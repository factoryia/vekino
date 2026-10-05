import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import betterAuthTest from "@convex-dev/better-auth/test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";

const modules = import.meta.glob("../convex/**/*.ts");

/**
 * FASE 8: SIN COBERTURA, NADA CAMBIA.
 *
 * Una instantánea de lo que devuelve la portería a quien NO tiene ninguna
 * cobertura: `guardia.home`, `asignaciones.miAcceso`, `turnoActivo`, la
 * apertura y el cierre del turno, las rondas, la minuta y las novedades, con
 * sus rechazos. La instantánea se generó con el código ANTERIOR a la Fase 8
 * (`git worktree` en el commit de partida) y esta prueba la compara con el de
 * ahora: si alguna respuesta cambia, falla.
 *
 * Solo usa funciones que ya existían antes, y de `miAcceso` solo los campos
 * de entonces: lo nuevo de la fase no entra en la comparación.
 *
 * El reloj está fijo y los ids de convex-test son un contador, así que todo
 * lo que sale es determinista.
 */

const MIN = 60 * 1000;
const DIA = 24 * 60 * MIN;
const AHORA = Date.parse("2026-10-12T08:00:00-05:00");
const CHECKLIST = [
  { item: "Radio", obligatorio: true, cantidadEsperada: 1, cantidadEncontrada: 1, estadoOk: true },
];

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
    const conjunto = (name: string, extra = {}) =>
      ctx.db.insert("condominios", {
        name,
        activeModules: [],
        isActive: true,
        createdAt: AHORA,
        updatedAt: AHORA,
        ...extra,
      });

    const superadmin = await usuario("super", "Super", { platformRole: "superadmin" as const });
    const alamos = await conjunto("Conjunto Alamos", { primaryColor: "#336699" });
    const bosque = await conjunto("Conjunto Bosque");
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
        vigenciaHasta: AHORA + 90 * DIA,
        creadoPorUserId: superadmin,
        createdAt: AHORA,
        updatedAt: AHORA,
      });
    const kAlamos = await contrato(alamos);
    const kBosque = await contrato(bosque);

    const miembro = (userId: Id<"users">, rol: "guardia" | "supervisor") =>
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
      rol: "guardia" | "supervisor",
    ) =>
      ctx.db.insert("asignaciones", {
        contratoId,
        companiaMiembroId,
        userId,
        condominioId,
        companiaId: andina,
        rol,
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

    const jason = await usuario("jason", "Jason Guarda");
    await asignacion(kAlamos, alamos, jason, await miembro(jason, "guardia"), "guardia");
    await membresia(jason, dalias, ["propietario"]);

    const mateo = await usuario("mateo", "Mateo Propio");
    await membresia(mateo, alamos, ["guardia"]);

    const paula = await usuario("paula", "Paula Mixta");
    await membresia(paula, alamos, ["guardia", "propietario"]);

    const bruno = await usuario("bruno", "Bruno Bosque");
    await asignacion(kBosque, bosque, bruno, await miembro(bruno, "guardia"), "guardia");

    const sofia = await usuario("sofia", "Sofia Supervisora");
    await asignacion(kAlamos, alamos, sofia, await miembro(sofia, "supervisor"), "supervisor");

    const ana = await usuario("ana", "Ana Administradora");
    await membresia(ana, alamos, ["administrador"]);

    return { alamos, bosque, dalias };
  });

  return { t, ...ids, como: (authId: string) => t.withIdentity({ subject: authId }) };
}

/** El resultado, o el mensaje del rechazo: los dos son parte del contrato. */
async function respuesta<T>(llamada: Promise<T>): Promise<T | { error: string }> {
  try {
    return await llamada;
  } catch (e) {
    return { error: (e as Error).message };
  }
}

let e: Awaited<ReturnType<typeof montar>>;
beforeEach(async () => {
  vi.setSystemTime(AHORA);
  e = await montar();
});
afterEach(() => vi.useRealTimers());

