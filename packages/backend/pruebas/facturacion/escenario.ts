import { convexTest } from "convex-test";
import { expect, vi } from "vitest";
import schema from "../../convex/schema";
import { api, internal } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { carpetaComprobantes } from "../../convex/lib/comprobantes";
import { subidaValidada } from "../helpers/subidas";

/**
 * ESCENARIO COMÚN DE LA RED DE SEGURIDAD DE FACTURACIÓN (Fase 0).
 *
 * Un conjunto con dos casas, su administración, dos propietarios y un guarda.
 * Las facturas entran por donde entran en producción —`facturas.bulkUpsert`,
 * con la misma forma que manda `apps/web/components/upload-facturas.tsx`— para
 * que la conciliación corra como corre de verdad. Los pagos aprobados pasan
 * por `pagos.registrarPago` + `pagos.aplicarEstado`, que es lo que hace la
 * pasarela después de hablar con Aval (sin la llamada HTTP).
 *
 * La red queda bloqueada en cada prueba (`bloquearRed`): las notificaciones
 * programadas (WhatsApp, push) corren de verdad, y si alguna intentara salir
 * a internet la prueba falla. Nadie del escenario tiene teléfono ni token push,
 * así que no deberían intentarlo.
 */

export const modules = import.meta.glob("../../convex/**/*.ts");

export const DIA = 24 * 60 * 60 * 1000;

/** Instante en hora de Colombia (UTC−5). `bogota("2026-10-08T10:00")`. */
export const bogota = (local: string) => Date.parse(`${local}:00-05:00`);

/**
 * El "hoy" de toda la suite: el 8 de octubre de 2026, el día de la auditoría
 * y del pago QA real. Con el reloj fijo, la cuenta de agosto (vence el 15 de
 * septiembre) ya venció y la de septiembre (vence el 15 de octubre) todavía
 * no, igual que en los datos reales; y las pruebas no cambian de resultado
 * según el día en que se corran.
 */
export const AHORA = bogota("2026-10-08T10:00");

/** Congela `Date` (solo `Date`: los temporizadores siguen siendo reales). */
export function fijarReloj(instante = AHORA) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(instante);
}

export function soltarReloj() {
  vi.useRealTimers();
}

/** "2026-09" → "2026-10". */
export function periodoSiguiente(periodo: string): string {
  const [a, m] = periodo.split("-").map(Number) as [number, number];
  return m === 12 ? `${a + 1}-01` : `${a}-${String(m + 1).padStart(2, "0")}`;
}

/**
 * El vencimiento que la carga por PDF le pone HOY a una factura: el día 15
 * del mes SIGUIENTE al período, a medianoche de Colombia
 * (`upload-facturas.tsx`: `new Date(año, mes, 15)` con el mes en base 1).
 */
export function vencimientoDeCarga(periodo: string): number {
  return bogota(`${periodoSiguiente(periodo)}-15T00:00`);
}

const MESES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

/** Etiqueta de período como la imprime Ciudad del Campo: "Agosto / 2026". */
export function etiquetaCdc(periodo: string): string {
  const [a, m] = periodo.split("-").map(Number) as [number, number];
  return `${MESES[m - 1]} / ${a}`;
}

export type Linea = {
  codigo: number;
  concepto: string;
  saldoAnterior: number;
  actual: number;
  total: number;
};

/** Una línea de la cuenta de cobro: lo que arrastra + lo del mes. */
export function linea(
  concepto: string,
  saldoAnterior: number,
  actual: number,
  codigo = 1,
): Linea {
  return { codigo, concepto, saldoAnterior, actual, total: saldoAnterior + actual };
}

export type Casa = "u101" | "u202";

export type FacturaCarga = {
  periodo: string;
  lineas: Linea[];
  /** Si no se da, la suma de las líneas (lo que trae un documento que cuadra). */
  totalAPagar?: number;
  totalConDescuento?: number;
  periodoLabel?: string;
  casa?: Casa;
  numeroInterno?: string;
};

