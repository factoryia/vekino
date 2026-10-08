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

/**
 * Qué le pide el cierre al guarda, campo por campo. `true` = el formulario lo
 * pinta y es obligatorio, en la pantalla y en el servidor; `false` = no se
 * pinta y puede llegar vacío.
 */
export type CamposPedidosCierre = {
  /** La lista de elementos firmados al iniciar y la pregunta de novedades. */
  elementos: boolean;
  /** El guarda que recibe el turno. */
  recibe: boolean;
  consignas: boolean;
  observacionesCierre: boolean;
};

/** El cierre completo, tal como era antes de simplificarlo. */
export const CIERRE_COMPLETO: CamposPedidosCierre = {
  elementos: true,
  recibe: true,
  consignas: true,
  observacionesCierre: true,
};

/**
 * Lo que el cierre pide HOY: nada más que confirmar quién entrega el turno.
 *
 * Se simplificó porque al final de la jornada eran demasiados datos. Los
 * campos se OCULTARON, no se quitaron: siguen en el esquema, en la mutación,
 * en estas reglas y en los dos formularios. Se vuelve a pedir uno cambiando
 * aquí su `false` por `true`.
 *
 * Lo que no se pide pero llega igual —una app móvil sin actualizar sigue
 * mandándolo todo— se valida y se guarda como siempre.
 *
 * Ojo al reactivar: el servidor también empieza a exigirlo, así que las apps
 * móviles ya publicadas que no lo pintan dejarían de poder cerrar. Se
 * reactiva cuando ya esté en la calle una versión que lo muestre.
 */
export const CAMPOS_PEDIDOS_CIERRE: CamposPedidosCierre = {
  elementos: false,
  recibe: false,
  consignas: false,
  observacionesCierre: false,
};

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

/**
 * Lo que se guarda. Un campo que no se pidió y llegó vacío queda `undefined`
 * —ausente en el turno—, no `""` ni `false`: ausente = no se preguntó.
 */
export type CierreTurnoValido = {
  consignas: string | undefined;
  recibe: string | undefined;
  observacionesCierre: string | undefined;
  novedadesElementos: boolean | undefined;
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
 * `pide` es lo que el cierre exige; por defecto, lo de hoy.
 */
export function erroresCierreTurno(
  e: EntradaCierreTurno,
  pide: CamposPedidosCierre = CAMPOS_PEDIDOS_CIERRE,
): Partial<Record<CampoCierreTurno, string>> {
  const errores: Partial<Record<CampoCierreTurno, string>> = {};

  if (e.novedadesElementos == null) {
    if (pide.elementos) {
      errores.novedadesElementos =
        "Indica si hay novedades con los elementos asignados.";
    }
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

  if (pide.recibe && !limpio(e.recibe)) {
    errores.recibe = "Indica el guarda que recibe el turno.";
  }
  if (pide.consignas && !limpio(e.consignas)) {
    errores.consignas = "Escribe las consignas o pendientes para el relevo.";
  }
  if (pide.observacionesCierre && !limpio(e.observacionesCierre)) {
    errores.observacionesCierre =
      "Escribe las observaciones generales del cierre.";
  }
  return errores;
}

/**
 * El cierre normalizado, o un error con el primer problema en el orden del
 * formulario. Es lo que llama el servidor antes de escribir nada.
 */
export function validarCierreTurno(
  e: EntradaCierreTurno,
  pide: CamposPedidosCierre = CAMPOS_PEDIDOS_CIERRE,
): CierreTurnoValido {
  const errores = erroresCierreTurno(e, pide);
  const primero = ORDEN.find((campo) => errores[campo]);
  if (primero) throw new Error(errores[primero]);

  const novedadesElementos =
    e.novedadesElementos == null ? undefined : e.novedadesElementos === true;
  return {
    consignas: limpio(e.consignas) || undefined,
    recibe: limpio(e.recibe) || undefined,
    observacionesCierre: limpio(e.observacionesCierre) || undefined,
    novedadesElementos,
    novedadesElementosDetalle: novedadesElementos
      ? limpio(e.novedadesElementosDetalle)
      : undefined,
  };
}
