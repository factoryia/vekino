import type { QueryCtx, MutationCtx } from "../_generated/server";
import type { Doc, Id, TableNames } from "../_generated/dataModel";
import { acotado, estaVigente, haySolape, type Rango } from "../lib/vigilancia";
import { displayNameFromUser } from "./displayName";

type Ctx = QueryCtx | MutationCtx;

/**
 * EL EJE DE SEGURIDAD, EN UNA HOJA.
 *
 * Vive aparte de `model/acceso.ts` porque `model/authz.ts` también necesita
 * resolver una asignación —el guarda de compañía tiene que pasar por
 * `requireCondominioRole` igual que el guarda propio del conjunto— y
 * `acceso.ts` ya depende de `authz.ts`. Importarlo al revés cerraría un ciclo.
 * Aquí no se importa nada del proyecto salvo las cuentas de vigencia y el
 * formateo de nombres —ambos hojas, sin dependencias—, así que los dos lados
 * pueden colgarse de este archivo sin enredo.
 *
 * Es la VÍA DE ASIGNACIÓN: una de las dos formas de pertenencia permanente a
 * un conjunto. La otra, la membresía, y la manera de juntarlas viven en
 * `model/vias.ts`, que es por donde preguntan los consumidores.
 */

/**
 * Un lector de documentos que no relee el mismo dos veces.
 *
 * Guarda la PROMESA y no el valor. Con `set(id, await get(id))` el `await`
 * suspende antes de escribir en el mapa, así que dentro de un `Promise.all`
 * todos comprueban `has()` a la vez, todos fallan y todos leen: el caché solo
 * deduplicaría si se le llamara en serie. Es un error que este proyecto ya
 * pagó una vez.
 */
function cacheDoc<T extends TableNames>(ctx: Ctx) {
  const visto = new Map<Id<T>, Promise<Doc<T> | null>>();
  return (id: Id<T>): Promise<Doc<T> | null> => {
    if (!visto.has(id)) visto.set(id, ctx.db.get(id));
    return visto.get(id)!;
  };
}

/**
 * Los cuatro documentos que hacen falta para juzgar una asignación.
 *
 * Se comparte entre todas las asignaciones de una misma consulta porque los
 * cincuenta guardas de una portería cuelgan del MISMO contrato y de la MISMA
 * compañía: sin caché eran cien lecturas de dos documentos.
 */
export function cacheDeCadena(ctx: Ctx) {
  return {
    contrato: cacheDoc<"companiaContratos">(ctx),
    compania: cacheDoc<"companiasSeguridad">(ctx),
    miembro: cacheDoc<"companiaMiembros">(ctx),
    usuario: cacheDoc<"users">(ctx),
  };
}

export type CacheDeCadena = ReturnType<typeof cacheDeCadena>;

/**
 * Una asignación que da acceso HOY, con la procedencia a la vista.
 *
 * `tipo` la distingue de las otras vías de `model/vias.ts`. Los campos de
 * arriba son los que cualquier vía tiene que poder contestar —quién, dónde,
 * con qué rol—; los documentos de abajo son la prueba, para quien necesite
 * mirar la compañía o las fechas.
 */
export type ViaAsignacion = {
  tipo: "asignacion";
  userId: Id<"users">;
  condominioId: Id<"condominios">;
  companiaId: Id<"companiasSeguridad">;
  rol: Doc<"asignaciones">["rol"];
  asignacion: Doc<"asignaciones">;
  contrato: Doc<"companiaContratos">;
  compania: Doc<"companiasSeguridad">;
};

/*
 * LOS CUATRO ESLABONES, EN UN SOLO SITIO.
 *
 * Asignación vigente → contrato vigente → compañía activa → miembro no dado
 * de baja. Es EL criterio del eje de seguridad, y existe en funciones propias
 * justamente para que no haya dos versiones: la cabecera de este archivo
 * avisa de que tenerlo repetido es cómo se abren los agujeros por los que
 * alguien sigue entrando a un conjunto que ya no cubre.
 *
 * Partido en dos mitades porque hay dos preguntas que no comprueban los
 * cuatro: `condominiosSupervisados` solo mira las fechas —la asignación y su
 * contrato— y `asignacionEstorba` mira las personas —compañía y miembro—
 * contra una ventana futura en vez de contra ahora. Cada una usa su mitad;
 * nadie reescribe un eslabón.
 *
 * Reciben la fila ya leída —quien pregunta por un conjunto entero ya las tiene
 * todas— y los lectores cacheados, para poder resolver cincuenta a la vez sin
 * releer lo mismo cincuenta veces.
 */

