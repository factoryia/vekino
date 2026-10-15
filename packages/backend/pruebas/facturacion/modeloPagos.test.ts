import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { MENSAJE_COMPROBANTE_HISTORICA } from "../../convex/soportesPago";
import {
  AHORA,
  DIA,
  aprobarPagoAval,
  bloquearRed,
  bogota,
  cargar,
  comoLaCargaPorPdf,
  comprobanteSubido,
  datosDePagoBot,
  esperarProgramadas,
  facturaDe,
  facturasDe,
  fijarReloj,
  insertarDirecto,
  liberarRed,
  linea,
  montar,
  soltarReloj,
  type Escenario,
  type FacturaCarga,
} from "./escenario";

/**
 * MODELO DE PAGOS Y ESTADOS (Fase 3 de la auditoría de facturación,
 * docs/audits/FASE-3-FACTURACION.md) — lo que se agregó en esta fase y la red
 * de la Fase 0 no cubría:
 *
 *   · cada ruta que cambia una factura deja su evento en la bitácora;
 *   · un pago que la contabilidad no refleja abre una discrepancia: la
 *     vigente no se cobra y la unidad no queda en mora por ese monto, hasta
 *     que un documento lo refleje o la administración lo resuelva;
 *   · el monto pagado cuenta (abonos, varios pagos, excedente, descuento,
 *     reverso), y la consulta diaria rescata pagos sin estado final;
 *   · los comprobantes llevan monto y solo van a la vigente;
 *   · un solo escritor de facturas, por identidad;
 *   · operación segura: AVAL_AMBIENTE obligatorio, `limpieza` y
 *     `pagosPruebas` no tocan la evidencia real;
 *   · una lectura sin total no se vuelve cobrable sin verificarla, y la
 *     llave de una importación incluye el modo.
 *
 * Red bloqueada en todas (`bloquearRed`): nada sale a Aval ni a internet.
 */

beforeEach(() => {
  bloquearRed();
  fijarReloj();
});
afterEach(() => {
  soltarReloj();
  liberarRed();
});

const CUOTA = 300_000;
const ago: FacturaCarga = { periodo: "2026-08", lineas: [linea("CUOTA", 0, CUOTA)] };
const sepArrastra = (saldo: number): FacturaCarga => ({
  periodo: "2026-09",
  lineas: [linea("CUOTA", saldo, CUOTA)],
});

async function eventos(esc: Escenario, facturaId: Id<"facturas">) {
  return await esc.t.run(
    async (ctx) =>
      await ctx.db
        .query("facturaEventos")
        .withIndex("by_factura", (q) => q.eq("facturaId", facturaId))
        .collect(),
  );
}

async function discrepancias(esc: Escenario) {
  return await esc.t.run(async (ctx) => await ctx.db.query("discrepanciasPago").collect());
}

async function programadas(esc: Escenario) {
  const filas = await esc.t.run(
    async (ctx) => await ctx.db.system.query("_scheduled_functions").collect(),
  );
  return filas.map((f) => ({
    name: f.name,
    args: (Array.isArray(f.args) ? f.args[0] : f.args) as Record<string, unknown>,
  }));
}

/** Un pago creado en un instante dado y aprobado por la pasarela. */
async function pagoAprobadoEl(
  esc: Escenario,
  facturaId: Id<"facturas">,
  monto: number,
  instante: number,
) {
  vi.setSystemTime(instante);
  const pagoId = await aprobarPagoAval(esc, facturaId, monto);
  vi.setSystemTime(AHORA);
  return pagoId;
}

/** Un pago en la pasarela, sin aprobar, creado en un instante dado. */
async function pagoIniciadoEl(
  esc: Escenario,
  facturaId: Id<"facturas">,
  instante: number,
  extra: { esPrueba?: boolean } = {},
) {
  vi.setSystemTime(instante);
  const pagoId = await esc.t.mutation(internal.pagos.registrarPago, {
    condominioId: esc.condominioId,
    unidadId: esc.u101,
    facturaId,
    userId: esc.residenteId,
    rqUID: `${instante}${Math.floor(Math.random() * 1e6)}`.slice(0, 19),
    pmtAuthId: `PMT-${instante}`,
    invoiceNum: "101",
    monto: CUOTA,
    estado: "iniciada",
    ambiente: "qa",
    ...extra,
  });
  vi.setSystemTime(AHORA);
  return pagoId;
}

/** Cambia variables de entorno y las restaura al final de la prueba. */
const entornoOriginal = new Map<string, string | undefined>();
function entorno(nombre: string, valor: string | undefined) {
  if (!entornoOriginal.has(nombre)) entornoOriginal.set(nombre, process.env[nombre]);
  if (valor === undefined) delete process.env[nombre];
  else process.env[nombre] = valor;
}
afterEach(() => {
  for (const [nombre, valor] of entornoOriginal) {
    if (valor === undefined) delete process.env[nombre];
    else process.env[nombre] = valor;
  }
  entornoOriginal.clear();
});

