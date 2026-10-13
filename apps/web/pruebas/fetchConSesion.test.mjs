import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Window } from "happy-dom";

const ventana = new Window({ url: "http://localhost:3000" });
for (const clave of ["window", "document", "navigator", "localStorage"]) {
  Object.defineProperty(globalThis, clave, { configurable: true, value: clave === "window" ? ventana : ventana[clave] });
}
/* El cliente no sale a la red en estas pruebas; la URL solo evita el aviso de
 * variable faltante de lib/auth-client.ts. */
process.env.NEXT_PUBLIC_CONVEX_SITE_URL = "http://127.0.0.1:9";

/**
 * `fetchConSesion` (lib/fetch-con-sesion.ts): la sesión del cliente oficial
 * viaja a las rutas API de la web en la cabecera `Better-Auth-Cookie`.
 *
 * Usa el cliente REAL de Better Auth de la web (`lib/auth-client.ts`, con
 * `crossDomainClient`) sobre el `localStorage` de happy-dom, con la sesión
 * guardada como la guarda ese plugin. Lo único simulado es la red (`fetch`).
 * La validación de la sesión en el servidor la prueba sesionRutasApi.test.mjs.
 */

const { authClient } = await import("../lib/auth-client");
const { fetchConSesion } = await import("../lib/fetch-con-sesion");

const TOKEN = "token-de-sesion.firma";
const futuro = () => new Date(Date.now() + 3_600_000).toISOString();
const pasado = () => new Date(Date.now() - 3_600_000).toISOString();
/** Lo que deja `crossDomainClient` en localStorage tras iniciar sesión. */
function guardarSesion() {
  localStorage.setItem(
    "better-auth_cookie",
    JSON.stringify({
      "better-auth.session_token": { value: TOKEN, expires: futuro() },
      "better-auth.convex_jwt": { value: "jwt-vencido", expires: pasado() },
    }),
  );
}

let llamadas, consola;
const fetchOriginal = globalThis.fetch;
const metodosConsola = ["log", "info", "warn", "error", "debug"];
const consolaOriginal = Object.fromEntries(metodosConsola.map((m) => [m, console[m]]));
beforeEach(() => {
  localStorage.clear();
  llamadas = [];
  consola = [];
  globalThis.fetch = async (url, init) => {
    llamadas.push({ url, init });
    return new Response("{}", { status: 200 });
  };
  for (const m of metodosConsola) console[m] = (...args) => consola.push(args.map(String).join(" "));
});
afterEach(() => {
  globalThis.fetch = fetchOriginal;
  for (const m of metodosConsola) console[m] = consolaOriginal[m];
});
const cabeceras = (i = 0) => new Headers(llamadas[i].init.headers);

describe("fetchConSesion · la cabecera", () => {
  test("manda la sesión del cliente oficial en Better-Auth-Cookie, con el formato de getCookie() y sin lo vencido", async () => {
    guardarSesion();
    await fetchConSesion("/api/facturas/upload", { method: "POST" });
    expect(authClient.getCookie()).toBe(`better-auth.session_token=${TOKEN}`);
    expect(cabeceras().get("better-auth-cookie")).toBe(`better-auth.session_token=${TOKEN}`);
    // No hace falta una cookie del dominio: la sesión va en la cabecera.
    expect(cabeceras().has("cookie")).toBe(false);
    expect(cabeceras().has("authorization")).toBe(false);
  });

  test("sin sesión sale sin la cabecera: no inventa una, y la ruta decide", async () => {
    await fetchConSesion("/api/facturas/upload", { method: "POST" });
    expect(llamadas).toHaveLength(1);
    expect(cabeceras().has("better-auth-cookie")).toBe(false);
  });

  test.each([
    ["sin sesión guardada", false],
    ["con sesión guardada", true],
  ])("una Better-Auth-Cookie que trae quien llama no pasa (%s): solo sale la del cliente oficial", async (_caso, conSesion) => {
    if (conSesion) guardarSesion();
    await fetchConSesion("/api/facturas/upload", { headers: { "Better-Auth-Cookie": "better-auth.session_token=ajena" } });
    expect(cabeceras().get("better-auth-cookie")).toBe(conSesion ? `better-auth.session_token=${TOKEN}` : null);
  });

  test("si la sesión guardada no se puede leer, sale sin la cabecera y sin registrar nada", async () => {
    const leer = localStorage.getItem;
    localStorage.getItem = () => {
      throw new Error("almacenamiento bloqueado");
    };
    try {
      await fetchConSesion("/api/incidentes/reporte", { method: "POST" });
    } finally {
      localStorage.getItem = leer;
    }
    expect(llamadas).toHaveLength(1);
    expect(cabeceras().has("better-auth-cookie")).toBe(false);
    expect(consola).toEqual([]);
  });

  test("no registra la sesión en ningún lado", async () => {
    guardarSesion();
    await fetchConSesion("/api/facturas/confirmar", { method: "POST" });
    expect(consola).toEqual([]);
  });
});

