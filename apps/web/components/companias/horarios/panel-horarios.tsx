"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { CalendarClock, Plus } from "lucide-react";
import { api } from "@vekino/backend/api";
import type { Id } from "@vekino/backend/dataModel";
import { hoyColombia, sumarDias } from "@vekino/backend/inasistencias";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  CellStack,
  Table,
  TableCard,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from "@/components/ui/table";
import { CrearHorarioDialog, type ConjuntoOpcion } from "./crear-horario-dialog";
import { DetalleHorarioDialog, EstadoHorario, vigenciaDe } from "./detalle-horario-dialog";
import { ResumenSemanal } from "./resumen-semanal";

/**
 * El horario permanente de los guardas de la compañía: listar, registrar, ver
 * y finalizar.
 *
 * Es planificación informativa: no da ni quita acceso a ningún conjunto. Que
 * un guarda no aparezca aquí significa que no hay información de su horario,
 * no que esté libre. Lo que se ve lo decide el SERVIDOR —el administrador ve
 * toda la compañía, el supervisor a los guardas de sus conjuntos—.
 */

const DIA = 24 * 60 * 60 * 1000;

export function PanelHorarios({
  companiaId,
  conjuntos,
}: {
  companiaId: Id<"companiasSeguridad">;
  conjuntos: readonly ConjuntoOpcion[];
}) {
  const hoy = hoyColombia();
  const [desde, setDesde] = useState(hoy);
  const [hasta, setHasta] = useState(sumarDias(hoy, 30));
  const [registrar, setRegistrar] = useState(false);
  const [abierto, setAbierto] = useState<Id<"horariosGuarda"> | null>(null);

  const errorRango =
    !desde || !hasta
      ? "Elige las dos fechas."
      : desde > hasta
        ? "La fecha final no puede ser anterior a la inicial."
        : Date.parse(hasta) - Date.parse(desde) >= 366 * DIA
          ? "Elige un periodo de hasta un año."
          : null;

  const lista = useQuery(
    api.horariosGuarda.deCompaniaEnRango,
    errorRango ? "skip" : { companiaId, desde, hasta },
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="max-w-xl text-sm text-muted-foreground">
          Qué días y en qué horario debería trabajar cada guarda, según lo
          planificado. Es informativo: no da ni quita acceso a ningún conjunto.
        </p>
        <Button size="sm" onClick={() => setRegistrar(true)}>
          <Plus className="h-4 w-4" aria-hidden />
          Registrar horario
        </Button>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1.5">
          <span className="block text-[13px] font-medium text-foreground">Desde</span>
          <Input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} />
        </label>
        <label className="space-y-1.5">
          <span className="block text-[13px] font-medium text-foreground">Hasta</span>
          <Input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} />
        </label>
        <p className="pb-2 text-xs text-muted-foreground">
          Horarios cuya vigencia se cruza con el periodo. Hora de Colombia.
        </p>
      </div>

      {errorRango ? (
        <p className="text-sm text-destructive">{errorRango}</p>
      ) : lista === undefined ? (
        <Skeleton className="h-32 w-full" />
      ) : lista.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title="Sin horarios en este periodo"
          description="Que no haya horario significa que no hay información de planificación, no que el guarda esté libre."
        />
      ) : (
        <TableCard>
          <Table>
            <THead>
              <tr>
                <TH>Guarda</TH>
                <TH>Semana</TH>
                <TH>Vigencia</TH>
                <TH>Estado</TH>
                <TH className="text-right">Acciones</TH>
              </tr>
            </THead>
            <TBody>
              {lista.map((h) => (
                <TR key={h._id}>
                  <TD>
                    <CellStack
                      primary={h.guardaNombre}
                      secondary={h.condominioNombre ?? "General (sin conjunto)"}
                    />
                  </TD>
                  <TD className="text-[13px]">
                    <ResumenSemanal bloques={h.bloques} compacto />
                  </TD>
                  <TD className="tabular-nums">{vigenciaDe(h)}</TD>
                  <TD>
                    <EstadoHorario estado={h.estado} />
                  </TD>
                  <TD className="text-right">
                    <Button size="sm" variant="ghost" onClick={() => setAbierto(h._id)}>
                      Ver
                    </Button>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </TableCard>
      )}

      <CrearHorarioDialog
        companiaId={companiaId}
        conjuntos={conjuntos}
        open={registrar}
        onClose={() => setRegistrar(false)}
      />
      {abierto && (
        <DetalleHorarioDialog horarioId={abierto} onClose={() => setAbierto(null)} />
      )}
    </div>
  );
}
