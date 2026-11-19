import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
const ventana = new Window({ url: "http://localhost" });
for (const clave of ["window", "document", "HTMLElement", "HTMLInputElement", "HTMLSelectElement", "Event", "KeyboardEvent", "MouseEvent", "Node", "navigator", "localStorage"]) Object.defineProperty(globalThis, clave, { configurable: true, value: clave === "window" ? ventana : ventana[clave] });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { getFunctionName } = await import("convex/server");

/**
 * EL HISTORIAL DE RONDAS POR PÁGINAS, EN LAS TRES PANTALLAS.
 *
 * Se montan los componentes y páginas reales —la tabla de administración y
 * supervisión, la página de supervisión y el historial del guarda— con el
 * servidor simulado. `usePaginatedQuery` devuelve lo que se le diga en cada
 * prueba (`paginado`) y anota con qué se la llamó: lo que se comprueba es qué
 * pide cada pantalla y qué ve el usuario en cada estado de la paginación.
 */

let respuestas, paginado, pedidas, cargas, llamadas, contenedor, root;

mock.module("next/navigation", () => ({ useParams: () => ({ id: "c1" }) }));
mock.module("next/link", () => ({ default: ({ href, children, ...props }) => createElement("a", { ...props, href }, children) }));
mock.module("convex/react", () => ({
  useQuery: (fn, args) => (args === "skip" ? undefined : respuestas[getFunctionName(fn)]),
  useMutation: (fn) => async (args) => {
    llamadas.push({ nombre: getFunctionName(fn), args });
    return { rondaId: "r-nueva", numero: 99 };
  },
  useAction: (fn) => async (args) => {
    llamadas.push({ nombre: getFunctionName(fn), args });
    return null;
  },
  usePaginatedQuery: (fn, args, opciones) => {
    pedidas.push({ nombre: getFunctionName(fn), args, opciones });
    return paginado;
  },
}));

const { TablaRondasPaginada } = await import("../components/vigilancia/tabla-rondas");
const { HistorialRondas } = await import("../components/guardia/historial-rondas");
const { default: SupervisionConjuntoPage } = await import("../app/vigilancia/[condominioId]/page");
const { default: VigilanciaConjuntoPage } = await import("../app/condominio/[id]/vigilancia/page");
const { default: RondasGuardaPage } = await import("../app/guardia/[id]/rondas/page");

const AHORA = Date.parse("2026-11-19T10:00:00-05:00");
const ronda = (i, extra = {}) => ({
  _id: `r${i}`,
  numero: i,
  zona: i % 2 ? "Perímetro" : "Parqueadero",
  guardiaNombre: "Ana Guarda",
  estado: "finalizada",
  fechaInicio: AHORA - i * 3_600_000,
  fechaCierre: AHORA - i * 3_600_000 + 2_400_000,
  duracion: "40 minutos",
  totales: { novedades: i % 2, vehiculos: 0, eventos: i % 3 },
  ...extra,
});
const rondas = (desde, hasta) => Array.from({ length: hasta - desde }, (_, k) => ronda(desde + k));
/** Lo que devuelve `usePaginatedQuery` en cada estado. */
const estado = (status, results = []) => ({
  results,
  status,
  isLoading: status === "LoadingFirstPage" || status === "LoadingMore",
  loadMore: (n) => cargas.push(n),
});
/** Los `params` de una página de Next ya resueltos: `use()` los lee sin suspender. */
const params = (valor) => Object.assign(Promise.resolve(valor), { status: "fulfilled", value: valor });

beforeEach(() => {
  respuestas = {}; pedidas = []; cargas = []; llamadas = [];
  paginado = estado("LoadingFirstPage");
  contenedor = document.createElement("div"); document.body.append(contenedor); root = createRoot(contenedor);
});
afterEach(async () => { await act(() => root.unmount()); contenedor.remove(); document.body.innerHTML = ""; });

const texto = () => document.body.textContent.replace(/\s+/g, " ");
const boton = (titulo) => [...document.body.querySelectorAll("button")].find((b) => b.textContent.trim() === titulo);
const filas = () => document.body.querySelectorAll("tbody tr").length;
async function pintar(el) { await act(() => root.render(el)); }
async function click(el) { expect(el).toBeTruthy(); await act(async () => { el.click(); }); }
async function elegir(select, valor) {
  const setter = Object.getOwnPropertyDescriptor(ventana.HTMLSelectElement.prototype, "value").set;
  await act(() => { setter.call(select, valor); select.dispatchEvent(new ventana.Event("change", { bubbles: true })); });
}

