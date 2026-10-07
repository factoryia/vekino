import { test, expect, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest } from "convex-test";
import betterAuthTest from "@convex-dev/better-auth/test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { createAuth } from "../convex/auth";
import {
  CHECKLIST,
  CIERRE,
  DIA,
  HORA,
  MIN,
  T17,
  modules,
  montar,
  type Escenario,
} from "./helpers/trazabilidad";
import {
  esPaginaDeSuCompania,
  puedeVerDetalleCompania,
} from "../../../apps/web/lib/role-routing";
import { mensajeErrorUsuario } from "../../../apps/web/lib/utils";
import fuenteDialogoInasistencias from "../../../apps/web/components/companias/inasistencias/registrar-dialog.tsx?raw";
import fuenteInicioUsuario from "../../../apps/web/app/dashboard/page.tsx?raw";
import fuentePortal from "../../../apps/web/components/portal/portal-shell.tsx?raw";
import fuentePaginaCompania from "../../../apps/web/app/dashboard/companias/[id]/page.tsx?raw";
import fuenteEditarPersona from "../../../apps/web/components/companias/editar-persona-dialog.tsx?raw";
import fuentePorteria from "../../../apps/web/app/guardia/[id]/page.tsx?raw";

/**
 * CORRECCIONES POSTERIORES AL QA MANUAL (Fase 15).
 *
 * Una seccion por defecto del reporte de la Fase 14, con sus casos. Cada una
 * empieza por el escenario que reprodujo el defecto y termina en la regla que
 * lo cierra.
 */

// ═════════════════════════════════════════════════════════════
// QA-003 — apropiacion de cuentas existentes por el alta de personal
// ═════════════════════════════════════════════════════════════

const CLAVE = "clave-de-prueba-1";
const CLAVE_ROSA = "clave-residente-9";
const CLAVE_ADM = "clave-del-conjunto-7";
const CLAVE_SUPER = "clave-super-dos-8";
const CLAVE_INTRUSA = "clave-intrusa-4";
const CLAVE_NUEVA = "otra-clave-larga-7";

const PLATAFORMA = /cuenta es de la plataforma/i;

async function montarCuentas() {
  const t = convexTest(schema, modules);
  betterAuthTest.register(t);
  const ahora = Date.now();
  await t.run(async (ctx) => {
    for (const [authId, name, platformRole] of [
      ["super", "Super", "superadmin"],
      ["padmin", "Pablo Plataforma", "admin"],
    ] as const) {
      await ctx.db.insert("users", {
        name,
        email: `${authId}@vekino.test`,
        emailVerified: true,
        active: true,
        authId,
        platformRole,
        createdAt: ahora,
        updatedAt: ahora,
      });
    }
  });
  const plataforma = t.withIdentity({ subject: "super" });
  const plataformaAdmin = t.withIdentity({ subject: "padmin" });

  const alfa = await plataforma.action(api.companias.registrar, {
    nombre: "Seguridad Alfa",
    adminName: "Alicia Alfa",
    adminEmail: "alicia@alfa.test",
    adminPassword: CLAVE,
  });
  const beta = await plataforma.action(api.companias.registrar, {
    nombre: "Seguridad Beta",
    adminName: "Bruno Beta",
    adminEmail: "bruno@beta.test",
    adminPassword: CLAVE,
  });
  const norte = await plataforma.mutation(api.condominios.create, { name: "Conjunto Norte" });
  const sur = await plataforma.mutation(api.condominios.create, { name: "Conjunto Sur" });
  await plataforma.action(api.users.createCondoMember, {
    condominioId: norte,
    email: "rosa@norte.test",
    name: "Rosa Residente",
    password: CLAVE_ROSA,
    roles: ["propietario"],
  });
  await plataforma.action(api.users.createCondoMember, {
    condominioId: norte,
    email: "adm@norte.test",
    name: "Andres Administrador",
    password: CLAVE_ADM,
    roles: ["administrador"],
  });
  await plataforma.action(api.users.createCondoMember, {
    condominioId: sur,
    email: "adm@sur.test",
    name: "Sara Sur",
    password: CLAVE_ADM,
    roles: ["administrador"],
  });
  await plataforma.action(api.users.createPlatformAdmin, {
    email: "super2@vekino.test",
    name: "Super Dos",
    password: CLAVE_SUPER,
    platformRole: "superadmin",
  });

  const perfil = (email: string) =>
    t.run(async (ctx) =>
      ctx.db
        .query("users")
        .withIndex("by_email", (q) => q.eq("email", email))
        .unique(),
    );
  const como = async (email: string) => t.withIdentity({ subject: (await perfil(email))!.authId! });

  /** Todo lo que el alta NO debe tocar de una cuenta existente. */
  const huella = (email: string) =>
    t.run(async (ctx) => {
      const u = await ctx.db
        .query("users")
        .withIndex("by_email", (q) => q.eq("email", email))
        .unique();
      const ia = (await createAuth(ctx as never).$context).internalAdapter;
      const found = await ia.findUserByEmail(email);
      const cuenta = found
        ? (await ia.findAccounts(found.user.id)).find((a) => a.providerId === "credential")
        : null;
      return {
        hash: cuenta?.password ?? null,
        platformRole: u?.platformRole ?? null,
        name: u?.name ?? null,
        active: u?.active ?? null,
        authId: u?.authId ?? null,
        telefono: u?.telefono ?? null,
      };
    });

  const claveSirve = (email: string, password: string) =>
    t.run(async (ctx) => {
      const authCtx = await createAuth(ctx as never).$context;
      const ia = authCtx.internalAdapter;
      const found = await ia.findUserByEmail(email);
      if (!found) return false;
      const cuenta = (await ia.findAccounts(found.user.id)).find((a) => a.providerId === "credential");
      if (!cuenta?.password) return false;
      return await authCtx.password.verify({ hash: cuenta.password, password });
    });

  const miembrosDe = (email: string) =>
    t.run(async (ctx) => {
      const u = await ctx.db
        .query("users")
        .withIndex("by_email", (q) => q.eq("email", email))
        .unique();
      if (!u) return [];
      return await ctx.db
        .query("companiaMiembros")
        .withIndex("by_user", (q) => q.eq("userId", u._id))
        .collect();
    });

  return { t, plataforma, plataformaAdmin, alfa, beta, norte, sur, perfil, como, huella, claveSirve, miembrosDe };
}

