"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { useQuery, useMutation } from "convex/react";
import {
  PlayCircle, StopCircle, Footprints, PenLine, Loader2,
  UserCheck, Package, AlertTriangle, Search, Plus, Trash2, Camera,
  ClipboardCheck, Users, Lock,
} from "lucide-react";
import { api } from "@vekino/backend/api";
import type { Id, Doc } from "@vekino/backend/dataModel";
import { erroresCierreTurno } from "@vekino/backend/cierreTurno";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Skeleton } from "@/components/ui/skeleton";
import { Input, Select, Textarea } from "@/components/ui/input";
import { PageContainer } from "@/components/layout/page-container";
import { PageHeader } from "@/components/layout/page-header";
import { StatCard } from "@/components/layout/stat-card";
import { cn } from "@/lib/utils";
import { EtiquetaRonda } from "@/components/guardia/etiqueta-ronda";
import { useUploadToS3 } from "@/hooks/use-upload-s3";
import Link from "next/link";

type Modulo = Doc<"minutaEventos">["modulo"];

const MODULO_META: Record<Modulo, { label: string; tone: React.ComponentProps<typeof Badge>["tone"] }> = {
  visitantes: { label: "Visitantes", tone: "info" },
  paqueteria: { label: "Paquetería", tone: "neutral" },
  reservas:   { label: "Reservas", tone: "brand" },
  novedades:  { label: "Novedades", tone: "destructive" },
  minuta:     { label: "Minuta", tone: "primary" },
};

function fmtHora(ts: number) {
  return new Date(ts).toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" });
}
function fmtFechaHora(ts: number) {
  const d = new Date(ts);
  const hoy = new Date().toDateString() === d.toDateString();
  const hora = fmtHora(ts);
  return hoy ? `Hoy ${hora}` : d.toLocaleDateString("es-CO", { day: "numeric", month: "short" }) + ` ${hora}`;
}

/** Sube archivos a S3 y devuelve las URLs públicas. */
async function subirFotos(
  uploadFile: (file: File, folder: string) => Promise<{ url: string; key: string }>,
  files: File[],
  folder: string,
): Promise<string[]> {
  const urls: string[] = [];
  for (const file of files) {
    const { url } = await uploadFile(file, folder);
    urls.push(url);
  }
  return urls;
}

