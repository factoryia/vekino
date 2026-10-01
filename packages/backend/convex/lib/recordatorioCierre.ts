/**
 * Recordatorio de cierre de turno y de sesión para guardas.
 *
 * Existe porque los guardas terminan el turno y dejan la sesión abierta en el
 * dispositivo de la portería: el siguiente guarda entra, la app le muestra la
 * cuenta del anterior y registra con ella. Esto NO cierra nada —ni turno, ni
 * sesión, ni tokens—: solo decide cuándo toca recordárselo a quien está en
 * sesión y lleva la cuenta de si ya lo confirmó.
 *
 * Vive aquí, sin tocar la base, para que la web y la app móvil decidan con las
 * mismas reglas (igual que `lib/cierreTurno.ts`) y para poder probarlo sin
 * levantar nada. Cada cliente pone solo lo suyo: dónde guarda el registro y
 * qué eventos de su ciclo de vida lo hacen volver a mirar el reloj.
 */

/**
 * Colombia no tiene horario de verano: UTC−5 todo el año. Es el mismo
 * criterio que `model/visitantes.ts:ventanaDiaBogota` aplica con "-05:00".
 *
 * Se calcula con aritmética y no con `Intl` a propósito: así no depende del
 * motor de JavaScript (Hermes en el móvil) ni de la zona horaria que tenga
 * configurada el dispositivo. Solo de que su reloj esté en hora.
 */
const OFFSET_COLOMBIA_MS = -5 * 60 * 60 * 1000;
const MINUTO_MS = 60 * 1000;
const DIA_MS = 24 * 60 * MINUTO_MS;

export type FranjaRecordatorio = "morning" | "evening";

/**
 * Los dos cambios de turno del día, en hora de Colombia y en orden.
 *
 * Diez minutos antes de las 06:00 y de las 18:00: le llega a quien está por
 * entregar la portería, con tiempo de cerrar el turno antes de irse.
 */
export const HORARIOS_RECORDATORIO: readonly {
  franja: FranjaRecordatorio;
  minutoDelDia: number;
}[] = [
  { franja: "morning", minutoDelDia: 5 * 60 + 50 },
  { franja: "evening", minutoDelDia: 17 * 60 + 50 },
];

/**
 * Cuánto dura cada recordatorio desde su horario, en minutos.
 *
 * ÚNICO sitio donde se fija: la web y el móvil lo toman de aquí. El aviso es
 * para el momento del relevo, no para todo el turno: fuera de la ventana no
 * sale aunque nadie lo haya confirmado, y si estaba en pantalla se retira.
 * Tiene que ser menor que el tiempo entre dos horarios (12 h); si no, una
 * ventana pisaría a la siguiente.
 */
export const VENTANA_RECORDATORIO_MINUTOS = 120;

/** Una aparición concreta del recordatorio: un horario de un día. */
export type Franja = {
  /** Día civil en Colombia en que empieza la franja, YYYY-MM-DD. */
  fecha: string;
  franja: FranjaRecordatorio;
  /** Instante (epoch ms) en que se abre su ventana. */
  inicio: number;
  /** Instante (epoch ms) en que se cierra su ventana (excluido). */
  fin: number;
  /** `fecha:franja`. Junto con el usuario identifica el recordatorio. */
  clave: string;
  /** Hora de inicio para mostrar, p. ej. "5:50 p. m.". */
  etiqueta: string;
};

/** Medianoche de Colombia del día de `ts`, desplazada a "hora de pared". */
function inicioDiaLocal(ts: number): number {
  const local = ts + OFFSET_COLOMBIA_MS;
  return Math.floor(local / DIA_MS) * DIA_MS;
}

function construir(
  diaLocal: number,
  h: (typeof HORARIOS_RECORDATORIO)[number],
  ventanaMinutos: number,
): Franja {
  const fecha = new Date(diaLocal).toISOString().slice(0, 10);
  const inicio = diaLocal + h.minutoDelDia * MINUTO_MS - OFFSET_COLOMBIA_MS;
  return {
    fecha,
    franja: h.franja,
    inicio,
    fin: inicio + ventanaMinutos * MINUTO_MS,
    clave: `${fecha}:${h.franja}`,
    etiqueta: horaColombia(inicio),
  };
}

