import type { Id } from "@vekino/backend/dataModel";
import { IncidenteVistaInicial } from "@/components/vigilancia/incidente-vista-inicial";

export default async function GuardiaIncidentePage({ params, searchParams }: {
  params: Promise<{ id: string; incidenteId: string }>;
  searchParams: Promise<{ registrado?: string }>;
}) {
  const [{ id, incidenteId }, { registrado }] = await Promise.all([params, searchParams]);
  return <IncidenteVistaInicial incidenteId={incidenteId as Id<"incidentes">} condominioId={id as Id<"condominios">} baseHref={`/guardia/${id}/incidentes`} registrado={registrado === "1"} />;
}
