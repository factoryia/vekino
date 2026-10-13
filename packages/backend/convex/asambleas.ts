import { v } from "convex/values";
import { query, mutation, internalMutation } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import {
  requireCondominioRole,
  requireAppUser,
  getCurrentAppUser,
  getMembership,
  vigentes,
} from "./model/authz";
import { calcularQuorum } from "./model/quorum";
import { resolveMediaUrl } from "./model/files";
import { resolveUserImage } from "./model/userImage";
import {
  codigoActual,
  codigoEsValido,
  msRestantes,
  nuevaSemilla,
  VENTANA_MS,
} from "./lib/codigoAsistencia";
import {
  duracionVentana,
  formatearDuracion,
  fusionarTramos,
  msConectados,
  pctPermanencia,
  type Tramo,
} from "./lib/permanencia";
import {
  abrirSesiones,
  cerrarSesionesAsamblea,
  cerrarSesionesUnidad,
  tieneConexionAbierta,
  type FilaSesion,
} from "./asambleaSala";
import { registrarBitacora } from "./salaBitacora";

const WRITE_ROLES = ["administrador", "junta_directiva", "representante_asamblea"] as const;

const tipoValidator = v.union(v.literal("ordinaria"), v.literal("extraordinaria"));
const modalidadValidator = v.union(v.literal("presencial"), v.literal("virtual"), v.literal("mixta"));
const estadoValidator = v.union(
  v.literal("programada"),
  v.literal("en_curso"),
  v.literal("finalizada"),
  v.literal("cancelada")
);

// ─── Asambleas ──────────────────────────────────────────────────────────────

export const listByCondominio = query({
  args: { condominioId: v.id("condominios") },
  handler: async (ctx, args) => {
    await requireCondominioRole(ctx, args.condominioId, []);
    const asambleas = await ctx.db
      .query("asambleas")
      .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
      .order("desc")
      .collect();

    return await Promise.all(
      asambleas.map(async (a) => {
        const votaciones = await ctx.db
          .query("votaciones")
          .withIndex("by_asamblea", (q) => q.eq("asambleaId", a._id))
          .collect();
        const actaUrl = a.actaStorageId ? await ctx.storage.getUrl(a.actaStorageId) : null;
        /* La semilla del código JAMÁS sale hacia un residente: con ella se
         * calculan todos los códigos futuros sin estar en la reunión. Estos
         * dos queries los lee cualquier miembro, así que se quita aquí. La
         * mesa la obtiene por `semillaAsistencia` (solo WRITE_ROLES). */
        const { codigoAsistenciaSemilla: _semilla, ...pub } = a;
        return { ...pub, votacionesCount: votaciones.length, actaUrl };
      })
    );
  },
});

/** Una asamblea puntual con su URL de acta (para la página de gestión). */
export const get = query({
  args: { id: v.id("asambleas") },
  handler: async (ctx, args) => {
    const a = await ctx.db.get(args.id);
    if (!a) return null;
    await requireCondominioRole(ctx, a.condominioId, []);
    const actaUrl = a.actaStorageId ? await ctx.storage.getUrl(a.actaStorageId) : null;
    const { codigoAsistenciaSemilla: _semilla, ...pub } = a;
    return { ...pub, actaUrl };
  },
});

export const create = mutation({
  args: {
    condominioId: v.id("condominios"),
    titulo: v.string(),
    tipo: tipoValidator,
    modalidad: modalidadValidator,
    fecha: v.string(),
    hora: v.string(),
    lugar: v.optional(v.string()),
    quorumRequerido: v.optional(v.number()),
    agenda: v.array(v.string()),
    descripcion: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireCondominioRole(ctx, args.condominioId, [...WRITE_ROLES]);
    const now = Date.now();
    return await ctx.db.insert("asambleas", {
      condominioId: args.condominioId,
      titulo: args.titulo.trim(),
      tipo: args.tipo,
      modalidad: args.modalidad,
      fecha: args.fecha,
      hora: args.hora,
      lugar: args.lugar?.trim(),
      estado: "programada",
      quorumRequerido: args.quorumRequerido,
      agenda: args.agenda.map((a) => a.trim()).filter(Boolean),
      descripcion: args.descripcion?.trim(),
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const update = mutation({
  args: {
    id: v.id("asambleas"),
    titulo: v.optional(v.string()),
    tipo: v.optional(tipoValidator),
    modalidad: v.optional(modalidadValidator),
    fecha: v.optional(v.string()),
    hora: v.optional(v.string()),
    lugar: v.optional(v.string()),
    quorumRequerido: v.optional(v.number()),
    quorumAlcanzado: v.optional(v.number()),
    agenda: v.optional(v.array(v.string())),
    descripcion: v.optional(v.string()),
    enlaceReunion: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.id);
    if (!existing) throw new Error("Asamblea no encontrada.");
    await requireCondominioRole(ctx, existing.condominioId, [...WRITE_ROLES]);
    const { id, ...rest } = args;
    if (rest.enlaceReunion !== undefined) {
      rest.enlaceReunion = saneaEnlaceReunion(rest.enlaceReunion);
    }
    await ctx.db.patch(id, {
      ...rest,
      titulo: rest.titulo?.trim() ?? existing.titulo,
      agenda: rest.agenda ? rest.agenda.map((a) => a.trim()).filter(Boolean) : existing.agenda,
      updatedAt: Date.now(),
    });
  },
});

/**
 * Asigna (o quita) el presidente de esta asamblea para acta / bitácora.
 * Solo mesa / administración.
 */
export const asignarPresidente = mutation({
  args: {
    asambleaId: v.id("asambleas"),
    userId: v.optional(v.id("users")),
    /** Si no hay userId, se puede fijar solo el nombre (p. ej. invitado). */
    nombre: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const asamblea = await ctx.db.get(args.asambleaId);
    if (!asamblea) throw new Error("Asamblea no encontrada.");
    await requireCondominioRole(ctx, asamblea.condominioId, [...WRITE_ROLES]);

    let nombre = args.nombre?.trim() || "";
    let userId = args.userId;

    if (userId) {
      const usr = await ctx.db.get(userId);
      if (!usr) throw new Error("Usuario no encontrado.");
      const membership = await getMembership(ctx, userId, asamblea.condominioId);
      if (!membership || !membership.isActive) {
        throw new Error("Esa persona no pertenece a este condominio.");
      }
      nombre = usr.name;
    }

    if (!userId && !nombre) {
      await ctx.db.patch(args.asambleaId, {
        presidenteUserId: undefined,
        presidenteNombre: undefined,
        updatedAt: Date.now(),
      });
      await registrarBitacora(ctx, {
        condominioId: asamblea.condominioId,
        asambleaId: args.asambleaId,
        tipo: "presidente_asignado",
        nombre: "—",
        detalle: "Se quitó la asignación de presidente",
      });
      return { ok: true as const, presidenteNombre: null };
    }

    if (!nombre) throw new Error("Indica el nombre del presidente.");

    await ctx.db.patch(args.asambleaId, {
      presidenteUserId: userId,
      presidenteNombre: nombre,
      updatedAt: Date.now(),
    });
    await registrarBitacora(ctx, {
      condominioId: asamblea.condominioId,
      asambleaId: args.asambleaId,
      tipo: "presidente_asignado",
      nombre,
      detalle: "Designado como presidente de la asamblea",
      userId,
    });
    return { ok: true as const, presidenteNombre: nombre };
  },
});

export const setEstado = mutation({
  args: {
    id: v.id("asambleas"),
    estado: estadoValidator,
    quorumAlcanzado: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.id);
    if (!existing) throw new Error("Asamblea no encontrada.");
    await requireCondominioRole(ctx, existing.condominioId, [...WRITE_ROLES]);
    const ahora = Date.now();

    /* Marcas reales de la asamblea. La permanencia se mide contra esta
     * ventana, no contra la hora citada: si arrancó 40 min tarde, quien
     * llegó antes de arrancar estuvo el 100 % del tiempo. `iniciadaEn` solo
     * se escribe la primera vez — reabrir una asamblea no debe reiniciar el
     * cronómetro y borrar la permanencia ya acumulada. */
    const iniciadaEn =
      args.estado === "en_curso" ? (existing.iniciadaEn ?? ahora) : existing.iniciadaEn;

    /* La semilla del código se crea AQUÍ y no al abrir el panel de
     * proyección: el apoderado externo y la app móvil registran asistencia
     * contra ella, y si la mesa nunca abría ese panel se quedaban ante un
     * "todavía no ha abierto el registro" sin salida. */
    if (args.estado === "en_curso" && !existing.codigoAsistenciaSemilla) {
      await ctx.db.patch(args.id, { codigoAsistenciaSemilla: nuevaSemilla() });
    }
    const finalizadaEn =
      args.estado === "finalizada" ? ahora : existing.finalizadaEn;

    await ctx.db.patch(args.id, {
      estado: args.estado,
      quorumAlcanzado: args.quorumAlcanzado ?? existing.quorumAlcanzado,
      ...(iniciadaEn !== undefined ? { iniciadaEn } : {}),
      ...(finalizadaEn !== undefined ? { finalizadaEn } : {}),
      updatedAt: ahora,
    });

    /* Al salir de "en_curso" nadie puede seguir conectado: si quedaran
     * tramos abiertos, la permanencia crecería sola para siempre. */
    if (args.estado !== "en_curso") {
      await cerrarSesionesAsamblea(ctx, args.id);
    }
    // Fuera de "en_curso" no debe haber votaciones abiertas al público.
    if (args.estado !== "en_curso") {
      const votaciones = await ctx.db
        .query("votaciones")
        .withIndex("by_asamblea", (q) => q.eq("asambleaId", args.id))
        .collect();
      const now = Date.now();
      for (const vt of votaciones) {
        if (vt.estado === "abierta") {
          await ctx.db.patch(vt._id, { estado: "cerrada", updatedAt: now });
        }
      }
    }
  },
});

export const remove = mutation({
  args: { id: v.id("asambleas") },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.id);
    if (!existing) throw new Error("Asamblea no encontrada.");
    await requireCondominioRole(ctx, existing.condominioId, [...WRITE_ROLES]);
    // Borrar votaciones asociadas
    const votaciones = await ctx.db
      .query("votaciones")
      .withIndex("by_asamblea", (q) => q.eq("asambleaId", args.id))
      .collect();
    await Promise.all(votaciones.map((vt) => ctx.db.delete(vt._id)));
    if (existing.actaStorageId) await ctx.storage.delete(existing.actaStorageId);
    await ctx.db.delete(args.id);
  },
});

// ─── Votaciones ─────────────────────────────────────────────────────────────

export const listVotaciones = query({
  args: { asambleaId: v.id("asambleas") },
  handler: async (ctx, args) => {
    const asamblea = await ctx.db.get(args.asambleaId);
    if (!asamblea) return [];
    await requireCondominioRole(ctx, asamblea.condominioId, []);
    return await ctx.db
      .query("votaciones")
      .withIndex("by_asamblea", (q) => q.eq("asambleaId", args.asambleaId))
      .order("desc")
      .collect();
  },
});

export const cerrarVotacionesSiInactiva = mutation({
  args: { asambleaId: v.id("asambleas") },
  handler: async (ctx, args) => {
    const asamblea = await ctx.db.get(args.asambleaId);
    if (!asamblea) return { cerradas: 0 };
    await requireCondominioRole(ctx, asamblea.condominioId, [...WRITE_ROLES]);
    if (asamblea.estado === "en_curso") return { cerradas: 0 };
    const votaciones = await ctx.db
      .query("votaciones")
      .withIndex("by_asamblea", (q) => q.eq("asambleaId", args.asambleaId))
      .collect();
    const now = Date.now();
    let cerradas = 0;
    for (const vt of votaciones) {
      if (vt.estado === "abierta") {
        await ctx.db.patch(vt._id, { estado: "cerrada", updatedAt: now });
        cerradas++;
      }
    }
    return { cerradas };
  },
});

export const createVotacion = mutation({
  args: {
    asambleaId: v.id("asambleas"),
    pregunta: v.string(),
    opciones: v.array(v.string()),
    /** Segundos abiertos. 0 / omitido = sin límite. Solo aplica si la asamblea está en curso. */
    duracionSegundos: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const asamblea = await ctx.db.get(args.asambleaId);
    if (!asamblea) throw new Error("Asamblea no encontrada.");
    await requireCondominioRole(ctx, asamblea.condominioId, [...WRITE_ROLES]);
    const now = Date.now();
    const pregunta = args.pregunta.trim();
    if (!pregunta) throw new Error("La pregunta es obligatoria.");
    const opciones = args.opciones
      .map((o) => o.trim())
      .filter(Boolean)
      .map((texto) => ({ texto, votos: 0 }));
    if (opciones.length < 2) {
      throw new Error("La votación necesita al menos 2 opciones.");
    }
    // Solo se abre al público si la asamblea ya está en curso.
    const enCurso = asamblea.estado === "en_curso";
    const dur = Math.max(0, Math.floor(args.duracionSegundos ?? 0));
    const cierraEn = enCurso && dur > 0 ? now + dur * 1000 : undefined;
    const id = await ctx.db.insert("votaciones", {
      condominioId: asamblea.condominioId,
      asambleaId: args.asambleaId,
      asambleaTitulo: asamblea.titulo,
      pregunta,
      opciones,
      estado: enCurso ? "abierta" : "cerrada",
      ...(enCurso
        ? {
            abiertaAlgunaVez: true,
            abiertaEn: now,
            ...(cierraEn != null ? { cierraEn } : {}),
          }
        : {}),
      createdAt: now,
      updatedAt: now,
    });
    // Enlazar al orden del día para poder cerrar / gestionar desde la sala.
    const orden = ordenDiaActual(asamblea);
    orden.push({ titulo: pregunta, votacionId: id });
    await ctx.db.patch(args.asambleaId, {
      ordenDia: orden,
      agenda: orden.map((p) => p.titulo),
      updatedAt: now,
    });
    if (cierraEn != null) {
      await ctx.scheduler.runAfter(
        cierraEn - now,
        internal.asambleas.cerrarVotacionSiExpiro,
        { id, cierraEn },
      );
    }
    if (enCurso) {
      await registrarBitacora(ctx, {
        condominioId: asamblea.condominioId,
        asambleaId: args.asambleaId,
        tipo: "votacion_abierta",
        nombre: pregunta,
        detalle:
          dur > 0
            ? `Abierta · ${Math.round(dur / 60)} min`
            : "Abierta · sin límite",
      });
    }
    return id;
  },
});

export const setVotos = mutation({
  args: {
    id: v.id("votaciones"),
    opciones: v.array(v.object({ texto: v.string(), votos: v.number() })),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.id);
    if (!existing) throw new Error("Votación no encontrada.");
    await requireCondominioRole(ctx, existing.condominioId, [...WRITE_ROLES]);
    await ctx.db.patch(args.id, { opciones: args.opciones, updatedAt: Date.now() });
  },
});

