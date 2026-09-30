/** El dashboard usa días civiles de Colombia y exclusivamente reportadoEn. */
export const DIA = 86_400_000;
export const ANTIGUEDAD_ACTIVA_DIAS = 7;
export const MAX_INCIDENTES_ANALITICA = 5000;
export const MAX_BYTES_ANALITICA = 6_000_000;
const OFFSET_COLOMBIA = 5 * 3_600_000;
export const PERIODOS_INCIDENTES = [
  { value: "hoy", label: "Hoy" }, { value: "7dias", label: "Últimos 7 días" },
  { value: "30dias", label: "Últimos 30 días" }, { value: "mes", label: "Este mes" },
  { value: "mesAnterior", label: "Mes anterior" }, { value: "personalizado", label: "Periodo personalizado" },
] as const;
export type PeriodoIncidentes = (typeof PERIODOS_INCIDENTES)[number]["value"];
export function diaColombia(ms: number) { return new Date(ms - OFFSET_COLOMBIA).toISOString().slice(0, 10); }
export function limiteDiaColombia(valor: string, fin = false) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(valor)) throw new Error("El rango de fechas no es válido.");
  const ms = Date.parse(`${valor}T00:00:00-05:00`);
  if (!Number.isFinite(ms) || diaColombia(ms) !== valor) throw new Error("El rango de fechas no es válido.");
  return ms + (fin ? DIA - 1 : 0);
}
export function periodoIncidentes(periodo: string, desde?: string, hasta?: string, ahora = Date.now()) {
  const hoy = diaColombia(ahora);
  const inicioHoy = limiteDiaColombia(hoy);
  let inicio = inicioHoy;
  let fin = inicioHoy + DIA - 1;
  if (periodo === "7dias") inicio -= 6 * DIA;
  else if (periodo === "30dias") inicio -= 29 * DIA;
  else if (periodo === "mes" || periodo === "mesAnterior") {
    const mes = new Date(`${hoy.slice(0, 7)}-01T00:00:00Z`);
    if (periodo === "mesAnterior") mes.setUTCMonth(mes.getUTCMonth() - 1);
    inicio = limiteDiaColombia(mes.toISOString().slice(0, 10));
    if (periodo === "mesAnterior") { mes.setUTCMonth(mes.getUTCMonth() + 1); fin = limiteDiaColombia(mes.toISOString().slice(0, 10)) - 1; }
  } else if (periodo === "personalizado") {
    inicio = limiteDiaColombia(desde ?? ""); fin = limiteDiaColombia(hasta ?? "", true);
  } else if (periodo !== "hoy") throw new Error("Periodo no válido.");
  if (inicio > fin || fin - inicio > 5 * 366 * DIA) throw new Error("Selecciona un periodo válido de hasta cinco años.");
  return { desde: inicio, hasta: fin, desdeDia: diaColombia(inicio), hastaDia: diaColombia(fin) };
}
export function intervalosIncidentes(desde: number, hasta: number) {
  const dias = Math.ceil((hasta - desde + 1) / DIA);
  const granularidad = dias <= 31 ? "día" : dias <= 180 ? "semana" : "mes";
  const puntos: { desde: number; hasta: number; label: string; value: number }[] = [];
  for (let inicio = desde; inicio <= hasta;) {
    let fin = inicio + (granularidad === "semana" ? 7 : 1) * DIA - 1;
    if (granularidad === "mes") {
      const siguiente = new Date(`${diaColombia(inicio).slice(0, 7)}-01T00:00:00Z`);
      siguiente.setUTCMonth(siguiente.getUTCMonth() + 1);
      fin = limiteDiaColombia(siguiente.toISOString().slice(0, 10)) - 1;
    }
    fin = Math.min(fin, hasta);
    puntos.push({ desde: inicio, hasta: fin, label: diaColombia(inicio), value: 0 }); inicio = fin + 1;
  }
  return { granularidad, puntos };
}
