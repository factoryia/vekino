import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { exigirAcceso } from "./model/acceso";
import {
  motivoDeSuspension,
  viasDeGuardiaDelConjunto,
  viasOperativasEnConjunto,
  type Via,
  type ViaMembership,
} from "./model/vias";
import { displayNameFromUser } from "./model/displayName";
import { lectorDeCoberturasHistoricas } from "./model/cobertura";
import { logNovedadItem } from "./model/inventarioNovedad";
import {
  aVistaCustodiaGuarda,
  cacheDeUsuarios,
  custodiaActiva,
  custodiaGuardaActiva,
  custodiasDeItem,
  custodiasGuardaDeCondominio,
  custodiasGuardaDeItem,
} from "./model/inventarioCustodia";
import { MAX_OBSERVACION, normalizarTexto } from "./lib/inventario";

/**
 * LA CUSTODIA INTERNA DE UN CONJUNTO: el supervisor reparte el material.
 *
 * El nivel de abajo de la cadena:
 *
 *     compañía → elemento → conjunto → guarda
 *
 * El elemento NUNCA deja de ser de la compañía ni deja de estar asignado al
 * conjunto: que un guarda lo tenga es una custodia ANIDADA dentro de aquélla.
 * Por eso las filas de aquí cuelgan de `inventarioAsignaciones` y no del
 * elemento.
 *
 * Quién manda: el SUPERVISOR de ese conjunto, con la capacidad
 * `inventario.custodiar`. No el administrador de la compañía —que conserva la
 * consulta pero no reparte material dentro de una portería en la que no
 * está— ni el guarda, ni el administrador del conjunto.
 *
 * Lo que NO hay aquí, deliberadamente: mover el elemento a otro conjunto,
 * devolverlo a la compañía, archivarlo o tocar su estado. Eso es de las
 * tareas 1 y 2 y sigue siendo del administrador de la compañía.
 *
 * El guarda nunca es quien obra aquí: es a quien se le entrega. Lo que sí
 * depende de él es si HOY opera en esta portería —para recibir material, para
 * salir en el desplegable y para no figurar como "pendiente"—, y eso se
 * pregunta con las vías operativas de `model/vias.ts`, las mismas con las que
 * le abre la portería: con una cobertura activa opera en el conjunto que
 * cubre y no en los suyos de siempre. Las reglas del supervisor que reparte
 * no cambian con la cobertura de nadie.
 */

/** Cuántas custodias abiertas de una portería se leen de una vez. */
const TOPE_CUSTODIAS = 1000;

/** Cuántas filas de historial devuelve la ficha de un elemento. */
const TOPE_HISTORIAL = 100;

// ─────────────────────────────────────────────────────────────
// La cadena de comprobaciones
// ─────────────────────────────────────────────────────────────

type Contexto = {
  item: Doc<"inventarioItems">;
  /** La custodia del conjunto de la que cuelga todo. */
  asignacion: Doc<"inventarioAsignaciones">;
  condominioId: Id<"condominios">;
  /** El supervisor que obra. */
  user: Doc<"users">;
  /**
   * La compañía por la que supervisa. Se devuelve resuelta para que quien
   * necesite el ámbito NO vuelva a llamar a `exigirAcceso`: resolverlo cuesta
   * cinco lecturas por índice, y hacerlo dos veces en la misma consulta es
   * además una segunda copia de la misma comprobación.
   */
  companiaId: Id<"companiasSeguridad">;
};

/**
 * Resuelve la cadena entera antes de dejar tocar nada.
 *
 *     elemento → su custodia de conjunto → ese conjunto →
 *     ¿el supervisor manda ahí? → ¿es de SU compañía?
 *
 * NINGÚN eslabón viene del cliente. El conjunto sale de la custodia activa del
 * elemento, no de los argumentos: si viniera de fuera, bastaría con mandar el
 * id de un conjunto donde uno sí es supervisor para operar sobre el material
 * de otro.
 *
 * La comprobación de compañía es la que no se ve venir. `exigirAcceso` dice
 * "esta persona es supervisora de este conjunto", y eso es cierto para los
 * supervisores de TODAS las empresas que lo cubran —dos compañías en la misma
 * portería es un caso real—. Sin comparar la compañía, el supervisor de la
 * empresa B podría repartir los radios de la empresa A.
 */