/**
 * Las franjas de ayer, hoy y mañana, en orden. Ayer cuenta porque una
 * ventana de la tarde lo bastante larga cruzaría la medianoche; mañana,
 * porque después de la última de hoy el próximo cambio ya es mañana.
 */
function franjasAlrededor(ahora: number, ventanaMinutos: number): Franja[] {
  const hoy = inicioDiaLocal(ahora);
  return [hoy - DIA_MS, hoy, hoy + DIA_MS].flatMap((dia) =>
    HORARIOS_RECORDATORIO.map((h) => construir(dia, h, ventanaMinutos)),
  );
}

/**
 * La franja cuya ventana está abierta en este instante, o null.
 *
 * Abierta desde su horario (incluido) hasta `fin` (excluido): con 120 min, de
 * 05:50 a 07:50 y de 17:50 a 19:50. A las 05:49 no hay ninguna —no se
 * adelanta— y a las 10:00 o a las 23:00 tampoco. La franja se identifica por
 * el día en que EMPIEZA, así que una ventana que cruzara la medianoche seguiría
 * siendo la de la víspera y no se repetiría por cambiar la fecha.
 */
export function franjaActiva(
  ahora: number,
  ventanaMinutos: number = VENTANA_RECORDATORIO_MINUTOS,
): Franja | null {
  let activa: Franja | null = null;
  for (const f of franjasAlrededor(ahora, ventanaMinutos)) {
    // En orden: si dos se pisaran, gana la más reciente.
    if (f.inicio <= ahora && ahora < f.fin) activa = f;
  }
  return activa;
}

/** Próximo instante (epoch ms, > `ahora`) en que abre o cierra una ventana. */
export function siguienteCambio(
  ahora: number,
  ventanaMinutos: number = VENTANA_RECORDATORIO_MINUTOS,
): number {
  let proximo = Infinity;
  for (const f of franjasAlrededor(ahora, ventanaMinutos)) {
    for (const t of [f.inicio, f.fin]) {
      if (t > ahora && t < proximo) proximo = t;
    }
  }
  return proximo;
}

/**
 * Tope de espera entre dos revisiones con la app abierta.
 *
 * Con un único temporizador hasta el próximo cambio (horas) bastaría en
 * teoría, pero un reloj que se corrige, un equipo que se suspende o un
 * navegador que congela la pestaña lo dejan disparando tarde o nunca. Mirar
 * como mucho cada minuto cuesta nada y lo vuelve inmune a todo eso. También
 * evita el aviso de React Native sobre temporizadores largos en Android.
 */
export const REVISION_MAX_MS = MINUTO_MS;

/**
 * Cuánto esperar hasta volver a evaluar: justo después de que abra o cierre
 * la próxima ventana si llega antes del tope, o el tope. Al cerrarse, el aviso
 * sin confirmar se retira solo. El margen evita despertar unos milisegundos
 * antes de la hora por redondeo del temporizador.
 */
export function msHastaRevision(
  ahora: number,
  ventanaMinutos: number = VENTANA_RECORDATORIO_MINUTOS,
): number {
  const hasta = siguienteCambio(ahora, ventanaMinutos) - ahora;
  return Math.min(REVISION_MAX_MS, hasta + 250);
}

// ─────────────────────────────────────────────────────────────
// Registro local: qué se mostró y qué se confirmó
// ─────────────────────────────────────────────────────────────

/**
 * Lo que se guarda en el dispositivo, uno por usuario.
 *
 * Solo el de la última franja: lo anterior ya no decide nada, y guardar solo
 * uno impide que el almacenamiento crezca con los meses.
 */
