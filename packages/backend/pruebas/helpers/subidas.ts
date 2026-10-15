import type { Id } from "../../convex/_generated/dataModel";

/**
 * SUBIDAS VALIDADAS PARA LAS PRUEBAS (H-12, Fase 4 de S3).
 *
 * Desde la Fase 4, una entidad solo registra un archivo NUEVO si viene de una
 * subida validada de quien registra, a la carpeta de esa entidad
 * (`convex/model/registroArchivos.ts`). Las pruebas que no tratan de la
 * subida en sí siembran aquí la fila que dejan `files.ts` / `subidas.ts`
 * después de leer el objeto, en vez de inventar una URL que nunca se subió.
 */

type ConRun = { run: <T>(fn: (ctx: any) => Promise<T>) => Promise<T> };

export const URL_BUCKET = "https://vekino.s3.us-east-1.amazonaws.com";

let n = 0;

/**
 * La subida validada de `userId` a `carpeta`; devuelve su llave y la URL
 * pública que el servidor le habría devuelto (la del bucket `vekino` de las
 * pruebas). Solo esa URL, exacta, se puede registrar.
 */
export async function subidaValidada(
  t: ConRun,
  opciones: { userId: Id<"users">; carpeta: string; nombre?: string; tipo?: string },
): Promise<{ key: string; url: string }> {
  const nombre = opciones.nombre ?? "archivo.pdf";
  const tipo = opciones.tipo ?? "application/pdf";
  // La forma de `files.buildObjectKey`: {carpeta}/{13 dígitos}-{8 hex}-{nombre};
  // distinta de las llaves inventadas de las pruebas, que nunca se subieron.
  const i = n++;
  const key = `${opciones.carpeta}/${1770000000000 + i}-${(0xa0000000 + i).toString(16)}-${nombre}`;
  const url = `${URL_BUCKET}/${key}`;
  await t.run((ctx) =>
    ctx.db.insert("subidasPendientes", {
      key,
      url,
      carpeta: opciones.carpeta,
      categoria: "adjunto",
      tipoDeclarado: tipo,
      userId: opciones.userId,
      modo: "servidor",
      estado: "validada",
      tipo,
      bytes: 1024,
      expiraEn: Date.now() + 24 * 60 * 60 * 1000,
    }),
  );
  return { key, url };
}
