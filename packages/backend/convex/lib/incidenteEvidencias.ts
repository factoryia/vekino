/** El mismo techo del transporte server-side de files.uploadBytes, sin fallback público. */
export const MAX_EVIDENCIA_BYTES = 15 * 1024 * 1024;
export const EVIDENCIA_MIMES = ["image/jpeg", "image/png", "image/webp", "application/pdf"] as const;
export const EVIDENCIA_ACCEPT = EVIDENCIA_MIMES.join(",");

export function validarArchivoEvidencia(archivo: { nombre: string; mimeType: string; size: number }) {
  const nombre = archivo.nombre.trim();
  if (!nombre || nombre.length > 120 || /[\x00-\x1f\x7f/\\]/.test(nombre)) {
    throw new Error("El nombre debe tener entre 1 y 120 caracteres, sin rutas ni caracteres de control.");
  }
  if (!EVIDENCIA_MIMES.includes(archivo.mimeType as typeof EVIDENCIA_MIMES[number])) {
    throw new Error("Solo se admiten imágenes JPEG, PNG, WebP y documentos PDF.");
  }
  const extensiones: Record<string, RegExp> = {
    "image/jpeg": /\.jpe?g$/i, "image/png": /\.png$/i,
    "image/webp": /\.webp$/i, "application/pdf": /\.pdf$/i,
  };
  if (!extensiones[archivo.mimeType]!.test(nombre)) throw new Error("La extensión no coincide con el tipo de archivo.");
  if (!Number.isSafeInteger(archivo.size) || archivo.size <= 0) throw new Error("Archivo vacío o tamaño inválido.");
  if (archivo.size > MAX_EVIDENCIA_BYTES) throw new Error("El archivo supera el límite de 15 MiB.");
  return { nombre, mimeType: archivo.mimeType, size: archivo.size };
}

/** No basta el MIME declarado: también se comprueba la firma binaria en servidor. */
export function validarContenidoEvidencia(bytes: ArrayBuffer, mimeType: string) {
  const b = new Uint8Array(bytes);
  const comienza = (firma: number[]) => firma.every((n, i) => b[i] === n);
  const valido = mimeType === "image/jpeg" ? comienza([0xff, 0xd8, 0xff])
    : mimeType === "image/png" ? comienza([137, 80, 78, 71, 13, 10, 26, 10])
    : mimeType === "image/webp" ? comienza([82, 73, 70, 70]) && [87, 69, 66, 80].every((n, i) => b[i + 8] === n)
    : mimeType === "application/pdf" && comienza([37, 80, 68, 70, 45]);
  if (!valido) throw new Error("El contenido no corresponde al tipo de archivo declarado.");
}
