import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../convex/_generated/server";
import { listarPagina } from "../convex/rondas";
import { montar } from "./helpers/trazabilidad";

const modules = import.meta.glob("../convex/**/*.ts");

/**
 * EL HISTORIAL DE RONDAS, COMPLETO Y POR PÁGINAS (`rondas.listarPagina`).
 *
 * `listar` corta en las últimas 50 y en Ciudad del Campo II quedaban nueve
 * rondas que no se podían ver. `listarPagina` pagina en la base con los
 * cursores de Convex. Estas pruebas comprueban:
 *
 *   A. Que recorriendo las páginas sale TODO el historial: sin duplicados,
 *      sin huecos, en el orden de `listar` y con sus mismos elementos.
 *   B. Que el filtro por guarda va por su índice: páginas llenas, solo lo
 *      suyo, y sin leer las rondas de los demás.
 *   C. Que los permisos son los de `listar`, persona por persona.
 *   D. Que cada página lee sus rondas y lo que cuelga de ellas, y nada más
 *      (medido con la contabilidad de `convex-test`), también con los
 *      límites reales de Convex aplicados.
 */

type T = ReturnType<typeof convexTest>;
const como = (t: T, subject: string) => t.withIdentity({ subject });

const MIN = 60_000;
const HORA = 60 * MIN;
const BASE = Date.parse("2026-09-17T06:00:00-05:00");
/* Documentos del tamaño de los de producción (~600 B). */
const RELLENO = "Registro de portería con detalle operativo del puesto. ".repeat(7);

type Pagina = { numItems: number; cursor: string | null; endCursor?: string | null };

type Opciones = {
  /** Cuántas rondas hace cada guarda. Se intercalan en el tiempo. */
  porGuarda: number[];
  /** Cada cuántas rondas una del registro antiguo, sin guarda (0 = ninguna). */
  antiguaCada?: number;
  sueltosMinuta?: number;
  sueltosNovedades?: number;
};

/**
 * Un conjunto con su historial: las rondas de varios guardas intercaladas
 * en el tiempo, las del registro antiguo (sin guarda), los hitos ligados a
 * cada una y minuta y novedades SIN ronda. Devuelve los ids de las rondas en
 * orden de creación y cuántos documentos cuelgan de cada una.
 */
