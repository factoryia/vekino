import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../convex/_generated/api";
import type { FunctionArgs } from "convex/server";
import type { Doc } from "../convex/_generated/dataModel";
import { montar } from "./helpers/incidentes";
import { DIA, MAX_INCIDENTES_ANALITICA, periodoIncidentes, intervalosIncidentes } from "../convex/lib/incidenteMetricas";

const AHORA = Date.parse("2026-09-30T15:00:00-05:00");
let e: Awaited<ReturnType<typeof montar>>;
beforeEach(async () => { vi.setSystemTime(AHORA); e = await montar(); });
afterEach(() => vi.useRealTimers());
async function caso(patch: Partial<Omit<Doc<"incidentes">, "_id" | "_creationTime">> = {}) {
  return e.t.run((ctx) => ctx.db.insert("incidentes", {
    companiaId: e.companiaA, condominioId: e.conjunto, reportadoPorUserId: e.adminA,
    reportadoPorNombre: "Ana", tipo: "ACCESO", ubicacion: "Portería", descripcion: "Hecho",
    estado: "REPORTADO", prioridad: "MEDIA", reportadoEn: AHORA, ocurrioEn: AHORA - 100 * DIA,
    createdAt: AHORA, updatedAt: AHORA, ...patch,
  }));
}
function dashboard(actor = "adminA", args: Partial<FunctionArgs<typeof api.incidentes.dashboard>> = {}) {
  return e.como(actor).query(api.incidentes.dashboard, { periodo: "30dias", ...args });
}

