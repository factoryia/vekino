import { test, expect, describe, beforeEach } from "vitest";
import { convexTest } from "convex-test";
import betterAuthTest from "@convex-dev/better-auth/test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { hoyColombia, sumarDias } from "../convex/lib/inasistencias";
import { diaDeLaSemana } from "../convex/lib/horariosGuarda";

const modules = import.meta.glob("../convex/**/*.ts");

/**
 * COBERTURAS TEMPORALES: SOLICITUD Y CICLO DE VIDA.
 *
 * Fija quien puede pedir, a quien, cuando; que solo se pide a quien esta
 * `disponible`; que aceptar vuelve a comprobarlo todo dentro de la mutacion;
 * las transiciones y su rastro; y, sobre todo, que aceptar NO da acceso: el
 * guarda sigue operando con sus vias de siempre.
 *
 * Las fechas se calculan desde hoy (hora de Colombia): el proximo lunes, etc.
 */

const DIA = 24 * 60 * 60 * 1000;
const HORA = 60 * 60 * 1000;
const HOY = hoyColombia();
const fecha = (dias: number) => sumarDias(HOY, dias);
function proximo(dia: number): string {
  for (let i = 1; i <= 7; i++) if (diaDeLaSemana(fecha(i)) === dia) return fecha(i);
  throw new Error("imposible");
}
const LUNES = proximo(1);
const MARTES = sumarDias(LUNES, 1);

const horas = (inicioLocal: string, finLocal: string) => ({
  diaCompleto: false as const,
  inicioLocal,
  finLocal,
});
/** La noche del lunes: libre segun el horario de 06 a 18. */
const NOCHE = horas(`${LUNES}T18:00`, `${MARTES}T06:00`);

const TODOS_LOS_DIAS_DE_DIA = [0, 1, 2, 3, 4, 5, 6].map((dia) => ({
  dia,
  horaInicio: "06:00",
  horaFin: "18:00",
}));

const CHECKLIST = [
  { item: "Radio", obligatorio: true, cantidadEsperada: 1, cantidadEncontrada: 1, estadoOk: true },
];

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
    const cedros = await conjunto("Conjunto Cedros");
    const fresnos = await conjunto("Conjunto Fresnos");
    const dalias = await conjunto("Conjunto Dalias");
    const encinos = await conjunto("Conjunto Encinos");
    const andina = await compania("Seguridad Andina");
    const rival = await compania("Seguridad Rival");

    const contrato = (condominioId: Id<"condominios">, extra = {}) =>
      ctx.db.insert("companiaContratos", {
        companiaId: andina,
        condominioId,
        vigenciaDesde: desde,
        creadoPorUserId: superadmin,
        createdAt: ahora,
        updatedAt: ahora,
        ...extra,
      });
    const kAlamos = await contrato(alamos);
    const kBosque = await contrato(bosque);
    const kCedros = await contrato(cedros);
    const kFresnos = await contrato(fresnos);
    // Terminado hace dias, y otro que acaba hoy: ninguno cubre la proxima semana.
    const kDalias = await contrato(dalias, { vigenciaHasta: ahora - 5 * DIA });
    const kEncinos = await contrato(encinos, { vigenciaHasta: ahora });

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

    // Sofia supervisa Alamos y Cedros.
    const sofia = await usuario("sofia", "Sofia Supervisora");
    const mSofia = await miembro(sofia, andina, "supervisor");
    await asignacion(kAlamos, alamos, sofia, mSofia, "supervisor");
    await asignacion(kCedros, cedros, sofia, mSofia, "supervisor");

    const jason = await usuario("jason", "Jason Guarda");
    const mJason = await miembro(jason, andina, "guardia");
    await asignacion(kAlamos, alamos, jason, mJason, "guardia");

    const bruno = await usuario("bruno", "Bruno Bosque");
    const mBruno = await miembro(bruno, andina, "guardia");
    await asignacion(kBosque, bosque, bruno, mBruno, "guardia");

    // Lucas: guarda de Alamos sin ningun horario registrado.
    const lucas = await usuario("lucas", "Lucas Sinhorario");
    const mLucas = await miembro(lucas, andina, "guardia");
    await asignacion(kAlamos, alamos, lucas, mLucas, "guardia");

    const ramon = await usuario("ramon", "Ramon Rival");
    await miembro(ramon, rival, "admin_compania");

    return {
      alamos, bosque, cedros, andina,
      kAlamos, kBosque, kCedros, kFresnos, kDalias, kEncinos,
      sofia, jason, bruno, lucas,
    };
  });

  const como = (authId: string) => t.withIdentity({ subject: authId });

  // Jason y Bruno trabajan de dia todos los dias: las noches estan libres.
  for (const userId of [ids.jason, ids.bruno]) {
    await como("alicia").mutation(api.horariosGuarda.crear, {
      companiaId: ids.andina,
      userId,
      fechaInicio: fecha(-7),
      bloques: TODOS_LOS_DIAS_DE_DIA,
    });
  }

  const crear = (
    authId: string,
    userId: Id<"users">,
    contratoId: Id<"companiaContratos">,
    ventana: ReturnType<typeof horas> = NOCHE,
  ) => como(authId).mutation(api.coberturas.crear, { contratoId, userId, ventana });

  const responder = (authId: string, coberturaId: Id<"coberturas">, acepta = true) =>
    como(authId).mutation(acepta ? api.coberturas.aceptar : api.coberturas.rechazar, {
      coberturaId,
    });

  const detalle = (coberturaId: Id<"coberturas">, authId = "alicia") =>
    como(authId).query(api.coberturas.detalle, { coberturaId });

  const fila = (coberturaId: Id<"coberturas">) =>
    t.run(async (ctx) => (await ctx.db.get(coberturaId))!);

  return { t, ...ids, como, crear, responder, detalle, fila };
}

