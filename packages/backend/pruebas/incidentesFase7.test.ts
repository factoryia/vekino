import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../convex/_generated/api";
import type { FunctionArgs } from "convex/server";
import type { Doc } from "../convex/_generated/dataModel";
import { montar } from "./helpers/incidentes";
import { DIA, periodoIncidentes } from "../convex/lib/incidenteMetricas";
import { COLUMNAS_REPORTE_INCIDENTES, COLUMNAS_CONTEXTO_CSV_INCIDENTES, csvReporteIncidentes, MAX_INCIDENTES_EXPORTACION, MAX_BYTES_EXPORTACION, nombreReporteIncidentes } from "../convex/lib/incidenteReporte";

const AHORA = Date.parse("2026-09-30T10:30:00-05:00");
let e: Awaited<ReturnType<typeof montar>>;
beforeEach(async () => { vi.setSystemTime(AHORA); e = await montar(); });
afterEach(() => vi.useRealTimers());
async function caso(patch: Partial<Omit<Doc<"incidentes">, "_id" | "_creationTime">> = {}) {
  return e.t.run((ctx) => ctx.db.insert("incidentes", { companiaId: e.companiaA, condominioId: e.conjunto, reportadoPorUserId: e.adminA,
    reportadoPorNombre: "Ana", responsableNombre: "Luis", tipo: "ACCESO", ubicacion: "Portería", descripcion: "DOCUMENTO PRIVADO https://privado token secreto",
    estado: "REPORTADO", prioridad: "MEDIA", reportadoEn: AHORA, ocurrioEn: AHORA - 100 * DIA, createdAt: AHORA, updatedAt: AHORA, ...patch }));
}
function reporte(actor = "adminA", args: Partial<FunctionArgs<typeof api.incidentes.reporte>> = {}) {
  return e.como(actor).query(api.incidentes.reporte, { periodo: "30dias", exportar: true, ...args });
}
async function csv(actor = "adminA", args: Partial<FunctionArgs<typeof api.incidentes.reporte>> = {}) {
  const d = (await reporte(actor, args))!;
  return csvReporteIncidentes(d.reporte!.filas, { ...d.periodo, ...d.reporte!.filtros, generadoEn: d.reporte!.generadoEn, conjunto: d.reporte!.conjunto });
}
describe("reportes: alcance, filtros y cohorte compartida", () => {
  test("dos compañías en el mismo conjunto conservan archivos y agregados completamente aislados", async () => {
    const a = await caso(); const antes = await reporte();
    const b = await caso({ companiaId: e.companiaB, reportadoPorUserId: e.adminB, reportadoPorNombre: "RIVAL", responsableNombre: "RIVAL", tipo: "SOLO_B", estado: "CERRADO", prioridad: "CRITICA" });
    expect(await reporte()).toEqual(antes); expect((await reporte())!.reporte!.filas.map((c) => c.referencia)).toEqual([a]);
    expect(await csv()).not.toContain(b); expect(await csv()).not.toContain("RIVAL");
    expect((await reporte("adminB"))!.reporte!.filas.map((c) => c.referencia)).toEqual([b]);
  });
  test("supervisor solo exporta la unión autorizada A+B y nunca C; no acepta listas del cliente", async () => {
    const tercero = await e.t.run(async (ctx) => {
      const contratoId = await ctx.db.insert("companiaContratos", { companiaId: e.companiaA, condominioId: e.ajeno, vigenciaDesde: AHORA - DIA, creadoPorUserId: e.adminA, createdAt: AHORA, updatedAt: AHORA });
      const miembro = await ctx.db.query("companiaMiembros").withIndex("by_user", (q) => q.eq("userId", e.supervisorA)).first();
      await ctx.db.insert("asignaciones", { contratoId, companiaMiembroId: miembro!._id, userId: e.supervisorA, companiaId: e.companiaA, condominioId: e.ajeno, rol: "supervisor", vigenciaDesde: AHORA - DIA, creadoPorUserId: e.adminA, createdAt: AHORA });
      const { _id, _creationTime, ...base } = (await ctx.db.get(e.conjunto))!;
      return ctx.db.insert("condominios", { ...base, name: "C" });
    });
    const a = await caso(); const b = await caso({ condominioId: e.ajeno }); const c = await caso({ condominioId: tercero });
    const d = (await reporte("supervisorA"))!; expect(d.total).toBe(2); expect(new Set(d.reporte!.filas.map((f) => f.referencia))).toEqual(new Set([a, b]));
    expect(await csv("supervisorA")).not.toContain(c);
    await expect(reporte("supervisorA", { condominioId: tercero })).rejects.toThrow(/contrato|permiso/);
  });
  test("guarda no obtiene reportes ni exportaciones, mantiene lectura propia de bandeja", async () => {
    const propio = await caso({ reportadoPorUserId: e.guardaA }); await caso();
    await expect(reporte("guardaA")).rejects.toThrow("SIN_ACCESO_REPORTE");
    await expect(reporte("guardaA", { exportar: false })).rejects.toThrow("SIN_ACCESO_REPORTE");
    const lista = await e.como("guardaA").query(api.incidentes.listar, { companiaId: e.companiaA, condominioId: e.conjunto, paginationOpts: e.paginar });
    expect(lista.page.map((f) => f._id)).toEqual([propio]);
  });
  test("sin membresía, sesión o compañía vigente no hay exportación", async () => {
    await expect(reporte("sinEmpresa")).rejects.toThrow("SIN_ACCESO_REPORTE");
    await expect(e.t.query(api.incidentes.reporte, { periodo: "hoy", exportar: true })).rejects.toThrow();
    await e.t.run((ctx) => ctx.db.patch(e.companiaA, { estado: "inactiva" }));
    await expect(reporte()).rejects.toThrow(/activa/);
  });
  test("revocar contrato invalida supervisor; admin conserva histórico igual que dashboard", async () => {
    await caso(); await e.t.run((ctx) => ctx.db.patch(e.kA, { terminadoEn: AHORA - 1 }));
    expect(await reporte("supervisorA")).toBeNull(); expect((await reporte())!.total).toBe(1);
  });
  test.each(["hoy", "7dias", "30dias", "mes", "mesAnterior", "personalizado"])("%s coincide con dashboard y bandeja en ambos extremos civiles", async (periodo) => {
    const filtros = { periodo, desde: "2026-08-03", hasta: "2026-09-07" };
    const rango = periodoIncidentes(periodo, filtros.desde, filtros.hasta, AHORA);
    for (const reportadoEn of [rango.desde - 1, rango.desde, rango.hasta, rango.hasta + 1]) await caso({ reportadoEn });
    const r = (await reporte("adminA", filtros))!; const d = (await e.como("adminA").query(api.incidentes.dashboard, filtros))!;
    const l = await e.como("adminA").query(api.incidentes.listar, { companiaId: e.companiaA, desde: rango.desde, hasta: rango.hasta, paginationOpts: e.paginar });
    expect(r.total).toBe(2); expect(r.total).toBe(d.total); expect(r.estados).toEqual(d.estados); expect(r.periodo).toEqual(d.periodo);
    expect(r.reporte!.filas.map((c) => c.referencia)).toEqual(l.page.map((c) => c._id));
  });
  test.each([{ prioridad: "CRITICA" as const }, { activos: true }, { estado: "CERRADO" as const, activos: true }, { tipo: "HISTORICO", prioridad: "CRITICA" as const, estado: "EN_INVESTIGACION" as const }])("combinación %j corresponde a los mismos casos y métricas", async (filtros) => {
    await caso({ tipo: "HISTORICO", prioridad: "CRITICA", estado: "EN_INVESTIGACION" }); await caso({ prioridad: "CRITICA", estado: "CERRADO" }); await caso(); await caso({ condominioId: e.ajeno, prioridad: "CRITICA" });
    const args = { periodo: "30dias", condominioId: e.conjunto, ...filtros };
    const r = (await reporte("adminA", args))!; const d = (await e.como("adminA").query(api.incidentes.dashboard, args))!;
    const rango = periodoIncidentes("30dias", undefined, undefined, AHORA);
    const l = await e.como("adminA").query(api.incidentes.listar, { companiaId: e.companiaA, desde: rango.desde, hasta: rango.hasta, condominioId: e.conjunto, ...filtros, paginationOpts: e.paginar });
    expect(r.total).toBe(d.total); expect(r.estados).toEqual(d.estados); expect(r.activos).toBe(d.activos);
    expect(new Set(r.reporte!.filas.map((c) => c.referencia))).toEqual(new Set(l.page.map((c) => c._id)));
  });
  test("estado actual, no estado histórico; hecho fuera del periodo se conserva", async () => {
    const id = await caso({ estado: "RESUELTO", resueltoEn: AHORA, reportadoEn: AHORA - DIA });
    await e.como("adminA").mutation(api.incidentes.cambiarEstado, { incidenteId: id, estado: "EN_SEGUIMIENTO", motivo: "Revisión" });
    const r = (await reporte())!; expect(r.activos).toBe(1); expect(r.reporte!.filas[0]!.resueltoEn).toBeNull(); expect(r.reporte!.filas[0]!.ocurrioEn).toBe(AHORA - 100 * DIA);
  });
});
describe("archivos, privacidad y límites", () => {
  test("CSV conserva encabezados, orden, escape, fechas y contexto oficial; omite descripción y datos técnicos", async () => {
    const viejo = await caso({ reportadoEn: AHORA - DIA, ubicacion: 'Puerta, "Sur"\nPiso 1', resueltoEn: AHORA, cerradoEn: AHORA });
    const nuevo = await caso({ ubicacion: "=HYPERLINK(secreto)", tipo: "@suma" });
    const archivo = await csv();
    expect(archivo.startsWith('\uFEFF' + [...COLUMNAS_REPORTE_INCIDENTES, ...COLUMNAS_CONTEXTO_CSV_INCIDENTES].map((v) => `"${v}"`).join(","))).toBe(true);
    expect(archivo.indexOf(nuevo)).toBeLessThan(archivo.indexOf(viejo)); expect(archivo).toContain('"Puerta, ""Sur""\nPiso 1"'); expect(archivo).toContain("'=HYPERLINK"); expect(archivo).toContain("'@suma"); expect(archivo).toContain("2026-09-30 10:30:00.000 -05:00");
    for (const secreto of ["DOCUMENTO PRIVADO", "https://privado", "token", "storageKey", "companiaId", "reportadoPorUserId", "condominioId", "createdAt"]) expect(archivo).not.toContain(secreto);
    expect(Object.keys((await reporte())!.reporte!.filas[0]!).sort()).toEqual(["referencia", "conjunto", "reportadoEn", "ocurrioEn", "tipo", "prioridad", "estado", "ubicacion", "reportante", "responsable", "resueltoEn", "cerradoEn"].sort());
  });
  test("nombre determinista omite identificadores y sanitiza conjunto", () => {
    const p = { desdeDia: "2026-09-01", hastaDia: "2026-09-30" };
    expect(nombreReporteIncidentes(p, "csv")).toBe("incidentes-2026-09-01-2026-09-30.csv");
    expect(nombreReporteIncidentes(p, "xlsx", "Conjunto Ñ / Sur")).toBe("incidentes-conjunto-n-sur-2026-09-01-2026-09-30.xlsx");
  });
  test("consulta vacía muestra ceros; exportación vacía falla explícitamente", async () => {
    const d = (await reporte("adminA", { exportar: false }))!; expect(d.total).toBe(0); expect(d.reporte!.filas).toEqual([]);
    await expect(reporte()).rejects.toThrow("REPORTE_VACIO");
  });
  test("preview limitado conserva métricas completas; acepta el límite exacto y rechaza una fila extra", async () => {
    await e.t.run(async (ctx) => {
      for (let i = 0; i < MAX_INCIDENTES_EXPORTACION; i++) await ctx.db.insert("incidentes", { companiaId: e.companiaA, condominioId: e.conjunto, reportadoPorUserId: e.adminA, reportadoPorNombre: "Ana", tipo: "ACCESO", ubicacion: "P", descripcion: "H", estado: "REPORTADO", prioridad: "MEDIA", reportadoEn: AHORA - i, ocurrioEn: AHORA, createdAt: AHORA, updatedAt: AHORA });
    });
    const vista = (await reporte("adminA", { exportar: false }))!; expect(vista.total).toBe(MAX_INCIDENTES_EXPORTACION); expect(vista.reporte!.filas).toHaveLength(50);
    const completo = (await reporte())!; expect(completo.reporte!.filas).toHaveLength(MAX_INCIDENTES_EXPORTACION); expect(vista.reporte!.filas).toEqual(completo.reporte!.filas.slice(0, 50));
    await caso(); await expect(reporte()).rejects.toThrow("LIMITE_EXPORTACION");
  });
  test("límite de bytes evita payloads grandes aun dentro del límite de filas", async () => {
    const grande = "N".repeat(MAX_BYTES_EXPORTACION);
    await caso({ reportadoPorNombre: grande }); await expect(reporte()).rejects.toThrow("LIMITE_EXPORTACION");
  });
});
