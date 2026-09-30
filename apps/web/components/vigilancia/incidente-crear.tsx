"use client";

import { useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation } from "convex/react";
import { AlertCircle, ArrowLeft, Plus, Trash2 } from "lucide-react";
import { api } from "@vekino/backend/api";
import type { Id } from "@vekino/backend/dataModel";
import { PageContainer } from "@/components/layout/page-container";
import { PageHeader } from "@/components/layout/page-header";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  argumentosCrearIncidente, fechaHoraLocal, mensajeErrorIncidente, PRIORIDADES_INCIDENTE,
  registrarIncidenteUnaVez,
  TIPOS_INCIDENTE, TIPOS_PERSONA, validarIncidenteBorrador,
  type IncidenteBorrador, type PersonaBorrador,
} from "@/lib/incidentes-ui";

export type ConjuntoIncidente = { condominioId: Id<"condominios">; condominioNombre: string };
type PersonaLocal = PersonaBorrador & { key: number };

function ErrorCampo({ id, children }: { id: string; children?: string }) {
  return children ? <p id={id} className="mt-1 text-xs text-destructive" role="alert">{children}</p> : null;
}

export function IncidenteCrear({
  conjuntos, baseHref, inicial,
}: {
  conjuntos: ConjuntoIncidente[];
  baseHref: string;
  inicial?: string;
}) {
  const router = useRouter();
  const crear = useMutation(api.incidentes.crear);
  const [borrador, setBorrador] = useState<IncidenteBorrador>(() => ({
    condominioId: conjuntos.some((c) => c.condominioId === inicial)
      ? inicial! : conjuntos.length === 1 ? conjuntos[0]!.condominioId : "",
    tipo: "", prioridad: "", ocurrioEn: fechaHoraLocal(new Date()),
    ubicacion: "", descripcion: "", personas: [],
  }));
  const [personas, setPersonas] = useState<PersonaLocal[]>([]);
  const siguienteKey = useRef(0);
  const enviandoRef = useRef(false);
  const [enviando, setEnviando] = useState(false);
  const [errores, setErrores] = useState<Record<string, string>>({});
  const [errorServidor, setErrorServidor] = useState<string | null>(null);

  function actualizar(campo: keyof Omit<IncidenteBorrador, "personas">, valor: string) {
    setBorrador((anterior) => ({ ...anterior, [campo]: valor }));
    setErrores((anterior) => ({ ...anterior, [campo]: "" }));
    setErrorServidor(null);
  }

  function actualizarPersona(key: number, campo: keyof PersonaBorrador, valor: string) {
    setPersonas((anteriores) => anteriores.map((persona) => persona.key === key ? { ...persona, [campo]: valor } : persona));
    setErrores({});
    setErrorServidor(null);
  }

  async function registrar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (enviandoRef.current) return;
    const datos = { ...borrador, personas };
    const nuevosErrores = validarIncidenteBorrador(datos, conjuntos.map((c) => c.condominioId), Date.now());
    setErrores(nuevosErrores);
    setErrorServidor(null);
    if (Object.keys(nuevosErrores).length) {
      const primero = Object.keys(nuevosErrores)[0]!;
      document.getElementById(primero.replaceAll(".", "-"))?.focus();
      return;
    }

    try {
      const payload = argumentosCrearIncidente(datos);
      const operacion = registrarIncidenteUnaVez(enviandoRef, () => crear({
        ...payload, condominioId: payload.condominioId as Id<"condominios">,
      }));
      if (!operacion) return;
      setEnviando(true);
      const incidenteId = await operacion;
      router.push(`${baseHref}/${incidenteId}?registrado=1`);
    } catch (error) {
      enviandoRef.current = false;
      setEnviando(false);
      setErrorServidor(mensajeErrorIncidente(error));
    }
  }

  const sinConjuntos = conjuntos.length === 0;

  return (
    <PageContainer className="mx-auto w-full max-w-4xl pb-16">
      <Link href={baseHref} className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" aria-hidden /> Incidentes
      </Link>
      <PageHeader title="Nuevo incidente" description="Registra el hecho con la información disponible. Tu cuenta quedará como reportante; el reporte y el estado inicial se generan al guardar." />
      {sinConjuntos ? (
        <Card className="space-y-2 p-6">
          <h2 className="font-semibold">Sin conjuntos disponibles</h2>
          <p className="text-sm text-muted-foreground">No tienes un conjunto vigente donde registrar incidentes. Consulta con el administrador de tu compañía.</p>
        </Card>
      ) : (
        <form onSubmit={registrar} noValidate className="space-y-5">
          <fieldset disabled={enviando} className="space-y-5 disabled:opacity-80">
            <Card className="space-y-5 p-5 sm:p-6">
              <div>
                <h2 className="text-base font-semibold">Información del hecho</h2>
                <p className="text-xs text-muted-foreground">¿Qué pasó, dónde y cuándo ocurrió?</p>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label htmlFor="condominioId" className="text-sm font-medium">Conjunto <span aria-hidden="true">*</span></label>
                  <Select id="condominioId" value={borrador.condominioId} onChange={(e) => actualizar("condominioId", e.target.value)} aria-invalid={!!errores.condominioId} aria-describedby={errores.condominioId ? "condominioId-error" : undefined} required>
                    <option value="">Seleccionar conjunto</option>
                    {conjuntos.map((c) => <option key={c.condominioId} value={c.condominioId}>{c.condominioNombre}</option>)}
                  </Select>
                  <ErrorCampo id="condominioId-error">{errores.condominioId}</ErrorCampo>
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="tipo" className="text-sm font-medium">Tipo de incidente <span aria-hidden="true">*</span></label>
                  <Select id="tipo" value={borrador.tipo} onChange={(e) => actualizar("tipo", e.target.value)} aria-invalid={!!errores.tipo} aria-describedby={errores.tipo ? "tipo-error" : undefined} required>
                    <option value="">Seleccionar tipo</option>
                    {TIPOS_INCIDENTE.map((tipo) => <option key={tipo.value} value={tipo.value}>{tipo.label}</option>)}
                  </Select>
                  <ErrorCampo id="tipo-error">{errores.tipo}</ErrorCampo>
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label htmlFor="ocurrioEn" className="text-sm font-medium">Fecha y hora del hecho <span aria-hidden="true">*</span></label>
                  <Input id="ocurrioEn" type="datetime-local" value={borrador.ocurrioEn} onChange={(e) => actualizar("ocurrioEn", e.target.value)} aria-invalid={!!errores.ocurrioEn} aria-describedby={errores.ocurrioEn ? "ocurrioEn-error" : "ocurrioEn-ayuda"} required />
                  <p id="ocurrioEn-ayuda" className="text-xs text-muted-foreground">Indica cuándo ocurrió. La hora del reporte la registra el sistema.</p>
                  <ErrorCampo id="ocurrioEn-error">{errores.ocurrioEn}</ErrorCampo>
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="ubicacion" className="text-sm font-medium">Ubicación dentro del conjunto <span aria-hidden="true">*</span></label>
                  <Input id="ubicacion" value={borrador.ubicacion} onChange={(e) => actualizar("ubicacion", e.target.value)} maxLength={200} placeholder="Ej. Torre 3, parqueadero de visitantes" aria-invalid={!!errores.ubicacion} aria-describedby={errores.ubicacion ? "ubicacion-error" : undefined} required />
                  <ErrorCampo id="ubicacion-error">{errores.ubicacion}</ErrorCampo>
                </div>
              </div>
              <div className="space-y-2">
                <span id="prioridad-label" className="text-sm font-medium">Prioridad <span aria-hidden="true">*</span></span>
                <div role="radiogroup" aria-labelledby="prioridad-label" aria-invalid={!!errores.prioridad} aria-describedby={errores.prioridad ? "prioridad-error" : undefined} className="grid gap-2 sm:grid-cols-2">
                  {PRIORIDADES_INCIDENTE.map((prioridad) => (
                    <label key={prioridad.value} className={cn("flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors focus-within:ring-2 focus-within:ring-ring/40", borrador.prioridad === prioridad.value ? "border-brand bg-brand/5" : "border-border hover:bg-accent/40")}>
                      <input id={prioridad.value === "BAJA" ? "prioridad" : undefined} type="radio" name="prioridad" value={prioridad.value} checked={borrador.prioridad === prioridad.value} onChange={() => actualizar("prioridad", prioridad.value)} className="mt-1 accent-[hsl(var(--brand))]" />
                      <span className="flex flex-col"><span className="text-sm font-semibold">{prioridad.label}</span><span className="text-xs text-muted-foreground">{prioridad.hint}</span></span>
                    </label>
                  ))}
                </div>
                <ErrorCampo id="prioridad-error">{errores.prioridad}</ErrorCampo>
              </div>
              <div className="space-y-1.5">
                <div className="flex items-baseline justify-between gap-2">
                  <label htmlFor="descripcion" className="text-sm font-medium">Descripción <span aria-hidden="true">*</span></label>
                  <span className="text-xs text-muted-foreground">{borrador.descripcion.length}/5000</span>
                </div>
                <Textarea id="descripcion" rows={6} value={borrador.descripcion} onChange={(e) => actualizar("descripcion", e.target.value)} maxLength={5000} placeholder="Describe qué ocurrió, cómo se detectó y la información disponible al momento." aria-invalid={!!errores.descripcion} aria-describedby={errores.descripcion ? "descripcion-error" : "descripcion-ayuda"} required />
                <p id="descripcion-ayuda" className="text-xs text-muted-foreground">Escribe hechos concretos. Podrás añadir seguimiento después.</p>
                <ErrorCampo id="descripcion-error">{errores.descripcion}</ErrorCampo>
              </div>
            </Card>

            <Card className="space-y-4 p-5 sm:p-6">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold">Personas involucradas</h2>
                  <p className="text-xs text-muted-foreground">Opcional. Puedes registrarlas sin vincularlas a una cuenta de Vekino.</p>
                </div>
                <Button type="button" variant="outline" size="sm" onClick={() => setPersonas((actuales) => [...actuales, { key: siguienteKey.current++, nombre: "", tipoPersona: "", documento: "", observacion: "" }])}>
                  <Plus className="h-4 w-4" aria-hidden /> Agregar persona
                </Button>
              </div>
              {personas.map((persona, i) => (
                <div key={persona.key} className="space-y-4 rounded-xl border border-border bg-muted/20 p-4">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold">Persona {i + 1}</h3>
                    <Button type="button" variant="ghost" size="sm" onClick={() => { setPersonas((actuales) => actuales.filter((x) => x.key !== persona.key)); setErrores({}); }} aria-label={`Quitar persona ${i + 1}`}><Trash2 className="h-4 w-4" aria-hidden /> Quitar</Button>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <label htmlFor={`personas-${i}-nombre`} className="text-sm font-medium">Nombre *</label>
                      <Input id={`personas-${i}-nombre`} value={persona.nombre} onChange={(e) => actualizarPersona(persona.key, "nombre", e.target.value)} maxLength={160} aria-invalid={!!errores[`personas.${i}.nombre`]} aria-describedby={errores[`personas.${i}.nombre`] ? `personas-${i}-nombre-error` : undefined} required />
                      <ErrorCampo id={`personas-${i}-nombre-error`}>{errores[`personas.${i}.nombre`]}</ErrorCampo>
                    </div>
                    <div className="space-y-1.5">
                      <label htmlFor={`personas-${i}-tipoPersona`} className="text-sm font-medium">Tipo de persona *</label>
                      <Select id={`personas-${i}-tipoPersona`} value={persona.tipoPersona} onChange={(e) => actualizarPersona(persona.key, "tipoPersona", e.target.value)} aria-invalid={!!errores[`personas.${i}.tipoPersona`]} aria-describedby={errores[`personas.${i}.tipoPersona`] ? `personas-${i}-tipoPersona-error` : undefined} required>
                        <option value="">Seleccionar tipo</option>
                        {TIPOS_PERSONA.map((tipo) => <option key={tipo.value} value={tipo.value}>{tipo.label}</option>)}
                      </Select>
                      <ErrorCampo id={`personas-${i}-tipoPersona-error`}>{errores[`personas.${i}.tipoPersona`]}</ErrorCampo>
                    </div>
                    <div className="space-y-1.5">
                      <label htmlFor={`personas-${i}-documento`} className="text-sm font-medium">Documento (opcional)</label>
                      <Input id={`personas-${i}-documento`} value={persona.documento} onChange={(e) => actualizarPersona(persona.key, "documento", e.target.value)} maxLength={80} aria-invalid={!!errores[`personas.${i}.documento`]} aria-describedby={errores[`personas.${i}.documento`] ? `personas-${i}-documento-error` : undefined} />
                      <ErrorCampo id={`personas-${i}-documento-error`}>{errores[`personas.${i}.documento`]}</ErrorCampo>
                    </div>
                    <div className="space-y-1.5">
                      <label htmlFor={`personas-${i}-observacion`} className="text-sm font-medium">Observación (opcional)</label>
                      <Textarea id={`personas-${i}-observacion`} rows={2} value={persona.observacion} onChange={(e) => actualizarPersona(persona.key, "observacion", e.target.value)} maxLength={2000} aria-invalid={!!errores[`personas.${i}.observacion`]} aria-describedby={errores[`personas.${i}.observacion`] ? `personas-${i}-observacion-error` : undefined} />
                      <ErrorCampo id={`personas-${i}-observacion-error`}>{errores[`personas.${i}.observacion`]}</ErrorCampo>
                    </div>
                  </div>
                </div>
              ))}
            </Card>
          </fieldset>

          {errorServidor && (
            <div role="alert" className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-foreground">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
              <p>{errorServidor}</p>
            </div>
          )}
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-end">
            <Button type="button" variant="outline" disabled={enviando} onClick={() => router.push(baseHref)}>Cancelar</Button>
            <Button type="submit" disabled={enviando} aria-busy={enviando} className="min-w-44">
              {enviando ? "Registrando incidente…" : "Registrar incidente"}
            </Button>
          </div>
        </form>
      )}
    </PageContainer>
  );
}
