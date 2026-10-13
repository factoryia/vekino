"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { useQuery, useMutation } from "convex/react";
import { api } from "@vekino/backend/api";
import type { Id } from "@vekino/backend/dataModel";
import { UserCheck, Plus, X, Loader2, QrCode, Trash2, Car, Check, Phone } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { EmptyState } from "@/components/ui/empty-state";
import {
  TEXTO_SIN_UNIDAD,
  TITULO_SIN_UNIDAD,
  fechaLarga,
  etiquetaUnidad,
} from "@/components/portal/portal-ui";
import { cn } from "@/lib/utils";

const TIPO_DOC = [
  { value: "CC", label: "Cédula (CC)" },
  { value: "CE", label: "Cédula extranjería (CE)" },
  { value: "NIT", label: "NIT" },
  { value: "PASAPORTE", label: "Pasaporte" },
  { value: "OTRO", label: "Otro" },
] as const;
const TIPO_VIS = [
  { value: "visitante", label: "Visitante" },
  { value: "empresa", label: "Empresa" },
  { value: "domicilio", label: "Domicilio" },
] as const;

const ESTADO_META: Record<string, { label: string; tone: "warning" | "success" | "neutral" | "info" | "destructive" }> = {
  pendiente: { label: "QR listo", tone: "warning" },
  esperando_aprobacion: { label: "Portería pide acceso", tone: "info" },
  activo: { label: "Adentro", tone: "success" },
  finalizado: { label: "Finalizado", tone: "neutral" },
  rechazado: { label: "Rechazado", tone: "destructive" },
};

type TipoDoc = (typeof TIPO_DOC)[number]["value"];
type TipoVis = (typeof TIPO_VIS)[number]["value"];

function qrUrl(id: string) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=240x240&margin=8&data=${encodeURIComponent(id)}`;
}

export default function Visitantes() {
  const { id } = useParams<{ id: string }>();
  const condominioId = id as Id<"condominios">;
  const home = useQuery(api.portal.home, { condominioId });
  const visitantes = useQuery(api.visitantes.listMios, { condominioId });
  const [formOpen, setFormOpen] = useState(false);
  const [qrId, setQrId] = useState<Id<"visitantes"> | null>(null);

  const unidades = home && home.allowed ? home.unidades : [];
  /* Sin una casa vinculada HOY (p. ej. el contrato de arriendo venció) no se
   * ofrece autorizar: el backend tampoco lo acepta (QA de comprobantes, H3). */
  const sinUnidad = home !== undefined && unidades.length === 0;

  return (
    <div className="space-y-6 py-2">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <UserCheck className="h-6 w-6 text-brand" />
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
              Visitantes
            </h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Autoriza visitas del día con QR. Si portería pide acceso sin QR, puedes aceptar o rechazar aquí.
            </p>
          </div>
        </div>
        {sinUnidad ? null : (
          <button
            onClick={() => setFormOpen(true)}
            className="inline-flex h-10 items-center gap-2 rounded-lg bg-brand px-4 text-sm font-semibold text-brand-foreground shadow-sm transition-colors hover:bg-brand/90"
          >
            <Plus className="h-4 w-4" />
            Autorizar visitante
          </button>
        )}
      </div>

      {sinUnidad ? (
        <EmptyState icon={UserCheck} title={TITULO_SIN_UNIDAD} description={TEXTO_SIN_UNIDAD} />
      ) : visitantes === undefined ? (
        <Card className="p-12">
          <Spinner className="mx-auto h-5 w-5" />
        </Card>
      ) : visitantes.length === 0 ? (
        <EmptyState
          icon={UserCheck}
          title="Sin visitantes autorizados"
          description="Autoriza a tu primer visitante y genérale un código QR para el ingreso."
        />
      ) : (
        <div className="space-y-3">
          {visitantes.map((vis) => {
            const estado = ESTADO_META[vis.estado];
            const tipoVis = TIPO_VIS.find((t) => t.value === vis.tipo)?.label ?? vis.tipo;
            const esWalkIn = vis.estado === "esperando_aprobacion";
            return (
              <Card
                key={vis._id}
                className={cn(
                  "flex flex-wrap items-center gap-4 p-5",
                  esWalkIn && "border-brand/40 bg-brand/3",
                )}
              >
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand">
                  {esWalkIn ? <Phone className="h-5 w-5" /> : <UserCheck className="h-5 w-5" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold text-foreground">{vis.nombre}</p>
                    {estado && <Badge tone={estado.tone}>{estado.label}</Badge>}
                    {vis.qrInvalidado && vis.estado !== "esperando_aprobacion" && (
                      <Badge tone="neutral">QR usado</Badge>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {vis.tipoDocumento} {vis.documento} · {tipoVis}
                    {vis.unidadNumero ? ` · Unidad ${vis.unidadNumero}` : ""}
                    {vis.placa ? (
                      <span className="inline-flex items-center gap-1">
                        {" · "}
                        <Car className="h-3.5 w-3.5" />
                        {vis.placa}
                      </span>
                    ) : null}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {esWalkIn
                      ? "Portería solicita dejarlo entrar. ¿Lo autorizas?"
                      : vis.fechaVisitaInicio
                        ? `Válido: ${fechaLarga(vis.fechaVisitaInicio)} (solo ese día)`
                        : ""}
                    {vis.fechaIngreso ? ` · Ingresó ${fechaLarga(vis.fechaIngreso)}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {esWalkIn ? (
                    <WalkInActions id={vis._id} />
                  ) : (
                    <>
                      {vis.estado === "pendiente" && !vis.qrInvalidado && (
                        <button
                          onClick={() => setQrId(vis._id)}
                          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-sm font-medium text-foreground transition-colors hover:bg-accent"
                        >
                          <QrCode className="h-4 w-4" />
                          QR
                        </button>
                      )}
                      {vis.estado !== "activo" && <BorrarBtn id={vis._id} />}
                    </>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {formOpen && !sinUnidad && (
        <VisitanteForm
          condominioId={condominioId}
          unidades={unidades}
          onClose={() => setFormOpen(false)}
          onCreated={(newId) => {
            setFormOpen(false);
            setQrId(newId);
          }}
        />
      )}
      {qrId && <QrModal id={qrId} onClose={() => setQrId(null)} />}
    </div>
  );
}

