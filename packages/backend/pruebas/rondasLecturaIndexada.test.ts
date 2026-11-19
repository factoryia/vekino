import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../convex/_generated/server";
import { detalle, listar } from "../convex/rondas";
import { exigirAcceso, resolverAcceso } from "../convex/model/acceso";
import { lectorDeCoberturasHistoricas } from "../convex/model/cobertura";
import {
  contar,
  duracionMs,
  duracionTexto,
  estadoDeRonda,
  ordenarLineaDeTiempo,
  type Hito,
} from "../convex/lib/ronda";

const modules = import.meta.glob("../convex/**/*.ts");

/**
 * LOS HITOS DE UNA RONDA SE LEEN POR SU ÍNDICE, NO POR EL DEL CONJUNTO.
 *
 * `hitosDeRonda` recorría la minuta y las novedades ENTERAS del conjunto y
 * filtraba en memoria por `rondaId`; `listar` la llamaba por cada una de sus
 * 50 rondas. En Ciudad del Campo II (59 rondas, 597 documentos de minuta y
 * novedades) eso eran 16,73 MiB por ejecución y Convex cortaba en 16 MiB.
 *
 * Ahora lee por `by_condominio_ronda`. Estas pruebas comprueban tres cosas:
 *
 *   A. Que la respuesta es la MISMA. El oráculo es el código anterior,
 *      copiado tal cual de `630c4ed` más abajo: `listar` y `detalle` se
 *      comparan objeto por objeto contra él, línea de tiempo y empates
 *      incluidos.
 *   B. Que no sale del conjunto: el índice lleva el conjunto delante.
 *   C. Que lo leído depende de las rondas listadas y sus hitos, no del
 *      historial. Se mide con la contabilidad de `convex-test` (la misma
 *      `getDocumentSize` de Convex, documento a documento), leída con
 *      `ctx.meta.getTransactionMetrics()`, y se comprueba contra los
 *      límites reales con `transactionLimits: true`.
 */

// ─────────────────────────────────────────────────────────────
// El código anterior (630c4ed), copiado como oráculo. NO TOCAR: es la
// referencia de comportamiento, no código vivo.
// ─────────────────────────────────────────────────────────────

async function hitosDeRondaAnterior(
  ctx: QueryCtx,
  ronda: Doc<"guardiaRondas">,
): Promise<Hito[]> {
  const hitos: Hito[] = [
    {
      en: ronda.fechaInicio ?? ronda.createdAt,
      tipo: "inicio",
      titulo: `Inicio de ronda${ronda.zona ? ` · ${ronda.zona}` : ""}`,
      quien: ronda.guardiaNombre ?? null,
    },
  ];

  const novedades = await ctx.db
    .query("guardiaNovedadReportes")
    .withIndex("by_condominio", (q) => q.eq("condominioId", ronda.condominioId))
    .collect();
  for (const n of novedades) {
    if (n.rondaId !== ronda._id) continue;
    hitos.push({
      en: n.ocurrioEn ?? n.createdAt,
      tipo: n.vehiculoPlaca ? "vehiculo" : "novedad",
      titulo: n.titulo,
      detalle: n.descripcion,
      fotos: n.fotos?.length ?? 0,
    });
  }

  const eventos = await ctx.db
    .query("minutaEventos")
    .withIndex("by_condominio", (q) => q.eq("condominioId", ronda.condominioId))
    .collect();
  for (const e of eventos) {
    if (e.rondaId !== ronda._id) continue;
    if (e.tipo === "Inicio de ronda" || e.tipo === "Fin de ronda") continue;
    hitos.push({
      en: e.createdAt,
      tipo: "evento",
      titulo: `${e.tipo}${e.unidad ? ` · ${e.unidad}` : ""}`,
      detalle: e.resumen,
      quien: e.actorNombre,
    });
  }

  if (ronda.fechaCierre) {
    hitos.push({
      en: ronda.fechaCierre,
      tipo: "cierre",
      titulo: "Finalización de ronda",
      detalle: ronda.observacionesCierre ?? null,
      quien: ronda.guardiaNombre ?? null,
    });
  }

  return ordenarLineaDeTiempo(hitos);
}

