import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { MENSAJE_ARCHIVO_AJENO } from "../convex/model/s3";

/* Las carpetas tal como las mandan la web y el móvil al subir (el contrato
 * con los clientes, escrito aquí a propósito y no importado del backend). */
const carpetaAvatar = (userId: string) => `avatars/${userId}`;
const carpetaDocumentos = (id: string) => `condominios/documentos/${id}`;
const carpetaComunicados = (id: string) => `condominios/comunicados/${id}`;
const carpetaConsejo = (id: string) => `condominios/${id}/consejo`;

/**
 * BORRADO DE ARCHIVOS S3 — Fase 1A (C3 y H-04 de la auditoría de S3,
 * qa/factory/auditoria-s3-2026-10-14).
 *
 *   - Ya no hay borrado público por llave (`files.deleteObject`).
 *   - Los borrados indirectos (avatar, documentos, comunicados, consejo) solo
 *     alcanzan llaves de la carpeta de SU entidad, armada con datos de la
 *     base, y que ningún otro registro del conjunto siga usando.
 *
 * Dos conjuntos (A y B), cada uno con su administración y un residente. S3 y
 * la red, simulados: lo que se mira es qué `DeleteObject` llega a S3.
 */

const modules = import.meta.glob("../convex/**/*.ts");

const aws = vi.hoisted(() => ({ send: vi.fn() }));
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
  getSignedUrl: async () => "https://vekino.s3.us-east-1.amazonaws.com/firmada?X-Amz-Signature=x",
}));

const BUCKET = "https://vekino.s3.us-east-1.amazonaws.com";
const url = (key: string) => `${BUCKET}/${key}`;

/** Una llave con la forma de `files.ts` (`buildObjectKey`), distinta cada vez. */
let n = 0;
const llave = (carpeta: string, nombre = "archivo.pdf") =>
  `${carpeta}/${1760000000000 + n++}-0a1b2c3d-${nombre}`;

/** El retirado `files.deleteObject`, por su nombre: ya no está en `api`. */
const deleteObjectRetirado = makeFunctionReference<"action", { key: string }>(
  "files:deleteObject",
);

type Quien = "adminA" | "adminB" | "residenteA" | "residenteB";

async function montar() {
  const t = convexTest(schema, modules);
  const ahora = Date.now();
  const ids = await t.run(async (ctx) => {
    const conjunto = (name: string) =>
      ctx.db.insert("condominios", {
        name,
        activeModules: [],
        isActive: true,
        createdAt: ahora,
        updatedAt: ahora,
      });
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
    const membresia = (
      userId: Id<"users">,
      condominioId: Id<"condominios">,
      roles: string[],
    ) =>
      ctx.db.insert("memberships", {
        userId,
        condominioId,
        roles: roles as never,
        isActive: true,
        createdAt: ahora,
        updatedAt: ahora,
      });
    const categoria = (condominioId: Id<"condominios">) =>
      ctx.db.insert("consejoCategorias", {
        condominioId,
        nombre: "Actas",
        slug: "actas",
        orden: 0,
        activo: true,
        createdAt: ahora,
        updatedAt: ahora,
      });

    const condoA = await conjunto("Conjunto A");
    const condoB = await conjunto("Conjunto B");
    const adminA = await persona("adminA");
    const adminB = await persona("adminB");
    const residenteA = await persona("residenteA");
    const residenteB = await persona("residenteB");
    await membresia(adminA, condoA, ["administrador"]);
    await membresia(adminB, condoB, ["administrador"]);
    await membresia(residenteA, condoA, ["propietario"]);
    await membresia(residenteB, condoB, ["propietario"]);
    return {
      condoA,
      condoB,
      adminA,
      adminB,
      residenteA,
      residenteB,
      catA: await categoria(condoA),
      catB: await categoria(condoB),
    };
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
  // Nada sale a internet (p. ej. la difusión de un comunicado por WhatsApp).
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: unknown) => {
      throw new Error(`Red bloqueada: ${String(u)}`);
    }),
  );
  aws.send.mockReset().mockImplementation(async () => ({}));
  e = await montar();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** Deja correr los borrados que agendó la última mutación. */
async function correrProgramadas() {
  await new Promise((r) => setTimeout(r, 10));
  await e.t.finishInProgressScheduledFunctions();
}

