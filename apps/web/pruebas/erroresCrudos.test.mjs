import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
const ventana = new Window({ url: "http://localhost" });
for (const clave of ["window", "document", "HTMLElement", "HTMLInputElement", "Event", "KeyboardEvent", "MouseEvent", "Node", "navigator", "localStorage"]) Object.defineProperty(globalThis, clave, { configurable: true, value: clave === "window" ? ventana : ventana[clave] });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { getFunctionName } = await import("convex/server");

/**
 * LOS RECHAZOS DE LA FASE 15 NO SE PINTAN EN CRUDO (QA-NEW-001).
 *
 * Se montan los componentes reales —el diálogo de editar persona y la minuta
 * de la portería— y el servidor simulado rechaza con el texto EXACTO que
 * entrega el cliente de Convex: prefijo, Request ID, archivo y línea. Lo que
 * se comprueba es lo que el usuario tiene delante, no qué función se llama.
 *
 * Lo único simulado es el servidor.
 */

let respuestas, rechazos, llamadas, contenedor, root;

mock.module("next/navigation", () => ({ useParams: () => ({ id: "c1" }) }));
mock.module("next/link", () => ({ default: ({ href, children, ...props }) => createElement("a", { ...props, href }, children) }));
mock.module("convex/react", () => {
  const llamar = (fn) => async (args) => {
    const nombre = getFunctionName(fn);
    llamadas.push({ nombre, args });
    if (rechazos[nombre]) throw new Error(rechazos[nombre]);
    return { ok: true };
  };
  return { useQuery: (fn) => respuestas[getFunctionName(fn)], useMutation: llamar, useAction: llamar };
});

const { evaluarPassword } = await import("@vekino/backend/passwordFuerte");
const { EditarPersonaDialog } = await import("../components/companias/editar-persona-dialog");
const { default: GuardiaMinutaHome } = await import("../app/guardia/[id]/page");

/** Lo que nunca debe ver el usuario. */
const PROHIBIDOS = ["Request ID", "Server Error", "CONVEX", "Uncaught", "at handler", ".ts:", "Called by client"];

/** El error tal cual lo entrega el cliente de Convex. `anidado`: una action que lo recibió de un `runQuery`. */
function crudo(fn, tipo, mensaje, { anidado = false, archivo = "companias.ts:1193:12" } = {}) {
  return `[CONVEX ${tipo}(${fn})] [Request ID: 9f0e1d2c3b4a5968] Server Error\nUncaught Error: ${anidado ? "Uncaught Error: " : ""}${mensaje}\n    at handler (../convex/${archivo})\n\n  Called by client`;
}

const EN_CONJUNTO = "Esa persona también pertenece a un conjunto. Su contraseña y su correo no se gestionan desde la compañía.";
const CUENTA_PROPIA = "Esa persona ya tenía su cuenta en Vekino. Su contraseña y su correo solo los cambia ella.";
const HUERFANO = "Tienes un turno pendiente de cierre en Conjunto Bosque. Ciérralo antes de iniciar otro.";

const PERSONA = {
  miembroId: "m1", nombre: "Ana Ruiz", email: "ana.ruiz@andina.co", firstName: "Ana", lastName: "Ruiz",
  tipoDocumento: "CC", numeroDocumento: "1013456789", telefono: null, cargo: null, passwordFijadaEn: null,
};
const CLAVE = "Faro-Quieto-58Kq";

beforeEach(() => {
  respuestas = {}; rechazos = {}; llamadas = [];
  contenedor = document.createElement("div"); document.body.append(contenedor); root = createRoot(contenedor);
});
afterEach(async () => { await act(() => root.unmount()); contenedor.remove(); document.body.innerHTML = ""; });

const dialogo = () => document.body.querySelector('[role="dialog"]');
const boton = (texto, dentro = document.body) => [...dentro.querySelectorAll("button")].find((b) => b.textContent.trim() === texto);
/** Escribe como lo haría el usuario: React solo ve el cambio si llega por el setter nativo + `input`. */
async function escribir(input, valor) {
  const setter = Object.getOwnPropertyDescriptor(ventana.HTMLInputElement.prototype, "value").set;
  await act(() => { setter.call(input, valor); input.dispatchEvent(new ventana.Event("input", { bubbles: true })); });
}
/** Clic y deja que la promesa del servidor se resuelva o rechace. */
async function pulsar(b) {
  expect(b).toBeTruthy();
  expect(b.disabled).toBe(false);
  await act(async () => { b.click(); await new Promise((r) => setTimeout(r, 0)); });
}
function sinRastroTecnico(texto) {
  for (const p of PROHIBIDOS) expect(texto).not.toContain(p);
}

