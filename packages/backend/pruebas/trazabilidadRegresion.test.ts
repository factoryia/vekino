import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../convex/_generated/api";
import { CIERRE, MIN, T17, montar, type Escenario } from "./helpers/trazabilidad";

/**
 * FASE 11: SIN COBERTURA, EL HISTÓRICO SE LEE IGUAL QUE ANTES.
 *
 * Una instantánea de todas las lecturas históricas que la fase toca —turnos,
 * rondas, minuta, novedades, la custodia del inventario, la operación de la
 * compañía y el historial de una persona— con un día de operación normal y
 * ninguna cobertura. Se generó con el código ANTERIOR a la fase (el árbol en
 * el commit de partida) y esta prueba la compara con el de ahora: si alguna
 * respuesta cambia, falla.
 *
 * Solo usa funciones que ya existían antes. El reloj está fijo y los ids de
 * convex-test son un contador, así que todo lo que sale es determinista.
 */

let e: Escenario;
beforeEach(async () => {
  vi.setSystemTime(T17);
  e = await montar();
});
afterEach(() => vi.useRealTimers());

describe("Fase 11: sin cobertura, el histórico no cambia", () => {
  test("instantánea de turnos, rondas, minuta, novedades, inventario, operación e historial", async () => {
    const radio = await e.itemEn(e.alamos, "Radio de Alamos");

    const deJason = await e.jornada("jason", e.alamos);
    await e.jornada("bruno", e.bosque);

    vi.setSystemTime(T17 + 10 * MIN);
    await e.como("sofia").mutation(api.inventarioGuardas.entregar, { itemId: radio, guardaUserId: e.jason });
    await e.como("sofia").mutation(api.inventarioGuardas.registrarNovedad, {
      itemId: radio,
      descripcion: "Antena floja.",
    });
    vi.setSystemTime(T17 + 20 * MIN);
    await e.como("sofia").mutation(api.inventarioGuardas.recibir, { itemId: radio });
    await e.como("jason").mutation(api.guardia.cerrarTurno, { turnoId: deJason.turnoId, ...CIERRE });

    const sofia = e.como("sofia");
    const salida = {
      turnos: await sofia.query(api.guardia.listTurnos, { condominioId: e.alamos }),
      turno: await sofia.query(api.guardia.getTurno, { turnoId: deJason.turnoId }),
      rondas: await sofia.query(api.rondas.listar, { condominioId: e.alamos }),
      ronda: await sofia.query(api.rondas.detalle, { rondaId: deJason.rondaId }),
      minuta: await sofia.query(api.guardia.listMinuta, { condominioId: e.alamos }),
      novedades: await e.como("jason").query(api.guardia.listNovedadReportes, { condominioId: e.alamos }),
      custodia: await sofia.query(api.inventarioGuardas.historialDeItem, { itemId: radio }),
      inventarioConjunto: await sofia.query(api.inventarioGuardas.itemsDelCondominio, {
        condominioId: e.alamos,
      }),
      elemento: await e.como("alicia").query(api.inventario.detalle, { itemId: radio }),
      operacion: await e.como("alicia").query(api.companias.operacion, {
        desde: "2026-10-10",
        hasta: "2026-10-10",
        granularidad: "dia",
      }),
      operacionDeJason: await e.como("alicia").query(api.companias.operacion, {
        desde: "2026-10-10",
        hasta: "2026-10-10",
        guardiaUserId: e.jason,
        granularidad: "dia",
      }),
      historialDeJason: await e.como("alicia").query(api.asignaciones.historialDePersona, {
        userId: e.jason,
      }),
      historialDeJasonEn: await e.como("alicia").query(api.asignaciones.historialDePersona, {
        userId: e.jason,
        en: T17,
      }),
    };

    expect(salida).toMatchSnapshot();
  });
});
