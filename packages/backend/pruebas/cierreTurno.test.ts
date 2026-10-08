import { test, expect, describe, beforeEach } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

const modules = import.meta.glob("../convex/**/*.ts");

/**
 * EL CIERRE DE TURNO DEL GUARDA.
 *
 * El cierre dejó de ser "consignas + un nombre": ahora dice con qué elementos
 * se entrega el puesto, si volvieron con novedad, a qué guarda se le entrega y
 * cómo terminó la jornada. Estas pruebas van por la API pública —la misma que
 * llaman la web y el móvil— y comprueban las dos mitades: que lo válido queda
 * guardado entero en el turno correcto, y que lo inválido no escribe NADA.
 *
 * Los elementos son el `checklist` firmado al iniciar. El cierre no los
 * recibe, no los copia y no los puede cambiar.
 */

const AHORA = Date.now();

type T = ReturnType<typeof convexTest>;
const como = (t: T, subject: string) => t.withIdentity({ subject });

const CHECKLIST = [
  { item: "Bastón", obligatorio: true, cantidadEsperada: 1, cantidadEncontrada: 1, estadoOk: true },
  { item: "Linterna", obligatorio: true, cantidadEsperada: 1, cantidadEncontrada: 1, estadoOk: true },
  {
    item: "Radio",
    obligatorio: true,
    cantidadEsperada: 1,
    cantidadEncontrada: 1,
    estadoOk: false,
    observacion: "Antena floja",
  },
  { item: "Llaves", obligatorio: true, cantidadEsperada: 3, cantidadEncontrada: 3, estadoOk: true },
];

const OBSERVACIONES =
  "Turno finalizado sin novedades adicionales. Se entrega puesto, documentación y elementos al guarda de relevo.";

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
      isActive = true,
    ) => {
      const userId = await ctx.db.insert("users", {
        name,
        email: `${authId}@vekino.test`,
        emailVerified: true,
        active: true,
        authId,
        createdAt: AHORA,
        updatedAt: AHORA,
      });
      await ctx.db.insert("memberships", {
        userId,
        condominioId,
        roles: roles as never,
        isActive,
        createdAt: AHORA,
        updatedAt: AHORA,
      });
      return userId;
    };

    return {
      norte,
      ana: await persona("Ana Guarda", "ana", norte, ["guardia"]),
      beto: await persona("Beto Guarda", "beto", norte, ["guardia"]),
      carla: await persona("Carla Guarda", "carla", norte, ["guardia"]),
      admin: await persona("Adriana Admin", "admin", norte, ["administrador"]),
      residente: await persona("Rita Residente", "rita", norte, ["residente"]),
      retirado: await persona("Raúl Retirado", "raul", norte, ["guardia"], false),
      deOtroConjunto: await persona("Sergio Sur", "sergio", sur, ["guardia"]),
    };
  });
}

type Escenario = Awaited<ReturnType<typeof escenario>>;

/** Ana abre el turno de Norte con el checklist de dotación. */
async function abrirTurno(t: T, e: Escenario, extra: object = {}) {
  return await como(t, "ana").mutation(api.guardia.iniciarTurno, {
    condominioId: e.norte,
    checklist: CHECKLIST,
    guardiaNombre: "Ana Guarda",
    ...extra,
  });
}

/** Un cierre válido, sin novedades, entregado a Beto. */
function cierreValido(e: Escenario, turnoId: Id<"guardiaTurnos">) {
  return {
    turnoId,
    recibeUserId: e.beto,
    consignas: "Paquete del 402 en portería.",
    observacionesCierre: OBSERVACIONES,
    novedadesElementos: false,
  };
}

async function leerTurno(t: T, turnoId: Id<"guardiaTurnos">) {
  return await t.run(async (ctx) => (await ctx.db.get(turnoId))!);
}

