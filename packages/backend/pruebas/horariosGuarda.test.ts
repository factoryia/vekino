import { test, expect, describe, beforeEach } from "vitest";
import { convexTest } from "convex-test";
import betterAuthTest from "@convex-dev/better-auth/test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { hoyColombia, sumarDias } from "../convex/lib/inasistencias";

const modules = import.meta.glob("../convex/**/*.ts");

/**
 * HORARIO PERMANENTE DE LOS GUARDAS.
 *
 * Fija el registro —quien puede tenerlo, los bloques, la vigencia, los
 * choques, la finalizacion sin perder historial— y que es informativo: no
 * toca asignaciones, membresias, inasistencias, turnos ni permisos.
 *
 * Las fechas se calculan desde hoy (hora de Colombia) porque finalizar no
 * admite fechas anteriores a ayer: con fechas fijas la prueba caducaria.
 */

const DIA = 24 * 60 * 60 * 1000;
const HOY = hoyColombia();
const fecha = (dias: number) => sumarDias(HOY, dias);

const CHECKLIST = [
  { item: "Radio", obligatorio: true, cantidadEsperada: 1, cantidadEncontrada: 1, estadoOk: true },
];

type Bloque = { dia: number; horaInicio: string; horaFin: string };
const b = (dia: number, horaInicio: string, horaFin: string): Bloque => ({
  dia,
  horaInicio,
  horaFin,
});
/** Lunes y martes 06-18, miercoles libre. */
const SEMANA_BASICA = [b(1, "06:00", "18:00"), b(2, "06:00", "18:00")];

async function montar() {
  const t = convexTest(schema, modules);
  betterAuthTest.register(t);

  const ahora = Date.now();
  const desde = ahora - 30 * DIA;

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

    const superadmin = await usuario("super", "Super", {
      platformRole: "superadmin" as const,
    });
    const alamos = await conjunto("Conjunto Alamos");
    const bosque = await conjunto("Conjunto Bosque");
    const cedros = await conjunto("Conjunto Cedros");
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
      isActive = true,
    ) =>
      ctx.db.insert("companiaMiembros", {
        userId,
        companiaId,
        roles: [rol],
        isActive,
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

    const jason = await usuario("jason", "Jason Guarda");
    const mJason = await miembro(jason, andina, "guardia");
    await asignacion(kAlamos, alamos, jason, mJason, "guardia");
    await asignacion(kBosque, bosque, jason, mJason, "guardia");

    const bruno = await usuario("bruno", "Bruno Bosque");
    const mBruno = await miembro(bruno, andina, "guardia");
    await asignacion(kBosque, bosque, bruno, mBruno, "guardia");

    const gabi = await usuario("gabi", "Gabi Sinpuesto");
    await miembro(gabi, andina, "guardia");

    const bea = await usuario("bea", "Bea Baja");
    await miembro(bea, andina, "guardia", false);

    const ramiro = await usuario("ramiro", "Ramiro Rival");
    await miembro(ramiro, rival, "guardia");
    const ramon = await usuario("ramon", "Ramon Rival");
    await miembro(ramon, rival, "admin_compania");

    return { alamos, bosque, cedros, andina, alicia, sofia, jason, bruno, gabi, bea, ramiro };
  });

  const como = (authId: string) => t.withIdentity({ subject: authId });

  const registrar = (
    authId: string,
    userId: Id<"users">,
    extra: Partial<{
      condominioId: Id<"condominios">;
      fechaInicio: string;
      fechaFin: string;
      bloques: Bloque[];
    }> = {},
  ) =>
    como(authId).mutation(api.horariosGuarda.crear, {
      companiaId: ids.andina,
      userId,
      condominioId: extra.condominioId,
      fechaInicio: extra.fechaInicio ?? fecha(0),
      fechaFin: "fechaFin" in extra ? extra.fechaFin : fecha(30),
      bloques: extra.bloques ?? SEMANA_BASICA,
    });

  const detalle = (horarioId: Id<"horariosGuarda">) =>
    como("alicia").query(api.horariosGuarda.detalle, { horarioId });

  const historial = (userId: Id<"users">, authId = "alicia") =>
    como(authId).query(api.horariosGuarda.historialDeGuarda, {
      companiaId: ids.andina,
      userId,
    });

  return { t, ...ids, plataforma: como("super"), como, registrar, detalle, historial };
}