function WalkInActions({ id }: { id: Id<"visitantes"> }) {
  const responder = useMutation(api.visitantes.responderWalkIn);
  const [busy, setBusy] = useState<"si" | "no" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function go(aceptar: boolean) {
    setBusy(aceptar ? "si" : "no");
    setError(null);
    try {
      await responder({ id, aceptar });
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo responder.");
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-2">
        <button
          onClick={() => go(false)}
          disabled={busy !== null}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-sm font-medium text-muted-foreground hover:bg-accent disabled:opacity-50"
        >
          {busy === "no" ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
          Rechazar
        </button>
        <button
          onClick={() => go(true)}
          disabled={busy !== null}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand px-3 text-sm font-semibold text-brand-foreground hover:bg-brand/90 disabled:opacity-50"
        >
          {busy === "si" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
          Aceptar ingreso
        </button>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}

function BorrarBtn({ id }: { id: Id<"visitantes"> }) {
  const remove = useMutation(api.visitantes.removeMio);
  const [busy, setBusy] = useState(false);
  async function borrar() {
    if (!confirm("¿Eliminar esta autorización?")) return;
    setBusy(true);
    try {
      await remove({ id });
    } catch {
      setBusy(false);
    }
  }
  return (
    <button
      onClick={borrar}
      disabled={busy}
      aria-label="Eliminar"
      className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-red-50 hover:text-red-600 disabled:opacity-50 dark:hover:bg-red-950/20"
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
    </button>
  );
}

function QrModal({ id, onClose }: { id: Id<"visitantes">; onClose: () => void }) {
  const vis = useQuery(api.visitantes.getMio, { id });
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="animate-fade-in absolute inset-0 bg-foreground/40 backdrop-blur-sm" onClick={onClose} />
      <div className="animate-scale-in relative z-10 w-full max-w-xs rounded-2xl border border-border bg-card p-6 text-center shadow-xl">
        <button
          onClick={onClose}
          aria-label="Cerrar"
          className="absolute right-3 top-3 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="h-5 w-5" />
        </button>
        <h2 className="text-base font-semibold text-foreground">Código de ingreso</h2>
        {vis === undefined ? (
          <div className="py-16">
            <Spinner className="mx-auto h-5 w-5" />
          </div>
        ) : vis === null ? (
          <p className="py-8 text-sm text-muted-foreground">No disponible.</p>
        ) : !vis.qrVigente ? (
          <>
            <p className="mt-6 font-semibold text-foreground">{vis.nombre}</p>
            <p className="mt-2 text-sm text-amber-700 dark:text-amber-400">
              {vis.qrMensaje ?? "Este QR ya no es válido."}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              Genera una autorización nueva para el día de la visita.
            </p>
          </>
        ) : (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={qrUrl(vis._id)}
              alt="Código QR del visitante"
              className="mx-auto mt-4 h-56 w-56 rounded-xl border border-border bg-white p-2"
            />
            <p className="mt-3 font-semibold text-foreground">{vis.nombre}</p>
            <p className="text-sm text-muted-foreground">
              {vis.tipoDocumento} {vis.documento}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              Válido solo el día de la visita. Muéstralo al guardia al llegar.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function VisitanteForm({
  condominioId,
  unidades,
  onClose,
  onCreated,
}: {
  condominioId: Id<"condominios">;
  unidades: {
    _id: string;
    numero: string;
    tipo?: string;
    torre?: string | null;
  }[];
  onClose: () => void;
  onCreated: (id: Id<"visitantes">) => void;
}) {
  const crear = useMutation(api.visitantes.crearMio);
  const hoy = new Date().toISOString().slice(0, 10);
  const [nombre, setNombre] = useState("");
  const [documento, setDocumento] = useState("");
  const [tipoDocumento, setTipoDocumento] = useState<TipoDoc>("CC");
  const [tipo, setTipo] = useState<TipoVis>("visitante");
  const [placa, setPlaca] = useState("");
  const [fecha, setFecha] = useState(hoy);
  const [unidadIds, setUnidadIds] = useState<string[]>(
    unidades[0]?._id ? [unidades[0]._id] : [],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleUnidad(id: string) {
    setUnidadIds((prev) => {
      if (prev.includes(id)) {
        if (prev.length === 1) return prev;
        return prev.filter((x) => x !== id);
      }
      return [...prev, id];
    });
  }

  function toggleTodas() {
    if (unidadIds.length === unidades.length) {
      setUnidadIds(unidades[0]?._id ? [unidades[0]._id] : []);
    } else {
      setUnidadIds(unidades.map((u) => u._id));
    }
  }

  async function guardar(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!nombre.trim()) return setError("El nombre es obligatorio.");
    if (!documento.trim()) return setError("El documento es obligatorio.");
    if (unidadIds.length === 0) return setError("Selecciona al menos una unidad.");
    setBusy(true);
    try {
      let lastId: Id<"visitantes"> | null = null;
      for (const uid of unidadIds) {
        lastId = await crear({
          condominioId,
          unidadId: uid as Id<"unidades">,
          nombre,
          documento,
          tipoDocumento,
          tipo,
          placa: placa.trim() || undefined,
          fechaVisita: fecha,
        });
      }
      if (lastId) onCreated(lastId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo autorizar.");
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div className="animate-fade-in absolute inset-0 bg-foreground/40 backdrop-blur-sm" onClick={onClose} />
      <div className="animate-slide-up relative z-10 w-full max-w-md rounded-t-2xl border border-border bg-card p-6 shadow-xl sm:rounded-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-foreground">Autorizar visitante</h2>
          <button
            onClick={onClose}
            aria-label="Cerrar"
            className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={guardar} className="space-y-4">
          <Field label="Nombre completo">
            <input value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="Nombre del visitante" className={inputCls} autoFocus />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Tipo doc.">
              <select value={tipoDocumento} onChange={(e) => setTipoDocumento(e.target.value as TipoDoc)} className={inputCls}>
                {TIPO_DOC.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </Field>
            <Field label="Documento">
              <input value={documento} onChange={(e) => setDocumento(e.target.value)} placeholder="Número" className={inputCls} />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Tipo">
              <select value={tipo} onChange={(e) => setTipo(e.target.value as TipoVis)} className={inputCls}>
                {TIPO_VIS.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </Field>
            <Field label="Placa (opcional)">
              <input value={placa} onChange={(e) => setPlaca(e.target.value.toUpperCase())} placeholder="ABC123" className={inputCls} />
            </Field>
          </div>

          <Field label="Fecha de visita">
            <input type="date" value={fecha} min={hoy} onChange={(e) => setFecha(e.target.value)} className={inputCls} />
            <p className="mt-1 text-[11px] text-muted-foreground">
              El QR solo sirve ese día. Si no llega, se elimina automáticamente.
            </p>
          </Field>

          {unidades.length > 1 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-muted-foreground">
                  Unidades ({unidadIds.length})
                </span>
                <button
                  type="button"
                  onClick={toggleTodas}
                  className="text-xs font-medium text-brand hover:underline"
                >
                  {unidadIds.length === unidades.length
                    ? "Solo una"
                    : "Seleccionar todas"}
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                {unidades.map((u) => {
                  const active = unidadIds.includes(u._id);
                  return (
                    <button
                      key={u._id}
                      type="button"
                      onClick={() => toggleUnidad(u._id)}
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors",
                        active
                          ? "border-brand/40 bg-brand/10 text-foreground"
                          : "border-border bg-card text-muted-foreground hover:bg-accent/50",
                      )}
                      aria-pressed={active}
                    >
                      {active ? <Check className="h-3.5 w-3.5 text-brand" /> : null}
                      {etiquetaUnidad(u)}
                    </button>
                  );
                })}
              </div>
              <p className="text-[11px] text-muted-foreground">
                Se genera un QR por cada unidad seleccionada.
              </p>
            </div>
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
              {unidadIds.length > 1
                ? `Autorizar (${unidadIds.length})`
                : "Autorizar y generar QR"}
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
