import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
const ventana = new Window({ url: "http://localhost" });
for (const clave of ["window", "document", "HTMLElement", "HTMLInputElement", "Event", "MouseEvent", "Node", "navigator"]) Object.defineProperty(globalThis, clave, { configurable: true, value: clave === "window" ? ventana : ventana[clave] });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
let datos, error, consultas, contenedor, root;
mock.module("convex/react", () => ({ useQuery: (_fn, args) => { consultas.push(args); if (error) throw error; return datos; } }));
mock.module("next/link", () => ({ default: ({ children, ...props }) => createElement("a", props, children) }));
const { PanelOperacion } = await import("../components/vigilancia/panel-operacion");
const cero = { turnos: 0, inicios: 0, cerrados: 0, rondas: 0, rondasEnCurso: 0, minuta: 0, novedades: 0, aportes: 0 };
function muestra() {
  const total = { ...cero, turnos: 3, inicios: 3, cerrados: 2, rondas: 4, minuta: 12, novedades: 2 };
  return { compania: "Andina", conjuntos: [{ id: "norte", nombre: "Norte" }, { id: "sur", nombre: "Sur" }], guardas: [{ id: "ana", nombre: "Ana" }, { id: "luis", nombre: "Luis" }], total,
    porConjunto: [{ id: "norte", nombre: "Norte", ...total }, { id: "sur", nombre: "Sur", ...cero }], porGuarda: [{ id: "ana", nombre: "Ana", ...total }, { id: "luis", nombre: "Luis", ...cero }],
    evolucion: [{ desde: Date.parse("2026-09-01T00:00:00-05:00"), hasta: Date.parse("2026-09-01T23:59:59-05:00"), label: "2026-09-01", ...total }],
    modulos: [{ label: "minuta", value: 12 }], tipos: [{ label: "minuta · Registro", value: 12 }], prioridades: { baja: 0, media: 1, alta: 1 }, activos: [],
    sinAutorMinuta: 0, sinAutorRondas: 0, duracionRondas: { promedioMs: null, muestra: 0 } };
}
beforeEach(() => { datos = muestra(); error = undefined; consultas = []; contenedor = document.createElement("div"); document.body.append(contenedor); root = createRoot(contenedor); });
afterEach(async () => { await act(() => root.unmount()); contenedor.remove(); });
async function render() { await act(() => root.render(createElement(PanelOperacion))); }
async function cambio(el, valor) { await act(() => { el.value = valor; el.dispatchEvent(new Event("change", { bubbles: true })); }); }
async function click(el) { expect(el).toBeTruthy(); await act(() => el.click()); }
const campo = titulo => [...contenedor.querySelectorAll("label")].find(l => l.querySelector("span")?.textContent === titulo)?.querySelector("input,select");
const boton = titulo => [...contenedor.querySelectorAll("button")].find(b => b.textContent === titulo);

describe("Panel operativo web", () => {
  test("carga, tarjetas, filtros accesibles y acceso a módulos existentes", async () => {
    datos = undefined; await render(); expect(contenedor.querySelector('[role="status"]')).toBeTruthy();
    datos = muestra(); await render(); expect(contenedor.textContent).toContain("Tendencia de actividad");
    expect(contenedor.textContent).toContain("Novedades reportadas"); expect(contenedor.textContent).toContain("Sin muestra válida");
    expect(contenedor.querySelector('a[href="/vigilancia/incidentes/dashboard"]')).toBeTruthy();
    for (const el of contenedor.querySelectorAll("input,select")) expect(el.closest("label")).toBeTruthy();
  });
  test("los filtros llegan a la query y cambiar conjunto limpia guarda", async () => {
    await render(); await cambio(campo("Guarda"), "ana");
    expect(consultas.at(-1).guardiaUserId).toBe("ana"); expect(contenedor.textContent).toContain("Actividad de Ana");
    await cambio(campo("Condominio"), "sur"); expect(consultas.at(-1).condominioId).toBe("sur"); expect(consultas.at(-1).guardiaUserId).toBeUndefined();
    await cambio(campo("Tendencia por"), "mes"); expect(consultas.at(-1).granularidad).toBe("mes");
    await click(boton("Hoy")); expect(consultas.at(-1).desde).toBe(consultas.at(-1).hasta);
  });
  test("agrupación y profundización por guarda o conjunto", async () => {
    await render(); await cambio(campo("Agrupar por"), "guarda");
    expect(contenedor.textContent).toContain("Comparación por guarda"); expect(contenedor.textContent).toContain("Sin participación en turnos registrada");
    await click(boton("Ana")); expect(consultas.at(-1).guardiaUserId).toBe("ana");
    await click(boton("Ver todos los guardas")); expect(consultas.at(-1).guardiaUserId).toBeUndefined();
    await cambio(campo("Agrupar por"), "condominio"); await click(boton("Norte")); expect(consultas.at(-1).condominioId).toBe("norte");
    await cambio(campo("Agrupar por"), "compania"); expect(contenedor.textContent).toContain("Comparación por compañía");
    await click(boton("Restablecer filtros")); expect(consultas.at(-1).condominioId).toBeUndefined();
  });
  test("vacío comunica falta de registros sin deducir ausencia", async () => {
    datos = { ...muestra(), total: cero }; await render();
    expect(contenedor.textContent).toContain("Sin actividad registrada en este periodo"); expect(contenedor.textContent).toContain("no demuestra una ausencia");
  });
  test("error mantiene filtros y permite reintentar", async () => {
    error = new Error("Reduce el periodo"); await render(); expect(contenedor.textContent).toContain("No se pudo cargar la operación");
    expect(campo("Desde")).toBeTruthy(); error = undefined; await click(boton("Reintentar"));
    expect(contenedor.textContent).toContain("Tendencia de actividad");
  });
  test("un error inesperado no muestra detalles internos", async () => {
    error = new Error("stack Convex token privado"); await render();
    expect(contenedor.textContent).not.toContain("token privado");
    expect(contenedor.textContent).toContain("No fue posible consultar los datos");
  });
  test("valores de tendencia y atribución antigua disponibles sin gráfico", async () => {
    datos.sinAutorRondas = 2; datos.sinAutorMinuta = 3; await render();
    expect(contenedor.textContent).toContain("2 rondas · 3 entradas de minuta");
    expect(contenedor.querySelectorAll('th[scope="col"]')).toHaveLength(9);
    expect(contenedor.textContent).toContain("2026-09-01");
  });
});
