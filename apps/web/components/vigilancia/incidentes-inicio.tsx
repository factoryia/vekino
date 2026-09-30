"use client";

import Link from "next/link";
import { AlertTriangle, Plus } from "lucide-react";
import { PageContainer } from "@/components/layout/page-container";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import type { ConjuntoIncidente } from "./incidente-crear";

export function IncidentesInicio({ conjuntos, baseHref }: {
  conjuntos: ConjuntoIncidente[] | undefined;
  baseHref: string;
}) {
  return (
    <PageContainer className="mx-auto w-full max-w-5xl">
      <PageHeader title="Incidentes" description="Registra hechos que requieren gestión y trazabilidad dentro de la operación de vigilancia."
        action={conjuntos && conjuntos.length > 0 ? <Button asChild><Link href={`${baseHref}/nuevo`}><Plus className="h-4 w-4" aria-hidden /> Nuevo incidente</Link></Button> : undefined} />
      {conjuntos === undefined ? <Skeleton className="h-44 rounded-2xl" /> : conjuntos.length === 0 ? (
        <EmptyState icon={AlertTriangle} title="Sin conjuntos disponibles" description="Necesitas una relación vigente con un conjunto para registrar incidentes. Consulta al administrador de tu compañía." />
      ) : (
        <Card className="space-y-4 p-5 sm:p-6">
          <h2 className="text-base font-semibold">Registrar un hecho</h2>
          <p className="max-w-2xl text-sm text-muted-foreground">El reporte empieza en estado Reportado. Incluye cuándo ocurrió, la ubicación y una descripción clara; puedes añadir personas involucradas si ya cuentas con esos datos.</p>
          <p className="text-xs text-muted-foreground">{conjuntos.length} conjunto{conjuntos.length === 1 ? "" : "s"} disponible{conjuntos.length === 1 ? "" : "s"} para tu operación vigente.</p>
          <Button asChild><Link href={`${baseHref}/nuevo`}><Plus className="h-4 w-4" aria-hidden /> Nuevo incidente</Link></Button>
        </Card>
      )}
    </PageContainer>
  );
}
