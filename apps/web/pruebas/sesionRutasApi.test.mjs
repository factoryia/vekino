import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Window } from "happy-dom";

/**
 * LA SESIÓN LLEGA A LAS RUTAS API DE NEXT Y LA RUTA LA VALIDA (integración).
 *
 * La web guarda la sesión en localStorage (`crossDomainClient`), no en una
 * cookie del dominio. Las rutas `/api/facturas/upload`, `/api/facturas/confirmar`
 * y `/api/incidentes/reporte` respondían 401/403 a quien había iniciado
 * sesión, porque el navegador no les mandaba nada. `fetchConSesion` les manda
 * la sesión en `Better-Auth-Cookie`.
 *
 * REAL aquí:
 *   · el cliente de Better Auth de la web (`lib/auth-client.ts`) y su login;
 *   · `fetchConSesion`, `descargarReporteIncidentes` y las tres rutas;
 *   · `lib/auth-server.ts` (`convexBetterAuthNextJs`), que reenvía las
 *     cabeceras de la petición a `/api/auth/convex/token`;
 *   · un servidor de Better Auth con los plugins del backend (`crossDomain` y
 *     `convex`, como packages/backend/convex/auth.ts): valida la sesión y
 *     firma el JWT de Convex.
 *
 * SIMULADO:
 *   · Convex: un servidor HTTP que verifica el JWT como Convex (firma con el
 *     JWKS del auth, issuer y audience "convex") y responde las funciones de
 *     estas rutas con un rol por persona. La lógica real de esos roles la
 *     prueban, en el backend, `pruebas/facturacion/cargaPorConjunto.test.ts` y
 *     `pruebas/incidentesFase7.test.ts`.
 *   · S3 (en memoria) y `next/headers` (devuelve las cabeceras de la petición
 *     en curso, como Next en una ruta).
 *
 * Todo en 127.0.0.1: nada sale a la red. Proceso propio (`test:sesion`).
 */

const WEB = "http://localhost:3000";
const ventana = new Window({ url: `${WEB}/condominio/condo-1/finanzas` });
for (const clave of ["window", "document", "navigator", "localStorage"]) {
  Object.defineProperty(globalThis, clave, { configurable: true, value: clave === "window" ? ventana : ventana[clave] });
}

// ── Servidores locales ──────────────────────────────────────────────────
const escuchar = (servidor) =>
  new Promise((listo) => servidor.listen(0, "127.0.0.1", () => listo(`http://127.0.0.1:${servidor.address().port}`)));
const leerCuerpo = (req) =>
  new Promise((listo, falla) => {
    const partes = [];
    req.on("data", (c) => partes.push(c));
    req.on("end", () => listo(Buffer.concat(partes)));
    req.on("error", falla);
  });

let auth;
/** Peticiones al auth: solo si traían sesión y qué respondió, nunca valores. */
let alAuth = [];
const servidorAuth = createServer(async (req, res) => {
  const cuerpo = req.method === "GET" ? undefined : await leerCuerpo(req);
  const r = await auth.handler(
    new Request(`${AUTH}${req.url}`, {
      method: req.method,
      headers: Object.entries(req.headers).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]])),
      body: cuerpo?.length ? cuerpo : undefined,
    }),
  );
  const texto = Buffer.from(await r.arrayBuffer());
  const ruta = req.url.split("?")[0];
  alAuth.push({
    ruta,
    status: r.status,
    betterAuthCookie: !!req.headers["better-auth-cookie"],
    cookie: !!req.headers.cookie,
    ...(ruta.endsWith("/convex/token") ? { token: !!JSON.parse(texto.toString() || "null")?.token } : {}),
  });
  const salida = {};
  r.headers.forEach((v, k) => {
    if (!["set-cookie", "content-length", "content-encoding"].includes(k)) salida[k] = v;
  });
  if (r.headers.getSetCookie().length) salida["set-cookie"] = r.headers.getSetCookie();
  res.writeHead(r.status, salida);
  res.end(texto);
});

