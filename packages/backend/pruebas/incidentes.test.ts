import { beforeEach, describe, expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

import { montar } from "./helpers/incidentes";
const DIA = 24 * 60 * 60 * 1000;

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

  test("bandeja combina conjunto, estado, prioridad, tipo y rango antes de paginar", async () => {
    const admin = e.como("adminA");
    const id = await admin.mutation(api.incidentes.crear, { ...e.datos(), prioridad: "ALTA" });
    await admin.mutation(api.incidentes.cambiarEstado, { incidenteId: id, estado: "EN_INVESTIGACION" });
    await admin.mutation(api.incidentes.crear, e.datos());
    await admin.mutation(api.incidentes.crear, { ...e.datos(), prioridad: "ALTA", tipo: "OTRO" });
    await e.como("adminB").mutation(api.incidentes.crear, { ...e.datos(), prioridad: "ALTA" });
    const filtros = { companiaId: e.companiaA, condominioId: e.conjunto, estado: "EN_INVESTIGACION" as const,
      prioridad: "ALTA" as const, tipo: "ACCESO", fecha: "ocurrioEn" as const, desde: Date.now() - DIA, hasta: Date.now(), paginationOpts: { cursor: null, numItems: 1 } };
    const pagina = await admin.query(api.incidentes.listar, filtros);
    expect(pagina.page.map((c) => c._id)).toEqual([id]);
    expect(pagina.page[0]).not.toHaveProperty("descripcion");
    expect(pagina.page[0]?.condominioNombre).toBe("Conjunto compartido");
    expect((await admin.query(api.incidentes.listar, { ...filtros, prioridad: "CRITICA" })).page).toEqual([]);
    await expect(admin.query(api.incidentes.listar, { ...filtros, desde: Date.now(), hasta: 1 })).rejects.toThrow("rango");
  });

  test("búsqueda indexada de ubicación/descripción y referencia respetan tenant y filtros", async () => {
    const a = await e.como("guardaA").mutation(api.incidentes.crear, e.datos());
    const b = await e.como("adminB").mutation(api.incidentes.crear, e.datos());
    for (const [campoBusqueda, busqueda] of [["ubicacion", "Portería"], ["descripcion", "autorizado"], ["referencia", a]] as const) {
      const respuesta = await e.como("adminA").query(api.incidentes.listar, { companiaId: e.companiaA, condominioId: e.conjunto,
        campoBusqueda, busqueda, estado: "REPORTADO", prioridad: "MEDIA", tipo: "ACCESO", desde: Date.now() - DIA, hasta: Date.now(), paginationOpts: e.paginar });
      expect(respuesta.page.map((c) => c._id)).toEqual([a]);
    }
    const porId = { companiaId: e.companiaA, campoBusqueda: "referencia" as const, busqueda: b, paginationOpts: e.paginar };
    expect((await e.como("adminA").query(api.incidentes.listar, porId)).page).toEqual([]);
    expect((await e.como("adminA").query(api.incidentes.listar, { ...porId, busqueda: a, prioridad: "ALTA" })).page).toEqual([]);
    const otroDeA = await e.como("adminA").mutation(api.incidentes.crear, e.datos());
    const propios = await e.como("guardaA").query(api.incidentes.listar, { ...porId, condominioId: e.conjunto, campoBusqueda: "ubicacion", busqueda: "Portería" });
    expect(propios.page.map((c) => c._id)).toEqual([a]);
    expect((await e.como("guardaA").query(api.incidentes.listar, { ...porId, condominioId: e.conjunto, busqueda: otroDeA })).page).toEqual([]);
  });

  test("páginas, orden de fechas y filtros no mezclan compañías del mismo conjunto", async () => {
    const propios = [];
    for (let i = 0; i < 5; i++) {
      propios.push(await e.como("adminA").mutation(api.incidentes.crear, { ...e.datos(), ocurrioEn: Date.now() - (i + 1) * DIA }));
      await e.como("adminB").mutation(api.incidentes.crear, e.datos());
    }
    const recibidos = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const pagina = await e.como("supervisorA").query(api.incidentes.listar, { companiaId: e.companiaA, condominioId: e.conjunto,
        estado: "REPORTADO", fecha: "ocurrioEn", orden: "asc", paginationOpts: { cursor, numItems: 2 } });
      recibidos.push(...pagina.page.map((c) => c._id));
      if (pagina.isDone) break;
      cursor = pagina.continueCursor;
    }
    expect(recibidos).toEqual([...propios].reverse());
    expect(new Set(recibidos).size).toBe(5);
    await expect(e.como("supervisorA").query(api.incidentes.listar, { companiaId: e.companiaA, paginationOpts: e.paginar })).rejects.toThrow("Seleccione");
    await expect(e.como("supervisorA").query(api.incidentes.listar, { companiaId: e.companiaA, condominioId: e.ajeno, paginationOpts: e.paginar })).rejects.toThrow("contrato");
  });

  test("vacío, sin coincidencias y vista activa frente a histórico", async () => {
    const consulta = { companiaId: e.companiaA, paginationOpts: e.paginar };
    expect((await e.como("adminA").query(api.incidentes.listar, consulta)).page).toEqual([]);
    const id = await e.como("adminA").mutation(api.incidentes.crear, e.datos());
    expect((await e.como("adminA").query(api.incidentes.listar, { ...consulta, prioridad: "CRITICA" })).page).toEqual([]);
    for (const estado of ["EN_INVESTIGACION", "EN_SEGUIMIENTO", "RESUELTO"] as const) {
      await e.como("adminA").mutation(api.incidentes.cambiarEstado, { incidenteId: id, estado, ...(estado === "RESUELTO" ? { resolucionObservacion: "Controlado" } : {}) });
    }
    expect((await e.como("adminA").query(api.incidentes.listar, { ...consulta, activos: true })).page).toEqual([]);
    expect((await e.como("adminA").query(api.incidentes.listar, consulta)).page.map((c) => c._id)).toEqual([id]);
  });

  test("filtros selectivos mantienen un cursor al alcanzar el límite de lectura", async () => {
    const id = await e.como("adminA").mutation(api.incidentes.crear, { ...e.datos(), prioridad: "CRITICA" });
    await e.t.run(async (ctx) => {
      const c = await ctx.db.get(id);
      const { _id, _creationTime, ...datos } = c!;
      for (let i = 0; i < 310; i++) await ctx.db.insert("incidentes", { ...datos, prioridad: "BAJA", reportadoEn: datos.reportadoEn + i + 1 });
    });
    const args = { companiaId: e.companiaA, prioridad: "CRITICA" as const, paginationOpts: { cursor: null as string | null, numItems: 20 } };
    const primera = await e.como("adminA").query(api.incidentes.listar, args);
    expect(primera.isDone).toBe(false);
    expect(primera.continueCursor).toBeTruthy();
    const segunda = await e.como("adminA").query(api.incidentes.listar, { ...args, paginationOpts: { ...args.paginationOpts, cursor: primera.continueCursor } });
    expect([...primera.page, ...segunda.page].map((c) => c._id)).toEqual([id]);
  });

  test("ficha expone solo transiciones permitidas y permisos vigentes", async () => {
    const id = await e.como("guardaA").mutation(api.incidentes.crear, e.datos());
    const caso = (actor: string) => e.como(actor).query(api.incidentes.obtener, { incidenteId: id });
    expect((await caso("guardaA")).permisos).toMatchObject({ gestionar: false, cerrar: false, agregarPersona: true });
    expect((await caso("guardaA")).transiciones).toEqual([]);
    expect((await caso("supervisorA")).transiciones).toEqual(["EN_INVESTIGACION"]);
    for (const estado of ["EN_INVESTIGACION", "EN_SEGUIMIENTO", "RESUELTO"] as const) {
      await e.como("adminA").mutation(api.incidentes.cambiarEstado, { incidenteId: id, estado, ...(estado === "RESUELTO" ? { resolucionObservacion: "Controlado" } : {}) });
    }
    expect((await caso("supervisorA")).transiciones).toEqual(["EN_SEGUIMIENTO"]);
    expect((await caso("adminA")).transiciones).toEqual(["EN_SEGUIMIENTO", "CERRADO"]);
    await e.como("adminA").mutation(api.incidentes.cambiarEstado, { incidenteId: id, estado: "CERRADO" });
    expect((await caso("adminA")).transiciones).toEqual([]);
    expect((await caso("adminA")).permisos.agregarPersona).toBe(false);
  });

  test("contexto y responsables elegibles excluyen usuarios ajenos y asignaciones vencidas", async () => {
    const id = await e.como("guardaA").mutation(api.incidentes.crear, e.datos());
    const contexto = await e.como("supervisorA").query(api.incidentes.contextoBandeja, {});
    expect(contexto?.conjuntos.map((c) => c.condominioId)).toEqual([e.conjunto]);
    expect(contexto?.todosLosConjuntos).toBe(false);
    const disponibles = await e.como("adminA").query(api.incidentes.responsablesDisponibles, { incidenteId: id });
    expect(disponibles.map((u) => u.userId).sort()).toEqual([e.adminA, e.supervisorA].sort());
    await expect(e.como("adminB").query(api.incidentes.responsablesDisponibles, { incidenteId: id })).rejects.toThrow("compañía");
    await expect(e.como("guardaA").query(api.incidentes.responsablesDisponibles, { incidenteId: id })).rejects.toThrow("permiso");
    await e.t.run(async (ctx) => {
      const asignaciones = await ctx.db.query("asignaciones").withIndex("by_user", (q) => q.eq("userId", e.supervisorA)).collect();
      await ctx.db.patch(asignaciones[0]!._id, { terminadoEn: Date.now() - 1 });
    });
    expect((await e.como("adminA").query(api.incidentes.responsablesDisponibles, { incidenteId: id })).map((u) => u.userId)).toEqual([e.adminA]);
    expect((await e.como("supervisorA").query(api.incidentes.contextoBandeja, {}))?.conjuntos).toEqual([]);
    await e.t.run((ctx) => ctx.db.patch(e.kA, { terminadoEn: Date.now() - 1 }));
    expect((await e.como("adminA").query(api.incidentes.contextoBandeja, {}))?.conjuntos[0]?.crear).toBe(false);
    expect((await e.como("adminA").query(api.incidentes.obtener, { incidenteId: id })).permisos.gestionar).toBe(false);
  });

  test("seguimiento conserva descripción y atribuye actor/hora del servidor", async () => {
    const id = await e.como("adminA").mutation(api.incidentes.crear, e.datos());
    const antes = Date.now();
    await e.como("supervisorA").mutation(api.incidentes.registrarSeguimiento, { incidenteId: id, observacion: "Revisión de cámaras" });
    const despues = Date.now();
    const eventos = await e.como("adminA").query(api.incidentes.listarEventos, { incidenteId: id, paginationOpts: e.paginar });
    expect(eventos.page[0]).toMatchObject({ tipo: "SEGUIMIENTO", actorUserId: e.supervisorA, actorNombre: "Sofia Andina", descripcion: "Revisión de cámaras" });
    expect(eventos.page[0]!.createdAt).toBeGreaterThanOrEqual(antes);
    expect(eventos.page[0]!.createdAt).toBeLessThanOrEqual(despues);
    expect((await e.como("adminA").query(api.incidentes.obtener, { incidenteId: id })).descripcion).toBe(e.datos().descripcion);
    await expect(e.como("adminB").mutation(api.incidentes.registrarSeguimiento, { incidenteId: id, observacion: "Ajeno" })).rejects.toThrow("compañía");
    await expect(e.como("supervisorA").mutation(api.incidentes.registrarSeguimiento, { incidenteId: id, observacion: " " })).rejects.toThrow("Observación");
  });
});
