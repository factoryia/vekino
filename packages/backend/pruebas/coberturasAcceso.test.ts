import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import betterAuthTest from "@convex-dev/better-auth/test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import { requireCondominioRole } from "../convex/model/authz";
import { resolverAcceso } from "../convex/model/acceso";
import type { OperationalRole } from "../convex/model/roles";

const modules = import.meta.glob("../convex/**/*.ts");

/**
 * FASE 8: LA COBERTURA ACTIVA ES EL CONTEXTO OPERATIVO DE GUARDA.
 *
 * Una cobertura aceptada, dentro de su ventana y con su cadena entera
 * (contrato, compañía, guarda de alta, conjunto activo), lleva al guarda a
 * operar SOLO en el conjunto que cubre. Sus vías permanentes de guarda quedan
 * suspendidas mientras dura; lo que no es de guarda no se toca. Nada de esto
 * se guarda: se deriva al leer, con el reloj del servidor.
 *
 * El reloj se fija con `vi.setSystemTime`: la ventana de la cobertura va de
 * INICIO a FIN, y cada caso se mira antes, durante y después.
 *
 * Reparto:
 *   jason  → guarda de Andina, asignado a Alamos y Cedros; propietario en Dalias.
 *   mateo  → guarda propio de Alamos (membresía ["guardia"]); también de Andina.
 *   paula  → membresía ["guardia","propietario"] en Alamos; también de Andina.
 *   bruno  → guarda de Andina asignado a Bosque.
 *   lucas  → guarda de Andina asignado a Alamos.
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

const GUARD_ROLES: OperationalRole[] = ["guardia", "administrador", "junta_directiva"];
const CHECKLIST = [
  { item: "Radio", obligatorio: true, cantidadEsperada: 1, cantidadEncontrada: 1, estadoOk: true },
];
const CIERRE = {
  consignas: "Sin pendientes.",
  observacionesCierre: "Turno sin novedad.",
  novedadesElementos: false,
};

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
    const mMateo = await miembro(mateo, "guardia");
    await membresia(mateo, alamos, ["guardia"]);

    const paula = await usuario("paula", "Paula Mixta");
    await miembro(paula, "guardia");
    await membresia(paula, alamos, ["guardia", "propietario"]);

    const bruno = await usuario("bruno", "Bruno Bosque");
    const mBruno = await miembro(bruno, "guardia");
    await asignacion(kBosque, bosque, bruno, mBruno);

    const lucas = await usuario("lucas", "Lucas Alamos");
    const mLucas = await miembro(lucas, "guardia");
    await asignacion(kAlamos, alamos, lucas, mLucas);

    return {
      alamos, bosque, cedros, dalias, andina,
      kAlamos, kBosque, kCedros,
      alicia, jason, mJason, mateo, mMateo, paula, bruno, lucas,
    };
  });

  const como = (authId: string) => t.withIdentity({ subject: authId });

  /** Una cobertura ya aceptada, insertada tal cual: aquí se prueba la lectura. */
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

  const home = async (authId: string, condominioId: Id<"condominios">) =>
    (await como(authId).query(api.guardia.home, { condominioId })).allowed;

  const contexto = async (authId: string) =>
    (await como(authId).query(api.users.me, {}))!.contextoOperativoGuardia;

  /** `requireCondominioRole` directo: true si pasa, el mensaje si no. */
  const exige = (authId: string, condominioId: Id<"condominios">, roles = GUARD_ROLES) =>
    como(authId).run((ctx) =>
      requireCondominioRole(ctx, condominioId, roles).then(
        () => true as const,
        (e: Error) => e.message,
      ),
    );

  /** `resolverAcceso` directo, en lo que se puede devolver desde `run`. */
  const acceso = (authId: string, condominioId: Id<"condominios">) =>
    como(authId).run(async (ctx) => {
      const a = await resolverAcceso(ctx, condominioId);
      return {
        rolesConjunto: a?.rolesConjunto ?? null,
        asignacionId: a?.asignacion?._id ?? null,
        coberturaCondominioId: a?.cobertura?.condominioId ?? null,
        capacidades: [...(a?.capacidades ?? [])].sort(),
      };
    });

  const abrirTurno = (authId: string, condominioId: Id<"condominios">) =>
    como(authId).mutation(api.guardia.iniciarTurno, { condominioId, checklist: CHECKLIST });

  return { t, ...ids, como, cubrir, home, contexto, exige, acceso, abrirTurno };
}

