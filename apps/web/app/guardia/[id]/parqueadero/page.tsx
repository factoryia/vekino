"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@vekino/backend/api";
import type { Id } from "@vekino/backend/dataModel";
import { Car, Loader2, Search, TriangleAlert } from "lucide-react";
import { PageContainer } from "@/components/layout/page-container";
import { PageHeader } from "@/components/layout/page-header";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { cn, cop } from "@/lib/utils";

/**
 * Consulta de cupo de parqueadero desde la portería.
 *
 * El guarda escribe una placa y ve de un vistazo si esa casa tiene derecho a
 * parquear en zonas comunes. El estado sale del aporte voluntario que aparece
 * en la última factura de la unidad; no hay nada que capturar.
 *
 * El semáforo es por CASA, no por vehículo: el aporte se cobra por unidad y
 * la factura no dice a qué placa corresponde. Si la casa está al día, todos
 * sus vehículos entran.
 */

const COLOR: Record<string, { fondo: string; punto: string; texto: string }> = {
  rojo: {
    fondo: "border-red-500/40 bg-red-500/10",
    punto: "bg-red-500",
    texto: "text-red-700 dark:text-red-400",
  },
  azul: {
    fondo: "border-sky-500/40 bg-sky-500/10",
    punto: "bg-sky-500",
    texto: "text-sky-700 dark:text-sky-400",
  },
  morado: {
    fondo: "border-violet-500/40 bg-violet-500/10",
    punto: "bg-violet-500",
    texto: "text-violet-700 dark:text-violet-400",
  },
  gris: {
    fondo: "border-border bg-muted/40",
    punto: "bg-muted-foreground",
    texto: "text-muted-foreground",
  },
};