export const toggleVotacion = mutation({
  args: {
    id: v.id("votaciones"),
    /** Al abrir: segundos de duración. 0 / omitido = sin límite. */
    duracionSegundos: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.id);
    if (!existing) throw new Error("Votación no encontrada.");
    await requireCondominioRole(ctx, existing.condominioId, [...WRITE_ROLES]);
    const abrir = existing.estado !== "abierta";
    if (abrir) {
      const asamblea = await ctx.db.get(existing.asambleaId);
      if (!asamblea || asamblea.estado !== "en_curso") {
        throw new Error("Inicia la asamblea antes de abrir una votación.");
      }
    }
    const ahora = Date.now();
    if (abrir) {
      const dur = Math.max(0, Math.floor(args.duracionSegundos ?? 0));
      const cierraEn = dur > 0 ? ahora + dur * 1000 : undefined;
      await ctx.db.patch(args.id, {
        estado: "abierta",
        // `abiertaEn` se refresca en cada apertura: si un punto se reabre, la
        // ventana que vale para el quórum es la última, no la primera.
        abiertaAlgunaVez: true,
        abiertaEn: ahora,
        cierraEn,
        updatedAt: ahora,
      });
      if (cierraEn != null) {
        await ctx.scheduler.runAfter(
          cierraEn - ahora,
          internal.asambleas.cerrarVotacionSiExpiro,
          { id: args.id, cierraEn },
        );
      }
      await registrarBitacora(ctx, {
        condominioId: existing.condominioId,
        asambleaId: existing.asambleaId,
        tipo: "votacion_abierta",
        nombre: existing.pregunta,
        detalle:
          dur > 0
            ? `Abierta · ${Math.round(dur / 60)} min`
            : "Abierta · sin límite",
      });
    } else {
      await ctx.db.patch(args.id, {
        estado: "cerrada",
        cerradaEn: ahora,
        cierraEn: undefined,
        updatedAt: ahora,
      });
      await registrarBitacora(ctx, {
        condominioId: existing.condominioId,
        asambleaId: existing.asambleaId,
        tipo: "votacion_cerrada",
        nombre: existing.pregunta,
        detalle: "Cerrada por la mesa",
      });
    }
  },
});

/**
 * Extiende el temporizador (o reabre una cerrada) sumando segundos.
 * Si estaba abierta sin límite, pasa a cerrar en `ahora + extra`.
 */
export const extenderVotacion = mutation({
  args: {
    id: v.id("votaciones"),
    segundosExtra: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.id);
    if (!existing) throw new Error("Votación no encontrada.");
    await requireCondominioRole(ctx, existing.condominioId, [...WRITE_ROLES]);
    const asamblea = await ctx.db.get(existing.asambleaId);
    if (!asamblea || asamblea.estado !== "en_curso") {
      throw new Error("La asamblea no está en curso.");
    }
    const extra = Math.max(30, Math.min(Math.floor(args.segundosExtra), 3600));
    const ahora = Date.now();
    const base =
      existing.estado === "abierta" && existing.cierraEn != null
        ? Math.max(ahora, existing.cierraEn)
        : ahora;
    const cierraEn = base + extra * 1000;
    await ctx.db.patch(args.id, {
      estado: "abierta",
      abiertaAlgunaVez: true,
      abiertaEn:
        existing.estado === "abierta"
          ? (existing.abiertaEn ?? ahora)
          : ahora,
      cierraEn,
      updatedAt: ahora,
    });
    await ctx.scheduler.runAfter(
      cierraEn - ahora,
      internal.asambleas.cerrarVotacionSiExpiro,
      { id: args.id, cierraEn },
    );
    return { cierraEn };
  },
});

/** Cierra la votación solo si el `cierraEn` programado sigue vigente. */
export const cerrarVotacionSiExpiro = internalMutation({
  args: {
    id: v.id("votaciones"),
    cierraEn: v.number(),
  },
  handler: async (ctx, args) => {
    const vt = await ctx.db.get(args.id);
    if (!vt || vt.estado !== "abierta") return;
    if (vt.cierraEn !== args.cierraEn) return;
    const ahora = Date.now();
    if ((vt.cierraEn ?? 0) > ahora + 750) return;
    await ctx.db.patch(vt._id, {
      estado: "cerrada",
      cerradaEn: ahora,
      cierraEn: undefined,
      updatedAt: ahora,
    });
    await registrarBitacora(ctx, {
      condominioId: vt.condominioId,
      asambleaId: vt.asambleaId,
      tipo: "votacion_cerrada",
      nombre: vt.pregunta,
      detalle: "Cerrada por tiempo",
    });
  },
});

export const removeVotacion = mutation({
  args: { id: v.id("votaciones") },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.id);
    if (!existing) throw new Error("Votación no encontrada.");
    await requireCondominioRole(ctx, existing.condominioId, [...WRITE_ROLES]);
    await ctx.db.delete(args.id);
  },
});

// ─────────────────────────────────────────────────────────────
// Asamblea en vivo: asistencia (quórum) y votación por unidad
// ─────────────────────────────────────────────────────────────

/**
 * Unidades vinculadas al usuario en el condominio (con su doc). Solo vínculos
 * VIGENTES (`vigentes`): quien ya no vive en la casa no registra asistencia
 * ni vota por ella (QA de comprobantes, H3).
 */
async function misUnidades(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  condominioId: Id<"condominios">,
) {
  const membership = await getMembership(ctx, userId, condominioId);
  if (!membership || !membership.isActive) return [];
  const links = vigentes(
    await ctx.db
      .query("usuarioUnidad")
      .withIndex("by_membership", (q) => q.eq("membershipId", membership._id))
      .collect(),
  );
  const unidades = await Promise.all(links.map((l) => ctx.db.get(l.unidadId)));
  return unidades.filter((u): u is NonNullable<typeof u> => u !== null);
}

/** Admin / junta / representante de asamblea (o platform admin). */
async function esGestorAsamblea(
  ctx: QueryCtx | MutationCtx,
  condominioId: Id<"condominios">,
  user: { _id: Id<"users">; platformRole?: string | null },
) {
  if (user.platformRole === "superadmin" || user.platformRole === "admin") return true;
  const m = await getMembership(ctx, user._id, condominioId);
  if (!m?.isActive) return false;
  return m.roles.some((r) => (WRITE_ROLES as readonly string[]).includes(r));
}

/** Dueño (propietario) de una unidad, si existe. */
async function dueñoUnidad(
  ctx: QueryCtx | MutationCtx,
  unidadId: Id<"unidades">,
): Promise<{ userId: Id<"users">; nombre: string } | null> {
  const links = await ctx.db
    .query("usuarioUnidad")
    .withIndex("by_unidad", (q) => q.eq("unidadId", unidadId))
    .collect();
  if (links.length === 0) return null;
  const preferido =
    links.find((l) => l.vinculo === "propietario") ??
    links.find((l) => l.esPrincipal) ??
    links[0]!;
  const membership = await ctx.db.get(preferido.membershipId);
  if (!membership) return null;
  const usr = await ctx.db.get(membership.userId);
  if (!usr) return null;
  return { userId: usr._id, nombre: usr.name };
}

/**
 * El propietario registra su asistencia (sus casas + las que representa por poder).
 * Idempotente: si la unidad ya está presente, no duplica.
 */
export const registrarAsistencia = mutation({
  args: { asambleaId: v.id("asambleas") },
  handler: async (ctx, args) => {
    const asamblea = await ctx.db.get(args.asambleaId);
    if (!asamblea) throw new Error("Asamblea no encontrada.");
    if (asamblea.estado === "finalizada" || asamblea.estado === "cancelada") {
      throw new Error("La asamblea ya no está activa.");
    }
    /* En asambleas virtuales la asistencia SIEMPRE exige el código que el
     * administrador proyecta en la reunión. Sin esto, cualquiera marcaría
     * asistencia desde su casa sin conectarse y el quórum quedaría inflado.
     * Ver `registrarAsistenciaConCodigoAsamblea`. */
    if (asamblea.modalidad === "virtual") {
      throw new Error(
        "Esta asamblea es virtual: entra a la sala para registrar tu asistencia, o usa el código que proyecta la administración.",
      );
    }
    const user = await requireAppUser(ctx);
    const { filas, poderesRecibidos } = await filasAsistenciaPersona(ctx, {
      asambleaId: args.asambleaId,
      condominioId: asamblea.condominioId,
      userId: user._id,
      userNombre: user.name,
    });
    if (filas.length === 0) {
      throw new Error(
        "No tienes unidades para registrar. Si delegaste tu poder, el apoderado usa su código en sala.",
      );
    }
    const registradas = await insertarAsistencias(ctx, {
      origen: "presencial",
      condominioId: asamblea.condominioId,
      asambleaId: args.asambleaId,
      filas,
    });
    return { registradas, unidades: filas.length };
  },
});

/**
 * Entrar a la sala de Vekino = registrar asistencia. Sin código.
 *
 * Es una mutation pública: la garantía NO es "solo se llama desde la
 * pantalla de la sala" (eso no existe en un backend), sino lo que se valida
 * aquí dentro: membresía, asamblea EN CURSO —más estricto que el código, que
 * permitía registrarse antes de iniciar— y las mismas unidades que
 * `filasAsistenciaPersona` (propias no delegadas + poderes ACEPTADOS). La
 * mesa controla la ventana (abre/cierra la asamblea), ve los conectados en
 * vivo y la conexión queda en `asambleaSesiones` con su permanencia, que es
 * más prueba de la que el código dio nunca.
 *
 * El código rotativo sigue vivo como vía para quien sigue la reunión por
 * fuera (Meet/Zoom, app móvil): posee el código quien ve la pantalla.
 */
/**
 * Solo https y sin espacios: un enlace de reunión es un link que TODA la
 * comunidad va a abrir con un clic; aceptar `javascript:` o `http:` aquí
 * sería regalar el vector.
 */
function saneaEnlaceReunion(valor: string): string {
  const limpio = valor.trim();
  if (limpio === "") return "";
  let url: URL;
  try {
    url = new URL(limpio);
  } catch {
    throw new Error("El enlace de la reunión no es una URL válida.");
  }
  if (url.protocol !== "https:") {
    throw new Error("El enlace de la reunión debe empezar por https://");
  }
  return url.toString();
}

/** La mesa fija (o quita, con "") el enlace externo de la reunión. */
export const setEnlaceReunion = mutation({
  args: { asambleaId: v.id("asambleas"), enlace: v.string() },
  handler: async (ctx, args) => {
    const asamblea = await ctx.db.get(args.asambleaId);
    if (!asamblea) throw new Error("Asamblea no encontrada.");
    await requireCondominioRole(ctx, asamblea.condominioId, [...WRITE_ROLES]);
    const enlace = saneaEnlaceReunion(args.enlace);
    await ctx.db.patch(args.asambleaId, {
      enlaceReunion: enlace === "" ? undefined : enlace,
      updatedAt: Date.now(),
    });
    return { enlace };
  },
});