async function detalleAnterior(ctx: QueryCtx, args: { rondaId: Id<"guardiaRondas"> }) {
  const ronda = await ctx.db.get(args.rondaId);
  if (!ronda) return null;
  const acceso = await resolverAcceso(ctx, ronda.condominioId);
  if (!acceso || !acceso.capacidades.has("porteria.ver")) return null;

  const hitos = await hitosDeRondaAnterior(ctx, ronda);
  const inicio = ronda.fechaInicio ?? ronda.createdAt;
  return {
    _id: ronda._id,
    numero: ronda.numero ?? null,
    zona: ronda.zona,
    guardiaNombre: ronda.guardiaNombre ?? null,
    ...(await lectorDeCoberturasHistoricas(ctx)(ronda)),
    estado: estadoDeRonda(ronda.estado),
    fechaInicio: inicio,
    fechaCierre: ronda.fechaCierre ?? null,
    duracion: duracionTexto(inicio, ronda.fechaCierre),
    duracionMs: duracionMs(inicio, ronda.fechaCierre),
    observacionesCierre: ronda.observacionesCierre ?? null,
    totales: contar(hitos),
    lineaDeTiempo: hitos,
  };
}

async function listarAnterior(
  ctx: QueryCtx,
  args: { condominioId: Id<"condominios">; limite?: number; guardiaUserId?: Id<"users"> },
) {
  await exigirAcceso(ctx, args.condominioId, "porteria.ver");
  const limite = Math.min(args.limite ?? 50, 200);

  let rondas: Doc<"guardiaRondas">[];
  if (args.guardiaUserId) {
    rondas = [];
    const guardiaUserId = args.guardiaUserId;
    for await (const r of ctx.db
      .query("guardiaRondas")
      .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
      .order("desc")) {
      if (r.guardiaUserId !== guardiaUserId) continue;
      rondas.push(r);
      if (rondas.length >= limite) break;
    }
  } else {
    rondas = await ctx.db
      .query("guardiaRondas")
      .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
      .order("desc")
      .take(limite);
  }

  const salida = [];
  const contexto = lectorDeCoberturasHistoricas(ctx);
  for (const r of rondas) {
    const hitos = await hitosDeRondaAnterior(ctx, r);
    const inicio = r.fechaInicio ?? r.createdAt;
    salida.push({
      _id: r._id,
      numero: r.numero ?? null,
      zona: r.zona,
      guardiaNombre: r.guardiaNombre ?? null,
      ...(await contexto(r)),
      estado: estadoDeRonda(r.estado),
      fechaInicio: inicio,
      fechaCierre: r.fechaCierre ?? null,
      duracion: duracionTexto(inicio, r.fechaCierre),
      totales: contar(hitos),
    });
  }
  return salida;
}

// ─────────────────────────────────────────────────────────────
// Escenario
// ─────────────────────────────────────────────────────────────

type T = ReturnType<typeof convexTest>;
const como = (t: T, subject: string) => t.withIdentity({ subject });

const MIN = 60_000;
const HORA = 60 * MIN;
const BASE = Date.parse("2026-09-17T06:00:00-05:00");
/* Texto de relleno para que los documentos pesen como los de producción
 * (~600 B; en CDC el promedio es 587 B). Con documentos pequeños el código
 * anterior rompería por número de documentos y no por bytes, que no es lo
 * que pasó en producción. */
const RELLENO = "Registro de portería con detalle operativo del puesto. ".repeat(7);
/** Cada décima ronda (8, 18, 28…) es del registro antiguo. */
const esAntigua = (i: number) => i % 10 === 8;
/* Lo mismo que hace la portería con Convex: el handler real, sin la envoltura. */
const handlerDe = (f: unknown) =>
  (f as { _handler: (ctx: QueryCtx, args: never) => Promise<unknown> })._handler;

type Totales = { novedades: number; vehiculos: number; eventos: number };

type Opciones = {
  rondas: number;
  sueltosMinuta: number;
  sueltosNovedades: number;
  /** Otro conjunto con su propia portería, para el aislamiento. */
  conSur?: boolean;
};

/**
 * Siembra un conjunto ("Norte") con rondas, hitos ligados y un historial de
 * minuta y novedades SIN ronda. Todo se inserta en orden cronológico,
 * intercalado, como lo escribiría la portería, para que el orden de creación
 * —el que resuelve los empates de la línea de tiempo— sea el real.
 *
 * Los hitos ligados siguen un patrón fijo por ronda (ver `planDe`) y se
 * devuelven contados aparte (`esperado`), como segundo oráculo, independiente
 * del código anterior.
 */
