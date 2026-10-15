import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import {
  MAX_COMPROBANTE_BYTES,
  MENSAJE_COMPROBANTE_GRANDE,
  MENSAJE_COMPROBANTE_TIPO,
  MENSAJE_COMPROBANTE_URL,
  MENSAJE_COMPROBANTE_VACIO,
  tipoPorContenido,
} from "../../convex/lib/comprobantes";
import { MENSAJE_ARCHIVO_NO_AUTORIZADO } from "../../convex/model/registroArchivos";
import { MENSAJE_COMPROBANTE_HISTORICA } from "../../convex/soportesPago";
import {
  AHORA,
  DIA,
  bloquearRed,
  bogota,
  cargar,
  comprobanteSubido,
  facturaDe,
  fijarReloj,
  liberarRed,
  linea,
  montar,
  soltarReloj,
  type Escenario,
} from "./escenario";

/**
 * EL COMPROBANTE DE LA WEB SE SUBE DESDE EL BACKEND — Hallazgo 1, segunda
 * ronda (docs/audits/FALTANTES-WEB-FACTURACION.md).
 *
 * `soportesPago.enviarMio` recibe el archivo y los datos, valida con las
 * reglas de `crearMio`, sube con una llave del servidor y registra
 * revalidando. `crearMio` (el móvil) ahora exige una URL del bucket y de la
 * carpeta de su conjunto. S3 simulado; la red, bloqueada.
 */

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
/* `generateUploadUrl` firma con el presigner: aquí solo importa la URL pública. */
vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: async () => "https://vekino.s3.us-east-1.amazonaws.com/firmada?X-Amz-Signature=x",
}));

const BUCKET = "https://vekino.s3.us-east-1.amazonaws.com";
const MENSAJE_PENDIENTE = "Ya tienes un comprobante en revisión para esta factura.";
const mediodia = (dia: string) => Date.parse(`${dia}T12:00:00-05:00`);

beforeEach(() => {
  bloquearRed();
  fijarReloj();
  vi.stubEnv("AWS_S3_BUCKET_NAME", "vekino");
  vi.stubEnv("AWS_REGION", "us-east-1");
  vi.stubEnv("AWS_ACCESS_KEY_ID", "fake");
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "fake-secret");
  /* Las apps instaladas no mandan el tamaño: su enlace es la ruta
   * /archivos/subida del backend (H-06). Convex inyecta esta variable. */
  vi.stubEnv("CONVEX_SITE_URL", "https://vekino-pruebas.convex.site");
  aws.send.mockReset().mockImplementation(async () => ({}));
});

afterEach(() => {
  vi.unstubAllEnvs();
  soltarReloj();
  liberarRed();
});

/* ── Archivos de prueba, por sus primeros bytes ───────────────────────────── */

