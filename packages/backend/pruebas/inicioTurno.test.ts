import { test, expect, describe, beforeEach } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

const modules = import.meta.glob("../convex/**/*.ts");

/**
 * EL INICIO DE TURNO SIMPLIFICADO.
 *
 * El guarda ya no escribe su nombre ni las observaciones iniciales: quién toma
 * el turno lo dice la sesión, y las observaciones quedan ocultas. El checklist
 * de dotación y el compañero de turno siguen igual. Estas pruebas van por la
 * API pública —la misma que llaman la web y el móvil— y comprueban también
 * que lo de antes (apps sin actualizar, turnos viejos) sigue funcionando.
 */

const AHORA = Date.now();

type T = ReturnType<typeof convexTest>;
const como = (t: T, subject: string) => t.withIdentity({ subject });

const CHECKLIST = [
  { item: "Bastón", obligatorio: true, cantidadEsperada: 1, cantidadEncontrada: 1, estadoOk: true },
  {
    item: "  Radio  ",
    obligatorio: true,
    cantidadEsperada: 1,
    cantidadEncontrada: 1,
    estadoOk: false,
    observacion: "  Antena floja  ",
  },
  { item: "Llaves", obligatorio: false, cantidadEsperada: 3, cantidadEncontrada: 2, estadoOk: true },
];

async function escenario(t: T) {
  return await t.run(async (ctx) => {
    const norte = await ctx.db.insert("condominios", {
      name: "Conjunto Norte",
      activeModules: [],
      isActive: true,
      createdAt: AHORA,
      updatedAt: AHORA,
    });

    const persona = async (
      name: string,
      authId: string,
      roles: string[],
      extra: { firstName?: string; lastName?: string } = {},
    ) => {
      const userId = await ctx.db.insert("users", {
        name,
        ...extra,
        email: `${authId}@vekino.test`,
        emailVerified: true,
        active: true,
        authId,
        createdAt: AHORA,
        updatedAt: AHORA,
      });
      await ctx.db.insert("memberships", {
        userId,
        condominioId: norte,
        roles: roles as never,
        isActive: true,
        createdAt: AHORA,
        updatedAt: AHORA,
      });
      return userId;
    };

    return {
      norte,
      ana: await persona("Ana Guarda", "ana", ["guardia"]),
      beto: await persona("Beto Guarda", "beto", ["guardia"]),
      /* Nombre del perfil distinto del nombre completo estructurado: el turno
       * usa el mismo nombre visible que el resto de la portería. */
      dora: await persona("dora", "dora", ["guardia"], {
        firstName: "Dora",
        lastName: "Díaz",
      }),
      admin: await persona("Adriana Admin", "admin", ["administrador"]),
    };
  });
}

type Escenario = Awaited<ReturnType<typeof escenario>>;

async function leerTurno(t: T, turnoId: Id<"guardiaTurnos">) {
  return await t.run(async (ctx) => (await ctx.db.get(turnoId))!);
}

async function eventoDeInicio(t: T, turnoId: Id<"guardiaTurnos">) {
  return await t.run(async (ctx) => {
    const eventos = await ctx.db
      .query("minutaEventos")
      .withIndex("by_turno", (q) => q.eq("turnoId", turnoId))
      .collect();
    return eventos.find((ev) => ev.tipo === "Inicio de Turno")!;
  });
}

