import { v } from "convex/values";
import { query, mutation, internalMutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import {
  getCurrentAppUser,
  getMembership,
  requireAppUser,
  requirePlatformStaff,
  requireSuperadmin,
  requireCondominioRole,
  hasPlatformRole,
} from "./model/authz";
import { resolverAcceso } from "./model/acceso";
import { subscriptionPlanValidator } from "./model/roles";
import { displayNameFromUser } from "./model/displayName";
import { resolveUserImage } from "./model/userImage";
import { normalizarNura } from "./lib/avalConvenio";

/** Admins operativos únicos de un condominio (sin duplicados por userId). */
async function listCondoAdmins(
  ctx: QueryCtx | MutationCtx,
  condominioId: Id<"condominios">,
) {
  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_condominio", (q) => q.eq("condominioId", condominioId))
    .collect();

  const active = memberships.filter((m) => m.isActive);
  const seen = new Set<string>();
  const admins: Array<{
    _id: Id<"users">;
    membershipId: Id<"memberships">;
    name: string;
    email: string;
    image: string | null;
    telefono: string | null;
    roles: string[];
  }> = [];

  for (const m of active) {
    if (!m.roles.includes("administrador")) continue;
    if (seen.has(m.userId)) continue;
    seen.add(m.userId);

    const u = await ctx.db.get(m.userId);
    if (!u || !u.active) continue;

    admins.push({
      _id: u._id,
      membershipId: m._id,
      name: u.name,
      email: u.email,
      image: await resolveUserImage(ctx, u),
      telefono: u.telefono ?? null,
      roles: m.roles,
    });
  }

  admins.sort((a, b) => a.name.localeCompare(b.name, "es"));
  return { admins, activeCount: active.length };
}

/**
 * Condominios visibles para el usuario actual:
 *  - Plataforma (superadmin/admin): todos.
 *  - Resto: solo aquellos donde tiene membresía activa.
 */
export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireAppUser(ctx);

    if (hasPlatformRole(user, "superadmin", "admin")) {
      return await ctx.db.query("condominios").order("desc").collect();
    }

    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();

    const condos = await Promise.all(
      memberships
        .filter((m) => m.isActive)
        .map((m) => ctx.db.get(m.condominioId)),
    );
    return condos.filter((c) => c !== null);
  },
});

/**
 * Home del área de administración de UN condominio. Autoriza el acceso
 * (staff de plataforma, o miembro con rol administrativo del condominio) y
 * devuelve la info + conteos + los roles del usuario en ese condominio.
 */
export const adminHome = query({
  args: { condominioId: v.id("condominios") },
  handler: async (ctx, args) => {
    const user = await getCurrentAppUser(ctx);
    if (!user) return { allowed: false as const };

    const condominio = await ctx.db.get(args.condominioId);
    if (!condominio) return { allowed: false as const };

    const isPlatform = hasPlatformRole(user, "superadmin", "admin");
    const membership = await getMembership(ctx, user._id, args.condominioId);
    const ADMIN_ROLES = ["administrador", "contadora"];
    const canAdmin =
      isPlatform ||
      (!!membership &&
        membership.isActive &&
        membership.roles.some((r) => ADMIN_ROLES.includes(r)));

    if (!canAdmin) return { allowed: false as const };

    // NOTA: esta consulta corre en el shell en CADA página del área admin.
    // Por eso NO lee membresías/unidades completas (serían ~cientos de docs por
    // navegación → gran gasto de E/S). Los conteos del dashboard se piden aparte
    // con `condominios.detail`, que solo se monta en la home del condominio.
    return {
      allowed: true as const,
      isPlatform,
      userName: displayNameFromUser(user),
      userImage: user.image ?? null,
      myRoles: membership?.roles ?? [],
      condominio: {
        _id: condominio._id,
        name: condominio.name,
        city: condominio.city ?? null,
        nit: condominio.nit ?? null,
        logo: condominio.logo ?? null,
        coverImage: condominio.coverImage ?? null,
        primaryColor: condominio.primaryColor ?? null,
        subscriptionPlan: condominio.subscriptionPlan ?? null,
        isActive: condominio.isActive,
        legacyId: condominio.legacyId ?? null,
        legacyDatabaseName: condominio.legacyDatabaseName ?? null,
      },
    };
  },
});

