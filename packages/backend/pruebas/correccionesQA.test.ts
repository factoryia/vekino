import { test, expect, describe, beforeEach, afterEach, vi } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { textoLocalColombia } from "../convex/lib/inasistencias";
import { sesionOperativa } from "../../../apps/web/lib/role-routing";
import { DIA, HORA, MIN, T17, montar, type Escenario } from "./helpers/trazabilidad";

/**
 * CORRECCIONES PREVIAS AL QA (Fase 13).
 *
 *   - Una cobertura ACEPTADA y una inasistencia del mismo guarda no pueden
 *     cruzarse: la inasistencia se rechaza. Para registrar una incapacidad
 *     en mitad de una cobertura, primero se inhabilita la cobertura.
 *   - La disponibilidad individual y la masiva son la misma función: mismo
 *     resultado, y las coberturas de OTRA compañía también ocupan.
 *   - El inventario dice por qué una custodia está pendiente.
 *   - La disponibilidad nunca lleva el motivo escrito de una inasistencia.
 *   - `desconocido` sigue sin ser elegible.
 *   - La sesión que la web arma (`sesionOperativa`) ve los mismos conjuntos
 *     de guarda que el servidor (`contextoOperativoGuardia.conjuntos`).
 *
 * Escenario de `helpers/trazabilidad.ts`: Andina con Alamos, Bosque y Cedros;
 * Jason asignado a Alamos, Bruno a Bosque. Reloj fijo: sábado 10/10/2026,
 * 17:00 en Colombia.
 */

const SOLAPE =
  "El guarda tiene una cobertura aceptada que se solapa con este periodo. Inhabilita primero la cobertura o registra la inasistencia para otro periodo.";
const SIN_HORARIO =
  "No hay horario registrado del guarda para toda la ventana: sin esa información no se puede pedir la cobertura.";
const YA_CUBRE = "El guarda ya tiene una cobertura aceptada que se cruza con esa ventana.";

/** Hora de pared de Colombia → instante. */
const instante = (local: string) => Date.parse(`${local}:00-05:00`);
const horas = (inicioLocal: string, finLocal: string) => ({
  diaCompleto: false as const,
  inicioLocal,
  finLocal,
});
type Ventana = ReturnType<typeof horas>;

/** La noche del domingo: libre según un horario de 06 a 18. */
const NOCHE = horas("2026-10-11T18:00", "2026-10-12T06:00");
const DE_DIA = [0, 1, 2, 3, 4, 5, 6].map((dia) => ({ dia, horaInicio: "06:00", horaFin: "18:00" }));

const en = (t: number) => vi.setSystemTime(t);

let e: Escenario;
let lucas: Id<"users">;

beforeEach(async () => {
  en(T17);
  e = await montar();
  /* Un tercer guarda de Andina en Alamos, sin horario: el `desconocido`. */
  lucas = await e.t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      name: "Lucas Sin Horario",
      email: "lucas@vekino.test",
      emailVerified: true,
      active: true,
      authId: "lucas",
      createdAt: T17,
      updatedAt: T17,
    });
    const companiaMiembroId = await ctx.db.insert("companiaMiembros", {
      userId,
      companiaId: e.andina,
      roles: ["guardia"],
      isActive: true,
      createdAt: T17,
      updatedAt: T17,
    });
    await ctx.db.insert("asignaciones", {
      contratoId: e.kAlamos,
      companiaMiembroId,
      userId,
      condominioId: e.alamos,
      companiaId: e.andina,
      rol: "guardia",
      vigenciaDesde: T17 - 60 * DIA,
      creadoPorUserId: e.alicia,
      createdAt: T17,
    });
    return userId;
  });
  /* Jason y Bruno trabajan de día: de noche están libres. */
  for (const userId of [e.jason, e.bruno]) {
    await e.como("alicia").mutation(api.horariosGuarda.crear, {
      companiaId: e.andina,
      userId,
      fechaInicio: "2026-10-01",
      bloques: DE_DIA,
    });
  }
});
afterEach(() => vi.useRealTimers());

// ── Atajos ────────────────────────────────────────────────────

const inasistencia = (
  userId: Id<"users">,
  ventana: Ventana | { diaCompleto: true; fechaInicio: string; fechaFin: string },
  extra: { tipo?: "incapacidad" | "vacaciones"; motivo?: string } = {},
) =>
  e.como("alicia").mutation(api.inasistencias.crear, {
    companiaId: e.andina,
    userId,
    tipo: extra.tipo ?? "incapacidad",
    motivo: extra.motivo,
    ventana,
  });