export default function GuardiaMinutaHome() {
  const params = useParams<{ id: string }>();
  const condominioId = params.id as Id<"condominios">;

  const turno = useQuery(api.guardia.turnoActivo, { condominioId });
  const minuta = useQuery(api.guardia.listMinuta, { condominioId, limit: 150 });

  const [modal, setModal] = useState<"iniciar" | "cerrar" | "ronda" | "nota" | null>(null);

  const eventosTurno = useMemo(
    () => (minuta ?? []).filter((e) => turno && e.turnoId === turno._id),
    [minuta, turno],
  );
  const stats = useMemo(() => ({
    visitantes: eventosTurno.filter((e) => e.modulo === "visitantes" && e.tipo === "Ingreso").length,
    paquetes: eventosTurno.filter((e) => e.modulo === "paqueteria").length,
    incidentes: eventosTurno.filter((e) => e.modulo === "novedades").length,
    rondas: turno?.rondasCount ?? 0,
  }), [eventosTurno, turno]);

  return (
    <PageContainer>
      <div className="space-y-6">
        <PageHeader
          title="Minuta digital"
          description="Control de turno y bitácora de portería"
          action={
            turno ? (
              <>
                <Button variant="outline" size="sm" onClick={() => setModal("nota")}>
                  <PenLine className="h-4 w-4" /> Anotación
                </Button>
                {/* Al módulo de rondas, no al modal viejo: ese creaba un
                    apunte sin principio ni fin, y quien lo abría buscando
                    dónde registrar dentro de la ronda no lo encontraba. */}
                <Button variant="outline" size="sm" asChild>
                  <Link href={`/guardia/${condominioId}/rondas`}>
                    <Footprints className="h-4 w-4" /> Rondas
                  </Link>
                </Button>
                <Button size="sm" variant="destructive" onClick={() => setModal("cerrar")}>
                  <StopCircle className="h-4 w-4" /> Cerrar turno
                </Button>
              </>
            ) : undefined
          }
        />

      {/* Estado del turno */}
      {turno === undefined ? (
        <Skeleton className="h-28 rounded-2xl" />
      ) : turno === null ? (
        <Card className="flex flex-col items-center gap-3 border-dashed p-8 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand/10 text-brand">
            <PlayCircle className="h-7 w-7" />
          </div>
          <div>
            <p className="text-lg font-semibold text-foreground">No hay turno abierto</p>
            <p className="mx-auto max-w-md text-sm text-muted-foreground">
              Inicia tu turno con el checklist de dotación para habilitar la minuta, las rondas y el control de portería.
            </p>
          </div>
          <Button onClick={() => setModal("iniciar")}>
            <PlayCircle className="h-4 w-4" /> Iniciar turno
          </Button>
        </Card>
      ) : (
        <>
          <Card className="p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <span className="relative flex h-3 w-3">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                  <span className="relative inline-flex h-3 w-3 rounded-full bg-emerald-500" />
                </span>
                <div>
                  <p className="font-semibold text-foreground">
                    Turno de {turno.guardiaNombre}
                    {turno.guardiaSecundarioNombre && <span className="text-muted-foreground"> · con {turno.guardiaSecundarioNombre}</span>}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Inició {fmtFechaHora(turno.fechaInicio)} · Checklist {turno.checklist.length} ítems
                    {turno.checklist.some((c) => !c.estadoOk) && (
                      <span className="ml-1 text-amber-600">· con novedades en dotación</span>
                    )}
                  </p>
                </div>
              </div>
            </div>
          </Card>

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <StatCard icon={UserCheck} label="Visitantes" value={stats.visitantes} tone="primary" />
            <StatCard icon={Package} label="Paquetes" value={stats.paquetes} tone="neutral" />
            <StatCard icon={Footprints} label="Rondas" value={stats.rondas} tone="brand" />
            <StatCard icon={AlertTriangle} label="Incidentes" value={stats.incidentes} tone="warning" />
          </div>
        </>
      )}

      {/* Minuta */}
      {turno === null ? (
        <Card className="flex items-center gap-3 p-5 text-sm text-muted-foreground">
          <Lock className="h-4 w-4 shrink-0" />
          La minuta se habilita al iniciar turno. Los registros anteriores quedan disponibles para la administración.
        </Card>
      ) : (
        <MinutaTable minuta={minuta} />
      )}

      {modal === "iniciar" && <IniciarTurnoModal condominioId={condominioId} onClose={() => setModal(null)} />}
      {modal === "cerrar" && turno && (
        <CerrarTurnoModal turno={turno} stats={stats} onClose={() => setModal(null)} />
      )}
      {modal === "nota" && <NotaModal condominioId={condominioId} onClose={() => setModal(null)} />}
      </div>
    </PageContainer>
  );
}

/* ───────── Tabla de minuta con filtros ───────── */
/* El evento de minuta más el número de ronda que le calcula la consulta: el
   documento crudo no lo trae, porque la ronda se resuelve al leer. */
type EventoMinuta = Doc<"minutaEventos"> & { rondaNumero?: number | null };

