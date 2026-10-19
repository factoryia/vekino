"use client";

import { useRef, useState } from "react";
import { useQuery } from "convex/react";
import { Upload, FileText, AlertCircle, CheckCircle, Loader2 } from "lucide-react";
import { api } from "@vekino/backend/api";
import type { Id } from "@vekino/backend/dataModel";
import {
  MENSAJE_LECTURA,
  MENSAJE_RECHAZO,
  etiquetaDePeriodo,
  type MotivoLectura,
  type MotivoRechazo,
} from "@vekino/backend/lecturaFactura";
import { emparejarLote, type ModoEmparejado } from "@/lib/emparejar-unidad";
import { fetchConSesion } from "@/lib/fetch-con-sesion";
import { leerRespuesta } from "@/lib/leer-respuesta";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Select } from "@/components/ui/input";
import { periodosElegibles } from "@vekino/backend/periodos";

/**
 * Carga de cuentas de cobro en PDF (Finanzas).
 *
 *   1. Vista previa: el servidor lee el PDF y devuelve cada factura con lo que
 *      dice su documento —período, total, saldo anterior— y si cuadra. No se
 *      publica ni se guarda nada.
 *   2. El período sale de los documentos, no del último cargado. Si los
 *      documentos no coinciden entre sí o con el período elegido, el lote se
 *      bloquea y se explica por qué.
 *   3. Confirmar: el servidor vuelve a leer el MISMO archivo (por su huella),
 *      publica en S3 solo lo que se inserta o actualiza y guarda. La pantalla
 *      muestra el resultado tal como lo devolvió el backend.
 *
 * Una factura que no cuadra no se descarta en silencio: entra "en revisión"
 * —es la vigente de su unidad, no puede faltar— y no se puede pagar hasta que
 * se corrija o se confirme en Finanzas.
 */

type Step = "idle" | "uploading" | "preview" | "inserting" | "done";

interface InvoiceRow {
  unitIdentifier: string;
  residenteNombre: string;
  numeroInterno: string;
  periodoLabel: string;
  periodoDocumento: string | null;
  apto?: string;
  totalAPagar: number;
  saldoAnteriorDocumento?: number;
  lineas: Array<{ saldoAnterior: number; total: number }>;
  motivos: MotivoLectura[];
  pageCount: number;
  format: "arboleda" | "cdc";
  // resolved after matching
  unidadId?: Id<"unidades">;
  matchStatus?: "ok" | "no-match";
  /** Cómo se resolvió: por número exacto o deduciendo la torre. */
  matchModo?: ModoEmparejado;
  /** "T II · 604" — solo cuando se dedujo la torre. */
  matchDetalle?: string;
}

type Resultado = {
  tipo: "nueva" | "repetida";
  insertadas: number;
  actualizadas: number;
  omitidas: number;
  marcadas: number;
  rechazadas: number;
  rechazos: Array<{ indice?: number; unidadId?: string; motivo: string }>;
  conciliacion?: { pagadas: number; abonadas: number; vencidas: number };
  publicadas: number;
};

function cop(n: number) {
  return new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(n);
}

function motivoRechazo(m: string): string {
  if (m === "sin_unidad") return "No se encontró la unidad en el conjunto.";
  return MENSAJE_RECHAZO[m as MotivoRechazo] ?? m;
}

