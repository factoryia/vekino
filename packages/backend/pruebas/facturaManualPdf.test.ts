import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { MENSAJE_ARCHIVO_GRANDE, MENSAJE_CONTENIDO } from "../convex/lib/subidas";
import { MENSAJE_ARCHIVO_NO_AUTORIZADO } from "../convex/model/registroArchivos";
import { MENSAJE_CARPETA } from "../convex/subidas";

/**
 * EL PDF DE UNA FACTURA MANUAL (carga unitaria) — Fase 6 de S3.
 *
 * La factura manual (`components/create-factura-form.tsx` en la web, la pestaña
 * de facturas en la app) sube su PDF por el mecanismo genérico de subidas
 * (`files.generateUploadUrl` / `uploadBytes` / `confirmarSubida`) a
 * `condominios/facturas/{conjunto}`, y `facturas.createManual` solo registra
 * una subida validada de quien la crea en esa carpeta (Fase 4). Los límites
 * son los de la categoría de esa carpeta (`pdfOImagen`, 25 MiB): por la web,
 * el PUT firmado a la zona provisional; por la app instalada, la ruta
 * intermediada (20 MiB).
 *
 * S3 simulado con los objetos de verdad (bytes, tipo); la red, bloqueada.
 */

const modules = import.meta.glob("../convex/**/*.ts");

const s3 = vi.hoisted(() => {
  const objetos = new Map<string, { bytes: Uint8Array; tipo?: string }>();
  const comandos: { nombre: string; input: Record<string, any> }[] = [];
  const firmas: { input: Record<string, any> }[] = [];
  /** Cuántas copias fallan todavía (para el reintento). */
  const fallas = { copia: 0 };
  const copia = (b: unknown) =>
    ArrayBuffer.isView(b) ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength).slice() : new Uint8Array(0);
  const error = (name: string, status: number) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
  async function enviar(c: { constructor: { name: string }; input: Record<string, any> }) {
    const nombre = c.constructor.name;
    const i = c.input;
    comandos.push({ nombre, input: i });
    switch (nombre) {
      case "PutObjectCommand":
        if (i.IfNoneMatch === "*" && objetos.has(i.Key)) throw error("PreconditionFailed", 412);
        objetos.set(i.Key, { bytes: copia(i.Body), tipo: i.ContentType });
        return {};
      case "HeadObjectCommand": {
        const o = objetos.get(i.Key);
        if (!o) throw error("NotFound", 404);
        return { ContentLength: o.bytes.byteLength, ContentType: o.tipo };
      }
      case "GetObjectCommand": {
        const o = objetos.get(i.Key);
        if (!o) throw error("NoSuchKey", 404);
        const rango = /^bytes=(\d+)-(\d+)$/.exec(i.Range ?? "");
        const parte = rango ? o.bytes.slice(Number(rango[1]), Number(rango[2]) + 1) : o.bytes.slice();
        return { Body: { transformToByteArray: async () => parte } };
      }
      case "CopyObjectCommand": {
        if (fallas.copia > 0) {
          fallas.copia--;
          throw error("InternalError", 500);
        }
        const o = objetos.get(String(i.CopySource).replace(/^vekino\//, ""));
        if (!o) throw error("NoSuchKey", 404);
        objetos.set(i.Key, { bytes: o.bytes, tipo: i.MetadataDirective === "REPLACE" ? i.ContentType : o.tipo });
        return {};
      }
      case "DeleteObjectCommand":
        objetos.delete(i.Key);
        return {};
    }
    throw new Error(`Comando de S3 inesperado: ${nombre}`);
  }
  return { objetos, comandos, firmas, fallas, enviar };
});

vi.mock("@aws-sdk/client-s3", () => {
  class Comando {
    constructor(public input: Record<string, any>) {}
  }
  return {
    S3Client: class {
      send = (c: Comando) => s3.enviar(c);
    },
    PutObjectCommand: class PutObjectCommand extends Comando {},
    HeadObjectCommand: class HeadObjectCommand extends Comando {},
    GetObjectCommand: class GetObjectCommand extends Comando {},
    CopyObjectCommand: class CopyObjectCommand extends Comando {},
    DeleteObjectCommand: class DeleteObjectCommand extends Comando {},
  };
});
vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: async (_cliente: unknown, comando: { input: Record<string, any> }) => {
    s3.firmas.push({ input: comando.input });
    return `https://vekino.s3.us-east-1.amazonaws.com/${comando.input.Key}?X-Amz-Signature=x`;
  },
}));

