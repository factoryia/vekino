import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
const ventana = new Window({ url: "http://localhost", settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true } });
for (const clave of ["window", "document", "HTMLElement", "HTMLInputElement", "HTMLFormElement", "Event", "MouseEvent", "FormData", "Node", "navigator"]) Object.defineProperty(globalThis, clave, { configurable: true, value: clave === "window" ? ventana : ventana[clave] });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { getFunctionName } = await import("convex/server");
const { periodoIncidentes, DIA } = await import("@vekino/backend/incidenteMetricas");
const { filtrosBandeja } = await import("../lib/incidentes-bandeja");
let contexto, datos, error, params, consultas, navegaciones, contenedor, root, pagina;
mock.module("convex/react", () => ({ useQuery: (fn, args) => {
  const nombre = getFunctionName(fn); consultas.push({ nombre, args });
  if (nombre === "incidentes:contextoBandeja") return contexto;
  if (nombre === "incidentes:dashboard") { if (error) throw error; return datos; }
  if (nombre === "incidentes:listar") return args === "skip" ? undefined : { page: [], isDone: true, continueCursor: "" };
} }));
mock.module("next/navigation", () => ({ useSearchParams: () => params, usePathname: () => "/vigilancia/incidentes", useRouter: () => ({ push: (url, opciones) => { navegaciones.push({ url, opciones }); params = new URLSearchParams(url.split("?")[1]); } }) }));
mock.module("next/link", () => ({ default: ({ children, ...props }) => createElement("a", props, children) }));
const { IncidentesDashboard } = await import("../components/vigilancia/incidentes-dashboard");
const { IncidentesInicio } = await import("../components/vigilancia/incidentes-inicio");
function muestra() {
  const periodo = periodoIncidentes("personalizado", "2026-09-01", "2026-09-30");
  return { periodo, total: 10, activos: 6, antiguos: 2, antiguedadDias: 7,
    estados: { REPORTADO: 2, EN_INVESTIGACION: 2, EN_SEGUIMIENTO: 2, RESUELTO: 3, CERRADO: 1 },
    prioridades: { BAJA: 1, MEDIA: 3, ALTA: 2, CRITICA: 4 },
    tipos: [{ tipo: "ACCESO", cantidad: 6 }, { tipo: "TIPO_HISTORICO", cantidad: 4 }],
    conjuntos: [{ condominioId: "conjunto-a", nombre: "Norte", cantidad: 7 }, { condominioId: "conjunto-b", nombre: "Sur", cantidad: 3 }],
    evolucion: { granularidad: "semana", puntos: [{ desde: periodo.desde, hasta: periodo.desde + 7 * DIA - 1, label: "2026-09-01", value: 10 }] },
    resolucion: { promedioMs: 36 * 3_600_000, muestra: 4, sinFecha: 1 },
    relevantes: [{ _id: "caso-a", condominioId: "conjunto-a", conjunto: "Norte", tipo: "ACCESO", prioridad: "CRITICA", estado: "REPORTADO", reportadoEn: periodo.desde, responsableNombre: "Sofía" }],
  };
}
beforeEach(() => {
  contexto = { companiaId: "empresa-a", todosLosConjuntos: true, conjuntos: [{ condominioId: "conjunto-a", condominioNombre: "Norte", crear: true, soloPropios: false }, { condominioId: "conjunto-b", condominioNombre: "Sur", crear: true, soloPropios: false }] };
  datos = muestra(); error = undefined; params = new URLSearchParams(); consultas = []; navegaciones = [];
  contenedor = document.createElement("div"); document.body.append(contenedor); root = createRoot(contenedor); pagina = createElement(IncidentesDashboard);
});
afterEach(async () => { await act(() => root.unmount()); contenedor.remove(); });
async function render() { await act(() => root.render(createElement(pagina.type, { ...pagina.props }))); }
async function click(el) { expect(el).toBeTruthy(); await act(() => el.click()); }
async function cambiar(el, valor) { await act(() => { el.value = valor; el.dispatchEvent(new Event("change", { bubbles: true })); }); }
async function submit(form) { await act(() => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))); await render(); }
const enlaces = () => [...contenedor.querySelectorAll("a")];
const enlaceTexto = (texto) => enlaces().find((a) => a.textContent.includes(texto));
const botones = () => [...contenedor.querySelectorAll("button")];
const argsDashboard = () => consultas.filter((c) => c.nombre === "incidentes:dashboard").at(-1).args;

