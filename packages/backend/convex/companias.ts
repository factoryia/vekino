import { v } from "convex/values";
import { obtenerOperacionCompania } from "./model/operacionCompania";

import {
  query,
  mutation,
  action,
  internalMutation,
} from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { createAuth } from "./auth";
import {
  getCurrentAppUser,
  requireAppUser,
  requirePlatformStaff,
} from "./model/authz";
import {
  exigirAccesoCompania,
  exigirAccesoContrato,
  getCompaniaMiembro,
  condominiosSupervisados,
  miCompaniaDe,
} from "./model/acceso";
import {
  companiaRoleValidator,
  estadoCompaniaValidator,
  exigirRolUnicoCompania,
  rolPrincipalDeCompania,
  tipoDocumentoValidator,
} from "./model/roles";
import { estadoVigencia, haySolape, estaVigente } from "./lib/vigilancia";
import { normalizarTelefonoE164 } from "./lib/telefono";
import { evaluarPassword } from "./lib/passwordFuerte";
import { displayNameFromUser } from "./model/displayName";
import { fijarPasswordDeCuenta } from "./model/credencial";

/**
 * Compañías de vigilancia: la empresa, su personal y sus contratos.
 *
 * Las asignaciones —quién opera en qué conjunto— viven en `asignaciones.ts`,
 * porque son la relación entre los dos ejes y no un detalle de la compañía.
 *
 * Quién manda sobre qué:
 *   - Crear compañías y firmar contratos es de la PLATAFORMA. Es la relación
 *     comercial del SaaS, no una decisión de la empresa de vigilancia ni del
 *     conjunto.
 *   - Administrar el personal propio es de la compañía (`admin_compania`).
 */

// ─────────────────────────────────────────────────────────────
// Lectura
// ─────────────────────────────────────────────────────────────

/** Panel inicial del administrador: agregados de las fuentes de portería. */
export const operacion = query({
  args: {
    desde: v.string(),
    hasta: v.string(),
    condominioId: v.optional(v.id("condominios")),
    guardiaUserId: v.optional(v.id("users")),
    granularidad: v.union(v.literal("dia"), v.literal("semana"), v.literal("mes")),
  },
  handler: obtenerOperacionCompania,
});

/**
 * Compañías con sus conteos. Solo plataforma.
 *
 * `archivo` separa las dos vistas EN EL SERVIDOR y no en la pantalla: que una
 * compañía dada de baja no aparezca entre las activas es una regla del
 * modelo, no una decisión de pintado. Por omisión, las que no están
 * archivadas —incluidas las suspendidas, que siguen siendo una situación
 * temporal y no el final del camino—.
 */
export const listAll = query({
  args: { archivo: v.optional(v.union(v.literal("activas"), v.literal("archivadas"))) },
  handler: async (ctx, args) => {
    await requirePlatformStaff(ctx);
    const todas = await ctx.db.query("companiasSeguridad").order("desc").collect();
    const archivadas = args.archivo === "archivadas";
    const filtradas = todas.filter((c) =>
      archivadas ? c.estado === "inactiva" : c.estado !== "inactiva",
    );

    return await Promise.all(
      filtradas.map(async (c) => {
        const miembros = await ctx.db
          .query("companiaMiembros")
          .withIndex("by_compania", (q) => q.eq("companiaId", c._id))
          .collect();
        const contratos = await ctx.db
          .query("companiaContratos")
          .withIndex("by_compania", (q) => q.eq("companiaId", c._id))
          .collect();
        const activos = miembros.filter((m) => m.isActive);
        const archivadaPor = c.archivadaPorUserId
          ? await ctx.db.get(c.archivadaPorUserId)
          : null;
        return {
          ...c,
          personalCount: activos.length,
          supervisorCount: activos.filter((m) => m.roles.includes("supervisor"))
            .length,
          guardiaCount: activos.filter((m) => m.roles.includes("guardia")).length,
          contratosVigentes: contratos.filter((k) => estaVigente(k)).length,
          /* El histórico entero sigue ahí: se dice cuánto hay, no se borra. */
          contratosTotales: contratos.length,
          archivadaEn: c.archivadaEn ?? null,
          archivadaPorNombre: archivadaPor
            ? displayNameFromUser(archivadaPor)
            : null,
        };
      }),
    );
  },
});

/** Hidrata un miembro con su perfil de usuario. */
async function hidratarMiembro(ctx: QueryCtx, m: Doc<"companiaMiembros">) {
  const u = await ctx.db.get(m.userId);
  const asignaciones = await ctx.db
    .query("asignaciones")
    .withIndex("by_miembro", (q) => q.eq("companiaMiembroId", m._id))
    .collect();
  return {
    _id: m._id,
    userId: m.userId,
    nombre: u ? displayNameFromUser(u) : "(perfil eliminado)",
    email: u?.email ?? null,
    telefono: u?.telefono ?? null,
    activoEnPlataforma: u?.active ?? false,
    roles: m.roles,
    cargo: m.cargo ?? null,
    isActive: m.isActive,
    /* Cuántos conjuntos cubre hoy. Es lo que la compañía mira para saber a
     * quién puede mandar a otro sitio. */
    asignacionesVigentes: asignaciones.filter((a) => estaVigente(a)).length,
    createdAt: m.createdAt,
  };
}

/** Deja solo a quienes tienen alguna asignación en los conjuntos indicados. */
async function filtrarPorCondominios(
  ctx: QueryCtx,
  miembros: Doc<"companiaMiembros">[],
  condominios: Set<Id<"condominios">>,
): Promise<Doc<"companiaMiembros">[]> {
  const out: Doc<"companiaMiembros">[] = [];
  for (const m of miembros) {
    const asigs = await ctx.db
      .query("asignaciones")
      .withIndex("by_miembro", (q) => q.eq("companiaMiembroId", m._id))
      .collect();
    if (asigs.some((a) => condominios.has(a.condominioId))) out.push(m);
  }
  return out;
}

