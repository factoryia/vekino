import { v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server";
import type { ActionCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireAppUser } from "./model/authz";
import { etiquetaUnidad, referenciaPago } from "./lib/referenciaPago";
import {
  faltantesParaProduccion,
  QA_AUTH_BASIC,
  QA_ENDPOINT,
} from "./lib/avalProduccion";
import { credencialesConvenio } from "./lib/avalConvenio";

// ─────────────────────────────────────────────────────────────
// Integración con la Pasarela de Pagos Aval (AV Villas / Grupo Aval)
// Doc: "Especificación Servicios – Integración Pasarela de Pagos Aval" v1.6
//
// Operaciones:
//   oauth2-token   → token de acceso (X-Sesskey) por transacción.
//   Payments_Trn   → crea la transacción, devuelve PmtAuthId + URL de la pasarela.
//   Payments_BasicData/{PmtId} → consulta el estado final de la transacción.
//
// Ambientes:
//   Los valores por defecto son los de QA/pruebas publicados en el manual, así
//   el flujo funciona en desarrollo sin configurar nada. Para PRODUCCIÓN se
//   sobreescriben por variables de entorno en el dashboard de Convex; NINGUNA
//   credencial de producción vive en el repositorio.
//   De Vekino ante Aval (una sola para todos los conjuntos):
//     AVAL_ENDPOINT          ej https://<dns-prod>
//     AVAL_AUTH_BASIC        Authorization Basic del servicio oauth2 (prod)
//     AVAL_TRN_SRC           Banco recaudador (2 = AV Villas)
//     AVAL_AMBIENTE          "qa" | "prod"
//   De cada convenio, con el Nura de sufijo (lib/avalConvenio.ts). El Nura lo
//   guarda el condominio en `avalNura`:
//     AVAL_X_AUTHORIZATION_<NURA>   Llave del convenio (X-Authorization) — SECRET
//     AVAL_SECRET_USER_<NURA> / AVAL_SECRET_PASSWORD_<NURA>  SecretList — SECRET
//     AVAL_CHANNEL_<NURA>           X-Channel que asigna el banco al convenio
//   En QA, sin sufijo valen las globales (AVAL_X_AUTHORIZATION, AVAL_AGRM_ID…)
//   y luego los ejemplos del manual. En producción no hay respaldo.
//   Web de retorno:  WEB_APP_URL  (ej https://app.vekino.co  — dev: localhost:3000)
// ─────────────────────────────────────────────────────────────

interface AvalConfig {
  endpoint: string;
  authBasic: string;
  xAuthorization: string;
  agrmId: string;
  companyId: string;
  channel: string;
  trnSrc: string;
  secretUser: string;
  secretPassword: string;
  ambiente: string;
  insecureTls: boolean;
}

/**
 * Config de la pasarela para un convenio. Por defecto QA (valores del manual,
 * no sensibles). En producción se pasan por env en el dashboard de Convex.
 *
 * `nura` es el convenio que cobra: el `avalNura` del condominio al crear el
 * pago, y el `agrmId` guardado en el pago al consultarlo, para que la consulta
 * use la misma llave con que se creó aunque el condominio cambie después.
 *
 * El canal tambien es del convenio. El manual dice "valor constante: 16" y
 * NO lo es: con 16 la pasarela responde 105 —"No es posible realizar la
 * transaccion"— sin decir por que. Ciudad del Campo (00030713) usa 1,
 * comprobado contra QA. De cada convenio nuevo, es lo primero que hay que
 * preguntarle al banco.
 */
function avalConfig(nura?: string | null): AvalConfig {
  const ambiente = process.env.AVAL_AMBIENTE ?? "qa";
  const cfg: AvalConfig = {
    endpoint: process.env.AVAL_ENDPOINT ?? QA_ENDPOINT,
    // Basic del servicio oauth2 — QA del manual (sección 4.3). Prod por env.
    authBasic: process.env.AVAL_AUTH_BASIC ?? QA_AUTH_BASIC,
    // Nura, X-Authorization, SecretList y canal: los del convenio.
    ...credencialesConvenio(process.env, nura, ambiente),
    companyId: process.env.AVAL_COMPANY_ID ?? "00089898",
    trnSrc: process.env.AVAL_TRN_SRC ?? "2", // 2 = Banco AvVillas
    ambiente,
    // TLS: en QA el endpoint no envía la cadena de CA completa, así que se
    // relaja la verificación. En producción SIEMPRE estricta (salvo opt-in
    // explícito con AVAL_INSECURE_TLS=1, no recomendado).
    insecureTls:
      process.env.AVAL_INSECURE_TLS === "1" ||
      (process.env.AVAL_AMBIENTE ?? "qa") !== "prod",
  };

  const faltan = faltantesParaProduccion(cfg);
  if (faltan.length > 0) {
    throw new Error(
      `Configuracion de produccion incompleta, no se envia nada al banco: ${faltan.join("; ")}.`,
    );
  }
  return cfg;
}

/** URL pública de nuestra app web (para la pantalla de comprobante de retorno). */
function webAppUrl(): string {
  return process.env.WEB_APP_URL ?? "http://localhost:3000";
}

/** URL base de httpActions de Convex (.site) para la URL de retorno de Aval. */
function convexSiteUrl(): string {
  // CONVEX_SITE_URL lo inyecta Convex automáticamente en el runtime.
  return process.env.CONVEX_SITE_URL ?? "";
}

/** X-RqUID: identificador único numérico por transacción (máx 22 dígitos). */
/**
 * Identificador unico de la peticion.
 *
 * El manual dice Number(22) y con 22 digitos la pasarela responde 511 — "No
 * es posible procesar la transaccion" — sin decir por que. El backend de
 * Aval lo lee como un entero con signo de 64 bits, que tope en
 * 9.223.372.036.854.775.807: DIECINUEVE digitos. Veintidos desbordan.
 *
 * Comprobado contra QA con el mismo cuerpo y la misma llave, cambiando solo
 * el largo: 22 da 511, 19 y 18 devuelven PmtAuthId.
 *
 * Trece del reloj mas seis al azar: 19 digitos, empieza en 1 y por tanto
 * cabe holgado, y deja una entre un millon de colisiones dentro del mismo
 * milisegundo.
 */
function generarRqUID(): string {
  const ts = Date.now().toString(); // 13 digitos
  const rnd = Math.floor(Math.random() * 1e6)
    .toString()
    .padStart(6, "0");
  return (ts + rnd).slice(0, 19);
}

/** Mapea el tipoDocumento de Vekino al tipo que espera Aval. */
function mapGovType(tipo?: string): string {
  switch (tipo) {
    case "CC":
    case "CE":
    case "NIT":
    case "TI":
      return tipo;
    case "PASAPORTE":
      return "PP";
    default:
      return "GUEST";
  }
}

/** Cabeceras comunes de seguridad para Trn y BasicData. */
function avalHeaders(
  cfg: AvalConfig,
  token: string,
  rqUID: string,
  govType: string,
  identNum: string,
  ipAddr: string,
): Record<string, string> {
  const auth = cfg.authBasic; // (no usado aquí; se deja explícito el contrato)
  void auth;
  return {
    "Content-Type": "application/json",
    "X-RqUID": rqUID,
    "X-Channel": cfg.channel,
    "X-CompanyId": cfg.companyId,
    "X-GovIssueIdentType": govType,
    "X-IdentSerialNum": identNum,
    "X-IPAddr": ipAddr,
    "X-Sesskey": token,
    "X-Authorization": cfg.xAuthorization,
  };
}

/** Ejecuta una petición HTTPS hacia Aval a través del cliente Node (control TLS). */
async function avalRequest(
  ctx: { runAction: (fn: any, args: any) => Promise<any> },
  cfg: AvalConfig,
  opts: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
  },
): Promise<{ status: number; headers: Record<string, string>; text: string }> {
  return await ctx.runAction(internal.avalHttp.request, {
    url: opts.url,
    method: opts.method,
    headers: opts.headers,
    body: opts.body,
    insecure: cfg.insecureTls,
  });
}

