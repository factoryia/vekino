"use client";

import { useMemo } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useQuery } from "convex/react";
import { CircleDollarSign, Wallet, DoorOpen, Upload, Clock, AlertTriangle, FolderOpen, ChartColumn, Users, Receipt } from "lucide-react";
import { api } from "@vekino/backend/api";
import type { Id } from "@vekino/backend/dataModel";
import { PageContainer } from "@/components/layout/page-container";
import { StatCard } from "@/components/layout/stat-card";
import { useTopbarActions } from "@/components/layout/admin-topbar-context";
import {
  PeriodoSelect,
  formatPeriodoLabel,
} from "@/components/layout/periodo-select";
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
import { TwinBars } from "@/components/charts/twin-bars";
import { DonutChart } from "@/components/charts/donut-chart";
import { CHART } from "@/components/charts/chart-colors";
import { usePersistedPeriodo } from "@/hooks/use-persisted-periodo";
import { cop, initials, cn } from "@/lib/utils";

const MES_CORTO = [
  "Ene",
  "Feb",
  "Mar",
  "Abr",
  "May",
  "Jun",
  "Jul",
  "Ago",
  "Sep",
  "Oct",
  "Nov",
  "Dic",
];

function periodoCorto(p: string) {
  const [y, m] = p.split("-");
  return `${MES_CORTO[Number(m) - 1] ?? m}`;
}

