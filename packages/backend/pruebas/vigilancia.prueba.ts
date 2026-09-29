import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cabeDentro,
  capacidadesDePlataforma,
  capacidadesDeRolAsignacion,
  capacidadesDeRolesCompania,
  capacidadesDeRolesConjunto,
  estaVigente,
  estadoVigencia,
  haySolape,
  unir,
  vigentes,
  CAPACIDADES,
  type Rango,
} from "../convex/lib/vigilancia.ts";

/** 2026: enero, junio y julio. El calendario del ejemplo de la especificacion. */
const D = (mes: number, dia: number) => new Date(2026, mes - 1, dia).getTime();

const ENERO = D(1, 1);
const JUNIO_30 = D(6, 30);
const JULIO_1 = D(7, 1);
const DICIEMBRE_31 = D(12, 31);

// ─────────────────────────────────────────────────────────────
// Vigencias
// ─────────────────────────────────────────────────────────────

test("un contrato sin fecha de fin es indefinido", () => {
  const r: Rango = { vigenciaDesde: ENERO };
  assert.equal(estaVigente(r, D(6, 15)), true);
  assert.equal(estaVigente(r, D(12, 31)), true);
  assert.equal(estadoVigencia(r, D(6, 15)), "vigente");
});

test("el que empieza manana todavia no vale", () => {
  const r: Rango = { vigenciaDesde: JULIO_1 };
  assert.equal(estaVigente(r, JUNIO_30), false);
  assert.equal(estadoVigencia(r, JUNIO_30), "programada");
});

test("el que vence 'el 30' cubre el 30 completo, no hasta las 00:00", () => {
  const r: Rango = { vigenciaDesde: ENERO, vigenciaHasta: JUNIO_30 };
  /* Es la regla que ya aplica model/authz.ts a los vinculos de unidad. Si
   * aqui fuera distinta, un arrendatario y un guarda con la misma fecha de
   * fin perderian el acceso en dias distintos. */
  assert.equal(estaVigente(r, JUNIO_30), true);
  assert.equal(estaVigente(r, JUNIO_30 + 23 * 60 * 60 * 1000), true);
  assert.equal(estaVigente(r, JULIO_1), false);
  assert.equal(estadoVigencia(r, JULIO_1), "terminada");
});

/**
 * EL CORTE INMEDIATO.
 *
 * `vigenciaHasta` es una fecha y `finDe` le regala el dia entero. Terminar un
 * contrato "hoy" escribiendo la fecha de hoy lo dejaba vigente 24 horas mas:
 * el boton no cambiaba nada y el personal seguia entrando. `terminadoEn` dice
 * el instante exacto y manda sobre la fecha pactada.
 */
test("terminar ahora corta ahora, no manana", () => {
  const mediodia = JUNIO_30 + 12 * 60 * 60 * 1000;
  const pactado: Rango = { vigenciaDesde: ENERO, vigenciaHasta: JUNIO_30 };
  // Antes: escribir la fecha de hoy dejaba el resto del dia vigente.
  assert.equal(estaVigente(pactado, mediodia), true);

  const cortado: Rango = { ...pactado, terminadoEn: mediodia };
  assert.equal(estaVigente(cortado, mediodia), false);
  assert.equal(estadoVigencia(cortado, mediodia), "terminada");
  // Un segundo antes seguia cubriendo: el corte es exacto.
  assert.equal(estaVigente(cortado, mediodia - 1000), true);
});

test("el corte no puede alargar lo pactado", () => {
  /* Un `terminadoEn` posterior al fin pactado no resucita nada: manda el que
   * llegue primero. */
  const r: Rango = {
    vigenciaDesde: ENERO,
    vigenciaHasta: JUNIO_30,
    terminadoEn: DICIEMBRE_31,
  };
  assert.equal(estaVigente(r, JULIO_1), false);
});

test("un contrato indefinido tambien se puede cortar", () => {
  const r: Rango = { vigenciaDesde: ENERO, terminadoEn: JUNIO_30 };
  assert.equal(estaVigente(r, JUNIO_30 - 1000), true);
  assert.equal(estaVigente(r, JUNIO_30), false);
  assert.equal(estadoVigencia(r, JULIO_1), "terminada");
});

test("cancelar algo que aun no empezaba lo deja terminado, no programado", () => {
  /* Sin esto, un contrato que arranca en julio y se cancela en enero se leia
   * como "programada" hasta julio: en la pantalla parecia que seguia en pie. */
  const r: Rango = { vigenciaDesde: JULIO_1, terminadoEn: ENERO };
  assert.equal(estadoVigencia(r, D(3, 1)), "terminada");
  assert.equal(estaVigente(r, D(8, 1)), false);
});

test("un contrato cortado deja sitio para el siguiente", () => {
  /* Terminar y volver a contratar la misma empresa es un caso real: si el
   * cortado siguiera ocupando su rango, `crearContrato` lo veria como solape
   * y no dejaria. */
  const cortado: Rango = { vigenciaDesde: ENERO, terminadoEn: JUNIO_30 };
  const nuevo: Rango = { vigenciaDesde: JULIO_1 };
  assert.equal(haySolape(cortado, nuevo), false);
});

