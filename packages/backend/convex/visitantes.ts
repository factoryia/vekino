import { v } from "convex/values";
import { query, mutation, internalMutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  requireAppUser,
  getCurrentAppUser,
  getMembership,
  misUnidadIds,
} from "./model/authz";
import { logMinuta } from "./model/minuta";
import {
  diaBogota,
  esVisitanteVigente,
  ventanaDiaBogota,
  ventanaHoyBogota,
} from "./model/visitantes";

const tipoDocValidator = v.union(
  v.literal("CC"),
  v.literal("CE"),
  v.literal("NIT"),
  v.literal("PASAPORTE"),
  v.literal("OTRO"),
);
const tipoValidator = v.union(
  v.literal("visitante"),
  v.literal("empresa"),
  v.literal("domicilio"),
);

/* Las unidades del usuario salen de `misUnidadIds` (`model/authz.ts`): solo
 * vínculos VIGENTES. Aquí había una copia propia sin ese filtro, y una
 * arrendataria con el contrato vencido seguía autorizando visitantes de la
 * casa, que avisan a portería (QA de comprobantes, H3). */

// ─────────────────────────────────────────────────────────────
// API del propietario
// ─────────────────────────────────────────────────────────────

/** Visitantes de las unidades del usuario (autorizados o walk-in pendientes). */
export const listMios = query({
  args: { condominioId: v.id("condominios") },
  handler: async (ctx, args) => {
    const user = await getCurrentAppUser(ctx);
    if (!user) return [];
    const unidadIds = await misUnidadIds(ctx, user._id, args.condominioId);
    if (unidadIds.size === 0) return [];

    const visitantes = await ctx.db
      .query("visitantes")
      .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
      .order("desc")
      .collect();

    const hoy = diaBogota();
    return visitantes
      .filter((vis) => unidadIds.has(vis.unidadId))
      .filter((vis) => {
        // No mostrar autorizaciones QR de días pasados que nunca ingresaron
        // (el cron las borra; filtro por si aún no corrió).
        if (vis.estado === "pendiente" && !vis.registradoPorGuardia) {
          const dia = diaBogota(vis.fechaVisitaInicio ?? vis.createdAt);
          if (dia < hoy) return false;
        }
        if (vis.estado === "rechazado") return false;
        return true;
      })
      .slice(0, 100);
  },
});

/** El propietario autoriza un visitante para UN día (queda pendiente + QR). */
export const crearMio = mutation({
  args: {
    condominioId: v.id("condominios"),
    unidadId: v.id("unidades"),
    nombre: v.string(),
    documento: v.string(),
    tipoDocumento: tipoDocValidator,
    tipo: tipoValidator,
    placa: v.optional(v.string()),
    /** Día de visita YYYY-MM-DD (America/Bogota). Default: hoy. */
    fechaVisita: v.optional(v.string()),
    fechaVisitaInicio: v.optional(v.number()),
    fechaVisitaFin: v.optional(v.number()),
    observaciones: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Id<"visitantes">> => {
    const user = await requireAppUser(ctx);
    const unidadIds = await misUnidadIds(ctx, user._id, args.condominioId);
    if (!unidadIds.has(args.unidadId)) {
      throw new Error("Esa unidad no está vinculada a tu cuenta.");
    }
    const nombre = args.nombre.trim();
    const documento = args.documento.trim();
    if (!nombre || !documento) throw new Error("Nombre y documento son obligatorios.");

    const unidad = await ctx.db.get(args.unidadId);
    const membership = await getMembership(ctx, user._id, args.condominioId);
    const now = Date.now();

    // Día de validez: fechaVisita (ISO), o el día de fechaVisitaInicio, o hoy.
    let fechaISO = args.fechaVisita?.trim();
    if (!fechaISO && args.fechaVisitaInicio) {
      fechaISO = diaBogota(args.fechaVisitaInicio);
    }
    if (!fechaISO) fechaISO = diaBogota(now);

    if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaISO)) {
      throw new Error("Fecha de visita inválida.");
    }
    const hoy = diaBogota(now);
    if (fechaISO < hoy) {
      throw new Error("No puedes autorizar para una fecha pasada.");
    }

    const { inicio, fin } = ventanaDiaBogota(fechaISO);

    await logMinuta(ctx, {
      condominioId: args.condominioId,
      modulo: "visitantes",
      tipo: "Autorización",
      unidad: unidad?.numero ?? "—",
      resumen: `${user.name} autorizó a ${nombre} (${documento}) para el ${fechaISO}.`,
      estado: "cerrado",
      actorUserId: user._id,
      actorNombre: user.name,
    });

    return await ctx.db.insert("visitantes", {
      condominioId: args.condominioId,
      unidadId: args.unidadId,
      unidadNumero: unidad?.numero,
      autorizadoPorUserId: user._id,
      membershipId: membership?._id,
      nombre,
      documento,
      tipoDocumento: args.tipoDocumento,
      tipo: args.tipo,
      placa: args.placa?.toUpperCase().trim() || undefined,
      fechaVisitaInicio: inicio,
      fechaVisitaFin: fin,
      estado: "pendiente",
      observaciones: args.observaciones?.trim() || undefined,
      qrInvalidado: false,
      registradoPorGuardia: false,
      createdAt: now,
      updatedAt: now,
    });
  },
});