describe("el guarda cierra su turno", () => {
  let t: T;
  let e: Escenario;
  let turnoId: Id<"guardiaTurnos">;

  beforeEach(async () => {
    t = convexTest(schema, modules);
    e = await escenario(t);
    turnoId = await abrirTurno(t, e);
  });

  test("ve los elementos que se le asignaron al iniciar, tal como se firmaron", async () => {
    const turno = await como(t, "ana").query(api.guardia.turnoActivo, {
      condominioId: e.norte,
    });
    expect(turno!._id).toBe(turnoId);
    expect(turno!.checklist.map((c) => c.item)).toEqual([
      "Bastón",
      "Linterna",
      "Radio",
      "Llaves",
    ]);
    // Con lo que se encontró al recibirlos, incluida la novedad de inicio.
    const radio = turno!.checklist.find((c) => c.item === "Radio")!;
    expect(radio.estadoOk).toBe(false);
    expect(radio.observacion).toBe("Antena floja");
    expect(turno!.checklist.find((c) => c.item === "Llaves")!.cantidadEncontrada).toBe(3);
  });

  test("el selector de relevo ofrece a los otros guardas vigentes, no a quien cierra", async () => {
    const equipo = await como(t, "ana").query(api.guardia.equipo, {
      condominioId: e.norte,
    });
    expect(equipo.map((g) => g.nombre)).toEqual(["Beto Guarda", "Carla Guarda"]);
  });

  test("cierre sin novedades: queda todo guardado en el turno correcto", async () => {
    await como(t, "ana").mutation(api.guardia.cerrarTurno, cierreValido(e, turnoId));

    const turno = await leerTurno(t, turnoId);
    expect(turno.estado).toBe("cerrado");
    expect(turno.fechaCierre).toBeTypeOf("number");
    expect(turno.cerradoPorUserId).toBe(e.ana);
    expect(turno.recibeUserId).toBe(e.beto);
    expect(turno.recibe).toBe("Beto Guarda");
    expect(turno.consignas).toBe("Paquete del 402 en portería.");
    expect(turno.observacionesCierre).toBe(OBSERVACIONES);
    expect(turno.novedadesElementos).toBe(false);
    expect(turno.novedadesElementosDetalle).toBeUndefined();
    // Los elementos siguen siendo los del inicio: el cierre no los tocó.
    expect(turno.checklist).toEqual(CHECKLIST);

    const minuta = await como(t, "ana").query(api.guardia.listMinuta, {
      condominioId: e.norte,
    });
    const cierre = minuta.find((m) => m.tipo === "Cierre de Turno")!;
    expect(cierre.turnoId).toBe(turnoId);
    expect(cierre.resumen).toContain("Recibe: Beto Guarda");
    expect(cierre.resumen).toContain("Elementos sin novedad");

    // Y el turno ya no gobierna la portería: se puede abrir el siguiente.
    expect(
      await como(t, "beto").query(api.guardia.turnoActivo, { condominioId: e.norte }),
    ).toBeNull();
  });

  test("cierre con novedades: la descripción queda en el turno y en la minuta", async () => {
    const detalle =
      "La linterna presenta daño en el interruptor y el radio tiene la batería descargada.";
    await como(t, "ana").mutation(api.guardia.cerrarTurno, {
      ...cierreValido(e, turnoId),
      novedadesElementos: true,
      novedadesElementosDetalle: `  ${detalle}  `,
    });

    const turno = await leerTurno(t, turnoId);
    expect(turno.novedadesElementos).toBe(true);
    expect(turno.novedadesElementosDetalle).toBe(detalle);

    const minuta = await como(t, "ana").query(api.guardia.listMinuta, {
      condominioId: e.norte,
    });
    expect(minuta.find((m) => m.tipo === "Cierre de Turno")!.resumen).toContain(detalle);
  });

  test("el detalle de novedades no se guarda si el checkbox quedó apagado", async () => {
    await como(t, "ana").mutation(api.guardia.cerrarTurno, {
      ...cierreValido(e, turnoId),
      novedadesElementos: false,
      novedadesElementosDetalle: "Texto escrito y luego desmarcado",
    });
    expect((await leerTurno(t, turnoId)).novedadesElementosDetalle).toBeUndefined();
  });

  test("el detalle de novedades del cierre queda en getTurno junto a quién cerró", async () => {
    await como(t, "ana").mutation(api.guardia.cerrarTurno, {
      ...cierreValido(e, turnoId),
      novedadesElementos: true,
      novedadesElementosDetalle: "Falta una llave del juego",
    });
    const detalle = await como(t, "admin").query(api.guardia.getTurno, { turnoId });
    expect(detalle!.cerradoPorNombre).toBe("Ana Guarda");
    expect(detalle!.recibe).toBe("Beto Guarda");
    expect(detalle!.novedadesElementosDetalle).toBe("Falta una llave del juego");
    expect(detalle!.checklist).toEqual(CHECKLIST);
  });
});