describe("fetchConSesion · conserva la petición de quien llama", () => {
  test("misma URL, método, cuerpo, señal y demás opciones", async () => {
    guardarSesion();
    const cuerpo = new FormData();
    cuerpo.append("condominioId", "condo-1");
    const control = new AbortController();
    await fetchConSesion("/api/facturas/upload", { method: "POST", body: cuerpo, signal: control.signal, cache: "no-store" });
    const { url, init } = llamadas[0];
    expect(url).toBe("/api/facturas/upload");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(cuerpo);
    expect(init.signal).toBe(control.signal);
    expect(init.cache).toBe("no-store");
  });

  test.each([
    ["objeto", { "Content-Type": "application/json", "X-Otra": "1" }],
    ["Headers", new Headers({ "Content-Type": "application/json", "X-Otra": "1" })],
    ["lista de pares", [["Content-Type", "application/json"], ["X-Otra", "1"]]],
  ])("combina las cabeceras de quien llama (%s) sin pisarlas", async (_forma, propias) => {
    guardarSesion();
    await fetchConSesion("/api/incidentes/reporte", { method: "POST", headers: propias, body: "{}" });
    expect(cabeceras().get("content-type")).toBe("application/json");
    expect(cabeceras().get("x-otra")).toBe("1");
    expect(cabeceras().get("better-auth-cookie")).toBe(`better-auth.session_token=${TOKEN}`);
  });

  test("devuelve la respuesta de la ruta tal cual, también un rechazo", async () => {
    globalThis.fetch = async () => Response.json({ error: "Inicia sesión para subir facturas." }, { status: 401 });
    const r = await fetchConSesion("/api/facturas/upload", { method: "POST" });
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: "Inicia sesión para subir facturas." });
  });
});

describe("fetchConSesion · solo a rutas de esta web", () => {
  test.each(["https://otro.example/api/facturas/upload", "//otro.example/api/facturas/upload", new URL("http://127.0.0.1:3000/api/facturas/upload")])(
    "a otro origen (%s) no manda nada",
    async (destino) => {
      guardarSesion();
      await expect(fetchConSesion(destino, { method: "POST" })).rejects.toThrow("solo manda la sesión a rutas de esta aplicación");
      expect(llamadas).toHaveLength(0);
    },
  );

  test("una URL absoluta del mismo origen sí lleva la sesión", async () => {
    guardarSesion();
    await fetchConSesion("http://localhost:3000/api/facturas/upload", { method: "POST" });
    expect(cabeceras().get("better-auth-cookie")).toBe(`better-auth.session_token=${TOKEN}`);
  });
});

describe("toda llamada de la web a sus rutas /api/ pasa por fetchConSesion", () => {
  const RAIZ = join(import.meta.dir, "..");
  function archivos(dir) {
    return readdirSync(dir).flatMap((nombre) => {
      const ruta = join(dir, nombre);
      if (statSync(ruta).isDirectory()) return archivos(ruta);
      return /\.(ts|tsx)$/.test(nombre) ? [ruta] : [];
    });
  }
  const fuentes = ["app", "components", "hooks", "lib"].flatMap((d) => archivos(join(RAIZ, d)));
  const lineasDeCodigo = (ruta) =>
    readFileSync(ruta, "utf8")
      .split("\n")
      .map((linea, i) => ({ linea, n: i + 1 }))
      .filter(({ linea }) => !/^\s*(\*|\/\/|\/\*)/.test(linea));

  test("ningún fetch directo a /api/ (sin sesión las rutas responden 401/403)", () => {
    const directos = fuentes.flatMap((ruta) =>
      lineasDeCodigo(ruta)
        .filter(({ linea }) => /\bfetch\(\s*["'`]\/api\//.test(linea))
        .map(({ n }) => `${ruta.slice(RAIZ.length + 1)}:${n}`),
    );
    expect(directos).toEqual([]);
  });

  test("la carga de facturas (vista previa y confirmación) y el reporte de incidentes la usan", () => {
    const usos = fuentes.flatMap((ruta) =>
      lineasDeCodigo(ruta)
        .map(({ linea }) => linea.match(/fetchConSesion\(\s*["'`](\/api\/[^"'`]+)/)?.[1])
        .filter(Boolean),
    );
    expect(usos.sort()).toEqual(["/api/facturas/confirmar", "/api/facturas/upload", "/api/incidentes/reporte"]);
  });
});
