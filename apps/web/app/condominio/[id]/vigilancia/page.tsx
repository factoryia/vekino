"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { useQuery, useMutation } from "convex/react";
import {
  AlertTriangle, BookOpenCheck, CalendarDays, Car, Check, ClipboardCheck, Download, Eye, Footprints, Loader2, Paperclip, Plus, Search, Settings2, ShieldCheck, Timer, Trash2, Users,
} from "lucide-react";
import { api } from "@vekino/backend/api";
import { EtiquetaCobertura } from "@/components/vigilancia/etiqueta-cobertura";
import type { Id, Doc } from "@vekino/backend/dataModel";
import type { FunctionReturnType } from "convex/server";
import { PageContainer } from "@/components/layout/page-container";
import { PageHeader } from "@/components/layout/page-header";
import { StatCard } from "@/components/layout/stat-card";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Input, Select } from "@/components/ui/input";
import { EtiquetaRonda } from "@/components/guardia/etiqueta-ronda";
import { TablaRondas } from "@/components/vigilancia/tabla-rondas";
import { cn } from "@/lib/utils";

type Modulo = Doc<"minutaEventos">["modulo"];

const MODULO_META: Record<Modulo, { label: string; tone: React.ComponentProps<typeof Badge>["tone"] }> = {
  visitantes: { label: "Visitantes", tone: "info" },
  paqueteria: { label: "Paquetería", tone: "neutral" },
  reservas:   { label: "Reservas", tone: "brand" },
  novedades:  { label: "Novedades", tone: "destructive" },
  minuta:     { label: "Minuta", tone: "primary" },
};

/**
 * Del día 1 del mes en curso hasta hoy.
 *
 * La sección no tenía período por defecto —las dos cifras se sacaban de listas
 * capadas—, así que se toma el mismo criterio que el reporte de reservas: un
 * rango que arranca con el mes. Hasta HOY y no hasta fin de mes porque estas
 * dos métricas cuentan lo que ya pasó; ofrecer días futuros solo añade ceros.
 */
function mesEnCurso(): { desde: string; hasta: string } {
  const hoy = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const iso = (d: Date) =>
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return {
    desde: iso(new Date(hoy.getFullYear(), hoy.getMonth(), 1)),
    hasta: iso(hoy),
  };
}

