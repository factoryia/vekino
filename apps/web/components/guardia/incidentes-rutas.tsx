"use client";

import { useQuery } from "convex/react";
import { api } from "@vekino/backend/api";
import type { Id } from "@vekino/backend/dataModel";
import { PageContainer } from "@/components/layout/page-container";
import { Skeleton } from "@/components/ui/skeleton";
import { IncidentesInicio } from "@/components/vigilancia/incidentes-inicio";
import { IncidenteCrear } from "@/components/vigilancia/incidente-crear";
import { sesionOperativa } from "@/lib/role-routing";
import { useMeOperativo } from "@/hooks/use-contexto-operativo";

/* Donde el guarda reporta por su compañía, con lo que opera HOY: su
 * asignación de guarda aquí o, si cubre este conjunto, la cobertura. El
 * servidor lo vuelve a exigir al crear (`exigirAccesoIncidente`). */
function useConjuntoCorporativo(condominioId: Id<"condominios">) {
  const me = useMeOperativo();
  const compania = useQuery(api.companias.miCompania);
  if (me === undefined || compania === undefined) return undefined;
  if (!me) return [];
  const cobertura = me.contextoOperativoGuardia.cobertura;
  if (cobertura?.condominioId === condominioId && cobertura.companiaId === compania?.companiaId) {
    return [{ condominioId: cobertura.condominioId, condominioNombre: cobertura.condominioNombre }];
  }
  return sesionOperativa(me).asignaciones
    .filter((a) => a.condominioId === condominioId && a.companiaId === compania?.companiaId && a.rol === "guardia")
    .map((a) => ({ condominioId: a.condominioId, condominioNombre: a.condominioNombre }));
}

export function GuardiaIncidentesInicio({ condominioId }: { condominioId: Id<"condominios"> }) {
  return <IncidentesInicio condominioId={condominioId} baseHref={`/guardia/${condominioId}/incidentes`} />;
}

export function GuardiaIncidenteNuevo({ condominioId }: { condominioId: Id<"condominios"> }) {
  const conjuntos = useConjuntoCorporativo(condominioId);
  if (conjuntos === undefined) return <PageContainer className="mx-auto w-full max-w-4xl"><Skeleton className="h-96 rounded-2xl" /></PageContainer>;
  return <IncidenteCrear conjuntos={conjuntos} baseHref={`/guardia/${condominioId}/incidentes`} />;
}
