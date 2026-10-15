import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getFunctionName } from "convex/server";
import { publicacionSimulada } from "./facturacion/publicacionSimulada.mjs";

/**
 * CARGA DE PDF POR CONJUNTO, NO POR `legacyId` (Hallazgo 2 de la QA en
 * Factory; ver docs/audits/FALTANTES-WEB-FACTURACION.md).
 *
 * Las dos rutas (`/api/facturas/upload` y `/api/facturas/confirmar`) piden
 * permiso y destino a `facturas.destinoCarga`, que resuelve el conjunto por
 * `condominioId` o por `condominioLegacyId` y devuelve su carpeta de S3:
 * `legacyId` si lo tiene, `_id` si no. Aquí, con S3 y Convex simulados:
 *
 *   · un conjunto SIN legacyId (como Factory) carga y confirma, con la llave
 *     bajo su `_id`;
 *   · uno CON legacyId conserva la llave de hoy, byte por byte;
 *   · la llamada de la web anterior (solo `condominioLegacyId` en la vista
 *     previa, los dos al confirmar) sigue funcionando;
 *   · dos identificadores de conjuntos distintos se rechazan antes de S3.
 *
 * Desde la Fase 5 de S3 publica Convex (`files.publicarFacturas`, simulado
 * con sus reglas en `facturacion/publicacionSimulada.mjs`): la llave la
 * arma el backend con la carpeta que resuelve para la importación, y la ruta
 * no escribe en S3.
 *
 * Proceso aparte en `test:facturacion`: simula `@/lib/auth-server` y S3 a su
 * manera.
 */

const FIXTURES = join(import.meta.dir, "facturacion", "fixtures");
const PDF = readFileSync(join(FIXTURES, "cdc-control.pdf"));
const HUELLA = createHash("sha256").update(PDF).digest("hex");
/** cdc-control.pdf es de abril de 2026, casa 999. */
const PERIODO = "2026-04";

// ── S3 desde Next: ya nadie debería escribir por aquí (Fase 5)
let escriturasDeNext;
mock.module("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(comando) {
      escriturasDeNext.push(comando.input);
      return {};
    }
  },
  PutObjectCommand: class {
    constructor(input) {
      this.input = input;
    }
  },
}));

// ── Convex simulado
/** Los conjuntos que conoce el backend simulado. */
let conjuntos;
/** Conjuntos donde la sesión tiene rol de carga (administración o contadora). */
let conRol;
let consultas;
let llamadas;

const carpetaDe = (c) => c.legacyId || c._id;

/** Lo que publicó Convex, con la forma de un PutObject. */
let publicados;
/** La importación en curso: su conjunto y su período (los guarda el backend). */
let importacion;
const publicacion = publicacionSimulada({
  destino: (importacionId) => {
    const conjunto = conjuntos.find((c) => c._id === importacion.condominioId);
    return `condominios/facturas/${carpetaDe(conjunto)}/${importacion.periodo}/${importacionId}`;
  },
  registro: () => publicados,
});

/** Lo que responde `facturas.destinoCarga`, con las mismas reglas que el backend. */
function destinoCarga({ condominioId, condominioLegacyId }) {
  if (condominioId === undefined && condominioLegacyId === undefined) {
    return { allowed: false, motivo: "sin_conjunto" };
  }
  const porId = condominioId === undefined ? undefined : conjuntos.find((c) => c._id === condominioId);
  if (condominioId !== undefined && !porId) return { allowed: false, motivo: "sin_permiso" };
  const porLegacy =
    condominioLegacyId === undefined ? undefined : conjuntos.filter((c) => c.legacyId === condominioLegacyId);
  if (porLegacy && porLegacy.length === 0) return { allowed: false, motivo: "sin_permiso" };
  if ([porId, ...(porLegacy ?? [])].some((c) => c && !conRol.has(c._id))) {
    return { allowed: false, motivo: "sin_permiso" };
  }
  const conjunto = porId ?? porLegacy[0];
  if (porLegacy && !porLegacy.includes(conjunto)) return { allowed: false, motivo: "no_coinciden" };
  if (conjuntos.some((c) => c !== conjunto && carpetaDe(c) === carpetaDe(conjunto))) {
    return { allowed: false, motivo: "carpeta_compartida" };
  }
  return { allowed: true, condominioId: conjunto._id, carpeta: carpetaDe(conjunto) };
}

