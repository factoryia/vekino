import { v } from "convex/values";
import {
  query,
  mutation,
  action,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { authComponent, createAuth } from "./auth";
import { verifyPassword } from "better-auth/crypto";
import {
  getCurrentAppUser,
  requireAppUser,
  requirePlatformStaff,
  requireCondominioRole,
  getMembership,
} from "./model/authz";
import { tipoDocumentoValidator } from "./model/roles";
import { evaluarPassword } from "./lib/passwordFuerte";
import { fijarPasswordDeCuenta } from "./model/credencial";
import { resolveUserImage } from "./model/userImage";
import { misAsignacionesDesde, viasDeAsignacionDe } from "./model/asignacion";
import {
  aplicarContexto,
  esViaDeGuarda,
  resolverContextoOperativoGuardia,
  viasDeMembershipDe,
  type ContextoOperativoGuardia,
  type Via,
} from "./model/vias";
import { miCompaniaDe } from "./model/acceso";
import { scheduleDeleteS3Keys, s3KeyFromPublicUrl } from "./model/s3";
import { normalizarTelefonoE164 } from "./lib/telefono";

/**
 * Las porterías donde la persona opera como guarda AHORA: sus vías de guarda
 * con el contexto aplicado, una por conjunto.
 *
 * Es `aplicarContexto` —la regla con la que deciden `requireCondominioRole` y
 * `resolverAcceso`— sobre todas sus vías permanentes, conjunto por conjunto.
 * Sin cobertura salen sus porterías de siempre; con cobertura, solo la que
 * cubre; bloqueado, ninguna. Se calcula aquí para que ningún cliente tenga
 * que reconstruir la regla con las membresías y las asignaciones.
 */
function porteriasDeGuardia(
  permanentes: readonly Via[],
  contexto: ContextoOperativoGuardia,
): Via[] {
  const conjuntos = new Set(permanentes.map((v) => v.condominioId));
  if (contexto.tipo === "cobertura") conjuntos.add(contexto.via.condominioId);
  return [...conjuntos].flatMap((condominioId) => {
    const aqui = permanentes.filter((v) => v.condominioId === condominioId);
    const deGuarda = aplicarContexto(aqui, contexto, condominioId).vias.filter(esViaDeGuarda);
    return deGuarda.slice(0, 1);
  });
}

/**
 * Dónde opera como guarda la persona AHORA, tal como lo necesita el cliente
 * para rutear: la cobertura que la lleva a otro conjunto, si la hay, las
 * porterías que puede operar (`conjuntos`) y cuándo volver a preguntar. Es el
 * contexto de `model/vias.ts` sin los documentos internos; la decisión sigue
 * siendo del servidor.
 */
function contextoParaSesion(
  contexto: ContextoOperativoGuardia,
  porterias: readonly Via[],
  condominioDe: (via: Via) => Doc<"condominios"> | null,
) {
  const cobertura =
    contexto.tipo === "cobertura"
      ? {
          coberturaId: contexto.via.cobertura._id,
          condominioId: contexto.via.condominioId,
          condominioNombre: contexto.via.condominio.name,
          condominioLogo: contexto.via.condominio.logo ?? null,
          condominioColor: contexto.via.condominio.primaryColor ?? null,
          companiaId: contexto.via.companiaId,
          companiaNombre: contexto.via.compania.nombre,
          inicio: contexto.via.cobertura.inicio,
          fin: contexto.via.cobertura.fin,
        }
      : null;
  const conjuntos = porterias
    .map((via) => {
      const condominio = condominioDe(via);
      return {
        condominioId: via.condominioId,
        condominioNombre: condominio?.name ?? "",
        condominioLogo: condominio?.logo ?? null,
        condominioColor: condominio?.primaryColor ?? null,
        condominioCoverImage: condominio?.coverImage ?? null,
        /** Por qué vía opera allí: su membresía, su asignación o la cobertura. */
        por: via.tipo,
      };
    })
    .sort((a, b) => a.condominioNombre.localeCompare(b.condominioNombre, "es"));
  return { tipo: contexto.tipo, cobertura, conjuntos, refrescarEn: contexto.refrescarEn };
}

/**
 * Estado de sesión + perfil + membresías del usuario actual.
 * Es la consulta que el frontend usa para saber "quién soy y qué puedo hacer".
 */
export const me = query({
  args: {},
  handler: async (ctx) => await sesionActual(ctx),
});

/**
 * Lo mismo que `me`, para quien necesita el contexto de guarda al día.
 *
 * `refresco` no se lee: es el número que el cliente cambia en
 * `contextoOperativoGuardia.refrescarEn` para que Convex vuelva a ejecutar la
 * consulta cuando el paso del tiempo cambia la respuesta (ver `guardia.home`).
 * Va en una consulta aparte, y no como argumento opcional de `me`, porque un
 * argumento obligaría a reescribir las veintisiete llamadas de la web y del
 * móvil que piden `me` sin argumentos. La respuesta es la misma función.
 */
export const meOperativo = query({
  args: { refresco: v.optional(v.number()) },
  handler: async (ctx) => await sesionActual(ctx),
});

async function sesionActual(ctx: QueryCtx) {
  const user = await getCurrentAppUser(ctx);
  if (!user) return null;

  /* Las dos listas salen de las mismas vías que autorizan (`model/vias.ts`):
   * lo que la sesión ofrece y lo que la portería deja pasar no pueden
   * medirse con criterios distintos. */
  const memberships = await viasDeMembershipDe(ctx, user._id);
  /* Los conjuntos de las membresías, para no volver a leerlos al armar las
   * porterías de guarda (la vía de membresía no trae el documento). */
  const condominiosDeMembresia = new Map<Id<"condominios">, Doc<"condominios"> | null>();

  const withCondominio = await Promise.all(
    memberships.map(async (via) => {
      const condominio = await ctx.db.get(via.condominioId);
      condominiosDeMembresia.set(via.condominioId, condominio);
      return {
        membershipId: via.membership._id,
        condominioId: via.condominioId,
        condominioName: condominio?.name ?? null,
        condominioSubdomain: condominio?.subdomain ?? null,
        condominioLogo: condominio?.logo ?? null,
        condominioCoverImage: condominio?.coverImage ?? null,
        condominioPrimaryColor: condominio?.primaryColor ?? null,
        roles: via.roles,
      };
    }),
  );

  /* EL SEGUNDO EJE. `memberships` dice a qué conjuntos pertenece la persona;
   * `asignaciones` dice en cuáles trabaja por una compañía de vigilancia.
   * El supervisor y el guarda de compañía no tienen NINGUNA membresía —no
   * son del conjunto, son de la empresa que lo cubre—, así que devolver
   * solo lo de arriba los dejaba entrando a una sesión sin un solo conjunto
   * a la vista. Van en un campo aparte, y no fingidos como membresías,
   * porque no dan lo mismo: un guarda de compañía no es residente ni tiene
   * unidades. */
  const viasDeAsignacion = await viasDeAsignacionDe(ctx, user._id);
  const asignaciones = misAsignacionesDesde(viasDeAsignacion);

  /* Y EL TERCERO. El administrador de una compañía no tiene membresía ni
   * asignación: no pisa ninguna portería, administra la empresa que las
   * cubre. Sin este campo entraba a una sesión sin un solo conjunto a la
   * vista, aunque su empresa tuviera contratos vigentes con varios. */
  const compania = await miCompaniaDe(ctx, user._id);

  /* Y dónde opera como guarda AHORA. Las asignaciones de arriba siguen
   * siendo todas las permanentes —a ellas vuelve cuando la cobertura
   * termina—; esto dice si hoy una cobertura las suspende y lo lleva a otro
   * conjunto. El cliente lo usa para rutear, no para decidir: cada consulta
   * y cada mutación de la portería lo vuelve a resolver en el servidor. */
  const contexto = await resolverContextoOperativoGuardia(ctx, user._id);
  const contextoOperativoGuardia = contextoParaSesion(
    contexto,
    porteriasDeGuardia([...memberships, ...viasDeAsignacion], contexto),
    (via) =>
      via.tipo === "membership"
        ? (condominiosDeMembresia.get(via.condominioId) ?? null)
        : via.condominio,
  );

  return {
    id: user._id,
    name: user.name,
    email: user.email,
    image: await resolveUserImage(ctx, user),
    firstName: user.firstName,
    lastName: user.lastName,
    telefono: user.telefono,
    active: user.active,
    platformRole: user.platformRole ?? null,
    isSuperadmin: user.platformRole === "superadmin",
    /** Sigue usando la clave que le generó la administración. */
    claveTemporal: user.claveTemporal === true,
    memberships: withCondominio,
    asignaciones,
    compania,
    contextoOperativoGuardia,
  };
}

/**
 * Crea (o enlaza) el perfil de aplicación del usuario autenticado con Better
 * Auth. Idempotente: se puede llamar en cada login sin duplicar.
 * Si aún no hay JWT (carrera al montar), retorna null sin fallar.
 */
export const ensureProfile = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    // ¿Ya existe perfil enlazado por authId?
    const existing = await ctx.db
      .query("users")
      .withIndex("by_authId", (q) => q.eq("authId", identity.subject))
      .unique();
    if (existing) {
      /* Único punto del backend que prueba que alguien ENTRÓ: aquí ya hay
       * sesión resuelta. `authId` no sirve de señal porque se estampa al
       * crear al residente, sin login. Se escribe como mucho una vez al día
       * para no patchear el documento en cada carga de pantalla. */
      const hoy = Date.now();
      const UN_DIA = 24 * 60 * 60 * 1000;
      if (!existing.ultimoIngresoAt || hoy - existing.ultimoIngresoAt > UN_DIA) {
        await ctx.db.patch(existing._id, { ultimoIngresoAt: hoy });
      }
      return existing._id;
    }

    const authUser = await authComponent.getAuthUser(ctx);
    const email = authUser?.email ?? identity.email ?? "";

    // ¿Existe un perfil por email (p.ej. importado en la migración) sin authId?
    if (email) {
      const byEmail = await ctx.db
        .query("users")
        .withIndex("by_email", (q) => q.eq("email", email))
        .unique();
      if (byEmail && !byEmail.authId) {
        await ctx.db.patch(byEmail._id, {
          authId: identity.subject,
          updatedAt: Date.now(),
        });
        return byEmail._id;
      }
    }

    const now = Date.now();
    return await ctx.db.insert("users", {
      authId: identity.subject,
      name: authUser?.name ?? identity.name ?? email,
      email,
      emailVerified: authUser?.emailVerified ?? false,
      image: authUser?.image ?? undefined,
      active: true,
      platformRole: undefined,
      createdAt: now,
      updatedAt: now,
    });
  },
});

