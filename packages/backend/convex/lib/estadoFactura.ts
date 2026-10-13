import {
  TOLERANCIA_PAGO,
  enRevision,
  facturaVigente,
  fechaLimiteDescuentoDe,
  informaSaldoAnterior,
  periodosConsecutivos,
  saldoAnteriorDe,
  veredictoConciliacion,
  type EstadoFactura,
  type LecturaDudosa,
  type LineaFactura,
  type Veredicto,
} from "./cartera.ts";
import { estadoDeCarga } from "./lecturaFactura.ts";

/**
 * EL ESTADO DE UNA FACTURA (Fase 3 de la auditoría de facturación,
 * docs/audits/FASE-3-FACTURACION.md).
 *
 * ── Dos fuentes, y no valen lo mismo ─────────────────────────────────────
 * Hasta la Fase 2, `facturas.estado` era un campo que escribían tres rutas y
 * ganaba la última: la pasarela (`pagos.aplicarEstado`), la aprobación de un
 * comprobante y la conciliación por saldo anterior. Las dos primeras son
 * EVIDENCIA de pago: Vekino vio el pago. La tercera es una INFERENCIA: la
 * factura siguiente dice cuánto quedó debiendo la unidad, y de ahí se deduce
 * si la anterior se pagó. Con la contabilidad atrasada o un PDF mal leído, la
 * inferencia borraba pagos que sí ocurrieron (F-02, F-12).
 *
 * Ahora cada fuente se guarda aparte —`estadoPago` (evidencia) y
 * `veredictoContable` (inferencia)— y el estado sale de las dos, aquí:
 *
 *   · La evidencia es un piso: la inferencia puede mejorarla (una abonada
 *     que la contabilidad da por saldada queda pagada), nunca empeorarla.
 *   · Sin evidencia manda el veredicto. Un "pagada" inferido sí se corrige si
 *     llega el documento siguiente corregido.
 *   · Sin ninguna de las dos, el estado de carga: pendiente o saldo a favor.
 *
 * Si la contabilidad contradice un pago (el saldo anterior siguiente es mayor
 * que lo que quedaba por pagar), no se le cree a ciegas a ninguno de los dos:
 * se registra una DISCREPANCIA y la vigente queda "pago en verificación"
 * hasta que un documento la resuelva o la administración la revise.
 *
 * Sin dependencias: se prueba con `node`, sin base de datos. Lo aplica
 * `model/estadoFactura.ts` y lo simula `lib/reproceso.ts`: el mismo cálculo.
 */

// ─────────────────────────────────────────────────────────────
// Evidencia de pago
// ─────────────────────────────────────────────────────────────

/** Un pago que Vekino vio: aprobado por la pasarela, o comprobante aprobado. */
export type PagoRegistrado = {
  id: string;
  facturaId: string;
  origen: "pasarela" | "comprobante";
  monto: number;
  /**
   * Cuándo se fijó el pago. En la pasarela, cuando se creó la transacción
   * (el monto, con o sin descuento, se cotiza ahí y es el que cobra el
   * banco); en un comprobante, la fecha que declaró quien pagó.
   */
  fecha: number;
  /**
   * Comprobante aprobado sin monto: se toma como pago completo de lo
   * adeudado (`soportesPago.montoAsumido`). `monto` es lo que se adeudaba al
   * aprobarlo, solo informativo.
   */
  asumido?: boolean;
};

export type EvidenciaPago = {
  estado: "pagada" | "abonada";
  montoPagado: number;
  /** Lo que se debía: el total con descuento si se pagó dentro del plazo. */
  montoAdeudado: number;
  conDescuento: boolean;
  /** Lo pagado de más, si pasa de la tolerancia. */
  excedente?: number;
};

type FacturaMontos = {
  periodo: string;
  totalAPagar: number;
  totalConDescuento?: number | null;
  fechaLimiteDescuento?: number | null;
};