/**
 * Versión del apoderado (con o sin cuenta): el código del PODER ya es la
 * prueba de posesión — pedirle además el código proyectado dentro de la sala
 * de Vekino era el mismo círculo que se quitó para el residente. El código
 * rotativo le queda a quien sigue la reunión por fuera.
 */
export const entrarYRegistrarConPoder = mutation({
  args: { codigo: v.string() },
  handler: async (ctx, args) => {
    const codigo = args.codigo.trim().toUpperCase();
    if (codigo.length < 4) throw new Error("Código inválido.");

    const poderes = await ctx.db
      .query("poderesAsamblea")
      .withIndex("by_codigo", (q) => q.eq("codigoAcceso", codigo))
      .collect();
    if (poderes.length === 0) throw new Error("Código no encontrado.");

    const asamblea = await ctx.db.get(poderes[0]!.asambleaId);
    if (!asamblea) throw new Error("Asamblea no encontrada.");
    if (asamblea.modalidad === "presencial") {
      throw new Error(
        "En asambleas presenciales el administrador registra la asistencia con tu código.",
      );
    }
    if (asamblea.estado !== "en_curso") {
      throw new Error("La sala aún no está abierta.");
    }

    const now = Date.now();
    const filas: FilaSesion[] = [];
    for (const p of poderes) {
      // Posesión del código = aceptación del poder (igual que la vía rotativa).
      if (!p.validado) await ctx.db.patch(p._id, { validado: true, updatedAt: now });
      filas.push({
        unidadId: p.unidadId,
        unidadNumero: p.unidadNumero,
        userId: p.representanteUserId ?? p.otorganteUserId,
        userNombre: p.representanteNombre,
        coeficiente: p.coeficiente,
        esPoder: true,
      });
    }
    const registradas = await insertarAsistencias(ctx, {
      origen: "poder_codigo",
      condominioId: asamblea.condominioId,
      asambleaId: asamblea._id,
      filas,
    });
    return { registradas, unidades: poderes.map((p) => p.unidadNumero) };
  },
});

export const entrarYRegistrar = mutation({
  args: { asambleaId: v.id("asambleas") },
  handler: async (ctx, args) => {
    const asamblea = await ctx.db.get(args.asambleaId);
    if (!asamblea) throw new Error("Asamblea no encontrada.");
    if (asamblea.modalidad === "presencial") {
      /* En presencial la asistencia la corrobora la mesa (QR en el punto de
       * registro). Auto-registrarse desde la casa inflaría el quórum. */
      throw new Error(
        "Esta asamblea es presencial: la asistencia se registra en el punto de control.",
      );
    }
    if (asamblea.estado !== "en_curso") {
      throw new Error("La sala aún no está abierta.");
    }
    const user = await requireAppUser(ctx);
    await requireCondominioRole(ctx, asamblea.condominioId, []);

    const { filas } = await filasAsistenciaPersona(ctx, {
      asambleaId: args.asambleaId,
      condominioId: asamblea.condominioId,
      userId: user._id,
      userNombre: user.name,
    });
    /* Sin unidades (mesa, o delegó todo y no representa a nadie) no es un
     * fallo: puede quedarse en la sala escuchando. Antes se lanzaba error y
     * ensuciaba la consola aunque el cliente lo silenciara. */
    if (filas.length === 0) {
      return { registradas: 0, unidades: [] as string[], sinUnidades: true as const };
    }
    const registradas = await insertarAsistencias(ctx, {
      origen: "sala",
      condominioId: asamblea.condominioId,
      asambleaId: args.asambleaId,
      filas,
    });
    return { registradas, unidades: filas.map((f) => f.unidadNumero), sinUnidades: false as const };
  },
});

/* ─── Código rotativo de asistencia (asambleas virtuales) ─────────────────
 *
 * Flujo:
 *   1. El admin abre el modo presentación → `iniciarCodigoAsistencia` crea la
 *      semilla (una sola vez por asamblea).
 *   2. `semillaAsistencia` le entrega la semilla al admin. Con ella el panel
 *      calcula el código de cada minuto EN EL NAVEGADOR, sin volver a pedir
 *      nada: una consulta de Convex no se re-ejecuta sola cada segundo.
 *   3. El residente escribe (o escanea) el código y llama a
 *      `registrarAsistenciaConCodigoAsamblea`, que valida recalculando.
 *
 * La semilla NUNCA se le devuelve a un residente: si la tuviera, podría
 * generar los códigos de todos los minutos siguientes sin estar en la
 * reunión, que es justo lo que esto evita.
 */

/** Crea la semilla si aún no existe. Solo administración. */
export const iniciarCodigoAsistencia = mutation({
  args: { asambleaId: v.id("asambleas") },
  handler: async (ctx, args) => {
    const asamblea = await ctx.db.get(args.asambleaId);
    if (!asamblea) throw new Error("Asamblea no encontrada.");
    await requireCondominioRole(ctx, asamblea.condominioId, [...WRITE_ROLES]);

    if (asamblea.codigoAsistenciaSemilla) {
      return { semilla: asamblea.codigoAsistenciaSemilla, creada: false };
    }
    const semilla = nuevaSemilla();
    await ctx.db.patch(args.asambleaId, {
      codigoAsistenciaSemilla: semilla,
      updatedAt: Date.now(),
    });
    return { semilla, creada: true };
  },
});

/**
 * Invalida todos los códigos anteriores generando una semilla nueva.
 * Útil si el admin sospecha que alguien difundió el código fuera de la sala.
 */
export const rotarCodigoAsistencia = mutation({
  args: { asambleaId: v.id("asambleas") },
  handler: async (ctx, args) => {
    const asamblea = await ctx.db.get(args.asambleaId);
    if (!asamblea) throw new Error("Asamblea no encontrada.");
    await requireCondominioRole(ctx, asamblea.condominioId, [...WRITE_ROLES]);

    const semilla = nuevaSemilla();
    await ctx.db.patch(args.asambleaId, {
      codigoAsistenciaSemilla: semilla,
      updatedAt: Date.now(),
    });
    return { semilla };
  },
});

/**
 * Semilla + código vigente, SOLO para administración.
 *
 * Devuelve también el código actual y cuánto le queda, para que el panel
 * pueda pintar algo aunque todavía no haya arrancado su propio reloj.
 */
export const semillaAsistencia = query({
  args: { asambleaId: v.id("asambleas") },
  handler: async (ctx, args) => {
    const asamblea = await ctx.db.get(args.asambleaId);
    if (!asamblea) return null;
    await requireCondominioRole(ctx, asamblea.condominioId, [...WRITE_ROLES]);

    const semilla = asamblea.codigoAsistenciaSemilla;
    if (!semilla) return { semilla: null, codigo: null, msRestantes: 0 };

    const ahora = Date.now();
    return {
      semilla,
      codigo: codigoActual(semilla, ahora),
      msRestantes: msRestantes(ahora),
      ventanaMs: VENTANA_MS,
    };
  },
});

/**
 * El residente registra su asistencia con el código proyectado en la reunión.
 *
 * Hace exactamente lo mismo que `registrarAsistencia` una vez validado el
 * código: registra sus unidades y las de los poderes que haya recibido.
 */
export const registrarAsistenciaConCodigoAsamblea = mutation({
  args: { asambleaId: v.id("asambleas"), codigo: v.string() },
  handler: async (ctx, args) => {
    const asamblea = await ctx.db.get(args.asambleaId);
    if (!asamblea) throw new Error("Asamblea no encontrada.");
    if (asamblea.estado === "finalizada" || asamblea.estado === "cancelada") {
      throw new Error("La asamblea ya no está activa.");
    }
    const semilla = asamblea.codigoAsistenciaSemilla;
    if (!semilla) {
      throw new Error(
        "La administración todavía no ha abierto el registro de asistencia.",
      );
    }
    if (!codigoEsValido(semilla, args.codigo, Date.now())) {
      throw new Error(
        "Código incorrecto o vencido. Mira el que aparece ahora en pantalla.",
      );
    }

    const user = await requireAppUser(ctx);
    const { filas, poderesRecibidos } = await filasAsistenciaPersona(ctx, {
      asambleaId: args.asambleaId,
      condominioId: asamblea.condominioId,
      userId: user._id,
      userNombre: user.name,
    });
    if (filas.length === 0) {
      throw new Error(
        "No tienes unidades para registrar. Si delegaste tu poder, el apoderado usa su código en sala.",
      );
    }
    const registradas = await insertarAsistencias(ctx, {
      origen: "codigo",
      condominioId: asamblea.condominioId,
      asambleaId: args.asambleaId,
      filas,
    });
    return { registradas, unidades: filas.length };
  },
});

/**
 * Quórum en tiempo real: % de coeficiente presente (o % de unidades si el
 * condominio no maneja coeficientes), unidades conectadas y total.
 */
export const quorum = query({
  args: { asambleaId: v.id("asambleas") },
  handler: async (ctx, args) => {
    const asamblea = await ctx.db.get(args.asambleaId);
    if (!asamblea) return null;
    await requireCondominioRole(ctx, asamblea.condominioId, []);

    const asistentes = await ctx.db
      .query("asambleaAsistentes")
      .withIndex("by_asamblea", (q) => q.eq("asambleaId", args.asambleaId))
      .collect();

    const poderes = await ctx.db
      .query("poderesAsamblea")
      .withIndex("by_asamblea", (q) => q.eq("asambleaId", args.asambleaId))
      .collect();

    const unidades = await ctx.db
      .query("unidades")
      .withIndex("by_condominio", (q) => q.eq("condominioId", asamblea.condominioId))
      .collect();

    // Cálculo único y compartido (model/quorum.ts): este número, el del
    // apoderado y el del acta tienen que coincidir siempre.
    const q = calcularQuorum({ asistentes, poderes, unidades });

    return {
      pct: q.pct,
      unidadesPresentes: q.unidadesPresentes,
      totalUnidades: q.totalUnidades,
      poderesActivos: q.poderesValidados,
      quorumRequerido: asamblea.quorumRequerido ?? 51,
      asistentes: asistentes
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 200)
        .map((a) => ({
          unidadNumero: a.unidadNumero,
          userNombre: a.userNombre,
          coeficiente: a.coeficiente ?? null,
          createdAt: a.createdAt,
          esPoder: !!a.esPoder,
        })),
    };
  },
});

/** Asistencia y votos del usuario actual en la asamblea (para la UI). */
export const miParticipacion = query({
  args: { asambleaId: v.id("asambleas") },
  handler: async (ctx, args) => {
    const asamblea = await ctx.db.get(args.asambleaId);
    if (!asamblea) return null;
    const user = await getCurrentAppUser(ctx);
    if (!user) return null;

    const misAsistencias = await ctx.db
      .query("asambleaAsistentes")
      .withIndex("by_asamblea_user", (q) =>
        q.eq("asambleaId", args.asambleaId).eq("userId", user._id),
      )
      .collect();

    /* Solo los votos PROPIOS, por índice.
     *
     * Antes traía todos los de la asamblea y filtraba en memoria. Eso costaba
     * dos veces: leía cientos de documentos por ejecución, y —lo caro— al
     * haber recorrido el rango entero, cada voto de cualquier vecino
     * reejecutaba esta consulta en los 173 conectados. Una votación de 173
     * personas disparaba ~30.000 ejecuciones de esto. Ahora el voto ajeno
     * cae fuera del rango leído y no despierta a nadie. */
    const misVotos = await ctx.db
      .query("votosAsamblea")
      .withIndex("by_asamblea_user", (q) =>
        q.eq("asambleaId", args.asambleaId).eq("userId", user._id),
      )
      .collect();

    // Casas que este usuario representa por poder (validado) — si es apoderado con cuenta.
    const poderesRecibidos = await ctx.db
      .query("poderesAsamblea")
      .withIndex("by_representante", (q) =>
        q.eq("asambleaId", args.asambleaId).eq("representanteUserId", user._id),
      )
      .collect();
    const representa = poderesRecibidos.filter((p) => p.validado).map((p) => p.unidadNumero);

    // Unidades propias que ya delegó (poder validado) → no necesita QR de asistencia.
    const poderesOtorgados = (
      await ctx.db
        .query("poderesAsamblea")
        .withIndex("by_asamblea", (q) => q.eq("asambleaId", args.asambleaId))
        .collect()
    ).filter((p) => p.validado && p.otorganteUserId === user._id);
    const unidades = await misUnidades(ctx, user._id, asamblea.condominioId);
    const delegadas = new Set(poderesOtorgados.map((p) => p.unidadId as string));
    const propiasSinDelegar = unidades.filter((u) => !delegadas.has(u._id as string));
    const delegoTodo = unidades.length > 0 && propiasSinDelegar.length === 0;

    return {
      presente: misAsistencias.length > 0,
      userId: user._id,
      nombre: user.name,
      email: user.email ?? null,
      imageUrl: await resolveUserImage(ctx, user),
      /** Rol de plataforma (si aplica): superadmin | admin. */
      platformRole: user.platformRole ?? null,
      unidades: misAsistencias.map((a) => a.unidadNumero),
      representa,
      delegoTodo,
      /** Hay algo que marcar al entrar (propias sin delegar o poderes recibidos). */
      puedeRegistrar: propiasSinDelegar.length > 0 || poderesRecibidos.length > 0,
      apoderadoNombre: poderesOtorgados[0]?.representanteNombre ?? null,
      votos: Object.fromEntries(misVotos.map((vt) => [vt.votacionId as string, vt.opcionIndex])),
    };
  },
});

