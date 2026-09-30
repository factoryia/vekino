import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { exigirAccesoCompania, getCompaniaMiembro } from "./model/acceso";
import { asignacionVigente } from "./model/asignacion";
import { hasPlatformRole, requireAppUser } from "./model/authz";
import { exigirAccesoIncidente, exigirIncidente } from "./model/incidenteAcceso";
import { logIncidenteEvento, type CambioIncidente } from "./model/incidenteEvento";
import { displayNameFromUser } from "./model/displayName";
import { estadoIncidenteValidator, prioridadIncidenteValidator } from "./model/roles";
import { textoOpcional, textoRequerido, validarTransicion } from "./lib/incidentes";

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
      await ctx.db.insert("incidentePersonas", {
        incidenteId, companiaId: miembro.companiaId, condominioId: args.condominioId,
        ...persona, createdAt: ahora,
      });
      await logIncidenteEvento(ctx, {
        incidente: { _id: incidenteId, companiaId: miembro.companiaId, condominioId: args.condominioId },
        tipo: "PERSONA_AGREGADA",
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
    const { incidente } = await exigirIncidente(ctx, args.incidenteId, "incidentes.ver");
    const conjunto = await ctx.db.get(incidente.condominioId);
    return { ...incidente, condominioNombre: conjunto?.name ?? "(conjunto no disponible)" };
  },
});

/** Una sola compañía y, para personal asignado, un solo conjunto por página. */
export const listar = query({
  args: {
    companiaId: v.id("companiasSeguridad"),
    condominioId: v.optional(v.id("condominios")),
    estado: v.optional(estadoIncidenteValidator),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const user = await requireAppUser(ctx);
    const miembro = await getCompaniaMiembro(ctx, user._id);
    const plataforma = hasPlatformRole(user, "superadmin", "admin");
    if (!plataforma && (!miembro || miembro.companiaId !== args.companiaId)) {
      throw new Error("No pertenece a esta compañía.");
    }
    const admin = !plataforma && !!miembro?.roles.includes("admin_compania");
    if (admin) await exigirAccesoCompania(ctx, args.companiaId, "incidentes.ver");
    if (plataforma && !(await ctx.db.get(args.companiaId))) throw new Error("Compañía no encontrada.");
    if (!args.condominioId && !admin && !plataforma) {
      throw new Error("Seleccione un conjunto de su asignación.");
    }
    if (args.condominioId) {
      const acceso = await exigirAccesoIncidente(ctx, args.companiaId, args.condominioId, "incidentes.ver");
      if (args.estado) {
        // No se añade índice compuesto hasta que exista un filtro visual que lo use.
        throw new Error("El filtro simultáneo por conjunto y estado aún no está disponible.");
      }
      if (acceso.rol === "guardia") {
        return await ctx.db.query("incidentes")
          .withIndex("by_compania_condominio_reportante", (q) => q
            .eq("companiaId", args.companiaId)
            .eq("condominioId", args.condominioId!)
            .eq("reportadoPorUserId", user._id))
          .order("desc").paginate(args.paginationOpts);
      }
      return await ctx.db.query("incidentes")
        .withIndex("by_compania_condominio_reportado", (q) => q
          .eq("companiaId", args.companiaId).eq("condominioId", args.condominioId!))
        .order("desc").paginate(args.paginationOpts);
    }
    // El staff de plataforma puede consultar una compañía explícita; nunca mezcla tenants.
    if (args.estado) {
      return await ctx.db.query("incidentes")
        .withIndex("by_compania_estado_reportado", (q) => q
          .eq("companiaId", args.companiaId).eq("estado", args.estado!))
        .order("desc").paginate(args.paginationOpts);
    }
    return await ctx.db.query("incidentes")
      .withIndex("by_compania_reportado", (q) => q.eq("companiaId", args.companiaId))
      .order("desc").paginate(args.paginationOpts);
  },
});

export const listarPersonas = query({
  args: { incidenteId: v.id("incidentes") },
  handler: async (ctx, args) => {
    await exigirIncidente(ctx, args.incidenteId, "incidentes.ver");
    return await ctx.db.query("incidentePersonas")
      .withIndex("by_incidente", (q) => q.eq("incidenteId", args.incidenteId))
      .order("asc").collect();
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
    const responsable = await ctx.db.get(args.responsableUserId);
    const miembro = await getCompaniaMiembro(ctx, args.responsableUserId);
    if (!responsable?.active || !miembro || miembro.companiaId !== incidente.companiaId) {
      throw new Error("El responsable debe ser miembro activo de la misma compañía.");
    }
    if (miembro.roles.includes("supervisor")) {
      const via = await asignacionVigente(ctx, responsable._id, incidente.condominioId);
      if (!via || via.asignacion.companiaId !== incidente.companiaId || via.asignacion.rol !== "supervisor") {
        throw new Error("El supervisor no está asignado a este conjunto.");
      }
    } else if (!miembro.roles.includes("admin_compania")) {
      throw new Error("El responsable debe ser administrador o supervisor.");
    }
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

/** Primera operación sobre personas: alta sin edición ni borrado hasta definir ese flujo. */
export const agregarPersona = mutation({
  args: {
    incidenteId: v.id("incidentes"), nombre: v.string(), tipoPersona: v.string(),
    documento: v.optional(v.string()), observacion: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { incidente, user, rol } = await exigirIncidente(ctx, args.incidenteId, "incidentes.ver");
    if (incidente.estado === "CERRADO") throw new Error("El incidente está cerrado.");
    if (rol !== "guardia") {
      await exigirAccesoIncidente(ctx, incidente.companiaId, incidente.condominioId, "incidentes.gestionar");
    }
    const { nombre, tipoPersona, documento, observacion } = validarPersona(args);
    const ahora = Date.now();
    const personaId = await ctx.db.insert("incidentePersonas", {
      incidenteId: incidente._id, companiaId: incidente.companiaId,
      condominioId: incidente.condominioId, nombre, tipoPersona,
      documento, observacion, createdAt: ahora,
    });
    await ctx.db.patch(incidente._id, { updatedAt: ahora });
    await logIncidenteEvento(ctx, { incidente, tipo: "PERSONA_AGREGADA", descripcion: `Persona involucrada agregada: ${nombre}.`, actor: user, ahora });
    return personaId;
  },
});
