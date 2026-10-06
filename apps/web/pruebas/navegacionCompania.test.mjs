import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
const ventana = new Window({ url: "http://localhost" });
for (const clave of ["window", "document", "HTMLElement", "HTMLInputElement", "Event", "KeyboardEvent", "MouseEvent", "Node", "navigator", "localStorage"]) Object.defineProperty(globalThis, clave, { configurable: true, value: clave === "window" ? ventana : ventana[clave] });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { getFunctionName } = await import("convex/server");

/**
 * NAVEGACIÓN DEL PERSONAL DE COMPAÑÍA, DE PUNTA A PUNTA (QA-004).
 *
 * Monta los shells reales (`VigilanciaShell` para `/vigilancia`,
 * `DashboardShell` para `/dashboard`) y la página real de la compañía sobre un
 * router mínimo: un clic en un enlace o un `router.replace` cambia la URL y
 * vuelve a montar el layout que le toca a la ruta nueva, como hace Next. Así
 * se siguen las redirecciones del shell hasta que la URL se queda quieta, y lo
 * que se comprueba es DÓNDE termina el usuario y QUÉ página tiene delante, no
 * qué condiciones hay escritas en el código.
 *
 * Lo único simulado es la sesión (`users.me`) y las respuestas del servidor.
 */

let me, ubicacion, historial, consultas, contenedor, root;
const LIMITE_SALTOS = 15;

const router = { replace: (href) => navegar(href), push: (href) => navegar(href), back() {}, refresh() {}, prefetch() {} };
mock.module("next/navigation", () => ({
  usePathname: () => ubicacion.pathname,
  useSearchParams: () => ubicacion.searchParams,
  useParams: () => ({ id: ubicacion.pathname.split("/")[3] }),
  useRouter: () => router,
}));
mock.module("next/link", () => ({
  default: ({ href, children, onClick, prefetch: _p, scroll: _s, ...props }) =>
    createElement("a", { ...props, href, onClick: (e) => { onClick?.(e); e.preventDefault(); navegar(href); } }, children),
}));
mock.module("next/image", () => ({ default: ({ src, alt }) => createElement("img", { src, alt }) }));
mock.module("@/lib/auth-client", () => ({ authClient: { signOut: async () => {} } }));
mock.module("convex/react", () => ({
  Authenticated: ({ children }) => children,
  Unauthenticated: () => null,
  AuthLoading: () => null,
  useQuery: (fn, args) => {
    const nombre = getFunctionName(fn);
    consultas.push({ nombre, args });
    return args === "skip" ? undefined : responder(nombre, args);
  },
  useMutation: () => async () => "u",
  useAction: () => async () => null,
}));

/** Lo que respondería el servidor a la sesión simulada. */
function responder(nombre, args) {
  if (nombre === "users:me" || nombre === "users:meOperativo") return me;
  if (nombre === "companias:miCompania") return me.compania;
  if (nombre === "asignaciones:miEquipo") {
    return me.asignaciones.filter((a) => a.rol === "supervisor").map((a) => ({ condominioId: a.condominioId, condominioNombre: a.condominioNombre }));
  }
  if (nombre === "companias:detail") {
    return { compania: { _id: args.companiaId, nombre: "Seguridad Andina", estado: "activa", nit: null, contactoEmail: null }, personal: [], contratos: [] };
  }
  return undefined;
}

const { ThemeProvider } = await import("../lib/theme");
const { DashboardShell } = await import("../components/dashboard-shell");
const { VigilanciaShell } = await import("../components/vigilancia/vigilancia-shell");
const { default: CompaniaDetallePage } = await import("../app/dashboard/companias/[id]/page");

/** La página de la ruta: la real para la compañía; para el resto, una marca. */
function Pagina() {
  if (/^\/dashboard\/companias\/[^/]+$/.test(ubicacion.pathname)) return createElement(CompaniaDetallePage);
  return createElement("div", { "data-pagina": ubicacion.pathname });
}

