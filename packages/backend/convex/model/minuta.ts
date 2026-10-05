import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { coberturaQueAmpara } from "./cobertura";

export type MinutaModulo =
  | "visitantes"
  | "paqueteria"
  | "reservas"
  | "novedades"
  | "minuta";

/** Turno de guardia abierto del condominio (máximo uno a la vez), o null. */
export async function turnoAbierto(
  ctx: QueryCtx | MutationCtx,
  condominioId: Id<"condominios">,
): Promise<Doc<"guardiaTurnos"> | null> {
  return await ctx.db
    .query("guardiaTurnos")
    .withIndex("by_condominio_estado", (q) =>
      q.eq("condominioId", condominioId).eq("estado", "abierto"),
    )
    .first();
}

/**
 * Ronda en curso del condominio (maximo una a la vez), o null.
 *
 * Se consulta por indice y no recorriendo el turno: cada evento de porteria
 * pasa por aqui, y esto tiene que costar lo mismo con diez rondas que con
 * diez mil.
 */
export async function rondaEnCurso(
  ctx: QueryCtx | MutationCtx,
  condominioId: Id<"condominios">,
): Promise<Doc<"guardiaRondas"> | null> {
  return await ctx.db
    .query("guardiaRondas")
    .withIndex("by_condominio_estado", (q) =>
      q.eq("condominioId", condominioId).eq("estado", "en_curso"),
    )
    .first();
}

/**
 * Registra un evento en la minuta digital (append-only).
 *
 * Réplica de la regla transversal de VekinoApi: casi toda acción de portería
 * genera automáticamente su entrada de minuta, sellada con el actor y ligada
 * al turno abierto si existe.
 */
export async function logMinuta(
  ctx: MutationCtx,
  args: {
    condominioId: Id<"condominios">;
    modulo: MinutaModulo;
    tipo: string;
    unidad: string;
    resumen: string;
    estado?: "abierto" | "cerrado";
    actorUserId?: Id<"users">;
    actorNombre: string;
    turnoId?: Id<"guardiaTurnos">;
  },
): Promise<void> {
  const turnoId =
    args.turnoId ?? (await turnoAbierto(ctx, args.condominioId))?._id;
  /* La ronda se engancha sola. La especificacion pide que cada registro
   * quede asociado a la ronda activa, y este es el unico sitio por donde
   * pasan todos: pedirselo a cada mutacion garantizaria que alguna se
   * olvidara. */
  const rondaId = (await rondaEnCurso(ctx, args.condominioId))?._id;
  /* El contexto del ACTOR, no el del turno: el turno es de la portería y
   * puede haberlo abierto otro guarda. Igual que la ronda, se sella aquí para
   * que ninguna mutación se olvide. Sin actor no hay de quién sellarlo. */
  const coberturaId = args.actorUserId
    ? await coberturaQueAmpara(ctx, args.actorUserId, args.condominioId)
    : null;
  await ctx.db.insert("minutaEventos", {
    condominioId: args.condominioId,
    turnoId,
    rondaId,
    modulo: args.modulo,
    tipo: args.tipo,
    unidad: args.unidad,
    resumen: args.resumen,
    estado: args.estado ?? "cerrado",
    actorUserId: args.actorUserId,
    actorNombre: args.actorNombre,
    ...(coberturaId ? { coberturaId } : {}),
    createdAt: Date.now(),
  });
}
