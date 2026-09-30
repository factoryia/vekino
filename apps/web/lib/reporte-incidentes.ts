import type { FunctionReturnType } from "convex/server";
import type { api } from "@vekino/backend/api";
import { COLUMNAS_REPORTE_INCIDENTES, MAX_PAGINAS_REPORTE_PDF, fechaReporteIncidente, valoresReporteIncidente } from "@vekino/backend/incidenteReporte";
import { construirXlsxReporteConResumen } from "./excel-reporte";

export type DatosReporteIncidentes = NonNullable<FunctionReturnType<typeof api.incidentes.reporte>>;
export function contextoReporteIncidentes(datos: DatosReporteIncidentes): string[][] {
  const r = datos.reporte!;
  return [["Periodo desde", datos.periodo.desdeDia], ["Periodo hasta", datos.periodo.hastaDia], ["Conjunto", r.conjunto],
    ["Estado", r.filtros.estado], ["Prioridad", r.filtros.prioridad], ["Tipo", r.filtros.tipo],
    ["Generado", fechaReporteIncidente(r.generadoEn)], ["Cohorte", "Fecha de reporte; estado actual; America/Bogota"]];
}
export async function xlsxReporteIncidentes(datos: DatosReporteIncidentes): Promise<Uint8Array> {
  return construirXlsxReporteConResumen({ nombreArchivo: "incidentes.xlsx", resumen: {
    titulo: "Reporte de incidentes", indicadores: [
      { etiqueta: "Total", valor: datos.total, tipo: "entero" }, { etiqueta: "Activos", valor: datos.activos, tipo: "entero" },
      { etiqueta: "Resueltos", valor: datos.estados.RESUELTO, tipo: "entero" }, { etiqueta: "Cerrados", valor: datos.estados.CERRADO, tipo: "entero" },
    ], notas: ["Cohorte por fecha de reporte; estados actuales. Días de Colombia."] },
    tabla: { titulo: "Incidentes incluidos", nombreTabla: "IncidentesReporte", columnas: COLUMNAS_REPORTE_INCIDENTES.map((encabezado) => ({ encabezado })), filas: datos.reporte!.filas.map(valoresReporteIncidente) },
  }, contextoReporteIncidentes(datos));
}

/** PDF operativo simple: mismo paquete autorizado, sin adjuntos ni infraestructura adicional. */
export async function pdfReporteIncidentes(datos: DatosReporteIncidentes): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  // No sustituir silenciosamente datos que las fuentes estándar no pueden representar.
  const limpiar = (s: string) => {
    const limpio = s.replace(/[\r\n\t]+/g, " ");
    try { font.encodeText(limpio); } catch { throw new Error("FORMATO_PDF_NO_COMPATIBLE"); }
    return limpio;
  };
  let page = doc.addPage([595.28, 841.89]); let y = 787;
  let referenciaActual = "";
  const nueva = () => {
    if (doc.getPageCount() >= MAX_PAGINAS_REPORTE_PDF) throw new Error("LIMITE_EXPORTACION");
    page = doc.addPage([595.28, 841.89]); y = 765;
    page.drawText("Reporte de incidentes (continuación)", { x: 48, y: 800, size: 11, font: bold });
    if (referenciaActual) { page.drawText(`Referencia: ${referenciaActual} (continuación)`, { x: 48, y, size: 10, font: bold }); y -= 24; }
  };
  const linea = (texto: string, titulo = false) => {
    const fuente = titulo ? bold : font, size = titulo ? 11 : 9;
    // Recorrido lineal por caracteres; evita mediciones cuadráticas de textos largos.
    let buffer = "", ancho = 0;
    const pintar = () => {
      if (y < 65) nueva();
      page.drawText(buffer.trimEnd(), { x: 48, y, size, font: fuente, color: rgb(.1, .12, .1) }); y -= 14;
      buffer = ""; ancho = 0;
    };
    for (const palabra of limpiar(texto).split(/(\s+)/)) {
      const medida = fuente.widthOfTextAtSize(palabra, size);
      if (medida <= 499) {
        if (ancho + medida > 499) pintar();
        if (!buffer && /^\s+$/.test(palabra)) continue;
        buffer += palabra; ancho += medida;
      } else for (const caracter of palabra) {
        const anchoCaracter = fuente.widthOfTextAtSize(caracter, size);
        if (ancho + anchoCaracter > 499) pintar();
        buffer += caracter; ancho += anchoCaracter;
      }
    }
    if (buffer) pintar();
  };
  linea("Reporte de incidentes", true); y -= 10;
  for (const [etiqueta, valor] of contextoReporteIncidentes(datos)) linea(`${etiqueta}: ${valor}`);
  linea(`Total: ${datos.total} | Activos: ${datos.activos} | Resueltos: ${datos.estados.RESUELTO} | Cerrados: ${datos.estados.CERRADO}`, true); y -= 18;
  for (const fila of datos.reporte!.filas) {
    referenciaActual = "";
    if (y < 220) nueva();
    referenciaActual = fila.referencia;
    linea(`Referencia: ${fila.referencia}`, true);
    valoresReporteIncidente(fila).slice(1).forEach((valor, i) => linea(`${COLUMNAS_REPORTE_INCIDENTES[i + 1]}: ${valor || "Sin registro"}`)); y -= 14;
  }
  doc.setTitle("Reporte de incidentes"); doc.setCreator("Vekino"); doc.setProducer("Vekino");
  doc.setCreationDate(new Date(datos.reporte!.generadoEn)); doc.setModificationDate(new Date(datos.reporte!.generadoEn));
  doc.getPages().forEach((p, i, paginas) => p.drawText(`Vekino - Incidentes | ${i + 1} / ${paginas.length}`, { x: 48, y: 32, size: 8, font }));
  return doc.save();
}
