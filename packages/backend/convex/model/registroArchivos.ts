import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { s3KeyFromPublicUrl } from "./s3";

/**
 * QUÉ ARCHIVO PUEDE REGISTRAR UNA ENTIDAD (H-12 de la auditoría de S3,
 * qa/factory/auditoria-s3-2026-10-14).
 *
 * Antes, las mutaciones guardaban la URL que mandara el cliente: la de otro
 * conjunto, una externa o una que nunca se subió. Ahora un archivo NUEVO
 * solo se registra si viene de una subida (`subidasPendientes`):
 *   - de quien registra;
 *   - a la carpeta de esa entidad (la arma quien llama con datos de la base);
 *   - validada: el servidor leyó el objeto y su contenido es de un tipo
 *     permitido (`subidas.ts`, `files.confirmarSubida`);
 *   - sin vencer y sin haberse registrado ya (un solo uso; los poderes, que
 *     se otorgan por varias casas con el mismo documento, la reutilizan);
 *   - con la URL exacta que el servidor le devolvió al subir: la misma llave
 *     en otro host (`https://vekino.s3.otro-sitio.test/…`), con `?…`, `#…`
 *     u otra forma de escribirla no es esa subida.
 *
 * Lo que el registro ya tenía (`previas`) se conserva sin más: editar un
 * formulario reenvía sus archivos tal cual, y las referencias de antes de
 * esta regla no se pueden atribuir a una subida. Pero nunca se acepta como
 * NUEVA una URL que no salga de una subida: ni una antigua, ni una externa.
 */

/** Mensaje estable. */
export const MENSAJE_ARCHIVO_NO_AUTORIZADO =
  "Ese archivo no se subió para este registro. Vuelve a subirlo.";

/** Una referencia a un archivo, como la manda el cliente. */
export type RefArchivo = { url?: string | null; s3Key?: string | null };

type Previa = RefArchivo | string | null | undefined;

const limpio = (s: string | null | undefined) => s?.trim() || undefined;

/** La llave de una referencia: su `s3Key`, o la de su URL si es del bucket. */
function llaveDe(ref: RefArchivo): string | undefined {
  return limpio(ref.s3Key) ?? (limpio(ref.url) ? s3KeyFromPublicUrl(limpio(ref.url)) ?? undefined : undefined);
}

/**
 * Si la referencia es una de las que el registro ya tenía, sin cambiar: la
 * misma URL, texto a texto (y la misma llave, si la manda). Sin URL, la misma
 * llave. Una URL distinta que apunte a la misma llave no "ya estaba": es una
 * referencia nueva y se revisa como tal.
 */
function yaEstaba(ref: RefArchivo, previas: Previa[]): boolean {
  const url = limpio(ref.url);
  const s3Key = limpio(ref.s3Key);
  return previas.some((p) => {
    const previa: RefArchivo = typeof p === "string" ? { url: p } : p ?? {};
    if (url) return url === limpio(previa.url) && (!s3Key || s3Key === llaveDe(previa));
    return Boolean(s3Key && s3Key === llaveDe(previa));
  });
}

/**
 * Exige que `ref` sea un archivo que esta entidad puede registrar (ver
 * arriba) y marca la subida como registrada. Sin archivo (`url` y `s3Key`
 * vacíos) no hace nada. Lanza `MENSAJE_ARCHIVO_NO_AUTORIZADO` si no.
 */
export async function exigirArchivoSubido(
  ctx: MutationCtx,
  userId: Id<"users">,
  ref: RefArchivo,
  carpeta: string,
  opciones: { previas?: Previa[]; reutilizable?: boolean } = {},
): Promise<void> {
  const url = limpio(ref.url);
  const s3Key = limpio(ref.s3Key);
  if (!url && !s3Key) return;

  // URL y llave tienen que ser el mismo objeto (si no, se mostraría uno y se
  // contaría otro).
  if (url && s3Key && s3KeyFromPublicUrl(url) !== s3Key) {
    throw new Error(MENSAJE_ARCHIVO_NO_AUTORIZADO);
  }
  if (yaEstaba(ref, opciones.previas ?? [])) return;

  const llave = llaveDe(ref);
  if (!llave || !llave.startsWith(`${carpeta}/`)) throw new Error(MENSAJE_ARCHIVO_NO_AUTORIZADO);
  const subida = await ctx.db
    .query("subidasPendientes")
    .withIndex("by_key", (q) => q.eq("key", llave))
    .first();
  if (
    !subida ||
    subida.estado !== "validada" ||
    subida.userId !== userId ||
    subida.carpeta !== carpeta ||
    subida.expiraEn < Date.now() ||
    (subida.registradaEn !== undefined && !opciones.reutilizable) ||
    (url !== undefined && url !== subida.url)
  ) {
    throw new Error(MENSAJE_ARCHIVO_NO_AUTORIZADO);
  }
  if (subida.registradaEn === undefined) {
    await ctx.db.patch(subida._id, { registradaEn: Date.now() });
  }
}

/** `exigirArchivoSubido` para una lista (fotos): cada una, contra la misma carpeta. */
export async function exigirArchivosSubidos(
  ctx: MutationCtx,
  userId: Id<"users">,
  refs: RefArchivo[],
  carpeta: string,
  opciones: { previas?: Previa[] } = {},
): Promise<void> {
  for (const ref of refs) await exigirArchivoSubido(ctx, userId, ref, carpeta, opciones);
}
