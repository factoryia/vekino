import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from "bun:test";
import { Window } from "happy-dom";
const ventana = new Window({ url: "http://localhost" });
for (const clave of ["window", "document", "HTMLElement", "HTMLInputElement", "Event", "MouseEvent", "Node", "navigator", "SVGElement"]) Object.defineProperty(globalThis, clave, { configurable: true, value: clave === "window" ? ventana : ventana[clave] });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { getFunctionName } = await import("convex/server");

/**
 * LO QUE VE LA WEB — Fase 4 de la auditoría de facturación
 * (docs/audits/FASE-4-FACTURACION.md). Páginas reales, con las respuestas del
 * servidor simuladas:
 *
 *   · "Sin verificar": una factura histórica que quedó pendiente (falta el
 *     estado de cuenta del mes siguiente) no se rotula "Pendiente";
 *   · decisión B: el residente ve el plazo del precio completo (fin de mes) y
 *     desde cuándo cuenta como mora (el 16 del mes siguiente);
 *   · pasarela en QA: sin portal del banco, a una unidad real no se le
 *     ofrece "Pagar" y se le dice por qué;
 *   · reportes: las dos cifras de recaudo, por separado (F-19).
 *
 * Proceso propio (como confirmarFacturasFase3): simula `convex/react` con
 * respuestas que las pruebas de la carpeta `facturacion/` no conocen.
 */

const bogota = (local) => Date.parse(`${local}:00-05:00`);

/** Último día del mes del período, a medianoche de Colombia (vencimiento desde la Fase 3). */
function finDeMes(periodo) {
  const [a, m] = periodo.split("-").map(Number);
  return Date.UTC(a, m, 0, 5);
}
/** El vencimiento de las facturas cargadas antes de la Fase 3: el 15 del mes siguiente. */
function quinceSiguiente(periodo) {
  const [a, m] = periodo.split("-").map(Number);
  const sig = m === 12 ? `${a + 1}-01` : `${a}-${String(m + 1).padStart(2, "0")}`;
  return bogota(`${sig}-15T00:00`);
}

function factura(periodo, estado, totalAPagar, extra = {}) {
  return {
    _id: `f-${periodo}`,
    unidadId: "u101",
    numeroFactura: `FAC-${periodo}-101`,
    periodo,
    periodoLabel: periodo,
    estado,
    totalAPagar,
    saldoAFavor: 0,
    fechaVencimiento: finDeMes(periodo),
    lineas: [{ codigo: 2, concepto: "Administración", saldoAnterior: 0, actual: totalAPagar, total: totalAPagar }],
    unidadNumero: "101",
    unidadTipo: "casa",
    unidadTorre: null,
    ...extra,
  };
}

const MENSAJE_QA =
  "El pago en línea todavía no está habilitado: la pasarela está en modo de pruebas. Paga por los canales habituales del conjunto y, si quieres, envía el comprobante.";

let respuestas = {};
let paginadas = [];
const home = (avalPortalUrl) => ({
  allowed: true,
  isPlatform: false,
  userId: "residente",
  userName: "Residente de prueba",
  userImage: null,
  userEmail: "residente@vekino.test",
  myRoles: ["propietario"],
  membershipId: "m-residente",
  unidades: [{ _id: "u101", numero: "101", torre: null, bloque: null, tipo: "casa", estado: "ocupada", coeficiente: null, vinculo: "propietario", esPrincipal: true }],
  condominio: { _id: "condo-prueba", name: "Conjunto de Prueba", city: null, address: null, nit: null, logo: null, coverImage: null, primaryColor: null, avalPortalUrl },
});
mock.module("next/navigation", () => ({ useParams: () => ({ id: "condo-prueba" }) }));
mock.module("next/link", () => ({ default: ({ href, children, prefetch: _p, ...props }) => createElement("a", { ...props, href }, children) }));
mock.module("convex/react", () => ({
  useQuery: (fn, args) => (args === "skip" ? undefined : respuestas[getFunctionName(fn)]),
  usePaginatedQuery: () => ({ results: paginadas, status: "Exhausted", loadMore: () => {} }),
  useAction: () => async () => ({ pagoId: "pago-prueba", redirectUrl: "https://pasarela.test" }),
  useMutation: () => async () => {},
}));
/* Finanzas monta la carga de facturas, que lee la sesión del cliente oficial
 * (lib/fetch-con-sesion.ts). Aquí no se carga nada. */