async function sembrar(t: T, o: Opciones) {
  const base = await t.run(async (ctx) => {
    const ahora = BASE;
    const conjunto = (name: string) =>
      ctx.db.insert("condominios", {
        name,
        activeModules: [],
        isActive: true,
        createdAt: ahora,
        updatedAt: ahora,
      });
    const persona = async (
      name: string,
      authId: string,
      membresia?: { condominioId: Id<"condominios">; roles: string[] },
      extra: Partial<Doc<"users">> = {},
    ) => {
      const userId = await ctx.db.insert("users", {
        name,
        email: `${authId}@vekino.test`,
        emailVerified: true,
        active: true,
        authId,
        createdAt: ahora,
        updatedAt: ahora,
        ...extra,
      });
      if (membresia) {
        await ctx.db.insert("memberships", {
          userId,
          condominioId: membresia.condominioId,
          roles: membresia.roles as never,
          isActive: true,
          createdAt: ahora,
          updatedAt: ahora,
        });
      }
      return userId;
    };
    const turno = (condominioId: Id<"condominios">, guardiaUserId: Id<"users">, guardiaNombre: string) =>
      ctx.db.insert("guardiaTurnos", {
        condominioId,
        guardiaUserId,
        guardiaNombre,
        checklist: [],
        estado: "cerrado",
        fechaInicio: ahora,
        fechaCierre: ahora + 1000 * HORA,
        createdAt: ahora,
        updatedAt: ahora,
      });

    const norte = await conjunto("Conjunto Norte");
    const sur = await conjunto("Conjunto Sur");
    await persona("Super", "super", undefined, { platformRole: "superadmin" });
    await persona("Ana Admin Norte", "adminNorte", { condominioId: norte, roles: ["administrador"] });
    await persona("Sara Admin Sur", "adminSur", { condominioId: sur, roles: ["administrador"] });
    const guardia = await persona("Gabriel Guarda", "guardiaNorte", { condominioId: norte, roles: ["guardia"] });
    const guardia2 = await persona("Gloria Guarda", "guardia2Norte", { condominioId: norte, roles: ["guardia"] });
    const guardiaSur = await persona("Samuel Guarda", "guardiaSur", { condominioId: sur, roles: ["guardia"] });
    return {
      norte,
      sur,
      guardia,
      guardia2,
      guardiaSur,
      turnoNorte: await turno(norte, guardia, "Gabriel Guarda"),
      turnoSur: await turno(sur, guardiaSur, "Samuel Guarda"),
    };
  });

  /* Las rondas primero: los hitos necesitan sus ids. Cada décima es del
   * registro antiguo (sin número, estado, inicio ni guarda), que se lee como
   * finalizada; un tercio de las nuevas es de la segunda guarda. */
  const rondas = await t.run(async (ctx) => {
    const ids: Id<"guardiaRondas">[] = [];
    for (let i = 0; i < o.rondas; i++) {
      const inicio = BASE + i * HORA;
      const antigua = esAntigua(i);
      const deGloria = i % 3 === 2;
      ids.push(
        await ctx.db.insert("guardiaRondas", {
          condominioId: base.norte,
          turnoId: base.turnoNorte,
          zona: i % 2 ? "Perímetro" : "Parqueadero",
          fotos: [],
          createdAt: inicio,
          ...(antigua
            ? { novedad: "Ronda del registro antiguo." }
            : {
                numero: i + 1,
                guardiaUserId: deGloria ? base.guardia2 : base.guardia,
                guardiaNombre: deGloria ? "Gloria Guarda" : "Gabriel Guarda",
                fechaInicio: inicio,
                ...(i === o.rondas - 1
                  ? { estado: "en_curso" as const }
                  : {
                      estado: "finalizada" as const,
                      fechaCierre: inicio + 40 * MIN,
                      ...(i % 4 ? {} : { observacionesCierre: "Sin novedad." }),
                    }),
              }),
        }),
      );
    }
    return ids;
  });

  type Pendiente = { en: number; orden: number; insertar: (ctx: MutationCtx) => Promise<unknown> };
  const pendientes: Pendiente[] = [];
  let orden = 0;
  const evento = (
    condominioId: Id<"condominios">,
    en: number,
    tipo: string,
    rondaId?: Id<"guardiaRondas">,
    extra: Partial<Doc<"minutaEventos">> = {},
  ) => {
    /* Fijado al pedirlo, no al insertar: así un documento ligado es idéntico,
     * byte a byte, en todos los escenarios, y la medición los puede comparar. */
    const n = orden++;
    pendientes.push({
      en,
      orden: n,
      insertar: (ctx) =>
        ctx.db.insert("minutaEventos", {
          condominioId,
          ...(rondaId ? { rondaId } : {}),
          modulo: "visitantes",
          tipo,
          unidad: `Casa ${(n % 120) + 1}`,
          resumen: `${tipo}. ${RELLENO}`,
          estado: "cerrado",
          actorNombre: "Gabriel Guarda",
          createdAt: en,
          ...extra,
        }),
    });
  };
  const novedad = (
    condominioId: Id<"condominios">,
    en: number,
    titulo: string,
    rondaId?: Id<"guardiaRondas">,
    extra: Partial<Doc<"guardiaNovedadReportes">> = {},
  ) =>
    pendientes.push({
      en,
      orden: orden++,
      insertar: (ctx) =>
        ctx.db.insert("guardiaNovedadReportes", {
          condominioId,
          ...(rondaId ? { rondaId } : {}),
          titulo,
          descripcion: `${titulo}. ${RELLENO}`,
          prioridad: "media",
          reportadoPorUserId: base.guardia,
          reportadoPorNombre: "Gabriel Guarda",
          createdAt: en,
          ...extra,
        }),
    });

  /* Los hitos ligados. Patrón por ronda:
   *   - cada quinta ronda, ninguno;
   *   - la ronda 3, muchos (40 eventos, 10 novedades, 5 vehículos);
   *   - el resto, `i % 7` eventos, `i % 3` novedades e `i % 2` vehículos.
   * Las nuevas llevan su "Inicio de ronda" en la minuta (como `iniciar`), que
   * la línea de tiempo NO repite; cada séptima lleva además un "Fin de ronda"
   * ligado, que tampoco se repite. */
  const esperado = new Map<Id<"guardiaRondas">, Totales>();
  const planDe = (i: number) =>
    i % 5 === 0
      ? { eventos: 0, novedades: 0, vehiculos: 0 }
      : i === 3
        ? { eventos: 40, novedades: 10, vehiculos: 5 }
        : { eventos: i % 7, novedades: i % 3, vehiculos: i % 2 };
  rondas.forEach((rondaId, i) => {
    const inicio = BASE + i * HORA;
    const p = planDe(i);
    esperado.set(rondaId, { eventos: p.eventos, novedades: p.novedades, vehiculos: p.vehiculos });
    if (!esAntigua(i)) evento(base.norte, inicio, "Inicio de ronda", rondaId, { modulo: "minuta" });
    for (let k = 0; k < p.eventos; k++) {
      evento(base.norte, inicio + (k + 1) * 30_000, k % 2 ? "Ingreso" : "Registro", rondaId);
    }
    for (let k = 0; k < p.novedades; k++) {
      novedad(base.norte, inicio + (k + 1) * 45_000, `Novedad ${i}.${k}`, rondaId, {
        ...(k % 2 ? { ocurrioEn: inicio + 5 * MIN } : {}),
        ...(k === 0 ? { fotos: [{ url: "https://ejemplo.invalid/foto.jpg" }] } : {}),
      });
    }
    for (let k = 0; k < p.vehiculos; k++) {
      novedad(base.norte, inicio + (k + 1) * 50_000, `Vehículo ${i}.${k}`, rondaId, {
        vehiculoPlaca: `ABC${100 + k}`,
      });
    }
    if (i % 7 === 6) evento(base.norte, inicio + 39 * MIN, "Fin de ronda", rondaId, { modulo: "minuta" });
  });

  /* Empates a propósito en la ronda 1: un evento en el mismo milisegundo que
   * la apertura (va DESPUÉS del inicio) y un evento y una novedad en el mismo
   * instante, con el evento creado ANTES. El código anterior ponía la novedad
   * primero porque recorría las novedades antes que la minuta; el nuevo tiene
   * que hacer lo mismo. */
  if (rondas.length > 1) {
    const r1 = rondas[1];
    const inicio = BASE + HORA;
    evento(base.norte, inicio, "Empate con la apertura", r1);
    evento(base.norte, inicio + 20 * MIN, "Empate evento", r1);
    novedad(base.norte, inicio + 20 * MIN, "Empate novedad", r1);
    const e = esperado.get(r1)!;
    esperado.set(r1, { ...e, eventos: e.eventos + 2, novedades: e.novedades + 1 });
  }

  /* El historial sin ronda: repartido por todo el periodo, intercalado con
   * lo anterior. */
  const periodo = Math.max(o.rondas, 1) * HORA;
  for (let j = 0; j < o.sueltosMinuta; j++) {
    evento(base.norte, BASE + Math.floor((j * periodo) / Math.max(o.sueltosMinuta, 1)) + 7_000, "Ingreso");
  }
  for (let j = 0; j < o.sueltosNovedades; j++) {
    novedad(base.norte, BASE + Math.floor((j * periodo) / Math.max(o.sueltosNovedades, 1)) + 11_000, "Novedad suelta");
  }

  /* El otro conjunto: su propia ronda con hitos, y un documento anómalo que
   * lleva el `rondaId` de una ronda de Norte. No pasa en la operación
   * (`operacionDe` busca la ronda en el mismo conjunto), pero si pasara, Norte
   * no lo debe ver nunca: es lo que garantiza el índice con el conjunto
   * delante. */
  let rondaSur: Id<"guardiaRondas"> | null = null;
  if (o.conSur) {
    rondaSur = await t.run((ctx) =>
      ctx.db.insert("guardiaRondas", {
        condominioId: base.sur,
        turnoId: base.turnoSur,
        zona: "Portería Sur",
        fotos: [],
        numero: 1,
        guardiaUserId: base.guardiaSur,
        guardiaNombre: "Samuel Guarda",
        estado: "finalizada",
        fechaInicio: BASE,
        fechaCierre: BASE + 30 * MIN,
        createdAt: BASE,
      }),
    );
    for (let k = 0; k < 6; k++) evento(base.sur, BASE + (k + 1) * MIN, "SUR evento", rondaSur);
    for (let k = 0; k < 3; k++) novedad(base.sur, BASE + (k + 1) * MIN, "SUR novedad", rondaSur);
    for (let k = 0; k < 50; k++) evento(base.sur, BASE + k * HORA, "SUR suelto");
    if (rondas.length > 2) {
      evento(base.sur, BASE + 2 * HORA + MIN, "SUR anómalo", rondas[2]);
      novedad(base.sur, BASE + 2 * HORA + MIN, "SUR anómala", rondas[2]);
    }
  }

  /* En orden cronológico (y, a igual instante, en el orden en que se
   * pidieron), por tandas para no pasar del límite de escritura por
   * transacción cuando las pruebas lo aplican. */
  pendientes.sort((a, b) => a.en - b.en || a.orden - b.orden);
  for (let i = 0; i < pendientes.length; i += 1000) {
    const tanda = pendientes.slice(i, i + 1000);
    await t.run(async (ctx) => {
      for (const p of tanda) await p.insertar(ctx);
    });
  }

  return { ...base, rondas, esperado, rondaSur };
}

