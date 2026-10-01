import { test } from "node:test";
import assert from "node:assert/strict";
import {
  claveRegistro,
  confirmarRecordatorio,
  evaluarRecordatorio,
  franjaActiva,
  horaColombia,
  leerRegistro,
  msHastaRevision,
  nombreParaSaludo,
  REVISION_MAX_MS,
  siguienteCambio,
  VENTANA_RECORDATORIO_MINUTOS,
  type Franja,
  type RegistroRecordatorio,
} from "../convex/lib/recordatorioCierre.ts";

/** Un instante en hora de Colombia, escrito como se lee en la portería. */
const co = (iso: string) => Date.parse(`${iso}-05:00`);
const clave = (iso: string) => franjaActiva(co(iso))?.clave ?? null;
/** Franja activa que la prueba da por hecho que existe. */
const activa = (iso: string): Franja => {
  const f = franjaActiva(co(iso));
  assert.ok(f, `esperaba una franja activa a las ${iso}`);
  return f;
};

// ─── Ventanas ────────────────────────────────────────────────

test("la ventana por defecto es de 120 minutos", () => {
  assert.equal(VENTANA_RECORDATORIO_MINUTOS, 120);
  const f = activa("2026-10-01T05:50:00");
  assert.equal(f.fin - f.inicio, 120 * 60 * 1000);
});

test("mañana: antes de 05:50 no, de 05:50 a 07:50 sí, desde 07:50 no", () => {
  assert.equal(clave("2026-10-01T05:49:59.999"), null);
  assert.equal(clave("2026-10-01T05:50:00"), "2026-10-01:morning");
  assert.equal(clave("2026-10-01T05:55:00"), "2026-10-01:morning"); // caso 1
  assert.equal(clave("2026-10-01T06:30:00"), "2026-10-01:morning"); // caso 6
  assert.equal(clave("2026-10-01T07:49:59.999"), "2026-10-01:morning");
  assert.equal(clave("2026-10-01T07:50:00"), null);
  assert.equal(clave("2026-10-01T10:00:00"), null); // caso 2
});

test("tarde: antes de 17:50 no, de 17:50 a 19:50 sí, desde 19:50 no", () => {
  assert.equal(clave("2026-10-01T17:49:59.999"), null);
  assert.equal(clave("2026-10-01T17:50:00"), "2026-10-01:evening");
  assert.equal(clave("2026-10-01T17:55:00"), "2026-10-01:evening"); // caso 3
  assert.equal(clave("2026-10-01T19:49:59.999"), "2026-10-01:evening");
  assert.equal(clave("2026-10-01T19:50:00"), null);
  assert.equal(clave("2026-10-01T23:00:00"), null); // caso 4
});

test("etiquetas e inicio de cada franja", () => {
  const m = activa("2026-10-01T05:50:00");
  assert.equal(m.inicio, co("2026-10-01T05:50:00"));
  assert.equal(m.fin, co("2026-10-01T07:50:00"));
  assert.equal(m.etiqueta, "5:50 a. m.");
  const t = activa("2026-10-01T18:00:00");
  assert.equal(t.fin, co("2026-10-01T19:50:00"));
  assert.equal(t.etiqueta, "5:50 p. m.");
});

test("cambio de día: noche anterior y madrugada sin aviso, el nuevo día abre el suyo", () => {
  assert.equal(clave("2026-10-01T22:00:00"), null);
  assert.equal(clave("2026-10-02T00:00:00"), null);
  assert.equal(clave("2026-10-02T03:30:00"), null);
  assert.equal(clave("2026-10-02T05:50:00"), "2026-10-02:morning");
  // Cruza mes y año sin desfasarse.
  assert.equal(clave("2026-11-01T06:00:00"), "2026-11-01:morning");
  assert.equal(clave("2026-12-31T18:00:00"), "2026-12-31:evening");
  assert.equal(clave("2027-01-01T01:00:00"), null);
});

