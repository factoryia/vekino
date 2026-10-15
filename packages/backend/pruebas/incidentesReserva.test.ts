import { test, expect, describe } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { subidaValidada } from "./helpers/subidas";

const modules = import.meta.glob("../convex/**/*.ts");

/**
 * INCIDENTES Y DEVOLUCIÓN DEL DEPÓSITO.
 *
 * Portería ve el daño; la administración le pone precio. El depósito solo
 * descuenta por incidentes valorados, como máximo lo que hay, y nadie puede
 * "retener" a criterio. Aquí se prueba ese reparto con las mutaciones de
 * verdad, porque es donde vive la autorización.
 */

const AHORA = Date.now();
const DEPOSITO = 60000;

type T = ReturnType<typeof convexTest>;
const como = (t: T, subject: string) => t.withIdentity({ subject });

async function escenario(t: T) {
  return await t.run(async (ctx) => {
    const condominioId = await ctx.db.insert("condominios", {
      name: "Conjunto A",
      activeModules: [],
      isActive: true,
      createdAt: AHORA,
      updatedAt: AHORA,
    });

    const persona = async (name: string, authId: string, roles: string[]) => {
      const userId = await ctx.db.insert("users", {
        name,
        email: `${authId}@vekino.test`,
        emailVerified: true,
        active: true,
        authId,
        createdAt: AHORA,
        updatedAt: AHORA,
      });
      const membershipId = await ctx.db.insert("memberships", {
        userId,
        condominioId,
        roles: roles as never,
        isActive: true,
        createdAt: AHORA,
        updatedAt: AHORA,
      });
      return { userId, membershipId };
    };

    await persona("Admin", "admin", ["administrador"]);
    await persona("Contadora", "contadora", ["contadora"]);
    const guarda = await persona("Guarda", "guarda", ["guardia"]);
    const residente = await persona("Residente", "residente", ["residente", "propietario"]);

    const unidadId = await ctx.db.insert("unidades", {
      condominioId,
      tipo: "casa",
      estado: "ocupada",
      numero: "409",
      createdAt: AHORA,
      updatedAt: AHORA,
    });
    await ctx.db.insert("usuarioUnidad", {
      membershipId: residente.membershipId,
      unidadId,
      condominioId,
      vinculo: "propietario" as never,
      esPrincipal: true,
      createdAt: AHORA,
    });

    const salon = await ctx.db.insert("zonasComunes", {
      condominioId,
      nombre: "Salón primer piso",
      unidadTiempo: "dia",
      precioPorDia: 260000,
      depositoRequerido: DEPOSITO,
      activa: true,
      createdAt: AHORA,
      updatedAt: AHORA,
    });

    return { condominioId, unidadId, salon, guardaId: guarda.userId };
  });
}

type Escenario = Awaited<ReturnType<typeof escenario>>;

/** La URL de una foto que el guarda subió a `uso` de portería (H-12, Fase 4 de S3). */
const fotoDelGuarda = async (t: T, s: Escenario, uso: "incidentes" | "depositos", nombre: string) =>
  (await subidaValidada(t, { userId: s.guardaId, carpeta: `condominios/guardia/${s.condominioId}/${uso}`, nombre, tipo: "image/jpeg" })).url;

/** Reserva aprobada con el depósito recibido en portería (ingreso validado). */
async function reservaConDeposito(t: T, s: Escenario, fecha = "2026-09-16") {
  const reservaId = await como(t, "admin").mutation(api.reservas.create, {
    condominioId: s.condominioId,
    unidadId: s.unidadId,
    zonaId: s.salon,
    fecha,
    horaInicio: "10:00",
    horaFin: "12:00",
  });
  await como(t, "admin").mutation(api.reservas.updateEstado, { id: reservaId, estado: "aprobada" });
  await como(t, "guarda").mutation(api.guardia.registrarDepositoReserva, {
    reservaId,
    monto: DEPOSITO,
  });
  const depositoId = await t.run(async (ctx) => {
    const dep = await ctx.db
      .query("guardiaReservaDepositos")
      .withIndex("by_reserva", (q) => q.eq("reservaId", reservaId))
      .first();
    return dep!._id;
  });
  return { reservaId, depositoId };
}

/** La fila de portería: lo mismo que ve el guarda en pantalla. */
async function filaPorteria(t: T, s: Escenario, reservaId: Id<"reservas">) {
  const filas = await como(t, "guarda").query(api.guardia.listReservasControl, {
    condominioId: s.condominioId,
  });
  return filas.find((f) => f._id === reservaId)!;
}

