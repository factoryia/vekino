import { test } from "node:test";
import assert from "node:assert/strict";
import {
  claveRegistro,
  confirmarRecordatorio,
  evaluarRecordatorio,
  franjaVigente,
  horaColombia,
  inicioSiguienteFranja,
  leerRegistro,
  msHastaRevision,
  nombreParaSaludo,
  REVISION_MAX_MS,
  type RegistroRecordatorio,
} from "../convex/lib/recordatorioCierre.ts";

/** Un instante en hora de Colombia, escrito como se lee en la portería. */
const co = (iso: string) => Date.parse(`${iso}-05:00`);

// ─── Horarios ────────────────────────────────────────────────

test("05:50 abre la franja de la mañana de ese día", () => {
  const f = franjaVigente(co("2026-10-01T05:50:00"));
  assert.equal(f.clave, "2026-10-01:morning");
  assert.equal(f.inicio, co("2026-10-01T05:50:00"));
  assert.equal(f.etiqueta, "5:50 a. m.");
});

test("17:50 abre la franja de la tarde de ese día", () => {
  const f = franjaVigente(co("2026-10-01T17:50:00"));
  assert.equal(f.clave, "2026-10-01:evening");
  assert.equal(f.etiqueta, "5:50 p. m.");
});

test("antes de las 05:50 no se adelanta la mañana: rige la tarde anterior", () => {
  assert.equal(
    franjaVigente(co("2026-10-01T05:49:59.999")).clave,
    "2026-09-30:evening",
  );
});

test("antes de las 17:50 sigue la mañana", () => {
  assert.equal(
    franjaVigente(co("2026-10-01T17:49:59.999")).clave,
    "2026-10-01:morning",
  );
});

test("pasada la medianoche no cambia la franja, aunque cambie la fecha", () => {
  assert.equal(franjaVigente(co("2026-10-01T23:59:59")).clave, "2026-10-01:evening");
  assert.equal(franjaVigente(co("2026-10-02T00:00:00")).clave, "2026-10-01:evening");
  assert.equal(franjaVigente(co("2026-10-02T03:30:00")).clave, "2026-10-01:evening");
});

test("cruza mes y año sin desfasarse", () => {
  assert.equal(franjaVigente(co("2026-11-01T02:00:00")).clave, "2026-10-31:evening");
  assert.equal(franjaVigente(co("2027-01-01T01:00:00")).clave, "2026-12-31:evening");
});

test("la hora la fija Colombia, no la zona del dispositivo", () => {
  // 22:50 UTC = 17:50 en Bogotá, se lea desde donde se lea.
  assert.equal(
    franjaVigente(Date.parse("2026-10-01T22:50:00Z")).clave,
    "2026-10-01:evening",
  );
});

test("la próxima franja siempre es posterior", () => {
  assert.equal(inicioSiguienteFranja(co("2026-10-01T05:49:00")), co("2026-10-01T05:50:00"));
  assert.equal(inicioSiguienteFranja(co("2026-10-01T05:50:00")), co("2026-10-01T17:50:00"));
  assert.equal(inicioSiguienteFranja(co("2026-10-01T20:00:00")), co("2026-10-02T05:50:00"));
});

test("revisa como mucho cada minuto, y justo después del horario si llega antes", () => {
  assert.equal(msHastaRevision(co("2026-10-01T12:00:00")), REVISION_MAX_MS);
  const ms = msHastaRevision(co("2026-10-01T17:49:59.900"));
  assert.ok(ms > 100 && ms < 1000, `esperaba < 1 s, fue ${ms}`);
});

// ─── Duplicados y confirmación ───────────────────────────────

test("sin registro previo: se muestra y hay que guardar que se mostró", () => {
  const ahora = co("2026-10-01T17:50:30");
  const r = evaluarRecordatorio(null, ahora);
  assert.equal(r.mostrar, true);
  assert.ok(r.mostrar && r.nuevo);
  assert.deepEqual(r.mostrar && r.registro, {
    franja: "2026-10-01:evening",
    mostradoEn: ahora,
  });
});

test("mostrado y no confirmado: vuelve a salir y conserva la primera hora", () => {
  const registro: RegistroRecordatorio = {
    franja: "2026-10-01:evening",
    mostradoEn: co("2026-10-01T17:50:00"),
  };
  const r = evaluarRecordatorio(registro, co("2026-10-01T19:00:00"));
  assert.equal(r.mostrar, true);
  assert.ok(r.mostrar && !r.nuevo);
  assert.equal(r.mostrar && r.registro.mostradoEn, co("2026-10-01T17:50:00"));
});

test("confirmado: no se repite en la misma franja", () => {
  const franja = franjaVigente(co("2026-10-01T17:50:00"));
  const confirmado = confirmarRecordatorio(
    { franja: franja.clave, mostradoEn: co("2026-10-01T17:50:00") },
    franja,
    co("2026-10-01T17:51:00"),
  );
  assert.equal(confirmado.mostradoEn, co("2026-10-01T17:50:00"));
  assert.equal(confirmado.confirmadoEn, co("2026-10-01T17:51:00"));

  for (const hora of ["2026-10-01T17:52:00", "2026-10-01T23:00:00", "2026-10-02T05:49:00"]) {
    assert.equal(evaluarRecordatorio(confirmado, co(hora)).mostrar, false, hora);
  }
});

test("confirmar la tarde no apaga la mañana siguiente", () => {
  const tarde = franjaVigente(co("2026-10-01T17:50:00"));
  const confirmado = confirmarRecordatorio(null, tarde, co("2026-10-01T17:55:00"));
  const r = evaluarRecordatorio(confirmado, co("2026-10-02T05:50:00"));
  assert.equal(r.mostrar, true);
  assert.equal(r.franja.clave, "2026-10-02:morning");
});

test("confirma la franja que leyó aunque justo haya empezado otra", () => {
  const tarde = franjaVigente(co("2026-10-01T17:50:00"));
  const confirmado = confirmarRecordatorio(null, tarde, co("2026-10-02T05:50:05"));
  assert.equal(confirmado.franja, "2026-10-01:evening");
  // La de la mañana sigue pendiente: es otro recordatorio.
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
  const ida = confirmarRecordatorio(null, franjaVigente(co("2026-10-01T06:00:00")), 99);
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
