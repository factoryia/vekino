import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import {
  MENSAJE_ARCHIVO_GRANDE,
  MENSAJE_CONTENIDO,
  MENSAJE_SUBIDA_NO_VALIDA,
  MENSAJE_TIPO_NO_PERMITIDO,
} from "../convex/lib/subidas";
import { MENSAJE_ARCHIVO_NO_AUTORIZADO } from "../convex/model/registroArchivos";

/**
 * EL CONTENIDO REAL DE LAS SUBIDAS DIRECTAS — Fase 4 de S3 (residuo de H-06).
 *
 * La web actual sube con una URL firmada (`generateUploadUrl` con `size`).
 * Firmar el tipo y el tamaño no prueba qué bytes llegan: un HTML con
 * `Content-Type: application/pdf` pasaba la firma y quedaba publicado. Ahora
 * el PUT va a una llave temporal (`pendientes/…`) y `files.confirmarSubida`
 * lo revisa leyendo el OBJETO —su tamaño con `HeadObject`, su primer KB con
 * un `GetObject` por rango— antes de copiarlo, dentro de S3, a su llave
 * definitiva con el tipo que dicen sus bytes. Solo entonces la subida queda
 * validada y una entidad la puede registrar.
 *
 * S3 simulado con los objetos de verdad (bytes, tipo, disposición): el PUT
 * del navegador se simula escribiendo en la llave firmada. Que S3 rechace un
 * PUT con otro tipo u otro tamaño que los firmados es de AWS y aquí no se
 * prueba (ver `firmaSubida.test.ts` para lo que sí se firma).
 */

const modules = import.meta.glob("../convex/**/*.ts");

type Objeto = { bytes: Uint8Array; tipo?: string; disposicion?: string };

const s3 = vi.hoisted(() => {
  const objetos = new Map<string, Objeto>();
  const comandos: { nombre: string; input: Record<string, any> }[] = [];
  const firmas: { input: Record<string, any>; opciones: any }[] = [];
  /** Bytes leídos por los `GetObject` (para ver que no se baja el archivo). */
  const leidos: number[] = [];
  const copia = (b: unknown) =>
    ArrayBuffer.isView(b) ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength).slice() : new Uint8Array(0);
  const error = (name: string) => Object.assign(new Error(name), { name });
  async function enviar(c: { constructor: { name: string }; input: Record<string, any> }) {
    const nombre = c.constructor.name;
    const i = c.input;
    comandos.push({ nombre, input: i });
    switch (nombre) {
      case "PutObjectCommand":
        if (i.IfNoneMatch === "*" && objetos.has(i.Key)) throw error("PreconditionFailed");
        objetos.set(i.Key, { bytes: copia(i.Body), tipo: i.ContentType, disposicion: i.ContentDisposition });
        return {};
      case "HeadObjectCommand": {
        const o = objetos.get(i.Key);
        if (!o) throw error("NotFound");
        return { ContentLength: o.bytes.byteLength, ContentType: o.tipo };
      }
      case "GetObjectCommand": {
        const o = objetos.get(i.Key);
        if (!o) throw error("NoSuchKey");
        const rango = /^bytes=(\d+)-(\d+)$/.exec(i.Range ?? "");
        const parte = rango ? o.bytes.slice(Number(rango[1]), Number(rango[2]) + 1) : o.bytes.slice();
        leidos.push(parte.byteLength);
        return { ContentType: o.tipo, Body: { transformToByteArray: async () => parte } };
      }
      case "CopyObjectCommand": {
        const o = objetos.get(String(i.CopySource).replace(/^vekino\//, ""));
        if (!o) throw error("NoSuchKey");
        const reemplazar = i.MetadataDirective === "REPLACE";
        objetos.set(i.Key, {
          bytes: o.bytes,
          tipo: reemplazar ? i.ContentType : o.tipo,
          disposicion: reemplazar ? i.ContentDisposition : o.disposicion,
        });
        return {};
      }
      case "DeleteObjectCommand":
        objetos.delete(i.Key);
        return {};
    }
    throw new Error(`Comando de S3 inesperado: ${nombre}`);
  }
  return { objetos, comandos, firmas, leidos, enviar };
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
  getSignedUrl: async (_cliente: unknown, comando: { input: Record<string, any> }, opciones: unknown) => {
    s3.firmas.push({ input: comando.input, opciones });
    return `https://vekino.s3.us-east-1.amazonaws.com/${comando.input.Key}?X-Amz-Signature=x`;
  },
}));

