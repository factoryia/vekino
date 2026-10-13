"use client";

import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { FileText, ExternalLink } from "lucide-react";
import { api } from "@vekino/backend/api";
import type { Id } from "@vekino/backend/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorBoundary, ErrorMessage } from "@/components/ui/error-boundary";
import { Modal } from "@/components/ui/modal";
import { Skeleton } from "@/components/ui/skeleton";
import { cop } from "@/lib/utils";

/**
 * Estado de cuenta de una unidad, sobre la tabla de reservas.
 *
 * ── Por qué carga aquí y no en la tabla ──────────────────────────────────
 * La tabla enseña el resumen de cada casa; el detalle son las facturas de
 * UNA, y sólo de la que la administración abre. Traer las facturas de las
 * treinta casas de la página para que se mire una sería cargar treinta veces
 * lo que se va a leer. Por eso la consulta va aquí dentro: este componente no
 * se monta hasta el clic, así que antes del clic no se pide nada.
 *
 * ── Al cerrar y volver a abrir ───────────────────────────────────────────
 * Se vuelve a consultar, a propósito y sin caché. Convex mantiene la consulta
 * viva mientras el modal está abierto y la suelta al cerrar: es una lectura
 * por índice de la cadena de una casa, barata. Guardarla sería enseñar
 * "Pendiente" en una factura que acaba de pagarse, y en cartera eso se paga
 * caro.
 */

type EstadoCuenta = NonNullable<
  FunctionReturnType<typeof api.facturas.estadoCuentaUnidad>
>;
type FilaFactura = EstadoCuenta["facturas"][number];
type EstadoFactura = FilaFactura["estado"];

/* Los mismos tonos y nombres que usa Finanzas: la administración ya sabe leer
 * estos badges, no hay por qué enseñarle otros. */
const ESTADO_TONE: Record<EstadoFactura, React.ComponentProps<typeof Badge>["tone"]> = {
  pendiente: "warning",
  pagada: "success",
  vencida: "destructive",
  abonada: "info",
  saldo_a_favor: "violet",
};
const ESTADO_LABEL: Record<EstadoFactura, string> = {
  pendiente: "Pendiente",
  pagada: "Pagada",
  vencida: "Vencida",
  abonada: "Abonada",
  saldo_a_favor: "Saldo a favor",
};

function fmtFecha(ts: number) {
  if (!ts) return "—";
  return new Date(ts).toLocaleDateString("es-CO", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

export function EstadoCuentaModal({
  condominioId,
  unidadId,
  unidadNumero,
  onClose,
}: {
  condominioId: Id<"condominios">;
  unidadId: Id<"unidades">;
  /** El de la reserva, para poder titular el modal antes de que llegue nada. */
  unidadNumero: string;
  onClose: () => void;
}) {
  return (
    <Modal
      open
      onClose={onClose}
      title={`Estado de cuenta — Unidad ${unidadNumero}`}
      description="Facturas de la unidad según el módulo de Finanzas"
      className="max-w-3xl"
      footer={
        <Button size="sm" onClick={onClose}>
          Cerrar
        </Button>
      }
    >
      <ErrorBoundary
        resetKey={unidadId}
        fallback={(e) => (
          <ErrorMessage
            title="No se pudo cargar el estado de cuenta"
            detail={e.message}
          />
        )}
      >
        <Contenido condominioId={condominioId} unidadId={unidadId} />
      </ErrorBoundary>
    </Modal>
  );
}

function Contenido({
  condominioId,
  unidadId,
}: {
  condominioId: Id<"condominios">;
  unidadId: Id<"unidades">;
}) {
  /* La consulta arranca al montarse este componente, que es al abrir el modal.
   * Antes del clic no se pide nada. */
  const data = useQuery(api.facturas.estadoCuentaUnidad, {
    condominioId,
    unidadId,
  });

  if (data === undefined) return <CargandoFacturas />;

  if (data === null) {
    return (
      <ErrorMessage
        title="Unidad no disponible"
        detail="La unidad ya no existe o no pertenece a este conjunto."
      />
    );
  }

  if (data.facturas.length === 0) {
    return (
      <EmptyState
        icon={FileText}
        title="Sin facturas"
        description="A esta unidad todavía no se le han cargado facturas, así que no hay cartera que mostrar."
      />
    );
  }

  const { cartera } = data;

  return (
    <div className="space-y-4">
      {/* Dos datos, y ninguno se calcula aquí.
          El saldo sale de la factura vigente, que ya arrastra todo lo
          anterior. Sumar los saldos del historial —que es lo que hacía esta
          pantalla— no contaba dos veces: resucitaba deuda ya pagada, porque
          cada factura absorbe el saldo de la anterior. */}
      <div className="flex flex-wrap items-center gap-x-8 gap-y-2 rounded-xl border border-border bg-muted/40 px-4 py-3">
        <Dato etiqueta="Saldo pendiente actual" valor={cop(cartera.saldoActual)} />
        <Dato
          etiqueta="Mora actual"
          valor={
            cartera.estado === "en_mora"
              ? `${cartera.diasMora} ${cartera.diasMora === 1 ? "día" : "días"}`
              : "Sin mora"
          }
          tono={cartera.estado === "en_mora" ? "mora" : undefined}
        />
      </div>

      <p className="pt-1 text-[11px] font-medium uppercase tracking-[0.04em] text-muted-foreground">
        Historial de facturas
      </p>

      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-brand/[0.07] text-left text-xs text-muted-foreground">
              <th className="px-3 py-2 font-medium">Factura</th>
              <th className="hidden px-3 py-2 font-medium sm:table-cell">Fecha de vencimiento</th>
              <th className="px-3 py-2 text-right font-medium">Valor</th>
              <th className="px-3 py-2 font-medium">Estado</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {data.facturas.map((f) => (
              <tr key={f._id} className="even:bg-brand/[0.035]">
                <td className="px-3 py-2">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium text-foreground">{f.numeroFactura}</span>
                    {f.pdfUrl && (
                      <a
                        href={f.pdfUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`Abrir PDF de ${f.numeroFactura}`}
                        className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    )}
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Emitida {fmtFecha(f.fechaEmision)}
                  </p>
                </td>
                <td className="hidden px-3 py-2 tabular-nums text-foreground sm:table-cell">
                  {fmtFecha(f.fechaVencimiento)}
                </td>
                <td className="px-3 py-2 text-right font-medium tabular-nums text-foreground">
                  {cop(f.totalAPagar)}
                </td>
                <td className="px-3 py-2">
                  {/* La vigente de una unidad en mora se ve "Vencida", como dice
                      la cartera de arriba (QA de comprobantes, H2). */}
                  <Badge tone={ESTADO_TONE[f.estadoVisible === "vencida" ? "vencida" : f.estado]}>
                    {ESTADO_LABEL[f.estadoVisible === "vencida" ? "vencida" : f.estado]}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Dato({
  etiqueta,
  valor,
  tono,
}: {
  etiqueta: string;
  valor: string;
  tono?: "mora";
}) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-[0.04em] text-muted-foreground">
        {etiqueta}
      </p>
      <p
        className={
          tono === "mora"
            ? "text-sm font-semibold text-red-600 dark:text-red-400"
            : "text-sm font-semibold text-foreground"
        }
      >
        {valor}
      </p>
    </div>
  );
}

function CargandoFacturas() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-16 rounded-xl" />
      <div className="overflow-hidden rounded-xl border border-border">
        <div className="divide-y divide-border">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 px-3 py-3">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-4 w-36" />
              <Skeleton className="ml-auto h-4 w-20" />
              <Skeleton className="h-5 w-16 rounded-full" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