function conCabecera(cabecera: number[] | string, tamano: number): ArrayBuffer {
  const inicio = typeof cabecera === "string" ? [...cabecera].map((c) => c.charCodeAt(0)) : cabecera;
  const b = new Uint8Array(tamano).fill(0x20);
  b.set(inicio.slice(0, tamano));
  return b.buffer;
}
const pdf = (tamano = 2_048) => conCabecera("%PDF-1.7\n", tamano);
const jpeg = (tamano = 2_048) => conCabecera([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46], tamano);
const png = () => conCabecera([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 512);
const webp = () => conCabecera("RIFF\x00\x00\x00\x00WEBPVP8 ", 512);
const heic = () => conCabecera("\x00\x00\x00\x18ftypheic", 512);

/* ── Escenario ────────────────────────────────────────────────────────────── */

async function conSeptiembre() {
  const esc = await montar();
  await cargar(esc, [{ periodo: "2026-09", lineas: [linea("CUOTA", 0, 380_000)] }]);
  return { esc, septiembre: await facturaDe(esc, "2026-09") };
}

/** Lo que manda la web. */
function envio(esc: Escenario, facturaId: Id<"facturas">, extra: Record<string, unknown> = {}) {
  return {
    condominioId: esc.condominioId,
    facturaId,
    monto: 150_000,
    fechaPago: mediodia("2026-10-07"),
    nombreArchivo: "Pago PSE.pdf",
    archivo: pdf(),
    ...extra,
  };
}

/** Lo mismo por `crearMio`, con una URL que sí es del bucket. */
function porCrearMio(esc: Escenario, facturaId: Id<"facturas">, extra: Record<string, unknown> = {}) {
  return {
    condominioId: esc.condominioId,
    facturaId,
    url: `${BUCKET}/condominios/soportes/${esc.condominioId}/1791565200000-a1b2c3d4-comprobante.pdf`,
    mimeType: "application/pdf",
    monto: 150_000,
    fechaPago: mediodia("2026-10-07"),
    ...extra,
  };
}

const comandos = (nombre: "PutObjectCommand" | "DeleteObjectCommand") =>
  aws.send.mock.calls.map(([c]) => c).filter((c) => c.constructor.name === nombre).map((c) => c.input);
const almacenTemporal = (esc: Escenario) => esc.t.run(async (ctx) => await ctx.db.system.query("_storage").collect());
const soportes = (esc: Escenario) => esc.t.run(async (ctx) => await ctx.db.query("soportesPago").collect());

async function mensajeDe(promesa: Promise<unknown>): Promise<string> {
  try {
    await promesa;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error("Se esperaba un rechazo y la llamada pasó.");
}

async function conPersona(
  esc: Escenario,
  authId: string,
  vinculo: { unidadId: Id<"unidades">; vigenciaHasta?: number } | null,
) {
  await esc.t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      name: authId,
      email: `${authId}@vekino.test`,
      emailVerified: true,
      active: true,
      authId,
      createdAt: AHORA,
      updatedAt: AHORA,
    });
    const membershipId = await ctx.db.insert("memberships", {
      userId,
      condominioId: esc.condominioId,
      roles: ["arrendatario"],
      isActive: true,
      createdAt: AHORA,
      updatedAt: AHORA,
    });
    if (vinculo) {
      await ctx.db.insert("usuarioUnidad", {
        membershipId,
        unidadId: vinculo.unidadId,
        condominioId: esc.condominioId,
        vinculo: "arrendatario",
        esPrincipal: true,
        vigenciaDesde: AHORA - 400 * DIA,
        ...(vinculo.vigenciaHasta !== undefined ? { vigenciaHasta: vinculo.vigenciaHasta } : {}),
        createdAt: AHORA,
      });
    }
  });
  return esc.t.withIdentity({ subject: authId });
}

// ─────────────────────────────────────────────────────────────────────────────

describe("Tipo por contenido, no por lo que diga el cliente", () => {
  test("JPEG, PNG, WebP y PDF por su firma; HEIC, texto y vacío, no", () => {
    expect(tipoPorContenido(jpeg())).toBe("image/jpeg");
    expect(tipoPorContenido(png())).toBe("image/png");
    expect(tipoPorContenido(webp())).toBe("image/webp");
    expect(tipoPorContenido(pdf())).toBe("application/pdf");
    expect(tipoPorContenido(heic())).toBeNull();
    expect(tipoPorContenido(conCabecera("hola, no soy un PDF", 64))).toBeNull();
    expect(tipoPorContenido(new ArrayBuffer(0))).toBeNull();
    /* "RIFF" sin "WEBP" (un WAV, un AVI) no es WebP. */
    expect(tipoPorContenido(conCabecera("RIFF\x00\x00\x00\x00WAVEfmt ", 64))).toBeNull();
  });
});