describe("bitácora: cada ruta que cambia una factura deja su evento", () => {
  test("la carga crea con su evento, y la conciliación deja el suyo en la anterior", async () => {
    const esc = await montar();
    await cargar(esc, [ago]);
    const agosto = await facturaDe(esc, "2026-08");
    expect((await eventos(esc, agosto._id)).map((e) => [e.origen, e.estadoAntes ?? null, e.estadoDespues])).toEqual([
      ["carga", null, "pendiente"],
    ]);
    await cargar(esc, [sepArrastra(CUOTA)]);
    const despues = await eventos(esc, agosto._id);
    expect(despues.map((e) => [e.origen, e.estadoAntes ?? null, e.estadoDespues])).toEqual([
      ["carga", null, "pendiente"],
      ["conciliacion", "pendiente", "vencida"],
    ]);
    expect(despues[1]?.actor).toBe("Administración");
    expect(despues[1]?.detalle).toMatch(/La factura siguiente dice que quedó vencida/);
  });

  test("pago, comprobante, confirmación de lectura, botón Conciliar, migración y script", async () => {
    const esc = await montar();
    // Pago
    await cargar(esc, [ago]);
    const agosto = await facturaDe(esc, "2026-08");
    await aprobarPagoAval(esc, agosto._id, CUOTA);
    expect((await eventos(esc, agosto._id)).at(-1)).toMatchObject({
      origen: "pago",
      estadoAntes: "pendiente",
      estadoDespues: "pagada",
      actor: "Pasarela Aval",
    });

    // Comprobante (casa 202)
    await cargar(esc, [{ ...ago, casa: "u202" }]);
    const de202 = await facturaDe(esc, "2026-08", "u202");
    const soporteId = await esc.como("vecino").mutation(api.soportesPago.crearMio, {
      condominioId: esc.condominioId,
      facturaId: de202._id,
      url: await comprobanteSubido(esc, "vecino", "c.pdf"),
      monto: CUOTA,
      fechaPago: bogota("2026-09-10T10:00"),
    });
    await esc.como("admin").mutation(api.soportesPago.aprobar, { id: soporteId, monto: CUOTA });
    await esperarProgramadas(esc);
    expect((await eventos(esc, de202._id)).at(-1)).toMatchObject({ origen: "comprobante", estadoDespues: "pagada" });

    // Confirmación de lectura
    await esc.como("admin").mutation(api.facturas.bulkUpsert, {
      facturas: [{ ...comoLaCargaPorPdf(esc, sepArrastra(0)), totalAPagar: 0 }],
      skipExisting: true,
    });
    const sept = await facturaDe(esc, "2026-09");
    await esc.como("admin").mutation(api.facturas.confirmarLectura, { facturaId: sept._id });
    expect((await eventos(esc, sept._id)).at(-1)).toMatchObject({ origen: "confirmacion_lectura" });

    // Conciliar: una cadena que nadie había juzgado
    const esc2 = await montar();
    const a2 = await insertarDirecto(esc2, ago, "pendiente");
    await insertarDirecto(esc2, sepArrastra(CUOTA), "pendiente");
    await esc2.como("admin").mutation(api.facturas.reconciliar, { condominioId: esc2.condominioId });
    expect((await eventos(esc2, a2)).map((e) => [e.origen, e.estadoDespues])).toEqual([["conciliacion", "vencida"]]);

    // Migración y script
    const esc3 = await montar();
    await esc3.t.mutation(internal.migrations.bulkFacturas, {
      facturas: [{ ...comoLaCargaPorPdf(esc3, ago), legacyId: "legacy-1" }],
    });
    const migrada = await facturaDe(esc3, "2026-08");
    expect((await eventos(esc3, migrada._id))[0]).toMatchObject({ origen: "migracion", actor: "migrations.bulkFacturas" });
    await esc3.t.mutation(internal.facturas.upsertFactura, comoLaCargaPorPdf(esc3, sepArrastra(CUOTA)));
    const porScript = await facturaDe(esc3, "2026-09");
    expect((await eventos(esc3, porScript._id))[0]).toMatchObject({ origen: "migracion", actor: "facturas.upsertFactura" });
  });

  test("el re-procesamiento deja el suyo", async () => {
    const esc = await montar();
    const agosto = await insertarDirecto(esc, { ...ago, totalAPagar: 0 }, "vencida");
    await esc.t.mutation(internal.facturas.reprocesarLecturas, {
      condominioId: esc.condominioId,
      dryRun: false,
      lecturas: [
        {
          facturaId: agosto,
          vrAdmon: CUOTA,
          lineas: [linea("CUOTA", 0, CUOTA)],
          saldoAFavor: 0,
          totalAPagar: CUOTA,
          periodoLabel: "Agosto / 2026",
          motivos: [],
        },
      ],
    });
    expect((await eventos(esc, agosto)).at(-1)).toMatchObject({ origen: "reproceso", actor: "facturas.reprocesarLecturas" });
  });
});

