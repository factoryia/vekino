import { test, expect, describe, beforeEach } from "vitest";
import { convexTest } from "convex-test";
import betterAuthTest from "@convex-dev/better-auth/test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { viasEnConjunto, type Via } from "../convex/model/vias";
import {
  asignacionVigente,
  condominiosSupervisados,
  viasDeAsignacionEn,
} from "../convex/model/asignacion";

const modules = import.meta.glob("../convex/**/*.ts");

/**
 * LAS VIAS DE ACCESO: UNA SOLA RESOLUCION, EL MISMO RESULTADO DE ANTES.
 *
 * `model/vias.ts` junta las dos formas de pertenencia permanente a un
 * conjunto —la membresia y la asignacion de una compania— y devuelve TODAS
 * las que valen, con su procedencia. Sobre eso se apoyan ahora
 * `requireCondominioRole`, `resolverAcceso`, `users.me` y la lista de
 * asignaciones de la sesion.
 *
 * Estas pruebas fijan dos cosas a la vez: que la resolucion devuelve lo que
 * debe (todas las vias, sin que una se coma a otra) y que lo que ve el resto
 * del sistema —la porteria, la sesion, los permisos— no cambio.
 *
 * El escenario se monta directo en la base, sin pasar por las altas, porque
 * lo que se prueba aqui es la lectura: asi cada caso controla exactamente que
 * filas existen.
 */

const DIA = 24 * 60 * 60 * 1000;

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

    const superadmin = await usuario("super", "Super", {
      platformRole: "superadmin" as const,
    });

    const alamos = await conjunto("Conjunto Alamos");
    const bosque = await conjunto("Conjunto Bosque");
    const cedros = await conjunto("Conjunto Cedros");

    const andina = await ctx.db.insert("companiasSeguridad", {
      nombre: "Seguridad Andina",
      estado: "activa",
      createdAt: ahora,
      updatedAt: ahora,
    });

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

    const miembro = (userId: Id<"users">, rol: "guardia" | "supervisor") =>
      ctx.db.insert("companiaMiembros", {
        userId,
        companiaId: andina,
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
    const membresia = (
      userId: Id<"users">,
      condominioId: Id<"condominios">,
      roles: ("guardia" | "propietario")[],
      isActive = true,
    ) =>
      ctx.db.insert("memberships", {
        userId,
        condominioId,
        roles,
        isActive,
        createdAt: ahora,
        updatedAt: ahora,
      });

    // Caso A: el guarda propio de Alamos, de los de antes.
    const propio = await usuario("propio", "Pedro Propio");
    await membresia(propio, alamos, ["guardia"]);

    // Un residente de Alamos: pertenece, pero no es de porteria.
    const residente = await usuario("residente", "Rita Residente");
    await membresia(residente, alamos, ["propietario"]);

    // Alguien que ya no pertenece: su membresia quedo inactiva.
    const exguarda = await usuario("exguarda", "Elias Exguarda");
    await membresia(exguarda, alamos, ["guardia"], false);

    // Casos B y C: Jason, guarda de Andina en Alamos Y en Bosque a la vez.
    const jason = await usuario("jason", "Jason Guarda");
    const mJason = await miembro(jason, "guardia");
    const aJasonAlamos = await asignacion(kAlamos, alamos, jason, mJason, "guardia");
    const aJasonBosque = await asignacion(kBosque, bosque, jason, mJason, "guardia");

    // Caso G: Mateo vive en Alamos y ademas lo cubre como guarda de Andina.
    const mateo = await usuario("mateo", "Mateo Mixto");
    await membresia(mateo, alamos, ["propietario"]);
    const mMateo = await miembro(mateo, "guardia");
    await asignacion(kAlamos, alamos, mateo, mMateo, "guardia");

    // Caso G cruzado: guarda propio de Cedros y de compania en Bosque.
    const lucia = await usuario("lucia", "Lucia Doble");
    await membresia(lucia, cedros, ["guardia"]);
    const mLucia = await miembro(lucia, "guardia");
    await asignacion(kBosque, bosque, lucia, mLucia, "guardia");

    // La supervisora de Alamos, para fijar `condominiosSupervisados`.
    const sofia = await usuario("sofia", "Sofia Supervisora");
    const mSofia = await miembro(sofia, "supervisor");
    await asignacion(kAlamos, alamos, sofia, mSofia, "supervisor");

    return {
      alamos,
      bosque,
      cedros,
      andina,
      kAlamos,
      kBosque,
      propio,
      residente,
      exguarda,
      jason,
      mJason,
      aJasonAlamos,
      aJasonBosque,
      mateo,
      lucia,
      sofia,
    };
  });

  const como = (authId: string) => t.withIdentity({ subject: authId });

  /** Las vias de alguien en un conjunto, en forma comparable. */
  const vias = async (userId: Id<"users">, condominioId: Id<"condominios">) =>
    await t.run(async (ctx) => {
      const r = await viasEnConjunto(ctx, userId, condominioId);
      return r.vias.map(resumen);
    });

  return { t, ...ids, plataforma: como("super"), como, vias };
}