type Cuentas = Awaited<ReturnType<typeof montarCuentas>>;

describe("QA-003 · el alta de personal no se apropia de cuentas existentes", () => {
  let c: Cuentas;
  beforeEach(async () => {
    /* Con el reloj de verdad: las altas pasan en instantes distintos. */
    vi.useRealTimers();
    c = await montarCuentas();
  });

  const alta = async (quien: string, companiaId: Id<"companiasSeguridad">, email: string, password: string, name = "Nombre Cualquiera") =>
    (await c.como(quien)).action(api.companias.crearMiembro, { companiaId, email, name, password, roles: ["guardia"] });

  test("A · cuenta nueva: se crea con la clave del alta", async () => {
    const r = await alta("alicia@alfa.test", c.alfa.companiaId, "gabriel@alfa.test", CLAVE, "Gabriel Guarda");
    expect(r.existed).toBe(false);
    expect(await c.claveSirve("gabriel@alfa.test", CLAVE)).toBe(true);
    expect((await c.huella("gabriel@alfa.test")).authId).toBeTruthy();
  });

  test("B · residente existente: entra como guarda y conserva su clave, su nombre y su conjunto", async () => {
    const antes = await c.huella("rosa@norte.test");
    const r = await alta("alicia@alfa.test", c.alfa.companiaId, "rosa@norte.test", CLAVE_INTRUSA, "Nombre Inventado");
    expect(r.existed).toBe(true);
    expect(await c.huella("rosa@norte.test")).toEqual(antes);
    expect(await c.claveSirve("rosa@norte.test", CLAVE_ROSA)).toBe(true);
    expect(await c.claveSirve("rosa@norte.test", CLAVE_INTRUSA)).toBe(false);
    const miembros = await c.miembrosDe("rosa@norte.test");
    expect(miembros.map((m) => [m.companiaId, m.isActive, m.roles])).toEqual([[c.alfa.companiaId, true, ["guardia"]]]);
    const me = await (await c.como("rosa@norte.test")).query(api.users.me, {});
    expect(me!.memberships.map((m) => m.roles)).toEqual([["propietario"]]);
  });

  test("B · y despues tampoco se le puede poner clave ni correo desde la compania", async () => {
    const r = await alta("alicia@alfa.test", c.alfa.companiaId, "rosa@norte.test", CLAVE_INTRUSA);
    const alicia = await c.como("alicia@alfa.test");
    const antes = await c.huella("rosa@norte.test");
    await expect(
      alicia.action(api.companias.setPasswordMiembro, { miembroId: r.miembroId, password: CLAVE_NUEVA }),
    ).rejects.toThrow();
    await expect(
      alicia.action(api.companias.setEmailMiembro, { miembroId: r.miembroId, email: "rosa.robada@alfa.test" }),
    ).rejects.toThrow();
    expect(await c.huella("rosa@norte.test")).toEqual(antes);
    expect((await c.perfil("rosa@norte.test"))?.email).toBe("rosa@norte.test");
  });

  test("C · administrador de conjunto existente: entra sin tocar credenciales ni plataforma", async () => {
    const antes = await c.huella("adm@norte.test");
    const r = await alta("alicia@alfa.test", c.alfa.companiaId, "adm@norte.test", CLAVE_INTRUSA);
    expect(r.existed).toBe(true);
    expect(await c.huella("adm@norte.test")).toEqual(antes);
    expect(await c.claveSirve("adm@norte.test", CLAVE_ADM)).toBe(true);
    await expect(
      (await c.como("alicia@alfa.test")).action(api.companias.setPasswordMiembro, { miembroId: r.miembroId, password: CLAVE_NUEVA }),
    ).rejects.toThrow();
  });

  test("D · superadministrador existente: se rechaza, por cualquier camino", async () => {
    const antes = await c.huella("super2@vekino.test");
    const alicia = await c.como("alicia@alfa.test");
    await expect(alta("alicia@alfa.test", c.alfa.companiaId, "super2@vekino.test", CLAVE_INTRUSA)).rejects.toThrow(PLATAFORMA);
    /* Manipulando el payload: la mutacion de perfil que usa la accion, llamada directa. */
    await expect(
      alicia.mutation(api.companias.upsertMiembroProfile, {
        companiaId: c.alfa.companiaId,
        email: "super2@vekino.test",
        name: "Super Dos",
        roles: ["admin_compania"],
      }),
    ).rejects.toThrow(PLATAFORMA);
    /* Ni registrando una compania con su correo como administrador. */
    await expect(
      c.plataformaAdmin.action(api.companias.registrar, {
        nombre: "Seguridad Trampa",
        adminName: "Super Dos",
        adminEmail: "super2@vekino.test",
        adminPassword: CLAVE_INTRUSA,
      }),
    ).rejects.toThrow(PLATAFORMA);
    expect(await c.huella("super2@vekino.test")).toEqual(antes);
    expect(await c.miembrosDe("super2@vekino.test")).toEqual([]);
    expect(await c.claveSirve("super2@vekino.test", CLAVE_SUPER)).toBe(true);
  });

  test("D · el staff de plataforma que no es superadmin no reparte ni toma cuentas privilegiadas", async () => {
    const antes = await c.huella("super2@vekino.test");
    await expect(
      c.plataformaAdmin.action(api.users.createPlatformAdmin, {
        email: "super2@vekino.test",
        name: "Super Dos",
        password: CLAVE_INTRUSA,
        platformRole: "admin",
      }),
    ).rejects.toThrow(/superadmin/i);
    await expect(
      c.plataformaAdmin.mutation(api.users.upsertPlatformAdminProfile, {
        email: "padmin@vekino.test",
        name: "Pablo Plataforma",
        platformRole: "superadmin",
      }),
    ).rejects.toThrow(/superadmin/i);
    expect(await c.huella("super2@vekino.test")).toEqual(antes);
    expect((await c.perfil("padmin@vekino.test"))?.platformRole).toBe("admin");
  });

  test("D · el superadmin que promueve una cuenta existente no le reescribe la clave", async () => {
    const antes = await c.huella("rosa@norte.test");
    await c.plataforma.action(api.users.createPlatformAdmin, {
      email: "rosa@norte.test",
      name: "Rosa Residente",
      password: CLAVE_INTRUSA,
      platformRole: "admin",
    });
    expect((await c.huella("rosa@norte.test")).hash).toBe(antes.hash);
    expect(await c.claveSirve("rosa@norte.test", CLAVE_ROSA)).toBe(true);
  });

  test("E y F · contrasena y platformRole identicos antes y despues, en todas las altas sobre cuentas existentes", async () => {
    const correos = ["rosa@norte.test", "adm@norte.test", "adm@sur.test", "super2@vekino.test"];
    const antes = await Promise.all(correos.map((e) => c.huella(e)));
    for (const email of correos) {
      await alta("alicia@alfa.test", c.alfa.companiaId, email, CLAVE_INTRUSA).catch(() => null);
    }
    const despues = await Promise.all(correos.map((e) => c.huella(e)));
    expect(despues.map((h) => h.hash)).toEqual(antes.map((h) => h.hash));
    expect(despues.map((h) => h.platformRole)).toEqual(antes.map((h) => h.platformRole));
  });

  test("G · repetir el alta no duplica la relacion ni regenera la credencial", async () => {
    await alta("alicia@alfa.test", c.alfa.companiaId, "gabriel@alfa.test", CLAVE, "Gabriel Guarda");
    const antes = await c.huella("gabriel@alfa.test");
    const otra = await alta("alicia@alfa.test", c.alfa.companiaId, "gabriel@alfa.test", CLAVE_INTRUSA, "Gabriel Guarda");
    expect(otra.existed).toBe(true);
    expect((await c.huella("gabriel@alfa.test")).hash).toBe(antes.hash);
    expect(await c.claveSirve("gabriel@alfa.test", CLAVE)).toBe(true);
    expect(await c.miembrosDe("gabriel@alfa.test")).toHaveLength(1);
    /* La cuenta que la compania SI creo la sigue gestionando ella. */
    await (await c.como("alicia@alfa.test")).action(api.companias.setPasswordMiembro, {
      miembroId: otra.miembroId,
      password: CLAVE_NUEVA,
    });
    expect(await c.claveSirve("gabriel@alfa.test", CLAVE_NUEVA)).toBe(true);
  });

  test("H · otra compania: ni la nueva ni la anterior pueden apropiarse de la cuenta", async () => {
    const alicia = await c.como("alicia@alfa.test");
    const enAlfa = await alta("alicia@alfa.test", c.alfa.companiaId, "mario@alfa.test", CLAVE, "Mario Movil");
    await alicia.mutation(api.companias.desactivarMiembro, { miembroId: enAlfa.miembroId });
    const antes = await c.huella("mario@alfa.test");
    const enBeta = await alta("bruno@beta.test", c.beta.companiaId, "mario@alfa.test", CLAVE_INTRUSA, "Mario Movil");
    expect(enBeta.existed).toBe(true);
    expect((await c.huella("mario@alfa.test")).hash).toBe(antes.hash);
    await expect(
      (await c.como("bruno@beta.test")).action(api.companias.setPasswordMiembro, { miembroId: enBeta.miembroId, password: CLAVE_NUEVA }),
    ).rejects.toThrow();
    await expect(
      alicia.action(api.companias.setPasswordMiembro, { miembroId: enAlfa.miembroId, password: CLAVE_NUEVA }),
    ).rejects.toThrow();
    expect(await c.claveSirve("mario@alfa.test", CLAVE)).toBe(true);
  });

  test("eje del conjunto: el administrador de un conjunto tampoco se apropia de cuentas de compania ni de otro conjunto", async () => {
    const adm = await c.como("adm@norte.test");
    const antesAlicia = await c.huella("alicia@alfa.test");
    const antesSur = await c.huella("adm@sur.test");
    for (const [email, name] of [["alicia@alfa.test", "Alicia Alfa"], ["adm@sur.test", "Sara Sur"]] as const) {
      await adm.action(api.users.createCondoMember, {
        condominioId: c.norte,
        email,
        name,
        password: CLAVE_INTRUSA,
        roles: ["propietario"],
      });
    }
    expect((await c.huella("alicia@alfa.test")).hash).toBe(antesAlicia.hash);
    expect((await c.huella("adm@sur.test")).hash).toBe(antesSur.hash);
    for (const email of ["alicia@alfa.test", "adm@sur.test"]) {
      await expect(
        adm.action(api.users.setMemberPassword, { condominioId: c.norte, userId: (await c.perfil(email))!._id, password: CLAVE_NUEVA }),
      ).rejects.toThrow();
    }
    expect(await c.claveSirve("alicia@alfa.test", CLAVE)).toBe(true);
    expect(await c.claveSirve("adm@sur.test", CLAVE_ADM)).toBe(true);
    /* Lo de siempre sigue: su propio residente sí. */
    await adm.action(api.users.setMemberPassword, {
      condominioId: c.norte,
      userId: (await c.perfil("rosa@norte.test"))!._id,
      password: CLAVE_NUEVA,
    });
    expect(await c.claveSirve("rosa@norte.test", CLAVE_NUEVA)).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════
// Escenario operativo (reloj fijo): QA-008, QA-001, QA-004, QA-005, QA-006
// ═════════════════════════════════════════════════════════════

const en = (t: number) => vi.setSystemTime(t);
const instante = (local: string) => Date.parse(`${local}:00-05:00`);
const horas = (inicioLocal: string, finLocal: string) => ({ diaCompleto: false as const, inicioLocal, finLocal });
const DE_DIA = [0, 1, 2, 3, 4, 5, 6].map((dia) => ({ dia, horaInicio: "06:00", horaFin: "18:00" }));
/** La noche del domingo 11 de octubre. */
const NOCHE = horas("2026-10-11T18:00", "2026-10-12T06:00");

let e: Escenario;
beforeEach(() => {
  en(T17);
});
afterEach(() => vi.useRealTimers());

async function guardaDeCompania(
  authId: string,
  name: string,
  extra: { membresia?: { condominioId: Id<"condominios">; roles: string[] } } = {},
): Promise<Id<"users">> {
  return await e.t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      name,
      email: `${authId}@vekino.test`,
      emailVerified: true,
      active: true,
      authId,
      createdAt: T17,
      updatedAt: T17,
    });
    await ctx.db.insert("companiaMiembros", {
      userId,
      companiaId: e.andina,
      roles: ["guardia"],
      isActive: true,
      createdAt: T17,
      updatedAt: T17,
    });
    if (extra.membresia) {
      await ctx.db.insert("memberships", {
        userId,
        condominioId: extra.membresia.condominioId,
        roles: extra.membresia.roles as never,
        isActive: true,
        createdAt: T17,
        updatedAt: T17,
      });
    }
    return userId;
  });
}

