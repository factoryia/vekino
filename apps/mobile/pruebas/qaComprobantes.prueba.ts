import { test } from "node:test";
import assert from "node:assert/strict";
import { estadoVisible, montoDeFila, tarjetaFacturas } from "../src/lib/resumen-facturas.ts";

/**
 * LAS FACTURAS EN EL MÓVIL — hallazgos del QA de comprobantes
 * (docs/qa/QA-FACTORY-COMPROBANTES.md), con la misma regla de la web:
 *
 *   · H1: un abono aprobado baja lo que se cobra y lo que muestra la vigente;
 *   · H2: la vigente de una unidad en mora se ve "vencida", como dice la
 *     tarjeta ("Tienes un saldo vencido").
 */

const bogota = (local: string) => Date.parse(`${local}:00-05:00`);
const finDeMes = (periodo: string) => {
  const [a, m] = periodo.split("-").map(Number) as [number, number];
  return Date.UTC(a, m, 0, 5);
};

function factura(periodo: string, estado: string, totalAPagar: number, extra: Record<string, unknown> = {}) {
  return {
    _id: `f-${periodo}`,
    unidadId: "u103",
    periodo,
    estado: estado as "pendiente",
    fechaVencimiento: finDeMes(periodo),
    totalAPagar,
    lineas: [],
    ...extra,
  };
}

const HOY = bogota("2026-10-09T10:00");

test("H1 · el caso del QA: $335.000 con $200.000 abonados → la tarjeta y la fila dicen $135.000", () => {
  const agosto = factura("2026-08", "abonada", 335_000, {
    estadoPago: { estado: "abonada" as const, montoPagado: 200_000 },
  });
  const t = tarjetaFacturas([agosto], HOY);
  assert.equal(t.porPagar, 135_000);
  assert.equal(montoDeFila(agosto, [agosto]), 135_000);
  /* Sin la cadena no se sabe si es la vigente: el total del documento. */
  assert.equal(montoDeFila(agosto), 335_000);
});

test("H1 · una histórica abonada muestra su total: lo que faltó ya va en la siguiente", () => {
  const agosto = factura("2026-08", "abonada", 335_000, {
    estadoPago: { estado: "abonada" as const, montoPagado: 200_000 },
  });
  const septiembre = factura("2026-09", "pendiente", 470_000);
  assert.equal(montoDeFila(agosto, [agosto, septiembre]), 335_000);
  assert.equal(montoDeFila(septiembre, [agosto, septiembre]), 470_000);
});

test("H2 · la vigente sin pagar con la unidad en mora se ve 'vencida'; dentro del plazo, 'pendiente'", () => {
  const cadena = [factura("2026-08", "pendiente", 335_000)];
  const enMora = tarjetaFacturas(cadena, HOY);
  assert.equal(enMora.enMora, true);
  assert.equal(estadoVisible(cadena[0]!, cadena, enMora.carteras.get("u103")), "vencida");

  const aTiempo = tarjetaFacturas(cadena, bogota("2026-09-10T10:00"));
  assert.equal(aTiempo.enMora, false);
  assert.equal(estadoVisible(cadena[0]!, cadena, aTiempo.carteras.get("u103")), "pendiente");

  /* Sin la cartera, como antes: no se juzga la mora. */
  assert.equal(estadoVisible(cadena[0]!, cadena), "pendiente");
});
