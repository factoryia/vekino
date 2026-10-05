import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import betterAuthTest from "@convex-dev/better-auth/test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import { viasOperativasEnConjunto } from "../convex/model/vias";

const modules = import.meta.glob("../convex/**/*.ts");

/**
 * FASE 10: LA CUSTODIA DE INVENTARIO SIGUE EL CONTEXTO OPERATIVO DEL GUARDA.
 *
 * En la custodia interna de un conjunto quien obra es el SUPERVISOR
 * (`inventario.custodiar`); el guarda es a quien se le entrega. Lo que depende
 * del guarda es si HOY opera en esa portería: para recibir material, para
 * salir en el desplegable y para no figurar como "pendiente". Eso se pregunta
 * ahora con las vías operativas de la Fase 8: con una cobertura activa en B,
 * Jason recibe material de B y no de A. Las reglas de quien obra —supervisor,
 * administrador de la compañía— no cambian con la cobertura de nadie.
 *
 * Reparto:
 *   jason  → guarda de Andina asignado a Alamos (A) y Cedros (C).
 *   lucas  → guarda de Andina asignado a Alamos.
 *   bruno  → guarda de Andina asignado a Bosque (B).
 *   sofia  → supervisora de Andina en Alamos y Cedros.
 *   sergio → supervisor de Andina en Bosque.
 *   alicia → administradora de Andina.
 */

const MIN = 60 * 1000;
const HORA = 60 * MIN;
const DIA = 24 * HORA;
const AHORA = Date.parse("2026-10-12T08:00:00-05:00");
const INICIO = AHORA + 2 * HORA;
const FIN = INICIO + 8 * HORA;
const DURANTE = INICIO + HORA;
const DESPUES = FIN + HORA;

const CUBRIENDO_BOSQUE = "Está cubriendo Conjunto Bosque";
const SIN_ASIGNACION = "asignación vigente en este conjunto";

const en = (instante: number) => vi.setSystemTime(instante);