/**
 * El propietario vota en una votación abierta. Un voto por unidad (todas sus
 * unidades votan la misma opción). Puede cambiar el voto mientras esté abierta.
 * Recalcula los contadores de la votación para el tablero en vivo.
 */
async function assertVotacionAbierta(
  ctx: MutationCtx,
  votacion: {
    _id: Id<"votaciones">;
    estado: "abierta" | "cerrada";
    cierraEn?: number;
  },
) {
  if (votacion.estado !== "abierta") {
    throw new Error("La votación está cerrada.");
  }
  if (votacion.cierraEn != null && votacion.cierraEn <= Date.now()) {
    const ahora = Date.now();
    await ctx.db.patch(votacion._id, {
      estado: "cerrada",
      cerradaEn: ahora,
      cierraEn: undefined,
      updatedAt: ahora,
    });
    throw new Error("El tiempo de la votación terminó.");
  }
}

export const votar = mutation({
  args: { votacionId: v.id("votaciones"), opcionIndex: v.number() },
  handler: async (ctx, args) => {
    const votacion = await ctx.db.get(args.votacionId);
    if (!votacion) throw new Error("Votación no encontrada.");
    await assertVotacionAbierta(ctx, votacion);
    if (args.opcionIndex < 0 || args.opcionIndex >= votacion.opciones.length) {
      throw new Error("Opción inválida.");
    }
    const asamblea = await ctx.db.get(votacion.asambleaId);
    if (!asamblea || asamblea.estado !== "en_curso") {
      throw new Error("La asamblea aún no ha iniciado.");
    }
    const user = await requireAppUser(ctx);

    // Debe estar presente en la asamblea para votar.
    const asistencia = await ctx.db
      .query("asambleaAsistentes")
      .withIndex("by_asamblea_user", (q) =>
        q.eq("asambleaId", votacion.asambleaId).eq("userId", user._id),
      )
      .first();
    if (!asistencia) throw new Error("Registra tu asistencia antes de votar.");

    /* Presencia EN EL MOMENTO de votar, no "alguna vez entró".
     *
     * Va detrás de una bandera por asamblea y apagada por defecto: si el
     * frontend de la sala todavía no manda latidos, el cron cierra todas las
     * conexiones a los 90 s y esto dejaría a la asamblea entera sin poder
     * votar. Se enciende cuando la sala esté en producción
     * (`asambleaSala.exigirConexionParaVotar`). */
    if (asamblea.exigirConexionParaVotar) {
      const conectado = await tieneConexionAbierta(
        ctx,
        votacion.asambleaId,
        asistencia.unidadId,
      );
      if (!conectado) {
        throw new Error(
          "Perdiste la conexión con la sala. Vuelve a entrar para poder votar.",
        );
      }
    }

    // Poderes de la asamblea: unidades que delegué (no las voto) y las que me delegaron.
    const poderes = await ctx.db
      .query("poderesAsamblea")
      .withIndex("by_asamblea", (q) => q.eq("asambleaId", votacion.asambleaId))
      .collect();
    const delegadasAway = new Set(
      poderes.filter((p) => p.validado && p.otorganteUserId === user._id).map((p) => p.unidadId as string),
    );
    const delegadasAMi = poderes.filter((p) => p.validado && p.representanteUserId === user._id);

    // Unidades votables = propias (no delegadas) + delegadas a mí (poder validado).
    const propias = (await misUnidades(ctx, user._id, votacion.condominioId))
      .filter((u) => !delegadasAway.has(u._id as string))
      .map((u) => ({ id: u._id, numero: u.numero, coeficiente: u.coeficiente }));
    const delegadas = delegadasAMi.map((p) => ({
      id: p.unidadId,
      numero: p.unidadNumero,
      coeficiente: p.coeficiente,
    }));
    const votables = [...propias, ...delegadas];
    if (votables.length === 0) {
      throw new Error("No tienes unidades habilitadas para votar en esta asamblea.");
    }

    const now = Date.now();
    for (const unidad of votables) {
      const existing = await ctx.db
        .query("votosAsamblea")
        .withIndex("by_votacion_unidad", (q) =>
          q.eq("votacionId", args.votacionId).eq("unidadId", unidad.id),
        )
        .first();
      if (existing) {
        await ctx.db.patch(existing._id, {
          opcionIndex: args.opcionIndex,
          userId: user._id,
          createdAt: now,
        });
      } else {
        await ctx.db.insert("votosAsamblea", {
          condominioId: votacion.condominioId,
          asambleaId: votacion.asambleaId,
          votacionId: args.votacionId,
          unidadId: unidad.id,
          unidadNumero: unidad.numero,
          userId: user._id,
          opcionIndex: args.opcionIndex,
          coeficiente: unidad.coeficiente,
          createdAt: now,
        });
      }
    }

    // Recalcula contadores (unidades por opción) para el tablero en vivo.
    const votos = await ctx.db
      .query("votosAsamblea")
      .withIndex("by_votacion", (q) => q.eq("votacionId", args.votacionId))
      .collect();
    const opciones = votacion.opciones.map((o, i) => ({
      texto: o.texto,
      votos: votos.filter((vt) => vt.opcionIndex === i).length,
    }));
    await ctx.db.patch(args.votacionId, { opciones, updatedAt: now });

    await registrarBitacora(ctx, {
      condominioId: votacion.condominioId,
      asambleaId: votacion.asambleaId,
      tipo: "voto",
      nombre: user.name,
      detalle: `${votables.map((u) => u.numero).join(", ")} → ${votacion.opciones[args.opcionIndex]?.texto ?? `opción ${args.opcionIndex + 1}`}`,
      userId: user._id,
    });

    return { ok: true as const };
  },
});

/** Resultados en vivo de una votación (conteo por unidades y por coeficiente). */
export const resultadosVotacion = query({
  args: { votacionId: v.id("votaciones") },
  handler: async (ctx, args) => {
    const votacion = await ctx.db.get(args.votacionId);
    if (!votacion) return null;
    await requireCondominioRole(ctx, votacion.condominioId, []);

    const votos = await ctx.db
      .query("votosAsamblea")
      .withIndex("by_votacion", (q) => q.eq("votacionId", args.votacionId))
      .collect();

    return {
      estado: votacion.estado,
      pregunta: votacion.pregunta,
      cierraEn: votacion.cierraEn ?? null,
      opciones: votacion.opciones.map((o, i) => {
        const propios = votos.filter((vt) => vt.opcionIndex === i);
        return {
          texto: o.texto,
          votos: propios.length,
          coeficiente: Math.round(propios.reduce((s, vt) => s + (vt.coeficiente ?? 0), 0) * 100) / 100,
        };
      }),
      totalVotos: votos.length,
    };
  },
});

/**
 * Quién ya votó / quién falta: visible para cualquiera con acceso al condominio
 * (misma info de unidades que ve la mesa en la sala).
 */
export const seguimientoVoto = query({
  args: { votacionId: v.id("votaciones") },
  handler: async (ctx, args) => {
    const votacion = await ctx.db.get(args.votacionId);
    if (!votacion) return null;
    await requireCondominioRole(ctx, votacion.condominioId, []);

    const asamblea = await ctx.db.get(votacion.asambleaId);
    if (!asamblea) return null;

    const asistentes = await ctx.db
      .query("asambleaAsistentes")
      .withIndex("by_asamblea", (q) => q.eq("asambleaId", votacion.asambleaId))
      .collect();
    const poderes = (
      await ctx.db
        .query("poderesAsamblea")
        .withIndex("by_asamblea", (q) => q.eq("asambleaId", votacion.asambleaId))
        .collect()
    ).filter((p) => p.validado);
    const votos = await ctx.db
      .query("votosAsamblea")
      .withIndex("by_votacion", (q) => q.eq("votacionId", args.votacionId))
      .collect();

    const presentes = new Map<string, string>(); // unidadId → numero
    for (const a of asistentes) {
      presentes.set(a.unidadId as string, a.unidadNumero);
    }
    // Unidades de poderes cuyo apoderado ya está presente.
    const asistenteUsers = new Set(
      asistentes.map((a) => a.userId as string).filter(Boolean),
    );
    const asistenteNombres = new Set(
      asistentes.map((a) => a.userNombre.trim().toLowerCase()),
    );
    for (const p of poderes) {
      const key = p.unidadId as string;
      if (presentes.has(key)) continue;
      const porUser =
        p.representanteUserId &&
        asistenteUsers.has(p.representanteUserId as string);
      const porNombre = asistenteNombres.has(
        p.representanteNombre.trim().toLowerCase(),
      );
      if (porUser || porNombre) {
        presentes.set(key, p.unidadNumero);
      }
    }

    const votaronSet = new Set(votos.map((v) => v.unidadId as string));
    const votaron = [...new Set(votos.map((v) => v.unidadNumero))].sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true }),
    );

    const pendientes = [...presentes.entries()]
      .filter(([id]) => !votaronSet.has(id))
      .map(([, num]) => num)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    return {
      estado: votacion.estado,
      cierraEn: votacion.cierraEn ?? null,
      votaron,
      pendientes: [...new Set(pendientes)],
    };
  },
});

// ─────────────────────────────────────────────────────────────
// Poderes (delegación de voto)
// ─────────────────────────────────────────────────────────────

/** Busca miembros del condominio para asignarles un poder (nombre/correo). */
export const buscarUsuarios = query({
  args: { condominioId: v.id("condominios"), search: v.string() },
  handler: async (ctx, args) => {
    await requireCondominioRole(ctx, args.condominioId, []);
    const term = args.search.trim().toLowerCase();
    if (term.length < 2) return [];

    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
      .collect();

    const users = await Promise.all(memberships.map((m) => ctx.db.get(m.userId)));
    return users
      .filter((u): u is NonNullable<typeof u> => u !== null)
      .filter(
        (u) =>
          u.name.toLowerCase().includes(term) ||
          (u.email ?? "").toLowerCase().includes(term),
      )
      .slice(0, 20)
      .map((u) => ({ _id: u._id, name: u.name, email: u.email }));
  },
});

/** El propietario otorga un poder de una de SUS unidades a un representante. */
/** Genera un código de acceso corto (evita caracteres ambiguos). */
function generarCodigo(unidadId: string): string {
  const raw = (Date.now().toString(36) + unidadId)
    .replace(/[^a-z0-9]/gi, "")
    .toUpperCase()
    .replace(/[O0I1L]/g, "X");
  return raw.slice(-6);
}

/**
 * El propietario otorga un poder de una de SUS unidades a un apoderado (persona,
 * puede no tener cuenta). Se genera un CÓDIGO que el apoderado usará para entrar
 * y votar. Si el mismo apoderado (documento) ya tiene poder en esta asamblea, se
 * reutiliza su código (así representa varias casas con el mismo código).
 */