/** Rol de cada persona en el Convex simulado (por id de usuario de Better Auth). */
const ROLES = new Map();
/** Llamadas a Convex: función e identidad que verificó el JWT. */
let aConvex = [];
let convexFalla = false;
let JWKS;
const jose = await import("jose");
async function identidadDe(authorization) {
  if (!authorization?.startsWith("Bearer ")) return null;
  try {
    const { payload } = await jose.jwtVerify(authorization.slice(7), JWKS, { issuer: AUTH, audience: "convex" });
    return payload.sub ?? null;
  } catch {
    return null;
  }
}
const SIN_SESION = "No autenticado o perfil inexistente.";
function responder(funcion, args, quien) {
  const rol = (quien && ROLES.get(quien)) || {};
  const ok = (value) => ({ status: "success", value });
  const error = (errorMessage) => ({ status: "error", errorMessage });
  const exigirCarga = () => (!quien ? error(SIN_SESION) : !rol.carga ? error("No tiene el rol requerido en este condominio.") : null);
  switch (funcion) {
    case "facturas:destinoCarga":
      if (!quien) return ok({ allowed: false, motivo: "sin_sesion" });
      if (!rol.carga) return ok({ allowed: false, motivo: "sin_permiso" });
      return ok({ allowed: true, condominioId: args.condominioId, carpeta: args.condominioId });
    case "facturas:iniciarImportacion":
      return (
        exigirCarga() ??
        ok({
          tipo: "nueva",
          importacionId: "importacion-1",
          resultado: null,
          plan: args.candidatas.map((c) => ({ indice: c.indice, accion: "insertar" })),
        })
      );
    /* Fase 5 de S3: los PDF los publica Convex, con la sesión de quien confirma. */
    case "files:publicarFacturas":
      return (
        exigirCarga() ??
        ok(
          args.pdfs.map((p, i) => {
            const key = `condominios/facturas/${args.importacionId}/unidad-${p.unidad}-${i}.pdf`;
            publicados.push(key);
            return { key, publicUrl: `https://pruebas.s3.us-east-1.amazonaws.com/${key}` };
          }),
        )
      );
    case "facturas:bulkUpsert":
      return (
        exigirCarga() ??
        ok({
          inserted: args.facturas.length,
          updated: 0,
          skipped: 0,
          marcadas: 0,
          rechazadas: 0,
          rechazos: [],
          conciliacion: { pagadas: 0, abonadas: 0, vencidas: 0 },
        })
      );
    case "facturas:finalizarImportacion":
      return (
        exigirCarga() ??
        ok({ importacionId: args.importacionId, estado: args.estado, insertadas: 0, actualizadas: 0, omitidas: 0, marcadas: 0, rechazadas: 0, rechazos: [] })
      );
    case "incidentes:reporte": {
      if (!quien) return error(SIN_SESION);
      if (!rol.compania) return error("SIN_ACCESO_REPORTE");
      if (args.tipo === "SIN_DATOS") return error("REPORTE_VACIO: no hay incidentes.");
      return ok({
        periodo: { desdeDia: "2026-09-01", hastaDia: "2026-09-30" },
        reporte: {
          generadoEn: Date.parse("2026-09-30T10:30:00-05:00"),
          conjunto: "Todos los conjuntos autorizados",
          filtros: { estado: "TODOS", prioridad: "Todas", tipo: "Todos" },
          filas: [
            {
              referencia: "caso-1",
              conjunto: "Factory",
              reportadoEn: Date.parse("2026-09-10T08:00:00-05:00"),
              ocurrioEn: Date.parse("2026-09-10T07:30:00-05:00"),
              tipo: "ACCESO",
              prioridad: "MEDIA",
              estado: "REPORTADO",
              ubicacion: "Portería",
              reportante: "Guarda de prueba",
              responsable: "Supervisor de prueba",
              resueltoEn: null,
              cerradoEn: null,
            },
          ],
        },
      });
    }
    default:
      return error(`Función no simulada: ${funcion}`);
  }
}
const servidorConvex = createServer(async (req, res) => {
  const { path: funcion, args } = JSON.parse((await leerCuerpo(req)).toString() || "{}");
  if (convexFalla) {
    aConvex.push({ funcion, quien: null, falla: true });
    res.writeHead(500).end("Convex no respondió");
    return;
  }
  const quien = await identidadDe(req.headers.authorization);
  const r = responder(funcion, args?.[0] ?? {}, quien);
  aConvex.push({ funcion, quien, ...(r.status === "error" ? { error: r.errorMessage } : {}) });
  res.writeHead(r.status === "success" ? 200 : 560, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ...r, logLines: [] }));
});

