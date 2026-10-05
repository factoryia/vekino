import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { getCurrentAppUser, requireAppUser } from "./model/authz";
import {
  exigirAccesoContrato,
  resolverAcceso,
  getCompaniaMiembro,
  condominiosSupervisados,
} from "./model/acceso";
import {
  asignacionEstorba,
  asignacionVigente,
  guardasDelConjunto,
  misAsignacionesVigentes,
} from "./model/asignacion";
import { rolAsignacionValidator } from "./model/roles";
import {
  acotado,
  cabeDentro,
  estaVigente,
  estadoVigencia,
  type Capacidad,
} from "./lib/vigilancia";
import { displayNameFromUser } from "./model/displayName";

/**
 * Asignaciones: quién opera en qué conjunto, desde cuándo y hasta cuándo.
 *
 * Es la tabla que une los dos ejes. Cuelga del CONTRATO, así que terminar un
 * contrato corta el acceso de todo su personal sin escribir una fila más.
 *
 * Nunca se borra una asignación: se le pone `vigenciaHasta`. Por eso se puede
 * responder dónde estaba asignada una persona en una fecha dada, que es lo
 * que sostiene la trazabilidad cuando alguien cambia de conjunto a mitad de
 * año.
 */

/**
 * Quién puede tocar las asignaciones de un contrato.
 *
 * El conjunto y la compañía salen SIEMPRE del documento del contrato, nunca
 * de un argumento del cliente. Manipular el `contratoId` de la petición no
 * abre nada: lleva a otro contrato, cuya compañía se vuelve a comprobar.
 */
async function exigirGestionDeContrato(
  ctx: QueryCtx,
  contrato: Doc<"companiaContratos">,
  capacidad: Capacidad = "seguridad.asignar",
) {
  return await exigirAccesoContrato(ctx, contrato, capacidad);
}

/**
 * El estado que se muestra sale de la asignación ACOTADA por su contrato.
 *
 * Mirando la fila sola, una asignación sin fecha de fin bajo un contrato
 * terminado sale "vigente" para siempre — y eso es lo que leía el
 * administrador del conjunto en "quién cubre hoy mi portería": gente
 * autorizada a entrar que en realidad ya no lo está. El acceso nunca estuvo
 * abierto, `asignacionVigente` sí comprueba el contrato; lo que estaba mal
 * era lo que se contaba en pantalla.
 */
async function hidratar(
  ctx: QueryCtx,
  a: Doc<"asignaciones">,
  /** Si quien llama ya lo tiene, se ahorra la lectura. */
  contratoConocido?: Doc<"companiaContratos"> | null,
) {
  const [u, condo, compania, contrato] = await Promise.all([
    ctx.db.get(a.userId),
    ctx.db.get(a.condominioId),
    ctx.db.get(a.companiaId),
    contratoConocido !== undefined
      ? Promise.resolve(contratoConocido)
      : ctx.db.get(a.contratoId),
  ]);
  return {
    _id: a._id,
    userId: a.userId,
    nombre: u ? displayNameFromUser(u) : "(perfil eliminado)",
    email: u?.email ?? null,
    condominioId: a.condominioId,
    condominioNombre: condo?.name ?? "(conjunto eliminado)",
    companiaId: a.companiaId,
    companiaNombre: compania?.nombre ?? "(compañía eliminada)",
    contratoId: a.contratoId,
    companiaMiembroId: a.companiaMiembroId,
    rol: a.rol,
    vigenciaDesde: a.vigenciaDesde,
    vigenciaHasta: a.vigenciaHasta ?? null,
    estado: estadoVigencia(contrato ? acotado(a, contrato) : a),
    createdAt: a.createdAt,
  };
}

// ─────────────────────────────────────────────────────────────
// Escritura
// ─────────────────────────────────────────────────────────────