/** oauth2-token → access_token (X-Sesskey). */
async function obtenerToken(
  ctx: { runAction: (fn: any, args: any) => Promise<any> },
  cfg: AvalConfig,
): Promise<string> {
  const authHeader = cfg.authBasic.startsWith("Basic ")
    ? cfg.authBasic
    : `Basic ${cfg.authBasic}`;

  const res = await avalRequest(ctx, cfg, {
    url: `${cfg.endpoint}/security/oauth2/oauth2-token`,
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: authHeader,
    },
    body: "grant_type=client_credentials&scope=payment_mgmt/sesskey_payment",
  });

  let json: any;
  try {
    json = JSON.parse(res.text);
  } catch {
    throw new Error(`oauth2-token: respuesta no-JSON (HTTP ${res.status}): ${res.text.slice(0, 200)}`);
  }
  if (res.status < 200 || res.status >= 300 || !json.access_token) {
    throw new Error(`oauth2-token falló (HTTP ${res.status}): ${json.error ?? res.text.slice(0, 200)}`);
  }
  return json.access_token as string;
}

/** Estados que puede reportar una consulta BasicData (excluye iniciada/error). */
type EstadoConsulta =
  | "pendiente"
  | "aprobada"
  | "rechazada"
  | "fallida"
  | "expirada"
  | "no_autorizada";

/** Estado de Aval (StatusCode BasicData) → estado interno del pago. */
function mapStatusCode(code: string): EstadoConsulta {
  switch (String(code)) {
    case "4":
      return "aprobada";
    case "2":
      return "rechazada";
    case "3":
      return "fallida";
    case "5":
      return "expirada";
    case "6":
      return "no_autorizada";
    case "1":
    default:
      return "pendiente";
  }
}

// ─────────────────────────────────────────────────────────────
// Consultas / mutaciones internas (DB)
// ─────────────────────────────────────────────────────────────

/**
 * Cuerpo común de datosParaTrn / datosParaTrnDeUsuario: valida que `user`
 * puede pagar la factura y devuelve todos los datos necesarios para armar la
 * transacción Trn. `conBypassPlataforma` deja pasar libre al staff de
 * plataforma (flujo web autenticado); el bot de WhatsApp siempre valida como
 * residente.
 */