/** Detalle: compañía + personal + contratos, acotado al ámbito de quien lee. */
export const detail = query({
  args: { companiaId: v.id("companiasSeguridad") },
  handler: async (ctx, args) => {
    const user = await requireAppUser(ctx);
    const compania = await ctx.db.get(args.companiaId);
    if (!compania) return null;

    const esPlataforma =
      user.platformRole === "superadmin" || user.platformRole === "admin";

    /* Ámbito de lectura: la plataforma lo ve todo; el admin de la compañía ve
     * su empresa entera; el supervisor solo los conjuntos que supervisa. Un
     * guarda no ve el directorio de la empresa por el hecho de trabajar en
     * ella. */
    let soloCondominios: Set<Id<"condominios">> | null = null;
    if (!esPlataforma) {
      const miembro = await getCompaniaMiembro(ctx, user._id);
      if (!miembro || miembro.companiaId !== args.companiaId) {
        throw new Error("No pertenece a esta compañía.");
      }
      if (!miembro.roles.includes("admin_compania")) {
        if (!miembro.roles.includes("supervisor")) {
          throw new Error("No tiene permiso para ver el detalle de la compañía.");
        }
        soloCondominios = await condominiosSupervisados(ctx, user._id);
        if (soloCondominios.size === 0) {
          return { compania, personal: [], contratos: [] };
        }
      }
    }

    const miembrosRaw = await ctx.db
      .query("companiaMiembros")
      .withIndex("by_compania", (q) => q.eq("companiaId", args.companiaId))
      .collect();
    /* Para el supervisor, "personal" es quien pisa alguno de sus conjuntos,
     * no la nómina entera de la empresa. */
    const miembrosVisibles = soloCondominios
      ? await filtrarPorCondominios(ctx, miembrosRaw, soloCondominios)
      : miembrosRaw;
    const personal = await Promise.all(
      miembrosVisibles.map((m) => hidratarMiembro(ctx, m)),
    );

    const contratosRaw = (
      await ctx.db
        .query("companiaContratos")
        .withIndex("by_compania", (q) => q.eq("companiaId", args.companiaId))
        .collect()
    ).filter((k) => !soloCondominios || soloCondominios.has(k.condominioId));

    const contratos = await Promise.all(
      contratosRaw.map(async (k) => {
        const condo = await ctx.db.get(k.condominioId);
        const asigs = await ctx.db
          .query("asignaciones")
          .withIndex("by_contrato", (q) => q.eq("contratoId", k._id))
          .collect();
        const estado = estadoVigencia(k);
        /* Dos motivos lo archivan: contrato terminado, o compañía dada de
         * baja —sus contratos ya no autorizan nada aunque las fechas digan
         * otra cosa, porque `resolverAcceso` mira el estado de la empresa—.
         * Suspender no: es temporal. */
        const archivado = estado === "terminada" || compania.estado === "inactiva";
        const terminadoPor = k.terminadoPorUserId
          ? await ctx.db.get(k.terminadoPorUserId)
          : null;
        return {
          _id: k._id,
          condominioId: k.condominioId,
          condominioNombre: condo?.name ?? "(conjunto eliminado)",
          vigenciaDesde: k.vigenciaDesde,
          vigenciaHasta: k.vigenciaHasta ?? null,
          estado,
          /** Si va en Activos o en Archivados. Lo decide el SERVIDOR. */
          archivado,
          /* Quién lo cortó y cuándo. `terminadoEn` solo existe si se terminó a
           * mano; los que vencieron por fecha lo dicen con `vigenciaHasta`. */
          terminadoEn: k.terminadoEn ?? null,
          terminadoPorNombre: terminadoPor
            ? displayNameFromUser(terminadoPor)
            : null,
          notas: k.notas ?? null,
          /* Bajo un contrato archivado NO queda nadie vigente, digan lo que
           * digan las fechas de la asignación: `asignacionVigente` comprueba
           * el contrato antes que nada, así que contarlas por su cuenta haría
           * que un conjunto archivado siguiera diciendo "2 asignados" — gente
           * que ya no puede entrar. Es la misma regla que aplica
           * `asignaciones.porContrato`. */
          asignacionesVigentes: archivado
            ? 0
            : asigs.filter((a) => estaVigente(a)).length,
          /* El histórico no se va a ninguna parte al archivar. */
          asignacionesTotales: asigs.length,
          createdAt: k.createdAt,
        };
      }),
    );

    return {
      compania,
      personal: personal.sort((a, b) => a.nombre.localeCompare(b.nombre)),
      contratos: contratos.sort((a, b) => b.vigenciaDesde - a.vigenciaDesde),
    };
  },
});

/**
 * La compañía del usuario actual, para el ruteo tras el login.
 *
 * Devuelve null para todo el mundo que no sea personal de vigilancia, que es
 * la inmensa mayoría: una lectura por índice y fuera.
 */
export const miCompania = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentAppUser(ctx);
    if (!user) return null;
    return await miCompaniaDe(ctx, user._id);
  },
});

/**
 * Contratos vigentes de un conjunto: quién le presta el servicio hoy.
 *
 * La lee el administrador del conjunto, que tiene derecho a saber qué empresa
 * cubre su portería, y la plataforma.
 */
export const contratosDeCondominio = query({
  args: { condominioId: v.id("condominios") },
  handler: async (ctx, args) => {
    const user = await requireAppUser(ctx);
    const esPlataforma =
      user.platformRole === "superadmin" || user.platformRole === "admin";
    if (!esPlataforma) {
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_condominio_user", (q) =>
          q.eq("condominioId", args.condominioId).eq("userId", user._id),
        )
        .unique();
      const puede =
        !!membership &&
        membership.isActive &&
        membership.roles.some((r) =>
          ["administrador", "junta_directiva"].includes(r),
        );
      if (!puede) throw new Error("No tiene acceso a este conjunto.");
    }

    const contratos = await ctx.db
      .query("companiaContratos")
      .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
      .collect();

    return await Promise.all(
      contratos.map(async (k) => {
        const c = await ctx.db.get(k.companiaId);
        return {
          _id: k._id,
          companiaId: k.companiaId,
          companiaNombre: c?.nombre ?? "(compañía eliminada)",
          companiaEstado: c?.estado ?? null,
          vigenciaDesde: k.vigenciaDesde,
          vigenciaHasta: k.vigenciaHasta ?? null,
          estado: estadoVigencia(k),
        };
      }),
    );
  },
});

// ─────────────────────────────────────────────────────────────
// Compañía
// ─────────────────────────────────────────────────────────────

/** Comprueba que el NIT no lo tenga ya otra compañía. */
async function exigirNitLibre(
  ctx: QueryCtx,
  nit: string | undefined,
  excepto?: Id<"companiasSeguridad">,
) {
  if (!nit) return;
  /* Convex no tiene UNIQUE: la unicidad se comprueba leyendo por índice antes
   * de escribir, igual que se hace hoy con `users.email`. */
  const otras = await ctx.db
    .query("companiasSeguridad")
    .withIndex("by_nit", (q) => q.eq("nit", nit))
    .collect();
  if (otras.some((c) => c._id !== excepto)) {
    throw new Error("Ya existe una compañía con ese NIT.");
  }
}

