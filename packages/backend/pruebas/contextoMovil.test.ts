import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import betterAuthTest from "@convex-dev/better-auth/test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import {
  condominioActivo,
  debeIrALaCobertura,
  esPorteriaDeGuarda,
  estadoDeGuardia,
  opcionesDeCondominio,
} from "../../../apps/mobile/src/lib/contexto-guardia";

const modules = import.meta.glob("../convex/**/*.ts");

/**
 * FASE 9: EL MÓVIL CONSUME EL CONTEXTO OPERATIVO DEL SERVIDOR.
 *
 * Cada caso pide `users.meOperativo` al backend de verdad y le pasa la
 * respuesta a la MISMA lógica pura que usa la app
 * (`apps/mobile/src/lib/contexto-guardia.ts`): qué conjuntos ofrece, cuál
 * abre, si muestra la portería y qué estado enseña cuando no hay ninguna. Así
 * se prueba el camino entero —servidor → contrato → pantalla— sin montar la
 * app, y que la app no necesita ninguna regla propia para llegar ahí.
 *
 * Y la parte que importa de verdad: manipular el cliente no devuelve acceso a
 * A durante una cobertura en B. Para cada operación que hacen las pantallas
 * de portería del móvil, B pasa y A se rechaza en el servidor.
 *
 * Reparto (como en `coberturasAcceso.test.ts`):
 *   jason  → guarda de Andina en Alamos y Cedros; propietario en Dalias.
 *   mateo  → guarda propio de Alamos (membresía ["guardia"]), también de Andina.
 *   bruno  → guarda de Andina en Bosque.
 *   lucas  → guarda de Andina en Alamos.
 *   nadia  → guarda de Andina sin asignación (ni portería ni conjunto).
 *   alicia → administradora de Andina.
 */

const MIN = 60 * 1000;
const HORA = 60 * MIN;
const DIA = 24 * HORA;
const AHORA = Date.parse("2026-10-12T08:00:00-05:00");
const INICIO = AHORA + 2 * HORA;
const FIN = INICIO + 8 * HORA;
const DURANTE = INICIO + HORA;
const DESPUES = FIN + HORA;

const CHECKLIST = [
  { item: "Radio", obligatorio: true, cantidadEsperada: 1, cantidadEncontrada: 1, estadoOk: true },
];
const CIERRE = {
  consignas: "Sin pendientes.",
  observacionesCierre: "Turno sin novedad.",
  novedadesElementos: false,
};
const CUBRIENDO_BOSQUE = "Está cubriendo Conjunto Bosque";

const en = (instante: number) => vi.setSystemTime(instante);

