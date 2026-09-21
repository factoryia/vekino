import { test, expect, describe } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

const modules = import.meta.glob("../convex/**/*.ts");

/**
 * EL SELECTOR DE CASA DE LA PORTERÍA.
 *
 * Paquetería, aporte voluntario y "otra novedad" escogen la casa con
 * `guardia.buscarUnidad`. Cada resultado tiene que decir quién vive ahí para
 * que el guarda sepa que escogió bien, sin por eso abrirle el censo: solo un
 * nombre, y solo de quien vive ahí hoy.
 */

const AHORA = Date.now();
const DIA = 24 * 60 * 60 * 1000;

type T = ReturnType<typeof convexTest>;
const como = (t: T, subject: string) => t.withIdentity({ subject });

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
    const condominioId = await conjunto("Conjunto A");
    const otroCondominioId = await conjunto("Conjunto B");

    const persona = async (
      name: string,
      authId: string,
      roles: string[],
      { activa = true }: { activa?: boolean } = {},
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
      const membershipId = await ctx.db.insert("memberships", {
        userId,
        condominioId,
        roles: roles as never,
        isActive: activa,
        createdAt: AHORA,
        updatedAt: AHORA,
      });
      return membershipId;
    };

    const casa = (numero: string, torre?: string, cond = condominioId) =>
      ctx.db.insert("unidades", {
        condominioId: cond,
        tipo: "casa",
        estado: "ocupada",
        numero,
        torre,
        createdAt: AHORA,
        updatedAt: AHORA,
      });
    const vincular = (
      membershipId: Id<"memberships">,
      unidadId: Id<"unidades">,
      vinculo: string,
      extra: { vigenciaHasta?: number } = {},
    ) =>
      ctx.db.insert("usuarioUnidad", {
        membershipId,
        unidadId,
        condominioId,
        vinculo: vinculo as never,
        esPrincipal: true,
        createdAt: AHORA,
        ...extra,
      });

    await persona("Guarda", "guarda", ["guardia"]);
    const carlos = await persona("Carlos Pérez", "carlos", ["propietario"]);
    const maria = await persona("María Rodríguez", "maria", ["residente"]);
    const exInquilino = await persona("Luis Viejo", "luis", ["residente"]);
    const inactiva = await persona("Sofía Baja", "sofia", ["residente"], { activa: false });

    const c101 = await casa("101", "A");
    const c101b = await casa("101", "B");
    const c102 = await casa("102", "A");
    const c103 = await casa("103", "A");
    const ajena = await casa("900", undefined, otroCondominioId);

    await vincular(carlos, c101, "propietario");
    await vincular(maria, c102, "residente");
    // El que ya se fue y la cuenta desactivada no son de la 103.
    await vincular(exInquilino, c103, "arrendatario", { vigenciaHasta: AHORA - 10 * DIA });
    await vincular(inactiva, c103, "residente");

    return { condominioId, c101, c101b, c102, c103, ajena };
  });
}

describe("guardia.buscarUnidad", () => {
  test("al abrir muestra las casas con quien vive en cada una", async () => {
    const t = convexTest(schema, modules);
    const s = await escenario(t);
    const r = await como(t, "guarda").query(api.guardia.buscarUnidad, {
      condominioId: s.condominioId,
      texto: "",
    });
    expect(r.map((c) => [c.torre, c.numero, c.residente, c.vinculo])).toEqual([
      ["A", "101", "Carlos Pérez", "propietario"],
      ["A", "102", "María Rodríguez", "residente"],
      ["A", "103", null, null],
      ["B", "101", null, null],
    ]);
  });

  test("busca por nombre mientras se escribe", async () => {
    const t = convexTest(schema, modules);
    const s = await escenario(t);
    const buscar = (texto: string) =>
      como(t, "guarda").query(api.guardia.buscarUnidad, { condominioId: s.condominioId, texto });

    expect((await buscar("carlos")).map((c) => c._id)).toEqual([s.c101]);
    expect((await buscar("maria")).map((c) => c._id)).toEqual([s.c102]);
    // Los que ya no viven ahí no se encuentran por nombre.
    expect(await buscar("luis")).toEqual([]);
    expect(await buscar("sofia")).toEqual([]);
  });

  test("no expone el censo: ni correos ni casas de otro conjunto", async () => {
    const t = convexTest(schema, modules);
    const s = await escenario(t);
    const r = await como(t, "guarda").query(api.guardia.buscarUnidad, {
      condominioId: s.condominioId,
      texto: "",
    });
    expect(Object.keys(r[0]!).sort()).toEqual(["_id", "numero", "residente", "torre", "vinculo"]);
    expect(r.some((c) => c._id === s.ajena)).toBe(false);
  });

  test("un residente no puede usarlo", async () => {
    const t = convexTest(schema, modules);
    const s = await escenario(t);
    await expect(
      como(t, "maria").query(api.guardia.buscarUnidad, { condominioId: s.condominioId, texto: "" }),
    ).rejects.toThrow();
  });
});

describe("guardia.recibirPaquete con la casa escogida", () => {
  test("usa la casa escogida aunque otra torre tenga el mismo número", async () => {
    const t = convexTest(schema, modules);
    const s = await escenario(t);
    const id = await como(t, "guarda").mutation(api.guardia.recibirPaquete, {
      condominioId: s.condominioId,
      unidadNumero: "101",
      unidadId: s.c101b,
      tipo: "paquete",
    });
    const paquete = await t.run((ctx) => ctx.db.get(id));
    expect(paquete?.unidadId).toBe(s.c101b);
    expect(paquete?.unidadNumero).toBe("101");
  });

  test("rechaza una casa de otro conjunto", async () => {
    const t = convexTest(schema, modules);
    const s = await escenario(t);
    await expect(
      como(t, "guarda").mutation(api.guardia.recibirPaquete, {
        condominioId: s.condominioId,
        unidadNumero: "900",
        unidadId: s.ajena,
        tipo: "paquete",
      }),
    ).rejects.toThrow("Esa casa no es de este conjunto.");
  });

  test("sin casa escogida sigue resolviendo por el número escrito", async () => {
    const t = convexTest(schema, modules);
    const s = await escenario(t);
    const id = await como(t, "guarda").mutation(api.guardia.recibirPaquete, {
      condominioId: s.condominioId,
      unidadNumero: " 102 ",
      tipo: "sobre",
    });
    const libre = await como(t, "guarda").mutation(api.guardia.recibirPaquete, {
      condominioId: s.condominioId,
      unidadNumero: "Portería",
      tipo: "otro",
    });
    const [p, q] = await t.run(async (ctx) => [await ctx.db.get(id), await ctx.db.get(libre)]);
    expect(p?.unidadId).toBe(s.c102);
    expect(q?.unidadId).toBeUndefined();
    expect(q?.unidadNumero).toBe("Portería");
  });
});

describe("guardia.buscarVehiculo", () => {
  test("la placa registrada dice de quién es la casa", async () => {
    const t = convexTest(schema, modules);
    const s = await escenario(t);
    await t.run((ctx) =>
      ctx.db.insert("vehiculos", {
        condominioId: s.condominioId,
        unidadId: s.c101,
        placa: "ABC123",
        tipo: "carro",
        createdAt: AHORA,
        updatedAt: AHORA,
      }),
    );
    const r = await como(t, "guarda").query(api.guardia.buscarVehiculo, {
      condominioId: s.condominioId,
      texto: "abc",
    });
    expect(r.map((v) => [v.placa, v.unidadNumero, v.residente])).toEqual([
      ["ABC123", "101", "Carlos Pérez"],
    ]);
  });
});