/** El propietario elimina una autorización pendiente (o cancela un walk-in). */
export const removeMio = mutation({
  args: { id: v.id("visitantes") },
  handler: async (ctx, args) => {
    const user = await requireAppUser(ctx);
    const vis = await ctx.db.get(args.id);
    if (!vis) throw new Error("Visitante no encontrado.");
    const unidadIds = await misUnidadIds(ctx, user._id, vis.condominioId);
    if (!unidadIds.has(vis.unidadId)) throw new Error("No autorizado.");
    if (vis.estado === "activo") {
      throw new Error("El visitante ya está adentro. La salida la registra portería.");
    }
    await ctx.db.delete(args.id);
  },
});

/** Un visitante puntual (para mostrar el QR después de crear). */
export const getMio = query({
  args: { id: v.id("visitantes") },
  handler: async (ctx, args) => {
    const user = await getCurrentAppUser(ctx);
    if (!user) return null;
    const vis = await ctx.db.get(args.id);
    if (!vis) return null;
    const unidadIds = await misUnidadIds(ctx, user._id, vis.condominioId);
    if (!unidadIds.has(vis.unidadId)) return null;
    const vigencia = esVisitanteVigente(vis);
    return {
      ...vis,
      qrVigente: vigencia.ok && vis.estado === "pendiente",
      qrMensaje: vigencia.ok ? null : vigencia.reason,
    };
  },
});

/**
 * El residente acepta o rechaza un walk-in solicitado por portería.
 * Aceptar = ingreso inmediato (activo + minuta).
 */
export const responderWalkIn = mutation({
  args: { id: v.id("visitantes"), aceptar: v.boolean() },
  handler: async (ctx, args) => {
    const user = await requireAppUser(ctx);
    const vis = await ctx.db.get(args.id);
    if (!vis) throw new Error("Solicitud no encontrada.");
    if (vis.estado !== "esperando_aprobacion") {
      throw new Error("Esta solicitud ya fue respondida.");
    }
    const unidadIds = await misUnidadIds(ctx, user._id, vis.condominioId);
    if (!unidadIds.has(vis.unidadId)) throw new Error("No autorizado.");

    const now = Date.now();
    if (!args.aceptar) {
      await logMinuta(ctx, {
        condominioId: vis.condominioId,
        modulo: "visitantes",
        tipo: "Rechazo",
        unidad: vis.unidadNumero ?? "—",
        resumen: `${user.name} rechazó el ingreso de ${vis.nombre} (${vis.documento}).`,
        estado: "cerrado",
        actorUserId: user._id,
        actorNombre: user.name,
      });
      await ctx.db.delete(args.id);
      return { aceptado: false as const };
    }

    await ctx.db.patch(args.id, {
      estado: "activo",
      fechaIngreso: now,
      autorizadoPorUserId: user._id,
      qrInvalidado: true, // walk-in no usa QR
      updatedAt: now,
    });
    await logMinuta(ctx, {
      condominioId: vis.condominioId,
      modulo: "visitantes",
      tipo: "Ingreso",
      unidad: vis.unidadNumero ?? "—",
      resumen: `${user.name} autorizó ingreso (portería): ${vis.nombre} (${vis.documento})${vis.placa ? ` · placa ${vis.placa}` : ""}.`,
      estado: "abierto",
      actorUserId: user._id,
      actorNombre: user.name,
    });
    return { aceptado: true as const };
  },
});

/**
 * Cron: borra autorizaciones QR (`pendiente`) cuyo día ya pasó sin ingreso.
 * Así no quedan códigos viejos ni listas basura para el propietario.
 */
export const expirarPendientesVencidos = internalMutation({
  args: {},
  handler: async (ctx) => {
    const hoy = diaBogota();
    const todos = await ctx.db.query("visitantes").collect();
    let borrados = 0;
    for (const vis of todos) {
      if (vis.estado !== "pendiente") continue;
      if (vis.registradoPorGuardia) continue;
      const dia = diaBogota(vis.fechaVisitaInicio ?? vis.createdAt);
      if (dia >= hoy) continue;
      await ctx.db.delete(vis._id);
      borrados += 1;
    }
    // Walk-ins sin respuesta por más de 12 h → borrar
    const limite = Date.now() - 12 * 60 * 60 * 1000;
    for (const vis of todos) {
      if (vis.estado !== "esperando_aprobacion") continue;
      if (vis.createdAt > limite) continue;
      await ctx.db.delete(vis._id);
      borrados += 1;
    }
    return { borrados };
  },
});
