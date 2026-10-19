import { v } from "convex/values";
import { httpAction, internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  misUnidadIds,
  requireAppUser,
  requireCondominioRole,
  requirePlatformStaff,
} from "./model/authz";
import { exigirAccesoCompania } from "./model/acceso";
import type { OperationalRole } from "./model/roles";
import { carpetaAvatar } from "./model/s3";
import { exigirArchivoSubido } from "./model/registroArchivos";
import { ADMIN_ROLES as ROLES_DOCUMENTOS } from "./documentos";
import { ADMIN_ROLES as ROLES_COMUNICADOS } from "./comunicados";
import { ADMIN_ROLES as ROLES_ICONOS_CONSEJO, UPLOAD_ROLES as ROLES_CONSEJO } from "./consejo";
import { GUARD_ROLES } from "./guardia";
import { ADMIN_ROLES as ROLES_RESERVAS } from "./reservas";
import { WRITE_ROLES as ROLES_MESA } from "./asambleas";
import { MANUAL_ROLES, carpetaParaPublicar } from "./facturas";
import {
  BYTES_CABECERA,
  CARPETA_TEMPORAL,
  CATEGORIAS,
  MAX_INTERMEDIADA,
  MENSAJE_ARCHIVO_GRANDE,
  MENSAJE_CONTENIDO,
  MENSAJE_SUBIDA_NO_VALIDA,
  MENSAJE_TIPO_NO_PERMITIDO,
  normalizarTipo,
  tipoVerificado,
  VIGENCIA_REGISTRO_MS,
  type Categoria,
  type NombreCategoria,
} from "./lib/subidas";

/**
 * QUIÉN PUEDE SUBIR QUÉ, Y DÓNDE (H-06 de la auditoría de S3,
 * qa/factory/auditoria-s3-2026-10-14).
 *
 * El cliente pide subir a una carpeta (`folder`). Antes bastaba con tener
 * sesión: cualquiera escribía en la carpeta de cualquier conjunto, con el
 * tipo y el tamaño que quisiera. Ahora la carpeta tiene que ser una de las
 * que de verdad usan la web y el móvil, se resuelve contra la base (el
 * conjunto, la asamblea o la compañía existen) y se exige el MISMO permiso
 * que la mutación que después registra el archivo. Cada carpeta tiene su
 * categoría (`lib/subidas.ts`): tipos y tamaño máximo.
 *
 * `files.ts` hace la subida: por el servidor (`uploadBytes`, con los bytes
 * revisados), por URL firmada con tamaño y tipo exactos (`generateUploadUrl`
 * con `size`), o —para las apps instaladas, que no mandan el tamaño— por la
 * ruta `/archivos/subida` de abajo, que revisa tamaño y contenido antes de
 * escribir en S3.
 */

/** Mensaje estable: la carpeta no existe, no es de un uso conocido o no hay permiso. */
export const MENSAJE_CARPETA = "No tienes permiso para subir archivos ahí.";
const MENSAJE_ENLACE = "El enlace de subida no es válido o ya venció. Vuelve a intentarlo.";

/** Las subcarpetas de portería (rondas, paquetes, depósitos…). */
const CARPETAS_PORTERIA = new Set(["rondas", "paquetes", "depositos", "incidentes", "novedades", "vehiculos"]);

type Destino = { carpeta: string; categoria: NombreCategoria; userId: Id<"users"> };

/** El conjunto de la carpeta, si existe. */
async function conjunto(ctx: QueryCtx, id: string): Promise<Id<"condominios">> {
  const condominioId = ctx.db.normalizeId("condominios", id);
  if (!condominioId || !(await ctx.db.get(condominioId))) throw new Error(MENSAJE_CARPETA);
  return condominioId;
}

/**
 * La carpeta autorizada para `folder`, con su categoría. Las carpetas son las
 * que arman hoy la web y el móvil; cualquier otra se rechaza. Los permisos
 * son los de la mutación que registra el archivo (entre paréntesis).
 */
