import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { vencimientoDePeriodo } from "../../convex/lib/cartera";
import { MENSAJE_PASARELA_DE_PRUEBAS } from "../../convex/lib/avalProduccion";
import {
  AHORA,
  DIA,
  aceptaPagar,
  aprobarPagoAval,
  bloquearRed,
  bogota,
  cargar,
  comoLaCargaPorPdf,
  datosDePagoBot,
  esperarProgramadas,
  facturaDe,
  fijarReloj,
  liberarRed,
  linea,
  montar,
  soltarReloj,
  type Escenario,
  type FacturaCarga,
} from "./escenario";

/**
 * FASE 4 DE LA AUDITORÍA DE FACTURACIÓN (docs/audits/FASE-4-FACTURACION.md),
 * contra el backend real en convex-test, con la red bloqueada:
 *
 *   · cobros de parqueadero: un cobro por (casa, vehículo, mes en hora de
 *     Colombia), un solo estado para Vigilancia y Cobros de parqueadero,
 *     transiciones validadas con su historia, reportes viejos y agrupamiento
 *     con `dryRun` (F-08);
 *   · aporte voluntario: cargos del mes, deuda de la última factura, concepto
 *     por texto y el color del guarda (F-10);
 *   · `listMia` con más de 50 facturas (F-16);
 *   · quién ve los pagos, sin las respuestas crudas del banco (F-20);
 *   · las dos cifras de recaudo (F-19);
 *   · mora desde el 16 del mes siguiente (decisión B) y "sin verificar";
 *   · la pasarela en QA, la versión mínima del móvil y el número de factura.
 */

beforeEach(() => {
  bloquearRed();
  fijarReloj();
});

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
  soltarReloj();
  liberarRed();
});

// ─── Parqueadero (F-08) ─────────────────────────────────────────────────────

async function conCarro(esc: Escenario, placa = "ABC123", unidad: "u101" | "u202" = "u101") {
  return await esc.t.run(
    async (ctx) =>
      await ctx.db.insert("vehiculos", {
        condominioId: esc.condominioId,
        unidadId: esc[unidad],
        placa,
        tipo: "carro",
        createdAt: AHORA,
        updatedAt: AHORA,
      }),
  );
}

async function reportar(esc: Escenario, vehiculoId: Id<"vehiculos">, cuando: string) {
  const id = await esc.como("guarda").mutation(api.guardia.reportarNovedad, {
    condominioId: esc.condominioId,
    titulo: "Vehículo sin aporte",
    descripcion: "Parqueado en zona común sin aporte voluntario.",
    prioridad: "media",
    vehiculoId,
    ocurrioEn: bogota(cuando),
  });
  await esperarProgramadas(esc);
  return id;
}

async function cobros(esc: Escenario, estado = "todos") {
  return await esc.como("admin").query(api.parqueadero.listar, { condominioId: esc.condominioId, estado });
}

async function vigilancia(esc: Escenario) {
  return await esc.como("admin").query(api.guardia.listNovedadReportes, { condominioId: esc.condominioId });
}

/** Un reporte como los que ya están guardados: sin cobro enlazado y con los dos estados viejos. */
async function reporteViejo(
  esc: Escenario,
  vehiculoId: Id<"vehiculos">,
  cuando: string,
  estados: { cobroEstado?: "pendiente" | "facturado" | "descartado"; gestion?: "pendiente" | "cobrada" | "descartada"; cobroPeriodo?: string } = {},
) {
  return await esc.t.run(
    async (ctx) =>
      await ctx.db.insert("guardiaNovedadReportes", {
        condominioId: esc.condominioId,
        titulo: "No tiene aporte voluntario",
        descripcion: "Placa reportada durante la ronda.",
        prioridad: "media",
        vehiculoId,
        vehiculoPlaca: "ABC123",
        vehiculoDescripcion: "carro",
        unidades: [{ unidadId: esc.u101, numero: "101" }],
        ocurrioEn: bogota(cuando),
        cobroEstado: estados.cobroEstado ?? "pendiente",
        gestion: estados.gestion ?? "pendiente",
        ...(estados.cobroPeriodo ? { cobroPeriodo: estados.cobroPeriodo } : {}),
        reportadoPorUserId: esc.guardaId,
        reportadoPorNombre: "Guarda de turno",
        createdAt: bogota(cuando),
      }),
  );
}

