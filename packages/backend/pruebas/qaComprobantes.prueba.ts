import { test } from "node:test";
import assert from "node:assert/strict";
import {
  abonoAprobado,
  carteraDeUnidad,
  estadoVisibleDeFactura,
  estadosVisiblesDeUnidad,
  informaSaldoAnterior,
  montoAPagarHoy,
  montoSinDescuento,
  veredictoConciliacion,
  type EvidenciaGuardada,
  type FacturaCartera,
  type LineaFactura,
} from "../convex/lib/cartera.ts";
import {
  calcularCadena,
  evidenciaDePago,
  parJuzgable,
  type FacturaEstado,
  type PagoRegistrado,
} from "../convex/lib/estadoFactura.ts";
import { recaudoContablePorPeriodo } from "../convex/lib/recaudo.ts";

/**
 * LAS REGLAS PURAS DETRÁS DE LOS HALLAZGOS DEL QA DE COMPROBANTES
 * (docs/qa/QA-FACTORY-COMPROBANTES.md):
 *
 *   · H1: lo que se cobra hoy descuenta lo ya abonado, con la misma regla que
 *     decide si la factura quedó pagada (`evidenciaDePago`);
 *   · H2: la vigente de una unidad en mora se MUESTRA vencida;
 *   · H4: una factura hecha a mano no juzga a la anterior ni prueba recaudo.
 *
 * Las pruebas de punta a punta (convex-test) están en `pruebas/facturacion/`
 * (`abonoAprobado`, `moraVisible`, `facturaManual`) y `vinculoVencido`.
 */

const bogota = (local: string) => Date.parse(`${local}:00-05:00`);
const DIA = 24 * 60 * 60 * 1000;

function linea(saldoAnterior: number, actual: number): LineaFactura {
  return { codigo: 1, concepto: "CUOTA", saldoAnterior, actual, total: saldoAnterior + actual };
}

/** Septiembre de Factory: $335.000, con descuento $295.000 hasta el 15 de septiembre. */
const SEPT = { periodo: "2026-09", totalAPagar: 335_000, totalConDescuento: 295_000 };
const abonada = (montoPagado: number): EvidenciaGuardada => ({ estado: "abonada", montoPagado });

// ─── H1 · lo que se cobra hoy ────────────────────────────────────────────────

test("H1 · sin pagos aprobados se cobra lo de siempre (con descuento solo en su plazo)", () => {
  assert.equal(montoAPagarHoy(SEPT, bogota("2026-09-10T10:00")), 295_000);
  assert.equal(montoAPagarHoy(SEPT, bogota("2026-10-09T10:00")), 335_000);
  assert.equal(montoAPagarHoy({ ...SEPT, estadoPago: null }, bogota("2026-10-09T10:00")), 335_000);
  assert.equal(abonoAprobado({}), 0);
});

test("H1 · el caso del QA: abono aprobado de $200.000 sobre $335.000 → se cobran $135.000", () => {
  const f = { ...SEPT, estadoPago: abonada(200_000) };
  assert.equal(abonoAprobado(f), 200_000);
  assert.equal(montoAPagarHoy(f, bogota("2026-10-09T10:00")), 135_000);
  assert.equal(montoSinDescuento(f), 135_000);
});

test("H1 · con el descuento vigente falta el total con descuento menos lo abonado", () => {
  const f = { ...SEPT, estadoPago: abonada(200_000) };
  assert.equal(montoAPagarHoy(f, bogota("2026-09-10T10:00")), 95_000);
  /* "Después" es el total menos lo abonado, no el total del documento. */
  assert.equal(montoSinDescuento(f), 135_000);
});

test("H1 · pagada por sus pagos: no se cobra nada, ni siquiera la diferencia del descuento", () => {
  /* Pagó $295.000 a tiempo: pagada con descuento. El total sin descuento
   * menos lo pagado ($40.000) NO se debe. */
  const f = { ...SEPT, estadoPago: { estado: "pagada" as const, montoPagado: 295_000 } };
  assert.equal(montoAPagarHoy(f, bogota("2026-10-09T10:00")), 0);
  assert.equal(montoSinDescuento(f), 0);
  assert.equal(abonoAprobado(f), 0);
});

