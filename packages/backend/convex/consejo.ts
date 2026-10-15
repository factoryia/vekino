import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  requireCondominioRole,
  getMembership,
  hasPlatformRole,
} from "./model/authz";
import { displayNameFromUser } from "./model/displayName";
import {
  carpetaConsejo,
  exigirLlaveDeCarpeta,
  scheduleDeleteS3Keys,
  s3KeyFromPublicUrl,
} from "./model/s3";

function resolveS3Key(
  s3Key: string | null | undefined,
  fileUrl: string | null | undefined,
): string | null {
  return s3Key?.trim() || s3KeyFromPublicUrl(fileUrl) || null;
}

/** Las llaves S3 que usan los documentos del consejo del conjunto y sus versiones. */
async function llavesEnUso(
  ctx: MutationCtx,
  condominioId: Id<"condominios">,
): Promise<Set<string>> {
  const enUso = new Set<string>();
  const docs = await ctx.db
    .query("consejoDocumentos")
    .withIndex("by_condominio", (q) => q.eq("condominioId", condominioId))
    .collect();
  for (const d of docs) {
    const versiones = await ctx.db
      .query("consejoDocumentoVersiones")
      .withIndex("by_documento", (q) => q.eq("documentoId", d._id))
      .collect();
    for (const f of [d, ...versiones]) {
      const key = resolveS3Key(f.s3Key, f.fileUrl);
      if (key) enUso.add(key);
    }
  }
  return enUso;
}

/**
 * Borra los archivos que ya no usa ningún documento ni versión del consejo
 * del conjunto (se llama DESPUÉS de guardar el cambio: una versión
 * restaurada sigue en uso), y solo si son de su carpeta
 * (`scheduleDeleteS3Keys`).
 */
async function borrarArchivosSinUso(
  ctx: MutationCtx,
  condominioId: Id<"condominios">,
  keys: Array<string | null>,
) {
  const enUso = await llavesEnUso(ctx, condominioId);
  await scheduleDeleteS3Keys(
    ctx,
    carpetaConsejo(condominioId),
    keys.filter((k) => k !== null && !enUso.has(k)),
  );
}

const VIEW_ROLES = ["administrador", "contadora", "junta_directiva"] as const;
export const UPLOAD_ROLES = ["administrador", "contadora"] as const;
export const ADMIN_ROLES = ["administrador"] as const;

const cargoValidator = v.union(
  v.literal("presidente"),
  v.literal("vicepresidente"),
  v.literal("secretario"),
  v.literal("tesorero"),
  v.literal("vocal"),
  v.literal("fiscal"),
  v.literal("suplente"),
);

const estadoDocValidator = v.union(
  v.literal("pendiente"),
  v.literal("en_revision"),
  v.literal("aprobado"),
  v.literal("reemplazado"),
);

type Ctx = QueryCtx | MutationCtx;

function slugBase(nombre: string) {
  const base = nombre
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return base || "categoria";
}

async function uniqueSlug(
  ctx: Ctx,
  condominioId: Id<"condominios">,
  nombre: string,
  excludeId?: Id<"consejoCategorias">,
) {
  let slug = slugBase(nombre);
  let n = 0;
  while (true) {
    const found = await ctx.db
      .query("consejoCategorias")
      .withIndex("by_condominio_slug", (q) =>
        q.eq("condominioId", condominioId).eq("slug", slug),
      )
      .unique();
    if (!found || (excludeId && found._id === excludeId)) return slug;
    n += 1;
    slug = `${slugBase(nombre)}-${n}`;
  }
}

async function requireConsejoAccess(
  ctx: Ctx,
  condominioId: Id<"condominios">,
  roles: readonly string[],
) {
  const { user, membership } = await requireCondominioRole(
    ctx,
    condominioId,
    [],
  );
  if (hasPlatformRole(user, "superadmin", "admin")) {
    return { user, membership };
  }
  if (!membership?.isActive) throw new Error("Sin acceso al consejo.");
  const ok = roles.some((r) => membership.roles.includes(r as never));
  if (!ok) throw new Error("Sin permiso para esta acción en el consejo.");
  return { user, membership };
}

