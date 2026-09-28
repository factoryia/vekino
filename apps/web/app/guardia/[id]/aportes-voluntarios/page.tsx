"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { useQuery } from "convex/react";
import { HandCoins, Plus } from "lucide-react";
import { api } from "@vekino/backend/api";
import type { Id } from "@vekino/backend/dataModel";
import { PageContainer } from "@/components/layout/page-container";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { NovedadVehiculoModal } from "@/components/guardia/novedad-vehiculo";
import { ReporteCard } from "@/components/guardia/reporte-card";

export default function GuardiaAportesVoluntariosPage() {
  const params = useParams<{ id: string }>();
  const condominioId = params.id as Id<"condominios">;
  const reportes = useQuery(api.guardia.listAportesVoluntarios, { condominioId });
  const [formOpen, setFormOpen] = useState(false);

  return (
    <PageContainer>
      <div className="space-y-6">
        <PageHeader
          title="Aportes Voluntarios"
          description="Registra y consulta reportes de vehículos relacionados con el aporte de parqueadero"
          action={
            <Button size="sm" onClick={() => setFormOpen(true)}>
              <Plus className="h-4 w-4" /> Registrar aporte voluntario
            </Button>
          }
        />

        {reportes === undefined ? (
          <div className="space-y-3">{[...Array(3)].map((_, i) => <Skeleton key={i} className="h-24 rounded-2xl" />)}</div>
        ) : reportes.length === 0 ? (
          <EmptyState
            icon={HandCoins}
            title="Sin aportes voluntarios reportados"
            description="Los reportes que registres aparecerán aquí y en la minuta digital."
            action={<Button size="sm" onClick={() => setFormOpen(true)}><Plus className="h-4 w-4" /> Reportar</Button>}
          />
        ) : (
          <div className="space-y-3">
            {reportes.map((n) => <ReporteCard key={n._id} n={n} />)}
          </div>
        )}

        {formOpen && <NovedadVehiculoModal condominioId={condominioId} onClose={() => setFormOpen(false)} />}
      </div>
    </PageContainer>
  );
}
