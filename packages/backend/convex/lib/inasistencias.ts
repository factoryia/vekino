/**
 * Las cuentas de las inasistencias: tipos, motivo, ventana y solape.
 *
 * Aparte del módulo porque no tocan la base, igual que `lib/cierreTurno.ts`:
 * la web valida el formulario con las mismas reglas que la mutación, y se
 * pueden probar sin levantar nada.
 *
 * Una inasistencia dice "durante esta ventana este guarda no está disponible
 * para planificar, y por qué". Es información de planificación: no autoriza
 * ni desautoriza nada.
 */
import { DIA, diaColombia, limiteDiaColombia } from "./incidenteMetricas.ts";
import { seSolapan } from "./horarios.ts";

/**
 * Conjunto cerrado. El día libre NO está a propósito: es planificación
 * normal y pertenece al horario, no a una ausencia registrada.
 */
export const TIPOS_INASISTENCIA = [
  "inasistencia",
  "incapacidad",
  "vacaciones",
  "permiso",
  "otro",
] as const;

export type TipoInasistencia = (typeof TIPOS_INASISTENCIA)[number];

export const ETIQUETA_TIPO_INASISTENCIA: Record<TipoInasistencia, string> = {
  inasistencia: "Inasistencia",
  incapacidad: "Incapacidad",
  vacaciones: "Vacaciones",
  permiso: "Permiso",
  otro: "Otro",
};

/**
 * Tipos que no dicen por sí solos qué pasó: sin motivo, "inasistencia" u
 * "otro" no le sirven a quien lo lea después. En los demás el tipo ya es la
 * explicación y el motivo es un añadido.
 */
export const TIPOS_CON_MOTIVO_OBLIGATORIO: readonly TipoInasistencia[] = [
  "inasistencia",
  "otro",
];

export const MAX_MOTIVO = 500;

export function exigeMotivo(tipo: TipoInasistencia): boolean {
  return TIPOS_CON_MOTIVO_OBLIGATORIO.includes(tipo);
}

/** El motivo limpio, o undefined. Lanza si falta donde es obligatorio. */
export function validarMotivo(
  tipo: TipoInasistencia,
  motivo: string | undefined,
): string | undefined {
  const limpio = motivo?.trim() ?? "";
  if (limpio.length > MAX_MOTIVO) {
    throw new Error(`El motivo admite hasta ${MAX_MOTIVO} caracteres.`);
  }
  if (!limpio) {
    if (exigeMotivo(tipo)) {
      throw new Error("Describe qué ocurrió: para este tipo el motivo es obligatorio.");
    }
    return undefined;
  }
  return limpio;
}

/**
 * Lo que llega del formulario.
 *
 * Fechas y horas viajan como TEXTO de pared ("2026-10-08", "2026-10-08T18:00")
 * y no como milisegundos calculados en el navegador: así la zona horaria del
 * equipo de quien registra no decide nada. Las interpreta el servidor en hora
 * de Colombia, la misma convención de reservas, visitantes y métricas.
 */
export type EntradaVentana =
  | { diaCompleto: true; fechaInicio: string; fechaFin: string }
  | { diaCompleto: false; inicioLocal: string; finLocal: string };

/**
 * La ventana resuelta.
 *
 * `inicio`/`fin` son instantes exactos en las dos modalidades —`fin` excluido—,
 * para que las consultas y el solape no distingan casos. En la de días
 * completos se guarda además la fecha civil tal como se pidió (`fechaFin`
 * incluida): es lo que hay que mostrar, y no tiene que reconstruirse
 * deshaciendo cuentas de zona horaria.
 */
export type Ventana = {
  inicio: number;
  fin: number;
  diaCompleto: boolean;
  fechaInicio?: string;
  fechaFin?: string;
};

const MINUTO = 60_000;
const OFFSET_COLOMBIA = 5 * 60 * MINUTO;