describe("discrepancias: un pago que la contabilidad no refleja", () => {
  async function agostoPagadoYSeptiembreArrastra() {
    const esc = await montar();
    await cargar(esc, [ago]);
    const agosto = await facturaDe(esc, "2026-08");
    await aprobarPagoAval(esc, agosto._id, CUOTA);
    await cargar(esc, [sepArrastra(CUOTA)]);
    return { esc, agosto, septiembre: await facturaDe(esc, "2026-09") };
  }

  test("se registra, la vigente no se cobra y la unidad no queda en mora por ese monto", async () => {
    const { esc, agosto, septiembre } = await agostoPagadoYSeptiembreArrastra();
    const [d] = await discrepancias(esc);
    expect(d).toMatchObject({
      estado: "abierta",
      facturaId: agosto._id,
      facturaSiguienteId: septiembre._id,
      montoNoAplicado: CUOTA,
      saldoAnteriorSiguiente: CUOTA,
    });
    expect(septiembre.pagoEnVerificacion).toEqual({ monto: CUOTA, discrepancias: [d!._id] });
    expect(await esc.como("residente").query(api.pagos.puedePagar, { facturaId: septiembre._id })).toBe(false);
    await expect(datosDePagoBot(esc, septiembre._id)).rejects.toThrow(/la contabilidad aún no lo refleja/);

    /* El 20 de octubre septiembre ya venció: sin la discrepancia sería mora. */
    vi.setSystemTime(bogota("2026-10-20T10:00"));
    const [fila] = await esc.como("admin").query(api.facturas.carteraPorUnidad, {
      condominioId: esc.condominioId,
      unidadIds: [esc.u101],
    });
    expect(fila).toMatchObject({ estado: "en_revision", motivoRevision: "pago_en_verificacion", montoEnVerificacion: CUOTA });
    const { items } = await esc.como("residente").query(api.notificacionesFeed.feed, { condominioId: esc.condominioId });
    expect(items.find((i) => i.titulo.includes("Septiembre"))?.detalle).toBe("Pago en verificación · $ 300.000");
  });

  test("se resuelve sola cuando la contabilidad corrige el documento siguiente", async () => {
    const { esc, septiembre } = await agostoPagadoYSeptiembreArrastra();
    await cargar(esc, [sepArrastra(0)], { skipExisting: false });
    const [d] = await discrepancias(esc);
    expect(d).toMatchObject({ estado: "resuelta", resolucion: { tipo: "documento_corregido", facturaId: septiembre._id } });
    expect((await facturaDe(esc, "2026-09")).pagoEnVerificacion).toBeUndefined();
    expect(await esc.como("residente").query(api.pagos.puedePagar, { facturaId: septiembre._id })).toBe(true);
  });

  test("y cuando un documento posterior muestra el pago aplicado", async () => {
    const { esc } = await agostoPagadoYSeptiembreArrastra();
    /* Octubre arrastra solo la cuota de septiembre: los 300.000 de agosto se aplicaron. */
    await cargar(esc, [{ periodo: "2026-10", lineas: [linea("CUOTA", CUOTA, CUOTA)] }]);
    const octubre = await facturaDe(esc, "2026-10");
    const [d] = await discrepancias(esc);
    expect(d).toMatchObject({ estado: "resuelta", resolucion: { tipo: "aplicado_en_documento_posterior", facturaId: octubre._id } });
    expect(octubre.pagoEnVerificacion).toBeUndefined();
    expect((await facturaDe(esc, "2026-09")).pagoEnVerificacion).toBeUndefined();
  });

  test("la administración la resuelve a mano, con nota; el residente no puede", async () => {
    const { esc, agosto, septiembre } = await agostoPagadoYSeptiembreArrastra();
    const [d] = await discrepancias(esc);
    await expect(
      esc.como("residente").mutation(api.facturas.resolverDiscrepancia, { id: d!._id, nota: "ya" }),
    ).rejects.toThrow();
    await expect(
      esc.como("admin").mutation(api.facturas.resolverDiscrepancia, { id: d!._id, nota: "  " }),
    ).rejects.toThrow(/Escribe qué se verificó/);
    await esc.como("admin").mutation(api.facturas.resolverDiscrepancia, {
      id: d!._id,
      nota: "La contabilidad lo aplicó en la nota crédito 12.",
    });
    expect((await discrepancias(esc))[0]).toMatchObject({
      estado: "resuelta",
      resolucion: { tipo: "administracion", nota: "La contabilidad lo aplicó en la nota crédito 12.", userId: esc.adminId },
    });
    expect(await esc.como("residente").query(api.pagos.puedePagar, { facturaId: septiembre._id })).toBe(true);
    expect((await eventos(esc, agosto._id)).at(-1)?.detalle).toMatch(/Discrepancia resuelta por Administración: La contabilidad lo aplicó/);
    /* Volver a calcular no la reabre: los montos son los mismos. */
    await esc.como("admin").mutation(api.facturas.reconciliar, { condominioId: esc.condominioId });
    expect((await discrepancias(esc))[0]?.estado).toBe("resuelta");
  });

  test("un abono que la contabilidad refleja no es discrepancia (#22)", async () => {
    const esc = await montar();
    await cargar(esc, [ago]);
    await aprobarPagoAval(esc, (await facturaDe(esc, "2026-08"))._id, 250_000);
    await cargar(esc, [sepArrastra(50_000)]);
    expect(await discrepancias(esc)).toEqual([]);
  });
});