export default function ParqueaderoPage() {
  const { id } = useParams<{ id: string }>();
  const condominioId = id as Id<"condominios">;

  const [placa, setPlaca] = useState("");
  const [busqueda, setBusqueda] = useState("");

  // Espera a que termine de escribir la placa; si no, va una consulta por tecla.
  useEffect(() => {
    const t = setTimeout(() => setBusqueda(placa.trim()), 300);
    return () => clearTimeout(t);
  }, [placa]);

  const leyenda = useQuery(api.aporte.leyenda, { condominioId });
  const caracteresBusqueda = busqueda.replace(/[^a-z0-9]/gi, "").length;
  const resultados = useQuery(
    api.guardia.buscarVehiculo,
    caracteresBusqueda >= 2 ? { condominioId, texto: busqueda } : "skip",
  );
  const r = useQuery(
    api.aporte.consultarPlaca,
    caracteresBusqueda >= 3 ? { condominioId, placa: busqueda } : "skip",
  );

  return (
    <PageContainer>
      <div className="space-y-6">
        <PageHeader
          title="Cupo de parqueadero"
          description="Consulta si una placa tiene derecho a parquear en zonas comunes"
        />

        <div className="space-y-1.5">
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              value={placa}
              onChange={(e) => setPlaca(e.target.value.toUpperCase())}
              placeholder="ABC123"
              autoFocus
              autoCapitalize="characters"
              className="h-14 pl-12 font-mono text-xl tracking-widest"
            />
          </div>

          {resultados === undefined && caracteresBusqueda >= 2 ? (
            <div className="flex justify-center py-3">
              <Spinner className="h-4 w-4" />
            </div>
          ) : resultados && resultados.length > 0 ? (
            <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
              {resultados.map((v) => (
                <li key={v._id}>
                  <button
                    type="button"
                    onClick={() => setPlaca(v.placa)}
                    className="flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors hover:bg-accent"
                  >
                    <span className="font-mono text-sm font-bold tracking-wider text-foreground">
                      {v.placa}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                      {v.unidadNumero
                        ? `Unidad ${[v.unidadTorre, v.unidadNumero].filter(Boolean).join(" ")}`
                        : "Sin unidad"}
                      {v.residente ? ` — ${v.residente}` : ""}
                      {v.descripcion ? ` · ${v.descripcion}` : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        {r === undefined && caracteresBusqueda >= 3 ? (
          <Card className="flex justify-center p-10">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </Card>
        ) : r && !r.encontrado ? (
          <Card className="flex items-start gap-3 p-6">
            <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" aria-hidden />
            <div>
              <p className="font-semibold text-foreground">
                {r.placa} no está registrada
              </p>
              <p className="mt-0.5 text-sm text-muted-foreground">
                No pertenece a ninguna casa del conjunto. Si está parqueada en
                zona común, repórtala como novedad.
              </p>
            </div>
          </Card>
        ) : r?.encontrado ? (
          <Resultado r={r} />
        ) : null}

        {/* Leyenda: el guarda tiene que poder recordar qué significa cada color. */}
        {leyenda && (
          <Card className="p-5">
            <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Qué significa cada color
            </p>
            <ul className="space-y-2">
              {(["azul", "morado", "rojo", "gris"] as const).map((c) => (
                <li key={c} className="flex items-center gap-2.5 text-sm">
                  <span className={cn("h-3 w-3 shrink-0 rounded-full", COLOR[c]!.punto)} />
                  <span className="text-foreground">{leyenda.significado[c]}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-[11px] text-muted-foreground">
              Carro {cop(leyenda.tarifas.tarifaCarro)} · Moto{" "}
              {cop(leyenda.tarifas.tarifaMoto)} al mes. Sale en rojo a partir de{" "}
              {leyenda.tarifas.mesesParaMora} meses de atraso.
            </p>
          </Card>
        )}
      </div>
    </PageContainer>
  );
}

function Resultado({
  r,
}: {
  r: {
    placa: string;
    tipo: string;
    descripcion: string | null;
    unidadNumero: string | null;
    unidadTorre: string | null;
    color: string;
    significado: string;
    enMora: boolean;
    mesesAtraso: number;
    montoPendiente: number;
    periodoFactura: string | null;
    vehiculosEnLaCasa: number;
    cuposPagados: number;
  };
}) {
  const c = COLOR[r.color] ?? COLOR.gris!;
  const masVehiculosQueCupos = r.vehiculosEnLaCasa > r.cuposPagados && r.cuposPagados > 0;

  return (
    <Card className={cn("border-2 p-6", c.fondo)}>
      <div className="flex items-start gap-4">
        <span className={cn("mt-1.5 h-5 w-5 shrink-0 rounded-full", c.punto)} />
        <div className="min-w-0 flex-1">
          <p className="font-mono text-3xl font-bold tracking-widest text-foreground">
            {r.placa}
          </p>
          <p className={cn("mt-1 text-lg font-semibold", c.texto)}>{r.significado}</p>

          <dl className="mt-4 space-y-1.5 text-sm">
            <Fila
              k="Casa"
              v={
                r.unidadNumero
                  ? [r.unidadTorre, r.unidadNumero].filter(Boolean).join(" ")
                  : "—"
              }
            />
            <Fila k="Vehículo" v={[r.tipo, r.descripcion].filter(Boolean).join(" · ")} />
            {r.enMora && (
              <>
                <Fila k="Atraso" v={`${r.mesesAtraso} meses`} />
                <Fila k="Debe" v={cop(r.montoPendiente)} />
              </>
            )}
            {r.periodoFactura && <Fila k="Última factura" v={r.periodoFactura} />}
          </dl>

          {/* El sistema no puede saber cuál de los carros pagó el cupo, pero
              el guarda sí necesita enterarse de que la cuenta no cuadra. */}
          {masVehiculosQueCupos && (
            <p className="mt-4 rounded-lg bg-amber-500/15 px-3 py-2 text-[13px] text-amber-800 dark:text-amber-300">
              La casa tiene {r.vehiculosEnLaCasa} vehículos registrados y pagó{" "}
              {r.cuposPagados} cupo. Verifica con la administración cuál tiene
              derecho.
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}

function Fila({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-28 shrink-0 text-muted-foreground">{k}</dt>
      <dd className="font-medium capitalize text-foreground">{v || "—"}</dd>
    </div>
  );
}
