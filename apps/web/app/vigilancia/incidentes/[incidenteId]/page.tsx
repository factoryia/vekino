import type { Id } from "@vekino/backend/dataModel";
import { IncidenteVistaInicial } from "@/components/vigilancia/incidente-vista-inicial";

export default async function IncidenteCompaniaPage({ params, searchParams }: {
  params: Promise<{ incidenteId: string }>;
  searchParams: Promise<{ registrado?: string }>;
}) {
  const [{ incidenteId }, { registrado }] = await Promise.all([params, searchParams]);
  return <IncidenteVistaInicial incidenteId={incidenteId as Id<"incidentes">} baseHref="/vigilancia/incidentes" registrado={registrado === "1"} />;
}