mock.module("@/lib/auth-client", () => ({ authClient: { getCookie: () => "" } }));
const { default: MisFacturas } = await import("../app/mi/[id]/cuenta/page");
const { default: PortalInicio } = await import("../app/mi/[id]/page");
const { default: Reportes } = await import("../app/condominio/[id]/reportes/page");
const { default: Finanzas } = await import("../app/condominio/[id]/finanzas/page");
const { CobrosParqueaderoPanel } = await import("../components/vehiculos/cobros-parqueadero");

let contenedor, root;
beforeEach(() => {
  contenedor = document.createElement("div");
  document.body.append(contenedor);
  root = createRoot(contenedor);
});
afterEach(async () => {
  await act(() => root.unmount());
  contenedor.remove();
  setSystemTime();
  respuestas = {};
  paginadas = [];
});

async function ver(Pagina, { facturas, ahora, avalPortalUrl = null, opciones }) {
  setSystemTime(new Date(ahora));
  respuestas = {
    "facturas:listMia": facturas,
    "portal:home": home(avalPortalUrl),
    "portal:misActividades": { reservasActivas: [], ticketsAbiertos: 0 },
    "comunicados:listRecent": [],
    ...(opciones ? { "pagos:opcionesDePago": opciones } : {}),
  };
  await act(() => root.render(createElement(Pagina)));
}
const texto = () => contenedor.textContent.replace(/\s+/g, " ");
const botonesPagar = () => [...contenedor.querySelectorAll("button")].filter((b) => /Pagar/.test(b.textContent));

/** Junio quedó pendiente porque falta julio; agosto es la vigente (vencimiento nuevo). */
const CASA_CON_HUECO = [
  factura("2026-06", "pendiente", 300_000, { fechaVencimiento: quinceSiguiente("2026-06") }),
  factura("2026-08", "pendiente", 600_000),
];

describe("Sin verificar · histórica pendiente", () => {
  test("'Mis facturas' la rotula 'Sin verificar' y dice por qué; la vigente sigue 'Pendiente'", async () => {
    await ver(MisFacturas, { facturas: CASA_CON_HUECO, ahora: bogota("2026-08-20T10:00") });
    expect(texto()).toContain("Sin verificar");
    expect(texto()).toContain("Falta el estado de cuenta del mes siguiente para saber si se pagó.");
    /* Un solo "Pendiente" en la lista: el de agosto (más el del resumen). */
    const filas = [...contenedor.querySelectorAll("#facturas .rounded-lg")];
    const junio = filas.find((f) => /junio/i.test(f.textContent));
    expect(junio?.textContent).toContain("Sin verificar");
    expect(junio?.textContent).not.toContain("Pendiente");
  });

  test("el inicio la rotula igual en 'Facturas recientes'", async () => {
    await ver(PortalInicio, { facturas: CASA_CON_HUECO, ahora: bogota("2026-08-20T10:00") });
    expect(texto()).toContain("Sin verificar");
    expect(texto()).toContain("Falta el estado de cuenta del mes siguiente para saber si se pagó.");
  });
});