const SITIO = "https://vekino-pruebas.convex.site";
const MiB = 1024 * 1024;

type Quien = "adminA" | "adminB" | "residenteA" | "residenteB" | "guardaA";

async function montar() {
  const t = convexTest(schema, modules);
  const ahora = Date.now();
  const ids = await t.run(async (ctx) => {
    const conjunto = (name: string) =>
      ctx.db.insert("condominios", { name, activeModules: [], isActive: true, createdAt: ahora, updatedAt: ahora });
    const persona = (authId: Quien) =>
      ctx.db.insert("users", {
        name: authId,
        email: `${authId}@vekino.test`,
        emailVerified: true,
        active: true,
        authId,
        createdAt: ahora,
        updatedAt: ahora,
      });
    const membresia = (userId: Id<"users">, condominioId: Id<"condominios">, roles: string[]) =>
      ctx.db.insert("memberships", { userId, condominioId, roles: roles as never, isActive: true, createdAt: ahora, updatedAt: ahora });
    const casa = async (membershipId: Id<"memberships">, condominioId: Id<"condominios">, numero: string) => {
      const unidadId = await ctx.db.insert("unidades", {
        condominioId,
        tipo: "casa",
        estado: "ocupada",
        numero,
        createdAt: ahora,
        updatedAt: ahora,
      });
      await ctx.db.insert("usuarioUnidad", { membershipId, unidadId, condominioId, vinculo: "propietario", esPrincipal: true, createdAt: ahora });
    };

    const condoA = await conjunto("A");
    const condoB = await conjunto("B");
    const u = {
      adminA: await persona("adminA"),
      adminB: await persona("adminB"),
      residenteA: await persona("residenteA"),
      residenteB: await persona("residenteB"),
      guardaA: await persona("guardaA"),
    };
    await membresia(u.adminA, condoA, ["administrador"]);
    await membresia(u.adminB, condoB, ["administrador"]);
    await membresia(u.guardaA, condoA, ["guardia"]);
    await casa(await membresia(u.residenteA, condoA, ["propietario"]), condoA, "101");
    await casa(await membresia(u.residenteB, condoB, ["propietario"]), condoB, "201");
    const asambleaA = await ctx.db.insert("asambleas", {
      condominioId: condoA,
      titulo: "Ordinaria",
      tipo: "ordinaria",
      modalidad: "virtual",
      fecha: "2026-11-01",
      hora: "18:00",
      estado: "en_curso",
      agenda: [],
      createdAt: ahora,
      updatedAt: ahora,
    });
    return { condoA, condoB, asambleaA, ...u };
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
  s3.leidos.length = 0;
  e = await montar();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/* ── Archivos de prueba, por sus primeros bytes ───────────────────────────── */

function conCabecera(cabecera: number[] | string, tamano = 2_048): Uint8Array {
  const inicio = typeof cabecera === "string" ? [...cabecera].map((c) => c.charCodeAt(0)) : cabecera;
  const b = new Uint8Array(tamano).fill(0x20);
  b.set(inicio.slice(0, tamano));
  return b;
}
const ftyp = (marca: string) => [0, 0, 0, 0x18, ...[..."ftyp", ...marca].map((c) => c.charCodeAt(0))];
const jpeg = (n?: number) => conCabecera([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46], n);
const pdf = (n?: number) => conCabecera("%PDF-1.7\n", n);
const heic = (n?: number) => conCabecera(ftyp("heic"), n);
const heif = (n?: number) => conCabecera(ftyp("mif1"), n);
const webm = (n?: number) => conCabecera([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81], n);
const csv = (n?: number) => conCabecera("casa;valor\n101;300000\n102;280000\n", n);
const html = (n?: number) => conCabecera("<!DOCTYPE html><html><script>alert(document.cookie)</script>", n);
const svg = (n?: number) => conCabecera('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', n);

/* ── Lo que hacen los clientes ────────────────────────────────────────────── */

const carpetaDocs = () => `condominios/documentos/${e.condoA}`;

/** La web nueva: pide la URL firmada con el tamaño. Devuelve también la llave firmada. */
async function pedirDirecto(quien: Quien, folder: string, contentType: string, size: number, fileName = "archivo") {
  const r = await e.como(quien).action(api.files.generateUploadUrl, { folder, contentType, fileName, size });
  const temporal = s3.firmas.at(-1)!.input.Key as string;
  return { ...r, temporal };
}

/** El PUT del navegador a la URL firmada: llega a la llave temporal con lo que mande. */
function putDelNavegador(temporal: string, bytes: Uint8Array, contentType: string) {
  s3.objetos.set(temporal, { bytes, tipo: contentType });
}

const confirmar = (quien: Quien, key: string) => e.como(quien).action(api.files.confirmarSubida, { key });

/** Subida directa completa: pedir, PUT y confirmar. */
async function subirDirecto(quien: Quien, folder: string, contentType: string, bytes: Uint8Array, fileName?: string) {
  const r = await pedirDirecto(quien, folder, contentType, bytes.byteLength, fileName);
  putDelNavegador(r.temporal, bytes, contentType);
  const confirmado = await confirmar(quien, r.key);
  return { ...r, confirmado };
}

/** Una app instalada: pide sin tamaño y hace PUT a la ruta del backend. */
async function subirComoLaApp(quien: Quien, folder: string, contentType: string, bytes: Uint8Array) {
  const r = await e.como(quien).action(api.files.generateUploadUrl, { folder, contentType, fileName: "foto" });
  const respuesta = await e.t.fetch(r.uploadUrl.slice(SITIO.length), {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: bytes,
  });
  return { ...r, status: respuesta.status };
}

const fila = (key: string) =>
  e.t.run((ctx) => ctx.db.query("subidasPendientes").withIndex("by_key", (q) => q.eq("key", key)).first());
const de = (nombre: string) => s3.comandos.filter((c) => c.nombre === nombre).map((c) => c.input);
const documentos = () => e.t.run((ctx) => ctx.db.query("documentos").collect());

async function mensajeDe(promesa: Promise<unknown>): Promise<string> {
  try {
    await promesa;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("Se esperaba un rechazo y la llamada pasó.");
}

const crearDocumento = (quien: Quien, condominioId: Id<"condominios">, r: { key: string; publicUrl: string }) =>
  e.como(quien).mutation(api.documentos.create, {
    condominioId,
    nombre: "Reglamento",
    categoria: "reglamento",
    url: r.publicUrl,
    s3Key: r.key,
    mimeType: "application/pdf",
    tamanio: 10,
  });

/** Nada quedó publicado ni pendiente de esa subida, y no se puede registrar. */
async function nadaPublicado(r: { key: string; temporal: string; publicUrl: string }) {
  expect(s3.objetos.has(r.key)).toBe(false);
  expect(s3.objetos.has(r.temporal)).toBe(false);
  expect(await fila(r.key)).toBeNull();
}

/* ── 1. Bytes que no son del tipo declarado ───────────────────────────────── */

describe("1. Un MIME permitido con bytes de otro tipo no se publica", () => {
  test("un HTML subido como application/pdf: se rechaza al confirmar, se borra y no se puede registrar", async () => {
    const r = await pedirDirecto("adminA", carpetaDocs(), "application/pdf", 2_048, "acta.pdf");
    putDelNavegador(r.temporal, html(2_048), "application/pdf");

    expect(await mensajeDe(confirmar("adminA", r.key))).toContain(MENSAJE_CONTENIDO);
    expect(de("CopyObjectCommand")).toEqual([]);
    await nadaPublicado(r);
    expect(await mensajeDe(crearDocumento("adminA", e.condoA, r))).toContain(MENSAJE_ARCHIVO_NO_AUTORIZADO);
    expect(await documentos()).toEqual([]);
  });

  test("un PDF subido como foto de perfil (image/jpeg): se rechaza; el avatar no cambia", async () => {
    const r = await pedirDirecto("residenteA", "avatars", "image/jpeg", 2_048, "yo.jpg");
    putDelNavegador(r.temporal, pdf(2_048), "image/jpeg");

    expect(await mensajeDe(confirmar("residenteA", r.key))).toContain(MENSAJE_CONTENIDO);
    await nadaPublicado(r);
    expect(
      await mensajeDe(e.como("residenteA").mutation(api.users.setMyAvatar, { url: r.publicUrl, s3Key: r.key })),
    ).toContain(MENSAJE_ARCHIVO_NO_AUTORIZADO);
    expect((await e.t.run((ctx) => ctx.db.get(e.residenteA)))!.image).toBeUndefined();
  });

  test("sin confirmar, aunque el PUT haya llegado, la llave definitiva no existe y no se registra", async () => {
    const r = await pedirDirecto("adminA", carpetaDocs(), "application/pdf", 2_048);
    putDelNavegador(r.temporal, pdf(2_048), "application/pdf");

    expect(s3.objetos.has(r.key)).toBe(false);
    expect(await fila(r.key)).toMatchObject({ estado: "pendiente", modo: "directo" });
    expect(await mensajeDe(crearDocumento("adminA", e.condoA, r))).toContain(MENSAJE_ARCHIVO_NO_AUTORIZADO);
  });
});

/* ── 2. Lo que decide es el objeto ────────────────────────────────────────── */

describe("2. La validación sale del objeto, no de lo que diga el cliente", () => {
  test("confirmar recibe solo la llave: un tipo o un tamaño del cliente no se aceptan", async () => {
    const r = await pedirDirecto("adminA", carpetaDocs(), "application/pdf", 2_048);
    putDelNavegador(r.temporal, html(2_048), "application/pdf");
    const conDatos = { key: r.key, tipo: "application/pdf", size: 2_048 } as unknown as { key: string };
    await expect(e.como("adminA").action(api.files.confirmarSubida, conDatos)).rejects.toThrow();
    expect(de("CopyObjectCommand")).toEqual([]);
    expect(await fila(r.key)).toMatchObject({ estado: "pendiente" });
  });

  test("declarado PDF y llegó un JPEG: se publica como image/jpeg; el Content-Type del PUT no cuenta", async () => {
    const r = await subirDirecto("adminA", carpetaDocs(), "application/pdf", jpeg(3_000), "foto.pdf");

    const [copia] = de("CopyObjectCommand");
    expect(copia).toMatchObject({
      Bucket: "vekino",
      Key: r.key,
      CopySource: `vekino/${r.temporal}`,
      MetadataDirective: "REPLACE",
      ContentType: "image/jpeg",
    });
    expect(s3.objetos.get(r.key)).toMatchObject({ tipo: "image/jpeg" });
    expect(s3.objetos.has(r.temporal)).toBe(false);
    expect(await fila(r.key)).toMatchObject({ estado: "validada", tipo: "image/jpeg", bytes: 3_000 });
    expect(r.confirmado).toEqual({ key: r.key, publicUrl: r.publicUrl });
  });

  test("el tamaño se lee con HeadObject y la cabecera con un rango, los dos de la llave temporal", async () => {
    const r = await subirDirecto("adminA", carpetaDocs(), "application/pdf", pdf(5_000));
    expect(de("HeadObjectCommand")).toEqual([{ Bucket: "vekino", Key: r.temporal }]);
    expect(de("GetObjectCommand")).toEqual([{ Bucket: "vekino", Key: r.temporal, Range: "bytes=0-1023" }]);
    expect(await fila(r.key)).toMatchObject({ estado: "validada", tipo: "application/pdf", bytes: 5_000 });
  });
});

/* ── 3. Tamaño ────────────────────────────────────────────────────────────── */

describe("3. Un objeto fuera del tamaño autorizado no se acepta", () => {
  test("más grande que lo firmado: se rechaza y se borra", async () => {
    const r = await pedirDirecto("adminA", carpetaDocs(), "application/pdf", 2_048);
    putDelNavegador(r.temporal, pdf(4_096), "application/pdf");
    expect(await mensajeDe(confirmar("adminA", r.key))).toContain(MENSAJE_ARCHIVO_GRANDE);
    await nadaPublicado(r);
  });

  test("más pequeño que lo firmado (incompleto): se rechaza y se borra", async () => {
    const r = await pedirDirecto("adminA", carpetaDocs(), "application/pdf", 4_096);
    putDelNavegador(r.temporal, pdf(1_000), "application/pdf");
    expect(await mensajeDe(confirmar("adminA", r.key))).toContain(MENSAJE_ARCHIVO_GRANDE);
    await nadaPublicado(r);
  });

  test("por encima del máximo de su categoría ni se firma", async () => {
    expect(await mensajeDe(pedirDirecto("adminA", carpetaDocs(), "application/pdf", 25 * MiB + 1))).toContain(
      MENSAJE_ARCHIVO_GRANDE,
    );
    expect(s3.firmas).toEqual([]);
  });

  test("si el objeto todavía no llegó, se puede reintentar: no se descarta", async () => {
    const r = await pedirDirecto("adminA", carpetaDocs(), "application/pdf", 2_048);
    expect(await mensajeDe(confirmar("adminA", r.key))).toContain("El archivo no llegó");
    expect(await fila(r.key)).toMatchObject({ estado: "pendiente" });
    putDelNavegador(r.temporal, pdf(2_048), "application/pdf");
    await confirmar("adminA", r.key);
    expect(await fila(r.key)).toMatchObject({ estado: "validada" });
  });
});

/* ── 4. Vencidas, llaves equivocadas y reuso ──────────────────────────────── */

describe("4. Vencidas, llaves equivocadas y confirmaciones repetidas se rechazan", () => {
  test("pasados los 20 minutos no se confirma; la siguiente subida limpia lo que quedó en pendientes/", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const r = await pedirDirecto("adminA", carpetaDocs(), "application/pdf", 2_048);
    putDelNavegador(r.temporal, pdf(2_048), "application/pdf");
    vi.setSystemTime(Date.now() + 21 * 60 * 1000);

    expect(await mensajeDe(confirmar("adminA", r.key))).toContain(MENSAJE_SUBIDA_NO_VALIDA);
    expect(de("CopyObjectCommand")).toEqual([]);
    expect(s3.objetos.has(r.key)).toBe(false);

    await pedirDirecto("adminA", carpetaDocs(), "application/pdf", 2_048);
    await new Promise((listo) => setTimeout(listo, 10));
    await e.t.finishInProgressScheduledFunctions();
    expect(s3.objetos.has(r.temporal)).toBe(false);
    expect(await fila(r.key)).toBeNull();
  });

  test("la llave de otra persona, la temporal o una inventada no se confirman; la ajena sigue intacta", async () => {
    const r = await pedirDirecto("residenteA", `condominios/soportes/${e.condoA}`, "image/jpeg", 2_048);
    putDelNavegador(r.temporal, jpeg(2_048), "image/jpeg");

    for (const [quien, key] of [
      ["adminA", r.key],
      ["residenteB", r.key],
      ["residenteA", r.temporal],
      ["residenteA", `${r.key}x`],
      ["residenteA", r.key.replace(String(e.condoA), String(e.condoB))],
    ] as const) {
      expect(await mensajeDe(confirmar(quien, key)), `${quien} ${key}`).toContain(MENSAJE_SUBIDA_NO_VALIDA);
    }
    await expect(e.t.action(api.files.confirmarSubida, { key: r.key })).rejects.toThrow();
    expect(de("HeadObjectCommand")).toEqual([]);
    expect(s3.objetos.has(r.temporal)).toBe(true);

    await confirmar("residenteA", r.key);
    expect(await fila(r.key)).toMatchObject({ estado: "validada", userId: e.residenteA });
  });

  test("confirmar dos veces: la segunda no vuelve a leer ni a publicar", async () => {
    const r = await subirDirecto("adminA", carpetaDocs(), "application/pdf", pdf());
    expect(await mensajeDe(confirmar("adminA", r.key))).toContain(MENSAJE_SUBIDA_NO_VALIDA);
    expect(de("CopyObjectCommand")).toHaveLength(1);
    expect(de("HeadObjectCommand")).toHaveLength(1);
  });

  test("validada, se registra dentro de las 24 horas; después, no", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const r = await subirDirecto("adminA", carpetaDocs(), "application/pdf", pdf());
    vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000 + 1);
    expect(await mensajeDe(crearDocumento("adminA", e.condoA, r))).toContain(MENSAJE_ARCHIVO_NO_AUTORIZADO);
    expect(await documentos()).toEqual([]);
  });
});

/* ── 5. Formatos legítimos ────────────────────────────────────────────────── */

describe("5. HEIC/HEIF, PDF, CSV y WebM siguen funcionando con las reglas de cada uso", () => {
  test("foto HEIC y HEIF del comprobante, por la web (directa) y por la app (intermediada), y crearMio las registra", async () => {
    const soportes = `condominios/soportes/${e.condoA}`;
    const web = await subirDirecto("residenteA", soportes, "image/heic", heic(3_000), "IMG_0001.HEIC");
    expect(s3.objetos.get(web.key)).toMatchObject({ tipo: "image/heic" });
    const heifWeb = await subirDirecto("residenteA", soportes, "image/heif", heif(3_000), "IMG_0002.HEIF");
    expect(s3.objetos.get(heifWeb.key)).toMatchObject({ tipo: "image/heif" });
    const app = await subirComoLaApp("residenteA", soportes, "image/heic", heic(3_000));
    expect(app.status).toBe(200);
    expect(await fila(app.key)).toMatchObject({ estado: "validada", modo: "intermediado", tipo: "image/heic" });

    for (const subida of [web, heifWeb]) {
      const id = await e.como("residenteA").mutation(api.soportesPago.crearMio, {
        condominioId: e.condoA,
        url: subida.publicUrl,
        mimeType: "image/heic",
      });
      await e.t.run((ctx) => ctx.db.patch(id, { estado: "rechazado" }));
    }
    await e.como("residenteA").mutation(api.soportesPago.crearMio, {
      condominioId: e.condoA,
      url: app.publicUrl,
      mimeType: "image/heic",
    });
    expect(await e.t.run((ctx) => ctx.db.query("soportesPago").collect())).toHaveLength(3);
  });

  test("PDF en documentos: se publica como PDF y se registra", async () => {
    const r = await subirDirecto("adminA", carpetaDocs(), "application/pdf", pdf(10_000), "Reglamento.pdf");
    expect(s3.objetos.get(r.key)).toMatchObject({ tipo: "application/pdf" });
    expect(s3.objetos.get(r.key)!.disposicion).toBeUndefined();
    await crearDocumento("adminA", e.condoA, r);
    expect(await documentos()).toHaveLength(1);
  });

  test("CSV en documentos: text/csv queda así; el de Excel en Windows (application/vnd.ms-excel) queda como texto", async () => {
    const csvWeb = await subirDirecto("adminA", carpetaDocs(), "text/csv", csv(), "cartera.csv");
    expect(s3.objetos.get(csvWeb.key)).toMatchObject({ tipo: "text/csv" });
    const deExcel = await subirDirecto("adminA", carpetaDocs(), "application/vnd.ms-excel", csv(), "cartera.csv");
    expect(s3.objetos.get(deExcel.key)).toMatchObject({ tipo: "text/plain" });
  });

  test("grabación: una parte de ~20 MiB y un reintento de 40 MiB se confirman; 50 MiB + 1 ni se firma", async () => {
    const carpeta = `asambleas/${e.asambleaA}/grabacion`;
    for (const [orden, tamano] of [[0, 20 * MiB - 4_096], [1, 40 * MiB]] as const) {
      const r = await subirDirecto("adminA", carpeta, "video/webm", webm(tamano), `parte-${orden}.webm`);
      expect(s3.objetos.get(r.key)).toMatchObject({ tipo: "video/webm" });
      await e.como("adminA").mutation(api.salaBitacora.anotarParteGrabacion, {
        asambleaId: e.asambleaA,
        sesionGrabacion: "s1",
        orden,
        url: r.publicUrl,
        bytes: tamano,
      });
    }
    expect(await e.t.run((ctx) => ctx.db.query("salaGrabacionPartes").collect())).toHaveLength(2);
    expect(await mensajeDe(pedirDirecto("adminA", carpeta, "video/webm", 50 * MiB + 1))).toContain(MENSAJE_ARCHIVO_GRANDE);
  });
});

/* ── 6. SVG ───────────────────────────────────────────────────────────────── */

describe("6. SVG sigue sin servirse como página", () => {
  test("por URL firmada no se pide un SVG, ni para los íconos del consejo", async () => {
    const iconos = `condominios/${e.condoA}/consejo/icons`;
    expect(await mensajeDe(pedirDirecto("adminA", iconos, "image/svg+xml", 500))).toContain(MENSAJE_TIPO_NO_PERMITIDO);
    expect(s3.firmas).toEqual([]);
  });

  test("un SVG disfrazado de PNG (íconos) o de texto (documentos) no se publica", async () => {
    const comoPng = await pedirDirecto("adminA", `condominios/${e.condoA}/consejo/icons`, "image/png", 2_048);
    putDelNavegador(comoPng.temporal, svg(2_048), "image/png");
    expect(await mensajeDe(confirmar("adminA", comoPng.key))).toContain(MENSAJE_CONTENIDO);
    await nadaPublicado(comoPng);

    const comoTexto = await pedirDirecto("adminA", carpetaDocs(), "text/plain", 2_048);
    putDelNavegador(comoTexto.temporal, svg(2_048), "text/plain");
    expect(await mensajeDe(confirmar("adminA", comoTexto.key))).toContain(MENSAJE_CONTENIDO);
    await nadaPublicado(comoTexto);
  });

  test("el ícono SVG por el servidor se guarda para descargar (attachment) y se registra en su categoría", async () => {
    const iconos = `condominios/${e.condoA}/consejo/icons`;
    const r = await e.como("adminA").action(api.files.uploadBytes, {
      folder: iconos,
      contentType: "image/svg+xml",
      fileName: "icono.svg",
      bytes: svg(400).buffer as ArrayBuffer,
    });
    expect(s3.objetos.get(r.key)).toMatchObject({ tipo: "image/svg+xml", disposicion: "attachment" });
    await e.como("adminA").mutation(api.consejo.createCategoria, {
      condominioId: e.condoA,
      nombre: "Actas",
      iconType: "image",
      iconValue: r.publicUrl,
    });
  });
});

/* ── 7. Memoria ───────────────────────────────────────────────────────────── */

describe("7. Validar no baja el archivo: memoria acotada", () => {
  test("una parte de 40 MiB se confirma leyendo 1 KB y copiándola dentro de S3", async () => {
    const r = await subirDirecto("adminA", `asambleas/${e.asambleaA}/grabacion`, "video/webm", webm(40 * MiB));
    expect(de("GetObjectCommand").every((g) => g.Range === "bytes=0-1023")).toBe(true);
    expect(Math.max(...s3.leidos)).toBeLessThanOrEqual(1_024);
    expect(de("PutObjectCommand")).toEqual([]);
    expect(de("CopyObjectCommand")).toHaveLength(1);
    expect(await e.t.run((ctx) => ctx.db.system.query("_storage").collect())).toEqual([]);
    expect(s3.objetos.get(r.key)!.bytes.byteLength).toBe(40 * MiB);
  });

  test("por la ruta del backend el techo sigue en 20 MiB, y lo que la pasa no llega a S3", async () => {
    const r = await e.como("guardaA").action(api.files.generateUploadUrl, {
      folder: `condominios/guardia/${e.condoA}/paquetes`,
      contentType: "image/jpeg",
    });
    const grande = new Uint8Array(20 * MiB + 1);
    grande.set(jpeg(16));
    const respuesta = await e.t.fetch(r.uploadUrl.slice(SITIO.length), {
      method: "PUT",
      headers: { "Content-Type": "image/jpeg" },
      body: grande,
    });
    expect(respuesta.status).toBe(413);
    expect(de("PutObjectCommand")).toEqual([]);
    expect(await fila(r.key)).toBeNull();
  });
});
