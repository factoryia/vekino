/**
 * La disponibilidad de un guarda para una ventana: calculada, nunca guardada.
 *
 * Responde "¿qué sabemos hoy sobre si este guarda puede cubrir COMPLETA esta
 * ventana?" con lo que ya está registrado —horarios e inasistencias— y nada
 * más: las asignaciones, los contratos y los turnos no participan. No es una
 * regla de autorización: no bloquea ni habilita nada.
 *
 * Función pura: recibe los datos ya cargados, no toca Convex, no sabe quién
 * pregunta y siempre da lo mismo para lo mismo. Se prueba con `node:test`.
 *
 * Nada de fechas propio: la ventana es la de las inasistencias (hora de
 * Colombia, [inicio, fin)), y los bloques en fechas concretas y su solape
 * salen de `lib/horariosGuarda.ts` y `lib/horarios.ts`.
 */
import { seSolapan } from "./horarios.ts";
import {
  bloquesQueCruzan,
  fechasDeVentana,
  rigeEl,
  type BloqueSemanal,
  type VigenciaHorario,
} from "./horariosGuarda.ts";
import { DIA } from "./incidenteMetricas.ts";
import {
  ventanaInasistencia,
  type EntradaVentana,
  type TipoInasistencia,
} from "./inasistencias.ts";

/**
 * De más a menos fuerte: la inasistencia manda sobre el horario, el horario
 * sobre la ausencia de choque, y "no sabemos" es lo que queda.
 */
export const ESTADOS_DISPONIBILIDAD = [
  "no_disponible",
  "ocupado",
  "disponible",
  "desconocido",
] as const;
export type EstadoDisponibilidad = (typeof ESTADOS_DISPONIBILIDAD)[number];

export const ETIQUETA_DISPONIBILIDAD: Record<EstadoDisponibilidad, string> = {
  disponible: "Disponible",
  ocupado: "Ocupado",
  no_disponible: "No disponible",
  desconocido: "Sin información",
};

/** Una cobertura puede durar unas vacaciones; un mes es el tope razonable. */
export const MAX_DIAS_VENTANA = 31;

/** La ventana a consultar, con la misma entrada y la misma zona que las inasistencias. */
export function ventanaDeConsulta(e: EntradaVentana): { inicio: number; fin: number } {
  const { inicio, fin } = ventanaInasistencia(e);
  if (fin - inicio > MAX_DIAS_VENTANA * DIA) {
    throw new Error(`Consulta una ventana de hasta ${MAX_DIAS_VENTANA} días.`);
  }
  return { inicio, fin };
}

/** Lo que hace falta de un horario. `condominioId` null = horario general. */
export type HorarioEvaluable = VigenciaHorario & {
  id: string;
  condominioId: string | null;
  bloques: readonly BloqueSemanal[];
};

/** Lo que hace falta de una inasistencia. El motivo escrito NO entra aquí. */
export type InasistenciaEvaluable = {
  id: string;
  tipo: TipoInasistencia;
  inicio: number;
  fin: number;
  estado: "activa" | "anulada";
};

/**
 * Por qué sale lo que sale.
 *
 * La inasistencia lleva solo su categoría —el tipo—, nunca el motivo escrito:
 * en una lista de candidatos no tiene por qué viajar lo que alguien anotó
 * sobre una incapacidad.
 */
export type MotivoDisponibilidad =
  | {
      tipo: "inasistencia";
      inasistenciaId: string;
      categoria: TipoInasistencia;
      inicio: number;
      fin: number;
    }
  | {
      tipo: "horario";
      horarioId: string;
      condominioId: string | null;
      fecha: string;
      horaInicio: string;
      horaFin: string;
      inicio: number;
      fin: number;
    }
  | {
      /** Días que toca la ventana sin ningún horario que rija. */
      tipo: "sin_horario";
      fechas: string[];
    };

export type Disponibilidad = {
  estado: EstadoDisponibilidad;
  motivos: MotivoDisponibilidad[];
};

/**
 * Evalúa la ventana COMPLETA: basta que una parte choque para no poder
 * cubrirla, porque una cobertura necesita a alguien para todo el turno.
 *
 *   - `no_disponible`: alguna inasistencia activa se cruza con la ventana;
 *   - `ocupado`: algún bloque de algún horario —de cualquier conjunto o
 *     general— se cruza con ella. Conservador: no hay jerarquía entre el
 *     general y el de conjunto, cualquiera ocupa;
 *   - `disponible`: todos los días que toca la ventana tienen algún horario
 *     que rige y ninguno la ocupa. Un día sin bloques dentro de un horario
 *     vigente es libre SEGÚN LA PLANIFICACIÓN;
 *   - `desconocido`: algún día de la ventana no tiene ningún horario que
 *     rija. Sin horario no se sabe, y no saber no es estar libre.
 *
 * Los horarios y las inasistencias se juzgan en las fechas de la ventana, no
 * por su estado de hoy: así se pueden evaluar fechas pasadas y futuras.
 */
export function evaluarDisponibilidadGuarda(entrada: {
  ventana: { inicio: number; fin: number };
  horarios: readonly HorarioEvaluable[];
  inasistencias: readonly InasistenciaEvaluable[];
}): Disponibilidad {
  const { ventana, horarios, inasistencias } = entrada;

  const porInasistencia: MotivoDisponibilidad[] = inasistencias
    .filter((i) => i.estado === "activa" && seSolapan(i, ventana))
    .sort((a, b) => a.inicio - b.inicio)
    .map((i) => ({
      tipo: "inasistencia",
      inasistenciaId: i.id,
      categoria: i.tipo,
      inicio: i.inicio,
      fin: i.fin,
    }));

  const porHorario: MotivoDisponibilidad[] = horarios
    .flatMap((h) =>
      bloquesQueCruzan(h, ventana).map((x) => ({
        tipo: "horario" as const,
        horarioId: h.id,
        condominioId: h.condominioId,
        fecha: x.fecha,
        horaInicio: x.bloque.horaInicio,
        horaFin: x.bloque.horaFin,
        inicio: x.inicio,
        fin: x.fin,
      })),
    )
    .sort((a, b) => a.inicio - b.inicio);

  /* La inasistencia manda, pero los choques de horario se siguen contando:
   * quien lo mire sabe además que estaba planificado. */
  if (porInasistencia.length > 0) {
    return { estado: "no_disponible", motivos: [...porInasistencia, ...porHorario] };
  }
  if (porHorario.length > 0) {
    return { estado: "ocupado", motivos: porHorario };
  }

  const sinPlanificacion = fechasDeVentana(ventana).filter(
    (fecha) => !horarios.some((h) => rigeEl(h, fecha)),
  );
  if (sinPlanificacion.length > 0) {
    return {
      estado: "desconocido",
      motivos: [{ tipo: "sin_horario", fechas: sinPlanificacion }],
    };
  }
  return { estado: "disponible", motivos: [] };
}

/** Para ordenar una lista de guardas: primero quien puede cubrir. */
export const ORDEN_PARA_CUBRIR: Record<EstadoDisponibilidad, number> = {
  disponible: 0,
  desconocido: 1,
  ocupado: 2,
  no_disponible: 3,
};
