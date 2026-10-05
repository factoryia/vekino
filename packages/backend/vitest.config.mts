import { defineConfig } from "vitest/config";

/**
 * Pruebas de autorización con `convex-test`.
 *
 * Aparte de las de `node:test` a propósito: aquellas prueban funciones puras
 * de `convex/lib` y corren en Node sin nada montado; éstas necesitan el
 * runtime de Convex simulado —base, índices, identidad— para poder llamar a
 * las queries y mutaciones de verdad, que es donde vive la autorización.
 *
 * Patrones distintos para que cada corredor coja solo lo suyo:
 *   node:test → pruebas/*.prueba.ts
 *   vitest    → pruebas/*.test.ts
 */
export default defineConfig({
  test: {
    environment: "edge-runtime",
    include: ["pruebas/**/*.test.ts"],
    /* Los 5s de vitest se quedaron cortos.
     *
     * Cada fichero monta el runtime de Convex entero —el `import.meta.glob`
     * de arriba trae todas las funciones— y los ficheros arrancan a la vez,
     * asi que el arranque en frio se pisa entre workers: la primera prueba de
     * un fichero puede pasar varios segundos esperando turno antes de correr.
     * Lo que tarda es montar, no la prueba (ninguna pasa de segundo y medio).
     * Con 5s, anadir un fichero mas tumbaba la primera prueba de otro. */
    testTimeout: 30_000,
    /* Lo mismo para los `beforeEach`/`beforeAll`, que se quedaban en los 10s
     * por defecto: el `beforeEach` de muchas suites monta el runtime y ademas
     * siembra el escenario con mutaciones de verdad (compania, contrato,
     * conjuntos, guardas), asi que paga el mismo arranque en frio que la
     * primera prueba. Cuando caia, caia ahi: es una suite PESADA bajo
     * concurrencia, no un test lento.
     *
     * Test lento o suite pesada (medido el 2026-10-05, 37 ficheros):
     *   - con la suite entera, la primera prueba de un fichero llega a ~7s:
     *     es el arranque en frio compartido, no la prueba;
     *   - las de `inventarioGuardas` rondan 1s solas y 2s con la suite
     *     entera: su escenario es grande y se monta en cada `beforeEach`;
     *   - el resto, por debajo de 2s incluso con la suite entera.
     * Para no esconder un test lento detras de este margen, el reporte marca
     * cualquier prueba que pase de `slowTestThreshold`, puesto por encima del
     * peor arranque observado: si alguna pasa de 10s, se volvio lenta ella. */
    hookTimeout: 30_000,
    slowTestThreshold: 10_000,
    server: { deps: { inline: ["convex-test"] } },
  },
});
