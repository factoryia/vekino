import { v } from "convex/values";
import { action, query, mutation, internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import {
  MENSAJE_COMPROBANTE_URL,
  bucketPublico,
  carpetaComprobantes,
  esUrlDeComprobante,
  exigirArchivoComprobante,
  tipoPorContenido,
  vTipoComprobante,
} from "./lib/comprobantes";
import { exigirArchivoSubido } from "./model/registroArchivos";
import {
  requireCondominioRole,
  requireAppUser,
  getCurrentAppUser,
  misUnidadIds,
} from "./model/authz";
import {
  carteraDeUnidad,
  estadoVisibleDeFactura,
  facturaVigente,
  formatoPesos,
  montoAPagarHoy,
} from "./lib/cartera";
import { recalcularCadena } from "./model/estadoFactura";

/**
 * Comprobantes de pago subidos por propietarios (foto/PDF, normalmente vía
 * WhatsApp). Flujo: llega → "pendiente_revision" → la administración lo
 * aprueba o lo rechaza.
 *
 * Este canal es paralelo a la pasarela Aval y NUNCA toca la tabla `pagos`
 * (esa es exclusiva de la pasarela).
 *
 * ── Fase 3 ───────────────────────────────────────────────────────────────
 *   · Un comprobante dice CUÁNTO y CUÁNDO se pagó (`monto`, `fechaPago`): lo
 *     declara el residente y lo confirma la administración al aprobar.
 *   · Aprobarlo es EVIDENCIA de pago por ese monto: la factura queda pagada o
 *     abonada según lo que se debía (`lib/estadoFactura.ts`), no "pagada" a
 *     secas. Sin factura vinculada queda registrado y no cambia ningún estado.
 *   · Solo se adjunta a la factura VIGENTE de la unidad: el saldo de una
 *     histórica ya va dentro de la más reciente.
 */

const ADMIN_ROLES = ["administrador", "contadora", "junta_directiva"] as const;

/**
 * Lo que se responde a quien adjunta un comprobante a una factura que ya no
 * es la vigente. Estable a propósito: la app lo muestra tal cual.
 */
export const MENSAJE_COMPROBANTE_HISTORICA =
  "Ese comprobante debe ir con la factura vigente de la unidad: el saldo de esa factura ya quedó incluido en la más reciente.";

/** Un pago declarado no puede ser de mañana (con un día de holgura por la zona horaria). */
const HOLGURA_FECHA_MS = 24 * 60 * 60 * 1000;

function validarMontoYFecha(monto: number | undefined, fechaPago: number | undefined) {
  if (monto !== undefined && (!Number.isFinite(monto) || monto <= 0)) {
    throw new Error("El monto pagado debe ser mayor que cero.");
  }
  if (
    fechaPago !== undefined &&
    (!Number.isFinite(fechaPago) || fechaPago <= 0 || fechaPago > Date.now() + HOLGURA_FECHA_MS)
  ) {
    throw new Error("La fecha del pago no es válida.");
  }
}

/**
 * Que la factura sea la vigente de su unidad (la del período más reciente).
 * Lanza el mensaje estable si es histórica.
 */
async function exigirVigente(ctx: QueryCtx | MutationCtx, factura: Doc<"facturas">) {
  const cadena = (
    await ctx.db
      .query("facturas")
      .withIndex("by_unidad", (q) => q.eq("unidadId", factura.unidadId))
      .collect()
  ).filter((f) => f.condominioId === factura.condominioId);
  if (cadena.some((f) => f.periodo.localeCompare(factura.periodo) > 0)) {
    throw new Error(MENSAJE_COMPROBANTE_HISTORICA);
  }
}

/** El bot registra un comprobante recibido por WhatsApp. */
export const crearDesdeBot = internalMutation({
  args: {
    condominioId: v.id("condominios"),
    unidadId: v.optional(v.id("unidades")),
    facturaId: v.optional(v.id("facturas")),
    userId: v.optional(v.id("users")),
    telefono: v.optional(v.string()),
    url: v.string(),
    mimeType: v.optional(v.string()),
    nota: v.optional(v.string()),
    monto: v.optional(v.number()),
    fechaPago: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    validarMontoYFecha(args.monto, args.fechaPago);
    let unidadId = args.unidadId;
    if (args.facturaId) {
      const factura = await ctx.db.get(args.facturaId);
      if (!factura || factura.condominioId !== args.condominioId) {
        throw new Error("Factura no encontrada.");
      }
      await exigirVigente(ctx, factura);
      unidadId = factura.unidadId;
    }
    return await ctx.db.insert("soportesPago", {
      ...args,
      ...(unidadId ? { unidadId } : {}),
      origen: "whatsapp",
      estado: "pendiente_revision",
      createdAt: Date.now(),
    });
  },
});

/**
 * El residente le dice al bot cuánto pagó, después de mandar la foto. Solo
 * sobre un comprobante suyo (mismo teléfono), sin revisar y sin monto.
 */
export const registrarMontoBot = internalMutation({
  args: {
    soporteId: v.id("soportesPago"),
    telefono: v.string(),
    monto: v.number(),
  },
  handler: async (ctx, args) => {
    validarMontoYFecha(args.monto, undefined);
    const soporte = await ctx.db.get(args.soporteId);
    if (!soporte || soporte.telefono !== args.telefono) {
      throw new Error("Comprobante no encontrado.");
    }
    if (soporte.estado !== "pendiente_revision") {
      throw new Error("El comprobante ya fue revisado.");
    }
    if (soporte.monto !== undefined) return args.soporteId;
    await ctx.db.patch(args.soporteId, { monto: args.monto });
    return args.soporteId;
  },
});

// ─────────────────────────────────────────────────────────────
// API del propietario: sube el comprobante desde la app y consulta
// en qué va la revisión. Canal manual mientras la pasarela Aval
// termina de quedar en producción.
// ─────────────────────────────────────────────────────────────

/**
 * Las reglas de un comprobante que el residente envía por su cuenta, por la
 * app (`crearMio`) o por la web (`enviarMio`), en el orden de siempre:
 * sesión → unidades vigentes → archivo → monto y fecha → factura suya →
 * vigente → ninguno en revisión. Lanza el mensaje estable de la primera que
 * falla.
 *
 * `validarArchivo` va donde `crearMio` siempre revisó la URL: así cada caso
 * responde lo mismo por las dos vías.
 */
async function validarComprobanteMio(
  ctx: QueryCtx | MutationCtx,
  args: {
    condominioId: Id<"condominios">;
    facturaId?: Id<"facturas">;
    monto?: number;
    fechaPago?: number;
  },
  validarArchivo: () => void,
): Promise<{ user: Doc<"users">; unidadId: Id<"unidades"> }> {
  const user = await requireAppUser(ctx);
  const unidadIds = await misUnidadIds(ctx, user._id, args.condominioId);
  if (unidadIds.size === 0) {
    throw new Error("No tienes unidades vinculadas en este condominio.");
  }
  validarArchivo();
  validarMontoYFecha(args.monto, args.fechaPago);

  // La factura (si se indicó) tiene que ser de una unidad suya, y la vigente.
  let unidadId = [...unidadIds][0]!;
  if (args.facturaId) {
    const factura = await ctx.db.get(args.facturaId);
    if (!factura || factura.condominioId !== args.condominioId) {
      throw new Error("Factura no encontrada.");
    }
    if (!unidadIds.has(factura.unidadId)) {
      throw new Error("Esa factura no pertenece a tu unidad.");
    }
    await exigirVigente(ctx, factura);
    unidadId = factura.unidadId;

    // Evita que se acumulen comprobantes duplicados sin revisar.
    const previos = await ctx.db
      .query("soportesPago")
      .withIndex("by_factura", (q) => q.eq("facturaId", args.facturaId))
      .collect();
    if (previos.some((s) => s.estado === "pendiente_revision")) {
      throw new Error(
        "Ya tienes un comprobante en revisión para esta factura.",
      );
    }
  }
  return { user, unidadId };
}

/**
 * Que la URL sea la de un archivo subido a la carpeta de comprobantes de ESE
 * conjunto, en el bucket de Vekino (`lib/comprobantes.ts`). Antes `crearMio`
 * aceptaba cualquier texto: la URL del comprobante de otro residente, o un
 * enlace externo que la administración abría al revisar.
 *
 * Sin `AWS_S3_BUCKET_NAME` no hay prefijo con qué comparar y esto no valida
 * nada; pero desde la Fase 4 de S3 el archivo tiene que salir además de una
 * subida validada de quien envía (`model/registroArchivos.ts`), así que una
 * URL de mentira tampoco entra sin bucket.
 */
function exigirUrlDeComprobante(url: string, condominioId: Id<"condominios">) {
  const destino = bucketPublico(process.env);
  if (destino && !esUrlDeComprobante(url, condominioId, destino)) {
    throw new Error(MENSAJE_COMPROBANTE_URL);
  }
}

/**
 * El propietario adjunta el comprobante de un pago que ya hizo.
 *
 * `monto` y `fechaPago` son opcionales solo para no romper las versiones de
 * la app que todavía no los piden; la app nueva los pide siempre, y la
 * administración los confirma al aprobar.
 *
 * La app sube el archivo antes (`files.generateUploadUrl` + PUT) y manda su
 * URL; la web usa `enviarMio`, que sube y registra en el backend.
 */
export const crearMio = mutation({
  args: {
    condominioId: v.id("condominios"),
    facturaId: v.optional(v.id("facturas")),
    url: v.string(),
    mimeType: v.optional(v.string()),
    nota: v.optional(v.string()),
    monto: v.optional(v.number()),
    fechaPago: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const url = args.url.trim();
    const { user, unidadId } = await validarComprobanteMio(ctx, args, () => {
      if (!url) throw new Error("Falta el archivo del comprobante.");
      exigirUrlDeComprobante(url, args.condominioId);
    });
    // Y el archivo sale de una subida validada suya (`model/registroArchivos.ts`).
    await exigirArchivoSubido(ctx, user._id, { url }, carpetaComprobantes(args.condominioId));

    return await ctx.db.insert("soportesPago", {
      condominioId: args.condominioId,
      unidadId,
      facturaId: args.facturaId,
      userId: user._id,
      origen: "app",
      url,
      mimeType: args.mimeType,
      nota: args.nota?.trim() || undefined,
      ...(args.monto !== undefined ? { monto: args.monto } : {}),
      ...(args.fechaPago !== undefined ? { fechaPago: args.fechaPago } : {}),
      estado: "pendiente_revision",
      createdAt: Date.now(),
    });
  },
});

/* ── El comprobante desde la web: el archivo llega al backend ───────────── */

const datosEnvioMio = {
  condominioId: v.id("condominios"),
  facturaId: v.id("facturas"),
  monto: v.number(),
  fechaPago: v.number(),
};

/** El archivo, revisado en la acción: tamaño y tipo por contenido. */
const archivoRevisado = v.object({
  bytes: v.number(),
  tipo: v.union(vTipoComprobante, v.null()),
});

/** Paso 1 de `enviarMio`: las reglas, antes de subir nada. */
export const validarEnvioMio = internalQuery({
  args: { ...datosEnvioMio, archivo: archivoRevisado },
  handler: async (ctx, args): Promise<null> => {
    await validarComprobanteMio(ctx, args, () => {
      exigirArchivoComprobante(args.archivo);
    });
    return null;
  },
});

/**
 * Paso 3 de `enviarMio`: registra el comprobante. Vuelve a correr las mismas
 * reglas: entre el paso 1 y este pudo entrar otro comprobante, cargarse una
 * factura nueva o vencerse el vínculo.
 */
export const registrarEnvioMio = internalMutation({
  args: {
    ...datosEnvioMio,
    archivo: archivoRevisado,
    url: v.string(),
    nota: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Id<"soportesPago">> => {
    let tipo: string | undefined;
    const { user, unidadId } = await validarComprobanteMio(ctx, args, () => {
      tipo = exigirArchivoComprobante(args.archivo);
      exigirUrlDeComprobante(args.url, args.condominioId);
    });
    return await ctx.db.insert("soportesPago", {
      condominioId: args.condominioId,
      unidadId,
      facturaId: args.facturaId,
      userId: user._id,
      origen: "web",
      url: args.url,
      mimeType: tipo,
      nota: args.nota?.trim() || undefined,
      monto: args.monto,
      fechaPago: args.fechaPago,
      estado: "pendiente_revision",
      createdAt: Date.now(),
    });
  },
});

/**
 * El residente envía desde la web el comprobante de un pago: el archivo y los
 * datos en una sola llamada. Todo pasa en el servidor:
 *
 *   1. las reglas de `crearMio` (las mismas, con sus mensajes) y el archivo:
 *      no vacío, hasta 10 MB y JPG, PNG, WebP o PDF según sus primeros bytes,
 *      no según lo que diga el navegador. Si algo falla, no se sube nada;
 *   2. el archivo al bucket, con la carpeta y la llave que decide el servidor
 *      y el `ContentType` detectado (`files.subirComprobante`, Node);
 *   3. el registro, que vuelve a validar las reglas;
 *   4. si el registro falla después de subir, se borra la llave que se creó
 *      en ESTA llamada, y ninguna otra.
 *
 * Es una acción del runtime de Convex, no Node, porque recibe el archivo:
 * aquí los argumentos llegan a 16 MiB, y en Node solo a 5 MiB. Por eso el
 * archivo pasa a la acción Node por el almacenamiento interno de Convex, que
 * se borra al terminar, salga bien o mal.
 *
 * La URL pública no la ve ni la elige el cliente: la arma el servidor. El
 * móvil sigue con `generateUploadUrl` + PUT + `crearMio`.
 */
export const enviarMio = action({
  args: {
    ...datosEnvioMio,
    nota: v.optional(v.string()),
    nombreArchivo: v.optional(v.string()),
    archivo: v.bytes(),
  },
  handler: async (ctx, args): Promise<Id<"soportesPago">> => {
    const { archivo: bytes, nombreArchivo, nota, ...datos } = args;
    const archivo = { bytes: bytes.byteLength, tipo: tipoPorContenido(bytes) };

    // 1. Las reglas y el archivo, antes de subir nada.
    await ctx.runQuery(internal.soportesPago.validarEnvioMio, { ...datos, archivo });
    const tipo = exigirArchivoComprobante(archivo);

    // 2. Al bucket. El archivo cruza a Node por el almacenamiento interno.
    const storageId = await ctx.storage.store(new Blob([bytes], { type: tipo }));
    try {
      const subido: { key: string; publicUrl: string } = await ctx.runAction(
        internal.files.subirComprobante,
        { storageId, condominioId: datos.condominioId, nombreArchivo, contentType: tipo },
      );
      try {
        // 3. El registro, con las reglas otra vez.
        return await ctx.runMutation(internal.soportesPago.registrarEnvioMio, {
          ...datos,
          archivo,
          url: subido.publicUrl,
          ...(nota !== undefined ? { nota } : {}),
        });
      } catch (e) {
        // 4. Solo la llave de esta llamada: nunca una que llegue de afuera.
        await ctx.runAction(internal.files.deleteObjectInternal, { key: subido.key });
        throw e;
      }
    } finally {
      await ctx.storage.delete(storageId);
    }
  },
});

/** Comprobantes que el propietario ha enviado, con el resultado de la revisión. */
export const listMios = query({
  args: { condominioId: v.id("condominios") },
  handler: async (ctx, args) => {
    const user = await getCurrentAppUser(ctx);
    if (!user) return [];
    const unidadIds = await misUnidadIds(ctx, user._id, args.condominioId);
    if (unidadIds.size === 0) return [];

    const soportes = await ctx.db
      .query("soportesPago")
      .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
      .order("desc")
      .take(200);

    // Suyos: los que subió él, o cualquiera atado a una unidad suya
    // (p. ej. el que mandó por WhatsApp desde otro teléfono de la familia).
    return soportes
      .filter(
        (s) =>
          s.userId === user._id ||
          (s.unidadId != null && unidadIds.has(s.unidadId)),
      )
      .map((s) => ({
        _id: s._id,
        facturaId: s.facturaId ?? null,
        url: s.url,
        mimeType: s.mimeType ?? null,
        nota: s.nota ?? null,
        monto: s.monto ?? null,
        fechaPago: s.fechaPago ?? null,
        estado: s.estado,
        notaRevision: s.notaRevision ?? null,
        revisadoAt: s.revisadoAt ?? null,
        createdAt: s.createdAt,
      }));
  },
});

/**
 * La factura vigente de una unidad (`lib/cartera.ts`, `facturaVigente`): la
 * del período más reciente, esté como esté. El bot y el agente la ofrecen
 * para pagar y le vinculan los comprobantes.
 *
 * Antes era "la primera sin pagar entre las 12 creadas más recientemente":
 * dependía del orden de carga —julio subido tarde le ganaba a septiembre— y,
 * con la vigente pagada, retrocedía hasta una factura vieja cuyo saldo ya iba
 * dentro de la pagada. Ahora, si la vigente está pagada o con saldo a favor,
 * se devuelve igual y quien llama responde "estás al día".
 *
 * `null` si la unidad no tiene facturas, o si tiene dos del período más
 * reciente (no se adivina cuál: nada que ofrecer hasta que se revise).
 */
export const facturaVigenteDeUnidad = internalQuery({
  args: { unidadId: v.id("unidades") },
  handler: async (ctx, args) => {
    const unidad = await ctx.db.get(args.unidadId);
    if (!unidad) return null;
    const cadena = (
      await ctx.db
        .query("facturas")
        .withIndex("by_unidad", (q) => q.eq("unidadId", args.unidadId))
        .collect()
    ).filter((f) => f.condominioId === unidad.condominioId);
    const vigente = facturaVigente(cadena);
    if (!vigente) return null;
    /* Lo que se le dice al residente: si la unidad está en mora, la vigente
     * es "vencida" aunque se guarde `pendiente` (QA de comprobantes, H2). */
    return {
      ...vigente,
      estadoVisible: estadoVisibleDeFactura(vigente, cadena, carteraDeUnidad(cadena, Date.now())),
    };
  },
});

/**
 * Las facturas viejas de la unidad que se muestran "Sin verificar" (Fase 4):
 * historicas que quedaron `pendiente` porque ninguna factura siguiente pudo
 * juzgarlas (falta el mes siguiente). El bot y el agente las nombran para no
 * dar a entender que se deben: lo que se debe hoy esta en la vigente.
 */
export const sinVerificarDeUnidad = internalQuery({
  args: { unidadId: v.id("unidades") },
  handler: async (ctx, args) => {
    const unidad = await ctx.db.get(args.unidadId);
    if (!unidad) return [];
    const cadena = (
      await ctx.db
        .query("facturas")
        .withIndex("by_unidad", (q) => q.eq("unidadId", args.unidadId))
        .collect()
    ).filter((f) => f.condominioId === unidad.condominioId);
    return cadena
      .filter((f) => estadoVisibleDeFactura(f, cadena) === "sin_verificar")
      .sort((a, b) => a.periodo.localeCompare(b.periodo))
      .map((f) => ({ periodo: f.periodo, periodoLabel: f.periodoLabel }));
  },
});

/** Listado para la pantalla de revisión de la administración. */
export const listByCondominio = query({
  args: {
    condominioId: v.id("condominios"),
    estado: v.optional(
      v.union(
        v.literal("pendiente_revision"),
        v.literal("aprobado"),
        v.literal("rechazado"),
      ),
    ),
  },
  handler: async (ctx, args) => {
    await requireCondominioRole(ctx, args.condominioId, [...ADMIN_ROLES]);

    const soportes = args.estado
      ? await ctx.db
          .query("soportesPago")
          .withIndex("by_condominio_estado", (q) =>
            q.eq("condominioId", args.condominioId).eq("estado", args.estado!),
          )
          .order("desc")
          .take(200)
      : await ctx.db
          .query("soportesPago")
          .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
          .order("desc")
          .take(200);

    const ahora = Date.now();
    return await Promise.all(
      soportes.map(async (s) => {
        const [unidad, factura, user] = await Promise.all([
          s.unidadId ? ctx.db.get(s.unidadId) : null,
          s.facturaId ? ctx.db.get(s.facturaId) : null,
          s.userId ? ctx.db.get(s.userId) : null,
        ]);
        return {
          ...s,
          unidadNumero: unidad?.numero ?? null,
          unidadTorre: unidad?.torre ?? null,
          facturaNumero: factura?.numeroFactura ?? null,
          facturaPeriodo: factura?.periodoLabel ?? null,
          facturaTotal: factura?.totalAPagar ?? null,
          facturaEstado: factura?.estado ?? null,
          /* Lo que se cobraba por la factura el día del pago declarado (con
           * descuento si cae en su plazo): el monto que la pantalla propone. */
          facturaAdeudado: factura ? montoAPagarHoy(factura, s.fechaPago ?? s.createdAt ?? ahora) : null,
          userNombre: user?.name ?? null,
        };
      }),
    );
  },
});

/** Conteo liviano para el badge del panel admin. */
export const countPendientes = query({
  args: { condominioId: v.id("condominios") },
  handler: async (ctx, args) => {
    await requireCondominioRole(ctx, args.condominioId, [...ADMIN_ROLES]);
    const pendientes = await ctx.db
      .query("soportesPago")
      .withIndex("by_condominio_estado", (q) =>
        q.eq("condominioId", args.condominioId).eq("estado", "pendiente_revision"),
      )
      .take(100);
    return pendientes.length;
  },
});

/** Vincula (o corrige) la factura a la que corresponde el comprobante. */
export const vincularFactura = mutation({
  args: {
    id: v.id("soportesPago"),
    facturaId: v.id("facturas"),
  },
  handler: async (ctx, args) => {
    const soporte = await ctx.db.get(args.id);
    if (!soporte) throw new Error("Comprobante no encontrado.");
    await requireCondominioRole(ctx, soporte.condominioId, [...ADMIN_ROLES]);

    const factura = await ctx.db.get(args.facturaId);
    if (!factura || factura.condominioId !== soporte.condominioId) {
      throw new Error("La factura no pertenece a este condominio.");
    }
    if (soporte.estado !== "pendiente_revision") {
      throw new Error("El comprobante ya fue revisado.");
    }

    await ctx.db.patch(args.id, {
      facturaId: args.facturaId,
      unidadId: factura.unidadId,
    });
    return args.id;
  },
});

/**
 * Aprueba el comprobante: es evidencia de pago por su monto.
 *
 * La pantalla de la administración pide el monto y la fecha del pago (los
 * que declaró el residente, corregidos si hace falta). Si no llegan —un
 * comprobante viejo, aprobado por la API—, se toma como pago completo de lo
 * que se debía ese día (`montoAsumido`), y así queda a la vista.
 *
 * Con factura vinculada, el estado de la cadena se recalcula
 * (`recalcularCadena`): pagada o abonada según el monto, y discrepancia si la
 * contabilidad no lo refleja. Sin factura, queda registrado y no cambia
 * ningún estado.
 */
export const aprobar = mutation({
  args: {
    id: v.id("soportesPago"),
    notaRevision: v.optional(v.string()),
    monto: v.optional(v.number()),
    fechaPago: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const soporte = await ctx.db.get(args.id);
    if (!soporte) throw new Error("Comprobante no encontrado.");
    const { user } = await requireCondominioRole(ctx, soporte.condominioId, [
      ...ADMIN_ROLES,
    ]);
    if (soporte.estado !== "pendiente_revision") {
      throw new Error("El comprobante ya fue revisado.");
    }
    validarMontoYFecha(args.monto, args.fechaPago);

    const now = Date.now();
    const factura = soporte.facturaId ? await ctx.db.get(soporte.facturaId) : null;
    const fechaPago = args.fechaPago ?? soporte.fechaPago;
    const declarado = args.monto ?? soporte.monto;
    const asumido = declarado === undefined;
    const monto =
      declarado ??
      (factura ? Math.max(0, montoAPagarHoy(factura, fechaPago ?? soporte.createdAt)) : undefined);

    await ctx.db.patch(args.id, {
      estado: "aprobado",
      revisadoPorUserId: user._id,
      revisadoPorNombre: user.name,
      revisadoAt: now,
      notaRevision: args.notaRevision,
      ...(monto !== undefined ? { monto } : {}),
      ...(fechaPago !== undefined ? { fechaPago } : {}),
      ...(asumido && monto !== undefined ? { montoAsumido: true } : {}),
      /* La evidencia se busca por unidad: que la tenga. */
      ...(factura ? { unidadId: factura.unidadId } : {}),
    });

    if (factura) {
      await recalcularCadena(ctx, factura.condominioId, factura.unidadId, {
        origen: "comprobante",
        actor: user.name || "Administración",
        actorUserId: user._id,
        tocadas: new Map([
          [
            factura._id,
            {
              detalle:
                monto === undefined
                  ? "Comprobante aprobado."
                  : asumido
                    ? `Comprobante aprobado sin monto: se toma como pago completo (${formatoPesos(monto)}).`
                    : `Comprobante aprobado: ${formatoPesos(monto)}.`,
              datos: { soporteId: soporte._id, monto: monto ?? null, asumido, fechaPago: fechaPago ?? null },
            },
          ],
        ]),
      });
    }

    // El bot le prometió al residente avisarle del resultado.
    await ctx.scheduler.runAfter(0, internal.whatsappNotifs.soporteRevisado, {
      soporteId: args.id,
    });
    return args.id;
  },
});

export const rechazar = mutation({
  args: {
    id: v.id("soportesPago"),
    notaRevision: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const soporte = await ctx.db.get(args.id);
    if (!soporte) throw new Error("Comprobante no encontrado.");
    const { user } = await requireCondominioRole(ctx, soporte.condominioId, [
      ...ADMIN_ROLES,
    ]);
    if (soporte.estado !== "pendiente_revision") {
      throw new Error("El comprobante ya fue revisado.");
    }

    await ctx.db.patch(args.id, {
      estado: "rechazado",
      revisadoPorUserId: user._id,
      revisadoPorNombre: user.name,
      revisadoAt: Date.now(),
      notaRevision: args.notaRevision,
    });

    await ctx.scheduler.runAfter(0, internal.whatsappNotifs.soporteRevisado, {
      soporteId: args.id,
    });
    return args.id;
  },
});

