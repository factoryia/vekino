import { paginationOptsValidator, type OrderedQuery, type IndexRangeBuilder, type IndexRange } from "convex/server";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc, DataModel } from "./_generated/dataModel";
import { exigirAccesoCompania, getCompaniaMiembro } from "./model/acceso";
import { hasPlatformRole, requireAppUser } from "./model/authz";
import { exigirAccesoIncidente, exigirIncidente, permisosIncidente, exigirResponsableIncidente } from "./model/incidenteAcceso";
import { logIncidenteEvento, type CambioIncidente } from "./model/incidenteEvento";
import { displayNameFromUser } from "./model/displayName";
import { estadoIncidenteValidator, prioridadIncidenteValidator } from "./model/roles";
import { textoOpcional, textoRequerido, validarTransicion, transicionesIncidente } from "./lib/incidentes";

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
    const user = await requireAppUser(ctx);
    const miembro = await getCompaniaMiembro(ctx, user._id);
    if (!miembro) return null;
    const admin = miembro.roles.includes("admin_compania");
    const relaciones = admin
      ? await ctx.db.query("companiaContratos").withIndex("by_compania", (q) => q.eq("companiaId", miembro.companiaId)).collect()
      : await ctx.db.query("asignaciones").withIndex("by_user", (q) => q.eq("userId", user._id)).collect();
    const conjuntos = [];
    for (const condominioId of new Set(relaciones.filter((r) => r.companiaId === miembro.companiaId).map((r) => r.condominioId))) {
      try {
        await exigirAccesoIncidente(ctx, miembro.companiaId, condominioId, "incidentes.ver");
      } catch { continue; }
      const conjunto = await ctx.db.get(condominioId);
      let crear = false;
      try {
        await exigirAccesoIncidente(ctx, miembro.companiaId, condominioId, "incidentes.crear");
        crear = true;
      } catch { /* Histórico en solo lectura. */ }
      conjuntos.push({ condominioId, condominioNombre: conjunto!.name, crear });
    }
    // Verifica también la compañía cuando no existen relaciones que recorrer.
    if (admin) await exigirAccesoCompania(ctx, miembro.companiaId, "incidentes.ver");
    return { companiaId: miembro.companiaId, todosLosConjuntos: admin, conjuntos };
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