describe("dashboard completo: consultas, estados y filtros", () => {
  test("cargando contexto y métricas no muestra ceros ni ausencia de datos", async () => {
    const previo = contexto; contexto = undefined; await render();
    expect(contenedor.querySelector('[aria-label="Cargando dashboard"]')).toBeTruthy();
    expect(contenedor.textContent).not.toContain("No hay incidentes"); expect(contenedor.textContent).not.toContain("Total de incidentes");
    contexto = previo; datos = undefined; await render();
    expect(contenedor.textContent).toContain("Aplicar filtros"); expect(contenedor.textContent).toContain("Cargando dashboard");
    expect(contenedor.textContent).not.toContain("Total de incidentes");
  });
  test("carga todas las métricas y valores, conserva tipos históricos y alternativas accesibles", async () => {
    await render();
    for (const texto of ["Dashboard de Incidentes", "Total de incidentes", "Activos", "Resueltos", "Cerrados", "Distribución por estado", "Distribución por prioridad", "Distribución por tipo", "TIPO_HISTORICO", "Volumen por conjunto", "Evolución temporal", "Atención operativa", "Sofía", "36 horas", "Muestra: 4", "Excluidos", "7 días"]) expect(contenedor.textContent).toContain(texto);
    expect(enlaceTexto("Total de incidentes").textContent).toContain("10"); expect(enlaceTexto("Activos").textContent).toContain("6");
    expect(contenedor.querySelectorAll("svg").length).toBeGreaterThan(2);
    expect(contenedor.querySelector("summary").textContent).toContain("Ver valores");
    expect(argsDashboard()).toMatchObject({ periodo: "30dias", activos: false });
  });
  test("sin datos, falta de alcance y rechazo son estados distintos", async () => {
    datos = { ...datos, total: 0 }; await render(); expect(contenedor.textContent).toContain("No hay incidentes en este periodo.");
    contexto = null; await render(); expect(contenedor.textContent).toContain("No tienes acceso a datos de incidentes."); expect(contenedor.textContent).not.toContain("No hay incidentes");
  });
  test.each([new Error("Fallo red stack secreto"), new Error("LIMITE_ANALITICA"), new Error("No tiene permiso"), new Error("El rango de fechas no es válido.")])("error %s y reintento recuperan dashboard sin filtrar trazas", async (fallo) => {
    error = fallo;
    const anterior = console.error; console.error = () => {};
    try { await render(); } finally { console.error = anterior; }
    expect(contenedor.querySelector('[role="alert"]')).toBeTruthy(); expect(contenedor.textContent).not.toContain("stack secreto");
    expect(contenedor.textContent).toContain(fallo.message.includes("permiso") ? "No tienes acceso" : fallo.message.includes("LIMITE") ? "límite de consulta" : "Ocurrió un error");
    expect(contenedor.querySelector("form")).toBeTruthy(); error = undefined; await click(botones().find((b) => b.textContent === "Reintentar"));
    expect(contenedor.textContent).toContain("Total de incidentes");
  });
  test("cambia periodo, conjunto, estado, prioridad y tipo mediante formulario y URL", async () => {
    await render(); const form = contenedor.querySelector("form");
    await cambiar(form.elements.periodo, "7dias"); await cambiar(form.elements.conjunto, "conjunto-b");
    await cambiar(form.elements.estado, "EN_INVESTIGACION"); await cambiar(form.elements.prioridad, "CRITICA"); form.elements.tipo.value = "TIPO_HISTORICO";
    await submit(form);
    expect(navegaciones.at(-1).opciones).toEqual({ scroll: false });
    expect(argsDashboard()).toMatchObject({ periodo: "7dias", condominioId: "conjunto-b", estado: "EN_INVESTIGACION", prioridad: "CRITICA", tipo: "TIPO_HISTORICO" });
  });
  test("personalizado solicita ambos días y conserva el periodo al regresar por URL", async () => {
    await render(); await cambiar(contenedor.querySelector('[name="periodo"]'), "personalizado");
    const form = contenedor.querySelector("form"); expect(form.elements.desde.required).toBe(true); expect(form.elements.hasta.required).toBe(true);
    form.elements.desde.value = "2026-08-01"; form.elements.hasta.value = "2026-09-15"; await submit(form);
    expect(argsDashboard()).toMatchObject({ periodo: "personalizado", desde: "2026-08-01", hasta: "2026-09-15" });
    params = new URLSearchParams("periodo=mesAnterior"); await render();
    expect(contenedor.querySelector('[name="desde"]')).toBeNull(); expect(contenedor.querySelector('[name="periodo"]').value).toBe("mesAnterior");
  });
  test("un único conjunto simplifica selector; supervisor usa ese alcance; admin conserva histórico global", async () => {
    contexto.conjuntos = contexto.conjuntos.slice(0, 1); contexto.todosLosConjuntos = false; await render();
    expect(contenedor.querySelector('select[name="conjunto"]')).toBeNull(); expect(argsDashboard().condominioId).toBe("conjunto-a");
    contexto.todosLosConjuntos = true; params = new URLSearchParams("periodo=hoy"); await render();
    expect(argsDashboard().condominioId).toBeUndefined();
  });
});
describe("navegación real dashboard → bandeja → dashboard", () => {
  test("activos mantiene fechas, tipo y conjunto, retorna exactamente al contexto original", async () => {
    params = new URLSearchParams("periodo=personalizado&desde=2026-09-01&hasta=2026-09-30&conjunto=conjunto-a&tipo=ACCESO");
    const original = params.toString(); await render();
    const href = enlaceTexto("Activos").getAttribute("href"); const destino = new URLSearchParams(href.split("?")[1]);
    expect(destino.get("estado")).toBe("ACTIVOS"); expect(destino.get("fecha")).toBe("reportadoEn"); expect(destino.get("zona")).toBe("America/Bogota");
    expect(destino.get("desde")).toBe("2026-09-01"); expect(destino.get("hasta")).toBe("2026-09-30"); expect(destino.get("dashboard")).toBe(original);
    const filtros = filtrosBandeja(destino); expect(filtros.desde).toBe(datos.periodo.desde); expect(filtros.hasta).toBe(datos.periodo.hasta);
    pagina = createElement(IncidentesInicio, { baseHref: "/vigilancia/incidentes" }); params = destino; await render();
    expect(enlaceTexto("Volver al dashboard").getAttribute("href")).toBe(`/vigilancia/incidentes/dashboard?${original}`);
    const form = contenedor.querySelector("form"); await cambiar(form.elements.prioridad, "ALTA"); await submit(form);
    expect(params.get("dashboard")).toBe(original); expect(params.get("zona")).toBe("America/Bogota");
  });
  test("categorías, intervalo y ficha usan los mismos filtros sin imponer estado activos", async () => {
    await render();
    expect(new URLSearchParams(enlaceTexto("En investigación").getAttribute("href").split("?")[1]).get("estado")).toBe("EN_INVESTIGACION");
    const critica = enlaces().find((a) => a.textContent.startsWith("Crítica")); expect(new URLSearchParams(critica.getAttribute("href").split("?")[1]).get("prioridad")).toBe("CRITICA");
    const tipo = enlaceTexto("TIPO_HISTORICO"); expect(new URLSearchParams(tipo.getAttribute("href").split("?")[1]).get("tipo")).toBe("TIPO_HISTORICO");
    expect(new URLSearchParams(enlaceTexto("Sur").getAttribute("href").split("?")[1]).get("conjunto")).toBe("conjunto-b");
    const temporal = enlaceTexto("2026-09-01: 10"); expect(new URLSearchParams(temporal.getAttribute("href").split("?")[1]).get("hasta")).toBe("2026-09-07");
    const ficha = enlaces().find((a) => a.getAttribute("href").startsWith("/vigilancia/incidentes/caso-a")); expect(ficha.getAttribute("href")).toContain("volver=");
  });
  test("supervisor con varios conjuntos navega a la unión autorizada y nunca pierde el alcance", async () => {
    contexto.todosLosConjuntos = false; await render();
    params = new URLSearchParams(enlaceTexto("Activos").getAttribute("href").split("?")[1]);
    expect(params.get("alcance")).toBe("mis-conjuntos"); expect(params.has("conjunto")).toBe(false);
    pagina = createElement(IncidentesInicio, { baseHref: "/vigilancia/incidentes" }); await render();
    const consulta = consultas.filter((c) => c.nombre === "incidentes:listar" && c.args !== "skip").at(-1);
    expect(consulta.args.todosMisConjuntos).toBe(true); expect(consulta.args.condominioId).toBeUndefined();
    await submit(contenedor.querySelector("form")); expect(params.get("alcance")).toBe("mis-conjuntos");
  });
  test("prioritarios filtran estado y prioridad sin introducir puntuaciones", async () => {
    params = new URLSearchParams("token=valor-sintetico&cursor=innecesario");
    await render(); const criticos = enlaceTexto("Ver activos de prioridad crítica");
    expect(criticos.getAttribute("href")).not.toContain("token");
    const contextoRetorno = new URLSearchParams(enlaceTexto("Activos").getAttribute("href").split("?")[1]).get("dashboard");
    expect(contextoRetorno).not.toContain("token"); expect(contextoRetorno).not.toContain("cursor");
    params = new URLSearchParams(criticos.getAttribute("href").split("?")[1]); await render();
    expect(argsDashboard()).toMatchObject({ activos: true, prioridad: "CRITICA" });
  });
  test("móvil apila contenido, filtros accesibles y listas extensas empiezan con diez categorías", async () => {
    datos.conjuntos = Array.from({ length: 24 }, (_, i) => ({ condominioId: `conjunto-${i}`, nombre: `Conjunto ${i}`, cantidad: 1 }));
    await render(); expect(contenedor.innerHTML).toContain("sm:grid-cols-2"); expect(contenedor.innerHTML).toContain("lg:grid-cols-2"); expect(contenedor.innerHTML).not.toContain("overflow-x-auto");
    expect(contenedor.textContent).toContain("Conjunto 9"); expect(contenedor.textContent).not.toContain("Conjunto 23");
    await click(botones().find((b) => b.textContent === "Ver todas las categorías (24)")); expect(contenedor.textContent).toContain("Conjunto 23");
    await click(botones().find((b) => b.textContent === "Mostrar menos")); expect(contenedor.textContent).not.toContain("Conjunto 23");
    for (const control of contenedor.querySelectorAll("select, input:not([type=hidden])")) expect(control.closest("label")).toBeTruthy();
  });
});