const horario = (userId: Id<"users">) =>
  e.como("alicia").mutation(api.horariosGuarda.crear, {
    companiaId: e.andina,
    userId,
    fechaInicio: "2026-10-01",
    bloques: DE_DIA,
  });

// ─────────────────────────────────────────────────────────────
describe("QA-008 · turno abierto en el conjunto cubierto", () => {
  let cobertura: Id<"coberturas">;
  let turnoB: Id<"guardiaTurnos">;
  const FIN = T17 + 5 * HORA;

  beforeEach(async () => {
    e = await montar();
    cobertura = await e.cubrir(e.bosque, e.kBosque, T17, FIN);
    en(T17 + HORA);
    turnoB = await e.como("jason").mutation(api.guardia.iniciarTurno, { condominioId: e.bosque, checklist: CHECKLIST });
  });

  const turno = () => e.t.run(async (ctx) => (await ctx.db.get(turnoB))!);
  const pendiente = () => e.como("jason").query(api.guardia.turnoPendienteDeCierre, {});
  const cerrarComoJason = () => e.como("jason").mutation(api.guardia.cerrarTurno, { turnoId: turnoB, ...CIERRE });
  const inhabilitar = () =>
    e.como("alicia").mutation(api.coberturas.inhabilitar, { coberturaId: cobertura, motivo: "QA-008" });

  test("A · cobertura activa: se cierra como siempre", async () => {
    await cerrarComoJason();
    expect((await turno()).estado).toBe("cerrado");
  });

  test("B · cobertura inhabilitada: el guarda ve el turno pendiente y lo cierra", async () => {
    await inhabilitar();
    en(T17 + 2 * HORA);
    const p = await pendiente();
    expect(p?.turno._id).toBe(turnoB);
    expect(p?.condominioNombre).toBe("Conjunto Bosque");
    expect(await e.como("jason").query(api.guardia.relevosDelTurno, { turnoId: turnoB })).toEqual(
      expect.arrayContaining([expect.objectContaining({ userId: e.bruno })]),
    );
    await cerrarComoJason();
    const t = await turno();
    expect([t.estado, t.condominioId, t.coberturaId, t.cerradoPorUserId]).toEqual(["cerrado", e.bosque, cobertura, e.jason]);
    expect(await pendiente()).toBeNull();
  });

  test("C · cobertura vencida: lo mismo al pasar el fin", async () => {
    en(FIN + MIN);
    expect((await pendiente())?.turno._id).toBe(turnoB);
    await cerrarComoJason();
    expect((await turno()).estado).toBe("cerrado");
  });

  test("cerrarlo no devuelve el conjunto ni crea una autorizacion", async () => {
    en(FIN + MIN);
    await cerrarComoJason();
    const home = await e.como("jason").query(api.guardia.home, { condominioId: e.bosque });
    expect(home.allowed).toBe(false);
    await expect(
      e.como("jason").mutation(api.guardia.registrarEventoMinuta, { condominioId: e.bosque, tipo: "Anotación", resumen: "x" }),
    ).rejects.toThrow();
    expect((await e.como("jason").query(api.users.me, {}))!.contextoOperativoGuardia.tipo).toBe("permanente");
  });

  test("D · tras dejar de operar no puede abrir otro turno en el conjunto cubierto", async () => {
    en(FIN + MIN);
    await cerrarComoJason();
    await expect(
      e.como("jason").mutation(api.guardia.iniciarTurno, { condominioId: e.bosque, checklist: CHECKLIST }),
    ).rejects.toThrow();
  });

  test("E · con el turno pendiente no abre otro en su conjunto como sustituto", async () => {
    en(FIN + MIN);
    await expect(
      e.como("jason").mutation(api.guardia.iniciarTurno, { condominioId: e.alamos, checklist: CHECKLIST }),
    ).rejects.toThrow(/turno pendiente de cierre en Conjunto Bosque/);
    await cerrarComoJason();
    await expect(
      e.como("jason").mutation(api.guardia.iniciarTurno, { condominioId: e.alamos, checklist: CHECKLIST }),
    ).resolves.toBeTruthy();
  });

  test("F · el administrador de la compania lo recupera; el supervisor y otra compania no", async () => {
    /* Mientras el guarda puede cerrarlo, no es huerfano. */
    await expect(
      e.como("alicia").mutation(api.guardia.cerrarTurnoHuerfano, { turnoId: turnoB, motivo: "Cierre de prueba" }),
    ).rejects.toThrow(/todavía puede cerrarlo/);
    en(FIN + MIN);
    expect((await e.como("alicia").query(api.guardia.turnosHuerfanosDeCompania, { companiaId: e.andina })).map((x) => x.turnoId)).toEqual([turnoB]);
    for (const quien of ["sergio", "sofia"]) {
      await expect(
        e.como(quien).mutation(api.guardia.cerrarTurnoHuerfano, { turnoId: turnoB, motivo: "Cierre de prueba" }),
      ).rejects.toThrow();
    }
    const olga = await e.t.run(async (ctx) => {
      const companiaId = await ctx.db.insert("companiasSeguridad", { nombre: "Otra", estado: "activa", createdAt: T17, updatedAt: T17 });
      const userId = await ctx.db.insert("users", { name: "Olga Otra", email: "olga@vekino.test", emailVerified: true, active: true, authId: "olga", createdAt: T17, updatedAt: T17 });
      await ctx.db.insert("companiaMiembros", { userId, companiaId, roles: ["admin_compania"], isActive: true, createdAt: T17, updatedAt: T17 });
      return userId;
    });
    expect(olga).toBeTruthy();
    await expect(
      e.como("olga").mutation(api.guardia.cerrarTurnoHuerfano, { turnoId: turnoB, motivo: "Cierre de prueba" }),
    ).rejects.toThrow();

    await e.como("alicia").mutation(api.guardia.cerrarTurnoHuerfano, { turnoId: turnoB, motivo: "El guarda termino su cobertura sin cerrar" });
    const t = await turno();
    expect([t.estado, t.condominioId, t.coberturaId, t.cerradoPorUserId]).toEqual(["cerrado", e.bosque, cobertura, e.alicia]);
    expect(await e.como("alicia").query(api.guardia.turnosHuerfanosDeCompania, { companiaId: e.andina })).toEqual([]);
    /* Y la porteria vuelve a poder abrir turno. */
    await expect(
      e.como("bruno").mutation(api.guardia.iniciarTurno, { condominioId: e.bosque, checklist: CHECKLIST }),
    ).resolves.toBeTruthy();
  });

  test("G · el historico conserva la cobertura con la que se abrio", async () => {
    await inhabilitar();
    en(T17 + 2 * HORA);
    await cerrarComoJason();
    const lista = await e.como("sergio").query(api.guardia.listTurnos, { condominioId: e.bosque });
    expect(lista.find((x) => x._id === turnoB)).toMatchObject({ estado: "cerrado", cobertura: expect.objectContaining({ coberturaId: cobertura }) });
  });
});

