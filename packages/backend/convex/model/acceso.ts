import type { QueryCtx, MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { getCurrentAppUser, hasPlatformRole } from "./authz";
import { asignacionVigente, condominiosSupervisados } from "./asignacion";
import { primeraVia, viasEnConjunto } from "./vias";

import {
  capacidadesDePlataforma,
  capacidadesDeRolAsignacion,
  capacidadesDeRolesCompania,
  capacidadesDeRolesConjunto,
  estaVigente,
  unir,
  type Capacidad,
} from "../lib/vigilancia";

/* `asignacionVigente` y `condominiosSupervisados` viven en
 * `model/asignacion.ts`, junto a la cadena que comprueban, para que `authz.ts`
 * tambien pueda usarlas sin cerrar un ciclo de imports. Se reexportan porque
 * este sigue siendo el sitio donde se busca "el eje de seguridad". */
export { asignacionVigente, condominiosSupervisados };

type Ctx = QueryCtx | MutationCtx;

/**
 * QUIÉN PUEDE HACER QUÉ, EN UN SOLO SITIO.
 *
 * Con dos ejes de pertenencia la pregunta "puede operar aquí" deja de ser un
 * rol: es rol + contrato + vigencia. Las listas de literales que hoy declara
 * cada módulo (`GUARD_ROLES` está duplicada en guardia.ts, rondas.ts y
 * aporte.ts) no pueden expresar eso, así que se sustituyen por capacidades
 * resueltas aquí.
 *
 * Esto NO reemplaza todavía a `requireCondominioRole`: lo envuelve. Los 192
 * puntos de verificación que existen hoy siguen funcionando igual, y cada
 * módulo migra cuando le toque. La vía directa del guarda propio del conjunto
 * (`memberships.roles ∋ "guardia"`) se conserva intacta, que es lo que hace
 * que ningún guarda actual deje de funcionar.
 */
export type Acceso = {
  user: Doc<"users">;
  esPlataforma: boolean;
  /** Membresía en el conjunto, si la tiene. Eje residencial. */
  membership: Doc<"memberships"> | null;
  /**
   * Asignación vigente en ESTE conjunto, si la tiene. Eje seguridad. Es la
   * primera vía de asignación de `viasEnConjunto` (en la práctica, la única).
   */
  asignacion: Doc<"asignaciones"> | null;
  /** El contrato que ampara esa asignación. */
  contrato: Doc<"companiaContratos"> | null;
  compania: Doc<"companiasSeguridad"> | null;
  capacidades: Set<Capacidad>;
};

/**
 * Membresía de compañía de una persona (o null).
 *
 * Se busca por `by_user` y no por compañía porque la pregunta que se hace en
 * el arranque de sesión es "¿de qué compañía es esta persona?", no al revés.
 * Se toma la primera activa: el modelo admite varias filas históricas, pero
 * pertenecer a dos compañías a la vez no es un caso real.
 */
export async function getCompaniaMiembro(
  ctx: Ctx,
  userId: Id<"users">,
): Promise<Doc<"companiaMiembros"> | null> {
  const filas = await ctx.db
    .query("companiaMiembros")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  return filas.find((m) => m.isActive) ?? null;
}

/** La compañía de una persona, tal como la necesita el arranque de sesión. */
export type MiCompania = {
  companiaId: Id<"companiasSeguridad">;
  nombre: string;
  estado: Doc<"companiasSeguridad">["estado"];
  logo: string | null;
  primaryColor: string | null;
  roles: Doc<"companiaMiembros">["roles"];
};

/**
 * A qué compañía pertenece esta persona y con qué roles.
 *
 * EL TERCER EJE. `memberships` dice a qué conjuntos pertenece; `asignaciones`,
 * en cuáles trabaja por una compañía; y esto, de qué empresa es. Son cosas
 * distintas y se notó tarde: el administrador de una compañía no tiene ni
 * membresía ni asignación —no pisa ninguna portería, administra la empresa
 * que las cubre—, así que un contexto de sesión armado solo con los dos
 * primeros lo dejaba dentro y sin nada que mirar.
 *
 * Vive aquí, junto a `getCompaniaMiembro`, para que `users.me` y
 * `companias.miCompania` respondan lo mismo sin dos consultas paralelas.
 */
export async function miCompaniaDe(
  ctx: Ctx,
  userId: Id<"users">,
): Promise<MiCompania | null> {
  const miembro = await getCompaniaMiembro(ctx, userId);
  if (!miembro) return null;
  const compania = await ctx.db.get(miembro.companiaId);
  if (!compania) return null;
  return {
    companiaId: compania._id,
    nombre: compania.nombre,
    estado: compania.estado,
    logo: compania.logo ?? null,
    primaryColor: compania.primaryColor ?? null,
    roles: miembro.roles,
  };
}

/**
 * El contrato vigente que ampara a una compañía sobre un conjunto.
 *
 * Es lo que convierte "soy el administrador de Seguridad Andina" en "puedo
 * mirar la portería de este conjunto": no el rol por sí solo, sino el rol más
 * un contrato en vigor. El día que el contrato termina, deja de resolver.
 *
 * Exportada porque el inventario hace la misma pregunta al entregar un
 * elemento a un conjunto: solo se le puede entregar a quien se atiende hoy.
 * Duplicar la consulta habría dejado dos definiciones de "atendemos este
 * conjunto" que se irían separando.
 */
export async function contratoVigente(
  ctx: Ctx,
  companiaId: Id<"companiasSeguridad">,
  condominioId: Id<"condominios">,
  ahora: number,
): Promise<Doc<"companiaContratos"> | null> {
  const contratos = await ctx.db
    .query("companiaContratos")
    .withIndex("by_condominio_compania", (q) =>
      q.eq("condominioId", condominioId).eq("companiaId", companiaId),
    )
    .collect();
  return contratos.find((k) => estaVigente(k, ahora)) ?? null;
}

/**
 * Resuelve todo lo que una persona puede hacer en un conjunto.
 *
 * Coste acotado: como mucho cinco lecturas por índice, ninguna de colección
 * completa. Importa porque las queries del shell (`guardia.home`,
 * `condominios.adminHome`) corren en CADA página, y su propio código ya
 * advierte de eso. Resolver una vez por función y pasar el resultado; nunca
 * llamar a esto varias veces en el mismo handler.
 */
export async function resolverAcceso(
  ctx: Ctx,
  condominioId: Id<"condominios">,
): Promise<Acceso | null> {
  const user = await getCurrentAppUser(ctx);
  if (!user || !user.active) return null;

  const esPlataforma = hasPlatformRole(user, "superadmin", "admin");
  /* Todas las vías de una vez (`model/vias.ts`). De cada clase se usa la
   * primera, como siempre: la membresía es única por conjunto y, con la regla
   * 3 de `asignaciones.crear`, también la asignación viva. */
  const { membership, vias } = await viasEnConjunto(ctx, user._id, condominioId);
  const viaMembership = primeraVia(vias, "membership");
  const viaCompania = primeraVia(vias, "asignacion");

  // El staff de plataforma mantiene el paso libre que ya tiene hoy.
  if (esPlataforma) {
    return {
      user,
      esPlataforma,
      membership,
      asignacion: viaCompania?.asignacion ?? null,
      contrato: viaCompania?.contrato ?? null,
      compania: viaCompania?.compania ?? null,
      capacidades: capacidadesDePlataforma(),
    };
  }

  /* Las vías se SUMAN. Un administrador del conjunto que además sea
   * supervisor de la compañía tiene lo de ambos, y un guarda que exista por
   * las dos vías no pierde acceso si una falla. */
  const delConjunto = viaMembership
    ? capacidadesDeRolesConjunto(viaMembership.roles)
    : new Set<Capacidad>();

  const deLaAsignacion = viaCompania
    ? capacidadesDeRolAsignacion(viaCompania.rol)
    : new Set<Capacidad>();

  /* TERCERA VÍA: el administrador de la compañía que cubre este conjunto.
   *
   * No tiene asignación —no cubre turnos, dirige a quien los cubre—, así que
   * por las dos vías de arriba no alcanzaba nada: sus propios supervisores
   * veían las rondas de un conjunto y él no. Lo que lo autoriza no es el rol
   * suelto sino el CONTRATO: solo los conjuntos que su empresa atiende hoy, y
   * solo para mirar. `porteria.operar` no está aquí a propósito.
   *
   * Se resuelve al final y SOLO si las otras dos vías no dieron nada: son dos
   * lecturas por índice más y esto corre en cada página. La condición no
   * pierde nada — cualquier rol del conjunto que otorgue algo ya otorga
   * `porteria.ver`, que es lo único que esta vía añade. */
  let deLaCompania = new Set<Capacidad>();
  if (delConjunto.size === 0 && deLaAsignacion.size === 0) {
    const miCompania = await getCompaniaMiembro(ctx, user._id);
    if (miCompania?.roles.includes("admin_compania")) {
      const empresa = await ctx.db.get(miCompania.companiaId);
      if (empresa && empresa.estado === "activa") {
        const contrato = await contratoVigente(
          ctx,
          miCompania.companiaId,
          condominioId,
          Date.now(),
        );
        if (contrato) deLaCompania = new Set<Capacidad>(["porteria.ver"]);
      }
    }
  }

  return {
    user,
    esPlataforma,
    membership,
    asignacion: viaCompania?.asignacion ?? null,
    contrato: viaCompania?.contrato ?? null,
    compania: viaCompania?.compania ?? null,
    capacidades: unir(delConjunto, deLaAsignacion, deLaCompania),
  };
}

/** Exige una capacidad en un conjunto. Lanza si no la tiene. */
export async function exigirAcceso(
  ctx: Ctx,
  condominioId: Id<"condominios">,
  capacidad: Capacidad,
): Promise<Acceso> {
  const acceso = await resolverAcceso(ctx, condominioId);
  if (!acceso) throw new Error("No autenticado o perfil inexistente.");
  if (!acceso.capacidades.has(capacidad)) {
    throw new Error(`No tiene permiso para esta operación (${capacidad}).`);
  }
  return acceso;
}

// ─────────────────────────────────────────────────────────────
// Autorización dentro del eje de seguridad (sin conjunto de por medio)
// ─────────────────────────────────────────────────────────────

export type AccesoCompania = {
  user: Doc<"users">;
  esPlataforma: boolean;
  miembro: Doc<"companiaMiembros"> | null;
  compania: Doc<"companiasSeguridad">;
  capacidades: Set<Capacidad>;
};

/**
 * Exige una capacidad SOBRE una compañía concreta.
 *
 * Separada de `exigirAcceso` porque administrar el personal de una compañía
 * no ocurre dentro de ningún conjunto: un supervisor puede existir sin estar
 * asignado a ninguna parte todavía.
 */
export async function exigirAccesoCompania(
  ctx: Ctx,
  companiaId: Id<"companiasSeguridad">,
  capacidad: Capacidad,
): Promise<AccesoCompania> {
  const user = await getCurrentAppUser(ctx);
  if (!user || !user.active) {
    throw new Error("No autenticado o perfil inexistente.");
  }
  const compania = await ctx.db.get(companiaId);
  if (!compania) throw new Error("Compañía no encontrada.");

  const esPlataforma = hasPlatformRole(user, "superadmin", "admin");
  if (esPlataforma) {
    return {
      user,
      esPlataforma,
      miembro: await getCompaniaMiembro(ctx, user._id),
      compania,
      capacidades: capacidadesDePlataforma(),
    };
  }

  const miembro = await getCompaniaMiembro(ctx, user._id);
  /* Pertenecer a OTRA compañía no da ningún acceso sobre ésta. */
  if (!miembro || miembro.companiaId !== companiaId) {
    throw new Error("No pertenece a esta compañía.");
  }
  /* Una compañía suspendida no opera, ni siquiera su propio administrador:
   * es justo lo que significa suspenderla. */
  if (compania.estado !== "activa") {
    throw new Error(`La compañía está ${compania.estado}.`);
  }

  const capacidades = capacidadesDeRolesCompania(miembro.roles);
  if (!capacidades.has(capacidad)) {
    throw new Error(`No tiene permiso para esta operación (${capacidad}).`);
  }
  return { user, esPlataforma, miembro, compania, capacidades };
}

/**
 * Hasta dónde alcanza quien pregunta dentro de una compañía, para una
 * capacidad.
 *
 * Tres vías:
 *
 *   - plataforma: toda la compañía;
 *   - `admin_compania` de ESA compañía, si su rol da la capacidad: toda la
 *     compañía;
 *   - `supervisor` de esa compañía, si su rol de ASIGNACIÓN da la capacidad:
 *     solo los conjuntos que supervisa hoy (`condominiosSupervisados`, la
 *     cadena entera).
 *
 * La tercera es la que `exigirAccesoCompania` no puede expresar: las
 * capacidades de compañía son globales a la empresa y el supervisor está
 * acotado por conjunto. Sin esto, o el supervisor no podía hacer nada, o
 * podía tocar los conjuntos de sus colegas.
 *
 * `conjuntos: null` es toda la compañía. Quién decide qué conjuntos toca cada
 * operación es el llamador (el del contrato, los de un guarda), con
 * `alcanceCubre`; la regla de quién llega a qué está aquí y solo aquí.
 */
export type AlcanceEnCompania = {
  user: Doc<"users">;
  esPlataforma: boolean;
  conjuntos: Set<Id<"condominios">> | null;
};

export async function alcanceEnCompania(
  ctx: Ctx,
  companiaId: Id<"companiasSeguridad">,
  capacidad: Capacidad,
  /** El error cuando quien pregunta es de otra compañía o de ninguna. */
  ajena: string = "No pertenece a esta compañía.",
): Promise<AlcanceEnCompania> {
  const user = await getCurrentAppUser(ctx);
  if (!user || !user.active) {
    throw new Error("No autenticado o perfil inexistente.");
  }
  if (hasPlatformRole(user, "superadmin", "admin")) {
    return { user, esPlataforma: true, conjuntos: null };
  }

  const miembro = await getCompaniaMiembro(ctx, user._id);
  if (!miembro || miembro.companiaId !== companiaId) {
    throw new Error(ajena);
  }
  const compania = await ctx.db.get(companiaId);
  if (!compania || compania.estado !== "activa") {
    throw new Error("La compañía no está activa.");
  }

  if (capacidadesDeRolesCompania(miembro.roles).has(capacidad)) {
    return { user, esPlataforma: false, conjuntos: null };
  }

  if (
    miembro.roles.includes("supervisor") &&
    capacidadesDeRolAsignacion("supervisor").has(capacidad)
  ) {
    return {
      user,
      esPlataforma: false,
      conjuntos: await condominiosSupervisados(ctx, user._id),
    };
  }

  throw new Error(`No tiene permiso para esta operación (${capacidad}).`);
}

/** Si el alcance llega a alguno de estos conjuntos. */
export function alcanceCubre(
  alcance: AlcanceEnCompania,
  condominios: Iterable<Id<"condominios">>,
): boolean {
  if (alcance.conjuntos === null) return true;
  for (const c of condominios) if (alcance.conjuntos.has(c)) return true;
  return false;
}

/**
 * Quién puede obrar sobre un contrato concreto.
 *
 * La compañía y el conjunto salen del documento del contrato, nunca de un
 * argumento del cliente. El supervisor solo alcanza los contratos de los
 * conjuntos que supervisa.
 */
export async function exigirAccesoContrato(
  ctx: Ctx,
  contrato: Doc<"companiaContratos">,
  capacidad: Capacidad,
): Promise<{
  user: Doc<"users">;
  esPlataforma: boolean;
  /** true si obra como supervisor acotado, no como admin de la compañía. */
  comoSupervisor: boolean;
}> {
  const alcance = await alcanceEnCompania(
    ctx,
    contrato.companiaId,
    capacidad,
    "Ese contrato no pertenece a su compañía.",
  );
  if (!alcanceCubre(alcance, [contrato.condominioId])) {
    throw new Error(`No tiene permiso para esta operación (${capacidad}).`);
  }
  return {
    user: alcance.user,
    esPlataforma: alcance.esPlataforma,
    comoSupervisor: alcance.conjuntos !== null,
  };
}
