import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getFunctionName } from "convex/server";

/**
 * QUIÉN PUEDE USAR /api/facturas/upload (Fase 1 de la auditoría de
 * facturación, docs/audits/FASE-1-FACTURACION.md).
 *
 * La ruta lee el PDF y lo publica en S3, en la carpeta del conjunto. Hasta la
 * Fase 1 respondía a cualquiera. La prueba de la Fase 0 (F07-subida-sin-sesion,
 * en `pruebas/facturacion/parserFacturas.test.mjs`) cubre "sin sesión"; aquí,
 * el resto: sesión sin permiso, sesión inválida, fallo al validar, y que con
 * permiso todo sigue como antes.
 *
 * Archivo aparte —y proceso aparte en `test:facturacion`— porque simula
 * `@/lib/auth-server` de otra forma que las pruebas del parser, y en un mismo
 * proceso de `bun test` los dobles de módulos se pisan entre archivos.
 */

const PDF = readFileSync(join(import.meta.dir, "facturacion", "fixtures", "cdc-control.pdf"));

let subidas = [];
let consultas = [];
let haySesion = true;
/** Lo que responde Convex a `facturas.destinoCarga` (antes, `permisoSubida`). */
let permiso = async () => ({ allowed: true });

mock.module("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(comando) {
      subidas.push(comando.input);
      return {};
    }
  },
  PutObjectCommand: class {
    constructor(input) {
      this.input = input;
    }
  },
}));

const sinSesion = () => {
  throw new Error("No autenticado o perfil inexistente.");
};
mock.module("@/lib/auth-server", () => ({
  handler: async () => new Response(null, { status: 404 }),
  getToken: async () => (haySesion ? "token-de-prueba" : undefined),
  isAuthenticated: async () => haySesion,
  preloadAuthQuery: async () => sinSesion(),
  fetchAuthQuery: async (consulta, args) => {
    consultas.push({ nombre: getFunctionName(consulta), args });
    return await permiso();
  },
  fetchAuthMutation: async () => sinSesion(),
  fetchAuthAction: async () => sinSesion(),
}));

const { POST } = await import("../app/api/facturas/upload/route");

beforeEach(() => {
  subidas = [];
  consultas = [];
  haySesion = true;
  permiso = async () => ({ allowed: true });
});

async function subir() {
  const form = new FormData();
  form.append("pdf", new File([PDF], "cdc-control.pdf", { type: "application/pdf" }));
  form.append("condominioLegacyId", "conjunto-de-prueba");
  form.append("periodo", "2026-09");
  const res = await POST(
    new Request("http://localhost/api/facturas/upload", { method: "POST", body: form }),
  );
  return { status: res.status, cuerpo: await res.json() };
}