// ─────────────────────────────────────────────────────────────
describe("La tabla paginada (administración y supervisión)", () => {
  const tabla = (props = {}) => createElement(TablaRondasPaginada, { condominioId: "c1", ...props });

  test("pide la consulta paginada, de 20 en 20, con el conjunto y el guarda", async () => {
    await pintar(tabla({ guardiaUserId: "g1" }));
    expect(pedidas.at(-1)).toEqual({
      nombre: "rondas:listarPagina",
      args: { condominioId: "c1", guardiaUserId: "g1" },
      opciones: { initialNumItems: 20 },
    });
  });

  test("cargando la primera página: esqueleto, sin tabla ni botón", async () => {
    await pintar(tabla());
    expect(filas()).toBe(0);
    expect(boton("Cargar más")).toBeUndefined();
    expect(texto()).not.toContain("Sin rondas registradas");
  });

  test("con más historial: las 20 recientes y 'Cargar más' pide la siguiente página", async () => {
    paginado = estado("CanLoadMore", rondas(1, 21));
    await pintar(tabla());
    expect(filas()).toBe(20);
    expect(texto()).toContain("Perímetro");
    expect(texto()).toContain("40 minutos");
    await click(boton("Cargar más"));
    expect(cargas).toEqual([20]);
  });

  test("mientras llega la página: botón deshabilitado y sin segunda petición", async () => {
    paginado = estado("LoadingMore", rondas(1, 21));
    await pintar(tabla());
    const b = boton("Cargando…");
    expect(b).toBeTruthy();
    expect(b.disabled).toBe(true);
    await act(async () => { b.click(); });
    expect(cargas).toEqual([]);
    // Lo ya cargado sigue a la vista.
    expect(filas()).toBe(20);
  });

  test("al llegar al final: todas las cargadas, sin botón y con el aviso de fin", async () => {
    paginado = estado("Exhausted", rondas(1, 60));
    await pintar(tabla());
    expect(filas()).toBe(59);
    expect(boton("Cargar más")).toBeUndefined();
    expect(texto()).toContain("No hay rondas más antiguas · 59 en total");
  });

  test("un historial que cabe en una página no muestra ni botón ni aviso", async () => {
    paginado = estado("Exhausted", rondas(1, 6));
    await pintar(tabla());
    expect(filas()).toBe(5);
    expect(boton("Cargar más")).toBeUndefined();
    expect(texto()).not.toContain("No hay rondas más antiguas");
  });

  test("sin rondas: el estado vacío, con el texto de quien mira", async () => {
    paginado = estado("Exhausted", []);
    await pintar(tabla({ vacio: "Ana todavía no tiene rondas en este conjunto." }));
    expect(texto()).toContain("Sin rondas registradas");
    expect(texto()).toContain("Ana todavía no tiene rondas en este conjunto.");
  });

  test("al cambiar de guarda, la consulta se pide con el nuevo filtro", async () => {
    paginado = estado("CanLoadMore", rondas(1, 21));
    await pintar(tabla({ guardiaUserId: "g1" }));
    await pintar(tabla({ guardiaUserId: "g2" }));
    expect(pedidas.at(-1).args).toEqual({ condominioId: "c1", guardiaUserId: "g2" });
  });
});

// ─────────────────────────────────────────────────────────────
describe("Supervisión de un conjunto", () => {
  const EQUIPO = [{
    condominioId: "c1", condominioNombre: "Ciudad del Campo II", companiaNombre: "Seguridad Andina", via: "supervisor",
    guardas: [{ userId: "g1", nombre: "Ana Guarda" }, { userId: "g2", nombre: "Beto Guarda" }],
  }];
  async function abrir() {
    respuestas["asignaciones:miEquipo"] = EQUIPO;
    respuestas["guardia:listMinuta"] = [];
    await pintar(createElement(SupervisionConjuntoPage, { params: params({ condominioId: "c1" }) }));
  }

  test("abre en rondas con la consulta paginada de toda la portería", async () => {
    paginado = estado("CanLoadMore", rondas(1, 21));
    await abrir();
    expect(pedidas.at(-1)).toEqual({
      nombre: "rondas:listarPagina",
      args: { condominioId: "c1", guardiaUserId: undefined },
      opciones: { initialNumItems: 20 },
    });
    expect(filas()).toBe(20);
    expect(boton("Cargar más")).toBeTruthy();
    // Ya no pide `rondas.listar`.
    expect(pedidas.every((p) => p.nombre === "rondas:listarPagina")).toBe(true);
  });

  test("filtrar por guarda pide su historial y el vacío habla de él", async () => {
    paginado = estado("Exhausted", []);
    await abrir();
    await elegir(document.body.querySelector("select"), "g1");
    expect(pedidas.at(-1).args).toEqual({ condominioId: "c1", guardiaUserId: "g1" });
    expect(texto()).toContain("Ana Guarda todavía no tiene rondas en este conjunto.");
  });

  test("en la pestaña de minuta las rondas no se piden", async () => {
    paginado = estado("CanLoadMore", rondas(1, 21));
    await abrir();
    // La pestaña de minuta lleva su contador: "Minuta(0)".
    await click([...document.body.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith("Minuta")));
    pedidas = [];
    // Un cambio cualquiera que vuelva a pintar la página.
    await elegir(document.body.querySelector("select"), "g2");
    expect(pedidas).toEqual([]);
    expect(texto()).toContain("Minuta vacía");
    // Y al volver a rondas, se piden otra vez desde el principio, con el filtro.
    await click(boton("Rondas"));
    expect(pedidas.at(-1).args).toEqual({ condominioId: "c1", guardiaUserId: "g2" });
  });
});