describe("enviarMio · envío correcto", () => {
  test("llave del servidor bajo la carpeta del conjunto, ContentType detectado y el comprobante con sus datos", async () => {
    const { esc, septiembre } = await conSeptiembre();
    const id = await esc.como("residente").action(api.soportesPago.enviarMio, envio(esc, septiembre._id, { nota: "  Pagué por PSE  " }));

    const [put, ...otros] = comandos("PutObjectCommand");
    expect(otros).toHaveLength(0);
    expect(put).toMatchObject({ Bucket: "vekino", ContentType: "application/pdf" });
    expect(put!.Key).toMatch(new RegExp(`^condominios/soportes/${esc.condominioId}/${AHORA}-[0-9a-f]{8}-Pago-PSE\\.pdf$`));
    expect((put!.Body as Buffer).byteLength).toBe(2_048);
    expect(comandos("DeleteObjectCommand")).toHaveLength(0);

    const guardado = await esc.t.run(async (ctx) => await ctx.db.get(id));
    expect(guardado).toMatchObject({
      condominioId: esc.condominioId,
      unidadId: esc.u101,
      facturaId: septiembre._id,
      userId: esc.residenteId,
      origen: "web",
      url: `${BUCKET}/${put!.Key}`,
      mimeType: "application/pdf",
      nota: "Pagué por PSE",
      monto: 150_000,
      fechaPago: mediodia("2026-10-07"),
      estado: "pendiente_revision",
    });
    /* El paso por el almacenamiento interno no deja nada. */
    expect(await almacenTemporal(esc)).toHaveLength(0);
    /* Y el residente lo ve en "Mis comprobantes". */
    const mios = await esc.como("residente").query(api.soportesPago.listMios, { condominioId: esc.condominioId });
    expect(mios.map((s) => [s._id, s.estado, s.monto])).toEqual([[id, "pendiente_revision", 150_000]]);
  });

  test("el tipo sale de los bytes: una foto llamada .pdf se guarda como JPEG; sin nombre, 'file'", async () => {
    const { esc, septiembre } = await conSeptiembre();
    const id = await esc.como("residente").action(
      api.soportesPago.enviarMio,
      envio(esc, septiembre._id, { archivo: jpeg(), nombreArchivo: undefined }),
    );
    const [put] = comandos("PutObjectCommand");
    expect(put).toMatchObject({ ContentType: "image/jpeg" });
    expect(put!.Key).toMatch(/-file$/);
    expect((await esc.t.run(async (ctx) => await ctx.db.get(id)))?.mimeType).toBe("image/jpeg");
  });

  test("justo 10 MB se acepta", async () => {
    const { esc, septiembre } = await conSeptiembre();
    await esc.como("residente").action(api.soportesPago.enviarMio, envio(esc, septiembre._id, { archivo: pdf(MAX_COMPROBANTE_BYTES) }));
    expect((comandos("PutObjectCommand")[0]!.Body as Buffer).byteLength).toBe(MAX_COMPROBANTE_BYTES);
  });
});

