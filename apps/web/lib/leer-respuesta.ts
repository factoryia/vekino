/**
 * El cuerpo JSON de una respuesta de las rutas de facturas (`/api/facturas/*`).
 *
 * Las rutas responden JSON. Pero si el archivo pasa del máximo que la
 * plataforma (Vercel) acepta en una petición, la plataforma responde 413 antes
 * de llegar a la ruta, y no en JSON: `res.json()` fallaba y la pantalla
 * mostraba "Unexpected token…". Aquí ese caso, y cualquier otra respuesta que
 * no sea JSON, se convierten en un error que se entiende.
 */
export const MENSAJE_ARCHIVO_DEMASIADO_GRANDE =
  "El PDF es demasiado grande para cargarlo de una vez (se admiten unos 4,5 MB por archivo). Divídelo en partes con facturas completas y cárgalas por separado.";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function leerRespuesta(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    if (res.status === 413) throw new Error(MENSAJE_ARCHIVO_DEMASIADO_GRANDE);
    throw new Error(`El servidor respondió algo inesperado (${res.status}). Intenta de nuevo.`);
  }
}
