"use client";

import { useEffect, useState, type CSSProperties } from "react";
import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import { Authenticated, Unauthenticated, AuthLoading, useQuery } from "convex/react";
import { api } from "@vekino/backend/api";
import type { Id } from "@vekino/backend/dataModel";
import {
  Car,
  ShieldCheck,
  BookOpenCheck,
  UserCheck,
  Package,
  CalendarCheck,
  AlertTriangle,
  ShieldAlert,
  HandCoins,
  Megaphone,
  LogOut,
  LayoutGrid,
  X,
} from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { Spinner } from "@/components/ui/spinner";
import { CambiarClaveTemporalModal } from "@/components/cambiar-clave-temporal-modal";
import { RecordatorioCierreTurno } from "@/components/guardia/recordatorio-cierre";
import { SolicitudesCobertura } from "@/components/guardia/solicitudes-cobertura";
import { AvisoCobertura } from "@/components/guardia/aviso-cobertura";
import { AvisoTurnoPendiente } from "@/components/guardia/aviso-turno-pendiente";
import { WhatsappFab } from "@/components/whatsapp-fab";
import { hexToHslChannels, hexToBrandForeground, cn, initials } from "@/lib/utils";
import { BrandThemeProvider } from "@/lib/brand-theme";
import { recibeRecordatorioCierre, sesionOperativa } from "@/lib/role-routing";
import {
  useConservado,
  useMeOperativo,
  useRefrescoOperativo,
} from "@/hooks/use-contexto-operativo";
import { Footprints } from "lucide-react";
import type { LucideIcon } from "lucide-react";

const NAV: { label: string; segment: string; icon: LucideIcon }[] = [
  { label: "Minuta", segment: "", icon: BookOpenCheck },
  { label: "Visitantes", segment: "visitantes", icon: UserCheck },
  { label: "Paquetería", segment: "paqueteria", icon: Package },
  { label: "Reservas", segment: "reservas", icon: CalendarCheck },
  { label: "Rondas", segment: "rondas", icon: Footprints },
  { label: "Novedades", segment: "novedades", icon: AlertTriangle },
  { label: "Aportes Voluntarios", segment: "aportes-voluntarios", icon: HandCoins },
  { label: "Parqueadero", segment: "parqueadero", icon: Car },
  { label: "Avisos", segment: "avisos", icon: Megaphone },
  { label: "Incidentes", segment: "incidentes", icon: ShieldAlert },
];

/** Ítems visibles en la barra inferior móvil; el resto va en "Más". */
const NAV_MOBILE = [
  NAV[0]!,
  { ...NAV[6]!, label: "Aporte Voluntario" },
  NAV[2]!,
  NAV[5]!,
];
const NAV_EXTRA = [NAV[1]!, NAV[3]!, NAV[4]!, NAV[7]!, NAV[8]!, NAV[9]!];

