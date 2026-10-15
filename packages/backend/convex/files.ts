"use node";

import { randomUUID } from "crypto";
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { v } from "convex/values";
import { action, internalAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { api, internal } from "./_generated/api";
import { bucketPublico, carpetaComprobantes, urlPublica, vTipoComprobante } from "./lib/comprobantes";
import { CARPETA_AVATARES, carpetaAvatar } from "./model/s3";

function requireS3Env() {
  /* Bucket y región como los lee `crearMio` para validar la URL de un
   * comprobante (`lib/comprobantes.ts`): una sola lectura para las dos. */
  const destino = bucketPublico(process.env);
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (!destino || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "Faltan variables AWS_S3_BUCKET_NAME / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY en Convex.",
    );
  }
  return { ...destino, accessKeyId, secretAccessKey };
}

function s3Client() {
  const { region, accessKeyId, secretAccessKey } = requireS3Env();
  return new S3Client({
    region,
    credentials: { accessKeyId, secretAccessKey },
  });
}

function publicUrlFor(key: string) {
  const { region, bucket } = requireS3Env();
  return urlPublica({ bucket, region }, key);
}

function sanitizeFileName(name: string) {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 120);
}

/**
 * Sanea la carpeta destino.
 *
 * `folder` llega del cliente y va directo a la clave del objeto. Sin limpiarla,
 * cualquier usuario autenticado pod\u00eda escribir bajo cualquier prefijo del
 * bucket \u2014incluido el de otro conjunto\u2014 y, con `..`, salirse de la carpeta
 * que dijo estar usando.
 */
function sanitizeFolder(folderArg: string): string {
  const limpio = folderArg
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== "." && s !== "..")
    .map((s) => s.replace(/[^a-zA-Z0-9._-]+/g, "-"))
    .slice(0, 6)
    .join("/");
  return limpio || "uploads";
}

/**
 * La carpeta en la que de verdad se sube.
 *
 * Las fotos de perfil van a la carpeta de quien sube (`avatars/{userId}`),
 * la pida como la pida el cliente: la web y el móvil —también los builds ya
 * instalados— mandan `"avatars"`. Así la llave dice de quién es la foto, y
 * `users.setMyAvatar` solo borra fotos de esa carpeta. Nadie puede dejar
 * archivos en la carpeta de otro usuario.
 */
async function carpetaDeSubida(ctx: ActionCtx, folderArg: string): Promise<string> {
  const folder = sanitizeFolder(folderArg);
  if (folder !== CARPETA_AVATARES && !folder.startsWith(`${CARPETA_AVATARES}/`)) {
    return folder;
  }
  const userId: Id<"users"> = await ctx.runQuery(internal.users.miIdParaArchivos, {});
  return carpetaAvatar(userId);
}

/** Key \u00fanico en el bucket: `{folder}/{timestamp}-{uuid corto}-{nombre saneado}`. */
function buildObjectKey(folderArg: string, fileNameArg?: string) {
  const folder = sanitizeFolder(folderArg);
  const rawName = fileNameArg?.trim() || "file";
  const safe = sanitizeFileName(rawName);
  return `${folder}/${Date.now()}-${randomUUID().slice(0, 8)}-${safe}`;
}

/**
 * Sube bytes al bucket con una llave nueva (`buildObjectKey`). La usan
 * `uploadBytes`, el bot (`uploadFromUrl`) y los comprobantes de la web
 * (`subirComprobante`).
 */
async function subirAlBucket(
  folder: string,
  fileName: string | undefined,
  contentType: string,
  body: Buffer,
): Promise<{ key: string; publicUrl: string }> {
  const { bucket } = requireS3Env();
  const client = s3Client();
  const key = buildObjectKey(folder, fileName);
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType,
      Body: body,
    }),
  );
  return { key, publicUrl: publicUrlFor(key) };
}

/**
 * URL firmada (PUT) para subir directo al bucket S3.
 * El cliente debe hacer PUT con el Content-Type indicado.
 *
 * Nota: en algunos entornos el PUT desde el browser falla por CORS
 * (`Failed to fetch`). Preferí `uploadBytes` desde el cliente cuando eso pase.
 */
export const generateUploadUrl = action({
  args: {
    folder: v.string(),
    contentType: v.string(),
    fileName: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ uploadUrl: string; key: string; publicUrl: string }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("No autenticado.");

    const { bucket } = requireS3Env();
    const client = s3Client();
    const key = buildObjectKey(await carpetaDeSubida(ctx, args.folder), args.fileName);

    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: args.contentType || "application/octet-stream",
    });

    const uploadUrl = await getSignedUrl(client, command, { expiresIn: 600 });
    return {
      uploadUrl,
      key,
      publicUrl: publicUrlFor(key),
    };
  },
});

/**
 * Subida server-side (evita CORS del browser → S3).
 * Límite práctico ~15 MB (argumentos de action Convex).
 */
export const uploadBytes = action({
  args: {
    folder: v.string(),
    contentType: v.string(),
    fileName: v.optional(v.string()),
    bytes: v.bytes(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ key: string; publicUrl: string }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("No autenticado.");

    const size = args.bytes.byteLength;
    if (size <= 0) throw new Error("Archivo vacío.");
    if (size > 15 * 1024 * 1024) {
      throw new Error("El archivo supera el límite de 15 MB.");
    }

    return await subirAlBucket(
      await carpetaDeSubida(ctx, args.folder),
      args.fileName,
      args.contentType || "application/octet-stream",
      Buffer.from(args.bytes),
    );
  },
});