type Escenario = Awaited<ReturnType<typeof montar>>;

// ─────────────────────────────────────────────────────────────
describe("A a C: el patron semanal", () => {
  let e: Escenario;
  beforeEach(async () => {
    e = await montar();
  });

  test("A: lunes y martes 06-18, miercoles libre", async () => {
    const id = await e.registrar("alicia", e.jason, { condominioId: e.alamos });
    const d = await e.detalle(id);
    expect(d).toMatchObject({
      userId: e.jason,
      guardaNombre: "Jason Guarda",
      condominioId: e.alamos,
      condominioNombre: "Conjunto Alamos",
      fechaInicio: fecha(0),
      fechaFin: fecha(30),
      ultimoDia: fecha(30),
      estado: "vigente",
      creadoPorNombre: "Alicia Admin",
      terminaEl: null,
    });
    // Ningun bloque el miercoles: es libre, no hay registro de "dia libre".
    expect(d!.bloques).toEqual(SEMANA_BASICA);
    const vigentes = await e.como("alicia").query(api.horariosGuarda.vigentesDeGuarda, {
      companiaId: e.andina,
      userId: e.jason,
    });
    expect(vigentes.map((h) => h._id)).toEqual([id]);
  });

  test("B: 18:00-06:00 cruza la medianoche hacia el dia siguiente", async () => {
    const id = await e.registrar("alicia", e.jason, {
      condominioId: e.alamos,
      bloques: [b(4, "18:00", "06:00")],
    });
    expect((await e.detalle(id))!.bloques).toEqual([b(4, "18:00", "06:00")]);
    // Prueba de que el jueves 18-06 llega al viernes: un viernes 05-09 en el
    // mismo conjunto choca, y uno de 06-09 no.
    await expect(
      e.registrar("alicia", e.jason, {
        condominioId: e.alamos,
        bloques: [b(5, "05:00", "09:00")],
      }),
    ).rejects.toThrow("se cruza con estos bloques");
    await expect(
      e.registrar("alicia", e.jason, {
        condominioId: e.alamos,
        bloques: [b(5, "06:00", "09:00")],
      }),
    ).resolves.toBeTruthy();
  });

  test("C: un dia puede tener varios bloques", async () => {
    const bloques = [b(1, "06:00", "10:00"), b(1, "14:00", "18:00")];
    const id = await e.registrar("alicia", e.jason, { bloques });
    expect((await e.detalle(id))!.bloques).toEqual(bloques);
  });
});

// ─────────────────────────────────────────────────────────────
describe("D a F: horario sin asignacion, con varias y sin conjunto", () => {
  let e: Escenario;
  beforeEach(async () => {
    e = await montar();
  });

  test("D: un guarda sin asignacion puede tener horario", async () => {
    await expect(e.registrar("alicia", e.gabi)).resolves.toBeTruthy();
    await expect(
      e.registrar("alicia", e.gabi, { condominioId: e.alamos }),
    ).resolves.toBeTruthy();
  });

  test("E: con dos asignaciones tiene un horario por conjunto y ninguno pisa al otro", async () => {
    const enAlamos = await e.registrar("alicia", e.jason, { condominioId: e.alamos });
    const enBosque = await e.registrar("alicia", e.jason, {
      condominioId: e.bosque,
      bloques: [b(3, "06:00", "18:00")],
    });
    const h = await e.historial(e.jason);
    expect(h.map((x) => x._id).sort()).toEqual([enAlamos, enBosque].sort());
    expect((await e.detalle(enAlamos))!.bloques).toEqual(SEMANA_BASICA);
  });

  test("F: sin conjunto es un horario general valido", async () => {
    const id = await e.registrar("alicia", e.jason);
    const d = await e.detalle(id);
    expect(d!.condominioId).toBeNull();
    expect(d!.condominioNombre).toBeNull();
  });

  test("no se inventa una relacion con un conjunto sin contrato", async () => {
    await expect(
      e.registrar("alicia", e.jason, { condominioId: e.cedros }),
    ).rejects.toThrow("La compañía no tiene contrato con ese conjunto.");
  });
});

