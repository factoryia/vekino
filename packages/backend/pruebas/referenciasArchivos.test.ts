import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { MENSAJE_COMPROBANTE_URL } from "../convex/lib/comprobantes";
import { MENSAJE_ARCHIVO_NO_AUTORIZADO } from "../convex/model/registroArchivos";
import { MENSAJE_ARCHIVO_AJENO } from "../convex/model/s3";
import { URL_BUCKET, subidaValidada } from "./helpers/subidas";

/**
 * CADA ARCHIVO REGISTRADO SALE DE UNA SUBIDA AUTORIZADA — Fase 4 de S3
 * (H-12 acotado, qa/factory/auditoria-s3-2026-10-14).
 *
 * Antes, las mutaciones guardaban la URL que mandara el cliente: la de otro
 * conjunto, la de otra persona, una externa o una que nunca se subió. Ahora
 * un archivo NUEVO solo se registra si hay una subida validada (el servidor
 * leyó sus bytes) de quien registra, a la carpeta de ESA entidad y uso, sin
 * vencer, sin usar (salvo los poderes) y con la URL exacta que se le devolvió
 * (`model/registroArchivos.ts`). Lo que el registro ya tenía se conserva.
 *
 * Las subidas se siembran ya validadas (`helpers/subidas.ts`): cómo se
 * validan lo prueban `contenidoSubidas.test.ts` y `subidasAutorizadas.test.ts`.
 * S3 y la red, simulados.
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

type Quien = "adminA" | "adminB" | "residenteA" | "vecinoA" | "residenteB" | "guardaA" | "plataforma";

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
      return unidadId;
    };

    const condoA = await conjunto("A");
    const condoB = await conjunto("B");
    const u = {
      adminA: await persona("adminA"),
      adminB: await persona("adminB"),
      residenteA: await persona("residenteA"),
      vecinoA: await persona("vecinoA"),
      residenteB: await persona("residenteB"),
      guardaA: await persona("guardaA"),
      plataforma: await persona("plataforma", "admin"),
    };
    await membresia(u.adminA, condoA, ["administrador"]);
    await membresia(u.adminB, condoB, ["administrador"]);
    await membresia(u.guardaA, condoA, ["guardia"]);
    const mResidenteA = await membresia(u.residenteA, condoA, ["propietario"]);
    const u101 = await casa(mResidenteA, condoA, "101");
    const u102 = await casa(mResidenteA, condoA, "102");
    const u103 = await casa(await membresia(u.vecinoA, condoA, ["propietario"]), condoA, "103");
    await casa(await membresia(u.residenteB, condoB, ["propietario"]), condoB, "201");
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
    const asambleaA = await ctx.db.insert("asambleas", {
      condominioId: condoA,
      titulo: "Ordinaria",
      tipo: "ordinaria",
      modalidad: "virtual",
      fecha: "2026-11-01",
      hora: "18:00",
      estado: "programada",
      agenda: [],
      createdAt: ahora,
      updatedAt: ahora,
    });
    return { condoA, condoB, u101, u102, u103, asambleaA, catA: await categoria(condoA), catB: await categoria(condoB), ...u };
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

/* ── Carpetas (el contrato con los clientes) y subidas ────────────────────── */

const soportes = (c: string) => `condominios/soportes/${c}`;
const docs = (c: string) => `condominios/documentos/${c}`;
const comunicados = (c: string) => `condominios/comunicados/${c}`;
const consejo = (c: string) => `condominios/${c}/consejo`;
const iconos = (c: string) => `condominios/${c}/consejo/icons`;
const paquetes = (c: string) => `condominios/guardia/${c}/paquetes`;
const novedades = (c: string) => `condominios/guardia/${c}/novedades`;
const poderes = (c: string) => `condominios/asambleas/${c}/poderes`;
const avatar = (u: string) => `avatars/${u}`;

