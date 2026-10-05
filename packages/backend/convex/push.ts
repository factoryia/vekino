import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  LOTE_EXPO,
  interpretarRespuesta,
  type RespuestaExpo,
} from "./lib/expoPush";

/**
 * Envío de notificaciones push.
 *
 * Hasta ahora la app registraba el token del teléfono y nadie lo usaba: no
 * existía código que enviara nada. Esto es la otra mitad.
 *
 * Va contra la API de Expo, que es la que corresponde porque los tokens los
 * emite Expo (`ExponentPushToken[...]`). Expo se encarga de hablar con APNs
 * y con FCM; nosotros solo le entregamos mensajes.
 *
 * ── Lo que hay que hacer bien ────────────────────────────────────────────
 * Mandar el POST es lo fácil. Lo que decide si esto funciona en seis meses
 * es lo otro:
 *
 *   · Los tokens MUEREN. Se desinstala la app, se restaura el teléfono, se
 *     reinstala. Expo responde `DeviceNotRegistered` y ese token hay que
 *     apagarlo; si no, se le sigue empujando a un aparato que no existe para
 *     siempre.
 *   · Expo acepta 100 mensajes por petición. Un conjunto de 300 casas no
 *     cabe en una.
 *   · Fallar no puede tumbar lo que disparó el aviso. Que no llegue una
 *     notificación es molesto; que no se pueda registrar un paquete porque
 *     el servidor de Expo está caído es inaceptable.
 */

const EXPO_URL = "https://exp.host/--/api/v2/push/send";

export type MensajePush = {
  token: string;
  titulo: string;
  cuerpo: string;
  /** Ruta de la app a la que lleva el toque. */
  ruta?: string;
};

// ─────────────────────────────────────────────────────────────
// Piezas internas
// ─────────────────────────────────────────────────────────────

/** Tokens activos de un grupo de personas. */
export const tokensDe = internalQuery({
  args: { userIds: v.array(v.id("users")) },
  handler: async (ctx, args) => {
    const salida: { userId: Id<"users">; token: string }[] = [];
    /* Sin repetidos: una persona puede estar vinculada a dos casas y no debe
     * recibir el mismo aviso dos veces. */
    const vistos = new Set<string>();
    for (const userId of new Set(args.userIds)) {
      const tokens = await ctx.db
        .query("pushTokens")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect();
      for (const t of tokens) {
        if (!t.enabled || vistos.has(t.token)) continue;
        vistos.add(t.token);
        salida.push({ userId, token: t.token });
      }
    }
    return salida;
  },
});

/**
 * Apaga los tokens que Expo reporta como muertos.
 *
 * Sin esto la lista de tokens crece para siempre y cada envío arrastra
 * aparatos que ya no existen, pagando el viaje y ensuciando los resultados.
 */
export const apagarTokens = internalMutation({
  args: { tokens: v.array(v.string()) },
  handler: async (ctx, args) => {
    for (const token of args.tokens) {
      const fila = await ctx.db
        .query("pushTokens")
        .withIndex("by_token", (q) => q.eq("token", token))
        .first();
      if (fila?.enabled) {
        await ctx.db.patch(fila._id, { enabled: false, updatedAt: Date.now() });
      }
    }
    return args.tokens.length;
  },
});

/** Quiénes están vinculados (y vigentes) a estas casas. */
export const personasDeUnidades = internalQuery({
  args: { unidadIds: v.array(v.id("unidades")) },
  handler: async (ctx, args) => {
    const userIds = new Set<Id<"users">>();
    const ahora = Date.now();
    const FIN_DEL_DIA = 24 * 60 * 60 * 1000;

    for (const unidadId of new Set(args.unidadIds)) {
      const links = await ctx.db
        .query("usuarioUnidad")
        .withIndex("by_unidad", (q) => q.eq("unidadId", unidadId))
        .collect();
      for (const l of links) {
        /* Un arrendatario que ya se fue no debe recibir avisos de esa casa.
         * Mismo criterio que `vigentes` en authz. */
        if (l.vigenciaDesde != null && l.vigenciaDesde > ahora) continue;
        if (l.vigenciaHasta != null && ahora >= l.vigenciaHasta + FIN_DEL_DIA) {
          continue;
        }
        const m = await ctx.db.get(l.membershipId);
        if (m?.isActive) userIds.add(m.userId);
      }
    }
    return [...userIds];
  },
});

// ─────────────────────────────────────────────────────────────
// El envío
// ─────────────────────────────────────────────────────────────