/**
 * Asigna a una persona de la compañía a un conjunto.
 *
 * Tres reglas, todas derivadas de algo real:
 *
 *  1. El rol debe estar entre los que esa persona tiene en la compañía. No se
 *     puede asignar como supervisor a quien la compañía no reconoce como tal.
 *
 *  2. La asignación tiene que caber dentro del contrato. Asignar a alguien
 *     hasta enero bajo un contrato que termina en diciembre promete un acceso
 *     que el modelo va a negar, y el error aparecería en la portería un mes
 *     después en vez de al guardar.
 *
 *  3. La misma persona no puede tener dos asignaciones VIVAS que se pisen en
 *     el MISMO conjunto. Dos asignaciones simultáneas en conjuntos DISTINTOS
 *     sí son válidas: es el guarda que cubre dos porterías, un caso real y
 *     pedido. Lo que no tiene sentido es estar asignado dos veces al mismo
 *     sitio, con el mismo rol o con roles distintos.
 *
 *     "Vivas" es la palabra que faltaba. Una asignación cuyo contrato se
 *     terminó no da acceso a nadie —así está hecho el modelo, y terminar un
 *     contrato no le escribe fecha de fin a sus asignaciones a propósito—,
 *     así que tampoco puede chocar con nada. Mirando la fila cruda parecía
 *     abierta para siempre, y un guarda que pasó por una compañía de pruebas
 *     quedaba vetado del conjunto de por vida. Lo decide `asignacionEstorba`,
 *     que comprueba la misma cadena que `asignacionVigente`.
 */
export const crear = mutation({
  args: {
    contratoId: v.id("companiaContratos"),
    companiaMiembroId: v.id("companiaMiembros"),
    rol: rolAsignacionValidator,
    vigenciaDesde: v.number(),
    vigenciaHasta: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const contrato = await ctx.db.get(args.contratoId);
    if (!contrato) throw new Error("Contrato no encontrado.");
    const { user } = await exigirGestionDeContrato(ctx, contrato);

    const miembro = await ctx.db.get(args.companiaMiembroId);
    if (!miembro) throw new Error("Miembro no encontrado.");
    if (miembro.companiaId !== contrato.companiaId) {
      throw new Error("Esa persona no pertenece a la compañía del contrato.");
    }
    if (!miembro.isActive) {
      throw new Error("Esa persona está dada de baja en la compañía.");
    }

    // Regla 1
    if (!miembro.roles.includes(args.rol)) {
      throw new Error(
        `Esa persona no tiene el rol "${args.rol}" en la compañía.`,
      );
    }

    if (
      args.vigenciaHasta != null &&
      args.vigenciaHasta < args.vigenciaDesde
    ) {
      throw new Error("La fecha de fin no puede ser anterior a la de inicio.");
    }

    const nueva = {
      vigenciaDesde: args.vigenciaDesde,
      vigenciaHasta: args.vigenciaHasta,
    };

    // Regla 2
    if (!cabeDentro(nueva, contrato)) {
      throw new Error(
        "La asignación no cabe dentro de la vigencia del contrato.",
      );
    }

    // Regla 3
    const previas = await ctx.db
      .query("asignaciones")
      .withIndex("by_user_condominio", (q) =>
        q
          .eq("userId", miembro.userId)
          .eq("condominioId", contrato.condominioId),
      )
      .collect();
    for (const previa of previas) {
      if (await asignacionEstorba(ctx, previa, nueva)) {
        throw new Error(
          "Esa persona ya tiene una asignación que se solapa con esas fechas en este conjunto.",
        );
      }
    }

    return await ctx.db.insert("asignaciones", {
      contratoId: args.contratoId,
      companiaMiembroId: args.companiaMiembroId,
      userId: miembro.userId,
      condominioId: contrato.condominioId,
      companiaId: contrato.companiaId,
      rol: args.rol,
      vigenciaDesde: args.vigenciaDesde,
      vigenciaHasta: args.vigenciaHasta,
      creadoPorUserId: user._id,
      createdAt: Date.now(),
    });
  },
});

/**
 * Termina una asignación poniéndole fecha de fin.
 *
 * No se borra: mover a un guarda de conjunto en julio no debe hacer
 * desaparecer que estuvo en el otro de enero a junio.
 */
