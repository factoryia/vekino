import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { getCurrentAppUser, requireAppUser } from "./model/authz";
import { alcanceCubre, alcanceEnCompania, exigirAccesoContrato } from "./model/acceso";
import {
  exigirAlcanceSobreGuarda,
  exigirGuardaActivo,
  lectorDeNombres,
} from "./model/alcanceGuarda";
import { viasEnConjunto } from "./model/vias";
import {
  CAPACIDADES_DISPONIBILIDAD,
  evaluarDisponibilidadDe,
} from "./model/disponibilidad";
import { coberturasActivasDe } from "./model/cobertura";
import { entradaVentanaValidator, estadoCoberturaValidator } from "./model/roles";
import { finDe } from "./lib/vigilancia";
import { ventanaDeConsulta } from "./lib/disponibilidad";
import { etiquetaInstante, rangoDeConsulta } from "./lib/inasistencias";
import {
  decidirCancelacion,
  decidirInhabilitacion,
  decidirRespuesta,
  exigirInicioFuturo,
  validarMotivoInhabilitacion,
  type Decision,
} from "./lib/coberturas";

/**
 * Coberturas temporales: solicitar, responder, cancelar, inhabilitar.
 *
 * Una cobertura aceptada es un COMPROMISO CONFIRMADO, no un acceso. Nada de
 * aquí toca asignaciones, membresías, contratos, turnos, `model/vias.ts`,
 * `resolverAcceso` ni `requireCondominioRole`: el guarda sigue operando con
 * sus vías de siempre. El acceso temporal es la fase siguiente.
 *
 * Quién puede, sin una autorización nueva:
 *   - solicitar y cancelar: quien puede asignar personal al conjunto destino
 *     (`exigirAccesoContrato` con `seguridad.asignar`, la regla de las
 *     asignaciones) y, para solicitar, además alcanza al guarda con el alcance
 *     de la disponibilidad (`model/alcanceGuarda.ts`);
 *   - inhabilitar: lo mismo, pero solo el administrador o la plataforma;
 *   - aceptar y rechazar: solo el propio guarda destinatario.
 */

const CAPACIDAD_DESTINO = "seguridad.asignar" as const;

type Ctx = QueryCtx | MutationCtx;

function aplicar(decision: Decision): boolean {
  if (decision.tipo === "error") throw new Error(decision.mensaje);
  return decision.tipo === "permitido";
}

/**
 * Todo lo que tiene que seguir siendo cierto para que una cobertura exista:
 * se comprueba al solicitar y OTRA VEZ al aceptar, porque entre una cosa y
 * otra pueden pasar horas y cambiar cualquier cosa.
 */
async function exigirElegible(
  ctx: Ctx,
  args: {
    userId: Id<"users">;
    contrato: Doc<"companiaContratos">;
    ventana: { inicio: number; fin: number };
  },
): Promise<Doc<"condominios">> {
  const { userId, contrato, ventana } = args;

  const compania = await ctx.db.get(contrato.companiaId);
  if (!compania || compania.estado !== "activa") {
    throw new Error("La compañía no está activa.");
  }

  await exigirGuardaActivo(
    ctx,
    contrato.companiaId,
    userId,
    "Solo un guarda de la compañía puede cubrir.",
  );

  /* El contrato tiene que respaldar el destino durante TODA la ventana, no
   * solo al empezar. */
  if (contrato.vigenciaDesde > ventana.inicio || ventana.fin > finDe(contrato)) {
    throw new Error("El contrato con ese conjunto no cubre toda la ventana.");
  }

  const condominio = await ctx.db.get(contrato.condominioId);
  if (!condominio || !condominio.isActive) {
    throw new Error("El conjunto no está activo.");
  }

  /* Si ya pertenece al conjunto —por membresía o por asignación— no hay nada
   * que cubrir temporalmente. */
  const { vias } = await viasEnConjunto(ctx, userId, contrato.condominioId, ventana.inicio);
  if (vias.length > 0) {
    throw new Error("Ese guarda ya pertenece a ese conjunto: no necesita una cobertura.");
  }

  /* Solo `disponible`. Sin horario no se sabe, y no saber no es estar libre. */
  const disponibilidad = await evaluarDisponibilidadDe(
    ctx,
    contrato.companiaId,
    userId,
    ventana,
  );
  switch (disponibilidad.estado) {
    case "disponible":
      return condominio;
    case "no_disponible":
      throw new Error("El guarda tiene una inasistencia en esa ventana: no puede cubrirla.");
    case "ocupado":
      throw new Error(
        disponibilidad.motivos.some((m) => m.tipo === "cobertura")
          ? "El guarda ya tiene una cobertura aceptada que se cruza con esa ventana."
          : "El guarda está ocupado según su horario en esa ventana.",
      );
    case "desconocido":
      throw new Error(
        "No hay horario registrado del guarda para toda la ventana: sin esa información no se puede pedir la cobertura.",
      );
  }
}

