"use client";

import Link from "next/link";
import { useQuery } from "convex/react";
import {
  ArrowLeftRight,
  Building2,
  CheckCircle2,
  ShieldAlert,
  ShieldCheck,
  Users,
  DoorOpen,
  LifeBuoy,
  ArrowUpRight,
} from "lucide-react";
import { api } from "@vekino/backend/api";
import { etiquetaInstante } from "@vekino/backend/inasistencias";
import {
  homeHrefForRoles,
  homeHrefForAsignacion,
  isGuardiaOnly,
  sesionOperativa,
} from "@/lib/role-routing";
import { useMeOperativo } from "@/hooks/use-contexto-operativo";
import { PageContainer } from "@/components/layout/page-container";
import { PageHeader } from "@/components/layout/page-header";
import { StatCard } from "@/components/layout/stat-card";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { DonutChart } from "@/components/charts/donut-chart";
import { CHART } from "@/components/charts/chart-colors";
import { cn } from "@/lib/utils";
import { SolicitudesCobertura } from "@/components/guardia/solicitudes-cobertura";
import { AvisoTurnoPendiente } from "@/components/guardia/aviso-turno-pendiente";

export default function DashboardHome() {
  const me = useMeOperativo();

  if (me === undefined) {
    return (
      <PageContainer>
        <p className="text-sm text-muted-foreground">Cargando…</p>
      </PageContainer>
    );
  }
  if (me === null) {
    return (
      <PageContainer>
        <p className="text-sm text-muted-foreground">Configurando tu perfil…</p>
      </PageContainer>
    );
  }

  const isPlatform =
    me.platformRole === "superadmin" || me.platformRole === "admin";

  return isPlatform ? <PlatformHome name={me.name} /> : <UserHome me={me} />;
}