/**
 * Inserta la fila de la compania. Interna: el alta entra por `registrar`.
 *
 * Publica y suelta era justo el agujero de este modulo: dejaba nacer una
 * compania sin una sola persona que pudiera entrar a ella, y el "Correo de
 * contacto" del formulario —que es un dato de contacto, no una cuenta— hacia
 * creer lo contrario. Una compania sin administrador no es un estado util del
 * sistema, asi que deja de ser alcanzable.
 */
export const crearCompania = internalMutation({
  args: {
    nombre: v.string(),
    nit: v.optional(v.string()),
    contactoEmail: v.optional(v.string()),
    contactoTelefono: v.optional(v.string()),
    primaryColor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requirePlatformStaff(ctx);
    const nombre = args.nombre.trim();
    if (!nombre) throw new Error("El nombre es obligatorio.");

    const nit = args.nit?.trim() || undefined;
    await exigirNitLibre(ctx, nit);

    const now = Date.now();
    return await ctx.db.insert("companiasSeguridad", {
      nombre,
      nit,
      contactoEmail: args.contactoEmail?.trim().toLowerCase() || undefined,
      contactoTelefono: args.contactoTelefono?.trim() || undefined,
      primaryColor: args.primaryColor?.trim() || undefined,
      estado: "activa",
      createdAt: now,
      updatedAt: now,
    });
  },
});

/**
 * Deshace un registro que no llegó a completarse.
 *
 * Solo se usa desde `registrar` y solo sobre la compañía que ese mismo
 * intento acaba de crear, así que no puede haber nada anterior que perder.
 * Existe para que un fallo a mitad de camino no deje una compañía sin
 * administrador —el estado exacto que dejaba a la empresa sin poder entrar— y
 * para que reintentar no choque contra "ya existe una compañía con ese NIT".
 *
 * El perfil de `users` NO se toca: puede ser una persona que ya existía
 * (un residente que además va a administrar la empresa), y borrarlo sería
 * destruir algo que el registro no creó. Un perfil sin membresía es inocuo y
 * el reintento lo reutiliza.
 */
export const descartarRegistroFallido = internalMutation({
  args: { companiaId: v.id("companiasSeguridad") },
  handler: async (ctx, args) => {
    const contratos = await ctx.db
      .query("companiaContratos")
      .withIndex("by_compania", (q) => q.eq("companiaId", args.companiaId))
      .collect();
    // Cinturón: una compañía recién creada no puede tener contratos. Si los
    // tiene, no es la que creamos y no se toca.
    if (contratos.length > 0) return { descartada: false as const };

    const miembros = await ctx.db
      .query("companiaMiembros")
      .withIndex("by_compania", (q) => q.eq("companiaId", args.companiaId))
      .collect();
    for (const m of miembros) await ctx.db.delete(m._id);

    await ctx.db.delete(args.companiaId);
    return { descartada: true as const };
  },
});

/**
 * Registra una compañía: la empresa Y el usuario con el que va a entrar.
 *
 * Es la puerta del alta. Antes eran dos pasos sueltos —crear la compañía y,
 * cuando alguien se acordara, darle de alta a su gente— y el primero se
 * sentía completo: la compañía aparecía en la lista. Pero no existía ninguna
 * cuenta con la que entrar, así que el intento de iniciar sesión con el
 * correo de contacto respondía "user not found". Aquí las dos cosas son un
 * solo acto.
 *
 * NO duplica nada del alta de personal: reutiliza `crearMiembro` tal cual,
 * que es el mismo camino por el que se dan de alta el guarda y el supervisor
 * (y, a su vez, el mismo `internalAdapter` de Better Auth que usa
 * `users.createCondoMember`). El administrador que sale de aquí es
 * estructuralmente idéntico a cualquier otro miembro de compañía: perfil en
 * `users` con `authId`, credencial en Better Auth y fila en
 * `companiaMiembros`.
 */
export const registrar = action({
  args: {
    nombre: v.string(),
    nit: v.optional(v.string()),
    contactoEmail: v.optional(v.string()),
    contactoTelefono: v.optional(v.string()),
    primaryColor: v.optional(v.string()),
    /** La cuenta con la que la empresa entrará. Obligatoria: es el punto. */
    adminEmail: v.string(),
    adminName: v.string(),
    adminPassword: v.string(),
    adminTelefono: v.optional(v.string()),
    adminCargo: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    ok: true;
    companiaId: Id<"companiasSeguridad">;
    userId: Id<"users">;
    miembroId: Id<"companiaMiembros">;
    existed: boolean;
  }> => {
    /* Lo que se puede comprobar sin base, se comprueba ANTES de crear nada:
     * un formulario mal llenado no debe dejar una compañía a medias. */
    if (!args.adminEmail.trim() || !args.adminName.trim()) {
      throw new Error(
        "El nombre y el correo del administrador son obligatorios.",
      );
    }
    if (args.adminPassword.trim().length < 8) {
      throw new Error("La contraseña debe tener al menos 8 caracteres.");
    }

    const companiaId: Id<"companiasSeguridad"> = await ctx.runMutation(
      internal.companias.crearCompania,
      {
        nombre: args.nombre,
        nit: args.nit,
        contactoEmail: args.contactoEmail,
        contactoTelefono: args.contactoTelefono,
        primaryColor: args.primaryColor,
      },
    );

    try {
      const admin: {
        ok: true;
        userId: Id<"users">;
        miembroId: Id<"companiaMiembros">;
        existed: boolean;
      } = await ctx.runAction(api.companias.crearMiembro, {
        companiaId,
        email: args.adminEmail,
        name: args.adminName,
        password: args.adminPassword,
        telefono: args.adminTelefono,
        cargo: args.adminCargo,
        roles: ["admin_compania"],
      });

      return {
        ok: true as const,
        companiaId,
        userId: admin.userId,
        miembroId: admin.miembroId,
        existed: admin.existed,
      };
    } catch (e) {
      /* Si el administrador no se pudo crear, la compañía no debe quedar.
       * Que la empresa exista sin nadie que pueda entrar es exactamente el
       * fallo que esta función viene a cerrar. */
      await ctx.runMutation(internal.companias.descartarRegistroFallido, {
        companiaId,
      });
      throw e;
    }
  },
});