export const otorgarPoder = mutation({
  args: {
    asambleaId: v.id("asambleas"),
    unidadId: v.id("unidades"),
    documentoStorageId: v.optional(v.id("_storage")), // PDF/foto del poder firmado (legacy)
    documentoUrl: v.optional(v.string()),
    // Modo A: seleccionar un propietario existente del conjunto.
    representanteUserId: v.optional(v.id("users")),
    // Modo B: persona externa (por nombre/documento).
    apoderadoNombre: v.optional(v.string()),
    apoderadoDocumento: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ codigo: string; nombre: string; esPropietario: boolean }> => {
    const asamblea = await ctx.db.get(args.asambleaId);
    if (!asamblea) throw new Error("Asamblea no encontrada.");
    if (asamblea.estado === "finalizada" || asamblea.estado === "cancelada") {
      throw new Error("La asamblea ya no está activa.");
    }
    const user = await requireAppUser(ctx);
    const esWriter = await esGestorAsamblea(ctx, asamblea.condominioId, user);

    // Público solo puede otorgar mientras la asamblea está programada.
    // En curso: únicamente administración (registro manual interno).
    if (asamblea.estado === "en_curso") {
      if (!esWriter) {
        throw new Error(
          "La asamblea ya inició. Solo la administración puede registrar poderes.",
        );
      }
    } else if (asamblea.estado !== "programada") {
      throw new Error("La asamblea ya no está activa.");
    }

    let unidadNumero: string;
    let coeficiente: number | undefined;
    let otorganteUserId: Id<"users">;
    let otorganteNombre: string;

    if (esWriter) {
      const unidad = await ctx.db.get(args.unidadId);
      if (!unidad || unidad.condominioId !== asamblea.condominioId) {
        throw new Error("Unidad no válida para esta asamblea.");
      }
      unidadNumero = unidad.numero;
      coeficiente = unidad.coeficiente;
      const dueño = await dueñoUnidad(ctx, args.unidadId);
      otorganteUserId = dueño?.userId ?? user._id;
      otorganteNombre = dueño?.nombre ?? user.name;
    } else {
      const propias = await misUnidades(ctx, user._id, asamblea.condominioId);
      const unidad = propias.find((u) => u._id === args.unidadId);
      if (!unidad) throw new Error("Esa unidad no está vinculada a tu cuenta.");
      unidadNumero = unidad.numero;
      coeficiente = unidad.coeficiente;
      otorganteUserId = user._id;
      otorganteNombre = user.name;
    }

    // Resuelve el apoderado: usuario existente o persona externa.
    let nombre: string;
    let documento: string | undefined;
    let representanteExistente: Id<"users"> | undefined;
    if (args.representanteUserId) {
      if (args.representanteUserId === otorganteUserId) {
        throw new Error("No puedes dar el poder al mismo otorgante.");
      }
      const rep = await ctx.db.get(args.representanteUserId);
      if (!rep) throw new Error("Propietario no encontrado.");
      /* Sin esto se podía nombrar representante a CUALQUIER usuario de la
       * plataforma, aunque no perteneciera al condominio. */
      const mRep = await getMembership(ctx, rep._id, asamblea.condominioId);
      if (!mRep?.isActive) {
        throw new Error("El apoderado debe ser miembro de este conjunto.");
      }
      nombre = rep.name;
      documento = rep.numeroDocumento ?? undefined;
      representanteExistente = rep._id;
    } else {
      nombre = (args.apoderadoNombre ?? "").trim();
      if (!nombre) throw new Error("El nombre del apoderado es obligatorio.");
      documento = args.apoderadoDocumento?.trim() || undefined;
    }

    // Una unidad → un solo poder por asamblea.
    const existing = await ctx.db
      .query("poderesAsamblea")
      .withIndex("by_asamblea_unidad", (q) =>
        q.eq("asambleaId", args.asambleaId).eq("unidadId", args.unidadId),
      )
      .first();
    if (existing) throw new Error("Esta unidad ya tiene un poder en esta asamblea.");

    // Reutiliza el código si el mismo apoderado (documento, o nombre) ya tiene poder.
    const todos = await ctx.db
      .query("poderesAsamblea")
      .withIndex("by_asamblea", (q) => q.eq("asambleaId", args.asambleaId))
      .collect();
    const mismo = todos.find((p) =>
      documento
        ? p.apoderadoDocumento === documento
        : p.representanteNombre.toLowerCase() === nombre.toLowerCase(),
    );
    const codigo = mismo?.codigoAcceso ?? generarCodigo(args.unidadId as string);

    // Si el apoderado ya es un propietario del conjunto, se enlaza a su cuenta
    // para que también pueda votar desde su propia sesión.
    let representanteUserId: Id<"users"> | undefined =
      representanteExistente ?? mismo?.representanteUserId;
    if (!representanteUserId && documento) {
      const posible = await ctx.db
        .query("users")
        .withIndex("by_numeroDocumento", (q) => q.eq("numeroDocumento", documento))
        .first();
      if (posible) {
        const m = await getMembership(ctx, posible._id, asamblea.condominioId);
        if (m) representanteUserId = posible._id;
      }
    }

    const now = Date.now();
    await ctx.db.insert("poderesAsamblea", {
      condominioId: asamblea.condominioId,
      asambleaId: args.asambleaId,
      unidadId: args.unidadId,
      unidadNumero,
      coeficiente,
      otorganteUserId,
      otorganteNombre,
      representanteUserId,
      representanteNombre: nombre,
      apoderadoDocumento: documento,
      codigoAcceso: codigo,
      documentoStorageId: args.documentoStorageId,
      documentoUrl: args.documentoUrl,
      // Vecino del conjunto: debe aceptar el poder. Externo: válido con el código.
      // Registro por administración queda validado de una vez.
      validado: esWriter ? true : !representanteUserId,
      createdAt: now,
      updatedAt: now,
    });
    return { codigo, nombre, esPropietario: !!representanteUserId };
  },
});

/** El representante (o admin) acepta o rechaza un poder recibido. */
export const responderPoder = mutation({
  args: { poderId: v.id("poderesAsamblea"), aceptar: v.boolean() },
  handler: async (ctx, args) => {
    const poder = await ctx.db.get(args.poderId);
    if (!poder) throw new Error("Poder no encontrado.");
    const asamblea = await ctx.db.get(poder.asambleaId);
    if (!asamblea) throw new Error("Asamblea no encontrada.");
    const { user } = await requireCondominioRole(ctx, poder.condominioId, []);
    const esWriter = await esGestorAsamblea(ctx, poder.condominioId, user);

    if (asamblea.estado !== "programada") {
      if (!esWriter) {
        throw new Error(
          "Con la asamblea en curso, solo la administración puede gestionar poderes.",
        );
      }
    } else if (poder.representanteUserId !== user._id && !esWriter) {
      throw new Error("Solo el representante puede responder este poder.");
    }

    if (args.aceptar) {
      await ctx.db.patch(args.poderId, { validado: true, updatedAt: Date.now() });
      /* Si el apoderado ya está presente (check-in físico o sala virtual),
       * aceptar el poder suma la unidad al quórum en cualquier modalidad.
       * La exclusión de virtual venía de cuando la única prueba era el
       * código proyectado; hoy la conexión a la sala es prueba más fuerte. */
      if (poder.representanteUserId) {
        const yaPresente = await ctx.db
          .query("asambleaAsistentes")
          .withIndex("by_asamblea_user", (q) =>
            q.eq("asambleaId", poder.asambleaId).eq("userId", poder.representanteUserId!),
          )
          .first();
        if (yaPresente) {
          await insertarAsistencias(ctx, {
            origen: "poder_codigo",
            condominioId: poder.condominioId,
            asambleaId: poder.asambleaId,
            filas: [
              {
                unidadId: poder.unidadId,
                unidadNumero: poder.unidadNumero,
                userId: poder.representanteUserId,
                userNombre: poder.representanteNombre,
                coeficiente: poder.coeficiente,
                esPoder: true,
              },
            ],
          });
        }
      }
    } else {
      await ctx.db.delete(args.poderId);
    }
  },
});

/** El otorgante (o admin) revoca un poder que otorgó, si aún no se ha votado con él. */
export const revocarPoder = mutation({
  args: { poderId: v.id("poderesAsamblea") },
  handler: async (ctx, args) => {
    const poder = await ctx.db.get(args.poderId);
    if (!poder) throw new Error("Poder no encontrado.");
    const asamblea = await ctx.db.get(poder.asambleaId);
    if (!asamblea) throw new Error("Asamblea no encontrada.");
    const { user } = await requireCondominioRole(ctx, poder.condominioId, []);
    const esWriter = await esGestorAsamblea(ctx, poder.condominioId, user);

    if (asamblea.estado !== "programada") {
      if (!esWriter) {
        throw new Error(
          "Con la asamblea en curso, solo la administración puede revocar poderes.",
        );
      }
    } else if (poder.otorganteUserId !== user._id && !esWriter) {
      throw new Error("Solo quien otorgó el poder puede revocarlo.");
    }

    // No revocar si esa unidad ya votó en la asamblea.
    const yaVoto = await ctx.db
      .query("votosAsamblea")
      .withIndex("by_asamblea", (q) => q.eq("asambleaId", poder.asambleaId))
      .collect();
    if (yaVoto.some((vt) => vt.unidadId === poder.unidadId)) {
      throw new Error("No se puede revocar: la unidad ya emitió un voto.");
    }
    await ctx.db.delete(args.poderId);
  },
});

/** URL firmada — @deprecated usar api.files.generateUploadUrl (S3). */
export const generateUploadUrl = mutation({
  args: {},
  handler: async () => {
    throw new Error(
      "Las subidas van a S3. Usa api.files.generateUploadUrl (action).",
    );
  },
});

/** Poderes que el usuario RECIBIÓ en esta asamblea (para aceptar/rechazar). */
export const poderesRecibidos = query({
  args: { asambleaId: v.id("asambleas") },
  handler: async (ctx, args) => {
    const user = await getCurrentAppUser(ctx);
    if (!user) return [];
    const poderes = await ctx.db
      .query("poderesAsamblea")
      .withIndex("by_representante", (q) =>
        q.eq("asambleaId", args.asambleaId).eq("representanteUserId", user._id),
      )
      .collect();
    return await Promise.all(
      poderes.map(async (p) => {
        const unidad = await ctx.db.get(p.unidadId);
        return {
          ...p,
          unidadTorre: unidad?.torre ?? null,
          unidadBloque: unidad?.bloque ?? null,
          documentoUrl:
            (await resolveMediaUrl(ctx, {
              url: p.documentoUrl,
              storageId: p.documentoStorageId,
            })) || null,
        };
      }),
    );
  },
});

/** Poderes que el usuario OTORGÓ en esta asamblea (para revocar). */
export const poderesOtorgados = query({
  args: { asambleaId: v.id("asambleas") },
  handler: async (ctx, args) => {
    const user = await getCurrentAppUser(ctx);
    if (!user) return [];
    const poderes = await ctx.db
      .query("poderesAsamblea")
      .withIndex("by_otorgante", (q) =>
        q.eq("asambleaId", args.asambleaId).eq("otorganteUserId", user._id),
      )
      .collect();
    return await Promise.all(
      poderes.map(async (p) => {
        const unidad = await ctx.db.get(p.unidadId);
        return {
          ...p,
          unidadTorre: unidad?.torre ?? null,
          unidadBloque: unidad?.bloque ?? null,
          documentoUrl:
            (await resolveMediaUrl(ctx, {
              url: p.documentoUrl,
              storageId: p.documentoStorageId,
            })) || null,
        };
      }),
    );
  },
});

/** Todos los poderes de la asamblea (vista admin). */
export const listPoderes = query({
  args: { asambleaId: v.id("asambleas") },
  handler: async (ctx, args) => {
    const asamblea = await ctx.db.get(args.asambleaId);
    if (!asamblea) return [];
    await requireCondominioRole(ctx, asamblea.condominioId, []);
    const poderes = await ctx.db
      .query("poderesAsamblea")
      .withIndex("by_asamblea", (q) => q.eq("asambleaId", args.asambleaId))
      .collect();

    // ¿El apoderado es propietario del condominio (tiene unidad) o persona externa?
    const propietariosUserIds = new Set<string>();
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_condominio", (q) => q.eq("condominioId", asamblea.condominioId))
      .collect();
    for (const m of memberships) {
      if (!m.isActive) continue;
      const links = await ctx.db
        .query("usuarioUnidad")
        .withIndex("by_membership", (q) => q.eq("membershipId", m._id))
        .first();
      if (links) propietariosUserIds.add(m.userId as string);
    }

    return await Promise.all(
      poderes.map(async (p) => {
        const esPropietario = p.representanteUserId
          ? propietariosUserIds.has(p.representanteUserId as string)
          : false;
        const documentoUrl =
          (await resolveMediaUrl(ctx, {
            url: p.documentoUrl,
            storageId: p.documentoStorageId,
          })) || null;
        const unidad = await ctx.db.get(p.unidadId);
        return {
          ...p,
          documentoUrl,
          unidadTorre: unidad?.torre ?? null,
          unidadBloque: unidad?.bloque ?? null,
          representanteTipo: esPropietario ? ("propietario" as const) : ("externo" as const),
        };
      }),
    );
  },
});

/**
 * Paquete completo para auditoría: asamblea, poderes (con URL de documento)
 * y resultados de todas las votaciones (coeficiente + veredicto).
 */