/** Pedir y aceptar por las mutaciones de verdad, con su revalidación. */
async function pedirYAceptar(
  userId: Id<"users">,
  authIdGuarda: string,
  contratoId: Id<"companiaContratos">,
  ventana: Ventana,
) {
  const coberturaId = await e.como("alicia").mutation(api.coberturas.crear, {
    contratoId,
    userId,
    ventana,
  });
  await e.como(authIdGuarda).mutation(api.coberturas.aceptar, { coberturaId });
  return coberturaId;
}

const inhabilitar = (coberturaId: Id<"coberturas">) =>
  e.como("alicia").mutation(api.coberturas.inhabilitar, {
    coberturaId,
    motivo: "El guarda se incapacitó.",
  });

const estadoDe = (id: Id<"coberturas">) =>
  e.t.run(async (ctx) => (await ctx.db.get(id))!.estado);

const inasistenciasDe = (userId: Id<"users">) =>
  e.t.run(async (ctx) =>
    (await ctx.db.query("inasistencias").collect()).filter((i) => i.userId === userId),
  );

const individual = (userId: Id<"users">, ventana: Ventana, authId = "alicia") =>
  e.como(authId).query(api.disponibilidad.deGuarda, { companiaId: e.andina, userId, ventana });

const masiva = async (ventana: Ventana, authId = "alicia") =>
  (await e.como(authId).query(api.disponibilidad.deGuardasEnAlcance, { companiaId: e.andina, ventana }))
    .guardas;

// ─────────────────────────────────────────────────────────────
describe("Inasistencia sobre una cobertura aceptada", () => {
  test("A. cobertura futura aceptada: se rechaza y la cobertura sigue aceptada", async () => {
    const id = await e.cubrir(e.bosque, e.kBosque, instante("2026-10-11T18:00"), instante("2026-10-12T06:00"));

    await expect(
      inasistencia(e.jason, horas("2026-10-11T20:00", "2026-10-12T02:00")),
    ).rejects.toThrow(SOLAPE);
    /* También por días completos: el domingo entero toca la noche. */
    await expect(
      inasistencia(e.jason, { diaCompleto: true, fechaInicio: "2026-10-11", fechaFin: "2026-10-11" }),
    ).rejects.toThrow(SOLAPE);

    /* No se inhabilita sola ni queda nada a medias. */
    expect(await estadoDe(id)).toBe("aceptada");
    expect(await inasistenciasDe(e.jason)).toEqual([]);
  });

  test("B. cobertura activa: se rechaza", async () => {
    await e.cubrir(e.bosque, e.kBosque, T17 - HORA, T17 + 5 * HORA);
    await expect(
      inasistencia(e.jason, horas(textoLocalColombia(T17), textoLocalColombia(T17 + 8 * HORA))),
    ).rejects.toThrow(SOLAPE);
  });

  test("C. tras inhabilitarla, la misma inasistencia se registra", async () => {
    const activa = await e.cubrir(e.bosque, e.kBosque, T17 - HORA, T17 + 5 * HORA);
    const ventana = horas(textoLocalColombia(T17), textoLocalColombia(T17 + 8 * HORA));
    await expect(inasistencia(e.jason, ventana)).rejects.toThrow(SOLAPE);

    await inhabilitar(activa);
    await expect(inasistencia(e.jason, ventana)).resolves.toBeTruthy();

    /* Y con una futura, igual. */
    const futura = await e.cubrir(e.cedros, e.kCedros, instante("2026-10-13T18:00"), instante("2026-10-14T06:00"));
    const otra = horas("2026-10-13T20:00", "2026-10-14T02:00");
    await expect(inasistencia(e.jason, otra)).rejects.toThrow(SOLAPE);
    await inhabilitar(futura);
    await expect(inasistencia(e.jason, otra)).resolves.toBeTruthy();
  });

  test("D. cobertura 18–06 e inasistencia 07–12 del día siguiente: se permite", async () => {
    await e.cubrir(e.bosque, e.kBosque, instante("2026-10-11T18:00"), instante("2026-10-12T06:00"));
    await expect(
      inasistencia(e.jason, horas("2026-10-12T07:00", "2026-10-12T12:00")),
    ).resolves.toBeTruthy();
  });

  test("E. inasistencia 08–18 y luego cobertura 18–06: se pide y se acepta", async () => {
    await inasistencia(e.jason, horas("2026-10-11T08:00", "2026-10-11T18:00"));
    const id = await pedirYAceptar(e.jason, "jason", e.kBosque, NOCHE);
    expect(await estadoDe(id)).toBe("aceptada");
  });

  test("E'. con la cobertura 18–06 aceptada, tocarla en un borde no es cruzarla", async () => {
    await e.cubrir(e.bosque, e.kBosque, instante("2026-10-11T18:00"), instante("2026-10-12T06:00"));
    /* Acaba justo cuando ella empieza; empieza justo cuando ella acaba. */
    await expect(
      inasistencia(e.jason, horas("2026-10-11T08:00", "2026-10-11T18:00")),
    ).resolves.toBeTruthy();
    await expect(
      inasistencia(e.jason, horas("2026-10-12T06:00", "2026-10-12T10:00")),
    ).resolves.toBeTruthy();
    /* Un minuto dentro de la cobertura (y fuera de las otras dos), ya sí. */
    await expect(
      inasistencia(e.jason, horas("2026-10-12T05:59", "2026-10-12T06:00")),
    ).rejects.toThrow(SOLAPE);
  });
});