describe("lo inválido no cierra el turno ni escribe nada", () => {
  let t: T;
  let e: Escenario;
  let turnoId: Id<"guardiaTurnos">;

  beforeEach(async () => {
    t = convexTest(schema, modules);
    e = await escenario(t);
    turnoId = await abrirTurno(t, e);
  });

  /** El turno sigue abierto y sin rastro de cierre. */
  async function sigueAbierto() {
    const turno = await leerTurno(t, turnoId);
    expect(turno.estado).toBe("abierto");
    expect(turno.fechaCierre).toBeUndefined();
    expect(turno.cerradoPorUserId).toBeUndefined();
    expect(turno.observacionesCierre).toBeUndefined();
    const minuta = await como(t, "ana").query(api.guardia.listMinuta, {
      condominioId: e.norte,
    });
    expect(minuta.some((m) => m.tipo === "Cierre de Turno")).toBe(false);
  }

  test("checkbox de novedades activado sin descripción", async () => {
    for (const detalle of [undefined, "", "    "]) {
      await expect(
        como(t, "ana").mutation(api.guardia.cerrarTurno, {
          ...cierreValido(e, turnoId),
          novedadesElementos: true,
          novedadesElementosDetalle: detalle,
        }),
      ).rejects.toThrow(/describe la novedad/i);
    }
    await sigueAbierto();
  });

  test("relevo inválido: alguien que no es guarda vigente de esta portería", async () => {
    for (const recibeUserId of [e.residente, e.admin, e.retirado, e.deOtroConjunto]) {
      await expect(
        como(t, "ana").mutation(api.guardia.cerrarTurno, {
          ...cierreValido(e, turnoId),
          recibeUserId,
        }),
      ).rejects.toThrow(/no es un guarda vigente/i);
    }
    await sigueAbierto();
  });

  test("relevo inválido: quien entrega no se recibe el turno a sí mismo", async () => {
    await expect(
      como(t, "ana").mutation(api.guardia.cerrarTurno, {
        ...cierreValido(e, turnoId),
        recibeUserId: e.ana,
      }),
    ).rejects.toThrow(/distinto de quien entrega/i);
    await sigueAbierto();
  });

  test("relevo inválido: el compañero del mismo turno tampoco lo recibe", async () => {
    await como(t, "ana").mutation(api.guardia.cerrarTurno, cierreValido(e, turnoId));
    const compartido = await abrirTurno(t, e, { guardiaSecundarioUserId: e.carla });
    await expect(
      como(t, "ana").mutation(api.guardia.cerrarTurno, {
        ...cierreValido(e, compartido),
        recibeUserId: e.carla,
      }),
    ).rejects.toThrow(/distinto de quien entrega/i);
  });

  test("los elementos no se pueden cambiar desde el cierre", async () => {
    /* No hay argumento para eso: mandar una lista la rechaza el validador. */
    await expect(
      como(t, "ana").mutation(api.guardia.cerrarTurno, {
        ...cierreValido(e, turnoId),
        checklist: [{ ...CHECKLIST[0], item: "Radio nuevo" }],
      } as never),
    ).rejects.toThrow();
    await sigueAbierto();
    expect((await leerTurno(t, turnoId)).checklist).toEqual(CHECKLIST);
  });

  test("un turno cerrado no se vuelve a cerrar", async () => {
    await como(t, "ana").mutation(api.guardia.cerrarTurno, cierreValido(e, turnoId));
    await expect(
      como(t, "ana").mutation(api.guardia.cerrarTurno, {
        ...cierreValido(e, turnoId),
        recibeUserId: e.carla,
        observacionesCierre: "Otra versión del cierre",
      }),
    ).rejects.toThrow(/ya está cerrado/i);
    const turno = await leerTurno(t, turnoId);
    expect(turno.recibeUserId).toBe(e.beto);
    expect(turno.observacionesCierre).toBe(OBSERVACIONES);
  });
});

