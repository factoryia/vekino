import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  alcanceCubre,
  alcanceEnCompania,
  type AlcanceEnCompania,
} from "./model/acceso";
import {
  alcanzaAlGuarda,
  exigirAlcanceSobreGuarda,
  exigirGuardaActivo,
  guardasElegibles as elegibles,
  lectorDeNombres,
} from "./model/alcanceGuarda";
import { bloqueSemanalValidator } from "./model/roles";
import { diaColombia } from "./lib/incidenteMetricas";
import { rangoDeConsulta } from "./lib/inasistencias";
import {
  chocanHorarios,
  cruzaRango,
  estadoHorario,
  rigeEl,
  ultimoDiaEfectivo,
  validarBloques,
  validarUltimoDia,
  validarVigencia,
} from "./lib/horariosGuarda";

/**
 * Horario permanente de los guardas: registrar, consultar y finalizar.
 *
 * PLANIFICACIÓN, nada más. Ninguna puerta lo mira —ni `requireCondominioRole`
 * ni `resolverAcceso` saben que existe— y nada de aquí escribe en
 * asignaciones, membresías, contratos, turnos ni inasistencias. Si un guarda
 * trabaja fuera de lo planificado, el sistema no lo bloquea: este módulo solo
 * dice qué estaba planificado.
 *
 * Quién puede: la capacidad `seguridad.horarios` con el alcance de
 * `model/alcanceGuarda.ts`, el mismo de las inasistencias. Además, el
 * supervisor solo planifica en los conjuntos que supervisa: puede ver todo el
 * horario de un guarda suyo —también lo que hace en otro conjunto, que es
 * justo lo que necesita para planificar—, pero no registrar ni finalizar un
 * horario de un conjunto que no supervisa.
 */

const CAPACIDAD = "seguridad.horarios" as const;

type Ctx = QueryCtx | MutationCtx;

function exigirAlcance(
  ctx: Ctx,
  companiaId: Id<"companiasSeguridad">,
  userId: Id<"users">,
): Promise<AlcanceEnCompania> {
  return exigirAlcanceSobreGuarda(ctx, companiaId, userId, CAPACIDAD);
}

/** El supervisor no planifica en un conjunto que no supervisa. */
function exigirConjuntoEnAlcance(
  alcance: AlcanceEnCompania,
  condominioId: Id<"condominios"> | undefined,
): void {
  if (condominioId != null && !alcanceCubre(alcance, [condominioId])) {
    throw new Error(`No tiene permiso para esta operación (${CAPACIDAD}).`);
  }
}

function hoyColombia(): string {
  return diaColombia(Date.now());
}

/** Todos los del guarda en la compañía, por fecha de inicio. */
async function delGuarda(
  ctx: Ctx,
  companiaId: Id<"companiasSeguridad">,
  userId: Id<"users">,
): Promise<Doc<"horariosGuarda">[]> {
  return await ctx.db
    .query("horariosGuarda")
    .withIndex("by_compania_user", (q) =>
      q.eq("companiaId", companiaId).eq("userId", userId),
    )
    .collect();
}

/** Lo que se pinta: la fila, los nombres y el estado derivado de las fechas. */
async function hidratar(ctx: Ctx, filas: readonly Doc<"horariosGuarda">[]) {
  const nombre = lectorDeNombres(ctx);
  const ahora = Date.now();
  return await Promise.all(
    filas.map(async (h) => {
      const condo = h.condominioId ? await ctx.db.get(h.condominioId) : null;
      return {
        _id: h._id,
        companiaId: h.companiaId,
        userId: h.userId,
        guardaNombre: await nombre(h.userId),
        condominioId: h.condominioId ?? null,
        condominioNombre: h.condominioId
          ? (condo?.name ?? "(conjunto eliminado)")
          : null,
        fechaInicio: h.fechaInicio,
        fechaFin: h.fechaFin ?? null,
        terminaEl: h.terminaEl ?? null,
        /** El último día en que rige de verdad; null = indefinido. */
        ultimoDia: ultimoDiaEfectivo(h) ?? null,
        bloques: h.bloques,
        estado: estadoHorario(h, ahora),
        creadoPorNombre: await nombre(h.creadoPorUserId),
        createdAt: h.createdAt,
        terminadoEn: h.terminadoEn ?? null,
        terminadoPorNombre: h.terminadoPorUserId
          ? await nombre(h.terminadoPorUserId)
          : null,
      };
    }),
  );
}

