import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

const ventana = new Window({ url: "http://localhost" });
for (const clave of ["window", "document", "HTMLElement", "HTMLInputElement", "HTMLSelectElement", "Event", "MouseEvent", "KeyboardEvent", "FormData", "File", "Blob", "Node", "navigator", "SVGElement"]) {
  Object.defineProperty(globalThis, clave, { configurable: true, value: clave === "window" ? ventana : ventana[clave] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { getFunctionName } = await import("convex/server");

/**
 * "SUBIR FACTURAS" EN CUALQUIER CONJUNTO (Hallazgo 2 de la QA en Factory;
 * ver docs/audits/FALTANTES-WEB-FACTURACION.md).
 *
 * Finanzas mostraba la carga solo si el conjunto tenía `legacyId`, y el botón
 * "Cargar facturas" de la barra superior llevaba a esa misma pantalla vacía.
 * Ahora la carga se ve con la misma fuente de rol del área de administración
 * (`condominios.adminHome.allowed`: administración, contadora y plataforma;
 * la prueba del backend `cargaPorConjunto.test.ts` comprueba qué roles la
 * obtienen) y manda `condominioId`, no `legacyId`.
 *
 * Páginas reales, con las respuestas de Convex simuladas. Proceso propio en
 * `test:facturacion`: simula `convex/react` y `next/navigation` a su manera.
 */

const CONDOMINIO = "j570ttbjpy06q0nnd6k15gnxbx8fxvcz";

let respuestas = {};
mock.module("next/navigation", () => ({ useParams: () => ({ id: CONDOMINIO }) }));
mock.module("next/link", () => ({
  default: ({ href, children, prefetch: _p, ...props }) => createElement("a", { ...props, href }, children),
}));
mock.module("convex/react", () => ({
  useQuery: (fn, args) => (args === "skip" ? undefined : respuestas[getFunctionName(fn)]),
  usePaginatedQuery: () => ({ results: [], status: "Exhausted", loadMore: () => {} }),
  useAction: () => async () => null,
  useMutation: () => async () => {},
}));
/* La sesión del cliente oficial, que la carga manda en Better-Auth-Cookie
 * (lib/fetch-con-sesion.ts). */
const SESION = "better-auth.session_token=sesion-de-prueba";
mock.module("@/lib/auth-client", () => ({ authClient: { getCookie: () => SESION } }));
const { AdminTopbarProvider, useTopbarOverride } = await import("../components/layout/admin-topbar-context");
const { default: Finanzas } = await import("../app/condominio/[id]/finanzas/page");
const { default: InicioConjunto } = await import("../app/condominio/[id]/page");

/** La barra superior: pinta las acciones que registra la página, como `AdminTopbar`. */
function Barra() {
  return createElement("header", null, useTopbarOverride());
}

/** Lo que responde `condominios.adminHome` a quien entra al área de administración. */
const homeDe = (myRoles, isPlatform = false) => ({
  allowed: true,
  isPlatform,
  userName: "Persona de prueba",
  userImage: null,
  myRoles,
  condominio: {
    _id: CONDOMINIO,
    name: "Factory",
    city: null,
    nit: null,
    logo: null,
    coverImage: null,
    primaryColor: null,
    subscriptionPlan: "basico",
    isActive: true,
    legacyId: null,
    legacyDatabaseName: null,
  },
});

let contenedor, root, peticiones;
beforeEach(() => {
  peticiones = [];
  globalThis.fetch = async (url, init) => {
    peticiones.push({ url, body: init?.body, headers: new Headers(init?.headers) });
    return { ok: true, status: 200, json: async () => ({ hash: "a".repeat(64), invoices: [], noLeidas: [] }) };
  };
  contenedor = document.createElement("div");
  document.body.append(contenedor);
  root = createRoot(contenedor);
});
afterEach(async () => {
  await act(() => root.unmount());
  contenedor.remove();
  respuestas = {};
});

async function ver(Pagina, home) {
  respuestas = {
    "condominios:adminHome": home,
    "facturas:listPeriodos": [],
    "unidades:listByCondominio": [],
  };
  await act(() =>
    root.render(createElement(AdminTopbarProvider, null, createElement(Barra), createElement(Pagina))),
  );
}
const barra = () => contenedor.querySelector("header");
const subirFacturas = () =>
  [...barra().querySelectorAll("button")].find((b) => b.textContent.trim() === "Subir facturas");

describe("Finanzas · 'Subir facturas' en un conjunto sin legacyId", () => {
  test.each([
    ["la administración", homeDe(["administrador"])],
    ["la contadora", homeDe(["contadora"])],
    ["el staff de plataforma", homeDe([], true)],
  ])("%s la ve", async (_quien, home) => {
    await ver(Finanzas, home);
    expect(subirFacturas()).toBeTruthy();
  });

  test("los demás roles no la ven (adminHome no les abre el área de administración)", async () => {
    await ver(Finanzas, { allowed: false });
    expect(barra().textContent).not.toContain("Subir facturas");
  });

  test("mientras adminHome carga, tampoco", async () => {
    await ver(Finanzas, undefined);
    expect(barra().textContent).not.toContain("Subir facturas");
  });

  test("la vista previa manda el condominioId, no un legacyId", async () => {
    await ver(Finanzas, homeDe(["contadora"]));
    await act(async () => subirFacturas().click());
    const input = document.body.querySelector('input[type="file"]');
    const pdf = new File([new Uint8Array([37, 80, 68, 70])], "septiembre.pdf", { type: "application/pdf" });
    Object.defineProperty(input, "files", { configurable: true, value: [pdf] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));

    expect(peticiones.map((p) => p.url)).toEqual(["/api/facturas/upload"]);
    expect(peticiones[0].headers.get("better-auth-cookie")).toBe(SESION);
    const form = peticiones[0].body;
    expect(form.get("condominioId")).toBe(CONDOMINIO);
    expect(form.get("condominioLegacyId")).toBeNull();
  });
});

describe("'Cargar facturas' de la barra superior lleva a donde la carga funciona", () => {
  test("desde el inicio del conjunto va a Finanzas, que tiene 'Subir facturas'", async () => {
    await ver(InicioConjunto, undefined);
    const enlace = [...barra().querySelectorAll("a")].find((a) => a.textContent.includes("Cargar facturas"));
    expect(enlace?.getAttribute("href")).toBe(`/condominio/${CONDOMINIO}/finanzas`);

    await act(() => root.unmount());
    root = createRoot(contenedor);
    await ver(Finanzas, homeDe(["administrador"]));
    expect(subirFacturas()).toBeTruthy();
  });
});
