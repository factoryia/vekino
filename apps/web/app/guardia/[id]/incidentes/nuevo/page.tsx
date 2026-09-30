import type { Id } from "@vekino/backend/dataModel";
import { GuardiaIncidenteNuevo } from "@/components/guardia/incidentes-rutas";

export default async function GuardiaNuevoIncidentePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <GuardiaIncidenteNuevo condominioId={id as Id<"condominios">} />;
}