/** El layout que Next monta para la ruta (`app/dashboard/layout.tsx`, `app/vigilancia/layout.tsx`). */
function pintar() {
  const p = ubicacion.pathname;
  const Layout = p.startsWith("/dashboard") ? DashboardShell : p.startsWith("/vigilancia") ? VigilanciaShell : null;
  const pagina = createElement(Pagina, { key: p + ubicacion.search });
  root.render(createElement(ThemeProvider, null, Layout ? createElement(Layout, null, pagina) : pagina));
}

function navegar(href) {
  const destino = new URL(href, ubicacion);
  historial.push(destino.pathname + destino.search);
  /* Un bucle de redirecciones no debe colgar la prueba: se corta y falla. */
  if (historial.length > LIMITE_SALTOS) return;
  ubicacion = destino;
  pintar();
}

/** Deja correr efectos y redirecciones hasta que la URL no cambie más. */
async function asentar() {
  for (let i = 0; i < LIMITE_SALTOS; i++) {
    const antes = historial.length;
    await act(() => new Promise((r) => setTimeout(r, 0)));
    if (historial.length === antes) return;
  }
}

/** El usuario abre una URL (escrita, o un enlace de fuera de la app). */
async function abrir(href) {
  ubicacion = new URL(href, "http://localhost");
  historial = [ubicacion.pathname + ubicacion.search];
  await act(() => pintar());
  await asentar();
}

/** El usuario hace clic en un enlace del menú. */
async function clic(texto) {
  const enlace = [...contenedor.querySelectorAll("nav a")].find((a) => a.textContent === texto);
  expect(enlace).toBeTruthy();
  await act(() => enlace.click());
  await asentar();
}

const urlFinal = () => ubicacion.pathname + ubicacion.search;
/** Se le preguntó al servidor (no basta con montar la consulta en "skip"). */
const pidio = (nombre) => consultas.some((c) => c.nombre === nombre && c.args !== "skip");
/** El componente que hace esa consulta está montado (la disponibilidad espera en "skip" a que se busque). */
const monto = (nombre) => consultas.some((c) => c.nombre === nombre);
const enlaceActivo = () => contenedor.querySelector('nav a[aria-current="page"]')?.textContent;
const pestanaActiva = () => [...contenedor.querySelectorAll("button")].find((b) => b.className.includes("border-brand"))?.textContent;

// ── Sesiones ───────────────────────────────────────────────────────────────
const K = "k_andina";
const compania = (roles, companiaId = K) => ({ companiaId, nombre: "Seguridad Andina", estado: "activa", logo: null, primaryColor: null, roles });
const asignacion = (condominioId, rol, companiaId = K) => ({ asignacionId: `as_${condominioId}_${rol}`, condominioId, condominioNombre: condominioId, condominioLogo: null, condominioColor: null, companiaId, companiaNombre: "Seguridad Andina", rol, vigenciaHasta: null });
const membresia = (condominioId, roles) => ({ membershipId: `m_${condominioId}`, condominioId, condominioName: condominioId, condominioSubdomain: null, condominioLogo: null, condominioCoverImage: null, condominioPrimaryColor: null, roles });
function sesion({ platformRole = null, memberships = [], asignaciones = [], compania = null, cobertura = null } = {}) {
  return {
    id: "u", name: "Persona de prueba", email: "persona@prueba.co", image: null, firstName: null, lastName: null, telefono: null, active: true,
    platformRole, isSuperadmin: platformRole === "superadmin", claveTemporal: false, memberships, asignaciones, compania,
    contextoOperativoGuardia: { tipo: cobertura ? "cobertura" : "permanente", cobertura, conjuntos: [], refrescarEn: null },
  };
}

/* Las mismas personas del escenario de `packages/backend/pruebas/helpers/trazabilidad.ts`. */
const SOFIA = () => sesion({ compania: compania(["supervisor"]), asignaciones: [asignacion("alamos", "supervisor")] });
const SERGIO = () => sesion({ compania: compania(["supervisor"]), asignaciones: [asignacion("bosque", "supervisor"), asignacion("cedros", "supervisor")] });
const ALICIA = () => sesion({ compania: compania(["admin_compania"]) });
const JASON = () => sesion({ compania: compania(["guardia"]), asignaciones: [asignacion("alamos", "guardia")] });

