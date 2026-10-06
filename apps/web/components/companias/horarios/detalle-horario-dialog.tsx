"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@vekino/backend/api";
import type { Id } from "@vekino/backend/dataModel";
import { etiquetaVigencia } from "@vekino/backend/horariosGuarda";
import { etiquetaInstante, hoyColombia, sumarDias } from "@vekino/backend/inasistencias";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ErrorBoundary, ErrorMessage } from "@/components/ui/error-boundary";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { Skeleton } from "@/components/ui/skeleton";
import { ResumenSemanal } from "./resumen-semanal";
import { mensajeErrorUsuario } from "@/lib/utils";

/**
 * Ficha de un horario, el historial de su guarda y la finalización.
 *
 * Finalizar no borra ni cambia lo planificado: dice hasta qué día rige y deja
 * el rastro de quién lo hizo. Para cambiar la planificación se finaliza el
 * horario y se registra otro.
 */

const ETIQUETA_ESTADO = {
  programado: { texto: "Programado", tono: "neutral" },
  vigente: { texto: "Vigente", tono: "success" },
  terminado: { texto: "Terminado", tono: "neutral" },
} as const;

export function EstadoHorario({ estado }: { estado: keyof typeof ETIQUETA_ESTADO }) {
  const e = ETIQUETA_ESTADO[estado];
  return <Badge tone={e.tono}>{e.texto}</Badge>;
}

/** La vigencia de una fila tal como llega de `horariosGuarda.*`. */
export function vigenciaDe(h: {
  fechaInicio: string;
  fechaFin: string | null;
  terminaEl: string | null;
}): string {
  return etiquetaVigencia(h);
}

export function DetalleHorarioDialog({
  horarioId,
  onClose,
}: {
  horarioId: Id<"horariosGuarda">;
  onClose: () => void;
}) {
  return (
    <Modal
      open
      onClose={onClose}
      title="Horario"
      description="Planificación informativa e historial del guarda"
      className="max-w-2xl"
    >
      <ErrorBoundary
        resetKey={horarioId}
        fallback={(e) => <ErrorMessage title="No se puede ver este horario" detail={mensajeErrorUsuario(e)} />}
      >
        <Contenido horarioId={horarioId} />
      </ErrorBoundary>
    </Modal>
  );
}

function Contenido({ horarioId }: { horarioId: Id<"horariosGuarda"> }) {
  const h = useQuery(api.horariosGuarda.detalle, { horarioId });
  const historial = useQuery(
    api.horariosGuarda.historialDeGuarda,
    h ? { companiaId: h.companiaId, userId: h.userId } : "skip",
  );
  const finalizar = useMutation(api.horariosGuarda.finalizar);
  const hoy = hoyColombia();
  const [ultimoDia, setUltimoDia] = useState(hoy);
  const [confirmando, setConfirmando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (h === undefined) return <Skeleton className="h-48 w-full" />;
  if (h === null) return <p className="text-sm text-muted-foreground">Ese horario no existe.</p>;

  const otros = (historial ?? []).filter((x) => x._id !== h._id);
  const puedeFinalizar = h.terminaEl == null && h.estado !== "terminado";

  return (
    <div className="space-y-5">
      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <Dato label="Guarda">{h.guardaNombre}</Dato>
        <Dato label="Estado">
          <EstadoHorario estado={h.estado} />
        </Dato>
        <Dato label="Conjunto">{h.condominioNombre ?? "General (sin conjunto)"}</Dato>
        <Dato label="Vigencia">
          <span className="tabular-nums">{vigenciaDe(h)}</span>
        </Dato>
        <Dato label="Registrado">
          {h.creadoPorNombre} · {etiquetaInstante(h.createdAt)}
        </Dato>
        {h.terminadoEn != null && (
          <Dato label="Finalizado">
            {h.terminadoPorNombre ?? "—"} · {etiquetaInstante(h.terminadoEn)}
          </Dato>
        )}
      </dl>

      <div className="space-y-1.5">
        <p className="text-[13px] font-medium text-foreground">Semana planificada</p>
        <ResumenSemanal bloques={h.bloques} />
        <p className="text-xs text-muted-foreground">
          Hora de Colombia. Un bloque que termina al día siguiente se marca (+1).
        </p>
      </div>

      {puedeFinalizar && (
        <div className="space-y-2 rounded-lg border border-border p-3">
          {confirmando ? (
            <>
              <label className="block space-y-1.5">
                <span className="text-[13px] font-medium text-foreground">Último día en que rige</span>
                <Input
                  type="date"
                  value={ultimoDia}
                  min={sumarDias(hoy, -1)}
                  max={h.ultimoDia ?? undefined}
                  onChange={(e) => setUltimoDia(e.target.value)}
                />
                <span className="block text-xs text-muted-foreground">
                  Desde ayer en adelante: lo planificado para días pasados no se reescribe.
                </span>
              </label>
              <div className="flex justify-end gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => setConfirmando(false)}
                >
                  Cancelar
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={busy || !ultimoDia}
                  onClick={async () => {
                    setError(null);
                    setBusy(true);
                    try {
                      await finalizar({ horarioId: h._id, ultimoDia });
                      setConfirmando(false);
                    } catch (e) {
                      setError(mensajeErrorUsuario(e, "No se pudo finalizar."));
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {busy ? "Finalizando…" : "Finalizar horario"}
                </Button>
              </div>
            </>
          ) : (
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                Para cambiar la planificación, finaliza este horario y registra otro.
              </p>
              <Button size="sm" variant="secondary" onClick={() => setConfirmando(true)}>
                Finalizar
              </Button>
            </div>
          )}
          {error && <p className="text-[13px] text-destructive">{error}</p>}
        </div>
      )}

      <div className="space-y-2">
        <p className="text-[13px] font-medium text-foreground">Historial de {h.guardaNombre}</p>
        {historial === undefined ? (
          <Skeleton className="h-16 w-full" />
        ) : otros.length === 0 ? (
          <p className="text-sm text-muted-foreground">No tiene otros horarios registrados.</p>
        ) : (
          <ul className="divide-y divide-border/60 rounded-lg border border-border text-sm">
            {otros.map((x) => (
              <li key={x._id} className="space-y-0.5 px-3 py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {x.condominioNombre ?? "General"} ·{" "}
                    <span className="tabular-nums">{vigenciaDe(x)}</span>
                  </span>
                  <EstadoHorario estado={x.estado} />
                </div>
                <ResumenSemanal bloques={x.bloques} compacto className="text-xs text-muted-foreground" />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Dato({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-foreground">{children}</dd>
    </div>
  );
}