describe("el relevo escrito a mano y las autorizaciones de siempre", () => {
  let t: T;
  let e: Escenario;
  let turnoId: Id<"guardiaTurnos">;

  beforeEach(async () => {
    t = convexTest(schema, modules);
    e = await escenario(t);
    turnoId = await abrirTurno(t, e);
  });

  test("cuenta compartida: el relevo sin usuario se registra por su nombre", async () => {
    await como(t, "ana").mutation(api.guardia.cerrarTurno, {
      turnoId,
      recibe: "  Pedro Relevo  ",
      consignas: "Nada pendiente",
      observacionesCierre: OBSERVACIONES,
      novedadesElementos: false,
    });
    const turno = await leerTurno(t, turnoId);
    expect(turno.recibe).toBe("Pedro Relevo");
    expect(turno.recibeUserId).toBeUndefined();
  });

  test("con un guarda elegido, el nombre sale de la base y no del cliente", async () => {
    await como(t, "ana").mutation(api.guardia.cerrarTurno, {
      ...cierreValido(e, turnoId),
      recibe: "Nombre inventado",
    });
    expect((await leerTurno(t, turnoId)).recibe).toBe("Beto Guarda");
  });

  test("otro guarda que no es del turno no lo puede cerrar", async () => {
    await expect(
      como(t, "carla").mutation(api.guardia.cerrarTurno, {
        ...cierreValido(e, turnoId),
      }),
    ).rejects.toThrow(/solo el guardia del turno/i);
  });

  test("un residente no puede cerrar turnos", async () => {
    await expect(
      como(t, "rita").mutation(api.guardia.cerrarTurno, cierreValido(e, turnoId)),
    ).rejects.toThrow();
  });

  test("el administrador puede cerrarlo, y queda dicho que fue él", async () => {
    await como(t, "admin").mutation(api.guardia.cerrarTurno, cierreValido(e, turnoId));
    const turno = await leerTurno(t, turnoId);
    expect(turno.estado).toBe("cerrado");
    expect(turno.cerradoPorUserId).toBe(e.admin);
  });
});

/**
 * EL CIERRE SIMPLIFICADO.
 *
 * Al guarda ya no se le piden elementos, relevo, consignas ni observaciones:
 * cierra con solo el turno (`CAMPOS_PEDIDOS_CIERRE`). Los campos siguen en el
 * esquema y en la mutación, y lo que llega igual —una app sin actualizar— se
 * valida y se guarda como siempre.
 */
