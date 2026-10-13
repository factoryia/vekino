import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import {
  getCurrentAppUser,
  requireAppUser,
  getMembership,
  misUnidadIds,
} from "./model/authz";
import {
  ETIQUETA_SIN_VERIFICAR,
  TEXTO_SIN_VERIFICAR,
  carteraDeUnidad,
  estadoVisibleDeFactura,
  montoAPagarHoy,
  motivoNoPagable,
  sinPagar,
  type CarteraUnidad,
  type MotivoNoPagable,
} from "./lib/cartera";

/**
 * Bandeja de novedades del residente.
 *
 * El feed se DERIVA de lo que ya existe (facturas, comunicados, documentos,
 * visitantes, paquetes, novedades, asambleas) en vez de escribirse en una tabla aparte. Así no hay
 * que instrumentar cada mutation y la bandeja funciona con el histórico que ya
 * está cargado. El costo es leer varias tablas por consulta, acotado con
 * `take` por fuente y una ventana de tiempo.
 *
 * Lo "no leído" se calcula contra `users.notificacionesVistasAt`.
 */

/** Cuánto historial mira la bandeja. */
const VENTANA_DIAS = 45;
/** Máximo por fuente antes de mezclar (evita que una fuente ahogue al resto). */
const POR_FUENTE = 15;
/** Máximo que devuelve la bandeja ya mezclada. */
const TOTAL = 40;

type Item = {
  id: string;
  tipo:
    | "factura"
    | "comunicado"
    | "documento"
    | "visitante"
    | "asamblea"
    | "paquete"
    | "novedad";
  titulo: string;
  detalle: string | null;
  createdAt: number;
  /** Ruta de la app a la que lleva el toque. */
  ruta: string;
};

