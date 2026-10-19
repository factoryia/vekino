import { NextRequest, NextResponse } from "next/server";
import { api } from "@vekino/backend/api";
import type { Id } from "@vekino/backend/dataModel";
import { finDelDiaDelPeriodo, vencimientoDePeriodo } from "@vekino/backend/cartera";
import { numeroFacturaDe } from "@vekino/backend/lecturaFactura";
import { fetchAuthAction, fetchAuthMutation } from "@/lib/auth-server";
import { hashDe, leerPdf, MENSAJE_PDF_ILEGIBLE, pdfDeFactura, PdfIlegible, type PdfLeido } from "../lectura";
import { idsDelConjunto, rechazoSinSesion, validarDestino } from "../permiso";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * CONFIRMACIÓN de un PDF de cuentas de cobro: lo único que publica en S3 y
 * escribe en la base.
 *
 *   1. Misma sesión, permiso y conjunto que la vista previa: el backend
 *      (`facturas.destinoCarga`) resuelve el conjunto y su carpeta de S3
 *      —`legacyId` si es migrado, `_id` si no— y rechaza un
 *      `condominioLegacyId` y un `condominioId` de conjuntos distintos.
 *   2. Vuelve a leer el PDF EN EL SERVIDOR y comprueba por hash que es el
 *      mismo de la vista previa: lo que se guarda son los números que lee
 *      el servidor, no los que mande el navegador.
 *   3. `iniciarImportacion` registra la carga y dice qué pasará con cada
 *      factura. Si el mismo archivo ya se confirmó para el período, devuelve
 *      el resultado anterior sin publicar ni escribir nada (doble clic,
 *      reintento).
 *   4. Publica SOLO las facturas que se insertan o actualizan, y no lo hace
 *      esta ruta: le manda a Convex (`files.publicarFacturas`) el PDF de
 *      cada una, y Convex comprueba el permiso sobre la importación y que
 *      sea un PDF, arma la llave (la de esta importación y la huella del
 *      contenido), publica con `If-None-Match: *` —un PDF publicado nunca
 *      se sobrescribe, y el `pdfUrl` anterior de una factura actualizada
 *      sigue sirviendo— y deja cada PDF como subida validada.
 *   5. `bulkUpsert` guarda (y vuelve a validar: un `pdfUrl` nuevo solo si es
 *      un PDF publicado para esta importación) y `finalizarImportacion`
 *      cierra la carga con sus conteos.
 *
 * Fase 5 de S3 (H-12): antes esta ruta escribía en S3 con sus propias
 * credenciales y `bulkUpsert` aceptaba cualquier `pdfUrl`. La web ya no
 * escribe en S3.
 *
 * Fase 6: un PDF de factura que no cabe en una llamada a `publicarFacturas`
 * (`MAX_LOTE_BYTES`) no se rechaza: sube por la ruta intermediada del backend
 * (`/archivos/subida`, la de las apps instaladas) a la carpeta de esta
 * importación, que revisa sesión, rol, contenido y tamaño (hasta 20 MiB) y
 * publica sin sobrescribir. Pasa, p. ej., cuando las páginas comparten una
 * imagen pesada: el PDF de cada factura la lleva entera.
 *
 * Fase 3: el vencimiento de lo que entra es el último día del mes del
 * período (`vencimientoDePeriodo`, decisión de la administración) y el plazo
 * del descuento es el que dice el documento (`fechaLimiteDescuento`). Dos
 * documentos para la misma unidad no se guardan (`documento_repetido`).
 */

/** Facturas por llamada a `bulkUpsert`, como hacía la pantalla. */
const LOTE = 20;
/**
 * Bytes de PDF por llamada a `files.publicarFacturas`: es una acción Node,
 * recibe hasta 5 MiB, y los bytes viajan en base64 (un tercio más).
 */
const MAX_LOTE_BYTES = 3 * 1024 * 1024;
/** Llamadas a `publicarFacturas` a la vez. */
const PARALELO = 3;