export const misPermisos = query({
  args: { condominioId: v.id("condominios") },
  handler: async (ctx, args) => {
    const user = await requireCondominioRole(ctx, args.condominioId, []).then(
      (r) => r.user,
    );
    const membership = await getMembership(ctx, user._id, args.condominioId);
    const roles = membership?.roles ?? [];
    const isPlatform = hasPlatformRole(user, "superadmin", "admin");
    const canView =
      isPlatform || VIEW_ROLES.some((r) => roles.includes(r));
    const canUpload =
      isPlatform || UPLOAD_ROLES.some((r) => roles.includes(r));
    const canManageCategorias =
      isPlatform || ADMIN_ROLES.some((r) => roles.includes(r));
    const canComment =
      isPlatform || VIEW_ROLES.some((r) => roles.includes(r));
    return { canView, canUpload, canManageCategorias, canComment, roles };
  },
});

export const resumen = query({
  args: { condominioId: v.id("condominios") },
  handler: async (ctx, args) => {
    await requireConsejoAccess(ctx, args.condominioId, VIEW_ROLES);
    const docs = await ctx.db
      .query("consejoDocumentos")
      .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
      .collect();
    const cats = await ctx.db
      .query("consejoCategorias")
      .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
      .collect();
    const now = new Date();
    const mes = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    let comentarios = 0;
    for (const d of docs.slice(0, 80)) {
      const cs = await ctx.db
        .query("consejoDocumentoComentarios")
        .withIndex("by_documento", (q) => q.eq("documentoId", d._id))
        .collect();
      comentarios += cs.filter((c) => c.activo).length;
    }
    return {
      documentosEsteMes: docs.filter((d) => d.periodoMes === mes).length,
      totalDocumentos: docs.length,
      totalComentarios: comentarios,
      categoriasActivas: cats.filter((c) => c.activo).length,
    };
  },
});

// ─── Categorías ───────────────────────────────────────────────

export const listCategorias = query({
  args: { condominioId: v.id("condominios") },
  handler: async (ctx, args) => {
    await requireConsejoAccess(ctx, args.condominioId, VIEW_ROLES);
    const cats = await ctx.db
      .query("consejoCategorias")
      .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
      .collect();
    const withCounts = await Promise.all(
      cats.map(async (c) => {
        const docs = await ctx.db
          .query("consejoDocumentos")
          .withIndex("by_categoria", (q) => q.eq("categoriaId", c._id))
          .collect();
        return { ...c, documentosCount: docs.length };
      }),
    );
    return withCounts
      .filter((c) => c.activo)
      .sort((a, b) => a.orden - b.orden || a.nombre.localeCompare(b.nombre));
  },
});

const iconTypeValidator = v.union(
  v.literal("lucide"),
  v.literal("emoji"),
  v.literal("svg"),
  v.literal("image"),
);

function normalizeCategoriaIcon(args: {
  iconType?: "lucide" | "emoji" | "svg" | "image";
  iconValue?: string;
  iconKey?: string;
  colorKey?: string;
}) {
  const iconType = args.iconType ?? "lucide";
  let iconValue = (args.iconValue ?? args.iconKey ?? "folder").trim();
  if (!iconValue) iconValue = "folder";
  if (iconType === "svg") {
    if (iconValue.length > 12_000) {
      throw new Error("El SVG es demasiado grande (máx. ~12 KB).");
    }
    iconValue = iconValue
      .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
      .replace(/<foreignObject[\s\S]*?>[\s\S]*?<\/foreignObject>/gi, "")
      .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
      .replace(/javascript:/gi, "");
    if (!iconValue.toLowerCase().includes("<svg")) {
      throw new Error("El SVG no es válido.");
    }
  }
  if (iconType === "emoji" && iconValue.length > 16) {
    throw new Error("El emoji no es válido.");
  }
  if (iconType === "image") {
    if (!/^https?:\/\//i.test(iconValue) && !iconValue.startsWith("/")) {
      throw new Error("La imagen debe ser una URL válida.");
    }
  }
  return {
    iconType,
    iconValue,
    iconKey: iconType === "lucide" ? iconValue : args.iconKey ?? "folder",
    colorKey: args.colorKey ?? "slate",
  };
}

