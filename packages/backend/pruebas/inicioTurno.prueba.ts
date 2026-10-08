import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CAMPOS_PEDIDOS_INICIO,
  INICIO_COMPLETO,
  nombreDeQuienInicia,
} from "../convex/lib/inicioTurno.ts";

test("hoy el inicio no pide el nombre ni las observaciones", () => {
  assert.deepEqual(CAMPOS_PEDIDOS_INICIO, {
    guardiaNombre: false,
    observacionesInicio: false,
  });
});

test("el inicio completo sigue disponible para volver a pedirlos", () => {
  assert.deepEqual(INICIO_COMPLETO, {
    guardiaNombre: true,
    observacionesInicio: true,
  });
});

test("sin pedir el nombre: sale de la sesión", () => {
  assert.equal(nombreDeQuienInicia(undefined, "Ana Guarda"), "Ana Guarda");
  assert.equal(nombreDeQuienInicia(null, "Ana Guarda"), "Ana Guarda");
  assert.equal(nombreDeQuienInicia("   ", "Ana Guarda"), "Ana Guarda");
});

test("sin pedir el nombre: el escrito a mano no puede contar otra persona", () => {
  /* Una app sin actualizar todavía lo pide y lo manda. */
  assert.equal(nombreDeQuienInicia("José Pérez", "Ana Guarda"), "Ana Guarda");
  assert.equal(
    nombreDeQuienInicia("José Pérez", "Ana Guarda", CAMPOS_PEDIDOS_INICIO),
    "Ana Guarda",
  );
});

test("pidiendo el nombre (cuenta compartida): manda el escrito, recortado", () => {
  assert.equal(
    nombreDeQuienInicia("  José Pérez  ", "Portería Norte", INICIO_COMPLETO),
    "José Pérez",
  );
});

test("pidiendo el nombre: vacío, la sesión queda de respaldo como antes", () => {
  for (const escrito of [undefined, null, "", "  \t "]) {
    assert.equal(
      nombreDeQuienInicia(escrito, "Portería Norte", INICIO_COMPLETO),
      "Portería Norte",
    );
  }
});
