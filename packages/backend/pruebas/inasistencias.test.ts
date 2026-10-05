import { test, expect, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest } from "convex-test";
import betterAuthTest from "@convex-dev/better-auth/test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { viasEnConjunto } from "../convex/model/vias";
import { textoLocalColombia } from "../convex/lib/inasistencias";

const modules = import.meta.glob("../convex/**/*.ts");

/**
 * INASISTENCIAS DE LOS GUARDAS DE UNA COMPANIA.
 *
 * Fija las reglas del registro —quien puede recibir una, la ventana, el
 * solape, la anulacion— y, sobre todo, que es informacion de planificacion:
 * registrarla no toca asignaciones, membresias, turnos ni permisos.
 *
 * El escenario se monta directo en la base para controlar exactamente que
 * filas existen.
 */

const DIA = 24 * 60 * 60 * 1000;
const HORA = 60 * 60 * 1000;

/* Reloj fijo: miercoles 7 de octubre de 2026, 10:00 en Colombia. Las ventanas
 * de estas pruebas son fechas fijas (el 8 y el 9 de octubre) mezcladas con
 * turnos y asignaciones relativos a ahora: con el reloj real, a partir del 8
 * las fechas fijas pasan a ser pasado y las pruebas dejan de mirar una
 * inasistencia futura sin que nada avise. */
const AHORA = Date.parse("2026-10-07T15:00:00Z");
beforeEach(() => {
  vi.setSystemTime(AHORA);
});
afterEach(() => vi.useRealTimers());

const CHECKLIST = [
  { item: "Radio", obligatorio: true, cantidadEsperada: 1, cantidadEncontrada: 1, estadoOk: true },
];
const OBSERVACIONES =
  "Turno finalizado sin novedades adicionales. Se entrega puesto, documentación y elementos al guarda de relevo.";

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
    const andina = await compania("Seguridad Andina");
    const rival = await compania("Seguridad Rival");

    const contrato = (
      companiaId: Id<"companiasSeguridad">,
      condominioId: Id<"condominios">,
    ) =>
      ctx.db.insert("companiaContratos", {
        companiaId,
        condominioId,
        vigenciaDesde: desde,
        creadoPorUserId: superadmin,
        createdAt: ahora,
        updatedAt: ahora,
      });
    const kAlamos = await contrato(andina, alamos);
    const kBosque = await contrato(andina, bosque);

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

    const otraSup = await usuario("otrasup", "Olga Supervisora");
    await miembro(otraSup, andina, "supervisor");

    // Jason: guarda de Andina en Alamos y en Bosque.
    const jason = await usuario("jason", "Jason Guarda");
    const mJason = await miembro(jason, andina, "guardia");
    await asignacion(kAlamos, alamos, jason, mJason, "guardia");
    await asignacion(kBosque, bosque, jason, mJason, "guardia");

    // Bruno: guarda de Andina solo en Bosque, fuera del alcance de Sofia.
    const bruno = await usuario("bruno", "Bruno Bosque");
    const mBruno = await miembro(bruno, andina, "guardia");
    await asignacion(kBosque, bosque, bruno, mBruno, "guardia");

    // Gabi: guarda de Andina sin ninguna asignacion hoy.
    const gabi = await usuario("gabi", "Gabi Sinpuesto");
    await miembro(gabi, andina, "guardia");

    // Bea: guarda de Andina dada de baja.
    const bea = await usuario("bea", "Bea Baja");
    await miembro(bea, andina, "guardia", false);

    // Ramiro y Ramon: guarda y administrador de Rival.
    const ramiro = await usuario("ramiro", "Ramiro Rival");
    await miembro(ramiro, rival, "guardia");
    const ramon = await usuario("ramon", "Ramon Rival");
    await miembro(ramon, rival, "admin_compania");

    // Pedro: guarda propio de Alamos, sin compania.
    const propio = await usuario("propio", "Pedro Propio");
    await ctx.db.insert("memberships", {
      userId: propio,
      condominioId: alamos,
      roles: ["guardia"],
      isActive: true,
      createdAt: ahora,
      updatedAt: ahora,
    });

    return {
      alamos,
      bosque,
      andina,
      alicia,
      sofia,
      otraSup,
      jason,
      bruno,
      gabi,
      bea,
      ramiro,
      propio,
    };
  });

  const como = (authId: string) => t.withIdentity({ subject: authId });

  /** Registra como `authId`; por defecto, dias completos y sin motivo. */
  const registrar = (
    authId: string,
    userId: Id<"users">,
    extra: Partial<{
      tipo: "inasistencia" | "incapacidad" | "vacaciones" | "permiso" | "otro";
      motivo: string;
      ventana:
        | { diaCompleto: true; fechaInicio: string; fechaFin: string }
        | { diaCompleto: false; inicioLocal: string; finLocal: string };
    }> = {},
  ) =>
    como(authId).mutation(api.inasistencias.crear, {
      companiaId: ids.andina,
      userId,
      tipo: extra.tipo ?? "incapacidad",
      motivo: extra.motivo,
      ventana: extra.ventana ?? {
        diaCompleto: true,
        fechaInicio: "2026-10-08",
        fechaFin: "2026-10-09",
      },
    });

  return { t, ...ids, plataforma: como("super"), como, registrar };
}