async function resolverDestino(ctx: QueryCtx, folderArg: string): Promise<Destino> {
  const folder = folderArg.trim();
  // Solo tramos simples: nada de `.`/`..`, barras dobles o al borde, ni otros caracteres.
  if (!/^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/.test(folder)) throw new Error(MENSAJE_CARPETA);
  const user = await requireAppUser(ctx);
  /* Un solo mensaje para "no existe", "no es tuyo" y "no tienes el rol": la
   * respuesta no dice si el conjunto existe ni qué falta. */
  try {
    return await destinoPara(ctx, folder, user._id);
  } catch {
    throw new Error(MENSAJE_CARPETA);
  }
}

async function destinoPara(ctx: QueryCtx, folder: string, userId: Id<"users">): Promise<Destino> {
  const en = (categoria: NombreCategoria): Destino => ({ carpeta: folder, categoria, userId });
  const t = folder.split("/");

  // Foto de perfil (`users.setMyAvatar`): siempre en la carpeta de quien sube.
  if (folder === "avatars") {
    return { carpeta: carpetaAvatar(userId), categoria: "imagen", userId };
  }
  // Bandeja de WhatsApp (`whatsappInbox.enviar`): personal de plataforma.
  if (folder === "whatsapp/salientes") {
    await requirePlatformStaff(ctx);
    return en("whatsapp");
  }
  // Soporte (`soporte.crear`/`responder`): sin conjunto, cualquiera con
  // perfil; con conjunto, sus miembros (o plataforma).
  if (t.length === 2 && t[0] === "soporte") {
    if (t[1] !== "plataforma") await requireCondominioRole(ctx, await conjunto(ctx, t[1]!), []);
    return en("adjunto");
  }
  // Inventario de una compañía (`inventario.crear`/`editar`).
  if (t.length === 2 && t[0] === "inventario") {
    const companiaId = ctx.db.normalizeId("companiasSeguridad", t[1]!);
    if (!companiaId) throw new Error(MENSAJE_CARPETA);
    await exigirAccesoCompania(ctx, companiaId, "inventario.gestionar");
    return en("imagen");
  }
  // Grabación de una asamblea: la mesa (`salaBitacora.iniciarGrabacion`).
  if (t.length === 3 && t[0] === "asambleas" && t[2] === "grabacion") {
    const asambleaId = ctx.db.normalizeId("asambleas", t[1]!);
    const asamblea = asambleaId ? await ctx.db.get(asambleaId) : null;
    if (!asamblea) throw new Error(MENSAJE_CARPETA);
    await requireCondominioRole(ctx, asamblea.condominioId, [...ROLES_MESA]);
    return en("grabacion");
  }
  // El PDF de una factura de una importación que no cabe en una llamada a
  // `files.publicarFacturas` (`/api/facturas/confirmar`, Fase 6):
  // condominios/facturas/{carpeta}/{período}/{importación}. Es la carpeta que
  // exige `bulkUpsert`, con el mismo permiso que esa publicación: importación
  // en curso, rol de carga, carpeta solo del conjunto. Solo PDF.
  if (t.length === 5 && t[0] === "condominios" && t[1] === "facturas") {
    const importacionId = ctx.db.normalizeId("importaciones", t[4]!);
    if (!importacionId) throw new Error(MENSAJE_CARPETA);
    const { carpeta } = await carpetaParaPublicar(ctx, importacionId);
    if (carpeta !== folder) throw new Error(MENSAJE_CARPETA);
    return en("facturaPdf");
  }
  if (t[0] !== "condominios") throw new Error(MENSAJE_CARPETA);

  // condominios/{uso}/{conjunto}
  if (t.length === 3) {
    switch (t[1]) {
      case "documentos": // documentos.create
        await requireCondominioRole(ctx, await conjunto(ctx, t[2]!), [...ROLES_DOCUMENTOS]);
        return en("documento");
      case "comunicados": // comunicados.create/update
        await requireCondominioRole(ctx, await conjunto(ctx, t[2]!), [...ROLES_COMUNICADOS]);
        return en("comunicado");
      case "facturas": // facturas.createManual
        await requireCondominioRole(ctx, await conjunto(ctx, t[2]!), [...MANUAL_ROLES]);
        return en("pdfOImagen");
      case "soportes": {
        // Comprobante de pago (`soportesPago.crearMio`): quien tiene casas ahí.
        const unidades = await misUnidadIds(ctx, userId, await conjunto(ctx, t[2]!));
        if (unidades.size === 0) throw new Error(MENSAJE_CARPETA);
        return en("adjunto");
      }
    }
  }
  // condominios/asambleas/{conjunto}/poderes (`asambleas.otorgarPoder`):
  // quien tiene casas ahí, o la administración de la asamblea.
  if (t.length === 4 && t[1] === "asambleas" && t[3] === "poderes") {
    const condominioId = await conjunto(ctx, t[2]!);
    if ((await misUnidadIds(ctx, userId, condominioId)).size === 0) {
      await requireCondominioRole(ctx, condominioId, [...ROLES_MESA]);
    }
    return en("pdfOImagen");
  }
  // condominios/guardia/{conjunto}/{rondas|paquetes|…} (`guardia.*`).
  if (t.length === 4 && t[1] === "guardia" && CARPETAS_PORTERIA.has(t[3]!)) {
    await requireCondominioRole(ctx, await conjunto(ctx, t[2]!), [...GUARD_ROLES]);
    return en(t[3] === "novedades" ? "novedad" : "imagen");
  }
  // condominios/{conjunto}/{consejo|consejo/icons|reservas/incidentes|logo|cover}
  const usos = new Map<string, { categoria: NombreCategoria; roles: readonly OperationalRole[] | "plataforma" }>([
    ["consejo", { categoria: "documento", roles: ROLES_CONSEJO }], // consejo.createDocumento/nuevaVersion
    ["consejo/icons", { categoria: "iconoConsejo", roles: ROLES_ICONOS_CONSEJO }], // consejo.*Categoria
    ["reservas/incidentes", { categoria: "imagen", roles: ROLES_RESERVAS }], // reservas.registrarIncidente
    ["logo", { categoria: "imagen", roles: "plataforma" }], // condominios.update
    ["cover", { categoria: "imagen", roles: "plataforma" }],
  ]);
  const uso = t.length >= 3 ? usos.get(t.slice(2).join("/")) : undefined;
  if (!uso) throw new Error(MENSAJE_CARPETA);
  const condominioId = await conjunto(ctx, t[1]!);
  if (uso.roles === "plataforma") await requirePlatformStaff(ctx);
  else await requireCondominioRole(ctx, condominioId, [...uso.roles]);
  return en(uso.categoria);
}