const deposito = (t: T, id: Id<"guardiaReservaDepositos">) =>
  t.run(async (ctx) => await ctx.db.get(id));

describe("la cuenta del depósito, liquidada en el servidor", () => {
  test("sin incidentes: se devuelve todo y la razón es opcional", async () => {
    const t = convexTest(schema, modules);
    const s = await escenario(t);
    const { reservaId, depositoId } = await reservaConDeposito(t, s);

    const fila = await filaPorteria(t, s, reservaId);
    expect(fila.liquidacion?.saldoDevolucion).toBe(DEPOSITO);
    expect(fila.liquidacion?.razonObligatoria).toBe(false);

    await como(t, "guarda").mutation(api.guardia.resolverDepositoReserva, {
      depositoId,
      saldoEsperado: DEPOSITO,
    });

    const dep = await deposito(t, depositoId);
    expect(dep?.estado).toBe("devuelto");
    expect(dep?.montoDevuelto).toBe(DEPOSITO);
    expect(dep?.montoDescontado).toBe(0);
    expect(dep?.observacionesSalida).toBeUndefined();
    expect(dep?.resueltoPorUserId).toBe(s.guardaId);

    const reserva = await t.run(async (ctx) => await ctx.db.get(reservaId));
    expect(reserva?.salidaValidadaAt).toBeTypeOf("number");
  });

  test("un incidente menor: devuelve $50.000 y exige la razón", async () => {
    const t = convexTest(schema, modules);
    const s = await escenario(t);
    const { reservaId, depositoId } = await reservaConDeposito(t, s);

    await como(t, "admin").mutation(api.reservas.registrarIncidente, {
      reservaId,
      descripcion: "Silla rota",
      valor: 10000,
    });

    await expect(
      como(t, "guarda").mutation(api.guardia.resolverDepositoReserva, {
        depositoId,
        saldoEsperado: 50000,
      }),
    ).rejects.toThrow(/razón/);

    const razon = "Devolución parcial por daño de silla. Se descontaron $10.000.";
    await como(t, "guarda").mutation(api.guardia.resolverDepositoReserva, {
      depositoId,
      saldoEsperado: 50000,
      observaciones: razon,
    });

    const dep = await deposito(t, depositoId);
    expect(dep?.estado).toBe("devuelto_parcial");
    expect(dep?.montoDevuelto).toBe(50000);
    expect(dep?.montoDescontado).toBe(10000);
    expect(dep?.totalIncidentes).toBe(10000);
    expect(dep?.monto).toBe(DEPOSITO);
    expect(dep?.observacionesSalida).toBe(razon);
  });

  test("varios incidentes: $10.000 + $15.000 devuelve $35.000", async () => {
    const t = convexTest(schema, modules);
    const s = await escenario(t);
    const { reservaId, depositoId } = await reservaConDeposito(t, s);

    for (const valor of [10000, 15000]) {
      await como(t, "admin").mutation(api.reservas.registrarIncidente, {
        reservaId,
        descripcion: `Daño de ${valor}`,
        valor,
      });
    }
    const fila = await filaPorteria(t, s, reservaId);
    expect(fila.liquidacion?.totalIncidentes).toBe(25000);
    expect(fila.liquidacion?.saldoDevolucion).toBe(35000);

    await como(t, "admin").mutation(api.reservas.resolverDeposito, {
      depositoId,
      saldoEsperado: 35000,
      observaciones: "Dos daños",
    });
    const dep = await deposito(t, depositoId);
    expect(dep?.montoDevuelto).toBe(35000);
    expect(dep?.estado).toBe("devuelto_parcial");
  });

  test("un incidente mayor al depósito: descuenta $60.000, devuelve $0 y no crea deuda", async () => {
    const t = convexTest(schema, modules);
    const s = await escenario(t);
    const { reservaId, depositoId } = await reservaConDeposito(t, s);

    await como(t, "admin").mutation(api.reservas.registrarIncidente, {
      reservaId,
      descripcion: "Mesón del BBQ roto",
      valor: 100000,
    });
    const fila = await filaPorteria(t, s, reservaId);
    expect(fila.liquidacion?.totalDescuento).toBe(DEPOSITO);
    expect(fila.liquidacion?.saldoDevolucion).toBe(0);
    expect(fila.liquidacion?.excedenteNoCubierto).toBe(40000);

    await como(t, "admin").mutation(api.reservas.resolverDeposito, {
      depositoId,
      saldoEsperado: 0,
      observaciones: "Daño superior al depósito; el resto se gestiona por fuera.",
    });

    const dep = await deposito(t, depositoId);
    expect(dep?.estado).toBe("no_devuelto");
    expect(dep?.montoDevuelto).toBe(0);
    expect(dep?.montoDescontado).toBe(DEPOSITO);
    expect(dep?.totalIncidentes).toBe(100000);

    /* Los $40.000 no aparecen como cobro en ningún lado: ni en la reserva, ni
     * como novedad cobrable, ni en la cartera. */
    const efectos = await t.run(async (ctx) => ({
      reserva: await ctx.db.get(reservaId),
      novedades: await ctx.db.query("guardiaNovedadReportes").collect(),
      facturas: await ctx.db.query("facturas").collect(),
    }));
    expect(efectos.reserva?.pagoAlquilerMonto).toBeUndefined();
    expect(efectos.novedades).toEqual([]);
    expect(efectos.facturas).toEqual([]);
  });

  test("varios incidentes que juntos superan el depósito no dejan saldo negativo", async () => {
    const t = convexTest(schema, modules);
    const s = await escenario(t);
    const { reservaId, depositoId } = await reservaConDeposito(t, s);

    for (const valor of [40000, 50000]) {
      await como(t, "admin").mutation(api.reservas.registrarIncidente, {
        reservaId,
        descripcion: `Daño de ${valor}`,
        valor,
      });
    }
    await como(t, "guarda").mutation(api.guardia.resolverDepositoReserva, {
      depositoId,
      saldoEsperado: 0,
      observaciones: "Daños mayores al depósito",
    });
    const dep = await deposito(t, depositoId);
    expect(dep?.montoDevuelto).toBe(0);
    expect(dep?.montoDescontado).toBe(DEPOSITO);
  });

  test("un saldo distinto al calculado se rechaza", async () => {
    const t = convexTest(schema, modules);
    const s = await escenario(t);
    const { reservaId, depositoId } = await reservaConDeposito(t, s);

    await como(t, "admin").mutation(api.reservas.registrarIncidente, {
      reservaId,
      descripcion: "Silla rota",
      valor: 10000,
    });
    /* La pantalla todavía mostraba el depósito completo. */
    await expect(
      como(t, "guarda").mutation(api.guardia.resolverDepositoReserva, {
        depositoId,
        saldoEsperado: DEPOSITO,
        observaciones: "Todo bien",
      }),
    ).rejects.toThrow(/cambió/);
    expect((await deposito(t, depositoId))?.estado).toBe("registrado");
  });
});

