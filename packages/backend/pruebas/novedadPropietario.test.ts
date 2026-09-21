import { test, expect, describe } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

const modules = import.meta.glob("../convex/**/*.ts");

/**
 * EL PROPIETARIO EN LOS APORTES VOLUNTARIOS.
 *
 * Un aporte voluntario (reporte con placa) es plata por cobrar a una casa, y
 * el guarda tiene que ver a quién: el propietario de ESA casa según el censo,
 * no quien hizo el reporte ni quien vive ahí en arriendo.
 */

const AHORA = Date.now();

type T = ReturnType<typeof convexTest>;
const como = (t: T, subject: string) => t.withIdentity({ subject });

async function escenario(t: T) {
  return await t.run(async (ctx) => {
    const condominioId = await ctx.db.insert("condominios", {
      name: "Conjunto A",
      activeModules: [],
      isActive: true,
      createdAt: AHORA,
      updatedAt: AHORA,
    });

    const persona = async (name: string, authId: string, roles: string[]) => {
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
        isActive: true,
        createdAt: AHORA,
        updatedAt: AHORA,
      });
      return { userId, membershipId };
    };
    const casa = (numero: string) =>
      ctx.db.insert("unidades", {
        condominioId,
        tipo: "casa",
        estado: "ocupada",
        numero,
        createdAt: AHORA,
        updatedAt: AHORA,
      });
    const vincular = (membershipId: Id<"memberships">, unidadId: Id<"unidades">, vinculo: string) =>
      ctx.db.insert("usuarioUnidad", {
        membershipId,
        unidadId,
        condominioId,
        vinculo: vinculo as never,
        esPrincipal: true,
        createdAt: AHORA,
      });
    const carro = (unidadId: Id<"unidades">, placa: string) =>
      ctx.db.insert("vehiculos", {
        condominioId,
        unidadId,
        placa,
        tipo: "carro",
        createdAt: AHORA,
        updatedAt: AHORA,
      });

    const guarda = await persona("Guarda Nocturno", "guarda", ["guardia"]);
    const carlos = await persona("Carlos Pérez", "carlos", ["propietario"]);
    const ana = await persona("Ana Torres", "ana", ["residente"]);
    const maria = await persona("María Rodríguez", "maria", ["propietario"]);

    const c603 = await casa("603");
    const c604 = await casa("604");
    const c605 = await casa("605");

    await vincular(ana.membershipId, c603, "arrendatario");
    await vincular(carlos.membershipId, c603, "propietario");
    await vincular(maria.membershipId, c604, "propietario");
    // La 605 solo tiene residente: no hay propietario que mostrar.
    await vincular(ana.membershipId, c605, "residente");

    return {
      condominioId,
      guardaId: guarda.userId,
      c603,
      c604,
      c605,
      hdw: await carro(c603, "HDW741"),
      xyz: await carro(c604, "XYZ123"),
      sin: await carro(c605, "SIN999"),
    };
  });
}

type Escenario = Awaited<ReturnType<typeof escenario>>;

const aporte = (t: T, s: Escenario, vehiculoId: Id<"vehiculos">) =>
  como(t, "guarda").mutation(api.guardia.reportarNovedad, {
    condominioId: s.condominioId,
    titulo: "Aporte Voluntario Parqueadero",
    descripcion: "Detectado durante la ronda.",
    prioridad: "media",
    vehiculoId,
    fotos: [{ url: "https://s3.test/foto.jpg" }],
  });

const listar = (t: T, s: Escenario) =>
  como(t, "guarda").query(api.guardia.listNovedadReportes, { condominioId: s.condominioId });

describe("guardia.listNovedadReportes · propietario del aporte", () => {
  test("muestra al propietario de la casa del vehículo, no al guarda ni al arrendatario", async () => {
    const t = convexTest(schema, modules);
    const s = await escenario(t);
    const id = await aporte(t, s, s.hdw);

    const n = (await listar(t, s)).find((r) => r._id === id)!;
    expect(n.vehiculoPlaca).toBe("HDW741");
    expect(n.unidades.map((u) => u.numero)).toEqual(["603"]);
    expect(n.propietarios).toEqual([{ unidadId: s.c603, numero: "603", nombre: "Carlos Pérez" }]);
    expect(n.reportadoPorNombre).toBe("Guarda Nocturno");
  });

  test("cada aporte lleva el propietario de su propia casa", async () => {
    const t = convexTest(schema, modules);
    const s = await escenario(t);
    const a603 = await aporte(t, s, s.hdw);
    const a604 = await aporte(t, s, s.xyz);

    const lista = await listar(t, s);
    const nombres = (id: Id<"guardiaNovedadReportes">) =>
      lista.find((r) => r._id === id)!.propietarios.map((p) => p.nombre);
    expect(nombres(a603)).toEqual(["Carlos Pérez"]);
    expect(nombres(a604)).toEqual(["María Rodríguez"]);
  });

  test("casa sin propietario registrado: lista vacía, sin romper nada", async () => {
    const t = convexTest(schema, modules);
    const s = await escenario(t);
    const id = await aporte(t, s, s.sin);

    const n = (await listar(t, s)).find((r) => r._id === id)!;
    expect(n.unidades.map((u) => u.numero)).toEqual(["605"]);
    expect(n.propietarios).toEqual([]);
  });

  test("los aportes viejos, con la unidad en los campos sueltos, también lo muestran", async () => {
    const t = convexTest(schema, modules);
    const s = await escenario(t);
    const viejo = await t.run((ctx) =>
      ctx.db.insert("guardiaNovedadReportes", {
        condominioId: s.condominioId,
        titulo: "Aporte Voluntario Parqueadero · HDW-741",
        descripcion: "Placa HDW-741 (unidad 603).",
        prioridad: "media",
        vehiculoPlaca: "HDW-741",
        unidadId: s.c603,
        unidadNumero: "603",
        reportadoPorUserId: s.guardaId,
        reportadoPorNombre: "Guarda Nocturno",
        createdAt: AHORA - 1000,
      }),
    );
    const sinCasa = await t.run((ctx) =>
      ctx.db.insert("guardiaNovedadReportes", {
        condominioId: s.condominioId,
        titulo: "Aporte Voluntario Parqueadero · QQQ111",
        descripcion: "Placa no registrada en el conjunto.",
        prioridad: "media",
        vehiculoPlaca: "QQQ111",
        reportadoPorUserId: s.guardaId,
        reportadoPorNombre: "Guarda Nocturno",
        createdAt: AHORA - 2000,
      }),
    );

    const lista = await listar(t, s);
    expect(lista.find((r) => r._id === viejo)!.propietarios.map((p) => p.nombre)).toEqual([
      "Carlos Pérez",
    ]);
    expect(lista.find((r) => r._id === sinCasa)!.propietarios).toEqual([]);
  });

  test("las demás novedades siguen igual y no traen propietario", async () => {
    const t = convexTest(schema, modules);
    const s = await escenario(t);
    const id = await como(t, "guarda").mutation(api.guardia.reportarNovedad, {
      condominioId: s.condominioId,
      titulo: "Gotera en el techo",
      descripcion: "Entre la 603 y la 604.",
      prioridad: "baja",
      unidadIds: [s.c603, s.c604],
    });

    const n = (await listar(t, s)).find((r) => r._id === id)!;
    expect(n.titulo).toBe("Gotera en el techo");
    expect(n.unidades.map((u) => u.numero)).toEqual(["603", "604"]);
    expect(n.propietarios).toEqual([]);
  });
});
