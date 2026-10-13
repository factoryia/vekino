"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { useQuery, useMutation } from "convex/react";
import { api } from "@vekino/backend/api";
import type { Id } from "@vekino/backend/dataModel";
import { Car, Plus, Archive, ArchiveRestore, X, Loader2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { TEXTO_SIN_UNIDAD, TITULO_SIN_UNIDAD } from "@/components/portal/portal-ui";
import { cn } from "@/lib/utils";

const TIPOS = [
  { value: "carro", label: "Carro" },
  { value: "moto", label: "Moto" },
  { value: "bicicleta", label: "Bicicleta" },
  { value: "otro", label: "Otro" },
] as const;

type Tipo = (typeof TIPOS)[number]["value"];

export default function Vehiculos() {
  const { id } = useParams<{ id: string }>();
  const condominioId = id as Id<"condominios">;
  const home = useQuery(api.portal.home, { condominioId });
  const vehiculos = useQuery(api.vehiculos.listMios, { condominioId });
  const [formOpen, setFormOpen] = useState(false);

  const unidades = home && home.allowed ? home.unidades : [];
  /* Sin una casa vinculada HOY no se ofrece registrar: el backend tampoco lo
   * acepta (`misUnidadIds`; QA de comprobantes, H3). */
  const sinUnidad = home !== undefined && unidades.length === 0;

  return (
    <div className="space-y-6 py-2">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <Car className="h-6 w-6 text-brand" />
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
              Mis vehículos
            </h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Registra los vehículos de tu unidad para el control de acceso.
            </p>
          </div>
        </div>
        {vehiculos && vehiculos.length > 0 && !sinUnidad && (
          <button
            onClick={() => setFormOpen(true)}
            className="inline-flex h-10 items-center gap-2 rounded-lg bg-brand px-4 text-sm font-semibold text-brand-foreground shadow-sm transition-colors hover:bg-brand/90"
          >
            <Plus className="h-4 w-4" />
            Agregar
          </button>
        )}
      </div>

      {vehiculos === undefined ? (
        <Card className="p-12">
          <Spinner className="mx-auto h-5 w-5" />
        </Card>
      ) : vehiculos.length === 0 && sinUnidad ? (
        <Card className="flex flex-col items-center gap-3 p-12 text-center">
          <Car className="h-12 w-12 text-muted-foreground/40" />
          <div>
            <p className="text-base font-semibold text-foreground">{TITULO_SIN_UNIDAD}</p>
            <p className="mt-1 text-sm text-muted-foreground">{TEXTO_SIN_UNIDAD}</p>
          </div>
        </Card>
      ) : vehiculos.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 p-12 text-center">
          <Car className="h-12 w-12 text-muted-foreground/40" />
          <div>
            <p className="text-base font-semibold text-foreground">
              Sin vehículos registrados
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Agrega los vehículos de tu unidad para facilitar el acceso.
            </p>
          </div>
          <button
            onClick={() => setFormOpen(true)}
            className="mt-1 inline-flex h-10 items-center gap-2 rounded-lg bg-brand px-4 text-sm font-semibold text-brand-foreground shadow-sm transition-colors hover:bg-brand/90"
          >
            <Plus className="h-4 w-4" />
            Registrar primer vehículo
          </button>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {vehiculos.map((veh) => (
            <VehiculoCard key={veh._id} veh={veh} />
          ))}
        </div>
      )}

      {formOpen && !sinUnidad && (
        <VehiculoForm
          condominioId={condominioId}
          unidades={unidades}
          onClose={() => setFormOpen(false)}
        />
      )}
    </div>
  );
}