test("H1 · nunca negativo, aunque lo abonado supere lo de hoy", () => {
  /* Un estado que la regla no produce (lo abonado ya supera el valor con
   * descuento que vale hoy), a propósito: aun así el cobro no baja de cero. */
  const f = { periodo: "2026-09", totalAPagar: 335_000, totalConDescuento: 250_000, estadoPago: abonada(300_000) };
  assert.equal(montoAPagarHoy(f, bogota("2026-09-10T10:00")), 0);
  assert.equal(montoAPagarHoy(f, bogota("2026-10-09T10:00")), 35_000);
});

/**
 * La prueba de fondo: `montoAPagarHoy` y `evidenciaDePago` son la misma regla.
 * Para cientos de facturas y pagos al azar (determinista), pagar hoy lo que
 * dice `montoAPagarHoy` deja la factura PAGADA, y pagar $2 menos la deja
 * abonada. Si un día dejan de coincidir, esta prueba lo dice.
 */
test("H1 · propiedad: pagar hoy `montoAPagarHoy` salda la factura según `evidenciaDePago`; $2 menos no", () => {
  let semilla = 20261009;
  const azar = () => {
    semilla = (semilla * 1103515245 + 12345) % 2 ** 31;
    return semilla / 2 ** 31;
  };
  let casos = 0;
  for (let i = 0; i < 400; i++) {
    const total = 100_000 + Math.round(azar() * 900) * 1_000;
    const conDescuento = azar() < 0.7;
    const factura = {
      periodo: "2026-09",
      totalAPagar: total,
      ...(conDescuento ? { totalConDescuento: total - 40_000 } : {}),
    };
    /* Hoy: dentro o fuera del plazo del descuento (15 de septiembre). */
    const ahora = azar() < 0.5 ? bogota("2026-09-12T10:00") : bogota("2026-10-09T10:00");
    /* Pagos aprobados anteriores a hoy, de cualquier monto. */
    const pagos: PagoRegistrado[] = [];
    const n = Math.floor(azar() * 3);
    for (let k = 0; k < n; k++) {
      const fecha = ahora - Math.floor(azar() * 20) * DIA;
      pagos.push({ id: `p${i}-${k}`, facturaId: "f", origen: "comprobante", monto: 1_000 + Math.round(azar() * 150) * 1_000, fecha });
    }
    const evidencia = evidenciaDePago(factura, pagos);
    if (evidencia?.estado === "pagada") continue;
    const cobrar = montoAPagarHoy({ ...factura, estadoPago: evidencia }, ahora);
    assert.ok(cobrar > 0, `caso ${i}: sin pagar y nada que cobrar`);
    const conElPago = evidenciaDePago(factura, [...pagos, { id: "hoy", facturaId: "f", origen: "pasarela", monto: cobrar, fecha: ahora }]);
    assert.equal(conElPago?.estado, "pagada", `caso ${i}: pagar ${cobrar} no la saldó`);
    if (cobrar > 2) {
      const corto = evidenciaDePago(factura, [...pagos, { id: "hoy", facturaId: "f", origen: "pasarela", monto: cobrar - 2, fecha: ahora }]);
      assert.equal(corto?.estado, "abonada", `caso ${i}: ${cobrar - 2} ya la saldaba: se cobraba de más`);
    }
    casos++;
  }
  assert.ok(casos > 200, `muy pocos casos sin saldar (${casos})`);
});

// ─── H1 · la deuda de la unidad ─────────────────────────────────────────────

function cartera(periodo: string, extra: Partial<FacturaCartera> = {}): FacturaCartera {
  const [a, m] = periodo.split("-").map(Number) as [number, number];
  return {
    periodo,
    estado: "pendiente",
    fechaVencimiento: Date.UTC(a, m, 0, 5),
    totalAPagar: 335_000,
    lineas: [linea(0, 335_000)],
    ...extra,
  };
}