async function exigirCadena(
  ctx: QueryCtx | MutationCtx,
  itemId: Id<"inventarioItems">,
): Promise<Contexto> {
  const item = await ctx.db.get(itemId);
  if (!item) throw new Error("Elemento no encontrado.");

  /* Un elemento archivado no está en ninguna portería: la tarea 2 impide
   * archivar algo entregado, así que llegar aquí con uno archivado significa
   * que nunca salió. Se comprueba igualmente. */
  if (item.archivadoEn != null) {
    throw new Error("Este elemento está archivado.");
  }

  const asignacion = await custodiaActiva(ctx, item._id);
  if (!asignacion) {
    throw new Error(
      "Este elemento no está asignado a ningún conjunto ahora mismo.",
    );
  }

  const acceso = await exigirAcceso(
    ctx,
    asignacion.condominioId,
    "inventario.custodiar",
  );

  /* El elemento tiene que ser de la MISMA compañía por la que esta persona
   * supervisa el conjunto. */
  if (acceso.compania && acceso.compania._id !== item.companiaId) {
    throw new Error("Ese elemento no pertenece a tu compañía.");
  }

  return {
    item,
    asignacion,
    condominioId: asignacion.condominioId,
    user: acceso.user,
    companiaId: exigirCompaniaDelAcceso(acceso.compania),
  };
}

/**
 * La compañía por la que esta persona supervisa el conjunto.
 *
 * Se saca del acceso y no de los argumentos. Para el personal de vigilancia
 * siempre existe; para el staff de plataforma —que tiene paso libre a todo
 * pero no pertenece a ninguna empresa— no hay compañía que deducir, y esta
 * pantalla no es la suya: la plataforma consulta el inventario desde la ficha
 * de la compañía. Se dice en vez de enseñar una lista vacía o, peor, la de
 * todas las empresas mezcladas.
 */
function exigirCompaniaDelAcceso(
  compania: Doc<"companiasSeguridad"> | null,
): Id<"companiasSeguridad"> {
  if (!compania) {
    throw new Error(
      "Esta vista es la del supervisor de una compañía. Consulta el inventario desde la ficha de la compañía.",
    );
  }
  return compania._id;
}

/**
 * Los guardas que HOY operan en esta portería por cuenta de esta compañía.
 *
 * Sale de `viasDeGuardiaDelConjunto`, la resolución con la que la portería
 * arma su relevo: la cadena entera de cada vía y el contexto de cobertura ya
 * aplicado. Así el guarda que hoy cubre otro conjunto no figura aquí aunque
 * su asignación siga viva, y el que cubre éste sí, aunque no tenga ninguna.
 *
 * Solo las vías de una compañía (asignación o cobertura) y solo de ESTA: el
 * material es de la empresa, y dos empresas pueden cubrir la misma portería.
 * La membresía de un guarda propio del conjunto no cuenta, como no contó
 * nunca: no es personal de la compañía.
 *
 * No es la plantilla (`guardasDelConjunto`, que sigue siendo quién está
 * asignado de forma permanente): es quién está de turno posible hoy.
 */
async function guardasOperativos(
  ctx: QueryCtx | MutationCtx,
  condominioId: Id<"condominios">,
  companiaId: Id<"companiasSeguridad">,
): Promise<{ userId: Id<"users">; nombre: string }[]> {
  const vias = await viasDeGuardiaDelConjunto(ctx, condominioId);
  const ids = new Set(
    vias
      .filter((v): v is Exclude<Via, ViaMembership> => v.tipo !== "membership")
      .filter((v) => v.companiaId === companiaId)
      .map((v) => v.userId),
  );
  const filas = await Promise.all(
    [...ids].map(async (userId) => {
      const u = await ctx.db.get(userId);
      if (!u || !u.active) return null;
      return { userId: u._id, nombre: displayNameFromUser(u) };
    }),
  );
  return filas
    .filter((g): g is NonNullable<typeof g> => g !== null)
    .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
}

