"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { ArrowLeftRight } from "lucide-react";
import { api } from "@vekino/backend/api";
import type { Id } from "@vekino/backend/dataModel";
import {
  ESTADOS_COBERTURA,
  ETIQUETA_ESTADO_COBERTURA,
  MAX_MOTIVO_INHABILITACION,
  type EstadoCobertura,
} from "@vekino/backend/coberturas";
import { etiquetaInstante, hoyColombia, sumarDias } from "@vekino/backend/inasistencias";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { Skeleton } from "@/components/ui/skeleton";
import { CellStack, Table, TableCard, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import type { ContratoDestino } from "../disponibilidad/panel-disponibilidad";

/**
 * Las coberturas de la compañía: ver su estado y su rastro, cancelar e
 * inhabilitar. Se solicitan desde Disponibilidad, a un guarda disponible.
 *
 * "Activa" no aparece como estado: se deriva de la ventana. Y una aceptada
 * todavía no da acceso al conjunto: es un compromiso confirmado.
 */

const DIA = 24 * 60 * 60 * 1000;

const TONO: Record<EstadoCobertura, "warning" | "success" | "neutral" | "destructive"> = {
  solicitada: "warning",
  aceptada: "success",
  rechazada: "neutral",
  cancelada: "neutral",
  inhabilitada: "destructive",
};

export function BadgeCobertura({ estado }: { estado: EstadoCobertura }) {
  return <Badge tone={TONO[estado]}>{ETIQUETA_ESTADO_COBERTURA[estado]}</Badge>;
}

export function PanelCoberturas({
  companiaId,
  conjuntos,
  puedeInhabilitar,
}: {
  companiaId: Id<"companiasSeguridad">;
  conjuntos: readonly ContratoDestino[];
  /** Administrador o plataforma. El servidor lo vuelve a exigir. */
  puedeInhabilitar: boolean;
}) {
  const hoy = hoyColombia();
  const [desde, setDesde] = useState(sumarDias(hoy, -7));
  const [hasta, setHasta] = useState(sumarDias(hoy, 30));
  const [estado, setEstado] = useState<EstadoCobertura | "">("");
  const [condominioId, setCondominioId] = useState<Id<"condominios"> | "">("");
  const [abierta, setAbierta] = useState<Id<"coberturas"> | null>(null);

  const errorRango =
    !desde || !hasta
      ? "Elige las dos fechas."
      : desde > hasta
        ? "La fecha final no puede ser anterior a la inicial."
        : Date.parse(hasta) - Date.parse(desde) >= 366 * DIA
          ? "Elige un periodo de hasta un año."
          : null;

  const lista = useQuery(
    api.coberturas.deCompania,
    errorRango
      ? "skip"
      : {
          companiaId,
          desde,
          hasta,
          estado: estado || undefined,
          condominioId: condominioId || undefined,
        },
  );

  return (
    <div className="space-y-4">
      <p className="max-w-2xl text-sm text-muted-foreground">
        Las coberturas temporales entre conjuntos. Se solicitan desde
        Disponibilidad a un guarda disponible, y el guarda las acepta o las
        rechaza. Una cobertura aceptada todavía no le da acceso al conjunto.
      </p>

      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1.5">
          <span className="block text-[13px] font-medium text-foreground">Desde</span>
          <Input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} />
        </label>
        <label className="space-y-1.5">
          <span className="block text-[13px] font-medium text-foreground">Hasta</span>
          <Input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} />
        </label>
        <label className="space-y-1.5">
          <span className="block text-[13px] font-medium text-foreground">Estado</span>
          <Select value={estado} onChange={(e) => setEstado(e.target.value as EstadoCobertura | "")}>
            <option value="">Todos</option>
            {ESTADOS_COBERTURA.map((s) => (
              <option key={s} value={s}>
                {ETIQUETA_ESTADO_COBERTURA[s]}
              </option>
            ))}
          </Select>
        </label>
        <label className="space-y-1.5">
          <span className="block text-[13px] font-medium text-foreground">Conjunto</span>
          <Select
            value={condominioId}
            onChange={(e) => setCondominioId(e.target.value as Id<"condominios"> | "")}
          >
            <option value="">Todos</option>
            {conjuntos.map((c) => (
              <option key={c.condominioId} value={c.condominioId}>
                {c.condominioNombre}
              </option>
            ))}
          </Select>
        </label>
      </div>

      {errorRango ? (
        <p className="text-sm text-destructive">{errorRango}</p>
      ) : lista === undefined ? (
        <Skeleton className="h-32 w-full" />
      ) : lista.length === 0 ? (
        <EmptyState
          icon={ArrowLeftRight}
          title="Sin coberturas en este periodo"
          description="Se solicitan desde la pestaña Disponibilidad."
        />
      ) : (
        <TableCard>
          <Table>
            <THead>
              <tr>
                <TH>Guarda</TH>
                <TH>Conjunto</TH>
                <TH>Ventana</TH>
                <TH>Estado</TH>
                <TH className="text-right">Acciones</TH>
              </tr>
            </THead>
            <TBody>
              {lista.map((c) => (
                <TR key={c._id}>
                  <TD>
                    <CellStack primary={c.guardaNombre} secondary={`Pidió ${c.solicitadoPorNombre}`} />
                  </TD>
                  <TD>{c.condominioNombre}</TD>
                  <TD className="tabular-nums">
                    {etiquetaInstante(c.inicio)} → {etiquetaInstante(c.fin)}
                  </TD>
                  <TD>
                    <BadgeCobertura estado={c.estado} />
                  </TD>
                  <TD className="text-right">
                    <Button size="sm" variant="ghost" onClick={() => setAbierta(c._id)}>
                      Ver
                    </Button>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </TableCard>
      )}

      {abierta && (
        <DetalleCobertura
          coberturaId={abierta}
          puedeInhabilitar={puedeInhabilitar}
          onClose={() => setAbierta(null)}
        />
      )}
    </div>
  );
}

function DetalleCobertura({
  coberturaId,
  puedeInhabilitar,
  onClose,
}: {
  coberturaId: Id<"coberturas">;
  puedeInhabilitar: boolean;
  onClose: () => void;
}) {
  const c = useQuery(api.coberturas.detalle, { coberturaId });
  const cancelar = useMutation(api.coberturas.cancelar);
  const inhabilitar = useMutation(api.coberturas.inhabilitar);
  const [motivo, setMotivo] = useState("");
  const [inhabilitando, setInhabilitando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function correr(accion: () => Promise<unknown>) {
    setError(null);
    setBusy(true);
    try {
      await accion();
      setInhabilitando(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo completar.");
    } finally {
      setBusy(false);
    }
  }

  const ahora = Date.now();
  const cancelable =
    c != null && (c.estado === "solicitada" || (c.estado === "aceptada" && c.inicio > ahora));
  const inhabilitable = c != null && puedeInhabilitar && c.estado === "aceptada" && c.fin > ahora;

  return (
    <Modal open onClose={onClose} title="Cobertura" className="max-w-xl">
      {c === undefined ? (
        <Skeleton className="h-40 w-full" />
      ) : c === null ? (
        <p className="text-sm text-muted-foreground">Esa cobertura no existe.</p>
      ) : (
        <div className="space-y-4">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <Dato label="Guarda">{c.guardaNombre}</Dato>
            <Dato label="Estado">
              <BadgeCobertura estado={c.estado} />
            </Dato>
            <Dato label="Conjunto a cubrir">{c.condominioNombre}</Dato>
            <Dato label="Ventana">
              <span className="tabular-nums">
                {etiquetaInstante(c.inicio)} → {etiquetaInstante(c.fin)}
              </span>
            </Dato>
          </dl>

          <div className="space-y-1">
            <p className="text-[13px] font-medium text-foreground">Rastro</p>
            <ul className="space-y-0.5 text-sm text-muted-foreground">
              <li>Solicitada por {c.solicitadoPorNombre} · {etiquetaInstante(c.solicitadoEn)}</li>
              {c.respuesta && c.respondidoEn != null && (
                <li>
                  {c.respuesta === "aceptada" ? "Aceptada" : "Rechazada"} por {c.respondidoPorNombre} ·{" "}
                  {etiquetaInstante(c.respondidoEn)}
                </li>
              )}
              {c.canceladaEn != null && (
                <li>Cancelada por {c.canceladaPorNombre} · {etiquetaInstante(c.canceladaEn)}</li>
              )}
              {c.inhabilitadaEn != null && (
                <li>
                  Inhabilitada por {c.inhabilitadaPorNombre} · {etiquetaInstante(c.inhabilitadaEn)} —{" "}
                  {c.motivoInhabilitacion}
                </li>
              )}
            </ul>
            <p className="text-xs text-muted-foreground">Hora de Colombia.</p>
          </div>

          {inhabilitando ? (
            <div className="space-y-2 rounded-lg border border-border p-3">
              <label className="block space-y-1.5">
                <span className="text-[13px] font-medium text-foreground">
                  Motivo de la inhabilitación <span className="text-destructive">*</span>
                </span>
                <Textarea
                  value={motivo}
                  onChange={(e) => setMotivo(e.target.value)}
                  maxLength={MAX_MOTIVO_INHABILITACION}
                  rows={2}
                />
              </label>
              <p className="text-xs text-muted-foreground">
                Corta la cobertura ahora. No se puede volver a activar: si hace
                falta otra vez, se solicita una nueva.
              </p>
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => setInhabilitando(false)}>
                  Volver
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={busy || !motivo.trim()}
                  onClick={() => correr(() => inhabilitar({ coberturaId: c._id, motivo }))}
                >
                  Inhabilitar
                </Button>
              </div>
            </div>
          ) : (
            (cancelable || inhabilitable) && (
              <div className="flex flex-wrap justify-end gap-2">
                {cancelable && (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => correr(() => cancelar({ coberturaId: c._id }))}
                  >
                    Cancelar cobertura
                  </Button>
                )}
                {inhabilitable && (
                  <Button size="sm" variant="destructive" disabled={busy} onClick={() => setInhabilitando(true)}>
                    Inhabilitar
                  </Button>
                )}
              </div>
            )
          )}

          {error && <p className="text-[13px] text-destructive">{error}</p>}
        </div>
      )}
    </Modal>
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