describe("el guarda reporta, la administración valora", () => {
  test("el guarda reporta sin valor y queda pendiente con su trazabilidad", async () => {
    const t = convexTest(schema, modules);
    const s = await escenario(t);
    const { reservaId } = await reservaConDeposito(t, s);

    await como(t, "guarda").mutation(api.guardia.reportarIncidenteReserva, {
      reservaId,
      descripcion: "Se rompió una silla",
      fotos: [{ url: await fotoDelGuarda(t, s, "incidentes", "silla.jpg") }],
    });

    const [incidente] = await t.run(async (ctx) => await ctx.db.query("reservaIncidentes").collect());
    expect(incidente?.estado).toBe("pendiente");
    expect(incidente?.valor).toBeUndefined();
    expect(incidente?.origen).toBe("porteria");
    expect(incidente?.reportadoPorUserId).toBe(s.guardaId);
    expect(incidente?.revisadoPorUserId).toBeUndefined();
    expect(incidente?.fotos).toHaveLength(1);

    /* La administración lo ve en su lista. */
    const pagina = await como(t, "admin").query(api.reservas.listPage, {
      condominioId: s.condominioId,
      paginationOpts: { numItems: 30, cursor: null },
    });
    const fila = pagina.page.find((r) => r._id === reservaId)!;
    expect(fila.incidentes).toHaveLength(1);
    expect(fila.incidentes[0]?.reportadoPorNombre).toBe("Guarda");
    expect(fila.liquidacion?.pendientes).toBe(1);
    expect(fila.liquidacion?.puedeLiquidar).toBe(false);
  });

  test("el guarda no puede mandar un valor", async () => {
    const t = convexTest(schema, modules);
    const s = await escenario(t);
    const { reservaId } = await reservaConDeposito(t, s);

    await expect(
      como(t, "guarda").mutation(api.guardia.reportarIncidenteReserva, {
        reservaId,
        descripcion: "Silla rota",
        valor: 10000,
      } as never),
    ).rejects.toThrow();
    await expect(
      como(t, "guarda").mutation(api.reservas.registrarIncidente, {
        reservaId,
        descripcion: "Silla rota",
        valor: 10000,
      }),
    ).rejects.toThrow(/rol/);
  });

  test("el guarda no puede valorar ni descartar", async () => {
    const t = convexTest(schema, modules);
    const s = await escenario(t);
    const { reservaId } = await reservaConDeposito(t, s);
    const incidenteId = await como(t, "guarda").mutation(api.guardia.reportarIncidenteReserva, {
      reservaId,
      descripcion: "Silla rota",
    });

    await expect(
      como(t, "guarda").mutation(api.reservas.valorarIncidente, { incidenteId, valor: 10000 }),
    ).rejects.toThrow(/rol/);
    await expect(
      como(t, "guarda").mutation(api.reservas.descartarIncidente, { incidenteId }),
    ).rejects.toThrow(/rol/);
  });

  test("la administración valora lo reportado por el guarda sin perder quién lo reportó", async () => {
    const t = convexTest(schema, modules);
    const s = await escenario(t);
    const { reservaId, depositoId } = await reservaConDeposito(t, s);
    const incidenteId = await como(t, "guarda").mutation(api.guardia.reportarIncidenteReserva, {
      reservaId,
      descripcion: "Silla rota",
    });

    await como(t, "admin").mutation(api.reservas.valorarIncidente, {
      incidenteId,
      valor: 10000,
      nota: "Cotización de reparación",
    });

    const incidente = await t.run(async (ctx) => await ctx.db.get(incidenteId));
    expect(incidente?.estado).toBe("valorado");
    expect(incidente?.valor).toBe(10000);
    expect(incidente?.reportadoPorNombre).toBe("Guarda");
    expect(incidente?.revisadoPorNombre).toBe("Admin");
    expect(incidente?.notaRevision).toBe("Cotización de reparación");

    await como(t, "guarda").mutation(api.guardia.resolverDepositoReserva, {
      depositoId,
      saldoEsperado: 50000,
      observaciones: "Silla rota, se descontaron $10.000",
    });
    expect((await deposito(t, depositoId))?.montoDevuelto).toBe(50000);
  });

  test("la administración registra un incidente ya valorado", async () => {
    const t = convexTest(schema, modules);
    const s = await escenario(t);
    const { reservaId } = await reservaConDeposito(t, s);

    const id = await como(t, "admin").mutation(api.reservas.registrarIncidente, {
      reservaId,
      descripcion: "Vidrio roto",
      valor: 30000,
    });
    const incidente = await t.run(async (ctx) => await ctx.db.get(id));
    expect(incidente?.estado).toBe("valorado");
    expect(incidente?.origen).toBe("administracion");
    expect(incidente?.reportadoPorNombre).toBe("Admin");
    expect(incidente?.revisadoPorNombre).toBe("Admin");
  });

  test("la contadora conserva los permisos de caja: puede valorar", async () => {
    const t = convexTest(schema, modules);
    const s = await escenario(t);
    const { reservaId } = await reservaConDeposito(t, s);
    const incidenteId = await como(t, "guarda").mutation(api.guardia.reportarIncidenteReserva, {
      reservaId,
      descripcion: "Silla rota",
    });
    await como(t, "contadora").mutation(api.reservas.valorarIncidente, { incidenteId, valor: 5000 });
    const incidente = await t.run(async (ctx) => await ctx.db.get(incidenteId));
    expect(incidente?.revisadoPorNombre).toBe("Contadora");
  });

  test("un valor de cero no se acepta: para no descontar se descarta", async () => {
    const t = convexTest(schema, modules);
    const s = await escenario(t);
    const { reservaId } = await reservaConDeposito(t, s);
    const incidenteId = await como(t, "guarda").mutation(api.guardia.reportarIncidenteReserva, {
      reservaId,
      descripcion: "Silla rota",
    });
    await expect(
      como(t, "admin").mutation(api.reservas.valorarIncidente, { incidenteId, valor: 0 }),
    ).rejects.toThrow(/mayor a 0/);
  });

  test("un incidente descartado no descuenta y la razón vuelve a ser opcional", async () => {
    const t = convexTest(schema, modules);
    const s = await escenario(t);
    const { reservaId, depositoId } = await reservaConDeposito(t, s);
    const incidenteId = await como(t, "guarda").mutation(api.guardia.reportarIncidenteReserva, {
      reservaId,
      descripcion: "Mancha en el piso",
    });
    await como(t, "admin").mutation(api.reservas.descartarIncidente, {
      incidenteId,
      nota: "Salió con limpieza normal",
    });

    const fila = await filaPorteria(t, s, reservaId);
    expect(fila.liquidacion?.saldoDevolucion).toBe(DEPOSITO);
    expect(fila.liquidacion?.razonObligatoria).toBe(false);

    await como(t, "guarda").mutation(api.guardia.resolverDepositoReserva, {
      depositoId,
      saldoEsperado: DEPOSITO,
    });
    const dep = await deposito(t, depositoId);
    expect(dep?.estado).toBe("devuelto");
    expect(dep?.montoDevuelto).toBe(DEPOSITO);
  });

  test("el residente no reporta, no valora ni devuelve", async () => {
    const t = convexTest(schema, modules);
    const s = await escenario(t);
    const { reservaId, depositoId } = await reservaConDeposito(t, s);
    const incidenteId = await como(t, "guarda").mutation(api.guardia.reportarIncidenteReserva, {
      reservaId,
      descripcion: "Silla rota",
    });

    await expect(
      como(t, "residente").mutation(api.guardia.reportarIncidenteReserva, { reservaId, descripcion: "x" }),
    ).rejects.toThrow();
    await expect(
      como(t, "residente").mutation(api.reservas.registrarIncidente, { reservaId, descripcion: "x", valor: 1 }),
    ).rejects.toThrow();
    await expect(
      como(t, "residente").mutation(api.reservas.valorarIncidente, { incidenteId, valor: 1 }),
    ).rejects.toThrow();
    await expect(
      como(t, "residente").mutation(api.reservas.descartarIncidente, { incidenteId }),
    ).rejects.toThrow();
    await expect(
      como(t, "residente").mutation(api.guardia.resolverDepositoReserva, { depositoId, saldoEsperado: DEPOSITO }),
    ).rejects.toThrow();
    await expect(
      como(t, "residente").mutation(api.reservas.resolverDeposito, { depositoId, saldoEsperado: DEPOSITO }),
    ).rejects.toThrow();

    const incidente = await t.run(async (ctx) => await ctx.db.get(incidenteId));
    expect(incidente?.estado).toBe("pendiente");
    expect((await deposito(t, depositoId))?.estado).toBe("registrado");
  });
});