/** Datos de contacto y marca. Los puede editar la propia compañía. */
export const update = mutation({
  args: {
    companiaId: v.id("companiasSeguridad"),
    nombre: v.optional(v.string()),
    nit: v.optional(v.string()),
    contactoEmail: v.optional(v.string()),
    contactoTelefono: v.optional(v.string()),
    logo: v.optional(v.string()),
    primaryColor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await exigirAccesoCompania(ctx, args.companiaId, "seguridad.personal");

    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    if (args.nombre !== undefined) {
      const nombre = args.nombre.trim();
      if (!nombre) throw new Error("El nombre no puede estar vacío.");
      patch.nombre = nombre;
    }
    if (args.nit !== undefined) {
      const nit = args.nit.trim() || undefined;
      await exigirNitLibre(ctx, nit, args.companiaId);
      patch.nit = nit;
    }
    if (args.contactoEmail !== undefined) {
      patch.contactoEmail = args.contactoEmail.trim().toLowerCase() || undefined;
    }
    if (args.contactoTelefono !== undefined) {
      patch.contactoTelefono = args.contactoTelefono.trim() || undefined;
    }
    if (args.logo !== undefined) patch.logo = args.logo.trim() || undefined;
    if (args.primaryColor !== undefined) {
      patch.primaryColor = args.primaryColor.trim() || undefined;
    }

    await ctx.db.patch(args.companiaId, patch);
    return args.companiaId;
  },
});

/**
 * Activa, suspende o ARCHIVA una compañía. Solo plataforma.
 *
 * `inactiva` es el archivado: el estado ya existía y no hacía falta inventar
 * otro. Suspender es temporal y archivar es el final del camino, pero los dos
 * cortan igual de rápido la operación de TODO su personal en TODOS sus
 * contratos: `asignacionVigente` y `resolverAcceso` dejan de resolver en
 * cuanto el estado no es "activa".
 *
 * SIN CASCADA, a propósito. No se toca ni un contrato ni una asignación: ya
 * dejan de autorizar por sí solos al comprobar el estado de la empresa, y
 * reescribirlos convertiría una decisión reversible en una pérdida de
 * histórico. Reactivar una compañía archivada la devuelve exactamente como
 * estaba; una cascada no tiene vuelta.
 *
 * Sus conjuntos, usuarios, minutas, rondas y eventos no se tocan siquiera de
 * lejos: cuelgan del CONJUNTO, no de la compañía.
 *
 * IDEMPOTENTE: reponer el mismo estado no mueve el sello de quién archivó.
 */
export const setEstado = mutation({
  args: {
    companiaId: v.id("companiasSeguridad"),
    estado: estadoCompaniaValidator,
  },
  handler: async (ctx, args) => {
    const user = await requirePlatformStaff(ctx);
    const compania = await ctx.db.get(args.companiaId);
    if (!compania) throw new Error("Compañía no encontrada.");

    const ahora = Date.now();
    if (compania.estado !== args.estado) {
      await ctx.db.patch(args.companiaId, {
        estado: args.estado,
        /* El rastro del archivado. Se pone al archivar y se limpia al
         * sacarla del archivo, para que la ficha nunca diga "archivada por
         * Fulano" de una compañía que hoy opera. */
        archivadaEn: args.estado === "inactiva" ? ahora : undefined,
        archivadaPorUserId: args.estado === "inactiva" ? user._id : undefined,
        updatedAt: ahora,
      });
    }

    // Para que la interfaz pueda decir a cuánta gente y cuántos conjuntos afecta.
    const contratos = await ctx.db
      .query("companiaContratos")
      .withIndex("by_compania", (q) => q.eq("companiaId", args.companiaId))
      .collect();
    const asignaciones = await ctx.db
      .query("asignaciones")
      .withIndex("by_compania", (q) => q.eq("companiaId", args.companiaId))
      .collect();
    return {
      estado: args.estado,
      condominiosAfectados: contratos.filter((k) => estaVigente(k)).length,
      personasAfectadas: new Set(
        asignaciones.filter((a) => estaVigente(a)).map((a) => a.userId),
      ).size,
    };
  },
});

// ─────────────────────────────────────────────────────────────
// Personal de la compañía
// ─────────────────────────────────────────────────────────────

/**
 * Crea o reactiva el perfil de un miembro de la compañía. Sin contraseña.
 *
 * Réplica de `memberships.upsertCondoMemberProfile` en el otro eje, y por el
 * mismo motivo: la credencial se crea en la action, que sí puede hablar con
 * Better Auth.
 */
export const upsertMiembroProfile = mutation({
  args: {
    companiaId: v.id("companiasSeguridad"),
    email: v.string(),
    name: v.string(),
    telefono: v.optional(v.string()),
    roles: v.array(companiaRoleValidator),
    cargo: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user: quienDaDeAlta } = await exigirAccesoCompania(
      ctx,
      args.companiaId,
      "seguridad.personal",
    );

    const email = args.email.trim().toLowerCase();
    const name = args.name.trim();
    if (!email || !name) throw new Error("Nombre y correo son obligatorios.");
    /* Un solo rol de compañía. Se comprueba aquí, en la mutación, y no solo
     * en la action que la llama: ésta es la puerta que toca la base. */
    exigirRolUnicoCompania(args.roles);

    const now = Date.now();
    const telefono = args.telefono?.trim() || undefined;
    const telefonoE164 = normalizarTelefonoE164(telefono) ?? undefined;

    const existing = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();

    let userId: Id<"users">;
    let existed = false;
    if (existing) {
      userId = existing._id;
      existed = true;
      /* Patch condicional: en Convex, patch con undefined BORRA el campo. Un
       * residente al que se da de alta como guarda no debe perder su
       * teléfono porque el formulario venga vacío. */
      const patch: Record<string, unknown> = { active: true, updatedAt: now };
      if (args.telefono !== undefined) {
        patch.telefono = telefono;
        patch.telefonoE164 = telefonoE164;
      }
      await ctx.db.patch(existing._id, patch);
    } else {
      userId = await ctx.db.insert("users", {
        name,
        email,
        telefono,
        telefonoE164,
        emailVerified: false,
        active: true,
        createdAt: now,
        updatedAt: now,
      });
    }

    const previo = await ctx.db
      .query("companiaMiembros")
      .withIndex("by_compania_user", (q) =>
        q.eq("companiaId", args.companiaId).eq("userId", userId),
      )
      .unique();

    /* Pertenecer a dos compañías a la vez no es un caso real, y permitirlo
     * dejaría `getCompaniaMiembro` eligiendo arbitrariamente entre dos. */
    const enOtra = (
      await ctx.db
        .query("companiaMiembros")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect()
    ).find((m) => m.isActive && m.companiaId !== args.companiaId);
    if (enOtra) {
      throw new Error(
        "Esa persona ya es personal activo de otra compañía. Debe darse de baja allí primero.",
      );
    }

    let miembroId: Id<"companiaMiembros">;
    if (previo) {
      miembroId = previo._id;
      /* Volver a dar de alta a alguien puede cambiarle el rol —se da de baja
       * a un guarda y se le vuelve a subir como supervisor—, así que deja el
       * mismo rastro que `setRolesMiembro`. */
      const anterior = rolPrincipalDeCompania(previo.roles);
      const nuevo = exigirRolUnicoCompania(args.roles);
      await ctx.db.patch(previo._id, {
        roles: [nuevo],
        cargo: args.cargo?.trim() || undefined,
        isActive: true,
        updatedAt: now,
        ...(anterior !== nuevo
          ? {
              rolAnterior: anterior ?? undefined,
              rolCambiadoEn: now,
              rolCambiadoPorUserId: quienDaDeAlta._id,
            }
          : {}),
      });
    } else {
      miembroId = await ctx.db.insert("companiaMiembros", {
        userId,
        companiaId: args.companiaId,
        roles: args.roles,
        cargo: args.cargo?.trim() || undefined,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      });
    }

    return { userId, miembroId, email, name, existed };
  },
});

