import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { textoAccesoWhatsApp } from "./lib/mensajesAcceso";
import type { Doc, Id } from "./_generated/dataModel";
import {
  enviarMensaje,
  msgBotones,
  msgDocumento,
  msgLista,
  msgTexto,
  describirMensaje,
} from "./lib/ycloud";
import { normalizarTelefonoE164 } from "./lib/telefono";
import {
  parseFechaFlexible,
  parseRangoHorasFlexible,
} from "./lib/fechaTexto";
import {
  ETIQUETA_SIN_VERIFICAR,
  MENSAJE_NO_PAGABLE,
  TEXTO_SIN_VERIFICAR,
  descuentoVigente,
  fechaLimiteDescuentoDe,
  leerMontoPesos,
  mensajePagoEnVerificacion,
  montoAPagarHoy,
  motivoNoPagable,
  textosDePlazos,
} from "./lib/cartera";
import { MENSAJE_PASARELA_DE_PRUEBAS, pasarelaPermitida } from "./lib/avalProduccion";
import { vigentes } from "./model/authz";

/**
 * Bot de WhatsApp (YCloud).
 *
 * El webhook (http.ts) valida y delega aquí. `registrarEntrante` es la barrera
 * de idempotencia (YCloud reintenta entregas); `procesarEntrante` es el router:
 * una máquina de estados determinista (menú, reservas, facturas, comprobantes,
 * problemas) con fallback a IA para texto libre.
 *
 * El bot SIEMPRE responde dentro de la ventana de 24 h (está contestando un
 * mensaje entrante), así que puede usar texto libre e interactivos. Las
 * plantillas solo hacen falta en los envíos iniciados por nosotros
 * (whatsappBroadcast / whatsappNotifs).
 */

const VENTANA_24H = 24 * 60 * 60 * 1000;

/**
 * Espera antes de contestar un mensaje de texto.
 *
 * La gente escribe por ráfagas: "Hola", "Buenas tardes", y después lo que
 * quiere. Contestar cada uno hace que el bot responda tres veces lo mismo.
 * Con esta pausa solo responde el último de la ráfaga, viendo todos los
 * anteriores. Los toques de botón no esperan: ahí la intención es inequívoca.
 */
const ESPERA_RAFAGA_MS = 7000;

/**
 * Número del bot para el botón flotante de la web/app.
 *
 * Solo lo devuelve si el condominio tiene el módulo "whatsapp" encendido: un
 * botón que lleva a un bot que va a contestar "no está habilitado" es peor
 * que no tener botón.
 */
export const contactoBot = query({
  args: { condominioId: v.optional(v.id("condominios")) },
  handler: async (ctx, args) => {
    const crudo = (process.env.YCLOUD_PHONE_NUMBER_ID ?? "").trim();
    const numero = crudo.replace(/\D/g, "");
    if (!numero) return { numero: null, habilitado: false };

    if (!args.condominioId) return { numero, habilitado: false };

    const condominio = await ctx.db.get(args.condominioId);
    const habilitado =
      !!condominio &&
      condominio.isActive &&
      condominio.activeModules.includes("whatsapp");

    return { numero, habilitado };
  },
});

// ─────────────────────────────────────────────────────────────
// Persistencia (mutations/queries internas)
// ─────────────────────────────────────────────────────────────

/**
 * Registra un mensaje entrante. Idempotente por `ycloudMessageId`: si ya lo
 * vimos (reintento de YCloud), devuelve duplicado=true y el router no corre.
 */
