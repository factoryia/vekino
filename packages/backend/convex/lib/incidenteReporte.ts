/** Límites inferiores a la lectura analítica (5.000 documentos / 6 MB). */
export const MAX_INCIDENTES_EXPORTACION = 1000;
export const MAX_BYTES_EXPORTACION = 1_500_000;
export const MAX_FILAS_VISTA_REPORTE = 50;
export const MAX_PAGINAS_REPORTE_PDF = 100;

export type FilaReporteIncidente = {
  referencia: string; conjunto: string; reportadoEn: number; ocurrioEn: number;
  tipo: string; prioridad: string; estado: string; ubicacion: string;
  reportante: string; responsable: string; resueltoEn: number | null; cerradoEn: number | null;
};
export const COLUMNAS_REPORTE_INCIDENTES = ["Referencia", "Fecha reporte", "Fecha incidente", "Conjunto", "Tipo", "Prioridad", "Estado", "Ubicación", "Reportante", "Responsable", "Fecha resolución", "Fecha cierre"] as const;

/** Formato estable con hora y offset explícitos; todos los archivos usan Colombia. */
export function fechaReporteIncidente(ms: number | null): string {
  return ms === null ? "" : new Date(ms - 5 * 3_600_000).toISOString().replace("T", " ").replace("Z", " -05:00");
}
export function valoresReporteIncidente(c: FilaReporteIncidente): string[] {
  return [c.referencia, fechaReporteIncidente(c.reportadoEn), fechaReporteIncidente(c.ocurrioEn), c.conjunto, c.tipo, c.prioridad, c.estado, c.ubicacion, c.reportante, c.responsable, fechaReporteIncidente(c.resueltoEn), fechaReporteIncidente(c.cerradoEn)];
}
export function nombreReporteIncidentes(periodo: { desdeDia: string; hastaDia: string }, formato: "csv" | "xlsx" | "pdf", conjunto?: string) {
  const slug = conjunto?.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  return `incidentes${slug ? `-${slug}` : ""}-${periodo.desdeDia}-${periodo.hastaDia}.${formato}`;
}
/** RFC 4180, BOM para Excel y neutralización de fórmulas de celdas no confiables. */
export type ContextoCsvIncidentes = { generadoEn: number; desdeDia: string; hastaDia: string; conjunto: string; estado: string; prioridad: string; tipo: string };
export const COLUMNAS_CONTEXTO_CSV_INCIDENTES = ["Generado", "Periodo desde", "Periodo hasta", "Filtro conjunto", "Filtro estado", "Filtro prioridad", "Filtro tipo"] as const;
export function csvReporteIncidentes(filas: readonly FilaReporteIncidente[], contexto: ContextoCsvIncidentes): string {
  const escapar = (v: string) => `"${(/^[\s\u0000-\u001f]*[=+@-]/.test(v) ? "'" + v : v).replace(/"/g, '""')}"`;
  const metadatos = [fechaReporteIncidente(contexto.generadoEn), contexto.desdeDia, contexto.hastaDia, contexto.conjunto, contexto.estado, contexto.prioridad, contexto.tipo];
  return "\uFEFF" + [[...COLUMNAS_REPORTE_INCIDENTES, ...COLUMNAS_CONTEXTO_CSV_INCIDENTES], ...filas.map((f) => [...valoresReporteIncidente(f), ...metadatos])].map((fila) => fila.map(escapar).join(",")).join("\r\n");
}