export async function montar() {
  const t = convexTest(schema, modules);
  const ahora = Date.now();

  const ids = await t.run(async (ctx) => {
    const condominioId = await ctx.db.insert("condominios", {
      name: "Conjunto de Prueba",
      activeModules: [],
      isActive: true,
      createdAt: ahora,
      updatedAt: ahora,
    });
    const persona = (authId: string, name: string) =>
      ctx.db.insert("users", {
        name,
        email: `${authId}@vekino.test`,
        emailVerified: true,
        active: true,
        authId,
        createdAt: ahora,
        updatedAt: ahora,
      });
    const membresia = (userId: Id<"users">, roles: string[]) =>
      ctx.db.insert("memberships", {
        userId,
        condominioId,
        roles: roles as never,
        isActive: true,
        createdAt: ahora,
        updatedAt: ahora,
      });
    const unidad = (numero: string) =>
      ctx.db.insert("unidades", {
        condominioId,
        tipo: "casa",
        estado: "ocupada",
        numero,
        createdAt: ahora,
        updatedAt: ahora,
      });

    const adminId = await persona("admin", "Administración");
    const residenteId = await persona("residente", "Propietaria 101");
    const vecinoId = await persona("vecino", "Propietario 202");
    const guardaId = await persona("guarda", "Guarda de turno");

    await membresia(adminId, ["administrador"]);
    const mResidente = await membresia(residenteId, ["propietario"]);
    const mVecino = await membresia(vecinoId, ["propietario"]);
    await membresia(guardaId, ["guardia"]);

    const u101 = await unidad("101");
    const u202 = await unidad("202");

    const vincular = (membershipId: Id<"memberships">, unidadId: Id<"unidades">) =>
      ctx.db.insert("usuarioUnidad", {
        membershipId,
        unidadId,
        condominioId,
        vinculo: "propietario",
        esPrincipal: true,
        createdAt: ahora,
      });
    await vincular(mResidente, u101);
    await vincular(mVecino, u202);

    return {
      condominioId,
      u101,
      u202,
      adminId,
      residenteId,
      vecinoId,
      guardaId,
      mResidente,
      mVecino,
    };
  });

  const como = (authId: "admin" | "residente" | "vecino" | "guarda") =>
    t.withIdentity({ subject: authId });

  return { t, ...ids, como };
}

export type Escenario = Awaited<ReturnType<typeof montar>>;

/** La factura tal como la manda la pantalla de subida de PDFs. */
export function comoLaCargaPorPdf(esc: Escenario, f: FacturaCarga, indice = 1) {
  const totalAPagar = f.totalAPagar ?? f.lineas.reduce((s, l) => s + l.total, 0);
  return {
    condominioId: esc.condominioId,
    unidadId: esc[f.casa ?? "u101"],
    numeroFactura: `FAC-${f.periodo}-${String(indice).padStart(4, "0")}`,
    numeroInterno: f.numeroInterno ?? `${f.periodo.replace("-", "")}${indice}`,
    periodo: f.periodo,
    periodoLabel: f.periodoLabel ?? etiquetaCdc(f.periodo),
    residenteNombre: "Residente de prueba",
    apto: f.casa === "u202" ? "202" : "101",
    vrAdmon: 300000,
    lineas: f.lineas,
    saldoAFavor: 0,
    totalAPagar,
    totalConDescuento: f.totalConDescuento,
    fechaEmision: Date.now(),
    fechaVencimiento: vencimientoDeCarga(f.periodo),
    estado: totalAPagar < 0 ? ("saldo_a_favor" as const) : ("pendiente" as const),
  };
}

/**
 * Inserta una factura con un estado dado, SIN pasar por la conciliación.
 *
 * Para aislar una pieza (p. ej. `armarDatosTrn`) de la regla que pone los
 * estados: así la prueba dice qué hace esa pieza con cada estado posible,
 * no qué estado habría puesto la carga.
 */
export async function insertarDirecto(
  esc: Escenario,
  f: FacturaCarga,
  estado: Doc<"facturas">["estado"],
): Promise<Id<"facturas">> {
  const { totalConDescuento, ...datos } = comoLaCargaPorPdf(esc, f);
  const ahora = Date.now();
  return await esc.t.run(
    async (ctx) =>
      await ctx.db.insert("facturas", {
        ...datos,
        ...(totalConDescuento === undefined ? {} : { totalConDescuento }),
        estado,
        createdAt: ahora,
        updatedAt: ahora,
      }),
  );
}

/** La administración sube un lote, como desde Finanzas → "Subir facturas". */
export async function cargar(
  esc: Escenario,
  facturas: FacturaCarga[],
  opciones: { skipExisting?: boolean } = {},
) {
  return await esc.como("admin").mutation(api.facturas.bulkUpsert, {
    facturas: facturas.map((f, i) => comoLaCargaPorPdf(esc, f, i + 1)),
    skipExisting: opciones.skipExisting ?? true,
  });
}

/** Facturas de una casa, por período. */
export async function facturasDe(esc: Escenario, casa: Casa = "u101") {
  const filas = await esc.t.run(
    async (ctx) =>
      await ctx.db
        .query("facturas")
        .withIndex("by_unidad", (q) => q.eq("unidadId", esc[casa]))
        .collect(),
  );
  return filas.sort((a, b) => a.periodo.localeCompare(b.periodo));
}