export function GuardiaShell({ children }: { children: React.ReactNode }) {
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
  const params = useParams<{ id: string }>();
  const condominioId = params.id as Id<"condominios">;
  /* `home` y `me` se vuelven a pedir en el instante en que una cobertura
   * empieza o termina (`refresco`): Convex no lo haría solo, porque el paso
   * del tiempo no cambia ningún dato. Quién entra lo decide el servidor. */
  const refresco = useRefrescoOperativo();
  const home = useConservado(
    useQuery(api.guardia.home, refresco ? { condominioId, refresco } : { condominioId }),
    condominioId,
  );
  const compania = useQuery(api.companias.miCompania);
  // Ya suscrita por `CambiarClaveTemporalModal`: Convex comparte la consulta.
  const me = useMeOperativo();

  if (home === undefined) {
    return (
      <Fullscreen>
        <Spinner className="h-5 w-5" />
      </Fullscreen>
    );
  }
  const cobertura = me?.contextoOperativoGuardia.cobertura ?? null;
  if (!home.allowed) {
    /* La URL de otra portería no salta nada: el servidor ya dijo que aquí no
     * entra. Si es porque hoy cubre otro conjunto, se le lleva allí. */
    if (me === undefined) {
      return (
        <Fullscreen>
          <Spinner className="h-5 w-5" />
        </Fullscreen>
      );
    }
    const destino =
      cobertura && cobertura.condominioId !== condominioId
        ? `/guardia/${cobertura.condominioId}`
        : "/dashboard";
    return <Redirect to={destino} />;
  }

  const base = `/guardia/${condominioId}`;
  /* Con lo que se opera hoy: con una cobertura activa, las vías de guarda de
   * siempre no cuentan aquí y la cobertura sí, como una asignación de guarda
   * de su compañía. */
  const hoy = me ? sesionOperativa(me) : null;
  const cubreAqui = cobertura?.condominioId === condominioId ? cobertura : null;
  const asignacionesAqui = (hoy?.asignaciones ?? []).filter((a) => a.condominioId === condominioId);
  const incidentesCorporativos =
    asignacionesAqui.some((a) => a.companiaId === compania?.companiaId && a.rol === "guardia") ||
    (!!cubreAqui && cubreAqui.companiaId === compania?.companiaId);
  /* Solo al guarda: a esta portería también entran administración y junta.
   * Hasta tener roles y asignaciones cargados no se decide nada. */
  const recordatorioCierre =
    !!hoy &&
    recibeRecordatorioCierre({
      esPlataforma: home.isPlatform,
      rolesConjunto:
        hoy.memberships.find((m) => m.condominioId === condominioId)?.roles ?? [],
      rolesAsignacion: [
        ...asignacionesAqui.map((a) => a.rol),
        ...(cubreAqui ? (["guardia"] as const) : []),
      ],
    });
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
        className="font-admin flex h-dvh flex-col overflow-hidden bg-background lg:p-1"
        style={themeStyle}
        data-brand-scope
      >
        <div className="flex min-h-0 w-full flex-1 overflow-hidden bg-card lg:rounded-[18px] lg:border lg:border-border lg:shadow-soft">
          <aside className="hidden w-60 shrink-0 flex-col overflow-hidden border-r border-border lg:flex">
            <Sidebar
              base={base}
              condominioId={condominioId}
              name={home.condominio.name}
              logo={home.condominio.logo}
              userName={home.userName}
              userImage={home.userImage}
              incidentesCorporativos={incidentesCorporativos}
            />
          </aside>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <MobileHeader
              condominioId={condominioId}
              name={home.condominio.name}
              logo={home.condominio.logo}
            />
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-20 lg:pb-0">
              {/* Las solicitudes de cobertura del guarda, en cualquier página
                  de la portería. No sale si no hay nada pendiente. */}
              <SolicitudesCobertura />
              {/* Hasta cuándo cubre este conjunto, y el turno que dejó abierto
                  en el suyo, si lo hay. Solo sale en la portería que cubre. */}
              <AvisoCobertura condominioId={condominioId} cobertura={cobertura} />
              {/* El turno que dejó abierto en el conjunto que cubría, cuando la
                  cobertura ya terminó. En la que cubre lo muestra el aviso de
                  arriba. */}
              {!cubreAqui && <AvisoTurnoPendiente condominioId={condominioId} />}
              {children}
            </div>
            <MobileBottomNav
              base={base}
              userName={home.userName}
              userImage={home.userImage}
              incidentesCorporativos={incidentesCorporativos}
            />
          </div>
        </div>

        <CambiarClaveTemporalModal />
        <RecordatorioCierreTurno
          condominioId={condominioId}
          userId={home.userId}
          nombre={home.userName}
          activo={recordatorioCierre}
        />
        {/* `MobileBottomNav` es `lg:hidden`: por debajo de lg el botón se sube. */}
        <WhatsappFab condominioId={condominioId} bottomNav="lg" />
      </div>
    </BrandThemeProvider>
  );
}

function TurnoChip({ condominioId }: { condominioId: Id<"condominios"> }) {
  const turno = useQuery(api.guardia.turnoActivo, { condominioId });
  if (turno === undefined) return null;
  const abierto = turno !== null;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold",
        abierto
          ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
          : "bg-muted text-muted-foreground",
      )}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          abierto ? "animate-pulse bg-emerald-500" : "bg-muted-foreground/50",
        )}
      />
      {abierto ? "Turno abierto" : "Sin turno"}
    </span>
  );
}

