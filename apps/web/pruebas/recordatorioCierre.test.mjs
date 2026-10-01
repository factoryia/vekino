import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from "bun:test";
import { Window } from "happy-dom";
const ventana = new Window({ url: "http://localhost" });
for (const clave of ["window", "document", "HTMLElement", "HTMLInputElement", "Event", "KeyboardEvent", "MouseEvent", "Node", "navigator"]) Object.defineProperty(globalThis, clave, { configurable: true, value: clave === "window" ? ventana : ventana[clave] });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");

let turno, consultas, contenedor, root, visible;
mock.module("convex/react", () => ({ useQuery: (_fn, args) => { consultas.push(args); return args === "skip" ? undefined : turno; } }));
const { RecordatorioCierreTurno } = await import("../components/guardia/recordatorio-cierre");
const { recibeRecordatorioCierre } = await import("../lib/role-routing");

/** Instante en hora de Colombia. */
const co = (iso) => new Date(`${iso}-05:00`);
const espera = (ms) => act(() => new Promise((r) => setTimeout(r, ms)));
const almacen = () => ventana.localStorage;
const registro = (userId) => JSON.parse(almacen().getItem(`vekino:recordatorio-cierre:${userId}`) ?? "null");

Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visible });

beforeEach(() => {
  almacen().clear(); turno = null; consultas = []; visible = "visible";
  setSystemTime(co("2026-10-01T17:50:10"));
  contenedor = document.createElement("div"); document.body.append(contenedor); root = createRoot(contenedor);
});
afterEach(async () => { await act(() => root.unmount()); contenedor.remove(); setSystemTime(); });