type Escenario = Awaited<ReturnType<typeof montar>>;

// ─────────────────────────────────────────────────────────────
describe("A a H: crear una solicitud", () => {
  let e: Escenario;
  beforeEach(async () => {
    e = await montar();
  });

  test("A: a un guarda disponible queda solicitada, con el contrato del destino", async () => {
    const id = await e.crear("alicia", e.jason, e.kCedros);
    const d = await e.detalle(id);
    expect(d).toMatchObject({
      estado: "solicitada",
      userId: e.jason,
      guardaNombre: "Jason Guarda",
      condominioId: e.cedros,
      condominioNombre: "Conjunto Cedros",
      contratoId: e.kCedros,
      solicitadoPorNombre: "Alicia Admin",
      respuesta: null,
    });
    expect(d!.fin - d!.inicio).toBe(12 * HORA);
    const pendientes = await e.como("jason").query(api.coberturas.pendientesDeGuarda, {});
    expect(pendientes.map((c) => c._id)).toEqual([id]);
  });

  test("B: ocupado por su horario: se rechaza", async () => {
    await expect(
      e.crear("alicia", e.jason, e.kCedros, horas(`${LUNES}T14:00`, `${LUNES}T20:00`)),
    ).rejects.toThrow("El guarda está ocupado según su horario en esa ventana.");
  });

  test("C: con una inasistencia en la ventana: se rechaza", async () => {
    await e.como("alicia").mutation(api.inasistencias.crear, {
      companiaId: e.andina,
      userId: e.jason,
      tipo: "permiso",
      ventana: horas(`${LUNES}T20:00`, `${LUNES}T23:00`),
    });
    await expect(e.crear("alicia", e.jason, e.kCedros)).rejects.toThrow(
      "El guarda tiene una inasistencia en esa ventana",
    );
  });

  test("D: sin horario (desconocido): se rechaza, no saber no es estar libre", async () => {
    await expect(e.crear("alicia", e.lucas, e.kCedros)).rejects.toThrow(
      "No hay horario registrado del guarda para toda la ventana",
    );
  });

  test("E: un contrato que no cubre toda la ventana: se rechaza", async () => {
    await expect(e.crear("alicia", e.jason, e.kDalias)).rejects.toThrow(
      "El contrato con ese conjunto no cubre toda la ventana.",
    );
    await expect(e.crear("alicia", e.jason, e.kEncinos)).rejects.toThrow(
      "El contrato con ese conjunto no cubre toda la ventana.",
    );
  });

  test("F: hacia un conjunto donde ya pertenece: se rechaza", async () => {
    await expect(e.crear("alicia", e.jason, e.kAlamos)).rejects.toThrow(
      "Ese guarda ya pertenece a ese conjunto",
    );
  });

  test("G: que empiece en el pasado: se rechaza", async () => {
    await expect(
      e.crear("alicia", e.jason, e.kCedros, horas(`${fecha(-1)}T18:00`, `${fecha(0)}T06:00`)),
    ).rejects.toThrow("La cobertura no puede empezar en el pasado.");
  });

  test("H: de mas de 31 dias: se rechaza", async () => {
    await expect(
      e.crear("alicia", e.jason, e.kCedros, horas(`${LUNES}T18:00`, `${sumarDias(LUNES, 32)}T06:00`)),
    ).rejects.toThrow("Consulta una ventana de hasta 31 días.");
  });
});