async function montar() {
  const t = convexTest(schema, modules);
  betterAuthTest.register(t);
  const desde = AHORA - 60 * DIA;

  const ids = await t.run(async (ctx) => {
    const usuario = (authId: string, name: string, extra = {}) =>
      ctx.db.insert("users", {
        name,
        email: `${authId}@vekino.test`,
        emailVerified: true,
        active: true,
        authId,
        createdAt: AHORA,
        updatedAt: AHORA,
        ...extra,
      });
    const conjunto = (name: string) =>
      ctx.db.insert("condominios", {
        name,
        activeModules: [],
        isActive: true,
        createdAt: AHORA,
        updatedAt: AHORA,
      });

    const superadmin = await usuario("super", "Super", { platformRole: "superadmin" as const });
    const alamos = await conjunto("Conjunto Alamos");
    const bosque = await conjunto("Conjunto Bosque");
    const cedros = await conjunto("Conjunto Cedros");
    const dalias = await conjunto("Conjunto Dalias");
    const andina = await ctx.db.insert("companiasSeguridad", {
      nombre: "Seguridad Andina",
      estado: "activa",
      createdAt: AHORA,
      updatedAt: AHORA,
    });

    const contrato = (condominioId: Id<"condominios">) =>
      ctx.db.insert("companiaContratos", {
        companiaId: andina,
        condominioId,
        vigenciaDesde: desde,
        creadoPorUserId: superadmin,
        createdAt: AHORA,
        updatedAt: AHORA,
      });
    const kAlamos = await contrato(alamos);
    const kBosque = await contrato(bosque);
    const kCedros = await contrato(cedros);

    const miembro = (userId: Id<"users">, rol: "guardia" | "admin_compania") =>
      ctx.db.insert("companiaMiembros", {
        userId,
        companiaId: andina,
        roles: [rol],
        isActive: true,
        createdAt: AHORA,
        updatedAt: AHORA,
      });
    const asignacion = (
      contratoId: Id<"companiaContratos">,
      condominioId: Id<"condominios">,
      userId: Id<"users">,
      companiaMiembroId: Id<"companiaMiembros">,
    ) =>
      ctx.db.insert("asignaciones", {
        contratoId,
        companiaMiembroId,
        userId,
        condominioId,
        companiaId: andina,
        rol: "guardia",
        vigenciaDesde: desde,
        creadoPorUserId: superadmin,
        createdAt: AHORA,
      });
    const membresia = (
      userId: Id<"users">,
      condominioId: Id<"condominios">,
      roles: Doc<"memberships">["roles"],
    ) =>
      ctx.db.insert("memberships", {
        userId,
        condominioId,
        roles,
        isActive: true,
        createdAt: AHORA,
        updatedAt: AHORA,
      });

    const alicia = await usuario("alicia", "Alicia Admin");
    await miembro(alicia, "admin_compania");

    const jason = await usuario("jason", "Jason Guarda");
    const mJason = await miembro(jason, "guardia");
    await asignacion(kAlamos, alamos, jason, mJason);
    await asignacion(kCedros, cedros, jason, mJason);
    await membresia(jason, dalias, ["propietario"]);

    const mateo = await usuario("mateo", "Mateo Propio");
    await miembro(mateo, "guardia");
    await membresia(mateo, alamos, ["guardia"]);

    const bruno = await usuario("bruno", "Bruno Bosque");
    await asignacion(kBosque, bosque, bruno, await miembro(bruno, "guardia"));

    const lucas = await usuario("lucas", "Lucas Alamos");
    await asignacion(kAlamos, alamos, lucas, await miembro(lucas, "guardia"));

    const nadia = await usuario("nadia", "Nadia Sinpuesto");
    await miembro(nadia, "guardia");

    return {
      alamos, bosque, cedros, dalias, andina,
      kAlamos, kBosque, kCedros,
      alicia, jason, mJason, mateo, bruno, lucas, nadia,
    };
  });

  const como = (authId: string) => t.withIdentity({ subject: authId });

  const cubrir = (
    userId: Id<"users">,
    condominioId: Id<"condominios">,
    contratoId: Id<"companiaContratos">,
    extra: Partial<Doc<"coberturas">> = {},
  ) =>
    t.run((ctx) =>
      ctx.db.insert("coberturas", {
        companiaId: ids.andina,
        userId,
        condominioId,
        contratoId,
        inicio: INICIO,
        fin: FIN,
        estado: "aceptada",
        solicitadoPorUserId: ids.alicia,
        solicitadoEn: AHORA - DIA,
        respuesta: "aceptada",
        respondidoEn: AHORA - DIA,
        respondidoPorUserId: userId,
        ...extra,
      }),
    );

  /**
   * Lo que pintaría el móvil: la respuesta de `meOperativo` pasada por la
   * lógica de la app. `elegido` es el conjunto que la app tenía guardado.
   */
  const pantalla = async (authId: string, elegido?: Id<"condominios">) => {
    const me = (await como(authId).query(api.users.meOperativo, {}))!;
    const opciones = opcionesDeCondominio(me);
    const activa = condominioActivo(opciones, elegido);
    return {
      tipo: me.contextoOperativoGuardia.tipo,
      cobertura: me.contextoOperativoGuardia.cobertura?.condominioId ?? null,
      refrescarEn: me.contextoOperativoGuardia.refrescarEn,
      opciones: opciones.map((o) => o.condominioId),
      activa: activa?.condominioId ?? null,
      porteria: esPorteriaDeGuarda(activa),
      estado: estadoDeGuardia(me),
      irACobertura: debeIrALaCobertura(me.contextoOperativoGuardia, null),
    };
  };

  return { t, ...ids, como, cubrir, pantalla };
}

