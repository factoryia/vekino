import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  getCurrentAppUser,
  getMembership,
  hasPlatformRole,
  requireAppUser,
  requireCondominioRole,
  requirePlatformStaff,
} from "./model/authz";
import { displayNameFromUser } from "./model/displayName";
import { exigirArchivoSubido } from "./model/registroArchivos";
import type { MutationCtx } from "./_generated/server";

const categoriaValidator = v.union(
  v.literal("factura"),
  v.literal("acceso"),
  v.literal("app"),
  v.literal("otro"),
);

const estadoValidator = v.union(
  v.literal("abierto"),
  v.literal("en_gestion"),
  v.literal("resuelto"),
  v.literal("cerrado"),
);

/**
 * El residente pide ayuda (factura, acceso, app…).
 * Llega al administrador del condominio y a superadmins de plataforma.
 */
const archivoValidator = v.object({
  url: v.string(),
  s3Key: v.optional(v.string()),
  mimeType: v.string(),
  nombre: v.string(),
});

type Adjunto = { url: string; s3Key?: string; mimeType: string; nombre: string };

/**
 * Los adjuntos de un ticket o de su respuesta. Los que ya estaban se
 * conservan como estaban guardados; uno nuevo sale de una subida validada de
 * quien escribe, a la carpeta de soporte del ticket
 * (`soporte/{conjunto}` o `soporte/plataforma`, `model/registroArchivos.ts`).
 */
async function exigirAdjuntosSoporte(
  ctx: MutationCtx,
  userId: Id<"users">,
  archivos: Adjunto[],
  carpeta: string,
  previos: Adjunto[] = [],
): Promise<Adjunto[]> {
  const resultado: Adjunto[] = [];
  for (const a of archivos) {
    const previo = previos.find(
      (p) => p.url === a.url && (p.s3Key ?? undefined) === (a.s3Key ?? undefined),
    );
    if (previo) {
      resultado.push(previo);
      continue;
    }
    await exigirArchivoSubido(ctx, userId, { url: a.url, s3Key: a.s3Key }, carpeta);
    resultado.push(a);
  }
  return resultado;
}

export const crear = mutation({
  args: {
    condominioId: v.optional(v.id("condominios")),
    categoria: categoriaValidator,
    asunto: v.string(),
    mensaje: v.string(),
    /** Capturas o archivos ya subidos a S3 (api.files.generateUploadUrl). */
    archivos: v.optional(v.array(archivoValidator)),
  },
  handler: async (ctx, args) => {
    const user = await requireAppUser(ctx);
    const asunto = args.asunto.trim();
    const mensaje = args.mensaje.trim();
    if (!asunto || !mensaje) throw new Error("Asunto y mensaje son obligatorios.");

    let condominioNombre: string | undefined;
    if (args.condominioId) {
      const condo = await ctx.db.get(args.condominioId);
      if (!condo) throw new Error("Condominio no encontrado.");
      const isPlatform = hasPlatformRole(user, "superadmin", "admin");
      const membership = await getMembership(ctx, user._id, args.condominioId);
      if (!isPlatform && (!membership || !membership.isActive)) {
        throw new Error("No tienes acceso a este condominio.");
      }
      condominioNombre = condo.name;
    }

    const now = Date.now();
    return await ctx.db.insert("soporteTickets", {
      condominioId: args.condominioId,
      condominioNombre,
      userId: user._id,
      userNombre: displayNameFromUser(user),
      userEmail: user.email,
      categoria: args.categoria,
      asunto,
      mensaje,
      archivos: args.archivos?.length
        ? await exigirAdjuntosSoporte(
            ctx,
            user._id,
            args.archivos,
            args.condominioId ? `soporte/${args.condominioId}` : "soporte/plataforma",
          )
        : undefined,
      estado: "abierto",
      createdAt: now,
      updatedAt: now,
    });
  },
});

/** Mis solicitudes de soporte. */
export const listMias = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentAppUser(ctx);
    if (!user) return [];
    return await ctx.db
      .query("soporteTickets")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(50);
  },
});

/** Tickets del condominio (admin / junta). */
export const listByCondominio = query({
  args: { condominioId: v.id("condominios") },
  handler: async (ctx, args) => {
    await requireCondominioRole(ctx, args.condominioId, [
      "administrador",
      "junta_directiva",
    ]);
    return await ctx.db
      .query("soporteTickets")
      .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
      .order("desc")
      .take(100);
  },
});

function etiquetaUnidadSoporte(u: {
  numero: string;
  torre?: string;
  bloque?: string;
}) {
  const partes = [`Unidad ${u.numero}`];
  if (u.torre?.trim()) partes.push(`Torre ${u.torre.trim()}`);
  if (u.bloque?.trim() && u.bloque.trim() !== u.torre?.trim()) {
    partes.push(`Bloque ${u.bloque.trim()}`);
  }
  return partes.join(" · ");
}

/** Unidades del usuario en el condominio del ticket (para la bandeja de soporte). */
async function unidadesDeUsuario(
  ctx: QueryCtx,
  userId: Id<"users">,
  condominioId: Id<"condominios"> | undefined,
) {
  if (!condominioId) return [] as string[];
  const membership = await getMembership(ctx, userId, condominioId);
  if (!membership?.isActive) return [];
  const links = await ctx.db
    .query("usuarioUnidad")
    .withIndex("by_membership", (q) => q.eq("membershipId", membership._id))
    .collect();
  const unidades = await Promise.all(links.map((l) => ctx.db.get(l.unidadId)));
  return unidades
    .filter((u): u is NonNullable<typeof u> => u !== null)
    .map(etiquetaUnidadSoporte)
    .slice(0, 8);
}

