import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agruparEnCobros,
  casaDelCobro,
  claveCobro,
  estadoDeReportesViejos,
  gestionDeCobro,
  periodoDeReporte,
  periodoEnColombia,
  periodoSiguiente,
  transicionCobro,
  type CobroGuardado,
  type ReporteDeCobro,
} from "../convex/lib/cobroParqueadero.ts";
import {
  cargoAporteDeFactura,
  deudaAporteDeFactura,
  esLineaDeAporte,
} from "../convex/lib/aporte.ts";
import {
  carteraDeUnidad,
  estadoVisibleDeFactura,
  facturasDelResidente,
  fechaEnPalabras,
  inicioDeMora,
  textosDePlazos,
  vencimientoDePeriodo,
  type FacturaCartera,
} from "../convex/lib/cartera.ts";
import { recaudoContablePorPeriodo, recaudoVekinoPorPeriodo } from "../convex/lib/recaudo.ts";
import {
  MENSAJE_PASARELA_DE_PRUEBAS,
  pasarelaPermitida,
  unidadesDePruebaAval,
} from "../convex/lib/avalProduccion.ts";
import { decidirVersion, leerVersion } from "../convex/lib/versionApp.ts";
import { numeroFacturaDe } from "../convex/lib/lecturaFactura.ts";

/**
 * FASE 4 DE LA AUDITORÍA DE FACTURACIÓN (docs/audits/FASE-4-FACTURACION.md):
 * las reglas puras.
 *
 *   · cobros de parqueadero: período en hora de Colombia, identidad (casa,
 *     vehículo, mes), estado de los reportes viejos, transiciones (F-08);
 *   · aporte voluntario: concepto por texto, cargo del mes y deuda (F-10);
 *   · la lista del residente: la vigente siempre llega (F-16);
 *   · recaudo: según la contabilidad y registrado en Vekino (F-19);
 *   · mora desde el 16 del mes siguiente (decisión B) y "sin verificar";
 *   · pasarela en QA, versión mínima del móvil y número de factura (F-17).
 */

const bogota = (local: string) => Date.parse(`${local}:00-05:00`);

// ─── Parqueadero (F-08) ─────────────────────────────────────────────────────

test("parqueadero: el mes del reporte va en hora de Colombia, también en el borde", () => {
  /* 30 de septiembre, 10 p. m. en Bogotá = 1.º de octubre en UTC. */
  assert.equal(periodoEnColombia(bogota("2026-09-30T22:00")), "2026-09");
  assert.equal(new Date(bogota("2026-09-30T22:00")).toISOString().slice(0, 7), "2026-10");
  assert.equal(periodoEnColombia(bogota("2026-10-01T00:00")), "2026-10");
  assert.equal(periodoEnColombia(bogota("2026-12-31T23:30")), "2026-12");
  assert.equal(periodoEnColombia(bogota("2027-01-01T00:10")), "2027-01");
  /* Vale cuando OCURRIÓ, no cuando se registró. */
  assert.equal(
    periodoDeReporte({ createdAt: bogota("2026-10-01T06:00"), ocurrioEn: bogota("2026-09-30T23:00") }),
    "2026-09",
  );
  /* El período sugerido también: el 30 de septiembre a las 11 p. m. aún es septiembre. */
  assert.equal(periodoSiguiente(bogota("2026-09-30T23:00")), "2026-10");
});

test("parqueadero: la identidad es casa + placa + mes; la placa sin guiones ni minúsculas", () => {
  assert.equal(
    claveCobro({ unidadId: "u1", placa: "abc-123", periodo: "2026-09" }),
    claveCobro({ unidadId: "u1", placa: "ABC 123", periodo: "2026-09" }),
  );
  assert.notEqual(
    claveCobro({ unidadId: "u1", placa: "ABC123", periodo: "2026-09" }),
    claveCobro({ unidadId: "u1", placa: "XYZ987", periodo: "2026-09" }),
  );
  assert.notEqual(
    claveCobro({ unidadId: "u1", placa: "ABC123", periodo: "2026-09" }),
    claveCobro({ unidadId: "u2", placa: "ABC123", periodo: "2026-09" }),
  );
  assert.equal(claveCobro({ unidadId: null, placa: "ABC123", periodo: "2026-09" }), "sin-casa|ABC123|2026-09");
});

