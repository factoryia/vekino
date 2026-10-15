import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";

/**
 * LA FIRMA DE VERDAD — Fase 3 (H-06).
 *
 * Sin simular el firmador: el SDK de AWS firma con credenciales falsas (es un
 * cálculo local; no sale nada a la red). Antes la URL firmada solo cubría
 * `host`, así que S3 aceptaba cualquier tipo y cualquier tamaño en el PUT.
 * Ahora cubre `content-type` y `content-length`: un PUT con otro tipo u otro
 * tamaño no coincide con la firma y S3 lo rechaza.
 *
 * Fase 4: el PUT firmado va a una llave temporal (`pendientes/…`), no a la
 * definitiva. El objeto solo se publica en su llave cuando el servidor lo
 * revisa (`files.confirmarSubida`).
 */

const modules = import.meta.glob("../convex/**/*.ts");

beforeEach(() => {
  vi.stubEnv("AWS_S3_BUCKET_NAME", "vekino");
  vi.stubEnv("AWS_REGION", "us-east-1");
  vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIAPRUEBASFALSAS000");
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "secreto-falso-de-prueba");
  vi.stubEnv("CONVEX_SITE_URL", "https://vekino-pruebas.convex.site");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: unknown) => {
      throw new Error(`Red bloqueada: ${String(u)}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

test("con el tamaño, la URL de S3 firma el tipo y el tamaño, y vence a los 10 minutos", async () => {
  const t = convexTest(schema, modules);
  const condominioId = await t.run(async (ctx) => {
    const ahora = Date.now();
    const condominioId = await ctx.db.insert("condominios", {
      name: "A",
      activeModules: [],
      isActive: true,
      createdAt: ahora,
      updatedAt: ahora,
    });
    const userId = await ctx.db.insert("users", {
      name: "Admin",
      email: "admin@vekino.test",
      emailVerified: true,
      active: true,
      authId: "admin",
      createdAt: ahora,
      updatedAt: ahora,
    });
    await ctx.db.insert("memberships", {
      userId,
      condominioId,
      roles: ["administrador"],
      isActive: true,
      createdAt: ahora,
      updatedAt: ahora,
    });
    return condominioId;
  });

  const r = await t.withIdentity({ subject: "admin" }).action(api.files.generateUploadUrl, {
    folder: `condominios/documentos/${condominioId}`,
    contentType: "application/pdf",
    fileName: "acta.pdf",
    size: 123_456,
  });
  const url = new URL(r.uploadUrl);
  expect(url.host).toBe("vekino.s3.us-east-1.amazonaws.com");
  const temporal = decodeURIComponent(url.pathname.slice(1));
  expect(temporal).toMatch(/^pendientes\/[0-9a-f]{32}$/);
  expect(r.key.startsWith(`condominios/documentos/${condominioId}/`)).toBe(true);
  const [fila] = await t.run((ctx) => ctx.db.query("subidasPendientes").collect());
  expect(fila).toMatchObject({ key: r.key, claveTemporal: temporal, size: 123_456, modo: "directo", estado: "pendiente" });
  expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host");
  expect(url.searchParams.get("X-Amz-Expires")).toBe("600");
});