const SITIO = "https://vekino-pruebas.convex.site";
const MiB = 1024 * 1024;
const DIA = 24 * 60 * 60 * 1000;
const PERIODO = "2026-09";

type Quien = "adminA" | "juntaA" | "residenteA" | "adminB";

async function montar() {
  const t = convexTest(schema, modules);
  const ahora = Date.now();
  const ids = await t.run(async (ctx) => {
    const persona = (authId: Quien) =>
      ctx.db.insert("users", { name: authId, email: `${authId}@vekino.test`, emailVerified: true, active: true, authId, createdAt: ahora, updatedAt: ahora });
    const membresia = (userId: Id<"users">, condominioId: Id<"condominios">, roles: string[]) =>
      ctx.db.insert("memberships", { userId, condominioId, roles: roles as never, isActive: true, createdAt: ahora, updatedAt: ahora });
    const unidad = (condominioId: Id<"condominios">, numero: string) =>
      ctx.db.insert("unidades", { condominioId, tipo: "casa", estado: "ocupada", numero, createdAt: ahora, updatedAt: ahora });
    const condoA = await ctx.db.insert("condominios", { name: "A", activeModules: [], isActive: true, createdAt: ahora, updatedAt: ahora });
    const condoB = await ctx.db.insert("condominios", { name: "B", activeModules: [], isActive: true, createdAt: ahora, updatedAt: ahora });
    const u = {
      adminA: await persona("adminA"),
      juntaA: await persona("juntaA"),
      residenteA: await persona("residenteA"),
      adminB: await persona("adminB"),
    };
    await membresia(u.adminA, condoA, ["administrador"]);
    await membresia(u.juntaA, condoA, ["junta_directiva"]);
    await membresia(u.adminB, condoB, ["administrador"]);
    const u101 = await unidad(condoA, "101");
    const u102 = await unidad(condoA, "102");
    const u201 = await unidad(condoB, "201");
    await ctx.db.insert("usuarioUnidad", {
      membershipId: await membresia(u.residenteA, condoA, ["propietario"]),
      unidadId: u101,
      condominioId: condoA,
      vinculo: "propietario",
      esPrincipal: true,
      createdAt: ahora,
    });
    return { condoA, condoB, u101, u102, u201, ...u };
  });
  const como = (quien: Quien) => t.withIdentity({ subject: quien });
  return { t, ...ids, como };
}

type Escenario = Awaited<ReturnType<typeof montar>>;
let e: Escenario;

beforeEach(async () => {
  vi.stubEnv("AWS_S3_BUCKET_NAME", "vekino");
  vi.stubEnv("AWS_REGION", "us-east-1");
  vi.stubEnv("AWS_ACCESS_KEY_ID", "fake");
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "fake-secret");
  vi.stubEnv("CONVEX_SITE_URL", SITIO);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: unknown) => {
      throw new Error(`Red bloqueada: ${String(u)}`);
    }),
  );
  s3.objetos.clear();
  s3.comandos.length = 0;
  s3.firmas.length = 0;
  s3.fallas.copia = 0;
  e = await montar();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/* ── Archivos y lo que hacen los clientes ─────────────────────────────────── */

function conCabecera(cabecera: string, tamano = 2_048): Uint8Array {
  const inicio = [...cabecera].map((c) => c.charCodeAt(0));
  const b = new Uint8Array(Math.max(tamano, inicio.length)).fill(0x20);
  b.set(inicio);
  return b;
}
const pdf = (tamano?: number, texto = "factura manual") => conCabecera(`%PDF-1.7\n% ${texto}\n`, tamano);
const html = (tamano?: number) => conCabecera("<!DOCTYPE html><html><script>alert(1)</script>", tamano);
const buf = (b: Uint8Array) => b.slice().buffer as ArrayBuffer;
const carpeta = (c: Id<"condominios">) => `condominios/facturas/${c}`;

/** La web, con un archivo pequeño: por el servidor (`uploadBytes`). */
const porElServidor = (quien: Quien, folder: string, bytes: Uint8Array, contentType = "application/pdf") =>
  e.como(quien).action(api.files.uploadBytes, { folder, contentType, fileName: "factura.pdf", bytes: buf(bytes) });