export const paqueteAuditoria = query({
  args: { asambleaId: v.id("asambleas") },
  handler: async (ctx, args) => {
    const asamblea = await ctx.db.get(args.asambleaId);
    if (!asamblea) return null;
    await requireCondominioRole(ctx, asamblea.condominioId, [...WRITE_ROLES]);

    const condominio = await ctx.db.get(asamblea.condominioId);
    const poderes = await ctx.db
      .query("poderesAsamblea")
      .withIndex("by_asamblea", (q) => q.eq("asambleaId", args.asambleaId))
      .collect();

    const propietariosUserIds = new Set<string>();
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_condominio", (q) => q.eq("condominioId", asamblea.condominioId))
      .collect();
    for (const m of memberships) {
      if (!m.isActive) continue;
      const links = await ctx.db
        .query("usuarioUnidad")
        .withIndex("by_membership", (q) => q.eq("membershipId", m._id))
        .first();
      if (links) propietariosUserIds.add(m.userId as string);
    }

    const poderesOut = await Promise.all(
      poderes
        .slice()
        .sort((a, b) =>
          a.unidadNumero.localeCompare(b.unidadNumero, undefined, { numeric: true }),
        )
        .map(async (p) => {
          const esPropietario = p.representanteUserId
            ? propietariosUserIds.has(p.representanteUserId as string)
            : false;
          const documentoUrl =
            (await resolveMediaUrl(ctx, {
              url: p.documentoUrl,
              storageId: p.documentoStorageId,
            })) || null;
          return {
            unidadNumero: p.unidadNumero,
            coeficiente: p.coeficiente ?? null,
            otorganteNombre: p.otorganteNombre,
            representanteNombre: p.representanteNombre,
            apoderadoDocumento: p.apoderadoDocumento ?? null,
            codigoAcceso: p.codigoAcceso,
            validado: p.validado,
            representanteTipo: esPropietario
              ? ("propietario" as const)
              : ("externo" as const),
            tieneDocumento: !!(documentoUrl || p.documentoStorageId),
            documentoUrl,
            createdAt: p.createdAt,
          };
        }),
    );

    const votaciones = await ctx.db
      .query("votaciones")
      .withIndex("by_asamblea", (q) => q.eq("asambleaId", args.asambleaId))
      .collect();

    const resultados = await Promise.all(
      votaciones.map(async (vt) => {
        const votos = await ctx.db
          .query("votosAsamblea")
          .withIndex("by_votacion", (q) => q.eq("votacionId", vt._id))
          .collect();
        const opciones = vt.opciones.map((o, i) => {
          const propios = votos.filter((v) => v.opcionIndex === i);
          return {
            texto: o.texto,
            votos: propios.length,
            coeficiente:
              Math.round(propios.reduce((s, v) => s + (v.coeficiente ?? 0), 0) * 100) / 100,
          };
        });
        return {
          pregunta: vt.pregunta,
          estado: vt.estado,
          abiertaAlgunaVez: vt.abiertaAlgunaVez ?? false,
          totalVotos: votos.length,
          opciones,
        };
      }),
    );

    const ordenDia =
      asamblea.ordenDia && asamblea.ordenDia.length > 0
        ? asamblea.ordenDia.map((p) => ({
            titulo: p.titulo,
            descripcion: p.descripcion ?? null,
            hecho: !!p.hecho,
            tieneVotacion: !!p.votacionId,
          }))
        : asamblea.agenda.map((t) => ({
            titulo: t,
            descripcion: null as string | null,
            hecho: false,
            tieneVotacion: false,
          }));

    /* Permanencia por unidad. Va en el paquete de auditoría, no en una
     * pantalla aparte: cuando alguien impugna un acta, lo que pide es UN
     * documento con quién estuvo, cuánto y en qué momento se decidió cada
     * punto. Si la asamblea no usó sala virtual, `sesiones` viene vacío y
     * este bloque sale en null en vez de con ceros, que se leerían como
     * "nadie asistió". */
    const sesiones = await ctx.db
      .query("asambleaSesiones")
      .withIndex("by_asamblea", (q) => q.eq("asambleaId", args.asambleaId))
      .collect();

    let permanencia: {
      iniciadaEn: number;
      finalizadaEn: number | null;
      duracionTotal: string;
      pctPromedio: number;
      unidades: {
        unidadNumero: string;
        personas: string;
        duracion: string;
        pct: number;
        reconexiones: number;
        sigueConectada: boolean;
      }[];
    } | null = null;

    if (sesiones.length > 0) {
      const ahora = Date.now();
      const desde =
        asamblea.iniciadaEn ?? Math.min(...sesiones.map((x) => x.entroEn));
      const ventana = { desde, hasta: asamblea.finalizadaEn ?? null };
      const msTotales = duracionVentana(ventana, ahora);

      const porUnidad = new Map<
        string,
        { numero: string; nombres: Set<string>; tramos: Tramo[] }
      >();
      for (const x of sesiones) {
        const key = x.unidadId as string;
        const acc = porUnidad.get(key);
        const tr: Tramo = { entroEn: x.entroEn, salioEn: x.salioEn ?? null };
        if (acc) {
          acc.tramos.push(tr);
          acc.nombres.add(x.userNombre);
        } else {
          porUnidad.set(key, {
            numero: x.unidadNumero,
            nombres: new Set([x.userNombre]),
            tramos: [tr],
          });
        }
      }

      const filas = [...porUnidad.values()]
        .map((u) => {
          const tramos = fusionarTramos(u.tramos, ahora);
          const ms = msConectados(tramos, ventana, ahora);
          return {
            unidadNumero: u.numero,
            personas: [...u.nombres].join(", "),
            duracion: formatearDuracion(ms),
            pct: pctPermanencia(ms, msTotales),
            reconexiones: Math.max(0, tramos.length - 1),
            sigueConectada: tramos.some((t) => t.salioEn === null),
          };
        })
        .sort((a, b) =>
          a.unidadNumero.localeCompare(b.unidadNumero, undefined, {
            numeric: true,
          }),
        );

      permanencia = {
        iniciadaEn: desde,
        finalizadaEn: asamblea.finalizadaEn ?? null,
        duracionTotal: formatearDuracion(msTotales),
        pctPromedio:
          filas.length > 0
            ? Math.round(
                (filas.reduce((acc, f) => acc + f.pct, 0) / filas.length) * 100,
              ) / 100
            : 0,
        unidades: filas,
      };
    }

    return {
      condominioNombre: condominio?.name ?? "Condominio",
      asamblea: {
        titulo: asamblea.titulo,
        tipo: asamblea.tipo,
        modalidad: asamblea.modalidad,
        estado: asamblea.estado,
        fecha: asamblea.fecha,
        hora: asamblea.hora,
        lugar: asamblea.lugar ?? null,
        quorumRequerido: asamblea.quorumRequerido ?? 51,
        iniciadaEn: asamblea.iniciadaEn ?? null,
        finalizadaEn: asamblea.finalizadaEn ?? null,
      },
      ordenDia,
      poderes: poderesOut,
      resultados,
      permanencia,
      generadoEn: Date.now(),
    };
  },
});

// ─────────────────────────────────────────────────────────────
// Admin de la sala en vivo
// ─────────────────────────────────────────────────────────────

/**
 * Inserta filas de asistencia (idempotente). Devuelve cuántas se crearon.
 */
/**
 * Registra la asistencia de cada unidad y abre su tramo de conexión.
 *
 * Ojo con la asimetría: la asistencia es idempotente (una unidad presente no
 * se registra dos veces), pero el tramo NO se salta para las ya presentes.
 * Quien se cae y vuelve a entrar el código sigue teniendo una sola marca de
 * asistencia y un tramo nuevo — que es justo lo que mide la permanencia.
 * `abrirSesiones` se encarga de no duplicar tramos ya abiertos.
 */
async function insertarAsistencias(
  ctx: MutationCtx,
  args: {
    condominioId: Id<"condominios">;
    asambleaId: Id<"asambleas">;
    origen: "codigo" | "sala" | "manual_admin" | "poder_codigo" | "presencial";
    filas: FilaSesion[];
  },
) {
  const now = Date.now();
  let registradas = 0;
  for (const f of args.filas) {
    const ex = await ctx.db
      .query("asambleaAsistentes")
      .withIndex("by_asamblea_unidad", (q) =>
        q.eq("asambleaId", args.asambleaId).eq("unidadId", f.unidadId),
      )
      .first();
    if (ex) continue;
    await ctx.db.insert("asambleaAsistentes", {
      condominioId: args.condominioId,
      asambleaId: args.asambleaId,
      unidadId: f.unidadId,
      unidadNumero: f.unidadNumero,
      userId: f.userId,
      userNombre: f.userNombre,
      coeficiente: f.coeficiente,
      esPoder: f.esPoder,
      createdAt: now,
    });
    registradas++;
  }

  await abrirSesiones(ctx, {
    condominioId: args.condominioId,
    asambleaId: args.asambleaId,
    origen: args.origen,
    filas: args.filas,
  });

  return registradas;
}

/**
 * Unidades a registrar cuando llega una persona:
 * - sus casas propias (no delegadas)
 * - casas que representa por poder (asignado a su userId; al check-in se valida)
 */
async function filasAsistenciaPersona(
  ctx: MutationCtx,
  args: {
    asambleaId: Id<"asambleas">;
    condominioId: Id<"condominios">;
    userId: Id<"users">;
    userNombre: string;
  },
) {
  const poderes = await ctx.db
    .query("poderesAsamblea")
    .withIndex("by_asamblea", (q) => q.eq("asambleaId", args.asambleaId))
    .collect();
  const delegadasAway = new Set(
    poderes
      .filter((p) => p.validado && p.otorganteUserId === args.userId)
      .map((p) => p.unidadId as string),
  );
  const propias = (await misUnidades(ctx, args.userId, args.condominioId)).filter(
    (u) => !delegadasAway.has(u._id as string),
  );
  /* SOLO poderes aceptados (`validado`). Antes entraban también los
   * pendientes y el registro los auto-validaba: bastaba que el "apoderado"
   * se registrara para capturar la unidad del otorgante sin que este pudiera
   * revocar (fuera de "programada" solo revoca la administración). Aceptar
   * un poder es un acto explícito: `responderPoder`. */
  const recibidos = poderes.filter(
    (p) => p.validado && p.representanteUserId === args.userId,
  );

  const filas: {
    unidadId: Id<"unidades">;
    unidadNumero: string;
    userId: Id<"users">;
    userNombre: string;
    coeficiente?: number;
    esPoder?: boolean;
  }[] = [];

  for (const u of propias) {
    filas.push({
      unidadId: u._id,
      unidadNumero: u.numero,
      userId: args.userId,
      userNombre: args.userNombre,
      coeficiente: u.coeficiente,
      esPoder: false,
    });
  }
  for (const p of recibidos) {
    filas.push({
      unidadId: p.unidadId,
      unidadNumero: p.unidadNumero,
      userId: args.userId,
      userNombre: args.userNombre,
      coeficiente: p.coeficiente,
      esPoder: true,
    });
  }
  return { filas, poderesRecibidos: recibidos };
}

/**
 * Si el apoderado ya está presente (check-in con su userId), las unidades
 * de poderes que representa también suman al quórum (aunque el poder
 * aún figure como pendiente: estar en sala lo ejerce de hecho).
 */
/** El admin registra la asistencia de un usuario (QR o manual). */
export const registrarAsistenciaAdmin = mutation({
  args: { asambleaId: v.id("asambleas"), userId: v.id("users") },
  handler: async (ctx, args) => {
    const asamblea = await ctx.db.get(args.asambleaId);
    if (!asamblea) throw new Error("Asamblea no encontrada.");
    await requireCondominioRole(ctx, asamblea.condominioId, [...WRITE_ROLES]);
    const target = await ctx.db.get(args.userId);
    if (!target) throw new Error("Usuario no encontrado.");

    const { filas, poderesRecibidos } = await filasAsistenciaPersona(ctx, {
      asambleaId: args.asambleaId,
      condominioId: asamblea.condominioId,
      userId: args.userId,
      userNombre: target.name,
    });
    if (filas.length === 0) {
      throw new Error(
        "Esta persona no tiene unidades propias ni poderes para registrar. Si solo es apoderado externo, usa su código.",
      );
    }
    const registradas = await insertarAsistencias(ctx, {
      origen: "manual_admin",
      condominioId: asamblea.condominioId,
      asambleaId: args.asambleaId,
      filas,
    });
    return { registradas, nombre: target.name };
  },
});

/** El admin quita la asistencia de una unidad. */
export const quitarAsistencia = mutation({
  args: { asistenteId: v.id("asambleaAsistentes") },
  handler: async (ctx, args) => {
    const a = await ctx.db.get(args.asistenteId);
    if (!a) return;
    await requireCondominioRole(ctx, a.condominioId, [...WRITE_ROLES]);
    // Cerrar ANTES de borrar: el tramo ya recorrido es prueba y se conserva.
    await cerrarSesionesUnidad(ctx, {
      asambleaId: a.asambleaId,
      unidadId: a.unidadId,
      motivo: "retirada_admin",
    });
    await ctx.db.delete(args.asistenteId);
  },
});