/** Actualiza datos de perfil del propio usuario. */
export const updateMyProfile = mutation({
  args: {
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    telefono: v.optional(v.string()),
    tipoDocumento: v.optional(tipoDocumentoValidator),
    numeroDocumento: v.optional(v.string()),
    image: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireAppUser(ctx);
    const patch: Record<string, unknown> = { ...args, updatedAt: Date.now() };
    if (args.telefono !== undefined) {
      patch.telefonoE164 = normalizarTelefonoE164(args.telefono) ?? undefined;
    }
    await ctx.db.patch(user._id, patch);
    return user._id;
  },
});

/** URL firmada para subir avatar — @deprecated usar api.files.generateUploadUrl (S3). */
export const generateAvatarUploadUrl = mutation({
  args: {},
  handler: async () => {
    throw new Error(
      "Las subidas van a S3. Usa api.files.generateUploadUrl (action).",
    );
  },
});

/** Guarda el avatar (URL S3 preferida; storageId legacy). Borra la foto anterior de S3. */
export const setMyAvatar = mutation({
  args: {
    storageId: v.optional(v.id("_storage")),
    url: v.optional(v.string()),
    s3Key: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireAppUser(ctx);
    let image = args.url?.trim();
    if (!image && args.storageId) {
      image = (await ctx.storage.getUrl(args.storageId)) ?? undefined;
    }
    if (!image) throw new Error("No se pudo obtener la URL del avatar.");

    const newKey =
      args.s3Key?.trim() || s3KeyFromPublicUrl(image) || undefined;
    const oldKey =
      user.imageS3Key?.trim() || s3KeyFromPublicUrl(user.image) || undefined;

    if (oldKey && oldKey !== newKey) {
      try {
        await scheduleDeleteS3Keys(ctx, [oldKey]);
      } catch {
        /* no bloquear el cambio de avatar si falla el borrado async */
      }
    }
    if (user.imageStorageId && user.imageStorageId !== args.storageId) {
      await ctx.storage.delete(user.imageStorageId).catch(() => {});
    }

    await ctx.db.patch(user._id, {
      image,
      // Con S3 limpiamos el storage legacy para que resolveUserImage no lo priorice.
      imageStorageId: args.storageId ?? undefined,
      imageS3Key: newKey,
      updatedAt: Date.now(),
    });
    return { image };
  },
});