test("terminar la compania no cambia como se leen los rangos sin corte", () => {
  /* Regresion: todo lo que ya existe no lleva `terminadoEn` y tiene que
   * comportarse exactamente igual que antes. */
  const r: Rango = { vigenciaDesde: ENERO, vigenciaHasta: JUNIO_30 };
  assert.equal(estadoVigencia(r, D(3, 1)), "vigente");
  assert.equal(estadoVigencia(r, JUNIO_30), "vigente");
  assert.equal(estadoVigencia(r, JULIO_1), "terminada");
  assert.equal(estadoVigencia({ vigenciaDesde: JULIO_1 }, ENERO), "programada");
});

test("vigentes deja solo lo que cubre el instante pedido", () => {
  const lista: Rango[] = [
    { vigenciaDesde: ENERO, vigenciaHasta: JUNIO_30 },
    { vigenciaDesde: JULIO_1, vigenciaHasta: DICIEMBRE_31 },
    { vigenciaDesde: D(9, 1) },
  ];
  assert.equal(vigentes(lista, D(3, 10)).length, 1);
  assert.equal(vigentes(lista, D(7, 15)).length, 1);
  assert.equal(vigentes(lista, D(10, 5)).length, 2);
});

// ─────────────────────────────────────────────────────────────
// Solapes — la regla que impide asignaciones incompatibles
// ─────────────────────────────────────────────────────────────

test("un relevo limpio no es un solape", () => {
  /* Enero-junio y julio-diciembre se tocan en el borde. Tratarlo como
   * conflicto obligaria a dejar un dia sin vigilancia. */
  const a: Rango = { vigenciaDesde: ENERO, vigenciaHasta: JUNIO_30 };
  const b: Rango = { vigenciaDesde: JULIO_1, vigenciaHasta: DICIEMBRE_31 };
  assert.equal(haySolape(a, b), false);
  assert.equal(haySolape(b, a), false);
});

test("dos periodos que se pisan un solo dia si son solape", () => {
  const a: Rango = { vigenciaDesde: ENERO, vigenciaHasta: JULIO_1 };
  const b: Rango = { vigenciaDesde: JULIO_1, vigenciaHasta: DICIEMBRE_31 };
  assert.equal(haySolape(a, b), true);
});

test("dos indefinidos siempre se solapan", () => {
  assert.equal(
    haySolape({ vigenciaDesde: ENERO }, { vigenciaDesde: JULIO_1 }),
    true,
  );
});

test("uno indefinido se solapa con todo lo posterior", () => {
  const abierto: Rango = { vigenciaDesde: ENERO };
  const cerrado: Rango = { vigenciaDesde: JULIO_1, vigenciaHasta: DICIEMBRE_31 };
  assert.equal(haySolape(abierto, cerrado), true);
});

test("lo anterior a un indefinido no se solapa con el", () => {
  const viejo: Rango = { vigenciaDesde: ENERO, vigenciaHasta: JUNIO_30 };
  const abierto: Rango = { vigenciaDesde: JULIO_1 };
  assert.equal(haySolape(viejo, abierto), false);
});

// ─────────────────────────────────────────────────────────────
// La asignacion tiene que caber en el contrato
// ─────────────────────────────────────────────────────────────

test("una asignacion dentro del contrato cabe", () => {
  const contrato: Rango = { vigenciaDesde: ENERO, vigenciaHasta: DICIEMBRE_31 };
  assert.equal(
    cabeDentro({ vigenciaDesde: JULIO_1, vigenciaHasta: D(9, 30) }, contrato),
    true,
  );
});

test("una asignacion que dura mas que el contrato no cabe", () => {
  /* Prometeria un acceso que el modelo va a negar, y el error apareceria en
   * la porteria un mes despues en vez de al guardar. */
  const contrato: Rango = { vigenciaDesde: ENERO, vigenciaHasta: JUNIO_30 };
  assert.equal(
    cabeDentro({ vigenciaDesde: D(3, 1), vigenciaHasta: DICIEMBRE_31 }, contrato),
    false,
  );
});

test("una asignacion que empieza antes del contrato no cabe", () => {
  const contrato: Rango = { vigenciaDesde: JULIO_1 };
  assert.equal(cabeDentro({ vigenciaDesde: ENERO }, contrato), false);
});

test("una asignacion indefinida no cabe en un contrato con fin", () => {
  const contrato: Rango = { vigenciaDesde: ENERO, vigenciaHasta: DICIEMBRE_31 };
  assert.equal(cabeDentro({ vigenciaDesde: JULIO_1 }, contrato), false);
});

test("una asignacion indefinida cabe en un contrato indefinido", () => {
  assert.equal(
    cabeDentro({ vigenciaDesde: JULIO_1 }, { vigenciaDesde: ENERO }),
    true,
  );
});