/** El PDF de una factura que tampoco cabe en la ruta intermediada (más de 20 MiB). */
class PdfDeFacturaGrande extends Error {}

type PdfPorPublicar = { indice: number; unidad: string; bytes: Uint8Array };

/** Los PDF (cada uno de hasta `max` bytes) en lotes que no pasan de `max` bytes. */
function enLotes(pdfs: readonly PdfPorPublicar[], max: number): PdfPorPublicar[][] {
  const lotes: PdfPorPublicar[][] = [];
  let lote: PdfPorPublicar[] = [];
  let tamano = 0;
  for (const p of pdfs) {
    if (lote.length > 0 && tamano + p.bytes.byteLength > max) {
      lotes.push(lote);
      lote = [];
      tamano = 0;
    }
    lote.push(p);
    tamano += p.bytes.byteLength;
  }
  if (lote.length > 0) lotes.push(lote);
  return lotes;
}

const aArrayBuffer = (b: Uint8Array): ArrayBuffer =>
  b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

/**
 * Un PDF que no cabe en una llamada a `publicarFacturas`: sube por la ruta
 * intermediada del backend a la carpeta de la importación (`subidas.ts`). El
 * enlace lo pide Convex con la sesión de quien confirma, es de un solo uso y
 * vence a los 10 minutos; el backend revisa el contenido y el tamaño antes de
 * publicar. Devuelve la URL que `bulkUpsert` acepta para esa importación.
 */
async function publicarGrande(carpetaImportacion: string, p: PdfPorPublicar): Promise<string> {
  const casa = p.unidad || "sin número";
  const { uploadUrl, publicUrl } = await fetchAuthAction(api.files.generateUploadUrl, {
    folder: carpetaImportacion,
    contentType: "application/pdf",
    fileName: `unidad-${p.unidad || "sin-unidad"}.pdf`,
  });
  const res = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "application/pdf" },
    body: aArrayBuffer(p.bytes),
  });
  if (res.status === 413) {
    throw new PdfDeFacturaGrande(
      `El PDF de la casa ${casa} es demasiado grande para publicarse (más de 20 MiB, unos 21 MB). Revisa el archivo y vuelve a cargarlo.`,
    );
  }
  if (!res.ok) throw new Error(`No se pudo publicar el PDF de la casa ${casa} (${res.status}).`);
  return publicUrl;
}

async function enParalelo<T>(items: readonly T[], n: number, fn: (item: T) => Promise<void>) {
  const cola = [...items];
  await Promise.all(
    Array.from({ length: Math.min(n, cola.length) }, async () => {
      for (let item = cola.shift(); item !== undefined; item = cola.shift()) await fn(item);
    }),
  );
}

