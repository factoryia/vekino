import { test, expect, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest } from "convex-test";
import betterAuthTest from "@convex-dev/better-auth/test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { hoyColombia, sumarDias } from "../convex/lib/inasistencias";
import { diaDeLaSemana } from "../convex/lib/horariosGuarda";

const modules = import.meta.glob("../convex/**/*.ts");

/**
 * DISPONIBILIDAD DE LOS GUARDAS, CALCULADA.
 *
 * La regla vive en `lib/disponibilidad.ts` y se prueba con node:test; aqui se
 * fija lo que depende de la base: que las consultas lean lo que deben (todos
 * los horarios del guarda, sus inasistencias, nada de asignaciones), que
 * respeten el alcance, que no expongan el motivo escrito de una inasistencia
 * y que no escriban nada.
 *
 * Las fechas se calculan desde hoy: el proximo lunes, martes, etc.
 */

const DIA = 24 * 60 * 60 * 1000;
/* Reloj fijo: miercoles 7 de octubre de 2026, 10:00 en Colombia. Las ventanas se
 * cortan por dias civiles y los horarios rigen desde una fecha.
 * Con el reloj real, HOY salia de la hora a la que se cargaba el fichero y el
 * servidor miraba la hora de cada prueba: cerca de la medianoche de Colombia
 * los dos no coincidian. Las fechas siguen siendo relativas a HOY. */
const AHORA = Date.parse("2026-10-07T15:00:00Z");
beforeEach(() => {
  vi.setSystemTime(AHORA);
});
afterEach(() => vi.useRealTimers());
const HOY = hoyColombia(AHORA);
const fecha = (dias: number) => sumarDias(HOY, dias);
function proximo(dia: number): string {
  for (let i = 1; i <= 7; i++) if (diaDeLaSemana(fecha(i)) === dia) return fecha(i);
  throw new Error("imposible");
}
const LUNES = proximo(1);
const MARTES = sumarDias(LUNES, 1);
const MIERCOLES = sumarDias(LUNES, 2);
const JUEVES = sumarDias(LUNES, 3);
const VIERNES = sumarDias(LUNES, 4);

const horas = (inicioLocal: string, finLocal: string) => ({
  diaCompleto: false as const,
  inicioLocal,
  finLocal,
});

type Bloque = { dia: number; horaInicio: string; horaFin: string };
const b = (dia: number, horaInicio: string, horaFin: string): Bloque => ({ dia, horaInicio, horaFin });

const MOTIVO_SENSIBLE = "Diagnostico confidencial de la EPS";