/**
 * Lo que prueban los pagos de UNA factura, o `null` si no tiene.
 *
 * Se suman todos —la pasarela y los comprobantes, varios abonos— contra lo
 * que se debía al pagar: el total con descuento si lo pagado DENTRO del
 * plazo del descuento alcanza para él, y si no el total. Con eso:
 *
 *   pagado >= adeudado (±1)  → pagada (y el excedente, si lo hay, se informa)
 *   0 < pagado < adeudado    → abonada
 *
 * Un comprobante aprobado sin monto cuenta como pago completo.
 */
export function evidenciaDePago(
  factura: FacturaMontos,
  pagos: readonly PagoRegistrado[],
): EvidenciaPago | null {
  if (pagos.length === 0) return null;
  const montoPagado = pagos.reduce((s, p) => s + p.monto, 0);
  const limite = fechaLimiteDescuentoDe(factura);
  const conDescuentoPosible = limite !== null && typeof factura.totalConDescuento === "number";
  const enPlazo = conDescuentoPosible
    ? pagos.filter((p) => p.fecha <= limite!).reduce((s, p) => s + p.monto, 0)
    : 0;
  const conDescuento =
    conDescuentoPosible && enPlazo >= (factura.totalConDescuento as number) - TOLERANCIA_PAGO;
  const montoAdeudado = Math.max(
    0,
    conDescuento ? (factura.totalConDescuento as number) : factura.totalAPagar,
  );

  if (pagos.some((p) => p.asumido) || montoPagado >= montoAdeudado - TOLERANCIA_PAGO) {
    const excedente = montoPagado - montoAdeudado;
    return {
      estado: "pagada",
      montoPagado,
      montoAdeudado,
      conDescuento,
      ...(excedente > TOLERANCIA_PAGO && !pagos.some((p) => p.asumido) ? { excedente } : {}),
    };
  }
  if (montoPagado <= 0) return null;
  return { estado: "abonada", montoPagado, montoAdeudado, conDescuento };
}

// ─────────────────────────────────────────────────────────────
// La regla única del estado
// ─────────────────────────────────────────────────────────────

/**
 * El estado de la factura a partir de sus tres fuentes. Es LA regla: nadie
 * más escribe `facturas.estado`.
 *
 * | evidencia \ veredicto | ninguno o sin veredicto | pagada | abonada | vencida | saldo a favor |
 * |-----------------------|-------------------------|--------|---------|---------|---------------|
 * | ninguna               | carga                   | pagada | abonada | vencida | saldo a favor |
 * | abonada               | abonada                 | pagada | abonada | abonada | saldo a favor |
 * | pagada                | pagada                  | pagada | pagada  | pagada  | pagada        |
 *
 * `carga` es pendiente o saldo a favor según el documento
 * (`estadoDeCarga`), y pendiente si la lectura está en revisión.
 */
export function estadoDeFactura(args: {
  carga: "pendiente" | "saldo_a_favor";
  evidencia: Pick<EvidenciaPago, "estado"> | null;
  veredicto: Veredicto | null;
}): EstadoFactura {
  const { carga, evidencia, veredicto } = args;
  if (evidencia?.estado === "pagada") return "pagada";
  if (evidencia?.estado === "abonada") {
    return veredicto === "pagada" || veredicto === "saldo_a_favor" ? veredicto : "abonada";
  }
  if (veredicto && veredicto !== "sin_veredicto") return veredicto;
  return carga;
}

/** El estado con el que la factura entró: lo que dice su propio documento. */
export function estadoCarga(f: {
  totalAPagar: number;
  saldoAFavor: number;
  lecturaDudosa?: LecturaDudosa | null;
}): "pendiente" | "saldo_a_favor" {
  return enRevision(f) ? "pendiente" : estadoDeCarga(f);
}

// ─────────────────────────────────────────────────────────────
// Discrepancias: un pago que la contabilidad no refleja
// ─────────────────────────────────────────────────────────────

export type DiscrepanciaCalculada = {
  montoAdeudado: number;
  montoPagado: number;
  saldoAnteriorSiguiente: number;
  /** Lo pagado que el saldo anterior siguiente no muestra aplicado. */
  montoNoAplicado: number;
};

type FacturaPar = {
  periodo: string;
  lineas: readonly LineaFactura[];
  saldoAnteriorDocumento?: number;
  lecturaDudosa?: LecturaDudosa | null;
  origen?: string | null;
};