export const createCategoria = mutation({
  args: {
    condominioId: v.id("condominios"),
    nombre: v.string(),
    iconKey: v.optional(v.string()),
    colorKey: v.optional(v.string()),
    iconType: v.optional(iconTypeValidator),
    iconValue: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireConsejoAccess(ctx, args.condominioId, ADMIN_ROLES);
    const nombre = args.nombre.trim();
    if (!nombre) throw new Error("El nombre es obligatorio.");
    const slug = await uniqueSlug(ctx, args.condominioId, nombre);
    const existing = await ctx.db
      .query("consejoCategorias")
      .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
      .collect();
    const icon = normalizeCategoriaIcon(args);
    const now = Date.now();
    return await ctx.db.insert("consejoCategorias", {
      condominioId: args.condominioId,
      nombre,
      slug,
      ...icon,
      orden: existing.length,
      activo: true,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const updateCategoria = mutation({
  args: {
    id: v.id("consejoCategorias"),
    nombre: v.string(),
    iconKey: v.optional(v.string()),
    colorKey: v.optional(v.string()),
    iconType: v.optional(iconTypeValidator),
    iconValue: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const cat = await ctx.db.get(args.id);
    if (!cat) throw new Error("Categoría no encontrada.");
    await requireConsejoAccess(ctx, cat.condominioId, ADMIN_ROLES);
    const nombre = args.nombre.trim();
    if (!nombre) throw new Error("El nombre es obligatorio.");
    const slug = await uniqueSlug(ctx, cat.condominioId, nombre, args.id);
    const patch: {
      nombre: string;
      slug: string;
      updatedAt: number;
      iconType?: "lucide" | "emoji" | "svg" | "image";
      iconValue?: string;
      iconKey?: string;
      colorKey?: string;
    } = {
      nombre,
      slug,
      updatedAt: Date.now(),
    };
    if (
      args.iconType !== undefined ||
      args.iconValue !== undefined ||
      args.iconKey !== undefined ||
      args.colorKey !== undefined
    ) {
      const icon = normalizeCategoriaIcon({
        iconType: args.iconType ?? cat.iconType,
        iconValue: args.iconValue ?? cat.iconValue ?? cat.iconKey,
        iconKey: args.iconKey ?? cat.iconKey,
        colorKey: args.colorKey ?? cat.colorKey,
      });
      patch.iconType = icon.iconType;
      patch.iconValue = icon.iconValue;
      patch.iconKey = icon.iconKey;
      patch.colorKey = icon.colorKey;
    }
    await ctx.db.patch(args.id, patch);
  },
});

/** Elimina categoría. Con `force` también borra sus documentos y archivos S3. */
export const removeCategoria = mutation({
  args: {
    id: v.id("consejoCategorias"),
    force: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const cat = await ctx.db.get(args.id);
    if (!cat) throw new Error("Categoría no encontrada.");
    await requireConsejoAccess(ctx, cat.condominioId, ADMIN_ROLES);
    const docs = await ctx.db
      .query("consejoDocumentos")
      .withIndex("by_categoria", (q) => q.eq("categoriaId", args.id))
      .collect();
    if (docs.length > 0 && !args.force) {
      throw new Error(
        `La categoría tiene ${docs.length} documento(s). Confirma para eliminarla con todo.`,
      );
    }
    for (const doc of docs) {
      await deleteDocumentoCascade(ctx, doc);
    }
    await ctx.db.delete(args.id);
  },
});

// ─── Documentos ───────────────────────────────────────────────

export const listDocumentos = query({
  args: {
    condominioId: v.id("condominios"),
    categoriaId: v.optional(v.id("consejoCategorias")),
  },
  handler: async (ctx, args) => {
    await requireConsejoAccess(ctx, args.condominioId, VIEW_ROLES);
    let docs: Doc<"consejoDocumentos">[];
    if (args.categoriaId) {
      docs = await ctx.db
        .query("consejoDocumentos")
        .withIndex("by_categoria", (q) => q.eq("categoriaId", args.categoriaId!))
        .collect();
    } else {
      docs = await ctx.db
        .query("consejoDocumentos")
        .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
        .collect();
    }
    const hydrated = await Promise.all(
      docs.map(async (d) => {
        const cat = await ctx.db.get(d.categoriaId);
        const comentarios = await ctx.db
          .query("consejoDocumentoComentarios")
          .withIndex("by_documento", (q) => q.eq("documentoId", d._id))
          .collect();
        return {
          ...d,
          categoriaNombre: cat?.nombre ?? "—",
          comentariosCount: comentarios.filter((c) => c.activo).length,
        };
      }),
    );
    return hydrated.sort((a, b) => b.createdAt - a.createdAt);
  },
});

export const getDocumento = query({
  args: { id: v.id("consejoDocumentos") },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.id);
    if (!doc) return null;
    const { user } = await requireConsejoAccess(
      ctx,
      doc.condominioId,
      VIEW_ROLES,
    );
    const cat = await ctx.db.get(doc.categoriaId);
    const versiones = await ctx.db
      .query("consejoDocumentoVersiones")
      .withIndex("by_documento", (q) => q.eq("documentoId", args.id))
      .collect();
    const comentarios = await ctx.db
      .query("consejoDocumentoComentarios")
      .withIndex("by_documento", (q) => q.eq("documentoId", args.id))
      .collect();
    const activos = comentarios
      .filter((c) => c.activo)
      .sort((a, b) => a.createdAt - b.createdAt);

    const enriched = await Promise.all(
      activos.map(async (c) => {
        const reacciones = await ctx.db
          .query("consejoComentarioReacciones")
          .withIndex("by_comentario", (q) => q.eq("comentarioId", c._id))
          .collect();
        const byEmoji = new Map<string, { count: number; mine: boolean }>();
        for (const r of reacciones) {
          const cur = byEmoji.get(r.emoji) ?? { count: 0, mine: false };
          cur.count += 1;
          if (r.userId === user._id) cur.mine = true;
          byEmoji.set(r.emoji, cur);
        }
        return {
          ...c,
          reacciones: [...byEmoji.entries()].map(([emoji, v]) => ({
            emoji,
            count: v.count,
            mine: v.mine,
          })),
          esMio: c.userId === user._id,
        };
      }),
    );

    return {
      ...doc,
      categoriaNombre: cat?.nombre ?? "—",
      versiones: versiones.sort((a, b) => b.version - a.version),
      comentarios: enriched,
      viewerUserId: user._id as string,
    };
  },
});

export const createDocumento = mutation({
  args: {
    condominioId: v.id("condominios"),
    categoriaId: v.id("consejoCategorias"),
    titulo: v.string(),
    descripcion: v.optional(v.string()),
    periodoMes: v.optional(v.string()),
    fileUrl: v.string(),
    fileName: v.string(),
    mimeType: v.string(),
    sizeBytes: v.number(),
    s3Key: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireConsejoAccess(
      ctx,
      args.condominioId,
      UPLOAD_ROLES,
    );
    const cat = await ctx.db.get(args.categoriaId);
    if (!cat || cat.condominioId !== args.condominioId || !cat.activo) {
      throw new Error("Categoría no válida.");
    }
    const titulo = args.titulo.trim();
    if (!titulo) throw new Error("El título es obligatorio.");
    const s3Key = exigirLlaveDeCarpeta(args.s3Key, carpetaConsejo(args.condominioId));
    const now = Date.now();
    return await ctx.db.insert("consejoDocumentos", {
      condominioId: args.condominioId,
      categoriaId: args.categoriaId,
      titulo,
      descripcion: args.descripcion?.trim(),
      periodoMes: args.periodoMes?.trim(),
      fileUrl: args.fileUrl,
      fileName: args.fileName,
      mimeType: args.mimeType,
      sizeBytes: args.sizeBytes,
      s3Key,
      version: 1,
      estado: "aprobado",
      createdByUserId: user._id,
      createdByNombre: displayNameFromUser(user),
      createdAt: now,
      updatedAt: now,
    });
  },
});

/** Sube una nueva versión: archiva la actual y reemplaza el archivo (v1 → v2…). */
export const nuevaVersion = mutation({
  args: {
    id: v.id("consejoDocumentos"),
    fileUrl: v.string(),
    fileName: v.string(),
    mimeType: v.string(),
    sizeBytes: v.number(),
    s3Key: v.optional(v.string()),
    nota: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.id);
    if (!doc) throw new Error("Documento no encontrado.");
    const { user } = await requireConsejoAccess(
      ctx,
      doc.condominioId,
      UPLOAD_ROLES,
    );
    const s3Key = exigirLlaveDeCarpeta(args.s3Key, carpetaConsejo(doc.condominioId));
    const now = Date.now();
    await ctx.db.insert("consejoDocumentoVersiones", {
      condominioId: doc.condominioId,
      documentoId: doc._id,
      version: doc.version,
      fileUrl: doc.fileUrl,
      fileName: doc.fileName,
      mimeType: doc.mimeType,
      sizeBytes: doc.sizeBytes,
      s3Key: doc.s3Key,
      subidoPorUserId: doc.createdByUserId,
      subidoPorNombre: doc.createdByNombre,
      createdAt: now,
    });
    await ctx.db.patch(doc._id, {
      fileUrl: args.fileUrl,
      fileName: args.fileName,
      mimeType: args.mimeType,
      sizeBytes: args.sizeBytes,
      s3Key,
      version: doc.version + 1,
      estado: "aprobado",
      descripcion: args.nota?.trim()
        ? `${doc.descripcion ? doc.descripcion + "\n" : ""}[v${doc.version + 1}] ${args.nota.trim()}`
        : doc.descripcion,
      createdByUserId: user._id,
      createdByNombre: displayNameFromUser(user),
      updatedAt: now,
    });
    return { version: doc.version + 1 };
  },
});

/** Edita metadatos sin cambiar el archivo. */
export const updateDocumento = mutation({
  args: {
    id: v.id("consejoDocumentos"),
    titulo: v.optional(v.string()),
    descripcion: v.optional(v.string()),
    periodoMes: v.optional(v.string()),
    categoriaId: v.optional(v.id("consejoCategorias")),
  },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.id);
    if (!doc) throw new Error("Documento no encontrado.");
    await requireConsejoAccess(ctx, doc.condominioId, UPLOAD_ROLES);

    if (args.categoriaId) {
      const cat = await ctx.db.get(args.categoriaId);
      if (!cat || cat.condominioId !== doc.condominioId || !cat.activo) {
        throw new Error("Categoría no válida.");
      }
    }

    const titulo =
      args.titulo !== undefined ? args.titulo.trim() : doc.titulo;
    if (!titulo) throw new Error("El título es obligatorio.");

    await ctx.db.patch(args.id, {
      titulo,
      descripcion:
        args.descripcion !== undefined
          ? args.descripcion.trim() || undefined
          : doc.descripcion,
      periodoMes:
        args.periodoMes !== undefined
          ? args.periodoMes.trim() || undefined
          : doc.periodoMes,
      categoriaId: args.categoriaId ?? doc.categoriaId,
      updatedAt: Date.now(),
    });
  },
});

