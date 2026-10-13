"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@vekino/backend/api";
import type { Id } from "@vekino/backend/dataModel";
import {
  ETIQUETA_SIN_VERIFICAR,
  TEXTO_SIN_VERIFICAR,
  abonoAprobado,
  descuentoVigente,
  estadoVisibleDeFactura,
  fechaLimiteDescuentoDe,
  inicioDeMora,
  mensajePagoEnVerificacion,
  montoAPagarHoy as montoDeHoy,
  montoSinDescuento,
  resumenResidente,
  type CarteraUnidad,
} from "@vekino/backend/cartera";
import {
  Building2,
  PiggyBank,
  CalendarCheck,
  MessageSquareWarning,
  CheckCircle2,
  AlertTriangle,
  ArrowRight,
  Download,
  Clock,
  Megaphone,
  Pin,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { LiquidGlassCard } from "@/components/portal/liquid-glass-card";
import { PortalPayButton } from "@/components/portal/portal-pay-button";
import { ComprobantePago } from "@/components/portal/comprobante-pago";
import { cop, cn } from "@/lib/utils";
import {
  ESTADO_FACTURA,
  TEXTO_SIN_UNIDAD,
  TITULO_SIN_UNIDAD,
  etiquetaUnidad,
  fechaLarga,
  fechaISO,
  fechaPlazo,
  periodoHumano,
  VINCULO_LABEL,
} from "@/components/portal/portal-ui";
import { AsambleaEnVivoCard } from "@/components/portal/asamblea-en-vivo-card";

const FECHA_MIN = 946684800000;

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
  lineas: {
    codigo: number;
    concepto: string;
    saldoAnterior: number;
    actual: number;
    total: number;
  }[];
  /** Un pago registrado que la contabilidad aún no refleja (Fase 3). */
  pagoEnVerificacion?: { monto: number } | null;
  /** Lo que prueban los pagos aprobados (Fase 3): un abono baja lo que falta. */
  estadoPago?: { estado: "pagada" | "abonada"; montoPagado: number } | null;
  unidadNumero?: string;
  unidadTipo?: string;
  unidadTorre?: string | null;
};

/**
 * Monto que aplica HOY: la regla del backend de pagos (`lib/cartera.ts`).
 * El descuento vale hasta SU fecha —la del documento, o el 15 del mes del
 * período—, no hasta el vencimiento (Fase 3, F-06), y lo ya abonado no se
 * vuelve a cobrar (QA de comprobantes, H1). La última factura ya consolida
 * saldos anteriores.
 */
/**
 * Los dos plazos de la vigente (Fase 4, decisión B): hasta cuándo se paga el
 * precio completo (fin de mes) y desde cuándo cuenta como mora (el 16 del mes
 * siguiente).
 */
function plazosEnTexto(f: Factura): string {
  return `Precio completo hasta el ${fechaPlazo(f.fechaVencimiento)} · En mora desde el ${fechaPlazo(inicioDeMora(f))}`;
}

function montoAPagarHoy(f: Factura, ahora = Date.now()) {
  return montoDeHoy(f, ahora);
}

