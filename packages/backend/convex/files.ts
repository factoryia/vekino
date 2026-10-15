"use node";

import { createHash, randomBytes, randomUUID } from "crypto";
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
  CopyObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { v } from "convex/values";
import { action, internalAction } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { api, internal } from "./_generated/api";
import { bucketPublico, carpetaComprobantes, urlPublica, vTipoComprobante } from "./lib/comprobantes";
import {
  BYTES_CABECERA,
  CARPETA_TEMPORAL,
  CATEGORIAS,
  MENSAJE_ARCHIVO_GRANDE,
  MENSAJE_CONTENIDO,
  MENSAJE_SUBIDA_NO_VALIDA,
  TIPOS_DESCARGA,
  VIGENCIA_PENDIENTE_DIRECTA_MS,
  tipoNeutralizado,
  tipoVerificado,
  type Categoria,
  type NombreCategoria,
} from "./lib/subidas";

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
 * Las carpetas de las subidas de usuarios ya llegan autorizadas y exactas
 * (`subidas.autorizar`); las de los procesos internos las arma el servidor.
 * Esto queda como cinturón: nunca `..`, `.` ni caracteres raros en una llave.
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

/** Key único en el bucket: `{folder}/{timestamp}-{uuid corto}-{nombre saneado}`. */
function buildObjectKey(folderArg: string, fileNameArg?: string) {
  const folder = sanitizeFolder(folderArg);
  const rawName = fileNameArg?.trim() || "file";
  const safe = sanitizeFileName(rawName);
  return `${folder}/${Date.now()}-${randomUUID().slice(0, 8)}-${safe}`;
}

/**
 * Escribe un objeto en el bucket. Nunca sobrescribe (`If-None-Match: *`): las
 * llaves son nuevas, y si alguna ya existiera, falla en vez de pisarla. Lo que
 * debe bajarse y no abrirse (`TIPOS_DESCARGA`, o lo que pida quien llama) va
 * con `Content-Disposition: attachment`.
 */
async function ponerEnBucket(
  key: string,
  contentType: string,
  body: Buffer,
  descarga = false,
): Promise<void> {
  const { bucket } = requireS3Env();
  await s3Client().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType,
      Body: body,
      IfNoneMatch: "*",
      ...(descarga || TIPOS_DESCARGA.has(contentType) ? { ContentDisposition: "attachment" } : {}),
    }),
  );
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
  descarga = false,
): Promise<{ key: string; publicUrl: string }> {
  const key = buildObjectKey(folder, fileName);
  await ponerEnBucket(key, contentType, body, descarga);
  return { key, publicUrl: publicUrlFor(key) };
}

/** Lo que `subidas.autorizar` devuelve: dónde, y con qué reglas. */
type Destino = {
  carpeta: string;
  categoria: string;
  userId: Id<"users">;
  tipos: string[];
  maxBytes: number;
};

/** Vigencia de un enlace de subida. */
const VIGENCIA_ENLACE_MS = 10 * 60 * 1000;

/**
 * El enlace para subir un archivo. Antes de firmar nada, `subidas.autorizar`
 * revisa la carpeta (que sea de un uso conocido y de un conjunto o entidad
 * donde quien pide tiene el permiso de registrar ese archivo), el tipo y el
 * tamaño. La llave la arma el servidor dentro de esa carpeta.
 *
 * Dos formas, con la misma respuesta `{uploadUrl, key, publicUrl}`:
 *   - Con `size` (la web actual): URL firmada de S3 con el tipo y el tamaño
 *     exactos firmados (`content-type`, `content-length`). S3 rechaza un PUT
 *     con otro tipo u otro tamaño.
 *   - Sin `size` (las apps instaladas y la web anterior, que hacen PUT a la
 *     `uploadUrl` con su `Content-Type`): la URL es la ruta
 *     `/archivos/subida` del backend, de un solo uso y 10 minutos, que revisa
 *     el tamaño y el contenido antes de escribir en S3 (`subidas.ts`).
 */