const PLANIFICACION = [
  { pestana: "inasistencias", menu: "Inasistencias", panel: "inasistencias:deCompaniaEnRango" },
  { pestana: "horarios", menu: "Horarios", panel: "horariosGuarda:deCompaniaEnRango" },
  { pestana: "disponibilidad", menu: "Disponibilidad", panel: "disponibilidad:deGuardasEnAlcance" },
  { pestana: "coberturas", menu: "Coberturas", panel: "coberturas:deCompania" },
];

beforeEach(() => {
  consultas = []; historial = [];
  contenedor = document.createElement("div"); document.body.append(contenedor); root = createRoot(contenedor);
});
afterEach(async () => { await act(() => root.unmount()); contenedor.remove(); });

/** Desde su inicio, clic en la sección: termina en ella, con su panel montado. */
async function planificaDesdeElMenu({ pestana, menu, panel }) {
  await abrir("/vigilancia");
  expect(urlFinal()).toBe("/vigilancia");
  consultas = [];
  const desde = historial.length;
  await clic(menu);
  const destino = `/dashboard/companias/${K}?tab=${pestana}`;
  /* Un solo salto —el del clic—, sin ninguna redirección detrás. */
  expect(historial.slice(desde)).toEqual([destino]);
  expect(urlFinal()).toBe(destino);
  /* La página real, con la pestaña pedida y su panel consultando al servidor. */
  expect(pidio("companias:detail")).toBe(true);
  expect(pestanaActiva()).toBe(menu);
  expect(monto(panel)).toBe(true);
  expect(enlaceActivo()).toBe(menu);
}

// ── Caso 1 ─────────────────────────────────────────────────────────────────
describe("Caso 1 · supervisor con UNA asignación (Sofía en Álamos)", () => {
  for (const seccion of PLANIFICACION) {
    test(`clic en ${seccion.menu} → se queda en la sección, no vuelve a /vigilancia`, async () => {
      me = SOFIA();
      await planificaDesdeElMenu(seccion);
    });
  }

  test("abrir la URL de una sección directamente también se queda en ella", async () => {
    me = SOFIA();
    for (const { pestana, panel } of PLANIFICACION) {
      consultas = [];
      await abrir(`/dashboard/companias/${K}?tab=${pestana}`);
      expect(urlFinal()).toBe(`/dashboard/companias/${K}?tab=${pestana}`);
      expect(monto(panel)).toBe(true);
    }
  });

  test("fuera de la página de su compañía sigue yendo a su inicio", async () => {
    me = SOFIA();
    await abrir("/dashboard");
    expect(urlFinal()).toBe("/vigilancia");
    await abrir("/dashboard/companias");
    expect(urlFinal()).toBe("/vigilancia");
  });
});

// ── Caso 2 ─────────────────────────────────────────────────────────────────
describe("Caso 2 · supervisor con VARIAS asignaciones (Sergio en Bosque y Cedros)", () => {
  for (const seccion of PLANIFICACION) {
    test(`clic en ${seccion.menu} → se queda en la sección`, async () => {
      me = SERGIO();
      await planificaDesdeElMenu(seccion);
    });
  }

  test("fuera de la página de su compañía sigue yendo a su inicio", async () => {
    me = SERGIO();
    await abrir("/dashboard");
    expect(urlFinal()).toBe("/vigilancia");
  });
});

