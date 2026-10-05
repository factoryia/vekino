import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ETIQUETA_ESTADO_COBERTURA,
  decidirCancelacion,
  decidirInhabilitacion,
  decidirRespuesta,
  estaActiva,
  exigirInicioFuturo,
  proximoCambioDeContexto,
  validarMotivoInhabilitacion,
  ventanaQueOcupa,
  type CoberturaParaReglas,
  type EstadoCobertura,
} from "../convex/lib/coberturas.ts";
import { evaluarDisponibilidadGuarda } from "../convex/lib/disponibilidad.ts";

const HORA = 3_600_000;
const AHORA = Date.UTC(2026, 9, 5, 12, 0);

const cobertura = (
  estado: EstadoCobertura,
  extra: Partial<CoberturaParaReglas> = {},
): CoberturaParaReglas => ({
  estado,
  inicio: AHORA + 6 * HORA,
  fin: AHORA + 18 * HORA,
  ...extra,
});

test("los estados visibles no incluyen 'activa': se deriva", () => {
  assert.deepEqual(Object.values(ETIQUETA_ESTADO_COBERTURA), [
    "Pendiente",
    "Aceptada",
    "Rechazada",
    "Cancelada",
    "Inhabilitada",
  ]);
});

test("una cobertura nueva no empieza en el pasado, sin tolerancia", () => {
  assert.doesNotThrow(() => exigirInicioFuturo(AHORA, AHORA));
  assert.throws(() => exigirInicioFuturo(AHORA - 1, AHORA), /pasado/);
});

test("responder: solo una pendiente; aceptar, solo si no empezo", () => {
  assert.deepEqual(decidirRespuesta(cobertura("solicitada"), "aceptada", AHORA), { tipo: "permitido" });
  assert.deepEqual(decidirRespuesta(cobertura("solicitada"), "rechazada", AHORA), { tipo: "permitido" });
  const empezada = cobertura("solicitada", { inicio: AHORA - HORA });
  assert.equal(decidirRespuesta(empezada, "aceptada", AHORA).tipo, "error");
  // Rechazar una que ya empezo no daña a nadie.
  assert.equal(decidirRespuesta(empezada, "rechazada", AHORA).tipo, "permitido");
  for (const estado of ["aceptada", "rechazada", "cancelada", "inhabilitada"] as const) {
    const d = decidirRespuesta(cobertura(estado), "aceptada", AHORA);
    assert.equal(d.tipo, "error", estado);
  }
});

test("cancelar: pendiente o aceptada sin empezar; lo empezado se inhabilita", () => {
  assert.equal(decidirCancelacion(cobertura("solicitada"), AHORA).tipo, "permitido");
  assert.equal(decidirCancelacion(cobertura("aceptada"), AHORA).tipo, "permitido");
  const empezada = cobertura("aceptada", { inicio: AHORA - HORA });
  const d = decidirCancelacion(empezada, AHORA);
  assert.equal(d.tipo, "error");
  assert.match(d.tipo === "error" ? d.mensaje : "", /inhabilítala/);
  assert.equal(decidirCancelacion(cobertura("cancelada"), AHORA).tipo, "yaEstaba");
  assert.equal(decidirCancelacion(cobertura("rechazada"), AHORA).tipo, "error");
  assert.equal(decidirCancelacion(cobertura("inhabilitada"), AHORA).tipo, "error");
});

test("inhabilitar: solo una aceptada que no termino; no hay vuelta atras", () => {
  assert.equal(decidirInhabilitacion(cobertura("aceptada"), AHORA).tipo, "permitido");
  assert.equal(
    decidirInhabilitacion(cobertura("aceptada", { inicio: AHORA - HORA }), AHORA).tipo,
    "permitido",
  );
  assert.equal(
    decidirInhabilitacion(cobertura("aceptada", { inicio: AHORA - 9 * HORA, fin: AHORA - HORA }), AHORA).tipo,
    "error",
  );
  assert.equal(decidirInhabilitacion(cobertura("inhabilitada"), AHORA).tipo, "yaEstaba");
  for (const estado of ["solicitada", "rechazada", "cancelada"] as const) {
    assert.equal(decidirInhabilitacion(cobertura(estado), AHORA).tipo, "error", estado);
  }
  // Ni aceptar ni cancelar devuelven a la vida una inhabilitada.
  assert.equal(decidirRespuesta(cobertura("inhabilitada"), "aceptada", AHORA).tipo, "error");
  assert.equal(decidirCancelacion(cobertura("inhabilitada"), AHORA).tipo, "error");
});