/**
 * Si el par N → N+1 se puede juzgar: meses consecutivos, ninguna en revisión
 * y N+1 con un saldo anterior de la contabilidad (no una factura hecha a mano,
 * `informaSaldoAnterior`).
 */
export function parJuzgable(
  anterior: { periodo: string; lecturaDudosa?: LecturaDudosa | null },
  siguiente: { periodo: string; lecturaDudosa?: LecturaDudosa | null; origen?: string | null },
): boolean {
  return (
    periodosConsecutivos(anterior.periodo, siguiente.periodo) &&
    !enRevision(anterior) &&
    !enRevision(siguiente) &&
    informaSaldoAnterior(siguiente)
  );
}

/**
 * Si la factura siguiente contradice los pagos de la anterior.
 *
 * Después de pagar, lo que quedaba por pagar de N es `adeudado − pagado`. Si
 * el saldo anterior de N+1 es mayor que eso (más la tolerancia), la
 * contabilidad no aplicó (todo) el pago: hay discrepancia, por lo pagado que
 * no se ve aplicado.
 *
 * NO es discrepancia un abono que la contabilidad refleja (agosto 300.000,
 * pagado 250.000, septiembre arrastra 50.000): eso es lo esperado. Tampoco se
 * juzga un par con un mes faltante o una lectura en revisión.
 */
export function discrepanciaDePar(
  evidencia: Pick<EvidenciaPago, "montoAdeudado" | "montoPagado"> | null,
  anterior: { periodo: string; lecturaDudosa?: LecturaDudosa | null },
  siguiente: FacturaPar,
): DiscrepanciaCalculada | null {
  if (!evidencia || evidencia.montoPagado <= 0) return null;
  if (!parJuzgable(anterior, siguiente)) return null;
  const saldoAnteriorSiguiente = saldoAnteriorDe(siguiente);
  const porPagar = Math.max(0, evidencia.montoAdeudado - evidencia.montoPagado);
  if (saldoAnteriorSiguiente <= porPagar + TOLERANCIA_PAGO) return null;
  const montoNoAplicado = Math.min(evidencia.montoPagado, saldoAnteriorSiguiente - porPagar);
  if (montoNoAplicado <= TOLERANCIA_PAGO) return null;
  return {
    montoAdeudado: evidencia.montoAdeudado,
    montoPagado: evidencia.montoPagado,
    saldoAnteriorSiguiente,
    montoNoAplicado,
  };
}

/**
 * Si un documento posterior (N+2) ya muestra aplicado lo que N+1 no
 * reflejaba: al cerrar N+1 se debía, a lo sumo, su total menos lo no
 * aplicado y menos lo que Vekino vio pagar de N+1.
 *
 * Un pago hecho por fuera de Vekino durante N+1 también baja el saldo, y
 * aquí se confundiría con el pago no aplicado. Es un límite conocido: lo
 * resuelve importar el recaudo del banco (diseño de la Fase 3, F-05).
 */
export function aplicadoEnPosterior(
  noAplicado: number,
  siguiente: {
    periodo: string;
    totalAPagar: number;
    lecturaDudosa?: LecturaDudosa | null;
    origen?: string | null;
  },
  pagadoSiguiente: number,
  posterior: FacturaPar,
): boolean {
  if (!parJuzgable(siguiente, posterior)) return false;
  return (
    saldoAnteriorDe(posterior) <=
    siguiente.totalAPagar - noAplicado - pagadoSiguiente + TOLERANCIA_PAGO
  );
}

// ─────────────────────────────────────────────────────────────
// La cadena entera de una unidad
// ─────────────────────────────────────────────────────────────

export type VeredictoContable = {
  estado: Veredicto;
  motivo?: "mes_faltante" | "heredado";
  facturaSiguienteId?: string;
  saldoAnteriorSiguiente?: number;
};

export type EstadoPagoCalculado = EvidenciaPago;

