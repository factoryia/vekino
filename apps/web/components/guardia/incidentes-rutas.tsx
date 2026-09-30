"use client";

import { useQuery } from "convex/react";
import { api } from "@vekino/backend/api";
import type { Id } from "@vekino/backend/dataModel";
import { PageContainer } from "@/components/layout/page-container";
import { Skeleton } from "@/components/ui/skeleton";
import { IncidentesInicio } from "@/components/vigilancia/incidentes-inicio";
import { IncidenteCrear } from "@/components/vigilancia/incidente-crear";

function useConjuntoCorporativo(condominioId: Id<"condominios">) {
  const asignaciones = useQuery(api.asignaciones.misAsignaciones);
  const compania = useQuery(api.companias.miCompania);
  if (asignaciones === undefined || compania === undefined) return undefined;
  return asignaciones
    .filter((a) => a.condominioId === condominioId && a.companiaId === compania?.companiaId && a.rol === "guardia")
    .map((a) => ({ condominioId: a.condominioId, condominioNombre: a.condominioNombre }));
}

export function GuardiaIncidentesInicio({ condominioId }: { condominioId: Id<"condominios"> }) {
  const conjuntos = useConjuntoCorporativo(condominioId);
  return <IncidentesInicio conjuntos={conjuntos} baseHref={`/guardia/${condominioId}/incidentes`} />;
}

export function GuardiaIncidenteNuevo({ condominioId }: { condominioId: Id<"condominios"> }) {
  const conjuntos = useConjuntoCorporativo(condominioId);
  if (conjuntos === undefined) return <PageContainer className="mx-auto w-full max-w-4xl"><Skeleton className="h-96 rounded-2xl" /></PageContainer>;
  return <IncidenteCrear conjuntos={conjuntos} baseHref={`/guardia/${condominioId}/incidentes`} />;
}
