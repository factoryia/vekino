"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { useQuery, useMutation } from "convex/react";
import {
  Package, Plus, Loader2, Check, Search, PackageCheck, Camera, Eye, Image as ImageIcon, Trash2, Home, X,
} from "lucide-react";
import { api } from "@vekino/backend/api";
import type { Id, Doc } from "@vekino/backend/dataModel";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Input, Select } from "@/components/ui/input";
import { PageContainer } from "@/components/layout/page-container";
import { PageHeader } from "@/components/layout/page-header";
import { cn } from "@/lib/utils";
import { useUploadToS3 } from "@/hooks/use-upload-s3";
import { SelectorUnidades, type UnidadElegida } from "@/components/guardia/selector-unidades";

type Paq = Omit<Doc<"paquetes">, "fotoUrl" | "fotoEntregaUrl"> & {
  fotoUrl: string | null;
  fotoEntregaUrl: string | null;
};
type TipoPaq = Doc<"paquetes">["tipo"];

const TIPO_LABEL: Record<TipoPaq, string> = {
  paquete: "Paquete", sobre: "Sobre", comida: "Comida", mercado: "Mercado", otro: "Otro",
};

function fmtHora(ts?: number) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("es-CO", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export default function GuardiaPaqueteriaPage() {
  const params = useParams<{ id: string }>();
  const condominioId = params.id as Id<"condominios">;
  const paquetes = useQuery(api.guardia.listPaquetes, { condominioId });

  const [tab, setTab] = useState<"recibido" | "entregado">("recibido");
  const [buscar, setBuscar] = useState("");
  const [nuevoOpen, setNuevoOpen] = useState(false);
  const [entregar, setEntregar] = useState<Paq | null>(null);
  const [detalle, setDetalle] = useState<Paq | null>(null);
  const [eliminar, setEliminar] = useState<Paq | null>(null);

  const pendientes = paquetes?.filter((p) => p.estado === "recibido").length ?? 0;

  const filtrados = (paquetes ?? [])
    .filter((p) => p.estado === tab)
    .filter((p) => {
      if (!buscar.trim()) return true;
      const q = buscar.toLowerCase();
      return `${p.unidadNumero} ${p.destinatario ?? ""} ${p.remitente ?? ""}`.toLowerCase().includes(q);
    });

  return (
    <PageContainer>
      <div className="space-y-6">
        <PageHeader
          title="Paquetería"
          description={
            pendientes > 0
              ? `Recepción y entrega con evidencia fotográfica · ${pendientes} por entregar`
              : "Recepción y entrega con evidencia fotográfica"
          }
          action={
            <Button size="sm" onClick={() => setNuevoOpen(true)}>
              <Plus className="h-4 w-4" /> Recibir paquete
            </Button>
          }
        />

      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="flex gap-1 rounded-xl bg-muted p-1">
          {([["recibido", "Por entregar"], ["entregado", "Entregados"]] as const).map(([val, label]) => (
            <button
              key={val}
              onClick={() => setTab(val)}
              className={cn("rounded-lg px-4 py-1.5 text-sm font-medium transition-colors", tab === val ? "bg-card text-foreground shadow-sm" : "text-muted-foreground")}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={buscar} onChange={(e) => setBuscar(e.target.value)} placeholder="Unidad, destinatario o remitente" className="pl-9" />
        </div>
      </div>

      {paquetes === undefined ? (
        <div className="space-y-3">{[...Array(3)].map((_, i) => <Skeleton key={i} className="h-20 rounded-2xl" />)}</div>
      ) : filtrados.length === 0 ? (
        <EmptyState
          icon={tab === "recibido" ? Package : PackageCheck}
          title={tab === "recibido" ? "Sin paquetes pendientes" : "Sin entregas registradas"}
          description={tab === "recibido" ? "Registra la correspondencia que llega a portería." : "Aquí queda la evidencia de lo entregado."}
        />
      ) : (
        <div className="space-y-3">
          {filtrados.map((p) => (
            <Card key={p._id} className="p-4">
              <div className="flex items-start gap-3">
                {p.fotoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={p.fotoUrl} alt="Paquete" className="h-14 w-14 shrink-0 rounded-lg object-cover ring-1 ring-border" />
                ) : (
                  <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                    <Package className="h-6 w-6" />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-md bg-muted px-2 py-0.5 text-sm font-semibold text-foreground">Unidad {p.unidadNumero}</span>
                    <Badge tone="info">{TIPO_LABEL[p.tipo]}</Badge>
                    {p.estado === "entregado" && <Badge tone="success">Entregado</Badge>}
                  </div>
                  {p.remitente && <p className="mt-1 text-sm text-foreground">De: {p.remitente}</p>}
                  {p.destinatario && <p className="text-xs text-muted-foreground">Para: {p.destinatario}</p>}
                  <p className="mt-1 text-xs text-muted-foreground">
                    Recibido {fmtHora(p.fechaRecibido)} · {p.recibidoPorNombre}
                    {p.estado === "entregado" && <> · Entregado {fmtHora(p.fechaEntregado)}{p.entregadoANombre ? ` a ${p.entregadoANombre}` : ""}</>}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1.5">
                  {p.estado === "recibido" && (
                    <Button size="sm" onClick={() => setEntregar(p)}><Check className="h-4 w-4" /> Entregar</Button>
                  )}
                  <button onClick={() => setDetalle(p)} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                    <Eye className="h-3.5 w-3.5" /> Detalle
                  </button>
                  {p.estado === "recibido" && (
                    <button
                      onClick={() => setEliminar(p)}
                      className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" /> Eliminar
                    </button>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {nuevoOpen && <RecibirModal condominioId={condominioId} onClose={() => setNuevoOpen(false)} />}
      {entregar && <EntregarModal paquete={entregar} onClose={() => setEntregar(null)} />}
      {detalle && (
        <DetalleModal
          paquete={detalle}
          onClose={() => setDetalle(null)}
          onEliminar={
            detalle.estado === "recibido"
              ? () => {
                  setDetalle(null);
                  setEliminar(detalle);
                }
              : undefined
          }
        />
      )}
      {eliminar && <EliminarModal paquete={eliminar} onClose={() => setEliminar(null)} />}
      </div>
    </PageContainer>
  );
}

function RecibirModal({ condominioId, onClose }: { condominioId: Id<"condominios">; onClose: () => void }) {
  const recibir = useMutation(api.guardia.recibirPaquete);
  const uploadFile = useUploadToS3();
  /* La casa sale del selector; `numeroLibre` es la salida para lo que no está
     en la lista, que el backend registra igual (sin aviso al residente). */
  const [casa, setCasa] = useState<UnidadElegida[]>([]);
  const [numeroLibre, setNumeroLibre] = useState<string | null>(null);
  const [tipo, setTipo] = useState<TipoPaq>("paquete");
  const [remitente, setRemitente] = useState("");
  const [destinatario, setDestinatario] = useState("");
  const [descripcion, setDescripcion] = useState("");
  const [foto, setFoto] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const elegida = casa[0] ?? null;
  const valid = elegida !== null || !!numeroLibre?.trim();

  function elegirCasa(u: UnidadElegida[]) {
    setCasa(u);
    setNumeroLibre(null);
    /* Quien vive ahí es el destinatario más probable; se puede cambiar. */
    if (u[0]?.residente && !destinatario.trim()) setDestinatario(u[0].residente);
  }

  async function save() {
    if (!valid) return;
    setBusy(true); setError(null);
    try {
      let fotoUrl: string | undefined;
      if (foto) {
        const uploaded = await uploadFile(
          foto,
          `condominios/guardia/${condominioId}/paquetes`,
        );
        fotoUrl = uploaded.url;
      }
      await recibir({
        condominioId,
        unidadNumero: elegida?.numero ?? numeroLibre ?? "",
        unidadId: elegida?._id,
        tipo,
        remitente: remitente || undefined,
        destinatario: destinatario || undefined,
        descripcion: descripcion || undefined,
        fotoUrl,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al registrar.");
      setBusy(false);
    }
  }

  return (
    <Modal
      open onClose={onClose}
      title="Recibir paquete"
      description="Queda registrado en la minuta con evidencia"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>Cancelar</Button>
          <Button size="sm" onClick={save} disabled={!valid || busy}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} Registrar
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2 space-y-1.5">
            <label className="flex items-center gap-1.5 text-xs font-medium text-foreground">
              <Home className="h-3.5 w-3.5" /> Casa *
            </label>
            {numeroLibre ? (
              <span className="inline-flex max-w-full items-center gap-1.5 rounded-lg bg-amber-500/10 px-2 py-1 text-[13px] font-medium text-amber-700 dark:text-amber-400">
                <Home className="h-3 w-3 shrink-0" aria-hidden />
                <span className="truncate">{numeroLibre} · no está en la lista, no se avisa al residente</span>
                <button
                  type="button"
                  onClick={() => setNumeroLibre(null)}
                  aria-label="Cambiar casa"
                  className="rounded p-0.5 hover:text-destructive"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ) : (
              <SelectorUnidades
                condominioId={condominioId}
                elegidas={casa}
                onChange={elegirCasa}
                unica
                onTextoLibre={setNumeroLibre}
              />
            )}
          </div>
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-foreground">Tipo</label>
            <Select value={tipo} onChange={(e) => setTipo(e.target.value as TipoPaq)}>
              {(Object.keys(TIPO_LABEL) as TipoPaq[]).map((t) => <option key={t} value={t}>{TIPO_LABEL[t]}</option>)}
            </Select>
          </div>
        </div>
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-foreground">Empresa / remitente</label>
          <Input value={remitente} onChange={(e) => setRemitente(e.target.value)} placeholder="Ej. Servientrega, Rappi…" />
        </div>
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-foreground">Destinatario</label>
          <Input value={destinatario} onChange={(e) => setDestinatario(e.target.value)} placeholder="Nombre (opcional)" />
        </div>
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-foreground">Descripción</label>
          <Input value={descripcion} onChange={(e) => setDescripcion(e.target.value)} placeholder="Ej. caja mediana (opcional)" />
        </div>
        <div className="space-y-1.5">
          <label className="flex items-center gap-1.5 text-xs font-medium text-foreground">
            <Camera className="h-3.5 w-3.5" /> Foto de llegada (opcional)
          </label>
          <Input type="file" accept="image/*" capture="environment" onChange={(e) => setFoto(e.target.files?.[0] ?? null)} />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
    </Modal>
  );
}

function EntregarModal({ paquete, onClose }: { paquete: Paq; onClose: () => void }) {
  const entregar = useMutation(api.guardia.entregarPaquete);
  const uploadFile = useUploadToS3();
  const [entregadoA, setEntregadoA] = useState("");
  const [observaciones, setObservaciones] = useState("");
  const [foto, setFoto] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true); setError(null);
    try {
      let fotoEntregaUrl: string | undefined;
      if (foto) {
        const uploaded = await uploadFile(
          foto,
          `condominios/guardia/${paquete.condominioId}/paquetes`,
        );
        fotoEntregaUrl = uploaded.url;
      }
      await entregar({
        id: paquete._id,
        entregadoA: entregadoA || undefined,
        observaciones: observaciones || undefined,
        fotoEntregaUrl,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo entregar.");
      setBusy(false);
    }
  }

  return (
    <Modal
      open onClose={onClose}
      title="Confirmar entrega"
      description={`Unidad ${paquete.unidadNumero} · ${TIPO_LABEL[paquete.tipo]}`}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>Cancelar</Button>
          <Button size="sm" onClick={confirm} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Confirmar entrega
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-foreground">¿Quién recibe?</label>
          <Input value={entregadoA} onChange={(e) => setEntregadoA(e.target.value)} placeholder="Nombre (opcional)" />
        </div>
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-foreground">Observaciones de entrega</label>
          <Input value={observaciones} onChange={(e) => setObservaciones(e.target.value)} placeholder="Opcional" />
        </div>
        <div className="space-y-1.5">
          <label className="flex items-center gap-1.5 text-xs font-medium text-foreground">
            <Camera className="h-3.5 w-3.5" /> Foto de entrega (opcional)
          </label>
          <Input type="file" accept="image/*" capture="environment" onChange={(e) => setFoto(e.target.files?.[0] ?? null)} />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
    </Modal>
  );
}

function EliminarModal({ paquete, onClose }: { paquete: Paq; onClose: () => void }) {
  const eliminar = useMutation(api.guardia.eliminarPaqueteReciente);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await eliminar({ id: paquete._id });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo eliminar.");
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Eliminar registro"
      description={`Unidad ${paquete.unidadNumero} · ${TIPO_LABEL[paquete.tipo]}`}
      className="max-w-sm"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>Cancelar</Button>
          <Button variant="destructive" size="sm" onClick={confirm} disabled={busy}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} Eliminar
          </Button>
        </>
      }
    >
      <p className="text-sm text-muted-foreground">
        Se borra el registro de portería. Úsalo si se registró por error (unidad equivocada, duplicado o prueba).
      </p>
      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
    </Modal>
  );
}

function DetalleModal({
  paquete,
  onClose,
  onEliminar,
}: {
  paquete: Paq;
  onClose: () => void;
  onEliminar?: () => void;
}) {
  return (
    <Modal
      open
      onClose={onClose}
      title="Detalle del paquete"
      description={`Unidad ${paquete.unidadNumero} · ${TIPO_LABEL[paquete.tipo]}`}
      className="max-w-lg"
      footer={
        <>
          {onEliminar && (
            <Button variant="ghost" size="sm" onClick={onEliminar} className="mr-auto text-destructive hover:text-destructive">
              <Trash2 className="h-4 w-4" /> Eliminar
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onClose}>Cerrar</Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <FotoBox label="Llegada" url={paquete.fotoUrl} />
          <FotoBox label="Entrega" url={paquete.fotoEntregaUrl} />
        </div>
        <div className="space-y-1 rounded-xl bg-muted/40 p-3 text-sm">
          {paquete.remitente && <p><span className="text-muted-foreground">Remitente:</span> <span className="text-foreground">{paquete.remitente}</span></p>}
          {paquete.destinatario && <p><span className="text-muted-foreground">Destinatario:</span> <span className="text-foreground">{paquete.destinatario}</span></p>}
          {paquete.descripcion && <p><span className="text-muted-foreground">Descripción:</span> <span className="text-foreground">{paquete.descripcion}</span></p>}
          <p><span className="text-muted-foreground">Recibido:</span> <span className="text-foreground">{fmtHora(paquete.fechaRecibido)} · {paquete.recibidoPorNombre}</span></p>
          {paquete.estado === "entregado" && (
            <>
              <p><span className="text-muted-foreground">Entregado:</span> <span className="text-foreground">{fmtHora(paquete.fechaEntregado)}{paquete.entregadoPorNombre ? ` · por ${paquete.entregadoPorNombre}` : ""}</span></p>
              {paquete.entregadoANombre && <p><span className="text-muted-foreground">Recibió:</span> <span className="text-foreground">{paquete.entregadoANombre}</span></p>}
              {paquete.observacionesEntrega && <p><span className="text-muted-foreground">Obs.:</span> <span className="text-foreground">{paquete.observacionesEntrega}</span></p>}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

function FotoBox({ label, url }: { label: string; url: string | null }) {
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-muted-foreground">{label}</p>
      {url ? (
        <a href={url} target="_blank" rel="noreferrer">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt={label} className="aspect-square w-full rounded-xl object-cover ring-1 ring-border" />
        </a>
      ) : (
        <div className="flex aspect-square w-full items-center justify-center rounded-xl bg-muted text-muted-foreground">
          <ImageIcon className="h-6 w-6" />
        </div>
      )}
    </div>
  );
}
