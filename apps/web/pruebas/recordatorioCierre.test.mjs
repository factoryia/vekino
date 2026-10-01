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

describe("Ventanas", () => {
  test("17:50 → recordatorio de la tarde, personalizado", async () => {
    await render();
    expect(dialogo()).toBeTruthy();
    expect(dialogo().textContent).toContain("Recordatorio de cierre de turno");
    expect(dialogo().textContent).toContain("Cambio de turno · 5:50 p. m.");
    expect(dialogo().textContent).toContain("Hola, José 👋");
    expect(dialogo().textContent).toContain("Recuerda que al finalizar tu turno debes cerrar correctamente el turno y cerrar sesión.");
    expect(dialogo().textContent).toContain("Esto ayuda a garantizar que tus registros queden asociados a tu cuenta y evita que otro guarda utilice tu sesión por accidente.");
    expect(registro("u1")).toEqual({ franja: "2026-10-01:evening", mostradoEn: co("2026-10-01T17:50:10").getTime() });
  });
  test("05:50 → recordatorio de la mañana", async () => {
    setSystemTime(co("2026-10-01T05:50:00")); await render();
    expect(dialogo().textContent).toContain("5:50 a. m.");
    expect(registro("u1").franja).toBe("2026-10-01:morning");
  });
  for (const [hora, esperado, caso] of [
    ["2026-10-01T05:49:00", null, "antes de 05:50"],
    ["2026-10-01T05:55:00", "5:50 a. m.", "caso 1"],
    ["2026-10-01T07:49:00", "5:50 a. m.", "fin de la ventana de la mañana"],
    ["2026-10-01T07:50:00", null, "desde 07:50"],
    ["2026-10-01T10:00:00", null, "caso 2"],
    ["2026-10-01T17:49:00", null, "antes de 17:50"],
    ["2026-10-01T17:55:00", "5:50 p. m.", "caso 3"],
    ["2026-10-01T19:49:00", "5:50 p. m.", "fin de la ventana de la tarde"],
    ["2026-10-01T19:50:00", null, "desde 19:50"],
    ["2026-10-01T23:00:00", null, "caso 4"],
  ]) {
    test(`al abrir a las ${hora.slice(11, 16)} (${caso}): ${esperado ? "muestra" : "no muestra"}`, async () => {
      setSystemTime(co(hora)); await render();
      if (esperado) expect(dialogo().textContent).toContain(esperado);
      else { expect(dialogo()).toBeNull(); expect(registro("u1")).toBeNull(); }
    });
  }
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
    setSystemTime(co("2026-10-01T19:30:00")); await enfocar();
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
  for (const [antes, despues, etiqueta] of [
    ["2026-10-01T05:49:59.900", "2026-10-01T05:50:00.300", "5:50 a. m."],
    ["2026-10-01T17:49:59.900", "2026-10-01T17:50:00.300", "5:50 p. m."],
  ]) {
    test(`caso 5 — app abierta: aparece sola al llegar las ${etiqueta}`, async () => {
      setSystemTime(co(antes)); await render();
      expect(dialogo()).toBeNull();
      setSystemTime(co(despues)); await espera(700);
      expect(dialogo().textContent).toContain(etiqueta);
    });
  }
  test("al cerrarse la ventana sin confirmar, el aviso se retira solo", async () => {
    setSystemTime(co("2026-10-01T19:49:59.900")); await render();
    expect(dialogo()).toBeTruthy();
    setSystemTime(co("2026-10-01T19:50:00.300")); await espera(700);
    expect(dialogo()).toBeNull();
    expect(registro("u1").confirmadoEn).toBeUndefined();
  });
  test("en segundo plano: al volver dentro de la ventana, sí; fuera, no", async () => {
    setSystemTime(co("2026-10-01T12:00:00")); await render();
    expect(dialogo()).toBeNull();
    visible = "hidden"; await emitir(document, new ventana.Event("visibilitychange"));
    setSystemTime(co("2026-10-01T18:30:00"));
    visible = "visible"; await emitir(document, new ventana.Event("visibilitychange"));
    expect(dialogo().textContent).toContain("5:50 p. m.");
    visible = "hidden"; await emitir(document, new ventana.Event("visibilitychange"));
    setSystemTime(co("2026-10-01T22:00:00"));
    visible = "visible"; await emitir(document, new ventana.Event("visibilitychange"));
    expect(dialogo()).toBeNull();
  });
  test("caso 6 — app cerrada, se abre a las 06:30: sale", async () => {
    setSystemTime(co("2026-10-01T03:00:00")); await render();
    expect(dialogo()).toBeNull();
    await act(() => root.unmount());
    setSystemTime(co("2026-10-01T06:30:00")); root = createRoot(contenedor); await render();
    expect(dialogo().textContent).toContain("5:50 a. m.");
  });
  test("reinicio: lo confirmado sobrevive; lo no confirmado vuelve a salir en la ventana", async () => {
    await render();
    setSystemTime(co("2026-10-01T18:10:00")); await remontar();
    expect(dialogo()).toBeTruthy();
    await confirmar();
    setSystemTime(co("2026-10-01T18:20:00")); await remontar();
    expect(dialogo()).toBeNull();
  });
  test("cambio de día: noche y madrugada sin aviso, el nuevo día abre el suyo", async () => {
    await render(); await confirmar();
    for (const hora of ["2026-10-01T23:00:00", "2026-10-02T00:30:00", "2026-10-02T04:00:00"]) {
      setSystemTime(co(hora)); await enfocar();
      expect(dialogo()).toBeNull();
    }
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
    expect(dialogo().textContent).toContain("debes cerrar correctamente el turno y cerrar sesión");
  });
});
