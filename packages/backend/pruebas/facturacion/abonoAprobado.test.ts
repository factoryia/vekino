import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import {
  aprobarPagoAval,
  bloquearRed,
  bogota,
  cargar,
  esperarProgramadas,
  facturaDe,
  fijarReloj,
  liberarRed,
  linea,
  montar,
  soltarReloj,
  type Escenario,
} from "./escenario";

/**
 * UN ABONO APROBADO BAJA LO QUE FALTA POR PAGAR — hallazgo H1 del QA de
 * comprobantes (docs/qa/QA-FACTORY-COMPROBANTES.md, defecto 2).
 *
 * En Factory: factura de $335.000, el residente reporta $200.000, la
 * administración lo aprueba y la factura queda "Abonada". El residente
 * seguía viendo $335.000, y la pasarela iba a cobrar $335.000 otra vez:
 * `montoAPagarHoy` solo elegía entre el total y el total con descuento.
 *
 * Lo que falta sale de la MISMA regla que decide el estado
 * (`evidenciaDePago`): lo que se cobra hoy menos lo que prueban los pagos
 * aprobados (`estadoPago.montoPagado`). Un comprobante pendiente o rechazado
 * no es un pago aplicado y no descuenta nada.
 *
 * Todo corre en convex-test con datos sintéticos: ni Aval ni la base real.
 */

/** El día de la ronda 2 del QA en Factory. */
const HOY = bogota("2026-10-09T10:00");
/** El instante que manda la web por un día: el mediodía de Colombia. */
const mediodia = (dia: string) => Date.parse(`${dia}T12:00:00-05:00`);

beforeEach(() => {
  bloquearRed();
  fijarReloj(HOY);
});

afterEach(() => {
  soltarReloj();
  liberarRed();
});

/** Septiembre: $335.000 (cuota 314.000 + pozo 21.000), con descuento $295.000 hasta el 15. */
async function conSeptiembre(): Promise<{ esc: Escenario; septiembre: Id<"facturas"> }> {
  const esc = await montar();
  await cargar(esc, [
    {
      periodo: "2026-09",
      lineas: [linea("CUOTA ADMINISTRACION", 0, 314_000), linea("POZO", 0, 21_000, 2)],
      totalConDescuento: 295_000,
    },
  ]);
  return { esc, septiembre: (await facturaDe(esc, "2026-09"))._id };
}

/** El residente envía un comprobante y la administración lo revisa (o no). */
async function comprobante(
  esc: Escenario,
  facturaId: Id<"facturas">,
  monto: number,
  dia: string,
  revision: "aprobar" | "rechazar" | "pendiente" = "aprobar",
) {
  const id = await esc.como("residente").mutation(api.soportesPago.crearMio, {
    condominioId: esc.condominioId,
    facturaId,
    url: "https://archivos.test/comprobante.png",
    mimeType: "image/png",
    monto,
    fechaPago: mediodia(dia),
  });
  if (revision === "aprobar") {
    await esc.como("admin").mutation(api.soportesPago.aprobar, { id, monto, fechaPago: mediodia(dia) });
  } else if (revision === "rechazar") {
    await esc.como("admin").mutation(api.soportesPago.rechazar, { id, notaRevision: "No se lee el valor." });
  }
  await esperarProgramadas(esc);
  return id;
}

/** Lo que la pasarela cobraría desde la web (`crearPagoFactura` → `armarDatosTrn`). */
async function montoWeb(esc: Escenario, facturaId: Id<"facturas">) {
  return (await esc.como("residente").query(internal.pagos.datosParaTrn, { facturaId })).monto;
}

/** Lo mismo por el bot de WhatsApp (`crearPagoFacturaBot`). */
async function montoBot(esc: Escenario, facturaId: Id<"facturas">) {
  return (
    await esc.t.query(internal.pagos.datosParaTrnDeUsuario, { facturaId, userId: esc.residenteId })
  ).monto;
}

/** Lo que dice la campana del residente de cada factura. */
async function campana(esc: Escenario) {
  const { items } = await esc
    .como("residente")
    .query(api.notificacionesFeed.feed, { condominioId: esc.condominioId });
  return items.filter((i) => i.tipo === "factura").map((i) => i.detalle);
}

