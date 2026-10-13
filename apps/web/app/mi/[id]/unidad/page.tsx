"use client";

import { useParams } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@vekino/backend/api";
import type { Id } from "@vekino/backend/dataModel";
import { Building2, Car, Bike, MapPin } from "lucide-react";
import { PageContainer } from "@/components/layout/page-container";
import { PageHeader } from "@/components/layout/page-header";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { EmptyState } from "@/components/ui/empty-state";
import {
  TEXTO_SIN_UNIDAD,
  TITULO_SIN_UNIDAD,
  VINCULO_LABEL,
  TIPO_UNIDAD_LABEL,
} from "@/components/portal/portal-ui";
import { HogarUnidad } from "@/components/portal/hogar-unidad";
import { MisPaquetes } from "@/components/portal/mis-paquetes";

export default function MiUnidad() {
  const { id } = useParams<{ id: string }>();
  const condominioId = id as Id<"condominios">;

  const home = useQuery(api.portal.home, { condominioId });
  /* Los de SUS casas, con vínculo vigente: los filtra el backend
   * (`vehiculos.listMios`). Antes se pedían los de todo el conjunto y se
   * filtraban aquí por número de casa (QA de comprobantes, H3). */
  const vehiculos = useQuery(api.vehiculos.listMios, { condominioId });

  if (home === undefined) {
    return (
      <PageContainer>
        <div className="flex justify-center py-20">
          <Spinner className="h-5 w-5" />
        </div>
      </PageContainer>
    );
  }
  if (!home.allowed) return null;

  const misVehiculos = vehiculos ?? [];

  return (
    <PageContainer className="max-w-4xl space-y-8">
      <PageHeader
        title="Mi unidad"
        description="Los datos de tu casa, quién vive en ella y los vehículos registrados."
      />

      {home.unidades.length === 0 ? (
        <EmptyState icon={Building2} title={TITULO_SIN_UNIDAD} description={TEXTO_SIN_UNIDAD} />
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {home.unidades.map((u) => (
              <Card key={u._id} className="p-6">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand/10 text-brand">
                      <Building2 className="h-5 w-5" />
                    </div>
                    <div>
                      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        {TIPO_UNIDAD_LABEL[u.tipo] ?? "Unidad"}
                      </p>
                      <p className="text-2xl font-semibold tracking-tight text-foreground">
                        {u.numero}
                      </p>
                    </div>
                  </div>
                  {u.esPrincipal && <Badge tone="brand">Principal</Badge>}
                </div>

                <dl className="mt-5 space-y-2.5 text-sm">
                  <Row label="Tu vínculo" value={VINCULO_LABEL[u.vinculo] ?? u.vinculo} />
                  {(u.torre || u.bloque) && (
                    <Row
                      label="Ubicación"
                      value={[u.torre && `Torre ${u.torre}`, u.bloque && `Bloque ${u.bloque}`]
                        .filter(Boolean)
                        .join(" · ")}
                    />
                  )}
                  {u.coeficiente != null && (
                    <Row label="Coeficiente" value={`${u.coeficiente}%`} />
                  )}
                </dl>
              </Card>
            ))}
          </div>

          {/* Personas de cada casa: quién vive ahí y hasta cuándo. */}
          {home.unidades.map((u) => (
            <HogarUnidad key={u._id} unidadId={u._id as Id<"unidades">} />
          ))}

          {/* Paquetes: aquí aterriza el aviso de "tienes un paquete". */}
          <MisPaquetes condominioId={condominioId} />

          {/* Vehículos */}
          <div>
            <h2 className="mb-3 text-lg font-semibold tracking-tight text-foreground">
              Vehículos registrados
            </h2>
            {vehiculos === undefined ? (
              <Card className="p-6">
                <Spinner className="mx-auto h-5 w-5" />
              </Card>
            ) : misVehiculos.length === 0 ? (
              <Card className="flex items-center gap-3 p-6 text-sm text-muted-foreground">
                <MapPin className="h-4 w-4" />
                No hay vehículos registrados en tu unidad. La administración puede
                agregarlos.
              </Card>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {misVehiculos.map((v) => {
                  const Icon = v.tipo === "moto" ? Bike : v.tipo === "bicicleta" ? Bike : Car;
                  return (
                    <Card key={v._id} className="flex items-center gap-3 p-4">
                      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                        <Icon className="h-5 w-5" />
                      </div>
                      <div className="min-w-0">
                        <p className="font-semibold uppercase tracking-wide text-foreground">
                          {v.placa}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {[v.marca, v.color].filter(Boolean).join(" · ") || v.tipo}
                          {" · Unidad "}
                          {v.unidadNumero}
                        </p>
                      </div>
                    </Card>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </PageContainer>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border/60 pb-2.5 last:border-0 last:pb-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium text-foreground">{value}</dd>
    </div>
  );
}
