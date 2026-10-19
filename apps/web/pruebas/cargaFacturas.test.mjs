import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

const ventana = new Window({ url: "http://localhost" });
for (const clave of ["window", "document", "HTMLElement", "HTMLInputElement", "HTMLSelectElement", "Event", "MouseEvent", "KeyboardEvent", "FormData", "File", "Blob", "Node", "navigator"]) {
  Object.defineProperty(globalThis, clave, { configurable: true, value: clave === "window" ? ventana : ventana[clave] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { getFunctionName } = await import("convex/server");
const { MENSAJE_LECTURA } = await import("@vekino/backend/lecturaFactura");

/**
 * PANTALLA DE CARGA DE FACTURAS (Finanzas → "Subir facturas"), Fase 2 de la
 * auditoría de facturación (docs/audits/FASE-2-FACTURACION.md).
 *
 * Monta el componente REAL. Lo único simulado son las unidades del conjunto y
 * las respuestas de las dos rutas: la vista previa (`/api/facturas/upload`) y
 * la confirmación (`/api/facturas/confirmar`).
 *
 *   · la vista previa muestra, por factura, el período del documento, el
 *     saldo anterior, el total y si cuadra; y el resumen del lote;
 *   · el período sale de los documentos, y un lote contradictorio se bloquea;
 *   · confirmar manda el MISMO archivo con su huella; lo que se muestra al
 *     final es lo que devolvió el backend.
 */

const UNIDADES = [
  { _id: "u999", numero: "999", torre: null },
  { _id: "u998", numero: "998", torre: null },
];
mock.module("convex/react", () => ({
  useQuery: (fn) => (getFunctionName(fn) === "unidades:listByCondominio" ? UNIDADES : undefined),
}));
/* La sesión del cliente oficial. Las dos rutas la reciben en la cabecera
 * Better-Auth-Cookie (lib/fetch-con-sesion.ts): en el dominio de la app no
 * hay cookie de sesión. */
const SESION = "better-auth.session_token=sesion-de-prueba";
let cookieSesion;
mock.module("@/lib/auth-client", () => ({ authClient: { getCookie: () => cookieSesion } }));
const { UploadFacturas } = await import("../components/upload-facturas");

const HUELLA = "a".repeat(64);
const factura = (casa, periodo, total, extra = {}) => ({
  format: "cdc",
  unitIdentifier: casa,
  residenteNombre: "RESIDENTE DE PRUEBA",
  numeroInterno: "90001",
  periodoLabel: periodo ? "Septiembre / 2026" : "",
  periodoDocumento: periodo,
  totalAPagar: total,
  lineas: [{ saldoAnterior: 0, total }],
  motivos: [],
  pageCount: 1,
  ...extra,
});
const LOTE = [
  factura("999", "2026-09", 5_705_200, { saldoAnteriorDocumento: 5_298_200, pageCount: 2 }),
  factura("998", "2026-09", 3_609_800, { motivos: ["total_no_leido"] }),
  factura("555", "2026-09", 335_000),
];

let peticiones, vistaPrevia, confirmacion, alertas, contenedor, root;
beforeEach(() => {
  peticiones = [];
  alertas = [];
  cookieSesion = SESION;
  vistaPrevia = { status: 200, cuerpo: { hash: HUELLA, invoices: LOTE, noLeidas: [] } };
  confirmacion = { status: 200, cuerpo: {} };
  globalThis.alert = (mensaje) => alertas.push(mensaje);
  globalThis.fetch = async (url, init) => {
    peticiones.push({ url, body: init?.body, headers: new Headers(init?.headers) });
    const r = url === "/api/facturas/upload" ? vistaPrevia : confirmacion;
    /* `sinJson`: lo que responde la plataforma (Vercel) a un archivo demasiado
     * grande, antes de llegar a la ruta: un 413 que no es JSON. */
    return {
      ok: r.status < 400,
      status: r.status,
      json: async () => {
        if (r.sinJson) throw new SyntaxError("Unexpected token R in JSON at position 0");
        return r.cuerpo;
      },
    };
  };
  contenedor = document.createElement("div");
  document.body.append(contenedor);
  root = createRoot(contenedor);
});
afterEach(async () => {
  await act(() => root.unmount());
  contenedor.remove();
});

const pantalla = () => document.body.textContent.replace(/\s+/g, " ");
const boton = (texto) => [...document.body.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith(texto));
async function click(el) {
  expect(el).toBeTruthy();
  await act(async () => el.click());
}
const esperar = () => act(async () => await new Promise((r) => setTimeout(r, 0)));

/** Abre el modal y elige el PDF: la pantalla pide la vista previa. */
async function elegirPdf() {
  await act(() => root.render(createElement(UploadFacturas, { condominioId: "condo-1", condominioLegacyId: "legacy-1", onDone: () => {} })));
  await click(boton("Subir facturas"));
  const input = document.body.querySelector('input[type="file"]');
  const pdf = new File([new Uint8Array([37, 80, 68, 70])], "septiembre.pdf", { type: "application/pdf" });
  Object.defineProperty(input, "files", { configurable: true, value: [pdf] });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
  await esperar();
  return pdf;
}

/** Los cuatro números del resumen del lote, en orden: leídas, entran, en revisión, no entran. */
function resumen() {
  const etiquetas = ["leídas", "entran", "entran en revisión", "no entran"];
  return etiquetas.map((e) => {
    const p = [...document.body.querySelectorAll("p")].find((x) => x.textContent === e);
    return Number(p?.previousElementSibling?.textContent);
  });
}

describe("vista previa: nada se publica ni se guarda", () => {
  test("el período sale de los documentos y cada factura muestra su lectura", async () => {
    await elegirPdf();
    expect(peticiones.map((p) => p.url)).toEqual(["/api/facturas/upload"]);
    expect(peticiones[0].headers.get("better-auth-cookie")).toBe(SESION);
    expect(resumen()).toEqual([3, 1, 1, 1]);
    expect(document.body.querySelector("select").value).toBe("2026-09");
    expect(pantalla()).toContain("según los documentos: Septiembre / 2026");
    expect(pantalla()).toContain("cuadra");
    expect(pantalla()).toContain(`en revisión: ${MENSAJE_LECTURA.total_no_leido}`);
    expect(pantalla()).toContain("sin unidad");
    expect(pantalla()).toContain("1 factura no cuadra con su documento");
    // Saldo anterior de la fila Totales, no la suma de las líneas
    expect(pantalla()).toMatch(/5\.298\.200/);
    expect(boton("Confirmar").disabled).toBe(false);
    expect(boton("Confirmar").textContent).toContain("Confirmar 2 facturas");
  });

  test("documentos de dos períodos: el lote se bloquea y dice por qué", async () => {
    vistaPrevia.cuerpo.invoices = [LOTE[0], factura("998", "2026-10", 300_000)];
    await elegirPdf();
    expect(pantalla()).toContain("Los documentos son de períodos distintos (Septiembre / 2026, Octubre / 2026)");
    expect(boton("Confirmar").disabled).toBe(true);
  });

  test("elegir otro período que el del documento también bloquea", async () => {
    await elegirPdf();
    const select = document.body.querySelector("select");
    await act(async () => {
      select.value = "2026-08";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(pantalla()).toContain("El documento es de Septiembre / 2026 y el período elegido es Agosto / 2026");
    expect(boton("Confirmar").disabled).toBe(true);
  });

  test("sin período legible en los documentos, hay que elegirlo", async () => {
    vistaPrevia.cuerpo.invoices = [factura("999", null, 335_000, { motivos: ["periodo_no_leido"] })];
    await elegirPdf();
    expect(pantalla()).toContain("Elige el período");
    expect(boton("Confirmar").disabled).toBe(true);
  });
});

describe("confirmar", () => {
  test("manda el mismo archivo con su huella, el período y las unidades; muestra lo que devolvió el backend", async () => {
    const pdf = await elegirPdf();
    confirmacion.cuerpo = {
      tipo: "nueva",
      insertadas: 1,
      actualizadas: 0,
      omitidas: 0,
      marcadas: 1,
      rechazadas: 1,
      rechazos: [{ indice: 2, motivo: "sin_unidad" }],
      conciliacion: { pagadas: 1, abonadas: 0, vencidas: 0 },
      publicadas: 2,
    };
    await click(boton("Confirmar"));
    await esperar();

    const envio = peticiones.find((p) => p.url === "/api/facturas/confirmar");
    expect(envio).toBeTruthy();
    expect(envio.headers.get("better-auth-cookie")).toBe(SESION);
    expect(envio.body.get("pdf")).toBe(pdf);
    expect(envio.body.get("hash")).toBe(HUELLA);
    expect(envio.body.get("periodo")).toBe("2026-09");
    expect(envio.body.get("soloNuevas")).toBe("true");
    expect(JSON.parse(envio.body.get("asignaciones"))).toEqual([
      { indice: 0, unidadId: "u999" },
      { indice: 1, unidadId: "u998" },
    ]);

    expect(pantalla()).toContain("¡Facturas cargadas!");
    expect(pantalla()).toContain("1 nuevas · 1 en revisión · 1 no entraron");
    expect(pantalla()).toContain("1 · No se encontró la unidad en el conjunto.");
    expect(pantalla()).toContain("1 factura anterior marcada como pagada");
  });

  test("un archivo que ya se había cargado lo dice, sin prometer nada nuevo", async () => {
    await elegirPdf();
    confirmacion.cuerpo = { tipo: "repetida", insertadas: 2, actualizadas: 0, omitidas: 0, marcadas: 0, rechazadas: 0, rechazos: [], publicadas: 0 };
    await click(boton("Confirmar"));
    await esperar();
    expect(pantalla()).toContain("Este archivo ya se había cargado");
    expect(pantalla()).toContain("No se publicó ni se guardó nada otra vez.");
  });

  /*
   * Auditoría en Factory (2026-10-13): un lote en el que no entró ninguna
   * factura (5 rechazadas por período) mostraba "¡Facturas cargadas!" con el
   * visto verde, y debajo "0 nuevas · 5 no entraron".
   */
  test.each([
    ["todas rechazadas", { rechazadas: 2, rechazos: [{ indice: 0, motivo: "periodo_no_coincide" }, { indice: 1, motivo: "periodo_no_coincide" }] }, "0 nuevas · 2 no entraron"],
    ["todas omitidas (ya existían)", { omitidas: 2 }, "0 nuevas · 2 omitidas"],
  ])("si no entró ninguna factura (%s), no dice que se cargaron", async (_caso, cuerpo, detalle) => {
    await elegirPdf();
    confirmacion.cuerpo = { tipo: "nueva", insertadas: 0, actualizadas: 0, omitidas: 0, marcadas: 0, rechazadas: 0, rechazos: [], conciliacion: { pagadas: 0, abonadas: 0, vencidas: 0 }, publicadas: 0, ...cuerpo };
    await click(boton("Confirmar"));
    await esperar();
    expect(pantalla()).not.toContain("¡Facturas cargadas!");
    expect(pantalla()).toContain("No se cargó ninguna factura");
    expect(pantalla()).toContain(detalle);
  });

  test("si la confirmación falla, se ve el motivo y se puede reintentar", async () => {
    await elegirPdf();
    confirmacion = { status: 409, cuerpo: { error: "El archivo no es el mismo de la vista previa. Vuelve a seleccionarlo." } };
    await click(boton("Confirmar"));
    await esperar();
    expect(pantalla()).toContain("El archivo no es el mismo de la vista previa");
    expect(boton("Confirmar").disabled).toBe(false);
  });
});

describe("la sesión viaja a las dos rutas, y la ruta decide", () => {
  test("sin sesión guardada, la vista previa sale sin la cabecera y se ve el rechazo del servidor", async () => {
    cookieSesion = "";
    vistaPrevia = { status: 401, cuerpo: { error: "Inicia sesión para subir facturas." } };
    await elegirPdf();
    expect(peticiones).toHaveLength(1);
    expect(peticiones[0].headers.has("better-auth-cookie")).toBe(false);
    expect(alertas).toEqual(["Error procesando PDF: Inicia sesión para subir facturas."]);
    // Vuelve a pedir el archivo: no se queda cargando.
    expect(pantalla()).toContain("Haz clic para seleccionar el PDF");
  });

  test("una confirmación sin permiso muestra el motivo, no da la carga por hecha y no expone la sesión", async () => {
    await elegirPdf();
    confirmacion = { status: 403, cuerpo: { error: "No tienes permiso para subir facturas de este conjunto." } };
    await click(boton("Confirmar"));
    await esperar();
    expect(peticiones.map((p) => p.headers.get("better-auth-cookie"))).toEqual([SESION, SESION]);
    expect(pantalla()).toContain("No tienes permiso para subir facturas de este conjunto.");
    expect(pantalla()).not.toContain("¡Facturas cargadas!");
    expect(pantalla()).not.toContain("sesion-de-prueba");
    expect(boton("Confirmar").disabled).toBe(false);
  });
});

describe("Fase 6 · un archivo que la plataforma no admite (413 que no es JSON)", () => {
  test("en la vista previa: un aviso que dice qué hacer, no un error de JSON", async () => {
    vistaPrevia = { status: 413, sinJson: true };
    await elegirPdf();
    expect(alertas.join(" ")).toContain("demasiado grande para cargarlo de una vez");
    expect(alertas.join(" ")).not.toMatch(/Unexpected token|JSON/);
  });

  test("en la confirmación: se ve el motivo y se puede reintentar", async () => {
    await elegirPdf();
    confirmacion = { status: 413, sinJson: true };
    await click(boton("Confirmar"));
    await esperar();
    expect(pantalla()).toContain("demasiado grande para cargarlo de una vez");
    expect(pantalla()).not.toMatch(/Unexpected token/);
    expect(boton("Confirmar").disabled).toBe(false);
  });
});
