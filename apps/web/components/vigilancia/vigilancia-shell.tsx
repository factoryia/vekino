"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  Authenticated,
  Unauthenticated,
  AuthLoading,
  useQuery,
  useMutation,
} from "convex/react";
import { api } from "@vekino/backend/api";
import { Spinner } from "@/components/ui/spinner";
import { CambiarClaveTemporalModal } from "@/components/cambiar-clave-temporal-modal";
import { CompanyNavigationShell } from "./company-navigation";

/**
 * Shell de la compañía de vigilancia: supervisión de conjuntos.
 *
 * Propio y no el del conjunto: ni el supervisor ni el administrador de la
 * empresa pertenecen a ningún conjunto —pertenecen a la compañía que los
 * cubre— y su trabajo es transversal a varios, así que ni el shell de
 * administración (que exige membresía) ni el de portería (que gira alrededor
 * de UN turno) les sirven.
 *
 * Entran los dos roles porque los dos miran la misma operación: el supervisor
 * los conjuntos que tiene asignados y el administrador los que su empresa
 * atiende por contrato. No decide nada de permisos: lo único que hace es no
 * dejar entrar a quien no es personal de vigilancia. El alcance real —qué
 * conjuntos y qué guardas— lo resuelve el servidor en `asignaciones.miEquipo`,
 * y cada consulta de portería lo vuelve a comprobar por su cuenta.
 */
export function VigilanciaShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-dvh overflow-hidden bg-background">
      <AuthLoading>
        <Fullscreen>
          <Spinner className="h-5 w-5" />
        </Fullscreen>
      </AuthLoading>
      <Unauthenticated>
        <Redirect to="/login" />
      </Unauthenticated>
      <Authenticated>
        <Guard>{children}</Guard>
      </Authenticated>
    </div>
  );
}

function Fullscreen({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function Redirect({ to }: { to: string }) {
  const router = useRouter();
  useEffect(() => {
    router.replace(to);
  }, [router, to]);
  return (
    <Fullscreen>
      <Spinner className="h-5 w-5" />
    </Fullscreen>
  );
}

function Guard({ children }: { children: React.ReactNode }) {
  const ensureProfile = useMutation(api.users.ensureProfile);
  const compania = useQuery(api.companias.miCompania);
  const me = useQuery(api.users.me);

  useEffect(() => {
    void ensureProfile();
  }, [ensureProfile]);

  if (compania === undefined || me === undefined || me === null) {
    return (
      <Fullscreen>
        <Spinner className="h-5 w-5" />
      </Fullscreen>
    );
  }

  /* Quien no es personal de una compañía no pinta nada aquí. No es la
   * autorización de verdad —esa está en el servidor— sino no dejar una
   * pantalla vacía a quien llegó por una URL que no le toca. */
  const supervisa = compania?.roles.includes("supervisor") ?? false;
  const administra = compania?.roles.includes("admin_compania") ?? false;
  if (!compania || (!supervisa && !administra)) {
    return <Redirect to="/dashboard" />;
  }

  return (
    <>
      <CompanyNavigationShell company={{ id: compania.companiaId, name: compania.nombre, logo: compania.logo, isAdmin: administra, userName: me.name }}>
        {children}
      </CompanyNavigationShell>
      <CambiarClaveTemporalModal />
    </>
  );
}