test("parqueadero: un reporte con varias casas se le cobra a la del vehículo; sin ella, no se adivina", () => {
  const casas = [
    { unidadId: "u101", numero: "101" },
    { unidadId: "u102", numero: "102" },
  ];
  assert.deepEqual(casaDelCobro(casas, "u102"), casas[1]);
  assert.equal(casaDelCobro(casas, "u999"), null);
  assert.equal(casaDelCobro(casas, null), null);
  assert.deepEqual(casaDelCobro([casas[0]!], null), casas[0]);
  assert.equal(casaDelCobro(undefined, null), null);
});

test("parqueadero: los dos estados viejos de un reporte son uno solo", () => {
  assert.equal(estadoDeReportesViejos([{ gestion: "cobrada", cobroEstado: "pendiente" }]).estado, "facturado");
  assert.equal(estadoDeReportesViejos([{ cobroEstado: "facturado", cobroPeriodo: "2026-10" }]).periodoFactura, "2026-10");
  /* Uno facturado en el mes factura el mes: cobrar los otros es el doble cobro. */
  const mezcla = estadoDeReportesViejos([{ cobroEstado: "pendiente" }, { gestion: "cobrada" }, {}]);
  assert.equal(mezcla.estado, "facturado");
  assert.equal(mezcla.mezclado, true);
  /* Descartado solo si todos lo están. */
  assert.equal(estadoDeReportesViejos([{ cobroEstado: "descartado" }, { gestion: "descartada" }]).estado, "descartado");
  assert.equal(estadoDeReportesViejos([{ cobroEstado: "descartado" }, { cobroEstado: "pendiente" }]).estado, "pendiente");
  assert.deepEqual(estadoDeReportesViejos([]), { estado: "pendiente", mezclado: false });
  assert.equal(gestionDeCobro("facturado"), "cobrada");
  assert.equal(gestionDeCobro("descartado"), "descartada");
});

test("parqueadero: transiciones válidas y las que se rechazan, con su mensaje", () => {
  assert.deepEqual(transicionCobro("pendiente", "facturar"), { ok: true, hacia: "facturado" });
  assert.deepEqual(transicionCobro("pendiente", "descartar"), { ok: true, hacia: "descartado" });
  assert.deepEqual(transicionCobro("facturado", "devolver"), { ok: true, hacia: "pendiente" });
  assert.deepEqual(transicionCobro("descartado", "devolver"), { ok: true, hacia: "pendiente" });

  const refacturar = transicionCobro("facturado", "facturar", "2026-10");
  assert.equal(refacturar.ok, false);
  assert.match((refacturar as { mensaje: string }).mensaje, /ya se facturó en 2026-10/);
  assert.equal(transicionCobro("facturado", "descartar").ok, false);
  assert.equal(transicionCobro("descartado", "facturar").ok, false);
  assert.equal(transicionCobro("descartado", "descartar").ok, false);
  assert.match((transicionCobro("pendiente", "devolver") as { mensaje: string }).mensaje, /ya está pendiente/);
});

function reporte(id: string, extra: Partial<ReporteDeCobro> = {}): ReporteDeCobro {
  return {
    _id: id,
    _creationTime: 1,
    vehiculoPlaca: "ABC123",
    vehiculoId: "v1",
    unidades: [{ unidadId: "u101", numero: "101" }],
    createdAt: bogota("2026-09-10T10:00"),
    ...extra,
  };
}

test("parqueadero: tres reportes del mismo carro en el mes son un cobro; el borde de mes separa", () => {
  const grupos = agruparEnCobros(
    [
      reporte("r1", { ocurrioEn: bogota("2026-09-03T22:00") }),
      reporte("r2", { ocurrioEn: bogota("2026-09-10T22:00") }),
      reporte("r3", { ocurrioEn: bogota("2026-09-30T22:00") }),
      reporte("r4", { ocurrioEn: bogota("2026-10-01T01:00") }),
      reporte("r5", { vehiculoPlaca: "XYZ987", vehiculoId: "v2" }),
    ],
    [],
    () => null,
  );
  const porClave = new Map(grupos.map((g) => [g.clave, g.reportes.map((r) => r._id)]));
  assert.equal(grupos.length, 3);
  assert.deepEqual(porClave.get("u101|ABC123|2026-09"), ["r1", "r2", "r3"]);
  assert.deepEqual(porClave.get("u101|ABC123|2026-10"), ["r4"]);
  assert.deepEqual(porClave.get("u101|XYZ987|2026-09"), ["r5"]);
});

