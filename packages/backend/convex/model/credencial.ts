import type { GenericCtx } from "@convex-dev/better-auth";
import type { DataModel } from "../_generated/dataModel";
import { createAuth } from "../auth";
import { evaluarPassword } from "../lib/passwordFuerte";

/**
 * FIJAR LA CONTRASEÑA DE UNA CUENTA. Un solo sitio.
 *
 * La misma secuencia —buscar en Better Auth por correo, crear la cuenta si no
 * existe, crear la credencial si falta, actualizarla si está— estaba escrita
 * en `users.setMemberPassword`, en `companias.crearMiembro`, en
 * `users.createCondoMember` y en `users.createPlatformAdmin`. Cuatro copias de
 * la operación más delicada del sistema es cómo se acaba teniendo una que
 * valida la fuerza de la clave y otra que no.
 *
 * ── Qué NO hace ──────────────────────────────────────────────────────────
 * No autoriza. Quien llame ya debe haber comprobado que puede tocar esa
 * cuenta: aquí llega un correo y una clave, y no hay forma de saber desde
 * dónde vinieron. La autorización vive en `assertPuedeEditarMiembro`
 * (compañía) y en `users.assertCanEditMember` (conjunto).
 *
 * No devuelve nada de la credencial. Ni el hash, ni si había una antes con
 * otro valor, ni la clave que entró. Lo único que sale es si hubo que crear
 * la cuenta, que es información de la operación y no del secreto.
 *
 * Y NO es para las altas: un alta solo crea identidades nuevas
 * (`credencialDeAlta`, más abajo).
 */

export type ResultadoCredencial = {
  ok: true;
  /** Si no existía cuenta en Better Auth y hubo que crearla. */
  cuentaCreada: boolean;
};

/**
 * Valida la fuerza y escribe la credencial.
 *
 * La política es `lib/passwordFuerte`, la misma que aplica el usuario cuando
 * cambia la suya y la que la app usa para las pistas en vivo. Antes, las
 * rutas por las que un administrador fijaba la clave de otro solo miraban que
 * tuviera ocho caracteres: la persona con MENOS control sobre su propia
 * cuenta —a la que le ponen la clave— era la peor protegida.
 *
 * Se le pasan nombre y correo para que la política pueda rechazar claves
 * construidas con los datos de la propia persona.
 */
export async function fijarPasswordDeCuenta(
  ctx: GenericCtx<DataModel>,
  datos: { email: string; name: string; password: string },
): Promise<ResultadoCredencial> {
  const password = datos.password.trim();

  const fuerza = evaluarPassword(password, {
    email: datos.email,
    nombre: datos.name,
  });
  if (!fuerza.ok) throw new Error(fuerza.problemas[0]!);

  const authCtx = await createAuth(ctx).$context;
  const ia = authCtx.internalAdapter;
  /* El hash lo calcula Better Auth con su propio scrypt. Nunca se guarda ni
   * se compara nada a mano, y la clave en claro no sale de esta función. */
  const hashed = await authCtx.password.hash(password);

  const found = await ia.findUserByEmail(datos.email);

  if (!found) {
    /* Perfil de aplicación sin cuenta de acceso: pasa con los usuarios
     * importados en la migración. Fijarle la clave es justamente lo que le
     * habilita la entrada. */
    const created = await ia.createUser({
      email: datos.email,
      name: datos.name,
      emailVerified: false,
    });
    await ia.createAccount({
      userId: created.id,
      providerId: "credential",
      accountId: created.id,
      password: hashed,
    });
    return { ok: true, cuentaCreada: true };
  }

  const accounts = await ia.findAccounts(found.user.id);
  const credential = accounts.find((a) => a.providerId === "credential");
  if (!credential) {
    /* Entra con Google o Apple y todavía no tiene contraseña. Añadirla no le
     * quita el proveedor social: le da una segunda vía. */
    await ia.createAccount({
      userId: found.user.id,
      providerId: "credential",
      accountId: found.user.id,
      password: hashed,
    });
  } else {
    await ia.updatePassword(found.user.id, hashed);
  }

  return { ok: true, cuentaCreada: false };
}

/**
 * LA CREDENCIAL DE UN ALTA. Solo para identidades nuevas.
 *
 * Las altas con contraseña —personal de una compañía, miembro de un conjunto,
 * staff de plataforma— escribían la clave con `fijarPasswordDeCuenta` aunque
 * la cuenta ya existiera. Bastaba con dar de alta el correo de otra persona,
 * incluido el de un superadministrador, para dejarle una clave que conocía
 * quien hacía el alta (QA-003). Un alta añade un vínculo; no se apropia de una
 * identidad.
 *
 * Así que esto solo crea. Si Better Auth ya conoce el correo devuelve su id y
 * no toca nada: ni la credencial, ni el proveedor social. La clave de una
 * cuenta existente la cambia su dueño (`cambiarMiPassword`, el
 * restablecimiento por correo) o quien la gestiona por una ruta con su propia
 * autorización (`setPasswordMiembro`, `setMemberPassword`).
 *
 * Quien llama tampoco debe usarlo cuando el perfil de aplicación ya existía,
 * aunque no tenga cuenta de acceso todavía: también es una identidad de otra
 * persona, y crearle la primera clave sería quedarse con ella.
 */
export async function credencialDeAlta(
  ctx: GenericCtx<DataModel>,
  datos: { email: string; name: string; password: string },
): Promise<{ authUserId: string; cuentaCreada: boolean }> {
  const authCtx = await createAuth(ctx).$context;
  const ia = authCtx.internalAdapter;
  const found = await ia.findUserByEmail(datos.email);
  if (found) return { authUserId: found.user.id, cuentaCreada: false };

  /* La fuerza de la clave la valida cada alta con su propia regla, igual que
   * antes: esto no cambia qué clave se acepta, solo a quién se le pone. */
  const hashed = await authCtx.password.hash(datos.password.trim());
  const created = await ia.createUser({
    email: datos.email,
    name: datos.name,
    emailVerified: false,
  });
  await ia.createAccount({
    userId: created.id,
    providerId: "credential",
    accountId: created.id,
    password: hashed,
  });
  return { authUserId: created.id, cuentaCreada: true };
}
