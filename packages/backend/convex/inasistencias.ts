import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  alcanceCubre,
  alcanceEnCompania,
  type AlcanceEnCompania,
} from "./model/acceso";
import { viasDeAsignacionDe } from "./model/asignacion";
import {
  rolPrincipalDeCompania,
  tipoInasistenciaValidator,
} from "./model/roles";
import { displayNameFromUser } from "./model/displayName";
import {
  pisaAlguna,
  rangoDeConsulta,
  validarMotivo,
  ventanaInasistencia,
} from "./lib/inasistencias";

/**
 * Inasistencias de los guardas de una compañía: registrar, consultar, anular.
 *
 * Es información de PLANIFICACIÓN. Nada de aquí escribe en asignaciones,
 * membresías, contratos ni turnos, y ni `requireCondominioRole` ni
 * `resolverAcceso` saben que existe: un guarda incapacitado sigue pudiendo
 * entrar y cerrar el turno que tenga abierto.
 *
 * Quién puede, con la capacidad `seguridad.inasistencias` y el alcance de
 * `alcanceEnCompania` —el mismo de los contratos—:
 *   - plataforma y `admin_compania`: todos los guardas de la compañía;
 *   - `supervisor`: los guardas que HOY trabajan en alguno de los conjuntos
 *     que supervisa;
 *   - el guarda: nada todavía.
 */

const CAPACIDAD = "seguridad.inasistencias" as const;

type Ctx = QueryCtx | MutationCtx;

/**
 * Dónde trabaja hoy esta persona para esta compañía.
 *
 * Sale de las vías de asignación (la cadena entera), no de las filas crudas:
 * un supervisor alcanza a quien de verdad está hoy en sus conjuntos.
 */
async function conjuntosDelGuarda(
  ctx: Ctx,
  companiaId: Id<"companiasSeguridad">,
  userId: Id<"users">,
): Promise<Id<"condominios">[]> {
  const vias = await viasDeAsignacionDe(ctx, userId);
  return vias
    .filter((via) => via.companiaId === companiaId)
    .map((via) => via.condominioId);
}

async function alcanzaAlGuarda(
  ctx: Ctx,
  alcance: AlcanceEnCompania,
  companiaId: Id<"companiasSeguridad">,
  userId: Id<"users">,
): Promise<boolean> {
  if (alcance.conjuntos === null) return true;
  return alcanceCubre(alcance, await conjuntosDelGuarda(ctx, companiaId, userId));
}

/**
 * Exige que quien pregunta alcance a este guarda dentro de la compañía.
 *
 * El alcance se comprueba ANTES que la persona: a un supervisor no se le
 * confirma si alguien de fuera de sus conjuntos pertenece o no a la empresa.
 */
async function exigirAlcanceSobreGuarda(
  ctx: Ctx,
  companiaId: Id<"companiasSeguridad">,
  userId: Id<"users">,
): Promise<AlcanceEnCompania> {
  const alcance = await alcanceEnCompania(ctx, companiaId, CAPACIDAD);
  if (!(await alcanzaAlGuarda(ctx, alcance, companiaId, userId))) {
    throw new Error(`No tiene permiso para esta operación (${CAPACIDAD}).`);
  }
  return alcance;
}

/**
 * El guarda al que se le registra: miembro de la compañía, de alta y guarda.
 *
 * No depende de que tenga una asignación hoy: la inasistencia es de la
 * persona dentro de su compañía, no de un conjunto.
 */
async function exigirGuardaActivo(
  ctx: Ctx,
  companiaId: Id<"companiasSeguridad">,
  userId: Id<"users">,
): Promise<Doc<"companiaMiembros">> {
  const filas = await ctx.db
    .query("companiaMiembros")
    .withIndex("by_compania_user", (q) =>
      q.eq("companiaId", companiaId).eq("userId", userId),
    )
    .collect();
  if (filas.length === 0) {
    throw new Error("Esa persona no pertenece a la compañía.");
  }
  const miembro = filas.find((m) => m.isActive);
  if (!miembro) {
    throw new Error("Esa persona está dada de baja en la compañía.");
  }
  if (rolPrincipalDeCompania(miembro.roles) !== "guardia") {
    throw new Error("Solo se registran inasistencias de guardas.");
  }
  return miembro;
}

