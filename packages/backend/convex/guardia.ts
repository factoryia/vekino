import { v } from "convex/values";
import { esAporteVoluntario } from "./lib/reporteGuardia";
import { internal } from "./_generated/api";
import { query, mutation } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  getCurrentAppUser,
  requireCondominioRole,
  hasPlatformRole,
  vigentes,
} from "./model/authz";
import { exigirAcceso, resolverAcceso } from "./model/acceso";
import { asignacionVigente } from "./model/asignacion";
import { membershipEn, viaDeMembership } from "./model/vias";
import { logMinuta, rondaEnCurso, turnoAbierto } from "./model/minuta";
import {
  esVisitanteVigente,
  ventanaDiaBogota,
  ventanaHoyBogota,
} from "./model/visitantes";
import { displayNameFromUser } from "./model/displayName";
import { resolveMediaUrl, resolveMediaUrlList } from "./model/files";
import { calcularCosto } from "./lib/costoReserva";
import { validarCierreTurno } from "./lib/cierreTurno";
import { normalizarPlaca } from "./lib/placa";
import { buscarCasas, ordenVinculo, type Ocupante } from "./lib/buscarCasa";
import {
  cajaDeposito,
  crearIncidente,
  depositoDeReserva,
  liquidarYDevolver,
  rolDeQuienOpera,
} from "./model/depositoReserva";

/** Roles que pueden operar la portería. */
const GUARD_ROLES = ["guardia", "administrador", "junta_directiva"] as const;
/** Roles que administran la configuración y el histórico. */
const ADMIN_ROLES = ["administrador", "junta_directiva"] as const;

const tipoDocValidator = v.union(
  v.literal("CC"),
  v.literal("CE"),
  v.literal("NIT"),
  v.literal("PASAPORTE"),
  v.literal("OTRO"),
);
const tipoVisitanteValidator = v.union(
  v.literal("visitante"),
  v.literal("empresa"),
  v.literal("domicilio"),
);
const tipoPaqueteValidator = v.union(
  v.literal("paquete"),
  v.literal("sobre"),
  v.literal("comida"),
  v.literal("mercado"),
  v.literal("otro"),
);
const checklistItemValidator = v.object({
  item: v.string(),
  obligatorio: v.boolean(),
  cantidadEsperada: v.number(),
  cantidadEncontrada: v.number(),
  estadoOk: v.boolean(),
  observacion: v.optional(v.string()),
});

/** URL de subida — @deprecated usar api.files.generateUploadUrl (S3). */
export const generateUploadUrl = mutation({
  args: {},
  handler: async () => {
    throw new Error(
      "Las subidas van a S3. Usa api.files.generateUploadUrl (action).",
    );
  },
});

// ─────────────────────────────────────────────────────────────
// Home / acceso
// ─────────────────────────────────────────────────────────────

/** Inicio del guardia: valida acceso y devuelve la marca del condominio. */
export const home = query({
  args: { condominioId: v.id("condominios") },
  handler: async (ctx, args) => {
    const user = await getCurrentAppUser(ctx);
    if (!user) return { allowed: false as const };

    const condominio = await ctx.db.get(args.condominioId);
    if (!condominio) return { allowed: false as const };

    /* La puerta del turno se pregunta por CAPACIDAD y no por rol: así entra
     * igual el guarda propio del conjunto y el que lo cubre por una compañía
     * de vigilancia, que hasta ahora quedaba fuera de su propia portería.
     * `porteria.operar` es exactamente lo que da GUARD_ROLES —administrador,
     * junta_directiva y guardia— más el guarda asignado; el supervisor NO la
     * tiene, y es correcto: supervisa, no releva. */
    const acceso = await resolverAcceso(ctx, args.condominioId);
    if (!acceso || !acceso.capacidades.has("porteria.operar")) {
      return { allowed: false as const };
    }
    const isPlatform = acceso.esPlataforma;

    return {
      allowed: true as const,
      isPlatform,
      userId: user._id as string,
      userName: displayNameFromUser(user),
      userImage: user.image ?? null,
      userEmail: user.email,
      condominio: {
        _id: condominio._id as string,
        name: condominio.name,
        logo: condominio.logo ?? null,
        primaryColor: condominio.primaryColor ?? null,
      },
    };
  },
});

// ─────────────────────────────────────────────────────────────
// Turnos — el turno gobierna la operación
// ─────────────────────────────────────────────────────────────

/** Turno abierto del condominio (o null). Solo puede haber uno a la vez. */
export const turnoActivo = query({
  args: { condominioId: v.id("condominios") },
  handler: async (ctx, args) => {
    await requireCondominioRole(ctx, args.condominioId, [...GUARD_ROLES]);
    const turno = await turnoAbierto(ctx, args.condominioId);
    if (!turno) return null;
    const rondas = await ctx.db
      .query("guardiaRondas")
      .withIndex("by_turno", (q) => q.eq("turnoId", turno._id))
      .collect();
    return { ...turno, rondasCount: rondas.length };
  },
});

/**
 * Los guardas que hoy pueden estar en la portería de un conjunto, activos.
 *
 * Un solo criterio para dos usos: el catálogo de compañeros y relevos
 * (`equipo`) y la comprobación del relevo en `cerrarTurno`. Si fueran dos
 * copias, el selector acabaría ofreciendo a alguien que el servidor rechaza.
 */
async function guardasDeLaPorteria(
  ctx: QueryCtx | MutationCtx,
  condominioId: Id<"condominios">,
): Promise<{ userId: Id<"users">; nombre: string }[]> {
  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_condominio", (q) => q.eq("condominioId", condominioId))
    .collect();
  const guardias = memberships.filter(
    (m) => viaDeMembership(m)?.roles.includes("guardia") === true,
  );

  /* El turno compartido es de la portería, no de la tabla de la que cuelgue
   * cada uno: los guardas que cubren por compañía son compañeros de turno
   * igual que los del conjunto. Sin esto, dos guardas de la misma garita no
   * se veían y no podían abrir turno juntos. */
  const asignados = await ctx.db
    .query("asignaciones")
    .withIndex("by_condominio_rol", (q) =>
      q.eq("condominioId", condominioId).eq("rol", "guardia"),
    )
    .collect();

  const ids = new Set<Id<"users">>();
  for (const m of guardias) ids.add(m.userId);
  for (const a of asignados) {
    /* Una asignación vigente bajo un contrato vencido no pone a nadie en la
     * garita: se comprueba la cadena entera, no solo la fila.
     *
     * OJO, sin corregir a propósito: esto pregunta si la PERSONA tiene alguna
     * asignación viva aquí, con cualquier rol, y no si ESTA fila de guarda la
     * tiene. Un guarda ascendido a supervisor en el mismo conjunto —fila de
     * guarda terminada, fila de supervisor viva— sigue saliendo como relevo.
     * `guardasDelConjunto` ya juzga cada fila; alinear esto cambia el relevo y
     * queda pendiente de aprobarse aparte. */
    if (!ids.has(a.userId) && (await asignacionVigente(ctx, a.userId, condominioId))) {
      ids.add(a.userId);
    }
  }

  const rows = await Promise.all(
    [...ids].map(async (userId) => {
      const u = await ctx.db.get(userId);
      if (!u || !u.active) return null;
      return { userId: u._id, nombre: u.name };
    }),
  );
  return rows
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
}

/** Usuarios con rol guardia en el condominio (turno compartido y relevo). */
export const equipo = query({
  args: { condominioId: v.id("condominios") },
  handler: async (ctx, args) => {
    const { user } = await requireCondominioRole(ctx, args.condominioId, [...GUARD_ROLES]);
    return (await guardasDeLaPorteria(ctx, args.condominioId)).filter(
      (g) => g.userId !== user._id,
    );
  },
});

/**
 * Inicia turno con checklist de dotación.
 * Reglas: un solo turno abierto por condominio; checklist con al
 * menos 1 ítem. Nombre del guardia (y compañero) en texto libre —
 * suele haber una sola cuenta compartida en portería.
 */
export const iniciarTurno = mutation({
  args: {
    condominioId: v.id("condominios"),
    checklist: v.array(checklistItemValidator),
    observacionesInicio: v.optional(v.string()),
    /** Nombre de quien toma el turno (cuenta compartida). */
    guardiaNombre: v.optional(v.string()),
    /** Legado: userId de segundo guardia (preferir nombre libre). */
    guardiaSecundarioUserId: v.optional(v.id("users")),
    guardiaSecundarioNombre: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireCondominioRole(ctx, args.condominioId, [...GUARD_ROLES]);

    const abierto = await turnoAbierto(ctx, args.condominioId);
    if (abierto) {
      throw new Error(
        `Ya hay un turno abierto (${abierto.guardiaNombre}). Debe cerrarse antes de iniciar otro.`,
      );
    }
    if (args.checklist.length === 0) {
      throw new Error("El checklist de inicio necesita al menos un ítem.");
    }

    const guardiaNombre =
      args.guardiaNombre?.trim() || displayNameFromUser(user);

    let secundarioNombre = args.guardiaSecundarioNombre?.trim() || undefined;
    let secundarioUserId = args.guardiaSecundarioUserId;
    if (secundarioUserId) {
      if (secundarioUserId === user._id) {
        throw new Error("El guardia secundario no puede ser el mismo que inicia el turno.");
      }
      const sec = await ctx.db.get(secundarioUserId);
      if (!sec || !sec.active) throw new Error("Guardia secundario no válido.");
      /* Solo por la vía de membresía, como siempre: el guarda de compañía no
       * entra aquí por id (va por nombre). Abrirlo es un cambio de turnos,
       * no de esta normalización. */
      const { via: secVia } = await membershipEn(ctx, sec._id, args.condominioId);
      if (!secVia?.roles.includes("guardia")) {
        throw new Error("El guardia secundario no tiene rol de guardia en este conjunto.");
      }
      secundarioNombre = secundarioNombre || displayNameFromUser(sec);
    } else {
      secundarioUserId = undefined;
    }

    if (
      secundarioNombre &&
      secundarioNombre.toLowerCase() === guardiaNombre.toLowerCase()
    ) {
      throw new Error("El compañero de turno no puede ser el mismo nombre.");
    }

    const now = Date.now();
    const turnoId = await ctx.db.insert("guardiaTurnos", {
      condominioId: args.condominioId,
      guardiaUserId: user._id,
      guardiaNombre,
      guardiaSecundarioUserId: secundarioUserId,
      guardiaSecundarioNombre: secundarioNombre,
      observacionesInicio: args.observacionesInicio?.trim() || undefined,
      checklist: args.checklist.map((c) => ({
        ...c,
        item: c.item.trim(),
        observacion: c.observacion?.trim() || undefined,
      })),
      estado: "abierto",
      fechaInicio: now,
      createdAt: now,
      updatedAt: now,
    });

    await logMinuta(ctx, {
      condominioId: args.condominioId,
      modulo: "minuta",
      tipo: "Inicio de Turno",
      unidad: "Portería",
      resumen: `Turno iniciado por ${guardiaNombre}${secundarioNombre ? ` (compartido con ${secundarioNombre})` : ""}. Checklist: ${args.checklist.length} ítems.`,
      estado: "abierto",
      actorUserId: user._id,
      actorNombre: guardiaNombre,
      turnoId,
    });
    return turnoId;
  },
});

