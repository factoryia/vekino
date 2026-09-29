"use client";

import { useCallback, useEffect, useRef, useState, Suspense } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "convex/react";
import { Boxes, Building2, FileText, LogOut, Menu, ShieldCheck, Users, X } from "lucide-react";
import { api } from "@vekino/backend/api";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/utils";

type Company = {
  id: string;
  name: string;
  logo?: string | null;
  isAdmin: boolean;
  userName: string;
};

export function CompanyNavigationShell({
  company,
  children,
}: {
  company: Company;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const close = useCallback(() => setOpen(false), []);
  const menuButton = useRef<HTMLButtonElement>(null);
  const drawer = useRef<HTMLDivElement>(null);

  useEffect(() => close(), [pathname, close]);
  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    drawer.current?.querySelector<HTMLButtonElement>("button")?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
      if (e.key !== "Tab" || !drawer.current) return;
      const focusable = Array.from(drawer.current.querySelectorAll<HTMLElement>("a, button"));
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (document.contains(previousFocus)) previousFocus?.focus();
    };
  }, [open, close]);

  return (
    <div className="font-admin flex h-dvh flex-col overflow-hidden bg-background lg:p-3.5">
      <div className="flex min-h-0 w-full flex-1 overflow-hidden bg-card lg:rounded-[18px] lg:border lg:border-border lg:shadow-soft">
        <aside className="hidden w-60 shrink-0 border-r border-border lg:block">
          <Suspense fallback={null}>
            <CompanySidebar company={company} />
          </Suspense>
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-card px-4 lg:hidden">
            <button ref={menuButton} type="button" onClick={() => setOpen(true)} aria-label="Abrir menú" aria-expanded={open} aria-controls="company-mobile-menu" className="rounded-lg p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground">
              <Menu className="h-5 w-5" />
            </button>
            <CompanyIdentity company={company} subtitle={pathname.startsWith("/dashboard/companias/") ? "Compañía" : pathname === "/vigilancia" ? "Mis conjuntos" : "Supervisión del conjunto"} />
          </header>
          <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</main>
        </div>
      </div>

      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-foreground/40 backdrop-blur-sm" onClick={close} aria-hidden="true" />
          <div ref={drawer} id="company-mobile-menu" className="absolute inset-y-0 left-0 w-[min(18rem,calc(100vw-2rem))] border-r border-border bg-card shadow-floating" role="dialog" aria-modal="true" aria-label="Menú de navegación">
            <button type="button" onClick={close} aria-label="Cerrar menú" className="absolute right-3 top-4 z-10 rounded-lg p-1.5 text-muted-foreground hover:bg-accent">
              <X className="h-5 w-5" />
            </button>
            <Suspense fallback={null}>
              <CompanySidebar company={company} onNavigate={close} />
            </Suspense>
          </div>
        </div>
      )}
    </div>
  );
}

function CompanyIdentity({ company, subtitle }: { company: Company; subtitle?: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      {company.logo ? (
        <Image src={company.logo} alt="" width={32} height={32} className="h-8 w-8 shrink-0 rounded-lg object-cover" />
      ) : (
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand">
          <ShieldCheck className="h-4 w-4" aria-hidden />
        </span>
      )}
      <div className="min-w-0">
        <p className="truncate text-[13px] font-medium text-foreground">{company.name}</p>
        <p className="truncate text-[11px] text-muted-foreground">{subtitle ?? (company.isAdmin ? "Administración" : "Supervisión")}</p>
      </div>
    </div>
  );
}

function CompanySidebar({ company, onNavigate }: { company: Company; onNavigate?: () => void }) {
  const pathname = usePathname();
  const search = useSearchParams();
  const router = useRouter();
  const team = useQuery(api.asignaciones.miEquipo);
  const companyPath = `/dashboard/companias/${company.id}`;
  const onCompanyPage = pathname === companyPath;
  const requestedTab = search.get("tab");
  const tab = requestedTab === "contratos" || requestedTab === "inventario" ? requestedTab : "personal";

  async function signOut() {
    onNavigate?.();
    await authClient.signOut();
    router.replace("/login");
  }

  const companyItems = [
    { label: "Personal", tab: "personal", icon: Users },
    { label: "Contratos", tab: "contratos", icon: FileText },
    { label: "Inventario", tab: "inventario", icon: Boxes },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <div className="flex h-16 shrink-0 items-center border-b border-border/80 px-3 pr-11 lg:pr-3">
        <CompanyIdentity company={company} />
      </div>
      <nav aria-label="Navegación de vigilancia" className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 py-4">
        <div className="space-y-0.5">
          <p className="px-2.5 pb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Operación</p>
          <NavLink href="/vigilancia" label="Mis conjuntos" icon={Building2} active={pathname === "/vigilancia"} onNavigate={onNavigate} />
          {team && team.length > 0 && (
            <div className="ml-4 space-y-0.5 border-l border-border pl-2">
              {team.map((c) => (
                <NavLink key={c.condominioId} href={`/vigilancia/${c.condominioId}`} label={c.condominioNombre} icon={ShieldCheck} active={pathname === `/vigilancia/${c.condominioId}`} onNavigate={onNavigate} />
              ))}
            </div>
          )}
        </div>
        {company.isAdmin && (
          <div className="space-y-0.5">
            <p className="px-2.5 pb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Compañía</p>
            {companyItems.map((item) => (
              <NavLink key={item.tab} href={`${companyPath}?tab=${item.tab}`} label={item.label} icon={item.icon} active={onCompanyPage && tab === item.tab} onNavigate={onNavigate} />
            ))}
          </div>
        )}
      </nav>
      <div className="shrink-0 border-t border-border/70 p-3">
        <p className="truncate px-2 text-[12.5px] text-foreground">{company.userName}</p>
        <p className="px-2 text-[10.5px] text-muted-foreground">{company.isAdmin ? "Admin de compañía" : "Supervisor"}</p>
        <button type="button" onClick={signOut} className="mt-2 flex w-full items-center gap-2 rounded-lg px-2 py-2 text-[13px] text-red-600 hover:bg-red-500/10 dark:text-red-400">
          <LogOut className="h-3.5 w-3.5" aria-hidden />Cerrar sesión
        </button>
      </div>
    </div>
  );
}

function NavLink({ href, label, icon: Icon, active, onNavigate }: { href: string; label: string; icon: typeof ShieldCheck; active: boolean; onNavigate?: () => void }) {
  return (
    <Link href={href} onClick={onNavigate} aria-current={active ? "page" : undefined} title={label} className={cn("group flex min-h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13px] transition-colors", active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground")}>
      <Icon className={cn("h-4 w-4 shrink-0", active ? "text-brand" : "text-foreground/45")} aria-hidden />
      <span className="truncate">{label}</span>
    </Link>
  );
}