// ── Caso 3 ─────────────────────────────────────────────────────────────────
describe("Caso 3 · quien no puede planificar sigue sin entrar", () => {
  test("guarda con una portería → su portería; nunca se pide el detalle", async () => {
    me = JASON();
    await abrir(`/dashboard/companias/${K}?tab=inasistencias`);
    expect(urlFinal()).toBe("/guardia/alamos");
    expect(pidio("companias:detail")).toBe(false);
    expect(pidio("inasistencias:deCompaniaEnRango")).toBe(false);
  });

  test("guarda con varias porterías → la página le niega la gestión; nunca se pide el detalle", async () => {
    me = sesion({ compania: compania(["guardia"]), asignaciones: [asignacion("alamos", "guardia"), asignacion("bosque", "guardia")] });
    await abrir(`/dashboard/companias/${K}?tab=inasistencias`);
    expect(contenedor.textContent).toContain("No tienes acceso a la gestión de esta compañía");
    expect(pidio("companias:detail")).toBe(false);
    expect(pidio("inasistencias:deCompaniaEnRango")).toBe(false);
  });

  test("supervisor de OTRA compañía → a su inicio, sin pedir el detalle ajeno", async () => {
    me = sesion({ compania: compania(["supervisor"], "k_otra"), asignaciones: [asignacion("dunas", "supervisor", "k_otra")] });
    await abrir(`/dashboard/companias/${K}?tab=inasistencias`);
    expect(urlFinal()).toBe("/vigilancia");
    expect(pidio("companias:detail")).toBe(false);
  });

  test("residente → a su portal", async () => {
    me = sesion({ memberships: [membresia("alamos", ["propietario"])] });
    await abrir(`/dashboard/companias/${K}?tab=inasistencias`);
    expect(urlFinal()).toBe("/mi/alamos");
  });

  test("usuario sin conjunto ni compañía → la página le niega la gestión", async () => {
    me = sesion();
    await abrir(`/dashboard/companias/${K}?tab=inasistencias`);
    expect(contenedor.textContent).toContain("No tienes acceso a la gestión de esta compañía");
    expect(pidio("companias:detail")).toBe(false);
  });
});

// ── Caso 4 ─────────────────────────────────────────────────────────────────
describe("Caso 4 · el resto de perfiles no cambia", () => {
  test("administrador de compañía: su página se queda, con cada pestaña; fuera de ella → /vigilancia/inicio", async () => {
    me = ALICIA();
    for (const { pestana, menu, panel } of PLANIFICACION) {
      consultas = [];
      await abrir(`/dashboard/companias/${K}?tab=${pestana}`);
      expect(urlFinal()).toBe(`/dashboard/companias/${K}?tab=${pestana}`);
      expect(pestanaActiva()).toBe(menu);
      expect(monto(panel)).toBe(true);
    }
    await abrir("/dashboard");
    expect(urlFinal()).toBe("/vigilancia/inicio");
  });

  test("administrador de compañía: clic en una sección de su menú se queda en ella", async () => {
    me = ALICIA();
    await abrir("/vigilancia/inicio");
    await clic("Inasistencias");
    expect(urlFinal()).toBe(`/dashboard/companias/${K}?tab=inasistencias`);
    expect(monto("inasistencias:deCompaniaEnRango")).toBe(true);
  });

  for (const platformRole of ["superadmin", "admin"]) {
    test(`plataforma (${platformRole}): ve la compañía en su panel, sin redirecciones`, async () => {
      me = sesion({ platformRole });
      await abrir(`/dashboard/companias/${K}?tab=inasistencias`);
      expect(historial).toEqual([`/dashboard/companias/${K}?tab=inasistencias`]);
      expect(pidio("companias:detail")).toBe(true);
      expect(monto("inasistencias:deCompaniaEnRango")).toBe(true);
      /* Su panel de plataforma, no el de la compañía. */
      expect(enlaceActivo()).not.toBe("Inasistencias");
    });
  }

  test("guarda con una cobertura activa → la portería que cubre", async () => {
    me = sesion({
      compania: compania(["guardia"]),
      asignaciones: [asignacion("alamos", "guardia")],
      cobertura: { coberturaId: "cb", condominioId: "bosque", condominioNombre: "bosque", condominioLogo: null, condominioColor: null, companiaId: K, companiaNombre: "Seguridad Andina", inicio: 0, fin: 1 },
    });
    await abrir("/dashboard");
    expect(urlFinal()).toBe("/guardia/bosque");
  });

  test("administrador de conjunto → su panel de administración", async () => {
    me = sesion({ memberships: [membresia("alamos", ["administrador"])] });
    await abrir("/dashboard");
    expect(urlFinal()).toBe("/condominio/alamos");
  });
});
