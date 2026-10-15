import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { MENSAJE_CONTENIDO } from "../convex/lib/subidas";
import { MENSAJE_ARCHIVO_NO_AUTORIZADO } from "../convex/model/registroArchivos";

/**
 * LOS PDF DE LAS FACTURAS SALEN DE UNA PUBLICACIÓN AUTORIZADA — Fase 5 de S3
 * (H-12 en facturación, qa/factory/auditoria-s3-2026-10-14).
 *
 * Antes `/api/facturas/confirmar` publicaba los PDF con su propio cliente de
 * S3 y `bulkUpsert` guardaba el `pdfUrl` que le mandaran: el de otro
 * conjunto, uno externo o uno que nunca se publicó. Ahora:
 *   - publica Convex (`files.publicarFacturas`): permiso sobre la
 *     importación, PDF por sus bytes, llave del servidor, sin sobrescribir,
 *     y cada PDF queda como subida validada;
 *   - `bulkUpsert` solo registra un `pdfUrl` nuevo si es uno de esos, de la
 *     misma importación y período, con la URL exacta y una sola vez; el que
 *     la factura ya tenía se conserva.
 *
 * Dos conjuntos: A (migrado, con `legacyId`) y B. S3 simulado con los
 * objetos de verdad (respeta `If-None-Match`); la red, bloqueada.
 */

const modules = import.meta.glob("../convex/**/*.ts");

