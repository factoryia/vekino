import type { QueryCtx, MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import {
  viasDeAsignacionDelConjunto,
  viasDeAsignacionEn,
  type ViaAsignacion,
} from "./asignacion";

type Ctx = QueryCtx | MutationCtx;

/**
 * LAS VÍAS POR LAS QUE UNA PERSONA LLEGA A UN CONJUNTO.
 *
 * Hoy son dos, y las dos son pertenencia PERMANENTE:
 *
 *   membership  → el eje residencial (`memberships`): residentes,
 *                 administración y el guarda propio del conjunto.
 *   asignacion  → el eje de seguridad (`asignaciones`): el guarda o el
 *                 supervisor de una compañía con contrato vigente.
 *
 * Una persona puede tener las dos en el mismo conjunto, y asignaciones en
 * varios conjuntos a la vez. Por eso aquí nada devuelve "la" vía: se
 * devuelven todas las que valen, cada una con su procedencia (`tipo`), y qué
 * hacer con ellas —sumar capacidades, exigir un rol, preferir una— es
 * política de quien pregunta, no un segundo criterio.
 *
 * Cada vía tiene UN criterio y vive en un solo sitio:
 *
 *   membership  → la fila está activa (aquí, `viaDeMembership`);
 *   asignacion  → asignación vigente → contrato vigente → compañía activa
 *                 → miembro activo → conjunto activo (`model/asignacion.ts`).
 *
 * El conjunto activo es eslabón de la asignación y NO de la membresía: es la
 * regla de que un conjunto inactivo no se opera por una asignación que siga
 * en la base. La vía residencial no lo mira, como no lo miró nunca.
 *
 * Lo que todavía NO existe:
 *   - una vía temporal (la cobertura). Será una entidad propia, no una fila
 *     de `asignaciones`, y entrará aquí como un `tipo` más de `Via`. Solo
 *     podrá cubrir quien en su compañía es guarda (`companiaMiembros.roles`
 *     = ["guardia"]): el supervisor NO es elegible. Que `asignaciones.rol`
 *     diga que un supervisor puede cubrir un turno como guarda es otro asunto
 *     sin resolver y no sirve para ampliar la cobertura;
 *   - un "contexto operativo". Cuando haga falta se DERIVA de estas vías
 *     —permanentes, luego temporales, luego la precedencia entre ellas— en
 *     `viasEnConjunto`, que es por donde ya preguntan `resolverAcceso` y la
 *     sesión. No se guarda en ninguna tabla: sería una segunda fuente de
 *     verdad que habría que mantener al día.
 */

/** Una membresía que da acceso: la fila existe y está activa. */
export type ViaMembership = {
  tipo: "membership";
  userId: Id<"users">;
  condominioId: Id<"condominios">;
  roles: Doc<"memberships">["roles"];
  membership: Doc<"memberships">;
};

export type Via = ViaMembership | ViaAsignacion;

/**
 * El criterio de la vía residencial: la membresía está activa.
 *
 * No mira roles. Cada operación pide los suyos, y una membresía activa sin el
 * rol pedido sigue siendo pertenencia: es lo que distingue "no pertenece a
 * este condominio" de "no tiene el rol requerido".
 */
export function viaDeMembership(
  m: Doc<"memberships"> | null,
): ViaMembership | null {
  if (!m || !m.isActive) return null;
  return {
    tipo: "membership",
    userId: m.userId,
    condominioId: m.condominioId,
    roles: m.roles,
    membership: m,
  };
}

/** La fila de membresía del usuario en un condominio (o null), activa o no. */
export async function getMembership(
  ctx: Ctx,
  userId: Id<"users">,
  condominioId: Id<"condominios">,
): Promise<Doc<"memberships"> | null> {
  return await ctx.db
    .query("memberships")
    .withIndex("by_condominio_user", (q) =>
      q.eq("condominioId", condominioId).eq("userId", userId),
    )
    .unique();
}

/**
 * La membresía de una persona en un conjunto, y la vía que da.
 *
 * Devuelve también la fila cruda porque varios consumidores la exponen tal
 * cual, inactiva incluida —`requireCondominioRole` la devuelve y
 * `asignaciones.miAcceso` enseña sus roles—, y cambiar eso no es parte de
 * resolver vías.
 */
export async function membershipEn(
  ctx: Ctx,
  userId: Id<"users">,
  condominioId: Id<"condominios">,
): Promise<{ membership: Doc<"memberships"> | null; via: ViaMembership | null }> {
  const membership = await getMembership(ctx, userId, condominioId);
  return { membership, via: viaDeMembership(membership) };
}

/** Las membresías que dan acceso a una persona, en cualquier conjunto. */
export async function viasDeMembershipDe(
  ctx: Ctx,
  userId: Id<"users">,
): Promise<ViaMembership[]> {
  const filas = await ctx.db
    .query("memberships")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  return filas
    .map(viaDeMembership)
    .filter((v): v is ViaMembership => v !== null);
}

/**
 * TODAS las vías de una persona en un conjunto, en este instante.
 *
 * Primero la membresía (como mucho una: el índice es único por conjunto y
 * usuario) y después las asignaciones, en el orden del índice.
 */
export async function viasEnConjunto(
  ctx: Ctx,
  userId: Id<"users">,
  condominioId: Id<"condominios">,
  ahora: number = Date.now(),
): Promise<{ membership: Doc<"memberships"> | null; vias: Via[] }> {
  const [{ membership, via }, asignaciones] = await Promise.all([
    membershipEn(ctx, userId, condominioId),
    viasDeAsignacionEn(ctx, userId, condominioId, ahora),
  ]);
  return { membership, vias: via ? [via, ...asignaciones] : asignaciones };
}

/**
 * Las vías de GUARDA que dan acceso hoy a un conjunto, de cualquier persona.
 *
 * Responde "¿quién puede ser guarda en ESTE conjunto?" con el mismo criterio
 * con el que la portería deja pasar: membresía activa con el rol `guardia`, o
 * asignación de guarda que pasa la cadena entera. Cada fila de asignación se
 * juzga por sí misma; que la persona tenga OTRA asignación viva aquí con otro
 * rol no cuenta.
 */
export async function viasDeGuardiaDelConjunto(
  ctx: Ctx,
  condominioId: Id<"condominios">,
  ahora: number = Date.now(),
): Promise<Via[]> {
  const [memberships, asignaciones] = await Promise.all([
    ctx.db
      .query("memberships")
      .withIndex("by_condominio", (q) => q.eq("condominioId", condominioId))
      .collect(),
    viasDeAsignacionDelConjunto(ctx, condominioId, "guardia", ahora),
  ]);
  const porMembresia = memberships
    .map(viaDeMembership)
    .filter((v): v is ViaMembership => v?.roles.includes("guardia") === true);
  return [...porMembresia, ...asignaciones];
}

/**
 * La primera vía de un tipo, o null.
 *
 * Para los consumidores que, como hasta ahora, operan con una sola vía de
 * cada clase: la membresía es única por conjunto, y con la regla 3 de
 * `asignaciones.crear` también lo es la asignación viva.
 */
export function primeraVia<T extends Via["tipo"]>(
  vias: readonly Via[],
  tipo: T,
): Extract<Via, { tipo: T }> | null {
  return (
    (vias.find((v) => v.tipo === tipo) as Extract<Via, { tipo: T }> | undefined) ??
    null
  );
}
