import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from "bun:test";
import { Window } from "happy-dom";
const ventana = new Window({ url: "http://localhost" });
for (const clave of ["window", "document", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLFormElement", "Event", "MouseEvent", "KeyboardEvent", "Node", "navigator", "SVGElement", "localStorage"]) Object.defineProperty(globalThis, clave, { configurable: true, value: clave === "window" ? ventana : ventana[clave] });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { getFunctionName } = await import("convex/server");

/**
 * LO QUE VE EL RESIDENTE — hallazgos del QA de comprobantes
 * (docs/qa/QA-FACTORY-COMPROBANTES.md, defectos 2, 3, 4 y 6):
 *
 *   · H1: con un abono aprobado de $200.000 sobre $335.000, el inicio, el
 *     resumen, la tarjeta, la fila y la sugerencia de "Ya pagué" dicen
 *     $135.000 (antes, $335.000 en todos);
 *   · H2: la vigente sin pagar de una unidad en mora es "Vencida" en el
 *     resumen, la tarjeta y la fila (antes la fila decía "Pendiente");
 *   · H3: sin una casa vinculada hoy no se dice "Estás al día", no se ofrece
 *     "Autorizar visitante" y "Mi unidad" pide sus vehículos al backend;
 *   · H5: el aviso de la pasarela es un párrafo en su propia línea de la fila
 *     de acciones (antes, un `span` en línea que desbordaba la fila).
 *
 * Páginas reales con el servidor simulado (`convex/react`). Proceso propio:
 * simula respuestas que las demás suites no conocen.
 */

const bogota = (local) => Date.parse(`${local}:00-05:00`);
const HOY = bogota("2026-10-09T10:00");

function finDeMes(periodo) {
  const [a, m] = periodo.split("-").map(Number);
  return Date.UTC(a, m, 0, 5);
}

function factura(periodo, estado, totalAPagar, extra = {}) {
  return {
    _id: `f-${periodo}`,
    unidadId: "u103",
    numeroFactura: `FAC-${periodo}-103`,
    periodo,
    periodoLabel: periodo,
    estado,
    totalAPagar,
    totalConDescuento: totalAPagar - 40_000,
    saldoAFavor: 0,
    fechaVencimiento: finDeMes(periodo),
    lineas: [{ codigo: 1, concepto: "Administración", saldoAnterior: 0, actual: totalAPagar, total: totalAPagar }],
    unidadNumero: "103",
    unidadTipo: "casa",
    unidadTorre: null,
    ...extra,
  };
}

const abono = (montoPagado) => ({ estado: "abonada", montoPagado, montoAdeudado: 335_000, conDescuento: false, actualizadoAt: 0 });

const MENSAJE_QA =
  "El pago en línea todavía no está habilitado: la pasarela está en modo de pruebas. Paga por los canales habituales del conjunto y, si quieres, envía el comprobante."; // lib/avalProduccion.ts

const UNIDAD_103 = { _id: "u103", numero: "103", torre: null, bloque: null, tipo: "casa", estado: "ocupada", coeficiente: null, vinculo: "propietario", esPrincipal: true };

function home(unidades, extra = {}) {
  return {
    allowed: true,
    isPlatform: false,
    userId: "residente",
    userName: "Residente de prueba",
    userImage: null,
    userEmail: "residente@vekino.test",
    myRoles: ["propietario"],
    membershipId: "m-residente",
    unidades,
    condominio: { _id: "condo-prueba", name: "Factory", city: null, address: null, nit: null, logo: null, coverImage: null, primaryColor: null, avalPortalUrl: null },
    ...extra,
  };
}

let respuestas, consultas, contenedor, root;

mock.module("next/navigation", () => ({ useParams: () => ({ id: "condo-prueba" }), usePathname: () => "/mi/condo-prueba" }));
mock.module("next/link", () => ({ default: ({ href, children, prefetch: _p, ...props }) => createElement("a", { ...props, href }, children) }));
mock.module("convex/react", () => ({
  useQuery: (fn, args) => {
    const nombre = getFunctionName(fn);
    consultas.push(nombre);
    if (args === "skip") return undefined;
    return respuestas[nombre];
  },
  usePaginatedQuery: () => ({ results: respuestas.paginadas ?? [], status: "Exhausted", loadMore: () => {} }),
  useAction: () => async () => ({ pagoId: "pago-prueba", redirectUrl: "https://pasarela.test" }),
  useMutation: () => async () => null,
}));
/* Finanzas monta la carga de facturas, que lee la sesión del cliente oficial. */
mock.module("@/lib/auth-client", () => ({ authClient: { getCookie: () => "" } }));
globalThis.alert = () => {};

const { default: MisFacturas } = await import("../app/mi/[id]/cuenta/page");
const { default: PortalInicio } = await import("../app/mi/[id]/page");
const { default: Visitantes } = await import("../app/mi/[id]/visitantes/page");
const { default: MiUnidad } = await import("../app/mi/[id]/unidad/page");
const { default: Reservas } = await import("../app/mi/[id]/reservas/page");
const { default: MisVehiculos } = await import("../app/mi/[id]/vehiculos/page");
const { default: Finanzas } = await import("../app/condominio/[id]/finanzas/page");

beforeEach(() => {
  consultas = [];
  respuestas = {
    "portal:home": home([UNIDAD_103]),
    "portal:misActividades": { reservasActivas: [], ticketsAbiertos: 0 },
    "comunicados:listRecent": [],
    "pagos:opcionesDePago": { debe: true, pasarela: false, motivo: MENSAJE_QA },
    "soportesPago:listMios": [],
  };
  contenedor = document.createElement("div");
  document.body.append(contenedor);
  root = createRoot(contenedor);
});

afterEach(async () => {
  await act(() => root.unmount());
  contenedor.remove();
  setSystemTime();
});

async function ver(Pagina, facturas, ahora = HOY) {
  setSystemTime(new Date(ahora));
  respuestas["facturas:listMia"] = facturas;
  await act(() => root.render(createElement(Pagina)));
}

const texto = () => contenedor.textContent.replace(/ /g, " ").replace(/\s+/g, " ");
/** Elementos cuyo texto PROPIO (sin el de sus hijos, p. ej. un ícono) es exactamente `t`. */
const exactos = (t) =>
  [...contenedor.querySelectorAll("*")].filter(
    (el) =>
      [...el.childNodes]
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent)
        .join("")
        .replace(/ /g, " ")
        .trim() === t,
  );

// ─── H1 ──────────────────────────────────────────────────────────────────────

describe("H1 · un abono aprobado baja lo que se ve por pagar", () => {
  const AGOSTO_ABONADO = [factura("2026-08", "abonada", 335_000, { estadoPago: abono(200_000) })];

  test("'Mis facturas': resumen, tarjeta y fila dicen $135.000, con lo abonado a la vista", async () => {
    await ver(MisFacturas, AGOSTO_ABONADO);
    /* Resumen ("Estado actual"), tarjeta ("Factura pendiente") y fila. */
    expect(exactos("$ 135.000").length).toBe(3);
    expect(exactos("$ 335.000")).toHaveLength(0);
    expect(texto()).toContain("Abonado $ 200.000 de $ 335.000");
  });

  test("inicio: 'Total pendiente: $ 135.000' y la fila con lo que falta", async () => {
    await ver(PortalInicio, AGOSTO_ABONADO);
    expect(texto()).toContain("Total pendiente: $ 135.000");
    expect(texto()).toContain("Abonado $ 200.000 de $ 335.000");
    expect(exactos("$ 135.000").length).toBe(1);
  });

  test("'Ya pagué' sugiere lo que falta, no el total", async () => {
    await ver(MisFacturas, AGOSTO_ABONADO);
    const boton = [...contenedor.querySelectorAll("button")].find((b) => b.textContent.includes("Ya pagué"));
    await act(async () => boton.click());
    const monto = contenedor.querySelector("input[name='monto']");
    expect(monto.value).toBe("135.000");
  });

  test("con el descuento vigente: se cobra el valor con descuento menos lo abonado, y 'Después' es lo que falta del total", async () => {
    const septiembre = [factura("2026-09", "abonada", 335_000, { estadoPago: abono(200_000) })];
    await ver(PortalInicio, septiembre, bogota("2026-09-10T10:00"));
    expect(texto()).toContain("Total pendiente: $ 95.000");
    expect(texto()).toContain("Después $ 135.000");
    await act(() => root.unmount());
    root = createRoot(contenedor);
    await ver(MisFacturas, septiembre, bogota("2026-09-10T10:00"));
    expect(texto()).toContain("Después: $ 135.000");
  });

  test("un comprobante sin aprobar no descuenta nada", async () => {
    await ver(MisFacturas, [factura("2026-08", "pendiente", 335_000)], bogota("2026-09-10T10:00"));
    expect(texto()).not.toContain("Abonado");
    expect(exactos("$ 335.000").length).toBeGreaterThan(0);
  });
});

// ─── H2 ──────────────────────────────────────────────────────────────────────

describe("H2 · la vigente en mora es 'Vencida' en todas partes", () => {
  const AGOSTO_SIN_PAGAR = [factura("2026-08", "pendiente", 335_000)];

  test("'Mis facturas': resumen, tarjeta y fila dicen 'Vencida' (antes la fila decía 'Pendiente')", async () => {
    await ver(MisFacturas, AGOSTO_SIN_PAGAR);
    expect(exactos("Vencida").length).toBe(3);
    expect(exactos("Pendiente")).toHaveLength(0);
  });

  test("inicio: 'En mora desde…' y la fila 'Vencida'", async () => {
    await ver(PortalInicio, AGOSTO_SIN_PAGAR);
    expect(texto()).toContain("En mora desde el 16 de septiembre de 2026");
    expect(exactos("Vencida").length).toBe(1);
    expect(exactos("Pendiente")).toHaveLength(0);
  });

  test("dentro del plazo sigue 'Pendiente' en todas partes", async () => {
    await ver(MisFacturas, AGOSTO_SIN_PAGAR, bogota("2026-09-10T10:00"));
    expect(exactos("Vencida")).toHaveLength(0);
    expect(exactos("Pendiente").length).toBe(3);
  });

  test("Finanzas pinta la fila como la manda el backend (`estadoVisible: vencida`) y cuenta 1 vencida", async () => {
    respuestas["condominios:adminHome"] = { allowed: false };
    respuestas["facturas:listPeriodos"] = ["2026-08"];
    respuestas["facturas:resumenPeriodo"] = {
      total: 1, pagadas: 0, pendientes: 0, vencidas: 1, abonadas: 0, saldoAFavorCount: 0,
      sumaTotalAPagar: 335_000, sumaPagado: 0, recaudoContable: null, recaudoContableUnidades: 0,
      recaudoContableSinCalcular: { sinSiguiente: 1, mesFaltante: 0, enRevision: 0, noCuadra: 0, siguienteManual: 0 },
      recaudoVekino: 0, recaudoVekinoPagos: 0, recaudoVekinoComprobantes: 0, comprobantesSinMonto: 0,
    };
    respuestas.paginadas = [
      { ...AGOSTO_SIN_PAGAR[0], residenteNombre: "Residente", apto: "103", numeroInterno: "1", estadoVisible: "vencida" },
    ];
    await ver(Finanzas, []);
    const fila = [...contenedor.querySelectorAll("tr")].find((tr) => tr.textContent.includes("FAC-2026-08-103"));
    expect(fila?.textContent).toContain("Vencida");
    expect(fila?.textContent).not.toContain("Pendiente");
    /* El indicador: la etiqueta "Vencidas" y, justo debajo, su valor. */
    const etiqueta = exactos("Vencidas")[0];
    expect(etiqueta?.nextElementSibling?.textContent).toBe("1");
  });
});

// ─── H3 ──────────────────────────────────────────────────────────────────────

describe("H3 · sin una casa vinculada hoy", () => {
  beforeEach(() => {
    respuestas["portal:home"] = home([]);
  });

  test("el inicio no dice 'Estás al día': dice que no tiene unidad vinculada", async () => {
    await ver(PortalInicio, []);
    expect(texto()).toContain("No tienes una unidad vinculada");
    expect(texto()).not.toContain("Estás al día");
  });

  test("'Mis facturas' tampoco", async () => {
    await ver(MisFacturas, []);
    expect(texto()).toContain("No tienes una unidad vinculada");
    expect(texto()).not.toContain("Estás al día");
    expect(exactos("Al día")).toHaveLength(0);
  });

  test("'Visitantes' no ofrece 'Autorizar visitante'", async () => {
    respuestas["visitantes:listMios"] = [];
    await ver(Visitantes, []);
    expect(texto()).not.toContain("Autorizar visitante");
    expect(texto()).toContain("No tienes una unidad vinculada");
  });

  test("'Mis reservas' y 'Mis vehículos' tampoco ofrecen crear sin casa (el backend ya lo rechazaba)", async () => {
    respuestas["reservas:listZonas"] = [{ _id: "z1", nombre: "Salón social", activa: true }];
    respuestas["reservas:listMias"] = [];
    respuestas["vehiculos:listMios"] = [];
    await ver(Reservas, []);
    expect(texto()).not.toContain("Nueva reserva");
    expect(texto()).toContain("No tienes una unidad vinculada");
    await act(() => root.unmount());
    root = createRoot(contenedor);
    await ver(MisVehiculos, []);
    expect(texto()).not.toContain("Registrar primer vehículo");
    expect(texto()).toContain("No tienes una unidad vinculada");

    /* Con la casa vigente, como siempre. */
    respuestas["portal:home"] = home([UNIDAD_103]);
    await act(() => root.unmount());
    root = createRoot(contenedor);
    await ver(Reservas, []);
    expect(texto()).toContain("Nueva reserva");
    await act(() => root.unmount());
    root = createRoot(contenedor);
    await ver(MisVehiculos, []);
    expect(texto()).toContain("Registrar primer vehículo");
  });

  test("con la casa vigente, todo sigue igual: 'Autorizar visitante' y 'Estás al día'", async () => {
    respuestas["portal:home"] = home([UNIDAD_103]);
    respuestas["visitantes:listMios"] = [];
    await ver(Visitantes, []);
    expect(texto()).toContain("Autorizar visitante");
    await act(() => root.unmount());
    root = createRoot(contenedor);
    await ver(PortalInicio, [factura("2026-08", "pagada", 335_000)]);
    expect(texto()).toContain("Estás al día");
  });

  test("el staff de plataforma (sin casa por definición) no ve el aviso de 'sin unidad'", async () => {
    respuestas["portal:home"] = home([], { isPlatform: true });
    await ver(PortalInicio, []);
    expect(texto()).not.toContain("No tienes una unidad vinculada");
  });

  test("'Mi unidad' pide sus vehículos al backend (`vehiculos.listMios`, con vigencia), no los de todo el conjunto", async () => {
    respuestas["portal:home"] = home([UNIDAD_103]);
    respuestas["vehiculos:listMios"] = [{ _id: "v1", placa: "ABC123", tipo: "carro", unidadNumero: "103", unidadId: "u103" }];
    respuestas["hogar:miHogar"] = null;
    respuestas["portal:misPaquetes"] = [];
    await ver(MiUnidad, []);
    expect(consultas).toContain("vehiculos:listMios");
    expect(consultas).not.toContain("vehiculos:listByCondominio");
    expect(texto()).toContain("ABC123");
  });
});

// ─── H5 ──────────────────────────────────────────────────────────────────────

describe("H5 · el aviso de la pasarela en la fila de 'Mis facturas'", () => {
  test("es un párrafo que va en su propia línea de la fila de acciones, no un span en línea", async () => {
    await ver(MisFacturas, [factura("2026-09", "pendiente", 335_000)]);
    const avisos = [...contenedor.querySelectorAll("#facturas *")].filter(
      (el) => el.children.length === 0 && el.textContent === MENSAJE_QA,
    );
    expect(avisos).toHaveLength(1);
    const [aviso] = avisos;
    expect(aviso.tagName).toBe("P");
    expect(aviso.className).toContain("basis-full");
    /* Hijo directo (el envoltorio es `display: contents`) de una fila de
     * acciones que hace salto de línea y no pasa del 60 % de la fila. */
    const acciones = aviso.parentElement.parentElement;
    expect(aviso.parentElement.className).toContain("contents");
    expect(acciones.className).toContain("flex-wrap");
    expect(acciones.className).toContain("sm:max-w-[60%]");
  });
});
