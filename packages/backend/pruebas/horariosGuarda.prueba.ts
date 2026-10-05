import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chocanHorarios,
  diaDeLaSemana,
  estadoHorario,
  etiquetaVigencia,
  resumenSemanal,
  rigeEl,
  terminaAlDiaSiguiente,
  ultimoDiaEfectivo,
  validarBloques,
  validarUltimoDia,
  validarVigencia,
  type BloqueSemanal,
} from "../convex/lib/horariosGuarda.ts";

const b = (dia: number, horaInicio: string, horaFin: string): BloqueSemanal => ({
  dia,
  horaInicio,
  horaFin,
});

/** Mediodía de Colombia de una fecha civil. */
const mediodia = (fecha: string) => Date.parse(`${fecha}T12:00:00-05:00`);

test("el dia de la semana sigue la convencion de las zonas comunes (0 = domingo)", () => {
  assert.equal(diaDeLaSemana("2026-10-04"), 0); // domingo
  assert.equal(diaDeLaSemana("2026-10-05"), 1); // lunes
  assert.equal(diaDeLaSemana("2026-10-10"), 6); // sabado
});

test("semana basica: ordena y normaliza, y los dias sin bloques son libres", () => {
  const bloques = validarBloques([b(2, "6:00", "18:00"), b(1, "06:00", "18:00")]);
  assert.deepEqual(bloques, [b(1, "06:00", "18:00"), b(2, "06:00", "18:00")]);
  const resumen = resumenSemanal(bloques);
  assert.equal(resumen[0]!.nombre, "Lunes");
  assert.deepEqual(resumen[0]!.bloques, ["06:00–18:00"]);
  assert.deepEqual(resumen[2]!.bloques, []); // miercoles: libre
  assert.equal(resumen[6]!.nombre, "Domingo");
});

test("cruce de medianoche: 18:00-06:00 termina al dia siguiente", () => {
  const [jueves] = validarBloques([b(4, "18:00", "06:00")]);
  assert.equal(terminaAlDiaSiguiente(jueves!), true);
  assert.deepEqual(resumenSemanal([jueves!])[3]!.bloques, ["18:00–06:00 (+1)"]);
  // 06:00-06:00 son 24 horas, como en las zonas comunes.
  assert.equal(terminaAlDiaSiguiente(b(1, "06:00", "06:00")), true);
});

test("varios bloques en un dia, si no se pisan", () => {
  const bloques = validarBloques([b(1, "06:00", "10:00"), b(1, "14:00", "18:00")]);
  assert.equal(bloques.length, 2);
  // Tocarse en el borde no es pisarse.
  assert.doesNotThrow(() => validarBloques([b(1, "06:00", "14:00"), b(1, "14:00", "18:00")]));
});

test("bloques que se pisan, tambien a traves de la medianoche y del domingo", () => {
  assert.throws(() => validarBloques([b(1, "08:00", "18:00"), b(1, "17:00", "22:00")]), /se pisan/);
  // El turno del lunes 18-06 se come el martes 05:00.
  assert.throws(() => validarBloques([b(1, "18:00", "06:00"), b(2, "05:00", "09:00")]), /se pisan/);
  // El del sabado 22-06 llega al domingo.
  assert.throws(() => validarBloques([b(6, "22:00", "06:00"), b(0, "05:00", "09:00")]), /se pisan/);
  assert.doesNotThrow(() => validarBloques([b(6, "22:00", "06:00"), b(0, "06:00", "09:00")]));
});

test("bloques invalidos se rechazan", () => {
  assert.throws(() => validarBloques([]), /al menos un bloque/);
  assert.throws(() => validarBloques([b(7, "06:00", "18:00")]), /Día de la semana/);
  assert.throws(() => validarBloques([b(1.5, "06:00", "18:00")]), /Día de la semana/);
  assert.throws(() => validarBloques([b(1, "25:00", "18:00")]), /Formato de hora/);
  assert.throws(() => validarBloques([b(1, "24:00", "06:00")]), /Formato de hora/);
  assert.throws(() => validarBloques([b(1, "6", "18:00")]), /Formato de hora/);
  assert.throws(
    () => validarBloques(Array.from({ length: 22 }, (_, i) => b(i % 7, `0${i % 7}:00`, `0${i % 7}:30`))),
    /hasta 21/,
  );
});

test("vigencia: el fin no puede ser anterior al inicio; sin fin es indefinida", () => {
  assert.doesNotThrow(() => validarVigencia("2026-10-01", "2026-10-31"));
  assert.doesNotThrow(() => validarVigencia("2026-10-01", "2026-10-01"));
  assert.doesNotThrow(() => validarVigencia("2026-10-01"));
  assert.throws(() => validarVigencia("2026-10-31", "2026-10-01"), /anterior/);
  assert.throws(() => validarVigencia("2026-02-30"), /no es válido/);
});