let e: Awaited<ReturnType<typeof montar>>;
beforeEach(async () => {
  en(AHORA);
  e = await montar();
});
afterEach(() => vi.useRealTimers());

const CUBRIENDO_BOSQUE = "Está cubriendo Conjunto Bosque";

describe("Fase 8: activación de la cobertura", () => {
  test("A. aceptada pero futura: opera con sus vías permanentes", async () => {
    await e.cubrir(e.jason, e.bosque, e.kBosque);
    en(AHORA);

    expect(await e.home("jason", e.alamos)).toBe(true);
    expect(await e.home("jason", e.cedros)).toBe(true);
    expect(await e.home("jason", e.bosque)).toBe(false);
    expect(await e.exige("jason", e.bosque)).toBe("No pertenece a este condominio.");

    await e.abrirTurno("jason", e.alamos);
    await expect(e.abrirTurno("jason", e.bosque)).rejects.toThrow("No pertenece a este condominio.");
  });

  test("B. durante la cobertura: solo B es operativo", async () => {
    await e.cubrir(e.jason, e.bosque, e.kBosque);
    en(DURANTE);

    expect(await e.home("jason", e.bosque)).toBe(true);
    expect(await e.home("jason", e.alamos)).toBe(false);
    expect(await e.home("jason", e.cedros)).toBe(false);

    await e.abrirTurno("jason", e.bosque);
    await expect(e.abrirTurno("jason", e.alamos)).rejects.toThrow(CUBRIENDO_BOSQUE);
    await expect(e.abrirTurno("jason", e.cedros)).rejects.toThrow(CUBRIENDO_BOSQUE);

    expect(await e.acceso("jason", e.bosque)).toEqual({
      rolesConjunto: null,
      asignacionId: null,
      coberturaCondominioId: e.bosque,
      capacidades: ["incidentes.crear", "incidentes.ver", "porteria.operar", "porteria.ver"],
    });
    expect(await e.acceso("jason", e.alamos)).toEqual({
      rolesConjunto: null,
      asignacionId: null,
      coberturaCondominioId: null,
      capacidades: [],
    });
  });

  test("C. después del fin: vuelven las vías permanentes", async () => {
    await e.cubrir(e.jason, e.bosque, e.kBosque);
    en(DESPUES);

    expect(await e.home("jason", e.alamos)).toBe(true);
    expect(await e.home("jason", e.cedros)).toBe(true);
    expect(await e.home("jason", e.bosque)).toBe(false);
    expect(await e.contexto("jason")).toEqual({ tipo: "permanente", cobertura: null, refrescarEn: null });
    await e.abrirTurno("jason", e.alamos);
  });

  test("D. inhabilitación: el acceso a B desaparece al instante y vuelve A", async () => {
    const coberturaId = await e.cubrir(e.jason, e.bosque, e.kBosque);
    en(DURANTE);
    expect(await e.home("jason", e.bosque)).toBe(true);

    await e.como("alicia").mutation(api.coberturas.inhabilitar, {
      coberturaId,
      motivo: "El guarda se retiró del puesto.",
    });

    expect(await e.home("jason", e.bosque)).toBe(false);
    expect(await e.home("jason", e.alamos)).toBe(true);
    await expect(e.abrirTurno("jason", e.bosque)).rejects.toThrow("No pertenece a este condominio.");
    expect((await e.contexto("jason")).tipo).toBe("permanente");
  });

  test("E. contrato de B terminado: la cobertura no concede acceso", async () => {
    await e.cubrir(e.jason, e.bosque, e.kBosque);
    en(DURANTE);
    await e.t.run((ctx) => ctx.db.patch(e.kBosque, { terminadoEn: DURANTE - MIN }));

    expect(await e.home("jason", e.bosque)).toBe(false);
    expect(await e.home("jason", e.alamos)).toBe(true);
    expect((await e.contexto("jason")).tipo).toBe("permanente");
  });

  test("F. conjunto B inactivo: la cobertura no concede acceso", async () => {
    await e.cubrir(e.jason, e.bosque, e.kBosque);
    en(DURANTE);
    await e.t.run((ctx) => ctx.db.patch(e.bosque, { isActive: false }));

    expect(await e.home("jason", e.bosque)).toBe(false);
    expect(await e.home("jason", e.alamos)).toBe(true);
    expect((await e.contexto("jason")).tipo).toBe("permanente");
  });

  test("G. compañía suspendida: la cobertura deja de ser vía", async () => {
    await e.cubrir(e.mateo, e.bosque, e.kBosque);
    en(DURANTE);
    expect(await e.home("mateo", e.alamos)).toBe(false);

    await e.t.run((ctx) => ctx.db.patch(e.andina, { estado: "suspendida" }));

    expect(await e.home("mateo", e.bosque)).toBe(false);
    expect((await e.contexto("mateo")).tipo).toBe("permanente");
    // Su membresía de guarda propio no cuelga de la compañía: vuelve a valer.
    expect(await e.home("mateo", e.alamos)).toBe(true);
  });

  test("H. miembro dado de baja: la cobertura deja de ser vía", async () => {
    await e.cubrir(e.mateo, e.bosque, e.kBosque);
    en(DURANTE);
    expect(await e.home("mateo", e.bosque)).toBe(true);

    await e.t.run((ctx) => ctx.db.patch(e.mMateo, { isActive: false }));

    expect(await e.home("mateo", e.bosque)).toBe(false);
    expect((await e.contexto("mateo")).tipo).toBe("permanente");
    expect(await e.home("mateo", e.alamos)).toBe(true);
  });

  test("I. vías múltiples (A y C permanentes, cobertura B): solo B opera", async () => {
    await e.cubrir(e.jason, e.bosque, e.kBosque);
    en(DURANTE);

    expect(await e.home("jason", e.alamos)).toBe(false);
    expect(await e.home("jason", e.cedros)).toBe(false);
    expect(await e.home("jason", e.bosque)).toBe(true);
    expect(await e.exige("jason", e.alamos)).toContain(CUBRIENDO_BOSQUE);
    expect(await e.exige("jason", e.cedros)).toContain(CUBRIENDO_BOSQUE);
    expect(await e.exige("jason", e.bosque)).toBe(true);

    // La sesión conserva sus asignaciones: a ellas vuelve cuando termine.
    const me = await e.como("jason").query(api.users.me, {});
    expect(me!.asignaciones.map((a) => a.condominioNombre)).toEqual([
      "Conjunto Alamos",
      "Conjunto Cedros",
    ]);
    expect(me!.contextoOperativoGuardia.cobertura?.condominioId).toBe(e.bosque);
  });

  test("J. membresía con rol guardia en A: también queda suspendida", async () => {
    await e.cubrir(e.mateo, e.bosque, e.kBosque);
    en(AHORA);
    expect(await e.home("mateo", e.alamos)).toBe(true);

    en(DURANTE);
    expect(await e.home("mateo", e.alamos)).toBe(false);
    expect(await e.home("mateo", e.bosque)).toBe(true);
    expect(await e.exige("mateo", e.alamos)).toContain(CUBRIENDO_BOSQUE);
    // Era solo de guarda: se suspende entera, también para "cualquier miembro".
    expect(await e.exige("mateo", e.alamos, [])).toContain(CUBRIENDO_BOSQUE);
    expect((await e.acceso("mateo", e.alamos)).rolesConjunto).toBeNull();
    await expect(
      e.como("mateo").query(api.condominios.get, { condominioId: e.alamos }),
    ).rejects.toThrow("No tiene acceso a este conjunto.");
  });

  test("K. membresía con otros roles: no desaparece", async () => {
    await e.cubrir(e.paula, e.bosque, e.kBosque);
    await e.cubrir(e.jason, e.cedros, e.kCedros, { inicio: INICIO, fin: FIN });
    en(DURANTE);

    // Paula: pierde el rol de guarda en Alamos y conserva el de propietaria.
    expect(await e.exige("paula", e.alamos, ["propietario"])).toBe(true);
    expect(await e.exige("paula", e.alamos)).toContain(CUBRIENDO_BOSQUE);
    const dePaula = await e.acceso("paula", e.alamos);
    expect(dePaula.rolesConjunto).toEqual(["propietario"]);
    expect(dePaula.capacidades).not.toContain("porteria.operar");
    expect(await e.home("paula", e.alamos)).toBe(false);
    await e.como("paula").query(api.condominios.get, { condominioId: e.alamos });

    // Jason, que cubre Cedros: su casa en Dalias sigue siendo suya.
    expect(await e.exige("jason", e.dalias, ["propietario"])).toBe(true);
    expect((await e.acceso("jason", e.dalias)).rolesConjunto).toEqual(["propietario"]);
    await e.como("jason").query(api.condominios.get, { condominioId: e.dalias });
  });

  test("L. turno abierto antes de la cobertura: se puede cerrar; no se abre uno nuevo en A", async () => {
    await e.cubrir(e.jason, e.bosque, e.kBosque);
    en(AHORA);
    const turnoId = await e.abrirTurno("jason", e.alamos);

    en(DURANTE);
    // En A no opera: ni turno nuevo, ni ronda, ni minuta.
    await expect(e.abrirTurno("jason", e.alamos)).rejects.toThrow(CUBRIENDO_BOSQUE);
    await expect(
      e.como("jason").mutation(api.rondas.iniciar, { condominioId: e.alamos }),
    ).rejects.toThrow(CUBRIENDO_BOSQUE);
    await expect(
      e.como("jason").mutation(api.guardia.registrarEventoMinuta, {
        condominioId: e.alamos,
        tipo: "Anotación",
        resumen: "Ronda perimetral",
      }),
    ).rejects.toThrow(CUBRIENDO_BOSQUE);

    // Pero su turno de antes sí se puede cerrar, y la web tiene desde dónde.
    const pendiente = await e.como("jason").query(api.guardia.turnoPendienteDeCierre, {});
    expect(pendiente?.turno._id).toBe(turnoId);
    expect(pendiente?.condominioNombre).toBe("Conjunto Alamos");
    const relevos = await e.como("jason").query(api.guardia.relevosDelTurno, { turnoId });
    expect(relevos.map((g) => g.userId)).toContain(e.lucas);
    expect(relevos.map((g) => g.userId)).not.toContain(e.jason);

    await e.como("jason").mutation(api.guardia.cerrarTurno, {
      turnoId,
      recibeUserId: e.lucas,
      ...CIERRE,
    });
    const cerrado = await e.t.run((ctx) => ctx.db.get(turnoId));
    expect(cerrado?.estado).toBe("cerrado");
    expect(cerrado?.cerradoPorUserId).toBe(e.jason);
    expect(await e.como("jason").query(api.guardia.turnoPendienteDeCierre, {})).toBeNull();

    // Cerrado el suyo, sigue sin poder abrir otro en A.
    await expect(e.abrirTurno("jason", e.alamos)).rejects.toThrow(CUBRIENDO_BOSQUE);
  });

  test("L'. la excepción no alcanza a un turno abierto después del inicio ni a uno ajeno", async () => {
    await e.cubrir(e.jason, e.bosque, e.kBosque);
    // Un turno suyo con hora de apertura posterior al inicio (no se puede
    // abrir por API; se fuerza para fijar la regla) y uno de Lucas.
    const tarde = await e.t.run((ctx) =>
      ctx.db.insert("guardiaTurnos", {
        condominioId: e.alamos,
        guardiaUserId: e.jason,
        guardiaNombre: "Jason Guarda",
        checklist: CHECKLIST,
        estado: "abierto",
        fechaInicio: INICIO + MIN,
        createdAt: INICIO + MIN,
        updatedAt: INICIO + MIN,
      }),
    );
    en(DURANTE);
    await expect(
      e.como("jason").mutation(api.guardia.cerrarTurno, { turnoId: tarde, recibe: "Lucas", ...CIERRE }),
    ).rejects.toThrow(CUBRIENDO_BOSQUE);
    expect(await e.como("jason").query(api.guardia.turnoPendienteDeCierre, {})).toBeNull();

    await e.t.run((ctx) => ctx.db.patch(tarde, { estado: "cerrado" }));
    const deLucas = await e.abrirTurno("lucas", e.alamos);
    await expect(
      e.como("jason").mutation(api.guardia.cerrarTurno, { turnoId: deLucas, recibe: "Otro", ...CIERRE }),
    ).rejects.toThrow(CUBRIENDO_BOSQUE);
  });

  test("M. relevo: aparece en B y no en A", async () => {
    await e.cubrir(e.jason, e.bosque, e.kBosque);
    en(AHORA);
    expect((await e.como("lucas").query(api.guardia.equipo, { condominioId: e.alamos })).map((g) => g.userId))
      .toContain(e.jason);

    en(DURANTE);
    const enAlamos = await e.como("lucas").query(api.guardia.equipo, { condominioId: e.alamos });
    expect(enAlamos.map((g) => g.userId)).not.toContain(e.jason);
    const enBosque = await e.como("bruno").query(api.guardia.equipo, { condominioId: e.bosque });
    expect(enBosque.map((g) => g.userId)).toContain(e.jason);

    // El servidor lo comprueba igual al cerrar.
    const turnoA = await e.abrirTurno("lucas", e.alamos);
    await expect(
      e.como("lucas").mutation(api.guardia.cerrarTurno, { turnoId: turnoA, recibeUserId: e.jason, ...CIERRE }),
    ).rejects.toThrow("El relevo elegido no es un guarda vigente de esta portería.");
    const turnoB = await e.abrirTurno("bruno", e.bosque);
    await e.como("bruno").mutation(api.guardia.cerrarTurno, {
      turnoId: turnoB,
      recibeUserId: e.jason,
      ...CIERRE,
    });
  });

  test("N. users.me expone el contexto operativo y cuándo volver a preguntar", async () => {
    const coberturaId = await e.cubrir(e.jason, e.bosque, e.kBosque);
    // Otra aceptada más adelante: el próximo cambio después de FIN es su inicio.
    await e.cubrir(e.jason, e.bosque, e.kBosque, { inicio: FIN + 3 * HORA, fin: FIN + 5 * HORA });

    en(AHORA);
    expect(await e.contexto("jason")).toEqual({ tipo: "permanente", cobertura: null, refrescarEn: INICIO });

    en(DURANTE);
    expect(await e.contexto("jason")).toEqual({
      tipo: "cobertura",
      cobertura: {
        coberturaId,
        condominioId: e.bosque,
        condominioNombre: "Conjunto Bosque",
        condominioLogo: null,
        condominioColor: null,
        companiaId: e.andina,
        companiaNombre: "Seguridad Andina",
        inicio: INICIO,
        fin: FIN,
      },
      refrescarEn: FIN,
    });

    en(DESPUES);
    expect(await e.contexto("jason")).toEqual({
      tipo: "permanente",
      cobertura: null,
      refrescarEn: FIN + 3 * HORA,
    });

    // `meOperativo` es la misma respuesta; `refresco` solo cambia el argumento.
    en(DURANTE);
    expect(await e.como("jason").query(api.users.meOperativo, { refresco: DURANTE })).toEqual(
      await e.como("jason").query(api.users.me, {}),
    );
  });

  test("O. la URL directa /guardia/A no salta la restricción", async () => {
    await e.cubrir(e.jason, e.bosque, e.kBosque);
    en(DURANTE);

    // Lo que pinta la portería de A: el shell y lo que monta encima.
    expect(await e.como("jason").query(api.guardia.home, { condominioId: e.alamos })).toEqual({
      allowed: false,
    });
    await expect(e.como("jason").query(api.guardia.turnoActivo, { condominioId: e.alamos }))
      .rejects.toThrow(CUBRIENDO_BOSQUE);
    await expect(e.como("jason").query(api.guardia.equipo, { condominioId: e.alamos }))
      .rejects.toThrow(CUBRIENDO_BOSQUE);
    await expect(e.como("jason").query(api.guardia.listAvisos, { condominioId: e.alamos }))
      .rejects.toThrow(CUBRIENDO_BOSQUE);
    await expect(e.como("jason").query(api.guardia.listMinuta, { condominioId: e.alamos }))
      .rejects.toThrow("porteria.ver");
    await expect(e.como("jason").query(api.condominios.get, { condominioId: e.alamos }))
      .rejects.toThrow("No tiene acceso a este conjunto.");
  });

  test("P. una llamada directa al backend sobre A se rechaza; sobre B pasa", async () => {
    await e.cubrir(e.jason, e.bosque, e.kBosque);
    en(DURANTE);
    const jason = e.como("jason");

    await expect(e.abrirTurno("jason", e.alamos)).rejects.toThrow(CUBRIENDO_BOSQUE);
    await expect(jason.mutation(api.rondas.iniciar, { condominioId: e.alamos })).rejects.toThrow(CUBRIENDO_BOSQUE);
    await expect(
      jason.mutation(api.guardia.reportarNovedad, {
        condominioId: e.alamos,
        titulo: "Puerta abierta",
        descripcion: "La reja quedó abierta.",
        prioridad: "media",
      }),
    ).rejects.toThrow(CUBRIENDO_BOSQUE);
    await expect(jason.query(api.aporte.consultarPlaca, { condominioId: e.alamos, placa: "ABC123" }))
      .rejects.toThrow(CUBRIENDO_BOSQUE);
    const incidente = {
      tipo: "ACCESO",
      ubicacion: "Portería",
      ocurrioEn: DURANTE - MIN,
      descripcion: "Intento de ingreso sin autorización.",
      prioridad: "MEDIA" as const,
    };
    await expect(jason.mutation(api.incidentes.crear, { condominioId: e.alamos, ...incidente }))
      .rejects.toThrow("incidentes.crear");

    // En B, todo por la cobertura.
    await e.abrirTurno("jason", e.bosque);
    await jason.mutation(api.guardia.registrarEventoMinuta, {
      condominioId: e.bosque,
      tipo: "Anotación",
      resumen: "Recibo la portería por cobertura.",
    });
    await jason.mutation(api.guardia.reportarNovedad, {
      condominioId: e.bosque,
      titulo: "Luz dañada",
      descripcion: "La luz de la entrada no prende.",
      prioridad: "baja",
    });
    await jason.mutation(api.incidentes.crear, { condominioId: e.bosque, ...incidente });
    const bandeja = await jason.query(api.incidentes.contextoBandeja, {});
    expect(bandeja?.conjuntos.map((c) => c.condominioId)).toEqual([e.bosque]);
  });

  test("Q. sin cobertura: el contexto es permanente y las vías no cambian", async () => {
    en(DURANTE);
    expect(await e.contexto("jason")).toEqual({ tipo: "permanente", cobertura: null, refrescarEn: null });
    expect(await e.home("jason", e.alamos)).toBe(true);
    expect(await e.home("jason", e.cedros)).toBe(true);
    expect(await e.home("mateo", e.alamos)).toBe(true);
    expect(await e.home("jason", e.bosque)).toBe(false);
    expect(await e.exige("mateo", e.alamos, [])).toBe(true);
    expect((await e.acceso("paula", e.alamos)).rolesConjunto).toEqual(["guardia", "propietario"]);
    expect((await e.acceso("jason", e.alamos)).coberturaCondominioId).toBeNull();
  });

  test("R. con coberturas históricas, solo la vigente genera la vía", async () => {
    // Bruno es de Bosque. Una terminada, una inhabilitada, una cancelada, una
    // rechazada y una futura, todas fuera de juego; y la vigente, en Cedros.
    await e.cubrir(e.bruno, e.alamos, e.kAlamos, { inicio: AHORA - 2 * DIA, fin: AHORA - DIA });
    await e.cubrir(e.bruno, e.alamos, e.kAlamos, { estado: "inhabilitada", inhabilitadaEn: INICIO });
    await e.cubrir(e.bruno, e.alamos, e.kAlamos, { estado: "cancelada" });
    await e.cubrir(e.bruno, e.alamos, e.kAlamos, { estado: "rechazada", respuesta: "rechazada" });
    await e.cubrir(e.bruno, e.alamos, e.kAlamos, { inicio: FIN + DIA, fin: FIN + DIA + HORA });
    const vigente = await e.cubrir(e.bruno, e.cedros, e.kCedros);
    en(DURANTE);

    const contexto = await e.contexto("bruno");
    expect(contexto.tipo).toBe("cobertura");
    expect(contexto.cobertura?.coberturaId).toBe(vigente);
    expect(await e.home("bruno", e.cedros)).toBe(true);
    expect(await e.home("bruno", e.alamos)).toBe(false);
    expect(await e.home("bruno", e.bosque)).toBe(false);
  });

  test("inconsistencia: dos coberturas activas a la vez bloquean la operación de guarda", async () => {
    await e.cubrir(e.jason, e.bosque, e.kBosque);
    await e.cubrir(e.jason, e.cedros, e.kCedros);
    en(DURANTE);

    expect((await e.contexto("jason")).tipo).toBe("bloqueado");
    for (const condominioId of [e.alamos, e.bosque, e.cedros]) {
      expect(await e.home("jason", condominioId)).toBe(false);
    }
    expect(await e.exige("jason", e.alamos)).toContain("más de una cobertura activa");
    expect(await e.exige("jason", e.bosque)).toBe("No pertenece a este condominio.");
    // Ni de relevo en ninguna de las dos.
    const enBosque = await e.como("bruno").query(api.guardia.equipo, { condominioId: e.bosque });
    expect(enBosque.map((g) => g.userId)).not.toContain(e.jason);
    // Lo que no es de guarda sigue en pie.
    expect(await e.exige("jason", e.dalias, ["propietario"])).toBe(true);
  });

  test("S. hora exacta de inicio: antes no existe la vía; en `inicio` sí", async () => {
    await e.cubrir(e.jason, e.bosque, e.kBosque);

    en(INICIO - 1);
    expect(await e.home("jason", e.bosque)).toBe(false);
    expect(await e.home("jason", e.alamos)).toBe(true);
    expect(await e.contexto("jason")).toEqual({ tipo: "permanente", cobertura: null, refrescarEn: INICIO });

    en(INICIO);
    expect(await e.home("jason", e.bosque)).toBe(true);
    expect(await e.home("jason", e.alamos)).toBe(false);
    expect((await e.contexto("jason")).refrescarEn).toBe(FIN);
  });

  test("T. hora exacta de fin: antes existe; en `fin` deja de existir", async () => {
    await e.cubrir(e.jason, e.bosque, e.kBosque);

    en(FIN - 1);
    expect(await e.home("jason", e.bosque)).toBe(true);
    expect(await e.home("jason", e.alamos)).toBe(false);

    en(FIN);
    expect(await e.home("jason", e.bosque)).toBe(false);
    expect(await e.home("jason", e.alamos)).toBe(true);
    expect(await e.contexto("jason")).toEqual({ tipo: "permanente", cobertura: null, refrescarEn: null });
  });
});

