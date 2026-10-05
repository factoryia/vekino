import { etiquetaVentana } from "@vekino/backend/inasistencias";

/**
 * La ventana de una fila tal como llega de `inasistencias.*`, para pintarla.
 *
 * El servidor manda `null` donde la lib espera `undefined`; aquí se traduce y
 * el texto sale de `etiquetaVentana`, en hora de Colombia.
 */
export function ventanaDe(i: {
  inicio: number;
  fin: number;
  diaCompleto: boolean;
  fechaInicio: string | null;
  fechaFin: string | null;
}): string {
  return etiquetaVentana({
    inicio: i.inicio,
    fin: i.fin,
    diaCompleto: i.diaCompleto,
    fechaInicio: i.fechaInicio ?? undefined,
    fechaFin: i.fechaFin ?? undefined,
  });
}
