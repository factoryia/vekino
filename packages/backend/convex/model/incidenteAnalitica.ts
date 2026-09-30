import type { QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { exigirAlcanceBandeja, obtenerContextoBandeja } from "./incidenteAcceso";
import { consultarIncidentes, coincideFiltrosIncidente, type FiltrosIncidentes } from "./incidenteConsulta";
import { ESTADOS_INCIDENTE, incidenteActivo } from "../lib/incidentes";
import { ANTIGUEDAD_ACTIVA_DIAS, DIA, MAX_INCIDENTES_ANALITICA, MAX_BYTES_ANALITICA, intervalosIncidentes, periodoIncidentes } from "../lib/incidenteMetricas";

export async function obtenerAnaliticaIncidentes(ctx: QueryCtx, args: {
  periodo: string; desde?: string; hasta?: string; condominioId?: Id<"condominios">;
  estado?: Doc<"incidentes">["estado"]; activos?: boolean; prioridad?: Doc<"incidentes">["prioridad"]; tipo?: string;
}) {
  const contexto = await obtenerContextoBandeja(ctx, false);
  if (!contexto || (!contexto.todosLosConjuntos && !contexto.conjuntos.length)) return null;
  const ahora = Date.now();
  const periodo = periodoIncidentes(args.periodo, args.desde, args.hasta, ahora);
  const filtros: FiltrosIncidentes = { companiaId: contexto.companiaId, fecha: "reportadoEn", ...periodo,
    estado: args.estado, activos: args.activos, prioridad: args.prioridad, tipo: args.tipo };
  // El admin conserva la lectura histórica de TODA su compañía, como listar.
  // Cada ámbito del personal se autoriza por separado, incluyendo reportante guarda.
  const ambitos = args.condominioId ? [args.condominioId] : contexto.todosLosConjuntos
    ? [undefined] : contexto.conjuntos.map((c) => c.condominioId);
  const estados = Object.fromEntries(ESTADOS_INCIDENTE.map((estado) => [estado, 0])) as Record<Doc<"incidentes">["estado"], number>;
  const prioridades = { BAJA: 0, MEDIA: 0, ALTA: 0, CRITICA: 0 };
  const tipos = new Map<string, number>();
  const conjuntos = new Map<Id<"condominios">, number>();
  const evolucion = intervalosIncidentes(periodo.desde, periodo.hasta);
  const relevantes: Doc<"incidentes">[] = [];
  let total = 0, activos = 0, antiguos = 0, sumaResolucion = 0, muestraResolucion = 0, sinFechaResolucion = 0;
  let leidos = 0;
  let bytesRestantes = MAX_BYTES_ANALITICA;
  for (const condominioId of ambitos) {
    const alcance = await exigirAlcanceBandeja(ctx, { companiaId: contexto.companiaId, condominioId });
    // Iteración por índice sin paginaciones múltiples ni conteos parciales.
    const alcanceFiltros = { ...filtros, condominioId };
    for await (const c of consultarIncidentes(ctx, alcanceFiltros, alcance.reportante, undefined, false)) {
      if (++leidos > MAX_INCIDENTES_ANALITICA) {
        throw new Error("LIMITE_ANALITICA: Reduce el periodo o selecciona un conjunto. No se muestran totales parciales.");
      }
      bytesRestantes -= new TextEncoder().encode(JSON.stringify(c)).byteLength;
      if (bytesRestantes <= 0) throw new Error("LIMITE_ANALITICA: Reduce el periodo o selecciona un conjunto.");
      if (!coincideFiltrosIncidente(c, alcanceFiltros)) continue;
      total++; estados[c.estado]++; prioridades[c.prioridad]++;
      tipos.set(c.tipo, (tipos.get(c.tipo) ?? 0) + 1);
      conjuntos.set(c.condominioId, (conjuntos.get(c.condominioId) ?? 0) + 1);
      const punto = evolucion.puntos.find((p) => c.reportadoEn >= p.desde && c.reportadoEn <= p.hasta);
      if (punto) punto.value++;
      if (incidenteActivo(c.estado)) {
        activos++;
        if (ahora - c.reportadoEn >= ANTIGUEDAD_ACTIVA_DIAS * DIA) antiguos++;
        relevantes.push(c);
        // Prioridad existente, después reporte más antiguo; selección limitada en backend.
        relevantes.sort((a, b) => prioridadesOrden(a.prioridad) - prioridadesOrden(b.prioridad) || a.reportadoEn - b.reportadoEn || a._id.localeCompare(b._id));
        relevantes.splice(5);
      }
      if (c.estado === "RESUELTO" || c.estado === "CERRADO") {
        if (c.resueltoEn !== undefined && Number.isFinite(c.resueltoEn) && c.resueltoEn >= c.reportadoEn) {
          sumaResolucion += c.resueltoEn - c.reportadoEn; muestraResolucion++;
        } else sinFechaResolucion++;
      }
    }
  }
  const nombres = new Map(await Promise.all([...conjuntos.keys()].map(async (id) => [id, (await ctx.db.get(id))?.name ?? "(conjunto no disponible)"] as const)));
  return { periodo, total, activos, antiguos, antiguedadDias: ANTIGUEDAD_ACTIVA_DIAS, estados, prioridades,
    tipos: [...tipos].map(([tipo, cantidad]) => ({ tipo, cantidad })).sort((a, b) => b.cantidad - a.cantidad || a.tipo.localeCompare(b.tipo)),
    conjuntos: [...conjuntos].map(([condominioId, cantidad]) => ({ condominioId, nombre: nombres.get(condominioId)!, cantidad })).sort((a, b) => b.cantidad - a.cantidad || a.nombre.localeCompare(b.nombre)),
    evolucion, resolucion: { promedioMs: muestraResolucion ? sumaResolucion / muestraResolucion : null, muestra: muestraResolucion, sinFecha: sinFechaResolucion },
    relevantes: relevantes.map((c) => ({ _id: c._id, condominioId: c.condominioId, conjunto: nombres.get(c.condominioId)!, tipo: c.tipo, estado: c.estado,
      prioridad: c.prioridad, reportadoEn: c.reportadoEn, responsableNombre: c.responsableNombre })),
  };
}
function prioridadesOrden(prioridad: Doc<"incidentes">["prioridad"]) {
  return ["CRITICA", "ALTA", "MEDIA", "BAJA"].indexOf(prioridad);
}