/** Control maestro: todos los condominios (solo plataforma). */
export const listAll = query({
  args: { onlyActive: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    await requirePlatformStaff(ctx);
    const all = await ctx.db.query("condominios").order("desc").collect();
    const filtered = args.onlyActive ? all.filter((c) => c.isActive) : all;

    return await Promise.all(
      filtered.map(async (c) => {
        const { admins, activeCount } = await listCondoAdmins(ctx, c._id);
        return {
          ...c,
          memberCount: activeCount,
          adminCount: admins.length,
          admins: admins.map(
            ({ membershipId: _m, telefono: _t, roles: _r, ...a }) => a,
          ),
        };
      }),
    );
  },
});

export const get = query({
  args: { condominioId: v.id("condominios") },
  handler: async (ctx, args) => {
    /* Antes bastaba con tener sesión: cualquier residente de cualquier
     * conjunto podía leer los datos institucionales de todos los demás
     * cambiando el id de la petición. Ahora hay que pertenecer.
     *
     * Se acepta la vía de compañía además de la membresía: un guarda
     * contratado no tiene membresía en el conjunto y aun así necesita la
     * marca para pintar su pantalla de portería. Y la cobertura, por lo
     * mismo: el guarda que cubre este conjunto pinta su portería.
     *
     * Con las vías OPERATIVAS, como todo lo demás: mientras un guarda cubre
     * otro conjunto, sus vías de guarda de aquí —la asignación y una
     * membresía que solo es de guarda— no le abren la ficha. Sin cobertura,
     * `rolesConjunto` es exactamente "tiene membresía activa". */
    const acceso = await resolverAcceso(ctx, args.condominioId);
    if (!acceso) throw new Error("No autenticado o perfil inexistente.");
    const pertenece =
      acceso.esPlataforma ||
      acceso.rolesConjunto !== null ||
      !!acceso.asignacion ||
      !!acceso.cobertura;
    if (!pertenece) throw new Error("No tiene acceso a este conjunto.");

    return await ctx.db.get(args.condominioId);
  },
});

/** Detalle + conteos (miembros, unidades) para la vista de condominio. */
export const detail = query({
  args: { condominioId: v.id("condominios") },
  handler: async (ctx, args) => {
    /* Devuelve la lista de administradores con sus datos de contacto, así que
     * exige rol de gestión y no solo pertenencia. */
    await requireCondominioRole(ctx, args.condominioId, [
      "administrador",
      "contadora",
      "junta_directiva",
    ]);
    const condominio = await ctx.db.get(args.condominioId);
    if (!condominio) return null;

    const unidades = await ctx.db
      .query("unidades")
      .withIndex("by_condominio", (q) =>
        q.eq("condominioId", args.condominioId),
      )
      .collect();

    const occupiedCount = unidades.filter((u) => u.estado === "ocupada").length;
    const { admins, activeCount } = await listCondoAdmins(
      ctx,
      args.condominioId,
    );

    return {
      condominio,
      memberCount: activeCount,
      unidadCount: unidades.length,
      occupiedCount,
      admins,
    };
  },
});