describe("dashboard: alcance de la lectura existente", () => {
  test("otra compañía en el mismo conjunto no altera ningún indicador, categoría, evolución ni caso relevante", async () => {
    await caso({ prioridad: "ALTA" });
    const antes = await dashboard();
    await caso({ companiaId: e.companiaB, reportadoPorUserId: e.adminB, tipo: "SOLO_RIVAL", prioridad: "CRITICA", estado: "CERRADO", resueltoEn: AHORA + DIA });
    await caso({ companiaId: e.companiaB, reportadoPorUserId: e.adminB, prioridad: "CRITICA" });
    expect(await dashboard()).toEqual(antes);
    expect((await dashboard("adminB"))!.total).toBe(2);
  });
  test("admin conserva histórico; supervisor pierde alcance cuando termina contrato", async () => {
    await caso();
    await e.t.run((ctx) => ctx.db.patch(e.kA, { terminadoEn: AHORA - 1 }));
    expect((await dashboard())!.total).toBe(1);
    expect(await dashboard("supervisorA")).toBeNull();
    expect(await dashboard("guardaA")).toBeNull();
    await expect(dashboard("supervisorA", { condominioId: e.conjunto })).resolves.toBeNull();
  });
  test("supervisor ve solo asignaciones vigentes; selección fuera de alcance se rechaza", async () => {
    await caso(); await caso({ condominioId: e.ajeno });
    expect((await dashboard("supervisorA"))!.total).toBe(1);
    expect((await dashboard())!.total).toBe(2);
    await expect(dashboard("supervisorA", { condominioId: e.ajeno })).rejects.toThrow(/contrato|permiso/);
    const contexto = await e.como("supervisorA").query(api.incidentes.contextoBandeja, {});
    expect(contexto!.conjuntos.map((c) => c.condominioId)).toEqual([e.conjunto]);
  });
  test("guarda solo agrega sus reportes y jamás recibe casos ajenos", async () => {
    const propio = await caso({ reportadoPorUserId: e.guardaA });
    await caso({ prioridad: "CRITICA" }); await caso({ companiaId: e.companiaB, reportadoPorUserId: e.guardaA });
    const d = (await dashboard("guardaA"))!;
    expect(d.total).toBe(1); expect(d.prioridades.CRITICA).toBe(0);
    expect(d.relevantes.map((c) => c._id)).toEqual([propio]);
    const lista = await e.como("guardaA").query(api.incidentes.listar, { companiaId: e.companiaA, todosMisConjuntos: true, paginationOpts: e.paginar });
    expect(lista.page.map((c) => c._id)).toEqual([propio]);
    await expect(e.como("guardaA").query(api.incidentes.listar, { companiaId: e.companiaB, todosMisConjuntos: true, paginationOpts: e.paginar })).rejects.toThrow("compañía");
  });
  test("sin membresía no recibe métricas; una compañía inactiva se rechaza", async () => {
    expect(await dashboard("sinEmpresa")).toBeNull();
    await e.t.run((ctx) => ctx.db.patch(e.companiaA, { estado: "inactiva" }));
    await expect(dashboard()).rejects.toThrow(/activa/);
  });
  test("supervisor con varios conjuntos obtiene la unión autorizada y la misma bandeja contextual", async () => {
    await e.t.run(async (ctx) => {
      const contratoId = await ctx.db.insert("companiaContratos", { companiaId: e.companiaA, condominioId: e.ajeno, vigenciaDesde: AHORA - DIA, creadoPorUserId: e.adminA, createdAt: AHORA, updatedAt: AHORA });
      const miembro = await ctx.db.query("companiaMiembros").withIndex("by_user", (q) => q.eq("userId", e.supervisorA)).first();
      await ctx.db.insert("asignaciones", { contratoId, companiaMiembroId: miembro!._id, userId: e.supervisorA, companiaId: e.companiaA, condominioId: e.ajeno, rol: "supervisor", vigenciaDesde: AHORA - DIA, creadoPorUserId: e.adminA, createdAt: AHORA });
    });
    const a = await caso(); const b = await caso({ condominioId: e.ajeno });
    await caso({ companiaId: e.companiaB, condominioId: e.ajeno });
    const d = (await dashboard("supervisorA"))!;
    expect(d.total).toBe(2); expect(d.conjuntos.map((c) => c.cantidad)).toEqual([1, 1]);
    const lista = await e.como("supervisorA").query(api.incidentes.listar, { companiaId: e.companiaA, todosMisConjuntos: true, paginationOpts: e.paginar });
    expect(new Set(lista.page.map((c) => c._id))).toEqual(new Set([a, b]));
    const referencia = await e.como("supervisorA").query(api.incidentes.listar, { companiaId: e.companiaA, todosMisConjuntos: true, campoBusqueda: "referencia", busqueda: b, paginationOpts: e.paginar });
    expect(referencia.page[0]!._id).toBe(b);
  });
});
describe("periodos y límites civiles de Colombia", () => {
  test.each(["hoy", "7dias", "30dias", "mes", "mesAnterior", "personalizado"])("%s incluye ambos extremos y excluye el milisegundo exterior", async (periodo) => {
    const args = { periodo, desde: "2026-08-03", hasta: "2026-09-07" };
    const rango = periodoIncidentes(periodo, args.desde, args.hasta, AHORA);
    for (const reportadoEn of [rango.desde - 1, rango.desde, rango.hasta, rango.hasta + 1]) await caso({ reportadoEn });
    const d = (await dashboard("adminA", args))!;
    expect(d.total).toBe(2); expect(d.evolucion.puntos.reduce((s, p) => s + p.value, 0)).toBe(2);
    expect(d.periodo.desde).toBe(rango.desde); expect(d.periodo.hasta).toBe(rango.hasta);
  });
  test("solo fecha de reporte determina inclusión aunque el hecho haya ocurrido antes", async () => {
    await caso({ ocurrioEn: AHORA - 100 * DIA }); await caso({ reportadoEn: AHORA - 2 * DIA, ocurrioEn: AHORA });
    expect((await dashboard("adminA", { periodo: "hoy" }))!.total).toBe(1);
    expect(periodoIncidentes("hoy", undefined, undefined, Date.parse("2026-10-01T04:59:59Z")).desdeDia).toBe("2026-09-30");
  });
  test("periodo vacío devuelve ceros concluidos y serie con ceros", async () => {
    await caso({ reportadoEn: AHORA - 100 * DIA });
    const d = (await dashboard("adminA", { periodo: "hoy" }))!;
    expect(d.total).toBe(0); expect(d.activos).toBe(0); expect(d.relevantes).toEqual([]);
    expect(d.evolucion.puntos.map((p) => p.value)).toEqual([0]); expect(d.resolucion.promedioMs).toBeNull();
  });
  test.each([{ periodo: "otro" }, { periodo: "personalizado", desde: "2026-02-30", hasta: "2026-03-01" }, { periodo: "personalizado", desde: "2026-09-30", hasta: "2026-09-01" }, { periodo: "personalizado" }, { periodo: "personalizado", desde: "2020-01-01", hasta: "2026-09-30" }])("rechaza periodo inválido %j", async (args) => {
    await expect(dashboard("adminA", args)).rejects.toThrow(/Periodo|periodo|fechas/);
  });
  test("granularidad adaptativa y febrero bisiesto, sin cientos de puntos", () => {
    for (const [desde, hasta, granularidad] of [["2026-09-01", "2026-09-30", "día"], ["2026-06-01", "2026-09-30", "semana"], ["2022-01-01", "2026-09-30", "mes"]]) {
      const r = periodoIncidentes("personalizado", desde, hasta, AHORA);
      const serie = intervalosIncidentes(r.desde, r.hasta);
      expect(serie.granularidad).toBe(granularidad); expect(serie.puntos.length).toBeLessThanOrEqual(61);
      expect(serie.puntos[0]!.desde).toBe(r.desde); expect(serie.puntos.at(-1)!.hasta).toBe(r.hasta);
      for (let i = 1; i < serie.puntos.length; i++) expect(serie.puntos[i]!.desde).toBe(serie.puntos[i - 1]!.hasta + 1);
    }
    const febrero = periodoIncidentes("mesAnterior", undefined, undefined, Date.parse("2024-03-01T12:00:00-05:00"));
    expect(febrero.hastaDia).toBe("2024-02-29");
  });
});
describe("conteos, fórmulas y equivalencia con bandeja", () => {
  test("total y estados exactos; desconocidos históricos se mantienen; conjunto se ordena en backend", async () => {
    for (const estado of ["REPORTADO", "EN_INVESTIGACION", "EN_SEGUIMIENTO", "RESUELTO", "CERRADO"] as const) await caso({ estado, tipo: estado === "CERRADO" ? "TIPO_HISTORICO" : "ACCESO" });
    const d = (await dashboard())!;
    expect(d.total).toBe(5); expect(d.activos).toBe(3); expect(Object.values(d.estados)).toEqual([1, 1, 1, 1, 1]);
    expect(d.tipos).toEqual([{ tipo: "ACCESO", cantidad: 4 }, { tipo: "TIPO_HISTORICO", cantidad: 1 }]);
    expect(d.conjuntos[0]!.cantidad).toBe(5); expect(d.relevantes).toHaveLength(3);
  });
  test.each([{ prioridad: "CRITICA" as const }, { estado: "EN_INVESTIGACION" as const }, { activos: true }, { estado: "CERRADO" as const, activos: true }, { tipo: "TIPO_HISTORICO", prioridad: "CRITICA" as const, estado: "EN_INVESTIGACION" as const }])("filtros combinados %j producen el mismo total que listar", async (filtros) => {
    await caso({ tipo: "TIPO_HISTORICO", prioridad: "CRITICA", estado: "EN_INVESTIGACION" });
    await caso({ prioridad: "CRITICA", estado: "CERRADO" }); await caso(); await caso({ condominioId: e.ajeno, prioridad: "CRITICA" });
    const rango = periodoIncidentes("30dias", undefined, undefined, AHORA);
    const d = (await dashboard("adminA", { ...filtros, condominioId: e.conjunto }))!;
    const lista = await e.como("adminA").query(api.incidentes.listar, { ...filtros, companiaId: e.companiaA, condominioId: e.conjunto, desde: rango.desde, hasta: rango.hasta, paginationOpts: e.paginar });
    expect(d.total).toBe(lista.page.length); expect(Object.values(d.prioridades).reduce((a, b) => a + b, 0)).toBe(d.total);
  });
  test("antigüedad exacta y relevantes por prioridad y fecha, máximo cinco", async () => {
    for (let i = 0; i < 6; i++) await caso({ reportadoEn: AHORA - (i + 1) * DIA, prioridad: "ALTA" });
    const critico = await caso({ reportadoEn: AHORA - 7 * DIA, prioridad: "CRITICA" });
    await caso({ reportadoEn: AHORA - 7 * DIA + 1 }); await caso({ reportadoEn: AHORA - 8 * DIA, estado: "RESUELTO" });
    const d = (await dashboard())!;
    expect(d.antiguos).toBe(1); expect(d.antiguedadDias).toBe(7); expect(d.relevantes).toHaveLength(5); expect(d.relevantes[0]!._id).toBe(critico);
    expect(d.relevantes[1]!.reportadoEn).toBe(AHORA - 6 * DIA);
  });
  test("resolución promedia reporte → resolución vigente, excluye inválidos y no usa cierre", async () => {
    await caso({ estado: "RESUELTO", reportadoEn: AHORA - DIA, resueltoEn: AHORA });
    await caso({ estado: "CERRADO", reportadoEn: AHORA - 2 * DIA, resueltoEn: AHORA, cerradoEn: AHORA + 10 * DIA });
    await caso({ estado: "CERRADO" }); await caso({ estado: "RESUELTO", resueltoEn: AHORA - 1 });
    await caso({ estado: "EN_SEGUIMIENTO", resueltoEn: AHORA + 20 * DIA });
    const d = (await dashboard())!;
    expect(d.resolucion).toEqual({ promedioMs: 1.5 * DIA, muestra: 2, sinFecha: 2 });
  });
  test("reapertura real elimina la resolución vigente y sale de la muestra", async () => {
    const id = await caso({ estado: "RESUELTO", reportadoEn: AHORA - DIA, resueltoEn: AHORA });
    expect((await dashboard())!.resolucion.muestra).toBe(1);
    await e.como("adminA").mutation(api.incidentes.cambiarEstado, { incidenteId: id, estado: "EN_SEGUIMIENTO", motivo: "Revisar nuevamente" });
    const d = (await dashboard())!; expect(d.resolucion.muestra).toBe(0); expect(d.activos).toBe(1);
  });
  test("límite de lectura se rechaza sin totales parciales incluso con filtros sin coincidencias", async () => {
    await e.t.run(async (ctx) => {
      for (let i = 0; i <= MAX_INCIDENTES_ANALITICA; i++) await ctx.db.insert("incidentes", { companiaId: e.companiaA, condominioId: e.conjunto, reportadoPorUserId: e.adminA, reportadoPorNombre: "Ana", tipo: "ACCESO", ubicacion: "P", descripcion: "H", estado: "REPORTADO", prioridad: "MEDIA", reportadoEn: AHORA, ocurrioEn: AHORA, createdAt: AHORA, updatedAt: AHORA });
    });
    await expect(dashboard("adminA", { prioridad: "CRITICA" })).rejects.toThrow("LIMITE_ANALITICA");
  });
});
