"use client";

import Link from "next/link";
import { useQuery } from "convex/react";
import { ArrowLeft, Plus, CheckCircle2 } from "lucide-react";
import { api } from "@vekino/backend/api";
import type { Id } from "@vekino/backend/dataModel";
import { PageContainer } from "@/components/layout/page-container";
import { PageHeader } from "@/components/layout/page-header";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { etiquetaTipoIncidente, PRIORIDADES_INCIDENTE, TIPOS_PERSONA } from "@/lib/incidentes-ui";

function fecha(ms: number) {
  return new Date(ms).toLocaleString("es-CO", { dateStyle: "medium", timeStyle: "short" });
}

export function IncidenteVistaInicial({ incidenteId, baseHref, registrado }: {
  incidenteId: Id<"incidentes">;
  baseHref: string;
  registrado: boolean;
}) {
  const incidente = useQuery(api.incidentes.obtener, { incidenteId });
  const personas = useQuery(api.incidentes.listarPersonas, { incidenteId });
  const prioridad = PRIORIDADES_INCIDENTE.find((x) => x.value === incidente?.prioridad);

  return (
    <PageContainer className="mx-auto w-full max-w-4xl pb-16">
      <Link href={baseHref} className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" aria-hidden /> Incidentes</Link>
      {incidente === undefined ? <Skeleton className="h-72 rounded-2xl" /> : (
        <>
          {registrado && <div role="status" className="flex items-start gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm text-foreground"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700 dark:text-emerald-400" aria-hidden /><span>El incidente fue registrado correctamente.</span></div>}
          <PageHeader title={etiquetaTipoIncidente(incidente.tipo)} description={`Referencia ${incidente._id}`} action={<Badge tone="info">{incidente.estado}</Badge>} />
          <Card className="space-y-5 p-5 sm:p-6">
            <dl className="grid gap-4 sm:grid-cols-2">
              <Dato label="Conjunto" valor={incidente.condominioNombre} />
              <Dato label="Prioridad" valor={<Badge tone={prioridad?.tone ?? "neutral"}>{prioridad?.label ?? incidente.prioridad}</Badge>} />
              <Dato label="Ocurrió" valor={fecha(incidente.ocurrioEn)} />
              <Dato label="Reportado" valor={fecha(incidente.reportadoEn)} />
              <Dato label="Ubicación" valor={incidente.ubicacion} />
              <Dato label="Reportado por" valor={incidente.reportadoPorNombre} />
            </dl>
            <div className="border-t border-border pt-4">
              <h2 className="text-sm font-semibold">Descripción</h2>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed">{incidente.descripcion}</p>
            </div>
          </Card>
          <Card className="space-y-3 p-5 sm:p-6">
            <h2 className="text-sm font-semibold">Personas involucradas</h2>
            {personas === undefined ? <Skeleton className="h-12" /> : personas.length === 0 ? <p className="text-sm text-muted-foreground">No se registraron personas al crear el incidente.</p> : (
              <ul className="divide-y divide-border">
                {personas.map((persona) => <li key={persona._id} className="py-3 text-sm"><p className="font-medium">{persona.nombre} <span className="font-normal text-muted-foreground">· {TIPOS_PERSONA.find((x) => x.value === persona.tipoPersona)?.label ?? persona.tipoPersona}</span></p>{persona.documento && <p className="text-xs text-muted-foreground">Documento: {persona.documento}</p>}{persona.observacion && <p className="mt-1 text-xs text-muted-foreground">{persona.observacion}</p>}</li>)}
              </ul>
            )}
          </Card>
          <div><Button variant="outline" asChild><Link href={`${baseHref}/nuevo`}><Plus className="h-4 w-4" aria-hidden /> Nuevo incidente</Link></Button></div>
        </>
      )}
    </PageContainer>
  );
}

function Dato({ label, valor }: { label: string; valor: React.ReactNode }) {
  return <div className="min-w-0"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 break-words text-sm font-medium">{valor}</dd></div>;
}