/**
 * Cierre formal del turno: novedades de los elementos asignados, quién
 * recibe, consignas para el relevo y observaciones generales.
 * Solo el guardia del turno (principal o secundario) o un administrador.
 *
 * Los elementos NO se reciben aquí: son el `checklist` que se firmó al iniciar
 * el turno y no se tocan. El cierre solo dice si volvieron con novedad; no
 * hay argumento por el que colar una lista distinta.
 *
 * `novedadesElementos` y `observacionesCierre` son opcionales en el validador
 * y obligatorios en el handler a propósito: una app móvil sin actualizar que
 * no los manda recibe "escribe las observaciones generales", no un error de
 * validación de argumentos que el guarda no puede entender.
 */
export const cerrarTurno = mutation({
  args: {
    turnoId: v.id("guardiaTurnos"),
    consignas: v.string(),
    /** Relevo elegido del catálogo (`equipo`). Si viene, manda sobre `recibe`. */
    recibeUserId: v.optional(v.id("users")),
    /** Nombre del relevo escrito a mano (cuenta compartida, relevo sin usuario). */
    recibe: v.optional(v.string()),
    observacionesCierre: v.optional(v.string()),
    novedadesElementos: v.optional(v.boolean()),
    novedadesElementosDetalle: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const turno = await ctx.db.get(args.turnoId);
    if (!turno) throw new Error("Turno no encontrado.");
    const { user, membership } = await requireCondominioRole(
      ctx,
      turno.condominioId,
      [...GUARD_ROLES],
    );
    if (turno.estado !== "abierto") throw new Error("El turno ya está cerrado.");

    const esAdmin =
      hasPlatformRole(user, "superadmin", "admin") ||
      (membership?.roles ?? []).some((r) => (ADMIN_ROLES as readonly string[]).includes(r));
    const esDelTurno =
      turno.guardiaUserId === user._id || turno.guardiaSecundarioUserId === user._id;
    if (!esAdmin && !esDelTurno) {
      throw new Error("Solo el guardia del turno puede cerrarlo.");
    }

    /* El relevo del catálogo se comprueba contra el MISMO criterio con el que
     * se ofrece, y su nombre sale de la base, no del cliente. */
    let recibeNombre = args.recibe;
    if (args.recibeUserId) {
      const quienEntrega = [user._id, turno.guardiaUserId, turno.guardiaSecundarioUserId];
      if (quienEntrega.includes(args.recibeUserId)) {
        throw new Error("El relevo debe ser un guarda distinto de quien entrega el turno.");
      }
      const relevo = (await guardasDeLaPorteria(ctx, turno.condominioId)).find(
        (g) => g.userId === args.recibeUserId,
      );
      if (!relevo) {
        throw new Error("El relevo elegido no es un guarda vigente de esta portería.");
      }
      recibeNombre = relevo.nombre;
    }

    const cierre = validarCierreTurno({
      consignas: args.consignas,
      recibe: recibeNombre,
      observacionesCierre: args.observacionesCierre,
      novedadesElementos: args.novedadesElementos,
      novedadesElementosDetalle: args.novedadesElementosDetalle,
      elementosAsignados: turno.checklist.length,
    });

    const now = Date.now();
    await ctx.db.patch(args.turnoId, {
      consignas: cierre.consignas,
      recibe: cierre.recibe,
      recibeUserId: args.recibeUserId,
      observacionesCierre: cierre.observacionesCierre,
      novedadesElementos: cierre.novedadesElementos,
      novedadesElementosDetalle: cierre.novedadesElementosDetalle,
      cerradoPorUserId: user._id,
      estado: "cerrado",
      fechaCierre: now,
      updatedAt: now,
    });

    await logMinuta(ctx, {
      condominioId: turno.condominioId,
      modulo: "minuta",
      tipo: "Cierre de Turno",
      unidad: "Portería",
      resumen:
        `Turno de ${turno.guardiaNombre} cerrado por ${user.name}. Recibe: ${cierre.recibe}. ` +
        (cierre.novedadesElementos
          ? `Novedades en elementos: ${cierre.novedadesElementosDetalle}`
          : "Elementos sin novedad."),
      estado: "cerrado",
      actorUserId: user._id,
      actorNombre: user.name,
      turnoId: args.turnoId,
    });
  },
});

/** Histórico de turnos (admin) con conteo de rondas. */
export const listTurnos = query({
  args: { condominioId: v.id("condominios") },
  handler: async (ctx, args) => {
    await exigirAcceso(ctx, args.condominioId, "porteria.ver");
    const turnos = await ctx.db
      .query("guardiaTurnos")
      .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
      .order("desc")
      .take(100);
    return await Promise.all(
      turnos.map(async (t) => {
        const rondas = await ctx.db
          .query("guardiaRondas")
          .withIndex("by_turno", (q) => q.eq("turnoId", t._id))
          .collect();
        return { ...t, rondasCount: rondas.length, checklistCount: t.checklist.length };
      }),
    );
  },
});

/** Detalle de un turno: checklist + rondas con URLs de fotos + su minuta. */
export const getTurno = query({
  args: { turnoId: v.id("guardiaTurnos") },
  handler: async (ctx, args) => {
    const turno = await ctx.db.get(args.turnoId);
    if (!turno) return null;

    /* Igual que `rondas.detalle`: sin acceso se responde lo mismo que si no
     * existiera, para que el id de un turno ajeno no sirva de sonda. El
     * conjunto sale del turno, no de la petición. */
    const acceso = await resolverAcceso(ctx, turno.condominioId);
    if (!acceso || !acceso.capacidades.has("porteria.ver")) return null;

    const rondasRaw = await ctx.db
      .query("guardiaRondas")
      .withIndex("by_turno", (q) => q.eq("turnoId", args.turnoId))
      .collect();
    const rondas = await Promise.all(
      rondasRaw.map(async (r) => ({
        ...r,
        fotoUrls: (await resolveMediaUrlList(ctx, r.fotos)).filter(
          (u): u is string => u !== null,
        ),
      })),
    );

    const eventos = await ctx.db
      .query("minutaEventos")
      .withIndex("by_turno", (q) => q.eq("turnoId", args.turnoId))
      .collect();

    const cerradoPor = turno.cerradoPorUserId
      ? await ctx.db.get(turno.cerradoPorUserId)
      : null;

    return {
      ...turno,
      cerradoPorNombre: cerradoPor ? displayNameFromUser(cerradoPor) : null,
      rondas: rondas.sort((a, b) => b.createdAt - a.createdAt),
      eventos: eventos.sort((a, b) => b.createdAt - a.createdAt),
    };
  },
});

// ─────────────────────────────────────────────────────────────
// Rondas de control
// ─────────────────────────────────────────────────────────────

/** Registra una ronda (requiere turno abierto propio; máximo 5 fotos). */
export const registrarRonda = mutation({
  args: {
    condominioId: v.id("condominios"),
    zonaId: v.optional(v.id("guardiaRondaZonas")),
    zonaNombre: v.optional(v.string()),
    novedad: v.optional(v.string()),
    fotos: v.array(v.string()), // URLs S3 (o storageId legacy como string)
  },
  handler: async (ctx, args) => {
    const { user } = await requireCondominioRole(ctx, args.condominioId, [...GUARD_ROLES]);

    const turno = await turnoAbierto(ctx, args.condominioId);
    if (!turno) throw new Error("Debes iniciar turno antes de registrar rondas.");
    if (args.fotos.length > 5) throw new Error("Máximo 5 fotos por ronda.");

    let zona = args.zonaNombre?.trim() || "";
    if (args.zonaId) {
      const z = await ctx.db.get(args.zonaId);
      if (!z || !z.activa) throw new Error("Zona de ronda no válida o inactiva.");
      zona = z.nombre;
    }
    if (!zona) throw new Error("Selecciona la zona de la ronda.");

    const now = Date.now();
    await ctx.db.insert("guardiaRondas", {
      condominioId: args.condominioId,
      turnoId: turno._id,
      zonaId: args.zonaId,
      zona,
      novedad: args.novedad?.trim() || undefined,
      fotos: args.fotos,
      createdAt: now,
    });

    await logMinuta(ctx, {
      condominioId: args.condominioId,
      modulo: "minuta",
      tipo: "Ronda de Control",
      unidad: zona,
      resumen: args.novedad?.trim() || `Ronda por ${zona} sin novedad.`,
      estado: "cerrado",
      actorUserId: user._id,
      actorNombre: user.name,
      turnoId: turno._id,
    });
  },
});

// ─────────────────────────────────────────────────────────────
// Catálogos (admin): checklist de dotación y zonas de ronda
// ─────────────────────────────────────────────────────────────

export const listChecklistTemplate = query({
  args: { condominioId: v.id("condominios") },
  handler: async (ctx, args) => {
    await requireCondominioRole(ctx, args.condominioId, [...GUARD_ROLES]);
    const items = await ctx.db
      .query("guardiaChecklistTemplates")
      .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
      .collect();
    return items.sort((a, b) => a.orden - b.orden || a.createdAt - b.createdAt);
  },
});

