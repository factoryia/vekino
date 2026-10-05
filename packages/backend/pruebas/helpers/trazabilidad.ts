import { convexTest } from "convex-test";
import betterAuthTest from "@convex-dev/better-auth/test";
import schema from "../../convex/schema";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";

/**
 * El escenario de la trazabilidad de coberturas (Fase 11).
 *
 * Una compañía, tres conjuntos y el reloj de un día cualquiera:
 *
 *   jason  → guarda de Andina asignado a Alamos (A). Es quien cubre.
 *   bruno  → guarda de Andina asignado a Bosque (B).
 *   sofia  → supervisora de Andina en Alamos.
 *   sergio → supervisor de Andina en Bosque y Cedros (C).
 *   alicia → administradora de Andina.
 *
 * Solo usa funciones que ya existían antes de la fase, para que la prueba de
 * regresión pueda correr también contra el código anterior.
 */

export const modules = import.meta.glob("../../convex/**/*.ts");

export const MIN = 60 * 1000;
export const HORA = 60 * MIN;
export const DIA = 24 * HORA;
/** 10/10/2026 17:00, hora de Colombia. */
export const T17 = Date.parse("2026-10-10T17:00:00-05:00");
export const CHECKLIST = [
  { item: "Radio", obligatorio: true, cantidadEsperada: 1, cantidadEncontrada: 1, estadoOk: true },
];
export const CIERRE = {
  recibe: "Relevo de la noche",
  consignas: "Sin pendientes.",
  observacionesCierre: "Turno sin novedad.",
  novedadesElementos: false,
};

