"use client";

import { useQuery } from "convex/react";
import { api } from "@vekino/backend/api";
import { IncidentesInicio } from "@/components/vigilancia/incidentes-inicio";

export default function IncidentesCompaniaPage() {
  const equipo = useQuery(api.asignaciones.miEquipo);
  return <IncidentesInicio conjuntos={equipo} baseHref="/vigilancia/incidentes" />;
}
