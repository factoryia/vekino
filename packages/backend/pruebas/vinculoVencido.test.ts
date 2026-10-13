import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { bloquearRed, bogota, liberarRed, modules } from "./facturacion/escenario";

/**
 * UN VÍNCULO VENCIDO NO DA ACCESO A LA CASA — hallazgo H3 del QA de
 * comprobantes (docs/qa/QA-FACTORY-COMPROBANTES.md, defecto 4).
 *
 * En Factory, la arrendataria de la 102 con el contrato terminado el 1 de
 * septiembre ya no veía las facturas (bien), pero el portal le mostraba
 * "Casa 102 · Arrendatario", "Mi unidad" con la casa, y "Visitantes" le
 * ofrecía "Autorizar visitante". El backend lo permitía: `visitantes.ts`
 * tenía su propio `misUnidadIds` SIN el filtro de vigencia, y `portal.home`,
 * `misActividades`, `navBadges`, las asambleas y el bot leían los vínculos
 * sin mirar fechas.
 *
 * La vigencia es UNA: `vigentes()` / `misUnidadIds` de `model/authz.ts` (el
 * día final cuenta completo). Estas pruebas llaman al backend directamente,
 * sin pantallas, como lo haría cualquiera con la URL del deployment.
 */

const DIA = 24 * 60 * 60 * 1000;
/** El día de la ronda 2 del QA en Factory. */
const HOY = bogota("2026-10-09T10:00");
/** Las fechas como las guarda "Mi hogar": la medianoche de Colombia del día elegido. */
const fecha = (dia: string) => bogota(`${dia}T00:00`);

beforeEach(() => {
  bloquearRed();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(HOY);
});

afterEach(() => {
  vi.useRealTimers();
  liberarRed();
});

type Persona = "propietario" | "vigente" | "vencida";

async function casa102() {
  const t = convexTest(schema, modules);
  const ahora = Date.now();
  const ids = await t.run(async (ctx) => {
    const condominioId = await ctx.db.insert("condominios", {
      name: "Conjunto de Prueba",
      activeModules: ["whatsapp"],
      isActive: true,
      createdAt: ahora,
      updatedAt: ahora,
    });
    const u102 = await ctx.db.insert("unidades", {
      condominioId,
      tipo: "casa",
      estado: "ocupada",
      numero: "102",
      createdAt: ahora,
      updatedAt: ahora,
    });
    const persona = async (authId: Persona, vinculo: "propietario" | "arrendatario", desde?: number, hasta?: number) => {
      const userId = await ctx.db.insert("users", {
        name: `Persona ${authId}`,
        email: `${authId}@vekino.test`,
        emailVerified: true,
        active: true,
        authId,
        createdAt: ahora,
        updatedAt: ahora,
      });
      /* Como las agrega el propietario desde "Mi hogar": rol de propietario en
       * la membresía; la diferencia está en el vínculo y su vigencia. */
      const membershipId = await ctx.db.insert("memberships", {
        userId,
        condominioId,
        roles: ["propietario"],
        isActive: true,
        createdAt: ahora,
        updatedAt: ahora,
      });
      await ctx.db.insert("usuarioUnidad", {
        membershipId,
        unidadId: u102,
        condominioId,
        vinculo,
        esPrincipal: true,
        ...(desde !== undefined ? { vigenciaDesde: desde } : {}),
        ...(hasta !== undefined ? { vigenciaHasta: hasta } : {}),
        createdAt: ahora,
      });
      return { userId, membershipId };
    };
    const propietario = await persona("propietario", "propietario");
    const vigente = await persona("vigente", "arrendatario", fecha("2026-04-01"), fecha("2027-03-31"));
    const vencida = await persona("vencida", "arrendatario", fecha("2026-03-01"), fecha("2026-09-01"));

    /* Lo que ya tiene la casa: una zona, una reserva, un vehículo, un
     * visitante autorizado, un walk-in esperando respuesta y una factura de
     * agosto sin pagar (en mora desde el 16 de septiembre). */
    const zonaId = await ctx.db.insert("zonasComunes", {
      condominioId,
      nombre: "Salón social",
      activa: true,
      createdAt: ahora,
      updatedAt: ahora,
    });
    await ctx.db.insert("reservas", {
      condominioId,
      unidadId: u102,
      zonaId,
      zonaNombre: "Salón social",
      unidadNumero: "102",
      solicitanteNombre: "Persona propietario",
      fecha: "2026-10-20",
      horaInicio: "10:00",
      horaFin: "12:00",
      estado: "aprobada",
      createdAt: ahora,
      updatedAt: ahora,
    });
    await ctx.db.insert("vehiculos", {
      condominioId,
      unidadId: u102,
      placa: "ABC123",
      tipo: "carro",
      createdAt: ahora,
      updatedAt: ahora,
    });
    const visitante = await ctx.db.insert("visitantes", {
      condominioId,
      unidadId: u102,
      unidadNumero: "102",
      nombre: "Visita del propietario",
      documento: "123",
      tipoDocumento: "CC",
      tipo: "visitante",
      estado: "pendiente",
      fechaVisitaInicio: ahora,
      fechaVisitaFin: ahora + DIA,
      qrInvalidado: false,
      registradoPorGuardia: false,
      createdAt: ahora,
      updatedAt: ahora,
    });
    const walkIn = await ctx.db.insert("visitantes", {
      condominioId,
      unidadId: u102,
      unidadNumero: "102",
      nombre: "Domicilio en portería",
      documento: "456",
      tipoDocumento: "CC",
      tipo: "domicilio",
      estado: "esperando_aprobacion",
      qrInvalidado: false,
      registradoPorGuardia: true,
      createdAt: ahora,
      updatedAt: ahora,
    });
    await ctx.db.insert("facturas", {
      condominioId,
      unidadId: u102,
      numeroFactura: "FAC-2026-08-102",
      numeroInterno: "1",
      periodo: "2026-08",
      periodoLabel: "01-agosto-2026",
      residenteNombre: "Persona propietario",
      apto: "102",
      vrAdmon: 335_000,
      lineas: [{ codigo: 1, concepto: "Administración", saldoAnterior: 0, actual: 335_000, total: 335_000 }],
      saldoAFavor: 0,
      totalAPagar: 335_000,
      fechaEmision: fecha("2026-08-01"),
      fechaVencimiento: fecha("2026-08-31"),
      estado: "pendiente",
      createdAt: ahora,
      updatedAt: ahora,
    });
    const asambleaId = await ctx.db.insert("asambleas", {
      condominioId,
      titulo: "Asamblea ordinaria",
      tipo: "ordinaria",
      modalidad: "presencial",
      fecha: "2026-10-09",
      hora: "18:00",
      estado: "en_curso",
      agenda: [],
      createdAt: ahora,
      updatedAt: ahora,
    } as never);
    const conversacion = await ctx.db.insert("waConversations", {
      telefono: "+573000000000",
      userId: vencida.userId,
      condominioId,
      membershipId: vencida.membershipId,
      paso: "menu",
      ultimoMensajeAt: ahora,
      createdAt: ahora,
      updatedAt: ahora,
    });
    return { condominioId, u102, zonaId, visitante, walkIn, asambleaId, conversacion, propietario, vigente, vencida };
  });
  const como = (p: Persona) => t.withIdentity({ subject: p });
  return { t, como, ...ids };
}

