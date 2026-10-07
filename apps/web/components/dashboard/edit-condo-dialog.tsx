"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { Camera, Loader2, X } from "lucide-react";
import { api } from "@vekino/backend/api";
import type { Id } from "@vekino/backend/dataModel";
import { Button } from "@/components/ui/button";
import { useUploadToS3 } from "@/hooks/use-upload-s3";
import { compressImage, formatBytes } from "@/lib/compress-image";
import { initials } from "@/lib/utils";

type Plan = "basico" | "pro" | "enterprise";

/** Originales grandes OK: se comprimen en el cliente antes de subir. */
const MAX_ORIGINAL_BYTES = 20 * 1024 * 1024;

export type CondoEditValues = {
  name: string;
  city?: string | null;
  nit?: string | null;
  address?: string | null;
  subdomain?: string | null;
  logo?: string | null;
  /** Foto destacada del home (app). */
  coverImage?: string | null;
  primaryColor?: string | null;
  subscriptionPlan?: Plan | null;
  unitLimit?: number | null;
  avalPortalUrl?: string | null;
  /** Nura del convenio Aval para pagar por API (ej "00030713"). */
  avalNura?: string | null;
  /** Módulos habilitados del condominio (p.ej. "whatsapp"). */
  activeModules?: string[] | null;
};

type UploadUi = {
  label: string;
  percent: number | null;
};

/**
 * Edición completa del condominio (plataforma): nombre, logo, color, plan, etc.
 */
