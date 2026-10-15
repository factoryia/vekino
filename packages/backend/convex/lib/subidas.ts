/**
 * Qué se puede subir a S3, cuánto, y cómo se reconoce por su contenido
 * (H-06 de la auditoría de S3, qa/factory/auditoria-s3-2026-10-14).
 *
 * Lo usan `subidas.ts` (quién puede subir a cada carpeta), `files.ts` (la
 * subida en sí) y la ruta `/archivos/subida` (la subida intermediada). Sin
 * imports de Convex: corre igual en el runtime de Convex, en Node y en las
 * pruebas.
 *
 * Las listas salen de lo que de verdad suben la web y el móvil (el `accept`
 * de cada pantalla y lo que mandan los celulares, HEIC incluido: el selector
 * de iOS lo entrega tal cual).
 */

const MiB = 1024 * 1024;

/**
 * Techo de la subida intermediada (`/archivos/subida`): el cuerpo se lee en el
 * runtime de Convex, que tiene 64 MiB de memoria, y se guarda una copia antes
 * de pasar a S3. Con 20 MiB caben las dos con margen.
 */
export const MAX_INTERMEDIADA = 20 * MiB;

/**
 * Carpeta provisional del PUT directo (URL firmada). El objeto queda aquí,
 * con una llave aleatoria, hasta que `files.confirmarSubida` lee su
 * contenido; solo entonces se copia a su llave definitiva con el tipo
 * verificado. Lo que nunca se confirma se borra al vencer.
 */
export const CARPETA_TEMPORAL = "pendientes";

/** Plazo para subir y confirmar un PUT directo (la URL vale 10 minutos). */
export const VIGENCIA_PENDIENTE_DIRECTA_MS = 20 * 60 * 1000;

/**
 * Plazo para registrar una subida ya validada en su entidad: las pantallas
 * suben al guardar y registran enseguida; un día cubre reintentos.
 */
export const VIGENCIA_REGISTRO_MS = 24 * 60 * 60 * 1000;

/* ── Tipos ────────────────────────────────────────────────────────────────── */

const IMAGENES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif"];
const PDF = ["application/pdf"];
const WORD = [
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];
const EXCEL = [
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];
const POWERPOINT = [
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
];
const TEXTO = ["text/plain", "text/csv"];
const VIDEO = ["video/mp4", "video/quicktime", "video/webm", "video/3gpp"];
const AUDIO = ["audio/ogg", "audio/webm", "audio/mp4", "audio/x-m4a", "audio/mpeg", "audio/aac"];

/**
 * El SVG puede llevar scripts. Solo se acepta para los íconos del consejo y
 * solo por el servidor, que lo guarda con `Content-Disposition: attachment`:
 * en un `<img>` se ve igual, pero abierto directo se descarga en vez de
 * ejecutarse. Por URL firmada no se puede imponer esa cabecera, así que por
 * ahí no se acepta.
 */
const SVG = "image/svg+xml";

/** Lo que se guarda con `Content-Disposition: attachment`. */
export const TIPOS_DESCARGA = new Set([SVG]);

export type Categoria = {
  /** Tipos aceptados (normalizados). */
  tipos: readonly string[];
  /** Tamaño máximo. */
  maxBytes: number;
  /** Tipos que solo pueden subirse por el servidor (ver `SVG`). */
  soloServidor?: readonly string[];
};

/**
 * Cada uso, con sus tipos y su límite. Los límites cubren lo que permiten hoy
 * las pantallas (15–20 MB en la web; el móvil no limita y manda fotos de 2–6
 * MB) y una parte de grabación de asamblea: 60 s a ~2,6 Mbit/s son ~20 MB, y
 * si una falla se reintenta junto con la siguiente.
 */
