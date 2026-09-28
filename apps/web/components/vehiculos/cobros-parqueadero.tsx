"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  Camera, Check, Download, FileSpreadsheet, Loader2, RotateCcw, Search, Settings2, X,
} from "lucide-react";
import { api } from "@vekino/backend/api";
import type { Id } from "@vekino/backend/dataModel";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { cn, cop } from "@/lib/utils";
import { descargarXlsxReporte } from "@/lib/excel-reporte";
import { csvReporteParqueaderos, ETIQUETA_ESTADO_PARQUEADERO, opcionesXlsxReporteParqueaderos } from "@/lib/reporte-parqueaderos";

/**
 * Cobros de parqueadero pendientes de pasar a la factura.
 *
 * El panel anterior leía las FACTURAS y mostraba a quién el software contable
 * ya le había cobrado la contribución voluntaria: arrancaba con el histórico
 * entero del conjunto y no servía para gestionar. Decía lo que ya pasó, no lo
 * que hay que hacer.
 *
 * Este nace vacío. Se llena con lo que el guarda reporta en la ronda, con
 * foto, y cada fila se marca cuando el cargo ya quedó en una factura — para
 * que no se cobre dos veces ni se quede ninguno sin cobrar.
 */

type Estado = "pendiente" | "facturado" | "descartado" | "todos";

const ETIQUETA: Record<Exclude<Estado, "todos">, { texto: string; clase: string }> = {
  pendiente: { texto: ETIQUETA_ESTADO_PARQUEADERO.pendiente, clase: "bg-amber-500/10 text-amber-700 dark:text-amber-400" },
  facturado: { texto: ETIQUETA_ESTADO_PARQUEADERO.facturado, clase: "bg-emerald-500/10 text-emerald-600" },
  descartado: { texto: ETIQUETA_ESTADO_PARQUEADERO.descartado, clase: "bg-muted text-muted-foreground" },
};

