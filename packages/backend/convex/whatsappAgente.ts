import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { textoAccesoWhatsApp } from "./lib/mensajesAcceso";
import type { Id } from "./_generated/dataModel";
import { GUIAS_VEKINO } from "./lib/guiasVekino";
import {
  TEXTO_SIN_VERIFICAR,
  descuentoVigente,
  enRevision,
  fechaLimiteDescuentoDe,
  inicioDeMora,
  mensajePagoEnVerificacion,
  montoAPagarHoy,
  motivoNoPagable,
} from "./lib/cartera";
import { MENSAJE_PASARELA_DE_PRUEBAS, pasarelaPermitida } from "./lib/avalProduccion";

/** "2026-09-15": el día en Colombia (UTC−5) de un instante. */
function diaEnColombia(ts: number): string {
  return new Date(ts - 5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * El agente de WhatsApp.
 *
 * A diferencia del router de menús (whatsapp.ts), aquí Claude tiene
 * HERRAMIENTAS sobre el backend real: consulta la factura de la unidad, genera
 * el link de pago, entrega credenciales, revisa disponibilidad y crea la
 * reserva o el PQRS. El residente escribe como le nazca —"cuánto debo",
 * "quiero el salón el sábado de 2 a 6"— y el agente lo resuelve en la misma
 * conversación, sin obligarlo a navegar opciones.
 *
 * Los menús interactivos siguen existiendo para quien prefiera tocar botones;
 * este camino es para el texto libre.
 */

const MAX_PASOS = 6;

const pesos = new Intl.NumberFormat("es-CO", {
  style: "currency",
  currency: "COP",
  maximumFractionDigits: 0,
});

type Herramienta = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

const HERRAMIENTAS: Herramienta[] = [
  {
    name: "ver_estado_cuenta",
    description:
      "Consulta la factura de administración vigente de la unidad del residente: número, período, total a pagar hoy, hasta qué día vale el descuento por pronto pago, hasta qué día se paga el precio completo (precioCompletoHasta), desde qué día cuenta como mora (enMoraDesde), si está pagada, si tiene un pago en verificación y si hoy se puede pagar en línea (pagoEnLineaDisponible). Úsala cuando pregunte cuánto debe, por su factura, su saldo o su estado de cuenta.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "generar_link_pago",
    description:
      "Genera el enlace de pago en línea (PSE/tarjeta) de la factura vigente y lo devuelve. Úsala solo cuando el residente quiera pagar. Antes conviene haber consultado el estado de cuenta.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "enviar_mis_credenciales",
    description:
      "Entrega los datos de acceso a la plataforma web. Si la persona nunca ha entrado, o sigue usando la clave que le dio la administración, genera una nueva y la devuelve. Si ya se puso una contraseña propia, NO la cambia: devuelve yaTieneClavePropia para que le digas que entre con la suya o use '¿La olvidaste?'. Solo pasa forzar=true si insiste explícitamente en que le cambies la contraseña actual.",
    input_schema: {
      type: "object",
      properties: {
        forzar: {
          type: "boolean",
          description:
            "true solo si la persona pide expresamente cambiar su contraseña actual sabiendo que dejará de funcionar",
        },
      },
      required: [],
    },
  },
  {
    name: "ver_zonas_comunes",
    description:
      "Lista las zonas comunes que se pueden reservar en el conjunto, con su nombre e id. Úsala antes de crear una reserva para saber qué hay disponible.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "verificar_disponibilidad",
    description:
      "Revisa si una zona está libre en una fecha y horario. Úsala SIEMPRE antes de crear una reserva.",
    input_schema: {
      type: "object",
      properties: {
        zonaId: { type: "string", description: "id de la zona (de ver_zonas_comunes)" },
        fecha: { type: "string", description: "AAAA-MM-DD" },
        horaInicio: { type: "string", description: "HH:MM en 24 horas" },
        horaFin: { type: "string", description: "HH:MM en 24 horas" },
      },
      required: ["zonaId", "fecha", "horaInicio", "horaFin"],
    },
  },
  {
    name: "crear_reserva",
    description:
      "Crea la reserva de una zona común a nombre del residente. Queda pendiente de aprobación de la administración. Confirma fecha y hora con él antes de crearla.",
    input_schema: {
      type: "object",
      properties: {
        zonaId: { type: "string" },
        fecha: { type: "string", description: "AAAA-MM-DD" },
        horaInicio: { type: "string", description: "HH:MM" },
        horaFin: { type: "string", description: "HH:MM" },
      },
      required: ["zonaId", "fecha", "horaInicio", "horaFin"],
    },
  },
  {
    name: "escalar_a_persona",
    description:
      "Pide que una persona del equipo de Vekino atienda esta conversación. Úsala cuando no puedas resolver con tus otras herramientas ni con las guías: una duda que no cubren, un caso raro, un reclamo delicado, o cuando la persona pide explícitamente hablar con alguien. Después de usarla no sigas intentando resolverlo tú: avísale que ya llamaste a alguien del equipo.",
    input_schema: {
      type: "object",
      properties: {
        motivo: {
          type: "string",
          description: "Qué necesita esta persona, en una frase, para que quien la atienda entre en contexto",
        },
      },
      required: ["motivo"],
    },
  },
  {
    name: "reportar_problema",
    description:
      "Radica una petición, queja o reclamo ante la administración del conjunto. Devuelve el número de radicado. Úsala cuando reporte un daño, una queja o una solicitud formal.",
    input_schema: {
      type: "object",
      properties: {
        tipo: {
          type: "string",
          enum: ["peticion", "queja", "reclamo", "sugerencia", "felicitacion"],
        },
        asunto: { type: "string", description: "resumen corto" },
        descripcion: { type: "string", description: "lo que contó el residente" },
      },
      required: ["tipo", "asunto", "descripcion"],
    },
  },
];

export const responder = internalAction({
  args: {
    conversacionId: v.id("waConversations"),
    userId: v.id("users"),
    condominioId: v.id("condominios"),
    condominioNombre: v.string(),
    nombre: v.string(),
    unidadId: v.optional(v.id("unidades")),
    unidadNumero: v.optional(v.string()),
    timezone: v.string(),
    pregunta: v.string(),
  },
  handler: async (ctx, args): Promise<string | null> => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return null;

    const historial: Array<{ direccion: string; tipo: string; contenido: string }> =
      await ctx.runQuery(internal.whatsapp.ultimosMensajes, {
        conversacionId: args.conversacionId,
        n: 12,
      });

    const hoy = new Intl.DateTimeFormat("en-CA", {
      timeZone: args.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());

    const system = [
      `Eres el asistente de Vekino para el conjunto residencial ${args.condominioNombre}, en Colombia.`,
      `Hablas por WhatsApp con ${args.nombre}${args.unidadNumero ? `, de la unidad ${args.unidadNumero}` : ""}.`,
      `Hoy es ${hoy} (zona horaria ${args.timezone}).`,
      "",
      "Eres una PERSONA del equipo de administración, no un sistema.",
      "",
      "Cómo hablas:",
      "- SIEMPRE de USTED. Nunca tutees, ni aunque la persona te tutee a ti.",
      "  Es 'le ayudo', 'usted puede', 'su unidad'. Nunca 'te ayudo' ni 'tu unidad'.",
      "- Trátalos por su título: 'señor Luis', 'señora Marcela'. Al saludar,",
      "  'Buenos días, señor Luis' o 'Buenas tardes, señora Marcela'.",
      "- Si el nombre no te deja claro si es hombre o mujer (Alexis, Yamile, Cruz,",
      "  Guadalupe, iniciales, un apellido solo...), NO adivines: usa el nombre a",
      "  secas ('Buenas tardes, Alexis'). Equivocarte de género ofende más que",
      "  omitir el título. Tampoco digas nunca 'señorita'.",
      "- Cercano pero respetuoso: es el trato de la administración con un",
      "  propietario, no el de dos amigos. Nada de 'listo, parce' ni 'de una'.",
      "- Frases cortas. Nunca sueltes listas de opciones ni menús numerados.",
      "- Nunca digas 'selecciona una opción', 'escribe la palabra X' ni '¿en qué puedo ayudarte hoy?'.",
      "- Nada de lenguaje de robot: ni 'procesando', ni 'su solicitud', ni 'estimado usuario'.",
      "- Si te saludan, saluda de vuelta con naturalidad y pregunta qué necesita, en una línea.",
      "- Un emoji de vez en cuando está bien; no en cada frase.",
      "",
      "Cómo trabajas:",
      "- Si una herramienta devuelve `textoExacto`, ese ES tu respuesta: cópialo",
      "  TAL CUAL, palabra por palabra, sin reescribirlo, resumirlo ni añadirle nada.",
      "  Lleva datos que solo el sistema conoce; si lo redactas tú te los inventas.",
      "- Nunca digas cuánto dura un enlace, cuánto vale algo ni cuándo vence si no",
      "  te lo dio una herramienta. Si no lo tienes, no lo menciones.",
      "- Cuando te pidan algo, HAZLO con tus herramientas. No expliques pasos ni mandes a ningún menú.",
      "- Si te falta un dato, pregúntalo como lo preguntaría una persona: una cosa a la vez.",
      "- Si alguien dice 'cuánto debo', consulta y dile el número. No preguntes de qué unidad si solo tiene una.",
      "- Si dice 'quiero el salón el sábado', mira las zonas, revisa disponibilidad y proponle confirmar.",
      "- Interpreta fechas y horas como habla la gente: 'mañana', 'el sábado', '20 de agosto', 'de 2 a 6' (14:00 a 18:00).",
      "",
      "Cuando pregunten CÓMO se hace algo en la plataforma:",
      "- Guíalos con los pasos reales que tienes abajo, nombrando los botones tal cual se llaman.",
      "- Da 3 o 4 pasos por mensaje, no un manual entero. Y ofrece seguir si se traban.",
      "- Si el problema es un botón que no se activa, revisa primero las trampas conocidas.",
      "- NUNCA los mandes a la administración por algo que sí está en estas guías.",
      "",
      "Límites que no cruzas:",
      "- Esta persona YA está identificada por su número. Nunca le pidas cédula, documento ni apartamento para verificarla.",
      "- Nunca inventes montos, saldos, fechas ni normas del conjunto: si no vino de una herramienta, no lo sabes. Dilo sin rodeos.",
      "- Antes de crear una reserva o de cambiarle la contraseña, confirma con ella.",
      "- Si te piden algo que no puedes hacer, dilo claro y ofrece escribirle a la administración.",
      "- Antes de rendirte, usa escalar_a_persona: alguien del equipo lo atiende por este mismo chat.",
      "- Si algo NO está en las guías de abajo, dilo en vez de inventarte pantallas o botones.",
      "",
      GUIAS_VEKINO,
    ].join("\n");

    type Mensaje = { role: "user" | "assistant"; content: unknown };
    const mensajes: Mensaje[] = [];
    for (const m of historial) {
      if (m.tipo !== "text" || !m.contenido.trim()) continue;
      mensajes.push({
        role: m.direccion === "entrante" ? "user" : "assistant",
        content: m.contenido.slice(0, 1200),
      });
    }
    if (
      mensajes.length === 0 ||
      (mensajes[mensajes.length - 1] as Mensaje).role !== "user"
    ) {
      mensajes.push({ role: "user", content: args.pregunta.slice(0, 1200) });
    }

    for (let paso = 0; paso < MAX_PASOS; paso++) {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5",
          max_tokens: 900,
          system,
          tools: HERRAMIENTAS,
          messages: mensajes,
        }),
      });
      if (!res.ok) return null;

      const data = (await res.json()) as {
        content?: Array<Record<string, any>>;
        stop_reason?: string;
      };
      const bloques = data.content ?? [];
      mensajes.push({ role: "assistant", content: bloques });

      const usos = bloques.filter((b) => b.type === "tool_use");
      if (usos.length === 0) {
        return (
          bloques
            .filter((b) => b.type === "text" && b.text)
            .map((b) => b.text as string)
            .join("\n")
            .trim() || null
        );
      }

      const resultados = [];
      for (const uso of usos) {
        const salida = await ejecutar(ctx, args, uso.name, uso.input ?? {});
        resultados.push({
          type: "tool_result",
          tool_use_id: uso.id,
          content: JSON.stringify(salida),
        });
      }
      mensajes.push({ role: "user", content: resultados });
    }

    // Se acabaron los pasos sin una respuesta final: mejor callar que inventar.
    return null;
  },
});