function resumen(v: Via) {
  return v.tipo === "membership"
    ? { tipo: v.tipo, condominioId: v.condominioId, roles: v.roles }
    : {
        tipo: v.tipo,
        condominioId: v.condominioId,
        companiaId: v.companiaId,
        rol: v.rol,
      };
}

type Escenario = Awaited<ReturnType<typeof montar>>;

// ─────────────────────────────────────────────────────────────
describe("caso A: la membresia sigue autorizando igual", () => {
  let e: Escenario;
  beforeEach(async () => {
    e = await montar();
  });

  test("el guarda propio tiene una sola via: su membresia", async () => {
    expect(await e.vias(e.propio, e.alamos)).toEqual([
      { tipo: "membership", condominioId: e.alamos, roles: ["guardia"] },
    ]);
  });

  test("y opera su porteria como antes", async () => {
    const home = await e.como("propio").query(api.guardia.home, {
      condominioId: e.alamos,
    });
    expect(home.allowed).toBe(true);
    await expect(
      e.como("propio").query(api.guardia.turnoActivo, { condominioId: e.alamos }),
    ).resolves.toBeNull();

    const acceso = await e.como("propio").query(api.asignaciones.miAcceso, {
      condominioId: e.alamos,
    });
    expect(acceso!.viaCompania).toBeNull();
    expect(acceso!.rolesConjunto).toEqual(["guardia"]);
    expect(acceso!.capacidades).toContain("porteria.operar");
  });

  test("su sesion trae la membresia y ninguna asignacion", async () => {
    const me = await e.como("propio").query(api.users.me, {});
    expect(me!.memberships.map((m) => m.condominioId)).toEqual([e.alamos]);
    expect(me!.memberships[0]!.roles).toEqual(["guardia"]);
    expect(me!.asignaciones).toEqual([]);
  });

  test("una membresia inactiva no es via, y el error sigue siendo el mismo", async () => {
    expect(await e.vias(e.exguarda, e.alamos)).toEqual([]);
    await expect(
      e.como("exguarda").query(api.guardia.turnoActivo, { condominioId: e.alamos }),
    ).rejects.toThrow("No pertenece a este condominio.");
    const me = await e.como("exguarda").query(api.users.me, {});
    expect(me!.memberships).toEqual([]);
  });

  test("pertenecer sin el rol pedido sigue diciendo que falta el rol", async () => {
    expect(await e.vias(e.residente, e.alamos)).toEqual([
      { tipo: "membership", condominioId: e.alamos, roles: ["propietario"] },
    ]);
    await expect(
      e.como("residente").query(api.guardia.turnoActivo, { condominioId: e.alamos }),
    ).rejects.toThrow("No tiene el rol requerido en este condominio.");
  });
});