test("finalizar recorta sin alargar, y el estado sale de las fechas", () => {
  const h = { fechaInicio: "2026-10-01", fechaFin: "2026-10-31" };
  assert.equal(ultimoDiaEfectivo(h), "2026-10-31");
  assert.equal(ultimoDiaEfectivo({ ...h, terminaEl: "2026-10-15" }), "2026-10-15");
  assert.equal(ultimoDiaEfectivo({ fechaInicio: "2026-10-01", terminaEl: "2026-10-15" }), "2026-10-15");
  assert.equal(ultimoDiaEfectivo({ fechaInicio: "2026-10-01" }), undefined);

  assert.equal(estadoHorario(h, mediodia("2026-09-30")), "programado");
  assert.equal(estadoHorario(h, mediodia("2026-10-31")), "vigente");
  assert.equal(estadoHorario(h, mediodia("2026-11-01")), "terminado");
  // Finalizado antes de empezar: terminado, aunque su inicio no haya llegado.
  assert.equal(
    estadoHorario({ ...h, terminaEl: "2026-09-29" }, mediodia("2026-09-25")),
    "terminado",
  );
  assert.equal(rigeEl({ ...h, terminaEl: "2026-10-15" }, "2026-10-16"), false);
  assert.equal(rigeEl({ ...h, terminaEl: "2026-10-15" }, "2026-10-15"), true);
});

test("el ultimo dia al finalizar: no antes de ayer, no despues del fin", () => {
  const h = { fechaInicio: "2026-10-01", fechaFin: "2026-10-31" };
  assert.doesNotThrow(() => validarUltimoDia(h, "2026-10-09", "2026-10-10"));
  assert.doesNotThrow(() => validarUltimoDia(h, "2026-10-20", "2026-10-10"));
  assert.throws(() => validarUltimoDia(h, "2026-10-08", "2026-10-10"), /anterior a ayer/);
  assert.throws(() => validarUltimoDia(h, "2026-11-05", "2026-10-10"), /alargar/);
});

test("choques: misma hora en vigencias que se cruzan", () => {
  const lunes = [b(1, "08:00", "18:00")];
  const a = { fechaInicio: "2026-10-01", fechaFin: "2026-10-31", bloques: lunes };
  assert.equal(chocanHorarios(a, { fechaInicio: "2026-10-15", bloques: [b(1, "17:00", "22:00")] }), true);
  // Seguidos en la hora: no chocan.
  assert.equal(chocanHorarios(a, { fechaInicio: "2026-10-15", bloques: [b(1, "18:00", "06:00")] }), false);
  // Vigencias que no se cruzan: no chocan.
  assert.equal(chocanHorarios(a, { fechaInicio: "2026-11-01", bloques: lunes }), false);
  // Un finalizado deja sitio al siguiente.
  assert.equal(
    chocanHorarios({ ...a, terminaEl: "2026-10-15" }, { fechaInicio: "2026-10-16", bloques: lunes }),
    false,
  );
});

test("choques: se miran fechas reales, no solo la semana tipo", () => {
  // Las vigencias solo se cruzan el jueves 15: un bloque de lunes no choca.
  const a = { fechaInicio: "2026-10-01", fechaFin: "2026-10-15", bloques: [b(1, "08:00", "18:00")] };
  const bloquesB = [b(1, "08:00", "18:00"), b(4, "20:00", "22:00")];
  assert.equal(chocanHorarios(a, { fechaInicio: "2026-10-15", bloques: bloquesB }), false);
  // Pero un turno que pasa la medianoche del miercoles 14 al jueves 15 si.
  const b2 = { fechaInicio: "2026-10-14", bloques: [b(3, "22:00", "06:00")] };
  assert.equal(
    chocanHorarios({ ...a, bloques: [b(4, "05:00", "09:00")] }, b2),
    true,
  );
});

test("la vigencia se lee en fechas civiles", () => {
  assert.equal(etiquetaVigencia({ fechaInicio: "2026-10-01", fechaFin: "2026-10-31" }), "01/10/2026 → 31/10/2026");
  assert.equal(etiquetaVigencia({ fechaInicio: "2026-10-01" }), "Desde 01/10/2026 (indefinido)");
  assert.equal(
    etiquetaVigencia({ fechaInicio: "2026-10-01", terminaEl: "2026-10-15" }),
    "01/10/2026 → 15/10/2026",
  );
});