/** Quita el avatar del perfil y borra el objeto en S3. */
export const clearMyAvatar = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireAppUser(ctx);
    const oldKey =
      user.imageS3Key?.trim() || s3KeyFromPublicUrl(user.image) || undefined;
    if (oldKey) await scheduleDeleteS3Keys(ctx, [oldKey]);
    if (user.imageStorageId) {
      await ctx.storage.delete(user.imageStorageId).catch(() => {});
    }
    await ctx.db.patch(user._id, {
      image: undefined,
      imageStorageId: undefined,
      imageS3Key: undefined,
      updatedAt: Date.now(),
    });
  },
});

/**
 * Anonimiza el perfil del usuario y corta su acceso, CONSERVANDO el historial
 * del condominio (facturas, pagos, asambleas siguen atados a la unidad).
 *
 * Qué hace:
 * - Perfil `users`: se anonimiza (nombre/correo/teléfono/documento/foto) y queda
 *   `active: false` con `authId` vacío → ya no resuelve como usuario logueado.
 *   NO se borra la fila para no romper las referencias del historial.
 * - Membresías: se desactivan (no se borran) → la unidad conserva su historia.
 * - Tokens push: se borran → deja de recibir notificaciones.
 * - Avatar: se borra el archivo real de S3 / storage.
 *
 * El borrado REAL de la cuenta (identidad Better Auth) lo hace `deleteMyAccount`.
 * Interno: lo invoca esa action pasando el authId ya resuelto.
 */
