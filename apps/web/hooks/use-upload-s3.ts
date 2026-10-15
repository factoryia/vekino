"use client";

import { useCallback } from "react";
import { useAction } from "convex/react";
import { api } from "@vekino/backend/api";
import { uploadToS3, type UploadToS3Options } from "@/lib/upload-s3";

/**
 * Subida a S3 con fallback por Convex (evita CORS del browser).
 */
export function useUploadToS3() {
  const generateUploadUrl = useAction(api.files.generateUploadUrl);
  const confirmarSubida = useAction(api.files.confirmarSubida);
  const uploadBytes = useAction(api.files.uploadBytes);

  return useCallback(
    (
      file: Blob & { name?: string },
      folder: string,
      options?: UploadToS3Options,
    ) => uploadToS3(generateUploadUrl, confirmarSubida, file, folder, uploadBytes, options),
    [generateUploadUrl, confirmarSubida, uploadBytes],
  );
}