// ─────────────────────────────────────────────────────────────
describe("I a K: responder", () => {
  let e: Escenario;
  let id: Id<"coberturas">;
  beforeEach(async () => {
    e = await montar();
    id = await e.crear("alicia", e.jason, e.kCedros);
  });

  test("I: el propio guarda acepta y queda el rastro de su respuesta", async () => {
    await e.responder("jason", id);
    const d = await e.detalle(id);
    expect(d).toMatchObject({
      estado: "aceptada",
      respuesta: "aceptada",
      respondidoPorNombre: "Jason Guarda",
    });
    expect(d!.respondidoEn).toBeGreaterThan(0);
    expect(await e.como("jason").query(api.coberturas.pendientesDeGuarda, {})).toEqual([]);
  });

  test("J: nadie mas puede aceptar en su nombre", async () => {
    for (const quien of ["bruno", "alicia", "sofia", "super"]) {
      await expect(e.responder(quien, id)).rejects.toThrow(
        "Solo el guarda destinatario puede responder esta solicitud.",
      );
    }
    expect((await e.fila(id)).estado).toBe("solicitada");
  });

  test("K: rechazar la conserva; despues no se acepta ni se cancela", async () => {
    await e.responder("jason", id, false);
    const d = await e.detalle(id);
    expect(d).toMatchObject({ estado: "rechazada", respuesta: "rechazada" });
    await expect(e.responder("jason", id)).rejects.toThrow("ya no está pendiente");
    await expect(
      e.como("alicia").mutation(api.coberturas.cancelar, { coberturaId: id }),
    ).rejects.toThrow("Una solicitud rechazada no se cancela.");
  });
});

// ─────────────────────────────────────────────────────────────
describe("L a N: cancelar e inhabilitar", () => {
  let e: Escenario;
  let id: Id<"coberturas">;
  beforeEach(async () => {
    e = await montar();
    id = await e.crear("alicia", e.jason, e.kCedros);
  });

  test("L: una pendiente se cancela; el guarda no puede cancelar", async () => {
    await expect(
      e.como("jason").mutation(api.coberturas.cancelar, { coberturaId: id }),
    ).rejects.toThrow("No tiene permiso para esta operación (seguridad.asignar).");
    await e.como("alicia").mutation(api.coberturas.cancelar, { coberturaId: id });
    const d = await e.detalle(id);
    expect(d).toMatchObject({ estado: "cancelada", canceladaPorNombre: "Alicia Admin", respuesta: null });
    // Repetirlo no reescribe quien la cancelo.
    const antes = await e.fila(id);
    await expect(
      e.como("sofia").mutation(api.coberturas.cancelar, { coberturaId: id }),
    ).resolves.toEqual({ ok: true, yaEstaba: true });
    expect(await e.fila(id)).toEqual(antes);
  });

  test("L: una aceptada que aun no empieza tambien se cancela, y se sabe que se acepto", async () => {
    await e.responder("jason", id);
    await e.como("sofia").mutation(api.coberturas.cancelar, { coberturaId: id });
    expect(await e.detalle(id)).toMatchObject({
      estado: "cancelada",
      respuesta: "aceptada",
      canceladaPorNombre: "Sofia Supervisora",
    });
  });

  test("M: el administrador inhabilita una aceptada, con motivo, sin tocar la ventana", async () => {
    await e.responder("jason", id);
    const antes = await e.fila(id);
    await expect(
      e.como("sofia").mutation(api.coberturas.inhabilitar, { coberturaId: id, motivo: "x" }),
    ).rejects.toThrow("Solo el administrador de la compañía puede inhabilitar una cobertura.");
    await expect(
      e.como("alicia").mutation(api.coberturas.inhabilitar, { coberturaId: id, motivo: "  " }),
    ).rejects.toThrow("Indica el motivo de la inhabilitación.");
    await e.como("alicia").mutation(api.coberturas.inhabilitar, {
      coberturaId: id,
      motivo: "Se reintegro el titular",
    });
    const despues = await e.fila(id);
    expect(despues).toMatchObject({
      estado: "inhabilitada",
      inicio: antes.inicio,
      fin: antes.fin,
      motivoInhabilitacion: "Se reintegro el titular",
    });
    expect(despues.inhabilitadaEn).toBeGreaterThan(0);
  });

  test("N: una inhabilitada no se rehabilita por ningun camino", async () => {
    await e.responder("jason", id);
    await e.como("alicia").mutation(api.coberturas.inhabilitar, { coberturaId: id, motivo: "Corte" });
    const antes = await e.fila(id);
    await expect(e.responder("jason", id)).rejects.toThrow("ya no está pendiente");
    await expect(
      e.como("alicia").mutation(api.coberturas.cancelar, { coberturaId: id }),
    ).rejects.toThrow("Una cobertura inhabilitada no se cancela.");
    await expect(
      e.como("alicia").mutation(api.coberturas.inhabilitar, { coberturaId: id, motivo: "Otra" }),
    ).resolves.toEqual({ ok: true, yaEstaba: true });
    expect(await e.fila(id)).toEqual(antes);
  });

  test("solo se inhabilita lo aceptado", async () => {
    await expect(
      e.como("alicia").mutation(api.coberturas.inhabilitar, { coberturaId: id, motivo: "x" }),
    ).rejects.toThrow("Solo se inhabilita una cobertura aceptada.");
  });
});

