import { NextRequest, NextResponse } from "next/server";
import { MENSAJE_LECTURA } from "@vekino/backend/lecturaFactura";
import { leerPdf, PdfIlegible, type PdfLeido } from "../lectura";
import { idsDelConjunto, rechazoSinSesion, validarDestino } from "../permiso";

/* Mensajes estables: la pantalla los muestra tal cual. */
const ARCHIVO_VACIO = "El archivo está vacío. Elige el PDF con las cuentas de cobro.";
const PDF_ILEGIBLE = "El archivo no es un PDF válido o está dañado. Revísalo y vuelve a subirlo.";

/**
 * VISTA PREVIA de un PDF de cuentas de cobro.
 *
 * Lee el PDF, lo parte en facturas y devuelve lo leído, con las dudas de cada
 * factura (`motivos`), el período que declara cada documento y la huella
 * (SHA-256) del archivo. No publica nada en S3 ni escribe en la base: eso lo
 * hace `/api/facturas/confirmar`, y solo con lo que la administración aceptó.
 *
 * Antes esta ruta subía cada PDF a S3 al leerlo, con una llave fija por
 * período y casa: la vista previa de un PDF equivocado pisaba los publicados
 * aunque se cancelara (auditoría de facturación, F-07).
 *
 * El conjunto llega como `condominioId` (o `condominioLegacyId`, de la web
 * anterior) y el permiso se valida igual que al confirmar (`validarDestino`).
 */
export async function POST(req: NextRequest) {
  try {
    const sinSesion = await rechazoSinSesion();
    if (sinSesion) return sinSesion;

    const form = await req.formData();
    const file = form.get("pdf") as File | null;
    const ids = idsDelConjunto(form);
    if (!file || !ids) {
      return NextResponse.json(
        { error: "Faltan campos: pdf, condominioId (o condominioLegacyId)" },
        { status: 400 },
      );
    }

    const { rechazo } = await validarDestino(ids);
    if (rechazo) return rechazo;

    /* Un archivo que no se puede abrir como PDF (vacío, de texto, cortado) no
     * es un error del servidor: se rechaza con un mensaje que se entiende. El
     * detalle del lector queda solo en el registro del servidor. Un fallo al
     * interpretar el texto sí es del servidor y sigue al 500 de abajo. */
    if (file.size === 0) return NextResponse.json({ error: ARCHIVO_VACIO }, { status: 400 });
    let leido: PdfLeido;
    try {
      leido = await leerPdf(new Uint8Array(await file.arrayBuffer()));
    } catch (e) {
      if (!(e instanceof PdfIlegible)) throw e;
      console.error("[facturas/upload] PDF ilegible:", e.message);
      return NextResponse.json({ error: PDF_ILEGIBLE }, { status: 422 });
    }

    /* Una factura que no cuadra sale igual en `invoices` (con sus motivos),
     * para que se vea y se decida; y además se cuenta en `parseErrors`, que
     * es lo que la pantalla muestra como aviso. Nunca como válida sin aviso. */
    const conDudas = leido.facturas
      .filter((f) => f.motivos.length > 0)
      .map((f) => ({
        pages: f.paginas,
        unitIdentifier: f.unitIdentifier,
        error: f.motivos.map((m) => MENSAJE_LECTURA[m]).join(" "),
      }));
    const parseErrors = [
      ...leido.errores.map((e) => ({ pages: e.paginas, error: e.error })),
      ...conDudas,
    ];

    return NextResponse.json({
      archivo: file.name,
      hash: leido.hash,
      total: leido.facturas.length + leido.errores.length,
      processed: leido.facturas.length,
      errors: parseErrors.length,
      invoices: leido.facturas.map((f) => ({ ...f, pageCount: f.paginas.length })),
      parseErrors,
      /** Grupos de páginas que no se pudieron leer como factura. */
      noLeidas: leido.errores,
      periodosDocumento: [...new Set(leido.facturas.map((f) => f.periodoDocumento))],
    });
  } catch (e) {
    console.error("[facturas/upload]", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "No se pudo leer el PDF." },
      { status: 500 },
    );
  }
}