function MinutaTable({ minuta }: { minuta: EventoMinuta[] | undefined }) {
  const [moduloFiltro, setModuloFiltro] = useState<"" | Modulo>("");
  const [unidadFiltro, setUnidadFiltro] = useState("");
  const [buscar, setBuscar] = useState("");

  const filtrados = (minuta ?? []).filter((e) => {
    if (moduloFiltro && e.modulo !== moduloFiltro) return false;
    if (unidadFiltro.trim() && !e.unidad.toLowerCase().includes(unidadFiltro.trim().toLowerCase())) return false;
    if (buscar.trim()) {
      const q = buscar.toLowerCase();
      return `${e.resumen} ${e.unidad} ${e.tipo} ${e.actorNombre}`.toLowerCase().includes(q);
    }
    return true;
  });

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={buscar} onChange={(e) => setBuscar(e.target.value)} placeholder="Buscar en la minuta" className="pl-9" />
        </div>
        <div className="flex gap-2">
          <Select value={moduloFiltro} onChange={(e) => setModuloFiltro(e.target.value as "" | Modulo)} className="w-40">
            <option value="">Todos los módulos</option>
            {(Object.keys(MODULO_META) as Modulo[]).map((m) => (
              <option key={m} value={m}>{MODULO_META[m].label}</option>
            ))}
          </Select>
          <Input value={unidadFiltro} onChange={(e) => setUnidadFiltro(e.target.value)} placeholder="Unidad" className="w-28" />
        </div>
      </div>

      {minuta === undefined ? (
        <div className="space-y-2">{[...Array(5)].map((_, i) => <Skeleton key={i} className="h-16 rounded-xl" />)}</div>
      ) : filtrados.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">
          {minuta.length === 0 ? "La minuta está vacía. Cada acción de portería quedará registrada aquí." : "Sin resultados con los filtros."}
        </Card>
      ) : (
        <Card className="divide-y divide-border p-0">
          {filtrados.map((e) => {
            const meta = MODULO_META[e.modulo];
            return (
              <div key={e._id} className="flex items-start gap-3 px-4 py-3">
                <div className="w-16 shrink-0 pt-0.5 text-xs tabular-nums text-muted-foreground">{fmtFechaHora(e.createdAt).replace("Hoy ", "")}</div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={meta.tone}>{meta.label}</Badge>
                    <span className="text-xs font-medium text-foreground">{e.tipo}</span>
                    {e.unidad && e.unidad !== "—" && (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{e.unidad}</span>
                    )}
                    {/* Durante qué recorrido pasó. Se guardaba pero no se
                        veía, y sin eso tener rondas no sirve de nada. */}
                    <EtiquetaRonda numero={e.rondaNumero} />
                    <span className={cn(
                      "ml-auto rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase",
                      e.estado === "abierto" ? "bg-emerald-500/10 text-emerald-600" : "bg-muted text-muted-foreground",
                    )}>
                      {e.estado}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-foreground">{e.resumen}</p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">{e.actorNombre}</p>
                </div>
              </div>
            );
          })}
        </Card>
      )}
    </div>
  );
}

/* ───────── Iniciar turno (checklist de dotación) ───────── */
type ChecklistRow = {
  item: string; obligatorio: boolean; cantidadEsperada: number;
  cantidadEncontrada: number; estadoOk: boolean; observacion: string;
};