test("H1 · el saldo de la unidad descuenta el abono aprobado de la vigente", () => {
  const c = carteraDeUnidad(
    [cartera("2026-09", { estado: "abonada", estadoPago: abonada(200_000) })],
    bogota("2026-10-09T10:00"),
  );
  assert.equal(c.saldoActual, 135_000);
  assert.equal(c.estado, "pendiente");
});

test("H1 · una abonada sin el monto de sus abonos (estado heredado) sigue reportando el total", () => {
  const c = carteraDeUnidad([cartera("2026-09", { estado: "abonada" })], bogota("2026-10-09T10:00"));
  assert.equal(c.saldoActual, 335_000);
});

// ─── H2 · lo que se muestra con la mora de la unidad ────────────────────────

test("H2 · la vigente pendiente de una unidad en mora se muestra 'vencida'", () => {
  const cadena = [cartera("2026-08")];
  const ahora = bogota("2026-10-09T10:00");
  const c = carteraDeUnidad(cadena, ahora);
  assert.equal(c.estado, "en_mora");
  assert.equal(estadoVisibleDeFactura(cadena[0]!, cadena, c), "vencida");
  /* Sin la cartera no se juzga la mora: las llamadas de antes no cambian. */
  assert.equal(estadoVisibleDeFactura(cadena[0]!, cadena), "pendiente");
});

test("H2 · dentro del plazo, pagada después del vencimiento o sin saldo: no se pinta vencida", () => {
  const ahora = bogota("2026-10-09T10:00");
  const visible = (cadena: (FacturaCartera & { _id: string })[]) =>
    estadosVisiblesDeUnidad(cadena, ahora).get(cadena[cadena.length - 1]!._id);
  /* Septiembre: mora desde el 16 de octubre. */
  assert.equal(visible([{ ...cartera("2026-08", { estado: "pagada" }), _id: "a" }, { ...cartera("2026-09"), _id: "s" }]), "pendiente");
  /* Agosto pagado el 1 de octubre. */
  assert.equal(visible([{ ...cartera("2026-08", { estado: "pagada", estadoPago: { estado: "pagada", montoPagado: 335_000 } }), _id: "a" }]), "pagada");
  /* Total en cero. */
  assert.equal(visible([{ ...cartera("2026-08", { totalAPagar: 0, lineas: [linea(0, 0)] }), _id: "a" }]), "pendiente");
  /* Abonada: la regla de la cartera la da por cubierta. */
  assert.equal(visible([{ ...cartera("2026-08", { estado: "abonada", estadoPago: abonada(200_000) }), _id: "a" }]), "abonada");
});

test("H2 · una histórica pendiente sigue 'Sin verificar', aunque la unidad esté en mora", () => {
  const ahora = bogota("2026-10-20T10:00");
  const cadena = [
    { ...cartera("2026-08"), _id: "a" },
    { ...cartera("2026-09", { totalAPagar: 670_000, lineas: [linea(335_000, 335_000)] }), _id: "s" },
  ];
  const visibles = estadosVisiblesDeUnidad(cadena, ahora);
  assert.equal(visibles.get("a"), "sin_verificar");
  assert.equal(visibles.get("s"), "vencida");
});

// ─── H4 · una factura hecha a mano no juzga a la anterior ───────────────────

test("H4 · el saldo anterior de una manual no es de la contabilidad", () => {
  assert.equal(informaSaldoAnterior({ origen: "manual" }), false);
  for (const origen of ["pdf", "migracion", "script", undefined, null]) {
    assert.equal(informaSaldoAnterior({ origen }), true);
  }
  const agosto = { periodo: "2026-08", totalAPagar: 335_000 };
  const septiembre = { periodo: "2026-09", lineas: [linea(0, 670_000)] };
  assert.equal(veredictoConciliacion(agosto, { ...septiembre, origen: "manual" }), null);
  /* El mismo documento, de la contabilidad: sí dice que agosto quedó pagada. */
  assert.equal(veredictoConciliacion(agosto, { ...septiembre, origen: "pdf" }), "pagada");
  assert.equal(parJuzgable(agosto, { ...septiembre, origen: "manual" }), false);
});