/** Todas las del guarda en la compañía, por fecha de inicio. */
async function delGuarda(
  ctx: Ctx,
  companiaId: Id<"companiasSeguridad">,
  userId: Id<"users">,
): Promise<Doc<"inasistencias">[]> {
  return await ctx.db
    .query("inasistencias")
    .withIndex("by_compania_user", (q) =>
      q.eq("companiaId", companiaId).eq("userId", userId),
    )
    .collect();
}

/** Lo que se pinta: la fila con los nombres resueltos. */
async function hidratar(
  ctx: Ctx,
  filas: readonly Doc<"inasistencias">[],
) {
  const nombres = new Map<Id<"users">, Promise<string>>();
  const nombre = (id: Id<"users">) => {
    if (!nombres.has(id)) {
      nombres.set(
        id,
        ctx.db.get(id).then((u) => (u ? displayNameFromUser(u) : "(perfil eliminado)")),
      );
    }
    return nombres.get(id)!;
  };
  return await Promise.all(
    filas.map(async (i) => ({
      _id: i._id,
      companiaId: i.companiaId,
      userId: i.userId,
      guardaNombre: await nombre(i.userId),
      tipo: i.tipo,
      motivo: i.motivo ?? null,
      inicio: i.inicio,
      fin: i.fin,
      diaCompleto: i.diaCompleto,
      fechaInicio: i.fechaInicio ?? null,
      fechaFin: i.fechaFin ?? null,
      estado: i.estado,
      registradaPorNombre: await nombre(i.registradaPorUserId),
      createdAt: i.createdAt,
      anuladaEn: i.anuladaEn ?? null,
      anuladaPorNombre: i.anuladaPorUserId ? await nombre(i.anuladaPorUserId) : null,
    })),
  );
}

// ─────────────────────────────────────────────────────────────
// Escritura
// ─────────────────────────────────────────────────────────────

/**
 * Registra una inasistencia.
 *
 * Rechaza cruzarse con otra ACTIVA del mismo guarda, total o parcialmente:
 * dos registros superpuestos no dicen nada que uno no diga, y decidir cuál
 * manda sería inventar una regla. Es el mismo criterio de las asignaciones y
 * las reservas. Si hay que cambiar una ventana, se anula y se registra otra.
 */
