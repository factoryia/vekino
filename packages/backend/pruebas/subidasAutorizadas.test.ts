import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { MENSAJE_CARPETA } from "../convex/subidas";
import {
  MENSAJE_ARCHIVO_GRANDE,
  MENSAJE_CONTENIDO,
  MENSAJE_TIPO_NO_PERMITIDO,
} from "../convex/lib/subidas";

/**
 * SUBIDAS A S3 AUTORIZADAS — Fase 3 (H-06 de la auditoría de S3,
 * qa/factory/auditoria-s3-2026-10-14).
 *
 *   - La carpeta tiene que ser de un uso conocido y de un conjunto o entidad
 *     donde quien sube tiene el permiso de registrar ese archivo.
 *   - Cada uso tiene tipos permitidos y tamaño máximo; el tipo se comprueba
 *     por los bytes cuando el servidor los ve.
 *   - Con `size` (web actual): URL firmada con tipo y tamaño exactos.
 *   - Sin `size` (apps instaladas): la URL es la ruta `/archivos/subida`, de
 *     un solo uso, que revisa tamaño y contenido antes de escribir.
 *
 * Dos conjuntos (A y B). S3, el firmador y la red, simulados: se mira qué
 * llega a S3 y qué queda pendiente.
 */

const modules = import.meta.glob("../convex/**/*.ts");

const aws = vi.hoisted(() => ({ send: vi.fn(), firmas: [] as { input: any; opciones: any }[] }));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    send = aws.send;
  },
  PutObjectCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
  DeleteObjectCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}));
vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: async (_cliente: unknown, comando: { input: unknown }, opciones: unknown) => {
    aws.firmas.push({ input: comando.input, opciones });
    return "https://vekino.s3.us-east-1.amazonaws.com/firmada?X-Amz-Signature=x";
  },
}));

const SITIO = "https://vekino-pruebas.convex.site";
const MiB = 1024 * 1024;

type Quien =
  | "adminA" | "adminB" | "contadoraA" | "guardaA" | "residenteA" | "residenteB" | "sinCasaA" | "plataforma";