/**
 * Alta completa de personal: perfil + credencial + membresía de compañía.
 *
 * Calcada de `users.createCondoMember`, que es el camino que el proyecto ya
 * usa para dar de alta gente con contraseña. Si la persona ya tenía cuenta
 * —un residente que además trabaja de guarda— se le respeta y solo se le
 * añade el vínculo con la compañía.
 */
export const crearMiembro = action({
  args: {
    companiaId: v.id("companiasSeguridad"),
    email: v.string(),
    name: v.string(),
    password: v.string(),
    telefono: v.optional(v.string()),
    roles: v.array(companiaRoleValidator),
    cargo: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    ok: true;
    userId: Id<"users">;
    miembroId: Id<"companiaMiembros">;
    existed: boolean;
  }> => {
    const password = args.password.trim();
    /* La política completa la aplica `fijarPasswordDeCuenta` más abajo, pero
     * el perfil se crea ANTES que la credencial: sin este corte temprano, una
     * clave rechazada dejaría a la persona dada de alta y sin poder entrar. */
    const fuerza = evaluarPassword(password, {
      email: args.email,
      nombre: args.name,
    });
    if (!fuerza.ok) throw new Error(fuerza.problemas[0]!);

    /* El rol, por la misma razón que la clave: `upsertMiembroProfile` lo
     * vuelve a comprobar —es la puerta de verdad— pero rechazarlo aquí evita
     * gastar una escritura y una llamada a Better Auth en un alta que iba a
     * fallar de todos modos. */
    exigirRolUnicoCompania(args.roles);

    const perfil: {
      userId: Id<"users">;
      miembroId: Id<"companiaMiembros">;
      email: string;
      name: string;
      existed: boolean;
    } = await ctx.runMutation(api.companias.upsertMiembroProfile, {
      companiaId: args.companiaId,
      email: args.email,
      name: args.name,
      telefono: args.telefono,
      roles: args.roles,
      cargo: args.cargo,
    });

    /* La credencial la escribe el helper compartido: la misma secuencia que
     * usa el restablecimiento, en un solo sitio. */
    await fijarPasswordDeCuenta(ctx, {
      email: perfil.email,
      name: perfil.name,
      password,
    });

    const ia = (await createAuth(ctx).$context).internalAdapter;
    const found = await ia.findUserByEmail(perfil.email);
    if (!found) throw new Error("No se pudo crear la cuenta de acceso.");
    const authUserId = found.user.id;

    await ctx.runMutation(internal.users.linkAuthId, {
      userId: perfil.userId,
      authId: authUserId,
    });

    return {
      ok: true as const,
      userId: perfil.userId,
      miembroId: perfil.miembroId,
      existed: perfil.existed,
    };
  },
});

export const setRolesMiembro = mutation({
  args: {
    miembroId: v.id("companiaMiembros"),
    roles: v.array(companiaRoleValidator),
    cargo: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const miembro = await ctx.db.get(args.miembroId);
    if (!miembro) throw new Error("Miembro no encontrado.");
    const { user: quienCambia } = await exigirAccesoCompania(
      ctx,
      miembro.companiaId,
      "seguridad.personal",
    );

    /* La regla, en el sitio donde se cambia el rol. Cambiar de GUARDA a
     * SUPERVISOR REEMPLAZA: llega un array de uno y se guarda tal cual, así
     * que no hay forma de acumular. */
    const nuevo = exigirRolUnicoCompania(args.roles);
    const anterior = rolPrincipalDeCompania(miembro.roles);

    /* Quitarle un rol a alguien que está asignado con ese rol dejaría una
     * asignación que ya no puede ejercerse. Se avisa en vez de romperla en
     * silencio: la decisión de terminar la asignación es de quien manda. */
    const asignaciones = await ctx.db
      .query("asignaciones")
      .withIndex("by_miembro", (q) => q.eq("companiaMiembroId", args.miembroId))
      .collect();
    const enConflicto = asignaciones.filter(
      (a) => estaVigente(a) && !args.roles.includes(a.rol),
    );
    if (enConflicto.length > 0) {
      throw new Error(
        `Tiene ${enConflicto.length} asignación(es) vigente(s) con un rol que estás quitando. Termínalas primero.`,
      );
    }

    const ahora = Date.now();
    await ctx.db.patch(args.miembroId, {
      roles: [nuevo],
      updatedAt: ahora,
      /* Patch condicional, como en `upsertMiembroProfile`: en Convex, patch
       * con undefined BORRA el campo. La pantalla cambia el rol sin mandar el
       * cargo —son dos acciones distintas—, así que escribirlo siempre le
       * borraba a la persona su "Supervisor zona norte" cada vez que alguien
       * le tocaba el rol. */
      ...(args.cargo !== undefined
        ? { cargo: args.cargo.trim() || undefined }
        : {}),
      /* Rastro del cambio de rol, en la propia fila afectada —como
       * `passwordFijadaPorUserId` justo al lado—. Solo si el rol cambió de
       * verdad: dejarlo también al corregir el cargo diría que hubo un cambio
       * de rol donde no lo hubo. */
      ...(anterior !== nuevo
        ? {
            rolAnterior: anterior ?? undefined,
            rolCambiadoEn: ahora,
            rolCambiadoPorUserId: quienCambia._id,
          }
        : {}),
    });
    return args.miembroId;
  },
});

/**
 * Da de baja a un miembro. No borra: pone `isActive` en false.
 *
 * Sus asignaciones dejan de resolver de inmediato porque
 * `asignacionVigente` comprueba el miembro, pero se les pone también fecha de
 * fin para que el histórico diga hasta cuándo estuvo, y no solo que ya no
 * está.
 */