test("parqueadero: un reporte viejo se une al cobro guardado de su misma clave, y manda el estado guardado", () => {
  const cobro: CobroGuardado = {
    _id: "c1",
    clave: "u101|ABC123|2026-09",
    unidadId: "u101",
    unidadNumero: "101",
    placa: "ABC123",
    periodo: "2026-09",
    estado: "facturado",
    periodoFactura: "2026-10",
  };
  const grupos = agruparEnCobros(
    [reporte("nuevo", { cargoId: "c1" }), reporte("viejo", { cobroEstado: "pendiente" })],
    [cobro],
    () => null,
  );
  assert.equal(grupos.length, 1);
  assert.equal(grupos[0]!.estado, "facturado");
  assert.equal(grupos[0]!.periodoFactura, "2026-10");
  assert.equal(grupos[0]!.reportes.length, 2);
});

// ─── Aporte voluntario (F-10) ───────────────────────────────────────────────

test("aporte: se reconoce por el texto del concepto, no por el código", () => {
  for (const c of ["CONT. VOL. AREAS COMUNES", "CONT VOLUNTARIA AREAS COMUN", "CONT VOLUNTARIA AREAS COM", "Contribución voluntaria", "APORTE VOLUNTARIO"]) {
    assert.equal(esLineaDeAporte({ concepto: c }), true, c);
  }
  /* El código 5 de Arboleda y el aporte navideño de Ciudad del Campo no son el cupo. */
  for (const c of ["Parqueadero visitante", "APORTE NAVIDEÑO", "CUOTA DE ADMINISTRACION", "CONTROL VOLQUETAS"]) {
    assert.equal(esLineaDeAporte({ concepto: c }), false, c);
  }
  /* Un conjunto que lo llame distinto lo configura; entonces solo cuenta lo suyo. */
  assert.equal(esLineaDeAporte({ concepto: "Cupo de parqueadero propietario" }, ["CUPO DE PARQUEADERO"]), true);
  assert.equal(esLineaDeAporte({ concepto: "CONT. VOL. AREAS COMUNES" }, ["CUPO DE PARQUEADERO"]), false);
});

test("aporte: se suma el cargo del mes (actual); la deuda es el total y no se suma entre meses", () => {
  const septiembre = [
    { codigo: 1, concepto: "CUOTA", saldoAnterior: 0, actual: 300_000, total: 300_000 },
    { codigo: 5, concepto: "CONT. VOL. AREAS COMUNES", saldoAnterior: 7_000, actual: 7_000, total: 14_000 },
  ];
  assert.equal(cargoAporteDeFactura(septiembre), 7_000);
  assert.equal(deudaAporteDeFactura(septiembre), 14_000);
  /* Una línea sin `actual` (datos viejos): total − saldo anterior. */
  assert.equal(
    cargoAporteDeFactura([{ codigo: 5, concepto: "CONT VOLUNTARIA AREAS COMUN", saldoAnterior: 7_000, total: 14_000 }]),
    7_000,
  );
  assert.equal(cargoAporteDeFactura([{ codigo: 5, concepto: "Parqueadero visitante", saldoAnterior: 0, actual: 10_000, total: 10_000 }]), 0);
});

// ─── La lista del residente (F-16) ──────────────────────────────────────────

test("listMia: la vigente de cada unidad llega aunque haya más de 50 facturas, una sola vez cada una", () => {
  const meses = (unidad: string, desde: number, n: number, emision: number) =>
    Array.from({ length: n }, (_, i) => {
      const k = desde + i;
      const periodo = `${2020 + Math.floor(k / 12)}-${String((k % 12) + 1).padStart(2, "0")}`;
      return { _id: `${unidad}-${periodo}`, periodo, fechaEmision: emision + i };
    }).reverse();
  /* La 101 tiene 55 facturas cargadas hace poco; la 202, una sola, cargada antes que todas. */
  const casa101 = meses("u101", 0, 55, 1_000_000);
  const casa202 = [{ _id: "u202-2026-09", periodo: "2026-09", fechaEmision: 1 }];
  const lista = facturasDelResidente([casa101, casa202, casa202], 50);
  assert.equal(lista.length, 50);
  assert.ok(lista.some((f) => f._id === "u202-2026-09"), "la vigente de la 202 llega");
  assert.ok(lista.some((f) => f._id === casa101[0]!._id), "la vigente de la 101 llega");
  assert.equal(new Set(lista.map((f) => f._id)).size, lista.length, "ninguna repetida");
  /* Dos del mismo período más reciente (no debería pasar): llegan las dos, para que se vea el empate. */
  const empate = facturasDelResidente([[{ _id: "a", periodo: "2026-09" }, { _id: "b", periodo: "2026-09" }, { _id: "c", periodo: "2026-08" }]], 1);
  assert.deepEqual(empate.map((f) => f._id).sort(), ["a", "b"]);
});