async function conjuntoConHistorial(t: T, o: Opciones) {
  const base = await t.run(async (ctx) => {
    const conjunto = (name: string) =>
      ctx.db.insert("condominios", { name, activeModules: [], isActive: true, createdAt: BASE, updatedAt: BASE });
    const usuario = (authId: string, name: string, extra: Partial<Doc<"users">> = {}) =>
      ctx.db.insert("users", {
        name,
        email: `${authId}@vekino.test`,
        emailVerified: true,
        active: true,
        authId,
        createdAt: BASE,
        updatedAt: BASE,
        ...extra,
      });
    const condominioId = await conjunto("Ciudad Sintética");
    const otro = await conjunto("Otro conjunto");
    await usuario("super", "Super", { platformRole: "superadmin" });
    const guardias: { id: Id<"users">; nombre: string }[] = [];
    for (let g = 0; g < o.porGuarda.length; g++) {
      const nombre = `Guarda ${g + 1}`;
      const id = await usuario(`guarda${g + 1}`, nombre);
      await ctx.db.insert("memberships", {
        userId: id,
        condominioId,
        roles: ["guardia"],
        isActive: true,
        createdAt: BASE,
        updatedAt: BASE,
      });
      guardias.push({ id, nombre });
    }
    const turnoId = await ctx.db.insert("guardiaTurnos", {
      condominioId,
      guardiaUserId: guardias[0]?.id ?? (await usuario("relevo", "Relevo")),
      guardiaNombre: "Guarda 1",
      checklist: [],
      estado: "cerrado",
      fechaInicio: BASE,
      createdAt: BASE,
      updatedAt: BASE,
    });
    return { condominioId, otro, guardias, turnoId };
  });

  /* Reparto intercalado: en cada vuelta, una ronda de cada guarda al que le
   * queden; y cada `antiguaCada`, una del registro antiguo. */
  const quedan = [...o.porGuarda];
  const plan: (number | null)[] = [];
  while (quedan.some((n) => n > 0)) {
    for (let g = 0; g < quedan.length; g++) {
      if (quedan[g] <= 0) continue;
      quedan[g]--;
      plan.push(g);
      if (o.antiguaCada && plan.length % o.antiguaCada === 0) plan.push(null);
    }
  }

  const rondas: Id<"guardiaRondas">[] = [];
  const deGuarda = new Map<Id<"guardiaRondas">, number | null>();
  for (let i = 0; i < plan.length; i += 500) {
    const tanda = plan.slice(i, i + 500);
    const ids = await t.run(async (ctx) => {
      const out: Id<"guardiaRondas">[] = [];
      for (let k = 0; k < tanda.length; k++) {
        const n = i + k;
        const g = tanda[k];
        const inicio = BASE + n * HORA;
        out.push(
          await ctx.db.insert("guardiaRondas", {
            condominioId: base.condominioId,
            turnoId: base.turnoId,
            zona: n % 2 ? "Perímetro" : "Parqueadero",
            fotos: [],
            createdAt: inicio,
            ...(g === null
              ? {}
              : {
                  numero: n + 1,
                  guardiaUserId: base.guardias[g].id,
                  guardiaNombre: base.guardias[g].nombre,
                  estado: "finalizada" as const,
                  fechaInicio: inicio,
                  fechaCierre: inicio + 40 * MIN,
                }),
          }),
        );
      }
      return out;
    });
    ids.forEach((id, k) => deGuarda.set(id, tanda[k]));
    rondas.push(...ids);
  }

  /* Hitos ligados (`n % 4` eventos y `n % 3` novedades) y el historial sin
   * ronda, en orden cronológico y por tandas. */
  type Pendiente = { en: number; insertar: (ctx: MutationCtx) => Promise<unknown> };
  const pendientes: Pendiente[] = [];
  const ligados = new Map<Id<"guardiaRondas">, number>();
  const evento = (en: number, rondaId?: Id<"guardiaRondas">) =>
    pendientes.push({
      en,
      insertar: (ctx) =>
        ctx.db.insert("minutaEventos", {
          condominioId: base.condominioId,
          ...(rondaId ? { rondaId } : {}),
          modulo: "visitantes",
          tipo: "Ingreso",
          unidad: "Casa 1",
          resumen: RELLENO,
          estado: "cerrado",
          actorNombre: "Guarda 1",
          createdAt: en,
        }),
    });
  const novedad = (en: number, rondaId?: Id<"guardiaRondas">) =>
    pendientes.push({
      en,
      insertar: (ctx) =>
        ctx.db.insert("guardiaNovedadReportes", {
          condominioId: base.condominioId,
          ...(rondaId ? { rondaId } : {}),
          titulo: "Novedad",
          descripcion: RELLENO,
          prioridad: "media",
          reportadoPorUserId: base.guardias[0].id,
          reportadoPorNombre: "Guarda 1",
          createdAt: en,
        }),
    });
  rondas.forEach((rondaId, n) => {
    const inicio = BASE + n * HORA;
    for (let k = 0; k < n % 4; k++) evento(inicio + (k + 1) * MIN, rondaId);
    for (let k = 0; k < n % 3; k++) novedad(inicio + (k + 1) * MIN + 1000, rondaId);
    ligados.set(rondaId, (n % 4) + (n % 3));
  });
  const periodo = Math.max(rondas.length, 1) * HORA;
  for (let j = 0; j < (o.sueltosMinuta ?? 0); j++) evento(BASE + Math.floor((j * periodo) / o.sueltosMinuta!) + 7_000);
  for (let j = 0; j < (o.sueltosNovedades ?? 0); j++) novedad(BASE + Math.floor((j * periodo) / o.sueltosNovedades!) + 11_000);
  pendientes.sort((a, b) => a.en - b.en);
  for (let i = 0; i < pendientes.length; i += 1000) {
    const tanda = pendientes.slice(i, i + 1000);
    await t.run(async (ctx) => {
      for (const p of tanda) await p.insertar(ctx);
    });
  }

  return { ...base, rondas, deGuarda, ligados };
}