describe("enviarMio · rechazos: cero llamadas a S3 y el mismo mensaje que crearMio", () => {
  type Caso = {
    nombre: string;
    preparar: (esc: Escenario, septiembre: Id<"facturas">) => Promise<{
      quien: ReturnType<Escenario["t"]["withIdentity"]> | Escenario["t"];
      facturaId: Id<"facturas">;
      extra?: Record<string, unknown>;
    }>;
    mensaje: string;
  };
  const CASOS: Caso[] = [
    {
      nombre: "sin sesión",
      preparar: async (esc, f) => ({ quien: esc.t, facturaId: f }),
      mensaje: "No autenticado o perfil inexistente.",
    },
    {
      nombre: "sin vínculo con ninguna unidad",
      preparar: async (esc, f) => ({ quien: await conPersona(esc, "sinvinculo", null), facturaId: f }),
      mensaje: "No tienes unidades vinculadas en este condominio.",
    },
    {
      nombre: "arrendataria con el contrato vencido",
      preparar: async (esc, f) => ({
        quien: await conPersona(esc, "arrendataria", { unidadId: esc.u101, vigenciaHasta: AHORA - 10 * DIA }),
        facturaId: f,
      }),
      mensaje: "No tienes unidades vinculadas en este condominio.",
    },
    {
      nombre: "vecino de otra casa",
      preparar: async (esc, f) => ({ quien: esc.como("vecino"), facturaId: f }),
      mensaje: "Esa factura no pertenece a tu unidad.",
    },
    {
      nombre: "factura histórica",
      preparar: async (esc) => {
        await cargar(esc, [{ periodo: "2026-10", lineas: [linea("CUOTA", 380_000, 380_000)] }]);
        return { quien: esc.como("residente"), facturaId: (await facturaDe(esc, "2026-09"))._id };
      },
      mensaje: MENSAJE_COMPROBANTE_HISTORICA,
    },
    {
      nombre: "ya hay uno pendiente",
      preparar: async (esc, f) => {
        await esc
          .como("residente")
          .mutation(api.soportesPago.crearMio, porCrearMio(esc, f, { url: await comprobanteSubido(esc) }));
        aws.send.mockClear();
        return { quien: esc.como("residente"), facturaId: f };
      },
      mensaje: MENSAJE_PENDIENTE,
    },
    {
      nombre: "monto en cero",
      preparar: async (esc, f) => ({ quien: esc.como("residente"), facturaId: f, extra: { monto: 0 } }),
      mensaje: "El monto pagado debe ser mayor que cero.",
    },
    {
      nombre: "monto negativo",
      preparar: async (esc, f) => ({ quien: esc.como("residente"), facturaId: f, extra: { monto: -5_000 } }),
      mensaje: "El monto pagado debe ser mayor que cero.",
    },
    {
      nombre: "fecha futura",
      preparar: async (esc, f) => ({ quien: esc.como("residente"), facturaId: f, extra: { fechaPago: AHORA + 2 * DIA } }),
      mensaje: "La fecha del pago no es válida.",
    },
    {
      nombre: "orden: monto en cero y factura histórica → primero el monto, como en crearMio",
      preparar: async (esc) => {
        await cargar(esc, [{ periodo: "2026-10", lineas: [linea("CUOTA", 380_000, 380_000)] }]);
        return { quien: esc.como("residente"), facturaId: (await facturaDe(esc, "2026-09"))._id, extra: { monto: 0 } };
      },
      mensaje: "El monto pagado debe ser mayor que cero.",
    },
  ];

  for (const caso of CASOS) {
    test(caso.nombre, async () => {
      const { esc, septiembre } = await conSeptiembre();
      const { quien, facturaId, extra = {} } = await caso.preparar(esc, septiembre._id);
      const antes = (await soportes(esc)).length;
      const porLaWeb = await mensajeDe(quien.action(api.soportesPago.enviarMio, envio(esc, facturaId, extra)));
      expect(porLaWeb).toContain(caso.mensaje);
      expect(aws.send).not.toHaveBeenCalled();
      expect(await almacenTemporal(esc)).toHaveLength(0);
      /* El móvil, con lo mismo, recibe el mismo mensaje. */
      const porElMovil = await mensajeDe(quien.mutation(api.soportesPago.crearMio, porCrearMio(esc, facturaId, extra)));
      expect(porElMovil).toContain(caso.mensaje);
      expect((await soportes(esc)).length).toBe(antes);
    });
  }

  for (const [nombre, archivo, mensaje] of [
    ["archivo vacío", new ArrayBuffer(0), MENSAJE_COMPROBANTE_VACIO],
    ["más de 10 MB", pdf(MAX_COMPROBANTE_BYTES + 1), MENSAJE_COMPROBANTE_GRANDE],
    ["dice ser PDF y no lo es", conCabecera("hola, no soy un PDF", 4_096), MENSAJE_COMPROBANTE_TIPO],
    ["una foto HEIC", heic(), MENSAJE_COMPROBANTE_TIPO],
  ] as const) {
    test(`${nombre}: mensaje estable y nada sube`, async () => {
      const { esc, septiembre } = await conSeptiembre();
      const msg = await mensajeDe(
        esc.como("residente").action(api.soportesPago.enviarMio, envio(esc, septiembre._id, { archivo, nombreArchivo: "extracto.pdf" })),
      );
      expect(msg).toContain(mensaje);
      expect(aws.send).not.toHaveBeenCalled();
      expect(await almacenTemporal(esc)).toHaveLength(0);
      expect(await soportes(esc)).toHaveLength(0);
    });
  }

  test("orden: sin vínculo y archivo vacío → primero el vínculo, como en crearMio", async () => {
    const { esc, septiembre } = await conSeptiembre();
    const arrendataria = await conPersona(esc, "arrendataria", { unidadId: esc.u101, vigenciaHasta: AHORA - 10 * DIA });
    const msg = await mensajeDe(
      arrendataria.action(api.soportesPago.enviarMio, envio(esc, septiembre._id, { archivo: new ArrayBuffer(0) })),
    );
    expect(msg).toContain("No tienes unidades vinculadas en este condominio.");
    expect(await mensajeDe(arrendataria.mutation(api.soportesPago.crearMio, porCrearMio(esc, septiembre._id, { url: "" })))).toContain(
      "No tienes unidades vinculadas en este condominio.",
    );
  });
});