export const setEstadoDocumento = mutation({
  args: {
    id: v.id("consejoDocumentos"),
    estado: estadoDocValidator,
  },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.id);
    if (!doc) throw new Error("Documento no encontrado.");
    await requireConsejoAccess(ctx, doc.condominioId, ADMIN_ROLES);
    await ctx.db.patch(args.id, { estado: args.estado, updatedAt: Date.now() });
  },
});

export const removeDocumento = mutation({
  args: { id: v.id("consejoDocumentos") },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.id);
    if (!doc) throw new Error("Documento no encontrado.");
    await requireConsejoAccess(ctx, doc.condominioId, UPLOAD_ROLES);
    await deleteDocumentoCascade(ctx, doc);
  },
});

/**
 * Borra una versión archivada (historial) o la versión actual.
 * - Archivada: solo elimina esa fila + S3.
 * - Actual: restaura la versión anterior del historial (si existe);
 *   si no hay historial, elimina el documento completo.
 */
export const removeVersion = mutation({
  args: {
    documentoId: v.id("consejoDocumentos"),
    /** Si se omite, borra la versión actual. */
    versionId: v.optional(v.id("consejoDocumentoVersiones")),
  },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.documentoId);
    if (!doc) throw new Error("Documento no encontrado.");
    await requireConsejoAccess(ctx, doc.condominioId, UPLOAD_ROLES);

    // Versión archivada
    if (args.versionId) {
      const ver = await ctx.db.get(args.versionId);
      if (!ver || ver.documentoId !== doc._id) {
        throw new Error("Versión no encontrada.");
      }
      await ctx.db.delete(ver._id);
      await borrarArchivosSinUso(ctx, doc.condominioId, [
        resolveS3Key(ver.s3Key, ver.fileUrl),
      ]);
      return { kind: "archived" as const };
    }

    // Versión actual → restaurar anterior o borrar documento
    const versiones = await ctx.db
      .query("consejoDocumentoVersiones")
      .withIndex("by_documento", (q) => q.eq("documentoId", doc._id))
      .collect();
    versiones.sort((a, b) => b.version - a.version);

    if (versiones.length === 0) {
      await deleteDocumentoCascade(ctx, doc);
      return { kind: "documento" as const };
    }

    const prev = versiones[0]!;
    await ctx.db.patch(doc._id, {
      fileUrl: prev.fileUrl,
      fileName: prev.fileName,
      mimeType: prev.mimeType,
      sizeBytes: prev.sizeBytes,
      s3Key: prev.s3Key,
      version: prev.version,
      createdByUserId: prev.subidoPorUserId,
      createdByNombre: prev.subidoPorNombre,
      updatedAt: Date.now(),
    });
    await ctx.db.delete(prev._id);
    await borrarArchivosSinUso(ctx, doc.condominioId, [
      resolveS3Key(doc.s3Key, doc.fileUrl),
    ]);
    return { kind: "restored" as const, version: prev.version };
  },
});

