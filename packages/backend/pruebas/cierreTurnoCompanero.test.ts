import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { logMinuta } from "../convex/model/minuta";
import { HORA, T17, montar } from "./helpers/trazabilidad";

/* `logMinuta` real, pero espiable: una prueba lo hace fallar una vez para ver
 * que el cierre y su traza se confirman juntos o no se confirma nada. */
vi.mock("../convex/model/minuta", async (importOriginal) => {
  const real = await importOriginal<typeof import("../convex/model/minuta")>();
  return { ...real, logMinuta: vi.fn(real.logMinuta) };
});

const modules = import.meta.glob("../convex/**/*.ts");

/**
 * EL CIERRE DEL TURNO QUE UN COMPAÑERO DEJÓ ABIERTO.
 *
 * Ana abre el turno de Norte y se va sin cerrarlo; Beto llega y no puede abrir
 * el suyo. Con `cerrarTurnoDeCompanero` Beto lo cierra él, y queda dicho en el
 * turno y en la minuta que lo cerró Beto, compañero, y no Ana. Todo va por la
 * API pública —la que llaman la web y el móvil— y lo que se rechaza se
 * comprueba también por lo que NO escribió.
 */

const AHORA = Date.now();
const TIPO = "Cierre de Turno por Compañero";

type T = ReturnType<typeof convexTest>;
const como = (t: T, subject: string) => t.withIdentity({ subject });

const CHECKLIST = [
  { item: "Radio", obligatorio: true, cantidadEsperada: 1, cantidadEncontrada: 1, estadoOk: true },
];

async function escenario(t: T) {
  return await t.run(async (ctx) => {
    const conjunto = (name: string) =>
      ctx.db.insert("condominios", {
        name,
        activeModules: [],
        isActive: true,
        createdAt: AHORA,
        updatedAt: AHORA,
      });
    const norte = await conjunto("Conjunto Norte");
    const sur = await conjunto("Conjunto Sur");

    const persona = async (
      name: string,
      authId: string,
      condominioId: Id<"condominios">,
      roles: string[],
      { membresiaActiva = true, cuentaActiva = true } = {},
    ) => {
      const userId = await ctx.db.insert("users", {
        name,
        email: `${authId}@vekino.test`,
        emailVerified: true,
        active: cuentaActiva,
        authId,
        createdAt: AHORA,
        updatedAt: AHORA,
      });
      await ctx.db.insert("memberships", {
        userId,
        condominioId,
        roles: roles as never,
        isActive: membresiaActiva,
        createdAt: AHORA,
        updatedAt: AHORA,
      });
      return userId;
    };

    return {
      norte,
      sur,
      ana: await persona("Ana Guarda", "ana", norte, ["guardia"]),
      beto: await persona("Beto Guarda", "beto", norte, ["guardia"]),
      carla: await persona("Carla Guarda", "carla", norte, ["guardia"]),
      admin: await persona("Adriana Admin", "admin", norte, ["administrador"]),
      junta: await persona("Julio Junta", "junta", norte, ["junta_directiva"]),
      residente: await persona("Rita Residente", "rita", norte, ["residente"]),
      retirado: await persona("Raúl Retirado", "raul", norte, ["guardia"], { membresiaActiva: false }),
      inactivo: await persona("Iván Inactivo", "ivan", norte, ["guardia"], { cuentaActiva: false }),
      sergio: await persona("Sergio Sur", "sergio", sur, ["guardia"]),
    };
  });
}
type Escenario = Awaited<ReturnType<typeof escenario>>;

async function abrir(t: T, authId: string, condominioId: Id<"condominios">, extra: object = {}) {
  return await como(t, authId).mutation(api.guardia.iniciarTurno, {
    condominioId,
    checklist: CHECKLIST,
    ...extra,
  });
}

const leerTurno = (t: T, turnoId: Id<"guardiaTurnos">) =>
  t.run(async (ctx) => (await ctx.db.get(turnoId))!);

/** Toda la minuta de un conjunto, tal como está en la base. */
const minutaDe = (t: T, condominioId: Id<"condominios">) =>
  t.run((ctx) =>
    ctx.db
      .query("minutaEventos")
      .withIndex("by_condominio", (q) => q.eq("condominioId", condominioId))
      .collect(),
  );