export const desactivarMiembro = mutation({
  args: { miembroId: v.id("companiaMiembros") },
  handler: async (ctx, args) => {
    const miembro = await ctx.db.get(args.miembroId);
    if (!miembro) throw new Error("Miembro no encontrado.");
    await exigirAccesoCompania(ctx, miembro.companiaId, "seguridad.personal");

    const now = Date.now();
    await ctx.db.patch(args.miembroId, { isActive: false, updatedAt: now });

    const asignaciones = await ctx.db
      .query("asignaciones")
      .withIndex("by_miembro", (q) => q.eq("companiaMiembroId", args.miembroId))
      .collect();
    let cerradas = 0;
    for (const a of asignaciones) {
      if (!estaVigente(a, now)) continue;
      await ctx.db.patch(a._id, { vigenciaHasta: now });
      cerradas++;
    }
    return { ok: true as const, asignacionesCerradas: cerradas };
  },
});

// ─────────────────────────────────────────────────────────────
// Contratos compañía ↔ conjunto
// ─────────────────────────────────────────────────────────────

/**
 * Firma un contrato. Solo plataforma.
 *
 * Es lo que autoriza a la compañía sobre un conjunto: sin contrato vigente,
 * ninguna asignación de esa empresa resuelve.
 */
export const crearContrato = mutation({
  args: {
    companiaId: v.id("companiasSeguridad"),
    condominioId: v.id("condominios"),
    vigenciaDesde: v.number(),
    vigenciaHasta: v.optional(v.number()),
    notas: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requirePlatformStaff(ctx);

    const compania = await ctx.db.get(args.companiaId);
    if (!compania) throw new Error("Compañía no encontrada.");
    if (compania.estado === "inactiva") {
      throw new Error("No se puede contratar una compañía dada de baja.");
    }
    const condominio = await ctx.db.get(args.condominioId);
    if (!condominio) throw new Error("Conjunto no encontrado.");

    if (
      args.vigenciaHasta != null &&
      args.vigenciaHasta < args.vigenciaDesde
    ) {
      throw new Error("La fecha de fin no puede ser anterior a la de inicio.");
    }

    /* Dos contratos vigentes a la vez de la MISMA compañía en el MISMO
     * conjunto son un duplicado, no un caso real. Compañías DISTINTAS sí
     * pueden solaparse: ese solape es justo el empalme cuando un conjunto
     * cambia de empresa. */
    const previos = await ctx.db
      .query("companiaContratos")
      .withIndex("by_condominio_compania", (q) =>
        q.eq("condominioId", args.condominioId).eq("companiaId", args.companiaId),
      )
      .collect();
    const nuevo = {
      vigenciaDesde: args.vigenciaDesde,
      vigenciaHasta: args.vigenciaHasta,
    };
    if (previos.some((k) => haySolape(k, nuevo))) {
      throw new Error(
        "Esa compañía ya tiene un contrato que se solapa con esas fechas en este conjunto.",
      );
    }

    const now = Date.now();
    return await ctx.db.insert("companiaContratos", {
      companiaId: args.companiaId,
      condominioId: args.condominioId,
      vigenciaDesde: args.vigenciaDesde,
      vigenciaHasta: args.vigenciaHasta,
      notas: args.notas?.trim() || undefined,
      creadoPorUserId: user._id,
      createdAt: now,
      updatedAt: now,
    });
  },
});

/**
 * TERMINA UN CONTRATO. Sin `vigenciaHasta`, el corte es AHORA.
 *
 * Los dos casos son reales y distintos:
 *
 *  - Sin fecha: "se acabó, hoy". Escribe `terminadoEn` con el instante, y el
 *    conjunto sale de los listados activos en la siguiente lectura. Es lo que
 *    hace el botón, y lo que antes no funcionaba: mandaba `vigenciaHasta =
 *    ahora`, y como `finDe` regala el día entero el contrato seguía vigente
 *    24 horas más. Nada cambiaba en pantalla, ni el personal perdía el acceso.
 *
 *  - Con fecha: "termina el 31". Programado, como estaba. Solo la plataforma:
 *    es una condición del contrato comercial.
 *
 * No borra nada ni recorre sus asignaciones: dejan de resolver solas porque
 * `asignacionVigente` comprueba el contrato. Ése es el motivo de que la
 * asignación cuelgue del contrato y no del conjunto — y por eso terminar no
 * pierde una sola ronda, minuta ni evento: todo eso cuelga del CONJUNTO, que
 * sigue intacto. Terminar el contrato no da de baja al conjunto.
 *
 * IDEMPOTENTE: sobre un contrato ya terminado no reescribe nada —conservar
 * quién y cuándo lo cortó importa más que registrar el segundo clic— y avisa
 * con `yaEstaba`.
 */
export const terminarContrato = mutation({
  args: {
    contratoId: v.id("companiaContratos"),
    /** Último día pactado. Ausente = terminar ahora. */
    vigenciaHasta: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const contrato = await ctx.db.get(args.contratoId);
    if (!contrato) throw new Error("Contrato no encontrado.");

    /* La compañía y el conjunto salen del DOCUMENTO del contrato, nunca de un
     * argumento: cambiar el id lleva a otro contrato, cuya compañía se vuelve
     * a comprobar. Pasan la plataforma y el `admin_compania` de ESA empresa;
     * el supervisor no, porque `seguridad.terminar` no está entre lo que da
     * su rol de asignación. */
    const { user, esPlataforma } = await exigirAccesoContrato(
      ctx,
      contrato,
      "seguridad.terminar",
    );

    const ahora = Date.now();

    /* Ya terminado: no se toca. Repetir la petición —doble clic, reintento de
     * red— no puede reescribir quién lo cortó ni correr la fecha. */
    if (estadoVigencia(contrato, ahora) === "terminada") {
      return { ok: true as const, yaEstaba: true as const, personasAfectadas: 0 };
    }

    if (args.vigenciaHasta != null) {
      /* Programar el fin es una condición del contrato comercial, y ésas las
       * pone Vekino. La compañía puede renunciar hoy, no reescribir el pacto. */
      if (!esPlataforma) {
        throw new Error(
          "Solo Vekino puede programar la fecha de fin de un contrato. Puedes terminarlo ahora.",
        );
      }
      if (args.vigenciaHasta < contrato.vigenciaDesde) {
        throw new Error("La fecha de fin no puede ser anterior a la de inicio.");
      }
      await ctx.db.patch(args.contratoId, {
        vigenciaHasta: args.vigenciaHasta,
        updatedAt: ahora,
      });
    } else {
      await ctx.db.patch(args.contratoId, {
        terminadoEn: ahora,
        terminadoPorUserId: user._id,
        updatedAt: ahora,
      });
    }

    const corte = args.vigenciaHasta ?? ahora;
    const asignaciones = await ctx.db
      .query("asignaciones")
      .withIndex("by_contrato", (q) => q.eq("contratoId", args.contratoId))
      .collect();
    return {
      ok: true as const,
      yaEstaba: false as const,
      /* Para que la interfaz pueda decir a cuánta gente deja sin acceso. */
      personasAfectadas: new Set(
        asignaciones
          .filter((a) => a.vigenciaHasta == null || a.vigenciaHasta > corte)
          .map((a) => a.userId),
      ).size,
    };
  },
});