async function montar() {
  const t = convexTest(schema, modules);
  betterAuthTest.register(t);
  const desde = AHORA - 60 * DIA;

  const ids = await t.run(async (ctx) => {
    const usuario = (authId: string, name: string, extra = {}) =>
      ctx.db.insert("users", {
        name,
        email: `${authId}@vekino.test`,
        emailVerified: true,
        active: true,
        authId,
        createdAt: AHORA,
        updatedAt: AHORA,
        ...extra,
      });
    const conjunto = (name: string) =>
      ctx.db.insert("condominios", {
        name,
        activeModules: [],
        isActive: true,
        createdAt: AHORA,
        updatedAt: AHORA,
      });

    const superadmin = await usuario("super", "Super", { platformRole: "superadmin" as const });
    const alamos = await conjunto("Conjunto Alamos");
    const bosque = await conjunto("Conjunto Bosque");
    const cedros = await conjunto("Conjunto Cedros");
    const andina = await ctx.db.insert("companiasSeguridad", {
      nombre: "Seguridad Andina",
      estado: "activa",
      createdAt: AHORA,
      updatedAt: AHORA,
    });

    const contrato = (condominioId: Id<"condominios">) =>
      ctx.db.insert("companiaContratos", {
        companiaId: andina,
        condominioId,
        vigenciaDesde: desde,
        creadoPorUserId: superadmin,
        createdAt: AHORA,
        updatedAt: AHORA,
      });
    const kAlamos = await contrato(alamos);
    const kBosque = await contrato(bosque);
    const kCedros = await contrato(cedros);

    const miembro = (userId: Id<"users">, rol: "guardia" | "supervisor" | "admin_compania") =>
      ctx.db.insert("companiaMiembros", {
        userId,
        companiaId: andina,
        roles: [rol],
        isActive: true,
        createdAt: AHORA,
        updatedAt: AHORA,
      });
    const asignacion = (
      contratoId: Id<"companiaContratos">,
      condominioId: Id<"condominios">,
      userId: Id<"users">,
      companiaMiembroId: Id<"companiaMiembros">,
      rol: "guardia" | "supervisor" = "guardia",
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
        createdAt: AHORA,
      });

    const alicia = await usuario("alicia", "Alicia Admin");
    await miembro(alicia, "admin_compania");

    const jason = await usuario("jason", "Jason Guarda");
    const mJason = await miembro(jason, "guardia");
    await asignacion(kAlamos, alamos, jason, mJason);
    await asignacion(kCedros, cedros, jason, mJason);

    const lucas = await usuario("lucas", "Lucas Alamos");
    await asignacion(kAlamos, alamos, lucas, await miembro(lucas, "guardia"));

    const bruno = await usuario("bruno", "Bruno Bosque");
    await asignacion(kBosque, bosque, bruno, await miembro(bruno, "guardia"));

    const sofia = await usuario("sofia", "Sofia Supervisora");
    const mSofia = await miembro(sofia, "supervisor");
    await asignacion(kAlamos, alamos, sofia, mSofia, "supervisor");
    await asignacion(kCedros, cedros, sofia, mSofia, "supervisor");

    const sergio = await usuario("sergio", "Sergio Supervisor");
    await asignacion(kBosque, bosque, sergio, await miembro(sergio, "supervisor"), "supervisor");

    return {
      alamos, bosque, cedros, andina,
      kAlamos, kBosque, kCedros,
      alicia, jason, mJason, lucas, bruno, sofia, sergio,
    };
  });

  const como = (authId: string) => t.withIdentity({ subject: authId });

  /** Un elemento de Andina ya asignado a un conjunto (tareas 1 y 2). */
  const itemEn = async (condominioId: Id<"condominios">, nombre: string) => {
    const itemId = await como("alicia").mutation(api.inventario.crear, {
      companiaId: ids.andina,
      nombre,
    });
    await como("alicia").mutation(api.inventarioAsignaciones.asignar, { itemId, condominioId });
    return itemId;
  };

  const cubrir = (extra: Partial<Doc<"coberturas">> = {}) =>
    t.run((ctx) =>
      ctx.db.insert("coberturas", {
        companiaId: ids.andina,
        userId: ids.jason,
        condominioId: ids.bosque,
        contratoId: ids.kBosque,
        inicio: INICIO,
        fin: FIN,
        estado: "aceptada",
        solicitadoPorUserId: ids.alicia,
        solicitadoEn: AHORA - DIA,
        respuesta: "aceptada",
        respondidoEn: AHORA - DIA,
        respondidoPorUserId: ids.jason,
        ...extra,
      }),
    );

  /** El supervisor entrega a Jason: true si pasa, el mensaje si no. */
  const entregarAJason = (supervisor: string, itemId: Id<"inventarioItems">) =>
    como(supervisor)
      .mutation(api.inventarioGuardas.entregar, { itemId, guardaUserId: ids.jason })
      .then(
        () => true as const,
        (err: Error) => err.message,
      );

  const desplegable = async (supervisor: string, condominioId: Id<"condominios">) =>
    (await como(supervisor).query(api.inventarioGuardas.guardasDisponibles, { condominioId })).map(
      (g) => g.userId,
    );

  return { t, ...ids, como, itemEn, cubrir, entregarAJason, desplegable };
}

let e: Awaited<ReturnType<typeof montar>>;
let radioA: Id<"inventarioItems">;
let radioB: Id<"inventarioItems">;
let radioC: Id<"inventarioItems">;

beforeEach(async () => {
  en(AHORA);
  e = await montar();
  radioA = await e.itemEn(e.alamos, "Radio de Alamos");
  radioB = await e.itemEn(e.bosque, "Radio de Bosque");
  radioC = await e.itemEn(e.cedros, "Radio de Cedros");
});
afterEach(() => vi.useRealTimers());