// ─── Recaudo (F-19) ─────────────────────────────────────────────────────────

/** Una factura cuyas líneas cuadran: saldo anterior + cargo del mes = total. */
function fr(id: string, unidadId: string, periodo: string, totalAPagar: number, saldoAnteriorDocumento?: number) {
  const anterior = saldoAnteriorDocumento ?? 0;
  return {
    _id: id,
    unidadId,
    periodo,
    totalAPagar,
    lineas: [{ codigo: 1, concepto: "CUOTA", saldoAnterior: anterior, actual: totalAPagar - anterior, total: totalAPagar }],
    saldoAnteriorDocumento,
  };
}

test("recaudo según la contabilidad: total del mes menos el saldo anterior del siguiente, con créditos y huecos", () => {
  const r = recaudoContablePorPeriodo([
    fr("a8", "A", "2026-08", 300_000),
    fr("a9", "A", "2026-09", 350_000, 50_000), // A pagó 250.000 de agosto
    fr("b8", "B", "2026-08", 300_000),
    fr("b9", "B", "2026-09", 200_000, -100_000), // B pagó de más: crédito de 100.000
    fr("c6", "C", "2026-06", 300_000),
    fr("c8", "C", "2026-08", 600_000, 300_000), // C no tiene julio: no se calcula junio
    fr("d8", "D", "2026-08", 300_000), // D no tiene septiembre: falta el mes
  ]);
  const agosto = r.get("2026-08")!;
  assert.equal(agosto.monto, 250_000 + 400_000);
  assert.equal(agosto.unidades, 2);
  assert.equal(agosto.mesFaltante, 2); // C (agosto sin septiembre) y D
  const junio = r.get("2026-06")!;
  assert.equal(junio.monto, null); // nadie se pudo calcular
  assert.equal(junio.mesFaltante, 0);
  assert.equal(junio.sinSiguiente, 1); // el conjunto no tiene julio cargado
  /* Septiembre es el último cargado: no se calcula y se dice por qué.
   * (`siguienteManual`, el motivo nuevo del H4 del QA de comprobantes, en 0.) */
  assert.deepEqual(r.get("2026-09"), { monto: null, unidades: 0, sinSiguiente: 2, mesFaltante: 0, enRevision: 0, noCuadra: 0, siguienteManual: 0 });
  /* Una factura cargada antes de la Fase 2 cuyas líneas no suman su total
   * (agosto de CDC: totales en $0) no se calcula: daría un recaudo negativo. */
  const viejo = recaudoContablePorPeriodo([
    { ...fr("y8", "Y", "2026-08", 0), lineas: [{ codigo: 1, concepto: "CUOTA", saldoAnterior: 900_000, actual: 300_000, total: 1_200_000 }] },
    fr("y9", "Y", "2026-09", 1_500_000, 1_200_000),
  ]);
  assert.deepEqual(viejo.get("2026-08"), { monto: null, unidades: 0, sinSiguiente: 0, mesFaltante: 0, enRevision: 0, noCuadra: 1, siguienteManual: 0 });
  /* Con una lectura en revisión tampoco. */
  const revision = recaudoContablePorPeriodo([
    fr("x8", "X", "2026-08", 300_000),
    { ...fr("x9", "X", "2026-09", 300_000, 0), lecturaDudosa: { motivos: ["lineas_no_cuadran"] } },
  ]);
  assert.equal(revision.get("2026-08")!.enRevision, 1);
  assert.equal(revision.get("2026-08")!.monto, null);
});