// ─────────────────────────────────────────────────────────────
describe("Integración", () => {
  test("A. cobertura pedida y aceptada + inasistencia encima: se rechaza", async () => {
    const id = await pedirYAceptar(e.jason, "jason", e.kBosque, NOCHE);
    await expect(inasistencia(e.jason, NOCHE)).rejects.toThrow(SOLAPE);
    expect(await estadoDe(id)).toBe("aceptada");
  });

  test("B. inhabilitar primero y luego la inasistencia: se permite", async () => {
    const id = await pedirYAceptar(e.jason, "jason", e.kBosque, NOCHE);
    en(instante("2026-10-11T20:00"));
    await inhabilitar(id);
    await expect(
      inasistencia(e.jason, horas("2026-10-11T20:00", "2026-10-12T06:00")),
    ).resolves.toBeTruthy();
    expect(await estadoDe(id)).toBe("inhabilitada");
  });

  test("C. la disponibilidad individual y la masiva dicen lo mismo de cada guarda", async () => {
    await e.cubrir(e.bosque, e.kBosque, instante("2026-10-11T20:00"), instante("2026-10-12T02:00"));
    await inasistencia(e.bruno, NOCHE, { tipo: "vacaciones" });

    const filas = await masiva(NOCHE);
    expect(filas.map((f) => [f.userId, f.estado])).toEqual(
      expect.arrayContaining([
        [e.jason, "ocupado"],
        [e.bruno, "no_disponible"],
        [lucas, "desconocido"],
      ]),
    );
    for (const fila of filas) {
      const sola = await individual(fila.userId, NOCHE);
      expect({ estado: fila.estado, motivos: fila.motivos }).toEqual({
        estado: sola.estado,
        motivos: sola.motivos,
      });
    }
  });

  test("D. una cobertura en OTRA compañía ocupa al guarda en las dos consultas", async () => {
    await e.t.run(async (ctx) => {
      const centinela = await ctx.db.insert("companiasSeguridad", {
        nombre: "Centinela",
        estado: "activa",
        createdAt: T17,
        updatedAt: T17,
      });
      const contratoId = await ctx.db.insert("companiaContratos", {
        companiaId: centinela,
        condominioId: e.cedros,
        vigenciaDesde: T17 - 60 * DIA,
        creadoPorUserId: e.alicia,
        createdAt: T17,
        updatedAt: T17,
      });
      await ctx.db.insert("companiaMiembros", {
        userId: e.jason,
        companiaId: centinela,
        roles: ["guardia"],
        isActive: true,
        createdAt: T17,
        updatedAt: T17,
      });
      await ctx.db.insert("coberturas", {
        companiaId: centinela,
        userId: e.jason,
        condominioId: e.cedros,
        contratoId,
        inicio: instante("2026-10-11T18:00"),
        fin: instante("2026-10-12T06:00"),
        estado: "aceptada",
        solicitadoPorUserId: e.alicia,
        solicitadoEn: T17,
        respuesta: "aceptada",
        respondidoEn: T17,
        respondidoPorUserId: e.jason,
      });
    });

    const sola = await individual(e.jason, NOCHE);
    const fila = (await masiva(NOCHE)).find((f) => f.userId === e.jason)!;
    expect(sola.estado).toBe("ocupado");
    expect(fila.estado).toBe("ocupado");
    expect(fila.motivos).toEqual(sola.motivos);
    expect(sola.motivos).toEqual([
      expect.objectContaining({ tipo: "cobertura", condominioId: e.cedros }),
    ]);

    /* Y lo que se apoya en ella: Andina no puede pedírselo, ni registrarle
     * una inasistencia encima. */
    await expect(
      e.como("alicia").mutation(api.coberturas.crear, { contratoId: e.kBosque, userId: e.jason, ventana: NOCHE }),
    ).rejects.toThrow(YA_CUBRE);
    await expect(inasistencia(e.jason, NOCHE)).rejects.toThrow(SOLAPE);
  });

  describe("E. por qué está pendiente una custodia", () => {
    const custodiaEn = async (authId: string, condominioId: Id<"condominios">, itemId: Id<"inventarioItems">) => {
      const lista = await e.como(authId).query(api.inventarioGuardas.itemsDelCondominio, { condominioId });
      return { custodia: lista.items.find((i) => i.itemId === itemId)!.custodia!, pendientes: lista.pendientes };
    };
    const entregar = (authId: string, itemId: Id<"inventarioItems">, guardaUserId: Id<"users">) =>
      e.como(authId).mutation(api.inventarioGuardas.entregar, { itemId, guardaUserId });

    test("ya no está asignado: le terminaron la asignación", async () => {
      const linterna = await e.itemEn(e.bosque, "Linterna de Bosque");
      await entregar("sergio", linterna, e.bruno);
      await e.t.run(async (ctx) => {
        const a = (await ctx.db.query("asignaciones").collect()).find(
          (x) => x.userId === e.bruno && x.condominioId === e.bosque,
        )!;
        await ctx.db.patch(a._id, { terminadoEn: T17 + 30 * MIN });
      });
      en(T17 + HORA);
      const { custodia, pendientes } = await custodiaEn("sergio", e.bosque, linterna);
      expect(custodia).toMatchObject({ pendiente: true, causaPendiente: "ya_no_asignado" });
      expect(pendientes).toBe(1);
    });

    test("cubriendo otro conjunto, y su cobertura terminó", async () => {
      const radioA = await e.itemEn(e.alamos, "Radio de Alamos");
      const radioB = await e.itemEn(e.bosque, "Radio de Bosque");
      await entregar("sofia", radioA, e.jason);
      await e.cubrir(e.bosque, e.kBosque, T17 + HORA, T17 + 10 * HORA);

      /* Durante la cobertura: el de Alamos queda pendiente porque cubre Bosque. */
      en(T17 + 2 * HORA);
      expect((await custodiaEn("sofia", e.alamos, radioA)).custodia).toMatchObject({
        pendiente: true,
        causaPendiente: "cubriendo_otro_conjunto",
      });
      await entregar("sergio", radioB, e.jason);
      const enBosque = (await custodiaEn("sergio", e.bosque, radioB)).custodia;
      expect(enBosque.pendiente).toBe(false);
      expect(enBosque).not.toHaveProperty("causaPendiente");

      /* Terminada: el de Bosque queda pendiente por eso; el de Alamos vuelve. */
      en(T17 + 11 * HORA);
      expect((await custodiaEn("sergio", e.bosque, radioB)).custodia).toMatchObject({
        pendiente: true,
        causaPendiente: "cobertura_terminada",
      });
      const deVuelta = (await custodiaEn("sofia", e.alamos, radioA)).custodia;
      expect(deVuelta.pendiente).toBe(false);
      expect(deVuelta).not.toHaveProperty("causaPendiente");
    });
  });

  test("F. la disponibilidad no lleva el motivo escrito, solo la categoría", async () => {
    const motivo = "Diagnostico reservado: migrana cronica";
    const id = await inasistencia(e.bruno, NOCHE, { tipo: "incapacidad", motivo });

    for (const authId of ["alicia", "sergio"]) {
      const sola = await individual(e.bruno, NOCHE, authId);
      const filas = await masiva(NOCHE, authId);
      for (const respuesta of [sola, filas]) {
        const texto = JSON.stringify(respuesta);
        expect(texto).not.toContain("migrana");
        expect(texto).not.toContain("Diagnostico");
        expect(texto).not.toContain('"motivo"');
      }
      expect(sola.motivos).toEqual([
        { tipo: "inasistencia", inasistenciaId: id, categoria: "incapacidad", inicio: expect.any(Number), fin: expect.any(Number) },
      ]);
    }
    /* El detalle, para quien gestiona, sigue como estaba. */
    const detalle = await e.como("alicia").query(api.inasistencias.detalle, { inasistenciaId: id });
    expect(detalle!.motivo).toBe(motivo);
  });

  test("F'. en una incapacidad el motivo sigue siendo opcional", async () => {
    await expect(inasistencia(e.bruno, NOCHE, { tipo: "incapacidad" })).resolves.toBeTruthy();
  });

  test("G. desconocido no es elegible: sin horario no se pide", async () => {
    expect((await individual(lucas, NOCHE)).estado).toBe("desconocido");
    await expect(
      e.como("alicia").mutation(api.coberturas.crear, { contratoId: e.kBosque, userId: lucas, ventana: NOCHE }),
    ).rejects.toThrow(SIN_HORARIO);
    expect(
      await e.t.run(async (ctx) => (await ctx.db.query("coberturas").collect()).length),
    ).toBe(0);
  });

  test("H. sin coberturas, todo como antes", async () => {
    expect((await individual(e.bruno, NOCHE)).estado).toBe("disponible");
    expect((await masiva(NOCHE)).find((f) => f.userId === e.bruno)!.estado).toBe("disponible");
    await expect(inasistencia(e.bruno, NOCHE)).resolves.toBeTruthy();

    const radio = await e.itemEn(e.bosque, "Radio de Bosque");
    await e.como("sergio").mutation(api.inventarioGuardas.entregar, { itemId: radio, guardaUserId: e.bruno });
    const lista = await e.como("sergio").query(api.inventarioGuardas.itemsDelCondominio, { condominioId: e.bosque });
    const custodia = lista.items.find((i) => i.itemId === radio)!.custodia!;
    expect(custodia.pendiente).toBe(false);
    expect(custodia).not.toHaveProperty("causaPendiente");
    expect(lista.pendientes).toBe(0);

    /* Y se le puede pedir una cobertura otra noche. */
    const otraNoche = horas("2026-10-13T18:00", "2026-10-14T06:00");
    const id = await pedirYAceptar(e.bruno, "bruno", e.kCedros, otraNoche);
    expect(await estadoDe(id)).toBe("aceptada");
  });
});

