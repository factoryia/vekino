import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { authComponent, createAuth } from "./auth";
import { normalizarTelefonoE164 } from "./lib/telefono";
import { opcionesSubida, recibirSubida } from "./subidas";


/**
 * Texto legible del cuerpo de un mensaje de WhatsApp.
 *
 * Se usa para los ecos y los estados, donde solo interesa qué se dijo. Sin
 * esto, una reacción se guardaba como "[reaction]" y en la bandeja no había
 * forma de saber qué emoji se había mandado.
 *
 * Las rutas se prueban en orden porque la forma del cuerpo cambia según de
 * dónde venga el evento y no está documentada de manera estable.
 */
function describirCuerpoWa(msg: any, tipoMsg: string): string {
  if (typeof msg?.reaction?.emoji === "string" && msg.reaction.emoji) {
    return `Reaccionó ${msg.reaction.emoji}`;
  }
  // Quitar la reacción llega igual, pero con el emoji vacío.
  if (tipoMsg === "reaction") return "Quitó su reacción";

  if (typeof msg?.text?.body === "string") return msg.text.body;
  if (typeof msg?.body === "string") return msg.body;
  if (typeof msg?.caption === "string") return msg.caption;
  if (typeof msg?.image?.caption === "string") return msg.image.caption;
  if (typeof msg?.template?.name === "string") {
    return `📋 Plantilla «${msg.template.name}»`;
  }
  if (tipoMsg === "image") return "📷 Imagen";
  if (tipoMsg === "audio") return "🎤 Nota de voz";
  if (tipoMsg === "video") return "🎥 Video";
  if (tipoMsg === "sticker") return "Sticker";
  if (tipoMsg === "document") {
    const nombre = msg?.document?.filename;
    return typeof nombre === "string" ? `📄 ${nombre}` : "📄 Documento";
  }
  if (tipoMsg === "location") return "📍 Ubicación";
  return `[${tipoMsg}]`;
}


/**
 * Enlace del adjunto de un mensaje de WhatsApp, si lo tiene.
 *
 * Cada tipo lo cuelga de su propia clave (`image.link`, `audio.link`…), así
 * que se prueban todas en vez de asumir una.
 */
function mediaDeMensajeWa(
  msg: any,
  tipoMsg: string,
): { link: string; mimeType?: string; filename?: string } | null {
  for (const k of ["image", "audio", "video", "document", "sticker", "voice"]) {
    const nodo = msg?.[k];
    const link = typeof nodo?.link === "string" ? nodo.link : nodo?.url;
    if (typeof link === "string" && link) {
      return {
        link,
        mimeType: nodo.mime_type ?? nodo.mimeType,
        filename: nodo.filename,
      };
    }
  }
  // Algunos eventos traen el adjunto suelto en la raíz.
  const suelto = typeof msg?.link === "string" ? msg.link : null;
  if (suelto && tipoMsg !== "text") {
    return { link: suelto, mimeType: msg.mime_type ?? msg.mimeType };
  }
  return null;
}

const http = httpRouter();

/* `cors: true` es obligatorio desde que la web llama a estas rutas DIRECTO
 * desde el navegador (ver `lib/auth-client.ts`). Antes todo pasaba por el
 * proxy de Next —servidor a servidor, sin CORS— y por eso nunca hizo falta.
 *
 * Sin esto el navegador ni siquiera llega a la petición: el preflight
 * `OPTIONS` responde 404 porque no hay ruta registrada para ese método, y la
 * promesa revienta con un `TypeError: Failed to fetch` que no dice nada.
 *
 * Los valores por defecto ya traen lo que necesita el flujo cross-domain:
 * los orígenes salen de `trustedOrigins` (auth.ts + AUTH_TRUSTED_ORIGINS),
 * `Better-Auth-Cookie` va en las cabeceras permitidas y
 * `Set-Better-Auth-Cookie` en las expuestas — esta última es la que el
 * cliente tiene que poder LEER para guardar la sesión. */
authComponent.registerRoutes(http, createAuth, { cors: true });