export const CATEGORIAS = {
  imagen: { tipos: IMAGENES, maxBytes: 20 * MiB },
  iconoConsejo: { tipos: [...IMAGENES, SVG], maxBytes: 20 * MiB, soloServidor: [SVG] },
  adjunto: { tipos: [...IMAGENES, ...PDF], maxBytes: 20 * MiB },
  documento: { tipos: [...IMAGENES, ...PDF, ...WORD, ...EXCEL, ...POWERPOINT, ...TEXTO], maxBytes: 25 * MiB },
  comunicado: { tipos: [...IMAGENES, ...PDF, ...WORD, ...EXCEL], maxBytes: 25 * MiB },
  pdfOImagen: { tipos: [...IMAGENES, ...PDF], maxBytes: 25 * MiB },
  novedad: { tipos: [...IMAGENES, ...PDF, ...VIDEO], maxBytes: 20 * MiB },
  grabacion: { tipos: ["video/webm"], maxBytes: 50 * MiB },
  whatsapp: { tipos: [...IMAGENES, ...PDF, ...AUDIO, ...VIDEO], maxBytes: 20 * MiB },
  /* El PDF de cada factura de una importación. No lo sube ningún cliente: lo
   * publica el servidor (`files.publicarFacturas`) con los bytes que leyó la
   * confirmación (`/api/facturas/confirmar`). */
  facturaPdf: { tipos: PDF, maxBytes: 25 * MiB },
} satisfies Record<string, Categoria>;

export type NombreCategoria = keyof typeof CATEGORIAS;

/** Mensajes estables: la web los muestra tal cual. */
export const MENSAJE_TIPO_NO_PERMITIDO = "Ese tipo de archivo no se puede subir aquí.";
export const MENSAJE_ARCHIVO_GRANDE = "El archivo supera el tamaño permitido.";
export const MENSAJE_CONTENIDO = "El contenido del archivo no corresponde a un tipo permitido.";
export const MENSAJE_SUBIDA_NO_VALIDA = "La subida no existe o ya venció. Vuelve a subir el archivo.";

/**
 * El tipo como lo manda el navegador o el celular, en minúsculas, sin
 * parámetros (`audio/webm;codecs=opus` → `audio/webm`) y con los alias de
 * siempre. `""` si no hay tipo (o es el genérico).
 */
export function normalizarTipo(contentType: string | null | undefined): string {
  const base = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  const alias: Record<string, string> = {
    "image/jpg": "image/jpeg",
    "image/pjpeg": "image/jpeg",
    "audio/mp3": "audio/mpeg",
    "audio/m4a": "audio/x-m4a",
    "application/x-pdf": "application/pdf",
  };
  const tipo = alias[base] ?? base;
  return tipo === "application/octet-stream" ? "" : tipo;
}

/* ── Contenido ────────────────────────────────────────────────────────────── */

/** Familias que se reconocen por sus primeros bytes. */
type Firma =
  | "jpeg" | "png" | "gif" | "webp" | "heic" | "pdf"
  | "ebml" | "ogg" | "isobmff" | "audio-mpeg" | "wav"
  | "zip" | "ole" | "texto" | "svg" | "marcado";

const FIRMA_DE_TIPO: Record<string, Firma> = {
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heic",
  [SVG]: "svg",
  "application/pdf": "pdf",
  "video/webm": "ebml",
  "audio/webm": "ebml",
  "audio/ogg": "ogg",
  "video/mp4": "isobmff",
  "audio/mp4": "isobmff",
  "audio/x-m4a": "isobmff",
  "video/quicktime": "isobmff",
  "video/3gpp": "isobmff",
  "audio/mpeg": "audio-mpeg",
  "audio/aac": "audio-mpeg",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "application/msword": "ole",
  "application/vnd.ms-excel": "ole",
  "application/vnd.ms-powerpoint": "ole",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "zip",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "zip",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "zip",
  "text/plain": "texto",
  "text/csv": "texto",
};

/**
 * El tipo de cada familia cuando no hay otro dato. Las ambiguas (ZIP, OLE) no
 * tienen. El texto queda como `text/plain`: Windows con Excel etiqueta los
 * `.csv` como `application/vnd.ms-excel`, y así se guardan igual, como texto.
 */
const TIPO_DE_FIRMA: Partial<Record<Firma, string>> = {
  texto: "text/plain",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  pdf: "application/pdf",
  ebml: "video/webm",
  ogg: "audio/ogg",
  isobmff: "video/mp4",
  "audio-mpeg": "audio/mpeg",
  wav: "audio/wav",
  svg: SVG,
};

