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
 * UNA VIGENTE EN MORA SE VE "VENCIDA" EN TODAS PARTES — hallazgo H2 del QA
 * de comprobantes (docs/qa/QA-FACTORY-COMPROBANTES.md, defecto 3).
 *
 * En Factory, la casa 103 tenía agosto sin pagar el 9 de octubre (mora desde
 * el 16 de septiembre). El resumen del residente decía "Vencida" (la cartera,
 * `carteraDeUnidad`), pero la fila, Finanzas (0 vencidas) y la campana decían
 * "Pendiente" / "Por pagar": leían `facturas.estado`, que sigue `pendiente`
 * porque ninguna factura posterior la ha juzgado.
 *
 * El campo no cambia (es lo que concluyó la conciliación). Lo que se MUESTRA
 * sale de una sola regla, `estadoVisibleDeFactura` con la cartera de la
 * unidad: la vigente de una unidad en mora se ve `vencida`.
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

const AGOSTO = { periodo: "2026-08", lineas: [linea("CUOTA", 0, 335_000)] };

async function resumen(esc: Escenario, periodo: string) {
  return await esc.como("admin").query(api.facturas.resumenPeriodo, { condominioId: esc.condominioId, periodo });
}

async function filasFinanzas(esc: Escenario, periodo: string) {
  const { page } = await esc.como("admin").query(api.facturas.listPage, {
    condominioId: esc.condominioId,
    periodo,
    paginationOpts: { numItems: 30, cursor: null },
  });
  return page.map((f) => ({ periodo: f.periodo, estado: f.estado, estadoVisible: f.estadoVisible }));
}

async function campana(esc: Escenario) {
  const { items } = await esc
    .como("residente")
    .query(api.notificacionesFeed.feed, { condominioId: esc.condominioId });
  return items.filter((i) => i.tipo === "factura").map((i) => `${i.titulo} · ${i.detalle}`);
}

async function serieDe(esc: Escenario, periodo: string) {
  const serie = await esc.como("admin").query(api.facturas.serie, { condominioId: esc.condominioId });
  return serie.find((s) => s.periodo === periodo);
}

async function estadoDeCuenta(esc: Escenario) {
  const r = await esc
    .como("admin")
    .query(api.facturas.estadoCuentaUnidad, { condominioId: esc.condominioId, unidadId: esc.u101 });
  return r!;
}

describe("H2 · la vigente sin pagar, pasada la fecha de mora", () => {
  test("el caso del QA: agosto sin pagar el 9 de octubre se ve 'vencida' en Finanzas, la serie, el estado de cuenta y la campana", async () => {
    const esc = await montar();
    await cargar(esc, [AGOSTO]);
    const agosto = await facturaDe(esc, "2026-08");
    /* El campo guardado no cambia: nadie lo juzgó todavía. */
    expect(agosto.estado).toBe("pendiente");

    const cartera = (await estadoDeCuenta(esc)).cartera;
    expect(cartera).toMatchObject({ estado: "en_mora", periodoEnMora: "2026-08" });

    expect(await filasFinanzas(esc, "2026-08")).toEqual([
      { periodo: "2026-08", estado: "pendiente", estadoVisible: "vencida" },
    ]);
    expect(await resumen(esc, "2026-08")).toMatchObject({ total: 1, vencidas: 1, pendientes: 0 });
    expect(await serieDe(esc, "2026-08")).toMatchObject({ total: 1, vencidas: 1, pendientes: 0 });
    expect((await estadoDeCuenta(esc)).facturas.map((f) => f.estadoVisible)).toEqual(["vencida"]);
    expect(await campana(esc)).toEqual([`Factura de ${agosto.periodoLabel} · Vencida · Por pagar $ 335.000`]);
    /* La insignia del portal ya contaba bien: es la misma regla. */
    expect(
      await esc.como("residente").query(api.portal.navBadges, { condominioId: esc.condominioId }),
    ).toMatchObject({ facturasVencidas: 1 });
  });

  test("la vigente que arrastra un mes ya vencido también se ve 'vencida' (la mora es de la unidad)", async () => {
    const esc = await montar();
    /* Agosto sin pagar; septiembre lo arrastra entero (agosto queda vencida). */
    await cargar(esc, [AGOSTO, { periodo: "2026-09", lineas: [linea("CUOTA", 335_000, 335_000)] }]);
    expect((await facturaDe(esc, "2026-08")).estado).toBe("vencida");
    expect((await facturaDe(esc, "2026-09")).estado).toBe("pendiente");

    expect(await filasFinanzas(esc, "2026-09")).toEqual([
      { periodo: "2026-09", estado: "pendiente", estadoVisible: "vencida" },
    ]);
    expect(await resumen(esc, "2026-09")).toMatchObject({ vencidas: 1, pendientes: 0 });
    /* Agosto ya era vencida por la conciliación: no se cuenta dos veces en su período. */
    expect(await resumen(esc, "2026-08")).toMatchObject({ vencidas: 1, pendientes: 0 });
  });
});

