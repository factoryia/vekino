"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery, useMutation } from "convex/react";
import {
  Building2,
  X,
  ChevronRight,
  UserPlus,
  ExternalLink,
  Pencil,
} from "lucide-react";
import { api } from "@vekino/backend/api";
import type { Id } from "@vekino/backend/dataModel";
import { PageContainer } from "@/components/layout/page-container";
import { PageHeader } from "@/components/layout/page-header";
import { useNuevoQuery } from "@/hooks/use-nuevo-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { UserAvatar } from "@/components/ui/user-avatar";
import { EditCondoDialog } from "@/components/dashboard/edit-condo-dialog";
import { ManageCondoAdminsDialog } from "@/components/dashboard/manage-condo-admins-dialog";
import { cn, initials } from "@/lib/utils";

type CondoRow = NonNullable<
  ReturnType<typeof useQuery<typeof api.condominios.listAll>>
>[number];

export default function CondominiosPage() {
  const me = useQuery(api.users.me);
  const isPlatform =
    me?.platformRole === "superadmin" || me?.platformRole === "admin";
  const condominios = useQuery(
    api.condominios.listAll,
    isPlatform ? {} : "skip",
  );
  const [showCreate, setShowCreate] = useState(false);
  const [adminsFor, setAdminsFor] = useState<{
    id: Id<"condominios">;
    name: string;
  } | null>(null);
  const [editFor, setEditFor] = useState<CondoRow | null>(null);
  useNuevoQuery(() => setShowCreate(true));

  if (me === undefined) {
    return (
      <PageContainer>
        <p className="text-sm text-muted-foreground">Cargando…</p>
      </PageContainer>
    );
  }

  if (!isPlatform) {
    return (
      <PageContainer>
        <p className="text-sm text-muted-foreground">
          No tienes acceso a esta sección.
        </p>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <div className="space-y-6">
        <PageHeader
          title="Condominios"
          description="Gestiona conjuntos, marca y administradores de cada condominio."
        />

        <Card className="overflow-hidden p-0">
          {condominios === undefined ? (
            <p className="p-6 text-sm text-muted-foreground">Cargando…</p>
          ) : condominios.length === 0 ? (
            <div className="p-10 text-center">
              <Building2 className="mx-auto mb-2 h-8 w-8 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">
                Aún no hay condominios. Crea el primero.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-180 text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="px-5 py-3 font-medium">Condominio</th>
                    <th className="px-5 py-3 font-medium">Marca</th>
                    <th className="px-5 py-3 font-medium">Administradores</th>
                    <th className="px-5 py-3 font-medium">Plan</th>
                    <th className="px-5 py-3 font-medium">Estado</th>
                    <th className="px-5 py-3 text-right font-medium">Acción</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {condominios.map((c) => (
                    <CondominioRow
                      key={c._id}
                      c={c}
                      onManageAdmins={() =>
                        setAdminsFor({ id: c._id, name: c.name })
                      }
                      onEdit={() => setEditFor(c)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      {showCreate && <CreateDialog onClose={() => setShowCreate(false)} />}
      {adminsFor && (
        <ManageCondoAdminsDialog
          condominioId={adminsFor.id}
          condominioName={adminsFor.name}
          onClose={() => setAdminsFor(null)}
        />
      )}
      {editFor && (
        <EditCondoDialog
          condominioId={editFor._id}
          initial={{
            name: editFor.name,
            city: editFor.city,
            nit: editFor.nit,
            address: editFor.address,
            subdomain: editFor.subdomain,
            logo: editFor.logo,
            coverImage: editFor.coverImage,
            primaryColor: editFor.primaryColor,
            subscriptionPlan: editFor.subscriptionPlan as
              | "basico"
              | "pro"
              | "enterprise"
              | null
              | undefined,
            unitLimit: editFor.unitLimit,
            avalPortalUrl: editFor.avalPortalUrl,
            avalNura: editFor.avalNura,
            activeModules: editFor.activeModules,
          }}
          onClose={() => setEditFor(null)}
        />
      )}
    </PageContainer>
  );
}

function CondoMark({
  name,
  logo,
  color,
}: {
  name: string;
  logo?: string | null;
  color?: string | null;
}) {
  const bg = color || "#F6560B";
  if (logo) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={logo}
        alt=""
        className="h-10 w-10 shrink-0 rounded-[11px] border border-border object-cover"
      />
    );
  }
  return (
    <div
      className="grid h-10 w-10 shrink-0 place-items-center rounded-[11px] text-[11px] font-semibold text-white"
      style={{ backgroundColor: bg }}
      title={bg}
    >
      {initials(name)}
    </div>
  );
}

function CondominioRow({
  c,
  onManageAdmins,
  onEdit,
}: {
  c: CondoRow;
  onManageAdmins: () => void;
  onEdit: () => void;
}) {
  const setActive = useMutation(api.condominios.setActive);
  const [busy, setBusy] = useState(false);

  async function toggle() {
    setBusy(true);
    try {
      await setActive({ condominioId: c._id, isActive: !c.isActive });
    } finally {
      setBusy(false);
    }
  }

  const adminCount = c.admins.length;

  return (
    <tr className="hover:bg-accent/30">
      <td className="px-5 py-3.5">
        <Link
          href={`/dashboard/condominios/${c._id}`}
          className="group flex items-center gap-3"
        >
          <CondoMark name={c.name} logo={c.logo} color={c.primaryColor} />
          <div className="min-w-0">
            <p className="truncate font-medium text-foreground group-hover:text-brand">
              {c.name}
              <ChevronRight className="ml-0.5 inline h-3.5 w-3.5 text-muted-foreground/50" />
            </p>
            <p className="truncate text-[11px] text-muted-foreground">
              {[c.city, `${c.memberCount} miembros`]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
        </Link>
      </td>

      <td className="px-5 py-3.5">
        <div className="flex items-center gap-2">
          <span
            className="h-5 w-5 shrink-0 rounded-md border border-border shadow-soft"
            style={{ backgroundColor: c.primaryColor ?? "#E3E6E3" }}
            title={c.primaryColor ?? "Sin color"}
          />
          <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
            {c.primaryColor ?? "—"}
          </span>
        </div>
      </td>

      <td className="px-5 py-3.5">
        <button
          type="button"
          onClick={onManageAdmins}
          className="group inline-flex max-w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-accent"
        >
          {adminCount === 0 ? (
            <>
              <span className="grid h-7 w-7 place-items-center rounded-full border border-dashed border-border text-muted-foreground">
                <UserPlus className="h-3.5 w-3.5" />
              </span>
              <span className="text-xs font-medium text-brand">Asignar</span>
            </>
          ) : (
            <>
              <span className="flex -space-x-2">
                {c.admins.slice(0, 3).map((a) => (
                  <UserAvatar
                    key={a._id}
                    name={a.name}
                    image={a.image}
                    size="sm"
                    className="ring-2 ring-card"
                  />
                ))}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[12.5px] font-medium text-foreground group-hover:text-brand">
                  {adminCount} admin{adminCount === 1 ? "" : "s"}
                </span>
                <span className="block truncate text-[10.5px] text-muted-foreground">
                  Gestionar
                </span>
              </span>
            </>
          )}
        </button>
      </td>

      <td className="px-5 py-3.5 capitalize text-muted-foreground">
        {c.subscriptionPlan ?? "—"}
      </td>

      <td className="px-5 py-3.5">
        <Badge tone={c.isActive ? "success" : "neutral"}>
          {c.isActive ? "Activo" : "Inactivo"}
        </Badge>
      </td>

      <td className="px-5 py-3.5 text-right">
        <div className="inline-flex items-center gap-2">
          <button
            type="button"
            onClick={onEdit}
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label={`Editar ${c.name}`}
          >
            <Pencil className="h-3.5 w-3.5" />
            Editar
          </button>
          <Button variant="secondary" size="sm" asChild>
            <Link href={`/condominio/${c._id}`}>
              <ExternalLink className="h-3.5 w-3.5" />
              Abrir
            </Link>
          </Button>
          <button
            type="button"
            onClick={toggle}
            disabled={busy}
            className={cn(
              "text-xs font-medium hover:underline disabled:opacity-50",
              c.isActive ? "text-muted-foreground" : "text-brand",
            )}
          >
            {c.isActive ? "Desactivar" : "Activar"}
          </button>
        </div>
      </td>
    </tr>
  );
}

function CreateDialog({ onClose }: { onClose: () => void }) {
  const create = useMutation(api.condominios.create);
  const update = useMutation(api.condominios.update);
  const [name, setName] = useState("");
  const [city, setCity] = useState("");
  const [nit, setNit] = useState("");
  const [primaryColor, setPrimaryColor] = useState("#F6560B");
  const [plan, setPlan] = useState<"basico" | "pro" | "enterprise">("basico");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const id = await create({
        name: name.trim(),
        city: city.trim() || undefined,
        nit: nit.trim() || undefined,
        subscriptionPlan: plan,
      });
      if (primaryColor) {
        await update({
          condominioId: id,
          patch: { primaryColor },
        });
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al crear");
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/40 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-floating">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-foreground">
            Nuevo condominio
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-muted-foreground hover:bg-accent"
            aria-label="Cerrar"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <form onSubmit={submit} className="space-y-3.5">
          <Field label="Nombre" value={name} onChange={setName} required />
          <Field label="Ciudad" value={city} onChange={setCity} />
          <Field label="NIT" value={nit} onChange={setNit} />
          <div>
            <label className="text-sm font-medium text-foreground">
              Color de marca
            </label>
            <div className="mt-1.5 flex items-center gap-2">
              <input
                type="color"
                value={primaryColor}
                onChange={(e) => setPrimaryColor(e.target.value)}
                className="h-10 w-12 cursor-pointer rounded-lg border border-border bg-background p-1"
              />
              <input
                value={primaryColor}
                onChange={(e) => setPrimaryColor(e.target.value)}
                className="flex-1 rounded-lg border border-border bg-background px-3 py-2.5 font-mono text-sm outline-none focus:ring-2 focus:ring-brand/30"
              />
            </div>
          </div>
          <div>
            <label className="text-sm font-medium text-foreground">Plan</label>
            <select
              value={plan}
              onChange={(e) =>
                setPlan(e.target.value as "basico" | "pro" | "enterprise")
              }
              className="mt-1.5 w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand/30"
            >
              <option value="basico">Básico</option>
              <option value="pro">Pro</option>
              <option value="enterprise">Enterprise</option>
            </select>
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <Button
            type="submit"
            variant="brand"
            className="w-full"
            disabled={loading || !name.trim()}
          >
            {loading ? "Creando…" : "Crear condominio"}
          </Button>
        </form>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  required,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
}) {
  return (
    <div>
      <label className="text-sm font-medium text-foreground">{label}</label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        className="mt-1.5 w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm text-foreground outline-none focus:ring-2 focus:ring-brand/30"
      />
    </div>
  );
}
