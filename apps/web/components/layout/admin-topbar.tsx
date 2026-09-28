"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Bell,
  Upload,
  Plus,
  FileUp,
  Megaphone,
  Landmark,
  CalendarPlus,
  CalendarClock,
  Building2,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { QuickAccess } from "@/components/layout/quick-access";
import { useTopbarOverride } from "@/components/layout/admin-topbar-context";

function segmentFromPath(pathname: string, base: string): string {
  const rest = pathname.startsWith(base) ? pathname.slice(base.length) : "";
  return rest.replace(/^\//, "").split("/")[0] ?? "";
}

function CondoDefaultActions({
  segment,
  base,
}: {
  segment: string;
  base: string;
}) {
  switch (segment) {
    case "":
      return (
        <>
          <Button
            variant="outline"
            size="icon"
            className="hidden rounded-[10px] sm:inline-flex"
            aria-label="Notificaciones"
            type="button"
          >
            <Bell className="h-4 w-4" />
          </Button>
          <Button variant="brand" asChild>
            <Link href={`${base}/finanzas`}>
              <Upload className="h-3.75 w-3.75" aria-hidden />
              Cargar facturas
            </Link>
          </Button>
        </>
      );
    case "unidades":
      return <DefaultCreate href={`${base}/unidades?nuevo=1`} icon={Building2} label="Nueva unidad" />;
    case "residentes":
      return <DefaultCreate href={`${base}/residentes?nuevo=1`} icon={UserPlus} label="Nuevo residente" />;
    case "vehiculos":
      return <DefaultCreate href={`${base}/vehiculos?nuevo=1`} icon={Plus} label="Registrar vehículo" />;
    case "documentos":
      return <DefaultCreate href={`${base}/documentos?nuevo=1`} icon={FileUp} label="Subir documento" />;
    case "comunicacion":
      return <DefaultCreate href={`${base}/comunicacion?nuevo=1`} icon={Megaphone} label="Nuevo comunicado" />;
    case "reservas":
      return <DefaultCreate href={`${base}/reservas?nuevo=1`} icon={CalendarPlus} label="Nueva reserva" />;
    case "asamblea":
      return <DefaultCreate href={`${base}/asamblea?nuevo=1`} icon={Landmark} label="Nueva asamblea" />;
    case "finanzas":
      return (
        <Button variant="brand" asChild>
          <Link href={`${base}/finanzas`}>
            <Upload className="h-3.75 w-3.75" aria-hidden />
            Cargar facturas
          </Link>
        </Button>
      );
    default:
      return null;
  }
}

function PlatformDefaultActions({ segment }: { segment: string }) {
  switch (segment) {
    case "":
      return (
        <DefaultCreate
          href="/dashboard/condominios?nuevo=1"
          icon={Building2}
          label="Nuevo condominio"
        />
      );
    case "condominios":
      return (
        <DefaultCreate
          href="/dashboard/condominios?nuevo=1"
          icon={Plus}
          label="Nuevo condominio"
        />
      );
    case "administradores":
      return (
        <DefaultCreate
          href="/dashboard/administradores?nuevo=1"
          icon={UserPlus}
          label="Agregar administrador"
        />
      );
    case "automatizaciones":
      return (
        <DefaultCreate
          href="/dashboard/automatizaciones?nuevo=1"
          icon={CalendarClock}
          label="Programar envío"
        />
      );
    case "soporte":
      return null;
    default:
      return null;
  }
}

function DefaultCreate({
  href,
  icon: Icon,
  label,
}: {
  href: string;
  icon: LucideIcon;
  label: string;
}) {
  return (
    <Button variant="brand" asChild>
      <Link href={href}>
        <Icon className="h-3.75 w-3.75" aria-hidden />
        {label}
      </Link>
    </Button>
  );
}

export function AdminTopbar({
  base,
  roles = [],
  isPlatform = false,
  variant = "condo",
}: {
  base: string;
  roles?: string[];
  isPlatform?: boolean;
  variant?: "condo" | "platform";
}) {
  const pathname = usePathname();
  const override = useTopbarOverride();
  const segment = segmentFromPath(pathname, base);

  return (
    <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border/80 bg-card/95 px-4 backdrop-blur-xl sm:h-16 sm:gap-4 sm:px-7 supports-backdrop-filter:bg-card/90">
      <div className="min-w-0 flex-1">
        <QuickAccess
          base={base}
          roles={roles}
          isPlatform={isPlatform}
          variant={variant}
        />
      </div>
      <div className="flex shrink-0 items-center gap-2 sm:gap-2.5">
        {override ??
          (variant === "platform" ? (
            <PlatformDefaultActions segment={segment} />
          ) : (
            <CondoDefaultActions segment={segment} base={base} />
          ))}
      </div>
    </header>
  );
}
