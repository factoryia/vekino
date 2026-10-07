/**
 * La barrera entre las pruebas y la plata de verdad.
 *
 * Todas las credenciales de la pasarela tienen un valor por defecto de QA
 * —los ejemplos del manual— para que el ambiente de pruebas funcione sin
 * configurar nada. Esa comodidad es una trampa el dia del cambio: bastaria
 * con poner AVAL_AMBIENTE=prod y olvidar una variable para que el sistema
 * intentara cobrarle a un residente con la llave de ejemplo del manual, y no
 * habria nada en pantalla que lo delatara.
 *
 * Asi que en produccion se comprueba lo contrario de lo habitual: no que las
 * variables existan, sino que YA NO SEAN las de QA. Si alguna lo es, no sale
 * nada al banco. Un pago que falla se ve y se arregla; un pago que sale con
 * la llave equivocada se descubre cuadrando caja a fin de mes.
 *
 * Vive en lib/ y sin `ctx` para poder probarse sin levantar Convex.
 */

/** Credenciales de EJEMPLO del manual, buenas solo contra QA. */
export const QA_ENDPOINT = "https://qa.psp.ath.com.co";
export const QA_AUTH_BASIC =
  "MzFoMHJlbzJwbTBndmhndjZyOGsycnFnamg6MTc0Y2o0bmp1bjYybXIzYmMxanRmY3Vsb2RsbmFjZmdmNDBvdDVkYzZjaHVvZG9rbDRxcA==";
export const QA_X_AUTHORIZATION =
  "L17Y8lLzv7M=ZnJOZm1OZ1JNUUlJTCtxZGdYNmhQUzh1N3ZwRXFMQlBZZG5VWDVFVXNKakUzQkNMSmpWcVltd0RhUVowZTA0VWZ1UWxyNGpWUTRhaWFDTTRPUEdHUkdiTXZTQWZveWkwNW1qSEJQc2tkOXo2dVNaeTVXOGxYazVxenBHd1FXK2k4ZWl1TGc9PQ==";
export const QA_SECRET_USER = "usuario1";
export const QA_SECRET_PASSWORD = "usuario1951";

/** Lo justo para revisar; el resto de AvalConfig aqui no importa. */
export type ConfigRevisable = {
  endpoint: string;
  authBasic: string;
  /** Nura del convenio; vacio si el condominio no tiene (lib/avalConvenio.ts). */
  agrmId: string;
  xAuthorization: string;
  secretUser: string;
  secretPassword: string;
  ambiente: string;
  insecureTls: boolean;
};

/**
 * Lo que impide pasar a produccion, en lenguaje llano y todo de una vez.
 *
 * Devuelve la lista completa, no el primer problema: avisar de uno por
 * intento convertiria el cambio a produccion en cinco despliegues a ciegas.
 */
export function faltantesParaProduccion(cfg: ConfigRevisable): string[] {
  if (cfg.ambiente !== "prod") return [];
  const faltan: string[] = [];
  if (
    !cfg.endpoint ||
    cfg.endpoint === QA_ENDPOINT ||
    /(^|\/\/)qa[.-]/i.test(cfg.endpoint)
  ) {
    faltan.push("AVAL_ENDPOINT sigue apuntando a QA");
  }
  if (cfg.authBasic === QA_AUTH_BASIC) {
    faltan.push("AVAL_AUTH_BASIC es la del manual de QA");
  }
  /* Las llaves del convenio llevan el Nura de sufijo (lib/avalConvenio.ts):
   * el mensaje nombra la variable exacta que hay que crear. */
  const suf = cfg.agrmId ? `_${cfg.agrmId}` : "_<NURA>";
  if (!cfg.agrmId) {
    faltan.push("el condominio no tiene Nura de Aval: sin el no se sabe a que convenio cobrar");
  }
  if (!cfg.xAuthorization || cfg.xAuthorization === QA_X_AUTHORIZATION) {
    faltan.push(`AVAL_X_AUTHORIZATION${suf} falta o es la de ejemplo del manual`);
  }
  if (
    !cfg.secretUser ||
    !cfg.secretPassword ||
    cfg.secretUser === QA_SECRET_USER ||
    cfg.secretPassword === QA_SECRET_PASSWORD
  ) {
    faltan.push(`AVAL_SECRET_USER${suf} / AVAL_SECRET_PASSWORD${suf} faltan o son las de QA`);
  }
  if (cfg.insecureTls) {
    faltan.push("AVAL_INSECURE_TLS=1: en un canal de pagos el TLS no se relaja");
  }
  return faltan;
}
