"use client";

import { useEffect, type CSSProperties } from "react";
import { useParams, usePathname, useRouter } from "next/navigation";
import {
  Authenticated,
  Unauthenticated,
  AuthLoading,
  useQuery,
} from "convex/react";
import { api } from "@vekino/backend/api";
import type { Id } from "@vekino/backend/dataModel";
import { PortalSidebarContent } from "@/components/portal/portal-sidebar";
import { CampanaNotificaciones } from "@/components/portal/campana-notificaciones";
import { PortalMobileNav } from "@/components/portal/portal-mobile-nav";
import { Spinner } from "@/components/ui/spinner";
import { CambiarClaveTemporalModal } from "@/components/cambiar-clave-temporal-modal";
import { WhatsappFab } from "@/components/whatsapp-fab";
import { useRegistrarUso } from "@/hooks/use-registrar-uso";
import { hexToHslChannels, hexToBrandForeground } from "@/lib/utils";
import { BrandThemeProvider } from "@/lib/brand-theme";
import { SolicitudesCobertura } from "@/components/guardia/solicitudes-cobertura";
import { AvisoTurnoPendiente } from "@/components/guardia/aviso-turno-pendiente";

export function PortalShell({ children }: { children: React.ReactNode }) {
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

/**
 * De qué módulo es cada sección del portal, para medir uso. Se deduce de la
 * ruta en vez de instrumentar página por página: así una pantalla nueva queda
 * medida sola, aunque sea como "app", en lugar de quedar invisible.
 */
const MODULO_POR_SECCION: Record<string, string> = {
  "": "app",
  asambleas: "asamblea",
  reservas: "reservas",
  avisos: "comunicados",
  consejo: "comunicados",
  documentos: "comunicados",
  pqrs: "soporte",
  soporte: "soporte",
  unidad: "facturas",
  pago: "pagos",
  cuenta: "pagos",
  vehiculos: "app",
  visitantes: "app",
  perfil: "app",
};

function Guard({ children }: { children: React.ReactNode }) {
  const params = useParams<{ id: string }>();
  const condominioId = params.id as Id<"condominios">;
  const home = useQuery(api.portal.home, { condominioId });

  // "/mi/<id>/reservas" → "reservas"
  const seccion = usePathname().split("/")[3] ?? "";
  useRegistrarUso("app", condominioId);
  useRegistrarUso(MODULO_POR_SECCION[seccion] ?? "app", condominioId);

  if (home === undefined) {
    return (
      <Fullscreen>
        <Spinner className="h-5 w-5" />
      </Fullscreen>
    );
  }
  if (!home.allowed) return <Redirect to="/dashboard" />;

  const base = `/mi/${condominioId}`;
  const primary = home.condominio.primaryColor;
  const brandChannels = primary ? hexToHslChannels(primary) : null;

  const themeStyle = brandChannels
    ? ({
        "--brand": brandChannels,
        "--ring": brandChannels,
        "--brand-foreground": hexToBrandForeground(primary!),
      } as CSSProperties)
    : undefined;

  return (
    <BrandThemeProvider style={themeStyle}>
      <div
        className="flex h-dvh flex-col overflow-hidden bg-background lg:p-1"
        style={themeStyle}
        data-brand-scope
      >
        <div className="flex min-h-0 w-full flex-1 overflow-hidden bg-card lg:rounded-[18px] lg:border lg:border-border lg:shadow-soft">
          <aside className="hidden w-60 shrink-0 flex-col overflow-hidden border-r border-border lg:flex">
            <PortalSidebarContent
              base={base}
              name={home.condominio.name}
              logo={home.condominio.logo}
              coverImage={home.condominio.coverImage}
              city={home.condominio.city}
              userName={home.userName}
              userImage={home.userImage}
              isPlatform={home.isPlatform}
              roles={home.myRoles}
            />
          </aside>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <PortalMobileNav
              base={base}
              name={home.condominio.name}
              logo={home.condominio.logo}
              coverImage={home.condominio.coverImage}
              city={home.condominio.city}
              userName={home.userName}
              userImage={home.userImage}
              isPlatform={home.isPlatform}
              roles={home.myRoles}
            />
            {/* Barra fina solo para la campana. El portal no tenía cabecera
                en escritorio, así que quien entra por el navegador no tenía
                dónde enterarse de un paquete o de una novedad de su casa. */}
            <div className="flex shrink-0 justify-end border-b border-border bg-background px-4 py-1.5 sm:px-6 lg:px-8">
              <CampanaNotificaciones condominioId={condominioId} base={base} />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-background">
              <div className="w-full px-4 py-5 sm:px-6 sm:py-6 lg:px-8">
                {/* Quien además es guarda de una compañía ve aquí sus
                    solicitudes de cobertura y el turno que tenga pendiente:
                    son suyas, no de una portería (QA-006, QA-008). Para el
                    resto de residentes no sale nada. */}
                <SolicitudesCobertura className="mb-4" />
                <AvisoTurnoPendiente className="mb-4" />
                {children}
              </div>
            </div>
          </div>
        </div>

        <CambiarClaveTemporalModal />
        {/* Hoy el portal no monta `PortalBottomNav`; si se monta, cambiar a
            bottomNav="md" (esa barra es `md:hidden`). */}
        <WhatsappFab condominioId={condominioId} />
      </div>
    </BrandThemeProvider>
  );
}
