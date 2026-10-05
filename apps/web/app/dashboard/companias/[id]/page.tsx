"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useQuery, useMutation, useAction } from "convex/react";
import {
  ShieldCheck,
  ArrowLeft,
  Users,
  FileText,
  UserPlus,
  Plus,
  UserMinus,
  CalendarOff,
  BookOpenCheck,
  Archive,
  ArchiveRestore,
  Pencil,
  Boxes,
  CalendarX,
  CalendarClock,
  CalendarCheck,
  ArrowLeftRight,
} from "lucide-react";
import { api } from "@vekino/backend/api";
import type { Id } from "@vekino/backend/dataModel";
import { PageContainer } from "@/components/layout/page-container";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Input, Select } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorBoundary, ErrorMessage } from "@/components/ui/error-boundary";
import { cn } from "@/lib/utils";
import { EstadoBadge, Campo } from "../page";
import { EditarPersonaDialog } from "@/components/companias/editar-persona-dialog";
import { PanelInventario } from "@/components/companias/inventario/panel-inventario";
import { PanelInasistencias } from "@/components/companias/inasistencias/panel-inasistencias";
import { PanelHorarios } from "@/components/companias/horarios/panel-horarios";
import { PanelDisponibilidad } from "@/components/companias/disponibilidad/panel-disponibilidad";
import { PanelCoberturas } from "@/components/companias/coberturas/panel-coberturas";

type Estado = "activa" | "suspendida" | "inactiva";
type RolCompania = "admin_compania" | "supervisor" | "guardia";
type RolAsignacion = "supervisor" | "guardia";

const ETIQUETA_ROL: Record<RolCompania, string> = {
  admin_compania: "Administrador",
  supervisor: "Supervisor",
  guardia: "Guarda",
};

/**
 * `<input type="date">` → milisegundos de la medianoche local.
 *
 * Pendiente técnico heredado, anterior al módulo de horarios y coberturas: la
 * medianoche es la del NAVEGADOR, no la de Colombia, así que un contrato o una
 * asignación cargados desde otra zona horaria empiezan unas horas corridos.
 * Los formularios del módulo (horarios, inasistencias, coberturas) mandan el
 * texto de pared y el servidor lo interpreta en hora de Colombia; aquí no se
 * cambió para no alterar vigencias ya guardadas.
 */
function fechaAMs(valor: string): number {
  const [a, m, d] = valor.split("-").map(Number);
  return new Date(a ?? 1970, (m ?? 1) - 1, d ?? 1).getTime();
}