/** Eslabones 1 y 2: la asignación y su contrato cubren este instante. */
async function vigenteConSuContrato(
  a: Doc<"asignaciones">,
  ahora: number,
  cache: CacheDeCadena,
): Promise<Doc<"companiaContratos"> | null> {
  if (!estaVigente(a, ahora)) return null;
  const contrato = await cache.contrato(a.contratoId);
  if (!contrato || !estaVigente(contrato, ahora)) return null;
  return contrato;
}

/** Eslabones 3 y 4: la compañía está activa y la persona sigue de alta en ella. */
async function personalDeAlta(
  a: Doc<"asignaciones">,
  cache: CacheDeCadena,
): Promise<Doc<"companiasSeguridad"> | null> {
  const compania = await cache.compania(a.companiaId);
  if (!compania || compania.estado !== "activa") return null;
  const miembro = await cache.miembro(a.companiaMiembroId);
  if (!miembro || !miembro.isActive) return null;
  return compania;
}

/** La cadena entera sobre UNA fila. Null si cae cualquier eslabón. */
async function viaDeAsignacion(
  a: Doc<"asignaciones">,
  ahora: number,
  cache: CacheDeCadena,
): Promise<ViaAsignacion | null> {
  const contrato = await vigenteConSuContrato(a, ahora, cache);
  if (!contrato) return null;
  const compania = await personalDeAlta(a, cache);
  if (!compania) return null;
  return {
    tipo: "asignacion",
    userId: a.userId,
    condominioId: a.condominioId,
    companiaId: a.companiaId,
    rol: a.rol,
    asignacion: a,
    contrato,
    compania,
  };
}

/** Las filas que pasan la cadena, en el orden en que las trajo el índice. */
async function filtrarVias(
  filas: readonly Doc<"asignaciones">[],
  ahora: number,
  cache: CacheDeCadena,
): Promise<ViaAsignacion[]> {
  const vias = await Promise.all(
    filas.map((a) => viaDeAsignacion(a, ahora, cache)),
  );
  return vias.filter((v): v is ViaAsignacion => v !== null);
}

/**
 * TODAS las asignaciones con las que esta persona puede operar hoy en este
 * conjunto.
 *
 * Devuelve la lista entera y no la primera: decidir qué hacer con varias es
 * cosa de quien pregunta. Hoy, por la regla 3 de `asignaciones.crear`, no
 * puede haber dos vivas que se pisen en el mismo conjunto, así que en la
 * práctica sale una o ninguna.
 *
 * Todo se comprueba al leer, así que el corte es exacto y no depende de que
 * ningún proceso se haya ejecutado.
 */
export async function viasDeAsignacionEn(
  ctx: Ctx,
  userId: Id<"users">,
  condominioId: Id<"condominios">,
  ahora: number = Date.now(),
): Promise<ViaAsignacion[]> {
  const filas = await ctx.db
    .query("asignaciones")
    .withIndex("by_user_condominio", (q) =>
      q.eq("userId", userId).eq("condominioId", condominioId),
    )
    .collect();
  return await filtrarVias(filas, ahora, cacheDeCadena(ctx));
}

/** Todas las asignaciones vigentes de una persona, en cualquier conjunto. */
async function viasDeAsignacionDe(
  ctx: Ctx,
  userId: Id<"users">,
  ahora: number,
): Promise<ViaAsignacion[]> {
  const filas = await ctx.db
    .query("asignaciones")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  return await filtrarVias(filas, ahora, cacheDeCadena(ctx));
}

/**
 * La asignación con la que esta persona opera hoy en este conjunto.
 *
 * Es la primera de `viasDeAsignacionEn`, en el orden del índice: lo que esta
 * función devolvió siempre. Con la regla 3 es la única, así que "la primera"
 * no elige nada; si una fila llegada de otro modo hiciera que hubiera dos, se
 * queda la misma de antes.
 *
 * Devuelve null en cuanto falla cualquier eslabón de la cadena: compañía
 * suspendida, miembro dado de baja, contrato vencido o asignación terminada.
 */
export async function asignacionVigente(
  ctx: Ctx,
  userId: Id<"users">,
  condominioId: Id<"condominios">,
  ahora: number = Date.now(),
): Promise<ViaAsignacion | null> {
  const vias = await viasDeAsignacionEn(ctx, userId, condominioId, ahora);
  return vias[0] ?? null;
}

/**
 * Los guardas que HOY cubren un conjunto por cuenta de una compañía.
 *
 * Vive aquí y no dentro de `asignaciones.ts` porque la usan dos módulos: el
 * equipo del supervisor y la custodia del inventario. Es exactamente el caso
 * del que avisa la cabecera de este archivo — tener el criterio de vigencia
 * en dos sitios es cómo se abre el agujero por el que alguien entrega un
 * radio a un guarda que ya no trabaja allí.
 *
 * Filtra por compañía A PROPÓSITO y no por comodidad: dos empresas pueden
 * cubrir la misma portería, y "está asignado a este conjunto" no implica "es
 * de los nuestros". Sin este filtro, el material de una empresa podría acabar
 * en manos del personal de la otra.
 *
 * Comprueba la MISMA cadena que `asignacionVigente` —es la misma función—
 * pero sobre las filas que ya trajo el índice y con los lectores compartidos:
 * los cincuenta guardas de una portería cuelgan del mismo contrato y de la
 * misma compañía, así que sin caché eran cien lecturas de dos documentos, y
 * en serie. Con caché y en paralelo, dos lecturas y un salto.
 */
