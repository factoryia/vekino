import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { exigirArchivoSubido } from "./model/registroArchivos";
import {
  requireAppUser,
  requireCondominioRole,
  hasPlatformRole,
} from "./model/authz";

const WRITE_ROLES = [
  "administrador",
  "junta_directiva",
  "representante_asamblea",
] as const;

const tipoBitacora = v.union(
  v.literal("entrada"),
  v.literal("salida"),
  v.literal("palabra_pedida"),
  v.literal("palabra_concedida"),
  v.literal("palabra_retirada"),
  v.literal("votacion_abierta"),
  v.literal("votacion_cerrada"),
  v.literal("voto"),
  v.literal("chat"),
  v.literal("reaccion"),
  v.literal("grabacion_inicio"),
  v.literal("grabacion_fin"),
  v.literal("transcripcion_inicio"),
  v.literal("transcripcion_fin"),
  v.literal("presidente_asignado"),
);

export type TipoBitacora =
  | "entrada"
  | "salida"
  | "palabra_pedida"
  | "palabra_concedida"
  | "palabra_retirada"
  | "votacion_abierta"
  | "votacion_cerrada"
  | "voto"
  | "chat"
  | "reaccion"
  | "grabacion_inicio"
  | "grabacion_fin"
  | "transcripcion_inicio"
  | "transcripcion_fin"
  | "presidente_asignado";

/** Etiqueta legible para exportar / mostrar la bitácora. */
export function etiquetaBitacora(tipo: TipoBitacora): string {
  switch (tipo) {
    case "entrada":
      return "Entró";
    case "salida":
      return "Salió";
    case "palabra_pedida":
      return "Pidió la palabra";
    case "palabra_concedida":
      return "Palabra concedida";
    case "palabra_retirada":
      return "Palabra retirada";
    case "votacion_abierta":
      return "Votación abierta";
    case "votacion_cerrada":
      return "Votación cerrada";
    case "voto":
      return "Votó";
    case "chat":
      return "Chat";
    case "reaccion":
      return "Reacción";
    case "grabacion_inicio":
      return "Grabación iniciada";
    case "grabacion_fin":
      return "Grabación finalizada";
    case "transcripcion_inicio":
      return "Transcripción iniciada";
    case "transcripcion_fin":
      return "Transcripción finalizada";
    case "presidente_asignado":
      return "Presidente";
    default:
      return tipo;
  }
}

/** Inserta un evento de bitácora (uso interno desde otras mutaciones). */
export async function registrarBitacora(
  ctx: MutationCtx,
  args: {
    condominioId: Id<"condominios">;
    asambleaId: Id<"asambleas">;
    tipo: TipoBitacora;
    nombre: string;
    detalle?: string;
    userId?: Id<"users">;
  },
) {
  await ctx.db.insert("salaBitacora", {
    condominioId: args.condominioId,
    asambleaId: args.asambleaId,
    tipo: args.tipo,
    nombre: args.nombre,
    detalle: args.detalle,
    userId: args.userId,
    createdAt: Date.now(),
  });
}

async function esMesa(
  ctx: MutationCtx,
  condominioId: Id<"condominios">,
  user: { _id: Id<"users">; platformRole?: string | null },
) {
  if (hasPlatformRole(user as never, "superadmin", "admin")) return true;
  try {
    await requireCondominioRole(ctx, condominioId, [...WRITE_ROLES]);
    return true;
  } catch {
    return false;
  }
}

