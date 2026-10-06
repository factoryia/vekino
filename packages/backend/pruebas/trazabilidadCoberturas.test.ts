import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id, TableNames } from "../convex/_generated/dataModel";
import { CHECKLIST, CIERRE, HORA, MIN, T17, montar, type Escenario } from "./helpers/trazabilidad";

/**
 * FASE 11: CADA OPERACIÓN RECUERDA BAJO QUÉ CONTEXTO SE HIZO.
 *
 * La autorización sigue siendo la de la Fase 8 (¿puede operar aquí AHORA?).
 * Lo nuevo es que la operación guarda, al crearse, la cobertura bajo la que
 * se hizo, y las lecturas históricas leen ese sello: no el contexto de hoy,
 * ni el estado actual de la cobertura, ni sus fechas.
 *
 * La cobertura X de Jason cubre Bosque (B) el 10/10 de 18:00 a 06:00. Su
 * conjunto de siempre es Alamos (A).
 */

const T18 = T17 + HORA;
const T19 = T17 + 2 * HORA;
const T06 = T17 + 13 * HORA;
const T07 = T17 + 14 * HORA;

let e: Escenario;
beforeEach(async () => {
  vi.setSystemTime(T17);
  e = await montar();
});
afterEach(() => vi.useRealTimers());

const en = (instante: number) => vi.setSystemTime(instante);

/** El sello tal cual quedó en la fila. */
const sello = (tabla: TableNames, id: string) =>
  e.t.run(async (ctx) => {
    const fila = (await ctx.db.get(id as Id<typeof tabla>)) as { coberturaId?: Id<"coberturas"> } | null;
    return fila?.coberturaId ?? null;
  });

/** Los sellos de todo lo que hizo un actor en un conjunto, por tabla. */
const sellosDe = (userId: Id<"users">, condominioId: Id<"condominios">) =>
  e.t.run(async (ctx) => {
    const delConjunto = async <T extends "guardiaTurnos" | "guardiaRondas" | "minutaEventos" | "guardiaNovedadReportes">(tabla: T) =>
      (await ctx.db.query(tabla).collect()).filter((f) => f.condominioId === condominioId);
    return {
      turnos: (await delConjunto("guardiaTurnos"))
        .filter((t) => t.guardiaUserId === userId)
        .map((t) => t.coberturaId ?? null),
      rondas: (await delConjunto("guardiaRondas"))
        .filter((r) => r.guardiaUserId === userId || (!r.guardiaUserId && r.coberturaId))
        .map((r) => r.coberturaId ?? null),
      minuta: (await delConjunto("minutaEventos"))
        .filter((m) => m.actorUserId === userId)
        .map((m) => m.coberturaId ?? null),
      novedades: (await delConjunto("guardiaNovedadReportes"))
        .filter((n) => n.reportadoPorUserId === userId)
        .map((n) => n.coberturaId ?? null),
    };
  });

const todos = (sellos: Awaited<ReturnType<typeof sellosDe>>) => [
  ...sellos.turnos,
  ...sellos.rondas,
  ...sellos.minuta,
  ...sellos.novedades,
];