test("la ventana es configurable; si cruza la medianoche sigue siendo la de la víspera", () => {
  assert.equal(franjaActiva(co("2026-10-01T06:20:00"), 31)?.clave, "2026-10-01:morning");
  assert.equal(franjaActiva(co("2026-10-01T06:20:00"), 30), null);
  // 7 h: 17:50 → 00:50 del día siguiente.
  assert.equal(franjaActiva(co("2026-10-02T00:30:00"), 420)?.clave, "2026-10-01:evening");
  assert.equal(franjaActiva(co("2026-10-02T00:50:00"), 420), null);
  const confirmado = confirmarRecordatorio(
    null,
    franjaActiva(co("2026-10-01T18:00:00"), 420)!,
    co("2026-10-01T18:00:00"),
  );
  assert.equal(evaluarRecordatorio(confirmado, co("2026-10-02T00:30:00"), 420).mostrar, false);
});

test("la hora la fija Colombia, no la zona del dispositivo", () => {
  // 22:50 UTC = 17:50 en Bogotá, se lea desde donde se lea.
  assert.equal(franjaActiva(Date.parse("2026-10-01T22:50:00Z"))?.clave, "2026-10-01:evening");
});

test("el próximo cambio es la apertura o el cierre más cercano", () => {
  assert.equal(siguienteCambio(co("2026-10-01T05:40:00")), co("2026-10-01T05:50:00"));
  assert.equal(siguienteCambio(co("2026-10-01T06:00:00")), co("2026-10-01T07:50:00"));
  assert.equal(siguienteCambio(co("2026-10-01T07:50:00")), co("2026-10-01T17:50:00"));
  assert.equal(siguienteCambio(co("2026-10-01T18:00:00")), co("2026-10-01T19:50:00"));
  assert.equal(siguienteCambio(co("2026-10-01T20:00:00")), co("2026-10-02T05:50:00"));
});

test("revisa como mucho cada minuto, y justo después de abrir o cerrar la ventana", () => {
  assert.equal(msHastaRevision(co("2026-10-01T12:00:00")), REVISION_MAX_MS);
  for (const iso of ["2026-10-01T05:49:59.900", "2026-10-01T07:49:59.900"]) {
    const ms = msHastaRevision(co(iso));
    assert.ok(ms > 100 && ms < 1000, `${iso}: esperaba < 1 s, fue ${ms}`);
  }
});

// ─── Evaluación, duplicados y confirmación ───────────────────

test("fuera de la ventana no se muestra ni se escribe nada", () => {
  for (const iso of ["2026-10-01T05:40:00", "2026-10-01T10:00:00", "2026-10-01T23:00:00"]) {
    assert.deepEqual(evaluarRecordatorio(null, co(iso)), { mostrar: false }, iso);
  }
});

test("dentro de la ventana y sin registro: se muestra y hay que guardar que se mostró", () => {
  const ahora = co("2026-10-01T17:50:30");
  const r = evaluarRecordatorio(null, ahora);
  assert.equal(r.mostrar, true);
  assert.ok(r.mostrar && r.nuevo);
  assert.deepEqual(r.mostrar && r.registro, {
    franja: "2026-10-01:evening",
    mostradoEn: ahora,
  });
});

test("mostrado y no confirmado: vuelve a salir dentro de la ventana, no fuera", () => {
  const registro: RegistroRecordatorio = {
    franja: "2026-10-01:evening",
    mostradoEn: co("2026-10-01T17:50:00"),
  };
  const r = evaluarRecordatorio(registro, co("2026-10-01T19:00:00"));
  assert.equal(r.mostrar, true);
  assert.ok(r.mostrar && !r.nuevo);
  assert.equal(r.mostrar && r.registro.mostradoEn, co("2026-10-01T17:50:00"));
  assert.equal(evaluarRecordatorio(registro, co("2026-10-01T19:50:00")).mostrar, false);
});