export const create = mutation({
  args: {
    name: v.string(),
    subdomain: v.optional(v.string()),
    nit: v.optional(v.string()),
    address: v.optional(v.string()),
    city: v.optional(v.string()),
    country: v.optional(v.string()),
    timezone: v.optional(v.string()),
    subscriptionPlan: v.optional(subscriptionPlanValidator),
    unitLimit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requirePlatformStaff(ctx);
    const now = Date.now();
    return await ctx.db.insert("condominios", {
      ...args,
      country: args.country ?? "Colombia",
      timezone: args.timezone ?? "America/Bogota",
      subscriptionPlan: args.subscriptionPlan ?? "basico",
      activeModules: [],
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const update = mutation({
  args: {
    condominioId: v.id("condominios"),
    patch: v.object({
      name: v.optional(v.string()),
      subdomain: v.optional(v.string()),
      nit: v.optional(v.string()),
      address: v.optional(v.string()),
      city: v.optional(v.string()),
      /** String vacía = quitar logo. */
      logo: v.optional(v.string()),
      /** String vacía = quitar foto destacada. */
      coverImage: v.optional(v.string()),
      primaryColor: v.optional(v.string()),
      subscriptionPlan: v.optional(subscriptionPlanValidator),
      unitLimit: v.optional(v.number()),
      activeModules: v.optional(v.array(v.string())),
      avalPortalUrl: v.optional(v.string()),
      /** Nura de Aval ("30830" o "00030830"). String vacía = quitarlo. */
      avalNura: v.optional(v.string()),
    }),
  },
  handler: async (ctx, args) => {
    await requirePlatformStaff(ctx);
    const condo = await ctx.db.get(args.condominioId);
    if (!condo) throw new Error("Condominio no encontrado.");

    const p = args.patch;
    const next = {
      ...condo,
      ...(p.name !== undefined ? { name: p.name.trim() } : {}),
      ...(p.subdomain !== undefined
        ? { subdomain: p.subdomain.trim() || undefined }
        : {}),
      ...(p.nit !== undefined ? { nit: p.nit.trim() || undefined } : {}),
      ...(p.address !== undefined
        ? { address: p.address.trim() || undefined }
        : {}),
      ...(p.city !== undefined ? { city: p.city.trim() || undefined } : {}),
      ...(p.logo !== undefined ? { logo: p.logo.trim() || undefined } : {}),
      ...(p.coverImage !== undefined
        ? { coverImage: p.coverImage.trim() || undefined }
        : {}),
      ...(p.primaryColor !== undefined
        ? { primaryColor: p.primaryColor.trim() || undefined }
        : {}),
      ...(p.subscriptionPlan !== undefined
        ? { subscriptionPlan: p.subscriptionPlan }
        : {}),
      ...(p.unitLimit !== undefined ? { unitLimit: p.unitLimit } : {}),
      ...(p.activeModules !== undefined
        ? { activeModules: p.activeModules }
        : {}),
      ...(p.avalPortalUrl !== undefined
        ? { avalPortalUrl: p.avalPortalUrl.trim() || undefined }
        : {}),
      ...(p.avalNura !== undefined
        ? { avalNura: normalizarNura(p.avalNura) ?? undefined }
        : {}),
      updatedAt: Date.now(),
    };

    // replace para poder limpiar campos opcionales (logo, city, etc.)
    const { _id, _creationTime, ...body } = next;
    await ctx.db.replace(args.condominioId, body);
  },
});

/**
 * Activa o desactiva un módulo del condominio (p.ej. "whatsapp").
 * `activeModules` es la lista blanca que gatea features por tenant:
 * el bot y los broadcasts de WhatsApp solo operan si "whatsapp" está aquí.
 */
export const toggleModulo = mutation({
  args: {
    condominioId: v.id("condominios"),
    modulo: v.string(),
    activo: v.boolean(),
  },
  handler: async (ctx, args) => {
    await requirePlatformStaff(ctx);
    const condo = await ctx.db.get(args.condominioId);
    if (!condo) throw new Error("Condominio no encontrado.");

    const sin = condo.activeModules.filter((m) => m !== args.modulo);
    const activeModules = args.activo ? [...sin, args.modulo] : sin;
    await ctx.db.patch(args.condominioId, {
      activeModules,
      updatedAt: Date.now(),
    });
    return activeModules;
  },
});

/**
 * Helper interno para fijar la URL del portal de pagos AvalPayCenter de un
 * condominio (deep-link por convenio). Uso puntual desde CLI/soporte.
 */
export const setAvalPortalUrl = internalMutation({
  args: { condominioId: v.id("condominios"), url: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.condominioId, {
      avalPortalUrl: args.url,
      updatedAt: Date.now(),
    });
    return { ok: true as const };
  },
});

/**
 * Helper interno para fijar el Nura de Aval de un condominio (convenio con
 * que paga por API). Uso puntual desde CLI/soporte. Sin `nura`, lo quita.
 */
export const setAvalNura = internalMutation({
  args: { condominioId: v.id("condominios"), nura: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const avalNura = normalizarNura(args.nura) ?? undefined;
    await ctx.db.patch(args.condominioId, { avalNura, updatedAt: Date.now() });
    return { avalNura: avalNura ?? null };
  },
});

/** Activar / desactivar un condominio (control maestro). */
export const setActive = mutation({
  args: { condominioId: v.id("condominios"), isActive: v.boolean() },
  handler: async (ctx, args) => {
    await requireSuperadmin(ctx);
    await ctx.db.patch(args.condominioId, {
      isActive: args.isActive,
      updatedAt: Date.now(),
    });
  },
});
