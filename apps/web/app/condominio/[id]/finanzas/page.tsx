"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { useQuery, useMutation, usePaginatedQuery } from "convex/react";
import {
  FileText, ExternalLink, TrendingUp, Clock, CheckCircle2, AlertTriangle,
  RefreshCcw, Loader2, PiggyBank, Wallet,
} from "lucide-react";
import { api } from "@vekino/backend/api";
import type { Doc, Id } from "@vekino/backend/dataModel";
import { UploadFacturas } from "@/components/upload-facturas";
import { CreateFacturaForm } from "@/components/create-factura-form";
import { PageContainer } from "@/components/layout/page-container";
import { PageHeader } from "@/components/layout/page-header";
import { useTopbarActions } from "@/components/layout/admin-topbar-context";
import { PeriodoSelect, formatPeriodoLabel } from "@/components/layout/periodo-select";
import { StatCard } from "@/components/layout/stat-card";
import { SearchInput, Select } from "@/components/ui/input";
import { TableCard, Table, THead, TH, TBody, TR, TD, CellStack } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { usePersistedPeriodo } from "@/hooks/use-persisted-periodo";
import { cop } from "@/lib/utils";
import { periodoDe } from "@vekino/backend/periodos";
import { MENSAJE_LECTURA, type MotivoLectura } from "@vekino/backend/lecturaFactura";
import {
  ETIQUETA_SIN_VERIFICAR,
  TEXTO_SIN_VERIFICAR,
  fechaLimiteDescuentoDe,
  leerMontoPesos,
} from "@vekino/backend/cartera";
import { PagosPorRevisar } from "@/components/finanzas/pagos-por-revisar";
import { MesesFaltantes } from "@/components/finanzas/meses-faltantes";
import { HistorialFactura } from "@/components/finanzas/historial-factura";
import { fechaPlazo } from "@/components/portal/portal-ui";

/** Lo que dice el veredicto de la contabilidad (la factura siguiente). */
const VEREDICTO_LABEL: Record<string, string> = {
  pagada: "pagada",
  abonada: "abonada",
  vencida: "vencida",
  saldo_a_favor: "con saldo a favor",
  sin_veredicto: "sin veredicto (falta el mes siguiente)",
};

const PAGE_SIZE = 30;

const ESTADO_TONE: Record<string, React.ComponentProps<typeof Badge>["tone"]> = {
  /* Historica que quedo pendiente: no se sabe si se pago (Fase 4). */
  sin_verificar: "neutral",
  pendiente: "warning",
  pagada: "success",
  vencida: "destructive",
  abonada: "info",
  saldo_a_favor: "violet",
};
const ESTADO_LABEL: Record<string, string> = {
  sin_verificar: ETIQUETA_SIN_VERIFICAR,
  pendiente: "Pendiente",
  pagada: "Pagada",
  vencida: "Vencida",
  abonada: "Abonada",
  saldo_a_favor: "Saldo a favor",
};

/** La fila de la tabla: la factura y el estado que se muestra (Fase 4). */
type Factura = Doc<"facturas"> & { estadoVisible?: string };

/**
 * "Sin verificar" en vez de "Pendiente" para una historica (Fase 4), y
 * "Vencida" para la vigente de una unidad en mora, que se guarda `pendiente`
 * (QA de comprobantes, H2); si no, el estado.
 */
function estadoMostrado(f: Factura): string {
  return f.estadoVisible === "sin_verificar" || f.estadoVisible === "vencida"
    ? f.estadoVisible
    : f.estado;
}