function IniciarTurnoModal({ condominioId, onClose }: { condominioId: Id<"condominios">; onClose: () => void }) {
  const template = useQuery(api.guardia.listChecklistTemplate, { condominioId });
  const iniciar = useMutation(api.guardia.iniciarTurno);

  const [rows, setRows] = useState<ChecklistRow[] | null>(null);
  const [quienTurno, setQuienTurno] = useState("");
  const [companero, setCompanero] = useState("");
  const [observaciones, setObservaciones] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pre-carga del checklist desde la plantilla activa (una sola vez).
  useEffect(() => {
    if (rows !== null || template === undefined) return;
    const activos = template.filter((t) => t.activo);
    setRows(
      activos.length > 0
        ? activos.map((t) => ({
            item: t.nombre, obligatorio: t.obligatorio, cantidadEsperada: t.cantidadEsperada,
            cantidadEncontrada: t.cantidadEsperada, estadoOk: true, observacion: "",
          }))
        : [
            { item: "Radio de comunicación", obligatorio: true, cantidadEsperada: 1, cantidadEncontrada: 1, estadoOk: true, observacion: "" },
            { item: "Linterna", obligatorio: true, cantidadEsperada: 1, cantidadEncontrada: 1, estadoOk: true, observacion: "" },
            { item: "Llaves de portería", obligatorio: true, cantidadEsperada: 1, cantidadEncontrada: 1, estadoOk: true, observacion: "" },
          ],
    );
  }, [rows, template]);

  function setRow(i: number, patch: Partial<ChecklistRow>) {
    setRows((prev) => (prev ?? []).map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  async function confirmar() {
    if (!rows || rows.length === 0) return;
    if (!quienTurno.trim()) {
      setError("Escribe el nombre de quien toma el turno.");
      return;
    }
    setBusy(true); setError(null);
    try {
      await iniciar({
        condominioId,
        checklist: rows
          .filter((r) => r.item.trim())
          .map((r) => ({
            item: r.item, obligatorio: r.obligatorio, cantidadEsperada: r.cantidadEsperada,
            cantidadEncontrada: r.cantidadEncontrada, estadoOk: r.estadoOk,
            observacion: r.observacion || undefined,
          })),
        observacionesInicio: observaciones || undefined,
        guardiaNombre: quienTurno.trim(),
        guardiaSecundarioNombre: companero.trim() || undefined,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo iniciar el turno.");
      setBusy(false);
    }
  }

  return (
    <Modal
      open onClose={onClose}
      title="Iniciar turno"
      description="Verifica la dotación de portería antes de recibir el turno"
      className="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>Cancelar</Button>
          <Button
            size="sm"
            onClick={confirmar}
            disabled={busy || !rows || rows.length === 0 || !quienTurno.trim()}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ClipboardCheck className="h-4 w-4" />}
            Iniciar turno
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="space-y-1.5">
          <label className="flex items-center gap-1.5 text-xs font-medium text-foreground">
            <Users className="h-3.5 w-3.5" /> Quién toma el turno
          </label>
          <Input
            value={quienTurno}
            onChange={(e) => setQuienTurno(e.target.value)}
            placeholder="Tu nombre completo"
            autoFocus
          />
          <p className="text-[11px] text-muted-foreground">
            La cuenta es compartida: escribe tu nombre para la minuta.
          </p>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Checklist de dotación</p>
          {rows === null ? (
            <Skeleton className="h-24 rounded-xl" />
          ) : (
            <div className="space-y-2">
              {rows.map((r, i) => (
                <div key={i} className="rounded-xl border border-border p-3">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setRow(i, { estadoOk: !r.estadoOk })}
                      className={cn(
                        "flex h-6 w-11 shrink-0 items-center rounded-full p-0.5 transition-colors",
                        r.estadoOk ? "justify-end bg-emerald-500" : "justify-start bg-red-400",
                      )}
                      aria-label={r.estadoOk ? "OK" : "Novedad"}
                    >
                      <span className="h-5 w-5 rounded-full bg-white shadow" />
                    </button>
                    <Input
                      value={r.item}
                      onChange={(e) => setRow(i, { item: e.target.value })}
                      className="h-9 flex-1"
                      placeholder="Ítem"
                    />
                    <Input
                      type="number" min={0}
                      value={r.cantidadEncontrada}
                      onChange={(e) => setRow(i, { cantidadEncontrada: Math.max(0, Number(e.target.value)) })}
                      className="h-9 w-16 text-center"
                      aria-label="Cantidad encontrada"
                    />
                    <span className="text-xs text-muted-foreground">/ {r.cantidadEsperada}</span>
                    <button
                      onClick={() => setRows((prev) => (prev ?? []).filter((_, idx) => idx !== i))}
                      className="rounded p-1.5 text-muted-foreground hover:text-red-600"
                      aria-label="Quitar ítem"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                  {!r.estadoOk && (
                    <Input
                      value={r.observacion}
                      onChange={(e) => setRow(i, { observacion: e.target.value })}
                      placeholder="¿Qué novedad tiene este ítem?"
                      className="mt-2 h-9"
                    />
                  )}
                </div>
              ))}
              <Button
                variant="outline" size="sm"
                onClick={() => setRows((prev) => [...(prev ?? []), { item: "", obligatorio: false, cantidadEsperada: 1, cantidadEncontrada: 1, estadoOk: true, observacion: "" }])}
              >
                <Plus className="h-4 w-4" /> Agregar ítem
              </Button>
            </div>
          )}
        </div>

        <div className="space-y-1.5">
          <label className="flex items-center gap-1.5 text-xs font-medium text-foreground">
            Compañero de turno (opcional)
          </label>
          <Input
            value={companero}
            onChange={(e) => setCompanero(e.target.value)}
            placeholder="Nombre del segundo guardia, si aplica"
          />
        </div>

        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-foreground">Observaciones iniciales (opcional)</label>
          <Textarea value={observaciones} onChange={(e) => setObservaciones(e.target.value)} rows={2} placeholder="Cómo recibes la portería…" />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
    </Modal>
  );
}

/* ───────── Cerrar turno (entrega formal) ───────── */
/** Valor del selector de relevo para escribir el nombre a mano. */
const RELEVO_OTRO = "__otro__";

function CerrarTurnoModal({
  turno, stats, onClose,
}: {
  turno: Doc<"guardiaTurnos"> & { rondasCount: number };
  stats: { visitantes: number; paquetes: number; incidentes: number; rondas: number };
  onClose: () => void;
}) {
  const cerrar = useMutation(api.guardia.cerrarTurno);
  const equipo = useQuery(api.guardia.equipo, { condominioId: turno.condominioId });
  const [hayNovedades, setHayNovedades] = useState(false);
  const [detalleNovedades, setDetalleNovedades] = useState("");
  const [relevo, setRelevo] = useState("");
  const [relevoManual, setRelevoManual] = useState("");
  const [consignas, setConsignas] = useState("");
  const [obs, setObs] = useState("");
  const [intentado, setIntentado] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* Quien entrega no se ofrece como relevo: ni el que abrió ni su compañero. */
  const opciones = (equipo ?? []).filter(
    (g) => g.userId !== turno.guardiaUserId && g.userId !== turno.guardiaSecundarioUserId,
  );
  /* Cuenta compartida o portería sin más usuarios: el relevo se escribe. */
  const manual = relevo === RELEVO_OTRO || (equipo !== undefined && opciones.length === 0);
  const recibeNombre = manual
    ? relevoManual
    : opciones.find((g) => g.userId === relevo)?.nombre ?? "";
  const elementos = turno.checklist;

  const errores = erroresCierreTurno({
    consignas,
    recibe: recibeNombre,
    observacionesCierre: obs,
    novedadesElementos: hayNovedades,
    novedadesElementosDetalle: detalleNovedades,
    elementosAsignados: elementos.length,
  });
  const mostrar = (campo: keyof typeof errores) => (intentado ? errores[campo] : undefined);

  async function confirmar() {
    setIntentado(true);
    if (Object.keys(errores).length > 0) return;
    setBusy(true); setError(null);
    try {
      await cerrar({
        turnoId: turno._id,
        ...(manual ? { recibe: relevoManual } : { recibeUserId: relevo as Id<"users"> }),
        consignas,
        observacionesCierre: obs,
        novedadesElementos: hayNovedades,
        novedadesElementosDetalle: hayNovedades ? detalleNovedades : undefined,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo cerrar el turno.");
      setBusy(false);
    }
  }

  return (
    <Modal
      open onClose={onClose}
      title="Cierre formal de turno"
      description="Entrega la portería, sus elementos y las consignas al relevo"
      className="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>Cancelar</Button>
          <Button variant="destructive" size="sm" onClick={confirmar} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <StopCircle className="h-4 w-4" />}
            Cerrar turno
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-4 gap-2 rounded-xl bg-muted/40 p-3 text-center">
          {[["Visitantes", stats.visitantes], ["Paquetes", stats.paquetes], ["Rondas", stats.rondas], ["Incidentes", stats.incidentes]].map(([l, vNum]) => (
            <div key={l as string}>
              <p className="text-lg font-bold tabular-nums text-foreground">{vNum as number}</p>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{l as string}</p>
            </div>
          ))}
        </div>
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-foreground">Entrega el turno</label>
          <Input value={turno.guardiaNombre} disabled className="bg-muted/40" />
        </div>

        {/* Los elementos son los que se firmaron al iniciar: aquí solo se leen. */}
        <div className="space-y-2">
          <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <Lock className="h-3.5 w-3.5" /> Elementos asignados
          </p>
          {elementos.length === 0 ? (
            <p className="rounded-lg bg-muted/40 p-3 text-sm text-muted-foreground">
              Este turno no registró elementos al iniciar.
            </p>
          ) : (
            <ul className="divide-y divide-border rounded-xl border border-border">
              {elementos.map((c, i) => (
                <li key={i} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                  <span className="min-w-0 text-foreground">{c.item}</span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="tabular-nums text-muted-foreground">{c.cantidadEncontrada}/{c.cantidadEsperada}</span>
                    {!c.estadoOk && (
                      <span className="max-w-48 truncate rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-700" title={c.observacion}>
                        Al recibir: {c.observacion || "con novedad"}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="text-[11px] text-muted-foreground">
            Registrados al iniciar el turno. No se modifican al cerrarlo.
          </p>
        </div>

        {elementos.length > 0 && (
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm font-medium text-foreground">
              <input
                type="checkbox"
                checked={hayNovedades}
                onChange={(e) => setHayNovedades(e.target.checked)}
                className="h-4 w-4 rounded border-border accent-brand"
              />
              ¿Existen novedades con los elementos asignados?
            </label>
            {hayNovedades && (
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-foreground">Detalle de la novedad *</label>
                <Textarea
                  value={detalleNovedades}
                  onChange={(e) => setDetalleNovedades(e.target.value)}
                  rows={3}
                  placeholder="Ej. La linterna presenta daño en el interruptor y el radio tiene la batería descargada."
                  aria-invalid={!!mostrar("novedadesElementosDetalle")}
                  autoFocus
                />
                <CampoError mensaje={mostrar("novedadesElementosDetalle")} />
              </div>
            )}
            <CampoError mensaje={mostrar("novedadesElementos")} />
          </div>
        )}

        <div className="space-y-1.5">
          <label className="flex items-center gap-1.5 text-xs font-medium text-foreground">
            <Users className="h-3.5 w-3.5" /> Guarda que recibe el turno *
          </label>
          {equipo === undefined ? (
            <Skeleton className="h-10 rounded-lg" />
          ) : opciones.length > 0 ? (
            <Select value={relevo} onChange={(e) => setRelevo(e.target.value)} aria-invalid={!!mostrar("recibe") && !manual}>
              <option value="">Selecciona el guarda…</option>
              {opciones.map((g) => <option key={g.userId} value={g.userId}>{g.nombre}</option>)}
              <option value={RELEVO_OTRO}>Otro guarda (escribir nombre)</option>
            </Select>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              No hay otros guardas registrados en esta portería: escribe el nombre del relevo.
            </p>
          )}
          {manual && (
            <Input
              value={relevoManual}
              onChange={(e) => setRelevoManual(e.target.value)}
              placeholder="Nombre de quien recibe el turno"
              aria-invalid={!!mostrar("recibe")}
            />
          )}
          <CampoError mensaje={mostrar("recibe")} />
        </div>

        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-foreground">Consignas / pendientes para el relevo *</label>
          <Textarea
            value={consignas}
            onChange={(e) => setConsignas(e.target.value)}
            rows={3}
            placeholder="Qué queda pendiente, llaves, paquetes por entregar…"
            aria-invalid={!!mostrar("consignas")}
          />
          <CampoError mensaje={mostrar("consignas")} />
        </div>

        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-foreground">Observaciones generales del cierre *</label>
          <Textarea
            value={obs}
            onChange={(e) => setObs(e.target.value)}
            rows={3}
            placeholder="Ej. Turno finalizado sin novedades adicionales. Se entrega puesto, documentación y elementos al guarda de relevo."
            aria-invalid={!!mostrar("observacionesCierre")}
          />
          <CampoError mensaje={mostrar("observacionesCierre")} />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
    </Modal>
  );
}

function CampoError({ mensaje }: { mensaje?: string }) {
  if (!mensaje) return null;
  return <p className="text-xs text-destructive">{mensaje}</p>;
}

/* ───────── Registrar ronda ───────── */
function RondaModal({ condominioId, onClose }: { condominioId: Id<"condominios">; onClose: () => void }) {
  const zonas = useQuery(api.guardia.listRondaZonas, { condominioId });
  const registrar = useMutation(api.guardia.registrarRonda);
  const uploadFile = useUploadToS3();

  const [zonaId, setZonaId] = useState("");
  const [zonaNombre, setZonaNombre] = useState("");
  const [novedad, setNovedad] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const zonasActivas = (zonas ?? []).filter((z) => z.activa);
  const valido = zonaId !== "" || zonaNombre.trim().length > 0;

  async function confirmar() {
    if (!valido) return;
    setBusy(true); setError(null);
    try {
      const fotos = await subirFotos(
        uploadFile,
        files.slice(0, 5),
        `condominios/guardia/${condominioId}/rondas`,
      );
      await registrar({
        condominioId,
        zonaId: zonaId ? (zonaId as Id<"guardiaRondaZonas">) : undefined,
        zonaNombre: zonaId ? undefined : zonaNombre,
        novedad: novedad || undefined,
        fotos,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo registrar la ronda.");
      setBusy(false);
    }
  }

  return (
    <Modal
      open onClose={onClose}
      title="Registrar ronda"
      description="Inspección de zona con evidencia fotográfica"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>Cancelar</Button>
          <Button size="sm" onClick={confirmar} disabled={!valido || busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Footprints className="h-4 w-4" />}
            Registrar ronda
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-foreground">Zona *</label>
          {zonasActivas.length > 0 ? (
            <Select value={zonaId} onChange={(e) => setZonaId(e.target.value)}>
              <option value="">Selecciona la zona…</option>
              {zonasActivas.map((z) => <option key={z._id} value={z._id}>{z.nombre}</option>)}
            </Select>
          ) : (
            <Input value={zonaNombre} onChange={(e) => setZonaNombre(e.target.value)} placeholder="Ej. Perímetro exterior" />
          )}
        </div>
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-foreground">Novedades de la ronda</label>
          <Textarea value={novedad} onChange={(e) => setNovedad(e.target.value)} rows={3} placeholder="Sin novedad / describe lo encontrado…" />
        </div>
        <div className="space-y-1.5">
          <label className="flex items-center gap-1.5 text-xs font-medium text-foreground">
            <Camera className="h-3.5 w-3.5" /> Fotos (máx. 5)
          </label>
          <Input
            type="file" accept="image/*" multiple
            onChange={(e) => setFiles(Array.from(e.target.files ?? []).slice(0, 5))}
          />
          {files.length > 0 && <p className="text-[11px] text-muted-foreground">{files.length} foto{files.length !== 1 ? "s" : ""} seleccionada{files.length !== 1 ? "s" : ""}</p>}
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
    </Modal>
  );
}

/* ───────── Anotación manual ───────── */
function NotaModal({ condominioId, onClose }: { condominioId: Id<"condominios">; onClose: () => void }) {
  const registrar = useMutation(api.guardia.registrarEventoMinuta);
  const [tipo, setTipo] = useState("Anotación");
  const [unidad, setUnidad] = useState("");
  const [resumen, setResumen] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirmar() {
    if (!resumen.trim()) return;
    setBusy(true); setError(null);
    try {
      await registrar({ condominioId, tipo, unidad: unidad || undefined, resumen });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo registrar.");
      setBusy(false);
    }
  }

  return (
    <Modal
      open onClose={onClose}
      title="Anotación en la minuta"
      description="Registro manual en la bitácora del turno"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>Cancelar</Button>
          <Button size="sm" onClick={confirmar} disabled={!resumen.trim() || busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <PenLine className="h-4 w-4" />}
            Registrar
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-foreground">Tipo</label>
            <Input value={tipo} onChange={(e) => setTipo(e.target.value)} placeholder="Anotación" />
          </div>
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-foreground">Unidad (opcional)</label>
            <Input value={unidad} onChange={(e) => setUnidad(e.target.value)} placeholder="Ej. 409" />
          </div>
        </div>
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-foreground">Detalle *</label>
          <Textarea value={resumen} onChange={(e) => setResumen(e.target.value)} rows={3} placeholder="Qué pasó…" />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
    </Modal>
  );
}
