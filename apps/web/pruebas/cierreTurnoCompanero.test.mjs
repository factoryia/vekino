import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
const ventana = new Window({ url: "http://localhost" });
for (const clave of ["window", "document", "HTMLElement", "HTMLInputElement", "Event", "KeyboardEvent", "MouseEvent", "Node", "navigator"]) Object.defineProperty(globalThis, clave, { configurable: true, value: clave === "window" ? ventana : ventana[clave] });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");

/* La mutación es la del servidor; aquí solo se mira qué le manda la pantalla
 * y qué dice con lo que responde. */
let llamadas, responder, contenedor, root;
mock.module("convex/react", () => ({ useMutation: () => async (args) => { llamadas.push(args); return await responder(args); } }));
const { AvisoTurnoDeCompanero, CerrarTurnoCompaneroModal } = await import("../components/guardia/cerrar-turno-companero");

const turno = {
  _id: "turno-ana", _creationTime: 0, condominioId: "norte", guardiaUserId: "ana", guardiaNombre: "Ana Guarda",
  checklist: [{ item: "Radio", obligatorio: true, cantidadEsperada: 1, cantidadEncontrada: 1, estadoOk: true }],
  estado: "abierto", fechaInicio: Date.parse("2026-10-19T06:02:00-05:00"), createdAt: 0, updatedAt: 0,
  rondasCount: 2, cierraComo: "companero",
};
const ERROR_CONVEX = "[CONVEX M(guardia:cerrarTurnoDeCompanero)] [Request ID: abc] Server Error\nUncaught Error: El turno ya está cerrado.\n    at handler (../convex/guardia.ts:810:11)";

beforeEach(() => {
  llamadas = []; responder = async () => ({ ok: true });
  contenedor = document.createElement("div"); document.body.append(contenedor); root = createRoot(contenedor);
});
afterEach(async () => { await act(() => root.unmount()); contenedor.remove(); });

const texto = () => document.body.textContent.replace(/\s+/g, " ");
const boton = (titulo) => [...document.body.querySelectorAll("button")].find((b) => b.textContent.trim() === titulo);
async function click(el) { expect(el).toBeTruthy(); await act(async () => { el.click(); }); }

describe("El aviso del turno que dejó abierto un compañero", () => {
  test("explica el bloqueo, dice de quién es y ofrece cerrarlo", async () => {
    let pedido = 0;
    await act(() => root.render(createElement(AvisoTurnoDeCompanero, { turno, onCerrar: () => pedido++ })));
    expect(texto()).toContain("Este turno es de Ana Guarda y sigue abierto: para iniciar el tuyo, primero debe cerrarse.");
    expect(texto()).toContain("Si ya terminó su jornada y no lo cerró, puedes cerrarlo tú.");
    await click(boton("Cerrar turno de Ana Guarda"));
    expect(pedido).toBe(1);
    // Solo abre la confirmación: no cierra nada por sí solo.
    expect(llamadas).toEqual([]);
  });

  test("en un turno compartido nombra a los dos guardas", async () => {
    await act(() => root.render(createElement(AvisoTurnoDeCompanero, { turno: { ...turno, guardiaSecundarioNombre: "Pedro Apoyo" }, onCerrar: () => {} })));
    expect(texto()).toContain("Este turno es de Ana Guarda y Pedro Apoyo y sigue abierto");
  });
});

describe("La confirmación del cierre", () => {
  let cerrados, cerrados2;
  async function render() {
    cerrados = 0; cerrados2 = 0;
    await act(() => root.render(createElement(CerrarTurnoCompaneroModal, {
      turno, condominioId: "norte", onClose: () => cerrados++, onCerrado: () => cerrados2++,
    })));
  }

  test("pide confirmación explícita, dice que el turno es de otro y que quedará a su nombre", async () => {
    await render();
    expect(texto()).toContain("Cerrar el turno de otro guarda");
    expect(texto()).toContain("Vas a cerrar el turno de Ana Guarda, no uno tuyo.");
    expect(texto()).toContain("Abierto desde19/10/2026 06:02");
    expect(texto()).toContain("Checklist1 ítems");
    expect(texto()).toContain("Rondas2");
    expect(texto()).toContain("En la minuta quedará que lo cerraste tú, como compañero, y no Ana Guarda.");
    expect(llamadas).toEqual([]);
  });

  test("cancelar no cierra nada", async () => {
    await render();
    await click(boton("Cancelar"));
    expect(cerrados).toBe(1);
    expect(llamadas).toEqual([]);
    expect(cerrados2).toBe(0);
  });

  test("confirmar manda el turno y el conjunto seleccionado, y solo sigue si el servidor lo cerró", async () => {
    await render();
    await click(boton("Sí, cerrar su turno"));
    expect(llamadas).toEqual([{ turnoId: "turno-ana", condominioId: "norte" }]);
    expect(cerrados2).toBe(1);
    expect(cerrados).toBe(0);
  });

  test("si el servidor lo rechaza, dice por qué y no da por hecho el cierre", async () => {
    responder = async () => { throw new Error(ERROR_CONVEX); };
    await render();
    await click(boton("Sí, cerrar su turno"));
    expect(llamadas).toHaveLength(1);
    expect(document.body.querySelector('[role="alert"]').textContent).toBe("El turno ya está cerrado.");
    expect(cerrados2).toBe(0);
    expect(cerrados).toBe(0);
    // Se puede volver a intentar o cancelar.
    expect(boton("Sí, cerrar su turno").disabled).toBe(false);
    expect(boton("Cancelar").disabled).toBe(false);
  });

  test("mientras el servidor responde no se puede confirmar dos veces", async () => {
    let soltar;
    responder = () => new Promise((r) => { soltar = r; });
    await render();
    await click(boton("Sí, cerrar su turno"));
    expect(boton("Sí, cerrar su turno").disabled).toBe(true);
    expect(boton("Cancelar").disabled).toBe(true);
    await act(async () => { soltar({ ok: true }); });
    expect(llamadas).toHaveLength(1);
    expect(cerrados2).toBe(1);
  });
});