async function armarDatosTrn(
  ctx: QueryCtx,
  user: Doc<"users">,
  facturaId: Id<"facturas">,
  conBypassPlataforma: boolean,
) {
  const factura = await ctx.db.get(facturaId);
  if (!factura) throw new Error("Factura no encontrada.");

  const condominio = await ctx.db.get(factura.condominioId);
  if (!condominio) throw new Error("Condominio no encontrado.");

  /* La unidad hace falta para la referencia que ve el banco: sin ella el
   * recaudo vuelve identificado solo por un consecutivo contable. */
  const unidad = await ctx.db.get(factura.unidadId);

  // Autorización: staff de plataforma pasa libre (si aplica); si no, debe
  // estar vinculado a la unidad de la factura en este condominio.
  const esPlataforma =
    conBypassPlataforma &&
    (user.platformRole === "superadmin" || user.platformRole === "admin");

  let membership: Doc<"memberships"> | null = null;
  if (!esPlataforma) {
    membership = await ctx.db
      .query("memberships")
      .withIndex("by_condominio_user", (q) =>
        q.eq("condominioId", factura.condominioId).eq("userId", user._id),
      )
      .unique();
    if (!membership || !membership.isActive) {
      throw new Error("No pertenece a este condominio.");
    }
    const link = await ctx.db
      .query("usuarioUnidad")
      .withIndex("by_membership", (q) => q.eq("membershipId", membership!._id))
      .filter((q) => q.eq(q.field("unidadId"), factura.unidadId))
      .first();
    if (!link) {
      throw new Error("Esta factura no corresponde a una de sus unidades.");
    }
  }

  if (factura.estado === "pagada") {
    throw new Error("Esta factura ya está pagada.");
  }

  // Monto a pagar: aplica descuento si aún estamos dentro del plazo con descuento.
  const conDescuentoVigente =
    typeof factura.totalConDescuento === "number" &&
    Date.now() <= factura.fechaVencimiento;
  const monto = conDescuentoVigente
    ? factura.totalConDescuento!
    : factura.totalAPagar;

  return {
    factura: {
      _id: factura._id,
      condominioId: factura.condominioId,
      unidadId: factura.unidadId,
      membershipId: factura.membershipId,
      numeroInterno: factura.numeroInterno,
      numeroFactura: factura.numeroFactura,
      periodoLabel: factura.periodoLabel,
      periodo: factura.periodo,
    },
    unidad: {
      torre: unidad?.torre ?? null,
      numero: unidad?.numero ?? factura.apto ?? "",
    },
    monto: Math.round(monto),
    condominioNombre: condominio.name,
    avalNura: condominio.avalNura ?? null,
    logoUrl: condominio.logo ?? "",
    user: {
      _id: user._id,
      firstName: user.firstName ?? user.name?.split(" ")[0] ?? "",
      lastName:
        user.lastName ??
        user.name?.split(" ").slice(1).join(" ") ??
        "",
      fullName: user.name ?? "",
      email: user.email ?? "",
      telefono: user.telefono ?? "",
      govType: mapGovType(user.tipoDocumento),
      identNum: user.numeroDocumento ?? "0",
    },
    membershipId: membership?._id,
  };
}

/**
 * Crea una transacción con un monto y un titular arbitrarios, sin factura.
 *
 * Existe por el set de pruebas del banco, que exige un pago de 300 millones y
 * otro de 6 mil millones. Ninguna cuota de administración se acerca a eso, y
 * el flujo normal solo sabe cobrar el valor exacto de una factura: sin esto
 * habría que inventar facturas falsas en la base de producción para poder
 * certificar, y luego acordarse de borrarlas.
 *
 * No toca `facturas` ni `pagos`: nace y muere en la pasarela. Lo único que
 * deja es lo que el banco necesita ver.
 *
 * Se niega en producción. Es una herramienta de certificación, y en
 * producción crearía un cobro real que no le corresponde a nadie.
 */
