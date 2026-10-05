"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { CalendarCheck, Search, Send } from "lucide-react";
import { api } from "@vekino/backend/api";
import type { Id } from "@vekino/backend/dataModel";
import {
  ESTADOS_DISPONIBILIDAD,
  ETIQUETA_DISPONIBILIDAD,
  ventanaDeConsulta,
  type EstadoDisponibilidad,
} from "@vekino/backend/disponibilidad";
import {
  NOMBRES_DIA,
  diaDeLaSemana,
  fechaCorta,
  terminaAlDiaSiguiente,
} from "@vekino/backend/horariosGuarda";
import {
  ETIQUETA_TIPO_INASISTENCIA,
  etiquetaInstante,
  hoyColombia,
  type EntradaVentana,
  type TipoInasistencia,
} from "@vekino/backend/inasistencias";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input, Select } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableCard, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { cn } from "@/lib/utils";

/**
 * Disponibilidad de los guardas para una ventana, y desde aquí la solicitud
 * de cobertura.
 *
 * La disponibilidad la calcula el servidor con horarios, inasistencias y
 * coberturas ya aceptadas. Solo a quien sale "Disponible" se le puede pedir
 * una cobertura: "Sin información" no es "libre". Pedirla no cambia nada:
 * queda pendiente hasta que el guarda responda. Aceptada, entra en vigencia
 * cuando empieza su ventana, y durante ella el guarda opera temporalmente en
 * el conjunto destino.
 */

const TONO: Record<EstadoDisponibilidad, "success" | "warning" | "destructive" | "neutral"> = {
  disponible: "success",
  ocupado: "warning",
  no_disponible: "destructive",
  desconocido: "neutral",
};

export type ContratoDestino = {
  contratoId: Id<"companiaContratos">;
  condominioId: Id<"condominios">;
  condominioNombre: string;
};

type Motivo =
  | { tipo: "inasistencia"; categoria: TipoInasistencia; inicio: number; fin: number }
  | {
      tipo: "horario";
      condominioNombre: string | null;
      fecha: string;
      horaInicio: string;
      horaFin: string;
      inicio: number;
      fin: number;
    }
  | { tipo: "cobertura"; condominioNombre: string; inicio: number; fin: number }
  | { tipo: "sin_horario"; fechas: string[] };

/** Un motivo como se lee. De una inasistencia solo se dice la categoría. */
function textoMotivo(m: Motivo): string {
  if (m.tipo === "inasistencia") {
    return `Inasistencia (${ETIQUETA_TIPO_INASISTENCIA[m.categoria]}) · ${etiquetaInstante(m.inicio)} → ${etiquetaInstante(m.fin)}`;
  }
  if (m.tipo === "horario") {
    const dia = diaDeLaSemana(m.fecha);
    const masUno = terminaAlDiaSiguiente({ dia, horaInicio: m.horaInicio, horaFin: m.horaFin });
    return `Planificado en ${m.condominioNombre ?? "su horario general"}: ${NOMBRES_DIA[dia]!.slice(0, 3)} ${fechaCorta(m.fecha)} ${m.horaInicio}–${m.horaFin}${masUno ? " (+1)" : ""}`;
  }
  if (m.tipo === "cobertura") {
    return `Ya cubre ${m.condominioNombre}: ${etiquetaInstante(m.inicio)} → ${etiquetaInstante(m.fin)}`;
  }
  return `Sin horario registrado para ${m.fechas.map(fechaCorta).join(", ")}`;
}