// ─────────────────────────────────────────────────────────────
// Retorno de la Pasarela de Pagos Aval
//
// Aval redirige al usuario a la PortalURL que enviamos en Trn, concatenando
// ?pmtId=<PmtAuthId>. Aquí disparamos una consulta inmediata del estado
// (BasicData) y redirigimos al comprobante en la app web.
// ─────────────────────────────────────────────────────────────
http.route({
  path: "/aval/retorno",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const pmtId =
      url.searchParams.get("pmtId") ??
      url.searchParams.get("PmtId") ??
      url.searchParams.get("pmtid") ??
      "";

    const webBase = process.env.WEB_APP_URL ?? "http://localhost:3000";

    if (!pmtId) {
      return Response.redirect(`${webBase}/pago/retorno`, 302);
    }

    let condominioId: string | null = null;
    try {
      const res = await ctx.runAction(internal.pagos.consultarEstadoPorPmt, {
        pmtId,
      });
      condominioId = res?.condominioId ?? null;
    } catch {
      // No bloquear el retorno del usuario si la consulta falla; la UI reintenta.
    }

    const dest = condominioId
      ? `${webBase}/mi/${condominioId}/pago/retorno?pmtId=${encodeURIComponent(pmtId)}`
      : `${webBase}/pago/retorno?pmtId=${encodeURIComponent(pmtId)}`;

    return Response.redirect(dest, 302);
  }),
});

// ─────────────────────────────────────────────────────────────
// Transcriptor de asambleas
//
// El motor de voz vive fuera de Convex (`infra/transcriptor`) porque
// reconocer habla exige mantener un socket abierto por hablante durante
// horas. Estas dos rutas son todo lo que necesita: preguntar a qué salas
// entrar y devolver texto.
//
// Se autentica con un secreto compartido y no con una sesión de usuario:
// es un servicio, no una persona. `TRANSCRIPTOR_SECRET` vive en Convex y en
// la máquina del servidor de medios, en ningún otro lado.
// ─────────────────────────────────────────────────────────────

/**
 * Comparación en tiempo constante.
 *
 * Un `===` sobre secretos se rinde en el primer byte distinto, y ese tiempo
 * es medible: sirve para adivinar el secreto carácter por carácter. Aquí
 * cuesta lo mismo fallar en el primero que en el último.
 */
function secretoValido(recibido: string | null, esperado: string): boolean {
  // Sin secreto configurado, la ruta queda cerrada. Nunca abierta.
  if (esperado.length < 16) return false;
  if (!recibido) return false;

  const a = new TextEncoder().encode(recibido);
  const b = new TextEncoder().encode(esperado);
  let dif = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    dif |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return dif === 0;
}

function bearer(request: Request): string | null {
  const cabecera = request.headers.get("Authorization") ?? "";
  const m = cabecera.match(/^Bearer\s+(.+)$/i);
  return m ? m[1]!.trim() : null;
}

/** Salas que el transcriptor debe estar atendiendo ahora mismo. */
http.route({
  path: "/transcriptor/salas",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    if (!secretoValido(bearer(request), process.env.TRANSCRIPTOR_SECRET ?? "")) {
      return new Response("No autorizado", { status: 401 });
    }
    const salas = await ctx.runQuery(internal.intervenciones.salasActivas, {});
    return Response.json({ salas });
  }),
});

/**
 * Recibe un segmento transcrito.
 *
 * Responde 200 aunque el segmento se descarte (asamblea cerrada,
 * transcripción apagada, hablante desconocido). El transcriptor no debe
 * reintentar ni caerse porque a alguien se le cayó la sesión a mitad de una
 * frase: eso es ruido esperable, no un fallo.
 */
http.route({
  path: "/transcriptor/intervencion",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!secretoValido(bearer(request), process.env.TRANSCRIPTOR_SECRET ?? "")) {
      return new Response("No autorizado", { status: 401 });
    }

    let cuerpo: {
      asambleaId?: string;
      identidad?: string;
      texto?: string;
      inicioEn?: number;
      finEn?: number;
      confianza?: number;
    };
    try {
      cuerpo = await request.json();
    } catch {
      return new Response("JSON inválido", { status: 400 });
    }

    const { asambleaId, identidad, texto, inicioEn, finEn } = cuerpo;
    if (
      typeof asambleaId !== "string" ||
      typeof identidad !== "string" ||
      typeof texto !== "string" ||
      typeof inicioEn !== "number" ||
      typeof finEn !== "number"
    ) {
      return new Response("Faltan campos", { status: 400 });
    }

    const id = await ctx.runMutation(internal.intervenciones.registrarHttp, {
      asambleaId,
      identidad,
      // Un segmento de voz no llega ni cerca de esto; el tope está para que
      // un cliente roto no pueda escribir un documento entero por fila.
      texto: texto.slice(0, 4000),
      inicioEn,
      finEn,
      confianza:
        typeof cuerpo.confianza === "number" ? cuerpo.confianza : undefined,
    });

    return Response.json({ guardado: id != null });
  }),
});

