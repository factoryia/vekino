import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { displayNameFromUser } from "./displayName";

/**
 * DÓNDE ESTÁ CADA ELEMENTO.
 *
 * Las lecturas de custodia en un solo sitio, igual que `model/minuta.ts` y
 * `model/inventarioNovedad.ts`: las usan tanto el listado del inventario como
 * la ficha del elemento y las propias mutaciones de asignación, y tres copias
 * de "cuál es la activa" acabarían discrepando en el peor momento.
 *
 * La regla que sostiene todo el módulo: **como máximo una custodia activa por
 * elemento**. No se guarda en ninguna parte que lo esté — se comprueba con el
 * índice `by_item_devuelta`, que es lo que la hace verificable en una lectura
 * en vez de una esperanza depositada en que nadie escriba dos filas.
 */

type Ctx = QueryCtx | MutationCtx;

/**
 * La custodia abierta de un elemento, si la hay.
 *
 * Una sola lectura indexada. `first()` y no `unique()` a propósito: `unique()`
 * lanza si hubiera dos filas abiertas, y eso convertiría una inconsistencia
 * —que las mutaciones ya impiden— en una pantalla que no carga. Con `first()`
 * la ficha se pinta y el problema se ve; sin él, no se vería nada.
 */
export async function custodiaActiva(
  ctx: Ctx,
  itemId: Id<"inventarioItems">,
): Promise<Doc<"inventarioAsignaciones"> | null> {
  return await ctx.db
    .query("inventarioAsignaciones")
    .withIndex("by_item_devuelta", (q) =>
      q.eq("itemId", itemId).eq("devueltaEn", undefined),
    )
    .first();
}

/** El historial de custodias de un elemento, de la más reciente a la más antigua. */
export async function custodiasDeItem(
  ctx: Ctx,
  itemId: Id<"inventarioItems">,
  limite: number,
): Promise<Doc<"inventarioAsignaciones">[]> {
  return await ctx.db
    .query("inventarioAsignaciones")
    .withIndex("by_item", (q) => q.eq("itemId", itemId))
    .order("desc")
    .take(limite);
}

/**
 * Todas las custodias abiertas de una compañía, indexadas por elemento.
 *
 * ES LO QUE EVITA EL N+1 DEL LISTADO. Preguntar "¿dónde está?" elemento por
 * elemento serían mil lecturas para pintar una tabla de mil filas; así es una
 * sola, y encima acotada por lo que la compañía tiene FUERA, que siempre es
 * menos que su inventario entero.
 */
export async function custodiasActivasDeCompania(
  ctx: Ctx,
  companiaId: Id<"companiasSeguridad">,
  tope: number,
): Promise<{
  porItem: Map<Id<"inventarioItems">, Doc<"inventarioAsignaciones">>;
  /**
   * El mapa NO está completo: había más custodias abiertas que el tope.
   *
   * Hay que decirlo, y no es un detalle. Quien pregunte por un elemento que
   * se quedó fuera del mapa no puede recibir "está en la compañía": eso es
   * una respuesta FALSA sobre dónde está un objeto físico, que es peor que
   * no responder. Con esta bandera, la pantalla dice "no se sabe".
   */
  incompleto: boolean;
}> {
  /* Más recientes primero, igual que el listado de elementos: si hay que
   * quedarse con una parte, que sea la que el usuario está mirando. */
  const abiertas = await ctx.db
    .query("inventarioAsignaciones")
    .withIndex("by_compania_devuelta", (q) =>
      q.eq("companiaId", companiaId).eq("devueltaEn", undefined),
    )
    .order("desc")
    .take(tope + 1);

  const porItem = new Map<
    Id<"inventarioItems">,
    Doc<"inventarioAsignaciones">
  >();
  for (const a of abiertas.slice(0, tope)) porItem.set(a.itemId, a);
  return { porItem, incompleto: abiertas.length > tope };
}

/**
 * Nombres de conjuntos, cacheados dentro de una misma consulta.
 *
 * Una compañía atiende unos pocos conjuntos, así que un listado de mil
 * elementos repartidos entre cinco porterías cuesta cinco lecturas y no mil.
 * El nombre se resuelve al leer y no se copia en la fila: si el conjunto se
 * renombra, el listado tiene que decir el nombre de hoy. (El histórico es
 * otra cosa: ahí el nombre va copiado dentro del texto de la novedad, que es
 * lo que le da sentido meses después.)
 */