export const createChecklistTemplate = mutation({
  args: {
    condominioId: v.id("condominios"),
    nombre: v.string(),
    obligatorio: v.boolean(),
    cantidadEsperada: v.number(),
    orden: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireCondominioRole(ctx, args.condominioId, [...ADMIN_ROLES]);
    const nombre = args.nombre.trim();
    if (!nombre) throw new Error("El nombre es obligatorio.");
    const now = Date.now();
    return await ctx.db.insert("guardiaChecklistTemplates", {
      condominioId: args.condominioId,
      nombre,
      obligatorio: args.obligatorio,
      cantidadEsperada: Math.max(1, Math.round(args.cantidadEsperada)),
      activo: true,
      orden: args.orden ?? 0,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const updateChecklistTemplate = mutation({
  args: {
    id: v.id("guardiaChecklistTemplates"),
    nombre: v.optional(v.string()),
    obligatorio: v.optional(v.boolean()),
    cantidadEsperada: v.optional(v.number()),
    activo: v.optional(v.boolean()),
    orden: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const item = await ctx.db.get(args.id);
    if (!item) throw new Error("Ítem no encontrado.");
    await requireCondominioRole(ctx, item.condominioId, [...ADMIN_ROLES]);
    const { id, ...rest } = args;
    await ctx.db.patch(id, {
      ...rest,
      nombre: rest.nombre?.trim() ?? item.nombre,
      updatedAt: Date.now(),
    });
  },
});

export const removeChecklistTemplate = mutation({
  args: { id: v.id("guardiaChecklistTemplates") },
  handler: async (ctx, args) => {
    const item = await ctx.db.get(args.id);
    if (!item) return;
    await requireCondominioRole(ctx, item.condominioId, [...ADMIN_ROLES]);
    await ctx.db.delete(args.id);
  },
});

export const listRondaZonas = query({
  args: { condominioId: v.id("condominios") },
  handler: async (ctx, args) => {
    await exigirAcceso(ctx, args.condominioId, "porteria.ver");
    const zonas = await ctx.db
      .query("guardiaRondaZonas")
      .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
      .collect();
    return zonas.sort((a, b) => a.orden - b.orden || a.createdAt - b.createdAt);
  },
});

export const createRondaZona = mutation({
  args: {
    condominioId: v.id("condominios"),
    nombre: v.string(),
    orden: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireCondominioRole(ctx, args.condominioId, [...ADMIN_ROLES]);
    const nombre = args.nombre.trim();
    if (!nombre) throw new Error("El nombre es obligatorio.");
    const now = Date.now();
    return await ctx.db.insert("guardiaRondaZonas", {
      condominioId: args.condominioId,
      nombre,
      activa: true,
      orden: args.orden ?? 0,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const updateRondaZona = mutation({
  args: {
    id: v.id("guardiaRondaZonas"),
    nombre: v.optional(v.string()),
    activa: v.optional(v.boolean()),
    orden: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const zona = await ctx.db.get(args.id);
    if (!zona) throw new Error("Zona no encontrada.");
    await requireCondominioRole(ctx, zona.condominioId, [...ADMIN_ROLES]);
    const { id, ...rest } = args;
    await ctx.db.patch(id, {
      ...rest,
      nombre: rest.nombre?.trim() ?? zona.nombre,
      updatedAt: Date.now(),
    });
  },
});

export const removeRondaZona = mutation({
  args: { id: v.id("guardiaRondaZonas") },
  handler: async (ctx, args) => {
    const zona = await ctx.db.get(args.id);
    if (!zona) return;
    await requireCondominioRole(ctx, zona.condominioId, [...ADMIN_ROLES]);
    await ctx.db.delete(args.id);
  },
});

// ─────────────────────────────────────────────────────────────
// Minuta digital
// ─────────────────────────────────────────────────────────────

/** Eventos de la minuta (más recientes primero). */
export const listMinuta = query({
  args: {
    condominioId: v.id("condominios"),
    limit: v.optional(v.number()),
    /**
     * Solo lo que registró esta persona.
     *
     * La minuta está modelada por CONJUNTO —es la bitácora de la portería, no
     * el diario de nadie—, así que lo del guarda es el subconjunto de eventos
     * cuyo actor es él. `actorUserId` es opcional: los eventos que no lo
     * llevan no se atribuyen a nadie y por eso no salen al filtrar.
     */
    actorUserId: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    /* Leer la minuta es supervisión, no operación: la puede leer quien tenga
     * `porteria.ver` —los mismos de siempre más el supervisor asignado—.
     * Escribir en ella sigue exigiendo turno abierto y rol de portería. */
    await exigirAcceso(ctx, args.condominioId, "porteria.ver");
    const limit = Math.min(args.limit ?? 150, 300);

    let eventos: Doc<"minutaEventos">[];
    if (!args.actorUserId) {
      eventos = await ctx.db
        .query("minutaEventos")
        .withIndex("by_condominio", (q) =>
          q.eq("condominioId", args.condominioId),
        )
        .order("desc")
        .take(limit);
    } else {
      const actorUserId = args.actorUserId;
      eventos = [];
      for await (const e of ctx.db
        .query("minutaEventos")
        .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
        .order("desc")) {
        if (e.actorUserId !== actorUserId) continue;
        eventos.push(e);
        if (eventos.length >= limit) break;
      }
    }

    /* La ronda se guardaba pero no se veía: la administración leía la minuta
     * sin poder saber durante qué recorrido pasó cada cosa, que es justo lo
     * que hace útil tener rondas.
     *
     * Se resuelve la ronda distinta, no por evento: una minuta de 300 líneas
     * de un mismo turno son dos o tres rondas, no 300 lecturas.
     *
     * Va el número Y la zona porque "Ronda #2" no dice nada a quien supervisa
     * varios conjuntos: lo que identifica el recorrido es "Ronda #2 ·
     * Perimetral". Ambos salen del mismo documento ya leído, así que nombrarla
     * entera no cuesta una lectura más. */
    const rondaPorId = new Map<
      string,
      { numero: number | null; zona: string | null }
    >();
    for (const e of eventos) {
      if (!e.rondaId || rondaPorId.has(e.rondaId)) continue;
      const r = await ctx.db.get(e.rondaId);
      rondaPorId.set(e.rondaId, {
        numero: r?.numero ?? null,
        zona: r?.zona ?? null,
      });
    }

    return eventos.map((e) => {
      const ronda = e.rondaId ? rondaPorId.get(e.rondaId) : undefined;
      return {
        ...e,
        rondaNumero: ronda?.numero ?? null,
        rondaZona: ronda?.zona ?? null,
      };
    });
  },
});

/**
 * CUÁNTAS RONDAS Y CUÁNTOS INCIDENTES HUBO EN UN PERÍODO.
 *
 * Existe porque contar no es listar. Las dos cifras se sacaban antes de las
 * listas que ya pedía la pantalla, y esas vienen capadas —`listMinuta` trae
 * como mucho 300 eventos y `rondas.listar` 200—, así que "incidentes" no era
 * ni el total ni el del período: era cuántas novedades cabían en la última
 * página. Con más de 200 eventos el número se quedaba corto sin avisar.
 *
 * Contar en el servidor y no en el cliente es justamente lo que arregla eso:
 * aquí se recorre el índice entero del rango, sin tope.
 *
 * El rango llega como "AAAA-MM-DD" —la convención que ya usa
 * `reservas.reporte`— y se traduce a milisegundos con `ventanaDiaBogota`, que
 * es el mismo criterio de día civil que aplica portería a los visitantes. Sin
 * eso, "hoy" empezaría a las 7 p.m. del día anterior para media operación.
 *
 * Ambos extremos son INCLUSIVE: pedir 01/09 → 01/09 cuenta ese día completo.
 */
export const resumenPeriodo = query({
  args: {
    condominioId: v.id("condominios"),
    /** "2026-09-01". Inclusive. */
    desde: v.string(),
    /** "2026-09-09". Inclusive. */
    hasta: v.string(),
  },
  handler: async (ctx, args) => {
    /* Mismo permiso que la minuta y las rondas que resume: leer la portería
     * es supervisión. No abre nada que la pantalla no pudiera ya ver. */
    await exigirAcceso(ctx, args.condominioId, "porteria.ver");

    if (args.desde > args.hasta) {
      throw new Error("La fecha inicial no puede ser posterior a la final.");
    }

    const { inicio } = ventanaDiaBogota(args.desde);
    const { fin } = ventanaDiaBogota(args.hasta);

    /* Se recorre de lo más nuevo a lo más viejo y se CORTA al pasarse del
     * inicio del rango, en vez de `.collect()`: en una portería con años de
     * histórico, contar lo de esta semana no puede costar leer la tabla
     * entera. Es la misma técnica que ya usa `listMinuta` al filtrar por
     * actor.
     *
     * El corte se hace por `createdAt` —que se escribe en el insert y por
     * tanto crece igual que el orden del índice— aunque la ronda se cuente
     * por `fechaInicio`: las dos se sellan en la misma escritura, así que no
     * hay ronda con inicio dentro del rango y creación anterior. */
    let rondas = 0;
    for await (const r of ctx.db
      .query("guardiaRondas")
      .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
      .order("desc")) {
      if (r.createdAt < inicio) break;
      const en = r.fechaInicio ?? r.createdAt;
      if (en >= inicio && en <= fin) rondas++;
    }

    let incidentes = 0;
    for await (const e of ctx.db
      .query("minutaEventos")
      .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
      .order("desc")) {
      if (e.createdAt < inicio) break;
      /* La misma definición de incidente que ya pintaba la tarjeta: el módulo
       * `novedades` de la minuta. No se amplía aquí lo que cuenta como
       * incidente; solo se acota al período. */
      if (e.createdAt <= fin && e.modulo === "novedades") incidentes++;
    }

    return { rondas, incidentes };
  },
});

/** Evento manual de minuta (requiere turno abierto). */
export const registrarEventoMinuta = mutation({
  args: {
    condominioId: v.id("condominios"),
    tipo: v.string(),
    unidad: v.optional(v.string()),
    resumen: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireCondominioRole(ctx, args.condominioId, [...GUARD_ROLES]);
    const turno = await turnoAbierto(ctx, args.condominioId);
    if (!turno) throw new Error("Debes iniciar turno para registrar en la minuta.");
    const resumen = args.resumen.trim();
    if (!resumen) throw new Error("El detalle del evento es obligatorio.");
    await logMinuta(ctx, {
      condominioId: args.condominioId,
      modulo: "minuta",
      tipo: args.tipo.trim() || "Anotación",
      unidad: args.unidad?.trim() || "Portería",
      resumen,
      estado: "cerrado",
      actorUserId: user._id,
      actorNombre: user.name,
      turnoId: turno._id,
    });
  },
});

// ─────────────────────────────────────────────────────────────
// Visitantes (control de acceso)
// ─────────────────────────────────────────────────────────────

/** Visitantes visibles en portería: adentro, walk-ins pendientes y salidas recientes.
 *  NO incluye autorizaciones QR pendientes (eso es solo escaneo). */
export const listVisitantes = query({
  args: { condominioId: v.id("condominios") },
  handler: async (ctx, args) => {
    await requireCondominioRole(ctx, args.condominioId, [...GUARD_ROLES]);
    const visitantes = await ctx.db
      .query("visitantes")
      .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
      .order("desc")
      .take(300);
    return visitantes.filter(
      (v) =>
        v.estado === "activo" ||
        v.estado === "esperando_aprobacion" ||
        v.estado === "finalizado",
    ).slice(0, 200);
  },
});

/**
 * Lo que el guarda necesita ver al escanear: quién llega, a qué casa va y
 * quién lo espera. Sin esto el QR solo decía "ingreso registrado" y había
 * que adivinar el resto.
 */
async function resumenAcceso(ctx: QueryCtx | MutationCtx, vis: Doc<"visitantes">) {
  let anfitrionNombre: string | null = null;
  if (vis.autorizadoPorUserId) {
    const u = await ctx.db.get(vis.autorizadoPorUserId);
    if (u) anfitrionNombre = displayNameFromUser(u) || u.name;
  }
  if (!anfitrionNombre) {
    const links = vigentes(
      await ctx.db
        .query("usuarioUnidad")
        .withIndex("by_unidad", (q) => q.eq("unidadId", vis.unidadId))
        .collect(),
    );
    const candidato = [...links].sort(
      (a, b) => ordenVinculo(a.vinculo) - ordenVinculo(b.vinculo),
    )[0];
    if (candidato) {
      const mem = await ctx.db.get(candidato.membershipId);
      const u = mem ? await ctx.db.get(mem.userId) : null;
      if (u) anfitrionNombre = displayNameFromUser(u) || u.name;
    }
  }
  return {
    id: vis._id,
    nombre: vis.nombre,
    documento: vis.documento,
    tipoDocumento: vis.tipoDocumento,
    tipo: vis.tipo,
    placa: vis.placa ?? null,
    unidadNumero: vis.unidadNumero ?? null,
    anfitrionNombre,
  };
}

/** Visitante puntual por id (resultado de escanear un QR). */
export const getVisitante = query({
  args: { id: v.id("visitantes") },
  handler: async (ctx, args) => {
    const vis = await ctx.db.get(args.id);
    if (!vis) return null;
    await requireCondominioRole(ctx, vis.condominioId, [...GUARD_ROLES]);
    return { ...vis, ...(await resumenAcceso(ctx, vis)) };
  },
});

/**
 * Ingreso por escaneo de QR.
 * Solo válido el día de la visita; si no llegó, el QR expira / se borra.
 */
export const registrarIngreso = mutation({
  args: { id: v.id("visitantes") },
  handler: async (ctx, args) => {
    const vis = await ctx.db.get(args.id);
    if (!vis) throw new Error("Visitante no encontrado.");
    const { user } = await requireCondominioRole(ctx, vis.condominioId, [...GUARD_ROLES]);

    const vigencia = esVisitanteVigente(vis);
    if (!vigencia.ok) {
      if (vigencia.reason === "YA_ACTIVO") {
        return { accion: "ya_activo" as const, ...(await resumenAcceso(ctx, vis)) };
      }
      throw new Error(vigencia.reason);
    }

    const now = Date.now();
    await ctx.db.patch(args.id, {
      estado: "activo",
      fechaIngreso: now,
      updatedAt: now,
    });
    await logMinuta(ctx, {
      condominioId: vis.condominioId,
      modulo: "visitantes",
      tipo: "Ingreso",
      unidad: vis.unidadNumero ?? "—",
      resumen: `Ingreso de ${vis.nombre} (${vis.documento})${vis.placa ? ` · placa ${vis.placa}` : ""}.`,
      estado: "abierto",
      actorUserId: user._id,
      actorNombre: user.name,
    });
    return { accion: "ingreso" as const, ...(await resumenAcceso(ctx, vis)) };
  },
});

/**
 * Salida de un visitante. El QR queda invalidado (un solo uso por autorización).
 */
export const registrarSalida = mutation({
  args: { id: v.id("visitantes") },
  handler: async (ctx, args) => {
    const vis = await ctx.db.get(args.id);
    if (!vis) throw new Error("Visitante no encontrado.");
    const { user } = await requireCondominioRole(ctx, vis.condominioId, [...GUARD_ROLES]);
    const now = Date.now();
    await ctx.db.patch(args.id, {
      estado: "finalizado",
      fechaSalida: now,
      qrInvalidado: true,
      updatedAt: now,
    });
    await logMinuta(ctx, {
      condominioId: vis.condominioId,
      modulo: "visitantes",
      tipo: "Salida",
      unidad: vis.unidadNumero ?? "—",
      resumen: `Salida de ${vis.nombre} (${vis.documento}).`,
      estado: "cerrado",
      actorUserId: user._id,
      actorNombre: user.name,
    });
    return { accion: "salida" as const, ...(await resumenAcceso(ctx, vis)) };
  },
});

/**
 * Walk-in: el guardia registra a quien llega sin QR.
 * Queda en "esperando_aprobacion" hasta que el residente acepte.
 * Avisar al dueño (llamar / app) antes de dejar pasar.
 */
export const registrarDirecto = mutation({
  args: {
    condominioId: v.id("condominios"),
    unidadNumero: v.string(),
    nombre: v.string(),
    documento: v.string(),
    tipoDocumento: tipoDocValidator,
    tipo: tipoVisitanteValidator,
    placa: v.optional(v.string()),
    observaciones: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireCondominioRole(ctx, args.condominioId, [...GUARD_ROLES]);
    const nombre = args.nombre.trim();
    const documento = args.documento.trim();
    const unidadNumero = args.unidadNumero.trim();
    if (!nombre || !documento) throw new Error("Nombre y documento son obligatorios.");
    if (!unidadNumero) throw new Error("La unidad es obligatoria.");

    const unidad = await ctx.db
      .query("unidades")
      .withIndex("by_condominio_numero", (q) =>
        q.eq("condominioId", args.condominioId).eq("numero", unidadNumero),
      )
      .first();
    if (!unidad) throw new Error(`No existe la unidad ${unidadNumero} en el conjunto.`);

    const now = Date.now();
    const { inicio, fin } = ventanaHoyBogota();
    const id = await ctx.db.insert("visitantes", {
      condominioId: args.condominioId,
      unidadId: unidad._id,
      unidadNumero: unidad.numero,
      nombre,
      documento,
      tipoDocumento: args.tipoDocumento,
      tipo: args.tipo,
      placa: args.placa?.toUpperCase().trim() || undefined,
      fechaVisitaInicio: inicio,
      fechaVisitaFin: fin,
      estado: "esperando_aprobacion",
      observaciones: args.observaciones?.trim() || undefined,
      qrInvalidado: false,
      registradoPorGuardia: true,
      createdAt: now,
      updatedAt: now,
    });
    await logMinuta(ctx, {
      condominioId: args.condominioId,
      modulo: "visitantes",
      tipo: "Solicitud",
      unidad: unidad.numero,
      resumen: `Portería solicita autorización: ${nombre} (${documento}) → unidad ${unidad.numero}. Esperando al residente.`,
      estado: "abierto",
      actorUserId: user._id,
      actorNombre: user.name,
    });
    return id;
  },
});

// ─────────────────────────────────────────────────────────────
// Paquetería (con evidencia fotográfica)
// ─────────────────────────────────────────────────────────────

/** Lista de paquetes con URLs de evidencia resueltas. */
export const listPaquetes = query({
  args: { condominioId: v.id("condominios") },
  handler: async (ctx, args) => {
    await requireCondominioRole(ctx, args.condominioId, [...GUARD_ROLES]);
    const paquetes = await ctx.db
      .query("paquetes")
      .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
      .order("desc")
      .take(200);
    return await Promise.all(
      paquetes.map(async (p) => ({
        ...p,
        fotoUrl:
          (await resolveMediaUrl(ctx, {
            url: p.fotoUrl,
            storageId: p.fotoStorageId,
          })) || null,
        fotoEntregaUrl:
          (await resolveMediaUrl(ctx, {
            url: p.fotoEntregaUrl,
            storageId: p.fotoEntregaStorageId,
          })) || null,
      })),
    );
  },
});

/** El guardia recibe un paquete (foto de llegada opcional). */
export const recibirPaquete = mutation({
  args: {
    condominioId: v.id("condominios"),
    unidadNumero: v.string(),
    /** La casa escogida en el selector. Si viene, manda sobre `unidadNumero`. */
    unidadId: v.optional(v.id("unidades")),
    tipo: tipoPaqueteValidator,
    remitente: v.optional(v.string()),
    destinatario: v.optional(v.string()),
    descripcion: v.optional(v.string()),
    fotoStorageId: v.optional(v.id("_storage")),
    fotoUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireCondominioRole(ctx, args.condominioId, [...GUARD_ROLES]);

    /* La casa escogida en el selector es la buena: no hay que adivinarla por
     * el numero, y dos torres con una 101 cada una dejan de confundirse. */
    let unidad: Doc<"unidades"> | undefined;
    if (args.unidadId) {
      const escogida = await ctx.db.get(args.unidadId);
      if (!escogida || escogida.condominioId !== args.condominioId) {
        throw new Error("Esa casa no es de este conjunto.");
      }
      unidad = escogida;
    }

    const unidadNumero = unidad?.numero ?? args.unidadNumero.trim();
    if (!unidadNumero) throw new Error("La unidad es obligatoria.");

    /* Sin casa escogida se resuelve por el numero escrito, para poder
     * avisarle a quien vive ahi. Si no cuadra con ninguna no se bloquea el
     * registro —la porteria no puede quedarse sin recibir un paquete porque
     * el numero venga raro—, pero el aviso no saldra y por eso conviene que
     * el guarda escoja de la lista. */
    if (!unidad) {
      const unidades = await ctx.db
        .query("unidades")
        .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
        .collect();
      const norm = (x: string) => x.trim().toLowerCase().replace(/\s+/g, "");
      unidad = unidades.find((u) => norm(u.numero) === norm(unidadNumero));
    }

    const now = Date.now();
    const id = await ctx.db.insert("paquetes", {
      condominioId: args.condominioId,
      unidadId: unidad?._id,
      unidadNumero,
      tipo: args.tipo,
      remitente: args.remitente?.trim() || undefined,
      destinatario: args.destinatario?.trim() || undefined,
      descripcion: args.descripcion?.trim() || undefined,
      fotoStorageId: args.fotoStorageId,
      fotoUrl: args.fotoUrl,
      estado: "recibido",
      recibidoPorNombre: user.name,
      fechaRecibido: now,
    });
    await logMinuta(ctx, {
      condominioId: args.condominioId,
      modulo: "paqueteria",
      tipo: "Registro",
      unidad: unidadNumero,
      resumen: `Paquete recibido${args.remitente ? ` de ${args.remitente.trim()}` : ""} para la unidad ${unidadNumero}.`,
      estado: "abierto",
      actorUserId: user._id,
      actorNombre: user.name,
    });

    /* Aviso al teléfono de quien vive ahí. Agendado y no en línea: enviar
     * sale a internet, y si Expo está caído eso no puede hacer fallar el
     * registro del paquete, que ya quedó hecho.
     *
     * Sin `unidad` resuelta no hay a quién avisarle; el paquete se registra
     * igual porque la portería no puede quedarse sin recibirlo. */
    if (unidad) {
      await ctx.scheduler.runAfter(0, internal.push.avisarAUnidades, {
        unidadIds: [unidad._id],
        titulo: "Tienes un paquete",
        cuerpo: args.remitente?.trim()
          ? `Llegó a portería un envío de ${args.remitente.trim()}.`
          : "Llegó un envío a portería.",
        ruta: "/(app)/paqueteria",
      });
    }
    return id;
  },
});

/** Entrega con evidencia: quién recibe, observaciones y foto de entrega. */
export const entregarPaquete = mutation({
  args: {
    id: v.id("paquetes"),
    entregadoA: v.optional(v.string()),
    observaciones: v.optional(v.string()),
    fotoEntregaStorageId: v.optional(v.id("_storage")),
    fotoEntregaUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const p = await ctx.db.get(args.id);
    if (!p) throw new Error("Paquete no encontrado.");
    const { user } = await requireCondominioRole(ctx, p.condominioId, [...GUARD_ROLES]);
    if (p.estado === "entregado") return;
    await ctx.db.patch(args.id, {
      estado: "entregado",
      entregadoPorNombre: user.name,
      entregadoANombre: args.entregadoA?.trim() || undefined,
      observacionesEntrega: args.observaciones?.trim() || undefined,
      fotoEntregaStorageId: args.fotoEntregaStorageId,
      fotoEntregaUrl: args.fotoEntregaUrl,
      fechaEntregado: Date.now(),
    });
    await logMinuta(ctx, {
      condominioId: p.condominioId,
      modulo: "paqueteria",
      tipo: "Entrega",
      unidad: p.unidadNumero,
      resumen: `Paquete entregado${args.entregadoA ? ` a ${args.entregadoA.trim()}` : ""}${args.observaciones ? `. Obs: ${args.observaciones.trim()}` : "."}`,
      estado: "cerrado",
      actorUserId: user._id,
      actorNombre: user.name,
    });
  },
});

/**
 * Portería borra un paquete que aún no se ha entregado.
 *
 * Sirve para corregir un registro mal hecho (unidad equivocada, duplicado,
 * prueba). El histórico de entregas no se toca: un paquete ya entregado
 * sigue siendo de la administración (`removePaquete`).
 */
export const eliminarPaqueteReciente = mutation({
  args: { id: v.id("paquetes") },
  handler: async (ctx, args) => {
    const p = await ctx.db.get(args.id);
    if (!p) return;
    const { user } = await requireCondominioRole(ctx, p.condominioId, [...GUARD_ROLES]);

    if (p.estado !== "recibido") {
      throw new Error(
        "Ese paquete ya fue entregado. Pídele a la administración que lo elimine.",
      );
    }

    if (p.fotoStorageId) await ctx.storage.delete(p.fotoStorageId).catch(() => {});
    await ctx.db.delete(args.id);
    await logMinuta(ctx, {
      condominioId: p.condominioId,
      modulo: "paqueteria",
      tipo: "Eliminación",
      unidad: p.unidadNumero,
      resumen: `Registro de paquete eliminado para la unidad ${p.unidadNumero}.`,
      estado: "cerrado",
      actorUserId: user._id,
      actorNombre: user.name,
    });
  },
});

export const removePaquete = mutation({
  args: { id: v.id("paquetes") },
  handler: async (ctx, args) => {
    const p = await ctx.db.get(args.id);
    if (!p) return;
    await requireCondominioRole(ctx, p.condominioId, [...ADMIN_ROLES]);
    if (p.fotoStorageId) await ctx.storage.delete(p.fotoStorageId).catch(() => {});
    if (p.fotoEntregaStorageId) await ctx.storage.delete(p.fotoEntregaStorageId).catch(() => {});
    await ctx.db.delete(args.id);
  },
});

// ─────────────────────────────────────────────────────────────
// Control de reservas + depósitos/garantías
// ─────────────────────────────────────────────────────────────

/** Reservas aprobadas para control en portería, con su depósito si existe. */
export const listReservasControl = query({
  args: { condominioId: v.id("condominios") },
  handler: async (ctx, args) => {
    await requireCondominioRole(ctx, args.condominioId, [...GUARD_ROLES]);
    const reservas = await ctx.db
      .query("reservas")
      .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
      .order("desc")
      .take(100);
    const aprobadas = reservas.filter((r) => r.estado === "aprobada");
    return await Promise.all(
      aprobadas.map(async (r) => {
        const deposito = await depositoDeReserva(ctx, r._id);
        let depositoRequerido = r.depositoRequerido;
        let valorReserva = r.valorReserva;
        if (depositoRequerido == null || valorReserva == null) {
          const zona = await ctx.db.get(r.zonaId);
          if (zona) {
            const costo = calcularCosto(zona, r.horaInicio, r.horaFin);
            if (valorReserva == null && !costo.sinTarifa) valorReserva = costo.alquiler;
            if (depositoRequerido == null) depositoRequerido = zona.depositoRequerido;
          }
        }
        return {
          ...r,
          valorReserva,
          depositoRequerido,
          deposito: deposito ?? null,
          ...(await cajaDeposito(ctx, r._id, deposito)),
        };
      }),
    );
  },
});

/**
 * Portería reporta un incidente de la reserva: descripción y foto.
 *
 * NO recibe valor. El guarda cuenta lo que vio; cuánto se descuenta lo decide
 * la administración (`reservas.valorarIncidente`). El incidente queda
 * `pendiente` y, mientras lo esté, el depósito no se puede devolver.
 */
export const reportarIncidenteReserva = mutation({
  args: {
    reservaId: v.id("reservas"),
    descripcion: v.string(),
    fotos: v.optional(
      v.array(v.object({ url: v.string(), nombre: v.optional(v.string()) })),
    ),
  },
  handler: async (ctx, args) => {
    const r = await ctx.db.get(args.reservaId);
    if (!r) throw new Error("Reserva no encontrada.");
    const { user } = await requireCondominioRole(ctx, r.condominioId, [...GUARD_ROLES]);
    const id = await crearIncidente(ctx, {
      reserva: r,
      user,
      origen: "porteria",
      descripcion: args.descripcion,
      fotos: args.fotos,
    });
    await logMinuta(ctx, {
      condominioId: r.condominioId,
      modulo: "reservas",
      tipo: "Incidente Reportado",
      unidad: r.unidadNumero,
      resumen: `Incidente en ${r.zonaNombre} · ${r.solicitanteNombre}: ${args.descripcion.trim()}. Pendiente de valoración.`,
      estado: "abierto",
      actorUserId: user._id,
      actorNombre: user.name,
    });
    return id;
  },
});

/** Valida el ingreso de una reserva (sin depósito). */
export const validarIngresoReserva = mutation({
  args: { reservaId: v.id("reservas") },
  handler: async (ctx, args) => {
    const r = await ctx.db.get(args.reservaId);
    if (!r) throw new Error("Reserva no encontrada.");
    const { user } = await requireCondominioRole(ctx, r.condominioId, [...GUARD_ROLES]);
    if (r.ingresoValidadoAt) return;
    await ctx.db.patch(args.reservaId, { ingresoValidadoAt: Date.now(), updatedAt: Date.now() });
    await logMinuta(ctx, {
      condominioId: r.condominioId,
      modulo: "reservas",
      tipo: "Ingreso Validado",
      unidad: r.unidadNumero,
      resumen: `Ingreso validado: ${r.zonaNombre} (${r.horaInicio}–${r.horaFin}) · ${r.solicitanteNombre}.`,
      estado: "abierto",
      actorUserId: user._id,
      actorNombre: user.name,
    });
  },
});

/** Registra el depósito/garantía y valida el ingreso. */
export const registrarDepositoReserva = mutation({
  args: {
    reservaId: v.id("reservas"),
    monto: v.number(),
    observaciones: v.optional(v.string()),
    fotoStorageId: v.optional(v.id("_storage")),
    fotoUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const r = await ctx.db.get(args.reservaId);
    if (!r) throw new Error("Reserva no encontrada.");
    const { user, membership } = await requireCondominioRole(ctx, r.condominioId, [...GUARD_ROLES]);
    if (args.monto <= 0) throw new Error("El monto del depósito debe ser mayor a 0.");

    const existente = await ctx.db
      .query("guardiaReservaDepositos")
      .withIndex("by_reserva", (q) => q.eq("reservaId", args.reservaId))
      .first();
    if (existente) throw new Error("Esta reserva ya tiene un depósito registrado.");

    const now = Date.now();
    await ctx.db.insert("guardiaReservaDepositos", {
      condominioId: r.condominioId,
      reservaId: args.reservaId,
      monto: args.monto,
      observacionesIngreso: args.observaciones?.trim() || undefined,
      fotoIngresoStorageId: args.fotoStorageId,
      fotoIngresoUrl: args.fotoUrl,
      estado: "registrado",
      recibidoPorNombre: user.name,
      recibidoPorUserId: user._id,
      recibidoPorRol: rolDeQuienOpera(user, membership, "porteria"),
      recibidoOrigen: "porteria",
      fechaRegistro: now,
    });
    await ctx.db.patch(args.reservaId, { ingresoValidadoAt: now, updatedAt: now });
    await logMinuta(ctx, {
      condominioId: r.condominioId,
      modulo: "reservas",
      tipo: "Depósito Registrado",
      unidad: r.unidadNumero,
      resumen: `Depósito de $${args.monto.toLocaleString("es-CO")} por ${r.zonaNombre} · ${r.solicitanteNombre}.`,
      estado: "abierto",
      actorUserId: user._id,
      actorNombre: user.name,
    });
  },
});

/**
 * Valida la salida de una reserva.
 *
 * Con el depósito en custodia la salida se bloquea hasta devolverlo, SALVO
 * que haya incidentes esperando valoración: el residente no se queda
 * esperando a la administración para irse. En ese caso la salida física se
 * valida y el depósito sigue en portería hasta que se valoren y se devuelva.
 */
export const validarSalidaReserva = mutation({
  args: { reservaId: v.id("reservas") },
  handler: async (ctx, args) => {
    const r = await ctx.db.get(args.reservaId);
    if (!r) throw new Error("Reserva no encontrada.");
    const { user } = await requireCondominioRole(ctx, r.condominioId, [...GUARD_ROLES]);
    const deposito = await depositoDeReserva(ctx, args.reservaId);
    let enCustodia = false;
    if (deposito && deposito.estado === "registrado") {
      const { liquidacion } = await cajaDeposito(ctx, args.reservaId, deposito);
      if (!liquidacion || liquidacion.pendientes === 0) {
        throw new Error("Hay un depósito pendiente: debes devolverlo antes de validar la salida.");
      }
      enCustodia = true;
    }
    await ctx.db.patch(args.reservaId, { salidaValidadaAt: Date.now(), updatedAt: Date.now() });
    await logMinuta(ctx, {
      condominioId: r.condominioId,
      modulo: "reservas",
      tipo: "Salida Validada",
      unidad: r.unidadNumero,
      resumen: enCustodia
        ? `Salida validada: ${r.zonaNombre} · ${r.solicitanteNombre}. El depósito queda en custodia hasta valorar los incidentes.`
        : `Salida validada: ${r.zonaNombre} · ${r.solicitanteNombre}.`,
      estado: enCustodia ? "abierto" : "cerrado",
      actorUserId: user._id,
      actorNombre: user.name,
    });
  },
});

/**
 * Devuelve el depósito en portería y valida la salida si faltaba.
 *
 * El monto lo calcula el servidor con los incidentes valorados; el guarda no
 * decide cuánto se retiene. No se puede devolver con incidentes pendientes.
 * La razón es obligatoria si hubo incidentes; la foto, opcional.
 *
 * `devuelto` queda solo por las apps ya instaladas: `false` se rechaza.
 */
export const resolverDepositoReserva = mutation({
  args: {
    depositoId: v.id("guardiaReservaDepositos"),
    /** @deprecated La retención a criterio ya no existe; `false` se rechaza. */
    devuelto: v.optional(v.boolean()),
    /** Razón de la devolución. */
    observaciones: v.optional(v.string()),
    fotoStorageId: v.optional(v.id("_storage")),
    fotoUrl: v.optional(v.string()),
    /** El saldo que se estaba mostrando; debe coincidir con el calculado. */
    saldoEsperado: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const dep = await ctx.db.get(args.depositoId);
    if (!dep) throw new Error("Depósito no encontrado.");
    const { user, membership } = await requireCondominioRole(ctx, dep.condominioId, [...GUARD_ROLES]);
    const liq = await liquidarYDevolver(ctx, {
      deposito: dep,
      user,
      membership,
      origen: "porteria",
      devuelto: args.devuelto,
      razon: args.observaciones,
      saldoEsperado: args.saldoEsperado,
      fotoUrl: args.fotoUrl,
      fotoStorageId: args.fotoStorageId,
    });

    const r = await ctx.db.get(dep.reservaId);
    if (r) {
      const now = Date.now();
      /* Si la salida ya se validó —se fue con incidentes pendientes—, se
       * conserva la hora en que de verdad salió. */
      if (!r.salidaValidadaAt) {
        await ctx.db.patch(dep.reservaId, { salidaValidadaAt: now, updatedAt: now });
      }
      const pesos = (n: number) => `$${n.toLocaleString("es-CO")}`;
      const razon = args.observaciones?.trim();
      await logMinuta(ctx, {
        condominioId: dep.condominioId,
        modulo: "reservas",
        tipo:
          liq.estadoResultante === "devuelto"
            ? "Depósito Devuelto"
            : liq.estadoResultante === "devuelto_parcial"
              ? "Depósito Devuelto Parcialmente"
              : "Depósito Descontado Totalmente",
        unidad: r.unidadNumero,
        resumen:
          `Depósito de ${pesos(dep.monto)} · ${r.zonaNombre}: devuelto ${pesos(liq.saldoDevolucion)}` +
          (liq.totalDescuento > 0 ? `, descontado ${pesos(liq.totalDescuento)} por incidentes` : "") +
          (razon ? `. Razón: ${razon}` : "."),
        estado: "cerrado",
        actorUserId: user._id,
        actorNombre: user.name,
      });
    }
    return liq;
  },
});

// ─────────────────────────────────────────────────────────────
// Novedades / incidentes de seguridad
// ─────────────────────────────────────────────────────────────

/**
 * Busca un vehículo por placa para señalarlo en una novedad.
 *
 * Vive aquí y no en `vehiculos.ts` porque el guarda no tiene permiso sobre
 * ese módulo —no debe poder listar el parque automotor entero del conjunto—
 * pero sí necesita resolver UNA placa cuando está haciendo la ronda.
 *
 * Por eso exige texto y devuelve poco: es un buscador, no un listado.
 */
/**
 * Motivos con los que se puede señalar un vehículo, si la administración no
 * ha configurado los suyos.
 *
 * No es una lista "provisional": es la que usa un conjunto que nunca entra a
 * configurar nada, que son la mayoría. Se exporta para que la interfaz pueda
 * mostrarla como punto de partida cuando el administrador abra el catálogo.
 */
export const MOTIVOS_VEHICULO_POR_DEFECTO = [
  /* Primero porque es el motivo real de casi todas las rondas: el derecho a
   * parquear en zonas comunes lo da el aporte voluntario, y el guarda sale a
   * mirar quien parquea sin haberlo pagado. Los otros cuatro son la
   * excepcion. */
  "Aporte Voluntario Parqueadero",
  "Parqueado en horario no permitido",
  "Parqueado en zona no autorizada",
  "Obstruye el paso o una salida",
  "Ocupa un parqueadero ajeno",
  "Parqueado en zona de visitantes sin permiso",
] as const;

/**
 * Motivos que ve el guarda en el desplegable.
 *
 * Si el conjunto no ha configurado ninguno devuelve los de por defecto, en
 * vez de una lista vacía: dejar al guarda sin poder escoger motivo sería
 * dejarlo sin poder reportar.
 */
export const listMotivosVehiculo = query({
  args: { condominioId: v.id("condominios") },
  handler: async (ctx, args) => {
    await requireCondominioRole(ctx, args.condominioId, [...GUARD_ROLES]);
    const propios = await ctx.db
      .query("guardiaMotivosVehiculo")
      .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
      .collect();

    const activos = propios
      .filter((m) => m.activo)
      .sort((a, b) => a.orden - b.orden || a.createdAt - b.createdAt);

    return {
      motivos: activos.length
        ? activos.map((m) => m.nombre)
        : [...MOTIVOS_VEHICULO_POR_DEFECTO],
      /** true cuando la lista sale de la configuración del conjunto. */
      propios: activos.length > 0,
    };
  },
});

/** Catálogo completo para la administración (incluye los desactivados). */
export const listMotivosVehiculoAdmin = query({
  args: { condominioId: v.id("condominios") },
  handler: async (ctx, args) => {
    await requireCondominioRole(ctx, args.condominioId, [...ADMIN_ROLES]);
    const propios = await ctx.db
      .query("guardiaMotivosVehiculo")
      .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
      .collect();
    return {
      motivos: propios.sort(
        (a, b) => a.orden - b.orden || a.createdAt - b.createdAt,
      ),
      porDefecto: [...MOTIVOS_VEHICULO_POR_DEFECTO],
    };
  },
});

export const createMotivoVehiculo = mutation({
  args: {
    condominioId: v.id("condominios"),
    nombre: v.string(),
    orden: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireCondominioRole(ctx, args.condominioId, [...ADMIN_ROLES]);
    const nombre = args.nombre.trim();
    if (!nombre) throw new Error("El motivo no puede quedar vacío.");
    if (nombre.length > 120) throw new Error("El motivo es demasiado largo.");

    /* Sin repetidos: dos motivos iguales en el desplegable solo sirven para
     * que el guarda dude cuál escoger. */
    const existentes = await ctx.db
      .query("guardiaMotivosVehiculo")
      .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
      .collect();
    const igual = (a: string, b: string) =>
      a.trim().toLowerCase() === b.trim().toLowerCase();
    if (existentes.some((m) => igual(m.nombre, nombre))) {
      throw new Error("Ese motivo ya está en la lista.");
    }

    const now = Date.now();
    return await ctx.db.insert("guardiaMotivosVehiculo", {
      condominioId: args.condominioId,
      nombre,
      activo: true,
      orden: args.orden ?? existentes.length + 1,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const updateMotivoVehiculo = mutation({
  args: {
    id: v.id("guardiaMotivosVehiculo"),
    nombre: v.optional(v.string()),
    activo: v.optional(v.boolean()),
    orden: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const motivo = await ctx.db.get(args.id);
    if (!motivo) throw new Error("Motivo no encontrado.");
    await requireCondominioRole(ctx, motivo.condominioId, [...ADMIN_ROLES]);
    const nombre = args.nombre?.trim();
    if (args.nombre !== undefined && !nombre) {
      throw new Error("El motivo no puede quedar vacío.");
    }
    await ctx.db.patch(args.id, {
      ...(nombre ? { nombre } : {}),
      ...(args.activo !== undefined ? { activo: args.activo } : {}),
      ...(args.orden !== undefined ? { orden: args.orden } : {}),
      updatedAt: Date.now(),
    });
  },
});

export const removeMotivoVehiculo = mutation({
  args: { id: v.id("guardiaMotivosVehiculo") },
  handler: async (ctx, args) => {
    const motivo = await ctx.db.get(args.id);
    if (!motivo) return;
    await requireCondominioRole(ctx, motivo.condominioId, [...ADMIN_ROLES]);
    /* Se borra el motivo, no las novedades: el título de cada reporte ya
     * lleva el texto copiado, así que un reporte viejo sigue diciendo por
     * qué se hizo aunque el conjunto cambie de criterio. */
    await ctx.db.delete(args.id);
  },
});

/**
 * Copia los motivos por defecto al catálogo del conjunto.
 *
 * Es el atajo para empezar: la administración los trae, borra los que no le
 * aplican y agrega los suyos, en vez de escribir cinco desde cero.
 */
export const sembrarMotivosVehiculo = mutation({
  args: { condominioId: v.id("condominios") },
  handler: async (ctx, args) => {
    await requireCondominioRole(ctx, args.condominioId, [...ADMIN_ROLES]);
    const existentes = await ctx.db
      .query("guardiaMotivosVehiculo")
      .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
      .collect();
    const ya = new Set(existentes.map((m) => m.nombre.trim().toLowerCase()));

    const now = Date.now();
    let creados = 0;
    for (const [i, nombre] of MOTIVOS_VEHICULO_POR_DEFECTO.entries()) {
      if (ya.has(nombre.toLowerCase())) continue;
      await ctx.db.insert("guardiaMotivosVehiculo", {
        condominioId: args.condominioId,
        nombre,
        activo: true,
        orden: existentes.length + i + 1,
        createdAt: now,
        updatedAt: now,
      });
      creados++;
    }
    return { creados };
  },
});

/** Hasta cuántas casas devuelve el selector de una vez. */
const LIMITE_CASAS = 50;

/**
 * Las casas del conjunto con quien vive en cada una, para el selector de la
 * portería (paquetería, aporte voluntario y "otra novedad").
 *
 * Se busca por número o por nombre: el domiciliario dice "para Carlos", no
 * "para la 101". Cada resultado trae el nombre de la persona que responde por
 * la casa, porque "101" a secas no le dice al guarda si escogió bien.
 *
 * Igual que `buscarVehiculo`: el guarda no tiene permiso sobre el modulo de
 * unidades, así que esto devuelve lo justo para identificar la casa —número y
 * un nombre— y nada del censo: ni correos, ni teléfonos, ni documentos.
 *
 * Texto vacío devuelve las primeras casas: es la lista que se ve al abrir el
 * selector, antes de escribir nada.
 */
export const buscarUnidad = query({
  args: { condominioId: v.id("condominios"), texto: v.string() },
  handler: async (ctx, args) => {
    await requireCondominioRole(ctx, args.condominioId, [...GUARD_ROLES]);

    const [unidades, vinculos] = await Promise.all([
      ctx.db
        .query("unidades")
        .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
        .collect(),
      ctx.db
        .query("usuarioUnidad")
        .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
        .collect(),
    ]);

    const ocupantes = await ocupantesPorUnidad(ctx, vinculos);
    const casas = unidades.map((u) => ({
      _id: u._id,
      numero: u.numero,
      torre: u.torre ?? null,
      bloque: u.bloque ?? null,
      tipo: u.tipo,
      ocupantes: ocupantes.get(u._id) ?? [],
    }));

    return buscarCasas(casas, args.texto, LIMITE_CASAS).map((c) => ({
      _id: c._id,
      numero: c.numero,
      torre: c.torre,
      residente: c.persona?.nombre ?? null,
      vinculo: c.persona?.vinculo ?? null,
    }));
  },
});

/**
 * Quién vive en cada casa HOY, con el nombre que se muestra.
 *
 * Solo los vínculos vigentes y de cuentas activas: el arrendatario que ya se
 * fue, o la membresía que la administración desactivó, no debe aparecer como
 * dueño de un paquete. Lee cada membresía y cada usuario una sola vez aunque
 * la persona tenga varias casas.
 */
async function ocupantesPorUnidad(
  ctx: QueryCtx | MutationCtx,
  vinculos: Doc<"usuarioUnidad">[],
): Promise<Map<Id<"unidades">, Ocupante[]>> {
  const personas = new Map<Id<"memberships">, Promise<string | null>>();
  const nombreDe = (membershipId: Id<"memberships">) => {
    if (!personas.has(membershipId)) {
      personas.set(
        membershipId,
        (async () => {
          const m = await ctx.db.get(membershipId);
          if (!m || !m.isActive) return null;
          const u = await ctx.db.get(m.userId);
          if (!u || !u.active) return null;
          return displayNameFromUser(u) || u.name || null;
        })(),
      );
    }
    return personas.get(membershipId)!;
  };

  const porUnidad = new Map<Id<"unidades">, Ocupante[]>();
  await Promise.all(
    vigentes(vinculos).map(async (l) => {
      const nombre = await nombreDe(l.membershipId);
      if (!nombre) return;
      const lista = porUnidad.get(l.unidadId) ?? [];
      lista.push({ nombre, vinculo: l.vinculo });
      porUnidad.set(l.unidadId, lista);
    }),
  );
  return porUnidad;
}

/**
 * `ocupantesPorUnidad` para unas cuantas casas y no para el conjunto entero.
 *
 * Una consulta por casa DISTINTA, no por fila: veinte aportes de la misma
 * casa leen sus vínculos una sola vez.
 */
async function ocupantesDeUnidades(
  ctx: QueryCtx | MutationCtx,
  unidadIds: Id<"unidades">[],
): Promise<Map<Id<"unidades">, Ocupante[]>> {
  const vinculos = (
    await Promise.all(
      [...new Set(unidadIds)].map((id) =>
        ctx.db
          .query("usuarioUnidad")
          .withIndex("by_unidad", (q) => q.eq("unidadId", id))
          .collect(),
      ),
    )
  ).flat();
  return await ocupantesPorUnidad(ctx, vinculos);
}

export const buscarVehiculo = query({
  args: { condominioId: v.id("condominios"), texto: v.string() },
  handler: async (ctx, args) => {
    await requireCondominioRole(ctx, args.condominioId, [...GUARD_ROLES]);

    /* Las placas se escriben de mil formas: "ABC 123", "abc-123", "ABC123".
     * Se comparan sin nada que no sea letra o número para que el guarda no
     * tenga que adivinar el formato con el que quedó registrada. */
    const aguja = args.texto.replace(/[^a-z0-9]/gi, "").toUpperCase();
    if (aguja.length < 2) return [];

    const vehiculos = await ctx.db
      .query("vehiculos")
      .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
      .collect();

    const coinciden = vehiculos
      .filter(
        (v) =>
          // Los archivados no se ofrecen: el carro ya no esta en el conjunto.
          !v.archivadoEn &&
          v.placa.replace(/[^a-z0-9]/gi, "").toUpperCase().includes(aguja),
      )
      .slice(0, 12);

    /* Quién vive en la casa de cada placa, con el mismo criterio del
     * selector de casa: el guarda ve "101 — Carlos Pérez" en los dos. */
    const ocupantes = await ocupantesDeUnidades(
      ctx,
      coinciden.map((v) => v.unidadId),
    );

    return await Promise.all(
      coinciden.map(async (v) => {
        const unidad = await ctx.db.get(v.unidadId);
        const titular = [...(ocupantes.get(v.unidadId) ?? [])].sort(
          (a, b) => ordenVinculo(a.vinculo) - ordenVinculo(b.vinculo),
        )[0];
        return {
          _id: v._id,
          placa: v.placa,
          tipo: v.tipo,
          descripcion:
            [v.marca, v.color].filter(Boolean).join(" · ") || null,
          unidadNumero: unidad?.numero ?? null,
          unidadTorre: unidad?.torre ?? null,
          residente: titular?.nombre ?? null,
        };
      }),
    );
  },
});

/**
 * La administración decide qué hacer con una novedad.
 *
 * Separado del reporte a propósito: el guarda registra lo que ve, y quién
 * decide si eso se le cobra a una unidad es la administración. Un guarda no
 * debería poder generar un cobro desde la ronda.
 */
export const gestionarNovedad = mutation({
  args: {
    novedadId: v.id("guardiaNovedadReportes"),
    gestion: v.union(
      v.literal("pendiente"),
      v.literal("cobrada"),
      v.literal("descartada"),
    ),
    nota: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const novedad = await ctx.db.get(args.novedadId);
    if (!novedad) throw new Error("Novedad no encontrada.");
    const { user } = await requireCondominioRole(
      ctx,
      novedad.condominioId,
      [...ADMIN_ROLES],
    );
    await ctx.db.patch(args.novedadId, {
      gestion: args.gestion,
      gestionNota: args.nota?.trim() || undefined,
      gestionPorUserId: user._id,
      gestionEn: Date.now(),
    });
  },
});

async function listarReportesGuardia(
  ctx: QueryCtx,
  condominioId: Id<"condominios">,
  tipo?: "novedad" | "aporte_voluntario",
) {
  await requireCondominioRole(ctx, condominioId, [...GUARD_ROLES]);
  const consulta = ctx.db
    .query("guardiaNovedadReportes")
    .withIndex("by_condominio", (q) => q.eq("condominioId", condominioId))
    .order("desc");
  // La vista mixta conserva su límite anterior. Las vistas separadas filtran
  // antes del límite para no ocultar aportes tras 100 novedades recientes.
  const reportes = tipo
    ? (await consulta.collect())
        .filter((n) => esAporteVoluntario(n) === (tipo === "aporte_voluntario"))
        .slice(0, 100)
    : await consulta.take(100);

    const unidadesDe = (n: Doc<"guardiaNovedadReportes">) =>
      n.unidades ??
      (n.unidadId && n.unidadNumero
        ? [{ unidadId: n.unidadId, numero: n.unidadNumero }]
        : []);

    /* El propietario de la casa de cada aporte voluntario (los reportes con
     * placa), para que el guarda y la administración vean a quién se le
     * cobra sin ir al censo. Se resuelve de la relación de hoy —no se copió
     * al reportar—, así que los aportes viejos también lo muestran. Las
     * demás novedades no lo necesitan y no se consultan. */
    const esAporte = esAporteVoluntario;
    const ocupantes = await ocupantesDeUnidades(
      ctx,
      reportes.filter(esAporte).flatMap((n) => unidadesDe(n).map((u) => u.unidadId)),
    );
    const propietariosDe = (n: Doc<"guardiaNovedadReportes">) =>
      esAporte(n)
        ? unidadesDe(n).flatMap((u) =>
            (ocupantes.get(u.unidadId) ?? [])
              .filter((o) => o.vinculo === "propietario")
              .map((o) => ({ unidadId: u.unidadId, numero: u.numero, nombre: o.nombre })),
          )
        : [];

    return await Promise.all(
      reportes.map(async (n) => ({
        ...n,
        propietarios: propietariosDe(n),
        archivoUrl:
          (await resolveMediaUrl(ctx, {
            url: n.archivoUrl,
            storageId: n.archivoStorageId,
          })) || null,
        /* Las fotos pasan por el mismo resolvedor que el adjunto: hoy son
         * URLs de S3 y salen tal cual, pero si alguna quedara guardada como
         * archivo de Convex igual se resolvería sola. */
        /* Las novedades viejas traen una sola unidad en los campos sueltos.
         * Se normalizan aquí para que la interfaz vea siempre un arreglo y
         * no tenga que conocer las dos formas. */
        unidades: unidadesDe(n),
        /* Sin hora del hecho, ocurrió cuando se registró. */
        ocurrioEn: n.ocurrioEn ?? n.createdAt,
        fotos: n.fotos
          ? (
              await Promise.all(
                n.fotos.map(async (fo) => ({
                  url: (await resolveMediaUrl(ctx, { url: fo.url })) || fo.url,
                  nombre: fo.nombre ?? null,
                })),
              )
            ).filter((fo) => fo.url)
          : [],
      })),
    );
}

export const listNovedadReportes = query({
  args: { condominioId: v.id("condominios") },
  handler: (ctx, args) => listarReportesGuardia(ctx, args.condominioId),
});

export const listNovedadesGuardia = query({
  args: { condominioId: v.id("condominios") },
  handler: (ctx, args) => listarReportesGuardia(ctx, args.condominioId, "novedad"),
});

export const listAportesVoluntarios = query({
  args: { condominioId: v.id("condominios") },
  handler: (ctx, args) => listarReportesGuardia(ctx, args.condominioId, "aporte_voluntario"),
});

export const reportarNovedad = mutation({
  args: {
    condominioId: v.id("condominios"),
    tipoReporte: v.optional(v.union(v.literal("novedad"), v.literal("aporte_voluntario"))),
    titulo: v.string(),
    descripcion: v.string(),
    prioridad: v.union(v.literal("baja"), v.literal("media"), v.literal("alta")),
    archivoStorageId: v.optional(v.id("_storage")),
    archivoUrl: v.optional(v.string()),
    archivoNombre: v.optional(v.string()),
    /** Vehículo señalado (mal parqueo, bloqueo, placa desconocida…). */
    vehiculoId: v.optional(v.id("vehiculos")),
    /**
     * Placa que no estaba en el conjunto y el guarda le asigna casa.
     *
     * Va en ESTA mutación y no en una aparte porque las dos escrituras tienen
     * que pasar juntas o ninguna: crear el vehículo y que luego falle el
     * reporte dejaría un carro registrado que nadie reportó, y al revés
     * dejaría el reporte sin la placa que lo justifica.
     */
    vehiculoNuevo: v.optional(
      v.object({
        placa: v.string(),
        unidadId: v.id("unidades"),
        tipo: v.union(
          v.literal("carro"),
          v.literal("moto"),
          v.literal("bicicleta"),
          v.literal("otro"),
        ),
        marca: v.optional(v.string()),
        color: v.optional(v.string()),
      }),
    ),
    /** Casas afectadas. Ninguna, una o varias — nunca obligatorio. */
    unidadIds: v.optional(v.array(v.id("unidades"))),
    /** Cuándo ocurrió, si no fue ahora mismo. */
    ocurrioEn: v.optional(v.number()),
    /** Evidencia. Varias fotos: una sola casi nunca prueba nada. */
    fotos: v.optional(
      v.array(v.object({ url: v.string(), nombre: v.optional(v.string()) })),
    ),
  },
  handler: async (ctx, args) => {
    const { user } = await requireCondominioRole(ctx, args.condominioId, [...GUARD_ROLES]);
    const titulo = args.titulo.trim();
    const descripcion = args.descripcion.trim();
    if (!titulo || !descripcion) throw new Error("Título y descripción son obligatorios.");

    /* Los datos del vehículo se COPIAN, no se dejan solo referenciados: si
     * mañana venden el carro o lo reasignan, la novedad tiene que seguir
     * diciendo a quién se le hizo. Es lo que sostiene el cobro cuando el
     * propietario reclama meses después. */
    let vehiculoPlaca: string | undefined;
    let vehiculoDescripcion: string | undefined;
    /* Se acumulan por id para no repetir una casa que llegue por dos vías
     * (señalada a mano y además dueña del vehículo). */
    const porUnidad = new Map<string, { unidadId: Id<"unidades">; numero: string }>();

    const sumarUnidad = async (id: Id<"unidades">) => {
      if (porUnidad.has(id)) return;
      const u = await ctx.db.get(id);
      if (!u || u.condominioId !== args.condominioId) return;
      porUnidad.set(id, { unidadId: id, numero: u.numero });
    };

    /* La placa nueva se resuelve primero, para que el resto del handler la
     * trate igual que a cualquier vehículo ya registrado. */
    let vehiculoId = args.vehiculoId;
    if (!vehiculoId && args.vehiculoNuevo) {
      const placa = normalizarPlaca(args.vehiculoNuevo.placa);
      if (placa.length < 3) throw new Error("La placa no es válida.");
      const unidad = await ctx.db.get(args.vehiculoNuevo.unidadId);
      if (!unidad || unidad.condominioId !== args.condominioId) {
        throw new Error("Esa casa no pertenece a este condominio.");
      }

      /* ¿Ya existía? Puede estar archivado —el carro se fue y volvió— y
       * entonces se revive en vez de crear un duplicado que no heredaría ni
       * la casa ni el historial. */
      const existentes = await ctx.db
        .query("vehiculos")
        .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
        .collect();
      const yaEsta = existentes.find((x) => normalizarPlaca(x.placa) === placa);

      if (yaEsta) {
        /* Si ya existe y está en otra casa NO se reasigna sola: mover un
         * carro de casa cambia quién responde por él y quién paga el aporte
         * voluntario, y eso no puede pasar por un reporte de ronda. La casa
         * que señaló el guarda igual queda en el reporte. */
        if (yaEsta.archivadoEn) {
          await ctx.db.patch(yaEsta._id, { archivadoEn: undefined, updatedAt: Date.now() });
        }
        vehiculoId = yaEsta._id;
      } else {
        const ahora = Date.now();
        vehiculoId = await ctx.db.insert("vehiculos", {
          condominioId: args.condominioId,
          unidadId: args.vehiculoNuevo.unidadId,
          placa,
          tipo: args.vehiculoNuevo.tipo,
          marca: args.vehiculoNuevo.marca?.trim() || undefined,
          color: args.vehiculoNuevo.color?.trim() || undefined,
          observaciones: `Registrado por ${user.name} durante una ronda.`,
          createdAt: ahora,
          updatedAt: ahora,
        });
      }
    }

    if (vehiculoId) {
      const veh = await ctx.db.get(vehiculoId);
      if (!veh || veh.condominioId !== args.condominioId) {
        throw new Error("Vehículo no encontrado en este condominio.");
      }
      vehiculoPlaca = veh.placa;
      vehiculoDescripcion =
        [veh.tipo, veh.marca, veh.color].filter(Boolean).join(" · ") || undefined;
      // La casa del vehículo entra sola: es la que responde por el carro.
      await sumarUnidad(veh.unidadId);
    }
    for (const id of args.unidadIds ?? []) await sumarUnidad(id);

    const unidades = [...porUnidad.values()].sort((a, b) =>
      a.numero.localeCompare(b.numero, undefined, { numeric: true }),
    );

    const turno = await turnoAbierto(ctx, args.condominioId);
    /* Si hay ronda en curso, el reporte queda colgado de ella. No se le
     * pregunta al guarda: la especificación pide que la asociación sea
     * automática, y a las 2 a. m. nadie se acuerda de marcar una casilla. */
    const ronda = await rondaEnCurso(ctx, args.condominioId);
    const now = Date.now();
    const id = await ctx.db.insert("guardiaNovedadReportes", {
      condominioId: args.condominioId,
      tipoReporte: args.tipoReporte ?? (vehiculoPlaca ? "aporte_voluntario" : "novedad"),
      turnoId: turno?._id,
      rondaId: ronda?._id,
      /* Nace pendiente de cobrar cuando senala un vehiculo: es plata por
       * cobrarle a una casa, y hasta que alguien diga lo contrario sigue
       * debiendose. */
      cobroEstado: vehiculoId ? ("pendiente" as const) : undefined,
      titulo,
      descripcion,
      prioridad: args.prioridad,
      archivoStorageId: args.archivoStorageId,
      archivoUrl: args.archivoUrl,
      archivoNombre: args.archivoNombre?.trim() || undefined,
      vehiculoId,
      vehiculoPlaca,
      vehiculoDescripcion,
      unidades: unidades.length ? unidades : undefined,
      ocurrioEn: args.ocurrioEn,
      fotos: args.fotos?.length ? args.fotos : undefined,
      // Nace pendiente: reportar no es cobrar, eso lo decide la administración.
      gestion: "pendiente",
      reportadoPorUserId: user._id,
      reportadoPorNombre: user.name,
      createdAt: now,
    });
    await logMinuta(ctx, {
      condominioId: args.condominioId,
      modulo: "novedades",
      tipo: `Reporte ${args.prioridad.toUpperCase()}`,
      /* La minuta apunta a las casas afectadas, no a "Portería": es lo que
       * hace que el evento aparezca al buscar por la unidad. */
      unidad: unidades.length
        ? unidades.map((u) => u.numero).join(", ")
        : "Portería",
      resumen: `${titulo}: ${descripcion.slice(0, 140)}${descripcion.length > 140 ? "…" : ""}`,
      estado: "abierto",
      actorUserId: user._id,
      actorNombre: user.name,
      turnoId: turno?._id,
    });

    /* Solo se avisa a las casas señaladas. Una novedad de portería o de una
     * zona común no es asunto de nadie en particular, y mandarla a todo el
     * conjunto acabaría con que la gente apague las notificaciones. */
    if (unidades.length > 0) {
      await ctx.scheduler.runAfter(0, internal.push.avisarAUnidades, {
        unidadIds: unidades.map((u) => u.unidadId),
        titulo,
        cuerpo: vehiculoPlaca
          ? `Portería reportó el vehículo ${vehiculoPlaca}.`
          : "Portería registró una novedad de tu casa.",
        ruta: "/(app)/novedades",
      });
    }
    return id;
  },
});

// ─────────────────────────────────────────────────────────────
// Avisos para seguridad (comunicados con audiencia todos/guardia)
// ─────────────────────────────────────────────────────────────

export const listAvisos = query({
  args: { condominioId: v.id("condominios") },
  handler: async (ctx, args) => {
    await requireCondominioRole(ctx, args.condominioId, [...GUARD_ROLES]);
    const comunicados = await ctx.db
      .query("comunicados")
      .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
      .order("desc")
      .take(60);
    const visibles = comunicados.filter(
      (c) => c.audiencia === "todos" || c.audiencia === "guardia",
    );
    return await Promise.all(
      visibles.map(async (c) => ({
        ...c,
        archivos: await Promise.all(
          (c.archivos ?? []).map(async (a) => ({
            nombre: a.nombre,
            mimeType: a.mimeType,
            url: await resolveMediaUrl(ctx, a),
          })),
        ),
      })),
    );
  },
});

// ─────────────────────────────────────────────────────────────
// Reservas del día (compat: lo usa la home del guardia)
// ─────────────────────────────────────────────────────────────

/** Reservas aprobadas para una fecha (YYYY-MM-DD). */
export const listReservasDia = query({
  args: { condominioId: v.id("condominios"), fecha: v.string() },
  handler: async (ctx, args) => {
    await requireCondominioRole(ctx, args.condominioId, [...GUARD_ROLES]);
    const reservas = await ctx.db
      .query("reservas")
      .withIndex("by_condominio_fecha", (q) =>
        q.eq("condominioId", args.condominioId).eq("fecha", args.fecha),
      )
      .collect();
    return reservas
      .filter((r) => r.estado === "aprobada")
      .sort((a, b) => a.horaInicio.localeCompare(b.horaInicio));
  },
});

// Nota de tipos: Doc/Id se usan en las firmas inferidas.
export type GuardiaTurnoDoc = Doc<"guardiaTurnos">;
export type GuardiaRondaZonaId = Id<"guardiaRondaZonas">;