export const feed = query({
  args: { condominioId: v.id("condominios") },
  handler: async (ctx, args) => {
    const user = await getCurrentAppUser(ctx);
    if (!user) return { items: [], sinLeer: 0, vistasAt: 0 };

    const membership = await getMembership(ctx, user._id, args.condominioId);
    if (!membership || !membership.isActive) {
      return { items: [], sinLeer: 0, vistasAt: 0 };
    }

    const desde = Date.now() - VENTANA_DIAS * 24 * 60 * 60 * 1000;
    const unidadIds = await misUnidadIds(ctx, user._id, args.condominioId);
    const items: Item[] = [];

    // ── Facturas de SUS unidades ────────────────────────────────
    if (unidadIds.size > 0) {
      /* "Por pagar" solo lo que se puede pagar: la vigente de cada unidad
       * (`lib/cartera.ts`). Antes toda factura no pagada decía "Por pagar",
       * también las viejas cuyo saldo ya iba dentro de la siguiente: la
       * campana pedía pagar dos veces lo mismo. */
      const cadenas = new Map<string, Doc<"facturas">[]>();
      /* La cartera de hoy de cada unidad: dice si la vigente está en mora. */
      const carteras = new Map<string, CarteraUnidad>();
      const ahora = Date.now();
      for (const unidadId of unidadIds) {
        const cadena = (
          await ctx.db
            .query("facturas")
            .withIndex("by_unidad", (q) => q.eq("unidadId", unidadId))
            .collect()
        ).filter((f) => f.condominioId === args.condominioId);
        cadenas.set(unidadId, cadena);
        carteras.set(unidadId, carteraDeUnidad(cadena, ahora));
      }
      const facturas = await ctx.db
        .query("facturas")
        .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
        .order("desc")
        .take(120);
      for (const f of facturas) {
        if (!unidadIds.has(f.unidadId) || f.createdAt < desde) continue;
        if (items.filter((i) => i.tipo === "factura").length >= POR_FUENTE) break;
        const cadena = cadenas.get(f.unidadId) ?? [f];
        items.push({
          id: f._id,
          tipo: "factura",
          titulo: `Factura de ${f.periodoLabel}`,
          detalle: detalleFactura(f, cadena, motivoNoPagable(cadena, f), carteras.get(f.unidadId)),
          createdAt: f.createdAt,
          ruta: "/(app)/(tabs)/facturas",
        });
      }
    }

    // ── Comunicados del condominio ──────────────────────────────
    const comunicados = await ctx.db
      .query("comunicados")
      .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
      .order("desc")
      .take(POR_FUENTE);
    for (const c of comunicados) {
      if (c.createdAt < desde) continue;
      items.push({
        id: c._id,
        tipo: "comunicado",
        titulo: c.titulo,
        detalle: c.prioridad === "normal" ? "Nuevo aviso" : etiquetaPrioridad(c.prioridad),
        createdAt: c.createdAt,
        ruta: "/(app)/(tabs)/comunicados",
      });
    }

    // ── Documentos publicados ───────────────────────────────────
    const documentos = await ctx.db
      .query("documentos")
      .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
      .order("desc")
      .take(POR_FUENTE);
    for (const d of documentos) {
      if (d.createdAt < desde) continue;
      items.push({
        id: d._id,
        tipo: "documento",
        titulo: d.nombre,
        detalle: "Documento nuevo",
        createdAt: d.createdAt,
        ruta: "/(app)/documentos",
      });
    }

    // ── Visitantes autorizados para SUS unidades ────────────────
    if (unidadIds.size > 0) {
      const visitantes = await ctx.db
        .query("visitantes")
        .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
        .order("desc")
        .take(120);
      for (const vis of visitantes) {
        if (!unidadIds.has(vis.unidadId) || vis.createdAt < desde) continue;
        if (items.filter((i) => i.tipo === "visitante").length >= POR_FUENTE) break;
        items.push({
          id: vis._id,
          tipo: "visitante",
          titulo: vis.nombre,
          detalle:
            vis.fechaIngreso != null
              ? "Ingresó al conjunto"
              : "Visitante autorizado",
          createdAt: vis.fechaIngreso ?? vis.createdAt,
          ruta: "/(app)/visitantes",
        });
      }
    }

    // ── Paquetes que llegaron a SUS unidades ────────────────────
    //
    // La portería registra el paquete y el residente se entera aquí. Antes
    // no aparecía en ningún lado: el paquete quedaba en la lista del guarda
    // y el dueño solo se enteraba si bajaba a preguntar.
    if (unidadIds.size > 0) {
      const paquetes = await ctx.db
        .query("paquetes")
        .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
        .order("desc")
        .take(120);
      /* Los paquetes viejos no tienen `unidadId`: se guardaba solo el
       * numero como texto. Para esos se compara por numero, que es lo unico
       * que hay. Los nuevos ya vienen vinculados. */
      const misNumeros = new Set(
        (await Promise.all([...unidadIds].map((id) => ctx.db.get(id))))
          .filter(Boolean)
          .map((u) => u!.numero.trim().toLowerCase().replace(/\s+/g, "")),
      );
      for (const p of paquetes) {
        const mio = p.unidadId
          ? unidadIds.has(p.unidadId)
          : misNumeros.has(p.unidadNumero.trim().toLowerCase().replace(/\s+/g, ""));
        if (!mio || p.fechaRecibido < desde) continue;
        if (items.filter((i) => i.tipo === "paquete").length >= POR_FUENTE) break;
        const entregado = p.estado === "entregado";
        items.push({
          id: p._id,
          tipo: "paquete",
          titulo: entregado ? "Paquete entregado" : "Tienes un paquete",
          detalle: [p.remitente, p.descripcion].filter(Boolean).join(" · ") || null,
          createdAt: p.fechaEntregado ?? p.fechaRecibido,
          ruta: "/(app)/paqueteria",
        });
      }
    }

    // ── Novedades que tocan a SUS unidades ──────────────────────
    //
    // Solo las que señalan la casa. Una novedad de portería o de una zona
    // común no es asunto de nadie en particular y llenaría la bandeja de
    // todo el conjunto con cosas que no le competen.
    if (unidadIds.size > 0) {
      const novedades = await ctx.db
        .query("guardiaNovedadReportes")
        .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
        .order("desc")
        .take(120);
      for (const n of novedades) {
        if (n.createdAt < desde) continue;
        const suyas = (
          n.unidades ?? (n.unidadId ? [{ unidadId: n.unidadId }] : [])
        ).some((u) => unidadIds.has(u.unidadId));
        if (!suyas) continue;
        if (items.filter((i) => i.tipo === "novedad").length >= POR_FUENTE) break;
        items.push({
          id: n._id,
          tipo: "novedad",
          titulo: n.titulo,
          detalle: n.vehiculoPlaca
            ? `Vehículo ${n.vehiculoPlaca}`
            : "Novedad reportada por portería",
          // La hora del hecho, no la del registro: es la que le importa a
          // quien la recibe.
          createdAt: n.ocurrioEn ?? n.createdAt,
          ruta: "/(app)/novedades",
        });
      }
    }

    // ── Asambleas convocadas ────────────────────────────────────
    const asambleas = await ctx.db
      .query("asambleas")
      .withIndex("by_condominio", (q) => q.eq("condominioId", args.condominioId))
      .order("desc")
      .take(POR_FUENTE);
    for (const a of asambleas) {
      if (a.createdAt < desde) continue;
      items.push({
        id: a._id,
        tipo: "asamblea",
        titulo: a.titulo,
        detalle: `Asamblea · ${a.fecha}`,
        createdAt: a.createdAt,
        ruta: "/(app)/asambleas",
      });
    }

    items.sort((a, b) => b.createdAt - a.createdAt);
    const recortado = items.slice(0, TOTAL);
    const vistasAt = user.notificacionesVistasAt ?? 0;

    return {
      items: recortado,
      sinLeer: recortado.filter((i) => i.createdAt > vistasAt).length,
      vistasAt,
    };
  },
});

