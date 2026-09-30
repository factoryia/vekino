import { convexTest } from "convex-test";
import betterAuthTest from "@convex-dev/better-auth/test";
import schema from "../../convex/schema";
import type { Id } from "../../convex/_generated/dataModel";

const modules = import.meta.glob("../../convex/**/*.ts");
const DIA = 24 * 60 * 60 * 1000;

export async function montar() {
  const t = convexTest(schema, modules);
  betterAuthTest.register(t);
  const ahora = Date.now();
  const ids = await t.run(async (ctx) => {
    const usuario = (authId: string, name: string) => ctx.db.insert("users", {
      authId, name, email: `${authId}@test.local`, emailVerified: true,
      active: true, createdAt: ahora, updatedAt: ahora,
    });
    const adminA = await usuario("adminA", "Ana Andina");
    const adminB = await usuario("adminB", "Berta Rival");
    const supervisorA = await usuario("supervisorA", "Sofia Andina");
    const supervisorB = await usuario("supervisorB", "Sara Rival");
    const guardaA = await usuario("guardaA", "Gabriel Andina");
    const guardaB = await usuario("guardaB", "Gustavo Rival");
    await usuario("sinEmpresa", "Residente Solo");
    const companiaA = await ctx.db.insert("companiasSeguridad", {
      nombre: "Andina", estado: "activa", createdAt: ahora, updatedAt: ahora,
    });
    const companiaB = await ctx.db.insert("companiasSeguridad", {
      nombre: "Rival", estado: "activa", createdAt: ahora, updatedAt: ahora,
    });
    const conjunto = await ctx.db.insert("condominios", {
      name: "Conjunto compartido", activeModules: [], isActive: true,
      createdAt: ahora, updatedAt: ahora,
    });
    const ajeno = await ctx.db.insert("condominios", {
      name: "Sin contrato", activeModules: [], isActive: true,
      createdAt: ahora, updatedAt: ahora,
    });
    const miembro = (userId: Id<"users">, companiaId: Id<"companiasSeguridad">, rol: "admin_compania" | "supervisor" | "guardia") =>
      ctx.db.insert("companiaMiembros", {
        userId, companiaId, roles: [rol], isActive: true, createdAt: ahora, updatedAt: ahora,
      });
    await miembro(adminA, companiaA, "admin_compania");
    await miembro(adminB, companiaB, "admin_compania");
    const msA = await miembro(supervisorA, companiaA, "supervisor");
    const msB = await miembro(supervisorB, companiaB, "supervisor");
    const mgA = await miembro(guardaA, companiaA, "guardia");
    const mgB = await miembro(guardaB, companiaB, "guardia");
    const contrato = (companiaId: Id<"companiasSeguridad">) => ctx.db.insert("companiaContratos", {
      companiaId, condominioId: conjunto, vigenciaDesde: ahora - DIA,
      creadoPorUserId: adminA, createdAt: ahora, updatedAt: ahora,
    });
    const kA = await contrato(companiaA);
    const kB = await contrato(companiaB);
    const asignar = (contratoId: Id<"companiaContratos">, companiaMiembroId: Id<"companiaMiembros">, userId: Id<"users">, companiaId: Id<"companiasSeguridad">, rol: "supervisor" | "guardia") =>
      ctx.db.insert("asignaciones", {
        contratoId, companiaMiembroId, userId, companiaId, condominioId: conjunto,
        rol, vigenciaDesde: ahora - DIA, creadoPorUserId: adminA, createdAt: ahora,
      });
    await asignar(kA, msA, supervisorA, companiaA, "supervisor");
    await asignar(kA, mgA, guardaA, companiaA, "guardia");
    await asignar(kB, msB, supervisorB, companiaB, "supervisor");
    await asignar(kB, mgB, guardaB, companiaB, "guardia");
    return { companiaA, companiaB, conjunto, ajeno, adminA, adminB, supervisorA, guardaA, kA, mgA };
  });
  const como = (subject: string) => t.withIdentity({ subject });
  const datos = (condominioId = ids.conjunto) => ({
    condominioId, tipo: "ACCESO", ubicacion: "Portería norte",
    ocurrioEn: Date.now() - 60_000, descripcion: "Ingreso no autorizado",
    prioridad: "MEDIA" as const,
  });
  const paginar = { cursor: null, numItems: 20 };
  return { t, ...ids, como, datos, paginar };
}