describe("Mora B · los dos plazos, con texto claro", () => {
  const OCTUBRE = [factura("2026-10", "pendiente", 380_000)];

  test("'Mis facturas': precio completo hasta el 31 y mora desde el 16 del mes siguiente", async () => {
    await ver(MisFacturas, { facturas: OCTUBRE, ahora: bogota("2026-10-20T10:00") });
    expect(texto()).toContain("Precio completo hasta el 31 de octubre de 2026");
    expect(texto()).toContain("En mora desde el 16 de noviembre de 2026");
    expect(texto()).not.toContain("Vencida");
  });

  test("el 5 de noviembre (vencido el plazo, antes del 16) no se pinta mora", async () => {
    await ver(PortalInicio, { facturas: OCTUBRE, ahora: bogota("2026-11-05T10:00") });
    expect(texto()).toContain("Precio completo hasta el 31 de octubre de 2026 · En mora desde el 16 de noviembre de 2026");
    expect(texto()).not.toContain("En mora desde el 16 de noviembre de 2026 ·");
    expect(contenedor.querySelector(".text-red-600")).toBeNull();
  });

  test("el 20 de noviembre sí: 'En mora desde el 16 de noviembre'", async () => {
    await ver(PortalInicio, { facturas: OCTUBRE, ahora: bogota("2026-11-20T10:00") });
    expect(texto()).toContain("En mora desde el 16 de noviembre de 2026");
    expect(contenedor.querySelector(".text-red-600")).not.toBeNull();
  });

  test("una factura vieja (vence el 15) sigue entrando en mora el 16, como siempre", async () => {
    await ver(PortalInicio, {
      facturas: [factura("2026-09", "pendiente", 289_000, { fechaVencimiento: quinceSiguiente("2026-09") })],
      ahora: bogota("2026-10-20T10:00"),
    });
    expect(texto()).toContain("En mora desde el 16 de octubre de 2026");
  });
});

describe("Pasarela en QA · sin 'Pagar' en línea para una unidad real", () => {
  const SEPTIEMBRE = [factura("2026-09", "pendiente", 380_000)];

  test("sin portal del banco: no hay botón 'Pagar' y se dice por qué", async () => {
    await ver(MisFacturas, {
      facturas: SEPTIEMBRE,
      ahora: bogota("2026-09-20T10:00"),
      opciones: { debe: true, pasarela: false, motivo: MENSAJE_QA },
    });
    expect(botonesPagar()).toHaveLength(0);
    expect(texto()).toContain(MENSAJE_QA);
  });

  test("con la pasarela disponible, 'Pagar' aparece como siempre", async () => {
    await ver(MisFacturas, {
      facturas: SEPTIEMBRE,
      ahora: bogota("2026-09-20T10:00"),
      opciones: { debe: true, pasarela: true, motivo: null },
    });
    expect(botonesPagar().length).toBeGreaterThan(0);
    expect(texto()).not.toContain(MENSAJE_QA);
  });

  test("con el portal del banco del conjunto, 'Pagar' abre el portal: la regla de QA no aplica", async () => {
    await ver(MisFacturas, {
      facturas: SEPTIEMBRE,
      ahora: bogota("2026-09-20T10:00"),
      avalPortalUrl: "https://portal.banco.test",
      opciones: { debe: true, pasarela: false, motivo: MENSAJE_QA },
    });
    expect(botonesPagar().length).toBeGreaterThan(0);
  });
});

describe("Reportes · dos cifras de recaudo (F-19)", () => {
  const periodo = (p, extra) => ({
    periodo: p,
    total: 2,
    pagadas: 1,
    pendientes: 1,
    vencidas: 0,
    abonadas: 0,
    sumaTotalAPagar: 650_000,
    sumaPagado: 300_000,
    recaudoContable: null,
    recaudoContableUnidades: 0,
    recaudoContableSinCalcular: { sinSiguiente: 0, mesFaltante: 0, enRevision: 0, noCuadra: 0 },
    recaudoVekino: 0,
    recaudoVekinoPagos: 0,
    recaudoVekinoComprobantes: 0,
    comprobantesSinMonto: 0,
    ...extra,
  });

  test("según la contabilidad y registrado en Vekino, cada una con su nombre; sin el mes siguiente, 'Sin calcular'", async () => {
    setSystemTime(new Date(bogota("2026-10-08T10:00")));
    respuestas = {
      "facturas:serie": [
        periodo("2026-08", { recaudoContable: 650_000, recaudoContableUnidades: 2, recaudoVekino: 0 }),
        periodo("2026-09", {
          recaudoContableSinCalcular: { sinSiguiente: 2, mesFaltante: 0, enRevision: 0, noCuadra: 0 },
          recaudoVekino: 350_000,
          recaudoVekinoPagos: 1,
        }),
      ],
      "unidades:listDetailed": [],
      "memberships:listByCondominio": [],
    };
    await act(() => root.render(createElement(Reportes)));
    expect(texto()).toContain("Recaudo según la contabilidad");
    expect(texto()).toContain("Sin calcular");
    expect(texto()).toContain("Falta cargar el estado de cuenta del mes siguiente");
    expect(texto()).toContain("Registrado en Vekino");
    expect(texto()).toContain("1 pagos en línea · 0 comprobantes");
    expect(texto()).toContain("Recaudo por período");
    expect(texto()).toContain("2 (falta el mes siguiente)");
    /* La suma del total de las pagadas ya no se presenta como recaudo. */
    expect(texto()).not.toContain("Recaudo del mes");
  });
});