describe("H1 · el abono aprobado se descuenta en todo lo que cobra o anuncia el backend", () => {
  test("el caso del QA: $335.000, abono aprobado de $200.000 → faltan $135.000 en la pasarela (web y bot) y en la campana", async () => {
    const { esc, septiembre } = await conSeptiembre();
    expect(await montoWeb(esc, septiembre)).toBe(335_000);

    await comprobante(esc, septiembre, 200_000, "2026-10-09");

    const f = await facturaDe(esc, "2026-09");
    expect(f.estado).toBe("abonada");
    expect(f.estadoPago).toMatchObject({ estado: "abonada", montoPagado: 200_000, montoAdeudado: 335_000 });
    expect(await montoWeb(esc, septiembre)).toBe(135_000);
    expect(await montoBot(esc, septiembre)).toBe(135_000);
    expect(await campana(esc)).toEqual(["Por pagar · $ 135.000"]);
    /* Sigue debiendo: se puede pagar y enviar comprobante. */
    expect(
      await esc.como("residente").query(api.pagos.opcionesDePago, { facturaId: septiembre }),
    ).toMatchObject({ debe: true });
  });

  test("sin abonos no cambia nada: se cobra el total", async () => {
    const { esc, septiembre } = await conSeptiembre();
    expect(await montoWeb(esc, septiembre)).toBe(335_000);
    expect(await montoBot(esc, septiembre)).toBe(335_000);
    expect(await campana(esc)).toEqual(["Por pagar · $ 335.000"]);
  });

  test("un comprobante sin revisar o rechazado NO es un abono: no descuenta nada", async () => {
    const { esc, septiembre } = await conSeptiembre();
    await comprobante(esc, septiembre, 200_000, "2026-10-09", "rechazar");
    expect(await montoWeb(esc, septiembre)).toBe(335_000);

    await comprobante(esc, septiembre, 200_000, "2026-10-09", "pendiente");
    expect((await facturaDe(esc, "2026-09")).estado).toBe("pendiente");
    expect(await montoWeb(esc, septiembre)).toBe(335_000);
    expect(await campana(esc)).toEqual(["Por pagar · $ 335.000"]);
  });

  test("abonos sucesivos se acumulan, y al completar el total la factura queda pagada y no se cobra más", async () => {
    const { esc, septiembre } = await conSeptiembre();
    await comprobante(esc, septiembre, 200_000, "2026-10-01");
    expect(await montoWeb(esc, septiembre)).toBe(135_000);

    await comprobante(esc, septiembre, 100_000, "2026-10-05");
    expect((await facturaDe(esc, "2026-09")).estadoPago).toMatchObject({ estado: "abonada", montoPagado: 300_000 });
    expect(await montoWeb(esc, septiembre)).toBe(35_000);
    expect(await campana(esc)).toEqual(["Por pagar · $ 35.000"]);

    await comprobante(esc, septiembre, 35_000, "2026-10-09");
    expect((await facturaDe(esc, "2026-09")).estado).toBe("pagada");
    await expect(montoWeb(esc, septiembre)).rejects.toThrow("Esta factura ya está pagada.");
    expect(await campana(esc)).toEqual(["Pagada"]);
  });

  test("un abono por la pasarela cuenta igual que un comprobante", async () => {
    const { esc, septiembre } = await conSeptiembre();
    await aprobarPagoAval(esc, septiembre, 200_000);
    expect((await facturaDe(esc, "2026-09")).estado).toBe("abonada");
    expect(await montoWeb(esc, septiembre)).toBe(135_000);
  });

  test("un pago reversado deja de descontarse", async () => {
    const { esc, septiembre } = await conSeptiembre();
    const pagoId = await aprobarPagoAval(esc, septiembre, 200_000);
    expect(await montoWeb(esc, septiembre)).toBe(135_000);

    await esc.t.mutation(internal.pagos.reversarPago, {
      pagoId,
      motivo: "Contracargo del banco (prueba)",
      actor: "Prueba",
    });
    expect((await facturaDe(esc, "2026-09")).estado).toBe("pendiente");
    expect(await montoWeb(esc, septiembre)).toBe(335_000);
  });

  test("con el descuento vigente: lo que falta es el total con descuento menos lo abonado, y pagarlo a tiempo salda la factura", async () => {
    vi.setSystemTime(bogota("2026-09-10T10:00"));
    const { esc, septiembre } = await conSeptiembre();
    await comprobante(esc, septiembre, 200_000, "2026-09-10");
    expect(await montoWeb(esc, septiembre)).toBe(95_000);
    expect(await campana(esc)).toEqual(["Por pagar · $ 95.000"]);

    /* Pagar esos $95.000 dentro del plazo completa el valor con descuento. */
    vi.setSystemTime(bogota("2026-09-12T14:00"));
    expect(await montoWeb(esc, septiembre)).toBe(95_000);
    await comprobante(esc, septiembre, 95_000, "2026-09-12");
    expect((await facturaDe(esc, "2026-09")).estadoPago).toMatchObject({
      estado: "pagada",
      conDescuento: true,
      montoPagado: 295_000,
    });
  });

  test("vencido el descuento, lo que falta es el total menos lo abonado (el abono no queda 'con descuento')", async () => {
    vi.setSystemTime(bogota("2026-09-10T10:00"));
    const { esc, septiembre } = await conSeptiembre();
    await comprobante(esc, septiembre, 200_000, "2026-09-10");

    vi.setSystemTime(bogota("2026-09-16T08:00"));
    expect(await montoWeb(esc, septiembre)).toBe(135_000);
  });

  test("un pago de más deja la factura pagada y nunca un saldo negativo por cobrar", async () => {
    const { esc, septiembre } = await conSeptiembre();
    await comprobante(esc, septiembre, 400_000, "2026-10-09");
    const f = await facturaDe(esc, "2026-09");
    expect(f.estadoPago).toMatchObject({ estado: "pagada", excedente: 65_000 });
    await expect(montoWeb(esc, septiembre)).rejects.toThrow("Esta factura ya está pagada.");
    expect(await campana(esc)).toEqual(["Pagada"]);
  });
});

