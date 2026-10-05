import type { QueryCtx, MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { alcanceCubre, alcanceEnCompania, type AlcanceEnCompania } from "./acceso";
import { viasDeAsignacionDe } from "./asignacion";
import { rolPrincipalDeCompania } from "./roles";
import { displayNameFromUser } from "./displayName";
import type { Capacidad } from "../lib/vigilancia";

type Ctx = QueryCtx | MutationCtx;

/**
 * QUIÉN ALCANZA A QUÉ GUARDA, PARA LA PLANIFICACIÓN DE LA COMPAÑÍA.
 *
 * Lo comparten las inasistencias y los horarios: los dos son planificación
 * del personal de guarda y los dos siguen la misma regla, así que vive aquí y
 * no copiado en cada módulo.
 *
 *   - plataforma y `admin_compania`: todos los guardas de la compañía;
 *   - `supervisor`: los guardas que HOY trabajan en alguno de los conjuntos
 *     que supervisa (`alcanceEnCompania`, la cadena entera);
 *   - el guarda: nada.
 *
 * La capacidad la pone cada módulo; el alcance no cambia. Quien combina datos
 * de varios módulos —la disponibilidad junta horarios e inasistencias— pide
 * TODAS sus capacidades y alcanza solo a quien alcanzaría con cada una: no
 * puede servir para ver lo que por separado no se vería.
 */

/** Una capacidad o varias que hay que tener todas. */
export type Capacidades = Capacidad | readonly Capacidad[];

function lista(capacidades: Capacidades): readonly Capacidad[] {
  return typeof capacidades === "string" ? [capacidades] : capacidades;
}

/**
 * El alcance con todas las capacidades a la vez: la intersección.
 *
 * Con una sola es exactamente `alcanceEnCompania`. Lanza con el error de la
 * primera capacidad que falte.
 */
export async function alcanceConTodas(
  ctx: Ctx,
  companiaId: Id<"companiasSeguridad">,
  capacidades: Capacidades,
): Promise<AlcanceEnCompania> {
  const alcances: AlcanceEnCompania[] = [];
  for (const capacidad of lista(capacidades)) {
    alcances.push(await alcanceEnCompania(ctx, companiaId, capacidad));
  }
  const [primero, ...resto] = alcances;
  if (!primero) throw new Error("Falta la capacidad que se exige.");

  let conjuntos: Set<Id<"condominios">> | null = primero.conjuntos;
  for (const { conjuntos: otros } of resto) {
    if (otros === null) continue;
    conjuntos = conjuntos === null ? otros : new Set([...conjuntos].filter((c) => otros.has(c)));
  }
  return { ...primero, conjuntos };
}

/**
 * Dónde trabaja hoy esta persona para esta compañía.
 *
 * Sale de las vías de asignación (la cadena entera), no de las filas crudas:
 * un supervisor alcanza a quien de verdad está hoy en sus conjuntos.
 */
export async function conjuntosDelGuarda(
  ctx: Ctx,
  companiaId: Id<"companiasSeguridad">,
  userId: Id<"users">,
): Promise<Id<"condominios">[]> {
  const vias = await viasDeAsignacionDe(ctx, userId);
  return vias
    .filter((via) => via.companiaId === companiaId)
    .map((via) => via.condominioId);
}

export async function alcanzaAlGuarda(
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
export async function exigirAlcanceSobreGuarda(
  ctx: Ctx,
  companiaId: Id<"companiasSeguridad">,
  userId: Id<"users">,
  capacidades: Capacidades,
): Promise<AlcanceEnCompania> {
  const alcance = await alcanceConTodas(ctx, companiaId, capacidades);
  if (!(await alcanzaAlGuarda(ctx, alcance, companiaId, userId))) {
    throw new Error(`No tiene permiso para esta operación (${lista(capacidades).join(", ")}).`);
  }
  return alcance;
}

/**
 * El guarda al que se le registra algo: miembro de la compañía, de alta y
 * guarda.
 *
 * No depende de que tenga una asignación hoy: lo que se le registra es de la
 * persona dentro de su compañía, no de un conjunto.
 */
export async function exigirGuardaActivo(
  ctx: Ctx,
  companiaId: Id<"companiasSeguridad">,
  userId: Id<"users">,
  /** El error cuando la persona no es guarda ("Solo se registran ..."). */
  soloGuardas: string,
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
    throw new Error(soloGuardas);
  }
  return miembro;
}

/**
 * Los guardas de alta de la compañía a los que alcanza quien pregunta. Es el
 * desplegable de los formularios; cada mutación vuelve a comprobarlo todo.
 */
export async function guardasElegibles(
  ctx: Ctx,
  companiaId: Id<"companiasSeguridad">,
  capacidades: Capacidades,
): Promise<{ userId: Id<"users">; nombre: string }[]> {
  const alcance = await alcanceConTodas(ctx, companiaId, capacidades);
  const miembros = (
    await ctx.db
      .query("companiaMiembros")
      .withIndex("by_compania", (q) => q.eq("companiaId", companiaId))
      .collect()
  ).filter((m) => m.isActive && rolPrincipalDeCompania(m.roles) === "guardia");

  const salida: { userId: Id<"users">; nombre: string }[] = [];
  for (const m of miembros) {
    if (!(await alcanzaAlGuarda(ctx, alcance, companiaId, m.userId))) continue;
    const u = await ctx.db.get(m.userId);
    if (!u) continue;
    salida.push({ userId: m.userId, nombre: displayNameFromUser(u) });
  }
  return salida.sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
}

/** Un lector de nombres que no relee el mismo usuario dos veces. */
export function lectorDeNombres(ctx: Ctx) {
  const nombres = new Map<Id<"users">, Promise<string>>();
  return (id: Id<"users">): Promise<string> => {
    if (!nombres.has(id)) {
      nombres.set(
        id,
        ctx.db.get(id).then((u) => (u ? displayNameFromUser(u) : "(perfil eliminado)")),
      );
    }
    return nombres.get(id)!;
  };
}
