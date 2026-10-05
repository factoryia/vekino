import { test } from "node:test";
import assert from "node:assert/strict";
import {
  condominioActivo,
  debeIrALaCobertura,
  esPorteriaDeGuarda,
  estadoDeGuardia,
  etiquetaHasta,
  firmaDeContexto,
  opcionesDeCondominio,
  type ContextoGuardia,
  type Sesion,
} from "../src/lib/contexto-guardia.ts";

/**
 * CÓMO TRADUCE EL MÓVIL EL CONTEXTO QUE DA EL SERVIDOR.
 *
 * Estas pruebas no deciden quién es guarda: le dan a la app la respuesta que
 * devuelve `users.meOperativo` en cada caso (la que fija
 * `packages/backend/pruebas/contextoMovil.test.ts` contra el backend de
 * verdad) y comprueban qué conjunto abre, si muestra la portería y qué
 * mensaje enseña cuando no hay ninguna.
 */

const AHORA = Date.parse("2026-10-12T08:00:00-05:00");
const FIN = Date.parse("2026-10-13T06:00:00-05:00");

type Membresia = Sesion["memberships"][number];
type Conjunto = ContextoGuardia["conjuntos"][number];

const membresia = (condominioId: string, roles: string[]): Membresia =>
  ({
    membershipId: `m-${condominioId}`,
    condominioId,
    condominioName: `Conjunto ${condominioId}`,
    condominioSubdomain: null,
    condominioLogo: null,
    condominioCoverImage: null,
    condominioPrimaryColor: null,
    roles,
  }) as unknown as Membresia;

const porteria = (condominioId: string, por: Conjunto["por"]): Conjunto =>
  ({
    condominioId,
    condominioNombre: `Conjunto ${condominioId}`,
    condominioLogo: null,
    condominioColor: null,
    condominioCoverImage: null,
    por,
  }) as unknown as Conjunto;

function contexto(
  tipo: ContextoGuardia["tipo"],
  conjuntos: Conjunto[],
  cubre?: string,
): ContextoGuardia {
  return {
    tipo,
    conjuntos,
    refrescarEn: null,
    cobertura: cubre
      ? ({
          coberturaId: `c-${cubre}`,
          condominioId: cubre,
          condominioNombre: `Conjunto ${cubre}`,
          condominioLogo: null,
          condominioColor: null,
          companiaId: "andina",
          companiaNombre: "Seguridad Andina",
          inicio: AHORA,
          fin: FIN,
        } as unknown as NonNullable<ContextoGuardia["cobertura"]>)
      : null,
  } as ContextoGuardia;
}

const sesion = (
  memberships: Membresia[],
  contextoOperativoGuardia: ContextoGuardia,
  rolCompania: string | null = "guardia",
) =>
  ({
    memberships,
    contextoOperativoGuardia,
    compania: rolCompania ? { roles: [rolCompania] } : null,
  }) as unknown as Sesion;

const ids = (s: Sesion) => opcionesDeCondominio(s).map((o) => o.condominioId);

test("A. guarda de compania sin membresia: su asignacion es su porteria", () => {
  const s = sesion([], contexto("permanente", [porteria("A", "asignacion")]));
  const opciones = opcionesDeCondominio(s);
  assert.deepEqual(ids(s), ["A"]);
  const activa = condominioActivo(opciones, undefined);
  assert.equal(activa?.condominioId, "A");
  assert.equal(esPorteriaDeGuarda(activa), true);
  assert.equal(estadoDeGuardia(s), null);
});

test("B. con cobertura activa: B es la porteria, A y C no se ofrecen", () => {
  const s = sesion(
    [membresia("D", ["propietario"])],
    contexto("cobertura", [porteria("B", "cobertura")], "B"),
  );
  assert.deepEqual(ids(s), ["B", "D"]);
  // Aunque tuviera A guardado, A ya no se abre: cae en B.
  const activa = condominioActivo(opcionesDeCondominio(s), "A");
  assert.equal(activa?.condominioId, "B");
  assert.equal(esPorteriaDeGuarda(activa), true);
  assert.equal(activa?.guardiaPor, "cobertura");
  // Y se le lleva a B una vez.
  assert.equal(debeIrALaCobertura(s.contextoOperativoGuardia, null), true);
  assert.equal(debeIrALaCobertura(s.contextoOperativoGuardia, "c-B"), false);
});

test("C. cobertura futura: el contexto sigue siendo permanente", () => {
  const s = sesion(
    [],
    contexto("permanente", [porteria("A", "asignacion"), porteria("C", "asignacion")]),
  );
  assert.deepEqual(ids(s), ["A", "C"]);
  assert.equal(condominioActivo(opcionesDeCondominio(s), "A")?.condominioId, "A");
  assert.equal(debeIrALaCobertura(s.contextoOperativoGuardia, null), false);
});

