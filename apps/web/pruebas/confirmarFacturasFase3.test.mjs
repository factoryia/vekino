import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getFunctionName } from "convex/server";
import { publicacionSimulada } from "./facturacion/publicacionSimulada.mjs";

/**
 * CONFIRMACIÓN DE UNA CARGA — lo que agregó la Fase 3 de la auditoría de
 * facturación (docs/audits/FASE-3-FACTURACION.md):
 *
 *   · el vencimiento de lo que entra es el último día del mes del período
 *     ("del 16 a 30 se paga el precio completo"), a medianoche de Colombia;
 *   · el plazo del descuento es el que dice el documento ("HASTA EL DIA 15
 *     DEL PRESENTE MES"), no el vencimiento;
 *   · dos documentos para la misma unidad no se mandan a guardar y quedan
 *     registrados al cerrar la importación.
 *
 * S3 y Convex simulados, como en confirmarFacturas.test.mjs. Proceso aparte
 * en `test:facturacion` (simula `@/lib/auth-server` y S3 a su manera).
 */

const FIXTURES = join(import.meta.dir, "facturacion", "fixtures");
const pdf = (archivo) => readFileSync(join(FIXTURES, archivo));
const huella = (bytes) => createHash("sha256").update(bytes).digest("hex");
const bogota = (local) => Date.parse(`${local}:00-05:00`);

/** Lo que publicó Convex (`files.publicarFacturas`, Fase 5 de S3). */
let publicados;
let periodoEnCurso;
const publicacion = publicacionSimulada({
  destino: (importacionId) => `condominios/facturas/conjunto-de-prueba/${periodoEnCurso}/${importacionId}`,
  registro: () => publicados,
});
/* S3 desde Next: ya nadie debería escribir por aquí. */
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

let llamadas;
mock.module("@/lib/auth-server", () => ({
  handler: async () => new Response(null, { status: 404 }),
  getToken: async () => "token",
  isAuthenticated: async () => true,
  preloadAuthQuery: async () => ({}),
  /* `facturas.destinoCarga` (Hallazgo 2): el conjunto migrado de la prueba y su carpeta. */
  fetchAuthQuery: async () => ({ allowed: true, condominioId: "condo-1", carpeta: "conjunto-de-prueba" }),
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
      periodoEnCurso = args.periodo;
      /* Como el backend: dos documentos de la misma unidad se rechazan los dos. */
      const veces = new Map();
      for (const c of args.candidatas) veces.set(c.unidadId, (veces.get(c.unidadId) ?? 0) + 1);
      return {
        tipo: "nueva",
        importacionId: "imp1",
        resultado: null,
        plan: args.candidatas.map((c) =>
          veces.get(c.unidadId) > 1
            ? { indice: c.indice, accion: "rechazar", motivo: "documento_repetido" }
            : { indice: c.indice, accion: "insertar" },
        ),
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
    if (nombre === "facturas:finalizarImportacion") {
      return { importacionId: "imp1", estado: args.estado };
    }
    throw new Error(`Mutación inesperada: ${nombre}`);
  },
}));

const { POST } = await import("../app/api/facturas/confirmar/route");

beforeEach(() => {
  publicados = [];
  escriturasDeNext = [];
  publicacion.olvidar();
  llamadas = [];
});

async function confirmar(archivo, periodo, asignaciones = [{ indice: 0, unidadId: "u999" }]) {
  const bytes = pdf(archivo);
  const form = new FormData();
  form.append("pdf", new File([bytes], archivo, { type: "application/pdf" }));
  form.append("condominioId", "condo-1");
  form.append("condominioLegacyId", "conjunto-de-prueba");
  form.append("periodo", periodo);
  form.append("hash", huella(bytes));
  form.append("soloNuevas", "true");
  form.append("asignaciones", JSON.stringify(asignaciones));
  const res = await POST(new Request("http://localhost/api/facturas/confirmar", { method: "POST", body: form }));
  return { status: res.status, cuerpo: await res.json() };
}

const guardadas = () => llamadas.filter((l) => l.nombre === "facturas:bulkUpsert").flatMap((l) => l.args.facturas);

describe("F06 · vencimiento y plazo del descuento de lo que entra", () => {
  test("el vencimiento es el último día del mes del período, a medianoche de Colombia", async () => {
    const { status } = await confirmar("cdc-control.pdf", "2026-04");
    expect(status).toBe(200);
    expect(guardadas()[0].fechaVencimiento).toBe(bogota("2026-04-30T00:00"));
  });

  test("el plazo del descuento es el del documento (día 15 del mes del período), no el vencimiento", async () => {
    await confirmar("cdc-control.pdf", "2026-04");
    const f = guardadas()[0];
    expect(typeof f.totalConDescuento).toBe("number");
    expect(f.fechaLimiteDescuento).toBe(bogota("2026-04-16T00:00") - 1);
  });

  test("un documento sin descuento no trae plazo de descuento", async () => {
    await confirmar("arboleda-control.pdf", "2026-06");
    const f = guardadas()[0];
    expect(f.totalConDescuento).toBeUndefined();
    expect(f.fechaLimiteDescuento).toBeUndefined();
  });
});

describe("dos documentos para la misma unidad", () => {
  test("no se mandan a guardar ni se publican, y quedan registrados al cerrar", async () => {
    const { status } = await confirmar("cdc-consolidado-con-continuacion.pdf", "2026-09", [
      { indice: 0, unidadId: "u999" },
      { indice: 1, unidadId: "u999" },
    ]);
    expect(status).toBe(200);
    expect(guardadas()).toEqual([]);
    expect(publicados).toEqual([]);
    expect(escriturasDeNext).toEqual([]);
    const fin = llamadas.find((l) => l.nombre === "facturas:finalizarImportacion").args;
    expect(fin.rechazos).toEqual([
      { indice: 0, motivo: "documento_repetido" },
      { indice: 1, motivo: "documento_repetido" },
    ]);
  });
});
