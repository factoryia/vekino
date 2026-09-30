import type { Doc } from "../_generated/dataModel";

/** Misma clasificación del listado operativo, incluidos formularios antiguos. */
export function esAporteVoluntario(n: Pick<Doc<"guardiaNovedadReportes">, "tipoReporte" | "vehiculoPlaca" | "descripcion">) {
  if (n.tipoReporte) return n.tipoReporte === "aporte_voluntario";
  return !!n.vehiculoPlaca || (n.descripcion.startsWith("Placa ") && n.descripcion.includes(" durante la ronda."));
}