test("los bordes exactos caben", () => {
  const contrato: Rango = { vigenciaDesde: ENERO, vigenciaHasta: DICIEMBRE_31 };
  assert.equal(cabeDentro({ ...contrato }, contrato), true);
});

// ─────────────────────────────────────────────────────────────
// Capacidades
// ─────────────────────────────────────────────────────────────

test("el guarda opera la porteria pero no la configura ni cobra", () => {
  const caps = capacidadesDeRolesConjunto(["guardia"]);
  assert.equal(caps.has("porteria.operar"), true);
  assert.equal(caps.has("porteria.ver"), true);
  assert.equal(caps.has("porteria.configurar"), false);
  assert.equal(caps.has("porteria.gestionar"), false);
});

test("el administrador del conjunto conserva todo lo de porteria", () => {
  /* Hoy puede operar la porteria y eso no cambia: GUARD_ROLES ya lo incluia. */
  const caps = capacidadesDeRolesConjunto(["administrador"]);
  assert.equal(caps.has("porteria.operar"), true);
  assert.equal(caps.has("porteria.configurar"), true);
  assert.equal(caps.has("porteria.gestionar"), true);
});

test("la contadora no opera la porteria", () => {
  assert.equal(capacidadesDeRolesConjunto(["contadora"]).size, 0);
});

test("un rol desconocido no otorga nada", () => {
  assert.equal(capacidadesDeRolesConjunto(["inventado"]).size, 0);
});

test("el supervisor mira y asigna, pero no opera la porteria", () => {
  const caps = capacidadesDeRolAsignacion("supervisor");
  assert.equal(caps.has("porteria.ver"), true);
  assert.equal(caps.has("seguridad.asignar"), true);
  assert.equal(caps.has("porteria.operar"), false);
});

test("el guarda de compañía conserva portería y recibe incidentes solo por asignación", () => {
  const directo = capacidadesDeRolesConjunto(["guardia"]);
  const compania = capacidadesDeRolAsignacion("guardia");
  assert.deepEqual(
    [...directo].filter((c) => c.startsWith("porteria.")).sort(),
    [...compania].filter((c) => c.startsWith("porteria.")).sort(),
  );
  assert.equal(directo.has("incidentes.crear"), false);
  assert.equal(compania.has("incidentes.crear"), true);
  assert.equal(compania.has("incidentes.gestionar"), false);
});

test("el admin de compania gestiona personal pero no opera ninguna porteria", () => {
  const caps = capacidadesDeRolesCompania(["admin_compania"]);
  assert.equal(caps.has("seguridad.personal"), true);
  assert.equal(caps.has("seguridad.asignar"), true);
  assert.equal(caps.has("porteria.operar"), false);
});

test("pertenecer a una compania como guarda no da nada por si solo", () => {
  /* El permiso lo da la asignacion a un conjunto, no la pertenencia. */
  assert.equal(capacidadesDeRolesCompania(["guardia"]).size, 0);
  assert.equal(capacidadesDeRolesCompania(["supervisor"]).size, 0);
});

test("contratar es solo de plataforma", () => {
  const nadie = [
    capacidadesDeRolesConjunto(["administrador"]),
    capacidadesDeRolAsignacion("supervisor"),
    capacidadesDeRolesCompania(["admin_compania"]),
  ];
  for (const caps of nadie) {
    assert.equal(caps.has("seguridad.contratar"), false);
  }
  assert.equal(capacidadesDePlataforma().has("seguridad.contratar"), true);
});

test("terminar el contrato propio es de la compania, firmarlo no", () => {
  /* Si `seguridad.terminar` no existiera y se hubiera reutilizado
   * `seguridad.contratar`, el administrador de una compania podria contratar
   * conjuntos a su antojo. Y el supervisor no termina contratos: administra
   * turnos, no la relacion comercial. */
  const admin = capacidadesDeRolesCompania(["admin_compania"]);
  assert.equal(admin.has("seguridad.terminar"), true);
  assert.equal(admin.has("seguridad.contratar"), false);

  const supervisor = capacidadesDeRolAsignacion("supervisor");
  assert.equal(supervisor.has("seguridad.terminar"), false);

  assert.equal(capacidadesDeRolesCompania(["guardia"]).size, 0);
});

test("la plataforma tiene todas las capacidades declaradas", () => {
  assert.equal(capacidadesDePlataforma().size, CAPACIDADES.length);
});

test("las dos vias se suman y no se pisan", () => {
  /* Un administrador del conjunto que ademas sea supervisor de la compania
   * tiene lo de ambos. */
  const caps = unir(
    capacidadesDeRolesConjunto(["administrador"]),
    capacidadesDeRolAsignacion("supervisor"),
  );
  assert.equal(caps.has("porteria.gestionar"), true);
  assert.equal(caps.has("seguridad.asignar"), true);
});

test("multi-rol acumula sin duplicar", () => {
  const caps = capacidadesDeRolesConjunto(["guardia", "administrador"]);
  assert.equal(caps.has("porteria.configurar"), true);
  assert.equal(caps.size, new Set([...caps]).size);
});