export default function PortalInicio() {
  const { id } = useParams<{ id: string }>();
  const condominioId = id as Id<"condominios">;

  const home = useQuery(api.portal.home, { condominioId });
  const facturas = useQuery(api.facturas.listMia, { condominioId }) as
    | Factura[]
    | undefined;
  const actividades = useQuery(api.portal.misActividades, { condominioId });
  const avisos = useQuery(api.comunicados.listRecent, {
    condominioId,
    limit: 8,
  });

  if (home === undefined) {
    return (
      <div className="flex justify-center py-24">
        <Spinner className="h-5 w-5" />
      </div>
    );
  }
  if (!home.allowed) return null;

  const base = `/mi/${condominioId}`;
  const firstName =
    home.userName.trim().split(/\s+/)[0] || home.userName.trim() || "";
  const avalPortalUrl = home.condominio.avalPortalUrl;
  const unidad =
    home.unidades.find((u) => u.esPrincipal) ?? home.unidades[0] ?? null;
  const multiUnidad = home.unidades.length > 1;
  const unidadLabel = multiUnidad
    ? `${home.unidades.length} unidades`
    : unidad
      ? etiquetaUnidad(unidad)
      : null;
  const vinculoLabel = unidad
    ? VINCULO_LABEL[unidad.vinculo] ?? null
    : null;

  const lista = facturas ?? [];
  /* La misma regla de la cartera que "Mis facturas" y la administración
   * (`lib/cartera.ts`): por unidad, la deuda es su factura vigente, que ya
   * absorbe a las anteriores. El historial no pinta mora ni se ofrece. */
  const resumen = resumenResidente(lista, Date.now());
  /* Sin ninguna casa vinculada HOY no se dice "Estás al día" (H3). */
  const sinUnidad = !home.isPlatform && home.unidades.length === 0;
  const estaAlDia = resumen.estado === "al_dia" || resumen.estado === "sin_facturas";
  /* Con la cartera de su unidad, cada fila se rotula como la ve la cartera (H2). */
  const carteras = new Map(resumen.unidades.map((u) => [String(u.unidadId), u.cartera]));
  const pagables = resumen.pagables;
  const totalPendiente = pagables.reduce((s, f) => s + montoAPagarHoy(f), 0);
  /* Con una sola unidad en mora, desde cuándo: la mora la marca el último
   * período vencido sin cubrir, que puede ser anterior a la vigente. */
  const enMora = resumen.unidades.filter((u) => u.cartera.estado === "en_mora");
  /* Desde cuándo está en mora (Fase 4, decisión B): el 16 del mes siguiente
   * al período en mora, no el día después del plazo del precio completo. */
  const carteraEnMora = enMora.length === 1 ? enMora[0]!.cartera : null;
  const vencimientoEnMora =
    carteraEnMora?.periodoEnMora && carteraEnMora.vencimientoEnMora
      ? inicioDeMora({
          periodo: carteraEnMora.periodoEnMora,
          fechaVencimiento: carteraEnMora.vencimientoEnMora,
        })
      : null;
  /* Pagos que Vekino registró y la contabilidad aún no refleja (Fase 3). */
  const enVerificacion = resumen.unidades.reduce(
    (s, u) =>
      s + (u.cartera.motivoRevision === "pago_en_verificacion" ? (u.cartera.montoEnVerificacion ?? 0) : 0),
    0,
  );

  /* El saldo a favor de HOY es el de las facturas vigentes; uno de hace meses
   * ya se aplicó en las siguientes. */
  const saldoAFavor = resumen.unidades.reduce(
    (s, u) => s + Math.max(0, u.vigente?.saldoAFavor ?? 0),
    0,
  );
  const reservas = actividades?.reservasActivas ?? [];
  const ticketsAbiertos = actividades?.ticketsAbiertos ?? 0;
  const proximaReserva = reservas[0] ?? null;

  const avisoDestacado =
    avisos?.find((a) => a.fijado) ??
    avisos?.find((a) => a.prioridad === "urgente") ??
    avisos?.find((a) => a.prioridad === "importante") ??
    null;

  return (
    <div className="w-full space-y-6 text-[15px] text-foreground">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-[1.75rem]">
          Hola{firstName ? `, ${firstName}` : ""}{" "}
          <span aria-hidden>👋</span>
        </h1>
        <p className="mt-1 text-[15px] text-foreground/70">
          {home.condominio.name}
          {unidadLabel ? <> · {unidadLabel}</> : null}
          {vinculoLabel ? (
            <span className="text-foreground/50"> · {vinculoLabel}</span>
          ) : null}
        </p>
      </header>

      <AsambleaEnVivoCard condominioId={condominioId} />

      {avisoDestacado ? (
        <AvisoFijado
          base={base}
          titulo={avisoDestacado.titulo}
          cuerpo={avisoDestacado.cuerpo}
          fijado={avisoDestacado.fijado}
          prioridad={avisoDestacado.prioridad}
          fecha={avisoDestacado.createdAt}
        />
      ) : null}

      {facturas === undefined ? (
        <LiquidGlassCard className="p-6">
          <Spinner className="mx-auto h-5 w-5" />
        </LiquidGlassCard>
      ) : sinUnidad ? (
        <LiquidGlassCard className="flex items-center gap-3 px-4 py-3.5">
          <Building2 className="h-5 w-5 shrink-0 text-foreground/50" />
          <div>
            <p className="font-semibold text-foreground">{TITULO_SIN_UNIDAD}</p>
            <p className="text-sm text-foreground/65">{TEXTO_SIN_UNIDAD}</p>
          </div>
        </LiquidGlassCard>
      ) : (
        <DeudaAlert
          base={base}
          condominioId={condominioId}
          estaAlDia={estaAlDia}
          enMora={resumen.estado === "en_mora"}
          vencimientoEnMora={vencimientoEnMora}
          enVerificacion={enVerificacion}
          totalPendiente={totalPendiente}
          facturasParaPagar={pagables}
          multiUnidad={multiUnidad}
          avalPortalUrl={avalPortalUrl}
        />
      )}

      {/* Resumen corto */}
      <div className="grid gap-2 sm:grid-cols-3">
        <StatLink
          href={`${base}/cuenta`}
          label="Saldo a favor"
          value={cop(saldoAFavor)}
          icon={PiggyBank}
        />
        <StatLink
          href={`${base}/reservas`}
          label="Próxima reserva"
          value={
            proximaReserva
              ? proximaReserva.zonaNombre
              : "Ninguna"
          }
          sub={proximaReserva ? fechaISO(proximaReserva.fecha) : undefined}
          icon={CalendarCheck}
        />
        <StatLink
          href={`${base}/pqrs`}
          label="Solicitudes"
          value={
            ticketsAbiertos === 0
              ? "Ninguna abierta"
              : ticketsAbiertos === 1
                ? "1 abierta"
                : `${ticketsAbiertos} abiertas`
          }
          icon={MessageSquareWarning}
        />
      </div>

      {/* 5. Facturas (contenido principal) */}
      <section>
        <div className="mb-3 flex items-end justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-foreground">
              Facturas recientes
            </h2>
            <p className="mt-0.5 text-sm text-foreground/65">
              Consulta, descarga o paga
            </p>
          </div>
          <Link
            href={`${base}/cuenta`}
            className="inline-flex min-h-10 items-center gap-1 text-sm font-medium text-foreground/70 transition-colors hover:text-foreground"
          >
            Ver todas
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>

        <LiquidGlassCard className="divide-y divide-border overflow-hidden p-0 dark:divide-white/10">
          {facturas === undefined ? (
            <div className="p-6">
              <Spinner className="mx-auto h-5 w-5" />
            </div>
          ) : lista.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-foreground/65">
              Aún no tienes facturas.
            </p>
          ) : (
            lista.slice(0, 4).map((f) => (
              <FacturaRow
                key={f._id}
                factura={f}
                cadena={lista.filter((x) => String(x.unidadId) === String(f.unidadId))}
                cartera={carteras.get(String(f.unidadId)) ?? null}
                showUnidad={multiUnidad}
              />
            ))
          )}
        </LiquidGlassCard>
      </section>

      {/* 6. Reservas — compacto */}
      <LiquidGlassCard className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
        <div className="min-w-0">
          <p className="font-medium text-foreground">Próximas reservas</p>
          <p className="text-sm text-foreground/65">
            {reservas.length === 0
              ? "No tienes reservas programadas"
              : `${reservas.length} reserva${reservas.length !== 1 ? "s" : ""}`}
          </p>
        </div>
        <Button
          variant={reservas.length === 0 ? "brand" : "outline"}
          size="sm"
          asChild
          className="min-h-10"
        >
          <Link href={`${base}/reservas`}>
            {reservas.length === 0 ? "Reservar zona" : "Ver reservas"}
          </Link>
        </Button>
      </LiquidGlassCard>
    </div>
  );
}

