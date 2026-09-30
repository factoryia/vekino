import type { QueryCtx, MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { hasPlatformRole, requireAppUser } from "./authz";
import { asignacionVigente } from "./asignacion";
import { contratoVigente, getCompaniaMiembro } from "./acceso";
import { capacidadesDeRolAsignacion, capacidadesDeRolesCompania, type Capacidad } from "../lib/vigilancia";

type Ctx = QueryCtx | MutationCtx;
export type RolAccesoIncidente = "plataforma" | "admin_compania" | "supervisor" | "guardia";

/** Verifica ambos tenants y la cadena vigente, sin sumar la membresía residencial. */
export async function exigirAccesoIncidente(
  ctx: Ctx,
  companiaId: Id<"companiasSeguridad">,
  condominioId: Id<"condominios">,
  capacidad: Extract<Capacidad, `incidentes.${string}`>,
): Promise<{ user: Doc<"users">; rol: RolAccesoIncidente }> {
  const user = await requireAppUser(ctx);
  const compania = await ctx.db.get(companiaId);
  const condominio = await ctx.db.get(condominioId);
  if (!compania || !condominio) throw new Error("Compañía o conjunto no encontrado.");

  // El staff mantiene lectura/gestión maestra; crear exige una compañía propia.
  if (capacidad !== "incidentes.crear" && hasPlatformRole(user, "superadmin", "admin")) {
    return { user, rol: "plataforma" };
  }

  const miembro = await getCompaniaMiembro(ctx, user._id);
  if (!miembro || miembro.companiaId !== companiaId) {
    throw new Error("No pertenece a la compañía del incidente.");
  }
  if (compania.estado !== "activa") throw new Error("La compañía no está activa.");
  if (!condominio.isActive && capacidad !== "incidentes.ver") {
    throw new Error("El conjunto no está activo.");
  }
  // El admin conserva lectura del histórico de su propia empresa después del contrato.
  // Toda escritura nueva o transición sí exige que el par siga contratado.
  if (capacidad === "incidentes.ver" && capacidadesDeRolesCompania(miembro.roles).has(capacidad)) {
    return { user, rol: "admin_compania" };
  }
  if (!condominio.isActive) throw new Error("El conjunto no está activo.");
  if (!(await contratoVigente(ctx, companiaId, condominioId, Date.now()))) {
    throw new Error("La compañía no tiene contrato vigente con este conjunto.");
  }
  if (capacidadesDeRolesCompania(miembro.roles).has(capacidad)) {
    return { user, rol: "admin_compania" };
  }
  const via = await asignacionVigente(ctx, user._id, condominioId);
  if (!via || via.asignacion.companiaId !== companiaId || !capacidadesDeRolAsignacion(via.asignacion.rol).has(capacidad)) {
    throw new Error(`No tiene permiso para esta operación (${capacidad}).`);
  }
  return { user, rol: via.asignacion.rol };
}

/** Para ID de caso: los tenants siempre salen del documento almacenado. */
export async function exigirIncidente(
  ctx: Ctx,
  incidenteId: Id<"incidentes">,
  capacidad: Extract<Capacidad, `incidentes.${string}`>,
): Promise<{ incidente: Doc<"incidentes">; user: Doc<"users">; rol: RolAccesoIncidente }> {
  const incidente = await ctx.db.get(incidenteId);
  if (!incidente) throw new Error("Incidente no encontrado.");
  const acceso = await exigirAccesoIncidente(ctx, incidente.companiaId, incidente.condominioId, capacidad);
  if (acceso.rol === "guardia" && incidente.reportadoPorUserId !== acceso.user._id) {
    throw new Error("No tiene acceso a este incidente.");
  }
  return { incidente, ...acceso };
}

/** La UI consulta permisos con la misma cadena que vuelve a exigir cada mutación. */
export async function permisosIncidente(ctx: Ctx, incidente: Doc<"incidentes">, rol: RolAccesoIncidente) {
  const permite = async (capacidad: "incidentes.gestionar" | "incidentes.cerrar") => {
    if (incidente.estado === "CERRADO") return false;
    try {
      await exigirAccesoIncidente(ctx, incidente.companiaId, incidente.condominioId, capacidad);
      return true;
    } catch { return false; }
  };
  const gestionar = await permite("incidentes.gestionar");
  return { gestionar, cerrar: await permite("incidentes.cerrar"), agregarPersona: incidente.estado !== "CERRADO" && (rol === "guardia" || gestionar) };
}

/** Reglas preexistentes de selección; también se usan para ofrecer candidatos. */
export async function exigirResponsableIncidente(ctx: Ctx, incidente: Doc<"incidentes">, userId: Id<"users">) {
  const responsable = await ctx.db.get(userId);
  const miembro = await getCompaniaMiembro(ctx, userId);
  if (!responsable?.active || !miembro || miembro.companiaId !== incidente.companiaId) {
    throw new Error("El responsable debe ser miembro activo de la misma compañía.");
  }
  if (miembro.roles.includes("supervisor")) {
    const via = await asignacionVigente(ctx, responsable._id, incidente.condominioId);
    if (!via || via.asignacion.companiaId !== incidente.companiaId || via.asignacion.rol !== "supervisor") {
      throw new Error("El supervisor no está asignado a este conjunto.");
    }
  } else if (!miembro.roles.includes("admin_compania")) {
    throw new Error("El responsable debe ser administrador o supervisor.");
  }
  return responsable;
}
