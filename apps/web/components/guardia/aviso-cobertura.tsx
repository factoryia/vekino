"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { ArrowLeftRight, StopCircle } from "lucide-react";
import { api } from "@vekino/backend/api";
import type { Id } from "@vekino/backend/dataModel";
import { etiquetaInstante } from "@vekino/backend/inasistencias";
import { Button } from "@/components/ui/button";
import { CerrarTurnoModal } from "@/components/guardia/cerrar-turno-modal";
import { useRefrescoOperativo } from "@/hooks/use-contexto-operativo";

type Cobertura = {
  condominioId: string;
  condominioNombre: string;
  companiaNombre: string;
  fin: number;
};

/**
 * En la portería que el guarda cubre: hasta cuándo, y el turno que dejó
 * abierto en su conjunto de siempre, si lo hay, con el botón para cerrarlo.
 *
 * Ese turno solo se puede cerrar desde aquí: mientras dura la cobertura, la
 * portería de su conjunto ya no le abre. El servidor decide si puede
 * (`guardia.turnoPendienteDeCierre` y `cerrarTurno`); esto solo lo enseña.
 */
export function AvisoCobertura({
  condominioId,
  cobertura,
}: {
  condominioId: Id<"condominios">;
  cobertura: Cobertura | null;
}) {
  const aqui = cobertura?.condominioId === condominioId ? cobertura : null;
  const refresco = useRefrescoOperativo();
  const pendiente = useQuery(
    api.guardia.turnoPendienteDeCierre,
    aqui ? (refresco ? { refresco } : {}) : "skip",
  );
  const [cerrando, setCerrando] = useState(false);
  if (!aqui) return null;

  return (
    <section
      aria-label="Cobertura temporal"
      className="mx-4 mt-4 space-y-2 rounded-xl border border-brand/30 bg-brand/5 p-3 text-[13px] lg:mx-6"
    >
      <p className="flex items-start gap-2 text-foreground">
        <ArrowLeftRight className="mt-0.5 h-4 w-4 shrink-0 text-brand" aria-hidden />
        <span>
          Cubres este conjunto por {aqui.companiaNombre} hasta el{" "}
          <span className="tabular-nums">{etiquetaInstante(aqui.fin)}</span> (hora de
          Colombia). Mientras tanto solo operas como guarda aquí.
        </span>
      </p>
      {pendiente && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-card px-3 py-2">
          <p className="text-foreground">
            Quedó abierto tu turno en {pendiente.condominioNombre} desde el{" "}
            <span className="tabular-nums">{etiquetaInstante(pendiente.turno.fechaInicio)}</span>.
          </p>
          <Button size="sm" variant="destructive" onClick={() => setCerrando(true)}>
            <StopCircle className="h-4 w-4" /> Cerrar ese turno
          </Button>
        </div>
      )}
      {cerrando && pendiente && (
        <CerrarTurnoModal
          turno={pendiente.turno}
          condominioNombre={pendiente.condominioNombre}
          onClose={() => setCerrando(false)}
        />
      )}
    </section>
  );
}
