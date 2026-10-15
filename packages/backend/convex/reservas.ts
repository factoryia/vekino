import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { query, mutation, internalQuery, internalMutation } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  aMinutos,
  cabeEnAlgunaFranja,
  fechasVecinas,
  rangoAbsoluto,
  seSolapan,
} from "./lib/horarios";
import { calcularCosto } from "./lib/costoReserva";
import {
  descripcionDeIncidentes,
  liquidarDeposito,
  montosDeDepositoResuelto,
  valorDeIncidentes,
} from "./lib/depositoReserva";
import {
  cajaDeposito,
  crearIncidente,
  depositoDeReserva,
  incidentesDeReserva,
  liquidarYDevolver,
  revisarIncidente,
  rolDeQuienOpera,
} from "./model/depositoReserva";
import {
  requireCondominioRole,
  requireAppUser,
  getCurrentAppUser,
  getMembership,
  misUnidadIds,
} from "./model/authz";
import { ventanaDiaBogota } from "./model/visitantes";
import { exigirArchivosSubidos } from "./model/registroArchivos";

export const ADMIN_ROLES = ["administrador", "junta_directiva", "contadora"] as const;

/**
 * Lo que se pacta al crear una reserva: cuanto cuesta y cuanto se deja en
 * garantia.
 *
 * Se copia de la zona en vez de leerla despues, por lo mismo que ya se hacia
 * con el deposito: si la administracion sube la tarifa en marzo, una reserva
 * de febrero sigue valiendo lo que se acordo. Antes solo se congelaba el
 * deposito; el valor del alquiler se calculaba en la pantalla del residente y
 * se perdia al enviar el formulario, asi que la administracion no podia verlo
 * en ninguna parte.
 *
 * El calculo es el MISMO que ve el residente antes de confirmar
 * (`lib/costoReserva`), no una segunda cuenta que pueda desviarse.
 */
function valoresPactados(
  zona: Doc<"zonasComunes">,
  horaInicio: string,
  horaFin: string,
): { valorReserva: number | undefined; depositoRequerido: number | undefined } {
  const costo = calcularCosto(zona, horaInicio, horaFin);
  return {
    /* Sin tarifa no se guarda un cero: cero es "gratis", y esto es "nadie le
     * puso precio". La diferencia importa cuando la administracion cuadre
     * caja. */
    valorReserva: costo.sinTarifa ? undefined : costo.alquiler,
    depositoRequerido: zona.depositoRequerido,
  };
}

const estadoValidator = v.union(
  v.literal("pendiente"),
  v.literal("aprobada"),
  v.literal("rechazada"),
  v.literal("cancelada")
);

const tipoZonaValidator = v.union(
  v.literal("salon_social"),
  v.literal("zona_bbq"),
  v.literal("sauna"),
  v.literal("casa_eventos"),
  v.literal("gimnasio"),
  v.literal("piscina"),
  v.literal("cancha_deportiva"),
  v.literal("parqueadero"),
  v.literal("otro"),
);

const unidadTiempoValidator = v.union(
  v.literal("hora"),
  v.literal("dia"),
  v.literal("mes"),
);

const horarioDiaValidator = v.object({
  dia: v.number(),
  horaInicio: v.string(),
  horaFin: v.string(),
});

function assertHorarios(
  horarios: { dia: number; horaInicio: string; horaFin: string }[],
) {
  if (horarios.length === 0) {
    throw new Error("Activa al menos un día con horario.");
  }
  for (const h of horarios) {
    if (h.dia < 0 || h.dia > 6) {
      throw new Error("Día de la semana inválido.");
    }
    /* No se compara fin > inicio: un salón que abre a las 09:00 y cierra a
     * las 02:00 es un horario legítimo, no un error de captura. `rango` lo
     * lee como cierre del día siguiente (lib/horarios.ts). */
    if (aMinutos(h.horaInicio) == null || aMinutos(h.horaFin) == null) {
      throw new Error("Formato de hora inválido (usa HH:MM).");
    }
  }
}

// ─── Zonas comunes ────────────────────────────────────────────

export const listZonas = query({
  args: { condominioId: v.id("condominios") },
  handler: async (ctx, args) => {
    await requireCondominioRole(ctx, args.condominioId, []);
    return await ctx.db
      .query("zonasComunes")
      .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
      .collect();
  },
});

export const createZona = mutation({
  args: {
    condominioId: v.id("condominios"),
    nombre: v.string(),
    tipo: v.optional(tipoZonaValidator),
    unidadTiempo: v.optional(unidadTiempoValidator),
    precioPorHora: v.optional(v.number()),
    precioPorDia: v.optional(v.number()),
    precioPorMes: v.optional(v.number()),
    horariosPorDia: v.optional(v.array(horarioDiaValidator)),
    requiereAprobacion: v.optional(v.boolean()),
    /** Depósito que se deja al reservar y se devuelve si se entrega bien. */
    depositoRequerido: v.optional(v.number()),
    capacidad: v.optional(v.number()),
    descripcion: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireCondominioRole(ctx, args.condominioId, [...ADMIN_ROLES]);
    const nombre = args.nombre.trim();
    if (!nombre) throw new Error("El nombre es obligatorio.");

    const horarios = args.horariosPorDia ?? [];
    if (horarios.length > 0) assertHorarios(horarios);

    const precioPorHora =
      args.precioPorHora != null && !Number.isNaN(args.precioPorHora)
        ? Math.max(0, args.precioPorHora)
        : undefined;
    const precioPorDia =
      args.precioPorDia != null && !Number.isNaN(args.precioPorDia)
        ? Math.max(0, args.precioPorDia)
        : undefined;
    const precioPorMes =
      args.precioPorMes != null && !Number.isNaN(args.precioPorMes)
        ? Math.max(0, args.precioPorMes)
        : undefined;

    const now = Date.now();
    return await ctx.db.insert("zonasComunes", {
      condominioId: args.condominioId,
      nombre,
      tipo: args.tipo ?? "otro",
      unidadTiempo: args.unidadTiempo ?? "hora",
      precioPorHora,
      precioPorDia,
      precioPorMes,
      horariosPorDia: horarios.length > 0 ? horarios : undefined,
      requiereAprobacion: args.requiereAprobacion ?? true,
      depositoRequerido: args.depositoRequerido,
      capacidad: args.capacidad,
      descripcion: args.descripcion?.trim() || undefined,
      activa: true,
      createdAt: now,
      updatedAt: now,
    });
  },
});

/**
 * Edita una zona comun ya creada.
 *
 * Hacia falta: hasta ahora una zona solo se podia crear o desactivar, asi
 * que para ponerle el deposito a una que ya existia habria que borrarla y
 * volverla a crear —perdiendo el historial de reservas que cuelga de ella.
 */