/**
 * Autoriza una subida ANTES de firmar o escribir nada: carpeta, permiso,
 * tipo declarado y tamaño. `directo` es la URL firmada a S3: ahí el tipo y el
 * tamaño quedan firmados, así que tienen que venir y ser válidos. Por el
 * servidor, sin tipo declarado, deciden los bytes.
 */
export const autorizar = internalQuery({
  args: {
    folder: v.string(),
    contentType: v.string(),
    size: v.optional(v.number()),
    directo: v.boolean(),
  },
  handler: async (ctx, args) => {
    const destino = await resolverDestino(ctx, args.folder);
    const categoria: Categoria = CATEGORIAS[destino.categoria];
    const tipo = normalizarTipo(args.contentType);
    if (args.directo) {
      if (!tipo || !categoria.tipos.includes(tipo) || categoria.soloServidor?.includes(tipo)) {
        throw new Error(MENSAJE_TIPO_NO_PERMITIDO);
      }
    } else if (tipo && !categoria.tipos.includes(tipo)) {
      throw new Error(MENSAJE_TIPO_NO_PERMITIDO);
    }
    if (args.size !== undefined) {
      if (!Number.isSafeInteger(args.size) || args.size <= 0) throw new Error("Tamaño de archivo inválido.");
      if (args.size > categoria.maxBytes) throw new Error(MENSAJE_ARCHIVO_GRANDE);
    }
    return {
      ...destino,
      tipos: [...categoria.tipos],
      maxBytes: categoria.maxBytes,
    };
  },
});

/* ── El registro de cada subida (`subidasPendientes`) ─────────────────────── */

/**
 * Borra algunas filas vencidas. Si era un PUT directo que nunca se confirmó,
 * borra también su objeto provisional (`pendientes/…`, llave del servidor):
 * nunca llegó a publicarse.
 */