export async function facturaDe(
  esc: Escenario,
  periodo: string,
  casa: Casa = "u101",
): Promise<Doc<"facturas">> {
  const f = (await facturasDe(esc, casa)).find((x) => x.periodo === periodo);
  if (!f) throw new Error(`No hay factura ${periodo} para ${casa}`);
  return f;
}

/** Deja correr las notificaciones que agendó la última mutación. */
export async function esperarProgramadas(esc: Escenario) {
  await new Promise((r) => setTimeout(r, 10));
  await esc.t.finishInProgressScheduledFunctions();
}

/**
 * Un pago que la pasarela Aval aprobó: lo que hacen `crearTrnYRegistrar` y
 * `consultarEstado` después de hablar con el banco, sin la llamada HTTP.
 */
export async function aprobarPagoAval(
  esc: Escenario,
  facturaId: Id<"facturas">,
  monto: number,
) {
  const factura = await esc.t.run(async (ctx) => await ctx.db.get(facturaId));
  if (!factura) throw new Error("Factura inexistente");
  const pagoId = await esc.t.mutation(internal.pagos.registrarPago, {
    condominioId: esc.condominioId,
    unidadId: factura.unidadId,
    facturaId,
    userId: esc.residenteId,
    rqUID: `${Date.now()}${Math.floor(Math.random() * 1e6)}`.slice(0, 19),
    pmtAuthId: `PMT-${facturaId}-${monto}`,
    invoiceNum: factura.apto ?? "101",
    monto,
    estado: "iniciada",
    ambiente: "qa",
  });
  await esc.t.mutation(internal.pagos.aplicarEstado, {
    pagoId,
    estado: "aprobada",
    statusCodeAval: "4",
    medioPago: "PSE",
    fechaPago: Date.now(),
  });
  await esperarProgramadas(esc);
  return pagoId;
}

/**
 * La URL de un comprobante que `quien` acaba de subir (H-12, Fase 4 de S3):
 * `crearMio` solo registra un archivo que quien envía subió, ya validado, a
 * la carpeta de comprobantes del conjunto.
 */
export async function comprobanteSubido(
  esc: Escenario,
  quien: "residente" | "vecino" = "residente",
  nombre = "comprobante.pdf",
) {
  const userId = quien === "residente" ? esc.residenteId : esc.vecinoId;
  const { url } = await subidaValidada(esc.t, { userId, carpeta: carpetaComprobantes(esc.condominioId), nombre });
  return url;
}

/** El residente sube un comprobante y la administración lo aprueba. */
export async function aprobarComprobante(esc: Escenario, facturaId: Id<"facturas">) {
  const soporteId = await esc.como("residente").mutation(api.soportesPago.crearMio, {
    condominioId: esc.condominioId,
    facturaId,
    url: await comprobanteSubido(esc),
    mimeType: "application/pdf",
  });
  await esc.como("admin").mutation(api.soportesPago.aprobar, { id: soporteId });
  await esperarProgramadas(esc);
  return soporteId;
}

/**
 * Lo que valida el backend antes de crear una transacción en la pasarela,
 * por el camino del bot de WhatsApp (`crearPagoFacturaBot`). El de la web
 * (`crearPagoFactura`) usa el mismo `armarDatosTrn`.
 */
export async function datosDePagoBot(esc: Escenario, facturaId: Id<"facturas">) {
  return await esc.t.query(internal.pagos.datosParaTrnDeUsuario, {
    facturaId,
    userId: esc.residenteId,
  });
}

/** Lo mismo por el camino de la web, con la sesión del residente. */
export async function datosDePagoWeb(esc: Escenario, facturaId: Id<"facturas">) {
  return await esc
    .como("residente")
    .query(internal.pagos.datosParaTrn, { facturaId });
}

/** ¿El backend acepta iniciar un pago de esta factura? */
export async function aceptaPagar(
  consulta: Promise<unknown>,
): Promise<{ acepta: boolean; motivo: string | null }> {
  try {
    await consulta;
    return { acepta: true, motivo: null };
  } catch (e) {
    return { acepta: false, motivo: e instanceof Error ? e.message : String(e) };
  }
}

/** Ninguna prueba de facturación puede salir a internet. */
let fetchBloqueado: ReturnType<typeof vi.fn> | null = null;

export function bloquearRed() {
  fetchBloqueado = vi.fn(async (url: unknown) => {
    throw new Error(`Red bloqueada en las pruebas de facturación: ${String(url)}`);
  });
  vi.stubGlobal("fetch", fetchBloqueado);
}

export function liberarRed() {
  const llamadas = fetchBloqueado?.mock.calls.length ?? 0;
  vi.unstubAllGlobals();
  fetchBloqueado = null;
  expect(llamadas, "una función intentó salir a internet").toBe(0);
}