async function montar() {
  const t = convexTest(schema, modules);
  betterAuthTest.register(t);

  const ahora = Date.now();
  const desde = ahora - 60 * DIA;

  const ids = await t.run(async (ctx) => {
    const usuario = (authId: string, name: string, extra = {}) =>
      ctx.db.insert("users", {
        name,
        email: `${authId}@vekino.test`,
        emailVerified: true,
        active: true,
        authId,
        createdAt: ahora,
        updatedAt: ahora,
        ...extra,
      });
    const conjunto = (name: string) =>
      ctx.db.insert("condominios", {
        name,
        activeModules: [],
        isActive: true,
        createdAt: ahora,
        updatedAt: ahora,
      });
    const compania = (nombre: string) =>
      ctx.db.insert("companiasSeguridad", {
        nombre,
        estado: "activa",
        createdAt: ahora,
        updatedAt: ahora,
      });

    const superadmin = await usuario("super", "Super", { platformRole: "superadmin" as const });
    const alamos = await conjunto("Conjunto Alamos");
    const bosque = await conjunto("Conjunto Bosque");
    const andina = await compania("Seguridad Andina");
    const rival = await compania("Seguridad Rival");

    const contrato = (condominioId: Id<"condominios">) =>
      ctx.db.insert("companiaContratos", {
        companiaId: andina,
        condominioId,
        vigenciaDesde: desde,
        creadoPorUserId: superadmin,
        createdAt: ahora,
        updatedAt: ahora,
      });
    const kAlamos = await contrato(alamos);
    const kBosque = await contrato(bosque);

    const miembro = (
      userId: Id<"users">,
      companiaId: Id<"companiasSeguridad">,
      rol: "guardia" | "supervisor" | "admin_compania",
    ) =>
      ctx.db.insert("companiaMiembros", {
        userId,
        companiaId,
        roles: [rol],
        isActive: true,
        createdAt: ahora,
        updatedAt: ahora,
      });
    const asignacion = (
      contratoId: Id<"companiaContratos">,
      condominioId: Id<"condominios">,
      userId: Id<"users">,
      companiaMiembroId: Id<"companiaMiembros">,
      rol: "guardia" | "supervisor",
    ) =>
      ctx.db.insert("asignaciones", {
        contratoId,
        companiaMiembroId,
        userId,
        condominioId,
        companiaId: andina,
        rol,
        vigenciaDesde: desde,
        creadoPorUserId: superadmin,
        createdAt: ahora,
      });

    const alicia = await usuario("alicia", "Alicia Admin");
    await miembro(alicia, andina, "admin_compania");

    const sofia = await usuario("sofia", "Sofia Supervisora");
    const mSofia = await miembro(sofia, andina, "supervisor");
    await asignacion(kAlamos, alamos, sofia, mSofia, "supervisor");

    // Jason: guarda en Alamos y en Bosque.
    const jason = await usuario("jason", "Jason Guarda");
    const mJason = await miembro(jason, andina, "guardia");
    await asignacion(kAlamos, alamos, jason, mJason, "guardia");
    await asignacion(kBosque, bosque, jason, mJason, "guardia");

    // Lucas: guarda en Alamos, sin ningun horario registrado.
    const lucas = await usuario("lucas", "Lucas Sinhorario");
    const mLucas = await miembro(lucas, andina, "guardia");
    await asignacion(kAlamos, alamos, lucas, mLucas, "guardia");

    // Bruno: guarda solo en Bosque, fuera del alcance de Sofia.
    const bruno = await usuario("bruno", "Bruno Bosque");
    const mBruno = await miembro(bruno, andina, "guardia");
    await asignacion(kBosque, bosque, bruno, mBruno, "guardia");

    // Gabi: guarda sin asignacion.
    const gabi = await usuario("gabi", "Gabi Sinpuesto");
    await miembro(gabi, andina, "guardia");

    const ramon = await usuario("ramon", "Ramon Rival");
    await miembro(ramon, rival, "admin_compania");

    return { alamos, bosque, andina, sofia, jason, lucas, bruno, gabi };
  });

  const como = (authId: string) => t.withIdentity({ subject: authId });

  const horario = (
    userId: Id<"users">,
    bloques: Bloque[],
    extra: Partial<{ condominioId: Id<"condominios">; fechaInicio: string; fechaFin: string }> = {},
  ) =>
    como("alicia").mutation(api.horariosGuarda.crear, {
      companiaId: ids.andina,
      userId,
      condominioId: extra.condominioId,
      fechaInicio: extra.fechaInicio ?? fecha(-7),
      fechaFin: extra.fechaFin,
      bloques,
    });

  const inasistencia = (
    userId: Id<"users">,
    ventana: ReturnType<typeof horas>,
    extra: Partial<{ tipo: "incapacidad" | "vacaciones"; motivo: string }> = {},
  ) =>
    como("alicia").mutation(api.inasistencias.crear, {
      companiaId: ids.andina,
      userId,
      tipo: extra.tipo ?? "vacaciones",
      motivo: extra.motivo,
      ventana,
    });

  const deGuarda = (
    userId: Id<"users">,
    ventana: ReturnType<typeof horas> | { diaCompleto: true; fechaInicio: string; fechaFin: string },
    authId = "alicia",
  ) =>
    como(authId).query(api.disponibilidad.deGuarda, {
      companiaId: ids.andina,
      userId,
      ventana,
    });

  const masiva = (ventana: ReturnType<typeof horas>, authId = "alicia") =>
    como(authId).query(api.disponibilidad.deGuardasEnAlcance, {
      companiaId: ids.andina,
      ventana,
    });

  return { t, ...ids, como, horario, inasistencia, deGuarda, masiva };
}

type Escenario = Awaited<ReturnType<typeof montar>>;