// ─────────────────────────────────────────────────────────────
describe("O a R: choques, carreras y revalidacion al aceptar", () => {
  let e: Escenario;
  beforeEach(async () => {
    e = await montar();
  });

  test("O: con una aceptada, otra que se cruza no se puede ni pedir, aunque sea otro conjunto", async () => {
    const primera = await e.crear("alicia", e.jason, e.kCedros);
    await e.responder("jason", primera);
    await expect(
      e.crear("alicia", e.jason, e.kFresnos, horas(`${LUNES}T22:00`, `${MARTES}T02:00`)),
    ).rejects.toThrow("El guarda ya tiene una cobertura aceptada que se cruza con esa ventana.");
    // Y la disponibilidad la cuenta como ocupacion.
    const disp = await e.como("alicia").query(api.disponibilidad.deGuarda, {
      companiaId: e.andina,
      userId: e.jason,
      ventana: NOCHE,
    });
    expect(disp.estado).toBe("ocupado");
    expect(disp.motivos[0]).toMatchObject({ tipo: "cobertura", condominioNombre: "Conjunto Cedros" });
  });

  test("P: dos solicitudes que se cruzan pueden existir, pero solo se acepta una", async () => {
    const enCedros = await e.crear("alicia", e.jason, e.kCedros);
    const enFresnos = await e.crear("alicia", e.jason, e.kFresnos, horas(`${LUNES}T22:00`, `${MARTES}T02:00`));
    await e.responder("jason", enCedros);
    await expect(e.responder("jason", enFresnos)).rejects.toThrow(
      "El guarda ya tiene una cobertura aceptada que se cruza con esa ventana.",
    );
    expect((await e.fila(enFresnos)).estado).toBe("solicitada");
  });

  test("Q: una inasistencia registrada entre la solicitud y la respuesta impide aceptar", async () => {
    const id = await e.crear("alicia", e.jason, e.kCedros);
    await e.como("alicia").mutation(api.inasistencias.crear, {
      companiaId: e.andina,
      userId: e.jason,
      tipo: "incapacidad",
      motivo: "Texto medico que no debe salir de inasistencias",
      ventana: horas(`${LUNES}T00:00`, `${MARTES}T00:00`),
    });
    await expect(e.responder("jason", id)).rejects.toThrow(
      "El guarda tiene una inasistencia en esa ventana",
    );
    expect((await e.fila(id)).estado).toBe("solicitada");
    expect(JSON.stringify(await e.detalle(id))).not.toContain("Texto medico");
  });

  test("R: un horario nuevo que lo ocupa impide aceptar", async () => {
    const id = await e.crear("alicia", e.jason, e.kCedros);
    await e.como("alicia").mutation(api.horariosGuarda.crear, {
      companiaId: e.andina,
      userId: e.jason,
      condominioId: e.alamos,
      fechaInicio: fecha(0),
      bloques: [{ dia: 1, horaInicio: "20:00", horaFin: "23:00" }],
    });
    await expect(e.responder("jason", id)).rejects.toThrow(
      "El guarda está ocupado según su horario en esa ventana.",
    );
  });

  test("dejar de ser guarda de la compania entre medias tambien impide aceptar", async () => {
    const id = await e.crear("alicia", e.jason, e.kCedros);
    await e.t.run(async (ctx) => {
      const m = await ctx.db
        .query("companiaMiembros")
        .withIndex("by_compania_user", (q) => q.eq("companiaId", e.andina).eq("userId", e.jason))
        .unique();
      await ctx.db.patch(m!._id, { isActive: false });
    });
    await expect(e.responder("jason", id)).rejects.toThrow(
      "Esa persona está dada de baja en la compañía.",
    );
  });

  test("una solicitud cuyo inicio ya paso no se acepta", async () => {
    const id = await e.crear("alicia", e.jason, e.kCedros);
    await e.t.run(async (ctx) => {
      await ctx.db.patch(id, { inicio: Date.now() - HORA });
    });
    await expect(e.responder("jason", id)).rejects.toThrow("La cobertura ya empezó: no se puede aceptar.");
  });
});

