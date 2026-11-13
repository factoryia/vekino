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
  /* El SecretList solo tiene que estar puesto a mano, no ser distinto del
   * manual: en produccion credencialesConvenio ya no cae a ningun valor por
   * defecto. El usuario y la clave del manual SON los de produccion: el
   * 13-nov-2026 prd.psp.ath.com.co acepto con ellos una Trn del 00030713. */
  if (!cfg.secretUser || !cfg.secretPassword) {
    faltan.push(`AVAL_SECRET_USER${suf} / AVAL_SECRET_PASSWORD${suf} faltan`);
  }
  if (cfg.insecureTls) {
    faltan.push("AVAL_INSECURE_TLS=1: en un canal de pagos el TLS no se relaja");
  }
  return faltan;
}

/** Los dos ambientes de la pasarela. */
export type AmbienteAval = "qa" | "prod";

/**
 * El ambiente de la pasarela, que tiene que estar declarado (Fase 3 de la
 * auditoría de facturación, F-21).
 *
 * Antes, sin `AVAL_AMBIENTE` se asumía "qa". En un deployment de producción
 * al que se le olvidara la variable, los pagos reales quedaban marcados como
 * de prueba —y `pagosPruebas.revertirTodos` borra los de prueba y le quita el
 * "pagada" a sus facturas—. Ahora la variable es obligatoria y solo admite
 * "qa" o "prod": sin ella no sale nada al banco ni se toca un pago.
 */
export function ambienteAval(env: Record<string, string | undefined>): AmbienteAval {
  const valor = env.AVAL_AMBIENTE?.trim();
  if (valor === "qa" || valor === "prod") return valor;
  throw new Error(
    valor
      ? `AVAL_AMBIENTE debe ser "qa" o "prod" (es "${valor.slice(0, 20)}"). No se envía nada al banco.`
      : 'Falta AVAL_AMBIENTE ("qa" o "prod") en el deployment. No se envía nada al banco.',
  );
}

/**
 * Las unidades de prueba declaradas para la pasarela en QA (Fase 4).
 *
 * `AVAL_UNIDADES_PRUEBA`: ids de `unidades` separados por comas, espacios o
 * saltos de linea. Ids y no numeros de casa: "999" puede existir en otro
 * conjunto, y un id no se confunde. Sin la variable, ninguna.
 */
export function unidadesDePruebaAval(env: Record<string, string | undefined>): Set<string> {
  return new Set(
    (env.AVAL_UNIDADES_PRUEBA ?? "")
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * Si la pasarela puede cobrarle a esta unidad (Fase 4).
 *
 * Con `AVAL_AMBIENTE=qa` la pasarela es la de pruebas del banco: no mueve
 * plata. Ofrecerle "Pagar en linea" a una casa real era hacerle creer que
 * pago —el deployment que usan los residentes esta en `qa` (Fase 1, §9.6)—.
 * En `qa` solo se opera sobre las unidades declaradas de prueba
 * (`AVAL_UNIDADES_PRUEBA`); sin la lista, sobre ninguna.
 *
 * Con `prod`, todas, como en la Fase 3. Sin `AVAL_AMBIENTE` no se decide
 * aqui: la pasarela ya se niega a crear o consultar transacciones
 * (`ambienteAval`).
 */
export function pasarelaPermitida(
  env: Record<string, string | undefined>,
  unidadId: string,
): boolean {
  if (env.AVAL_AMBIENTE?.trim() !== "qa") return true;
  return unidadesDePruebaAval(env).has(unidadId);
}

/** Lo que se le responde a una unidad real mientras la pasarela esta en QA. Estable. */
export const MENSAJE_PASARELA_DE_PRUEBAS =
  "El pago en línea todavía no está habilitado: la pasarela está en modo de pruebas. Paga por los canales habituales del conjunto y, si quieres, envía el comprobante.";