describe("enviarMio · carreras: el registro revalida y solo se borra la llave propia", () => {
  test("otro comprobante entra mientras se sube: se rechaza y se borra SOLO la llave de esta llamada", async () => {
    const { esc, septiembre } = await conSeptiembre();
    aws.send.mockImplementation(async (comando) => {
      if (comando.constructor.name === "PutObjectCommand") {
        /* Mientras sube, llega otro por WhatsApp para la misma factura. */
        await esc.t.mutation(internal.soportesPago.crearDesdeBot, {
          condominioId: esc.condominioId,
          facturaId: septiembre._id,
          telefono: "+573001112233",
          url: `${BUCKET}/comprobantes/${esc.condominioId}/1791565200000-0f0f0f0f-foto.jpg`,
        });
      }
      return {};
    });
    const msg = await mensajeDe(esc.como("residente").action(api.soportesPago.enviarMio, envio(esc, septiembre._id)));
    expect(msg).toContain(MENSAJE_PENDIENTE);

    const [put] = comandos("PutObjectCommand");
    expect(comandos("DeleteObjectCommand")).toEqual([{ Bucket: "vekino", Key: put!.Key }]);
    const quedan = await soportes(esc);
    expect(quedan).toHaveLength(1);
    expect(quedan[0]!.origen).toBe("whatsapp");
    expect(await almacenTemporal(esc)).toHaveLength(0);
  });

  test("dos envíos a la vez: uno queda, el otro borra su propia llave y no la del que quedó", async () => {
    const { esc, septiembre } = await conSeptiembre();
    /* Los dos pasan la validación y suben antes de que alguno registre. */
    let liberar!: () => void;
    const ambosSubieron = new Promise<void>((r) => (liberar = r));
    let subidas = 0;
    aws.send.mockImplementation(async (comando) => {
      if (comando.constructor.name === "PutObjectCommand" && ++subidas === 2) liberar();
      if (comando.constructor.name === "PutObjectCommand") await ambosSubieron;
      return {};
    });
    const resultados = await Promise.allSettled([
      esc.como("residente").action(api.soportesPago.enviarMio, envio(esc, septiembre._id, { nombreArchivo: "uno.pdf" })),
      esc.como("residente").action(api.soportesPago.enviarMio, envio(esc, septiembre._id, { nombreArchivo: "dos.pdf" })),
    ]);
    expect(resultados.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const rechazo = resultados.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String(rechazo.reason)).toContain(MENSAJE_PENDIENTE);

    const llaves = comandos("PutObjectCommand").map((p) => p.Key as string);
    expect(new Set(llaves).size).toBe(2);
    const [guardado] = await soportes(esc);
    const llaveGuardada = guardado!.url.slice(`${BUCKET}/`.length);
    const borradas = comandos("DeleteObjectCommand").map((d) => d.Key);
    expect(borradas).toEqual(llaves.filter((k) => k !== llaveGuardada));
    expect(borradas).not.toContain(llaveGuardada);
    /* El almacenamiento temporal no se mira aquí: convex-test tiene UNA
     * transacción global, y el borrado que hace una acción mientras la
     * mutación de la otra está abierta se deshace con el rollback de esa
     * mutación. En Convex cada operación es independiente. La limpieza la
     * prueban los casos de una sola llamada. */
  });

  test("si falla la subida a S3, no se registra ni se borra nada, y el almacenamiento temporal se limpia", async () => {
    const { esc, septiembre } = await conSeptiembre();
    aws.send.mockImplementation(async () => {
      throw new Error("S3 no responde");
    });
    const msg = await mensajeDe(esc.como("residente").action(api.soportesPago.enviarMio, envio(esc, septiembre._id)));
    expect(msg).toContain("S3 no responde");
    expect(comandos("DeleteObjectCommand")).toHaveLength(0);
    expect(await soportes(esc)).toHaveLength(0);
    expect(await almacenTemporal(esc)).toHaveLength(0);
  });
});

