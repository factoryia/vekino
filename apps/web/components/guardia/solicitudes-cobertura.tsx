"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { ArrowLeftRight } from "lucide-react";
import { api } from "@vekino/backend/api";
import type { Id } from "@vekino/backend/dataModel";
import { etiquetaInstante } from "@vekino/backend/inasistencias";
import { Button } from "@/components/ui/button";

/**
 * Las solicitudes de cobertura que el guarda tiene que responder.
 *
 * La superficie mínima: dónde, cuándo y quién la pide, y aceptar o rechazar.
 * Nada de su disponibilidad ni de sus inasistencias. No sale si no hay nada
 * pendiente. Aceptar es un compromiso: todavía no le da acceso al conjunto.
 */
export function SolicitudesCobertura() {
  const pendientes = useQuery(api.coberturas.pendientesDeGuarda, {});
  if (!pendientes || pendientes.length === 0) return null;

  return (
    <section
      aria-label="Solicitudes de cobertura"
      className="mx-4 mt-4 space-y-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 lg:mx-6"
    >
      <p className="flex items-center gap-2 text-[13px] font-medium text-foreground">
        <ArrowLeftRight className="h-4 w-4" aria-hidden />
        {pendientes.length === 1
          ? "Tienes una solicitud de cobertura"
          : `Tienes ${pendientes.length} solicitudes de cobertura`}
      </p>
      <ul className="space-y-2">
        {pendientes.map((c) => (
          <Solicitud
            key={c._id}
            coberturaId={c._id}
            conjunto={c.condominioNombre}
            ventana={`${etiquetaInstante(c.inicio)} → ${etiquetaInstante(c.fin)}`}
            pidio={c.solicitadoPorNombre}
          />
        ))}
      </ul>
    </section>
  );
}

function Solicitud({
  coberturaId,
  conjunto,
  ventana,
  pidio,
}: {
  coberturaId: Id<"coberturas">;
  conjunto: string;
  ventana: string;
  pidio: string;
}) {
  const aceptar = useMutation(api.coberturas.aceptar);
  const rechazar = useMutation(api.coberturas.rechazar);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function responder(accion: typeof aceptar) {
    setError(null);
    setBusy(true);
    try {
      await accion({ coberturaId });
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo responder.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="rounded-lg bg-card px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-medium text-foreground">Cubrir {conjunto}</p>
          <p className="tabular-nums text-muted-foreground">{ventana} · hora de Colombia</p>
          <p className="text-xs text-muted-foreground">La pidió {pidio}</p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => responder(rechazar)}>
            Rechazar
          </Button>
          <Button size="sm" disabled={busy} onClick={() => responder(aceptar)}>
            Aceptar
          </Button>
        </div>
      </div>
      {error && <p className="mt-1 text-[13px] text-destructive">{error}</p>}
    </li>
  );
}