export const terminar = mutation({
  args: {
    asignacionId: v.id("asignaciones"),
    /** Último día asignado. Ausente = sacarlo del conjunto ahora. */
    vigenciaHasta: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const asignacion = await ctx.db.get(args.asignacionId);
    if (!asignacion) throw new Error("Asignación no encontrada.");
    const contrato = await ctx.db.get(asignacion.contratoId);
    if (!contrato) throw new Error("Contrato no encontrado.");
    const { user } = await exigirGestionDeContrato(ctx, contrato);

    const ahora = Date.now();
    /* Repetir la petición no reescribe quién lo sacó ni corre la fecha. */
    if (estadoVigencia(asignacion, ahora) === "terminada") {
      return { ok: true as const, yaEstaba: true as const };
    }

    if (args.vigenciaHasta != null) {
      if (args.vigenciaHasta < asignacion.vigenciaDesde) {
        throw new Error("La fecha de fin no puede ser anterior a la de inicio.");
      }
      await ctx.db.patch(args.asignacionId, {
        vigenciaHasta: args.vigenciaHasta,
      });
    } else {
      /* Mismo motivo que en el contrato: `vigenciaHasta` es una fecha y le
       * sobra el día entero, así que "sacarlo ahora" lo dejaba operando la
       * portería hasta mañana. */
      await ctx.db.patch(args.asignacionId, {
        terminadoEn: ahora,
        terminadoPorUserId: user._id,
      });
    }
    return { ok: true as const, yaEstaba: false as const };
  },
});

/**
 * Traslada a una persona de un conjunto a otro.
 *
 * Es terminar y crear en una sola transacción, y existe porque hacerlo en dos
 * llamadas desde el cliente deja una ventana en la que la persona está en los
 * dos sitios o en ninguno.
 */
export const trasladar = mutation({
  args: {
    asignacionId: v.id("asignaciones"),
    contratoDestinoId: v.id("companiaContratos"),
    rol: rolAsignacionValidator,
    /** Último día en el conjunto actual. */
    hasta: v.number(),
    /** Primer día en el nuevo. */
    desde: v.number(),
    vigenciaHasta: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const actual = await ctx.db.get(args.asignacionId);
    if (!actual) throw new Error("Asignación no encontrada.");
    const contratoActual = await ctx.db.get(actual.contratoId);
    if (!contratoActual) throw new Error("Contrato de origen no encontrado.");
    await exigirGestionDeContrato(ctx, contratoActual);

    const destino = await ctx.db.get(args.contratoDestinoId);
    if (!destino) throw new Error("Contrato de destino no encontrado.");
    const { user } = await exigirGestionDeContrato(ctx, destino);

    const miembro = await ctx.db.get(actual.companiaMiembroId);
    if (!miembro || !miembro.isActive) {
      throw new Error("Esa persona está dada de baja en la compañía.");
    }
    if (miembro.companiaId !== destino.companiaId) {
      throw new Error("El contrato de destino es de otra compañía.");
    }
    if (!miembro.roles.includes(args.rol)) {
      throw new Error(`Esa persona no tiene el rol "${args.rol}" en la compañía.`);
    }
    if (args.hasta < actual.vigenciaDesde) {
      throw new Error("La fecha de salida es anterior a la de entrada.");
    }

    const nueva = {
      vigenciaDesde: args.desde,
      vigenciaHasta: args.vigenciaHasta,
    };
    if (!cabeDentro(nueva, destino)) {
      throw new Error(
        "La nueva asignación no cabe dentro de la vigencia del contrato de destino.",
      );
    }

    const previas = await ctx.db
      .query("asignaciones")
      .withIndex("by_user_condominio", (q) =>
        q.eq("userId", miembro.userId).eq("condominioId", destino.condominioId),
      )
      .collect();
    for (const previa of previas) {
      /* Misma regla que en `crear`: solo estorba lo que sigue vivo. */
      if (await asignacionEstorba(ctx, previa, nueva)) {
        throw new Error(
          "Esa persona ya tiene una asignación que se solapa con esas fechas en el conjunto de destino.",
        );
      }
    }

    await ctx.db.patch(args.asignacionId, { vigenciaHasta: args.hasta });
    const nuevaId = await ctx.db.insert("asignaciones", {
      contratoId: args.contratoDestinoId,
      companiaMiembroId: actual.companiaMiembroId,
      userId: miembro.userId,
      condominioId: destino.condominioId,
      companiaId: destino.companiaId,
      rol: args.rol,
      vigenciaDesde: args.desde,
      vigenciaHasta: args.vigenciaHasta,
      creadoPorUserId: user._id,
      createdAt: Date.now(),
    });
    return { anterior: args.asignacionId, nueva: nuevaId };
  },
});

// ─────────────────────────────────────────────────────────────
// Lectura
// ─────────────────────────────────────────────────────────────

