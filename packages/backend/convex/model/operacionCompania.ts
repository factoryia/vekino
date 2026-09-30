import type { QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { exigirAccesoCompania, getCompaniaMiembro, exigirAcceso } from "./acceso";
import { requireAppUser } from "./authz";
import { displayNameFromUser } from "./displayName";
import { acotado, estaVigente, finDe } from "../lib/vigilancia";
import { DIA, diaColombia, limiteDiaColombia, periodoIncidentes } from "../lib/incidenteMetricas";
import { estadoDeRonda, duracionMs } from "../lib/ronda";
import { esAporteVoluntario } from "../lib/reporteGuardia";

export type FiltrosOperacion = {
  desde: string; hasta: string; condominioId?: Id<"condominios">;
  guardiaUserId?: Id<"users">; granularidad: "dia" | "semana" | "mes";
};
function contadores() {
  return { turnos: 0, inicios: 0, cerrados: 0, rondas: 0, rondasEnCurso: 0, minuta: 0, novedades: 0, aportes: 0 };
}

/** Agregación de las fuentes operativas. No persiste contadores ni expone documentos. */
export async function obtenerOperacionCompania(ctx: QueryCtx, args: FiltrosOperacion) {
  const user = await requireAppUser(ctx);
  const miembro = await getCompaniaMiembro(ctx, user._id);
  if (!miembro?.roles.includes("admin_compania")) throw new Error("Requiere administrador de compañía.");
  const { compania } = await exigirAccesoCompania(ctx, miembro.companiaId, "seguridad.personal");
  const periodo = periodoIncidentes("personalizado", args.desde, args.hasta);
  if (periodo.hasta - periodo.desde >= 366 * DIA) throw new Error("Selecciona un periodo de hasta 366 días.");
  const contratos = await ctx.db.query("companiaContratos").withIndex("by_compania", q => q.eq("companiaId", compania._id)).collect();
  const ids = [...new Set(contratos.filter(c => estaVigente(c)).map(c => c.condominioId))];
  const conjuntos = (await Promise.all(ids.map(async id => ({ id, nombre: (await ctx.db.get(id))?.name ?? "Conjunto no disponible" })))).sort((a, b) => a.nombre.localeCompare(b.nombre));
  if (args.condominioId && !ids.includes(args.condominioId)) throw new Error("El conjunto no está en el ámbito autorizado.");
  const seleccionados = args.condominioId ? [args.condominioId] : ids;
  // La lectura histórica de portería sigue exigiendo un contrato vigente HOY.
  for (const id of seleccionados) await exigirAcceso(ctx, id, "porteria.ver");
  const asignaciones = await ctx.db.query("asignaciones").withIndex("by_compania", q => q.eq("companiaId", compania._id)).collect();
  const porContrato = new Map(contratos.map(c => [c._id, c]));
  const ambitos = asignaciones.filter(a => a.rol === "guardia" && seleccionados.includes(a.condominioId)).flatMap(a => {
    const c = porContrato.get(a.contratoId);
    if (!c) return [];
    const rango = acotado(a, c);
    return rango.vigenciaDesde <= periodo.hasta && finDe(rango) > periodo.desde ? [{ ...a, rango }] : [];
  });
  const guardas = await Promise.all([...new Set(ambitos.map(a => a.userId))].map(async id => {
    const perfil = await ctx.db.get(id);
    return { id, nombre: perfil ? displayNameFromUser(perfil) : "Perfil no disponible" };
  }));
  guardas.sort((a, b) => a.nombre.localeCompare(b.nombre));
  if (args.guardiaUserId && !guardas.some(g => g.id === args.guardiaUserId)) throw new Error("El guarda no está asignado en este ámbito y periodo.");
  const pertenece = (id: Id<"users">, condo: Id<"condominios">, fecha: number) => ambitos.some(a => a.userId === id && a.condominioId === condo && estaVigente(a.rango, fecha));
  const cubierto = (condo: Id<"condominios">, fecha: number) => contratos.some(c => c.condominioId === condo && estaVigente(c, fecha));
  const total = contadores();
  const porConjunto = new Map(seleccionados.map(id => [id, { id, nombre: conjuntos.find(c => c.id === id)!.nombre, ...contadores() }]));
  const porGuarda = new Map(guardas.filter(g => !args.guardiaUserId || g.id === args.guardiaUserId).map(g => [g.id, { ...g, ...contadores() }]));
  const evolucion: ({ desde: number; hasta: number; label: string } & ReturnType<typeof contadores>)[] = [];
  for (let inicio = periodo.desde; inicio <= periodo.hasta;) {
    let fin = inicio + (args.granularidad === "semana" ? 7 : 1) * DIA - 1;
    if (args.granularidad === "mes") {
      const siguiente = new Date(`${diaColombia(inicio).slice(0, 7)}-01T00:00:00Z`);
      siguiente.setUTCMonth(siguiente.getUTCMonth() + 1);
      fin = limiteDiaColombia(siguiente.toISOString().slice(0, 10)) - 1;
    }
    fin = Math.min(fin, periodo.hasta);
    evolucion.push({ desde: inicio, hasta: fin, label: diaColombia(inicio), ...contadores() }); inicio = fin + 1;
  }
  type Metrica = keyof ReturnType<typeof contadores>;
  const sumar = (campo: Metrica, condo: Id<"condominios">, fecha: number, autores: Id<"users">[] = []) => {
    total[campo]++; porConjunto.get(condo)![campo]++;
    const punto = evolucion.find(p => fecha >= p.desde && fecha <= p.hasta);
    if (punto) punto[campo]++;
    for (const id of new Set(autores)) { const fila = porGuarda.get(id); if (fila) fila[campo]++; }
  };
  const modulos = new Map<string, number>(), tipos = new Map<string, number>();
  const prioridades = { baja: 0, media: 0, alta: 0 };
  let sinAutorRondas = 0, sinAutorMinuta = 0, sumaDuracion = 0, muestraDuracion = 0, leidos = 0, bytes = 0;
  const controlar = (doc: unknown) => {
    bytes += new TextEncoder().encode(JSON.stringify(doc)).byteLength;
    if (++leidos > 6000 || bytes > 6_000_000) throw new Error("Reduce el periodo o selecciona un conjunto: se alcanzó el límite de consulta. No se muestran totales parciales.");
  };
  const aceptarActor = (id: Id<"users"> | undefined, condo: Id<"condominios">, fecha: number) =>
    cubierto(condo, fecha) && (id ? pertenece(id, condo, fecha) && (!args.guardiaUserId || args.guardiaUserId === id) : !args.guardiaUserId);
  const activos: { id: Id<"guardiaTurnos">; condominioId: Id<"condominios">; conjunto: string; guardas: string; desde: number }[] = [];
  for (const condo of seleccionados) {
    for await (const t of ctx.db.query("guardiaTurnos").withIndex("by_condominio_fecha", q => q.eq("condominioId", condo).gte("fechaInicio", periodo.desde).lte("fechaInicio", periodo.hasta))) {
      controlar(t);
      const autores = [t.guardiaUserId, t.guardiaSecundarioUserId].filter((id): id is Id<"users"> => !!id && pertenece(id, condo, t.fechaInicio));
      if (!autores.length || (args.guardiaUserId && !autores.includes(args.guardiaUserId))) continue;
      sumar("turnos", condo, t.fechaInicio, autores);
      // El titular abrió el turno; el secundario participa, pero no se inventa otra apertura.
      if (autores.includes(t.guardiaUserId) && (!args.guardiaUserId || args.guardiaUserId === t.guardiaUserId)) sumar("inicios", condo, t.fechaInicio, [t.guardiaUserId]);
      if (t.estado === "cerrado") sumar("cerrados", condo, t.fechaInicio, autores);
    }
    for await (const r of ctx.db.query("guardiaRondas").withIndex("by_condominio_fecha", q => q.eq("condominioId", condo).gte("createdAt", periodo.desde).lte("createdAt", periodo.hasta))) {
      controlar(r);
      const fecha = r.fechaInicio ?? r.createdAt;
      if (fecha < periodo.desde || fecha > periodo.hasta || !aceptarActor(r.guardiaUserId, condo, fecha)) continue;
      const finalizada = estadoDeRonda(r.estado) === "finalizada";
      sumar(finalizada ? "rondas" : "rondasEnCurso", condo, fecha, r.guardiaUserId ? [r.guardiaUserId] : []);
      if (!r.guardiaUserId) sinAutorRondas++;
      const duracion = duracionMs(r.fechaInicio, r.fechaCierre);
      if (finalizada && duracion !== null) { sumaDuracion += duracion; muestraDuracion++; }
    }
    for await (const e of ctx.db.query("minutaEventos").withIndex("by_condominio_fecha", q => q.eq("condominioId", condo).gte("createdAt", periodo.desde).lte("createdAt", periodo.hasta))) {
      controlar(e);
      if (!aceptarActor(e.actorUserId, condo, e.createdAt)) continue;
      sumar("minuta", condo, e.createdAt, e.actorUserId ? [e.actorUserId] : []);
      if (!e.actorUserId) sinAutorMinuta++;
      modulos.set(e.modulo, (modulos.get(e.modulo) ?? 0) + 1);
      tipos.set(`${e.modulo} · ${e.tipo}`, (tipos.get(`${e.modulo} · ${e.tipo}`) ?? 0) + 1);
    }
    for await (const n of ctx.db.query("guardiaNovedadReportes").withIndex("by_condominio_fecha", q => q.eq("condominioId", condo).gte("createdAt", periodo.desde).lte("createdAt", periodo.hasta))) {
      controlar(n);
      if (!aceptarActor(n.reportadoPorUserId, condo, n.createdAt)) continue;
      const aporte = esAporteVoluntario(n);
      sumar(aporte ? "aportes" : "novedades", condo, n.createdAt, [n.reportadoPorUserId]);
      if (!aporte) prioridades[n.prioridad]++;
    }
    for await (const t of ctx.db.query("guardiaTurnos").withIndex("by_condominio_estado", q => q.eq("condominioId", condo).eq("estado", "abierto"))) {
      controlar(t);
      // Snapshot actual independiente del rango. Comprueba la asignación en la apertura.
      const deCompania = asignaciones.filter(a => a.rol === "guardia" && a.condominioId === condo).some(a => {
        const c = porContrato.get(a.contratoId);
        return c && [t.guardiaUserId, t.guardiaSecundarioUserId].includes(a.userId) && estaVigente(acotado(a, c), t.fechaInicio);
      });
      if (deCompania && (!args.guardiaUserId || [t.guardiaUserId, t.guardiaSecundarioUserId].includes(args.guardiaUserId))) activos.push({ id: t._id, condominioId: condo, conjunto: porConjunto.get(condo)!.nombre, guardas: [t.guardiaNombre, t.guardiaSecundarioNombre].filter(Boolean).join(" y "), desde: t.fechaInicio });
    }
  }
  const distribucion = (mapa: Map<string, number>) => [...mapa].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
  return { compania: compania.nombre, periodo, conjuntos, guardas, total, porConjunto: [...porConjunto.values()], porGuarda: [...porGuarda.values()], evolucion,
    modulos: distribucion(modulos), tipos: distribucion(tipos), prioridades, activos, sinAutorRondas, sinAutorMinuta,
    duracionRondas: { promedioMs: muestraDuracion ? sumaDuracion / muestraDuracion : null, muestra: muestraDuracion } };
}