function useDebounced(value: string, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export default function FinanzasPage() {
  const params = useParams<{ id: string }>();
  const condominioId = params.id as Id<"condominios">;
  const condominioData = useQuery(api.condominios.adminHome, { condominioId });
  const periodos = useQuery(api.facturas.listPeriodos, { condominioId });
  const { periodo, setPeriodo } = usePersistedPeriodo(condominioId, periodos);
  const [uploadKey, setUploadKey] = useState(0);

  /* El respaldo era "2026-03" escrito a mano: un conjunto sin facturas
   * aterrizaba en marzo de 2026 para siempre. El mes de hoy al menos es
   * cierto. */
  const periodoActivo = periodo ?? periodos?.[0] ?? periodoDe(new Date());
  const resumen = useQuery(api.facturas.resumenPeriodo, { condominioId, periodo: periodoActivo });

  const [search, setSearch] = useState("");
  const deferredSearch = useDebounced(search, 280);
  const [filtroEstado, setFiltroEstado] = useState<
    "" | "pendiente" | "pagada" | "vencida" | "abonada" | "saldo_a_favor"
  >("");
  const [facturaDetalle, setFacturaDetalle] = useState<Factura | null>(null);

  const { results: facturas, status, loadMore } = usePaginatedQuery(
    api.facturas.listPage,
    {
      condominioId,
      periodo: periodoActivo,
      q: deferredSearch.trim() || undefined,
      estado: filtroEstado || undefined,
    },
    { initialNumItems: PAGE_SIZE },
  );

  const loading = status === "LoadingFirstPage";
  const canLoadMore = status === "CanLoadMore";
  const loadingMore = status === "LoadingMore";

  const reconciliar = useMutation(api.facturas.reconciliar);
  const [conciliando, setConciliando] = useState(false);
  const [conciliacionMsg, setConciliacionMsg] = useState<string | null>(null);

  async function handleReconciliar() {
    setConciliando(true);
    setConciliacionMsg(null);
    try {
      const r = await reconciliar({ condominioId });
      const cambios = r.pagadas + r.abonadas + r.vencidas;
      setConciliacionMsg(
        cambios === 0
          ? `Todo al día: ${r.facturas} facturas de ${r.unidades} unidades ya estaban conciliadas.`
          : `Conciliación lista: ${r.pagadas} pagadas · ${r.abonadas} abonadas · ${r.vencidas} vencidas (${r.unidades} unidades revisadas).`
      );
    } catch (e) {
      setConciliacionMsg(e instanceof Error ? e.message : "Error al conciliar.");
    } finally {
      setConciliando(false);
    }
  }

  const hasFilters = Boolean(deferredSearch.trim() || filtroEstado);
  const totalLabel = resumen?.total;

  useTopbarActions(
    <>
      <Button variant="outline" onClick={handleReconciliar} disabled={conciliando}>
        {conciliando ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        ) : (
          <RefreshCcw className="h-4 w-4" aria-hidden />
        )}
        Conciliar
      </Button>
      <CreateFacturaForm
        condominioId={condominioId}
        defaultPeriodo={periodoActivo}
      />
      {/* Para cualquier conjunto, tenga o no `legacyId` (Hallazgo 2). La ve
          quien entra al área de administración (`adminHome`: administración,
          contadora y plataforma), los mismos que `facturas.destinoCarga`
          deja cargar. */}
      {condominioData?.allowed && (
        <UploadFacturas
          key={uploadKey}
          condominioId={condominioId}
          onDone={() => setUploadKey((k) => k + 1)}
        />
      )}
      <PeriodoSelect
        value={periodoActivo}
        options={periodos ?? []}
        onChange={(p) => {
          setPeriodo(p);
          setFacturaDetalle(null);
        }}
      />
    </>,
    [
      conciliando,
      condominioId,
      periodoActivo,
      uploadKey,
      condominioData?.allowed,
      (periodos ?? []).join("|"),
    ],
  );

  return (
    <PageContainer>
      <div className="space-y-6">
        <PageHeader
          title="Finanzas"
          description="Cuentas de cobro y estado de cartera"
        />

        {conciliacionMsg && (
          <div className="flex items-start gap-2 rounded-xl border border-border bg-muted/40 px-4 py-3 text-sm text-foreground">
            <RefreshCcw className="mt-0.5 h-4 w-4 shrink-0 text-brand" aria-hidden />
            <p>{conciliacionMsg}</p>
            <button
              onClick={() => setConciliacionMsg(null)}
              className="ml-auto text-xs text-muted-foreground hover:text-foreground"
            >
              Cerrar
            </button>
          </div>
        )}

        <EnRevision condominioId={condominioId} />
        <PagosPorRevisar condominioId={condominioId} />
        <MesesFaltantes condominioId={condominioId} />

        {/* KPIs */}
        {resumen ? (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
            <StatCard icon={TrendingUp} label="Total cartera" value={cop(resumen.sumaTotalAPagar)} hint="Facturado en el período" />
            <StatCard icon={Clock} label="Pendientes" value={resumen.pendientes} hint={`de ${resumen.total} facturas`} tone="warning" />
            <StatCard
              icon={CheckCircle2}
              label="Pagadas"
              value={resumen.pagadas}
              hint={
                /* Fase 4 (F-19): recaudo de la contabilidad, no el total de las pagadas. */
                resumen.recaudoContable !== null
                  ? `Recaudo (contabilidad): ${cop(resumen.recaudoContable)} · En Vekino: ${cop(resumen.recaudoVekino)}`
                  : `Recaudo: falta el mes siguiente · En Vekino: ${cop(resumen.recaudoVekino)}`
              }
              tone="success"
            />
            <StatCard icon={PiggyBank} label="Abonadas" value={resumen.abonadas ?? 0} hint="Pago parcial" tone="primary" />
            <StatCard icon={AlertTriangle} label="Vencidas" value={resumen.vencidas} hint="Con mora" tone="destructive" />
            {(resumen.saldoAFavorCount ?? 0) > 0 ? (
              <StatCard icon={Wallet} label="Saldo a favor" value={resumen.saldoAFavorCount} hint="Crédito del residente" tone="primary" />
            ) : null}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-32 rounded-2xl" />
            ))}
          </div>
        )}

        {/* Toolbar */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted-foreground">
            {loading
              ? "Cargando…"
              : totalLabel != null
                ? `${facturas.length} de ${totalLabel} facturas`
                : `${facturas.length} facturas`}
          </p>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Select
              value={filtroEstado}
              onChange={(e) => setFiltroEstado(e.target.value as typeof filtroEstado)}
              className="sm:w-44"
            >
              <option value="">Todos los estados</option>
              <option value="pendiente">Pendiente</option>
              <option value="pagada">Pagada</option>
              <option value="abonada">Abonada</option>
              <option value="vencida">Vencida</option>
              <option value="saldo_a_favor">Saldo a favor</option>
            </Select>
            <SearchInput
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar residente o apto"
              className="sm:w-72"
            />
          </div>
        </div>

        {/* Tabla */}
        {loading ? (
          <TableSkeleton />
        ) : facturas.length === 0 ? (
          <EmptyState
            icon={FileText}
            title={hasFilters ? "Sin resultados" : "Sin facturas"}
            description={
              hasFilters
                ? "Ninguna factura coincide con los filtros."
                : "Aún no hay facturas para este período. Súbelas desde el botón superior."
            }
            action={
              hasFilters ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setSearch("");
                    setFiltroEstado("");
                  }}
                >
                  Limpiar filtros
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            <TableCard>
              <Table>
                <THead>
                  <tr>
                    <TH className="hidden md:table-cell">Factura</TH>
                    <TH>Residente</TH>
                    <TH>Estado</TH>
                    <TH className="text-right">Total</TH>
                    <TH className="text-right">Acciones</TH>
                  </tr>
                </THead>
                <TBody>
                  {facturas.map((f) => (
                    <TR key={f._id}>
                      <TD className="hidden md:table-cell">
                        <CellStack
                          primary={f.numeroFactura}
                          secondary={`ID ${f.numeroInterno}`}
                        />
                      </TD>
                      <TD>
                        <CellStack
                          primary={f.residenteNombre}
                          secondary={f.apto ? `Apto ${f.apto}` : "Sin unidad"}
                        />
                      </TD>
                      <TD>
                        <div className="flex flex-wrap items-center gap-1">
                          <Badge
                            tone={ESTADO_TONE[estadoMostrado(f)] ?? "neutral"}
                            title={estadoMostrado(f) === "sin_verificar" ? TEXTO_SIN_VERIFICAR : undefined}
                          >
                            {ESTADO_LABEL[estadoMostrado(f)] ?? f.estado}
                          </Badge>
                          {f.lecturaDudosa && !f.lecturaDudosa.confirmada ? (
                            <Badge tone="warning">En revisión</Badge>
                          ) : null}
                          {f.pagoEnVerificacion ? (
                            <Badge tone="info">Pago en verificación</Badge>
                          ) : null}
                        </div>
                      </TD>
                      <TD className="text-right font-medium tabular-nums text-foreground">
                        {cop(f.totalAPagar)}
                      </TD>
                      <TD className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              setFacturaDetalle(
                                facturaDetalle?._id === f._id ? null : f,
                              )
                            }
                          >
                            Ver detalle
                          </Button>
                          {f.pdfUrl && (
                            <a
                              href={f.pdfUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              aria-label="Abrir PDF"
                              className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                            >
                              <ExternalLink className="h-4 w-4" />
                            </a>
                          )}
                        </div>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableCard>

            {canLoadMore || loadingMore ? (
              <div className="flex justify-center">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={loadingMore}
                  onClick={() => loadMore(PAGE_SIZE)}
                >
                  {loadingMore ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                      Cargando…
                    </>
                  ) : (
                    "Cargar más"
                  )}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>

      {/* Detalle */}
      {facturaDetalle && (
        <Modal
          open
          onClose={() => setFacturaDetalle(null)}
          title={facturaDetalle.residenteNombre}
          description={`${facturaDetalle.numeroFactura} · Apto ${facturaDetalle.apto ?? "—"} · ${formatPeriodoLabel(facturaDetalle.periodo)}`}
          footer={
            <>
              {facturaDetalle.pdfUrl && (
                <Button variant="outline" size="sm" asChild>
                  <a href={facturaDetalle.pdfUrl} target="_blank" rel="noopener noreferrer">
                    <FileText className="h-4 w-4" aria-hidden />
                    Ver PDF
                  </a>
                </Button>
              )}
              <Button size="sm" onClick={() => setFacturaDetalle(null)}>Cerrar</Button>
            </>
          }
        >
          <div className="mb-3 flex justify-end">
            <Badge tone={ESTADO_TONE[estadoMostrado(facturaDetalle)] ?? "neutral"}>
              {ESTADO_LABEL[estadoMostrado(facturaDetalle)] ?? facturaDetalle.estado}
            </Badge>
            {estadoMostrado(facturaDetalle) === "sin_verificar" ? (
              <span className="ml-2 text-xs text-muted-foreground">{TEXTO_SIN_VERIFICAR}</span>
            ) : null}
          </div>
          <div className="overflow-hidden rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-brand/[0.07] text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Concepto</th>
                  <th className="px-4 py-2 text-right font-medium">Ant.</th>
                  <th className="px-4 py-2 text-right font-medium">Actual</th>
                  <th className="px-4 py-2 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {/* Los créditos (anticipos, notas crédito, saldo a favor) son
                    negativos: se muestran, no se esconden como "—". */}
                {facturaDetalle.lineas.map((l, i) => (
                  <tr
                    key={i}
                    className={`even:bg-brand/[0.035] ${l.total !== 0 ? "" : "text-muted-foreground/60"}`}
                  >
                    <td className="px-4 py-2">{l.concepto}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{l.saldoAnterior !== 0 ? cop(l.saldoAnterior) : "—"}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{l.actual !== 0 ? cop(l.actual) : "—"}</td>
                    <td className={`px-4 py-2 text-right font-medium tabular-nums ${l.total !== 0 ? "text-foreground" : ""}`}>
                      {l.total !== 0 ? cop(l.total) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                {facturaDetalle.totalConDescuento != null && facturaDetalle.totalConDescuento > 0 && (
                  <tr className="border-t border-border bg-emerald-500/5">
                    <td colSpan={3} className="px-4 py-2 text-xs font-medium text-emerald-600">
                      {/* La fecha real del descuento: la del documento, o el 15 del mes del período (Fase 3). */}
                      Con descuento, hasta el {fechaPlazo(fechaLimiteDescuentoDe(facturaDetalle) ?? 0)}
                      {facturaDetalle.fechaLimiteDescuento == null ? " (regla del día 15)" : ""}
                    </td>
                    <td className="px-4 py-2 text-right text-sm font-bold tabular-nums dark:text-emerald-400">
                      {cop(facturaDetalle.totalConDescuento)}
                    </td>
                  </tr>
                )}
                <tr className="border-t border-border bg-muted/40">
                  <td colSpan={3} className="px-4 py-2.5 text-sm font-semibold text-foreground">
                    {facturaDetalle.totalConDescuento != null && facturaDetalle.totalConDescuento > 0
                      ? `Sin descuento, hasta el ${fechaPlazo(facturaDetalle.fechaVencimiento)}`
                      : `Total a pagar · vence el ${fechaPlazo(facturaDetalle.fechaVencimiento)}`}
                  </td>
                  <td className="px-4 py-2.5 text-right text-sm font-bold tabular-nums text-foreground">
                    {cop(facturaDetalle.totalAPagar)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Por qué está en este estado (Fase 3): evidencia, veredicto y pago en verificación. */}
          <div className="mt-4 space-y-1 text-xs text-muted-foreground">
            {facturaDetalle.estadoPago ? (
              <p>
                <span className="font-medium text-foreground">Pagos registrados:</span>{" "}
                {cop(facturaDetalle.estadoPago.montoPagado)} de {cop(facturaDetalle.estadoPago.montoAdeudado)}
                {facturaDetalle.estadoPago.conDescuento ? " (con descuento)" : ""}
                {facturaDetalle.estadoPago.excedente
                  ? ` · ${cop(facturaDetalle.estadoPago.excedente)} de más`
                  : ""}
              </p>
            ) : null}
            {facturaDetalle.veredictoContable ? (
              <p>
                <span className="font-medium text-foreground">Según la factura siguiente:</span>{" "}
                {facturaDetalle.veredictoContable.motivo === "heredado"
                  ? `${VEREDICTO_LABEL[facturaDetalle.veredictoContable.estado] ?? facturaDetalle.veredictoContable.estado} (estado que traía de antes)`
                  : VEREDICTO_LABEL[facturaDetalle.veredictoContable.estado] ?? facturaDetalle.veredictoContable.estado}
                {facturaDetalle.veredictoContable.saldoAnteriorSiguiente !== undefined
                  ? ` · saldo anterior ${cop(facturaDetalle.veredictoContable.saldoAnteriorSiguiente)}`
                  : ""}
              </p>
            ) : null}
            {facturaDetalle.pagoEnVerificacion ? (
              <p className="text-sky-700 dark:text-sky-400">
                Pago en verificación: {cop(facturaDetalle.pagoEnVerificacion.monto)} pagados que la contabilidad
                todavía no refleja. No se cobra en línea mientras tanto.
              </p>
            ) : null}
          </div>

          <details className="mt-4">
            <summary className="cursor-pointer text-sm font-medium text-foreground">Historial de la factura</summary>
            <div className="mt-2">
              <HistorialFactura facturaId={facturaDetalle._id} />
            </div>
          </details>
        </Modal>
      )}
    </PageContainer>
  );
}

/**
 * Facturas en revisión: lecturas del PDF que no cuadran (o sin total, o sin
 * período legible). No se pueden pagar ni deciden la cartera hasta que se
 * vuelva a subir una lectura correcta o la administración la confirme.
 */
function EnRevision({ condominioId }: { condominioId: Id<"condominios"> }) {
  const filas = useQuery(api.facturas.listEnRevision, { condominioId });
  const confirmar = useMutation(api.facturas.confirmarLectura);
  const [confirmando, setConfirmando] = useState<Id<"facturas"> | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!filas || filas.length === 0) return null;

  async function onConfirmar(id: Id<"facturas">, motivos: readonly string[]) {
    /* Sin total en el documento (o empezaba en una hoja de continuación): el
     * número guardado no salió del PDF, y confirmarlo a ciegas lo volvería
     * cobrable. Hay que escribir el total que se ve en el documento (Fase 3). */
    let totalVerificado: number | undefined;
    if (motivos.includes("total_no_leido") || motivos.includes("pagina_de_continuacion")) {
      const escrito = window.prompt(
        "El total de esta factura no salió del documento. Escribe el TOTAL A PAGAR que ves en el PDF (sin descuento). Si es un saldo a favor, con signo menos.",
      );
      if (escrito === null) return;
      const negativo = escrito.trim().startsWith("-");
      const limpio = escrito.replace(/[^\d.,]/g, "");
      const valor = /^0+$/.test(limpio) ? 0 : leerMontoPesos(limpio);
      if (valor === null) {
        setError("El total escrito no es un valor válido. Escríbelo como aparece en el PDF, por ejemplo 342.000.");
        return;
      }
      totalVerificado = negativo ? -valor : valor;
    } else if (!window.confirm("¿Revisaste el PDF y los valores son correctos? La factura quedará disponible para pago.")) {
      return;
    }
    setConfirmando(id);
    setError(null);
    try {
      await confirmar({ facturaId: id, ...(totalVerificado !== undefined ? { totalVerificado } : {}) });
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo confirmar.");
    } finally {
      setConfirmando(null);
    }
  }

  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
      <div className="mb-2 flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" aria-hidden />
        <p className="text-sm font-semibold text-foreground">
          {filas.length} factura{filas.length === 1 ? "" : "s"} en revisión
        </p>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        Su PDF no cuadra o no se pudo leer completo. No se pueden pagar hasta que subas una lectura correcta
        (con "actualizar") o confirmes que los valores están bien.
      </p>
      {error && <p className="mb-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
      <div className="max-h-72 space-y-2 overflow-auto">
        {filas.map((f) => (
          <div key={f._id} className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm">
            <div className="min-w-0">
              <p className="font-medium text-foreground">
                {formatPeriodoLabel(f.periodo)} · Unidad {[f.unidadTorre, f.unidadNumero].filter(Boolean).join(" ")}
                <span className="ml-2 font-normal tabular-nums text-muted-foreground">{cop(f.totalAPagar)}</span>
              </p>
              <p className="text-xs text-muted-foreground">
                {f.motivos.map((m) => MENSAJE_LECTURA[m as MotivoLectura] ?? m).join(" ")}
              </p>
            </div>
            <div className="flex items-center gap-1">
              {f.pdfUrl && (
                <a
                  href={f.pdfUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  aria-label="Abrir PDF"
                >
                  <ExternalLink className="h-4 w-4" />
                </a>
              )}
              <Button variant="outline" size="sm" disabled={confirmando === f._id} onClick={() => onConfirmar(f._id, f.motivos)}>
                {confirmando === f._id ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : "Confirmar lectura"}
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function TableSkeleton() {
  return (
    <TableCard>
      <div className="divide-y divide-border">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 px-5 py-3.5">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-5 w-20 rounded-full" />
            <Skeleton className="ml-auto h-4 w-24" />
          </div>
        ))}
      </div>
    </TableCard>
  );
}