function exigirObservacion(bruto: string | undefined): string | undefined {
  const texto = normalizarTexto(bruto);
  if (texto && texto.length > MAX_OBSERVACION) {
    throw new Error(
      `La observación no puede superar ${MAX_OBSERVACION} caracteres.`,
    );
  }
  return texto;
}

// ─────────────────────────────────────────────────────────────
// Lectura
// ─────────────────────────────────────────────────────────────

/**
 * Los guardas a los que este supervisor puede entregar material hoy.
 *
 * Sale de `guardasOperativos`: la cadena entera y el contexto de cobertura,
 * filtrado por compañía, así que no ofrece a un guarda de la empresa de al
 * lado que cubre la misma portería ni a uno propio que hoy cubre otra.
 */
export const guardasDisponibles = query({
  args: { condominioId: v.id("condominios") },
  handler: async (ctx, args) => {
    const acceso = await exigirAcceso(
      ctx,
      args.condominioId,
      "inventario.custodiar",
    );
    const companiaId = exigirCompaniaDelAcceso(acceso.compania);
    return await guardasOperativos(ctx, args.condominioId, companiaId);
  },
});

/**
 * El material que este conjunto tiene hoy, y en manos de quién.
 *
 * DOS lecturas indexadas para toda la pantalla, pase lo que pase:
 *   1. las custodias de conjunto abiertas de esta compañía en este conjunto;
 *   2. las custodias de guarda abiertas, indexadas por elemento.
 * Más una por elemento para hidratarlo, que es inevitable —son documentos
 * distintos— pero va en paralelo y no encadenada.
 *
 * Los guardas que hoy operan aquí se resuelven UNA vez para todo el listado:
 * es lo que permite marcar los pendientes sin preguntar por cada fila.
 * "Pendiente" es material en manos de quien hoy NO opera en esta portería: el
 * guarda que se fue a cubrir otro conjunto con un radio de éste, o el que
 * cubrió éste y ya terminó. Por eso se mira con las vías operativas.
 */
export const itemsDelCondominio = query({
  args: { condominioId: v.id("condominios") },
  handler: async (ctx, args) => {
    const acceso = await exigirAcceso(
      ctx,
      args.condominioId,
      "inventario.custodiar",
    );
    const companiaId = exigirCompaniaDelAcceso(acceso.compania);

    const asignaciones = await ctx.db
      .query("inventarioAsignaciones")
      .withIndex("by_compania_condominio_devuelta", (q) =>
        q
          .eq("companiaId", companiaId)
          .eq("condominioId", args.condominioId)
          .eq("devueltaEn", undefined),
      )
      .order("desc")
      .take(TOPE_CUSTODIAS + 1);

    const truncado = asignaciones.length > TOPE_CUSTODIAS;
    const enElConjunto = asignaciones.slice(0, TOPE_CUSTODIAS);

    const { porItem: custodias, incompleto: custodiaIncompleta } =
      await custodiasGuardaDeCondominio(
        ctx,
        companiaId,
        args.condominioId,
        TOPE_CUSTODIAS,
      );

    /* Una sola resolución de "quién opera hoy aquí", no una por fila. */
    const vigentes = new Set(
      (await guardasOperativos(ctx, args.condominioId, companiaId)).map(
        (g) => g.userId,
      ),
    );
    const usuario = cacheDeUsuarios(ctx);
    const contexto = lectorDeCoberturasHistoricas(ctx);

    const items = await Promise.all(
      enElConjunto.map((a) => ctx.db.get(a.itemId)),
    );

    const filas = await Promise.all(
      enElConjunto.map(async (a, i) => {
        const item = items[i];
        if (!item) return null;
        const c = custodias.get(item._id);
        return {
          itemId: item._id,
          nombre: item.nombre,
          serial: item.serial ?? null,
          descripcion: item.descripcion ?? null,
          fotoUrl: item.fotoUrl ?? null,
          /* El estado FÍSICO. No se mezcla con la custodia: un radio averiado
           * en manos de Juan tiene que poder decir las dos cosas. */
          estado: item.estado,
          asignadaEnElConjuntoDesde: a.asignadaEn,
          custodia: c
            ? await aVistaCustodiaGuarda(ctx, c, usuario, vigentes, contexto)
            : null,
        };
      }),
    );

    const utiles = filas.filter((f): f is NonNullable<typeof f> => f !== null);

    return {
      items: utiles.sort((a, b) => a.nombre.localeCompare(b.nombre, "es")),
      truncado,
      /**
       * El mapa de custodias se quedó corto: `custodia: null` deja de
       * significar "está en la portería" y pasa a significar "no se sabe".
       * Callarlo haría que la pantalla ofreciera "Entregar" sobre algo que
       * alguien ya tiene, y que el contador de pendientes de abajo se
       * presentara como exacto sin serlo.
       */
      custodiaIncompleta,
      /* Cuántos elementos están en manos de alguien que ya no cubre este
       * conjunto. Es el número que hay que mirar antes de cerrar un turno. */
      pendientes: utiles.filter((f) => f.custodia?.pendiente === true).length,
    };
  },
});

