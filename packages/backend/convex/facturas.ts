import { mutation, query, internalMutation } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import {
  requireCondominioRole,
  requireAppUser,
  getCurrentAppUser,
  misUnidadIds,
} from "./model/authz";
import {
  carteraDeUnidad,
  enRevision,
  estadoCuentaDeCadena,
  estadoVisibleDeFactura,
  estadosVisiblesDeUnidad,
  facturasDelResidente,
  formatoPesos,
  periodoSiguiente,
  periodosConsecutivos,
  type EstadoVisible,
} from "./lib/cartera";
import {
  PERIODO_VALIDO,
  motivosValidos,
  rechazoDePeriodo,
  validarLectura,
  type MotivoRechazo,
} from "./lib/lecturaFactura";
import { planificarReproceso, type PlanUnidad } from "./lib/reproceso";
import { exigirStorageIdDelRegistro } from "./model/files";
import {
  recaudoContablePorPeriodo,
  recaudoVekinoPorPeriodo,
  type FacturaRecaudo,
  type RecaudoContable,
  type RecaudoVekino,
} from "./lib/recaudo";
import {
  anotarEvento,
  pagosRegistrados,
  recalcularCadena,
  recalcularUnidades,
  type Tocada,
} from "./model/estadoFactura";
import {
  actualizarDocumento,
  escribirFactura,
  facturasDeIdentidad,
  type EntradaFactura,
} from "./model/facturas";

/** Quien sube y confirma facturas: los mismos roles de `bulkUpsert`. */
const CARGA_ROLES = ["administrador", "contadora"] as const;

/**
 * Quien puede ver la cartera del conjunto.
 *
 * La factura dice nombre, apartamento y cuanto debe cada residente. No es
 * dato de vecino: es de la administracion y de quien lleva las cuentas.
 * El residente ve LA SUYA por `listMia`, que filtra por sus unidades.
 */
const CARTERA_ROLES = ["administrador", "contadora", "junta_directiva"] as const;

const MESES_ES = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];

function periodoLabelFrom(periodo: string): string {
  const [y, m] = periodo.split("-");
  const mi = Number(m) - 1;
  return `01-${MESES_ES[mi] ?? m}-${y}`;
}

function formatApto(numero: string, torre?: string | null): string {
  if (torre) return `${numero} ${torre}`;
  return numero;
}

// Valores de líneas en la factura
const lineValidator = v.object({
  codigo: v.number(),
  codigoTexto: v.optional(v.string()),
  concepto: v.string(),
  saldoAnterior: v.number(),
  actual: v.number(),
  total: v.number(),
});

// ─────────────────────────────────────────────────────────────
// Estado y conciliación (Fase 3)
//
// La factura del mes siguiente dice cuánto quedó debiendo la unidad (su
// saldo anterior), y de ahí se infiere si la anterior se pagó. Desde la Fase
// 3 esa inferencia es UNA de las fuentes del estado, no la única: la
// evidencia de pago (pasarela, comprobantes) es un piso que la inferencia no
// baja, un mes faltante no deja juzgar, y una contradicción entre los dos se
// registra como discrepancia. Todo eso vive en `lib/estadoFactura.ts` y lo
// escribe `model/estadoFactura.ts` (`recalcularCadena`); las facturas las
// inserta y actualiza `model/facturas.ts` (`escribirFactura`). Ninguna ruta
// de este archivo escribe `estado`.
// ─────────────────────────────────────────────────────────────

/** El nombre con el que la bitácora registra a una persona. */
function nombreDe(user: Doc<"users">): string {
  return user.name || user.email || "Administración";
}

/**
 * Alta/actualización de una factura desde los scripts de importación.
 *
 * Es `internalMutation` y no `mutation`: en Convex toda función exportada
 * como `mutation` es API pública, invocable por cualquiera que conozca la URL
 * del deployment —y esa URL viaja en el bundle del navegador—. Esta no tiene
 * ningún llamador de cliente; sus únicos usuarios son los scripts de
 * migración vía `convex run`, que también pueden invocar funciones internas.
 *
 * La alta manual desde la aplicación es `createManual`, que sí comprueba
 * permisos.
 *
 * Idempotente por (conjunto, unidad, período), como toda escritura de
 * facturas (`model/facturas.ts`). El `estado` que manda el script NO se
 * escribe (los scripts mandan "pendiente" a ciegas, y pisaban pagos: F-11):
 * el estado lo calcula `recalcularCadena`.
 */
export const upsertFactura = internalMutation({
  args: {
    condominioId: v.id("condominios"),
    unidadId: v.id("unidades"),
    membershipId: v.optional(v.id("memberships")),

    numeroFactura: v.string(),
    numeroInterno: v.string(),
    periodo: v.string(),
    periodoLabel: v.string(),

    residenteNombre: v.string(),
    apto: v.optional(v.string()),
    vrAdmon: v.number(),

    lineas: v.array(lineValidator),
    saldoAFavor: v.number(),
    totalAPagar: v.number(),
    totalConDescuento: v.optional(v.number()),

    fechaEmision: v.number(),
    fechaVencimiento: v.number(),
    estado: v.union(
      v.literal("pendiente"),
      v.literal("pagada"),
      v.literal("vencida"),
      v.literal("abonada"),
      v.literal("saldo_a_favor")
    ),

    pdfUrl: v.optional(v.string()),
    legacyId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { estado, ...documento } = args;
    const escritura = await escribirFactura(
      ctx,
      {
        ...documento,
        origen: "script",
        ...(estado === "pagada" || estado === "abonada" || estado === "vencida"
          ? { veredictoHeredado: estado }
          : {}),
      },
      { siExiste: "actualizar", conFechas: true, soloDefinidos: true },
    );
    if (escritura.accion === "ambigua") {
      throw new Error("La unidad ya tiene más de una factura de este período.");
    }
    if (escritura.accion === "conflicto_legacy") {
      throw new Error(`El legacyId ${args.legacyId} ya es de otra factura.`);
    }
    await recalcularCadena(ctx, args.condominioId, args.unidadId, {
      origen: "migracion",
      actor: "facturas.upsertFactura",
      tocadas:
        "tocada" in escritura && escritura.tocada
          ? new Map([[escritura.facturaId, escritura.tocada]])
          : undefined,
    });
    return escritura.facturaId;
  },
});

/**
 * Lista facturas de un condominio por período
 */
export const listByPeriodo = query({
  args: {
    condominioId: v.id("condominios"),
    periodo: v.string(),
  },
  handler: async (ctx, args) => {
    await requireCondominioRole(ctx, args.condominioId, [...CARTERA_ROLES]);
    const filas = await ctx.db
      .query("facturas")
      .withIndex("by_condominio_periodo", (q) =>
        q.eq("condominioId", args.condominioId).eq("periodo", args.periodo)
      )
      .order("asc")
      .collect();
    /* Con el estado que se muestra, como `listPage` (QA de comprobantes, H2). */
    return await conEstadoVisible(ctx, filas);
  },
});

/** Facturas recientes de un período (home). Sin .collect() completo. */
export const listRecentByPeriodo = query({
  args: {
    condominioId: v.id("condominios"),
    periodo: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireCondominioRole(ctx, args.condominioId, [...CARTERA_ROLES]);
    const limit = Math.min(Math.max(args.limit ?? 5, 1), 20);
    const rows = await ctx.db
      .query("facturas")
      .withIndex("by_condominio_periodo", (q) =>
        q.eq("condominioId", args.condominioId).eq("periodo", args.periodo),
      )
      .order("desc")
      .take(limit);
    /* Con el estado que se muestra, como `listPage` (QA de comprobantes, H2). */
    return await conEstadoVisible(ctx, rows);
  },
});

/**
 * Página de facturas por período. Sin filtros: paginación real.
 * Con `q` o `estado`: escanea un lote acotado (máx. 250).
 */
export const listPage = query({
  args: {
    condominioId: v.id("condominios"),
    periodo: v.string(),
    paginationOpts: paginationOptsValidator,
    q: v.optional(v.string()),
    estado: v.optional(
      v.union(
        v.literal("pendiente"),
        v.literal("pagada"),
        v.literal("vencida"),
        v.literal("abonada"),
        v.literal("saldo_a_favor"),
      ),
    ),
  },
  handler: async (ctx, args) => {
    await requireCondominioRole(ctx, args.condominioId, [...CARTERA_ROLES]);
    const needle = args.q?.trim().toLowerCase() ?? "";
    const estado = args.estado;

    if (needle || estado) {
      const scan = await ctx.db
        .query("facturas")
        .withIndex("by_condominio_periodo", (q) =>
          q.eq("condominioId", args.condominioId).eq("periodo", args.periodo),
        )
        .order("desc")
        .take(250);
      /* Filtrar por "pendiente" o "vencida" es filtrar por lo que se muestra:
       * la vigente en mora es "vencida" aunque se guarde `pendiente`. */
      const visibles =
        estado === "pendiente" || estado === "vencida"
          ? await estadosVisibles(ctx, scan)
          : new Map<string, EstadoVisible>();
      const filtered = scan.filter((f) => {
        if (estado && estadoDeFinanzas(f, visibles) !== estado) return false;
        if (!needle) return true;
        return (
          f.residenteNombre.toLowerCase().includes(needle) ||
          (f.apto ?? "").toLowerCase().includes(needle) ||
          f.numeroFactura.toLowerCase().includes(needle) ||
          f.numeroInterno.toLowerCase().includes(needle)
        );
      });
      const limit = Math.min(args.paginationOpts.numItems || 30, 60);
      return {
        page: await conEstadoVisible(ctx, filtered.slice(0, limit)),
        isDone: true,
        continueCursor: "",
      };
    }

    const pagina = await ctx.db
      .query("facturas")
      .withIndex("by_condominio_periodo", (q) =>
        q.eq("condominioId", args.condominioId).eq("periodo", args.periodo),
      )
      .order("desc")
      .paginate(args.paginationOpts);
    return { ...pagina, page: await conEstadoVisible(ctx, pagina.page) };
  },
});

/**
 * Cada factura con el estado que se le MUESTRA (`estadoVisibleDeFactura`):
 * una historica que quedo `pendiente` se ve "Sin verificar" —falta el estado
 * de cuenta siguiente para saber si se pago— (Fase 4), y la vigente de una
 * unidad que HOY esta en mora se ve "Vencida", como la ven la cartera y el
 * residente (QA de comprobantes, H2). El campo `estado` no cambia.
 */
