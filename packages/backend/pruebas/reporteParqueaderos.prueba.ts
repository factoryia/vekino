import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { construirXlsxReporte } from "../../../apps/web/lib/excel-reporte.ts";
import {
  COLUMNAS_REPORTE_PARQUEADEROS,
  csvReporteParqueaderos,
  filasReporteParqueaderos,
  opcionesXlsxReporteParqueaderos,
  type FilaReporteParqueadero,
} from "../../../apps/web/lib/reporte-parqueaderos.ts";

const filas: FilaReporteParqueadero[] = [
  {
    ocurrioEn: Date.UTC(2026, 8, 15, 14, 30),
    casas: ["0012", "34"],
    placa: "ABC123",
    titulo: 'Visita, "noche"',
    monto: 26000,
    estado: "pendiente",
    periodo: null,
    cobradoPor: null,
  },
  {
    ocurrioEn: Date.UTC(2026, 8, 16, 14, 30),
    casas: ["05"],
    placa: "XYZ987",
    titulo: "Moto",
    monto: 12000,
    estado: "facturado",
    periodo: "2026-10",
    cobradoPor: "Ana",
  },
];

test("CSV de parqueaderos conserva encabezados, orden, textos y escape", () => {
  const csv = csvReporteParqueaderos(filas);
  const valores = filasReporteParqueaderos(filas);
  const esc = (v: string | number | null) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  assert.equal(csv, [COLUMNAS_REPORTE_PARQUEADEROS.map((c) => c.encabezado), ...valores]
    .map((fila) => fila.map(esc).join(",")).join("\n"));
  assert.deepEqual(valores[0]?.slice(1), [
    "0012 / 34", "ABC123", 'Visita, "noche"', 26000, "Por cobrar", "", "",
  ]);
  assert.equal(valores[1]?.[5], "Facturado");
});

test("Excel de parqueaderos reutiliza el reporte con resumen y la misma tabla del CSV", async () => {
  const opts = opcionesXlsxReporteParqueaderos({
    filas,
    estado: "todos",
    periodo: "2026-10",
    busqueda: "ABC",
    fechaArchivo: "2026-09-28",
  });
  assert.equal(opts.nombreArchivo, "cobros-parqueadero-2026-09-28.xlsx");
  assert.equal(opts.hoja, "Parqueaderos");
  assert.equal(opts.resumen.indicadores[0]?.valor, filas.length);
  assert.match(opts.resumen.subtitulo!, /Estado: Todos.*Periodo: 2026-10.*Búsqueda: ABC/);
  assert.deepEqual(opts.tabla.filas, filasReporteParqueaderos(filas));
  assert.deepEqual(opts.tabla.columnas.map((c) => c.encabezado),
    ["Fecha", "Casa", "Placa", "Motivo", "Valor", "Estado", "Periodo", "Registró"]);
  assert.equal(opts.tabla.columnas[4]?.tipo, "moneda");

  const zip = await JSZip.loadAsync(await construirXlsxReporte(opts));
  const sheet = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
  const tabla = await zip.file("xl/tables/table1.xml")!.async("string");
  const strings = await zip.file("xl/sharedStrings.xml")!.async("string");
  const estilos = await zip.file("xl/styles.xml")!.async("string");
  assert.match(strings, /Resumen de parqueaderos/);
  assert.match(strings, /Cobros de parqueadero/);
  assert.match(strings, /0012 \/ 34/);
  assert.match(strings, /Visita, &quot;noche&quot;/);
  assert.match(tabla, /TablaParqueaderos/);
  assert.match(tabla, /autoFilter/);
  assert.match(sheet, /<v>26000<\/v>/);
  assert.match(sheet, /<v>12000<\/v>/);
  assert.match(estilos, /\$ /);
});