/** Lo que el cálculo necesita de cada factura de la cadena. */
export type FacturaEstado = {
  _id: string;
  periodo: string;
  estado: EstadoFactura;
  totalAPagar: number;
  totalConDescuento?: number;
  fechaLimiteDescuento?: number;
  saldoAFavor: number;
  lineas: readonly LineaFactura[];
  saldoAnteriorDocumento?: number;
  lecturaDudosa?: LecturaDudosa | null;
  veredictoContable?: (VeredictoContable & { at?: number }) | null;
  /** La evidencia guardada la última vez (Fase 3). */
  estadoPago?: { estado: "pagada" | "abonada" } | null;
  /** Por dónde entró: una `manual` no juzga a la anterior (`informaSaldoAnterior`). */
  origen?: string | null;
};

/** Una discrepancia ya guardada (`discrepanciasPago`). */
export type DiscrepanciaGuardada = {
  _id: string;
  facturaId: string;
  facturaSiguienteId: string;
  estado: "abierta" | "resuelta";
  resolucion?: { tipo: string } | null;
  montoPagado: number;
  montoNoAplicado: number;
};

export type TipoResolucion =
  | "documento_corregido"
  | "aplicado_en_documento_posterior"
  | "pago_reversado";

export type OperacionDiscrepancia =
  | {
      tipo: "crear";
      ref: string;
      facturaId: string;
      facturaSiguienteId: string;
      periodo: string;
      periodoSiguiente: string;
      calculo: DiscrepanciaCalculada;
      pagoIds: string[];
    }
  | { tipo: "actualizar"; id: string; calculo: DiscrepanciaCalculada; pagoIds: string[] }
  | { tipo: "reabrir"; id: string; calculo: DiscrepanciaCalculada; pagoIds: string[] }
  | { tipo: "resolver"; id: string; resolucion: TipoResolucion; facturaId?: string };

export type ResultadoFactura = {
  estado: EstadoFactura;
  estadoPago: EstadoPagoCalculado | null;
  veredicto: VeredictoContable | null;
  /** Solo la vigente: lo pagado que espera verificación, o `null`. */
  pagoEnVerificacion: { monto: number; refs: string[] } | null;
  /** Qué movió el estado, si cambió: la evidencia, el veredicto o la carga. */
  causa: "evidencia" | "veredicto" | "carga" | null;
};

export type ResultadoCadena = {
  facturas: Map<string, ResultadoFactura>;
  discrepancias: OperacionDiscrepancia[];
};

export function igualVeredicto(
  a: VeredictoContable | null | undefined,
  b: VeredictoContable | null | undefined,
): boolean {
  if (!a || !b) return !a && !b;
  return (
    a.estado === b.estado &&
    (a.motivo ?? null) === (b.motivo ?? null) &&
    (a.facturaSiguienteId ?? null) === (b.facturaSiguienteId ?? null) &&
    (a.saldoAnteriorSiguiente ?? null) === (b.saldoAnteriorSiguiente ?? null)
  );
}

/** Los estados que pone un veredicto: los que un dato heredado puede traer. */
const DE_VEREDICTO: ReadonlySet<EstadoFactura> = new Set(["pagada", "abonada", "vencida"]);

/**
 * El estado de TODA la cadena de una unidad: evidencia, veredicto y estado
 * de cada factura, las discrepancias que se abren, actualizan o resuelven, y
 * la marca de "pago en verificación" de la vigente.
 *
 * `cadena`: todas las facturas de la unidad (en cualquier orden).
 * `pagos`: los pagos aprobados de la pasarela y los comprobantes aprobados
 * de esas facturas. `discrepancias`: las ya guardadas de la unidad.
 *
 * ── El veredicto de cada factura ─────────────────────────────────────────
 * Lo da la siguiente de la cadena (`veredictoConciliacion`). Si el par no se
 * puede juzgar (alguna en revisión) o no hay siguiente, se conserva el que
 * ya tenía. Si la siguiente es una factura hecha a mano, no hay veredicto:
 * su saldo anterior no es de la contabilidad (`informaSaldoAnterior`).
 *
 * Una factura de antes de la Fase 3, sin veredicto ni evidencia
 * guardados, trae en `estado` lo que le puso la conciliación vieja: se
 * conserva como veredicto `heredado`, para no degradar en silencio lo que la
 * unidad ya veía. Si alguna vez tuvo evidencia (`estadoPago`), su estado
 * salió de ella y no se hereda: un pago reversado no deja la factura pagada.
 *
 * Es puro y determinista: el mismo cálculo lo aplica el modelo y lo simula
 * el re-procesamiento.
 */