export function cacheDeCondominios(ctx: Ctx) {
  /**
   * Guarda la PROMESA y no el valor. Con `cache.set(id, await get(id))` el
   * `await` suspende ANTES de escribir en el mapa, así que dentro de un
   * `Promise.all` los quinientos llamadores comprueban `has()` de forma
   * síncrona, todos fallan y todos lanzan su lectura: el caché solo
   * deduplicaba si se le llamaba en serie, y aquí nadie lo hace. Medido:
   * 500 lecturas para un único conjunto.
   */
  const cache = new Map<
    Id<"condominios">,
    Promise<Doc<"condominios"> | null>
  >();
  return async (id: Id<"condominios">) => {
    if (!cache.has(id)) cache.set(id, ctx.db.get(id));
    return (await cache.get(id)) ?? null;
  };
}

/** La custodia tal como la consume la pantalla. */
export type VistaCustodia = {
  _id: Id<"inventarioAsignaciones">;
  condominioId: Id<"condominios">;
  condominioNombre: string;
  asignadaEn: number;
  asignadaPorNombre: string | null;
  observacionAsignacion: string | null;
  devueltaEn: number | null;
  devueltaPorNombre: string | null;
  observacionDevolucion: string | null;
  /** Derivado, nunca guardado: sigue abierta mientras no tenga devolución. */
  activa: boolean;
};

/**
 * Hidrata una custodia con los nombres que la pantalla necesita.
 *
 * Recibe los resolutores en vez de leer por su cuenta para que quien pinta una
 * lista los comparta y no repita la misma lectura por fila.
 */
export async function aVistaCustodia(
  ctx: Ctx,
  a: Doc<"inventarioAsignaciones">,
  condominio: (id: Id<"condominios">) => Promise<Doc<"condominios"> | null>,
  usuario: (id: Id<"users">) => Promise<Doc<"users"> | null>,
): Promise<VistaCustodia> {
  const [condo, quienAsigno, quienDevolvio] = await Promise.all([
    condominio(a.condominioId),
    usuario(a.asignadaPorUserId),
    a.devueltaPorUserId ? usuario(a.devueltaPorUserId) : Promise.resolve(null),
  ]);
  return {
    _id: a._id,
    condominioId: a.condominioId,
    condominioNombre: condo?.name ?? "(conjunto eliminado)",
    asignadaEn: a.asignadaEn,
    asignadaPorNombre: quienAsigno ? displayNameFromUser(quienAsigno) : null,
    observacionAsignacion: a.observacionAsignacion ?? null,
    devueltaEn: a.devueltaEn ?? null,
    devueltaPorNombre: quienDevolvio
      ? displayNameFromUser(quienDevolvio)
      : null,
    observacionDevolucion: a.observacionDevolucion ?? null,
    activa: a.devueltaEn == null,
  };
}

/** Mismo cacheo que el de conjuntos, para los actores del historial. */
export function cacheDeUsuarios(ctx: Ctx) {
  /* Misma trampa que en cacheDeCondominios: la promesa, no el valor. */
  const cache = new Map<Id<"users">, Promise<Doc<"users"> | null>>();
  return async (id: Id<"users">) => {
    if (!cache.has(id)) cache.set(id, ctx.db.get(id));
    return (await cache.get(id)) ?? null;
  };
}

// ─────────────────────────────────────────────────────────────
// LA CUSTODIA INTERNA: qué guarda tiene el elemento dentro del conjunto.
//
// Un nivel más abajo que la de arriba, no un valor alternativo suyo: mientras
// un guarda tiene el radio, el elemento SIGUE asignado al conjunto. Las
// lecturas viven aquí, junto a las del conjunto, para que las dos reglas que
// dependen de ellas —"un solo guarda a la vez" y "el conjunto no devuelve lo
// que un guarda todavía tiene"— se apoyen exactamente en el mismo criterio.
// ─────────────────────────────────────────────────────────────

/**
 * La custodia de guarda abierta de un elemento, si la hay.
 *
 * Una sola lectura indexada, y sostiene DOS invariantes a la vez: que no se
 * pueda entregar a un segundo guarda, y que el conjunto no pueda devolver a la
 * compañía material que alguien tiene en la mano.
 *
 * `first()` y no `unique()` por lo mismo que en `custodiaActiva`: si alguna vez
 * hubiera dos filas abiertas, `unique()` convertiría la inconsistencia en una
 * pantalla que no carga, y el problema dejaría de poder verse.
 */
export async function custodiaGuardaActiva(
  ctx: Ctx,
  itemId: Id<"inventarioItems">,
): Promise<Doc<"inventarioCustodiaGuardas"> | null> {
  return await ctx.db
    .query("inventarioCustodiaGuardas")
    .withIndex("by_item_devuelta", (q) =>
      q.eq("itemId", itemId).eq("devueltaEn", undefined),
    )
    .first();
}