/** Una subida que `quien` hizo a `carpeta` y que el servidor ya validó. */
const sube = (quien: Quien, carpeta: string, nombre?: string) =>
  subidaValidada(e.t, { userId: e[quien], carpeta, nombre });

const subida = (key: string) =>
  e.t.run((ctx) => ctx.db.query("subidasPendientes").withIndex("by_key", (q) => q.eq("key", key)).first());
const sinUsar = async (key: string) => expect((await subida(key))?.registradaEn).toBeUndefined();
const usada = async (key: string) => expect((await subida(key))?.registradaEn).toEqual(expect.any(Number));

const cuantos = (tabla: "documentos" | "comunicados" | "soportesPago" | "consejoDocumentos" | "paquetes" | "poderesAsamblea") =>
  e.t.run(async (ctx) => (await ctx.db.query(tabla).collect()).length);

async function mensajeDe(promesa: Promise<unknown>): Promise<string> {
  try {
    await promesa;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("Se esperaba un rechazo y la llamada pasó.");
}

/* ── Lo que mandan los clientes ───────────────────────────────────────────── */

const documento = (quien: Quien, condominioId: Id<"condominios">, archivo: { url?: string; s3Key?: string }) =>
  e.como(quien).mutation(api.documentos.create, {
    condominioId,
    nombre: "Reglamento",
    categoria: "reglamento",
    url: archivo.url ?? "",
    ...(archivo.s3Key ? { s3Key: archivo.s3Key } : {}),
    mimeType: "application/pdf",
    tamanio: 10,
  });

const adjunto = (a: { url: string; key?: string }) => ({
  url: a.url,
  ...(a.key ? { s3Key: a.key } : {}),
  mimeType: "application/pdf",
  nombre: "circular.pdf",
});
const datosComunicado = (archivos: { url: string; key?: string }[]) => ({
  titulo: "Aviso",
  cuerpo: "Texto",
  audiencia: "todos" as const,
  prioridad: "normal" as const,
  fijado: false,
  archivos: archivos.map(adjunto),
});
const comunicado = (quien: Quien, condominioId: Id<"condominios">, archivos: { url: string; key?: string }[]) =>
  e.como(quien).mutation(api.comunicados.create, { condominioId, ...datosComunicado(archivos) });

const consejoDocumento = (quien: Quien, condominioId: Id<"condominios">, categoriaId: Id<"consejoCategorias">, a: { url: string; key?: string }) =>
  e.como(quien).mutation(api.consejo.createDocumento, {
    condominioId,
    categoriaId,
    titulo: "Acta",
    fileUrl: a.url,
    fileName: "acta.pdf",
    mimeType: "application/pdf",
    sizeBytes: 10,
    ...(a.key ? { s3Key: a.key } : {}),
  });

const comprobante = (quien: Quien, condominioId: Id<"condominios">, url: string) =>
  e.como(quien).mutation(api.soportesPago.crearMio, { condominioId, url, mimeType: "application/pdf" });

const paquete = (fotoUrl: string) =>
  e.como("guardaA").mutation(api.guardia.recibirPaquete, {
    condominioId: e.condoA,
    unidadNumero: "101",
    unidadId: e.u101,
    tipo: "paquete",
    fotoUrl,
  });

const poder = (quien: Quien, unidadId: Id<"unidades">, documentoUrl: string) =>
  e.como(quien).mutation(api.asambleas.otorgarPoder, {
    asambleaId: e.asambleaA,
    unidadId,
    documentoUrl,
    apoderadoNombre: "Pedro Pérez",
  });

/* ── 8. De otro conjunto, o de otra persona ───────────────────────────────── */

describe("8. Un archivo de B, o de otra persona, no se registra como propio en A", () => {
  test("comprobante: ni la subida validada del residente de B ni la de un vecino de A", async () => {
    const deB = await sube("residenteB", soportes(e.condoB), "pago.pdf");
    const delVecino = await sube("vecinoA", soportes(e.condoA), "pago.pdf");

    expect(await mensajeDe(comprobante("residenteA", e.condoA, deB.url))).toContain(MENSAJE_COMPROBANTE_URL);
    expect(await mensajeDe(comprobante("residenteA", e.condoA, delVecino.url))).toContain(MENSAJE_ARCHIVO_NO_AUTORIZADO);
    expect(await cuantos("soportesPago")).toBe(0);
    await sinUsar(deB.key);
    await sinUsar(delVecino.key);

    // El dueño de cada una sí la registra.
    await comprobante("vecinoA", e.condoA, delVecino.url);
    await comprobante("residenteB", e.condoB, deB.url);
  });

  test("documentos, comunicados y consejo de A: la llave o la URL validada de B se rechazan", async () => {
    const docB = await sube("adminB", docs(e.condoB));
    const comB = await sube("adminB", comunicados(e.condoB));
    const conB = await sube("adminB", consejo(e.condoB));

    expect(await mensajeDe(documento("adminA", e.condoA, { url: docB.url, s3Key: docB.key }))).toContain(MENSAJE_ARCHIVO_AJENO);
    expect(await mensajeDe(documento("adminA", e.condoA, { url: docB.url }))).toContain(MENSAJE_ARCHIVO_NO_AUTORIZADO);
    expect(await mensajeDe(comunicado("adminA", e.condoA, [comB]))).toContain(MENSAJE_ARCHIVO_AJENO);
    expect(await mensajeDe(comunicado("adminA", e.condoA, [{ url: comB.url }]))).toContain(MENSAJE_ARCHIVO_NO_AUTORIZADO);
    expect(await mensajeDe(consejoDocumento("adminA", e.condoA, e.catA, conB))).toContain(MENSAJE_ARCHIVO_AJENO);
    expect(await mensajeDe(consejoDocumento("adminA", e.condoA, e.catA, { url: conB.url }))).toContain(MENSAJE_ARCHIVO_NO_AUTORIZADO);

    expect(await cuantos("documentos")).toBe(0);
    expect(await cuantos("comunicados")).toBe(0);
    expect(await cuantos("consejoDocumentos")).toBe(0);
    for (const s of [docB, comB, conB]) await sinUsar(s.key);
  });

  test("la foto de perfil de otra persona no se pone como propia, ni por setMyAvatar ni por updateMyProfile", async () => {
    const deB = await sube("residenteB", avatar(e.residenteB), "yo.jpg");
    expect(await mensajeDe(e.como("residenteA").mutation(api.users.setMyAvatar, { url: deB.url }))).toContain(
      MENSAJE_ARCHIVO_NO_AUTORIZADO,
    );
    expect(await mensajeDe(e.como("residenteA").mutation(api.users.updateMyProfile, { image: deB.url }))).toContain(
      MENSAJE_ARCHIVO_NO_AUTORIZADO,
    );
    expect((await e.t.run((ctx) => ctx.db.get(e.residenteA)))!.image).toBeUndefined();
    await sinUsar(deB.key);
  });
});

/* ── 9. Parámetros manipulados ────────────────────────────────────────────── */

describe("9. Una URL o una llave manipuladas no se asocian a un registro", () => {
  test("la misma llave en otro host, con ? o #, por http, con otra forma o codificada: no; la URL exacta, sí", async () => {
    const propia = await sube("adminA", docs(e.condoA), "acta.pdf");
    const ruta = propia.key;
    for (const url of [
      `https://vekino.s3.otro-sitio.test/${ruta}`,
      `https://vekino.s3.us-east-1.amazonaws.com.otro-sitio.test/${ruta}`,
      `${propia.url}?descarga=1`,
      `${propia.url}#pagina=2`,
      `http://vekino.s3.us-east-1.amazonaws.com/${ruta}`,
      `https://vekino.s3.amazonaws.com/${ruta}`,
      `https://s3.us-east-1.amazonaws.com/vekino/${ruta}`,
      `${URL_BUCKET}//${ruta}`,
      `${URL_BUCKET}/${encodeURIComponent(ruta)}`,
    ]) {
      expect(await mensajeDe(documento("adminA", e.condoA, { url, s3Key: ruta })), url).toContain(MENSAJE_ARCHIVO_NO_AUTORIZADO);
      expect(await mensajeDe(documento("adminA", e.condoA, { url })), url).toContain(MENSAJE_ARCHIVO_NO_AUTORIZADO);
    }
    expect(await cuantos("documentos")).toBe(0);
    await sinUsar(propia.key);

    await documento("adminA", e.condoA, { url: propia.url, s3Key: propia.key });
    await usada(propia.key);
  });

  test("URL y llave de objetos distintos, o una URL externa con una llave buena: no", async () => {
    const una = await sube("adminA", docs(e.condoA));
    const otra = await sube("adminA", docs(e.condoA));
    expect(await mensajeDe(documento("adminA", e.condoA, { url: una.url, s3Key: otra.key }))).toContain(MENSAJE_ARCHIVO_NO_AUTORIZADO);
    expect(await mensajeDe(documento("adminA", e.condoA, { url: "https://archivos.test/acta.pdf", s3Key: una.key }))).toContain(
      MENSAJE_ARCHIVO_NO_AUTORIZADO,
    );
    expect(await cuantos("documentos")).toBe(0);
    await sinUsar(una.key);
    await sinUsar(otra.key);
  });

  test("al editar, una URL manipulada de la foto o del logo actuales no pasa por 'la misma'", async () => {
    const foto = await sube("residenteA", avatar(e.residenteA), "yo.jpg");
    await e.como("residenteA").mutation(api.users.setMyAvatar, { url: foto.url, s3Key: foto.key });
    expect(
      await mensajeDe(e.como("residenteA").mutation(api.users.setMyAvatar, { url: `https://vekino.s3.otro-sitio.test/${foto.key}` })),
    ).toContain(MENSAJE_ARCHIVO_NO_AUTORIZADO);
    expect((await e.t.run((ctx) => ctx.db.get(e.residenteA)))!.image).toBe(foto.url);

    const logo = await sube("plataforma", `condominios/${e.condoA}/logo`, "logo.png");
    await e.como("plataforma").mutation(api.condominios.update, { condominioId: e.condoA, patch: { logo: logo.url } });
    expect(
      await mensajeDe(
        e.como("plataforma").mutation(api.condominios.update, { condominioId: e.condoA, patch: { logo: `${logo.url}?v=2` } }),
      ),
    ).toContain(MENSAJE_ARCHIVO_NO_AUTORIZADO);
    expect((await e.t.run((ctx) => ctx.db.get(e.condoA)))!.logo).toBe(logo.url);
  });
});

/* ── 10. Otro uso ─────────────────────────────────────────────────────────── */

describe("10. Una subida para un uso no se registra en otro", () => {
  test("de comunicados a documentos, y de documentos al consejo, en el mismo conjunto: no", async () => {
    const deComunicado = await sube("adminA", comunicados(e.condoA));
    const deDocumentos = await sube("adminA", docs(e.condoA));
    expect(await mensajeDe(documento("adminA", e.condoA, { url: deComunicado.url }))).toContain(MENSAJE_ARCHIVO_NO_AUTORIZADO);
    expect(await mensajeDe(documento("adminA", e.condoA, { url: deComunicado.url, s3Key: deComunicado.key }))).toContain(
      MENSAJE_ARCHIVO_AJENO,
    );
    expect(await mensajeDe(consejoDocumento("adminA", e.condoA, e.catA, { url: deDocumentos.url }))).toContain(
      MENSAJE_ARCHIVO_NO_AUTORIZADO,
    );
    await sinUsar(deComunicado.key);
    await sinUsar(deDocumentos.key);
  });

  test("la foto de un paquete no sirve como archivo de una novedad", async () => {
    const delPaquete = await sube("guardaA", paquetes(e.condoA), "caja.jpg");
    expect(
      await mensajeDe(
        e.como("guardaA").mutation(api.guardia.reportarNovedad, {
          condominioId: e.condoA,
          titulo: "Puerta dañada",
          descripcion: "No cierra.",
          prioridad: "alta",
          archivoUrl: delPaquete.url,
        }),
      ),
    ).toContain(MENSAJE_ARCHIVO_NO_AUTORIZADO);
    await sinUsar(delPaquete.key);
    // En su uso, sí.
    await paquete(delPaquete.url);
    await usada(delPaquete.key);
  });

  test("un comprobante no es una foto de perfil, ni al revés", async () => {
    const pago = await sube("residenteA", soportes(e.condoA), "pago.jpg");
    const foto = await sube("residenteA", avatar(e.residenteA), "yo.jpg");
    expect(await mensajeDe(e.como("residenteA").mutation(api.users.setMyAvatar, { url: pago.url }))).toContain(
      MENSAJE_ARCHIVO_NO_AUTORIZADO,
    );
    expect(await mensajeDe(comprobante("residenteA", e.condoA, foto.url))).toContain(MENSAJE_COMPROBANTE_URL);
    await sinUsar(pago.key);
    await sinUsar(foto.key);
  });
});

/* ── 11. Un solo uso ──────────────────────────────────────────────────────── */

describe("11. Una subida se registra una vez (los poderes, por diseño, más)", () => {
  test("documentos: el segundo registro con la misma subida se rechaza", async () => {
    const s = await sube("adminA", docs(e.condoA));
    await documento("adminA", e.condoA, { url: s.url, s3Key: s.key });
    expect(await mensajeDe(documento("adminA", e.condoA, { url: s.url, s3Key: s.key }))).toContain(MENSAJE_ARCHIVO_NO_AUTORIZADO);
    expect(await cuantos("documentos")).toBe(1);
  });

  test("comprobante: la misma URL dos veces, no; una subida nueva, sí", async () => {
    const s = await sube("residenteA", soportes(e.condoA), "pago.pdf");
    await comprobante("residenteA", e.condoA, s.url);
    expect(await mensajeDe(comprobante("residenteA", e.condoA, s.url))).toContain(MENSAJE_ARCHIVO_NO_AUTORIZADO);
    await comprobante("residenteA", e.condoA, (await sube("residenteA", soportes(e.condoA), "pago.pdf")).url);
    expect(await cuantos("soportesPago")).toBe(2);
  });

  test("comunicados: ni en dos comunicados ni dos veces en el mismo", async () => {
    const s = await sube("adminA", comunicados(e.condoA));
    expect(await mensajeDe(comunicado("adminA", e.condoA, [s, s]))).toContain(MENSAJE_ARCHIVO_NO_AUTORIZADO);
    await sinUsar(s.key);
    await comunicado("adminA", e.condoA, [s]);
    expect(await mensajeDe(comunicado("adminA", e.condoA, [s]))).toContain(MENSAJE_ARCHIVO_NO_AUTORIZADO);
    expect(await cuantos("comunicados")).toBe(1);
  });

  test("poder: el mismo documento firmado sirve para las casas de quien lo subió, no para otro", async () => {
    const firmado = await sube("residenteA", poderes(e.condoA), "poder.pdf");
    await poder("residenteA", e.u101, firmado.url);
    await poder("residenteA", e.u102, firmado.url);
    expect(await mensajeDe(poder("vecinoA", e.u103, firmado.url))).toContain(MENSAJE_ARCHIVO_NO_AUTORIZADO);
    expect(await cuantos("poderesAsamblea")).toBe(2);
  });
});

/* ── 12. Editar sin cambiar archivos ──────────────────────────────────────── */

describe("12. Editar sin cambiar los archivos sigue funcionando", () => {
  test("comunicado: se edita el texto y se reenvían sus adjuntos (en otro orden), sin subir nada", async () => {
    const [a, b] = [await sube("adminA", comunicados(e.condoA)), await sube("adminA", comunicados(e.condoA))];
    const id = await comunicado("adminA", e.condoA, [a, b]);
    await e.como("adminA").mutation(api.comunicados.update, { id, ...datosComunicado([b, a]), titulo: "Aviso corregido" });
    const guardado = await e.t.run((ctx) => ctx.db.get(id));
    expect(guardado!.titulo).toBe("Aviso corregido");
    expect(guardado!.archivos!.map((x) => x.s3Key)).toEqual([b.key, a.key]);
  });

  test("perfil, logo, portada e ícono del consejo: reenviar los mismos vale; quitarlos también", async () => {
    const foto = await sube("residenteA", avatar(e.residenteA), "yo.jpg");
    await e.como("residenteA").mutation(api.users.setMyAvatar, { url: foto.url, s3Key: foto.key });
    await e.como("residenteA").mutation(api.users.setMyAvatar, { url: foto.url, s3Key: foto.key });
    await e.como("residenteA").mutation(api.users.updateMyProfile, { firstName: "Ana", image: foto.url });

    const logo = await sube("plataforma", `condominios/${e.condoA}/logo`, "logo.png");
    const portada = await sube("plataforma", `condominios/${e.condoA}/cover`, "portada.jpg");
    const editar = (patch: { logo?: string; coverImage?: string; name?: string }) =>
      e.como("plataforma").mutation(api.condominios.update, { condominioId: e.condoA, patch });
    await editar({ logo: logo.url, coverImage: portada.url });
    await editar({ logo: logo.url, coverImage: portada.url, name: "Conjunto A" });
    await editar({ logo: "", coverImage: "" });
    expect(await e.t.run((ctx) => ctx.db.get(e.condoA))).toMatchObject({ name: "Conjunto A" });

    const icono = await sube("adminA", iconos(e.condoA), "icono.png");
    const cat = await e.como("adminA").mutation(api.consejo.createCategoria, {
      condominioId: e.condoA,
      nombre: "Contratos",
      iconType: "image",
      iconValue: icono.url,
    });
    await e.como("adminA").mutation(api.consejo.updateCategoria, {
      id: cat,
      nombre: "Contratos vigentes",
      iconType: "image",
      iconValue: icono.url,
    });
  });
});

/* ── 13. Compartidos e históricos ─────────────────────────────────────────── */

describe("13. Adjuntos históricos y compartidos, con reglas explícitas", () => {
  test("un adjunto de antes (URL externa): editar conservándolo funciona; ponerlo en otro comunicado, no", async () => {
    const viejo = "https://archivos.test/circular-2024.pdf";
    const id = await e.t.run((ctx) =>
      ctx.db.insert("comunicados", {
        condominioId: e.condoA,
        autorNombre: "x",
        ...datosComunicado([{ url: viejo }]),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    await e.como("adminA").mutation(api.comunicados.update, { id, ...datosComunicado([{ url: viejo }]), titulo: "Aviso 2024" });
    expect((await e.t.run((ctx) => ctx.db.get(id)))!.archivos!.map((x) => x.url)).toEqual([viejo]);

    expect(await mensajeDe(comunicado("adminA", e.condoA, [{ url: viejo }]))).toContain(MENSAJE_ARCHIVO_NO_AUTORIZADO);
    // Y uno nuevo junto al histórico tiene que ser una subida.
    expect(
      await mensajeDe(
        e.como("adminA").mutation(api.comunicados.update, {
          id,
          ...datosComunicado([{ url: viejo }, { url: `${URL_BUCKET}/${comunicados(e.condoA)}/1700000000000-0a1b2c3d-otro.pdf` }]),
        }),
      ),
    ).toContain(MENSAJE_ARCHIVO_NO_AUTORIZADO);
  });

  test("una URL del bucket que ya está en la base (de otro registro, o de una carpeta vieja) no queda autorizada por estar ahí", async () => {
    const enOtro = await sube("adminA", docs(e.condoA));
    await documento("adminA", e.condoA, { url: enOtro.url, s3Key: enOtro.key });
    const vieja = `${URL_BUCKET}/documentos/reglamento-2019.pdf`;
    await e.t.run((ctx) =>
      ctx.db.insert("documentos", {
        condominioId: e.condoA,
        nombre: "Reglamento 2019",
        categoria: "reglamento",
        url: vieja,
        mimeType: "application/pdf",
        tamanio: 10,
        autorNombre: "x",
        createdAt: Date.now(),
      }),
    );
    expect(await mensajeDe(documento("adminA", e.condoA, { url: enOtro.url }))).toContain(MENSAJE_ARCHIVO_NO_AUTORIZADO);
    expect(await mensajeDe(documento("adminA", e.condoA, { url: vieja }))).toContain(MENSAJE_ARCHIVO_NO_AUTORIZADO);
    expect(await mensajeDe(comunicado("adminA", e.condoA, [{ url: vieja }]))).toContain(MENSAJE_ARCHIVO_NO_AUTORIZADO);
    expect(await cuantos("documentos")).toBe(2);
  });
});

/* ── 14. Rechazos sin escrituras a medias ─────────────────────────────────── */

describe("14. Una solicitud rechazada no escribe, no publica y no gasta subidas", () => {
  test("comunicado con un adjunto bueno y uno ajeno: no se crea y el bueno queda sin usar", async () => {
    const bueno = await sube("adminA", comunicados(e.condoA));
    const ajeno = await sube("adminB", comunicados(e.condoB));
    expect(await mensajeDe(comunicado("adminA", e.condoA, [bueno, { url: ajeno.url }]))).toContain(MENSAJE_ARCHIVO_NO_AUTORIZADO);
    expect(await cuantos("comunicados")).toBe(0);
    await sinUsar(bueno.key);
    await sinUsar(ajeno.key);
    await comunicado("adminA", e.condoA, [bueno]);
    await usada(bueno.key);
  });

  test("conjunto con un logo bueno y una portada ajena: no cambia nada y el logo queda sin usar", async () => {
    const logo = await sube("plataforma", `condominios/${e.condoA}/logo`, "logo.png");
    const portadaDeB = await sube("plataforma", `condominios/${e.condoB}/cover`, "portada.jpg");
    expect(
      await mensajeDe(
        e.como("plataforma").mutation(api.condominios.update, {
          condominioId: e.condoA,
          patch: { name: "Otro nombre", logo: logo.url, coverImage: portadaDeB.url },
        }),
      ),
    ).toContain(MENSAJE_ARCHIVO_NO_AUTORIZADO);
    expect(await e.t.run((ctx) => ctx.db.get(e.condoA))).toMatchObject({ name: "A" });
    expect((await e.t.run((ctx) => ctx.db.get(e.condoA)))!.logo).toBeUndefined();
    await sinUsar(logo.key);
  });

  test("los rechazos no tocan S3 ni agendan borrados, y no dejan paquetes ni documentos", async () => {
    const ajena = await sube("adminB", docs(e.condoB));
    await mensajeDe(documento("adminA", e.condoA, { url: ajena.url }));
    await mensajeDe(paquete(`${URL_BUCKET}/${paquetes(e.condoA)}/1700000000000-0a1b2c3d-caja.jpg`));
    await mensajeDe(paquete((await sube("guardaA", novedades(e.condoA), "nota.pdf")).url));
    expect(await cuantos("documentos")).toBe(0);
    expect(await cuantos("paquetes")).toBe(0);
    expect(aws.send).not.toHaveBeenCalled();
    const programadas = await e.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(programadas.filter((f) => f.name.includes("deleteObject"))).toEqual([]);
  });
});
