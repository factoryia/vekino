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

/** Una aparición concreta del recordatorio: un horario de un día. */
export type Franja = {
  /** Día civil en Colombia en que empieza la franja, YYYY-MM-DD. */
  fecha: string;
  franja: FranjaRecordatorio;
  /** Instante (epoch ms) en que empieza. */
  inicio: number;
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
): Franja {
  const fecha = new Date(diaLocal).toISOString().slice(0, 10);
  const inicio = diaLocal + h.minutoDelDia * MINUTO_MS - OFFSET_COLOMBIA_MS;
  return {
    fecha,
    franja: h.franja,
    inicio,
    clave: `${fecha}:${h.franja}`,
    etiqueta: horaColombia(inicio),
  };
}

/**
 * La franja que rige en este instante: el último horario ya alcanzado.
 *
 * Cada franja dura hasta que empieza la siguiente. Por eso a las 05:49 rige
 * todavía la de la tarde ANTERIOR (no se adelanta la de la mañana), y a la
 * medianoche no pasa nada: la fecha del calendario cambia, la franja no.
 */
export function franjaVigente(ahora: number): Franja {
  const dia = inicioDiaLocal(ahora);
  const transcurrido = ahora + OFFSET_COLOMBIA_MS - dia;
  for (let i = HORARIOS_RECORDATORIO.length - 1; i >= 0; i--) {
    const h = HORARIOS_RECORDATORIO[i]!;
    if (transcurrido >= h.minutoDelDia * MINUTO_MS) return construir(dia, h);
  }
  return construir(
    dia - DIA_MS,
    HORARIOS_RECORDATORIO[HORARIOS_RECORDATORIO.length - 1]!,
  );
}

/** Instante (epoch ms) en que empieza la próxima franja, siempre > `ahora`. */
export function inicioSiguienteFranja(ahora: number): number {
  const hoy = inicioDiaLocal(ahora);
  for (const dia of [hoy, hoy + DIA_MS]) {
    for (const h of HORARIOS_RECORDATORIO) {
      const inicio = dia + h.minutoDelDia * MINUTO_MS - OFFSET_COLOMBIA_MS;
      if (inicio > ahora) return inicio;
    }
  }
  // Inalcanzable: mañana siempre tiene un horario posterior a hoy.
  return hoy + 2 * DIA_MS - OFFSET_COLOMBIA_MS;
}

/**
 * Tope de espera entre dos revisiones con la app abierta.
 *
 * Con un único temporizador hasta el próximo horario (hasta 12 h) bastaría en
 * teoría, pero un reloj que se corrige, un equipo que se suspende o un
 * navegador que congela la pestaña lo dejan disparando tarde o nunca. Mirar
 * como mucho cada minuto cuesta nada y lo vuelve inmune a todo eso. También
 * evita el aviso de React Native sobre temporizadores largos en Android.
 */
export const REVISION_MAX_MS = MINUTO_MS;

/**
 * Cuánto esperar hasta volver a evaluar: justo después del próximo horario
 * si llega antes del tope, o el tope. El margen evita despertar unos
 * milisegundos antes de la hora por redondeo del temporizador.
 */
export function msHastaRevision(ahora: number): number {
  const hasta = inicioSiguienteFranja(ahora) - ahora;
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
  | { mostrar: false; franja: Franja }
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
 * Toca mientras la franja vigente no esté confirmada. Mostrarlo no cuenta
 * como confirmarlo: si recarga la página o reabre la app sin pulsar
 * "Entendido", vuelve a salir — y conserva la hora en que salió primero.
 */
export function evaluarRecordatorio(
  registro: RegistroRecordatorio | null,
  ahora: number,
): EvaluacionRecordatorio {
  const franja = franjaVigente(ahora);
  if (registro?.franja === franja.clave) {
    if (registro.confirmadoEn != null) return { mostrar: false, franja };
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
 * la que leyó aunque justo acabe de empezar otra).
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