type Escenario = Awaited<ReturnType<typeof montar>>;

const dias = (fechaInicio: string, fechaFin: string) => ({
  diaCompleto: true as const,
  fechaInicio,
  fechaFin,
});
const horas = (inicioLocal: string, finLocal: string) => ({
  diaCompleto: false as const,
  inicioLocal,
  finLocal,
});

// ─────────────────────────────────────────────────────────────
describe("A: registrar una inasistencia valida", () => {
  let e: Escenario;
  beforeEach(async () => {
    e = await montar();
  });

  test("de dias completos: conserva la fecha civil y queda activa", async () => {
    const id = await e.registrar("alicia", e.jason, {
      tipo: "incapacidad",
      motivo: "Incapacidad medica de dos dias",
      ventana: dias("2026-10-08", "2026-10-09"),
    });
    const d = await e.como("alicia").query(api.inasistencias.detalle, {
      inasistenciaId: id,
    });
    expect(d).toMatchObject({
      userId: e.jason,
      companiaId: e.andina,
      guardaNombre: "Jason Guarda",
      tipo: "incapacidad",
      motivo: "Incapacidad medica de dos dias",
      diaCompleto: true,
      fechaInicio: "2026-10-08",
      fechaFin: "2026-10-09",
      estado: "activa",
      registradaPorNombre: "Alicia Admin",
      anuladaEn: null,
      anuladaPorNombre: null,
    });
    expect(d!.fin - d!.inicio).toBe(2 * DIA);
  });

  test("con hora: instantes exactos, sin fecha civil", async () => {
    const id = await e.registrar("alicia", e.jason, {
      tipo: "permiso",
      ventana: horas("2026-10-08T18:00", "2026-10-09T06:00"),
    });
    const d = await e.como("alicia").query(api.inasistencias.detalle, {
      inasistenciaId: id,
    });
    expect(d!.diaCompleto).toBe(false);
    expect(d!.fechaInicio).toBeNull();
    expect(d!.inicio).toBe(Date.UTC(2026, 9, 8, 23, 0));
    expect(d!.fin - d!.inicio).toBe(12 * HORA);
  });

  test("a un guarda sin asignacion hoy tambien se le registra", async () => {
    await expect(e.registrar("alicia", e.gabi)).resolves.toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────
describe("B a D: solo a guardas de alta de la compania", () => {
  let e: Escenario;
  beforeEach(async () => {
    e = await montar();
  });

  test("B: quien no pertenece a la compania se rechaza", async () => {
    await expect(e.registrar("alicia", e.ramiro)).rejects.toThrow(
      "Esa persona no pertenece a la compañía.",
    );
    // El guarda propio del conjunto no es personal de ninguna compania.
    await expect(e.registrar("alicia", e.propio)).rejects.toThrow(
      "Esa persona no pertenece a la compañía.",
    );
  });

  test("C: un supervisor o un administrador no reciben inasistencias", async () => {
    await expect(e.registrar("alicia", e.otraSup)).rejects.toThrow(
      "Solo se registran inasistencias de guardas.",
    );
    await expect(e.registrar("alicia", e.alicia)).rejects.toThrow(
      "Solo se registran inasistencias de guardas.",
    );
  });

  test("D: un guarda dado de baja se rechaza", async () => {
    await expect(e.registrar("alicia", e.bea)).rejects.toThrow(
      "Esa persona está dada de baja en la compañía.",
    );
  });
});

// ─────────────────────────────────────────────────────────────
describe("E: ventana y motivo invalidos", () => {
  let e: Escenario;
  beforeEach(async () => {
    e = await montar();
  });

  test("inicio igual o posterior al fin se rechaza", async () => {
    await expect(
      e.registrar("alicia", e.jason, {
        ventana: horas("2026-10-08T18:00", "2026-10-08T18:00"),
      }),
    ).rejects.toThrow("El fin debe ser posterior al inicio.");
    await expect(
      e.registrar("alicia", e.jason, {
        ventana: horas("2026-10-09T06:00", "2026-10-08T18:00"),
      }),
    ).rejects.toThrow("El fin debe ser posterior al inicio.");
    await expect(
      e.registrar("alicia", e.jason, { ventana: dias("2026-10-10", "2026-10-08") }),
    ).rejects.toThrow("La fecha final no puede ser anterior a la inicial.");
  });

  test("una fecha que no existe se rechaza", async () => {
    await expect(
      e.registrar("alicia", e.jason, {
        ventana: horas("2026-02-30T10:00", "2026-03-01T10:00"),
      }),
    ).rejects.toThrow("La fecha y hora no son válidas.");
  });

  test("inasistencia y otro exigen describir que paso", async () => {
    await expect(
      e.registrar("alicia", e.jason, { tipo: "inasistencia" }),
    ).rejects.toThrow("el motivo es obligatorio");
    await expect(
      e.registrar("alicia", e.jason, { tipo: "otro", motivo: "   " }),
    ).rejects.toThrow("el motivo es obligatorio");
    await expect(
      e.registrar("alicia", e.jason, { tipo: "inasistencia", motivo: "No se presento" }),
    ).resolves.toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────
describe("F: solapamientos", () => {
  let e: Escenario;
  beforeEach(async () => {
    e = await montar();
    await e.registrar("alicia", e.jason, {
      ventana: horas("2026-10-08T08:00", "2026-10-10T18:00"),
    });
  });

  test("superpuesta del todo o en parte: se rechaza", async () => {
    const mensaje = "Ese guarda ya tiene una inasistencia activa que se cruza con esas fechas";
    await expect(
      e.registrar("alicia", e.jason, {
        ventana: horas("2026-10-08T08:00", "2026-10-10T18:00"),
      }),
    ).rejects.toThrow(mensaje);
    await expect(
      e.registrar("alicia", e.jason, {
        ventana: horas("2026-10-09T12:00", "2026-10-11T10:00"),
      }),
    ).rejects.toThrow(mensaje);
    await expect(
      e.registrar("alicia", e.jason, { ventana: dias("2026-10-09", "2026-10-09") }),
    ).rejects.toThrow(mensaje);
  });

  test("seguida, sin cruzarse: se permite", async () => {
    await expect(
      e.registrar("alicia", e.jason, {
        ventana: horas("2026-10-10T18:00", "2026-10-11T06:00"),
      }),
    ).resolves.toBeTruthy();
  });

  test("otro guarda en las mismas fechas: no hay cruce", async () => {
    await expect(
      e.registrar("alicia", e.bruno, {
        ventana: horas("2026-10-08T08:00", "2026-10-10T18:00"),
      }),
    ).resolves.toBeTruthy();
  });

  test("una anulada ya no estorba", async () => {
    const [activa] = await e.como("alicia").query(api.inasistencias.activasDeGuarda, {
      companiaId: e.andina,
      userId: e.jason,
    });
    await e.como("alicia").mutation(api.inasistencias.anular, {
      inasistenciaId: activa!._id,
    });
    await expect(
      e.registrar("alicia", e.jason, {
        ventana: horas("2026-10-09T12:00", "2026-10-11T10:00"),
      }),
    ).resolves.toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────
describe("G a I: anular, activas e historial", () => {
  let e: Escenario;
  let id: Id<"inasistencias">;
  beforeEach(async () => {
    e = await montar();
    id = await e.registrar("alicia", e.jason);
  });

  test("G: anular la conserva, la marca y deja rastro", async () => {
    const r = await e.como("alicia").mutation(api.inasistencias.anular, {
      inasistenciaId: id,
    });
    expect(r).toEqual({ ok: true, yaEstaba: false });
    const d = await e.como("alicia").query(api.inasistencias.detalle, {
      inasistenciaId: id,
    });
    expect(d!.estado).toBe("anulada");
    expect(d!.anuladaPorNombre).toBe("Alicia Admin");
    expect(d!.anuladaEn).toBeGreaterThan(0);
    // La fila sigue ahi, con todo lo que tenia.
    expect(d!.tipo).toBe("incapacidad");
    expect(d!.fechaInicio).toBe("2026-10-08");
  });

  test("G: anular otra vez no reescribe quien la anulo", async () => {
    await e.como("sofia").mutation(api.inasistencias.anular, { inasistenciaId: id });
    const antes = await e.t.run(async (ctx) => await ctx.db.get(id));
    const r = await e.como("alicia").mutation(api.inasistencias.anular, {
      inasistenciaId: id,
    });
    expect(r).toEqual({ ok: true, yaEstaba: true });
    const despues = await e.t.run(async (ctx) => await ctx.db.get(id));
    expect(despues).toEqual(antes);
  });

  test("H: una anulada no aparece como activa", async () => {
    await e.como("alicia").mutation(api.inasistencias.anular, { inasistenciaId: id });
    const activas = await e.como("alicia").query(api.inasistencias.activasDeGuarda, {
      companiaId: e.andina,
      userId: e.jason,
    });
    expect(activas).toEqual([]);
    const enRango = await e.como("alicia").query(api.inasistencias.deCompaniaEnRango, {
      companiaId: e.andina,
      desde: "2026-10-01",
      hasta: "2026-10-31",
    });
    expect(enRango).toEqual([]);
  });

  test("I: el historial la sigue mostrando, anulada", async () => {
    await e.como("alicia").mutation(api.inasistencias.anular, { inasistenciaId: id });
    const segunda = await e.registrar("alicia", e.jason, {
      ventana: dias("2026-11-02", "2026-11-03"),
    });
    const historial = await e.como("alicia").query(api.inasistencias.historialDeGuarda, {
      companiaId: e.andina,
      userId: e.jason,
    });
    expect(historial.map((i) => [i._id, i.estado])).toEqual([
      [segunda, "activa"],
      [id, "anulada"],
    ]);
  });

  test("el rango trae solo lo que se cruza con el", async () => {
    await e.registrar("alicia", e.jason, { ventana: dias("2026-12-01", "2026-12-02") });
    const octubre = await e.como("alicia").query(api.inasistencias.deCompaniaEnRango, {
      companiaId: e.andina,
      desde: "2026-10-09",
      hasta: "2026-10-20",
    });
    expect(octubre.map((i) => i._id)).toEqual([id]);
  });
});

// ─────────────────────────────────────────────────────────────
describe("J y K: no es un mecanismo de autorizacion", () => {
  let e: Escenario;
  beforeEach(async () => {
    e = await montar();
  });

  test("J: registrarla no toca asignaciones, membresias, permisos ni turnos", async () => {
    // Jason abre turno en Alamos antes de que le registren la inasistencia.
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
        turnos: await ctx.db.query("guardiaTurnos").collect(),
      }));
    const acceso = () =>
      e.como("jason").query(api.asignaciones.miAcceso, { condominioId: e.alamos });

    const antes = await foto();
    const accesoAntes = await acceso();

    // Una inasistencia que cubre AHORA mismo.
    const ahora = Date.now();
    await e.registrar("alicia", e.jason, {
      tipo: "incapacidad",
      ventana: horas(textoLocalColombia(ahora - 2 * HORA), textoLocalColombia(ahora + 6 * HORA)),
    });

    expect(await foto()).toEqual(antes);
    expect(await acceso()).toEqual(accesoAntes);
    const home = await e.como("jason").query(api.guardia.home, {
      condominioId: e.alamos,
    });
    expect(home.allowed).toBe(true);

    // Y puede cerrar el turno que tenia abierto.
    await e.como("jason").mutation(api.guardia.cerrarTurno, {
      turnoId,
      recibe: "Relevo de la noche",
      consignas: "Sin pendientes.",
      observacionesCierre: OBSERVACIONES,
      novedadesElementos: false,
    });
    const turno = await e.t.run(async (ctx) => await ctx.db.get(turnoId));
    expect(turno!.estado).toBe("cerrado");
  });

  test("K: con dos asignaciones tiene UNA inasistencia y sus dos vias siguen", async () => {
    const id = await e.registrar("alicia", e.jason, { ventana: dias("2026-10-08", "2026-10-09") });

    for (const condominioId of [e.alamos, e.bosque]) {
      const vias = await e.t.run(async (ctx) =>
        (await viasEnConjunto(ctx, e.jason, condominioId)).vias.map((v) => v.tipo),
      );
      expect(vias).toEqual(["asignacion"]);
    }
    const enRango = await e.como("alicia").query(api.inasistencias.deCompaniaEnRango, {
      companiaId: e.andina,
      desde: "2026-10-01",
      hasta: "2026-10-31",
    });
    expect(enRango.map((i) => i._id)).toEqual([id]);
    const filas = await e.t.run(async (ctx) => await ctx.db.query("inasistencias").collect());
    expect(filas).toHaveLength(1);
    expect(filas[0]).not.toHaveProperty("condominioId");
    expect(filas[0]).not.toHaveProperty("asignacionId");
  });
});

// ─────────────────────────────────────────────────────────────
describe("permisos: compania, supervisor y guarda", () => {
  let e: Escenario;
  beforeEach(async () => {
    e = await montar();
  });

  test("el supervisor registra y anula a los guardas de sus conjuntos", async () => {
    const propia = await e.registrar("sofia", e.jason);
    const deAlicia = await e.registrar("alicia", e.jason, {
      ventana: dias("2026-11-01", "2026-11-01"),
    });
    await expect(
      e.como("sofia").mutation(api.inasistencias.anular, { inasistenciaId: deAlicia }),
    ).resolves.toEqual({ ok: true, yaEstaba: false });
    const d = await e.como("alicia").query(api.inasistencias.detalle, {
      inasistenciaId: propia,
    });
    expect(d!.registradaPorNombre).toBe("Sofia Supervisora");
  });

  test("pero no a los de fuera de sus conjuntos, ni a quien no tiene puesto", async () => {
    const permiso = "No tiene permiso para esta operación (seguridad.inasistencias).";
    await expect(e.registrar("sofia", e.bruno)).rejects.toThrow(permiso);
    await expect(e.registrar("sofia", e.gabi)).rejects.toThrow(permiso);

    const deBruno = await e.registrar("alicia", e.bruno);
    await expect(
      e.como("sofia").mutation(api.inasistencias.anular, { inasistenciaId: deBruno }),
    ).rejects.toThrow(permiso);
    await expect(
      e.como("sofia").query(api.inasistencias.historialDeGuarda, {
        companiaId: e.andina,
        userId: e.bruno,
      }),
    ).rejects.toThrow(permiso);
  });

  test("el listado del supervisor solo trae a los guardas que alcanza", async () => {
    const deJason = await e.registrar("alicia", e.jason);
    await e.registrar("alicia", e.bruno);
    const lista = await e.como("sofia").query(api.inasistencias.deCompaniaEnRango, {
      companiaId: e.andina,
      desde: "2026-10-01",
      hasta: "2026-10-31",
    });
    expect(lista.map((i) => i._id)).toEqual([deJason]);
    const todo = await e.como("alicia").query(api.inasistencias.deCompaniaEnRango, {
      companiaId: e.andina,
      desde: "2026-10-01",
      hasta: "2026-10-31",
    });
    expect(todo).toHaveLength(2);
  });

  test("los guardas elegibles siguen el mismo alcance", async () => {
    const deAlicia = await e.como("alicia").query(api.inasistencias.guardasElegibles, {
      companiaId: e.andina,
    });
    expect(deAlicia.map((g) => g.nombre)).toEqual([
      "Bruno Bosque",
      "Gabi Sinpuesto",
      "Jason Guarda",
    ]);
    const deSofia = await e.como("sofia").query(api.inasistencias.guardasElegibles, {
      companiaId: e.andina,
    });
    expect(deSofia.map((g) => g.nombre)).toEqual(["Jason Guarda"]);
  });

  test("el guarda no registra ni consulta, ni siquiera lo suyo", async () => {
    await expect(e.registrar("jason", e.jason)).rejects.toThrow(
      "No tiene permiso para esta operación (seguridad.inasistencias).",
    );
    await expect(
      e.como("jason").query(api.inasistencias.activasDeGuarda, {
        companiaId: e.andina,
        userId: e.jason,
      }),
    ).rejects.toThrow("No tiene permiso para esta operación (seguridad.inasistencias).");
  });

  test("otra compania no alcanza nada", async () => {
    await expect(e.registrar("ramon", e.jason)).rejects.toThrow(
      "No pertenece a esta compañía.",
    );
    const id = await e.registrar("alicia", e.jason);
    await expect(
      e.como("ramon").query(api.inasistencias.detalle, { inasistenciaId: id }),
    ).rejects.toThrow("No pertenece a esta compañía.");
    await expect(
      e.como("ramon").query(api.inasistencias.deCompaniaEnRango, {
        companiaId: e.andina,
        desde: "2026-10-01",
        hasta: "2026-10-31",
      }),
    ).rejects.toThrow("No pertenece a esta compañía.");
  });

  test("una compania suspendida no registra", async () => {
    await e.plataforma.mutation(api.companias.setEstado, {
      companiaId: e.andina,
      estado: "suspendida",
    });
    await expect(e.registrar("alicia", e.jason)).rejects.toThrow(
      "La compañía no está activa.",
    );
  });

  test("la plataforma conserva el paso libre", async () => {
    await expect(e.registrar("super", e.jason)).resolves.toBeTruthy();
  });
});