test("recaudo registrado en Vekino: pagos aprobados y comprobantes aprobados con monto", () => {
  const periodoDe = new Map([["f8", "2026-08"], ["f9", "2026-09"]]);
  const r = recaudoVekinoPorPeriodo(
    periodoDe,
    [
      { facturaId: "f8", monto: 300_000, estado: "aprobada" },
      { facturaId: "f8", monto: 100_000, estado: "reversada" },
      { facturaId: "f8", monto: 50_000, estado: "fallida" },
      { facturaId: "otra", monto: 1, estado: "aprobada" },
    ],
    [
      { facturaId: "f9", monto: 340_000, estado: "aprobado" },
      { facturaId: "f9", estado: "aprobado" },
      { facturaId: "f9", monto: 5, estado: "rechazado" },
    ],
  );
  assert.deepEqual(r.get("2026-08"), { monto: 300_000, pagos: 1, comprobantes: 0, comprobantesSinMonto: 0 });
  assert.deepEqual(r.get("2026-09"), { monto: 340_000, pagos: 0, comprobantes: 1, comprobantesSinMonto: 1 });
});

// ─── Mora desde el 16 del mes siguiente (decisión B) ────────────────────────

function cartera(periodo: string, extra: Partial<FacturaCartera> = {}): FacturaCartera {
  return {
    periodo,
    estado: "pendiente",
    fechaVencimiento: vencimientoDePeriodo(periodo),
    totalAPagar: 380_000,
    lineas: [],
    ...extra,
  };
}

test("mora B: empieza el 16 del mes siguiente, sea el vencimiento nuevo o el viejo, y nunca antes de un plazo propio", () => {
  /* Nuevo: vence el 31 de octubre; la mora empieza el 16 de noviembre. */
  assert.equal(inicioDeMora(cartera("2026-10")), bogota("2026-11-16T00:00"));
  /* Viejo: vence el 15 del mes siguiente; la mora, el 16, como siempre. */
  assert.equal(inicioDeMora(cartera("2026-09", { fechaVencimiento: bogota("2026-10-15T00:00") })), bogota("2026-10-16T00:00"));
  /* Diciembre → enero del año siguiente. */
  assert.equal(inicioDeMora(cartera("2026-12")), bogota("2027-01-16T00:00"));
  /* Un plazo propio más largo (una factura manual hasta el 25) se respeta. */
  assert.equal(inicioDeMora(cartera("2026-10", { fechaVencimiento: bogota("2026-11-25T00:00") })), bogota("2026-11-26T00:00"));
});

test("mora B: con el vencimiento a fin de mes, del 1 al 15 no hay mora; el 16 sí, con los días desde ahí", () => {
  const c = (ahora: string) => carteraDeUnidad([cartera("2026-10")], bogota(ahora));
  assert.equal(c("2026-10-31T18:00").estado, "pendiente");
  assert.equal(c("2026-11-01T08:00").estado, "pendiente");
  assert.equal(c("2026-11-15T23:59").estado, "pendiente");
  const dia16 = c("2026-11-16T08:00");
  assert.equal(dia16.estado, "en_mora");
  assert.equal(dia16.diasMora, 1);
  assert.equal(dia16.vencimientoEnMora, vencimientoDePeriodo("2026-10"));
  assert.equal(c("2026-11-20T08:00").diasMora, 5);
});

test("mora B: el residente ve los dos plazos con texto claro", () => {
  assert.equal(fechaEnPalabras(bogota("2026-11-16T00:00")), "16 de noviembre de 2026");
  assert.deepEqual(textosDePlazos(cartera("2026-10", { totalConDescuento: 340_000 } as Partial<FacturaCartera>)), [
    "Con descuento hasta el 15 de octubre de 2026",
    "Precio completo hasta el 31 de octubre de 2026",
    "En mora desde el 16 de noviembre de 2026",
  ]);
  assert.deepEqual(textosDePlazos(cartera("2026-10", { fechaVencimiento: 0 })), []);
});

// ─── "Sin verificar" ────────────────────────────────────────────────────────

