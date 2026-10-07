import { test } from "node:test";
import assert from "node:assert/strict";
import {
  credencialesConvenio,
  normalizarNura,
} from "../convex/lib/avalConvenio.ts";
import {
  faltantesParaProduccion,
  QA_X_AUTHORIZATION,
} from "../convex/lib/avalProduccion.ts";

/** Produccion con los dos convenios cargados, cada uno con sus llaves. */
const envProd = {
  AVAL_X_AUTHORIZATION_00030713: "LLAVE_CIUDAD_DEL_CAMPO",
  AVAL_SECRET_USER_00030713: "userCampo",
  AVAL_SECRET_PASSWORD_00030713: "claveCampo",
  AVAL_CHANNEL_00030713: "1",
  AVAL_X_AUTHORIZATION_00030830: "LLAVE_ARBOLEDA",
  AVAL_SECRET_USER_00030830: "userArboleda",
  AVAL_SECRET_PASSWORD_00030830: "claveArboleda",
  AVAL_CHANNEL_00030830: "7",
};

test("el Nura se escribe como lo escriba el banco", () => {
  assert.equal(normalizarNura("30713"), "00030713");
  assert.equal(normalizarNura("00030713"), "00030713");
  assert.equal(normalizarNura(" Nura 30830 "), "00030830");
  assert.equal(normalizarNura(""), null);
  assert.equal(normalizarNura("0000"), null);
  assert.equal(normalizarNura(undefined), null);
});

test("cada convenio cobra con lo suyo", () => {
  const campo = credencialesConvenio(envProd, "30713", "prod");
  const arboleda = credencialesConvenio(envProd, "00030830", "prod");
  assert.deepEqual(campo, {
    agrmId: "00030713",
    xAuthorization: "LLAVE_CIUDAD_DEL_CAMPO",
    secretUser: "userCampo",
    secretPassword: "claveCampo",
    channel: "1",
  });
  assert.equal(arboleda.agrmId, "00030830");
  assert.equal(arboleda.xAuthorization, "LLAVE_ARBOLEDA");
  assert.equal(arboleda.channel, "7");
});

test("en produccion la llave global no se cuela en otro convenio", () => {
  /* Si Arboleda heredara la llave de Ciudad del Campo, la falla seria
   * silenciosa. Tiene que faltar, y la barrera tiene que nombrarla. */
  const env = { ...envProd, AVAL_X_AUTHORIZATION: "LLAVE_GLOBAL" };
  delete (env as Record<string, string>).AVAL_X_AUTHORIZATION_00030830;
  const c = credencialesConvenio(env, "30830", "prod");
  assert.equal(c.xAuthorization, "");
  const faltan = faltantesParaProduccion({
    ...c,
    endpoint: "https://psp.ath.com.co",
    authBasic: "BASIC_PROD",
    ambiente: "prod",
    insecureTls: false,
  });
  assert.deepEqual(faltan, [
    "AVAL_X_AUTHORIZATION_00030830 falta o es la de ejemplo del manual",
  ]);
});

test("en produccion, un conjunto sin Nura no cobra", () => {
  const c = credencialesConvenio({ ...envProd, AVAL_AGRM_ID: "00030713" }, null, "prod");
  assert.equal(c.agrmId, "");
  const faltan = faltantesParaProduccion({
    ...c,
    endpoint: "https://psp.ath.com.co",
    authBasic: "BASIC_PROD",
    ambiente: "prod",
    insecureTls: false,
  });
  assert.match(faltan.join(" "), /no tiene Nura/);
});

test("en QA sigue funcionando sin configurar nada", () => {
  const c = credencialesConvenio({}, null, "qa");
  assert.equal(c.agrmId, "00002336");
  assert.equal(c.xAuthorization, QA_X_AUTHORIZATION);
  assert.equal(c.secretUser, "usuario1");
  assert.equal(c.channel, "1");
});

test("en QA, sin llave propia el convenio usa la global", () => {
  /* Asi esta hoy QA de Ciudad del Campo: AVAL_X_AUTHORIZATION a secas. */
  const c = credencialesConvenio(
    { AVAL_X_AUTHORIZATION: "LLAVE_QA_GLOBAL", AVAL_AGRM_ID: "30713" },
    "30830",
    "qa",
  );
  assert.equal(c.agrmId, "00030830");
  assert.equal(c.xAuthorization, "LLAVE_QA_GLOBAL");
});

test("en QA, sin Nura en el conjunto vale AVAL_AGRM_ID", () => {
  const c = credencialesConvenio({ AVAL_AGRM_ID: "30713" }, null, "qa");
  assert.equal(c.agrmId, "00030713");
});