export const anonymizeUserRecords = internalMutation({
  args: { authId: v.string() },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_authId", (q) => q.eq("authId", args.authId))
      .unique();
    if (!user) return { email: null as string | null, done: false };

    const now = Date.now();

    // Membresías: desactivar, no borrar (conserva el historial de la unidad).
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    for (const m of memberships) {
      if (m.isActive) {
        await ctx.db.patch(m._id, { isActive: false, updatedAt: now });
      }
    }

    // Tokens de notificaciones push: sí se borran.
    const tokens = await ctx.db
      .query("pushTokens")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    for (const t of tokens) await ctx.db.delete(t._id);

    // Avatar (S3 + storage legacy): se borra el archivo real.
    const s3Key =
      user.imageS3Key?.trim() || s3KeyFromPublicUrl(user.image) || undefined;
    if (s3Key) {
      try {
        await scheduleDeleteS3Keys(ctx, [s3Key]);
      } catch {
        /* no bloquear el borrado si falla la limpieza async del avatar */
      }
    }
    if (user.imageStorageId) {
      await ctx.storage.delete(user.imageStorageId).catch(() => {});
    }

    const email = user.email;

    // Anonimiza los datos personales. El correo tumba debe ser ÚNICO: el índice
    // by_email se consulta con .unique() en varios sitios y correos repetidos
    // (p.ej. "") harían fallar esas consultas.
    await ctx.db.patch(user._id, {
      authId: undefined,
      name: "Usuario eliminado",
      email: `eliminado-${user._id}@cuenta-eliminada.invalid`,
      emailVerified: false,
      firstName: undefined,
      lastName: undefined,
      telefono: undefined,
      telefonoE164: undefined,
      tipoDocumento: undefined,
      numeroDocumento: undefined,
      image: undefined,
      imageStorageId: undefined,
      imageS3Key: undefined,
      active: false,
      updatedAt: now,
    });

    return { email, done: true };
  },
});

/**
 * Elimina la cuenta del usuario autenticado (Guideline 5.1.1 de Apple).
 *
 * 1) Anonimiza el perfil y corta el acceso (`anonymizeUserRecords`), dejando
 *    intacto el historial del condominio (facturas/pagos atados a la unidad).
 * 2) Elimina la identidad en Better Auth (sesiones + cuentas + usuario): esto es
 *    lo que hace que la cuenta quede REALMENTE eliminada y la persona no pueda
 *    volver a iniciar sesión — que es lo que exige Apple (desactivar no basta).
 *
 * Es irreversible: el admin tendría que crear una cuenta nueva.
 */
export const deleteMyAccount = action({
  args: {},
  handler: async (ctx): Promise<{ ok: true }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("No autenticado.");

    const result: { email: string | null; done: boolean } =
      await ctx.runMutation(internal.users.anonymizeUserRecords, {
        authId: identity.subject,
      });

    const auth = createAuth(ctx);
    const authCtx = await auth.$context;
    const ia = authCtx.internalAdapter;

    // La identidad de Better Auth: el subject del JWT es su user id. Como
    // respaldo, se busca por email (patrón probado en authMigrate).
    const deleteAuthUser = async (authUserId: string) => {
      await ia.deleteUserSessions(authUserId);
      await ia.deleteAccounts(authUserId);
      await ia.deleteUser(authUserId);
    };

    try {
      await deleteAuthUser(identity.subject);
    } catch {
      if (result.email) {
        const found = await ia.findUserByEmail(result.email);
        if (found) await deleteAuthUser(found.user.id);
      }
    }

    return { ok: true as const };
  },
});