async function conEstadoVisible(ctx: QueryCtx, filas: Doc<"facturas">[]) {
  const visibles = await estadosVisibles(ctx, filas);
  return filas.map((f) => ({ ...f, estadoVisible: visibles.get(f._id)! }));
}

/** Las facturas de una unidad en el conjunto: la cadena que juzga la conciliacion. */
async function cadenaDeUnidad(
  ctx: QueryCtx,
  condominioId: Id<"condominios">,
  unidadId: Id<"unidades">,
) {
  return (
    await ctx.db
      .query("facturas")
      .withIndex("by_unidad", (q) => q.eq("unidadId", unidadId))
      .collect()
  ).filter((f) => f.condominioId === condominioId);
}

/**
 * El estado visible de cada factura de `filas`, con la cartera de hoy de su
 * unidad (`estadosVisiblesDeUnidad`).
 *
 * Solo una `pendiente` puede verse distinta de su estado guardado ("Sin
 * verificar" si es histórica, "Vencida" si es la vigente de una unidad en
 * mora), así que solo las unidades con alguna leen su cadena, una vez cada
 * una. Para las demás basta la propia factura.
 */
async function estadosVisibles(
  ctx: QueryCtx,
  filas: readonly Doc<"facturas">[],
): Promise<Map<string, EstadoVisible>> {
  const ahora = Date.now();
  const unidades = new Map<Id<"unidades">, Id<"condominios">>();
  for (const f of filas) if (f.estado === "pendiente") unidades.set(f.unidadId, f.condominioId);
  const salida = new Map<string, EstadoVisible>();
  await Promise.all(
    [...unidades].map(async ([unidadId, condominioId]) => {
      const cadena = await cadenaDeUnidad(ctx, condominioId, unidadId);
      for (const [id, visible] of estadosVisiblesDeUnidad(cadena, ahora)) salida.set(id, visible);
    }),
  );
  for (const f of filas) if (!salida.has(f._id)) salida.set(f._id, estadoVisibleDeFactura(f, [f]));
  return salida;
}

/**
 * El estado con el que Finanzas cuenta y filtra: el guardado, salvo la
 * vigente de una unidad en mora, que se cuenta "vencida" (la regla de
 * `estadoVisibleDeFactura`). Asi el total sigue siendo la suma de los estados.
 */
function estadoDeFinanzas(
  f: Doc<"facturas">,
  visibles: ReadonlyMap<string, EstadoVisible>,
): Doc<"facturas">["estado"] {
  return f.estado === "pendiente" && visibles.get(f._id) === "vencida" ? "vencida" : f.estado;
}

/** Una factura como la necesita `lib/recaudo.ts`. */
function aRecaudo(f: Doc<"facturas">): FacturaRecaudo {
  return {
    _id: f._id,
    unidadId: f.unidadId,
    periodo: f.periodo,
    totalAPagar: f.totalAPagar,
    lineas: f.lineas,
    saldoAnteriorDocumento: f.saldoAnteriorDocumento,
    lecturaDudosa: f.lecturaDudosa,
    origen: f.origen,
  };
}

/** Los pagos aprobados y los comprobantes aprobados del conjunto (recaudo en Vekino). */
async function evidenciaDelConjunto(ctx: QueryCtx, condominioId: Id<"condominios">) {
  const pagos = (
    await ctx.db
      .query("pagos")
      .withIndex("by_condominio", (q) => q.eq("condominioId", condominioId))
      .collect()
  ).filter((p) => p.estado === "aprobada");
  const comprobantes = await ctx.db
    .query("soportesPago")
    .withIndex("by_condominio_estado", (q) =>
      q.eq("condominioId", condominioId).eq("estado", "aprobado"),
    )
    .collect();
  return {
    pagos: pagos.map((p) => ({ facturaId: p.facturaId as string, monto: p.monto, estado: p.estado })),
    comprobantes: comprobantes.map((c) => ({
      facturaId: c.facturaId as string | undefined,
      monto: c.monto,
      estado: c.estado,
    })),
  };
}

/** Las dos cifras de recaudo de un periodo, con lo que no se pudo calcular. */
function cifrasDeRecaudo(contable: RecaudoContable | undefined, vekino: RecaudoVekino | undefined) {
  return {
    /** Segun la contabilidad: total(N) − saldo anterior(N+1); `null` si ninguna unidad se pudo calcular. */
    recaudoContable: contable?.monto ?? null,
    recaudoContableUnidades: contable?.unidades ?? 0,
    recaudoContableSinCalcular: {
      sinSiguiente: contable?.sinSiguiente ?? 0,
      mesFaltante: contable?.mesFaltante ?? 0,
      enRevision: contable?.enRevision ?? 0,
      noCuadra: contable?.noCuadra ?? 0,
      /** El mes siguiente es una factura hecha a mano: no trae saldo anterior (H4). */
      siguienteManual: contable?.siguienteManual ?? 0,
    },
    /** Registrado en Vekino: pagos y comprobantes aprobados. */
    recaudoVekino: vekino?.monto ?? 0,
    recaudoVekinoPagos: vekino?.pagos ?? 0,
    recaudoVekinoComprobantes: vekino?.comprobantes ?? 0,
    comprobantesSinMonto: vekino?.comprobantesSinMonto ?? 0,
  };
}

/**
 * Resumen de un período: estados, cartera y las dos cifras de recaudo.
 *
 * Fase 4 (F-19): el recaudo ya no es "la suma del total de las pagadas" (que
 * metia el arrastre y dejaba fuera los abonos). Son dos cifras, por separado:
 * la de la contabilidad (con el mes siguiente) y la registrada en Vekino. Ver
 * `lib/recaudo.ts`. `sumaPagado` se conserva para las pantallas anteriores,
 * con su significado de siempre: no es recaudo.
 */
export const resumenPeriodo = query({
  args: {
    condominioId: v.id("condominios"),
    periodo: v.string(),
  },
  handler: async (ctx, args) => {
    await requireCondominioRole(ctx, args.condominioId, [...CARTERA_ROLES]);
    const rows = await ctx.db
      .query("facturas")
      .withIndex("by_condominio_periodo", (q) =>
        q.eq("condominioId", args.condominioId).eq("periodo", args.periodo)
      )
      .collect();
    /* El mes siguiente: su saldo anterior dice cuanto quedo debiendo cada
     * unidad de este. */
    const siguientes = PERIODO_VALIDO.test(args.periodo)
      ? await ctx.db
          .query("facturas")
          .withIndex("by_condominio_periodo", (q) =>
            q.eq("condominioId", args.condominioId).eq("periodo", periodoSiguiente(args.periodo)),
          )
          .collect()
      : [];

    /* "Vencidas" son las que se MUESTRAN vencidas: las que la conciliación
     * juzgó así y la vigente de una unidad que hoy está en mora, que sigue
     * `pendiente` en la base (QA de comprobantes, H2: decía 0 con una casa en
     * mora). Solo una `pendiente` puede cambiar, así que solo esas leen su
     * cadena. */
    const visibles = await estadosVisibles(ctx, rows);
    const estados = rows.map((r) => estadoDeFinanzas(r, visibles));

    const total = rows.length;
    const pagadas = estados.filter((e) => e === "pagada").length;
    const pendientes = estados.filter((e) => e === "pendiente").length;
    const vencidas = estados.filter((e) => e === "vencida").length;
    const abonadas = estados.filter((e) => e === "abonada").length;
    const saldoAFavorCount = rows.filter((r) => r.estado === "saldo_a_favor").length;
    const sumaTotalAPagar = rows.reduce((s, r) => s + r.totalAPagar, 0);
    /** @deprecated (F-19) Suma del total de las pagadas: NO es recaudo. */
    const sumaPagado = rows
      .filter((r) => r.estado === "pagada")
      .reduce((s, r) => s + r.totalAPagar, 0);

    const contable = recaudoContablePorPeriodo([...rows, ...siguientes].map(aRecaudo)).get(
      args.periodo,
    );
    const evidencia = await evidenciaDelConjunto(ctx, args.condominioId);
    const vekino = recaudoVekinoPorPeriodo(
      new Map(rows.map((r) => [r._id as string, r.periodo])),
      evidencia.pagos,
      evidencia.comprobantes,
    ).get(args.periodo);

    return {
      total,
      pagadas,
      pendientes,
      vencidas,
      abonadas,
      saldoAFavorCount,
      sumaTotalAPagar,
      sumaPagado,
      ...cifrasDeRecaudo(contable, vekino),
    };
  },
});

/**
 * Lista todos los periodos disponibles para un condominio
 */
export const listPeriodos = query({
  args: { condominioId: v.id("condominios") },
  handler: async (ctx, args) => {
    await requireCondominioRole(ctx, args.condominioId, [...CARTERA_ROLES]);
    const rows = await ctx.db
      .query("facturas")
      .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
      .collect();
    const periodos = [...new Set(rows.map((r) => r.periodo))].sort().reverse();
    return periodos;
  },
});

/**
 * Serie temporal por período: totales y desglose de estado en cada período.
 * Ordenada ascendente por período (para gráficas de tendencia).
 */
