import type { QueryCtx, MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { estaActiva, ventanaQueOcupa } from "../lib/coberturas";
import type { CoberturaQueOcupa } from "../lib/disponibilidad";

type Ctx = QueryCtx | MutationCtx;

/**
 * Las coberturas de un guarda leídas para dos preguntas que no son de acceso:
 * qué lo ocupa (disponibilidad) y cuáles están activas ahora.
 *
 * Ninguna de las dos da acceso a nada en esta fase: una cobertura aceptada es
 * un compromiso confirmado, no una vía. Las reglas viven en
 * `lib/coberturas.ts`; aquí solo se leen las filas.
 */

async function deEstado(
  ctx: Ctx,
  userId: Id<"users">,
  estado: Doc<"coberturas">["estado"],
  antesDe: number,
): Promise<Doc<"coberturas">[]> {
  return await ctx.db
    .query("coberturas")
    .withIndex("by_user_estado", (q) =>
      q.eq("userId", userId).eq("estado", estado).lt("inicio", antesDe),
    )
    .collect();
}

/**
 * Lo que ya ocupa al guarda, en cualquier conjunto y compañía, entre las
 * coberturas que empiezan antes de `antesDe`. Una aceptada lo ocupa entera;
 * una inhabilitada, hasta su corte.
 */
export async function coberturasQueOcupan(
  ctx: Ctx,
  userId: Id<"users">,
  antesDe: number,
): Promise<CoberturaQueOcupa[]> {
  const [aceptadas, inhabilitadas] = await Promise.all([
    deEstado(ctx, userId, "aceptada", antesDe),
    deEstado(ctx, userId, "inhabilitada", antesDe),
  ]);
  return [...aceptadas, ...inhabilitadas].flatMap((c) => {
    const ventana = ventanaQueOcupa(c);
    return ventana ? [{ id: c._id, condominioId: c.condominioId, ...ventana }] : [];
  });
}

/**
 * Las coberturas activas de un guarda: aceptadas y con `ahora` dentro de su
 * ventana. Derivado al leer, nunca guardado.
 */
export async function coberturasActivasDe(
  ctx: Ctx,
  userId: Id<"users">,
  ahora: number,
): Promise<Doc<"coberturas">[]> {
  const aceptadas = await deEstado(ctx, userId, "aceptada", ahora + 1);
  return aceptadas.filter((c) => estaActiva(c, ahora));
}
