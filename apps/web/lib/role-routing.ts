/**
 * Destino de inicio de un usuario dentro de un condominio, según sus roles.
 *
 * - administrador / contadora → panel de administración (`/condominio/:id`).
 * - guardia → app de portería (`/guardia/:id`).
 * - resto (propietario, arrendatario, residente, junta_directiva…) → portal
 *   personal (`/mi/:id`). La junta ve Consejo como sección extra del portal.
 */
export function homeHrefForRoles(condominioId: string, roles: string[]): string {
  const canAdmin = roles.some((r) =>
    ["administrador", "contadora"].includes(r),
  );
  if (canAdmin) return `/condominio/${condominioId}`;
  if (roles.includes("guardia")) return `/guardia/${condominioId}`;
  return `/mi/${condominioId}`;
}

/** Roles que abren el shell de administración del condominio. */
export const CONDO_ADMIN_ROLES = ["administrador", "contadora"] as const;

/** Roles de operación con shell propio (portería). */
export function isGuardiaOnly(roles: string[]): boolean {
  const canAdmin = roles.some((r) =>
    (CONDO_ADMIN_ROLES as readonly string[]).includes(r),
  );
  return !canAdmin && roles.includes("guardia");
}

/**
 * Destino de quien llega por el eje de vigilancia (una compañía, no el
 * conjunto). No tiene membresía, así que `homeHrefForRoles` no le aplica.
 *
 * - guardia → la misma app de portería que el guarda propio del conjunto.
 * - supervisor → su panel, que es transversal a varios conjuntos y por eso no
 *   lleva id en la ruta.
 */
export function homeHrefForAsignacion(
  condominioId: string,
  rol: "guardia" | "supervisor",
): string {
  return rol === "supervisor" ? "/vigilancia" : `/guardia/${condominioId}`;
}

/**
 * Destino de quien pertenece a una COMPAÑÍA de vigilancia, por su rol en ella.
 *
 * El tercer eje: ni membresía en un conjunto ni asignación a una portería,
 * sino pertenecer a la empresa. Un usuario de compañía tiene un solo rol —lo
 * garantiza `exigirRolUnicoCompania` en el backend—, así que aquí no hay nada
 * que desempatar: un rol, un destino.
 *
 * `null` para el guarda a propósito. Su experiencia es la portería de un
 * conjunto concreto, y sin asignación no hay conjunto al que llevarlo; su
 * destino sale de `homeHrefForAsignacion`, no de aquí. Devolver "/vigilancia"
 * lo mandaría a un panel que su rol no abre, y el shell lo rebotaría a
 * /dashboard en un bucle.
 */
export function homeHrefForCompania(
  rol: string | undefined,
  _companiaId: string,
): string | null {
  if (rol === "admin_compania") return "/vigilancia/inicio";
  if (rol === "supervisor") return "/vigilancia";
  return null;
}