/** Milisegundos → `yyyy-mm-dd` local, para rellenar el input. */
function msAFecha(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function fmt(ms: number | null): string {
  if (ms == null) return "indefinido";
  return new Date(ms).toLocaleDateString("es-CO", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

const TONO_VIGENCIA = {
  vigente: "success",
  programada: "info",
  terminada: "neutral",
} as const;

export default function CompaniaDetallePage() {
  return (
    <Suspense fallback={<PageContainer><p className="text-sm text-muted-foreground">Cargando…</p></PageContainer>}>
      <CompaniaDetalleContent />
    </Suspense>
  );
}

function CompaniaDetalleContent() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const search = useSearchParams();
  const companiaId = params.id as Id<"companiasSeguridad">;
  const data = useQuery(api.companias.detail, { companiaId });
  const me = useQuery(api.users.me);
  const requestedTab = search.get("tab");
  const tab =
    requestedTab === "contratos" ||
    requestedTab === "inventario" ||
    requestedTab === "inasistencias" ||
    requestedTab === "horarios" ||
    requestedTab === "disponibilidad" ||
    requestedTab === "coberturas"
      ? requestedTab
      : "personal";
  function setTab(
    next:
      | "personal"
      | "contratos"
      | "inventario"
      | "inasistencias"
      | "horarios"
      | "disponibilidad"
      | "coberturas",
  ) {
    router.push(`/dashboard/companias/${companiaId}?tab=${next}`, { scroll: false });
  }

  /* Firmar contratos y suspender la empresa son decisiones comerciales del
   * SaaS, no de la compañía: `crearContrato` y `setEstado` exigen plataforma
   * en el backend. Mostrarle esos controles al administrador de la compañía
   * solo le ofrecería botones que terminan en un error. */
  const esPlataforma =
    me?.platformRole === "superadmin" || me?.platformRole === "admin";

  /* El inventario es SOLO del administrador de la compania (y de la
   * plataforma). `companias.detail` deja entrar tambien al supervisor con
   * asignacion vigente, y a ese las consultas del inventario le responden con
   * un error de permiso: sin ocultarle la pestana, el primer clic le tumbaba
   * la pagina entera y perdia tambien Personal y Conjuntos. */
  const puedeInventario =
    esPlataforma || me?.compania?.roles?.includes("admin_compania") === true;

  /* La planificación del personal —inasistencias y horarios— la lleva el
   * administrador para toda la compañía y el supervisor para los guardas de
   * sus conjuntos. Qué ve cada uno lo decide el servidor; aquí solo se ocultan
   * las pestañas a quien no tiene ninguna de las dos cosas. */
  const puedePlanificar =
    esPlataforma ||
    me?.compania?.roles?.includes("admin_compania") === true ||
    me?.compania?.roles?.includes("supervisor") === true;

  if (data === undefined) {
    return (
      <PageContainer>
        <p className="text-sm text-muted-foreground">Cargando…</p>
      </PageContainer>
    );
  }
  if (data === null) {
    return (
      <PageContainer>
        <p className="text-sm text-muted-foreground">
          Esa compañía no existe o fue eliminada.
        </p>
      </PageContainer>
    );
  }

  const { compania, personal, contratos } = data;

  /* Los conjuntos donde se puede planificar un horario: los de sus contratos
   * no archivados. Para el supervisor `detail` ya los trae acotados a los que
   * supervisa, que es la misma regla que aplica el servidor al registrar. */
  const conjuntosPlanificables = [
    ...new Map(
      contratos
        .filter((c) => !c.archivado)
        .map((c) => [
          c.condominioId,
          { condominioId: c.condominioId, condominioNombre: c.condominioNombre },
        ]),
    ).values(),
  ].sort((a, b) => a.condominioNombre.localeCompare(b.condominioNombre, "es"));

  /* Los conjuntos a los que se puede mandar una cobertura: los de contratos
   * vigentes hoy, con el contrato que los respalda. El servidor exige además
   * que el contrato cubra toda la ventana. */
  const contratosParaCubrir = contratos
    .filter((c) => c.estado === "vigente" && !c.archivado)
    .map((c) => ({
      contratoId: c._id,
      condominioId: c.condominioId,
      condominioNombre: c.condominioNombre,
    }))
    .sort((a, b) => a.condominioNombre.localeCompare(b.condominioNombre, "es"));

  /* Inhabilitar una cobertura es del administrador (o de la plataforma). */
  const puedeInhabilitarCoberturas =
    esPlataforma || me?.compania?.roles?.includes("admin_compania") === true;

  return (
    <PageContainer>
      <div className="space-y-6">
        <Link
          href={esPlataforma ? "/dashboard/companias" : "/vigilancia"}
          className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          {esPlataforma ? "Compañías" : "Mis conjuntos"}
        </Link>

        <Cabecera compania={compania} esPlataforma={esPlataforma} />

        <div className="flex gap-1 overflow-x-auto border-b border-border">
          <Tab
            activo={tab === "personal"}
            onClick={() => setTab("personal")}
            icon={Users}
            label="Personal"
            n={personal.filter((p) => p.isActive).length}
          />
          <Tab
            activo={tab === "contratos"}
            onClick={() => setTab("contratos")}
            icon={FileText}
            label="Contratos"
            n={contratos.filter((c) => c.estado === "vigente").length}
          />
          {/* El inventario es de la EMPRESA, no de ninguno de sus conjuntos:
              por eso vive aqui y no en la ficha de un contrato. Su conteo lo
              pide el propio panel — meterlo en `companias.detail` obligaria a
              leer el inventario entero en cada carga de esta pagina. */}
          {puedeInventario && (
            <TabSimple
              activo={tab === "inventario"}
              onClick={() => setTab("inventario")}
              icon={Boxes}
              label="Inventario"
            />
          )}
          {puedePlanificar && (
            <TabSimple
              activo={tab === "inasistencias"}
              onClick={() => setTab("inasistencias")}
              icon={CalendarX}
              label="Inasistencias"
            />
          )}
          {puedePlanificar && (
            <TabSimple
              activo={tab === "horarios"}
              onClick={() => setTab("horarios")}
              icon={CalendarClock}
              label="Horarios"
            />
          )}
          {puedePlanificar && (
            <TabSimple
              activo={tab === "disponibilidad"}
              onClick={() => setTab("disponibilidad")}
              icon={CalendarCheck}
              label="Disponibilidad"
            />
          )}
          {puedePlanificar && (
            <TabSimple
              activo={tab === "coberturas"}
              onClick={() => setTab("coberturas")}
              icon={ArrowLeftRight}
              label="Coberturas"
            />
          )}
        </div>

        {tab === "personal" && (
          <PanelPersonal companiaId={companiaId} personal={personal} />
        )}
        {tab === "contratos" && (
          <PanelContratos
            companiaId={companiaId}
            contratos={contratos}
            personal={personal}
            esPlataforma={esPlataforma}
            companiaActiva={compania.estado === "activa"}
          />
        )}
        {tab === "inventario" && puedeInventario && (
          /* Red de seguridad ademas de ocultar la pestana: una compania
           * SUSPENDIDA deja pasar `companias.detail` pero no
           * `exigirAccesoCompania`, y `useQuery` lanza en el render. Sin
           * boundary propio, ese error sube hasta Next y se lleva la pagina. */
          <ErrorBoundary
            resetKey={companiaId}
            fallback={(e) => (
              <ErrorMessage title="No se puede ver el inventario" detail={e.message} />
            )}
          >
            <PanelInventario companiaId={companiaId} />
          </ErrorBoundary>
        )}
        {tab === "inasistencias" && puedePlanificar && (
          /* Mismo motivo que el inventario: una compañía suspendida deja pasar
           * `companias.detail` pero no las consultas del panel. */
          <ErrorBoundary
            resetKey={companiaId}
            fallback={(e) => (
              <ErrorMessage title="No se pueden ver las inasistencias" detail={e.message} />
            )}
          >
            <PanelInasistencias companiaId={companiaId} />
          </ErrorBoundary>
        )}
        {tab === "horarios" && puedePlanificar && (
          <ErrorBoundary
            resetKey={companiaId}
            fallback={(e) => (
              <ErrorMessage title="No se pueden ver los horarios" detail={e.message} />
            )}
          >
            <PanelHorarios companiaId={companiaId} conjuntos={conjuntosPlanificables} />
          </ErrorBoundary>
        )}
        {tab === "disponibilidad" && puedePlanificar && (
          <ErrorBoundary
            resetKey={companiaId}
            fallback={(e) => (
              <ErrorMessage title="No se puede ver la disponibilidad" detail={e.message} />
            )}
          >
            <PanelDisponibilidad companiaId={companiaId} contratos={contratosParaCubrir} />
          </ErrorBoundary>
        )}
        {tab === "coberturas" && puedePlanificar && (
          <ErrorBoundary
            resetKey={companiaId}
            fallback={(e) => (
              <ErrorMessage title="No se pueden ver las coberturas" detail={e.message} />
            )}
          >
            <PanelCoberturas
              companiaId={companiaId}
              conjuntos={contratosParaCubrir}
              puedeInhabilitar={puedeInhabilitarCoberturas}
            />
          </ErrorBoundary>
        )}
      </div>
    </PageContainer>
  );
}

/**
 * Pestana sin contador.
 *
 * `Tab` exige un numero y lo pinta siempre; el del inventario no esta en
 * `companias.detail` a proposito —lo pide el panel cuando se abre— y pasarle
 * un 0 mentiria hasta que cargara. Antes que aflojar `Tab` para todas, una
 * variante para esta.
 */
function TabSimple({
  activo,
  onClick,
  icon: Icon,
  label,
}: {
  activo: boolean;
  onClick: () => void;
  icon: typeof Users;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "-mb-px flex items-center gap-2 border-b-2 px-4 py-2.5 text-[13.5px] font-medium transition-colors",
        activo
          ? "border-brand text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon className="h-4 w-4" aria-hidden />
      {label}
    </button>
  );
}

function Tab({
  activo,
  onClick,
  icon: Icon,
  label,
  n,
}: {
  activo: boolean;
  onClick: () => void;
  icon: typeof Users;
  label: string;
  n: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "-mb-px flex items-center gap-2 border-b-2 px-4 py-2.5 text-[13.5px] font-medium transition-colors",
        activo
          ? "border-brand text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon className="h-4 w-4" aria-hidden />
      {label}
      <span className="rounded-full bg-muted px-1.5 text-[11px] tabular-nums">
        {n}
      </span>
    </button>
  );
}

function Cabecera({
  compania,
  esPlataforma,
}: {
  compania: { _id: Id<"companiasSeguridad">; nombre: string; estado: string; nit?: string; contactoEmail?: string };
  esPlataforma: boolean;
}) {
  const setEstado = useMutation(api.companias.setEstado);
  const [confirmar, setConfirmar] = useState<Estado | null>(null);

  return (
    <>
      <div className="flex flex-wrap items-start gap-4">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-brand/10">
          <ShieldCheck className="h-6 w-6 text-brand" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              {compania.nombre}
            </h1>
            <EstadoBadge estado={compania.estado as Estado} />
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {compania.nit ? `NIT ${compania.nit}` : "Sin NIT registrado"}
            {compania.contactoEmail ? ` · ${compania.contactoEmail}` : ""}
          </p>
        </div>

        {esPlataforma && (
          <div className="flex items-center gap-2">
            <Select
              className="w-auto"
              value={compania.estado}
              onChange={(e) => setConfirmar(e.target.value as Estado)}
              aria-label="Estado de la compañía"
            >
              <option value="activa">Activa</option>
              <option value="suspendida">Suspendida</option>
              <option value="inactiva">Archivada</option>
            </Select>
            {/* Archivar es `estado: "inactiva"` de siempre; lo que faltaba era
                una acción que se llamara como lo que hace. Solo plataforma:
                el backend rechaza a cualquier otro. */}
            {compania.estado === "inactiva" ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setConfirmar("activa")}
              >
                <ArchiveRestore className="h-4 w-4" aria-hidden />
                Sacar del archivo
              </Button>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setConfirmar("inactiva")}
              >
                <Archive className="h-4 w-4" aria-hidden />
                Archivar compañía
              </Button>
            )}
          </div>
        )}
      </div>

      <ConfirmarEstado
        companiaId={compania._id}
        estado={confirmar}
        onClose={() => setConfirmar(null)}
        onConfirm={async (estado) => {
          await setEstado({ companiaId: compania._id, estado });
          setConfirmar(null);
        }}
      />
    </>
  );
}