export const crear = mutation({
  args: {
    companiaId: v.id("companiasSeguridad"),
    userId: v.id("users"),
    tipo: tipoInasistenciaValidator,
    motivo: v.optional(v.string()),
    /* Texto de pared, no milisegundos: lo interpreta el servidor en hora de
     * Colombia (`lib/inasistencias.ts`). */
    ventana: v.union(
      v.object({
        diaCompleto: v.literal(true),
        fechaInicio: v.string(),
        fechaFin: v.string(),
      }),
      v.object({
        diaCompleto: v.literal(false),
        inicioLocal: v.string(),
        finLocal: v.string(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const { user } = await exigirAlcanceSobreGuarda(ctx, args.companiaId, args.userId);
    await exigirGuardaActivo(ctx, args.companiaId, args.userId);

    const motivo = validarMotivo(args.tipo, args.motivo);
    const ventana = ventanaInasistencia(args.ventana);

    const activas = (await delGuarda(ctx, args.companiaId, args.userId)).filter(
      (i) => i.estado === "activa",
    );
    if (pisaAlguna(ventana, activas)) {
      throw new Error(
        "Ese guarda ya tiene una inasistencia activa que se cruza con esas fechas. Anúlala o ajusta la ventana.",
      );
    }

    return await ctx.db.insert("inasistencias", {
      companiaId: args.companiaId,
      userId: args.userId,
      tipo: args.tipo,
      motivo,
      inicio: ventana.inicio,
      fin: ventana.fin,
      diaCompleto: ventana.diaCompleto,
      fechaInicio: ventana.fechaInicio,
      fechaFin: ventana.fechaFin,
      estado: "activa",
      registradaPorUserId: user._id,
      createdAt: Date.now(),
    });
  },
});

/**
 * Anula una inasistencia. No la borra: deja de contar como indisponibilidad
 * y conserva quién la anuló y cuándo.
 *
 * Repetir la petición no reescribe quién la anuló, igual que
 * `asignaciones.terminar`.
 */
export const anular = mutation({
  args: { inasistenciaId: v.id("inasistencias") },
  handler: async (ctx, args) => {
    const inasistencia = await ctx.db.get(args.inasistenciaId);
    if (!inasistencia) throw new Error("Inasistencia no encontrada.");
    const { user } = await exigirAlcanceSobreGuarda(
      ctx,
      inasistencia.companiaId,
      inasistencia.userId,
    );
    if (inasistencia.estado === "anulada") {
      return { ok: true as const, yaEstaba: true as const };
    }
    await ctx.db.patch(inasistencia._id, {
      estado: "anulada",
      anuladaEn: Date.now(),
      anuladaPorUserId: user._id,
    });
    return { ok: true as const, yaEstaba: false as const };
  },
});

// ─────────────────────────────────────────────────────────────
// Lectura
// ─────────────────────────────────────────────────────────────

/** Las inasistencias activas (no anuladas) de un guarda, por fecha. */
export const activasDeGuarda = query({
  args: {
    companiaId: v.id("companiasSeguridad"),
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    await exigirAlcanceSobreGuarda(ctx, args.companiaId, args.userId);
    const filas = await delGuarda(ctx, args.companiaId, args.userId);
    return await hidratar(
      ctx,
      filas.filter((i) => i.estado === "activa"),
    );
  },
});

/** Todo lo registrado de un guarda, anuladas incluidas, lo más reciente primero. */
export const historialDeGuarda = query({
  args: {
    companiaId: v.id("companiasSeguridad"),
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    await exigirAlcanceSobreGuarda(ctx, args.companiaId, args.userId);
    const filas = await delGuarda(ctx, args.companiaId, args.userId);
    return await hidratar(ctx, [...filas].reverse());
  },
});

/**
 * Las inasistencias activas de los guardas de la compañía que se cruzan con
 * un rango de fechas civiles (ambas incluidas).
 *
 * El supervisor solo ve las de los guardas a los que alcanza, con el mismo
 * criterio que al registrarlas.
 */
export const deCompaniaEnRango = query({
  args: {
    companiaId: v.id("companiasSeguridad"),
    desde: v.string(),
    hasta: v.string(),
  },
  handler: async (ctx, args) => {
    const alcance = await alcanceEnCompania(ctx, args.companiaId, CAPACIDAD);
    const rango = rangoDeConsulta(args.desde, args.hasta);

    const filas = (
      await ctx.db
        .query("inasistencias")
        .withIndex("by_compania_estado_fin", (q) =>
          q
            .eq("companiaId", args.companiaId)
            .eq("estado", "activa")
            .gt("fin", rango.desde),
        )
        .collect()
    ).filter((i) => i.inicio < rango.hasta);

    const alcanza = new Map<Id<"users">, boolean>();
    for (const userId of new Set(filas.map((i) => i.userId))) {
      alcanza.set(userId, await alcanzaAlGuarda(ctx, alcance, args.companiaId, userId));
    }
    const visibles = filas
      .filter((i) => alcanza.get(i.userId))
      .sort((a, b) => a.inicio - b.inicio);
    return await hidratar(ctx, visibles);
  },
});

/** Una inasistencia concreta, o null si no existe. */
export const detalle = query({
  args: { inasistenciaId: v.id("inasistencias") },
  handler: async (ctx, args) => {
    const inasistencia = await ctx.db.get(args.inasistenciaId);
    if (!inasistencia) return null;
    await exigirAlcanceSobreGuarda(ctx, inasistencia.companiaId, inasistencia.userId);
    const [hidratada] = await hidratar(ctx, [inasistencia]);
    return hidratada!;
  },
});

/**
 * A quién se le puede registrar: los guardas de alta de la compañía a los que
 * alcanza quien pregunta. Es el desplegable del formulario; el servidor
 * vuelve a comprobar todo al registrar.
 */
export const guardasElegibles = query({
  args: { companiaId: v.id("companiasSeguridad") },
  handler: async (ctx, args) => {
    const alcance = await alcanceEnCompania(ctx, args.companiaId, CAPACIDAD);
    const miembros = (
      await ctx.db
        .query("companiaMiembros")
        .withIndex("by_compania", (q) => q.eq("companiaId", args.companiaId))
        .collect()
    ).filter((m) => m.isActive && rolPrincipalDeCompania(m.roles) === "guardia");

    const salida: { userId: Id<"users">; nombre: string }[] = [];
    for (const m of miembros) {
      if (!(await alcanzaAlGuarda(ctx, alcance, args.companiaId, m.userId))) continue;
      const u = await ctx.db.get(m.userId);
      if (!u) continue;
      salida.push({ userId: m.userId, nombre: displayNameFromUser(u) });
    }
    return salida.sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
  },
});