export const crearTrnCertificacion = internalAction({
  args: {
    monto: v.number(),
    tipoPersona: v.union(v.literal("natural"), v.literal("juridica")),
    documento: v.optional(v.string()),
    nombre: v.optional(v.string()),
    email: v.optional(v.string()),
    referencia: v.optional(v.string()),
    /** Convenio con que se certifica (ej "30830"). Sin él, el de QA global. */
    nura: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const cfg = avalConfig(args.nura);
    if (cfg.ambiente === "prod") {
      throw new Error(
        "crearTrnCertificacion no se ejecuta en producción: crearía un cobro real sin dueño.",
      );
    }
    if (!Number.isInteger(args.monto) || args.monto <= 0) {
      throw new Error("El monto debe ser un entero positivo de pesos.");
    }

    const juridica = args.tipoPersona === "juridica";
    /* Persona jurídica paga con NIT; natural con cédula. El banco pide un
     * caso de cada una, y la pasarela decide el formulario de PSE por este
     * par de campos. */
    const govType = juridica ? "NIT" : "CC";
    const documento = args.documento ?? (juridica ? "9001234567" : "1098526415");
    const nombre =
      args.nombre ?? (juridica ? "Certificacion Juridica SAS" : "Certificacion Natural");
    /* Referencia distinta en cada corrida.
     *
     * Con una fija, el segundo caso del set de pruebas choca con el primero:
     * la pasarela responde 27 ("transacción PENDIENTE para esta referencia")
     * hasta que la anterior expire, y certificar los siete casos tomaría toda
     * una tarde de esperas. Se puede fijar a mano con `referencia` cuando lo
     * que se quiera enseñar sea justamente el número de casa. */
    const referencia = args.referencia ?? String(Date.now()).slice(-9);

    const rqUID = generarRqUID();
    const site = convexSiteUrl();
    const portalUrl = site ? `${site}/aval/retorno` : `${webAppUrl()}/pago/retorno`;
    const token = await obtenerToken(ctx, cfg);
    const headers = avalHeaders(cfg, token, rqUID, govType, documento, "127.0.0.1");

    const partes = nombre.split(" ");
    const body = {
      Agreement: { AgrmId: cfg.agrmId },
      SecretList: [
        { SecretId: "user", Secret: cfg.secretUser },
        { SecretId: "password", Secret: cfg.secretPassword },
      ],
      Fee: { CurAmt: { Amt: String(args.monto), CurCode: "COP" } },
      TaxPmtInfo: { CurAmt: { Amt: "0", CurCode: "COP" } },
      InvoicePmtInfo: {
        InvoiceInfo: {
          InvoiceType: "1",
          InvoiceNum: referencia,
          Desc: `Certificacion ${juridica ? "persona juridica" : "persona natural"} - ${args.monto} COP`.slice(0, 150),
          NIE: [referencia],
          InvoiceSender: { Category: "0" },
        },
        PmtStatus: { PmtMethod: "2" },
      },
      RefInfo: [
        { RefId: "PortalURL", RefType: portalUrl },
        { RefId: "Template", RefType: "0" },
        { RefId: "TokenizedData", RefType: "0" },
      ],
      TrnSrcInfo: { TrnSrc: cfg.trnSrc },
      CustInfo: {
        PersonInfo: {
          PersonName: {
            FirstName: partes[0] ?? "Certificacion",
            LastName: partes.slice(1).join(" ") || "-",
            FullName: nombre,
          },
          ContactInfo: {
            EmailAddr: args.email ?? "certificacion@vekino.com",
            PhoneNum: { Phone: "3163801625" },
          },
        },
      },
    };

    const res = await avalRequest(ctx, cfg, {
      url: `${cfg.endpoint}/payment/Payments_Trn/Trn`,
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    let json: any;
    try {
      json = JSON.parse(res.text);
    } catch {
      throw new Error(`Trn: respuesta no-JSON (HTTP ${res.status}): ${res.text.slice(0, 200)}`);
    }
    const estado = json?.InvoicePmtInfo?.PmtStatus;
    const url = (json?.RefInfo ?? []).find(
      (r: { RefId?: string }) => r.RefId === "URL",
    )?.RefType;
    if (!estado?.PmtAuthId || !url) {
      throw new Error(
        `La pasarela no devolvió transacción: ${JSON.stringify(json?.MsgRsHdr?.Status ?? json)}`,
      );
    }

    return {
      pmtAuthId: estado.PmtAuthId as string,
      agrmId: cfg.agrmId,
      referencia,
      monto: args.monto,
      tipoPersona: args.tipoPersona,
      govType,
      documento,
      urlPasarela: url as string,
      urlRetorno: portalUrl,
      rqUID,
    };
  },
});

/**
 * Lo que el banco valida de una transacción, en un solo bloque.
 *
 * Consulta BasicData en vivo: la evidencia debe salir de la pasarela, no de
 * nuestra copia, que es justamente lo que ellos quieren comprobar.
 */
export const evidenciaCertificacion = internalAction({
  args: {
    pmtAuthId: v.string(),
    /** El mismo `nura` con que se creó en crearTrnCertificacion. */
    nura: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const cfg = avalConfig(args.nura);
    const token = await obtenerToken(ctx, cfg);
    const headers = avalHeaders(
      cfg,
      token,
      generarRqUID(),
      "GUEST",
      "0",
      "127.0.0.1",
    );
    const res = await avalRequest(ctx, cfg, {
      url: `${cfg.endpoint}/payment/Payments_BasicData/BasicData/${args.pmtAuthId}`,
      method: "GET",
      headers,
    });
    let json: any;
    try {
      json = JSON.parse(res.text);
    } catch {
      throw new Error(`BasicData: respuesta no-JSON (HTTP ${res.status}): ${res.text.slice(0, 200)}`);
    }
    const info = json?.InvoicePmtInfo?.InvoiceInfo ?? {};
    const st = json?.InvoicePmtInfo?.PmtStatus ?? {};
    return {
      pmtAuthId: args.pmtAuthId,
      referencia: info.InvoiceNum ?? null,
      descripcion: info.Desc ?? null,
      monto: json?.Fee?.CurAmt?.Amt ?? null,
      statusCode: st.StatusCode ?? null,
      statusDesc: st.StatusDesc ?? null,
      estadoLegible: mapStatusCode(String(st.StatusCode ?? "")),
      medioPago: st.PmtMethodDesc ?? st.PmtMethod ?? null,
      banco: st.BankName ?? null,
      approvalId: st.ApprovalId ?? null,
      fecha: st.EffDt ?? null,
      crudo: json,
    };
  },
});

/**
 * Valida que el usuario autenticado puede pagar la factura y devuelve todos
 * los datos necesarios para armar la transacción Trn.
 */
export const datosParaTrn = internalQuery({
  args: { facturaId: v.id("facturas") },
  handler: async (ctx, args) => {
    const user = await requireAppUser(ctx);
    return await armarDatosTrn(ctx, user, args.facturaId, true);
  },
});

/**
 * Variante para el bot de WhatsApp: mismos datos y validaciones que
 * datosParaTrn, pero partiendo del usuario cargado por id (el bot ya lo
 * identificó por teléfono). Sin bypass de plataforma: el bot siempre actúa en
 * nombre de un residente.
 */
export const datosParaTrnDeUsuario = internalQuery({
  args: { facturaId: v.id("facturas"), userId: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) throw new Error("Usuario no encontrado.");
    if (!user.active) throw new Error("Usuario inactivo.");
    return await armarDatosTrn(ctx, user, args.facturaId, false);
  },
});

/** Inserta el registro de pago (estado inicial). */
export const registrarPago = internalMutation({
  args: {
    condominioId: v.id("condominios"),
    unidadId: v.id("unidades"),
    facturaId: v.id("facturas"),
    membershipId: v.optional(v.id("memberships")),
    userId: v.optional(v.id("users")),
    rqUID: v.string(),
    pmtAuthId: v.optional(v.string()),
    invoiceNum: v.string(),
    /** Nura del convenio con que se creó: la consulta usa el mismo. */
    agrmId: v.optional(v.string()),
    monto: v.number(),
    estado: v.union(
      v.literal("iniciada"),
      v.literal("error"),
    ),
    redirectUrl: v.optional(v.string()),
    ambiente: v.string(),
    trnRaw: v.optional(v.any()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    return await ctx.db.insert("pagos", {
      condominioId: args.condominioId,
      unidadId: args.unidadId,
      facturaId: args.facturaId,
      membershipId: args.membershipId,
      userId: args.userId,
      rqUID: args.rqUID,
      pmtAuthId: args.pmtAuthId,
      invoiceNum: args.invoiceNum,
      agrmId: args.agrmId,
      monto: args.monto,
      moneda: "COP",
      estado: args.estado,
      redirectUrl: args.redirectUrl,
      ambiente: args.ambiente,
      trnRaw: args.trnRaw,
      error: args.error,
      intentosConsulta: 0,
      createdAt: now,
      updatedAt: now,
    });
  },
});

/** Aplica el estado consultado a la pasarela; si aprueba, marca la factura pagada. */
export const aplicarEstado = internalMutation({
  args: {
    pagoId: v.id("pagos"),
    estado: v.union(
      v.literal("pendiente"),
      v.literal("aprobada"),
      v.literal("rechazada"),
      v.literal("fallida"),
      v.literal("expirada"),
      v.literal("no_autorizada"),
    ),
    statusCodeAval: v.optional(v.string()),
    medioPago: v.optional(v.string()),
    banco: v.optional(v.string()),
    approvalId: v.optional(v.string()),
    fechaPago: v.optional(v.number()),
    basicDataRaw: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const pago = await ctx.db.get(args.pagoId);
    if (!pago) throw new Error("Pago no encontrado.");

    const now = Date.now();
    await ctx.db.patch(args.pagoId, {
      estado: args.estado,
      statusCodeAval: args.statusCodeAval,
      medioPago: args.medioPago,
      banco: args.banco,
      approvalId: args.approvalId,
      fechaPago: args.fechaPago,
      basicDataRaw: args.basicDataRaw,
      intentosConsulta: pago.intentosConsulta + 1,
      updatedAt: now,
    });

    // Reflejo en la factura: al aprobar el pago, la factura queda pagada al instante.
    if (args.estado === "aprobada") {
      const factura = await ctx.db.get(pago.facturaId);
      if (factura && factura.estado !== "pagada") {
        await ctx.db.patch(pago.facturaId, {
          estado: "pagada",
          updatedAt: now,
        });
      }

      // Aviso por WhatsApp: solo en la transición a aprobada (no si ya lo estaba).
      if (pago.estado !== "aprobada") {
        await ctx.scheduler.runAfter(0, internal.whatsappNotifs.pagoAprobado, {
          pagoId: args.pagoId,
        });
      }
    }
  },
});

/** Incrementa el contador de intentos cuando la consulta falla (para el backoff). */
export const marcarIntentoConsulta = internalMutation({
  args: { pagoId: v.id("pagos") },
  handler: async (ctx, args) => {
    const pago = await ctx.db.get(args.pagoId);
    if (!pago) return;
    await ctx.db.patch(args.pagoId, {
      intentosConsulta: pago.intentosConsulta + 1,
      updatedAt: Date.now(),
    });
  },
});

export const getPagoInterno = internalQuery({
  args: { pagoId: v.id("pagos") },
  handler: async (ctx, args) => await ctx.db.get(args.pagoId),
});

export const getPagoPorPmt = internalQuery({
  args: { pmtId: v.string() },
  handler: async (ctx, args) =>
    await ctx.db
      .query("pagos")
      .withIndex("by_pmtAuthId", (q) => q.eq("pmtAuthId", args.pmtId))
      .first(),
});

// ─────────────────────────────────────────────────────────────
// Acciones (HTTP externo hacia Aval)
// ─────────────────────────────────────────────────────────────

/**
 * Cada cuánto se consulta el estado. Lo fija Aval, no nosotros: la
 * especificación (4.1.3.1) dice "consultar cada 2 minutos hasta obtener un
 * estado final".
 */
const INTERVALO_CONSULTA_MS = 2 * 60 * 1000;

/**
 * Cuántas veces se consulta antes de rendirse.
 *
 * Estaba en 10 —veinte minutos— y la especificación de Aval (4.1.3.3) dice
 * que la pasarela tarda "un tiempo estimado de 50 minutos" en resolver una
 * transacción pendiente, porque puede quedar esperando al banco, a ACH o a
 * Redeban.
 *
 * Con veinte minutos, un pago que el banco confirmara al minuto 35 quedaba
 * pendiente para siempre: el residente pagaba y la factura seguía debiendo.
 * No hay webhook que lo rescate —Aval no notifica, hay que preguntar—, así
 * que la ventana de consulta ES el único mecanismo.
 *
 * Treinta intentos son sesenta minutos: los cincuenta del peor caso más un
 * margen. Preguntar de más cuesta una llamada HTTP; preguntar de menos
 * cuesta un pago perdido.
 */
const MAX_INTENTOS = 30;

/**
 * Flujo compartido de creación del pago (web y bot de WhatsApp) a partir de
 * los datos ya validados: token oauth2 → Payments_Trn → registrarPago →
 * agenda consultarEstado como red de seguridad.
 */
async function crearTrnYRegistrar(
  ctx: ActionCtx,
  datos: Awaited<ReturnType<typeof armarDatosTrn>>,
  ipAddr: string,
): Promise<{ pagoId: Id<"pagos">; redirectUrl: string }> {
  const cfg = avalConfig(datos.avalNura);

  const rqUID = generarRqUID();
  /* La referencia que vera el banco: casa + periodo, legible de un vistazo.
   * Si por lo que sea no se puede armar (una unidad sin numero, un periodo
   * raro), cae al consecutivo contable de siempre: es feo pero es unico, y
   * quedarse sin referencia seria quedarse sin pago. */
  /* La referencia que vera el banco: el numero de la casa, lo mismo que pide
   * el portal publico del convenio. Si la unidad no da un numero utilizable,
   * cae al consecutivo contable de siempre: es feo pero es unico, y quedarse
   * sin referencia seria quedarse sin pago. */
  const invoiceNum =
    referenciaPago({ torre: datos.unidad.torre, numero: datos.unidad.numero }) ??
    datos.factura.numeroInterno ??
    datos.factura.numeroFactura;

  // URL de retorno: httpAction de Convex (.site). Aval le concatena ?pmtId=...
  const site = convexSiteUrl();
  const portalUrl = site ? `${site}/aval/retorno` : `${webAppUrl()}/pago/retorno`;

  try {
    const token = await obtenerToken(ctx, cfg);

    const headers = avalHeaders(
      cfg,
      token,
      rqUID,
      datos.user.govType,
      datos.user.identNum,
      ipAddr,
    );

    const body = {
      Agreement: { AgrmId: cfg.agrmId },
      SecretList: [
        { SecretId: "user", Secret: cfg.secretUser },
        { SecretId: "password", Secret: cfg.secretPassword },
      ],
      Fee: { CurAmt: { Amt: String(datos.monto), CurCode: "COP" } },
      TaxPmtInfo: { CurAmt: { Amt: "0", CurCode: "COP" } },
      InvoicePmtInfo: {
        InvoiceInfo: {
          InvoiceType: "1",
          InvoiceNum: invoiceNum,
          Desc: `${etiquetaUnidad(datos.unidad.torre, datos.unidad.numero)} - Administracion ${datos.factura.periodoLabel} - ${datos.condominioNombre}`.slice(0, 150),
          NIE: [invoiceNum],
          InvoiceSender: { Category: "0" },
        },
        PmtStatus: { PmtMethod: "2" },
      },
      RefInfo: [
        { RefId: "PortalURL", RefType: portalUrl },
        { RefId: "LogoURL", RefType: datos.logoUrl },
        { RefId: "Template", RefType: "0" },
        { RefId: "TokenizedData", RefType: "0" },
      ],
      TrnSrcInfo: { TrnSrc: cfg.trnSrc },
      CustInfo: {
        PersonInfo: {
          PersonName: {
            FirstName: datos.user.firstName || datos.factura.periodoLabel,
            LastName: datos.user.lastName || "-",
            FullName: datos.user.fullName,
          },
          ContactInfo: {
            EmailAddr: datos.user.email,
            PhoneNum: { Phone: datos.user.telefono },
          },
        },
      },
    };

    const res = await avalRequest(ctx, cfg, {
      url: `${cfg.endpoint}/payment/Payments_Trn/Trn`,
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    let json: any;
    try {
      json = JSON.parse(res.text);
    } catch {
      throw new Error(`Trn: respuesta no-JSON (HTTP ${res.status}): ${res.text.slice(0, 300)}`);
    }

    // Error de negocio de Aval
    const errDesc = json?.MsgRsHdr?.Status?.StatusDesc;
    const pmtAuthId = json?.InvoicePmtInfo?.PmtStatus?.PmtAuthId;
    const urlRef = Array.isArray(json?.RefInfo)
      ? json.RefInfo.find((r: any) => r.RefId === "URL")?.RefType
      : undefined;

    const resOk = res.status >= 200 && res.status < 300;
    if (!resOk || errDesc || !pmtAuthId || !urlRef) {
      const msg = errDesc ?? `HTTP ${res.status}`;
      const pagoId = await ctx.runMutation(internal.pagos.registrarPago, {
        condominioId: datos.factura.condominioId,
        unidadId: datos.factura.unidadId,
        facturaId: datos.factura._id,
        membershipId: datos.membershipId,
        userId: datos.user._id,
        rqUID,
        invoiceNum,
        agrmId: cfg.agrmId,
        monto: datos.monto,
        estado: "error",
        ambiente: cfg.ambiente,
        trnRaw: json,
        error: String(msg),
      });
      throw new Error(`No se pudo crear el pago en la pasarela: ${msg} (pagoId ${pagoId})`);
    }

    const pagoId = await ctx.runMutation(internal.pagos.registrarPago, {
      condominioId: datos.factura.condominioId,
      unidadId: datos.factura.unidadId,
      facturaId: datos.factura._id,
      membershipId: datos.membershipId,
      userId: datos.user._id,
      rqUID,
      pmtAuthId: String(pmtAuthId),
      invoiceNum,
      agrmId: cfg.agrmId,
      monto: datos.monto,
      estado: "iniciada",
      redirectUrl: urlRef,
      ambiente: cfg.ambiente,
      trnRaw: json,
    });

    // Red de seguridad: consulta el estado aunque el usuario no vuelva.
    await ctx.scheduler.runAfter(
      INTERVALO_CONSULTA_MS,
      internal.pagos.consultarEstado,
      { pagoId },
    );

    return { pagoId, redirectUrl: urlRef as string };
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("No se pudo crear el pago")) {
      throw e;
    }
    // Falla de red/token: deja rastro y propaga.
    await ctx.runMutation(internal.pagos.registrarPago, {
      condominioId: datos.factura.condominioId,
      unidadId: datos.factura.unidadId,
      facturaId: datos.factura._id,
      membershipId: datos.membershipId,
      userId: datos.user._id,
      rqUID,
      invoiceNum,
      agrmId: cfg.agrmId,
      monto: datos.monto,
      estado: "error",
      ambiente: cfg.ambiente,
      error: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }
}

/**
 * Crea la transacción en la pasarela Aval para una factura y devuelve la URL a
 * la que se debe redirigir al usuario. Llamada por el propietario desde la web.
 */
export const crearPagoFactura = action({
  args: {
    facturaId: v.id("facturas"),
    ipAddr: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ pagoId: Id<"pagos">; redirectUrl: string }> => {
    const datos = await ctx.runQuery(internal.pagos.datosParaTrn, {
      facturaId: args.facturaId,
    });
    return await crearTrnYRegistrar(ctx, datos, args.ipAddr ?? "127.0.0.1");
  },
});

/**
 * Variante para el bot de WhatsApp: crea la transacción para un usuario ya
 * identificado por teléfono (sin ctx.auth) y devuelve el enlace de pago para
 * enviarlo al chat. Los errores llevan mensaje en español porque el bot los
 * muestra tal cual al usuario.
 */
export const crearPagoFacturaBot = internalAction({
  args: {
    facturaId: v.id("facturas"),
    userId: v.id("users"),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ pagoId: Id<"pagos">; redirectUrl: string }> => {
    const datos = await ctx.runQuery(internal.pagos.datosParaTrnDeUsuario, {
      facturaId: args.facturaId,
      userId: args.userId,
    });
    return await crearTrnYRegistrar(ctx, datos, "127.0.0.1");
  },
});

/**
 * Consulta el estado de una transacción en la pasarela (BasicData) y lo aplica.
 * Reagenda automáticamente cada 2 min mientras siga pendiente (hasta MAX_INTENTOS).
 */
export const consultarEstado = internalAction({
  args: { pagoId: v.id("pagos") },
  handler: async (ctx, args): Promise<Doc<"pagos">["estado"] | null> => {
    const pago = await ctx.runQuery(internal.pagos.getPagoInterno, {
      pagoId: args.pagoId,
    });
    if (!pago || !pago.pmtAuthId) return null;
    /* BasicData se consulta con la llave del convenio que creó la
     * transacción. Los pagos de antes de guardar el convenio son de QA. */
    const cfg = avalConfig(pago.agrmId);

    // Ya está en estado final: nada que hacer.
    if (["aprobada", "rechazada", "fallida", "expirada", "no_autorizada"].includes(pago.estado)) {
      return pago.estado;
    }

    try {
      const token = await obtenerToken(ctx, cfg);
      const rqUID = generarRqUID();
      const headers = avalHeaders(cfg, token, rqUID, "GUEST", "0", "127.0.0.1");

      const res = await avalRequest(ctx, cfg, {
        url: `${cfg.endpoint}/payment/Payments_BasicData/BasicData/${pago.pmtAuthId}`,
        method: "GET",
        headers,
      });
      let json: any;
      try {
        json = JSON.parse(res.text);
      } catch {
        throw new Error(`BasicData: respuesta no-JSON (HTTP ${res.status})`);
      }

      const pmtStatus = json?.InvoicePmtInfo?.PmtStatus;
      const statusCode: string | undefined = pmtStatus?.StatusCode;

      // Respuesta de error (pmtid inválido, etc.): reintenta si aún hay margen.
      if (!statusCode) {
        await ctx.runMutation(internal.pagos.marcarIntentoConsulta, {
          pagoId: args.pagoId,
        });
        await reagendarSiProcede(ctx, args.pagoId, pago.intentosConsulta + 1);
        return pago.estado;
      }

      const estado = mapStatusCode(statusCode);
      const medioPago = Array.isArray(pmtStatus?.PmtInfo)
        ? pmtStatus.PmtInfo[0]?.PmtInfoType
        : undefined;
      const banco = Array.isArray(json?.RefInfo)
        ? json.RefInfo.find((r: any) => r.RefId === "BankName")?.RefType
        : undefined;
      const approvalId = res.headers["x-approvalid"] ?? undefined;
      const effDt: string | undefined = pmtStatus?.EffDt;
      const fechaPago = effDt ? Date.parse(effDt.replace(" ", "T")) : undefined;

      await ctx.runMutation(internal.pagos.aplicarEstado, {
        pagoId: args.pagoId,
        estado,
        statusCodeAval: String(statusCode),
        medioPago,
        banco,
        approvalId: approvalId && approvalId !== "0" ? approvalId : undefined,
        fechaPago: Number.isNaN(fechaPago) ? undefined : fechaPago,
        basicDataRaw: json,
      });

      // Si sigue pendiente, reagenda otra consulta.
      if (estado === "pendiente") {
        await reagendarSiProcede(ctx, args.pagoId, pago.intentosConsulta + 1);
      }
      return estado;
    } catch (e) {
      await ctx.runMutation(internal.pagos.marcarIntentoConsulta, {
        pagoId: args.pagoId,
      });
      await reagendarSiProcede(ctx, args.pagoId, pago.intentosConsulta + 1);
      return pago.estado;
    }
  },
});

async function reagendarSiProcede(
  ctx: { scheduler: { runAfter: (ms: number, fn: any, args: any) => Promise<unknown> } },
  pagoId: Id<"pagos">,
  intentos: number,
): Promise<void> {
  if (intentos >= MAX_INTENTOS) return;
  await ctx.scheduler.runAfter(
    INTERVALO_CONSULTA_MS,
    internal.pagos.consultarEstado,
    { pagoId },
  );
}

/** Consulta por pmtId (usada por el httpAction de retorno de Aval). */
export const consultarEstadoPorPmt = internalAction({
  args: { pmtId: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{ condominioId: Id<"condominios">; pagoId: Id<"pagos"> } | null> => {
    const pago = await ctx.runQuery(internal.pagos.getPagoPorPmt, {
      pmtId: args.pmtId,
    });
    if (!pago) return null;
    await ctx.runAction(internal.pagos.consultarEstado, { pagoId: pago._id });
    return { condominioId: pago.condominioId, pagoId: pago._id };
  },
});

// ─────────────────────────────────────────────────────────────
// API pública para la UI
// ─────────────────────────────────────────────────────────────

/** Fuerza una consulta inmediata del estado (botón "Actualizar" del comprobante). */
export const verificarPago = action({
  args: { pagoId: v.id("pagos") },
  handler: async (ctx, args): Promise<Doc<"pagos"> | null> => {
    // La consulta interna valida existencia; la lectura pública valida acceso.
    await ctx.runAction(internal.pagos.consultarEstado, { pagoId: args.pagoId });
    return await ctx.runQuery(internal.pagos.getPagoInterno, {
      pagoId: args.pagoId,
    });
  },
});

/** Estado reactivo de un pago (para la pantalla de comprobante). Valida acceso. */
export const estadoPago = query({
  args: { pagoId: v.id("pagos") },
  handler: async (ctx, args) => {
    const user = await requireAppUser(ctx);
    const pago = await ctx.db.get(args.pagoId);
    if (!pago) return null;

    const esPlataforma =
      user.platformRole === "superadmin" || user.platformRole === "admin";
    if (!esPlataforma && pago.userId && pago.userId !== user._id) {
      // Permitir también a cualquier miembro vinculado a la unidad de la factura.
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_condominio_user", (q) =>
          q.eq("condominioId", pago.condominioId).eq("userId", user._id),
        )
        .unique();
      const link = membership
        ? await ctx.db
            .query("usuarioUnidad")
            .withIndex("by_membership", (q) => q.eq("membershipId", membership._id))
            .filter((q) => q.eq(q.field("unidadId"), pago.unidadId))
            .first()
        : null;
      if (!link) throw new Error("No autorizado para ver este pago.");
    }

    return {
      _id: pago._id,
      estado: pago.estado,
      statusCodeAval: pago.statusCodeAval,
      monto: pago.monto,
      medioPago: pago.medioPago,
      banco: pago.banco,
      pmtAuthId: pago.pmtAuthId,
      facturaId: pago.facturaId,
      condominioId: pago.condominioId,
      fechaPago: pago.fechaPago,
      error: pago.error,
    };
  },
});

/** Estado de un pago a partir del pmtId de Aval (pantalla de retorno). */
export const estadoPagoPorPmt = query({
  args: { pmtId: v.string() },
  handler: async (ctx, args) => {
    const user = await requireAppUser(ctx);
    const pago = await ctx.db
      .query("pagos")
      .withIndex("by_pmtAuthId", (q) => q.eq("pmtAuthId", args.pmtId))
      .first();
    if (!pago) return null;

    const esPlataforma =
      user.platformRole === "superadmin" || user.platformRole === "admin";
    if (!esPlataforma && pago.userId && pago.userId !== user._id) {
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_condominio_user", (q) =>
          q.eq("condominioId", pago.condominioId).eq("userId", user._id),
        )
        .unique();
      const link = membership
        ? await ctx.db
            .query("usuarioUnidad")
            .withIndex("by_membership", (q) => q.eq("membershipId", membership._id))
            .filter((q) => q.eq(q.field("unidadId"), pago.unidadId))
            .first()
        : null;
      if (!link) return null;
    }

    return {
      _id: pago._id,
      estado: pago.estado,
      monto: pago.monto,
      medioPago: pago.medioPago,
      banco: pago.banco,
      condominioId: pago.condominioId,
      facturaId: pago.facturaId,
      fechaPago: pago.fechaPago,
    };
  },
});

/** Historial de pagos de una factura (para la UI del propietario/admin). */
export const listPorFactura = query({
  args: { facturaId: v.id("facturas") },
  handler: async (ctx, args) => {
    await requireAppUser(ctx);
    return await ctx.db
      .query("pagos")
      .withIndex("by_factura", (q) => q.eq("facturaId", args.facturaId))
      .order("desc")
      .collect();
  },
});