test("D/E/F/G/H/I. cuando la cobertura deja de valer, vuelve a su porteria permanente", () => {
  // Fin, inhabilitacion o cadena rota: el servidor vuelve a "permanente".
  const s = sesion(
    [membresia("D", ["propietario"])],
    contexto("permanente", [porteria("A", "asignacion"), porteria("C", "asignacion")]),
  );
  // Tenia B elegido: B ya no existe. Vuelve a una porteria, no a su casa.
  const activa = condominioActivo(opcionesDeCondominio(s), "B");
  assert.equal(activa?.condominioId, "A");
  assert.equal(esPorteriaDeGuarda(activa), true);
  // Sin nada elegido, el orden de siempre: primero sus membresias.
  assert.equal(condominioActivo(opcionesDeCondominio(s), undefined)?.condominioId, "D");
});

test("D'. sin ninguna via permanente de guarda: no se inventa un conjunto", () => {
  const s = sesion([], contexto("permanente", []));
  assert.deepEqual(ids(s), []);
  assert.equal(condominioActivo(opcionesDeCondominio(s), "B"), undefined);
  assert.equal(estadoDeGuardia(s), "sin_porteria");
});

test("J. bloqueado: ninguna porteria, y se dice", () => {
  const s = sesion([membresia("D", ["propietario"])], contexto("bloqueado", []));
  const opciones = opcionesDeCondominio(s);
  assert.deepEqual(ids(s), ["D"]);
  assert.equal(esPorteriaDeGuarda(condominioActivo(opciones, "B")), false);
  assert.equal(estadoDeGuardia(s), "bloqueado");
});

test("membresia solo de guarda: con cobertura no se ofrece; sin ella, es su porteria", () => {
  const durante = sesion(
    [membresia("A", ["guardia"])],
    contexto("cobertura", [porteria("B", "cobertura")], "B"),
  );
  assert.deepEqual(ids(durante), ["B"]);

  const sinCobertura = sesion(
    [membresia("A", ["guardia"])],
    contexto("permanente", [porteria("A", "membership")]),
    null,
  );
  const activa = condominioActivo(opcionesDeCondominio(sinCobertura), undefined);
  assert.equal(activa?.condominioId, "A");
  assert.deepEqual(activa?.roles, []);
  assert.equal(esPorteriaDeGuarda(activa), true);
});

test("membresia con otros roles: conserva esos roles y deja de ser porteria", () => {
  const s = sesion(
    [membresia("A", ["guardia", "propietario"])],
    contexto("cobertura", [porteria("B", "cobertura")], "B"),
  );
  const a = opcionesDeCondominio(s).find((o) => o.condominioId === "A");
  assert.deepEqual(a?.roles, ["propietario"]);
  assert.equal(a?.guardiaPor, null);
  assert.equal(esPorteriaDeGuarda(a), false);
});

test("quien administra el conjunto ve su panel, no la porteria", () => {
  const s = sesion(
    [membresia("A", ["guardia", "administrador"])],
    contexto("permanente", [porteria("A", "membership")]),
    null,
  );
  const activa = condominioActivo(opcionesDeCondominio(s), "A");
  assert.equal(esPorteriaDeGuarda(activa), false);
});

test("Q. residente sin compania: nada cambia y no hay estado de guarda", () => {
  const s = sesion([membresia("D", ["propietario"])], contexto("permanente", []), null);
  assert.deepEqual(ids(s), ["D"]);
  assert.equal(esPorteriaDeGuarda(condominioActivo(opcionesDeCondominio(s), undefined)), false);
  assert.equal(estadoDeGuardia(s), null);
});

test("V. guarda de compania sin contexto: sin porteria, que no es lo mismo que sin cuenta", () => {
  const s = sesion([], contexto("permanente", []));
  assert.equal(estadoDeGuardia(s), "sin_porteria");
  // Un supervisor sin conjuntos no es "guarda sin porteria".
  assert.equal(estadoDeGuardia(sesion([], contexto("permanente", []), "supervisor")), null);
});

test("la firma cambia cuando cambia el contexto, y solo entonces", () => {
  const a = contexto("permanente", [porteria("A", "asignacion")]);
  const b = contexto("cobertura", [porteria("B", "cobertura")], "B");
  assert.notEqual(firmaDeContexto(a), firmaDeContexto(b));
  assert.equal(firmaDeContexto(a), firmaDeContexto(contexto("permanente", [porteria("A", "asignacion")])));
  assert.equal(firmaDeContexto(undefined), "");
});

test("la hora de fin se lee en hora de Colombia", () => {
  assert.equal(etiquetaHasta(FIN), "13 de octubre · 06:00");
  assert.equal(etiquetaHasta(Date.parse("2026-01-01T04:59:00Z")), "31 de diciembre · 23:59");
});