function leerAsignaciones(crudo: string | null, total: number): Map<number, string> | null {
  try {
    const lista = JSON.parse(crudo ?? "") as unknown;
    if (!Array.isArray(lista)) return null;
    const mapa = new Map<number, string>();
    for (const a of lista) {
      const { indice, unidadId } = (a ?? {}) as { indice?: unknown; unidadId?: unknown };
      if (!Number.isInteger(indice) || (indice as number) < 0 || (indice as number) >= total) return null;
      if (typeof unidadId !== "string" || !unidadId || mapa.has(indice as number)) return null;
      mapa.set(indice as number, unidadId);
    }
    return mapa;
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  let importacionId: Id<"importaciones"> | null = null;
  try {
    const sinSesion = await rechazoSinSesion();
    if (sinSesion) return sinSesion;

    const form = await req.formData();
    const file = form.get("pdf") as File | null;
    const ids = idsDelConjunto(form);
    const periodo = form.get("periodo") as string | null;
    const hash = form.get("hash") as string | null;
    const soloNuevas = form.get("soloNuevas") !== "false";
    if (!file || !ids || !periodo || !hash) {
      return NextResponse.json(
        { error: "Faltan campos: pdf, condominioId (o condominioLegacyId), periodo, hash" },
        { status: 400 },
      );
    }

    const permiso = await validarDestino(ids);
    if (permiso.rechazo) return permiso.rechazo;
    /* El conjunto y su carpeta salen del backend, no del formulario. Al
     * publicar, Convex vuelve a resolverlos desde la importación. */
    const { condominioId, carpeta } = permiso.destino;

    const bytes = new Uint8Array(await file.arrayBuffer());
    if (hashDe(bytes) !== hash) {
      return NextResponse.json(
        { error: "El archivo no es el mismo de la vista previa. Vuelve a seleccionarlo." },
        { status: 409 },
      );
    }

    let leido: PdfLeido;
    try {
      leido = await leerPdf(bytes);
    } catch (e) {
      if (!(e instanceof PdfIlegible)) throw e;
      return NextResponse.json({ error: MENSAJE_PDF_ILEGIBLE }, { status: 422 });
    }
    const asignaciones = leerAsignaciones(form.get("asignaciones") as string | null, leido.facturas.length);
    if (!asignaciones) {
      return NextResponse.json({ error: "Las unidades asignadas no son válidas." }, { status: 400 });
    }
    const candidatas = leido.facturas.flatMap((f, indice) => {
      const unidadId = asignaciones.get(indice);
      return unidadId
        ? [{ indice, unidadId: unidadId as Id<"unidades">, periodoLabel: f.periodoLabel }]
        : [];
    });
    const sinUnidad = leido.facturas.map((_, i) => i).filter((i) => !asignaciones.has(i));

    const inicio = await fetchAuthMutation(api.facturas.iniciarImportacion, {
      condominioId,
      periodo,
      archivo: file.name,
      hash,
      soloNuevas,
      documentos: leido.facturas.length,
      candidatas,
    });
    if (inicio.tipo === "repetida") {
      return NextResponse.json({ tipo: "repetida", ...inicio.resultado, publicadas: 0 });
    }
    if (inicio.tipo === "en_curso") {
      return NextResponse.json(
        { error: "Esta carga ya se está confirmando. Espera un momento y revisa Finanzas." },
        { status: 409 },
      );
    }
    importacionId = inicio.importacionId;

    /* Solo lo que de verdad se va a escribir. Lo omitido ("solo nuevas") y
     * lo rechazado no se publica. Publica Convex (`files.publicarFacturas`),
     * que devuelve la URL de cada PDF: la única que `bulkUpsert` acepta. */
    const aPublicar = inicio.plan.filter((p) => p.accion === "insertar" || p.accion === "actualizar");
    const pdfs: PdfPorPublicar[] = [];
    for (const p of aPublicar) {
      const f = leido.facturas[p.indice]!;
      pdfs.push({ indice: p.indice, unidad: f.unitIdentifier, bytes: await pdfDeFactura(leido.doc, f.paginas) });
    }
    const urls = new Map<number, string>();
    const caben = pdfs.filter((p) => p.bytes.byteLength <= MAX_LOTE_BYTES);
    const grandes = pdfs.filter((p) => p.bytes.byteLength > MAX_LOTE_BYTES);
    await enParalelo(enLotes(caben, MAX_LOTE_BYTES), PARALELO, async (lote) => {
      const publicados = await fetchAuthAction(api.files.publicarFacturas, {
        importacionId: importacionId!,
        pdfs: lote.map((p) => ({ unidad: p.unidad, bytes: aArrayBuffer(p.bytes) })),
      });
      lote.forEach((p, i) => urls.set(p.indice, publicados[i]!.publicUrl));
    });
    const carpetaImportacion = `condominios/facturas/${carpeta}/${periodo}/${importacionId}`;
    for (const p of grandes) urls.set(p.indice, await publicarGrande(carpetaImportacion, p));

    const fechaEmision = Date.now();
    /* Decisión de la administración para la Fase 3: "con descuento hasta el
     * 15 del presente mes, del 16 a 30 se paga el precio completo". El
     * vencimiento es el último día del mes del período (antes, el 15 del mes
     * siguiente). Solo para lo que entra desde ahora. */
    const fechaVencimiento = vencimientoDePeriodo(periodo);
    /* Dos documentos para la misma unidad en este PDF: el plan los rechazó y
     * no se mandan a guardar (podrían caer en lotes distintos y el segundo
     * pisaría al primero). Quedan registrados al cerrar. */
    const repetidas = inicio.plan.filter(
      (p) => p.accion === "rechazar" && p.motivo === "documento_repetido",
    );
    const fuera = new Set(repetidas.map((p) => p.indice));
    const facturas = candidatas.filter((c) => !fuera.has(c.indice)).map((c, i) => {
      const f = leido.facturas[c.indice]!;
      const pdfUrl = urls.get(c.indice);
      return {
        condominioId,
        unidadId: c.unidadId,
        /* Del período y la casa del documento, no de la posición en el lote
         * (Fase 4, F-17): el mismo documento, el mismo número. */
        numeroFactura: numeroFacturaDe(periodo, f.unitIdentifier, i + 1),
        numeroInterno: f.numeroInterno,
        periodo,
        periodoLabel: f.periodoLabel,
        residenteNombre: f.residenteNombre,
        ...(f.apto ? { apto: f.apto } : {}),
        vrAdmon: f.vrAdmon,
        lineas: f.lineas,
        saldoAFavor: f.saldoAFavor,
        totalAPagar: f.totalAPagar,
        ...(f.totalConDescuento !== undefined ? { totalConDescuento: f.totalConDescuento } : {}),
        ...(f.totalConDescuento !== undefined && f.diaLimiteDescuento !== undefined
          ? { fechaLimiteDescuento: finDelDiaDelPeriodo(periodo, f.diaLimiteDescuento) }
          : {}),
        ...(f.saldoAnteriorDocumento !== undefined
          ? { saldoAnteriorDocumento: f.saldoAnteriorDocumento }
          : {}),
        fechaEmision,
        fechaVencimiento,
        estado: "pendiente" as const,
        ...(pdfUrl ? { pdfUrl } : {}),
        motivosLectura: f.motivos,
      };
    });

    const conciliacion = { pagadas: 0, abonadas: 0, vencidas: 0 };
    for (let i = 0; i < facturas.length; i += LOTE) {
      const r = await fetchAuthMutation(api.facturas.bulkUpsert, {
        facturas: facturas.slice(i, i + LOTE),
        skipExisting: soloNuevas,
        importacionId,
      });
      conciliacion.pagadas += r.conciliacion.pagadas;
      conciliacion.abonadas += r.conciliacion.abonadas;
      conciliacion.vencidas += r.conciliacion.vencidas;
    }

    const final = await fetchAuthMutation(api.facturas.finalizarImportacion, {
      importacionId,
      estado: "completada",
      sinUnidad,
      ...(repetidas.length > 0
        ? { rechazos: repetidas.map((p) => ({ indice: p.indice, motivo: "documento_repetido" })) }
        : {}),
    });
    return NextResponse.json({ tipo: "nueva", ...final, conciliacion, publicadas: aPublicar.length });
  } catch (e) {
    console.error("[facturas/confirmar]", e);
    const mensaje = e instanceof Error ? e.message : String(e);
    if (importacionId) {
      try {
        await fetchAuthMutation(api.facturas.finalizarImportacion, {
          importacionId,
          estado: "fallida",
          error: mensaje,
        });
      } catch {
        /* Si tampoco se puede cerrar, queda "en curso" y se retoma al reintentar. */
      }
    }
    if (e instanceof PdfDeFacturaGrande) return NextResponse.json({ error: e.message }, { status: 413 });
    return NextResponse.json(
      { error: "No se pudo confirmar la carga. Intenta de nuevo; lo ya guardado no se duplica." },
      { status: 500 },
    );
  }
}
