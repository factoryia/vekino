"use client";

import { Suspense, useEffect, type CSSProperties } from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import {
  Authenticated,
  Unauthenticated,
  AuthLoading,
  useQuery,
  useMutation,
} from "convex/react";
import { LayoutDashboard, LogOut, ShieldCheck } from "lucide-react";
import { api } from "@vekino/backend/api";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/utils";
import {
  homeHrefForRoles,
  homeHrefForAsignacion,
  homeHrefForCompania,
  sesionOperativa,
} from "@/lib/role-routing";
import { useMeOperativo } from "@/hooks/use-contexto-operativo";
import {
  PlatformSidebar,
  PlatformMobileNav,
} from "@/components/layout/platform-sidebar";
import { AdminTopbar } from "@/components/layout/admin-topbar";
import { AdminTopbarProvider } from "@/components/layout/admin-topbar-context";
import { Spinner } from "@/components/ui/spinner";
import { CambiarClaveTemporalModal } from "@/components/cambiar-clave-temporal-modal";
import { CompanyNavigationShell } from "@/components/vigilancia/company-navigation";

export function DashboardShell({ children }: { children: React.ReactNode }) {
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
        <Shell>{children}</Shell>
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

function Shell({ children }: { children: React.ReactNode }) {
  const ensureProfile = useMutation(api.users.ensureProfile);
  /* Con el contexto de guarda al día: si una cobertura empieza o termina con
   * la sesión abierta, el ruteo de abajo se vuelve a decidir solo. */
  const me = useMeOperativo();
  const pathname = usePathname();

  // Cuando `me` aún es null, el JWT puede no haber llegado: reintentamos al
  // resolverse la sesión para no spamear errores de "No autenticado".
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const id = await ensureProfile();
      if (cancelled || id) return;
      // Reintento corto si la mutación llegó antes del token.
      await new Promise((r) => setTimeout(r, 400));
      if (!cancelled) await ensureProfile();
    })();
    return () => {
      cancelled = true;
    };
  }, [ensureProfile]);

  if (me === undefined || me === null) {
    return (
      <Fullscreen>
        <Spinner className="h-5 w-5" />
      </Fullscreen>
    );
  }

  const isPlatform =
    me.platformRole === "superadmin" || me.platformRole === "admin";

  const administraCompania = !isPlatform && me.compania?.roles.includes("admin_compania") === true;
  // El administrador aterriza en operación aunque también tenga membresías.
  // Su gestión de personal/contratos conserva la ruta existente.
  if (administraCompania && me.compania && pathname !== `/dashboard/companias/${me.compania.companiaId}`) {
    return <Redirect to={homeHrefForCompania("admin_compania", me.compania.companiaId)!} />;
  }

  /* El ruteo de abajo mira la sesión como se OPERA hoy: con una cobertura
   * activa, las vías de guarda de siempre no cuentan (`sesionOperativa`). Sin
   * esto, el guarda que cubre otro conjunto acababa en su portería de siempre,
   * que el servidor ya no le abre, y de vuelta aquí: un bucle. */
  const hoy = sesionOperativa(me);
  const cobertura = me.contextoOperativoGuardia.cobertura;

  /* Con una cobertura activa, su portería de hoy es la que cubre. Solo si no
   * le queda nada más que atender: el residente o el administrador de un
   * conjunto siguen entrando a su panel, con la cobertura a la vista. */
  if (
    !isPlatform && !administraCompania &&
    cobertura &&
    hoy.memberships.length === 0 &&
    hoy.asignaciones.length === 0
  ) {
    return <Redirect to={homeHrefForAsignacion(cobertura.condominioId, "guardia")} />;
  }

  if (
    !isPlatform && !administraCompania &&
    hoy.memberships.length === 1 &&
    hoy.memberships[0] &&
    hoy.asignaciones.length === 0 &&
    !cobertura
  ) {
    const m = hoy.memberships[0];
    return <Redirect to={homeHrefForRoles(m.condominioId, m.roles)} />;
  }

  /* El personal de vigilancia no tiene membresías: pertenece a una compañía,
   * no al conjunto. Sin esta rama caía en el panel de "Mis condominios" con
   * la lista vacía —entraba bien y no veía nada— porque todo el ruteo se
   * apoyaba solo en `memberships`. */
  if (!isPlatform && !administraCompania && hoy.memberships.length === 0 && hoy.asignaciones.length > 0) {
    /* El supervisor primero: su panel es transversal a todos sus conjuntos,
     * así que cubre también al que supervisa varios. */
    const supervisa = hoy.asignaciones.find((a) => a.rol === "supervisor");
    if (supervisa) {
      return (
        <Redirect
          to={homeHrefForAsignacion(supervisa.condominioId, "supervisor")}
        />
      );
    }
    if (hoy.asignaciones.length === 1 && hoy.asignaciones[0]) {
      const a = hoy.asignaciones[0];
      return <Redirect to={homeHrefForAsignacion(a.condominioId, a.rol)} />;
    }
  }

  /* Personal de una compañía sin membresía ni asignación. El caso típico es
   * el administrador —no pisa ninguna portería, administra la empresa que las
   * cubre—, pero también cae aquí el supervisor al que todavía no le han dado
   * conjuntos. Sin esta rama los dos aterrizaban en "Mis condominios" con la
   * lista vacía: entran bien y no ven nada.
   *
   * El destino sale de `homeHrefForCompania`, que es UN mapa rol → sitio. Se
   * puede escribir así porque el rol de compañía es único: el backend lo
   * garantiza en todos sus puntos de escritura, de modo que aquí no hay que
   * desempatar entre "tiene guardia" y "además tiene supervisor". */
  if (
    !isPlatform &&
    hoy.memberships.length === 0 &&
    hoy.asignaciones.length === 0 &&
    me.compania
  ) {
    const destino = homeHrefForCompania(
      me.compania.roles[0],
      me.compania.companiaId,
    );
    const gestionCompania = me.compania.roles.includes("admin_compania") && pathname === `/dashboard/companias/${me.compania.companiaId}`;
    if (destino && !pathname.startsWith(destino) && !gestionCompania) {
      return <Redirect to={destino} />;
    }
  }

  if (
    !isPlatform &&
    (pathname.startsWith("/dashboard/condominios") ||
      pathname.startsWith("/dashboard/administradores") ||
      pathname.startsWith("/dashboard/automatizaciones") ||
      pathname.startsWith("/dashboard/inbox") ||
      pathname.startsWith("/dashboard/uso") ||
      pathname.startsWith("/dashboard/soporte"))
  ) {
    return <Redirect to="/dashboard" />;
  }

  if (!isPlatform) {
    return <UserMultiCondoShell me={me}>{children}</UserMultiCondoShell>;
  }

  const esInbox = pathname.startsWith("/dashboard/inbox");

  return (
    <div
      className="font-admin flex h-dvh flex-col overflow-hidden bg-background lg:p-3.5"
      style={
        {
          /* Panel maestro: acento carbón (sin naranja de producto) */
          "--brand": "120 6% 14%",
          "--brand-foreground": "0 0% 100%",
          "--ring": "120 4% 38%",
          "--success": "120 5% 32%",
          "--success-foreground": "0 0% 100%",
        } as CSSProperties
      }
    >
      <div className="flex min-h-0 w-full flex-1 overflow-hidden bg-card lg:rounded-[18px] lg:border lg:border-border lg:shadow-soft">
        <aside className="hidden w-60 shrink-0 flex-col overflow-hidden border-r border-border lg:flex">
          <PlatformSidebar
            userName={me.name}
            userEmail={me.email}
            userImage={me.image}
            platformRole={me.platformRole}
          />
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <PlatformMobileNav
            userName={me.name}
            userEmail={me.email}
            userImage={me.image}
            platformRole={me.platformRole}
          />
          <AdminTopbarProvider>
            {/* La bandeja ya trae su propio buscador y cabecera de chat: el
             * topbar solo le robaba alto a la conversación. */}
            {!esInbox && <AdminTopbar base="/dashboard" variant="platform" />}
            <div
              className={cn(
                "min-h-0 flex-1 overscroll-contain",
                esInbox ? "overflow-hidden" : "overflow-y-auto",
              )}
            >
              <Suspense fallback={null}>{children}</Suspense>
            </div>
          </AdminTopbarProvider>
        </div>
      </div>

      <CambiarClaveTemporalModal />
    </div>
  );
}

