import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { MENSAJE_STORAGE_AJENO } from "../convex/model/files";

/**
 * CONVEX STORAGE HEREDADO — Fase 2 de S3 (H-16 de la auditoría,
 * qa/factory/auditoria-s3-2026-10-14; R-5 de la revisión de la Fase 1A).
 *
 * Las subidas a Convex Storage están cerradas, así que un `storageId` que
 * manda hoy el cliente es de un archivo que ya existía y no prueba de quién
 * es. La regla (`model/files.ts`):
 *   - asignar: solo el id que el registro ya tenía;
 *   - borrar: una referencia que vino del cliente se desvincula sin borrar el
 *     archivo; solo se borran ids que puso el servidor (acta, temporal).
 *
 * Dos conjuntos (A y B). Los archivos heredados se crean de verdad en el
 * Convex Storage simulado y lo que se mira es si siguen ahí.
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
let n = 0;
const llave = (carpeta: string, nombre = "archivo.jpg") =>
  `${carpeta}/${1760000000000 + n++}-0a1b2c3d-${nombre}`;

type Quien = "adminA" | "adminB" | "guardaA" | "guardaB" | "residenteA" | "residenteB";

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
    const membresia = (userId: Id<"users">, condominioId: Id<"condominios">, roles: string[]) =>
      ctx.db.insert("memberships", {
        userId,
        condominioId,
        roles: roles as never,
        isActive: true,
        createdAt: ahora,
        updatedAt: ahora,
      });
    const unidad = (condominioId: Id<"condominios">, numero: string) =>
      ctx.db.insert("unidades", {
        condominioId,
        tipo: "casa",
        estado: "ocupada",
        numero,
        createdAt: ahora,
        updatedAt: ahora,
      });

    const condoA = await conjunto("Conjunto A");
    const condoB = await conjunto("Conjunto B");
    const ids = {
      condoA,
      condoB,
      adminA: await persona("adminA"),
      adminB: await persona("adminB"),
      guardaA: await persona("guardaA"),
      guardaB: await persona("guardaB"),
      residenteA: await persona("residenteA"),
      residenteB: await persona("residenteB"),
      unidadA: await unidad(condoA, "101"),
      unidadB: await unidad(condoB, "201"),
    };
    await membresia(ids.adminA, condoA, ["administrador"]);
    await membresia(ids.adminB, condoB, ["administrador"]);
    await membresia(ids.guardaA, condoA, ["guardia"]);
    await membresia(ids.guardaB, condoB, ["guardia"]);
    await membresia(ids.residenteA, condoA, ["propietario"]);
    await membresia(ids.residenteB, condoB, ["propietario"]);
    return ids;
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

/* ── Archivos heredados y efectos ─────────────────────────────────────────── */

/** Un archivo "heredado" en Convex Storage (como los de antes de S3). */
const heredado = (texto: string) =>
  e.t.run((ctx) => ctx.storage.store(new Blob([texto], { type: "image/jpeg" })));

/** Si el archivo sigue en Convex Storage. */
const existe = (id: Id<"_storage">) =>
  e.t.run(async (ctx) => (await ctx.storage.get(id)) !== null);

/**
 * Ningún borrado de S3 programado ni ejecutado. (Un `ctx.storage.delete` se
 * ve en `existe`.)
 */
async function sinBorradosS3() {
  await new Promise((r) => setTimeout(r, 10));
  await e.t.finishInProgressScheduledFunctions();
  const programados = (
    await e.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())
  ).filter((f) => f.name.includes("deleteObjectInternal"));
  expect(programados).toEqual([]);
  expect(
    aws.send.mock.calls.filter(([c]) => c.constructor.name === "DeleteObjectCommand"),
  ).toEqual([]);
}

/* ── Datos sembrados como habrían quedado antes de esta fase ─────────────── */

const documentoDirecto = (condominioId: Id<"condominios">, storageId: Id<"_storage">) =>
  e.t.run((ctx) =>
    ctx.db.insert("documentos", {
      condominioId,
      nombre: "Reglamento",
      categoria: "reglamento",
      storageId,
      mimeType: "application/pdf",
      tamanio: 10,
      autorNombre: "x",
      createdAt: Date.now(),
    }),
  );

