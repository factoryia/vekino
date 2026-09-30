import { describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  argumentosCrearIncidente, fechaHoraLocal, mensajeErrorIncidente,
  registrarIncidenteUnaVez, validarIncidenteBorrador,
} from "../lib/incidentes-ui";
import { filtrosBandeja, requisitosTransicion, mensajeErrorGestion } from "../lib/incidentes-bandeja";

const AHORA = new Date(2026, 8, 29, 10, 30).getTime();
// Exportación opcional de las pantallas reales con datos sintéticos para revisión visual.
function guardarVista(nombre, html) {
  const directorio = process.env.INCIDENTES_PREVIEW;
  if (!directorio) return;
  mkdirSync(directorio, { recursive: true });
  writeFileSync(join(directorio, `${nombre}.html`), `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/estilos.css"><body style="background:hsl(var(--background));color:hsl(var(--foreground));font-family:Arial,sans-serif">${html}</body></html>`);
}
const valido = {
  condominioId: "conjunto-a", tipo: "ACCESO", prioridad: "MEDIA",
  ocurrioEn: "2026-09-29T10:00", ubicacion: "Portería principal",
  descripcion: "Se detectó un ingreso no autorizado.", personas: [],
};

describe("registro de incidentes", () => {
  test("campos obligatorios y conjunto fuera de alcance producen errores claros", () => {
    const errores = validarIncidenteBorrador({ ...valido, condominioId: "conjunto-b", tipo: "", prioridad: "", ubicacion: "", descripcion: "" }, ["conjunto-a"], AHORA);
    expect(Object.keys(errores).sort()).toEqual(["condominioId", "descripcion", "prioridad", "tipo", "ubicacion"]);
    expect(errores.condominioId).toContain("operación vigente");
  });

  test("la fecha inválida o futura se rechaza, sin limitar hechos anteriores", () => {
    expect(validarIncidenteBorrador({ ...valido, ocurrioEn: "invalida" }, ["conjunto-a"], AHORA).ocurrioEn).toBeTruthy();
    expect(validarIncidenteBorrador({ ...valido, ocurrioEn: "2026-09-29T11:00" }, ["conjunto-a"], AHORA).ocurrioEn).toContain("futura");
    expect(validarIncidenteBorrador({ ...valido, ocurrioEn: "2020-01-01T09:00" }, ["conjunto-a"], AHORA)).toEqual({});
    expect(fechaHoraLocal(new Date(2026, 8, 29, 10, 30))).toBe("2026-09-29T10:30");
  });

  test("longitudes y personas opcionales se validan antes de enviar", () => {
    const errores = validarIncidenteBorrador({
      ...valido, ubicacion: "x".repeat(201), descripcion: "x".repeat(5001),
      personas: [{ nombre: "", tipoPersona: "", documento: "x".repeat(81), observacion: "x".repeat(2001) }],
    }, ["conjunto-a"], AHORA);
    expect(Object.keys(errores)).toHaveLength(6);
    expect(errores["personas.0.nombre"]).toBeTruthy();
    expect(errores["personas.0.tipoPersona"]).toBeTruthy();
  });

  test("la mutación recibe solo los datos del hecho y personas, sin compañía, actor, reporte ni estado", () => {
    const payload = argumentosCrearIncidente({
      ...valido, ubicacion: "  Portería principal  ",
      personas: [{ nombre: "  Ana  ", tipoPersona: "VISITANTE", documento: " ", observacion: " Testigo " }],
    });
    expect(payload).toEqual({
      condominioId: "conjunto-a", tipo: "ACCESO", prioridad: "MEDIA",
      ocurrioEn: new Date(2026, 8, 29, 10).getTime(),
      ubicacion: "Portería principal", descripcion: valido.descripcion,
      personas: [{ nombre: "Ana", tipoPersona: "VISITANTE", observacion: "Testigo" }],
    });
    expect(Object.keys(payload)).not.toContain("companiaId");
    expect(Object.keys(payload)).not.toContain("reportadoPorUserId");
    expect(Object.keys(payload)).not.toContain("estado");
  });

  test("doble envío ejecuta la mutación una vez y conserva el bloqueo hasta navegar", async () => {
    const bloqueo = { current: false };
    let terminar;
    const crear = mock(() => new Promise((resolve) => { terminar = resolve; }));
    const primero = registrarIncidenteUnaVez(bloqueo, crear);
    const segundo = registrarIncidenteUnaVez(bloqueo, crear);
    expect(segundo).toBeNull();
    expect(crear).toHaveBeenCalledTimes(1);
    terminar("incidente-creado");
    expect(await primero).toBe("incidente-creado");
    expect(bloqueo.current).toBe(true);
  });

  test("si Convex rechaza, permite corregir y reintentar", async () => {
    const bloqueo = { current: false };
    await expect(registrarIncidenteUnaVez(bloqueo, () => Promise.reject(new Error("falló")))).rejects.toThrow("falló");
    expect(bloqueo.current).toBe(false);
    expect(await registrarIncidenteUnaVez(bloqueo, () => Promise.resolve("ok"))).toBe("ok");
  });

  test("errores de sesión, alcance y fallos inesperados no exponen trazas", () => {
    expect(mensajeErrorIncidente(new Error("No autenticado o perfil inexistente"))).toContain("sesión");
    expect(mensajeErrorIncidente(new Error("La compañía no tiene contrato vigente con este conjunto"))).toContain("conjunto");
    expect(mensajeErrorIncidente(new Error("stack: /private/server.ts:19"))).not.toContain("stack");
  });
});