const AUTH = await escuchar(servidorAuth);
const CONVEX = await escuchar(servidorConvex);
afterAll(() => {
  servidorAuth.close();
  servidorConvex.close();
});
JWKS = jose.createRemoteJWKSet(new URL(`${AUTH}/api/auth/convex/jwks`));
process.env.CONVEX_SITE_URL = AUTH;
process.env.NEXT_PUBLIC_CONVEX_SITE_URL = AUTH;
process.env.NEXT_PUBLIC_CONVEX_URL = CONVEX;
process.env.AWS_S3_BUCKET_NAME = "pruebas";

// ── Better Auth con los plugins del backend ─────────────────────────────
const { betterAuth } = await import("better-auth/minimal");
const { memoryAdapter } = await import("better-auth/adapters/memory");
const { crossDomain, convex } = await import("@convex-dev/better-auth/plugins");
const { getAuthConfigProvider } = await import("@convex-dev/better-auth/auth-config");
const db = { user: [], session: [], account: [], verification: [], jwks: [] };
const memoria = memoryAdapter(db);
auth = betterAuth({
  baseURL: AUTH,
  secret: "secreto-solo-para-esta-prueba-0123456789",
  trustedOrigins: [WEB, AUTH],
  /* El plugin `convex` anula las escrituras salvo en un contexto con
   * mutaciones, como el del adaptador de Convex en una acción HTTP. */
  database: (opciones) => {
    const adaptador = memoria(opciones);
    adaptador.options = { ...(adaptador.options ?? {}), isRunMutationCtx: true };
    return adaptador;
  },
  emailAndPassword: { enabled: true, requireEmailVerification: false },
  plugins: [crossDomain({ siteUrl: WEB }), convex({ authConfig: { providers: [getAuthConfigProvider()] } })],
});

// ── Lo que Next pone alrededor de una ruta ──────────────────────────────
let cabecerasEnCurso = new Headers();
mock.module("next/headers", () => ({ headers: async () => cabecerasEnCurso }));
mock.module("next/headers.js", () => ({ headers: async () => cabecerasEnCurso }));
/** Lo que publicó Convex (`files.publicarFacturas`). */
let publicados = [];
/** S3 desde Next: ya nadie debería escribir por aquí (Fase 5 de S3). */
let escriturasDeNext = [];
mock.module("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(comando) {
      escriturasDeNext.push(comando.input.Key);
      return {};
    }
  },
  PutObjectCommand: class {
    constructor(input) {
      this.input = input;
    }
  },
}));

const { authClient } = await import("../lib/auth-client");
const { fetchConSesion } = await import("../lib/fetch-con-sesion");
const { descargarReporteIncidentes } = await import("../lib/descargar-reporte-incidentes");
const RUTAS = {
  "/api/facturas/upload": (await import("../app/api/facturas/upload/route")).POST,
  "/api/facturas/confirmar": (await import("../app/api/facturas/confirmar/route")).POST,
  "/api/incidentes/reporte": (await import("../app/api/incidentes/reporte/route")).POST,
};

/* La red del navegador: lo que va a la web lo atiende la ruta real con las
 * cabeceras tal como salieron; lo demás (auth, Convex) va de verdad, y a otro
 * origen el navegador agrega Origin. */
const fetchReal = globalThis.fetch;
/** Lo que recibió Next de cada petición: solo si traía sesión. */
let aNext = [];
globalThis.fetch = async (entrada, init = {}) => {
  const url = new URL(typeof entrada === "string" ? entrada : entrada instanceof URL ? entrada.href : entrada.url, WEB);
  if (url.origin === WEB) {
    const peticion = new Request(url, init);
    aNext.push({
      ruta: url.pathname,
      betterAuthCookie: peticion.headers.has("better-auth-cookie"),
      cookie: peticion.headers.has("cookie"),
      authorization: peticion.headers.has("authorization"),
    });
    cabecerasEnCurso = new Headers(peticion.headers);
    const ruta = RUTAS[url.pathname];
    return ruta ? await ruta(peticion) : new Response(null, { status: 404 });
  }
  const cabeceras = new Headers(init.headers);
  if (url.origin === AUTH && !cabeceras.has("origin")) cabeceras.set("origin", WEB);
  return fetchReal(url, { ...init, headers: cabeceras });
};