function AvisoFijado({
  base,
  titulo,
  cuerpo,
  fijado,
  prioridad,
  fecha,
}: {
  base: string;
  titulo: string;
  cuerpo: string;
  fijado: boolean;
  prioridad: string;
  fecha: number;
}) {
  const extracto =
    cuerpo.length > 160 ? `${cuerpo.slice(0, 160).trim()}…` : cuerpo;

  return (
    <LiquidGlassCard className="px-4 py-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-neutral-900/5 text-foreground">
            <Megaphone className="h-5 w-5" aria-hidden />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-xs font-medium uppercase tracking-wide text-foreground/55">
                Aviso de la administración
              </p>
              {fijado ? (
                <Badge tone="neutral" className="gap-1">
                  <Pin className="h-3 w-3" aria-hidden />
                  Fijado
                </Badge>
              ) : null}
              {prioridad === "urgente" ? (
                <Badge tone="destructive">Urgente</Badge>
              ) : null}
              {prioridad === "importante" ? (
                <Badge tone="warning">Importante</Badge>
              ) : null}
            </div>
            <p className="mt-1 text-[17px] font-semibold leading-snug text-foreground">
              {titulo}
            </p>
            <p className="mt-1 text-sm leading-relaxed text-foreground/70">
              {extracto}
            </p>
            <p className="mt-1.5 text-xs text-foreground/50">
              {fechaLarga(fecha)}
            </p>
          </div>
        </div>
        <Button variant="outline" asChild className="min-h-11 shrink-0">
          <Link href={`${base}/avisos`}>
            Ver avisos
            <ArrowRight className="h-4 w-4" />
          </Link>
        </Button>
      </div>
    </LiquidGlassCard>
  );
}

