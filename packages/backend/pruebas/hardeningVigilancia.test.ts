import { test, expect, describe, beforeEach } from "vitest";
import { convexTest } from "convex-test";
import betterAuthTest from "@convex-dev/better-auth/test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { viasEnConjunto } from "../convex/model/vias";
import {
  asignacionVigente,
  condominiosSupervisados,
} from "../convex/model/asignacion";

const modules = import.meta.glob("../convex/**/*.ts");

/**
 * HARDENING DE LA AUTORIZACION DE VIGILANCIA.
 *
 * Tres reglas, las tres en la cadena central de `model/asignacion.ts` y no en
 * cada consumidor:
 *
 *   1. Un conjunto inactivo no se opera por una asignacion que siga en la
 *      base. La fila no se toca: al reactivar el conjunto vuelve a valer sola.
 *   2. `condominiosSupervisados` usa la cadena entera. Una asignacion de
 *      supervisor deja de ampliar su alcance si cae cualquier eslabon.
 *   3. El relevo se juzga fila por fila: hace falta una via de GUARDA en ESTE
 *      conjunto, no una asignacion cualquiera.
 *
 * El escenario se monta directo en la base para controlar exactamente que
 * filas existen; lo que se prueba son las puertas de la API.
 */

const DIA = 24 * 60 * 60 * 1000;

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
    const kAndinaAlamos = await contrato(andina, alamos);
    const kAndinaBosque = await contrato(andina, bosque);
    const kRivalAlamos = await contrato(rival, alamos);

    const miembro = (
      userId: Id<"users">,
      companiaId: Id<"companiasSeguridad">,
      rol: "guardia" | "supervisor",
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
      companiaId: Id<"companiasSeguridad">,
      condominioId: Id<"condominios">,
      userId: Id<"users">,
      companiaMiembroId: Id<"companiaMiembros">,
      rol: "guardia" | "supervisor",
      extra = {},
    ) =>
      ctx.db.insert("asignaciones", {
        contratoId,
        companiaMiembroId,
        userId,
        condominioId,
        companiaId,
        rol,
        vigenciaDesde: desde,
        creadoPorUserId: superadmin,
        createdAt: ahora,
        ...extra,
      });
    const membresia = (
      userId: Id<"users">,
      condominioId: Id<"condominios">,
      roles: ("guardia" | "propietario")[],
    ) =>
      ctx.db.insert("memberships", {
        userId,
        condominioId,
        roles,
        isActive: true,
        createdAt: ahora,
        updatedAt: ahora,
      });

    // Jason: guarda de Andina en Alamos y en Bosque.
    const jason = await usuario("jason", "Jason Guarda");
    const mJason = await miembro(jason, andina, "guardia");
    const aJasonAlamos = await asignacion(kAndinaAlamos, andina, alamos, jason, mJason, "guardia");
    await asignacion(kAndinaBosque, andina, bosque, jason, mJason, "guardia");

    // Pedro: guarda propio de Alamos (via de membresia).
    const propio = await usuario("propio", "Pedro Propio");
    await membresia(propio, alamos, ["guardia"]);

    // Mateo: vive en Alamos y ademas lo cubre como guarda de Andina.
    const mateo = await usuario("mateo", "Mateo Mixto");
    await membresia(mateo, alamos, ["propietario"]);
    const mMateo = await miembro(mateo, andina, "guardia");
    await asignacion(kAndinaAlamos, andina, alamos, mateo, mMateo, "guardia");

    // Bruno: guarda de Andina, pero solo en Bosque.
    const bruno = await usuario("bruno", "Bruno Bosque");
    const mBruno = await miembro(bruno, andina, "guardia");
    await asignacion(kAndinaBosque, andina, bosque, bruno, mBruno, "guardia");

    /* Ascendido: fue guarda de Alamos y hoy es su supervisor. La fila de
     * guarda esta terminada; la de supervisor, viva. */
    const ascendido = await usuario("ascendido", "Andres Ascendido");
    const mAscendido = await miembro(ascendido, andina, "supervisor");
    await asignacion(kAndinaAlamos, andina, alamos, ascendido, mAscendido, "guardia", {
      terminadoEn: ahora - 5 * DIA,
    });
    await asignacion(kAndinaAlamos, andina, alamos, ascendido, mAscendido, "supervisor", {
      vigenciaDesde: ahora - 5 * DIA,
    });

    // Sofia: supervisora de Andina en Alamos.
    const sofia = await usuario("sofia", "Sofia Supervisora");
    const mSofia = await miembro(sofia, andina, "supervisor");
    await asignacion(kAndinaAlamos, andina, alamos, sofia, mSofia, "supervisor");

    /* Rafa: supervisaba Alamos por Andina, se le dio de baja alli y hoy es
     * supervisor de Rival, que tambien cubre Alamos. Su asignacion vieja
     * sigue con fechas vigentes; en Rival no tiene ninguna. */
    const rafa = await usuario("rafa", "Rafa Cambio");
    const mRafaAndina = await miembro(rafa, andina, "supervisor", false);
    await asignacion(kAndinaAlamos, andina, alamos, rafa, mRafaAndina, "supervisor");
    await miembro(rafa, rival, "supervisor");
    const guardaRival = await usuario("guardarival", "Gina Rival");
    const mGuardaRival = await miembro(guardaRival, rival, "guardia");

    return {
      alamos,
      bosque,
      andina,
      kRivalAlamos,
      jason,
      aJasonAlamos,
      propio,
      mateo,
      bruno,
      ascendido,
      sofia,
      mSofia,
      rafa,
      mGuardaRival,
    };
  });

  const como = (authId: string) => t.withIdentity({ subject: authId });

  const desactivar = (condominioId: Id<"condominios">, isActive = false) =>
    t.run(async (ctx) => {
      await ctx.db.patch(condominioId, { isActive });
    });

  const tiposDeVia = async (
    userId: Id<"users">,
    condominioId: Id<"condominios">,
  ) =>
    await t.run(async (ctx) =>
      (await viasEnConjunto(ctx, userId, condominioId)).vias.map((v) => v.tipo),
    );

  const supervisados = async (userId: Id<"users">) =>
    await t.run(async (ctx) => [...(await condominiosSupervisados(ctx, userId))]);

  const abrirTurno = (authId: string, condominioId: Id<"condominios">) =>
    como(authId).mutation(api.guardia.iniciarTurno, {
      condominioId,
      checklist: CHECKLIST,
    });

  const cerrarTurnoCon = (
    authId: string,
    turnoId: Id<"guardiaTurnos">,
    recibeUserId: Id<"users">,
  ) =>
    como(authId).mutation(api.guardia.cerrarTurno, {
      turnoId,
      recibeUserId,
      consignas: "Paquete del 402 en portería.",
      observacionesCierre: OBSERVACIONES,
      novedadesElementos: false,
    });

  return {
    t,
    ...ids,
    plataforma: como("super"),
    como,
    desactivar,
    tiposDeVia,
    supervisados,
    abrirTurno,
    cerrarTurnoCon,
  };
}