// ── Personas ────────────────────────────────────────────────────────────
const CUENTAS = {
  administracion: { email: "administracion@vekino.test", password: "Clave-de-prueba-1", name: "Administración", roles: { carga: true, compania: true } },
  residente: { email: "residente@vekino.test", password: "Clave-de-prueba-2", name: "Residente", roles: {} },
};
for (const cuenta of Object.values(CUENTAS)) {
  const { user } = await auth.api.signUpEmail({ body: { email: cuenta.email, password: cuenta.password, name: cuenta.name } });
  cuenta.id = user.id;
  ROLES.set(user.id, cuenta.roles);
}
db.session.length = 0;

/** Login por el cliente real de la web, como el formulario de /login. */
async function entrarComo(nombre) {
  localStorage.clear();
  const { email, password } = CUENTAS[nombre];
  const { error } = await authClient.signIn.email({ email, password });
  if (error) throw new Error(`No se pudo iniciar sesión: ${error.message}`);
}
const tokenGuardado = () => JSON.parse(localStorage.getItem("better-auth_cookie") || "{}")["better-auth.session_token"]?.value;

const FIXTURE = readFileSync(join(import.meta.dir, "facturacion", "fixtures", "cdc-control.pdf"));
const pdf = () => new File([FIXTURE], "cdc-control.pdf", { type: "application/pdf" });
function formularioVistaPrevia() {
  const form = new FormData();
  form.append("pdf", pdf());
  form.append("condominioId", "condo-1");
  return form;
}

beforeEach(() => {
  localStorage.clear();
  alAuth = [];
  aConvex = [];
  aNext = [];
  publicados = [];
  escriturasDeNext = [];
  convexFalla = false;
});

describe("vista previa de facturas: la sesión llega y se valida", () => {
  test("con fetchConSesion la sesión llega en Better-Auth-Cookie, sin cookie, y la ruta lee el PDF", async () => {
    await entrarComo("administracion");
    expect(tokenGuardado()).toBeTruthy();
    const r = await fetchConSesion("/api/facturas/upload", { method: "POST", body: formularioVistaPrevia() });
    const cuerpo = await r.json();
    expect(r.status).toBe(200);
    expect(cuerpo.processed).toBeGreaterThan(0);
    expect(aNext).toEqual([{ ruta: "/api/facturas/upload", betterAuthCookie: true, cookie: false, authorization: false }]);
    // El auth recibió la sesión (que el plugin crossDomain convierte en cookie) y dio el JWT.
    expect(alAuth.filter((p) => p.ruta.endsWith("/convex/token"))[0]).toMatchObject({ status: 200, betterAuthCookie: true, token: true });
    // Convex verificó el JWT de esa misma persona.
    expect(aConvex).toEqual([{ funcion: "facturas:destinoCarga", quien: CUENTAS.administracion.id }]);
  });

  test("la misma persona, con un fetch sin la cabecera (como antes del arreglo), recibe 401", async () => {
    await entrarComo("administracion");
    const r = await fetch("/api/facturas/upload", { method: "POST", body: formularioVistaPrevia() });
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: "Inicia sesión para subir facturas." });
    expect(aNext[0]).toMatchObject({ betterAuthCookie: false, cookie: false });
    expect(aConvex).toEqual([]);
  });

  test("sin sesión: 401 y Convex no se consulta", async () => {
    const r = await fetchConSesion("/api/facturas/upload", { method: "POST", body: formularioVistaPrevia() });
    expect(r.status).toBe(401);
    expect(aNext[0].betterAuthCookie).toBe(false);
    expect(aConvex).toEqual([]);
  });

  test.each([
    ["inventada", () => "better-auth.session_token=sesion-inventada.firma-inventada"],
    ["con la firma alterada", () => `better-auth.session_token=${tokenGuardado().replace(/.$/, (c) => (c === "A" ? "B" : "A"))}`],
  ])("una cabecera %s no basta: el auth valida la sesión y la ruta responde 401", async (_caso, falsa) => {
    await entrarComo("administracion");
    const cabecera = falsa();
    localStorage.clear();
    const r = await fetch("/api/facturas/upload", { method: "POST", body: formularioVistaPrevia(), headers: { "Better-Auth-Cookie": cabecera } });
    expect(r.status).toBe(401);
    expect(alAuth.find((p) => p.ruta.endsWith("/convex/token"))).toMatchObject({ status: 401, token: false });
    expect(aConvex).toEqual([]);
  });

  test.each([
    ["cerrada en el servidor", () => (db.session.length = 0)],
    ["vencida", () => db.session.forEach((s) => (s.expiresAt = new Date(Date.now() - 60_000)))],
  ])("una sesión %s ya no entra aunque siga guardada en el navegador", async (_caso, invalidar) => {
    await entrarComo("administracion");
    invalidar();
    expect(tokenGuardado()).toBeTruthy();
    const r = await fetchConSesion("/api/facturas/upload", { method: "POST", body: formularioVistaPrevia() });
    expect(r.status).toBe(401);
    expect(aConvex).toEqual([]);
  });

  test("con sesión pero sin rol de carga: 403, sin leer ni publicar nada", async () => {
    await entrarComo("residente");
    const r = await fetchConSesion("/api/facturas/upload", { method: "POST", body: formularioVistaPrevia() });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: "No tienes permiso para subir facturas de este conjunto." });
    expect(aConvex).toEqual([{ funcion: "facturas:destinoCarga", quien: CUENTAS.residente.id }]);
    expect(publicados).toEqual([]);
  });
});