/** "2026-10-08T18:00" en hora de Colombia → instante. Lanza si no es válida. */
export function instanteColombia(valor: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(valor)) {
    throw new Error("La fecha y hora no son válidas.");
  }
  const ms = Date.parse(`${valor}:00-05:00`);
  /* Ida y vuelta: rechaza el 30 de febrero o las 24:00, que `Date.parse`
   * puede aceptar corriéndolos al día siguiente. */
  if (!Number.isFinite(ms) || textoLocalColombia(ms) !== valor) {
    throw new Error("La fecha y hora no son válidas.");
  }
  return ms;
}

/** Instante → "2026-10-08T18:00" en hora de Colombia. */
export function textoLocalColombia(ms: number): string {
  return new Date(ms - OFFSET_COLOMBIA).toISOString().slice(0, 16);
}

export function ventanaInasistencia(e: EntradaVentana): Ventana {
  if (e.diaCompleto) {
    const inicio = limiteDiaColombia(e.fechaInicio);
    const ultimoDia = limiteDiaColombia(e.fechaFin);
    if (ultimoDia < inicio) {
      throw new Error("La fecha final no puede ser anterior a la inicial.");
    }
    return {
      inicio,
      /* El último día cuenta entero: termina donde empieza el siguiente. */
      fin: ultimoDia + DIA,
      diaCompleto: true,
      fechaInicio: e.fechaInicio,
      fechaFin: e.fechaFin,
    };
  }
  const inicio = instanteColombia(e.inicioLocal);
  const fin = instanteColombia(e.finLocal);
  if (inicio >= fin) {
    throw new Error("El fin debe ser posterior al inicio.");
  }
  return { inicio, fin, diaCompleto: false };
}

/**
 * Si la nueva ventana pisa alguna de las existentes.
 *
 * Intervalos con el fin excluido: una inasistencia que termina a las 06:00 y
 * otra que empieza a las 06:00 no se pisan, son seguidas.
 */
export function pisaAlguna(
  nueva: { inicio: number; fin: number },
  existentes: readonly { inicio: number; fin: number }[],
): boolean {
  return existentes.some((e) => seSolapan(nueva, e));
}

/** Rango de consulta en fechas civiles, ambas incluidas → instantes. */
export function rangoDeConsulta(desde: string, hasta: string): { desde: number; hasta: number } {
  const ini = limiteDiaColombia(desde);
  const fin = limiteDiaColombia(hasta) + DIA;
  if (fin <= ini) throw new Error("La fecha final no puede ser anterior a la inicial.");
  if (fin - ini > 366 * DIA) throw new Error("Selecciona un periodo de hasta 366 días.");
  return { desde: ini, hasta: fin };
}

/** "2026-10-08" → "08/10/2026". */
function fechaCorta(fecha: string): string {
  const [a, m, d] = fecha.split("-");
  return `${d}/${m}/${a}`;
}

/** Un instante como "08/10/2026 18:00", en hora de Colombia. */
export function etiquetaInstante(ms: number): string {
  const [fecha, hora] = textoLocalColombia(ms).split("T");
  return `${fechaCorta(fecha!)} ${hora}`;
}

/**
 * La ventana como se lee, siempre en hora de Colombia y no en la del
 * navegador: la web y el móvil la muestran igual vengan de donde vengan.
 */
export function etiquetaVentana(v: Ventana): string {
  if (v.diaCompleto && v.fechaInicio && v.fechaFin) {
    return v.fechaInicio === v.fechaFin
      ? `${fechaCorta(v.fechaInicio)} (día completo)`
      : `${fechaCorta(v.fechaInicio)} → ${fechaCorta(v.fechaFin)} (días completos)`;
  }
  return `${etiquetaInstante(v.inicio)} → ${etiquetaInstante(v.fin)}`;
}

/** Hoy en Colombia, "2026-10-08". */
export function hoyColombia(ahora: number = Date.now()): string {
  return diaColombia(ahora);
}

/** Suma días a una fecha civil. */
export function sumarDias(fecha: string, dias: number): string {
  return diaColombia(limiteDiaColombia(fecha) + dias * DIA);
}
