"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@vekino/backend/api";
import type { Id } from "@vekino/backend/dataModel";
import {
  ETIQUETA_TIPO_INASISTENCIA,
  etiquetaInstante,
} from "@vekino/backend/inasistencias";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ErrorBoundary, ErrorMessage } from "@/components/ui/error-boundary";
import { Modal } from "@/components/ui/modal";
import { Skeleton } from "@/components/ui/skeleton";
import { ventanaDe } from "./ventana";
import { mensajeErrorUsuario } from "@/lib/utils";

/**
 * Ficha de una inasistencia, el historial de su guarda y la anulación.
 *
 * Anular no borra: la inasistencia se queda en el historial con quién la
 * anuló y cuándo, y deja de contar como indisponibilidad. No hay edición: si
 * la ventana estaba mal, se anula y se registra otra.
 */
export function DetalleInasistenciaDialog({
  inasistenciaId,
  onClose,
}: {
  inasistenciaId: Id<"inasistencias">;
  onClose: () => void;
}) {
  return (
    <Modal
      open
      onClose={onClose}
      title="Inasistencia"
      description="Ficha e historial del guarda"
      className="max-w-2xl"
    >
      <ErrorBoundary
        resetKey={inasistenciaId}
        fallback={(e) => (
          <ErrorMessage title="No se puede ver esta inasistencia" detail={mensajeErrorUsuario(e)} />
        )}
      >
        <Contenido inasistenciaId={inasistenciaId} />
      </ErrorBoundary>
    </Modal>
  );
}

function Contenido({ inasistenciaId }: { inasistenciaId: Id<"inasistencias"> }) {
  const d = useQuery(api.inasistencias.detalle, { inasistenciaId });
  const historial = useQuery(
    api.inasistencias.historialDeGuarda,
    d ? { companiaId: d.companiaId, userId: d.userId } : "skip",
  );
  const anular = useMutation(api.inasistencias.anular);
  const [confirmando, setConfirmando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (d === undefined) return <Skeleton className="h-40 w-full" />;
  if (d === null) {
    return <p className="text-sm text-muted-foreground">Esa inasistencia no existe.</p>;
  }

  const otras = (historial ?? []).filter((i) => i._id !== d._id);

  return (
    <div className="space-y-5">
      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <Dato label="Guarda">{d.guardaNombre}</Dato>
        <Dato label="Estado">
          <Badge tone={d.estado === "activa" ? "warning" : "neutral"}>
            {d.estado === "activa" ? "Activa" : "Anulada"}
          </Badge>
        </Dato>
        <Dato label="Tipo">{ETIQUETA_TIPO_INASISTENCIA[d.tipo]}</Dato>
        <Dato label="Ventana">
          <span className="tabular-nums">{ventanaDe(d)}</span>
        </Dato>
        <Dato label="Motivo" ancho>
          {d.motivo ?? <span className="text-muted-foreground">Sin motivo</span>}
        </Dato>
        <Dato label="Registrada">
          {d.registradaPorNombre} · {etiquetaInstante(d.createdAt)}
        </Dato>
        {d.anuladaEn != null && (
          <Dato label="Anulada">
            {d.anuladaPorNombre ?? "—"} · {etiquetaInstante(d.anuladaEn)}
          </Dato>
        )}
      </dl>
      <p className="text-xs text-muted-foreground">Fechas y horas en hora de Colombia.</p>

      {d.estado === "activa" && (
        <div className="space-y-2 rounded-lg border border-border p-3">
          {confirmando ? (
            <>
              <p className="text-sm">
                La inasistencia se conserva en el historial y deja de contar como
                indisponibilidad. ¿Anularla?
              </p>
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
                  disabled={busy}
                  onClick={async () => {
                    setError(null);
                    setBusy(true);
                    try {
                      await anular({ inasistenciaId: d._id });
                      setConfirmando(false);
                    } catch (e) {
                      setError(mensajeErrorUsuario(e, "No se pudo anular."));
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {busy ? "Anulando…" : "Anular inasistencia"}
                </Button>
              </div>
            </>
          ) : (
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                Si se registró por error o la ventana cambió, anúlala y registra otra.
              </p>
              <Button size="sm" variant="secondary" onClick={() => setConfirmando(true)}>
                Anular
              </Button>
            </div>
          )}
          {error && <p className="text-[13px] text-destructive">{error}</p>}
        </div>
      )}

      <div className="space-y-2">
        <p className="text-[13px] font-medium text-foreground">
          Historial de {d.guardaNombre}
        </p>
        {historial === undefined ? (
          <Skeleton className="h-16 w-full" />
        ) : otras.length === 0 ? (
          <p className="text-sm text-muted-foreground">No tiene otras inasistencias.</p>
        ) : (
          <ul className="divide-y divide-border/60 rounded-lg border border-border text-sm">
            {otras.map((i) => (
              <li key={i._id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <span>
                  {ETIQUETA_TIPO_INASISTENCIA[i.tipo]} ·{" "}
                  <span className="tabular-nums">{ventanaDe(i)}</span>
                </span>
                <Badge tone={i.estado === "activa" ? "warning" : "neutral"}>
                  {i.estado === "activa" ? "Activa" : "Anulada"}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Dato({
  label,
  ancho,
  children,
}: {
  label: string;
  ancho?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={ancho ? "sm:col-span-2" : undefined}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-foreground">{children}</dd>
    </div>
  );
}