async function limpiarVencidas(ctx: MutationCtx) {
  const vencidas = await ctx.db
    .query("subidasPendientes")
    .withIndex("by_expira", (q) => q.lt("expiraEn", Date.now()))
    .take(20);
  for (const p of vencidas) {
    const pendiente = (p.estado ?? "pendiente") === "pendiente";
    if (pendiente && p.claveTemporal?.startsWith(`${CARPETA_TEMPORAL}/`)) {
      await ctx.scheduler.runAfter(0, internal.files.deleteObjectInternal, { key: p.claveTemporal });
    }
    await ctx.db.delete(p._id);
  }
}

const vModo = v.union(v.literal("directo"), v.literal("intermediado"), v.literal("servidor"));

/** Una subida autorizada que todavía no llega (o no se ha comprobado). */
export const registrarPendiente = internalMutation({
  args: {
    key: v.string(),
    url: v.string(),
    carpeta: v.string(),
    categoria: v.string(),
    tipoDeclarado: v.string(),
    userId: v.id("users"),
    expiraEn: v.number(),
    modo: vModo,
    tokenHash: v.optional(v.string()),
    size: v.optional(v.number()),
    claveTemporal: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await limpiarVencidas(ctx);
    await ctx.db.insert("subidasPendientes", { ...args, estado: "pendiente" });
  },
});

/** Una subida que el servidor ya escribió con los bytes revisados (`uploadBytes`). */
export const registrarValidada = internalMutation({
  args: {
    key: v.string(),
    url: v.string(),
    carpeta: v.string(),
    categoria: v.string(),
    tipoDeclarado: v.string(),
    userId: v.id("users"),
    tipo: v.string(),
    bytes: v.number(),
  },
  handler: async (ctx, args) => {
    await limpiarVencidas(ctx);
    await ctx.db.insert("subidasPendientes", {
      ...args,
      modo: "servidor",
      estado: "validada",
      expiraEn: Date.now() + VIGENCIA_REGISTRO_MS,
    });
  },
});

async function porLlave(ctx: QueryCtx, key: string) {
  return await ctx.db
    .query("subidasPendientes")
    .withIndex("by_key", (q) => q.eq("key", key))
    .first();
}

/**
 * Los PDF que el servidor publicó para una importación de facturas
 * (`files.publicarFacturas`): validados desde ya, como los de `uploadBytes`.
 *
 * Sus llaves no son al azar: llevan la importación y la huella del contenido,
 * así que un reintento de la misma importación publica en las mismas llaves
 * y aquí encuentra su fila. No se duplica: si ninguna factura la registró
 * todavía, pasa a quien reintenta (la importación pudo retomarla otra persona
 * con el mismo rol) y se renueva el plazo; si ya se registró, queda como está
 * (la factura la conserva como "la que ya tenía").
 */
export const registrarPublicadas = internalMutation({
  args: {
    carpeta: v.string(),
    userId: v.id("users"),
    archivos: v.array(v.object({ key: v.string(), url: v.string(), bytes: v.number() })),
  },
  handler: async (ctx, args) => {
    await limpiarVencidas(ctx);
    for (const a of args.archivos) {
      const previa = await porLlave(ctx, a.key);
      if (previa) {
        // Solo puede ser una publicación anterior de esta misma importación.
        if (previa.carpeta !== args.carpeta || previa.url !== a.url || previa.estado !== "validada") {
          throw new Error(MENSAJE_SUBIDA_NO_VALIDA);
        }
        if (previa.registradaEn === undefined) {
          await ctx.db.patch(previa._id, { userId: args.userId, expiraEn: Date.now() + VIGENCIA_REGISTRO_MS });
        }
        continue;
      }
      await ctx.db.insert("subidasPendientes", {
        key: a.key,
        url: a.url,
        carpeta: args.carpeta,
        categoria: "facturaPdf",
        tipoDeclarado: "application/pdf",
        userId: args.userId,
        modo: "servidor",
        estado: "validada",
        tipo: "application/pdf",
        bytes: a.bytes,
        expiraEn: Date.now() + VIGENCIA_REGISTRO_MS,
      });
    }
  },
});

