/**
 * Las llaves de cada convenio.
 *
 * La pasarela tiene dos clases de credenciales. Unas son de Vekino ante Aval
 * —endpoint y Authorization Basic del oauth2— y valen para todos. Las otras
 * son del convenio: el Nura (AgrmId), la llave X-Authorization, el usuario y
 * la clave del SecretList y el canal. Cada conjunto tiene su convenio y su
 * cuenta: Ciudad del Campo es el 00030713, Arboleda el 00030830.
 *
 * Mientras hubo un solo convenio, todo vivia en variables globales. Con dos,
 * eso obliga a escoger cual de los dos conjuntos cobra; o peor, a que el
 * segundo cobre con el Nura del primero y la plata de Arboleda caiga en la
 * cuenta de Ciudad del Campo.
 *
 * Asi que el Nura lo guarda el condominio (no es secreto: sale en los
 * archivos de recaudo) y las llaves van en variables de entorno con el Nura
 * de sufijo:
 *
 *   AVAL_X_AUTHORIZATION_00030830
 *   AVAL_SECRET_USER_00030830 / AVAL_SECRET_PASSWORD_00030830
 *   AVAL_CHANNEL_00030830
 *
 * En QA, si falta la del sufijo, se usa la global y luego el ejemplo del
 * manual: el ambiente de pruebas debe seguir funcionando sin configurar nada.
 * En produccion NO hay respaldo. Una llave global serviria para un solo
 * convenio y se colaria en los demas sin que nadie lo note; vale mas que
 * falte y la barrera de avalProduccion.ts lo diga.
 *
 * Vive en lib/ y sin `ctx` para poder probarse sin levantar Convex.
 */

import {
  QA_SECRET_PASSWORD,
  QA_SECRET_USER,
  QA_X_AUTHORIZATION,
} from "./avalProduccion.ts";

export type CredencialesConvenio = {
  /** Nura a 8 digitos, o "" si en produccion el condominio no tiene. */
  agrmId: string;
  xAuthorization: string;
  secretUser: string;
  secretPassword: string;
  channel: string;
};

type Env = Record<string, string | undefined>;

/** Nura del manual de QA, para cuando nadie configuro uno. */
const QA_AGRM_ID = "00002336";

/**
 * "30713" · "00030713" · " 30713 " → "00030713". `null` si no hay digitos.
 *
 * El banco lo escribe de las dos formas ("Nura 30713" en el asunto,
 * "00030713" en el manual). Normalizado, la variable de entorno se llama
 * igual la escriba quien la escriba.
 */
export function normalizarNura(nura?: string | null): string | null {
  const d = (nura ?? "").replace(/\D/g, "");
  if (!d || Number(d) === 0) return null;
  return d.padStart(8, "0");
}

/** Nombre de la variable para un convenio: "AVAL_X_AUTHORIZATION_00030830". */
export function variableDeConvenio(base: string, nura: string): string {
  return `${base}_${nura}`;
}

export function credencialesConvenio(
  env: Env,
  nura: string | null | undefined,
  ambiente: string,
): CredencialesConvenio {
  const n = normalizarNura(nura);
  const prod = ambiente === "prod";

  const leer = (base: string, qa: string): string => {
    const propia = n ? env[variableDeConvenio(base, n)] : undefined;
    if (propia) return propia;
    if (prod) return "";
    return env[base] || qa;
  };

  return {
    agrmId: n ?? (prod ? "" : normalizarNura(env.AVAL_AGRM_ID) ?? QA_AGRM_ID),
    xAuthorization: leer("AVAL_X_AUTHORIZATION", QA_X_AUTHORIZATION),
    secretUser: leer("AVAL_SECRET_USER", QA_SECRET_USER),
    secretPassword: leer("AVAL_SECRET_PASSWORD", QA_SECRET_PASSWORD),
    /* El manual dice "valor constante: 16" y NO lo es: el canal se asigna
     * por convenio. Ciudad del Campo usa 1 (comprobado contra QA: con 16 la
     * pasarela responde 105). El canal no es secreto, asi que en produccion
     * si se acepta el global como respaldo; pero de cada convenio nuevo hay
     * que preguntarle al banco el suyo. */
    channel:
      (n ? env[variableDeConvenio("AVAL_CHANNEL", n)] : undefined) ||
      env.AVAL_CHANNEL ||
      "1",
  };
}
