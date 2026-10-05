"use client";

import { Footprints } from "lucide-react";
import type { FunctionReturnType } from "convex/server";
import type { api } from "@vekino/backend/api";
import { EtiquetaCobertura } from "@/components/vigilancia/etiqueta-cobertura";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * EL HISTORIAL DE RONDAS DE UN CONJUNTO, EN TABLA.
 *
 * Una sola tabla para las dos vistas que lo miran: la compañía desde
 * `/vigilancia/:condominioId` y el conjunto desde su propia sección. Es
 * literalmente la misma pregunta —qué recorrió la portería de este conjunto—
 * y la responde la misma consulta (`rondas.listar`), así que tener dos tablas
 * solo garantizaba que una de las dos se quedara atrás.
 *
 * No decide nada: recibe lo que devolvió el servidor. Quién puede ver estas
 * rondas lo resuelve `rondas.listar` exigiendo `porteria.ver` sobre ESE
 * conjunto, no esta tabla.
 */
export type RondaListada = FunctionReturnType<typeof api.rondas.listar>[number];

const TONO_RONDA = {
  en_curso: "brand",
  finalizada: "success",
} as const;

function fechaHora(ms: number): string {
  return new Date(ms).toLocaleString("es-CO", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function TablaRondas({
  rondas,
  vacio,
}: {
  /** `undefined` mientras carga, igual que `useQuery`. */
  rondas: RondaListada[] | undefined;
  /** Qué decir cuando no hay ninguna. Cambia según quién mire y si filtra. */
  vacio?: string;
}) {
  if (rondas === undefined) {
    return <Skeleton className="h-64 rounded-2xl" />;
  }

  if (rondas.length === 0) {
    return (
      <EmptyState
        icon={Footprints}
        title="Sin rondas registradas"
        description={
          vacio ?? "Cuando la portería haga su primera ronda aparecerá aquí."
        }
      />
    );
  }

  return (
    <Card className="overflow-hidden p-0">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="px-5 py-3 font-medium">#</th>
              <th className="px-5 py-3 font-medium">Zona</th>
              <th className="px-5 py-3 font-medium">Guarda</th>
              <th className="px-5 py-3 font-medium">Inicio</th>
              <th className="px-5 py-3 font-medium">Duración</th>
              <th className="px-5 py-3 font-medium">Registros</th>
              <th className="px-5 py-3 font-medium">Estado</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {rondas.map((r) => (
              <tr key={r._id}>
                <td className="px-5 py-3 tabular-nums text-muted-foreground">
                  {r.numero ?? "—"}
                </td>
                <td className="px-5 py-3 text-foreground">{r.zona}</td>
                <td className="px-5 py-3 text-muted-foreground">
                  <span className="flex flex-wrap items-center gap-1.5">
                    {r.guardiaNombre ?? "—"}
                    <EtiquetaCobertura cobertura={r.cobertura} compacta />
                  </span>
                </td>
                <td className="px-5 py-3 text-muted-foreground">
                  {fechaHora(r.fechaInicio)}
                </td>
                <td className="px-5 py-3 text-muted-foreground">
                  {r.duracion}
                </td>
                <td className="px-5 py-3 text-muted-foreground">
                  {r.totales.eventos} evento
                  {r.totales.eventos === 1 ? "" : "s"}
                  {r.totales.vehiculos > 0 &&
                    ` · ${r.totales.vehiculos} vehículo${r.totales.vehiculos === 1 ? "" : "s"}`}
                  {r.totales.novedades > 0 && (
                    <span className="ml-1.5 text-destructive">
                      · {r.totales.novedades} novedad
                      {r.totales.novedades === 1 ? "" : "es"}
                    </span>
                  )}
                </td>
                <td className="px-5 py-3">
                  <Badge tone={TONO_RONDA[r.estado]}>{r.estado}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