/** Lo que se pinta: la fila con los nombres resueltos. */
async function hidratar(ctx: Ctx, filas: readonly Doc<"coberturas">[]) {
  const nombre = lectorDeNombres(ctx);
  const nombreOpcional = (id: Id<"users"> | undefined) => (id ? nombre(id) : null);
  return await Promise.all(
    filas.map(async (c) => {
      const [condo, compania] = await Promise.all([
        ctx.db.get(c.condominioId),
        ctx.db.get(c.companiaId),
      ]);
      return {
        _id: c._id,
        companiaId: c.companiaId,
        companiaNombre: compania?.nombre ?? "(compañía eliminada)",
        userId: c.userId,
        guardaNombre: await nombre(c.userId),
        condominioId: c.condominioId,
        condominioNombre: condo?.name ?? "(conjunto eliminado)",
        contratoId: c.contratoId,
        inicio: c.inicio,
        fin: c.fin,
        estado: c.estado,
        solicitadoPorNombre: await nombre(c.solicitadoPorUserId),
        solicitadoEn: c.solicitadoEn,
        respuesta: c.respuesta ?? null,
        respondidoEn: c.respondidoEn ?? null,
        respondidoPorNombre: await nombreOpcional(c.respondidoPorUserId),
        canceladaEn: c.canceladaEn ?? null,
        canceladaPorNombre: await nombreOpcional(c.canceladaPorUserId),
        inhabilitadaEn: c.inhabilitadaEn ?? null,
        inhabilitadaPorNombre: await nombreOpcional(c.inhabilitadaPorUserId),
        motivoInhabilitacion: c.motivoInhabilitacion ?? null,
      };
    }),
  );
}

async function cargar(ctx: Ctx, coberturaId: Id<"coberturas">) {
  const cobertura = await ctx.db.get(coberturaId);
  if (!cobertura) throw new Error("Cobertura no encontrada.");
  return cobertura;
}

async function contratoDe(ctx: Ctx, cobertura: Doc<"coberturas">) {
  const contrato = await ctx.db.get(cobertura.contratoId);
  if (!contrato) throw new Error("Contrato no encontrado.");
  return contrato;
}

// ─────────────────────────────────────────────────────────────
// Escritura
// ─────────────────────────────────────────────────────────────

/**
 * Solicita a un guarda que cubra un conjunto durante una ventana.
 *
 * El conjunto sale del contrato, que se guarda tal cual: no se deduce después
 * del conjunto, porque puede haber contratos históricos o un cambio de
 * contrato.
 */
export const crear = mutation({
  args: {
    contratoId: v.id("companiaContratos"),
    userId: v.id("users"),
    ventana: entradaVentanaValidator,
  },
  handler: async (ctx, args) => {
    const contrato = await ctx.db.get(args.contratoId);
    if (!contrato) throw new Error("Contrato no encontrado.");
    const { user } = await exigirAccesoContrato(ctx, contrato, CAPACIDAD_DESTINO);
    await exigirAlcanceSobreGuarda(
      ctx,
      contrato.companiaId,
      args.userId,
      CAPACIDADES_DISPONIBILIDAD,
    );

    const ahora = Date.now();
    const ventana = ventanaDeConsulta(args.ventana);
    exigirInicioFuturo(ventana.inicio, ahora);
    const condominio = await exigirElegible(ctx, { userId: args.userId, contrato, ventana });

    const id = await ctx.db.insert("coberturas", {
      companiaId: contrato.companiaId,
      userId: args.userId,
      condominioId: contrato.condominioId,
      contratoId: contrato._id,
      inicio: ventana.inicio,
      fin: ventana.fin,
      estado: "solicitada",
      solicitadoPorUserId: user._id,
      solicitadoEn: ahora,
    });

    await ctx.scheduler.runAfter(0, internal.push.avisarAPersonas, {
      userIds: [args.userId],
      titulo: "Solicitud de cobertura",
      cuerpo: `Te piden cubrir ${condominio.name}: ${etiquetaInstante(ventana.inicio)} → ${etiquetaInstante(ventana.fin)}.`,
    });
    return id;
  },
});

