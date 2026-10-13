"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { useQuery, useMutation } from "convex/react";
import { api } from "@vekino/backend/api";
import type { Id } from "@vekino/backend/dataModel";
import { CalendarCheck, Users, Clock, Plus, X, Loader2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { EmptyState } from "@/components/ui/empty-state";
import { TEXTO_SIN_UNIDAD, TITULO_SIN_UNIDAD, fechaISO } from "@/components/portal/portal-ui";

const ESTADO_META: Record<
  string,
  { label: string; tone: "warning" | "success" | "destructive" | "neutral" }
> = {
  pendiente: { label: "Pendiente", tone: "warning" },
  aprobada: { label: "Aprobada", tone: "success" },
  rechazada: { label: "Rechazada", tone: "destructive" },
  cancelada: { label: "Cancelada", tone: "neutral" },
};

export default function Reservas() {
  const { id } = useParams<{ id: string }>();
  const condominioId = id as Id<"condominios">;

  const home = useQuery(api.portal.home, { condominioId });
  const zonas = useQuery(api.reservas.listZonas, { condominioId });
  const misReservas = useQuery(api.reservas.listMias, { condominioId });
  const [formOpen, setFormOpen] = useState(false);

  const unidades = home && home.allowed ? home.unidades : [];
  /* Sin una casa vinculada HOY no se ofrece reservar: el backend tampoco lo
   * acepta (`misUnidadIds`; QA de comprobantes, H3). */
  const sinUnidad = home !== undefined && unidades.length === 0;
  const zonasActivas = (zonas ?? []).filter((z) => z.activa);

  return (
    <div className="space-y-6 py-2 sm:space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
            Mis reservas
          </h1>
          <p className="mt-1 text-sm text-muted-foreground sm:text-base">
            Gestiona tus reservas de espacios comunes.
          </p>
        </div>
        {sinUnidad ? null : (
          <button
            onClick={() => setFormOpen(true)}
            disabled={zonasActivas.length === 0}
            className="inline-flex h-10 items-center gap-2 rounded-lg bg-brand px-4 text-sm font-semibold text-brand-foreground shadow-sm transition-colors hover:bg-brand/90 disabled:opacity-50"
          >
            <Plus className="h-4 w-4" />
            Nueva reserva
          </button>
        )}
      </div>

      {/* Zonas comunes */}
      <div>
        <h2 className="mb-3 text-lg font-semibold tracking-tight text-foreground">
          Zonas comunes
        </h2>
        {zonas === undefined ? (
          <Card className="p-6">
            <Spinner className="mx-auto h-5 w-5" />
          </Card>
        ) : zonasActivas.length === 0 ? (
          <Card className="p-6 text-center text-sm text-muted-foreground">
            No hay zonas comunes disponibles para reservar.
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {zonasActivas.map((z) => (
              <Card key={z._id} className="p-5">
                <div className="flex items-center gap-3">
                  <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand/10 text-brand">
                    <CalendarCheck className="h-5 w-5" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-base font-semibold text-foreground">{z.nombre}</p>
                    {z.capacidad != null && (
                      <p className="flex items-center gap-1 text-sm text-muted-foreground">
                        <Users className="h-3.5 w-3.5" /> Hasta {z.capacidad} personas
                      </p>
                    )}
                  </div>
                </div>
                {z.descripcion && (
                  <p className="mt-3 text-sm text-muted-foreground">{z.descripcion}</p>
                )}
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Mis reservas */}
      <div>
        <h2 className="mb-3 text-lg font-semibold tracking-tight text-foreground">
          Historial de reservas
        </h2>
        {misReservas === undefined ? (
          <Card className="p-6">
            <Spinner className="mx-auto h-5 w-5" />
          </Card>
        ) : misReservas.length === 0 && sinUnidad ? (
          <EmptyState icon={CalendarCheck} title={TITULO_SIN_UNIDAD} description={TEXTO_SIN_UNIDAD} />
        ) : misReservas.length === 0 ? (
          <EmptyState
            icon={CalendarCheck}
            title="No tienes reservas aún"
            description="Crea una reserva con el botón “Nueva reserva”."
          />
        ) : (
          <div className="space-y-3">
            {misReservas.map((r) => {
              const estado = ESTADO_META[r.estado];
              return (
                <Card key={r._id} className="flex flex-wrap items-center gap-3 p-5">
                  <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                    <CalendarCheck className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-base font-semibold text-foreground">{r.zonaNombre}</p>
                    <p className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
                      {fechaISO(r.fecha)}
                      <span className="inline-flex items-center gap-1">
                        <Clock className="h-3.5 w-3.5" /> {r.horaInicio}–{r.horaFin}
                      </span>
                    </p>
                  </div>
                  {estado && <Badge tone={estado.tone}>{estado.label}</Badge>}
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {formOpen && !sinUnidad && (
        <ReservaForm
          condominioId={condominioId}
          unidades={unidades}
          zonas={zonasActivas}
          onClose={() => setFormOpen(false)}
        />
      )}
    </div>
  );
}

function ReservaForm({
  condominioId,
  unidades,
  zonas,
  onClose,
}: {
  condominioId: Id<"condominios">;
  unidades: { _id: string; numero: string }[];
  /* La zona entera, no solo el nombre: sin los precios el residente llenaba
     el formulario sin ver un peso y se enteraba del valor cuando se lo
     cobraban. */
  zonas: ({ _id: Id<"zonasComunes">; nombre: string } & Tarifa)[];
  onClose: () => void;
}) {
  const create = useMutation(api.reservas.createMia);
  const hoy = new Date().toISOString().slice(0, 10);
  const [zonaId, setZonaId] = useState(zonas[0]?._id ?? "");
  const [unidadId, setUnidadId] = useState(unidades[0]?._id ?? "");
  const [fecha, setFecha] = useState(hoy);
  const [horaInicio, setHoraInicio] = useState("10:00");
  const [horaFin, setHoraFin] = useState("12:00");
  const [observaciones, setObservaciones] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const zona = zonas.find((z) => z._id === zonaId);

  async function guardar(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!zonaId) return setError("Selecciona una zona.");
    if (!unidadId) return setError("Selecciona una unidad.");
    /* No se compara fin > inicio: una reserva de 22:00 a 01:00 es válida si
     * la zona cierra pasada la medianoche. Quien sabe si cabe es el backend,
     * que conoce el horario de la zona y devuelve el motivo exacto. */
    if (horaInicio === horaFin) return setError("La reserva no puede empezar y terminar a la misma hora.");
    setBusy(true);
    try {
      await create({
        condominioId,
        unidadId: unidadId as Id<"unidades">,
        zonaId: zonaId as Id<"zonasComunes">,
        fecha,
        horaInicio,
        horaFin,
        observaciones: observaciones.trim() || undefined,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo crear la reserva.");
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div className="animate-fade-in absolute inset-0 bg-foreground/40 backdrop-blur-sm" onClick={onClose} />
      <div className="animate-slide-up relative z-10 w-full max-w-md rounded-t-2xl border border-border bg-card p-6 shadow-xl sm:rounded-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-foreground">Nueva reserva</h2>
          <button
            onClick={onClose}
            aria-label="Cerrar"
            className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={guardar} className="space-y-4">
          <Field label="Zona común">
            <select value={zonaId} onChange={(e) => setZonaId(e.target.value)} className={inputCls}>
              {zonas.map((z) => (
                <option key={z._id} value={z._id}>
                  {z.nombre}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Fecha">
            <input
              type="date"
              value={fecha}
              min={hoy}
              onChange={(e) => setFecha(e.target.value)}
              className={inputCls}
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Desde">
              <input type="time" value={horaInicio} onChange={(e) => setHoraInicio(e.target.value)} className={inputCls} />
            </Field>
            <Field label="Hasta">
              <input type="time" value={horaFin} onChange={(e) => setHoraFin(e.target.value)} className={inputCls} />
            </Field>
          </div>

          {unidades.length > 1 && (
            <Field label="Unidad">
              <select value={unidadId} onChange={(e) => setUnidadId(e.target.value)} className={inputCls}>
                {unidades.map((u) => (
                  <option key={u._id} value={u._id}>
                    Unidad {u.numero}
                  </option>
                ))}
              </select>
            </Field>
          )}

          <Field label="Observaciones (opcional)">
            <textarea
              value={observaciones}
              onChange={(e) => setObservaciones(e.target.value)}
              rows={2}
              placeholder="Motivo de la reserva…"
              className={cn(inputCls, "h-auto resize-none py-2")}
            />
          </Field>

          {/* El valor, antes de confirmar y no despues de que se lo cobren.
              El mismo bloque que ve la administracion: si se separan, uno de
              los dos envejece. */}
          <ResumenCosto
            zona={zona}
            horaInicio={horaInicio}
            horaFin={horaFin}
            nota="El pago se realiza con la administración una vez aprueben tu reserva."
          />

          {error && <p className="text-sm text-red-600">{error}</p>}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-10 items-center rounded-lg border border-border bg-card px-4 text-sm font-medium text-foreground transition-colors hover:bg-accent"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={busy}
              className="inline-flex h-10 items-center gap-2 rounded-lg bg-brand px-5 text-sm font-semibold text-brand-foreground shadow-sm transition-colors hover:bg-brand/90 disabled:opacity-60"
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              Crear reserva
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

import { cn } from "@/lib/utils";
import type { Tarifa } from "@vekino/backend/costoReserva";
import { ResumenCosto } from "@/components/reservas/resumen-costo";

const inputCls =
  "h-10 w-full rounded-lg border border-input bg-card px-3 text-sm text-foreground outline-none transition-colors focus:border-brand focus:ring-2 focus:ring-brand/20";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium text-foreground">{label}</span>
      {children}
    </label>
  );
}
