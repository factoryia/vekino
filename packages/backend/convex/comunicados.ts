import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { query, mutation, internalQuery } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { requireCondominioRole } from "./model/authz";
import { exigirStorageIdDelRegistro, resolveMediaUrl } from "./model/files";
import { exigirArchivoSubido } from "./model/registroArchivos";
import {
  carpetaComunicados,
  exigirLlaveDeCarpeta,
  llaveDeArchivo,
  scheduleDeleteS3Keys,
} from "./model/s3";

const audienciaValidator = v.union(
  v.literal("todos"),
  v.literal("propietario"),
  v.literal("arrendatario"),
  v.literal("residente"),
  v.literal("junta_directiva"),
  v.literal("guardia")
);
const prioridadValidator = v.union(
  v.literal("normal"),
  v.literal("importante"),
  v.literal("urgente")
);
const archivoValidator = v.object({
  storageId: v.optional(v.id("_storage")), // legacy
  url: v.optional(v.string()),
  s3Key: v.optional(v.string()),
  mimeType: v.string(),
  nombre: v.string(),
});

export const ADMIN_ROLES = ["administrador", "junta_directiva", "contadora"] as const;

type Archivo = {
  storageId?: Id<"_storage">;
  url?: string;
  s3Key?: string;
  mimeType: string;
  nombre: string;
};

/**
 * Los adjuntos que se guardan.
 *
 * Los que el comunicado ya tenía (la edición los reenvía) se conservan tal
 * como estaban guardados, no como los manda el cliente; un `storageId` de
 * Convex Storage solo vale así (`model/files.ts`). Uno NUEVO tiene que tener
 * su `s3Key` en la carpeta de comunicados del conjunto y salir de una subida
 * validada de quien guarda (`model/registroArchivos.ts`).
 */
async function exigirAdjuntos(
  ctx: MutationCtx,
  userId: Id<"users">,
  archivos: Archivo[],
  condominioId: Id<"condominios">,
  previos: Archivo[] = [],
): Promise<Archivo[]> {
  const storagePrevios = previos.map((a) => a.storageId);
  const carpeta = carpetaComunicados(condominioId);
  const resultado: Archivo[] = [];
  for (const a of archivos) {
    const key = a.s3Key?.trim();
    const url = a.url?.trim();
    const previo = previos.find(
      (p) =>
        (a.storageId !== undefined && p.storageId === a.storageId) ||
        (key !== undefined && key !== "" && p.s3Key?.trim() === key) ||
        (!key && a.storageId === undefined && url !== undefined && url !== "" && p.url?.trim() === url),
    );
    if (previo) {
      resultado.push(previo);
      continue;
    }
    exigirStorageIdDelRegistro(a.storageId, storagePrevios);
    const s3Key = exigirLlaveDeCarpeta(key, carpeta);
    await exigirArchivoSubido(ctx, userId, { url: a.url, s3Key: a.s3Key }, carpeta);
    resultado.push({ ...a, s3Key });
  }
  return resultado;
}

/** Las llaves S3 que usan los adjuntos de los comunicados del conjunto. */
async function llavesEnUso(
  ctx: MutationCtx,
  condominioId: Id<"condominios">,
): Promise<Set<string>> {
  const rows = await ctx.db
    .query("comunicados")
    .withIndex("by_condominio", (q) => q.eq("condominioId", condominioId))
    .collect();
  return new Set(
    rows
      .flatMap((r) => r.archivos ?? [])
      .map((a) => llaveDeArchivo(a.s3Key, a.url))
      .filter((k): k is string => Boolean(k)),
  );
}

/**
 * Borra los archivos de `archivos` que ya no usa ningún comunicado del
 * conjunto (se llama DESPUÉS de guardar el cambio), y solo si son de su
 * carpeta (`scheduleDeleteS3Keys`).
 */
async function borrarAdjuntosSinUso(
  ctx: MutationCtx,
  condominioId: Id<"condominios">,
  archivos: Archivo[],
) {
  const enUso = await llavesEnUso(ctx, condominioId);
  await scheduleDeleteS3Keys(
    ctx,
    carpetaComunicados(condominioId),
    archivos
      .map((a) => llaveDeArchivo(a.s3Key, a.url))
      .filter((k) => k !== null && !enUso.has(k)),
  );
}

/** URL de subida — @deprecated usar api.files.generateUploadUrl (S3). */
export const generateUploadUrl = mutation({
  handler: async () => {
    throw new Error(
      "Las subidas van a S3. Usa api.files.generateUploadUrl (action).",
    );
  },
});

