/**
 * Las cuentas del horario permanente de un guarda: bloques, vigencia, estado
 * y choques.
 *
 * Aparte del módulo porque no tocan la base: la web arma el formulario con
 * las mismas reglas que la mutación, y se prueban sin levantar nada.
 *
 * El horario es PLANIFICACIÓN: dice dónde y cuándo debería estar trabajando
 * un guarda según lo registrado. No autoriza ni desautoriza nada, y que no
 * haya horario significa "no tenemos esa información", nunca "está libre".
 *
 * No se inventa nada nuevo para las horas:
 *   - el patrón semanal tiene la forma de `zonasComunes.horariosPorDia`
 *     ({ dia: 0=domingo … 6=sábado, horaInicio, horaFin }, "HH:MM");
 *   - el cruce de medianoche y el solape salen de `lib/horarios.ts`;
 *   - la vigencia y su estado, de `lib/vigilancia.ts`, como contratos y
 *     asignaciones;
 *   - las fechas civiles, en hora de Colombia como las inasistencias.
 */
import { aMinutos, rango, rangoAbsoluto, seSolapan } from "./horarios.ts";
import { DIA, diaColombia, limiteDiaColombia } from "./incidenteMetricas.ts";
import { estadoVigencia, type Rango } from "./vigilancia.ts";

/** Un bloque de trabajo de un día de la semana. Sin fechas: eso es la vigencia. */
export type BloqueSemanal = { dia: number; horaInicio: string; horaFin: string };

/** 0 = domingo, como en `zonasComunes.horariosPorDia`. */
export const NOMBRES_DIA = [
  "Domingo",
  "Lunes",
  "Martes",
  "Miércoles",
  "Jueves",
  "Viernes",
  "Sábado",
] as const;

/** El orden en que se lee una semana de trabajo: lunes primero. */
export const ORDEN_SEMANA = [1, 2, 3, 4, 5, 6, 0] as const;

/** Tres bloques por día dan para cualquier turno partido real. */
export const MAX_BLOQUES = 21;

const MINUTOS_DIA = 24 * 60;