mock.module("@/lib/auth-server", () => ({
  handler: async () => new Response(null, { status: 404 }),
  getToken: async () => "token",
  isAuthenticated: async () => true,
  preloadAuthQuery: async () => ({}),
  fetchAuthQuery: async (fn, args) => {
    const nombre = getFunctionName(fn);
    consultas.push({ nombre, args });
    if (nombre === "facturas:destinoCarga") return destinoCarga(args);
    throw new Error(`Consulta inesperada: ${nombre}`);
  },
  fetchAuthAction: async (fn, args) => {
    const nombre = getFunctionName(fn);
    llamadas.push({ nombre, args });
    if (nombre === "files:publicarFacturas") return await publicacion.publicarFacturas(args);
    throw new Error(`Acción inesperada: ${nombre}`);
  },
  fetchAuthMutation: async (fn, args) => {
    const nombre = getFunctionName(fn);
    llamadas.push({ nombre, args });
    if (nombre === "facturas:iniciarImportacion") {
      importacion = { condominioId: args.condominioId, periodo: args.periodo };
      return {
        tipo: "nueva",
        importacionId: "imp1",
        resultado: null,
        plan: args.candidatas.map((c) => ({ indice: c.indice, accion: "insertar" })),
      };
    }
    if (nombre === "facturas:bulkUpsert") {
      return {
        inserted: args.facturas.length,
        updated: 0,
        skipped: 0,
        marcadas: 0,
        rechazadas: 0,
        rechazos: [],
        conciliacion: { pagadas: 0, abonadas: 0, vencidas: 0 },
      };
    }
    if (nombre === "facturas:finalizarImportacion") return { importacionId: "imp1", estado: args.estado };
    throw new Error(`Mutación inesperada: ${nombre}`);
  },
}));

const { POST: vistaPrevia } = await import("../app/api/facturas/upload/route");
const { POST: confirmacion } = await import("../app/api/facturas/confirmar/route");

const MIGRADO = { _id: "condo-cdc", legacyId: "conjunto-de-prueba" };
const FACTORY = { _id: "j570ttbjpy06q0nnd6k15gnxbx8fxvcz" };

beforeEach(() => {
  publicados = [];
  escriturasDeNext = [];
  publicacion.olvidar();
  consultas = [];
  llamadas = [];
  conjuntos = [MIGRADO, FACTORY];
  conRol = new Set([MIGRADO._id, FACTORY._id]);
});

/** El formulario con los identificadores que se pidan (los que no, no van). */
function formulario(ids, extra = {}) {
  const form = new FormData();
  form.append("pdf", new File([PDF], "cdc-control.pdf", { type: "application/pdf" }));
  for (const [campo, valor] of Object.entries({ ...ids, ...extra })) form.append(campo, valor);
  return form;
}

async function leer(ids) {
  const res = await vistaPrevia(
    new Request("http://localhost/api/facturas/upload", { method: "POST", body: formulario(ids) }),
  );
  return { status: res.status, cuerpo: await res.json() };
}

async function confirmar(ids) {
  const form = formulario(ids, {
    periodo: PERIODO,
    hash: HUELLA,
    soloNuevas: "true",
    asignaciones: JSON.stringify([{ indice: 0, unidadId: "u999" }]),
  });
  const res = await confirmacion(
    new Request("http://localhost/api/facturas/confirmar", { method: "POST", body: form }),
  );
  return { status: res.status, cuerpo: await res.json() };
}

const mutacion = (nombre) => llamadas.find((l) => l.nombre === nombre)?.args;
const llaveBajo = (carpeta) =>
  new RegExp(`^condominios/facturas/${carpeta}/${PERIODO}/imp1/unidad-999-[0-9a-f]{12}\\.pdf$`);

describe("conjunto SIN legacyId (como Factory): carga y confirma por condominioId", () => {
  test("vista previa: pregunta por ESE conjunto, lee el PDF y no publica nada", async () => {
    const { status, cuerpo } = await leer({ condominioId: FACTORY._id });
    expect(status).toBe(200);
    expect(cuerpo.invoices).toHaveLength(1);
    expect(consultas).toEqual([{ nombre: "facturas:destinoCarga", args: { condominioId: FACTORY._id } }]);
    expect(publicados).toEqual([]);
  });

  test("confirmación: la llave de S3 va bajo el _id y lo que se guarda es de ese conjunto", async () => {
    const { status, cuerpo } = await confirmar({ condominioId: FACTORY._id });
    expect(status).toBe(200);
    expect(cuerpo.publicadas).toBe(1);
    expect(publicados.map((p) => p.Key)).toEqual([expect.stringMatching(llaveBajo(FACTORY._id))]);
    expect(publicados[0].IfNoneMatch).toBe("*");
    expect(mutacion("facturas:iniciarImportacion").condominioId).toBe(FACTORY._id);
    const [factura] = mutacion("facturas:bulkUpsert").facturas;
    expect(factura.condominioId).toBe(FACTORY._id);
    expect(factura.pdfUrl).toEndWith(`/${publicados[0].Key}`);
    expect(escriturasDeNext).toEqual([]);
  });
});