export type RegistroRecordatorio = {
  /** `Franja.clave` a la que se refiere. */
  franja: string;
  /** Primera vez que se le mostró esa franja en este dispositivo. */
  mostradoEn: number;
  /**
   * Cuándo marcó "Entendido". Es confirmación de LECTURA: no prueba que haya
   * cerrado el turno ni la sesión, y no debe usarse como si lo hiciera.
   */
  confirmadoEn?: number;
};

/**
 * Clave de almacenamiento. Lleva el usuario para que lo que confirmó un guarda
 * no le apague el recordatorio al siguiente que entre en el mismo equipo.
 */
export function claveRegistro(userId: string): string {
  return `vekino:recordatorio-cierre:${userId}`;
}

/** Lee lo guardado. Cualquier cosa corrupta o ajena cuenta como "nada". */
export function leerRegistro(
  raw: string | null | undefined,
): RegistroRecordatorio | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<RegistroRecordatorio> | null;
    if (!v || typeof v.franja !== "string" || typeof v.mostradoEn !== "number") {
      return null;
    }
    return {
      franja: v.franja,
      mostradoEn: v.mostradoEn,
      confirmadoEn:
        typeof v.confirmadoEn === "number" ? v.confirmadoEn : undefined,
    };
  } catch {
    return null;
  }
}

export type EvaluacionRecordatorio =
  | { mostrar: false }
  | {
      mostrar: true;
      franja: Franja;
      /** Registro con la marca de "mostrado" de esta franja. */
      registro: RegistroRecordatorio;
      /** `true` si es la primera vez que se muestra: hay que guardarlo. */
      nuevo: boolean;
    };

/**
 * Si toca mostrar el recordatorio ahora, dado lo que este usuario tiene
 * guardado en este dispositivo.
 *
 * Toca solo dentro de la ventana de una franja y mientras esa franja no esté
 * confirmada. Mostrarlo no cuenta como confirmarlo: si recarga la página o
 * reabre la app sin pulsar "Entendido", vuelve a salir —dentro de la
 * ventana— y conserva la hora en que salió primero. Fuera de la ventana no se
 * escribe nada.
 */
export function evaluarRecordatorio(
  registro: RegistroRecordatorio | null,
  ahora: number,
  ventanaMinutos: number = VENTANA_RECORDATORIO_MINUTOS,
): EvaluacionRecordatorio {
  const franja = franjaActiva(ahora, ventanaMinutos);
  if (!franja) return { mostrar: false };
  if (registro?.franja === franja.clave) {
    if (registro.confirmadoEn != null) return { mostrar: false };
    return { mostrar: true, franja, registro, nuevo: false };
  }
  return {
    mostrar: true,
    franja,
    registro: { franja: franja.clave, mostradoEn: ahora },
    nuevo: true,
  };
}

/**
 * Registro tras pulsar "Entendido" sobre `franja` (la que se le mostró, que es
 * la que leyó aunque su ventana se haya cerrado un instante antes del clic).
 */
export function confirmarRecordatorio(
  registro: RegistroRecordatorio | null,
  franja: Franja,
  ahora: number,
): RegistroRecordatorio {
  return {
    franja: franja.clave,
    mostradoEn: registro?.franja === franja.clave ? registro.mostradoEn : ahora,
    confirmadoEn: ahora,
  };
}

// ─────────────────────────────────────────────────────────────
// Texto
// ─────────────────────────────────────────────────────────────

/**
 * "José Pérez" → "José". El saludo usa el primer nombre, como los paneles
 * ("Hola, Ana"). Recibe el nombre visible que ya calcula cada cliente.
 */
export function nombreParaSaludo(nombreVisible: string): string {
  return nombreVisible.trim().split(/\s+/)[0] ?? "";
}

/** Hora de Colombia en formato de 12 h: "5:50 a. m.", "12:05 p. m.". */
export function horaColombia(ts: number): string {
  const local = ts + OFFSET_COLOMBIA_MS - inicioDiaLocal(ts);
  const minutos = Math.floor(local / MINUTO_MS);
  const h24 = Math.floor(minutos / 60);
  const mm = String(minutos % 60).padStart(2, "0");
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${mm} ${h24 < 12 ? "a. m." : "p. m."}`;
}
