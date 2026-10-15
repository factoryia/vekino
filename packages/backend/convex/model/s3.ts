import { internal } from "../_generated/api";
import { TRAMO_DE_LLAVE } from "../lib/comprobantes";

type SchedulerCtx = {
  scheduler: {
    // Convex MutationCtx.scheduler — tipado laxo para evitar acoplar a codegen.
    runAfter: (delayMs: number, fn: any, args: any) => Promise<unknown>;
  };
};

/** Extrae el object key de una URL pública de nuestro bucket S3. */
export function s3KeyFromPublicUrl(
  url: string | null | undefined,
): string | null {
  if (!url?.trim()) return null;
  try {
    const u = new URL(url.trim());
    const host = u.hostname;
    const path = decodeURIComponent(u.pathname.replace(/^\/+/, ""));
    if (!path) return null;

    const bucket = process.env.AWS_S3_BUCKET_NAME?.trim();
    if (bucket) {
      if (
        host === `${bucket}.s3.amazonaws.com` ||
        host.startsWith(`${bucket}.s3.`)
      ) {
        return path;
      }
      // path-style: s3.region.amazonaws.com/bucket/key
      if (
        (host.startsWith("s3.") || host === "s3.amazonaws.com") &&
        path.startsWith(`${bucket}/`)
      ) {
        return path.slice(bucket.length + 1) || null;
      }
      return null;
    }

    if (host.includes(".amazonaws.com")) return path;
  } catch {
    /* ignore */
  }
  return null;
}

/** La llave de un archivo guardado: su `s3Key`, o la que sale de su URL. */
export function llaveDeArchivo(
  s3Key: string | null | undefined,
  url: string | null | undefined,
): string | null {
  return s3Key?.trim() || s3KeyFromPublicUrl(url) || null;
}

/* ── Carpetas de cada entidad ────────────────────────────────────────────────
 *
 * Las mismas que mandan la web y el móvil al subir (`files.generateUploadUrl`
 * / `uploadBytes`), pero armadas aquí con datos de la base: el conjunto del
 * registro, o el usuario de la sesión. Un borrado solo alcanza llaves de la
 * carpeta de SU entidad; nunca la que diga el cliente.
 */

/** Fotos de perfil: una carpeta por usuario. `files.ts` la impone al subir. */
export const CARPETA_AVATARES = "avatars";
export const carpetaAvatar = (userId: string) => `${CARPETA_AVATARES}/${userId}`;
export const carpetaDocumentos = (condominioId: string) =>
  `condominios/documentos/${condominioId}`;
export const carpetaComunicados = (condominioId: string) =>
  `condominios/comunicados/${condominioId}`;
export const carpetaConsejo = (condominioId: string) =>
  `condominios/${condominioId}/consejo`;

/** Mensaje estable cuando el cliente manda una llave que no es de la entidad. */
export const MENSAJE_ARCHIVO_AJENO =
  "El archivo no corresponde a este registro. Súbelo de nuevo.";

/**
 * Si `key` es una llave que armó `files.ts` (`buildObjectKey`) directamente
 * dentro de `carpeta`: la carpeta exacta y el último tramo
 * (`{Date.now()}-{8 hex}-{nombre saneado}`). Comparación exacta de texto: sin
 * subcarpetas, `..`, `//` ni barras en el tramo. Una llave de otro conjunto,
 * de otra entidad o de otro usuario no pasa.
 */
export function esLlaveDeCarpeta(
  key: string | null | undefined,
  carpeta: string,
): key is string {
  if (!key) return false;
  const prefijo = `${carpeta}/`;
  return key.startsWith(prefijo) && TRAMO_DE_LLAVE.test(key.slice(prefijo.length));
}

/**
 * La llave que manda el cliente, si la manda, tiene que ser de la carpeta de
 * la entidad: así nunca queda guardada una llave ajena que un borrado
 * posterior pudiera alcanzar.
 */
export function exigirLlaveDeCarpeta(
  s3Key: string | null | undefined,
  carpeta: string,
): string | undefined {
  const key = s3Key?.trim();
  if (!key) return undefined;
  if (!esLlaveDeCarpeta(key, carpeta)) throw new Error(MENSAJE_ARCHIVO_AJENO);
  return key;
}

/**
 * Programa el borrado async de objetos S3 (no bloquea la mutación).
 *
 * `carpeta` la arma quien llama con datos de la base (las funciones de
 * arriba). Solo se borran las llaves de esa carpeta (`esLlaveDeCarpeta`); el
 * resto se ignora: ante la duda, el objeto se queda. Así, un `s3Key` o una
 * URL guardados con datos del cliente no pueden borrar el archivo de otro
 * conjunto, de otra entidad ni de otro usuario.
 */
export async function scheduleDeleteS3Keys(
  ctx: SchedulerCtx,
  carpeta: string,
  keys: Array<string | null | undefined>,
) {
  const unique = [
    ...new Set(
      keys
        .map((k) => k?.trim())
        .filter((k): k is string => esLlaveDeCarpeta(k, carpeta)),
    ),
  ];
  await Promise.all(
    unique.map((key) =>
      ctx.scheduler.runAfter(0, internal.files.deleteObjectInternal, { key }),
    ),
  );
}
