import type { Id } from "../_generated/dataModel";

type StorageCtx = {
  storage: {
    getUrl: (id: Id<"_storage">) => Promise<string | null>;
  };
};

/* ── Convex Storage heredado: qué se acepta y qué se borra ───────────────────
 *
 * Las subidas a Convex Storage están cerradas: los `generateUploadUrl`
 * heredados lanzan error y solo el servidor guarda temporales
 * (`soportesPago.enviarMio`). Así que un `storageId` que llega hoy del cliente
 * es de un archivo que ya existía, y el id no dice de quién es: `_storage` no
 * guarda dueño, y las referencias viejas las escribió el cliente.
 *
 *   - Leer: los archivos heredados se siguen mostrando (`resolveMediaUrl`).
 *   - Asignar: solo el id que ese registro ya tenía (`exigirStorageIdDelRegistro`).
 *   - Borrar: una referencia que vino del cliente se desvincula, pero el
 *     archivo NO se borra: no hay cómo probar que es de quien la quita, y un
 *     huérfano es mejor que borrar el archivo de otro. Solo se borran ids que
 *     puso el servidor (el temporal de `enviarMio`, el acta de una asamblea).
 */

/** Mensaje estable cuando el cliente manda un archivo de Convex Storage ajeno al registro. */
export const MENSAJE_STORAGE_AJENO =
  "Ese archivo ya no se puede adjuntar. Súbelo de nuevo.";

/**
 * El `storageId` que manda el cliente, si es el que el registro ya tenía (la
 * edición lo reenvía tal cual). Cualquier otro se rechaza: ver arriba.
 */
export function exigirStorageIdDelRegistro(
  storageId: Id<"_storage"> | undefined,
  delRegistro: Array<Id<"_storage"> | null | undefined> = [],
): Id<"_storage"> | undefined {
  if (!storageId) return undefined;
  if (!delRegistro.includes(storageId)) throw new Error(MENSAJE_STORAGE_AJENO);
  return storageId;
}

/** Resuelve URL pública: prioriza S3 `url`, luego Convex storage legacy. */
export async function resolveMediaUrl(
  ctx: StorageCtx,
  ref: {
    url?: string | null;
    storageId?: Id<"_storage"> | string | null;
  } | null | undefined,
): Promise<string> {
  if (!ref) return "";
  if (ref.url?.startsWith("http")) return ref.url;
  const sid = ref.storageId;
  if (!sid) return "";
  if (typeof sid === "string" && sid.startsWith("http")) return sid;
  try {
    return (await ctx.storage.getUrl(sid as Id<"_storage">)) ?? "";
  } catch {
    return "";
  }
}

export async function resolveMediaUrlList(
  ctx: StorageCtx,
  values: Array<string | Id<"_storage">>,
): Promise<(string | null)[]> {
  return Promise.all(
    values.map(async (v) => {
      if (typeof v === "string" && v.startsWith("http")) return v;
      try {
        return await ctx.storage.getUrl(v as Id<"_storage">);
      } catch {
        return null;
      }
    }),
  );
}