/** Eventos de la reunión (mesa y residentes del condominio). */
export const listar = query({
  args: { asambleaId: v.id("asambleas") },
  handler: async (ctx, args) => {
    const asamblea = await ctx.db.get(args.asambleaId);
    if (!asamblea) return [];
    await requireCondominioRole(ctx, asamblea.condominioId, []);
    /* Las ÚLTIMAS 150, no las 2.000.
     *
     * La mesa tiene esto suscrito en vivo, y la bitácora se escribe con cada
     * mensaje de chat y con cada desconexión de wifi. Releer 2.000 filas en
     * cada escritura, por cada miembro de la mesa, era 3,5 GB en una sola
     * asamblea para enseñar una lista de la que solo se mira el final.
     *
     * El registro completo sigue intacto en la tabla y el acta lo lee entero
     * (acta.ts): no se pierde nada con valor probatorio. */
    const recientes = await ctx.db
      .query("salaBitacora")
      .withIndex("by_asamblea_created", (q) =>
        q.eq("asambleaId", args.asambleaId),
      )
      .order("desc")
      .take(150);
    const filas = recientes.reverse();
    return filas.map((f) => ({
      _id: f._id,
      tipo: f.tipo,
      nombre: f.nombre,
      detalle: f.detalle ?? null,
      createdAt: f.createdAt,
    }));
  },
});

/** ¿Hay grabación activa? (badge para todos). */
export const grabacionActiva = query({
  args: { asambleaId: v.id("asambleas") },
  handler: async (ctx, args) => {
    const asamblea = await ctx.db.get(args.asambleaId);
    if (!asamblea) return null;
    try {
      await requireCondominioRole(ctx, asamblea.condominioId, []);
    } catch {
      return null;
    }
    const activa = await ctx.db
      .query("salaGrabacion")
      .withIndex("by_asamblea", (q) => q.eq("asambleaId", args.asambleaId))
      .filter((q) => q.eq(q.field("estado"), "activa"))
      .first();
    if (!activa) return null;
    return {
      iniciadaPorNombre: activa.iniciadaPorNombre,
      startedAt: activa.startedAt,
    };
  },
});

/** La mesa marca el inicio de la grabación local. */
export const iniciarGrabacion = mutation({
  args: { asambleaId: v.id("asambleas") },
  handler: async (ctx, args) => {
    const asamblea = await ctx.db.get(args.asambleaId);
    if (!asamblea) throw new Error("Asamblea no encontrada.");
    if (asamblea.estado !== "en_curso") {
      throw new Error("La sala no está abierta.");
    }
    const user = await requireAppUser(ctx);
    if (!(await esMesa(ctx, asamblea.condominioId, user))) {
      throw new Error("Solo la mesa puede grabar.");
    }
    const previas = await ctx.db
      .query("salaGrabacion")
      .withIndex("by_asamblea", (q) => q.eq("asambleaId", args.asambleaId))
      .filter((q) => q.eq(q.field("estado"), "activa"))
      .collect();
    const ahora = Date.now();
    for (const p of previas) {
      await ctx.db.patch(p._id, { estado: "terminada", endedAt: ahora });
    }
    await ctx.db.insert("salaGrabacion", {
      condominioId: asamblea.condominioId,
      asambleaId: args.asambleaId,
      iniciadaPorUserId: user._id,
      iniciadaPorNombre: user.name,
      estado: "activa",
      startedAt: ahora,
    });
    await registrarBitacora(ctx, {
      condominioId: asamblea.condominioId,
      asambleaId: args.asambleaId,
      tipo: "grabacion_inicio",
      nombre: user.name,
      detalle: "Grabación de la reunión iniciada (video + audio)",
      userId: user._id,
    });
    return { ok: true as const };
  },
});

/** La mesa marca el fin de la grabación local. */
export const detenerGrabacion = mutation({
  args: { asambleaId: v.id("asambleas") },
  handler: async (ctx, args) => {
    const asamblea = await ctx.db.get(args.asambleaId);
    if (!asamblea) throw new Error("Asamblea no encontrada.");
    const user = await requireAppUser(ctx);
    if (!(await esMesa(ctx, asamblea.condominioId, user))) {
      throw new Error("Solo la mesa puede grabar.");
    }
    const ahora = Date.now();
    const activas = await ctx.db
      .query("salaGrabacion")
      .withIndex("by_asamblea", (q) => q.eq("asambleaId", args.asambleaId))
      .filter((q) => q.eq(q.field("estado"), "activa"))
      .collect();
    for (const a of activas) {
      await ctx.db.patch(a._id, { estado: "terminada", endedAt: ahora });
    }
    await registrarBitacora(ctx, {
      condominioId: asamblea.condominioId,
      asambleaId: args.asambleaId,
      tipo: "grabacion_fin",
      nombre: user.name,
      detalle: "Grabación de la reunión detenida",
      userId: user._id,
    });
    return { ok: true as const };
  },
});