/** Lista los comunicados del condominio: fijados primero, luego más recientes. */
export const listByCondominio = query({
  args: { condominioId: v.id("condominios") },
  handler: async (ctx, args) => {
    await requireCondominioRole(ctx, args.condominioId, []); // cualquier miembro
    const rows = await ctx.db
      .query("comunicados")
      .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
      .collect();

    const withUrls = await Promise.all(
      rows.map(async (row) => {
        const archivosItems = await Promise.all(
          (row.archivos ?? []).map(async (a) => ({
            storageId: a.storageId as string | undefined,
            url: await resolveMediaUrl(ctx, a),
            s3Key: a.s3Key,
            mimeType: a.mimeType,
            nombre: a.nombre,
          })),
        );
        return { ...row, archivosItems };
      }),
    );

    return withUrls.sort((a, b) => {
      if (a.fijado !== b.fijado) return a.fijado ? -1 : 1;
      return b.createdAt - a.createdAt;
    });
  },
});

/** Página de comunicados con URLs solo de la página actual. */
export const listPage = query({
  args: {
    condominioId: v.id("condominios"),
    paginationOpts: paginationOptsValidator,
    q: v.optional(v.string()),
    prioridad: v.optional(
      v.union(v.literal("normal"), v.literal("importante"), v.literal("urgente")),
    ),
  },
  handler: async (ctx, args) => {
    await requireCondominioRole(ctx, args.condominioId, []);
    const needle = args.q?.trim().toLowerCase() ?? "";
    const prioridad = args.prioridad;

    async function hydrate(row: any) {
      const archivosItems = await Promise.all(
        (row.archivos ?? []).map(async (a: any) => ({
          storageId: a.storageId as string | undefined,
          url: await resolveMediaUrl(ctx, a),
          s3Key: a.s3Key,
          mimeType: a.mimeType,
          nombre: a.nombre,
        })),
      );
      return { ...row, archivosItems };
    }

    if (needle || prioridad) {
      const scan = await ctx.db
        .query("comunicados")
        .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
        .order("desc")
        .take(250);
      const filtered = scan
        .filter((c) => {
          if (prioridad && c.prioridad !== prioridad) return false;
          if (!needle) return true;
          return (
            c.titulo.toLowerCase().includes(needle) ||
            c.cuerpo.toLowerCase().includes(needle) ||
            c.autorNombre.toLowerCase().includes(needle)
          );
        })
        .sort((a, b) => {
          if (a.fijado !== b.fijado) return a.fijado ? -1 : 1;
          return b.createdAt - a.createdAt;
        });
      const limit = Math.min(args.paginationOpts.numItems || 30, 60);
      const page = await Promise.all(filtered.slice(0, limit).map(hydrate));
      return { page, isDone: true, continueCursor: "" };
    }

    const result = await ctx.db
      .query("comunicados")
      .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
      .order("desc")
      .paginate(args.paginationOpts);

    const page = await Promise.all(result.page.map(hydrate));
    return { ...result, page };
  },
});