/** El admin registra asistencia con el código de un poder (apoderado). */
export const registrarAsistenciaPorCodigo = mutation({
  args: { asambleaId: v.id("asambleas"), codigo: v.string() },
  handler: async (ctx, args) => {
    const asamblea = await ctx.db.get(args.asambleaId);
    if (!asamblea) throw new Error("Asamblea no encontrada.");
    if (asamblea.estado === "finalizada" || asamblea.estado === "cancelada") {
      throw new Error("La asamblea ya no está activa.");
    }
    await requireCondominioRole(ctx, asamblea.condominioId, [...WRITE_ROLES]);

    const codigo = args.codigo.trim().toUpperCase();
    if (codigo.length < 4) throw new Error("Código inválido.");

    const poderes = (
      await ctx.db
        .query("poderesAsamblea")
        .withIndex("by_codigo", (q) => q.eq("codigoAcceso", codigo))
        .collect()
    ).filter((p) => p.asambleaId === args.asambleaId);

    if (poderes.length === 0) {
      throw new Error("Código no encontrado en esta asamblea.");
    }

    const now = Date.now();
    for (const p of poderes) {
      if (!p.validado) {
        await ctx.db.patch(p._id, { validado: true, updatedAt: now });
      }
    }

    const repUserId = poderes.find((p) => p.representanteUserId)?.representanteUserId;
    const repNombre = poderes[0]!.representanteNombre;

    const filas: {
      unidadId: Id<"unidades">;
      unidadNumero: string;
      userId: Id<"users">;
      userNombre: string;
      coeficiente?: number;
      esPoder?: boolean;
    }[] = [];

    for (const p of poderes) {
      const uid = p.representanteUserId ?? p.otorganteUserId;
      filas.push({
        unidadId: p.unidadId,
        unidadNumero: p.unidadNumero,
        userId: uid,
        userNombre: p.representanteNombre,
        coeficiente: p.coeficiente,
        esPoder: true,
      });
    }

    // Si el apoderado también es propietario, registra sus casas propias.
    if (repUserId) {
      const { filas: propias } = await filasAsistenciaPersona(ctx, {
        asambleaId: args.asambleaId,
        condominioId: asamblea.condominioId,
        userId: repUserId,
        userNombre: repNombre,
      });
      const seen = new Set(filas.map((f) => f.unidadId as string));
      for (const f of propias) {
        if (!seen.has(f.unidadId as string)) {
          filas.push(f);
          seen.add(f.unidadId as string);
        }
      }
    }

    const registradas = await insertarAsistencias(ctx, {
      origen: "poder_codigo",
      condominioId: asamblea.condominioId,
      asambleaId: args.asambleaId,
      filas,
    });

    return {
      registradas,
      nombre: repNombre,
      unidades: filas.map((f) => f.unidadNumero),
    };
  },
});

/**
 * Registro detallado (tabla del admin): TODAS las unidades con su estado de
 * asistencia, quién representa (poder), coeficiente y el voto por cada votación.
 */
export const asistentesDetallado = query({
  args: { asambleaId: v.id("asambleas") },
  handler: async (ctx, args) => {
    const asamblea = await ctx.db.get(args.asambleaId);
    if (!asamblea) return { filas: [], asistentes: [] };
    // Solo administración / mesa de asistencia (no residentes).
    await requireCondominioRole(ctx, asamblea.condominioId, [
      ...WRITE_ROLES,
      "contadora",
    ]);

    const unidades = await ctx.db
      .query("unidades")
      .withIndex("by_condominio", (q) => q.eq("condominioId", asamblea.condominioId))
      .collect();
    const asistentes = await ctx.db
      .query("asambleaAsistentes")
      .withIndex("by_asamblea", (q) => q.eq("asambleaId", args.asambleaId))
      .collect();
    const poderes = (
      await ctx.db
        .query("poderesAsamblea")
        .withIndex("by_asamblea", (q) => q.eq("asambleaId", args.asambleaId))
        .collect()
    ).filter((p) => p.validado);
    const votos = await ctx.db
      .query("votosAsamblea")
      .withIndex("by_asamblea", (q) => q.eq("asambleaId", args.asambleaId))
      .collect();

    const asisMap = new Map(asistentes.map((a) => [a.unidadId as string, a]));
    const podMap = new Map(poderes.map((p) => [p.unidadId as string, p]));

    // Unidades que cada persona (userId / nombre) representa por poder.
    const representaPorUser = new Map<string, string[]>();
    const representaPorNombre = new Map<string, string[]>();
    for (const p of poderes) {
      if (p.representanteUserId) {
        const key = p.representanteUserId as string;
        const arr = representaPorUser.get(key) ?? [];
        arr.push(p.unidadNumero);
        representaPorUser.set(key, arr);
      }
      const nk = p.representanteNombre.trim().toLowerCase();
      const arrN = representaPorNombre.get(nk) ?? [];
      arrN.push(p.unidadNumero);
      representaPorNombre.set(nk, arrN);
    }

    // Dueño (propietario) por unidad: membership → usuarioUnidad → user.
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_condominio", (q) => q.eq("condominioId", asamblea.condominioId))
      .collect();
    const propietarioPorUnidad = new Map<string, string>();
    for (const m of memberships) {
      const links = await ctx.db
        .query("usuarioUnidad")
        .withIndex("by_membership", (q) => q.eq("membershipId", m._id))
        .collect();
      if (links.length === 0) continue;
      const usr = await ctx.db.get(m.userId);
      const nombre = usr?.name ?? null;
      if (!nombre) continue;
      for (const l of links) {
        const key = l.unidadId as string;
        // Prefiere el vínculo "propietario"; si no, el primero que aparezca.
        if (!propietarioPorUnidad.has(key) || l.vinculo === "propietario") {
          propietarioPorUnidad.set(key, nombre);
        }
      }
    }

    const filas = unidades
      .map((u) => {
        const asis = asisMap.get(u._id as string);
        const pod = podMap.get(u._id as string);
        const votosUnidad = votos.filter((vt) => vt.unidadId === u._id);
        let tambienRepresenta: string[] = [];
        if (asis && !asis.esPoder) {
          const byUser = asis.userId
            ? representaPorUser.get(asis.userId as string) ?? []
            : [];
          const byName = representaPorNombre.get((asis.userNombre ?? "").trim().toLowerCase()) ?? [];
          tambienRepresenta = [...new Set([...byUser, ...byName])].sort((a, b) =>
            a.localeCompare(b, undefined, { numeric: true }),
          );
        }
        return {
          unidadId: u._id as string,
          unidadNumero: u.numero,
          coeficiente: u.coeficiente ?? null,
          // Solo cuenta como "asistió" si hubo registro explícito (QR/código/manual).
          // Aceptar un poder NO marca asistencia.
          presente: !!asis,
          tienePoder: !!pod,
          porPoder: !!asis?.esPoder,
          propietario: propietarioPorUnidad.get(u._id as string) ?? null,
          asistente: asis?.userNombre ?? null,
          /** Nombre del apoderado (si esta unidad tiene poder). */
          representa: pod ? pod.representanteNombre : null,
          /** Unidades que esta persona también representa (fila de su casa propia). */
          tambienRepresenta,
          horaRegistro: asis?.createdAt ?? null,
          votos: Object.fromEntries(votosUnidad.map((vt) => [vt.votacionId as string, vt.opcionIndex])),
        };
      })
      .sort((a, b) => a.unidadNumero.localeCompare(b.unidadNumero, undefined, { numeric: true }));

    return {
      filas,
      asistentes: asistentes
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((a) => ({
          _id: a._id,
          unidadNumero: a.unidadNumero,
          userNombre: a.userNombre,
          coeficiente: a.coeficiente ?? null,
          createdAt: a.createdAt,
        })),
    };
  },
});

// ─────────────────────────────────────────────────────────────
// Orden del día estructurado (puntos con votación opcional)
// ─────────────────────────────────────────────────────────────

type PuntoOrden = {
  titulo: string;
  descripcion?: string;
  votacionId?: Id<"votaciones">;
  hecho?: boolean;
};

/** Orden del día actual (usa el estructurado; si no existe, migra desde agenda). */
function ordenDiaActual(a: { ordenDia?: PuntoOrden[]; agenda: string[] }): PuntoOrden[] {
  if (a.ordenDia && a.ordenDia.length > 0) return [...a.ordenDia];
  return a.agenda.map((t) => ({ titulo: t }));
}

/** Agrega un punto al orden del día; opcionalmente crea su votación. */
export const agregarPunto = mutation({
  args: {
    asambleaId: v.id("asambleas"),
    titulo: v.string(),
    descripcion: v.optional(v.string()),
    habilitarVotacion: v.boolean(),
    opciones: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const asamblea = await ctx.db.get(args.asambleaId);
    if (!asamblea) throw new Error("Asamblea no encontrada.");
    await requireCondominioRole(ctx, asamblea.condominioId, [...WRITE_ROLES]);
    const titulo = args.titulo.trim();
    if (!titulo) throw new Error("El título del punto es obligatorio.");

    const now = Date.now();
    let votacionId: Id<"votaciones"> | undefined;
    if (args.habilitarVotacion) {
      const ops = (args.opciones ?? ["A favor", "En contra", "Abstención"])
        .map((o) => o.trim())
        .filter(Boolean);
      if (ops.length < 2) throw new Error("La votación necesita al menos 2 opciones.");
      votacionId = await ctx.db.insert("votaciones", {
        condominioId: asamblea.condominioId,
        asambleaId: args.asambleaId,
        asambleaTitulo: asamblea.titulo,
        pregunta: titulo,
        opciones: ops.map((texto) => ({ texto, votos: 0 })),
        estado: "cerrada", // se abre desde "Votación en vivo"
        createdAt: now,
        updatedAt: now,
      });
    }

    const orden = ordenDiaActual(asamblea);
    orden.push({ titulo, descripcion: args.descripcion?.trim() || undefined, votacionId });
    await ctx.db.patch(args.asambleaId, {
      ordenDia: orden,
      agenda: orden.map((p) => p.titulo),
      updatedAt: now,
    });
    return { ok: true as const };
  },
});

/** Edita el título/descripción de un punto (y la pregunta de su votación). */
export const editarPunto = mutation({
  args: {
    asambleaId: v.id("asambleas"),
    index: v.number(),
    titulo: v.string(),
    descripcion: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const asamblea = await ctx.db.get(args.asambleaId);
    if (!asamblea) throw new Error("Asamblea no encontrada.");
    await requireCondominioRole(ctx, asamblea.condominioId, [...WRITE_ROLES]);
    const orden = ordenDiaActual(asamblea);
    const p = orden[args.index];
    if (!p) throw new Error("Punto no encontrado.");
    p.titulo = args.titulo.trim() || p.titulo;
    p.descripcion = args.descripcion?.trim() || undefined;
    if (p.votacionId) {
      const vt = await ctx.db.get(p.votacionId);
      if (vt) await ctx.db.patch(p.votacionId, { pregunta: p.titulo, updatedAt: Date.now() });
    }
    await ctx.db.patch(args.asambleaId, {
      ordenDia: orden,
      agenda: orden.map((x) => x.titulo),
      updatedAt: Date.now(),
    });
  },
});

/** Elimina un punto (y su votación ligada, si tiene). */
export const eliminarPunto = mutation({
  args: { asambleaId: v.id("asambleas"), index: v.number() },
  handler: async (ctx, args) => {
    const asamblea = await ctx.db.get(args.asambleaId);
    if (!asamblea) throw new Error("Asamblea no encontrada.");
    await requireCondominioRole(ctx, asamblea.condominioId, [...WRITE_ROLES]);
    const orden = ordenDiaActual(asamblea);
    const p = orden[args.index];
    if (!p) return;
    if (p.votacionId) {
      await ctx.db.delete(p.votacionId).catch(() => {});
    }
    orden.splice(args.index, 1);
    await ctx.db.patch(args.asambleaId, {
      ordenDia: orden,
      agenda: orden.map((x) => x.titulo),
      updatedAt: Date.now(),
    });
  },
});

/** Reordena un punto hacia arriba (-1) o abajo (1). */
export const moverPunto = mutation({
  args: { asambleaId: v.id("asambleas"), index: v.number(), dir: v.number() },
  handler: async (ctx, args) => {
    const asamblea = await ctx.db.get(args.asambleaId);
    if (!asamblea) throw new Error("Asamblea no encontrada.");
    await requireCondominioRole(ctx, asamblea.condominioId, [...WRITE_ROLES]);
    const orden = ordenDiaActual(asamblea);
    const j = args.index + (args.dir < 0 ? -1 : 1);
    if (args.index < 0 || args.index >= orden.length || j < 0 || j >= orden.length) return;
    const tmp = orden[args.index]!;
    orden[args.index] = orden[j]!;
    orden[j] = tmp;
    await ctx.db.patch(args.asambleaId, {
      ordenDia: orden,
      agenda: orden.map((x) => x.titulo),
      updatedAt: Date.now(),
    });
  },
});