export const updateZona = mutation({
  args: {
    id: v.id("zonasComunes"),
    nombre: v.optional(v.string()),
    tipo: v.optional(tipoZonaValidator),
    unidadTiempo: v.optional(unidadTiempoValidator),
    precioPorHora: v.optional(v.number()),
    precioPorDia: v.optional(v.number()),
    precioPorMes: v.optional(v.number()),
    requiereAprobacion: v.optional(v.boolean()),
    depositoRequerido: v.optional(v.number()),
    capacidad: v.optional(v.number()),
    descripcion: v.optional(v.string()),
    /* Faltaba, y era justo lo que la administración necesitaba corregir: un
     * horario mal puesto solo se podía arreglar borrando la zona y volviéndola
     * a crear, lo que se lleva por delante su historial de reservas. */
    horariosPorDia: v.optional(v.array(horarioDiaValidator)),
  },
  handler: async (ctx, args) => {
    const zona = await ctx.db.get(args.id);
    if (!zona) throw new Error("Zona no encontrada.");
    await requireCondominioRole(ctx, zona.condominioId, [...ADMIN_ROLES]);

    const { id, ...campos } = args;
    const nombre = campos.nombre?.trim();
    if (campos.nombre !== undefined && !nombre) {
      throw new Error("El nombre no puede quedar vacio.");
    }

    if (args.horariosPorDia) assertHorarios(args.horariosPorDia);

    /* Solo se tocan los campos que vinieron. `undefined` significa "no lo
     * cambies", no "borralo": pasar el objeto entero borraria el precio de
     * una zona por editarle el nombre. */
    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    for (const [k, valor] of Object.entries(campos)) {
      if (valor !== undefined) patch[k] = k === "nombre" ? nombre : valor;
    }
    await ctx.db.patch(id, patch);
  },
});

export const toggleZona = mutation({
  args: { id: v.id("zonasComunes") },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.id);
    if (!existing) throw new Error("Zona no encontrada.");
    await requireCondominioRole(ctx, existing.condominioId, [...ADMIN_ROLES]);
    await ctx.db.patch(args.id, { activa: !existing.activa, updatedAt: Date.now() });
  },
});

export const removeZona = mutation({
  args: { id: v.id("zonasComunes") },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.id);
    if (!existing) throw new Error("Zona no encontrada.");
    await requireCondominioRole(ctx, existing.condominioId, [...ADMIN_ROLES]);
    await ctx.db.delete(args.id);
  },
});

// ─── Reservas ─────────────────────────────────────────────────

export const listByCondominio = query({
  args: { condominioId: v.id("condominios") },
  handler: async (ctx, args) => {
    await requireCondominioRole(ctx, args.condominioId, []);
    const filas = await ctx.db
      .query("reservas")
      .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
      .order("desc")
      .collect();
    return await conValores(ctx, args.condominioId, filas);
  },
});

/** Conteos de estado (escanea máx. 2000). */
export const countsByCondominio = query({
  args: { condominioId: v.id("condominios") },
  handler: async (ctx, args) => {
    await requireCondominioRole(ctx, args.condominioId, []);
    const rows = await ctx.db
      .query("reservas")
      .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
      .take(2000);
    return {
      total: rows.length,
      pendiente: rows.filter((r) => r.estado === "pendiente").length,
      aprobada: rows.filter((r) => r.estado === "aprobada").length,
      rechazada: rows.filter((r) => r.estado === "rechazada").length,
    };
  },
});

/**
 * Le pone a cada reserva lo que cuesta y lo que se deja en garantia.
 *
 * Las reservas creadas desde que existe `valorReserva` ya lo traen pactado y
 * aqui no se toca. Las anteriores no lo tienen —el valor solo vivia en la
 * pantalla del residente— y en vez de dejar la columna en blanco se calcula
 * con la tarifa que la zona tiene HOY, marcandolo como estimado: es un dato
 * util para la administracion, pero no es lo que se acordo y no puede
 * presentarse como si lo fuera.
 *
 * Las zonas se leen UNA vez por pagina, no una por fila: treinta reservas de
 * un conjunto suelen ser cuatro zonas, y preguntar por fila serian treinta
 * consultas para cuatro respuestas.
 */
async function conValores<T extends Doc<"reservas">>(
  ctx: QueryCtx,
  condominioId: Id<"condominios">,
  filas: T[],
) {
  const necesitaZonas = filas.some(
    (r) => r.valorReserva == null || r.depositoRequerido == null,
  );
  const zonas = necesitaZonas
    ? new Map(
        (
          await ctx.db
            .query("zonasComunes")
            .withIndex("by_condominio", (q) => q.eq("condominioId", condominioId))
            .collect()
        ).map((z) => [z._id, z]),
      )
    : new Map<Id<"zonasComunes">, Doc<"zonasComunes">>();

  return filas.map((r) => {
    const pactadoValor = r.valorReserva != null;
    const pactadoDeposito = r.depositoRequerido != null;
    if (pactadoValor && pactadoDeposito) {
      return {
        ...r,
        valorReserva: r.valorReserva,
        depositoRequerido: r.depositoRequerido,
        valoresEstimados: false,
      };
    }
    /* La zona pudo borrarse: sin ella no hay tarifa de donde estimar, y eso
     * es "no se sabe", no "estimado". */
    const zona = zonas.get(r.zonaId);
    const costo = zona ? calcularCosto(zona, r.horaInicio, r.horaFin) : null;
    const valorReserva = pactadoValor
      ? r.valorReserva
      : costo && !costo.sinTarifa
        ? costo.alquiler
        : null;
    const depositoDeZona =
      !pactadoDeposito && zona?.depositoRequerido != null;
    return {
      ...r,
      valorReserva,
      depositoRequerido: r.depositoRequerido ?? zona?.depositoRequerido,
      /* Solo se marca cuando de verdad se saco algo de la zona de hoy. Marcar
       * una fila que no estima nada haria dudar de un dato que si esta
       * pactado. */
      valoresEstimados:
        (!pactadoValor && valorReserva != null) || depositoDeZona,
    };
  });
}