describe("Fase 11: el sello sigue el contexto real de cada operación", () => {
  test("A, B, C, D y E. la línea de tiempo 17:00 → 07:00", async () => {
    const x = await e.cubrir(e.bosque, e.kBosque, T18, T06);

    // 17:00 — A, antes de la cobertura (A y C): sin sello.
    const enA = await e.jornada("jason", e.alamos);
    expect(await sello("guardiaTurnos", enA.turnoId)).toBeNull();

    // 19:00 — B, durante la cobertura (B): sellado con X.
    en(T19);
    const enB = await e.jornada("jason", e.bosque);
    expect(await sello("guardiaTurnos", enB.turnoId)).toBe(x);
    expect(await sello("guardiaRondas", enB.rondaId)).toBe(x);
    expect(await sello("guardiaNovedadReportes", enB.novedadId)).toBe(x);

    // 19:30 — cierra el turno de A que dejó abierto (D): sigue sin sello, y
    // el evento de cierre, que ocurre en A, tampoco lleva el de B.
    en(T19 + 30 * MIN);
    await e.como("jason").mutation(api.guardia.cerrarTurno, { turnoId: enA.turnoId, ...CIERRE });
    expect(await sello("guardiaTurnos", enA.turnoId)).toBeNull();
    expect(new Set(todos(await sellosDe(e.jason, e.alamos)))).toEqual(new Set([null]));

    // 06:00 termina. 07:00 — de vuelta en A (E): sin sello.
    en(T06 - MIN);
    await e.como("jason").mutation(api.guardia.cerrarTurno, { turnoId: enB.turnoId, ...CIERRE });
    en(T07);
    const despues = await e.jornada("jason", e.alamos);
    expect(await sello("guardiaTurnos", despues.turnoId)).toBeNull();
    expect(await sello("guardiaRondas", despues.rondaId)).toBeNull();
    expect(await sello("guardiaNovedadReportes", despues.novedadId)).toBeNull();

    // Todo lo de B, sellado con X; todo lo de A, sin sello.
    expect(new Set(todos(await sellosDe(e.jason, e.bosque)))).toEqual(new Set([x]));
    expect(new Set(todos(await sellosDe(e.jason, e.alamos)))).toEqual(new Set([null]));
  });

  test("G y H. el turno es de la portería: cada uno sella su propio contexto", async () => {
    const x = await e.cubrir(e.bosque, e.kBosque, T18, T06);
    en(T19);
    // Bruno (de planta en B) abre el turno; Jason opera en él cubriendo.
    const turnoDeBruno = await e.como("bruno").mutation(api.guardia.iniciarTurno, {
      condominioId: e.bosque,
      checklist: CHECKLIST,
    });
    await e.como("jason").mutation(api.guardia.registrarRonda, {
      condominioId: e.bosque,
      zonaNombre: "Parqueadero",
      fotos: [],
    });
    await e.como("jason").mutation(api.guardia.registrarEventoMinuta, {
      condominioId: e.bosque,
      tipo: "Anotación",
      resumen: "Recorrido de Jason.",
    });
    await e.como("bruno").mutation(api.guardia.registrarEventoMinuta, {
      condominioId: e.bosque,
      tipo: "Anotación",
      resumen: "Recorrido de Bruno.",
    });

    // El turno de Bruno no lleva sello; lo de Jason dentro de él, sí.
    expect(await sello("guardiaTurnos", turnoDeBruno)).toBeNull();
    const minuta = await e.como("sergio").query(api.guardia.listMinuta, { condominioId: e.bosque });
    const deJason = minuta.filter((m) => m.actorUserId === e.jason);
    const deBruno = minuta.filter((m) => m.actorUserId === e.bruno);
    expect(deJason.length).toBeGreaterThan(0);
    expect(deJason.every((m) => m.cobertura?.coberturaId === x && m.turnoId === turnoDeBruno)).toBe(true);
    expect(deBruno.every((m) => m.cobertura === undefined)).toBe(true);
    const rondas = await e.como("sergio").query(api.rondas.listar, { condominioId: e.bosque });
    expect(rondas[0]).toMatchObject({ cobertura: { coberturaId: x, inicio: T18, fin: T06 } });
  });

  test("F y N. inhabilitarla después no cambia el pasado; lo de después ya no existe bajo ella", async () => {
    const x = await e.cubrir(e.bosque, e.kBosque, T18, T06);
    en(T19);
    const enB = await e.jornada("jason", e.bosque);

    en(T17 + 5 * HORA); // 22:00
    await e.como("alicia").mutation(api.coberturas.inhabilitar, { coberturaId: x, motivo: "Se retiró." });

    // Lo hecho a las 19:00 sigue diciendo X, en la fila y en las lecturas.
    expect(await sello("guardiaTurnos", enB.turnoId)).toBe(x);
    const turnos = await e.como("sergio").query(api.guardia.listTurnos, { condominioId: e.bosque });
    expect(turnos.find((t) => t._id === enB.turnoId)).toMatchObject({
      coberturaId: x,
      cobertura: { coberturaId: x, inicio: T18, fin: T06 },
    });
    const turno = await e.como("sergio").query(api.guardia.getTurno, { turnoId: enB.turnoId });
    expect(turno?.cobertura?.coberturaId).toBe(x);

    // Después del corte no hay operación en B bajo X: la autorización lo impide.
    await expect(
      e.como("jason").mutation(api.guardia.registrarEventoMinuta, {
        condominioId: e.bosque,
        tipo: "Anotación",
        resumen: "Tarde.",
      }),
    ).rejects.toThrow();
    // Y lo que haga de nuevo en A, ya de vuelta, va sin sello. Antes cierra el
    // turno que dejó abierto en B: con él pendiente no se abre otro en A
    // (Fase 15, QA-008 E). Cerrarlo no cambia su sello.
    await e.como("jason").mutation(api.guardia.cerrarTurno, { turnoId: enB.turnoId, ...CIERRE });
    expect(await sello("guardiaTurnos", enB.turnoId)).toBe(x);
    await e.jornada("jason", e.alamos);
    expect(new Set(todos(await sellosDe(e.jason, e.alamos)))).toEqual(new Set([null]));
  });

  test("I. la novedad sale con su contexto en el listado", async () => {
    const x = await e.cubrir(e.bosque, e.kBosque, T18, T06);
    en(T19);
    const { novedadId } = await e.jornada("jason", e.bosque);
    const reportes = await e.como("jason").query(api.guardia.listNovedadReportes, {
      condominioId: e.bosque,
    });
    expect(reportes.find((n) => n._id === novedadId)).toMatchObject({
      cobertura: { coberturaId: x, condominioId: e.bosque, inicio: T18, fin: T06 },
    });
  });

  test("J. la entrega de material durante B queda atribuida a la cobertura", async () => {
    const x = await e.cubrir(e.bosque, e.kBosque, T18, T06);
    const radioA = await e.itemEn(e.alamos, "Radio de Alamos");
    const radioB = await e.itemEn(e.bosque, "Radio de Bosque");

    // 17:10 en A, por su asignación: sin sello.
    en(T17 + 10 * MIN);
    await e.como("sofia").mutation(api.inventarioGuardas.entregar, { itemId: radioA, guardaUserId: e.jason });
    await e.como("sofia").mutation(api.inventarioGuardas.recibir, { itemId: radioA });

    // 19:15 en B, cubriendo: sellado con X.
    en(T19 + 15 * MIN);
    const { custodiaId } = await e.como("sergio").mutation(api.inventarioGuardas.entregar, {
      itemId: radioB,
      guardaUserId: e.jason,
    });
    expect(await sello("inventarioCustodiaGuardas", custodiaId)).toBe(x);

    // Y se puede demostrar después, ya terminada la cobertura.
    en(T07);
    const historialB = await e.como("sergio").query(api.inventarioGuardas.historialDeItem, { itemId: radioB });
    expect(historialB[0]).toMatchObject({
      guardaUserId: e.jason,
      cobertura: { coberturaId: x, inicio: T18, fin: T06 },
    });
    const historialA = await e.como("sofia").query(api.inventarioGuardas.historialDeItem, { itemId: radioA });
    expect(historialA[0]!.cobertura).toBeUndefined();
  });

  test("K. operacionCompania atribuye a Jason lo que hizo en B mientras cubría", async () => {
    const x = await e.cubrir(e.bosque, e.kBosque, T18, T06);
    await e.jornada("jason", e.alamos);
    en(T19);
    await e.jornada("jason", e.bosque);

    const filtros = { desde: "2026-10-10", hasta: "2026-10-11", granularidad: "dia" as const };
    const enB = await e.como("alicia").query(api.companias.operacion, {
      ...filtros,
      condominioId: e.bosque,
      guardiaUserId: e.jason,
    });
    // Antes de esta fase, nada de esto contaba: Jason no tiene asignación en B.
    expect(enB.guardas.map((g) => g.id)).toContain(e.jason);
    expect(enB.total).toMatchObject({ turnos: 1, inicios: 1, rondas: 2, novedades: 1, aportes: 1 });
    expect(enB.total.minuta).toBeGreaterThan(0);
    const fila = enB.porGuarda.find((g) => g.id === e.jason)!;
    expect(fila.enCobertura).toBeGreaterThan(0);
    // El turno abierto en B dice que es de una cobertura.
    expect(enB.activos[0]).toMatchObject({ cobertura: { coberturaId: x, inicio: T18, fin: T06 } });

    // En A, lo suyo de siempre, sin marca de cobertura.
    const enA = await e.como("alicia").query(api.companias.operacion, {
      ...filtros,
      condominioId: e.alamos,
      guardiaUserId: e.jason,
    });
    expect(enA.total.turnos).toBe(1);
    expect(enA.porGuarda.find((g) => g.id === e.jason)!.enCobertura).toBeUndefined();
    expect(enA.activos[0]!.cobertura).toBeUndefined();
  });

  test("L. historialDePersona distingue su asignación de su cobertura", async () => {
    const x = await e.cubrir(e.bosque, e.kBosque, T18, T06);
    const historial = await e.como("alicia").query(api.asignaciones.historialDePersona, { userId: e.jason });
    expect(historial.map((h) => ("tipo" in h ? h.tipo : "asignacion"))).toEqual(["cobertura", "asignacion"]);
    expect(historial[0]).toMatchObject({
      tipo: "cobertura",
      coberturaId: x,
      condominioId: e.bosque,
      inicio: T18,
      fin: T06,
      inhabilitada: false,
      estado: "programada",
    });
    // "¿Dónde estaba a las 19:00?": cubriendo B (y asignado a A).
    const a19 = await e.como("alicia").query(api.asignaciones.historialDePersona, { userId: e.jason, en: T19 });
    expect(a19.map((h) => h.condominioId).sort()).toEqual([e.alamos, e.bosque].sort());
    // "¿Y a las 17:00?": solo A.
    const a17 = await e.como("alicia").query(api.asignaciones.historialDePersona, { userId: e.jason, en: T17 });
    expect(a17.map((h) => h.condominioId)).toEqual([e.alamos]);
    // Inhabilitada: sale hasta el corte, y nada sobre por qué.
    en(T17 + 5 * HORA);
    await e.como("alicia").mutation(api.coberturas.inhabilitar, { coberturaId: x, motivo: "Motivo interno." });
    const cortada = await e.como("alicia").query(api.asignaciones.historialDePersona, { userId: e.jason });
    expect(cortada[0]).toMatchObject({ inhabilitada: true, fin: T17 + 5 * HORA, estado: "terminada" });
    expect(JSON.stringify(cortada)).not.toContain("Motivo interno");
  });

  test("M. lo registrado antes del sello sigue funcionando sin atribución", async () => {
    await e.cubrir(e.bosque, e.kBosque, T18, T06);
    // Un evento de B del 10/10 a las 20:00 escrito como antes: sin sello.
    en(T17 + 3 * HORA);
    await e.t.run((ctx) =>
      ctx.db.insert("minutaEventos", {
        condominioId: e.bosque,
        modulo: "minuta",
        tipo: "Anotación",
        unidad: "Portería",
        resumen: "Evento antiguo.",
        estado: "cerrado",
        actorUserId: e.jason,
        actorNombre: "Jason Valderrama",
        createdAt: T17 + 3 * HORA,
      }),
    );
    const minuta = await e.como("sergio").query(api.guardia.listMinuta, { condominioId: e.bosque });
    expect(minuta[0]!.cobertura).toBeUndefined();
    // No se adivina con fechas: no se le atribuye a nadie de la compañía.
    const operacion = await e.como("alicia").query(api.companias.operacion, {
      desde: "2026-10-10",
      hasta: "2026-10-10",
      condominioId: e.bosque,
      granularidad: "dia",
    });
    expect(operacion.total.minuta).toBe(0);
  });

  test("O. con dos coberturas, cada operación apunta a la suya", async () => {
    const x = await e.cubrir(e.bosque, e.kBosque, T18, T06);
    const y = await e.cubrir(e.cedros, e.kCedros, T18 + 24 * HORA, T06 + 24 * HORA);
    en(T19);
    const enB = await e.jornada("jason", e.bosque);
    en(T06 - MIN);
    await e.como("jason").mutation(api.guardia.cerrarTurno, { turnoId: enB.turnoId, ...CIERRE });
    en(T19 + 24 * HORA);
    const enC = await e.jornada("jason", e.cedros);

    expect(await sello("guardiaTurnos", enB.turnoId)).toBe(x);
    expect(await sello("guardiaTurnos", enC.turnoId)).toBe(y);
    expect(new Set(todos(await sellosDe(e.jason, e.bosque)))).toEqual(new Set([x]));
    expect(new Set(todos(await sellosDe(e.jason, e.cedros)))).toEqual(new Set([y]));
  });

  test("el cliente no puede mandar el sello", async () => {
    await e.cubrir(e.bosque, e.kBosque, T18, T06);
    en(T19);
    const otra = await e.cubrir(e.cedros, e.kCedros, T18 + 24 * HORA, T06 + 24 * HORA);
    await expect(
      e.como("jason").mutation(api.guardia.iniciarTurno, {
        condominioId: e.bosque,
        checklist: CHECKLIST,
        coberturaId: otra,
      } as never),
    ).rejects.toThrow();
  });
});
