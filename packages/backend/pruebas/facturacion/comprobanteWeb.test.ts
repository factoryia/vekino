import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { MENSAJE_PASARELA_DE_PRUEBAS } from "../../convex/lib/avalProduccion";
import { MENSAJE_COMPROBANTE_HISTORICA } from "../../convex/soportesPago";
import {
  AHORA,
  DIA,
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
 * LO QUE LA WEB DEL RESIDENTE DA POR HECHO DEL BACKEND — Hallazgo 1
 * (docs/audits/FALTANTES-WEB-FACTURACION.md).
 *
 * La pantalla "Ya pagué, enviar comprobante" no repite reglas: muestra el
 * botón con `pagos.opcionesDePago.debe`, lo oculta si `soportesPago.listMios`
 * trae uno en revisión para la factura, y muestra tal cual lo que responda
 * `soportesPago.crearMio`. Estas pruebas fijan esos contratos, que no tenían
 * prueba propia, contra el backend real en convex-test (sin cambiarlo):
 *
 *   · uno pendiente por factura, de quien sea (también el que llegó por
 *     WhatsApp), con su mensaje estable; tras un rechazo se puede reenviar;
 *   · `listMios` trae lo que la pantalla pinta (estado, monto, fecha, motivo);
 *   · con un comprobante en revisión la factura se sigue debiendo
 *     (`debe: true`): ocultar el botón le toca a `listMios`;
 *   · el mediodía de hoy en Colombia, enviado a las 23:00, no es "futuro";
 *   · ni el vecino ni la arrendataria con el contrato vencido pueden enviar,
 *     y `opcionesDePago` no les ofrece nada.
 */

const MENSAJE_PENDIENTE = "Ya tienes un comprobante en revisión para esta factura.";
const MENSAJE_FECHA = "La fecha del pago no es válida.";

/** El instante que manda la web (y el móvil) por un día: el mediodía de Colombia. */
const mediodia = (dia: string) => Date.parse(`${dia}T12:00:00-05:00`);

const entornoOriginal = new Map<string, string | undefined>();
function entorno(nombre: string, valor: string | undefined) {
  if (!entornoOriginal.has(nombre)) entornoOriginal.set(nombre, process.env[nombre]);
  if (valor === undefined) delete process.env[nombre];
  else process.env[nombre] = valor;
}

beforeEach(() => {
  bloquearRed();
  fijarReloj();
  /* Como el deployment de los residentes hoy: la pasarela en QA y sin
   * unidades de prueba, así que no acepta a nadie (Fase 4, §5.3). */
  entorno("AVAL_AMBIENTE", "qa");
  entorno("AVAL_UNIDADES_PRUEBA", undefined);
});

afterEach(() => {
  for (const [nombre, valor] of entornoOriginal) {
    if (valor === undefined) delete process.env[nombre];
    else process.env[nombre] = valor;
  }
  entornoOriginal.clear();
  soltarReloj();
  liberarRed();
});

async function conSeptiembre() {
  const esc = await montar();
  await cargar(esc, [{ periodo: "2026-09", lineas: [linea("CUOTA", 0, 380_000)] }]);
  return { esc, septiembre: await facturaDe(esc, "2026-09") };
}

/** Lo que manda la web al enviar, con un comprobante que `quien` acaba de subir. */
async function envio(
  esc: Escenario,
  facturaId: Id<"facturas">,
  extra: Record<string, unknown> = {},
  quien: "residente" | "vecino" = "residente",
) {
  return {
    condominioId: esc.condominioId,
    facturaId,
    url: await comprobanteSubido(esc, quien),
    mimeType: "application/pdf",
    monto: 150_000,
    fechaPago: mediodia("2026-10-07"),
    ...extra,
  };
}

const listMios = (esc: Escenario, quien: "residente" | "vecino" = "residente") =>
  esc.como(quien).query(api.soportesPago.listMios, { condominioId: esc.condominioId });

describe("Uno en revisión por factura · lo que oculta y vuelve a mostrar el botón", () => {
  test("el segundo se rechaza con el mensaje estable; rechazado el primero, se puede enviar otro", async () => {
    const { esc, septiembre } = await conSeptiembre();
    const primero = await esc.como("residente").mutation(api.soportesPago.crearMio, await envio(esc, septiembre._id));

    /* Lo que pinta la pantalla. */
    expect(await listMios(esc)).toEqual([
      expect.objectContaining({
        _id: primero,
        facturaId: septiembre._id,
        estado: "pendiente_revision",
        monto: 150_000,
        fechaPago: mediodia("2026-10-07"),
        mimeType: "application/pdf",
        notaRevision: null,
      }),
    ]);
    await expect(
      esc.como("residente").mutation(api.soportesPago.crearMio, await envio(esc, septiembre._id)),
    ).rejects.toThrow(MENSAJE_PENDIENTE);

    await esc.como("admin").mutation(api.soportesPago.rechazar, { id: primero, notaRevision: "No se lee el valor." });
    await esperarProgramadas(esc);
    expect(await listMios(esc)).toEqual([
      expect.objectContaining({ _id: primero, estado: "rechazado", notaRevision: "No se lee el valor." }),
    ]);

    const segundo = await esc.como("residente").mutation(api.soportesPago.crearMio, await envio(esc, septiembre._id));
    expect((await listMios(esc)).map((s) => [s._id, s.estado])).toEqual([
      [segundo, "pendiente_revision"],
      [primero, "rechazado"],
    ]);
  });

  test("el que llegó por WhatsApp desde otro teléfono también cuenta, y `listMios` lo trae", async () => {
    const { esc, septiembre } = await conSeptiembre();
    const delBot = await esc.t.mutation(internal.soportesPago.crearDesdeBot, {
      condominioId: esc.condominioId,
      facturaId: septiembre._id,
      telefono: "+573001112233",
      url: "https://archivos.test/foto.jpg",
      mimeType: "image/jpeg",
    });
    expect((await listMios(esc)).map((s) => [s._id, s.facturaId, s.estado])).toEqual([
      [delBot, septiembre._id, "pendiente_revision"],
    ]);
    await expect(
      esc.como("residente").mutation(api.soportesPago.crearMio, await envio(esc, septiembre._id)),
    ).rejects.toThrow(MENSAJE_PENDIENTE);
  });

  test("con uno en revisión la factura se sigue debiendo: `debe` no oculta el botón, `listMios` sí", async () => {
    const { esc, septiembre } = await conSeptiembre();
    const antes = await esc.como("residente").query(api.pagos.opcionesDePago, { facturaId: septiembre._id });
    expect(antes).toEqual({ debe: true, pasarela: false, motivo: MENSAJE_PASARELA_DE_PRUEBAS });
    await esc.como("residente").mutation(api.soportesPago.crearMio, await envio(esc, septiembre._id));
    expect(await esc.como("residente").query(api.pagos.opcionesDePago, { facturaId: septiembre._id })).toEqual(antes);
  });

  test("a una histórica se le responde el mensaje estable que muestra la pantalla", async () => {
    const esc = await montar();
    await cargar(esc, [{ periodo: "2026-08", lineas: [linea("CUOTA", 0, 300_000)] }]);
    await cargar(esc, [{ periodo: "2026-09", lineas: [linea("CUOTA", 300_000, 300_000)] }]);
    const agosto = await facturaDe(esc, "2026-08");
    expect(
      (await esc.como("residente").query(api.pagos.opcionesDePago, { facturaId: agosto._id })).debe,
    ).toBe(false);
    await expect(
      esc.como("residente").mutation(api.soportesPago.crearMio, await envio(esc, agosto._id)),
    ).rejects.toThrow(MENSAJE_COMPROBANTE_HISTORICA);
  });
});

describe("La fecha que manda la web · el día de Colombia", () => {
  test("a las 23:00 de Bogotá, el mediodía de hoy se acepta; el de pasado mañana, no", async () => {
    fijarReloj(bogota("2026-10-09T23:00"));
    const esc = await montar();
    await cargar(esc, [{ periodo: "2026-10", lineas: [linea("CUOTA", 0, 380_000)] }]);
    const octubre = await facturaDe(esc, "2026-10");
    await expect(
      esc.como("residente").mutation(api.soportesPago.crearMio, await envio(esc, octubre._id, { fechaPago: mediodia("2026-10-11") })),
    ).rejects.toThrow(MENSAJE_FECHA);
    const id = await esc.como("residente").mutation(
      api.soportesPago.crearMio,
      await envio(esc, octubre._id, { fechaPago: mediodia("2026-10-09") }),
    );
    expect((await listMios(esc)).find((s) => s._id === id)?.fechaPago).toBe(mediodia("2026-10-09"));
  });
});

describe("Accesos · quien no tiene un vínculo vigente con la unidad", () => {
  test("el vecino de otra casa: `opcionesDePago` no le ofrece nada, `crearMio` lo rechaza y no ve los de la 101", async () => {
    const { esc, septiembre } = await conSeptiembre();
    await esc.como("residente").mutation(api.soportesPago.crearMio, await envio(esc, septiembre._id));
    expect(
      (await esc.como("vecino").query(api.pagos.opcionesDePago, { facturaId: septiembre._id })).debe,
    ).toBe(false);
    await expect(
      esc.como("vecino").mutation(api.soportesPago.crearMio, await envio(esc, septiembre._id, {}, "vecino")),
    ).rejects.toThrow("Esa factura no pertenece a tu unidad.");
    expect(await listMios(esc, "vecino")).toEqual([]);
  });

  test("la arrendataria con el contrato vencido: sin deuda que ofrecer, sin envío y sin comprobantes", async () => {
    const { esc, septiembre } = await conSeptiembre();
    await esc.como("residente").mutation(api.soportesPago.crearMio, await envio(esc, septiembre._id));
    await esc.t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {
        name: "Arrendataria",
        email: "arrendataria@vekino.test",
        emailVerified: true,
        active: true,
        authId: "arrendataria",
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
      await ctx.db.insert("usuarioUnidad", {
        membershipId,
        unidadId: esc.u101,
        condominioId: esc.condominioId,
        vinculo: "arrendatario",
        esPrincipal: true,
        vigenciaDesde: AHORA - 400 * DIA,
        vigenciaHasta: AHORA - 10 * DIA,
        createdAt: AHORA,
      });
    });
    const arrendataria = esc.t.withIdentity({ subject: "arrendataria" });
    expect(await arrendataria.query(api.pagos.opcionesDePago, { facturaId: septiembre._id })).toEqual({
      debe: false,
      pasarela: false,
      motivo: "Esta factura no corresponde a una de sus unidades.",
    });
    await expect(
      arrendataria.mutation(api.soportesPago.crearMio, await envio(esc, septiembre._id)),
    ).rejects.toThrow("No tienes unidades vinculadas en este condominio.");
    expect(await arrendataria.query(api.soportesPago.listMios, { condominioId: esc.condominioId })).toEqual([]);
  });
});