async function deleteDocumentoCascade(
  ctx: MutationCtx,
  doc: Doc<"consejoDocumentos">,
) {
  const versiones = await ctx.db
    .query("consejoDocumentoVersiones")
    .withIndex("by_documento", (q) => q.eq("documentoId", doc._id))
    .collect();
  const comentarios = await ctx.db
    .query("consejoDocumentoComentarios")
    .withIndex("by_documento", (q) => q.eq("documentoId", doc._id))
    .collect();
  for (const c of comentarios) {
    const reacciones = await ctx.db
      .query("consejoComentarioReacciones")
      .withIndex("by_comentario", (q) => q.eq("comentarioId", c._id))
      .collect();
    for (const r of reacciones) await ctx.db.delete(r._id);
    await ctx.db.delete(c._id);
  }
  for (const v of versiones) await ctx.db.delete(v._id);
  await ctx.db.delete(doc._id);
  await borrarArchivosSinUso(ctx, doc.condominioId, [
    resolveS3Key(doc.s3Key, doc.fileUrl),
    ...versiones.map((v) => resolveS3Key(v.s3Key, v.fileUrl)),
  ]);
}

// ─── Comentarios ──────────────────────────────────────────────

const REACCION_EMOJIS = ["👍", "❤️", "😮", "😂"] as const;

