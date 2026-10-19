import { createHash } from "crypto";
import { PDFDocument } from "pdf-lib";
import { extraerTextoConLayout } from "./pdf-layout";
import { leerFacturas, type ErrorDeLectura, type FacturaLeida } from "./parser";

/**
 * Lectura de un PDF de cuentas de cobro en el servidor: lo comparten la vista
 * previa (`/api/facturas/upload`) y la confirmación (`/api/facturas/confirmar`),
 * para que lo que se confirma sea exactamente lo que se vio.
 *
 * No escribe nada en ningún lado.
 */
export type PdfLeido = {
  /** SHA-256 del archivo: así la confirmación sabe que es el mismo de la vista previa. */
  hash: string;
  doc: PDFDocument;
  facturas: FacturaLeida[];
  errores: ErrorDeLectura[];
  totalPaginas: number;
};

/**
 * El archivo no se pudo abrir o recorrer como PDF: vacío, de texto con
 * extensión .pdf, cortado, cifrado. Es un problema del archivo, no del
 * servidor. Lo que falle después, al interpretar el texto, no entra aquí.
 */
export class PdfIlegible extends Error {
  constructor(causa: unknown) {
    super(causa instanceof Error ? causa.message : String(causa));
    this.name = "PdfIlegible";
  }
}

/** Lo que ve quien sube un `PdfIlegible`, en la vista previa y en la confirmación (422). */
export const MENSAJE_PDF_ILEGIBLE = "El archivo no es un PDF válido o está dañado. Revísalo y vuelve a subirlo.";

export function hashDe(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function leerPdf(bytes: Uint8Array): Promise<PdfLeido> {
  const { doc, textos } = await abrirPdf(bytes);
  const { facturas, errores } = leerFacturas(textos);
  return { hash: hashDe(bytes), doc, facturas, errores, totalPaginas: doc.getPageCount() };
}

async function abrirPdf(bytes: Uint8Array): Promise<{ doc: PDFDocument; textos: string[] }> {
  try {
    const doc = await PDFDocument.load(bytes);
    /* Texto por página: cada una se extrae sola, con sus columnas en su sitio
     * (ver pdf-layout.ts), y después se agrupan por factura. */
    const textos: string[] = [];
    for (let i = 0; i < doc.getPageCount(); i++) {
      const una = await PDFDocument.create();
      const [pagina] = await una.copyPages(doc, [i]);
      una.addPage(pagina);
      textos.push(await extraerTextoConLayout(await una.save()));
    }
    return { doc, textos };
  } catch (e) {
    throw new PdfIlegible(e);
  }
}

/**
 * El PDF de una sola factura (sus páginas), para publicarlo. Sin fecha de
 * creación en los metadatos: el mismo documento da los mismos bytes, y un
 * reintento cae en la misma llave de S3 (que lleva la huella del contenido).
 */
export async function pdfDeFactura(doc: PDFDocument, paginas: readonly number[]): Promise<Uint8Array> {
  const salida = await PDFDocument.create({ updateMetadata: false });
  const copiadas = await salida.copyPages(doc, paginas.map((p) => p - 1));
  copiadas.forEach((p) => salida.addPage(p));
  return await salida.save();
}