export const serie = query({
  args: { condominioId: v.id("condominios") },
  handler: async (ctx, args) => {
    await requireCondominioRole(ctx, args.condominioId, [...CARTERA_ROLES]);
    const rows = await ctx.db
      .query("facturas")
      .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
      .collect();

    const map = new Map<
      string,
      {
        periodo: string;
        total: number;
        pagadas: number;
        pendientes: number;
        vencidas: number;
        abonadas: number;
        sumaTotalAPagar: number;
        sumaPagado: number;
      }
    >();

    /* El estado con que se cuenta, como en `resumenPeriodo`: la vigente de
     * una unidad en mora cuenta "vencida" (H2). Las facturas ya están todas
     * aquí: se agrupan por unidad sin leer nada más. */
    const porUnidad = new Map<string, Doc<"facturas">[]>();
    for (const r of rows) {
      const cadena = porUnidad.get(r.unidadId);
      if (cadena) cadena.push(r);
      else porUnidad.set(r.unidadId, [r]);
    }
    const ahora = Date.now();
    const visibles = new Map<string, EstadoVisible>();
    for (const cadena of porUnidad.values()) {
      if (!cadena.some((f) => f.estado === "pendiente")) continue;
      for (const [id, visible] of estadosVisiblesDeUnidad(cadena, ahora)) visibles.set(id, visible);
    }

    for (const r of rows) {
      const estado = estadoDeFinanzas(r, visibles);
      let e = map.get(r.periodo);
      if (!e) {
        e = {
          periodo: r.periodo,
          total: 0,
          pagadas: 0,
          pendientes: 0,
          vencidas: 0,
          abonadas: 0,
          sumaTotalAPagar: 0,
          sumaPagado: 0,
        };
        map.set(r.periodo, e);
      }
      e.total++;
      e.sumaTotalAPagar += r.totalAPagar;
      if (estado === "pagada") {
        e.pagadas++;
        /* @deprecated (F-19): suma del total de las pagadas; NO es recaudo. */
        e.sumaPagado += r.totalAPagar;
      } else if (estado === "pendiente") {
        e.pendientes++;
      } else if (estado === "vencida") {
        e.vencidas++;
      } else if (estado === "abonada") {
        e.abonadas++;
      }
    }

    /* Las dos cifras de recaudo por periodo (Fase 4, F-19; `lib/recaudo.ts`). */
    const contable = recaudoContablePorPeriodo(rows.map(aRecaudo));
    const evidencia = await evidenciaDelConjunto(ctx, args.condominioId);
    const vekino = recaudoVekinoPorPeriodo(
      new Map(rows.map((r) => [r._id as string, r.periodo])),
      evidencia.pagos,
      evidencia.comprobantes,
    );

    return [...map.values()]
      .sort((a, b) => a.periodo.localeCompare(b.periodo))
      .map((e) => ({ ...e, ...cifrasDeRecaudo(contable.get(e.periodo), vekino.get(e.periodo)) }));
  },
});

/**
 * Cuenta facturas por período
 */
export const countByPeriodo = query({
  args: {
    condominioId: v.id("condominios"),
    periodo: v.string(),
  },
  handler: async (ctx, args) => {
    await requireCondominioRole(ctx, args.condominioId, [...CARTERA_ROLES]);
    const rows = await ctx.db
      .query("facturas")
      .withIndex("by_condominio_periodo", (q) =>
        q.eq("condominioId", args.condominioId).eq("periodo", args.periodo)
      )
      .collect();
    return rows.length;
  },
});

const facturaInputValidator = v.object({
  condominioId: v.id("condominios"),
  unidadId: v.id("unidades"),
  membershipId: v.optional(v.id("memberships")),
  numeroFactura: v.string(),
  numeroInterno: v.string(),
  periodo: v.string(),
  periodoLabel: v.string(),
  residenteNombre: v.string(),
  apto: v.optional(v.string()),
  vrAdmon: v.number(),
  lineas: v.array(lineValidator),
  saldoAFavor: v.number(),
  totalAPagar: v.number(),
  totalConDescuento: v.optional(v.number()),
  fechaEmision: v.number(),
  fechaVencimiento: v.number(),
  estado: v.union(
    v.literal("pendiente"),
    v.literal("pagada"),
    v.literal("vencida"),
    v.literal("abonada"),
    v.literal("saldo_a_favor"),
  ),
  pdfUrl: v.optional(v.string()),
  legacyId: v.optional(v.string()),
  /** Saldo anterior que imprime el documento (fila Totales), si lo trae. */
  saldoAnteriorDocumento: v.optional(v.number()),
  /**
   * Hasta cuándo vale `totalConDescuento`, como lo dice el documento ("HASTA
   * EL DIA 15 DEL PRESENTE MES"). Sin él, `lib/cartera.ts` aplica la regla.
   */
  fechaLimiteDescuento: v.optional(v.number()),
  /**
   * Motivos de lectura dudosa que vio el parser en el PDF y que no se pueden
   * comprobar con los números (no estaba el total, la hoja era de
   * continuación…). Solo pueden AGREGAR dudas: lo que el backend comprueba
   * por su cuenta no depende de esto.
   */
  motivosLectura: v.optional(v.array(v.string())),
});

/**
 * Si quien llama puede subir PDFs de facturas del conjunto cuyo `legacyId`
 * es `condominioLegacyId`.
 *
 * La consulta `/api/facturas/upload` antes de leer el PDF y de escribir en
 * S3, donde las llaves van por ese id: la ruta respondía a cualquiera, con o
 * sin sesión. Pide los mismos roles que `bulkUpsert`, que es lo que se hace
 * después con lo leído.
 *
 * Responde el motivo en vez de lanzar: la ruta decide 401 o 403 con él, y no
 * con el texto de un error, que Convex puede ocultar fuera de desarrollo.
 */
