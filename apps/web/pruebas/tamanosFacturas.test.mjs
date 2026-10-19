import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getFunctionName } from "convex/server";
import { convexToJson } from "convex/values";
import { PDFDocument, PDFName, PDFRawStream } from "pdf-lib";

/**
 * TAMAÑOS EN LA CONFIRMACIÓN DE FACTURAS (Fase 6 de S3).
 *
 * /api/facturas/confirmar publica el PDF de cada factura de dos formas:
 *   · los que caben (hasta 3 MiB) van en lotes a `files.publicarFacturas`,
 *     una acción Node que recibe hasta 5 MiB de argumentos, con los bytes en
 *     base64;
 *   · uno más grande sube por la ruta intermediada del backend
 *     (`/archivos/subida`, hasta 20 MiB) a la carpeta de la importación.
 *
 * Aquí, con PDF de verdad (los fixtures) a los que se les agrega una imagen de
 * relleno incompresible del tamaño que se quiere probar. Convex y la ruta
 * intermediada se simulan; el tamaño de cada llamada a Convex se mide con la
 * MISMA codificación del cliente HTTP de Convex. Lo que acepten de verdad
 * Vercel y Convex se confirma en un entorno real (ver el informe de la Fase 6).
 */

const FIXTURES = join(import.meta.dir, "facturacion", "fixtures");
const MiB = 1024 * 1024;
const LIMITE_NODE = 5 * MiB;
const SITIO = "https://convex.prueba";
const huella = (b) => createHash("sha256").update(b).digest("hex");

let llamadas;
let publicaciones;
let intermediadas;
let escriturasDeNext;
/** Si se indica, falla la llamada a `publicarFacturas` número N. */
let fallarPublicacionN;
/** Lo que responde la ruta intermediada (200 si no se dice otra cosa). */
let estadoIntermediada;
let fetchOriginal;

mock.module("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(c) {
      escriturasDeNext.push(c.input);
      return {};
    }
  },
  PutObjectCommand: class {
    constructor(i) {
      this.input = i;
    }
  },
}));

mock.module("@/lib/auth-server", () => ({
  handler: async () => new Response(null, { status: 404 }),
  getToken: async () => "token",
  isAuthenticated: async () => true,
  preloadAuthQuery: async () => ({}),
  fetchAuthQuery: async () => ({ allowed: true, condominioId: "condo-1", carpeta: "conjunto-de-prueba" }),
  fetchAuthAction: async (fn, args) => {
    const nombre = getFunctionName(fn);
    llamadas.push({ nombre, args });
    if (nombre === "files:publicarFacturas") {
      // El cuerpo HTTP tal como lo arma ConvexHttpClient.action.
      const cuerpo = new TextEncoder().encode(
        JSON.stringify({ path: nombre, format: "convex_encoded_json", args: [convexToJson(args)] }),
      ).byteLength;
      const crudos = args.pdfs.reduce((s, p) => s + p.bytes.byteLength, 0);
      publicaciones.push({ pdfs: args.pdfs.length, crudos, cuerpo });
      if (cuerpo > LIMITE_NODE) throw new Error("Simulado: los argumentos pasan de 5 MiB");
      if (publicaciones.length === fallarPublicacionN) throw new Error("No se pudo publicar el PDF de una factura. Intenta de nuevo.");
      const n = publicaciones.length;
      return args.pdfs.map((p, i) => ({
        key: `inline${n}-${i}`,
        publicUrl: `https://vekino.s3.us-east-1.amazonaws.com/condominios/facturas/conjunto-de-prueba/p/imp1/unidad-${p.unidad}-inline${n}-${i}.pdf`,
      }));
    }
    if (nombre === "files:generateUploadUrl") {
      const n = llamadas.filter((l) => l.nombre === "files:generateUploadUrl").length;
      return {
        uploadUrl: `${SITIO}/archivos/subida?token=${"0".repeat(63)}${n}`,
        key: `${args.folder}/grande-${n}.pdf`,
        publicUrl: `https://vekino.s3.us-east-1.amazonaws.com/${args.folder}/grande-${n}.pdf`,
      };
    }
    throw new Error(`Acción inesperada: ${nombre}`);
  },
  fetchAuthMutation: async (fn, args) => {
    const nombre = getFunctionName(fn);
    llamadas.push({ nombre, args });
    if (nombre === "facturas:iniciarImportacion") {
      return {
        tipo: "nueva",
        importacionId: "imp1",
        resultado: null,
        plan: args.candidatas.map((c) => ({ indice: c.indice, accion: "insertar" })),
      };
    }
    if (nombre === "facturas:bulkUpsert") {
      return { inserted: args.facturas.length, updated: 0, skipped: 0, marcadas: 0, rechazadas: 0, rechazos: [], conciliacion: { pagadas: 0, abonadas: 0, vencidas: 0 } };
    }
    if (nombre === "facturas:finalizarImportacion") return { importacionId: "imp1", estado: args.estado };
    throw new Error(`Mutación inesperada: ${nombre}`);
  },
}));