/** Las llaves que llegaron a S3 en un `DeleteObject`. */
async function borradas(): Promise<string[]> {
  await correrProgramadas();
  return aws.send.mock.calls
    .map(([c]) => c)
    .filter((c) => c.constructor.name === "DeleteObjectCommand")
    .map((c) => (c.input as { Key: string }).Key);
}

/* ── Datos sembrados ──────────────────────────────────────────────────────── */

/** Un documento guardado tal cual (como habría quedado antes de esta fase). */
async function documentoDirecto(
  condominioId: Id<"condominios">,
  archivo: { s3Key?: string; url?: string },
) {
  return await e.t.run((ctx) =>
    ctx.db.insert("documentos", {
      condominioId,
      nombre: "Reglamento",
      categoria: "reglamento",
      mimeType: "application/pdf",
      tamanio: 10,
      autorNombre: "x",
      createdAt: Date.now(),
      ...archivo,
    }),
  );
}

async function comunicadoDirecto(
  condominioId: Id<"condominios">,
  archivos: { s3Key?: string; url?: string }[],
) {
  return await e.t.run((ctx) =>
    ctx.db.insert("comunicados", {
      condominioId,
      autorNombre: "x",
      titulo: "Aviso",
      cuerpo: "Texto",
      audiencia: "todos",
      prioridad: "normal",
      fijado: false,
      archivos: archivos.map((a) => ({ ...a, mimeType: "application/pdf", nombre: "a.pdf" })),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

async function consejoDirecto(
  condominioId: Id<"condominios">,
  categoriaId: Id<"consejoCategorias">,
  key: string,
) {
  return await e.t.run((ctx) =>
    ctx.db.insert("consejoDocumentos", {
      condominioId,
      categoriaId,
      titulo: "Acta",
      fileUrl: url(key),
      fileName: "acta.pdf",
      mimeType: "application/pdf",
      sizeBytes: 10,
      s3Key: key,
      version: 1,
      estado: "aprobado",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

const datosDocumento = (condominioId: Id<"condominios">, key: string) => ({
  condominioId,
  nombre: "Reglamento",
  categoria: "reglamento" as const,
  url: url(key),
  s3Key: key,
  mimeType: "application/pdf",
  tamanio: 10,
});

const datosComunicado = (
  condominioId: Id<"condominios">,
  keys: string[],
) => ({
  condominioId,
  titulo: "Aviso",
  cuerpo: "Texto",
  audiencia: "todos" as const,
  prioridad: "normal" as const,
  fijado: false,
  archivos: keys.map((k) => ({
    url: url(k),
    s3Key: k,
    mimeType: "application/pdf",
    nombre: "a.pdf",
  })),
});

const datosConsejo = (
  condominioId: Id<"condominios">,
  categoriaId: Id<"consejoCategorias">,
  key: string,
) => ({
  condominioId,
  categoriaId,
  titulo: "Acta",
  fileUrl: url(key),
  fileName: "acta.pdf",
  mimeType: "application/pdf",
  sizeBytes: 10,
  s3Key: key,
});

/* ── 1. API pública ───────────────────────────────────────────────────────── */

describe("borrado directo: no hay API pública por llave", () => {
  test("un usuario autenticado no puede borrar una llave ajena con files.deleteObject: la función ya no existe", async () => {
    const ajena = llave(carpetaDocumentos(e.condoA));
    await documentoDirecto(e.condoA, { s3Key: ajena, url: url(ajena) });

    for (const quien of ["residenteB", "adminB", "adminA"] as const) {
      await expect(
        e.como(quien).action(deleteObjectRetirado, { key: ajena }),
      ).rejects.toThrow();
    }
    expect(await borradas()).toEqual([]);
    // `api` responde a cualquier nombre: lo que cuenta es lo que exporta el módulo.
    const files = (await modules["../convex/files.ts"]!()) as Record<string, unknown>;
    expect(files).not.toHaveProperty("deleteObject");
    expect(files).toHaveProperty("deleteObjectInternal");
  });
});

/* ── 2. Borrados indirectos entre conjuntos ───────────────────────────────── */

describe("borrado indirecto: otro conjunto no alcanza los archivos de A", () => {
  test("documentos: la llave de A se rechaza al crear en B, y un registro de B que la tenga no la borra", async () => {
    const deA = llave(carpetaDocumentos(e.condoA));
    await documentoDirecto(e.condoA, { s3Key: deA, url: url(deA) });

    await expect(
      e.como("adminB").mutation(api.documentos.create, datosDocumento(e.condoB, deA)),
    ).rejects.toThrow(MENSAJE_ARCHIVO_AJENO);

    // Con solo la URL (no hay llave que revisar) se guarda, pero no borra.
    const soloUrl = await e.como("adminB").mutation(api.documentos.create, {
      ...datosDocumento(e.condoB, deA),
      s3Key: undefined,
    });
    await e.como("adminB").mutation(api.documentos.remove, { id: soloUrl });

    // Y uno guardado antes de esta fase con la llave de A, tampoco.
    const sembrado = await documentoDirecto(e.condoB, { s3Key: deA, url: url(deA) });
    await e.como("adminB").mutation(api.documentos.remove, { id: sembrado });

    expect(await borradas()).toEqual([]);
  });

  test("comunicados: la llave de A se rechaza en B al crear y al editar, y quitarla o borrar el comunicado no la borra", async () => {
    const deA = llave(carpetaComunicados(e.condoA));
    await comunicadoDirecto(e.condoA, [{ s3Key: deA, url: url(deA) }]);

    await expect(
      e.como("adminB").mutation(api.comunicados.create, datosComunicado(e.condoB, [deA])),
    ).rejects.toThrow(MENSAJE_ARCHIVO_AJENO);

    const propio = await e.como("adminB").mutation(
      api.comunicados.create,
      datosComunicado(e.condoB, []),
    );
    const { condominioId: _c, ...edicion } = datosComunicado(e.condoB, [deA]);
    await expect(
      e.como("adminB").mutation(api.comunicados.update, { id: propio, ...edicion }),
    ).rejects.toThrow(MENSAJE_ARCHIVO_AJENO);

    // Sembrado con la llave de A: quitar el adjunto y borrar no la tocan.
    const sembrado = await comunicadoDirecto(e.condoB, [{ s3Key: deA, url: url(deA) }]);
    await e.como("adminB").mutation(api.comunicados.update, {
      id: sembrado,
      ...edicion,
      archivos: [],
    });
    const otro = await comunicadoDirecto(e.condoB, [{ url: url(deA) }]);
    await e.como("adminB").mutation(api.comunicados.remove, { id: otro });

    expect(await borradas()).toEqual([]);
  });

  test("consejo: la llave de A se rechaza en B (documento y versión) y borrar en B no la toca", async () => {
    const deA = llave(carpetaConsejo(e.condoA));
    await consejoDirecto(e.condoA, e.catA, deA);

    await expect(
      e.como("adminB").mutation(api.consejo.createDocumento, datosConsejo(e.condoB, e.catB, deA)),
    ).rejects.toThrow(MENSAJE_ARCHIVO_AJENO);

    const propio = await e.como("adminB").mutation(
      api.consejo.createDocumento,
      datosConsejo(e.condoB, e.catB, llave(carpetaConsejo(e.condoB))),
    );
    await expect(
      e.como("adminB").mutation(api.consejo.nuevaVersion, {
        id: propio,
        fileUrl: url(deA),
        fileName: "acta.pdf",
        mimeType: "application/pdf",
        sizeBytes: 10,
        s3Key: deA,
      }),
    ).rejects.toThrow(MENSAJE_ARCHIVO_AJENO);

    const sembrado = await consejoDirecto(e.condoB, e.catB, deA);
    await e.como("adminB").mutation(api.consejo.removeVersion, { documentoId: sembrado });
    const otro = await consejoDirecto(e.condoB, e.catB, deA);
    await e.como("adminB").mutation(api.consejo.removeDocumento, { id: otro });

    expect(await borradas()).toEqual([]);
  });

  test("la administración de B no puede borrar los registros de A", async () => {
    const deA = llave(carpetaDocumentos(e.condoA));
    const doc = await documentoDirecto(e.condoA, { s3Key: deA, url: url(deA) });
    await expect(
      e.como("adminB").mutation(api.documentos.remove, { id: doc }),
    ).rejects.toThrow();
    expect(await borradas()).toEqual([]);
  });
});

/* ── 3. Avatar ────────────────────────────────────────────────────────────── */

describe("avatar: cambiar o quitar la foto nunca borra la de otro usuario", () => {
  test("la subida va a la carpeta de quien sube, pida la carpeta que pida", async () => {
    for (const folder of ["avatars", `avatars/${e.residenteB}`]) {
      const subida = await e.como("residenteA").action(api.files.generateUploadUrl, {
        folder,
        contentType: "image/jpeg",
        fileName: "yo.jpg",
      });
      expect(subida.key.startsWith(`${carpetaAvatar(e.residenteA)}/`)).toBe(true);
      expect(subida.publicUrl).toBe(url(subida.key));
    }
    const bytes = await e.como("residenteA").action(api.files.uploadBytes, {
      folder: "avatars",
      contentType: "image/jpeg",
      fileName: "yo.jpg",
      bytes: new Uint8Array([255, 216, 255]).buffer,
    });
    expect(bytes.key.startsWith(`${carpetaAvatar(e.residenteA)}/`)).toBe(true);

    // Las demás carpetas no cambian.
    const doc = await e.como("adminA").action(api.files.generateUploadUrl, {
      folder: carpetaDocumentos(e.condoA),
      contentType: "application/pdf",
    });
    expect(doc.key.startsWith(`${carpetaDocumentos(e.condoA)}/`)).toBe(true);
  });

  test("la llave de otro usuario se rechaza; con solo su URL no queda como propia; y quitarla no la borra", async () => {
    const deA = llave(carpetaAvatar(e.residenteA), "yo.jpg");
    await e.como("residenteA").mutation(api.users.setMyAvatar, { url: url(deA), s3Key: deA });

    await expect(
      e.como("residenteB").mutation(api.users.setMyAvatar, { url: url(deA), s3Key: deA }),
    ).rejects.toThrow(MENSAJE_ARCHIVO_AJENO);

    await e.como("residenteB").mutation(api.users.setMyAvatar, { url: url(deA) });
    const b = await e.t.run((ctx) => ctx.db.get(e.residenteB));
    expect(b!.imageS3Key).toBeUndefined();
    await e.como("residenteB").mutation(api.users.clearMyAvatar, {});

    // Con la URL ajena puesta por `updateMyProfile`, tampoco.
    await e.como("residenteB").mutation(api.users.updateMyProfile, { image: url(deA) });
    await e.como("residenteB").mutation(api.users.clearMyAvatar, {});

    expect(await borradas()).toEqual([]);
  });

  test("una llave ajena guardada antes de esta fase no se borra al cambiar, quitar ni eliminar la cuenta", async () => {
    const deA = llave(carpetaAvatar(e.residenteA), "yo.jpg");
    const plantar = () =>
      e.t.run((ctx) => ctx.db.patch(e.residenteB, { image: url(deA), imageS3Key: deA }));

    await plantar();
    const nueva = llave(carpetaAvatar(e.residenteB), "yo.jpg");
    await e.como("residenteB").mutation(api.users.setMyAvatar, { url: url(nueva), s3Key: nueva });
    await plantar();
    await e.como("residenteB").mutation(api.users.clearMyAvatar, {});
    await plantar();
    await e.t.mutation(internal.users.anonymizeUserRecords, { authId: "residenteB" });

    expect(await borradas()).toEqual([]);
  });

  test("tampoco una foto de antes de la carpeta por usuario (no se puede atribuir)", async () => {
    const vieja = llave("avatars", "yo.jpg");
    await e.t.run((ctx) =>
      ctx.db.patch(e.residenteA, { image: url(vieja), imageS3Key: vieja }),
    );
    await e.como("residenteA").mutation(api.users.clearMyAvatar, {});
    expect(await borradas()).toEqual([]);
  });
});

/* ── 4. Borrados legítimos ────────────────────────────────────────────────── */

describe("los borrados de archivos propios siguen funcionando", () => {
  test("avatar: subir, cambiar (borra la anterior), quitar (borra la actual) y eliminar la cuenta", async () => {
    const subir = async () => {
      const { key, publicUrl } = await e.como("residenteA").action(api.files.generateUploadUrl, {
        folder: "avatars",
        contentType: "image/jpeg",
        fileName: "yo.jpg",
      });
      return { key, publicUrl };
    };
    const primera = await subir();
    await e.como("residenteA").mutation(api.users.setMyAvatar, {
      url: primera.publicUrl,
      s3Key: primera.key,
    });
    const segunda = await subir();
    // Como un build viejo que manda solo la URL: la llave sale de la URL.
    await e.como("residenteA").mutation(api.users.setMyAvatar, { url: segunda.publicUrl });
    expect(await borradas()).toEqual([primera.key]);

    aws.send.mockClear();
    await e.como("residenteA").mutation(api.users.clearMyAvatar, {});
    expect(await borradas()).toEqual([segunda.key]);

    aws.send.mockClear();
    const tercera = await subir();
    await e.como("residenteA").mutation(api.users.setMyAvatar, {
      url: tercera.publicUrl,
      s3Key: tercera.key,
    });
    await e.t.mutation(internal.users.anonymizeUserRecords, { authId: "residenteA" });
    expect(await borradas()).toEqual([tercera.key]);
  });

  test("documentos: borrar el documento borra su archivo; si otro documento lo usa, espera al último", async () => {
    const k = llave(carpetaDocumentos(e.condoA));
    const id = await e.como("adminA").mutation(api.documentos.create, datosDocumento(e.condoA, k));
    await e.como("adminA").mutation(api.documentos.remove, { id });
    expect(await borradas()).toEqual([k]);

    aws.send.mockClear();
    const compartida = llave(carpetaDocumentos(e.condoA));
    const uno = await e.como("adminA").mutation(api.documentos.create, datosDocumento(e.condoA, compartida));
    const dos = await e.como("adminA").mutation(api.documentos.create, datosDocumento(e.condoA, compartida));
    await e.como("adminA").mutation(api.documentos.remove, { id: uno });
    expect(await borradas()).toEqual([]);
    await e.como("adminA").mutation(api.documentos.remove, { id: dos });
    expect(await borradas()).toEqual([compartida]);
  });

  test("comunicados: quitar un adjunto borra solo ese; borrar el comunicado, los que quedan", async () => {
    const [k1, k2] = [llave(carpetaComunicados(e.condoA)), llave(carpetaComunicados(e.condoA))];
    const id = await e.como("adminA").mutation(
      api.comunicados.create,
      datosComunicado(e.condoA, [k1, k2]),
    );
    const { condominioId: _c, ...edicion } = datosComunicado(e.condoA, [k2]);
    await e.como("adminA").mutation(api.comunicados.update, { id, ...edicion });
    expect(await borradas()).toEqual([k1]);

    aws.send.mockClear();
    await e.como("adminA").mutation(api.comunicados.remove, { id });
    expect(await borradas()).toEqual([k2]);
  });

  test("comunicados: editar reenviando un adjunto de antes (otra carpeta) no falla y no lo borra", async () => {
    const viejo = "comunicados/adjunto-de-antes.pdf";
    const id = await comunicadoDirecto(e.condoA, [{ s3Key: viejo, url: url(viejo) }]);
    const { condominioId: _c, ...edicion } = datosComunicado(e.condoA, []);
    await e.como("adminA").mutation(api.comunicados.update, {
      id,
      ...edicion,
      archivos: [{ s3Key: viejo, url: url(viejo), mimeType: "application/pdf", nombre: "a.pdf" }],
    });
    expect(await borradas()).toEqual([]);
  });

  test("consejo: borrar una versión archivada, la actual (restaura la anterior) y el documento entero", async () => {
    const [v1, v2, v3] = [1, 2, 3].map(() => llave(carpetaConsejo(e.condoA)));
    const id = await e.como("adminA").mutation(
      api.consejo.createDocumento,
      datosConsejo(e.condoA, e.catA, v1),
    );
    const version = (k: string) =>
      e.como("adminA").mutation(api.consejo.nuevaVersion, {
        id,
        fileUrl: url(k),
        fileName: "acta.pdf",
        mimeType: "application/pdf",
        sizeBytes: 10,
        s3Key: k,
      });
    await version(v2);
    await version(v3);

    // Archivada (v1).
    const archivadas = await e.t.run((ctx) =>
      ctx.db
        .query("consejoDocumentoVersiones")
        .withIndex("by_documento", (q) => q.eq("documentoId", id))
        .collect(),
    );
    const deV1 = archivadas.find((a) => a.s3Key === v1)!;
    await e.como("adminA").mutation(api.consejo.removeVersion, { documentoId: id, versionId: deV1._id });
    expect(await borradas()).toEqual([v1]);

    // La actual (v3): se borra y vuelve v2, que sigue en uso.
    aws.send.mockClear();
    await e.como("adminA").mutation(api.consejo.removeVersion, { documentoId: id });
    expect(await borradas()).toEqual([v3]);
    expect((await e.t.run((ctx) => ctx.db.get(id)))!.s3Key).toBe(v2);

    // El documento entero.
    aws.send.mockClear();
    await e.como("adminA").mutation(api.consejo.removeDocumento, { id });
    expect(await borradas()).toEqual([v2]);
  });
});

/* ── 5. Operaciones internas ──────────────────────────────────────────────── */

describe("las operaciones internas siguen funcionando", () => {
  test("files.deleteObjectInternal borra la llave que le pasa el servidor", async () => {
    const k = llave(carpetaDocumentos(e.condoA));
    await e.t.action(internal.files.deleteObjectInternal, { key: k });
    expect(aws.send.mock.calls.map(([c]) => c.input)).toEqual([{ Bucket: "vekino", Key: k }]);
  });

  test("las subidas fuera de avatares conservan su carpeta (comprobantes del bot, documentos)", async () => {
    const subida = await e.como("adminA").action(api.files.uploadBytes, {
      folder: carpetaComunicados(e.condoA),
      contentType: "application/pdf",
      bytes: new Uint8Array([37, 80, 68, 70, 45]).buffer,
    });
    expect(subida.key.startsWith(`${carpetaComunicados(e.condoA)}/`)).toBe(true);
    expect(aws.send.mock.calls[0]![0].input).toMatchObject({ Bucket: "vekino", Key: subida.key });
  });
});

/* ── 6. Solicitudes inválidas ─────────────────────────────────────────────── */

describe("las llaves inválidas no producen ningún DeleteObject", () => {
  test("rutas con `..`, subcarpetas, otra entidad, otro bucket u otro dominio", async () => {
    const carpeta = carpetaDocumentos(e.condoA);
    const invalidas = [
      `${carpeta}/../../facturas/${e.condoA}/2026-09/unidad-101.pdf`,
      `${carpeta}/sub/${llave("x").split("/").pop()}`,
      `${carpeta}//${llave("x").split("/").pop()}`,
      llave(`condominios/facturas/${e.condoA}`),
      llave(carpetaComunicados(e.condoA)),
      `${carpeta}/factura.pdf`,
    ];
    for (const k of invalidas) {
      await expect(
        e.como("adminA").mutation(api.documentos.create, datosDocumento(e.condoA, k)),
      ).rejects.toThrow(MENSAJE_ARCHIVO_AJENO);
      const sembrado = await documentoDirecto(e.condoA, { s3Key: k });
      await e.como("adminA").mutation(api.documentos.remove, { id: sembrado });
    }
    const buena = llave(carpeta);
    for (const ajena of [
      `https://otro-bucket.s3.us-east-1.amazonaws.com/${buena}`,
      `https://ejemplo.com/${buena}`,
    ]) {
      const sembrado = await documentoDirecto(e.condoA, { url: ajena });
      await e.como("adminA").mutation(api.documentos.remove, { id: sembrado });
    }
    expect(await borradas()).toEqual([]);
  });

  test("sin sesión no se borra nada", async () => {
    const k = llave(carpetaDocumentos(e.condoA));
    const doc = await documentoDirecto(e.condoA, { s3Key: k, url: url(k) });
    await expect(e.t.mutation(api.documentos.remove, { id: doc })).rejects.toThrow();
    await expect(e.t.mutation(api.users.clearMyAvatar, {})).rejects.toThrow();
    await expect(e.t.action(deleteObjectRetirado, { key: k })).rejects.toThrow();
    expect(await borradas()).toEqual([]);
  });
});