// ─────────────────────────────────────────────────────────────
// Escritura
// ─────────────────────────────────────────────────────────────

/**
 * Registra un horario.
 *
 * Choque: no puede haber dos horarios del mismo guarda PARA EL MISMO
 * CONJUNTO —o los dos generales— que lo planifiquen en el mismo momento.
 * Entre conjuntos distintos no se rechaza: el modelo ya admite que un guarda
 * esté asignado a dos porterías, y decidir que nunca puede estar planificado
 * en dos a la vez es una regla de disponibilidad, que es la fase siguiente.
 * Un general frente a uno de conjunto tampoco se rechaza, por lo mismo.
 */
export const crear = mutation({
  args: {
    companiaId: v.id("companiasSeguridad"),
    userId: v.id("users"),
    condominioId: v.optional(v.id("condominios")),
    /* Fechas civiles; las lee el servidor en hora de Colombia. */
    fechaInicio: v.string(),
    fechaFin: v.optional(v.string()),
    bloques: v.array(bloqueSemanalValidator),
  },
  handler: async (ctx, args) => {
    const alcance = await exigirAlcance(ctx, args.companiaId, args.userId);
    exigirConjuntoEnAlcance(alcance, args.condominioId);
    await exigirGuardaActivo(
      ctx,
      args.companiaId,
      args.userId,
      "Solo se registran horarios de guardas.",
    );

    /* El conjunto tiene que ser uno con el que la compañía tiene o tuvo
     * contrato: un horario no inventa una relación que no existe. Su vigencia
     * no depende de la del contrato —son cosas independientes—. */
    if (args.condominioId != null) {
      const condo = await ctx.db.get(args.condominioId);
      if (!condo) throw new Error("Conjunto no encontrado.");
      const contrato = await ctx.db
        .query("companiaContratos")
        .withIndex("by_condominio_compania", (q) =>
          q.eq("condominioId", args.condominioId!).eq("companiaId", args.companiaId),
        )
        .first();
      if (!contrato) {
        throw new Error("La compañía no tiene contrato con ese conjunto.");
      }
    }

    validarVigencia(args.fechaInicio, args.fechaFin);
    const bloques = validarBloques(args.bloques);

    const nuevo = { fechaInicio: args.fechaInicio, fechaFin: args.fechaFin, bloques };
    const mismoConjunto = (await delGuarda(ctx, args.companiaId, args.userId)).filter(
      (h) => (h.condominioId ?? null) === (args.condominioId ?? null),
    );
    if (mismoConjunto.some((h) => chocanHorarios(nuevo, h))) {
      throw new Error(
        args.condominioId == null
          ? "Ese guarda ya tiene un horario general que se cruza con estos bloques en esas fechas. Finalízalo o ajusta la vigencia."
          : "Ese guarda ya tiene un horario en ese conjunto que se cruza con estos bloques en esas fechas. Finalízalo o ajusta la vigencia.",
      );
    }

    return await ctx.db.insert("horariosGuarda", {
      companiaId: args.companiaId,
      userId: args.userId,
      condominioId: args.condominioId,
      fechaInicio: args.fechaInicio,
      fechaFin: args.fechaFin,
      bloques,
      creadoPorUserId: alcance.user._id,
      createdAt: Date.now(),
    });
  },
});

/**
 * Finaliza un horario: rige hasta `ultimoDia` incluido y después ya no. No
 * se borra ni se cambia lo que se planificó: queda el rastro de cuándo se
 * cortó y quién lo hizo.
 *
 * Repetir la petición no reescribe el corte, igual que terminar un contrato.
 */