describe("H2 · lo que NO es mora no se pinta vencido", () => {
  test("dentro del plazo: septiembre vigente el 9 de octubre (mora desde el 16) sigue 'pendiente'", async () => {
    const esc = await montar();
    await cargar(esc, [AGOSTO, { periodo: "2026-09", lineas: [linea("CUOTA", 0, 335_000)] }]);
    /* Septiembre dice saldo anterior 0: agosto quedó pagada. */
    expect((await facturaDe(esc, "2026-08")).estado).toBe("pagada");

    expect(await filasFinanzas(esc, "2026-09")).toEqual([
      { periodo: "2026-09", estado: "pendiente", estadoVisible: "pendiente" },
    ]);
    expect(await resumen(esc, "2026-09")).toMatchObject({ vencidas: 0, pendientes: 1 });
    expect((await campana(esc))[0]).toMatch(/· Por pagar · \$ 335\.000$/);
  });

  test("pagada después de la fecha de mora: 'pagada', no 'vencida'", async () => {
    const esc = await montar();
    await cargar(esc, [AGOSTO]);
    const agosto: Id<"facturas"> = (await facturaDe(esc, "2026-08"))._id;
    const soporte = await esc.como("residente").mutation(api.soportesPago.crearMio, {
      condominioId: esc.condominioId,
      facturaId: agosto,
      url: await comprobanteSubido(esc, "residente", "comprobante.png"),
      mimeType: "image/png",
      monto: 335_000,
      fechaPago: mediodia("2026-10-01"),
    });
    await esc.como("admin").mutation(api.soportesPago.aprobar, {
      id: soporte,
      monto: 335_000,
      fechaPago: mediodia("2026-10-01"),
    });
    await esperarProgramadas(esc);

    expect(await filasFinanzas(esc, "2026-08")).toEqual([
      { periodo: "2026-08", estado: "pagada", estadoVisible: "pagada" },
    ]);
    expect(await resumen(esc, "2026-08")).toMatchObject({ vencidas: 0, pagadas: 1 });
    expect((await campana(esc))[0]).toMatch(/· Pagada$/);
  });

  test("saldo cero: aunque pasó la fecha, no hay mora ni 'vencida'", async () => {
    const esc = await montar();
    await cargar(esc, [{ periodo: "2026-08", lineas: [linea("CUOTA", 0, 0)] }]);
    expect((await estadoDeCuenta(esc)).cartera.estado).toBe("al_dia");
    expect((await filasFinanzas(esc, "2026-08"))[0]!.estadoVisible).not.toBe("vencida");
    expect(await resumen(esc, "2026-08")).toMatchObject({ vencidas: 0 });
  });

  test("con un abono aprobado la vigente vencida se ve 'abonada' (la regla de la cartera no la pone en mora)", async () => {
    const esc = await montar();
    await cargar(esc, [AGOSTO]);
    const agosto = (await facturaDe(esc, "2026-08"))._id;
    const soporte = await esc.como("residente").mutation(api.soportesPago.crearMio, {
      condominioId: esc.condominioId,
      facturaId: agosto,
      url: await comprobanteSubido(esc, "residente", "comprobante.png"),
      mimeType: "image/png",
      monto: 200_000,
      fechaPago: mediodia("2026-10-09"),
    });
    await esc.como("admin").mutation(api.soportesPago.aprobar, {
      id: soporte,
      monto: 200_000,
      fechaPago: mediodia("2026-10-09"),
    });
    await esperarProgramadas(esc);

    expect(await filasFinanzas(esc, "2026-08")).toEqual([
      { periodo: "2026-08", estado: "abonada", estadoVisible: "abonada" },
    ]);
    expect(await resumen(esc, "2026-08")).toMatchObject({ vencidas: 0, abonadas: 1 });
  });
});