// ─────────────────────────────────────────────────────────────
describe("consulta individual", () => {
  let e: Escenario;
  beforeEach(async () => {
    e = await montar();
  });

  test("A y B: libre segun su horario, u ocupado con el bloque que choca", async () => {
    await e.horario(e.jason, [b(1, "06:00", "18:00")], { condominioId: e.alamos });
    const libre = await e.deGuarda(e.jason, horas(`${LUNES}T18:00`, `${LUNES}T22:00`));
    expect(libre.estado).toBe("disponible");
    expect(libre.horariosVigentes).toHaveLength(1);

    const ocupado = await e.deGuarda(e.jason, horas(`${LUNES}T14:00`, `${LUNES}T22:00`));
    expect(ocupado.estado).toBe("ocupado");
    expect(ocupado.motivos).toMatchObject([
      {
        tipo: "horario",
        condominioNombre: "Conjunto Alamos",
        fecha: LUNES,
        horaInicio: "06:00",
        horaFin: "18:00",
      },
    ]);
  });

  test("C: un horario en Alamos ocupa aunque la cobertura sea para Bosque", async () => {
    await e.horario(e.jason, [b(4, "18:00", "06:00")], { condominioId: e.alamos });
    const r = await e.deGuarda(e.jason, horas(`${JUEVES}T18:00`, `${VIERNES}T06:00`));
    expect(r.estado).toBe("ocupado");
    expect(r.motivos[0]).toMatchObject({ tipo: "horario", condominioNombre: "Conjunto Alamos" });
  });

  test("D: un horario general ocupa", async () => {
    await e.horario(e.gabi, [b(4, "08:00", "20:00")]);
    const r = await e.deGuarda(e.gabi, horas(`${JUEVES}T18:00`, `${VIERNES}T06:00`));
    expect(r.estado).toBe("ocupado");
    expect(r.motivos[0]).toMatchObject({ tipo: "horario", condominioId: null, condominioNombre: null });
  });

  test("E y L: con asignaciones pero sin horario, desconocido: la asignacion no cuenta", async () => {
    const r = await e.deGuarda(e.lucas, horas(`${LUNES}T14:00`, `${LUNES}T22:00`));
    expect(r.estado).toBe("desconocido");
    expect(r.motivos).toEqual([{ tipo: "sin_horario", fechas: [LUNES] }]);
  });

  test("F: el dia sin bloques de un horario vigente es libre", async () => {
    await e.horario(e.jason, [b(1, "06:00", "18:00"), b(2, "06:00", "18:00")]);
    const r = await e.deGuarda(e.jason, horas(`${MIERCOLES}T18:00`, `${JUEVES}T06:00`));
    expect(r.estado).toBe("disponible");
  });

  test("G y J: la inasistencia manda, y no viaja su motivo escrito", async () => {
    await e.horario(e.jason, [b(1, "06:00", "18:00")], { condominioId: e.alamos });
    await e.inasistencia(e.jason, horas(`${LUNES}T00:00`, `${MARTES}T00:00`), {
      tipo: "incapacidad",
      motivo: MOTIVO_SENSIBLE,
    });
    const r = await e.deGuarda(e.jason, horas(`${LUNES}T14:00`, `${LUNES}T22:00`));
    expect(r.estado).toBe("no_disponible");
    expect(r.motivos.map((m) => m.tipo)).toEqual(["inasistencia", "horario"]);
    expect(r.motivos[0]).toMatchObject({ tipo: "inasistencia", categoria: "incapacidad" });
    expect(JSON.stringify(r)).not.toContain(MOTIVO_SENSIBLE);
  });

  test("H: anularla devuelve la disponibilidad", async () => {
    await e.horario(e.jason, [b(2, "06:00", "18:00")]);
    const id = await e.inasistencia(e.jason, horas(`${LUNES}T00:00`, `${MARTES}T00:00`));
    expect((await e.deGuarda(e.jason, horas(`${LUNES}T14:00`, `${LUNES}T22:00`))).estado).toBe(
      "no_disponible",
    );
    await e.como("alicia").mutation(api.inasistencias.anular, { inasistenciaId: id });
    expect((await e.deGuarda(e.jason, horas(`${LUNES}T14:00`, `${LUNES}T22:00`))).estado).toBe(
      "disponible",
    );
  });

  test("I: un cruce parcial basta, de horario o de inasistencia", async () => {
    await e.horario(e.jason, [b(4, "22:00", "06:00")], { condominioId: e.alamos });
    expect(
      (await e.deGuarda(e.jason, horas(`${JUEVES}T18:00`, `${VIERNES}T06:00`))).estado,
    ).toBe("ocupado");
    await e.horario(e.gabi, [b(4, "06:00", "08:00")]);
    await e.inasistencia(e.gabi, horas(`${JUEVES}T22:00`, `${VIERNES}T06:00`));
    expect((await e.deGuarda(e.gabi, horas(`${JUEVES}T18:00`, `${VIERNES}T06:00`))).estado).toBe(
      "no_disponible",
    );
  });

  test("K: con horarios en varios conjuntos se evalua contra todos", async () => {
    await e.horario(e.jason, [b(1, "06:00", "18:00")], { condominioId: e.alamos });
    await e.horario(e.jason, [b(3, "18:00", "06:00")], { condominioId: e.bosque });
    const r = await e.deGuarda(e.jason, horas(`${MIERCOLES}T20:00`, `${MIERCOLES}T23:00`));
    expect(r.estado).toBe("ocupado");
    expect(r.motivos[0]).toMatchObject({ condominioNombre: "Conjunto Bosque" });
    expect(r.horariosVigentes).toHaveLength(2);
  });

  test("M: sin asignacion, el horario decide igual", async () => {
    await e.horario(e.gabi, [b(1, "06:00", "18:00")]);
    expect((await e.deGuarda(e.gabi, horas(`${LUNES}T18:00`, `${LUNES}T22:00`))).estado).toBe(
      "disponible",
    );
    expect((await e.deGuarda(e.gabi, horas(`${LUNES}T10:00`, `${LUNES}T12:00`))).estado).toBe(
      "ocupado",
    );
  });

  test("N y O: fechas pasadas y futuras se evaluan con lo que regia o va a regir", async () => {
    const pasado = fecha(-20);
    await e.horario(e.gabi, [b(diaDeLaSemana(pasado), "06:00", "18:00")], {
      fechaInicio: fecha(-30),
      fechaFin: fecha(-10),
    });
    expect((await e.deGuarda(e.gabi, horas(`${pasado}T10:00`, `${pasado}T12:00`))).estado).toBe(
      "ocupado",
    );
    expect((await e.deGuarda(e.gabi, horas(`${LUNES}T10:00`, `${LUNES}T12:00`))).estado).toBe(
      "desconocido",
    );

    const futuro = fecha(40);
    await e.horario(e.lucas, [b(diaDeLaSemana(futuro), "06:00", "18:00")], {
      fechaInicio: fecha(35),
    });
    expect((await e.deGuarda(e.lucas, horas(`${futuro}T10:00`, `${futuro}T12:00`))).estado).toBe(
      "ocupado",
    );
  });

  test("un dia completo y el tope de la ventana", async () => {
    const r = await e.deGuarda(e.lucas, { diaCompleto: true, fechaInicio: LUNES, fechaFin: LUNES });
    expect(r.ventana.fin - r.ventana.inicio).toBe(DIA);
    await expect(
      e.deGuarda(e.lucas, { diaCompleto: true, fechaInicio: fecha(1), fechaFin: fecha(40) }),
    ).rejects.toThrow("Consulta una ventana de hasta 31 días.");
  });
});

