"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { StopCircle } from "lucide-react";
import { api } from "@vekino/backend/api";
import type { Id } from "@vekino/backend/dataModel";
import { etiquetaInstante } from "@vekino/backend/inasistencias";
import { Button } from "@/components/ui/button";
import { CerrarTurnoModal } from "@/components/guardia/cerrar-turno-modal";
import { useRefrescoOperativo } from "@/hooks/use-contexto-operativo";

/**
 * El turno que el guarda dejó abierto en otro conjunto y que todavía debe
 * cerrar (QA-008).
 *
 * Hoy es, sobre todo, el que abrió en el conjunto que cubría cuando la
 * cobertura terminó o la inhabilitaron: su contexto vuelve a su conjunto de
 * siempre y la portería de la cobertura ya no le abre, así que desde aquí es
 * desde donde lo cierra. El servidor decide si puede
 * (`guardia.turnoPendienteDeCierre` y `cerrarTurno`); esto solo lo enseña.
 *
 * En la portería que cubre ya lo muestra `AvisoCobertura`: ahí no se monta.
 * Tampoco sale si el turno pendiente es de la portería en la que está.
 */
export function AvisoTurnoPendiente({
  condominioId,
  className = "mx-4 mt-4 lg:mx-6",
}: {
  condominioId?: Id<"condominios">;
  className?: string;
}) {
  const refresco = useRefrescoOperativo();
  const pendiente = useQuery(
    api.guardia.turnoPendienteDeCierre,
    refresco ? { refresco } : {},
  );
  const [cerrando, setCerrando] = useState(false);
  if (!pendiente || pendiente.turno.condominioId === condominioId) return null;

  return (
    <section
      aria-label="Turno pendiente de cierre"
      className={`${className} flex flex-wrap items-center justify-between gap-2 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-[13px]`}
    >
      <p className="text-foreground">
        Tienes un turno pendiente de cierre en {pendiente.condominioNombre}, abierto el{" "}
        <span className="tabular-nums">{etiquetaInstante(pendiente.turno.fechaInicio)}</span>.
      </p>
      <Button size="sm" variant="destructive" onClick={() => setCerrando(true)}>
        <StopCircle className="h-4 w-4" /> Cerrar ese turno
      </Button>
      {cerrando && (
        <CerrarTurnoModal
          turno={pendiente.turno}
          condominioNombre={pendiente.condominioNombre}
          onClose={() => setCerrando(false)}
        />
      )}
    </section>
  );
}
