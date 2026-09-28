"use client";

import { useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { TrendingUp, Wallet, Building2, Users, PieChart } from "lucide-react";
import { api } from "@vekino/backend/api";
import type { Id } from "@vekino/backend/dataModel";
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
import { Select } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { AreaChart } from "@/components/charts/area-chart";
import { DonutChart } from "@/components/charts/donut-chart";
import { HBars } from "@/components/charts/h-bars";
import { CHART } from "@/components/charts/chart-colors";
import { cn, cop, num } from "@/lib/utils";
import { CobrosParqueaderoPanel } from "@/components/vehiculos/cobros-parqueadero";
import { ReporteReservasPanel } from "@/components/reservas/reporte-reservas";

const MES_LARGO = [
  "Enero",
  "Febrero",
  "Marzo",
  "Abril",
  "Mayo",
  "Junio",
  "Julio",
  "Agosto",
  "Septiembre",
  "Octubre",
  "Noviembre",
  "Diciembre",
];
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
  return `${MES_CORTO[Number(m) - 1] ?? m} ${String(y).slice(2)}`;
}

function periodoLargo(p: string) {
  const [y, m] = p.split("-");
  return `${MES_LARGO[Number(m) - 1] ?? m} ${y}`;
}

const ROLE_LABEL: Record<string, string> = {
  administrador: "Administrador",
  propietario: "Propietario",
  apoderado: "Apoderado",
  arrendatario: "Arrendatario",
  residente: "Residente",
  contadora: "Contadora",
  guardia: "Guardia",
  junta_directiva: "Junta directiva",
  representante_asamblea: "Rep. asamblea",
};

type Tab = "monetarios" | "parqueaderos" | "reservas";

const TABS: { id: Tab; label: string }[] = [
  { id: "monetarios", label: "Cartera" },
  { id: "parqueaderos", label: "Parqueaderos" },
  { id: "reservas", label: "Reservas" },
];

export default function ReportesPage() {
  const params = useParams<{ id: string }>();
  const condominioId = params.id as Id<"condominios">;
  const [tab, setTab] = useState<Tab>("monetarios");
  const serie = useQuery(api.facturas.serie, { condominioId });
  const unidades = useQuery(api.unidades.listDetailed, { condominioId });
  const members = useQuery(api.memberships.listByCondominio, { condominioId });

  const loading =
    serie === undefined || unidades === undefined || members === undefined;

  return (
    <PageContainer>
      <div className="space-y-8">
        <PageHeader
          title="Reportes"
          description="Cartera, aporte voluntario de parqueaderos y reservas"
        />

        <div className="flex gap-1 rounded-xl bg-muted p-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={cn(
                "flex-1 cursor-pointer rounded-lg px-4 py-1.5 text-sm font-medium transition-colors",
                tab === t.id ? "bg-card text-foreground shadow-sm" : "text-muted-foreground",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === "parqueaderos" ? (
          <CobrosParqueaderoPanel condominioId={condominioId} />
        ) : tab === "reservas" ? (
          <ReporteReservasPanel condominioId={condominioId} />
        ) : loading ? (
          <ReportesSkeleton />
        ) : serie.length === 0 && unidades.length === 0 ? (
          <EmptyState
            icon={PieChart}
            title="Aún no hay datos para reportar"
            description="Cuando cargues facturas y unidades, aquí verás los indicadores del conjunto."
          />
        ) : (
          <ReportesContent
            serie={serie}
            unidades={unidades}
            members={members}
          />
        )}
      </div>
    </PageContainer>
  );
}

type Serie = FunctionReturnType<typeof api.facturas.serie>;
type Unidades = FunctionReturnType<typeof api.unidades.listDetailed>;
type Members = FunctionReturnType<typeof api.memberships.listByCondominio>;

