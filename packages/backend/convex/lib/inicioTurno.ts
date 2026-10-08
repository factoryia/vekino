/**
 * Lo que el inicio de turno le pide al guarda.
 *
 * Aparte de la mutación por lo mismo que `lib/cierreTurno.ts`: el servidor y
 * los dos formularios (web y móvil) tienen que decidir EXACTAMENTE lo mismo.
 * Si la pantalla oculta un campo que el servidor sigue usando, lo que se
 * guarda depende de qué versión de la app tenga cada guarda.
 *
 * Lo que NO decide esto: el checklist de dotación ni el compañero de turno.
 * Esos se piden siempre y se validan en `iniciarTurno`, como antes.
 */

/**
 * Qué le pide el inicio al guarda, campo por campo. `true` = el formulario lo
 * pinta tal como era antes de simplificarlo (el nombre, obligatorio; las
 * observaciones, opcionales); `false` = no se pinta.
 */
export type CamposPedidosInicio = {
  /**
   * "Quién toma el turno", escrito a mano. Venía de la portería con una sola
   * cuenta compartida, donde la sesión no decía qué persona estaba de turno.
   */
  guardiaNombre: boolean;
  /** Las observaciones iniciales: cómo se recibe la portería. */
  observacionesInicio: boolean;
};

/** El inicio completo, tal como era antes de simplificarlo. */
export const INICIO_COMPLETO: CamposPedidosInicio = {
  guardiaNombre: true,
  observacionesInicio: true,
};

/**
 * Lo que el inicio pide HOY: el checklist de dotación y, si lo hay, el
 * compañero. Nada más.
 *
 * Los campos se OCULTARON, no se quitaron: siguen en el esquema, en la
 * mutación, en estas reglas y en los dos formularios. Se vuelve a pedir uno
 * cambiando aquí su `false` por `true`.
 *
 * Las observaciones que llegan igual —una app móvil sin actualizar sigue
 * mandándolas— se guardan como siempre. El nombre escrito a mano, no: ver
 * `nombreDeQuienInicia`.
 */
export const CAMPOS_PEDIDOS_INICIO: CamposPedidosInicio = {
  guardiaNombre: false,
  observacionesInicio: false,
};

/**
 * El nombre con el que queda el turno, en el turno y en la minuta.
 *
 * Mientras el nombre no se pide, sale SOLO de la sesión: el turno ya cuelga
 * del usuario autenticado (`guardiaUserId`) y su nombre no puede contar otra
 * persona. Por eso se descarta el que llegue escrito —una app sin actualizar
 * todavía lo pide— en vez de guardarlo.
 *
 * Si se vuelve a pedir (cuenta compartida), manda el escrito y la sesión
 * queda de respaldo, que es como funcionaba antes.
 */
export function nombreDeQuienInicia(
  escrito: string | null | undefined,
  deLaSesion: string,
  pide: CamposPedidosInicio = CAMPOS_PEDIDOS_INICIO,
): string {
  if (!pide.guardiaNombre) return deLaSesion;
  return escrito?.trim() || deLaSesion;
}
