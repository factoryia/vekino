import {
  carteraDeUnidad,
  resumenResidente,
  type CarteraUnidad,
  type EstadoCartera,
  type EstadoFactura,
  type EvidenciaGuardada,
  type LineaFactura,
} from "./cartera";
import {
  calcularCadena,
  type DiscrepanciaGuardada,
  type PagoRegistrado,
  type VeredictoContable,
} from "./estadoFactura";
import {
  motivosValidos,
  normalizarPeriodo,
  rechazoDePeriodo,
  validarLectura,
  type MotivoRechazo,
} from "./lecturaFactura";

/**
 * RE-PROCESAMIENTO de facturas ya cargadas con el parser nuevo (Fase 2 de la
 * auditoría de facturación, docs/audits/FASE-2-FACTURACION.md).
 *
 * Simula, para UNA unidad, volver a cargar cada factura de su cadena con la
 * lectura nueva de su propio PDF, con la misma semántica de `bulkUpsert` al
 * actualizar, y volver a conciliar la cadena con la misma regla
 * (`veredictoConciliacion`). Devuelve qué cambiaría, factura por factura, y
 * cómo quedaría la unidad para la administración (`carteraDeUnidad`) y para
 * el residente (`resumenResidente`).
 *
 * Es código puro: lo usan el informe en modo dry-run (sobre una exportación)
 * y `facturas.reprocesarLecturas`, que aplica exactamente este plan cuando se
 * autorice. Así lo que se revisa con la administración es lo que se escribe.
 *
 * ── Lo que NO toca ───────────────────────────────────────────────────────
 *   · Los números de una factura con evidencia de pago (pago aprobado o
 *     comprobante aprobado). Su estado lo sigue calculando la regla de la
 *     Fase 3 (`lib/estadoFactura.ts`), que la inferencia no puede degradar.
 *   · Una factura cuyo documento dice otro período: no se reescribe con él.
 *   · Una factura cuyo documento publicado NO es el que se cargó: otro
 *     consecutivo (`documento_distinto`). Pasó con la casa 802 de Ciudad del
 *     Campo en septiembre de 2026: el PDF consolidado traía dos estados de
 *     cuenta para ella, el segundo pisó al primero en S3, y la base guardó los
 *     números del primero. Re-leer el PDF publicado habría reemplazado la
 *     cuenta correcta por la otra (FASE-3-FACTURACION.md, §2).
 *   · Una factura sin documento que leer.
 *
 * El estado de la cadena lo calcula `calcularCadena` (`lib/estadoFactura.ts`),
 * el mismo cálculo que aplica `model/estadoFactura.ts`: lo que se simula es
 * lo que se escribe.
 */

/** Lo que el parser nuevo lee del PDF ya publicado de una factura. */
export type LecturaNueva = {
  vrAdmon: number;
  lineas: LineaFactura[];
  saldoAFavor: number;
  totalAPagar: number;
  totalConDescuento?: number;
  saldoAnteriorDocumento?: number;
  periodoLabel: string;
  /** Lo que el parser vio en el PDF y no se comprueba con los números (`FacturaLeida.motivos`). */
  motivos: readonly string[];
  /** El consecutivo del documento ("Nro."). Si no coincide con el guardado, es otro documento. */
  numeroInterno?: string;
};

/** La marca de lectura dudosa, tal como se guarda en la factura. */
export type MarcaLectura = {
  motivos: string[];
  marcadaAt: number;
  confirmada?: { userId: string; nombre: string; at: number };
};

/** Una factura guardada: lo que el re-procesamiento lee y puede cambiar. */
export type FacturaGuardada = {
  _id: string;
  unidadId: string;
  periodo: string;
  periodoLabel: string;
  numeroInterno?: string;
  estado: EstadoFactura;
  fechaVencimiento: number;
  vrAdmon: number;
  lineas: LineaFactura[];
  saldoAFavor: number;
  totalAPagar: number;
  totalConDescuento?: number;
  fechaLimiteDescuento?: number;
  saldoAnteriorDocumento?: number;
  lecturaDudosa?: MarcaLectura;
  veredictoContable?: (VeredictoContable & { at?: number }) | null;
  /** Con su monto: lo abonado baja el saldo de la vigente (`carteraDeUnidad`). */
  estadoPago?: EvidenciaGuardada | null;
  pagoEnVerificacion?: { monto: number } | null;
  /** Por dónde entró: una `manual` no juzga a la anterior (`informaSaldoAnterior`). */
  origen?: string | null;
};