export const registrarEntrante = internalMutation({
  args: {
    telefono: v.optional(v.string()), // E.164 con "+", si Meta lo manda
    bsuid: v.optional(v.string()), // identidad estable por negocio
    username: v.optional(v.string()),
    ycloudMessageId: v.string(),
    tipo: v.string(),
    contenido: v.string(),
    nombrePerfil: v.optional(v.string()),
    // Datos que necesita el router. Se agenda desde AQUÍ (no desde el
    // webhook) para que registro + scheduling sean una sola transacción:
    // si algo falla, YCloud reintenta y no hay mensaje fantasma ya "visto".
    texto: v.optional(v.string()),
    interactiveId: v.optional(v.string()),
    media: v.optional(
      v.object({
        link: v.string(),
        mimeType: v.optional(v.string()),
        filename: v.optional(v.string()),
        caption: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const existente = await ctx.db
      .query("waMessages")
      .withIndex("by_ycloudMessageId", (q) =>
        q.eq("ycloudMessageId", args.ycloudMessageId),
      )
      .first();
    if (existente) {
      return { conversacionId: existente.conversacionId, duplicado: true as const };
    }

    const now = Date.now();

    /* El BSUID manda: es la única identidad que Meta garantiza en todos los
     * mensajes. El teléfono se busca solo como respaldo, y sirve además para
     * reencontrar la conversación de alguien que activó su @usuario después
     * de haber escrito antes con el número visible. */
    let conversacion = args.bsuid
      ? await ctx.db
          .query("waConversations")
          .withIndex("by_bsuid", (q) => q.eq("bsuid", args.bsuid))
          .first()
      : null;
    if (!conversacion && args.telefono) {
      conversacion = await ctx.db
        .query("waConversations")
        .withIndex("by_telefono", (q) => q.eq("telefono", args.telefono))
        .first();
    }

    let conversacionId: Id<"waConversations">;
    if (conversacion) {
      conversacionId = conversacion._id;
      await ctx.db.patch(conversacionId, {
        // Se completan sin pisar con undefined lo que ya se sabía.
        bsuid: args.bsuid ?? conversacion.bsuid,
        telefono: args.telefono ?? conversacion.telefono,
        username: args.username ?? conversacion.username,
        ultimoMensajeAt: now,
        ultimoEntranteAt: now,
        ventanaExpiraAt: now + VENTANA_24H,
        nombrePerfil: args.nombrePerfil ?? conversacion.nombrePerfil,
        updatedAt: now,
      });
      conversacion = await ctx.db.get(conversacionId);
    } else {
      conversacionId = await ctx.db.insert("waConversations", {
        telefono: args.telefono,
        bsuid: args.bsuid,
        username: args.username,
        nombrePerfil: args.nombrePerfil,
        paso: "nueva",
        ultimoMensajeAt: now,
        ultimoEntranteAt: now,
        ventanaExpiraAt: now + VENTANA_24H,
        createdAt: now,
        updatedAt: now,
      });
      conversacion = await ctx.db.get(conversacionId);
    }

    // Identificación por teléfono, REVALIDADA en cada entrante: si el número
    // fue reasignado a otra persona (el admin corrigió teléfonos), el vínculo
    // viejo expondría facturas y unidades del dueño anterior. No es único
    // (parejas comparten número): tomamos el primer usuario ACTIVO.
    // Sin teléfono no hay nada que revalidar: la identidad la sostiene el
    // BSUID y el vínculo que se haya confirmado antes (flujo de vinculación).
    /* Si a esta persona ya la identificamos a mano alguna vez, su @usuario
     * quedó guardado en su ficha: se reconoce sola y no hay que volver a
     * preguntarle quién es. */
    if (conversacion && !conversacion.userId && args.bsuid) {
      const porBsuid = await ctx.db
        .query("users")
        .withIndex("by_wa_bsuid", (q) => q.eq("waBsuid", args.bsuid))
        .first();
      if (porBsuid?.active) {
        await ctx.db.patch(conversacionId, {
          userId: porBsuid._id,
          updatedAt: now,
        });
        conversacion = await ctx.db.get(conversacionId);
      }
    }

    if (conversacion && args.telefono) {
      const telefono = args.telefono;
      const vigente = conversacion.userId
        ? await ctx.db.get(conversacion.userId)
        : null;
      const vinculoValido =
        vigente != null && vigente.active && vigente.telefonoE164 === telefono;

      if (!vinculoValido) {
        const candidatos = await ctx.db
          .query("users")
          .withIndex("by_telefono", (q) => q.eq("telefonoE164", telefono))
          .collect();
        const usuario = candidatos.find((u) => u.active);
        if (usuario?._id !== conversacion.userId) {
          // Cambió el dueño del número: nada del contexto anterior
          // (condominio, unidad, borradores) puede heredarse.
          await ctx.db.patch(conversacionId, {
            userId: usuario?._id,
            membershipId: undefined,
            condominioId: undefined,
            paso: "nueva",
            contexto: null,
            updatedAt: now,
          });
        }
      }
    }

    await ctx.db.insert("waMessages", {
      conversacionId,
      telefono: args.telefono,
      direccion: "entrante",
      tipo: args.tipo,
      contenido: args.contenido.slice(0, 4000),
      ycloudMessageId: args.ycloudMessageId,
      createdAt: now,
    });

    const esperar =
      args.tipo === "text" && !args.interactiveId && !args.media
        ? ESPERA_RAFAGA_MS
        : 0;
    await ctx.scheduler.runAfter(0, internal.whatsappInbox.sumarNoLeido, {
      conversacionId,
    });

    await ctx.scheduler.runAfter(esperar, internal.whatsapp.procesarEntrante, {
      conversacionId,
      tipo: args.tipo,
      texto: args.texto,
      interactiveId: args.interactiveId,
      media: args.media,
      marcaAt: now,
    });

    return { conversacionId, duplicado: false as const };
  },
});

export const registrarSaliente = internalMutation({
  args: {
    conversacionId: v.id("waConversations"),
    tipo: v.string(),
    contenido: v.string(),
    ycloudMessageId: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const conversacion = await ctx.db.get(args.conversacionId);
    if (!conversacion) return null;
    const now = Date.now();
    await ctx.db.patch(args.conversacionId, { ultimoMensajeAt: now, updatedAt: now });
    return await ctx.db.insert("waMessages", {
      conversacionId: args.conversacionId,
      telefono: conversacion.telefono,
      direccion: "saliente",
      tipo: args.tipo,
      contenido: args.contenido.slice(0, 4000),
      ycloudMessageId: args.ycloudMessageId,
      estado: args.error ? "failed" : "sent",
      error: args.error,
      createdAt: now,
    });
  },
});

/** Estado de entrega de un saliente (evento whatsapp.message.updated). */
export const actualizarEstadoMensaje = internalMutation({
  args: {
    ycloudMessageId: v.string(),
    estado: v.string(),
    error: v.optional(v.string()),
    /* Datos del mensaje, por si NO lo conocemos: los salientes enviados desde
     * el panel de YCloud (o cualquier otra herramienta sobre el mismo número)
     * no pasan por nuestra API, así que la única noticia que tenemos de ellos
     * es este evento. Sin esto, la bandeja del equipo muestra la conversación
     * a medias y parece que nadie contestó. */
    destino: v.optional(v.string()),
    tipo: v.optional(v.string()),
    contenido: v.optional(v.string()),
    /** Quién lo escribió, si se sabe: "Desde WhatsApp", "Enviado por fuera"… */
    etiqueta: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const mensaje = await ctx.db
      .query("waMessages")
      .withIndex("by_ycloudMessageId", (q) =>
        q.eq("ycloudMessageId", args.ycloudMessageId),
      )
      .first();

    if (mensaje) {
      await ctx.db.patch(mensaje._id, { estado: args.estado, error: args.error });
      return null;
    }

    // Saliente desconocido: se adopta en la conversación que corresponda.
    if (!args.destino) return null;
    const telefono = normalizarTelefonoE164(args.destino);
    const conversacion =
      (telefono
        ? await ctx.db
            .query("waConversations")
            .withIndex("by_telefono", (q) => q.eq("telefono", telefono))
            .first()
        : null) ??
      (await ctx.db
        .query("waConversations")
        .withIndex("by_bsuid", (q) => q.eq("bsuid", args.destino))
        .first());
    if (!conversacion) return null;

    const now = Date.now();
    await ctx.db.insert("waMessages", {
      conversacionId: conversacion._id,
      telefono: conversacion.telefono,
      direccion: "saliente",
      tipo: args.tipo ?? "text",
      contenido: (args.contenido ?? "").slice(0, 4000),
      ycloudMessageId: args.ycloudMessageId,
      estado: args.estado,
      error: args.error,
      // Se marca como externo para distinguirlo del bot y del panel propio.
      agenteNombre: args.etiqueta ?? "Enviado por fuera",
      createdAt: now,
    });
    await ctx.db.patch(conversacion._id, {
      ultimoMensajeAt: now,
      // Alguien contestó por otra vía: el agente no debe responder encima.
      agentePausadoHasta: now + 2 * 60 * 60 * 1000,
      updatedAt: now,
    });
    return null;
  },
});

/**
 * Ata esta conversación (y por tanto el BSUID) a un residente, tras haber
 * verificado el código enviado a su correo. Es la vía para quien activó su
 * @usuario de WhatsApp y ya no comparte el teléfono con Meta.
 */
export const vincularUsuario = internalMutation({
  args: {
    conversacionId: v.id("waConversations"),
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user || !user.active) return null;

    await ctx.db.patch(args.conversacionId, {
      userId: args.userId,
      // Contexto y condominio se resuelven de cero con la identidad nueva.
      membershipId: undefined,
      condominioId: undefined,
      paso: "menu",
      contexto: null,
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const setConversacion = internalMutation({
  args: {
    conversacionId: v.id("waConversations"),
    paso: v.optional(v.string()),
    contexto: v.optional(v.any()),
    condominioId: v.optional(v.id("condominios")),
    membershipId: v.optional(v.id("memberships")),
  },
  handler: async (ctx, args) => {
    const { conversacionId, ...cambios } = args;
    await ctx.db.patch(conversacionId, { ...cambios, updatedAt: Date.now() });
    return null;
  },
});

/**
 * Reclama atómicamente el borrador de reserva pendiente de confirmar.
 * Las mutations de Convex serializan: si llegan dos taps de "Confirmar",
 * solo el primero recibe el draft; el segundo recibe null y no duplica.
 */
export const reclamarDraftReserva = internalMutation({
  args: { conversacionId: v.id("waConversations") },
  handler: async (ctx, args) => {
    const conversacion = await ctx.db.get(args.conversacionId);
    if (!conversacion || conversacion.paso !== "reserva:confirmar") return null;
    const contexto = (conversacion.contexto ?? {}) as Record<string, any>;
    const draft = contexto.reserva;
    if (!draft?.zonaId || !draft?.fecha || !draft?.horaInicio || !draft?.horaFin) {
      return null;
    }
    await ctx.db.patch(args.conversacionId, {
      paso: "menu",
      contexto: { ...contexto, reserva: undefined },
      updatedAt: Date.now(),
    });
    return draft as {
      zonaId: string;
      fecha: string;
      horaInicio: string;
      horaFin: string;
    };
  },
});

/** Todo lo que el router necesita para decidir: usuario, membresías, unidades. */
export const contextoConversacion = internalQuery({
  args: { conversacionId: v.id("waConversations") },
  handler: async (ctx, args) => {
    const conversacion = await ctx.db.get(args.conversacionId);
    if (!conversacion) return null;

    const user = conversacion.userId ? await ctx.db.get(conversacion.userId) : null;
    const usuarioActivo = user && user.active ? user : null;

    const membresias: Array<{
      membership: Doc<"memberships">;
      condominio: Doc<"condominios">;
    }> = [];
    if (usuarioActivo) {
      const ms = await ctx.db
        .query("memberships")
        .withIndex("by_user", (q) => q.eq("userId", usuarioActivo._id))
        .collect();
      for (const m of ms) {
        if (!m.isActive) continue;
        const condominio = await ctx.db.get(m.condominioId);
        if (condominio && condominio.isActive) {
          membresias.push({ membership: m, condominio });
        }
      }
    }

    // Membresía "efectiva": la persistida si sigue activa, o la única activa
    // si aún no se persistió (primer mensaje). Sin este fallback, el primer
    // mensaje de un usuario nuevo (típicamente la foto del comprobante) vería
    // 0 unidades: el router fija membershipId DESPUÉS de esta query. También
    // cubre membershipId obsoleto (membresía desactivada): jamás se cargan
    // unidades de un vínculo que ya no está activo.
    const conModulo = membresias.filter((m) =>
      m.condominio.activeModules.includes("whatsapp"),
    );
    const efectiva =
      membresias.find(
        (m) => m.membership._id === conversacion.membershipId,
      ) ??
      (conModulo.length === 1 ? conModulo[0] : undefined) ??
      (membresias.length === 1 ? membresias[0] : undefined);

    const unidades: Array<{ unidad: Doc<"unidades">; vinculo: string }> = [];
    if (efectiva) {
      /* Solo vínculos VIGENTES, como en la web (`misUnidadIds`): con el
       * contrato vencido, el bot no le ofrece la casa ni sus facturas,
       * reservas o comprobantes (QA de comprobantes, H3). */
      const vinculos = vigentes(
        await ctx.db
          .query("usuarioUnidad")
          .withIndex("by_membership", (q) =>
            q.eq("membershipId", efectiva.membership._id),
          )
          .collect(),
      );
      for (const vu of vinculos) {
        const unidad = await ctx.db.get(vu.unidadId);
        if (unidad) unidades.push({ unidad, vinculo: vu.vinculo });
      }
    }

    return { conversacion, user: usuarioActivo, membresias, unidades };
  },
});

/** Últimos mensajes (para darle memoria a la IA). */
export const ultimosMensajes = internalQuery({
  args: { conversacionId: v.id("waConversations"), n: v.number() },
  handler: async (ctx, args) => {
    const mensajes = await ctx.db
      .query("waMessages")
      .withIndex("by_conversacion", (q) =>
        q.eq("conversacionId", args.conversacionId),
      )
      .order("desc")
      .take(Math.min(args.n, 20));
    return mensajes.reverse();
  },
});

// ─────────────────────────────────────────────────────────────
// Helpers puros del router
// ─────────────────────────────────────────────────────────────

const pesos = new Intl.NumberFormat("es-CO", {
  style: "currency",
  currency: "COP",
  maximumFractionDigits: 0,
});

function fechaLarga(ts: number, timezone: string): string {
  return new Intl.DateTimeFormat("es-CO", {
    dateStyle: "long",
    timeZone: timezone,
  }).format(new Date(ts));
}

function hoyEn(timezone: string): string {
  // en-CA da YYYY-MM-DD directamente.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function normalizarComando(texto: string): string {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

/** Etiqueta corta para la lista de fechas: "Hoy · jue 6 ago". */
function etiquetaFecha(fechaISO: string, hoyISO: string, timezone: string): string {
  const d = new Date(`${fechaISO}T12:00:00Z`);
  const dia = new Intl.DateTimeFormat("es-CO", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(d);
  const manana = new Date(`${hoyISO}T12:00:00Z`);
  manana.setUTCDate(manana.getUTCDate() + 1);
  const mananaISO = manana.toISOString().slice(0, 10);
  if (fechaISO === hoyISO) return `Hoy · ${dia}`;
  if (fechaISO === mananaISO) return `Mañana · ${dia}`;
  void timezone;
  return dia.charAt(0).toUpperCase() + dia.slice(1);
}

/** Próximos días como filas de lista, para no obligar a escribir la fecha. */
function proximasFechas(hoyISO: string, n: number): string[] {
  const salida: string[] = [];
  const base = new Date(`${hoyISO}T12:00:00Z`);
  for (let i = 0; i < n; i++) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + i);
    salida.push(d.toISOString().slice(0, 10));
  }
  return salida;
}

/** Bloques típicos de reserva; siempre queda la opción de escribir otro. */
const HORARIOS_SUGERIDOS: Array<{ rango: [string, string]; etiqueta: string }> = [
  { rango: ["08:00", "12:00"], etiqueta: "Mañana · 8:00 a 12:00" },
  { rango: ["12:00", "16:00"], etiqueta: "Medio día · 12:00 a 4:00" },
  { rango: ["14:00", "18:00"], etiqueta: "Tarde · 2:00 a 6:00" },
  { rango: ["16:00", "20:00"], etiqueta: "Tarde · 4:00 a 8:00" },
  { rango: ["18:00", "22:00"], etiqueta: "Noche · 6:00 a 10:00" },
  { rango: ["08:00", "18:00"], etiqueta: "Todo el día · 8 a 6" },
];

type CtxBot = {
  conversacion: Doc<"waConversations">;
  user: Doc<"users"> | null;
  membresias: Array<{
    membership: Doc<"memberships">;
    condominio: Doc<"condominios">;
  }>;
  unidades: Array<{ unidad: Doc<"unidades">; vinculo: string }>;
};

// ─────────────────────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────────────────────

export const procesarEntrante = internalAction({
  args: {
    conversacionId: v.id("waConversations"),
    tipo: v.string(),
    texto: v.optional(v.string()),
    /** id del botón/fila elegida en un mensaje interactivo. */
    interactiveId: v.optional(v.string()),
    media: v.optional(
      v.object({
        link: v.string(),
        mimeType: v.optional(v.string()),
        filename: v.optional(v.string()),
        caption: v.optional(v.string()),
      }),
    ),
    /** Momento del mensaje que disparó esta ejecución. */
    marcaAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const datos = await ctx.runQuery(internal.whatsapp.contextoConversacion, {
      conversacionId: args.conversacionId,
    });
    if (!datos) return null;

    /* Interruptor general: con WHATSAPP_BOT_APAGADO=1 no se responde NADA de
     * forma automática, en ningún condominio. Es para los días en que el
     * equipo quiere atender a mano —una asamblea, un envío masivo— y un bot
     * contestando encima estorba más de lo que ayuda.
     *
     * Corta solo la RESPUESTA: el mensaje entrante ya quedó registrado antes
     * de llegar aquí, así que sigue apareciendo en la bandeja y nadie se
     * queda sin ser atendido. Los envíos programados no pasan por acá y
     * salen igual.
     *
     * Se apaga y se prende con `bunx convex env set WHATSAPP_BOT_APAGADO`. */
    if (process.env.WHATSAPP_BOT_APAGADO === "1") {
      /* Una excepción, y solo una: quien escribe que no puede entrar. Ese
       * caso no aguanta a que alguien del equipo lo vea —el día de una
       * asamblea, media hora de espera es quedarse sin votar—, y la respuesta
       * es siempre la misma. Todo lo demás sigue callado. */
      await rescatarAccesoSiAplica(ctx, args.conversacionId, args.texto);
      return null;
    }

    /* Hay alguien del equipo atendiendo esta conversación: el agente se
     * calla para no responder encima. Los entrantes se siguen registrando y
     * se ven en el inbox. */
    if ((datos.conversacion.agentePausadoHasta ?? 0) > Date.now()) {
      return null;
    }

    /* Llegó algo más nuevo mientras esperábamos: este mensaje era parte de una
     * ráfaga. Se calla y deja que responda el último, que ya ve todo. */
    if (
      args.marcaAt != null &&
      (datos.conversacion.ultimoEntranteAt ?? 0) > args.marcaAt
    ) {
      return null;
    }

    const enviar = async (payload: Record<string, unknown> & { to: string }) => {
      const tipo = (payload as { type?: string }).type ?? "text";
      // Se guarda legible: el historial lo lee la IA como turnos del asistente
      // y el equipo lo ve en el inbox. El JSON crudo no le sirve a ninguno.
      const contenido = describirMensaje(payload as Record<string, any>);
      try {
        const res = await enviarMensaje(payload);
        await ctx.runMutation(internal.whatsapp.registrarSaliente, {
          conversacionId: args.conversacionId,
          tipo,
          contenido,
          ycloudMessageId: res.id,
        });
      } catch (e) {
        await ctx.runMutation(internal.whatsapp.registrarSaliente, {
          conversacionId: args.conversacionId,
          tipo,
          contenido,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    };

    /* A quién se le responde: el teléfono si lo hay, o el BSUID de Meta si la
     * persona activó su @usuario. `enviarMensaje` decide solo si va como `to`
     * o como `recipient`, que es lo que YCloud exige para cada uno. */
    const destino = datos.conversacion.telefono ?? datos.conversacion.bsuid;
    if (!destino) return null;
    const to: string = destino;

    const setConv = (cambios: {
      paso?: string;
      contexto?: unknown;
      condominioId?: Id<"condominios">;
      membershipId?: Id<"memberships">;
    }) =>
      ctx.runMutation(internal.whatsapp.setConversacion, {
        conversacionId: args.conversacionId,
        ...cambios,
      });

    // 1) No sabemos quién escribe.
    if (!datos.user) {
      const pasoActual = datos.conversacion.paso;
      const contextoVinc = (datos.conversacion.contexto ?? {}) as Record<string, any>;

      const pidioVincular =
        args.interactiveId === "vincular:iniciar" ||
        /^vincul/.test(normalizarComando(args.texto ?? ""));
      if (pidioVincular) {
        await setConv({ paso: "vincular:documento", contexto: null });
        await enviar(
          msgTexto(
            to,
            "🔗 Para reconocerlo, por favor escríbame su *número de documento* (el mismo que tiene registrado la administración).",
          ),
        );
        return null;
      }

      // Paso 2 del alta: contrastar el código que le llegó al correo.
      if (pasoActual === "vincular:codigo" && contextoVinc.vinculacion) {
        const vinc = contextoVinc.vinculacion;
        const tecleado = (args.texto ?? "").replace(/\D/g, "");

        if (Date.now() > (vinc.expiraAt ?? 0)) {
          await enviar(
            msgTexto(to, "⌛ Ese código venció. Escribe *vincular* para empezar de nuevo."),
          );
          await setConv({ paso: "nueva", contexto: null });
          return null;
        }
        if ((vinc.intentos ?? 0) >= 3) {
          await enviar(
            msgTexto(to, "🚫 Demasiados intentos. Escribe *vincular* para empezar de nuevo."),
          );
          await setConv({ paso: "nueva", contexto: null });
          return null;
        }
        if (!tecleado || tecleado !== vinc.codigo) {
          await setConv({
            paso: "vincular:codigo",
            contexto: {
              vinculacion: { ...vinc, intentos: (vinc.intentos ?? 0) + 1 },
            },
          });
          await enviar(
            msgTexto(to, "El código no coincide 🤔. Revíselo en su correo y escríbalo de nuevo, por favor."),
          );
          return null;
        }

        // Correcto: el BSUID queda atado a esa persona de forma permanente.
        await ctx.runMutation(internal.whatsapp.vincularUsuario, {
          conversacionId: args.conversacionId,
          userId: vinc.userId as Id<"users">,
        });
        await enviar(
          msgTexto(to, "✅ ¡Listo! Tu WhatsApp quedó vinculado. Escribe *menú* para empezar."),
        );
        return null;
      }

      // Paso 1 del alta: pedir el documento.
      if (pasoActual === "vincular:documento") {
        const doc = (args.texto ?? "").replace(/\D/g, "");
        if (doc.length < 5) {
          await enviar(
            msgTexto(to, "Escríbame solo su número de documento, sin puntos ni espacios."),
          );
          return null;
        }
        const res: { ok: boolean; motivo?: string; nombre?: string; emailOculto?: string } =
          await ctx.runAction(internal.whatsappVinculacion.enviarCodigo, {
            conversacionId: args.conversacionId,
            documento: doc,
          });
        if (!res.ok) {
          await enviar(msgTexto(to, `😕 ${res.motivo}`));
          await setConv({ paso: "nueva", contexto: null });
          return null;
        }
        await enviar(
          msgTexto(
            to,
            `Perfecto, ${res.nombre?.split(" ")[0] ?? ""} 👍\n\nTe envié un código de 6 dígitos a *${res.emailOculto}*.\n\nEscríbalo aquí para confirmar que es usted.`,
          ),
        );
        return null;
      }

      // Sin teléfono (activó su @usuario de WhatsApp): se ofrece vincular.
      if (!datos.conversacion.telefono) {
        await enviar(
          msgBotones(
            to,
            "👋 Hola. Este es el canal de *Vekino*.\n\nComo tiene activado su usuario de WhatsApp, no puedo ver su número para reconocerlo. Puedo vincular su cuenta en un minuto: verifico su documento y le envío un código a su correo.",
            [
              { id: "vincular:iniciar", title: "🔗 Vincular mi cuenta" },
            ],
          ),
        );
        return null;
      }

      // Con teléfono visible pero sin registrar: lo resuelve la administración.
      await enviar(
        msgTexto(
          to,
          "👋 Hola. Este es el canal de *Vekino*.\n\nNo encontramos su número en la plataforma. Por favor pídale a la administración de su conjunto que registre o actualice su teléfono, y con mucho gusto lo atiendo por aquí.\n\nSi prefiere, escriba *vincular* y lo hacemos con su documento.",
        ),
      );
      return null;
    }

    // 2) Sin membresías activas.
    if (datos.membresias.length === 0) {
      await enviar(
        msgTexto(
          to,
          "Su cuenta no tiene un conjunto activo asociado. Por favor comuníquese con su administración.",
        ),
      );
      return null;
    }

    // 2b) Gate por tenant: el módulo "whatsapp" se activa por condominio
    // (condominios.activeModules, toggle del superadmin). Solo se atienden
    // los conjuntos que lo tengan encendido.
    const habilitadas = datos.membresias.filter((m) =>
      m.condominio.activeModules.includes("whatsapp"),
    );
    if (habilitadas.length === 0) {
      await enviar(
        msgTexto(
          to,
          "Este canal de WhatsApp aún no está habilitado para su conjunto. 🙏\n\nPor ahora puede usar la app de Vekino o escribirle directamente a su administración.",
        ),
      );
      return null;
    }

    // 3) Resolver condominio activo de la conversación.
    let activa = habilitadas.find(
      (m) => m.membership._id === datos.conversacion.membershipId,
    );
    if (!activa && habilitadas.length === 1) {
      activa = habilitadas[0]!;
      await setConv({
        condominioId: activa.condominio._id,
        membershipId: activa.membership._id,
      });
    }

    const nombre = datos.user.firstName ?? datos.user.name.split(" ")[0] ?? "";
    const accion = args.interactiveId;
    const texto = args.texto ?? "";
    const comando = normalizarComando(texto);

    // Cambio de condominio elegido por lista: fijarlo y caer al menú.
    let mostrarMenuTrasElegirCondominio = false;
    if (accion?.startsWith("condo:")) {
      const membershipId = accion.slice("condo:".length) as Id<"memberships">;
      const elegida = habilitadas.find((m) => m.membership._id === membershipId);
      if (elegida) {
        await setConv({
          condominioId: elegida.condominio._id,
          membershipId: elegida.membership._id,
          paso: "menu",
          contexto: null,
        });
        activa = elegida;
        mostrarMenuTrasElegirCondominio = true;
      }
    }

    if (!activa) {
      // Varios condominios y ninguno elegido aún.
      await enviar(
        msgLista(
          to,
          `Hola ${nombre} 👋 ¿Sobre cuál conjunto desea hablar?`,
          "Elegir conjunto",
          habilitadas.map((m) => ({
            id: `condo:${m.membership._id}`,
            title: m.condominio.name.slice(0, 24),
          })),
        ),
      );
      await setConv({ paso: "elegir_condominio" });
      return null;
    }

    const condominio = activa.condominio;
    const membership = activa.membership;
    const timezone = condominio.timezone ?? "America/Bogota";
    const contexto = (datos.conversacion.contexto ?? {}) as Record<string, any>;
    const paso = datos.conversacion.paso;

    async function enviarMenu(nombreCondominio?: string) {
      await enviar(
        msgLista(
          to,
          `Hola ${nombre} 👋 Soy el asistente de *${nombreCondominio ?? condominio.name}*. ¿En qué te ayudo?`,
          "Ver opciones",
          [
            { id: "menu:factura", title: "💰 Estado de cuenta", description: "Tu factura de administración" },
            { id: "menu:reserva", title: "🏝 Reservar zona común", description: "Salón social, BBQ y más" },
            { id: "menu:comprobante", title: "🧾 Enviar comprobante", description: "Reporte su pago con una foto" },
            { id: "menu:problema", title: "🛠 Reportar un problema", description: "Queja, petición o daño" },
            { id: "menu:acceso", title: "🔑 Datos de acceso", description: "Tu usuario y clave de la app" },
            { id: "menu:consulta", title: "💬 Otra consulta", description: "Pregúntame lo que necesites" },
          ],
        ),
      );
      await setConv({ paso: "menu", contexto: null });
    }

    /**
     * Pide la fecha ofreciendo los próximos días como lista.
     * Escribirla también funciona (parseFechaFlexible), pero tocar una fila
     * es más rápido y no hay forma de equivocarse de formato.
     */
    async function pedirFecha() {
      const hoy = hoyEn(timezone);
      const filas = proximasFechas(hoy, 7).map((f) => ({
        id: `fecha:${f}`,
        title: etiquetaFecha(f, hoy, timezone),
      }));
      filas.push({ id: "fecha:otra", title: "📅 Otra fecha" });
      await enviar(
        msgLista(
          to,
          "📅 ¿Para qué día?\n\nToca una opción o escríbeme la fecha (ej: *20 de agosto*).",
          "Ver fechas",
          filas,
        ),
      );
    }

    /** Horarios típicos como lista; también acepta texto libre. */
    async function pedirHora() {
      const filas = HORARIOS_SUGERIDOS.map((h) => ({
        id: `hora:${h.rango[0]}-${h.rango[1]}`,
        title: h.etiqueta,
      }));
      filas.push({ id: "hora:otro", title: "🕐 Otro horario" });
      await enviar(
        msgLista(
          to,
          "🕐 ¿En qué horario?\n\nToca una opción o escríbemelo (ej: *de 2 a 6*).",
          "Ver horarios",
          filas,
        ),
      );
    }

    /** Valida disponibilidad y pide confirmación final. */
    async function confirmarReserva(horaInicio: string, horaFin: string) {
      const draft = { ...contexto.reserva, horaInicio, horaFin };
      if (!draft?.zonaId || !draft?.fecha) {
        await enviarMenu();
        return;
      }

      const disponible: { ok: boolean; motivo?: string } = await ctx.runQuery(
        internal.reservas.verificarDisponibilidad,
        {
          zonaId: draft.zonaId as Id<"zonasComunes">,
          fecha: draft.fecha,
          horaInicio,
          horaFin,
        },
      );
      if (!disponible.ok) {
        await enviar(
          msgTexto(
            to,
            `😕 ${disponible.motivo ?? "Ese horario no está disponible."}`,
          ),
        );
        await pedirHora();
        return;
      }

      await setConv({
        paso: "reserva:confirmar",
        contexto: { ...contexto, reserva: draft },
      });
      const [d1, m1, y1] = draft.fecha.split("-").reverse();
      await enviar(
        msgBotones(
          to,
          `¿Confirmas la reserva?\n\n📅 ${d1}/${m1}/${y1}\n🕐 ${horaInicio} a ${horaFin}`,
          [
            { id: "reserva:confirmar", title: "✅ Confirmar" },
            { id: "reserva:cancelar", title: "❌ Cancelar" },
          ],
        ),
      );
    }

    /** Unidad de trabajo: la única, la elegida antes, o pedimos elegir. */
    async function resolverUnidad(pendiente: string): Promise<Doc<"unidades"> | null> {
      if (contexto.unidadId) {
        const u = datos!.unidades.find((x) => x.unidad._id === contexto.unidadId);
        if (u) return u.unidad;
      }
      if (datos!.unidades.length === 1) return datos!.unidades[0]!.unidad;
      if (datos!.unidades.length === 0) {
        await enviar(
          msgTexto(
            to,
            "No encontré unidades vinculadas a su cuenta en este conjunto. Por favor escríbale a su administración para que lo corrija.",
          ),
        );
        return null;
      }
      await enviar(
        msgLista(
          to,
          "¿Sobre cuál unidad?",
          "Elegir unidad",
          datos!.unidades.map((x) => ({
            id: `unidad:${x.unidad._id}`,
            title: [x.unidad.torre, x.unidad.numero].filter(Boolean).join(" ").slice(0, 24) || x.unidad.numero,
            description: x.vinculo,
          })),
        ),
      );
      await setConv({
        paso: "elegir_unidad",
        contexto: { ...contexto, pendiente },
      });
      return null;
    }

    if (mostrarMenuTrasElegirCondominio) {
      await enviarMenu();
      return null;
    }

    // ── Comprobante: cualquier imagen/PDF entrante se trata como comprobante ──
    if (args.media && (args.tipo === "image" || args.tipo === "document")) {
      const unidad = await resolverUnidad("media");
      if (!unidad) {
        if (datos.unidades.length > 1) {
          // guardamos la media para procesarla al elegir unidad
          await setConv({
            paso: "elegir_unidad",
            contexto: { ...contexto, pendiente: "media", media: args.media },
          });
        }
        return null;
      }
      await procesarComprobante(unidad, args.media);
      return null;
    }

    async function procesarComprobante(
      unidad: Doc<"unidades">,
      media: { link: string; mimeType?: string; filename?: string; caption?: string },
    ) {
      try {
        const subido: { key: string; publicUrl: string } = await ctx.runAction(
          internal.files.uploadFromUrl,
          {
            url: media.link,
            folder: `comprobantes/${condominio._id}`,
            fileName: media.filename,
            contentType: media.mimeType,
            conApiKeyYCloud: true,
          },
        );
        const factura = await ctx.runQuery(
          internal.soportesPago.facturaVigenteDeUnidad,
          { unidadId: unidad._id },
        );
        /* Cuánto se pagó (Fase 3): si viene en el texto de la foto ("pagué
         * 340.000") se toma de ahí; si no, se pregunta. Con el monto, el
         * comprobante aprobado prueba un pago por ese valor, no "pagada" a
         * ciegas. */
        const monto = media.caption ? leerMontoPesos(media.caption) : null;
        const soporteId: Id<"soportesPago"> = await ctx.runMutation(
          internal.soportesPago.crearDesdeBot,
          {
            condominioId: condominio._id,
            unidadId: unidad._id,
            facturaId: factura?._id,
            userId: datos!.user!._id,
            telefono: to,
            url: subido.publicUrl,
            mimeType: media.mimeType,
            nota: media.caption,
            ...(monto !== null ? { monto } : {}),
          },
        );
        const recibido = `🧾 ¡Recibido! Tu comprobante quedó *pendiente de revisión* por la administración${factura ? ` (factura ${factura.numeroFactura})` : ""}.`;
        if (monto !== null) {
          await enviar(
            msgTexto(
              to,
              `${recibido}\n\nAnoté un pago de *${pesos.format(monto)}*. Te avisaremos cuando lo confirmen. Escribe *menú* si necesitas algo más.`,
            ),
          );
          await setConv({ paso: "menu", contexto: { unidadId: unidad._id } });
        } else {
          await enviar(
            msgTexto(
              to,
              `${recibido}\n\n¿Cuánto pagaste? Escríbeme solo el valor, por ejemplo *340000*. Si no lo tienes a mano, escribe *omitir* y la administración lo revisa.`,
            ),
          );
          await setConv({
            paso: "comprobante:monto",
            contexto: { unidadId: unidad._id, soporteId },
          });
        }
      } catch {
        await enviar(
          msgTexto(
            to,
            "😕 No pude guardar el comprobante. Inténtelo de nuevo en unos minutos o envíelo a su administración.",
          ),
        );
      }
    }

    // ── Selección de unidad pendiente ──
    if (accion?.startsWith("unidad:")) {
      const unidadId = accion.slice("unidad:".length);
      const elegida = datos.unidades.find((x) => x.unidad._id === unidadId);
      if (!elegida) return null;
      const nuevoContexto = { ...contexto, unidadId };
      await setConv({ contexto: nuevoContexto });
      contexto.unidadId = unidadId;
      const pendiente = contexto.pendiente as string | undefined;
      if (pendiente === "media" && contexto.media) {
        await procesarComprobante(elegida.unidad, contexto.media);
      } else if (pendiente) {
        await manejarAccion(pendiente);
      } else {
        await enviarMenu();
      }
      return null;
    }

    // ── Acciones del menú y botones ──
    async function manejarAccion(id: string): Promise<void> {
      if (id === "menu:inicio") {
        await enviarMenu();
        return;
      }

      if (id === "menu:factura") {
        const unidad = await resolverUnidad("menu:factura");
        if (!unidad) return;
        const factura = await ctx.runQuery(
          internal.soportesPago.facturaVigenteDeUnidad,
          { unidadId: unidad._id },
        );
        if (!factura) {
          await enviar(
            msgTexto(to, `No encontré facturas para la unidad ${unidad.numero}. 🎉`),
          );
          return;
        }
        /* El descuento vale hasta SU fecha (la del documento, o el 15 del mes
         * del período), no hasta el vencimiento (F-06). */
        const ahora = Date.now();
        const conDescuento = descuentoVigente(factura, ahora);
        const monto = montoAPagarHoy(factura, ahora);
        const limiteDescuento = fechaLimiteDescuentoDe(factura);
        const lineas = [
          `📄 *Factura ${factura.numeroFactura}* — ${factura.periodoLabel}`,
          `Unidad: ${[unidad.torre, unidad.numero].filter(Boolean).join(" ")}`,
          `Estado: *${factura.estadoVisible.replace("_", " ")}*`,
          `Total a pagar: *${pesos.format(monto)}*${
            conDescuento && limiteDescuento !== null
              ? ` (con descuento por pronto pago hasta el ${fechaLarga(limiteDescuento, timezone)})`
              : ""
          }`,
          /* Los plazos, iguales en la web, el móvil y el agente (Fase 4,
           * decisión B): el fin de mes es el plazo del precio completo y la
           * mora empieza el 16 del mes siguiente. */
          ...textosDePlazos(factura).filter((t) => !t.startsWith("Con descuento")),
        ];
        /* Meses viejos que nadie pudo juzgar (Fase 4): "Sin verificar", no
         * deuda. Lo que se debe hoy ya está en esta factura. */
        const sinVerificar: { periodo: string; periodoLabel: string }[] = await ctx.runQuery(
          internal.soportesPago.sinVerificarDeUnidad,
          { unidadId: unidad._id },
        );
        if (sinVerificar.length > 0) {
          lineas.push(
            `ℹ️ ${sinVerificar.map((s) => s.periodoLabel || s.periodo).join(", ")}: *${ETIQUETA_SIN_VERIFICAR}*. ${TEXTO_SIN_VERIFICAR} Lo que debes hoy ya está en esta factura.`,
          );
        }
        /* Es la vigente: si no se puede pagar es porque ya está saldada
         * (pagada, saldo a favor o sin saldo), porque su lectura está en
         * revisión, o porque hay un pago en verificación. No se busca otra
         * anterior. */
        const noPagable = motivoNoPagable([factura], factura);
        if (noPagable === "pago_en_verificacion") {
          await enviar(
            msgTexto(
              to,
              `📄 Factura de ${factura.periodoLabel || factura.periodo}\n\n🔎 ${mensajePagoEnVerificacion(
                factura.pagoEnVerificacion?.monto ?? 0,
              )} Mientras tanto no te cobro en línea, para no cobrarte dos veces. Si tienes dudas, escribe *menú*.`,
            ),
          );
          return;
        }
        if (noPagable === "en_revision") {
          await enviar(
            msgTexto(
              to,
              `📄 Tu factura de ${factura.periodoLabel || factura.periodo} está *en revisión* por la administración. Cuando la confirmen podrás verla y pagarla aquí. Si tienes dudas, escribe *menú*.`,
            ),
          );
          return;
        }
        if (noPagable !== null) {
          await enviar(msgTexto(to, `${lineas.join("\n")}\n\n✅ Estás al día. ¡Gracias!`));
          return;
        }
        /* Con la pasarela en QA (la de pruebas del banco) a una casa real no
         * se le ofrece "Pagar en línea" (Fase 4): paga por los canales del
         * conjunto y manda el comprobante. */
        const enLinea = pasarelaPermitida(process.env, factura.unidadId);
        await enviar(
          msgTexto(to, enLinea ? lineas.join("\n") : `${lineas.join("\n")}\n\n${MENSAJE_PASARELA_DE_PRUEBAS}`),
        );
        if (factura.pdfUrl) {
          await enviar(
            msgDocumento(to, factura.pdfUrl, {
              filename: `${factura.numeroFactura}.pdf`,
              caption: "Tu factura en PDF",
            }),
          );
        }
        await enviar(
          msgBotones(to, "¿Qué desea hacer?", [
            ...(enLinea ? [{ id: `pagar:${factura._id}`, title: "💳 Pagar en línea" }] : []),
            { id: "menu:comprobante", title: "🧾 Ya pagué" },
            { id: "menu:inicio", title: "Volver al menú" },
          ]),
        );
        await setConv({ paso: "menu", contexto: { unidadId: unidad._id } });
        return;
      }

      if (id.startsWith("pagar:")) {
        const facturaId = id.slice("pagar:".length) as Id<"facturas">;
        try {
          const pago: { pagoId: string; redirectUrl: string } = await ctx.runAction(
            internal.pagos.crearPagoFacturaBot,
            { facturaId, userId: datos!.user!._id },
          );
          await enviar(
            msgTexto(
              to,
              `💳 Paga de forma segura con PSE o tarjeta en este enlace:\n\n${pago.redirectUrl}\n\nCuando el banco confirme, te aviso por aquí. ✅`,
            ),
          );
        } catch (e) {
          const motivo = e instanceof Error ? e.message : "";
          /* Un botón "Pagar" viejo del chat puede apuntar a una factura que
           * ya no es la vigente (llegó la del mes siguiente): el backend la
           * rechaza, y "intenta más tarde" no le serviría de nada. */
          await enviar(
            msgTexto(
              to,
              motivo.includes("pagada")
                ? "Esa factura ya figura pagada. ✅"
                : motivo.includes(MENSAJE_NO_PAGABLE.historica)
                  ? "Esa factura ya no está vigente: su saldo quedó incluido en tu factura más reciente. Escribe *menú* y elige *Estado de cuenta* para verla y pagarla."
                  : motivo.includes(MENSAJE_NO_PAGABLE.sin_saldo)
                    ? "Esa factura no tiene saldo por pagar. ✅"
                    : motivo.includes(MENSAJE_NO_PAGABLE.pago_en_verificacion)
                      ? "🔎 Tu pago anterior está registrado y la contabilidad aún no lo refleja. No te cobro en línea mientras la administración lo verifica, para no cobrarte dos veces."
                    : motivo.includes(MENSAJE_PASARELA_DE_PRUEBAS)
                      ? MENSAJE_PASARELA_DE_PRUEBAS
                    : motivo.includes(MENSAJE_NO_PAGABLE.vigente_ambigua) ||
                        motivo.includes(MENSAJE_NO_PAGABLE.en_revision)
                      ? "No puedo generar el pago en línea de esa factura: está en revisión por la administración."
                      : "😕 No pude generar el enlace de pago en este momento. Intenta más tarde o escribe *menú*.",
            ),
          );
        }
        return;
      }

      if (id === "menu:comprobante") {
        await enviar(
          msgTexto(
            to,
            "🧾 Envíeme la *foto o PDF* del comprobante de su pago y lo dejo registrado para revisión de la administración.",
          ),
        );
        await setConv({ paso: "esperando_comprobante", contexto });
        return;
      }

      if (id === "menu:reserva") {
        const zonas: Array<Doc<"zonasComunes">> = await ctx.runQuery(
          internal.reservas.zonasActivas,
          { condominioId: condominio._id },
        );
        if (zonas.length === 0) {
          await enviar(
            msgTexto(to, "Este conjunto no tiene zonas comunes reservables por ahora."),
          );
          return;
        }
        await enviar(
          msgLista(
            to,
            "🏝 ¿Qué zona desea reservar?",
            "Ver zonas",
            zonas.map((z) => ({
              id: `zona:${z._id}`,
              title: z.nombre.slice(0, 24),
              description: z.descripcion?.slice(0, 72),
            })),
          ),
        );
        await setConv({ paso: "reserva:zona", contexto });
        return;
      }

      if (id.startsWith("zona:")) {
        const zonaId = id.slice("zona:".length);
        await setConv({
          paso: "reserva:fecha",
          contexto: { ...contexto, reserva: { zonaId } },
        });
        await pedirFecha();
        return;
      }

      if (id.startsWith("fecha:")) {
        const valor = id.slice("fecha:".length);
        if (valor === "otra") {
          await enviar(
            msgTexto(
              to,
              "📅 Escríbeme la fecha como quieras: *20 de agosto*, *20/08*, *el sábado*…",
            ),
          );
          return;
        }
        await setConv({
          paso: "reserva:hora",
          contexto: { ...contexto, reserva: { ...contexto.reserva, fecha: valor } },
        });
        await pedirHora();
        return;
      }

      if (id.startsWith("hora:")) {
        const valor = id.slice("hora:".length);
        if (valor === "otro") {
          await enviar(
            msgTexto(
              to,
              "🕐 Escríbeme el horario como quieras: *de 2 a 6*, *14:00-18:00*, *9 am a 12*…",
            ),
          );
          return;
        }
        const [ini, fin] = valor.split("-");
        if (!ini || !fin) return;
        await confirmarReserva(ini, fin);
        return;
      }

      if (id === "reserva:confirmar") {
        const unidad = await resolverUnidad("reserva:confirmar");
        if (!unidad) return;
        // Reclamo atómico: un segundo tap de "Confirmar" recibe null.
        const draft = await ctx.runMutation(
          internal.whatsapp.reclamarDraftReserva,
          { conversacionId: args.conversacionId },
        );
        if (!draft) {
          await enviar(
            msgTexto(
              to,
              "Esa confirmación ya se procesó o expiró. Escribe *menú* para empezar de nuevo.",
            ),
          );
          return;
        }
        try {
          await ctx.runMutation(
            internal.reservas.createFromBot,
            {
              userId: datos!.user!._id,
              condominioId: condominio._id,
              unidadId: unidad._id,
              zonaId: draft.zonaId as Id<"zonasComunes">,
              fecha: draft.fecha,
              horaInicio: draft.horaInicio,
              horaFin: draft.horaFin,
              observaciones: "Creada por WhatsApp",
            },
          );
          await enviar(
            msgTexto(
              to,
              `✅ ¡Listo! Tu reserva quedó registrada y está *pendiente de aprobación* por la administración.\n\nTe confirmo por aquí cuando la aprueben. Escribe *menú* para más opciones.`,
            ),
          );
          await setConv({ paso: "menu", contexto: { unidadId: unidad._id } });
        } catch (e) {
          await enviar(
            msgTexto(
              to,
              `😕 No pude crear la reserva: ${e instanceof Error ? e.message : "error"}.\n\nEscribe *menú* para intentarlo de nuevo.`,
            ),
          );
          await setConv({ paso: "menu", contexto: {} });
        }
        return;
      }

      if (id === "reserva:cancelar") {
        await enviar(msgTexto(to, "Reserva descartada. 👍"));
        await enviarMenu();
        return;
      }

      if (id === "menu:problema") {
        await enviar(
          msgTexto(
            to,
            "🛠 Cuénteme qué pasa: escriba su petición, queja o el problema que desea reportar.",
          ),
        );
        await setConv({ paso: "problema:descripcion", contexto });
        return;
      }

      if (id === "problema:condominio" || id === "problema:app") {
        const descripcion = (contexto.problema ?? "").toString();
        if (!descripcion) {
          await enviarMenu();
          return;
        }
        const asunto =
          descripcion.length > 60 ? `${descripcion.slice(0, 57)}...` : descripcion;
        try {
          if (id === "problema:condominio") {
            const r: { radicado: string } = await ctx.runMutation(
              internal.pqrs.crearInterno,
              {
                condominioId: condominio._id,
                userId: datos!.user!._id,
                tipo: "peticion",
                asunto,
                descripcion: `${descripcion}\n\n— Recibido por WhatsApp`,
                unidadNumero: datos!.unidades[0]?.unidad.numero,
              },
            );
            await enviar(
              msgTexto(
                to,
                `📋 Tu solicitud quedó radicada como *${r.radicado}*.\n\nLa administración te responderá pronto. Escribe *menú* si necesitas algo más.`,
              ),
            );
          } else {
            await ctx.runMutation(internal.soporte.crearInterno, {
              userId: datos!.user!._id,
              condominioId: condominio._id,
              categoria: "app",
              asunto,
              mensaje: `${descripcion}\n\n— Recibido por WhatsApp`,
            });
            await enviar(
              msgTexto(
                to,
                "🎧 Tu reporte llegó al equipo de soporte de Vekino. Te contactaremos pronto.\n\nEscribe *menú* si necesitas algo más.",
              ),
            );
          }
        } catch {
          await enviar(
            msgTexto(to, "😕 No pude registrar su reporte. Inténtelo de nuevo más tarde."),
          );
        }
        await setConv({ paso: "menu", contexto: {} });
        return;
      }

      if (id === "menu:acceso") {
        await enviar(
          msgBotones(
            to,
            "🔑 Te puedo generar una *clave nueva* para entrar a la plataforma.\n\nOjo: la contraseña que tengas ahora dejará de funcionar.",
            [
              { id: "acceso:confirmar", title: "🔑 Generar clave" },
              { id: "menu:inicio", title: "Cancelar" },
            ],
          ),
        );
        await setConv({ paso: "menu", contexto });
        return;
      }

      if (id === "acceso:confirmar") {
        // WhatsApp garantiza el remitente y el número está registrado en la
        // plataforma: equivale al "te mandamos un enlace a tu correo".
        const res: {
          ok: boolean;
          email?: string;
          password?: string;
          motivo?: string;
          enlace?: string;
          yaTieneClavePropia?: boolean;
        } = await ctx.runAction(internal.credenciales.generarClaveParaEntrega, {
          userId: datos!.user!._id,
        });

        // Ya entró y tiene su propia contraseña: no se le toca nada.
        if (!res.ok && res.yaTieneClavePropia) {
          await enviar(
            msgTexto(
              to,
              `Usted ya ha entrado antes, así que su contraseña actual sigue sirviendo y no se la cambio 🙂\n\nEntre con *${res.email}* en https://www.vekino.com/login\n\n¿No la recuerda? Use *¿La olvidaste?* en esa pantalla, o dígame *quiero una clave nueva* y se la genero.`,
            ),
          );
          return;
        }

        if (!res.ok || !res.password) {
          await enviar(
            msgTexto(
              to,
              `😕 No pude generar su clave${res.motivo ? `: ${res.motivo}` : ""}.\n\nPor favor escríbale a su administración para que revise sus datos.`,
            ),
          );
          return;
        }

        /* Si faltara cualquiera de los tres, el mensaje saldría con un hueco
         * ("Contraseña: undefined") y la persona intentaría entrar con eso.
         * Mejor decir que no se pudo. */
        if (!res.email || !res.password || !res.enlace) {
          await enviar(
            msgTexto(
              to,
              "😕 No pude armar sus datos de acceso. Por favor escríbale a su administración para que revise su registro.",
            ),
          );
          return;
        }

        await enviar(
          msgTexto(
            to,
            textoAccesoWhatsApp({
              email: res.email,
              password: res.password,
              enlace: res.enlace,
            }),
          ),
        );
        await setConv({ paso: "menu", contexto });
        return;
      }

      if (id === "menu:consulta") {
        await enviar(msgTexto(to, "💬 Claro que sí, escríbame su pregunta."));
        await setConv({ paso: "consulta", contexto });
        return;
      }

      // Acción desconocida: menú.
      await enviarMenu();
    }

    if (accion) {
      await manejarAccion(accion);
      return null;
    }

    // ── Texto libre ──

    // Solo el menú PEDIDO explícitamente abre el menú. Un "hola" lo contesta
    // el agente: soltarle una lista de opciones a alguien que saluda es
    // justo lo que hace que esto se sienta un bot y no una persona.
    if (["menu", "menú", "opciones", "inicio", "volver"].includes(comando)) {
      await enviarMenu();
      return null;
    }

    if (paso === "reserva:fecha") {
      const fecha = parseFechaFlexible(texto, hoyEn(timezone));
      if (!fecha) {
        await enviar(
          msgTexto(
            to,
            "No me quedó clara la fecha 😅. Puedes decírmela como quieras: *20 de agosto*, *20/08*, *mañana* o *el sábado*.",
          ),
        );
        await pedirFecha();
        return null;
      }
      if (fecha < hoyEn(timezone)) {
        await enviar(msgTexto(to, "Esa fecha ya pasó 📅. Elige una futura."));
        await pedirFecha();
        return null;
      }
      await setConv({
        paso: "reserva:hora",
        contexto: { ...contexto, reserva: { ...contexto.reserva, fecha } },
      });
      contexto.reserva = { ...contexto.reserva, fecha };
      await pedirHora();
      return null;
    }

    if (paso === "reserva:hora") {
      const rango = parseRangoHorasFlexible(texto);
      if (!rango) {
        await enviar(
          msgTexto(
            to,
            "No me quedó claro el horario 😅. Puedes decírmelo así: *de 2 a 6*, *14:00-18:00* o *9 am a 12*.",
          ),
        );
        await pedirHora();
        return null;
      }
      await confirmarReserva(rango[0], rango[1]);
      return null;
    }

    if (paso === "problema:descripcion" && texto.trim()) {
      await setConv({
        paso: "problema:destino",
        contexto: { ...contexto, problema: texto.trim().slice(0, 2000) },
      });
      await enviar(
        msgBotones(to, "¿Con quién va su reporte?", [
          { id: "problema:condominio", title: "🏢 Mi conjunto" },
          { id: "problema:app", title: "📱 La app Vekino" },
        ]),
      );
      return null;
    }

    if (paso === "esperando_comprobante") {
      await enviar(
        msgTexto(to, "Quedo atento a la *foto o PDF* del comprobante. 🧾"),
      );
      return null;
    }

    /* Después de la foto del comprobante: cuánto se pagó. */
    if (paso === "comprobante:monto" && contexto.soporteId) {
      const volverAlMenu = () =>
        setConv({ paso: "menu", contexto: { unidadId: contexto.unidadId } });
      if (/^(omitir|no s[eé]|no lo tengo|despu[eé]s)\b/.test(comando)) {
        await enviar(
          msgTexto(to, "Listo 👍 La administración revisará el valor con el comprobante. Escribe *menú* si necesitas algo más."),
        );
        await volverAlMenu();
        return null;
      }
      const monto = leerMontoPesos(texto);
      if (monto === null) {
        await enviar(
          msgTexto(to, "No me quedó claro el valor 😅. Escríbeme solo el número, por ejemplo *340000*, o *omitir*."),
        );
        return null;
      }
      try {
        await ctx.runMutation(internal.soportesPago.registrarMontoBot, {
          soporteId: contexto.soporteId as Id<"soportesPago">,
          telefono: to,
          monto,
        });
        await enviar(
          msgTexto(to, `Anotado: *${pesos.format(monto)}*. Te avisaremos cuando la administración lo confirme. ✅`),
        );
      } catch {
        await enviar(
          msgTexto(to, "Ese comprobante ya fue revisado por la administración. Escribe *menú* si necesitas algo más."),
        );
      }
      await volverAlMenu();
      return null;
    }

    /* Texto libre → agente con herramientas reales (whatsappAgente.ts).
     * Puede consultar la factura, generar el link de pago, entregar
     * credenciales, revisar disponibilidad y crear reservas o PQRS, así que
     * resuelve en la conversación en vez de mandar al menú. */
    const unidadActiva = datos.unidades[0]?.unidad;
    const respuestaIA: string | null = await ctx.runAction(
      internal.whatsappAgente.responder,
      {
        conversacionId: args.conversacionId,
        userId: datos.user._id,
        condominioId: condominio._id,
        condominioNombre: condominio.name,
        nombre,
        unidadId: unidadActiva?._id,
        unidadNumero: unidadActiva?.numero,
        timezone,
        pregunta: texto,
      },
    );
    if (respuestaIA) {
      await enviar(msgTexto(to, respuestaIA));
      await setConv({ paso: "consulta", contexto });
    } else {
      /* Red de seguridad: el agente no pudo responder (sin API key, error de
       * red o se quedó sin pasos). Se cae a la intención por palabra clave y,
       * en último caso, al menú. */
      if (/factur|deuda|cuanto debo|estado de cuenta|pagar|pago/.test(comando)) {
        await manejarAccion("menu:factura");
      } else if (/reserv|salon|bbq|piscina|cancha|gimnasio/.test(comando)) {
        await manejarAccion("menu:reserva");
      } else if (/comprobante|soporte de pago|transferencia|consign/.test(comando)) {
        await manejarAccion("menu:comprobante");
      } else if (/problema|queja|reclamo|dano|daño|reportar/.test(comando)) {
        await manejarAccion("menu:problema");
      } else if (
        /clave|credencial|contrasena|password|no puedo entrar|acceso|ingresar|olvide/.test(
          comando,
        )
      ) {
        await manejarAccion("menu:acceso");
      } else {
        await enviarMenu();
      }
    }
    return null;
  },
});

// ─────────────────────────────────────────────────────────────
// IA (Claude) para consultas de texto libre
// ─────────────────────────────────────────────────────────────

async function responderConIA(
  ctx: { runQuery: any },
  conversacionId: Id<"waConversations">,
  datos: CtxBot,
  pregunta: string,
): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !pregunta.trim()) return null;

  const historial: Array<Doc<"waMessages">> = await ctx.runQuery(
    internal.whatsapp.ultimosMensajes,
    { conversacionId, n: 10 },
  );

  const condominio = datos.membresias.find(
    (m) => m.membership._id === datos.conversacion.membershipId,
  )?.condominio;

  const system = [
    `Eres el asistente de WhatsApp de Vekino, la plataforma de administración del conjunto residencial "${condominio?.name ?? "—"}" en Colombia.`,
    `Hablas con ${datos.user?.name ?? "un residente"}. Responde en español, cálido y BREVE (máximo 3 frases, es WhatsApp).`,
    "",
    "CRÍTICO: esta persona YA está identificada y verificada por su número de WhatsApp.",
    "NUNCA le pidas cédula, documento ni número de apartamento para 'verificar' quién es.",
    "NUNCA le digas que escriba 'vincular': ese flujo es solo para números desconocidos.",
    "NUNCA inventes requisitos, pasos ni opciones que no estén listados aquí abajo.",
    "",
    "Esto es TODO lo que el bot sabe hacer:",
    "- Consultar su factura y pagar en línea",
    "- Reservar una zona común",
    "- Registrar el comprobante de un pago (basta con que mande la foto)",
    "- Reportar un problema, queja o petición",
    "- Entregarle sus datos de acceso a la plataforma",
    "",
    "Si pide algo de esa lista, respóndele con naturalidad y dile que se lo estás abriendo; el sistema lo lleva al paso siguiente.",
    "Si pide datos exactos (montos, fechas, disponibilidad) no los inventes: no los tienes a la vista.",
    "Nunca inventes normas del conjunto. Si no sabes algo, dilo y sugiere escribir a la administración.",
  ].join("\n");

  const mensajes = historial
    .filter((m) => m.tipo === "text" && m.contenido.trim())
    .slice(-8)
    .map((m) => ({
      role: m.direccion === "entrante" ? ("user" as const) : ("assistant" as const),
      content: m.contenido.slice(0, 1000),
    }));
  if (mensajes.length === 0 || mensajes[mensajes.length - 1]!.role !== "user") {
    mensajes.push({ role: "user", content: pregunta.slice(0, 1000) });
  }

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001",
        max_tokens: 400,
        system,
        messages: mensajes,
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const textoIA = data.content
      ?.filter((b) => b.type === "text" && b.text)
      .map((b) => b.text)
      .join("\n")
      .trim();
    return textoIA || null;
  } catch {
    return null;
  }
}

/**
 * Le manda sus datos de acceso a quien escribe que no puede entrar.
 *
 * Deliberadamente estrecho. No es "el bot vuelve por la puerta de atrás": son
 * frases muy concretas sobre INGRESAR A LA PLATAFORMA, y aun así solo actúa
 * si la persona ya está identificada, porque a un desconocido no se le manda
 * una contraseña.
 *
 * Se descartan a propósito las quejas sobre la SALA de la asamblea ("no puedo
 * entrar a la sala"), que el día de la reunión son la mayoría y no se
 * arreglan con una clave nueva.
 *
 * Una vez por hora y por persona: si alguien insiste, se le rotaría la clave
 * en cada mensaje y quedaría peor que al principio.
 */
const PIDE_ACCESO = [
  "no puedo entrar", "no me deja entrar", "no puedo ingresar",
  "no me deja ingresar", "no puedo acceder", "no logro entrar",
  "como entro", "cómo entro", "como ingreso", "cómo ingreso",
  "como hago para entrar", "cómo hago para entrar",
  "no se como entrar", "no sé cómo entrar", "no se como ingresar",
  "no tengo la clave", "no tengo contraseña", "no tengo contrasena",
  "olvide mi contraseña", "olvidé mi contraseña", "no sirve la contraseña",
  "no sirve la clave", "esa contraseña no", "la clave no funciona",
  "no me funciona la clave", "no me llego la clave", "no me llegó la clave",
];

/** Lo que NO es un problema de credenciales aunque suene parecido. */
const NO_ES_ACCESO = ["a la sala", "en la sala", "a la reunion", "a la reunión", "a la asamblea"];

const RESCATE_MS = 60 * 60 * 1000;

async function rescatarAccesoSiAplica(
  ctx: any,
  conversacionId: Id<"waConversations">,
  texto: string | undefined,
): Promise<void> {
  const t = (texto ?? "").toLowerCase().trim();
  if (t.length < 4 || t.length > 300) return;
  if (!PIDE_ACCESO.some((f) => t.includes(f))) return;
  if (NO_ES_ACCESO.some((f) => t.includes(f))) return;

  const puede = await ctx.runMutation(internal.whatsapp.marcarRescateAcceso, {
    conversacionId,
  });
  if (!puede) return;

  await ctx.runAction(internal.credenciales.enviarAccesoPorWhatsapp, {
    conversacionId,
    forzar: true,
  });
}

/**
 * Reclama el turno de rescate: devuelve false si a esta persona ya se le
 * mandó hace menos de una hora. Es mutation para que dos mensajes seguidos
 * no pasen los dos.
 */
export const marcarRescateAcceso = internalMutation({
  args: { conversacionId: v.id("waConversations") },
  handler: async (ctx, args) => {
    const c = await ctx.db.get(args.conversacionId);
    if (!c) return false;
    // Sin usuario vinculado no se manda ninguna credencial.
    if (!c.userId) return false;
    const now = Date.now();
    if (c.ultimoRescateAccesoAt && now - c.ultimoRescateAccesoAt < RESCATE_MS) {
      return false;
    }
    await ctx.db.patch(args.conversacionId, { ultimoRescateAccesoAt: now });
    return true;
  },
});