type Metricas = { bytes: number; docs: number; rangos: number };

/** Lo que lee `f` dentro de una transacción, según `convex-test`. */
async function medir(t: T, subject: string, f: (ctx: QueryCtx) => Promise<unknown>): Promise<Metricas> {
  return await como(t, subject).run(async (ctx) => {
    await f(ctx);
    const m = await ctx.meta.getTransactionMetrics();
    return { bytes: m.bytesRead.used, docs: m.documentsRead.used, rangos: m.databaseQueries.used };
  });
}

const kib = (b: number) => Math.round((b / 1024) * 10) / 10;

// ─────────────────────────────────────────────────────────────
// A. Equivalencia funcional
// ─────────────────────────────────────────────────────────────

describe("A. Misma respuesta que el código anterior", () => {
  test("listar y detalle devuelven exactamente lo mismo, ronda por ronda", async () => {
    const t = convexTest(schema, modules);
    const e = await sembrar(t, { rondas: 60, sueltosMinuta: 600, sueltosNovedades: 220, conSur: true });
    const sup = como(t, "super");

    /* El escenario no es trivial: hay rondas vacías, una muy cargada,
     * del registro antiguo y una en curso. */
    const totales = [...e.esperado.values()];
    expect(totales.filter((x) => x.eventos + x.novedades + x.vehiculos === 0).length).toBeGreaterThanOrEqual(12);
    expect(Math.max(...totales.map((x) => x.eventos))).toBe(40);
    expect(totales.reduce((a, x) => a + x.eventos + x.novedades + x.vehiculos, 0)).toBeGreaterThan(200);

    // listar: todas las rondas (límite 200) y el límite por defecto (50).
    for (const args of [
      { condominioId: e.norte, limite: 200 },
      { condominioId: e.norte },
      { condominioId: e.norte, limite: 7 },
    ]) {
      const nuevo = await sup.query(api.rondas.listar, args);
      const anterior = await sup.run((ctx) => listarAnterior(ctx, args));
      expect(nuevo).toEqual(anterior);
    }

    // listar con el filtro por guarda (supervisor mirando a una persona).
    for (const guardiaUserId of [e.guardia, e.guardia2]) {
      const args = { condominioId: e.norte, guardiaUserId, limite: 200 };
      const nuevo = await sup.query(api.rondas.listar, args);
      expect(nuevo.length).toBeGreaterThan(0);
      expect(nuevo).toEqual(await sup.run((ctx) => listarAnterior(ctx, args)));
    }

    // detalle: la línea de tiempo completa, en el mismo orden, de cada ronda.
    for (const rondaId of e.rondas) {
      const nuevo = await sup.query(api.rondas.detalle, { rondaId });
      const anterior = await sup.run((ctx) => detalleAnterior(ctx, { rondaId }));
      expect(nuevo).not.toBeNull();
      expect(nuevo).toEqual(anterior);
    }
  });

  test("los contadores coinciden con lo sembrado, sin hitos de otras rondas", async () => {
    const t = convexTest(schema, modules);
    const e = await sembrar(t, { rondas: 60, sueltosMinuta: 600, sueltosNovedades: 220, conSur: true });
    const lista = await como(t, "super").query(api.rondas.listar, { condominioId: e.norte, limite: 200 });

    expect(lista).toHaveLength(60);
    // Seis del registro antiguo (sin número) y la más nueva, en curso.
    expect(lista.filter((r) => r.numero === null)).toHaveLength(6);
    expect(lista.filter((r) => r.estado === "en_curso").map((r) => r._id)).toEqual([e.rondas[59]]);
    for (const r of lista) {
      expect(r.totales, `ronda ${r._id}`).toEqual(e.esperado.get(r._id));
    }
  });

  test("los empates de la línea de tiempo se resuelven como antes", async () => {
    const t = convexTest(schema, modules);
    const e = await sembrar(t, { rondas: 3, sueltosMinuta: 20, sueltosNovedades: 10 });
    const d = await como(t, "super").query(api.rondas.detalle, { rondaId: e.rondas[1] });
    const titulos = d!.lineaDeTiempo.map((h) => h.titulo);

    // El inicio primero aunque un evento comparta su milisegundo.
    expect(titulos[0]).toBe("Inicio de ronda · Perímetro");
    expect(titulos[1]).toMatch(/^Empate con la apertura/);
    // Mismo instante: la novedad antes que el evento, aunque se creó después.
    const iNovedad = titulos.indexOf("Empate novedad");
    expect(iNovedad).toBeGreaterThan(0);
    expect(titulos[iNovedad + 1]).toMatch(/^Empate evento/);
    // Ni "Inicio de ronda" ni "Fin de ronda" de la minuta se repiten.
    expect(titulos.filter((x) => x.startsWith("Inicio de ronda"))).toHaveLength(1);
    expect(titulos.at(-1)).toBe("Finalización de ronda");
  });
});