/** Cruza cada reserva con lo que realmente se cobró, su depósito e incidentes. */
async function conCaja<T extends Doc<"reservas">>(
  ctx: QueryCtx,
  filas: Array<T & { valorReserva?: number | null; depositoRequerido?: number; valoresEstimados?: boolean }>,
) {
  return await Promise.all(
    filas.map(async (r) => {
      const dep = await depositoDeReserva(ctx, r._id);
      return {
        ...r,
        pagoAlquilerMonto: r.pagoAlquilerMonto ?? null,
        pagoAlquilerAt: r.pagoAlquilerAt ?? null,
        pagoAlquilerPorNombre: r.pagoAlquilerPorNombre ?? null,
        pagoAlquilerNotas: r.pagoAlquilerNotas ?? null,
        depositoCaja: dep
          ? {
              _id: dep._id,
              monto: dep.monto,
              estado: dep.estado,
              observacionesSalida: dep.observacionesSalida ?? null,
              resueltoPorNombre: dep.resueltoPorNombre ?? null,
              fechaResolucion: dep.fechaResolucion ?? null,
            }
          : null,
        ...(await cajaDeposito(ctx, r._id, dep)),
      };
    }),
  );
}

export const listPage = query({
  args: {
    condominioId: v.id("condominios"),
    paginationOpts: paginationOptsValidator,
    estado: v.optional(estadoValidator),
    zonaId: v.optional(v.id("zonasComunes")),
  },
  handler: async (ctx, args) => {
    await requireCondominioRole(ctx, args.condominioId, []);
    const estado = args.estado;
    const zonaId = args.zonaId;

    if (estado || zonaId) {
      const scan = await ctx.db
        .query("reservas")
        .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
        .order("desc")
        .take(250);
      const filtered = scan.filter((r) => {
        if (estado && r.estado !== estado) return false;
        if (zonaId && r.zonaId !== zonaId) return false;
        return true;
      });
      const limit = Math.min(args.paginationOpts.numItems || 30, 60);
      return {
        page: await conCaja(
          ctx,
          await conValores(ctx, args.condominioId, filtered.slice(0, limit)),
        ),
        isDone: true,
        continueCursor: "",
      };
    }

    const pagina = await ctx.db
      .query("reservas")
      .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
      .order("desc")
      .paginate(args.paginationOpts);

    return {
      ...pagina,
      page: await conCaja(
        ctx,
        await conValores(ctx, args.condominioId, pagina.page),
      ),
    };
  },
});

/** Conteo liviano de reservas pendientes (home). Escanea como máximo 120 recientes. */
export const countPendientes = query({
  args: { condominioId: v.id("condominios") },
  handler: async (ctx, args) => {
    await requireCondominioRole(ctx, args.condominioId, []);
    const recent = await ctx.db
      .query("reservas")
      .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
      .order("desc")
      .take(120);
    return recent.filter((r) => r.estado === "pendiente").length;
  },
});