describe("el cierre simplificado: el guarda cierra con solo el turno", () => {
  let t: T;
  let e: Escenario;
  let turnoId: Id<"guardiaTurnos">;

  beforeEach(async () => {
    t = convexTest(schema, modules);
    e = await escenario(t);
    turnoId = await abrirTurno(t, e);
  });

  test("cierra sin ningún dato del formulario y libera la portería", async () => {
    await como(t, "ana").mutation(api.guardia.cerrarTurno, { turnoId });

    const turno = await leerTurno(t, turnoId);
    expect(turno.estado).toBe("cerrado");
    expect(turno.fechaCierre).toBeTypeOf("number");
    expect(turno.cerradoPorUserId).toBe(e.ana);
    // Lo que no se pidió queda ausente: ni "" ni un "no" que nadie dijo.
    expect(turno.consignas).toBeUndefined();
    expect(turno.recibe).toBeUndefined();
    expect(turno.recibeUserId).toBeUndefined();
    expect(turno.observacionesCierre).toBeUndefined();
    expect(turno.novedadesElementos).toBeUndefined();
    expect(turno.novedadesElementosDetalle).toBeUndefined();
    expect(turno.checklist).toEqual(CHECKLIST);

    const minuta = await como(t, "ana").query(api.guardia.listMinuta, {
      condominioId: e.norte,
    });
    const cierre = minuta.find((m) => m.tipo === "Cierre de Turno")!;
    expect(cierre.turnoId).toBe(turnoId);
    expect(cierre.resumen).toBe("Turno de Ana Guarda cerrado por Ana Guarda.");

    // La portería queda libre y el relevo abre el siguiente turno.
    expect(
      await como(t, "beto").query(api.guardia.turnoActivo, { condominioId: e.norte }),
    ).toBeNull();
    await como(t, "beto").mutation(api.guardia.iniciarTurno, {
      condominioId: e.norte,
      checklist: CHECKLIST,
      guardiaNombre: "Beto Guarda",
    });
  });

  test("textos vacíos o de solo espacios no bloquean ni se guardan", async () => {
    await como(t, "ana").mutation(api.guardia.cerrarTurno, {
      turnoId,
      consignas: "",
      recibe: "   ",
      observacionesCierre: "  \n  ",
    });
    const turno = await leerTurno(t, turnoId);
    expect(turno.estado).toBe("cerrado");
    expect(turno.consignas).toBeUndefined();
    expect(turno.recibe).toBeUndefined();
    expect(turno.observacionesCierre).toBeUndefined();
  });

  test("una app sin actualizar que no contesta la pregunta de novedades cierra igual", async () => {
    /* Así llamaba una app móvil anterior a la pregunta de novedades. */
    await como(t, "ana").mutation(api.guardia.cerrarTurno, {
      turnoId,
      consignas: "Nada pendiente",
      recibe: "Beto",
      observacionesCierre: OBSERVACIONES,
    });
    const turno = await leerTurno(t, turnoId);
    expect(turno.estado).toBe("cerrado");
    expect(turno.consignas).toBe("Nada pendiente");
    expect(turno.recibe).toBe("Beto");
    expect(turno.observacionesCierre).toBe(OBSERVACIONES);
    // No contestó: no queda un "sin novedad" que nadie dijo.
    expect(turno.novedadesElementos).toBeUndefined();

    const minuta = await como(t, "ana").query(api.guardia.listMinuta, {
      condominioId: e.norte,
    });
    const resumen = minuta.find((m) => m.tipo === "Cierre de Turno")!.resumen;
    expect(resumen).toContain("Recibe: Beto.");
    expect(resumen).not.toContain("Elementos sin novedad");
  });

  test("lo que llega igual se sigue validando y, si está mal, no cierra", async () => {
    await expect(
      como(t, "ana").mutation(api.guardia.cerrarTurno, {
        turnoId,
        recibeUserId: e.deOtroConjunto,
      }),
    ).rejects.toThrow(/no es un guarda vigente/i);
    await expect(
      como(t, "ana").mutation(api.guardia.cerrarTurno, {
        turnoId,
        novedadesElementos: true,
      }),
    ).rejects.toThrow(/describe la novedad/i);
    const turno = await leerTurno(t, turnoId);
    expect(turno.estado).toBe("abierto");
    expect(turno.cerradoPorUserId).toBeUndefined();
  });

  test("las autorizaciones no cambian", async () => {
    await expect(
      como(t, "carla").mutation(api.guardia.cerrarTurno, { turnoId }),
    ).rejects.toThrow(/solo el guardia del turno/i);
    await expect(
      como(t, "rita").mutation(api.guardia.cerrarTurno, { turnoId }),
    ).rejects.toThrow();
    await como(t, "ana").mutation(api.guardia.cerrarTurno, { turnoId });
    await expect(
      como(t, "ana").mutation(api.guardia.cerrarTurno, { turnoId }),
    ).rejects.toThrow(/ya está cerrado/i);
  });

  test("el histórico mezcla cierres completos y simplificados sin romperse", async () => {
    // Un cierre con el formulario completo...
    await como(t, "ana").mutation(api.guardia.cerrarTurno, cierreValido(e, turnoId));
    // ...y el siguiente, simplificado.
    const siguiente = await como(t, "beto").mutation(api.guardia.iniciarTurno, {
      condominioId: e.norte,
      checklist: CHECKLIST,
      guardiaNombre: "Beto Guarda",
    });
    await como(t, "beto").mutation(api.guardia.cerrarTurno, { turnoId: siguiente });

    const lista = await como(t, "admin").query(api.guardia.listTurnos, {
      condominioId: e.norte,
    });
    expect(lista.map((x) => x._id)).toEqual(
      expect.arrayContaining([turnoId, siguiente]),
    );

    const completo = await como(t, "admin").query(api.guardia.getTurno, { turnoId });
    expect(completo!.recibe).toBe("Beto Guarda");
    expect(completo!.consignas).toBe("Paquete del 402 en portería.");
    expect(completo!.observacionesCierre).toBe(OBSERVACIONES);
    expect(completo!.novedadesElementos).toBe(false);

    const simple = await como(t, "admin").query(api.guardia.getTurno, {
      turnoId: siguiente,
    });
    expect(simple!.estado).toBe("cerrado");
    expect(simple!.cerradoPorNombre).toBe("Beto Guarda");
    expect(simple!.recibe).toBeUndefined();
    expect(simple!.consignas).toBeUndefined();
    expect(simple!.novedadesElementos).toBeUndefined();
  });
});

