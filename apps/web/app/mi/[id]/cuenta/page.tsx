"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { useQuery, useAction } from "convex/react";
import { api } from "@vekino/backend/api";
import type { Id } from "@vekino/backend/dataModel";
import {
  ETIQUETA_SIN_VERIFICAR,
  TEXTO_SIN_VERIFICAR,
  abonoAprobado,
  descuentoVigente,
  enRevision,
  estadoVisibleDeFactura,
  fechaLimiteDescuentoDe,
  inicioDeMora,
  mensajePagoEnVerificacion,
  montoAPagarHoy as montoDeHoy,
  montoSinDescuento,
  resumenResidente,
  sinPagar,
  type CarteraUnidad,
} from "@vekino/backend/cartera";
import {
  Download,
  ArrowRight,
  CheckCircle2,
  Loader2,
  ChevronDown,
} from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LiquidGlassCard } from "@/components/portal/liquid-glass-card";
import { PagoNoDisponible, PortalPayButton } from "@/components/portal/portal-pay-button";
import { ComprobantePago } from "@/components/portal/comprobante-pago";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { cop, cn } from "@/lib/utils";
import {
  ESTADO_FACTURA,
  TEXTO_SIN_UNIDAD,
  TITULO_SIN_UNIDAD,
  etiquetaUnidad,
  fechaPlazo,
  periodoHumano,
} from "@/components/portal/portal-ui";

const FECHA_MIN = 946684800000;

/**
 * Lo que se cobra hoy: la misma regla del backend de pagos
 * (`lib/cartera.ts`, `montoAPagarHoy`). El descuento vale hasta SU fecha —la
 * del documento, o el 15 del mes del período—, no hasta el vencimiento
 * (Fase 3, F-06): antes la pantalla ofrecía el descuento un mes de más. Y lo
 * ya abonado (pagos aprobados) no se vuelve a cobrar (QA de comprobantes, H1).
 */
function montoAPagarHoy(f: Factura, ahora = Date.now()) {
  return montoDeHoy(f, ahora);
}

type LineaFactura = {
  codigo: number;
  concepto: string;
  saldoAnterior: number;
  actual: number;
  total: number;
};

type Factura = {
  _id: Id<"facturas">;
  unidadId: Id<"unidades">;
  numeroFactura: string;
  periodo: string;
  periodoLabel: string;
  estado: "pendiente" | "pagada" | "vencida" | "abonada" | "saldo_a_favor";
  totalAPagar: number;
  totalConDescuento?: number;
  /** Hasta cuándo vale el descuento, según el documento (Fase 3). */
  fechaLimiteDescuento?: number;
  saldoAFavor: number;
  fechaVencimiento: number;
  pdfUrl?: string;
  lineas: LineaFactura[];
  /** Lectura dudosa del PDF (Fase 2): en revisión mientras no se confirme. */
  lecturaDudosa?: { motivos: string[]; confirmada?: unknown } | null;
  /** Un pago registrado que la contabilidad aún no refleja (Fase 3). */
  pagoEnVerificacion?: { monto: number } | null;
  /** Lo que prueban los pagos aprobados (Fase 3): un abono baja lo que falta. */
  estadoPago?: { estado: "pagada" | "abonada"; montoPagado: number } | null;
  unidadNumero?: string;
  unidadTipo?: string;
  unidadTorre?: string | null;
};