const cierresDe = async (t: T, condominioId: Id<"condominios">, turnoId: Id<"guardiaTurnos">) =>
  (await minutaDe(t, condominioId)).filter(
    (m) => m.turnoId === turnoId && m.tipo.startsWith("Cierre de Turno"),
  );

describe("un guarda cierra el turno que su compañero dejó abierto", () => {
  let t: T;
  let e: Escenario;
  let turnoId: Id<"guardiaTurnos">;

  beforeEach(async () => {
    t = convexTest(schema, modules);
    e = await escenario(t);
    turnoId = await abrir(t, "ana", e.norte);
  });

  test("la portería le dice de quién es el turno y que lo cierra como compañero", async () => {
    const paraBeto = await como(t, "beto").query(api.guardia.turnoActivo, { condominioId: e.norte });
    expect(paraBeto!._id).toBe(turnoId);
    expect(paraBeto!.guardiaNombre).toBe("Ana Guarda");
    expect(paraBeto!.cierraComo).toBe("companero");
    // Para Ana y para la administración es la vía de siempre.
    for (const quien of ["ana", "admin", "junta"]) {
      const turno = await como(t, quien).query(api.guardia.turnoActivo, { condominioId: e.norte });
      expect(turno!.cierraComo, quien).toBe("propio");
    }
    // Y mientras siga abierto, Beto no puede abrir el suyo: el bloqueo de siempre.
    await expect(abrir(t, "beto", e.norte)).rejects.toThrow(/ya hay un turno abierto \(Ana Guarda\)/i);
  });

  test("lo cierra, el turno sigue siendo de Ana y el cierre queda a nombre de Beto", async () => {
    const antes = await leerTurno(t, turnoId);
    expect(
      await como(t, "beto").mutation(api.guardia.cerrarTurnoDeCompanero, {
        turnoId,
        condominioId: e.norte,
      }),
    ).toEqual({ ok: true });

    const turno = await leerTurno(t, turnoId);
    expect(turno.estado).toBe("cerrado");
    expect(turno.fechaCierre).toBeTypeOf("number");
    // Ejecutor: quien tiene la sesión. Propietario: intacto.
    expect(turno.cerradoPorUserId).toBe(e.beto);
    expect(turno.guardiaUserId).toBe(e.ana);
    expect(turno.guardiaNombre).toBe("Ana Guarda");
    expect(turno.condominioId).toBe(e.norte);
    expect(turno.fechaInicio).toBe(antes.fechaInicio);
    expect(turno.checklist).toEqual(antes.checklist);
    expect(turno.observacionesCierre).toBe(
      "Cierre por compañero (turno olvidado): lo cerró Beto Guarda, que no es del turno.",
    );
    // Nadie entregó la portería: no se inventa un relevo.
    expect(turno.recibe).toBeUndefined();
    expect(turno.recibeUserId).toBeUndefined();
  });

  test("la minuta deja constancia: tipo, turno, propietario, ejecutor, conjunto, hora, motivo y estados", async () => {
    const inicioAntes = (await minutaDe(t, e.norte)).find((m) => m.tipo === "Inicio de Turno")!;
    await como(t, "beto").mutation(api.guardia.cerrarTurnoDeCompanero, {
      turnoId,
      condominioId: e.norte,
    });
    const turno = await leerTurno(t, turnoId);

    const cierres = await cierresDe(t, e.norte, turnoId);
    expect(cierres).toHaveLength(1);
    const [cierre] = cierres;
    expect(cierre!.tipo).toBe(TIPO);
    expect(cierre!.turnoId).toBe(turnoId);
    expect(cierre!.condominioId).toBe(e.norte);
    expect(cierre!.actorUserId).toBe(e.beto);
    expect(cierre!.actorNombre).toBe("Beto Guarda");
    expect(cierre!.estado).toBe("cerrado");
    expect(cierre!.createdAt).toBeGreaterThanOrEqual(turno.fechaCierre!);
    expect(cierre!.resumen).toBe(
      "Turno de Ana Guarda cerrado por Beto Guarda, compañero de portería: " +
        "quedó abierto sin cerrar (turno olvidado). Estado: abierto → cerrado.",
    );

    // El histórico no se toca: el inicio de Ana sigue igual y a su nombre.
    const inicioDespues = (await minutaDe(t, e.norte)).find((m) => m._id === inicioAntes._id)!;
    expect(inicioDespues).toEqual(inicioAntes);
    expect(inicioDespues.actorUserId).toBe(e.ana);

    // Y quien supervisa lo ve: en la minuta de la portería y en el detalle del turno.
    const minuta = await como(t, "admin").query(api.guardia.listMinuta, { condominioId: e.norte });
    expect(minuta.some((m) => m.tipo === TIPO && m.turnoId === turnoId)).toBe(true);
    const detalle = await como(t, "admin").query(api.guardia.getTurno, { turnoId });
    expect(detalle!.guardiaNombre).toBe("Ana Guarda");
    expect(detalle!.cerradoPorNombre).toBe("Beto Guarda");
    expect(detalle!.eventos.map((m) => m.tipo).sort()).toEqual([TIPO, "Inicio de Turno"].sort());
  });

  test("después del cierre, Beto abre su turno con las reglas de siempre", async () => {
    await como(t, "beto").mutation(api.guardia.cerrarTurnoDeCompanero, {
      turnoId,
      condominioId: e.norte,
    });
    expect(await como(t, "beto").query(api.guardia.turnoActivo, { condominioId: e.norte })).toBeNull();

    // Las reglas de apertura no cambian: sin checklist no abre.
    await expect(
      como(t, "beto").mutation(api.guardia.iniciarTurno, { condominioId: e.norte, checklist: [] }),
    ).rejects.toThrow(/al menos un ítem/i);

    const nuevo = await abrir(t, "beto", e.norte);
    const activo = await como(t, "beto").query(api.guardia.turnoActivo, { condominioId: e.norte });
    expect(activo!._id).toBe(nuevo);
    expect(activo!.guardiaUserId).toBe(e.beto);
    expect(activo!.cierraComo).toBe("propio");
    // El turno de Ana sigue cerrado y es otro.
    expect((await leerTurno(t, turnoId)).estado).toBe("cerrado");
  });

  test("el turno compartido se dice con sus dos guardas", async () => {
    await como(t, "beto").mutation(api.guardia.cerrarTurnoDeCompanero, { turnoId, condominioId: e.norte });
    await abrir(t, "ana", e.norte, { guardiaSecundarioNombre: "Pedro Apoyo" });
    const compartido = (await como(t, "carla").query(api.guardia.turnoActivo, { condominioId: e.norte }))!;
    await como(t, "carla").mutation(api.guardia.cerrarTurnoDeCompanero, {
      turnoId: compartido._id,
      condominioId: e.norte,
    });
    const [cierre] = await cierresDe(t, e.norte, compartido._id);
    expect(cierre!.resumen).toMatch(/^Turno de Ana Guarda \(compartido con Pedro Apoyo\) cerrado por Carla Guarda/);
  });
});

