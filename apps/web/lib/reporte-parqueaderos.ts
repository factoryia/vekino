import type { ColumnaReporte, OpcionesXlsxReporte, ValorReporte } from "./excel-reporte.ts";

/** Las columnas y los valores son los mismos para las dos descargas. */
export type FilaReporteParqueadero = {
  ocurrioEn: number;
  casas: string[];
  placa: string;
  titulo: string;
  monto: number;
  estado: string;
  periodo: string | null;
  cobradoPor: string | null;
};

export const COLUMNAS_REPORTE_PARQUEADEROS: readonly ColumnaReporte[] = [
  { encabezado: "Fecha" },
  { encabezado: "Casa" },
  { encabezado: "Placa" },
  { encabezado: "Motivo" },
  { encabezado: "Valor", tipo: "moneda" },
  { encabezado: "Estado" },
  { encabezado: "Periodo" },
  { encabezado: "Registró" },
];

export const ETIQUETA_ESTADO_PARQUEADERO = {
  pendiente: "Por cobrar",
  facturado: "Facturado",
  descartado: "No se cobra",
} satisfies Record<string, string>;

function etiquetaEstado(estado: string): string {
  return ETIQUETA_ESTADO_PARQUEADERO[
    estado as keyof typeof ETIQUETA_ESTADO_PARQUEADERO
  ] ?? estado;
}

export function filasReporteParqueaderos(filas: readonly FilaReporteParqueadero[]): ValorReporte[][] {
  return filas.map((f) => [
    new Date(f.ocurrioEn).toLocaleString("es-CO"),
    f.casas.join(" / "),
    f.placa,
    f.titulo,
    f.monto,
    etiquetaEstado(f.estado),
    f.periodo ?? "",
    f.cobradoPor ?? "",
  ]);
}

/** Sin BOM: se añade al crear el Blob, como en el CSV existente. */
export function csvReporteParqueaderos(filas: readonly FilaReporteParqueadero[]): string {
  const cabecera = COLUMNAS_REPORTE_PARQUEADEROS.map((col) => col.encabezado);
  const esc = (v: ValorReporte) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return [cabecera, ...filasReporteParqueaderos(filas)]
    .map((fila) => fila.map(esc).join(","))
    .join("\n");
}

export function opcionesXlsxReporteParqueaderos(args: {
  filas: readonly FilaReporteParqueadero[];
  estado: string;
  periodo: string;
  busqueda: string;
  fechaArchivo: string;
}): OpcionesXlsxReporte {
  const filtros = [`Estado: ${args.estado === "todos" ? "Todos" : etiquetaEstado(args.estado)}`];
  if (args.periodo) filtros.push(`Periodo: ${args.periodo}`);
  if (args.busqueda.trim()) filtros.push(`Búsqueda: ${args.busqueda.trim()}`);

  return {
    nombreArchivo: `cobros-parqueadero-${args.fechaArchivo}.xlsx`,
    hoja: "Parqueaderos",
    resumen: {
      titulo: "Resumen de parqueaderos",
      subtitulo: filtros.join("  ·  "),
      indicadores: [
        { etiqueta: "Registros exportados", valor: args.filas.length, tipo: "entero" },
      ],
    },
    tabla: {
      titulo: "Cobros de parqueadero",
      nombreTabla: "TablaParqueaderos",
      columnas: COLUMNAS_REPORTE_PARQUEADEROS,
      filas: filasReporteParqueaderos(args.filas),
    },
  };
}