function UserMultiCondoShell({
  me,
  children,
}: {
  me: NonNullable<ReturnType<typeof useQuery<typeof api.users.me>>>;
  children: React.ReactNode;
}) {
  const router = useRouter();

  async function signOut() {
    await authClient.signOut();
    router.replace("/login");
  }

  if (me.compania?.roles.includes("admin_compania")) {
    return (
      <>
        <CompanyNavigationShell company={{ id: me.compania.companiaId, name: me.compania.nombre, logo: me.compania.logo, isAdmin: true, userName: me.name }}>
          {children}
        </CompanyNavigationShell>
        <CambiarClaveTemporalModal />
      </>
    );
  }

  return (
    <div className="font-admin flex h-dvh flex-col overflow-hidden bg-background lg:p-3.5">
      <div className="flex min-h-0 w-full flex-1 overflow-hidden bg-card lg:rounded-[18px] lg:border lg:border-border lg:shadow-soft">
        <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-card lg:flex">
          <div className="flex h-full flex-col gap-3 px-3 py-3.5">
            <div className="px-1.5 py-1">
              <Image
                src="/logos/logo-vekino.svg"
                alt="Vekino"
                width={112}
                height={36}
                className="h-7 w-auto dark:brightness-0 dark:invert"
              />
            </div>
            <nav className="flex-1 space-y-0.5">
              <Link
                href="/dashboard"
                className="flex h-8 items-center gap-2.5 rounded-lg bg-accent px-2.5 text-[13px] font-normal text-foreground"
              >
                <LayoutDashboard className="h-3.75 w-3.75 stroke-2 text-brand" />
                Mis condominios
              </Link>
              {/* Para el personal de una compañía, esta es su casa. */}
              {me.compania && (
                <Link
                  href={`/dashboard/companias/${me.compania.companiaId}`}
                  className="flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13px] font-normal text-foreground hover:bg-accent"
                >
                  <ShieldCheck className="h-3.75 w-3.75 stroke-2 text-brand" />
                  {me.compania.nombre}
                </Link>
              )}
            </nav>
            <div className="border-t border-border/70 pt-2.5">
              <div className="px-1.5 py-1">
                <p className="truncate text-[12.5px] text-foreground">{me.name}</p>
                <p className="truncate text-[10.5px] text-muted-foreground">{me.email}</p>
              </div>
              <button
                type="button"
                onClick={signOut}
                className="mt-1 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] text-red-600 hover:bg-red-500/10 dark:text-red-400"
              >
                <LogOut className="h-3.5 w-3.5" />
                Cerrar sesión
              </button>
            </div>
          </div>
        </aside>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {children}
        </div>
      </div>

      <CambiarClaveTemporalModal />
    </div>
  );
}