/** El historial de manos por las que ha pasado un elemento. */
export async function custodiasGuardaDeItem(
  ctx: Ctx,
  itemId: Id<"inventarioItems">,
  limite: number,
): Promise<Doc<"inventarioCustodiaGuardas">[]> {
  return await ctx.db
    .query("inventarioCustodiaGuardas")
    .withIndex("by_item", (q) => q.eq("itemId", itemId))
    .order("desc")
    .take(limite);
}

/**
 * Lo que está repartido HOY en una portería, indexado por elemento.
 *
 * ES LO QUE EVITA EL N+1 de la pantalla del supervisor. Preguntar "¿quién lo
 * tiene?" elemento por elemento serían cien lecturas para pintar cien filas;
 * así es una, y acotada por lo que está repartido, que siempre es menos que el
 * inventario del conjunto.
 *
 * Con la compañía DELANTE del conjunto en el índice: dos empresas pueden
 * cubrir la misma portería, y acotar por conjunto para filtrar después por
 * compañía se lleva las filas de la otra.
 */
export async function custodiasGuardaDeCondominio(
  ctx: Ctx,
  companiaId: Id<"companiasSeguridad">,
  condominioId: Id<"condominios">,
  tope: number,
): Promise<{
  porItem: Map<Id<"inventarioItems">, Doc<"inventarioCustodiaGuardas">>;
  incompleto: boolean;
}> {
  const abiertas = await ctx.db
    .query("inventarioCustodiaGuardas")
    .withIndex("by_compania_condominio_devuelta", (q) =>
      q
        .eq("companiaId", companiaId)
        .eq("condominioId", condominioId)
        .eq("devueltaEn", undefined),
    )
    .order("desc")
    .take(tope + 1);

  const porItem = new Map<
    Id<"inventarioItems">,
    Doc<"inventarioCustodiaGuardas">
  >();
  for (const c of abiertas.slice(0, tope)) porItem.set(c.itemId, c);
  return { porItem, incompleto: abiertas.length > tope };
}

/** La custodia de guarda tal como la consume la pantalla. */
export type VistaCustodiaGuarda = {
  _id: Id<"inventarioCustodiaGuardas">;
  guardaUserId: Id<"users">;
  guardaNombre: string;
  entregadaEn: number;
  entregadaPorNombre: string | null;
  observacionEntrega: string | null;
  devueltaEn: number | null;
  devueltaPorNombre: string | null;
  observacionDevolucion: string | null;
  activa: boolean;
  /**
   * El guarda hoy no opera en el conjunto —ya no está asignado, se fue a
   * cubrir otro, o la cobertura con la que estaba aquí terminó— pero sigue con
   * el elemento.
   *
   * NO se cierra sola. La relación laboral y la custodia física son cosas
   * distintas —el mismo criterio que hizo que la custodia del conjunto no
   * caducara con el contrato—, así que cerrar la fila al terminar la
   * asignación diría que el radio volvió cuando nadie lo ha devuelto. Se
   * señala para que alguien lo resuelva; esconderlo es como se pierde
   * inventario.
   *
   * `null` cuando no se ha comprobado (historial cerrado: no aplica).
   */
  pendiente: boolean | null;
};

export async function aVistaCustodiaGuarda(
  ctx: Ctx,
  c: Doc<"inventarioCustodiaGuardas">,
  usuario: (id: Id<"users">) => Promise<Doc<"users"> | null>,
  /** Quiénes operan hoy en el conjunto. Ausente = no se marca pendiente. */
  guardasVigentes?: ReadonlySet<Id<"users">>,
): Promise<VistaCustodiaGuarda> {
  const [guarda, quienEntrego, quienRecibio] = await Promise.all([
    usuario(c.guardaUserId),
    usuario(c.entregadaPorUserId),
    c.devueltaPorUserId ? usuario(c.devueltaPorUserId) : Promise.resolve(null),
  ]);
  const activa = c.devueltaEn == null;
  return {
    _id: c._id,
    guardaUserId: c.guardaUserId,
    guardaNombre: guarda ? displayNameFromUser(guarda) : "(perfil eliminado)",
    entregadaEn: c.entregadaEn,
    entregadaPorNombre: quienEntrego ? displayNameFromUser(quienEntrego) : null,
    observacionEntrega: c.observacionEntrega ?? null,
    devueltaEn: c.devueltaEn ?? null,
    devueltaPorNombre: quienRecibio ? displayNameFromUser(quienRecibio) : null,
    observacionDevolucion: c.observacionDevolucion ?? null,
    activa,
    pendiente:
      activa && guardasVigentes ? !guardasVigentes.has(c.guardaUserId) : null,
  };
}