// ─────────────────────────────────────────────────────────────
describe("S y T: aceptada no es acceso", () => {
  let e: Escenario;
  beforeEach(async () => {
    e = await montar();
  });

  test("S: crear, aceptar, cancelar e inhabilitar no tocan asignaciones ni membresias", async () => {
    const foto = () =>
      e.t.run(async (ctx) => ({
        asignaciones: await ctx.db.query("asignaciones").collect(),
        memberships: await ctx.db.query("memberships").collect(),
        miembros: await ctx.db.query("companiaMiembros").collect(),
        contratos: await ctx.db.query("companiaContratos").collect(),
        turnos: await ctx.db.query("guardiaTurnos").collect(),
      }));
    const antes = await foto();
    const a = await e.crear("alicia", e.jason, e.kCedros);
    await e.responder("jason", a);
    await e.como("alicia").mutation(api.coberturas.inhabilitar, { coberturaId: a, motivo: "Corte" });
    const b = await e.crear("alicia", e.jason, e.kCedros);
    await e.como("alicia").mutation(api.coberturas.cancelar, { coberturaId: b });
    expect(await foto()).toEqual(antes);
  });

  test("T: aceptar no cambia miAcceso, guardia.home ni requireCondominioRole", async () => {
    const turnoId = await e.como("jason").mutation(api.guardia.iniciarTurno, {
      condominioId: e.alamos,
      checklist: CHECKLIST,
    });
    const estado = async () => ({
      accesoAlamos: await e.como("jason").query(api.asignaciones.miAcceso, { condominioId: e.alamos }),
      accesoCedros: await e.como("jason").query(api.asignaciones.miAcceso, { condominioId: e.cedros }),
      homeAlamos: await e.como("jason").query(api.guardia.home, { condominioId: e.alamos }),
      homeCedros: await e.como("jason").query(api.guardia.home, { condominioId: e.cedros }),
    });
    const antes = await estado();
    const id = await e.crear("alicia", e.jason, e.kCedros);
    await e.responder("jason", id);
    expect(await estado()).toEqual(antes);
    expect(antes.homeCedros.allowed).toBe(false);
    await expect(
      e.como("jason").query(api.guardia.turnoActivo, { condominioId: e.cedros }),
    ).rejects.toThrow("No pertenece a este condominio.");
    await expect(
      e.como("jason").query(api.guardia.turnoActivo, { condominioId: e.alamos }),
    ).resolves.toMatchObject({ _id: turnoId });
  });
});

// ─────────────────────────────────────────────────────────────
describe("U: historial", () => {
  let e: Escenario;
  beforeEach(async () => {
    e = await montar();
  });

  test("cada transicion deja quien y cuando", async () => {
    const id = await e.crear("sofia", e.jason, e.kCedros);
    await e.responder("jason", id);
    await e.como("alicia").mutation(api.coberturas.inhabilitar, { coberturaId: id, motivo: "Corte" });
    const d = await e.detalle(id);
    expect(d).toMatchObject({
      solicitadoPorNombre: "Sofia Supervisora",
      respuesta: "aceptada",
      respondidoPorNombre: "Jason Guarda",
      estado: "inhabilitada",
      inhabilitadaPorNombre: "Alicia Admin",
      motivoInhabilitacion: "Corte",
      canceladaEn: null,
    });
    expect(d!.solicitadoEn).toBeLessThanOrEqual(d!.respondidoEn!);
    expect(d!.respondidoEn!).toBeLessThanOrEqual(d!.inhabilitadaEn!);
  });
});

