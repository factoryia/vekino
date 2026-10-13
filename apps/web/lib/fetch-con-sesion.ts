import { authClient } from "@/lib/auth-client";

/**
 * `fetch` a una ruta API de esta misma web (`/api/...`) llevando la sesión.
 *
 * La sesión no vive en una cookie del dominio de la app: `crossDomainClient`
 * la guarda en `localStorage` y la manda a …convex.site en la cabecera
 * `Better-Auth-Cookie` (ver `lib/auth-client.ts`). Un `fetch` normal a una
 * ruta de Next sale sin nada, y las rutas que piden sesión respondían 401 o
 * 403 aunque la persona hubiera iniciado sesión.
 *
 * Este helper agrega esa MISMA cabecera, con el valor que arma el cliente
 * oficial (`authClient.getCookie()`: "nombre=valor; …" sin las vencidas). En
 * el servidor, `convexBetterAuthNextJs` (`lib/auth-server.ts`) reenvía las
 * cabeceras de la petición al auth de Convex, que la valida como valida las
 * del navegador. La cabecera solo transporta la sesión: cada ruta sigue
 * exigiendo una sesión válida y el rol de la operación.
 *
 *   · Solo para rutas de esta web: a otro origen no se manda la sesión.
 *   · La única sesión que sale es la del cliente oficial. Sin sesión, o si no
 *     se puede leer, la petición sale sin la cabecera y la ruta responde 401:
 *     no se inventa una sesión.
 *   · Conserva método, cuerpo, señal y las cabeceras de quien llama.
 *   · No registra el valor en ningún lado.
 */
export async function fetchConSesion(ruta: string | URL, init: RequestInit = {}): Promise<Response> {
  const destino = new URL(ruta, window.location.origin);
  if (destino.origin !== window.location.origin) {
    throw new Error("fetchConSesion solo manda la sesión a rutas de esta aplicación.");
  }
  const headers = new Headers(init.headers);
  headers.delete("Better-Auth-Cookie");
  const sesion = sesionGuardada();
  if (sesion) headers.set("Better-Auth-Cookie", sesion);
  return fetch(ruta, { ...init, headers });
}

/** La sesión guardada, tal como la arma `crossDomainClient`; "" si no hay o no se puede leer. */
function sesionGuardada(): string {
  try {
    return authClient.getCookie();
  } catch {
    return "";
  }
}