/** Asignaciones de un contrato. Para el panel de la compañía. */
export const porContrato = query({
  args: {
    contratoId: v.id("companiaContratos"),
    incluirTerminadas: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const contrato = await ctx.db.get(args.contratoId);
    if (!contrato) return [];
    await exigirGestionDeContrato(ctx, contrato, "seguridad.asignar");

    const filas = await ctx.db
      .query("asignaciones")
      .withIndex("by_contrato", (q) => q.eq("contratoId", args.contratoId))
      .collect();

    /* El contrato ya está leído: se lo pasamos a `hidratar`, que es quien
     * acota el estado. Antes se corregía aquí a mano —"si el contrato terminó,
     * terminada"— y era el único sitio donde se corregía, así que el mismo
     * listado visto desde el conjunto seguía pintando en verde a gente que ya
     * no puede entrar. Con la cuenta en un solo sitio, coinciden. */
    const todas = await Promise.all(filas.map((a) => hidratar(ctx, a, contrato)));
    const salida = args.incluirTerminadas
      ? todas
      : todas.filter((a) => a.estado !== "terminada");
    return salida.sort((a, b) => b.vigenciaDesde - a.vigenciaDesde);
  },
});

/**
 * Quién cubre hoy un conjunto. La lee el administrador del conjunto.
 *
 * Es la respuesta a "¿quién está autorizado a entrar a mi portería?", que el
 * conjunto tiene todo el derecho a saber aunque el personal no sea suyo.
 */
export const porCondominio = query({
  args: {
    condominioId: v.id("condominios"),
    incluirTerminadas: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const acceso = await resolverAcceso(ctx, args.condominioId);
    if (!acceso || !acceso.capacidades.has("porteria.ver")) {
      throw new Error("No tiene acceso a la vigilancia de este conjunto.");
    }

    const filas = await ctx.db
      .query("asignaciones")
      .withIndex("by_condominio_rol", (q) =>
        q.eq("condominioId", args.condominioId),
      )
      .collect();

    /* Se hidrata antes de filtrar: si se filtrara por la fila cruda volvería
     * a colarse la asignación de un contrato terminado. */
    const todas = await Promise.all(filas.map((a) => hidratar(ctx, a)));
    const salida = args.incluirTerminadas
      ? todas
      : todas.filter((a) => a.estado !== "terminada");

    /* Un guarda puede ver quién más cubre SU portería —es su relevo— pero no
     * los datos de contacto de sus compañeros. El correo solo lo ve quien
     * administra: el conjunto o la compañía. */
    const puedeVerContacto =
      acceso.esPlataforma ||
      acceso.capacidades.has("porteria.configurar") ||
      acceso.asignacion?.rol === "supervisor";

    const ordenada = salida.sort((a, b) => b.vigenciaDesde - a.vigenciaDesde);
    return puedeVerContacto
      ? ordenada
      : ordenada.map((a) => ({ ...a, email: null }));
  },
});

/**
 * Dónde trabaja una persona. Es la consulta del arranque de sesión: un guarda
 * con varias asignaciones tiene que poder elegir en qué conjunto entra.
 *
 * La resolución vive en `model/asignacion.ts` porque `users.me` necesita
 * exactamente lo mismo para saber a dónde mandar a quien acaba de entrar, y
 * dos copias con criterios de vigencia distintos es como se acaba mostrando
 * un conjunto que ya no se cubre.
 */
export const misAsignaciones = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentAppUser(ctx);
    if (!user) return [];
    return await misAsignacionesVigentes(ctx, user._id);
  },
});

/**
 * Los guardas de una compañía que cubren HOY un conjunto.
 *
 * Solo los de ESA compañía: cuando un conjunto cambia de empresa los dos
 * contratos se solapan a propósito durante el empalme, y en esos días quien
 * entra no tiene por qué ver la nómina de la que sale.
 */
/* Movida a `model/asignacion.ts`: la custodia del inventario necesita la
 * misma lista, y dos copias del criterio de vigencia acabarían discrepando. */