// ─────────────────────────────────────────────────────────────
describe("permisos y consultas", () => {
  let e: Escenario;
  beforeEach(async () => {
    e = await montar();
  });

  test("el supervisor pide solo hacia sus conjuntos y para guardas a su alcance", async () => {
    await expect(e.crear("sofia", e.jason, e.kCedros)).resolves.toBeTruthy();
    const permiso = /No tiene permiso para esta operación/;
    // Bosque no lo supervisa.
    await expect(e.crear("sofia", e.jason, e.kBosque)).rejects.toThrow(permiso);
    // Bruno no trabaja en sus conjuntos.
    await expect(e.crear("sofia", e.bruno, e.kCedros)).rejects.toThrow(permiso);
  });

  test("el guarda no crea, ni otra compania", async () => {
    await expect(e.crear("jason", e.jason, e.kCedros)).rejects.toThrow(
      "No tiene permiso para esta operación (seguridad.asignar).",
    );
    await expect(e.crear("ramon", e.jason, e.kCedros)).rejects.toThrow(
      "Ese contrato no pertenece a su compañía.",
    );
  });

  test("detalle: el guarda ve las suyas; otro guarda no", async () => {
    const id = await e.crear("alicia", e.jason, e.kCedros);
    await expect(e.detalle(id, "jason")).resolves.toMatchObject({ _id: id });
    await expect(e.detalle(id, "bruno")).rejects.toThrow(
      "No tiene permiso para esta operación (seguridad.asignar).",
    );
  });

  test("deCompania filtra y el supervisor solo ve sus destinos", async () => {
    const enCedros = await e.crear("alicia", e.jason, e.kCedros);
    const enBosque = await e.crear("alicia", e.jason, e.kBosque, horas(`${sumarDias(LUNES, 7)}T18:00`, `${sumarDias(MARTES, 7)}T06:00`));
    await e.responder("jason", enCedros);
    const rango = { companiaId: e.andina, desde: fecha(0), hasta: fecha(20) };

    const todas = await e.como("alicia").query(api.coberturas.deCompania, rango);
    expect(todas.map((c) => c._id)).toEqual([enCedros, enBosque]);
    const aceptadas = await e.como("alicia").query(api.coberturas.deCompania, { ...rango, estado: "aceptada" });
    expect(aceptadas.map((c) => c._id)).toEqual([enCedros]);
    const deBosque = await e.como("alicia").query(api.coberturas.deCompania, { ...rango, condominioId: e.bosque });
    expect(deBosque.map((c) => c._id)).toEqual([enBosque]);
    const deBruno = await e.como("alicia").query(api.coberturas.deCompania, { ...rango, userId: e.bruno });
    expect(deBruno).toEqual([]);

    const deSofia = await e.como("sofia").query(api.coberturas.deCompania, rango);
    expect(deSofia.map((c) => c._id)).toEqual([enCedros]);
  });

  test("activasDeGuarda deriva la actividad: aceptada y ahora dentro de la ventana", async () => {
    const ahora = Date.now();
    const base = await e.t.run(async (ctx) => {
      const contrato = (await ctx.db.get(e.kCedros))!;
      const fila = {
        companiaId: e.andina,
        userId: e.jason,
        condominioId: e.cedros,
        contratoId: contrato._id,
        inicio: ahora - HORA,
        fin: ahora + HORA,
        solicitadoPorUserId: e.jason,
        solicitadoEn: ahora - DIA,
      };
      const activa = await ctx.db.insert("coberturas", { ...fila, estado: "aceptada" });
      await ctx.db.insert("coberturas", { ...fila, estado: "inhabilitada", inhabilitadaEn: ahora - 1 });
      await ctx.db.insert("coberturas", { ...fila, estado: "solicitada" });
      await ctx.db.insert("coberturas", {
        ...fila,
        estado: "aceptada",
        inicio: ahora + DIA,
        fin: ahora + DIA + HORA,
      });
      return activa;
    });
    const propias = await e.como("jason").query(api.coberturas.activasDeGuarda, {
      companiaId: e.andina,
      userId: e.jason,
    });
    expect(propias.map((c) => c._id)).toEqual([base]);
    const deSofia = await e.como("sofia").query(api.coberturas.activasDeGuarda, {
      companiaId: e.andina,
      userId: e.jason,
    });
    expect(deSofia.map((c) => c._id)).toEqual([base]);
    // Y aun activa, no le da acceso a Cedros.
    const home = await e.como("jason").query(api.guardia.home, { condominioId: e.cedros });
    expect(home.allowed).toBe(false);
  });
});