// ─────────────────────────────────────────────────────────────
describe("QA-001 · una cobertura con la cadena rota no bloquea la planificacion", () => {
  const SOLAPE =
    "El guarda tiene una cobertura aceptada que se solapa con este periodo. Inhabilita primero la cobertura o registra la inasistencia para otro periodo.";

  beforeEach(async () => {
    e = await montar();
    await horario(e.jason);
  });

  /** Una cobertura aceptada de Jason con Centinela, en Cedros, la noche del domingo. */
  async function coberturaDeCentinela(jasonDeAlta: boolean) {
    return await e.t.run(async (ctx) => {
      const centinela = await ctx.db.insert("companiasSeguridad", { nombre: "Centinela", estado: "activa", createdAt: T17, updatedAt: T17 });
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
        isActive: jasonDeAlta,
        createdAt: T17,
        updatedAt: T17,
      });
      return await ctx.db.insert("coberturas", {
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
  }

  const inasistencia = (ventana = NOCHE) =>
    e.como("alicia").mutation(api.inasistencias.crear, { companiaId: e.andina, userId: e.jason, tipo: "incapacidad", ventana });
  const disponibilidad = async () => {
    const sola = await e.como("alicia").query(api.disponibilidad.deGuarda, { companiaId: e.andina, userId: e.jason, ventana: NOCHE });
    const masiva = (await e.como("alicia").query(api.disponibilidad.deGuardasEnAlcance, { companiaId: e.andina, ventana: NOCHE })).guardas.find((g) => g.userId === e.jason)!;
    expect(masiva.estado).toBe(sola.estado);
    return sola.estado;
  };

  test("A y F · cobertura valida de otra compania: se rechaza, sin pedir que la inhabilite quien no puede", async () => {
    await coberturaDeCentinela(true);
    const r = inasistencia();
    await expect(r).rejects.toThrow(/otra compañía/);
    await expect(inasistencia()).rejects.not.toThrow(/Inhabilita primero/);
    expect(await disponibilidad()).toBe("ocupado");
  });

  test("B · cobertura rota porque el guarda fue dado de baja alli: no bloquea", async () => {
    await coberturaDeCentinela(false);
    expect(await disponibilidad()).toBe("disponible");
    await expect(inasistencia()).resolves.toBeTruthy();
  });

  test("B · cobertura rota porque terminaron el contrato: tampoco", async () => {
    const id = await e.cubrir(e.bosque, e.kBosque, instante("2026-10-11T18:00"), instante("2026-10-12T06:00"));
    expect(id).toBeTruthy();
    await e.t.run(async (ctx) => ctx.db.patch(e.kBosque, { terminadoEn: T17 + MIN }));
    en(T17 + 2 * MIN);
    await expect(inasistencia()).resolves.toBeTruthy();
  });

  test("C · cobertura inhabilitada: no bloquea", async () => {
    const id = await e.cubrir(e.bosque, e.kBosque, instante("2026-10-11T18:00"), instante("2026-10-12T06:00"));
    await e.como("alicia").mutation(api.coberturas.inhabilitar, { coberturaId: id, motivo: "QA-001" });
    await expect(inasistencia()).resolves.toBeTruthy();
  });

  test("D y F · cobertura aceptada vigente de la propia compania: se rechaza con su instruccion", async () => {
    await e.cubrir(e.bosque, e.kBosque, instante("2026-10-11T18:00"), instante("2026-10-12T06:00"));
    await expect(inasistencia()).rejects.toThrow(SOLAPE);
  });

  test("E · sin solapamiento: se permite", async () => {
    await coberturaDeCentinela(true);
    await e.cubrir(e.bosque, e.kBosque, instante("2026-10-13T18:00"), instante("2026-10-14T06:00"));
    await expect(inasistencia(horas("2026-10-12T06:00", "2026-10-12T12:00"))).resolves.toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────
describe("QA-004 · el supervisor usa lo que el backend ya le autoriza", () => {
  beforeEach(async () => {
    e = await montar();
    await horario(e.jason);
  });

  test("A a D · el supervisor de A consulta horarios, inasistencias, disponibilidad y coberturas", async () => {
    const sofia = e.como("sofia");
    await expect(sofia.query(api.horariosGuarda.deCompaniaEnRango, { companiaId: e.andina, desde: "2026-10-10", hasta: "2026-10-20" })).resolves.toBeTruthy();
    await expect(sofia.query(api.inasistencias.deCompaniaEnRango, { companiaId: e.andina, desde: "2026-10-10", hasta: "2026-10-20" })).resolves.toBeTruthy();
    await expect(sofia.query(api.disponibilidad.deGuardasEnAlcance, { companiaId: e.andina, ventana: NOCHE })).resolves.toBeTruthy();
    await expect(sofia.query(api.coberturas.deCompania, { companiaId: e.andina, desde: "2026-10-01", hasta: "2026-10-31" })).resolves.toBeTruthy();
  });

  test("E · fuera de su alcance el backend sigue rechazando", async () => {
    await expect(
      e.como("sofia").query(api.disponibilidad.deGuarda, { companiaId: e.andina, userId: e.bruno, ventana: NOCHE }),
    ).rejects.toThrow();
  });

  test("A a F · la web deja abrir la pagina de su compania al supervisor y al administrador, a nadie mas", () => {
    const yo = (roles: string[], companiaId = "k_andina") => ({ platformRole: null, compania: { companiaId, roles } });
    const ruta = "/dashboard/companias/k_andina";
    expect(esPaginaDeSuCompania(yo(["supervisor"]), ruta)).toBe(true);
    expect(esPaginaDeSuCompania(yo(["supervisor"]), `${ruta}?tab=horarios`.split("?")[0]!)).toBe(true);
    expect(esPaginaDeSuCompania(yo(["admin_compania"]), ruta)).toBe(true);
    expect(esPaginaDeSuCompania(yo(["supervisor"], "k_otra"), ruta)).toBe(false);
    expect(esPaginaDeSuCompania(yo(["guardia"]), ruta)).toBe(false);
    expect(esPaginaDeSuCompania(yo(["supervisor"]), "/dashboard/companias/k_andina/otra")).toBe(false);
    /* Que el shell de verdad deje al supervisor en esa pagina —con una o con
     * varias asignaciones— lo prueba el recorrido de navegacion en
     * `apps/web/pruebas/navegacionCompania.test.mjs`. */
  });
});

// ─────────────────────────────────────────────────────────────
describe("QA-002 · una denegacion valida no tumba la pagina de la compania", () => {
  test("solo se pide el detalle a quien puede verlo", () => {
    const yo = (roles: string[], companiaId = "k_andina", platformRole: string | null = null) => ({ platformRole, compania: { companiaId, roles } });
    expect(puedeVerDetalleCompania(yo(["guardia"]), "k_andina")).toBe(false);
    expect(puedeVerDetalleCompania(yo(["supervisor"]), "k_andina")).toBe(true);
    expect(puedeVerDetalleCompania(yo(["admin_compania"]), "k_andina")).toBe(true);
    expect(puedeVerDetalleCompania(yo(["admin_compania"], "k_otra"), "k_andina")).toBe(false);
    expect(puedeVerDetalleCompania({ platformRole: "superadmin", compania: null }, "k_andina")).toBe(true);
    expect(puedeVerDetalleCompania({ platformRole: null, compania: null }, "k_andina")).toBe(false);
    expect(fuentePaginaCompania).toMatch(/puedeVerDetalleCompania\(/);
    expect(fuentePaginaCompania).toMatch(/"skip"/);
  });

  test("el backend sigue negando el detalle a un guarda", async () => {
    e = await montar();
    await expect(e.como("jason").query(api.companias.detail, { companiaId: e.andina })).rejects.toThrow(/permiso/);
  });
});

// ─────────────────────────────────────────────────────────────
describe("QA-005 · rutas de porteria invalidas", () => {
  beforeEach(async () => {
    e = await montar();
  });

  test("A · id sintacticamente invalido: no abre, sin error de validacion", async () => {
    expect(await e.como("jason").query(api.guardia.home, { condominioId: "esto-no-es-un-id" })).toEqual({ allowed: false });
  });

  test("B · id valido de un conjunto que ya no existe: no abre", async () => {
    const borrado = await e.t.run(async (ctx) => {
      const id = await ctx.db.insert("condominios", { name: "Efimero", activeModules: [], isActive: true, createdAt: T17, updatedAt: T17 });
      await ctx.db.delete(id);
      return id;
    });
    expect(await e.como("jason").query(api.guardia.home, { condominioId: borrado })).toEqual({ allowed: false });
    /* Ni un id de otra tabla. */
    expect(await e.como("jason").query(api.guardia.home, { condominioId: e.jason })).toEqual({ allowed: false });
  });

  test("C y D · solo abre el conjunto donde opera", async () => {
    expect((await e.como("jason").query(api.guardia.home, { condominioId: e.bosque })).allowed).toBe(false);
    expect((await e.como("jason").query(api.guardia.home, { condominioId: e.alamos })).allowed).toBe(true);
  });

  test("C y D · con una cobertura aceptada y empezada abre B y A no; al terminar, al reves", async () => {
    await e.cubrir(e.bosque, e.kBosque, T17 + HORA, T17 + 5 * HORA);
    en(T17 + 2 * HORA);
    expect((await e.como("jason").query(api.guardia.home, { condominioId: e.bosque })).allowed).toBe(true);
    expect((await e.como("jason").query(api.guardia.home, { condominioId: e.alamos })).allowed).toBe(false);
    en(T17 + 6 * HORA);
    expect((await e.como("jason").query(api.guardia.home, { condominioId: e.bosque })).allowed).toBe(false);
    expect((await e.como("jason").query(api.guardia.home, { condominioId: e.alamos })).allowed).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
describe("QA-006 · las solicitudes de cobertura no dependen de tener porteria", () => {
  let diego: Id<"users">;
  let rosa: Id<"users">;
  const V = horas("2026-10-11T19:00", "2026-10-11T23:00");
  const pedir = (userId: Id<"users">, ventana = V) =>
    e.como("alicia").mutation(api.coberturas.crear, { contratoId: e.kBosque, userId, ventana });
  const pendientes = async (authId: string) =>
    (await e.como(authId).query(api.coberturas.pendientesDeGuarda, {})).map((c) => c._id);

  beforeEach(async () => {
    e = await montar();
    diego = await guardaDeCompania("diego", "Diego Sin Asignacion");
    rosa = await guardaDeCompania("rosa", "Rosa Residente", { membresia: { condominioId: e.cedros, roles: ["propietario"] } });
    for (const u of [diego, rosa, e.jason]) await horario(u);
  });

  test("A y B · guarda sin asignacion: ve su solicitud y la acepta", async () => {
    const id = await pedir(diego);
    expect(await pendientes("diego")).toEqual([id]);
    await e.como("diego").mutation(api.coberturas.aceptar, { coberturaId: id });
    expect(await pendientes("diego")).toEqual([]);
  });

  test("C · y puede rechazarla", async () => {
    const id = await pedir(diego);
    await e.como("diego").mutation(api.coberturas.rechazar, { coberturaId: id });
    expect(await e.t.run(async (ctx) => (await ctx.db.get(id))!.estado)).toBe("rechazada");
  });

  test("D · guarda y residente: conserva su portal y ve sus solicitudes", async () => {
    const id = await pedir(rosa);
    expect(await pendientes("rosa")).toEqual([id]);
    const me = await e.como("rosa").query(api.users.me, {});
    expect(me!.memberships.map((m) => m.roles)).toEqual([["propietario"]]);
  });

  test("E · con una cobertura activa ve las demas con la misma regla", async () => {
    await e.cubrir(e.bosque, e.kBosque, T17 - HORA, T17 + HORA);
    const id = await pedir(e.jason, horas("2026-10-12T19:00", "2026-10-12T23:00"));
    expect(await pendientes("jason")).toEqual([id]);
  });

  test("F · otro guarda no ve ni responde solicitudes ajenas", async () => {
    const id = await pedir(diego);
    expect(await pendientes("bruno")).toEqual([]);
    await expect(e.como("bruno").mutation(api.coberturas.aceptar, { coberturaId: id })).rejects.toThrow(/destinatario/);
  });

  test("la web las muestra fuera de la porteria: inicio, portal de residente y pagina de compania", () => {
    for (const fuente of [fuenteInicioUsuario, fuentePortal, fuentePaginaCompania]) {
      expect(fuente).toMatch(/<SolicitudesCobertura\b/);
    }
  });
});

// ─────────────────────────────────────────────────────────────
describe("QA-007 · los errores tecnicos no llegan a la interfaz", () => {
  const MENSAJE =
    "El guarda tiene una cobertura aceptada que se solapa con este periodo. Inhabilita primero la cobertura o registra la inasistencia para otro periodo.";

  test("el error del cliente de React se reduce al mensaje funcional", () => {
    const crudo = `[CONVEX M(inasistencias:crear)] [Request ID: 3f88ba86f6a86b57] Server Error\nUncaught Error: ${MENSAJE}\n    at handler (../convex/inasistencias.ts:144:8)\n\n  Called by client`;
    expect(mensajeErrorUsuario(new Error(crudo))).toBe(MENSAJE);
  });

  test("tambien el del cliente HTTP y el que llega en una sola linea", () => {
    expect(mensajeErrorUsuario(new Error(`[Request ID: 5a3c4c979e82ce3f] Server Error\nUncaught Error: ${MENSAJE}\n    at async handler (../convex/x.ts:80:6)\n`))).toBe(MENSAJE);
    expect(mensajeErrorUsuario(new Error(`[CONVEX M(a:b)] [Request ID: 1] Server Error Uncaught Error: ${MENSAJE} at handler (../convex/a.ts:1:1) Called by client`))).toBe(MENSAJE);
  });

  test("sin mensaje funcional queda el texto de respaldo, nunca el interno", () => {
    const r = mensajeErrorUsuario(new Error("[CONVEX Q(a:b)] [Request ID: 9] Server Error"), "No se pudo registrar.");
    expect(r).toBe("No se pudo registrar.");
    for (const prohibido of ["Request ID", "Server Error", "CONVEX", "at handler", ".ts:"]) {
      expect(mensajeErrorUsuario(new Error(`[CONVEX M(a:b)] [Request ID: 1] Server Error\n    at handler (../convex/a.ts:1:1)`))).not.toContain(prohibido);
    }
  });

  test("el dialogo de inasistencias usa el normalizador compartido", () => {
    expect(fuenteDialogoInasistencias).toMatch(/mensajeErrorUsuario\(/);
    expect(fuenteDialogoInasistencias).not.toMatch(/err instanceof Error \? err\.message/);
  });
});

// ─────────────────────────────────────────────────────────────
describe("QA-NEW-001 · los rechazos de la Fase 15 tampoco llegan en crudo", () => {
  const PROHIBIDOS = ["Request ID", "Server Error", "CONVEX", "Uncaught", "at handler", ".ts:", "Called by client"];
  const limpio = (crudo: string) => {
    const r = mensajeErrorUsuario(new Error(crudo));
    for (const p of PROHIBIDOS) expect(r).not.toContain(p);
    return r;
  };

  test("iniciar turno con un turno huerfano: solo la frase funcional", () => {
    const MENSAJE = "Tienes un turno pendiente de cierre en Conjunto Bosque. Ciérralo antes de iniciar otro.";
    const crudo = `[CONVEX M(guardia:iniciarTurno)] [Request ID: 7c1d0e2fa4b5] Server Error\nUncaught Error: ${MENSAJE}\n    at handler (../convex/guardia.ts:244:8)\n\n  Called by client`;
    expect(limpio(crudo)).toBe(MENSAJE);
  });

  /* La puerta de la credencial es una query que la action llama con
   * `runQuery`: Convex vuelve a envolver el error ya formateado, con su
   * "Uncaught Error:" y su traza, y llega con el prefijo dos veces. */
  test("cambiar clave o correo rechazado desde la puerta de la credencial", () => {
    for (const [fn, MENSAJE] of [
      ["setPasswordMiembro", "Esa persona también pertenece a un conjunto. Su contraseña y su correo no se gestionan desde la compañía."],
      ["setEmailMiembro", "Esa persona ya tenía su cuenta en Vekino. Su contraseña y su correo solo los cambia ella."],
    ] as const) {
      const crudo = `[CONVEX A(companias:${fn})] [Request ID: 9f0e1d2c3b4a] Server Error\nUncaught Error: Uncaught Error: ${MENSAJE}\n    at handler (../convex/companias.ts:1193:12)\n\n    at async handler (../convex/companias.ts:1364:22)\n\n  Called by client`;
      expect(limpio(crudo)).toBe(MENSAJE);
    }
  });

  test("y el rechazo que lanza la propia action, con un solo prefijo", () => {
    const MENSAJE = "Ese correo ya está en uso por otra cuenta.";
    const crudo = `[CONVEX A(companias:setEmailMiembro)] [Request ID: 1a2b] Server Error\nUncaught Error: ${MENSAJE}\n    at handler (../convex/companias.ts:1438:20)\n\n  Called by client`;
    expect(limpio(crudo)).toBe(MENSAJE);
  });

  test("editar persona e iniciar turno usan el normalizador compartido", () => {
    expect(fuenteEditarPersona).toMatch(/mensajeErrorUsuario\(err, "No se pudo guardar\."\)/);
    expect(fuenteEditarPersona).toMatch(/mensajeErrorUsuario\(err, "No se pudo establecer\."\)/);
    expect(fuentePorteria).toMatch(/mensajeErrorUsuario\(e, "No se pudo iniciar el turno\."\)/);
    expect(fuentePorteria).not.toMatch(/e instanceof Error \? e\.message : "No se pudo iniciar el turno\."/);
  });
});