let parametros = new URLSearchParams();
mock.module("next/navigation", () => ({ useRouter: () => ({ push: () => {} }), useSearchParams: () => parametros, usePathname: () => "/vigilancia/incidentes" }));
mock.module("next/link", () => ({ default: ({ href, children, ...props }) => createElement("a", { href, ...props }, children) }));
let respuestasConsulta = [];
let consultas = [];
let eventos = [];
mock.module("convex/react", () => ({
  useMutation: () => () => Promise.resolve("incidente-creado"),
  useQuery: (_query, args) => { consultas.push(args); return args === "skip" ? undefined : respuestasConsulta.shift(); },
  usePaginatedQuery: () => ({ results: eventos, status: "Exhausted", loadMore: () => {} }),
}));

describe("pantallas iniciales", () => {
  test("el formulario muestra los campos, estado inicial explicado y un único conjunto autorizado", async () => {
    const { IncidenteCrear } = await import("../components/vigilancia/incidente-crear");
    const html = renderToStaticMarkup(createElement(IncidenteCrear, {
      conjuntos: [{ condominioId: "conjunto-a", condominioNombre: "Conjunto Norte" }],
      baseHref: "/vigilancia/incidentes",
    }));
    for (const campo of ["Conjunto", "Tipo de incidente", "Prioridad", "Fecha y hora del hecho", "Ubicación dentro del conjunto", "Descripción", "Personas involucradas"]) {
      expect(html).toContain(campo);
    }
    expect(html).toContain("Conjunto Norte");
    expect(html).not.toContain("Conjunto Ajeno");
    expect(html).toContain("Registrar incidente");
    expect(html).not.toContain('name="estado"');
    expect(html).not.toContain('name="reportadoPorUserId"');
  });

  test("la entrada principal ofrece Nuevo incidente", async () => {
    respuestasConsulta = [{ companiaId: "compania-a", todosLosConjuntos: true, conjuntos: [{ condominioId: "conjunto-a", condominioNombre: "Conjunto Norte", crear: true }] }, { page: [], isDone: true, continueCursor: "" }, { page: [], isDone: true, continueCursor: "" }];
    const { IncidentesInicio } = await import("../components/vigilancia/incidentes-inicio");
    const html = renderToStaticMarkup(createElement(IncidentesInicio, {
      baseHref: "/vigilancia/incidentes",
    }));
    expect(html).toContain("Nuevo incidente");
    expect(html).toContain("/vigilancia/incidentes/nuevo");
  });

  test("tras la respuesta del servidor muestra confirmación y estado REPORTADO", async () => {
    respuestasConsulta = [{
      _id: "incidente-creado", tipo: "ACCESO", prioridad: "MEDIA", estado: "REPORTADO",
      condominioNombre: "Conjunto Norte", ubicacion: "Portería", descripcion: "Ingreso no autorizado",
      ocurrioEn: AHORA - 60_000, reportadoEn: AHORA, reportadoPorNombre: "Ana Guarda",
      permisos: { gestionar: false, cerrar: false, agregarPersona: true }, transiciones: [],
    }, []];
    const { IncidenteVistaInicial } = await import("../components/vigilancia/incidente-vista-inicial");
    const html = renderToStaticMarkup(createElement(IncidenteVistaInicial, {
      incidenteId: "incidente-creado", baseHref: "/vigilancia/incidentes", registrado: true,
    }));
    expect(html).toContain("El incidente fue registrado correctamente");
    expect(html).toContain("Reportado");
    expect(html).toContain("Conjunto Norte");
    expect(html).toContain("Referencia incidente-creado");
  });
});