test("mismo usuario, fecha y franja: se confirma una sola vez", () => {
  const franja = activa("2026-10-01T17:50:00");
  const confirmado = confirmarRecordatorio(
    { franja: franja.clave, mostradoEn: co("2026-10-01T17:50:00") },
    franja,
    co("2026-10-01T17:51:00"),
  );
  assert.equal(confirmado.mostradoEn, co("2026-10-01T17:50:00"));
  assert.equal(confirmado.confirmadoEn, co("2026-10-01T17:51:00"));

  for (const hora of ["2026-10-01T17:52:00", "2026-10-01T19:49:00", "2026-10-01T23:00:00"]) {
    assert.equal(evaluarRecordatorio(confirmado, co(hora)).mostrar, false, hora);
  }
});

test("confirmar la tarde no apaga la mañana siguiente ni al revés", () => {
  const tarde = activa("2026-10-01T17:50:00");
  const conTarde = confirmarRecordatorio(null, tarde, co("2026-10-01T17:55:00"));
  const r = evaluarRecordatorio(conTarde, co("2026-10-02T05:50:00"));
  assert.ok(r.mostrar);
  assert.equal(r.mostrar && r.franja.clave, "2026-10-02:morning");

  const manana = activa("2026-10-02T06:00:00");
  const conManana = confirmarRecordatorio(null, manana, co("2026-10-02T06:00:00"));
  assert.equal(evaluarRecordatorio(conManana, co("2026-10-02T17:50:00")).mostrar, true);
});

test("confirma la franja que leyó aunque su ventana acabe de cerrarse", () => {
  const tarde = activa("2026-10-01T19:49:00");
  const confirmado = confirmarRecordatorio(null, tarde, co("2026-10-01T19:50:05"));
  assert.equal(confirmado.franja, "2026-10-01:evening");
  assert.equal(evaluarRecordatorio(confirmado, co("2026-10-01T19:50:10")).mostrar, false);
  assert.equal(evaluarRecordatorio(confirmado, co("2026-10-02T05:50:10")).mostrar, true);
});

test("lo guardado corrupto o ajeno cuenta como nada", () => {
  assert.equal(leerRegistro(null), null);
  assert.equal(leerRegistro(""), null);
  assert.equal(leerRegistro("{no es json"), null);
  assert.equal(leerRegistro('"2026-10-01:evening"'), null);
  assert.equal(leerRegistro('{"franja":1,"mostradoEn":2}'), null);
  assert.deepEqual(leerRegistro('{"franja":"2026-10-01:evening","mostradoEn":5,"confirmadoEn":"x"}'), {
    franja: "2026-10-01:evening",
    mostradoEn: 5,
    confirmadoEn: undefined,
  });
  const ida = confirmarRecordatorio(null, activa("2026-10-01T06:00:00"), 99);
  assert.deepEqual(leerRegistro(JSON.stringify(ida)), ida);
});

test("la clave separa usuarios: lo de un guarda no apaga el del siguiente", () => {
  assert.notEqual(claveRegistro("userA"), claveRegistro("userB"));
  assert.ok(claveRegistro("userA").includes("userA"));
});

// ─── Texto ───────────────────────────────────────────────────

test("saludo con el primer nombre", () => {
  assert.equal(nombreParaSaludo("José Pérez Gómez"), "José");
  assert.equal(nombreParaSaludo("  Ana  "), "Ana");
  assert.equal(nombreParaSaludo(""), "");
});

test("hora de 12 h en Colombia", () => {
  assert.equal(horaColombia(co("2026-10-01T00:05:00")), "12:05 a. m.");
  assert.equal(horaColombia(co("2026-10-01T06:02:00")), "6:02 a. m.");
  assert.equal(horaColombia(co("2026-10-01T12:00:00")), "12:00 p. m.");
  assert.equal(horaColombia(co("2026-10-01T23:59:00")), "11:59 p. m.");
});