export const generateUploadUrl = action({
  args: {
    folder: v.string(),
    contentType: v.string(),
    fileName: v.optional(v.string()),
    /** Bytes del archivo. Sin él, la subida pasa por el backend. */
    size: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ uploadUrl: string; key: string; publicUrl: string }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("No autenticado.");

    const { bucket } = requireS3Env();
    const directo = args.size !== undefined;
    const destino: Destino = await ctx.runQuery(internal.subidas.autorizar, {
      folder: args.folder,
      contentType: args.contentType,
      ...(directo ? { size: args.size } : {}),
      directo,
    });
    const key = buildObjectKey(destino.carpeta, args.fileName);

    if (directo) {
      /* El PUT va a una llave provisional (`pendientes/…`), con el tipo y el
       * tamaño firmados: el cliente manda exactamente este `Content-Type` y
       * el navegador pone el `Content-Length`. Firmar no prueba qué bytes
       * llegan: eso lo revisa `confirmarSubida` leyendo el objeto, y solo
       * entonces lo publica en `key` con el tipo verificado. */
      const claveTemporal = `${CARPETA_TEMPORAL}/${randomBytes(16).toString("hex")}`;
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: claveTemporal,
        ContentType: args.contentType,
        ContentLength: args.size,
      });
      const uploadUrl = await getSignedUrl(s3Client(), command, {
        expiresIn: VIGENCIA_ENLACE_MS / 1000,
        signableHeaders: new Set(["content-type", "content-length"]),
      });
      await ctx.runMutation(internal.subidas.registrarPendiente, {
        key,
        url: publicUrlFor(key),
        carpeta: destino.carpeta,
        categoria: destino.categoria,
        tipoDeclarado: args.contentType,
        userId: destino.userId,
        expiraEn: Date.now() + VIGENCIA_PENDIENTE_DIRECTA_MS,
        modo: "directo",
        size: args.size,
        claveTemporal,
      });
      return { uploadUrl, key, publicUrl: publicUrlFor(key) };
    }

    const sitio = process.env.CONVEX_SITE_URL?.replace(/\/+$/, "");
    if (!sitio) throw new Error("Falta CONVEX_SITE_URL en Convex.");
    const token = randomBytes(32).toString("hex");
    await ctx.runMutation(internal.subidas.registrarPendiente, {
      tokenHash: createHash("sha256").update(token).digest("hex"),
      key,
      url: publicUrlFor(key),
      carpeta: destino.carpeta,
      categoria: destino.categoria,
      tipoDeclarado: args.contentType,
      userId: destino.userId,
      expiraEn: Date.now() + VIGENCIA_ENLACE_MS,
      modo: "intermediado",
    });
    return {
      uploadUrl: `${sitio}/archivos/subida?token=${token}`,
      key,
      publicUrl: publicUrlFor(key),
    };
  },
});

/**
 * Subida server-side (evita CORS del browser → S3). Es una acción Node: los
 * argumentos llegan hasta 5 MiB, así que en la práctica sirve para archivos
 * de hasta ~3,7 MB; lo más grande va por `generateUploadUrl`.
 *
 * Misma autorización que `generateUploadUrl`, y además se revisan los bytes:
 * se guarda con el tipo que dicen, si está permitido.
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

    const destino: Destino = await ctx.runQuery(internal.subidas.autorizar, {
      folder: args.folder,
      contentType: args.contentType,
      size,
      directo: false,
    });
    const cabecera = new Uint8Array(args.bytes, 0, Math.min(size, BYTES_CABECERA));
    const tipo = tipoVerificado(cabecera, args.contentType, destino.tipos);
    if (!tipo) throw new Error(MENSAJE_CONTENIDO);

    const subido = await subirAlBucket(destino.carpeta, args.fileName, tipo, Buffer.from(args.bytes));
    // Validada desde ya: el servidor vio los bytes.
    await ctx.runMutation(internal.subidas.registrarValidada, {
      key: subido.key,
      url: subido.publicUrl,
      carpeta: destino.carpeta,
      categoria: destino.categoria,
      tipoDeclarado: args.contentType,
      userId: destino.userId,
      tipo,
      bytes: size,
    });
    return subido;
  },
});

/** Publicaciones simultáneas en S3 dentro de una llamada a `publicarFacturas`. */
const FACTURAS_EN_PARALELO = 6;

/** S3 rechazó el `If-None-Match: *`: la llave ya existe. */
function yaExiste(e: unknown): boolean {
  const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
  return err?.name === "PreconditionFailed" || err?.$metadata?.httpStatusCode === 412;
}