describe("crearMio · la URL tiene que ser del bucket y de la carpeta del conjunto", () => {
  /**
   * La URL que de verdad le devuelve `generateUploadUrl` al móvil, después
   * de subir la foto como la sube: PUT a la ruta del backend que le dieron
   * (H-06). Sin ese PUT la subida no queda validada y `crearMio` no la
   * registra (H-12).
   */
  async function urlDelMovil(esc: Escenario, condominioId: string, fileName?: string) {
    const r = await esc.como("residente").action(api.files.generateUploadUrl, {
      folder: `condominios/soportes/${condominioId}`,
      contentType: "image/jpeg",
      ...(fileName !== undefined ? { fileName } : {}),
    });
    const put = await esc.t.fetch(r.uploadUrl.slice("https://vekino-pruebas.convex.site".length), {
      method: "PUT",
      headers: { "Content-Type": "image/jpeg" },
      body: new Uint8Array(jpeg()),
    });
    expect(put.status).toBe(200);
    return r.publicUrl;
  }

  test("acepta el formato real de generateUploadUrl, con los nombres que dan los celulares", async () => {
    for (const fileName of [
      "IMG_0001.JPG",
      "1000012345.jpg",
      "Comprobante PSE (1).pdf",
      "pago..pdf",
      "ñandú – septiembre.jpeg",
      "日本.jpg",
      "   ",
      "x".repeat(300),
      undefined,
    ]) {
      const { esc, septiembre } = await conSeptiembre();
      const url = await urlDelMovil(esc, esc.condominioId, fileName);
      const id = await esc.como("residente").mutation(api.soportesPago.crearMio, porCrearMio(esc, septiembre._id, { url }));
      expect((await esc.t.run(async (ctx) => await ctx.db.get(id)))?.url).toBe(url);
    }
  });

  test("con espacios alrededor, como antes, se recorta y se acepta", async () => {
    const { esc, septiembre } = await conSeptiembre();
    const url = await urlDelMovil(esc, esc.condominioId, "foto.jpg");
    const id = await esc.como("residente").mutation(api.soportesPago.crearMio, porCrearMio(esc, septiembre._id, { url: `  ${url}\n` }));
    expect((await esc.t.run(async (ctx) => await ctx.db.get(id)))?.url).toBe(url);
  });

  test("rechaza otra carpeta de conjunto, otro bucket, un dominio externo, `..`, dobles barras y otras variantes", async () => {
    const { esc, septiembre } = await conSeptiembre();
    const otroConjunto = await esc.t.run(
      async (ctx) =>
        await ctx.db.insert("condominios", { name: "Otro", activeModules: [], isActive: true, createdAt: AHORA, updatedAt: AHORA }),
    );
    const buena = await urlDelMovil(esc, esc.condominioId, "foto.jpg");
    const tramo = buena.slice(buena.lastIndexOf("/") + 1);
    const propia = `${BUCKET}/condominios/soportes/${esc.condominioId}`;
    for (const url of [
      // Con la forma de una URL del otro conjunto. Pedirla ya no se puede: la
      // subida a la carpeta de otro conjunto se rechaza antes (H-06).
      `${BUCKET}/condominios/soportes/${otroConjunto}/${tramo}`,
      `https://otro-bucket.s3.us-east-1.amazonaws.com/condominios/soportes/${esc.condominioId}/${tramo}`,
      `https://vekino.s3.us-west-2.amazonaws.com/condominios/soportes/${esc.condominioId}/${tramo}`,
      `https://archivos.test/condominios/soportes/${esc.condominioId}/${tramo}`,
      `https://vekino.s3.us-east-1.amazonaws.com.atacante.test/condominios/soportes/${esc.condominioId}/${tramo}`,
      `http://vekino.s3.us-east-1.amazonaws.com/condominios/soportes/${esc.condominioId}/${tramo}`,
      `${BUCKET}/condominios/soportes/${otroConjunto}/../${esc.condominioId}/${tramo}`,
      `${propia}/../${otroConjunto}/${tramo}`,
      `${propia}/../../facturas/${tramo}`,
      `${propia}//${tramo}`,
      `${propia}/sub/${tramo}`,
      `${propia}/${tramo}?descarga=1`,
      `${propia}/${tramo}#x`,
      `${propia}/${tramo.replace("-", "%2F")}`,
      `${BUCKET}/comprobantes/${esc.condominioId}/${tramo}`,
      `${propia}/`,
      "javascript:alert(1)",
    ]) {
      const msg = await mensajeDe(esc.como("residente").mutation(api.soportesPago.crearMio, porCrearMio(esc, septiembre._id, { url })));
      expect(msg, url).toContain(MENSAJE_COMPROBANTE_URL);
    }
    expect(await soportes(esc)).toHaveLength(0);
  });

  test("sin bucket configurado tampoco entra una URL que no salió de una subida (antes se aceptaba)", async () => {
    vi.stubEnv("AWS_S3_BUCKET_NAME", "");
    const { esc, septiembre } = await conSeptiembre();
    for (const url of ["https://archivos.test/c.jpg", porCrearMio(esc, septiembre._id).url]) {
      expect(
        await mensajeDe(esc.como("residente").mutation(api.soportesPago.crearMio, porCrearMio(esc, septiembre._id, { url }))),
        url,
      ).toContain(MENSAJE_ARCHIVO_NO_AUTORIZADO);
    }
    expect(await soportes(esc)).toHaveLength(0);
  });

  test("una URL vacía sigue diciendo 'Falta el archivo del comprobante.'", async () => {
    const { esc, septiembre } = await conSeptiembre();
    expect(await mensajeDe(esc.como("residente").mutation(api.soportesPago.crearMio, porCrearMio(esc, septiembre._id, { url: "  " })))).toContain(
      "Falta el archivo del comprobante.",
    );
  });
});