export function calcularCadena(args: {
  cadena: readonly FacturaEstado[];
  pagos: readonly PagoRegistrado[];
  discrepancias: readonly DiscrepanciaGuardada[];
}): ResultadoCadena {
  const cadena = [...args.cadena].sort((a, b) => a.periodo.localeCompare(b.periodo));
  const pagosDe = new Map<string, PagoRegistrado[]>();
  for (const p of args.pagos) {
    const lista = pagosDe.get(p.facturaId);
    if (lista) lista.push(p);
    else pagosDe.set(p.facturaId, [p]);
  }

  const facturas = new Map<string, ResultadoFactura>();
  const evidencias = cadena.map((f) => evidenciaDePago(f, pagosDe.get(f._id) ?? []));

  // 1. Veredicto y estado de cada factura
  cadena.forEach((f, i) => {
    const siguiente = cadena[i + 1];
    const evidencia = evidencias[i] ?? null;
    let veredicto: VeredictoContable | null = null;
    const calculado = siguiente ? veredictoConciliacion(f, siguiente) : null;
    /* Una siguiente hecha a mano no dice nada de esta (QA de comprobantes,
     * H4): no la juzga, y el veredicto que una manual le haya puesto antes se
     * descarta. Solo se conserva un estado heredado de la migración, que no
     * salió de ella. Sin veredicto, mandan los pagos o el documento. */
    const siguienteManual = !!siguiente && !informaSaldoAnterior(siguiente);
    if (calculado !== null && siguiente) {
      veredicto = {
        estado: calculado,
        ...(calculado === "sin_veredicto" ? { motivo: "mes_faltante" as const } : {}),
        facturaSiguienteId: siguiente._id,
        saldoAnteriorSiguiente: saldoAnteriorDe(siguiente),
      };
    } else if (
      f.veredictoContable &&
      (!siguienteManual || f.veredictoContable.motivo === "heredado")
    ) {
      const { at: _at, ...guardado } = f.veredictoContable;
      veredicto = guardado;
    } else if (!f.veredictoContable && !evidencia && !f.estadoPago && DE_VEREDICTO.has(f.estado)) {
      veredicto = { estado: f.estado as Veredicto, motivo: "heredado" };
    }

    const estado = estadoDeFactura({
      carga: estadoCarga(f),
      evidencia,
      veredicto: veredicto?.estado ?? null,
    });

    /* Qué lo movió: la evidencia (un pago, un comprobante, un reverso), el
     * veredicto de la contabilidad, o el propio documento. */
    let causa: ResultadoFactura["causa"] = null;
    if (estado !== f.estado) {
      if ((evidencia?.estado ?? null) !== (f.estadoPago?.estado ?? null)) causa = "evidencia";
      else if (!igualVeredicto(f.veredictoContable, veredicto)) causa = "veredicto";
      else causa = "carga";
    }

    facturas.set(f._id, {
      estado,
      estadoPago: evidencia,
      veredicto,
      pagoEnVerificacion: null,
      causa,
    });
  });

  // 2. Discrepancias
  const discrepancias: OperacionDiscrepancia[] = [];
  const abiertas: { ref: string; monto: number }[] = [];
  const guardadas = new Map(
    args.discrepancias.map((d) => [`${d.facturaId}→${d.facturaSiguienteId}`, d]),
  );
  const tocadas = new Set<string>();

  cadena.forEach((f, i) => {
    const siguiente = cadena[i + 1];
    if (!siguiente) return;
    const clave = `${f._id}→${siguiente._id}`;
    const guardada = guardadas.get(clave);
    if (guardada) tocadas.add(guardada._id);
    const evidencia = evidencias[i] ?? null;
    const pagoIds = (pagosDe.get(f._id) ?? []).map((p) => p.id);

    /* Sin poder juzgar el par (revisión, mes faltante), lo guardado queda como está. */
    if (!parJuzgable(f, siguiente)) {
      if (guardada?.estado === "abierta") abiertas.push({ ref: guardada._id, monto: guardada.montoNoAplicado });
      return;
    }

    const calculo = discrepanciaDePar(evidencia, f, siguiente);
    if (!calculo) {
      if (guardada?.estado === "abierta") {
        discrepancias.push({
          tipo: "resolver",
          id: guardada._id,
          resolucion:
            (evidencia?.montoPagado ?? 0) < guardada.montoPagado - TOLERANCIA_PAGO
              ? "pago_reversado"
              : "documento_corregido",
          facturaId: siguiente._id,
        });
      }
      return;
    }

    /* ¿Un documento posterior ya lo muestra aplicado? */
    const posterior = cadena[i + 2];
    const pagadoSiguiente = evidencias[i + 1]?.montoPagado ?? 0;
    if (
      posterior &&
      aplicadoEnPosterior(calculo.montoNoAplicado, siguiente, pagadoSiguiente, posterior)
    ) {
      if (guardada?.estado === "abierta") {
        discrepancias.push({
          tipo: "resolver",
          id: guardada._id,
          resolucion: "aplicado_en_documento_posterior",
          facturaId: posterior._id,
        });
      }
      return;
    }

    if (!guardada) {
      const ref = `nueva:${f._id}`;
      discrepancias.push({
        tipo: "crear",
        ref,
        facturaId: f._id,
        facturaSiguienteId: siguiente._id,
        periodo: f.periodo,
        periodoSiguiente: siguiente.periodo,
        calculo,
        pagoIds,
      });
      abiertas.push({ ref, monto: calculo.montoNoAplicado });
      return;
    }

    if (guardada.estado === "abierta") {
      if (
        Math.abs(guardada.montoNoAplicado - calculo.montoNoAplicado) > TOLERANCIA_PAGO ||
        Math.abs(guardada.montoPagado - calculo.montoPagado) > TOLERANCIA_PAGO
      ) {
        discrepancias.push({ tipo: "actualizar", id: guardada._id, calculo, pagoIds });
      }
      abiertas.push({ ref: guardada._id, monto: calculo.montoNoAplicado });
      return;
    }

    /* Resuelta. La resolución de la administración se respeta mientras los
     * montos sean los mismos; una automática se reabre si la contradicción
     * volvió (otro documento, otro pago). */
    const mismosMontos =
      Math.abs(guardada.montoNoAplicado - calculo.montoNoAplicado) <= TOLERANCIA_PAGO &&
      Math.abs(guardada.montoPagado - calculo.montoPagado) <= TOLERANCIA_PAGO;
    if (guardada.resolucion?.tipo === "administracion" && mismosMontos) return;
    if (guardada.resolucion?.tipo === "aplicado_en_documento_posterior" && mismosMontos) return;
    discrepancias.push({ tipo: "reabrir", id: guardada._id, calculo, pagoIds });
    abiertas.push({ ref: guardada._id, monto: calculo.montoNoAplicado });
  });

  /* Las abiertas de pares que ya no existen en la cadena (no debería pasar:
   * las facturas no se borran) siguen abiertas: las revisa la administración. */
  for (const d of args.discrepancias) {
    if (d.estado === "abierta" && !tocadas.has(d._id)) abiertas.push({ ref: d._id, monto: d.montoNoAplicado });
  }

  // 3. La vigente lleva la marca
  if (abiertas.length > 0) {
    const vigente = facturaVigente(cadena);
    const ultimas = vigente
      ? [vigente]
      : cadena.filter((f) => f.periodo === cadena[cadena.length - 1]?.periodo);
    const marca = {
      monto: abiertas.reduce((s, a) => s + a.monto, 0),
      refs: abiertas.map((a) => a.ref),
    };
    for (const f of ultimas) {
      const r = facturas.get(f._id);
      if (r) r.pagoEnVerificacion = marca;
    }
  }

  return { facturas, discrepancias };
}