export default function MisFacturas() {
  const { id } = useParams<{ id: string }>();
  const condominioId = id as Id<"condominios">;
  const facturas = useQuery(api.facturas.listMia, { condominioId }) as
    | Factura[]
    | undefined;
  const home = useQuery(api.portal.home, { condominioId });
  const avalPortalUrl =
    home && home.allowed ? (home.condominio.avalPortalUrl ?? null) : null;
  const unidades = home?.allowed ? home.unidades : [];
  const multiUnidad = unidades.length > 1;

  const [unidadFiltro, setUnidadFiltro] = useState<Id<"unidades"> | "">("");

  const listaAll = facturas ?? [];
  const lista =
    unidadFiltro === ""
      ? listaAll
      : listaAll.filter((f) => String(f.unidadId) === String(unidadFiltro));

  /* Estado y botones "Pagar" con la regla de la cartera (`lib/cartera.ts`),
   * la misma de la administración y del backend de pagos: la deuda es la
   * factura vigente de cada unidad, no el historial. Una factura vieja
   * `vencida` ya absorbida por las siguientes no pinta "Vencida" ni se
   * ofrece para pagar; una vigente que venció sin pagarse, sí es mora. */
  const resumen = resumenResidente(lista, Date.now());
  /* Sin ninguna casa vinculada HOY (p. ej. una arrendataria con el contrato
   * vencido: el backend ya no le da la casa) no se dice "Estás al día": no
   * hay de qué estar al día (QA de comprobantes, H3). */
  const sinUnidad = home?.allowed === true && !home.isPlatform && home.unidades.length === 0;
  const estaAlDia =
    !sinUnidad && (resumen.estado === "al_dia" || resumen.estado === "sin_facturas");
  const enMora = resumen.estado === "en_mora";
  /* La cartera de hoy de cada unidad: con ella cada factura se rotula como
   * la ve la cartera (`estadoVisibleDeFactura`, QA de comprobantes, H2). */
  const carteras = new Map(resumen.unidades.map((u) => [String(u.unidadId), u.cartera]));
  const pagables = resumen.pagables;
  const pagableIds = new Set(pagables.map((f) => f._id));
  const deudaTotal = pagables.reduce((s, f) => s + montoAPagarHoy(f), 0);
  /* Pagos que Vekino registró y la contabilidad aún no refleja: no se cobran
   * otra vez, y la unidad no está "en mora" por ellos. */
  const enVerificacion = resumen.unidades.reduce(
    (s, u) =>
      s + (u.cartera.motivoRevision === "pago_en_verificacion" ? (u.cartera.montoEnVerificacion ?? 0) : 0),
    0,
  );

  function scrollToFacturas() {
    document.getElementById("facturas")?.scrollIntoView({ behavior: "smooth" });
  }

  return (
    <div className="space-y-6 py-2 sm:space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          Mis facturas
        </h1>
        <p className="mt-1 text-sm text-muted-foreground sm:text-base">
          Gestiona tus facturas y pagos de administración.
        </p>
      </div>

      {multiUnidad ? (
        <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:thin]">
          <button
            type="button"
            onClick={() => setUnidadFiltro("")}
            className={cn(
              "inline-flex h-10 shrink-0 items-center gap-2 rounded-full border px-3.5 text-sm font-medium transition-colors",
              unidadFiltro === ""
                ? "border-foreground/20 bg-foreground text-background"
                : "border-border bg-card text-foreground hover:bg-accent/50",
            )}
          >
            Todas
            <span
              className={cn(
                "tabular-nums text-xs",
                unidadFiltro === ""
                  ? "text-background/70"
                  : "text-muted-foreground",
              )}
            >
              {listaAll.length}
            </span>
          </button>
          {unidades.map((u) => {
            const uid = u._id as Id<"unidades">;
            const active = String(unidadFiltro) === String(uid);
            const count = listaAll.filter(
              (f) => String(f.unidadId) === String(uid),
            ).length;
            return (
              <button
                key={u._id}
                type="button"
                onClick={() => setUnidadFiltro(uid)}
                className={cn(
                  "inline-flex h-10 shrink-0 items-center gap-2 rounded-full border px-3.5 text-sm font-medium transition-colors",
                  active
                    ? "border-brand/40 bg-brand/10 text-foreground"
                    : "border-border bg-card text-foreground hover:bg-accent/50",
                )}
                aria-pressed={active}
              >
                <span className="max-w-[11rem] truncate">
                  {etiquetaUnidad(u)}
                </span>
                <span className="tabular-nums text-xs text-muted-foreground">
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}

      {/* Resumen: estado actual + factura pendiente */}
      <div className="grid grid-cols-1 items-stretch gap-6 md:grid-cols-2">
        <ResumenActual
          loading={facturas === undefined}
          sinUnidad={sinUnidad}
          estaAlDia={estaAlDia}
          enMora={enMora}
          enRevision={resumen.estado === "en_revision"}
          enVerificacion={enVerificacion}
          conteo={pagables.length}
          deuda={deudaTotal}
          multiUnidad={multiUnidad && unidadFiltro === ""}
          onVerDetalle={scrollToFacturas}
        />
        <ProximoPagoCard
          loading={facturas === undefined}
          sinUnidad={sinUnidad}
          facturas={pagables}
          estaAlDia={estaAlDia}
          enVerificacion={enVerificacion}
          carteras={carteras}
          avalPortalUrl={avalPortalUrl}
          multiUnidad={multiUnidad}
        />
      </div>

      {/* Lista de facturas */}
      <div id="facturas" className="scroll-mt-24">
        <div className="mb-4">
          <h2 className="text-lg font-semibold text-foreground sm:text-xl">
            Facturas
          </h2>
          <p className="mt-1 text-xs text-muted-foreground sm:text-sm">
            {facturas === undefined
              ? "Cargando…"
              : unidadFiltro
                ? `${lista.length} factura${lista.length !== 1 ? "s" : ""} de esta unidad`
                : `${lista.length} factura${lista.length !== 1 ? "s" : ""} en total`}
          </p>
        </div>

        {facturas === undefined ? (
          <div className="space-y-3">
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-20 animate-pulse rounded-lg border border-border bg-muted/40"
              />
            ))}
          </div>
        ) : lista.length === 0 ? (
          <div className="rounded-lg border border-border py-12 text-center text-sm text-muted-foreground">
            {unidadFiltro
              ? "No hay facturas para esta unidad."
              : "No hay facturas disponibles."}
          </div>
        ) : (
          <div className="space-y-3">
            {lista.map((f) => (
              <FacturaRow
                key={f._id}
                condominioId={condominioId}
                factura={f}
                cadena={listaAll.filter((x) => String(x.unidadId) === String(f.unidadId))}
                cartera={carteras.get(String(f.unidadId)) ?? null}
                avalPortalUrl={avalPortalUrl}
                pagable={pagableIds.has(f._id)}
                showUnidad={multiUnidad && unidadFiltro === ""}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ───────────────────────── Resumen: Estado actual ───────────────────────── */

function ResumenActual({
  loading,
  sinUnidad,
  estaAlDia,
  enMora,
  enRevision,
  enVerificacion,
  conteo,
  deuda,
  multiUnidad,
  onVerDetalle,
}: {
  loading: boolean;
  /** No tiene ninguna casa vinculada hoy: ni "al día" ni deuda. */
  sinUnidad: boolean;
  estaAlDia: boolean;
  /** Mora ACTUAL según la cartera, no "alguna factura vencida en el historial". */
  enMora: boolean;
  /** La factura vigente tiene una lectura dudosa: ni al día ni en mora. */
  enRevision: boolean;
  /** Pagado y todavía no reflejado por la contabilidad (0 si no hay). */
  enVerificacion: number;
  conteo: number;
  deuda: number;
  multiUnidad: boolean;
  onVerDetalle: () => void;
}) {
  const badgeTone = estaAlDia
    ? ("success" as const)
    : enMora
      ? ("destructive" as const)
      : enRevision
        ? ("info" as const)
        : ("warning" as const);
  const badgeLabel = estaAlDia
    ? "Al día"
    : enMora
      ? "Vencida"
      : enVerificacion > 0
        ? "Pago en verificación"
        : enRevision
          ? "En revisión"
          : "Pendiente";

  return (
    <LiquidGlassCard className="relative flex min-h-[180px] w-full flex-col justify-between overflow-hidden p-5 sm:p-6">
      <div className="relative z-1">
        <div className="mb-3 flex items-center justify-between gap-2">
          <span className="text-sm font-semibold text-foreground">
            Estado actual
          </span>
          {sinUnidad ? null : <Badge tone={badgeTone}>{badgeLabel}</Badge>}
        </div>
        {loading ? (
          <div className="h-8 w-40 animate-pulse rounded bg-muted" />
        ) : sinUnidad ? (
          <>
            <p className="font-semibold text-foreground">{TITULO_SIN_UNIDAD}</p>
            <p className="mt-1 text-sm text-muted-foreground">{TEXTO_SIN_UNIDAD}</p>
          </>
        ) : estaAlDia ? (
          <p className="text-sm text-muted-foreground">
            No tienes facturas pendientes. ¡Estás al día!
          </p>
        ) : enVerificacion > 0 && conteo === 0 ? (
          <p className="text-sm text-muted-foreground">{mensajePagoEnVerificacion(enVerificacion)}</p>
        ) : conteo === 0 ? (
          /* Debe, pero no hay una factura vigente que se pueda pagar: la
           * unidad tiene dos del mismo período y la administración debe
           * revisarlas. No se adivina cuál cobrar. */
          <p className="text-sm text-muted-foreground">
            Tu factura está en revisión. Comunícate con la administración.
          </p>
        ) : (
          <>
            <p className="text-2xl font-bold tabular-nums tracking-tight text-foreground">
              {cop(deuda)}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {multiUnidad
                ? `${conteo} unidad${conteo !== 1 ? "es" : ""} con saldo`
                : `${conteo} factura${conteo !== 1 ? "s" : ""} por pagar`}
            </p>
          </>
        )}
      </div>
      {!estaAlDia && !sinUnidad ? (
        <div className="relative z-1 mt-4">
          <Button variant="outline" onClick={onVerDetalle} className="min-h-10">
            Ver detalle
          </Button>
        </div>
      ) : null}
    </LiquidGlassCard>
  );
}

/* ───────────────────────── Resumen: Factura pendiente ───────────────────────── */

function ProximoPagoCard({
  loading,
  sinUnidad,
  facturas,
  estaAlDia,
  enVerificacion,
  carteras,
  avalPortalUrl,
  multiUnidad,
}: {
  loading: boolean;
  /** No tiene ninguna casa vinculada hoy. */
  sinUnidad: boolean;
  /** Las vigentes que se pueden pagar: a lo sumo una por unidad. */
  facturas: Factura[];
  estaAlDia: boolean;
  /** Pagado y todavía no reflejado por la contabilidad (0 si no hay). */
  enVerificacion: number;
  /** La cartera de hoy de cada unidad, por id. */
  carteras: ReadonlyMap<string, CarteraUnidad>;
  avalPortalUrl: string | null;
  multiUnidad: boolean;
}) {
  if (loading) {
    return (
      <LiquidGlassCard className="flex min-h-[180px] w-full items-center justify-center p-6">
        <Spinner className="h-5 w-5" />
      </LiquidGlassCard>
    );
  }

  if (facturas.length === 0) {
    return (
      <LiquidGlassCard className="flex min-h-[180px] w-full flex-col items-center justify-center gap-2 p-6 text-center">
        {sinUnidad ? (
          <>
            <p className="text-lg font-bold text-foreground">{TITULO_SIN_UNIDAD}</p>
            <p className="text-sm text-muted-foreground">{TEXTO_SIN_UNIDAD}</p>
          </>
        ) : estaAlDia ? (
          <>
            <CheckCircle2 className="h-9 w-9 text-emerald-600 dark:text-emerald-400" />
            <p className="text-lg font-bold text-foreground">Estás al día</p>
            <p className="text-sm text-muted-foreground">
              No tienes pagos pendientes.
            </p>
          </>
        ) : enVerificacion > 0 ? (
          /* No se cobra en línea: se le cobraría dos veces lo que ya pagó. */
          <>
            <p className="text-lg font-bold text-foreground">Pago en verificación</p>
            <p className="text-sm text-muted-foreground">
              {mensajePagoEnVerificacion(enVerificacion)}
            </p>
          </>
        ) : (
          <>
            <p className="text-lg font-bold text-foreground">Pago en línea no disponible</p>
            <p className="text-sm text-muted-foreground">
              Comunícate con la administración para revisar tu factura.
            </p>
          </>
        )}
      </LiquidGlassCard>
    );
  }

  if (facturas.length > 1) {
    return (
      <LiquidGlassCard className="flex min-h-[180px] w-full flex-col justify-between gap-3 p-5 sm:p-6">
        <div>
          <span className="text-sm font-semibold text-foreground">
            Pagos pendientes
          </span>
          <p className="mt-1 text-sm text-muted-foreground">
            Cada unidad se paga por separado.
          </p>
        </div>
        <ul className="space-y-2">
          {facturas.map((f) => (
            <li
              key={f._id}
              className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-2 first:border-0 first:pt-0"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">
                  {etiquetaUnidad(f)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {periodoHumano(f.periodo || f.periodoLabel)}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold tabular-nums text-foreground">
                  {cop(montoAPagarHoy(f))}
                </span>
                <PortalPayButton
                  facturaId={f._id}
                  avalPortalUrl={avalPortalUrl}
                  label="Pagar"
                  size="sm"
                />
              </div>
            </li>
          ))}
        </ul>
      </LiquidGlassCard>
    );
  }

  const factura = facturas[0]!;
  /* La vigente de una unidad en mora se rotula como la cartera: puede seguir
   * `pendiente` en la base porque ninguna factura posterior la ha juzgado.
   * Es la regla de toda la app (`estadoVisibleDeFactura`, H2). */
  const meta =
    ESTADO_FACTURA[
      estadoVisibleDeFactura(factura, [factura], carteras.get(String(factura.unidadId))) === "vencida"
        ? "vencida"
        : factura.estado
    ];
  const venc =
    factura.fechaVencimiento > FECHA_MIN
      ? fechaPlazo(factura.fechaVencimiento)
      : null;
  /* Fase 4, decisión B: el fin de mes es el plazo del precio completo; la
   * mora empieza el 16 del mes siguiente. Las dos fechas, dichas claro. */
  const moraDesde = venc ? fechaPlazo(inicioDeMora(factura)) : null;
  const limiteDescuento = fechaLimiteDescuentoDe(factura);
  /* Lo ya abonado (pagos aprobados): el monto de arriba ya lo descuenta. */
  const abonado = abonoAprobado(factura);

  return (
    <LiquidGlassCard className="flex min-h-[180px] w-full flex-col justify-between gap-4 p-5 sm:flex-row sm:items-center sm:p-6">
      <div className="min-w-0 sm:flex-1">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-foreground">
            Factura pendiente
          </span>
          {meta ? <Badge tone={meta.tone}>{meta.label}</Badge> : null}
        </div>
        {multiUnidad ? (
          <p className="text-sm font-medium text-foreground">
            {etiquetaUnidad(factura)}
          </p>
        ) : null}
        <p className="text-sm text-foreground">
          Cuenta de {periodoHumano(factura.periodo || factura.periodoLabel)}
        </p>
        <p className="text-xs text-muted-foreground">{factura.numeroFactura}</p>
        {venc ? (
          <p className="mt-1 text-xs text-muted-foreground">
            Precio completo hasta el {venc}
          </p>
        ) : null}
        {moraDesde ? (
          <p className="text-xs text-muted-foreground">En mora desde el {moraDesde}</p>
        ) : null}
      </div>
      {/* Acotada al 55 %: un texto largo (el aviso de la pasarela, el del
          descuento) se acomoda aquí en vez de aplastar la columna de la
          factura (QA de comprobantes, H5). */}
      <div className="flex min-w-0 flex-col items-start gap-2 sm:max-w-[55%] sm:shrink-0 sm:items-end">
        <span className="text-xl font-bold tabular-nums tracking-tight text-foreground sm:text-2xl">
          {cop(montoAPagarHoy(factura))}
        </span>
        {abonado > 0 ? (
          <p className="text-xs text-muted-foreground sm:text-right">
            Abonado {cop(abonado)} de {cop(factura.totalAPagar)}
          </p>
        ) : null}
        {limiteDescuento !== null && descuentoVigente(factura, Date.now()) ? (
          <p className="text-xs text-muted-foreground sm:text-right">
            Con descuento hasta el {fechaPlazo(limiteDescuento)}. Después: {cop(montoSinDescuento(factura))}
          </p>
        ) : null}
        <PortalPayButton
          facturaId={factura._id}
          avalPortalUrl={avalPortalUrl}
          label="Pagar"
          showArrow
          className="w-full sm:w-auto"
        />
      </div>
    </LiquidGlassCard>
  );
}

/* ───────────────────────── Fila de factura ───────────────────────── */

function FacturaRow({
  condominioId,
  factura,
  cadena,
  cartera,
  avalPortalUrl,
  pagable,
  showUnidad,
}: {
  condominioId: Id<"condominios">;
  factura: Factura;
  /** Las facturas de la misma unidad: dicen si esta es historica. */
  cadena: Factura[];
  /** La cartera de hoy de su unidad: dice si la vigente está en mora. */
  cartera: CarteraUnidad | null;
  avalPortalUrl: string | null;
  pagable: boolean;
  showUnidad: boolean;
}) {
  const [open, setOpen] = useState(false);
  /* Una historica que quedó `pendiente` no se sabe si se pagó: falta el
   * estado de cuenta siguiente (Fase 4). No se rotula "Pendiente". Y la
   * vigente de una unidad en mora es "Vencida", como en el resumen y la
   * tarjeta de arriba (QA de comprobantes, H2). */
  const visible = estadoVisibleDeFactura(factura, cadena, cartera);
  const sinVerificar = visible === "sin_verificar";
  const meta = sinVerificar ? null : ESTADO_FACTURA[visible === "vencida" ? "vencida" : factura.estado];
  const isPagada = factura.estado === "pagada";
  const venc = factura.fechaVencimiento > FECHA_MIN ? fechaPlazo(factura.fechaVencimiento) : null;
  /* La mora solo se anuncia en la vigente sin pagar (decisión B, Fase 4). */
  const esVigente = !cadena.some((x) => x.periodo > factura.periodo);
  const moraDesde =
    venc && esVigente && sinPagar(factura.estado) ? fechaPlazo(inicioDeMora(factura)) : null;
  const periodo = periodoHumano(factura.periodo || factura.periodoLabel);
  const limiteDescuento = fechaLimiteDescuentoDe(factura);
  /* Un abono aprobado: en la vigente se muestra lo que falta, no el total
   * del documento (QA de comprobantes, H1). En una histórica, lo que faltó
   * ya va en la siguiente: se deja su total. */
  const abonado = abonoAprobado(factura);
  const monto = esVigente && abonado > 0 ? montoSinDescuento(factura) : factura.totalAPagar;

  return (
    <div className="overflow-hidden rounded-lg border border-border transition-colors">
      {/* Cabecera de la fila (clic = expandir) */}
      <div
        onClick={() => setOpen((o) => !o)}
        className="flex cursor-pointer flex-col gap-4 p-4 hover:bg-muted/40 sm:flex-row sm:items-center sm:justify-between"
      >
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex flex-wrap items-center gap-2">
            <span className="text-base font-semibold text-foreground">
              {periodo}
            </span>
            {meta && <Badge tone={meta.tone}>{meta.label}</Badge>}
            {sinVerificar && <Badge tone="neutral">{ETIQUETA_SIN_VERIFICAR}</Badge>}
            {enRevision(factura) && <Badge tone="info">En revisión</Badge>}
            {factura.pagoEnVerificacion ? (
              <Badge tone="info">Pago en verificación</Badge>
            ) : null}
            {isPagada && (
              <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
                <CheckCircle2 className="h-3.5 w-3.5" /> Pagada
              </span>
            )}
          </div>
          {showUnidad ? (
            <p className="mb-1 text-sm font-medium text-foreground">
              {etiquetaUnidad(factura)}
            </p>
          ) : null}
          <p className="mb-1 text-sm text-muted-foreground">
            {factura.numeroFactura}
          </p>
          {venc && (
            <p className="text-xs font-medium text-muted-foreground">
              Precio completo hasta el {venc}
            </p>
          )}
          {moraDesde && (
            <p className="text-xs text-muted-foreground">En mora desde el {moraDesde}</p>
          )}
          {sinVerificar && (
            <p className="mt-1 text-xs text-muted-foreground">{TEXTO_SIN_VERIFICAR}</p>
          )}
          {factura.pagoEnVerificacion ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {mensajePagoEnVerificacion(factura.pagoEnVerificacion.monto)}
            </p>
          ) : null}
          {abonado > 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Abonado {cop(abonado)} de {cop(factura.totalAPagar)}
            </p>
          ) : null}
        </div>

        {/* Acotada al 60 % y con salto de línea: el aviso de la pasarela va en
            su propia línea y ya no aplasta ni desborda la fila (H5). */}
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 sm:max-w-[60%] sm:shrink-0 sm:justify-end">
          <span className="text-lg font-bold tabular-nums text-foreground">
            {cop(monto)}
          </span>
          {!isPagada && pagable && (
            /* `contents`: el botón o el aviso son hijos directos de la fila
             * de acciones, para que el aviso pueda ir a su propia línea. */
            <div className="contents" onClick={(e) => e.stopPropagation()}>
              <PayButton factura={factura} avalPortalUrl={avalPortalUrl} size="sm" />
            </div>
          )}
          {factura.pdfUrl && (
            <a
              href={factura.pdfUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="text-sm font-medium text-brand hover:underline"
            >
              Descargar
            </a>
          )}
          <ChevronDown
            className={cn(
              "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-180",
            )}
          />
        </div>
      </div>

      {/* "Ya pagué" en la vigente, y los comprobantes enviados de cualquiera
          (Hallazgo 1). Fuera de la cabecera: tocarlo no abre el desglose. */}
      <ComprobantePago
        condominioId={condominioId}
        factura={factura}
        vigente={esVigente}
        className="border-t border-border px-4 py-3"
      />

      {/* Desglose (acordeón) */}
      {open && (
        <div className="border-t border-border bg-muted/20 px-4 py-4">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[24rem] text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="pb-2 font-medium">Concepto</th>
                  <th className="pb-2 text-right font-medium">Saldo ant.</th>
                  <th className="pb-2 text-right font-medium">Mes</th>
                  <th className="pb-2 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {factura.lineas.map((l, i) => (
                  <tr key={i}>
                    <td className="py-2 pr-3 text-foreground">{l.concepto}</td>
                    <td className="py-2 text-right tabular-nums text-muted-foreground">
                      {l.saldoAnterior ? cop(l.saldoAnterior) : "—"}
                    </td>
                    <td className="py-2 text-right tabular-nums text-muted-foreground">
                      {l.actual ? cop(l.actual) : "—"}
                    </td>
                    <td className="py-2 text-right font-medium tabular-nums text-foreground">
                      {cop(l.total)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                {factura.saldoAFavor > 0 && (
                  <tr>
                    <td colSpan={3} className="pt-3 text-right text-muted-foreground">
                      Saldo a favor
                    </td>
                    <td className="pt-3 text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                      −{cop(factura.saldoAFavor)}
                    </td>
                  </tr>
                )}
                {factura.totalConDescuento != null &&
                limiteDescuento !== null &&
                factura.totalConDescuento < factura.totalAPagar ? (
                  <>
                    <tr>
                      <td
                        colSpan={3}
                        className="pt-3 text-right text-sm font-medium text-emerald-700 dark:text-emerald-400"
                      >
                        Con descuento, hasta el {fechaPlazo(limiteDescuento)}
                      </td>
                      <td className="pt-3 text-right text-base font-bold tabular-nums text-emerald-700 dark:text-emerald-400">
                        {cop(factura.totalConDescuento)}
                      </td>
                    </tr>
                    <tr>
                      <td colSpan={3} className="pt-1 text-right text-sm font-semibold text-foreground">
                        {venc ? `Sin descuento, hasta el ${venc}` : "Sin descuento"}
                      </td>
                      <td className="pt-1 text-right text-base font-bold tabular-nums text-foreground">
                        {cop(factura.totalAPagar)}
                      </td>
                    </tr>
                  </>
                ) : (
                  <tr>
                    <td colSpan={3} className="pt-2 text-right font-semibold text-foreground">
                      Total a pagar
                    </td>
                    <td className="pt-2 text-right text-base font-semibold tabular-nums text-foreground">
                      {cop(factura.totalAPagar)}
                    </td>
                  </tr>
                )}
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── Botón de pago (deep-link Aval o API) ───────────────────────── */

type PayButtonProps = {
  factura: Factura;
  avalPortalUrl: string | null;
  size?: "default" | "sm";
  className?: string;
};

/* Como `PortalPayButton`: si `opcionesDePago` falla, queda una nota en la
 * fila y la página sigue. */
function PayButton(props: PayButtonProps) {
  return (
    <ErrorBoundary resetKey={props.factura._id} fallback={() => <PagoNoDisponible />}>
      <PayButtonContenido {...props} />
    </ErrorBoundary>
  );
}

function PayButtonContenido({
  factura,
  avalPortalUrl,
  size = "default",
  className,
}: PayButtonProps) {
  const crearPago = useAction(api.pagos.crearPagoFactura);
  const [loading, setLoading] = useState(false);
  /* Igual que en portal-pay-button (Fase 4): sin portal del banco, con la
   * pasarela en QA y una unidad real, no se ofrece pagar en línea. */
  const opciones = useQuery(
    api.pagos.opcionesDePago,
    avalPortalUrl ? "skip" : { facturaId: factura._id },
  );
  if (!avalPortalUrl && opciones?.debe && !opciones.pasarela && opciones.motivo) {
    /* Un párrafo, no un `span`: en línea, su ancho máximo no aplicaba y el
     * aviso se pintaba en una sola línea de casi 1.000 px que desbordaba la
     * fila y la dejaba corrida al cerrar el formulario (QA de comprobantes,
     * H5). Va al final y a lo ancho de la fila de acciones. */
    return (
      <p className="order-last basis-full text-xs leading-snug text-muted-foreground sm:text-right">
        {opciones.motivo}
      </p>
    );
  }

  async function pagar() {
    if (avalPortalUrl) {
      window.open(avalPortalUrl, "_blank", "noopener,noreferrer");
      return;
    }
    setLoading(true);
    /* Igual que en portal-pay-button: la pestaña se abre con el clic todavía
     * en curso, o el navegador la bloquea por emergente. Navegar en la misma
     * pestaña dejaba a la persona sin Vekino si la pasarela terminaba en una
     * pantalla sin salida. */
    const pestana = window.open("", "_blank", "noopener,noreferrer");
    try {
      const { redirectUrl } = await crearPago({ facturaId: factura._id });
      if (pestana && !pestana.closed) pestana.location.href = redirectUrl;
      else window.location.href = redirectUrl;
      setLoading(false);
    } catch {
      if (pestana && !pestana.closed) pestana.close();
      setLoading(false);
    }
  }

  return (
    <button
      onClick={pagar}
      disabled={loading}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-md bg-brand font-semibold text-brand-foreground shadow-[0_4px_10px_hsl(var(--brand)/0.28)] transition-colors hover:bg-brand/90 disabled:opacity-60",
        size === "sm" ? "h-8 px-3 text-sm" : "h-10 px-5 text-sm",
        className,
      )}
    >
      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <>
          Pagar
          {size !== "sm" && <ArrowRight className="h-4 w-4" />}
        </>
      )}
    </button>
  );
}
