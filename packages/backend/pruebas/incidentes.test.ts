import { beforeEach, describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import betterAuthTest from "@convex-dev/better-auth/test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

const modules = import.meta.glob("../convex/**/*.ts");
const DIA = 24 * 60 * 60 * 1000;

async function montar() {
  const t = convexTest(schema, modules);
  betterAuthTest.register(t);
  const ahora = Date.now();
  const ids = await t.run(async (ctx) => {
    const usuario = (authId: string, name: string) => ctx.db.insert("users", {
      authId, name, email: `${authId}@test.local`, emailVerified: true,
      active: true, createdAt: ahora, updatedAt: ahora,
    });
    const adminA = await usuario("adminA", "Ana Andina");
    const adminB = await usuario("adminB", "Berta Rival");
    const supervisorA = await usuario("supervisorA", "Sofia Andina");
    const supervisorB = await usuario("supervisorB", "Sara Rival");
    const guardaA = await usuario("guardaA", "Gabriel Andina");
    const guardaB = await usuario("guardaB", "Gustavo Rival");
    await usuario("sinEmpresa", "Residente Solo");
    const companiaA = await ctx.db.insert("companiasSeguridad", {
      nombre: "Andina", estado: "activa", createdAt: ahora, updatedAt: ahora,
    });
    const companiaB = await ctx.db.insert("companiasSeguridad", {
      nombre: "Rival", estado: "activa", createdAt: ahora, updatedAt: ahora,
    });
    const conjunto = await ctx.db.insert("condominios", {
      name: "Conjunto compartido", activeModules: [], isActive: true,
      createdAt: ahora, updatedAt: ahora,
    });
    const ajeno = await ctx.db.insert("condominios", {
      name: "Sin contrato", activeModules: [], isActive: true,
      createdAt: ahora, updatedAt: ahora,
    });
    const miembro = (userId: Id<"users">, companiaId: Id<"companiasSeguridad">, rol: "admin_compania" | "supervisor" | "guardia") =>
      ctx.db.insert("companiaMiembros", {
        userId, companiaId, roles: [rol], isActive: true, createdAt: ahora, updatedAt: ahora,
      });
    await miembro(adminA, companiaA, "admin_compania");
    await miembro(adminB, companiaB, "admin_compania");
    const msA = await miembro(supervisorA, companiaA, "supervisor");
    const msB = await miembro(supervisorB, companiaB, "supervisor");
    const mgA = await miembro(guardaA, companiaA, "guardia");
    const mgB = await miembro(guardaB, companiaB, "guardia");
    const contrato = (companiaId: Id<"companiasSeguridad">) => ctx.db.insert("companiaContratos", {
      companiaId, condominioId: conjunto, vigenciaDesde: ahora - DIA,
      creadoPorUserId: adminA, createdAt: ahora, updatedAt: ahora,
    });
    const kA = await contrato(companiaA);
    const kB = await contrato(companiaB);
    const asignar = (contratoId: Id<"companiaContratos">, companiaMiembroId: Id<"companiaMiembros">, userId: Id<"users">, companiaId: Id<"companiasSeguridad">, rol: "supervisor" | "guardia") =>
      ctx.db.insert("asignaciones", {
        contratoId, companiaMiembroId, userId, companiaId, condominioId: conjunto,
        rol, vigenciaDesde: ahora - DIA, creadoPorUserId: adminA, createdAt: ahora,
      });
    await asignar(kA, msA, supervisorA, companiaA, "supervisor");
    await asignar(kA, mgA, guardaA, companiaA, "guardia");
    await asignar(kB, msB, supervisorB, companiaB, "supervisor");
    await asignar(kB, mgB, guardaB, companiaB, "guardia");
    return { companiaA, companiaB, conjunto, ajeno, adminA, adminB, supervisorA, guardaA, kA, mgA };
  });
  const como = (subject: string) => t.withIdentity({ subject });
  const datos = (condominioId = ids.conjunto) => ({
    condominioId, tipo: "ACCESO", ubicacion: "Portería norte",
    ocurrioEn: Date.now() - 60_000, descripcion: "Ingreso no autorizado",
    prioridad: "MEDIA" as const,
  });
  const paginar = { cursor: null, numItems: 20 };
  return { t, ...ids, como, datos, paginar };
}

type Escenario = Awaited<ReturnType<typeof montar>>;
describe("incidentes de vigilancia", () => {
  let e: Escenario;
  beforeEach(async () => { e = await montar(); });

  test("creación: actor, timestamps de servidor, estado y evento atómico", async () => {
    const antes = Date.now();
    const id = await e.como("guardaA").mutation(api.incidentes.crear, e.datos());
    const despues = Date.now();
    const caso = await e.como("guardaA").query(api.incidentes.obtener, { incidenteId: id });
    expect(caso.companiaId).toBe(e.companiaA);
    expect(caso.estado).toBe("REPORTADO");
    expect(caso.reportadoPorUserId).toBe(e.guardaA);
    expect(caso.reportadoPorNombre).toBe("Gabriel Andina");
    expect(caso.reportadoEn).toBeGreaterThanOrEqual(antes);
    expect(caso.reportadoEn).toBeLessThanOrEqual(despues);
    const eventos = await e.como("guardaA").query(api.incidentes.listarEventos, { incidenteId: id, paginationOpts: e.paginar });
    expect(eventos.page.map((x) => x.tipo)).toEqual(["CREACION"]);
    expect(eventos.page[0]!.actorUserId).toBe(e.guardaA);
    expect(eventos.page[0]!.companiaId).toBe(e.companiaA);
  });

  test("personas iniciales y eventos se guardan en la misma creación", async () => {
    const id = await e.como("guardaA").mutation(api.incidentes.crear, {
      ...e.datos(), personas: [
        { nombre: "  Juan Visitante  ", tipoPersona: "VISITANTE", documento: "123" },
        { nombre: "Marta", tipoPersona: "RESIDENTE", observacion: "Testigo" },
      ],
    });
    const personas = await e.como("guardaA").query(api.incidentes.listarPersonas, { incidenteId: id });
    expect(personas.map((p) => p.nombre)).toEqual(["Juan Visitante", "Marta"]);
    expect(personas.every((p) => p.companiaId === e.companiaA && p.condominioId === e.conjunto)).toBe(true);
    const eventos = await e.como("guardaA").query(api.incidentes.listarEventos, { incidenteId: id, paginationOpts: e.paginar });
    expect(eventos.page.map((x) => x.tipo)).toEqual(["PERSONA_AGREGADA", "PERSONA_AGREGADA", "CREACION"]);
    await expect(e.como("adminB").query(api.incidentes.listarPersonas, { incidenteId: id })).rejects.toThrow("compañía");
  });

  test("persona inicial inválida revierte incidente e historial completos", async () => {
    await expect(e.como("adminA").mutation(api.incidentes.crear, {
      ...e.datos(), personas: [{ nombre: "", tipoPersona: "VISITANTE" }],
    })).rejects.toThrow("Nombre");
    const [incidentes, personas, eventos] = await e.t.run(async (ctx) => Promise.all([
      ctx.db.query("incidentes").collect(),
      ctx.db.query("incidentePersonas").collect(),
      ctx.db.query("incidenteEventos").collect(),
    ]));
    expect(incidentes).toHaveLength(0);
    expect(personas).toHaveLength(0);
    expect(eventos).toHaveLength(0);
  });

  test("rechaza fecha futura y no deja filas parciales", async () => {
    await expect(e.como("guardaA").mutation(api.incidentes.crear, {
      ...e.datos(), ocurrioEn: Date.now() + DIA,
    })).rejects.toThrow("fecha");
    const filas = await e.t.run((ctx) => ctx.db.query("incidentes").collect());
    const eventos = await e.t.run((ctx) => ctx.db.query("incidenteEventos").collect());
    expect(filas).toHaveLength(0);
    expect(eventos).toHaveLength(0);
  });

  test("sin membresía corporativa no crea; tampoco en conjunto sin contrato", async () => {
    await expect(e.como("sinEmpresa").mutation(api.incidentes.crear, e.datos())).rejects.toThrow("compañía");
    await expect(e.como("adminA").mutation(api.incidentes.crear, e.datos(e.ajeno))).rejects.toThrow("contrato");
  });

  test("dos compañías en el mismo conjunto crean y listan sin mezclar", async () => {
    const a = await e.como("adminA").mutation(api.incidentes.crear, e.datos());
    const b = await e.como("adminB").mutation(api.incidentes.crear, e.datos());
    const listaA = await e.como("adminA").query(api.incidentes.listar, { companiaId: e.companiaA, paginationOpts: e.paginar });
    const listaB = await e.como("adminB").query(api.incidentes.listar, { companiaId: e.companiaB, paginationOpts: e.paginar });
    expect(listaA.page.map((x) => x._id)).toEqual([a]);
    expect(listaB.page.map((x) => x._id)).toEqual([b]);
    await expect(e.como("adminA").query(api.incidentes.listar, { companiaId: e.companiaB, paginationOpts: e.paginar })).rejects.toThrow("compañía");
  });

  test("ID de la otra empresa no permite detalle, mutación ni hijos", async () => {
    const b = await e.como("adminB").mutation(api.incidentes.crear, e.datos());
    await expect(e.como("adminA").query(api.incidentes.obtener, { incidenteId: b })).rejects.toThrow("compañía");
    await expect(e.como("adminA").mutation(api.incidentes.cambiarPrioridad, { incidenteId: b, prioridad: "ALTA" })).rejects.toThrow("compañía");
    await expect(e.como("adminA").mutation(api.incidentes.agregarPersona, { incidenteId: b, nombre: "X", tipoPersona: "TERCERO" })).rejects.toThrow("compañía");
    await expect(e.como("adminA").query(api.incidentes.listarPersonas, { incidenteId: b })).rejects.toThrow("compañía");
    await expect(e.como("adminA").query(api.incidentes.listarEventos, { incidenteId: b, paginationOpts: e.paginar })).rejects.toThrow("compañía");
  });

  test("supervisor ve y gestiona solo su compañía; guarda solo sus casos", async () => {
    const a = await e.como("adminA").mutation(api.incidentes.crear, e.datos());
    const propio = await e.como("guardaA").mutation(api.incidentes.crear, e.datos());
    const sup = await e.como("supervisorA").query(api.incidentes.listar, { companiaId: e.companiaA, condominioId: e.conjunto, paginationOpts: e.paginar });
    expect(sup.page.map((x) => x._id)).toEqual([propio, a]);
    const guarda = await e.como("guardaA").query(api.incidentes.listar, { companiaId: e.companiaA, condominioId: e.conjunto, paginationOpts: e.paginar });
    expect(guarda.page.map((x) => x._id)).toEqual([propio]);
    await expect(e.como("guardaA").query(api.incidentes.obtener, { incidenteId: a })).rejects.toThrow("acceso");
    await expect(e.como("guardaA").mutation(api.incidentes.cambiarPrioridad, { incidenteId: propio, prioridad: "ALTA" })).rejects.toThrow("permiso");
    await expect(e.como("supervisorB").query(api.incidentes.obtener, { incidenteId: a })).rejects.toThrow("compañía");
  });

  test("prioridad, clasificación, corrección, asignación y seguimiento registran diferencias", async () => {
    const id = await e.como("guardaA").mutation(api.incidentes.crear, e.datos());
    const admin = e.como("adminA");
    await admin.mutation(api.incidentes.cambiarPrioridad, { incidenteId: id, prioridad: "CRITICA" });
    await admin.mutation(api.incidentes.clasificar, { incidenteId: id, tipo: "SEGURIDAD" });
    await admin.mutation(api.incidentes.corregirDatos, { incidenteId: id, ubicacion: "Entrada sur" });
    await admin.mutation(api.incidentes.asignarResponsable, { incidenteId: id, responsableUserId: e.supervisorA });
    await admin.mutation(api.incidentes.registrarSeguimiento, { incidenteId: id, observacion: "Revisando cámaras" });
    const eventos = await admin.query(api.incidentes.listarEventos, { incidenteId: id, paginationOpts: e.paginar });
    expect(eventos.page.map((x) => x.tipo)).toEqual(["SEGUIMIENTO", "ASIGNACION", "CAMBIO_RELEVANTE", "CLASIFICACION", "CAMBIO_PRIORIDAD", "CREACION"]);
    expect(eventos.page.find((x) => x.tipo === "CAMBIO_PRIORIDAD")?.cambios).toEqual([{ campo: "prioridad", antes: "MEDIA", despues: "CRITICA" }]);
    const caso = await admin.query(api.incidentes.obtener, { incidenteId: id });
    expect(caso.responsableUserId).toBe(e.supervisorA);
    expect(caso.responsableNombre).toBe("Sofia Andina");
  });

  test("responsable ajeno o supervisor sin asignación es rechazado", async () => {
    const id = await e.como("adminA").mutation(api.incidentes.crear, e.datos());
    await expect(e.como("adminA").mutation(api.incidentes.asignarResponsable, { incidenteId: id, responsableUserId: e.adminB })).rejects.toThrow("misma compañía");
  });

  test("transiciones principales requieren resolución y cierre desde RESUELTO", async () => {
    const id = await e.como("adminA").mutation(api.incidentes.crear, e.datos());
    const admin = e.como("adminA");
    await expect(admin.mutation(api.incidentes.cambiarEstado, { incidenteId: id, estado: "CERRADO" })).rejects.toThrow("Transición");
    await admin.mutation(api.incidentes.cambiarEstado, { incidenteId: id, estado: "EN_INVESTIGACION" });
    await admin.mutation(api.incidentes.cambiarEstado, { incidenteId: id, estado: "EN_SEGUIMIENTO" });
    await expect(admin.mutation(api.incidentes.cambiarEstado, { incidenteId: id, estado: "RESUELTO" })).rejects.toThrow("resolución");
    await admin.mutation(api.incidentes.cambiarEstado, { incidenteId: id, estado: "RESUELTO", resolucionObservacion: "Se verificó y controló el acceso" });
    const resuelto = await admin.query(api.incidentes.obtener, { incidenteId: id });
    expect(resuelto.resueltoEn).toBeTypeOf("number");
    expect(resuelto.resolucionObservacion).toBe("Se verificó y controló el acceso");
    await admin.mutation(api.incidentes.cambiarEstado, { incidenteId: id, estado: "CERRADO" });
    const cerrado = await admin.query(api.incidentes.obtener, { incidenteId: id });
    expect(cerrado.cerradoEn).toBeTypeOf("number");
    await expect(admin.mutation(api.incidentes.cambiarEstado, { incidenteId: id, estado: "EN_SEGUIMIENTO", motivo: "Otro" })).rejects.toThrow("Transición");
    const eventos = await admin.query(api.incidentes.listarEventos, { incidenteId: id, paginationOpts: e.paginar });
    expect(eventos.page.map((x) => x.tipo)).toEqual(["CIERRE", "RESOLUCION", "CAMBIO_ESTADO", "CAMBIO_ESTADO", "CREACION"]);
  });

  test("retrocesos exigen motivo y limpian la resolución vigente", async () => {
    const id = await e.como("adminA").mutation(api.incidentes.crear, e.datos());
    const admin = e.como("adminA");
    for (const estado of ["EN_INVESTIGACION", "EN_SEGUIMIENTO"] as const) {
      await admin.mutation(api.incidentes.cambiarEstado, { incidenteId: id, estado });
    }
    await expect(admin.mutation(api.incidentes.cambiarEstado, { incidenteId: id, estado: "EN_INVESTIGACION" })).rejects.toThrow("motivo");
    await admin.mutation(api.incidentes.cambiarEstado, { incidenteId: id, estado: "EN_INVESTIGACION", motivo: "Nueva información" });
    await admin.mutation(api.incidentes.cambiarEstado, { incidenteId: id, estado: "EN_SEGUIMIENTO" });
    await admin.mutation(api.incidentes.cambiarEstado, { incidenteId: id, estado: "RESUELTO", resolucionObservacion: "Resuelto" });
    await expect(admin.mutation(api.incidentes.cambiarEstado, { incidenteId: id, estado: "EN_SEGUIMIENTO" })).rejects.toThrow("motivo");
    await admin.mutation(api.incidentes.cambiarEstado, { incidenteId: id, estado: "EN_SEGUIMIENTO", motivo: "Reapareció" });
    const caso = await admin.query(api.incidentes.obtener, { incidenteId: id });
    expect(caso.resueltoEn).toBeUndefined();
    expect(caso.resolucionObservacion).toBeUndefined();
  });

  test("solo admin cierra; cerrado bloquea ediciones y personas", async () => {
    const id = await e.como("adminA").mutation(api.incidentes.crear, e.datos());
    const admin = e.como("adminA");
    await admin.mutation(api.incidentes.cambiarEstado, { incidenteId: id, estado: "EN_INVESTIGACION" });
    await admin.mutation(api.incidentes.cambiarEstado, { incidenteId: id, estado: "EN_SEGUIMIENTO" });
    await admin.mutation(api.incidentes.cambiarEstado, { incidenteId: id, estado: "RESUELTO", resolucionObservacion: "Controlado" });
    await expect(e.como("supervisorA").mutation(api.incidentes.cambiarEstado, { incidenteId: id, estado: "CERRADO" })).rejects.toThrow("permiso");
    await admin.mutation(api.incidentes.cambiarEstado, { incidenteId: id, estado: "CERRADO" });
    await expect(admin.mutation(api.incidentes.cambiarPrioridad, { incidenteId: id, prioridad: "ALTA" })).rejects.toThrow("cerrado");
    await expect(admin.mutation(api.incidentes.agregarPersona, { incidenteId: id, nombre: "Juan", tipoPersona: "VISITANTE" })).rejects.toThrow("cerrado");
  });

  test("personas e historial heredan el tenant del padre sin userId de tercero", async () => {
    const id = await e.como("guardaA").mutation(api.incidentes.crear, e.datos());
    const personaId = await e.como("guardaA").mutation(api.incidentes.agregarPersona, {
      incidenteId: id, nombre: "Juan Visitante", tipoPersona: "VISITANTE", documento: "123",
    });
    const personas = await e.como("adminA").query(api.incidentes.listarPersonas, { incidenteId: id });
    expect(personas).toHaveLength(1);
    expect(personas[0]!._id).toBe(personaId);
    expect(personas[0]!.companiaId).toBe(e.companiaA);
    expect(personas[0]!.condominioId).toBe(e.conjunto);
    const eventos = await e.como("adminA").query(api.incidentes.listarEventos, { incidenteId: id, paginationOpts: e.paginar });
    expect(eventos.page[0]!.tipo).toBe("PERSONA_AGREGADA");
    await expect(e.como("adminB").query(api.incidentes.listarPersonas, { incidenteId: id })).rejects.toThrow("compañía");
  });

  test("contrato terminado corta escrituras; admin conserva lectura histórica propia", async () => {
    const id = await e.como("adminA").mutation(api.incidentes.crear, e.datos());
    await e.t.run((ctx) => ctx.db.patch(e.kA, { terminadoEn: Date.now() - 1 }));
    await expect(e.como("adminA").mutation(api.incidentes.crear, e.datos())).rejects.toThrow("contrato");
    await expect(e.como("adminA").mutation(api.incidentes.cambiarPrioridad, { incidenteId: id, prioridad: "ALTA" })).rejects.toThrow("contrato");
    expect((await e.como("adminA").query(api.incidentes.obtener, { incidenteId: id }))._id).toBe(id);
    await expect(e.como("guardaA").query(api.incidentes.obtener, { incidenteId: id })).rejects.toThrow("contrato");
  });

  test("la baja de la asignación corta el acceso del guarda sin borrar el caso", async () => {
    const id = await e.como("guardaA").mutation(api.incidentes.crear, e.datos());
    await e.t.run(async (ctx) => {
      const filas = await ctx.db.query("asignaciones")
        .withIndex("by_user", (q) => q.eq("userId", e.guardaA)).collect();
      await ctx.db.patch(filas[0]!._id, { terminadoEn: Date.now() - 1 });
    });
    await expect(e.como("guardaA").query(api.incidentes.obtener, { incidenteId: id })).rejects.toThrow("permiso");
    await expect(e.como("guardaA").mutation(api.incidentes.crear, e.datos())).rejects.toThrow("permiso");
    expect((await e.como("adminA").query(api.incidentes.obtener, { incidenteId: id }))._id).toBe(id);
  });

  test("suspender la compañía corta su consulta y gestión", async () => {
    const id = await e.como("adminA").mutation(api.incidentes.crear, e.datos());
    await e.t.run((ctx) => ctx.db.patch(e.companiaA, { estado: "suspendida" }));
    await expect(e.como("adminA").query(api.incidentes.obtener, { incidenteId: id })).rejects.toThrow("activa");
    await expect(e.como("adminA").query(api.incidentes.listar, { companiaId: e.companiaA, paginationOpts: e.paginar })).rejects.toThrow("suspendida");
    await expect(e.como("adminA").mutation(api.incidentes.cambiarEstado, { incidenteId: id, estado: "EN_INVESTIGACION" })).rejects.toThrow("activa");
  });
});