type Casa = Awaited<ReturnType<typeof casa102>>;

/** Lo que la pantalla "Autorizar visitante" manda. */
function nuevoVisitante(c: Casa) {
  return {
    condominioId: c.condominioId,
    unidadId: c.u102,
    nombre: "Visitante de prueba",
    documento: "789",
    tipoDocumento: "CC" as const,
    tipo: "visitante" as const,
  };
}

describe("H3 · la arrendataria con el vínculo vencido (terminó el 1 de septiembre)", () => {
  test("no autoriza, ve, borra ni responde visitantes de la casa", async () => {
    const c = await casa102();
    const yo = c.como("vencida");
    await expect(yo.mutation(api.visitantes.crearMio, nuevoVisitante(c))).rejects.toThrow(
      "Esa unidad no está vinculada a tu cuenta.",
    );
    expect(await yo.query(api.visitantes.listMios, { condominioId: c.condominioId })).toEqual([]);
    expect(await yo.query(api.visitantes.getMio, { id: c.visitante })).toBeNull();
    await expect(yo.mutation(api.visitantes.removeMio, { id: c.visitante })).rejects.toThrow("No autorizado.");
    await expect(
      yo.mutation(api.visitantes.responderWalkIn, { id: c.walkIn, aceptar: true }),
    ).rejects.toThrow("No autorizado.");

    /* Nada cambió en la casa. */
    const visitantes = await c.t.run(async (ctx) => await ctx.db.query("visitantes").collect());
    expect(visitantes.map((v) => v.estado).sort()).toEqual(["esperando_aprobacion", "pendiente"]);
  });

  test("el portal no le devuelve la casa: ni encabezado, ni 'Mi unidad', ni reservas, ni la mora de la casa", async () => {
    const c = await casa102();
    const yo = c.como("vencida");
    const home = await yo.query(api.portal.home, { condominioId: c.condominioId });
    /* Sigue siendo miembro del conjunto (avisos, PQRS): solo pierde la casa. */
    expect(home).toMatchObject({ allowed: true, unidades: [] });
    expect(await yo.query(api.portal.misActividades, { condominioId: c.condominioId })).toMatchObject({
      reservasActivas: [],
    });
    expect(await yo.query(api.portal.navBadges, { condominioId: c.condominioId })).toMatchObject({
      facturasVencidas: 0,
    });
    expect(await yo.query(api.portal.misPaquetes, { condominioId: c.condominioId })).toEqual([]);
    expect(await yo.query(api.vehiculos.listMios, { condominioId: c.condominioId })).toEqual([]);
    expect(await yo.query(api.facturas.listMia, { condominioId: c.condominioId })).toEqual([]);
  });

  test("no registra asistencia ni vota por la casa en una asamblea", async () => {
    const c = await casa102();
    const yo = c.como("vencida");
    const mi = await yo.query(api.asambleas.miParticipacion, { asambleaId: c.asambleaId });
    expect(mi).toMatchObject({ puedeRegistrar: false });
    await expect(
      yo.mutation(api.asambleas.registrarAsistencia, { asambleaId: c.asambleaId }),
    ).rejects.toThrow("No tienes unidades para registrar.");
  });

  test("por WhatsApp tampoco: el bot no le carga la casa y no le reserva a nombre de ella", async () => {
    const c = await casa102();
    const contexto = await c.t.query(internal.whatsapp.contextoConversacion, {
      conversacionId: c.conversacion,
    });
    expect(contexto?.unidades).toEqual([]);
    await expect(
      c.t.mutation(internal.reservas.createFromBot, {
        userId: c.vencida.userId,
        condominioId: c.condominioId,
        unidadId: c.u102,
        zonaId: c.zonaId,
        fecha: "2026-10-25",
        horaInicio: "10:00",
        horaFin: "12:00",
      }),
    ).rejects.toThrow("Esa unidad no está vinculada a tu cuenta.");
  });
});