/**
 * El historial de manos por las que ha pasado un elemento.
 *
 * NO pasa por `exigirCadena`, y ésa es la diferencia con las mutaciones: se
 * autoriza sobre la ÚLTIMA estancia del elemento en un conjunto, esté abierta
 * o cerrada. Exigir que siga asignado dejaba al supervisor sin poder consultar
 * por qué manos pasó un radio en su portería en cuanto la compañía se lo
 * llevaba de vuelta — que es exactamente el momento en que se reclama un
 * faltante.
 *
 * Sigue siendo su portería y sigue haciendo falta `inventario.custodiar` allí,
 * así que no abre nada: solo deja de cerrarse en el peor momento.
 */
export const historialDeItem = query({
  args: { itemId: v.id("inventarioItems") },
  handler: async (ctx, args) => {
    const item = await ctx.db.get(args.itemId);
    if (!item) throw new Error("Elemento no encontrado.");

    /* La última estancia, abierta o cerrada. Sin ninguna, no hay conjunto
     * desde el que preguntar y no hay nada que contar. */
    const [ultima] = await custodiasDeItem(ctx, item._id, 1);
    if (!ultima) return [];

    const acceso = await exigirAcceso(
      ctx,
      ultima.condominioId,
      "inventario.custodiar",
    );
    const companiaId = exigirCompaniaDelAcceso(acceso.compania);
    if (companiaId !== item.companiaId) {
      throw new Error("Ese elemento no pertenece a tu compañía.");
    }
    const condominioId = ultima.condominioId;

    const vigentes = new Set(
      (await guardasOperativos(ctx, condominioId, companiaId)).map(
        (g) => g.userId,
      ),
    );

    const filas = await custodiasGuardaDeItem(ctx, item._id, TOPE_HISTORIAL);
    const usuario = cacheDeUsuarios(ctx);
    const contexto = lectorDeCoberturasHistoricas(ctx);
    return await Promise.all(
      filas.map((c) => aVistaCustodiaGuarda(ctx, c, usuario, vigentes, contexto)),
    );
  },
});

// ─────────────────────────────────────────────────────────────
// Escritura
// ─────────────────────────────────────────────────────────────

/**
 * Entrega a un guarda un elemento que el conjunto ya tiene.
 *
 * Las comprobaciones, todas en el servidor y en este orden:
 *   1. el elemento existe y no está archivado;
 *   2. está asignado a un conjunto AHORA (si no, no hay nada que repartir);
 *   3. quien obra es supervisor de ESE conjunto;
 *   4. el elemento es de la compañía por la que lo supervisa;
 *   5. el guarda opera HOY en ese conjunto como guarda y por la misma
 *      compañía: su asignación vigente o su cobertura activa, con el contexto
 *      de cobertura aplicado;
 *   6. el elemento no está ya en manos de otro guarda.
 *
 * El doble submit no necesita candado: la mutación es una transacción
 * serializable, así que la segunda llamada lee la custodia que abrió la
 * primera y se rechaza sola.
 */