describe("los cierres anteriores siguen consultándose", () => {
  test("un turno cerrado con el formulario viejo se lee sin los campos nuevos", async () => {
    const t = convexTest(schema, modules);
    const e = await escenario(t);
    /* Tal como lo dejaba el cierre de antes: sin relevo elegido, sin novedades
     * de elementos, sin quién cerró y con observaciones opcionales vacías. */
    const antiguo = await t.run(async (ctx) =>
      ctx.db.insert("guardiaTurnos", {
        condominioId: e.norte,
        guardiaUserId: e.ana,
        guardiaNombre: "Ana Guarda",
        checklist: CHECKLIST,
        consignas: "Llaves en el tablero",
        recibe: "Beto",
        estado: "cerrado",
        fechaInicio: AHORA - 12 * 3_600_000,
        fechaCierre: AHORA - 3_600_000,
        createdAt: AHORA - 12 * 3_600_000,
        updatedAt: AHORA - 3_600_000,
      }),
    );

    const lista = await como(t, "admin").query(api.guardia.listTurnos, {
      condominioId: e.norte,
    });
    expect(lista.map((x) => x._id)).toContain(antiguo);

    const detalle = await como(t, "admin").query(api.guardia.getTurno, {
      turnoId: antiguo,
    });
    expect(detalle!.recibe).toBe("Beto");
    expect(detalle!.consignas).toBe("Llaves en el tablero");
    expect(detalle!.novedadesElementos).toBeUndefined();
    expect(detalle!.recibeUserId).toBeUndefined();
    expect(detalle!.cerradoPorNombre).toBeNull();
  });
});