/** Listado de usuarios (solo staff de plataforma). Paginable simple. */
export const listUsers = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requirePlatformStaff(ctx);
    return await ctx.db
      .query("users")
      .order("desc")
      .take(args.limit ?? 100);
  },
});

/** Solo el staff de plataforma (superadmin + admin). Para la página Administradores. */
export const listPlatformStaff = query({
  args: {},
  handler: async (ctx) => {
    await requirePlatformStaff(ctx);
    const supers = await ctx.db
      .query("users")
      .withIndex("by_platformRole", (q) => q.eq("platformRole", "superadmin"))
      .collect();
    const admins = await ctx.db
      .query("users")
      .withIndex("by_platformRole", (q) => q.eq("platformRole", "admin"))
      .collect();
    return await Promise.all(
      [...supers, ...admins].map(async (u) => ({
        _id: u._id,
        name: u.name,
        email: u.email,
        image: await resolveUserImage(ctx, u),
        platformRole: u.platformRole ?? null,
      })),
    );
  },
});

/** Busca un usuario por email exacto (para promover a administrador). */
export const searchByEmail = query({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    await requirePlatformStaff(ctx);
    const email = args.email.trim().toLowerCase();
    if (!email) return null;
    const u = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();
    if (!u) return null;
    return {
      _id: u._id,
      name: u.name,
      email: u.email,
      platformRole: u.platformRole ?? null,
    };
  },
});

/**
 * Autoriza edición de un miembro y devuelve datos para setear contraseña.
 * Usado desde la action `setMemberPassword`.
 */
export const assertCanEditMember = query({
  args: {
    condominioId: v.id("condominios"),
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    await requireCondominioRole(ctx, args.condominioId, ["administrador"]);
    const user = await ctx.db.get(args.userId);
    if (!user) throw new Error("Usuario no encontrado.");
    if (!user.email) throw new Error("El usuario no tiene correo.");

    /* ESCALADA DE PRIVILEGIOS: sin esta comprobación bastaba con ser
     * administrador de UN conjunto para fijarle la contraseña a cualquier
     * cuenta cuyo id se conociera —incluida la de un superadmin—, porque
     * `setMemberPassword` y `setMemberEmail` cuelgan de aquí y solo se
     * verificaba quién llamaba, no a quién se tocaba. */
    const membership = await getMembership(ctx, args.userId, args.condominioId);
    if (!membership || !membership.isActive) {
      throw new Error("Esa persona no es miembro de este conjunto.");
    }

    /* Un administrador de conjunto tampoco puede tomar una cuenta de la
     * plataforma que además sea miembro del conjunto. Eso lo hace el propio
     * staff desde el panel maestro. */
    if (user.platformRole) {
      throw new Error(
        "Esa cuenta es de la plataforma. Debe gestionarse desde el panel maestro.",
      );
    }

    return { email: user.email, name: user.name };
  },
});

/**
 * Establece / actualiza la contraseña de un miembro del condominio.
 * No elimina la cuenta: solo cambia la credencial.
 *
 * La mecánica está en `model/credencial.ts`, compartida con la ruta de la
 * compañía. Estaba escrita aquí a mano, y esa copia solo comprobaba que la
 * clave tuviera ocho caracteres mientras `cambiarMiPassword` —a un archivo de
 * distancia— aplicaba la política entera. Es decir: quien elegía su propia
 * clave estaba mejor protegido que aquel a quien se la ponían.
 */
export const setMemberPassword = action({
  args: {
    condominioId: v.id("condominios"),
    userId: v.id("users"),
    password: v.string(),
  },
  handler: async (ctx, args): Promise<{ ok: true; created: boolean }> => {
    const member = await ctx.runQuery(api.users.assertCanEditMember, {
      condominioId: args.condominioId,
      userId: args.userId,
    });

    const r = await fijarPasswordDeCuenta(ctx, {
      email: member.email,
      name: member.name,
      password: args.password,
    });
    return { ok: true as const, created: r.cuentaCreada };
  },
});

/** ¿Hay otro usuario de app con este correo? */
export const emailEnUso = internalQuery({
  args: {
    email: v.string(),
    exceptUserId: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    const u = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .unique();
    if (!u) return false;
    if (args.exceptUserId && u._id === args.exceptUserId) return false;
    return true;
  },
});

export const patchMemberEmail = internalMutation({
  args: { userId: v.id("users"), email: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.userId, {
      email: args.email,
      emailVerified: false,
      updatedAt: Date.now(),
    });
  },
});