/** Por qué una factura se deja como está. */
export type Omision =
  | "evidencia_de_pago"
  | "sin_documento"
  | "documento_distinto"
  | MotivoRechazo;

/** Los campos que el re-procesamiento puede cambiar. */
export const CAMPOS_REPROCESO = [
  "totalAPagar",
  "totalConDescuento",
  "saldoAFavor",
  "vrAdmon",
  "lineas",
  "saldoAnteriorDocumento",
  "periodoLabel",
  "lecturaDudosa",
  "estado",
] as const;
export type CampoReproceso = (typeof CAMPOS_REPROCESO)[number];

export type ParcheFactura = {
  totalAPagar?: number;
  totalConDescuento?: number;
  saldoAFavor?: number;
  vrAdmon?: number;
  lineas?: LineaFactura[];
  saldoAnteriorDocumento?: number;
  periodoLabel?: string;
  lecturaDudosa?: MarcaLectura;
  estado?: EstadoFactura;
};

export type PlanFactura = {
  facturaId: string;
  periodo: string;
  omitida: Omision | null;
  /** Motivos de lectura dudosa con la lectura nueva (vacío si cuadra). */
  motivos: string[];
  cambios: { campo: CampoReproceso; antes: unknown; despues: unknown }[];
  /**
   * Lo que hay que escribir. Un campo presente con valor `undefined` se
   * borra (p. ej. la marca de una lectura que ahora cuadra).
   */
  parche: ParcheFactura;
};

/** Cómo se ve la unidad: para la administración y para el residente. */
export type FotoUnidad = {
  cartera: CarteraUnidad;
  residente: EstadoCartera;
  /** La vigente que se le ofrece pagar, si alguna. */
  pagable: { facturaId: string; periodo: string; totalAPagar: number } | null;
};

export type PlanUnidad = {
  unidadId: string;
  facturas: PlanFactura[];
  antes: FotoUnidad;
  despues: FotoUnidad;
};

function igualLineas(a: readonly LineaFactura[], b: readonly LineaFactura[]): boolean {
  return (
    a.length === b.length &&
    a.every((x, i) => {
      const y = b[i]!;
      return (
        x.codigo === y.codigo &&
        (x.codigoTexto ?? null) === (y.codigoTexto ?? null) &&
        x.concepto === y.concepto &&
        x.saldoAnterior === y.saldoAnterior &&
        x.actual === y.actual &&
        x.total === y.total
      );
    })
  );
}

function mismosMotivos(marca: MarcaLectura | undefined, motivos: readonly string[]): boolean {
  return !!marca && marca.motivos.length === motivos.length && marca.motivos.every((m, i) => m === motivos[i]);
}

function igual(campo: CampoReproceso, a: unknown, b: unknown): boolean {
  if (campo === "lineas") return igualLineas(a as LineaFactura[], b as LineaFactura[]);
  if (campo === "lecturaDudosa") {
    const x = a as MarcaLectura | undefined;
    const y = b as MarcaLectura | undefined;
    return x === y || (!!x && !!y && mismosMotivos(x, y.motivos) && !!x.confirmada === !!y.confirmada);
  }
  return a === b;
}

function foto<F extends FacturaGuardada>(cadena: readonly F[], ahora: number): FotoUnidad {
  const r = resumenResidente(cadena, ahora);
  const u = r.unidades[0];
  return {
    cartera: u?.cartera ?? carteraDeUnidad([], ahora),
    residente: r.estado,
    pagable: u?.pagable
      ? { facturaId: u.pagable._id, periodo: u.pagable.periodo, totalAPagar: u.pagable.totalAPagar }
      : null,
  };
}

