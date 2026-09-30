"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { mensajeErrorGestion } from "@/lib/incidentes-bandeja";

/** No limpia formularios rechazados; evita envíos simultáneos. */
export function useOperacion(mensajeError: (error: unknown) => string = mensajeErrorGestion) {
  const bloqueo = useRef(false);
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState("");
  const [exito, setExito] = useState("");
  async function ejecutar(accion: () => Promise<unknown>, mensaje: string, limpiar?: () => void) {
    if (bloqueo.current) return;
    bloqueo.current = true; setOcupado(true); setError(""); setExito("");
    try { await accion(); limpiar?.(); setExito(mensaje); }
    catch (e) { setError(mensajeError(e)); }
    finally { bloqueo.current = false; setOcupado(false); }
  }
  return { ocupado, ejecutar, aviso: <>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}{exito && <p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">{exito}</p>}</> };
}

export function Campo({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block min-w-0 space-y-1 text-xs font-medium"><span>{label}</span>{children}</label>;
}

export function RetirarElemento({ nombre, retirar }: { nombre: string; retirar: (motivo: string) => Promise<unknown> }) {
  const operacion = useOperacion((e) => /motivo/i.test(String(e)) ? "Escribe el motivo del retiro (máximo 2000 caracteres)." : mensajeErrorGestion(e));
  return <details className="mt-3"><summary className="cursor-pointer text-xs font-medium text-destructive">Retirar {nombre}</summary>
    <form className="mt-3 space-y-3" onSubmit={(e) => {
      e.preventDefault(); const form = e.currentTarget;
      const motivo = String(new FormData(form).get("motivo")).trim();
      void operacion.ejecutar(() => retirar(motivo), "Retiro registrado en el historial.", () => form.reset());
    }}>
      <p className="text-xs text-muted-foreground">El retiro conserva el registro y su historial.</p>
      {operacion.aviso}<fieldset disabled={operacion.ocupado} className="space-y-3">
        <Campo label="Motivo del retiro"><Textarea name="motivo" required maxLength={2000} /></Campo>
        <Button type="submit" variant="outline">{operacion.ocupado ? "Retirando…" : "Confirmar retiro"}</Button>
      </fieldset>
    </form>
  </details>;
}
