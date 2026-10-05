"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { useQuery } from "convex/react";
import { api } from "@vekino/backend/api";

/**
 * EL RELOJ DE LA COBERTURA, DEL LADO DEL CLIENTE.
 *
 * Convex vuelve a ejecutar una consulta cuando cambian los datos que leyó, no
 * cuando pasa el tiempo. Una cobertura empieza y termina sin que nadie escriba
 * nada, así que `users.me` y `guardia.home` seguirían respondiendo lo de antes
 * hasta que otra cosa las despertara: el guarda seguiría viendo la portería de
 * su conjunto de siempre aunque ya le tocara la otra.
 *
 * El servidor dice CUÁNDO cambia la respuesta
 * (`contextoOperativoGuardia.refrescarEn`). Aquí solo se programa un
 * temporizador para ese instante, que cambia un número (`refresco`) que esas
 * consultas (`users.meOperativo`, `guardia.home`,
 * `guardia.turnoPendienteDeCierre`) reciben como argumento. Un argumento distinto es una consulta
 * nueva, y Convex la ejecuta con SU reloj. El cliente nunca decide si la
 * cobertura está activa: solo cuándo volver a preguntar. Y aunque no
 * preguntara, cada consulta y cada mutación de la portería lo vuelve a
 * resolver en el servidor.
 */

let refresco = 0;
let ultimoAvance = 0;
const oyentes = new Set<() => void>();

function suscribir(oyente: () => void) {
  oyentes.add(oyente);
  return () => {
    oyentes.delete(oyente);
  };
}

function leer() {
  return refresco;
}

/* Un solo número para toda la página: si dos componentes tienen el mismo
 * límite, los dos temporizadores disparan casi a la vez y con esto cuentan
 * como uno, y todas las consultas comparten argumento (y suscripción). */
function avanzar() {
  const ahora = Date.now();
  if (ahora - ultimoAvance < 1_000) return;
  ultimoAvance = ahora;
  refresco = ahora;
  oyentes.forEach((oyente) => oyente());
}

/** Llegar un poco DESPUÉS del límite, nunca antes. */
const MARGEN = 1_000;
/* Si el reloj de este equipo va adelantado, el límite ya "pasó" aquí y en el
 * servidor todavía no: se vuelve a preguntar cada tanto, sin martillar. */
const REINTENTO = 15_000;
/** El tope de `setTimeout`; una cobertura puede empezar en más de 24 días. */
const MAX_ESPERA = 2_147_483_647;

/**
 * El número que se pasa como `refresco`. 0 mientras no haya pasado ningún
 * límite: así las consultas comparten suscripción con las que no lo pasan.
 */
export function useRefrescoOperativo(): number {
  return useSyncExternalStore(suscribir, leer, () => 0);
}

/** Programa el próximo refresco para el instante que dio el servidor. */
export function useProgramarRefresco(refrescarEn: number | null | undefined) {
  const actual = useRefrescoOperativo();
  useEffect(() => {
    if (refrescarEn == null) return;
    const falta = refrescarEn - Date.now();
    const espera = falta > 0 ? Math.min(falta + MARGEN, MAX_ESPERA) : REINTENTO;
    const t = setTimeout(avanzar, espera);
    return () => clearTimeout(t);
    /* `actual` está a propósito: si el servidor devuelve el mismo límite
     * después de un refresco (relojes desfasados), hay que volver a armarlo. */
  }, [refrescarEn, actual]);
}

/**
 * El último valor que llegó, mientras la consulta con el argumento nuevo
 * carga. Sin esto, cada refresco pasaba un instante por `undefined`: el shell
 * pintaba el spinner y desmontaba la página, con lo que se estuviera
 * escribiendo. `clave` separa lo que no se debe mezclar (otro conjunto).
 */
export function useConservado<T>(valor: T | undefined, clave = ""): T | undefined {
  const [guardado, setGuardado] = useState<{ clave: string; valor: T } | null>(null);
  if (valor !== undefined && (guardado?.valor !== valor || guardado.clave !== clave)) {
    setGuardado({ clave, valor });
  }
  if (valor !== undefined) return valor;
  return guardado?.clave === clave ? guardado.valor : undefined;
}

/**
 * La sesión (`users.me`) con el contexto operativo al día: se vuelve a pedir
 * en el instante en que una cobertura empieza o termina. Es la misma
 * respuesta que `users.me`, por `users.meOperativo`, que acepta `refresco`.
 */
export function useMeOperativo() {
  const refresco = useRefrescoOperativo();
  const me = useConservado(useQuery(api.users.meOperativo, refresco ? { refresco } : {}));
  useProgramarRefresco(me?.contextoOperativoGuardia.refrescarEn);
  return me;
}
