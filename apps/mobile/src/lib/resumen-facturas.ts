import {
  ETIQUETA_SIN_VERIFICAR,
  TEXTO_SIN_VERIFICAR,
  abonoAprobado,
  descuentoVigente,
  enRevision,
  estadoVisibleDeFactura,
  fechaLimiteDescuentoDe,
  inicioDeMora,
  montoAPagarHoy,
  montoSinDescuento,
  resumenResidente,
  type CarteraUnidad,
  type EvidenciaGuardada,
  type FacturaCartera,
  type LecturaDudosa,
} from "@vekino/backend/cartera";

/**
 * LA TARJETA DE FACTURAS DEL RESIDENTE EN EL MÓVIL (inicio y pestaña Facturas).
 *
 * Nada de aquí decide quién debe ni qué se paga: lo dice `resumenResidente`
 * (`packages/backend/convex/lib/cartera.ts`), la misma regla de la cartera de
 * la administración, de la web y del backend de pagos. Por unidad, la deuda es
 * su factura VIGENTE —la del período más reciente—, que ya absorbe a las
 * anteriores. Aquí solo se traduce a lo que muestra la tarjeta.
 *
 * Antes cada pantalla contaba y sumaba las facturas `pendiente` de todo el
 * historial: con dos de la misma casa duplicaba la deuda (`totalAPagar` es
 * acumulado), y una vigente que venció sin pagarse se veía "pendiente".
 *
 * Fase 3: lo "por pagar" es lo que se cobra HOY (con descuento solo dentro de
 * su plazo, `montoAPagarHoy`), y un pago registrado que la contabilidad aún
 * no refleja se ve "Pago en verificación", no como deuda.
 */
type FacturaTarjeta = FacturaCartera & {
  unidadId: string;
  totalConDescuento?: number;
  fechaLimiteDescuento?: number;
};

export function tarjetaFacturas<F extends FacturaTarjeta>(
  facturas: readonly F[],
  ahora: number,
) {
  const { estado, pagables, unidades } = resumenResidente(facturas, ahora);
  const alDia = estado === "al_dia" || estado === "sin_facturas";
  const enMora = estado === "en_mora";
  const enVerificacion = unidades.reduce(
    (s, u) =>
      s + (u.cartera.motivoRevision === "pago_en_verificacion" ? (u.cartera.montoEnVerificacion ?? 0) : 0),
    0,
  );
  return {
    titulo: alDia
      ? "Estás al día"
      : pagables.length === 0
        ? enVerificacion > 0
          ? "Pago en verificación"
          : "Factura en revisión"
        : enMora
          ? "Tienes un saldo vencido"
          : pagables.length === 1
            ? "1 factura pendiente"
            : `${pagables.length} facturas pendientes`,
    /** Lo que se debe hoy: la vigente de cada unidad, nunca el historial (sin lo ya abonado). */
    porPagar: pagables.reduce((s, f) => s + montoAPagarHoy(f, ahora), 0),
    /** Pagado y todavía no reflejado por la contabilidad. */
    enVerificacion,
    alDia,
    enMora,
    /** A lo sumo una por unidad. */
    pagables,
    /** La cartera de hoy de cada unidad, por id: con ella se rotula cada factura (`estadoVisible`). */
    carteras: new Map<string, CarteraUnidad>(unidades.map((u) => [u.unidadId, u.cartera])),
  };
}

/**
 * El estado que se le muestra al residente en la lista y en el detalle. Una
 * factura cuya lectura la administración todavía no verificó se ve "en
 * revisión", diga lo que diga el estado guardado: no se paga hasta que la
 * confirmen (Fase 2, docs/audits/FASE-2-FACTURACION.md). Una con un pago en
 * verificación se ve así (Fase 3): pagó y la contabilidad aún no lo refleja.
 *
 * Fase 4: con `cadena` (las facturas de la misma unidad), una histórica que
 * quedó `pendiente` se ve "sin verificar" —falta el estado de cuenta
 * siguiente para saber si se pagó—. La regla es la del backend
 * (`estadoVisibleDeFactura`); si la fila ya trae `estadoVisible` (la lista de
 * la administración), manda ese.
 *
 * Con `cartera` (la de su unidad, `tarjetaFacturas(...).carteras`), la vigente
 * de una unidad en mora se ve "vencida", como dice la tarjeta ("Tienes un
 * saldo vencido") y como la ven la web y la administración (QA de
 * comprobantes, H2).
 */
export function estadoVisible(
  f: {
    periodo?: string;
    estado: string;
    lecturaDudosa?: LecturaDudosa | null;
    pagoEnVerificacion?: { monto: number } | null;
    estadoVisible?: string;
  },
  cadena?: readonly { periodo: string }[],
  cartera?: Pick<CarteraUnidad, "estado"> | null,
): string {
  if (f.estadoVisible) return f.estadoVisible;
  if (cadena && f.periodo) return estadoVisibleDeFactura({ ...f, periodo: f.periodo }, cadena, cartera);
  if (enRevision(f)) return "en_revision";
  if (f.pagoEnVerificacion) return "en_verificacion";
  return f.estado;
}

/**
 * El monto de la fila de una factura: el de su documento, salvo en la VIGENTE
 * con un abono aprobado, que muestra lo que falta (QA de comprobantes, H1).
 * En una histórica lo que faltó ya va en la siguiente: se deja su total. Sin
 * `cadena` no se sabe si es la vigente, y se deja el total.
 */
export function montoDeFila(
  f: { periodo: string; totalAPagar: number; estadoPago?: EvidenciaGuardada | null },
  cadena?: readonly { periodo: string }[],
): number {
  if (!cadena) return f.totalAPagar;
  const esVigente = !cadena.some((x) => x.periodo > f.periodo);
  return esVigente && abonoAprobado(f) > 0 ? montoSinDescuento(f) : f.totalAPagar;
}

/**
 * Los plazos de una factura para mostrarlos (Fase 4, decisión B): hasta
 * cuándo se paga el precio completo (`fechaVencimiento`) y desde cuándo
 * cuenta como mora (el 16 del mes siguiente). `null` si no tiene fecha.
 */
export function plazosDe(f: {
  periodo: string;
  fechaVencimiento: number;
}): { precioCompletoHasta: number; moraDesde: number } | null {
  if (!(f.fechaVencimiento > 0)) return null;
  return { precioCompletoHasta: f.fechaVencimiento, moraDesde: inicioDeMora(f) };
}

export { ETIQUETA_SIN_VERIFICAR, TEXTO_SIN_VERIFICAR };

/**
 * El descuento por pronto pago de una factura, para mostrarlo: hasta cuándo
 * vale (la fecha del documento, o el 15 del mes del período) y si hoy
 * todavía vale. `null` si no tiene.
 */
export function descuentoDe(
  f: { periodo: string; totalAPagar: number; totalConDescuento?: number; fechaLimiteDescuento?: number },
  ahora: number,
): { monto: number; hasta: number; vigente: boolean } | null {
  const hasta = fechaLimiteDescuentoDe(f);
  if (hasta === null || typeof f.totalConDescuento !== "number" || f.totalConDescuento >= f.totalAPagar) {
    return null;
  }
  return { monto: f.totalConDescuento, hasta, vigente: descuentoVigente(f, ahora) };
}