describe("F-08 · cobros de parqueadero", () => {
  test("el mes del cobro va en hora de Colombia, también en el borde de mes", async () => {
    const esc = await montar();
    const carro = await conCarro(esc);
    await reportar(esc, carro, "2026-09-15T10:00");
    await reportar(esc, carro, "2026-09-30T22:00"); // en UTC ya es octubre
    await reportar(esc, carro, "2026-10-01T01:00");
    const { filas, resumen } = await cobros(esc);
    expect(resumen.pendientes).toBe(2);
    expect(resumen.reportes).toBe(3);
    expect(filas.map((f) => [f.periodoParqueo, f.reportes]).sort()).toEqual([
      ["2026-09", 2],
      ["2026-10", 1],
    ]);
  });

  test("Vigilancia y Cobros de parqueadero mueven el MISMO estado", async () => {
    const esc = await montar();
    const carro = await conCarro(esc);
    const r1 = await reportar(esc, carro, "2026-09-03T22:00");
    const r2 = await reportar(esc, carro, "2026-09-10T22:00");

    /* Se factura desde Cobros con el SEGUNDO reporte: el mes entero queda facturado. */
    await esc.como("admin").mutation(api.parqueadero.marcarFacturado, { reporteId: r2, periodo: "2026-10" });
    const vistos = await vigilancia(esc);
    for (const id of [r1, r2]) {
      const n = vistos.find((x) => x._id === id)!;
      expect(n.gestion).toBe("cobrada");
      expect(n.cobro).toMatchObject({ estado: "facturado", periodoFactura: "2026-10", reportes: 2 });
    }

    /* "Reabrir" en Vigilancia lo devuelve a pendiente en Cobros. */
    await esc.como("admin").mutation(api.guardia.gestionarNovedad, { novedadId: r1, gestion: "pendiente" });
    expect((await cobros(esc)).filas[0]).toMatchObject({ estado: "pendiente", periodo: null });

    /* Descartar en Vigilancia, con motivo, lo descarta en Cobros. */
    await esc.como("admin").mutation(api.guardia.gestionarNovedad, {
      novedadId: r1,
      gestion: "descartada",
      nota: "Era el carro de un visitante",
    });
    expect((await cobros(esc)).filas[0]).toMatchObject({ estado: "descartado", nota: "Era el carro de un visitante" });

    /* Y devolverlo en Cobros lo deja pendiente en Vigilancia. */
    await esc.como("admin").mutation(api.parqueadero.devolverAPendiente, { reporteId: r1 });
    expect((await vigilancia(esc)).find((x) => x._id === r2)!.gestion).toBe("pendiente");
  });

  test("las transiciones que no van se rechazan con un mensaje claro", async () => {
    const esc = await montar();
    const carro = await conCarro(esc);
    const r = await reportar(esc, carro, "2026-09-03T22:00");
    const admin = esc.como("admin");
    await expect(admin.mutation(api.parqueadero.devolverAPendiente, { reporteId: r })).rejects.toThrow(/ya está pendiente/);
    await admin.mutation(api.parqueadero.marcarFacturado, { reporteId: r, periodo: "2026-10" });
    await expect(admin.mutation(api.parqueadero.descartar, { reporteId: r, nota: "no" })).rejects.toThrow(/ya se facturó en 2026-10/);
    await expect(
      admin.mutation(api.guardia.gestionarNovedad, { novedadId: r, gestion: "cobrada", periodo: "2026-11" }),
    ).rejects.toThrow(/ya se facturó en 2026-10/);
    await admin.mutation(api.parqueadero.devolverAPendiente, { reporteId: r });
    await admin.mutation(api.parqueadero.descartar, { reporteId: r, nota: "Placa mal leída" });
    await expect(admin.mutation(api.parqueadero.marcarFacturado, { reporteId: r, periodo: "2026-10" })).rejects.toThrow(/está descartado/);
    await expect(admin.mutation(api.parqueadero.descartar, { reporteId: r, nota: "   " })).rejects.toThrow();
    /* Un período mal escrito tampoco. */
    await admin.mutation(api.parqueadero.devolverAPendiente, { reporteId: r });
    await expect(admin.mutation(api.parqueadero.marcarFacturado, { reporteId: r, periodo: "octubre" })).rejects.toThrow(/AAAA-MM/);
  });

  test("devolver a pendiente deja quién, cuándo, el estado y el período anteriores", async () => {
    const esc = await montar();
    const carro = await conCarro(esc);
    const r = await reportar(esc, carro, "2026-09-03T22:00");
    const admin = esc.como("admin");
    await admin.mutation(api.parqueadero.marcarFacturado, { reporteId: r, periodo: "2026-10" });
    vi.setSystemTime(AHORA + DIA);
    await admin.mutation(api.parqueadero.devolverAPendiente, { reporteId: r, nota: "Quedó en la cuenta equivocada" });

    const historia = await admin.query(api.parqueadero.historial, { reporteId: r });
    expect(historia.map((e) => e.accion)).toEqual(["crear", "agregar_reporte", "facturar", "devolver"]);
    const devolver = historia[3]!;
    expect(devolver).toMatchObject({
      estadoAntes: "facturado",
      estadoDespues: "pendiente",
      periodoFacturaAntes: "2026-10",
      periodoFactura: null,
      nota: "Quedó en la cuenta equivocada",
      actorNombre: "Administración",
      origen: "cobros",
      at: AHORA + DIA,
    });
    expect(historia[2]).toMatchObject({ estadoAntes: "pendiente", estadoDespues: "facturado", periodoFactura: "2026-10" });
  });

  test("un reporte nuevo de un mes ya facturado se suma como evidencia y no genera otro cobro", async () => {
    const esc = await montar();
    const carro = await conCarro(esc);
    const r1 = await reportar(esc, carro, "2026-09-03T22:00");
    await esc.como("admin").mutation(api.parqueadero.marcarFacturado, { reporteId: r1, periodo: "2026-10" });
    await reportar(esc, carro, "2026-09-25T22:00");
    const { filas, resumen } = await cobros(esc);
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({ estado: "facturado", reportes: 2 });
    expect(resumen.pendientes).toBe(0);
    expect(resumen.facturados).toBe(1);
  });

  test("Vigilancia sin motivo: se acepta, y queda dicho en la historia", async () => {
    const esc = await montar();
    const carro = await conCarro(esc);
    const r = await reportar(esc, carro, "2026-09-03T22:00");
    await esc.como("admin").mutation(api.guardia.gestionarNovedad, { novedadId: r, gestion: "descartada" });
    const [fila] = (await cobros(esc)).filas;
    expect(fila).toMatchObject({ estado: "descartado", nota: "Descartado desde Vigilancia sin escribir el motivo." });
    const historia = await esc.como("admin").query(api.parqueadero.historial, { reporteId: r });
    expect(historia.at(-1)).toMatchObject({ accion: "descartar", origen: "vigilancia" });
  });

  test("una novedad sin vehículo sigue con su gestión de siempre y no es un cobro", async () => {
    const esc = await montar();
    const id = await esc.como("guarda").mutation(api.guardia.reportarNovedad, {
      condominioId: esc.condominioId,
      titulo: "Gotera",
      descripcion: "Gotera en el pasillo de la 101.",
      prioridad: "baja",
      unidadIds: [esc.u101],
    });
    await esperarProgramadas(esc);
    await esc.como("admin").mutation(api.guardia.gestionarNovedad, { novedadId: id, gestion: "cobrada" });
    const n = (await vigilancia(esc)).find((x) => x._id === id)!;
    expect(n.gestion).toBe("cobrada");
    expect("cobro" in n).toBe(false);
    expect((await cobros(esc)).filas).toHaveLength(0);
  });

  test("los reportes viejos (sin cobro) se agrupan al leer y se enlazan al gestionar uno", async () => {
    const esc = await montar();
    const carro = await conCarro(esc);
    const viejos = [
      await reporteViejo(esc, carro, "2026-09-03T22:00"),
      await reporteViejo(esc, carro, "2026-09-10T22:00"),
      await reporteViejo(esc, carro, "2026-09-17T22:00"),
    ];
    /* Agosto ya se había marcado "cobrada" en Vigilancia: Cobros lo seguía ofreciendo (F-08). */
    await reporteViejo(esc, carro, "2026-08-20T22:00", { gestion: "cobrada" });

    const antes = await cobros(esc);
    expect(antes.resumen.pendientes).toBe(1);
    expect(antes.filas.find((f) => f.periodoParqueo === "2026-08")).toMatchObject({ estado: "facturado", mezclado: false });
    expect(antes.filas.find((f) => f.periodoParqueo === "2026-09")).toMatchObject({ estado: "pendiente", reportes: 3 });

    await esc.como("admin").mutation(api.parqueadero.marcarFacturado, { reporteId: viejos[1]!, periodo: "2026-10" });
    const guardados = await esc.t.run(async (ctx) => ({
      cobros: await ctx.db.query("cobrosParqueadero").collect(),
      reportes: await Promise.all(viejos.map((id) => ctx.db.get(id))),
    }));
    expect(guardados.cobros).toHaveLength(1);
    expect(guardados.cobros[0]).toMatchObject({ estado: "facturado", periodo: "2026-09", periodoFactura: "2026-10" });
    expect(new Set(guardados.reportes.map((r) => r!.cargoId))).toEqual(new Set([guardados.cobros[0]!._id]));
  });

  test("agruparReportes: en dryRun no escribe y dice qué haría; aplicado, lo hace una sola vez", async () => {
    const esc = await montar();
    const carro = await conCarro(esc);
    const otro = await conCarro(esc, "XYZ987", "u202");
    await reporteViejo(esc, carro, "2026-09-03T22:00");
    await reporteViejo(esc, carro, "2026-09-10T22:00");
    await esc.t.run(async (ctx) => {
      await ctx.db.insert("guardiaNovedadReportes", {
        condominioId: esc.condominioId,
        titulo: "No tiene aporte voluntario",
        descripcion: "Placa reportada durante la ronda.",
        prioridad: "media",
        vehiculoId: otro,
        vehiculoPlaca: "XYZ987",
        unidades: [{ unidadId: esc.u202, numero: "202" }],
        cobroEstado: "pendiente",
        gestion: "pendiente",
        reportadoPorUserId: esc.guardaId,
        reportadoPorNombre: "Guarda de turno",
        createdAt: bogota("2026-09-05T22:00"),
      });
    });

    const plan = await esc.t.mutation(internal.parqueadero.agruparReportes, { condominioId: esc.condominioId });
    expect(plan).toMatchObject({
      dryRun: true,
      reportesDeVehiculo: 3,
      reportesPorEnlazar: 3,
      cobros: 2,
      cobrosConVariosReportes: 1,
      sinCasa: 0,
      creados: 0,
      enlazados: 0,
    });
    expect(await esc.t.run(async (ctx) => (await ctx.db.query("cobrosParqueadero").collect()).length)).toBe(0);

    const aplicado = await esc.t.mutation(internal.parqueadero.agruparReportes, {
      condominioId: esc.condominioId,
      dryRun: false,
    });
    expect(aplicado).toMatchObject({ dryRun: false, creados: 2, enlazados: 3 });
    const otraVez = await esc.t.mutation(internal.parqueadero.agruparReportes, {
      condominioId: esc.condominioId,
      dryRun: false,
    });
    expect(otraVez).toMatchObject({ reportesPorEnlazar: 0, cobros: 0, creados: 0 });
    const eventos = await esc.t.run(async (ctx) => await ctx.db.query("cobroParqueaderoEventos").collect());
    expect(eventos.map((e) => [e.accion, e.origen])).toEqual([
      ["agrupar", "migracion"],
      ["agrupar", "migracion"],
    ]);
  });
});