describe("confirmación de facturas: cada paso que escribe lleva la sesión", () => {
  async function vistaPreviaComoAdministracion() {
    await entrarComo("administracion");
    const r = await fetchConSesion("/api/facturas/upload", { method: "POST", body: formularioVistaPrevia() });
    expect(r.status).toBe(200);
    return await r.json();
  }
  function formularioConfirmacion(previa) {
    const form = new FormData();
    form.append("pdf", pdf());
    form.append("condominioId", "condo-1");
    form.append("periodo", previa.periodosDocumento[0]);
    form.append("hash", previa.hash);
    form.append("soloNuevas", "true");
    form.append("asignaciones", JSON.stringify(previa.invoices.map((_f, indice) => ({ indice, unidadId: `unidad-${indice}` }))));
    return form;
  }

  test("con sesión y rol: importa, publica y cierra, todo con la identidad de quien confirma", async () => {
    const previa = await vistaPreviaComoAdministracion();
    aConvex = [];
    const r = await fetchConSesion("/api/facturas/confirmar", { method: "POST", body: formularioConfirmacion(previa) });
    expect(r.status).toBe(200);
    expect((await r.json()).tipo).toBe("nueva");
    expect(aNext.at(-1)).toEqual({ ruta: "/api/facturas/confirmar", betterAuthCookie: true, cookie: false, authorization: false });
    expect(aConvex.map((c) => c.funcion)).toEqual([
      "facturas:destinoCarga",
      "facturas:iniciarImportacion",
      "files:publicarFacturas",
      "facturas:bulkUpsert",
      "facturas:finalizarImportacion",
    ]);
    expect(aConvex.every((c) => c.quien === CUENTAS.administracion.id)).toBe(true);
    expect(publicados).toHaveLength(previa.invoices.length);
    expect(escriturasDeNext).toEqual([]);
  });

  test("sin sesión: 401 antes de leer el formulario; ni Convex ni S3", async () => {
    const previa = await vistaPreviaComoAdministracion();
    localStorage.clear();
    aConvex = [];
    const r = await fetchConSesion("/api/facturas/confirmar", { method: "POST", body: formularioConfirmacion(previa) });
    expect(r.status).toBe(401);
    expect(aConvex).toEqual([]);
    expect(publicados).toEqual([]);
  });

  test("con sesión pero sin rol de carga: 403 y nada se escribe", async () => {
    const previa = await vistaPreviaComoAdministracion();
    await entrarComo("residente");
    aConvex = [];
    const r = await fetchConSesion("/api/facturas/confirmar", { method: "POST", body: formularioConfirmacion(previa) });
    expect(r.status).toBe(403);
    expect(aConvex.map((c) => c.funcion)).toEqual(["facturas:destinoCarga"]);
    expect(publicados).toEqual([]);
  });
});