describe("F07 · /api/facturas/upload exige sesión y permiso sobre el conjunto", () => {
  test("sin sesión: 401, sin preguntar permisos ni tocar S3", async () => {
    haySesion = false;
    const { status } = await subir();
    expect(status).toBe(401);
    expect(consultas).toEqual([]);
    expect(subidas).toEqual([]);
  });

  test("con sesión pero sin rol en el conjunto (o de otro conjunto): 403 y nada en S3", async () => {
    permiso = async () => ({ allowed: false, motivo: "sin_permiso" });
    const { status, cuerpo } = await subir();
    expect(status).toBe(403);
    expect(cuerpo.error).toMatch(/permiso/);
    expect(subidas).toEqual([]);
  });

  test("hay cookie, pero Convex no reconoce a la persona: 401 y nada en S3", async () => {
    permiso = async () => ({ allowed: false, motivo: "sin_sesion" });
    expect((await subir()).status).toBe(401);
    expect(subidas).toEqual([]);
  });

  test("un token que Convex rechaza (error de autenticación): 401 y nada en S3", async () => {
    permiso = async () => sinSesion();
    expect((await subir()).status).toBe(401);
    expect(subidas).toEqual([]);
  });

  test("si no se puede validar el permiso, no pasa: 500 y nada en S3", async () => {
    permiso = async () => {
      throw new Error("fetch failed");
    };
    expect((await subir()).status).toBe(500);
    expect(subidas).toEqual([]);
  });

  /*
   * Hasta la Fase 1 esta prueba exigía que la vista previa publicara el PDF
   * en S3 (`…/2026-09/unidad-999.pdf`). La Fase 2 lo prohíbe —F07-s3-antes-de-
   * confirmar, #78 de la Fase 0— y mueve la publicación a /api/facturas/confirmar
   * (ver confirmarFacturas.test.mjs). Lo demás se mantiene: pregunta por ESE
   * conjunto y lee el PDF.
   */
  test("con permiso: pregunta por ESE conjunto y lee el PDF, sin publicar nada (S3 solo al confirmar)", async () => {
    const { status, cuerpo } = await subir();
    expect(status).toBe(200);
    /* Hallazgo 2: la ruta pregunta por `facturas.destinoCarga` (por
     * `condominioId` o, como aquí, por `condominioLegacyId`), no por
     * `permisoSubida`, que solo resuelve por `legacyId`. */
    expect(consultas).toEqual([
      { nombre: "facturas:destinoCarga", args: { condominioLegacyId: "conjunto-de-prueba" } },
    ]);
    expect(cuerpo.invoices).toHaveLength(1);
    expect(cuerpo.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(subidas).toEqual([]);
  });
});

/*
 * Auditoría de facturación en Factory (2026-10-13): un archivo que no es PDF,
 * uno vacío o uno dañado respondían 500 con el mensaje interno de pdf-lib en
 * inglés ("Failed to parse PDF document (line:2 col:0 offset=59): No PDF header
 * found"), y la pantalla lo mostraba tal cual. No es un error del servidor: es
 * un archivo que no sirve, y la persona tiene que entender qué hacer.
 */
describe("archivos que no son un PDF legible: rechazo claro, sin detalles internos", () => {
  async function subirArchivo(bytes, nombre) {
    const form = new FormData();
    form.append("pdf", new File([bytes], nombre, { type: "application/pdf" }));
    form.append("condominioId", "condo-de-prueba");
    const res = await POST(new Request("http://localhost/api/facturas/upload", { method: "POST", body: form }));
    return { status: res.status, cuerpo: await res.json() };
  }

  test("un archivo vacío: 400 y lo dice", async () => {
    const { status, cuerpo } = await subirArchivo(new Uint8Array(0), "vacio.pdf");
    expect(status).toBe(400);
    expect(cuerpo.error).toBe("El archivo está vacío. Elige el PDF con las cuentas de cobro.");
    expect(subidas).toEqual([]);
  });

  test.each([
    ["un texto con extensión .pdf", new TextEncoder().encode("Esto es texto, no un PDF.\n")],
    ["un PDF cortado a la mitad", PDF.subarray(0, Math.floor(PDF.length / 2))],
  ])("%s: 422 con un mensaje que se entiende, sin el error interno del lector", async (_caso, bytes) => {
    const { status, cuerpo } = await subirArchivo(bytes, "factura.pdf");
    expect(status).toBe(422);
    expect(cuerpo.error).toBe("El archivo no es un PDF válido o está dañado. Revísalo y vuelve a subirlo.");
    expect(JSON.stringify(cuerpo)).not.toMatch(/Failed to parse|offset|line:/);
    expect(subidas).toEqual([]);
  });

  test("sin sesión, aun con un archivo dañado, primero responde 401", async () => {
    haySesion = false;
    const { status } = await subirArchivo(new TextEncoder().encode("no es un PDF"), "factura.pdf");
    expect(status).toBe(401);
  });

  /* El 422 es solo para el archivo que no se pudo abrir: un fallo al
   * interpretar el texto es del servidor y no debe pasar por "archivo dañado". */
  test("solo cuenta como PDF ilegible lo que no se pudo abrir", async () => {
    const { leerPdf, PdfIlegible } = await import("../app/api/facturas/lectura");
    await expect(leerPdf(new TextEncoder().encode("no es un PDF"))).rejects.toBeInstanceOf(PdfIlegible);
    expect((await leerPdf(new Uint8Array(PDF))).facturas).toHaveLength(1);
  });
});