let e: Awaited<ReturnType<typeof montar>>;
beforeEach(async () => {
  en(AHORA);
  e = await montar();
});
afterEach(() => vi.useRealTimers());

describe("Fase 9: el móvil resuelve la portería con el contexto del servidor", () => {
  test("A. guarda de compañía sin membresía: opera en su asignación", async () => {
    expect(await e.pantalla("lucas")).toMatchObject({
      tipo: "permanente",
      opciones: [e.alamos],
      activa: e.alamos,
      porteria: true,
      estado: null,
    });
    expect((await e.como("lucas").query(api.guardia.home, { condominioId: e.alamos })).allowed).toBe(true);
  });

  test("B. con cobertura activa: B es la portería; A y C no se ofrecen", async () => {
    await e.cubrir(e.jason, e.bosque, e.kBosque);
    en(DURANTE);
    expect(await e.pantalla("jason", e.alamos)).toMatchObject({
      tipo: "cobertura",
      cobertura: e.bosque,
      opciones: [e.bosque, e.dalias],
      activa: e.bosque,
      porteria: true,
      irACobertura: true,
    });
  });

  test("C. cobertura futura: conserva su contexto permanente", async () => {
    await e.cubrir(e.jason, e.bosque, e.kBosque);
    expect(await e.pantalla("jason", e.alamos)).toMatchObject({
      tipo: "permanente",
      cobertura: null,
      refrescarEn: INICIO,
      opciones: [e.dalias, e.alamos, e.cedros],
      activa: e.alamos,
      porteria: true,
      irACobertura: false,
    });
  });

  test("D y R. al terminar (con la app abierta), vuelve a A y C", async () => {
    await e.cubrir(e.jason, e.bosque, e.kBosque);
    en(DURANTE);
    expect((await e.pantalla("jason", e.bosque)).activa).toBe(e.bosque);
    en(FIN);
    expect(await e.pantalla("jason", e.bosque)).toMatchObject({
      tipo: "permanente",
      opciones: [e.dalias, e.alamos, e.cedros],
      activa: e.alamos,
      porteria: true,
    });
  });

  test("E y S. inhabilitada mientras la usa: vuelve al permanente en el acto", async () => {
    const coberturaId = await e.cubrir(e.jason, e.bosque, e.kBosque);
    en(DURANTE);
    await e.como("alicia").mutation(api.coberturas.inhabilitar, { coberturaId, motivo: "Se retiró." });
    expect(await e.pantalla("jason", e.bosque)).toMatchObject({
      tipo: "permanente",
      activa: e.alamos,
      porteria: true,
    });
  });

  test("F. compañía suspendida: la cobertura deja de operar", async () => {
    await e.cubrir(e.mateo, e.bosque, e.kBosque);
    en(DURANTE);
    await e.t.run((ctx) => ctx.db.patch(e.andina, { estado: "suspendida" }));
    // Su membresía de guarda propio no cuelga de la compañía: vuelve a Alamos.
    expect(await e.pantalla("mateo", e.bosque)).toMatchObject({
      tipo: "permanente",
      opciones: [e.alamos],
      activa: e.alamos,
      porteria: true,
    });
  });

  test("G. conjunto inactivo: la cobertura deja de operar", async () => {
    await e.cubrir(e.jason, e.bosque, e.kBosque);
    en(DURANTE);
    await e.t.run((ctx) => ctx.db.patch(e.bosque, { isActive: false }));
    expect(await e.pantalla("jason", e.bosque)).toMatchObject({ tipo: "permanente", activa: e.alamos });
  });

  test("H. contrato terminado: la cobertura deja de operar", async () => {
    await e.cubrir(e.jason, e.bosque, e.kBosque);
    en(DURANTE);
    await e.t.run((ctx) => ctx.db.patch(e.kBosque, { terminadoEn: DURANTE - MIN }));
    expect(await e.pantalla("jason", e.bosque)).toMatchObject({ tipo: "permanente", activa: e.alamos });
  });

  test("I. miembro dado de baja: la cobertura deja de operar y no queda portería", async () => {
    await e.cubrir(e.jason, e.bosque, e.kBosque);
    en(DURANTE);
    await e.t.run((ctx) => ctx.db.patch(e.mJason, { isActive: false }));
    // Dado de baja, tampoco valen sus asignaciones: le queda su casa.
    expect(await e.pantalla("jason", e.bosque)).toMatchObject({
      tipo: "permanente",
      opciones: [e.dalias],
      activa: e.dalias,
      porteria: false,
    });
  });

  test("J. dos coberturas a la vez: bloqueado, sin portería y con aviso", async () => {
    await e.cubrir(e.jason, e.bosque, e.kBosque);
    await e.cubrir(e.jason, e.cedros, e.kCedros);
    en(DURANTE);
    expect(await e.pantalla("jason", e.bosque)).toMatchObject({
      tipo: "bloqueado",
      opciones: [e.dalias],
      porteria: false,
      estado: "bloqueado",
    });
  });

  test("K. el conjunto A guardado no abre una portería durante la cobertura", async () => {
    await e.cubrir(e.jason, e.bosque, e.kBosque);
    en(DURANTE);
    expect((await e.pantalla("jason", e.alamos)).activa).toBe(e.bosque);
    // Y si el cliente insiste, el servidor no le abre A.
    expect(await e.como("jason").query(api.guardia.home, { condominioId: e.alamos })).toEqual({ allowed: false });
  });

  test("N. relevo: solo los guardas que operan hoy en la portería del turno", async () => {
    await e.cubrir(e.jason, e.bosque, e.kBosque);
    en(DURANTE);
    const turnoB = await e.como("bruno").mutation(api.guardia.iniciarTurno, {
      condominioId: e.bosque,
      checklist: CHECKLIST,
    });
    const enB = await e.como("bruno").query(api.guardia.relevosDelTurno, { turnoId: turnoB });
    expect(enB.map((g) => g.userId)).toEqual([e.jason]);

    const turnoA = await e.como("lucas").mutation(api.guardia.iniciarTurno, {
      condominioId: e.alamos,
      checklist: CHECKLIST,
    });
    const enA = await e.como("lucas").query(api.guardia.relevosDelTurno, { turnoId: turnoA });
    expect(enA.map((g) => g.userId)).not.toContain(e.jason);
    expect(enA.map((g) => g.userId)).toContain(e.mateo);
  });

  test("O, P y Q. solicitudes: verla, aceptarla cambia cuándo volver a preguntar; rechazarla no cambia nada", async () => {
    // Jason trabaja de día: la noche está libre.
    await e.como("alicia").mutation(api.horariosGuarda.crear, {
      companiaId: e.andina,
      userId: e.jason,
      fechaInicio: "2026-10-05",
      bloques: [0, 1, 2, 3, 4, 5, 6].map((dia) => ({ dia, horaInicio: "06:00", horaFin: "18:00" })),
    });
    const noche = {
      diaCompleto: false as const,
      inicioLocal: "2026-10-12T18:00",
      finLocal: "2026-10-13T06:00",
    };
    const inicioNoche = Date.parse("2026-10-12T18:00:00-05:00");

    const rechazable = await e.como("alicia").mutation(api.coberturas.crear, {
      contratoId: e.kBosque,
      userId: e.jason,
      ventana: noche,
    });
    // O: la ve en sus pendientes.
    const pendientes = await e.como("jason").query(api.coberturas.pendientesDeGuarda, {});
    expect(pendientes.map((c) => c._id)).toEqual([rechazable]);

    // Q: rechazarla no cambia su contexto.
    const antes = await e.pantalla("jason");
    await e.como("jason").mutation(api.coberturas.rechazar, { coberturaId: rechazable });
    expect(await e.pantalla("jason")).toEqual(antes);

    // P: aceptar otra. El contexto no cambia todavía, pero la sesión ya sabe
    // cuándo volver a preguntar; en ese instante, la portería es B.
    const aceptable = await e.como("alicia").mutation(api.coberturas.crear, {
      contratoId: e.kBosque,
      userId: e.jason,
      ventana: noche,
    });
    await e.como("jason").mutation(api.coberturas.aceptar, { coberturaId: aceptable });
    expect(await e.pantalla("jason", e.alamos)).toMatchObject({
      tipo: "permanente",
      activa: e.alamos,
      refrescarEn: inicioNoche,
    });
    en(inicioNoche);
    expect(await e.pantalla("jason", e.alamos)).toMatchObject({
      tipo: "cobertura",
      activa: e.bosque,
      irACobertura: true,
    });
  });

  test("T y U. el turno de A abierto antes se puede cerrar desde B; uno nuevo en A no", async () => {
    await e.cubrir(e.jason, e.bosque, e.kBosque);
    const turnoA = await e.como("jason").mutation(api.guardia.iniciarTurno, {
      condominioId: e.alamos,
      checklist: CHECKLIST,
    });
    en(DURANTE);
    const pendiente = await e.como("jason").query(api.guardia.turnoPendienteDeCierre, {});
    expect(pendiente?.turno._id).toBe(turnoA);
    await e.como("jason").mutation(api.guardia.cerrarTurno, {
      turnoId: turnoA,
      recibeUserId: e.lucas,
      ...CIERRE,
    });
    expect(await e.como("jason").query(api.guardia.turnoPendienteDeCierre, {})).toBeNull();
    await expect(
      e.como("jason").mutation(api.guardia.iniciarTurno, { condominioId: e.alamos, checklist: CHECKLIST }),
    ).rejects.toThrow(CUBRIENDO_BOSQUE);
  });

  test("V. sin contexto de guarda: no hay portería falsa", async () => {
    expect(await e.pantalla("nadia")).toMatchObject({
      tipo: "permanente",
      opciones: [],
      activa: null,
      porteria: false,
      estado: "sin_porteria",
    });
  });
});

