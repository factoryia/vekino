import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { query, mutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireCondominioRole } from "./model/authz";
import { exigirStorageIdDelRegistro, resolveMediaUrl } from "./model/files";
import { exigirArchivoSubido } from "./model/registroArchivos";
import {
  carpetaDocumentos,
  exigirLlaveDeCarpeta,
  llaveDeArchivo,
  scheduleDeleteS3Keys,
} from "./model/s3";

export const ADMIN_ROLES = ["administrador", "junta_directiva", "contadora"] as const;

const categoriaValidator = v.union(
  v.literal("reglamento"),
  v.literal("acta"),
  v.literal("contrato"),
  v.literal("comunicado"),
  v.literal("financiero"),
  v.literal("otro")
);

/**
 * @deprecated Usar `api.files.generateUploadUrl` (S3).
 * Se mantiene para no romper clientes viejos — lanza error claro.
 */
export const generateUploadUrl = mutation({
  handler: async () => {
    throw new Error(
      "Las subidas van a S3. Usa api.files.generateUploadUrl (action).",
    );
  },
});

export const listByCondominio = query({
  args: { condominioId: v.id("condominios") },
  handler: async (ctx, args) => {
    await requireCondominioRole(ctx, args.condominioId, []);
    const docs = await ctx.db
      .query("documentos")
      .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
      .order("desc")
      .collect();

    return await Promise.all(
      docs.map(async (doc) => ({
        ...doc,
        url: await resolveMediaUrl(ctx, doc),
      })),
    );
  },
});

/** Conteos por categoría (escanea máx. 2000). */
export const countsByCondominio = query({
  args: { condominioId: v.id("condominios") },
  handler: async (ctx, args) => {
    await requireCondominioRole(ctx, args.condominioId, []);
    const rows = await ctx.db
      .query("documentos")
      .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
      .take(2000);
    return {
      total: rows.length,
      reglamento: rows.filter((d) => d.categoria === "reglamento").length,
      acta: rows.filter((d) => d.categoria === "acta").length,
      financiero: rows.filter((d) => d.categoria === "financiero").length,
    };
  },
});

export const listPage = query({
  args: {
    condominioId: v.id("condominios"),
    paginationOpts: paginationOptsValidator,
    categoria: v.optional(categoriaValidator),
  },
  handler: async (ctx, args) => {
    await requireCondominioRole(ctx, args.condominioId, []);
    const categoria = args.categoria;

    async function hydrate(doc: Doc<"documentos">) {
      return {
        ...doc,
        url: await resolveMediaUrl(ctx, doc),
      };
    }

    if (categoria) {
      const scan = await ctx.db
        .query("documentos")
        .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
        .order("desc")
        .take(250);
      const filtered = scan.filter((d) => d.categoria === categoria);
      const limit = Math.min(args.paginationOpts.numItems || 30, 60);
      const page = await Promise.all(filtered.slice(0, limit).map(hydrate));
      return { page, isDone: true, continueCursor: "" };
    }

    const result = await ctx.db
      .query("documentos")
      .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
      .order("desc")
      .paginate(args.paginationOpts);

    const page = await Promise.all(result.page.map(hydrate));
    return { ...result, page };
  },
});

export const create = mutation({
  args: {
    condominioId: v.id("condominios"),
    nombre: v.string(),
    categoria: categoriaValidator,
    /** @deprecated Convex Storage — preferir url/s3Key */
    storageId: v.optional(v.id("_storage")),
    url: v.optional(v.string()),
    s3Key: v.optional(v.string()),
    mimeType: v.string(),
    tamanio: v.number(),
    descripcion: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireCondominioRole(ctx, args.condominioId, [...ADMIN_ROLES]);
    if (!args.url && !args.storageId) {
      throw new Error("Falta la URL del archivo (S3).");
    }
    // La llave, si viene, tiene que ser de la carpeta de documentos del conjunto.
    const s3Key = exigirLlaveDeCarpeta(
      args.s3Key,
      carpetaDocumentos(args.condominioId),
    );
    // Un documento nuevo no puede llevar un archivo de Convex Storage (`model/files.ts`).
    const storageId = exigirStorageIdDelRegistro(args.storageId);
    // El archivo sale de una subida validada de quien registra, a esta carpeta.
    await exigirArchivoSubido(
      ctx,
      user._id,
      { url: args.url, s3Key: args.s3Key },
      carpetaDocumentos(args.condominioId),
    );
    return await ctx.db.insert("documentos", {
      condominioId: args.condominioId,
      nombre: args.nombre.trim(),
      categoria: args.categoria,
      storageId,
      url: args.url,
      s3Key,
      mimeType: args.mimeType,
      tamanio: args.tamanio,
      autorNombre: user.name,
      descripcion: args.descripcion?.trim(),
      createdAt: Date.now(),
    });
  },
});

export const remove = mutation({
  args: { id: v.id("documentos") },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.id);
    if (!existing) throw new Error("Documento no encontrado.");
    await requireCondominioRole(ctx, existing.condominioId, [...ADMIN_ROLES]);
    // Un archivo de Convex Storage heredado se desvincula sin borrarlo: su id
    // no prueba de quién es (`model/files.ts`).
    await ctx.db.delete(args.id);

    // El archivo, solo si es de la carpeta del conjunto y ya no lo usa otro
    // documento.
    const key = llaveDeArchivo(existing.s3Key, existing.url);
    const enUso = await llavesEnUso(ctx, existing.condominioId);
    if (key && !enUso.has(key)) {
      await scheduleDeleteS3Keys(ctx, carpetaDocumentos(existing.condominioId), [key]);
    }
  },
});

/** Las llaves S3 que usan los documentos del conjunto. */
async function llavesEnUso(
  ctx: MutationCtx,
  condominioId: Id<"condominios">,
): Promise<Set<string>> {
  const docs = await ctx.db
    .query("documentos")
    .withIndex("by_condominio", (q) => q.eq("condominioId", condominioId))
    .collect();
  return new Set(
    docs
      .map((d) => llaveDeArchivo(d.s3Key, d.url))
      .filter((k): k is string => Boolean(k)),
  );
}
