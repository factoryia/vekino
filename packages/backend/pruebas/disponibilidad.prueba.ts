import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluarDisponibilidadGuarda,
  ventanaDeConsulta,
  type HorarioEvaluable,
  type InasistenciaEvaluable,
} from "../convex/lib/disponibilidad.ts";
import { ventanaInasistencia } from "../convex/lib/inasistencias.ts";

/*
 * Calendario de referencia (octubre de 2026):
 *   lunes 05, martes 06, miercoles 07, jueves 08, viernes 09.
 */

type Bloque = { dia: number; horaInicio: string; horaFin: string };
const b = (dia: number, horaInicio: string, horaFin: string): Bloque => ({ dia, horaInicio, horaFin });

const horas = (inicioLocal: string, finLocal: string) =>
  ventanaDeConsulta({ diaCompleto: false, inicioLocal, finLocal });

let n = 0;
function horario(
  bloques: Bloque[],
  extra: Partial<HorarioEvaluable> = {},
): HorarioEvaluable {
  return {
    id: `h${++n}`,
    condominioId: "A",
    fechaInicio: "2026-10-01",
    bloques,
    ...extra,
  };
}

function inasistencia(
  inicioLocal: string,
  finLocal: string,
  extra: Partial<InasistenciaEvaluable> = {},
): InasistenciaEvaluable {
  const v = ventanaInasistencia({ diaCompleto: false, inicioLocal, finLocal });
  return { id: `i${++n}`, tipo: "vacaciones", inicio: v.inicio, fin: v.fin, estado: "activa", ...extra };
}

const evaluar = (
  ventana: { inicio: number; fin: number },
  horarios: HorarioEvaluable[] = [],
  inasistencias: InasistenciaEvaluable[] = [],
) => evaluarDisponibilidadGuarda({ ventana, horarios, inasistencias });

const LUNES_MARTES = [b(1, "06:00", "18:00"), b(2, "06:00", "18:00")];

test("A: horario conocido que no ocupa la ventana y sin inasistencia: disponible", () => {
  const r = evaluar(horas("2026-10-05T18:00", "2026-10-05T22:00"), [horario(LUNES_MARTES)]);
  assert.deepEqual(r, { estado: "disponible", motivos: [] });
});

test("B: el horario se cruza con la ventana: ocupado, con el bloque que choca", () => {
  const h = horario(LUNES_MARTES);
  const r = evaluar(horas("2026-10-05T14:00", "2026-10-05T22:00"), [h]);
  assert.equal(r.estado, "ocupado");
  assert.deepEqual(r.motivos, [
    {
      tipo: "horario",
      horarioId: h.id,
      condominioId: "A",
      fecha: "2026-10-05",
      horaInicio: "06:00",
      horaFin: "18:00",
      inicio: Date.UTC(2026, 9, 5, 11, 0),
      fin: Date.UTC(2026, 9, 5, 23, 0),
    },
  ]);
});

test("C: un horario en otro conjunto tambien ocupa, aunque se pregunte por otro", () => {
  const enA = horario([b(4, "18:00", "06:00")], { condominioId: "A" });
  const r = evaluar(horas("2026-10-08T18:00", "2026-10-09T06:00"), [enA]);
  assert.equal(r.estado, "ocupado");
  assert.equal(r.motivos[0]!.tipo === "horario" && r.motivos[0]!.condominioId, "A");

  // Si en A trabaja el jueves de dia, la noche del jueves queda libre.
  const deDia = horario([b(4, "06:00", "18:00")], { condominioId: "A" });
  assert.equal(evaluar(horas("2026-10-08T18:00", "2026-10-09T06:00"), [deDia]).estado, "disponible");
});

test("D: un horario general que cubre la ventana ocupa", () => {
  const general = horario([b(4, "08:00", "20:00")], { condominioId: null });
  const r = evaluar(horas("2026-10-08T18:00", "2026-10-09T06:00"), [general]);
  assert.equal(r.estado, "ocupado");
  assert.equal(r.motivos[0]!.tipo === "horario" && r.motivos[0]!.condominioId, null);
});

test("E: sin horario ni inasistencia: desconocido, nunca disponible", () => {
  const r = evaluar(horas("2026-10-08T18:00", "2026-10-09T06:00"));
  assert.deepEqual(r, {
    estado: "desconocido",
    motivos: [{ tipo: "sin_horario", fechas: ["2026-10-08", "2026-10-09"] }],
  });
});

test("F: dia sin bloques dentro de un horario vigente es libre; sin horario que rija, desconocido", () => {
  // Lunes y martes trabaja; el miercoles en la noche esta libre segun lo planificado.
  assert.equal(
    evaluar(horas("2026-10-07T18:00", "2026-10-08T06:00"), [horario(LUNES_MARTES)]).estado,
    "disponible",
  );
  // Pero si el horario termina el miercoles, la madrugada del jueves no tiene planificacion.
  const r = evaluar(horas("2026-10-07T18:00", "2026-10-08T06:00"), [
    horario(LUNES_MARTES, { fechaFin: "2026-10-07" }),
  ]);
  assert.deepEqual(r, {
    estado: "desconocido",
    motivos: [{ tipo: "sin_horario", fechas: ["2026-10-08"] }],
  });
});

test("G: una inasistencia que cruza la ventana: no disponible, solo con su categoria", () => {
  const i = inasistencia("2026-10-08T00:00", "2026-10-09T00:00", { tipo: "incapacidad" });
  const r = evaluar(horas("2026-10-08T14:00", "2026-10-08T22:00"), [horario(LUNES_MARTES)], [i]);
  assert.equal(r.estado, "no_disponible");
  assert.deepEqual(r.motivos, [
    { tipo: "inasistencia", inasistenciaId: i.id, categoria: "incapacidad", inicio: i.inicio, fin: i.fin },
  ]);
  assert.equal(JSON.stringify(r).includes("motivo\""), false);
});