/**
 * El contenido ya se leyó y es de un tipo permitido: la subida queda
 * validada, con el tipo y el tamaño comprobados, lista para registrarse.
 */
export const marcarValidada = internalMutation({
  args: { key: v.string(), tipo: v.string(), bytes: v.number() },
  handler: async (ctx, args) => {
    const p = await porLlave(ctx, args.key);
    // Sin fila (venció o se descartó): quien llama no debe dejar nada publicado.
    if (!p) throw new Error(MENSAJE_SUBIDA_NO_VALIDA);
    // Ya validada (dos confirmaciones a la vez): nada que hacer.
    if (p.estado === "validada") return;
    await ctx.db.patch(p._id, {
      estado: "validada",
      tipo: args.tipo,
      bytes: args.bytes,
      tokenHash: undefined,
      claveTemporal: undefined,
      expiraEn: Date.now() + VIGENCIA_REGISTRO_MS,
    });
  },
});

/** La subida no pasó la revisión: se olvida (nada quedó publicado). */
export const descartar = internalMutation({
  args: { key: v.string() },
  handler: async (ctx, args) => {
    const p = await porLlave(ctx, args.key);
    if (p && (p.estado ?? "pendiente") === "pendiente") await ctx.db.delete(p._id);
  },
});

/**
 * La subida directa que `files.confirmarSubida` va a revisar: de quien
 * confirma, pendiente y sin vencer. Lo demás (destino, categoría, tamaño
 * firmado, tipo declarado) sale de aquí, no del cliente.
 */
export const paraConfirmar = internalQuery({
  args: { key: v.string() },
  handler: async (ctx, args) => {
    const user = await requireAppUser(ctx);
    const p = await porLlave(ctx, args.key);
    if (
      !p ||
      p.userId !== user._id ||
      p.modo !== "directo" ||
      (p.estado ?? "pendiente") !== "pendiente" ||
      !p.claveTemporal ||
      p.size === undefined ||
      p.expiraEn < Date.now()
    ) {
      return null;
    }
    return {
      key: p.key,
      claveTemporal: p.claveTemporal,
      size: p.size,
      categoria: p.categoria,
      tipoDeclarado: p.tipoDeclarado,
    };
  },
});

/**
 * Gasta el enlace de la subida intermediada (un solo uso): borra su huella y
 * devuelve la subida si sigue pendiente y no venció.
 */
export const consumirPendiente = internalMutation({
  args: { tokenHash: v.string() },
  handler: async (ctx, args) => {
    const p = await ctx.db
      .query("subidasPendientes")
      .withIndex("by_token", (q) => q.eq("tokenHash", args.tokenHash))
      .first();
    if (!p) return null;
    if (p.expiraEn < Date.now() || (p.estado ?? "pendiente") !== "pendiente") {
      await ctx.db.delete(p._id);
      return null;
    }
    await ctx.db.patch(p._id, { tokenHash: undefined });
    return { key: p.key, categoria: p.categoria, tipoDeclarado: p.tipoDeclarado };
  },
});

/** Para acciones (la bandeja de WhatsApp): `exigirArchivoSubido` en una mutación. */
export const exigirSubidaParaRegistro = internalMutation({
  args: { userId: v.id("users"), url: v.string(), carpeta: v.string(), reutilizable: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    await exigirArchivoSubido(ctx, args.userId, { url: args.url }, args.carpeta, {
      reutilizable: args.reutilizable,
    });
  },
});

/* ── Subida intermediada (apps instaladas y web anterior) ─────────────────── */

/* La subida la hacen el navegador (la web anterior, por XHR) y la app; el
 * enlace es la credencial, así que no hacen falta cookies ni un origen fijo. */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "600",
};

function respuesta(status: number, cuerpo?: Record<string, unknown>) {
  return new Response(cuerpo ? JSON.stringify(cuerpo) : null, {
    status,
    headers: cuerpo ? { ...CORS, "Content-Type": "application/json" } : CORS,
  });
}