/** Una sola compañía y, para personal asignado, un solo conjunto por página. */
export const listar = query({
  args: {
    companiaId: v.id("companiasSeguridad"),
    condominioId: v.optional(v.id("condominios")),
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
    const acceso = args.condominioId
      ? await exigirAccesoIncidente(ctx, args.companiaId, args.condominioId, "incidentes.ver") : null;
    const reportante = acceso?.rol === "guardia" ? user._id : undefined;
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
      const coincide = c && c.companiaId === args.companiaId && (!args.condominioId || c.condominioId === args.condominioId)
        && (!reportante || c.reportadoPorUserId === reportante) && (!args.estado || c.estado === args.estado)
        && (!args.prioridad || c.prioridad === args.prioridad) && (!args.tipo || c.tipo === args.tipo)
        && (!args.activos || args.estado || (c.estado !== "RESUELTO" && c.estado !== "CERRADO"))
        && (args.desde === undefined || c[fecha] >= args.desde) && (args.hasta === undefined || c[fecha] <= args.hasta);
      return { page: await proyectar(coincide ? [c] : []), isDone: true, continueCursor: "" };
    }
    let consulta: OrderedQuery<DataModel["incidentes"]>;
    if (busqueda) {
      const campo = args.campoBusqueda === "descripcion" ? "descripcion" : "ubicacion";
      consulta = ctx.db.query("incidentes").withSearchIndex(campo === "descripcion" ? "buscar_descripcion" : "buscar_ubicacion", (q) => {
        let filtro = q.search(campo, busqueda).eq("companiaId", args.companiaId);
        if (args.condominioId) filtro = filtro.eq("condominioId", args.condominioId);
        if (reportante) filtro = filtro.eq("reportadoPorUserId", reportante);
        if (args.estado) filtro = filtro.eq("estado", args.estado);
        if (args.prioridad) filtro = filtro.eq("prioridad", args.prioridad);
        if (args.tipo) filtro = filtro.eq("tipo", args.tipo);
        return filtro;
      });
    } else {
      // El rango se aplica al índice de la fecha elegida; nunca se ordena una descarga en cliente.
      const rangoReporte = (q: IndexRange & Omit<IndexRangeBuilder<Doc<"incidentes">, ["reportadoEn"]>, "eq">) => {
        if (args.desde !== undefined && args.hasta !== undefined) return q.gte("reportadoEn", args.desde).lte("reportadoEn", args.hasta);
        if (args.desde !== undefined) return q.gte("reportadoEn", args.desde);
        if (args.hasta !== undefined) return q.lte("reportadoEn", args.hasta);
        return q;
      };
      const rangoHecho = (q: IndexRange & Omit<IndexRangeBuilder<Doc<"incidentes">, ["ocurrioEn"]>, "eq">) => {
        if (args.desde !== undefined && args.hasta !== undefined) return q.gte("ocurrioEn", args.desde).lte("ocurrioEn", args.hasta);
        if (args.desde !== undefined) return q.gte("ocurrioEn", args.desde);
        if (args.hasta !== undefined) return q.lte("ocurrioEn", args.hasta);
        return q;
      };
      // Las ramas explícitas conservan el tipado de los prefijos del índice.
      if (fecha === "ocurrioEn") {
        if (reportante) consulta = ctx.db.query("incidentes").withIndex("by_compania_condominio_reportante_ocurrio", (q) => rangoHecho(q.eq("companiaId", args.companiaId).eq("condominioId", args.condominioId!).eq("reportadoPorUserId", reportante))).order(args.orden ?? "desc");
        else if (args.condominioId) consulta = ctx.db.query("incidentes").withIndex("by_compania_condominio_ocurrio", (q) => rangoHecho(q.eq("companiaId", args.companiaId).eq("condominioId", args.condominioId!))).order(args.orden ?? "desc");
        else consulta = ctx.db.query("incidentes").withIndex("by_compania_ocurrio", (q) => rangoHecho(q.eq("companiaId", args.companiaId))).order(args.orden ?? "desc");
      } else {
        if (reportante) consulta = ctx.db.query("incidentes").withIndex("by_compania_condominio_reportante", (q) => rangoReporte(q.eq("companiaId", args.companiaId).eq("condominioId", args.condominioId!).eq("reportadoPorUserId", reportante))).order(args.orden ?? "desc");
        else if (args.condominioId && args.estado) consulta = ctx.db.query("incidentes").withIndex("by_compania_condominio_estado_reportado", (q) => rangoReporte(q.eq("companiaId", args.companiaId).eq("condominioId", args.condominioId!).eq("estado", args.estado!))).order(args.orden ?? "desc");
        else if (args.condominioId) consulta = ctx.db.query("incidentes").withIndex("by_compania_condominio_reportado", (q) => rangoReporte(q.eq("companiaId", args.companiaId).eq("condominioId", args.condominioId!))).order(args.orden ?? "desc");
        else if (args.estado) consulta = ctx.db.query("incidentes").withIndex("by_compania_estado_reportado", (q) => rangoReporte(q.eq("companiaId", args.companiaId).eq("estado", args.estado!))).order(args.orden ?? "desc");
        else consulta = ctx.db.query("incidentes").withIndex("by_compania_reportado", (q) => rangoReporte(q.eq("companiaId", args.companiaId))).order(args.orden ?? "desc");
      }
    }
    // Todos los criterios se evalúan ANTES de paginar; lectura acotada por solicitud.
    if (args.estado) consulta = consulta.filter((q) => q.eq(q.field("estado"), args.estado!));
    else if (args.activos) consulta = consulta.filter((q) => q.and(q.neq(q.field("estado"), "RESUELTO"), q.neq(q.field("estado"), "CERRADO")));
    if (args.prioridad) consulta = consulta.filter((q) => q.eq(q.field("prioridad"), args.prioridad!));
    if (args.tipo) consulta = consulta.filter((q) => q.eq(q.field("tipo"), args.tipo!));
    if (busqueda && args.desde !== undefined) consulta = consulta.filter((q) => q.gte(q.field(fecha), args.desde!));
    if (busqueda && args.hasta !== undefined) consulta = consulta.filter((q) => q.lte(q.field(fecha), args.hasta!));
    const resultado = await consulta.paginate({ ...args.paginationOpts, numItems: Math.min(args.paginationOpts.numItems, 50), maximumRowsRead: 300, maximumBytesRead: 2_000_000 });
    return { ...resultado, page: await proyectar(resultado.page) };
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
