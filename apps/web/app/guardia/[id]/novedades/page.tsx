"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { useQuery, useMutation } from "convex/react";
import {
  AlertTriangle, Plus, Loader2, Paperclip, FileText, Car, Home, Clock,
} from "lucide-react";
import { api } from "@vekino/backend/api";
import type { Id } from "@vekino/backend/dataModel";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Input, Select, Textarea } from "@/components/ui/input";
import { PageContainer } from "@/components/layout/page-container";
import { PageHeader } from "@/components/layout/page-header";
import { cn } from "@/lib/utils";
import { useUploadToS3 } from "@/hooks/use-upload-s3";
import { NovedadVehiculoModal } from "@/components/guardia/novedad-vehiculo";
import { NovedadModal } from "@/components/guardia/novedad-modal";
import { SelectorUnidades, type UnidadElegida } from "@/components/guardia/selector-unidades";

type Prioridad = "baja" | "media" | "alta";

const PRIORIDAD_META: Record<Prioridad, { label: string; cls: string; dot: string }> = {
  baja:  { label: "Baja",  cls: "bg-slate-500/10 text-slate-600",  dot: "bg-slate-400" },
  media: { label: "Media", cls: "bg-amber-500/10 text-amber-600",  dot: "bg-amber-500" },
  alta:  { label: "Alta",  cls: "bg-red-500/10 text-red-600",      dot: "bg-red-500" },
};

function fmtFechaHora(ts: number) {
  return new Date(ts).toLocaleString("es-CO", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/**
 * "Propietario: Carlos Pérez". Con varias casas se dice de cuál es cada uno;
 * sin propietario registrado (aportes viejos, casas sin dueño cargado) la
 * línea no sale.
 */
function textoPropietarios(ps: { unidadId: string; numero: string; nombre: string }[]) {
  const variasCasas = new Set(ps.map((p) => p.unidadId)).size > 1;
  const nombres = ps.map((p) => (variasCasas ? `${p.numero} ${p.nombre}` : p.nombre));
  return `${ps.length > 1 ? "Propietarios" : "Propietario"}: ${nombres.join(" · ")}`;
}

export default function GuardiaNovedadesPage() {
  const params = useParams<{ id: string }>();
  const condominioId = params.id as Id<"condominios">;
  const reportes = useQuery(api.guardia.listNovedadReportes, { condominioId });
  const [formOpen, setFormOpen] = useState(false);
  const [vehiculoOpen, setVehiculoOpen] = useState(false);

  return (
    <PageContainer>
      <div className="space-y-6">
        <PageHeader
          title="Novedades"
          description="Reporta incidentes de seguridad a la administración"
          action={
            <div className="flex flex-wrap gap-2">
              {/* Primero el de vehículo: es el que se usa en la ronda, con el
                  celular en la mano y de pie en el parqueadero. */}
              <Button size="sm" onClick={() => setVehiculoOpen(true)}>
                <Car className="h-4 w-4" /> Aporte voluntario
              </Button>
              <Button variant="outline" size="sm" onClick={() => setFormOpen(true)}>
                <Plus className="h-4 w-4" /> Otra novedad
              </Button>
            </div>
          }
        />

      {reportes === undefined ? (
        <div className="space-y-3">{[...Array(3)].map((_, i) => <Skeleton key={i} className="h-24 rounded-2xl" />)}</div>
      ) : reportes.length === 0 ? (
        <EmptyState
          icon={AlertTriangle}
          title="Sin novedades reportadas"
          description="Los incidentes que reportes quedan aquí y en la minuta digital."
          action={<Button size="sm" onClick={() => setFormOpen(true)}><Plus className="h-4 w-4" /> Reportar</Button>}
        />
      ) : (
        <div className="space-y-3">
          {reportes.map((n) => {
            const meta = PRIORIDAD_META[n.prioridad];
            return (
              <Card key={n._id} className="p-4">
                <div className="flex items-start gap-3">
                  <span className={cn("mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full", meta.dot)} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-semibold text-foreground">{n.titulo}</p>
                      <span className={cn("rounded-md px-2 py-0.5 text-[11px] font-semibold", meta.cls)}>
                        Prioridad {meta.label}
                      </span>
                    </div>
                    {(n.vehiculoPlaca || n.unidades.length > 0) && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        {n.vehiculoPlaca && (
                          <span className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-0.5 font-mono text-[12px] font-bold tracking-wider text-foreground">
                            <Car className="h-3 w-3" aria-hidden /> {n.vehiculoPlaca}
                          </span>
                        )}
                        {n.unidades.map((u) => (
                          <span key={u.unidadId} className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-[12px] text-foreground">
                            <Home className="h-3 w-3 text-muted-foreground" aria-hidden /> {u.numero}
                          </span>
                        ))}
                      </div>
                    )}
                    {n.propietarios.length > 0 && (
                      <p className="mt-1 text-[13px] text-muted-foreground">
                        {textoPropietarios(n.propietarios)}
                      </p>
                    )}
                    <p className="mt-1 whitespace-pre-line text-sm text-foreground">{n.descripcion}</p>
                    {n.fotos && n.fotos.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {n.fotos.map((fo) => (
                          <a key={fo.url} href={fo.url} target="_blank" rel="noreferrer" className="block h-16 w-16 overflow-hidden rounded-lg border border-border">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={fo.url} alt={fo.nombre ?? "Evidencia"} className="h-full w-full object-cover" />
                          </a>
                        ))}
                      </div>
                    )}
                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span>{n.reportadoPorNombre}</span>
                      <span>·</span>
                      <span>{fmtFechaHora(n.ocurrioEn)}</span>
                      {n.ocurrioEn !== n.createdAt && (
                        <span className="text-muted-foreground/70">
                          (registrada {fmtFechaHora(n.createdAt)})
                        </span>
                      )}
                      {n.archivoUrl && (
                        <a href={n.archivoUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-brand hover:underline">
                          <Paperclip className="h-3 w-3" /> {n.archivoNombre ?? "Adjunto"}
                        </a>
                      )}
                    </div>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {formOpen && <NovedadModal condominioId={condominioId} onClose={() => setFormOpen(false)} />}
      {vehiculoOpen && (
        <NovedadVehiculoModal condominioId={condominioId} onClose={() => setVehiculoOpen(false)} />
      )}
      </div>
    </PageContainer>
  );
}