/**
 * El plan de re-procesamiento de una unidad.
 *
 * 1. Cada factura toma su lectura nueva —total, líneas, saldo a favor,
 *    saldo anterior del documento y marca de lectura dudosa—, salvo las que
 *    se omiten (evidencia de pago, sin documento, otro período, otro
 *    documento). Como en `bulkUpsert`: una lectura que cuadra quita la
 *    marca; una que no, la pone. Si ya tenía exactamente esa marca (quizá
 *    confirmada) se conserva. La etiqueta del período solo se reemplaza por
 *    una legible.
 * 2. El estado de toda la cadena se calcula con la regla de la Fase 3
 *    (`calcularCadena`): evidencia de pago, veredicto de la factura
 *    siguiente y estado de carga, con las lecturas nuevas.
 *
 * `cadena` son todas las facturas de la unidad en su conjunto, en cualquier
 * orden; `pagos`, los pagos aprobados y comprobantes aprobados de esas
 * facturas. Es idempotente: con el plan aplicado, el siguiente sale vacío.
 */
export function planificarReproceso<F extends FacturaGuardada>(args: {
  cadena: readonly F[];
  lecturas: ReadonlyMap<string, LecturaNueva>;
  pagos: readonly PagoRegistrado[];
  discrepancias?: readonly DiscrepanciaGuardada[];
  ahora: number;
}): PlanUnidad {
  const { lecturas, ahora } = args;
  const conEvidencia = new Set(args.pagos.map((p) => p.facturaId));
  const ordenada = [...args.cadena].sort((a, b) => a.periodo.localeCompare(b.periodo));

  // 1. Lecturas nuevas
  const pasos = ordenada.map((f) => {
    const sinCambio = (omitida: Omision) => ({ f, omitida, motivos: [] as string[], nueva: { ...f } });
    if (conEvidencia.has(f._id)) return sinCambio("evidencia_de_pago");
    const l = lecturas.get(f._id);
    if (!l) return sinCambio("sin_documento");
    const rechazo = rechazoDePeriodo(f.periodo, l.periodoLabel);
    if (rechazo) return sinCambio(rechazo);
    if (
      l.numeroInterno?.trim() &&
      f.numeroInterno?.trim() &&
      l.numeroInterno.trim() !== f.numeroInterno.trim()
    ) {
      return sinCambio("documento_distinto");
    }

    const motivos = motivosValidos([...validarLectura(l), ...l.motivos]);
    const lecturaDudosa: MarcaLectura | undefined =
      motivos.length === 0
        ? undefined
        : mismosMotivos(f.lecturaDudosa, motivos)
          ? f.lecturaDudosa
          : { motivos, marcadaAt: ahora };
    const nueva: F = {
      ...f,
      vrAdmon: l.vrAdmon,
      lineas: l.lineas,
      saldoAFavor: l.saldoAFavor,
      totalAPagar: l.totalAPagar,
      totalConDescuento: l.totalConDescuento,
      saldoAnteriorDocumento: l.saldoAnteriorDocumento,
      periodoLabel: normalizarPeriodo(l.periodoLabel) ? l.periodoLabel : f.periodoLabel,
      lecturaDudosa,
    };
    return { f, omitida: null, motivos, nueva };
  });

  // 2. Estado de la cadena con las lecturas nuevas (la regla de la Fase 3)
  const nuevas = pasos.map((p) => p.nueva);
  const calculo = calcularCadena({
    cadena: nuevas,
    pagos: args.pagos,
    discrepancias: args.discrepancias ?? [],
  });
  for (const n of nuevas) {
    const r = calculo.facturas.get(n._id);
    if (!r) continue;
    n.estado = r.estado;
    n.veredictoContable = r.veredicto;
    n.estadoPago = r.estadoPago;
    n.pagoEnVerificacion = r.pagoEnVerificacion ? { monto: r.pagoEnVerificacion.monto } : null;
  }

  const facturas: PlanFactura[] = pasos.map(({ f, omitida, motivos, nueva }) => {
    const cambios: PlanFactura["cambios"] = [];
    const parche: Record<string, unknown> = {};
    for (const campo of CAMPOS_REPROCESO) {
      if (igual(campo, f[campo], nueva[campo])) continue;
      cambios.push({ campo, antes: f[campo], despues: nueva[campo] });
      parche[campo] = nueva[campo];
    }
    return { facturaId: f._id, periodo: f.periodo, omitida, motivos, cambios, parche: parche as ParcheFactura };
  });

  return {
    unidadId: ordenada[0]?.unidadId ?? "",
    facturas,
    antes: foto(ordenada, ahora),
    despues: foto(nuevas, ahora),
  };
}

