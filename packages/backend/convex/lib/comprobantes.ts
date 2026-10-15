import { v } from "convex/values";

/**
 * El archivo de un comprobante de pago y su URL (Hallazgo 1,
 * docs/audits/FALTANTES-WEB-FACTURACION.md).
 *
 * Lo usan `soportesPago.enviarMio` (el archivo llega al backend),
 * `soportesPago.crearMio` (la URL que manda el móvil), `files.ts` (la URL
 * pública) y la web (`@vekino/backend/comprobantes`), para que el límite, los
 * tipos y el formato de la URL no se escriban dos veces.
 */

/**
 * Hasta 10 MB: una foto de celular pesa 2–6 MB y el PDF de un banco menos de
 * 1 MB. Viaja como argumento de una acción del runtime de Convex (hasta
 * 16 MiB), en base64: 10 MiB son 13,3 MiB. A una acción Node (5 MiB) no le
 * cabría.
 */
export const MAX_COMPROBANTE_BYTES = 10 * 1024 * 1024;

/**
 * Lo que la pantalla "Comprobantes" de la administración puede mostrar: pinta
 * con `<img>` lo que empiece por `image/` y con "Ver PDF" lo demás. HEIC no se
 * ve en Chrome ni en Firefox.
 */
export const TIPOS_COMPROBANTE = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
] as const;

export type TipoComprobante = (typeof TIPOS_COMPROBANTE)[number];

export const vTipoComprobante = v.union(
  v.literal("image/jpeg"),
  v.literal("image/png"),
  v.literal("image/webp"),
  v.literal("application/pdf"),
);

/* Mensajes estables: la web los muestra tal cual. */
export const MENSAJE_COMPROBANTE_VACIO = "El archivo del comprobante está vacío.";
export const MENSAJE_COMPROBANTE_GRANDE = "El archivo del comprobante pesa más de 10 MB.";
export const MENSAJE_COMPROBANTE_TIPO =
  "El comprobante debe ser una foto JPG, PNG o WebP, o un PDF.";
export const MENSAJE_COMPROBANTE_URL =
  "El archivo del comprobante no es válido: envíalo de nuevo desde la app.";

/**
 * El tipo del archivo según sus primeros bytes, no según lo que diga el
 * cliente. `null` si no es ninguno de los permitidos.
 */
export function tipoPorContenido(archivo: ArrayBuffer | Uint8Array): TipoComprobante | null {
  const b =
    archivo instanceof Uint8Array
      ? archivo
      : new Uint8Array(archivo, 0, Math.min(12, archivo.byteLength));
  const empieza = (firma: number[], desde = 0) => firma.every((n, i) => b[desde + i] === n);
  if (empieza([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (empieza([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (empieza([0x52, 0x49, 0x46, 0x46]) && empieza([0x57, 0x45, 0x42, 0x50], 8)) return "image/webp"; // RIFF....WEBP
  if (empieza([0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"; // %PDF-
  return null;
}

/** El tipo del archivo si se puede guardar; si no, lanza el mensaje estable. */
export function exigirArchivoComprobante(archivo: {
  bytes: number;
  tipo: TipoComprobante | null;
}): TipoComprobante {
  if (!(archivo.bytes > 0)) throw new Error(MENSAJE_COMPROBANTE_VACIO);
  if (archivo.bytes > MAX_COMPROBANTE_BYTES) throw new Error(MENSAJE_COMPROBANTE_GRANDE);
  if (!archivo.tipo || !TIPOS_COMPROBANTE.includes(archivo.tipo)) {
    throw new Error(MENSAJE_COMPROBANTE_TIPO);
  }
  return archivo.tipo;
}

/** La carpeta de los comprobantes de un conjunto. La decide el servidor. */
export function carpetaComprobantes(condominioId: string): string {
  return `condominios/soportes/${condominioId}`;
}

export type BucketPublico = { bucket: string; region: string };

/**
 * El bucket público, leído como lo lee `files.ts`. `null` si no está
 * configurado: sin él, `generateUploadUrl` no firma nada.
 */
export function bucketPublico(env: Record<string, string | undefined>): BucketPublico | null {
  const bucket = env.AWS_S3_BUCKET_NAME;
  if (!bucket) return null;
  return { bucket, region: env.AWS_REGION ?? "us-east-1" };
}

/** La URL pública de una llave. Es la que devuelve `files.generateUploadUrl`. */
export function urlPublica(destino: BucketPublico, key: string): string {
  return `https://${destino.bucket}.s3.${destino.region}.amazonaws.com/${key}`;
}

/**
 * El último tramo de la llave que arma `files.ts` (`buildObjectKey`):
 * `{Date.now()}-{8 hex de un UUID}-{nombre saneado}`. El nombre saneado solo
 * tiene `[A-Za-z0-9._-]`, hasta 120 caracteres, y puede quedar vacío. Sin `/`
 * no hay `..` como tramo ni dobles barras; sin `?`, `#` ni `%`, nada más.
 */
export const TRAMO_DE_LLAVE = /^\d{13}-[0-9a-f]{8}-[A-Za-z0-9._-]{0,120}$/;

/**
 * Si `url` es la de un archivo subido con `generateUploadUrl` a la carpeta de
 * comprobantes de ESE conjunto, en el bucket de Vekino. Comparación exacta de
 * texto: no se normaliza la URL, así que `..`, `//` o un host parecido no
 * pasan.
 */
export function esUrlDeComprobante(
  url: string,
  condominioId: string,
  destino: BucketPublico,
): boolean {
  const prefijo = urlPublica(destino, `${carpetaComprobantes(condominioId)}/`);
  return url.startsWith(prefijo) && TRAMO_DE_LLAVE.test(url.slice(prefijo.length));
}