describe("El bot de WhatsApp, sin cambios", () => {
  test("baja la foto, la sube con la misma llave de siempre y crearDesdeBot la registra (no pasa por crearMio)", async () => {
    const { esc, septiembre } = await conSeptiembre();
    vi.stubGlobal("fetch", async () => new Response(new Uint8Array(jpeg(4_096)), { headers: { "content-type": "image/jpeg" } }));
    const subido = await esc.t.action(internal.files.uploadFromUrl, {
      url: "https://api.ycloud.com/v2/whatsapp/media/abc",
      folder: `comprobantes/${esc.condominioId}`,
      fileName: "foto.jpg",
      contentType: "image/jpeg",
      conApiKeyYCloud: true,
    });
    const [put] = comandos("PutObjectCommand");
    expect(put).toMatchObject({ Bucket: "vekino", ContentType: "image/jpeg" });
    expect(put!.Key).toMatch(new RegExp(`^comprobantes/${esc.condominioId}/${AHORA}-[0-9a-f]{8}-foto\\.jpg$`));
    expect(subido).toEqual({ key: put!.Key, publicUrl: `${BUCKET}/${put!.Key}` });

    const id = await esc.t.mutation(internal.soportesPago.crearDesdeBot, {
      condominioId: esc.condominioId,
      facturaId: septiembre._id,
      telefono: "+573001112233",
      url: subido.publicUrl,
      mimeType: "image/jpeg",
    });
    expect((await esc.t.run(async (ctx) => await ctx.db.get(id)))).toMatchObject({ origen: "whatsapp", url: subido.publicUrl });
    bloquearRed();
  });

  /* Antes cualquier sesión subía a cualquier carpeta ("condominios/documentos/x")
   * con el tipo que dijera. Desde H-06 la carpeta tiene que ser de un conjunto
   * donde quien sube tiene permiso, y el tipo sale de los bytes. */
  test("uploadBytes: carpeta autorizada, tipo por contenido y los mismos límites", async () => {
    const { esc } = await conSeptiembre();
    const r = await esc.como("residente").action(api.files.uploadBytes, {
      folder: `condominios/soportes/${esc.condominioId}`,
      contentType: "",
      fileName: "acta.pdf",
      bytes: pdf(),
    });
    expect(comandos("PutObjectCommand")[0]).toMatchObject({ Bucket: "vekino", ContentType: "application/pdf" });
    expect(r.key).toMatch(new RegExp(`^condominios/soportes/${esc.condominioId}/${AHORA}-[0-9a-f]{8}-acta\\.pdf$`));
    expect(
      await mensajeDe(
        esc.como("residente").action(api.files.uploadBytes, {
          folder: "condominios/documentos/x",
          contentType: "",
          fileName: "acta.pdf",
          bytes: pdf(),
        }),
      ),
    ).toContain("No tienes permiso para subir archivos ahí.");
    expect(await mensajeDe(esc.como("residente").action(api.files.uploadBytes, { folder: "x", contentType: "a", bytes: new ArrayBuffer(0) }))).toContain(
      "Archivo vacío.",
    );
  });
});

/* Que la fecha de la web (mediodía de Colombia) pase igual por las dos vías. */
describe("enviarMio · la fecha que manda la web", () => {
  test("a las 23:00 de Colombia, el mediodía de hoy se acepta", async () => {
    fijarReloj(bogota("2026-10-09T23:00"));
    const esc = await montar();
    await cargar(esc, [{ periodo: "2026-10", lineas: [linea("CUOTA", 0, 380_000)] }]);
    const octubre = await facturaDe(esc, "2026-10");
    const id = await esc.como("residente").action(
      api.soportesPago.enviarMio,
      envio(esc, octubre._id, { fechaPago: mediodia("2026-10-09") }),
    );
    expect((await esc.t.run(async (ctx) => await ctx.db.get(id)))?.fechaPago).toBe(mediodia("2026-10-09"));
  });
});