function horaNormalizada(hora: string): string | null {
  const m = aMinutos(hora);
  /* `aMinutos` acepta hasta 24:59 por cómo se escriben las zonas comunes; un
   * bloque de trabajo no: las 24:00 se escriben 00:00 y `rango` ya entiende
   * que caen al día siguiente. */
  if (m == null || m >= MINUTOS_DIA) return null;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** ¿Termina al día siguiente? */
export function terminaAlDiaSiguiente(b: BloqueSemanal): boolean {
  const r = rango(b.horaInicio, b.horaFin);
  return r != null && r.fin > MINUTOS_DIA;
}

/** Día de la semana de una fecha civil, 0 = domingo. */
export function diaDeLaSemana(fecha: string): number {
  return new Date(`${fecha}T00:00:00Z`).getUTCDay();
}

function sumarDias(fecha: string, dias: number): string {
  return diaColombia(limiteDiaColombia(fecha) + dias * DIA);
}

/**
 * Los bloques de un horario puestos en fechas concretas, en minutos absolutos.
 *
 * Cada bloque pertenece al día en que EMPIEZA —el turno de 18:00 a 06:00 del
 * jueves es del jueves—, igual que una reserva que termina pasada la
 * medianoche se guarda con la fecha en que empieza.
 */
function instancias(
  bloques: readonly BloqueSemanal[],
  fechas: readonly string[],
): { inicio: number; fin: number; clave: string }[] {
  const salida: { inicio: number; fin: number; clave: string }[] = [];
  for (const fecha of fechas) {
    const dia = diaDeLaSemana(fecha);
    bloques.forEach((b, i) => {
      if (b.dia !== dia) return;
      const r = rangoAbsoluto(fecha, b.horaInicio, b.horaFin);
      if (r) salida.push({ ...r, clave: `${fecha}#${i}` });
    });
  }
  return salida;
}

/**
 * Valida y ordena un patrón semanal. Lanza con el primer problema.
 *
 * Los días sin bloques son días libres: no se registran como nada. Dentro de
 * un mismo horario dos bloques no pueden pisarse, contando los que cruzan la
 * medianoche hacia el día siguiente.
 */
export function validarBloques(bloques: readonly BloqueSemanal[]): BloqueSemanal[] {
  if (bloques.length === 0) {
    throw new Error("Agrega al menos un bloque de trabajo. Los días sin bloques son los libres.");
  }
  if (bloques.length > MAX_BLOQUES) {
    throw new Error(`Un horario admite hasta ${MAX_BLOQUES} bloques.`);
  }
  const limpios = bloques.map((b) => {
    if (!Number.isInteger(b.dia) || b.dia < 0 || b.dia > 6) {
      throw new Error("Día de la semana inválido.");
    }
    const horaInicio = horaNormalizada(b.horaInicio);
    const horaFin = horaNormalizada(b.horaFin);
    if (horaInicio == null || horaFin == null) {
      throw new Error("Formato de hora inválido (usa HH:MM).");
    }
    return { dia: b.dia, horaInicio, horaFin };
  });
  limpios.sort((a, b) => a.dia - b.dia || a.horaInicio.localeCompare(b.horaInicio));

  /* Ocho días seguidos cubren cualquier pareja de bloques: el patrón se
   * repite cada semana y un bloque se alarga como mucho al día siguiente. */
  const semana = Array.from({ length: 8 }, (_, i) => sumarDias("2026-01-04", i));
  const xs = instancias(limpios, semana);
  for (let i = 0; i < xs.length; i++) {
    for (let j = i + 1; j < xs.length; j++) {
      if (seSolapan(xs[i]!, xs[j]!)) {
        throw new Error("Dos bloques del horario se pisan. Revisa los que cruzan la medianoche.");
      }
    }
  }
  return limpios;
}

/** Valida la vigencia en fechas civiles. Sin `fechaFin` es indefinida. */
export function validarVigencia(fechaInicio: string, fechaFin?: string): void {
  limiteDiaColombia(fechaInicio);
  if (fechaFin != null) {
    limiteDiaColombia(fechaFin);
    if (fechaFin < fechaInicio) {
      throw new Error("La fecha final no puede ser anterior a la inicial.");
    }
  }
}

/** Lo que hace falta de un horario para saber cuándo rige. */
export type VigenciaHorario = {
  fechaInicio: string;
  fechaFin?: string | null;
  /** Último día tras finalizarlo, si se finalizó. */
  terminaEl?: string | null;
};

/**
 * El último día en que rige, o undefined si es indefinido.
 *
 * Manda el que llegue primero: finalizar no alarga lo planificado, y la fecha
 * planificada no resucita lo ya finalizado.
 */
export function ultimoDiaEfectivo(h: VigenciaHorario): string | undefined {
  const fin = h.fechaFin ?? undefined;
  const corte = h.terminaEl ?? undefined;
  if (fin == null) return corte;
  if (corte == null) return fin;
  return corte < fin ? corte : fin;
}

/**
 * La vigencia como `Rango` de `lib/vigilancia`, para usar sus mismas cuentas.
 *
 * `vigenciaHasta` es el inicio del último día y `finDe` le suma el día entero:
 * exactamente "el último día cuenta completo".
 */
export function rangoDeVigencia(h: VigenciaHorario): Rango {
  const ultimo = ultimoDiaEfectivo(h);
  return {
    vigenciaDesde: limiteDiaColombia(h.fechaInicio),
    vigenciaHasta: ultimo == null ? undefined : limiteDiaColombia(ultimo),
  };
}

export type EstadoHorario = "programado" | "vigente" | "terminado";

/** Derivado de las fechas, no guardado: igual que un contrato. */
export function estadoHorario(h: VigenciaHorario, ahora: number = Date.now()): EstadoHorario {
  /* Finalizado antes de empezar: no va a regir nunca, así que está terminado
   * aunque su fecha de inicio todavía no haya llegado. */
  const ultimo = ultimoDiaEfectivo(h);
  if (ultimo != null && ultimo < h.fechaInicio) return "terminado";
  const e = estadoVigencia(rangoDeVigencia(h), ahora);
  return e === "programada" ? "programado" : e === "vigente" ? "vigente" : "terminado";
}

/** ¿Rige en esta fecha civil? */
export function rigeEl(h: VigenciaHorario, fecha: string): boolean {
  const ultimo = ultimoDiaEfectivo(h);
  return h.fechaInicio <= fecha && (ultimo == null || fecha <= ultimo);
}

/** ¿Su vigencia se cruza con el rango de fechas civiles [desde, hasta]? */
export function cruzaRango(h: VigenciaHorario, desde: string, hasta: string): boolean {
  const ultimo = ultimoDiaEfectivo(h);
  return h.fechaInicio <= hasta && (ultimo == null || ultimo >= desde);
}

/**
 * Si dos horarios planifican al guarda en el mismo momento.
 *
 * Se miran fechas reales, no solo la semana tipo: si las vigencias se cruzan
 * un solo jueves, un bloque de lunes no choca con nada. Se recorre el cruce
 * —más el día anterior, por los bloques que pasan la medianoche— con un tope
 * de ocho días, que es cuando el patrón ya se ha repetido entero.
 */
export function chocanHorarios(
  a: VigenciaHorario & { bloques: readonly BloqueSemanal[] },
  b: VigenciaHorario & { bloques: readonly BloqueSemanal[] },
): boolean {
  const desde = a.fechaInicio > b.fechaInicio ? a.fechaInicio : b.fechaInicio;
  const finA = ultimoDiaEfectivo(a);
  const finB = ultimoDiaEfectivo(b);
  const hasta =
    finA == null ? finB : finB == null ? finA : finA < finB ? finA : finB;
  if (hasta != null && hasta < desde) return false;

  const tope = sumarDias(desde, 7);
  const ultimo = hasta == null || hasta > tope ? tope : hasta;
  const fechas: string[] = [];
  for (let f = sumarDias(desde, -1); f <= ultimo; f = sumarDias(f, 1)) fechas.push(f);

  const deA = instancias(a.bloques, fechas.filter((f) => rigeEl(a, f)));
  const deB = instancias(b.bloques, fechas.filter((f) => rigeEl(b, f)));
  return deA.some((x) => deB.some((y) => seSolapan(x, y)));
}

/**
 * Valida el último día al finalizar.
 *
 * No puede ser anterior a ayer: lo planificado para días que ya pasaron es
 * historia y no se reescribe. Tampoco puede alargar lo planificado.
 */
export function validarUltimoDia(
  h: VigenciaHorario,
  ultimoDia: string,
  hoy: string,
): void {
  limiteDiaColombia(ultimoDia);
  if (ultimoDia < sumarDias(hoy, -1)) {
    throw new Error("No se puede finalizar con una fecha anterior a ayer: lo ya planificado no se reescribe.");
  }
  const actual = ultimoDiaEfectivo(h);
  if (actual != null && ultimoDia > actual) {
    throw new Error("Finalizar no puede alargar el horario.");
  }
}

/** La semana tal como se lee, lunes primero; los días sin bloques, libres. */
export function resumenSemanal(
  bloques: readonly BloqueSemanal[],
): { dia: number; nombre: string; bloques: string[] }[] {
  return ORDEN_SEMANA.map((dia) => ({
    dia,
    nombre: NOMBRES_DIA[dia]!,
    bloques: bloques
      .filter((b) => b.dia === dia)
      .map(
        (b) =>
          `${b.horaInicio}–${b.horaFin}${terminaAlDiaSiguiente(b) ? " (+1)" : ""}`,
      ),
  }));
}

/** "2026-10-08" → "08/10/2026". */
export function fechaCorta(fecha: string): string {
  const [a, m, d] = fecha.split("-");
  return `${d}/${m}/${a}`;
}

/** La vigencia como se lee. */
export function etiquetaVigencia(h: VigenciaHorario): string {
  const ultimo = ultimoDiaEfectivo(h);
  return ultimo == null
    ? `Desde ${fechaCorta(h.fechaInicio)} (indefinido)`
    : `${fechaCorta(h.fechaInicio)} → ${fechaCorta(ultimo)}`;
}
