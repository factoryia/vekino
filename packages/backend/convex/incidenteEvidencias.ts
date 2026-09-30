import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { exigirAgregarIncidente, exigirIncidente, comprobarContextoHijo } from "./model/incidenteAcceso";
import { displayNameFromUser } from "./model/displayName";
import { logIncidenteEvento } from "./model/incidenteEvento";
import { textoRequerido } from "./lib/incidentes";
import { validarArchivoEvidencia } from "./lib/incidenteEvidencias";

export const listar = query({
  args: { incidenteId: v.id("incidentes") },
  handler: async (ctx, args) => {
    const { incidente } = await exigirIncidente(ctx, args.incidenteId, "incidentes.ver");
    const evidencias = await ctx.db.query("incidenteEvidencias")
      .withIndex("by_incidente", (q) => q.eq("incidenteId", incidente._id)).order("desc").collect();
    return evidencias.map((e) => {
      comprobarContextoHijo(e, incidente);
      // Ni clave ni URL en la ficha; el acceso al contenido es una solicitud aparte.
      const { storageKey: _key, ...metadatos } = e;
      return metadatos;
    });
  },
});

/** Solo la action de subida genera la clave y llama a esta preparación. */
export const preparar = internalMutation({
  args: { incidenteId: v.id("incidentes"), objetoId: v.string(), nombre: v.string(), mimeType: v.string(), size: v.number() },
  handler: async (ctx, args) => {
    const { incidente, user } = await exigirAgregarIncidente(ctx, args.incidenteId);
    const datos = validarArchivoEvidencia(args);
    if (!/^[0-9a-f-]{36}$/.test(args.objetoId)) throw new Error("Identificador de objeto inválido.");
    const storageKey = `incidentes/${incidente.companiaId}/${incidente.condominioId}/${incidente._id}/${args.objetoId}`;
    const cargaId = await ctx.db.insert("incidenteEvidenciaCargas", {
      incidenteId: incidente._id, companiaId: incidente.companiaId, condominioId: incidente.condominioId,
      storageKey, ...datos, subidoPorUserId: user._id, subidoPorNombre: displayNameFromUser(user), createdAt: Date.now(),
    });
    return { cargaId, storageKey };
  },
});

/** Tras PutObject exitoso, revalida padre/vigencia/actor. Registro y evento son atómicos. */
export const registrar = internalMutation({
  args: { cargaId: v.id("incidenteEvidenciaCargas") },
  handler: async (ctx, args) => {
    const carga = await ctx.db.get(args.cargaId);
    if (!carga) throw new Error("Carga no encontrada.");
    const { incidente, user } = await exigirAgregarIncidente(ctx, carga.incidenteId);
    comprobarContextoHijo(carga, incidente);
    if (carga.subidoPorUserId !== user._id) throw new Error("La carga pertenece a otro actor.");
    if (carga.evidenciaId) return carga.evidenciaId;
    const ahora = Date.now();
    const evidenciaId = await ctx.db.insert("incidenteEvidencias", {
      incidenteId: incidente._id, companiaId: incidente.companiaId, condominioId: incidente.condominioId,
      storageKey: carga.storageKey, nombre: carga.nombre, mimeType: carga.mimeType, size: carga.size,
      subidoPorUserId: carga.subidoPorUserId, subidoPorNombre: carga.subidoPorNombre, createdAt: ahora,
    });
    await ctx.db.patch(carga._id, { evidenciaId });
    await ctx.db.patch(incidente._id, { updatedAt: ahora });
    await logIncidenteEvento(ctx, { incidente, evidenciaId, tipo: "EVIDENCIA_AGREGADA",
      descripcion: `Evidencia agregada: ${carga.nombre}.`, actor: user, ahora });
    return evidenciaId;
  },
});

/** No es una API por clave: el objeto sale del registro autorizado y su padre. */
export const resolverAcceso = internalQuery({
  args: { evidenciaId: v.id("incidenteEvidencias") },
  handler: async (ctx, args) => {
    const evidencia = await ctx.db.get(args.evidenciaId);
    if (!evidencia) throw new Error("Evidencia no encontrada.");
    const { incidente } = await exigirIncidente(ctx, evidencia.incidenteId, "incidentes.ver");
    comprobarContextoHijo(evidencia, incidente);
    if (evidencia.retiradoEn !== undefined) throw new Error("La evidencia está retirada.");
    validarArchivoEvidencia(evidencia);
    return { storageKey: evidencia.storageKey, nombre: evidencia.nombre, mimeType: evidencia.mimeType, size: evidencia.size };
  },
});

export const retirar = mutation({
  args: { evidenciaId: v.id("incidenteEvidencias"), motivo: v.string() },
  handler: async (ctx, args) => {
    const evidencia = await ctx.db.get(args.evidenciaId);
    if (!evidencia) throw new Error("Evidencia no encontrada.");
    const { incidente, user } = await exigirIncidente(ctx, evidencia.incidenteId, "incidentes.gestionar");
    comprobarContextoHijo(evidencia, incidente);
    if (incidente.estado === "CERRADO") throw new Error("El incidente está cerrado.");
    if (evidencia.retiradoEn !== undefined) throw new Error("La evidencia ya está retirada.");
    const motivo = textoRequerido(args.motivo, "Motivo", 2000);
    const ahora = Date.now();
    await ctx.db.patch(evidencia._id, { retiradoEn: ahora, retiradoPorUserId: user._id,
      retiradoPorNombre: displayNameFromUser(user), motivoRetiro: motivo });
    await ctx.db.patch(incidente._id, { updatedAt: ahora });
    await logIncidenteEvento(ctx, { incidente, evidenciaId: evidencia._id, tipo: "EVIDENCIA_RETIRADA",
      descripcion: `Evidencia retirada: ${evidencia.nombre}.`, motivo, actor: user, ahora });
  },
});