describe("reporte de incidentes: autenticación, permiso y datos se distinguen", () => {
  let archivos;
  const crearOriginal = URL.createObjectURL;
  const revocarOriginal = URL.revokeObjectURL;
  beforeEach(() => {
    archivos = [];
    URL.createObjectURL = (blob) => {
      archivos.push(blob);
      return "blob:reporte";
    };
    URL.revokeObjectURL = () => {};
    ventana.HTMLAnchorElement.prototype.click = function () {};
  });
  afterAll(() => {
    URL.createObjectURL = crearOriginal;
    URL.revokeObjectURL = revocarOriginal;
  });
  const descargar = (parametros = "periodo=personalizado&desde=2026-09-01&hasta=2026-09-30") => {
    const estados = [];
    return descargarReporteIncidentes(new URLSearchParams(parametros), "csv", (e) => estados.push(e), new AbortController().signal).then(() => estados);
  };

  test("con sesión y rol de compañía: la descarga completa trae el CSV", async () => {
    await entrarComo("administracion");
    expect(await descargar()).toEqual(["Preparando", "Generando", "Descargando", "Completado"]);
    expect(aNext).toEqual([{ ruta: "/api/incidentes/reporte", betterAuthCookie: true, cookie: false, authorization: false }]);
    expect(aConvex).toEqual([{ funcion: "incidentes:reporte", quien: CUENTAS.administracion.id }]);
    // BOM para Excel (Blob.text() lo descarta al decodificar: se miran los bytes).
    expect([...new Uint8Array(await archivos[0].arrayBuffer()).slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const csv = await archivos[0].text();
    expect(csv).toContain('"Referencia","Fecha reporte"');
    expect(csv).toContain('"caso-1"');
  });

  test("sin sesión: 403 y Convex recibe la consulta SIN identidad (falta autenticación)", async () => {
    await expect(descargar()).rejects.toThrow("No tienes acceso a este reporte. Revisa tu sesión.");
    expect(aNext[0].betterAuthCookie).toBe(false);
    expect(aConvex).toEqual([{ funcion: "incidentes:reporte", quien: null, error: SIN_SESION }]);
  });

  test("con sesión pero sin rol de compañía: 403 por permiso (Convex SÍ recibe la identidad)", async () => {
    await entrarComo("residente");
    await expect(descargar()).rejects.toThrow("No tienes acceso a este reporte. Revisa tu sesión.");
    expect(aConvex).toEqual([{ funcion: "incidentes:reporte", quien: CUENTAS.residente.id, error: "SIN_ACCESO_REPORTE" }]);
    expect(archivos).toEqual([]);
  });

  test("con sesión y rol, pero sin datos: 422 'No hay incidentes…', distinto de un error de acceso", async () => {
    await entrarComo("administracion");
    await expect(descargar("periodo=personalizado&desde=2026-09-01&hasta=2026-09-30&tipo=SIN_DATOS")).rejects.toThrow(
      "No hay incidentes para los filtros seleccionados.",
    );
    expect(aConvex[0]).toMatchObject({ quien: CUENTAS.administracion.id });
  });
});

describe("los errores no exponen la sesión", () => {
  test("si Convex falla, las rutas responden un error genérico y ni la respuesta ni los registros llevan la sesión", async () => {
    await entrarComo("administracion");
    const token = tokenGuardado();
    const registrado = [];
    const metodos = ["log", "info", "warn", "error", "debug"];
    const originales = Object.fromEntries(metodos.map((m) => [m, console[m]]));
    for (const m of metodos) console[m] = (...args) => registrado.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : String(a))).join(" "));
    convexFalla = true;
    let subida, reporte;
    try {
      subida = await fetchConSesion("/api/facturas/upload", { method: "POST", body: formularioVistaPrevia() });
      reporte = await fetchConSesion("/api/incidentes/reporte", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parametros: "periodo=personalizado&desde=2026-09-01&hasta=2026-09-30", formato: "csv" }),
      });
    } finally {
      for (const m of metodos) console[m] = originales[m];
    }
    const textoSubida = await subida.text();
    const textoReporte = await reporte.text();
    expect(subida.status).toBe(500);
    expect(JSON.parse(textoSubida)).toEqual({ error: "No fue posible validar tu sesión. Intenta de nuevo." });
    expect(reporte.status).toBe(500);
    expect(JSON.parse(textoReporte)).toEqual({ error: "No fue posible generar el reporte. Intenta nuevamente." });
    for (const texto of [textoSubida, textoReporte, ...registrado]) expect(texto).not.toContain(token);
  });
});