/** "2026-09-01" → "1 sep 2026", para redactar el pie de las tarjetas. */
function fmtDiaCorto(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1).toLocaleDateString("es-CO", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function fmtFechaHora(ts?: number) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("es-CO", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/**
 * LA CONFIGURACIÓN DE PORTERÍA, APAGADA A PROPÓSITO.
 *
 * Checklist de inicio de turno, zonas de ronda y motivos de vehículo están
 * implementados de punta a punta y funcionan —el guarda los consume al abrir
 * turno, al iniciar una ronda y al reportar un vehículo—, pero no se pidieron
 * para esta entrega y hoy no se muestran.
 *
 * Se apaga la PUERTA, no la funcionalidad: `ConfigTab` y sus tres paneles
 * siguen enteros justo debajo, y las mutaciones del backend siguen ahí y
 * siguen exigiendo rol de administración. Borrarlos habría obligado a
 * reescribirlos el día que se decida mostrarlos; esto es una palabra.
 *
 * Mientras esté en `false`, los conjuntos usan los valores por defecto: el
 * checklist básico de tres ítems, "Recorrido general" como zona y los cinco
 * motivos de vehículo que trae el backend. Ninguna pantalla del guarda se
 * queda vacía por esto.
 *
 * El tipo es `boolean` explícito y no el literal `false` para que el resto del
 * archivo compile igual con el interruptor en cualquiera de las dos
 * posiciones.
 */
const MOSTRAR_CONFIGURACION: boolean = false;

const TABS = [
  { key: "personal", label: "Personal", icon: Users },
  { key: "rondas", label: "Rondas", icon: Footprints },
  { key: "minuta", label: "Minuta digital", icon: BookOpenCheck },
  { key: "turnos", label: "Turnos", icon: Timer },
  { key: "novedades", label: "Novedades", icon: AlertTriangle },
  { key: "config", label: "Configuración", icon: Settings2 },
] as const;
type TabKey = (typeof TABS)[number]["key"];

/** Lo que se pinta hoy. `TABS` sigue completo para no perder el tipo. */
const TABS_VISIBLES = TABS.filter(
  (t) => t.key !== "config" || MOSTRAR_CONFIGURACION,
);

/**
 * VIGILANCIA DEL CONJUNTO.
 *
 * La portería vista desde el conjunto: quién la cubre, qué recorre y qué
 * anota. Es la contraparte de `/vigilancia/:condominioId` —la misma operación
 * mirada desde la compañía que la presta— y comparte con ella las consultas
 * (`rondas.listar`, `guardia.listMinuta`) y la tabla de rondas. Lo que cambia
 * es por dónde llega el permiso: aquí por el rol en el conjunto y allí por el
 * contrato de la empresa. En los dos casos lo resuelve el servidor exigiendo
 * `porteria.ver` sobre ESE conjunto; el id de la URL no autoriza nada.
 *
 * El conjunto sale de la ruta del shell, así que no hay selector que
 * manipular: un administrador solo puede estar dentro de su conjunto, y la
 * plataforma dentro del que abrió.
 */
export default function VigilanciaConjuntoPage() {
  const params = useParams<{ id: string }>();
  const condominioId = params.id as Id<"condominios">;
  const [tab, setTab] = useState<TabKey>("personal");

  const turnoActivo = useQuery(api.guardia.turnoActivo, { condominioId });
  const minuta = useQuery(api.guardia.listMinuta, { condominioId, limit: 200 });
  /* Quién cubre esta portería. La consulta ya existía para responder justo
   * esta pregunta desde el conjunto ("¿quién está autorizado a entrar?") y
   * trae guardas y supervisores juntos, con su compañía y su vigencia. */
  const personal = useQuery(api.asignaciones.porCondominio, { condominioId });

  const activos = (personal ?? []).filter((p) => p.estado !== "terminada");

  const [periodo, setPeriodo] = useState(mesEnCurso);
  const rangoValido = periodo.desde <= periodo.hasta;

  /* Las dos cifras del período las cuenta el SERVIDOR. Sacarlas de `minuta`
   * —que viene capada a 200 eventos— era el motivo de que el número no
   * cuadrara con nada. Con el rango al revés no se pregunta: el servidor lo
   * rechazaría y la pantalla entera se caería por un dato mal escrito. */
  const resumen = useQuery(
    api.guardia.resumenPeriodo,
    rangoValido
      ? { condominioId, desde: periodo.desde, hasta: periodo.hasta }
      : "skip",
  );

  return (
    <PageContainer>
      <div className="space-y-6">
        <PageHeader
          title="Vigilancia"
          description="Quién cubre la portería, qué recorre y qué queda anotado"
        />

        <FiltroPeriodo
          periodo={periodo}
          onChange={setPeriodo}
          valido={rangoValido}
        />

        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {/* Turno actual y Personal NO dependen del período: dicen qué pasa
              ahora mismo en la portería, no cuánto pasó en unas fechas. */}
          <StatCard
            icon={ShieldCheck}
            label="Turno actual"
            value={turnoActivo ? turnoActivo.guardiaNombre.split(" ")[0] ?? "Abierto" : "Sin turno"}
            tone={turnoActivo ? "success" : "neutral"}
          />
          <StatCard
            icon={Users}
            label="Personal asignado"
            value={activos.length}
            tone="primary"
          />
          {/* Estas dos sí. Se etiquetan "del período" para que el número no se
              lea como un total: antes decía "del turno" y contaba otra cosa. */}
          <StatCard
            icon={Footprints}
            label="Rondas del período"
            value={rangoValido ? (resumen?.rondas ?? "…") : "—"}
            tone="brand"
          />
          <StatCard
            icon={AlertTriangle}
            label="Incidentes del período"
            value={rangoValido ? (resumen?.incidentes ?? "…") : "—"}
            tone="destructive"
          />
        </div>

        <nav className="flex items-center gap-1 overflow-x-auto rounded-xl border border-border bg-card p-1">
          {TABS_VISIBLES.map((t) => {
            const Icon = t.icon;
            const active = tab === t.key;
            return (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={cn(
                  "flex flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                  active ? "bg-brand text-brand-foreground" : "text-muted-foreground hover:bg-accent",
                )}
              >
                <Icon className="h-4 w-4" /> {t.label}
              </button>
            );
          })}
        </nav>

        {tab === "personal" && <PersonalTab personal={personal} />}
        {tab === "rondas" && <RondasTab condominioId={condominioId} />}
        {tab === "minuta" && <MinutaTab minuta={minuta} />}
        {tab === "turnos" && <TurnosTab condominioId={condominioId} />}
        {tab === "novedades" && <NovedadesTab condominioId={condominioId} />}
        {tab === "config" && MOSTRAR_CONFIGURACION && (
          <ConfigTab condominioId={condominioId} />
        )}
      </div>
    </PageContainer>
  );
}

/* ───────── Filtro de período ───────── */

/**
 * Desde / Hasta para las dos métricas que cuentan hechos.
 *
 * Dos `<Input type="date">` y no un componente nuevo: es el patrón que ya usa
 * el reporte de reservas, y extraer un `<RangoFechas />` con dos usos en todo
 * el proyecto sería una abstracción antes de tiempo. Si aparece un tercero,
 * ahí sí conviene sacarlo.
 *
 * La validación va en el input (`max` en Desde, `min` en Hasta) para que el
 * calendario no deje ni escoger un rango invertido, y además se comprueba
 * arriba antes de preguntar. El servidor la repite por su cuenta: escribir la
 * fecha a mano es perfectamente posible.
 */
function FiltroPeriodo({
  periodo,
  onChange,
  valido,
}: {
  periodo: { desde: string; hasta: string };
  onChange: (p: { desde: string; hasta: string }) => void;
  valido: boolean;
}) {
  return (
    <Card className="flex flex-wrap items-end gap-4 p-4">
      <div className="space-y-1.5">
        <label
          htmlFor="vig-desde"
          className="flex items-center gap-1.5 text-[12.5px] font-medium text-foreground"
        >
          <CalendarDays className="h-3.5 w-3.5 text-brand" aria-hidden />
          Desde
        </label>
        <Input
          id="vig-desde"
          type="date"
          value={periodo.desde}
          max={periodo.hasta}
          onChange={(e) => onChange({ ...periodo, desde: e.target.value })}
        />
      </div>
      <div className="space-y-1.5">
        <label
          htmlFor="vig-hasta"
          className="block text-[12.5px] font-medium text-foreground"
        >
          Hasta
        </label>
        <Input
          id="vig-hasta"
          type="date"
          value={periodo.hasta}
          min={periodo.desde}
          onChange={(e) => onChange({ ...periodo, hasta: e.target.value })}
        />
      </div>

      <p className="min-w-[220px] flex-1 pb-2 text-[11.5px] text-muted-foreground">
        {valido ? (
          <>
            Rondas e incidentes contados entre el{" "}
            {fmtDiaCorto(periodo.desde)} y el {fmtDiaCorto(periodo.hasta)},
            ambos incluidos.
          </>
        ) : (
          <span className="text-destructive">
            La fecha inicial no puede ser posterior a la final.
          </span>
        )}
      </p>
    </Card>
  );
}

/* ───────── Personal: guardas y supervisores del conjunto ───────── */

const ROL_META = {
  supervisor: { label: "Supervisor", tone: "info" },
  guardia: { label: "Guarda", tone: "brand" },
} as const;

const TONO_VIGENCIA = {
  programada: "info",
  vigente: "success",
  terminada: "neutral",
} as const;

function fmtFecha(ms: number | null) {
  if (ms == null) return "indefinida";
  return new Date(ms).toLocaleDateString("es-CO", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

type PersonalVigilancia = FunctionReturnType<
  typeof api.asignaciones.porCondominio
>;

/**
 * Quién está autorizado a entrar a esta portería.
 *
 * Todo sale de `asignaciones.porCondominio`, que ya acota al conjunto en el
 * servidor: no hay nada que filtrar aquí. Guardas y supervisores viajan en la
 * misma respuesta porque son la misma pregunta con distinto rol; separarlos
 * en dos consultas habría duplicado la autorización.
 *
 * Se separan al PINTAR y no al pedir: el administrador quiere ver de un
 * vistazo a quién manda y quién cubre el turno.
 */
function PersonalTab({ personal }: { personal: PersonalVigilancia | undefined }) {
  if (personal === undefined) {
    return <div className="space-y-2">{[...Array(3)].map((_, i) => <Skeleton key={i} className="h-16 rounded-xl" />)}</div>;
  }

  const vigentes = personal.filter((p) => p.estado !== "terminada");
  const supervisores = vigentes.filter((p) => p.rol === "supervisor");
  const guardas = vigentes.filter((p) => p.rol === "guardia");

  if (vigentes.length === 0) {
    return (
      <EmptyState
        icon={Users}
        title="Nadie asignado a esta portería"
        description="Cuando la compañía de vigilancia asigne supervisores o guardas a tu conjunto aparecerán aquí, con la vigencia de cada uno."
      />
    );
  }

  return (
    <div className="space-y-5">
      <GrupoPersonal
        titulo="Supervisores"
        descripcion="Dirigen la operación de tu portería. No cubren turno."
        gente={supervisores}
      />
      <GrupoPersonal
        titulo="Guardas"
        descripcion="Abren turno, hacen las rondas y escriben la minuta."
        gente={guardas}
      />
    </div>
  );
}

function GrupoPersonal({
  titulo,
  descripcion,
  gente,
}: {
  titulo: string;
  descripcion: string;
  gente: PersonalVigilancia;
}) {
  return (
    <div className="space-y-2">
      <div>
        <h2 className="text-sm font-semibold text-foreground">
          {titulo}{" "}
          <span className="font-normal text-muted-foreground">
            ({gente.length})
          </span>
        </h2>
        <p className="text-[12px] text-muted-foreground">{descripcion}</p>
      </div>

      {gente.length === 0 ? (
        <Card className="p-5 text-center text-[13px] text-muted-foreground">
          Ninguno asignado en este momento.
        </Card>
      ) : (
        <Card className="divide-y divide-border p-0">
          {gente.map((p) => {
            const meta = ROL_META[p.rol];
            return (
              <div
                key={p._id}
                className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-foreground">
                      {p.nombre}
                    </span>
                    <Badge tone={meta.tone}>{meta.label}</Badge>
                  </div>
                  <p className="mt-0.5 text-[11.5px] text-muted-foreground">
                    {p.companiaNombre}
                    {/* El correo solo lo devuelve el servidor a quien
                        administra: para los demás llega en null. */}
                    {p.email ? ` · ${p.email}` : ""}
                  </p>
                </div>
                <div className="text-right">
                  <Badge tone={TONO_VIGENCIA[p.estado]}>{p.estado}</Badge>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {fmtFecha(p.vigenciaDesde)} → {fmtFecha(p.vigenciaHasta)}
                  </p>
                </div>
              </div>
            );
          })}
        </Card>
      )}
    </div>
  );
}

/* ───────── Rondas ───────── */

/**
 * El historial de recorridos. Misma consulta y misma tabla que usa la
 * compañía en `/vigilancia/:condominioId`: aquí solo cambia quién pregunta.
 */
function RondasTab({ condominioId }: { condominioId: Id<"condominios"> }) {
  const rondas = useQuery(api.rondas.listar, { condominioId, limite: 50 });
  return <TablaRondas rondas={rondas} />;
}

/* ───────── Minuta (auditoría) ───────── */
type EventoMinuta = FunctionReturnType<typeof api.guardia.listMinuta>[number];

function MinutaTab({ minuta }: { minuta: EventoMinuta[] | undefined }) {
  const [moduloFiltro, setModuloFiltro] = useState<"" | Modulo>("");
  const [buscar, setBuscar] = useState("");

  const filtrados = (minuta ?? []).filter((e) => {
    if (moduloFiltro && e.modulo !== moduloFiltro) return false;
    if (buscar.trim()) {
      const q = buscar.toLowerCase();
      return `${e.resumen} ${e.unidad} ${e.tipo} ${e.actorNombre}`.toLowerCase().includes(q);
    }
    return true;
  });

  function exportarCSV() {
    const filas = [
      ["Fecha", "Módulo", "Tipo", "Unidad", "Resumen", "Actor", "Estado"],
      ...filtrados.map((e) => [
        new Date(e.createdAt).toLocaleString("es-CO"),
        MODULO_META[e.modulo].label, e.tipo, e.unidad,
        e.resumen.replace(/"/g, '""'), e.actorNombre, e.estado,
      ]),
    ];
    const csv = filas.map((f) => f.map((c) => `"${c}"`).join(";")).join("\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "minuta-digital.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={buscar} onChange={(e) => setBuscar(e.target.value)} placeholder="Buscar en la minuta" className="pl-9" />
        </div>
        <div className="flex gap-2">
          <Select value={moduloFiltro} onChange={(e) => setModuloFiltro(e.target.value as "" | Modulo)} className="w-44">
            <option value="">Todos los módulos</option>
            {(Object.keys(MODULO_META) as Modulo[]).map((m) => (
              <option key={m} value={m}>{MODULO_META[m].label}</option>
            ))}
          </Select>
          <Button variant="outline" onClick={exportarCSV} disabled={filtrados.length === 0}>
            <Download className="h-4 w-4" /> CSV
          </Button>
        </div>
      </div>

      {minuta === undefined ? (
        <div className="space-y-2">{[...Array(5)].map((_, i) => <Skeleton key={i} className="h-14 rounded-xl" />)}</div>
      ) : filtrados.length === 0 ? (
        <EmptyState icon={BookOpenCheck} title="Minuta vacía" description="Cada acción de portería queda registrada aquí automáticamente." />
      ) : (
        <Card className="divide-y divide-border p-0">
          {filtrados.map((e) => {
            const meta = MODULO_META[e.modulo];
            return (
              <div key={e._id} className="flex items-start gap-3 px-4 py-3">
                <div className="w-24 shrink-0 pt-0.5 text-xs tabular-nums text-muted-foreground">{fmtFechaHora(e.createdAt)}</div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={meta.tone}>{meta.label}</Badge>
                    <span className="text-xs font-medium text-foreground">{e.tipo}</span>
                    {e.unidad && e.unidad !== "—" && (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{e.unidad}</span>
                    )}
                    {/* En qué recorrido ocurrió. `listMinuta` ya lo resuelve y
                        la portería y la compañía ya lo pintaban; esta vista
                        era la única que se lo callaba. */}
                    <EtiquetaRonda numero={e.rondaNumero} zona={e.rondaZona} />
                  </div>
                  <p className="mt-1 text-sm text-foreground">{e.resumen}</p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                    {e.actorNombre}
                    <EtiquetaCobertura cobertura={e.cobertura} compacta />
                  </p>
                </div>
              </div>
            );
          })}
        </Card>
      )}
    </div>
  );
}

/* ───────── Turnos (historial + detalle) ───────── */
function TurnosTab({ condominioId }: { condominioId: Id<"condominios"> }) {
  const turnos = useQuery(api.guardia.listTurnos, { condominioId });
  const [detalleId, setDetalleId] = useState<Id<"guardiaTurnos"> | null>(null);

  return (
    <div className="space-y-3">
      {turnos === undefined ? (
        <div className="space-y-2">{[...Array(4)].map((_, i) => <Skeleton key={i} className="h-16 rounded-xl" />)}</div>
      ) : turnos.length === 0 ? (
        <EmptyState icon={Timer} title="Sin turnos registrados" description="Cuando los guardias inicien turno, quedarán aquí con su checklist y rondas." />
      ) : (
        <Card className="divide-y divide-border p-0">
          {turnos.map((t) => (
            <div key={t._id} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium text-foreground">
                    {t.guardiaNombre}
                    {t.guardiaSecundarioNombre && <span className="text-muted-foreground"> + {t.guardiaSecundarioNombre}</span>}
                  </p>
                  <Badge tone={t.estado === "abierto" ? "success" : "neutral"}>{t.estado === "abierto" ? "Abierto" : "Cerrado"}</Badge>
                  <EtiquetaCobertura cobertura={t.cobertura} compacta />
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {fmtFechaHora(t.fechaInicio)} → {t.fechaCierre ? fmtFechaHora(t.fechaCierre) : "en curso"}
                  <span className="ml-2">· {t.checklistCount} checklist · {t.rondasCount} rondas</span>
                  {t.recibe && <span className="ml-2">· Recibió: {t.recibe}</span>}
                  {t.novedadesElementos && <span className="ml-2 text-amber-600">· Novedades en elementos</span>}
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={() => setDetalleId(t._id)}>
                <Eye className="h-4 w-4" /> Detalle
              </Button>
            </div>
          ))}
        </Card>
      )}

      {detalleId && <TurnoDetalleModal turnoId={detalleId} onClose={() => setDetalleId(null)} />}
    </div>
  );
}

function TurnoDetalleModal({ turnoId, onClose }: { turnoId: Id<"guardiaTurnos">; onClose: () => void }) {
  const turno = useQuery(api.guardia.getTurno, { turnoId });

  function exportarCSV() {
    if (!turno) return;
    const filas: string[][] = [
      ["Sección", "Detalle 1", "Detalle 2", "Detalle 3"],
      ["Turno", turno.guardiaNombre, fmtFechaHora(turno.fechaInicio), turno.fechaCierre ? fmtFechaHora(turno.fechaCierre) : "en curso"],
      ...(turno.guardiaSecundarioNombre ? [["Turno compartido", turno.guardiaSecundarioNombre, "", ""]] : []),
      ...(turno.consignas ? [["Consignas", turno.consignas, `Recibe: ${turno.recibe ?? ""}`, turno.observacionesCierre ?? ""]] : []),
      ...(turno.novedadesElementos !== undefined
        ? [["Novedades en elementos", turno.novedadesElementos ? "Sí" : "No", turno.novedadesElementosDetalle ?? "", turno.cerradoPorNombre ? `Cerró: ${turno.cerradoPorNombre}` : ""]]
        : []),
      ...turno.checklist.map((c) => ["Checklist", c.item, `${c.cantidadEncontrada}/${c.cantidadEsperada}`, c.estadoOk ? "OK" : `NOVEDAD ${c.observacion ?? ""}`]),
      ...turno.rondas.map((r) => ["Ronda", r.zona, fmtFechaHora(r.createdAt), r.novedad ?? "Sin novedad"]),
      ...turno.eventos.map((e) => ["Evento", `${MODULO_META[e.modulo].label} / ${e.tipo}`, fmtFechaHora(e.createdAt), e.resumen]),
    ];
    const csv = filas.map((f) => f.map((c) => `"${c.replace(/"/g, '""')}"`).join(";")).join("\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `turno-${turno.guardiaNombre.replace(/\s+/g, "-").toLowerCase()}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <Modal
      open onClose={onClose}
      title="Detalle del turno"
      className="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>Cerrar</Button>
          <Button variant="outline" size="sm" onClick={exportarCSV} disabled={!turno}>
            <Download className="h-4 w-4" /> Exportar CSV
          </Button>
        </>
      }
    >
      {turno === undefined ? (
        <Skeleton className="h-48 rounded-xl" />
      ) : turno === null ? (
        <p className="text-sm text-muted-foreground">Turno no encontrado.</p>
      ) : (
        <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
          <div className="rounded-xl bg-muted/40 p-3 text-sm">
            <p className="font-semibold text-foreground">
              {turno.guardiaNombre}
              {turno.guardiaSecundarioNombre && <span className="text-muted-foreground"> · compartido con {turno.guardiaSecundarioNombre}</span>}
            </p>
            {turno.cobertura && (
              <div className="mt-1">
                <EtiquetaCobertura cobertura={turno.cobertura} />
              </div>
            )}
            <p className="mt-0.5 text-xs text-muted-foreground">
              {fmtFechaHora(turno.fechaInicio)} → {turno.fechaCierre ? fmtFechaHora(turno.fechaCierre) : "en curso"}
            </p>
            {turno.observacionesInicio && <p className="mt-1 text-xs text-muted-foreground">Inicio: {turno.observacionesInicio}</p>}
            {turno.consignas && (
              <div className="mt-2 rounded-lg bg-card p-2 text-xs">
                <p><span className="font-medium text-foreground">Consignas:</span> {turno.consignas}</p>
                <p className="mt-0.5"><span className="font-medium text-foreground">Recibió:</span> {turno.recibe}</p>
                {/* Los cierres de antes no preguntaban por los elementos: sin
                    el dato no se dice ni "sí" ni "no". */}
                {turno.novedadesElementos !== undefined && (
                  <p className="mt-0.5">
                    <span className="font-medium text-foreground">Novedades en elementos:</span>{" "}
                    {turno.novedadesElementos ? (
                      <span className="text-red-600">{turno.novedadesElementosDetalle}</span>
                    ) : (
                      "Sin novedad"
                    )}
                  </p>
                )}
                {turno.observacionesCierre && (
                  <p className="mt-0.5">
                    <span className="font-medium text-foreground">Observaciones generales:</span>{" "}
                    <span className="text-muted-foreground">{turno.observacionesCierre}</span>
                  </p>
                )}
                {turno.cerradoPorNombre && (
                  <p className="mt-0.5 text-muted-foreground">Cerró: {turno.cerradoPorNombre}</p>
                )}
              </div>
            )}
          </div>

          <div>
            <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <ClipboardCheck className="h-3.5 w-3.5" /> Checklist de dotación
            </p>
            <div className="space-y-1.5">
              {turno.checklist.map((c, i) => (
                <div key={i} className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm">
                  <span className="text-foreground">{c.item}</span>
                  <span className="flex items-center gap-2">
                    <span className="tabular-nums text-muted-foreground">{c.cantidadEncontrada}/{c.cantidadEsperada}</span>
                    <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-semibold", c.estadoOk ? "bg-emerald-500/10 text-emerald-600" : "bg-red-500/10 text-red-600")}>
                      {c.estadoOk ? "OK" : c.observacion || "Novedad"}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div>
            <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <Footprints className="h-3.5 w-3.5" /> Rondas ({turno.rondas.length})
            </p>
            {turno.rondas.length === 0 ? (
              <p className="text-sm text-muted-foreground">Sin rondas registradas.</p>
            ) : (
              <div className="space-y-2">
                {turno.rondas.map((r) => (
                  <div key={r._id} className="rounded-lg border border-border p-3">
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-medium text-foreground">{r.zona}</span>
                      <span className="text-xs text-muted-foreground">{fmtFechaHora(r.createdAt)}</span>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">{r.novedad ?? "Sin novedad"}</p>
                    {r.fotoUrls.length > 0 && (
                      <div className="mt-2 flex gap-2 overflow-x-auto">
                        {r.fotoUrls.map((u, i) => (
                          <a key={i} href={u} target="_blank" rel="noreferrer">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={u} alt={`Ronda ${r.zona}`} className="h-16 w-16 rounded-lg object-cover ring-1 ring-border" />
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

/* ───────── Novedades (reportes del guardia) ───────── */
function NovedadesTab({ condominioId }: { condominioId: Id<"condominios"> }) {
  const reportes = useQuery(api.guardia.listNovedadReportes, { condominioId });

  const PRIORIDAD_CLS: Record<string, string> = {
    baja: "bg-slate-500/10 text-slate-600",
    media: "bg-amber-500/10 text-amber-600",
    alta: "bg-red-500/10 text-red-600",
  };

  return reportes === undefined ? (
    <div className="space-y-2">{[...Array(3)].map((_, i) => <Skeleton key={i} className="h-20 rounded-xl" />)}</div>
  ) : reportes.length === 0 ? (
    <EmptyState icon={AlertTriangle} title="Sin novedades" description="Los incidentes reportados por los guardias aparecerán aquí." />
  ) : (
    <div className="space-y-3">
      {reportes.map((n) => <NovedadCard key={n._id} n={n} cls={PRIORIDAD_CLS} />)}
    </div>
  );
}

/**
 * Una novedad vista por la administración.
 *
 * Lo que el guarda reporta desde la ronda llega aquí con la placa, la unidad
 * y las fotos. La decisión de cobrar es de la administración, no del guarda:
 * él registra lo que ve, y esa separación es la que hace que un cobro se
 * pueda sostener si el propietario reclama.
 */
function NovedadCard({
  n,
  cls,
}: {
  n: FunctionReturnType<typeof api.guardia.listNovedadReportes>[number];
  cls: Record<string, string>;
}) {
  const gestionar = useMutation(api.guardia.gestionarNovedad);
  const [busy, setBusy] = useState(false);
  const estado = n.gestion ?? "pendiente";

  async function marcar(gestion: "pendiente" | "cobrada" | "descartada") {
    setBusy(true);
    try {
      await gestionar({ novedadId: n._id, gestion });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-semibold text-foreground">{n.titulo}</p>
        <span className={cn("rounded-md px-2 py-0.5 text-[11px] font-semibold", cls[n.prioridad])}>
          {n.prioridad.toUpperCase()}
        </span>
        {estado === "cobrada" && (
          <span className="rounded-md bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-400">
            COBRADA
          </span>
        )}
        {estado === "descartada" && (
          <span className="rounded-md bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
            DESCARTADA
          </span>
        )}
      </div>

      {(n.vehiculoPlaca || n.unidades.length > 0) && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {n.vehiculoPlaca && (
            <span className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 font-mono text-[13px] font-bold tracking-wider text-foreground">
              <Car className="h-3.5 w-3.5" aria-hidden /> {n.vehiculoPlaca}
            </span>
          )}
          {n.unidades.map((u) => (
            <span key={u.unidadId} className="text-sm font-medium text-foreground">
              Casa {u.numero}
            </span>
          ))}
          {n.vehiculoPlaca && n.unidades.length === 0 && (
            <span className="text-sm text-amber-600 dark:text-amber-400">Placa no registrada</span>
          )}
          {n.vehiculoDescripcion && (
            <span className="text-xs text-muted-foreground">{n.vehiculoDescripcion}</span>
          )}
        </div>
      )}

      <p className="mt-1.5 whitespace-pre-line text-sm text-foreground">{n.descripcion}</p>

      {n.fotos && n.fotos.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-2">
          {n.fotos.map((fo) => (
            <a
              key={fo.url}
              href={fo.url}
              target="_blank"
              rel="noreferrer"
              className="block h-20 w-20 overflow-hidden rounded-lg border border-border transition-opacity hover:opacity-80"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={fo.url} alt={fo.nombre ?? "Evidencia"} className="h-full w-full object-cover" />
            </a>
          ))}
        </div>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>{n.reportadoPorNombre}</span>
        <EtiquetaCobertura cobertura={n.cobertura} compacta />
        <span>·</span>
        <span>Ocurrió {fmtFechaHora(n.ocurrioEn)}</span>
        {n.ocurrioEn !== n.createdAt && (
          <span className="text-muted-foreground/70">
            · registrada {fmtFechaHora(n.createdAt)}
          </span>
        )}
        {n.archivoUrl && (
          <a href={n.archivoUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-brand hover:underline">
            <Paperclip className="h-3 w-3" /> {n.archivoNombre ?? "Adjunto"}
          </a>
        )}
      </div>

      {/* Solo se ofrece cobrar cuando hay a quién: sin unidad no hay a quién
          pasarle el cargo, y un botón que no lleva a nada confunde más que
          ayudar. */}
      {n.unidades.length > 0 && estado === "pendiente" && (
        <div className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3">
          <Button size="sm" disabled={busy} onClick={() => marcar("cobrada")}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            Marcar cobrada a {n.unidades.length === 1
              ? `la casa ${n.unidades[0]!.numero}`
              : `${n.unidades.length} casas`}
          </Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => marcar("descartada")}>
            Descartar
          </Button>
        </div>
      )}
      {estado !== "pendiente" && (
        <button
          type="button"
          disabled={busy}
          onClick={() => marcar("pendiente")}
          className="mt-2 text-xs text-muted-foreground underline-offset-2 hover:underline"
        >
          Reabrir
        </button>
      )}
    </Card>
  );
}

/**
 * Motivos con los que el guarda puede señalar un vehículo.
 *
 * Cada conjunto cobra por cosas distintas —unos por parquear en visitantes,
 * otros ni lo miran—, así que la lista la arma la administración.
 *
 * Mientras no configure ninguno, el guarda ve una lista por defecto: un
 * desplegable vacío lo dejaría sin poder reportar, que es peor que una lista
 * genérica. Por eso aquí se ofrece traerlos y ajustarlos, en vez de obligar
 * a escribirlos desde cero.
 */
function MotivosVehiculoConfig({ condominioId }: { condominioId: Id<"condominios"> }) {
  const data = useQuery(api.guardia.listMotivosVehiculoAdmin, { condominioId });
  const create = useMutation(api.guardia.createMotivoVehiculo);
  const update = useMutation(api.guardia.updateMotivoVehiculo);
  const remove = useMutation(api.guardia.removeMotivoVehiculo);
  const sembrar = useMutation(api.guardia.sembrarMotivosVehiculo);

  const [nombre, setNombre] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const motivos = data?.motivos ?? [];
  const usandoPorDefecto = data !== undefined && motivos.length === 0;

  async function agregar() {
    if (!nombre.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await create({ condominioId, nombre });
      setNombre("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo agregar.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-5">
      <div className="mb-1 flex items-center gap-2">
        <Car className="h-4 w-4 text-brand" aria-hidden />
        <h3 className="font-semibold text-foreground">Motivos de vehículo</h3>
      </div>
      <p className="mb-4 text-sm text-muted-foreground">
        Lo que el guarda puede escoger al reportar un carro en la ronda.
      </p>

      {data === undefined ? (
        <div className="space-y-2">
          {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-10 rounded-lg" />)}
        </div>
      ) : usandoPorDefecto ? (
        <div className="rounded-xl border border-dashed border-border p-4">
          <p className="text-sm text-foreground">
            Están usándose los motivos por defecto:
          </p>
          <ul className="mt-2 space-y-1">
            {data.porDefecto.map((m) => (
              <li key={m} className="text-[13px] text-muted-foreground">· {m}</li>
            ))}
          </ul>
          <Button
            size="sm"
            className="mt-3"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await sembrar({ condominioId });
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Traerlos para poder editarlos
          </Button>
        </div>
      ) : (
        <ul className="mb-3 space-y-2">
          {motivos.map((m) => (
            <li
              key={m._id}
              className={cn(
                "flex items-center gap-2 rounded-lg border border-border px-3 py-2",
                !m.activo && "opacity-55",
              )}
            >
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                {m.nombre}
              </span>
              <button
                type="button"
                onClick={() => void update({ id: m._id, activo: !m.activo })}
                className="shrink-0 rounded-md px-2 py-0.5 text-[11px] font-semibold text-muted-foreground hover:bg-accent"
              >
                {m.activo ? "Activo" : "Oculto"}
              </button>
              <button
                type="button"
                onClick={() => void remove({ id: m._id })}
                aria-label={`Eliminar ${m.nombre}`}
                className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex gap-2">
        <Input
          value={nombre}
          onChange={(e) => setNombre(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void agregar()}
          placeholder="Ej. Parqueado sobre zona verde"
        />
        <Button size="sm" onClick={agregar} disabled={busy || !nombre.trim()}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
        </Button>
      </div>
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
      <p className="mt-2 text-[11px] text-muted-foreground">
        «Otro» siempre aparece: tiene que haber salida para lo que nadie previó.
      </p>
    </Card>
  );
}

/* ───────── Configuración (catálogos) ───────── */
function ConfigTab({ condominioId }: { condominioId: Id<"condominios"> }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <ChecklistConfig condominioId={condominioId} />
      <ZonasConfig condominioId={condominioId} />
      <MotivosVehiculoConfig condominioId={condominioId} />
    </div>
  );
}

function ChecklistConfig({ condominioId }: { condominioId: Id<"condominios"> }) {
  const items = useQuery(api.guardia.listChecklistTemplate, { condominioId });
  const create = useMutation(api.guardia.createChecklistTemplate);
  const update = useMutation(api.guardia.updateChecklistTemplate);
  const remove = useMutation(api.guardia.removeChecklistTemplate);

  const [nombre, setNombre] = useState("");
  const [cantidad, setCantidad] = useState("1");
  const [busy, setBusy] = useState(false);

  async function agregar() {
    if (!nombre.trim()) return;
    setBusy(true);
    try {
      await create({ condominioId, nombre, obligatorio: true, cantidadEsperada: Number(cantidad) || 1, orden: (items?.length ?? 0) + 1 });
      setNombre(""); setCantidad("1");
    } finally { setBusy(false); }
  }

  return (
    <Card className="p-5">
      <h3 className="mb-1 flex items-center gap-2 font-semibold text-foreground">
        <ClipboardCheck className="h-4 w-4 text-brand" /> Checklist de inicio de turno
      </h3>
      <p className="mb-3 text-xs text-muted-foreground">Dotación que el guardia verifica al recibir la portería.</p>
      <div className="mb-3 flex gap-2">
        <Input value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="Ej. Linterna" className="flex-1" />
        <Input type="number" min={1} value={cantidad} onChange={(e) => setCantidad(e.target.value)} className="w-16 text-center" aria-label="Cantidad" />
        <Button onClick={agregar} disabled={!nombre.trim() || busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
        </Button>
      </div>
      {items === undefined ? (
        <Skeleton className="h-24 rounded-xl" />
      ) : items.length === 0 ? (
        <p className="rounded-lg bg-muted/40 p-3 text-sm text-muted-foreground">Sin ítems. El guardia verá un checklist básico por defecto.</p>
      ) : (
        <div className="space-y-1.5">
          {items.map((it) => (
            <div key={it._id} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm">
              <span className={cn("flex-1", !it.activo && "text-muted-foreground line-through")}>{it.nombre}</span>
              <span className="tabular-nums text-xs text-muted-foreground">×{it.cantidadEsperada}</span>
              <button
                onClick={() => update({ id: it._id, activo: !it.activo })}
                className={cn("rounded px-2 py-0.5 text-[11px] font-semibold", it.activo ? "bg-emerald-500/10 text-emerald-600" : "bg-muted text-muted-foreground")}
              >
                {it.activo ? "Activo" : "Inactivo"}
              </button>
              <button onClick={() => remove({ id: it._id })} aria-label="Eliminar" className="rounded p-1 text-muted-foreground hover:text-red-600">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function ZonasConfig({ condominioId }: { condominioId: Id<"condominios"> }) {
  const zonas = useQuery(api.guardia.listRondaZonas, { condominioId });
  const create = useMutation(api.guardia.createRondaZona);
  const update = useMutation(api.guardia.updateRondaZona);
  const remove = useMutation(api.guardia.removeRondaZona);

  const [nombre, setNombre] = useState("");
  const [busy, setBusy] = useState(false);

  async function agregar() {
    if (!nombre.trim()) return;
    setBusy(true);
    try {
      await create({ condominioId, nombre, orden: (zonas?.length ?? 0) + 1 });
      setNombre("");
    } finally { setBusy(false); }
  }

  return (
    <Card className="p-5">
      <h3 className="mb-1 flex items-center gap-2 font-semibold text-foreground">
        <Footprints className="h-4 w-4 text-brand" /> Zonas de ronda
      </h3>
      <p className="mb-3 text-xs text-muted-foreground">Puntos de inspección para las rondas de control.</p>
      <div className="mb-3 flex gap-2">
        <Input value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="Ej. Perímetro exterior" className="flex-1" />
        <Button onClick={agregar} disabled={!nombre.trim() || busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
        </Button>
      </div>
      {zonas === undefined ? (
        <Skeleton className="h-24 rounded-xl" />
      ) : zonas.length === 0 ? (
        <p className="rounded-lg bg-muted/40 p-3 text-sm text-muted-foreground">Sin zonas. El guardia podrá escribir la zona manualmente.</p>
      ) : (
        <div className="space-y-1.5">
          {zonas.map((z) => (
            <div key={z._id} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm">
              <span className={cn("flex-1", !z.activa && "text-muted-foreground line-through")}>{z.nombre}</span>
              <button
                onClick={() => update({ id: z._id, activa: !z.activa })}
                className={cn("rounded px-2 py-0.5 text-[11px] font-semibold", z.activa ? "bg-emerald-500/10 text-emerald-600" : "bg-muted text-muted-foreground")}
              >
                {z.activa ? "Activa" : "Inactiva"}
              </button>
              <button onClick={() => remove({ id: z._id })} aria-label="Eliminar" className="rounded p-1 text-muted-foreground hover:text-red-600">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

