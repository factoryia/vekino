"use client";
import Link from "next/link";
import { useQuery } from "convex/react";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api } from "@vekino/backend/api";
import { MAX_INCIDENTES_EXPORTACION, MAX_FILAS_VISTA_REPORTE } from "@vekino/backend/incidenteReporte";
import { PageContainer } from "@/components/layout/page-container";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ErrorBoundary, ErrorMessage } from "@/components/ui/error-boundary";
import { Skeleton } from "@/components/ui/skeleton";
import { etiquetaEstado, fechaIncidente } from "@/lib/incidentes-bandeja";
import { filtrosDashboard, enlaceBandejaDashboard, parametrosReporteIncidentes } from "@/lib/incidentes-dashboard";
import { descargarReporteIncidentes, mensajeErrorReporteIncidentes, type EstadoExportacionIncidentes } from "@/lib/descargar-reporte-incidentes";
import { FiltrosReporteIncidentes } from "./incidentes-filtros-reporte";

const RUTA = "/vigilancia/incidentes/reportes";
function Carga() { return <div role="status"><Skeleton className="h-64" />Cargando reporte</div>; }
function Fallo({ error, reintentar }: { error: Error; reintentar: () => void }) {
  const limite = /LIMITE_/i.test(error.message);
  const acceso = /SIN_ACCESO_REPORTE|permiso|autenticado|compañía|contrato/i.test(error.message);
  return <Card className="p-5"><div role="alert"><ErrorMessage title={limite ? "El periodo es demasiado amplio." : acceso ? "No tienes acceso a reportes operativos." : "No fue posible consultar el reporte."} detail={limite ? "Acota el periodo o selecciona un conjunto." : "Revisa tu sesión, alcance y fechas. Intenta nuevamente."} /></div><Button onClick={reintentar}>Reintentar</Button></Card>;
}
export function IncidentesReportes() {
  const params = useSearchParams(); const [intento, setIntento] = useState(0);
  return <PageContainer className="mx-auto w-full max-w-7xl pb-12">
    <nav aria-label="Ruta de navegación" className="text-sm"><Link href="/vigilancia">Vigilancia</Link> / <Link href="/vigilancia/incidentes">Incidentes</Link> / Reportes</nav>
    <PageHeader title="Reportes de incidentes" description="Consulta reproducible por fecha de reporte y estado actual. Días de Colombia (America/Bogota)." />
    <ErrorBoundary resetKey={`${params}:${intento}`} fallback={(error) => <Fallo error={error} reintentar={() => setIntento((n) => n + 1)} />}><ContextoReporte /></ErrorBoundary>
  </PageContainer>;
}
function ContextoReporte() {
  const params = useSearchParams(); const contexto = useQuery(api.incidentes.contextoBandeja);
  if (contexto === undefined) return <Carga />;
  if (!contexto || (!contexto.todosLosConjuntos && !contexto.conjuntos.length)) return <p role="status">No tienes acceso a reportes operativos.</p>;
  const autorizado = contexto;
  return <FiltrosReporteIncidentes key={params.toString()} contexto={autorizado} ruta={RUTA} fallback={(error, reintentar) => <Fallo error={error} reintentar={reintentar} />}>{(filtros, efectivos, pendientes) => <Resultado pendientes={pendientes} filtros={filtros} params={efectivos} union={!autorizado.todosLosConjuntos && !filtros.condominioId} />}</FiltrosReporteIncidentes>;
}
function Resultado({ filtros, params, union, pendientes }: { filtros: ReturnType<typeof filtrosDashboard>; params: URLSearchParams; union: boolean; pendientes: boolean }) {
  const datos = useQuery(api.incidentes.reporte, filtros);
  const [estado, setEstado] = useState<EstadoExportacionIncidentes | "Error" | "">("");
  const [error, setError] = useState(""); const solicitud = useRef<AbortController | null>(null);
  useEffect(() => () => solicitud.current?.abort(), []);
  const ocupado = ["Preparando", "Generando", "Descargando"].includes(estado);
  if (datos === undefined) return <Carga />;
  if (!datos?.reporte) return <p role="status">No tienes acceso a reportes operativos.</p>;
  const reporte = datos.reporte;
  const bandeja = enlaceBandejaDashboard(params, datos.periodo, union ? { alcance: "mis-conjuntos" } : {});
  const excedido = datos.total > MAX_INCIDENTES_EXPORTACION;
  async function exportar(formato: "csv" | "xlsx" | "pdf") {
    if (solicitud.current || !datos) return;
    const controller = new AbortController(); solicitud.current = controller; setError("");
    try { await descargarReporteIncidentes(parametrosReporteIncidentes(params, datos.periodo), formato, setEstado, controller.signal); }
    catch (fallo) { if (!controller.signal.aborted) { setEstado("Error"); setError(mensajeErrorReporteIncidentes(fallo)); } }
    finally { solicitud.current = null; }
  }
  return <div className="space-y-5">
    <Card className="space-y-3 p-5"><h2 className="font-semibold">Resumen del reporte</h2><p>Periodo: {datos.periodo.desdeDia} — {datos.periodo.hastaDia}</p><p>Conjunto: {reporte.conjunto}</p><p className="text-sm">Estado: {reporte.filtros.estado} · Prioridad: {reporte.filtros.prioridad} · Tipo: {reporte.filtros.tipo}</p>
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">{[["Total", datos.total], ["Activos", datos.activos], ["Resueltos", datos.estados.RESUELTO], ["Cerrados", datos.estados.CERRADO]].map(([titulo, cantidad]) => <div key={titulo}><dt>{titulo}</dt><dd className="text-2xl font-semibold">{cantidad}</dd></div>)}</dl>
      <p className="text-xs text-muted-foreground">Consulta generada: {fechaIncidente(reporte.generadoEn, "America/Bogota")}. Las exportaciones vuelven a comprobar permisos y datos vigentes con estos mismos filtros.</p>
      <div className="flex flex-wrap gap-2">{([['csv', 'Generar CSV'], ['xlsx', 'Exportar Excel'], ['pdf', 'Generar PDF']] as const).map(([formato, etiqueta]) => <Button key={formato} disabled={ocupado || pendientes || !datos.total || excedido} onClick={() => exportar(formato)}>{etiqueta}</Button>)}</div>
      {pendientes && <p role="status">Aplica los filtros antes de exportar.</p>}
      <p role="status" aria-live="polite" aria-atomic="true">{estado}{estado === "Completado" && ". Archivo enviado al navegador."}</p>{error && <p role="alert">{error}</p>}
      {excedido && <p role="status">El periodo es demasiado amplio. Máximo {MAX_INCIDENTES_EXPORTACION} incidentes por exportación; acota el periodo o selecciona un conjunto.</p>}
    </Card>
    {!datos.total ? <p role="status">No hay incidentes para los filtros seleccionados. Modifica los filtros para consultar otro periodo.</p> : <Card className="p-5"><h2 className="font-semibold">Incidentes incluidos</h2><p className="my-3 text-sm">Mostrando {reporte.filas.length} de {datos.total} incidentes, más recientes primero. <Link className="underline" href={bandeja}>Consultar todos en la bandeja</Link></p>
      <div className="overflow-x-auto" role="region" aria-label="Resultados del reporte" tabIndex={0}><table className="w-full text-left text-sm"><caption className="sr-only">Hasta {MAX_FILAS_VISTA_REPORTE} incidentes recientes; exportación completa dentro del límite.</caption><thead><tr>{["Referencia", "Fecha reporte", "Fecha del hecho", "Conjunto", "Tipo", "Prioridad", "Estado", "Responsable", "Ubicación"].map((c) => <th scope="col" key={c} className="p-2">{c}</th>)}</tr></thead><tbody>{reporte.filas.map((c) => <tr key={c.referencia} className="border-t"><td className="p-2"><Link className="underline" href={`/vigilancia/incidentes/${c.referencia}?volver=${encodeURIComponent(bandeja.split("?")[1]!)}`}>{c.referencia}</Link></td>{[fechaIncidente(c.reportadoEn, "America/Bogota"), fechaIncidente(c.ocurrioEn, "America/Bogota"), c.conjunto, c.tipo, c.prioridad, etiquetaEstado(c.estado), c.responsable || "Sin asignar", c.ubicacion].map((valor, i) => <td key={i} className="max-w-64 break-words p-2">{valor}</td>)}</tr>)}</tbody></table></div>
    </Card>}
  </div>;
}