const { POST } = await import("../app/api/facturas/confirmar/route");

beforeEach(() => {
  llamadas = [];
  publicaciones = [];
  intermediadas = [];
  escriturasDeNext = [];
  fallarPublicacionN = undefined;
  estadoIntermediada = 200;
  fetchOriginal = globalThis.fetch;
  /* La ruta intermediada del backend: la única petición de red de la ruta. */
  globalThis.fetch = async (url, init = {}) => {
    if (!String(url).startsWith(`${SITIO}/archivos/subida?token=`)) throw new Error(`Red bloqueada: ${url}`);
    const bytes = new Uint8Array(init.body);
    intermediadas.push({ url: String(url), metodo: init.method, tipo: new Headers(init.headers).get("content-type"), bytes: bytes.byteLength });
    return new Response(JSON.stringify(estadoIntermediada === 200 ? { ok: true } : { error: "x" }), { status: estadoIntermediada });
  };
});

afterEach(() => {
  globalThis.fetch = fetchOriginal;
});

/**
 * El fixture con una imagen de relleno (bytes al azar, incompresibles) en
 * cada página: `porPagina[i]` bytes en la página i. Con `compartida`, UNA
 * sola imagen de `porPagina` bytes la usan todas las páginas (como un logo
 * pesado): el PDF de cada factura la lleva entera.
 */
async function conRelleno(archivo, porPagina, { compartida = false } = {}) {
  const doc = await PDFDocument.load(readFileSync(join(FIXTURES, archivo)));
  const imagen = (n) => {
    const ancho = 1000;
    const alto = Math.max(1, Math.floor(n / (ancho * 3)));
    const datos = randomBytes(ancho * alto * 3);
    const dict = doc.context.obj({ Type: "XObject", Subtype: "Image", Width: ancho, Height: alto, ColorSpace: "DeviceRGB", BitsPerComponent: 8, Length: datos.length });
    return doc.context.register(PDFRawStream.of(dict, datos));
  };
  const una = compartida ? imagen(porPagina) : null;
  doc.getPages().forEach((pagina, i) => {
    const n = Array.isArray(porPagina) ? porPagina[i] : porPagina;
    if (n) pagina.node.setXObject(PDFName.of("Relleno"), una ?? imagen(n));
  });
  return new Uint8Array(await doc.save({ useObjectStreams: false }));
}

async function confirmar(bytes, nombre, facturas) {
  const form = new FormData();
  form.append("pdf", new File([bytes], nombre, { type: "application/pdf" }));
  form.append("condominioId", "condo-1");
  form.append("periodo", "2026-09");
  form.append("hash", huella(bytes));
  form.append("soloNuevas", "true");
  form.append("asignaciones", JSON.stringify(Array.from({ length: facturas }, (_, i) => ({ indice: i, unidadId: `u${i}` }))));
  const res = await POST(new Request("http://localhost/api/facturas/confirmar", { method: "POST", body: form }));
  return { status: res.status, cuerpo: await res.json() };
}

const nombres = () => llamadas.map((l) => l.nombre);
const guardadas = () => llamadas.filter((l) => l.nombre === "facturas:bulkUpsert").flatMap((l) => l.args.facturas);
const fin = () => llamadas.find((l) => l.nombre === "facturas:finalizarImportacion")?.args;
const CARPETA_IMPORTACION = "condominios/facturas/conjunto-de-prueba/2026-09/imp1";

describe("carga masiva · lo que cabe en llamadas a publicarFacturas", () => {
  test("importación normal de varias facturas: una llamada, nada por la ruta intermediada", async () => {
    const r = await confirmar(readFileSync(join(FIXTURES, "cdc-consolidado-con-continuacion.pdf")), "consolidado.pdf", 2);
    expect(r.status).toBe(200);
    expect(publicaciones).toHaveLength(1);
    expect(intermediadas).toEqual([]);
    expect(guardadas().map((f) => typeof f.pdfUrl)).toEqual(["string", "string"]);
  });

  test("un original de tamaño considerable (~3,6 MiB) cuyas facturas suman más de 3 MiB: varias llamadas, todas bajo 5 MiB, y se guardan todas", async () => {
    const bytes = await conRelleno("cdc-consolidado-con-continuacion.pdf", 1_200_000);
    expect(bytes.byteLength).toBeGreaterThan(3 * MiB);
    const r = await confirmar(bytes, "consolidado.pdf", 2);
    expect(r.status).toBe(200);
    expect(publicaciones.length).toBeGreaterThanOrEqual(2);
    for (const p of publicaciones) {
      expect(p.crudos).toBeLessThanOrEqual(3 * MiB);
      expect(p.cuerpo).toBeLessThan(LIMITE_NODE);
    }
    expect(intermediadas).toEqual([]);
    expect(guardadas()).toHaveLength(2);
  });

  test("una factura de ~2,96 MiB (justo bajo 3 MiB): una llamada de ~3,95 MiB, bajo el límite de 5 MiB", async () => {
    const r = await confirmar(await conRelleno("cdc-control.pdf", 3_100_000), "grande.pdf", 1);
    expect(r.status).toBe(200);
    const [p] = publicaciones;
    expect(p.crudos).toBeLessThanOrEqual(3 * MiB);
    expect(p.cuerpo).toBeGreaterThan(3.9 * MiB);
    expect(p.cuerpo).toBeLessThan(LIMITE_NODE);
    expect(intermediadas).toEqual([]);
  });
});