export function PanelDisponibilidad({
  companiaId,
  contratos,
}: {
  companiaId: Id<"companiasSeguridad">;
  /** Los conjuntos a los que quien mira puede mandar una cobertura. */
  contratos: readonly ContratoDestino[];
}) {
  const hoy = hoyColombia();
  const [diaCompleto, setDiaCompleto] = useState(false);
  const [fecha, setFecha] = useState(hoy);
  const [inicioLocal, setInicioLocal] = useState(`${hoy}T18:00`);
  const [finLocal, setFinLocal] = useState(`${hoy}T22:00`);
  const [destino, setDestino] = useState<Id<"companiaContratos"> | "">("");
  const [consulta, setConsulta] = useState<EntradaVentana | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [solicitar, setSolicitar] = useState<{ userId: Id<"users">; nombre: string } | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  const resultado = useQuery(
    api.disponibilidad.deGuardasEnAlcance,
    consulta ? { companiaId, ventana: consulta } : "skip",
  );
  const contratoDestino = contratos.find((c) => c.contratoId === destino) ?? null;

  function consultar(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setAviso(null);
    const ventana: EntradaVentana = diaCompleto
      ? { diaCompleto: true, fechaInicio: fecha, fechaFin: fecha }
      : { diaCompleto: false, inicioLocal, finLocal };
    try {
      ventanaDeConsulta(ventana);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Revisa la ventana.");
      return;
    }
    setConsulta(ventana);
  }

  const conteo = resultado
    ? ESTADOS_DISPONIBILIDAD.map((estado) => ({
        estado,
        n: resultado.guardas.filter((g) => g.estado === estado).length,
      }))
    : [];

  return (
    <div className="space-y-4">
      <p className="max-w-2xl text-sm text-muted-foreground">
        Quién podría cubrir una ventana completa, según horarios, inasistencias
        y coberturas ya aceptadas. Solo a quien sale «Disponible» se le puede
        pedir una cobertura. «Sin información» significa que no hay horario
        registrado, no que el guarda esté libre.
      </p>

      <form onSubmit={consultar} className="flex flex-wrap items-end gap-3">
        <div className="flex gap-1 rounded-lg bg-muted p-1 text-[13px]">
          {[
            { valor: false, label: "Con hora" },
            { valor: true, label: "Día completo" },
          ].map((op) => (
            <button
              key={op.label}
              type="button"
              aria-pressed={diaCompleto === op.valor}
              onClick={() => setDiaCompleto(op.valor)}
              className={cn(
                "rounded-md px-3 py-1.5 transition-colors",
                diaCompleto === op.valor
                  ? "bg-card font-medium text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {op.label}
            </button>
          ))}
        </div>
        {diaCompleto ? (
          <label className="space-y-1.5">
            <span className="block text-[13px] font-medium text-foreground">Día</span>
            <Input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} required />
          </label>
        ) : (
          <>
            <label className="space-y-1.5">
              <span className="block text-[13px] font-medium text-foreground">Desde</span>
              <Input
                type="datetime-local"
                value={inicioLocal}
                onChange={(e) => setInicioLocal(e.target.value)}
                required
              />
            </label>
            <label className="space-y-1.5">
              <span className="block text-[13px] font-medium text-foreground">Hasta</span>
              <Input
                type="datetime-local"
                value={finLocal}
                onChange={(e) => setFinLocal(e.target.value)}
                required
              />
            </label>
          </>
        )}
        <label className="space-y-1.5">
          <span className="block text-[13px] font-medium text-foreground">Conjunto a cubrir</span>
          <Select
            value={destino}
            onChange={(e) => setDestino(e.target.value as Id<"companiaContratos"> | "")}
          >
            <option value="">Solo consultar</option>
            {contratos.map((c) => (
              <option key={c.contratoId} value={c.contratoId}>
                {c.condominioNombre}
              </option>
            ))}
          </Select>
        </label>
        <Button type="submit" size="sm">
          <Search className="h-4 w-4" aria-hidden />
          Consultar
        </Button>
        <p className="pb-2 text-xs text-muted-foreground">Hora de Colombia.</p>
      </form>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {aviso && (
        <p className="rounded-lg bg-emerald-500/10 px-3 py-2 text-[13px] text-emerald-700 dark:text-emerald-400">
          {aviso}
        </p>
      )}

      {consulta === null ? (
        <EmptyState
          icon={CalendarCheck}
          title="Elige una ventana"
          description="Indica el turno que habría que cubrir y consulta quién podría hacerlo."
        />
      ) : resultado === undefined ? (
        <Skeleton className="h-32 w-full" />
      ) : resultado.guardas.length === 0 ? (
        <EmptyState
          icon={CalendarCheck}
          title="No hay guardas a tu cargo"
          description="La consulta solo incluye a los guardas de alta que puedes gestionar."
        />
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2 text-xs">
            {conteo.map(({ estado, n }) => (
              <Badge key={estado} tone={TONO[estado]}>
                {ETIQUETA_DISPONIBILIDAD[estado]}: {n}
              </Badge>
            ))}
          </div>
          <TableCard>
            <Table>
              <THead>
                <tr>
                  <TH>Guarda</TH>
                  <TH>Estado</TH>
                  <TH>Motivos</TH>
                  <TH className="text-right">Cobertura</TH>
                </tr>
              </THead>
              <TBody>
                {resultado.guardas.map((g) => (
                  <TR key={g.userId}>
                    <TD className="font-medium text-foreground">{g.nombre}</TD>
                    <TD>
                      <Badge tone={TONO[g.estado]}>{ETIQUETA_DISPONIBILIDAD[g.estado]}</Badge>
                    </TD>
                    <TD className="text-[13px] text-muted-foreground">
                      {g.motivos.length === 0 ? (
                        "Su horario no lo ocupa en esa ventana."
                      ) : (
                        <ul className="space-y-0.5">
                          {g.motivos.map((m, i) => (
                            <li key={i}>{textoMotivo(m as Motivo)}</li>
                          ))}
                        </ul>
                      )}
                    </TD>
                    <TD className="text-right">
                      {/* Solo a quien está disponible. El servidor lo vuelve
                          a comprobar todo al solicitar. */}
                      {g.estado === "disponible" && (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={!contratoDestino}
                          title={contratoDestino ? undefined : "Elige el conjunto a cubrir"}
                          onClick={() => {
                            setAviso(null);
                            setSolicitar({ userId: g.userId, nombre: g.nombre });
                          }}
                        >
                          <Send className="h-3.5 w-3.5" aria-hidden />
                          Solicitar cobertura
                        </Button>
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableCard>
          {!contratoDestino && (
            <p className="text-xs text-muted-foreground">
              Para solicitar una cobertura, elige el conjunto a cubrir.
            </p>
          )}
        </div>
      )}

      {solicitar && contratoDestino && consulta && resultado && (
        <SolicitarCoberturaDialog
          guarda={solicitar}
          destino={contratoDestino}
          ventana={consulta}
          etiquetaVentana={`${etiquetaInstante(resultado.ventana.inicio)} → ${etiquetaInstante(resultado.ventana.fin)}`}
          onClose={() => setSolicitar(null)}
          onEnviada={() => {
            setAviso(
              `Solicitud enviada a ${solicitar.nombre}. Queda pendiente hasta que la acepte o la rechace.`,
            );
            setSolicitar(null);
          }}
        />
      )}
    </div>
  );
}

function SolicitarCoberturaDialog({
  guarda,
  destino,
  ventana,
  etiquetaVentana,
  onClose,
  onEnviada,
}: {
  guarda: { userId: Id<"users">; nombre: string };
  destino: ContratoDestino;
  ventana: EntradaVentana;
  etiquetaVentana: string;
  onClose: () => void;
  onEnviada: () => void;
}) {
  const crear = useMutation(api.coberturas.crear);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <Modal
      open
      onClose={onClose}
      title="Solicitar cobertura"
      description="El guarda recibe la solicitud y decide. Si la acepta, entra en vigencia cuando comienza la ventana y, durante ese periodo, opera temporalmente en este conjunto."
    >
      <div className="space-y-4">
        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-muted-foreground">Guarda</dt>
            <dd className="mt-0.5 text-foreground">{guarda.nombre}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Conjunto a cubrir</dt>
            <dd className="mt-0.5 text-foreground">{destino.condominioNombre}</dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-xs text-muted-foreground">Ventana (hora de Colombia)</dt>
            <dd className="mt-0.5 tabular-nums text-foreground">{etiquetaVentana}</dd>
          </div>
        </dl>
        {error && (
          <p className="rounded-lg bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button
            type="button"
            disabled={busy}
            onClick={async () => {
              setError(null);
              setBusy(true);
              try {
                await crear({ contratoId: destino.contratoId, userId: guarda.userId, ventana });
                onEnviada();
              } catch (e) {
                setError(e instanceof Error ? e.message : "No se pudo enviar la solicitud.");
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Enviando…" : "Enviar solicitud"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