describe("H1 · la revisión de la administración parte de lo que falta, no del total", () => {
  test("el segundo comprobante muestra lo que se debía ese día descontando el abono ya aprobado", async () => {
    const { esc, septiembre } = await conSeptiembre();
    await comprobante(esc, septiembre, 200_000, "2026-10-01");
    const segundo = await comprobante(esc, septiembre, 135_000, "2026-10-09", "pendiente");

    const lista = await esc
      .como("admin")
      .query(api.soportesPago.listByCondominio, { condominioId: esc.condominioId });
    expect(lista.find((s) => s._id === segundo)?.facturaAdeudado).toBe(135_000);
  });

  test("aprobar sin monto después de un abono toma solo lo que faltaba: el recaudo no cuenta el abono dos veces", async () => {
    const { esc, septiembre } = await conSeptiembre();
    await comprobante(esc, septiembre, 200_000, "2026-10-01");

    /* Una app vieja, sin monto: la administración lo aprueba tal cual. */
    const viejo = await esc.como("residente").mutation(api.soportesPago.crearMio, {
      condominioId: esc.condominioId,
      facturaId: septiembre,
      url: "https://archivos.test/comprobante-viejo.pdf",
      mimeType: "application/pdf",
    });
    await esc.como("admin").mutation(api.soportesPago.aprobar, { id: viejo });
    await esperarProgramadas(esc);

    const soporte = await esc.t.run(async (ctx) => await ctx.db.get(viejo));
    expect(soporte).toMatchObject({ estado: "aprobado", monto: 135_000, montoAsumido: true });
    expect((await facturaDe(esc, "2026-09")).estado).toBe("pagada");

    const resumen = await esc
      .como("admin")
      .query(api.facturas.resumenPeriodo, { condominioId: esc.condominioId, periodo: "2026-09" });
    expect(resumen.recaudoVekino).toBe(335_000);
  });
});
