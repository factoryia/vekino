import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import {
  bloquearRed,
  bogota,
  cargar,
  comprobanteSubido,
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
 * UNA FACTURA MANUAL NO DICE NADA DE LA ANTERIOR — hallazgo H4 del QA de
 * comprobantes (docs/qa/QA-FACTORY-COMPROBANTES.md, defecto 5).
 *
 * En Factory se crearon a mano agosto ($335.000) y septiembre ($670.000) de la
 * 105. Agosto pasó a "pagada" ("La factura siguiente dice que quedó pagada
 * (saldo anterior $ 0)") y sus $335.000 entraron al recaudo de la
 * contabilidad. Nadie había pagado nada.
 *
 * Causa: `createManual` no tiene saldo anterior (sus líneas lo traen en 0
 * porque nadie lo escribió), y la conciliación (`veredictoConciliacion`) y el
 * recaudo contable (`recaudoContablePorPeriodo`) lo leían como "la
 * contabilidad dice que no quedó debiendo nada". Una factura manual no es un
 * documento de la contabilidad: no juzga a la anterior ni prueba recaudo.
 * Los pagos reales (comprobantes, pasarela) siguen contando.
 */

/** El día de la ronda 2 del QA en Factory. */
const HOY = bogota("2026-10-09T10:00");
const mediodia = (dia: string) => Date.parse(`${dia}T12:00:00-05:00`);

beforeEach(() => {
  bloquearRed();
  fijarReloj(HOY);
});

afterEach(() => {
  soltarReloj();
  liberarRed();
});

/** "Crear factura" en Finanzas, con el vencimiento que propone la pantalla (fin de mes). */
async function manual(esc: Escenario, periodo: string, valor: number, conDescuento?: number) {
  const [a, m] = periodo.split("-").map(Number) as [number, number];
  return await esc.como("admin").mutation(api.facturas.createManual, {
    condominioId: esc.condominioId,
    unidadId: esc.u101,
    periodo,
    fechaVencimiento: Date.UTC(a, m, 0, 5),
    valor,
    ...(conDescuento !== undefined ? { totalConDescuento: conDescuento } : {}),
  });
}

async function eventosDe(esc: Escenario, facturaId: Id<"facturas">) {
  return await esc.como("admin").query(api.facturas.eventos, { facturaId });
}

async function resumen(esc: Escenario, periodo: string) {
  return await esc.como("admin").query(api.facturas.resumenPeriodo, { condominioId: esc.condominioId, periodo });
}

async function cartera(esc: Escenario) {
  const [c] = await esc
    .como("admin")
    .query(api.facturas.carteraPorUnidad, { condominioId: esc.condominioId, unidadIds: [esc.u101] });
  return c!;
}

describe("H4 · crear a mano el mes siguiente no paga el anterior", () => {
  test("el caso del QA: agosto $335.000 y septiembre $670.000 a mano → agosto sigue sin pagar, sin conciliación inventada ni recaudo", async () => {
    const esc = await montar();
    const agosto = await manual(esc, "2026-08", 335_000, 295_000);
    await manual(esc, "2026-09", 670_000, 630_000);

    const ago = await facturaDe(esc, "2026-08");
    expect(ago.estado).toBe("pendiente");
    expect(ago.veredictoContable ?? null).toBeNull();
    const eventos = await eventosDe(esc, agosto);
    expect(eventos.filter((e) => e.origen === "conciliacion")).toEqual([]);
    expect(eventos.map((e) => e.estadoDespues)).not.toContain("pagada");

    /* Ni "pagadas" ni recaudo de la contabilidad: el par no se puede calcular. */
    expect(await resumen(esc, "2026-08")).toMatchObject({
      pagadas: 0,
      recaudoContable: null,
      recaudoVekino: 0,
    });
    /* La unidad debe lo que dice la vigente y agosto, vencido el 16 de
     * septiembre sin pago que lo cubra, la pone en mora. */
    expect(await cartera(esc)).toMatchObject({ estado: "en_mora", saldoActual: 670_000, periodoEnMora: "2026-08" });
  });

  test("en otro orden (septiembre antes que agosto) da lo mismo", async () => {
    const esc = await montar();
    await manual(esc, "2026-09", 670_000);
    await manual(esc, "2026-08", 335_000);
    expect((await facturaDe(esc, "2026-08")).estado).toBe("pendiente");
    expect((await resumen(esc, "2026-08")).recaudoContable).toBeNull();
  });

  test("tres meses seguidos a mano: ninguno da por pagado al anterior", async () => {
    const esc = await montar();
    await manual(esc, "2026-07", 335_000);
    await manual(esc, "2026-08", 670_000);
    await manual(esc, "2026-09", 1_005_000);
    expect((await facturaDe(esc, "2026-07")).estado).toBe("pendiente");
    expect((await facturaDe(esc, "2026-08")).estado).toBe("pendiente");
    expect((await resumen(esc, "2026-07")).recaudoContable).toBeNull();
    expect((await resumen(esc, "2026-08")).recaudoContable).toBeNull();
  });

  test("la misma unidad y período dos veces: se rechaza la segunda", async () => {
    const esc = await montar();
    await manual(esc, "2026-08", 335_000);
    await expect(manual(esc, "2026-08", 335_000)).rejects.toThrow(
      "Ya existe una factura para esta unidad en ese período.",
    );
  });
});

describe("H4 · lo que sí prueba un pago o un documento sigue contando", () => {
  test("un pago real de agosto la deja pagada aunque septiembre sea manual, y cuenta en el recaudo de Vekino", async () => {
    const esc = await montar();
    const agosto = await manual(esc, "2026-08", 335_000);
    const soporte = await esc.como("residente").mutation(api.soportesPago.crearMio, {
      condominioId: esc.condominioId,
      facturaId: agosto,
      url: await comprobanteSubido(esc, "residente", "comprobante.png"),
      mimeType: "image/png",
      monto: 335_000,
      fechaPago: mediodia("2026-09-05"),
    });
    await esc.como("admin").mutation(api.soportesPago.aprobar, {
      id: soporte,
      monto: 335_000,
      fechaPago: mediodia("2026-09-05"),
    });
    await esperarProgramadas(esc);
    await manual(esc, "2026-09", 335_000);

    expect((await facturaDe(esc, "2026-08")).estado).toBe("pagada");
    expect(await resumen(esc, "2026-08")).toMatchObject({ pagadas: 1, recaudoVekino: 335_000, recaudoContable: null });
  });

  test("agosto manual y septiembre del PDF con saldo anterior: el documento sí juzga a agosto", async () => {
    const esc = await montar();
    await manual(esc, "2026-08", 335_000);
    /* La contabilidad arrastra los $335.000: agosto no se pagó. */
    await cargar(esc, [{ periodo: "2026-09", lineas: [linea("CUOTA", 335_000, 335_000)] }]);
    expect((await facturaDe(esc, "2026-08")).estado).toBe("vencida");
    expect((await resumen(esc, "2026-08")).recaudoContable).toBe(0);
  });

  test("agosto manual y septiembre del PDF con saldo anterior en cero: agosto pagada, y ese recaudo sí es de la contabilidad", async () => {
    const esc = await montar();
    await manual(esc, "2026-08", 335_000);
    await cargar(esc, [{ periodo: "2026-09", lineas: [linea("CUOTA", 0, 335_000)] }]);
    expect((await facturaDe(esc, "2026-08")).estado).toBe("pagada");
    expect((await resumen(esc, "2026-08")).recaudoContable).toBe(335_000);
  });

  test("cuando llega el PDF de septiembre, reemplaza la manual y juzga a agosto con su saldo anterior", async () => {
    const esc = await montar();
    await manual(esc, "2026-08", 335_000);
    await manual(esc, "2026-09", 670_000);
    expect((await facturaDe(esc, "2026-08")).estado).toBe("pendiente");

    await cargar(esc, [{ periodo: "2026-09", lineas: [linea("CUOTA", 335_000, 335_000)] }]);
    const sept = await facturaDe(esc, "2026-09");
    expect(sept.origen).toBe("pdf");
    expect((await facturaDe(esc, "2026-08")).estado).toBe("vencida");
  });
});

describe("H4 · los datos que ya quedaron mal se corrigen al recalcular", () => {
  test("una anterior 'pagada' por una manual vuelve a pendiente con 'Conciliar', y queda en su historial", async () => {
    const esc = await montar();
    await manual(esc, "2026-08", 335_000);
    const septiembre = await manual(esc, "2026-09", 670_000);
    /* Así quedaron en producción antes de la corrección: agosto con el
     * veredicto "pagada" que le puso la manual de septiembre. */
    const ago = await facturaDe(esc, "2026-08");
    await esc.t.run(async (ctx) => {
      await ctx.db.patch(ago._id, {
        estado: "pagada",
        veredictoContable: {
          estado: "pagada",
          facturaSiguienteId: septiembre,
          saldoAnteriorSiguiente: 0,
          at: Date.now(),
        },
      });
    });

    await esc.como("admin").mutation(api.facturas.reconciliar, { condominioId: esc.condominioId });

    const despues = await facturaDe(esc, "2026-08");
    expect(despues.estado).toBe("pendiente");
    expect(despues.veredictoContable ?? null).toBeNull();
    const [ultimo] = await eventosDe(esc, ago._id);
    expect(ultimo).toMatchObject({ estadoAntes: "pagada", estadoDespues: "pendiente" });
  });

  test("un estado heredado de la migración no se pierde por una manual siguiente", async () => {
    const esc = await montar();
    await manual(esc, "2026-08", 335_000);
    const ago = await facturaDe(esc, "2026-08");
    await esc.t.run(async (ctx) => {
      await ctx.db.patch(ago._id, {
        estado: "pagada",
        veredictoContable: { estado: "pagada", motivo: "heredado", at: Date.now() },
      });
    });
    await manual(esc, "2026-09", 335_000);
    expect((await facturaDe(esc, "2026-08")).estado).toBe("pagada");
  });
});
