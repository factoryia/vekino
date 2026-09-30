import type { OrderedQuery, IndexRangeBuilder, IndexRange } from "convex/server";
import type { QueryCtx } from "../_generated/server";
import type { Doc, Id, DataModel } from "../_generated/dataModel";
import { ESTADOS_ACTIVOS } from "../lib/incidentes";
import { incidenteActivo } from "../lib/incidentes";

export type FiltrosIncidentes = {
  companiaId: Id<"companiasSeguridad">; condominioId?: Id<"condominios">;
  estado?: Doc<"incidentes">["estado"]; prioridad?: Doc<"incidentes">["prioridad"];
  tipo?: string; activos?: boolean; busqueda?: string;
  campoBusqueda?: "ubicacion" | "descripcion" | "referencia";
  fecha?: "reportadoEn" | "ocurrioEn"; desde?: number; hasta?: number; orden?: "asc" | "desc";
};
/** Coincidencia compartida para referencia exacta y agregación incremental. */
export function coincideFiltrosIncidente(c: Doc<"incidentes">, args: FiltrosIncidentes) {
  const fecha = args.fecha ?? "reportadoEn";
  return c.companiaId === args.companiaId && (!args.condominioId || c.condominioId === args.condominioId)
    && (!args.estado || c.estado === args.estado) && (!args.prioridad || c.prioridad === args.prioridad)
    && (!args.tipo || c.tipo === args.tipo) && (!args.activos || !!args.estado || incidenteActivo(c.estado))
    && (args.desde === undefined || c[fecha] >= args.desde) && (args.hasta === undefined || c[fecha] <= args.hasta);
}
export function consultarIncidentes(ctx: QueryCtx, args: FiltrosIncidentes, reportante?: Id<"users">,
  ambitos?: { condominioId: Id<"condominios">; reportante?: Id<"users"> }[], filtrar = true) {
    const fecha = args.fecha ?? "reportadoEn";
    const busqueda = args.busqueda?.trim();
    let consulta: OrderedQuery<DataModel["incidentes"]>;
    if (busqueda) {
      const campo = args.campoBusqueda === "descripcion" ? "descripcion" : "ubicacion";
      consulta = ctx.db.query("incidentes").withSearchIndex(campo === "descripcion" ? "buscar_descripcion" : "buscar_ubicacion", (q) => {
        let filtro = q.search(campo, busqueda).eq("companiaId", args.companiaId);
        if (args.condominioId) filtro = filtro.eq("condominioId", args.condominioId);
        if (reportante) filtro = filtro.eq("reportadoPorUserId", reportante);
        if (args.estado) filtro = filtro.eq("estado", args.estado);
        if (args.prioridad) filtro = filtro.eq("prioridad", args.prioridad);
        if (args.tipo) filtro = filtro.eq("tipo", args.tipo);
        return filtro;
      });
    } else {
      // El rango se aplica al índice de la fecha elegida; nunca se ordena una descarga en cliente.
      const rangoReporte = (q: IndexRange & Omit<IndexRangeBuilder<Doc<"incidentes">, ["reportadoEn"]>, "eq">) => {
        if (args.desde !== undefined && args.hasta !== undefined) return q.gte("reportadoEn", args.desde).lte("reportadoEn", args.hasta);
        if (args.desde !== undefined) return q.gte("reportadoEn", args.desde);
        if (args.hasta !== undefined) return q.lte("reportadoEn", args.hasta);
        return q;
      };
      const rangoHecho = (q: IndexRange & Omit<IndexRangeBuilder<Doc<"incidentes">, ["ocurrioEn"]>, "eq">) => {
        if (args.desde !== undefined && args.hasta !== undefined) return q.gte("ocurrioEn", args.desde).lte("ocurrioEn", args.hasta);
        if (args.desde !== undefined) return q.gte("ocurrioEn", args.desde);
        if (args.hasta !== undefined) return q.lte("ocurrioEn", args.hasta);
        return q;
      };
      // Las ramas explícitas conservan el tipado de los prefijos del índice.
      if (fecha === "ocurrioEn") {
        if (reportante) consulta = ctx.db.query("incidentes").withIndex("by_compania_condominio_reportante_ocurrio", (q) => rangoHecho(q.eq("companiaId", args.companiaId).eq("condominioId", args.condominioId!).eq("reportadoPorUserId", reportante))).order(args.orden ?? "desc");
        else if (args.condominioId) consulta = ctx.db.query("incidentes").withIndex("by_compania_condominio_ocurrio", (q) => rangoHecho(q.eq("companiaId", args.companiaId).eq("condominioId", args.condominioId!))).order(args.orden ?? "desc");
        else consulta = ctx.db.query("incidentes").withIndex("by_compania_ocurrio", (q) => rangoHecho(q.eq("companiaId", args.companiaId))).order(args.orden ?? "desc");
      } else {
        if (reportante) consulta = ctx.db.query("incidentes").withIndex("by_compania_condominio_reportante", (q) => rangoReporte(q.eq("companiaId", args.companiaId).eq("condominioId", args.condominioId!).eq("reportadoPorUserId", reportante))).order(args.orden ?? "desc");
        else if (args.condominioId && args.estado) consulta = ctx.db.query("incidentes").withIndex("by_compania_condominio_estado_reportado", (q) => rangoReporte(q.eq("companiaId", args.companiaId).eq("condominioId", args.condominioId!).eq("estado", args.estado!))).order(args.orden ?? "desc");
        else if (args.condominioId) consulta = ctx.db.query("incidentes").withIndex("by_compania_condominio_reportado", (q) => rangoReporte(q.eq("companiaId", args.companiaId).eq("condominioId", args.condominioId!))).order(args.orden ?? "desc");
        else if (args.estado) consulta = ctx.db.query("incidentes").withIndex("by_compania_estado_reportado", (q) => rangoReporte(q.eq("companiaId", args.companiaId).eq("estado", args.estado!))).order(args.orden ?? "desc");
        else consulta = ctx.db.query("incidentes").withIndex("by_compania_reportado", (q) => rangoReporte(q.eq("companiaId", args.companiaId))).order(args.orden ?? "desc");
      }
    }
    // Filtros compartidos antes de paginar o agregar.
    if (ambitos) consulta = consulta.filter((q) => q.or(...ambitos.map((a) => a.reportante
      ? q.and(q.eq(q.field("condominioId"), a.condominioId), q.eq(q.field("reportadoPorUserId"), a.reportante))
      : q.eq(q.field("condominioId"), a.condominioId))));
    if (!filtrar) return consulta;
    if (args.estado) consulta = consulta.filter((q) => q.eq(q.field("estado"), args.estado!));
    else if (args.activos) consulta = consulta.filter((q) => q.or(...ESTADOS_ACTIVOS.map((estado) => q.eq(q.field("estado"), estado))));
    if (args.prioridad) consulta = consulta.filter((q) => q.eq(q.field("prioridad"), args.prioridad!));
    if (args.tipo) consulta = consulta.filter((q) => q.eq(q.field("tipo"), args.tipo!));
    if (busqueda && args.desde !== undefined) consulta = consulta.filter((q) => q.gte(q.field(fecha), args.desde!));
    if (busqueda && args.hasta !== undefined) consulta = consulta.filter((q) => q.lte(q.field(fecha), args.hasta!));
    return consulta;
}
