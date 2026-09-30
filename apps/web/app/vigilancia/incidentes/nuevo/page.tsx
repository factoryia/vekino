import { IncidenteNuevoCompania } from "@/components/vigilancia/incidente-rutas";

export default async function NuevoIncidenteCompaniaPage({ searchParams }: {
  searchParams: Promise<{ condominioId?: string }>;
}) {
  const { condominioId } = await searchParams;
  return <IncidenteNuevoCompania inicial={condominioId} />;
}