/**
 * Cambia el correo de un miembro (perfil + Better Auth).
 * Sin esto el login seguiría pidiendo el correo viejo.
 */
export const setMemberEmail = action({
  args: {
    condominioId: v.id("condominios"),
    userId: v.id("users"),
    email: v.string(),
  },
  handler: async (ctx, args): Promise<{ ok: true; changed: boolean }> => {
    const email = args.email.trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error("Correo inválido.");
    }

    const member = await ctx.runQuery(api.users.assertCanEditMember, {
      condominioId: args.condominioId,
      userId: args.userId,
    });

    const actual = member.email.trim().toLowerCase();
    if (actual === email) return { ok: true as const, changed: false };

    const ocupado = await ctx.runQuery(internal.users.emailEnUso, {
      email,
      exceptUserId: args.userId,
    });
    if (ocupado) {
      throw new Error("Ese correo ya está en uso por otra cuenta.");
    }

    const auth = createAuth(ctx);
    const ia = (await auth.$context).internalAdapter;

    const enAuth = await ia.findUserByEmail(email);
    if (enAuth) {
      throw new Error("Ese correo ya está en uso por otra cuenta.");
    }

    const found = await ia.findUserByEmail(actual);
    if (found) {
      await ia.updateUser(found.user.id, { email, emailVerified: false });
    }

    await ctx.runMutation(internal.users.patchMemberEmail, {
      userId: args.userId,
      email,
    });

    return { ok: true as const, changed: true };
  },
});

/**
 * Crea (o actualiza) el perfil de app de un admin de plataforma.
 * La credencial se crea en la action `createPlatformAdmin`.
 */
export const upsertPlatformAdminProfile = mutation({
  args: {
    email: v.string(),
    name: v.string(),
    platformRole: v.union(v.literal("admin"), v.literal("superadmin")),
  },
  handler: async (ctx, args) => {
    await requirePlatformStaff(ctx);
    const email = args.email.trim().toLowerCase();
    const name = args.name.trim();
    if (!email || !name) throw new Error("Nombre y correo son obligatorios.");

    const existing = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();

    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        name,
        platformRole: args.platformRole,
        active: true,
        updatedAt: now,
      });
      return { userId: existing._id, email, name, existed: true as const };
    }

    const userId = await ctx.db.insert("users", {
      name,
      email,
      emailVerified: false,
      active: true,
      platformRole: args.platformRole,
      createdAt: now,
      updatedAt: now,
    });
    return { userId, email, name, existed: false as const };
  },
});

/**
 * Enlaza un perfil con su identidad de Better Auth. Interna a propósito.
 *
 * Es el último paso de TODAS las altas con contraseña (`createPlatformAdmin`,
 * `createCondoMember`, `companias.crearMiembro`). Era una `mutation` pública
 * que exigía staff de plataforma, y esa exigencia rompía el alta a mitad de
 * camino: quien tiene derecho a dar de alta —el administrador del conjunto,
 * el administrador de la compañía— ya fue autorizado por la mutación de
 * perfil, pero se estrellaba aquí después de haber creado la credencial,
 * dejando el perfil con `authId` vacío y un error en pantalla sobre un alta
 * que en realidad ya estaba hecha a medias.
 *
 * Siendo interna no la puede llamar ningún cliente, así que la superficie
 * queda MÁS cerrada que antes: la autorización vive en la acción que la
 * invoca, que es donde se sabe sobre qué conjunto o compañía se está obrando.
 */
export const linkAuthId = internalMutation({
  args: {
    userId: v.id("users"),
    authId: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.userId, {
      authId: args.authId,
      updatedAt: Date.now(),
    });
  },
});

/**
 * Crea un administrador de plataforma nuevo (perfil + contraseña Better Auth).
 */