/** Marca la bandeja como vista (apaga el punto de la campana). */
export const marcarVistas = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireAppUser(ctx);
    await ctx.db.patch(user._id, { notificacionesVistasAt: Date.now() });
  },
});

function etiquetaPrioridad(p: string): string {
  return p === "urgente" ? "Urgente" : "Importante";
}

function formatoCOP(valor: number): string {
  // Sin Intl: el runtime de Convex no garantiza los locales completos.
  const entero = Math.round(valor).toString();
  const conPuntos = entero.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `$ ${conPuntos}`;
}

/**
 * La línea de una factura en la campana, según si hoy se puede pagar. El
 * monto "por pagar" es el de hoy: con descuento solo dentro de su plazo y sin
 * lo ya abonado (`montoAPagarHoy`). Si la unidad está en mora, la vigente se
 * anuncia "Vencida", como la ven la cartera, la web y Finanzas
 * (`estadoVisibleDeFactura`; QA de comprobantes, H2).
 */
function detalleFactura(
  f: Doc<"facturas">,
  cadena: readonly Doc<"facturas">[],
  motivo: MotivoNoPagable | null,
  cartera?: CarteraUnidad,
): string {
  if (motivo === null) {
    const monto = formatoCOP(montoAPagarHoy(f, Date.now()));
    return estadoVisibleDeFactura(f, cadena, cartera) === "vencida"
      ? `Vencida · Por pagar ${monto}`
      : `Por pagar · ${monto}`;
  }
  if (motivo === "pagada") return "Pagada";
  /* Una historica que nadie pudo juzgar (Fase 4): no se sabe si se pago. */
  if (motivo === "historica" && estadoVisibleDeFactura(f, cadena) === "sin_verificar") {
    return `${ETIQUETA_SIN_VERIFICAR} · ${TEXTO_SIN_VERIFICAR}`;
  }
  if (motivo === "historica" && sinPagar(f.estado)) {
    return "Su saldo pasó a la factura siguiente";
  }
  if (motivo === "pago_en_verificacion") {
    /* Pagó y la contabilidad aún no lo refleja: no es deuda que cobrar. */
    return `Pago en verificación · ${formatoCOP(f.pagoEnVerificacion?.monto ?? 0)}`;
  }
  if (motivo === "vigente_ambigua" || motivo === "en_revision") {
    return "En revisión de la administración";
  }
  return "Sin saldo por pagar";
}
