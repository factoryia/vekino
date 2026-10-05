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
 * Si a quien está en la portería le toca el recordatorio de cierre de turno.
 *
 * A `/guardia/:id` entra todo el que tiene `porteria.operar`, y eso incluye a
 * la administración y a la junta: estar en la ruta no dice que sea guarda. Se
 * responde con los mismos criterios que ya lo mandan a la portería —
 * `isGuardiaOnly` para el guarda del conjunto y la asignación `guardia` para
 * el de compañía (`homeHrefForAsignacion`)—, sin una lista de roles nueva.
 *
 * Cualquier rol de administración pesa más que una asignación, y el staff de
 * plataforma y el supervisor quedan fuera aunque además figuren como guarda.
 */
export function recibeRecordatorioCierre({
  esPlataforma,
  rolesConjunto,
  rolesAsignacion,
}: {
  esPlataforma: boolean;
  /** Roles de la membresía en ESTE conjunto (vacío si no tiene). */
  rolesConjunto: string[];
  /** Roles de sus asignaciones vigentes en ESTE conjunto. */
  rolesAsignacion: string[];
}): boolean {
  if (esPlataforma) return false;
  if (rolesConjunto.some((r) => (CONDO_ADMIN_ROLES as readonly string[]).includes(r))) {
    return false;
  }
  if (rolesAsignacion.includes("supervisor")) return false;
  return isGuardiaOnly(rolesConjunto) || rolesAsignacion.includes("guardia");
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

/**
 * La sesión tal como se OPERA hoy, según el contexto que resolvió el servidor
 * (`users.me` → `contextoOperativoGuardia`).
 *
 * Con una cobertura activa —o con el contexto bloqueado— las vías de guarda de
 * siempre quedan suspendidas: las asignaciones de guarda no se ofrecen, y las
 * membresías pierden el rol `guardia` (y desaparecen si no tenían otro). Es la
 * misma regla que aplica el backend (`aplicarContexto` en `model/vias.ts`), y
 * aquí solo sirve para rutear y pintar: no decide si la cobertura está activa
 * —eso viene en `tipo`— ni deja pasar a nadie, porque cada consulta y cada
 * mutación lo vuelve a resolver en el servidor. Las listas originales siguen
 * en `me` sin tocar: a ellas vuelve el guarda cuando la cobertura termina.
 */
export function sesionOperativa<
  M extends { roles: string[] },
  A extends { rol: string },
>(me: {
  memberships: M[];
  asignaciones: A[];
  contextoOperativoGuardia: { tipo: "permanente" | "cobertura" | "bloqueado" };
}): { memberships: M[]; asignaciones: A[] } {
  if (me.contextoOperativoGuardia.tipo === "permanente") {
    return { memberships: me.memberships, asignaciones: me.asignaciones };
  }
  return {
    memberships: me.memberships.flatMap((m) => {
      if (!m.roles.includes("guardia")) return [m];
      const roles = m.roles.filter((r) => r !== "guardia");
      return roles.length > 0 ? [{ ...m, roles }] : [];
    }),
    asignaciones: me.asignaciones.filter((a) => a.rol !== "guardia"),
  };
}