test("el motivo de inhabilitacion es obligatorio y acotado", () => {
  assert.equal(validarMotivoInhabilitacion("  Se reintegro el titular  "), "Se reintegro el titular");
  assert.throws(() => validarMotivoInhabilitacion("   "), /motivo/);
  assert.throws(() => validarMotivoInhabilitacion("x".repeat(501)), /500/);
});

test("que ocupa al guarda: la aceptada entera, la inhabilitada hasta el corte", () => {
  assert.deepEqual(ventanaQueOcupa(cobertura("aceptada")), {
    inicio: AHORA + 6 * HORA,
    fin: AHORA + 18 * HORA,
  });
  assert.deepEqual(
    ventanaQueOcupa(cobertura("inhabilitada", { inhabilitadaEn: AHORA + 10 * HORA })),
    { inicio: AHORA + 6 * HORA, fin: AHORA + 10 * HORA },
  );
  // Inhabilitada antes de empezar: no ocupo nunca.
  assert.equal(ventanaQueOcupa(cobertura("inhabilitada", { inhabilitadaEn: AHORA })), null);
  for (const estado of ["solicitada", "rechazada", "cancelada"] as const) {
    assert.equal(ventanaQueOcupa(cobertura(estado)), null, estado);
  }
});

test("activa se deriva: aceptada y ahora dentro de [inicio, fin)", () => {
  const c = cobertura("aceptada", { inicio: AHORA - HORA, fin: AHORA + HORA });
  assert.equal(estaActiva(c, AHORA), true);
  assert.equal(estaActiva(c, AHORA + HORA), false);
  assert.equal(estaActiva(cobertura("aceptada"), AHORA), false); // aun no empieza
  assert.equal(estaActiva({ ...c, estado: "inhabilitada" }, AHORA), false);
  assert.equal(estaActiva({ ...c, estado: "solicitada" }, AHORA), false);
});

test("una cobertura que ocupa vuelve al guarda 'ocupado', en cualquier conjunto", () => {
  const ventana = { inicio: AHORA + 10 * HORA, fin: AHORA + 14 * HORA };
  const horarios = [
    {
      id: "h",
      condominioId: "A",
      fechaInicio: "2026-01-01",
      bloques: [0, 1, 2, 3, 4, 5, 6].map((dia) => ({ dia, horaInicio: "06:00", horaFin: "07:00" })),
    },
  ];
  const libre = evaluarDisponibilidadGuarda({ ventana, horarios, inasistencias: [] });
  assert.equal(libre.estado, "disponible");

  const ocupado = evaluarDisponibilidadGuarda({
    ventana,
    horarios,
    inasistencias: [],
    coberturas: [{ id: "c", condominioId: "B", inicio: AHORA + 6 * HORA, fin: AHORA + 18 * HORA }],
  });
  assert.equal(ocupado.estado, "ocupado");
  assert.deepEqual(ocupado.motivos, [
    { tipo: "cobertura", coberturaId: "c", condominioId: "B", inicio: AHORA + 6 * HORA, fin: AHORA + 18 * HORA },
  ]);

  // Pegada sin pisarse: no ocupa.
  const pegada = evaluarDisponibilidadGuarda({
    ventana,
    horarios,
    inasistencias: [],
    coberturas: [{ id: "c", condominioId: "B", inicio: AHORA, fin: AHORA + 10 * HORA }],
  });
  assert.equal(pegada.estado, "disponible");
});

test("el proximo cambio de contexto: el inicio de la que viene o el fin de la que corre", () => {
  assert.equal(proximoCambioDeContexto([], AHORA), null);

  const futura = cobertura("aceptada");
  assert.equal(proximoCambioDeContexto([futura], AHORA), futura.inicio);
  // En el instante exacto del inicio ya corre: lo proximo es su fin.
  assert.equal(proximoCambioDeContexto([futura], futura.inicio), futura.fin);
  assert.equal(proximoCambioDeContexto([futura], futura.fin - 1), futura.fin);
  // En el fin ya termino: no queda nada a la vista.
  assert.equal(proximoCambioDeContexto([futura], futura.fin), null);

  // Con varias, el mas proximo.
  const despues = cobertura("aceptada", { inicio: AHORA + 20 * HORA, fin: AHORA + 22 * HORA });
  assert.equal(proximoCambioDeContexto([despues, futura], AHORA + 7 * HORA), futura.fin);
  assert.equal(proximoCambioDeContexto([despues, futura], AHORA + 19 * HORA), despues.inicio);

  // Lo que no esta aceptado no cambia nada por el paso del tiempo.
  for (const estado of ["solicitada", "rechazada", "cancelada", "inhabilitada"] as const) {
    assert.equal(proximoCambioDeContexto([cobertura(estado)], AHORA), null, estado);
  }
});