function fe(_id: string, periodo: string, lineas: LineaFactura[], extra: Partial<FacturaEstado> = {}): FacturaEstado {
  return { _id, periodo, estado: "pendiente", totalAPagar: lineas.reduce((s, l) => s + l.total, 0), saldoAFavor: 0, lineas, ...extra };
}

test("H4 · conciliación: con la siguiente manual, la anterior queda como la dejan sus pagos o su documento", () => {
  const r = calcularCadena({
    cadena: [fe("ago", "2026-08", [linea(0, 335_000)], { origen: "manual" }), fe("sep", "2026-09", [linea(0, 670_000)], { origen: "manual" })],
    pagos: [],
    discrepancias: [],
  });
  assert.deepEqual(r.facturas.get("ago"), { estado: "pendiente", estadoPago: null, veredicto: null, pagoEnVerificacion: null, causa: null });
});

test("H4 · el veredicto que una manual puso antes se descarta; uno heredado de la migración se conserva", () => {
  const sep = fe("sep", "2026-09", [linea(0, 670_000)], { origen: "manual" });
  const mal = calcularCadena({
    cadena: [
      fe("ago", "2026-08", [linea(0, 335_000)], {
        estado: "pagada",
        veredictoContable: { estado: "pagada", facturaSiguienteId: "sep", saldoAnteriorSiguiente: 0 },
      }),
      sep,
    ],
    pagos: [],
    discrepancias: [],
  });
  assert.equal(mal.facturas.get("ago")?.estado, "pendiente");
  assert.equal(mal.facturas.get("ago")?.veredicto, null);
  assert.equal(mal.facturas.get("ago")?.causa, "veredicto");

  const heredada = calcularCadena({
    cadena: [fe("ago", "2026-08", [linea(0, 335_000)], { estado: "pagada", veredictoContable: { estado: "pagada", motivo: "heredado" } }), sep],
    pagos: [],
    discrepancias: [],
  });
  assert.equal(heredada.facturas.get("ago")?.estado, "pagada");
});

test("H4 · un pago real de la anterior sigue contando, y la manual no abre discrepancias", () => {
  const pago: PagoRegistrado = { id: "c1", facturaId: "ago", origen: "comprobante", monto: 200_000, fecha: bogota("2026-09-05T12:00") };
  const r = calcularCadena({
    cadena: [fe("ago", "2026-08", [linea(0, 335_000)]), fe("sep", "2026-09", [linea(500_000, 335_000)], { origen: "manual" })],
    pagos: [pago],
    discrepancias: [],
  });
  assert.equal(r.facturas.get("ago")?.estado, "abonada");
  assert.deepEqual(r.discrepancias, []);
});

test("H4 · recaudo de la contabilidad: no se calcula contra una manual, y se dice por qué", () => {
  const fr = (_id: string, periodo: string, total: number, anterior = 0, origen?: string) => ({
    _id,
    unidadId: "U",
    periodo,
    totalAPagar: total,
    lineas: [linea(anterior, total - anterior)],
    ...(origen ? { origen } : {}),
  });
  const conManual = recaudoContablePorPeriodo([fr("a8", "2026-08", 335_000, 0, "manual"), fr("a9", "2026-09", 670_000, 0, "manual")]);
  assert.deepEqual(conManual.get("2026-08"), {
    monto: null,
    unidades: 0,
    sinSiguiente: 0,
    mesFaltante: 0,
    enRevision: 0,
    noCuadra: 0,
    siguienteManual: 1,
  });
  /* La anterior manual con la siguiente de la contabilidad: sí se calcula. */
  const conPdf = recaudoContablePorPeriodo([fr("a8", "2026-08", 335_000, 0, "manual"), fr("a9", "2026-09", 335_000, 0, "pdf")]);
  assert.equal(conPdf.get("2026-08")?.monto, 335_000);
});
