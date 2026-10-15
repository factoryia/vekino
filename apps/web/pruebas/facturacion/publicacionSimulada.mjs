import { createHash } from "node:crypto";

/**
 * `files.publicarFacturas` simulado, para las pruebas de /api/facturas/confirmar.
 *
 * Desde la Fase 5 de S3 la ruta ya no escribe en S3: le manda a Convex el PDF
 * de cada factura y usa la URL que le devuelve. Esto hace lo que hace el
 * backend, con sus mismas reglas a la vista de la ruta: la llave la arma el
 * servidor bajo la carpeta de la importación (`destino`), con la casa y la
 * huella del contenido; solo acepta PDF; nunca sobrescribe (una llave que ya
 * existe se da por publicada, como con `If-None-Match: *`). Lo publicado se
 * anota en `registro()` con la forma de un `PutObject`.
 *
 * Las reglas de verdad (permiso, tipo, registro de la subida) las prueba
 * packages/backend/pruebas/pdfFacturas.test.ts contra el backend.
 */
export const URL_BUCKET = "https://vekino.s3.us-east-1.amazonaws.com";

export function publicacionSimulada({ destino, registro }) {
  const enS3 = new Set();
  return {
    /** Vacía el bucket simulado. */
    olvidar: () => enS3.clear(),
    async publicarFacturas({ importacionId, pdfs }) {
      const carpeta = destino(importacionId);
      const archivos = pdfs.map(({ unidad, bytes }) => {
        const b = new Uint8Array(bytes);
        if (b.byteLength === 0) throw new Error("Archivo vacío.");
        if (String.fromCharCode(...b.subarray(0, 5)) !== "%PDF-") {
          throw new Error("El contenido del archivo no corresponde a un tipo permitido.");
        }
        const casa = (unidad || "sin-unidad").replace(/[^A-Za-z0-9-]/g, "_").slice(0, 40);
        const huella = createHash("sha256").update(b).digest("hex").slice(0, 12);
        return { key: `${carpeta}/unidad-${casa}-${huella}.pdf`, bytes: b };
      });
      return archivos.map(({ key, bytes }) => {
        if (!enS3.has(key)) {
          enS3.add(key);
          registro().push({ Key: key, ContentType: "application/pdf", IfNoneMatch: "*", Body: bytes });
        }
        return { key, publicUrl: `${URL_BUCKET}/${key}` };
      });
    },
  };
}