export async function montar() {
  const t = convexTest(schema, modules);
  betterAuthTest.register(t);
  const desde = T17 - 60 * DIA;

  const ids = await t.run(async (ctx) => {
    const usuario = (authId: string, name: string, extra = {}) =>
      ctx.db.insert("users", {
        name,
        email: `${authId}@vekino.test`,
        emailVerified: true,
        active: true,
        authId,
        createdAt: T17,
        updatedAt: T17,
        ...extra,
      });
    const conjunto = (name: string) =>
      ctx.db.insert("condominios", {
        name,
        activeModules: [],
        isActive: true,
        createdAt: T17,
        updatedAt: T17,
      });

    const superadmin = await usuario("super", "Super", { platformRole: "superadmin" as const });
    const alamos = await conjunto("Conjunto Alamos");
    const bosque = await conjunto("Conjunto Bosque");
    const cedros = await conjunto("Conjunto Cedros");
    const andina = await ctx.db.insert("companiasSeguridad", {
      nombre: "Seguridad Andina",
      estado: "activa",
      createdAt: T17,
      updatedAt: T17,
    });

    const contrato = (condominioId: Id<"condominios">) =>
      ctx.db.insert("companiaContratos", {
        companiaId: andina,
        condominioId,
        vigenciaDesde: desde,
        creadoPorUserId: superadmin,
        createdAt: T17,
        updatedAt: T17,
      });
    const kAlamos = await contrato(alamos);
    const kBosque = await contrato(bosque);
    const kCedros = await contrato(cedros);

    const miembro = (userId: Id<"users">, rol: "guardia" | "supervisor" | "admin_compania") =>
      ctx.db.insert("companiaMiembros", {
        userId,
        companiaId: andina,
        roles: [rol],
        isActive: true,
        createdAt: T17,
        updatedAt: T17,
      });
    const asignacion = (
      contratoId: Id<"companiaContratos">,
      condominioId: Id<"condominios">,
      userId: Id<"users">,
      companiaMiembroId: Id<"companiaMiembros">,
      rol: "guardia" | "supervisor" = "guardia",
    ) =>
      ctx.db.insert("asignaciones", {
        contratoId,
        companiaMiembroId,
        userId,
        condominioId,
        companiaId: andina,
        rol,
        vigenciaDesde: desde,
        creadoPorUserId: superadmin,
        createdAt: T17,
      });

    const alicia = await usuario("alicia", "Alicia Admin");
    await miembro(alicia, "admin_compania");

    const jason = await usuario("jason", "Jason Valderrama");
    await asignacion(kAlamos, alamos, jason, await miembro(jason, "guardia"));

    const bruno = await usuario("bruno", "Bruno Bosque");
    await asignacion(kBosque, bosque, bruno, await miembro(bruno, "guardia"));

    const sofia = await usuario("sofia", "Sofia Supervisora");
    await asignacion(kAlamos, alamos, sofia, await miembro(sofia, "supervisor"), "supervisor");

    const sergio = await usuario("sergio", "Sergio Supervisor");
    const mSergio = await miembro(sergio, "supervisor");
    await asignacion(kBosque, bosque, sergio, mSergio, "supervisor");
    await asignacion(kCedros, cedros, sergio, mSergio, "supervisor");

    return {
      alamos, bosque, cedros, andina,
      kAlamos, kBosque, kCedros,
      alicia, jason, bruno, sofia, sergio,
    };
  });

  const como = (authId: string) => t.withIdentity({ subject: authId });

  /** Una cobertura ya aceptada de Jason, insertada tal cual. */
  const cubrir = (
    condominioId: Id<"condominios">,
    contratoId: Id<"companiaContratos">,
    inicio: number,
    fin: number,
    extra: Partial<Doc<"coberturas">> = {},
  ) =>
    t.run((ctx) =>
      ctx.db.insert("coberturas", {
        companiaId: ids.andina,
        userId: ids.jason,
        condominioId,
        contratoId,
        inicio,
        fin,
        estado: "aceptada",
        solicitadoPorUserId: ids.alicia,
        solicitadoEn: inicio - DIA,
        respuesta: "aceptada",
        respondidoEn: inicio - DIA,
        respondidoPorUserId: ids.jason,
        ...extra,
      }),
    );

  /** Un elemento de Andina ya asignado a un conjunto. */
  const itemEn = async (condominioId: Id<"condominios">, nombre: string) => {
    const itemId = await como("alicia").mutation(api.inventario.crear, {
      companiaId: ids.andina,
      nombre,
    });
    await como("alicia").mutation(api.inventarioAsignaciones.asignar, { itemId, condominioId });
    return itemId;
  };

  /**
   * Lo que hace un guarda en una portería durante su turno: abrirlo, una
   * ronda completa, una ronda del registro antiguo (la del móvil), una
   * anotación, una novedad y un aporte. Devuelve los ids para mirarlos.
   */
  const jornada = async (authId: string, condominioId: Id<"condominios">) => {
    const g = como(authId);
    const turnoId = await g.mutation(api.guardia.iniciarTurno, { condominioId, checklist: CHECKLIST });
    const { rondaId } = await g.mutation(api.rondas.iniciar, { condominioId, zona: "Perímetro" });
    await g.mutation(api.rondas.finalizar, { rondaId, observaciones: "Sin novedad." });
    await g.mutation(api.guardia.registrarRonda, { condominioId, zonaNombre: "Parqueadero", fotos: [] });
    await g.mutation(api.guardia.registrarEventoMinuta, {
      condominioId,
      tipo: "Anotación",
      resumen: `Anotación de ${authId}.`,
    });
    const novedadId = await g.mutation(api.guardia.reportarNovedad, {
      condominioId,
      titulo: "Luz dañada",
      descripcion: "La luz de la entrada no prende.",
      prioridad: "baja",
    });
    await g.mutation(api.guardia.reportarNovedad, {
      condominioId,
      tipoReporte: "aporte_voluntario",
      titulo: "Aporte",
      descripcion: "Vehículo sin aporte.",
      prioridad: "media",
    });
    return { turnoId, rondaId, novedadId };
  };

  return { t, ...ids, como, cubrir, itemEn, jornada };
}

export type Escenario = Awaited<ReturnType<typeof montar>>;