function Sidebar({
  base,
  condominioId,
  name,
  logo,
  userName,
  userImage,
  incidentesCorporativos,
}: {
  base: string;
  condominioId: Id<"condominios">;
  name: string;
  logo: string | null;
  userName: string;
  userImage?: string | null;
  incidentesCorporativos: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();

  async function signOut() {
    await authClient.signOut();
    router.replace("/login");
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-card">
      <div className="flex h-16 shrink-0 items-center gap-3 border-b border-border/80 px-3">
        {logo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={logo}
            alt={name}
            className="h-9 w-9 rounded-[11px] object-cover ring-1 ring-border"
          />
        ) : (
          <div className="flex h-9 w-9 items-center justify-center rounded-[11px] bg-brand text-[11px] font-bold text-brand-foreground">
            {initials(name)}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold tracking-tight text-foreground">
            {name}
          </p>
          <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <ShieldCheck className="h-3 w-3" /> Seguridad
          </p>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 px-3 py-3">
        <div className="px-0.5">
          <TurnoChip condominioId={condominioId} />
        </div>

        <nav className="scrollbar-none min-h-0 flex-1 overflow-y-auto">
          <p className="mb-0.5 px-2.5 text-[10px] font-normal uppercase tracking-[0.06em] text-muted-foreground/70">
            Operación
          </p>
          <div className="flex flex-col gap-px">
            {NAV.filter((item) => incidentesCorporativos || item.segment !== "incidentes").map((item) => {
              const href = item.segment ? `${base}/${item.segment}` : base;
              const active = item.segment
                ? pathname === href || pathname.startsWith(`${href}/`)
                : pathname === base;
              const Icon = item.icon;
              return (
                <Link
                  key={item.label}
                  href={href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "group flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13px] font-normal tracking-[-0.01em] transition-colors",
                    active
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                  )}
                >
                  <Icon
                    className={cn(
                      "h-3.75 w-3.75 shrink-0 stroke-2",
                      active
                        ? "text-brand"
                        : "text-foreground/45 group-hover:text-foreground/70",
                    )}
                    aria-hidden
                  />
                  <span className="truncate">{item.label}</span>
                </Link>
              );
            })}
          </div>
        </nav>

        <div className="mt-auto shrink-0 border-t border-border/80 pt-3">
          <div className="flex items-center gap-2.5 rounded-xl px-2 py-2">
            {userImage ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={userImage}
                alt={userName}
                className="h-8 w-8 rounded-full object-cover ring-1 ring-border"
              />
            ) : (
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-xs font-semibold text-foreground">
                {initials(userName)}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-foreground">
                {userName}
              </p>
              <p className="text-[11px] text-muted-foreground">
                Guardia en servicio
              </p>
            </div>
            <button
              type="button"
              onClick={signOut}
              aria-label="Cerrar sesión"
              className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function MobileHeader({
  condominioId,
  name,
  logo,
}: {
  condominioId: Id<"condominios">;
  name: string;
  logo: string | null;
}) {
  return (
    <header className="sticky top-0 z-30 border-b border-border/80 bg-card lg:hidden">
      <div className="flex h-14 items-center gap-3 px-4">
        {logo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={logo}
            alt={name}
            className="h-8 w-8 rounded-lg object-cover ring-1 ring-border"
          />
        ) : (
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand text-[10px] font-bold text-brand-foreground">
            {initials(name)}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-foreground">{name}</p>
          <p className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <ShieldCheck className="h-3 w-3" /> Seguridad
          </p>
        </div>
        <TurnoChip condominioId={condominioId} />
      </div>
    </header>
  );
}

function MobileBottomNav({
  base,
  userName,
  userImage,
  incidentesCorporativos,
}: {
  base: string;
  userName: string;
  userImage?: string | null;
  incidentesCorporativos: boolean;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);

  function isActive(segment: string) {
    const href = segment ? `${base}/${segment}` : base;
    return segment
      ? pathname === href || pathname.startsWith(`${href}/`)
      : pathname === base;
  }

  async function signOut() {
    await authClient.signOut();
    router.replace("/login");
  }

  return (
    <>
      <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-card lg:hidden">
        <div className="flex h-16 items-center justify-around gap-1 px-1">
          {NAV_MOBILE.map((item) => {
            const href = item.segment ? `${base}/${item.segment}` : base;
            const active = isActive(item.segment);
            const Icon = item.icon;
            return (
              <Link
                key={item.label}
                href={href}
                className={cn(
                  "flex h-13 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg transition-colors",
                  active
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground",
                )}
              >
                <Icon
                  className={cn("h-5 w-5", active && "text-brand")}
                  aria-hidden
                />
                <span className="w-full truncate text-center text-[10px] font-medium leading-none">
                  {item.label}
                </span>
              </Link>
            );
          })}
          <button
            type="button"
            onClick={() => setOpen(true)}
            className={cn(
              "flex h-13 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg",
              NAV_EXTRA.some((i) => isActive(i.segment))
                ? "bg-accent text-foreground"
                : "text-muted-foreground",
            )}
          >
            <LayoutGrid className="h-5 w-5" aria-hidden />
            <span className="text-[10px] font-medium leading-none">Más</span>
          </button>
        </div>
      </nav>

      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            aria-label="Cerrar menú"
            onClick={() => setOpen(false)}
          />
          <div className="absolute inset-x-0 bottom-0 rounded-t-2xl border border-border bg-card p-4 pb-8 shadow-lg">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                {userImage ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={userImage}
                    alt=""
                    className="h-7 w-7 rounded-full object-cover ring-1 ring-border"
                  />
                ) : null}
                <p className="truncate text-sm font-semibold text-foreground">
                  {userName} · Portería
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Cerrar"
                className="rounded-lg p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {NAV_EXTRA.filter((item) => incidentesCorporativos || item.segment !== "incidentes").map((item) => {
                const href = `${base}/${item.segment}`;
                const Icon = item.icon;
                return (
                  <Link
                    key={item.label}
                    href={href}
                    onClick={() => setOpen(false)}
                    className="flex items-center gap-2.5 rounded-xl border border-border p-3 text-sm font-medium text-foreground transition-colors hover:bg-accent/60"
                  >
                    <Icon className="h-5 w-5 text-brand" aria-hidden />{" "}
                    {item.label}
                  </Link>
                );
              })}
            </div>
            <button
              type="button"
              onClick={signOut}
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl border border-border py-2.5 text-sm font-medium text-red-600 transition-colors hover:bg-red-500/5 dark:text-red-400"
            >
              <LogOut className="h-4 w-4" /> Cerrar sesión
            </button>
          </div>
        </div>
      )}
    </>
  );
}