export const entregar = mutation({
  args: {
    itemId: v.id("inventarioItems"),
    guardaUserId: v.id("users"),
    observacion: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { item, asignacion, condominioId, user } = await exigirCadena(
      ctx,
      args.itemId,
    );

    /* La cadena entera del guarda, no solo su id, y con su contexto.
     *
     * `viasOperativasEnConjunto` es el mismo criterio con el que la portería
     * le deja entrar: asignación, contrato, compañía activa, miembro no dado
     * de baja, conjunto activo y, encima, la cobertura. Comprobar solo que
     * existe el `userId` habría dejado entregar material a alguien despedido
     * la semana pasada; mirar solo su asignación, entregarle el radio de este
     * conjunto mientras está cubriendo otro. Cuenta la vía de una compañía
     * —asignación o cobertura—, la primera, como antes la asignación vigente;
     * la membresía de un guarda propio no, como no contó nunca. */
    const { vias, suspendidas, contexto } = await viasOperativasEnConjunto(
      ctx,
      args.guardaUserId,
      condominioId,
    );
    const via = vias.find(
      (v): v is Exclude<Via, ViaMembership> => v.tipo !== "membership",
    );
    if (!via) {
      if (contexto.tipo !== "permanente" && suspendidas.some((v) => v.tipo === "asignacion")) {
        throw new Error(motivoDeSuspension(contexto));
      }
      throw new Error(
        "Esa persona no tiene una asignación vigente en este conjunto.",
      );
    }
    if (via.rol !== "guardia") {
      throw new Error("Esa persona no está asignada como guarda aquí.");
    }
    /* Y de NUESTRA compañía: dos empresas pueden cubrir la misma portería, y
     * el material de una no se le entrega al personal de la otra. */
    if (via.companiaId !== item.companiaId) {
      throw new Error("Ese guarda es de otra compañía.");
    }

    const yaLoTiene = await custodiaGuardaActiva(ctx, item._id);
    if (yaLoTiene) {
      const quien = await ctx.db.get(yaLoTiene.guardaUserId);
      throw new Error(
        yaLoTiene.guardaUserId === args.guardaUserId
          ? "Ese guarda ya tiene este elemento."
          : `Este elemento lo tiene ${quien?.name ?? "otro guarda"}. Regístrale la devolución antes de entregarlo.`,
      );
    }

    const observacion = exigirObservacion(args.observacion);
    const ahora = Date.now();
    const guarda = await ctx.db.get(args.guardaUserId);

    const custodiaId = await ctx.db.insert("inventarioCustodiaGuardas", {
      /* Cuelga de la custodia del conjunto: cerrarla invalida ésta sin tocar
       * una fila, igual que `asignaciones` cuelga del contrato. */
      inventarioAsignacionId: asignacion._id,
      /* Si lo recibe porque cubre este conjunto, queda dicho: es la vía con la
       * que se le acaba de aceptar, no una suposición posterior. */
      ...(via.tipo === "cobertura" ? { coberturaId: via.cobertura._id } : {}),
      itemId: item._id,
      companiaId: item.companiaId,
      condominioId,
      guardaUserId: args.guardaUserId,
      entregadaEn: ahora,
      entregadaPorUserId: user._id,
      ...(observacion ? { observacionEntrega: observacion } : {}),
      createdAt: ahora,
    });

    /* El mismo mecanismo de auditoría de las tareas 1 y 2, no uno nuevo. El
     * nombre del guarda va copiado dentro del texto —si se da de baja, la
     * línea tiene que seguir diciendo a quién se le entregó— y el id
     * estructurado va en `guardaUserId`, que la tarea 1 dejó declarado. */
    await logNovedadItem(ctx, {
      itemId: item._id,
      companiaId: item.companiaId,
      tipo: "ITEM_ASSIGNED_TO_GUARD",
      descripcion: observacion
        ? `Entregado al guarda ${guarda?.name ?? "(sin nombre)"}. ${observacion}`
        : `Entregado al guarda ${guarda?.name ?? "(sin nombre)"}.`,
      condominioId,
      guardaUserId: args.guardaUserId,
      actor: user,
    });

    return { custodiaId };
  },
});