export const permisoSubida = query({
  args: { condominioLegacyId: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{ allowed: true } | { allowed: false; motivo: "sin_sesion" | "sin_permiso" }> => {
    const user = await getCurrentAppUser(ctx);
    if (!user || !user.active) return { allowed: false, motivo: "sin_sesion" };
    /* `condominios` no tiene índice por `legacyId`, y son pocos: uno por
     * conjunto. Si dos compartieran el id, compartirían la carpeta de S3, así
     * que se exige el rol en todos. */
    const conjuntos = (await ctx.db.query("condominios").collect()).filter(
      (c) => c.legacyId === args.condominioLegacyId,
    );
    if (conjuntos.length === 0) return { allowed: false, motivo: "sin_permiso" };
    for (const c of conjuntos) {
      try {
        await requireCondominioRole(ctx, c._id, ["administrador", "contadora"]);
      } catch {
        return { allowed: false, motivo: "sin_permiso" };
      }
    }
    return { allowed: true };
  },
});

/**
 * Carpeta de S3 de los PDF de facturas de un conjunto: su `legacyId` si lo
 * tiene —las llaves de los migrados (CDC, Arboleda) no cambian— y su `_id`
 * si no. Un `legacyId` vacío cuenta como ausente.
 */
function carpetaDeFacturas(c: Doc<"condominios">): string {
  return c.legacyId || c._id;
}

/**
 * Permiso y destino de una carga de PDFs de facturas, por conjunto.
 *
 * `permisoSubida` resuelve el conjunto por `legacyId`, que solo tienen los
 * conjuntos migrados: uno creado desde la plataforma no podía cargar PDFs.
 * Esta consulta lo resuelve por `condominioId` —o por `condominioLegacyId`,
 * que sigue mandando la web anterior— y devuelve, con el permiso, el conjunto
 * y su carpeta de S3. Las dos rutas (`/api/facturas/upload` y `/confirmar`)
 * usan esta misma resolución y no calculan nada por su cuenta.
 *
 *   · Pide los roles de `bulkUpsert` en cada conjunto nombrado, antes de
 *     decir nada más: quien no puede cargar en uno no se entera de si los
 *     identificadores coinciden.
 *   · Si llegan los dos identificadores, tienen que ser del mismo conjunto.
 *   · La carpeta tiene que ser solo de ese conjunto. Si otro la comparte (un
 *     `legacyId` repetido, o igual al `_id` de otro), no se carga: sus PDF
 *     quedarían mezclados en la misma carpeta pública.
 *
 * El `condominioId` llega como texto y se normaliza aquí: un id mal formado
 * es "sin permiso", no un error de validación.
 *
 * Responde el motivo en vez de lanzar, como `permisoSubida`.
 */
export const destinoCarga = query({
  args: {
    condominioId: v.optional(v.string()),
    condominioLegacyId: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<
    | { allowed: true; condominioId: Id<"condominios">; carpeta: string }
    | {
        allowed: false;
        motivo: "sin_sesion" | "sin_permiso" | "sin_conjunto" | "no_coinciden" | "carpeta_compartida";
      }
  > => {
    const user = await getCurrentAppUser(ctx);
    if (!user || !user.active) return { allowed: false, motivo: "sin_sesion" };
    if (args.condominioId === undefined && args.condominioLegacyId === undefined) {
      return { allowed: false, motivo: "sin_conjunto" };
    }

    /* Son pocos (uno por conjunto) y no hay índice por `legacyId`. Además
     * hay que verlos todos para saber si la carpeta es de uno solo. */
    const todos = await ctx.db.query("condominios").collect();

    let porId: Doc<"condominios"> | undefined;
    if (args.condominioId !== undefined) {
      const id = ctx.db.normalizeId("condominios", args.condominioId);
      porId = id ? todos.find((c) => c._id === id) : undefined;
      if (!porId) return { allowed: false, motivo: "sin_permiso" };
    }
    let porLegacy: Doc<"condominios">[] | undefined;
    if (args.condominioLegacyId !== undefined) {
      porLegacy = todos.filter((c) => c.legacyId === args.condominioLegacyId);
      if (porLegacy.length === 0) return { allowed: false, motivo: "sin_permiso" };
    }

    for (const c of [...(porId ? [porId] : []), ...(porLegacy ?? [])]) {
      try {
        await requireCondominioRole(ctx, c._id, [...CARGA_ROLES]);
      } catch {
        return { allowed: false, motivo: "sin_permiso" };
      }
    }

    const conjunto = (porId ?? porLegacy?.[0])!;
    if (porLegacy && !porLegacy.some((c) => c._id === conjunto._id)) {
      return { allowed: false, motivo: "no_coinciden" };
    }
    const carpeta = carpetaDeFacturas(conjunto);
    if (todos.some((c) => c._id !== conjunto._id && carpetaDeFacturas(c) === carpeta)) {
      return { allowed: false, motivo: "carpeta_compartida" };
    }
    return { allowed: true, condominioId: conjunto._id, carpeta };
  },
});

/**
 * Inserta o actualiza un lote de facturas desde la UI (subida de PDF bulk).
 * Idempotente por (condominioId, unidadId, periodo).
 * Con skipExisting=true solo inserta facturas nuevas (no pisa las que ya existen).
 *
 * ── No confía en lo que manda el navegador ──────────────────────────────
 * Valida cada factura por su cuenta (`lib/lecturaFactura.ts`), aunque la
 * ruta de confirmación ya lo haya hecho:
 *
 *   · RECHAZA (no la guarda; devuelve el motivo) la factura cuyo propio
 *     documento dice otro período (`periodo_no_coincide`), la de un período
 *     mal formado o la de una unidad de otro conjunto. Guardarla sería
 *     guardar una identidad que el documento contradice.
 *   · MARCA "en revisión" la que no cuadra (Σ líneas ≠ total, saldo anterior
 *     de las líneas ≠ el del documento, sin líneas, período ilegible, o lo
 *     que avise el parser). Entra igual —es la vigente de su unidad y no
 *     puede faltar—, pero no se paga, no concilia y no decide "al día" ni
 *     "mora" hasta que se corrija o se confirme (`confirmarLectura`).
 *
 * Una lectura correcta que llega después (re-subida con "actualizar") quita
 * la marca.
 *
 * ── Fase 3 ───────────────────────────────────────────────────────────────
 *   · Escribe por `escribirFactura` (identidad única) y NUNCA el estado: lo
 *     calcula `recalcularCadena` por cada unidad tocada, con evidencia de
 *     pago, veredicto y discrepancias, y deja la bitácora.
 *   · Dos documentos de la misma unidad en el mismo lote se rechazan los dos
 *     (`documento_repetido`): guardar el primero era adivinar (CDC 802,
 *     septiembre de 2026).
 *   · El `fechaVencimiento` es el que manda quien carga (la confirmación de
 *     la web le pone la regla nueva a lo que entra).
 */
export const bulkUpsert = mutation({
  args: {
    facturas: v.array(facturaInputValidator),
    skipExisting: v.optional(v.boolean()),
    /** La importación (PDF confirmado) a la que pertenece el lote, si la hay. */
    importacionId: v.optional(v.id("importaciones")),
  },
  handler: async (ctx, args) => {
    /* Sesión primero. Sin esto, un lote VACÍO no pasaba por ninguna
     * comprobación —el bucle de abajo no itera— y una mutación pública
     * respondía correctamente a quien no había iniciado sesión. No escribía
     * nada, pero una escritura que no exige identidad no debe existir. */
    const user = await requireAppUser(ctx);

    /* El lote no trae un `condominioId` propio: cada factura lleva el suyo.
     * Así que se comprueba el permiso sobre CADA conjunto presente en el
     * payload, no sobre el primero. Sin esto, quien administra un conjunto
     * podría colar en el mismo lote facturas de otro. */
    const conjuntos = new Set(args.facturas.map((f) => f.condominioId));
    for (const condominioId of conjuntos) {
      await requireCondominioRole(ctx, condominioId, [...CARGA_ROLES]);
    }

    const importacion = args.importacionId ? await ctx.db.get(args.importacionId) : null;
    if (args.importacionId) {
      if (!importacion || [...conjuntos].some((c) => c !== importacion.condominioId)) {
        throw new Error("La importación no corresponde a este conjunto.");
      }
      if (importacion.estado !== "en_curso") throw new Error("La importación ya se cerró.");
    }

    const now = Date.now();
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    let marcadas = 0;
    const rechazos: { indice: number; unidadId: Id<"unidades">; motivo: MotivoRechazo }[] = [];
    const unidadesAfectadas = new Map<Id<"unidades">, Id<"condominios">>();
    const tocadas = new Map<Id<"facturas">, Tocada>();

    /* Dos documentos de la misma unidad y período en el lote: ninguno. */
    const porIdentidad = new Map<string, number>();
    for (const f of args.facturas) {
      const clave = `${f.condominioId}|${f.unidadId}|${f.periodo}`;
      porIdentidad.set(clave, (porIdentidad.get(clave) ?? 0) + 1);
    }

    for (const [indice, entrada] of args.facturas.entries()) {
      const { motivosLectura, estado: _estadoDelCliente, ...f } = entrada;

      /* Identidad: la unidad es de este conjunto, y el período es el que dice
       * el propio documento. Si no, la factura no se guarda. */
      const unidad = await ctx.db.get(f.unidadId);
      const rechazo: MotivoRechazo | null =
        !unidad || unidad.condominioId !== f.condominioId
          ? "unidad_ajena"
          : (porIdentidad.get(`${f.condominioId}|${f.unidadId}|${f.periodo}`) ?? 0) > 1
            ? "documento_repetido"
            : rechazoDePeriodo(f.periodo, f.periodoLabel);
      if (rechazo) {
        rechazos.push({ indice, unidadId: f.unidadId, motivo: rechazo });
        continue;
      }

      /* Lectura: lo que el backend comprueba con los números, más lo que el
       * parser vio en el PDF. Cualquier motivo deja la factura en revisión. */
      const motivos = motivosValidos([...validarLectura(f), ...(motivosLectura ?? [])]);
      const lecturaDudosa = motivos.length > 0 ? { motivos, marcadaAt: now } : undefined;

      /* El estado NO lo decide quien llama (la UI de subida mandaba
       * "pendiente" a ciegas), ni esta ruta: lo calcula `recalcularCadena`.
       * Al actualizar se escriben solo los números del documento, así que
       * nada que venga de un pago o de la conciliación se pisa. */
      const escritura = await escribirFactura(
        ctx,
        {
          ...f,
          lecturaDudosa,
          origen: "pdf",
          ...(args.importacionId ? { importacionId: args.importacionId } : {}),
        },
        { siExiste: args.skipExisting ? "omitir" : "actualizar", conLectura: true },
      );

      if (escritura.accion === "ambigua") {
        rechazos.push({ indice, unidadId: f.unidadId, motivo: "factura_duplicada" });
        continue;
      }
      if (escritura.accion === "conflicto_legacy") {
        rechazos.push({ indice, unidadId: f.unidadId, motivo: "factura_duplicada" });
        continue;
      }
      // Aun sin re-insertar, la factura existente puede juzgar a la anterior
      unidadesAfectadas.set(f.unidadId, f.condominioId);
      if (escritura.accion === "omitida") {
        skipped++;
        continue;
      }
      if (escritura.accion === "insertada") inserted++;
      else updated++;
      if (lecturaDudosa) marcadas++;
      if (escritura.tocada) tocadas.set(escritura.facturaId, escritura.tocada);
    }

    // Estado y conciliación de cada unidad tocada (`model/estadoFactura.ts`)
    const conciliacion = await recalcularUnidades(ctx, unidadesAfectadas, {
      origen: "carga",
      actor: nombreDe(user),
      actorUserId: user._id,
      tocadas,
    });

    if (importacion) {
      await ctx.db.patch(importacion._id, {
        insertadas: importacion.insertadas + inserted,
        actualizadas: importacion.actualizadas + updated,
        omitidas: importacion.omitidas + skipped,
        marcadas: importacion.marcadas + marcadas,
        rechazadas: importacion.rechazadas + rechazos.length,
        rechazos: [
          ...importacion.rechazos,
          ...rechazos.map((r) => ({ unidadId: r.unidadId, motivo: r.motivo })),
        ],
      });
    }

    return {
      inserted,
      updated,
      skipped,
      marcadas,
      rechazadas: rechazos.length,
      rechazos,
      conciliacion,
    };
  },
});

// ─────────────────────────────────────────────────────────────
// Importaciones: la confirmación de un PDF, de punta a punta
//
// /api/facturas/confirmar vuelve a leer el PDF en el servidor, comprueba que
// es el mismo de la vista previa (hash) y entonces:
//   1. `iniciarImportacion` registra la carga y dice qué pasará con cada
//      factura (insertar, actualizar, omitir, rechazar);
//   2. la ruta publica en S3 SOLO las que se insertan o actualizan, con una
//      llave propia de la importación (nunca se pisa un PDF publicado);
//   3. `bulkUpsert` guarda, enlazando cada factura a la importación;
//   4. `finalizarImportacion` la cierra con sus conteos.
// El hash hace idempotente la confirmación: el mismo archivo para el mismo
// período se carga una sola vez, aunque se pulse dos veces.
// ─────────────────────────────────────────────────────────────

/** Una confirmación que lleva más que esto "en curso" se da por abandonada. */
const IMPORTACION_ABANDONADA_MS = 10 * 60 * 1000;

function resumenImportacion(i: Doc<"importaciones">) {
  return {
    importacionId: i._id,
    estado: i.estado,
    documentos: i.documentos,
    insertadas: i.insertadas,
    actualizadas: i.actualizadas,
    omitidas: i.omitidas,
    marcadas: i.marcadas,
    rechazadas: i.rechazadas,
    rechazos: i.rechazos,
  };
}

export const iniciarImportacion = mutation({
  args: {
    condominioId: v.id("condominios"),
    periodo: v.string(),
    archivo: v.string(),
    hash: v.string(),
    soloNuevas: v.boolean(),
    documentos: v.number(),
    /** Las facturas leídas que tienen unidad, con la etiqueta de su documento. */
    candidatas: v.array(
      v.object({
        indice: v.number(),
        unidadId: v.id("unidades"),
        periodoLabel: v.string(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const { user } = await requireCondominioRole(ctx, args.condominioId, [...CARGA_ROLES]);
    if (!PERIODO_VALIDO.test(args.periodo)) throw new Error("El período debe tener la forma AAAA-MM.");
    if (!/^[0-9a-f]{64}$/.test(args.hash)) throw new Error("La huella del archivo no es válida.");

    const ahora = Date.now();
    /* La llave de idempotencia es el archivo, el período Y el modo: el mismo
     * PDF confirmado con "solo nuevas" y después con "actualizar" son dos
     * cargas distintas (la segunda sí actualiza). Sin el modo, la segunda
     * respondía "ya se cargó" y no actualizaba nada (Fase 3, PASO 11). */
    const previa = (
      await ctx.db
        .query("importaciones")
        .withIndex("by_condominio_hash", (q) =>
          q.eq("condominioId", args.condominioId).eq("hash", args.hash),
        )
        .collect()
    ).find((i) => i.periodo === args.periodo && i.soloNuevas === args.soloNuevas);

    if (previa?.estado === "completada") {
      return {
        tipo: "repetida" as const,
        importacionId: previa._id,
        resultado: resumenImportacion(previa),
        plan: [],
      };
    }
    if (previa?.estado === "en_curso" && ahora - previa.createdAt < IMPORTACION_ABANDONADA_MS) {
      return {
        tipo: "en_curso" as const,
        importacionId: previa._id,
        resultado: resumenImportacion(previa),
        plan: [],
      };
    }

    /* Nueva, o una anterior que falló o quedó a medias: se retoma la MISMA
     * importación, así las llaves de S3 que ya se hubieran publicado se
     * reconocen en vez de duplicarse. */
    const datos = {
      archivo: args.archivo.slice(0, 200),
      userId: user._id,
      userNombre: user.name,
      soloNuevas: args.soloNuevas,
      estado: "en_curso" as const,
      documentos: args.documentos,
      insertadas: 0,
      actualizadas: 0,
      omitidas: 0,
      marcadas: 0,
      rechazadas: 0,
      rechazos: [] as Doc<"importaciones">["rechazos"],
      createdAt: ahora,
    };
    let importacionId: Id<"importaciones">;
    if (previa) {
      await ctx.db.patch(previa._id, { ...datos, error: undefined, completadaAt: undefined });
      importacionId = previa._id;
    } else {
      importacionId = await ctx.db.insert("importaciones", {
        ...datos,
        condominioId: args.condominioId,
        periodo: args.periodo,
        hash: args.hash,
      });
    }

    const plan: { indice: number; accion: "insertar" | "actualizar" | "omitir" | "rechazar"; motivo?: MotivoRechazo }[] = [];
    const porUnidad = new Map<string, number>();
    for (const c of args.candidatas) porUnidad.set(c.unidadId, (porUnidad.get(c.unidadId) ?? 0) + 1);
    for (const c of args.candidatas) {
      const unidad = await ctx.db.get(c.unidadId);
      const rechazo: MotivoRechazo | null =
        !unidad || unidad.condominioId !== args.condominioId
          ? "unidad_ajena"
          : (porUnidad.get(c.unidadId) ?? 0) > 1
            ? "documento_repetido"
            : rechazoDePeriodo(args.periodo, c.periodoLabel);
      if (rechazo) {
        plan.push({ indice: c.indice, accion: "rechazar", motivo: rechazo });
        continue;
      }
      const existentes = await facturasDeIdentidad(ctx, args.condominioId, c.unidadId, args.periodo);
      if (existentes.length > 1) {
        plan.push({ indice: c.indice, accion: "rechazar", motivo: "factura_duplicada" });
        continue;
      }
      const existente = existentes[0];
      plan.push({
        indice: c.indice,
        accion: !existente
          ? "insertar"
          : /* Una hecha a mano la reemplaza el PDF, aun con "solo nuevas". */
            args.soloNuevas && existente.origen !== "manual"
            ? "omitir"
            : "actualizar",
      });
    }

    return { tipo: "nueva" as const, importacionId, resultado: null, plan };
  },
});

export const finalizarImportacion = mutation({
  args: {
    importacionId: v.id("importaciones"),
    estado: v.union(v.literal("completada"), v.literal("fallida")),
    error: v.optional(v.string()),
    /** Facturas que no llegaron al backend: sin unidad emparejada. */
    sinUnidad: v.optional(v.array(v.number())),
    /**
     * Otras que el plan rechazó y no se mandaron a guardar (dos documentos
     * de la misma unidad en el PDF: `documento_repetido`).
     */
    rechazos: v.optional(v.array(v.object({ indice: v.number(), motivo: v.string() }))),
  },
  handler: async (ctx, args) => {
    const importacion = await ctx.db.get(args.importacionId);
    if (!importacion) throw new Error("Importación no encontrada.");
    await requireCondominioRole(ctx, importacion.condominioId, [...CARGA_ROLES]);
    if (importacion.estado !== "en_curso") return resumenImportacion(importacion);
    const sinUnidad = args.sinUnidad ?? [];
    const otros = (args.rechazos ?? []).map((r) => ({ indice: r.indice, motivo: r.motivo.slice(0, 60) }));
    await ctx.db.patch(args.importacionId, {
      estado: args.estado,
      error: args.error?.slice(0, 500),
      rechazadas: importacion.rechazadas + sinUnidad.length + otros.length,
      rechazos: [
        ...importacion.rechazos,
        ...sinUnidad.map((indice) => ({ indice, motivo: "sin_unidad" })),
        ...otros,
      ],
      completadaAt: Date.now(),
    });
    return resumenImportacion((await ctx.db.get(args.importacionId))!);
  },
});

/**
 * Facturas en revisión del conjunto: lecturas dudosas sin confirmar, con su
 * motivo. Es la lista de trabajo de Finanzas.
 */
export const listEnRevision = query({
  args: { condominioId: v.id("condominios") },
  handler: async (ctx, args) => {
    await requireCondominioRole(ctx, args.condominioId, [...CARTERA_ROLES]);
    const facturas = await ctx.db
      .query("facturas")
      .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
      .collect();
    const enCurso = facturas.filter((f) => enRevision(f));
    const unidades = new Map<Id<"unidades">, Doc<"unidades"> | null>();
    for (const f of enCurso) {
      if (!unidades.has(f.unidadId)) unidades.set(f.unidadId, await ctx.db.get(f.unidadId));
    }
    return enCurso
      .map((f) => ({
        _id: f._id,
        periodo: f.periodo,
        numeroFactura: f.numeroFactura,
        unidadNumero: unidades.get(f.unidadId)?.numero ?? f.apto ?? "—",
        unidadTorre: unidades.get(f.unidadId)?.torre ?? null,
        residenteNombre: f.residenteNombre,
        totalAPagar: f.totalAPagar,
        motivos: f.lecturaDudosa?.motivos ?? [],
        marcadaAt: f.lecturaDudosa?.marcadaAt ?? f.updatedAt,
        pdfUrl: f.pdfUrl ?? null,
      }))
      .sort((a, b) => b.periodo.localeCompare(a.periodo) || a.unidadNumero.localeCompare(b.unidadNumero));
  },
});

/**
 * Motivos con los que el total que se cobraría NO salió del documento: no se
 * encontró, o el documento empezaba en una hoja de continuación (falta la
 * primera). Confirmar esas lecturas exige escribir el total del PDF.
 */
const SIN_TOTAL_DEL_DOCUMENTO: ReadonlySet<string> = new Set([
  "total_no_leido",
  "pagina_de_continuacion",
]);

/**
 * La administración revisó el PDF y da por buena la lectura, aunque no
 * cuadre (por ejemplo, el documento de la contabilidad viene así). Queda
 * registrado quién y cuándo; los motivos originales se conservan. Desde ese
 * momento la factura se paga y concilia como cualquier otra.
 *
 * ── Sin total en el documento (Fase 3, PASO 11) ──────────────────────────
 * Si el total no se leyó (`total_no_leido`) o el documento empezaba en una
 * hoja de continuación, el número guardado no salió del PDF: confirmarlo a
 * ciegas era volver cobrable un monto que nadie verificó. Entonces hay que
 * escribir el total que se ve en el documento (`totalVerificado`):
 *   · si coincide con el leído (±$1), se confirma y queda registrado;
 *   · si no, la factura queda con el total escrito —y sin el valor con
 *     descuento, que tampoco se verificó, salvo que se escriba
 *     (`totalConDescuentoVerificado`)—, y queda registrado el que se había
 *     leído.
 * La otra salida es volver a subir el PDF completo.
 */
export const confirmarLectura = mutation({
  args: {
    facturaId: v.id("facturas"),
    totalVerificado: v.optional(v.number()),
    totalConDescuentoVerificado: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const factura = await ctx.db.get(args.facturaId);
    if (!factura) throw new Error("Factura no encontrada.");
    const { user } = await requireCondominioRole(ctx, factura.condominioId, [...CARGA_ROLES]);
    if (!factura.lecturaDudosa) throw new Error("La factura no tiene una lectura en revisión.");
    if (factura.lecturaDudosa.confirmada) return args.facturaId;

    const sinTotal = factura.lecturaDudosa.motivos.some((m) => SIN_TOTAL_DEL_DOCUMENTO.has(m));
    const verificado = args.totalVerificado;
    if (sinTotal && verificado === undefined) {
      throw new Error(
        "El total de esta factura no salió del documento: escribe el total que ves en el PDF para confirmarla, o vuelve a subir el PDF completo.",
      );
    }
    if (verificado !== undefined && !Number.isFinite(verificado)) {
      throw new Error("El total escrito no es un número válido.");
    }
    const conDescuento = args.totalConDescuentoVerificado;
    if (conDescuento !== undefined && (!Number.isFinite(conDescuento) || verificado === undefined || conDescuento > verificado)) {
      throw new Error("El valor con descuento debe ser un número menor o igual al total.");
    }

    const now = Date.now();
    const corrige = verificado !== undefined && Math.abs(verificado - factura.totalAPagar) > 1;
    const tocada = await actualizarDocumento(
      ctx,
      factura,
      {
        lecturaDudosa: {
          ...factura.lecturaDudosa,
          confirmada: {
            userId: user._id,
            nombre: user.name,
            at: now,
            ...(verificado !== undefined
              ? { totalVerificado: verificado, totalLeido: factura.totalAPagar }
              : {}),
          },
        },
        ...(corrige
          ? {
              totalAPagar: verificado,
              totalConDescuento: conDescuento,
              fechaLimiteDescuento: conDescuento === undefined ? undefined : factura.fechaLimiteDescuento,
            }
          : {}),
      },
      `Lectura confirmada por ${nombreDe(user)}${
        verificado === undefined
          ? ""
          : corrige
            ? `: el total del documento es ${formatoPesos(verificado)} (se había leído ${formatoPesos(factura.totalAPagar)})`
            : `: total verificado ${formatoPesos(verificado)}`
      }`,
    );
    await recalcularCadena(ctx, factura.condominioId, factura.unidadId, {
      origen: "confirmacion_lectura",
      actor: nombreDe(user),
      actorUserId: user._id,
      ...(tocada ? { tocadas: new Map([[factura._id, tocada]]) } : {}),
    });
    return args.facturaId;
  },
});

/**
 * Re-ejecuta la conciliación por saldo anterior sobre TODAS las cadenas de
 * facturas del condominio (1ª → 2ª → 3ª… por unidad). Útil para arreglar el
 * histórico completo de una vez o después de correcciones manuales.
 */
export const reconciliar = mutation({
  args: { condominioId: v.id("condominios") },
  handler: async (ctx, args) => {
    const { user } = await requireCondominioRole(ctx, args.condominioId, [
      "administrador",
      "contadora",
      "junta_directiva",
    ]);

    const facturas = await ctx.db
      .query("facturas")
      .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
      .collect();

    const unidades = new Map(facturas.map((f) => [f.unidadId, args.condominioId] as const));

    /* La misma regla que al cargar o pagar: una factura con evidencia de pago
     * no la degrada la inferencia (F-02). */
    const totales = await recalcularUnidades(ctx, unidades, {
      origen: "conciliacion",
      actor: nombreDe(user),
      actorUserId: user._id,
    });

    return {
      unidades: unidades.size,
      facturas: facturas.length,
      ...totales,
    };
  },
});

// ─────────────────────────────────────────────────────────────
// Re-procesamiento de lo ya cargado con el parser nuevo (Fase 2)
// ─────────────────────────────────────────────────────────────

/** La lectura nueva del PDF ya publicado de una factura (`FacturaLeida`, web). */
const lecturaNuevaValidator = v.object({
  facturaId: v.id("facturas"),
  vrAdmon: v.number(),
  lineas: v.array(lineValidator),
  saldoAFavor: v.number(),
  totalAPagar: v.number(),
  totalConDescuento: v.optional(v.number()),
  saldoAnteriorDocumento: v.optional(v.number()),
  periodoLabel: v.string(),
  motivos: v.array(v.string()),
  /** El consecutivo del documento publicado: si no es el guardado, es otro documento. */
  numeroInterno: v.optional(v.string()),
});

/**
 * Aplica a facturas YA CARGADAS la lectura del parser nuevo de su propio PDF
 * y vuelve a conciliar sus cadenas: el plan de `lib/reproceso.ts`, unidad por
 * unidad (toda la cadena de cada unidad tocada).
 *
 * Por defecto NO escribe (`dryRun: true`): devuelve el plan —qué cambiaría en
 * cada factura y cómo quedaría cada unidad para la administración y para el
 * residente—. Con `dryRun: false` escribe exactamente ese plan.
 *
 * Es `internalMutation`: ningún cliente la puede llamar; solo `convex run`,
 * por lotes de pocas unidades (lee pagos y comprobantes de cada factura). Se
 * aplica SOLO con autorización explícita, después de revisar el informe con
 * la administración (docs/audits/FASE-2-FACTURACION.md, PASO 12).
 *
 * No toca los números de facturas con un pago aprobado o un comprobante
 * aprobado, ni las que su propio documento dice que son de otro período, ni
 * aquellas cuyo PDF publicado es OTRO documento (otro consecutivo:
 * `documento_distinto`, el caso de la casa 802 de Ciudad del Campo). El
 * estado lo escribe `recalcularCadena`, con la regla de la Fase 3.
 */
export const reprocesarLecturas = internalMutation({
  args: {
    condominioId: v.id("condominios"),
    lecturas: v.array(lecturaNuevaValidator),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    const ahora = Date.now();
    const lecturas = new Map(args.lecturas.map(({ facturaId, ...l }) => [facturaId as string, l]));

    const unidades = new Set<Id<"unidades">>();
    const ajenas: Id<"facturas">[] = [];
    for (const { facturaId } of args.lecturas) {
      const f = await ctx.db.get(facturaId);
      if (!f || f.condominioId !== args.condominioId) ajenas.push(facturaId);
      else unidades.add(f.unidadId);
    }

    const planes: PlanUnidad[] = [];
    for (const unidadId of unidades) {
      const cadena = (
        await ctx.db
          .query("facturas")
          .withIndex("by_unidad", (q) => q.eq("unidadId", unidadId))
          .collect()
      ).filter((f) => f.condominioId === args.condominioId);
      const ids = new Set<string>(cadena.map((f) => f._id));
      const pagos = (await pagosRegistrados(ctx, unidadId)).filter((p) => ids.has(p.facturaId));
      const discrepancias = (
        await ctx.db
          .query("discrepanciasPago")
          .withIndex("by_unidad", (q) => q.eq("unidadId", unidadId))
          .collect()
      ).filter((d) => d.condominioId === args.condominioId);

      const plan = planificarReproceso({ cadena, lecturas, pagos, discrepancias, ahora });
      if (!dryRun) {
        const tocadas = new Map<Id<"facturas">, Tocada>();
        for (const pf of plan.facturas) {
          if (pf.cambios.length === 0) continue;
          const factura = cadena.find((f) => f._id === pf.facturaId)!;
          /* Solo los números del documento; el estado lo pone
           * `recalcularCadena`, con el mismo cálculo del plan. La marca
           * conservada trae el `userId` de quien confirmó tal como está en la
           * base; las nuevas no traen confirmación. */
          const { estado: _estado, ...numeros } = pf.parche;
          const tocada = await actualizarDocumento(
            ctx,
            factura,
            numeros as Parameters<typeof actualizarDocumento>[2],
            "Re-procesada con el parser nuevo",
          );
          if (tocada) tocadas.set(factura._id, tocada);
        }
        await recalcularCadena(ctx, args.condominioId, unidadId, {
          origen: "reproceso",
          actor: "facturas.reprocesarLecturas",
          tocadas,
        });
      }
      planes.push(plan);
    }

    return { dryRun, ajenas, unidades: planes };
  },
});

/** URL de subida para adjunto — @deprecated usar api.files.generateUploadUrl (S3). */
export const generateUploadUrl = mutation({
  args: {},
  handler: async () => {
    throw new Error(
      "Las subidas van a S3. Usa api.files.generateUploadUrl (action).",
    );
  },
});

/** Quién crea facturas a mano (y sube su PDF: `subidas.ts`). */
export const MANUAL_ROLES = ["administrador", "contadora", "junta_directiva"] as const;

/**
 * Crea una factura puntual para una unidad (montos manuales + PDF/imagen opcional).
 * Falla si ya existe factura para (condominio, unidad, período).
 *
 * Queda con `origen: "manual"`: si después llega el PDF de la contabilidad
 * para esa unidad y período, la carga la reemplaza (aun con "solo nuevas"),
 * porque la manual era un sustituto mientras llegaba el documento.
 * El vencimiento lo elige quien la crea; la web y el móvil proponen el de la
 * regla nueva (`vencimientoDePeriodo`).
 */
export const createManual = mutation({
  args: {
    condominioId: v.id("condominios"),
    unidadId: v.id("unidades"),
    periodo: v.string(),
    fechaVencimiento: v.number(),
    valor: v.number(),
    saldoAFavor: v.optional(v.number()),
    totalConDescuento: v.optional(v.number()),
    pdfStorageId: v.optional(v.id("_storage")),
    pdfUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireCondominioRole(ctx, args.condominioId, [...MANUAL_ROLES]);

    if (!/^\d{4}-\d{2}$/.test(args.periodo)) {
      throw new Error("El período debe tener formato YYYY-MM.");
    }
    if (args.valor < 0) throw new Error("El valor no puede ser negativo.");
    const saldoAFavor = Math.max(0, args.saldoAFavor ?? 0);
    if (
      args.totalConDescuento !== undefined &&
      args.totalConDescuento !== null &&
      args.totalConDescuento < 0
    ) {
      throw new Error("El valor con descuento no puede ser negativo.");
    }

    const unidad = await ctx.db.get(args.unidadId);
    if (!unidad || unidad.condominioId !== args.condominioId) {
      throw new Error("Unidad no encontrada en este condominio.");
    }

    if ((await facturasDeIdentidad(ctx, args.condominioId, args.unidadId, args.periodo)).length > 0) {
      throw new Error(
        "Ya existe una factura para esta unidad en ese período.",
      );
    }

    const links = await ctx.db
      .query("usuarioUnidad")
      .withIndex("by_unidad", (q) => q.eq("unidadId", args.unidadId))
      .collect();

    let membershipId: Id<"memberships"> | undefined;
    let residenteNombre = "Sin asignar";
    for (const link of links) {
      const m = await ctx.db.get(link.membershipId);
      if (!m) continue;
      const user = await ctx.db.get(m.userId);
      if (!membershipId) membershipId = m._id;
      if (user?.name) {
        residenteNombre = user.name;
        membershipId = m._id;
        if (link.vinculo === "propietario" || link.esPrincipal) break;
      }
    }

    const apto = formatApto(unidad.numero, unidad.torre);
    const mesNombre = MESES_ES[Number(args.periodo.split("-")[1]) - 1] ?? "";
    const totalAPagar = Math.max(0, args.valor - saldoAFavor);
    const now = Date.now();
    const consecutivo = String(now).slice(-6);
    const numeroFactura = `FAC-${args.periodo}-${unidad.numero}-${consecutivo}`;
    const numeroInterno = consecutivo;

    // Una factura nueva no puede llevar un archivo de Convex Storage (`model/files.ts`).
    const pdfStorageId = exigirStorageIdDelRegistro(args.pdfStorageId);
    let pdfUrl = args.pdfUrl;
    if (!pdfUrl && pdfStorageId) {
      pdfUrl = (await ctx.storage.getUrl(pdfStorageId)) ?? undefined;
    }

    const entrada: EntradaFactura = {
      condominioId: args.condominioId,
      unidadId: args.unidadId,
      membershipId,
      numeroFactura,
      numeroInterno,
      periodo: args.periodo,
      periodoLabel: periodoLabelFrom(args.periodo),
      residenteNombre,
      apto,
      vrAdmon: args.valor,
      lineas: [
        {
          codigo: 1,
          concepto: `Administración de ${mesNombre}`,
          saldoAnterior: 0,
          actual: args.valor,
          total: args.valor,
        },
      ],
      saldoAFavor,
      totalAPagar,
      totalConDescuento: args.totalConDescuento,
      fechaEmision: now,
      fechaVencimiento: args.fechaVencimiento,
      pdfUrl,
      origen: "manual",
    };
    const escritura = await escribirFactura(ctx, entrada, { siExiste: "error" });
    if (escritura.accion !== "insertada") {
      throw new Error("Ya existe una factura para esta unidad en ese período.");
    }

    await recalcularCadena(ctx, args.condominioId, args.unidadId, {
      origen: "carga",
      actor: nombreDe(user),
      actorUserId: user._id,
      tocadas: new Map([[escritura.facturaId, escritura.tocada]]),
    });
    return escritura.facturaId;
  },
});

/** Cuantas facturas devuelve `listMia`, ademas de las vigentes. */
const LIMITE_LIST_MIA = 50;

/**
 * Facturas de las unidades del usuario autenticado en este condominio.
 *
 * Fase 4 (F-16):
 * - Las unidades salen de `misUnidadIds`, la misma puerta de todo el acceso
 *   del residente: solo vinculos VIGENTES (un arrendatario cuyo contrato
 *   vencio ya no ve la casa, #55) y cada casa una vez, aunque tenga dos
 *   vinculos (#54).
 * - Cada factura sale una vez (por `_id`).
 * - La VIGENTE de cada unidad —todas las del periodo mas reciente— llega
 *   siempre, aunque el residente tenga mas de 50 facturas: se lee por unidad
 *   y por periodo (`by_condominio_unidad_periodo`) y no se recorta. Antes el
 *   recorte iba por fecha de carga entre todas las unidades, y una casa cuyas
 *   facturas se cargaron antes podia quedarse sin la suya; el estado, los
 *   botones de pago y el resumen se calculan sobre esta lista.
 */
export const listMia = query({
  args: { condominioId: v.id("condominios") },
  handler: async (ctx, args) => {
    const { user, membership } = await requireCondominioRole(ctx, args.condominioId, []);

    let rows: Doc<"facturas">[];

    if (!membership) {
      // Superadmin/admin: retorna las últimas facturas del condominio
      rows = await ctx.db
        .query("facturas")
        .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
        .order("desc")
        .take(LIMITE_LIST_MIA);
    } else {
      const unidades = [...(await misUnidadIds(ctx, user._id, args.condominioId))];
      if (unidades.length === 0) return [];

      const porUnidad = await Promise.all(
        unidades.map((unidadId) =>
          ctx.db
            .query("facturas")
            .withIndex("by_condominio_unidad_periodo", (q) =>
              q.eq("condominioId", args.condominioId).eq("unidadId", unidadId),
            )
            .order("desc")
            .take(LIMITE_LIST_MIA),
        ),
      );

      rows = facturasDelResidente(porUnidad, LIMITE_LIST_MIA);
    }

    const unidadCache = new Map<
      Id<"unidades">,
      { numero: string; tipo: string; torre: string | null }
    >();

    return await Promise.all(
      rows.map(async (f) => {
        let u = unidadCache.get(f.unidadId);
        if (!u) {
          const doc = await ctx.db.get(f.unidadId);
          u = doc
            ? {
                numero: doc.numero,
                tipo: doc.tipo,
                torre: doc.torre ?? null,
              }
            : { numero: "—", tipo: "otro", torre: null };
          unidadCache.set(f.unidadId, u);
        }
        return {
          ...f,
          unidadNumero: u.numero,
          unidadTipo: u.tipo,
          unidadTorre: u.torre,
        };
      }),
    );
  },
});

/**
 * Backfill de fechas. Las facturas migradas quedaron con fechaEmision y
 * fechaVencimiento en 0 (epoch → se muestra "31 de diciembre de 1969").
 * Deriva ambas del período "YYYY-MM":
 *   fechaEmision     = día 1 del mes del período
 *   fechaVencimiento = día 15 del mes siguiente (regla documentada en el schema)
 * Solo toca facturas con la fecha en 0. Idempotente. No mueve el estado;
 * cada factura completada deja su evento en la bitácora.
 */
export const backfillFechas = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("facturas").collect();
    let actualizadas = 0;
    for (const f of rows) {
      if (f.fechaEmision > 0 && f.fechaVencimiento > 0) continue;
      const parts = f.periodo.split("-");
      const y = Number(parts[0]);
      const m = Number(parts[1]);
      if (!y || !m) continue;
      const tocada = await actualizarDocumento(
        ctx,
        f,
        {
          fechaEmision: f.fechaEmision > 0 ? f.fechaEmision : Date.UTC(y, m - 1, 1, 12),
          fechaVencimiento:
            f.fechaVencimiento > 0 ? f.fechaVencimiento : Date.UTC(y, m, 15, 12),
        },
        "Fechas completadas",
      );
      if (tocada) {
        await anotarEvento(
          ctx,
          f,
          { origen: "migracion", actor: "facturas.backfillFechas" },
          tocada.detalle,
          tocada.datos,
        );
      }
      actualizadas++;
    }
    return { actualizadas, total: rows.length };
  },
});

/**
 * Estado de cartera de un grupo de unidades, en una sola consulta.
 *
 * Nace para la tabla de reservas: la administración necesita ver, al lado de
 * cada solicitud, si esa casa está al día. Vive aquí y no en `reservas.ts`
 * porque es cartera —quién debe y desde cuándo lo decide este módulo— y
 * porque así hereda su control de acceso: `reservas.listPage` la puede leer
 * cualquier miembro del conjunto, y la situación financiera del vecino no es
 * dato de vecino. Reservas solo la consume.
 *
 * ── Por qué recibe una lista y no una unidad ─────────────────────────────
 * Preguntar unidad por unidad desde la tabla serían tantas consultas como
 * filas. Se piden juntas y se responden juntas: el llamador manda las
 * unidades DISTINTAS que tiene en pantalla —treinta reservas suelen ser doce
 * casas— y cada una se lee una sola vez.
 *
 * NO decide nada sobre la reserva. Informa; aprobar o rechazar sigue siendo
 * de quien administra, que es el único que sabe si hay un acuerdo de pago de
 * por medio.
 */

/**
 * Topes de la consulta. Se leen juntos: lo que acota el trabajo es el
 * PRODUCTO, porque cada unidad se resuelve con su propio recorrido de índice.
 *
 * 120 × 120 = 14.400 documentos en el peor caso imaginable, que es el orden
 * de lo que Convex deja leer en una función. Con 240 facturas por unidad el
 * peor caso se pasaba del techo y la consulta reventaba en vez de degradarse.
 *
 * Ninguno se alcanza con datos reales: 120 unidades son cuatro páginas de
 * reservas sin una sola casa repetida, y 120 facturas son diez años de cuotas
 * mensuales. Son cinturones de seguridad, no dimensionamiento.
 *
 * Si el de unidades se alcanza, las que sobren se devuelven sin fila: quien
 * llama debe distinguir "todavía cargando" de "no vino", y no dejar una
 * casilla girando para siempre.
 */
const MAX_UNIDADES_CARTERA = 120;
const MAX_FACTURAS_UNIDAD = 120;

export const carteraPorUnidad = query({
  args: {
    condominioId: v.id("condominios"),
    unidadIds: v.array(v.id("unidades")),
  },
  handler: async (ctx, args) => {
    await requireCondominioRole(ctx, args.condominioId, [...CARTERA_ROLES]);

    const ids = [...new Set(args.unidadIds)].slice(0, MAX_UNIDADES_CARTERA);
    const ahora = Date.now();

    const filas = await Promise.all(
      ids.map(async (unidadId) => {
        /* El id llega del cliente: hay que comprobar que la unidad es de ESTE
         * conjunto antes de contar su plata. Sin esto, quien administra un
         * conjunto podría leer la cartera de otro pasando ids ajenos. */
        const unidad = await ctx.db.get(unidadId);
        if (!unidad || unidad.condominioId !== args.condominioId) return null;

        const facturas = await ctx.db
          .query("facturas")
          .withIndex("by_unidad", (q) => q.eq("unidadId", unidadId))
          .take(MAX_FACTURAS_UNIDAD);

        /* `by_unidad` no lleva el condominio en la llave; el mismo filtro que
         * hace la conciliación. */
        const propias = facturas.filter((f) => f.condominioId === args.condominioId);

        return { unidadId, ...carteraDeUnidad(propias, ahora) };
      }),
    );

    return filas.filter((f) => f !== null);
  },
});

/**
 * Estado de cuenta de UNA unidad: sus facturas, una por una.
 *
 * Es el detalle detrás del resumen que `carteraPorUnidad` pone en la tabla de
 * reservas, y se pide sólo cuando la administración abre el modal de una
 * casa. Por eso son dos consultas y no una: cargar el detalle de las treinta
 * casas de la página para que se mire una sería traer treinta veces más de lo
 * que se va a leer.
 *
 * No calcula nada nuevo. El estado de cada factura lo puso la conciliación y
 * la mora sale del vencimiento. Aquí sólo se ordena la cadena y se traduce.
 *
 * Devuelve `null` si la unidad no es de este condominio, en vez de lanzar:
 * quien pregunta ya demostró que administra ESTE conjunto, y un id que no
 * corresponde es una pantalla desincronizada, no un intento de intrusión. Lo
 * que no hace nunca es responder con datos de otro conjunto.
 */
export const estadoCuentaUnidad = query({
  args: {
    condominioId: v.id("condominios"),
    unidadId: v.id("unidades"),
  },
  handler: async (ctx, args) => {
    await requireCondominioRole(ctx, args.condominioId, [...CARTERA_ROLES]);

    const unidad = await ctx.db.get(args.unidadId);
    if (!unidad || unidad.condominioId !== args.condominioId) return null;

    const cadena = (
      await ctx.db
        .query("facturas")
        .withIndex("by_unidad", (q) => q.eq("unidadId", args.unidadId))
        .take(MAX_FACTURAS_UNIDAD)
    )
      .filter((f) => f.condominioId === args.condominioId)
      /* Del más viejo al más nuevo: cada factura se juzga con la siguiente,
       * igual que en la conciliación. */
      .sort((a, b) => a.periodo.localeCompare(b.periodo));

    const ahora = Date.now();
    const cartera = carteraDeUnidad(cadena, ahora);
    const filas = estadoCuentaDeCadena(cadena).map((fila, i) => ({
      ...fila,
      /* Lo que se muestra: la vigente de una unidad en mora es "vencida",
       * como dice la cartera de arriba (QA de comprobantes, H2). */
      estadoVisible: estadoVisibleDeFactura(cadena[i]!, cadena, cartera),
      _id: cadena[i]!._id,
      numeroFactura: cadena[i]!.numeroFactura,
      fechaEmision: cadena[i]!.fechaEmision,
      pdfUrl: cadena[i]!.pdfUrl ?? null,
    }));

    return {
      unidad: {
        _id: unidad._id,
        numero: unidad.numero,
        torre: unidad.torre ?? null,
        residenteNombre: cadena[cadena.length - 1]?.residenteNombre ?? null,
      },
      cartera,
      /* De la más reciente hacia atrás: es el orden en el que se lee un
       * estado de cuenta. */
      facturas: filas.reverse(),
    };
  },
});

// ─────────────────────────────────────────────────────────────
// Finanzas: lo que la administración tiene que revisar (Fase 3)
// ─────────────────────────────────────────────────────────────

type UnidadCorta = { numero: string; torre: string | null };

async function etiquetaUnidad(
  ctx: QueryCtx,
  cache: Map<Id<"unidades">, UnidadCorta>,
  unidadId: Id<"unidades">,
): Promise<UnidadCorta> {
  let u = cache.get(unidadId);
  if (!u) {
    const doc = await ctx.db.get(unidadId);
    u = { numero: doc?.numero ?? "—", torre: doc?.torre ?? null };
    cache.set(unidadId, u);
  }
  return u;
}

/**
 * Pagos por revisar del conjunto:
 *   · discrepancias: Vekino registró un pago que la factura siguiente no
 *     refleja (abiertas primero, y las resueltas recientes con su motivo);
 *   · excedentes: facturas pagadas de más (se informan; no se aplican solos);
 *   · pagos sin estado final: la pasarela no respondió y la consulta
 *     automática se rindió (`pagos.reconsultaDiaria`).
 */
export const pagosPorRevisar = query({
  args: { condominioId: v.id("condominios") },
  handler: async (ctx, args) => {
    await requireCondominioRole(ctx, args.condominioId, [...CARTERA_ROLES]);
    const cache = new Map<Id<"unidades">, UnidadCorta>();

    const discrepancias = await ctx.db
      .query("discrepanciasPago")
      .withIndex("by_condominio_estado", (q) => q.eq("condominioId", args.condominioId))
      .order("desc")
      .take(200);
    const ordenadas = [...discrepancias].sort((a, b) =>
      a.estado === b.estado ? b.updatedAt - a.updatedAt : a.estado === "abierta" ? -1 : 1,
    );
    const filasDiscrepancia = [];
    for (const d of ordenadas) {
      const u = await etiquetaUnidad(ctx, cache, d.unidadId);
      filasDiscrepancia.push({
        _id: d._id,
        estado: d.estado,
        unidadNumero: u.numero,
        unidadTorre: u.torre,
        facturaId: d.facturaId,
        facturaSiguienteId: d.facturaSiguienteId,
        periodo: d.periodo,
        periodoSiguiente: d.periodoSiguiente,
        montoAdeudado: d.montoAdeudado,
        montoPagado: d.montoPagado,
        saldoAnteriorSiguiente: d.saldoAnteriorSiguiente,
        montoNoAplicado: d.montoNoAplicado,
        pagos: d.pagoIds.length,
        comprobantes: d.soporteIds.length,
        resolucion: d.resolucion ?? null,
        createdAt: d.createdAt,
      });
    }

    const facturas = await ctx.db
      .query("facturas")
      .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
      .collect();
    const excedentes = [];
    for (const f of facturas) {
      if (!f.estadoPago?.excedente) continue;
      const u = await etiquetaUnidad(ctx, cache, f.unidadId);
      excedentes.push({
        facturaId: f._id,
        periodo: f.periodo,
        unidadNumero: u.numero,
        unidadTorre: u.torre,
        montoAdeudado: f.estadoPago.montoAdeudado,
        montoPagado: f.estadoPago.montoPagado,
        excedente: f.estadoPago.excedente,
      });
    }

    const pagos = await ctx.db
      .query("pagos")
      .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
      .order("desc")
      .take(500);
    const sinEstadoFinal = [];
    for (const p of pagos) {
      if (!p.consultaAgotadaAt || (p.estado !== "iniciada" && p.estado !== "pendiente")) continue;
      const u = await etiquetaUnidad(ctx, cache, p.unidadId);
      sinEstadoFinal.push({
        pagoId: p._id,
        facturaId: p.facturaId,
        unidadNumero: u.numero,
        unidadTorre: u.torre,
        monto: p.monto,
        estado: p.estado,
        createdAt: p.createdAt,
        consultaAgotadaAt: p.consultaAgotadaAt,
      });
    }

    return { discrepancias: filasDiscrepancia, excedentes, sinEstadoFinal };
  },
});

/**
 * La administración resuelve a mano una discrepancia: verificó con la
 * contabilidad (o con el banco) y deja escrito qué encontró.
 *
 * Al resolverla, la vigente deja de estar "pago en verificación" y vuelve a
 * poderse pagar por el valor de su documento. Por eso la nota es obligatoria:
 * resolver sin que la contabilidad haya reflejado el pago es volver a cobrar
 * lo que el residente ya pagó. Si la contabilidad emite un documento
 * corregido, no hace falta resolverla: se resuelve sola al cargarlo.
 */
export const resolverDiscrepancia = mutation({
  args: { id: v.id("discrepanciasPago"), nota: v.string() },
  handler: async (ctx, args) => {
    const d = await ctx.db.get(args.id);
    if (!d) throw new Error("Discrepancia no encontrada.");
    const { user } = await requireCondominioRole(ctx, d.condominioId, [...CARGA_ROLES]);
    const nota = args.nota.trim().slice(0, 500);
    if (!nota) throw new Error("Escribe qué se verificó para resolverla.");
    if (d.estado === "resuelta") return args.id;

    const ahora = Date.now();
    await ctx.db.patch(args.id, {
      estado: "resuelta",
      resolucion: {
        tipo: "administracion",
        nota,
        userId: user._id,
        nombre: nombreDe(user),
        at: ahora,
      },
      updatedAt: ahora,
    });
    const contexto = {
      origen: "discrepancia" as const,
      actor: nombreDe(user),
      actorUserId: user._id,
    };
    const factura = await ctx.db.get(d.facturaId);
    if (factura) {
      await anotarEvento(
        ctx,
        factura,
        contexto,
        `Discrepancia resuelta por ${nombreDe(user)}: ${nota}`,
        { discrepanciaId: d._id, montoNoAplicado: d.montoNoAplicado },
      );
    }
    await recalcularCadena(ctx, d.condominioId, d.unidadId, contexto);
    return args.id;
  },
});

/**
 * Meses faltantes: unidades a las que les falta la factura de algún mes.
 *
 *   · `hueco`: entre dos facturas cargadas falta una (agosto y octubre, sin
 *     septiembre). El saldo anterior de octubre no permite juzgar agosto
 *     (F-09): queda sin veredicto hasta que se cargue septiembre.
 *   · `al_final`: a la unidad le faltan los meses más recientes que el
 *     conjunto ya cargó para las demás. Su "vigente" es vieja.
 */
export const mesesFaltantes = query({
  args: { condominioId: v.id("condominios") },
  handler: async (ctx, args) => {
    await requireCondominioRole(ctx, args.condominioId, [...CARTERA_ROLES]);
    const facturas = await ctx.db
      .query("facturas")
      .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
      .collect();
    const ultimoDelConjunto = facturas.reduce(
      (max, f) => (f.periodo.localeCompare(max) > 0 ? f.periodo : max),
      "",
    );
    const porUnidad = new Map<Id<"unidades">, Set<string>>();
    for (const f of facturas) {
      const s = porUnidad.get(f.unidadId) ?? new Set<string>();
      s.add(f.periodo);
      porUnidad.set(f.unidadId, s);
    }

    /** Los períodos estrictamente entre `desde` y `hasta` (a lo sumo dos años). */
    const entre = (desde: string, hasta: string, incluirHasta: boolean): string[] => {
      const faltan: string[] = [];
      for (
        let p = periodoSiguiente(desde);
        (incluirHasta ? p.localeCompare(hasta) <= 0 : p.localeCompare(hasta) < 0) && faltan.length < 24;
        p = periodoSiguiente(p)
      ) {
        faltan.push(p);
      }
      return faltan;
    };

    const cache = new Map<Id<"unidades">, UnidadCorta>();
    const filas = [];
    for (const [unidadId, periodos] of porUnidad) {
      const orden = [...periodos].sort();
      const huecos: {
        tipo: "hueco" | "al_final";
        desde: string;
        hasta: string | null;
        faltan: string[];
      }[] = [];
      for (let i = 1; i < orden.length; i++) {
        if (periodosConsecutivos(orden[i - 1]!, orden[i]!)) continue;
        huecos.push({
          tipo: "hueco",
          desde: orden[i - 1]!,
          hasta: orden[i]!,
          faltan: entre(orden[i - 1]!, orden[i]!, false),
        });
      }
      const ultimo = orden[orden.length - 1]!;
      if (ultimoDelConjunto && ultimo.localeCompare(ultimoDelConjunto) < 0) {
        huecos.push({
          tipo: "al_final",
          desde: ultimo,
          hasta: null,
          faltan: entre(ultimo, ultimoDelConjunto, true),
        });
      }
      if (huecos.length === 0) continue;
      const u = await etiquetaUnidad(ctx, cache, unidadId);
      filas.push({ unidadId, unidadNumero: u.numero, unidadTorre: u.torre, huecos });
    }
    return {
      ultimoPeriodo: ultimoDelConjunto || null,
      unidades: filas.sort((a, b) =>
        a.unidadNumero.localeCompare(b.unidadNumero, "es", { numeric: true }),
      ),
    };
  },
});

/** La bitácora de una factura: cada cambio, con su origen y quién. */
export const eventos = query({
  args: { facturaId: v.id("facturas") },
  handler: async (ctx, args) => {
    const factura = await ctx.db.get(args.facturaId);
    if (!factura) return [];
    await requireCondominioRole(ctx, factura.condominioId, [...CARTERA_ROLES]);
    const filas = await ctx.db
      .query("facturaEventos")
      .withIndex("by_factura", (q) => q.eq("facturaId", args.facturaId))
      .order("desc")
      .take(100);
    return filas.map((e) => ({
      _id: e._id,
      at: e.at,
      origen: e.origen,
      estadoAntes: e.estadoAntes ?? null,
      estadoDespues: e.estadoDespues,
      actor: e.actor ?? null,
      detalle: e.detalle,
    }));
  },
});
