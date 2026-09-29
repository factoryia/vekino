import type { Doc } from "../_generated/dataModel";

export type EstadoIncidente = Doc<"incidentes">["estado"];

/** Solo las transiciones acordadas. CERRADO no tiene salida. */
const SIGUIENTES: Record<EstadoIncidente, readonly EstadoIncidente[]> = {
  REPORTADO: ["EN_INVESTIGACION"],
  EN_INVESTIGACION: ["EN_SEGUIMIENTO"],
  EN_SEGUIMIENTO: ["EN_INVESTIGACION", "RESUELTO"],
  RESUELTO: ["EN_SEGUIMIENTO", "CERRADO"],
  CERRADO: [],
};

export function validarTransicion(
  anterior: EstadoIncidente,
  siguiente: EstadoIncidente,
  motivo?: string,
  resolucion?: string,
): void {
  if (!SIGUIENTES[anterior].includes(siguiente)) {
    throw new Error(`Transición de incidente no permitida: ${anterior} → ${siguiente}.`);
  }
  if (
    (anterior === "EN_SEGUIMIENTO" && siguiente === "EN_INVESTIGACION") ||
    (anterior === "RESUELTO" && siguiente === "EN_SEGUIMIENTO")
  ) {
    if (!motivo?.trim()) throw new Error("El retroceso requiere un motivo.");
  }
  if (siguiente === "RESUELTO" && !resolucion?.trim()) {
    throw new Error("La resolución requiere una observación.");
  }
}

export function textoRequerido(value: string, nombre: string, max: number): string {
  const limpio = value.trim();
  if (!limpio || limpio.length > max) {
    throw new Error(`${nombre} debe tener entre 1 y ${max} caracteres.`);
  }
  return limpio;
}

export function textoOpcional(value: string | undefined, nombre: string, max: number): string | undefined {
  if (value == null) return undefined;
  return textoRequerido(value, nombre, max);
}