function DeudaAlert({
  base,
  condominioId,
  estaAlDia,
  enMora,
  vencimientoEnMora,
  enVerificacion,
  totalPendiente,
  facturasParaPagar,
  multiUnidad,
  avalPortalUrl,
}: {
  base: string;
  condominioId: Id<"condominios">;
  estaAlDia: boolean;
  /** Mora ACTUAL según la cartera, no "alguna factura vencida en el historial". */
  enMora: boolean;
  /** Vencimiento que marca la mora, si es de una sola unidad. */
  vencimientoEnMora: number | null;
  /** Pagado y todavía no reflejado por la contabilidad (0 si no hay). */
  enVerificacion: number;
  totalPendiente: number;
  facturasParaPagar: Factura[];
  multiUnidad: boolean;
  avalPortalUrl: string | null;
}) {
  if (estaAlDia) {
    return (
      <LiquidGlassCard className="flex items-center gap-3 px-4 py-3.5">
        <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600" />
        <div>
          <p className="font-semibold text-foreground">Estás al día</p>
          <p className="text-sm text-foreground/65">
            No tienes facturas pendientes.
          </p>
        </div>
      </LiquidGlassCard>
    );
  }

  /* Pagó y la contabilidad aún no lo refleja (Fase 3): no se le cobra otra
   * vez ni se le dice que debe. */
  if (facturasParaPagar.length === 0 && enVerificacion > 0) {
    return (
      <LiquidGlassCard className="flex items-center gap-3 px-4 py-3.5">
        <Clock className="h-5 w-5 shrink-0 text-sky-700" />
        <div>
          <p className="font-semibold text-foreground">Pago en verificación</p>
          <p className="text-sm text-foreground/65">{mensajePagoEnVerificacion(enVerificacion)}</p>
        </div>
      </LiquidGlassCard>
    );
  }

  /* Debe, pero ninguna vigente se puede pagar: la unidad tiene dos facturas
   * del mismo período, o la lectura del PDF de su vigente está en revisión
   * (Fase 2), y la administración debe revisarlas. */
  if (facturasParaPagar.length === 0) {
    return (
      <LiquidGlassCard className="flex items-center gap-3 px-4 py-3.5">
        <Clock className="h-5 w-5 shrink-0 text-amber-700" />
        <div>
          <p className="font-semibold text-foreground">Tu factura está en revisión</p>
          <p className="text-sm text-foreground/65">
            Comunícate con la administración.
          </p>
        </div>
      </LiquidGlassCard>
    );
  }

  const varias = facturasParaPagar.length > 1;
  const f = facturasParaPagar[0]!;
  const periodo = periodoHumano(f.periodo || f.periodoLabel);
  const limiteDescuento = fechaLimiteDescuentoDe(f);
  const prontoPago = !varias && descuentoVigente(f, Date.now());
  const vencida = enMora;
  /* El total ya descuenta lo abonado (H1); se dice cuánto, para que cuadre
   * con el documento. */
  const abonado = varias ? 0 : abonoAprobado(f);

  const titulo = `Total pendiente: ${cop(totalPendiente)}`;
  let sub: string;
  if (varias) {
    const unidades = facturasParaPagar
      .map((x) => etiquetaUnidad(x))
      .join(" · ");
    sub = `${facturasParaPagar.length} unidades con saldo · ${unidades}`;
  } else if (vencida) {
    sub =
      vencimientoEnMora !== null && vencimientoEnMora > FECHA_MIN
        ? `${periodo}${multiUnidad ? ` · ${etiquetaUnidad(f)}` : ""} · En mora desde el ${fechaPlazo(vencimientoEnMora)}`
        : `${periodo}${multiUnidad ? ` · ${etiquetaUnidad(f)}` : ""} · Factura vencida`;
  } else if (prontoPago && limiteDescuento !== null) {
    /* La fecha real del descuento (la del documento, o el 15 del mes del
     * período), no el vencimiento: antes se anunciaba un mes de más. */
    sub = `${periodo}${multiUnidad ? ` · ${etiquetaUnidad(f)}` : ""} · Con descuento hasta el ${fechaPlazo(limiteDescuento)} · Después ${cop(montoSinDescuento(f))}`;
  } else if (
    limiteDescuento !== null &&
    typeof f.totalConDescuento === "number" &&
    f.totalConDescuento < f.totalAPagar
  ) {
    sub = `${periodo}${multiUnidad ? ` · ${etiquetaUnidad(f)}` : ""} · Sin descuento (venció el ${fechaPlazo(limiteDescuento)})${
      f.fechaVencimiento > FECHA_MIN ? ` · ${plazosEnTexto(f)}` : ""
    }`;
  } else {
    sub =
      f.fechaVencimiento > FECHA_MIN
        ? `${periodo}${multiUnidad ? ` · ${etiquetaUnidad(f)}` : ""} · ${plazosEnTexto(f)}`
        : `${periodo}${multiUnidad ? ` · ${etiquetaUnidad(f)}` : ""}`;
  }

  return (
    <LiquidGlassCard
      className={cn(
        "px-4 py-4",
        vencida && "border-red-200/60 bg-red-50/40",
        !vencida && "border-amber-200/50 bg-amber-50/30",
      )}
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          {vencida ? (
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-600" />
          ) : (
            <Clock className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" />
          )}
          <div>
            <p
              className={cn(
                "text-[17px] font-semibold leading-snug",
                vencida ? "text-red-800" : "text-amber-950",
              )}
            >
              {titulo}
            </p>
            <p className="mt-0.5 text-sm text-foreground/70">{sub}</p>
            {abonado > 0 ? (
              <p className="mt-0.5 text-sm text-foreground/70">
                Abonado {cop(abonado)} de {cop(f.totalAPagar)}
              </p>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {varias ? (
            <Button variant="brand" asChild className="min-h-11">
              <Link href={`${base}/cuenta`}>Ver y pagar</Link>
            </Button>
          ) : (
            <>
              <PortalPayButton
                facturaId={f._id}
                avalPortalUrl={avalPortalUrl}
                label="Pagar ahora"
                variant="brand"
              />
              <Button variant="outline" asChild className="min-h-11 border-border/80">
                <Link href={`${base}/cuenta`}>Ver facturas</Link>
              </Button>
            </>
          )}
        </div>
      </div>
      {/* "Ya pagué" junto a "Pagar ahora" (Hallazgo 1). Con varias unidades
          con saldo, cada una se envía desde "Mis facturas", como el pago. */}
      {!varias ? (
        <ComprobantePago
          condominioId={condominioId}
          factura={f}
          className="mt-4 border-t border-border/60 pt-4"
        />
      ) : null}
    </LiquidGlassCard>
  );
}

function FacturaRow({
  factura: f,
  cadena,
  cartera,
  showUnidad,
}: {
  factura: Factura;
  /** Las facturas de la misma unidad: dicen si esta es historica. */
  cadena: Factura[];
  /** La cartera de hoy de su unidad: dice si la vigente está en mora. */
  cartera: CarteraUnidad | null;
  showUnidad: boolean;
}) {
  /* Una historica `pendiente` no se sabe si se pagó (Fase 4): "Sin verificar".
   * La vigente de una unidad en mora es "Vencida", como dice la tarjeta de
   * arriba (QA de comprobantes, H2). */
  const visible = estadoVisibleDeFactura(f, cadena, cartera);
  const sinVerificar = visible === "sin_verificar";
  const meta = sinVerificar ? null : ESTADO_FACTURA[visible === "vencida" ? "vencida" : f.estado];
  const Icon = meta?.icon;
  const periodo = periodoHumano(f.periodo || f.periodoLabel);
  const unidadTxt = showUnidad ? etiquetaUnidad(f) : null;
  /* En la vigente con un abono aprobado, lo que falta (H1). */
  const esVigente = !cadena.some((x) => x.periodo > f.periodo);
  const abonado = abonoAprobado(f);
  const monto = esVigente && abonado > 0 ? montoSinDescuento(f) : f.totalAPagar;

  return (
    <div className="px-4 py-3.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium text-foreground">{periodo}</p>
          {unidadTxt ? (
            <p className="mt-0.5 text-sm font-medium text-foreground/80">
              {unidadTxt}
            </p>
          ) : null}
          <p className="mt-0.5 text-sm text-foreground/65">
            {sinVerificar
              ? TEXTO_SIN_VERIFICAR
              : f.fechaVencimiento > FECHA_MIN
                ? f.estado === "vencida"
                  ? `Venció el ${fechaPlazo(f.fechaVencimiento)}`
                  : `Precio completo hasta el ${fechaPlazo(f.fechaVencimiento)}`
                : f.numeroFactura}
          </p>
        </div>
        <div className="text-right">
          <p className="text-[15px] font-semibold tabular-nums text-foreground">
            {cop(monto)}
          </p>
          {abonado > 0 ? (
            <p className="mt-0.5 text-xs text-foreground/60">
              Abonado {cop(abonado)} de {cop(f.totalAPagar)}
            </p>
          ) : null}
        </div>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {meta ? (
          <Badge tone={meta.tone} className="gap-1">
            {Icon ? <Icon className="h-3.5 w-3.5" aria-hidden /> : null}
            {meta.label}
          </Badge>
        ) : null}
        {sinVerificar ? <Badge tone="neutral">{ETIQUETA_SIN_VERIFICAR}</Badge> : null}
        {f.pdfUrl ? (
          <div className="ml-auto">
            <Button
              variant="outline"
              size="sm"
              asChild
              className="min-h-10 border-border/80 gap-1.5"
            >
              <a href={f.pdfUrl} target="_blank" rel="noopener noreferrer">
                <Download className="h-4 w-4" aria-hidden />
                PDF
              </a>
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function StatLink({
  href,
  label,
  value,
  sub,
  icon: Icon,
}: {
  href: string;
  label: string;
  value: string;
  sub?: string;
  icon: typeof PiggyBank;
}) {
  return (
    <LiquidGlassCard href={href} className="flex min-h-[4.5rem] flex-col justify-center px-3.5 py-3">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-sm text-foreground/65">{label}</span>
        <Icon className="h-4 w-4 text-foreground/40" aria-hidden />
      </div>
      <span className="truncate font-semibold text-foreground">{value}</span>
      {sub ? (
        <span className="mt-0.5 truncate text-xs text-foreground/55">{sub}</span>
      ) : null}
    </LiquidGlassCard>
  );
}