const contexto = { companiaId: "compania-a", todosLosConjuntos: true, conjuntos: [{ condominioId: "conjunto-a", condominioNombre: "Conjunto Norte", crear: true }] };
const caso = { _id: "caso-a", condominioId: "conjunto-a", condominioNombre: "Conjunto Norte", tipo: "ACCESO", prioridad: "ALTA", estado: "EN_SEGUIMIENTO", ubicacion: "Portería", descripcion: "Descripción original", reportadoPorNombre: "Ana Guarda", responsableNombre: "Sofía", ocurrioEn: AHORA - 60000, reportadoEn: AHORA, permisos: { gestionar: true, cerrar: false, agregarPersona: true }, transiciones: ["EN_INVESTIGACION", "RESUELTO"] };

describe("bandeja operativa", () => {
  test("envía búsqueda y filtros combinados al servidor, conserva contexto/cursor y muestra solo proyección", async () => {
    parametros = new URLSearchParams("q=Portería&campo=ubicacion&conjunto=conjunto-a&estado=EN_SEGUIMIENTO&prioridad=ALTA&tipo=ACCESO&fecha=ocurrioEn&desde=2026-09-01&hasta=2026-09-30&cursor=pagina-2");
    consultas = [];
    respuestasConsulta = [contexto, { page: [caso], isDone: false, continueCursor: "pagina-3" }];
    const { IncidentesInicio } = await import("../components/vigilancia/incidentes-inicio");
    const html = renderToStaticMarkup(createElement(IncidentesInicio, { baseHref: "/vigilancia/incidentes" }));
    expect(consultas[1]).toMatchObject({ companiaId: "compania-a", condominioId: "conjunto-a", estado: "EN_SEGUIMIENTO", prioridad: "ALTA", tipo: "ACCESO", busqueda: "Portería", campoBusqueda: "ubicacion", fecha: "ocurrioEn", paginationOpts: { cursor: "pagina-2", numItems: 20 } });
    expect(consultas[1].desde).toBe(new Date(2026, 8, 1).getTime());
    for (const texto of ["Acceso", "Alta", "En seguimiento", "Conjunto Norte", "Reporte:", "Hecho:", "Sofía", "Siguiente página"]) expect(html).toContain(texto);
    expect(html).toContain("/vigilancia/incidentes/caso-a?volver=");
    expect(html).toContain("pagina-3");
    expect(html).not.toContain("Descripción original");
    guardarVista("bandeja", html);
    parametros = new URLSearchParams();
  });

  test("distingue sin incidentes, sin resultados y loading", async () => {
    const { IncidentesInicio } = await import("../components/vigilancia/incidentes-inicio");
    const render = () => renderToStaticMarkup(createElement(IncidentesInicio, { baseHref: "/vigilancia/incidentes" }));
    respuestasConsulta = [contexto, { page: [], isDone: true }, { page: [], isDone: true }];
    expect(render()).toContain("Todavía no hay incidentes registrados.");
    respuestasConsulta = [contexto, { page: [], isDone: true }, { page: [caso], isDone: true }];
    expect(render()).toContain("No encontramos incidentes con los filtros seleccionados.");
    respuestasConsulta = [contexto, undefined];
    const html = render();
    expect(html).not.toContain("Todavía no hay incidentes");
    expect(html).toContain("animate-pulse");
  });

  test("guarda fija conjunto de ruta y no ofrece selector global", async () => {
    respuestasConsulta = [{ ...contexto, todosLosConjuntos: false }, { page: [caso], isDone: true }];
    consultas = [];
    parametros = new URLSearchParams("conjunto=ajeno");
    const { IncidentesInicio } = await import("../components/vigilancia/incidentes-inicio");
    const html = renderToStaticMarkup(createElement(IncidentesInicio, { baseHref: "/guardia/conjunto-a/incidentes", condominioId: "conjunto-a" }));
    expect(consultas[1].condominioId).toBe("conjunto-a");
    expect(html).not.toContain('name="conjunto"');
    parametros = new URLSearchParams();
  });

  test("consulta rechazada se propaga a los boundaries de Vekino", async () => {
    respuestasConsulta = [contexto];
    const { IncidentesInicio } = await import("../components/vigilancia/incidentes-inicio");
    // El ErrorBoundary de React captura en cliente; SSR propaga el mismo error.
    const fallo = { get page() { throw new Error("Consulta rechazada por autorización"); }, isDone: true };
    respuestasConsulta.push(fallo);
    expect(() => renderToStaticMarkup(createElement(IncidentesInicio, { baseHref: "/vigilancia/incidentes" }))).toThrow("Consulta rechazada");
  });
});