describe("el monto pagado cuenta", () => {
  test("un abono y otro pago completan: pagada; el aviso sale una vez por pago", async () => {
    const esc = await montar();
    await cargar(esc, [ago]);
    const agosto = await facturaDe(esc, "2026-08");
    const primero = await aprobarPagoAval(esc, agosto._id, 100_000);
    expect((await facturaDe(esc, "2026-08")).estado).toBe("abonada");
    await aprobarPagoAval(esc, agosto._id, 200_000);
    expect(await facturaDe(esc, "2026-08")).toMatchObject({
      estado: "pagada",
      estadoPago: { estado: "pagada", montoPagado: CUOTA, montoAdeudado: CUOTA },
    });
    /* Consultar otra vez un pago ya aprobado no vuelve a avisar ni a mover nada. */
    await esc.t.mutation(internal.pagos.aplicarEstado, { pagoId: primero, estado: "aprobada", statusCodeAval: "4" });
    await esperarProgramadas(esc);
    const avisos = (await programadas(esc)).filter((p) => p.name.includes("pagoAprobado") && p.args.pagoId === primero);
    expect(avisos).toHaveLength(1);
  });

  test("lo pagado de más queda como excedente y se informa a Finanzas", async () => {
    const esc = await montar();
    await cargar(esc, [ago]);
    const agosto = await facturaDe(esc, "2026-08");
    await aprobarPagoAval(esc, agosto._id, 350_000);
    expect((await facturaDe(esc, "2026-08")).estadoPago).toMatchObject({ estado: "pagada", excedente: 50_000 });
    const r = await esc.como("admin").query(api.facturas.pagosPorRevisar, { condominioId: esc.condominioId });
    expect(r.excedentes).toEqual([
      expect.objectContaining({ facturaId: agosto._id, excedente: 50_000, montoPagado: 350_000, montoAdeudado: CUOTA }),
    ]);
  });

  test("con descuento: pagado dentro del plazo cubre; el mismo monto después del 15 es un abono", async () => {
    const conDescuento: FacturaCarga = {
      periodo: "2026-09",
      lineas: [linea("CUOTA", 0, 380_000)],
      totalConDescuento: 340_000,
    };
    const dentro = await montar();
    await cargar(dentro, [conDescuento]);
    await pagoAprobadoEl(dentro, (await facturaDe(dentro, "2026-09"))._id, 340_000, bogota("2026-09-10T10:00"));
    expect((await facturaDe(dentro, "2026-09")).estadoPago).toMatchObject({ estado: "pagada", conDescuento: true, montoAdeudado: 340_000 });

    const fuera = await montar();
    await cargar(fuera, [conDescuento]);
    await pagoAprobadoEl(fuera, (await facturaDe(fuera, "2026-09"))._id, 340_000, bogota("2026-09-20T10:00"));
    expect((await facturaDe(fuera, "2026-09")).estadoPago).toMatchObject({ estado: "abonada", conDescuento: false, montoAdeudado: 380_000 });
  });

  test("un pago reversado deja de ser evidencia, con su motivo en la bitácora", async () => {
    const esc = await montar();
    await cargar(esc, [ago]);
    const agosto = await facturaDe(esc, "2026-08");
    const pagoId = await aprobarPagoAval(esc, agosto._id, CUOTA);
    await expect(
      esc.t.mutation(internal.pagos.reversarPago, { pagoId, motivo: " ", actor: "Tesorería" }),
    ).rejects.toThrow(/motivo/);
    expect(
      await esc.t.mutation(internal.pagos.reversarPago, { pagoId, motivo: "Contracargo del banco", actor: "Tesorería" }),
    ).toEqual({ reversado: true });
    expect(await esc.t.run(async (ctx) => (await ctx.db.get(pagoId))?.estado)).toBe("reversada");
    const despues = await facturaDe(esc, "2026-08");
    expect(despues.estado).toBe("pendiente");
    expect(despues.estadoPago).toBeUndefined();
    expect((await eventos(esc, agosto._id)).at(-1)).toMatchObject({
      origen: "pago",
      estadoAntes: "pagada",
      estadoDespues: "pendiente",
      actor: "Tesorería",
    });
    /* Una consulta que llegue después no lo vuelve a aprobar. */
    await esc.t.mutation(internal.pagos.aplicarEstado, { pagoId, estado: "aprobada", statusCodeAval: "4" });
    expect((await facturaDe(esc, "2026-08")).estado).toBe("pendiente");
    expect(await esc.t.mutation(internal.pagos.reversarPago, { pagoId, motivo: "otra vez", actor: "x" })).toEqual({
      reversado: false,
      motivo: "ya estaba reversado",
    });
  });
});

