"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "@vekino/backend/api";
import type { Id } from "@vekino/backend/dataModel";
import type { FunctionReturnType } from "convex/server";
import { Activity, Building2, ShieldCheck } from "lucide-react";
import { PageContainer } from "@/components/layout/page-container";
import { PageHeader } from "@/components/layout/page-header";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorBoundary, ErrorMessage } from "@/components/ui/error-boundary";
import { AreaChart } from "@/components/charts/area-chart";
import { HBars } from "@/components/charts/h-bars";
import { CHART } from "@/components/charts/chart-colors";

type Datos = FunctionReturnType<typeof api.companias.operacion>;
type Catalogo = Pick<Datos, "conjuntos" | "guardas">;
type Filtros = { desde: string; hasta: string; condominioId: string; guardiaUserId: string; granularidad: "dia" | "semana" | "mes" };
type Agrupacion = "compania" | "condominio" | "guarda";
type Serie = "turnos" | "rondas" | "minuta" | "novedades";
const series: Record<Serie, string> = { turnos: "Turnos iniciados", rondas: "Rondas finalizadas", minuta: "Entradas de minuta", novedades: "Novedades reportadas" };
function dia(ms: number) { return new Date(ms - 5 * 3_600_000).toISOString().slice(0, 10); }
function inicial(): Filtros { const ahora = Date.now(); return { desde: dia(ahora - 6 * 86_400_000), hasta: dia(ahora), condominioId: "", guardiaUserId: "", granularidad: "dia" }; }
function fecha(ms: number) { return new Date(ms).toLocaleString("es-CO", { timeZone: "America/Bogota", dateStyle: "medium", timeStyle: "short" }); }
function errorOperacion(error: Error) {
  if (error.message.includes("Reduce el periodo")) return "Reduce el periodo o selecciona un conjunto. La consulta superó su límite y no se muestran totales parciales.";
  if (error.message.includes("366 días") || error.message.includes("rango de fechas")) return "Selecciona un rango de fechas válido de hasta 366 días.";
  if (/autorizado|asignado|administrador|compañía|inactivo|autenticado/.test(error.message)) return "No tienes acceso a esta selección. Revisa los filtros y la vigencia de tu acceso.";
  return "No fue posible consultar los datos. Intenta de nuevo.";
}