describe("pendientes, salida física y custodia del depósito", () => {
  test("un incidente pendiente impide devolver, en portería y en oficina", async () => {
    const t = convexTest(schema, modules);
    const s = await escenario(t);
    const { reservaId, depositoId } = await reservaConDeposito(t, s);
    await como(t, "guarda").mutation(api.guardia.reportarIncidenteReserva, {
      reservaId,
      descripcion: "Silla rota",
    });

    await expect(
      como(t, "guarda").mutation(api.guardia.resolverDepositoReserva, {
        depositoId,
        saldoEsperado: DEPOSITO,
        observaciones: "x",
      }),
    ).rejects.toThrow(/pendiente de valoración/);
    await expect(
      como(t, "admin").mutation(api.reservas.resolverDeposito, {
        depositoId,
        saldoEsperado: DEPOSITO,
        observaciones: "x",
      }),
    ).rejects.toThrow(/pendiente de valoración/);
  });

  test("con un pendiente la salida se valida y el depósito sigue en custodia", async () => {
    const t = convexTest(schema, modules);
    const s = await escenario(t);
    const { reservaId, depositoId } = await reservaConDeposito(t, s);
    await como(t, "guarda").mutation(api.guardia.reportarIncidenteReserva, {
      reservaId,
      descripcion: "Silla rota",
    });

    await como(t, "guarda").mutation(api.guardia.validarSalidaReserva, { reservaId });

    const reserva = await t.run(async (ctx) => await ctx.db.get(reservaId));
    const salida = reserva?.salidaValidadaAt;
    expect(salida).toBeTypeOf("number");
    expect((await deposito(t, depositoId))?.estado).toBe("registrado");

    /* Después la administración valora y portería devuelve: la hora de
     * salida no se pisa. */
    const [incidente] = await t.run(async (ctx) => await ctx.db.query("reservaIncidentes").collect());
    await como(t, "admin").mutation(api.reservas.valorarIncidente, {
      incidenteId: incidente!._id,
      valor: 10000,
    });
    await como(t, "guarda").mutation(api.guardia.resolverDepositoReserva, {
      depositoId,
      saldoEsperado: 50000,
      observaciones: "Silla rota",
    });
    const despues = await t.run(async (ctx) => await ctx.db.get(reservaId));
    expect(despues?.salidaValidadaAt).toBe(salida);
  });

  test("sin pendientes, la salida sigue bloqueada con el depósito en custodia", async () => {
    const t = convexTest(schema, modules);
    const s = await escenario(t);
    const { reservaId } = await reservaConDeposito(t, s);

    await expect(
      como(t, "guarda").mutation(api.guardia.validarSalidaReserva, { reservaId }),
    ).rejects.toThrow(/depósito pendiente/);

    /* Un incidente ya valorado tampoco la libera: ya se sabe cuánto devolver. */
    await como(t, "admin").mutation(api.reservas.registrarIncidente, {
      reservaId,
      descripcion: "Silla rota",
      valor: 10000,
    });
    await expect(
      como(t, "guarda").mutation(api.guardia.validarSalidaReserva, { reservaId }),
    ).rejects.toThrow(/depósito pendiente/);
  });
});

