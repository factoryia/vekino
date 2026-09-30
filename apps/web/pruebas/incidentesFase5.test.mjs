import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

const ventana = new Window({ url: "http://localhost", settings: { enableImageFileLoading: false, enableFileSystemHttpRequests: false, disableCSSFileLoading: true, disableJavaScriptFileLoading: true, handleDisabledFileLoadingAsSuccess: true } });
for (const clave of ["window", "document", "HTMLElement", "HTMLInputElement", "HTMLFormElement", "Event", "MouseEvent", "FormData", "File", "Blob", "Node", "navigator"]) {
  Object.defineProperty(globalThis, clave, { configurable: true, value: clave === "window" ? ventana : ventana[clave] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { getFunctionName } = await import("convex/server");
let personas, evidencias, caso;
const llamadas = [];
let accion, mutacion;
mock.module("convex/react", () => ({
  useQuery: (fn) => ({ "incidentes:listarPersonas": personas, "incidenteEvidencias:listar": evidencias, "incidentes:obtener": caso }[getFunctionName(fn)]),
  useMutation: (fn) => (args) => { const nombre = getFunctionName(fn); llamadas.push({ nombre, args }); return mutacion(nombre, args); },
  useAction: (fn) => (args) => { const nombre = getFunctionName(fn); llamadas.push({ nombre, args }); return accion(nombre, args); },
  usePaginatedQuery: () => ({ results: [], status: "Exhausted", loadMore: () => {} }),
}));
mock.module("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
mock.module("next/link", () => ({ default: ({ children, ...props }) => createElement("a", props, children) }));
const { Evidencias, ContenidoEvidencia } = await import("../components/vigilancia/incidente-evidencias");
const { Personas, FormularioPersona } = await import("../components/vigilancia/incidente-personas");
const { IncidenteVistaInicial } = await import("../components/vigilancia/incidente-vista-inicial");
const AHORA = Date.now();
const evidencia = { _id: "evidencia-a", nombre: "foto.jpg", mimeType: "image/jpeg", size: 1024, subidoPorNombre: "Ana Guarda", createdAt: AHORA };
const persona = { _id: "persona-a", nombre: "Juan", tipoPersona: "VISITANTE", documento: "123", observacion: "Testigo" };
let contenedor, root, componente;
const crearBlob = mock(() => "blob:http://localhost/vista-autorizada");
const revocarBlob = mock(() => {});
URL.createObjectURL = crearBlob; URL.revokeObjectURL = revocarBlob;
beforeEach(() => {
  llamadas.length = 0; crearBlob.mockClear(); revocarBlob.mockClear(); personas = []; evidencias = [];
  accion = () => Promise.resolve({ bytes: new Uint8Array([255, 216, 255]).buffer, nombre: "foto.jpg", mimeType: "image/jpeg" });
  mutacion = () => Promise.resolve();
  contenedor = document.createElement("div"); document.body.append(contenedor); root = createRoot(contenedor);
});
afterEach(async () => { await act(() => root.unmount()); contenedor.remove(); });
async function render(elemento) { componente = elemento; await act(() => root.render(elemento)); }
async function actualizar() { await act(() => root.render(createElement(componente.type, { ...componente.props }))); }
const boton = (texto) => [...contenedor.querySelectorAll("button")].find((b) => b.textContent === texto);
async function click(el) { expect(el).toBeTruthy(); await act(async () => { el.click(); }); }
async function submit(form) { await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }); }
async function elegir(archivo) {
  const input = contenedor.querySelector('input[type="file"]');
  Object.defineProperty(input, "files", { configurable: true, value: [archivo] });
  await act(() => input.dispatchEvent(new Event("change", { bubbles: true })));
}
function archivo(nombre = "foto.jpg", type = "image/jpeg", contenido = [255, 216, 255]) { return new File([new Uint8Array(contenido)], nombre, { type }); }

describe("evidencias en la ficha", () => {
  test("carga, vacío y metadatos privados, con permisos visibles y retiradas aparte", async () => {
    evidencias = undefined;
    await render(createElement(Evidencias, { incidenteId: "caso-a", agregar: false, retirar: false }));
    expect(contenedor.innerHTML).toContain("animate-pulse");
    expect(contenedor.textContent).not.toContain("No hay evidencias");
    evidencias = []; await actualizar(); expect(contenedor.textContent).toContain("No hay evidencias vigentes");
    evidencias = [evidencia, { ...evidencia, _id: "retirada", nombre: "incorrecta.pdf", mimeType: "application/pdf", retiradoEn: AHORA, retiradoPorNombre: "Supervisor", motivoRetiro: "Duplicada" }]; await actualizar();
    for (const texto of ["Evidencias del incidente", "foto.jpg", "image/jpeg", "Ana Guarda", "KiB", "Vigente", "Evidencias retiradas", "Supervisor", "Duplicada"]) expect(contenedor.textContent).toContain(texto);
    expect(boton("Agregar evidencia")).toBeUndefined(); expect(contenedor.textContent).not.toContain("Retirar evidencia");
    expect(contenedor.querySelector("img")).toBeNull(); expect(contenedor.innerHTML).not.toContain("https://");
  });

  test("archivo inválido falla antes de la action y conserva la selección", async () => {
    await render(createElement(Evidencias, { incidenteId: "caso-a", agregar: true, retirar: false }));
    await elegir(archivo("script.html", "text/html")); await submit(contenedor.querySelector("form"));
    expect(contenedor.querySelector('[role="alert"]').textContent).toContain("Solo se admiten");
    expect(contenedor.textContent).toContain("Seleccionado: script.html"); expect(llamadas).toHaveLength(0);
    await elegir({ name: "foto.jpg", type: "image/jpeg", size: 15 * 1024 * 1024 + 1 }); await submit(contenedor.querySelector("form"));
    expect(contenedor.querySelector('[role="alert"]').textContent).toContain("15 MiB"); expect(llamadas).toHaveLength(0);
  });

  test("subida correcta bloquea doble envío, limpia tras éxito y actualiza la lista reactiva", async () => {
    let terminar;
    accion = () => new Promise((resolve) => { terminar = resolve; });
    await render(createElement(Evidencias, { incidenteId: "caso-a", agregar: true, retirar: true }));
    await elegir(archivo()); await submit(contenedor.querySelector("form"));
    expect(contenedor.textContent).toContain("Validando y subiendo evidencia");
    expect(contenedor.querySelector("fieldset").disabled).toBe(true);
    await submit(contenedor.querySelector("form")); expect(llamadas).toHaveLength(1);
    expect(llamadas[0]).toMatchObject({ nombre: "incidenteArchivos:subir", args: { incidenteId: "caso-a", nombre: "foto.jpg", mimeType: "image/jpeg" } });
    expect(llamadas[0].args.bytes.byteLength).toBe(3); expect(llamadas[0].args).not.toHaveProperty("storageKey");
    await act(() => { evidencias = [evidencia]; terminar("evidencia-a"); }); await actualizar();
    expect(contenedor.textContent).toContain("Evidencia agregada y registrada");
    expect(contenedor.textContent).not.toContain("Seleccionado:"); expect(contenedor.textContent).toContain("Ana Guarda");
  });

  test("error de subida conserva archivo para reintentar y no expone trazas", async () => {
    accion = () => Promise.reject(new Error("stack /private/file.ts"));
    await render(createElement(Evidencias, { incidenteId: "caso-a", agregar: true, retirar: false }));
    await elegir(archivo()); await submit(contenedor.querySelector("form"));
    expect(contenedor.textContent).toContain("Conservamos tu selección"); expect(contenedor.textContent).toContain("Seleccionado: foto.jpg");
    expect(contenedor.textContent).not.toContain("stack"); expect(boton("Agregar evidencia").disabled).toBe(false);
  });

  test("preview exige autorización y libera su blob local; un rechazo nunca expone imagen", async () => {
    let responder;
    accion = () => new Promise((resolve) => { responder = resolve; });
    await render(createElement(ContenidoEvidencia, { evidencia }));
    expect(contenedor.querySelector("img")).toBeNull();
    await click(boton("Ver imagen")); expect(contenedor.textContent).toContain("Comprobando acceso");
    expect(llamadas[0]).toEqual({ nombre: "incidenteArchivos:acceder", args: { evidenciaId: "evidencia-a" } });
    await act(async () => responder({ bytes: new Uint8Array([255, 216, 255]).buffer, nombre: "foto.jpg", mimeType: "image/jpeg" }));
    expect(contenedor.querySelector("img").getAttribute("src")).toContain("blob:http://localhost/");
    expect(contenedor.querySelector("img").getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(crearBlob).toHaveBeenCalledTimes(1);
    accion = () => Promise.reject(new Error("No tiene acceso")); await click(boton("Ver imagen"));
    expect(contenedor.querySelector('[role="alert"]').textContent).toContain("No tienes acceso vigente"); expect(contenedor.querySelector("img")).toBeNull(); expect(revocarBlob).toHaveBeenCalledWith("blob:http://localhost/vista-autorizada");
  });

  test("fallo al cargar imagen permite solicitar autorización de nuevo", async () => {
    await render(createElement(ContenidoEvidencia, { evidencia })); await click(boton("Ver imagen"));
    await act(() => contenedor.querySelector("img").dispatchEvent(new Event("error")));
    expect(contenedor.querySelector('[role="alert"]').textContent).toContain("Solicita acceso de nuevo"); expect(contenedor.querySelector("img")).toBeNull();
  });

  test("documento usa descarga autorizada; retiro exige motivo y actualiza estado sin preview", async () => {
    evidencias = [{ ...evidencia, mimeType: "application/pdf", nombre: "acta.pdf" }];
    await render(createElement(Evidencias, { incidenteId: "caso-a", agregar: false, retirar: true }));
    await click(boton("Solicitar documento")); expect(llamadas[0].args).toEqual({ evidenciaId: "evidencia-a" });
    expect(contenedor.querySelector("a").textContent).toContain("Descargar documento autorizado");
    const form = contenedor.querySelector("form"); expect(form.querySelector("textarea").required).toBe(true); form.querySelector("textarea").value = "Archivo incorrecto";
    mutacion = async (_nombre, args) => { evidencias = [{ ...evidencias[0], retiradoEn: AHORA, retiradoPorNombre: "Juan Pérez", motivoRetiro: args.motivo }]; };
    await submit(form); await actualizar();
    expect(llamadas[1]).toEqual({ nombre: "incidenteEvidencias:retirar", args: { evidenciaId: "evidencia-a", motivo: "Archivo incorrecto" } });
    expect(contenedor.textContent).toContain("Evidencias retiradas"); expect(contenedor.textContent).toContain("Juan Pérez"); expect(contenedor.textContent).toContain("Archivo incorrecto");
    expect(contenedor.querySelector("a")).toBeNull(); expect(boton("Solicitar documento")).toBeUndefined();
  });

  test("consulta rechazada se propaga al boundary de la ficha", async () => {
    evidencias = { filter() { throw new Error("Lectura no autorizada"); } };
    await expect(render(createElement(Evidencias, { incidenteId: "caso-a", agregar: false, retirar: false }))).rejects.toThrow("Lectura no autorizada");
  });
});

describe("personas y actualización del expediente", () => {
  test("vigentes y retiradas se distinguen; permisos ocultan alta/edición/retiro", async () => {
    personas = [persona, { ...persona, _id: "retirada", nombre: "Marta", retiradoEn: AHORA, retiradoPorNombre: "Sofía", motivoRetiro: "No participó" }];
    await render(createElement(Personas, { incidenteId: "caso-a", agregar: false, editar: false, retirar: false }));
    for (const texto of ["Actualmente involucradas", "Juan", "Personas retiradas del caso", "Marta", "Sofía", "No participó"]) expect(contenedor.textContent).toContain(texto);
    for (const texto of ["Agregar persona involucrada", "Editar persona", "Retirar persona"]) expect(contenedor.textContent).not.toContain(texto);
  });

  test("alta y edición envían campos completos, conservan datos tras rechazo y admiten vaciar opcionales", async () => {
    let rechazar = true;
    const guardar = mock((args) => rechazar ? Promise.reject(new Error("Error de servidor")) : Promise.resolve(args));
    await render(createElement(FormularioPersona, { persona, guardar }));
    const form = contenedor.querySelector("form"); form.elements.nombre.value = "Juan Pérez"; form.elements.tipoPersona.value = "RESIDENTE"; form.elements.documento.value = ""; form.elements.observacion.value = "";
    await submit(form);
    expect(form.elements.nombre.value).toBe("Juan Pérez"); expect(form.elements.tipoPersona.value).toBe("RESIDENTE"); expect(contenedor.textContent).toContain("Conservamos tus datos");
    rechazar = false; await submit(form);
    expect(guardar.mock.calls[1][0]).toEqual({ nombre: "Juan Pérez", tipoPersona: "RESIDENTE", documento: undefined, observacion: undefined });
    expect(contenedor.textContent).toContain("Persona editada");
  });

  test("agregar persona actualiza ficha, limpiar solo tras éxito y retirar mueve al histórico", async () => {
    await render(createElement(Personas, { incidenteId: "caso-a", agregar: true, editar: true, retirar: true }));
    let form = contenedor.querySelector("form"); form.elements.nombre.value = "Juan"; form.elements.tipoPersona.value = "VISITANTE";
    mutacion = async (nombre, args) => { if (nombre === "incidentes:agregarPersona") personas = [persona]; else personas = [{ ...persona, retiradoEn: AHORA, retiradoPorNombre: "Ana", motivoRetiro: args.motivo }]; };
    await submit(form); await actualizar(); expect(llamadas[0].nombre).toBe("incidentes:agregarPersona"); expect(form.elements.nombre.value).toBe(""); expect(contenedor.textContent).toContain("Editar persona");
    form = [...contenedor.querySelectorAll("form")].find((f) => f.elements.motivo); form.elements.motivo.value = "No participó";
    await submit(form); await actualizar();
    expect(llamadas[1]).toEqual({ nombre: "incidentes:retirarPersona", args: { personaId: "persona-a", motivo: "No participó" } });
    expect(contenedor.textContent).toContain("Personas retiradas del caso"); expect(contenedor.textContent).not.toContain("Editar persona");
  });

  test("edición desde la lista utiliza personaId; rechazo de retiro mantiene motivo", async () => {
    personas = [persona];
    await render(createElement(Personas, { incidenteId: "caso-a", agregar: false, editar: true, retirar: true }));
    const forms = contenedor.querySelectorAll("form"); forms[0].elements.nombre.value = "Juan Pérez";
    await submit(forms[0]); expect(llamadas[0].args.personaId).toBe("persona-a"); expect(llamadas[0].args).not.toHaveProperty("incidenteId");
    mutacion = () => Promise.reject(new Error("No tiene permiso")); forms[1].elements.motivo.value = "Persona errónea"; await submit(forms[1]);
    expect(forms[1].elements.motivo.value).toBe("Persona errónea"); expect(contenedor.textContent).toContain("Ya no tienes permiso");
  });

  test("ficha cerrada conserva responsable histórico y todas las secciones sin acciones", async () => {
    caso = { _id: "caso-a", tipo: "ACCESO", prioridad: "MEDIA", estado: "CERRADO", condominioNombre: "Norte", ubicacion: "Portería", descripcion: "Hecho", reportadoPorNombre: "Guarda", responsableNombre: "Supervisor dado de baja", ocurrioEn: AHORA, reportadoEn: AHORA,
      permisos: { gestionar: false, cerrar: false, agregarPersona: false, editarPersona: false, retirarPersona: false, agregarEvidencia: false, retirarEvidencia: false }, transiciones: [] };
    personas = [persona]; evidencias = [evidencia];
    await render(createElement(IncidenteVistaInicial, { incidenteId: "caso-a", baseHref: "/vigilancia/incidentes", registrado: false }));
    for (const texto of ["Supervisor dado de baja", "Personas involucradas", "Evidencias del incidente", "Historial del incidente", "Caso cerrado"]) expect(contenedor.textContent).toContain(texto);
    for (const texto of ["Agregar evidencia", "Editar persona", "Retirar evidencia", "Retirar persona", "Agregar persona involucrada"]) expect(contenedor.textContent).not.toContain(texto);
  });
});
