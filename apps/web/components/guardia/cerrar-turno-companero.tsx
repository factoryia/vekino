"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { AlertTriangle, Loader2, StopCircle } from "lucide-react";
import { api } from "@vekino/backend/api";
import type { Doc, Id } from "@vekino/backend/dataModel";
import { etiquetaInstante } from "@vekino/backend/inasistencias";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { mensajeErrorUsuario } from "@/lib/utils";

/*
 * El turno que otro guarda dejó abierto en la portería. Mientras siga abierto
 * no se puede iniciar otro (solo hay uno a la vez), así que el aviso explica
 * el bloqueo y dice de quién es el turno, y el cierre se confirma aparte,
 * diciendo que no es suyo. Quién puede cerrarlo lo decide el servidor
 * (`guardia.cerrarTurnoDeCompanero`); esto solo lo enseña.
 */

type Turno = Doc<"guardiaTurnos"> & { rondasCount: number };

function deQuien(turno: Turno): string {
  return turno.guardiaNombre + (turno.guardiaSecundarioNombre ? ` y ${turno.guardiaSecundarioNombre}` : "");
}

export function AvisoTurnoDeCompanero({ turno, onCerrar }: { turno: Turno; onCerrar: () => void }) {
  return (
    <section
      aria-label="Turno abierto por otro guarda"
      className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-[13px]"
    >
      <p className="max-w-xl text-foreground">
        Este turno es de <span className="font-semibold">{deQuien(turno)}</span> y sigue abierto: para
        iniciar el tuyo, primero debe cerrarse. Si ya terminó su jornada y no lo cerró, puedes cerrarlo tú.
      </p>
      <Button size="sm" variant="destructive" onClick={onCerrar}>
        <StopCircle className="h-4 w-4" /> Cerrar turno de {turno.guardiaNombre}
      </Button>
    </section>
  );
}

export function CerrarTurnoCompaneroModal({
  turno, condominioId, onClose, onCerrado,
}: {
  turno: Turno;
  /** El conjunto seleccionado. El servidor comprueba que el turno sea de él. */
  condominioId: Id<"condominios">;
  onClose: () => void;
  /** Solo cuando el servidor confirmó el cierre. */
  onCerrado: () => void;
}) {
  const cerrar = useMutation(api.guardia.cerrarTurnoDeCompanero);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirmar() {
    setBusy(true); setError(null);
    try {
      await cerrar({ turnoId: turno._id, condominioId });
      onCerrado();
    } catch (e) {
      setError(mensajeErrorUsuario(e, "No se pudo cerrar el turno."));
      setBusy(false);
    }
  }

  return (
    <Modal
      open onClose={onClose}
      title="Cerrar el turno de otro guarda"
      description={`Vas a cerrar el turno de ${deQuien(turno)}, no uno tuyo.`}
      className="max-w-lg"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>Cancelar</Button>
          <Button variant="destructive" size="sm" onClick={confirmar} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <StopCircle className="h-4 w-4" />}
            Sí, cerrar su turno
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <dl className="grid grid-cols-2 gap-3 rounded-xl bg-muted/40 p-3 text-sm">
          <div>
            <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">Guarda del turno</dt>
            <dd className="font-medium text-foreground">{deQuien(turno)}</dd>
          </div>
          <div>
            <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">Abierto desde</dt>
            <dd className="tabular-nums text-foreground">{etiquetaInstante(turno.fechaInicio)}</dd>
          </div>
          <div>
            <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">Checklist</dt>
            <dd className="text-foreground">{turno.checklist.length} ítems</dd>
          </div>
          <div>
            <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">Rondas</dt>
            <dd className="tabular-nums text-foreground">{turno.rondasCount}</dd>
          </div>
        </dl>
        <p className="flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-[13px] text-foreground">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <span>
            Hazlo solo si {turno.guardiaNombre} ya terminó su jornada y olvidó cerrarlo. En la minuta quedará
            que lo cerraste tú, como compañero, y no {turno.guardiaNombre}.
          </span>
        </p>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </div>
    </Modal>
  );
}