/**
 * LOS CONJUNTOS A CARGO DE QUIEN PREGUNTA, Y EN CADA UNO SUS GUARDAS.
 *
 * Dos vías, y las dos resuelven el ámbito en el SERVIDOR: no hay ningún
 * argumento del cliente que manipular.
 *
 *  - `supervisor`: los conjuntos donde tiene asignación vigente con ese rol
 *    —lo mismo que ya aplican `companias.detail` y `historialDePersona`—, así
 *    que un supervisor de la zona norte no ve la sur ni, por supuesto, nada
 *    de otra empresa. `condominiosSupervisados` comprueba asignación y
 *    contrato.
 *
 *  - `admin_compania`: los conjuntos que su empresa atiende HOY. No tiene
 *    asignación —no cubre turnos, dirige a quien los cubre—, así que por la
 *    vía de arriba no alcanzaba ninguno: sus propios supervisores veían la
 *    operación de un conjunto y él no. Lo que lo autoriza es el CONTRATO, el
 *    mismo eslabón del que ya cuelga su `porteria.ver` en `resolverAcceso`;
 *    el día que termina, el conjunto desaparece de aquí y la portería le
 *    rebota igual.
 *
 * Las dos se SUMAN, sin repetir conjunto: quien administra la empresa y
 * además supervisa una zona ve cada conjunto una sola vez, y en los que
 * supervisa la ficha dice eso.
 *
 * Devuelve solo a quien cubre HOY: un guarda cuya asignación o cuyo contrato
 * ya venció dejó de estar bajo su responsabilidad.
 */
export const miEquipo = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentAppUser(ctx);
    if (!user) return [];

    type Conjunto = {
      /** La asignación por la que lo supervisa, si es esa la vía. */
      asignacionId: Id<"asignaciones"> | null;
      condominioId: Id<"condominios">;
      condominioNombre: string;
      condominioLogo: string | null;
      condominioColor: string | null;
      companiaId: Id<"companiasSeguridad">;
      companiaNombre: string;
      /** Por qué está a su cargo. La interfaz lo usa para nombrar el ámbito. */
      via: "supervisor" | "admin_compania";
      vigenciaHasta: number | null;
      guardas: Awaited<ReturnType<typeof guardasDelConjunto>>;
    };

    const porConjunto = new Map<Id<"condominios">, Conjunto>();

    // ── Vía 1: los conjuntos que supervisa.
    const supervisa = await condominiosSupervisados(ctx, user._id);
    if (supervisa.size > 0) {
      const mios = await misAsignacionesVigentes(ctx, user._id);
      const porCondominio = new Map(mios.map((a) => [a.condominioId, a]));

      for (const condominioId of supervisa) {
        const mia = porCondominio.get(condominioId);
        if (!mia) continue;
        porConjunto.set(condominioId, {
          asignacionId: mia.asignacionId,
          condominioId: mia.condominioId,
          condominioNombre: mia.condominioNombre,
          condominioLogo: mia.condominioLogo,
          condominioColor: mia.condominioColor,
          companiaId: mia.companiaId,
          companiaNombre: mia.companiaNombre,
          via: "supervisor",
          vigenciaHasta: mia.vigenciaHasta,
          guardas: await guardasDelConjunto(ctx, condominioId, mia.companiaId),
        });
      }
    }

    // ── Vía 2: los conjuntos contratados por la empresa que administra.
    const miembro = await getCompaniaMiembro(ctx, user._id);
    if (miembro?.roles.includes("admin_compania")) {
      const compania = await ctx.db.get(miembro.companiaId);
      /* Una compañía suspendida no opera, ni siquiera para su administrador:
       * es justo lo que significa suspenderla, y `resolverAcceso` ya se lo
       * niega. Listarlos aquí solo le daría enlaces que rebotan. */
      if (compania && compania.estado === "activa") {
        const contratos = await ctx.db
          .query("companiaContratos")
          .withIndex("by_compania", (q) => q.eq("companiaId", compania._id))
          .collect();

        for (const k of contratos) {
          if (!estaVigente(k)) continue;
          if (porConjunto.has(k.condominioId)) continue;
          const condo = await ctx.db.get(k.condominioId);
          if (!condo || !condo.isActive) continue;

          porConjunto.set(k.condominioId, {
            asignacionId: null,
            condominioId: k.condominioId,
            condominioNombre: condo.name,
            condominioLogo: condo.logo ?? null,
            condominioColor: condo.primaryColor ?? null,
            companiaId: compania._id,
            companiaNombre: compania.nombre,
            via: "admin_compania",
            vigenciaHasta: k.vigenciaHasta ?? null,
            guardas: await guardasDelConjunto(
              ctx,
              k.condominioId,
              compania._id,
            ),
          });
        }
      }
    }

    return [...porConjunto.values()].sort((a, b) =>
      a.condominioNombre.localeCompare(b.condominioNombre, "es"),
    );
  },
});