/**
 * Suspender corta la operación de TODA la compañía a la vez. Es una acción
 * con mucho más radio del que sugiere un desplegable, así que se nombra a
 * cuánta gente y cuántos conjuntos deja sin portería antes de aplicarla.
 */
function ConfirmarEstado({
  companiaId,
  estado,
  onClose,
  onConfirm,
}: {
  companiaId: Id<"companiasSeguridad">;
  estado: Estado | null;
  onClose: () => void;
  onConfirm: (estado: Estado) => Promise<void>;
}) {
  const data = useQuery(api.companias.detail, { companiaId });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!estado) return null;

  const vigentes = data?.contratos.filter((c) => c.estado === "vigente") ?? [];
  const personas = vigentes.reduce((n, c) => n + c.asignacionesVigentes, 0);
  const corta = estado !== "activa";

  return (
    <Modal
      open
      onClose={busy ? () => {} : onClose}
      title={
        estado === "activa"
          ? "Reactivar compañía"
          : estado === "inactiva"
            ? "Archivar compañía"
            : "Suspender compañía"
      }
    >
      <div className="space-y-4">
        {corta ? (
          <p className="text-sm text-foreground">
            Su personal dejará de poder operar de inmediato en{" "}
            <strong>
              {vigentes.length} conjunto{vigentes.length === 1 ? "" : "s"}
            </strong>
            , afectando a <strong>{personas}</strong> asignación
            {personas === 1 ? "" : "es"} vigente{personas === 1 ? "" : "s"}.
            {estado === "suspendida" &&
              " Los contratos y las asignaciones quedan intactos: al reactivarla, todo vuelve a funcionar."}
          </p>
        ) : (
          <p className="text-sm text-foreground">
            Su personal recuperará el acceso a los conjuntos con contrato
            vigente.
          </p>
        )}

        {estado === "inactiva" && (
          <p className="rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-[12.5px] text-muted-foreground">
            No se borra nada. La compañía pasa a <strong>Archivadas</strong> con
            sus contratos, su personal y todo lo que registró en las porterías
            —turnos, rondas, minutas y eventos—, que pertenecen al conjunto y no
            se tocan. Se puede sacar del archivo y todo vuelve a funcionar.
          </p>
        )}
        {vigentes.length > 0 && corta && (
          <ul className="rounded-lg bg-muted/60 p-3 text-[13px] text-muted-foreground">
            {vigentes.map((c) => (
              <li key={c._id}>· {c.condominioNombre}</li>
            ))}
          </ul>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button
            variant={corta ? "destructive" : "primary"}
            disabled={busy}
            onClick={async () => {
              setError(null);
              setBusy(true);
              try {
                await onConfirm(estado);
              } catch (err) {
                /* Antes se lo tragaba el `finally` y el modal se quedaba como
                   si nada. La fuente de verdad es el servidor: si rechaza, se
                   dice. */
                setError(
                  err instanceof Error
                    ? err.message
                    : "No se pudo cambiar el estado.",
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy
              ? "Aplicando…"
              : estado === "inactiva"
                ? "Sí, archivar"
                : "Confirmar"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────
// Personal
// ─────────────────────────────────────────────────────────────

type Persona = {
  _id: Id<"companiaMiembros">;
  userId: Id<"users">;
  nombre: string;
  email: string | null;
  roles: string[];
  cargo: string | null;
  isActive: boolean;
  asignacionesVigentes: number;
};

function PanelPersonal({
  companiaId,
  personal,
}: {
  companiaId: Id<"companiasSeguridad">;
  personal: Persona[];
}) {
  const [agregar, setAgregar] = useState(false);
  const activos = personal.filter((p) => p.isActive);
  const bajas = personal.filter((p) => !p.isActive);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Supervisores y guardas de la compañía. Pertenecer a ella no da acceso
          a ningún conjunto: eso lo da la asignación.
        </p>
        <Button size="sm" onClick={() => setAgregar(true)}>
          <UserPlus className="h-4 w-4" aria-hidden />
          Agregar persona
        </Button>
      </div>

      {activos.length === 0 ? (
        <EmptyState
          icon={Users}
          title="Sin personal todavía"
          description="Agrega supervisores y guardas para poder asignarlos a los conjuntos que la compañía atiende."
          action={<Button onClick={() => setAgregar(true)}>Agregar persona</Button>}
        />
      ) : (
        <Card className="overflow-hidden p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="px-5 py-3 font-medium">Persona</th>
                <th className="px-5 py-3 font-medium">Rol</th>
                <th className="px-5 py-3 font-medium">Conjuntos</th>
                <th className="px-5 py-3 text-right font-medium">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {activos.map((p) => (
                <FilaPersona key={p._id} p={p} />
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {bajas.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">
            {bajas.length} persona{bajas.length === 1 ? "" : "s"} dada
            {bajas.length === 1 ? "" : "s"} de baja
          </summary>
          <ul className="mt-2 space-y-1 pl-4 text-muted-foreground">
            {bajas.map((p) => (
              <li key={p._id}>
                {p.nombre} {p.email ? `· ${p.email}` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}

      <AgregarPersonaDialog
        companiaId={companiaId}
        open={agregar}
        onClose={() => setAgregar(false)}
      />
    </div>
  );
}

function FilaPersona({ p }: { p: Persona }) {
  const desactivar = useMutation(api.companias.desactivarMiembro);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editando, setEditando] = useState(false);

  /* `[0]` y no un `find`: el backend garantiza que solo hay uno. Se lee así
   * para que, si alguna vez llegara una fila vieja sin normalizar, la fila
   * muestre el primero en vez de reventar. */
  const rolActual = p.roles[0] as RolCompania | undefined;

  return (
    <tr className="align-top">
      <td className="px-5 py-3.5">
        <p className="font-medium text-foreground">{p.nombre}</p>
        <p className="text-xs text-muted-foreground">{p.email}</p>
        {p.cargo && (
          <p className="text-xs text-muted-foreground">{p.cargo}</p>
        )}
        {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
      </td>
      <td className="px-5 py-3.5">
        {/* Solo lectura. La tabla dice QUÉ es cada persona; cambiarlo es una
            decisión, y las decisiones se toman en "Editar" —donde además se
            ve a quién se le está cambiando—. Con el control aquí, un clic
            despistado al recorrer la lista le cambiaba el rol a alguien. */}
        {rolActual ? (
          <Badge tone="brand">{ETIQUETA_ROL[rolActual]}</Badge>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </td>
      <td className="px-5 py-3.5 tabular-nums text-muted-foreground">
        {p.asignacionesVigentes}
      </td>
      <td className="px-5 py-3.5 text-right">
        <div className="flex items-center justify-end gap-1">
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => setEditando(true)}
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden />
            Editar
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={async () => {
              setError(null);
              setBusy(true);
              try {
                await desactivar({ miembroId: p._id });
              } catch (e) {
                /* El hueco de error de la fila lo alimentaba el control de
                 * rol, que ya no está aquí. Darlo de baja puede fallar
                 * —perfil sin correo, permisos— y hasta ahora ese fallo se
                 * perdía en silencio. */
                setError(e instanceof Error ? e.message : "No se pudo dar de baja.");
              } finally {
                setBusy(false);
              }
            }}
          >
            <UserMinus className="h-3.5 w-3.5" aria-hidden />
            Dar de baja
          </Button>
        </div>
        {/* La ficha se monta al pulsar: los datos personales no viajan en el
            listado de toda la compañía. */}
        {editando && (
          <EditarPersonaDialog
            miembroId={p._id}
            /* El rol viaja como prop y no lo vuelve a pedir el modal:
             * `detalleMiembro` no lo devuelve, y la fila ya lo tiene. Así el
             * cambio se queda en el frontend. */
            rolActual={rolActual}
            onClose={() => setEditando(false)}
          />
        )}
      </td>
    </tr>
  );
}

function AgregarPersonaDialog({
  companiaId,
  open,
  onClose,
}: {
  companiaId: Id<"companiasSeguridad">;
  open: boolean;
  onClose: () => void;
}) {
  const crear = useAction(api.companias.crearMiembro);
  const [nombre, setNombre] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [telefono, setTelefono] = useState("");
  const [cargo, setCargo] = useState("");
  const [rol, setRol] = useState<RolCompania>("guardia");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function cerrar() {
    setNombre("");
    setEmail("");
    setPassword("");
    setTelefono("");
    setCargo("");
    setRol("guardia");
    setError(null);
    onClose();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await crear({
        companiaId,
        name: nombre,
        email,
        password,
        telefono: telefono || undefined,
        cargo: cargo || undefined,
        roles: [rol],
      });
      cerrar();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo agregar.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={cerrar}
      title="Agregar persona a la compañía"
      description="Si ya tiene cuenta en Vekino se le respeta y solo se le añade el vínculo con la compañía."
    >
      <form onSubmit={submit} className="space-y-3.5">
        <Campo label="Nombre completo" requerido>
          <Input
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            required
            autoFocus
          />
        </Campo>
        <Campo label="Correo" requerido>
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </Campo>
        <Campo
          label="Contraseña"
          requerido
          ayuda="Mínimo 8 caracteres. Es con la que entrará a la app."
        >
          <Input
            type="text"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
          />
        </Campo>
        <Campo label="Teléfono">
          <Input value={telefono} onChange={(e) => setTelefono(e.target.value)} />
        </Campo>
        <Campo label="Cargo" ayuda="Solo informativo. No otorga permisos.">
          <Input
            value={cargo}
            onChange={(e) => setCargo(e.target.value)}
            placeholder="Supervisor zona norte"
          />
        </Campo>

        {/* Un solo rol. Mismo `Select` que el diálogo de asignación de abajo:
            no hay dos maneras de elegir un rol en esta pantalla. */}
        <Campo
          label="Rol en la compañía"
          requerido
          ayuda="Una persona tiene un único rol. Se puede cambiar después."
        >
          <Select
            value={rol}
            onChange={(e) => setRol(e.target.value as RolCompania)}
          >
            {(Object.keys(ETIQUETA_ROL) as RolCompania[]).map((r) => (
              <option key={r} value={r}>
                {ETIQUETA_ROL[r]}
              </option>
            ))}
          </Select>
        </Campo>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" onClick={cerrar}>
            Cancelar
          </Button>
          <Button
            type="submit"
            disabled={busy || password.length < 8}
          >
            {busy ? "Agregando…" : "Agregar"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────
// Contratos y asignaciones
// ─────────────────────────────────────────────────────────────

type Contrato = {
  _id: Id<"companiaContratos">;
  condominioId: Id<"condominios">;
  condominioNombre: string;
  vigenciaDesde: number;
  vigenciaHasta: number | null;
  estado: "programada" | "vigente" | "terminada";
  /* Lo decide el servidor, no esta pantalla: es la regla del modelo. */
  archivado: boolean;
  terminadoEn: number | null;
  terminadoPorNombre: string | null;
  asignacionesVigentes: number;
  asignacionesTotales: number;
};

/**
 * Los conjuntos de la compañía, separados en Activos y Archivados.
 *
 * `archivado` viene calculado del servidor —contrato terminado, o compañía
 * dada de baja—: aquí solo se agrupa. Si la separación se decidiera en esta
 * pantalla, sería la pantalla la que define qué está terminado, y bastaría
 * abrir otra vista para volver a verlo activo.
 */
function PanelContratos({
  companiaId,
  contratos,
  personal,
  esPlataforma,
  companiaActiva,
}: {
  companiaId: Id<"companiasSeguridad">;
  contratos: Contrato[];
  personal: Persona[];
  esPlataforma: boolean;
  companiaActiva: boolean;
}) {
  const [nuevo, setNuevo] = useState(false);
  const [abierto, setAbierto] = useState<Id<"companiaContratos"> | null>(null);
  const [archivo, setArchivo] = useState(false);

  const activos = contratos.filter((k) => !k.archivado);
  const archivados = contratos.filter((k) => k.archivado);
  const visibles = archivo ? archivados : activos;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-muted-foreground">
          Los conjuntos donde esta compañía presta servicio. El contrato es lo
          que autoriza: sin uno vigente, ninguna asignación funciona.
        </p>
        {esPlataforma && (
          <Button size="sm" onClick={() => setNuevo(true)}>
            <Plus className="h-4 w-4" aria-hidden />
            Contratar conjunto
          </Button>
        )}
      </div>

      <div className="flex gap-1 rounded-xl border border-border bg-card p-1">
        <SubTab
          activo={!archivo}
          onClick={() => setArchivo(false)}
          label="Activos"
          n={activos.length}
        />
        <SubTab
          activo={archivo}
          onClick={() => setArchivo(true)}
          label="Archivados"
          n={archivados.length}
        />
      </div>

      {visibles.length === 0 ? (
        <EmptyState
          icon={archivo ? Archive : FileText}
          title={archivo ? "Nada archivado todavía" : "Sin conjuntos activos"}
          description={
            archivo
              ? "Cuando termine el contrato de un conjunto pasará aquí, con su histórico intacto."
              : esPlataforma
                ? "Contrata un conjunto para poder asignarle supervisores y guardas."
                : "Cuando Vekino firme un contrato con un conjunto aparecerá aquí y podrás asignarle tu personal."
          }
          action={
            !archivo && esPlataforma ? (
              <Button onClick={() => setNuevo(true)}>Contratar conjunto</Button>
            ) : undefined
          }
        />
      ) : (
        <div className="space-y-3">
          {visibles.map((k) => (
            <FilaContrato
              key={k._id}
              contrato={k}
              personal={personal}
              esPlataforma={esPlataforma}
              companiaActiva={companiaActiva}
              abierto={abierto === k._id}
              onToggle={() => setAbierto(abierto === k._id ? null : k._id)}
            />
          ))}
        </div>
      )}

      <NuevoContratoDialog
        companiaId={companiaId}
        open={nuevo}
        onClose={() => setNuevo(false)}
      />
    </div>
  );
}

function SubTab({
  activo,
  onClick,
  label,
  n,
}: {
  activo: boolean;
  onClick: () => void;
  label: string;
  n: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors",
        activo
          ? "bg-brand text-brand-foreground"
          : "text-muted-foreground hover:bg-accent",
      )}
    >
      {label}
      <span className="tabular-nums opacity-80">({n})</span>
    </button>
  );
}

function FilaContrato({
  contrato,
  personal,
  esPlataforma,
  companiaActiva,
  abierto,
  onToggle,
}: {
  contrato: Contrato;
  personal: Persona[];
  esPlataforma: boolean;
  companiaActiva: boolean;
  abierto: boolean;
  onToggle: () => void;
}) {
  const asignaciones = useQuery(
    api.asignaciones.porContrato,
    abierto ? { contratoId: contrato._id, incluirTerminadas: true } : "skip",
  );
  const [asignar, setAsignar] = useState(false);
  const [confirmar, setConfirmar] = useState(false);

  return (
    <Card className="overflow-hidden p-0">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-4 p-4 text-left transition-colors hover:bg-accent/40"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium text-foreground">
              {contrato.condominioNombre}
            </p>
            <Badge tone={TONO_VIGENCIA[contrato.estado]}>{contrato.estado}</Badge>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {fmt(contrato.vigenciaDesde)} →{" "}
            {contrato.terminadoEn != null
              ? fmt(contrato.terminadoEn)
              : fmt(contrato.vigenciaHasta)}
            {/* Quién lo cortó. Es lo primero que se pregunta meses después. */}
            {contrato.terminadoPorNombre &&
              ` · terminado por ${contrato.terminadoPorNombre}`}
          </p>
        </div>
        <div className="text-right">
          <p className="text-lg font-semibold tabular-nums text-foreground">
            {contrato.asignacionesVigentes}
          </p>
          <p className="text-[11px] text-muted-foreground">asignados</p>
        </div>
      </button>

      {/* La operación del conjunto: rondas y minuta del equipo que lo cubre.
          Es la misma pantalla que ya usa el supervisor —no una copia— y el
          servidor vuelve a resolver el permiso por contrato en cada consulta.
          Solo en los contratos que siguen en pie: en uno terminado la
          portería rebota, y ofrecer el enlace sería prometer lo que no hay.
          Y solo al personal de la compañía: el staff de plataforma no entra
          por ese shell —no es de ninguna empresa— y tiene la minuta del
          conjunto en su propio panel de control de guardia. */}
      {contrato.estado === "vigente" && companiaActiva && !esPlataforma && (
        <div className="border-t border-border px-4 py-2.5">
          <Link
            href={`/vigilancia/${contrato.condominioId}`}
            className="inline-flex items-center gap-1.5 text-[12.5px] text-brand hover:underline"
          >
            <BookOpenCheck className="h-3.5 w-3.5" aria-hidden />
            Ver minuta y rondas del conjunto
          </Link>
        </div>
      )}

      {abierto && (
        <div className="border-t border-border bg-muted/30 p-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-[13px] font-medium text-foreground">
              Personal asignado
            </p>
            <div className="flex gap-2">
              {!contrato.archivado && (
                <>
                  <Button size="sm" onClick={() => setAsignar(true)}>
                    <UserPlus className="h-3.5 w-3.5" aria-hidden />
                    Asignar
                  </Button>
                  {/* Antes ejecutaba al primer clic y se tragaba el error: si
                      el backend rechazaba —y a la compañía la rechazaba
                      siempre— no pasaba nada y no se decía por qué. Ahora
                      confirma, y el resultado sale del servidor. */}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setConfirmar(true)}
                  >
                    <CalendarOff className="h-3.5 w-3.5" aria-hidden />
                    Terminar contrato
                  </Button>
                </>
              )}
            </div>
          </div>

          {asignaciones === undefined ? (
            <p className="text-[13px] text-muted-foreground">Cargando…</p>
          ) : asignaciones.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">
              Nadie asignado todavía. La compañía tiene el contrato, pero sin
              asignaciones su personal no puede operar esta portería.
            </p>
          ) : (
            <ul className="divide-y divide-border/60">
              {asignaciones.map((a) => (
                <FilaAsignacion key={a._id} a={a} />
              ))}
            </ul>
          )}
        </div>
      )}

      <AsignarDialog
        contrato={contrato}
        personal={personal}
        open={asignar}
        onClose={() => setAsignar(false)}
      />
      <TerminarContratoDialog
        contrato={contrato}
        open={confirmar}
        onClose={() => setConfirmar(false)}
      />
    </Card>
  );
}

/**
 * Confirmar la terminación de un contrato.
 *
 * Dice lo que va a pasar de verdad —a cuánta gente deja sin portería y qué se
 * conserva— porque terminar un contrato corta el acceso de todo su personal
 * en ese conjunto de inmediato, y desde el botón no se veía venir.
 *
 * No mueve nada a mano al terminar: la lista es una consulta de Convex y el
 * conjunto salta a "Archivados" solo, en cuanto el servidor lo dice. Un
 * estado local aquí sería justo la mentira que había que evitar.
 */
function TerminarContratoDialog({
  contrato,
  open,
  onClose,
}: {
  contrato: Contrato;
  open: boolean;
  onClose: () => void;
}) {
  const terminar = useMutation(api.companias.terminarContrato);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirmar() {
    setError(null);
    setBusy(true);
    try {
      /* Sin `vigenciaHasta`: se termina AHORA. Mandar la fecha de hoy era el
         bug — `finDe` le regala el día entero y no cortaba hasta mañana. */
      await terminar({ contratoId: contrato._id });
      onClose();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "No se pudo terminar el contrato.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      title="Terminar contrato"
      description={contrato.condominioNombre}
    >
      <div className="space-y-4">
        <p className="text-sm text-foreground">
          El contrato queda terminado <strong>hoy mismo</strong>.{" "}
          {contrato.asignacionesVigentes > 0 ? (
            <>
              <strong>
                {contrato.asignacionesVigentes} persona
                {contrato.asignacionesVigentes === 1 ? "" : "s"}
              </strong>{" "}
              de tu compañía dejará
              {contrato.asignacionesVigentes === 1 ? "" : "n"} de poder entrar a
              esa portería de inmediato.
            </>
          ) : (
            "Nadie de tu compañía está asignado a ese conjunto ahora mismo."
          )}
        </p>
        <p className="rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-[12.5px] text-muted-foreground">
          No se borra nada. El conjunto pasa a <strong>Archivados</strong> con
          su histórico completo —turnos, rondas, minuta y las{" "}
          {contrato.asignacionesTotales} asignación
          {contrato.asignacionesTotales === 1 ? "" : "es"} que hubo—, y el
          conjunto sigue funcionando en Vekino con normalidad.
        </p>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button variant="destructive" onClick={confirmar} disabled={busy}>
            {busy ? "Terminando…" : "Sí, terminar contrato"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function FilaAsignacion({
  a,
}: {
  a: {
    _id: Id<"asignaciones">;
    nombre: string;
    rol: string;
    vigenciaDesde: number;
    vigenciaHasta: number | null;
    estado: "programada" | "vigente" | "terminada";
  };
}) {
  const terminar = useMutation(api.asignaciones.terminar);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <li className="flex flex-wrap items-center gap-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="text-[13.5px] font-medium text-foreground">{a.nombre}</p>
        <p className="text-xs text-muted-foreground">
          {a.rol === "supervisor" ? "Supervisor" : "Guarda"} ·{" "}
          {fmt(a.vigenciaDesde)} → {fmt(a.vigenciaHasta)}
        </p>
        {error && <p className="mt-0.5 text-xs text-destructive">{error}</p>}
      </div>
      <Badge tone={TONO_VIGENCIA[a.estado]}>{a.estado}</Badge>
      {a.estado !== "terminada" && (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={async () => {
            setError(null);
            setBusy(true);
            try {
              /* Sin fecha: sale del conjunto ahora. Mandar la de hoy lo
                 dejaba operando la portería hasta mañana. */
              await terminar({ asignacionId: a._id });
            } catch (err) {
              setError(
                err instanceof Error ? err.message : "No se pudo terminar.",
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          Terminar
        </Button>
      )}
    </li>
  );
}

function AsignarDialog({
  contrato,
  personal,
  open,
  onClose,
}: {
  contrato: Contrato;
  personal: Persona[];
  open: boolean;
  onClose: () => void;
}) {
  const crear = useMutation(api.asignaciones.crear);
  const [miembroId, setMiembroId] = useState<string>("");
  const [rol, setRol] = useState<RolAsignacion>("guardia");
  const [desde, setDesde] = useState(msAFecha(Math.max(contrato.vigenciaDesde, Date.now())));
  const [hasta, setHasta] = useState(
    contrato.vigenciaHasta ? msAFecha(contrato.vigenciaHasta) : "",
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Solo tiene sentido ofrecer a quien la compañía reconoce con ese rol.
  const elegibles = personal.filter((p) => p.isActive && p.roles.includes(rol));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await crear({
        contratoId: contrato._id,
        companiaMiembroId: miembroId as Id<"companiaMiembros">,
        rol,
        vigenciaDesde: fechaAMs(desde),
        vigenciaHasta: hasta ? fechaAMs(hasta) : undefined,
      });
      setMiembroId("");
      setError(null);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo asignar.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Asignar a ${contrato.condominioNombre}`}
      description="La asignación tiene que caber dentro de la vigencia del contrato."
    >
      <form onSubmit={submit} className="space-y-3.5">
        <Campo label="Rol en este conjunto" requerido>
          <Select
            value={rol}
            onChange={(e) => {
              setRol(e.target.value as RolAsignacion);
              setMiembroId("");
            }}
          >
            <option value="guardia">Guarda</option>
            <option value="supervisor">Supervisor</option>
          </Select>
        </Campo>

        <Campo
          label="Persona"
          requerido
          ayuda={
            elegibles.length === 0
              ? "Nadie de la compañía tiene ese rol todavía. Asígnaselo primero en la pestaña Personal."
              : undefined
          }
        >
          <Select
            value={miembroId}
            onChange={(e) => setMiembroId(e.target.value)}
            required
            disabled={elegibles.length === 0}
          >
            <option value="">Selecciona…</option>
            {elegibles.map((p) => (
              <option key={p._id} value={p._id}>
                {p.nombre}
              </option>
            ))}
          </Select>
        </Campo>

        <div className="grid grid-cols-2 gap-3">
          <Campo label="Desde" requerido>
            <Input
              type="date"
              value={desde}
              onChange={(e) => setDesde(e.target.value)}
              required
            />
          </Campo>
          <Campo label="Hasta" ayuda="Vacío = indefinido">
            <Input
              type="date"
              value={hasta}
              onChange={(e) => setHasta(e.target.value)}
            />
          </Campo>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={busy || !miembroId}>
            {busy ? "Asignando…" : "Asignar"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function NuevoContratoDialog({
  companiaId,
  open,
  onClose,
}: {
  companiaId: Id<"companiasSeguridad">;
  open: boolean;
  onClose: () => void;
}) {
  const condominios = useQuery(api.condominios.listAll, open ? {} : "skip");
  const crear = useMutation(api.companias.crearContrato);
  const [condominioId, setCondominioId] = useState("");
  const [desde, setDesde] = useState(msAFecha(Date.now()));
  const [hasta, setHasta] = useState("");
  const [notas, setNotas] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await crear({
        companiaId,
        condominioId: condominioId as Id<"condominios">,
        vigenciaDesde: fechaAMs(desde),
        vigenciaHasta: hasta ? fechaAMs(hasta) : undefined,
        notas: notas || undefined,
      });
      setCondominioId("");
      setNotas("");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo contratar.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Contratar un conjunto"
      description="Autoriza a esta compañía a operar la portería del conjunto durante el período indicado."
    >
      <form onSubmit={submit} className="space-y-3.5">
        <Campo label="Conjunto" requerido>
          <Select
            value={condominioId}
            onChange={(e) => setCondominioId(e.target.value)}
            required
          >
            <option value="">Selecciona…</option>
            {(condominios ?? []).map((c) => (
              <option key={c._id} value={c._id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Campo>

        <div className="grid grid-cols-2 gap-3">
          <Campo label="Desde" requerido>
            <Input
              type="date"
              value={desde}
              onChange={(e) => setDesde(e.target.value)}
              required
            />
          </Campo>
          <Campo label="Hasta" ayuda="Vacío = indefinido">
            <Input
              type="date"
              value={hasta}
              onChange={(e) => setHasta(e.target.value)}
            />
          </Campo>
        </div>

        <Campo label="Referencia del contrato">
          <Input
            value={notas}
            onChange={(e) => setNotas(e.target.value)}
            placeholder="Contrato 2026-014"
          />
        </Campo>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={busy || !condominioId}>
            {busy ? "Contratando…" : "Contratar"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