// ─── Aporte voluntario (F-10) ───────────────────────────────────────────────

describe("F-10 · aporte voluntario y el color del guarda", () => {
  async function color(esc: Escenario, placa: string) {
    return await esc.como("guarda").query(api.aporte.consultarPlaca, { condominioId: esc.condominioId, placa });
  }

  test("el guarda ve el color con la misma regla: el 'Parqueadero visitante' no es aporte", async () => {
    const esc = await montar();
    await conCarro(esc, "AAA111", "u101");
    await conCarro(esc, "BBB222", "u202");
    await cargar(esc, [
      {
        periodo: "2026-09",
        lineas: [linea("CUOTA", 0, 300_000, 1), linea("CONT. VOL. AREAS COMUNES", 14_000, 7_000, 5)],
      },
      {
        periodo: "2026-09",
        casa: "u202",
        lineas: [linea("Administración", 0, 300_000, 2), linea("Parqueadero visitante", 0, 10_000, 5)],
      },
    ]);
    /* 101: debe tres meses del aporte (21.000 / 7.000): dos de atraso, en rojo. */
    expect(await color(esc, "AAA111")).toMatchObject({ color: "rojo", montoPendiente: 21_000, mesesAtraso: 2 });
    /* 202: antes salía "al día" por el código 5; no tiene aporte. */
    expect(await color(esc, "BBB222")).toMatchObject({ color: "gris", montoPendiente: 0 });
  });

  test("el reporte separa los cargos del rango de la deuda de la última factura", async () => {
    const esc = await montar();
    await cargar(esc, [{ periodo: "2026-08", lineas: [linea("CUOTA", 0, 300_000, 1), linea("CONT. VOL. AREAS COMUNES", 0, 7_000, 5)] }]);
    await cargar(esc, [{ periodo: "2026-09", lineas: [linea("CUOTA", 0, 300_000, 1), linea("CONT. VOL. AREAS COMUNES", 7_000, 7_000, 5)] }]);
    const { filas, resumen } = await esc.como("admin").query(api.aporte.reporte, {
      condominioId: esc.condominioId,
      desde: "2026-08",
      hasta: "2026-09",
    });
    expect(filas.find((f) => f.unidadId === esc.u101)).toMatchObject({
      valorTotal: 14_000,
      deudaUltimaFactura: 14_000,
      periodoUltimaFactura: "2026-09",
      meses: 2,
    });
    expect(resumen).toMatchObject({ valorTotal: 14_000, deudaUltimaFactura: 14_000 });
  });

  test("un conjunto que llama distinto al aporte lo configura, sin perderlo al cambiar tarifas", async () => {
    const esc = await montar();
    await esc.como("admin").mutation(api.aporte.configurar, {
      condominioId: esc.condominioId,
      tarifaCarro: 7_000,
      tarifaMoto: 3_000,
      mesesParaMora: 2,
      conceptos: ["Cupo de parqueadero"],
    });
    await esc.como("admin").mutation(api.aporte.configurar, {
      condominioId: esc.condominioId,
      tarifaCarro: 8_000,
      tarifaMoto: 3_000,
      mesesParaMora: 2,
    });
    await cargar(esc, [
      {
        periodo: "2026-09",
        lineas: [linea("CUOTA", 0, 300_000, 1), linea("CUPO DE PARQUEADERO PROPIETARIO", 0, 8_000, 9), linea("CONT. VOL. AREAS COMUNES", 0, 7_000, 5)],
      },
    ]);
    const { filas } = await esc.como("admin").query(api.aporte.reporte, {
      condominioId: esc.condominioId,
      desde: "2026-09",
      hasta: "2026-09",
    });
    expect(filas.find((f) => f.unidadId === esc.u101)?.valorTotal).toBe(8_000);
  });
});

