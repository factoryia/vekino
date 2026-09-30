import type { Id } from "@vekino/backend/dataModel";
import { GuardiaIncidentesInicio } from "@/components/guardia/incidentes-rutas";

export default async function GuardiaIncidentesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <GuardiaIncidentesInicio condominioId={id as Id<"condominios">} />;
}
