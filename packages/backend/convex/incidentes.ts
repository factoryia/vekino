import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { getCompaniaMiembro } from "./model/acceso";
import { requireAppUser } from "./model/authz";
import { exigirAccesoIncidente, exigirIncidente, permisosIncidente, exigirResponsableIncidente, exigirAgregarIncidente, comprobarContextoHijo, exigirAlcanceBandeja, obtenerContextoBandeja } from "./model/incidenteAcceso";
import { logIncidenteEvento, type CambioIncidente } from "./model/incidenteEvento";
import { displayNameFromUser } from "./model/displayName";
import { estadoIncidenteValidator, prioridadIncidenteValidator } from "./model/roles";
import { textoOpcional, textoRequerido, validarTransicion, transicionesIncidente } from "./lib/incidentes";

import { consultarIncidentes, coincideFiltrosIncidente } from "./model/incidenteConsulta";
import { obtenerAnaliticaIncidentes } from "./model/incidenteAnalitica";

/** Agregación de la misma lectura autorizada de la bandeja. */
export const dashboard = query({
  args: {
    periodo: v.string(), desde: v.optional(v.string()), hasta: v.optional(v.string()),
    condominioId: v.optional(v.id("condominios")), estado: v.optional(estadoIncidenteValidator),
    activos: v.optional(v.boolean()), prioridad: v.optional(prioridadIncidenteValidator), tipo: v.optional(v.string()),
  },
  handler: (ctx, args) => obtenerAnaliticaIncidentes(ctx, args),
});

/** Mismos filtros, cohorte y métricas; solo proyección operacional autorizada. */
export const reporte = query({
  args: {
    periodo: v.string(), desde: v.optional(v.string()), hasta: v.optional(v.string()),
    condominioId: v.optional(v.id("condominios")), estado: v.optional(estadoIncidenteValidator),
    activos: v.optional(v.boolean()), prioridad: v.optional(prioridadIncidenteValidator), tipo: v.optional(v.string()),
    exportar: v.optional(v.boolean()),
  },
  handler: (ctx, args) => obtenerAnaliticaIncidentes(ctx, args, args.exportar ? "exportacion" : "vista"),
});

const personaInicialValidator = v.object({
  nombre: v.string(),
  tipoPersona: v.string(),
  documento: v.optional(v.string()),
  observacion: v.optional(v.string()),
});

function validarPersona(persona: {
  nombre: string; tipoPersona: string; documento?: string; observacion?: string;
}) {
  return {
    nombre: textoRequerido(persona.nombre, "Nombre", 160),
    tipoPersona: textoRequerido(persona.tipoPersona, "Tipo de persona", 80),
    documento: textoOpcional(persona.documento, "Documento", 80),
    observacion: textoOpcional(persona.observacion, "Observación", 2000),
  };
}

/** La compañía se deduce de la sesión; un guarda propio del conjunto no tiene compañía implícita. */
export const crear = mutation({
  args: {
    condominioId: v.id("condominios"),
    tipo: v.string(),
    ubicacion: v.string(),
    ocurrioEn: v.number(),
    descripcion: v.string(),
    prioridad: prioridadIncidenteValidator,
    personas: v.optional(v.array(personaInicialValidator)),
  },
  handler: async (ctx, args) => {
    const actor = await requireAppUser(ctx);
    const miembro = await getCompaniaMiembro(ctx, actor._id);
    if (!miembro) throw new Error("No pertenece a una compañía de vigilancia.");
    await exigirAccesoIncidente(ctx, miembro.companiaId, args.condominioId, "incidentes.crear");
    const ahora = Date.now();
    if (!Number.isFinite(args.ocurrioEn) || args.ocurrioEn <= 0 || args.ocurrioEn > ahora) {
      throw new Error("La fecha del incidente debe ser válida y no futura.");
    }
    const tipo = textoRequerido(args.tipo, "Tipo", 80);
    const ubicacion = textoRequerido(args.ubicacion, "Ubicación", 200);
    const descripcion = textoRequerido(args.descripcion, "Descripción", 5000);
    const personas = (args.personas ?? []).map(validarPersona);
    const incidenteId = await ctx.db.insert("incidentes", {
      companiaId: miembro.companiaId,
      condominioId: args.condominioId,
      tipo,
      ubicacion,
      ocurrioEn: args.ocurrioEn,
      reportadoEn: ahora,
      reportadoPorUserId: actor._id,
      reportadoPorNombre: displayNameFromUser(actor),
      descripcion,
      prioridad: args.prioridad,
      estado: "REPORTADO",
      createdAt: ahora,
      updatedAt: ahora,
    });
    await logIncidenteEvento(ctx, {
      incidente: { _id: incidenteId, companiaId: miembro.companiaId, condominioId: args.condominioId },
      tipo: "CREACION",
      descripcion: "Incidente reportado.",
      actor,
      ahora,
    });
    // La creación y las personas iniciales forman una única transacción Convex.
    for (const persona of personas) {
      const personaId = await ctx.db.insert("incidentePersonas", {
        incidenteId, companiaId: miembro.companiaId, condominioId: args.condominioId,
        ...persona, createdAt: ahora,
      });
      await logIncidenteEvento(ctx, {
        incidente: { _id: incidenteId, companiaId: miembro.companiaId, condominioId: args.condominioId },
        tipo: "PERSONA_AGREGADA",
        personaId,
        descripcion: `Persona involucrada agregada: ${persona.nombre}.`,
        actor, ahora,
      });
    }
    return incidenteId;
  },
});