// ─────────────────────────────────────────────────────────────
describe("Vigilancia del conjunto (administración)", () => {
  test("la pestaña de rondas usa la consulta paginada y solo al abrirla", async () => {
    paginado = estado("CanLoadMore", rondas(1, 21));
    await pintar(createElement(VigilanciaConjuntoPage));
    expect(pedidas).toEqual([]);
    await click(boton("Rondas"));
    expect(pedidas.at(-1)).toEqual({
      nombre: "rondas:listarPagina",
      args: { condominioId: "c1", guardiaUserId: undefined },
      opciones: { initialNumItems: 20 },
    });
    expect(filas()).toBe(20);
    await click(boton("Cargar más"));
    expect(cargas).toEqual([20]);
  });
});

// ─────────────────────────────────────────────────────────────
describe("Historial del guarda", () => {
  const historial = () => createElement(HistorialRondas, { condominioId: "c1" });
  const entrada = (i) => [...document.body.querySelectorAll("button")].find((b) => b.textContent.includes(`Ronda #${i} ·`));

  test("cargando la primera página: solo el indicador", async () => {
    await pintar(historial());
    expect(texto()).not.toContain("Rondas anteriores");
    expect(texto()).not.toContain("Todavía no hay rondas registradas.");
    expect(pedidas.at(-1)).toEqual({ nombre: "rondas:listarPagina", args: { condominioId: "c1", guardiaUserId: undefined }, opciones: { initialNumItems: 20 } });
  });

  test("sin rondas: el aviso de siempre", async () => {
    paginado = estado("Exhausted", []);
    await pintar(historial());
    expect(texto()).toContain("Todavía no hay rondas registradas.");
  });

  test("las 20 recientes, sus contadores y 'Cargar más'", async () => {
    paginado = estado("CanLoadMore", rondas(1, 21));
    await pintar(historial());
    expect(texto()).toContain("Rondas anteriores");
    expect(entrada(1)).toBeTruthy();
    expect(entrada(20)).toBeTruthy();
    expect(entrada(21)).toBeUndefined();
    expect(entrada(4).textContent).toContain("0 nov.");
    expect(entrada(5).textContent).toContain("1 nov.");
    expect(entrada(5).textContent).toContain("2 ev.");
    await click(boton("Cargar más"));
    expect(cargas).toEqual([20]);
  });

  test("la ronda desplegada sigue abierta cuando llega la página siguiente", async () => {
    respuestas["rondas:detalle"] = {
      observacionesCierre: "Sin novedad en el recorrido.",
      lineaDeTiempo: [{ en: AHORA, tipo: "inicio", titulo: "Inicio de ronda · Perímetro", quien: "Ana Guarda" }],
    };
    paginado = estado("CanLoadMore", rondas(1, 21));
    await pintar(historial());
    await click(entrada(3));
    expect(texto()).toContain("Sin novedad en el recorrido.");

    paginado = estado("Exhausted", rondas(1, 41));
    await pintar(historial());
    expect(entrada(40)).toBeTruthy();
    expect(texto()).toContain("Sin novedad en el recorrido.");
    expect(boton("Cargar más")).toBeUndefined();
    expect(texto()).toContain("No hay rondas más antiguas · 40 en total");
  });

  test("la página de rondas del guarda sigue permitiendo iniciar una", async () => {
    respuestas["rondas:activa"] = null;
    respuestas["guardia:listRondaZonas"] = [];
    paginado = estado("CanLoadMore", rondas(1, 21));
    await pintar(createElement(RondasGuardaPage, { params: params({ id: "c1" }) }));
    expect(texto()).toContain("No tienes ninguna ronda abierta");
    expect(entrada(1)).toBeTruthy();
    await click(boton("Iniciar ronda"));
    expect(llamadas).toEqual([{ nombre: "rondas:iniciar", args: { condominioId: "c1", zonaId: undefined } }]);
  });
});