// ─────────────────────────────────────────────────────────────
describe("G: fechas y bloques invalidos", () => {
  let e: Escenario;
  beforeEach(async () => {
    e = await montar();
  });

  test("el fin antes del inicio se rechaza", async () => {
    await expect(
      e.registrar("alicia", e.jason, { fechaInicio: fecha(10), fechaFin: fecha(5) }),
    ).rejects.toThrow("La fecha final no puede ser anterior a la inicial.");
    await expect(
      e.registrar("alicia", e.jason, { fechaInicio: "2026-02-30" }),
    ).rejects.toThrow("El rango de fechas no es válido.");
  });

  test("bloques invalidos se rechazan", async () => {
    await expect(e.registrar("alicia", e.jason, { bloques: [] })).rejects.toThrow(
      "Agrega al menos un bloque",
    );
    await expect(
      e.registrar("alicia", e.jason, { bloques: [b(7, "06:00", "18:00")] }),
    ).rejects.toThrow("Día de la semana inválido.");
    await expect(
      e.registrar("alicia", e.jason, { bloques: [b(1, "25:00", "18:00")] }),
    ).rejects.toThrow("Formato de hora inválido");
    await expect(
      e.registrar("alicia", e.jason, {
        bloques: [b(1, "08:00", "18:00"), b(1, "17:00", "22:00")],
      }),
    ).rejects.toThrow("Dos bloques del horario se pisan.");
  });

  test("sin fecha de fin es indefinido", async () => {
    const id = await e.registrar("alicia", e.jason, { fechaFin: undefined });
    const d = await e.detalle(id);
    expect(d!.fechaFin).toBeNull();
    expect(d!.ultimoDia).toBeNull();
    expect(d!.estado).toBe("vigente");
  });
});