export const finalizar = mutation({
  args: {
    horarioId: v.id("horariosGuarda"),
    /** Último día en que rige. No puede ser anterior a ayer. */
    ultimoDia: v.string(),
  },
  handler: async (ctx, args) => {
    const horario = await ctx.db.get(args.horarioId);
    if (!horario) throw new Error("Horario no encontrado.");
    const alcance = await exigirAlcance(ctx, horario.companiaId, horario.userId);
    exigirConjuntoEnAlcance(alcance, horario.condominioId);

    if (horario.terminaEl != null) {
      return { ok: true as const, yaEstaba: true as const };
    }
    if (estadoHorario(horario) === "terminado") {
      throw new Error("Ese horario ya terminó: no hay nada que finalizar.");
    }
    validarUltimoDia(horario, args.ultimoDia, hoyColombia());

    await ctx.db.patch(horario._id, {
      terminaEl: args.ultimoDia,
      terminadoEn: Date.now(),
      terminadoPorUserId: alcance.user._id,
    });
    return { ok: true as const, yaEstaba: false as const };
  },
});

// ─────────────────────────────────────────────────────────────
// Lectura
// ─────────────────────────────────────────────────────────────

/**
 * Los horarios que rigen para un guarda en una fecha (hoy, si no se dice).
 *
 * Puede ser más de uno —uno por conjunto, o uno general— y puede no haber
 * ninguno, que significa "sin información", no "libre".
 */
export const vigentesDeGuarda = query({
  args: {
    companiaId: v.id("companiasSeguridad"),
    userId: v.id("users"),
    fecha: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await exigirAlcance(ctx, args.companiaId, args.userId);
    const fecha = args.fecha ?? hoyColombia();
    validarVigencia(fecha);
    const filas = await delGuarda(ctx, args.companiaId, args.userId);
    return await hidratar(
      ctx,
      filas.filter((h) => rigeEl(h, fecha)),
    );
  },
});

/** Todo lo planificado para un guarda, terminados incluidos, lo más reciente primero. */
export const historialDeGuarda = query({
  args: {
    companiaId: v.id("companiasSeguridad"),
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    await exigirAlcance(ctx, args.companiaId, args.userId);
    const filas = await delGuarda(ctx, args.companiaId, args.userId);
    const orden = [...filas].sort(
      (a, b) =>
        b.fechaInicio.localeCompare(a.fechaInicio) || b.createdAt - a.createdAt,
    );
    return await hidratar(ctx, orden);
  },
});

/**
 * Los horarios de la compañía cuya vigencia se cruza con un rango de fechas
 * civiles (las dos incluidas).
 *
 * El supervisor solo ve los de los guardas a los que alcanza.
 */
export const deCompaniaEnRango = query({
  args: {
    companiaId: v.id("companiasSeguridad"),
    desde: v.string(),
    hasta: v.string(),
  },
  handler: async (ctx, args) => {
    const alcance = await alcanceEnCompania(ctx, args.companiaId, CAPACIDAD);
    rangoDeConsulta(args.desde, args.hasta);

    const filas = (
      await ctx.db
        .query("horariosGuarda")
        .withIndex("by_compania", (q) =>
          q.eq("companiaId", args.companiaId).lte("fechaInicio", args.hasta),
        )
        .collect()
    ).filter((h) => cruzaRango(h, args.desde, args.hasta));

    const alcanza = new Map<Id<"users">, boolean>();
    for (const userId of new Set(filas.map((h) => h.userId))) {
      alcanza.set(userId, await alcanzaAlGuarda(ctx, alcance, args.companiaId, userId));
    }
    const visibles = await hidratar(
      ctx,
      filas.filter((h) => alcanza.get(h.userId)),
    );
    return visibles.sort(
      (a, b) =>
        a.guardaNombre.localeCompare(b.guardaNombre, "es") ||
        a.fechaInicio.localeCompare(b.fechaInicio),
    );
  },
});

/** Un horario concreto, o null si no existe. */
export const detalle = query({
  args: { horarioId: v.id("horariosGuarda") },
  handler: async (ctx, args) => {
    const horario = await ctx.db.get(args.horarioId);
    if (!horario) return null;
    await exigirAlcance(ctx, horario.companiaId, horario.userId);
    const [hidratado] = await hidratar(ctx, [horario]);
    return hidratado!;
  },
});

/** A quién se le puede registrar un horario: el desplegable del formulario. */
export const guardasElegibles = query({
  args: { companiaId: v.id("companiasSeguridad") },
  handler: async (ctx, args) => await elegibles(ctx, args.companiaId, CAPACIDAD),
});