// ─────────────────────────────────────────────────────────────
describe("Editar persona", () => {
  async function abrir() {
    respuestas["companias:detalleMiembro"] = PERSONA;
    await act(() => root.render(createElement(EditarPersonaDialog, { miembroId: "m1", rolActual: "guardia", onClose() {} })));
    expect(dialogo()).toBeTruthy();
  }

  test("cambio de correo rechazado: solo el mensaje funcional", async () => {
    rechazos["companias:setEmailMiembro"] = crudo("companias:setEmailMiembro", "A", CUENTA_PROPIA, { anidado: true });
    await abrir();
    await escribir(dialogo().querySelector('input[type="email"]'), "ana.nueva@andina.co");
    await pulsar(boton("Guardar cambios", dialogo()));

    expect(llamadas.map((l) => l.nombre)).toContain("companias:setEmailMiembro");
    const texto = dialogo().textContent;
    expect(texto).toContain(CUENTA_PROPIA);
    expect(texto).not.toContain("correo actualizados");
    sinRastroTecnico(texto);
  });

  test("cambio de clave rechazado: solo el mensaje funcional", async () => {
    expect(evaluarPassword(CLAVE, { email: PERSONA.email, nombre: PERSONA.nombre }).ok).toBe(true);
    rechazos["companias:setPasswordMiembro"] = crudo("companias:setPasswordMiembro", "A", EN_CONJUNTO, { anidado: true });
    await abrir();
    const [nueva, confirmar] = dialogo().querySelectorAll('input[type="password"]');
    await escribir(nueva, CLAVE);
    await escribir(confirmar, CLAVE);
    await pulsar(boton("Establecer nueva contraseña", dialogo()));

    expect(llamadas.map((l) => l.nombre)).toContain("companias:setPasswordMiembro");
    const texto = dialogo().textContent;
    expect(texto).toContain(EN_CONJUNTO);
    expect(texto).not.toContain("Contraseña establecida");
    sinRastroTecnico(texto);
  });

  test("regresión: guardar datos sin rechazo sigue confirmando", async () => {
    await abrir();
    await pulsar(boton("Guardar cambios", dialogo()));
    expect(llamadas.map((l) => l.nombre)).toEqual(["companias:actualizarMiembro"]);
    expect(dialogo().textContent).toContain("Datos actualizados.");
  });
});

// ─────────────────────────────────────────────────────────────
describe("Iniciar turno", () => {
  async function abrirModal() {
    respuestas["guardia:turnoActivo"] = null;
    respuestas["guardia:listMinuta"] = [];
    respuestas["guardia:listChecklistTemplate"] = [];
    await act(() => root.render(createElement(GuardiaMinutaHome)));
    await pulsar(boton("Iniciar turno"));
    expect(dialogo()).toBeTruthy();
    await escribir(dialogo().querySelector('input[placeholder="Tu nombre completo"]'), "José Pérez");
  }

  test("con un turno huérfano pendiente: sigue rechazado y sin el error de Convex", async () => {
    rechazos["guardia:iniciarTurno"] = crudo("guardia:iniciarTurno", "M", HUERFANO, { archivo: "guardia.ts:244:8" });
    await abrirModal();
    await pulsar(boton("Iniciar turno", dialogo()));

    expect(llamadas.map((l) => l.nombre)).toEqual(["guardia:iniciarTurno"]);
    expect(dialogo()).toBeTruthy();
    const texto = dialogo().textContent;
    expect(texto).toContain(HUERFANO);
    sinRastroTecnico(texto);
  });

  test("regresión: sin rechazo el turno se inicia y el modal se cierra", async () => {
    await abrirModal();
    await pulsar(boton("Iniciar turno", dialogo()));
    expect(llamadas.map((l) => l.nombre)).toEqual(["guardia:iniciarTurno"]);
    expect(llamadas[0].args.guardiaNombre).toBe("José Pérez");
    expect(dialogo()).toBeNull();
  });
});