export async function guardasDelConjunto(
  ctx: Ctx,
  condominioId: Id<"condominios">,
  companiaId: Id<"companiasSeguridad">,
) {
  const filas = await ctx.db
    .query("asignaciones")
    .withIndex("by_condominio_rol", (q) =>
      q.eq("condominioId", condominioId).eq("rol", "guardia"),
    )
    .collect();

  const cache = cacheDeCadena(ctx);
  const ahora = Date.now();

  /* Se juzga CADA fila, no "¿tiene esta persona alguna asignación vigente
   * aquí?". Preguntar lo segundo hacía que alguien con dos filas en el mismo
   * conjunto —una vencida y otra viva— apareciera DOS VECES en el listado y
   * en el desplegable de entrega. */
  const resueltas = await Promise.all(
    filas
      .filter((a) => a.companiaId === companiaId)
      .map(async (a) => {
        if (!(await viaDeAsignacion(a, ahora, cache))) return null;
        const u = await cache.usuario(a.userId);
        if (!u || !u.active) return null;
        return {
          asignacionId: a._id,
          userId: u._id,
          nombre: displayNameFromUser(u),
          email: u.email,
          telefono: u.telefono ?? null,
          vigenciaDesde: a.vigenciaDesde,
          vigenciaHasta: a.vigenciaHasta ?? null,
        };
      }),
  );

  /* Una persona, una entrada.
   *
   * `asignacionEstorba` impide por API crear dos asignaciones solapadas, pero
   * una fila llegada de otro modo haria aparecer al mismo guarda dos veces en
   * el desplegable de entrega — dos opciones identicas, y quien las mira sin
   * saber cual elegir. Se queda la primera por orden del indice. */
  const vistos = new Set<Id<"users">>();
  return resueltas
    .filter((g): g is NonNullable<typeof g> => g !== null)
    .filter((g) => {
      if (vistos.has(g.userId)) return false;
      vistos.add(g.userId);
      return true;
    })
    .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
}

/** Una asignación vigente, con lo que hace falta para pintarla y rutear. */
export type MiAsignacion = {
  asignacionId: Id<"asignaciones">;
  condominioId: Id<"condominios">;
  condominioNombre: string;
  condominioLogo: string | null;
  condominioColor: string | null;
  companiaId: Id<"companiasSeguridad">;
  companiaNombre: string;
  rol: Doc<"asignaciones">["rol"];
  vigenciaHasta: number | null;
};

/**
 * Dónde trabaja hoy una persona por la vía de una compañía.
 *
 * Es LA consulta del arranque de sesión del personal de vigilancia, y por eso
 * está aquí y no dentro de una función de Convex: la usan `users.me` (para
 * saber a dónde mandar a quien acaba de entrar), `asignaciones.misAsignaciones`
 * (para elegir conjunto) y `asignaciones.miEquipo`. `condominios.listMine` NO:
 * sigue siendo el eje residencial, a propósito.
 *
 * Las asignaciones salen de la misma cadena que autoriza (`viasDeAsignacionDe`),
 * no de una copia: dos criterios de vigencia es exactamente cómo se abren los
 * agujeros por los que alguien sigue viendo un conjunto que ya no cubre.
 *
 * Encima de la cadena se quita el conjunto inactivo. Ese filtro es de esta
 * lista y no de la vía: la portería de un conjunto inactivo hoy NO rebota a
 * quien tiene asignación vigente —ni `requireCondominioRole` ni
 * `resolverAcceso` miran el conjunto—, solo deja de ofrecerse aquí. Se
 * conserva tal cual; si un conjunto inactivo debe cortar también el acceso es
 * una decisión pendiente, no un detalle de implementación.
 */
export async function misAsignacionesVigentes(
  ctx: Ctx,
  userId: Id<"users">,
  ahora: number = Date.now(),
): Promise<MiAsignacion[]> {
  const vias = await viasDeAsignacionDe(ctx, userId, ahora);

  const salida: MiAsignacion[] = [];
  for (const via of vias) {
    const condo = await ctx.db.get(via.condominioId);
    if (!condo || !condo.isActive) continue;

    salida.push({
      asignacionId: via.asignacion._id,
      condominioId: via.condominioId,
      condominioNombre: condo.name,
      condominioLogo: condo.logo ?? null,
      condominioColor: condo.primaryColor ?? null,
      companiaId: via.companiaId,
      companiaNombre: via.compania.nombre,
      rol: via.rol,
      vigenciaHasta: via.asignacion.vigenciaHasta ?? null,
    });
  }

  return salida.sort((a, b) =>
    a.condominioNombre.localeCompare(b.condominioNombre, "es"),
  );
}

