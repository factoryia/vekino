import { describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  argumentosCrearIncidente, fechaHoraLocal, mensajeErrorIncidente,
  registrarIncidenteUnaVez, validarIncidenteBorrador,
} from "../lib/incidentes-ui";

const AHORA = new Date(2026, 8, 29, 10, 30).getTime();
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

mock.module("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));
mock.module("next/link", () => ({ default: ({ href, children, ...props }) => createElement("a", { href, ...props }, children) }));
let respuestasConsulta = [];
mock.module("convex/react", () => ({
  useMutation: () => () => Promise.resolve("incidente-creado"),
  useQuery: () => respuestasConsulta.shift(),
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
    const { IncidentesInicio } = await import("../components/vigilancia/incidentes-inicio");
    const html = renderToStaticMarkup(createElement(IncidentesInicio, {
      conjuntos: [{ condominioId: "conjunto-a", condominioNombre: "Conjunto Norte" }],
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
    }, []];
    const { IncidenteVistaInicial } = await import("../components/vigilancia/incidente-vista-inicial");
    const html = renderToStaticMarkup(createElement(IncidenteVistaInicial, {
      incidenteId: "incidente-creado", baseHref: "/vigilancia/incidentes", registrado: true,
    }));
    expect(html).toContain("El incidente fue registrado correctamente");
    expect(html).toContain("REPORTADO");
    expect(html).toContain("Conjunto Norte");
    expect(html).toContain("Referencia incidente-creado");
  });
});