export function PanelOperacion() {
  const [filtros, setFiltros] = useState(inicial);
  const [catalogo, setCatalogo] = useState<Catalogo>({ conjuntos: [], guardas: [] });
  const [agrupacion, setAgrupacion] = useState<Agrupacion>("condominio");
  const [reintento, setReintento] = useState(0);
  const valido = !!filtros.desde && !!filtros.hasta && filtros.desde <= filtros.hasta &&
    Date.parse(`${filtros.hasta}T00:00:00Z`) - Date.parse(`${filtros.desde}T00:00:00Z`) < 366 * 86_400_000;
  function actualizar(cambio: Partial<Filtros>) { setFiltros(f => ({ ...f, ...cambio })); }
  function periodo(dias: number) { actualizar({ desde: dia(Date.now() - (dias - 1) * 86_400_000), hasta: dia(Date.now()), guardiaUserId: "" }); }
  return <PageContainer><div className="space-y-5">
    <PageHeader title="Panel operativo" description="Actividad de los guardas y estado de la operación de tu compañía." />
    <div className="flex flex-wrap gap-3 text-sm"><Link href="/vigilancia" className="text-brand underline">Supervisar conjuntos</Link><Link href="/vigilancia/incidentes/dashboard" className="text-brand underline">Analizar incidentes de compañía</Link></div>
    <Card className="space-y-4">
      <div className="flex flex-wrap gap-2">{[[1, "Hoy"], [7, "7 días"], [30, "30 días"]].map(([n, label]) => <Button key={n} size="sm" variant="outline" onClick={() => periodo(Number(n))}>{label}</Button>)}<Button size="sm" variant="ghost" onClick={() => { setFiltros(inicial()); setAgrupacion("condominio"); }}>Restablecer filtros</Button></div>
      <details className="group">
      <summary className="cursor-pointer text-sm font-medium">Filtros y agrupación <span className="ml-2 text-xs font-normal text-muted-foreground">{filtros.desde} → {filtros.hasta}{filtros.condominioId ? ` · ${catalogo.conjuntos.find(c => c.id === filtros.condominioId)?.nombre ?? "Conjunto seleccionado"}` : " · Todos los conjuntos"}{filtros.guardiaUserId ? ` · ${catalogo.guardas.find(g => g.id === filtros.guardiaUserId)?.nombre ?? "Guarda seleccionado"}` : ""}</span></summary>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <Campo titulo="Desde"><Input type="date" value={filtros.desde} onChange={e => actualizar({ desde: e.target.value, guardiaUserId: "" })} /></Campo>
        <Campo titulo="Hasta"><Input type="date" value={filtros.hasta} onChange={e => actualizar({ hasta: e.target.value, guardiaUserId: "" })} /></Campo>
        <Campo titulo="Condominio"><Select value={filtros.condominioId} onChange={e => actualizar({ condominioId: e.target.value, guardiaUserId: "" })}><option value="">Todos los conjuntos</option>{catalogo.conjuntos.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}</Select></Campo>
        <Campo titulo="Guarda"><Select value={filtros.guardiaUserId} onChange={e => actualizar({ guardiaUserId: e.target.value })}><option value="">Todos los guardas</option>{catalogo.guardas.map(g => <option key={g.id} value={g.id}>{g.nombre}</option>)}</Select></Campo>
        <Campo titulo="Agrupar por"><Select value={agrupacion} onChange={e => setAgrupacion(e.target.value as Agrupacion)}><option value="compania">Compañía</option><option value="condominio">Condominio</option><option value="guarda">Guarda</option></Select></Campo>
        <Campo titulo="Tendencia por"><Select value={filtros.granularidad} onChange={e => actualizar({ granularidad: e.target.value as Filtros["granularidad"] })}><option value="dia">Día</option><option value="semana">Semana</option><option value="mes">Mes</option></Select></Campo>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">Fechas inclusivas en hora de Colombia. Hasta 366 días. La actividad histórica se limita a conjuntos con contrato vigente hoy y a las asignaciones que cubrían cada registro.</p>
      </details>
    </Card>
    {!valido ? <p role="alert" className="text-sm text-destructive">Selecciona un rango válido, en orden, de hasta 366 días.</p> : <ErrorBoundary resetKey={`${JSON.stringify(filtros)}-${reintento}`} fallback={error => <Card><ErrorMessage title="No se pudo cargar la operación" detail={errorOperacion(error)} /><div className="flex justify-center"><Button variant="outline" onClick={() => setReintento(n => n + 1)}>Reintentar</Button></div></Card>}><Resultados filtros={filtros} agrupacion={agrupacion} onCatalogo={setCatalogo} onFiltrar={actualizar} /></ErrorBoundary>}
    <Card className="text-xs leading-relaxed text-muted-foreground"><details><summary className="cursor-pointer font-medium text-foreground">Fuentes y alcance de las métricas</summary><div className="mt-3 space-y-2"><p>Un turno compartido cuenta una vez en compañía y conjunto, y una participación para cada guarda. «Aperturas como titular» indica quién inició el turno. Los cerrados son el estado actual de los turnos iniciados en el periodo. Las rondas se agrupan por su inicio; la minuta y las novedades, por fecha de registro.</p><p>La minuta cuenta entradas de bitácora, incluidas acciones automáticas. Las novedades cuentan reportes de seguridad, sin volver a sumar su evento de minuta. Los aportes voluntarios se separan mediante la clasificación del módulo operativo. Las distribuciones usan módulos, tipos y prioridades guardados.</p><p>No existe programación de turnos ni frecuencia obligatoria de rondas: no se calculan ausencias, puntualidad o cumplimiento. Las rondas antiguas sin estado se interpretan como finalizadas según el módulo actual. Registros sin autor se incluyen únicamente en compañía/conjunto durante la vigencia contractual y no se adjudican a guardas. La autoría de esos registros no permite confirmar su pertenencia a la compañía.</p><p>Los incidentes de compañía son casos de otro módulo y se consultan en su dashboard existente.</p></div></details></Card>
  </div></PageContainer>;
}
function Campo({ titulo, children }: { titulo: string; children: React.ReactNode }) { return <label className="block space-y-1.5 text-xs font-medium"> <span>{titulo}</span>{children}</label>; }