const comunicadoDirecto = (condominioId: Id<"condominios">, storageIds: Id<"_storage">[]) =>
  e.t.run((ctx) =>
    ctx.db.insert("comunicados", {
      condominioId,
      autorNombre: "x",
      titulo: "Aviso",
      cuerpo: "Texto",
      audiencia: "todos",
      prioridad: "normal",
      fijado: false,
      archivos: storageIds.map((storageId) => ({ storageId, mimeType: "image/jpeg", nombre: "a.jpg" })),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );

const paqueteDirecto = (
  condominioId: Id<"condominios">,
  fotos: { fotoStorageId?: Id<"_storage">; fotoEntregaStorageId?: Id<"_storage"> },
  estado: "recibido" | "entregado" = "recibido",
) =>
  e.t.run((ctx) =>
    ctx.db.insert("paquetes", {
      condominioId,
      unidadNumero: "101",
      tipo: "paquete",
      estado,
      recibidoPorNombre: "x",
      fechaRecibido: Date.now(),
      ...fotos,
    }),
  );

const edicion = { titulo: "Aviso", cuerpo: "Texto", audiencia: "todos" as const, prioridad: "normal" as const, fijado: false };
const adjunto = (storageId: Id<"_storage">) => ({ storageId, mimeType: "image/jpeg", nombre: "a.jpg" });

/* ── 1, 2, 7. Avatares y cuenta eliminada ─────────────────────────────────── */

describe("avatar: el storageId de otro no se asigna ni se borra", () => {
  test("asignar la foto de B: se rechaza y la foto de B sigue", async () => {
    const fotoB = await heredado("foto de B");
    await e.t.run((ctx) => ctx.db.patch(e.residenteB, { imageStorageId: fotoB }));

    await expect(
      e.como("residenteA").mutation(api.users.setMyAvatar, { storageId: fotoB }),
    ).rejects.toThrow(MENSAJE_STORAGE_AJENO);

    expect((await e.t.run((ctx) => ctx.db.get(e.residenteA)))!.imageStorageId).toBeUndefined();
    expect(await existe(fotoB)).toBe(true);
    await sinBorradosS3();
  });

  test("la foto de B puesta antes de esta fase: cambiarla, quitarla o eliminar la cuenta no la borra", async () => {
    const fotoB = await heredado("foto de B");
    await e.t.run((ctx) => ctx.db.patch(e.residenteB, { imageStorageId: fotoB }));
    const plantar = () => e.t.run((ctx) => ctx.db.patch(e.residenteA, { imageStorageId: fotoB }));

    await plantar();
    const propia = llave(`avatars/${e.residenteA}`);
    await e.como("residenteA").mutation(api.users.setMyAvatar, { url: url(propia), s3Key: propia });
    expect(await existe(fotoB)).toBe(true);

    await plantar();
    await e.como("residenteA").mutation(api.users.clearMyAvatar, {});
    expect(await existe(fotoB)).toBe(true);

    await plantar();
    await e.t.mutation(internal.users.anonymizeUserRecords, { authId: "residenteA" });
    expect(await existe(fotoB)).toBe(true);

    // B sigue con su foto.
    expect((await e.t.run((ctx) => ctx.db.get(e.residenteB)))!.imageStorageId).toBe(fotoB);
    // El borrado de la foto propia de S3 (Fase 1A) sí corrió: es lo único.
    await new Promise((r) => setTimeout(r, 10));
    await e.t.finishInProgressScheduledFunctions();
    const borradas = aws.send.mock.calls
      .map(([c]) => c)
      .filter((c) => c.constructor.name === "DeleteObjectCommand")
      .map((c) => c.input.Key);
    expect(borradas).toEqual([propia]);
  });

  test("eliminar la cuenta por el flujo completo (deleteMyAccount) tampoco borra la foto de otro", async () => {
    const fotoB = await heredado("foto de B");
    await e.t.run((ctx) => ctx.db.patch(e.residenteA, { imageStorageId: fotoB }));

    // La parte de Better Auth (borrar la identidad) no está montada en
    // convex-test; lo que importa aquí es lo que pasa con los archivos, que
    // ocurre antes, en `anonymizeUserRecords`.
    await e.como("residenteA").action(api.users.deleteMyAccount, {}).catch(() => undefined);

    const a = await e.t.run((ctx) => ctx.db.get(e.residenteA));
    expect(a).toMatchObject({ active: false, name: "Usuario eliminado" });
    expect(a!.imageStorageId).toBeUndefined();
    expect(await existe(fotoB)).toBe(true);
    await sinBorradosS3();
  });

  test("legítimo: con su foto heredada puede volver a ponerla, cambiarla por una de S3 y quitarla (se desvincula, no se borra)", async () => {
    const propia = await heredado("foto propia");
    await e.t.run((ctx) => ctx.db.patch(e.residenteA, { imageStorageId: propia }));

    // Reenviar la misma: vale.
    await e.como("residenteA").mutation(api.users.setMyAvatar, { storageId: propia });
    expect((await e.t.run((ctx) => ctx.db.get(e.residenteA)))!.imageStorageId).toBe(propia);

    // Cambiarla por una de S3: el registro queda limpio; el archivo heredado se queda.
    const s3 = llave(`avatars/${e.residenteA}`);
    await e.como("residenteA").mutation(api.users.setMyAvatar, { url: url(s3), s3Key: s3 });
    const a = await e.t.run((ctx) => ctx.db.get(e.residenteA));
    expect(a).toMatchObject({ image: url(s3), imageS3Key: s3 });
    expect(a!.imageStorageId).toBeUndefined();
    expect(await existe(propia)).toBe(true);

    await e.como("residenteA").mutation(api.users.clearMyAvatar, {});
    const limpio = await e.t.run((ctx) => ctx.db.get(e.residenteA));
    expect(limpio!.image).toBeUndefined();
    expect(limpio!.imageS3Key).toBeUndefined();
    // Quitarla sí borra su foto de S3 (Fase 1A); la heredada sigue.
    await new Promise((r) => setTimeout(r, 10));
    await e.t.finishInProgressScheduledFunctions();
    expect(
      aws.send.mock.calls
        .map(([c]) => c)
        .filter((c) => c.constructor.name === "DeleteObjectCommand")
        .map((c) => c.input.Key),
    ).toEqual([s3]);
    expect(await existe(propia)).toBe(true);
  });
});

/* ── 3, 6. Documentos ─────────────────────────────────────────────────────── */

describe("documentos: un archivo de otra entidad no se asigna ni se borra", () => {
  test("crear con el storageId de un documento de A (ni siquiera uno del propio conjunto): se rechaza", async () => {
    const deA = await heredado("reglamento de A");
    const deB = await heredado("reglamento de B");
    const docA = await documentoDirecto(e.condoA, deA);
    await documentoDirecto(e.condoB, deB);

    for (const storageId of [deA, deB]) {
      await expect(
        e.como("adminB").mutation(api.documentos.create, {
          condominioId: e.condoB,
          nombre: "Copia",
          categoria: "otro",
          storageId,
          mimeType: "application/pdf",
          tamanio: 10,
        }),
      ).rejects.toThrow(MENSAJE_STORAGE_AJENO);
    }
    expect(await existe(deA)).toBe(true);
    expect(await e.t.run((ctx) => ctx.db.get(docA))).not.toBeNull();
    await sinBorradosS3();
  });

  test("un documento de B guardado antes con el archivo de A: borrarlo no borra el de A, que se sigue viendo", async () => {
    const deA = await heredado("reglamento de A");
    await documentoDirecto(e.condoA, deA);
    const sembrado = await documentoDirecto(e.condoB, deA);

    await e.como("adminB").mutation(api.documentos.remove, { id: sembrado });

    expect(await e.t.run((ctx) => ctx.db.get(sembrado))).toBeNull();
    expect(await existe(deA)).toBe(true);
    const listaA = await e.como("adminA").query(api.documentos.listByCondominio, { condominioId: e.condoA });
    expect(listaA[0]!.url).not.toBe("");
    await sinBorradosS3();
  });

  test("la administración de B no puede borrar el documento de A", async () => {
    const deA = await heredado("reglamento de A");
    const docA = await documentoDirecto(e.condoA, deA);
    await expect(e.como("adminB").mutation(api.documentos.remove, { id: docA })).rejects.toThrow();
    expect(await e.t.run((ctx) => ctx.db.get(docA))).not.toBeNull();
    expect(await existe(deA)).toBe(true);
  });

  test("legítimo: la administración de A borra su documento heredado (se desvincula, el archivo queda)", async () => {
    const deA = await heredado("reglamento de A");
    const docA = await documentoDirecto(e.condoA, deA);
    await e.como("adminA").mutation(api.documentos.remove, { id: docA });
    expect(await e.t.run((ctx) => ctx.db.get(docA))).toBeNull();
    expect(await existe(deA)).toBe(true);
    await sinBorradosS3();
  });
});

/* ── 4, 10. Comunicados y archivos compartidos ────────────────────────────── */

describe("comunicados: adjuntos ajenos y compartidos", () => {
  test("crear o editar con un storageId que el comunicado no tenía: se rechaza", async () => {
    const deA = await heredado("adjunto de A");
    await comunicadoDirecto(e.condoA, [deA]);
    const propio = await comunicadoDirecto(e.condoB, []);

    await expect(
      e.como("adminB").mutation(api.comunicados.create, {
        condominioId: e.condoB,
        ...edicion,
        archivos: [adjunto(deA)],
      }),
    ).rejects.toThrow(MENSAJE_STORAGE_AJENO);
    await expect(
      e.como("adminB").mutation(api.comunicados.update, { id: propio, ...edicion, archivos: [adjunto(deA)] }),
    ).rejects.toThrow(MENSAJE_STORAGE_AJENO);

    expect((await e.t.run((ctx) => ctx.db.get(propio)))!.archivos).toEqual([]);
    expect(await existe(deA)).toBe(true);
    await sinBorradosS3();
  });

  test("uno de B guardado antes con el adjunto de A: quitarlo y borrarlo no lo borran", async () => {
    const deA = await heredado("adjunto de A");
    await comunicadoDirecto(e.condoA, [deA]);
    const sembrado = await comunicadoDirecto(e.condoB, [deA]);

    await e.como("adminB").mutation(api.comunicados.update, { id: sembrado, ...edicion, archivos: [] });
    expect(await existe(deA)).toBe(true);
    const otro = await comunicadoDirecto(e.condoB, [deA]);
    await e.como("adminB").mutation(api.comunicados.remove, { id: otro });
    expect(await existe(deA)).toBe(true);
    await sinBorradosS3();
  });

  test("legítimo: editar reenviando su adjunto heredado sigue funcionando; quitarlo lo desvincula", async () => {
    const [a1, a2] = [await heredado("uno"), await heredado("dos")];
    const id = await comunicadoDirecto(e.condoA, [a1, a2]);

    // Como el formulario web: reenvía los que ya tenía (con su URL resuelta).
    const resuelta = (await e.como("adminA").query(api.comunicados.listByCondominio, { condominioId: e.condoA }))[0]!
      .archivosItems[0]!.url;
    await e.como("adminA").mutation(api.comunicados.update, {
      id,
      ...edicion,
      titulo: "Editado",
      archivos: [{ ...adjunto(a1), url: resuelta }, adjunto(a2)],
    });
    expect((await e.t.run((ctx) => ctx.db.get(id)))!.titulo).toBe("Editado");

    await e.como("adminA").mutation(api.comunicados.update, { id, ...edicion, archivos: [adjunto(a2)] });
    expect((await e.t.run((ctx) => ctx.db.get(id)))!.archivos!.map((a) => a.storageId)).toEqual([a2]);
    expect(await existe(a1)).toBe(true);

    await e.como("adminA").mutation(api.comunicados.remove, { id });
    expect(await e.t.run((ctx) => ctx.db.get(id))).toBeNull();
    expect(await existe(a2)).toBe(true);
    await sinBorradosS3();
  });

  test("compartido: dos comunicados con el mismo archivo; borrar uno deja el archivo y el otro lo sigue mostrando", async () => {
    const comun = await heredado("compartido");
    const uno = await comunicadoDirecto(e.condoA, [comun]);
    await comunicadoDirecto(e.condoA, [comun]);

    await e.como("adminA").mutation(api.comunicados.remove, { id: uno });

    expect(await existe(comun)).toBe(true);
    const lista = await e.como("adminA").query(api.comunicados.listByCondominio, { condominioId: e.condoA });
    expect(lista).toHaveLength(1);
    expect(lista[0]!.archivosItems[0]!.url).not.toBe("");
  });
});

/* ── 5. Portería ──────────────────────────────────────────────────────────── */

describe("portería: fotos y adjuntos", () => {
  test("recibir o entregar un paquete con el storageId de otro: se rechaza", async () => {
    const deA = await heredado("foto de A");
    await paqueteDirecto(e.condoA, { fotoStorageId: deA });

    await expect(
      e.como("guardaB").mutation(api.guardia.recibirPaquete, {
        condominioId: e.condoB,
        unidadNumero: "201",
        tipo: "paquete",
        fotoStorageId: deA,
      }),
    ).rejects.toThrow(MENSAJE_STORAGE_AJENO);

    const propio = await e.como("guardaB").mutation(api.guardia.recibirPaquete, {
      condominioId: e.condoB,
      unidadNumero: "201",
      tipo: "paquete",
    });
    await expect(
      e.como("guardaB").mutation(api.guardia.entregarPaquete, { id: propio, fotoEntregaStorageId: deA }),
    ).rejects.toThrow(MENSAJE_STORAGE_AJENO);
    expect((await e.t.run((ctx) => ctx.db.get(propio)))!.estado).toBe("recibido");
    expect(await existe(deA)).toBe(true);
  });

  test("paquetes de B guardados antes con fotos de A: ni portería ni administración las borran", async () => {
    const [llegada, entrega] = [await heredado("llegada A"), await heredado("entrega A")];
    await paqueteDirecto(e.condoA, { fotoStorageId: llegada, fotoEntregaStorageId: entrega }, "entregado");

    const reciente = await paqueteDirecto(e.condoB, { fotoStorageId: llegada });
    await e.como("guardaB").mutation(api.guardia.eliminarPaqueteReciente, { id: reciente });
    const viejo = await paqueteDirecto(e.condoB, { fotoStorageId: llegada, fotoEntregaStorageId: entrega }, "entregado");
    await e.como("adminB").mutation(api.guardia.removePaquete, { id: viejo });

    expect(await e.t.run((ctx) => ctx.db.get(reciente))).toBeNull();
    expect(await e.t.run((ctx) => ctx.db.get(viejo))).toBeNull();
    expect(await existe(llegada)).toBe(true);
    expect(await existe(entrega)).toBe(true);
    await sinBorradosS3();
  });

  test("la portería de B no alcanza los paquetes de A", async () => {
    const deA = await heredado("foto de A");
    const paq = await paqueteDirecto(e.condoA, { fotoStorageId: deA });
    await expect(e.como("guardaB").mutation(api.guardia.eliminarPaqueteReciente, { id: paq })).rejects.toThrow();
    await expect(e.como("adminB").mutation(api.guardia.removePaquete, { id: paq })).rejects.toThrow();
    expect(await e.t.run((ctx) => ctx.db.get(paq))).not.toBeNull();
    expect(await existe(deA)).toBe(true);
  });

  test("depósito (registrar y devolver) y novedad con el storageId de otro: se rechazan", async () => {
    const deA = await heredado("foto de A");
    const ahora = Date.now();
    const reservaId = await e.t.run(async (ctx) => {
      const zonaId = await ctx.db.insert("zonasComunes", {
        condominioId: e.condoB,
        nombre: "Salón",
        activa: true,
        createdAt: ahora,
        updatedAt: ahora,
      });
      return await ctx.db.insert("reservas", {
        condominioId: e.condoB,
        unidadId: e.unidadB,
        zonaId,
        zonaNombre: "Salón",
        unidadNumero: "201",
        solicitanteNombre: "B",
        fecha: "2026-10-20",
        horaInicio: "09:00",
        horaFin: "12:00",
        estado: "aprobada",
        createdAt: ahora,
        updatedAt: ahora,
      });
    });

    await expect(
      e.como("guardaB").mutation(api.guardia.registrarDepositoReserva, { reservaId, monto: 50000, fotoStorageId: deA }),
    ).rejects.toThrow(MENSAJE_STORAGE_AJENO);
    await e.como("guardaB").mutation(api.guardia.registrarDepositoReserva, { reservaId, monto: 50000 });
    const dep = await e.t.run((ctx) =>
      ctx.db.query("guardiaReservaDepositos").withIndex("by_reserva", (q) => q.eq("reservaId", reservaId)).first(),
    );
    await expect(
      e.como("guardaB").mutation(api.guardia.resolverDepositoReserva, { depositoId: dep!._id, fotoStorageId: deA }),
    ).rejects.toThrow(MENSAJE_STORAGE_AJENO);
    expect((await e.t.run((ctx) => ctx.db.get(dep!._id)))!.estado).toBe("registrado");

    await expect(
      e.como("guardaB").mutation(api.guardia.reportarNovedad, {
        condominioId: e.condoB,
        titulo: "Daño",
        descripcion: "Algo",
        prioridad: "baja",
        archivoStorageId: deA,
      }),
    ).rejects.toThrow(MENSAJE_STORAGE_AJENO);
    expect(await existe(deA)).toBe(true);
  });
});

/* ── Otros que aceptaban storageId: poderes y factura manual ──────────────── */

describe("poderes y factura manual: un storageId del cliente se rechaza", () => {
  test("otorgar un poder o crear una factura manual con el archivo de otro", async () => {
    const deB = await heredado("archivo de B");
    const ahora = Date.now();
    const asambleaId = await e.t.run((ctx) =>
      ctx.db.insert("asambleas", {
        condominioId: e.condoA,
        titulo: "Ordinaria",
        tipo: "ordinaria",
        modalidad: "presencial",
        fecha: "2026-11-01",
        hora: "18:00",
        estado: "programada",
        agenda: [],
        createdAt: ahora,
        updatedAt: ahora,
      }),
    );
    await expect(
      e.como("adminA").mutation(api.asambleas.otorgarPoder, {
        asambleaId,
        unidadId: e.unidadA,
        apoderadoNombre: "Apoderado",
        documentoStorageId: deB,
      }),
    ).rejects.toThrow(MENSAJE_STORAGE_AJENO);
    await expect(
      e.como("adminA").mutation(api.facturas.createManual, {
        condominioId: e.condoA,
        unidadId: e.unidadA,
        periodo: "2026-10",
        fechaVencimiento: ahora,
        valor: 100000,
        pdfStorageId: deB,
      }),
    ).rejects.toThrow(MENSAJE_STORAGE_AJENO);
    expect(await e.t.run((ctx) => ctx.db.query("poderesAsamblea").collect())).toEqual([]);
    expect(await e.t.run((ctx) => ctx.db.query("facturas").collect())).toEqual([]);
    expect(await existe(deB)).toBe(true);
  });
});

/* ── 8. Borrados que sí corresponden ──────────────────────────────────────── */

describe("los ids que puso el servidor sí se borran", () => {
  test("acta de una asamblea: se borra con la asamblea, y solo por su administración", async () => {
    const acta = await heredado("acta");
    const ahora = Date.now();
    const asambleaId = await e.t.run((ctx) =>
      ctx.db.insert("asambleas", {
        condominioId: e.condoA,
        titulo: "Ordinaria",
        tipo: "ordinaria",
        modalidad: "presencial",
        fecha: "2026-11-01",
        hora: "18:00",
        estado: "finalizada",
        agenda: [],
        actaStorageId: acta,
        createdAt: ahora,
        updatedAt: ahora,
      }),
    );

    await expect(e.como("adminB").mutation(api.asambleas.remove, { id: asambleaId })).rejects.toThrow();
    expect(await existe(acta)).toBe(true);

    await e.como("adminA").mutation(api.asambleas.remove, { id: asambleaId });
    expect(await e.t.run((ctx) => ctx.db.get(asambleaId))).toBeNull();
    expect(await existe(acta)).toBe(false);
  });
});
