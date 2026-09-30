"use client";
import Link from "next/link";
import { useQuery } from "convex/react";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@vekino/backend/api";
import { PERIODOS_INCIDENTES, diaColombia, periodoIncidentes } from "@vekino/backend/incidenteMetricas";
import { PageContainer } from "@/components/layout/page-container";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorBoundary, ErrorMessage } from "@/components/ui/error-boundary";
import { Input, Select } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { DonutChart } from "@/components/charts/donut-chart";
import { AreaChart } from "@/components/charts/area-chart";
import { CHART } from "@/components/charts/chart-colors";
import { ESTADOS_INCIDENTE, etiquetaEstado, fechaIncidente } from "@/lib/incidentes-bandeja";
import { etiquetaTipoIncidente, PRIORIDADES_INCIDENTE } from "@/lib/incidentes-ui";
import { enlaceBandejaDashboard, filtrosDashboard, parametrosDashboard } from "@/lib/incidentes-dashboard";
import { Campo } from "./incidente-campo";

type Contexto = NonNullable<FunctionReturnType<typeof api.incidentes.contextoBandeja>>;
const RUTA = "/vigilancia/incidentes/dashboard";

function Carga() { return <div role="status" aria-label="Cargando dashboard"><Skeleton className="h-72 rounded-2xl" /><span className="sr-only">Cargando dashboard</span></div>; }
function SinAcceso() { return <EmptyState icon={AlertTriangle} title="No tienes acceso a datos de incidentes." description="Consulta tu alcance vigente con la compañía." />; }
function Fallo({ error, reintentar }: { error: Error; reintentar: () => void }) {
  const sinAcceso = /permiso|acceso|compañía|contrato|autenticado|perfil inexistente/i.test(error.message);
  const limite = /LIMITE_ANALITICA/i.test(error.message);
  return <Card className="p-5"><div role="alert"><ErrorMessage title={sinAcceso ? "No tienes acceso a datos de incidentes." : limite ? "El periodo supera el límite de consulta." : "Ocurrió un error al cargar el dashboard."} detail={limite ? "Reduce el periodo o selecciona un conjunto. No se muestran totales parciales." : /periodo|fechas|cinco años/i.test(error.message) ? "Selecciona fechas válidas y un periodo de hasta cinco años." : "Revisa tu sesión y vuelve a intentar."} /></div><Button variant="outline" onClick={reintentar}>Reintentar</Button></Card>;
}
export function IncidentesDashboard() {
  const params = useSearchParams();
  const [intento, setIntento] = useState(0);
  return <PageContainer className="mx-auto w-full max-w-7xl pb-12">
    <nav aria-label="Ruta de navegación" className="text-sm text-muted-foreground"><Link href="/vigilancia">Vigilancia</Link> / <Link href="/vigilancia/incidentes">Incidentes</Link> / Dashboard</nav>
    <PageHeader title="Dashboard de Incidentes" description="Estado actual de los casos reportados en el periodo. Días de Colombia (UTC−5)." action={<Button variant="outline" asChild><Link href="/vigilancia/incidentes">Bandeja de incidentes</Link></Button>} />
    <ErrorBoundary resetKey={`${params}:${intento}`} fallback={(error) => <Fallo error={error} reintentar={() => setIntento((n) => n + 1)} />}><ContextoDashboard /></ErrorBoundary>
  </PageContainer>;
}
function ContextoDashboard() {
  const params = useSearchParams();
  const contexto = useQuery(api.incidentes.contextoBandeja);
  if (contexto === undefined) return <Carga />;
  if (!contexto || (!contexto.todosLosConjuntos && !contexto.conjuntos.length)) return <SinAcceso />;
  return <Panel key={params.toString()} contexto={contexto} />;
}
function Panel({ contexto }: { contexto: Contexto }) {
  const params = useSearchParams();
  const router = useRouter();
  const efectivos = new URLSearchParams(params.toString());
  if (!contexto.todosLosConjuntos && contexto.conjuntos.length === 1 && !efectivos.has("conjunto")) efectivos.set("conjunto", contexto.conjuntos[0]!.condominioId);
  const filtros = filtrosDashboard(efectivos);
  const [periodo, setPeriodo] = useState(filtros.periodo);
  const [intento, setIntento] = useState(0);
  let rango;
  try { rango = periodoIncidentes(filtros.periodo, filtros.desde, filtros.hasta); } catch { /* La query y el boundary presentan el error. */ }
  const unConjunto = !contexto.todosLosConjuntos && contexto.conjuntos.length === 1 ? contexto.conjuntos[0]! : undefined;
  const restringido = !contexto.todosLosConjuntos && contexto.conjuntos.every((c) => c.soloPropios);
  function aplicar(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const siguiente = new URLSearchParams();
    for (const [clave, valor] of new FormData(event.currentTarget)) if (String(valor)) siguiente.set(clave, String(valor));
    if (siguiente.get("periodo") !== "personalizado") { siguiente.delete("desde"); siguiente.delete("hasta"); }
    router.push(`${RUTA}?${siguiente}`, { scroll: false });
  }
  return <>
    <Card className="p-4 sm:p-5"><form key={params.toString()} onSubmit={aplicar} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <Campo label="Periodo"><Select name="periodo" defaultValue={filtros.periodo} onChange={(e) => setPeriodo(e.target.value)}>{PERIODOS_INCIDENTES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</Select></Campo>
      {unConjunto ? <div className="text-sm"><p className="text-xs text-muted-foreground">Conjunto disponible</p><p className="break-words font-medium">{unConjunto.condominioNombre}</p>{filtros.condominioId && <input type="hidden" name="conjunto" value={filtros.condominioId} />}</div> : <Campo label="Conjunto"><Select name="conjunto" defaultValue={filtros.condominioId ?? ""}><option value="">{contexto.todosLosConjuntos ? "Todos los conjuntos autorizados" : "Todos mis conjuntos"}</option>{contexto.conjuntos.map((c) => <option key={c.condominioId} value={c.condominioId}>{c.condominioNombre}</option>)}</Select></Campo>}
      <Campo label="Estado"><Select name="estado" defaultValue={params.get("estado") ?? "TODOS"}><option value="TODOS">Todos</option><option value="ACTIVOS">Activos</option>{ESTADOS_INCIDENTE.map((e) => <option key={e} value={e}>{etiquetaEstado(e)}</option>)}</Select></Campo>
      <Campo label="Prioridad"><Select name="prioridad" defaultValue={filtros.prioridad ?? ""}><option value="">Todas</option>{PRIORIDADES_INCIDENTE.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</Select></Campo>
      <Campo label="Tipo registrado"><Input name="tipo" maxLength={80} placeholder="Todos · valor exacto" defaultValue={filtros.tipo ?? ""} /></Campo>
      {periodo === "personalizado" && <><Campo label="Desde"><Input name="desde" type="date" required defaultValue={filtros.desde ?? rango?.desdeDia ?? diaColombia(Date.now())} /></Campo><Campo label="Hasta"><Input name="hasta" type="date" required defaultValue={filtros.hasta ?? rango?.hastaDia ?? diaColombia(Date.now())} /></Campo></>}
      <div className="flex flex-wrap items-end gap-2"><Button type="submit">Aplicar filtros</Button><Button asChild variant="outline"><Link href={RUTA}>Limpiar filtros</Link></Button></div>
    </form>{restringido && <p className="mt-3 text-xs text-muted-foreground">Métricas limitadas a tus propios incidentes autorizados.</p>}</Card>
    <ErrorBoundary resetKey={`${params}:${intento}`} fallback={(error) => <Fallo error={error} reintentar={() => setIntento((n) => n + 1)} />}><Metricas filtros={filtros} contexto={contexto} params={efectivos} /></ErrorBoundary>
  </>;
}
function Metricas({ filtros, contexto, params }: { filtros: ReturnType<typeof filtrosDashboard>; contexto: Contexto; params: URLSearchParams }) {
  const datos = useQuery(api.incidentes.dashboard, filtros);
  if (datos === undefined) return <Carga />;
  if (datos === null) return <SinAcceso />;
  if (datos.total === 0) return <EmptyState icon={AlertTriangle} title="No hay incidentes en este periodo." description="Prueba otro periodo o cambia los filtros." />;
  const enlace = (cambios: Record<string, string> = {}) => enlaceBandejaDashboard(params, datos.periodo, { ...(!contexto.todosLosConjuntos && !filtros.condominioId ? { alcance: "mis-conjuntos" } : {}), ...cambios });
  return <div className="space-y-5">
    <p className="text-xs text-muted-foreground" role="status">Reportes del {datos.periodo.desdeDia} al {datos.periodo.hastaDia} · Estado actual</p>
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Resumen operativo">
      <Indicador titulo="Total de incidentes" valor={datos.total} href={enlace()} />
      <Indicador titulo="Activos" valor={datos.activos} href={enlace({ estado: "ACTIVOS" })} contexto="Reportados, en investigación o seguimiento" />
      <Indicador titulo="Resueltos" valor={datos.estados.RESUELTO} href={enlace({ estado: "RESUELTO" })} />
      <Indicador titulo="Cerrados" valor={datos.estados.CERRADO} href={enlace({ estado: "CERRADO" })} />
    </div>
    <div className="grid min-w-0 gap-5 lg:grid-cols-2">
      <Distribucion titulo="Distribución por estado" items={ESTADOS_INCIDENTE.map((estado, i) => ({ clave: estado, label: etiquetaEstado(estado), value: datos.estados[estado], color: [CHART.sky, CHART.pending, CHART.accent, CHART.success, CHART.mutedStrong][i]!, href: enlace({ estado }) }))} donut />
      <Distribucion titulo="Distribución por prioridad" items={PRIORIDADES_INCIDENTE.map((p, i) => ({ clave: p.value, label: p.label, value: datos.prioridades[p.value], color: [CHART.mutedStrong, CHART.sky, CHART.pending, CHART.danger][i]!, href: enlace({ prioridad: p.value }) }))} donut />
      <Distribucion titulo="Distribución por tipo" items={datos.tipos.map((t) => ({ clave: t.tipo, label: etiquetaTipoIncidente(t.tipo), value: t.cantidad, color: CHART.accent, href: enlace({ tipo: t.tipo }) }))} />
      <Distribucion titulo="Volumen por conjunto" items={datos.conjuntos.map((c) => ({ clave: c.condominioId, label: c.nombre, value: c.cantidad, color: CHART.sky, href: enlace({ conjunto: c.condominioId }) }))} />
    </div>
    <Card className="min-w-0 space-y-3 p-4 sm:p-5"><h2 className="font-semibold">Evolución temporal</h2><p className="text-xs text-muted-foreground">Reportes por {datos.evolucion.granularidad}. Los intervalos comienzan en la fecha indicada; los valores incluyen días sin reportes.</p><div aria-hidden="true"><AreaChart data={datos.evolucion.puntos.map((p) => ({ label: p.label.slice(5), value: p.value }))} color={CHART.sky} labelEvery={Math.ceil(datos.evolucion.puntos.length / 8)} /></div><details><summary className="cursor-pointer text-sm">Ver valores y abrir la bandeja por intervalo</summary><ul className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{datos.evolucion.puntos.map((p) => <li key={p.desde} className="text-sm">{<Link className="underline" href={enlace({ desde: diaColombia(p.desde), hasta: diaColombia(p.hasta) })}>{p.label}: {p.value} incidentes</Link>}</li>)}</ul></details></Card>
    <div className="grid gap-5 lg:grid-cols-2">
      <Card className="space-y-3 p-4 sm:p-5"><h2 className="font-semibold">Atención operativa</h2><div className="flex flex-wrap gap-3">{["CRITICA", "ALTA"].map((p) => <Link key={p} href={`${RUTA}?${new URLSearchParams({ ...Object.fromEntries(parametrosDashboard(params)), estado: "ACTIVOS", prioridad: p })}`} className="text-sm underline">Ver activos de prioridad {p === "CRITICA" ? "crítica" : "alta"}</Link>)}</div><p className="text-sm">Activos con al menos {datos.antiguedadDias} días desde el reporte: <strong>{datos.antiguos}</strong>.</p>{<Link href={enlace({ estado: "ACTIVOS", orden: "asc" })} className="text-sm underline">Ver activos más antiguos en la bandeja</Link>}<p className="text-xs text-muted-foreground">Hasta cinco activos del periodo, por prioridad existente y luego por reporte más antiguo.</p><ul className="space-y-2">{datos.relevantes.map((c) => <li key={c._id}><Link href={`/vigilancia/incidentes/${c._id}?volver=${encodeURIComponent(enlace({ conjunto: c.condominioId }).split("?")[1]!)}`} className="block rounded-xl border p-3 focus-visible:ring-2 focus-visible:ring-ring"><div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium min-w-0 max-w-full break-words">{etiquetaTipoIncidente(c.tipo)}</span><Badge tone={PRIORIDADES_INCIDENTE.find((p) => p.value === c.prioridad)!.tone}>{PRIORIDADES_INCIDENTE.find((p) => p.value === c.prioridad)!.label}</Badge><Badge tone="info">{etiquetaEstado(c.estado)}</Badge></div><p className="mt-2 text-xs break-words">{c.conjunto} · Reporte: {fechaIncidente(c.reportadoEn, "America/Bogota")}</p>{c.responsableNombre && <p className="text-xs break-words">Responsable: {c.responsableNombre}</p>}</Link></li>)}</ul>{!datos.relevantes.length && <p className="text-sm text-muted-foreground">No hay incidentes activos con estos filtros.</p>}</Card>
      <Card className="space-y-3 p-4 sm:p-5"><h2 className="font-semibold">Tiempo de resolución</h2><p className="text-2xl font-semibold tabular-nums">{datos.resolucion.promedioMs === null ? "Sin muestra válida" : `${(datos.resolucion.promedioMs / 3_600_000).toLocaleString("es-CO", { maximumFractionDigits: 1 })} horas`}</p><p className="text-sm text-muted-foreground">Promedio desde el reporte hasta la última resolución vigente, entre casos actualmente resueltos o cerrados reportados en este periodo.</p><p className="text-xs text-muted-foreground">Muestra: {datos.resolucion.muestra} casos. Excluidos por fecha de resolución ausente o inválida: {datos.resolucion.sinFecha}. No mide tiempo hasta cierre ni constituye un SLA.</p></Card>
    </div>
  </div>;
}
function Indicador({ titulo, valor, href, contexto }: { titulo: string; valor: number; href?: string; contexto?: string }) {
  const contenido = <><h2 className="text-sm text-muted-foreground">{titulo}</h2><p className="mt-2 text-3xl font-semibold tabular-nums">{valor}</p>{contexto && <p className="mt-2 text-xs text-muted-foreground">{contexto}</p>}</>;
  return <Card className="min-w-0">{href ? <Link className="block rounded-2xl p-4 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring" href={href}>{contenido}</Link> : <div className="p-4">{contenido}</div>}</Card>;
}
type Item = { clave: string; label: string; value: number; color: string; href?: string };
function Distribucion({ titulo, items, donut = false }: { titulo: string; items: Item[]; donut?: boolean }) {
  const [ampliado, setAmpliado] = useState(false);
  const visibles = ampliado ? items : items.slice(0, 10);
  const total = items.reduce((s, i) => s + i.value, 0);
  return <Card className="min-w-0 space-y-3 p-4 sm:p-5"><h2 className="font-semibold">{titulo}</h2><p className="text-xs text-muted-foreground">Cantidad de reportes en el periodo y filtros seleccionados.</p>{donut && <div aria-hidden="true"><DonutChart data={items} showLegend={false} centerValue={total} centerLabel="incidentes" /></div>}<ul className="space-y-2">{visibles.map((item) => { const fila = <><div className="flex justify-between gap-3 text-sm"><span className="min-w-0 break-words">{item.label}</span><span className="shrink-0 font-semibold tabular-nums">{item.value} <span className="text-xs font-normal text-muted-foreground">({total ? Math.round(item.value / total * 100) : 0}%)</span></span></div>{!donut && <div aria-hidden="true" className="mt-1 h-1.5 rounded-full bg-muted"><div className="h-full rounded-full" style={{ width: `${total ? item.value / total * 100 : 0}%`, backgroundColor: item.color }} /></div>}</>; return <li key={item.clave}>{item.href ? <Link href={item.href} className="block rounded-lg p-2 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">{fila}</Link> : <div className="p-2">{fila}</div>}</li>; })}</ul>{items.length > 10 && <Button variant="outline" onClick={() => setAmpliado((v) => !v)}>{ampliado ? "Mostrar menos" : `Ver todas las categorías (${items.length})`}</Button>}</Card>;
}