/*
 * LA PRUEBA QUE IMPORTA: el cliente no puede devolverse el acceso a A.
 *
 * Cada operación que hacen las pantallas de portería del móvil, llamada a
 * mano durante la cobertura: sobre B pasa, sobre A el servidor la rechaza.
 */
describe("Fase 9: cada operación del móvil, B pasa y A se rechaza", () => {
  test("consultas de las pantallas de portería", async () => {
    await e.cubrir(e.jason, e.bosque, e.kBosque);
    en(DURANTE);
    const jason = e.como("jason");
    const llamadas = {
      turnoActivo: (c: Id<"condominios">) => jason.query(api.guardia.turnoActivo, { condominioId: c }),
      listMinuta: (c: Id<"condominios">) => jason.query(api.guardia.listMinuta, { condominioId: c, limit: 10 }),
      listVisitantes: (c: Id<"condominios">) => jason.query(api.guardia.listVisitantes, { condominioId: c }),
      listPaquetes: (c: Id<"condominios">) => jason.query(api.guardia.listPaquetes, { condominioId: c }),
      listReservasControl: (c: Id<"condominios">) =>
        jason.query(api.guardia.listReservasControl, { condominioId: c }),
      listReservasDia: (c: Id<"condominios">) =>
        jason.query(api.guardia.listReservasDia, { condominioId: c, fecha: "2026-10-12" }),
      listAvisos: (c: Id<"condominios">) => jason.query(api.guardia.listAvisos, { condominioId: c }),
      listNovedadReportes: (c: Id<"condominios">) =>
        jason.query(api.guardia.listNovedadReportes, { condominioId: c }),
      listChecklistTemplate: (c: Id<"condominios">) =>
        jason.query(api.guardia.listChecklistTemplate, { condominioId: c }),
      listRondaZonas: (c: Id<"condominios">) => jason.query(api.guardia.listRondaZonas, { condominioId: c }),
      equipo: (c: Id<"condominios">) => jason.query(api.guardia.equipo, { condominioId: c }),
      condominiosGet: (c: Id<"condominios">) => jason.query(api.condominios.get, { condominioId: c }),
    };
    for (const [nombre, llamar] of Object.entries(llamadas)) {
      await expect(llamar(e.bosque), `${nombre} en B`).resolves.not.toThrow();
      await expect(llamar(e.alamos), `${nombre} en A`).rejects.toThrow();
    }
    expect((await jason.query(api.guardia.home, { condominioId: e.bosque })).allowed).toBe(true);
    expect((await jason.query(api.guardia.home, { condominioId: e.alamos })).allowed).toBe(false);
  });

  test("escrituras: turno, minuta, ronda, novedad, aporte, visitante, paquete e incidente", async () => {
    await e.cubrir(e.jason, e.bosque, e.kBosque);
    en(DURANTE);
    const jason = e.como("jason");
    const incidente = {
      tipo: "ACCESO",
      ubicacion: "Portería",
      ocurrioEn: DURANTE - MIN,
      descripcion: "Intento de ingreso sin autorización.",
      prioridad: "MEDIA" as const,
    };
    const escrituras = {
      iniciarTurno: (c: Id<"condominios">) =>
        jason.mutation(api.guardia.iniciarTurno, { condominioId: c, checklist: CHECKLIST }),
      registrarEventoMinuta: (c: Id<"condominios">) =>
        jason.mutation(api.guardia.registrarEventoMinuta, {
          condominioId: c,
          tipo: "Anotación",
          resumen: "Recibo la portería.",
        }),
      registrarRonda: (c: Id<"condominios">) =>
        jason.mutation(api.guardia.registrarRonda, { condominioId: c, zonaNombre: "Perímetro", fotos: [] }),
      reportarNovedad: (c: Id<"condominios">) =>
        jason.mutation(api.guardia.reportarNovedad, {
          condominioId: c,
          titulo: "Luz dañada",
          descripcion: "La luz de la entrada no prende.",
          prioridad: "baja",
        }),
      aporteVoluntario: (c: Id<"condominios">) =>
        jason.mutation(api.guardia.reportarNovedad, {
          condominioId: c,
          tipoReporte: "aporte_voluntario",
          titulo: "Aporte",
          descripcion: "Vehículo sin aporte.",
          prioridad: "media",
        }),
      incidente: (c: Id<"condominios">) => jason.mutation(api.incidentes.crear, { condominioId: c, ...incidente }),
    };
    /* En orden: la minuta y la ronda necesitan el turno abierto en B. */
    for (const [nombre, escribir] of Object.entries(escrituras)) {
      await expect(escribir(e.alamos), `${nombre} en A`).rejects.toThrow();
      await expect(escribir(e.bosque), `${nombre} en B`).resolves.not.toThrow();
    }
    /* Visitante y paquete: en A el servidor rechaza antes de mirar la casa. */
    await expect(
      jason.mutation(api.guardia.registrarDirecto, {
        condominioId: e.alamos,
        unidadNumero: "101",
        nombre: "Visita",
        documento: "123",
        tipoDocumento: "CC",
        tipo: "visitante",
      }),
    ).rejects.toThrow(CUBRIENDO_BOSQUE);
    await expect(
      jason.mutation(api.guardia.recibirPaquete, {
        condominioId: e.alamos,
        unidadNumero: "101",
        tipo: "paquete",
      }),
    ).rejects.toThrow(CUBRIENDO_BOSQUE);
  });
});