export const obtener = query({
  args: { incidenteId: v.id("incidentes") },
  handler: async (ctx, args) => {
    const { incidente, rol } = await exigirIncidente(ctx, args.incidenteId, "incidentes.ver");
    const conjunto = await ctx.db.get(incidente.condominioId);
    const permisos = await permisosIncidente(ctx, incidente, rol);
    return { ...incidente, condominioNombre: conjunto?.name ?? "(conjunto no disponible)", permisos,
      transiciones: transicionesIncidente(incidente.estado, permisos.gestionar, permisos.cerrar) };
  },
});

/** Opciones de ámbito, sin descargar casos ni datos de equipos completos. */
export const contextoBandeja = query({
  args: {},
  handler: async (ctx) => {
    return obtenerContextoBandeja(ctx);
  },
});

export const responsablesDisponibles = query({
  args: { incidenteId: v.id("incidentes") },
  handler: async (ctx, args) => {
    const { incidente } = await exigirIncidente(ctx, args.incidenteId, "incidentes.gestionar");
    if (incidente.estado === "CERRADO") return [];
    const miembros = await ctx.db.query("companiaMiembros")
      .withIndex("by_compania", (q) => q.eq("companiaId", incidente.companiaId)).collect();
    const candidatos = [];
    for (const miembro of miembros) {
      if (!miembro.isActive || !miembro.roles.some((r) => r === "admin_compania" || r === "supervisor")) continue;
      try {
        const user = await exigirResponsableIncidente(ctx, incidente, miembro.userId);
        candidatos.push({ userId: user._id, nombre: displayNameFromUser(user) });
      } catch { /* No cumple la regla existente de vigencia/asignación. */ }
    }
    return candidatos;
  },
});

