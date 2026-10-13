import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api } from "../../convex/_generated/api";
import {
  AHORA,
  aprobarPagoAval,
  bloquearRed,
  cargar,
  facturaDe,
  fijarReloj,
  liberarRed,
  linea,
  montar,
  soltarReloj,
  type Escenario,
} from "./escenario";

/**
 * CONTENCIÓN DE FACTURACIÓN (Fase 1) — lo que se agregó en esa fase y la red
 * de la Fase 0 no cubría. Ver docs/audits/FASE-1-FACTURACION.md.
 *
 * Va en la suite normal (`*.test.ts`, `vitest run`), no en la de regresión:
 * describe comportamiento ya corregido y debe quedarse en verde.
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

/** Agosto sin pagar, absorbido por septiembre (que arrastra los $300.000). */
async function agostoAbsorbido() {
  const esc = await montar();
  await cargar(esc, [{ periodo: "2026-08", lineas: [linea("ADMINISTRACION", 0, CUOTA)] }]);
  await cargar(esc, [
    { periodo: "2026-09", lineas: [linea("ADMINISTRACION", CUOTA, CUOTA)] },
  ]);
  return {
    esc,
    agosto: await facturaDe(esc, "2026-08"),
    septiembre: await facturaDe(esc, "2026-09"),
  };
}

describe("pagos.puedePagar · el 'Pagar' del móvil pregunta lo mismo que valida la pasarela", () => {
  test("la vigente sin pagar: sí", async () => {
    const { esc, septiembre } = await agostoAbsorbido();
    expect(
      await esc.como("residente").query(api.pagos.puedePagar, { facturaId: septiembre._id }),
    ).toBe(true);
  });

  test("la absorbida por la siguiente: no", async () => {
    const { esc, agosto } = await agostoAbsorbido();
    expect(agosto.estado).toBe("vencida");
    expect(
      await esc.como("residente").query(api.pagos.puedePagar, { facturaId: agosto._id }),
    ).toBe(false);
  });

  test("con la vigente pagada, ninguna", async () => {
    const { esc, agosto, septiembre } = await agostoAbsorbido();
    await aprobarPagoAval(esc, septiembre._id, 2 * CUOTA);
    for (const f of [agosto, septiembre]) {
      expect(
        await esc.como("residente").query(api.pagos.puedePagar, { facturaId: f._id }),
      ).toBe(false);
    }
  });

  test("la factura de otra casa: no", async () => {
    const { esc, septiembre } = await agostoAbsorbido();
    expect(
      await esc.como("vecino").query(api.pagos.puedePagar, { facturaId: septiembre._id }),
    ).toBe(false);
  });

  test("sin sesión: no", async () => {
    const { esc, septiembre } = await agostoAbsorbido();
    expect(await esc.t.query(api.pagos.puedePagar, { facturaId: septiembre._id })).toBe(false);
  });
});

describe("facturas.permisoSubida · quién puede subir PDFs de facturas (/api/facturas/upload)", () => {
  async function conLegacyId(): Promise<Escenario> {
    const esc = await montar();
    await esc.t.run(async (ctx) => {
      await ctx.db.patch(esc.condominioId, { legacyId: "conjunto-de-prueba" });
    });
    return esc;
  }

  test("la administración del conjunto: sí", async () => {
    const esc = await conLegacyId();
    expect(
      await esc
        .como("admin")
        .query(api.facturas.permisoSubida, { condominioLegacyId: "conjunto-de-prueba" }),
    ).toEqual({ allowed: true });
  });

  test("un residente del conjunto: no", async () => {
    const esc = await conLegacyId();
    expect(
      await esc
        .como("residente")
        .query(api.facturas.permisoSubida, { condominioLegacyId: "conjunto-de-prueba" }),
    ).toEqual({ allowed: false, motivo: "sin_permiso" });
  });

  test("el guarda tampoco", async () => {
    const esc = await conLegacyId();
    expect(
      await esc
        .como("guarda")
        .query(api.facturas.permisoSubida, { condominioLegacyId: "conjunto-de-prueba" }),
    ).toEqual({ allowed: false, motivo: "sin_permiso" });
  });

  test("sin sesión: no, y se distingue de no tener permiso (401 frente a 403)", async () => {
    const esc = await conLegacyId();
    expect(
      await esc.t.query(api.facturas.permisoSubida, { condominioLegacyId: "conjunto-de-prueba" }),
    ).toEqual({ allowed: false, motivo: "sin_sesion" });
  });

  test("la administración de OTRO conjunto: no", async () => {
    const esc = await conLegacyId();
    await esc.t.run(async (ctx) => {
      await ctx.db.insert("condominios", {
        name: "Otro conjunto",
        legacyId: "otro-conjunto",
        activeModules: [],
        isActive: true,
        createdAt: AHORA,
        updatedAt: AHORA,
      });
    });
    expect(
      await esc
        .como("admin")
        .query(api.facturas.permisoSubida, { condominioLegacyId: "otro-conjunto" }),
    ).toEqual({ allowed: false, motivo: "sin_permiso" });
  });

  test("un conjunto que no existe: no", async () => {
    const esc = await conLegacyId();
    expect(
      await esc
        .como("admin")
        .query(api.facturas.permisoSubida, { condominioLegacyId: "no-existe" }),
    ).toEqual({ allowed: false, motivo: "sin_permiso" });
  });
});

describe("notificacionesFeed · la campana no anuncia como deuda lo que ya va en la vigente", () => {
  async function lineasDeFactura(esc: Escenario) {
    const { items } = await esc
      .como("residente")
      .query(api.notificacionesFeed.feed, { condominioId: esc.condominioId });
    return items
      .filter((i) => i.tipo === "factura")
      .map((i) => [i.titulo, i.detalle])
      .sort();
  }

  test("septiembre sin pagar: 'Por pagar' es septiembre; agosto ya va dentro", async () => {
    const { esc } = await agostoAbsorbido();
    /* Septiembre arrastra agosto, que está en mora desde el 16 de septiembre:
     * la unidad está en mora y la vigente se anuncia "Vencida", como en la
     * cartera y la web (QA de comprobantes, H2; antes "Por pagar · …"). */
    expect(await lineasDeFactura(esc)).toEqual([
      ["Factura de Agosto / 2026", "Su saldo pasó a la factura siguiente"],
      ["Factura de Septiembre / 2026", "Vencida · Por pagar $ 600.000"],
    ]);
  });

  test("septiembre pagada: nada queda 'Por pagar'", async () => {
    const { esc, septiembre } = await agostoAbsorbido();
    await aprobarPagoAval(esc, septiembre._id, 2 * CUOTA);
    expect(await lineasDeFactura(esc)).toEqual([
      ["Factura de Agosto / 2026", "Su saldo pasó a la factura siguiente"],
      ["Factura de Septiembre / 2026", "Pagada"],
    ]);
  });
});