// ─────────────────────────────────────────────────────────────
// B. Aislamiento entre conjuntos
// ─────────────────────────────────────────────────────────────

describe("B. Aislamiento entre conjuntos", () => {
  test("ni listar ni detalle traen hitos de otro conjunto", async () => {
    const t = convexTest(schema, modules);
    const e = await sembrar(t, { rondas: 12, sueltosMinuta: 60, sueltosNovedades: 20, conSur: true });
    const sup = como(t, "super");

    // La ronda 2 de Norte tiene un evento y una novedad "anómalos" de Sur
    // con su rondaId: no salen.
    const d2 = await sup.query(api.rondas.detalle, { rondaId: e.rondas[2] });
    expect(d2!.lineaDeTiempo.some((h) => h.titulo.startsWith("SUR"))).toBe(false);
    expect(d2!.totales).toEqual(e.esperado.get(e.rondas[2]));

    const lista = await sup.query(api.rondas.listar, { condominioId: e.norte, limite: 200 });
    expect(new Set(lista.map((r) => r._id))).toEqual(new Set(e.rondas));
    for (const r of lista) expect(r.totales).toEqual(e.esperado.get(r._id));

    // Y la de Sur solo ve lo suyo: 6 eventos y 3 novedades.
    const dSur = await sup.query(api.rondas.detalle, { rondaId: e.rondaSur! });
    expect(dSur!.totales).toEqual({ novedades: 3, vehiculos: 0, eventos: 6 });
    expect(dSur!.lineaDeTiempo.every((h) => h.tipo === "inicio" || h.tipo === "cierre" || h.titulo.startsWith("SUR"))).toBe(true);
  });

  test("el índice filtra por conjunto aunque el rondaId sea de otro", async () => {
    const t = convexTest(schema, modules);
    const e = await sembrar(t, { rondas: 4, sueltosMinuta: 10, sueltosNovedades: 5, conSur: true });
    const leidos = await t.run(async (ctx) => {
      const porIndice = (condominioId: Id<"condominios">) =>
        Promise.all([
          ctx.db
            .query("minutaEventos")
            .withIndex("by_condominio_ronda", (q) => q.eq("condominioId", condominioId).eq("rondaId", e.rondas[2]))
            .collect(),
          ctx.db
            .query("guardiaNovedadReportes")
            .withIndex("by_condominio_ronda", (q) => q.eq("condominioId", condominioId).eq("rondaId", e.rondas[2]))
            .collect(),
        ]);
      const [mNorte, nNorte] = await porIndice(e.norte);
      const [mSur, nSur] = await porIndice(e.sur);
      return {
        norte: [...mNorte, ...nNorte].map((d) => d.condominioId),
        sur: [...mSur, ...nSur].map((d) => ("titulo" in d ? d.titulo : d.tipo)),
      };
    });
    expect(leidos.norte.length).toBeGreaterThan(0);
    expect(leidos.norte.every((c) => c === e.norte)).toBe(true);
    expect(leidos.sur.sort()).toEqual(["SUR anómala", "SUR anómalo"]);
  });

  test("las autorizaciones no cambian", async () => {
    const t = convexTest(schema, modules);
    const e = await sembrar(t, { rondas: 4, sueltosMinuta: 10, sueltosNovedades: 5, conSur: true });

    // Quien opera o administra Norte, lo lee.
    for (const quien of ["adminNorte", "guardiaNorte", "super"]) {
      const lista = await como(t, quien).query(api.rondas.listar, { condominioId: e.norte });
      expect(lista).toHaveLength(4);
    }
    // La administración de Sur no lee Norte: ni la lista ni el detalle.
    await expect(como(t, "adminSur").query(api.rondas.listar, { condominioId: e.norte })).rejects.toThrow();
    expect(await como(t, "adminSur").query(api.rondas.detalle, { rondaId: e.rondas[1] })).toBeNull();
    // Y la de Norte no lee el detalle de Sur.
    expect(await como(t, "adminNorte").query(api.rondas.detalle, { rondaId: e.rondaSur! })).toBeNull();
    // Sin identidad, nada.
    await expect(t.query(api.rondas.listar, { condominioId: e.norte })).rejects.toThrow();
    expect(await t.query(api.rondas.detalle, { rondaId: e.rondas[1] })).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// C. Lo leído no depende del historial del conjunto
// ─────────────────────────────────────────────────────────────

describe("C. Coste de lectura", () => {
  const ESCENARIOS = {
    "1 · pocas rondas": { rondas: 3, sueltosMinuta: 10, sueltosNovedades: 5 },
    "2 · 60 rondas e historial": { rondas: 60, sueltosMinuta: 600, sueltosNovedades: 220 },
    "3 · el mismo historial ×10": { rondas: 60, sueltosMinuta: 6000, sueltosNovedades: 2200 },
  } as const;

  test(
    "listar y detalle leen lo de sus rondas: el historial ×10 no cambia nada",
    async () => {
      const medido: Record<string, { antes: Metricas; ahora: Metricas; detalleAntes: Metricas; detalleAhora: Metricas; ligados: number }> = {};

      for (const [nombre, o] of Object.entries(ESCENARIOS)) {
        const t = convexTest(schema, modules);
        const e = await sembrar(t, o);
        const args = { condominioId: e.norte, limite: 50 };
        /* La ronda más cargada (la 3) o, si no hay tantas, la última. */
        const rondaId = e.rondas[Math.min(3, e.rondas.length - 1)];

        const ahora = await medir(t, "super", (ctx) => handlerDe(listar)(ctx, args as never));
        const antes = await medir(t, "super", (ctx) => listarAnterior(ctx, args));
        const detalleAhora = await medir(t, "super", (ctx) => handlerDe(detalle)(ctx, { rondaId } as never));
        const detalleAntes = await medir(t, "super", (ctx) => detalleAnterior(ctx, { rondaId }));

        /* Lo que de verdad cuelga de las 50 rondas listadas (las más nuevas):
         * sus hitos más los "Inicio/Fin de ronda" de la minuta, que se leen
         * aunque la línea de tiempo no los repita. */
        const ligados = await t.run(async (ctx) => {
          const listadas = await ctx.db
            .query("guardiaRondas")
            .withIndex("by_condominio", (q) => q.eq("condominioId", e.norte))
            .order("desc")
            .take(50);
          let n = 0;
          for (const r of listadas) {
            for (const tabla of ["minutaEventos", "guardiaNovedadReportes"] as const) {
              n += (
                await ctx.db
                  .query(tabla)
                  .withIndex("by_condominio_ronda", (q) => q.eq("condominioId", e.norte).eq("rondaId", r._id))
                  .collect()
              ).length;
            }
          }
          return n + listadas.length;
        });

        medido[nombre] = { antes, ahora, detalleAntes, detalleAhora, ligados };
      }

      console.info(
        "[rondas] lecturas medidas por convex-test (getDocumentSize):\n" +
          Object.entries(medido)
            .map(
              ([n, m]) =>
                `  ${n}: listar antes ${m.antes.docs} docs / ${kib(m.antes.bytes)} KiB / ${m.antes.rangos} rangos` +
                ` → ahora ${m.ahora.docs} docs / ${kib(m.ahora.bytes)} KiB / ${m.ahora.rangos} rangos` +
                ` (rondas + documentos ligados: ${m.ligados});` +
                ` detalle antes ${m.detalleAntes.docs} docs / ${kib(m.detalleAntes.bytes)} KiB → ahora ${m.detalleAhora.docs} docs / ${kib(m.detalleAhora.bytes)} KiB`,
            )
            .join("\n"),
      );

      const dos = medido["2 · 60 rondas e historial"];
      const tres = medido["3 · el mismo historial ×10"];

      // Diez veces más historial sin ronda: el código nuevo lee EXACTAMENTE lo mismo.
      expect(tres.ahora).toEqual(dos.ahora);
      expect(tres.detalleAhora).toEqual(dos.detalleAhora);
      /* El anterior leía cada documento suelto UNA VEZ POR RONDA listada: los
       * 7.380 que añade el escenario 3 eran 50 × 7.380 lecturas más. */
      expect(tres.antes.docs - dos.antes.docs).toBe(50 * (6000 - 600 + (2200 - 220)));

      for (const m of Object.values(medido)) {
        /* Lo leído es: las rondas listadas, lo que cuelga de ellas y unas
         * pocas lecturas fijas de autorización (usuario, membresía,
         * conjunto…). Nada más. */
        expect(m.ahora.docs).toBeGreaterThanOrEqual(m.ligados);
        expect(m.ahora.docs - m.ligados).toBeLessThanOrEqual(10);
        expect(m.ahora.docs).toBeLessThanOrEqual(m.antes.docs);
      }
      // Con el volumen de producción, de varios MiB a pocas decenas de KiB.
      expect(dos.antes.bytes).toBeGreaterThan(16 * 1024 * 1024);
      expect(dos.ahora.bytes).toBeLessThan(256 * 1024);
    },
    300_000,
  );

  test(
    "con los límites reales de Convex: el código anterior rompe y el nuevo no",
    async () => {
      /* `transactionLimits: true` aplica los límites de Convex (16 MiB y
       * 32.000 documentos leídos por ejecución) con la misma cuenta de bytes
       * por documento. Es el error de producción, reproducido. */
      const t = convexTest({ schema, modules, transactionLimits: true });
      const e = await sembrar(t, ESCENARIOS["3 · el mismo historial ×10"]);
      const sup = como(t, "super");
      const args = { condominioId: e.norte, limite: 50 };

      // Por la API pública, igual que la web.
      const lista = await sup.query(api.rondas.listar, args);
      expect(lista).toHaveLength(50);
      for (const rondaId of e.rondas) {
        expect(await sup.query(api.rondas.detalle, { rondaId })).not.toBeNull();
      }
      // El máximo que admite listar (200) tampoco se acerca al límite.
      expect(await sup.query(api.rondas.listar, { condominioId: e.norte, limite: 200 })).toHaveLength(60);

      await expect(sup.run((ctx) => listarAnterior(ctx, args))).rejects.toThrow(
        /Read too much data in a single function execution/,
      );
    },
    300_000,
  );
});
