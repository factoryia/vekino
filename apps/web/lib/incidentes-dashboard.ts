import { filtrosBandeja } from "./incidentes-bandeja";

/** Solo contexto operativo: nunca copia parámetros ajenos a estos filtros. */
export function parametrosDashboard(params: URLSearchParams) {
  const contexto = new URLSearchParams();
  for (const clave of ["periodo", "desde", "hasta", "conjunto", "estado", "prioridad", "tipo"]) {
    const valor = params.get(clave); if (valor) contexto.set(clave, valor);
  }
  return contexto;
}
export function filtrosDashboard(params: URLSearchParams) {
  const comunes = new URLSearchParams(params);
  if (!comunes.has("estado")) comunes.set("estado", "TODOS");
  const { condominioId, estado, activos, prioridad, tipo } = filtrosBandeja(comunes);
  return { condominioId, estado, activos, prioridad, tipo, periodo: params.get("periodo") ?? "30dias",
    desde: params.get("desde") ?? undefined, hasta: params.get("hasta") ?? undefined };
}
export function enlaceBandejaDashboard(params: URLSearchParams, periodo: { desdeDia: string; hastaDia: string }, cambios: Record<string, string> = {}) {
  const bandeja = new URLSearchParams();
  for (const clave of ["conjunto", "estado", "prioridad", "tipo"]) {
    const valor = params.get(clave); if (valor) bandeja.set(clave, valor);
  }
  if (!bandeja.has("estado")) bandeja.set("estado", "TODOS");
  bandeja.set("fecha", "reportadoEn"); bandeja.set("zona", "America/Bogota");
  bandeja.set("desde", periodo.desdeDia); bandeja.set("hasta", periodo.hastaDia);
  bandeja.set("dashboard", parametrosDashboard(params).toString());
  for (const [clave, valor] of Object.entries(cambios)) bandeja.set(clave, valor);
  return `/vigilancia/incidentes?${bandeja}`;
}

/** Fija los días resueltos en servidor: una consulta reproducible al cambiar de día. */
export function parametrosReporteIncidentes(params: URLSearchParams, periodo: { desdeDia: string; hastaDia: string }) {
  const reporte = parametrosDashboard(params);
  reporte.set("periodo", "personalizado"); reporte.set("desde", periodo.desdeDia); reporte.set("hasta", periodo.hastaDia);
  return reporte;
}