// ─────────────────────────────────────────────────────────────
// Editar a una persona de la compañía
//
// El administrador de la compañía ya podía darla de alta, cambiarle los roles
// y darla de baja. Lo que faltaba era corregir lo que se escribió mal el día
// del alta —un apellido, un documento, un teléfono— y volverle a poner la
// clave cuando la pierde, que en una empresa de vigilancia con rotación pasa
// todas las semanas. Sin esto había que darla de baja y volverla a crear.
// ─────────────────────────────────────────────────────────────

/** Roles de conjunto cuya cuenta NO puede tomar el administrador de una compañía. */
const ROLES_DE_MANDO_EN_CONJUNTO = [
  "administrador",
  "contadora",
  "junta_directiva",
] as const;

/**
 * Autoriza tocar a una persona de una compañía, y devuelve lo justo.
 *
 * ── De dónde sale la compañía ────────────────────────────────────────────
 * Del DOCUMENTO del miembro, nunca de un argumento. No hay `companiaId` que
 * mandar desde el cliente: se envía el id del miembro, se lee su compañía y
 * es ÉSA la que se comprueba contra la identidad de quien llama. Cambiar el
 * id lleva a otro miembro, cuya compañía se vuelve a comprobar, así que no
 * queda nada que manipular.
 *
 * ── Escalada de privilegios ──────────────────────────────────────────────
 * Dos puertas cerradas, y ninguna es teórica: una misma persona tiene un solo
 * `users` —el alta reutiliza la fila por correo— y puede estar a la vez en
 * una compañía y en un conjunto.
 *
 *  1. Cuentas de plataforma. Igual que en `users.assertCanEditMember`: quien
 *     administra una empresa no le fija la contraseña a un superadmin porque
 *     lo tenga apuntado como guarda.
 *
 *  2. Cuentas con mando en algún conjunto. Sin esto, dar de alta como guarda
 *     a la administradora de un conjunto —cosa que nadie impide— y acto
 *     seguido cambiarle la clave entregaba ese conjunto entero. Es el salto
 *     entre los dos ejes del modelo, y es el que había que cerrar.
 *
 * Devuelve solo correo y nombre. Nada de credenciales: el hash no sale de
 * Better Auth ni siquiera hacia el servidor que lo pide.
 */
export const assertPuedeEditarMiembro = query({
  args: { miembroId: v.id("companiaMiembros") },
  handler: async (ctx, args) => {
    const miembro = await ctx.db.get(args.miembroId);
    if (!miembro) throw new Error("Miembro no encontrado.");

    await exigirAccesoCompania(ctx, miembro.companiaId, "seguridad.personal");

    const user = await ctx.db.get(miembro.userId);
    if (!user) throw new Error("Perfil no encontrado.");
    if (!user.email) throw new Error("Esa persona no tiene correo.");

    if (user.platformRole) {
      throw new Error(
        "Esa cuenta es de la plataforma. Debe gestionarse desde el panel maestro.",
      );
    }

    const membresias = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", miembro.userId))
      .collect();
    const mandaEnUnConjunto = membresias.some(
      (m) =>
        m.isActive &&
        m.roles.some((r) =>
          (ROLES_DE_MANDO_EN_CONJUNTO as readonly string[]).includes(r),
        ),
    );
    if (mandaEnUnConjunto) {
      throw new Error(
        "Esa persona administra un conjunto. Sus credenciales se gestionan desde el conjunto, no desde la compañía.",
      );
    }

    return {
      userId: miembro.userId,
      companiaId: miembro.companiaId,
      email: user.email,
      name: user.name,
    };
  },
});

/**
 * Corrige los datos personales de alguien de la compañía.
 *
 * Solo lo que vive en la PERSONA. El rol es de `setRolesMiembro`, la baja de
 * `desactivarMiembro`, el correo de `setEmailMiembro` —porque además toca la
 * credencial— y dónde trabaja es de `asignaciones`. Meterlo todo en un mismo
 * formulario haría que corregir un apellido pudiera, de paso, cambiar quién
 * entra a qué portería.
 */
export const actualizarMiembro = mutation({
  args: {
    miembroId: v.id("companiaMiembros"),
    name: v.string(),
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    tipoDocumento: v.optional(tipoDocumentoValidator),
    numeroDocumento: v.optional(v.string()),
    telefono: v.optional(v.string()),
    cargo: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const miembro = await ctx.db.get(args.miembroId);
    if (!miembro) throw new Error("Miembro no encontrado.");
    const { user: quienEdita } = await exigirAccesoCompania(
      ctx,
      miembro.companiaId,
      "seguridad.personal",
    );
    /* Las mismas dos puertas contra la escalada. Se reusa la query en vez de
     * repetir el criterio: dos copias es como acaban divergiendo. */
    await ctx.runQuery(api.companias.assertPuedeEditarMiembro, {
      miembroId: args.miembroId,
    });

    const name = args.name.trim();
    if (!name) throw new Error("El nombre es obligatorio.");
    if (name.length > 120) throw new Error("El nombre es demasiado largo.");

    const numeroDocumento = args.numeroDocumento?.trim() || undefined;
    if (numeroDocumento && !/^[A-Za-z0-9.-]{4,20}$/.test(numeroDocumento)) {
      throw new Error("El número de documento no parece válido.");
    }

    const telefono = args.telefono?.trim() || undefined;
    if (telefono && !normalizarTelefonoE164(telefono)) {
      throw new Error("El teléfono no parece válido.");
    }

    const ahora = Date.now();
    await ctx.db.patch(miembro.userId, {
      name,
      firstName: args.firstName?.trim() || undefined,
      lastName: args.lastName?.trim() || undefined,
      tipoDocumento: args.tipoDocumento,
      numeroDocumento,
      telefono,
      telefonoE164: normalizarTelefonoE164(telefono) ?? undefined,
      updatedAt: ahora,
    });

    /* Rastro de quién lo tocó, en la propia fila afectada. Es como el resto
     * del modelo registra lo sensible —`terminadoPorUserId`,
     * `archivadaPorUserId`, `creadoPorUserId`— y no hay tabla de auditoría
     * que alimentar ni conviene inventar una para esto. */
    await ctx.db.patch(args.miembroId, {
      cargo: args.cargo?.trim() || undefined,
      actualizadoPorUserId: quienEdita._id,
      updatedAt: ahora,
    });

    return { ok: true as const };
  },
});