// ─────────────────────────────────────────────────────────────
describe("caso B: la asignacion de compania sigue autorizando igual", () => {
  let e: Escenario;
  beforeEach(async () => {
    e = await montar();
  });

  test("la via dice de que compania viene y con que rol", async () => {
    expect(await e.vias(e.jason, e.alamos)).toEqual([
      {
        tipo: "asignacion",
        condominioId: e.alamos,
        companiaId: e.andina,
        rol: "guardia",
      },
    ]);
  });

  test("opera la porteria y la sesion lo dice", async () => {
    const home = await e.como("jason").query(api.guardia.home, {
      condominioId: e.alamos,
    });
    expect(home.allowed).toBe(true);
    await expect(
      e.como("jason").query(api.guardia.turnoActivo, { condominioId: e.alamos }),
    ).resolves.toBeNull();

    const acceso = await e.como("jason").query(api.asignaciones.miAcceso, {
      condominioId: e.alamos,
    });
    expect(acceso!.viaCompania).toMatchObject({
      asignacionId: e.aJasonAlamos,
      rol: "guardia",
      companiaNombre: "Seguridad Andina",
    });
  });

  test("donde no tiene asignacion no tiene via ni porteria", async () => {
    expect(await e.vias(e.jason, e.cedros)).toEqual([]);
    const home = await e.como("jason").query(api.guardia.home, {
      condominioId: e.cedros,
    });
    expect(home.allowed).toBe(false);
    await expect(
      e.como("jason").query(api.guardia.turnoActivo, { condominioId: e.cedros }),
    ).rejects.toThrow("No pertenece a este condominio.");
  });

  test("y no entra a lo que es de la comunidad", async () => {
    await expect(
      e.como("jason").query(api.novedades.listByCondominio, {
        condominioId: e.alamos,
      }),
    ).rejects.toThrow("No pertenece a este condominio.");
  });
});

