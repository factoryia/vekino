import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TIPOS_INASISTENCIA,
  etiquetaVentana,
  exigeMotivo,
  instanteColombia,
  pisaAlguna,
  rangoDeConsulta,
  sumarDias,
  validarMotivo,
  ventanaInasistencia,
} from "../convex/lib/inasistencias.ts";

const HORA = 3_600_000;
const DIA = 24 * HORA;

test("los tipos son un conjunto cerrado y el dia libre no esta", () => {
  assert.deepEqual([...TIPOS_INASISTENCIA], [
    "inasistencia",
    "incapacidad",
    "vacaciones",
    "permiso",
    "otro",
  ]);
  assert.equal((TIPOS_INASISTENCIA as readonly string[]).includes("dia_libre"), false);
});

test("el motivo es obligatorio en inasistencia y otro, opcional en el resto", () => {
  assert.equal(exigeMotivo("inasistencia"), true);
  assert.equal(exigeMotivo("otro"), true);
  assert.equal(exigeMotivo("incapacidad"), false);
  assert.throws(() => validarMotivo("inasistencia", "   "), /obligatorio/);
  assert.throws(() => validarMotivo("otro", undefined), /obligatorio/);
  assert.equal(validarMotivo("vacaciones", undefined), undefined);
  assert.equal(validarMotivo("vacaciones", "  "), undefined);
  assert.equal(validarMotivo("inasistencia", "  No llego al turno  "), "No llego al turno");
  assert.throws(() => validarMotivo("permiso", "x".repeat(501)), /500/);
});

test("la hora de pared se lee en hora de Colombia, no en la del equipo", () => {
  // 18:00 en Colombia son las 23:00 UTC.
  assert.equal(instanteColombia("2026-10-08T18:00"), Date.UTC(2026, 9, 8, 23, 0));
  assert.throws(() => instanteColombia("2026-02-30T10:00"), /no son válidas/);
  assert.throws(() => instanteColombia("2026-10-08T24:00"), /no son válidas/);
  assert.throws(() => instanteColombia("2026-10-08 18:00"), /no son válidas/);
  assert.throws(() => instanteColombia(""), /no son válidas/);
});

test("dias completos: conserva la fecha civil y el ultimo dia cuenta entero", () => {
  const v = ventanaInasistencia({
    diaCompleto: true,
    fechaInicio: "2026-10-08",
    fechaFin: "2026-10-10",
  });
  assert.equal(v.diaCompleto, true);
  assert.equal(v.fechaInicio, "2026-10-08");
  assert.equal(v.fechaFin, "2026-10-10");
  // Medianoche de Colombia del 8 → medianoche de Colombia del 11.
  assert.equal(v.inicio, Date.UTC(2026, 9, 8, 5, 0));
  assert.equal(v.fin, Date.UTC(2026, 9, 11, 5, 0));
  assert.equal(v.fin - v.inicio, 3 * DIA);
});

test("un solo dia completo es valido", () => {
  const v = ventanaInasistencia({
    diaCompleto: true,
    fechaInicio: "2026-10-08",
    fechaFin: "2026-10-08",
  });
  assert.equal(v.fin - v.inicio, DIA);
});

test("con hora: instantes exactos que cruzan la medianoche", () => {
  const v = ventanaInasistencia({
    diaCompleto: false,
    inicioLocal: "2026-10-08T18:00",
    finLocal: "2026-10-09T06:00",
  });
  assert.equal(v.diaCompleto, false);
  assert.equal(v.fechaInicio, undefined);
  assert.equal(v.fin - v.inicio, 12 * HORA);
});

test("inicio >= fin se rechaza en las dos modalidades", () => {
  assert.throws(
    () =>
      ventanaInasistencia({
        diaCompleto: false,
        inicioLocal: "2026-10-08T18:00",
        finLocal: "2026-10-08T18:00",
      }),
    /posterior/,
  );
  assert.throws(
    () =>
      ventanaInasistencia({
        diaCompleto: false,
        inicioLocal: "2026-10-09T06:00",
        finLocal: "2026-10-08T18:00",
      }),
    /posterior/,
  );
  assert.throws(
    () =>
      ventanaInasistencia({
        diaCompleto: true,
        fechaInicio: "2026-10-10",
        fechaFin: "2026-10-08",
      }),
    /anterior/,
  );
  assert.throws(
    () =>
      ventanaInasistencia({
        diaCompleto: true,
        fechaInicio: "2026-13-01",
        fechaFin: "2026-13-02",
      }),
    /no es válido/,
  );
});

test("solape: se pisan las que se cruzan, no las que se tocan en el borde", () => {
  const a = { inicio: 10, fin: 20 };
  assert.equal(pisaAlguna({ inicio: 15, fin: 25 }, [a]), true); // parcial
  assert.equal(pisaAlguna({ inicio: 12, fin: 18 }, [a]), true); // contenida
  assert.equal(pisaAlguna({ inicio: 5, fin: 30 }, [a]), true); // contiene
  assert.equal(pisaAlguna({ inicio: 20, fin: 30 }, [a]), false); // seguida
  assert.equal(pisaAlguna({ inicio: 0, fin: 10 }, [a]), false); // antes, pegada
  assert.equal(pisaAlguna({ inicio: 15, fin: 25 }, []), false);
});

test("rango de consulta: fechas incluidas y tope de un ano", () => {
  const r = rangoDeConsulta("2026-10-01", "2026-10-31");
  assert.equal(r.desde, Date.UTC(2026, 9, 1, 5, 0));
  assert.equal(r.hasta, Date.UTC(2026, 10, 1, 5, 0));
  assert.throws(() => rangoDeConsulta("2026-10-31", "2026-10-01"), /anterior/);
  assert.throws(() => rangoDeConsulta("2026-01-01", "2027-06-01"), /366/);
});

test("la etiqueta se escribe en hora de Colombia", () => {
  assert.equal(
    etiquetaVentana(
      ventanaInasistencia({ diaCompleto: true, fechaInicio: "2026-10-08", fechaFin: "2026-10-10" }),
    ),
    "08/10/2026 → 10/10/2026 (días completos)",
  );
  assert.equal(
    etiquetaVentana(
      ventanaInasistencia({ diaCompleto: true, fechaInicio: "2026-10-08", fechaFin: "2026-10-08" }),
    ),
    "08/10/2026 (día completo)",
  );
  assert.equal(
    etiquetaVentana(
      ventanaInasistencia({
        diaCompleto: false,
        inicioLocal: "2026-10-08T18:00",
        finLocal: "2026-10-09T06:00",
      }),
    ),
    "08/10/2026 18:00 → 09/10/2026 06:00",
  );
});

test("sumar dias sobre fechas civiles cruza meses", () => {
  assert.equal(sumarDias("2026-10-30", 3), "2026-11-02");
  assert.equal(sumarDias("2026-03-01", -1), "2026-02-28");
});