test("sin verificar: una histórica pendiente; la vigente pendiente sigue pendiente", () => {
  const cadena = [{ periodo: "2026-06" }, { periodo: "2026-08" }, { periodo: "2026-09" }];
  assert.equal(estadoVisibleDeFactura({ periodo: "2026-06", estado: "pendiente" }, cadena), "sin_verificar");
  assert.equal(estadoVisibleDeFactura({ periodo: "2026-09", estado: "pendiente" }, cadena), "pendiente");
  assert.equal(estadoVisibleDeFactura({ periodo: "2026-08", estado: "vencida" }, cadena), "vencida");
  assert.equal(estadoVisibleDeFactura({ periodo: "2026-08", estado: "pagada" }, cadena), "pagada");
  /* Una lectura en revisión manda sobre "sin verificar". */
  assert.equal(
    estadoVisibleDeFactura({ periodo: "2026-06", estado: "pendiente", lecturaDudosa: { motivos: ["sin_lineas"] } }, cadena),
    "en_revision",
  );
  /* Sin la cadena no se puede decir que es histórica. */
  assert.equal(estadoVisibleDeFactura({ periodo: "2026-06", estado: "pendiente" }, []), "pendiente");
});

// ─── Pasarela en QA ─────────────────────────────────────────────────────────

test("pasarela en QA: solo las unidades de prueba declaradas; sin la lista, ninguna; prod como antes", () => {
  assert.equal(pasarelaPermitida({ AVAL_AMBIENTE: "qa" }, "u-real"), false);
  assert.equal(pasarelaPermitida({ AVAL_AMBIENTE: "qa", AVAL_UNIDADES_PRUEBA: "u-999, u-9999" }, "u-999"), true);
  assert.equal(pasarelaPermitida({ AVAL_AMBIENTE: "qa", AVAL_UNIDADES_PRUEBA: "u-999,u-9999" }, "u-real"), false);
  assert.equal(pasarelaPermitida({ AVAL_AMBIENTE: "prod" }, "u-real"), true);
  assert.equal(pasarelaPermitida({ AVAL_AMBIENTE: "prod", AVAL_UNIDADES_PRUEBA: "u-999" }, "u-real"), true);
  /* Sin AVAL_AMBIENTE no decide esta regla: la pasarela ya se niega sola (Fase 3). */
  assert.equal(pasarelaPermitida({}, "u-real"), true);
  assert.deepEqual([...unidadesDePruebaAval({ AVAL_UNIDADES_PRUEBA: " a ;b\nc,," })], ["a", "b", "c"]);
  assert.match(MENSAJE_PASARELA_DE_PRUEBAS, /modo de pruebas/);
});

// ─── Versión mínima del móvil ───────────────────────────────────────────────

test("versión mínima: sin configuración no bloquea a nadie; con ella, solo a las anteriores", () => {
  assert.deepEqual(decidirVersion({}, "1.0.0", "ios"), { debeActualizar: false, versionMinima: null, mensaje: null });
  assert.equal(decidirVersion({ MOVIL_VERSION_MINIMA: "1.2.0" }, "1.0.0", "android").debeActualizar, true);
  assert.equal(decidirVersion({ MOVIL_VERSION_MINIMA: "1.2.0" }, "1.2.0", "android").debeActualizar, false);
  assert.equal(decidirVersion({ MOVIL_VERSION_MINIMA: "1.2.0" }, "1.10.0", "android").debeActualizar, false);
  /* Por plataforma manda la suya. */
  assert.equal(decidirVersion({ MOVIL_VERSION_MINIMA: "2.0.0", MOVIL_VERSION_MINIMA_IOS: "1.0.0" }, "1.5.0", "ios").debeActualizar, false);
  /* Lo que no se puede leer no se bloquea. */
  assert.equal(decidirVersion({ MOVIL_VERSION_MINIMA: "1.2.0" }, null, "ios").debeActualizar, false);
  assert.equal(decidirVersion({ MOVIL_VERSION_MINIMA: "uno" }, "0.1.0", "ios").debeActualizar, false);
  assert.deepEqual(leerVersion("1.2.3"), [1, 2, 3]);
  assert.equal(leerVersion("1.2.x"), null);
});

// ─── Número de factura (F-17) ───────────────────────────────────────────────

test("número de factura: del período y la casa del documento, no de la posición en el lote", () => {
  assert.equal(numeroFacturaDe("2026-10", "104", 7), "FAC-2026-10-104");
  assert.equal(numeroFacturaDe("2026-10", "104 T-I", 7), "FAC-2026-10-104-T-I");
  assert.equal(numeroFacturaDe("2026-10", "", 7), "FAC-2026-10-0007");
});