/**
 * Historial de una persona: dónde estuvo asignada y cuándo.
 *
 * Con `en` responde la pregunta puntual —"¿dónde estaba este guarda el 14 de
 * marzo?"—, que es justo lo que hace falta cuando se revisa un incidente
 * meses después.
 */
export const historialDePersona = query({
  args: {
    userId: v.id("users"),
    en: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const solicitante = await requireAppUser(ctx);
    const esPlataforma =
      solicitante.platformRole === "superadmin" ||
      solicitante.platformRole === "admin";

    const filas = await ctx.db
      .query("asignaciones")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();

    if (!esPlataforma && solicitante._id !== args.userId) {
      /* Solo su propia compañía puede ver su historial. Un administrador de
       * conjunto ve quién cubre SU portería (`porCondominio`), no la carrera
       * de una persona por otras empresas. */
      const objetivo = await getCompaniaMiembro(ctx, args.userId);
      const yo = await getCompaniaMiembro(ctx, solicitante._id);
      const mismaCompania =
        !!objetivo && !!yo && yo.isActive && objetivo.companiaId === yo.companiaId;
      if (!mismaCompania) {
        throw new Error("No tiene acceso al historial de esa persona.");
      }

      const esAdminCompania = yo!.roles.includes("admin_compania");
      if (!esAdminCompania) {
        /* El supervisor solo alcanza a quien pisa alguno de SUS conjuntos.
         * Pertenecer a la misma empresa no basta: un supervisor de la zona
         * norte no tiene por qué ver la carrera del personal de la sur. */
        const supervisa = await condominiosSupervisados(ctx, solicitante._id);
        const seCruzan = filas.some((a) => supervisa.has(a.condominioId));
        if (supervisa.size === 0 || !seCruzan) {
          throw new Error("No tiene acceso al historial de esa persona.");
        }
      }
    }

    const enFecha = args.en;
    const filtradas =
      enFecha == null ? filas : filas.filter((a) => estaVigente(a, enFecha));

    const salida = await Promise.all(
      filtradas.map(async (a) => ({
        ...(await hidratar(ctx, a)),
        estado: estadoVigencia(a, enFecha ?? Date.now()),
      })),
    );
    return salida.sort((a, b) => b.vigenciaDesde - a.vigenciaDesde);
  },
});

/**
 * Qué puede hacer el usuario actual en un conjunto.
 *
 * La respuesta directa a "qué operaciones puede ejecutar un guarda en cada
 * conjunto", y la que el frontend usa para mostrar u ocultar acciones sin
 * duplicar la regla en el cliente.
 */
export const miAcceso = query({
  args: { condominioId: v.id("condominios") },
  handler: async (ctx, args) => {
    const acceso = await resolverAcceso(ctx, args.condominioId);
    if (!acceso) return null;
    return {
      capacidades: [...acceso.capacidades],
      esPlataforma: acceso.esPlataforma,
      rolesConjunto: acceso.membership?.roles ?? [],
      /* De dónde viene el permiso: por la vía directa del conjunto o por una
       * compañía. La interfaz lo necesita para decir "operas aquí por
       * Seguridad Andina, hasta el 30 de junio". */
      viaCompania: acceso.asignacion
        ? {
            asignacionId: acceso.asignacion._id,
            rol: acceso.asignacion.rol,
            companiaId: acceso.compania?._id ?? null,
            companiaNombre: acceso.compania?.nombre ?? null,
            vigenciaHasta: acceso.asignacion.vigenciaHasta ?? null,
            contratoHasta: acceso.contrato?.vigenciaHasta ?? null,
          }
        : null,
      /* Y si opera aquí de paso, por una cobertura: "cubres este conjunto
       * por Seguridad Andina hasta las 18:00". */
      viaCobertura: acceso.cobertura
        ? {
            coberturaId: acceso.cobertura.cobertura._id,
            companiaId: acceso.cobertura.companiaId,
            companiaNombre: acceso.cobertura.compania.nombre,
            inicio: acceso.cobertura.cobertura.inicio,
            fin: acceso.cobertura.cobertura.fin,
          }
        : null,
    };
  },
});