describe("ficha operativa", () => {
  test("retroceso y resolución presentan sus campos obligatorios; cierre explica el bloqueo", async () => {
    const { CamposTransicionIncidente } = await import("../components/vigilancia/incidente-vista-inicial");
    const render = (actual, siguiente) => renderToStaticMarkup(createElement(CamposTransicionIncidente, { actual, siguiente }));
    const retroceso = render("EN_SEGUIMIENTO", "EN_INVESTIGACION");
    expect(retroceso).toContain("Motivo del retroceso");
    expect(retroceso).toContain('name="motivo"');
    expect(retroceso).toContain('required=""');
    const resolucion = render("EN_SEGUIMIENTO", "RESUELTO");
    expect(resolucion).toContain("Observación de resolución");
    expect(resolucion).toContain('name="resolucion"');
    expect(resolucion).toContain('required=""');
    const cierre = render("RESUELTO", "CERRADO");
    expect(cierre).toContain("bloquea cambios posteriores");
    expect(cierre).not.toContain("textarea");
  });

  test("separa información actual, personas e historial real y conserva vuelta a filtros", async () => {
    parametros = new URLSearchParams("volver=estado%3DEN_SEGUIMIENTO%26cursor%3Dpagina-2");
    eventos = [{ _id: "evento-a", tipo: "CAMBIO_PRIORIDAD", actorNombre: "Cristian", createdAt: AHORA, descripcion: "Prioridad actualizada.", cambios: [{ campo: "prioridad", antes: "MEDIA", despues: "ALTA" }] }];
    respuestasConsulta = [caso, [{ userId: "sup-a", nombre: "Sofía" }], [{ _id: "persona-a", nombre: "Juan", tipoPersona: "VISITANTE", observacion: "Testigo" }]];
    const { IncidenteVistaInicial } = await import("../components/vigilancia/incidente-vista-inicial");
    const html = renderToStaticMarkup(createElement(IncidenteVistaInicial, { incidenteId: "caso-a", baseHref: "/vigilancia/incidentes", registrado: false }));
    for (const texto of ["Información actual", "Descripción original", "Ana Guarda", "Sofía", "Personas involucradas", "Juan", "Historial del incidente", "Cristian", "MEDIA", "ALTA", "Registrar seguimiento", "Resolver incidente", "Volver a investigación"]) expect(html).toContain(texto);
    expect(html).not.toContain("Cerrar incidente");
    expect(html).toContain("cursor=pagina-2");
    expect(html).toContain("seleccion=caso-a");
    guardarVista("detalle", html);
    parametros = new URLSearchParams(); eventos = [];
  });

  test("cerrado y solo lectura no ofrecen mutaciones; resolución y cierre tienen fechas propias", async () => {
    const { IncidenteVistaInicial } = await import("../components/vigilancia/incidente-vista-inicial");
    respuestasConsulta = [{ ...caso, estado: "CERRADO", permisos: { gestionar: false, cerrar: false, agregarPersona: false }, transiciones: [], resolucionObservacion: "Acceso controlado", resueltoEn: AHORA, cerradoEn: AHORA + 60000 }, []];
    const html = renderToStaticMarkup(createElement(IncidenteVistaInicial, { incidenteId: "caso-a", baseHref: "/vigilancia/incidentes", registrado: false }));
    for (const texto of ["Caso cerrado", "Resolución declarada", "Acceso controlado", "Fecha de resolución", "Fecha de cierre"]) expect(html).toContain(texto);
    for (const texto of ["Registrar seguimiento", "Agregar persona involucrada", "Asignar responsable", "Gestionar incidente"]) expect(html).not.toContain(texto);
  });

  test("motivos y observaciones corresponden a las transiciones del dominio", () => {
    expect(requisitosTransicion("EN_SEGUIMIENTO", "EN_INVESTIGACION")).toEqual({ motivo: true, resolucion: false });
    expect(requisitosTransicion("RESUELTO", "EN_SEGUIMIENTO").motivo).toBe(true);
    expect(requisitosTransicion("EN_SEGUIMIENTO", "RESUELTO")).toEqual({ motivo: false, resolucion: true });
    expect(requisitosTransicion("RESUELTO", "CERRADO")).toEqual({ motivo: false, resolucion: false });
    expect(mensajeErrorGestion(new Error("privado/stack.ts"))).not.toContain("stack");
  });
});