describe("no hay retención a criterio ni doble devolución", () => {
  test("devuelto: false se rechaza en portería y en oficina", async () => {
    const t = convexTest(schema, modules);
    const s = await escenario(t);
    const { depositoId } = await reservaConDeposito(t, s);

    await expect(
      como(t, "guarda").mutation(api.guardia.resolverDepositoReserva, {
        depositoId,
        devuelto: false,
        observaciones: "Daños",
        fotoUrl: await fotoDelGuarda(t, s, "depositos", "evidencia.jpg"),
      }),
    ).rejects.toThrow(/retener/);
    await expect(
      como(t, "admin").mutation(api.reservas.resolverDeposito, {
        depositoId,
        devuelto: false,
        observaciones: "Daños",
      }),
    ).rejects.toThrow(/retener/);
    expect((await deposito(t, depositoId))?.estado).toBe("registrado");
  });

  test("una app vieja (sin saldoEsperado) solo devuelve completo cuando no hay incidentes", async () => {
    const t = convexTest(schema, modules);
    const s = await escenario(t);

    const limpia = await reservaConDeposito(t, s, "2026-09-16");
    await como(t, "guarda").mutation(api.guardia.resolverDepositoReserva, {
      depositoId: limpia.depositoId,
      devuelto: true,
    });
    expect((await deposito(t, limpia.depositoId))?.montoDevuelto).toBe(DEPOSITO);

    const conDano = await reservaConDeposito(t, s, "2026-09-18");
    await como(t, "admin").mutation(api.reservas.registrarIncidente, {
      reservaId: conDano.reservaId,
      descripcion: "Silla rota",
      valor: 10000,
    });
    await expect(
      como(t, "guarda").mutation(api.guardia.resolverDepositoReserva, {
        depositoId: conDano.depositoId,
        devuelto: true,
        observaciones: "Todo bien",
      }),
    ).rejects.toThrow(/Actualiza/);
    expect((await deposito(t, conDano.depositoId))?.estado).toBe("registrado");
  });

  test("el mismo depósito no se devuelve dos veces", async () => {
    const t = convexTest(schema, modules);
    const s = await escenario(t);
    const { depositoId } = await reservaConDeposito(t, s);

    await como(t, "guarda").mutation(api.guardia.resolverDepositoReserva, {
      depositoId,
      saldoEsperado: DEPOSITO,
    });
    await expect(
      como(t, "admin").mutation(api.reservas.resolverDeposito, { depositoId, saldoEsperado: DEPOSITO }),
    ).rejects.toThrow(/ya fue resuelto/);
    await expect(
      como(t, "guarda").mutation(api.guardia.resolverDepositoReserva, { depositoId, saldoEsperado: DEPOSITO }),
    ).rejects.toThrow(/ya fue resuelto/);
  });

  test("liquidado el depósito, sus incidentes quedan congelados", async () => {
    const t = convexTest(schema, modules);
    const s = await escenario(t);
    const { reservaId, depositoId } = await reservaConDeposito(t, s);
    const valoradoId = await como(t, "admin").mutation(api.reservas.registrarIncidente, {
      reservaId,
      descripcion: "Silla rota",
      valor: 10000,
    });
    await como(t, "admin").mutation(api.reservas.resolverDeposito, {
      depositoId,
      saldoEsperado: 50000,
      observaciones: "Silla rota",
    });

    await expect(
      como(t, "guarda").mutation(api.guardia.reportarIncidenteReserva, { reservaId, descripcion: "Otro" }),
    ).rejects.toThrow(/liquidado/);
    await expect(
      como(t, "admin").mutation(api.reservas.registrarIncidente, { reservaId, descripcion: "Otro", valor: 5000 }),
    ).rejects.toThrow(/liquidado/);
    await expect(
      como(t, "admin").mutation(api.reservas.valorarIncidente, { incidenteId: valoradoId, valor: 99999 }),
    ).rejects.toThrow(/liquidado/);
    await expect(
      como(t, "admin").mutation(api.reservas.descartarIncidente, { incidenteId: valoradoId }),
    ).rejects.toThrow(/liquidado/);

    const incidente = await t.run(async (ctx) => await ctx.db.get(valoradoId));
    expect(incidente?.valor).toBe(10000);
    const pagina = await como(t, "admin").query(api.reservas.listPage, {
      condominioId: s.condominioId,
      paginationOpts: { numItems: 30, cursor: null },
    });
    const fila = pagina.page.find((r) => r._id === reservaId)!;
    expect(fila.incidentesAbiertos).toBe(false);
    expect(fila.liquidacion).toBeNull();
    expect(fila.liquidado).toEqual({ devuelto: 50000, descontado: 10000 });
  });
});