export function EditCondoDialog({
  condominioId,
  initial,
  onClose,
}: {
  condominioId: Id<"condominios">;
  initial: CondoEditValues;
  onClose: () => void;
}) {
  const update = useMutation(api.condominios.update);
  const uploadFile = useUploadToS3();
  const logoRef = useRef<HTMLInputElement>(null);
  const coverRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState(initial.name);
  const [city, setCity] = useState(initial.city ?? "");
  const [nit, setNit] = useState(initial.nit ?? "");
  const [address, setAddress] = useState(initial.address ?? "");
  const [subdomain, setSubdomain] = useState(initial.subdomain ?? "");
  const [logo, setLogo] = useState(initial.logo ?? "");
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [coverImage, setCoverImage] = useState(initial.coverImage ?? "");
  const [coverPreview, setCoverPreview] = useState<string | null>(null);
  const [color, setColor] = useState(initial.primaryColor ?? "#F6560B");
  const [plan, setPlan] = useState<Plan>(initial.subscriptionPlan ?? "basico");
  const [unitLimit, setUnitLimit] = useState(
    initial.unitLimit != null ? String(initial.unitLimit) : "",
  );
  const [avalPortalUrl, setAvalPortalUrl] = useState(
    initial.avalPortalUrl ?? "",
  );
  const [avalNura, setAvalNura] = useState(initial.avalNura ?? "");
  const [whatsappActivo, setWhatsappActivo] = useState(
    (initial.activeModules ?? []).includes("whatsapp"),
  );
  /* Marcado = volver al motor viejo. Cloudflare va por defecto; esto es el
   * freno de emergencia, no el encendido. */
  const [salaSinCf, setSalaSinCf] = useState(
    (initial.activeModules ?? []).includes("sala_sin_cloudflare"),
  );
  const [logoProgress, setLogoProgress] = useState<UploadUi | null>(null);
  const [coverProgress, setCoverProgress] = useState<UploadUi | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLogoPreview(null);
  }, [initial.logo]);

  useEffect(() => {
    setCoverPreview(null);
  }, [initial.coverImage]);

  const shownLogo = logoPreview ?? (logo || null);
  const shownCover = coverPreview ?? (coverImage || null);
  const uploadingLogo = logoProgress != null;
  const uploadingCover = coverProgress != null;
  const uploading = uploadingLogo || uploadingCover;

  async function uploadImage(
    file: File,
    kind: "logo" | "cover",
    folder: string,
    onUrl: (url: string) => void,
    setPreview: (url: string | null) => void,
    setProgress: (p: UploadUi | null) => void,
  ) {
    if (!file.type.startsWith("image/")) {
      setError("El archivo debe ser una imagen.");
      return;
    }
    if (file.size > MAX_ORIGINAL_BYTES) {
      setError("La imagen debe pesar menos de 20 MB.");
      return;
    }

    setError(null);
    const localUrl = URL.createObjectURL(file);
    setPreview(localUrl);
    setProgress({
      label: `Optimizando… (${formatBytes(file.size)})`,
      percent: null,
    });

    try {
      const compressed = await compressImage(file, {
        maxEdge: kind === "logo" ? 512 : 1600,
        quality: kind === "logo" ? 0.88 : 0.8,
      });
      setProgress({
        label: `Subiendo… (${formatBytes(compressed.size)})`,
        percent: 5,
      });

      const { url } = await uploadFile(compressed, folder, {
        onProgress: (p) =>
          setProgress({
            label: p.label,
            percent: p.percent,
          }),
      });
      onUrl(url);
      setPreview(url);
      setProgress({ label: "Listo", percent: 100 });
      window.setTimeout(() => setProgress(null), 600);
    } catch (err) {
      setPreview(null);
      setProgress(null);
      setError(
        err instanceof Error ? err.message : "No se pudo subir la imagen.",
      );
    } finally {
      URL.revokeObjectURL(localUrl);
    }
  }

  async function onPickLogo(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    await uploadImage(
      file,
      "logo",
      `condominios/${condominioId}/logo`,
      setLogo,
      setLogoPreview,
      setLogoProgress,
    );
  }

  async function onPickCover(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    await uploadImage(
      file,
      "cover",
      `condominios/${condominioId}/cover`,
      setCoverImage,
      setCoverPreview,
      setCoverProgress,
    );
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const trimmed = name.trim();
    if (!trimmed) {
      setError("El nombre es obligatorio.");
      return;
    }
    if (!/^#[0-9A-Fa-f]{6}$/.test(color.trim())) {
      setError("El color debe ser un hex válido, ej. #F6560B.");
      return;
    }

    let limit: number | undefined;
    if (unitLimit.trim()) {
      limit = Number(unitLimit);
      if (!Number.isFinite(limit) || limit < 0) {
        setError("El límite de unidades debe ser un número válido.");
        return;
      }
    }

    setBusy(true);
    try {
      await update({
        condominioId,
        patch: {
          name: trimmed,
          city: city.trim(),
          nit: nit.trim(),
          address: address.trim(),
          subdomain: subdomain.trim(),
          logo: logo.trim(),
          coverImage: coverImage.trim(),
          primaryColor: color.trim(),
          subscriptionPlan: plan,
          unitLimit: limit,
          avalPortalUrl: avalPortalUrl.trim(),
          avalNura: avalNura.trim(),
          /* Se reconstruye la lista quitando los que gobierna este diálogo y
           * volviendo a añadir los encendidos, para no pisar módulos que se
           * activen desde otro sitio. */
          activeModules: [
            ...(initial.activeModules ?? []).filter(
              (m) =>
                m !== "whatsapp" &&
                m !== "sala_cloudflare" &&
                m !== "sala_sin_cloudflare",
            ),
            ...(whatsappActivo ? ["whatsapp"] : []),
            ...(salaSinCf ? ["sala_sin_cloudflare"] : []),
          ],
        },
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar.");
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/40 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-labelledby="edit-condo-title"
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-border bg-card p-6 shadow-floating"
      >
        <div className="mb-1 flex items-center justify-between">
          <h2
            id="edit-condo-title"
            className="text-lg font-semibold text-foreground"
          >
            Editar condominio
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={uploading}
            className="rounded-lg p-1 text-muted-foreground hover:bg-accent disabled:opacity-40"
            aria-label="Cerrar"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <p className="mb-5 text-sm text-muted-foreground">
          Actualiza nombre, marca e información institucional.
        </p>

        <form onSubmit={save} className="space-y-4">
          <div>
            <p className="mb-2 text-sm font-medium text-foreground">Logo</p>
            <div className="flex items-center gap-4">
              <button
                type="button"
                onClick={() => logoRef.current?.click()}
                disabled={uploading || busy}
                className="group relative grid h-20 w-20 shrink-0 place-items-center overflow-hidden rounded-2xl border border-border bg-muted text-sm font-semibold text-muted-foreground"
                aria-label="Subir logo"
                style={
                  !shownLogo
                    ? { backgroundColor: color, color: "#fff" }
                    : undefined
                }
              >
                {shownLogo ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={shownLogo}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                ) : (
                  initials(name || "C")
                )}
                <span
                  className={`absolute inset-0 flex items-center justify-center bg-foreground/40 transition-opacity ${
                    uploadingLogo
                      ? "opacity-100"
                      : "opacity-0 group-hover:opacity-100"
                  }`}
                >
                  {uploadingLogo ? (
                    <Loader2 className="h-5 w-5 animate-spin text-white" />
                  ) : (
                    <Camera className="h-5 w-5 text-white" />
                  )}
                </span>
              </button>
              <input
                ref={logoRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={onPickLogo}
              />
              <div className="min-w-0 flex-1 space-y-2">
                <p className="text-xs text-muted-foreground">
                  PNG, JPG o WebP · se optimiza al subir · máx. 20 MB
                </p>
                {logoProgress ? (
                  <UploadProgressBar progress={logoProgress} />
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={uploading || busy}
                      onClick={() => logoRef.current?.click()}
                    >
                      <Camera className="h-3.5 w-3.5" />
                      {shownLogo ? "Cambiar logo" : "Subir logo"}
                    </Button>
                    {logo ? (
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={uploading || busy}
                        onClick={() => {
                          setLogo("");
                          setLogoPreview(null);
                        }}
                      >
                        Quitar
                      </Button>
                    ) : null}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div>
            <p className="mb-2 text-sm font-medium text-foreground">
              Foto destacada
            </p>
            <p className="mb-2 text-xs text-muted-foreground">
              Se muestra en el inicio de la app. Ideal horizontal (fachada o
              entrada). Se comprime automáticamente.
            </p>
            <button
              type="button"
              onClick={() => coverRef.current?.click()}
              disabled={uploading || busy}
              className="group relative flex h-36 w-full items-center justify-center overflow-hidden rounded-2xl border border-border bg-muted"
              aria-label="Subir foto destacada"
            >
              {shownCover ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={shownCover}
                  alt=""
                  className="h-full w-full object-cover"
                />
              ) : (
                <span className="text-sm text-muted-foreground">
                  Sin foto · toca para subir
                </span>
              )}
              <span
                className={`absolute inset-0 flex flex-col items-center justify-center gap-2 bg-foreground/50 px-4 transition-opacity ${
                  uploadingCover
                    ? "opacity-100"
                    : "opacity-0 group-hover:opacity-100"
                }`}
              >
                {uploadingCover ? (
                  <>
                    <Loader2 className="h-6 w-6 animate-spin text-white" />
                    <span className="text-center text-xs font-medium text-white">
                      {coverProgress?.label}
                    </span>
                  </>
                ) : (
                  <Camera className="h-6 w-6 text-white" />
                )}
              </span>
            </button>
            <input
              ref={coverRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={onPickCover}
            />
            <div className="mt-2 space-y-2">
              {coverProgress ? (
                <UploadProgressBar progress={coverProgress} />
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={uploading || busy}
                    onClick={() => coverRef.current?.click()}
                  >
                    <Camera className="h-3.5 w-3.5" />
                    {shownCover ? "Cambiar foto" : "Subir foto"}
                  </Button>
                  {coverImage ? (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={uploading || busy}
                      onClick={() => {
                        setCoverImage("");
                        setCoverPreview(null);
                      }}
                    >
                      Quitar
                    </Button>
                  ) : null}
                </div>
              )}
            </div>
          </div>

          <Field label="Nombre" value={name} onChange={setName} required />

          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
            <Field label="Ciudad" value={city} onChange={setCity} />
            <Field label="NIT" value={nit} onChange={setNit} />
          </div>

          <Field label="Dirección" value={address} onChange={setAddress} />

          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
            <Field
              label="Subdominio"
              value={subdomain}
              onChange={setSubdomain}
              placeholder="ej. arboleda"
            />
            <div>
              <label className="text-sm font-medium text-foreground">
                Plan
              </label>
              <select
                value={plan}
                onChange={(e) => setPlan(e.target.value as Plan)}
                className="mt-1.5 w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand/30"
              >
                <option value="basico">Básico</option>
                <option value="pro">Pro</option>
                <option value="enterprise">Enterprise</option>
              </select>
            </div>
          </div>

          <div>
            <label className="text-sm font-medium text-foreground">
              Color de marca
            </label>
            <div className="mt-1.5 flex items-center gap-2">
              <input
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="h-10 w-12 cursor-pointer rounded-lg border border-border bg-background p-1"
              />
              <input
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="flex-1 rounded-lg border border-border bg-background px-3 py-2.5 font-mono text-sm outline-none focus:ring-2 focus:ring-brand/30"
              />
            </div>
          </div>

          <Field
            label="Límite de unidades"
            value={unitLimit}
            onChange={setUnitLimit}
            placeholder="Opcional"
            inputMode="numeric"
          />

          <Field
            label="URL portal AvalPay"
            value={avalPortalUrl}
            onChange={setAvalPortalUrl}
            placeholder="https://… (opcional)"
          />

          <Field
            label="Nura del convenio Aval (pago por API)"
            value={avalNura}
            onChange={setAvalNura}
            placeholder="Ej. 00030713 (opcional)"
            inputMode="numeric"
          />

          <div>
            <p className="mb-2 text-sm font-medium text-foreground">Módulos</p>
            <label className="flex cursor-pointer items-start justify-between gap-3 rounded-xl border border-border bg-background px-3 py-3">
              <span className="min-w-0">
                <span className="block text-sm font-medium text-foreground">
                  WhatsApp (YCloud)
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  Bot para residentes (facturas, reservas, comprobantes, PQRS) y
                  avisos por plantilla al publicar comunicados.
                </span>
              </span>
              <input
                type="checkbox"
                checked={whatsappActivo}
                onChange={(e) => setWhatsappActivo(e.target.checked)}
                disabled={busy || uploading}
                className="mt-0.5 h-5 w-9 shrink-0 cursor-pointer appearance-none rounded-full bg-muted transition-colors before:mt-0.5 before:ml-0.5 before:block before:h-4 before:w-4 before:rounded-full before:bg-white before:shadow before:transition-transform checked:bg-brand checked:before:translate-x-4"
              />
            </label>

            <label className="mt-2 flex cursor-pointer items-start justify-between gap-3 rounded-xl border border-border bg-background px-3 py-3">
              <span className="min-w-0">
                <span className="block text-sm font-medium text-foreground">
                  Desactivar Cloudflare en la sala
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  Las asambleas usan el repetidor de Cloudflare por defecto.
                  Marca esto solo como freno de emergencia: devuelve a este
                  conjunto al motor anterior, que en una asamblea grande no
                  aguanta. Los participantes tienen que volver a entrar a la
                  sala para que el cambio les llegue.
                </span>
              </span>
              <input
                type="checkbox"
                checked={salaSinCf}
                onChange={(e) => setSalaSinCf(e.target.checked)}
                disabled={busy || uploading}
                className="mt-0.5 h-5 w-9 shrink-0 cursor-pointer appearance-none rounded-full bg-muted transition-colors before:mt-0.5 before:ml-0.5 before:block before:h-4 before:w-4 before:rounded-full before:bg-white before:shadow before:transition-transform checked:bg-brand checked:before:translate-x-4"
              />
            </label>
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <div className="flex gap-2 pt-1">
            <Button
              type="button"
              variant="secondary"
              className="flex-1"
              onClick={onClose}
              disabled={busy || uploading}
            >
              Cancelar
            </Button>
            <Button
              type="submit"
              variant="brand"
              className="flex-1"
              disabled={busy || uploading || !name.trim()}
            >
              {busy
                ? "Guardando…"
                : uploading
                  ? "Espera a que termine la foto…"
                  : "Guardar cambios"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

function UploadProgressBar({ progress }: { progress: UploadUi }) {
  const pct = progress.percent;
  return (
    <div className="space-y-1.5" aria-live="polite">
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="min-w-0 truncate">{progress.label}</span>
        {pct != null ? (
          <span className="shrink-0 font-medium tabular-nums text-foreground">
            {pct}%
          </span>
        ) : null}
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full bg-brand transition-[width] duration-300 ${
            pct == null ? "w-1/3 animate-pulse" : ""
          }`}
          style={pct != null ? { width: `${Math.max(4, pct)}%` } : undefined}
        />
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  required,
  placeholder,
  inputMode,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  placeholder?: string;
  inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"];
}) {
  return (
    <div>
      <label className="text-sm font-medium text-foreground">{label}</label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        placeholder={placeholder}
        inputMode={inputMode}
        className="mt-1.5 w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm text-foreground outline-none focus:ring-2 focus:ring-brand/30"
      />
    </div>
  );
}
