import { beforeEach, describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import { DIA, diaColombia, limiteDiaColombia } from "../convex/lib/incidenteMetricas";
import { homeHrefForCompania } from "../../../apps/web/lib/role-routing";

const modules = import.meta.glob("../convex/**/*.ts");
async function montar() {
  const t = convexTest(schema, modules);
  const inicio = limiteDiaColombia(diaColombia(Date.now() - 2 * DIA));
  const ids = await t.run(async ctx => {
    const perfil = async (nombre: string) => ctx.db.insert("users", { name: nombre, email: `${nombre}@test.test`, authId: nombre, emailVerified: true, active: true, createdAt: inicio, updatedAt: inicio });
    const admin = await perfil("Admin"), guarda = await perfil("Guarda"), segundo = await perfil("Segundo"), rival = await perfil("Rival"), supervisor = await perfil("Supervisor");
    const compania = await ctx.db.insert("companiasSeguridad", { nombre: "Andina", estado: "activa", createdAt: inicio, updatedAt: inicio });
    const otra = await ctx.db.insert("companiasSeguridad", { nombre: "Otra", estado: "activa", createdAt: inicio, updatedAt: inicio });
    const condominio = await ctx.db.insert("condominios", { name: "Norte", activeModules: [], isActive: true, createdAt: inicio, updatedAt: inicio });
    const sur = await ctx.db.insert("condominios", { name: "Sur", activeModules: [], isActive: true, createdAt: inicio, updatedAt: inicio });
    const extranjero = await ctx.db.insert("condominios", { name: "Ajeno", activeModules: [], isActive: true, createdAt: inicio, updatedAt: inicio });
    for (const [id, rol, cia] of [[admin, "admin_compania", compania], [guarda, "guardia", compania], [segundo, "guardia", compania], [supervisor, "supervisor", compania], [rival, "admin_compania", otra]] as const) {
      await ctx.db.insert("companiaMiembros", { userId: id, companiaId: cia, roles: [rol], isActive: true, createdAt: inicio, updatedAt: inicio });
    }
    const contrato = await ctx.db.insert("companiaContratos", { companiaId: compania, condominioId: condominio, vigenciaDesde: inicio - 20 * DIA, creadoPorUserId: admin, createdAt: inicio, updatedAt: inicio });
    await ctx.db.insert("companiaContratos", { companiaId: compania, condominioId: sur, vigenciaDesde: inicio - 20 * DIA, creadoPorUserId: admin, createdAt: inicio, updatedAt: inicio });
    const asignar = async (id: typeof guarda) => {
      const m = await ctx.db.query("companiaMiembros").withIndex("by_user", q => q.eq("userId", id)).first();
      return ctx.db.insert("asignaciones", { contratoId: contrato, companiaMiembroId: m!._id, userId: id, companiaId: compania, condominioId: condominio, rol: "guardia", vigenciaDesde: inicio - 10 * DIA, creadoPorUserId: admin, createdAt: inicio });
    };
    const asignacion = await asignar(guarda); await asignar(segundo);
    const turno = await ctx.db.insert("guardiaTurnos", { condominioId: condominio, guardiaUserId: guarda, guardiaNombre: "Guarda", guardiaSecundarioUserId: segundo, guardiaSecundarioNombre: "Segundo", checklist: [], estado: "cerrado", fechaInicio: inicio, fechaCierre: inicio + 12 * 3_600_000, createdAt: inicio, updatedAt: inicio });
    const evento = async (actorUserId: typeof guarda | undefined, en: number, modulo: "minuta" | "novedades" = "minuta") => ctx.db.insert("minutaEventos", { condominioId: condominio, turnoId: turno, modulo, tipo: "Registro", unidad: "Portería", resumen: "Registro", estado: "cerrado", actorUserId, actorNombre: "Actor", createdAt: en });
    await evento(guarda, inicio - 1); // fuera del día civil
    await evento(guarda, inicio); await evento(segundo, inicio + DIA - 1, "novedades");
    await evento(undefined, inicio + 1000); await evento(rival, inicio + 2000);
    await evento(guarda, inicio + DIA); // fuera del periodo
    await ctx.db.insert("guardiaRondas", { condominioId: condominio, turnoId: turno, zona: "Norte", fotos: [], guardiaUserId: guarda, estado: "finalizada", fechaInicio: inicio + 1000, fechaCierre: inicio + 61_000, createdAt: inicio + 1000 });
    await ctx.db.insert("guardiaRondas", { condominioId: condominio, turnoId: turno, zona: "Legado", fotos: [], createdAt: inicio + 2000 });
    await ctx.db.insert("guardiaRondas", { condominioId: condominio, turnoId: turno, zona: "Sur", fotos: [], guardiaUserId: segundo, estado: "en_curso", fechaInicio: inicio + 3000, createdAt: inicio + 3000 });
    const reporte = async (tipoReporte: "novedad" | "aporte_voluntario" | undefined, placa?: string) => ctx.db.insert("guardiaNovedadReportes", { condominioId: condominio, turnoId: turno, tipoReporte, vehiculoPlaca: placa, titulo: "Reporte", descripcion: "Descripción", prioridad: "alta", reportadoPorUserId: guarda, reportadoPorNombre: "Guarda", createdAt: inicio + 4000 });
    await reporte("novedad"); await reporte("aporte_voluntario"); await reporte(undefined, "ABC123");
    return { admin, guarda, segundo, rival, compania, contrato, condominio, sur, extranjero, asignacion, turno };
  });
  return { t, ids, inicio, como: (nombre: string) => t.withIdentity({ subject: nombre }), filtros: { desde: diaColombia(inicio), hasta: diaColombia(inicio), granularidad: "dia" as const } };
}
let e: Awaited<ReturnType<typeof montar>>;
beforeEach(async () => { e = await montar(); });
describe("Panel operativo de compañía", () => {
  test("cuenta fuentes sin duplicar reportes, respeta límites inclusivos y conserva legado", async () => {
    const d = await e.como("Admin").query(api.companias.operacion, e.filtros);
    expect(d.total).toEqual({ turnos: 1, inicios: 1, cerrados: 1, rondas: 2, rondasEnCurso: 1, minuta: 3, novedades: 1, aportes: 2 });
    expect(d.sinAutorMinuta).toBe(1); expect(d.sinAutorRondas).toBe(1);
    expect(d.duracionRondas).toEqual({ promedioMs: 60_000, muestra: 1 });
    expect(d.prioridades).toEqual({ baja: 0, media: 0, alta: 1 });
    expect(d.porConjunto.reduce((n, c) => n + c.minuta, 0)).toBe(d.total.minuta);
    expect(d.porGuarda.reduce((n, g) => n + g.turnos, 0)).toBe(2);
    expect(d.porGuarda.reduce((n, g) => n + g.minuta, 0)).toBe(2);
  });
  test("detalle del secundario cuenta participación pero no otra apertura ni rondas ajenas", async () => {
    const d = await e.como("Admin").query(api.companias.operacion, { ...e.filtros, guardiaUserId: e.ids.segundo });
    expect(d.total).toEqual({ turnos: 1, inicios: 0, cerrados: 1, rondas: 0, rondasEnCurso: 1, minuta: 1, novedades: 0, aportes: 0 });
    expect(d.porGuarda).toHaveLength(1); expect(d.sinAutorRondas).toBe(0);
  });
  test("filtro de conjunto vacío y guarda fuera de ámbito", async () => {
    const d = await e.como("Admin").query(api.companias.operacion, { ...e.filtros, condominioId: e.ids.sur });
    expect(d.total.turnos).toBe(0); expect(d.guardas).toHaveLength(0);
    await expect(e.como("Admin").query(api.companias.operacion, { ...e.filtros, condominioId: e.ids.sur, guardiaUserId: e.ids.guarda })).rejects.toThrow("ámbito");
  });
  test("tendencias consistentes y ceros en días sin actividad, para cada granularidad", async () => {
    for (const granularidad of ["dia", "semana", "mes"] as const) {
      const d = await e.como("Admin").query(api.companias.operacion, { ...e.filtros, hasta: diaColombia(e.inicio + 40 * DIA), granularidad });
      expect(d.evolucion.reduce((n, p) => n + p.minuta, 0)).toBe(d.total.minuta);
      expect(d.evolucion.reduce((n, p) => n + p.turnos, 0)).toBe(d.total.turnos);
      expect(d.evolucion.some(p => p.minuta === 0)).toBe(true);
      expect(d.evolucion.at(-1)!.hasta).toBe(d.periodo.hasta);
    }
  });
  test("un guarda desactivado hoy mantiene su histórico de asignación", async () => {
    await e.t.run(async ctx => {
      await ctx.db.patch(e.ids.asignacion, { terminadoEn: e.inicio + DIA });
      const m = await ctx.db.query("companiaMiembros").withIndex("by_user", q => q.eq("userId", e.ids.guarda)).first();
      await ctx.db.patch(m!._id, { isActive: false });
    });
    const d = await e.como("Admin").query(api.companias.operacion, { ...e.filtros, guardiaUserId: e.ids.guarda });
    expect(d.total.turnos).toBe(1); expect(d.total.novedades).toBe(1);
  });
  test("no atribuye registros anteriores a la asignación", async () => {
    await e.t.run(async ctx => { await ctx.db.patch(e.ids.asignacion, { vigenciaDesde: e.inicio + DIA }); });
    const d = await e.como("Admin").query(api.companias.operacion, e.filtros);
    expect(d.total.novedades).toBe(0); expect(d.total.rondas).toBe(1); expect(d.total.inicios).toBe(0);
  });
  test("contrato terminado deja de autorizar portería y rechaza su filtro", async () => {
    await e.t.run(async ctx => { await ctx.db.patch(e.ids.contrato, { terminadoEn: Date.now() - 1 }); });
    const d = await e.como("Admin").query(api.companias.operacion, e.filtros);
    expect(d.total.minuta).toBe(0);
    await expect(e.como("Admin").query(api.companias.operacion, { ...e.filtros, condominioId: e.ids.condominio })).rejects.toThrow("autorizado");
  });
  test("autorización del servidor rechaza guarda, supervisor, anónimo y filtro de otra compañía", async () => {
    for (const nombre of ["Guarda", "Supervisor"]) await expect(e.como(nombre).query(api.companias.operacion, e.filtros)).rejects.toThrow("administrador");
    await expect(e.t.query(api.companias.operacion, e.filtros)).rejects.toThrow("autenticado");
    await expect(e.como("Rival").query(api.companias.operacion, { ...e.filtros, condominioId: e.ids.condominio })).rejects.toThrow("autorizado");
    await expect(e.como("Admin").query(api.companias.operacion, { ...e.filtros, condominioId: e.ids.extranjero })).rejects.toThrow("autorizado");
  });
  test("compañía suspendida y usuario inactivo no acceden", async () => {
    await e.t.run(async ctx => { await ctx.db.patch(e.ids.compania, { estado: "suspendida" }); });
    await expect(e.como("Admin").query(api.companias.operacion, e.filtros)).rejects.toThrow("suspendida");
    await e.t.run(async ctx => { await ctx.db.patch(e.ids.admin, { active: false }); });
    await expect(e.como("Admin").query(api.companias.operacion, e.filtros)).rejects.toThrow("inactivo");
  });
  test("snapshot de turnos abiertos independiente del periodo", async () => {
    await e.t.run(async ctx => { await ctx.db.patch(e.ids.turno, { estado: "abierto" }); });
    const d = await e.como("Admin").query(api.companias.operacion, { ...e.filtros, desde: diaColombia(e.inicio + DIA), hasta: diaColombia(e.inicio + DIA) });
    expect(d.total.turnos).toBe(0); expect(d.activos).toHaveLength(1);
  });
  test("rechaza fechas inválidas, rangos invertidos y periodos excesivos", async () => {
    for (const rango of [{ desde: "2026-02-30", hasta: "2026-03-01" }, { desde: "2026-10-01", hasta: "2026-09-01" }, { desde: "2025-01-01", hasta: "2026-09-01" }]) {
      await expect(e.como("Admin").query(api.companias.operacion, { ...e.filtros, ...rango })).rejects.toThrow();
    }
  });
  test("al superar el presupuesto rechaza el agregado, sin devolver cifras parciales", async () => {
    await e.t.run(async ctx => {
      for (let i = 0; i < 6001; i++) await ctx.db.insert("minutaEventos", {
        condominioId: e.ids.condominio, modulo: "minuta", tipo: "Registro", unidad: "Portería", resumen: "Registro", estado: "cerrado",
        actorUserId: e.ids.guarda, actorNombre: "Guarda", createdAt: e.inicio + 10_000 + i,
      });
    });
    await expect(e.como("Admin").query(api.companias.operacion, e.filtros)).rejects.toThrow("No se muestran totales parciales");
  });
  test("inicio del administrador llega al panel y conserva los destinos de supervisor y guarda", () => {
    expect(homeHrefForCompania("admin_compania", "id")).toBe("/vigilancia/inicio");
    expect(homeHrefForCompania("supervisor", "id")).toBe("/vigilancia");
    expect(homeHrefForCompania("guardia", "id")).toBeNull();
  });
});
