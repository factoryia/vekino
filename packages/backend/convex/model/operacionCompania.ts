import type { QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { exigirAccesoCompania, getCompaniaMiembro, exigirAcceso } from "./acceso";
import { requireAppUser } from "./authz";
import { displayNameFromUser } from "./displayName";
import { acotado, estaVigente, finDe } from "../lib/vigilancia";
import { DIA, diaColombia, limiteDiaColombia, periodoIncidentes } from "../lib/incidenteMetricas";
import { estadoDeRonda, duracionMs } from "../lib/ronda";
import { esAporteVoluntario } from "../lib/reporteGuardia";
import { ventanaQueOcupa } from "../lib/coberturas";

export type FiltrosOperacion = {
  desde: string; hasta: string; condominioId?: Id<"condominios">;
  guardiaUserId?: Id<"users">; granularidad: "dia" | "semana" | "mes";
};
function contadores() {
  return { turnos: 0, inicios: 0, cerrados: 0, rondas: 0, rondasEnCurso: 0, minuta: 0, novedades: 0, aportes: 0 };
}

/**
 * Agregación de las fuentes operativas. No persiste contadores ni expone documentos.
 *
 * QUIÉN HIZO CADA COSA, Y BAJO QUÉ CONTEXTO.
 *
 * Una operación cuenta para un guarda de la compañía por una de dos vías:
 *
 *   - su asignación permanente en ese conjunto en esa fecha (`pertenece`):
 *     la relación contractual, como siempre;
 *   - la cobertura SELLADA en la operación al crearla (`coberturaId`), si es
 *     de esta compañía y de ese conjunto. Es el contexto real de ese momento,
 *     no el de hoy: no se mira si la cobertura sigue activa, ni si la
 *     inhabilitaron después.
 *
 * Una operación de antes del sello que se hizo cubriendo no tiene ni lo uno
 * ni lo otro y sigue sin contarse, como antes de esta fase: no se adivina con
 * fechas. Para la lista de guardas del ámbito (y el filtro por guarda) sí se
 * leen las coberturas del periodo, igual que las asignaciones: son el
 * registro de la relación, no la atribución de ninguna operación.
 */
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
  /* Quien cubrió alguno de estos conjuntos en el periodo: su cobertura es su
   * ámbito allí. Solo las que llegaron a ocurrir (aceptada, o inhabilitada
   * hasta su corte). */
  const coberturasDelPeriodo = (await ctx.db.query("coberturas").withIndex("by_compania_fin", q => q.eq("companiaId", compania._id).gt("fin", periodo.desde)).collect())
    .filter(c => seleccionados.includes(c.condominioId))
    .filter(c => { const v = ventanaQueOcupa(c); return !!v && v.inicio <= periodo.hasta && v.fin > periodo.desde; });
  const guardas = await Promise.all([...new Set([...ambitos.map(a => a.userId), ...coberturasDelPeriodo.map(c => c.userId)])].map(async id => {
    const perfil = await ctx.db.get(id);
    return { id, nombre: perfil ? displayNameFromUser(perfil) : "Perfil no disponible" };
  }));
  guardas.sort((a, b) => a.nombre.localeCompare(b.nombre));
  if (args.guardiaUserId && !guardas.some(g => g.id === args.guardiaUserId)) throw new Error("El guarda no está asignado en este ámbito y periodo.");
  const pertenece = (id: Id<"users">, condo: Id<"condominios">, fecha: number) => ambitos.some(a => a.userId === id && a.condominioId === condo && estaVigente(a.rango, fecha));
  const cubierto = (condo: Id<"condominios">, fecha: number) => contratos.some(c => c.condominioId === condo && estaVigente(c, fecha));
  /* La cobertura sellada en una operación, si es de esta compañía y de este
   * conjunto. Se lee tal cual está guardada; cada una, una sola vez. */
  const leidas = new Map<Id<"coberturas">, Promise<Doc<"coberturas"> | null>>();
  const amparo = async (coberturaId: Id<"coberturas"> | undefined, condo: Id<"condominios">) => {
    if (!coberturaId) return null;
    if (!leidas.has(coberturaId)) leidas.set(coberturaId, ctx.db.get(coberturaId));
    const c = await leidas.get(coberturaId)!;
    return c && c.companiaId === compania._id && c.condominioId === condo ? c : null;
  };
  const enCobertura = new Map<Id<"users">, number>();
  const contarCobertura = (autor: Id<"users">) => enCobertura.set(autor, (enCobertura.get(autor) ?? 0) + 1);
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
  /* El autor de una operación, si cuenta. Con cobertura sellada, el autor es
   * quien la tenía (también en las rondas del registro antiguo, que no
   * guardan quién las hizo pero sí el sello de quien las registró); sin ella,
   * la regla de siempre. */
  const aceptarActor = async (id: Id<"users"> | undefined, coberturaId: Id<"coberturas"> | undefined, condo: Id<"condominios">, fecha: number): Promise<{ autor: Id<"users"> | undefined; cobertura: boolean } | null> => {
    if (!cubierto(condo, fecha)) return null;
    const c = await amparo(coberturaId, condo);
    if (c && (!id || id === c.userId)) {
      return !args.guardiaUserId || args.guardiaUserId === c.userId ? { autor: c.userId, cobertura: true } : null;
    }
    const acepta = id ? pertenece(id, condo, fecha) && (!args.guardiaUserId || args.guardiaUserId === id) : !args.guardiaUserId;
    return acepta ? { autor: id, cobertura: false } : null;
  };
  type Activo = { id: Id<"guardiaTurnos">; condominioId: Id<"condominios">; conjunto: string; guardas: string; desde: number; cobertura?: { coberturaId: Id<"coberturas">; inicio: number; fin: number } };
  const activos: Activo[] = [];
  for (const condo of seleccionados) {
    for await (const t of ctx.db.query("guardiaTurnos").withIndex("by_condominio_fecha", q => q.eq("condominioId", condo).gte("fechaInicio", periodo.desde).lte("fechaInicio", periodo.hasta))) {
      controlar(t);
      /* La cobertura sellada es la del TITULAR: el secundario sigue por la
       * regla de siempre. */
      const c = await amparo(t.coberturaId, condo);
      const titularCubriendo = !!c && c.userId === t.guardiaUserId;
      const autores = [t.guardiaUserId, t.guardiaSecundarioUserId].filter((id): id is Id<"users"> => !!id && (pertenece(id, condo, t.fechaInicio) || (titularCubriendo && id === t.guardiaUserId)));
      if (!autores.length || (args.guardiaUserId && !autores.includes(args.guardiaUserId))) continue;
      sumar("turnos", condo, t.fechaInicio, autores);
      if (titularCubriendo) contarCobertura(t.guardiaUserId);
      // El titular abrió el turno; el secundario participa, pero no se inventa otra apertura.
      if (autores.includes(t.guardiaUserId) && (!args.guardiaUserId || args.guardiaUserId === t.guardiaUserId)) sumar("inicios", condo, t.fechaInicio, [t.guardiaUserId]);
      if (t.estado === "cerrado") sumar("cerrados", condo, t.fechaInicio, autores);
    }
    for await (const r of ctx.db.query("guardiaRondas").withIndex("by_condominio_fecha", q => q.eq("condominioId", condo).gte("createdAt", periodo.desde).lte("createdAt", periodo.hasta))) {
      controlar(r);
      const fecha = r.fechaInicio ?? r.createdAt;
      if (fecha < periodo.desde || fecha > periodo.hasta) continue;
      const ronda = await aceptarActor(r.guardiaUserId, r.coberturaId, condo, fecha);
      if (!ronda) continue;
      const finalizada = estadoDeRonda(r.estado) === "finalizada";
      sumar(finalizada ? "rondas" : "rondasEnCurso", condo, fecha, ronda.autor ? [ronda.autor] : []);
      if (!ronda.autor) sinAutorRondas++;
      if (ronda.cobertura && ronda.autor) contarCobertura(ronda.autor);
      const duracion = duracionMs(r.fechaInicio, r.fechaCierre);
      if (finalizada && duracion !== null) { sumaDuracion += duracion; muestraDuracion++; }
    }
    for await (const e of ctx.db.query("minutaEventos").withIndex("by_condominio_fecha", q => q.eq("condominioId", condo).gte("createdAt", periodo.desde).lte("createdAt", periodo.hasta))) {
      controlar(e);
      const evento = await aceptarActor(e.actorUserId, e.coberturaId, condo, e.createdAt);
      if (!evento) continue;
      sumar("minuta", condo, e.createdAt, evento.autor ? [evento.autor] : []);
      if (!evento.autor) sinAutorMinuta++;
      if (evento.cobertura && evento.autor) contarCobertura(evento.autor);
      modulos.set(e.modulo, (modulos.get(e.modulo) ?? 0) + 1);
      tipos.set(`${e.modulo} · ${e.tipo}`, (tipos.get(`${e.modulo} · ${e.tipo}`) ?? 0) + 1);
    }
    for await (const n of ctx.db.query("guardiaNovedadReportes").withIndex("by_condominio_fecha", q => q.eq("condominioId", condo).gte("createdAt", periodo.desde).lte("createdAt", periodo.hasta))) {
      controlar(n);
      const reporte = await aceptarActor(n.reportadoPorUserId, n.coberturaId, condo, n.createdAt);
      if (!reporte) continue;
      const aporte = esAporteVoluntario(n);
      sumar(aporte ? "aportes" : "novedades", condo, n.createdAt, [n.reportadoPorUserId]);
      if (reporte.cobertura) contarCobertura(n.reportadoPorUserId);
      if (!aporte) prioridades[n.prioridad]++;
    }
    for await (const t of ctx.db.query("guardiaTurnos").withIndex("by_condominio_estado", q => q.eq("condominioId", condo).eq("estado", "abierto"))) {
      controlar(t);
      // Snapshot actual independiente del rango. Comprueba la asignación en la apertura,
      // o la cobertura sellada con la que el titular lo abrió.
      const c = await amparo(t.coberturaId, condo);
      const titularCubriendo = !!c && c.userId === t.guardiaUserId;
      const deCompania = titularCubriendo || asignaciones.filter(a => a.rol === "guardia" && a.condominioId === condo).some(a => {
        const k = porContrato.get(a.contratoId);
        return k && [t.guardiaUserId, t.guardiaSecundarioUserId].includes(a.userId) && estaVigente(acotado(a, k), t.fechaInicio);
      });
      if (deCompania && (!args.guardiaUserId || [t.guardiaUserId, t.guardiaSecundarioUserId].includes(args.guardiaUserId))) activos.push({ id: t._id, condominioId: condo, conjunto: porConjunto.get(condo)!.nombre, guardas: [t.guardiaNombre, t.guardiaSecundarioNombre].filter(Boolean).join(" y "), desde: t.fechaInicio, ...(titularCubriendo ? { cobertura: { coberturaId: c._id, inicio: c.inicio, fin: c.fin } } : {}) });
    }
  }
  const distribucion = (mapa: Map<string, number>) => [...mapa].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
  /* Cuántas de sus operaciones hizo cubriendo, solo en quien tiene alguna:
   * sin coberturas, las filas salen exactamente como antes. */
  const filasPorGuarda = [...porGuarda.values()].map(fila => {
    const n = enCobertura.get(fila.id);
    return n ? { ...fila, enCobertura: n } : fila;
  });
  return { compania: compania.nombre, periodo, conjuntos, guardas, total, porConjunto: [...porConjunto.values()], porGuarda: filasPorGuarda, evolucion,
    modulos: distribucion(modulos), tipos: distribucion(tipos), prioridades, activos, sinAutorRondas, sinAutorMinuta,
    duracionRondas: { promedioMs: muestraDuracion ? sumaDuracion / muestraDuracion : null, muestra: muestraDuracion } };
}