describe("carga masiva · facturas de más de 3 MiB por la ruta intermediada", () => {
  test("una imagen compartida por todas las páginas (cada factura pasa de 3 MiB): ya no se rechaza, sube por la ruta intermediada a la carpeta de la importación", async () => {
    const bytes = await conRelleno("cdc-consolidado-con-continuacion.pdf", 3_250_000, { compartida: true });
    expect(bytes.byteLength).toBeLessThan(4.5 * 1000 * 1000);
    const r = await confirmar(bytes, "con-logo-pesado.pdf", 2);
    expect(r.status).toBe(200);
    expect(publicaciones).toEqual([]);
    const pedidas = llamadas.filter((l) => l.nombre === "files:generateUploadUrl").map((l) => l.args);
    expect(pedidas).toHaveLength(2);
    for (const a of pedidas) expect(a).toMatchObject({ folder: CARPETA_IMPORTACION, contentType: "application/pdf" });
    expect(intermediadas).toHaveLength(2);
    for (const i of intermediadas) {
      expect(i).toMatchObject({ metodo: "PUT", tipo: "application/pdf" });
      expect(i.bytes).toBeGreaterThan(3 * MiB);
    }
    expect(guardadas().map((f) => f.pdfUrl).sort()).toEqual(
      [1, 2].map((n) => `https://vekino.s3.us-east-1.amazonaws.com/${CARPETA_IMPORTACION}/grande-${n}.pdf`).sort(),
    );
    expect(escriturasDeNext).toEqual([]);
  });

  test("mezcla: la factura grande va por la ruta intermediada y la pequeña en lote, y se guardan las dos", async () => {
    const bytes = await conRelleno("cdc-consolidado-con-continuacion.pdf", [3_250_000, 0, 0]);
    const r = await confirmar(bytes, "mezcla.pdf", 2);
    expect(r.status).toBe(200);
    expect(intermediadas).toHaveLength(1);
    expect(publicaciones).toHaveLength(1);
    expect(guardadas()).toHaveLength(2);
    expect(guardadas().every((f) => typeof f.pdfUrl === "string")).toBe(true);
  });

  test("si la ruta intermediada responde 413 (más de 20 MiB): 413 claro, la importación queda fallida y no se guarda nada", async () => {
    estadoIntermediada = 413;
    const r = await confirmar(await conRelleno("cdc-control.pdf", 3_250_000), "enorme.pdf", 1);
    expect(r.status).toBe(413);
    expect(r.cuerpo.error).toMatch(/demasiado grande para publicarse/);
    expect(nombres()).not.toContain("facturas:bulkUpsert");
    expect(fin()).toMatchObject({ estado: "fallida" });
  });

  test("si la ruta intermediada falla (500): 500 sin detalles internos, fallida y sin facturas guardadas", async () => {
    estadoIntermediada = 500;
    const r = await confirmar(await conRelleno("cdc-control.pdf", 3_250_000), "grande.pdf", 1);
    expect(r.status).toBe(500);
    expect(r.cuerpo.error).not.toMatch(/convex|token|amazonaws|S3/i);
    expect(nombres()).not.toContain("facturas:bulkUpsert");
    expect(fin()).toMatchObject({ estado: "fallida" });
  });
});

describe("carga masiva · fallos y archivos inválidos", () => {
  test("falla el segundo lote: no se guarda nada y queda fallida; al reintentar se completa", async () => {
    const bytes = await conRelleno("cdc-consolidado-con-continuacion.pdf", 1_200_000);
    fallarPublicacionN = 2;
    const primera = await confirmar(bytes, "consolidado.pdf", 2);
    expect(primera.status).toBe(500);
    expect(nombres()).not.toContain("facturas:bulkUpsert");
    expect(fin()).toMatchObject({ estado: "fallida" });

    llamadas = [];
    publicaciones = [];
    fallarPublicacionN = undefined;
    const segunda = await confirmar(bytes, "consolidado.pdf", 2);
    expect(segunda.status).toBe(200);
    expect(guardadas()).toHaveLength(2);
  });

  test("con extensión .pdf pero sin contenido PDF: 422 con el mismo mensaje que la vista previa, sin iniciar la importación", async () => {
    const r = await confirmar(new TextEncoder().encode("Cuenta de cobro 101: esto no es un PDF"), "factura.pdf", 1);
    expect(r.status).toBe(422);
    expect(r.cuerpo.error).toBe("El archivo no es un PDF válido o está dañado. Revísalo y vuelve a subirlo.");
    expect(nombres()).toEqual([]);
  });
});