export function CobrosParqueaderoPanel({
  condominioId,
}: {
  condominioId: Id<"condominios">;
}) {
  const [estado, setEstado] = useState<Estado>("pendiente");
  const [periodo, setPeriodo] = useState("");
  const [busqueda, setBusqueda] = useState("");
  const [tarifas, setTarifas] = useState(false);
  const [generandoExcel, setGenerandoExcel] = useState(false);
  const [errorExcel, setErrorExcel] = useState<string | null>(null);

  const data = useQuery(api.parqueadero.listar, {
    condominioId,
    estado,
    periodo: periodo || undefined,
    busqueda: busqueda.trim() || undefined,
  });

  function descargar() {
    if (!data) return;
    const csv = csvReporteParqueaderos(data.filas);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
    a.download = `cobros-parqueadero-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  }

  async function descargarExcel() {
    if (!data?.filas.length) return;
    setGenerandoExcel(true);
    setErrorExcel(null);
    try {
      await descargarXlsxReporte(opcionesXlsxReporteParqueaderos({
        filas: data.filas,
        estado,
        periodo,
        busqueda,
        fechaArchivo: new Date().toISOString().slice(0, 10),
      }));
    } catch {
      setErrorExcel("No se pudo generar el Excel. Intenta de nuevo.");
    } finally {
      setGenerandoExcel(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-foreground">Estado</label>
          <Select
            value={estado}
            onChange={(e) => { setEstado(e.target.value as Estado); setPeriodo(""); }}
            className="w-44"
          >
            <option value="pendiente">Por cobrar</option>
            <option value="facturado">Ya facturados</option>
            <option value="descartado">No se cobran</option>
            <option value="todos">Todos</option>
          </Select>
        </div>

        {/* El filtro por mes solo tiene sentido sobre lo ya facturado. */}
        {(estado === "facturado" || estado === "todos") && (data?.periodos.length ?? 0) > 0 && (
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-foreground">Periodo</label>
            <Select value={periodo} onChange={(e) => setPeriodo(e.target.value)} className="w-36">
              <option value="">Todos</option>
              {(data?.periodos ?? []).map((p) => (
                <option key={p} value={p!}>{p}</option>
              ))}
            </Select>
          </div>
        )}

        <div className="min-w-[200px] flex-1 space-y-1.5">
          <label className="block text-xs font-medium text-foreground">Buscar</label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="Casa, placa o motivo"
              className="pl-9"
            />
          </div>
        </div>

        <Button variant="outline" size="sm" onClick={() => setTarifas(true)}>
          <Settings2 className="h-4 w-4" /> Tarifas
        </Button>
        <Button variant="outline" size="sm" onClick={descargar} disabled={!data?.filas.length}>
          <Download className="h-4 w-4" /> Descargar CSV
        </Button>
        <Button variant="outline" size="sm" onClick={descargarExcel} disabled={!data?.filas.length || generandoExcel}>
          {generandoExcel ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4" />}
          Descargar Excel
        </Button>
      </div>
      {errorExcel && <p className="text-sm text-red-600 dark:text-red-400">{errorExcel}</p>}

      {data && (
        <div className="grid grid-cols-3 gap-3">
          <Dato valor={String(data.resumen.pendientes)} etiqueta="Por cobrar"
                alerta={data.resumen.pendientes > 0} />
          <Dato valor={cop(data.resumen.valorPendiente)} etiqueta="Valor pendiente" />
          <Dato valor={String(data.resumen.casas)} etiqueta="Casas involucradas" />
        </div>
      )}

      {data === undefined ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : data.filas.length === 0 ? (
        <Vacio estado={estado} />
      ) : (
        <div className="space-y-2">
          {data.filas.map((f) => (
            <Fila key={f._id} fila={f} periodoSugerido={data.periodoSugerido} />
          ))}
        </div>
      )}

      {tarifas && (
        <TarifasResumen tarifas={data?.tarifas} onClose={() => setTarifas(false)} />
      )}
    </div>
  );
}

/**
 * El vacío explica qué falta, no solo que no hay nada.
 *
 * Un conjunto que arranca ve esta pantalla el primer día, y «sin resultados»
 * no le dice a nadie qué tiene que pasar para que aparezca algo.
 */
function Vacio({ estado }: { estado: Estado }) {
  const texto =
    estado === "pendiente"
      ? "No hay cobros pendientes. Cuando un guarda reporte un vehículo con evidencia durante la ronda, aparecerá aquí para pasarlo a la factura."
      : estado === "facturado"
        ? "Todavía no se ha facturado ningún cobro de parqueadero."
        : estado === "descartado"
          ? "No se ha descartado ningún cobro."
          : "Aún no hay reportes de vehículos.";
  return (
    <p className="rounded-2xl border border-dashed border-border px-6 py-12 text-center text-sm text-muted-foreground">
      {texto}
    </p>
  );
}

function Fila({
  fila,
  periodoSugerido,
}: {
  fila: {
    _id: Id<"guardiaNovedadReportes">;
    placa: string; descripcion: string | null; casas: string[];
    titulo: string; ocurrioEn: number; estado: string; monto: number;
    periodo: string | null; cobradoPor: string | null; nota: string | null;
    fotos: (string | null)[];
  };
  periodoSugerido: string;
}) {
  const marcar = useMutation(api.parqueadero.marcarFacturado);
  const descartar = useMutation(api.parqueadero.descartar);
  const devolver = useMutation(api.parqueadero.devolverAPendiente);

  const [abierto, setAbierto] = useState<null | "facturar" | "descartar">(null);
  const [periodo, setPeriodo] = useState(periodoSugerido);
  const [nota, setNota] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const et = ETIQUETA[fila.estado as Exclude<Estado, "todos">];
  const fotos = fila.fotos.filter((u): u is string => !!u);

  async function accion(fn: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try { await fn(); setAbierto(null); }
    catch (e) { setError(e instanceof Error ? e.message : "No se pudo."); }
    finally { setBusy(false); }
  }

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm font-semibold text-foreground">{fila.placa}</span>
            <span className="text-sm text-foreground">
              {fila.casas.length ? `Casa ${fila.casas.join(", ")}` : "sin casa asignada"}
            </span>
            {et && (
              <span className={cn("rounded px-2 py-0.5 text-[11px] font-medium", et.clase)}>
                {et.texto}
              </span>
            )}
            {fila.periodo && (
              <span className="rounded bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                {fila.periodo}
              </span>
            )}
          </div>
          <p className="mt-1 text-[13px] text-muted-foreground">{fila.titulo}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {new Date(fila.ocurrioEn).toLocaleString("es-CO", {
              day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
            })}
            {fila.descripcion ? ` · ${fila.descripcion}` : ""}
            {fotos.length > 0 && (
              <span className="ml-2 inline-flex items-center gap-1">
                <Camera className="h-3 w-3" /> {fotos.length}
              </span>
            )}
          </p>
          {fila.nota && (
            <p className="mt-1 text-xs text-muted-foreground">
              <span className="font-medium">No se cobra:</span> {fila.nota}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <span className="text-sm font-semibold text-foreground">{cop(fila.monto)}</span>
          {fila.estado === "pendiente" ? (
            <>
              <Button size="sm" onClick={() => setAbierto("facturar")}>
                <Check className="h-4 w-4" /> Facturar
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setAbierto("descartar")}>
                <X className="h-4 w-4" />
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => accion(() => devolver({ reporteId: fila._id }))}
              disabled={busy}
              title="Devolver a pendiente"
            >
              <RotateCcw className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {/* La evidencia va a la vista: es lo que sostiene el cobro cuando el
          propietario reclama meses después. */}
      {fotos.length > 0 && (
        <div className="mt-3 flex gap-2 overflow-x-auto">
          {fotos.map((u) => (
            <a key={u} href={u} target="_blank" rel="noopener noreferrer" className="shrink-0">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={u} alt="Evidencia" className="h-20 w-28 rounded-lg border border-border object-cover" />
            </a>
          ))}
        </div>
      )}

      {abierto === "facturar" && (
        <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-border pt-3">
          <div className="space-y-1">
            <label className="block text-xs text-muted-foreground">Periodo de la factura</label>
            <Input value={periodo} onChange={(e) => setPeriodo(e.target.value)}
                   placeholder="2026-10" className="w-32" />
          </div>
          <Button size="sm" disabled={busy}
                  onClick={() => accion(() => marcar({ reporteId: fila._id, periodo, monto: fila.monto }))}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            Confirmar
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setAbierto(null)}>Cancelar</Button>
        </div>
      )}

      {abierto === "descartar" && (
        <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-border pt-3">
          <div className="min-w-[220px] flex-1 space-y-1">
            <label className="block text-xs text-muted-foreground">¿Por qué no se cobra?</label>
            <Input value={nota} onChange={(e) => setNota(e.target.value)}
                   placeholder="El residente demostró que sí pagó" />
          </div>
          <Button size="sm" variant="outline" disabled={busy}
                  onClick={() => accion(() => descartar({ reporteId: fila._id, nota }))}>
            No cobrar
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setAbierto(null)}>Cancelar</Button>
        </div>
      )}

      {error && <p className="mt-2 text-[13px] text-destructive">{error}</p>}
    </div>
  );
}

function Dato({ valor, etiqueta, alerta }: { valor: string; etiqueta: string; alerta?: boolean }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className={cn("text-2xl font-semibold", alerta ? "text-amber-600" : "text-foreground")}>
        {valor}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{etiqueta}</p>
    </div>
  );
}

function TarifasResumen({
  tarifas,
  onClose,
}: {
  tarifas?: { tarifaCarro: number; tarifaMoto: number; mesesParaMora: number };
  onClose: () => void;
}) {
  return (
    <Modal open onClose={onClose} title="Tarifas del aporte"
           description="Con estas se propone el valor de cada cobro">
      <dl className="space-y-2 text-sm">
        <div className="flex justify-between"><dt className="text-muted-foreground">Carro</dt>
          <dd className="font-medium">{cop(tarifas?.tarifaCarro ?? 0)}</dd></div>
        <div className="flex justify-between"><dt className="text-muted-foreground">Moto</dt>
          <dd className="font-medium">{cop(tarifas?.tarifaMoto ?? 0)}</dd></div>
      </dl>
      <p className="mt-4 text-xs text-muted-foreground">
        Se configuran desde Vehículos → Aporte voluntario.
      </p>
    </Modal>
  );
}