function Resultados({ filtros, agrupacion, onCatalogo, onFiltrar }: { filtros: Filtros; agrupacion: Agrupacion; onCatalogo: (c: Catalogo) => void; onFiltrar: (c: Partial<Filtros>) => void }) {
  const datos = useQuery(api.companias.operacion, { desde: filtros.desde, hasta: filtros.hasta, granularidad: filtros.granularidad,
    condominioId: filtros.condominioId ? filtros.condominioId as Id<"condominios"> : undefined,
    guardiaUserId: filtros.guardiaUserId ? filtros.guardiaUserId as Id<"users"> : undefined });
  const [serie, setSerie] = useState<Serie>("turnos");
  const [mostrarTipos, setMostrarTipos] = useState(false);
  useEffect(() => { if (datos) onCatalogo({ conjuntos: datos.conjuntos, guardas: datos.guardas }); }, [datos, onCatalogo]);
  if (!datos) return <div role="status" aria-label="Cargando estadísticas" className="space-y-4"><div className="grid grid-cols-2 gap-4 lg:grid-cols-4">{[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-28 rounded-xl" />)}</div><Skeleton className="h-72 rounded-xl" /></div>;
  const total = datos.total;
  const guarda = datos.guardas.find(g => g.id === filtros.guardiaUserId);
  const etiquetaSerie = (key: Serie) => key === "turnos" && (guarda || agrupacion === "guarda") ? "Participaciones en turnos" : series[key];
  const filas = agrupacion === "condominio" ? datos.porConjunto : agrupacion === "guarda" ? datos.porGuarda : [{ id: "compania", nombre: datos.compania, ...total }];
  const detalle = (id: string) => { if (agrupacion === "guarda") onFiltrar({ guardiaUserId: id }); if (agrupacion === "condominio") onFiltrar({ condominioId: id, guardiaUserId: "" }); };
  const tituloTurnos = guarda ? "Participaciones en turnos" : "Turnos iniciados";
  return <div className="space-y-5">
    {guarda && <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-brand/30 bg-brand/5 p-4"><h2 className="font-semibold">Actividad de {guarda.nombre}</h2><Button variant="ghost" size="sm" onClick={() => onFiltrar({ guardiaUserId: "" })}>Ver todos los guardas</Button></div>}
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      <Metrica titulo={tituloTurnos} valor={total.turnos} contexto={`${total.cerrados} cerrados · ${datos.porGuarda.filter(g => g.turnos > 0).length} guardas participantes`} />
      <Metrica titulo="Rondas finalizadas" valor={total.rondas} contexto={`${total.rondasEnCurso} iniciadas en el periodo aún en curso`} />
      <Metrica titulo="Entradas de minuta" valor={total.minuta} contexto="Bitácora manual y automática" />
      <Metrica titulo="Novedades reportadas" valor={total.novedades} contexto={`${total.aportes} reportes de aporte voluntario por separado`} />
    </div>
    <Card className="space-y-3"><h2 className="flex items-center gap-2 font-semibold"><ShieldCheck className="h-4 w-4 text-brand" />Turnos abiertos ahora <span className="tabular-nums">({datos.activos.length})</span></h2><p className="text-xs text-muted-foreground">Estado actual de los conjuntos y guarda seleccionados, independiente del rango de fechas.</p>{datos.activos.length ? <ul className="grid gap-2 md:grid-cols-2">{datos.activos.map(t => <li key={t.id}><Link href={`/vigilancia/${t.condominioId}`} className="block rounded-lg border border-border p-3 text-sm hover:bg-accent"><strong>{t.conjunto}</strong><p className="break-words">{t.guardas}</p><p className="text-xs text-muted-foreground">Desde {fecha(t.desde)}</p></Link></li>)}</ul> : <p className="text-sm text-muted-foreground">No hay turnos abiertos atribuibles a la compañía en esta selección.</p>}</Card>
    {!datos.conjuntos.length ? <EmptyState icon={Building2} title="Sin conjuntos con contrato vigente" description="Los contratos vigentes habilitan la consulta operativa de la compañía." /> : !(total.turnos + total.rondas + total.rondasEnCurso + total.minuta + total.novedades + total.aportes) ? <EmptyState icon={Activity} title="Sin actividad registrada en este periodo" description="Prueba otro rango o revisa los filtros. La falta de registros no demuestra una ausencia de turno." /> : null}
    <Card className="space-y-3"><div className="flex flex-wrap items-end justify-between gap-3"><div><h2 className="font-semibold">Tendencia de actividad</h2><p className="text-xs text-muted-foreground">Incluye intervalos sin actividad. Las semanas parten de la fecha inicial.</p></div><Campo titulo="Métrica"><Select value={serie} onChange={e => setSerie(e.target.value as Serie)}>{Object.entries(series).map(([key, label]) => <option key={key} value={key}>{etiquetaSerie(key as Serie)}</option>)}</Select></Campo></div><div aria-hidden><AreaChart data={datos.evolucion.map(p => ({ label: p.label.slice(5), value: p[serie] }))} color={CHART.sky} labelEvery={Math.ceil(datos.evolucion.length / 8)} /></div><details><summary className="cursor-pointer text-sm">Ver valores por intervalo</summary><div className="mt-3 max-h-64 overflow-auto text-sm"><table className="w-full text-left"><thead><tr><th>Desde</th><th>Hasta</th><th>{etiquetaSerie(serie)}</th></tr></thead><tbody>{datos.evolucion.map(p => <tr key={p.desde}><td>{dia(p.desde)}</td><td>{dia(p.hasta)}</td><td>{p[serie]}</td></tr>)}</tbody></table></div></details></Card>
    <div className="grid gap-4 lg:grid-cols-2"><Distribucion titulo="Distribución de la minuta por módulo" items={datos.modulos} /><Distribucion titulo="Novedades por prioridad" items={Object.entries(datos.prioridades).map(([label, value]) => ({ label, value }))} /></div>
    <Card className="space-y-3"><h2 className="font-semibold">Tipos más frecuentes en la minuta</h2><p className="text-xs text-muted-foreground">Tipos originales, acompañados de su módulo.</p>{datos.tipos.length ? <HBars data={mostrarTipos ? datos.tipos : datos.tipos.slice(0, 10)} color={CHART.accent} /> : <p className="text-sm text-muted-foreground">Sin entradas en este periodo.</p>}{datos.tipos.length > 10 && <Button variant="outline" size="sm" onClick={() => setMostrarTipos(v => !v)}>{mostrarTipos ? "Mostrar menos" : `Ver todos (${datos.tipos.length})`}</Button>}</Card>
    <Card className="space-y-4"><h2 className="font-semibold">Comparación por {agrupacion === "compania" ? "compañía" : agrupacion === "condominio" ? "condominio" : "guarda"}</h2><p className="text-xs text-muted-foreground">{agrupacion === "guarda" ? "Turnos indica participaciones; aperturas indica inicios como titular. Selecciona un nombre para ver su detalle." : agrupacion === "condominio" ? "Selecciona un conjunto para profundizar en su actividad." : "Totales del periodo y filtros seleccionados."}</p><HBars data={[...filas].sort((a, b) => b[serie] - a[serie]).slice(0, 10).map(f => ({ label: `${f.nombre} (${f.id.slice(-5)})`, value: f[serie] }))} color={CHART.sky} /><p className="text-xs text-muted-foreground">Barras: {etiquetaSerie(serie)}, hasta 10 filas con mayor actividad. La tabla incluye todas.</p><div className="max-h-96 overflow-auto"><table className="w-full min-w-[760px] text-left text-sm"><caption className="sr-only">Resumen operativo de la selección</caption><thead><tr className="border-b text-xs text-muted-foreground">{["Nombre", "Turnos", "Aperturas", "Cerrados", "Rondas", "En curso", "Minuta", "Novedades", "Aportes"].map(t => <th key={t} scope="col" className="px-3 py-3">{t}</th>)}</tr></thead><tbody>{filas.map(f => <tr key={f.id} className="border-b border-border/60"><th scope="row" className="px-3 py-3 font-medium">{agrupacion === "compania" ? f.nombre : <button className="text-left text-brand underline" onClick={() => detalle(f.id)}>{f.nombre}</button>}{agrupacion === "guarda" && !f.turnos && <span className="block text-xs font-normal text-muted-foreground">Sin participación en turnos registrada</span>}</th>{[f.turnos, f.inicios, f.cerrados, f.rondas, f.rondasEnCurso, f.minuta, f.novedades, f.aportes].map((n, i) => <td key={i} className="px-3 py-3 tabular-nums">{n}</td>)}</tr>)}</tbody></table></div></Card>
    <div className="grid gap-4 sm:grid-cols-2"><Card><h2 className="text-sm font-medium">Duración promedio de rondas</h2><p className="mt-2 text-2xl font-semibold">{datos.duracionRondas.promedioMs === null ? "Sin muestra válida" : `${Math.round(datos.duracionRondas.promedioMs / 60_000)} min`}</p><p className="mt-2 text-xs text-muted-foreground">{datos.duracionRondas.muestra} rondas finalizadas con inicio y cierre válidos.</p></Card><Card><h2 className="text-sm font-medium">Registros sin autor identificado</h2><p className="mt-2 text-sm">{datos.sinAutorRondas} rondas · {datos.sinAutorMinuta} entradas de minuta</p><p className="mt-2 text-xs text-muted-foreground">Solo en totales de compañía y conjunto; no forman parte de estadísticas individuales.</p></Card></div>
  </div>;
}
function Metrica({ titulo, valor, contexto }: { titulo: string; valor: number; contexto: string }) { return <Card><h2 className="text-sm text-muted-foreground">{titulo}</h2><p className="mt-2 text-3xl font-semibold tabular-nums">{valor.toLocaleString("es-CO")}</p><p className="mt-2 text-xs text-muted-foreground">{contexto}</p></Card>; }
function Distribucion({ titulo, items }: { titulo: string; items: { label: string; value: number }[] }) { return <Card className="space-y-3"><h2 className="font-semibold">{titulo}</h2>{items.some(i => i.value) ? <HBars data={items} color={CHART.accent} /> : <p className="text-sm text-muted-foreground">Sin registros en este periodo.</p>}</Card>; }
