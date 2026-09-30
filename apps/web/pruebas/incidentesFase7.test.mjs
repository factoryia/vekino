import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
const ventana = new Window({ url: "http://localhost", settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true } });
for (const clave of ["window", "document", "HTMLElement", "HTMLInputElement", "HTMLFormElement", "Event", "MouseEvent", "FormData", "Node", "navigator"]) Object.defineProperty(globalThis, clave, { configurable: true, value: clave === "window" ? ventana : ventana[clave] });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { getFunctionName } = await import("convex/server");
const { periodoIncidentes } = await import("@vekino/backend/incidenteMetricas");
let contexto, datos, error, params, consultas, navegaciones, root, contenedor, peticiones, descargas, servidorError, servidorArgs;
mock.module("convex/react", () => ({ useQuery: (fn, args) => {
  const nombre = getFunctionName(fn); consultas.push({ nombre, args });
  if (nombre === "incidentes:contextoBandeja") return contexto;
  if (nombre === "incidentes:reporte" || nombre === "incidentes:dashboard") { if (error) throw error; return datos; }
} }));
mock.module("next/navigation", () => ({ useSearchParams: () => params, useRouter: () => ({ push: (url) => { navegaciones.push(url); params = new URLSearchParams(url.split("?")[1]); } }) }));
mock.module("next/link", () => ({ default: ({ children, ...props }) => createElement("a", props, children) }));
mock.module("@/lib/auth-server", () => ({ fetchAuthQuery: async (fn, args) => { servidorArgs = args; if (servidorError) throw servidorError; return datos; } }));
const { IncidentesReportes } = await import("../components/vigilancia/incidentes-reportes");
const { IncidentesDashboard } = await import("../components/vigilancia/incidentes-dashboard");
const { POST } = await import("../app/api/incidentes/reporte/route");
const { descargarReporteIncidentes } = await import("../lib/descargar-reporte-incidentes");
const JSZip = (await import("jszip")).default;
const fetchOriginal = globalThis.fetch, createOriginal = URL.createObjectURL, revokeOriginal = URL.revokeObjectURL;
const clickOriginal = ventana.HTMLAnchorElement.prototype.click;
const ahoraOriginal = Date.now;
function muestra() {
  const periodo = periodoIncidentes("personalizado", "2026-09-01", "2026-09-30");
  return { periodo, total: 1, activos: 1, estados: { REPORTADO: 1, EN_INVESTIGACION: 0, EN_SEGUIMIENTO: 0, RESUELTO: 0, CERRADO: 0 },
    prioridades: { BAJA: 0, MEDIA: 1, ALTA: 0, CRITICA: 0 }, tipos: [{ tipo: "ACCESO", cantidad: 1 }], conjuntos: [{ condominioId: "conjunto-a", nombre: "Norte", cantidad: 1 }],
    evolucion: { granularidad: "día", puntos: [] }, resolucion: { promedioMs: null, muestra: 0, sinFecha: 0 }, relevantes: [], antiguos: 0, antiguedadDias: 7,
    reporte: { generadoEn: Date.parse("2026-09-30T10:30:00-05:00"), conjunto: "Norte", filtros: { estado: "TODOS", prioridad: "Todas", tipo: "Todos" },
      filas: [{ referencia: "caso-a", conjunto: "Norte", reportadoEn: periodo.desde, ocurrioEn: periodo.desde - 1000, tipo: "ACCESO", prioridad: "MEDIA", estado: "REPORTADO", ubicacion: 'Puerta "Sur"', reportante: "Ana", responsable: "Sofía", resueltoEn: null, cerradoEn: null }] },
  };
}
beforeEach(() => {
  Date.now = () => Date.parse("2026-09-30T10:30:00-05:00");
  contexto = { companiaId: "empresa-a", todosLosConjuntos: true, conjuntos: [{ condominioId: "conjunto-a", condominioNombre: "Norte", soloPropios: false }] };
  datos = muestra(); error = undefined; servidorError = undefined; servidorArgs = undefined; params = new URLSearchParams(); consultas = []; navegaciones = []; peticiones = []; descargas = [];
  globalThis.fetch = async (url, opts) => { peticiones.push({ url, ...opts }); return new Response("archivo completo", { headers: { "Content-Disposition": 'attachment; filename="incidentes-2026-09-01-2026-09-30.csv"' } }); };
  URL.createObjectURL = () => "blob:reporte-sintetico"; URL.revokeObjectURL = () => {};
  ventana.HTMLAnchorElement.prototype.click = function () { descargas.push({ nombre: this.download, href: this.href }); };
  contenedor = document.createElement("div"); document.body.append(contenedor); root = createRoot(contenedor);
});
afterEach(async () => { await act(() => root.unmount()); contenedor.remove(); globalThis.fetch = fetchOriginal; URL.createObjectURL = createOriginal; URL.revokeObjectURL = revokeOriginal; ventana.HTMLAnchorElement.prototype.click = clickOriginal; Date.now = ahoraOriginal; });
async function render(componente = IncidentesReportes) { await act(() => root.render(createElement(componente))); }
async function tick() { await act(() => new Promise((r) => setTimeout(r, 10))); }
async function click(el) { expect(el).toBeTruthy(); await act(() => el.click()); }
async function cambio(el, valor) { await act(() => { el.value = valor; el.dispatchEvent(new Event("change", { bubbles: true })); }); }
const boton = (texto) => [...contenedor.querySelectorAll("button")].find((b) => b.textContent === texto);
const enlace = (texto) => [...contenedor.querySelectorAll("a")].find((a) => a.textContent.includes(texto));
const argsReporte = () => consultas.filter((c) => c.nombre === "incidentes:reporte").at(-1).args;
describe("reportes: vista, navegación y descargas", () => {
  test("loading de contexto y resultados; resumen, tabla y controles con texto accesible", async () => {
    const original = contexto; contexto = undefined; await render(); expect(contenedor.textContent).toContain("Cargando reporte"); expect(contenedor.textContent).not.toContain("Resumen del reporte");
    contexto = original; datos = undefined; await render(); expect(contenedor.querySelector("form")).toBeTruthy(); expect(contenedor.textContent).toContain("Cargando reporte");
    datos = muestra(); await render(); for (const texto of ["Resumen del reporte", "Activos", "Resueltos", "Cerrados", "2026-09-01", "Referencia", "Sofía", "Generar CSV", "Exportar Excel", "Generar PDF"]) expect(contenedor.textContent).toContain(texto);
    for (const el of contenedor.querySelectorAll("select,input:not([type=hidden])")) expect(el.closest("label")).toBeTruthy();
    expect(contenedor.querySelector('div[role="region"]').tabIndex).toBe(0); expect(contenedor.querySelectorAll('th[scope="col"]')).toHaveLength(9);
  });
  test("formulario aplica todos los filtros y bloquea exportación de cambios pendientes", async () => {
    await render(); const f = contenedor.querySelector("form");
    await cambio(f.elements.periodo, "7dias"); await cambio(f.elements.conjunto, "conjunto-a"); await cambio(f.elements.estado, "EN_INVESTIGACION"); await cambio(f.elements.prioridad, "CRITICA"); await cambio(f.elements.tipo, "HISTORICO");
    expect(boton("Generar CSV").disabled).toBe(true); expect(contenedor.textContent).toContain("Aplica los filtros");
    await act(() => f.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))); await render();
    expect(navegaciones.at(-1)).toContain("/reportes?"); expect(argsReporte()).toMatchObject({ periodo: "7dias", condominioId: "conjunto-a", estado: "EN_INVESTIGACION", prioridad: "CRITICA", tipo: "HISTORICO" }); expect(boton("Generar CSV").disabled).toBe(false);
  });
  test("dashboard abre reporte con fechas backend y filtros exactos; bandeja y ficha existentes conservan contexto", async () => {
    params = new URLSearchParams("periodo=mes&conjunto=conjunto-a&estado=ACTIVOS&prioridad=ALTA&tipo=ACCESO&token=privado");
    await render(IncidentesDashboard); const url = enlace("Generar reporte").getAttribute("href"); expect(url).not.toContain("token");
    params = new URLSearchParams(url.split("?")[1]); await render();
    expect(argsReporte()).toMatchObject({ periodo: "personalizado", desde: "2026-09-01", hasta: "2026-09-30", condominioId: "conjunto-a", activos: true, prioridad: "ALTA", tipo: "ACCESO" });
    const bandeja = new URLSearchParams(enlace("Consultar todos").getAttribute("href").split("?")[1]); expect(bandeja.get("zona")).toBe("America/Bogota"); expect(bandeja.get("estado")).toBe("ACTIVOS");
    expect(enlace("caso-a").getAttribute("href")).toContain("/incidentes/caso-a?volver=");
    datos.total = 0; await render(IncidentesDashboard); expect(enlace("Generar reporte").getAttribute("href")).toContain("hasta=2026-09-30"); expect(contenedor.textContent).toContain("No hay incidentes en este periodo");
  });
  test("supervisor usa todos sus conjuntos sin lista cliente", async () => {
    contexto.todosLosConjuntos = false; contexto.conjuntos.push({ condominioId: "conjunto-b", condominioNombre: "Sur", soloPropios: false }); await render();
    expect(contenedor.querySelector('select[name="conjunto"]').textContent).toContain("Todos mis conjuntos"); expect(argsReporte().condominioId).toBeUndefined(); expect(argsReporte().companiaId).toBeUndefined();
    expect(enlace("Consultar todos").getAttribute("href")).toContain("alcance=mis-conjuntos");
  });
  test("preparando/generando, archivo recibido, descargando y completado; doble clic produce una sola solicitud", async () => {
    let responder; globalThis.fetch = (url, opts) => { peticiones.push({ url, ...opts }); return new Promise((r) => { responder = r; }); };
    await render(); await act(() => { boton("Generar CSV").click(); boton("Generar CSV").click(); }); expect(contenedor.textContent).toMatch(/Preparando|Generando/); await tick();
    expect(contenedor.textContent).toContain("Generando"); expect(boton("Exportar Excel").disabled).toBe(true); expect(peticiones).toHaveLength(1); expect(descargas).toHaveLength(0);
    const body = JSON.parse(peticiones[0].body); const p = new URLSearchParams(body.parametros); expect(p.get("periodo")).toBe("personalizado"); expect(p.get("hasta")).toBe("2026-09-30"); expect(body.formato).toBe("csv");
    await act(() => responder(new Response("archivo", { headers: { "Content-Disposition": 'attachment; filename="incidentes-2026-09-01-2026-09-30.csv"' } }))); await tick();
    expect(descargas[0].nombre).toBe("incidentes-2026-09-01-2026-09-30.csv"); expect(contenedor.textContent).toContain("Completado"); expect(boton("Generar CSV").disabled).toBe(false);
  });
  test("helper emite los cinco pasos útiles solo tras recibir archivo completo", async () => {
    const estados = []; await descargarReporteIncidentes(new URLSearchParams(), "csv", (s) => estados.push(s), new AbortController().signal);
    expect(estados).toEqual(["Preparando", "Generando", "Descargando", "Completado"]);
  });
  test.each(["csv", "xlsx", "pdf"])("genera formato %s con filtros idénticos y nombre recibido del servidor", async (formato) => {
    globalThis.fetch = async (url, opts) => { peticiones.push(JSON.parse(opts.body)); return new Response("archivo", { headers: { "Content-Disposition": `attachment; filename="incidentes-norte-2026-09-01-2026-09-30.${formato}"` } }); };
    await render(); await click(boton({ csv: "Generar CSV", xlsx: "Exportar Excel", pdf: "Generar PDF" }[formato])); await tick();
    expect(peticiones[0].formato).toBe(formato); expect(descargas[0].nombre.endsWith(`.${formato}`)).toBe(true);
  });
  test.each(["El periodo es demasiado amplio. Acota el periodo o selecciona un conjunto.", "No hay incidentes para los filtros seleccionados.", "stack Convex storageKey secreto"])("error %s es útil, permite reintentar y oculta trazas", async (mensaje) => {
    globalThis.fetch = async () => Response.json({ error: mensaje }, { status: 422 }); await render(); await click(boton("Generar CSV")); await tick();
    expect(contenedor.querySelector('[role="alert"]')).toBeTruthy(); expect(contenedor.textContent).not.toContain("storageKey"); expect(descargas).toHaveLength(0); expect(boton("Generar CSV").disabled).toBe(false);
    expect(contenedor.textContent).toContain(mensaje.includes("stack") ? "No fue posible generar" : mensaje);
  });
  test("no descarga vacíos ni permite sobrepasar límite; no acceso separado de sin resultados", async () => {
    datos.total = 0; datos.reporte.filas = []; await render(); expect(contenedor.textContent).toContain("No hay incidentes"); expect(boton("Generar CSV").disabled).toBe(true);
    datos.total = 1001; await render(); expect(boton("Generar CSV").disabled).toBe(true); expect(contenedor.textContent).toContain("Máximo 1000");
    contexto = null; await render(); expect(contenedor.textContent).toContain("No tienes acceso"); expect(contenedor.querySelector("table")).toBeNull();
  });
  test("fallo de red se sanitiza y respuesta vacía nunca muestra éxito", async () => {
    globalThis.fetch = async () => { throw new Error("S3 storageKey privado"); }; await render(); await click(boton("Generar CSV")); await tick();
    expect(contenedor.textContent).not.toContain("storageKey"); expect(contenedor.textContent).toContain("No fue posible generar");
    globalThis.fetch = async () => new Response("", { headers: { "Content-Disposition": 'attachment; filename="incidentes-2026-09-01-2026-09-30.csv"' } }); await click(boton("Generar CSV")); await tick();
    expect(descargas).toHaveLength(0); expect(contenedor.textContent).not.toContain("Completado");
  });
  test("consulta fallida mantiene filtros y permite reintentar sin mostrar detalles internos", async () => {
    const original = console.error; console.error = () => {}; error = new Error("LIMITE_ANALITICA stack privado");
    try { await render(); } finally { console.error = original; }
    expect(contenedor.querySelector("form")).toBeTruthy(); expect(contenedor.textContent).toContain("periodo es demasiado amplio"); expect(contenedor.textContent).not.toContain("stack privado");
    error = undefined; await click(boton("Reintentar")); expect(contenedor.textContent).toContain("Resumen del reporte");
  });
  test("cambiar filtros cancela descarga anterior; nunca completa una descarga sin archivo", async () => {
    let responder; globalThis.fetch = (url, opts) => { peticiones.push({ url, ...opts }); return new Promise((r) => { responder = r; }); };
    await render(); await click(boton("Generar CSV")); await tick(); params = new URLSearchParams("periodo=hoy"); await render(); expect(peticiones[0].signal.aborted).toBe(true);
    await act(() => responder(new Response("archivo", { headers: { "Content-Disposition": 'attachment; filename="incidentes-2026-09-01-2026-09-30.csv"' } }))); await tick(); expect(descargas).toHaveLength(0); expect(contenedor.textContent).not.toContain("Completado");
  });
});
describe("endpoint autenticado y archivos server-side", () => {
  const solicitar = (formato = "csv", parametros = "periodo=personalizado&desde=2026-09-01&hasta=2026-09-30&conjunto=conjunto-a") => POST(new Request("http://localhost/api/incidentes/reporte", { method: "POST", body: JSON.stringify({ formato, parametros }) }));
  test("CSV usa consulta exportar autorizada y devuelve archivo completo, nombre y metadatos sin caché", async () => {
    const r = await solicitar(); expect(r.status).toBe(200); expect(servidorArgs).toMatchObject({ exportar: true, periodo: "personalizado", condominioId: "conjunto-a" }); expect(servidorArgs.companiaId).toBeUndefined();
    expect(r.headers.get("Content-Disposition")).toContain("incidentes-norte-2026-09-01-2026-09-30.csv"); expect(r.headers.get("Cache-Control")).toBe("private, no-store"); expect(r.headers.get("X-Reporte-Generado")).toBe("2026-09-30T15:30:00.000Z");
    const csv = await r.text(); expect(csv).toContain('"Referencia","Fecha reporte"'); expect(csv).toContain("caso-a"); expect(csv).toContain("2026-09-30 10:30:00.000 -05:00"); expect(csv).not.toContain("storageKey");
  });
  test("Excel contiene Resumen e Incidentes; referencias XML, contexto y tabla completos sin fórmulas", async () => {
    datos.reporte.filas[0].ubicacion = "=HYPERLINK(privado)";
    const r = await solicitar("xlsx"); const zip = await JSZip.loadAsync(await r.arrayBuffer());
    expect(r.headers.get("Content-Type")).toContain("spreadsheetml");
    const workbook = await zip.file("xl/workbook.xml").async("string"); expect(workbook).toContain('name="Resumen"'); expect(workbook).toContain('name="Incidentes"'); expect(workbook).toContain('localSheetId="1"');
    const strings = await zip.file("xl/sharedStrings.xml").async("string"); for (const v of ["Periodo desde", "2026-09-01", "Generado", "Estado", "Total", "caso-a", "=HYPERLINK(privado)"]) expect(strings).toContain(v);
    const shared = [...strings.matchAll(/<si><t[^>]*>([\s\S]*?)<\/t><\/si>/g)].map((m) => m[1]);
    const sheet2 = await zip.file("xl/worksheets/sheet2.xml").async("string"); expect(sheet2).not.toContain("<f>");
    const textos = [...sheet2.matchAll(/t="s"><v>(\d+)<\/v>/g)].map((m) => shared[Number(m[1])]); expect(textos).toContain("caso-a"); expect(textos).toContain("Fecha cierre"); expect(textos).toContain("=HYPERLINK(privado)");
    expect(await zip.file("xl/worksheets/_rels/sheet2.xml.rels").async("string")).toContain("table2.xml"); expect(await zip.file("xl/tables/table2.xml").async("string")).toContain('id="2"');
  });
  test("PDF usa paquete oficial con paginación, resumen y datos consultados", async () => {
    datos.reporte.filas = Array.from({ length: 8 }, (_, i) => ({ ...datos.reporte.filas[0], referencia: `referencia-${i}`, ubicacion: 'Ubicación extensa '.repeat(30) })); datos.total = 8;
    const r = await solicitar("pdf"); expect(r.status).toBe(200); const bytes = new Uint8Array(await r.arrayBuffer());
    const { PDFDocument } = await import("pdf-lib"); const pdf = await PDFDocument.load(bytes); expect(pdf.getPageCount()).toBeGreaterThan(1); expect(pdf.getTitle()).toBe("Reporte de incidentes"); expect(pdf.getCreationDate().toISOString()).toBe("2026-09-30T15:30:00.000Z");
    const { extractText } = await import("unpdf"); const texto = (await extractText(bytes, { mergePages: true })).text; expect(texto).toContain("Total: 8"); expect(texto).toContain("referencia-7"); expect(texto).toContain("Fecha cierre");
  });
  test("PDF rechaza caracteres no soportados y exceso de páginas sin entregar contenido parcial", async () => {
    datos.reporte.filas[0].ubicacion = "Portería 🏠";
    let r = await solicitar("pdf"); expect(r.status).toBe(422); expect(r.headers.get("Content-Disposition")).toBeNull(); expect((await r.json()).error).toContain("Exporta CSV o Excel");
    const fila = { ...datos.reporte.filas[0], ubicacion: "Portería" }; datos.reporte.filas = Array.from({ length: 400 }, (_, i) => ({ ...fila, referencia: `referencia-${i}` })); datos.total = 400;
    r = await solicitar("pdf"); expect(r.status).toBe(422); expect(r.headers.get("Content-Disposition")).toBeNull(); expect((await r.json()).error).toContain("periodo es demasiado amplio");
  });
  test.each([["LIMITE_EXPORTACION", 422, "periodo es demasiado amplio"], ["REPORTE_VACIO", 422, "No hay incidentes"], ["SIN_ACCESO_REPORTE", 403, "No tienes acceso"], ["stack S3 token privado", 500, "No fue posible generar"]])("fallo %s devuelve error seguro sin archivo", async (mensaje, status, esperado) => {
    servidorError = new Error(mensaje); const r = await solicitar(); expect(r.status).toBe(status); expect(r.headers.get("Content-Disposition")).toBeNull(); const body = await r.json(); expect(body.error).toContain(esperado); expect(body.error).not.toContain("token privado");
  });
  test("formato desconocido, body o parámetros malformados no invocan backend", async () => {
    expect((await solicitar("exe")).status).toBe(400); expect(servidorArgs).toBeUndefined(); expect((await solicitar("csv", "a".repeat(2001))).status).toBe(400);
  });
});