/**
 * Manda los mensajes a Expo, por lotes, y apaga lo que rebote.
 *
 * Nunca lanza: la llaman mutaciones que ya hicieron su trabajo (el paquete
 * quedó registrado), y una caída de Expo no puede deshacer eso.
 */
export const enviar = internalAction({
  args: {
    mensajes: v.array(
      v.object({
        token: v.string(),
        titulo: v.string(),
        cuerpo: v.string(),
        ruta: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args): Promise<{ enviados: number; apagados: number }> => {
    if (args.mensajes.length === 0) return { enviados: 0, apagados: 0 };

    /* Opcional pero recomendable: sin token de acceso, cualquiera que
     * consiga un ExponentPushToken puede mandarle notificaciones a esa
     * persona haciéndose pasar por la app. */
    const accessToken = process.env.EXPO_ACCESS_TOKEN?.trim();

    let enviados = 0;
    const muertos: string[] = [];

    for (let i = 0; i < args.mensajes.length; i += LOTE_EXPO) {
      const lote = args.mensajes.slice(i, i + LOTE_EXPO);
      try {
        const res = await fetch(EXPO_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
          },
          body: JSON.stringify(
            lote.map((m) => ({
              to: m.token,
              title: m.titulo,
              body: m.cuerpo,
              sound: "default",
              data: m.ruta ? { ruta: m.ruta } : undefined,
            })),
          ),
        });

        if (!res.ok) {
          console.error(`[push] Expo respondió ${res.status}`);
          continue;
        }

        const cuerpo = (await res.json()) as RespuestaExpo;
        if (cuerpo.errors?.length) {
          console.error("[push]", cuerpo.errors.map((e) => e.message).join("; "));
        }

        const r = interpretarRespuesta(lote.map((m) => m.token), cuerpo);
        enviados += r.enviados;
        muertos.push(...r.muertos);
        for (const p of r.problemas) console.error(`[push] ${p}`);
      } catch (e) {
        // Se registra y se sigue con el resto de lotes.
        console.error("[push] lote fallido:", (e as Error).message);
      }
    }

    if (muertos.length > 0) {
      await ctx.runMutation(internal.push.apagarTokens, { tokens: muertos });
    }
    return { enviados, apagados: muertos.length };
  },
});

/**
 * Arma y despacha un aviso para las personas de unas casas.
 *
 * Es la que llaman los módulos. Resuelve a quién, junta los tokens y agenda
 * el envío.
 */
export const avisarAUnidades = internalAction({
  args: {
    unidadIds: v.array(v.id("unidades")),
    titulo: v.string(),
    cuerpo: v.string(),
    ruta: v.optional(v.string()),
    /** No avisarle a quien disparó el evento. */
    exceptoUserId: v.optional(v.id("users")),
  },
  handler: async (ctx, args): Promise<{ enviados: number; apagados: number }> => {
    if (args.unidadIds.length === 0) return { enviados: 0, apagados: 0 };

    const userIds: Id<"users">[] = await ctx.runQuery(
      internal.push.personasDeUnidades,
      { unidadIds: args.unidadIds },
    );
    const destino = userIds.filter((u) => u !== args.exceptoUserId);
    if (destino.length === 0) return { enviados: 0, apagados: 0 };

    const tokens: { userId: Id<"users">; token: string }[] = await ctx.runQuery(
      internal.push.tokensDe,
      { userIds: destino },
    );

    return await ctx.runAction(internal.push.enviar, {
      mensajes: tokens.map((t) => ({
        token: t.token,
        titulo: args.titulo,
        cuerpo: args.cuerpo,
        ruta: args.ruta,
      })),
    });
  },
});

/**
 * Lo mismo para personas concretas, sin pasar por casas: el guarda al que se
 * le pide una cobertura no es residente de ninguna. Mismos tokens y mismo
 * envío que `avisarAUnidades`.
 */
export const avisarAPersonas = internalAction({
  args: {
    userIds: v.array(v.id("users")),
    titulo: v.string(),
    cuerpo: v.string(),
    ruta: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ enviados: number; apagados: number }> => {
    if (args.userIds.length === 0) return { enviados: 0, apagados: 0 };
    const tokens: { userId: Id<"users">; token: string }[] = await ctx.runQuery(
      internal.push.tokensDe,
      { userIds: args.userIds },
    );
    return await ctx.runAction(internal.push.enviar, {
      mensajes: tokens.map((t) => ({
        token: t.token,
        titulo: args.titulo,
        cuerpo: args.cuerpo,
        ruta: args.ruta,
      })),
    });
  },
});