/**
 * Conjuntos donde esta persona supervisa hoy.
 *
 * El ámbito del supervisor NO es su compañía entera: es el conjunto de sitios
 * donde tiene asignación vigente con rol `supervisor`. Un supervisor de zona
 * norte no manda sobre la zona sur de la misma empresa.
 *
 * Solo mira los dos primeros eslabones —la asignación y su contrato—, como lo
 * hizo siempre: la compañía y el miembro los comprueba antes cada consumidor
 * sobre la membresía ACTIVA de quien pregunta (`exigirAccesoContrato`,
 * `companias.detail`, `historialDePersona`). No coincide del todo con la
 * cadena entera: una asignación de supervisor bajo una compañía suspendida, o
 * colgada de una membresía dada de baja, sigue contando aquí. Pasarla a los
 * cuatro eslabones cambiaría lo que ve un supervisor, así que se deja anotado
 * como decisión pendiente en vez de cambiarlo de paso.
 *
 * Vive aquí, y no en `model/acceso.ts` donde se usa, para que la mitad de la
 * cadena que necesita no salga de este archivo.
 */
export async function condominiosSupervisados(
  ctx: Ctx,
  userId: Id<"users">,
  ahora: number = Date.now(),
): Promise<Set<Id<"condominios">>> {
  const filas = await ctx.db
    .query("asignaciones")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();

  const cache = cacheDeCadena(ctx);
  const out = new Set<Id<"condominios">>();
  for (const a of filas) {
    if (a.rol !== "supervisor") continue;
    if (!(await vigenteConSuContrato(a, ahora, cache))) continue;
    out.add(a.condominioId);
  }
  return out;
}

/**
 * Si una asignacion ya existente choca DE VERDAD con una ventana nueva.
 *
 * ── Por que no basta con mirar las fechas ────────────────────────────────
 * Porque en este modelo el significado de una fila no esta en la fila. Una
 * asignacion cuelga del contrato y del miembro precisamente para que
 * terminar el contrato o dar de baja a la persona la invaliden sin tocarla:
 * lo dice el esquema y lo aplica `asignacionVigente` al leer. Terminar un
 * contrato NO le pone fecha de fin a sus asignaciones, a proposito.
 *
 * De modo que una asignacion vieja, sin `vigenciaHasta`, bajo un contrato
 * terminado hace meses, leida sola parece abierta e infinita. Y asi es como
 * un guarda registrado en una compania de pruebas —contrato terminado, baja
 * dada— quedaba bloqueado para siempre en el conjunto: la comprobacion de
 * solape miraba la fila cruda mientras el resto del sistema miraba la cadena.
 *
 * Esta funcion comprueba los mismos cuatro eslabones que `asignacionVigente`
 * —asignacion, contrato, compania, miembro— y vive pegada a ella para que no
 * vuelvan a separarse. Si una asignacion no puede dar acceso, no puede
 * estorbar: no hay nadie ahi con quien chocar.
 *
 * ── Lo que SIGUE bloqueando ──────────────────────────────────────────────
 * Dos asignaciones vivas a la misma porteria a la vez, aunque las traiga otra
 * compania. No se filtra por `companiaId`: la misma persona no puede cubrir
 * dos veces el mismo puesto a la misma hora, y de quien la contrate no
 * depende. Acotar por compania habria hecho pasar este caso, si, pero
 * abriendo justo ese agujero.
 */
export async function asignacionEstorba(
  ctx: Ctx,
  previa: Doc<"asignaciones">,
  nueva: Rango,
): Promise<boolean> {
  /* Lo barato primero. Acotar por el contrato solo puede ENCOGER la ventana,
   * asi que si las fechas crudas ya no se pisan no hay nada que ir a leer, y
   * el caso normal no cuesta una sola consulta. */
  if (!haySolape(previa, nueva)) return false;

  /* Sin contrato no ampara nada. No deberia pasar; si pasa, la fila esta
   * huerfana y no es motivo para bloquear a nadie. */
  const cache = cacheDeCadena(ctx);
  const contrato = await cache.contrato(previa.contratoId);
  if (!contrato) return false;
  if (!haySolape(acotado(previa, contrato), nueva)) return false;

  /* Los eslabones de las personas son los mismos de la cadena; lo único
   * distinto aquí es que las fechas se miran contra la ventana nueva y no
   * contra ahora. */
  return (await personalDeAlta(previa, cache)) !== null;
}
