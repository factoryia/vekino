"use client";

import { useQuery } from "convex/react";
import { api } from "@vekino/backend/api";
import { PageContainer } from "@/components/layout/page-container";
import { Skeleton } from "@/components/ui/skeleton";
import { IncidenteCrear } from "./incidente-crear";

export function IncidenteNuevoCompania({ inicial }: { inicial?: string }) {
  const equipo = useQuery(api.asignaciones.miEquipo);
  if (equipo === undefined) return <PageContainer className="mx-auto w-full max-w-4xl"><Skeleton className="h-96 rounded-2xl" /></PageContainer>;
  return <IncidenteCrear conjuntos={equipo} baseHref="/vigilancia/incidentes" inicial={inicial} />;
}
