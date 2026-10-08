import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CAMPOS_PEDIDOS_CIERRE,
  CIERRE_COMPLETO,
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
    // Cuando se pide, se exige.
    assert.throws(
      () =>
        validarCierreTurno(
          { ...base, novedadesElementos: respuesta },
          CIERRE_COMPLETO,
        ),
      /indica si hay novedades/i,
    );
    // Cuando no se pide, queda sin contestar: ni "sí" ni "no".
    assert.equal(
      validarCierreTurno({ ...base, novedadesElementos: respuesta })
        .novedadesElementos,
      undefined,
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

test("cierre completo: observaciones generales vacías o de solo espacios se rechazan", () => {
  for (const obs of [undefined, null, "", "    ", "\n\t"]) {
    const entrada = { ...base, observacionesCierre: obs };
    assert.ok(erroresCierreTurno(entrada, CIERRE_COMPLETO).observacionesCierre);
    assert.throws(
      () => validarCierreTurno(entrada, CIERRE_COMPLETO),
      /observaciones generales/i,
    );
  }
});

test("cierre completo: relevo ausente o de solo espacios se rechaza", () => {
  for (const recibe of [undefined, null, "", "   "]) {
    assert.throws(
      () => validarCierreTurno({ ...base, recibe }, CIERRE_COMPLETO),
      /guarda que recibe/i,
    );
  }
});

test("cierre completo: consignas vacías se rechazan", () => {
  assert.throws(
    () => validarCierreTurno({ ...base, consignas: "  " }, CIERRE_COMPLETO),
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

test("cierre completo: reporta todos los campos que faltan, y lanza el primero del formulario", () => {
  const vacio: EntradaCierreTurno = {
    consignas: "",
    recibe: "",
    observacionesCierre: "",
    novedadesElementos: true,
    novedadesElementosDetalle: "",
    elementosAsignados: 2,
  };
  assert.deepEqual(Object.keys(erroresCierreTurno(vacio, CIERRE_COMPLETO)).sort(), [
    "consignas",
    "novedadesElementosDetalle",
    "observacionesCierre",
    "recibe",
  ]);
  assert.throws(
    () => validarCierreTurno(vacio, CIERRE_COMPLETO),
    /describe la novedad/i,
  );
});

// ── El cierre simplificado: lo que hoy pide el formulario ──────────────

/** Lo que manda hoy el formulario: nada más que el turno. */
const simplificado: EntradaCierreTurno = {
  consignas: undefined,
  recibe: undefined,
  observacionesCierre: undefined,
  novedadesElementos: undefined,
  novedadesElementosDetalle: undefined,
  elementosAsignados: 4,
};

test("hoy el cierre no pide ninguno de los campos ocultos", () => {
  assert.deepEqual(CAMPOS_PEDIDOS_CIERRE, {
    elementos: false,
    recibe: false,
    consignas: false,
    observacionesCierre: false,
  });
});

test("cierre simplificado: sin ningún dato pasa y no guarda nada", () => {
  assert.deepEqual(erroresCierreTurno(simplificado), {});
  assert.deepEqual(validarCierreTurno(simplificado), {
    consignas: undefined,
    recibe: undefined,
    observacionesCierre: undefined,
    novedadesElementos: undefined,
    novedadesElementosDetalle: undefined,
  });
  // Tampoco en un turno antiguo sin elementos.
  assert.doesNotThrow(() =>
    validarCierreTurno({ ...simplificado, elementosAsignados: 0 }),
  );
});

test("cierre simplificado: los textos vacíos no se guardan como texto", () => {
  const r = validarCierreTurno({
    ...simplificado,
    consignas: "   ",
    recibe: "",
    observacionesCierre: "\n\t",
  });
  assert.equal(r.consignas, undefined);
  assert.equal(r.recibe, undefined);
  assert.equal(r.observacionesCierre, undefined);
});

test("cierre simplificado: lo que llega igual se valida y se guarda como siempre", () => {
  // Una app sin actualizar que manda el cierre completo: se guarda entero.
  assert.deepEqual(
    validarCierreTurno(base),
    validarCierreTurno(base, CIERRE_COMPLETO),
  );
  // Y lo que viene mal sigue sin pasar, aunque el campo ya no se pida.
  assert.throws(
    () =>
      validarCierreTurno({
        ...simplificado,
        novedadesElementos: true,
        novedadesElementosDetalle: "  ",
      }),
    /describe la novedad/i,
  );
});
