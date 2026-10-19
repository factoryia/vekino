import { describe, expect, test } from "bun:test";

/**
 * `leerRespuesta` (lib/leer-respuesta.ts): las rutas de facturas responden
 * JSON, pero la plataforma (Vercel) corta un archivo demasiado grande con un
 * 413 que NO es JSON, antes de llegar a la ruta. La pantalla mostraba
 * "Unexpected token…"; ahora muestra qué pasó y qué hacer.
 */

const { leerRespuesta, MENSAJE_ARCHIVO_DEMASIADO_GRANDE } = await import("../lib/leer-respuesta");

describe("leerRespuesta", () => {
  test("JSON de la ruta, con o sin error: se devuelve tal cual", async () => {
    expect(await leerRespuesta(new Response(JSON.stringify({ tipo: "nueva" }), { status: 200 }))).toEqual({ tipo: "nueva" });
    const r = await leerRespuesta(new Response(JSON.stringify({ error: "El PDF de la casa 101 es demasiado grande" }), { status: 413 }));
    expect(r.error).toMatch(/casa 101/);
  });

  test("el 413 de la plataforma (texto, no JSON): mensaje claro con qué hacer", async () => {
    const plataforma = new Response("Request Entity Too Large\n\nFUNCTION_PAYLOAD_TOO_LARGE\n", { status: 413 });
    await expect(leerRespuesta(plataforma)).rejects.toThrow(MENSAJE_ARCHIVO_DEMASIADO_GRANDE);
    expect(MENSAJE_ARCHIVO_DEMASIADO_GRANDE).toMatch(/Divídelo en partes/);
  });

  test("cualquier otra respuesta que no es JSON: error genérico con el código, sin el cuerpo", async () => {
    const r = new Response("<html><body>Bad Gateway: upstream 10.0.0.12</body></html>", { status: 502 });
    const mensaje = await leerRespuesta(r).catch((e) => e.message);
    expect(mensaje).toBe("El servidor respondió algo inesperado (502). Intenta de nuevo.");
  });
});
