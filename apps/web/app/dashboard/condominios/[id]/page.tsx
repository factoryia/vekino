"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery, useMutation, useAction, usePaginatedQuery } from "convex/react";
import {
  ArrowLeft,
  Building2,
  Users,
  Home,
  Search,
  Pencil,
  Trash2,
  X,
  UserPlus,
  ExternalLink,
  KeyRound,
} from "lucide-react";
import { api } from "@vekino/backend/api";
import type { Id } from "@vekino/backend/dataModel";
import { PageContainer } from "@/components/layout/page-container";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { UserAvatar } from "@/components/ui/user-avatar";
import { CreateCondoAdminDialog } from "@/components/dashboard/create-condo-admin-dialog";
import { EditCondoDialog } from "@/components/dashboard/edit-condo-dialog";
import { SendCredentialsDialog } from "@/components/dashboard/send-credentials-dialog";
import { initials } from "@/lib/utils";

const PAGE_SIZE = 30;

const OPERATIONAL_ROLES = [
  "administrador",
  "propietario",
  "apoderado",
  "arrendatario",
  "residente",
  "contadora",
  "guardia",
  "junta_directiva",
  "representante_asamblea",
] as const;
type OpRole = (typeof OPERATIONAL_ROLES)[number];

const ROLE_LABEL: Record<string, string> = {
  administrador: "Administrador",
  propietario: "Propietario",
  apoderado: "Apoderado",
  arrendatario: "Arrendatario",
  residente: "Residente",
  contadora: "Contadora",
  guardia: "Guardia",
  junta_directiva: "Junta directiva",
  representante_asamblea: "Rep. asamblea",
};

const ROLE_COLOR: Record<string, string> = {
  administrador: "bg-brand/10 text-brand",
  propietario:
    "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400",
  apoderado:
    "bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-400",
  arrendatario:
    "bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-400",
  guardia:
    "bg-orange-50 text-orange-700 dark:bg-orange-500/10 dark:text-orange-400",
  contadora:
    "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400",
  junta_directiva:
    "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-400",
  representante_asamblea:
    "bg-fuchsia-50 text-fuchsia-700 dark:bg-fuchsia-500/10 dark:text-fuchsia-400",
};

