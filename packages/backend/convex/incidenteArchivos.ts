"use node";

import { randomUUID } from "node:crypto";
import { S3Client, PutObjectCommand, GetObjectCommand, GetPublicAccessBlockCommand } from "@aws-sdk/client-s3";
import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { validarArchivoEvidencia, validarContenidoEvidencia } from "./lib/incidenteEvidencias";

/** Bucket exclusivo: las APIs antiguas por key solo pueden operar sobre AWS_S3_BUCKET_NAME. */
async function almacenamientoPrivado() {
  const bucket = process.env.AWS_INCIDENTES_BUCKET_NAME?.trim();
  const accessKeyId = process.env.AWS_INCIDENTES_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.AWS_INCIDENTES_SECRET_ACCESS_KEY;
  if (!bucket || !accessKeyId || !secretAccessKey) throw new Error("El almacenamiento privado de evidencias no está configurado.");
  if (bucket === process.env.AWS_S3_BUCKET_NAME?.trim()) throw new Error("El bucket de evidencias debe ser distinto del bucket público.");
  const client = new S3Client({ region: process.env.AWS_INCIDENTES_REGION ?? process.env.AWS_REGION ?? "us-east-1",
    credentials: { accessKeyId, secretAccessKey } });
  const { PublicAccessBlockConfiguration: bloqueo } = await client.send(new GetPublicAccessBlockCommand({ Bucket: bucket }));
  if (!bloqueo?.BlockPublicAcls || !bloqueo.IgnorePublicAcls || !bloqueo.BlockPublicPolicy || !bloqueo.RestrictPublicBuckets) {
    throw new Error("El bucket de evidencias no tiene bloqueado todo el acceso público.");
  }
  return { bucket, client };
}

/** Validar → preparar en Convex → subir bytes acotados → registrar con autorización actual. */
export const subir = action({
  args: { incidenteId: v.id("incidentes"), nombre: v.string(), mimeType: v.string(), bytes: v.bytes() },
  handler: async (ctx, args): Promise<Id<"incidenteEvidencias">> => {
    const datos = validarArchivoEvidencia({ ...args, size: args.bytes.byteLength });
    validarContenidoEvidencia(args.bytes, datos.mimeType);
    const carga: { cargaId: Id<"incidenteEvidenciaCargas">; storageKey: string } = await ctx.runMutation(internal.incidenteEvidencias.preparar,
      { incidenteId: args.incidenteId, objetoId: randomUUID(), ...datos });
    const { bucket, client } = await almacenamientoPrivado();
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: carga.storageKey,
      Body: Buffer.from(args.bytes), ContentType: datos.mimeType, ContentLength: datos.size,
      CacheControl: "private, no-store", ServerSideEncryption: "AES256" }));
    // Nunca borrar si falla el registro: la carga interna permite reconciliar sin perder trazabilidad.
    return await ctx.runMutation(internal.incidenteEvidencias.registrar, { cargaId: carga.cargaId });
  },
});

/** Lectura autenticada por petición: no entrega ninguna URL S3 al cliente. */
export const acceder = action({
  args: { evidenciaId: v.id("incidenteEvidencias") },
  handler: async (ctx, args): Promise<{ bytes: ArrayBuffer; nombre: string; mimeType: string }> => {
    const evidencia: { storageKey: string; nombre: string; mimeType: string; size: number } = await ctx.runQuery(internal.incidenteEvidencias.resolverAcceso, { evidenciaId: args.evidenciaId });
    const { bucket, client } = await almacenamientoPrivado();
    const objeto = await client.send(new GetObjectCommand({ Bucket: bucket, Key: evidencia.storageKey }));
    if (!objeto.Body || objeto.ContentLength !== evidencia.size) throw new Error("El objeto no coincide con el registro de evidencia.");
    const contenido = await objeto.Body.transformToByteArray();
    validarArchivoEvidencia({ ...evidencia, size: contenido.byteLength });
    if (contenido.byteLength !== evidencia.size) throw new Error("El objeto no coincide con el registro de evidencia.");
    // No devolver contenido si hubo retiro o pérdida de alcance durante la lectura de S3.
    await ctx.runQuery(internal.incidenteEvidencias.resolverAcceso, { evidenciaId: args.evidenciaId });
    return { bytes: new Uint8Array(contenido).buffer, nombre: evidencia.nombre, mimeType: evidencia.mimeType };
  },
});