const MARCAS_HEIC = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1"]);

/** Cuántos bytes del principio hacen falta para reconocer el tipo. */
export const BYTES_CABECERA = 1024;

/**
 * La familia del archivo por sus primeros bytes (`BYTES_CABECERA` bastan), o
 * `null` si no se reconoce. El texto se distingue del marcado (HTML, XML,
 * SVG), que nunca se acepta como texto.
 */
export function firmaPorContenido(bytes: Uint8Array): Firma | null {
  const b = bytes;
  const es = (firma: number[], desde = 0) => firma.every((n, i) => b[desde + i] === n);
  const ascii = (desde: number, largo: number) =>
    String.fromCharCode(...b.subarray(desde, desde + largo));

  if (es([0xff, 0xd8, 0xff])) return "jpeg";
  if (es([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return "gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "webp";
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE") return "wav";
  if (ascii(0, 5) === "%PDF-") return "pdf";
  if (es([0x1a, 0x45, 0xdf, 0xa3])) return "ebml";
  if (ascii(0, 4) === "OggS") return "ogg";
  if (ascii(4, 4) === "ftyp") return MARCAS_HEIC.has(ascii(8, 4)) ? "heic" : "isobmff";
  if (ascii(0, 3) === "ID3" || (b[0] === 0xff && b.length > 1 && (b[1]! & 0xe0) === 0xe0)) return "audio-mpeg";
  if (es([0x50, 0x4b, 0x03, 0x04])) return "zip";
  if (es([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return "ole";

  // Texto: sin bytes nulos en la cabecera. Si es marcado, no es texto.
  const cabecera = b.subarray(0, BYTES_CABECERA);
  if (cabecera.length === 0 || cabecera.includes(0)) return null;
  const texto = new TextDecoder("utf-8", { fatal: false })
    .decode(cabecera)
    .replace(/^\uFEFF/, "")
    .trimStart()
    .toLowerCase();
  if (texto.includes("<svg")) return "svg";
  if (/^<(!doctype|html|head|body|script|iframe|\?xml|svg|meta|object|embed|a\s|div|img)/.test(texto)) {
    return "marcado";
  }
  return "texto";
}

/**
 * El tipo con el que se guarda el archivo, si su contenido lo justifica:
 *   - el que declaró el cliente, si está permitido y los bytes son de esa
 *     familia;
 *   - si no (sin tipo, o mal puesto), el de la familia que dicen los bytes,
 *     si está permitido;
 *   - si no, `null`: no se sube.
 * Así el `Content-Type` que sirve S3 nunca sale solo de lo que dijo el cliente.
 */
export function tipoVerificado(
  cabecera: Uint8Array,
  declarado: string | null | undefined,
  permitidos: readonly string[],
): string | null {
  const firma = firmaPorContenido(cabecera);
  if (!firma) return null;
  const tipo = normalizarTipo(declarado);
  if (tipo && permitidos.includes(tipo) && FIRMA_DE_TIPO[tipo] === firma) return tipo;
  const deFirma = TIPO_DE_FIRMA[firma];
  return deFirma && permitidos.includes(deFirma) ? deFirma : null;
}

/**
 * El tipo con el que se guarda un archivo que llega por un webhook (la media
 * de WhatsApp): no se rechaza nada —el mensaje ya llegó—, pero lo que no se
 * reconoce como pasivo se guarda como binario y para descargar. Nunca queda
 * un HTML o un SVG servido como tal desde el bucket.
 */
export function tipoNeutralizado(
  cabecera: Uint8Array,
  declarado: string | null | undefined,
): { contentType: string; descarga: boolean } {
  const firma = firmaPorContenido(cabecera);
  if (!firma || firma === "svg" || firma === "marcado") {
    return { contentType: "application/octet-stream", descarga: true };
  }
  const tipo = normalizarTipo(declarado);
  if (tipo && FIRMA_DE_TIPO[tipo] === firma) return { contentType: tipo, descarga: false };
  const deFirma = TIPO_DE_FIRMA[firma];
  return deFirma
    ? { contentType: deFirma, descarga: false }
    : { contentType: "application/octet-stream", descarga: true };
}