function PlatformHome({ name }: { name: string }) {
  const stats = useQuery(api.platform.stats);
  const loading = stats === undefined;

  const maxMembers = Math.max(
    1,
    ...(stats?.ranking.map((r) => r.members) ?? [1]),
  );

  const pctActivos =
    stats && stats.condominios.total > 0
      ? Math.round((stats.condominios.activos / stats.condominios.total) * 100)
      : 0;

  return (
    <PageContainer>
      <div className="grid grid-cols-12 gap-4">
        <div className="col-span-12">
          <PageHeader
            title="Panel maestro"
            description={`Hola, ${name}. Vista global de la plataforma Vekino.`}
          />
        </div>

        {/* KPIs */}
        <div className="col-span-12 grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard
            icon={Building2}
            tone="neutral"
            label="Condominios"
            value={stats?.condominios.total ?? "—"}
            badge={
              stats
                ? `${stats.condominios.activos} activos`
                : undefined
            }
            href="/dashboard/condominios"
          />
          <StatCard
            icon={Users}
            tone="neutral"
            label="Usuarios"
            value={stats?.usuarios.total ?? "—"}
            badge={
              stats
                ? `${stats.membresias.activas} membresías`
                : undefined
            }
            href="/dashboard/administradores"
          />
          <StatCard
            icon={DoorOpen}
            tone="neutral"
            label="Unidades"
            value={stats?.unidades.total ?? "—"}
            badge="en la plataforma"
          />
          <StatCard
            icon={LifeBuoy}
            tone="neutral"
            label="Soporte abierto"
            value={stats?.soporte.abiertos ?? "—"}
            badge={
              stats && stats.soporte.abiertos > 0
                ? "requiere atención"
                : "al día"
            }
            badgeTone={
              stats && stats.soporte.abiertos > 0 ? "pending" : "positive"
            }
            href="/dashboard/soporte"
          />
        </div>

        {/* Ranking barras */}
        <Card className="col-span-12 lg:col-span-8">
          <CardHeader className="mb-0 flex-row items-start justify-between gap-3">
            <div>
              <CardTitle>Usuarios por condominio</CardTitle>
              <CardDescription>
                Membresías activas · ranking de adopción
              </CardDescription>
            </div>
            <Button variant="secondary" size="sm" asChild>
              <Link href="/dashboard/condominios">Ver todos</Link>
            </Button>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="mt-3 space-y-3">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-10 w-full rounded-xl" />
                ))}
              </div>
            ) : !stats || stats.ranking.length === 0 ? (
              <p className="py-14 text-center text-sm text-muted-foreground">
                Aún no hay condominios registrados.
              </p>
            ) : (
              <ul className="mt-2 space-y-3">
                {stats.ranking.slice(0, 8).map((row, i) => (
                  <li key={row.id}>
                    <Link
                      href={`/condominio/${row.id}`}
                      className="group block rounded-xl px-1 py-1 transition-colors hover:bg-accent/40"
                    >
                      <div className="mb-1.5 flex items-center justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-2.5">
                          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-muted text-[11px] font-semibold tabular-nums text-muted-foreground">
                            {i + 1}
                          </span>
                          <div className="min-w-0">
                            <p className="truncate text-[13px] font-medium text-foreground">
                              {row.name}
                            </p>
                            <p className="truncate text-[11px] text-muted-foreground">
                              {[row.city, `${row.unidades} unidades`]
                                .filter(Boolean)
                                .join(" · ")}
                            </p>
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {!row.isActive && (
                            <Badge tone="neutral">Inactivo</Badge>
                          )}
                          <span className="tabular-nums text-[13px] font-semibold text-foreground">
                            {row.members}
                          </span>
                          <ArrowUpRight className="h-3.5 w-3.5 text-muted-foreground/40 transition-colors group-hover:text-muted-foreground" />
                        </div>
                      </div>
                      <div className="ml-8.5 h-1.5 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-foreground/70 transition-[width] duration-300 dark:bg-foreground/55"
                          style={{
                            width: `${Math.max(4, (row.members / maxMembers) * 100)}%`,
                          }}
                        />
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Donut estado */}
        <Card className="col-span-12 lg:col-span-4">
          <CardHeader className="mb-0">
            <CardTitle>Estado de condominios</CardTitle>
            <CardDescription>Activos vs. inactivos</CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="mt-2 flex flex-col items-center gap-4">
                <Skeleton className="h-37.5 w-37.5 rounded-full" />
                <Skeleton className="h-16 w-full" />
              </div>
            ) : stats && stats.condominios.total > 0 ? (
              <DonutChart
                size={150}
                thickness={18}
                centerValue={`${pctActivos}%`}
                centerLabel="activos"
                data={[
                  {
                    label: "Activos",
                    value: stats.condominios.activos,
                    color: CHART.primary,
                  },
                  {
                    label: "Inactivos",
                    value: stats.condominios.inactivos,
                    color: CHART.muted,
                  },
                ]}
              />
            ) : (
              <p className="py-14 text-center text-sm text-muted-foreground">
                Sin datos.
              </p>
            )}
          </CardContent>
        </Card>

        {/* Tabla recientes */}
        <Card className="col-span-12 lg:col-span-8">
          <CardHeader className="mb-3 flex-row items-center justify-between gap-3">
            <div>
              <CardTitle>Condominios recientes</CardTitle>
              <CardDescription>Últimos conjuntos dados de alta</CardDescription>
            </div>
            <Button variant="brand" size="sm" asChild>
              <Link href="/dashboard/condominios">Nuevo condominio</Link>
            </Button>
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-48 w-full rounded-xl" />
            ) : !stats || stats.recientes.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                No hay condominios todavía.
              </p>
            ) : (
              <div className="overflow-hidden">
                <table className="w-full table-fixed border-collapse text-[12px]">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="w-[40%] px-2 py-2.5 text-left text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        Condominio
                      </th>
                      <th className="w-[18%] px-2 py-2.5 text-right text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        Usuarios
                      </th>
                      <th className="w-[18%] px-2 py-2.5 text-right text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        Unidades
                      </th>
                      <th className="w-[24%] px-2 py-2.5 text-left text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        Estado
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.recientes.map((c) => (
                      <tr
                        key={c.id}
                        className="border-b border-border/60 last:border-b-0 even:bg-muted/30"
                      >
                        <td className="max-w-0 px-2 py-2.5 align-middle">
                          <Link
                            href={`/condominio/${c.id}`}
                            className="block truncate font-medium text-foreground hover:text-foreground/80"
                            title={c.name}
                          >
                            {c.name}
                          </Link>
                          <p className="truncate text-[11px] text-muted-foreground">
                            {c.city ?? "Sin ciudad"}
                            {c.plan ? ` · ${c.plan}` : ""}
                          </p>
                        </td>
                        <td className="px-2 py-2.5 text-right tabular-nums text-foreground">
                          {c.members}
                        </td>
                        <td className="px-2 py-2.5 text-right tabular-nums text-foreground">
                          {c.unidades}
                        </td>
                        <td className="px-2 py-2.5">
                          <Badge tone="neutral">
                            {c.isActive ? "Activo" : "Inactivo"}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Actividad soporte */}
        <Card className="col-span-12 lg:col-span-4">
          <CardHeader className="mb-0 flex-row items-center justify-between">
            <div>
              <CardTitle>Actividad de soporte</CardTitle>
              <CardDescription>Tickets recientes</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="mt-3 space-y-3">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full rounded-xl" />
                ))}
              </div>
            ) : !stats || stats.soporte.recientes.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-12 text-center">
                <CheckCircle2 className="h-5 w-5 text-muted-foreground/50" />
                <p className="text-sm text-muted-foreground">
                  Sin tickets por ahora.
                </p>
              </div>
            ) : (
              <ul className="mt-1 space-y-0">
                {stats.soporte.recientes.map((t, i) => (
                  <li
                    key={t.id}
                    className={cn(
                      "flex gap-3 py-2.5",
                      i < stats.soporte.recientes.length - 1 &&
                        "border-b border-border/60",
                    )}
                  >
                    <span
                      className={cn(
                        "mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full",
                        t.estado === "abierto"
                          ? "bg-amber-500"
                          : t.estado === "en_gestion"
                            ? "bg-sky-500"
                            : "bg-muted-foreground/40",
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-medium text-foreground">
                        {t.asunto}
                      </p>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {t.userNombre}
                        {t.condominioNombre
                          ? ` · ${t.condominioNombre}`
                          : ""}
                      </p>
                    </div>
                    <Badge
                      tone={
                        t.estado === "abierto"
                          ? "warning"
                          : t.estado === "en_gestion"
                            ? "info"
                            : "neutral"
                      }
                      className="shrink-0"
                    >
                      {ticketEstadoLabel(t.estado)}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </PageContainer>
  );
}

function ticketEstadoLabel(estado: string) {
  switch (estado) {
    case "abierto":
      return "Abierto";
    case "en_gestion":
      return "En gestión";
    case "resuelto":
      return "Resuelto";
    case "cerrado":
      return "Cerrado";
    default:
      return estado;
  }
}

function UserHome({
  me,
}: {
  me: NonNullable<ReturnType<typeof useQuery<typeof api.users.me>>>;
}) {
  /* Lo que se opera hoy. Con una cobertura activa, las vías de guarda de
   * siempre no se ofrecen: la portería de hoy es la de la cobertura. */
  const hoy = sesionOperativa(me);
  const contexto = me.contextoOperativoGuardia;
  return (
    <PageContainer>
      <div className="space-y-6">
        <PageHeader title={`Hola, ${me.name}`} description={me.email} />
        {/* Las solicitudes de cobertura y el turno pendiente del guarda, tenga
            o no portería que abrir (QA-006, QA-008). */}
        <SolicitudesCobertura className="" />
        <AvisoTurnoPendiente className="" />
        {contexto.cobertura && (
          <Card className="border-brand/30">
            <CardHeader className="mb-0">
              <CardTitle className="flex items-center gap-2">
                <ArrowLeftRight className="h-4 w-4 text-brand" />
                Cobertura de hoy
              </CardTitle>
              <CardDescription>
                Mientras dure, solo operas como guarda en este conjunto.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Link
                href={homeHrefForAsignacion(contexto.cobertura.condominioId, "guardia")}
                className="group flex items-center justify-between py-1 hover:text-brand"
              >
                <span className="flex flex-col">
                  <span className="text-sm text-foreground">
                    {contexto.cobertura.condominioNombre}
                  </span>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {contexto.cobertura.companiaNombre} · hasta el{" "}
                    {etiquetaInstante(contexto.cobertura.fin)} (hora de Colombia)
                  </span>
                </span>
                <span className="text-xs text-brand">Portería →</span>
              </Link>
            </CardContent>
          </Card>
        )}
        {contexto.tipo === "bloqueado" && (
          <Card className="border-destructive/40">
            <CardHeader className="mb-0">
              <CardTitle className="flex items-center gap-2">
                <ShieldAlert className="h-4 w-4 text-destructive" />
                Operación como guarda en pausa
              </CardTitle>
              <CardDescription>
                Tienes más de una cobertura activa a la vez. Hasta que tu compañía
                lo corrija no puedes operar ninguna portería.
              </CardDescription>
            </CardHeader>
          </Card>
        )}
        <Card>
          <CardHeader className="mb-0">
            <CardTitle className="flex items-center gap-2">
              <Building2 className="h-4 w-4 text-brand" />
              Mis condominios ({hoy.memberships.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {hoy.memberships.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Aún no perteneces a ningún condominio.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {hoy.memberships.map((m) => {
                  const canAdmin = m.roles.some((r) =>
                    ["administrador", "contadora"].includes(r),
                  );
                  const esGuardia = isGuardiaOnly(m.roles);
                  const href = homeHrefForRoles(m.condominioId, m.roles);
                  return (
                    <li key={m.membershipId}>
                      <Link
                        href={href}
                        className="group flex items-center justify-between py-3 hover:text-brand"
                      >
                        <span className="flex flex-col">
                          <span className="text-sm text-foreground">
                            {m.condominioName ?? m.condominioId}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {m.roles.join(", ")}
                          </span>
                        </span>
                        <span className="text-xs text-brand opacity-0 group-hover:opacity-100">
                          {canAdmin
                            ? "Administrar →"
                            : esGuardia
                              ? "Portería →"
                              : "Entrar →"}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* El otro eje. Quien trabaja aquí por una compañía de vigilancia no
            tiene membresía en el conjunto, y sin esta tarjeta la sesión se le
            quedaba en blanco. */}
        {hoy.asignaciones.length > 0 && (
          <Card>
            <CardHeader className="mb-0">
              <CardTitle className="flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-brand" />
                Donde trabajo ({hoy.asignaciones.length})
              </CardTitle>
              <CardDescription>
                Conjuntos que cubres por la compañía de vigilancia.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="divide-y divide-border">
                {hoy.asignaciones.map((a) => (
                  <li key={a.asignacionId}>
                    <Link
                      href={homeHrefForAsignacion(a.condominioId, a.rol)}
                      className="group flex items-center justify-between py-3 hover:text-brand"
                    >
                      <span className="flex flex-col">
                        <span className="text-sm text-foreground">
                          {a.condominioNombre}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {a.rol} · {a.companiaNombre}
                        </span>
                      </span>
                      <span className="text-xs text-brand opacity-0 group-hover:opacity-100">
                        {a.rol === "supervisor" ? "Supervisión →" : "Portería →"}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
      </div>
    </PageContainer>
  );
}