async function deleteS3Key(key: string) {
  const trimmed = key.trim();
  if (!trimmed) return;
  const { bucket } = requireS3Env();
  const client = s3Client();
  await client.send(
    new DeleteObjectCommand({
      Bucket: bucket,
      Key: trimmed,
    }),
  );
}

/*
 * No hay borrado público por llave. Existía `deleteObject` (cualquier sesión
 * borraba cualquier llave del bucket) y ningún cliente lo usaba: se retiró.
 * Los archivos se borran solo al borrar o reemplazar su registro, con la
 * carpeta de su entidad (`model/s3.ts`, `scheduleDeleteS3Keys`).
 */

/**
 * Borrado interno (p. ej. al reemplazar avatar / adjuntos). Lo programan
 * `scheduleDeleteS3Keys`, que ya filtró la llave por la carpeta de su
 * entidad, y `soportesPago.enviarMio`, con la llave que acaba de crear.
 */
export const deleteObjectInternal = internalAction({
  args: { key: v.string() },
  handler: async (_ctx, args) => {
    try {
      await deleteS3Key(args.key);
    } catch {
      // No fallar el flujo si el objeto ya no existe o hay un glitch de red.
    }
    return { ok: true as const };
  },
});

/** Compat: algunos callers solo necesitan confirmar sesión. */
export const ping = action({
  args: {},
  handler: async (ctx): Promise<{ ok: boolean }> => {
    const me: unknown = await ctx.runQuery(api.users.me, {});
    return { ok: Boolean(me) };
  },
});

/**
 * Descarga un archivo desde una URL y lo sube al bucket S3.
 * Pensado para el bot de WhatsApp: la media de YCloud viene como URL temporal
 * (requiere el header X-API-Key y caduca en ~30 días), así que la persistimos
 * de una vez en S3. Sin ctx.auth: es una internalAction invocada por el bot.
 */
export const uploadFromUrl = internalAction({
  args: {
    url: v.string(),
    folder: v.string(),
    fileName: v.optional(v.string()),
    contentType: v.optional(v.string()),
    conApiKeyYCloud: v.optional(v.boolean()),
  },
  handler: async (
    _ctx,
    args,
  ): Promise<{ key: string; publicUrl: string }> => {
    const maxBytes = 25 * 1024 * 1024;

    // Anti-SSRF: la URL viene del payload del webhook (autenticado por
    // secreto, pero defensa en profundidad): solo HTTPS y nunca hosts
    // internos/IP privadas. Y el API key de YCloud solo viaja a YCloud.
    let destino: URL;
    try {
      destino = new URL(args.url);
    } catch {
      throw new Error("URL de descarga inválida.");
    }
    if (destino.protocol !== "https:") {
      throw new Error("Solo se permiten descargas por HTTPS.");
    }
    const host = destino.hostname.toLowerCase();
    const esIpPrivada =
      host === "localhost" ||
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^169\.254\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      host === "[::1]" ||
      host.endsWith(".internal");
    if (esIpPrivada) {
      throw new Error("Host de descarga no permitido.");
    }

    const headers: Record<string, string> = {};
    if (
      args.conApiKeyYCloud &&
      (host === "ycloud.com" || host.endsWith(".ycloud.com"))
    ) {
      headers["X-API-Key"] = process.env.YCLOUD_API_KEY ?? "";
    }

    const response = await fetch(args.url, { headers });
    if (!response.ok) {
      throw new Error(
        `No se pudo descargar el archivo (HTTP ${response.status}).`,
      );
    }

    // Límite defensivo: primero por header, luego por el buffer real.
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new Error("El archivo supera el límite de 25 MB.");
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength <= 0) throw new Error("Archivo vacío.");
    if (bytes.byteLength > maxBytes) {
      throw new Error("El archivo supera el límite de 25 MB.");
    }

    const contentType =
      args.contentType ||
      response.headers.get("content-type") ||
      "application/octet-stream";

    return await subirAlBucket(args.folder, args.fileName, contentType, bytes);
  },
});

/**
 * El archivo de un comprobante que el residente envió desde la web
 * (`soportesPago.enviarMio`), ya validado allí: reglas, tamaño y tipo por
 * contenido.
 *
 * Llega por el almacenamiento interno de Convex y no como argumento: una
 * acción Node solo recibe 5 MiB de argumentos, y un comprobante puede pesar
 * 10 MB. La carpeta y la llave las decide el servidor; el `ContentType` es el
 * tipo detectado.
 */
export const subirComprobante = internalAction({
  args: {
    storageId: v.id("_storage"),
    condominioId: v.id("condominios"),
    nombreArchivo: v.optional(v.string()),
    contentType: vTipoComprobante,
  },
  handler: async (ctx, args): Promise<{ key: string; publicUrl: string }> => {
    const archivo = await ctx.storage.get(args.storageId);
    if (!archivo) throw new Error("No se encontró el archivo del comprobante.");
    return await subirAlBucket(
      carpetaComprobantes(args.condominioId),
      args.nombreArchivo,
      args.contentType,
      Buffer.from(await archivo.arrayBuffer()),
    );
  },
});