async function huella(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Lee el cuerpo sin pasar de `max`: corta en cuanto lo supera, sin esperar a
 * que termine. Devuelve los trozos (para guardarlos sin otra copia) y la
 * cabecera para reconocer el tipo.
 */
async function leerConLimite(
  request: Request,
  max: number,
): Promise<{ trozos: Uint8Array[]; total: number; cabecera: Uint8Array } | null> {
  const trozos: Uint8Array[] = [];
  let total = 0;
  if (request.body) {
    const lector = request.body.getReader();
    for (;;) {
      const { done, value } = await lector.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await lector.cancel();
        return null;
      }
      trozos.push(value);
    }
  }
  const cabecera = new Uint8Array(Math.min(total, BYTES_CABECERA));
  let llevo = 0;
  for (const trozo of trozos) {
    if (llevo >= cabecera.length) break;
    const n = Math.min(trozo.byteLength, cabecera.length - llevo);
    cabecera.set(trozo.subarray(0, n), llevo);
    llevo += n;
  }
  return { trozos, total, cabecera };
}

/** `OPTIONS /archivos/subida`: el preflight del navegador. */
export const opcionesSubida = httpAction(async () => respuesta(204));

/**
 * `PUT /archivos/subida?token=…`: el archivo de una subida autorizada.
 *
 * El enlace sale de `files.generateUploadUrl` cuando el cliente no manda el
 * tamaño (las apps instaladas no lo mandan: hacen PUT a la `uploadUrl` que
 * reciben, con su `Content-Type`). Aquí, antes de escribir en S3: el enlace
 * existe, no venció y no se usó; el cuerpo no pasa del límite de su categoría;
 * y los bytes son de un tipo permitido. El objeto se guarda en la llave que
 * ya se le devolvió al cliente, con el tipo verificado.
 */
export const recibirSubida = httpAction(async (ctx, request) => {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  if (!/^[0-9a-f]{64}$/.test(token)) return respuesta(403, { error: MENSAJE_ENLACE });
  const pendiente = await ctx.runMutation(internal.subidas.consumirPendiente, {
    tokenHash: await huella(token),
  });
  const categoria: Categoria | undefined = pendiente
    ? CATEGORIAS[pendiente.categoria as NombreCategoria]
    : undefined;
  if (!pendiente || !categoria) return respuesta(403, { error: MENSAJE_ENLACE });

  const max = Math.min(categoria.maxBytes, MAX_INTERMEDIADA);
  /* Si no pasa la revisión, la subida se olvida: no queda nada publicado ni
   * nada que una entidad pueda registrar. */
  const rechazar = async (status: number, error: string) => {
    await ctx.runMutation(internal.subidas.descartar, { key: pendiente.key });
    return respuesta(status, { error });
  };
  const anunciado = Number(request.headers.get("content-length"));
  if (Number.isFinite(anunciado) && anunciado > max) return await rechazar(413, MENSAJE_ARCHIVO_GRANDE);
  const leido = await leerConLimite(request, max);
  if (!leido) return await rechazar(413, MENSAJE_ARCHIVO_GRANDE);
  if (leido.total === 0) return await rechazar(400, "Archivo vacío.");

  const tipo = tipoVerificado(leido.cabecera, pendiente.tipoDeclarado, categoria.tipos);
  if (!tipo) return await rechazar(415, MENSAJE_CONTENIDO);

  const storageId = await ctx.storage.store(new Blob(leido.trozos as BlobPart[], { type: tipo }));
  try {
    await ctx.runAction(internal.files.publicarSubida, {
      storageId,
      key: pendiente.key,
      contentType: tipo,
    });
  } catch {
    return await rechazar(502, "No se pudo guardar el archivo. Intenta de nuevo.");
  } finally {
    await ctx.storage.delete(storageId);
  }
  try {
    await ctx.runMutation(internal.subidas.marcarValidada, { key: pendiente.key, tipo, bytes: leido.total });
  } catch {
    // Venció mientras llegaba: no queda publicado nada que no se pueda registrar.
    await ctx.runAction(internal.files.deleteObjectInternal, { key: pendiente.key });
    return respuesta(403, { error: MENSAJE_ENLACE });
  }
  return respuesta(200, { ok: true });
});
