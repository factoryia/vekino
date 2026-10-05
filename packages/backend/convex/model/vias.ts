import type { QueryCtx, MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { etiquetaInstante } from "../lib/inasistencias";
import {
  viasDeAsignacionDelConjunto,
  viasDeAsignacionEn,
  type ViaAsignacion,
} from "./asignacion";
import {
  coberturaActivaDeGuardia,
  coberturasActivasEnConjunto,
  type ViaCobertura,
} from "./cobertura";

export type { ViaCobertura };

type Ctx = QueryCtx | MutationCtx;

/**
 * LAS VÍAS POR LAS QUE UNA PERSONA LLEGA A UN CONJUNTO.
 *
 * Son tres. Dos de pertenencia PERMANENTE y una TEMPORAL:
 *
 *   membership  → el eje residencial (`memberships`): residentes,
 *                 administración y el guarda propio del conjunto.
 *   asignacion  → el eje de seguridad (`asignaciones`): el guarda o el
 *                 supervisor de una compañía con contrato vigente.
 *   cobertura   → la cobertura temporal (`coberturas`): el guarda de una
 *                 compañía que cubre OTRO conjunto durante una ventana.
 *
 * Una persona puede tener varias en el mismo conjunto, y vías en varios
 * conjuntos a la vez. Por eso aquí nada devuelve "la" vía: se devuelven todas
 * las que valen, cada una con su procedencia (`tipo`), y qué hacer con ellas
 * —sumar capacidades, exigir un rol, preferir una— es política de quien
 * pregunta, no un segundo criterio.
 *
 * Cada vía tiene UN criterio y vive en un solo sitio:
 *
 *   membership  → la fila está activa (aquí, `viaDeMembership`);
 *   asignacion  → asignación vigente → contrato vigente → compañía activa
 *                 → miembro activo → conjunto activo (`model/asignacion.ts`);
 *   cobertura   → aceptada y dentro de su ventana → contrato vigente →
 *                 compañía activa → guarda de alta → conjunto activo
 *                 (`model/cobertura.ts`).
 *
 * El conjunto activo es eslabón de la asignación y de la cobertura, NO de la
 * membresía: es la regla de que un conjunto inactivo no se opera por una fila
 * de seguridad que siga en la base. La vía residencial no lo mira, como no lo
 * miró nunca.
 *
 * ── El contexto operativo de guarda ──────────────────────────────────────
 * Mientras un guarda tiene una cobertura activa, opera como guarda SOLO en el
 * conjunto que cubre. Sus vías permanentes DE GUARDA —la asignación con rol
 * `guardia` y el rol `guardia` de una membresía— quedan suspendidas en todos
 * los demás, y también en el de la cobertura, donde la vía es la cobertura.
 * Lo que no es de guarda no se toca: el residente sigue siendo residente y el
 * administrador sigue administrando.
 *
 * Ese contexto NO se guarda en ninguna tabla. Se deriva al leer, con el
 * instante de la petición (`resolverContextoOperativoGuardia`), y se aplica
 * sobre las vías permanentes (`aplicarContexto`). No hay columna que mantener
 * ni proceso que tenga que haber corrido: cuando la cobertura empieza, termina
 * o pierde un eslabón, la respuesta cambia sola.
 *
 * Quien autoriza pregunta por las vías OPERATIVAS (`viasOperativasEnConjunto`,
 * que es lo que miran `resolverAcceso` y `requireCondominioRole`). Las vías
 * PERMANENTES (`viasEnConjunto`) siguen existiendo para las preguntas que no
 * son de operación: si el guarda ya pertenece al conjunto que se le pide
 * cubrir, o en qué portería tenía su turno antes de salir a cubrir.
 *
 * El supervisor no es elegible para cubrir: solo quien en su compañía es
 * guarda (`companiaMiembros.roles` = ["guardia"]). Que `asignaciones.rol`
 * diga que un supervisor puede cubrir un turno como guarda es otro asunto sin
 * resolver y no sirve para ampliar la cobertura.
 */

/** Una membresía que da acceso: la fila existe y está activa. */
export type ViaMembership = {
  tipo: "membership";
  userId: Id<"users">;
  condominioId: Id<"condominios">;
  roles: Doc<"memberships">["roles"];
  membership: Doc<"memberships">;
};

export type Via = ViaMembership | ViaAsignacion | ViaCobertura;

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
 * Las vías PERMANENTES de una persona en un conjunto, en este instante: la
 * membresía (como mucho una: el índice es único por conjunto y usuario) y
 * después las asignaciones, en el orden del índice.
 *
 * No aplica el contexto operativo. Para autorizar una operación se pregunta a
 * `viasOperativasEnConjunto`.
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
 * Dónde puede operar como guarda una persona, en este instante.
 *
 *   permanente → no tiene cobertura activa: sus vías de siempre, sin cambios;
 *   cobertura  → opera como guarda SOLO en el conjunto de `via`;
 *   bloqueado  → tiene más de una cobertura activa a la vez. Es un dato
 *                inconsistente y la respuesta segura es no dejarlo operar
 *                como guarda en ninguna parte hasta que se corrija.
 *
 * `refrescarEn` es el próximo instante en que esto cambia solo. Es para que
 * el cliente sepa cuándo volver a preguntar, nunca para que decida.
 */
export type ContextoOperativoGuardia =
  | { tipo: "permanente"; refrescarEn: number | null }
  | { tipo: "cobertura"; via: ViaCobertura; refrescarEn: number | null }
  | {
      tipo: "bloqueado";
      coberturaIds: Id<"coberturas">[];
      refrescarEn: number | null;
    };

export async function resolverContextoOperativoGuardia(
  ctx: Ctx,
  userId: Id<"users">,
  ahora: number = Date.now(),
): Promise<ContextoOperativoGuardia> {
  const activa = await coberturaActivaDeGuardia(ctx, userId, ahora);
  switch (activa.estado) {
    case "ninguna":
      return { tipo: "permanente", refrescarEn: activa.refrescarEn };
    case "activa":
      return { tipo: "cobertura", via: activa.via, refrescarEn: activa.refrescarEn };
    case "inconsistente":
      return {
        tipo: "bloqueado",
        coberturaIds: activa.coberturaIds,
        refrescarEn: activa.refrescarEn,
      };
  }
}

/** Si una vía es de guarda: el rol `guardia` de la membresía, la asignación o la cobertura. */
export function esViaDeGuarda(v: Via): boolean {
  return v.tipo === "membership" ? v.roles.includes("guardia") : v.rol === "guardia";
}

/**
 * Las vías con las que una persona OPERA en un conjunto, dadas sus vías
 * permanentes allí y su contexto de guarda. Sin base de datos.
 *
 * Sin cobertura no cambia nada. Con cobertura (o bloqueado):
 *   - la asignación con rol `guardia` se suspende;
 *   - la membresía pierde el rol `guardia` y conserva los demás; si no tenía
 *     otro, se suspende entera;
 *   - lo demás (residente, administración, supervisor) sigue igual;
 *   - en el conjunto de la cobertura, la cobertura se suma como vía.
 *
 * `suspendidas` son las vías de guarda que la persona tendría aquí sin la
 * cobertura: sirven para decir por qué no pasa, nunca para dejarla pasar.
 */
export function aplicarContexto(
  permanentes: readonly Via[],
  contexto: ContextoOperativoGuardia,
  condominioId: Id<"condominios">,
): { vias: Via[]; suspendidas: Via[] } {
  if (contexto.tipo === "permanente") {
    return { vias: [...permanentes], suspendidas: [] };
  }
  const vias: Via[] = [];
  const suspendidas: Via[] = [];
  for (const v of permanentes) {
    if (!esViaDeGuarda(v)) {
      vias.push(v);
      continue;
    }
    suspendidas.push(v);
    if (v.tipo === "membership") {
      const resto = v.roles.filter((r) => r !== "guardia");
      if (resto.length > 0) vias.push({ ...v, roles: resto });
    }
  }
  if (contexto.tipo === "cobertura" && contexto.via.condominioId === condominioId) {
    vias.push(contexto.via);
  }
  return { vias, suspendidas };
}

/**
 * TODAS las vías con las que una persona opera hoy en un conjunto: las
 * permanentes con el contexto de guarda aplicado. Es lo que autoriza.
 */
export async function viasOperativasEnConjunto(
  ctx: Ctx,
  userId: Id<"users">,
  condominioId: Id<"condominios">,
  ahora: number = Date.now(),
): Promise<{
  membership: Doc<"memberships"> | null;
  vias: Via[];
  suspendidas: Via[];
  contexto: ContextoOperativoGuardia;
}> {
  const [{ membership, vias: permanentes }, contexto] = await Promise.all([
    viasEnConjunto(ctx, userId, condominioId, ahora),
    resolverContextoOperativoGuardia(ctx, userId, ahora),
  ]);
  return {
    membership,
    contexto,
    ...aplicarContexto(permanentes, contexto, condominioId),
  };
}

/**
 * Por qué una vía de guarda no vale ahora. Para el error de quien la intenta
 * usar: "no pertenece" sería falso y no le diría a dónde ir.
 */
export function motivoDeSuspension(
  contexto: Exclude<ContextoOperativoGuardia, { tipo: "permanente" }>,
): string {
  if (contexto.tipo === "bloqueado") {
    return "Tiene más de una cobertura activa a la vez: su operación como guarda queda bloqueada hasta que la compañía lo corrija.";
  }
  return `Está cubriendo ${contexto.via.condominio.name} hasta el ${etiquetaInstante(contexto.via.cobertura.fin)}: mientras tanto solo opera como guarda allí.`;
}

/**
 * Las vías de GUARDA que dan acceso hoy a un conjunto, de cualquier persona.
 *
 * Responde "¿quién puede ser guarda en ESTE conjunto?" con el mismo criterio
 * con el que la portería deja pasar: membresía activa con el rol `guardia`,
 * asignación de guarda que pasa la cadena entera, o cobertura activa aquí.
 * Cada fila de asignación se juzga por sí misma; que la persona tenga OTRA
 * asignación viva aquí con otro rol no cuenta.
 *
 * Y con el contexto aplicado: quien hoy cubre otro conjunto no es guarda
 * aquí aunque su asignación siga viva, y quien cubre éste sí lo es aunque no
 * tenga ninguna. Cuesta una lectura por índice por cada guarda permanente de
 * la portería, que son pocos.
 */
export async function viasDeGuardiaDelConjunto(
  ctx: Ctx,
  condominioId: Id<"condominios">,
  ahora: number = Date.now(),
): Promise<Via[]> {
  const [memberships, asignaciones, coberturas] = await Promise.all([
    ctx.db
      .query("memberships")
      .withIndex("by_condominio", (q) => q.eq("condominioId", condominioId))
      .collect(),
    viasDeAsignacionDelConjunto(ctx, condominioId, "guardia", ahora),
    coberturasActivasEnConjunto(ctx, condominioId, ahora),
  ]);
  const porMembresia = memberships
    .map(viaDeMembership)
    .filter((v): v is ViaMembership => v?.roles.includes("guardia") === true);
  const permanentes: Via[] = [...porMembresia, ...asignaciones];

  const personas = [...new Set(permanentes.map((v) => v.userId))];
  const contextos = await Promise.all(
    personas.map((userId) => resolverContextoOperativoGuardia(ctx, userId, ahora)),
  );
  const operan = new Set(
    personas.filter((_, i) => contextos[i]!.tipo === "permanente"),
  );
  return [...permanentes.filter((v) => operan.has(v.userId)), ...coberturas];
}

/**
 * La primera vía de un tipo, o null.
 *
 * Para los consumidores que, como hasta ahora, operan con una sola vía de
 * cada clase: la membresía es única por conjunto, con la regla 3 de
 * `asignaciones.crear` también lo es la asignación viva, y la cobertura que
 * da vía es como mucho una (con dos, el contexto queda bloqueado).
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
