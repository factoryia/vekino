import { api } from "@vekino/backend/api";
import { csvReporteIncidentes, nombreReporteIncidentes } from "@vekino/backend/incidenteReporte";
import { fetchAuthQuery } from "@/lib/auth-server";
import { filtrosDashboard } from "@/lib/incidentes-dashboard";
import { pdfReporteIncidentes, xlsxReporteIncidentes } from "@/lib/reporte-incidentes";

export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request): Promise<Response> {
  try {
    // No aceptar datos/filas del cliente. Solo parámetros; sesión mediante cookie.
    const body = await request.json();
    if (!body || typeof body.parametros !== "string" || body.parametros.length > 2000 || !["csv", "xlsx", "pdf"].includes(body.formato)) return Response.json({ error: "Solicitud de reporte no válida." }, { status: 400 });
    const formato = body.formato as "csv" | "xlsx" | "pdf";
    const datos = await fetchAuthQuery(api.incidentes.reporte, { ...filtrosDashboard(new URLSearchParams(body.parametros)), exportar: true });
    if (!datos?.reporte) return Response.json({ error: "No tienes acceso a este reporte." }, { status: 403 });
    // Metadato oficial de esta generación, independiente de la caché de consultas Convex.
    datos.reporte.generadoEn = Date.now();
    const contenido = formato === "csv" ? csvReporteIncidentes(datos.reporte.filas, { ...datos.periodo, ...datos.reporte.filtros, conjunto: datos.reporte.conjunto, generadoEn: datos.reporte.generadoEn }) : formato === "xlsx" ? await xlsxReporteIncidentes(datos) : await pdfReporteIncidentes(datos);
    const nombre = nombreReporteIncidentes(datos.periodo, formato, new URLSearchParams(body.parametros).has("conjunto") ? datos.reporte.conjunto : undefined);
    return new Response(typeof contenido === "string" ? contenido : new Uint8Array(contenido), { headers: {
      "Content-Type": formato === "csv" ? "text/csv;charset=utf-8" : formato === "xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "application/pdf",
      "Content-Disposition": `attachment; filename="${nombre}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
      "X-Reporte-Generado": new Date(datos.reporte.generadoEn).toISOString(),
    } });
  } catch (error) {
    const texto = error instanceof Error ? error.message : "";
    if (/FORMATO_PDF_NO_COMPATIBLE/.test(texto)) return Response.json({ error: "El PDF contiene caracteres que la fuente disponible no admite. Exporta CSV o Excel." }, { status: 422, headers: { "Cache-Control": "private, no-store" } });
    const limite = /LIMITE_EXPORTACION|LIMITE_ANALITICA/.test(texto), vacio = /REPORTE_VACIO/.test(texto), permiso = /SIN_ACCESO_REPORTE|autenticado|permiso|acceso|compañía|contrato|perfil inexistente|invalid token|token expired/i.test(texto);
    return Response.json({ error: limite ? "El periodo es demasiado amplio. Acota el periodo o selecciona un conjunto." : vacio ? "No hay incidentes para los filtros seleccionados." : permiso ? "No tienes acceso a este reporte. Revisa tu sesión." : "No fue posible generar el reporte. Intenta nuevamente." }, { status: limite || vacio ? 422 : permiso ? 403 : 500, headers: { "Cache-Control": "private, no-store" } });
  }
}