export const addComentario = mutation({
  args: {
    documentoId: v.id("consejoDocumentos"),
    contenido: v.string(),
    parentId: v.optional(v.id("consejoDocumentoComentarios")),
  },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.documentoId);
    if (!doc) throw new Error("Documento no encontrado.");
    const { user } = await requireConsejoAccess(
      ctx,
      doc.condominioId,
      VIEW_ROLES,
    );
    const contenido = args.contenido.trim();
    if (!contenido) throw new Error("El comentario no puede estar vacío.");
    if (args.parentId) {
      const parent = await ctx.db.get(args.parentId);
      if (
        !parent ||
        !parent.activo ||
        parent.documentoId !== args.documentoId
      ) {
        throw new Error("El comentario al que respondes no existe.");
      }
      if (parent.parentId) {
        throw new Error("Solo se puede responder al comentario principal.");
      }
    }
    const now = Date.now();
    return await ctx.db.insert("consejoDocumentoComentarios", {
      condominioId: doc.condominioId,
      documentoId: args.documentoId,
      userId: user._id,
      autorNombre: displayNameFromUser(user),
      contenido,
      parentId: args.parentId,
      activo: true,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const updateComentario = mutation({
  args: {
    id: v.id("consejoDocumentoComentarios"),
    contenido: v.string(),
  },
  handler: async (ctx, args) => {
    const c = await ctx.db.get(args.id);
    if (!c || !c.activo) throw new Error("Comentario no encontrado.");
    const { user } = await requireConsejoAccess(
      ctx,
      c.condominioId,
      VIEW_ROLES,
    );
    const isAdmin =
      hasPlatformRole(user, "superadmin", "admin") ||
      (await getMembership(ctx, user._id, c.condominioId))?.roles.includes(
        "administrador",
      );
    if (c.userId !== user._id && !isAdmin) {
      throw new Error("Solo puedes editar tus comentarios.");
    }
    const contenido = args.contenido.trim();
    if (!contenido) throw new Error("El comentario no puede estar vacío.");
    await ctx.db.patch(args.id, { contenido, updatedAt: Date.now() });
  },
});

export const removeComentario = mutation({
  args: { id: v.id("consejoDocumentoComentarios") },
  handler: async (ctx, args) => {
    const c = await ctx.db.get(args.id);
    if (!c || !c.activo) throw new Error("Comentario no encontrado.");
    const { user } = await requireConsejoAccess(
      ctx,
      c.condominioId,
      VIEW_ROLES,
    );
    const membership = await getMembership(ctx, user._id, c.condominioId);
    const isAdmin =
      hasPlatformRole(user, "superadmin", "admin") ||
      membership?.roles.includes("administrador");
    if (c.userId !== user._id && !isAdmin) {
      throw new Error("Solo puedes eliminar tus comentarios.");
    }
    const now = Date.now();
    await ctx.db.patch(args.id, { activo: false, updatedAt: now });
    // Soft-delete respuestas directas
    const replies = await ctx.db
      .query("consejoDocumentoComentarios")
      .withIndex("by_parent", (q) => q.eq("parentId", args.id))
      .collect();
    for (const r of replies) {
      if (r.activo) await ctx.db.patch(r._id, { activo: false, updatedAt: now });
    }
  },
});

export const toggleReaccion = mutation({
  args: {
    comentarioId: v.id("consejoDocumentoComentarios"),
    emoji: v.string(),
  },
  handler: async (ctx, args) => {
    if (!(REACCION_EMOJIS as readonly string[]).includes(args.emoji)) {
      throw new Error("Reacción no válida.");
    }
    const c = await ctx.db.get(args.comentarioId);
    if (!c || !c.activo) throw new Error("Comentario no encontrado.");
    const { user } = await requireConsejoAccess(
      ctx,
      c.condominioId,
      VIEW_ROLES,
    );
    const existing = await ctx.db
      .query("consejoComentarioReacciones")
      .withIndex("by_comentario_user_emoji", (q) =>
        q
          .eq("comentarioId", args.comentarioId)
          .eq("userId", user._id)
          .eq("emoji", args.emoji),
      )
      .unique();
    if (existing) {
      await ctx.db.delete(existing._id);
      return { added: false };
    }
    await ctx.db.insert("consejoComentarioReacciones", {
      condominioId: c.condominioId,
      comentarioId: args.comentarioId,
      userId: user._id,
      emoji: args.emoji,
      createdAt: Date.now(),
    });
    return { added: true };
  },
});

// ─── Miembros (usuarios con rol junta_directiva) ──────────────

export const listMiembros = query({
  args: { condominioId: v.id("condominios") },
  handler: async (ctx, args) => {
    await requireConsejoAccess(ctx, args.condominioId, VIEW_ROLES);
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_condominio", (q) =>
        q.eq("condominioId", args.condominioId),
      )
      .collect();

    const junta = memberships.filter(
      (m) => m.isActive && m.roles.includes("junta_directiva"),
    );

    const rows = await Promise.all(
      junta.map(async (m) => {
        const user = await ctx.db.get(m.userId);
        const links = await ctx.db
          .query("usuarioUnidad")
          .withIndex("by_membership", (q) => q.eq("membershipId", m._id))
          .collect();
        const unidades = (
          await Promise.all(
            links.map(async (link) => {
              const u = await ctx.db.get(link.unidadId);
              if (!u) return null;
              const label = [u.torre ?? u.bloque, u.numero]
                .filter(Boolean)
                .join(" ");
              return label || u.numero;
            }),
          )
        ).filter((x): x is string => Boolean(x));

        return {
          membershipId: m._id,
          userId: m.userId,
          nombre: user ? displayNameFromUser(user) : "—",
          email: user?.email ?? null,
          telefono: user?.telefono ?? null,
          unidades,
          roles: m.roles,
        };
      }),
    );

    return rows.sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
  },
});

/** @deprecated Catálogo manual; preferir rol junta_directiva en Residentes. */
export const createMiembro = mutation({
  args: {
    condominioId: v.id("condominios"),
    nombre: v.string(),
    cargo: cargoValidator,
    unidadNumero: v.optional(v.string()),
    telefono: v.optional(v.string()),
    email: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireConsejoAccess(ctx, args.condominioId, ADMIN_ROLES);
    const now = Date.now();
    return await ctx.db.insert("consejoMiembros", {
      condominioId: args.condominioId,
      nombre: args.nombre.trim(),
      cargo: args.cargo,
      unidadNumero: args.unidadNumero?.trim(),
      telefono: args.telefono?.trim(),
      email: args.email?.trim().toLowerCase(),
      activo: true,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const removeMiembro = mutation({
  args: { id: v.id("consejoMiembros") },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.id);
    if (!existing) throw new Error("Miembro no encontrado.");
    await requireConsejoAccess(ctx, existing.condominioId, ADMIN_ROLES);
    await ctx.db.delete(args.id);
  },
});

export const toggleMiembro = mutation({
  args: { id: v.id("consejoMiembros") },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.id);
    if (!existing) throw new Error("Miembro no encontrado.");
    await requireConsejoAccess(ctx, existing.condominioId, ADMIN_ROLES);
    await ctx.db.patch(args.id, {
      activo: !existing.activo,
      updatedAt: Date.now(),
    });
  },
});

const tipoSesionValidator = v.union(
  v.literal("ordinaria"),
  v.literal("extraordinaria"),
);

export const listSesiones = query({
  args: { condominioId: v.id("condominios") },
  handler: async (ctx, args) => {
    await requireConsejoAccess(ctx, args.condominioId, VIEW_ROLES);
    return await ctx.db
      .query("consejoSesiones")
      .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
      .order("desc")
      .collect();
  },
});

export const createSesion = mutation({
  args: {
    condominioId: v.id("condominios"),
    titulo: v.string(),
    tipo: tipoSesionValidator,
    fecha: v.string(),
    asistentes: v.optional(v.number()),
    temas: v.optional(v.string()),
    acuerdos: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireConsejoAccess(ctx, args.condominioId, ADMIN_ROLES);
    const now = Date.now();
    return await ctx.db.insert("consejoSesiones", {
      condominioId: args.condominioId,
      titulo: args.titulo.trim(),
      tipo: args.tipo,
      fecha: args.fecha,
      asistentes: args.asistentes,
      temas: args.temas?.trim(),
      acuerdos: args.acuerdos?.trim(),
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const removeSesion = mutation({
  args: { id: v.id("consejoSesiones") },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.id);
    if (!existing) throw new Error("Sesión no encontrada.");
    await requireConsejoAccess(ctx, existing.condominioId, ADMIN_ROLES);
    await ctx.db.delete(args.id);
  },
});
