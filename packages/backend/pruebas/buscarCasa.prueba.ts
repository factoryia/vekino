import { test } from "node:test";
import assert from "node:assert/strict";
import { buscarCasas, normalizar, type CasaParaBuscar } from "../convex/lib/buscarCasa.ts";

const casa = (
  numero: string,
  ocupantes: CasaParaBuscar["ocupantes"] = [],
  extra: Partial<CasaParaBuscar> = {},
): CasaParaBuscar => ({ numero, ocupantes, tipo: "casa", ...extra });

const CONJUNTO = [
  casa("210", [{ nombre: "Pedro Ruiz", vinculo: "propietario" }]),
  casa("103", [{ nombre: "Juan Gómez", vinculo: "propietario" }]),
  casa("101", [
    { nombre: "Ana Torres", vinculo: "arrendatario" },
    { nombre: "Carlos Pérez", vinculo: "propietario" },
  ]),
  casa("102", [{ nombre: "María Rodríguez", vinculo: "residente" }]),
  casa("104"),
];

const vista = (r: ReturnType<typeof buscarCasas>) =>
  r.map((c) => `${c.numero} ${c.persona?.nombre ?? "—"}`);

test("sin texto trae todas, ordenadas y con su titular", () => {
  /* Es la lista que ve el guarda al abrir el selector. El propietario va
   * primero aunque el arrendatario se haya vinculado antes. */
  assert.deepEqual(vista(buscarCasas(CONJUNTO, "", 50)), [
    "101 Carlos Pérez",
    "102 María Rodríguez",
    "103 Juan Gómez",
    "104 —",
    "210 Pedro Ruiz",
  ]);
});

test("por número: primero las que empiezan así", () => {
  /* "10" es la 101, no la 210 —pero la 210 también la contiene—. */
  assert.deepEqual(vista(buscarCasas(CONJUNTO, "10", 50)), [
    "101 Carlos Pérez",
    "102 María Rodríguez",
    "103 Juan Gómez",
    "104 —",
    "210 Pedro Ruiz",
  ]);
  assert.deepEqual(vista(buscarCasas(CONJUNTO, "103", 50)), ["103 Juan Gómez"]);
});

test("por nombre, sin tildes ni mayúsculas", () => {
  assert.deepEqual(vista(buscarCasas(CONJUNTO, "carlos", 50)), ["101 Carlos Pérez"]);
  assert.deepEqual(vista(buscarCasas(CONJUNTO, "MARIA rodriguez", 50)), ["102 María Rodríguez"]);
  assert.deepEqual(vista(buscarCasas(CONJUNTO, "perez", 50)), ["101 Carlos Pérez"]);
});

test("muestra a la persona que casó, no siempre al titular", () => {
  /* Buscó a Ana: que vea a Ana, que es a quien le llegó el paquete. */
  assert.deepEqual(vista(buscarCasas(CONJUNTO, "ana", 50)), ["101 Ana Torres"]);
});

test("número y nombre juntos tienen que ser de la misma casa", () => {
  assert.deepEqual(vista(buscarCasas(CONJUNTO, "101 carlos", 50)), ["101 Carlos Pérez"]);
  assert.deepEqual(buscarCasas(CONJUNTO, "102 carlos", 50), []);
});

test("encuentra por torre y por la palabra casa o apto", () => {
  const torres = [
    casa("101", [], { torre: "A", tipo: "apartamento" }),
    casa("101", [], { torre: "B", tipo: "apartamento" }),
  ];
  assert.deepEqual(
    buscarCasas(torres, "b 101", 50).map((c) => c.torre),
    ["B"],
  );
  assert.equal(buscarCasas(torres, "apto 101", 50).length, 2);
  assert.equal(buscarCasas(CONJUNTO, "casa 101", 50).length, 1);
});

test("respeta el límite y no revienta con basura", () => {
  assert.equal(buscarCasas(CONJUNTO, "", 2).length, 2);
  assert.deepEqual(buscarCasas(CONJUNTO, "zzz", 50), []);
  assert.equal(buscarCasas(CONJUNTO, "   ", 50).length, CONJUNTO.length);
  assert.equal(normalizar(null), "");
  assert.equal(normalizar("  Ñandú   Pérez "), "nandu perez");
});