describe("H3 · quien tiene el vínculo vigente conserva todo", () => {
  for (const quien of ["propietario", "vigente"] as const) {
    test(`${quien}: autoriza visitantes, ve la casa, su reserva y su mora`, async () => {
      const c = await casa102();
      const yo = c.como(quien);
      const id = await yo.mutation(api.visitantes.crearMio, nuevoVisitante(c));
      expect(await yo.query(api.visitantes.getMio, { id })).not.toBeNull();
      expect((await yo.query(api.visitantes.listMios, { condominioId: c.condominioId })).length).toBe(3);

      const home = await yo.query(api.portal.home, { condominioId: c.condominioId });
      expect(home.allowed && home.unidades.map((u) => u.numero)).toEqual(["102"]);
      expect(
        (await yo.query(api.portal.misActividades, { condominioId: c.condominioId })).reservasActivas,
      ).toHaveLength(1);
      expect(await yo.query(api.portal.navBadges, { condominioId: c.condominioId })).toMatchObject({
        facturasVencidas: 1,
      });
      expect(
        await yo.query(api.asambleas.miParticipacion, { asambleaId: c.asambleaId }),
      ).toMatchObject({ puedeRegistrar: true });
      expect(await yo.query(api.vehiculos.listMios, { condominioId: c.condominioId })).toHaveLength(1);
    });
  }
});

describe("H3 · el día exacto en que termina el vínculo", () => {
  test("el 1 de septiembre completo todavía es suyo; desde el 2 a las 00:00 (Colombia) ya no", async () => {
    const c = await casa102();
    const yo = c.como("vencida");

    vi.setSystemTime(bogota("2026-09-01T23:59"));
    await expect(yo.mutation(api.visitantes.crearMio, nuevoVisitante(c))).resolves.toBeTruthy();
    expect((await yo.query(api.portal.home, { condominioId: c.condominioId })).unidades).toHaveLength(1);

    vi.setSystemTime(bogota("2026-09-02T00:00"));
    await expect(yo.mutation(api.visitantes.crearMio, nuevoVisitante(c))).rejects.toThrow(
      "Esa unidad no está vinculada a tu cuenta.",
    );
    expect((await yo.query(api.portal.home, { condominioId: c.condominioId })).unidades).toHaveLength(0);
  });

  test("un vínculo que todavía no empieza tampoco da acceso", async () => {
    const c = await casa102();
    vi.setSystemTime(bogota("2026-03-31T23:59"));
    await expect(
      c.como("vigente").mutation(api.visitantes.crearMio, nuevoVisitante(c)),
    ).rejects.toThrow("Esa unidad no está vinculada a tu cuenta.");
  });
});