describe("re-consulta diaria de pagos sin estado final (Aval simulado)", () => {
  test("agenda los de la última semana, marca los más viejos y no toca los recientes ni los aprobados", async () => {
    const esc = await montar();
    await cargar(esc, [sepArrastra(0)]);
    const sept = await facturaDe(esc, "2026-09");
    const deHaceTresDias = await pagoIniciadoEl(esc, sept._id, AHORA - 3 * DIA);
    const recien = await pagoIniciadoEl(esc, sept._id, AHORA - 30 * 60 * 1000);
    const viejo = await pagoIniciadoEl(esc, sept._id, AHORA - 10 * DIA);
    const r = await esc.t.mutation(internal.pagos.reconsultaDiaria, {});
    expect(r).toEqual({ agendados: 1, agotados: 1 });

    const consultas = (await programadas(esc)).filter((p) => p.name.includes("consultarEstado"));
    expect(consultas.map((p) => p.args.pagoId)).toEqual([deHaceTresDias]);
    expect(await esc.t.run(async (ctx) => (await ctx.db.get(viejo))?.consultaAgotadaAt)).toBe(AHORA);
    /* `t.run` devuelve `null` por un `undefined`: no tiene la marca. */
    expect(await esc.t.run(async (ctx) => (await ctx.db.get(recien))?.consultaAgotadaAt ?? null)).toBeNull();
    const porRevisar = await esc.como("admin").query(api.facturas.pagosPorRevisar, { condominioId: esc.condominioId });
    expect(porRevisar.sinEstadoFinal.map((p) => p.pagoId)).toEqual([viejo]);

    /* Aval responde (simulado): aprobada. La factura queda pagada. */
    await esc.t.mutation(internal.pagos.aplicarEstado, {
      pagoId: deHaceTresDias,
      estado: "aprobada",
      statusCodeAval: "4",
      fechaPago: AHORA,
    });
    await esperarProgramadas(esc);
    expect((await facturaDe(esc, "2026-09")).estado).toBe("pagada");
  });
});

describe("comprobantes con monto, solo para la vigente", () => {
  test("con monto: aprobarlo es un pago por ese valor (250.000 de 300.000 es un abono)", async () => {
    const esc = await montar();
    await cargar(esc, [ago]);
    const agosto = await facturaDe(esc, "2026-08");
    const id = await esc.como("residente").mutation(api.soportesPago.crearMio, {
      condominioId: esc.condominioId,
      facturaId: agosto._id,
      url: await comprobanteSubido(esc, "residente", "c.jpg"),
      monto: 250_000,
      fechaPago: bogota("2026-09-10T10:00"),
    });
    await esc.como("admin").mutation(api.soportesPago.aprobar, { id });
    await esperarProgramadas(esc);
    expect((await facturaDe(esc, "2026-08")).estado).toBe("abonada");
    expect(await esc.t.run(async (ctx) => await ctx.db.get(id))).toMatchObject({ estado: "aprobado", monto: 250_000 });
  });

  test("sin monto (app vieja, aprobado por la API): pago completo, y así queda escrito", async () => {
    const esc = await montar();
    await cargar(esc, [ago]);
    const agosto = await facturaDe(esc, "2026-08");
    const id = await esc.como("residente").mutation(api.soportesPago.crearMio, {
      condominioId: esc.condominioId,
      facturaId: agosto._id,
      url: await comprobanteSubido(esc, "residente", "c.jpg"),
    });
    await esc.como("admin").mutation(api.soportesPago.aprobar, { id });
    await esperarProgramadas(esc);
    expect((await facturaDe(esc, "2026-08")).estado).toBe("pagada");
    expect(await esc.t.run(async (ctx) => await ctx.db.get(id))).toMatchObject({ monto: CUOTA, montoAsumido: true });
  });

  test("a una factura histórica no se le adjunta comprobante (app ni bot)", async () => {
    const esc = await montar();
    await cargar(esc, [ago]);
    await cargar(esc, [sepArrastra(CUOTA)]);
    const agosto = await facturaDe(esc, "2026-08");
    await expect(
      esc.como("residente").mutation(api.soportesPago.crearMio, {
        condominioId: esc.condominioId,
        facturaId: agosto._id,
        url: await comprobanteSubido(esc, "residente", "c.jpg"),
        monto: CUOTA,
      }),
    ).rejects.toThrow(MENSAJE_COMPROBANTE_HISTORICA);
    await expect(
      esc.t.mutation(internal.soportesPago.crearDesdeBot, {
        condominioId: esc.condominioId,
        facturaId: agosto._id,
        url: "https://archivos.test/c.jpg",
      }),
    ).rejects.toThrow(MENSAJE_COMPROBANTE_HISTORICA);
  });

  test("sin factura vinculada: queda aprobado y ningún estado cambia", async () => {
    const esc = await montar();
    await cargar(esc, [ago]);
    const antes = await facturasDe(esc);
    const id = await esc.t.mutation(internal.soportesPago.crearDesdeBot, {
      condominioId: esc.condominioId,
      url: "https://archivos.test/c.jpg",
      telefono: "+573001112233",
    });
    await esc.t.mutation(internal.soportesPago.registrarMontoBot, { soporteId: id, telefono: "+573001112233", monto: 120_000 });
    await expect(
      esc.t.mutation(internal.soportesPago.registrarMontoBot, { soporteId: id, telefono: "+570000000000", monto: 1_000 }),
    ).rejects.toThrow();
    await esc.como("admin").mutation(api.soportesPago.aprobar, { id });
    await esperarProgramadas(esc);
    expect(await esc.t.run(async (ctx) => await ctx.db.get(id))).toMatchObject({ estado: "aprobado", monto: 120_000 });
    expect((await facturasDe(esc)).map((f) => [f.estado, f.updatedAt])).toEqual(antes.map((f) => [f.estado, f.updatedAt]));
  });
});

