"use client";

import Link from "next/link";
import { useQuery } from "convex/react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { AlertTriangle, Plus } from "lucide-react";
import { api } from "@vekino/backend/api";
import type { FunctionReturnType } from "convex/server";
import type { Id } from "@vekino/backend/dataModel";
import { PageContainer } from "@/components/layout/page-container";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorBoundary, ErrorMessage } from "@/components/ui/error-boundary";
import { Input, Select } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { etiquetaTipoIncidente, PRIORIDADES_INCIDENTE, TIPOS_INCIDENTE } from "@/lib/incidentes-ui";
import { ESTADOS_INCIDENTE, etiquetaEstado, fechaIncidente, filtrosBandeja } from "@/lib/incidentes-bandeja";

import { Campo } from "./incidente-campo";

type Contexto = NonNullable<FunctionReturnType<typeof api.incidentes.contextoBandeja>>;

export function IncidentesInicio({ baseHref, condominioId }: { baseHref: string; condominioId?: Id<"condominios"> }) {
  const contexto = useQuery(api.incidentes.contextoBandeja);
  if (contexto === undefined) return <PageContainer><Skeleton className="h-96 rounded-2xl" /></PageContainer>;
  if (!contexto || (!contexto.todosLosConjuntos && !contexto.conjuntos.length) || (condominioId && !contexto.conjuntos.some((c) => c.condominioId === condominioId))) {
    return <PageContainer><EmptyState icon={AlertTriangle} title="Sin alcance disponible" description="Necesitas una relación vigente con una compañía y un conjunto para consultar sus incidentes." /></PageContainer>;
  }
  return <Bandeja contexto={contexto} baseHref={baseHref} condominioId={condominioId} />;
}