/** Todos los tickets (superadmin / admin de plataforma). */
export const listAll = query({
  args: { soloAbiertos: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    await requirePlatformStaff(ctx);
    const rows = await ctx.db.query("soporteTickets").order("desc").take(200);
    const filtrados = args.soloAbiertos
      ? rows.filter((t) => t.estado === "abierto" || t.estado === "en_gestion")
      : rows;

    return await Promise.all(
      filtrados.map(async (t) => ({
        ...t,
        unidadesLabel: (
          await unidadesDeUsuario(ctx, t.userId, t.condominioId)
        ).join(", "),
      })),
    );
  },
});

/** Contador de tickets pendientes (abiertos + en gestión) para el badge del menú. */
export const countPendientes = query({
  args: {},
  handler: async (ctx) => {
    await requirePlatformStaff(ctx);
    const abiertos = await ctx.db
      .query("soporteTickets")
      .withIndex("by_estado", (q) => q.eq("estado", "abierto"))
      .collect();
    const enGestion = await ctx.db
      .query("soporteTickets")
      .withIndex("by_estado", (q) => q.eq("estado", "en_gestion"))
      .collect();
    return abiertos.length + enGestion.length;
  },
});

/** Responder / cambiar estado (admin del condo o plataforma). */
export const responder = mutation({
  args: {
    id: v.id("soporteTickets"),
    respuesta: v.string(),
    estado: v.optional(estadoValidator),
    archivos: v.optional(v.array(archivoValidator)),
  },
  handler: async (ctx, args) => {
    const ticket = await ctx.db.get(args.id);
    if (!ticket) throw new Error("Ticket no encontrado.");
    const user = await requireAppUser(ctx);
    const isPlatform = hasPlatformRole(user, "superadmin", "admin");

    if (!isPlatform) {
      if (!ticket.condominioId) {
        throw new Error("Solo plataforma puede atender tickets sin condominio.");
      }
      await requireCondominioRole(ctx, ticket.condominioId, [
        "administrador",
        "junta_directiva",
      ]);
    }

    const respuesta = args.respuesta.trim();
    const carpetaRespuesta = ticket.condominioId ? `soporte/${ticket.condominioId}` : "soporte/plataforma";
    if (!respuesta) throw new Error("La respuesta es obligatoria.");
    const now = Date.now();
    await ctx.db.patch(args.id, {
      respuesta,
      archivosRespuesta: args.archivos?.length
        ? await exigirAdjuntosSoporte(ctx, user._id, args.archivos, carpetaRespuesta, ticket.archivosRespuesta)
        : undefined,
      estado: args.estado ?? "resuelto",
      respondidoPorUserId: user._id,
      respondidoPorNombre: displayNameFromUser(user),
      respondidoAt: now,
      updatedAt: now,
    });
  },
});

export const setEstado = mutation({
  args: {
    id: v.id("soporteTickets"),
    estado: estadoValidator,
  },
  handler: async (ctx, args) => {
    const ticket = await ctx.db.get(args.id);
    if (!ticket) throw new Error("Ticket no encontrado.");
    const user = await requireAppUser(ctx);
    const isPlatform = hasPlatformRole(user, "superadmin", "admin");
    if (!isPlatform) {
      if (!ticket.condominioId) throw new Error("Sin permiso.");
      await requireCondominioRole(ctx, ticket.condominioId, [
        "administrador",
        "junta_directiva",
      ]);
    }
    await ctx.db.patch(args.id, { estado: args.estado, updatedAt: Date.now() });
  },
});

/**
 * Crea un ticket EN NOMBRE de un usuario ya identificado (bot de WhatsApp).
 * Sin ctx.auth: el bot ya validó la identidad y la membresía del usuario;
 * aquí solo se verifica que el usuario esté activo y que el condominio exista.
 */
export const crearInterno = internalMutation({
  args: {
    userId: v.id("users"),
    condominioId: v.optional(v.id("condominios")),
    categoria: categoriaValidator,
    asunto: v.string(),
    mensaje: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) throw new Error("Usuario no encontrado.");
    if (!user.active) throw new Error("El usuario está inactivo.");

    const asunto = args.asunto.trim();
    const mensaje = args.mensaje.trim();
    if (!asunto || !mensaje) throw new Error("Asunto y mensaje son obligatorios.");

    let condominioNombre: string | undefined;
    if (args.condominioId) {
      const condo = await ctx.db.get(args.condominioId);
      if (!condo) throw new Error("Condominio no encontrado.");
      condominioNombre = condo.name;
    }

    const now = Date.now();
    return await ctx.db.insert("soporteTickets", {
      condominioId: args.condominioId,
      condominioNombre,
      userId: user._id,
      userNombre: displayNameFromUser(user),
      userEmail: user.email,
      categoria: args.categoria,
      asunto,
      mensaje,
      estado: "abierto",
      createdAt: now,
      updatedAt: now,
    });
  },
});