describe("un solo escritor de facturas", () => {
  test("la web, el script, la migración y la alta manual escriben la MISMA factura", async () => {
    const esc = await montar();
    await cargar(esc, [ago]);
    await esc.t.mutation(internal.facturas.upsertFactura, { ...comoLaCargaPorPdf(esc, ago), estado: "pagada" });
    await esc.t.mutation(internal.migrations.bulkFacturas, {
      facturas: [{ ...comoLaCargaPorPdf(esc, ago), legacyId: "legacy-x" }],
    });
    await expect(
      esc.como("admin").mutation(api.facturas.createManual, {
        condominioId: esc.condominioId,
        unidadId: esc.u101,
        periodo: "2026-08",
        fechaVencimiento: bogota("2026-08-31T00:00"),
        valor: CUOTA,
      }),
    ).rejects.toThrow(/Ya existe una factura/);
    const agosto = (await facturasDe(esc)).filter((f) => f.periodo === "2026-08");
    expect(agosto).toHaveLength(1);
    /* El "pagada" que mandó el script no se escribe: no hay pago ni veredicto. */
    expect(agosto[0]?.estado).toBe("pendiente");
  });

  test("una factura hecha a mano la reemplaza el PDF del mismo período, aun con 'solo nuevas'", async () => {
    const esc = await montar();
    await esc.como("admin").mutation(api.facturas.createManual, {
      condominioId: esc.condominioId,
      unidadId: esc.u101,
      periodo: "2026-09",
      fechaVencimiento: bogota("2026-09-30T00:00"),
      valor: 250_000,
    });
    expect((await facturaDe(esc, "2026-09")).origen).toBe("manual");
    const r = await cargar(esc, [sepArrastra(0)]);
    expect(r).toMatchObject({ inserted: 0, updated: 1, skipped: 0 });
    const sept = await facturaDe(esc, "2026-09");
    expect(sept).toMatchObject({ origen: "pdf", totalAPagar: CUOTA });
    expect((await eventos(esc, sept._id)).at(-1)?.detalle).toMatch(/El PDF reemplazó la factura hecha a mano/);
  });

  test("dos documentos de la misma unidad en el mismo lote: no se guarda ninguno", async () => {
    const esc = await montar();
    const r = await esc.como("admin").mutation(api.facturas.bulkUpsert, {
      facturas: [comoLaCargaPorPdf(esc, sepArrastra(0), 1), comoLaCargaPorPdf(esc, sepArrastra(0), 2)],
      skipExisting: true,
    });
    expect(r.rechazos.map((x) => x.motivo)).toEqual(["documento_repetido", "documento_repetido"]);
    expect(await facturasDe(esc)).toHaveLength(0);
    const plan = await esc.como("admin").mutation(api.facturas.iniciarImportacion, {
      condominioId: esc.condominioId,
      periodo: "2026-09",
      archivo: "septiembre.pdf",
      hash: "c".repeat(64),
      soloNuevas: true,
      documentos: 2,
      candidatas: [
        { indice: 0, unidadId: esc.u101, periodoLabel: "Septiembre / 2026" },
        { indice: 1, unidadId: esc.u101, periodoLabel: "Septiembre / 2026" },
      ],
    });
    expect(plan.plan).toEqual([
      { indice: 0, accion: "rechazar", motivo: "documento_repetido" },
      { indice: 1, accion: "rechazar", motivo: "documento_repetido" },
    ]);
  });
});