/**
 * Recibe de vuelta un elemento que tenía un guarda.
 *
 * NO termina la asignación del elemento al conjunto: el radio vuelve al
 * cuarto de la portería, no a la bodega de la empresa. Después de esto el
 * elemento queda libre para entregárselo a otro guarda del mismo conjunto.
 *
 * A propósito NO exige que el guarda siga asignado. Si a Juan se le acabó el
 * contrato y aparece con el radio un mes después, recibírselo es exactamente
 * lo que hay que poder hacer; exigirlo dejaría el pendiente abierto para
 * siempre.
 */
export const recibir = mutation({
  args: {
    itemId: v.id("inventarioItems"),
    observacion: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { item, user, condominioId } = await exigirCadena(ctx, args.itemId);

    const abierta = await custodiaGuardaActiva(ctx, item._id);
    /* Idempotente, igual que el resto del módulo: con dos pestañas abiertas,
     * el segundo clic no reescribe quién lo recibió ni añade otra línea. */
    if (!abierta) return { yaEstaba: true as const };

    const observacion = exigirObservacion(args.observacion);
    const guarda = await ctx.db.get(abierta.guardaUserId);
    const ahora = Date.now();

    await ctx.db.patch(abierta._id, {
      devueltaEn: ahora,
      devueltaPorUserId: user._id,
      ...(observacion ? { observacionDevolucion: observacion } : {}),
    });

    await logNovedadItem(ctx, {
      itemId: item._id,
      companiaId: item.companiaId,
      tipo: "ITEM_RETURNED_BY_GUARD",
      descripcion: observacion
        ? `Devuelto por el guarda ${guarda?.name ?? "(sin nombre)"}. ${observacion}`
        : `Devuelto por el guarda ${guarda?.name ?? "(sin nombre)"}.`,
      condominioId,
      guardaUserId: abierta.guardaUserId,
      actor: user,
    });

    return { yaEstaba: false as const, custodiaId: abierta._id };
  },
});

/**
 * Registra una novedad sobre el elemento. NO cambia su estado.
 *
 * Va al MISMO historial que todo lo demás. El modelo de la tarea 1 ya lo
 * soportaba entero —conjunto, guarda, actor, descripción, fecha— así que no
 * hace falta ni una tabla nueva ni un campo nuevo: solo un literal más en el
 * enum. Una segunda bitácora habría partido en dos la historia del elemento,
 * que es lo único que este módulo tiene que saber contar entero.
 *
 * Y NO toca `estado`, deliberadamente. "El radio presenta interferencia" es
 * una observación, no un diagnóstico; convertirla en `averiado` dejaría que
 * cualquiera sacara material de circulación con una frase. Los tres ejes
 * —evento, estado y custodia— siguen separados, igual que desde la tarea 1.
 *
 * Si hay un guarda con el elemento, la novedad queda ligada a él sin que haya
 * que decirlo: es la información que hace falta para reclamar después.
 */
export const registrarNovedad = mutation({
  args: {
    itemId: v.id("inventarioItems"),
    descripcion: v.string(),
  },
  handler: async (ctx, args) => {
    const { item, user, condominioId } = await exigirCadena(ctx, args.itemId);

    const descripcion = normalizarTexto(args.descripcion);
    if (!descripcion) throw new Error("Escribe la novedad.");
    if (descripcion.length > MAX_OBSERVACION) {
      throw new Error(
        `La novedad no puede superar ${MAX_OBSERVACION} caracteres.`,
      );
    }

    const abierta = await custodiaGuardaActiva(ctx, item._id);

    const novedadId = await logNovedadItem(ctx, {
      itemId: item._id,
      companiaId: item.companiaId,
      tipo: "ITEM_NOTE",
      descripcion,
      condominioId,
      ...(abierta ? { guardaUserId: abierta.guardaUserId } : {}),
      actor: user,
    });

    return { novedadId };
  },
});