describe("los depósitos históricos no se rompen", () => {
  test("devuelto y no_devuelto de antes se leen con sus montos en el reporte", async () => {
    const t = convexTest(schema, modules);
    const s = await escenario(t);
    const a = await reservaConDeposito(t, s, "2026-09-16");
    const b = await reservaConDeposito(t, s, "2026-09-18");

    /* Tal como quedaban antes: estado binario, sin cifras de liquidación. */
    await t.run(async (ctx) => {
      await ctx.db.patch(a.depositoId, {
        estado: "devuelto",
        resueltoPorNombre: "Guarda",
        fechaResolucion: AHORA,
      });
      await ctx.db.patch(b.depositoId, {
        estado: "no_devuelto",
        observacionesSalida: "Se dañó el mesón del BBQ",
        resueltoPorNombre: "Guarda",
        fechaResolucion: AHORA,
      });
    });

    const reporte = await como(t, "admin").query(api.reservas.reporte, {
      condominioId: s.condominioId,
      desde: "2026-09-01",
      hasta: "2026-09-30",
    });
    const [fa, fb] = reporte.filas;
    expect(fa?.depositoEstado).toBe("devuelto");
    expect(fa?.depositoDevuelto).toBe(DEPOSITO);
    expect(fa?.depositoDescontado).toBe(0);
    expect(fb?.depositoEstado).toBe("no_devuelto");
    expect(fb?.depositoDevuelto).toBe(0);
    expect(fb?.depositoDescontado).toBe(DEPOSITO);
    expect(fb?.depositoRetencion).toBe("Se dañó el mesón del BBQ");
    expect(reporte.resumen.depositosRetenidos).toBe(1);
  });

  test("el reporte cuenta las devoluciones parciales y lo descontado", async () => {
    const t = convexTest(schema, modules);
    const s = await escenario(t);
    const { reservaId, depositoId } = await reservaConDeposito(t, s);
    await como(t, "admin").mutation(api.reservas.registrarIncidente, {
      reservaId,
      descripcion: "Silla rota",
      valor: 10000,
    });
    await como(t, "admin").mutation(api.reservas.resolverDeposito, {
      depositoId,
      saldoEsperado: 50000,
      observaciones: "Silla rota",
    });

    const reporte = await como(t, "admin").query(api.reservas.reporte, {
      condominioId: s.condominioId,
      desde: "2026-09-01",
      hasta: "2026-09-30",
    });
    expect(reporte.filas[0]?.depositoEstado).toBe("devuelto_parcial");
    expect(reporte.filas[0]?.depositoRetencion).toBe("Silla rota");
    expect(reporte.resumen.depositosDevueltosParcial).toBe(1);
    expect(reporte.resumen.depositoDescontado).toBe(10000);
  });

  test("el reporte trae el valor de incidentes por reserva y su total, respetando los filtros", async () => {
    const t = convexTest(schema, modules);
    const s = await escenario(t);
    const RANGO = { desde: "2026-09-01", hasta: "2026-09-30" };

    /* A: dos valorados, uno pendiente y uno descartado → solo cuentan los valorados. */
    const a = await reservaConDeposito(t, s, "2026-09-16");
    for (const valor of [10000, 15000]) {
      await como(t, "admin").mutation(api.reservas.registrarIncidente, {
        reservaId: a.reservaId,
        descripcion: `Daño de ${valor}`,
        valor,
      });
    }
    await como(t, "guarda").mutation(api.guardia.reportarIncidenteReserva, {
      reservaId: a.reservaId,
      descripcion: "Sin valorar",
    });
    const descartado = await como(t, "guarda").mutation(api.guardia.reportarIncidenteReserva, {
      reservaId: a.reservaId,
      descripcion: "No procede",
    });
    await como(t, "admin").mutation(api.reservas.descartarIncidente, { incidenteId: descartado });

    /* B: incidente mayor al depósito, ya liquidado → vale 100.000 aunque se descontaron 60.000. */
    const b = await reservaConDeposito(t, s, "2026-09-18");
    await como(t, "admin").mutation(api.reservas.registrarIncidente, {
      reservaId: b.reservaId,
      descripcion: "Mesón roto",
      valor: 100000,
    });
    await como(t, "admin").mutation(api.reservas.resolverDeposito, {
      depositoId: b.depositoId,
      saldoEsperado: 0,
      observaciones: "Daño mayor al depósito",
    });

    /* C: sin incidentes → 0, no vacío. */
    const c = await reservaConDeposito(t, s, "2026-09-20");

    /* D: fuera del rango → no entra al total. */
    const d = await reservaConDeposito(t, s, "2026-10-02");
    await como(t, "admin").mutation(api.reservas.registrarIncidente, {
      reservaId: d.reservaId,
      descripcion: "Fuera del rango",
      valor: 7000,
    });

    const reporte = await como(t, "admin").query(api.reservas.reporte, {
      condominioId: s.condominioId,
      ...RANGO,
    });
    const porId = new Map(reporte.filas.map((f) => [f._id, f]));
    expect(porId.get(a.reservaId)?.valorIncidentes).toBe(25000);
    expect(porId.get(b.reservaId)?.valorIncidentes).toBe(100000);
    expect(porId.get(b.reservaId)?.depositoDescontado).toBe(DEPOSITO);
    expect(porId.get(c.reservaId)?.valorIncidentes).toBe(0);
    expect(porId.has(d.reservaId)).toBe(false);
    expect(reporte.resumen.valorIncidentes).toBe(125000);
    /* El total es exactamente la suma de la columna: no hay una segunda regla. */
    expect(reporte.resumen.valorIncidentes).toBe(
      reporte.filas.reduce((s2, f) => s2 + f.valorIncidentes, 0),
    );
    /* Lo existente no cambia por los incidentes. */
    expect(reporte.resumen.depositoDescontado).toBe(DEPOSITO);

    /* La descripción acompaña al valor: dice de QUÉ se habla. Van los cuatro
       incidentes de A, también el pendiente y el descartado, que no suman. */
    expect(porId.get(a.reservaId)?.descripcionIncidentes).toBe(
      "Daño de 10000 · Daño de 15000 · Sin valorar · No procede",
    );
    expect(porId.get(b.reservaId)?.descripcionIncidentes).toBe("Mesón roto");
    /* Sin incidentes es cadena vacía, que es la celda en blanco del reporte. */
    expect(porId.get(c.reservaId)?.descripcionIncidentes).toBe("");

    /* Con filtro de estado, solo las filas filtradas suman. */
    await como(t, "admin").mutation(api.reservas.updateEstado, { id: c.reservaId, estado: "cancelada" });
    const canceladas = await como(t, "admin").query(api.reservas.reporte, {
      condominioId: s.condominioId,
      ...RANGO,
      estado: "cancelada",
    });
    expect(canceladas.filas.map((f) => f._id)).toEqual([c.reservaId]);
    expect(canceladas.resumen.valorIncidentes).toBe(0);
    const aprobadas = await como(t, "admin").query(api.reservas.reporte, {
      condominioId: s.condominioId,
      ...RANGO,
      estado: "aprobada",
    });
    expect(aprobadas.resumen.valorIncidentes).toBe(125000);
  });

  test("borrar la reserva se lleva sus incidentes", async () => {
    const t = convexTest(schema, modules);
    const s = await escenario(t);
    const { reservaId } = await reservaConDeposito(t, s);
    await como(t, "guarda").mutation(api.guardia.reportarIncidenteReserva, { reservaId, descripcion: "x" });
    await como(t, "admin").mutation(api.reservas.remove, { id: reservaId });
    const restantes = await t.run(async (ctx) => await ctx.db.query("reservaIncidentes").collect());
    expect(restantes).toEqual([]);
  });
});