describe("solo en el conjunto seleccionado y autorizado", () => {
  let t: T;
  let e: Escenario;
  let turnoNorte: Id<"guardiaTurnos">;

  beforeEach(async () => {
    t = convexTest(schema, modules);
    e = await escenario(t);
    turnoNorte = await abrir(t, "ana", e.norte);
  });

  /** Que el intento no dejó nada: el turno sigue abierto y la minuta, igual. */
  async function sinCambios() {
    const turno = await leerTurno(t, turnoNorte);
    expect(turno.estado).toBe("abierto");
    expect(turno.cerradoPorUserId).toBeUndefined();
    expect(turno.fechaCierre).toBeUndefined();
    expect(await cierresDe(t, e.norte, turnoNorte)).toEqual([]);
  }

  test("un guarda de otro conjunto no lo cierra pidiéndolo en Norte", async () => {
    await expect(
      como(t, "sergio").mutation(api.guardia.cerrarTurnoDeCompanero, {
        turnoId: turnoNorte,
        condominioId: e.norte,
      }),
    ).rejects.toThrow(/no pertenece a este condominio/i);
    await sinCambios();
  });

  test("ni mandando su propio conjunto con el id de un turno de Norte", async () => {
    await expect(
      como(t, "sergio").mutation(api.guardia.cerrarTurnoDeCompanero, {
        turnoId: turnoNorte,
        condominioId: e.sur,
      }),
    ).rejects.toThrow(/turno no encontrado en esta portería/i);
    await sinCambios();
  });

  test("ni un guarda de Norte cierra un turno de Sur desde Norte", async () => {
    const turnoSur = await abrir(t, "sergio", e.sur);
    await expect(
      como(t, "beto").mutation(api.guardia.cerrarTurnoDeCompanero, {
        turnoId: turnoSur,
        condominioId: e.norte,
      }),
    ).rejects.toThrow(/turno no encontrado en esta portería/i);
    await expect(
      como(t, "beto").mutation(api.guardia.cerrarTurnoDeCompanero, {
        turnoId: turnoSur,
        condominioId: e.sur,
      }),
    ).rejects.toThrow(/no pertenece a este condominio/i);
    expect((await leerTurno(t, turnoSur)).estado).toBe("abierto");
  });

  test("sin autorización vigente no se ejecuta: membresía retirada, cuenta inactiva, sin sesión", async () => {
    const intento = (quien?: string) =>
      (quien ? como(t, quien) : t).mutation(api.guardia.cerrarTurnoDeCompanero, {
        turnoId: turnoNorte,
        condominioId: e.norte,
      });
    await expect(intento("raul")).rejects.toThrow(/no pertenece a este condominio/i);
    await expect(intento("ivan")).rejects.toThrow(/usuario inactivo/i);
    await expect(intento()).rejects.toThrow(/no autenticado/i);
    await sinCambios();
  });

  test("ids inexistentes o manipulados se rechazan sin escribir nada", async () => {
    const borrado = await t.run(async (ctx) => {
      const id = await ctx.db.insert("guardiaTurnos", {
        condominioId: e.norte,
        guardiaUserId: e.ana,
        guardiaNombre: "Ana Guarda",
        checklist: CHECKLIST,
        estado: "cerrado",
        fechaInicio: AHORA,
        createdAt: AHORA,
        updatedAt: AHORA,
      });
      await ctx.db.delete(id);
      return id;
    });
    const intento = (turnoId: string, condominioId: string = e.norte) =>
      como(t, "beto").mutation(api.guardia.cerrarTurnoDeCompanero, {
        turnoId: turnoId as Id<"guardiaTurnos">,
        condominioId: condominioId as Id<"condominios">,
      });

    await expect(intento(borrado)).rejects.toThrow(/turno no encontrado en esta portería/i);
    // El id de otra tabla en lugar del turno, y un texto que no es un id.
    await expect(intento(e.norte)).rejects.toThrow();
    await expect(intento("no-es-un-id")).rejects.toThrow();
    // El turno bien, pero un conjunto que no es un conjunto.
    await expect(intento(turnoNorte, turnoNorte)).rejects.toThrow();
    await sinCambios();
  });
});