/** Recorre todas las páginas como lo hace `usePaginatedQuery` con "Cargar más". */
async function recorrer(
  t: T,
  subject: string,
  args: { condominioId: Id<"condominios">; guardiaUserId?: Id<"users"> },
  numItems: number,
) {
  const paginas: Id<"guardiaRondas">[][] = [];
  const items = [];
  let cursor: string | null = null;
  for (let vuelta = 0; vuelta < 1000; vuelta++) {
    const r = await como(t, subject).query(api.rondas.listarPagina, {
      ...args,
      paginationOpts: { numItems, cursor },
    });
    paginas.push(r.page.map((x) => x._id));
    items.push(...r.page);
    if (r.isDone) return { paginas, items };
    cursor = r.continueCursor;
  }
  throw new Error("La paginación no terminó.");
}

type Metricas = { bytes: number; docs: number; rangos: number };

/** Lo que lee una página, según `convex-test`, con el handler real. */
async function medirPagina(
  t: T,
  subject: string,
  args: { condominioId: Id<"condominios">; guardiaUserId?: Id<"users">; paginationOpts: Pagina },
): Promise<Metricas & { ids: Id<"guardiaRondas">[] }> {
  return await como(t, subject).run(async (ctx) => {
    const handler = (listarPagina as unknown as {
      _handler: (c: QueryCtx, a: typeof args) => Promise<{ page: { _id: Id<"guardiaRondas"> }[] }>;
    })._handler;
    const r = await handler(ctx, args);
    const m = await ctx.meta.getTransactionMetrics();
    return {
      bytes: m.bytesRead.used,
      docs: m.documentsRead.used,
      rangos: m.databaseQueries.used,
      ids: r.page.map((x) => x._id),
    };
  });
}

/** Cuántos documentos cuelgan de estas rondas (por el índice de la Fase 1). */
async function documentosLigados(t: T, condominioId: Id<"condominios">, rondas: Id<"guardiaRondas">[]) {
  return await t.run(async (ctx) => {
    let n = 0;
    for (const rondaId of rondas) {
      for (const tabla of ["minutaEventos", "guardiaNovedadReportes"] as const) {
        n += (
          await ctx.db
            .query(tabla)
            .withIndex("by_condominio_ronda", (q) => q.eq("condominioId", condominioId).eq("rondaId", rondaId))
            .collect()
        ).length;
      }
    }
    return n;
  });
}

const sinRepetidos = <X>(xs: X[]) => new Set(xs).size === xs.length;

/**
 * Qué índice usa cada consulta a la base, anotado al vuelo.
 *
 * Hace falta además de medir: `convex-test` aplica `.filter()` dentro de su
 * base simulada y solo cuenta como leídos los documentos que pasan, mientras
 * que Convex cuenta todo lo recorrido. Un "índice del conjunto + filtro por
 * guarda" saldría igual de barato aquí y no en producción. Esto lo delata.
 */
function espiarConsultas(ctx: QueryCtx) {
  const llamadas: string[] = [];
  const ANOTAR = ["filter", "order", "paginate", "collect", "take", "first", "unique"];
  const envolver = (obj: object, tabla: string): object =>
    new Proxy(obj, {
      get(target, prop) {
        const val = Reflect.get(target, prop, target);
        if (typeof val !== "function") return val;
        if (typeof prop !== "string") return val.bind(target);
        return (...args: unknown[]) => {
          if (prop === "withIndex") llamadas.push(`${tabla}.withIndex(${String(args[0])})`);
          else if (ANOTAR.includes(prop)) llamadas.push(`${tabla}.${prop}`);
          const r = val.apply(target, args);
          return r && typeof r === "object" && !(r instanceof Promise) ? envolver(r, tabla) : r;
        };
      },
    });
  const db = new Proxy(ctx.db, {
    get(target, prop) {
      const val = Reflect.get(target, prop, target);
      if (prop === "query") return (tabla: string) => envolver(val.call(target, tabla), tabla);
      return typeof val === "function" ? val.bind(target) : val;
    },
  });
  return { ctx: { ...ctx, db } as QueryCtx, llamadas };
}