export const create = mutation({
  args: {
    condominioId: v.id("condominios"),
    unidadId: v.id("unidades"),
    zonaId: v.id("zonasComunes"),
    fecha: v.string(),
    horaInicio: v.string(),
    horaFin: v.string(),
    observaciones: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireCondominioRole(ctx, args.condominioId, [...ADMIN_ROLES]);
    const zona = await ctx.db.get(args.zonaId);
    if (!zona) throw new Error("Zona no encontrada.");
    const unidad = await ctx.db.get(args.unidadId);
    if (!unidad) throw new Error("Unidad no encontrada.");
    const now = Date.now();
    return await ctx.db.insert("reservas", {
      condominioId: args.condominioId,
      unidadId: args.unidadId,
      zonaId: args.zonaId,
      zonaNombre: zona.nombre,
      unidadNumero: unidad.numero,
      solicitanteNombre: user.name,
      fecha: args.fecha,
      horaInicio: args.horaInicio,
      horaFin: args.horaFin,
      estado: "pendiente",
      observaciones: args.observaciones?.trim(),
      ...valoresPactados(zona, args.horaInicio, args.horaFin),
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const updateEstado = mutation({
  args: {
    id: v.id("reservas"),
    estado: estadoValidator,
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.id);
    if (!existing) throw new Error("Reserva no encontrada.");
    await requireCondominioRole(ctx, existing.condominioId, [...ADMIN_ROLES]);
    await ctx.db.patch(args.id, { estado: args.estado, updatedAt: Date.now() });
  },
});

/**
 * Marca que se cobró el alquiler de la reserva.
 *
 * Sin esto el reporte solo podía decir "no se recibió", porque nadie tenía
 * dónde apuntar que sí se cobró. Portería registra el depósito; el alquiler
 * lo cobra la administración.
 */
export const registrarPagoAlquiler = mutation({
  args: {
    id: v.id("reservas"),
    monto: v.number(),
    notas: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const r = await ctx.db.get(args.id);
    if (!r) throw new Error("Reserva no encontrada.");
    const { user } = await requireCondominioRole(ctx, r.condominioId, [...ADMIN_ROLES]);
    if (!Number.isFinite(args.monto) || args.monto <= 0) {
      throw new Error("El monto cobrado debe ser mayor a 0.");
    }
    await ctx.db.patch(args.id, {
      pagoAlquilerMonto: args.monto,
      pagoAlquilerAt: Date.now(),
      pagoAlquilerPorNombre: user.name,
      pagoAlquilerNotas: args.notas?.trim() || undefined,
      updatedAt: Date.now(),
    });
  },
});

/**
 * La administración registra el depósito (sin validar el ingreso de portería).
 *
 * El depósito vivía solo en el flujo del guarda. Quien cobra en oficina no
 * podía dejar constancia, y el reporte salía como si no se hubiera recibido.
 */
export const registrarDeposito = mutation({
  args: {
    id: v.id("reservas"),
    monto: v.number(),
    observaciones: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const r = await ctx.db.get(args.id);
    if (!r) throw new Error("Reserva no encontrada.");
    const { user, membership } = await requireCondominioRole(ctx, r.condominioId, [...ADMIN_ROLES]);
    if (!Number.isFinite(args.monto) || args.monto <= 0) {
      throw new Error("El monto del depósito debe ser mayor a 0.");
    }
    const existente = await ctx.db
      .query("guardiaReservaDepositos")
      .withIndex("by_reserva", (q) => q.eq("reservaId", args.id))
      .first();
    if (existente) throw new Error("Esta reserva ya tiene un depósito registrado.");

    await ctx.db.insert("guardiaReservaDepositos", {
      condominioId: r.condominioId,
      reservaId: args.id,
      monto: args.monto,
      observacionesIngreso: args.observaciones?.trim() || undefined,
      estado: "registrado",
      recibidoPorNombre: user.name,
      recibidoPorUserId: user._id,
      recibidoPorRol: rolDeQuienOpera(user, membership, "administracion"),
      recibidoOrigen: "administracion",
      fechaRegistro: Date.now(),
    });
    await ctx.db.patch(args.id, { updatedAt: Date.now() });
  },
});

/**
 * Devuelve el depósito desde oficina.
 *
 * Ya no hay "retener": lo que se descuenta sale de los incidentes valorados
 * y lo calcula el servidor (`model/depositoReserva.ts`). Si hubo incidentes,
 * la razón es obligatoria. A diferencia de portería, no valida la salida.
 *
 * `devuelto` queda solo por compatibilidad de forma: `false` se rechaza.
 */
export const resolverDeposito = mutation({
  args: {
    depositoId: v.id("guardiaReservaDepositos"),
    /** @deprecated La retención a criterio ya no existe; `false` se rechaza. */
    devuelto: v.optional(v.boolean()),
    /** Razón de la devolución. */
    observaciones: v.optional(v.string()),
    /** El saldo que se estaba mostrando; debe coincidir con el calculado. */
    saldoEsperado: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const dep = await ctx.db.get(args.depositoId);
    if (!dep) throw new Error("Depósito no encontrado.");
    const { user, membership } = await requireCondominioRole(ctx, dep.condominioId, [...ADMIN_ROLES]);
    return await liquidarYDevolver(ctx, {
      deposito: dep,
      user,
      membership,
      origen: "administracion",
      devuelto: args.devuelto,
      razon: args.observaciones,
      saldoEsperado: args.saldoEsperado,
    });
  },
});

// ─── Incidentes de la reserva (administración) ────────────────

/**
 * La administración registra un incidente, con o sin valor.
 *
 * Con valor queda `valorado` y descuenta de una vez; sin él queda `pendiente`
 * igual que si lo hubiera reportado portería.
 */
export const registrarIncidente = mutation({
  args: {
    reservaId: v.id("reservas"),
    descripcion: v.string(),
    valor: v.optional(v.number()),
    fotos: v.optional(
      v.array(v.object({ url: v.string(), nombre: v.optional(v.string()) })),
    ),
  },
  handler: async (ctx, args) => {
    const reserva = await ctx.db.get(args.reservaId);
    if (!reserva) throw new Error("Reserva no encontrada.");
    const { user } = await requireCondominioRole(ctx, reserva.condominioId, [...ADMIN_ROLES]);
    // Fotos de subidas validadas de quien registra, a la carpeta de la caja (`model/registroArchivos.ts`).
    await exigirArchivosSubidos(ctx, user._id, args.fotos ?? [], `condominios/${reserva.condominioId}/reservas/incidentes`);
    return await crearIncidente(ctx, {
      reserva,
      user,
      origen: "administracion",
      descripcion: args.descripcion,
      fotos: args.fotos,
      valor: args.valor,
    });
  },
});

/**
 * Le pone (o corrige) el valor a un incidente.
 *
 * Es la decisión económica que portería no toma: sirve para los reportados
 * por el guarda y para corregir uno ya valorado o descartado, mientras el
 * depósito no se haya liquidado.
 */
export const valorarIncidente = mutation({
  args: {
    incidenteId: v.id("reservaIncidentes"),
    valor: v.number(),
    nota: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const incidente = await ctx.db.get(args.incidenteId);
    if (!incidente) throw new Error("Incidente no encontrado.");
    const { user } = await requireCondominioRole(ctx, incidente.condominioId, [...ADMIN_ROLES]);
    await revisarIncidente(ctx, {
      incidente,
      user,
      decision: { tipo: "valorar", valor: args.valor },
      nota: args.nota,
    });
  },
});

/** La administración revisa un incidente y decide que no descuenta nada. */
export const descartarIncidente = mutation({
  args: {
    incidenteId: v.id("reservaIncidentes"),
    nota: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const incidente = await ctx.db.get(args.incidenteId);
    if (!incidente) throw new Error("Incidente no encontrado.");
    const { user } = await requireCondominioRole(ctx, incidente.condominioId, [...ADMIN_ROLES]);
    await revisarIncidente(ctx, {
      incidente,
      user,
      decision: { tipo: "descartar" },
      nota: args.nota,
    });
  },
});

export const remove = mutation({
  args: { id: v.id("reservas") },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.id);
    if (!existing) throw new Error("Reserva no encontrada.");
    await requireCondominioRole(ctx, existing.condominioId, [...ADMIN_ROLES]);
    const dep = await depositoDeReserva(ctx, args.id);
    if (dep) await ctx.db.delete(dep._id);
    /* Sin la reserva, un incidente no se asocia a nada: se van con ella. */
    for (const i of await incidentesDeReserva(ctx, args.id)) {
      await ctx.db.delete(i._id);
    }
    await ctx.db.delete(args.id);
  },
});

/**
 * Reporte de reservas de un rango de fechas, con caja de alquiler y depósito.
 *
 * El valor pactado no es un cobro. Hasta que administración (o portería)
 * marca que recibió el dinero, el reporte dice "sin registrar" — no "no se
 * recibió". Mezclar las dos cosas era el hueco: nadie tenía dónde anotar el
 * pago, y el informe salía como si el conjunto no hubiera cobrado.
 */
export const reporte = query({
  args: {
    condominioId: v.id("condominios"),
    /** "2026-08-01". Inclusive. */
    desde: v.string(),
    /** "2026-08-31". Inclusive. */
    hasta: v.string(),
    /** Solo las reservas en este estado. Sin él, todas (como siempre). */
    estado: v.optional(estadoValidator),
  },
  handler: async (ctx, args) => {
    await requireCondominioRole(ctx, args.condominioId, [...ADMIN_ROLES]);

    /* Las fechas son "AAAA-MM-DD", asi que comparar como texto ya ordena
     * bien. No hace falta convertirlas ni preocuparse por zonas horarias.
     * El rango va en el indice: antes se traia todo el historico del
     * conjunto para descartarlo en memoria. */
    const reservas = await ctx.db
      .query("reservas")
      .withIndex("by_condominio_fecha", (q) =>
        q.eq("condominioId", args.condominioId).gte("fecha", args.desde).lte("fecha", args.hasta),
      )
      .collect();

    /* El estado se filtra ANTES de estimar valores y buscar depositos, para
     * no gastar lecturas en filas que no van al reporte. El resumen de abajo
     * se calcula sobre lo que queda, con la misma regla de siempre. */
    const enRango = reservas
      .filter((r) => !args.estado || r.estado === args.estado)
      .sort((a, b) => a.fecha.localeCompare(b.fecha) || a.horaInicio.localeCompare(b.horaInicio));

    const conVals = await conValores(ctx, args.condominioId, enRango);
    const filas = await Promise.all(
      conVals.map(async (r) => {
        const dep = await depositoDeReserva(ctx, r._id);
        /* Los resueltos antes de los incidentes no guardan cifras: se deducen
         * del estado, como siempre se leyeron. */
        const montos = dep ? montosDeDepositoResuelto(dep) : null;
        /* Se leen los incidentes y no `dep.totalIncidentes`: una reserva sin
         * depósito o con el depósito aún en custodia también puede tenerlos. */
        const incidentes = await incidentesDeReserva(ctx, r._id);
        return {
          _id: r._id,
          /* Lo que valen los incidentes de ESTA reserva, sin tope. No es el
           * depósito ni lo descontado (`depositoDescontado`). */
          valorIncidentes: valorDeIncidentes(incidentes),
          /* Qué pasó, al lado de cuánto costó. Van TODOS los incidentes de la
           * reserva —también los pendientes y los descartados—: el valor solo
           * suma los valorados, pero el reporte tiene que poder explicar de
           * qué habla. Vacío cuando no hubo ninguno. */
          descripcionIncidentes: descripcionDeIncidentes(incidentes),
          fecha: r.fecha,
          horaInicio: r.horaInicio,
          horaFin: r.horaFin,
          zonaNombre: r.zonaNombre,
          unidadNumero: r.unidadNumero,
          solicitanteNombre: r.solicitanteNombre,
          estado: r.estado,
          valorReserva: r.valorReserva ?? null,
          pagoAlquilerMonto: r.pagoAlquilerMonto ?? null,
          depositoRequerido: r.depositoRequerido ?? null,
          valoresEstimados: r.valoresEstimados,
          depositoRecibido: dep?.monto ?? null,
          depositoEstado: dep?.estado ?? null,
          depositoDescontado: montos?.descontado ?? null,
          depositoDevuelto: montos?.devuelto ?? null,
          /* La razón de lo que no se devolvió: la retención de antes o la
           * devolución parcial/total por incidentes de ahora. */
          depositoRetencion:
            dep && (dep.estado === "no_devuelto" || dep.estado === "devuelto_parcial")
              ? (dep.observacionesSalida ?? null)
              : null,
          /* Lo que se escribió al pedir la reserva. Viene en el mismo
           * documento: no cuesta ninguna lectura más. */
          observaciones: r.observaciones ?? null,
          ingresoValidadoAt: r.ingresoValidadoAt ?? null,
          salidaValidadaAt: r.salidaValidadaAt ?? null,
        };
      }),
    );

    /* Los totales se calculan aqui y no en el navegador: son los numeros que
     * la administracion va a cuadrar contra la caja. */
    const cobrables = filas.filter((f) => f.estado !== "cancelada" && f.estado !== "rechazada");
    return {
      filas,
      resumen: {
        total: filas.length,
        aprobadas: filas.filter((f) => f.estado === "aprobada").length,
        canceladas: filas.filter((f) => f.estado === "cancelada").length,
        alquilerEsperado: cobrables.reduce((s, f) => s + (f.valorReserva ?? 0), 0),
        alquilerRecibido: cobrables.reduce((s, f) => s + (f.pagoAlquilerMonto ?? 0), 0),
        depositoEsperado: cobrables.reduce((s, f) => s + (f.depositoRequerido ?? 0), 0),
        alquilerSinRegistrar: cobrables.filter(
          (f) => f.valorReserva != null && f.pagoAlquilerMonto == null,
        ).length,
        depositoSinRegistrar: cobrables.filter(
          (f) => f.depositoRequerido && f.depositoRecibido == null,
        ).length,
        depositosSinDevolver: filas.filter((f) => f.depositoEstado === "registrado").length,
        depositosRetenidos: filas.filter((f) => f.depositoEstado === "no_devuelto").length,
        depositosDevueltosParcial: filas.filter((f) => f.depositoEstado === "devuelto_parcial").length,
        /* Lo que los incidentes descontaron de depósitos ya liquidados. El
         * excedente sobre el depósito no está aquí: no es del sistema. */
        depositoDescontado: filas.reduce((s, f) => s + (f.depositoDescontado ?? 0), 0),
        /* Suma de la columna "Valor de incidentes" de las filas del reporte
         * (rango y estado ya filtrados). Sobre TODAS las filas, como
         * `depositoDescontado`: un daño no deja de haber ocurrido porque la
         * reserva se cancele después. Sin tope: no es un ingreso. */
        valorIncidentes: filas.reduce((s, f) => s + f.valorIncidentes, 0),
      },
    };
  },
});

/**
 * AUDITORÍA DE DEPÓSITOS: qué pasó con cada garantía, y quién la tocó.
 *
 * Una fila por DEPÓSITO —no por reserva—: lo que se audita es el dinero, y
 * una reserva sin depósito no tiene nada que auditar. De ahí que no salga de
 * `reporte`, que recorre reservas.
 *
 * Nada se recalcula al leer. Las cifras de un depósito ya liquidado son las
 * congeladas al entregarlo (`montosDeDepositoResuelto`), y quién lo recibió o
 * lo devolvió es lo que se selló en ese momento: si el rol no se guardó
 * —depósitos anteriores a `recibidoPorRol`— sale `null` y la pantalla lo dice.
 * Rellenarlo con el rol que esa persona tiene hoy sería inventar el pasado.
 *
 * El único cálculo es la proyección de lo que se devolvería HOY, y solo para
 * los que siguen en custodia: va aparte, marcada como previsión.
 */
const criterioFechaValidator = v.union(
  /** El depósito se recibió dentro del rango. */
  v.literal("recepcion"),
  /** Se devolvió dentro del rango. */
  v.literal("devolucion"),
  /** Cualquiera de las dos cosas ocurrió dentro del rango. */
  v.literal("cualquiera"),
);

export const auditoriaDepositos = query({
  args: {
    condominioId: v.id("condominios"),
    /** "2026-08-01". Inclusive, día civil de Bogotá. */
    desde: v.string(),
    /** "2026-08-31". Inclusive. */
    hasta: v.string(),
    /** Qué fecha tiene que caer en el rango. Sin él, cualquiera de las dos. */
    criterio: v.optional(criterioFechaValidator),
  },
  handler: async (ctx, args) => {
    /* El mismo permiso que el reporte de reservas: leer la caja del conjunto.
     * Va por `condominioId` y el índice filtra por él, así que cambiar el
     * parámetro no enseña los depósitos de otro conjunto: enseña un error. */
    await requireCondominioRole(ctx, args.condominioId, [...ADMIN_ROLES]);
    if (args.desde > args.hasta) {
      throw new Error("La fecha inicial no puede ser posterior a la final.");
    }
    const criterio = args.criterio ?? "cualquiera";
    const { inicio } = ventanaDiaBogota(args.desde);
    const { fin } = ventanaDiaBogota(args.hasta);

    /* El índice acota por fecha de RECEPCIÓN, la única que todo depósito
     * tiene. Filtrando por ella el rango cierra por los dos lados; en los
     * otros dos criterios solo puede cerrar por arriba —un depósito devuelto
     * en septiembre pudo recibirse en julio—, pero eso ya evita leer lo
     * posterior al rango, que en un conjunto con años de histórico es la
     * mitad de la tabla. */
    const depositos = await ctx.db
      .query("guardiaReservaDepositos")
      .withIndex("by_condominio_registro", (q) =>
        criterio === "recepcion"
          ? q
              .eq("condominioId", args.condominioId)
              .gte("fechaRegistro", inicio)
              .lte("fechaRegistro", fin)
          : q.eq("condominioId", args.condominioId).lte("fechaRegistro", fin),
      )
      .collect();

    const enRango = depositos.filter((d) => {
      const recibido = d.fechaRegistro >= inicio && d.fechaRegistro <= fin;
      const devuelto =
        d.fechaResolucion != null && d.fechaResolucion >= inicio && d.fechaResolucion <= fin;
      if (criterio === "recepcion") return recibido;
      if (criterio === "devolucion") return devuelto;
      return recibido || devuelto;
    });

    const filas = (
      await Promise.all(
        enRango
          .sort((a, b) => b.fechaRegistro - a.fechaRegistro)
          .map(async (d) => {
            const r = await ctx.db.get(d.reservaId);
            /* Cinturón: el índice ya es por conjunto, pero la fila se arma
             * con datos de la reserva y esos tienen que ser del mismo. */
            if (!r || r.condominioId !== args.condominioId) return null;
            const incidentes = await incidentesDeReserva(ctx, d.reservaId);
            const montos = montosDeDepositoResuelto(d);
            const enCustodia = d.estado === "registrado";
            return {
              _id: d._id,
              reservaId: d.reservaId,
              fecha: r.fecha,
              horaInicio: r.horaInicio,
              horaFin: r.horaFin,
              zonaNombre: r.zonaNombre,
              unidadNumero: r.unidadNumero,
              solicitanteNombre: r.solicitanteNombre,
              estadoReserva: r.estado,
              /** Lo que se recibió. Nunca cambia. */
              monto: d.monto,
              estado: d.estado,
              fechaRegistro: d.fechaRegistro,
              recibidoPorNombre: d.recibidoPorNombre,
              recibidoPorRol: d.recibidoPorRol ?? null,
              recibidoOrigen: d.recibidoOrigen ?? null,
              observacionesIngreso: d.observacionesIngreso ?? null,
              fechaResolucion: d.fechaResolucion ?? null,
              resueltoPorNombre: d.resueltoPorNombre ?? null,
              resueltoPorRol: d.resueltoPorRol ?? null,
              resueltoOrigen: d.resueltoOrigen ?? null,
              /** La razón de la devolución; obligatoria cuando hubo incidentes. */
              motivoDevolucion: d.observacionesSalida ?? null,
              /** Lo entregado y lo descontado de verdad. Vacíos si sigue en custodia. */
              devuelto: montos?.devuelto ?? null,
              descontado: montos?.descontado ?? null,
              /** Lo que el conjunto todavía tiene en la mano. */
              enCustodia: enCustodia ? d.monto : 0,
              /**
               * Lo que se devolvería HOY si se liquidara. Previsión, no
               * historia: solo para los que siguen en custodia.
               */
              saldoPrevisto: enCustodia
                ? liquidarDeposito(d.monto, incidentes).saldoDevolucion
                : null,
              /**
               * Las cifras del liquidado salen del propio depósito o se
               * deducen del estado. Los anteriores a los incidentes no las
               * guardaron: la pantalla lo advierte en vez de fingir precisión.
               */
              cifrasCongeladas: d.montoDevuelto != null,
              valorIncidentes: valorDeIncidentes(incidentes),
              descripcionIncidentes: descripcionDeIncidentes(incidentes),
              incidentes: incidentes.length,
            };
          }),
      )
    ).filter((f) => f !== null);

    return {
      filas,
      resumen: {
        total: filas.length,
        /* Lo recibido: la suma de los depósitos del rango, se hayan devuelto
         * o no. No es un ingreso —es una garantía—, y por eso no se cruza con
         * los totales del reporte de reservas. */
        recibido: filas.reduce((s2, f) => s2 + f.monto, 0),
        enCustodia: filas.reduce((s2, f) => s2 + f.enCustodia, 0),
        devuelto: filas.reduce((s2, f) => s2 + (f.devuelto ?? 0), 0),
        descontado: filas.reduce((s2, f) => s2 + (f.descontado ?? 0), 0),
        valorIncidentes: filas.reduce((s2, f) => s2 + f.valorIncidentes, 0),
        conIncidentes: filas.filter((f) => f.incidentes > 0).length,
        /* Cuántas filas no pueden decir con qué rol se actuó: son las
         * anteriores a que el rol se guardara. La pantalla lo declara en vez
         * de dejar que se lea como "nadie las tocó". */
        sinRolRegistrado: filas.filter(
          (f) => !f.recibidoPorRol || (f.fechaResolucion != null && !f.resueltoPorRol),
        ).length,
      },
    };
  },
});

// ─────────────────────────────────────────────────────────────
// API del propietario: crea y ve las reservas de SUS unidades.
// ─────────────────────────────────────────────────────────────

/** Reservas de las unidades del usuario autenticado (más recientes primero). */
export const listMias = query({
  args: { condominioId: v.id("condominios") },
  handler: async (ctx, args) => {
    const user = await getCurrentAppUser(ctx);
    if (!user) return [];
    const unidadIds = await misUnidadIds(ctx, user._id, args.condominioId);
    if (unidadIds.size === 0) return [];

    const reservas = await ctx.db
      .query("reservas")
      .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
      .order("desc")
      .collect();

    const mias = reservas.filter((r) => unidadIds.has(r.unidadId));
    return await conValores(ctx, args.condominioId, mias);
  },
});

/** El propietario crea una reserva para una de SUS unidades (queda pendiente). */
export const createMia = mutation({
  args: {
    condominioId: v.id("condominios"),
    unidadId: v.id("unidades"),
    zonaId: v.id("zonasComunes"),
    fecha: v.string(),
    horaInicio: v.string(),
    horaFin: v.string(),
    observaciones: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireAppUser(ctx);
    const unidadIds = await misUnidadIds(ctx, user._id, args.condominioId);
    if (!unidadIds.has(args.unidadId)) {
      throw new Error("Esa unidad no está vinculada a tu cuenta.");
    }
    const zona = await ctx.db.get(args.zonaId);
    if (!zona || zona.condominioId !== args.condominioId) {
      throw new Error("Zona no encontrada.");
    }
    if (!zona.activa) throw new Error("Esa zona no está disponible.");
    const unidad = await ctx.db.get(args.unidadId);
    if (!unidad) throw new Error("Unidad no encontrada.");

    /* Antes aquí solo se comparaban las horas como texto, lo que descartaba
     * "22:00 a 01:00" y no miraba si el salón ya estaba cogido. Se delega en
     * la misma comprobación que usa el bot: entiende los horarios que cruzan
     * la medianoche y detecta el solape con lo ya reservado. */
    const disponible = await checkDisponibilidadZona(
      ctx,
      zona,
      args.fecha,
      args.horaInicio,
      args.horaFin,
    );
    if (!disponible.ok) {
      throw new Error(disponible.motivo ?? "Ese horario no está disponible.");
    }

    const now = Date.now();
    return await ctx.db.insert("reservas", {
      condominioId: args.condominioId,
      unidadId: args.unidadId,
      zonaId: args.zonaId,
      zonaNombre: zona.nombre,
      unidadNumero: unidad.numero,
      solicitanteNombre: user.name,
      fecha: args.fecha,
      horaInicio: args.horaInicio,
      horaFin: args.horaFin,
      estado: "pendiente",
      observaciones: args.observaciones?.trim(),
      ...valoresPactados(zona, args.horaInicio, args.horaFin),
      createdAt: now,
      updatedAt: now,
    });
  },
});

/**
 * El propietario cancela una reserva de SUS unidades.
 *
 * No la borra: la deja en "cancelada" para que la administración conserve el
 * histórico. Borrar sigue siendo exclusivo de la administración (`remove`).
 */
export const cancelarMia = mutation({
  args: { id: v.id("reservas") },
  handler: async (ctx, args) => {
    const user = await requireAppUser(ctx);
    const reserva = await ctx.db.get(args.id);
    if (!reserva) throw new Error("Reserva no encontrada.");

    const unidadIds = await misUnidadIds(ctx, user._id, reserva.condominioId);
    if (!unidadIds.has(reserva.unidadId)) {
      throw new Error("Esa reserva no pertenece a tu unidad.");
    }
    if (reserva.estado === "cancelada") {
      throw new Error("La reserva ya está cancelada.");
    }
    if (reserva.estado === "rechazada") {
      throw new Error("Una reserva rechazada no se puede cancelar.");
    }

    await ctx.db.patch(args.id, { estado: "cancelada", updatedAt: Date.now() });
    return args.id;
  },
});

// ─────────────────────────────────────────────────────────────
// Bot de WhatsApp: funciones internas (sin sesión Better Auth).
// El router de whatsapp.ts identifica al propietario por teléfono
// y llama estas funciones con el userId ya resuelto.
// ─────────────────────────────────────────────────────────────

/**
 * Verifica horarios de la zona y solape con otras reservas.
 * Lógica compartida entre verificarDisponibilidad y createFromBot.
 * Asume que la zona ya fue validada (existe y está activa).
 */
async function checkDisponibilidadZona(
  ctx: QueryCtx | MutationCtx,
  zona: Doc<"zonasComunes">,
  fecha: string,
  horaInicio: string,
  horaFin: string,
): Promise<{ ok: boolean; motivo?: string }> {
  // Horarios de funcionamiento (0=domingo … 6=sábado, igual que el schema).
  // Mediodía + getUTCDay para que el día no dependa del timezone del runtime.
  const pedido = rangoAbsoluto(fecha, horaInicio, horaFin);
  if (!pedido) {
    return { ok: false, motivo: "La fecha o la hora no son válidas." };
  }

  const horarios = zona.horariosPorDia ?? [];
  if (horarios.length > 0) {
    const dia = new Date(fecha + "T12:00:00").getUTCDay();
    const franjas = horarios.filter((h) => h.dia === dia);
    if (franjas.length === 0) {
      return { ok: false, motivo: "La zona no abre ese día." };
    }
    /* En minutos, no en texto: comparando "HH:MM" como cadena, una zona
     * abierta hasta las 02:00 rechazaba una reserva de media mañana
     * ("12:00" <= "02:00" es falso) y aceptaba casi cualquier cosa de
     * noche. */
    const inicioDelDia = rangoAbsoluto(fecha, "00:00", "00:01")!.inicio;
    const relativo = {
      inicio: pedido.inicio - inicioDelDia,
      fin: pedido.fin - inicioDelDia,
    };
    if (!cabeEnAlgunaFranja(relativo, franjas)) {
      const rangos = franjas
        .map((f) => `de ${f.horaInicio} a ${f.horaFin}`)
        .join(" y ");
      return { ok: false, motivo: `Ese día la zona funciona ${rangos}.` };
    }
  }

  /* Solape con reservas vigentes de la zona.
   *
   * Se miran también la víspera y el día siguiente. Una reserva del viernes
   * que termina a la 01:00 se guarda con fecha del VIERNES: sin mirar atrás,
   * una del sábado a las 00:30 no la vería y se aprobarían las dos sobre el
   * mismo salón. */
  const diasAMirar = new Set(fechasVecinas(fecha));
  const existentes = await ctx.db
    .query("reservas")
    .withIndex("by_zona", (q) => q.eq("zonaId", zona._id))
    .collect();

  for (const r of existentes) {
    if (!diasAMirar.has(r.fecha)) continue;
    if (r.estado !== "pendiente" && r.estado !== "aprobada") continue;
    const otra = rangoAbsoluto(r.fecha, r.horaInicio, r.horaFin);
    if (otra && seSolapan(pedido, otra)) {
      const cuando =
        r.fecha === fecha ? "ese día" : `el ${r.fecha}`;
      return {
        ok: false,
        motivo: `Ya hay una reserva de ${r.horaInicio} a ${r.horaFin} ${cuando}.`,
      };
    }
  }

  return { ok: true };
}

/** Zonas comunes activas del condominio (para el menú del bot). */
export const zonasActivas = internalQuery({
  args: { condominioId: v.id("condominios") },
  handler: async (ctx, args) => {
    const zonas = await ctx.db
      .query("zonasComunes")
      .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
      .collect();
    return zonas.filter((z) => z.activa);
  },
});

/** ¿Está libre la zona en esa fecha y franja? Devuelve { ok, motivo? }. */
export const verificarDisponibilidad = internalQuery({
  args: {
    zonaId: v.id("zonasComunes"),
    fecha: v.string(),
    horaInicio: v.string(),
    horaFin: v.string(),
  },
  handler: async (ctx, args) => {
    const zona = await ctx.db.get(args.zonaId);
    if (!zona || !zona.activa) {
      return { ok: false, motivo: "La zona no está disponible." };
    }
    return await checkDisponibilidadZona(
      ctx,
      zona,
      args.fecha,
      args.horaInicio,
      args.horaFin,
    );
  },
});

/**
 * Crea una reserva EN NOMBRE de un propietario identificado por el bot
 * (mismas validaciones que createMia, pero con el usuario explícito).
 * Los mensajes de error se muestran tal cual en WhatsApp.
 */
export const createFromBot = internalMutation({
  args: {
    userId: v.id("users"),
    condominioId: v.id("condominios"),
    unidadId: v.id("unidades"),
    zonaId: v.id("zonasComunes"),
    fecha: v.string(),
    horaInicio: v.string(),
    horaFin: v.string(),
    observaciones: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user || !user.active) {
      throw new Error("Tu cuenta no está activa. Contacta a la administración.");
    }

    const membership = await getMembership(ctx, args.userId, args.condominioId);
    if (!membership || !membership.isActive) {
      throw new Error("No tienes una cuenta activa en este conjunto.");
    }

    // La unidad debe estar vinculada a la membresía del usuario, y el vínculo
    // vigente (`misUnidadIds`, como `createMia`; QA de comprobantes, H3).
    const unidadIds = await misUnidadIds(ctx, args.userId, args.condominioId);
    if (!unidadIds.has(args.unidadId)) {
      throw new Error("Esa unidad no está vinculada a tu cuenta.");
    }
    const unidad = await ctx.db.get(args.unidadId);
    if (!unidad) throw new Error("Unidad no encontrada.");

    const zona = await ctx.db.get(args.zonaId);
    if (!zona || zona.condominioId !== args.condominioId) {
      throw new Error("Zona no encontrada.");
    }
    if (!zona.activa) throw new Error("Esa zona no está disponible.");

    if (!/^\d{4}-\d{2}-\d{2}$/.test(args.fecha)) {
      throw new Error("La fecha no es válida.");
    }
    // La validación de horas la hace checkDisponibilidadZona, que sí entiende
    // los cierres pasada la medianoche.
    const disponible = await checkDisponibilidadZona(
      ctx,
      zona,
      args.fecha,
      args.horaInicio,
      args.horaFin,
    );
    if (!disponible.ok) {
      throw new Error(disponible.motivo ?? "Ese horario no está disponible.");
    }

    const now = Date.now();
    const reservaId = await ctx.db.insert("reservas", {
      condominioId: args.condominioId,
      unidadId: args.unidadId,
      zonaId: args.zonaId,
      zonaNombre: zona.nombre,
      unidadNumero: unidad.numero,
      solicitanteNombre: user.name,
      fecha: args.fecha,
      horaInicio: args.horaInicio,
      horaFin: args.horaFin,
      estado: "pendiente",
      observaciones: args.observaciones?.trim(),
      ...valoresPactados(zona, args.horaInicio, args.horaFin),
      createdAt: now,
      updatedAt: now,
    });
    return { reservaId, estado: "pendiente" as const };
  },
});


/**
 * Carga varios espacios comunes de una vez, desde la terminal.
 *
 * La administracion manda la lista por WhatsApp —"salon social, 80 personas,
 * 150 mil el dia, viernes y sabado hasta las 2 a. m."— y meterlos uno por uno
 * por la interfaz son veinte minutos de formulario y una errata garantizada
 * en los horarios.
 *
 * Los horarios se escriben por GRUPO de dias, que es como los dicta la gente:
 * "lunes a jueves hasta las 10, viernes y sabado hasta las 2". Aqui se
 * expanden a un registro por dia, que es como los guarda el sistema.
 *
 * Es idempotente por nombre: volver a correrla no duplica lo ya cargado, solo
 * agrega lo que falte. Asi se puede ir completando la lista a medida que la
 * administracion la va mandando.
 */
export const crearZonasEnLote = internalMutation({
  args: {
    condominioId: v.id("condominios"),
    zonas: v.array(
      v.object({
        nombre: v.string(),
        tipo: v.optional(tipoZonaValidator),
        unidadTiempo: v.optional(unidadTiempoValidator),
        capacidad: v.optional(v.number()),
        descripcion: v.optional(v.string()),
        precioPorHora: v.optional(v.number()),
        precioPorDia: v.optional(v.number()),
        precioPorMes: v.optional(v.number()),
        requiereAprobacion: v.optional(v.boolean()),
        depositoRequerido: v.optional(v.number()),
        /** 0=domingo … 6=sabado. "09:00" a "02:00" cierra al dia siguiente. */
        horarios: v.optional(
          v.array(
            v.object({
              dias: v.array(v.number()),
              horaInicio: v.string(),
              horaFin: v.string(),
            }),
          ),
        ),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const condominio = await ctx.db.get(args.condominioId);
    if (!condominio) throw new Error("Condominio no encontrado.");

    const existentes = await ctx.db
      .query("zonasComunes")
      .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
      .collect();
    const yaEstan = new Set(
      existentes.map((z) => z.nombre.trim().toLowerCase()),
    );

    const creadas: string[] = [];
    const omitidas: string[] = [];

    for (const z of args.zonas) {
      const nombre = z.nombre.trim();
      if (!nombre) continue;
      if (yaEstan.has(nombre.toLowerCase())) {
        omitidas.push(nombre);
        continue;
      }

      const horariosPorDia = (z.horarios ?? []).flatMap((h) =>
        h.dias.map((dia) => ({
          dia,
          horaInicio: h.horaInicio,
          horaFin: h.horaFin,
        })),
      );
      /* Se valida ANTES de insertar nada: media lista cargada y media no es
       * peor que ninguna, porque no se ve cual falto. */
      if (horariosPorDia.length > 0) assertHorarios(horariosPorDia);

      const ahora = Date.now();
      await ctx.db.insert("zonasComunes", {
        condominioId: args.condominioId,
        nombre,
        tipo: z.tipo ?? "otro",
        unidadTiempo: z.unidadTiempo ?? "dia",
        capacidad: z.capacidad ?? 1,
        descripcion: z.descripcion?.trim() || undefined,
        precioPorHora: z.precioPorHora,
        precioPorDia: z.precioPorDia,
        precioPorMes: z.precioPorMes,
        horariosPorDia: horariosPorDia.length ? horariosPorDia : undefined,
        requiereAprobacion: z.requiereAprobacion ?? true,
        depositoRequerido: z.depositoRequerido,
        activa: true,
        createdAt: ahora,
        updatedAt: ahora,
      });
      yaEstan.add(nombre.toLowerCase());
      creadas.push(nombre);
    }

    return { condominio: condominio.name, creadas, omitidas };
  },
});
