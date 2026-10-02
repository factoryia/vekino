/**
 * Las reglas del cierre de turno del guarda.
 *
 * Aparte de la mutación porque no tocan la base, igual que `lib/ronda.ts` y
 * `lib/inventario.ts`, y porque tienen que dar EXACTAMENTE el mismo resultado
 * en el servidor y en los dos formularios (web y móvil): si la pantalla deja
 * pasar algo que el servidor rechaza, el guarda se entera al final de un turno
 * de doce horas, que es el peor momento.
 *
 * Lo que NO decide esto: si el relevo elegido es de verdad un guarda de la
 * portería. Eso necesita la base y vive en `cerrarTurno`; aquí solo llega el
 * nombre ya resuelto.
 */

export type EntradaCierreTurno = {
  consignas: string | null | undefined;
  /** Nombre de quien recibe (del catálogo de guardas o escrito a mano). */
  recibe: string | null | undefined;
  observacionesCierre: string | null | undefined;
  /** `undefined` = el formulario no contestó la pregunta. No es un "no". */
  novedadesElementos: boolean | null | undefined;
  novedadesElementosDetalle: string | null | undefined;
  /** Cuántos elementos quedaron en el checklist al iniciar el turno. */
  elementosAsignados: number;
};

export type CierreTurnoValido = {
  consignas: string;
  recibe: string;
  /** Opcional: vacío o solo espacios no se guarda. */
  observacionesCierre: string | undefined;
  novedadesElementos: boolean;
  /** Solo cuando hay novedades: sin ellas no se guarda un texto que nadie pidió. */
  novedadesElementosDetalle: string | undefined;
};

export type CampoCierreTurno =
  | "consignas"
  | "recibe"
  | "novedadesElementos"
  | "novedadesElementosDetalle"
  | "observacionesCierre";

/** El orden del formulario: el primer error que se ve es el primero que se lee. */
const ORDEN: CampoCierreTurno[] = [
  "novedadesElementos",
  "novedadesElementosDetalle",
  "recibe",
  "consignas",
  "observacionesCierre",
];

/** Recortado, o `""` si no quedó nada: un texto de solo espacios no es un texto. */
function limpio(bruto: string | null | undefined): string {
  return bruto?.trim() ?? "";
}

/**
 * Los errores campo por campo. Vacío = el cierre es válido.
 *
 * Lo usan los formularios para pintar cada mensaje debajo de su campo.
 */
export function erroresCierreTurno(
  e: EntradaCierreTurno,
): Partial<Record<CampoCierreTurno, string>> {
  const errores: Partial<Record<CampoCierreTurno, string>> = {};

  if (e.novedadesElementos == null) {
    errores.novedadesElementos =
      "Indica si hay novedades con los elementos asignados.";
  } else if (e.novedadesElementos) {
    /* Reportar novedades de elementos que el turno no tuvo no describe nada:
     * para lo demás están las observaciones generales. */
    if (e.elementosAsignados <= 0) {
      errores.novedadesElementos =
        "Este turno no tiene elementos asignados sobre los que reportar novedades.";
    } else if (!limpio(e.novedadesElementosDetalle)) {
      errores.novedadesElementosDetalle =
        "Describe la novedad de los elementos asignados.";
    }
  }

  if (!limpio(e.recibe)) {
    errores.recibe = "Indica el guarda que recibe el turno.";
  }
  if (!limpio(e.consignas)) {
    errores.consignas = "Escribe las consignas o pendientes para el relevo.";
  }
  return errores;
}

/**
 * El cierre normalizado, o un error con el primer problema en el orden del
 * formulario. Es lo que llama el servidor antes de escribir nada.
 */
export function validarCierreTurno(e: EntradaCierreTurno): CierreTurnoValido {
  const errores = erroresCierreTurno(e);
  const primero = ORDEN.find((campo) => errores[campo]);
  if (primero) throw new Error(errores[primero]);

  const novedadesElementos = e.novedadesElementos === true;
  const observacionesCierre = limpio(e.observacionesCierre);
  return {
    consignas: limpio(e.consignas),
    recibe: limpio(e.recibe),
    observacionesCierre: observacionesCierre || undefined,
    novedadesElementos,
    novedadesElementosDetalle: novedadesElementos
      ? limpio(e.novedadesElementosDetalle)
      : undefined,
  };
}