/**
 * El guarda acepta. Todo se vuelve a comprobar aquí dentro —disponibilidad,
 * inasistencias, horarios, otras coberturas aceptadas, contrato, pertenencia—
 * y nada de lo que la pantalla viera antes cuenta: si entre la solicitud y la
 * respuesta dejó de ser elegible, no se acepta.
 */
export const aceptar = mutation({
  args: { coberturaId: v.id("coberturas") },
  handler: async (ctx, args) => {
    const cobertura = await cargar(ctx, args.coberturaId);
    const user = await requireAppUser(ctx);
    if (cobertura.userId !== user._id) {
      throw new Error("Solo el guarda destinatario puede responder esta solicitud.");
    }
    const ahora = Date.now();
    aplicar(decidirRespuesta(cobertura, "aceptada", ahora));

    await exigirElegible(ctx, {
      userId: cobertura.userId,
      contrato: await contratoDe(ctx, cobertura),
      ventana: { inicio: cobertura.inicio, fin: cobertura.fin },
    });

    await ctx.db.patch(cobertura._id, {
      estado: "aceptada",
      respuesta: "aceptada",
      respondidoEn: ahora,
      respondidoPorUserId: user._id,
    });
    return { ok: true as const };
  },
});

/** El guarda rechaza. Queda en el historial y no se puede volver a aceptar. */
export const rechazar = mutation({
  args: { coberturaId: v.id("coberturas") },
  handler: async (ctx, args) => {
    const cobertura = await cargar(ctx, args.coberturaId);
    const user = await requireAppUser(ctx);
    if (cobertura.userId !== user._id) {
      throw new Error("Solo el guarda destinatario puede responder esta solicitud.");
    }
    const ahora = Date.now();
    aplicar(decidirRespuesta(cobertura, "rechazada", ahora));
    await ctx.db.patch(cobertura._id, {
      estado: "rechazada",
      respuesta: "rechazada",
      respondidoEn: ahora,
      respondidoPorUserId: user._id,
    });
    return { ok: true as const };
  },
});

/**
 * Cancela una solicitud pendiente, o una aceptada que todavía no empezó. Lo
 * que ya empezó se inhabilita. Repetirlo no reescribe quién la canceló.
 */
export const cancelar = mutation({
  args: { coberturaId: v.id("coberturas") },
  handler: async (ctx, args) => {
    const cobertura = await cargar(ctx, args.coberturaId);
    const { user } = await exigirAccesoContrato(
      ctx,
      await contratoDe(ctx, cobertura),
      CAPACIDAD_DESTINO,
    );
    const ahora = Date.now();
    if (!aplicar(decidirCancelacion(cobertura, ahora))) {
      return { ok: true as const, yaEstaba: true as const };
    }
    await ctx.db.patch(cobertura._id, {
      estado: "cancelada",
      canceladaEn: ahora,
      canceladaPorUserId: user._id,
    });
    return { ok: true as const, yaEstaba: false as const };
  },
});

/**
 * Corta una cobertura aceptada. Solo el administrador de la compañía (o la
 * plataforma), con motivo. La ventana pactada no se toca: el corte es
 * `inhabilitadaEn`. No hay vuelta atrás: si hace falta otra vez, se crea otra.
 */