describe("caso 1 — inicio normal: la identidad sale de la sesión", () => {
  let t: T;
  let e: Escenario;
  beforeEach(async () => {
    t = convexTest(schema, modules);
    e = await escenario(t);
  });

  test("sin nombre ni observaciones: el turno queda a nombre de quien inició sesión", async () => {
    const turnoId = await como(t, "ana").mutation(api.guardia.iniciarTurno, {
      condominioId: e.norte,
      checklist: CHECKLIST,
    });

    const turno = await leerTurno(t, turnoId);
    expect(turno.guardiaUserId).toBe(e.ana);
    expect(turno.guardiaNombre).toBe("Ana Guarda");
    expect(turno.estado).toBe("abierto");

    const ev = await eventoDeInicio(t, turnoId);
    expect(ev.resumen).toBe("Turno iniciado por Ana Guarda. Checklist: 3 ítems.");
    expect(ev.actorUserId).toBe(e.ana);
    expect(ev.actorNombre).toBe("Ana Guarda");

    const activo = await como(t, "ana").query(api.guardia.turnoActivo, {
      condominioId: e.norte,
    });
    expect(activo!._id).toBe(turnoId);
    expect(activo!.guardiaNombre).toBe("Ana Guarda");
  });

  test("el nombre es el mismo que la portería muestra en la cabecera", async () => {
    const home = await como(t, "dora").query(api.guardia.home, {
      condominioId: e.norte,
    });
    const turnoId = await como(t, "dora").mutation(api.guardia.iniciarTurno, {
      condominioId: e.norte,
      checklist: CHECKLIST,
    });
    expect(home.allowed && home.userName).toBe("Dora Díaz");
    expect((await leerTurno(t, turnoId)).guardiaNombre).toBe("Dora Díaz");
  });

  test("app sin actualizar: el nombre escrito a mano no reemplaza al de la sesión", async () => {
    const turnoId = await como(t, "ana").mutation(api.guardia.iniciarTurno, {
      condominioId: e.norte,
      checklist: CHECKLIST,
      guardiaNombre: "José Pérez",
    });
    const turno = await leerTurno(t, turnoId);
    expect(turno.guardiaUserId).toBe(e.ana);
    expect(turno.guardiaNombre).toBe("Ana Guarda");
    expect((await eventoDeInicio(t, turnoId)).actorNombre).toBe("Ana Guarda");
  });

  test("el checklist de dotación se guarda igual que antes", async () => {
    const turnoId = await como(t, "ana").mutation(api.guardia.iniciarTurno, {
      condominioId: e.norte,
      checklist: CHECKLIST,
    });
    expect((await leerTurno(t, turnoId)).checklist).toEqual([
      { item: "Bastón", obligatorio: true, cantidadEsperada: 1, cantidadEncontrada: 1, estadoOk: true },
      {
        item: "Radio",
        obligatorio: true,
        cantidadEsperada: 1,
        cantidadEncontrada: 1,
        estadoOk: false,
        observacion: "Antena floja",
      },
      { item: "Llaves", obligatorio: false, cantidadEsperada: 3, cantidadEncontrada: 2, estadoOk: true },
    ]);

    /* Y se sigue viendo después: el detalle del administrador lo trae. */
    const detalle = await como(t, "admin").query(api.guardia.getTurno, { turnoId });
    expect(detalle!.checklist).toHaveLength(3);
    expect(detalle!.checklist[1]!.observacion).toBe("Antena floja");
  });

  test("las validaciones de siempre no cambian", async () => {
    await expect(
      como(t, "ana").mutation(api.guardia.iniciarTurno, {
        condominioId: e.norte,
        checklist: [],
      }),
    ).rejects.toThrow(/al menos un ítem/);

    await como(t, "ana").mutation(api.guardia.iniciarTurno, {
      condominioId: e.norte,
      checklist: CHECKLIST,
    });
    await expect(
      como(t, "beto").mutation(api.guardia.iniciarTurno, {
        condominioId: e.norte,
        checklist: CHECKLIST,
      }),
    ).rejects.toThrow(/Ya hay un turno abierto \(Ana Guarda\)/);
  });
});

describe("caso 2 — sin observaciones iniciales", () => {
  test("el turno inicia y no guarda observaciones", async () => {
    const t = convexTest(schema, modules);
    const e = await escenario(t);
    const turnoId = await como(t, "ana").mutation(api.guardia.iniciarTurno, {
      condominioId: e.norte,
      checklist: CHECKLIST,
    });
    expect((await leerTurno(t, turnoId)).observacionesInicio).toBeUndefined();
  });

  test("vacías o de solo espacios no se guardan como texto", async () => {
    const t = convexTest(schema, modules);
    const e = await escenario(t);
    const turnoId = await como(t, "ana").mutation(api.guardia.iniciarTurno, {
      condominioId: e.norte,
      checklist: CHECKLIST,
      observacionesInicio: "  \n ",
    });
    expect((await leerTurno(t, turnoId)).observacionesInicio).toBeUndefined();
  });

  test("app sin actualizar que todavía las manda: se guardan como siempre", async () => {
    const t = convexTest(schema, modules);
    const e = await escenario(t);
    const turnoId = await como(t, "ana").mutation(api.guardia.iniciarTurno, {
      condominioId: e.norte,
      checklist: CHECKLIST,
      observacionesInicio: "  Recibo con la reja del parqueadero trabada.  ",
    });
    expect((await leerTurno(t, turnoId)).observacionesInicio).toBe(
      "Recibo con la reja del parqueadero trabada.",
    );
  });
});