/** Una sola compañía y únicamente conjuntos/reportantes autorizados. */
export const listar = query({
  args: {
    companiaId: v.id("companiasSeguridad"),
    condominioId: v.optional(v.id("condominios")),
    todosMisConjuntos: v.optional(v.boolean()),
    estado: v.optional(estadoIncidenteValidator),
    prioridad: v.optional(prioridadIncidenteValidator),
    tipo: v.optional(v.string()),
    activos: v.optional(v.boolean()),
    busqueda: v.optional(v.string()),
    campoBusqueda: v.optional(v.union(v.literal("ubicacion"), v.literal("descripcion"), v.literal("referencia"))),
    fecha: v.optional(v.union(v.literal("reportadoEn"), v.literal("ocurrioEn"))),
    desde: v.optional(v.number()),
    hasta: v.optional(v.number()),
    orden: v.optional(v.union(v.literal("asc"), v.literal("desc"))),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const { reportante, ambitos } = await exigirAlcanceBandeja(ctx, args);
    const fecha = args.fecha ?? "reportadoEn";
    if ((args.desde !== undefined && !Number.isFinite(args.desde)) ||
      (args.hasta !== undefined && !Number.isFinite(args.hasta)) ||
      (args.desde !== undefined && args.hasta !== undefined && args.desde > args.hasta)) {
      throw new Error("El rango de fechas no es válido.");
    }
    const busqueda = args.busqueda?.trim();
    if (busqueda && busqueda.length > 200) throw new Error("Búsqueda demasiado larga.");
    // La proyección mantiene la bandeja liviana, sin descripción ni resolución.
    const proyectar = async (casos: Doc<"incidentes">[]) => {
      const nombres = new Map(await Promise.all([...new Set(casos.map((c) => c.condominioId))]
        .map(async (id) => [id, (await ctx.db.get(id))?.name ?? "(conjunto no disponible)"] as const)));
      return casos.map((c) => ({ _id: c._id, tipo: c.tipo, condominioId: c.condominioId,
        condominioNombre: nombres.get(c.condominioId)!, ubicacion: c.ubicacion, prioridad: c.prioridad,
        estado: c.estado, ocurrioEn: c.ocurrioEn, reportadoEn: c.reportadoEn, responsableNombre: c.responsableNombre }));
    };
    if (busqueda && args.campoBusqueda === "referencia") {
      const id = ctx.db.normalizeId("incidentes", busqueda);
      const c = id ? await ctx.db.get(id) : null;
      const coincide = c && coincideFiltrosIncidente(c, args)
        && (!reportante || c.reportadoPorUserId === reportante)
        && (!ambitos || ambitos.some((a) => c.condominioId === a.condominioId && (!a.reportante || c.reportadoPorUserId === a.reportante)));
      return { page: await proyectar(coincide ? [c] : []), isDone: true, continueCursor: "" };
    }
    const consulta = consultarIncidentes(ctx, args, reportante, ambitos);
    const resultado = await consulta.paginate({ ...args.paginationOpts, numItems: Math.min(args.paginationOpts.numItems, 50), maximumRowsRead: 300, maximumBytesRead: 2_000_000 });
    return { ...resultado, page: await proyectar(resultado.page) };
  },
});

export const listarPersonas = query({
  args: { incidenteId: v.id("incidentes") },
  handler: async (ctx, args) => {
    const { incidente } = await exigirIncidente(ctx, args.incidenteId, "incidentes.ver");
    const personas = await ctx.db.query("incidentePersonas")
      .withIndex("by_incidente", (q) => q.eq("incidenteId", args.incidenteId))
      .order("asc").collect();
    for (const persona of personas) comprobarContextoHijo(persona, incidente);
    return personas;
  },
});