/** La web, con un archivo grande: PUT firmado a la zona provisional y confirmación. */
async function directo(quien: Quien, folder: string, bytes: Uint8Array, contentType = "application/pdf") {
  const r = await e.como(quien).action(api.files.generateUploadUrl, { folder, contentType, fileName: "factura.pdf", size: bytes.byteLength });
  const temporal = s3.firmas.at(-1)!.input.Key as string;
  s3.objetos.set(temporal, { bytes, tipo: contentType });
  return { ...r, temporal, confirmar: () => e.como(quien).action(api.files.confirmarSubida, { key: r.key }) };
}

/** La app instalada: enlace sin tamaño y PUT a la ruta del backend. */
async function porLaApp(quien: Quien, folder: string, bytes: Uint8Array) {
  const r = await e.como(quien).action(api.files.generateUploadUrl, { folder, contentType: "application/pdf", fileName: "factura.pdf" });
  const res = await e.t.fetch(r.uploadUrl.slice(SITIO.length), { method: "PUT", headers: { "Content-Type": "application/pdf" }, body: bytes });
  return { ...r, status: res.status };
}

const crear = (quien: Quien, unidadId: Id<"unidades">, pdfUrl?: string, opciones: { condominioId?: Id<"condominios">; periodo?: string } = {}) =>
  e.como(quien).mutation(api.facturas.createManual, {
    condominioId: opciones.condominioId ?? e.condoA,
    unidadId,
    periodo: opciones.periodo ?? PERIODO,
    fechaVencimiento: Date.now() + 30 * DIA,
    valor: 300_000,
    ...(pdfUrl ? { pdfUrl } : {}),
  });

const facturas = () => e.t.run((ctx) => ctx.db.query("facturas").collect());
const puts = () => s3.comandos.filter((c) => c.nombre === "PutObjectCommand").map((c) => c.input);