function Bandeja({ contexto, baseHref, condominioId }: { contexto: Contexto; baseHref: string; condominioId?: Id<"condominios"> }) {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const [reintento, setReintento] = useState(0);
  const conjunto = condominioId ?? (!contexto.todosLosConjuntos ? params.get("conjunto") || (params.get("alcance") === "mis-conjuntos" ? undefined : contexto.conjuntos[0]?.condominioId) : undefined);
  const filtros = filtrosBandeja(new URLSearchParams(params.toString()), conjunto);
  const crear = contexto.conjuntos.some((c) => c.crear && (!condominioId || c.condominioId === condominioId));
  function aplicar(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const siguiente = new URLSearchParams();
    for (const [key, value] of new FormData(event.currentTarget)) if (String(value)) siguiente.set(key, String(value));
    if (siguiente.get("conjunto") === "MIS_CONJUNTOS") { siguiente.delete("conjunto"); siguiente.set("alcance", "mis-conjuntos"); }
    router.push(`${pathname}?${siguiente}`, { scroll: false });
  }
  return <PageContainer className="mx-auto w-full max-w-7xl pb-12">
    <PageHeader title="Incidentes" description="Consulta y gestiona los casos de tu operación." action={<div className="flex flex-wrap gap-2">{baseHref === "/vigilancia/incidentes" && <Button variant="outline" asChild><Link href={`${baseHref}/dashboard?${params.get("dashboard") ?? ""}`}>{params.has("dashboard") ? "Volver al dashboard" : "Dashboard"}</Link></Button>}{baseHref === "/vigilancia/incidentes" && <Button variant="outline" asChild><Link href={`${baseHref}/reportes`}>Reportes</Link></Button>}{crear ? <Button asChild><Link href={`${baseHref}/nuevo`}><Plus className="h-4 w-4" aria-hidden /> Nuevo incidente</Link></Button> : null}</div>} />
    <Card className="p-4 sm:p-5">
      <form key={params.toString()} onSubmit={aplicar} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {params.has("dashboard") && <input type="hidden" name="dashboard" value={params.get("dashboard")!} />}
        {params.has("zona") && <input type="hidden" name="zona" value={params.get("zona")!} />}
        <Campo label="Buscar"><Input name="q" maxLength={200} placeholder="Texto o referencia completa" defaultValue={params.get("q") ?? ""} /></Campo>
        <Campo label="Buscar en"><Select name="campo" defaultValue={params.get("campo") ?? "ubicacion"}><option value="ubicacion">Ubicación</option><option value="descripcion">Descripción</option><option value="referencia">Referencia exacta</option></Select></Campo>
        <Campo label="Estado"><Select name="estado" defaultValue={params.get("estado") ?? "ACTIVOS"}><option value="ACTIVOS">Activos</option><option value="TODOS">Todos</option>{ESTADOS_INCIDENTE.map((e) => <option key={e} value={e}>{etiquetaEstado(e)}</option>)}</Select></Campo>
        <Campo label="Prioridad"><Select name="prioridad" defaultValue={params.get("prioridad") ?? ""}><option value="">Todas</option>{PRIORIDADES_INCIDENTE.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</Select></Campo>
        <details className="sm:col-span-2 lg:col-span-4"><summary className="cursor-pointer text-sm font-medium">Conjunto, tipo y fechas{filtros.tipo || filtros.desde || filtros.hasta || filtros.condominioId ? " · Filtros aplicados" : ""}</summary><div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {!condominioId && <Campo label="Conjunto"><Select name="conjunto" defaultValue={filtros.condominioId ?? (filtros.todosMisConjuntos ? "MIS_CONJUNTOS" : "")}>{!contexto.todosLosConjuntos && <option value="MIS_CONJUNTOS">Todos mis conjuntos</option>}{contexto.todosLosConjuntos && <option value="">Todos</option>}{contexto.conjuntos.map((c) => <option key={c.condominioId} value={c.condominioId}>{c.condominioNombre}{!c.crear ? " · Histórico" : ""}</option>)}</Select></Campo>}
        <Campo label="Tipo"><Input name="tipo" list="tipos-incidente" placeholder="Todos" maxLength={80} defaultValue={params.get("tipo") ?? ""} /><datalist id="tipos-incidente">{TIPOS_INCIDENTE.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</datalist></Campo>
        {params.get("zona") === "America/Bogota" && <p className="text-xs text-muted-foreground">Fechas en Colombia (UTC−5).</p>}
        <Campo label="Fecha de referencia"><Select name="fecha" defaultValue={filtros.fecha}><option value="reportadoEn">Reporte</option><option value="ocurrioEn">Hecho</option></Select></Campo>
        <Campo label="Orden"><Select name="orden" defaultValue={filtros.orden} disabled={!!filtros.busqueda && filtros.campoBusqueda !== "referencia"}><option value="desc">Más recientes primero</option><option value="asc">Más antiguos primero</option></Select></Campo>
        <Campo label="Desde"><Input name="desde" type="date" defaultValue={params.get("desde") ?? ""} /></Campo>
        <Campo label="Hasta"><Input name="hasta" type="date" min={params.get("desde") ?? undefined} defaultValue={params.get("hasta") ?? ""} /></Campo>
        </div></details>
        <div className="flex flex-wrap items-end gap-2 sm:col-span-2"><Button type="submit">Aplicar filtros</Button><Button variant="outline" asChild><Link href={`${baseHref}?estado=TODOS`}>Limpiar filtros</Link></Button></div>
      </form>
      {filtros.busqueda && filtros.campoBusqueda !== "referencia" && <p className="mt-3 text-xs text-muted-foreground">Resultados ordenados por relevancia del texto.</p>}
      {!contexto.todosLosConjuntos && !condominioId && <p className="mt-3 text-xs text-muted-foreground">Solo se incluyen tus conjuntos y casos autorizados.</p>}
    </Card>
    <ErrorBoundary resetKey={`${params}:${reintento}`} fallback={() => <Card className="p-4"><ErrorMessage title="No se pudieron cargar los incidentes" detail="Revisa tu sesión, el acceso al conjunto o el rango de fechas." /><Button variant="outline" onClick={() => setReintento((r) => r + 1)}>Reintentar</Button></Card>}>
      <Resultados companiaId={contexto.companiaId} filtros={filtros} params={new URLSearchParams(params.toString())} baseHref={baseHref} />
    </ErrorBoundary>
  </PageContainer>;
}

function Resultados({ companiaId, filtros, params, baseHref }: { companiaId: Id<"companiasSeguridad">; filtros: ReturnType<typeof filtrosBandeja>; params: URLSearchParams; baseHref: string }) {
  const cursor = params.get("cursor");
  const datos = useQuery(api.incidentes.listar, { companiaId, ...filtros, paginationOpts: { cursor, numItems: 20 } });
  const vacio = datos?.isDone && !datos.page.length && !cursor;
  const alguno = useQuery(api.incidentes.listar, vacio ? { companiaId, condominioId: filtros.condominioId, todosMisConjuntos: filtros.todosMisConjuntos, paginationOpts: { cursor: null, numItems: 1 } } : "skip");
  useEffect(() => {
    const seleccionado = params.get("seleccion");
    if (seleccionado && datos) document.getElementById(`caso-${seleccionado}`)?.focus({ preventScroll: true });
  }, [datos, params]);
  if (!datos) return <Skeleton className="h-72 rounded-2xl" />;
  if (vacio && alguno === undefined) return <Skeleton className="h-44 rounded-2xl" />;
  const siguiente = new URLSearchParams(params); siguiente.set("cursor", datos.continueCursor); siguiente.delete("seleccion");
  const primera = new URLSearchParams(params); primera.delete("cursor"); primera.delete("seleccion");
  return <div className="space-y-4">
    {vacio ? <EmptyState icon={AlertTriangle} title={alguno?.page.length === 0 ? "Todavía no hay incidentes registrados." : "No encontramos incidentes con los filtros seleccionados."} description={alguno?.page.length === 0 ? "Registra el primer caso de este ámbito cuando ocurra un hecho." : "Prueba otro periodo o cambia los filtros."} /> : <>
      <p role="status" className="text-xs text-muted-foreground">{datos.page.length} casos en esta página</p>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {datos.page.map((c) => { const prioridad = PRIORIDADES_INCIDENTE.find((p) => p.value === c.prioridad); return <Link id={`caso-${c._id}`} key={c._id} href={`${baseHref}/${c._id}?volver=${encodeURIComponent(params.toString())}`} className="rounded-2xl border border-border bg-card p-4 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-semibold">{etiquetaTipoIncidente(c.tipo)}</h2><Badge tone={prioridad?.tone ?? "neutral"}>{prioridad?.label ?? c.prioridad}</Badge></div>
          <Badge className="mt-2" tone={c.estado === "CERRADO" ? "neutral" : "info"}>{etiquetaEstado(c.estado)}</Badge>
          <p className="mt-3 break-words text-sm font-medium">{c.condominioNombre}</p><p className="mt-1 break-words text-sm text-muted-foreground">{c.ubicacion}</p>
          <dl className="mt-3 space-y-1 text-xs"><div><dt className="inline text-muted-foreground">Hecho: </dt><dd className="inline">{fechaIncidente(c.ocurrioEn, params.get("zona") === "America/Bogota" ? "America/Bogota" : undefined)}</dd></div><div><dt className="inline text-muted-foreground">Reporte: </dt><dd className="inline">{fechaIncidente(c.reportadoEn, params.get("zona") === "America/Bogota" ? "America/Bogota" : undefined)}</dd></div>{c.responsableNombre && <div><dt className="inline text-muted-foreground">Responsable: </dt><dd className="inline">{c.responsableNombre}</dd></div>}</dl>
          <p className="mt-3 break-all text-[11px] text-muted-foreground">Referencia {c._id}</p>
        </Link>; })}
      </div>
      {!datos.page.length && <p className="text-sm text-muted-foreground">{datos.isDone ? "No hay más resultados con los filtros seleccionados." : "No hay coincidencias en este tramo. Continúa consultando para completar la búsqueda."}</p>}
    </>}
    <div className="flex flex-wrap gap-2">{cursor && <Button variant="outline" asChild><Link href={`${baseHref}?${primera}`}>Primera página</Link></Button>}{!datos.isDone && <Button variant="outline" asChild><Link href={`${baseHref}?${siguiente}`}>Siguiente página</Link></Button>}</div>
  </div>;
}