export const listarEventos = query({
  args: { incidenteId: v.id("incidentes"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    await exigirIncidente(ctx, args.incidenteId, "incidentes.ver");
    return await ctx.db.query("incidenteEventos")
      .withIndex("by_incidente", (q) => q.eq("incidenteId", args.incidenteId))
      .order("desc").paginate(args.paginationOpts);
  },
});

/** Corrección de datos actuales, conservando la diferencia en el historial. */
export const corregirDatos = mutation({
  args: {
    incidenteId: v.id("incidentes"),
    ubicacion: v.optional(v.string()),
    descripcion: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { incidente, user } = await exigirIncidente(ctx, args.incidenteId, "incidentes.gestionar");
    if (incidente.estado === "CERRADO") throw new Error("El incidente está cerrado.");
    const cambios: CambioIncidente[] = [];
    const patch: Partial<Pick<Doc<"incidentes">, "ubicacion" | "descripcion" | "updatedAt">> = {};
    if (args.ubicacion !== undefined) {
      const nuevo = textoRequerido(args.ubicacion, "Ubicación", 200);
      if (nuevo !== incidente.ubicacion) {
        patch.ubicacion = nuevo;
        cambios.push({ campo: "ubicacion", antes: incidente.ubicacion, despues: nuevo });
      }
    }
    if (args.descripcion !== undefined) {
      const nuevo = textoRequerido(args.descripcion, "Descripción", 5000);
      if (nuevo !== incidente.descripcion) {
        patch.descripcion = nuevo;
        cambios.push({ campo: "descripcion", antes: incidente.descripcion, despues: nuevo });
      }
    }
    if (!cambios.length) throw new Error("No hay cambios que registrar.");
    const ahora = Date.now();
    await ctx.db.patch(incidente._id, { ...patch, updatedAt: ahora });
    await logIncidenteEvento(ctx, { incidente, tipo: "CAMBIO_RELEVANTE", descripcion: "Datos del incidente corregidos.", cambios, actor: user, ahora });
  },
});

export const clasificar = mutation({
  args: { incidenteId: v.id("incidentes"), tipo: v.string() },
  handler: async (ctx, args) => {
    const { incidente, user } = await exigirIncidente(ctx, args.incidenteId, "incidentes.gestionar");
    if (incidente.estado === "CERRADO") throw new Error("El incidente está cerrado.");
    const tipo = textoRequerido(args.tipo, "Tipo", 80);
    if (tipo === incidente.tipo) throw new Error("El tipo no cambió.");
    const ahora = Date.now();
    await ctx.db.patch(incidente._id, { tipo, updatedAt: ahora });
    await logIncidenteEvento(ctx, { incidente, tipo: "CLASIFICACION", descripcion: "Tipo de incidente actualizado.", cambios: [{ campo: "tipo", antes: incidente.tipo, despues: tipo }], actor: user, ahora });
  },
});

export const cambiarPrioridad = mutation({
  args: { incidenteId: v.id("incidentes"), prioridad: prioridadIncidenteValidator },
  handler: async (ctx, args) => {
    const { incidente, user } = await exigirIncidente(ctx, args.incidenteId, "incidentes.gestionar");
    if (incidente.estado === "CERRADO") throw new Error("El incidente está cerrado.");
    if (incidente.prioridad === args.prioridad) throw new Error("La prioridad no cambió.");
    const ahora = Date.now();
    await ctx.db.patch(incidente._id, { prioridad: args.prioridad, updatedAt: ahora });
    await logIncidenteEvento(ctx, { incidente, tipo: "CAMBIO_PRIORIDAD", descripcion: "Prioridad cambiada.", cambios: [{ campo: "prioridad", antes: incidente.prioridad, despues: args.prioridad }], actor: user, ahora });
  },
});

export const asignarResponsable = mutation({
  args: { incidenteId: v.id("incidentes"), responsableUserId: v.id("users") },
  handler: async (ctx, args) => {
    const { incidente, user } = await exigirIncidente(ctx, args.incidenteId, "incidentes.gestionar");
    if (incidente.estado === "CERRADO") throw new Error("El incidente está cerrado.");
    const responsable = await exigirResponsableIncidente(ctx, incidente, args.responsableUserId);
    if (incidente.responsableUserId === responsable._id) throw new Error("El responsable no cambió.");
    const nombre = displayNameFromUser(responsable);
    const ahora = Date.now();
    await ctx.db.patch(incidente._id, { responsableUserId: responsable._id, responsableNombre: nombre, updatedAt: ahora });
    await logIncidenteEvento(ctx, { incidente, tipo: "ASIGNACION", descripcion: `Responsable asignado: ${nombre}.`, cambios: [{ campo: "responsable", antes: incidente.responsableNombre, despues: nombre }], actor: user, ahora });
  },
});

export const cambiarEstado = mutation({
  args: {
    incidenteId: v.id("incidentes"),
    estado: estadoIncidenteValidator,
    motivo: v.optional(v.string()),
    resolucionObservacion: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const capacidad = args.estado === "CERRADO" ? "incidentes.cerrar" : "incidentes.gestionar";
    const { incidente, user } = await exigirIncidente(ctx, args.incidenteId, capacidad);
    const motivo = textoOpcional(args.motivo, "Motivo", 2000);
    const resolucion = textoOpcional(args.resolucionObservacion, "Observación de resolución", 5000);
    if (resolucion && args.estado !== "RESUELTO") {
      throw new Error("La observación de resolución solo corresponde al estado RESUELTO.");
    }
    validarTransicion(incidente.estado, args.estado, motivo, resolucion);
    const ahora = Date.now();
    await ctx.db.patch(incidente._id, {
      estado: args.estado,
      updatedAt: ahora,
      ...(args.estado === "RESUELTO" ? { resueltoEn: ahora, resolucionObservacion: resolucion } : {}),
      ...(incidente.estado === "RESUELTO" && args.estado === "EN_SEGUIMIENTO"
        ? { resueltoEn: undefined, resolucionObservacion: undefined } : {}),
      ...(args.estado === "CERRADO" ? { cerradoEn: ahora } : {}),
    });
    const tipo = args.estado === "RESUELTO" ? "RESOLUCION" : args.estado === "CERRADO" ? "CIERRE" : "CAMBIO_ESTADO";
    await logIncidenteEvento(ctx, {
      incidente, tipo,
      descripcion: args.estado === "RESUELTO" ? resolucion! : motivo ?? `Estado: ${incidente.estado} → ${args.estado}.`,
      cambios: [{ campo: "estado", antes: incidente.estado, despues: args.estado }],
      actor: user, ahora,
    });
  },
});

export const registrarSeguimiento = mutation({
  args: { incidenteId: v.id("incidentes"), observacion: v.string() },
  handler: async (ctx, args) => {
    const { incidente, user } = await exigirIncidente(ctx, args.incidenteId, "incidentes.gestionar");
    if (incidente.estado === "CERRADO") throw new Error("El incidente está cerrado.");
    const observacion = textoRequerido(args.observacion, "Observación", 5000);
    const ahora = Date.now();
    await ctx.db.patch(incidente._id, { updatedAt: ahora });
    await logIncidenteEvento(ctx, { incidente, tipo: "SEGUIMIENTO", descripcion: observacion, actor: user, ahora });
  },
});

/** Alta del caso: datos históricos independientes de una cuenta en users. */
export const agregarPersona = mutation({
  args: {
    incidenteId: v.id("incidentes"), nombre: v.string(), tipoPersona: v.string(),
    documento: v.optional(v.string()), observacion: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { incidente, user } = await exigirAgregarIncidente(ctx, args.incidenteId);
    const { nombre, tipoPersona, documento, observacion } = validarPersona(args);
    const ahora = Date.now();
    const personaId = await ctx.db.insert("incidentePersonas", {
      incidenteId: incidente._id, companiaId: incidente.companiaId,
      condominioId: incidente.condominioId, nombre, tipoPersona,
      documento, observacion, createdAt: ahora,
    });
    await ctx.db.patch(incidente._id, { updatedAt: ahora });
    await logIncidenteEvento(ctx, { incidente, tipo: "PERSONA_AGREGADA", personaId, descripcion: `Persona involucrada agregada: ${nombre}.`, actor: user, ahora });
    return personaId;
  },
});

export const editarPersona = mutation({
  args: { personaId: v.id("incidentePersonas"), nombre: v.string(), tipoPersona: v.string(),
    documento: v.optional(v.string()), observacion: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const persona = await ctx.db.get(args.personaId);
    if (!persona) throw new Error("Persona no encontrada.");
    const { incidente, user } = await exigirIncidente(ctx, persona.incidenteId, "incidentes.gestionar");
    comprobarContextoHijo(persona, incidente);
    if (incidente.estado === "CERRADO") throw new Error("El incidente está cerrado.");
    if (persona.retiradoEn !== undefined) throw new Error("La persona está retirada del caso.");
    // Edición completa: omitir los campos opcionales los vacía, conservando el valor anterior en el evento.
    const datos = validarPersona(args);
    const cambios: CambioIncidente[] = [];
    for (const campo of ["nombre", "tipoPersona", "documento", "observacion"] as const) {
      if (persona[campo] !== datos[campo]) cambios.push({ campo, antes: persona[campo], despues: datos[campo] });
    }
    if (!cambios.length) throw new Error("No hay cambios que registrar.");
    const ahora = Date.now();
    await ctx.db.patch(persona._id, { ...datos, updatedAt: ahora });
    await ctx.db.patch(incidente._id, { updatedAt: ahora });
    await logIncidenteEvento(ctx, { incidente, personaId: persona._id, tipo: "PERSONA_EDITADA",
      descripcion: `Persona involucrada editada: ${datos.nombre}.`, cambios, actor: user, ahora });
  },
});

export const retirarPersona = mutation({
  args: { personaId: v.id("incidentePersonas"), motivo: v.string() },
  handler: async (ctx, args) => {
    const persona = await ctx.db.get(args.personaId);
    if (!persona) throw new Error("Persona no encontrada.");
    const { incidente, user } = await exigirIncidente(ctx, persona.incidenteId, "incidentes.gestionar");
    comprobarContextoHijo(persona, incidente);
    if (incidente.estado === "CERRADO") throw new Error("El incidente está cerrado.");
    if (persona.retiradoEn !== undefined) throw new Error("La persona ya está retirada.");
    const motivo = textoRequerido(args.motivo, "Motivo", 2000);
    const ahora = Date.now();
    await ctx.db.patch(persona._id, { retiradoEn: ahora, retiradoPorUserId: user._id,
      retiradoPorNombre: displayNameFromUser(user), motivoRetiro: motivo, updatedAt: ahora });
    await ctx.db.patch(incidente._id, { updatedAt: ahora });
    await logIncidenteEvento(ctx, { incidente, personaId: persona._id, tipo: "PERSONA_RETIRADA",
      descripcion: `Persona retirada del caso: ${persona.nombre}.`, motivo, actor: user, ahora });
  },
});