async function mensajeDe(promesa: Promise<unknown>): Promise<string> {
  try {
    await promesa;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("Se esperaba un rechazo y la llamada pasó.");
}

/* ── 1–4. Tamaños y contenido ─────────────────────────────────────────────── */

describe("carga unitaria · tamaño y contenido del PDF", () => {
  test("1. PDF pequeño: por el servidor (web) y por la app instalada; la factura queda con su URL", async () => {
    const web = await porElServidor("adminA", carpeta(e.condoA), pdf());
    await crear("adminA", e.u101, web.publicUrl);
    const app = await porLaApp("juntaA", carpeta(e.condoA), pdf(4_096, "desde la app"));
    expect(app.status).toBe(200);
    await crear("juntaA", e.u102, app.publicUrl);
    expect((await facturas()).map((f) => f.pdfUrl).sort()).toEqual([web.publicUrl, app.publicUrl].sort());
  });

  test("2. PDF cerca del límite de la categoría (25 MiB − 1 KiB) por la web: se revisa, se publica y se registra", async () => {
    const grande = pdf(25 * MiB - 1024);
    const r = await directo("adminA", carpeta(e.condoA), grande);
    await r.confirmar();
    expect(s3.objetos.get(r.key)?.bytes.byteLength).toBe(25 * MiB - 1024);
    expect(s3.objetos.has(r.temporal)).toBe(false);
    await crear("adminA", e.u101, r.publicUrl);
    expect((await facturas())[0]?.pdfUrl).toBe(r.publicUrl);
  });

  test("3. por encima del límite: la web no recibe enlace (25 MiB + 1) y la app recibe 413 (más de 20 MiB); nada se publica", async () => {
    expect(
      await mensajeDe(e.como("adminA").action(api.files.generateUploadUrl, { folder: carpeta(e.condoA), contentType: "application/pdf", size: 25 * MiB + 1 })),
    ).toContain(MENSAJE_ARCHIVO_GRANDE);
    const app = await porLaApp("adminA", carpeta(e.condoA), pdf(20 * MiB + 1));
    expect(app.status).toBe(413);
    expect(puts()).toEqual([]);
    expect(s3.firmas).toEqual([]);
  });

  test("4. con extensión .pdf pero sin contenido PDF: rechazo por el servidor, por la web y por la app", async () => {
    expect(await mensajeDe(porElServidor("adminA", carpeta(e.condoA), html()))).toContain(MENSAJE_CONTENIDO);
    const r = await directo("adminA", carpeta(e.condoA), html(8_192));
    expect(await mensajeDe(r.confirmar())).toContain(MENSAJE_CONTENIDO);
    expect(s3.objetos.has(r.key)).toBe(false);
    expect(s3.objetos.has(r.temporal)).toBe(false);
    expect((await porLaApp("adminA", carpeta(e.condoA), html(4_096))).status).toBe(415);
    expect(await mensajeDe(crear("adminA", e.u101, r.publicUrl))).toContain(MENSAJE_ARCHIVO_NO_AUTORIZADO);
    expect(await facturas()).toEqual([]);
  });
});

/* ── 5–6. Permisos y correspondencia ──────────────────────────────────────── */

describe("carga unitaria · quién sube y a qué factura va", () => {
  test("5. sin sesión, sin el rol (residente) o sobre otro conjunto: ni enlace ni factura", async () => {
    await expect(e.t.action(api.files.generateUploadUrl, { folder: carpeta(e.condoA), contentType: "application/pdf" })).rejects.toThrow();
    for (const [quien, c] of [["residenteA", e.condoA], ["adminB", e.condoA], ["adminA", e.condoB]] as const) {
      expect(
        await mensajeDe(e.como(quien).action(api.files.generateUploadUrl, { folder: carpeta(c), contentType: "application/pdf" })),
        `${quien} → ${c}`,
      ).toContain(MENSAJE_CARPETA);
    }
    const deB = await porElServidor("adminB", carpeta(e.condoB), pdf());
    expect(await mensajeDe(crear("adminA", e.u101, deB.publicUrl))).toContain(MENSAJE_ARCHIVO_NO_AUTORIZADO);
    await expect(crear("residenteA", e.u101)).rejects.toThrow();
    expect(await facturas()).toEqual([]);
  });

  test("6. el PDF de una factura no se usa en otra unidad ni en otro período", async () => {
    const r = await porElServidor("adminA", carpeta(e.condoA), pdf());
    await crear("adminA", e.u101, r.publicUrl);
    expect(await mensajeDe(crear("adminA", e.u102, r.publicUrl))).toContain(MENSAJE_ARCHIVO_NO_AUTORIZADO);
    expect(await mensajeDe(crear("adminA", e.u101, r.publicUrl, { periodo: "2026-10" }))).toContain(MENSAJE_ARCHIVO_NO_AUTORIZADO);
    expect(await facturas()).toHaveLength(1);
  });
});

/* ── 7–8. Fallos y sobrescritura ──────────────────────────────────────────── */

describe("carga unitaria · fallos y sobrescritura", () => {
  test("7. si falla la publicación (la copia en S3), la subida sigue pendiente y el reintento la completa", async () => {
    const r = await directo("adminA", carpeta(e.condoA), pdf(5 * MiB));
    s3.fallas.copia = 1;
    await expect(r.confirmar()).rejects.toThrow();
    expect(s3.objetos.has(r.key)).toBe(false);
    expect(s3.objetos.has(r.temporal)).toBe(true);
    expect(await mensajeDe(crear("adminA", e.u101, r.publicUrl))).toContain(MENSAJE_ARCHIVO_NO_AUTORIZADO);
    await r.confirmar();
    await crear("adminA", e.u101, r.publicUrl);
    expect((await facturas())[0]?.pdfUrl).toBe(r.publicUrl);
  });

  test("8. no se sobrescribe: cada subida tiene su llave del servidor, toda escritura es condicional y una factura existente no se reemplaza a mano", async () => {
    const una = await porElServidor("adminA", carpeta(e.condoA), pdf(2_048, "una"));
    const otra = await porElServidor("adminA", carpeta(e.condoA), pdf(2_048, "otra"));
    expect(una.key).not.toBe(otra.key);
    expect(puts().every((p) => p.IfNoneMatch === "*")).toBe(true);
    await crear("adminA", e.u101, una.publicUrl);
    expect(await mensajeDe(crear("adminA", e.u101, otra.publicUrl))).toContain("Ya existe una factura para esta unidad en ese período.");
    expect((await facturas())[0]?.pdfUrl).toBe(una.publicUrl);
  });
});
