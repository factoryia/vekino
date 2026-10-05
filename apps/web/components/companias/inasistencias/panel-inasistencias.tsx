"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { CalendarX, Plus } from "lucide-react";
import { api } from "@vekino/backend/api";
import type { Id } from "@vekino/backend/dataModel";
import {
  ETIQUETA_TIPO_INASISTENCIA,
  hoyColombia,
  sumarDias,
} from "@vekino/backend/inasistencias";
import { Badge } from "@/components/ui/badge";
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
import { RegistrarInasistenciaDialog } from "./registrar-dialog";
import { DetalleInasistenciaDialog } from "./detalle-dialog";
import { ventanaDe } from "./ventana";

/**
 * Las inasistencias de los guardas de la compañía: listar, registrar, ver y
 * anular.
 *
 * Es planificación, no permisos: aquí no se toca ninguna asignación ni se le
 * quita a nadie el acceso a un conjunto. Lo que se ve lo decide el SERVIDOR
 * —el administrador ve toda la compañía, el supervisor solo a los guardas de
 * sus conjuntos—; esta pantalla no filtra por rol.
 */

const DIA = 24 * 60 * 60 * 1000;

export function PanelInasistencias({
  companiaId,
}: {
  companiaId: Id<"companiasSeguridad">;
}) {
  const hoy = hoyColombia();
  const [desde, setDesde] = useState(hoy);
  const [hasta, setHasta] = useState(sumarDias(hoy, 30));
  const [registrar, setRegistrar] = useState(false);
  const [abierta, setAbierta] = useState<Id<"inasistencias"> | null>(null);

  /* El servidor rechaza un rango al revés o de más de un año; se avisa aquí
   * en vez de dejar que la consulta reviente el panel. */
  const errorRango =
    !desde || !hasta
      ? "Elige las dos fechas."
      : desde > hasta
        ? "La fecha final no puede ser anterior a la inicial."
        : Date.parse(hasta) - Date.parse(desde) >= 366 * DIA
          ? "Elige un periodo de hasta un año."
          : null;

  const lista = useQuery(
    api.inasistencias.deCompaniaEnRango,
    errorRango ? "skip" : { companiaId, desde, hasta },
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="max-w-xl text-sm text-muted-foreground">
          Cuándo un guarda no está disponible para planificar y por qué. No le
          quita el acceso a ningún conjunto ni toca sus asignaciones.
        </p>
        <Button size="sm" onClick={() => setRegistrar(true)}>
          <Plus className="h-4 w-4" aria-hidden />
          Registrar inasistencia
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
          Activas que se cruzan con el periodo. Fechas en hora de Colombia.
        </p>
      </div>

      {errorRango ? (
        <p className="text-sm text-destructive">{errorRango}</p>
      ) : lista === undefined ? (
        <Skeleton className="h-32 w-full" />
      ) : lista.length === 0 ? (
        <EmptyState
          icon={CalendarX}
          title="Sin inasistencias en este periodo"
          description="Las inasistencias anuladas no aparecen aquí; siguen en el historial de cada guarda."
        />
      ) : (
        <TableCard>
          <Table>
            <THead>
              <tr>
                <TH>Guarda</TH>
                <TH>Tipo</TH>
                <TH>Ventana</TH>
                <TH>Registrada por</TH>
                <TH className="text-right">Acciones</TH>
              </tr>
            </THead>
            <TBody>
              {lista.map((i) => (
                <TR key={i._id}>
                  <TD>
                    <CellStack primary={i.guardaNombre} secondary={i.motivo ?? undefined} />
                  </TD>
                  <TD>
                    <Badge tone="brand">{ETIQUETA_TIPO_INASISTENCIA[i.tipo]}</Badge>
                  </TD>
                  <TD className="tabular-nums">{ventanaDe(i)}</TD>
                  <TD className="text-muted-foreground">{i.registradaPorNombre}</TD>
                  <TD className="text-right">
                    <Button size="sm" variant="ghost" onClick={() => setAbierta(i._id)}>
                      Ver
                    </Button>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </TableCard>
      )}

      <RegistrarInasistenciaDialog
        companiaId={companiaId}
        open={registrar}
        onClose={() => setRegistrar(false)}
      />
      {abierta && (
        <DetalleInasistenciaDialog
          inasistenciaId={abierta}
          onClose={() => setAbierta(null)}
        />
      )}
    </div>
  );
}