// ─────────────────────────────────────────────────────────────
// A. Paginación completa
// ─────────────────────────────────────────────────────────────

describe("A. Paginación completa", () => {
  test("Ciudad del Campo II: sus 59 rondas son accesibles (listar solo daba 50)", async () => {
    const t = convexTest(schema, modules);
    // 59 rondas, como en producción: 3 guardas y alguna del registro antiguo.
    const e = await conjuntoConHistorial(t, { porGuarda: [20, 20, 17], antiguaCada: 20, sueltosMinuta: 380, sueltosNovedades: 220 });
    expect(e.rondas).toHaveLength(59);

    const { paginas, items } = await recorrer(t, "super", { condominioId: e.condominioId }, 20);
    expect(paginas.map((p) => p.length)).toEqual([20, 20, 19]);
    const ids = items.map((r) => r._id);
    expect(sinRepetidos(ids)).toBe(true);
    // Todas, de la más nueva a la más vieja.
    expect(ids).toEqual([...e.rondas].reverse());

    // listar sigue igual: las 50 últimas, y son las mismas que las primeras 50 del recorrido.
    const listadas = await como(t, "super").query(api.rondas.listar, { condominioId: e.condominioId });
    expect(listadas).toHaveLength(50);
    expect(listadas).toEqual(items.slice(0, 50));
  });

  test("con 65 rondas: páginas exactas, sin huecos, mismo orden y mismos elementos que listar", async () => {
    const t = convexTest(schema, modules);
    const e = await conjuntoConHistorial(t, { porGuarda: [25, 25, 10], antiguaCada: 12, sueltosMinuta: 100, sueltosNovedades: 40 });
    expect(e.rondas).toHaveLength(65);

    const { paginas, items } = await recorrer(t, "super", { condominioId: e.condominioId }, 20);
    expect(paginas.map((p) => p.length)).toEqual([20, 20, 20, 5]);
    expect(sinRepetidos(items.map((r) => r._id))).toBe(true);
    // El recorrido completo es exactamente lo que da listar con su máximo (200).
    const todas = await como(t, "super").query(api.rondas.listar, { condominioId: e.condominioId, limite: 200 });
    expect(items).toEqual(todas);
    // Y los contadores son los de cada ronda.
    for (const r of items) {
      expect(r.totales.eventos + r.totales.novedades + r.totales.vehiculos).toBe(e.ligados.get(r._id));
    }
    // Las del registro antiguo salen, sin número y como finalizadas.
    const antiguas = items.filter((r) => r.numero === null);
    expect(antiguas.length).toBe(5);
    expect(antiguas.every((r) => r.estado === "finalizada" && r.guardiaNombre === null)).toBe(true);
  });

  test("otro tamaño de página da el mismo historial; un conjunto sin rondas da una página vacía", async () => {
    const t = convexTest(schema, modules);
    const e = await conjuntoConHistorial(t, { porGuarda: [14, 9], antiguaCada: 7 });
    const de20 = await recorrer(t, "super", { condominioId: e.condominioId }, 20);
    const de7 = await recorrer(t, "super", { condominioId: e.condominioId }, 7);
    const de1 = await recorrer(t, "super", { condominioId: e.condominioId }, 1);
    expect(de7.items).toEqual(de20.items);
    expect(de1.items).toEqual(de20.items);
    expect(de7.paginas.slice(0, -1).every((p) => p.length === 7)).toBe(true);

    const vacio = await como(t, "super").query(api.rondas.listarPagina, {
      condominioId: e.otro,
      paginationOpts: { numItems: 20, cursor: null },
    });
    expect(vacio.page).toEqual([]);
    expect(vacio.isDone).toBe(true);
  });

  test("una ronda nueva entre dos páginas no duplica ni se salta nada", async () => {
    const t = convexTest(schema, modules);
    const e = await conjuntoConHistorial(t, { porGuarda: [30, 15] });
    const sup = como(t, "super");
    const args = { condominioId: e.condominioId };

    const p1 = await sup.query(api.rondas.listarPagina, { ...args, paginationOpts: { numItems: 20, cursor: null } });
    // Llega una ronda nueva mientras el usuario mira la primera página.
    const nueva = await t.run((ctx) =>
      ctx.db.insert("guardiaRondas", {
        condominioId: e.condominioId,
        turnoId: e.turnoId,
        zona: "Nueva",
        fotos: [],
        numero: 999,
        guardiaUserId: e.guardias[0].id,
        guardiaNombre: "Guarda 1",
        estado: "en_curso",
        fechaInicio: BASE + 1000 * HORA,
        createdAt: BASE + 1000 * HORA,
      }),
    );
    // "Cargar más" sigue del cursor: las 20 siguientes a las ya vistas.
    const p2 = await sup.query(api.rondas.listarPagina, { ...args, paginationOpts: { numItems: 20, cursor: p1.continueCursor } });
    const orden = [...e.rondas].reverse();
    expect(p1.page.map((r) => r._id)).toEqual(orden.slice(0, 20));
    expect(p2.page.map((r) => r._id)).toEqual(orden.slice(20, 40));
    // La primera página, recalculada como la mantiene `usePaginatedQuery`
    // (hasta su cursor final), trae la nueva arriba y las mismas 20 debajo.
    const p1Viva = await sup.query(api.rondas.listarPagina, {
      ...args,
      paginationOpts: { numItems: 20, cursor: null, endCursor: p1.continueCursor },
    });
    expect(p1Viva.page.map((r) => r._id)).toEqual([nueva, ...orden.slice(0, 20)]);
  });

  test("el tamaño de página no pasa de 200 aunque se pidan más", async () => {
    const t = convexTest(schema, modules);
    const e = await conjuntoConHistorial(t, { porGuarda: [130, 130] });
    const r = await como(t, "super").query(api.rondas.listarPagina, {
      condominioId: e.condominioId,
      paginationOpts: { numItems: 5000, cursor: null },
    });
    expect(r.page).toHaveLength(200);
    expect(r.isDone).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// B. Filtro por guarda
// ─────────────────────────────────────────────────────────────

describe("B. Filtro por guarda", () => {
  test("páginas llenas, solo sus rondas, en orden, y todo su historial", async () => {
    const t = convexTest(schema, modules);
    const e = await conjuntoConHistorial(t, { porGuarda: [25, 40, 6], antiguaCada: 9 });

    for (let g = 0; g < e.guardias.length; g++) {
      const guardiaUserId = e.guardias[g].id;
      const suyas = e.rondas.filter((id) => e.deGuarda.get(id) === g).reverse();
      const { paginas, items } = await recorrer(t, "super", { condominioId: e.condominioId, guardiaUserId }, 10);

      // Ninguna página se queda corta salvo la última.
      expect(paginas.slice(0, -1).every((p) => p.length === 10)).toBe(true);
      expect(items.map((r) => r._id)).toEqual(suyas);
      expect(items.every((r) => r.guardiaNombre === e.guardias[g].nombre)).toBe(true);
      // Igual que listar con el mismo filtro.
      expect(items).toEqual(
        await como(t, "super").query(api.rondas.listar, { condominioId: e.condominioId, guardiaUserId, limite: 200 }),
      );
    }
  });

  test("cada consulta va por su índice, sin filtros sobre lo recorrido", async () => {
    const t = convexTest(schema, modules);
    const e = await conjuntoConHistorial(t, { porGuarda: [8, 8], sueltosMinuta: 30, sueltosNovedades: 10 });
    const handler = (listarPagina as unknown as { _handler: (c: QueryCtx, a: unknown) => Promise<unknown> })._handler;
    const consultas = (guardiaUserId?: Id<"users">) =>
      como(t, "super").run(async (ctx) => {
        const espia = espiarConsultas(ctx as unknown as QueryCtx);
        await handler(espia.ctx, {
          condominioId: e.condominioId,
          ...(guardiaUserId ? { guardiaUserId } : {}),
          paginationOpts: { numItems: 5, cursor: null },
        });
        return espia.llamadas;
      });

    const conGuarda = await consultas(e.guardias[1].id);
    const sinGuarda = await consultas();
    for (const llamadas of [conGuarda, sinGuarda]) {
      // Nada se filtra después de recorrer un índice, en ninguna tabla.
      expect(llamadas.filter((l) => l.endsWith(".filter"))).toEqual([]);
      // Los hitos, siempre por la ronda (Fase 1), nunca por el conjunto entero.
      const hitos = llamadas.filter((l) => /^(minutaEventos|guardiaNovedadReportes)\.withIndex/.test(l));
      expect(hitos.length).toBe(10);
      expect(hitos.every((l) => l.endsWith("(by_condominio_ronda)"))).toBe(true);
      // Una sola paginación, la de las rondas.
      expect(llamadas.filter((l) => l.endsWith(".paginate"))).toEqual(["guardiaRondas.paginate"]);
    }
    const indiceDeRondas = (ls: string[]) => ls.filter((l) => l.startsWith("guardiaRondas.withIndex"));
    expect(indiceDeRondas(conGuarda)).toEqual(["guardiaRondas.withIndex(by_condominio_guardia)"]);
    expect(indiceDeRondas(sinGuarda)).toEqual(["guardiaRondas.withIndex(by_condominio)"]);
  });

  test("va por su índice: las rondas de los demás no se leen", async () => {
    /* El guarda 3 tiene 6 rondas. Con o sin 300 rondas más de otros guardas
     * en el conjunto, su página lee lo mismo. */
    const pocas = convexTest(schema, modules);
    const a = await conjuntoConHistorial(pocas, { porGuarda: [0, 0, 6] });
    const muchas = convexTest(schema, modules);
    const b = await conjuntoConHistorial(muchas, { porGuarda: [150, 150, 6] });

    const pagina = { numItems: 10, cursor: null };
    const ma = await medirPagina(pocas, "super", { condominioId: a.condominioId, guardiaUserId: a.guardias[2].id, paginationOpts: pagina });
    const mb = await medirPagina(muchas, "super", { condominioId: b.condominioId, guardiaUserId: b.guardias[2].id, paginationOpts: pagina });

    expect(ma.ids).toHaveLength(6);
    expect(mb.ids).toHaveLength(6);
    const ligadosA = await documentosLigados(pocas, a.condominioId, ma.ids);
    const ligadosB = await documentosLigados(muchas, b.condominioId, mb.ids);
    // Lo leído: sus 6 rondas, lo que cuelga de ellas y unas pocas lecturas de
    // autorización. Las 300 de los demás no aparecen.
    expect(ma.docs - (6 + ligadosA)).toBeLessThanOrEqual(5);
    expect(mb.docs - (6 + ligadosB)).toBe(ma.docs - (6 + ligadosA));
    console.info(
      `[rondas] página filtrada (6 rondas del guarda): ${ma.docs} docs con 6 rondas en el conjunto, ` +
        `${mb.docs} docs con 306 rondas en el conjunto (ligados ${ligadosA} / ${ligadosB})`,
    );
  });
});

// ─────────────────────────────────────────────────────────────
// C. Autorización y aislamiento
// ─────────────────────────────────────────────────────────────

describe("C. Autorización y aislamiento", () => {
  test("los mismos permisos que listar, persona por persona y conjunto por conjunto", async () => {
    const e = await montar();
    /* Administración del conjunto (rol del conjunto, no de la compañía). */
    await e.t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {
        name: "Ada Admin Alamos",
        email: "adminAlamos@vekino.test",
        emailVerified: true,
        active: true,
        authId: "adminAlamos",
        createdAt: BASE,
        updatedAt: BASE,
      });
      await ctx.db.insert("memberships", {
        userId,
        condominioId: e.alamos,
        roles: ["administrador"],
        isActive: true,
        createdAt: BASE,
        updatedAt: BASE,
      });
    });
    /* Rondas en Alamos (de Jason) y en Bosque (de Bruno). */
    const rondasDe = async (condominioId: Id<"condominios">, guardiaUserId: Id<"users">, n: number) =>
      e.t.run(async (ctx) => {
        const turnoId = await ctx.db.insert("guardiaTurnos", {
          condominioId,
          guardiaUserId,
          guardiaNombre: "Guarda",
          checklist: [],
          estado: "cerrado",
          fechaInicio: BASE,
          createdAt: BASE,
          updatedAt: BASE,
        });
        for (let i = 0; i < n; i++) {
          await ctx.db.insert("guardiaRondas", {
            condominioId,
            turnoId,
            zona: "Perímetro",
            fotos: [],
            numero: i + 1,
            guardiaUserId,
            guardiaNombre: "Guarda",
            estado: "finalizada",
            fechaInicio: BASE + i * HORA,
            fechaCierre: BASE + i * HORA + 30 * MIN,
            createdAt: BASE + i * HORA,
          });
        }
      });
    await rondasDe(e.alamos, e.jason, 7);
    await rondasDe(e.bosque, e.bruno, 4);

    const personas = ["super", "adminAlamos", "alicia", "sofia", "sergio", "jason", "bruno"];
    const resultado = async <R>(p: Promise<R>) => {
      try {
        return { ok: true as const, valor: await p };
      } catch {
        return { ok: false as const };
      }
    };

    const permitidos: string[] = [];
    for (const quien of personas) {
      for (const [nombre, condominioId] of [["alamos", e.alamos], ["bosque", e.bosque], ["cedros", e.cedros]] as const) {
        const antes = await resultado(e.como(quien).query(api.rondas.listar, { condominioId, limite: 200 }));
        const ahora = await resultado(
          e.como(quien).query(api.rondas.listarPagina, { condominioId, paginationOpts: { numItems: 200, cursor: null } }),
        );
        expect(ahora.ok, `${quien} en ${nombre}`).toBe(antes.ok);
        if (antes.ok && ahora.ok) {
          expect(ahora.valor.page, `${quien} en ${nombre}`).toEqual(antes.valor);
          permitidos.push(`${quien}:${nombre}`);
        }
      }
    }

    // Lo que importa, dicho explícitamente.
    expect(permitidos).toContain("super:alamos");
    expect(permitidos).toContain("adminAlamos:alamos");
    expect(permitidos).toContain("sofia:alamos");
    expect(permitidos).toContain("jason:alamos");
    expect(permitidos).not.toContain("adminAlamos:bosque");
    expect(permitidos).not.toContain("sofia:bosque");
    expect(permitidos).not.toContain("bruno:alamos");
    // Sin sesión, nada.
    await expect(
      e.t.query(api.rondas.listarPagina, { condominioId: e.alamos, paginationOpts: { numItems: 20, cursor: null } }),
    ).rejects.toThrow();
  });

  test("el filtro por guarda no saca rondas de otro conjunto", async () => {
    const e = await montar();
    /* Bruno tiene rondas en Bosque. Pedirlas "de Bruno" en Alamos no da nada. */
    await e.t.run(async (ctx) => {
      const turnoId = await ctx.db.insert("guardiaTurnos", {
        condominioId: e.bosque,
        guardiaUserId: e.bruno,
        guardiaNombre: "Bruno Bosque",
        checklist: [],
        estado: "cerrado",
        fechaInicio: BASE,
        createdAt: BASE,
        updatedAt: BASE,
      });
      for (let i = 0; i < 3; i++) {
        await ctx.db.insert("guardiaRondas", {
          condominioId: e.bosque,
          turnoId,
          zona: "Bosque",
          fotos: [],
          guardiaUserId: e.bruno,
          guardiaNombre: "Bruno Bosque",
          createdAt: BASE + i * HORA,
        });
      }
    });
    const r = await e.como("super").query(api.rondas.listarPagina, {
      condominioId: e.alamos,
      guardiaUserId: e.bruno,
      paginationOpts: { numItems: 20, cursor: null },
    });
    expect(r.page).toEqual([]);
    const enBosque = await e.como("super").query(api.rondas.listarPagina, {
      condominioId: e.bosque,
      guardiaUserId: e.bruno,
      paginationOpts: { numItems: 20, cursor: null },
    });
    expect(enBosque.page).toHaveLength(3);
  });
});

// ─────────────────────────────────────────────────────────────
// D. Coste de lectura por página
// ─────────────────────────────────────────────────────────────

describe("D. Coste de lectura por página", () => {
  test(
    "cada página lee sus rondas y lo que cuelga de ellas: ni el resto del historial ni los sueltos",
    async () => {
      const escenarios = {
        "60 rondas, 820 sueltos": { porGuarda: [30, 30], sueltosMinuta: 600, sueltosNovedades: 220 },
        "60 rondas, 8.200 sueltos": { porGuarda: [30, 30], sueltosMinuta: 6000, sueltosNovedades: 2200 },
        "600 rondas, 820 sueltos": { porGuarda: [300, 300], sueltosMinuta: 600, sueltosNovedades: 220 },
      };
      const medido: Record<string, { pagina: number; docs: number; kib: number; esperado: number }[]> = {};

      for (const [nombre, o] of Object.entries(escenarios)) {
        const t = convexTest(schema, modules);
        const e = await conjuntoConHistorial(t, o);
        medido[nombre] = [];
        let cursor: string | null = null;
        for (let p = 1; p <= 3; p++) {
          const m = await medirPagina(t, "super", {
            condominioId: e.condominioId,
            paginationOpts: { numItems: 20, cursor },
          });
          const esperado = m.ids.length + (await documentosLigados(t, e.condominioId, m.ids));
          medido[nombre].push({ pagina: p, docs: m.docs, kib: Math.round(m.bytes / 102.4) / 10, esperado });
          // Rondas de la página + sus hitos + autorización. Nada del resto.
          expect(m.docs - esperado, `${nombre}, página ${p}`).toBeGreaterThanOrEqual(0);
          expect(m.docs - esperado, `${nombre}, página ${p}`).toBeLessThanOrEqual(5);
          const siguiente = await como(t, "super").query(api.rondas.listarPagina, {
            condominioId: e.condominioId,
            paginationOpts: { numItems: 20, cursor },
          });
          cursor = siguiente.continueCursor;
        }
      }

      console.info(
        "[rondas] lecturas por página de 20 (convex-test):\n" +
          Object.entries(medido)
            .map(([n, ps]) => `  ${n}: ` + ps.map((p) => `p${p.pagina} ${p.docs} docs / ${p.kib} KiB (rondas+ligados ${p.esperado})`).join(" · "))
            .join("\n"),
      );

      // Diez veces más sueltos: exactamente lo mismo, página por página.
      expect(medido["60 rondas, 8.200 sueltos"]).toEqual(medido["60 rondas, 820 sueltos"]);
      // Diez veces más rondas: cada página sigue costando lo de sus 20.
      for (const p of medido["600 rondas, 820 sueltos"]) {
        expect(p.docs).toBeLessThan(150);
        expect(p.kib).toBeLessThan(100);
      }
    },
    300_000,
  );

  test(
    "con los límites reales de Convex: todo el historial de 600 rondas se recorre",
    async () => {
      const t = convexTest({ schema, modules, transactionLimits: true });
      const e = await conjuntoConHistorial(t, { porGuarda: [300, 300], antiguaCada: 25, sueltosMinuta: 6000, sueltosNovedades: 2200 });
      const { items } = await recorrer(t, "super", { condominioId: e.condominioId }, 20);
      expect(items).toHaveLength(e.rondas.length);
      expect(sinRepetidos(items.map((r) => r._id))).toBe(true);
      // Y con el máximo de página permitido.
      const grande = await recorrer(t, "super", { condominioId: e.condominioId }, 200);
      expect(grande.items).toEqual(items);
    },
    300_000,
  );
});