/** Últimos avisos para home (sin .collect() completo ni URLs de archivos). */
export const listRecent = query({
  args: {
    condominioId: v.id("condominios"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireCondominioRole(ctx, args.condominioId, []);
    const limit = Math.min(Math.max(args.limit ?? 5, 1), 20);
    const rows = await ctx.db
      .query("comunicados")
      .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
      .order("desc")
      .take(40);

    const top = rows
      .sort((a, b) => {
        if (a.fijado !== b.fijado) return a.fijado ? -1 : 1;
        return b.createdAt - a.createdAt;
      })
      .slice(0, limit);

    // El home solo pinta la imagen del primero (la tarjeta destacada), así que
    // resolvemos esa URL y nada más: seguimos sin hidratar todos los adjuntos.
    const destacado = top[0];
    const portada = destacado
      ? (destacado.archivos ?? []).find((a) =>
          a.mimeType?.startsWith("image/"),
        )
      : undefined;
    const portadaUrl = portada ? await resolveMediaUrl(ctx, portada) : "";

    return top.map((row, i) => ({
      _id: row._id,
      titulo: row.titulo,
      cuerpo: row.cuerpo,
      prioridad: row.prioridad,
      fijado: row.fijado,
      createdAt: row.createdAt,
      imagenUrl: i === 0 && portadaUrl ? portadaUrl : null,
    }));
  },
});

/** Crea un comunicado (solo roles administrativos). */
export const create = mutation({
  args: {
    condominioId: v.id("condominios"),
    titulo: v.string(),
    cuerpo: v.string(),
    audiencia: audienciaValidator,
    prioridad: prioridadValidator,
    fijado: v.boolean(),
    archivos: v.optional(v.array(archivoValidator)),
  },
  handler: async (ctx, args) => {
    const { user } = await requireCondominioRole(ctx, args.condominioId, [
      ...ADMIN_ROLES,
    ]);
    const now = Date.now();
    const comunicadoId = await ctx.db.insert("comunicados", {
      condominioId: args.condominioId,
      autorUserId: user._id,
      autorNombre: user.name,
      titulo: args.titulo.trim(),
      cuerpo: args.cuerpo.trim(),
      audiencia: args.audiencia,
      prioridad: args.prioridad,
      fijado: args.fijado,
      archivos: await exigirAdjuntos(ctx, user._id, args.archivos ?? [], args.condominioId),
      createdAt: now,
      updatedAt: now,
    });

    // Fan-out de WhatsApp a la audiencia del comunicado (solo al crear, no al
    // editar). El gating por tenant (módulo "whatsapp") se decide en la action.
    await ctx.scheduler.runAfter(0, internal.whatsappBroadcast.broadcastComunicado, {
      comunicadoId,
    });

    return comunicadoId;
  },
});

/** Edita un comunicado. */
export const update = mutation({
  args: {
    id: v.id("comunicados"),
    titulo: v.string(),
    cuerpo: v.string(),
    audiencia: audienciaValidator,
    prioridad: prioridadValidator,
    fijado: v.boolean(),
    archivos: v.optional(v.array(archivoValidator)),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.id);
    if (!existing) throw new Error("Comunicado no encontrado.");
    const { user } = await requireCondominioRole(ctx, existing.condominioId, [...ADMIN_ROLES]);

    const nextArchivos = args.archivos
      ? await exigirAdjuntos(ctx, user._id, args.archivos, existing.condominioId, existing.archivos)
      : existing.archivos ?? [];
    // Un adjunto de Convex Storage que se quita se desvincula sin borrarlo:
    // su id no prueba de quién es (`model/files.ts`).

    await ctx.db.patch(args.id, {
      titulo: args.titulo.trim(),
      cuerpo: args.cuerpo.trim(),
      audiencia: args.audiencia,
      prioridad: args.prioridad,
      fijado: args.fijado,
      archivos: nextArchivos,
      updatedAt: Date.now(),
    });

    // Los adjuntos que se quitaron (los que siguen, siguen en uso).
    if (args.archivos) {
      await borrarAdjuntosSinUso(ctx, existing.condominioId, existing.archivos ?? []);
    }
  },
});

/** Fija / desfija un comunicado. */
export const togglePin = mutation({
  args: { id: v.id("comunicados") },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.id);
    if (!existing) throw new Error("Comunicado no encontrado.");
    await requireCondominioRole(ctx, existing.condominioId, [...ADMIN_ROLES]);
    await ctx.db.patch(args.id, {
      fijado: !existing.fijado,
      updatedAt: Date.now(),
    });
  },
});

/** Elimina un comunicado y sus archivos adjuntos. */
export const remove = mutation({
  args: { id: v.id("comunicados") },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.id);
    if (!existing) throw new Error("Comunicado no encontrado.");
    await requireCondominioRole(ctx, existing.condominioId, [...ADMIN_ROLES]);
    // Los adjuntos de Convex Storage se desvinculan sin borrarlos (`model/files.ts`).
    await ctx.db.delete(args.id);
    await borrarAdjuntosSinUso(ctx, existing.condominioId, existing.archivos ?? []);
  },
});

/**
 * Comunicados de un condominio con sus adjuntos, para enviarlos por WhatsApp.
 * La plantilla de texto no lleva la imagen; dentro de la ventana de 24 h sí se
 * puede mandar el archivo real, que es lo que la gente espera ver.
 */
export const paraWhatsapp = internalQuery({
  args: { condominioId: v.id("condominios"), limite: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const filas = await ctx.db
      .query("comunicados")
      .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
      .order("desc")
      .take(Math.min(args.limite ?? 10, 30));

    return filas.map((c) => ({
      id: c._id,
      titulo: c.titulo,
      cuerpo: c.cuerpo,
      prioridad: c.prioridad,
      createdAt: c.createdAt,
      archivos: (c.archivos ?? [])
        .filter((a) => !!a.url)
        .map((a) => ({
          url: a.url as string,
          mimeType: a.mimeType,
          nombre: a.nombre,
        })),
    }));
  },
});
