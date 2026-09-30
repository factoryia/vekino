"use client";

import Link from "next/link";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { useSearchParams } from "next/navigation";
import { useRef, useState } from "react";
import { ArrowLeft, CheckCircle2 } from "lucide-react";
import { api } from "@vekino/backend/api";
import type { Id } from "@vekino/backend/dataModel";
import type { FunctionReturnType } from "convex/server";
import { PageContainer } from "@/components/layout/page-container";
import { PageHeader } from "@/components/layout/page-header";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { ErrorBoundary, ErrorMessage } from "@/components/ui/error-boundary";
import { Skeleton } from "@/components/ui/skeleton";
import { etiquetaTipoIncidente, PRIORIDADES_INCIDENTE, TIPOS_PERSONA } from "@/lib/incidentes-ui";
import { etiquetaEstado, fechaIncidente as fecha, mensajeErrorGestion, requisitosTransicion, type EstadoIncidente } from "@/lib/incidentes-bandeja";

type Caso = FunctionReturnType<typeof api.incidentes.obtener>;

export function IncidenteVistaInicial({ incidenteId, baseHref, registrado, condominioId }: {
  incidenteId: Id<"incidentes">; baseHref: string; registrado: boolean; condominioId?: Id<"condominios">;
}) {
  const incidente = useQuery(api.incidentes.obtener, { incidenteId });
  const params = useSearchParams();
  const volver = new URLSearchParams(params.get("volver") ?? "");
  volver.set("seleccion", incidenteId);
  const prioridad = PRIORIDADES_INCIDENTE.find((x) => x.value === incidente?.prioridad);
  return <PageContainer className="mx-auto w-full max-w-5xl pb-16">
    <Link href={`${baseHref}?${volver}`} className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" aria-hidden /> Volver a incidentes</Link>
    {incidente === undefined ? <Skeleton className="h-72 rounded-2xl" /> : condominioId && incidente.condominioId !== condominioId ? <ErrorMessage title="El incidente no corresponde a este conjunto" /> : <>
      {registrado && <div role="status" className="flex items-start gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /><span>El incidente fue registrado correctamente.</span></div>}
      <PageHeader title={etiquetaTipoIncidente(incidente.tipo)} description={`Referencia ${incidente._id}`} action={<div className="flex flex-wrap gap-2"><Badge tone={prioridad?.tone ?? "neutral"}>{prioridad?.label ?? incidente.prioridad}</Badge><Badge tone="info">{etiquetaEstado(incidente.estado)}</Badge></div>} />
      <Card className="space-y-5 p-5 sm:p-6">
        <h2 className="text-base font-semibold">Información actual</h2>
        <dl className="grid gap-4 sm:grid-cols-2">
          <Dato label="Conjunto" valor={incidente.condominioNombre} /><Dato label="Ubicación" valor={incidente.ubicacion} />
          <Dato label="Fecha y hora del hecho" valor={fecha(incidente.ocurrioEn)} /><Dato label="Fecha de reporte" valor={fecha(incidente.reportadoEn)} />
          <Dato label="Reportado por" valor={incidente.reportadoPorNombre} /><Dato label="Responsable" valor={incidente.responsableNombre ?? "Sin asignar"} />
          {incidente.resueltoEn && <Dato label="Fecha de resolución" valor={fecha(incidente.resueltoEn)} />}
          {incidente.cerradoEn && <Dato label="Fecha de cierre" valor={fecha(incidente.cerradoEn)} />}
        </dl>
        <div className="border-t border-border pt-4"><h3 className="text-sm font-semibold">Descripción</h3><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed">{incidente.descripcion}</p></div>
        {incidente.resolucionObservacion && <div className="border-t border-border pt-4"><h3 className="text-sm font-semibold">Resolución declarada</h3><p className="mt-2 whitespace-pre-wrap break-words text-sm">{incidente.resolucionObservacion}</p></div>}
      </Card>
      {incidente.estado === "CERRADO" ? <p role="status" className="text-sm text-muted-foreground">Caso cerrado. La información y el historial están disponibles para consulta.</p> : incidente.permisos.gestionar ? <Gestion key={incidente.estado} incidente={incidente} /> : <p className="text-sm text-muted-foreground">Consulta del caso. Tu alcance actual no permite gestionar el estado ni registrar seguimientos.</p>}
      <ErrorBoundary resetKey={incidenteId} fallback={() => <ErrorMessage title="No se pudieron cargar las personas" />}><Personas incidenteId={incidenteId} agregar={incidente.permisos.agregarPersona} /></ErrorBoundary>
      <ErrorBoundary resetKey={incidenteId} fallback={() => <ErrorMessage title="No se pudo cargar el historial" />}><Historial incidenteId={incidenteId} /></ErrorBoundary>
    </>}
  </PageContainer>;
}

/** Serializa envíos de gestión, conserva formularios rechazados y anuncia el resultado. */
function useOperacion() {
  const bloqueo = useRef(false);
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState("");
  const [exito, setExito] = useState("");
  async function ejecutar(accion: () => Promise<unknown>, mensaje: string, limpiar?: () => void) {
    if (bloqueo.current) return;
    bloqueo.current = true; setOcupado(true); setError(""); setExito("");
    try { await accion(); limpiar?.(); setExito(mensaje); }
    catch (e) { setError(mensajeErrorGestion(e)); }
    finally { bloqueo.current = false; setOcupado(false); }
  }
  return { ocupado, ejecutar, aviso: <>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}{exito && <p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">{exito}</p>}</> };
}

function Gestion({ incidente }: { incidente: Caso }) {
  const cambiar = useMutation(api.incidentes.cambiarEstado);
  const seguimiento = useMutation(api.incidentes.registrarSeguimiento);
  const prioridad = useMutation(api.incidentes.cambiarPrioridad);
  const [estado, setEstado] = useState<EstadoIncidente | "">("");
  const operacion = useOperacion();
  const requisitos = estado ? requisitosTransicion(incidente.estado, estado) : { motivo: false, resolucion: false };
  function transicion(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); if (!estado || !incidente.transiciones.includes(estado)) return;
    const datos = new FormData(e.currentTarget);
    void operacion.ejecutar(() => cambiar({ incidenteId: incidente._id, estado,
      ...(requisitos.motivo ? { motivo: String(datos.get("motivo")).trim() } : {}),
      ...(requisitos.resolucion ? { resolucionObservacion: String(datos.get("resolucion")).trim() } : {}),
    }), "Estado actualizado.");
  }
  return <Card className="space-y-5 p-5 sm:p-6">
    <h2 className="text-base font-semibold">Gestionar incidente</h2>{operacion.aviso}
    <form onSubmit={transicion}>
      <fieldset disabled={operacion.ocupado} className="space-y-3">
        <Campo label="Acción sobre el estado"><Select required value={estado} onChange={(e) => setEstado(e.target.value as EstadoIncidente)}><option value="">Selecciona una acción</option>{incidente.transiciones.map((s) => <option key={s} value={s}>{s === "RESUELTO" ? "Resolver incidente" : s === "CERRADO" ? "Cerrar incidente" : s === "EN_INVESTIGACION" && incidente.estado === "EN_SEGUIMIENTO" ? "Volver a investigación" : s === "EN_SEGUIMIENTO" && incidente.estado === "RESUELTO" ? "Volver a seguimiento" : `Pasar a ${etiquetaEstado(s).toLowerCase()}`}</option>)}</Select></Campo>
        {estado && <CamposTransicionIncidente actual={incidente.estado} siguiente={estado} />}
        {estado && <div className="flex flex-wrap gap-2"><Button type="submit">{operacion.ocupado ? "Guardando…" : estado === "RESUELTO" ? "Confirmar resolución" : estado === "CERRADO" ? "Confirmar cierre" : "Confirmar transición"}</Button><Button type="button" variant="outline" onClick={() => setEstado("")}>Cancelar</Button></div>}
      </fieldset>
    </form>
    <form className="border-t border-border pt-4" onSubmit={(e) => { e.preventDefault(); const form = e.currentTarget; const observacion = String(new FormData(form).get("observacion")).trim(); if (!observacion) return; void operacion.ejecutar(() => seguimiento({ incidenteId: incidente._id, observacion }), "Seguimiento registrado en el historial.", () => form.reset()); }}>
      <fieldset disabled={operacion.ocupado} className="space-y-3"><Campo label="Registrar seguimiento"><Textarea name="observacion" required maxLength={5000} rows={3} placeholder="Describe la actuación realizada…" /></Campo><Button type="submit">Registrar seguimiento</Button></fieldset>
    </form>
    <form className="border-t border-border pt-4" onSubmit={(e) => { e.preventDefault(); const nueva = String(new FormData(e.currentTarget).get("prioridad")) as Caso["prioridad"]; void operacion.ejecutar(() => prioridad({ incidenteId: incidente._id, prioridad: nueva }), "Prioridad actualizada."); }}>
      <fieldset disabled={operacion.ocupado} className="flex flex-wrap items-end gap-3"><Campo label="Prioridad"><Select name="prioridad" key={incidente.prioridad} defaultValue={incidente.prioridad}>{PRIORIDADES_INCIDENTE.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</Select></Campo><Button variant="outline" type="submit">Actualizar prioridad</Button></fieldset>
    </form>
    <ErrorBoundary resetKey={incidente._id} fallback={() => <ErrorMessage title="No se pudieron cargar los responsables disponibles" />}><Responsable incidente={incidente} /></ErrorBoundary>
  </Card>;
}

export function CamposTransicionIncidente({ actual, siguiente }: { actual: EstadoIncidente; siguiente: EstadoIncidente }) {
  const requisitos = requisitosTransicion(actual, siguiente);
  return <>
    {requisitos.motivo && <Campo label="Motivo del retroceso"><Textarea name="motivo" required maxLength={2000} rows={3} /></Campo>}
    {requisitos.resolucion && <><p className="text-sm text-muted-foreground">Declara cómo se resolvió el incidente. Después podrá cerrarlo un administrador.</p><Campo label="Observación de resolución"><Textarea name="resolucion" required maxLength={5000} rows={4} /></Campo></>}
    {siguiente === "CERRADO" && <p className="text-sm text-muted-foreground">El caso ya tiene una resolución declarada. Cerrar finaliza su gestión y bloquea cambios posteriores.</p>}
  </>;
}

function Responsable({ incidente }: { incidente: Caso }) {
  const candidatos = useQuery(api.incidentes.responsablesDisponibles, { incidenteId: incidente._id });
  const asignar = useMutation(api.incidentes.asignarResponsable);
  const operacion = useOperacion();
  return <form className="space-y-3 border-t border-border pt-4" onSubmit={(e) => { e.preventDefault(); const userId = String(new FormData(e.currentTarget).get("responsable")) as Id<"users">; void operacion.ejecutar(() => asignar({ incidenteId: incidente._id, responsableUserId: userId }), "Responsable asignado."); }}>
    {operacion.aviso}<fieldset disabled={operacion.ocupado || candidatos === undefined || !candidatos.length} className="flex flex-wrap items-end gap-3"><Campo label="Asignar responsable"><Select name="responsable" required key={incidente.responsableUserId} defaultValue={incidente.responsableUserId ?? ""}><option value="">Selecciona un administrador o supervisor</option>{candidatos?.map((c) => <option key={c.userId} value={c.userId}>{c.nombre}</option>)}</Select></Campo><Button type="submit" variant="outline">Asignar responsable</Button></fieldset>
    {candidatos === undefined ? <Skeleton className="h-6" /> : !candidatos.length && <p className="text-xs text-muted-foreground">No hay responsables elegibles en el alcance vigente de este caso.</p>}
  </form>;
}

function Personas({ incidenteId, agregar }: { incidenteId: Id<"incidentes">; agregar: boolean }) {
  const personas = useQuery(api.incidentes.listarPersonas, { incidenteId });
  const alta = useMutation(api.incidentes.agregarPersona);
  const operacion = useOperacion();
  return <Card className="space-y-4 p-5 sm:p-6"><h2 className="text-base font-semibold">Personas involucradas</h2>
    {personas === undefined ? <Skeleton className="h-12" /> : !personas.length ? <p className="text-sm text-muted-foreground">No hay personas asociadas al incidente.</p> : <ul className="divide-y divide-border">{personas.map((p) => <li key={p._id} className="break-words py-3 text-sm"><p className="font-medium">{p.nombre} <span className="font-normal text-muted-foreground">· {TIPOS_PERSONA.find((t) => t.value === p.tipoPersona)?.label ?? p.tipoPersona}</span></p>{p.documento && <p className="text-xs text-muted-foreground">Documento: {p.documento}</p>}{p.observacion && <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{p.observacion}</p>}</li>)}</ul>}
    {agregar && <details className="border-t border-border pt-4"><summary className="cursor-pointer text-sm font-medium">Agregar persona involucrada</summary><form className="mt-4 space-y-3" onSubmit={(e) => { e.preventDefault(); const form = e.currentTarget; const datos = new FormData(form); const documento = String(datos.get("documento")).trim(); const observacion = String(datos.get("observacion")).trim(); void operacion.ejecutar(() => alta({ incidenteId, nombre: String(datos.get("nombre")).trim(), tipoPersona: String(datos.get("tipoPersona")), ...(documento ? { documento } : {}), ...(observacion ? { observacion } : {}) }), "Persona agregada y registrada en el historial.", () => form.reset()); }}>
      {operacion.aviso}<fieldset disabled={operacion.ocupado} className="grid gap-3 sm:grid-cols-2"><Campo label="Nombre"><Input name="nombre" required maxLength={160} /></Campo><Campo label="Tipo de persona"><Select name="tipoPersona" required defaultValue=""><option value="">Selecciona el tipo</option>{TIPOS_PERSONA.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</Select></Campo><Campo label="Documento (opcional)"><Input name="documento" maxLength={80} /></Campo><Campo label="Observación (opcional)"><Textarea name="observacion" maxLength={2000} /></Campo><div><Button type="submit">Agregar persona</Button></div></fieldset>
    </form></details>}
  </Card>;
}

const ACCIONES: Record<string, string> = { CREACION: "Reporte del incidente", SEGUIMIENTO: "Seguimiento", CAMBIO_ESTADO: "Cambio de estado", CAMBIO_PRIORIDAD: "Cambio de prioridad", CLASIFICACION: "Clasificación", ASIGNACION: "Asignación de responsable", PERSONA_AGREGADA: "Persona agregada", RESOLUCION: "Resolución declarada", CIERRE: "Cierre del caso", CAMBIO_RELEVANTE: "Corrección de datos" };
function Historial({ incidenteId }: { incidenteId: Id<"incidentes"> }) {
  const { results, status, loadMore } = usePaginatedQuery(api.incidentes.listarEventos, { incidenteId }, { initialNumItems: 30 });
  return <Card className="space-y-4 p-5 sm:p-6"><h2 className="text-base font-semibold">Historial del incidente</h2><p className="text-xs text-muted-foreground">Actuaciones registradas, de la más reciente a la más antigua.</p>
    {status === "LoadingFirstPage" ? <Skeleton className="h-32" /> : !results.length ? <p className="text-sm text-muted-foreground">No hay eventos disponibles.</p> : <ol className="ml-2 space-y-5 border-l border-border pl-5">{results.map((evento) => <li key={evento._id} className="relative text-sm"><span aria-hidden className="absolute -left-[25px] top-1.5 h-2 w-2 rounded-full bg-brand" /><time className="text-xs text-muted-foreground" dateTime={new Date(evento.createdAt).toISOString()}>{fecha(evento.createdAt)}</time><p className="mt-1 font-semibold">{ACCIONES[evento.tipo] ?? evento.tipo}</p><p className="text-xs text-muted-foreground">{evento.actorNombre}</p><p className="mt-2 whitespace-pre-wrap break-words">{evento.descripcion}</p>{evento.cambios?.map((c, i) => <p key={i} className="mt-1 break-words text-xs text-muted-foreground">{c.campo}: {c.antes ?? "Sin valor"} → {c.despues ?? "Sin valor"}</p>)}</li>)}</ol>}
    {(status === "CanLoadMore" || status === "LoadingMore") && <Button type="button" variant="outline" disabled={status === "LoadingMore"} onClick={() => loadMore(30)}>{status === "LoadingMore" ? "Cargando…" : "Ver eventos anteriores"}</Button>}
  </Card>;
}
function Dato({ label, valor }: { label: string; valor: React.ReactNode }) {
  return <div className="min-w-0"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 break-words text-sm font-medium">{valor}</dd></div>;
}
function Campo({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block min-w-0 space-y-1 text-xs font-medium"><span>{label}</span>{children}</label>;
}