function VehiculoCard({
  veh,
}: {
  veh: {
    _id: Id<"vehiculos">;
    placa: string;
    tipo: string;
    marca?: string;
    color?: string;
    unidadNumero: string;
    archivadoEn?: number;
  };
}) {
  const remove = useMutation(api.vehiculos.removeMio);
  const restaurar = useMutation(api.vehiculos.restaurarMio);
  const [busy, setBusy] = useState(false);
  const tipoLabel = TIPOS.find((t) => t.value === veh.tipo)?.label ?? veh.tipo;
  const archivado = veh.archivadoEn != null;

  /* Retirar no borra: archiva. El vigilante tiene que poder mirar atrás —si
   * el carro se vendió y alguien pregunta por un reporte de hace meses, la
   * placa tiene que seguir existiendo—. Y si el vehículo vuelve, se
   * desarchiva en vez de quedar registrado dos veces. */
  async function alternar() {
    if (!archivado && !confirm(`¿Retirar el vehículo ${veh.placa}?`)) return;
    setBusy(true);
    try {
      if (archivado) await restaurar({ id: veh._id });
      else await remove({ id: veh._id });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className={`flex items-center gap-4 p-5 ${archivado ? "opacity-60" : ""}`}>
      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand">
        <Car className="h-6 w-6" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-lg font-bold tracking-wide text-foreground">
          {veh.placa}
          {archivado && (
            <span className="ml-2 rounded-md bg-muted px-2 py-0.5 align-middle text-[11px] font-semibold text-muted-foreground">
              Retirado
            </span>
          )}
        </p>
        <p className="text-sm text-muted-foreground">
          {tipoLabel}
          {veh.marca ? ` · ${veh.marca}` : ""}
          {veh.color ? ` · ${veh.color}` : ""}
        </p>
        <p className="text-xs text-muted-foreground">Unidad {veh.unidadNumero}</p>
      </div>
      <button
        onClick={alternar}
        disabled={busy}
        aria-label={archivado ? "Volver a activar" : "Retirar vehículo"}
        title={archivado ? "Volver a activar" : "Retirar vehículo"}
        className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
      >
        {busy ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : archivado ? (
          <ArchiveRestore className="h-4 w-4" />
        ) : (
          <Archive className="h-4 w-4" />
        )}
      </button>
    </Card>
  );
}

function VehiculoForm({
  condominioId,
  unidades,
  onClose,
}: {
  condominioId: Id<"condominios">;
  unidades: { _id: string; numero: string }[];
  onClose: () => void;
}) {
  const create = useMutation(api.vehiculos.createMio);
  const [placa, setPlaca] = useState("");
  const [tipo, setTipo] = useState<Tipo>("carro");
  const [marca, setMarca] = useState("");
  const [color, setColor] = useState("");
  const [unidadId, setUnidadId] = useState(unidades[0]?._id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function guardar(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!placa.trim()) return setError("La placa es obligatoria.");
    if (!unidadId) return setError("Selecciona una unidad.");
    setBusy(true);
    try {
      await create({
        condominioId,
        unidadId: unidadId as Id<"unidades">,
        placa,
        tipo,
        marca: marca.trim() || undefined,
        color: color.trim() || undefined,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar.");
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div className="animate-fade-in absolute inset-0 bg-foreground/40 backdrop-blur-sm" onClick={onClose} />
      <div className="animate-slide-up relative z-10 w-full max-w-md rounded-t-2xl border border-border bg-card p-6 shadow-xl sm:rounded-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-foreground">Agregar vehículo</h2>
          <button
            onClick={onClose}
            aria-label="Cerrar"
            className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={guardar} className="space-y-4">
          <Field label="Placa">
            <input
              value={placa}
              onChange={(e) => setPlaca(e.target.value.toUpperCase())}
              placeholder="ABC123"
              className={inputCls}
              autoFocus
            />
          </Field>

          <Field label="Tipo">
            <select value={tipo} onChange={(e) => setTipo(e.target.value as Tipo)} className={inputCls}>
              {TIPOS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Marca (opcional)">
              <input value={marca} onChange={(e) => setMarca(e.target.value)} placeholder="Mazda" className={inputCls} />
            </Field>
            <Field label="Color (opcional)">
              <input value={color} onChange={(e) => setColor(e.target.value)} placeholder="Gris" className={inputCls} />
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
              Guardar
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

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