/**
 * Publica los PDF de las facturas de una importación (Fase 5 de S3, H-12).
 *
 * Antes `/api/facturas/confirmar` los escribía con su propio cliente de S3 y
 * mandaba la URL a `bulkUpsert`, que la guardaba sin saber de dónde salía.
 * Ahora la ruta manda aquí los bytes que leyó, y:
 *   - el permiso y el destino salen de la importación
 *     (`facturas.destinoPublicacion`): en curso, rol de carga en su
 *     conjunto, carpeta solo de ese conjunto;
 *   - cada archivo tiene que ser un PDF por sus bytes —no por su nombre ni
 *     por lo que diga quien llama—, no vacío y dentro del límite;
 *   - la llave la arma el servidor: carpeta de la importación, casa y huella
 *     del contenido. Nunca sobrescribe (`If-None-Match: *`): si ya existe es
 *     un reintento de esta importación con el mismo contenido (nadie más
 *     escribe en esa carpeta) y se da por publicado;
 *   - cada PDF queda como subida validada (`subidas.registrarPublicadas`), y
 *     `bulkUpsert` solo registra en una factura uno de esos.
 * Todos se revisan antes de escribir el primero: un lote con un archivo malo
 * no publica nada. Si falla una escritura, lo ya publicado queda registrado
 * (un reintento lo reconoce) y la llamada falla. Nada se borra.
 *
 * Es una acción Node: recibe hasta 5 MiB por llamada, y la ruta manda los PDF
 * en lotes por debajo de eso.
 */
export const publicarFacturas = action({
  args: {
    importacionId: v.id("importaciones"),
    /** `unidad`: la casa que dice el documento, solo para el nombre del archivo. */
    pdfs: v.array(v.object({ unidad: v.string(), bytes: v.bytes() })),
  },
  handler: async (ctx, args): Promise<{ key: string; publicUrl: string }[]> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("No autenticado.");
    const destino: { carpeta: string; userId: Id<"users"> } = await ctx.runQuery(
      internal.facturas.destinoPublicacion,
      { importacionId: args.importacionId },
    );

    const { maxBytes, tipos } = CATEGORIAS.facturaPdf;
    const archivos = args.pdfs.map((p) => {
      const bytes = new Uint8Array(p.bytes);
      if (bytes.byteLength === 0) throw new Error("Archivo vacío.");
      if (bytes.byteLength > maxBytes) throw new Error(MENSAJE_ARCHIVO_GRANDE);
      if (!tipoVerificado(bytes.subarray(0, BYTES_CABECERA), "application/pdf", tipos)) {
        throw new Error(MENSAJE_CONTENIDO);
      }
      const casa = (p.unidad || "sin-unidad").replace(/[^A-Za-z0-9-]/g, "_").slice(0, 40);
      const huella = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
      const key = `${destino.carpeta}/unidad-${casa}-${huella}.pdf`;
      return { key, url: publicUrlFor(key), bytes };
    });

    const publicadas: typeof archivos = [];
    let fallo = false;
    const cola = [...archivos];
    await Promise.all(
      Array.from({ length: Math.min(FACTURAS_EN_PARALELO, cola.length) }, async () => {
        for (let a = cola.shift(); a; a = cola.shift()) {
          try {
            await ponerEnBucket(a.key, "application/pdf", Buffer.from(a.bytes));
            publicadas.push(a);
          } catch (e) {
            if (yaExiste(e)) publicadas.push(a);
            else fallo = true;
          }
        }
      }),
    );
    if (publicadas.length > 0) {
      await ctx.runMutation(internal.subidas.registrarPublicadas, {
        carpeta: destino.carpeta,
        userId: destino.userId,
        archivos: publicadas.map(({ key, url, bytes }) => ({ key, url, bytes: bytes.byteLength })),
      });
    }
    // Sin detalles de AWS: el registro del servidor los tiene.
    if (fallo) throw new Error("No se pudo publicar el PDF de una factura. Intenta de nuevo.");
    return archivos.map(({ key, url }) => ({ key, publicUrl: url }));
  },
});

/**
 * El archivo de una subida intermediada (`subidas.recibirSubida`), ya
 * revisado allí: enlace válido, tamaño y tipo por contenido. Llega por el
 * almacenamiento interno de Convex porque una acción Node solo recibe 5 MiB.
 */