describe("Finanzas · la histórica pendiente se ve como 'Sin verificar'", () => {
  test("la fila de junio dice 'Sin verificar' (el backend lo manda en estadoVisible), no 'Pendiente'", async () => {
    setSystemTime(new Date(bogota("2026-10-08T10:00")));
    respuestas = {
      "condominios:adminHome": { allowed: false },
      "facturas:listPeriodos": ["2026-08", "2026-06"],
      "facturas:resumenPeriodo": {
        total: 1, pagadas: 0, pendientes: 1, vencidas: 0, abonadas: 0, saldoAFavorCount: 0,
        sumaTotalAPagar: 300_000, sumaPagado: 0, recaudoContable: null, recaudoContableUnidades: 0,
        recaudoContableSinCalcular: { sinSiguiente: 0, mesFaltante: 1, enRevision: 0, noCuadra: 0 },
        recaudoVekino: 0, recaudoVekinoPagos: 0, recaudoVekinoComprobantes: 0, comprobantesSinMonto: 0,
      },
    };
    paginadas = [
      { ...factura("2026-06", "pendiente", 300_000), residenteNombre: "Residente", apto: "101", numeroInterno: "1", estadoVisible: "sin_verificar" },
    ];
    await act(() => root.render(createElement(Finanzas)));
    const fila = [...contenedor.querySelectorAll("tr")].find((tr) => tr.textContent.includes("FAC-2026-06-101"));
    expect(fila?.textContent).toContain("Sin verificar");
    expect(fila?.textContent).not.toContain("Pendiente");
    expect(texto()).toContain("Recaudo: falta el mes siguiente");
  });
});

describe("Cobros de parqueadero · un cobro por casa, vehículo y mes", () => {
  test("la fila dice el mes del parqueo y cuántos reportes agrupa; el resumen cuenta cobros", async () => {
    setSystemTime(new Date(bogota("2026-10-08T10:00")));
    respuestas = {
      "parqueadero:listar": {
        filas: [
          {
            _id: "r1",
            cargoId: "c1",
            placa: "ABC123",
            descripcion: "carro",
            casas: ["101"],
            casaPorDefinir: false,
            casasNombradas: ["101"],
            periodoParqueo: "2026-09",
            reportes: 3,
            ocurrencias: [bogota("2026-09-17T22:00"), bogota("2026-09-10T22:00"), bogota("2026-09-03T22:00")],
            titulo: "Vehículo sin aporte",
            ocurrioEn: bogota("2026-09-17T22:00"),
            estado: "pendiente",
            monto: 7_000,
            periodo: null,
            cobradoPor: null,
            nota: null,
            mezclado: false,
            fotos: [],
          },
        ],
        resumen: { pendientes: 1, valorPendiente: 7_000, facturados: 0, valorFacturado: 0, descartados: 0, casas: 1, reportes: 3 },
        periodos: [],
        tarifas: { tarifaCarro: 7_000, tarifaMoto: 3_000, mesesParaMora: 2 },
        periodoSugerido: "2026-11",
      },
    };
    await act(() => root.render(createElement(CobrosParqueaderoPanel, { condominioId: "condo-prueba" })));
    expect(texto()).toContain("septiembre de 2026 · 3 reportes");
    expect(texto()).toContain("Casa 101");
    expect(texto()).toContain("Ver historia");
    /* Un cobro de $7.000, no tres. */
    expect(texto()).toMatch(/Por cobrar/);
    expect(texto()).toContain("$ 7.000");
  });
});