describe("Fase 8: sin cobertura, la portería responde igual que antes", () => {
  test("instantánea de home, miAcceso, turno, rondas, minuta y novedades", async () => {
    const personas = ["jason", "mateo", "paula", "bruno", "sofia", "ana"];
    const conjuntos = { alamos: e.alamos, bosque: e.bosque, dalias: e.dalias };
    const salida: Record<string, unknown> = {};

    for (const persona of personas) {
      for (const [nombre, condominioId] of Object.entries(conjuntos)) {
        const clave = `${persona}@${nombre}`;
        salida[`home ${clave}`] = await e.como(persona).query(api.guardia.home, { condominioId });
        const acceso = await e.como(persona).query(api.asignaciones.miAcceso, { condominioId });
        salida[`miAcceso ${clave}`] = acceso && {
          capacidades: [...acceso.capacidades].sort(),
          esPlataforma: acceso.esPlataforma,
          rolesConjunto: acceso.rolesConjunto,
          viaCompania: acceso.viaCompania,
        };
        salida[`turnoActivo ${clave}`] = await respuesta(
          e.como(persona).query(api.guardia.turnoActivo, { condominioId }),
        );
      }
    }

    const jason = e.como("jason");
    salida["iniciarTurno jason@bosque"] = await respuesta(
      jason.mutation(api.guardia.iniciarTurno, { condominioId: e.bosque, checklist: CHECKLIST }),
    );
    salida["iniciarTurno jason@dalias"] = await respuesta(
      jason.mutation(api.guardia.iniciarTurno, { condominioId: e.dalias, checklist: CHECKLIST }),
    );
    const turnoId = await jason.mutation(api.guardia.iniciarTurno, {
      condominioId: e.alamos,
      checklist: CHECKLIST,
    });
    salida["turnoActivo tras abrir"] = await jason.query(api.guardia.turnoActivo, { condominioId: e.alamos });
    salida["iniciarTurno repetido"] = await respuesta(
      e.como("mateo").mutation(api.guardia.iniciarTurno, { condominioId: e.alamos, checklist: CHECKLIST }),
    );
    salida["equipo jason@alamos"] = await jason.query(api.guardia.equipo, { condominioId: e.alamos });
    salida["equipo bruno@bosque"] = await e.como("bruno").query(api.guardia.equipo, { condominioId: e.bosque });

    const { rondaId } = await jason.mutation(api.rondas.iniciar, { condominioId: e.alamos, zona: "Perimetro" });
    salida["ronda activa"] = await jason.query(api.rondas.activa, { condominioId: e.alamos });
    salida["ronda en bosque"] = await respuesta(
      jason.mutation(api.rondas.iniciar, { condominioId: e.bosque }),
    );
    vi.setSystemTime(AHORA + 20 * MIN);
    await jason.mutation(api.rondas.finalizar, { rondaId, observaciones: "Sin novedad." });
    salida["rondas"] = await jason.query(api.rondas.listar, { condominioId: e.alamos });

    await jason.mutation(api.guardia.registrarEventoMinuta, {
      condominioId: e.alamos,
      tipo: "Anotación",
      resumen: "Recibo la portería.",
    });
    salida["minuta en bosque"] = await respuesta(
      jason.mutation(api.guardia.registrarEventoMinuta, {
        condominioId: e.bosque,
        tipo: "Anotación",
        resumen: "No debería quedar.",
      }),
    );
    salida["minuta"] = await jason.query(api.guardia.listMinuta, { condominioId: e.alamos });

    await e.como("mateo").mutation(api.guardia.reportarNovedad, {
      condominioId: e.alamos,
      titulo: "Luz dañada",
      descripcion: "La luz de la entrada no prende.",
      prioridad: "baja",
    });
    await jason.mutation(api.guardia.reportarNovedad, {
      condominioId: e.alamos,
      tipoReporte: "aporte_voluntario",
      titulo: "Aporte",
      descripcion: "Vehículo sin aporte.",
      prioridad: "media",
    });
    salida["novedad en dalias"] = await respuesta(
      jason.mutation(api.guardia.reportarNovedad, {
        condominioId: e.dalias,
        titulo: "X",
        descripcion: "Y",
        prioridad: "baja",
      }),
    );
    salida["novedades"] = await jason.query(api.guardia.listNovedadesGuardia, { condominioId: e.alamos });
    salida["aportes"] = await jason.query(api.guardia.listAportesVoluntarios, { condominioId: e.alamos });

    vi.setSystemTime(AHORA + 8 * 60 * MIN);
    salida["cerrar ajeno"] = await respuesta(
      e.como("bruno").mutation(api.guardia.cerrarTurno, {
        turnoId,
        recibe: "Otro",
        consignas: "x",
        observacionesCierre: "x",
        novedadesElementos: false,
      }),
    );
    await jason.mutation(api.guardia.cerrarTurno, {
      turnoId,
      recibeUserId: (await jason.query(api.guardia.equipo, { condominioId: e.alamos }))[0]!.userId,
      consignas: "Sin pendientes.",
      observacionesCierre: "Turno sin novedad.",
      novedadesElementos: false,
    });
    salida["turno cerrado"] = await e.t.run((ctx) => ctx.db.get(turnoId));
    salida["turnoActivo tras cerrar"] = await jason.query(api.guardia.turnoActivo, { condominioId: e.alamos });

    expect(salida).toMatchSnapshot();
  });
});