// ─── listMia (F-16) ─────────────────────────────────────────────────────────

describe("F-16 · la lista del residente", () => {
  test("con más de 50 facturas, la vigente de cada casa llega, una sola vez", async () => {
    const esc = await montar();
    /* La propietaria también tiene la 202, cuya única factura se cargó antes que todas. */
    await esc.t.run(async (ctx) => {
      await ctx.db.insert("usuarioUnidad", {
        membershipId: esc.mResidente,
        unidadId: esc.u202,
        condominioId: esc.condominioId,
        vinculo: "propietario",
        esPrincipal: false,
        createdAt: AHORA,
      });
      const base = comoLaCargaPorPdf(esc, { periodo: "2026-09", casa: "u202", lineas: [linea("CUOTA", 0, 300_000)] });
      await ctx.db.insert("facturas", { ...base, fechaEmision: 1, estado: "pendiente", createdAt: 1, updatedAt: 1 });
      for (let i = 0; i < 55; i++) {
        const periodo = `${2022 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
        const f = comoLaCargaPorPdf(esc, { periodo, lineas: [linea("CUOTA", 0, 300_000)] }, i + 1);
        await ctx.db.insert("facturas", { ...f, fechaEmision: AHORA + i, estado: "pagada", createdAt: AHORA, updatedAt: AHORA });
      }
    });
    const lista = await esc.como("residente").query(api.facturas.listMia, { condominioId: esc.condominioId });
    expect(lista).toHaveLength(50);
    expect(new Set(lista.map((f) => f._id)).size).toBe(50);
    expect(lista.some((f) => f.unidadId === esc.u202 && f.periodo === "2026-09")).toBe(true);
    expect(lista.some((f) => f.unidadId === esc.u101 && f.periodo === "2026-07")).toBe(true);
  });

  test("un arrendatario con el contrato vigente sí ve las facturas de la casa", async () => {
    const esc = await montar();
    await cargar(esc, [{ periodo: "2026-09", lineas: [linea("CUOTA", 0, 300_000)] }]);
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
        vigenciaDesde: AHORA - 30 * DIA,
        vigenciaHasta: AHORA + 300 * DIA,
        createdAt: AHORA,
      });
    });
    const lista = await esc.t
      .withIdentity({ subject: "arrendataria" })
      .query(api.facturas.listMia, { condominioId: esc.condominioId });
    expect(lista.map((f) => f.periodo)).toEqual(["2026-09"]);
  });
});

// ─── Acceso a los pagos (F-20) ──────────────────────────────────────────────

describe("F-20 · quién ve los pagos", () => {
  async function conPago() {
    const esc = await montar();
    await cargar(esc, [{ periodo: "2026-09", lineas: [linea("CUOTA", 0, 300_000)] }]);
    const septiembre = await facturaDe(esc, "2026-09");
    const pagoId = await aprobarPagoAval(esc, septiembre._id, 300_000);
    /* La respuesta cruda del banco, como la guarda `consultarEstado`. */
    await esc.t.run(async (ctx) => {
      await ctx.db.patch(pagoId, { trnRaw: { secreto: "trn" }, basicDataRaw: { secreto: "basic" } });
    });
    const extra = await esc.t.run(async (ctx) => {
      const persona = async (authId: string, roles: string[], condominioId = esc.condominioId) => {
        const userId = await ctx.db.insert("users", {
          name: authId,
          email: `${authId}@vekino.test`,
          emailVerified: true,
          active: true,
          authId,
          createdAt: AHORA,
          updatedAt: AHORA,
        });
        await ctx.db.insert("memberships", {
          userId,
          condominioId,
          roles: roles as never,
          isActive: true,
          createdAt: AHORA,
          updatedAt: AHORA,
        });
        return userId;
      };
      await persona("contadora", ["contadora"]);
      await persona("junta", ["junta_directiva"]);
      const otro = await ctx.db.insert("condominios", {
        name: "Otro conjunto",
        activeModules: [],
        isActive: true,
        createdAt: AHORA,
        updatedAt: AHORA,
      });
      await persona("adminOtro", ["administrador"], otro);
      return { otro };
    });
    return { esc, septiembre, pagoId, ...extra };
  }

  test("listPorFactura: dueña, administración y contadora sí; vecino, junta, otro conjunto y sin sesión no", async () => {
    const { esc, septiembre } = await conPago();
    const listar = (subject?: string) =>
      (subject ? esc.t.withIdentity({ subject }) : esc.t).query(api.pagos.listPorFactura, { facturaId: septiembre._id });
    for (const quien of ["residente", "admin", "contadora"]) {
      const pagos = await listar(quien);
      expect(pagos, quien).toHaveLength(1);
      expect(pagos[0]!.estado).toBe("aprobada");
      expect(Object.keys(pagos[0]!)).not.toContain("trnRaw");
      expect(Object.keys(pagos[0]!)).not.toContain("basicDataRaw");
    }
    for (const quien of ["vecino", "junta", "adminOtro", "guarda"]) {
      await expect(listar(quien), quien).rejects.toThrow();
    }
    await expect(listar()).rejects.toThrow();
  });

  test("un arrendatario con el contrato vencido ya no ve los pagos", async () => {
    const { esc, septiembre } = await conPago();
    await esc.t.run(async (ctx) => {
      const links = await ctx.db
        .query("usuarioUnidad")
        .withIndex("by_membership", (q) => q.eq("membershipId", esc.mResidente))
        .collect();
      for (const l of links) await ctx.db.patch(l._id, { vigenciaHasta: AHORA - 30 * DIA });
    });
    await expect(
      esc.como("residente").query(api.pagos.listPorFactura, { facturaId: septiembre._id }),
    ).rejects.toThrow();
  });

  test("verificarPago valida antes de hablar con el banco y nunca devuelve los datos crudos", async () => {
    const { esc, pagoId } = await conPago();
    await expect(esc.como("vecino").action(api.pagos.verificarPago, { pagoId })).rejects.toThrow();
    /* Aprobado: `consultarEstado` no vuelve a preguntar (estado final). */
    const pago = await esc.como("residente").action(api.pagos.verificarPago, { pagoId });
    expect(pago).toMatchObject({ _id: pagoId, estado: "aprobada", monto: 300_000 });
    expect(Object.keys(pago!)).not.toContain("trnRaw");
    expect(Object.keys(pago!)).not.toContain("basicDataRaw");
  });

  test("estadoPago y estadoPagoPorPmt: la misma regla, también para un pago sin usuario (el hueco de antes)", async () => {
    const { esc, pagoId } = await conPago();
    const pmt = await esc.t.run(async (ctx) => {
      await ctx.db.patch(pagoId, { userId: undefined });
      return (await ctx.db.get(pagoId))!.pmtAuthId!;
    });
    await expect(esc.como("vecino").query(api.pagos.estadoPago, { pagoId })).rejects.toThrow();
    expect(await esc.como("vecino").query(api.pagos.estadoPagoPorPmt, { pmtId: pmt })).toBeNull();
    expect(await esc.como("residente").query(api.pagos.estadoPago, { pagoId })).toMatchObject({ estado: "aprobada" });
    expect(await esc.como("admin").query(api.pagos.estadoPagoPorPmt, { pmtId: pmt })).toMatchObject({ estado: "aprobada" });
  });
});

// ─── Recaudo (F-19) ─────────────────────────────────────────────────────────

describe("F-19 · las dos cifras de recaudo", () => {
  test("según la contabilidad (con créditos y lo que no se puede calcular) y registrado en Vekino, por separado", async () => {
    const esc = await montar();
    await cargar(esc, [
      { periodo: "2026-08", lineas: [linea("CUOTA", 0, 300_000)] },
      { periodo: "2026-08", casa: "u202", lineas: [linea("CUOTA", 0, 300_000)] },
    ]);
    await cargar(esc, [
      /* 101 pagó 250.000 de agosto; 202 pagó 400.000 (100.000 a favor). */
      { periodo: "2026-09", lineas: [linea("CUOTA", 50_000, 300_000)] },
      { periodo: "2026-09", casa: "u202", lineas: [linea("SALDO A FAVOR", -100_000, 0), linea("CUOTA", 0, 300_000)] },
    ]);
    const septiembre = await facturaDe(esc, "2026-09");
    await aprobarPagoAval(esc, septiembre._id, 350_000);

    const agosto = await esc.como("admin").query(api.facturas.resumenPeriodo, {
      condominioId: esc.condominioId,
      periodo: "2026-08",
    });
    expect(agosto).toMatchObject({
      recaudoContable: 250_000 + 400_000,
      recaudoContableUnidades: 2,
      recaudoContableSinCalcular: { sinSiguiente: 0, mesFaltante: 0, enRevision: 0, noCuadra: 0 },
      recaudoVekino: 0,
    });
    const sept = await esc.como("admin").query(api.facturas.resumenPeriodo, {
      condominioId: esc.condominioId,
      periodo: "2026-09",
    });
    expect(sept).toMatchObject({
      recaudoContable: null,
      recaudoContableSinCalcular: { sinSiguiente: 2, mesFaltante: 0, enRevision: 0, noCuadra: 0 },
      recaudoVekino: 350_000,
      recaudoVekinoPagos: 1,
    });
    const serie = await esc.como("admin").query(api.facturas.serie, { condominioId: esc.condominioId });
    expect(serie.map((p) => [p.periodo, p.recaudoContable, p.recaudoVekino])).toEqual([
      ["2026-08", 650_000, 0],
      ["2026-09", null, 350_000],
    ]);
  });
});

// ─── Mora desde el 16 del mes siguiente (decisión B) ────────────────────────

describe("Mora B · el fin de mes es el plazo; la mora empieza el 16", () => {
  async function conOctubreNuevo() {
    const esc = await montar();
    const octubre: FacturaCarga = { periodo: "2026-10", lineas: [linea("CUOTA", 0, 300_000)] };
    await esc.como("admin").mutation(api.facturas.bulkUpsert, {
      facturas: [{ ...comoLaCargaPorPdf(esc, octubre), fechaVencimiento: vencimientoDePeriodo("2026-10") }],
      skipExisting: true,
    });
    return esc;
  }
  const cartera = async (esc: Escenario) =>
    (await esc.como("admin").query(api.facturas.carteraPorUnidad, { condominioId: esc.condominioId, unidadIds: [esc.u101] }))[0]!;
  const badges = async (esc: Escenario) =>
    (await esc.como("residente").query(api.portal.navBadges, { condominioId: esc.condominioId })).facturasVencidas;

  test("del 1 al 15 del mes siguiente no hay mora: es la ventana en que llega el PDF", async () => {
    const esc = await conOctubreNuevo();
    vi.setSystemTime(bogota("2026-11-01T09:00"));
    expect(await cartera(esc)).toMatchObject({ estado: "pendiente", diasMora: 0 });
    expect(await badges(esc)).toBe(0);
    vi.setSystemTime(bogota("2026-11-15T20:00"));
    expect((await cartera(esc)).estado).toBe("pendiente");
  });

  test("el 16 sí, con los días contados desde ahí y el plazo que se le mostró", async () => {
    const esc = await conOctubreNuevo();
    vi.setSystemTime(bogota("2026-11-18T09:00"));
    expect(await cartera(esc)).toMatchObject({
      estado: "en_mora",
      diasMora: 3,
      periodoEnMora: "2026-10",
      vencimientoEnMora: vencimientoDePeriodo("2026-10"),
    });
    expect(await badges(esc)).toBe(1);
  });
});

// ─── "Sin verificar" ────────────────────────────────────────────────────────

describe("Sin verificar · histórica pendiente que nadie pudo juzgar", () => {
  /** Junio y agosto, sin julio: el saldo anterior de agosto no juzga junio. */
  async function conHueco() {
    const esc = await montar();
    await cargar(esc, [{ periodo: "2026-06", lineas: [linea("CUOTA", 0, 300_000)] }]);
    await cargar(esc, [{ periodo: "2026-08", lineas: [linea("CUOTA", 300_000, 300_000)] }]);
    return esc;
  }

  test("la campana lo dice, y no 'su saldo pasó a la siguiente'", async () => {
    const esc = await conHueco();
    expect((await facturaDe(esc, "2026-06")).estado).toBe("pendiente");
    const { items } = await esc.como("residente").query(api.notificacionesFeed.feed, { condominioId: esc.condominioId });
    const junio = items.find((i) => i.tipo === "factura" && /junio/i.test(i.titulo));
    const agosto = items.find((i) => i.tipo === "factura" && /agosto/i.test(i.titulo));
    /* Agosto es la vigente y lo que se paga. El 8 de octubre la unidad está
     * en mora (desde el 16 de septiembre), así que se anuncia "Vencida", como
     * la ven la cartera y la tarjeta del residente (QA de comprobantes, H2;
     * antes decía solo "Por pagar"). */
    expect(agosto?.detalle).toMatch(/^Vencida · Por pagar \$ /);
    expect(junio?.detalle).toBe("Sin verificar · Falta el estado de cuenta del mes siguiente para saber si se pagó.");
  });

  test("Finanzas la ve 'Sin verificar' y el bot la nombra; el campo estado no cambia", async () => {
    const esc = await conHueco();
    const pagina = await esc.como("admin").query(api.facturas.listPage, {
      condominioId: esc.condominioId,
      periodo: "2026-06",
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(pagina.page.map((f) => [f.estado, f.estadoVisible])).toEqual([["pendiente", "sin_verificar"]]);
    const agosto = await esc.como("admin").query(api.facturas.listPage, {
      condominioId: esc.condominioId,
      periodo: "2026-08",
      paginationOpts: { numItems: 10, cursor: null },
    });
    /* Agosto, la vigente, no es "Sin verificar". Con la unidad en mora se ve
     * "vencida" aunque se guarde `pendiente` (QA de comprobantes, H2; antes
     * se veía "pendiente" mientras la cartera decía mora). */
    expect(agosto.page[0]!.estado).toBe("pendiente");
    expect(agosto.page[0]!.estadoVisible).toBe("vencida");
    const delBot = await esc.t.query(internal.soportesPago.sinVerificarDeUnidad, { unidadId: esc.u101 });
    expect(delBot.map((f) => f.periodo)).toEqual(["2026-06"]);
  });
});

// ─── Pasarela en QA ─────────────────────────────────────────────────────────

describe("Pasarela en QA · no toca a residentes reales", () => {
  async function conSeptiembre() {
    const esc = await montar();
    await cargar(esc, [{ periodo: "2026-09", lineas: [linea("CUOTA", 0, 300_000)] }]);
    return { esc, septiembre: await facturaDe(esc, "2026-09") };
  }

  test("con qa y sin lista de unidades de prueba: ninguna unidad, con el mensaje estable", async () => {
    const { esc, septiembre } = await conSeptiembre();
    entorno("AVAL_AMBIENTE", "qa");
    entorno("AVAL_UNIDADES_PRUEBA", undefined);
    expect(await aceptaPagar(datosDePagoBot(esc, septiembre._id))).toEqual({
      acepta: false,
      motivo: MENSAJE_PASARELA_DE_PRUEBAS,
    });
    expect(await esc.como("residente").query(api.pagos.puedePagar, { facturaId: septiembre._id })).toBe(false);
    /* La factura se sigue debiendo: "Ya pagué" y el portal del banco siguen disponibles. */
    expect(await esc.como("residente").query(api.pagos.opcionesDePago, { facturaId: septiembre._id })).toEqual({
      debe: true,
      pasarela: false,
      motivo: MENSAJE_PASARELA_DE_PRUEBAS,
    });
  });

  test("con qa, una unidad declarada de prueba sí; otra no", async () => {
    const { esc, septiembre } = await conSeptiembre();
    entorno("AVAL_AMBIENTE", "qa");
    entorno("AVAL_UNIDADES_PRUEBA", `${esc.u101}`);
    expect((await aceptaPagar(datosDePagoBot(esc, septiembre._id))).acepta).toBe(true);
    expect(await esc.como("residente").query(api.pagos.opcionesDePago, { facturaId: septiembre._id })).toEqual({
      debe: true,
      pasarela: true,
      motivo: null,
    });
    entorno("AVAL_UNIDADES_PRUEBA", `${esc.u202}`);
    expect((await aceptaPagar(datosDePagoBot(esc, septiembre._id))).acepta).toBe(false);
  });

  test("con prod se comporta como en la Fase 3", async () => {
    const { esc, septiembre } = await conSeptiembre();
    entorno("AVAL_AMBIENTE", "prod");
    entorno("AVAL_UNIDADES_PRUEBA", undefined);
    expect((await aceptaPagar(datosDePagoBot(esc, septiembre._id))).acepta).toBe(true);
    expect(await esc.como("residente").query(api.pagos.puedePagar, { facturaId: septiembre._id })).toBe(true);
  });

  test("una histórica no se debe, en ningún ambiente", async () => {
    const esc = await montar();
    await cargar(esc, [{ periodo: "2026-08", lineas: [linea("CUOTA", 0, 300_000)] }]);
    await cargar(esc, [{ periodo: "2026-09", lineas: [linea("CUOTA", 300_000, 300_000)] }]);
    entorno("AVAL_AMBIENTE", "qa");
    const agosto = await facturaDe(esc, "2026-08");
    expect(await esc.como("residente").query(api.pagos.opcionesDePago, { facturaId: agosto._id })).toMatchObject({
      debe: false,
      pasarela: false,
    });
  });
});

// ─── Versión mínima del móvil y número de factura ───────────────────────────

describe("Versión mínima del móvil", () => {
  test("sin configuración no bloquea a nadie; con ella, a las versiones anteriores", async () => {
    const esc = await montar();
    entorno("MOVIL_VERSION_MINIMA", undefined);
    expect(await esc.t.query(api.appMovil.versionMinima, { version: "1.0.0", plataforma: "ios" })).toMatchObject({
      debeActualizar: false,
    });
    entorno("MOVIL_VERSION_MINIMA", "1.1.0");
    expect(await esc.t.query(api.appMovil.versionMinima, { version: "1.0.0", plataforma: "android" })).toMatchObject({
      debeActualizar: true,
      versionMinima: "1.1.0",
    });
    expect(await esc.t.query(api.appMovil.versionMinima, { version: "1.1.0", plataforma: "android" })).toMatchObject({
      debeActualizar: false,
    });
  });
});

describe("F-17 · número de factura", () => {
  test("volver a cargar el mismo período con 'actualizar' no le cambia el número a la factura", async () => {
    const esc = await montar();
    const sept: FacturaCarga = { periodo: "2026-09", lineas: [linea("CUOTA", 0, 300_000)] };
    await esc.como("admin").mutation(api.facturas.bulkUpsert, {
      facturas: [{ ...comoLaCargaPorPdf(esc, sept), numeroFactura: "FAC-2026-09-101" }],
      skipExisting: true,
    });
    await esc.como("admin").mutation(api.facturas.bulkUpsert, {
      facturas: [{ ...comoLaCargaPorPdf(esc, { ...sept, lineas: [linea("CUOTA", 0, 310_000)] }), numeroFactura: "FAC-2026-09-0007" }],
      skipExisting: false,
    });
    const f = await facturaDe(esc, "2026-09");
    expect(f.numeroFactura).toBe("FAC-2026-09-101");
    expect(f.totalAPagar).toBe(310_000);
  });
});