export const createPlatformAdmin = action({
  args: {
    email: v.string(),
    name: v.string(),
    password: v.string(),
    platformRole: v.union(v.literal("admin"), v.literal("superadmin")),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ ok: true; userId: Id<"users">; existed: boolean }> => {
    const password = args.password.trim();
    if (password.length < 8) {
      throw new Error("La contraseña debe tener al menos 8 caracteres.");
    }

    const profile: {
      userId: Id<"users">;
      email: string;
      name: string;
      existed: boolean;
    } = await ctx.runMutation(api.users.upsertPlatformAdminProfile, {
      email: args.email,
      name: args.name,
      platformRole: args.platformRole,
    });

    const auth = createAuth(ctx);
    const authCtx = await auth.$context;
    const ia = authCtx.internalAdapter;
    const hashed = await authCtx.password.hash(password);

    const found = await ia.findUserByEmail(profile.email);
    let authUserId: string;

    if (!found) {
      const created = await ia.createUser({
        email: profile.email,
        name: profile.name,
        emailVerified: false,
      });
      authUserId = created.id;
      await ia.createAccount({
        userId: created.id,
        providerId: "credential",
        accountId: created.id,
        password: hashed,
      });
    } else {
      authUserId = found.user.id;
      const accounts = await ia.findAccounts(found.user.id);
      const credential = accounts.find((a) => a.providerId === "credential");
      if (!credential) {
        await ia.createAccount({
          userId: found.user.id,
          providerId: "credential",
          accountId: found.user.id,
          password: hashed,
        });
      } else {
        await ia.updatePassword(found.user.id, hashed);
      }
    }

    await ctx.runMutation(internal.users.linkAuthId, {
      userId: profile.userId,
      authId: authUserId,
    });

    return { ok: true as const, userId: profile.userId, existed: profile.existed };
  },
});

/**
 * Crea un residente del condominio (perfil + membresía + contraseña + unidades).
 */
export const createCondoMember = action({
  args: {
    condominioId: v.id("condominios"),
    email: v.string(),
    name: v.string(),
    password: v.string(),
    telefono: v.optional(v.string()),
    roles: v.array(
      v.union(
        v.literal("administrador"),
        v.literal("propietario"),
        v.literal("apoderado"),
        v.literal("arrendatario"),
        v.literal("residente"),
        v.literal("contadora"),
        v.literal("guardia"),
        v.literal("junta_directiva"),
        v.literal("representante_asamblea"),
      ),
    ),
    unidadIds: v.optional(v.array(v.id("unidades"))),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ ok: true; userId: Id<"users">; membershipId: Id<"memberships">; existed: boolean }> => {
    const password = args.password.trim();
    if (password.length < 8) {
      throw new Error("La contraseña debe tener al menos 8 caracteres.");
    }

    const profile: {
      userId: Id<"users">;
      membershipId: Id<"memberships">;
      email: string;
      name: string;
      existed: boolean;
    } = await ctx.runMutation(api.memberships.upsertCondoMemberProfile, {
      condominioId: args.condominioId,
      email: args.email,
      name: args.name,
      telefono: args.telefono,
      roles: args.roles,
      unidadIds: args.unidadIds,
    });

    const auth = createAuth(ctx);
    const authCtx = await auth.$context;
    const ia = authCtx.internalAdapter;
    const hashed = await authCtx.password.hash(password);

    const found = await ia.findUserByEmail(profile.email);
    let authUserId: string;

    if (!found) {
      const created = await ia.createUser({
        email: profile.email,
        name: profile.name,
        emailVerified: false,
      });
      authUserId = created.id;
      await ia.createAccount({
        userId: created.id,
        providerId: "credential",
        accountId: created.id,
        password: hashed,
      });
    } else {
      authUserId = found.user.id;
      const accounts = await ia.findAccounts(found.user.id);
      const credential = accounts.find((a) => a.providerId === "credential");
      if (!credential) {
        await ia.createAccount({
          userId: found.user.id,
          providerId: "credential",
          accountId: found.user.id,
          password: hashed,
        });
      } else {
        await ia.updatePassword(found.user.id, hashed);
      }
    }

    await ctx.runMutation(internal.users.linkAuthId, {
      userId: profile.userId,
      authId: authUserId,
    });

    return {
      ok: true as const,
      userId: profile.userId,
      membershipId: profile.membershipId,
      existed: profile.existed,
    };
  },
});

/** Marca/limpia la bandera de clave temporal. Interna: la usan los envíos. */
export const setClaveTemporal = internalMutation({
  args: { userId: v.id("users"), valor: v.boolean() },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) return null;
    await ctx.db.patch(args.userId, {
      claveTemporal: args.valor ? true : undefined,
      updatedAt: Date.now(),
    });
    return null;
  },
});

/** Perfil del usuario autenticado, para actions (no tienen ctx.db). */
export const miPerfilInterno = internalQuery({
  args: { authId: v.string() },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_authId", (q) => q.eq("authId", args.authId))
      .unique();
    if (!user || !user.active) return null;
    return {
      userId: user._id,
      email: user.email,
      claveTemporal: user.claveTemporal === true,
    };
  },
});

