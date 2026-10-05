import type { QueryCtx, MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { OperationalRole, PlatformRole } from "./roles";
import { asignacionVigente } from "./asignacion";
import { getMembership, membershipEn } from "./vias";

/* La lectura de la membresía vive con las demás vías en `model/vias.ts`. Se
 * reexporta porque casi cuarenta módulos la importan desde aquí. */
export { getMembership };

type Ctx = QueryCtx | MutationCtx;

/**
 * Devuelve el perfil de aplicación (tabla `users`) del usuario autenticado,
 * o null si no hay sesión / no existe perfil todavía.
 *
 * El enlace con Better Auth se hace por `users.authId === identity.subject`.
 */
export async function getCurrentAppUser(ctx: Ctx): Promise<Doc<"users"> | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;

  return await ctx.db
    .query("users")
    .withIndex("by_authId", (q) => q.eq("authId", identity.subject))
    .unique();
}

/** Igual que getCurrentAppUser pero lanza si no hay usuario. */
export async function requireAppUser(ctx: Ctx): Promise<Doc<"users">> {
  const user = await getCurrentAppUser(ctx);
  if (!user) throw new Error("No autenticado o perfil inexistente.");
  if (!user.active) throw new Error("Usuario inactivo.");
  return user;
}

export function hasPlatformRole(
  user: Doc<"users">,
  ...roles: PlatformRole[]
): boolean {
  return !!user.platformRole && roles.includes(user.platformRole);
}

export function isSuperadmin(user: Doc<"users">): boolean {
  return user.platformRole === "superadmin";
}

/** Exige superadmin (control maestro total). */
export async function requireSuperadmin(ctx: Ctx): Promise<Doc<"users">> {
  const user = await requireAppUser(ctx);
  if (!isSuperadmin(user)) throw new Error("Requiere rol superadmin.");
  return user;
}

/** Exige staff de plataforma (superadmin o admin). */
export async function requirePlatformStaff(ctx: Ctx): Promise<Doc<"users">> {
  const user = await requireAppUser(ctx);
  if (!hasPlatformRole(user, "superadmin", "admin")) {
    throw new Error("Requiere rol de plataforma (admin/superadmin).");
  }
  return user;
}

/**
 * Unidades vinculadas al usuario dentro de un condominio.
 *
 * Base de las APIs "mías" (reservas, vehículos, comprobantes de pago): el
 * propietario solo puede leer y escribir sobre sus propias unidades.
 */
/**
 * Deja solo los vínculos vigentes hoy.
 *
 * Un margen de un día al final: el contrato que vence "el 31" cubre el 31
 * completo, no hasta las 00:00 de ese día.
 */
export function vigentes<T extends { vigenciaDesde?: number; vigenciaHasta?: number }>(
  links: T[],
): T[] {
  const ahora = Date.now();
  const FIN_DEL_DIA = 24 * 60 * 60 * 1000;
  return links.filter(
    (l) =>
      (l.vigenciaDesde == null || l.vigenciaDesde <= ahora) &&
      (l.vigenciaHasta == null || ahora < l.vigenciaHasta + FIN_DEL_DIA),
  );
}

export async function misUnidadIds(
  ctx: Ctx,
  userId: Id<"users">,
  condominioId: Id<"condominios">,
): Promise<Set<Id<"unidades">>> {
  const membership = await getMembership(ctx, userId, condominioId);
  if (!membership || !membership.isActive) return new Set();
  const links = await ctx.db
    .query("usuarioUnidad")
    .withIndex("by_membership", (q) => q.eq("membershipId", membership._id))
    .collect();
  /* Los vínculos vencidos no cuentan. Un arrendatario que ya se fue no debe
   * seguir viendo las facturas ni los visitantes de esa casa, y como TODO el
   * acceso del residente pasa por aquí, cortarlo en este punto lo corta en
   * todas partes a la vez. Ver `vigenciaHasta` en el schema. */
  return new Set(vigentes(links).map((l) => l.unidadId));
}

/**
 * Exige que el usuario actual pertenezca al condominio con al menos uno de los
 * roles indicados. Superadmin/admin de plataforma tienen paso libre.
 *
 * Pregunta por las vías de `model/vias.ts` en orden y se detiene en la
 * primera que basta: un residente no paga la lectura de asignaciones en cada
 * llamada. El resultado es el mismo que pedirlas todas de golpe.
 */
export async function requireCondominioRole(
  ctx: Ctx,
  condominioId: Id<"condominios">,
  roles: OperationalRole[],
): Promise<{ user: Doc<"users">; membership: Doc<"memberships"> | null }> {
  const user = await requireAppUser(ctx);
  const { membership, via: porMembresia } = await membershipEn(
    ctx,
    user._id,
    condominioId,
  );

  // Control maestro: la plataforma puede operar sobre cualquier condominio.
  if (hasPlatformRole(user, "superadmin", "admin")) {
    return { user, membership };
  }

  if (
    porMembresia &&
    (roles.length === 0 || porMembresia.roles.some((r) => roles.includes(r)))
  ) {
    return { user, membership };
  }

  /* SEGUNDA VÍA: el guarda que llega por una compañía de vigilancia.
   *
   * No tiene fila en `memberships` —no es del conjunto, es de la empresa que
   * lo cubre— así que por la vía de arriba no pasaba nunca y su asignación no
   * le servía para nada: entraba a Vekino y la portería le rebotaba. Es el
   * mismo trato que el guarda propio del conjunto, tal como lo declara
   * `POR_ROL_ASIGNACION` en lib/vigilancia.ts, y por eso se resuelve aquí y
   * no en ciento noventa llamadas.
   *
   * Solo cuando la operación admite explícitamente a un `guardia`. Con
   * `roles: []` —que significa "cualquier miembro del conjunto": votar en
   * asamblea, otorgar un poder— NO pasa: el personal de una empresa
   * contratada no es parte de la comunidad, y esa puerta debe seguir cerrada.
   *
   * `asignacionVigente` comprueba la cadena entera (asignación, contrato,
   * compañía activa, miembro no dado de baja), así que el acceso se corta
   * solo el día que cualquiera de esos eslabones caduque. */
  if (roles.includes("guardia" as OperationalRole)) {
    const via = await asignacionVigente(ctx, user._id, condominioId);
    if (via && via.rol === "guardia") return { user, membership };
  }

  if (!porMembresia) {
    throw new Error("No pertenece a este condominio.");
  }
  throw new Error("No tiene el rol requerido en este condominio.");
}