function compactCop(n: number) {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `$${m >= 100 ? Math.round(m) : m.toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return cop(n);
}

const AVATAR_COLORS = [
  "bg-brand",
  "bg-brand/80",
  "bg-foreground/70",
  "bg-muted-foreground/60",
  "bg-foreground/50",
];

const ESTADO_TONE: Record<
  string,
  "success" | "warning" | "destructive" | "info" | "neutral"
> = {
  pagada: "success",
  pendiente: "warning",
  vencida: "destructive",
  abonada: "info",
};
const ESTADO_LABEL: Record<string, string> = {
  pagada: "Pagado",
  pendiente: "Pendiente",
  vencida: "Vencida",
  abonada: "Abonada",
};

export default function CondominioHome() {
  const params = useParams<{ id: string }>();
  const condominioId = params.id as Id<"condominios">;
  const home = useQuery(api.condominios.adminHome, { condominioId });
  const detail = useQuery(api.condominios.detail, { condominioId });
  const serie = useQuery(api.facturas.serie, { condominioId });
  const periodos = useQuery(api.facturas.listPeriodos, { condominioId });
  const { periodo, setPeriodo } = usePersistedPeriodo(condominioId, periodos);

  const base = `/condominio/${condominioId}`;

  const selectedIdx = useMemo(() => {
    if (!serie || !periodo) return -1;
    return serie.findIndex((p: { periodo: string }) => p.periodo === periodo);
  }, [serie, periodo]);

  const current = selectedIdx >= 0 ? serie![selectedIdx] : undefined;
  const prev = selectedIdx > 0 ? serie![selectedIdx - 1] : undefined;

  const pagosRecientes = useQuery(
    api.facturas.listRecentByPeriodo,
    periodo ? { condominioId, periodo, limit: 6 } : "skip",
  );

  const periodosKey = (periodos ?? []).join("|");

  // Un solo CTA primario: Cargar facturas. Exportar vive en Reportes.
  useTopbarActions(
    <>
      <PeriodoSelect
        value={periodo}
        options={periodos ?? []}
        onChange={setPeriodo}
      />
      <Button variant="brand" asChild>
        <Link href={`${base}/finanzas`}>
          <Upload className="h-3.75 w-3.75" aria-hidden />
          Cargar facturas
        </Link>
      </Button>
    </>,
    [periodo, periodosKey, base],
  );

  if (home === undefined || !home.allowed) {
    return <DashboardSkeleton />;
  }

  const isContadoraOnly =
    !home.isPlatform &&
    home.myRoles.includes("contadora") &&
    !home.myRoles.includes("administrador");

  /* Fase 4 (F-19): el recaudo es el de la contabilidad —lo que la factura
   * cobraba menos lo que el estado de cuenta siguiente dice que quedó
   * debiendo—, no la suma del total de las facturas pagadas. Sin el mes
   * siguiente cargado no se puede calcular, y se dice. */
  const recaudoContable = current?.recaudoContable ?? null;
  const recaudo = recaudoContable ?? 0;
  const carteraPendiente = current
    ? Math.max(0, current.sumaTotalAPagar - current.sumaPagado)
    : 0;
  const alDia = current ? current.pagadas : 0;
  const totalFacturas = current?.total ?? 0;
  const pctAlDia =
    totalFacturas > 0 ? Math.round((alDia / totalFacturas) * 100) : 0;
  const pctRecaudo =
    current && current.sumaTotalAPagar > 0
      ? Math.round((recaudo / current.sumaTotalAPagar) * 1000) / 10
      : 0;

  const recaudoDelta =
    recaudoContable !== null && prev?.recaudoContable
      ? Math.round(((recaudoContable - prev.recaudoContable) / prev.recaudoContable) * 100)
      : null;
  const carteraDelta =
    prev && prev.sumaTotalAPagar - prev.sumaPagado > 0
      ? Math.round(
          ((carteraPendiente - (prev.sumaTotalAPagar - prev.sumaPagado)) /
            (prev.sumaTotalAPagar - prev.sumaPagado)) *
            100,
        )
      : null;

  const barSlice =
    selectedIdx >= 0 && serie
      ? serie.slice(0, selectedIdx + 1).slice(-6)
      : (serie ?? []).slice(-6);
  const barData = barSlice.map(
    (p: { periodo: string; sumaPagado: number; sumaTotalAPagar: number; recaudoContable: number | null }) => ({
      label: periodoCorto(p.periodo),
      recaudo: p.recaudoContable ?? 0,
      vencida: Math.max(0, p.sumaTotalAPagar - p.sumaPagado),
    }),
  );

  const periodoLabelTxt = periodo ? formatPeriodoLabel(periodo) : null;
  const rawName = home.userName?.trim() ?? "";
  const firstName = rawName.split(/\s+/)[0] || "";
  const greeting = firstName ? `Hola, ${firstName}` : "Hola";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageContainer>
        <div className="flex flex-col gap-6">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              {greeting}{" "}
              <span aria-hidden>👋</span>
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {isContadoraOnly
                ? `Resumen financiero · ${home.condominio.name}`
                : `Resumen de ${home.condominio.name}`}
              {periodoLabelTxt ? ` · ${periodoLabelTxt}` : ""}
            </p>
          </div>

          {/* KPIs */}
          <div
            className={cn(
              "grid grid-cols-1 gap-4",
              isContadoraOnly
                ? "sm:grid-cols-2 xl:grid-cols-4"
                : "sm:grid-cols-3",
            )}
          >
            <StatCard
              icon={CircleDollarSign}
              tone="brand"
              label={isContadoraOnly ? "% Recaudo del mes (contabilidad)" : "Recaudo del mes (contabilidad)"}
              value={
                !current
                  ? "—"
                  : recaudoContable === null
                    ? "Sin calcular"
                    : isContadoraOnly
                      ? `${pctRecaudo}%`
                      : compactCop(recaudo)
              }
              badge={
                current && recaudoContable === null
                  ? "Falta el mes siguiente"
                  : isContadoraOnly
                  ? current
                    ? `${compactCop(recaudo)} de ${compactCop(current.sumaTotalAPagar)}`
                    : undefined
                  : recaudoDelta != null
                    ? `${recaudoDelta >= 0 ? "↑" : "↓"} ${Math.abs(recaudoDelta)}%`
                    : undefined
              }
              badgeTone={
                !isContadoraOnly &&
                recaudoDelta != null &&
                recaudoDelta < 0
                  ? "negative"
                  : "positive"
              }
              href={`${base}/finanzas`}
            />
            <StatCard
              icon={Wallet}
              tone="neutral"
              label={isContadoraOnly ? "Total facturado" : "Cartera pendiente"}
              value={
                current
                  ? compactCop(
                      isContadoraOnly
                        ? current.sumaTotalAPagar
                        : carteraPendiente,
                    )
                  : "—"
              }
              badge={
                isContadoraOnly
                  ? periodoLabelTxt ?? undefined
                  : carteraDelta != null
                    ? `${carteraDelta >= 0 ? "↑" : "↓"} ${Math.abs(carteraDelta)}%`
                    : undefined
              }
              badgeTone={
                !isContadoraOnly &&
                carteraDelta != null &&
                carteraDelta > 0
                  ? "negative"
                  : "positive"
              }
              href={`${base}/finanzas`}
            />
            {isContadoraOnly ? (
              <>
                <StatCard
                  icon={Clock}
                  tone="warning"
                  label="Facturas pendientes"
                  value={current ? current.pendientes + current.abonadas : "—"}
                  badge="Por cobrar"
                  badgeTone="pending"
                  href={`${base}/finanzas`}
                />
                <StatCard
                  icon={AlertTriangle}
                  tone="destructive"
                  label="Facturas vencidas"
                  value={current ? current.vencidas : "—"}
                  badge="Con mora"
                  badgeTone="negative"
                  href={`${base}/finanzas`}
                />
              </>
            ) : (
              <StatCard
                icon={DoorOpen}
                tone="neutral"
                label="Unidades al día"
                value={
                  current && detail
                    ? `${alDia}/${detail.unidadCount || totalFacturas}`
                    : current
                      ? `${alDia}/${totalFacturas}`
                      : "—"
                }
                badge={current ? `${pctAlDia}%` : undefined}
                badgeTone="positive"
                href={`${base}/unidades`}
              />
            )}
          </div>

          {isContadoraOnly ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {(
                [
                  {
                    href: `${base}/finanzas`,
                    label: "Finanzas",
                    hint: "Facturas y cartera",
                    icon: Receipt,
                  },
                  {
                    href: `${base}/reportes`,
                    label: "Reportes",
                    hint: "Indicadores",
                    icon: ChartColumn,
                  },
                  {
                    href: `${base}/documentos`,
                    label: "Documentos",
                    hint: "Archivos",
                    icon: FolderOpen,
                  },
                  {
                    href: `${base}/consejo`,
                    label: "Consejo",
                    hint: "Junta directiva",
                    icon: Users,
                  },
                ] as const
              ).map((a) => (
                <Link
                  key={a.href}
                  href={a.href}
                  className="group flex items-center gap-3 rounded-2xl border border-border bg-card px-3.5 py-3 transition-colors hover:bg-accent/40"
                >
                  <span className="grid h-9 w-9 place-items-center rounded-xl bg-muted text-foreground/70 transition-colors group-hover:bg-brand/10 group-hover:text-brand">
                    <a.icon className="h-4 w-4" aria-hidden />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-foreground">
                      {a.label}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {a.hint}
                    </span>
                  </span>
                </Link>
              ))}
            </div>
          ) : null}

          {/* ~70% líneas + ~30% estado */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-10">
            <Card className="lg:col-span-7">
              <CardHeader className="mb-0">
                <CardTitle>Cobrado vs. por cobrar</CardTitle>
                <CardDescription>
                  {periodoLabelTxt
                    ? `Hasta ${periodoLabelTxt} · últimos ${barData.length || 6} meses`
                    : "Comparación mes a mes"}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {serie === undefined ? (
                  <Skeleton className="mt-4 h-57.5 w-full rounded-xl" />
                ) : barData.length === 0 ? (
                  <p className="py-16 text-center text-sm text-muted-foreground">
                    Aún no hay facturas cargadas.
                  </p>
                ) : (
                  <TwinBars data={barData} />
                )}
              </CardContent>
            </Card>

            <Card className="lg:col-span-3">
              <CardHeader className="mb-0">
                <CardTitle>Estado de cartera</CardTitle>
                <CardDescription>
                  {periodoLabelTxt ?? "Período actual"}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {serie === undefined ? (
                  <div className="mt-2 flex flex-col items-center gap-4">
                    <Skeleton className="h-36 w-36 rounded-full" />
                    <Skeleton className="h-16 w-full" />
                  </div>
                ) : current ? (
                  <DonutChart
                    size={140}
                    thickness={16}
                    centerValue={`${pctAlDia}%`}
                    centerLabel="al día"
                    data={[
                      {
                        label: "Al día",
                        value: current.pagadas,
                        color: CHART.primary,
                      },
                      {
                        label: "Pendientes",
                        value: current.pendientes + current.abonadas,
                        color: CHART.slate,
                      },
                      {
                        label: "Vencidas",
                        value: current.vencidas,
                        color: CHART.danger,
                      },
                    ]}
                  />
                ) : (
                  <p className="py-16 text-center text-sm text-muted-foreground">
                    Sin datos.
                  </p>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Una sola lista de acción */}
          <Card>
            <CardHeader className="mb-3 flex-row items-center justify-between gap-3">
              <div>
                <CardTitle>Pagos recientes</CardTitle>
                <CardDescription>
                  {pagosRecientes
                    ? `${pagosRecientes.length} recientes${periodoLabelTxt ? ` · ${periodoLabelTxt}` : ""}`
                    : "…"}
                </CardDescription>
              </div>
              <Button variant="ghost" size="sm" asChild>
                <Link href={`${base}/finanzas`}>Ver todos</Link>
              </Button>
            </CardHeader>
            <CardContent>
              {pagosRecientes === undefined ? (
                <Skeleton className="h-48 w-full rounded-xl" />
              ) : pagosRecientes.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  No hay facturas en este período.
                </p>
              ) : (
                <div className="overflow-hidden">
                  <table className="w-full table-fixed border-collapse text-[12px]">
                    <thead>
                      <tr className="border-b border-border/70">
                        <th className="w-[28%] px-2 py-2.5 text-left text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          Factura
                        </th>
                        <th className="w-[36%] px-2 py-2.5 text-left text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          Residente
                        </th>
                        <th className="w-[16%] px-2 py-2.5 text-right text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          Valor
                        </th>
                        <th className="w-[20%] px-2 py-2.5 text-left text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          Estado
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {pagosRecientes.map((f, i) => (
                        <tr
                          key={f._id}
                          className="border-b border-border/50 last:border-b-0"
                        >
                          <td className="max-w-0 px-2 py-3 align-middle">
                            <p
                              className="truncate font-medium text-foreground"
                              title={f.numeroFactura}
                            >
                              {f.numeroFactura.replace(/^FAC-/, "")}
                            </p>
                            <p className="truncate text-[11px] text-muted-foreground">
                              {f.apto ? `Apto ${f.apto}` : f.numeroInterno}
                            </p>
                          </td>
                          <td className="max-w-0 px-2 py-3 align-middle">
                            <div className="flex min-w-0 items-center gap-2">
                              <div
                                className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-[9px] font-semibold text-white ${AVATAR_COLORS[i % AVATAR_COLORS.length]}`}
                              >
                                {initials(f.residenteNombre)}
                              </div>
                              <p
                                className="truncate font-medium capitalize text-foreground"
                                title={f.residenteNombre}
                              >
                                {f.residenteNombre.toLowerCase()}
                              </p>
                            </div>
                          </td>
                          <td className="whitespace-nowrap px-2 py-3 text-right font-medium tabular-nums text-foreground">
                            {cop(f.totalAPagar)}
                          </td>
                          <td className="px-2 py-3 align-middle">
                            {/* La vigente de una unidad en mora se ve "Vencida"
                                aunque se guarde `pendiente` (H2). */}
                            <Badge
                              tone={ESTADO_TONE[f.estadoVisible === "vencida" ? "vencida" : f.estado] ?? "neutral"}
                              className="max-w-full truncate text-[10px]"
                            >
                              {ESTADO_LABEL[f.estadoVisible === "vencida" ? "vencida" : f.estado] ?? f.estado}
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
        </div>
      </PageContainer>
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="flex flex-col">
      <PageContainer>
        <div className="flex flex-col gap-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-19 rounded-[14px]" />
            ))}
          </div>
          <Skeleton className="h-72 w-full rounded-[14px]" />
          <Skeleton className="h-64 w-full rounded-[14px]" />
        </div>
      </PageContainer>
    </div>
  );
}