describe("Fase 8: requireCondominioRole y resolverAcceso dicen lo mismo", () => {
  test("en cada conjunto, momento y persona, pasar como guarda ⇔ tener porteria.operar", async () => {
    await e.cubrir(e.jason, e.bosque, e.kBosque);
    await e.cubrir(e.mateo, e.bosque, e.kBosque);
    await e.cubrir(e.paula, e.cedros, e.kCedros);
    const personas = ["jason", "mateo", "paula", "bruno", "lucas"];
    const conjuntos = [e.alamos, e.bosque, e.cedros, e.dalias];

    for (const momento of [AHORA, DURANTE, DESPUES]) {
      en(momento);
      for (const persona of personas) {
        for (const condominioId of conjuntos) {
          const pasa = (await e.exige(persona, condominioId)) === true;
          const resuelto = await e.acceso(persona, condominioId);
          expect({ momento, persona, condominioId, pasa }).toEqual({
            momento,
            persona,
            condominioId,
            pasa: resuelto.capacidades.includes("porteria.operar"),
          });

          const comoPropietario = (await e.exige(persona, condominioId, ["propietario"])) === true;
          const roles = resuelto.rolesConjunto ?? [];
          expect({ momento, persona, condominioId, comoPropietario }).toEqual({
            momento,
            persona,
            condominioId,
            comoPropietario: roles.includes("propietario"),
          });
        }
      }
    }
  });
});