function ReportesContent({
  serie,
  unidades,
  members,
}: {
  serie: Serie;
  unidades: Unidades;
  members: Members;
}) {
  const periodos = useMemo(
    () => [...serie].sort((a, b) => a.periodo.localeCompare(b.periodo)),
    [serie],
  );
  const defaultPeriodo = periodos[periodos.length - 1]?.periodo ?? "";
  const [periodo, setPeriodo] = useState(defaultPeriodo);

  const selected =
    periodos.find((p) => p.periodo === periodo) ??
    periodos[periodos.length - 1] ??
    null;

  const totalRecaudo = periodos.reduce((s, p) => s + p.sumaPagado, 0);
  const recaudoPct =
    selected && selected.total > 0
      ? Math.round((selected.pagadas / selected.total) * 100)
      : 0;

  const ocupadas = unidades.filter((u) => u.estado === "ocupada").length;
  const desocupadas = unidades.length - ocupadas;
  const ocupacionPct =
    unidades.length > 0 ? Math.round((ocupadas / unidades.length) * 100) : 0;

  const tipoMap = new Map<string, number>();
  for (const u of unidades) tipoMap.set(u.tipo, (tipoMap.get(u.tipo) ?? 0) + 1);
  const tipoColors = [CHART.primary, CHART.brand, CHART.violet, CHART.sky];
  const tipoData = [...tipoMap.entries()].map(([tipo, value], i) => ({
    label: tipo.charAt(0).toUpperCase() + tipo.slice(1),
    value,
    color: tipoColors[i % tipoColors.length]!,
  }));

  const rolMap = new Map<string, number>();
  for (const m of members)
    for (const r of m.roles) rolMap.set(r, (rolMap.get(r) ?? 0) + 1);
  const rolData = [...rolMap.entries()].map(([r, value]) => ({
    label: ROLE_LABEL[r] ?? r,
    value,
  }));

  return (
    <>
      {/* Selector de mes del reporte */}
      <div className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-medium text-foreground">Mes del reporte</p>
          <p className="text-xs text-muted-foreground">
            Los KPIs y el estado de facturas usan el período seleccionado.
          </p>
        </div>
        <Select
          value={periodo || defaultPeriodo}
          onChange={(e) => setPeriodo(e.target.value)}
          className="sm:w-56"
          disabled={periodos.length === 0}
        >
          {periodos.length === 0 ? (
            <option value="">Sin períodos</option>
          ) : (
            [...periodos].reverse().map((p) => (
              <option key={p.periodo} value={p.periodo}>
                {periodoLargo(p.periodo)}
              </option>
            ))
          )}
        </Select>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          icon={Wallet}
          label="Cartera del mes"
          value={selected ? cop(selected.sumaTotalAPagar) : "—"}
          hint={selected ? periodoCorto(selected.periodo) : undefined}
          tone="brand"
        />
        <StatCard
          icon={TrendingUp}
          label="Recaudo del mes"
          value={selected ? cop(selected.sumaPagado) : "—"}
          hint={`${recaudoPct}% pagado · acum. ${cop(totalRecaudo)}`}
          tone="success"
        />
        <StatCard
          icon={Building2}
          label="Ocupación"
          value={`${ocupacionPct}%`}
          hint={`${ocupadas} de ${unidades.length} unidades`}
        />
        <StatCard
          icon={Users}
          label="Comunidad"
          value={num(members.length)}
          hint="Residentes registrados"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Cartera por período</CardTitle>
          <CardDescription>Total facturado en cada mes</CardDescription>
        </CardHeader>
        <CardContent>
          {periodos.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Sin períodos facturados.
            </p>
          ) : (
            <AreaChart
              data={periodos.map((p) => ({
                label: periodoCorto(p.periodo),
                value: p.sumaTotalAPagar,
              }))}
              color={CHART.brand}
              format={cop}
            />
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Estado de facturas</CardTitle>
            <CardDescription>
              {selected ? periodoLargo(selected.periodo) : "Sin período"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {selected ? (
              <DonutChart
                centerValue={selected.total}
                centerLabel="facturas"
                data={[
                  {
                    label: "Pagadas",
                    value: selected.pagadas,
                    color: CHART.emerald,
                  },
                  {
                    label: "Pendientes",
                    value: selected.pendientes,
                    color: CHART.amber,
                  },
                  {
                    label: "Vencidas",
                    value: selected.vencidas,
                    color: CHART.red,
                  },
                ]}
              />
            ) : (
              <p className="py-8 text-center text-sm text-muted-foreground">
                Sin datos.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Ocupación</CardTitle>
            <CardDescription>Estado de las unidades</CardDescription>
          </CardHeader>
          <CardContent>
            <DonutChart
              centerValue={`${ocupacionPct}%`}
              centerLabel="ocupadas"
              data={[
                { label: "Ocupadas", value: ocupadas, color: CHART.emerald },
                {
                  label: "Desocupadas",
                  value: desocupadas,
                  color: CHART.slate,
                },
              ]}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Tipo de unidad</CardTitle>
            <CardDescription>Distribución del inventario</CardDescription>
          </CardHeader>
          <CardContent>
            <DonutChart
              centerValue={unidades.length}
              centerLabel="unidades"
              data={tipoData}
            />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Residentes por rol</CardTitle>
          <CardDescription>Composición de la comunidad</CardDescription>
        </CardHeader>
        <CardContent>
          {rolData.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              Sin roles asignados.
            </p>
          ) : (
            <HBars data={rolData} color={CHART.primary} />
          )}
        </CardContent>
      </Card>
    </>
  );
}

function ReportesSkeleton() {
  return (
    <>
      <Skeleton className="h-20 rounded-2xl" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-32 rounded-2xl" />
        ))}
      </div>
      <Skeleton className="h-72 rounded-2xl" />
      <div className="grid gap-6 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-64 rounded-2xl" />
        ))}
      </div>
    </>
  );
}