// ─────────────────────────────────────────────────────────────
describe("H: choques de planificacion", () => {
  let e: Escenario;
  beforeEach(async () => {
    e = await montar();
    await e.registrar("alicia", e.jason, {
      condominioId: e.alamos,
      bloques: [b(1, "08:00", "18:00")],
    });
  });

  test("mismo conjunto, mismas fechas, horas que se pisan: se rechaza", async () => {
    await expect(
      e.registrar("alicia", e.jason, {
        condominioId: e.alamos,
        fechaInicio: fecha(5),
        bloques: [b(1, "17:00", "22:00")],
      }),
    ).rejects.toThrow("ya tiene un horario en ese conjunto que se cruza");
  });

  test("seguido en la hora, o en otras fechas: se permite", async () => {
    await expect(
      e.registrar("alicia", e.jason, {
        condominioId: e.alamos,
        bloques: [b(1, "18:00", "06:00")],
      }),
    ).resolves.toBeTruthy();
    await expect(
      e.registrar("alicia", e.jason, {
        condominioId: e.alamos,
        fechaInicio: fecha(31),
        fechaFin: fecha(60),
        bloques: [b(1, "08:00", "18:00")],
      }),
    ).resolves.toBeTruthy();
  });

  test("otro conjunto a la misma hora: no se rechaza (no es disponibilidad)", async () => {
    await expect(
      e.registrar("alicia", e.jason, {
        condominioId: e.bosque,
        bloques: [b(1, "17:00", "22:00")],
      }),
    ).resolves.toBeTruthy();
  });

  test("dos generales que se pisan: se rechaza", async () => {
    await e.registrar("alicia", e.jason, { bloques: [b(2, "08:00", "18:00")] });
    await expect(
      e.registrar("alicia", e.jason, { bloques: [b(2, "12:00", "20:00")] }),
    ).rejects.toThrow("ya tiene un horario general que se cruza");
  });

  test("otro guarda a la misma hora: no hay choque", async () => {
    await expect(
      e.registrar("alicia", e.bruno, {
        condominioId: e.alamos,
        bloques: [b(1, "08:00", "18:00")],
      }),
    ).resolves.toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────
describe("I y L: finalizar sin perder historial", () => {
  let e: Escenario;
  beforeEach(async () => {
    e = await montar();
  });

  test("I: finalizar lo recorta, deja rastro y no lo borra", async () => {
    const id = await e.registrar("alicia", e.jason, { condominioId: e.alamos });
    const r = await e.como("alicia").mutation(api.horariosGuarda.finalizar, {
      horarioId: id,
      ultimoDia: fecha(10),
    });
    expect(r).toEqual({ ok: true, yaEstaba: false });
    const d = await e.detalle(id);
    expect(d).toMatchObject({
      fechaFin: fecha(30), // lo planificado no se reescribe
      terminaEl: fecha(10),
      ultimoDia: fecha(10),
      terminadoPorNombre: "Alicia Admin",
    });
    expect(d!.terminadoEn).toBeGreaterThan(0);
    expect((await e.historial(e.jason)).map((h) => h._id)).toEqual([id]);
  });

  test("I: finalizar otra vez no reescribe el corte", async () => {
    const id = await e.registrar("alicia", e.jason);
    await e.como("alicia").mutation(api.horariosGuarda.finalizar, {
      horarioId: id,
      ultimoDia: fecha(5),
    });
    const antes = await e.t.run(async (ctx) => await ctx.db.get(id));
    const r = await e.como("alicia").mutation(api.horariosGuarda.finalizar, {
      horarioId: id,
      ultimoDia: fecha(20),
    });
    expect(r).toEqual({ ok: true, yaEstaba: true });
    expect(await e.t.run(async (ctx) => await ctx.db.get(id))).toEqual(antes);
  });

  test("I: no se reescriben dias pasados ni se alarga lo planificado", async () => {
    const id = await e.registrar("alicia", e.jason, { fechaInicio: fecha(-20) });
    await expect(
      e.como("alicia").mutation(api.horariosGuarda.finalizar, {
        horarioId: id,
        ultimoDia: fecha(-5),
      }),
    ).rejects.toThrow("anterior a ayer");
    await expect(
      e.como("alicia").mutation(api.horariosGuarda.finalizar, {
        horarioId: id,
        ultimoDia: fecha(40),
      }),
    ).rejects.toThrow("Finalizar no puede alargar el horario.");
  });

  test("I: uno que ya termino por fecha no se finaliza", async () => {
    const id = await e.registrar("alicia", e.jason, {
      fechaInicio: fecha(-20),
      fechaFin: fecha(-10),
    });
    expect((await e.detalle(id))!.estado).toBe("terminado");
    await expect(
      e.como("alicia").mutation(api.horariosGuarda.finalizar, {
        horarioId: id,
        ultimoDia: fecha(0),
      }),
    ).rejects.toThrow("Ese horario ya terminó");
  });

  test("L: cambiar la planificacion es finalizar y registrar otro, y el anterior se sigue viendo", async () => {
    const octubre = await e.registrar("alicia", e.jason, {
      condominioId: e.alamos,
      fechaInicio: fecha(-20),
      fechaFin: fecha(30),
      bloques: [b(1, "06:00", "18:00")],
    });
    await e.como("alicia").mutation(api.horariosGuarda.finalizar, {
      horarioId: octubre,
      ultimoDia: fecha(-1),
    });
    const nuevo = await e.registrar("alicia", e.jason, {
      condominioId: e.alamos,
      fechaInicio: fecha(0),
      fechaFin: fecha(30),
      bloques: [b(1, "18:00", "06:00")],
    });

    const h = await e.historial(e.jason);
    expect(h.map((x) => [x._id, x.estado])).toEqual([
      [nuevo, "vigente"],
      [octubre, "terminado"],
    ]);
    const antes = await e.como("alicia").query(api.horariosGuarda.vigentesDeGuarda, {
      companiaId: e.andina,
      userId: e.jason,
      fecha: fecha(-10),
    });
    expect(antes.map((x) => x._id)).toEqual([octubre]);
    const hoy = await e.como("alicia").query(api.horariosGuarda.vigentesDeGuarda, {
      companiaId: e.andina,
      userId: e.jason,
    });
    expect(hoy.map((x) => x._id)).toEqual([nuevo]);
  });

  test("el rango trae los horarios cuya vigencia se cruza con el", async () => {
    const actual = await e.registrar("alicia", e.jason, { fechaFin: fecha(10) });
    await e.registrar("alicia", e.jason, {
      fechaInicio: fecha(40),
      fechaFin: fecha(50),
    });
    const lista = await e.como("alicia").query(api.horariosGuarda.deCompaniaEnRango, {
      companiaId: e.andina,
      desde: fecha(5),
      hasta: fecha(20),
    });
    expect(lista.map((x) => x._id)).toEqual([actual]);
  });
});

// ─────────────────────────────────────────────────────────────
describe("J y K: el horario es independiente", () => {
  let e: Escenario;
  beforeEach(async () => {
    e = await montar();
  });

  test("J: registrar una inasistencia no toca el horario", async () => {
    const id = await e.registrar("alicia", e.jason, { condominioId: e.alamos });
    const antes = await e.t.run(async (ctx) => await ctx.db.get(id));
    await e.como("alicia").mutation(api.inasistencias.crear, {
      companiaId: e.andina,
      userId: e.jason,
      tipo: "incapacidad",
      ventana: { diaCompleto: true, fechaInicio: fecha(1), fechaFin: fecha(3) },
    });
    expect(await e.t.run(async (ctx) => await ctx.db.get(id))).toEqual(antes);
    // Y el horario sigue rigiendo esos dias: los dos coexisten.
    const vigentes = await e.como("alicia").query(api.horariosGuarda.vigentesDeGuarda, {
      companiaId: e.andina,
      userId: e.jason,
      fecha: fecha(2),
    });
    expect(vigentes.map((h) => h._id)).toEqual([id]);
  });

  test("K: no toca asignaciones, membresias, inasistencias, turnos ni permisos", async () => {
    const turnoId = await e.como("jason").mutation(api.guardia.iniciarTurno, {
      condominioId: e.alamos,
      checklist: CHECKLIST,
    });
    const foto = () =>
      e.t.run(async (ctx) => ({
        asignaciones: await ctx.db.query("asignaciones").collect(),
        memberships: await ctx.db.query("memberships").collect(),
        miembros: await ctx.db.query("companiaMiembros").collect(),
        contratos: await ctx.db.query("companiaContratos").collect(),
        inasistencias: await ctx.db.query("inasistencias").collect(),
        turnos: await ctx.db.query("guardiaTurnos").collect(),
      }));
    const acceso = () =>
      e.como("jason").query(api.asignaciones.miAcceso, { condominioId: e.alamos });
    const antes = await foto();
    const accesoAntes = await acceso();

    // Un horario que NO incluye este momento: solo empieza el mes que viene.
    await e.registrar("alicia", e.jason, {
      condominioId: e.alamos,
      fechaInicio: fecha(30),
      fechaFin: fecha(60),
    });
    // Y otro en Bosque que si rige hoy.
    await e.registrar("alicia", e.jason, { condominioId: e.bosque });

    expect(await foto()).toEqual(antes);
    expect(await acceso()).toEqual(accesoAntes);
    // Trabajar fuera de lo planificado no bloquea nada.
    const home = await e.como("jason").query(api.guardia.home, {
      condominioId: e.alamos,
    });
    expect(home.allowed).toBe(true);
    await expect(
      e.como("jason").query(api.guardia.turnoActivo, { condominioId: e.alamos }),
    ).resolves.toMatchObject({ _id: turnoId });
  });
});

// ─────────────────────────────────────────────────────────────
describe("permisos y pertenencia", () => {
  let e: Escenario;
  beforeEach(async () => {
    e = await montar();
  });

  test("solo guardas de alta de la compania", async () => {
    await expect(e.registrar("alicia", e.ramiro)).rejects.toThrow(
      "Esa persona no pertenece a la compañía.",
    );
    await expect(e.registrar("alicia", e.sofia)).rejects.toThrow(
      "Solo se registran horarios de guardas.",
    );
    await expect(e.registrar("alicia", e.bea)).rejects.toThrow(
      "Esa persona está dada de baja en la compañía.",
    );
  });

  test("el supervisor planifica a sus guardas, solo en sus conjuntos o en general", async () => {
    const permiso = "No tiene permiso para esta operación (seguridad.horarios).";
    await expect(
      e.registrar("sofia", e.jason, { condominioId: e.alamos }),
    ).resolves.toBeTruthy();
    await expect(e.registrar("sofia", e.jason, { bloques: [b(3, "06:00", "18:00")] })).resolves.toBeTruthy();
    // Jason tambien trabaja en Bosque, pero Bosque no es de Sofia.
    await expect(
      e.registrar("sofia", e.jason, { condominioId: e.bosque, bloques: [b(4, "06:00", "18:00")] }),
    ).rejects.toThrow(permiso);
    // Ni a quien no trabaja en sus conjuntos.
    await expect(e.registrar("sofia", e.bruno)).rejects.toThrow(permiso);
    await expect(e.registrar("sofia", e.gabi)).rejects.toThrow(permiso);
  });

  test("el supervisor ve todo el horario de su guarda, pero no finaliza el de otro conjunto", async () => {
    const enBosque = await e.registrar("alicia", e.jason, { condominioId: e.bosque });
    const enAlamos = await e.registrar("alicia", e.jason, {
      condominioId: e.alamos,
      bloques: [b(3, "06:00", "18:00")],
    });
    expect((await e.historial(e.jason, "sofia")).map((h) => h._id).sort()).toEqual(
      [enAlamos, enBosque].sort(),
    );
    await expect(
      e.como("sofia").mutation(api.horariosGuarda.finalizar, {
        horarioId: enBosque,
        ultimoDia: fecha(5),
      }),
    ).rejects.toThrow("No tiene permiso para esta operación (seguridad.horarios).");
    await expect(
      e.como("sofia").mutation(api.horariosGuarda.finalizar, {
        horarioId: enAlamos,
        ultimoDia: fecha(5),
      }),
    ).resolves.toEqual({ ok: true, yaEstaba: false });
  });

  test("el listado y los elegibles del supervisor siguen su alcance", async () => {
    await e.registrar("alicia", e.jason);
    await e.registrar("alicia", e.bruno);
    const deSofia = await e.como("sofia").query(api.horariosGuarda.deCompaniaEnRango, {
      companiaId: e.andina,
      desde: fecha(0),
      hasta: fecha(10),
    });
    expect(deSofia.map((h) => h.guardaNombre)).toEqual(["Jason Guarda"]);
    const elegibles = await e.como("sofia").query(api.horariosGuarda.guardasElegibles, {
      companiaId: e.andina,
    });
    expect(elegibles.map((g) => g.nombre)).toEqual(["Jason Guarda"]);
    const deAlicia = await e.como("alicia").query(api.horariosGuarda.guardasElegibles, {
      companiaId: e.andina,
    });
    expect(deAlicia.map((g) => g.nombre)).toEqual([
      "Bruno Bosque",
      "Gabi Sinpuesto",
      "Jason Guarda",
    ]);
  });

  test("el guarda no modifica ni consulta su horario todavia", async () => {
    const permiso = "No tiene permiso para esta operación (seguridad.horarios).";
    await expect(e.registrar("jason", e.jason)).rejects.toThrow(permiso);
    await expect(
      e.como("jason").query(api.horariosGuarda.vigentesDeGuarda, {
        companiaId: e.andina,
        userId: e.jason,
      }),
    ).rejects.toThrow(permiso);
  });

  test("otra compania no alcanza nada", async () => {
    const id = await e.registrar("alicia", e.jason);
    await expect(e.registrar("ramon", e.jason)).rejects.toThrow("No pertenece a esta compañía.");
    await expect(
      e.como("ramon").query(api.horariosGuarda.detalle, { horarioId: id }),
    ).rejects.toThrow("No pertenece a esta compañía.");
  });
});
