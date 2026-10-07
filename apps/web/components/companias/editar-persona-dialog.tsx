"use client";

import { useEffect, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { KeyRound, Loader2, ShieldCheck, UserCog } from "lucide-react";
import { api } from "@vekino/backend/api";
import type { Id } from "@vekino/backend/dataModel";
import { evaluarPassword } from "@vekino/backend/passwordFuerte";
import { Button } from "@/components/ui/button";
import { ErrorBoundary, ErrorMessage } from "@/components/ui/error-boundary";
import { Input, Select } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { Skeleton } from "@/components/ui/skeleton";
import { mensajeErrorUsuario } from "@/lib/utils";

/**
 * Editar a una persona de la compañía.
 *
 * Dos secciones separadas y dos botones, porque son dos operaciones distintas
 * en el backend y de sensibilidad muy distinta: corregir un apellido no puede
 * pasar por el código que reescribe credenciales. Quien solo viene a arreglar
 * un teléfono no tiene que tocar la contraseña.
 *
 * La contraseña NUNCA se precarga ni se muestra: no existe forma de leerla
 * —el hash vive en Better Auth y ninguna consulta lo devuelve— y el campo
 * arranca vacío siempre. Por eso dice "Nueva contraseña" y no "Contraseña".
 */

const DOCUMENTOS = ["CC", "CE", "NIT", "PASAPORTE", "TI", "PEP"] as const;
type TipoDocumento = (typeof DOCUMENTOS)[number];

type RolCompania = "admin_compania" | "supervisor" | "guardia";

/** Las mismas etiquetas que pinta la tabla. */
const ETIQUETA_ROL: Record<RolCompania, string> = {
  admin_compania: "Administrador",
  supervisor: "Supervisor",
  guardia: "Guarda",
};

export function EditarPersonaDialog({
  miembroId,
  rolActual,
  onClose,
}: {
  miembroId: Id<"companiaMiembros">;
  /** El que tiene hoy. Lo pasa la fila, que ya lo tiene cargado. */
  rolActual: RolCompania | undefined;
  onClose: () => void;
}) {
  return (
    <Modal
      open
      onClose={onClose}
      title="Editar persona"
      description="Datos de la persona y acceso a la plataforma"
      className="max-w-lg"
    >
      <ErrorBoundary
        resetKey={miembroId}
        fallback={(e) => (
          <ErrorMessage title="No se puede editar" detail={e.message} />
        )}
      >
        <Contenido
          miembroId={miembroId}
          rolActual={rolActual}
          onClose={onClose}
        />
      </ErrorBoundary>
    </Modal>
  );
}

function Contenido({
  miembroId,
  rolActual,
  onClose,
}: {
  miembroId: Id<"companiaMiembros">;
  rolActual: RolCompania | undefined;
  onClose: () => void;
}) {
  const datos = useQuery(api.companias.detalleMiembro, { miembroId });
  if (datos === undefined) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-9 rounded-lg" />
        ))}
      </div>
    );
  }
  return (
    <div className="space-y-6">
      <DatosPersonales datos={datos} onClose={onClose} />
      <div className="border-t border-border pt-5">
        <RolEnLaCompania miembroId={miembroId} rolActual={rolActual} />
      </div>
      <div className="border-t border-border pt-5">
        <Credencial miembroId={miembroId} email={datos.email} nombre={datos.nombre} />
      </div>
    </div>
  );
}

type Datos = NonNullable<
  Awaited<ReturnType<typeof useQuery<typeof api.companias.detalleMiembro>>>
>;