describe("sin estados inconsistentes ni registros engañosos", () => {
  let t: T;
  let e: Escenario;
  let turnoId: Id<"guardiaTurnos">;

  beforeEach(async () => {
    t = convexTest(schema, modules);
    e = await escenario(t);
    turnoId = await abrir(t, "ana", e.norte);
  });

  afterEach(() => vi.mocked(logMinuta).mockClear());

  test("un turno ya cerrado no se vuelve a cerrar", async () => {
    await como(t, "beto").mutation(api.guardia.cerrarTurnoDeCompanero, { turnoId, condominioId: e.norte });
    const cerrado = await leerTurno(t, turnoId);

    await expect(
      como(t, "carla").mutation(api.guardia.cerrarTurnoDeCompanero, { turnoId, condominioId: e.norte }),
    ).rejects.toThrow(/ya está cerrado/i);
    await expect(
      como(t, "beto").mutation(api.guardia.cerrarTurnoDeCompanero, { turnoId, condominioId: e.norte }),
    ).rejects.toThrow(/ya está cerrado/i);

    expect(await leerTurno(t, turnoId)).toEqual(cerrado);
    expect(await cierresDe(t, e.norte, turnoId)).toHaveLength(1);
  });

  test("dos compañeros a la vez: uno lo cierra, el otro recibe el rechazo y la minuta cuenta un cierre", async () => {
    const resultados = await Promise.allSettled([
      como(t, "beto").mutation(api.guardia.cerrarTurnoDeCompanero, { turnoId, condominioId: e.norte }),
      como(t, "carla").mutation(api.guardia.cerrarTurnoDeCompanero, { turnoId, condominioId: e.norte }),
    ]);
    const ok = resultados.filter((r) => r.status === "fulfilled");
    const rechazos = resultados.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(rechazos).toHaveLength(1);
    expect(String(rechazos[0]!.reason)).toMatch(/ya está cerrado/i);

    const ganador = resultados[0]!.status === "fulfilled" ? e.beto : e.carla;
    const turno = await leerTurno(t, turnoId);
    expect(turno.cerradoPorUserId).toBe(ganador);
    const cierres = await cierresDe(t, e.norte, turnoId);
    expect(cierres).toHaveLength(1);
    expect(cierres[0]!.actorUserId).toBe(ganador);
  });

  test("Ana cierra el suyo mientras Beto confirma: un solo cierre, y la minuta dice cuál", async () => {
    const resultados = await Promise.allSettled([
      como(t, "ana").mutation(api.guardia.cerrarTurno, { turnoId }),
      como(t, "beto").mutation(api.guardia.cerrarTurnoDeCompanero, { turnoId, condominioId: e.norte }),
    ]);
    expect(resultados.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const ganoAna = resultados[0]!.status === "fulfilled";

    const cierres = await cierresDe(t, e.norte, turnoId);
    expect(cierres).toHaveLength(1);
    // El registro coincide con quien de verdad cerró, sea cual sea.
    expect(cierres[0]!.tipo).toBe(ganoAna ? "Cierre de Turno" : TIPO);
    expect(cierres[0]!.actorUserId).toBe(ganoAna ? e.ana : e.beto);
    expect((await leerTurno(t, turnoId)).cerradoPorUserId).toBe(ganoAna ? e.ana : e.beto);
  });

  test("lo que vio ya no vale: si mientras tanto se cerró y se abrió otro, no cierra el nuevo", async () => {
    const visto = (await como(t, "beto").query(api.guardia.turnoActivo, { condominioId: e.norte }))!;
    await como(t, "ana").mutation(api.guardia.cerrarTurno, { turnoId });
    const nuevo = await abrir(t, "carla", e.norte);

    await expect(
      como(t, "beto").mutation(api.guardia.cerrarTurnoDeCompanero, {
        turnoId: visto._id,
        condominioId: e.norte,
      }),
    ).rejects.toThrow(/ya está cerrado/i);
    const turnoNuevo = await leerTurno(t, nuevo);
    expect(turnoNuevo.estado).toBe("abierto");
    expect(turnoNuevo.cerradoPorUserId).toBeUndefined();
    expect(await cierresDe(t, e.norte, nuevo)).toEqual([]);
  });

  test("si falla el registro en la minuta, el turno no queda cerrado (todo o nada) y se puede reintentar", async () => {
    const antes = await leerTurno(t, turnoId);
    const minutaAntes = await minutaDe(t, e.norte);
    vi.mocked(logMinuta).mockImplementationOnce(async () => {
      throw new Error("Falla simulada al escribir la minuta");
    });

    await expect(
      como(t, "beto").mutation(api.guardia.cerrarTurnoDeCompanero, { turnoId, condominioId: e.norte }),
    ).rejects.toThrow(/falla simulada/i);
    // El patch del turno corrió antes que la minuta, y se deshizo con ella.
    expect(await leerTurno(t, turnoId)).toEqual(antes);
    expect(await minutaDe(t, e.norte)).toEqual(minutaAntes);

    await como(t, "beto").mutation(api.guardia.cerrarTurnoDeCompanero, { turnoId, condominioId: e.norte });
    expect((await leerTurno(t, turnoId)).estado).toBe("cerrado");
    expect(await cierresDe(t, e.norte, turnoId)).toHaveLength(1);
  });
});

describe("los demás cierres y roles siguen como estaban", () => {
  let t: T;
  let e: Escenario;
  let turnoId: Id<"guardiaTurnos">;

  beforeEach(async () => {
    t = convexTest(schema, modules);
    e = await escenario(t);
    turnoId = await abrir(t, "ana", e.norte);
  });

  test("el guarda cierra el suyo como antes, sin rastro de compañero", async () => {
    await como(t, "ana").mutation(api.guardia.cerrarTurno, { turnoId });
    const turno = await leerTurno(t, turnoId);
    expect(turno.estado).toBe("cerrado");
    expect(turno.cerradoPorUserId).toBe(e.ana);
    expect(turno.observacionesCierre).toBeUndefined();
    const cierres = await cierresDe(t, e.norte, turnoId);
    expect(cierres.map((c) => [c.tipo, c.resumen])).toEqual([
      ["Cierre de Turno", "Turno de Ana Guarda cerrado por Ana Guarda."],
    ]);
  });

  test("el cierre normal sigue sin dejar que otro guarda cierre el turno ajeno", async () => {
    await expect(como(t, "beto").mutation(api.guardia.cerrarTurno, { turnoId })).rejects.toThrow(
      /solo el guardia del turno/i,
    );
    expect((await leerTurno(t, turnoId)).estado).toBe("abierto");
  });

  test("el suyo no se cierra por la vía del compañero, ni siendo el secundario", async () => {
    await expect(
      como(t, "ana").mutation(api.guardia.cerrarTurnoDeCompanero, { turnoId, condominioId: e.norte }),
    ).rejects.toThrow(/este turno es tuyo/i);
    await como(t, "ana").mutation(api.guardia.cerrarTurno, { turnoId });

    const compartido = await abrir(t, "ana", e.norte, { guardiaSecundarioUserId: e.beto });
    expect(
      (await como(t, "beto").query(api.guardia.turnoActivo, { condominioId: e.norte }))!.cierraComo,
    ).toBe("propio");
    await expect(
      como(t, "beto").mutation(api.guardia.cerrarTurnoDeCompanero, {
        turnoId: compartido,
        condominioId: e.norte,
      }),
    ).rejects.toThrow(/este turno es tuyo/i);
    expect((await leerTurno(t, compartido)).estado).toBe("abierto");
  });

  test("administración y junta no ganan esta vía; siguen cerrando con la de siempre", async () => {
    for (const quien of ["admin", "junta"]) {
      await expect(
        como(t, quien).mutation(api.guardia.cerrarTurnoDeCompanero, { turnoId, condominioId: e.norte }),
        quien,
      ).rejects.toThrow(/no tiene el rol requerido/i);
    }
    await como(t, "admin").mutation(api.guardia.cerrarTurno, { turnoId });
    expect((await leerTurno(t, turnoId)).cerradoPorUserId).toBe(e.admin);
  });

  test("un residente no cierra turnos por ninguna vía", async () => {
    await expect(
      como(t, "rita").mutation(api.guardia.cerrarTurnoDeCompanero, { turnoId, condominioId: e.norte }),
    ).rejects.toThrow(/no tiene el rol requerido/i);
    await expect(como(t, "rita").mutation(api.guardia.cerrarTurno, { turnoId })).rejects.toThrow();
    await expect(
      como(t, "rita").query(api.guardia.turnoActivo, { condominioId: e.norte }),
    ).rejects.toThrow();
    expect((await leerTurno(t, turnoId)).estado).toBe("abierto");
  });
});

/**
 * Con la compañía de vigilancia: el guarda asignado por la compañía es
 * compañero de portería igual que el del conjunto, el supervisor no releva, y
 * una cobertura activa cambia en qué portería se opera —y por tanto dónde se
 * puede cerrar—.
 */
describe("guardas de compañía, supervisores y coberturas", () => {
  beforeEach(() => vi.setSystemTime(T17));
  afterEach(() => vi.useRealTimers());

  async function conLucia() {
    const e = await montar();
    const lucia = await e.t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {
        name: "Lucía Local",
        email: "lucia@vekino.test",
        emailVerified: true,
        active: true,
        authId: "lucia",
        createdAt: T17,
        updatedAt: T17,
      });
      await ctx.db.insert("memberships", {
        userId,
        condominioId: e.alamos,
        roles: ["guardia"],
        isActive: true,
        createdAt: T17,
        updatedAt: T17,
      });
      return userId;
    });
    return { ...e, lucia };
  }

  test("la guarda del conjunto cierra el turno olvidado del guarda de compañía, y al revés", async () => {
    const e = await conLucia();
    const deJason = await e.como("jason").mutation(api.guardia.iniciarTurno, {
      condominioId: e.alamos,
      checklist: CHECKLIST,
    });
    expect(
      (await e.como("lucia").query(api.guardia.turnoActivo, { condominioId: e.alamos }))!.cierraComo,
    ).toBe("companero");
    await e.como("lucia").mutation(api.guardia.cerrarTurnoDeCompanero, {
      turnoId: deJason,
      condominioId: e.alamos,
    });
    expect((await e.t.run((ctx) => ctx.db.get(deJason)))!.cerradoPorUserId).toBe(e.lucia);

    const deLucia = await e.como("lucia").mutation(api.guardia.iniciarTurno, {
      condominioId: e.alamos,
      checklist: CHECKLIST,
    });
    await e.como("jason").mutation(api.guardia.cerrarTurnoDeCompanero, {
      turnoId: deLucia,
      condominioId: e.alamos,
    });
    const minuta = await e.t.run((ctx) =>
      ctx.db
        .query("minutaEventos")
        .withIndex("by_turno", (q) => q.eq("turnoId", deLucia))
        .collect(),
    );
    const cierre = minuta.find((m) => m.tipo === TIPO)!;
    expect(cierre.actorUserId).toBe(e.jason);
    expect(cierre.resumen).toMatch(/^Turno de Lucía Local cerrado por Jason Valderrama/);
  });

  test("el supervisor y la administración de la compañía no lo cierran", async () => {
    const e = await conLucia();
    const turnoId = await e.como("lucia").mutation(api.guardia.iniciarTurno, {
      condominioId: e.alamos,
      checklist: CHECKLIST,
    });
    for (const quien of ["sofia", "alicia"]) {
      await expect(
        e.como(quien).mutation(api.guardia.cerrarTurnoDeCompanero, { turnoId, condominioId: e.alamos }),
        quien,
      ).rejects.toThrow();
    }
    expect((await e.t.run((ctx) => ctx.db.get(turnoId)))!.estado).toBe("abierto");
  });

  test("con una cobertura activa se cierra en la portería que cubre, no en la de siempre", async () => {
    const e = await conLucia();
    const enAlamos = await e.como("lucia").mutation(api.guardia.iniciarTurno, {
      condominioId: e.alamos,
      checklist: CHECKLIST,
    });
    const enBosque = await e.como("bruno").mutation(api.guardia.iniciarTurno, {
      condominioId: e.bosque,
      checklist: CHECKLIST,
    });
    // Jason pasa a cubrir Bosque: Alamos, su portería de siempre, queda suspendida.
    await e.cubrir(e.bosque, e.kBosque, T17 - HORA, T17 + 12 * HORA);

    await expect(
      e.como("jason").mutation(api.guardia.cerrarTurnoDeCompanero, {
        turnoId: enAlamos,
        condominioId: e.alamos,
      }),
    ).rejects.toThrow();
    expect((await e.t.run((ctx) => ctx.db.get(enAlamos)))!.estado).toBe("abierto");

    await e.como("jason").mutation(api.guardia.cerrarTurnoDeCompanero, {
      turnoId: enBosque,
      condominioId: e.bosque,
    });
    const turno = (await e.t.run((ctx) => ctx.db.get(enBosque)))!;
    expect(turno.estado).toBe("cerrado");
    expect(turno.cerradoPorUserId).toBe(e.jason);
    expect(turno.guardiaUserId).toBe(e.bruno);
  });
});
