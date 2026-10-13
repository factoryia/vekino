import { NextResponse } from "next/server";
import { api } from "@vekino/backend/api";
import type { Id } from "@vekino/backend/dataModel";
import { fetchAuthQuery, isAuthenticated } from "@/lib/auth-server";

/**
 * Sesión, permiso y destino para leer y cargar PDFs de facturas.
 *
 * Las rutas de facturas leen PDFs con datos de los residentes y, al confirmar,
 * publican en S3 y escriben en la base. Piden la sesión de Better Auth, que no
 * es una cookie del dominio de la app: la web la manda en la cabecera
 * `Better-Auth-Cookie` (`lib/fetch-con-sesion.ts`) y el auth de Convex la
 * valida, igual que en `/api/incidentes/reporte`. Y piden el rol de quien sube
 * facturas en ese conjunto. Ante la duda, no dejan pasar.
 *
 * El conjunto lo resuelve el backend (`facturas.destinoCarga`), por
 * `condominioId` o por `condominioLegacyId` (la web anterior manda este), y
 * devuelve con el permiso su id y su carpeta de S3. Antes todo dependía del
 * `legacyId`, que solo tienen los conjuntos migrados (Hallazgo 2).
 */

/** Sin sesión no se lee ni el formulario: 401. */
export async function rechazoSinSesion(): Promise<NextResponse | null> {
  if (await isAuthenticated()) return null;
  return NextResponse.json({ error: "Inicia sesión para subir facturas." }, { status: 401 });
}

/** Cómo dice el formulario de qué conjunto es la carga. */
export type IdsConjunto = { condominioId?: string; condominioLegacyId?: string };

/** `condominioId` y `condominioLegacyId` del formulario; `null` si no llega ninguno. Vacío no cuenta. */
export function idsDelConjunto(form: FormData): IdsConjunto | null {
  const campo = (nombre: string) => {
    const valor = form.get(nombre);
    return typeof valor === "string" && valor !== "" ? valor : undefined;
  };
  const condominioId = campo("condominioId");
  const condominioLegacyId = campo("condominioLegacyId");
  if (condominioId === undefined && condominioLegacyId === undefined) return null;
  return {
    ...(condominioId !== undefined ? { condominioId } : {}),
    ...(condominioLegacyId !== undefined ? { condominioLegacyId } : {}),
  };
}

/** El conjunto de la carga y su carpeta de S3 (`legacyId` o `_id`), tal como los resolvió el backend. */
export type DestinoCarga = { condominioId: Id<"condominios">; carpeta: string };

/**
 * 401 si Convex no reconoce a la persona, 403 sin rol en el conjunto, 400 si
 * los dos identificadores son de conjuntos distintos, 409 si la carpeta de S3
 * no es solo de este conjunto, 500 si no se pudo validar. Si pasa, el destino.
 */
export async function validarDestino(
  ids: IdsConjunto,
): Promise<{ rechazo: NextResponse } | { rechazo: null; destino: DestinoCarga }> {
  const SIN_SESION = { error: "Tu sesión no es válida. Vuelve a iniciar sesión." };
  const SIN_PERMISO = { error: "No tienes permiso para subir facturas de este conjunto." };
  try {
    const r = await fetchAuthQuery(api.facturas.destinoCarga, ids);
    if (r?.allowed) {
      return { rechazo: null, destino: { condominioId: r.condominioId, carpeta: r.carpeta } };
    }
    switch (r?.motivo) {
      case "sin_sesion":
        return { rechazo: NextResponse.json(SIN_SESION, { status: 401 }) };
      case "sin_conjunto":
        return { rechazo: NextResponse.json({ error: "Falta el conjunto de la carga." }, { status: 400 }) };
      case "no_coinciden":
        return {
          rechazo: NextResponse.json(
            { error: "condominioId y condominioLegacyId son de conjuntos distintos." },
            { status: 400 },
          ),
        };
      case "carpeta_compartida":
        return {
          rechazo: NextResponse.json(
            { error: "La carpeta de facturas de este conjunto la usa otro conjunto. Avisa a soporte antes de cargar." },
            { status: 409 },
          ),
        };
      default:
        return { rechazo: NextResponse.json(SIN_PERMISO, { status: 403 }) };
    }
  } catch (e) {
    /* Un token que Convex no acepta llega como error, no como respuesta. */
    const texto = e instanceof Error ? e.message : "";
    if (/autenticado|perfil inexistente|token|unauthenticated/i.test(texto)) {
      return { rechazo: NextResponse.json(SIN_SESION, { status: 401 }) };
    }
    return {
      rechazo: NextResponse.json(
        { error: "No fue posible validar tu sesión. Intenta de nuevo." },
        { status: 500 },
      ),
    };
  }
}
