/**
 * Las reglas del ciclo de vida de una cobertura temporal, sin base de datos.
 *
 * Una cobertura es "este guarda aceptó cubrir temporalmente el conjunto B
 * durante esta ventana". Es un registro propio, no una asignación: la
 * pertenencia permanente del guarda no se toca.
 *
 *   solicitada ─┬─ aceptada ─┬─ cancelada     (antes de empezar)
 *               │            └─ inhabilitada  (corte manual, con motivo)
 *               ├─ rechazada
 *               └─ cancelada
 *
 * Nada vuelve atrás: una rechazada no se acepta, una inhabilitada no se
 * rehabilita. Si hace falta otra vez, se crea otra cobertura.
 *
 * "Activa" NO es un estado guardado: se deriva (aceptada y ahora dentro de la
 * ventana). Aceptada tampoco es acceso: el acceso lo da la cobertura activa
 * que además pasa su cadena (contrato, compañía, guarda y conjunto), y eso se
 * resuelve en `model/cobertura.ts`, al leer.
 */

export const ESTADOS_COBERTURA = [
  "solicitada",
  "aceptada",
  "rechazada",
  "cancelada",
  "inhabilitada",
] as const;
export type EstadoCobertura = (typeof ESTADOS_COBERTURA)[number];

/** Lo que se lee en pantalla. "Activa" no está a propósito: se deriva. */
export const ETIQUETA_ESTADO_COBERTURA: Record<EstadoCobertura, string> = {
  solicitada: "Pendiente",
  aceptada: "Aceptada",
  rechazada: "Rechazada",
  cancelada: "Cancelada",
  inhabilitada: "Inhabilitada",
};

export const MAX_MOTIVO_INHABILITACION = 500;

/** Lo que hace falta de una cobertura para aplicarle las reglas. */
export type CoberturaParaReglas = {
  estado: EstadoCobertura;
  inicio: number;
  fin: number;
  inhabilitadaEn?: number | null;
};

/** Qué hacer con una petición de transición. */
export type Decision =
  | { tipo: "permitido" }
  /** Ya estaba en el estado pedido: no se reescribe nada. */
  | { tipo: "yaEstaba" }
  | { tipo: "error"; mensaje: string };

const permitido: Decision = { tipo: "permitido" };
const yaEstaba: Decision = { tipo: "yaEstaba" };
const error = (mensaje: string): Decision => ({ tipo: "error", mensaje });

/**
 * Una cobertura nueva no empieza en el pasado. Sin tolerancia: el proyecto no
 * tiene una y no se inventa aquí.
 */
export function exigirInicioFuturo(inicio: number, ahora: number): void {
  if (inicio < ahora) {
    throw new Error("La cobertura no puede empezar en el pasado.");
  }
}

/**
 * Aceptar o rechazar: solo una solicitud pendiente. Aceptar, además, solo si
 * todavía no empezó: aceptar tarde un turno que ya corre no tiene sentido.
 */
export function decidirRespuesta(
  c: CoberturaParaReglas,
  respuesta: "aceptada" | "rechazada",
  ahora: number,
): Decision {
  if (c.estado !== "solicitada") {
    return error(
      `Esta solicitud ya no está pendiente: está ${ETIQUETA_ESTADO_COBERTURA[c.estado].toLowerCase()}.`,
    );
  }
  if (respuesta === "aceptada" && c.inicio <= ahora) {
    return error("La cobertura ya empezó: no se puede aceptar.");
  }
  return permitido;
}

/**
 * Cancelar: una solicitud pendiente, o una aceptada que todavía no empezó.
 * Lo que ya empezó no se cancela: se inhabilita, que es un corte con motivo.
 */
export function decidirCancelacion(c: CoberturaParaReglas, ahora: number): Decision {
  switch (c.estado) {
    case "cancelada":
      return yaEstaba;
    case "solicitada":
      return permitido;
    case "aceptada":
      return c.inicio > ahora
        ? permitido
        : error("La cobertura ya empezó: para cortarla, inhabilítala.");
    case "rechazada":
      return error("Una solicitud rechazada no se cancela.");
    case "inhabilitada":
      return error("Una cobertura inhabilitada no se cancela.");
  }
}

/** Inhabilitar: solo una aceptada que todavía no terminó. */
export function decidirInhabilitacion(c: CoberturaParaReglas, ahora: number): Decision {
  if (c.estado === "inhabilitada") return yaEstaba;
  if (c.estado !== "aceptada") return error("Solo se inhabilita una cobertura aceptada.");
  if (c.fin <= ahora) return error("La cobertura ya terminó: no hay nada que inhabilitar.");
  return permitido;
}

export function validarMotivoInhabilitacion(motivo: string): string {
  const limpio = motivo.trim();
  if (!limpio) throw new Error("Indica el motivo de la inhabilitación.");
  if (limpio.length > MAX_MOTIVO_INHABILITACION) {
    throw new Error(`El motivo admite hasta ${MAX_MOTIVO_INHABILITACION} caracteres.`);
  }
  return limpio;
}

/**
 * La ventana durante la cual una cobertura ocupa al guarda, o null.
 *
 * Una aceptada lo ocupa entera. Una inhabilitada lo ocupó hasta el corte: lo
 * que ya pasó pasó, y evaluar una fecha anterior tiene que saberlo. Una
 * solicitud pendiente, rechazada o cancelada no ocupa nada.
 */
export function ventanaQueOcupa(
  c: CoberturaParaReglas,
): { inicio: number; fin: number } | null {
  if (c.estado === "aceptada") return { inicio: c.inicio, fin: c.fin };
  if (c.estado === "inhabilitada" && c.inhabilitadaEn != null) {
    const fin = Math.min(c.fin, c.inhabilitadaEn);
    return fin > c.inicio ? { inicio: c.inicio, fin } : null;
  }
  return null;
}

/**
 * Activa: aceptada y ahora dentro de [inicio, fin). Derivada, nunca guardada.
 * Una inhabilitada o cancelada no está activa aunque su ventana diga otra cosa.
 */
export function estaActiva(c: CoberturaParaReglas, ahora: number): boolean {
  return c.estado === "aceptada" && c.inicio <= ahora && ahora < c.fin;
}

/**
 * El próximo instante en que el contexto operativo de un guarda cambia solo,
 * por el paso del tiempo, o null si no hay ninguno a la vista.
 *
 * Es el `inicio` de la próxima aceptada que aún no empezó, o el `fin` de la
 * que está corriendo. Lo que cambia por una escritura —inhabilitar, cancelar,
 * terminar un contrato— no hace falta anunciarlo: Convex vuelve a ejecutar la
 * consulta por su cuenta. El paso del tiempo no, y por eso existe esto.
 *
 * No decide nada: le dice al cliente cuándo volver a PREGUNTAR. La respuesta
 * sigue saliendo del servidor con su propio reloj.
 */
export function proximoCambioDeContexto(
  coberturas: readonly CoberturaParaReglas[],
  ahora: number,
): number | null {
  let proximo: number | null = null;
  for (const c of coberturas) {
    if (c.estado !== "aceptada" || c.fin <= ahora) continue;
    const limite = c.inicio > ahora ? c.inicio : c.fin;
    if (proximo === null || limite < proximo) proximo = limite;
  }
  return proximo;
}