describe("Fase 10: la custodia del inventario sigue el contexto operativo", () => {
  test("A. sin cobertura: Jason recibe material de A como siempre", async () => {
    expect(await e.desplegable("sofia", e.alamos)).toEqual([e.jason, e.lucas]);
    expect(await e.entregarAJason("sofia", radioA)).toBe(true);
    expect(await e.entregarAJason("sergio", radioB)).toContain(SIN_ASIGNACION);
    const lista = await e.como("sofia").query(api.inventarioGuardas.itemsDelCondominio, {
      condominioId: e.alamos,
    });
    expect(lista.items[0]!.custodia).toMatchObject({ guardaUserId: e.jason, pendiente: false });
  });

  test("B. cobertura activa: B permite, A rechaza", async () => {
    await e.cubrir();
    en(DURANTE);
    expect(await e.desplegable("sergio", e.bosque)).toEqual([e.bruno, e.jason]);
    expect(await e.desplegable("sofia", e.alamos)).toEqual([e.lucas]);
    expect(await e.entregarAJason("sergio", radioB)).toBe(true);
    expect(await e.entregarAJason("sofia", radioA)).toContain(CUBRIENDO_BOSQUE);
  });

  test("C. cobertura futura: sigue en A; en el instante de inicio cambia", async () => {
    await e.cubrir();
    en(INICIO - 1);
    expect(await e.desplegable("sofia", e.alamos)).toContain(e.jason);
    expect(await e.desplegable("sergio", e.bosque)).not.toContain(e.jason);
    expect(await e.entregarAJason("sergio", radioB)).toContain(SIN_ASIGNACION);

    en(INICIO);
    expect(await e.desplegable("sofia", e.alamos)).not.toContain(e.jason);
    expect(await e.desplegable("sergio", e.bosque)).toContain(e.jason);
    expect(await e.entregarAJason("sofia", radioA)).toContain(CUBRIENDO_BOSQUE);
    expect(await e.entregarAJason("sergio", radioB)).toBe(true);
  });

  test("D. al terminar: vuelve A, y lo de B que se quedó en sus manos queda pendiente", async () => {
    await e.cubrir();
    en(DURANTE);
    expect(await e.entregarAJason("sergio", radioB)).toBe(true);
    const enB = () =>
      e.como("sergio").query(api.inventarioGuardas.itemsDelCondominio, { condominioId: e.bosque });
    expect((await enB()).pendientes).toBe(0);

    en(FIN);
    expect(await e.desplegable("sofia", e.alamos)).toContain(e.jason);
    expect(await e.desplegable("sergio", e.bosque)).not.toContain(e.jason);
    expect(await e.entregarAJason("sofia", radioA)).toBe(true);
    /* El radio de Bosque sigue con él: no se cierra solo, se señala. */
    expect((await enB()).pendientes).toBe(1);
    await e.como("sergio").mutation(api.inventarioGuardas.recibir, { itemId: radioB });
    expect((await enB()).pendientes).toBe(0);
  });

  test("E. inhabilitada mientras corre: vuelve A en el acto", async () => {
    const coberturaId = await e.cubrir();
    en(DURANTE);
    expect(await e.entregarAJason("sofia", radioA)).toContain(CUBRIENDO_BOSQUE);
    await e.como("alicia").mutation(api.coberturas.inhabilitar, { coberturaId, motivo: "Se retiró." });
    expect(await e.entregarAJason("sofia", radioA)).toBe(true);
    expect(await e.desplegable("sergio", e.bosque)).not.toContain(e.jason);
  });

  test("F. contrato de B terminado: B deja de operar y vuelve A", async () => {
    await e.cubrir();
    en(DURANTE);
    await e.t.run((ctx) => ctx.db.patch(e.kBosque, { terminadoEn: DURANTE - MIN }));
    expect(await e.desplegable("sofia", e.alamos)).toContain(e.jason);
    expect(await e.entregarAJason("sofia", radioA)).toBe(true);
  });

  test("G. conjunto B inactivo: B deja de operar y vuelve A", async () => {
    await e.cubrir();
    en(DURANTE);
    await e.t.run((ctx) => ctx.db.patch(e.bosque, { isActive: false }));
    expect(await e.desplegable("sofia", e.alamos)).toContain(e.jason);
    expect(await e.entregarAJason("sofia", radioA)).toBe(true);
  });

  test("H. compañía suspendida: la cobertura deja de ser vía", async () => {
    await e.cubrir();
    en(DURANTE);
    await e.t.run((ctx) => ctx.db.patch(e.andina, { estado: "suspendida" }));
    /* Sus asignaciones son de la misma compañía: A no vuelve, nadie de Andina
     * opera, y el supervisor tampoco reparte. Lo que importa aquí es que la
     * cobertura no sigue dando vía en B. */
    const enB = await e.t.run(async (ctx) => {
      const { vias, contexto } = await viasOperativasEnConjunto(ctx, e.jason, e.bosque);
      return { vias: vias.length, contexto: contexto.tipo };
    });
    expect(enB).toEqual({ vias: 0, contexto: "permanente" });
    await expect(
      e.como("sergio").query(api.inventarioGuardas.guardasDisponibles, { condominioId: e.bosque }),
    ).rejects.toThrow("inventario.custodiar");
  });

  test("I. guarda dado de baja: la cobertura deja de operar", async () => {
    await e.cubrir();
    en(DURANTE);
    await e.t.run((ctx) => ctx.db.patch(e.mJason, { isActive: false }));
    expect(await e.entregarAJason("sergio", radioB)).toContain(SIN_ASIGNACION);
    expect(await e.entregarAJason("sofia", radioA)).toContain(SIN_ASIGNACION);
    expect(await e.desplegable("sergio", e.bosque)).not.toContain(e.jason);
  });

  test("J. asignado a A y C, cubriendo B: solo B opera", async () => {
    await e.cubrir();
    en(DURANTE);
    expect(await e.desplegable("sofia", e.alamos)).not.toContain(e.jason);
    expect(await e.desplegable("sofia", e.cedros)).not.toContain(e.jason);
    expect(await e.entregarAJason("sofia", radioA)).toContain(CUBRIENDO_BOSQUE);
    expect(await e.entregarAJason("sofia", radioC)).toContain(CUBRIENDO_BOSQUE);
    expect(await e.entregarAJason("sergio", radioB)).toBe(true);
  });

  test("K. el supervisor de A conserva su alcance durante la cobertura de Jason", async () => {
    await e.cubrir();
    expect(await e.entregarAJason("sofia", radioA)).toBe(true);
    en(DURANTE);
    const sofia = e.como("sofia");
    /* Sigue viendo su portería, y el radio de A en manos de Jason, que hoy
     * está en otra, queda señalado. */
    const lista = await sofia.query(api.inventarioGuardas.itemsDelCondominio, { condominioId: e.alamos });
    expect(lista.items.find((i) => i.itemId === radioA)!.custodia).toMatchObject({
      guardaUserId: e.jason,
      pendiente: true,
    });
    expect(lista.pendientes).toBe(1);
    const historial = await sofia.query(api.inventarioGuardas.historialDeItem, { itemId: radioA });
    expect(historial[0]).toMatchObject({ guardaUserId: e.jason, pendiente: true });
    /* Registra novedades, se lo recibe aunque Jason hoy no opere aquí, y
     * reparte a quien sí opera. */
    await sofia.mutation(api.inventarioGuardas.registrarNovedad, {
      itemId: radioA,
      descripcion: "Se lo llevó a la cobertura.",
    });
    await sofia.mutation(api.inventarioGuardas.recibir, { itemId: radioA });
    await sofia.mutation(api.inventarioGuardas.entregar, { itemId: radioA, guardaUserId: e.lucas });

    /* Al terminar la cobertura, Jason vuelve a figurar en A. */
    en(DESPUES);
    expect(await e.desplegable("sofia", e.alamos)).toContain(e.jason);
  });

  test("L. la administradora de la compañía conserva sus capacidades", async () => {
    await e.cubrir();
    en(DURANTE);
    expect(await e.entregarAJason("sergio", radioB)).toBe(true);
    const alicia = e.como("alicia");
    /* Ve quién tiene cada elemento, aunque sea material entregado en una
     * cobertura. */
    const detalle = await alicia.query(api.inventario.detalle, { itemId: radioB });
    expect(JSON.stringify(detalle)).toContain("Jason Guarda");
    /* La regla de la tarea 2 sigue: no se devuelve a la bodega lo que un
     * guarda tiene en la mano. */
    await expect(
      alicia.mutation(api.inventarioAsignaciones.devolver, { itemId: radioB }),
    ).rejects.toThrow("lo tiene el guarda");
    /* Y sigue sin repartir material dentro de una portería. */
    await expect(
      alicia.mutation(api.inventarioGuardas.entregar, { itemId: radioA, guardaUserId: e.lucas }),
    ).rejects.toThrow("inventario.custodiar");
    /* Crear y asignar, como siempre. */
    const nuevo = await e.itemEn(e.alamos, "Linterna");
    expect(nuevo).toBeTruthy();
  });

  test("M. la portería de la Fase 8 sigue igual", async () => {
    await e.cubrir();
    en(DURANTE);
    expect((await e.como("jason").query(api.guardia.home, { condominioId: e.bosque })).allowed).toBe(true);
    expect((await e.como("jason").query(api.guardia.home, { condominioId: e.alamos })).allowed).toBe(false);
  });
});