// ─────────────────────────────────────────────────────────────
// Webhook de YCloud (WhatsApp)
//
// URL a registrar en el panel de YCloud:
//   ${CONVEX_SITE_URL}/whatsapp/webhook?token=<YCLOUD_WEBHOOK_SECRET>
//
// YCloud no firma los eventos, así que el secreto va en la URL (o como
// Bearer). Se responde 200 rápido y el trabajo pesado corre por scheduler:
// YCloud reintenta en no-2xx y no queremos reintentos por errores nuestros.
// La idempotencia real vive en whatsapp.registrarEntrante (ycloudMessageId).
// ─────────────────────────────────────────────────────────────
http.route({
  path: "/whatsapp/webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const token = bearer(request) ?? url.searchParams.get("token");
    if (!secretoValido(token, process.env.YCLOUD_WEBHOOK_SECRET ?? "")) {
      return new Response("No autorizado", { status: 401 });
    }

    let payload: any;
    try {
      payload = await request.json();
    } catch {
      return new Response("JSON inválido", { status: 400 });
    }

    const tipoEvento = typeof payload?.type === "string" ? payload.type : "";

    if (tipoEvento === "whatsapp.inbound_message.received") {
      // Forma actual (whatsappInboundMessage) y forma vieja (data.object).
      const msg = payload.whatsappInboundMessage ?? payload.data?.object;
      if (!msg?.id) return Response.json({ ok: true });

      /* Usernames de WhatsApp (Meta, 2026): si el usuario activó su @usuario,
       * `from` deja de traer el teléfono y puede venir el BSUID. YCloud manda
       * el BSUID aparte en `fromUserId` ("US.1349…"), que llega SIEMPRE y es
       * estable por negocio: esa es la identidad de la conversación. El
       * teléfono pasa a ser un dato opcional que a veces acompaña. */
      const bsuid =
        typeof msg.fromUserId === "string" ? msg.fromUserId : undefined;
      const telefono = msg.from
        ? (normalizarTelefonoE164(String(msg.from)) ?? undefined)
        : undefined;

      // Sin ninguna de las dos identidades no hay a quién responderle.
      if (!bsuid && !telefono) return Response.json({ ok: true });

      const tipoMsg = String(msg.type ?? "text");
      let texto: string | undefined;
      let interactiveId: string | undefined;
      let media:
        | { link: string; mimeType?: string; filename?: string; caption?: string }
        | undefined;

      if (tipoMsg === "text") {
        texto = typeof msg.text?.body === "string" ? msg.text.body : undefined;
      } else if (tipoMsg === "interactive") {
        const reply = msg.interactive?.button_reply ?? msg.interactive?.list_reply;
        interactiveId = typeof reply?.id === "string" ? reply.id : undefined;
        texto = typeof reply?.title === "string" ? reply.title : undefined;
      } else if (tipoMsg === "image" && typeof msg.image?.link === "string") {
        media = {
          link: msg.image.link,
          mimeType: msg.image.mime_type,
          caption: msg.image.caption,
        };
      } else if (tipoMsg === "document" && typeof msg.document?.link === "string") {
        media = {
          link: msg.document.link,
          mimeType: msg.document.mime_type,
          filename: msg.document.filename,
          caption: msg.document.caption,
        };
      }

      /* Mismo criterio que en los ecos: una reacción tiene que decir QUÉ
       * emoji fue. "[reaction]" en la bandeja no le sirve a nadie. */
      const contenido =
        texto ??
        (media?.caption
          ? `[${tipoMsg}] ${media.caption}`
          : describirCuerpoWa(msg, tipoMsg));

      // Registro + scheduling del router son UNA transacción dentro de la
      // mutation: o queda todo, o YCloud reintenta.
      // Copia de la media a S3 para poder verla en el inbox del equipo: los
      // enlaces de YCloud exigen la API key y caducan.
      if (media) {
        await ctx.scheduler.runAfter(0, internal.whatsappInbox.rescatarMedia, {
          ycloudMessageId: String(msg.id),
          link: media.link,
          mimeType: media.mimeType,
          filename: media.filename,
        });
      }

      await ctx.runMutation(internal.whatsapp.registrarEntrante, {
        telefono,
        bsuid,
        username:
          typeof msg.customerProfile?.username === "string"
            ? msg.customerProfile.username
            : undefined,
        ycloudMessageId: String(msg.id),
        tipo: tipoMsg,
        contenido: contenido.slice(0, 4000),
        nombrePerfil:
          typeof msg.customerProfile?.name === "string"
            ? msg.customerProfile.name
            : undefined,
        texto: texto?.slice(0, 4000),
        interactiveId,
        media,
      });
      return Response.json({ ok: true });
    }

    if (tipoEvento === "whatsapp.message.updated") {
      const msg = payload.whatsappMessage ?? payload.data?.object;
      if (msg?.id && msg?.status) {
        // Se manda también el contenido: si el mensaje salió por fuera (panel
        // de YCloud u otra herramienta) este evento es la única forma de
        // enterarnos, y sin estos datos quedaría una burbuja vacía.
        const tipoMsg = typeof msg.type === "string" ? msg.type : "text";
        const cuerpo = describirCuerpoWa(msg, tipoMsg);

        await ctx.runMutation(internal.whatsapp.actualizarEstadoMensaje, {
          ycloudMessageId: String(msg.id),
          estado: String(msg.status),
          error:
            typeof msg.errorMessage === "string" ? msg.errorMessage : undefined,
          destino:
            typeof msg.to === "string"
              ? msg.to
              : typeof msg.recipient === "string"
                ? msg.recipient
                : undefined,
          tipo: tipoMsg,
          contenido: cuerpo,
        });
      }
      return Response.json({ ok: true });
    }

    /* Eco de la app de WhatsApp Business.
     *
     * Cuando alguien del equipo contesta desde el TELÉFONO, ese mensaje no
     * pasa por nuestra API y `message.updated` tampoco lo trae: Meta lo manda
     * por este evento aparte. Sin manejarlo, la bandeja mostraba la
     * conversación a medias —la pregunta del residente sin la respuesta— y
     * parecía que nadie había contestado.
     *
     * La forma del cuerpo no está documentada de manera estable, así que se
     * leen varias rutas posibles y, si no se reconoce ninguna, se guarda el
     * tipo crudo en vez de descartar el mensaje. */
    if (tipoEvento === "whatsapp.smb.message.echoes") {
      const msg =
        payload.whatsappMessage ??
        payload.message ??
        payload.data?.object ??
        payload.echo ??
        null;

      if (msg) {
        const tipoMsg = typeof msg.type === "string" ? msg.type : "text";
        const cuerpo = describirCuerpoWa(msg, tipoMsg);

        const destino =
          typeof msg.to === "string"
            ? msg.to
            : typeof msg.recipient === "string"
              ? msg.recipient
              : typeof msg.customerProfile?.waId === "string"
                ? msg.customerProfile.waId
                : undefined;

        if (destino) {
          const idMsg = String(msg.id ?? `echo-${Date.now()}`);

          await ctx.runMutation(internal.whatsapp.actualizarEstadoMensaje, {
            ycloudMessageId: idMsg,
            estado: typeof msg.status === "string" ? msg.status : "sent",
            destino,
            tipo: tipoMsg,
            contenido: cuerpo,
            /* Lo escribió una persona con el celular en la mano, no el
             * sistema: se etiqueta así para que en el hilo se distinga. */
            etiqueta: "Desde WhatsApp",
          });

          /* La foto o el audio que el equipo mandó desde el teléfono hay que
           * copiarlos igual que los entrantes: los enlaces de YCloud exigen
           * la API key y caducan, así que sin esto la burbuja queda diciendo
           * "📷 Imagen" y no se ve nada. */
          const adj = mediaDeMensajeWa(msg, tipoMsg);
          if (adj) {
            await ctx.scheduler.runAfter(0, internal.whatsappInbox.rescatarMedia, {
              ycloudMessageId: idMsg,
              link: adj.link,
              mimeType: adj.mimeType,
              filename: adj.filename,
            });
          }
        }
      }
      return Response.json({ ok: true });
    }

    // Otros eventos (revisión de plantillas, etc.): 200 y a otra cosa.
    return Response.json({ ok: true });
  }),
});

// ─────────────────────────────────────────────────────────────
// Subida intermediada a S3 (`subidas.ts`)
//
// La `uploadUrl` que `files.generateUploadUrl` da a las apps instaladas (no
// mandan el tamaño): PUT con el archivo y su Content-Type. El enlace es de un
// solo uso; aquí se revisan tamaño y contenido antes de escribir en S3.
// ─────────────────────────────────────────────────────────────
http.route({ path: "/archivos/subida", method: "PUT", handler: recibirSubida });
http.route({ path: "/archivos/subida", method: "OPTIONS", handler: opcionesSubida });

export default http;
