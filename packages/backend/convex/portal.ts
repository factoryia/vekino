import { v } from "convex/values";
import { query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import {
  getCurrentAppUser,
  getMembership,
  hasPlatformRole,
  misUnidadIds,
  vigentes,
} from "./model/authz";
import { displayNameFromUser } from "./model/displayName";
import { resolveUserImage } from "./model/userImage";
import { certificaPorApi } from "./lib/certificacion";
import { carteraDeUnidad } from "./lib/cartera";

/**
 * PORTAL DEL RESIDENTE / PROPIETARIO
 *
 * A diferencia de `condominios.adminHome` (que exige rol administrativo), este
 * home autoriza a CUALQUIER miembro activo del condominio: propietario,
 * arrendatario, residente, apoderado, etc. Es la puerta de entrada al área
 * "/mi/[id]" que ve la persona que vive en el conjunto.
 *
 * Devuelve la marca del condominio (para el tema/logo del portal) y las unidades
 * vinculadas a la persona (su apartamento/casa), con su vínculo y coeficiente.
 */
export const home = query({
  args: { condominioId: v.id("condominios") },
  handler: async (ctx, args) => {
    const user = await getCurrentAppUser(ctx);
    if (!user) return { allowed: false as const };

    const condominio = await ctx.db.get(args.condominioId);
    if (!condominio) return { allowed: false as const };

    const isPlatform = hasPlatformRole(user, "superadmin", "admin");
    const membership = await getMembership(ctx, user._id, args.condominioId);
    const isMember = !!membership && membership.isActive;

    // Solo miembros del condominio (o staff de plataforma, para previsualizar).
    if (!isPlatform && !isMember) return { allowed: false as const };

    // Unidades vinculadas a la persona dentro de este condominio.
    let unidades: {
      _id: string;
      numero: string;
      torre: string | null;
      bloque: string | null;
      tipo: Doc<"unidades">["tipo"];
      estado: Doc<"unidades">["estado"];
      coeficiente: number | null;
      vinculo: Doc<"usuarioUnidad">["vinculo"];
      esPrincipal: boolean;
    }[] = [];

    if (membership) {
      /* Solo los vínculos VIGENTES (`vigentes`, la regla de `misUnidadIds`):
       * con el contrato vencido, el encabezado, "Mi unidad" y cada pantalla
       * que parte de aquí dejan de ofrecer la casa (QA de comprobantes, H3).
       * La persona sigue siendo del conjunto: avisos, PQRS, documentos. */
      const links = vigentes(
        await ctx.db
          .query("usuarioUnidad")
          .withIndex("by_membership", (q) => q.eq("membershipId", membership._id))
          .collect(),
      );

      const rows = await Promise.all(
        links.map(async (l) => {
          const u = await ctx.db.get(l.unidadId);
          if (!u) return null;
          return {
            _id: u._id as string,
            numero: u.numero,
            torre: u.torre ?? null,
            bloque: u.bloque ?? null,
            tipo: u.tipo,
            estado: u.estado,
            coeficiente: u.coeficiente ?? null,
            vinculo: l.vinculo,
            esPrincipal: l.esPrincipal,
          };
        }),
      );

      unidades = rows
        .filter((r): r is NonNullable<typeof r> => r !== null)
        .sort((a, b) => Number(b.esPrincipal) - Number(a.esPrincipal));
    }

    return {
      allowed: true as const,
      isPlatform,
      userId: user._id as string,
      userName: displayNameFromUser(user),
      userImage: await resolveUserImage(ctx, user),
      userEmail: user.email,
      myRoles: membership?.roles ?? [],
      membershipId: (membership?._id ?? null) as string | null,
      unidades,
      condominio: {
        _id: condominio._id as string,
        name: condominio.name,
        city: condominio.city ?? null,
        address: condominio.address ?? null,
        nit: condominio.nit ?? null,
        logo: condominio.logo ?? null,
        coverImage: condominio.coverImage ?? null,
        primaryColor: condominio.primaryColor ?? null,
        /* Se le esconde la URL del portal a quien esta certificando, para
         * que su boton de pagar use la API. Todos los demas siguen yendo al
         * portal del banco, donde el pago es real (lib/certificacion.ts). */
        avalPortalUrl: certificaPorApi(
          user.email,
          process.env.AVAL_CERTIFICACION_EMAILS,
        )
          ? null
          : (condominio.avalPortalUrl ?? null),
      },
    };
  },
});

/**
 * Actividad del usuario para la home del portal (stat cards + secciones):
 * reservas activas (pendientes/aprobadas) de sus unidades y PQRS abiertos.
 * No usa fecha del servidor (las queries son deterministas); el cliente filtra
 * por fecha si lo necesita.
 */
export const misActividades = query({
  args: { condominioId: v.id("condominios") },
  handler: async (ctx, args) => {
    const user = await getCurrentAppUser(ctx);
    if (!user) return { reservasActivas: [], ticketsAbiertos: 0 };

    const membership = await getMembership(ctx, user._id, args.condominioId);

    // PQRS abiertos del usuario
    const pqrs = await ctx.db
      .query("pqrs")
      .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
      .collect();
    const ticketsAbiertos = pqrs.filter(
      (p) =>
        p.solicitanteUserId === user._id &&
        (p.estado === "abierto" || p.estado === "en_gestion"),
    ).length;

    // Reservas activas de las unidades del usuario
    let reservasActivas: {
      _id: string;
      zonaNombre: string;
      unidadNumero: string;
      fecha: string;
      horaInicio: string;
      horaFin: string;
      estado: Doc<"reservas">["estado"];
    }[] = [];

    if (membership) {
      /* Las reservas de sus casas de HOY: un vínculo vencido no cuenta. */
      const unidadIds = await misUnidadIds(ctx, user._id, args.condominioId);

      if (unidadIds.size > 0) {
        const reservas = await ctx.db
          .query("reservas")
          .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
          .collect();
        reservasActivas = reservas
          .filter(
            (r) =>
              unidadIds.has(r.unidadId) &&
              (r.estado === "pendiente" || r.estado === "aprobada"),
          )
          .sort((a, b) => b.fecha.localeCompare(a.fecha))
          .slice(0, 5)
          .map((r) => ({
            _id: r._id as string,
            zonaNombre: r.zonaNombre,
            unidadNumero: r.unidadNumero,
            fecha: r.fecha,
            horaInicio: r.horaInicio,
            horaFin: r.horaFin,
            estado: r.estado,
          }));
      }
    }

    return { reservasActivas, ticketsAbiertos };
  },
});

/**
 * Contadores para badges del sidebar del portal (facturas vencidas, PQRS, etc.).
 */
/**
 * Los paquetes de las casas del residente.
 *
 * Existia la vista de la porteria —quien recibe y quien entrega— pero no la
 * del duenno: el paquete quedaba en la lista del guarda y el residente solo
 * se enteraba si bajaba a preguntar. Ahora la notificacion tiene donde
 * aterrizar.
 */
export const misPaquetes = query({
  args: { condominioId: v.id("condominios") },
  handler: async (ctx, args) => {
    const user = await getCurrentAppUser(ctx);
    if (!user) return [];
    const unidadIds = await misUnidadIds(ctx, user._id, args.condominioId);
    if (unidadIds.size === 0) return [];

    /* Los paquetes viejos no tienen `unidadId`: se guardaba solo el numero
     * como texto. Para esos se compara por numero, que es lo unico que hay. */
    const unidades = await Promise.all(
      [...unidadIds].map((id) => ctx.db.get(id)),
    );
    const numeros = new Set(
      unidades
        .filter((u): u is NonNullable<typeof u> => u !== null)
        .map((u) => u.numero.trim().toLowerCase().replace(/\s+/g, "")),
    );

    const todos = await ctx.db
      .query("paquetes")
      .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
      .order("desc")
      .take(200);

    return todos
      .filter((p) =>
        p.unidadId
          ? unidadIds.has(p.unidadId)
          : numeros.has(p.unidadNumero.trim().toLowerCase().replace(/\s+/g, "")),
      )
      .slice(0, 40)
      .map((p) => ({
        _id: p._id,
        tipo: p.tipo,
        remitente: p.remitente ?? null,
        descripcion: p.descripcion ?? null,
        destinatario: p.destinatario ?? null,
        unidadNumero: p.unidadNumero,
        entregado: p.estado === "entregado",
        fechaRecibido: p.fechaRecibido,
        fechaEntregado: p.fechaEntregado ?? null,
        entregadoANombre: p.entregadoANombre ?? null,
      }));
  },
});

export const navBadges = query({
  args: { condominioId: v.id("condominios") },
  handler: async (ctx, args) => {
    const user = await getCurrentAppUser(ctx);
    if (!user) {
      return { facturasVencidas: 0, avisos: 0, asambleas: 0, pqrs: 0 };
    }

    const membership = await getMembership(ctx, user._id, args.condominioId);

    const pqrsRows = await ctx.db
      .query("pqrs")
      .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
      .collect();
    const pqrs = pqrsRows.filter(
      (p) =>
        p.solicitanteUserId === user._id &&
        (p.estado === "abierto" || p.estado === "en_gestion"),
    ).length;

    /* La mora ACTUAL: cuántas de sus unidades están en mora según la misma
     * regla de la cartera de la administración (`carteraDeUnidad`). Cada una
     * es una obligación vencida, la de su factura vigente.
     *
     * Antes contaba toda factura `vencida` del historial: una casa al día con
     * abril y junio vencidos —ya absorbidos y saldados por las siguientes—
     * sumaba 2, y una con la vigente vencida sin pagar (que sigue `pendiente`
     * porque ninguna factura posterior la ha juzgado) sumaba 0. */
    let facturasVencidas = 0;
    if (membership) {
      /* Solo sus casas de hoy: la mora de una casa donde ya no vive no es
       * suya (QA de comprobantes, H3). */
      const unidadIds = [...(await misUnidadIds(ctx, user._id, args.condominioId))];
      const ahora = Date.now();
      const carteras = await Promise.all(
        unidadIds.map(async (unidadId) => {
          const cadena = (
            await ctx.db
              .query("facturas")
              .withIndex("by_unidad", (q) => q.eq("unidadId", unidadId))
              .collect()
          ).filter((f) => f.condominioId === args.condominioId);
          return carteraDeUnidad(cadena, ahora);
        }),
      );
      facturasVencidas = carteras.filter((c) => c.estado === "en_mora").length;
    }

    const avisos = await ctx.db
      .query("comunicados")
      .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
      .take(40);
    const avisosCount = avisos.filter(
      (a) => a.prioridad === "urgente" || a.prioridad === "importante",
    ).length;

    const asambleas = await ctx.db
      .query("asambleas")
      .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
      .collect();
    const asambleasCount = asambleas.filter(
      (a) => a.estado === "programada" || a.estado === "en_curso",
    ).length;

    return {
      facturasVencidas,
      avisos: avisosCount,
      asambleas: asambleasCount,
      pqrs,
    };
  },
});