/*
 * SEGURIDAD: para cada operación de la custodia, quién obra y sobre qué.
 *
 * El guarda no obra en el inventario, con o sin cobertura: no tiene
 * `inventario.custodiar`. Lo que su contexto decide es dónde puede ser
 * destinatario: con la cobertura en B, el material de B le llega y el de A no.
 */
describe("Fase 10: seguridad de la custodia con la cobertura activa", () => {
  test("el guarda no reparte ni consulta material, ni en A ni en B", async () => {
    await e.cubrir();
    en(DURANTE);
    const jason = e.como("jason");
    for (const condominioId of [e.alamos, e.bosque]) {
      await expect(
        jason.query(api.inventarioGuardas.itemsDelCondominio, { condominioId }),
      ).rejects.toThrow("inventario.custodiar");
      await expect(
        jason.query(api.inventarioGuardas.guardasDisponibles, { condominioId }),
      ).rejects.toThrow("inventario.custodiar");
    }
    for (const itemId of [radioA, radioB]) {
      await expect(
        jason.mutation(api.inventarioGuardas.entregar, { itemId, guardaUserId: e.jason }),
      ).rejects.toThrow("inventario.custodiar");
      await expect(jason.mutation(api.inventarioGuardas.recibir, { itemId })).rejects.toThrow(
        "inventario.custodiar",
      );
      await expect(
        jason.mutation(api.inventarioGuardas.registrarNovedad, { itemId, descripcion: "x" }),
      ).rejects.toThrow("inventario.custodiar");
      await expect(jason.query(api.inventarioGuardas.historialDeItem, { itemId })).rejects.toThrow(
        "inventario.custodiar",
      );
    }
  });

  test("como destinatario: B pasa, A se rechaza, en cada punto donde cuenta", async () => {
    await e.cubrir();
    en(DURANTE);
    // Desplegable.
    expect(await e.desplegable("sergio", e.bosque)).toContain(e.jason);
    expect(await e.desplegable("sofia", e.alamos)).not.toContain(e.jason);
    // Entrega.
    expect(await e.entregarAJason("sergio", radioB)).toBe(true);
    expect(await e.entregarAJason("sofia", radioA)).toContain(CUBRIENDO_BOSQUE);
    // Presencia (pendiente) en el listado y en el historial de B.
    const enB = await e.como("sergio").query(api.inventarioGuardas.itemsDelCondominio, {
      condominioId: e.bosque,
    });
    expect(enB.items.find((i) => i.itemId === radioB)!.custodia).toMatchObject({ pendiente: false });
    const historialB = await e.como("sergio").query(api.inventarioGuardas.historialDeItem, {
      itemId: radioB,
    });
    expect(historialB[0]).toMatchObject({ guardaUserId: e.jason, pendiente: false });
  });

  test("no se modifica ninguna asignación, membresía, contrato ni cobertura", async () => {
    const coberturaId = await e.cubrir();
    const foto = () =>
      e.t.run(async (ctx) => ({
        asignaciones: await ctx.db.query("asignaciones").collect(),
        memberships: await ctx.db.query("memberships").collect(),
        contratos: await ctx.db.query("companiaContratos").collect(),
        miembros: await ctx.db.query("companiaMiembros").collect(),
        cobertura: await ctx.db.get(coberturaId),
      }));
    const antes = await foto();
    en(DURANTE);
    await e.entregarAJason("sergio", radioB);
    await e.entregarAJason("sofia", radioA);
    await e.como("sergio").mutation(api.inventarioGuardas.recibir, { itemId: radioB });
    await e.como("sergio").mutation(api.inventarioGuardas.registrarNovedad, {
      itemId: radioB,
      descripcion: "Revisado.",
    });
    expect(await foto()).toEqual(antes);
  });
});