/** Ejecuta una herramienta contra el backend real. */
async function ejecutar(
  ctx: any,
  args: {
    conversacionId: Id<"waConversations">;
    userId: Id<"users">;
    condominioId: Id<"condominios">;
    unidadId?: Id<"unidades">;
    unidadNumero?: string;
  },
  nombre: string,
  input: Record<string, any>,
): Promise<unknown> {
  try {
    switch (nombre) {
      case "ver_estado_cuenta": {
        if (!args.unidadId) return { error: "El residente no tiene unidad vinculada." };
        const f = await ctx.runQuery(internal.soportesPago.facturaVigenteDeUnidad, {
          unidadId: args.unidadId,
        });
        if (!f) return { sinFacturas: true };
        /* El descuento vale hasta SU fecha, no hasta el vencimiento (F-06). */
        const ahora = Date.now();
        const limite = fechaLimiteDescuentoDe(f);
        /* Meses viejos "Sin verificar" (Fase 4): no son deuda. */
        const sinVerificar: { periodo: string; periodoLabel: string }[] = await ctx.runQuery(
          internal.soportesPago.sinVerificarDeUnidad,
          { unidadId: args.unidadId },
        );
        return {
          ...(sinVerificar.length > 0
            ? {
                mesesSinVerificar: sinVerificar.map((s) => s.periodoLabel || s.periodo),
                sobreMesesSinVerificar: `${TEXTO_SIN_VERIFICAR} No son deuda aparte: lo que debe hoy ya está en la factura vigente. No digas que los debe ni que los pagó.`,
              }
            : {}),
          numeroFactura: f.numeroFactura,
          periodo: f.periodoLabel,
          /* Con la unidad en mora, "vencida" (QA de comprobantes, H2). */
          estado: f.estadoVisible,
          /* Lectura dudosa del PDF: el monto no está verificado. */
          enRevision: enRevision(f),
          /* Pagó y la contabilidad aún no lo refleja: no es deuda que cobrar. */
          ...(f.pagoEnVerificacion
            ? {
                pagoEnVerificacion: pesos.format(f.pagoEnVerificacion.monto),
                queDecir: `${mensajePagoEnVerificacion(f.pagoEnVerificacion.monto)} No le pidas que pague otra vez.`,
              }
            : {}),
          totalAPagar: pesos.format(montoAPagarHoy(f, ahora)),
          aplicaDescuentoProntoPago: descuentoVigente(f, ahora),
          descuentoHasta: limite !== null ? diaEnColombia(limite) : null,
          /* Fase 4, decisión B: el fin de mes es el plazo del precio
           * completo; la mora empieza el 16 del mes siguiente. */
          precioCompletoHasta: diaEnColombia(f.fechaVencimiento),
          venceEl: diaEnColombia(f.fechaVencimiento),
          enMoraDesde: f.fechaVencimiento > 0 ? diaEnColombia(inicioDeMora(f)) : null,
          /* Con la pasarela en QA no se ofrece pagar en línea a una casa real. */
          pagoEnLineaDisponible: pasarelaPermitida(process.env, f.unidadId),
          tienePdf: !!f.pdfUrl,
        };
      }

      case "generar_link_pago": {
        if (!args.unidadId) return { error: "Sin unidad vinculada." };
        const f = await ctx.runQuery(internal.soportesPago.facturaVigenteDeUnidad, {
          unidadId: args.unidadId,
        });
        if (!f) return { error: "No hay factura para pagar." };
        /* `f` es la vigente: si no se puede pagar, está saldada. Nunca se
         * busca una anterior, cuyo saldo ya va dentro de esta. */
        const noPagable = motivoNoPagable([f], f);
        if (noPagable === "pagada") return { yaPagada: true };
        if (noPagable === "en_revision") {
          return {
            enRevision: true,
            queDecir:
              "Su factura está en revisión por la administración; todavía no se puede pagar en línea. No inventes montos ni fechas.",
          };
        }
        if (noPagable === "pago_en_verificacion") {
          return {
            pagoEnVerificacion: true,
            queDecir: `${mensajePagoEnVerificacion(f.pagoEnVerificacion?.monto ?? 0)} Mientras tanto no se cobra en línea, para no cobrarle dos veces. No inventes montos ni fechas.`,
          };
        }
        if (noPagable) return { alDia: true, sinSaldoPorPagar: true };
        /* Pasarela en QA y casa real (Fase 4): no se genera un enlace de
         * pruebas, que no mueve plata y le haría creer que pagó. */
        if (!pasarelaPermitida(process.env, f.unidadId)) {
          return {
            pagoEnLineaNoDisponible: true,
            queDecir: `${MENSAJE_PASARELA_DE_PRUEBAS} No generes ni inventes enlaces de pago.`,
          };
        }
        const pago = await ctx.runAction(internal.pagos.crearPagoFacturaBot, {
          facturaId: f._id,
          userId: args.userId,
        });
        return { enlacePago: pago.redirectUrl, factura: f.numeroFactura };
      }

      case "enviar_mis_credenciales": {
        const r = await ctx.runAction(internal.credenciales.generarClaveParaEntrega, {
          userId: args.userId,
          forzar: input.forzar === true,
        });
        if (!r.ok && r.yaTieneClavePropia) {
          return {
            yaTieneClavePropia: true,
            usuario: r.email,
            donde: "https://www.vekino.com/login",
            queDecir:
              "Ya tiene contraseña propia; no se la cambiamos. Si no la recuerda, que use '¿La olvidaste?' en la pantalla de ingreso.",
          };
        }
        if (!r.ok) return { error: r.motivo };
        /* Se devuelve el texto YA REDACTADO, no los datos sueltos. Cuando el
         * agente lo escribia el, se inventaba los detalles: a un residente le
         * dijo que el enlace vencia en 30 minutos cuando dura 24 horas. */
        return {
          textoExacto: textoAccesoWhatsApp({
            email: r.email,
            password: r.password,
            enlace: r.enlace,
          }),
        };
      }

      case "ver_zonas_comunes": {
        const zonas = await ctx.runQuery(internal.reservas.zonasActivas, {
          condominioId: args.condominioId,
        });
        return zonas.map((z: any) => ({
          zonaId: z._id,
          nombre: z.nombre,
          tipo: z.tipo ?? null,
          horarios: z.horariosPorDia ?? null,
        }));
      }

      case "verificar_disponibilidad":
        return await ctx.runQuery(internal.reservas.verificarDisponibilidad, {
          zonaId: input.zonaId as Id<"zonasComunes">,
          fecha: input.fecha,
          horaInicio: input.horaInicio,
          horaFin: input.horaFin,
        });

      case "crear_reserva": {
        if (!args.unidadId) return { error: "Sin unidad vinculada." };
        const r = await ctx.runMutation(internal.reservas.createFromBot, {
          userId: args.userId,
          condominioId: args.condominioId,
          unidadId: args.unidadId,
          zonaId: input.zonaId as Id<"zonasComunes">,
          fecha: input.fecha,
          horaInicio: input.horaInicio,
          horaFin: input.horaFin,
          observaciones: "Creada por WhatsApp",
        });
        return { creada: true, estado: r.estado };
      }

      case "escalar_a_persona": {
        await ctx.runMutation(internal.whatsappInbox.escalar, {
          conversacionId: args.conversacionId,
          motivo: String(input.motivo ?? "Sin motivo"),
        });
        return {
          escalado: true,
          queDecir:
            "Dile que ya avisaste a alguien del equipo y que le escriben por aquí mismo. No prometas tiempos exactos.",
        };
      }

      case "reportar_problema": {
        const r = await ctx.runMutation(internal.pqrs.crearInterno, {
          condominioId: args.condominioId,
          userId: args.userId,
          tipo: input.tipo,
          asunto: String(input.asunto).slice(0, 120),
          descripcion: `${input.descripcion}\n\n— Recibido por WhatsApp`,
          unidadNumero: args.unidadNumero,
        });
        return { radicado: r.radicado };
      }

      default:
        return { error: "Herramienta desconocida." };
    }
  } catch (e) {
    // El error viaja al modelo para que lo explique con sus palabras.
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
