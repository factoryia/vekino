import {
  enRevision,
  informaSaldoAnterior,
  periodoSiguiente,
  saldoAnteriorDe,
  type LecturaDudosa,
  type LineaFactura,
} from "./cartera.ts";

/**
 * Las dos cifras de recaudo de un periodo (Fase 4, F-19), por separado.
 *
 * Antes "recaudo" era la suma del `totalAPagar` de las facturas `pagada`: la
 * deuda acumulada de quien termino pagando (arrastre incluido) y nada de los
 * abonos. No era ni lo que entro al banco ni lo que dice la contabilidad.
 *
 * 1. **Recaudo segun la contabilidad.** Por unidad y por dos meses SEGUIDOS:
 *    lo que la factura N cobraba (`totalAPagar`) menos lo que la factura N+1
 *    dice que quedo debiendo (su saldo anterior: el de la fila Totales si lo
 *    trae, `saldoAnteriorDe`). Es lo que la contabilidad dio por cancelado de
 *    N entre los dos cortes, con creditos y notas: un saldo anterior negativo
 *    (saldo a favor) cuenta como pagado de mas. Incluye lo que se pago por el
 *    banco, el portal o en efectivo, y los descuentos que la contabilidad
 *    reconocio.
 *    - Sin la factura N+1 no se calcula: `sinSiguiente` si el conjunto
 *      todavia no tiene ese mes cargado (es el ultimo), `mesFaltante` si el
 *      conjunto lo tiene y la unidad no (un hueco, F-09).
 *    - Con una lectura en revision (N o N+1) tampoco: `enRevision`.
 *    - Ni con una factura cuyas lineas no suman su total (`noCuadra`): son
 *      las cargadas antes de la Fase 2, que no llevan la marca de revision
 *      pero tienen la misma falla (en agosto de 2026 de Ciudad del Campo, 44:
 *      totales en $0 o sin las hojas de continuacion). Con ellas la cuenta da
 *      cualquier cosa —hasta un recaudo negativo—.
 *    - Ni si N+1 es una factura hecha a mano (`siguienteManual`): su saldo
 *      anterior no es de la contabilidad (`informaSaldoAnterior`), y leerlo
 *      como $0 contaba como recaudada una cuota que nadie pago (QA de
 *      comprobantes, H4).
 *    No se rellena ni se estima: se informa cuantas unidades quedaron fuera.
 *
 * 2. **Recaudo registrado en Vekino.** Los pagos de la pasarela aprobados y
 *    los comprobantes aprobados, con su monto, de las facturas del periodo.
 *    Es lo que Vekino VIO pagar; hoy casi todo el recaudo es por fuera
 *    (auditoria F-05), asi que esta cifra es mucho menor que la primera.
 *
 * Sin dependencias: se prueba con `node`.
 */

export type FacturaRecaudo = {
  _id: string;
  unidadId: string;
  periodo: string;
  totalAPagar: number;
  lineas: readonly LineaFactura[];
  saldoAnteriorDocumento?: number;
  lecturaDudosa?: LecturaDudosa | null;
  origen?: string | null;
};

export type RecaudoContable = {
  /** Suma de lo calculable; `null` si ninguna unidad se pudo calcular. */
  monto: number | null;
  /** Unidades con el par N, N+1 completo. */
  unidades: number;
  /** El conjunto todavia no tiene el mes siguiente: el periodo es el ultimo. */
  sinSiguiente: number;
  /** El conjunto tiene el mes siguiente y la unidad no. */
  mesFaltante: number;
  /** N o N+1 tienen la lectura en revision. */
  enRevision: number;
  /** N o N+1 tienen lineas que no suman su total (cargas anteriores a la Fase 2). */
  noCuadra: number;
  /** N+1 es una factura hecha a mano: no trae el saldo anterior de la contabilidad. */
  siguienteManual: number;
};

const vacio = (): RecaudoContable => ({
  monto: null,
  unidades: 0,
  sinSiguiente: 0,
  mesFaltante: 0,
  enRevision: 0,
  noCuadra: 0,
  siguienteManual: 0,
});

/** Si las lineas de la factura suman su total (±$1, la tolerancia del cuadre). */
function cuadra(f: FacturaRecaudo): boolean {
  if (f.lineas.length === 0) return false;
  return Math.abs(f.lineas.reduce((s, l) => s + l.total, 0) - f.totalAPagar) <= 1;
}

/** El recaudo segun la contabilidad, por periodo N. */
export function recaudoContablePorPeriodo(
  facturas: readonly FacturaRecaudo[],
): Map<string, RecaudoContable> {
  const porUnidadPeriodo = new Map<string, FacturaRecaudo>();
  const periodosDelConjunto = new Set<string>();
  for (const f of facturas) {
    porUnidadPeriodo.set(`${f.unidadId}|${f.periodo}`, f);
    periodosDelConjunto.add(f.periodo);
  }
  const salida = new Map<string, RecaudoContable>();
  for (const f of facturas) {
    const r = salida.get(f.periodo) ?? vacio();
    salida.set(f.periodo, r);
    const sig = periodoSiguiente(f.periodo);
    const siguiente = porUnidadPeriodo.get(`${f.unidadId}|${sig}`);
    if (!siguiente) {
      if (periodosDelConjunto.has(sig)) r.mesFaltante++;
      else r.sinSiguiente++;
      continue;
    }
    if (!informaSaldoAnterior(siguiente)) {
      r.siguienteManual++;
      continue;
    }
    if (enRevision(f) || enRevision(siguiente)) {
      r.enRevision++;
      continue;
    }
    if (!cuadra(f) || !cuadra(siguiente)) {
      r.noCuadra++;
      continue;
    }
    r.monto = (r.monto ?? 0) + (f.totalAPagar - saldoAnteriorDe(siguiente));
    r.unidades++;
  }
  return salida;
}

export type PagoRecaudo = { facturaId: string; monto: number; estado: string };
export type ComprobanteRecaudo = { facturaId?: string; monto?: number; estado: string };

export type RecaudoVekino = {
  monto: number;
  /** Pagos de la pasarela aprobados (no reversados). */
  pagos: number;
  /** Comprobantes aprobados con monto. */
  comprobantes: number;
  /** Comprobantes aprobados sin monto (anteriores a la Fase 3): no se suman. */
  comprobantesSinMonto: number;
};

/** El recaudo registrado en Vekino, por periodo de la factura pagada. */
export function recaudoVekinoPorPeriodo(
  periodoDeFactura: ReadonlyMap<string, string>,
  pagos: readonly PagoRecaudo[],
  comprobantes: readonly ComprobanteRecaudo[],
): Map<string, RecaudoVekino> {
  const salida = new Map<string, RecaudoVekino>();
  const de = (periodo: string) => {
    const r = salida.get(periodo) ?? { monto: 0, pagos: 0, comprobantes: 0, comprobantesSinMonto: 0 };
    salida.set(periodo, r);
    return r;
  };
  for (const p of pagos) {
    if (p.estado !== "aprobada") continue;
    const periodo = periodoDeFactura.get(p.facturaId);
    if (!periodo) continue;
    const r = de(periodo);
    r.monto += p.monto;
    r.pagos++;
  }
  for (const c of comprobantes) {
    if (c.estado !== "aprobado" || !c.facturaId) continue;
    const periodo = periodoDeFactura.get(c.facturaId);
    if (!periodo) continue;
    const r = de(periodo);
    if (typeof c.monto === "number") {
      r.monto += c.monto;
      r.comprobantes++;
    } else {
      r.comprobantesSinMonto++;
    }
  }
  return salida;
}