describe("operación segura", () => {
  test("sin AVAL_AMBIENTE no se habla con el banco", async () => {
    const esc = await montar();
    entorno("AVAL_AMBIENTE", undefined);
    /* Por si acaso: un endpoint que no existe. Nada debe llegar a usarse. */
    entorno("AVAL_ENDPOINT", "https://aval.invalid");
    await expect(
      esc.t.action(internal.pagos.crearTrnCertificacion, { monto: 1_000, tipoPersona: "natural" }),
    ).rejects.toThrow(/AVAL_AMBIENTE/);
  });

  test("la limpieza de operación no toca pagos, comprobantes, bitácora, discrepancias ni importaciones", async () => {
    const esc = await montar();
    await cargar(esc, [ago]);
    const agosto = await facturaDe(esc, "2026-08");
    await aprobarPagoAval(esc, agosto._id, CUOTA);
    await cargar(esc, [sepArrastra(CUOTA)]);
    await esc.t.mutation(internal.soportesPago.crearDesdeBot, { condominioId: esc.condominioId, url: "https://archivos.test/c.jpg" });
    const contar = () =>
      esc.t.run(async (ctx) => ({
        pagos: (await ctx.db.query("pagos").collect()).length,
        soportes: (await ctx.db.query("soportesPago").collect()).length,
        eventos: (await ctx.db.query("facturaEventos").collect()).length,
        discrepancias: (await ctx.db.query("discrepanciasPago").collect()).length,
        facturas: (await ctx.db.query("facturas").collect()).length,
      }));
    const antes = await contar();
    expect(antes).toMatchObject({ pagos: 1, soportes: 1, discrepancias: 1, facturas: 2 });
    const inventario = await esc.t.query(internal.limpieza.inventario, { condominioId: esc.condominioId });
    expect(inventario.tablas.map((t) => t.tabla)).not.toContain("pagos");
    await esc.t.mutation(internal.limpieza.limpiar, {
      condominioId: esc.condominioId,
      confirmar: "Conjunto de Prueba",
      tablas: ["pagos", "soportesPago", "facturaEventos", "discrepanciasPago", "importaciones", "facturas"],
    });
    expect(await contar()).toEqual(antes);
  });

  test("pagosPruebas solo borra pagos marcados como de prueba, y nunca en producción", async () => {
    const esc = await montar();
    await cargar(esc, [ago]);
    const agosto = await facturaDe(esc, "2026-08");
    const sinMarca = await aprobarPagoAval(esc, agosto._id, CUOTA);

    entorno("AVAL_AMBIENTE", undefined);
    await expect(esc.t.mutation(internal.pagosPruebas.revertir, { pagoId: sinMarca })).rejects.toThrow(/AVAL_AMBIENTE/);
    entorno("AVAL_AMBIENTE", "prod");
    await expect(esc.t.mutation(internal.pagosPruebas.revertir, { pagoId: sinMarca })).rejects.toThrow(/PRODUCCION/);
    entorno("AVAL_AMBIENTE", "qa");
    await expect(esc.t.mutation(internal.pagosPruebas.revertir, { pagoId: sinMarca })).rejects.toThrow(/no esta marcado/);
    expect(await esc.t.mutation(internal.pagosPruebas.revertirTodos, { confirmar: "SI" })).toMatchObject({
      borrados: 0,
      sinMarca: 1,
    });
    expect((await facturaDe(esc, "2026-08")).estado).toBe("pagada");

    /* Marcado (a mano, uno por uno): se borra y la factura se vuelve a calcular. */
    await esc.t.mutation(internal.pagosPruebas.marcarDePrueba, { pagoId: sinMarca });
    const r = await esc.t.mutation(internal.pagosPruebas.revertir, { pagoId: sinMarca });
    expect(r).toMatchObject({ facturaAntes: "pagada", facturaDespues: "pendiente" });
    expect((await eventos(esc, agosto._id)).at(-1)?.detalle).toMatch(/Se borró un pago de PRUEBA/);
  });

  test("un pago creado contra QA queda marcado de prueba al registrarse", async () => {
    const esc = await montar();
    await cargar(esc, [ago]);
    const id = await pagoIniciadoEl(esc, (await facturaDe(esc, "2026-08"))._id, AHORA, { esPrueba: true });
    expect(await esc.t.run(async (ctx) => (await ctx.db.get(id))?.esPrueba)).toBe(true);
  });
});

