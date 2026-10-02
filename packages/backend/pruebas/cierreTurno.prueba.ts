import { test } from "node:test";
import assert from "node:assert/strict";
import {
  erroresCierreTurno,
  validarCierreTurno,
  type EntradaCierreTurno,
} from "../convex/lib/cierreTurno.ts";

/** Un cierre completo y válido, sin novedades. Cada prueba rompe una cosa. */
const base: EntradaCierreTurno = {
  consignas: "Paquete del 402 en portería.",
  recibe: "Hernán Guarda",
  observacionesCierre:
    "Turno finalizado sin novedades adicionales. Se entrega puesto, documentación y elementos al guarda de relevo.",
  novedadesElementos: false,
  novedadesElementosDetalle: undefined,
  elementosAsignados: 4,
};

test("cierre sin novedades: pasa y no guarda detalle", () => {
  const r = validarCierreTurno(base);
  assert.equal(r.novedadesElementos, false);
  assert.equal(r.novedadesElementosDetalle, undefined);
  assert.equal(r.recibe, "Hernán Guarda");
  assert.deepEqual(erroresCierreTurno(base), {});
});

test("cierre con novedades: exige y guarda la descripción", () => {
  const r = validarCierreTurno({
    ...base,
    novedadesElementos: true,
    novedadesElementosDetalle:
      "  La linterna presenta daño en el interruptor y el radio tiene la batería descargada.  ",
  });
  assert.equal(r.novedadesElementos, true);
  assert.equal(
    r.novedadesElementosDetalle,
    "La linterna presenta daño en el interruptor y el radio tiene la batería descargada.",
  );
});

test("checkbox activado sin descripción: se rechaza", () => {
  for (const detalle of [undefined, null, "", "   \n\t "]) {
    const entrada = {
      ...base,
      novedadesElementos: true,
      novedadesElementosDetalle: detalle,
    };
    assert.ok(erroresCierreTurno(entrada).novedadesElementosDetalle);
    assert.throws(
      () => validarCierreTurno(entrada),
      /describe la novedad/i,
    );
  }
});

test("sin novedades, un detalle escrito y luego desmarcado no se guarda", () => {
  const r = validarCierreTurno({
    ...base,
    novedadesElementos: false,
    novedadesElementosDetalle: "Algo que se escribió y se desmarcó",
  });
  assert.equal(r.novedadesElementosDetalle, undefined);
});

test("no contestar la pregunta de novedades no equivale a 'no'", () => {
  for (const respuesta of [undefined, null]) {
    assert.throws(
      () => validarCierreTurno({ ...base, novedadesElementos: respuesta }),
      /indica si hay novedades/i,
    );
  }
});

test("no se reportan novedades de un turno sin elementos asignados", () => {
  assert.throws(
    () =>
      validarCierreTurno({
        ...base,
        elementosAsignados: 0,
        novedadesElementos: true,
        novedadesElementosDetalle: "Falta el radio",
      }),
    /no tiene elementos asignados/i,
  );
  // Sin novedades, un turno antiguo sin checklist se cierra igual.
  assert.doesNotThrow(() =>
    validarCierreTurno({ ...base, elementosAsignados: 0 }),
  );
});

test("observaciones generales vacías o de solo espacios: se aceptan y no se guardan", () => {
  for (const obs of [undefined, null, "", "    ", "\n\t"]) {
    const entrada = { ...base, observacionesCierre: obs };
    assert.equal(erroresCierreTurno(entrada).observacionesCierre, undefined);
    assert.equal(validarCierreTurno(entrada).observacionesCierre, undefined);
  }
});

test("relevo ausente o de solo espacios: se rechaza", () => {
  for (const recibe of [undefined, null, "", "   "]) {
    assert.throws(
      () => validarCierreTurno({ ...base, recibe }),
      /guarda que recibe/i,
    );
  }
});

test("consignas vacías: siguen siendo obligatorias", () => {
  assert.throws(
    () => validarCierreTurno({ ...base, consignas: "  " }),
    /consignas/i,
  );
});

test("recorta los textos que guarda", () => {
  const r = validarCierreTurno({
    ...base,
    consignas: "  Llaves del salón en el tablero  ",
    recibe: "  Hernán  ",
    observacionesCierre: "  Todo en orden  ",
  });
  assert.equal(r.consignas, "Llaves del salón en el tablero");
  assert.equal(r.recibe, "Hernán");
  assert.equal(r.observacionesCierre, "Todo en orden");
});

test("reporta todos los campos que faltan, y lanza el primero del formulario", () => {
  const vacio: EntradaCierreTurno = {
    consignas: "",
    recibe: "",
    observacionesCierre: "",
    novedadesElementos: true,
    novedadesElementosDetalle: "",
    elementosAsignados: 2,
  };
  assert.deepEqual(Object.keys(erroresCierreTurno(vacio)).sort(), [
    "consignas",
    "novedadesElementosDetalle",
    "recibe",
  ]);
  assert.throws(() => validarCierreTurno(vacio), /describe la novedad/i);
});