export default function CondominioDetailPage() {
  const params = useParams<{ id: string }>();
  const condominioId = params.id as Id<"condominios">;
  const detail = useQuery(api.condominios.detail, { condominioId });
  const [tab, setTab] = useState<"usuarios" | "unidades">("usuarios");
  const [showCreateAdmin, setShowCreateAdmin] = useState(false);
  const [sendingCredentials, setSendingCredentials] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editingAdmin, setEditingAdmin] = useState<{
    userId: Id<"users">;
    name: string;
    email: string;
    telefono: string;
    roles: OpRole[];
  } | null>(null);
  const [removingAdmin, setRemovingAdmin] = useState<{
    membershipId: Id<"memberships">;
    name: string;
  } | null>(null);
  const [removingBusy, setRemovingBusy] = useState(false);
  const deactivate = useMutation(api.memberships.deactivate);

  if (detail === undefined)
    return (
      <PageContainer>
        <p className="text-sm text-muted-foreground">Cargando…</p>
      </PageContainer>
    );
  if (detail === null)
    return (
      <PageContainer>
        <p className="text-sm text-muted-foreground">Condominio no encontrado.</p>
      </PageContainer>
    );

  const c = detail.condominio;
  const brand = c.primaryColor ?? "#F6560B";

  return (
    <PageContainer>
      <Link
        href="/dashboard/condominios"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Condominios
      </Link>

      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-4">
          {c.logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={c.logo}
              alt={c.name}
              className="h-14 w-14 shrink-0 rounded-2xl border border-border object-cover"
            />
          ) : (
            <div
              className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl text-sm font-semibold text-white"
              style={{ backgroundColor: brand }}
            >
              {initials(c.name)}
            </div>
          )}
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">
                {c.name}
              </h1>
              <Badge tone={c.isActive ? "success" : "neutral"}>
                {c.isActive ? "Activo" : "Inactivo"}
              </Badge>
            </div>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {[c.city, c.nit && `NIT ${c.nit}`].filter(Boolean).join(" · ") ||
                "Sin datos institucionales"}
            </p>
            <div className="mt-2 flex items-center gap-2">
              <span
                className="h-4 w-4 rounded-md border border-border"
                style={{ backgroundColor: brand }}
              />
              <span className="font-mono text-[11px] text-muted-foreground">
                {c.primaryColor ?? "Sin color"}
              </span>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            type="button"
            onClick={() => setEditing(true)}
          >
            <Pencil className="h-3.5 w-3.5" />
            Editar
          </Button>
          <Button variant="secondary" size="sm" asChild>
            <Link href={`/condominio/${c._id}`}>
              <ExternalLink className="h-3.5 w-3.5" />
              Abrir panel
            </Link>
          </Button>
          <Button
            variant="secondary"
            size="sm"
            type="button"
            onClick={() => setSendingCredentials(true)}
          >
            <KeyRound className="h-3.5 w-3.5" />
            Enviar credenciales por correo
          </Button>
          <Button
            variant="brand"
            size="sm"
            type="button"
            onClick={() => setShowCreateAdmin(true)}
          >
            <UserPlus className="h-3.5 w-3.5" />
            Nuevo administrador
          </Button>
        </div>
      </div>

      {c.coverImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={c.coverImage}
          alt={`Foto de ${c.name}`}
          className="mb-6 h-40 w-full rounded-2xl border border-border object-cover"
        />
      ) : null}

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat icon={Users} label="Miembros" value={detail.memberCount} />
        <Stat icon={Home} label="Unidades" value={detail.unidadCount} />
        <Stat label="Plan" text={c.subscriptionPlan ?? "—"} />
        <Stat label="Admins" value={detail.admins.length} />
      </div>

      <Card className="mb-6 p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-foreground">
              Administradores del condominio
            </p>
            <p className="text-xs text-muted-foreground">
              Usuarios con rol operativo de administrador
            </p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            type="button"
            onClick={() => setShowCreateAdmin(true)}
          >
            <UserPlus className="h-3.5 w-3.5" />
            Agregar
          </Button>
        </div>
        {detail.admins.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            Este conjunto aún no tiene administrador. Crea uno para que puedan
            operar el panel.
          </p>
        ) : (
          <ul className="divide-y divide-border/60">
            {detail.admins.map((a) => (
              <li
                key={a._id}
                className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0"
              >
                <UserAvatar name={a.name} image={a.image} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">
                    {a.name}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {a.email}
                    {a.telefono ? ` · ${a.telefono}` : ""}
                  </p>
                </div>
                <Badge tone="brand">Administrador</Badge>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() =>
                      setEditingAdmin({
                        userId: a._id,
                        name: a.name,
                        email: a.email,
                        telefono: a.telefono ?? "",
                        roles: a.roles as OpRole[],
                      })
                    }
                    className="rounded-lg p-1.5 text-muted-foreground hover:bg-accent hover:text-brand"
                    aria-label={`Editar ${a.name}`}
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setRemovingAdmin({
                        membershipId: a.membershipId,
                        name: a.name,
                      })
                    }
                    className="rounded-lg p-1.5 text-muted-foreground hover:bg-accent hover:text-red-600"
                    aria-label={`Quitar ${a.name}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="mb-5 flex gap-1 border-b border-border">
        <Tab active={tab === "usuarios"} onClick={() => setTab("usuarios")}>
          Usuarios
        </Tab>
        <Tab active={tab === "unidades"} onClick={() => setTab("unidades")}>
          Unidades
        </Tab>
      </div>

      {tab === "usuarios" ? (
        <UsuariosTab condominioId={condominioId} />
      ) : (
        <UnidadesTab condominioId={condominioId} />
      )}

      {showCreateAdmin && (
        <CreateCondoAdminDialog
          condominioId={condominioId}
          condominioName={c.name}
          onClose={() => setShowCreateAdmin(false)}
        />
      )}

      {sendingCredentials && (
        <SendCredentialsDialog
          condominioId={condominioId}
          condominioName={c.name}
          onClose={() => setSendingCredentials(false)}
        />
      )}

      {editing && (
        <EditCondoDialog
          condominioId={condominioId}
          initial={{
            name: c.name,
            city: c.city,
            nit: c.nit,
            address: c.address,
            subdomain: c.subdomain,
            logo: c.logo,
            coverImage: c.coverImage,
            primaryColor: c.primaryColor,
            subscriptionPlan: c.subscriptionPlan as
              | "basico"
              | "pro"
              | "enterprise"
              | null
              | undefined,
            unitLimit: c.unitLimit,
            avalPortalUrl: c.avalPortalUrl,
            avalNura: c.avalNura,
            activeModules: c.activeModules,
          }}
          onClose={() => setEditing(false)}
        />
      )}

      {editingAdmin && (
        <EditUserDialog
          condominioId={condominioId}
          userId={editingAdmin.userId}
          email={editingAdmin.email}
          initialName={editingAdmin.name}
          initialTelefono={editingAdmin.telefono}
          initialRoles={editingAdmin.roles}
          onClose={() => setEditingAdmin(null)}
        />
      )}

      {removingAdmin && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/40 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-floating">
            <h2 className="text-lg font-semibold text-foreground">
              Quitar administrador
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              ¿Quitar a{" "}
              <span className="font-medium text-foreground">
                {removingAdmin.name}
              </span>{" "}
              de este condominio? No se borra su cuenta, solo el acceso aquí.
            </p>
            <div className="mt-5 flex gap-2">
              <Button
                type="button"
                variant="secondary"
                className="flex-1"
                onClick={() => setRemovingAdmin(null)}
                disabled={removingBusy}
              >
                Cancelar
              </Button>
              <Button
                type="button"
                className="flex-1 bg-red-600 text-white hover:bg-red-700"
                disabled={removingBusy}
                onClick={async () => {
                  setRemovingBusy(true);
                  try {
                    await deactivate({
                      membershipId: removingAdmin.membershipId,
                    });
                    setRemovingAdmin(null);
                  } finally {
                    setRemovingBusy(false);
                  }
                }}
              >
                {removingBusy ? "Quitando…" : "Quitar"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </PageContainer>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  text,
}: {
  icon?: typeof Building2;
  label: string;
  value?: number;
  text?: string;
}) {
  return (
    <Card className="p-3.5">
      <p className="text-[11px] font-medium text-muted-foreground">{label}</p>
      <div className="mt-1 flex items-center gap-2">
        {Icon && <Icon className="h-4 w-4 text-brand" />}
        <p className="text-lg font-semibold tabular-nums capitalize text-foreground">
          {text ?? value ?? "—"}
        </p>
      </div>
    </Card>
  );
}

function Tab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`-mb-px border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
        active
          ? "border-brand text-brand"
          : "border-transparent text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

function useDebounced(value: string, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function UsuariosTab({ condominioId }: { condominioId: Id<"condominios"> }) {
  const deactivate = useMutation(api.memberships.deactivate);
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<OpRole | "">("");
  const deferredQ = useDebounced(search, 280);
  const [editing, setEditing] = useState<{
    userId: Id<"users">;
    name: string;
    email: string;
    telefono: string;
    roles: OpRole[];
  } | null>(null);
  const [removing, setRemoving] = useState<{
    membershipId: Id<"memberships">;
    name: string;
  } | null>(null);
  const [removingBusy, setRemovingBusy] = useState(false);

  const { results, status, loadMore } = usePaginatedQuery(
    api.memberships.listPage,
    {
      condominioId,
      q: deferredQ.trim() || undefined,
      role: roleFilter || undefined,
    },
    { initialNumItems: PAGE_SIZE },
  );

  const rows = results.filter((m) => m.isActive);
  const hasFilters = Boolean(deferredQ.trim() || roleFilter);
  const loading = status === "LoadingFirstPage";
  const canLoadMore = status === "CanLoadMore";
  const loadingMore = status === "LoadingMore";

  async function confirmRemove() {
    if (!removing) return;
    setRemovingBusy(true);
    try {
      await deactivate({ membershipId: removing.membershipId });
      setRemoving(null);
    } finally {
      setRemovingBusy(false);
    }
  }

  return (
    <>
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
        <select
          value={roleFilter}
          onChange={(e) => setRoleFilter(e.target.value as OpRole | "")}
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-brand/30 sm:w-48"
        >
          <option value="">Todos los roles</option>
          {OPERATIONAL_ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </select>
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nombre o correo"
            className="w-full rounded-lg border border-border bg-background py-2 pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-brand/30"
          />
        </div>
      </div>

      <Card className="overflow-hidden p-0">
        {loading ? (
          <p className="p-6 text-sm text-muted-foreground">Cargando usuarios…</p>
        ) : rows.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">
            {hasFilters ? "Sin resultados." : "Sin usuarios."}
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="px-5 py-3 font-medium">Usuario</th>
                <th className="px-5 py-3 font-medium">Correo</th>
                <th className="px-5 py-3 font-medium">Roles</th>
                <th className="px-5 py-3 text-right font-medium">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {rows.map((m) => (
                <tr key={m.membershipId} className="hover:bg-accent/30">
                  <td className="px-5 py-3 font-medium text-foreground">
                    {m.name ?? "—"}
                  </td>
                  <td className="px-5 py-3 text-muted-foreground">
                    {m.email ?? "—"}
                  </td>
                  <td className="px-5 py-3">
                    <RoleBadges roles={m.roles} />
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          setEditing({
                            userId: m.userId,
                            name: m.name ?? "",
                            email: m.email ?? "",
                            telefono: m.telefono ?? "",
                            roles: m.roles as OpRole[],
                          })
                        }
                        className="text-muted-foreground hover:text-brand"
                        aria-label="Editar usuario"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setRemoving({
                            membershipId: m.membershipId,
                            name: m.name ?? m.email ?? "este usuario",
                          })
                        }
                        className="text-muted-foreground hover:text-red-600"
                        aria-label="Eliminar usuario"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {(canLoadMore || loadingMore) && (
        <div className="mt-3 flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {rows.length}
            {!hasFilters ? "+" : ""} usuarios
          </p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => loadMore(PAGE_SIZE)}
            disabled={loadingMore}
          >
            {loadingMore ? "Cargando…" : "Cargar más"}
          </Button>
        </div>
      )}

      {!canLoadMore && !loadingMore && rows.length > 0 && (
        <p className="mt-3 text-xs text-muted-foreground">
          {rows.length} usuarios
        </p>
      )}

      {editing && (
        <EditUserDialog
          condominioId={condominioId}
          userId={editing.userId}
          email={editing.email}
          initialName={editing.name}
          initialTelefono={editing.telefono}
          initialRoles={editing.roles}
          onClose={() => setEditing(null)}
        />
      )}

      {removing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/40 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-floating">
            <h2 className="text-lg font-semibold text-foreground">
              Eliminar usuario
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              ¿Quitar a{" "}
              <span className="font-medium text-foreground">{removing.name}</span>{" "}
              de este condominio? No se borra su cuenta global, solo el acceso
              aquí.
            </p>
            <div className="mt-5 flex gap-2">
              <Button
                type="button"
                variant="secondary"
                className="flex-1"
                onClick={() => setRemoving(null)}
                disabled={removingBusy}
              >
                Cancelar
              </Button>
              <Button
                type="button"
                className="flex-1 bg-red-600 text-white hover:bg-red-700"
                onClick={confirmRemove}
                disabled={removingBusy}
              >
                {removingBusy ? "Eliminando…" : "Eliminar"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function RoleBadges({ roles }: { roles: string[] }) {
  if (roles.length === 0)
    return <span className="text-xs text-muted-foreground">Sin rol</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {roles.map((r) => (
        <span
          key={r}
          className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${
            ROLE_COLOR[r] ?? "bg-muted text-muted-foreground"
          }`}
        >
          {ROLE_LABEL[r] ?? r}
        </span>
      ))}
    </div>
  );
}

function EditUserDialog({
  condominioId,
  userId,
  email,
  initialName,
  initialTelefono,
  initialRoles,
  onClose,
}: {
  condominioId: Id<"condominios">;
  userId: Id<"users">;
  email: string;
  initialName: string;
  initialTelefono: string;
  initialRoles: OpRole[];
  onClose: () => void;
}) {
  const updateMember = useMutation(api.memberships.updateMember);
  const setPassword = useAction(api.users.setMemberPassword);
  const [name, setName] = useState(initialName);
  const [telefono, setTelefono] = useState(initialTelefono);
  const [selected, setSelected] = useState<Set<OpRole>>(new Set(initialRoles));
  const [password, setPasswordValue] = useState("");
  const [password2, setPassword2] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(r: OpRole) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(r)) next.delete(r);
      else next.add(r);
      return next;
    });
  }

  async function save() {
    setError(null);
    if (!name.trim()) {
      setError("El nombre es obligatorio.");
      return;
    }
    if (password || password2) {
      if (password.length < 8) {
        setError("La contraseña debe tener al menos 8 caracteres.");
        return;
      }
      if (password !== password2) {
        setError("Las contraseñas no coinciden.");
        return;
      }
    }

    setBusy(true);
    try {
      await updateMember({
        condominioId,
        userId,
        name: name.trim(),
        telefono,
        roles: [...selected],
      });
      if (password) {
        await setPassword({ condominioId, userId, password });
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/40 p-4 backdrop-blur-sm">
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-border bg-card p-6 shadow-floating">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-foreground">
            Editar usuario
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
        <p className="mb-5 text-sm text-muted-foreground">
          {email || "Sin correo"}
        </p>

        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium text-foreground">Nombre</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1.5 w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand/30"
            />
          </div>
          <div>
            <label className="text-sm font-medium text-foreground">
              Teléfono
            </label>
            <input
              value={telefono}
              onChange={(e) => setTelefono(e.target.value)}
              placeholder="Opcional"
              className="mt-1.5 w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand/30"
            />
          </div>

          <div>
            <p className="mb-2 text-sm font-medium text-foreground">Roles</p>
            <div className="grid grid-cols-2 gap-2">
              {OPERATIONAL_ROLES.map((r) => {
                const on = selected.has(r);
                return (
                  <button
                    key={r}
                    type="button"
                    onClick={() => toggle(r)}
                    className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                      on
                        ? "border-brand bg-brand/5 font-medium text-brand"
                        : "border-border text-muted-foreground hover:bg-accent"
                    }`}
                  >
                    <span
                      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                        on ? "border-brand bg-brand" : "border-border"
                      }`}
                    >
                      {on && <span className="text-[10px] text-white">✓</span>}
                    </span>
                    {ROLE_LABEL[r]}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="border-t border-border pt-2">
            <p className="mb-1 text-sm font-medium text-foreground">
              Nueva contraseña
            </p>
            <p className="mb-2 text-xs text-muted-foreground">
              Déjalo vacío si no quieres cambiarla.
            </p>
            <div className="space-y-2">
              <input
                type="password"
                value={password}
                onChange={(e) => setPasswordValue(e.target.value)}
                placeholder="Nueva contraseña"
                autoComplete="new-password"
                className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand/30"
              />
              <input
                type="password"
                value={password2}
                onChange={(e) => setPassword2(e.target.value)}
                placeholder="Confirmar contraseña"
                autoComplete="new-password"
                className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand/30"
              />
            </div>
          </div>
        </div>

        {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

        <Button
          type="button"
          variant="brand"
          className="mt-5 w-full"
          onClick={save}
          disabled={busy}
        >
          {busy ? "Guardando…" : "Guardar cambios"}
        </Button>
      </div>
    </div>
  );
}

function UnidadesTab({ condominioId }: { condominioId: Id<"condominios"> }) {
  const [search, setSearch] = useState("");
  const deferredQ = useDebounced(search, 280);

  const { results, status, loadMore } = usePaginatedQuery(
    api.unidades.listPage,
    {
      condominioId,
      q: deferredQ.trim() || undefined,
    },
    { initialNumItems: PAGE_SIZE },
  );

  const term = deferredQ.trim();
  const loading = status === "LoadingFirstPage";
  const canLoadMore = status === "CanLoadMore";
  const loadingMore = status === "LoadingMore";

  return (
    <>
      <div className="mb-3 flex items-center justify-end">
        <div className="relative w-72 max-w-full">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por unidad o residente"
            className="w-full rounded-lg border border-border bg-background py-2 pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-brand/30"
          />
        </div>
      </div>

      <Card className="overflow-hidden p-0">
        {loading ? (
          <p className="p-6 text-sm text-muted-foreground">Cargando unidades…</p>
        ) : results.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">
            {term ? "Sin resultados." : "Sin unidades."}
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="px-5 py-3 font-medium">Unidad</th>
                <th className="px-5 py-3 font-medium">Tipo</th>
                <th className="px-5 py-3 font-medium">Estado</th>
                <th className="px-5 py-3 font-medium">Residentes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {results.map((u) => (
                <tr key={u._id} className="hover:bg-accent/30">
                  <td className="px-5 py-3 font-medium text-foreground">
                    {[u.torre, u.numero].filter(Boolean).join(" · ")}
                  </td>
                  <td className="px-5 py-3 capitalize text-muted-foreground">
                    {u.tipo ?? "—"}
                  </td>
                  <td className="px-5 py-3 capitalize text-muted-foreground">
                    {u.estado ?? "—"}
                  </td>
                  <td className="px-5 py-3 text-muted-foreground">
                    {u.residentes.length === 0
                      ? "—"
                      : u.residentes
                          .map((r) => r.name)
                          .filter(Boolean)
                          .join(", ") || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {(canLoadMore || loadingMore) && (
        <div className="mt-3 flex justify-end">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => loadMore(PAGE_SIZE)}
            disabled={loadingMore}
          >
            {loadingMore ? "Cargando…" : "Cargar más"}
          </Button>
        </div>
      )}
    </>
  );
}
