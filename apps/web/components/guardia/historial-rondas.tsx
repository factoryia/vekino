"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { ChevronDown, Loader2 } from "lucide-react";
import { api } from "@vekino/backend/api";
import type { Id } from "@vekino/backend/dataModel";
import { cn } from "@/lib/utils";
import { CargarMasRondas, useRondasPaginadas } from "@/components/vigilancia/rondas-paginadas";
import { LineaDeTiempo } from "./linea-de-tiempo";

/**
 * Rondas anteriores, con su reporte consolidado al desplegarlas.
 *
 * Por páginas: las 20 más recientes y "Cargar más" hasta la primera. La ronda
 * desplegada sigue abierta al cargar más, porque se recuerda por su id.
 */
export function HistorialRondas({
  condominioId,
}: {
  condominioId: Id<"condominios">;
}) {
  const { results: rondas, status, loadMore } = useRondasPaginadas(condominioId);
  const [abierta, setAbierta] = useState<Id<"guardiaRondas"> | null>(null);

  if (status === "LoadingFirstPage") {
    return (
      <div className="flex justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (rondas.length === 0) {
    return (
      <p className="rounded-2xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
        Todavía no hay rondas registradas.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <h2 className="text-sm font-semibold text-foreground">Rondas anteriores</h2>
      {rondas.map((r) => (
        <div key={r._id} className="overflow-hidden rounded-xl border border-border bg-card">
          <button
            type="button"
            onClick={() => setAbierta(abierta === r._id ? null : r._id)}
            className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/50"
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <p className="text-[13px] font-medium text-foreground">
                  Ronda {r.numero ? `#${r.numero}` : ""} · {r.zona}
                </p>
                {r.estado === "en_curso" && (
                  <span className="rounded-full bg-brand/15 px-2 py-0.5 text-[11px] font-medium text-brand">
                    En curso
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {new Date(r.fechaInicio).toLocaleString("es-CO", {
                  day: "2-digit",
                  month: "short",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
                {r.duracion ? ` · ${r.duracion}` : ""}
                {r.guardiaNombre ? ` · ${r.guardiaNombre}` : ""}
              </p>
            </div>
            <div className="flex shrink-0 gap-2 text-[11px] text-muted-foreground">
              <span>{r.totales.novedades} nov.</span>
              <span>{r.totales.vehiculos} veh.</span>
              <span>{r.totales.eventos} ev.</span>
            </div>
            <ChevronDown
              className={cn(
                "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
                abierta === r._id && "rotate-180",
              )}
            />
          </button>
          {abierta === r._id && <Reporte rondaId={r._id} />}
        </div>
      ))}
      <CargarMasRondas status={status} loadMore={loadMore} cargadas={rondas.length} />
    </div>
  );
}

function Reporte({ rondaId }: { rondaId: Id<"guardiaRondas"> }) {
  const d = useQuery(api.rondas.detalle, { rondaId });
  if (d === undefined) {
    return (
      <div className="flex justify-center border-t border-border py-6">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!d) return null;
  return (
    <div className="space-y-3 border-t border-border bg-muted/30 px-4 py-4">
      {d.observacionesCierre && (
        <p className="rounded-lg bg-card px-3 py-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Cierre: </span>
          {d.observacionesCierre}
        </p>
      )}
      <LineaDeTiempo hitos={d.lineaDeTiempo} />
    </div>
  );
}