test("H: una inasistencia anulada no cuenta", () => {
  const anulada = inasistencia("2026-10-07T00:00", "2026-10-08T00:00", { estado: "anulada" });
  assert.equal(
    evaluar(horas("2026-10-07T18:00", "2026-10-07T22:00"), [horario(LUNES_MARTES)], [anulada]).estado,
    "disponible",
  );
});

test("I: basta un cruce parcial para no poder cubrir la ventana completa", () => {
  const ventana = horas("2026-10-08T18:00", "2026-10-09T06:00");
  const ultimasHoras = horario([b(4, "22:00", "06:00")]);
  assert.equal(evaluar(ventana, [ultimasHoras]).estado, "ocupado");
  const parcial = inasistencia("2026-10-08T22:00", "2026-10-09T06:00");
  assert.equal(evaluar(ventana, [horario(LUNES_MARTES)], [parcial]).estado, "no_disponible");
});

test("J: horario e inasistencia a la vez: manda la inasistencia, y se ven los dos", () => {
  const h = horario([b(4, "18:00", "06:00")]);
  const i = inasistencia("2026-10-08T00:00", "2026-10-09T00:00");
  const r = evaluar(horas("2026-10-08T18:00", "2026-10-09T06:00"), [h], [i]);
  assert.equal(r.estado, "no_disponible");
  assert.deepEqual(r.motivos.map((m) => m.tipo), ["inasistencia", "horario"]);
});

test("K: con varios horarios en conjuntos distintos se evalua contra todos", () => {
  const enA = horario([b(1, "06:00", "18:00")], { condominioId: "A" });
  const enB = horario([b(3, "18:00", "06:00")], { condominioId: "B" });
  const miercoles = evaluar(horas("2026-10-07T20:00", "2026-10-07T23:00"), [enA, enB]);
  assert.equal(miercoles.estado, "ocupado");
  assert.equal(miercoles.motivos[0]!.tipo === "horario" && miercoles.motivos[0]!.condominioId, "B");
  assert.equal(evaluar(horas("2026-10-06T08:00", "2026-10-06T10:00"), [enA, enB]).estado, "disponible");
});

test("los bordes se tocan sin pisarse: [inicio, fin)", () => {
  const h = horario(LUNES_MARTES);
  assert.equal(evaluar(horas("2026-10-05T04:00", "2026-10-05T06:00"), [h]).estado, "disponible");
  assert.equal(evaluar(horas("2026-10-05T18:00", "2026-10-05T19:00"), [h]).estado, "disponible");
  const hasta18 = inasistencia("2026-10-05T08:00", "2026-10-05T18:00");
  assert.equal(evaluar(horas("2026-10-05T18:00", "2026-10-05T19:00"), [h], [hasta18]).estado, "disponible");
});

test("el turno de la vispera que pasa la medianoche ocupa la madrugada", () => {
  const miercolesNoche = horario([b(3, "22:00", "06:00")]);
  const r = evaluar(horas("2026-10-08T00:00", "2026-10-08T04:00"), [miercolesNoche]);
  assert.equal(r.estado, "ocupado");
  assert.equal(r.motivos[0]!.tipo === "horario" && r.motivos[0]!.fecha, "2026-10-07");
});

test("N: una fecha pasada se evalua con lo que regia entonces", () => {
  const septiembre = horario([b(1, "06:00", "18:00")], {
    fechaInicio: "2026-09-01",
    fechaFin: "2026-09-30",
  });
  assert.equal(evaluar(horas("2026-09-07T10:00", "2026-09-07T12:00"), [septiembre]).estado, "ocupado");
  assert.equal(evaluar(horas("2026-10-05T10:00", "2026-10-05T12:00"), [septiembre]).estado, "desconocido");
  // Un horario finalizado deja de regir desde el dia siguiente a su corte.
  const finalizado = horario([b(1, "06:00", "18:00")], { terminaEl: "2026-10-04" });
  assert.equal(evaluar(horas("2026-10-05T10:00", "2026-10-05T12:00"), [finalizado]).estado, "desconocido");
});

test("O: una fecha futura se evalua con lo que va a regir", () => {
  const noviembre = horario([b(1, "06:00", "18:00")], { fechaInicio: "2026-11-01" });
  assert.equal(evaluar(horas("2026-11-02T10:00", "2026-11-02T12:00"), [noviembre]).estado, "ocupado");
  assert.equal(evaluar(horas("2026-10-05T10:00", "2026-10-05T12:00"), [noviembre]).estado, "desconocido");
});

test("un dia completo va de su medianoche a la siguiente, en hora de Colombia", () => {
  const v = ventanaDeConsulta({ diaCompleto: true, fechaInicio: "2026-10-08", fechaFin: "2026-10-08" });
  assert.equal(v.inicio, Date.UTC(2026, 9, 8, 5, 0));
  assert.equal(v.fin, Date.UTC(2026, 9, 9, 5, 0));
  assert.deepEqual(evaluar(v).motivos, [{ tipo: "sin_horario", fechas: ["2026-10-08"] }]);
});

test("P: la ventana tiene un tope de 31 dias", () => {
  assert.doesNotThrow(() =>
    ventanaDeConsulta({ diaCompleto: true, fechaInicio: "2026-10-01", fechaFin: "2026-10-31" }),
  );
  assert.throws(
    () => ventanaDeConsulta({ diaCompleto: true, fechaInicio: "2026-10-01", fechaFin: "2026-11-01" }),
    /hasta 31 días/,
  );
  assert.throws(() => horas("2026-10-08T18:00", "2026-10-08T18:00"), /posterior/);
});