describe("conjunto CON legacyId: la misma llave que hoy", () => {
  test("la web nueva (solo condominioId) publica bajo el legacyId", async () => {
    const { status } = await confirmar({ condominioId: MIGRADO._id });
    expect(status).toBe(200);
    expect(publicados.map((p) => p.Key)).toEqual([expect.stringMatching(llaveBajo("conjunto-de-prueba"))]);
    expect(mutacion("facturas:iniciarImportacion").condominioId).toBe(MIGRADO._id);
  });

  test("la web anterior (los dos identificadores) y la nueva dan exactamente la misma llave", async () => {
    await confirmar({ condominioId: MIGRADO._id });
    const nueva = publicados.map((p) => p.Key);
    expect(nueva).toEqual([expect.stringMatching(llaveBajo("conjunto-de-prueba"))]);
    publicados = [];
    llamadas = [];
    publicacion.olvidar();
    await confirmar({ condominioId: MIGRADO._id, condominioLegacyId: "conjunto-de-prueba" });
    expect(publicados.map((p) => p.Key)).toEqual(nueva);
  });
});

describe("la llamada antigua, solo con condominioLegacyId, sigue funcionando", () => {
  test("vista previa", async () => {
    const { status, cuerpo } = await leer({ condominioLegacyId: "conjunto-de-prueba" });
    expect(status).toBe(200);
    expect(cuerpo.invoices).toHaveLength(1);
    expect(consultas).toEqual([
      { nombre: "facturas:destinoCarga", args: { condominioLegacyId: "conjunto-de-prueba" } },
    ]);
  });

  test("confirmación: el conjunto lo resuelve el backend y la llave es la de hoy", async () => {
    const { status } = await confirmar({ condominioLegacyId: "conjunto-de-prueba" });
    expect(status).toBe(200);
    expect(publicados.map((p) => p.Key)).toEqual([expect.stringMatching(llaveBajo("conjunto-de-prueba"))]);
    expect(mutacion("facturas:iniciarImportacion").condominioId).toBe(MIGRADO._id);
    expect(mutacion("facturas:bulkUpsert").facturas[0].condominioId).toBe(MIGRADO._id);
  });
});

describe("rechazos, sin publicar ni escribir nada", () => {
  test("una confirmación con la llave de OTRO conjunto (legacyId de uno, condominioId de otro): 400", async () => {
    const { status, cuerpo } = await confirmar({
      condominioId: FACTORY._id,
      condominioLegacyId: "conjunto-de-prueba",
    });
    expect(status).toBe(400);
    expect(cuerpo.error).toMatch(/conjuntos distintos/);
    expect(publicados).toEqual([]);
    expect(llamadas).toEqual([]);
  });

  test("la vista previa también la rechaza", async () => {
    const { status } = await leer({ condominioId: FACTORY._id, condominioLegacyId: "conjunto-de-prueba" });
    expect(status).toBe(400);
  });

  test("sin rol en el otro conjunto: 403, y no se le dice si coinciden", async () => {
    conRol = new Set([FACTORY._id]);
    const { status } = await confirmar({ condominioId: FACTORY._id, condominioLegacyId: "conjunto-de-prueba" });
    expect(status).toBe(403);
    expect(publicados).toEqual([]);
    expect(llamadas).toEqual([]);
  });

  test("sin ningún identificador: 400 claro en las dos rutas, sin preguntarle a Convex", async () => {
    const previa = await leer({});
    const confirmada = await confirmar({});
    for (const r of [previa, confirmada]) {
      expect(r.status).toBe(400);
      expect(r.cuerpo.error).toMatch(/condominioId/);
    }
    expect(consultas).toEqual([]);
    expect(publicados).toEqual([]);
    expect(llamadas).toEqual([]);
  });

  test("una carpeta que comparte otro conjunto: 409", async () => {
    conjuntos = [MIGRADO, FACTORY, { _id: "condo-intruso", legacyId: FACTORY._id }];
    const { status } = await confirmar({ condominioId: FACTORY._id });
    expect(status).toBe(409);
    expect(publicados).toEqual([]);
    expect(llamadas).toEqual([]);
  });
});