describe("lectura sin total e idempotencia de la importación", () => {
  async function septiembreSinTotal(esc: Escenario) {
    await esc.como("admin").mutation(api.facturas.bulkUpsert, {
      facturas: [
        {
          ...comoLaCargaPorPdf(esc, { ...sepArrastra(0), totalConDescuento: 260_000 }),
          motivosLectura: ["total_no_leido"],
        },
      ],
      skipExisting: true,
    });
    return await facturaDe(esc, "2026-09");
  }

  test("confirmar una lectura sin total exige escribir el del PDF", async () => {
    const esc = await montar();
    const sept = await septiembreSinTotal(esc);
    await expect(
      esc.como("admin").mutation(api.facturas.confirmarLectura, { facturaId: sept._id }),
    ).rejects.toThrow(/escribe el total que ves en el PDF/);
    expect(await esc.como("residente").query(api.pagos.puedePagar, { facturaId: sept._id })).toBe(false);
  });

  test("si coincide con lo leído, queda confirmada y registrada", async () => {
    const esc = await montar();
    const sept = await septiembreSinTotal(esc);
    await esc.como("admin").mutation(api.facturas.confirmarLectura, { facturaId: sept._id, totalVerificado: CUOTA });
    const despues = await facturaDe(esc, "2026-09");
    expect(despues.lecturaDudosa?.confirmada).toMatchObject({ totalVerificado: CUOTA, totalLeido: CUOTA, userId: esc.adminId });
    expect(despues.totalAPagar).toBe(CUOTA);
    expect(await esc.como("residente").query(api.pagos.puedePagar, { facturaId: sept._id })).toBe(true);
  });

  test("si no coincide, se cobra el total escrito, sin el descuento que nadie verificó", async () => {
    const esc = await montar();
    const sept = await septiembreSinTotal(esc);
    await esc.como("admin").mutation(api.facturas.confirmarLectura, { facturaId: sept._id, totalVerificado: 342_000 });
    const despues = await facturaDe(esc, "2026-09");
    expect(despues).toMatchObject({ totalAPagar: 342_000 });
    expect(despues.totalConDescuento).toBeUndefined();
    expect(despues.lecturaDudosa?.confirmada).toMatchObject({ totalVerificado: 342_000, totalLeido: CUOTA });
    expect((await datosDePagoBot(esc, sept._id)).monto).toBe(342_000);
    expect((await eventos(esc, sept._id)).at(-1)?.detalle).toMatch(/el total del documento es \$ 342\.000 \(se había leído \$ 300\.000\)/);
  });

  test("el mismo archivo con otro modo es otra importación (la llave incluye 'solo nuevas')", async () => {
    const esc = await montar();
    await cargar(esc, [sepArrastra(0)]);
    const iniciar = (soloNuevas: boolean) =>
      esc.como("admin").mutation(api.facturas.iniciarImportacion, {
        condominioId: esc.condominioId,
        periodo: "2026-09",
        archivo: "septiembre.pdf",
        hash: "d".repeat(64),
        soloNuevas,
        documentos: 1,
        candidatas: [{ indice: 0, unidadId: esc.u101, periodoLabel: "Septiembre / 2026" }],
      });
    const primera = await iniciar(true);
    await esc.como("admin").mutation(api.facturas.finalizarImportacion, { importacionId: primera.importacionId, estado: "completada" });
    expect((await iniciar(true)).tipo).toBe("repetida");
    const conActualizar = await iniciar(false);
    expect(conActualizar.tipo).toBe("nueva");
    expect(conActualizar.importacionId).not.toBe(primera.importacionId);
    expect(conActualizar.plan).toEqual([{ indice: 0, accion: "actualizar" }]);
  });
});

describe("meses faltantes (F-09)", () => {
  test("agosto → octubre: agosto sin veredicto, la casa en revisión (no en mora) y Finanzas ve el hueco", async () => {
    const esc = await montar();
    await cargar(esc, [ago]);
    await cargar(esc, [{ periodo: "2026-10", lineas: [linea("CUOTA", CUOTA, CUOTA)] }]);
    expect((await facturaDe(esc, "2026-08")).veredictoContable).toMatchObject({ estado: "sin_veredicto", motivo: "mes_faltante" });
    const [fila] = await esc.como("admin").query(api.facturas.carteraPorUnidad, {
      condominioId: esc.condominioId,
      unidadIds: [esc.u101],
    });
    expect(fila).toMatchObject({ estado: "en_revision", motivoRevision: "mes_faltante", diasMora: 0 });
    const huecos = await esc.como("admin").query(api.facturas.mesesFaltantes, { condominioId: esc.condominioId });
    expect(huecos.unidades).toEqual([
      expect.objectContaining({
        unidadNumero: "101",
        huecos: [{ tipo: "hueco", desde: "2026-08", hasta: "2026-10", faltan: ["2026-09"] }],
      }),
    ]);
    /* Llega septiembre: ya se puede juzgar agosto. */
    await cargar(esc, [sepArrastra(CUOTA)]);
    expect((await facturaDe(esc, "2026-08")).estado).toBe("vencida");
  });
});

describe("re-procesamiento: el PDF publicado que no es el documento cargado", () => {
  test("otro consecutivo: se omite (documento_distinto) y la factura no cambia", async () => {
    const esc = await montar();
    const sept = await insertarDirecto(esc, { ...sepArrastra(0), numeroInterno: "12163" }, "pendiente");
    const r = await esc.t.mutation(internal.facturas.reprocesarLecturas, {
      condominioId: esc.condominioId,
      dryRun: false,
      lecturas: [
        {
          facturaId: sept,
          vrAdmon: 0,
          lineas: [linea("ANTICIPO", -103_400, 0, 0)],
          saldoAFavor: 103_400,
          totalAPagar: -103_400,
          periodoLabel: "Septiembre / 2026",
          motivos: [],
          numeroInterno: "0",
        },
      ],
    });
    expect(r.unidades[0]?.facturas[0]?.omitida).toBe("documento_distinto");
    expect((await facturaDe(esc, "2026-09")).totalAPagar).toBe(CUOTA);
  });
});

