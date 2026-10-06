"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Plus, Trash2 } from "lucide-react";
import { api } from "@vekino/backend/api";
import type { Id } from "@vekino/backend/dataModel";
import {
  NOMBRES_DIA,
  ORDEN_SEMANA,
  MAX_BLOQUES,
  terminaAlDiaSiguiente,
  validarBloques,
  validarVigencia,
  type BloqueSemanal,
} from "@vekino/backend/horariosGuarda";
import { hoyColombia } from "@vekino/backend/inasistencias";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { ResumenSemanal } from "./resumen-semanal";
import { mensajeErrorUsuario } from "@/lib/utils";

/**
 * Registrar un horario.
 *
 * La vigencia va en fechas civiles y la lee el servidor en hora de Colombia.
 * El formulario valida con las mismas reglas que la mutación
 * (`@vekino/backend/horariosGuarda`), pero quien manda es el servidor.
 *
 * Para cambiar un horario no se edita: se finaliza el que rige y se registra
 * otro, para que siempre se sepa qué estaba planificado antes.
 */

export type ConjuntoOpcion = {
  condominioId: Id<"condominios">;
  condominioNombre: string;
};

type BloqueEditable = BloqueSemanal & { key: number };

let siguienteKey = 1;

export function CrearHorarioDialog({
  companiaId,
  conjuntos,
  open,
  onClose,
}: {
  companiaId: Id<"companiasSeguridad">;
  /** Los conjuntos con los que la compañía tiene contrato, y alcanza quien registra. */
  conjuntos: readonly ConjuntoOpcion[];
  open: boolean;
  onClose: () => void;
}) {
  const hoy = hoyColombia();
  const guardas = useQuery(
    api.horariosGuarda.guardasElegibles,
    open ? { companiaId } : "skip",
  );
  const crear = useMutation(api.horariosGuarda.crear);

  const [userId, setUserId] = useState<Id<"users"> | "">("");
  const [condominioId, setCondominioId] = useState<Id<"condominios"> | "">("");
  const [fechaInicio, setFechaInicio] = useState(hoy);
  const [fechaFin, setFechaFin] = useState("");
  const [bloques, setBloques] = useState<BloqueEditable[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /* Lo que ya rige para el guarda elegido: es lo que haría chocar el registro
   * si es del mismo conjunto. */
  const vigentes = useQuery(
    api.horariosGuarda.vigentesDeGuarda,
    open && userId ? { companiaId, userId } : "skip",
  );

  function cerrar() {
    setUserId("");
    setCondominioId("");
    setFechaInicio(hoy);
    setFechaFin("");
    setBloques([]);
    setError(null);
    onClose();
  }

  function agregar(dia: number) {
    setBloques((xs) => [
      ...xs,
      { key: siguienteKey++, dia, horaInicio: "06:00", horaFin: "18:00" },
    ]);
  }

  function cambiar(key: number, patch: Partial<BloqueSemanal>) {
    setBloques((xs) => xs.map((x) => (x.key === key ? { ...x, ...patch } : x)));
  }

  function quitar(key: number) {
    setBloques((xs) => xs.filter((x) => x.key !== key));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!userId) {
      setError("Elige el guarda.");
      return;
    }
    const limpios = bloques.map(({ dia, horaInicio, horaFin }) => ({ dia, horaInicio, horaFin }));
    try {
      validarVigencia(fechaInicio, fechaFin || undefined);
      validarBloques(limpios);
    } catch (err) {
      setError(mensajeErrorUsuario(err, "Revisa los datos."));
      return;
    }
    setBusy(true);
    try {
      await crear({
        companiaId,
        userId,
        condominioId: condominioId || undefined,
        fechaInicio,
        fechaFin: fechaFin || undefined,
        bloques: limpios,
      });
      cerrar();
    } catch (err) {
      setError(mensajeErrorUsuario(err, "No se pudo registrar."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={cerrar}
      title="Registrar horario"
      description="Planificación informativa: no da ni quita acceso a ningún conjunto. Los días sin bloques quedan como libres."
      className="max-w-2xl"
    >
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Campo label="Guarda" requerido>
            {guardas === undefined ? (
              <p className="text-sm text-muted-foreground">Cargando…</p>
            ) : guardas.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No hay guardas a tu cargo a los que registrar un horario.
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
          <Campo label="Conjunto" ayuda="Opcional. Sin conjunto es un horario general.">
            <Select
              value={condominioId}
              onChange={(e) => setCondominioId(e.target.value as Id<"condominios"> | "")}
            >
              <option value="">General (sin conjunto)</option>
              {conjuntos.map((c) => (
                <option key={c.condominioId} value={c.condominioId}>
                  {c.condominioNombre}
                </option>
              ))}
            </Select>
          </Campo>
          <Campo label="Desde" requerido>
            <Input
              type="date"
              value={fechaInicio}
              onChange={(e) => setFechaInicio(e.target.value)}
              required
            />
          </Campo>
          <Campo label="Hasta" ayuda="Vacío = indefinido. El último día cuenta entero.">
            <Input type="date" value={fechaFin} onChange={(e) => setFechaFin(e.target.value)} />
          </Campo>
        </div>

        {vigentes && vigentes.length > 0 && (
          <div className="rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">Horarios que rigen hoy para este guarda</p>
            <ul className="mt-1 space-y-0.5">
              {vigentes.map((h) => (
                <li key={h._id}>
                  {h.condominioNombre ?? "General"} ·{" "}
                  <ResumenSemanal bloques={h.bloques} compacto />
                </li>
              ))}
            </ul>
          </div>
        )}

        <fieldset className="space-y-2">
          <legend className="text-[13px] font-medium text-foreground">
            Bloques de trabajo <span className="text-destructive">*</span>
          </legend>
          <ul className="divide-y divide-border/60 rounded-lg border border-border">
            {ORDEN_SEMANA.map((dia) => {
              const delDia = bloques.filter((x) => x.dia === dia);
              return (
                <li key={dia} className="space-y-2 px-3 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm text-foreground">{NOMBRES_DIA[dia]}</span>
                    <div className="flex items-center gap-2">
                      {delDia.length === 0 && (
                        <span className="text-xs text-muted-foreground">Libre</span>
                      )}
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={bloques.length >= MAX_BLOQUES}
                        onClick={() => agregar(dia)}
                      >
                        <Plus className="h-3.5 w-3.5" aria-hidden />
                        Bloque
                      </Button>
                    </div>
                  </div>
                  {delDia.map((x) => (
                    <div key={x.key} className="flex flex-wrap items-center gap-2">
                      <Input
                        type="time"
                        aria-label={`${NOMBRES_DIA[dia]}: inicio`}
                        className="w-32"
                        value={x.horaInicio}
                        onChange={(e) => cambiar(x.key, { horaInicio: e.target.value })}
                        required
                      />
                      <span className="text-muted-foreground">→</span>
                      <Input
                        type="time"
                        aria-label={`${NOMBRES_DIA[dia]}: fin`}
                        className="w-32"
                        value={x.horaFin}
                        onChange={(e) => cambiar(x.key, { horaFin: e.target.value })}
                        required
                      />
                      {terminaAlDiaSiguiente(x) && (
                        <span className="text-xs text-muted-foreground">termina al día siguiente</span>
                      )}
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        aria-label="Quitar bloque"
                        onClick={() => quitar(x.key)}
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden />
                      </Button>
                    </div>
                  ))}
                </li>
              );
            })}
          </ul>
        </fieldset>

        {bloques.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-[13px] font-medium text-foreground">Resumen semanal</p>
            <ResumenSemanal bloques={bloques} />
          </div>
        )}

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