export const inhabilitar = mutation({
  args: {
    coberturaId: v.id("coberturas"),
    motivo: v.string(),
  },
  handler: async (ctx, args) => {
    const cobertura = await cargar(ctx, args.coberturaId);
    const acceso = await exigirAccesoContrato(
      ctx,
      await contratoDe(ctx, cobertura),
      CAPACIDAD_DESTINO,
    );
    if (acceso.comoSupervisor) {
      throw new Error("Solo el administrador de la compañía puede inhabilitar una cobertura.");
    }
    const ahora = Date.now();
    if (!aplicar(decidirInhabilitacion(cobertura, ahora))) {
      return { ok: true as const, yaEstaba: true as const };
    }
    const motivo = validarMotivoInhabilitacion(args.motivo);
    await ctx.db.patch(cobertura._id, {
      estado: "inhabilitada",
      inhabilitadaEn: ahora,
      inhabilitadaPorUserId: acceso.user._id,
      motivoInhabilitacion: motivo,
    });
    return { ok: true as const, yaEstaba: false as const };
  },
});

// ─────────────────────────────────────────────────────────────
// Lectura
// ─────────────────────────────────────────────────────────────

/**
 * Las solicitudes que el guarda tiene que responder: pendientes y que todavía
 * no empezaron. Solo lo necesario para decidir —dónde, cuándo, quién pide—;
 * nada de su disponibilidad ni de sus inasistencias.
 */
export const pendientesDeGuarda = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentAppUser(ctx);
    if (!user) return [];
    const filas = await ctx.db
      .query("coberturas")
      .withIndex("by_user_estado", (q) =>
        q.eq("userId", user._id).eq("estado", "solicitada").gt("inicio", Date.now()),
      )
      .collect();
    return await hidratar(ctx, filas);
  },
});

/** Una cobertura concreta: para su guarda, o para quien gestiona el destino. */
export const detalle = query({
  args: { coberturaId: v.id("coberturas") },
  handler: async (ctx, args) => {
    const cobertura = await ctx.db.get(args.coberturaId);
    if (!cobertura) return null;
    const user = await requireAppUser(ctx);
    if (cobertura.userId !== user._id) {
      await exigirAccesoContrato(ctx, await contratoDe(ctx, cobertura), CAPACIDAD_DESTINO);
    }
    const [hidratada] = await hidratar(ctx, [cobertura]);
    return hidratada!;
  },
});

/**
 * Las coberturas de la compañía cuya ventana se cruza con un rango de fechas
 * civiles, filtrables por estado, conjunto y guarda. El supervisor solo ve
 * las de los conjuntos que supervisa.
 */
export const deCompania = query({
  args: {
    companiaId: v.id("companiasSeguridad"),
    desde: v.string(),
    hasta: v.string(),
    estado: v.optional(estadoCoberturaValidator),
    condominioId: v.optional(v.id("condominios")),
    userId: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    const alcance = await alcanceEnCompania(ctx, args.companiaId, CAPACIDAD_DESTINO);
    const rango = rangoDeConsulta(args.desde, args.hasta);
    const filas = (
      await ctx.db
        .query("coberturas")
        .withIndex("by_compania_fin", (q) =>
          q.eq("companiaId", args.companiaId).gt("fin", rango.desde),
        )
        .collect()
    ).filter(
      (c) =>
        c.inicio < rango.hasta &&
        (args.estado == null || c.estado === args.estado) &&
        (args.condominioId == null || c.condominioId === args.condominioId) &&
        (args.userId == null || c.userId === args.userId) &&
        alcanceCubre(alcance, [c.condominioId]),
    );
    const salida = await hidratar(ctx, filas);
    return salida.sort((a, b) => a.inicio - b.inicio);
  },
});

/**
 * Las coberturas activas de un guarda: aceptadas y con ahora dentro de su
 * ventana. Preparada para la fase de acceso; HOY no da acceso a nada.
 *
 * El propio guarda ve las suyas; quien gestiona, las de los conjuntos a su
 * alcance.
 */
export const activasDeGuarda = query({
  args: {
    companiaId: v.id("companiasSeguridad"),
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const user = await requireAppUser(ctx);
    const propio = user._id === args.userId;
    const alcance = propio
      ? null
      : await alcanceEnCompania(ctx, args.companiaId, CAPACIDAD_DESTINO);
    const filas = (await coberturasActivasDe(ctx, args.userId, Date.now())).filter(
      (c) =>
        c.companiaId === args.companiaId &&
        (alcance === null || alcanceCubre(alcance, [c.condominioId])),
    );
    return await hidratar(ctx, filas);
  },
});