/**
 * Le pone una contraseña nueva a alguien de la compañía.
 *
 * Aparte de `actualizarMiembro` a propósito: corregir un apellido y reescribir
 * una credencial no son la misma clase de acto, y mezclarlos haría que cada
 * corrección de un teléfono pasara por el código que toca contraseñas.
 *
 * La clave entra, se valida contra la política del proyecto y se va a Better
 * Auth. No se guarda en `users`, no queda en ningún registro y no vuelve en la
 * respuesta.
 */
export const setPasswordMiembro = action({
  args: {
    miembroId: v.id("companiaMiembros"),
    password: v.string(),
  },
  handler: async (ctx, args): Promise<{ ok: true; cuentaCreada: boolean }> => {
    const objetivo: {
      userId: Id<"users">;
      companiaId: Id<"companiasSeguridad">;
      email: string;
      name: string;
    } = await ctx.runQuery(api.companias.assertPuedeEditarMiembro, {
      miembroId: args.miembroId,
    });

    const r = await fijarPasswordDeCuenta(ctx, {
      email: objetivo.email,
      name: objetivo.name,
      password: args.password,
    });

    await ctx.runMutation(internal.companias.marcarPasswordFijada, {
      miembroId: args.miembroId,
    });

    /* Solo si hubo que crear la cuenta. Ni la clave ni nada derivado de ella. */
    return { ok: true as const, cuentaCreada: r.cuentaCreada };
  },
});

/** Deja constancia de cuándo y por orden de quién se reescribió la clave. */
export const marcarPasswordFijada = internalMutation({
  args: { miembroId: v.id("companiaMiembros") },
  handler: async (ctx, args) => {
    const quien = await getCurrentAppUser(ctx);
    await ctx.db.patch(args.miembroId, {
      passwordFijadaEn: Date.now(),
      passwordFijadaPorUserId: quien?._id,
      updatedAt: Date.now(),
    });
  },
});

/**
 * Cambia el correo de alguien de la compañía.
 *
 * Va aparte porque el correo NO es un dato personal más: es con lo que se
 * entra. Hay que moverlo en los dos sitios —el perfil de aplicación y Better
 * Auth— o el login seguiría pidiendo el viejo. Es exactamente lo que hace
 * `users.setMemberEmail` en el eje del conjunto.
 *
 * Las sesiones abiertas siguen abiertas: Better Auth las guarda contra el id
 * del usuario, no contra su correo. Cambiarlo no echa a nadie, y el
 * restablecimiento por correo pasa a usar el nuevo.
 */
export const setEmailMiembro = action({
  args: {
    miembroId: v.id("companiaMiembros"),
    email: v.string(),
  },
  handler: async (ctx, args): Promise<{ ok: true; changed: boolean }> => {
    const email = args.email.trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error("Correo inválido.");
    }

    const objetivo: {
      userId: Id<"users">;
      companiaId: Id<"companiasSeguridad">;
      email: string;
      name: string;
    } = await ctx.runQuery(api.companias.assertPuedeEditarMiembro, {
      miembroId: args.miembroId,
    });

    const actual = objetivo.email.trim().toLowerCase();
    if (actual === email) return { ok: true as const, changed: false };

    /* Único global: `users` se indexa por correo con `.unique()` y el alta
     * reutiliza la fila que encuentre. Dos cuentas con el mismo correo
     * romperían esa lectura, así que se comprueba en los dos lados. */
    const ocupado = await ctx.runQuery(internal.users.emailEnUso, {
      email,
      exceptUserId: objetivo.userId,
    });
    if (ocupado) throw new Error("Ese correo ya está en uso por otra cuenta.");

    const ia = (await createAuth(ctx).$context).internalAdapter;
    if (await ia.findUserByEmail(email)) {
      throw new Error("Ese correo ya está en uso por otra cuenta.");
    }

    const found = await ia.findUserByEmail(actual);
    if (found) {
      await ia.updateUser(found.user.id, { email, emailVerified: false });
    }
    await ctx.runMutation(internal.users.patchMemberEmail, {
      userId: objetivo.userId,
      email,
    });

    return { ok: true as const, changed: true };
  },
});

/**
 * Los datos de una persona, para el formulario de edición.
 *
 * Aparte de `detail` y no dentro: el documento y el teléfono de cada guarda no
 * tienen por qué viajar en el listado de la compañía entera para que alguien
 * abra una ficha. Se piden al abrirla.
 *
 * Pasa por la misma puerta que las escrituras, así que una ficha que no se
 * puede editar tampoco se puede leer desde aquí, y el motivo lo dice el mismo
 * mensaje.
 *
 * NO devuelve nada de la credencial. No hay campo que devolver: el hash vive
 * en Better Auth y esta consulta ni lo mira.
 */
export const detalleMiembro = query({
  args: { miembroId: v.id("companiaMiembros") },
  handler: async (ctx, args) => {
    const miembro = await ctx.db.get(args.miembroId);
    if (!miembro) throw new Error("Miembro no encontrado.");
    await exigirAccesoCompania(ctx, miembro.companiaId, "seguridad.personal");

    const user = await ctx.db.get(miembro.userId);
    if (!user) throw new Error("Perfil no encontrado.");

    if (user.platformRole) {
      throw new Error(
        "Esa cuenta es de la plataforma. Debe gestionarse desde el panel maestro.",
      );
    }
    const membresias = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", miembro.userId))
      .collect();
    if (
      membresias.some(
        (m) =>
          m.isActive &&
          m.roles.some((r) =>
            (ROLES_DE_MANDO_EN_CONJUNTO as readonly string[]).includes(r),
          ),
      )
    ) {
      throw new Error(
        "Esa persona administra un conjunto. Sus credenciales se gestionan desde el conjunto, no desde la compañía.",
      );
    }

    return {
      miembroId: miembro._id,
      nombre: user.name,
      email: user.email,
      firstName: user.firstName ?? null,
      lastName: user.lastName ?? null,
      tipoDocumento: user.tipoDocumento ?? null,
      numeroDocumento: user.numeroDocumento ?? null,
      telefono: user.telefono ?? null,
      cargo: miembro.cargo ?? null,
      /* Cuándo se le fijó la clave por última vez. El hecho, no el secreto:
       * es lo que responde "¿ya le pusieron una nueva?". */
      passwordFijadaEn: miembro.passwordFijadaEn ?? null,
    };
  },
});