/**
 * Anota un trozo de grabación ya subido a S3.
 *
 * El archivo lo sube el navegador directo a S3; aquí solo queda el apunte de
 * dónde está y en qué orden va. Sin el orden no hay grabación: un WebM se
 * reconstruye concatenando los trozos en secuencia, y el primero es el único
 * que lleva la cabecera.
 */
export const anotarParteGrabacion = mutation({
  args: {
    asambleaId: v.id("asambleas"),
    sesionGrabacion: v.string(),
    orden: v.number(),
    url: v.string(),
    bytes: v.number(),
  },
  handler: async (ctx, args) => {
    const user = await requireAppUser(ctx);
    const asamblea = await ctx.db.get(args.asambleaId);
    if (!asamblea) throw new Error("Asamblea no encontrada.");
    /* Solo la mesa graba (`iniciarGrabacion`), y cada parte sale de una
     * subida validada suya a la carpeta de ESTA asamblea: nadie mete en la
     * grabación de otra asamblea un archivo ajeno o una URL cualquiera. */
    await requireCondominioRole(ctx, asamblea.condominioId, [...WRITE_ROLES]);
    await exigirArchivoSubido(ctx, user._id, { url: args.url }, `asambleas/${args.asambleaId}/grabacion`);

    await ctx.db.insert("salaGrabacionPartes", {
      condominioId: asamblea.condominioId,
      asambleaId: args.asambleaId,
      grabadorUserId: user._id,
      sesionGrabacion: args.sesionGrabacion,
      orden: args.orden,
      url: args.url,
      bytes: args.bytes,
      createdAt: Date.now(),
    });
    return null;
  },
});

/**
 * Las grabaciones que hay de una asamblea, agrupadas por sesión.
 *
 * Se agrupan porque puede haber VARIAS a la vez —y conviene que las haya: si
 * graban el administrador y la secretaria, que se caiga un portátil deja de
 * ser un problema. Cada grupo se descarga concatenando sus trozos en orden.
 */
export const grabacionesDeAsamblea = query({
  args: { asambleaId: v.id("asambleas") },
  handler: async (ctx, args) => {
    const asamblea = await ctx.db.get(args.asambleaId);
    if (!asamblea) return [];
    await requireCondominioRole(ctx, asamblea.condominioId, []);

    const partes = await ctx.db
      .query("salaGrabacionPartes")
      .withIndex("by_asamblea", (q) => q.eq("asambleaId", args.asambleaId))
      .collect();

    const porSesion = new Map<
      string,
      { grabador: string; partes: { orden: number; url: string }[]; bytes: number }
    >();
    for (const p of partes) {
      const g = porSesion.get(p.sesionGrabacion) ?? {
        grabador: "",
        partes: [],
        bytes: 0,
      };
      g.partes.push({ orden: p.orden, url: p.url });
      g.bytes += p.bytes;
      porSesion.set(p.sesionGrabacion, g);
    }

    const salida = [];
    for (const [sesion, g] of porSesion) {
      const primera = partes.find((p) => p.sesionGrabacion === sesion);
      const u = primera ? await ctx.db.get(primera.grabadorUserId) : null;
      salida.push({
        sesion,
        grabador: u?.name ?? "—",
        bytes: g.bytes,
        partes: g.partes.sort((a, b) => a.orden - b.orden),
      });
    }
    return salida;
  },
});
