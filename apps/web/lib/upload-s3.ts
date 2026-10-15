import type { FunctionReturnType } from "convex/server";
import type { api } from "@vekino/backend/api";

type GenerateS3Upload = (args: {
  folder: string;
  contentType: string;
  fileName?: string;
  /** Con el tamaño, la URL firmada de S3 exige ese tamaño y ese tipo exactos. */
  size?: number;
}) => Promise<FunctionReturnType<typeof api.files.generateUploadUrl>>;

type UploadBytesFn = (args: {
  folder: string;
  contentType: string;
  fileName?: string;
  bytes: ArrayBuffer;
}) => Promise<FunctionReturnType<typeof api.files.uploadBytes>>;

/** Límite de args de Convex actions (~16 MiB); dejamos margen. */
const SERVER_MAX_BYTES = 15 * 1024 * 1024;

export type UploadProgress = {
  /** 0–100 cuando se conoce; null si indeterminado. */
  percent: number | null;
  label: string;
};

export type UploadToS3Options = {
  onProgress?: (p: UploadProgress) => void;
};

/**
 * Sube un File/Blob a S3.
 *
 * - Archivos ≤ 15 MB + `uploadBytes`: sube por Convex (sin CORS).
 * - Archivos grandes: PUT firmado al bucket (con progreso XHR).
 */
export async function uploadToS3(
  generateUploadUrl: GenerateS3Upload,
  file: Blob & { name?: string },
  folder: string,
  uploadBytes?: UploadBytesFn,
  options?: UploadToS3Options,
): Promise<{ url: string; key: string }> {
  const contentType = file.type || "application/octet-stream";
  const onProgress = options?.onProgress;
  const canServer = Boolean(uploadBytes) && file.size <= SERVER_MAX_BYTES;

  if (canServer && uploadBytes) {
    try {
      onProgress?.({ percent: null, label: "Preparando archivo…" });
      const bytes = await file.arrayBuffer();
      onProgress?.({ percent: 10, label: "Subiendo al servidor…" });
      const stopPulse = pulseProgress(onProgress, 10, 88, "Subiendo al servidor…");
      try {
        const { publicUrl, key } = await uploadBytes({
          folder,
          contentType,
          fileName: file.name,
          bytes,
        });
        stopPulse();
        onProgress?.({ percent: 100, label: "Listo" });
        return { url: publicUrl, key };
      } catch (inner) {
        stopPulse();
        throw inner;
      }
    } catch (err) {
      // Si el servidor falla, intenta PUT como último recurso.
      try {
        return await putSigned(
          generateUploadUrl,
          file,
          folder,
          contentType,
          onProgress,
        );
      } catch {
        throw toUploadError(err);
      }
    }
  }

  try {
    return await putSigned(
      generateUploadUrl,
      file,
      folder,
      contentType,
      onProgress,
    );
  } catch (err) {
    if (uploadBytes && file.size <= SERVER_MAX_BYTES) {
      try {
        onProgress?.({ percent: 10, label: "Reintentando por servidor…" });
        const bytes = await file.arrayBuffer();
        const stopPulse = pulseProgress(
          onProgress,
          10,
          88,
          "Subiendo al servidor…",
        );
        try {
          const { publicUrl, key } = await uploadBytes({
            folder,
            contentType,
            fileName: file.name,
            bytes,
          });
          stopPulse();
          onProgress?.({ percent: 100, label: "Listo" });
          return { url: publicUrl, key };
        } catch (inner) {
          stopPulse();
          throw inner;
        }
      } catch (fallbackErr) {
        throw toUploadError(fallbackErr);
      }
    }
    throw toUploadError(err);
  }
}

async function putSigned(
  generateUploadUrl: GenerateS3Upload,
  file: Blob & { name?: string },
  folder: string,
  contentType: string,
  onProgress?: (p: UploadProgress) => void,
): Promise<{ url: string; key: string }> {
  onProgress?.({ percent: null, label: "Obteniendo enlace de subida…" });
  const { uploadUrl, publicUrl, key } = await generateUploadUrl({
    folder,
    contentType,
    fileName: file.name,
    size: file.size,
  });

  onProgress?.({ percent: 0, label: "Subiendo a almacenamiento…" });
  await putWithProgress(uploadUrl, file, contentType, (percent) => {
    onProgress?.({
      percent,
      label: `Subiendo… ${percent}%`,
    });
  });
  onProgress?.({ percent: 100, label: "Listo" });
  return { url: publicUrl, key };
}

/** PUT con progreso real (XHR). Timeout 90s. */
function putWithProgress(
  uploadUrl: string,
  file: Blob,
  contentType: string,
  onPercent: (n: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl);
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.timeout = 90_000;

    xhr.upload.onprogress = (ev) => {
      if (!ev.lengthComputable || ev.total <= 0) return;
      onPercent(Math.min(99, Math.round((ev.loaded / ev.total) * 100)));
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onPercent(100);
        resolve();
      } else {
        reject(new Error(`Error al subir a S3 (${xhr.status}).`));
      }
    };
    xhr.onerror = () =>
      reject(new Error("No se pudo subir el archivo (red o CORS de S3)."));
    xhr.ontimeout = () =>
      reject(
        new Error(
          "La subida tardó demasiado. Prueba una foto más liviana o otra red.",
        ),
      );
    xhr.send(file);
  });
}

/** Avance estimado mientras Convex procesa (sin % real del wire). */
function pulseProgress(
  onProgress: ((p: UploadProgress) => void) | undefined,
  from: number,
  to: number,
  label: string,
): () => void {
  if (!onProgress) return () => {};
  let current = from;
  const id = window.setInterval(() => {
    // Asymptotic approach toward `to`
    current = current + (to - current) * 0.12;
    onProgress({
      percent: Math.min(to, Math.round(current)),
      label: `${label} ${Math.round(current)}%`,
    });
  }, 400);
  return () => window.clearInterval(id);
}

function toUploadError(err: unknown): Error {
  const msg =
    err instanceof Error ? err.message : "No se pudo subir el archivo.";
  if (/failed to fetch|networkerror|load failed/i.test(msg)) {
    return new Error(
      "No se pudo subir el archivo (conexión o CORS de S3). Revisa la red e inténtalo de nuevo.",
    );
  }
  return err instanceof Error ? err : new Error(msg);
}