async function montar() {
  const t = convexTest(schema, modules);
  const ahora = Date.now();
  const ids = await t.run(async (ctx) => {
    const conjunto = (name: string) =>
      ctx.db.insert("condominios", { name, activeModules: [], isActive: true, createdAt: ahora, updatedAt: ahora });
    const persona = (authId: Quien, platformRole?: "admin") =>
      ctx.db.insert("users", {
        name: authId,
        email: `${authId}@vekino.test`,
        emailVerified: true,
        active: true,
        authId,
        ...(platformRole ? { platformRole } : {}),
        createdAt: ahora,
        updatedAt: ahora,
      });
    const membresia = (userId: Id<"users">, condominioId: Id<"condominios">, roles: string[]) =>
      ctx.db.insert("memberships", { userId, condominioId, roles: roles as never, isActive: true, createdAt: ahora, updatedAt: ahora });
    const unidad = (condominioId: Id<"condominios">, numero: string) =>
      ctx.db.insert("unidades", { condominioId, tipo: "casa", estado: "ocupada", numero, createdAt: ahora, updatedAt: ahora });
    const vincular = (membershipId: Id<"memberships">, unidadId: Id<"unidades">, condominioId: Id<"condominios">) =>
      ctx.db.insert("usuarioUnidad", { membershipId, unidadId, condominioId, vinculo: "propietario", esPrincipal: true, createdAt: ahora });

    const condoA = await conjunto("A");
    const condoB = await conjunto("B");
    const unidadA = await unidad(condoA, "101");
    const unidadB = await unidad(condoB, "201");
    const u = {
      adminA: await persona("adminA"),
      adminB: await persona("adminB"),
      contadoraA: await persona("contadoraA"),
      guardaA: await persona("guardaA"),
      residenteA: await persona("residenteA"),
      residenteB: await persona("residenteB"),
      sinCasaA: await persona("sinCasaA"),
      plataforma: await persona("plataforma", "admin"),
    };
    await membresia(u.adminA, condoA, ["administrador"]);
    await membresia(u.adminB, condoB, ["administrador"]);
    await membresia(u.contadoraA, condoA, ["contadora"]);
    await membresia(u.guardaA, condoA, ["guardia"]);
    await membresia(u.sinCasaA, condoA, ["propietario"]);
    await vincular(await membresia(u.residenteA, condoA, ["propietario"]), unidadA, condoA);
    await vincular(await membresia(u.residenteB, condoB, ["propietario"]), unidadB, condoB);
    const companiaA = await ctx.db.insert("companiasSeguridad", { nombre: "Seguridad A", estado: "activa", createdAt: ahora, updatedAt: ahora });
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
    return { condoA, condoB, companiaA, asambleaA, ...u };
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
  aws.send.mockReset().mockImplementation(async () => ({}));
  aws.firmas.length = 0;
  e = await montar();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/* ── Archivos de prueba, por sus primeros bytes ───────────────────────────── */

function conCabecera(cabecera: number[] | string, tamano = 2_048): ArrayBuffer {
  const inicio = typeof cabecera === "string" ? [...cabecera].map((c) => c.charCodeAt(0)) : cabecera;
  const b = new Uint8Array(tamano).fill(0x20);
  b.set(inicio.slice(0, tamano));
  return b.buffer;
}
const jpeg = (n?: number) => conCabecera([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46], n);
const pdf = (n?: number) => conCabecera("%PDF-1.7\n", n);
const heic = (n?: number) => conCabecera([0, 0, 0, 0x18, ...[..."ftypheic"].map((c) => c.charCodeAt(0))], n);
const webm = (n?: number) => conCabecera([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81], n);
const ogg = (n?: number) => conCabecera("OggS\0\x02", n);
const zip = (n?: number) => conCabecera([0x50, 0x4b, 0x03, 0x04], n);
const html = (n?: number) => conCabecera("<!DOCTYPE html><html><script>alert(1)</script>", n);
const svg = (n?: number) => conCabecera('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', n);

/* ── Efectos ──────────────────────────────────────────────────────────────── */

const puts = () =>
  aws.send.mock.calls
    .map(([c]) => c)
    .filter((c) => c.constructor.name === "PutObjectCommand")
    .map((c) => c.input as Record<string, unknown>);
const pendientes = () => e.t.run((ctx) => ctx.db.query("subidasPendientes").collect());
const temporales = () => e.t.run((ctx) => ctx.db.system.query("_storage").collect());

/** Nada se firmó, nada quedó pendiente y nada llegó a S3. */
async function sinEscrituras() {
  expect(aws.firmas).toEqual([]);
  expect(await pendientes()).toEqual([]);
  expect(puts()).toEqual([]);
}

const pedir = (quien: Quien, folder: string, contentType = "image/jpeg", size?: number) =>
  e.como(quien).action(api.files.generateUploadUrl, {
    folder,
    contentType,
    fileName: "archivo",
    ...(size !== undefined ? { size } : {}),
  });

const subirBytes = (quien: Quien, folder: string, contentType: string, bytes: ArrayBuffer) =>
  e.como(quien).action(api.files.uploadBytes, { folder, contentType, fileName: "archivo", bytes });

/** El PUT de una app instalada a la `uploadUrl` que recibió. */
const putIntermediado = (uploadUrl: string, cuerpo: ArrayBuffer | Uint8Array, contentType = "image/jpeg") =>
  e.t.fetch(uploadUrl.slice(SITIO.length), {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: cuerpo instanceof Uint8Array ? cuerpo : new Uint8Array(cuerpo),
  });

/* ── 1, 2, 7. Autorización por carpeta ────────────────────────────────────── */

describe("autorización: conjunto y entidad, antes de firmar o escribir", () => {
  test("un residente de A pide subir a los comprobantes de B: rechazo, sin firma ni escritura", async () => {
    for (const size of [undefined, 1_000]) {
      await expect(pedir("residenteA", `condominios/soportes/${e.condoB}`, "image/jpeg", size)).rejects.toThrow(MENSAJE_CARPETA);
    }
    await expect(subirBytes("residenteA", `condominios/soportes/${e.condoB}`, "image/jpeg", jpeg())).rejects.toThrow(MENSAJE_CARPETA);
    await sinEscrituras();
  });

  test("la administración de A no sube a las carpetas de B; la de B sí", async () => {
    const deB = [
      [`condominios/documentos/${e.condoB}`, "application/pdf"],
      [`condominios/comunicados/${e.condoB}`, "application/pdf"],
      [`condominios/facturas/${e.condoB}`, "application/pdf"],
      [`condominios/${e.condoB}/consejo`, "application/pdf"],
      [`condominios/${e.condoB}/consejo/icons`, "image/png"],
      [`condominios/${e.condoB}/reservas/incidentes`, "image/jpeg"],
      [`condominios/guardia/${e.condoB}/paquetes`, "image/jpeg"],
      [`condominios/asambleas/${e.condoB}/poderes`, "application/pdf"],
    ] as const;
    for (const [folder, tipo] of deB) {
      await expect(pedir("adminA", folder, tipo), folder).rejects.toThrow(MENSAJE_CARPETA);
    }
    await sinEscrituras();
    for (const [folder, tipo] of deB) {
      const { key } = await pedir("adminB", folder, tipo);
      expect(key.startsWith(`${folder}/`), folder).toBe(true);
    }
  });

  test("un residente sin rol no sube a las carpetas de gestión de su propio conjunto", async () => {
    for (const [folder, tipo] of [
      [`condominios/documentos/${e.condoA}`, "application/pdf"],
      [`condominios/comunicados/${e.condoA}`, "application/pdf"],
      [`condominios/facturas/${e.condoA}`, "application/pdf"],
      [`condominios/${e.condoA}/consejo`, "application/pdf"],
      [`condominios/guardia/${e.condoA}/rondas`, "image/jpeg"],
      [`condominios/${e.condoA}/reservas/incidentes`, "image/jpeg"],
      [`condominios/${e.condoA}/logo`, "image/png"],
      ["whatsapp/salientes", "image/jpeg"],
      [`inventario/${e.companiaA}`, "image/jpeg"],
      [`asambleas/${e.asambleaA}/grabacion`, "video/webm"],
    ] as const) {
      await expect(pedir("residenteA", folder, tipo), folder).rejects.toThrow(MENSAJE_CARPETA);
    }
    // Comprobantes: hace falta tener casa ahí, no solo ser miembro.
    await expect(pedir("sinCasaA", `condominios/soportes/${e.condoA}`)).rejects.toThrow(MENSAJE_CARPETA);
    // La contadora no maneja la portería ni los íconos del consejo.
    await expect(pedir("contadoraA", `condominios/guardia/${e.condoA}/paquetes`)).rejects.toThrow(MENSAJE_CARPETA);
    await expect(pedir("contadoraA", `condominios/${e.condoA}/consejo/icons`, "image/png")).rejects.toThrow(MENSAJE_CARPETA);
    await sinEscrituras();
  });

  test("carpetas manipuladas, inexistentes o ambiguas: rechazo y nada escrito", async () => {
    const A = e.condoA;
    for (const folder of [
      "",
      "/",
      " / ",
      `/condominios/documentos/${A}`,
      `condominios/documentos/${A}/`,
      `condominios//documentos/${A}`,
      `condominios/documentos/${e.condoB}/../${A}`,
      `condominios/documentos/${A}/..`,
      `./condominios/documentos/${A}`,
      `condominios\\documentos\\${A}`,
      `condominios/documentos/${A}%2F..%2F${e.condoB}`,
      `condominios/documentos/${A}/sub`,
      "condominios/documentos/noexiste",
      `condominios/documentos/${e.asambleaA}`,
      `condominios/${A}/constructor`,
      `condominios/${A}/toString`,
      `condominios/${A}/__proto__`,
      `avatars/${e.residenteB}`,
      "Avatars",
      "uploads",
      "comprobantes/" + A,
      `whatsapp/${A}`,
      `asambleas/${A}/grabacion`,
      "inventario/noexiste",
    ]) {
      await expect(pedir("adminA", folder, "application/pdf"), folder).rejects.toThrow(MENSAJE_CARPETA);
      await expect(subirBytes("adminA", folder, "application/pdf", pdf()), folder).rejects.toThrow(MENSAJE_CARPETA);
    }
    await sinEscrituras();
  });

  test("legítimas: cada uso con su rol obtiene una llave dentro de su carpeta", async () => {
    const casos: [Quien, string, string, string?][] = [
      ["residenteA", "avatars", "image/jpeg", `avatars/${e.residenteA}`],
      ["residenteA", `condominios/soportes/${e.condoA}`, "image/heic"],
      ["residenteA", `condominios/asambleas/${e.condoA}/poderes`, "application/pdf"],
      ["residenteA", `soporte/${e.condoA}`, "image/jpeg"],
      ["residenteA", "soporte/plataforma", "application/pdf"],
      ["adminA", `condominios/documentos/${e.condoA}`, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      ["contadoraA", `condominios/comunicados/${e.condoA}`, "application/pdf"],
      ["contadoraA", `condominios/facturas/${e.condoA}`, "image/jpeg"],
      ["contadoraA", `condominios/${e.condoA}/consejo`, "application/pdf"],
      ["adminA", `condominios/${e.condoA}/consejo/icons`, "image/png"],
      ["adminA", `condominios/${e.condoA}/reservas/incidentes`, "image/jpeg"],
      ["adminA", `condominios/asambleas/${e.condoA}/poderes`, "application/pdf"],
      ["adminA", `asambleas/${e.asambleaA}/grabacion`, "video/webm"],
      ["guardaA", `condominios/guardia/${e.condoA}/rondas`, "image/jpeg"],
      ["guardaA", `condominios/guardia/${e.condoA}/novedades`, "video/mp4"],
      ["plataforma", `condominios/${e.condoA}/logo`, "image/png"],
      ["plataforma", `condominios/${e.condoA}/cover`, "image/jpeg"],
      ["plataforma", "whatsapp/salientes", "audio/ogg"],
      ["plataforma", `inventario/${e.companiaA}`, "image/jpeg"],
    ];
    for (const [quien, folder, tipo, carpeta = folder] of casos) {
      const r = await pedir(quien, folder, tipo);
      expect(r.key.startsWith(`${carpeta}/`), `${quien} ${folder}`).toBe(true);
      expect(r.uploadUrl.startsWith(`${SITIO}/archivos/subida?token=`)).toBe(true);
      expect(r.publicUrl).toBe(`https://vekino.s3.us-east-1.amazonaws.com/${r.key}`);
    }
    expect(await pendientes()).toHaveLength(casos.length);
    expect(puts()).toEqual([]);
  });
});

/* ── 3, 4. Tipos y contenido ──────────────────────────────────────────────── */

describe("tipos: lista por uso, y por los bytes cuando el servidor los ve", () => {
  test("tipos activos o ajenos al uso: rechazo al pedir el enlace (con y sin tamaño)", async () => {
    const doc = `condominios/documentos/${e.condoA}`;
    for (const tipo of [
      "text/html",
      "application/xhtml+xml",
      "application/javascript",
      "text/javascript",
      "image/svg+xml",
      "application/x-msdownload",
      "application/zip",
      "video/webm",
    ]) {
      for (const size of [undefined, 1_000]) {
        await expect(pedir("adminA", doc, tipo, size), `${tipo} ${size}`).rejects.toThrow(MENSAJE_TIPO_NO_PERMITIDO);
      }
    }
    // Sin tipo se puede pedir solo si pasa por el servidor (deciden los bytes).
    await expect(pedir("adminA", doc, "application/octet-stream", 1_000)).rejects.toThrow(MENSAJE_TIPO_NO_PERMITIDO);
    await expect(pedir("adminA", doc, "", 1_000)).rejects.toThrow(MENSAJE_TIPO_NO_PERMITIDO);
    await sinEscrituras();
  });

  test("uploadBytes: el tipo sale de los bytes; un disfraz se rechaza sin escribir", async () => {
    const doc = `condominios/documentos/${e.condoA}`;
    for (const [tipo, bytes] of [
      ["image/jpeg", html()],
      ["text/plain", html()],
      ["application/pdf", zip()],
      ["image/png", svg()],
      ["", html()],
    ] as const) {
      await expect(subirBytes("adminA", doc, tipo, bytes), tipo).rejects.toThrow(MENSAJE_CONTENIDO);
    }
    expect(puts()).toEqual([]);

    // Tipo mal puesto pero contenido permitido: se guarda con el de los bytes.
    await subirBytes("adminA", doc, "image/png", jpeg());
    await subirBytes("adminA", doc, "", pdf());
    await subirBytes("residenteA", `condominios/soportes/${e.condoA}`, "image/heic", heic());
    // Un CSV que Windows (con Excel) etiqueta como hoja de Excel: es texto.
    await subirBytes("adminA", doc, "application/vnd.ms-excel", conCabecera("casa;valor\n101;380000\n"));
    expect(puts().map((p) => p.ContentType)).toEqual(["image/jpeg", "application/pdf", "image/heic", "text/plain"]);
    // En un uso sin texto (comunicados), el mismo archivo no entra.
    await expect(
      subirBytes("adminA", `condominios/comunicados/${e.condoA}`, "application/vnd.ms-excel", conCabecera("casa;valor\n")),
    ).rejects.toThrow(MENSAJE_CONTENIDO);
    expect(puts().every((p) => p.IfNoneMatch === "*")).toBe(true);
  });

  test("SVG: solo íconos del consejo y solo por el servidor, que lo guarda para descargar", async () => {
    const iconos = `condominios/${e.condoA}/consejo/icons`;
    await expect(pedir("adminA", iconos, "image/svg+xml", 500)).rejects.toThrow(MENSAJE_TIPO_NO_PERMITIDO);
    await expect(subirBytes("adminA", `condominios/comunicados/${e.condoA}`, "image/svg+xml", svg())).rejects.toThrow(
      MENSAJE_TIPO_NO_PERMITIDO,
    );
    await subirBytes("adminA", iconos, "image/svg+xml", svg());
    expect(puts()).toHaveLength(1);
    expect(puts()[0]).toMatchObject({ ContentType: "image/svg+xml", ContentDisposition: "attachment" });
  });
});

/* ── 5, 6. Tamaño ─────────────────────────────────────────────────────────── */

describe("tamaño: límite efectivo en las dos formas", () => {
  test("URL firmada: el tamaño y el tipo quedan firmados; fuera del límite no se firma", async () => {
    const doc = `condominios/documentos/${e.condoA}`;
    for (const size of [25 * MiB + 1, 0, -1, 1.5, Number.NaN]) {
      await expect(pedir("adminA", doc, "application/pdf", size), String(size)).rejects.toThrow();
    }
    await expect(pedir("adminA", doc, "application/pdf", 25 * MiB + 1)).rejects.toThrow(MENSAJE_ARCHIVO_GRANDE);
    await sinEscrituras();

    const r = await pedir("adminA", doc, "application/pdf", 3 * MiB);
    expect(r.uploadUrl).toContain("vekino.s3.us-east-1.amazonaws.com");
    expect(aws.firmas).toHaveLength(1);
    const [firma] = aws.firmas;
    expect(firma!.input).toMatchObject({ Key: r.key, ContentType: "application/pdf", ContentLength: 3 * MiB });
    expect([...firma!.opciones.signableHeaders].sort()).toEqual(["content-length", "content-type"]);
    expect(firma!.opciones.expiresIn).toBe(600);
    // Una grabación de 40 MB (una parte reintentada) cabe; la de 60 no.
    await pedir("adminA", `asambleas/${e.asambleaA}/grabacion`, "video/webm", 40 * MiB);
    await expect(pedir("adminA", `asambleas/${e.asambleaA}/grabacion`, "video/webm", 60 * MiB)).rejects.toThrow(
      MENSAJE_ARCHIVO_GRANDE,
    );
  });

  test("subida intermediada: un cuerpo sobre el límite se corta con 413 y no llega a S3", async () => {
    const foto = await pedir("guardaA", `condominios/guardia/${e.condoA}/paquetes`);
    const grande = new Uint8Array(20 * MiB + 1);
    grande.set(new Uint8Array(jpeg(16)));
    const r = await putIntermediado(foto.uploadUrl, grande);
    expect(r.status).toBe(413);

    // La grabación admite 50 MiB por URL firmada, pero por aquí el techo es 20.
    const parte = await pedir("adminA", `asambleas/${e.asambleaA}/grabacion`, "video/webm");
    const parteGrande = new Uint8Array(20 * MiB + 1);
    parteGrande.set(new Uint8Array(webm(16)));
    expect((await putIntermediado(parte.uploadUrl, parteGrande, "video/webm")).status).toBe(413);

    expect(puts()).toEqual([]);
    expect(await temporales()).toEqual([]);
  });
});

/* ── 8, 9, 12. Subida intermediada: el contrato de las apps instaladas ────── */

describe("subida intermediada (apps instaladas): PUT a la uploadUrl con su Content-Type", () => {
  test("flujo completo de un comprobante desde el celular (foto HEIC)", async () => {
    const r = await pedir("residenteA", `condominios/soportes/${e.condoA}`, "image/heic");
    const respuesta = await putIntermediado(r.uploadUrl, heic(4_096), "image/heic");
    expect(respuesta.status).toBe(200);
    expect(respuesta.headers.get("access-control-allow-origin")).toBe("*");

    expect(puts()).toHaveLength(1);
    expect(puts()[0]).toMatchObject({ Bucket: "vekino", Key: r.key, ContentType: "image/heic", IfNoneMatch: "*" });
    expect((puts()[0]!.Body as Buffer).byteLength).toBe(4_096);
    expect(await pendientes()).toEqual([]);
    expect(await temporales()).toEqual([]);

    // Y la URL pública es la que crearMio acepta para ese conjunto.
    expect(r.publicUrl.startsWith(`https://vekino.s3.us-east-1.amazonaws.com/condominios/soportes/${e.condoA}/`)).toBe(true);
  });

  test("un solo uso, vence a los 10 minutos, y un token inventado no sirve", async () => {
    const r = await pedir("guardaA", `condominios/guardia/${e.condoA}/rondas`);
    expect((await putIntermediado(r.uploadUrl, jpeg())).status).toBe(200);
    expect((await putIntermediado(r.uploadUrl, jpeg())).status).toBe(403);

    vi.useFakeTimers({ toFake: ["Date"] });
    const viejo = await pedir("guardaA", `condominios/guardia/${e.condoA}/rondas`);
    vi.setSystemTime(Date.now() + 11 * 60 * 1000);
    expect((await putIntermediado(viejo.uploadUrl, jpeg())).status).toBe(403);
    vi.useRealTimers();

    for (const ruta of ["/archivos/subida", `/archivos/subida?token=${"0".repeat(64)}`, "/archivos/subida?token=../../x"]) {
      expect((await e.t.fetch(ruta, { method: "PUT", body: new Uint8Array(jpeg()) })).status).toBe(403);
    }
    expect(puts()).toHaveLength(1);
  });

  test("contenido que no es del tipo permitido, o vacío: no llega a S3", async () => {
    const a = await pedir("guardaA", `condominios/guardia/${e.condoA}/paquetes`, "image/jpeg");
    const ra = await putIntermediado(a.uploadUrl, html(), "image/jpeg");
    expect(ra.status).toBe(415);
    expect(await ra.json()).toEqual({ error: MENSAJE_CONTENIDO });

    const b = await pedir("adminA", `condominios/documentos/${e.condoA}`, "application/pdf");
    expect((await putIntermediado(b.uploadUrl, new Uint8Array(0), "application/pdf")).status).toBe(400);

    expect(puts()).toEqual([]);
    expect(await temporales()).toEqual([]);
  });

  test("preflight del navegador (web anterior)", async () => {
    const r = await e.t.fetch("/archivos/subida", { method: "OPTIONS" });
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-methods")).toContain("PUT");
    expect(r.headers.get("access-control-allow-headers")).toContain("Content-Type");
  });
});

/* ── 10. Procesos internos ────────────────────────────────────────────────── */

describe("procesos internos: WhatsApp conserva su carpeta, pero nunca sirve HTML", () => {
  const desdeYCloud = async (cuerpo: ArrayBuffer, contentType: string, folder: string) => {
    vi.stubGlobal("fetch", async () => new Response(new Uint8Array(cuerpo), { headers: { "content-type": contentType } }));
    return await e.t.action(internal.files.uploadFromUrl, {
      url: "https://api.ycloud.com/v2/whatsapp/media/abc",
      folder,
      fileName: "media",
      conApiKeyYCloud: true,
    });
  };

  test("foto, nota de voz y documento HTML que llegan por WhatsApp", async () => {
    await desdeYCloud(jpeg(), "image/jpeg", `comprobantes/${e.condoA}`);
    await desdeYCloud(ogg(), "audio/ogg; codecs=opus", `whatsapp/${e.condoA}`);
    await desdeYCloud(html(), "text/html", `whatsapp/${e.condoA}`);
    await desdeYCloud(svg(), "image/svg+xml", `whatsapp/${e.condoA}`);
    const [foto, voz, pagina, dibujo] = puts();
    expect(foto).toMatchObject({ ContentType: "image/jpeg" });
    expect(foto!.ContentDisposition).toBeUndefined();
    expect(voz).toMatchObject({ ContentType: "audio/ogg" });
    expect(pagina).toMatchObject({ ContentType: "application/octet-stream", ContentDisposition: "attachment" });
    expect(dibujo).toMatchObject({ ContentType: "application/octet-stream", ContentDisposition: "attachment" });
    expect((foto!.Key as string).startsWith(`comprobantes/${e.condoA}/`)).toBe(true);
  });
});