const s3 = vi.hoisted(() => {
  const objetos = new Map<string, { bytes: Uint8Array; tipo?: string }>();
  const comandos: { nombre: string; input: Record<string, any> }[] = [];
  const firmas: { input: Record<string, any> }[] = [];
  /** Llaves cuya escritura falla (para los fallos parciales). */
  const fallan = new Set<string>();
  const copia = (b: unknown) =>
    ArrayBuffer.isView(b) ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength).slice() : new Uint8Array(0);
  const error = (name: string, status: number) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
  async function enviar(c: { constructor: { name: string }; input: Record<string, any> }) {
    const nombre = c.constructor.name;
    const i = c.input;
    comandos.push({ nombre, input: i });
    switch (nombre) {
      case "PutObjectCommand":
        if (fallan.has(i.Key)) throw error("InternalError: credenciales AKIA-SECRETO en us-east-1", 500);
        if (i.IfNoneMatch === "*" && objetos.has(i.Key)) throw error("PreconditionFailed", 412);
        objetos.set(i.Key, { bytes: copia(i.Body), tipo: i.ContentType });
        return {};
      case "DeleteObjectCommand":
        objetos.delete(i.Key);
        return {};
    }
    throw new Error(`Comando de S3 inesperado: ${nombre}`);
  }
  return { objetos, comandos, firmas, fallan, enviar };
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

const BUCKET = "https://vekino.s3.us-east-1.amazonaws.com";
const DIA = 24 * 60 * 60 * 1000;
const PERIODO = "2026-09";
const ETIQUETA = "Septiembre / 2026";

type Quien = "adminA" | "contadoraA" | "juntaA" | "residenteA" | "guardaA" | "adminB";

async function montar() {
  const t = convexTest(schema, modules);
  const ahora = Date.now();
  const ids = await t.run(async (ctx) => {
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
    const unidad = (condominioId: Id<"condominios">, numero: string) =>
      ctx.db.insert("unidades", { condominioId, tipo: "casa", estado: "ocupada", numero, createdAt: ahora, updatedAt: ahora });

    const condoA = await ctx.db.insert("condominios", {
      name: "A",
      legacyId: "conjunto-a",
      activeModules: [],
      isActive: true,
      createdAt: ahora,
      updatedAt: ahora,
    });
    const condoB = await ctx.db.insert("condominios", { name: "B", activeModules: [], isActive: true, createdAt: ahora, updatedAt: ahora });
    const u = {
      adminA: await persona("adminA"),
      contadoraA: await persona("contadoraA"),
      juntaA: await persona("juntaA"),
      residenteA: await persona("residenteA"),
      guardaA: await persona("guardaA"),
      adminB: await persona("adminB"),
    };
    await membresia(u.adminA, condoA, ["administrador"]);
    await membresia(u.contadoraA, condoA, ["contadora"]);
    await membresia(u.juntaA, condoA, ["junta_directiva"]);
    await membresia(u.guardaA, condoA, ["guardia"]);
    await membresia(u.adminB, condoB, ["administrador"]);
    const u101 = await unidad(condoA, "101");
    const u102 = await unidad(condoA, "102");
    const u201 = await unidad(condoB, "201");
    const mResidente = await membresia(u.residenteA, condoA, ["propietario"]);
    await ctx.db.insert("usuarioUnidad", {
      membershipId: mResidente,
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
  vi.stubEnv("CONVEX_SITE_URL", "https://vekino-pruebas.convex.site");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: unknown) => {
      throw new Error(`Red bloqueada: ${String(u)}`);
    }),
  );
  s3.objetos.clear();
  s3.comandos.length = 0;
  s3.firmas.length = 0;
  s3.fallan.clear();
  e = await montar();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/* ── Archivos ─────────────────────────────────────────────────────────────── */

function conCabecera(cabecera: number[] | string, tamano = 2_048): Uint8Array {
  const inicio = typeof cabecera === "string" ? [...cabecera].map((c) => c.charCodeAt(0)) : cabecera;
  const b = new Uint8Array(Math.max(tamano, inicio.length)).fill(0x20);
  b.set(inicio);
  return b;
}
/** Un PDF (por sus bytes); `texto` cambia el contenido y, con él, la huella. */
const pdf = (texto = "cuenta de cobro") => conCabecera(`%PDF-1.7\n% ${texto}\n`);
const html = () => conCabecera("<!DOCTYPE html><html><script>alert(1)</script>");
const jpeg = () => conCabecera([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const svg = () => conCabecera('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const buf = (b: Uint8Array) => b.slice().buffer as ArrayBuffer;
const sha256 = async (b: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))].map((x) => x.toString(16).padStart(2, "0")).join("");
const huellaAlAzar = () => Array.from({ length: 64 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");

/* ── Lo que hace la confirmación (`/api/facturas/confirmar`) ─────────────── */

type Casa = { unidadId: Id<"unidades">; unidad: string };

async function iniciar(
  quien: Quien,
  condominioId: Id<"condominios">,
  casas: Casa[],
  opciones: { soloNuevas?: boolean; hash?: string; periodo?: string } = {},
) {
  const r = await e.como(quien).mutation(api.facturas.iniciarImportacion, {
    condominioId,
    periodo: opciones.periodo ?? PERIODO,
    archivo: "cuentas.pdf",
    hash: opciones.hash ?? huellaAlAzar(),
    soloNuevas: opciones.soloNuevas ?? true,
    documentos: casas.length,
    candidatas: casas.map((c, indice) => ({ indice, unidadId: c.unidadId, periodoLabel: ETIQUETA })),
  });
  return r;
}

const publicar = (quien: Quien, importacionId: Id<"importaciones">, pdfs: { unidad: string; bytes: Uint8Array }[]) =>
  e.como(quien).action(api.files.publicarFacturas, {
    importacionId,
    pdfs: pdfs.map((p) => ({ unidad: p.unidad, bytes: buf(p.bytes) })),
  });

/** Lo que manda la confirmación por factura (con o sin PDF). */
function entrada(condominioId: Id<"condominios">, unidadId: Id<"unidades">, pdfUrl?: string, periodo = PERIODO) {
  return {
    condominioId,
    unidadId,
    numeroFactura: `F-${periodo}-${unidadId.slice(-4)}`,
    numeroInterno: "1",
    periodo,
    periodoLabel: periodo === PERIODO ? ETIQUETA : "Octubre / 2026",
    residenteNombre: "Residente",
    vrAdmon: 300_000,
    lineas: [{ codigo: 1, concepto: "CUOTA", saldoAnterior: 0, actual: 300_000, total: 300_000 }],
    saldoAFavor: 0,
    totalAPagar: 300_000,
    fechaEmision: Date.now(),
    fechaVencimiento: Date.now() + 30 * DIA,
    estado: "pendiente" as const,
    ...(pdfUrl !== undefined ? { pdfUrl } : {}),
  };
}

const guardar = (
  quien: Quien,
  facturas: ReturnType<typeof entrada>[],
  opciones: { importacionId?: Id<"importaciones">; skipExisting?: boolean } = {},
) =>
  e.como(quien).mutation(api.facturas.bulkUpsert, {
    facturas,
    skipExisting: opciones.skipExisting ?? true,
    ...(opciones.importacionId ? { importacionId: opciones.importacionId } : {}),
  });

const cerrar = (quien: Quien, importacionId: Id<"importaciones">, estado: "completada" | "fallida" = "completada") =>
  e.como(quien).mutation(api.facturas.finalizarImportacion, { importacionId, estado });

/** Una carga completa de la casa 101 de A: importar, publicar, guardar y cerrar. */
async function cargar101(quien: Quien = "adminA", bytes = pdf(), opciones: { soloNuevas?: boolean } = {}) {
  const inicio = await iniciar(quien, e.condoA, [{ unidadId: e.u101, unidad: "101" }], opciones);
  if (inicio.tipo !== "nueva") throw new Error(`importación ${inicio.tipo}`);
  const [publicado] = await publicar(quien, inicio.importacionId, [{ unidad: "101", bytes }]);
  await guardar(quien, [entrada(e.condoA, e.u101, publicado!.publicUrl)], {
    importacionId: inicio.importacionId,
    skipExisting: opciones.soloNuevas ?? true,
  });
  await cerrar(quien, inicio.importacionId);
  return { importacionId: inicio.importacionId, ...publicado! };
}

/* ── Efectos ──────────────────────────────────────────────────────────────── */

const puts = () => s3.comandos.filter((c) => c.nombre === "PutObjectCommand").map((c) => c.input);
const borrados = () => s3.comandos.filter((c) => c.nombre === "DeleteObjectCommand").map((c) => c.input.Key);
const facturas = () => e.t.run((ctx) => ctx.db.query("facturas").collect());
const filas = () => e.t.run((ctx) => ctx.db.query("subidasPendientes").collect());
const fila = (key: string) =>
  e.t.run((ctx) => ctx.db.query("subidasPendientes").withIndex("by_key", (q) => q.eq("key", key)).first());
const facturaDe = async (unidadId: Id<"unidades">) => (await facturas()).find((f) => f.unidadId === unidadId);

async function mensajeDe(promesa: Promise<unknown>): Promise<string> {
  try {
    await promesa;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("Se esperaba un rechazo y la llamada pasó.");
}

/** Nada llegó a S3, a las facturas ni al registro de subidas. */
async function nadaEscrito() {
  expect(puts()).toEqual([]);
  expect(await facturas()).toEqual([]);
  expect(await filas()).toEqual([]);
}

/* ── 1. Sin sesión ────────────────────────────────────────────────────────── */

describe("1. Sin sesión no se carga ni se confirma nada", () => {
  test("ni importar, ni publicar, ni guardar", async () => {
    const inicio = await iniciar("adminA", e.condoA, [{ unidadId: e.u101, unidad: "101" }]);
    if (inicio.tipo !== "nueva") throw new Error();
    await expect(
      e.t.mutation(api.facturas.iniciarImportacion, {
        condominioId: e.condoA,
        periodo: PERIODO,
        archivo: "x.pdf",
        hash: huellaAlAzar(),
        soloNuevas: true,
        documentos: 1,
        candidatas: [],
      }),
    ).rejects.toThrow();
    await expect(
      e.t.action(api.files.publicarFacturas, { importacionId: inicio.importacionId, pdfs: [{ unidad: "101", bytes: buf(pdf()) }] }),
    ).rejects.toThrow();
    await expect(
      e.t.mutation(api.facturas.bulkUpsert, {
        facturas: [entrada(e.condoA, e.u101, `${BUCKET}/condominios/facturas/conjunto-a/${PERIODO}/${inicio.importacionId}/unidad-101-0a1b2c3d4e5f.pdf`)],
        importacionId: inicio.importacionId,
      }),
    ).rejects.toThrow();
    await nadaEscrito();
  });
});

/* ── 2. Sin el rol de carga ───────────────────────────────────────────────── */

describe("2. Sin el rol de carga (administración o contadora) no se publica", () => {
  test("junta, residente y guarda: ni importan, ni publican en la importación de la administración, ni guardan", async () => {
    const inicio = await iniciar("adminA", e.condoA, [{ unidadId: e.u101, unidad: "101" }]);
    if (inicio.tipo !== "nueva") throw new Error();
    for (const quien of ["juntaA", "residenteA", "guardaA"] as const) {
      await expect(iniciar(quien, e.condoA, [{ unidadId: e.u101, unidad: "101" }]), quien).rejects.toThrow();
      await expect(publicar(quien, inicio.importacionId, [{ unidad: "101", bytes: pdf() }]), quien).rejects.toThrow();
      await expect(guardar(quien, [entrada(e.condoA, e.u101)], { importacionId: inicio.importacionId }), quien).rejects.toThrow();
    }
    await nadaEscrito();
  });
});

/* ── 3. Otro conjunto ─────────────────────────────────────────────────────── */

describe("3. La administración de A no registra un PDF de B", () => {
  test("ni la URL publicada para B, ni publicar en la importación de B, ni mezclar conjuntos e importaciones", async () => {
    const deB = await iniciar("adminB", e.condoB, [{ unidadId: e.u201, unidad: "201" }]);
    const deA = await iniciar("adminA", e.condoA, [{ unidadId: e.u101, unidad: "101" }]);
    if (deB.tipo !== "nueva" || deA.tipo !== "nueva") throw new Error();
    const [pdfDeB] = await publicar("adminB", deB.importacionId, [{ unidad: "201", bytes: pdf("de B") }]);
    const putsAntes = puts().length;

    expect(await mensajeDe(guardar("adminA", [entrada(e.condoA, e.u101, pdfDeB!.publicUrl)], { importacionId: deA.importacionId }))).toContain(
      MENSAJE_ARCHIVO_NO_AUTORIZADO,
    );
    await expect(publicar("adminA", deB.importacionId, [{ unidad: "201", bytes: pdf() }])).rejects.toThrow();
    expect(
      await mensajeDe(guardar("adminA", [entrada(e.condoA, e.u101, pdfDeB!.publicUrl)], { importacionId: deB.importacionId })),
    ).toContain("La importación no corresponde a este conjunto.");
    await expect(guardar("adminA", [entrada(e.condoB, e.u201, pdfDeB!.publicUrl)], { importacionId: deB.importacionId })).rejects.toThrow();

    expect(puts()).toHaveLength(putsAntes);
    expect(await facturas()).toEqual([]);
    expect((await fila(pdfDeB!.key))?.registradaEn).toBeUndefined();
  });
});

/* ── 4. URLs externas o que imitan al bucket ──────────────────────────────── */

describe("4. Una URL externa o un host que imita al bucket no entra como PDF nuevo", () => {
  test("la llave publicada, escrita de otra forma o en otro host: no; la URL exacta: sí", async () => {
    const inicio = await iniciar("adminA", e.condoA, [{ unidadId: e.u101, unidad: "101" }]);
    if (inicio.tipo !== "nueva") throw new Error();
    const [publicado] = await publicar("adminA", inicio.importacionId, [{ unidad: "101", bytes: pdf() }]);
    const { key, publicUrl } = publicado!;
    for (const url of [
      "https://archivos.test/factura.pdf",
      `https://vekino.s3.otro-sitio.test/${key}`,
      `https://vekino.s3.us-east-1.amazonaws.com.otro-sitio.test/${key}`,
      `https://otro-bucket.s3.us-east-1.amazonaws.com/${key}`,
      `http://vekino.s3.us-east-1.amazonaws.com/${key}`,
      `https://vekino.s3.amazonaws.com/${key}`,
      `https://s3.us-east-1.amazonaws.com/vekino/${key}`,
      `${publicUrl}?descarga=1`,
      `${publicUrl}#pagina=2`,
      `${BUCKET}/${encodeURIComponent(key)}`,
      `${BUCKET}//${key}`,
    ]) {
      expect(
        await mensajeDe(guardar("adminA", [entrada(e.condoA, e.u101, url)], { importacionId: inicio.importacionId })),
        url,
      ).toContain(MENSAJE_ARCHIVO_NO_AUTORIZADO);
    }
    expect(await facturas()).toEqual([]);
    expect((await fila(key))?.registradaEn).toBeUndefined();

    await guardar("adminA", [entrada(e.condoA, e.u101, publicUrl)], { importacionId: inicio.importacionId });
    expect((await facturaDe(e.u101))?.pdfUrl).toBe(publicUrl);
  });
});

/* ── 5. URL de S3 válida sin publicación autorizada ───────────────────────── */

describe("5. Una URL de S3 bien formada, pero sin publicación autorizada, se rechaza", () => {
  test("en la carpeta de la importación sin publicar, la de una factura manual, la de un comprobante, o sin importación", async () => {
    const inicio = await iniciar("adminA", e.condoA, [{ unidadId: e.u101, unidad: "101" }]);
    if (inicio.tipo !== "nueva") throw new Error();
    const carpeta = `condominios/facturas/conjunto-a/${PERIODO}/${inicio.importacionId}`;
    const manual = await e.como("adminA").action(api.files.uploadBytes, {
      folder: `condominios/facturas/${e.condoA}`,
      contentType: "application/pdf",
      fileName: "manual.pdf",
      bytes: buf(pdf("manual")),
    });
    const comprobante = await e.como("residenteA").action(api.files.uploadBytes, {
      folder: `condominios/soportes/${e.condoA}`,
      contentType: "application/pdf",
      fileName: "pago.pdf",
      bytes: buf(pdf("pago")),
    });
    for (const url of [
      `${BUCKET}/${carpeta}/unidad-101-0a1b2c3d4e5f.pdf`,
      `${BUCKET}/condominios/facturas/conjunto-a/${PERIODO}/unidad-101.pdf`,
      manual.publicUrl,
      comprobante.publicUrl,
    ]) {
      expect(
        await mensajeDe(guardar("adminA", [entrada(e.condoA, e.u101, url)], { importacionId: inicio.importacionId })),
        url,
      ).toContain(MENSAJE_ARCHIVO_NO_AUTORIZADO);
    }
    // Sin importación, ningún PDF nuevo, ni siquiera uno publicado de verdad.
    const [publicado] = await publicar("adminA", inicio.importacionId, [{ unidad: "101", bytes: pdf() }]);
    expect(await mensajeDe(guardar("adminA", [entrada(e.condoA, e.u101, publicado!.publicUrl)]))).toContain(
      MENSAJE_ARCHIVO_NO_AUTORIZADO,
    );
    expect(await facturas()).toEqual([]);
    for (const k of [manual.key, comprobante.key, publicado!.key]) expect((await fila(k))?.registradaEn).toBeUndefined();
  });
});

/* ── 6. Lo que no es PDF ──────────────────────────────────────────────────── */

describe("6. Un archivo que no es PDF no se publica como factura", () => {
  test("HTML, JPEG, SVG, texto o vacío: rechazo, y un lote con uno malo no publica ninguno", async () => {
    const inicio = await iniciar("adminA", e.condoA, [{ unidadId: e.u101, unidad: "101" }]);
    if (inicio.tipo !== "nueva") throw new Error();
    for (const [nombre, bytes, mensaje] of [
      ["html", html(), MENSAJE_CONTENIDO],
      ["jpeg", jpeg(), MENSAJE_CONTENIDO],
      ["svg", svg(), MENSAJE_CONTENIDO],
      ["texto", conCabecera("Cuenta de cobro 101: $300.000"), MENSAJE_CONTENIDO],
      ["vacío", new Uint8Array(0), "Archivo vacío."],
    ] as const) {
      expect(await mensajeDe(publicar("adminA", inicio.importacionId, [{ unidad: "101", bytes }])), nombre).toContain(mensaje);
    }
    expect(
      await mensajeDe(
        publicar("adminA", inicio.importacionId, [
          { unidad: "101", bytes: pdf() },
          { unidad: "102", bytes: html() },
        ]),
      ),
    ).toContain(MENSAJE_CONTENIDO);
    await nadaEscrito();
  });
});

/* ── 7. Llave ajena, provisional, vencida o mal usada ─────────────────────── */

describe("7. Una llave ajena, provisional, vencida o mal usada no se registra", () => {
  test("la de otra importación, o la de esta en una factura de otro período", async () => {
    const primera = await iniciar("adminA", e.condoA, [{ unidadId: e.u101, unidad: "101" }]);
    const segunda = await iniciar("adminA", e.condoA, [{ unidadId: e.u101, unidad: "101" }], { soloNuevas: false });
    if (primera.tipo !== "nueva" || segunda.tipo !== "nueva") throw new Error();
    const [dePrimera] = await publicar("adminA", primera.importacionId, [{ unidad: "101", bytes: pdf() }]);
    expect(
      await mensajeDe(guardar("adminA", [entrada(e.condoA, e.u101, dePrimera!.publicUrl)], { importacionId: segunda.importacionId })),
    ).toContain(MENSAJE_ARCHIVO_NO_AUTORIZADO);
    expect(
      await mensajeDe(
        guardar("adminA", [entrada(e.condoA, e.u101, dePrimera!.publicUrl, "2026-10")], { importacionId: primera.importacionId }),
      ),
    ).toContain(MENSAJE_ARCHIVO_NO_AUTORIZADO);
    expect(await facturas()).toEqual([]);
  });

  test("la provisional de una subida directa (pendientes/…) y la de una subida sin confirmar", async () => {
    const inicio = await iniciar("adminA", e.condoA, [{ unidadId: e.u101, unidad: "101" }]);
    if (inicio.tipo !== "nueva") throw new Error();
    const directa = await e.como("adminA").action(api.files.generateUploadUrl, {
      folder: `condominios/facturas/${e.condoA}`,
      contentType: "application/pdf",
      fileName: "factura.pdf",
      size: 2_048,
    });
    const temporal = s3.firmas.at(-1)!.input.Key as string;
    for (const url of [`${BUCKET}/${temporal}`, directa.publicUrl]) {
      expect(
        await mensajeDe(guardar("adminA", [entrada(e.condoA, e.u101, url)], { importacionId: inicio.importacionId })),
        url,
      ).toContain(MENSAJE_ARCHIVO_NO_AUTORIZADO);
    }
    expect(await facturas()).toEqual([]);
  });

  test("vencida: un día después de publicarla ya no se registra", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const inicio = await iniciar("adminA", e.condoA, [{ unidadId: e.u101, unidad: "101" }]);
    if (inicio.tipo !== "nueva") throw new Error();
    const [publicado] = await publicar("adminA", inicio.importacionId, [{ unidad: "101", bytes: pdf() }]);
    vi.setSystemTime(Date.now() + DIA + 1);
    expect(
      await mensajeDe(guardar("adminA", [entrada(e.condoA, e.u101, publicado!.publicUrl)], { importacionId: inicio.importacionId })),
    ).toContain(MENSAJE_ARCHIVO_NO_AUTORIZADO);
    expect(await facturas()).toEqual([]);
  });

  test("mal usada: el PDF de la 101 no se registra también en la 102", async () => {
    const inicio = await iniciar("adminA", e.condoA, [
      { unidadId: e.u101, unidad: "101" },
      { unidadId: e.u102, unidad: "102" },
    ]);
    if (inicio.tipo !== "nueva") throw new Error();
    const [de101] = await publicar("adminA", inicio.importacionId, [{ unidad: "101", bytes: pdf() }]);
    await guardar("adminA", [entrada(e.condoA, e.u101, de101!.publicUrl)], { importacionId: inicio.importacionId });
    expect(
      await mensajeDe(guardar("adminA", [entrada(e.condoA, e.u102, de101!.publicUrl)], { importacionId: inicio.importacionId })),
    ).toContain(MENSAJE_ARCHIVO_NO_AUTORIZADO);
    expect(await facturaDe(e.u102)).toBeUndefined();
  });

  test("cerrada la importación, ya no se publica ni se guarda en ella", async () => {
    const { importacionId } = await cargar101();
    const putsAntes = puts().length;
    expect(await mensajeDe(publicar("adminA", importacionId, [{ unidad: "102", bytes: pdf("otra") }]))).toContain(
      "La importación ya se cerró.",
    );
    expect(await mensajeDe(guardar("adminA", [entrada(e.condoA, e.u102)], { importacionId }))).toContain(
      "La importación ya se cerró.",
    );
    expect(puts()).toHaveLength(putsAntes);
  });
});

/* ── 8. Sin sobrescribir ──────────────────────────────────────────────────── */

describe("8. Una llave existente no se sobrescribe", () => {
  test("toda escritura va con If-None-Match, y lo que ya estaba en la llave se queda como estaba", async () => {
    const inicio = await iniciar("adminA", e.condoA, [{ unidadId: e.u101, unidad: "101" }]);
    if (inicio.tipo !== "nueva") throw new Error();
    const [publicado] = await publicar("adminA", inicio.importacionId, [{ unidad: "101", bytes: pdf() }]);
    // Alguien (o algo) dejó otros bytes en esa llave: publicar de nuevo no los pisa.
    const ajeno = pdf("contenido que ya estaba");
    s3.objetos.set(publicado!.key, { bytes: ajeno, tipo: "application/pdf" });
    await publicar("adminA", inicio.importacionId, [{ unidad: "101", bytes: pdf() }]);
    expect(s3.objetos.get(publicado!.key)!.bytes).toEqual(ajeno);
    expect(puts().every((p) => p.IfNoneMatch === "*")).toBe(true);
  });

  test("la misma casa con el mismo contenido en dos importaciones: dos llaves distintas", async () => {
    const una = await cargar101("adminA", pdf());
    const otra = await cargar101("adminA", pdf(), { soloNuevas: false });
    expect(una.key).not.toBe(otra.key);
    expect(una.key).toContain(`/${una.importacionId}/`);
    expect(otra.key).toContain(`/${otra.importacionId}/`);
  });
});

/* ── 9. Actualizar sin cambiar el PDF ─────────────────────────────────────── */

describe("9. Una actualización sin cambio de PDF conserva su referencia", () => {
  test("reenviarlo, no mandarlo o mandarlo vacío: la factura sigue con su PDF, sin subir nada", async () => {
    const { publicUrl } = await cargar101();
    const otra = await iniciar("adminA", e.condoA, [{ unidadId: e.u101, unidad: "101" }], { soloNuevas: false });
    if (otra.tipo !== "nueva") throw new Error();
    const putsAntes = puts().length;
    for (const pdfUrl of [publicUrl, undefined, "", "  "]) {
      await guardar("adminA", [entrada(e.condoA, e.u101, pdfUrl)], { importacionId: otra.importacionId, skipExisting: false });
      expect((await facturaDe(e.u101))?.pdfUrl, String(pdfUrl)).toBe(publicUrl);
    }
    // También sin importación, como la llamada de antes.
    await guardar("adminA", [entrada(e.condoA, e.u101, publicUrl)], { skipExisting: false });
    expect((await facturaDe(e.u101))?.pdfUrl).toBe(publicUrl);
    expect(puts()).toHaveLength(putsAntes);
  });

  test("un PDF histórico (de antes de esta fase) se conserva, pero no se copia a otra factura", async () => {
    const historico = `${BUCKET}/condominios/facturas/conjunto-a/2026-08/unidad-101.pdf`;
    await e.t.run(async (ctx) => {
      await ctx.db.insert("facturas", {
        ...entrada(e.condoA, e.u101, historico),
        origen: "pdf",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
    await guardar("adminA", [entrada(e.condoA, e.u101, historico)], { skipExisting: false });
    expect((await facturaDe(e.u101))?.pdfUrl).toBe(historico);
    expect(await mensajeDe(guardar("adminA", [entrada(e.condoA, e.u102, historico)]))).toContain(MENSAJE_ARCHIVO_NO_AUTORIZADO);
    expect(await facturaDe(e.u102)).toBeUndefined();
  });
});

/* ── 10. Sustitución ──────────────────────────────────────────────────────── */

describe("10. Una sustitución autorizada usa un objeto nuevo y no borra el anterior", () => {
  test("re-carga con 'actualizar' y otro PDF: llave nueva, la factura apunta a ella y la anterior sigue en S3", async () => {
    const antes = await cargar101("adminA", pdf("versión 1"));
    const despues = await cargar101("adminA", pdf("versión 2"), { soloNuevas: false });
    expect(despues.key).not.toBe(antes.key);
    expect((await facturaDe(e.u101))?.pdfUrl).toBe(despues.publicUrl);
    expect(s3.objetos.has(antes.key)).toBe(true);
    expect(s3.objetos.has(despues.key)).toBe(true);
    expect(borrados()).toEqual([]);
    expect(await facturas()).toHaveLength(1);
  });
});

/* ── 11. Reintentos ───────────────────────────────────────────────────────── */

describe("11. Los reintentos no duplican nada ni invalidan lo guardado", () => {
  test("una importación que falló a medias se retoma: mismas llaves, una fila por llave, sin facturas duplicadas", async () => {
    const hash = huellaAlAzar();
    const casas = [
      { unidadId: e.u101, unidad: "101" },
      { unidadId: e.u102, unidad: "102" },
    ];
    const archivos = [
      { unidad: "101", bytes: pdf("101") },
      { unidad: "102", bytes: pdf("102") },
    ];
    const primera = await iniciar("adminA", e.condoA, casas, { hash });
    if (primera.tipo !== "nueva") throw new Error();
    const publicados = await publicar("adminA", primera.importacionId, archivos);
    // Se guardó el primer lote y se cortó antes del segundo.
    await guardar("adminA", [entrada(e.condoA, e.u101, publicados[0]!.publicUrl)], { importacionId: primera.importacionId });
    await cerrar("adminA", primera.importacionId, "fallida");

    // La contadora la retoma: misma importación, mismas llaves.
    const retomada = await iniciar("contadoraA", e.condoA, casas, { hash });
    if (retomada.tipo !== "nueva") throw new Error();
    expect(retomada.importacionId).toBe(primera.importacionId);
    expect(retomada.plan).toEqual([
      { indice: 0, accion: "omitir" },
      { indice: 1, accion: "insertar" },
    ]);
    const [de102] = await publicar("contadoraA", retomada.importacionId, [archivos[1]!]);
    expect(de102).toEqual(publicados[1]);
    await guardar("contadoraA", [entrada(e.condoA, e.u102, de102!.publicUrl)], { importacionId: retomada.importacionId });
    await cerrar("contadoraA", retomada.importacionId);

    expect(new Set(puts().map((p) => p.Key)).size).toBe(2);
    expect(s3.objetos.size).toBe(2);
    expect(await filas()).toHaveLength(2);
    expect(await facturas()).toHaveLength(2);
    expect((await facturaDe(e.u101))?.pdfUrl).toBe(publicados[0]!.publicUrl);
    expect((await facturaDe(e.u102))?.pdfUrl).toBe(publicados[1]!.publicUrl);
  });

  test("confirmar otra vez una carga completa: 'repetida', sin publicar ni guardar", async () => {
    const hash = huellaAlAzar();
    const inicio = await iniciar("adminA", e.condoA, [{ unidadId: e.u101, unidad: "101" }], { hash });
    if (inicio.tipo !== "nueva") throw new Error();
    const [publicado] = await publicar("adminA", inicio.importacionId, [{ unidad: "101", bytes: pdf() }]);
    await guardar("adminA", [entrada(e.condoA, e.u101, publicado!.publicUrl)], { importacionId: inicio.importacionId });
    await cerrar("adminA", inicio.importacionId);
    const putsAntes = puts().length;
    expect((await iniciar("adminA", e.condoA, [{ unidadId: e.u101, unidad: "101" }], { hash })).tipo).toBe("repetida");
    expect(puts()).toHaveLength(putsAntes);
    expect(await facturas()).toHaveLength(1);
  });

  test("guardar dos veces el mismo lote (doble envío): la segunda no falla ni cambia el PDF", async () => {
    const inicio = await iniciar("adminA", e.condoA, [{ unidadId: e.u101, unidad: "101" }], { soloNuevas: false });
    if (inicio.tipo !== "nueva") throw new Error();
    const [publicado] = await publicar("adminA", inicio.importacionId, [{ unidad: "101", bytes: pdf() }]);
    const lote = [entrada(e.condoA, e.u101, publicado!.publicUrl)];
    await guardar("adminA", lote, { importacionId: inicio.importacionId, skipExisting: false });
    await guardar("adminA", lote, { importacionId: inicio.importacionId, skipExisting: false });
    expect(await facturas()).toHaveLength(1);
    expect((await facturaDe(e.u101))?.pdfUrl).toBe(publicado!.publicUrl);
  });
});

/* ── 12. Fallos parciales ─────────────────────────────────────────────────── */

describe("12. Un fallo parcial no deja facturas rotas ni borra lo que se usa", () => {
  test("si falla una escritura en S3: error sin detalles de AWS, lo publicado queda registrado y el reintento completa", async () => {
    const inicio = await iniciar("adminA", e.condoA, [
      { unidadId: e.u101, unidad: "101" },
      { unidadId: e.u102, unidad: "102" },
    ]);
    if (inicio.tipo !== "nueva") throw new Error();
    const archivos = [
      { unidad: "101", bytes: pdf("101") },
      { unidad: "102", bytes: pdf("102") },
    ];
    // La escritura de la 102 falla (su llave: la de la importación y su huella).
    s3.fallan.add(`condominios/facturas/conjunto-a/${PERIODO}/${inicio.importacionId}/unidad-102-${(await sha256(archivos[1]!.bytes)).slice(0, 12)}.pdf`);
    const mensaje = await mensajeDe(publicar("adminA", inicio.importacionId, archivos));
    expect(mensaje).toContain("No se pudo publicar el PDF de una factura");
    expect(mensaje).not.toMatch(/AKIA|InternalError|us-east-1/);
    expect(await facturas()).toEqual([]);
    const registradas = await filas();
    expect(registradas.map((f) => f.key)).toEqual([expect.stringContaining("/unidad-101-")]);
    expect(registradas[0]!.registradaEn).toBeUndefined();

    // Se recupera S3 y se reintenta: la 101 se reconoce, la 102 se publica.
    s3.fallan.clear();
    const publicados = await publicar("adminA", inicio.importacionId, archivos);
    await guardar(
      "adminA",
      [entrada(e.condoA, e.u101, publicados[0]!.publicUrl), entrada(e.condoA, e.u102, publicados[1]!.publicUrl)],
      { importacionId: inicio.importacionId },
    );
    expect(await facturas()).toHaveLength(2);
    expect(await filas()).toHaveLength(2);
    expect(borrados()).toEqual([]);
  });

  test("un lote con un PDF que no corresponde no guarda NINGUNA factura del lote, ni gasta los buenos", async () => {
    const inicio = await iniciar("adminA", e.condoA, [
      { unidadId: e.u101, unidad: "101" },
      { unidadId: e.u102, unidad: "102" },
    ]);
    if (inicio.tipo !== "nueva") throw new Error();
    const [de101] = await publicar("adminA", inicio.importacionId, [{ unidad: "101", bytes: pdf("101") }]);
    expect(
      await mensajeDe(
        guardar(
          "adminA",
          [entrada(e.condoA, e.u101, de101!.publicUrl), entrada(e.condoA, e.u102, "https://archivos.test/102.pdf")],
          { importacionId: inicio.importacionId },
        ),
      ),
    ).toContain(MENSAJE_ARCHIVO_NO_AUTORIZADO);
    expect(await facturas()).toEqual([]);
    expect((await fila(de101!.key))?.registradaEn).toBeUndefined();
    const importacion = await e.t.run((ctx) => ctx.db.get(inicio.importacionId));
    expect(importacion).toMatchObject({ insertadas: 0, actualizadas: 0, rechazadas: 0 });
  });
});

/* ── 13. Las cargas legítimas ─────────────────────────────────────────────── */

describe("13. Las cargas legítimas siguen funcionando para los roles autorizados", () => {
  test("administración y contadora cargan varias facturas con su PDF, con la llave de siempre", async () => {
    const inicio = await iniciar("contadoraA", e.condoA, [
      { unidadId: e.u101, unidad: "101" },
      { unidadId: e.u102, unidad: "102" },
    ]);
    if (inicio.tipo !== "nueva") throw new Error();
    const publicados = await publicar("contadoraA", inicio.importacionId, [
      { unidad: "101", bytes: pdf("101") },
      { unidad: "102", bytes: pdf("102") },
    ]);
    for (const [i, casa] of ["101", "102"].entries()) {
      expect(publicados[i]!.key).toMatch(
        new RegExp(`^condominios/facturas/conjunto-a/${PERIODO}/${inicio.importacionId}/unidad-${casa}-[0-9a-f]{12}\\.pdf$`),
      );
      expect(publicados[i]!.publicUrl).toBe(`${BUCKET}/${publicados[i]!.key}`);
      expect(s3.objetos.get(publicados[i]!.key)).toMatchObject({ tipo: "application/pdf" });
    }
    const r = await guardar(
      "contadoraA",
      [entrada(e.condoA, e.u101, publicados[0]!.publicUrl), entrada(e.condoA, e.u102, publicados[1]!.publicUrl)],
      { importacionId: inicio.importacionId },
    );
    expect(r).toMatchObject({ inserted: 2, rechazadas: 0 });
    await cerrar("contadoraA", inicio.importacionId);

    // B, sin legacyId: bajo su _id.
    const deB = await iniciar("adminB", e.condoB, [{ unidadId: e.u201, unidad: "201" }]);
    if (deB.tipo !== "nueva") throw new Error();
    const [pdfB] = await publicar("adminB", deB.importacionId, [{ unidad: "201", bytes: pdf("201") }]);
    expect(pdfB!.key.startsWith(`condominios/facturas/${e.condoB}/${PERIODO}/${deB.importacionId}/`)).toBe(true);
    await guardar("adminB", [entrada(e.condoB, e.u201, pdfB!.publicUrl)], { importacionId: deB.importacionId });

    expect((await facturas()).map((f) => f.pdfUrl).sort()).toEqual(
      [publicados[0]!.publicUrl, publicados[1]!.publicUrl, pdfB!.publicUrl].sort(),
    );
    expect((await filas()).every((f) => f.registradaEn !== undefined)).toBe(true);
  });

  test("la factura manual con su PDF sigue por su camino (subida validada a la carpeta del conjunto)", async () => {
    const manual = await e.como("juntaA").action(api.files.uploadBytes, {
      folder: `condominios/facturas/${e.condoA}`,
      contentType: "application/pdf",
      fileName: "manual.pdf",
      bytes: buf(pdf("manual")),
    });
    await e.como("juntaA").mutation(api.facturas.createManual, {
      condominioId: e.condoA,
      unidadId: e.u101,
      periodo: PERIODO,
      fechaVencimiento: Date.now() + 30 * DIA,
      valor: 300_000,
      pdfUrl: manual.publicUrl,
    });
    expect((await facturaDe(e.u101))?.pdfUrl).toBe(manual.publicUrl);
  });
});

/* ── 14. Rechazos sin escrituras ──────────────────────────────────────────── */

describe("14. Los casos negativos no escriben en S3 ni en la base", () => {
  test("todos los rechazos juntos: ni un objeto, ni una factura, ni una fila de subidas", async () => {
    const inicio = await iniciar("adminA", e.condoA, [{ unidadId: e.u101, unidad: "101" }]);
    if (inicio.tipo !== "nueva") throw new Error();
    const importacionAntes = await e.t.run((ctx) => ctx.db.get(inicio.importacionId));
    const intentos: Promise<unknown>[] = [
      e.t.action(api.files.publicarFacturas, { importacionId: inicio.importacionId, pdfs: [{ unidad: "101", bytes: buf(pdf()) }] }),
      publicar("residenteA", inicio.importacionId, [{ unidad: "101", bytes: pdf() }]),
      publicar("adminB", inicio.importacionId, [{ unidad: "101", bytes: pdf() }]),
      publicar("adminA", inicio.importacionId, [{ unidad: "101", bytes: html() }]),
      guardar("adminA", [entrada(e.condoA, e.u101, "https://archivos.test/f.pdf")], { importacionId: inicio.importacionId }),
      guardar("adminA", [entrada(e.condoA, e.u101, `${BUCKET}/condominios/facturas/conjunto-a/${PERIODO}/${inicio.importacionId}/unidad-101-0a1b2c3d4e5f.pdf`)], {
        importacionId: inicio.importacionId,
      }),
      guardar("adminA", [entrada(e.condoA, e.u101, `${BUCKET}/condominios/facturas/conjunto-a/x.pdf`)]),
    ];
    for (const intento of intentos) await expect(intento).rejects.toThrow();
    await nadaEscrito();
    expect(await e.t.run((ctx) => ctx.db.get(inicio.importacionId))).toEqual(importacionAntes);
  });
});