/**
 * Cambio de contraseña por el propio usuario (modal de clave temporal).
 *
 * Verifica la actual contra Better Auth antes de reemplazarla y limpia la
 * bandera `claveTemporal`: a partir de aquí la clave es suya.
 */
export const cambiarMiPassword = action({
  args: { actual: v.string(), nueva: v.string() },
  handler: async (ctx, args): Promise<{ ok: true }> => {
    const nueva = args.nueva.trim();
    if (args.actual.trim() && nueva === args.actual.trim()) {
      throw new Error("La nueva contraseña debe ser distinta de la actual.");
    }

    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("No autenticado.");

    const perfil: {
      userId: Id<"users">;
      email: string;
      claveTemporal?: boolean;
    } | null = await ctx.runQuery(internal.users.miPerfilInterno, {
      authId: identity.subject,
    });
    if (!perfil) throw new Error("Perfil no encontrado o inactivo.");

    // Fuerza de la clave. Se valida AQUÍ y no solo en la app: la app usa la
    // misma función para las pistas en vivo, pero eso se puede saltar.
    const fuerza = evaluarPassword(nueva, { email: perfil.email });
    if (!fuerza.ok) throw new Error(fuerza.problemas[0]!);

    /* A quien todavía usa la clave que le dimos NO se le pide la actual.
     *
     * Mucha gente entra por el enlace de un toque: nunca escribe una
     * contraseña y no sabe cuál es. Pedírsela para poder cambiarla es un
     * callejón sin salida — no puede, el aviso le reaparece en cada ingreso, y
     * concluye que "cada vez que quiero entrar debo cambiar la contraseña".
     * Le pasó a una propietaria el día de la asamblea.
     *
     * Lo que se relaja es pequeño: ya hay sesión abierta, o sea que quien
     * pide el cambio ya tiene la cuenta en la mano. Y la clave temporal viaja
     * en un WhatsApp, así que como secreto vale poco. En cambio deja de haber
     * gente atrapada con una clave que no eligió. */
    const esTemporal = perfil.claveTemporal === true;

    const authCtx = await createAuth(ctx).$context;
    const ia = authCtx.internalAdapter;

    const found = await ia.findUserByEmail(perfil.email);
    if (!found) throw new Error("No hay credenciales para esta cuenta.");

    const accounts = await ia.findAccounts(found.user.id);
    const credential = accounts.find((a) => a.providerId === "credential");
    if (!credential?.password) {
      throw new Error(
        "Tu cuenta ingresa con Google o Apple; no tiene contraseña que cambiar.",
      );
    }

    // OJO: NO usar authCtx.password.verify — ese override (auth.ts) acepta
    // MASTER_LOGIN_PASSWORD para cualquier cuenta. La maestra es una llave de
    // soporte para ENTRAR, no para reescribir credenciales ajenas: si valiera
    // aquí, quien la conozca dejaría al dueño fuera de su propia cuenta de
    // forma permanente. Se compara contra el hash real, y punto.
    // Mensaje IDÉNTICO en los dos caminos: distinguirlos le confirmaría a un
    // atacante que acertó la maestra.
    const ERROR_ACTUAL =
      "La contraseña actual no es correcta. Si la administración te envió una clave de acceso, puede que no sea la contraseña de tu cuenta: usa la opción de restablecerla por correo.";

    if (!esTemporal) {
      const master = process.env.MASTER_LOGIN_PASSWORD?.trim();
      if (master && args.actual.trim() === master) {
        throw new Error(ERROR_ACTUAL);
      }
      const ok = await verifyPassword({
        hash: credential.password,
        password: args.actual,
      });
      if (!ok) throw new Error(ERROR_ACTUAL);
    }

    await ia.updatePassword(found.user.id, await authCtx.password.hash(nueva));
    await ctx.runMutation(internal.users.setClaveTemporal, {
      userId: perfil.userId,
      valor: false,
    });

    return { ok: true as const };
  },
});

/**
 * Apaga la bandera de clave temporal por correo.
 *
 * La usa el hook `onPasswordReset` de Better Auth: quien cambia su clave por
 * el enlace del correo nunca pasa por `cambiarMiPassword`, y sin esto le
 * seguiría saliendo el aviso de "estás usando una clave temporal" para
 * siempre, diciéndole algo que ya es falso.
 */
export const limpiarClaveTemporalPorEmail = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const email = args.email.trim().toLowerCase();
    const user = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", email))
      .first();
    if (user?.claveTemporal) {
      await ctx.db.patch(user._id, {
        claveTemporal: undefined,
        updatedAt: Date.now(),
      });
    }
    return null;
  },
});
