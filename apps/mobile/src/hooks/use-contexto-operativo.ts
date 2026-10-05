import { useEffect, useState, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { useQuery } from "convex/react";
import { api } from "@vekino/backend/api";

/**
 * EL RELOJ DE LA COBERTURA, DEL LADO DEL MÓVIL.
 *
 * El mismo principio que la web (`apps/web/hooks/use-contexto-operativo.ts`):
 * Convex vuelve a ejecutar una consulta cuando cambian los datos que leyó, no
 * cuando pasa el tiempo, y una cobertura empieza y termina sin que nadie
 * escriba nada. El servidor dice CUÁNDO cambia la respuesta
 * (`contextoOperativoGuardia.refrescarEn`); aquí solo se programa un
 * temporizador que, llegado ese instante, cambia un número (`refresco`) que
 * las consultas del contexto reciben como argumento. Un argumento distinto es
 * una consulta nueva, y Convex la ejecuta con SU reloj.
 *
 * El cliente nunca decide si la cobertura está activa: solo cuándo volver a
 * preguntar. Y aunque no preguntara, cada consulta y cada mutación de la
 * portería lo vuelve a resolver en el servidor.
 *
 * Lo propio del móvil: con la app en segundo plano los temporizadores no
 * corren. Al volver al frente, si el límite ya pasó, se pregunta enseguida.
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

/**
 * Vuelve a pedir el contexto operativo. Lo usa el temporizador, la vuelta
 * del segundo plano y quien recibe del servidor un "aquí ya no operas": así
 * la respuesta nueva llega sin esperar al siguiente límite.
 */
export function refrescarContextoOperativo() {
  const ahora = Date.now();
  /* Dos avisos casi a la vez (dos pantallas, temporizador y vuelta al frente)
   * cuentan como uno: todas las consultas comparten argumento y suscripción. */
  if (ahora - ultimoAvance < 1_000) return;
  ultimoAvance = ahora;
  refresco = ahora;
  oyentes.forEach((oyente) => oyente());
}

/** Llegar un poco DESPUÉS del límite, nunca antes. */
const MARGEN = 1_000;
/* Si el reloj del teléfono va adelantado, el límite ya "pasó" aquí y en el
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
    const t = setTimeout(refrescarContextoOperativo, espera);
    return () => clearTimeout(t);
    /* `actual` está a propósito: si el servidor devuelve el mismo límite
     * después de un refresco (relojes desfasados), hay que volver a armarlo. */
  }, [refrescarEn, actual]);

  useEffect(() => {
    if (refrescarEn == null) return;
    const sub = AppState.addEventListener("change", (estado) => {
      if (estado === "active" && Date.now() >= refrescarEn) refrescarContextoOperativo();
    });
    return () => sub.remove();
  }, [refrescarEn]);
}

/**
 * El último valor que llegó, mientras la consulta con el argumento nuevo
 * carga. Sin esto, cada refresco pasaba un instante por `undefined` y el
 * proveedor de sesión volvía a "cargando": la app entera se desmontaba, con
 * lo que el guarda estuviera escribiendo.
 */
export function useConservado<T>(valor: T | undefined): T | undefined {
  const [guardado, setGuardado] = useState<{ valor: T } | null>(null);
  if (valor !== undefined && guardado?.valor !== valor) {
    setGuardado({ valor });
  }
  return valor !== undefined ? valor : guardado?.valor;
}

/**
 * La sesión (`users.meOperativo`) con el contexto operativo al día: se vuelve
 * a pedir en el instante en que una cobertura empieza o termina, al volver la
 * app al frente con el límite pasado, o cuando alguien lo pide.
 */
export function useMeOperativo() {
  const refresco = useRefrescoOperativo();
  const me = useConservado(
    useQuery(api.users.meOperativo, refresco ? { refresco } : {}),
  );
  useProgramarRefresco(me?.contextoOperativoGuardia.refrescarEn);
  return me;
}
