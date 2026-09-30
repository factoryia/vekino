"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@vekino/backend/api";
import { PERIODOS_INCIDENTES, diaColombia, periodoIncidentes } from "@vekino/backend/incidenteMetricas";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { Input, Select } from "@/components/ui/input";
import { ESTADOS_INCIDENTE, etiquetaEstado } from "@/lib/incidentes-bandeja";
import { PRIORIDADES_INCIDENTE } from "@/lib/incidentes-ui";
import { filtrosDashboard } from "@/lib/incidentes-dashboard";
import { Campo } from "./incidente-campo";

type Contexto = NonNullable<FunctionReturnType<typeof api.incidentes.contextoBandeja>>;
export function FiltrosReporteIncidentes({ contexto, ruta, children, fallback }: { contexto: Contexto; ruta: string; children: (filtros: ReturnType<typeof filtrosDashboard>, params: URLSearchParams, pendientes: boolean) => React.ReactNode; fallback: (error: Error, reintentar: () => void) => React.ReactNode }) {
  const params = useSearchParams();
  const router = useRouter();
  const efectivos = new URLSearchParams(params.toString());
  if (!contexto.todosLosConjuntos && contexto.conjuntos.length === 1 && !efectivos.has("conjunto")) efectivos.set("conjunto", contexto.conjuntos[0]!.condominioId);
  const filtros = filtrosDashboard(efectivos);
  const [intento, setIntento] = useState(0);
  const [pendientes, setPendientes] = useState(false);
  const [periodo, setPeriodo] = useState(filtros.periodo);
  let rango;
  try { rango = periodoIncidentes(filtros.periodo, filtros.desde, filtros.hasta); } catch { /* La query y el boundary presentan el error. */ }
  const unConjunto = !contexto.todosLosConjuntos && contexto.conjuntos.length === 1 ? contexto.conjuntos[0]! : undefined;
  const restringido = !contexto.todosLosConjuntos && contexto.conjuntos.every((c) => c.soloPropios);
  function aplicar(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const siguiente = new URLSearchParams();
    for (const [clave, valor] of new FormData(event.currentTarget)) if (String(valor)) siguiente.set(clave, String(valor));
    if (siguiente.get("periodo") !== "personalizado") { siguiente.delete("desde"); siguiente.delete("hasta"); }
    router.push(`${ruta}?${siguiente}`, { scroll: false });
  }
  return <>
    <Card className="p-4 sm:p-5"><form key={params.toString()} onSubmit={aplicar} onChange={() => setPendientes(true)} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <Campo label="Periodo"><Select name="periodo" defaultValue={filtros.periodo} onChange={(e) => setPeriodo(e.target.value)}>{PERIODOS_INCIDENTES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</Select></Campo>
      {unConjunto ? <div className="text-sm"><p className="text-xs text-muted-foreground">Conjunto disponible</p><p className="break-words font-medium">{unConjunto.condominioNombre}</p>{filtros.condominioId && <input type="hidden" name="conjunto" value={filtros.condominioId} />}</div> : <Campo label="Conjunto"><Select name="conjunto" defaultValue={filtros.condominioId ?? ""}><option value="">{contexto.todosLosConjuntos ? "Todos los conjuntos autorizados" : "Todos mis conjuntos"}</option>{contexto.conjuntos.map((c) => <option key={c.condominioId} value={c.condominioId}>{c.condominioNombre}</option>)}</Select></Campo>}
      <Campo label="Estado"><Select name="estado" defaultValue={params.get("estado") ?? "TODOS"}><option value="TODOS">Todos</option><option value="ACTIVOS">Activos</option>{ESTADOS_INCIDENTE.map((e) => <option key={e} value={e}>{etiquetaEstado(e)}</option>)}</Select></Campo>
      <Campo label="Prioridad"><Select name="prioridad" defaultValue={filtros.prioridad ?? ""}><option value="">Todas</option>{PRIORIDADES_INCIDENTE.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</Select></Campo>
      <Campo label="Tipo registrado"><Input name="tipo" maxLength={80} placeholder="Todos · valor exacto" defaultValue={filtros.tipo ?? ""} /></Campo>
      {periodo === "personalizado" && <><Campo label="Desde"><Input name="desde" type="date" required defaultValue={filtros.desde ?? rango?.desdeDia ?? diaColombia(Date.now())} /></Campo><Campo label="Hasta"><Input name="hasta" type="date" required defaultValue={filtros.hasta ?? rango?.hastaDia ?? diaColombia(Date.now())} /></Campo></>}
      <div className="flex flex-wrap items-end gap-2"><Button type="submit">Aplicar filtros</Button><Button asChild variant="outline"><Link href={ruta}>Limpiar filtros</Link></Button></div>
    </form>{restringido && <p className="mt-3 text-xs text-muted-foreground">Métricas limitadas a tus propios incidentes autorizados.</p>}</Card>
    <ErrorBoundary resetKey={`${params}:${intento}`} fallback={(error) => fallback(error, () => setIntento((n) => n + 1))}>{children(filtros, efectivos, pendientes)}</ErrorBoundary>
  </>;
}