// ─────────────────────────────────────────────────────────────
describe("consulta masiva y alcance", () => {
  let e: Escenario;
  const ventana = horas(`${LUNES}T14:00`, `${LUNES}T22:00`);
  beforeEach(async () => {
    e = await montar();
    await e.horario(e.jason, [b(1, "06:00", "18:00")], { condominioId: e.alamos });
    await e.horario(e.gabi, [b(2, "06:00", "18:00")]);
    await e.inasistencia(e.lucas, horas(`${LUNES}T00:00`, `${MARTES}T00:00`), {
      tipo: "incapacidad",
      motivo: MOTIVO_SENSIBLE,
    });
  });

  test("el administrador ve a todos sus guardas, primero quien puede cubrir", async () => {
    const r = await e.masiva(ventana);
    expect(r.guardas.map((g) => [g.nombre, g.estado])).toEqual([
      ["Gabi Sinpuesto", "disponible"],
      ["Bruno Bosque", "desconocido"],
      ["Jason Guarda", "ocupado"],
      ["Lucas Sinhorario", "no_disponible"],
    ]);
    expect(JSON.stringify(r)).not.toContain(MOTIVO_SENSIBLE);
  });

  test("el supervisor solo ve a los guardas de sus conjuntos", async () => {
    const r = await e.masiva(ventana, "sofia");
    expect(r.guardas.map((g) => g.nombre)).toEqual(["Jason Guarda", "Lucas Sinhorario"]);
    await expect(e.deGuarda(e.bruno, ventana, "sofia")).rejects.toThrow(
      "No tiene permiso para esta operación (seguridad.horarios, seguridad.inasistencias).",
    );
  });

  test("el guarda no consulta, ni otra compania", async () => {
    await expect(e.masiva(ventana, "jason")).rejects.toThrow("No tiene permiso para esta operación");
    await expect(e.deGuarda(e.jason, ventana, "jason")).rejects.toThrow(
      "No tiene permiso para esta operación",
    );
    await expect(e.masiva(ventana, "ramon")).rejects.toThrow("No pertenece a esta compañía.");
  });

  test("solo se evalua a guardas", async () => {
    await expect(e.deGuarda(e.sofia, ventana)).rejects.toThrow(
      "Solo se evalúa la disponibilidad de guardas.",
    );
  });

  test("consultar no escribe nada", async () => {
    const foto = () =>
      e.t.run(async (ctx) => ({
        asignaciones: await ctx.db.query("asignaciones").collect(),
        memberships: await ctx.db.query("memberships").collect(),
        contratos: await ctx.db.query("companiaContratos").collect(),
        horarios: await ctx.db.query("horariosGuarda").collect(),
        inasistencias: await ctx.db.query("inasistencias").collect(),
        turnos: await ctx.db.query("guardiaTurnos").collect(),
      }));
    const antes = await foto();
    await e.masiva(ventana);
    await e.deGuarda(e.jason, ventana);
    expect(await foto()).toEqual(antes);
  });
});