export function UploadFacturas({
  condominioId,
  onDone,
}: {
  condominioId: Id<"condominios">;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("idle");
  const [periodo, setPeriodo] = useState("");
  const [soloNuevas, setSoloNuevas] = useState(true);
  const [archivo, setArchivo] = useState<File | null>(null);
  const [hash, setHash] = useState("");
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [noLeidas, setNoLeidas] = useState<Array<{ paginas: number[]; error: string }>>([]);
  const [result, setResult] = useState<Resultado | null>(null);
  const [errorConfirmacion, setErrorConfirmacion] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const unidades = useQuery(api.unidades.listByCondominio, { condominioId });

  function close() {
    setOpen(false);
    setStep("idle");
    setInvoices([]);
    setNoLeidas([]);
    setArchivo(null);
    setHash("");
    setPeriodo("");
    setResult(null);
    setErrorConfirmacion(null);
    setSoloNuevas(true);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setStep("uploading");
    setInvoices([]);
    setNoLeidas([]);
    setErrorConfirmacion(null);

    const form = new FormData();
    form.append("pdf", file);
    form.append("condominioId", condominioId);

    try {
      const res = await fetchConSesion("/api/facturas/upload", { method: "POST", body: form });
      const data = await leerRespuesta(res);
      if (!res.ok) throw new Error(data.error ?? "Error desconocido");

      /* Emparejamiento del LOTE COMPLETO, no factura por factura.
       * Hay conjuntos cuyo PDF pega la torre al número ("2604" = Torre II,
       * apto 604) y dejan una torre sin prefijo, lo que vuelve ambiguos
       * identificadores como "1101". Resolverlos juntos permite descartar por
       * eliminación: cada unidad se factura una sola vez por período.
       * Ver lib/emparejar-unidad.ts. */
      const crudas = data.invoices as InvoiceRow[];
      const emparejadas = emparejarLote(
        crudas.map((i) => i.unitIdentifier),
        (unidades ?? []).map((u) => ({
          _id: u._id as string,
          numero: u.numero,
          torre: u.torre,
        })),
      );

      const rows: InvoiceRow[] = crudas.map((inv, i) => {
        const r = emparejadas[i]!;
        return {
          ...inv,
          unidadId: (r.unidadId ?? undefined) as Id<"unidades"> | undefined,
          matchStatus: r.unidadId ? "ok" : "no-match",
          matchModo: r.modo ?? undefined,
          matchDetalle: r.detalle,
        };
      });

      /* El período lo dicen los documentos. */
      const delDocumento = [...new Set(rows.map((r) => r.periodoDocumento).filter((p): p is string => !!p))];
      if (delDocumento.length === 1) setPeriodo(delDocumento[0]!);

      setArchivo(file);
      setHash(data.hash as string);
      setInvoices(rows);
      setNoLeidas(data.noLeidas ?? []);
      setStep("preview");
    } catch (e: any) {
      alert("Error procesando PDF: " + e.message);
      setStep("idle");
    }
  }

  async function handleConfirm() {
    if (!archivo) return;
    setStep("inserting");
    setErrorConfirmacion(null);
    const form = new FormData();
    form.append("pdf", archivo);
    form.append("condominioId", condominioId);
    form.append("periodo", periodo);
    form.append("hash", hash);
    form.append("soloNuevas", soloNuevas ? "true" : "false");
    form.append(
      "asignaciones",
      JSON.stringify(
        invoices.flatMap((inv, indice) =>
          inv.matchStatus === "ok" && inv.unidadId ? [{ indice, unidadId: inv.unidadId }] : [],
        ),
      ),
    );
    try {
      const res = await fetchConSesion("/api/facturas/confirmar", { method: "POST", body: form });
      const data = await leerRespuesta(res);
      if (!res.ok) throw new Error(data.error ?? "Error desconocido");
      setResult(data as Resultado);
      setStep("done");
    } catch (e: any) {
      setErrorConfirmacion(e.message);
      setStep("preview");
    }
  }

  // ── Resumen del lote antes de confirmar
  const periodosDocumento = [...new Set(invoices.map((i) => i.periodoDocumento).filter((p): p is string => !!p))];
  const bloqueo =
    periodosDocumento.length > 1
      ? `Los documentos son de períodos distintos (${periodosDocumento.map(etiquetaDePeriodo).join(", ")}). Sube un PDF por período.`
      : periodosDocumento.length === 1 && periodo !== periodosDocumento[0]
        ? `El documento es de ${etiquetaDePeriodo(periodosDocumento[0]!)} y el período elegido es ${periodo ? etiquetaDePeriodo(periodo) : "—"}.`
        : !periodo
          ? "Elige el período: los documentos no lo traen legible."
          : null;
  const conUnidad = invoices.filter((i) => i.matchStatus === "ok");
  const enRevision = conUnidad.filter((i) => i.motivos.length > 0).length;
  const sinUnidad = invoices.filter((i) => i.matchStatus === "no-match").length;
  // Emparejadas deduciendo la torre: merecen una mirada antes de insertar.
  const porTorreCount = conUnidad.filter((i) => i.matchModo === "torre" || i.matchModo === "deducido").length;
  const multiPagina = invoices.filter((i) => i.pageCount > 1).length;
  const opcionesPeriodo = [...new Set([...periodosElegibles(), ...periodosDocumento])].sort().reverse();
  // Las marcadas en revisión ya van contadas entre insertadas y actualizadas.
  const sinCarga = result?.tipo === "nueva" && result.insertadas + result.actualizadas === 0;

  const footer =
    step === "done" ? (
      <Button size="sm" onClick={() => { close(); onDone(); }}>
        Ver facturas
      </Button>
    ) : step === "preview" ? (
      <>
        <Button variant="ghost" size="sm" onClick={close}>
          Cancelar
        </Button>
        <Button size="sm" onClick={handleConfirm} disabled={conUnidad.length === 0 || bloqueo !== null}>
          Confirmar {conUnidad.length} facturas
        </Button>
      </>
    ) : (
      <Button variant="ghost" size="sm" onClick={close}>
        Cerrar
      </Button>
    );

  return (
    <>
      <Button variant="brand" onClick={() => setOpen(true)}>
        <Upload className="h-4 w-4" aria-hidden />
        Subir facturas
      </Button>

      <Modal
        open={open}
        onClose={close}
        title="Subir facturas"
        description="PDF con todas las facturas del período · se divide automáticamente"
        className="max-w-3xl"
        footer={footer}
      >
        {/* Step: idle / uploading */}
        {(step === "idle" || step === "uploading") && (
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground">
              El período se toma de los documentos. Nada se publica ni se guarda hasta que confirmes.
            </p>
            <div
              onClick={() => fileRef.current?.click()}
              className="flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-border px-6 py-10 transition-colors hover:border-brand/40 hover:bg-accent/40"
            >
              {step === "uploading" ? (
                <>
                  <Loader2 className="h-8 w-8 animate-spin text-brand" aria-hidden />
                  <p className="text-sm text-muted-foreground">Leyendo PDF… puede tardar un momento</p>
                </>
              ) : (
                <>
                  <FileText className="h-8 w-8 text-muted-foreground/40" aria-hidden />
                  <p className="text-sm font-medium text-foreground">Haz clic para seleccionar el PDF</p>
                  <p className="text-xs text-muted-foreground">
                    PDF con todas las facturas · se detectan facturas de varias hojas
                  </p>
                </>
              )}
              <input
                ref={fileRef}
                type="file"
                accept="application/pdf"
                className="hidden"
                onChange={handleFile}
                disabled={step === "uploading"}
              />
            </div>
          </div>
        )}

        {/* Step: preview */}
        {step === "preview" && (
          <div className="space-y-3">
            <div className="grid grid-cols-4 gap-2 rounded-xl bg-muted/50 p-3 text-center text-xs">
              <div>
                <p className="text-lg font-semibold tabular-nums text-foreground">{invoices.length}</p>
                <p className="text-muted-foreground">leídas</p>
              </div>
              <div>
                <p className="text-lg font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">{conUnidad.length - enRevision}</p>
                <p className="text-muted-foreground">entran</p>
              </div>
              <div>
                <p className={`text-lg font-semibold tabular-nums ${enRevision > 0 ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground/50"}`}>{enRevision}</p>
                <p className="text-muted-foreground">entran en revisión</p>
              </div>
              <div>
                <p className={`text-lg font-semibold tabular-nums ${sinUnidad + noLeidas.length > 0 ? "text-red-600 dark:text-red-400" : "text-muted-foreground/50"}`}>{sinUnidad + noLeidas.length}</p>
                <p className="text-muted-foreground">no entran</p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 text-sm">
              <label className="text-xs font-medium text-foreground">Período</label>
              <Select value={periodo} onChange={(e) => setPeriodo(e.target.value)} className="w-40">
                <option value="">—</option>
                {opcionesPeriodo.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </Select>
              {periodosDocumento.length === 1 ? (
                <span className="text-xs text-muted-foreground">
                  según los documentos: {etiquetaDePeriodo(periodosDocumento[0]!)}
                </span>
              ) : null}
            </div>

            {bloqueo && (
              <div className="flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">
                <AlertCircle className="h-4 w-4 shrink-0" aria-hidden />
                {bloqueo}
              </div>
            )}

            {errorConfirmacion && (
              <div className="flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">
                <AlertCircle className="h-4 w-4 shrink-0" aria-hidden />
                {errorConfirmacion}
              </div>
            )}

            {enRevision > 0 && (
              <div className="flex items-start gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                <p>
                  {enRevision} factura{enRevision > 1 ? "s" : ""} no cuadra{enRevision > 1 ? "n" : ""} con su documento.
                  Entra{enRevision > 1 ? "n" : ""} en revisión: no se podrá{enRevision > 1 ? "n" : ""} pagar hasta que se corrija{enRevision > 1 ? "n" : ""} o se confirme{enRevision > 1 ? "n" : ""} en Finanzas.
                </p>
              </div>
            )}

            {(multiPagina > 0 || porTorreCount > 0) && (
              <p className="text-xs text-muted-foreground">
                {multiPagina > 0 && `${multiPagina} factura${multiPagina > 1 ? "s" : ""} de varias hojas agrupada${multiPagina > 1 ? "s" : ""}. `}
                {porTorreCount > 0 && `${porTorreCount} unidad${porTorreCount > 1 ? "es" : ""} deducida${porTorreCount > 1 ? "s" : ""} por torre: revísala${porTorreCount > 1 ? "s" : ""}.`}
              </p>
            )}

            {noLeidas.length > 0 && (
              <div className="rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-600 dark:text-red-400">
                <p className="mb-1 font-medium">No se pudieron leer ({noLeidas.length}):</p>
                {noLeidas.map((e, i) => (
                  <p key={i}>Páginas {e.paginas.join(",")}: {e.error}</p>
                ))}
              </div>
            )}

            <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm">
              <input
                type="checkbox"
                checked={soloNuevas}
                onChange={(e) => setSoloNuevas(e.target.checked)}
                className="accent-brand"
              />
              <span className="font-medium text-foreground">Solo insertar facturas nuevas</span>
              <span className="text-muted-foreground">(omite las que ya existen)</span>
            </label>

            <div className="max-h-[22rem] overflow-auto rounded-xl border border-border">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border bg-muted/40 text-left text-muted-foreground">
                    <th className="px-3 py-2 font-medium">Unidad</th>
                    <th className="px-3 py-2 font-medium">Período</th>
                    <th className="px-3 py-2 text-right font-medium">Saldo ant.</th>
                    <th className="px-3 py-2 text-right font-medium">Total</th>
                    <th className="px-3 py-2 font-medium">Lectura</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {invoices.map((inv, idx) => {
                    const saldoAnterior =
                      inv.saldoAnteriorDocumento ?? inv.lineas.reduce((s, l) => s + l.saldoAnterior, 0);
                    const otroPeriodo = inv.periodoDocumento !== null && inv.periodoDocumento !== periodo;
                    return (
                      <tr key={idx} className={inv.matchStatus === "no-match" ? "bg-red-500/5" : inv.motivos.length > 0 ? "bg-amber-500/5" : ""}>
                        <td className="px-3 py-1.5 font-mono font-medium text-foreground">
                          {inv.unitIdentifier || "?"}
                          {inv.matchDetalle ? (
                            <span className="ml-1.5 font-sans text-[11px] font-normal text-muted-foreground">
                              → {inv.matchDetalle}
                            </span>
                          ) : null}
                          {inv.matchStatus === "no-match" ? (
                            <span className="ml-1.5 inline-flex items-center gap-0.5 font-sans text-red-500">
                              <AlertCircle className="h-3.5 w-3.5" aria-hidden /> sin unidad
                            </span>
                          ) : inv.matchModo === "torre" || inv.matchModo === "deducido" ? (
                            <span className="ml-1.5 font-sans text-amber-600 dark:text-amber-400" title="La unidad se dedujo del identificador y del resto del lote. Revísala.">
                              por torre
                            </span>
                          ) : null}
                        </td>
                        <td className={`px-3 py-1.5 ${otroPeriodo ? "font-semibold text-red-600 dark:text-red-400" : "text-muted-foreground"}`}>
                          {inv.periodoDocumento ? etiquetaDePeriodo(inv.periodoDocumento) : "ilegible"}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{cop(saldoAnterior)}</td>
                        <td className="px-3 py-1.5 text-right font-semibold tabular-nums text-foreground">{cop(inv.totalAPagar)}</td>
                        <td className="px-3 py-1.5">
                          {inv.motivos.length === 0 ? (
                            <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                              <CheckCircle className="h-3.5 w-3.5" aria-hidden /> cuadra
                            </span>
                          ) : (
                            <span className="text-amber-700 dark:text-amber-400" title={inv.motivos.map((m) => MENSAJE_LECTURA[m]).join(" ")}>
                              en revisión: {inv.motivos.map((m) => MENSAJE_LECTURA[m]).join(" ")}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Step: inserting */}
        {step === "inserting" && (
          <div className="flex flex-col items-center gap-4 py-8">
            <Loader2 className="h-10 w-10 animate-spin text-brand" aria-hidden />
            <p className="text-sm text-foreground">Confirmando la carga… se vuelve a leer el PDF y se publican los documentos.</p>
          </div>
        )}

        {/* Step: done */}
        {step === "done" && result && (
          <div className="flex flex-col items-center gap-4 py-6 text-center">
            {/* Un lote en el que no entró ninguna factura (todas rechazadas u
              * omitidas) no se da por cargado: el detalle de abajo dice por qué. */}
            {sinCarga ? (
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-amber-500/10">
                <AlertCircle className="h-8 w-8 text-amber-500" aria-hidden />
              </div>
            ) : (
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/10">
                <CheckCircle className="h-8 w-8 text-emerald-500" aria-hidden />
              </div>
            )}
            <div>
              <p className="text-lg font-semibold text-foreground">
                {result.tipo === "repetida"
                  ? "Este archivo ya se había cargado"
                  : sinCarga
                    ? "No se cargó ninguna factura"
                    : "¡Facturas cargadas!"}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {result.insertadas} nuevas
                {result.actualizadas > 0 && ` · ${result.actualizadas} actualizadas`}
                {result.omitidas > 0 && ` · ${result.omitidas} omitidas`}
                {result.marcadas > 0 && ` · ${result.marcadas} en revisión`}
                {result.rechazadas > 0 && ` · ${result.rechazadas} no entraron`}
              </p>
              {result.tipo === "repetida" ? (
                <p className="mt-1 text-xs text-muted-foreground">No se publicó ni se guardó nada otra vez.</p>
              ) : null}
            </div>

            {result.rechazos.length > 0 && (
              <div className="w-full max-w-md rounded-xl border border-red-500/20 bg-red-500/5 p-3 text-left text-xs text-red-700 dark:text-red-400">
                <p className="mb-1 font-semibold">No entraron:</p>
                {Object.entries(
                  result.rechazos.reduce<Record<string, number>>((m, r) => {
                    m[r.motivo] = (m[r.motivo] ?? 0) + 1;
                    return m;
                  }, {}),
                ).map(([motivo, n]) => (
                  <p key={motivo}>{n} · {motivoRechazo(motivo)}</p>
                ))}
              </div>
            )}

            {result.conciliacion && (result.conciliacion.pagadas > 0 || result.conciliacion.abonadas > 0 || result.conciliacion.vencidas > 0) && (
              <div className="w-full max-w-sm rounded-xl border border-border bg-muted/40 p-4 text-left">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Conciliación automática del mes anterior
                </p>
                <div className="space-y-1.5 text-sm">
                  {result.conciliacion.pagadas > 0 && (
                    <p className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400">
                      <CheckCircle className="h-4 w-4 shrink-0" aria-hidden />
                      {result.conciliacion.pagadas} factura{result.conciliacion.pagadas === 1 ? "" : "s"} anterior{result.conciliacion.pagadas === 1 ? "" : "es"} marcada{result.conciliacion.pagadas === 1 ? "" : "s"} como pagada{result.conciliacion.pagadas === 1 ? "" : "s"}
                    </p>
                  )}
                  {result.conciliacion.abonadas > 0 && (
                    <p className="flex items-center gap-2 text-sky-600 dark:text-sky-400">
                      <CheckCircle className="h-4 w-4 shrink-0" aria-hidden />
                      {result.conciliacion.abonadas} con abono parcial
                    </p>
                  )}
                  {result.conciliacion.vencidas > 0 && (
                    <p className="flex items-center gap-2 text-red-600 dark:text-red-400">
                      <AlertCircle className="h-4 w-4 shrink-0" aria-hidden />
                      {result.conciliacion.vencidas} sin pago (vencida{result.conciliacion.vencidas === 1 ? "" : "s"})
                    </p>
                  )}
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Según el saldo anterior que reporta cada factura nueva. Las facturas en revisión no se usan para juzgar.
                </p>
              </div>
            )}
          </div>
        )}
      </Modal>
    </>
  );
}