type Escenario = Awaited<ReturnType<typeof montar>>;

// ─────────────────────────────────────────────────────────────
describe("caso A: asignacion vigente en un conjunto activo", () => {
  let e: Escenario;
  beforeEach(async () => {
    e = await montar();
  });

  test("autoriza como siempre: via, porteria, capacidades y turno", async () => {
    expect(await e.tiposDeVia(e.jason, e.alamos)).toEqual(["asignacion"]);
    const home = await e.como("jason").query(api.guardia.home, {
      condominioId: e.alamos,
    });
    expect(home.allowed).toBe(true);
    const acceso = await e.como("jason").query(api.asignaciones.miAcceso, {
      condominioId: e.alamos,
    });
    expect(acceso!.capacidades).toContain("porteria.operar");
    const turnoId = await e.abrirTurno("jason", e.alamos);
    expect(turnoId).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────
describe("caso B: asignacion vigente en un conjunto inactivo", () => {
  let e: Escenario;
  beforeEach(async () => {
    e = await montar();
    await e.desactivar(e.alamos);
  });

  test("la asignacion deja de ser via", async () => {
    expect(await e.tiposDeVia(e.jason, e.alamos)).toEqual([]);
    const via = await e.t.run(
      async (ctx) => await asignacionVigente(ctx, e.jason, e.alamos),
    );
    expect(via).toBeNull();
  });

  test("guardia.home y la resolucion de acceso le cierran la porteria", async () => {
    const home = await e.como("jason").query(api.guardia.home, {
      condominioId: e.alamos,
    });
    expect(home.allowed).toBe(false);
    const acceso = await e.como("jason").query(api.asignaciones.miAcceso, {
      condominioId: e.alamos,
    });
    expect(acceso!.viaCompania).toBeNull();
    expect(acceso!.capacidades).toEqual([]);
  });

  test("requireCondominioRole lo rechaza: ni consultar el turno ni abrirlo", async () => {
    await expect(
      e.como("jason").query(api.guardia.turnoActivo, { condominioId: e.alamos }),
    ).rejects.toThrow("No pertenece a este condominio.");
    await expect(e.abrirTurno("jason", e.alamos)).rejects.toThrow(
      "No pertenece a este condominio.",
    );
  });

  test("tampoco registra novedades", async () => {
    await expect(
      e.como("jason").mutation(api.novedades.create, {
        condominioId: e.alamos,
        tipo: "otro",
        descripcion: "Prueba",
        turno: "noche",
      }),
    ).rejects.toThrow("No pertenece a este condominio.");
  });

  test("la asignacion queda intacta y el otro conjunto sigue igual", async () => {
    const fila = await e.t.run(async (ctx) => await ctx.db.get(e.aJasonAlamos));
    expect(fila!.terminadoEn).toBeUndefined();
    expect(fila!.vigenciaHasta).toBeUndefined();

    const home = await e.como("jason").query(api.guardia.home, {
      condominioId: e.bosque,
    });
    expect(home.allowed).toBe(true);
    const me = await e.como("jason").query(api.users.me, {});
    expect(me!.asignaciones.map((a) => a.condominioId)).toEqual([e.bosque]);
  });
});

// ─────────────────────────────────────────────────────────────
describe("caso C: reactivar el conjunto", () => {
  let e: Escenario;
  beforeEach(async () => {
    e = await montar();
  });

  test("la misma asignacion vuelve a valer, sin tocarla", async () => {
    const antes = await e.t.run(async (ctx) => await ctx.db.get(e.aJasonAlamos));

    await e.desactivar(e.alamos);
    expect(await e.tiposDeVia(e.jason, e.alamos)).toEqual([]);

    await e.desactivar(e.alamos, true);
    expect(await e.tiposDeVia(e.jason, e.alamos)).toEqual(["asignacion"]);
    const home = await e.como("jason").query(api.guardia.home, {
      condominioId: e.alamos,
    });
    expect(home.allowed).toBe(true);

    const despues = await e.t.run(async (ctx) => await ctx.db.get(e.aJasonAlamos));
    expect(despues).toEqual(antes);
  });
});

// ─────────────────────────────────────────────────────────────
describe("caso D: supervisor de una compania activa", () => {
  let e: Escenario;
  beforeEach(async () => {
    e = await montar();
  });

  test("supervisa exactamente los conjuntos de sus asignaciones vigentes", async () => {
    expect(await e.supervisados(e.sofia)).toEqual([e.alamos]);

    const equipo = await e.como("sofia").query(api.asignaciones.miEquipo, {});
    expect(equipo.map((c) => c.condominioId)).toEqual([e.alamos]);

    const detalle = await e.como("sofia").query(api.companias.detail, {
      companiaId: e.andina,
    });
    expect(detalle!.contratos.map((k) => k.condominioId)).toEqual([e.alamos]);

    // Jason pisa Alamos: Sofia puede ver su historial.
    const historial = await e.como("sofia").query(api.asignaciones.historialDePersona, {
      userId: e.jason,
    });
    expect(historial.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────
describe("caso E: compania suspendida o inactiva, o conjunto inactivo", () => {
  let e: Escenario;
  beforeEach(async () => {
    e = await montar();
  });

  for (const estado of ["suspendida", "inactiva"] as const) {
    test(`compania ${estado}: sus asignaciones dejan de ampliar el alcance`, async () => {
      await e.plataforma.mutation(api.companias.setEstado, {
        companiaId: e.andina,
        estado,
      });
      expect(await e.supervisados(e.sofia)).toEqual([]);

      const detalle = await e.como("sofia").query(api.companias.detail, {
        companiaId: e.andina,
      });
      expect(detalle!.contratos).toEqual([]);
      expect(detalle!.personal).toEqual([]);

      await expect(
        e.como("sofia").query(api.asignaciones.historialDePersona, {
          userId: e.jason,
        }),
      ).rejects.toThrow("No tiene acceso al historial de esa persona.");
    });
  }

  test("conjunto inactivo: tambien sale del alcance del supervisor", async () => {
    await e.desactivar(e.alamos);
    expect(await e.supervisados(e.sofia)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
describe("caso F: miembro dado de baja", () => {
  let e: Escenario;
  beforeEach(async () => {
    e = await montar();
  });

  test("sus asignaciones dejan de ampliar el alcance", async () => {
    await e.plataforma.mutation(api.companias.desactivarMiembro, {
      miembroId: e.mSofia,
    });
    expect(await e.supervisados(e.sofia)).toEqual([]);
  });

  test("una asignacion de la compania anterior no abre el conjunto en la nueva", async () => {
    /* Rafa sigue teniendo una asignacion de supervisor con fechas vigentes,
     * pero colgada de su membresia de Andina, dada de baja. Antes contaba, y
     * le dejaba asignar personal de Rival en Alamos sin ninguna asignacion
     * en Rival. */
    expect(await e.supervisados(e.rafa)).toEqual([]);
    await expect(
      e.como("rafa").mutation(api.asignaciones.crear, {
        contratoId: e.kRivalAlamos,
        companiaMiembroId: e.mGuardaRival,
        rol: "guardia",
        vigenciaDesde: Date.now(),
      }),
    ).rejects.toThrow("No tiene permiso para esta operación (seguridad.asignar).");
  });
});

// ─────────────────────────────────────────────────────────────
describe("caso G: quien no es guarda de ESTE conjunto no es relevo", () => {
  let e: Escenario;
  let turnoId: Id<"guardiaTurnos">;
  beforeEach(async () => {
    e = await montar();
    turnoId = await e.abrirTurno("jason", e.alamos);
  });

  test("el guarda que solo cubre otro conjunto no sale en el catalogo ni se acepta", async () => {
    const equipo = await e.como("jason").query(api.guardia.equipo, {
      condominioId: e.alamos,
    });
    expect(equipo.map((g) => g.userId)).not.toContain(e.bruno);
    await expect(e.cerrarTurnoCon("jason", turnoId, e.bruno)).rejects.toThrow(
      "El relevo elegido no es un guarda vigente de esta portería.",
    );
  });

  test("una fila de guarda muerta no la revive otra fila viva de supervisor", async () => {
    /* El bug real: el ascendido tiene aqui una asignacion viva, pero de
     * supervisor. Antes eso bastaba para validar su fila de guarda
     * terminada, y salia como relevo. */
    const equipo = await e.como("jason").query(api.guardia.equipo, {
      condominioId: e.alamos,
    });
    expect(equipo.map((g) => g.userId)).not.toContain(e.ascendido);
    await expect(e.cerrarTurnoCon("jason", turnoId, e.ascendido)).rejects.toThrow(
      "El relevo elegido no es un guarda vigente de esta portería.",
    );
  });
});

// ─────────────────────────────────────────────────────────────
describe("caso H: el relevo valido funciona igual", () => {
  let e: Escenario;
  let turnoId: Id<"guardiaTurnos">;
  beforeEach(async () => {
    e = await montar();
    turnoId = await e.abrirTurno("jason", e.alamos);
  });

  test("el catalogo trae a los guardas de ESTE conjunto, por las dos vias", async () => {
    const equipo = await e.como("jason").query(api.guardia.equipo, {
      condominioId: e.alamos,
    });
    expect(equipo.map((g) => g.nombre)).toEqual(["Mateo Mixto", "Pedro Propio"]);
  });

  test("se entrega al guarda propio del conjunto", async () => {
    await e.cerrarTurnoCon("jason", turnoId, e.propio);
    const turno = await e.t.run(async (ctx) => await ctx.db.get(turnoId));
    expect(turno!.estado).toBe("cerrado");
    expect(turno!.recibeUserId).toBe(e.propio);
    expect(turno!.recibe).toBe("Pedro Propio");
  });

  test("y al guarda de compania del conjunto", async () => {
    await e.cerrarTurnoCon("jason", turnoId, e.mateo);
    const turno = await e.t.run(async (ctx) => await ctx.db.get(turnoId));
    expect(turno!.recibeUserId).toBe(e.mateo);
  });
});

// ─────────────────────────────────────────────────────────────
describe("caso I: membresia y asignacion a la vez", () => {
  let e: Escenario;
  beforeEach(async () => {
    e = await montar();
  });

  test("en un conjunto activo siguen las dos vias", async () => {
    expect(await e.tiposDeVia(e.mateo, e.alamos)).toEqual(["membership", "asignacion"]);
    await expect(
      e.como("mateo").query(api.guardia.turnoActivo, { condominioId: e.alamos }),
    ).resolves.toBeNull();
  });

  test("en un conjunto inactivo cae la asignacion y queda la membresia", async () => {
    await e.desactivar(e.alamos);
    expect(await e.tiposDeVia(e.mateo, e.alamos)).toEqual(["membership"]);

    // La porteria era de la asignacion: propietario no es rol de porteria.
    await expect(
      e.como("mateo").query(api.guardia.turnoActivo, { condominioId: e.alamos }),
    ).rejects.toThrow("No tiene el rol requerido en este condominio.");
    const home = await e.como("mateo").query(api.guardia.home, {
      condominioId: e.alamos,
    });
    expect(home.allowed).toBe(false);

    // Lo residencial sigue: la via de membresia no mira el conjunto.
    await expect(
      e.como("mateo").query(api.novedades.listByCondominio, {
        condominioId: e.alamos,
      }),
    ).resolves.toEqual([]);
    const me = await e.como("mateo").query(api.users.me, {});
    expect(me!.memberships.map((m) => m.condominioId)).toEqual([e.alamos]);
    expect(me!.asignaciones).toEqual([]);
  });

  test("el guarda propio de un conjunto inactivo sigue operando", async () => {
    /* Fijado a proposito: la regla del conjunto inactivo se aplico a la
     * asignacion, no a la membresia. Si se decide extenderla, esta prueba es
     * la que tiene que cambiar. */
    await e.desactivar(e.alamos);
    const home = await e.como("propio").query(api.guardia.home, {
      condominioId: e.alamos,
    });
    expect(home.allowed).toBe(true);

    // Y en su catalogo de relevos ya no estan los guardas de compania.
    const equipo = await e.como("propio").query(api.guardia.equipo, {
      condominioId: e.alamos,
    });
    expect(equipo).toEqual([]);
  });
});
