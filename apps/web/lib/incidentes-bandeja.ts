import type { Id } from "@vekino/backend/dataModel";
import type { PrioridadIncidente } from "./incidentes-ui";

import { ESTADOS_INCIDENTE } from "@vekino/backend/incidentes";
import { limiteDiaColombia } from "@vekino/backend/incidenteMetricas";
export { ESTADOS_INCIDENTE };
export type EstadoIncidente = (typeof ESTADOS_INCIDENTE)[number];
export function etiquetaEstado(estado: string) {
  return ({ REPORTADO: "Reportado", EN_INVESTIGACION: "En investigación", EN_SEGUIMIENTO: "En seguimiento", RESUELTO: "Resuelto", CERRADO: "Cerrado" } as Record<string, string>)[estado] ?? estado;
}
export function fechaIncidente(ms: number, timeZone?: string) {
  return new Date(ms).toLocaleString("es-CO", { dateStyle: "medium", timeStyle: "short", ...(timeZone ? { timeZone } : {}) });
}
export function filtrosBandeja(params: URLSearchParams, conjunto?: string) {
  const estado = params.get("estado") ?? "ACTIVOS";
  const prioridad = params.get("prioridad") ?? "";
  const fecha = params.get("fecha") === "ocurrioEn" ? "ocurrioEn" as const : "reportadoEn" as const;
  const campo = params.get("campo") ?? "ubicacion";
  const dia = (valor: string | null, fin: boolean) => {
    if (!valor || !/^\d{4}-\d{2}-\d{2}$/.test(valor)) return undefined;
    if (params.get("zona") === "America/Bogota") {
      try { return limiteDiaColombia(valor, fin); } catch { return undefined; }
    }
    const ms = Date.parse(`${valor}T${fin ? "23:59:59.999" : "00:00:00"}`);
    return Number.isFinite(ms) ? ms : undefined;
  };
  return {
    condominioId: (conjunto || params.get("conjunto") || undefined) as Id<"condominios"> | undefined,
    ...(params.get("alcance") === "mis-conjuntos" && !conjunto && !params.get("conjunto") ? { todosMisConjuntos: true } : {}),
    estado: ESTADOS_INCIDENTE.includes(estado as EstadoIncidente) ? estado as EstadoIncidente : undefined,
    activos: estado === "ACTIVOS",
    prioridad: ["BAJA", "MEDIA", "ALTA", "CRITICA"].includes(prioridad) ? prioridad as PrioridadIncidente : undefined,
    tipo: params.get("tipo") || undefined,
    busqueda: params.get("q")?.trim() || undefined,
    campoBusqueda: (campo === "descripcion" || campo === "referencia" ? campo : "ubicacion") as "descripcion" | "ubicacion" | "referencia",
    fecha, desde: dia(params.get("desde"), false), hasta: dia(params.get("hasta"), true),
    orden: params.get("orden") === "asc" ? "asc" as const : "desc" as const,
  };
}
export function mensajeErrorGestion(error: unknown) {
  const texto = error instanceof Error ? error.message : String(error);
  if (/No autenticado|perfil inexistente/i.test(texto)) return "Tu sesión terminó. Inicia sesión de nuevo.";
  if (/permiso|acceso|compañía|contrato|activo/i.test(texto)) return "Ya no tienes permiso para esta operación o la relación con el conjunto terminó. Actualiza la página.";
  if (/motivo/i.test(texto)) return "Escribe un motivo válido para el retroceso (máximo 2000 caracteres).";
  if (/resolución/i.test(texto)) return "Escribe la observación de resolución (máximo 5000 caracteres).";
  if (/cerrado|Transición|observación|debe tener|no cambió/i.test(texto)) return "Revisa los datos y el estado actual del incidente antes de confirmar.";
  return "No pudimos guardar el cambio. Conservamos tus datos; inténtalo de nuevo.";
}
/** Solo prepara los campos; las acciones disponibles llegan del dominio. */
export function requisitosTransicion(actual: EstadoIncidente, siguiente: EstadoIncidente) {
  return { motivo: (actual === "EN_SEGUIMIENTO" && siguiente === "EN_INVESTIGACION") || (actual === "RESUELTO" && siguiente === "EN_SEGUIMIENTO"), resolucion: siguiente === "RESUELTO" };
}