function DatosPersonales({
  datos,
  onClose,
}: {
  datos: Datos;
  onClose: () => void;
}) {
  const actualizar = useMutation(api.companias.actualizarMiembro);
  const cambiarCorreo = useAction(api.companias.setEmailMiembro);

  const [nombre, setNombre] = useState(datos.nombre);
  const [firstName, setFirstName] = useState(datos.firstName ?? "");
  const [lastName, setLastName] = useState(datos.lastName ?? "");
  const [tipoDocumento, setTipoDocumento] = useState(datos.tipoDocumento ?? "");
  const [numeroDocumento, setNumeroDocumento] = useState(
    datos.numeroDocumento ?? "",
  );
  const [telefono, setTelefono] = useState(datos.telefono ?? "");
  const [cargo, setCargo] = useState(datos.cargo ?? "");
  const [email, setEmail] = useState(datos.email);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  async function guardar(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setOk(null);
    setBusy(true);
    try {
      await actualizar({
        miembroId: datos.miembroId,
        name: nombre,
        firstName: firstName || undefined,
        lastName: lastName || undefined,
        tipoDocumento: (tipoDocumento || undefined) as TipoDocumento | undefined,
        numeroDocumento: numeroDocumento || undefined,
        telefono: telefono || undefined,
        cargo: cargo || undefined,
      });
      /* El correo va aparte porque además mueve la credencial. Solo se llama
       * si de verdad cambió: es una operación con más consecuencias. */
      const nuevo = email.trim().toLowerCase();
      if (nuevo !== datos.email.trim().toLowerCase()) {
        await cambiarCorreo({ miembroId: datos.miembroId, email: nuevo });
        setOk("Datos y correo actualizados. A partir de ahora entra con el correo nuevo.");
      } else {
        setOk("Datos actualizados.");
      }
    } catch (err) {
      setError(mensajeErrorUsuario(err, "No se pudo guardar."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={guardar} className="space-y-3.5">
      <p className="text-[11px] font-medium uppercase tracking-[0.04em] text-muted-foreground">
        Información personal
      </p>

      <Campo label="Nombre completo" requerido>
        <Input value={nombre} onChange={(e) => setNombre(e.target.value)} required />
      </Campo>

      <div className="grid grid-cols-2 gap-3">
        <Campo label="Nombres">
          <Input value={firstName} onChange={(e) => setFirstName(e.target.value)} />
        </Campo>
        <Campo label="Apellidos">
          <Input value={lastName} onChange={(e) => setLastName(e.target.value)} />
        </Campo>
      </div>

      <div className="grid grid-cols-[7rem_1fr] gap-3">
        <Campo label="Tipo doc.">
          <Select
            value={tipoDocumento}
            onChange={(e) => setTipoDocumento(e.target.value)}
          >
            <option value="">—</option>
            {DOCUMENTOS.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </Select>
        </Campo>
        <Campo label="Número de documento">
          <Input
            value={numeroDocumento}
            onChange={(e) => setNumeroDocumento(e.target.value)}
          />
        </Campo>
      </div>

      <Campo label="Teléfono">
        <Input
          value={telefono}
          onChange={(e) => setTelefono(e.target.value)}
          placeholder="300 123 4567"
        />
      </Campo>

      <Campo label="Cargo">
        <Input
          value={cargo}
          onChange={(e) => setCargo(e.target.value)}
          placeholder="Supervisor zona norte"
        />
      </Campo>

      <Campo label="Correo (con el que entra)" requerido>
        <Input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </Campo>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {ok && (
        <p className="flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400">
          <ShieldCheck className="h-4 w-4" aria-hidden />
          {ok}
        </p>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={busy}>
          Cerrar
        </Button>
        <Button type="submit" size="sm" disabled={busy}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          Guardar cambios
        </Button>
      </div>
    </form>
  );
}

/**
 * El rol de la persona dentro de la compañía.
 *
 * Sección propia con su propio botón, como las otras dos y por el mismo
 * motivo: en el backend son mutaciones distintas —`setRolesMiembro` frente a
 * `actualizarMiembro`— y meter el rol en el formulario de datos personales
 * haría que corregir un apellido pudiera, de paso, cambiar quién opera qué
 * portería. Es justo lo que evita `actualizarMiembro` al no aceptar el rol.
 *
 * Un `Select` y no tres píldoras: una persona de compañía tiene UN rol —lo
 * garantiza el backend en todos sus puntos de escritura— y un desplegable no
 * deja ni la duda de si se pueden marcar varios.
 */
function RolEnLaCompania({
  miembroId,
  rolActual,
}: {
  miembroId: Id<"companiaMiembros">;
  rolActual: RolCompania | undefined;
}) {
  const setRoles = useMutation(api.companias.setRolesMiembro);
  const [rol, setRol] = useState<RolCompania>(rolActual ?? "guardia");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  /* Al cambiar de persona el desplegable vuelve a decir la verdad. */
  useEffect(() => {
    setRol(rolActual ?? "guardia");
    setError(null);
    setOk(false);
  }, [miembroId, rolActual]);

  const cambio = rol !== rolActual;

  async function guardar(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setOk(false);
    setBusy(true);
    try {
      /* Se manda SOLO el rol nuevo: reemplaza al anterior, nunca se suma.
       * `cargo` no viaja a propósito —lo edita la sección de arriba— y la
       * mutación lo respeta si no se lo mandan. */
      await setRoles({ miembroId, roles: [rol] });
      setOk(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cambiar el rol.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={guardar} className="space-y-3.5">
      <p className="text-[11px] font-medium uppercase tracking-[0.04em] text-muted-foreground">
        Rol en la compañía
      </p>
      <p className="text-xs text-muted-foreground">
        Una persona tiene un único rol. El que elijas reemplaza al anterior.
      </p>

      <Campo label="Rol" requerido>
        <Select
          value={rol}
          onChange={(e) => {
            setRol(e.target.value as RolCompania);
            setOk(false);
          }}
        >
          {(Object.keys(ETIQUETA_ROL) as RolCompania[]).map((r) => (
            <option key={r} value={r}>
              {ETIQUETA_ROL[r]}
            </option>
          ))}
        </Select>
      </Campo>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {ok && (
        <p className="flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400">
          <ShieldCheck className="h-4 w-4" aria-hidden />
          Rol actualizado.
        </p>
      )}

      <div className="flex justify-end">
        <Button type="submit" size="sm" variant="outline" disabled={!cambio || busy}>
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <UserCog className="h-4 w-4" aria-hidden />
          )}
          Cambiar rol
        </Button>
      </div>
    </form>
  );
}

function Credencial({
  miembroId,
  email,
  nombre,
}: {
  miembroId: Id<"companiaMiembros">;
  email: string;
  nombre: string;
}) {
  const setPassword = useAction(api.companias.setPasswordMiembro);
  const [nueva, setNueva] = useState("");
  const [confirmar, setConfirmar] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  /* El campo arranca vacío y se vacía al terminar: la clave no se queda en
   * memoria del formulario más de lo necesario. */
  useEffect(() => {
    setNueva("");
    setConfirmar("");
    setOk(false);
  }, [miembroId]);

  /* La misma función que valida el backend, aquí solo para dar pistas en
   * vivo. La que manda es la del servidor. */
  const fuerza = nueva ? evaluarPassword(nueva, { email, nombre }) : null;
  const coinciden = nueva.length > 0 && nueva === confirmar;
  const puede = coinciden && (fuerza?.ok ?? false) && !busy;

  async function establecer(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setOk(false);
    if (nueva !== confirmar) {
      setError("Las contraseñas no coinciden.");
      return;
    }
    setBusy(true);
    try {
      await setPassword({ miembroId, password: nueva });
      setNueva("");
      setConfirmar("");
      setOk(true);
    } catch (err) {
      setError(mensajeErrorUsuario(err, "No se pudo establecer."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={establecer} className="space-y-3.5">
      <p className="text-[11px] font-medium uppercase tracking-[0.04em] text-muted-foreground">
        Seguridad
      </p>
      <p className="text-xs text-muted-foreground">
        La contraseña actual no se puede consultar: nadie la guarda en claro.
        Aquí solo se establece una nueva, y desde ese momento la anterior deja
        de servir.
      </p>

      <Campo label="Nueva contraseña">
        <Input
          type="password"
          value={nueva}
          onChange={(e) => setNueva(e.target.value)}
          autoComplete="new-password"
          placeholder="Sin escribir nada, la contraseña no cambia"
        />
      </Campo>
      <Campo label="Confirmar nueva contraseña">
        <Input
          type="password"
          value={confirmar}
          onChange={(e) => setConfirmar(e.target.value)}
          autoComplete="new-password"
        />
      </Campo>

      {fuerza && !fuerza.ok && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          {fuerza.problemas[0]}
        </p>
      )}
      {nueva.length > 0 && confirmar.length > 0 && !coinciden && (
        <p className="text-xs text-destructive">Las contraseñas no coinciden.</p>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
      {ok && (
        <p className="flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400">
          <ShieldCheck className="h-4 w-4" aria-hidden />
          Contraseña establecida. Entrégasela por un medio seguro.
        </p>
      )}

      <div className="flex justify-end">
        <Button type="submit" size="sm" variant="outline" disabled={!puede}>
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <KeyRound className="h-4 w-4" aria-hidden />
          )}
          Establecer nueva contraseña
        </Button>
      </div>
    </form>
  );
}

function Campo({
  label,
  requerido,
  children,
}: {
  label: string;
  requerido?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="block text-xs font-medium text-foreground">
        {label}
        {requerido && <span className="text-destructive"> *</span>}
      </span>
      {children}
    </label>
  );
}