/** Crea/quita la votación de un punto existente. */
export const toggleVotacionPunto = mutation({
  args: {
    asambleaId: v.id("asambleas"),
    index: v.number(),
    opciones: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const asamblea = await ctx.db.get(args.asambleaId);
    if (!asamblea) throw new Error("Asamblea no encontrada.");
    await requireCondominioRole(ctx, asamblea.condominioId, [...WRITE_ROLES]);
    const orden = ordenDiaActual(asamblea);
    const p = orden[args.index];
    if (!p) throw new Error("Punto no encontrado.");
    const now = Date.now();
    if (p.votacionId) {
      await ctx.db.delete(p.votacionId).catch(() => {});
      p.votacionId = undefined;
    } else {
      const ops = (args.opciones ?? ["A favor", "En contra", "Abstención"])
        .map((o) => o.trim())
        .filter(Boolean);
      p.votacionId = await ctx.db.insert("votaciones", {
        condominioId: asamblea.condominioId,
        asambleaId: args.asambleaId,
        asambleaTitulo: asamblea.titulo,
        pregunta: p.titulo,
        opciones: ops.map((texto) => ({ texto, votos: 0 })),
        estado: "cerrada",
        createdAt: now,
        updatedAt: now,
      });
    }
    await ctx.db.patch(args.asambleaId, { ordenDia: orden, updatedAt: now });
  },
});

/** Marca / desmarca un punto del orden del día como realizado. */
export const togglePuntoHecho = mutation({
  args: { asambleaId: v.id("asambleas"), index: v.number() },
  handler: async (ctx, args) => {
    const asamblea = await ctx.db.get(args.asambleaId);
    if (!asamblea) throw new Error("Asamblea no encontrada.");
    await requireCondominioRole(ctx, asamblea.condominioId, [...WRITE_ROLES]);
    const orden = ordenDiaActual(asamblea);
    const p = orden[args.index];
    if (!p) throw new Error("Punto no encontrado.");
    p.hecho = !p.hecho;
    await ctx.db.patch(args.asambleaId, {
      ordenDia: orden,
      updatedAt: Date.now(),
    });
    return { hecho: !!p.hecho };
  },
});

// ─────────────────────────────────────────────────────────────
// Acceso del APODERADO por código (sin cuenta)
// ─────────────────────────────────────────────────────────────

/** El apoderado entra con su código: ve las casas que representa y las votaciones. */
export const accederConCodigo = query({
  args: { codigo: v.string() },
  handler: async (ctx, args) => {
    const codigo = args.codigo.trim().toUpperCase();
    if (codigo.length < 4) return null;

    const poderes = await ctx.db
      .query("poderesAsamblea")
      .withIndex("by_codigo", (q) => q.eq("codigoAcceso", codigo))
      .collect();
    if (poderes.length === 0) return null;

    const asamblea = await ctx.db.get(poderes[0]!.asambleaId);
    if (!asamblea) return null;
    // Código deja de servir cuando la asamblea cierra.
    if (asamblea.estado === "finalizada" || asamblea.estado === "cancelada") {
      return null;
    }

    const votaciones = await ctx.db
      .query("votaciones")
      .withIndex("by_asamblea", (q) => q.eq("asambleaId", asamblea._id))
      .order("desc")
      .collect();

    const misVotos = (
      await ctx.db
        .query("votosAsamblea")
        .withIndex("by_asamblea", (q) => q.eq("asambleaId", asamblea._id))
        .collect()
    ).filter((vt) => vt.codigoApoderado === codigo);
    const votoPorVotacion = new Map<string, number>();
    for (const vt of misVotos) votoPorVotacion.set(vt.votacionId as string, vt.opcionIndex);

    // Quórum (mismo cálculo que la vista de admin: solo check-in real).
    const asistentes = await ctx.db
      .query("asambleaAsistentes")
      .withIndex("by_asamblea", (q) => q.eq("asambleaId", asamblea._id))
      .collect();
    const unidadesCond = await ctx.db
      .query("unidades")
      .withIndex("by_condominio", (q) => q.eq("condominioId", asamblea.condominioId))
      .collect();
    const poderesAsamblea = await ctx.db
      .query("poderesAsamblea")
      .withIndex("by_asamblea", (q) => q.eq("asambleaId", asamblea._id))
      .collect();
    // Si las unidades de ESTE apoderado ya tienen check-in propio: es lo que
    // se le muestra a él sobre su propia gestión, distinto del quórum global.
    const idsAsistentes = new Set(asistentes.map((a) => a.unidadId as string));
    const asistenciaRegistrada = poderes.every((p) =>
      idsAsistentes.has(p.unidadId as string),
    );
    // El quórum sale del mismo cálculo compartido que la mesa y el acta.
    const qPaquete = calcularQuorum({
      asistentes,
      poderes: poderesAsamblea,
      unidades: unidadesCond,
    });
    const pctQuorum = qPaquete.pct;

    // Orden del día (con la pregunta/estado de su votación si tiene).
    const votacionPorId = new Map(votaciones.map((vt) => [vt._id as string, vt]));
    const ordenDia = ordenDiaActual(asamblea).map((p) => {
      const vt = p.votacionId ? votacionPorId.get(p.votacionId as string) : undefined;
      return {
        titulo: p.titulo,
        descripcion: p.descripcion ?? null,
        votacionId: p.votacionId ?? null,
        hecho: !!p.hecho,
        estadoVotacion: vt ? vt.estado : null,
      };
    });

    return {
      apoderadoNombre: poderes[0]!.representanteNombre,
      asamblea: {
        _id: asamblea._id,
        condominioId: asamblea.condominioId,
        titulo: asamblea.titulo,
        tipo: asamblea.tipo,
        modalidad: asamblea.modalidad,
        estado: asamblea.estado,
        fecha: asamblea.fecha,
        hora: asamblea.hora,
      },
      validado: poderes.every((p) => p.validado),
      asistenciaRegistrada,
      quorum: {
        pct: pctQuorum,
        unidadesPresentes: qPaquete.unidadesPresentes,
        totalUnidades: qPaquete.totalUnidades,
        quorumRequerido: asamblea.quorumRequerido ?? 51,
      },
      ordenDia,
      unidades: poderes.map((p) => ({ unidadNumero: p.unidadNumero, coeficiente: p.coeficiente ?? null, validado: p.validado })),
      votaciones: votaciones.map((vt) => ({
        _id: vt._id,
        pregunta: vt.pregunta,
        estado: vt.estado,
        abiertaAlgunaVez: vt.abiertaAlgunaVez ?? false,
        opciones: vt.opciones,
        miVoto: votoPorVotacion.get(vt._id as string) ?? null,
      })),
    };
  },
});

/**
 * El apoderado registra asistencia en asamblea virtual (página `/apoderado`).
 *
 * Necesita dos códigos:
 * - `codigo`: credencial del poder (entra a la sala del apoderado)
 * - `codigoSala`: código rotativo que la administración proyecta (igual que
 *   residentes). Sin él cualquiera marcaría asistencia sin estar en la reunión.
 *
 * En presencial/mixta el admin registra; esta mutación no aplica.
 */
export const registrarAsistenciaConCodigo = mutation({
  args: { codigo: v.string(), codigoSala: v.string() },
  handler: async (ctx, args) => {
    const codigo = args.codigo.trim().toUpperCase();
    if (codigo.length < 4) throw new Error("Código inválido.");

    const poderes = await ctx.db
      .query("poderesAsamblea")
      .withIndex("by_codigo", (q) => q.eq("codigoAcceso", codigo))
      .collect();
    if (poderes.length === 0) throw new Error("Código no encontrado.");

    const asamblea = await ctx.db.get(poderes[0]!.asambleaId);
    if (!asamblea) throw new Error("Asamblea no encontrada.");
    if (asamblea.estado === "finalizada" || asamblea.estado === "cancelada") {
      throw new Error("La asamblea ya no está activa.");
    }
    if (asamblea.modalidad !== "virtual") {
      throw new Error(
        "En asambleas presenciales el administrador registra la asistencia con tu código.",
      );
    }

    const semilla = asamblea.codigoAsistenciaSemilla;
    if (!semilla) {
      throw new Error(
        "La administración todavía no ha abierto el registro de asistencia.",
      );
    }
    if (!codigoEsValido(semilla, args.codigoSala, Date.now())) {
      throw new Error(
        "Código de la reunión incorrecto o vencido. Mira el que aparece ahora en pantalla.",
      );
    }

    const now = Date.now();
    const filas = [];
    for (const p of poderes) {
      if (!p.validado) await ctx.db.patch(p._id, { validado: true, updatedAt: now });
      filas.push({
        unidadId: p.unidadId,
        unidadNumero: p.unidadNumero,
        userId: p.representanteUserId ?? p.otorganteUserId,
        userNombre: p.representanteNombre,
        coeficiente: p.coeficiente,
        esPoder: true as const,
      });
    }
    const registradas = await insertarAsistencias(ctx, {
      origen: "poder_codigo",
      condominioId: asamblea.condominioId,
      asambleaId: asamblea._id,
      filas,
    });
    return { registradas, unidades: poderes.map((p) => p.unidadNumero) };
  },
});

/** El apoderado vota (con su código) por todas las casas que representa. */
export const votarConCodigo = mutation({
  args: { codigo: v.string(), votacionId: v.id("votaciones"), opcionIndex: v.number() },
  handler: async (ctx, args) => {
    const codigo = args.codigo.trim().toUpperCase();
    const votacion = await ctx.db.get(args.votacionId);
    if (!votacion) throw new Error("Votación no encontrada.");
    await assertVotacionAbierta(ctx, votacion);
    if (args.opcionIndex < 0 || args.opcionIndex >= votacion.opciones.length) {
      throw new Error("Opción inválida.");
    }
    const asamblea = await ctx.db.get(votacion.asambleaId);
    if (!asamblea || asamblea.estado !== "en_curso") {
      throw new Error("La asamblea aún no ha iniciado.");
    }

    const poderes = (
      await ctx.db
        .query("poderesAsamblea")
        .withIndex("by_codigo", (q) => q.eq("codigoAcceso", codigo))
        .collect()
    ).filter((p) => p.validado && p.asambleaId === votacion.asambleaId);
    if (poderes.length === 0) throw new Error("Código inválido o poderes no validados.");

    /* Sin asistencia no se vota — también por esta vía.
     *
     * `validado` NO implica presencia: un poder creado por la administración
     * nace validado (ver `otorgarPoder`), y al aceptarlo el otorgante también
     * queda validado. Sin este filtro, un apoderado podía votar sin haberse
     * registrado nunca en la asamblea. Solo votan las unidades que tengan
     * asistencia registrada. */
    const presentes: typeof poderes = [];
    for (const p of poderes) {
      const asistencia = await ctx.db
        .query("asambleaAsistentes")
        .withIndex("by_asamblea_unidad", (q) =>
          q.eq("asambleaId", votacion.asambleaId).eq("unidadId", p.unidadId),
        )
        .first();
      if (asistencia) presentes.push(p);
    }
    if (presentes.length === 0) {
      throw new Error("Registra tu asistencia antes de votar.");
    }

    const now = Date.now();
    for (const p of presentes) {
      const ex = await ctx.db
        .query("votosAsamblea")
        .withIndex("by_votacion_unidad", (q) =>
          q.eq("votacionId", args.votacionId).eq("unidadId", p.unidadId),
        )
        .first();
      if (ex) {
        await ctx.db.patch(ex._id, { opcionIndex: args.opcionIndex, codigoApoderado: codigo, userId: undefined, createdAt: now });
      } else {
        await ctx.db.insert("votosAsamblea", {
          condominioId: votacion.condominioId,
          asambleaId: votacion.asambleaId,
          votacionId: args.votacionId,
          unidadId: p.unidadId,
          unidadNumero: p.unidadNumero,
          codigoApoderado: codigo,
          opcionIndex: args.opcionIndex,
          coeficiente: p.coeficiente,
          createdAt: now,
        });
      }
    }

    const votos = await ctx.db
      .query("votosAsamblea")
      .withIndex("by_votacion", (q) => q.eq("votacionId", args.votacionId))
      .collect();
    await ctx.db.patch(args.votacionId, {
      opciones: votacion.opciones.map((o, i) => ({ texto: o.texto, votos: votos.filter((vt) => vt.opcionIndex === i).length })),
      updatedAt: now,
    });
    await registrarBitacora(ctx, {
      condominioId: votacion.condominioId,
      asambleaId: votacion.asambleaId,
      tipo: "voto",
      nombre: presentes[0]!.representanteNombre,
      detalle: `${presentes.map((p) => p.unidadNumero).join(", ")} → ${votacion.opciones[args.opcionIndex]?.texto ?? `opción ${args.opcionIndex + 1}`} (apoderado)`,
    });
    return { ok: true as const };
  },
});