// ─────────────────────────────────────────────────────────────
describe("I7: la sesión de la web y el servidor ven los mismos conjuntos", () => {
  /** Dónde ve la web que opera como guarda: lo que hacen los shells. */
  function conjuntosEnLaWeb(me: NonNullable<Awaited<ReturnType<typeof sesion>>>) {
    const hoy = sesionOperativa(me);
    const ids = new Set<string>([
      ...hoy.memberships.filter((m) => m.roles.includes("guardia")).map((m) => m.condominioId),
      ...hoy.asignaciones.filter((a) => a.rol === "guardia").map((a) => a.condominioId),
    ]);
    const cobertura = me.contextoOperativoGuardia.cobertura;
    if (cobertura) ids.add(cobertura.condominioId);
    return [...ids].sort();
  }
  const sesion = () => e.como("jason").query(api.users.me, {});
  const comparar = async () => {
    const me = (await sesion())!;
    const delServidor = me.contextoOperativoGuardia.conjuntos.map((c) => c.condominioId as string).sort();
    expect(conjuntosEnLaWeb(me)).toEqual(delServidor);
    return { tipo: me.contextoOperativoGuardia.tipo, conjuntos: delServidor };
  };

  let dalias: Id<"condominios">;
  beforeEach(async () => {
    /* Jason también es guarda propio (y propietario) de Dalias. */
    dalias = await e.t.run(async (ctx) => {
      const id = await ctx.db.insert("condominios", {
        name: "Conjunto Dalias",
        activeModules: [],
        isActive: true,
        createdAt: T17,
        updatedAt: T17,
      });
      await ctx.db.insert("memberships", {
        userId: e.jason,
        condominioId: id,
        roles: ["guardia", "propietario"],
        isActive: true,
        createdAt: T17,
        updatedAt: T17,
      });
      return id;
    });
  });

  test("permanente, cobertura futura, activa, bloqueado y terminada", async () => {
    const siempre = [e.alamos, dalias].map(String).sort();
    expect(await comparar()).toEqual({ tipo: "permanente", conjuntos: siempre });

    await e.cubrir(e.bosque, e.kBosque, T17 + HORA, T17 + 5 * HORA);
    expect(await comparar()).toEqual({ tipo: "permanente", conjuntos: siempre });

    en(T17 + 2 * HORA);
    expect(await comparar()).toEqual({ tipo: "cobertura", conjuntos: [String(e.bosque)] });

    await e.cubrir(e.cedros, e.kCedros, T17 + HORA, T17 + 3 * HORA);
    expect(await comparar()).toEqual({ tipo: "bloqueado", conjuntos: [] });

    en(T17 + 6 * HORA);
    expect(await comparar()).toEqual({ tipo: "permanente", conjuntos: siempre });
  });
});
