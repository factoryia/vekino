export type EstadoExportacionIncidentes = "Preparando" | "Generando" | "Descargando" | "Completado";
const ERRORES_REPORTE = ["El periodo es demasiado amplio. Acota el periodo o selecciona un conjunto.", "No hay incidentes para los filtros seleccionados.", "No tienes acceso a este reporte. Revisa tu sesión.", "El PDF contiene caracteres que la fuente disponible no admite. Exporta CSV o Excel."];
export function mensajeErrorReporteIncidentes(error: unknown): string {
  const mensaje = error instanceof Error ? error.message : "";
  return ERRORES_REPORTE.includes(mensaje) ? mensaje : "No fue posible generar el reporte. Intenta nuevamente.";
}
export async function descargarReporteIncidentes(parametros: URLSearchParams, formato: "csv" | "xlsx" | "pdf", estado: (valor: EstadoExportacionIncidentes) => void, signal: AbortSignal) {
  estado("Preparando");
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (signal.aborted) return;
  estado("Generando");
  const respuesta = await fetch("/api/incidentes/reporte", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ parametros: parametros.toString(), formato }), signal });
  if (!respuesta.ok) {
    // Solo mensajes operacionales conocidos; jamás mostrar una respuesta técnica.
    const body = await respuesta.json().catch(() => ({}));
    throw new Error(mensajeErrorReporteIncidentes(new Error(body.error)));
  }
  const archivo = await respuesta.blob();
  if (signal.aborted) return;
  const nombre = respuesta.headers.get("Content-Disposition")?.match(/filename="(incidentes[a-z0-9.-]+)"/)?.[1];
  if (!nombre || !nombre.endsWith(`.${formato}`) || !archivo.size) throw new Error("No fue posible generar el reporte. Intenta nuevamente.");
  estado("Descargando");
  const url = URL.createObjectURL(archivo);
  try {
    const a = document.createElement("a"); a.href = url; a.download = nombre;
    document.body.append(a); a.click(); a.remove();
    await new Promise((resolve) => setTimeout(resolve, 0));
    estado("Completado");
  } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
