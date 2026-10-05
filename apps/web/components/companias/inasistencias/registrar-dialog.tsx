"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@vekino/backend/api";
import type { Id } from "@vekino/backend/dataModel";
import {
  ETIQUETA_TIPO_INASISTENCIA,
  MAX_MOTIVO,
  TIPOS_INASISTENCIA,
  exigeMotivo,
  hoyColombia,
  validarMotivo,
  ventanaInasistencia,
  type EntradaVentana,
  type TipoInasistencia,
} from "@vekino/backend/inasistencias";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { cn } from "@/lib/utils";
import { ventanaDe } from "./ventana";

/**
 * Registrar una inasistencia.
 *
 * Fechas y horas se mandan como TEXTO de pared y las interpreta el servidor
 * en hora de Colombia: la zona horaria del navegador de quien registra no
 * decide nada. El formulario valida con las mismas reglas que la mutación
 * (`@vekino/backend/inasistencias`), pero quien manda es el servidor.
 */
export function RegistrarInasistenciaDialog({
  companiaId,
  open,
  onClose,
}: {
  companiaId: Id<"companiasSeguridad">;
  open: boolean;
  onClose: () => void;
}) {
  const hoy = hoyColombia();
  const guardas = useQuery(
    api.inasistencias.guardasElegibles,
    open ? { companiaId } : "skip",
  );
  const crear = useMutation(api.inasistencias.crear);

  const [userId, setUserId] = useState<Id<"users"> | "">("");
  const [tipo, setTipo] = useState<TipoInasistencia>("incapacidad");
  const [diaCompleto, setDiaCompleto] = useState(true);
  const [fechaInicio, setFechaInicio] = useState(hoy);
  const [fechaFin, setFechaFin] = useState(hoy);
  const [inicioLocal, setInicioLocal] = useState(`${hoy}T06:00`);
  const [finLocal, setFinLocal] = useState(`${hoy}T18:00`);
  const [motivo, setMotivo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /* Lo que ya tiene activo el guarda elegido: es lo que haría chocar el
   * registro, y verlo antes ahorra el error. */
  const activas = useQuery(
    api.inasistencias.activasDeGuarda,
    open && userId ? { companiaId, userId } : "skip",
  );

  function cerrar() {
    setUserId("");
    setTipo("incapacidad");
    setDiaCompleto(true);
    setFechaInicio(hoy);
    setFechaFin(hoy);
    setInicioLocal(`${hoy}T06:00`);
    setFinLocal(`${hoy}T18:00`);
    setMotivo("");
    setError(null);
    onClose();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!userId) {
      setError("Elige el guarda.");
      return;
    }
    const ventana: EntradaVentana = diaCompleto
      ? { diaCompleto: true, fechaInicio, fechaFin }
      : { diaCompleto: false, inicioLocal, finLocal };
    try {
      ventanaInasistencia(ventana);
      validarMotivo(tipo, motivo);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Revisa los datos.");
      return;
    }
    setBusy(true);
    try {
      await crear({
        companiaId,
        userId,
        tipo,
        motivo: motivo.trim() || undefined,
        ventana,
      });
      cerrar();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo registrar.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={cerrar}
      title="Registrar inasistencia"
      description="El guarda queda como no disponible para planificar en esa ventana. No pierde sus asignaciones ni el acceso a sus conjuntos."
    >
      <form onSubmit={submit} className="space-y-3.5">
        <Campo label="Guarda" requerido>
          {guardas === undefined ? (
            <p className="text-sm text-muted-foreground">Cargando…</p>
          ) : guardas.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No hay guardas a tu cargo a los que registrar una inasistencia.
            </p>
          ) : (
            <Select
              value={userId}
              onChange={(e) => setUserId(e.target.value as Id<"users"> | "")}
              required
            >
              <option value="">Elige un guarda…</option>
              {guardas.map((g) => (
                <option key={g.userId} value={g.userId}>
                  {g.nombre}
                </option>
              ))}
            </Select>
          )}
        </Campo>

        {activas && activas.length > 0 && (
          <div className="rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">Inasistencias activas de este guarda</p>
            <ul className="mt-1 space-y-0.5">
              {activas.map((a) => (
                <li key={a._id}>
                  {ETIQUETA_TIPO_INASISTENCIA[a.tipo]} · {ventanaDe(a)}
                </li>
              ))}
            </ul>
          </div>
        )}

        <Campo label="Tipo" requerido>
          <Select
            value={tipo}
            onChange={(e) => setTipo(e.target.value as TipoInasistencia)}
          >
            {TIPOS_INASISTENCIA.map((t) => (
              <option key={t} value={t}>
                {ETIQUETA_TIPO_INASISTENCIA[t]}
              </option>
            ))}
          </Select>
        </Campo>

        <fieldset className="space-y-1.5">
          <legend className="text-[13px] font-medium text-foreground">Ventana</legend>
          <div className="flex gap-1 rounded-lg bg-muted p-1 text-[13px]">
            {[
              { valor: true, label: "Días completos" },
              { valor: false, label: "Con hora" },
            ].map((op) => (
              <button
                key={op.label}
                type="button"
                aria-pressed={diaCompleto === op.valor}
                onClick={() => setDiaCompleto(op.valor)}
                className={cn(
                  "flex-1 rounded-md px-3 py-1.5 transition-colors",
                  diaCompleto === op.valor
                    ? "bg-card font-medium text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {op.label}
              </button>
            ))}
          </div>
        </fieldset>

        {diaCompleto ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Campo label="Primer día" requerido>
              <Input
                type="date"
                value={fechaInicio}
                onChange={(e) => setFechaInicio(e.target.value)}
                required
              />
            </Campo>
            <Campo label="Último día" requerido ayuda="Cuenta entero.">
              <Input
                type="date"
                value={fechaFin}
                onChange={(e) => setFechaFin(e.target.value)}
                required
              />
            </Campo>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Campo label="Desde" requerido>
              <Input
                type="datetime-local"
                value={inicioLocal}
                onChange={(e) => setInicioLocal(e.target.value)}
                required
              />
            </Campo>
            <Campo label="Hasta" requerido>
              <Input
                type="datetime-local"
                value={finLocal}
                onChange={(e) => setFinLocal(e.target.value)}
                required
              />
            </Campo>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Fechas y horas en hora de Colombia.
        </p>

        <Campo
          label="Motivo"
          requerido={exigeMotivo(tipo)}
          ayuda={
            exigeMotivo(tipo)
              ? "Describe qué ocurrió."
              : "Opcional."
          }
        >
          <Textarea
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            maxLength={MAX_MOTIVO}
            rows={3}
          />
        </Campo>

        {error && (
          <p className="rounded-lg bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" onClick={cerrar}>
            Cancelar
          </Button>
          <Button type="submit" disabled={busy || !guardas?.length}>
            {busy ? "Registrando…" : "Registrar"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function Campo({
  label,
  requerido,
  ayuda,
  children,
}: {
  label: string;
  requerido?: boolean;
  ayuda?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-[13px] font-medium text-foreground">
        {label}
        {requerido && <span className="text-destructive"> *</span>}
      </span>
      {children}
      {ayuda && <span className="block text-xs text-muted-foreground">{ayuda}</span>}
    </label>
  );
}
