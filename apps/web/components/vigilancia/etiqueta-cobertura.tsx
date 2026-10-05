import { ArrowLeftRight } from "lucide-react";
import { etiquetaInstante } from "@vekino/backend/inasistencias";

/**
 * Marca una operación histórica hecha bajo una cobertura temporal.
 *
 * El dato viene del sello de la propia operación (`cobertura`), que el
 * servidor puso al crearla: no del contexto de hoy ni del estado actual de la
 * cobertura. Sin sello no se pinta nada, así que las vistas quedan como antes.
 * `compacta` deja solo la marca y pasa la ventana al título.
 */
export function EtiquetaCobertura({
  cobertura,
  compacta = false,
}: {
  cobertura?: { inicio: number; fin: number } | null;
  compacta?: boolean;
}) {
  if (!cobertura) return null;
  const ventana = `${etiquetaInstante(cobertura.inicio)} → ${etiquetaInstante(cobertura.fin)}`;
  return (
    <span
      title={`Cobertura temporal · ${ventana} (hora de Colombia)`}
      className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-400"
    >
      <ArrowLeftRight className="h-3 w-3" aria-hidden />
      Cobertura temporal
      {!compacta && <span className="font-normal tabular-nums">· {ventana}</span>}
    </span>
  );
}