// ─────────────────────────────────────────────────────────────
describe("caso C: varias asignaciones a la vez", () => {
  let e: Escenario;
  beforeEach(async () => {
    e = await montar();
  });

  test("cada conjunto resuelve su propia via", async () => {
    const enAlamos = await e.vias(e.jason, e.alamos);
    const enBosque = await e.vias(e.jason, e.bosque);
    expect(enAlamos).toHaveLength(1);
    expect(enBosque).toHaveLength(1);
    expect(enAlamos[0]!.condominioId).toBe(e.alamos);
    expect(enBosque[0]!.condominioId).toBe(e.bosque);
  });

  test("opera las dos porterias, y la sesion ofrece las dos", async () => {
    for (const condominioId of [e.alamos, e.bosque]) {
      const home = await e.como("jason").query(api.guardia.home, { condominioId });
      expect(home.allowed).toBe(true);
    }
    const me = await e.como("jason").query(api.users.me, {});
    expect(me!.asignaciones.map((a) => a.condominioNombre)).toEqual([
      "Conjunto Alamos",
      "Conjunto Bosque",
    ]);
    const mias = await e.como("jason").query(api.asignaciones.misAsignaciones, {});
    expect(mias.map((a) => a.condominioId)).toEqual([e.alamos, e.bosque]);
  });

  test("terminar una no toca la otra", async () => {
    await e.plataforma.mutation(api.asignaciones.terminar, {
      asignacionId: e.aJasonBosque,
    });
    expect(await e.vias(e.jason, e.bosque)).toEqual([]);
    expect(await e.vias(e.jason, e.alamos)).toHaveLength(1);
    const home = await e.como("jason").query(api.guardia.home, {
      condominioId: e.alamos,
    });
    expect(home.allowed).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
describe("caso D: una asignacion terminada deja de ser via", () => {
  let e: Escenario;
  beforeEach(async () => {
    e = await montar();
  });

  test("terminada a mano: se corta en el acto", async () => {
    await e.plataforma.mutation(api.asignaciones.terminar, {
      asignacionId: e.aJasonAlamos,
    });
    expect(await e.vias(e.jason, e.alamos)).toEqual([]);
    const home = await e.como("jason").query(api.guardia.home, {
      condominioId: e.alamos,
    });
    expect(home.allowed).toBe(false);
    const me = await e.como("jason").query(api.users.me, {});
    expect(me!.asignaciones.map((a) => a.condominioId)).toEqual([e.bosque]);
  });

  test("vencida por fecha: igual", async () => {
    await e.t.run(async (ctx) => {
      await ctx.db.patch(e.aJasonAlamos, { vigenciaHasta: Date.now() - 3 * DIA });
    });
    expect(await e.vias(e.jason, e.alamos)).toEqual([]);
    await expect(
      e.como("jason").query(api.guardia.turnoActivo, { condominioId: e.alamos }),
    ).rejects.toThrow("No pertenece a este condominio.");
  });
});

// ─────────────────────────────────────────────────────────────
describe("caso E: sin contrato vigente no hay via", () => {
  let e: Escenario;
  beforeEach(async () => {
    e = await montar();
  });

  test("terminar el contrato corta la asignacion sin tocarla", async () => {
    await e.plataforma.mutation(api.companias.terminarContrato, {
      contratoId: e.kAlamos,
    });
    expect(await e.vias(e.jason, e.alamos)).toEqual([]);
    const home = await e.como("jason").query(api.guardia.home, {
      condominioId: e.alamos,
    });
    expect(home.allowed).toBe(false);

    // La fila sigue ahi, sin fecha de fin: es el contrato el que la invalida.
    const fila = await e.t.run(async (ctx) => await ctx.db.get(e.aJasonAlamos));
    expect(fila!.vigenciaHasta).toBeUndefined();
    expect(fila!.terminadoEn).toBeUndefined();

    // El otro contrato no se entera.
    expect(await e.vias(e.jason, e.bosque)).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────
describe("caso F: compania suspendida, inactiva o miembro de baja", () => {
  let e: Escenario;
  beforeEach(async () => {
    e = await montar();
  });

  for (const estado of ["suspendida", "inactiva"] as const) {
    test(`compania ${estado}: ninguna asignacion suya da via`, async () => {
      await e.plataforma.mutation(api.companias.setEstado, {
        companiaId: e.andina,
        estado,
      });
      expect(await e.vias(e.jason, e.alamos)).toEqual([]);
      expect(await e.vias(e.jason, e.bosque)).toEqual([]);
      const home = await e.como("jason").query(api.guardia.home, {
        condominioId: e.alamos,
      });
      expect(home.allowed).toBe(false);
      const me = await e.como("jason").query(api.users.me, {});
      expect(me!.asignaciones).toEqual([]);
    });
  }

  test("miembro dado de baja: tampoco", async () => {
    await e.plataforma.mutation(api.companias.desactivarMiembro, {
      miembroId: e.mJason,
    });
    expect(await e.vias(e.jason, e.alamos)).toEqual([]);
    expect(await e.vias(e.jason, e.bosque)).toEqual([]);
  });

  test("condominiosSupervisados usa la misma cadena que la via", async () => {
    /* Fase 3: antes miraba solo la asignacion y su contrato, y una compania
     * suspendida seguia ampliando el alcance de su supervisor. Ahora la lista
     * y la via dicen lo mismo. Ver hardeningVigilancia.test.ts. */
    await e.plataforma.mutation(api.companias.setEstado, {
      companiaId: e.andina,
      estado: "suspendida",
    });
    const r = await e.t.run(async (ctx) => ({
      supervisa: [...(await condominiosSupervisados(ctx, e.sofia))],
      via: await asignacionVigente(ctx, e.sofia, e.alamos),
    }));
    expect(r.supervisa).toEqual([]);
    expect(r.via).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
describe("caso G: membresia y asignacion a la vez", () => {
  let e: Escenario;
  beforeEach(async () => {
    e = await montar();
  });

  test("en el mismo conjunto salen las dos vias, ninguna descartada", async () => {
    expect(await e.vias(e.mateo, e.alamos)).toEqual([
      { tipo: "membership", condominioId: e.alamos, roles: ["propietario"] },
      {
        tipo: "asignacion",
        condominioId: e.alamos,
        companiaId: e.andina,
        rol: "guardia",
      },
    ]);
  });

  test("las capacidades se suman y cada puerta mira la suya", async () => {
    const acceso = await e.como("mateo").query(api.asignaciones.miAcceso, {
      condominioId: e.alamos,
    });
    expect(acceso!.rolesConjunto).toEqual(["propietario"]);
    expect(acceso!.viaCompania).not.toBeNull();
    expect(acceso!.capacidades).toContain("porteria.operar");

    // La porteria la abre la asignacion: propietario no es rol de porteria.
    await expect(
      e.como("mateo").query(api.guardia.turnoActivo, { condominioId: e.alamos }),
    ).resolves.toBeNull();
    // Lo de la comunidad lo abre la membresia.
    await expect(
      e.como("mateo").query(api.novedades.listByCondominio, {
        condominioId: e.alamos,
      }),
    ).resolves.toEqual([]);

    const me = await e.como("mateo").query(api.users.me, {});
    expect(me!.memberships.map((m) => m.condominioId)).toEqual([e.alamos]);
    expect(me!.asignaciones.map((a) => a.condominioId)).toEqual([e.alamos]);
  });

  test("si cae la asignacion queda la membresia, y al reves no se mezclan", async () => {
    await e.plataforma.mutation(api.companias.terminarContrato, {
      contratoId: e.kAlamos,
    });
    expect(await e.vias(e.mateo, e.alamos)).toEqual([
      { tipo: "membership", condominioId: e.alamos, roles: ["propietario"] },
    ]);
    const home = await e.como("mateo").query(api.guardia.home, {
      condominioId: e.alamos,
    });
    expect(home.allowed).toBe(false);
    await expect(
      e.como("mateo").query(api.novedades.listByCondominio, {
        condominioId: e.alamos,
      }),
    ).resolves.toEqual([]);
  });

  test("en conjuntos distintos cada via responde por el suyo", async () => {
    expect(await e.vias(e.lucia, e.cedros)).toEqual([
      { tipo: "membership", condominioId: e.cedros, roles: ["guardia"] },
    ]);
    expect(await e.vias(e.lucia, e.bosque)).toEqual([
      {
        tipo: "asignacion",
        condominioId: e.bosque,
        companiaId: e.andina,
        rol: "guardia",
      },
    ]);
    for (const condominioId of [e.cedros, e.bosque]) {
      const home = await e.como("lucia").query(api.guardia.home, { condominioId });
      expect(home.allowed).toBe(true);
    }
    const me = await e.como("lucia").query(api.users.me, {});
    expect(me!.memberships.map((m) => m.condominioId)).toEqual([e.cedros]);
    expect(me!.asignaciones.map((a) => a.condominioId)).toEqual([e.bosque]);
  });
});

// ─────────────────────────────────────────────────────────────
describe("casos limite de la resolucion", () => {
  let e: Escenario;
  beforeEach(async () => {
    e = await montar();
  });

  test("un conjunto inactivo corta la via y sale de la sesion, con el mismo criterio", async () => {
    /* Fase 3: el conjunto activo es el quinto eslabon de la cadena. Antes la
     * sesion lo quitaba pero la porteria seguia abierta; ahora las dos miran
     * lo mismo. Ver hardeningVigilancia.test.ts. */
    await e.t.run(async (ctx) => {
      await ctx.db.patch(e.bosque, { isActive: false });
    });
    expect(await e.vias(e.jason, e.bosque)).toEqual([]);
    const home = await e.como("jason").query(api.guardia.home, {
      condominioId: e.bosque,
    });
    expect(home.allowed).toBe(false);
    const me = await e.como("jason").query(api.users.me, {});
    expect(me!.asignaciones.map((a) => a.condominioId)).toEqual([e.alamos]);
  });

  test("con dos asignaciones vivas en un conjunto salen las dos vias, y asignacionVigente sigue dando la primera", async () => {
    /* No se puede llegar aqui por la API (regla 3 de `asignaciones.crear`),
     * pero una fila importada podria. La resolucion no esconde ninguna; la
     * politica de los consumidores —quedarse con la primera del indice— es la
     * de siempre. */
    const segunda = await e.t.run(async (ctx) => {
      const a = (await ctx.db.get(e.aJasonAlamos))!;
      const { _id, _creationTime, ...resto } = a;
      return await ctx.db.insert("asignaciones", { ...resto, rol: "supervisor" });
    });
    const r = await e.t.run(async (ctx) => ({
      todas: (await viasDeAsignacionEn(ctx, e.jason, e.alamos)).map(
        (v) => v.asignacion._id,
      ),
      primera: (await asignacionVigente(ctx, e.jason, e.alamos))!.asignacion._id,
    }));
    expect(r.todas).toEqual([e.aJasonAlamos, segunda]);
    expect(r.primera).toBe(e.aJasonAlamos);
  });
});