export const publicarSubida = internalAction({
  args: { storageId: v.id("_storage"), key: v.string(), contentType: v.string() },
  handler: async (ctx, args): Promise<null> => {
    const archivo = await ctx.storage.get(args.storageId);
    if (!archivo) throw new Error("No se encontró el archivo de la subida.");
    await ponerEnBucket(args.key, args.contentType, Buffer.from(await archivo.arrayBuffer()));
    return null;
  },
});

/**
 * Publica un PUT directo (`generateUploadUrl` con `size`) después de mirar
 * el objeto que de verdad llegó a su llave provisional:
 *   1. su tamaño real (`HeadObject`), que tiene que ser el firmado y no pasar
 *      el de su categoría;
 *   2. sus primeros bytes (`GetObject` con `Range`, 1 KB: no se baja el
 *      archivo), que tienen que ser de un tipo permitido;
 *   3. si pasa, una copia dentro de S3 (no pasa por aquí: sirve para las
 *      grabaciones de 50 MiB) a su llave definitiva con el tipo verificado, y
 *      la subida queda validada para registrarse. Si no pasa, se borra y no
 *      se publica nada.
 * Destino, categoría, tamaño y tipo declarado salen de la subida guardada al
 * firmar, no del cliente; solo puede confirmarla quien la pidió.
 */
export const confirmarSubida = action({
  args: { key: v.string() },
  handler: async (ctx, args): Promise<{ key: string; publicUrl: string }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("No autenticado.");
    const subida = await ctx.runQuery(internal.subidas.paraConfirmar, { key: args.key });
    if (!subida) throw new Error(MENSAJE_SUBIDA_NO_VALIDA);

    const { bucket } = requireS3Env();
    const client = s3Client();
    const descartar = async (mensaje: string): Promise<never> => {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: subida.claveTemporal })).catch(() => {});
      await ctx.runMutation(internal.subidas.descartar, { key: subida.key });
      throw new Error(mensaje);
    };
    const categoria: Categoria | undefined = CATEGORIAS[subida.categoria as NombreCategoria];
    if (!categoria) return await descartar(MENSAJE_SUBIDA_NO_VALIDA);

    // 1. El tamaño real.
    let bytes: number;
    try {
      const cabeza = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: subida.claveTemporal }));
      bytes = Number(cabeza.ContentLength);
    } catch {
      throw new Error("El archivo no llegó. Vuelve a intentarlo.");
    }
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes !== subida.size || bytes > categoria.maxBytes) {
      return await descartar(MENSAJE_ARCHIVO_GRANDE);
    }

    // 2. El tipo real, por sus primeros bytes.
    const parte = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: subida.claveTemporal, Range: `bytes=0-${BYTES_CABECERA - 1}` }),
    );
    const cabecera = parte.Body ? (await parte.Body.transformToByteArray()).subarray(0, BYTES_CABECERA) : new Uint8Array();
    const permitidos = categoria.tipos.filter((t) => !categoria.soloServidor?.includes(t));
    const tipo = tipoVerificado(cabecera, subida.tipoDeclarado, permitidos);
    if (!tipo) return await descartar(MENSAJE_CONTENIDO);

    // 3. Publicar con el tipo verificado.
    await client.send(
      new CopyObjectCommand({
        Bucket: bucket,
        Key: subida.key,
        CopySource: `${bucket}/${subida.claveTemporal}`,
        MetadataDirective: "REPLACE",
        ContentType: tipo,
        ...(TIPOS_DESCARGA.has(tipo) ? { ContentDisposition: "attachment" } : {}),
      }),
    );
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: subida.claveTemporal })).catch(() => {});
    try {
      await ctx.runMutation(internal.subidas.marcarValidada, { key: subida.key, tipo, bytes });
    } catch (e) {
      // Venció o se descartó mientras tanto: no queda publicado.
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: subida.key })).catch(() => {});
      throw e;
    }
    return { key: subida.key, publicUrl: publicUrlFor(subida.key) };
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

    /* La media la manda cualquiera por WhatsApp: no se rechaza (el mensaje ya
     * llegó), pero se guarda con el tipo que dicen sus bytes, y lo que no es
     * un tipo pasivo conocido (HTML, SVG, desconocido) va como binario para
     * descargar. Nunca se sirve un HTML desde el bucket. */
    const { contentType, descarga } = tipoNeutralizado(
      bytes.subarray(0, BYTES_CABECERA),
      args.contentType || response.headers.get("content-type"),
    );

    return await subirAlBucket(args.folder, args.fileName, contentType, bytes, descarga);
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