const props = { condominioId: "c1", userId: "u1", nombre: "José Pérez", activo: true };
async function render(extra = {}) { await act(() => root.render(createElement(RecordatorioCierreTurno, { ...props, ...extra }))); }
async function remontar(extra = {}) { await act(() => root.unmount()); root = createRoot(contenedor); await render(extra); }
async function emitir(blanco, evento) { await act(() => { blanco.dispatchEvent(evento); }); }
const enfocar = () => emitir(window, new ventana.Event("focus"));
const dialogo = () => document.body.querySelector('[role="alertdialog"]');
const casilla = () => dialogo()?.querySelector('input[type="checkbox"]');
const entendido = () => [...(dialogo()?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Entendido");
async function confirmar() { await act(() => casilla().click()); await act(() => entendido().click()); }

describe("Quién recibe el recordatorio", () => {
  const r = (rolesConjunto, rolesAsignacion = [], esPlataforma = false) => recibeRecordatorioCierre({ esPlataforma, rolesConjunto, rolesAsignacion });
  test("guarda del conjunto o de compañía: sí", () => {
    expect(r(["guardia"])).toBe(true);
    expect(r(["guardia", "propietario"])).toBe(true);
    expect(r([], ["guardia"])).toBe(true);
  });
  test("supervisor, administración, junta, plataforma y residentes: no", () => {
    expect(r([], ["supervisor"])).toBe(false);
    expect(r(["guardia"], ["supervisor"])).toBe(false);
    expect(r(["administrador"])).toBe(false);
    expect(r(["administrador", "guardia"])).toBe(false);
    expect(r(["administrador"], ["guardia"])).toBe(false);
    expect(r(["contadora", "guardia"])).toBe(false);
    expect(r(["junta_directiva"])).toBe(false);
    expect(r(["propietario", "residente"])).toBe(false);
    expect(r(["guardia"], [], true)).toBe(false);
    expect(r([], [])).toBe(false);
  });
  test("si el rol no aplica, ni se muestra ni se consulta el turno", async () => {
    await render({ activo: false });
    expect(dialogo()).toBeNull();
    expect(consultas.every((a) => a === "skip")).toBe(true);
    expect(registro("u1")).toBeNull();
  });
});

describe("Horarios", () => {
  test("17:50 → recordatorio de la tarde, personalizado", async () => {
    await render();
    expect(dialogo()).toBeTruthy();
    expect(dialogo().textContent).toContain("Recordatorio de cierre de turno");
    expect(dialogo().textContent).toContain("Cambio de turno · 5:50 p. m.");
    expect(dialogo().textContent).toContain("Hola, José 👋");
    expect(registro("u1")).toEqual({ franja: "2026-10-01:evening", mostradoEn: co("2026-10-01T17:50:10").getTime() });
  });
  test("05:50 → recordatorio de la mañana", async () => {
    setSystemTime(co("2026-10-01T05:50:00")); await render();
    expect(dialogo().textContent).toContain("5:50 a. m.");
    expect(registro("u1").franja).toBe("2026-10-01:morning");
  });
  test("antes del horario no se adelanta; después, sí", async () => {
    almacen().setItem("vekino:recordatorio-cierre:u1", JSON.stringify({ franja: "2026-09-30:evening", mostradoEn: 1, confirmadoEn: 2 }));
    setSystemTime(co("2026-10-01T05:49:00")); await render();
    expect(dialogo()).toBeNull();
    setSystemTime(co("2026-10-01T05:51:00")); await enfocar();
    expect(dialogo().textContent).toContain("5:50 a. m.");
  });
});

describe("Confirmación consciente", () => {
  test("casilla desmarcada y botón deshabilitado hasta marcarla", async () => {
    await render();
    expect(casilla().checked).toBe(false);
    expect(entendido().disabled).toBe(true);
    await act(() => casilla().click());
    expect(casilla().checked).toBe(true);
    expect(entendido().disabled).toBe(false);
  });
  test("no se descarta tocando fuera ni con Escape, y Escape no llega a lo de debajo", async () => {
    await render();
    let llegoAbajo = false;
    const abajo = (e) => { if (e.key === "Escape") llegoAbajo = true; };
    document.addEventListener("keydown", abajo);
    await act(() => dialogo().parentElement.click());
    await emitir(casilla(), new ventana.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    document.removeEventListener("keydown", abajo);
    expect(dialogo()).toBeTruthy();
    expect(llegoAbajo).toBe(false);
    expect(dialogo().querySelector('[aria-label="Cerrar"]')).toBeNull();
  });
  test("confirmar guarda la franja atendida y no vuelve a salir en ella", async () => {
    await render(); await confirmar();
    expect(dialogo()).toBeNull();
    const r = registro("u1");
    expect(r.franja).toBe("2026-10-01:evening");
    expect(r.confirmadoEn).toBe(co("2026-10-01T17:50:10").getTime());
    setSystemTime(co("2026-10-01T21:00:00")); await enfocar();
    expect(dialogo()).toBeNull();
    await remontar();
    expect(dialogo()).toBeNull();
  });
  test("con el almacenamiento bloqueado tampoco se repite", async () => {
    const proto = Object.getPrototypeOf(almacen());
    const { getItem, setItem } = proto;
    proto.getItem = () => { throw new Error("bloqueado"); };
    proto.setItem = () => { throw new Error("bloqueado"); };
    try {
      await render(); await confirmar();
      setSystemTime(co("2026-10-01T17:55:00")); await enfocar();
      expect(dialogo()).toBeNull();
    } finally { proto.getItem = getItem; proto.setItem = setItem; }
  });
});

describe("Ciclo de vida", () => {
  test("app abierta: aparece sola al llegar la hora", async () => {
    almacen().setItem("vekino:recordatorio-cierre:u1", JSON.stringify({ franja: "2026-10-01:morning", mostradoEn: 1, confirmadoEn: 2 }));
    setSystemTime(co("2026-10-01T17:49:59.900")); await render();
    expect(dialogo()).toBeNull();
    setSystemTime(co("2026-10-01T17:50:00.300")); await espera(700);
    expect(dialogo()).toBeTruthy();
  });
  test("en segundo plano: al volver después de la hora", async () => {
    almacen().setItem("vekino:recordatorio-cierre:u1", JSON.stringify({ franja: "2026-10-01:morning", mostradoEn: 1, confirmadoEn: 2 }));
    setSystemTime(co("2026-10-01T12:00:00")); await render();
    expect(dialogo()).toBeNull();
    visible = "hidden"; await emitir(document, new ventana.Event("visibilitychange"));
    setSystemTime(co("2026-10-01T18:30:00"));
    visible = "visible"; await emitir(document, new ventana.Event("visibilitychange"));
    expect(dialogo().textContent).toContain("5:50 p. m.");
  });
  test("reabierta después de la hora (reinicio): sale si no se confirmó", async () => {
    setSystemTime(co("2026-10-01T12:00:00")); await render(); await confirmar();
    setSystemTime(co("2026-10-01T19:00:00")); await remontar();
    expect(dialogo().textContent).toContain("5:50 p. m.");
  });
  test("cambio de día con la app abierta: medianoche no repite, 05:50 sí", async () => {
    await render(); await confirmar();
    setSystemTime(co("2026-10-02T00:30:00")); await enfocar();
    expect(dialogo()).toBeNull();
    setSystemTime(co("2026-10-02T05:50:30")); await enfocar();
    expect(dialogo().textContent).toContain("5:50 a. m.");
    expect(registro("u1").franja).toBe("2026-10-02:morning");
  });
  test("otra pestaña confirma: se cierra aquí también", async () => {
    await render();
    almacen().setItem("vekino:recordatorio-cierre:u1", JSON.stringify({ franja: "2026-10-01:evening", mostradoEn: 1, confirmadoEn: 2 }));
    const evento = new ventana.Event("storage"); Object.defineProperty(evento, "key", { value: "vekino:recordatorio-cierre:u1" });
    await emitir(window, evento);
    expect(dialogo()).toBeNull();
  });
});

describe("Identidad", () => {
  test("logout/login con otra cuenta: saluda a quien está en sesión y no hereda lo confirmado", async () => {
    await render(); await confirmar();
    await render({ userId: "u2", nombre: "María López" });
    expect(dialogo().textContent).toContain("Hola, María 👋");
    expect(dialogo().textContent).not.toContain("José");
    await confirmar();
    await render();
    expect(dialogo()).toBeNull();
    expect(registro("u1").confirmadoEn).toBeTruthy();
    expect(registro("u2").confirmadoEn).toBeTruthy();
  });
});

describe("Turno", () => {
  test("con turno propio abierto lo menciona; sin turno o ajeno, no", async () => {
    turno = { guardiaUserId: "u1", fechaInicio: co("2026-10-01T06:02:00").getTime() };
    await render();
    expect(consultas.at(-1)).toEqual({ condominioId: "c1" });
    expect(dialogo().textContent).toContain("Desde las 6:02 a. m. tienes un turno abierto. Ciérralo en la Minuta");
    turno = { guardiaUserId: "otro", guardiaSecundarioUserId: "u1", fechaInicio: co("2026-10-01T06:02:00").getTime() };
    await render({ nombre: "José Pérez " });
    expect(dialogo().textContent).toContain("tienes un turno abierto");
    turno = { guardiaUserId: "otro", fechaInicio: 1 };
    await render({ nombre: "José" });
    expect(dialogo().textContent).not.toContain("turno abierto");
    turno = null;
    await render({ nombre: "José  Pérez" });
    expect(dialogo().textContent).not.toContain("turno abierto");
    expect(dialogo().textContent).toContain("debes cerrar el turno y cerrar sesión");
  });
});