describe("casos 3 y 4 — compañero de turno", () => {
  let t: T;
  let e: Escenario;
  beforeEach(async () => {
    t = convexTest(schema, modules);
    e = await escenario(t);
  });

  test("sin compañero: el turno inicia y no queda compartido", async () => {
    const turnoId = await como(t, "ana").mutation(api.guardia.iniciarTurno, {
      condominioId: e.norte,
      checklist: CHECKLIST,
      guardiaSecundarioNombre: "   ",
    });
    const turno = await leerTurno(t, turnoId);
    expect(turno.guardiaSecundarioNombre).toBeUndefined();
    expect(turno.guardiaSecundarioUserId).toBeUndefined();
    expect((await eventoDeInicio(t, turnoId)).resumen).not.toContain("compartido");
  });

  test("con compañero escrito: se guarda y sale en la minuta", async () => {
    const turnoId = await como(t, "ana").mutation(api.guardia.iniciarTurno, {
      condominioId: e.norte,
      checklist: CHECKLIST,
      guardiaSecundarioNombre: "  Beto Guarda ",
    });
    const turno = await leerTurno(t, turnoId);
    expect(turno.guardiaNombre).toBe("Ana Guarda");
    expect(turno.guardiaSecundarioNombre).toBe("Beto Guarda");
    expect((await eventoDeInicio(t, turnoId)).resumen).toBe(
      "Turno iniciado por Ana Guarda (compartido con Beto Guarda). Checklist: 3 ítems.",
    );
  });

  test("con compañero por usuario (vía heredada): sigue funcionando", async () => {
    const turnoId = await como(t, "ana").mutation(api.guardia.iniciarTurno, {
      condominioId: e.norte,
      checklist: CHECKLIST,
      guardiaSecundarioUserId: e.beto,
    });
    const turno = await leerTurno(t, turnoId);
    expect(turno.guardiaSecundarioUserId).toBe(e.beto);
    expect(turno.guardiaSecundarioNombre).toBe("Beto Guarda");
  });

  test("el compañero no puede ser quien inicia: se compara contra la sesión", async () => {
    await expect(
      como(t, "ana").mutation(api.guardia.iniciarTurno, {
        condominioId: e.norte,
        checklist: CHECKLIST,
        guardiaSecundarioNombre: "ana guarda",
      }),
    ).rejects.toThrow(/no puede ser el mismo nombre/);

    /* Aunque una app vieja mande otro nombre para quien inicia. */
    await expect(
      como(t, "ana").mutation(api.guardia.iniciarTurno, {
        condominioId: e.norte,
        checklist: CHECKLIST,
        guardiaNombre: "José Pérez",
        guardiaSecundarioNombre: "Ana Guarda",
      }),
    ).rejects.toThrow(/no puede ser el mismo nombre/);

    await expect(
      como(t, "ana").mutation(api.guardia.iniciarTurno, {
        condominioId: e.norte,
        checklist: CHECKLIST,
        guardiaSecundarioUserId: e.ana,
      }),
    ).rejects.toThrow(/no puede ser el mismo/);
  });

  test("el compañero también puede cerrar el turno compartido", async () => {
    const turnoId = await como(t, "ana").mutation(api.guardia.iniciarTurno, {
      condominioId: e.norte,
      checklist: CHECKLIST,
      guardiaSecundarioUserId: e.beto,
    });
    await como(t, "beto").mutation(api.guardia.cerrarTurno, { turnoId });
    expect((await leerTurno(t, turnoId)).estado).toBe("cerrado");
  });
});

describe("caso 5 — turnos anteriores al cambio", () => {
  test("un turno con nombre escrito y observaciones iniciales se sigue leyendo y cerrando", async () => {
    const t = convexTest(schema, modules);
    const e = await escenario(t);
    /* Tal como lo dejaba el inicio de antes en una cuenta compartida: el
     * nombre escrito a mano y las observaciones iniciales. */
    const antiguo = await t.run(async (ctx) =>
      ctx.db.insert("guardiaTurnos", {
        condominioId: e.norte,
        guardiaUserId: e.ana,
        guardiaNombre: "José Pérez",
        guardiaSecundarioNombre: "Luis Gómez",
        observacionesInicio: "Recibo sin novedad.",
        checklist: CHECKLIST,
        estado: "abierto",
        fechaInicio: AHORA - 6 * 3_600_000,
        createdAt: AHORA - 6 * 3_600_000,
        updatedAt: AHORA - 6 * 3_600_000,
      }),
    );

    const activo = await como(t, "ana").query(api.guardia.turnoActivo, {
      condominioId: e.norte,
    });
    expect(activo!.guardiaNombre).toBe("José Pérez");
    expect(activo!.observacionesInicio).toBe("Recibo sin novedad.");

    const lista = await como(t, "admin").query(api.guardia.listTurnos, {
      condominioId: e.norte,
    });
    expect(lista.find((x) => x._id === antiguo)!.observacionesInicio).toBe(
      "Recibo sin novedad.",
    );

    await como(t, "ana").mutation(api.guardia.cerrarTurno, { turnoId: antiguo });
    const detalle = await como(t, "admin").query(api.guardia.getTurno, {
      turnoId: antiguo,
    });
    expect(detalle!.estado).toBe("cerrado");
    expect(detalle!.guardiaNombre).toBe("José Pérez");
    expect(detalle!.guardiaSecundarioNombre).toBe("Luis Gómez");
    expect(detalle!.observacionesInicio).toBe("Recibo sin novedad.");

    /* Y el turno nuevo convive con él, ya con el nombre de la sesión. */
    const nuevo = await como(t, "ana").mutation(api.guardia.iniciarTurno, {
      condominioId: e.norte,
      checklist: CHECKLIST,
    });
    const ambos = await como(t, "admin").query(api.guardia.listTurnos, {
      condominioId: e.norte,
    });
    const porId = new Map(ambos.map((x) => [x._id, x]));
    expect(porId.get(antiguo)!.guardiaNombre).toBe("José Pérez");
    expect(porId.get(nuevo)!.guardiaNombre).toBe("Ana Guarda");
    expect(porId.get(nuevo)!.observacionesInicio).toBeUndefined();
  });
});
