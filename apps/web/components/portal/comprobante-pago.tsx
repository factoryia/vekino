"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { useAction, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@vekino/backend/api";
import type { Id } from "@vekino/backend/dataModel";
import { montoAPagarHoy } from "@vekino/backend/cartera";
import { Camera, FileUp, Loader2, Receipt } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { Input } from "@/components/ui/input";
import { fechaPlazo } from "@/components/portal/portal-ui";
import { cn, cop, mensajeErrorUsuario } from "@/lib/utils";
import {
  ACCEPT_COMPROBANTE,
  hoyEnBogota,
  leerFechaPago,
  leerMontoCOP,
  montoConPuntos,
  problemaDeArchivo,
} from "@/lib/comprobante-pago";

type FacturaComprobante = {
  _id: Id<"facturas">;
  periodo: string;
  totalAPagar: number;
  totalConDescuento?: number | null;
  fechaLimiteDescuento?: number | null;
  /** Pagos aprobados: la sugerencia de "¿Cuánto pagaste?" ya descuenta lo abonado (H1). */
  estadoPago?: { estado: "pagada" | "abonada"; montoPagado: number } | null;
};

type Soporte = FunctionReturnType<typeof api.soportesPago.listMios>[number];

const ESTADO_SOPORTE: Record<
  Soporte["estado"],
  { label: string; tone: "warning" | "success" | "destructive" }
> = {
  pendiente_revision: { label: "Pendiente de revisión", tone: "warning" },
  aprobado: { label: "Aprobado", tone: "success" },
  rechazado: { label: "Rechazado", tone: "destructive" },
};

type Props = {
  condominioId: Id<"condominios">;
  factura: FacturaComprobante;
  vigente?: boolean;
  className?: string;
};

/**
 * "Ya pagué, enviar comprobante" y "Mis comprobantes" de UNA factura, en la
 * web del residente (Hallazgo 1).
 *
 * Quién lo ve lo decide el backend, no la pantalla:
 * - el botón, con `pagos.opcionesDePago.debe` (la vigente de una unidad
 *   suya, con vínculo vigente, con saldo, sin revisión ni pago en
 *   verificación), aunque la pasarela no acepte la unidad (`pasarela`);
 * - y se oculta mientras haya un comprobante en revisión para la factura
 *   (`soportesPago.listMios`), porque el backend acepta uno solo.
 *
 * El envío es UNA llamada a `soportesPago.enviarMio`, con el archivo: el
 * backend valida, sube con su propia llave y registra. El navegador no habla
 * con el bucket ni elige carpeta ni URL. (El móvil sigue con
 * `generateUploadUrl` + PUT + `crearMio`.)
 *
 * `vigente={false}` (una histórica) no pregunta nada: solo muestra los
 * comprobantes que ya se enviaron para ella.
 *
 * Si una de sus consultas falla (por ejemplo, un backend sin
 * `opcionesDePago`), el componente desaparece y la factura y la página
 * siguen: `useQuery` lanza el error al pintar, y lo recoge este borde.
 */
export function ComprobantePago(props: Props) {
  return (
    <ErrorBoundary resetKey={props.factura._id} fallback={() => null}>
      <ComprobantePagoContenido {...props} />
    </ErrorBoundary>
  );
}

function ComprobantePagoContenido({ condominioId, factura, vigente = true, className }: Props) {
  const opciones = useQuery(
    api.pagos.opcionesDePago,
    vigente ? { facturaId: factura._id } : "skip",
  );
  const soportes = useQuery(api.soportesPago.listMios, { condominioId });
  const enviarMio = useAction(api.soportesPago.enviarMio);

  const id = useId();
  const [abierto, setAbierto] = useState(false);
  const [monto, setMonto] = useState("");
  const [fecha, setFecha] = useState("");
  const [nota, setNota] = useState("");
  const [archivo, setArchivo] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [recienEnviado, setRecienEnviado] = useState<Id<"soportesPago"> | null>(null);
  /* El candado de verdad contra el doble envío. `enviando` deshabilita el
   * botón en el SIGUIENTE render; un doble clic o dos Enter seguidos llegan
   * antes, y cada uno mandaría el archivo otra vez. */
  const enviandoRef = useRef(false);
  const archivoRef = useRef<HTMLInputElement>(null);
  const camaraRef = useRef<HTMLInputElement>(null);

  const mios = (soportes ?? []).filter((s) => s.facturaId === factura._id);
  /* El recién enviado cuenta como en revisión hasta que `listMios` lo traiga:
   * si no, el botón reaparece un instante y un segundo clic mandaría otro
   * archivo que el backend rechazaría. */
  const sinListar = recienEnviado !== null && !mios.some((s) => s._id === recienEnviado);
  const enRevision = sinListar || mios.some((s) => s.estado === "pendiente_revision");
  const recienEnRevision =
    sinListar || mios.some((s) => s._id === recienEnviado && s.estado === "pendiente_revision");
  const puedeEnviar =
    vigente && opciones?.debe === true && soportes !== undefined && !enRevision;

  if (!puedeEnviar && mios.length === 0 && !sinListar && !error) return null;

  const hoy = hoyEnBogota();
  const montoLeido = leerMontoCOP(monto);

  function abrir() {
    const sugerido = montoAPagarHoy(factura, Date.now());
    setMonto(sugerido > 0 ? montoConPuntos(sugerido) : "");
    setFecha(hoyEnBogota());
    setNota("");
    setArchivo(null);
    setError(null);
    setAbierto(true);
  }

  function cancelar() {
    setAbierto(false);
    setArchivo(null);
    setError(null);
  }

  function elegir(file: File | null | undefined) {
    if (!file) return;
    const problema = problemaDeArchivo(file);
    setArchivo(problema ? null : file);
    setError(problema);
  }

  async function enviar(e?: FormEvent) {
    e?.preventDefault();
    if (enviandoRef.current) return;

    /* Ayudas de formulario: avisan antes de mandar el archivo. Decide el
     * backend, que vuelve a revisar todo. */
    const m = leerMontoCOP(monto);
    if (!m.ok) return setError(m.error);
    const f = leerFechaPago(fecha);
    if (!f.ok) return setError(f.error);
    if (!archivo) return setError("Elige la foto o el PDF del comprobante.");
    const problema = problemaDeArchivo(archivo);
    if (problema) return setError(problema);

    enviandoRef.current = true;
    setEnviando(true);
    setError(null);
    try {
      const soporteId = await enviarMio({
        condominioId,
        facturaId: factura._id,
        monto: m.monto,
        fechaPago: f.fechaPago,
        nombreArchivo: archivo.name,
        archivo: await archivo.arrayBuffer(),
        ...(nota.trim() ? { nota: nota.trim() } : {}),
      });
      setRecienEnviado(soporteId);
      setAbierto(false);
      setArchivo(null);
      setNota("");
    } catch (err) {
      /* Los mensajes del backend son estables: van tal cual, sin el
       * envoltorio de Convex. */
      setError(mensajeErrorUsuario(err, "No se pudo enviar el comprobante. Inténtalo de nuevo."));
    } finally {
      enviandoRef.current = false;
      setEnviando(false);
    }
  }

  return (
    <div className={cn("space-y-3", className)}>
      {mios.length > 0 || sinListar ? (
        <div>
          <p className="text-sm font-semibold text-foreground">Mis comprobantes</p>
          {recienEnRevision ? (
            <p role="status" className="mt-1 text-sm text-foreground/80">
              Comprobante enviado. La administración lo revisará y te confirmará el pago.
            </p>
          ) : null}
          <ul className="mt-2 space-y-2">
            {sinListar ? (
              <li className="rounded-lg border border-border/70 bg-card/60 px-3 py-2.5 text-sm">
                <Badge tone="warning">Pendiente de revisión</Badge>
              </li>
            ) : null}
            {mios.map((s) => (
              <SoporteItem key={s._id} s={s} puedeReenviar={puedeEnviar} />
            ))}
          </ul>
        </div>
      ) : null}

      {puedeEnviar && !abierto ? (
        <Button
          type="button"
          variant="outline"
          onClick={abrir}
          className="min-h-11 w-full gap-2 px-4 text-[15px] sm:w-auto"
        >
          <Receipt className="h-4 w-4" aria-hidden />
          Ya pagué, enviar comprobante
        </Button>
      ) : null}

      {puedeEnviar && abierto ? (
        <form
          onSubmit={enviar}
          noValidate
          aria-label="Enviar comprobante de pago"
          className="space-y-3 rounded-xl border border-border bg-card/70 p-3 sm:p-4"
        >
          <p className="text-sm font-semibold text-foreground">Enviar comprobante de pago</p>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="min-w-0 space-y-1.5">
              <label htmlFor={`${id}-monto`} className="text-xs font-medium text-muted-foreground">
                ¿Cuánto pagaste? *
              </label>
              <Input
                id={`${id}-monto`}
                name="monto"
                inputMode="numeric"
                autoComplete="off"
                placeholder="380.000"
                value={monto}
                onChange={(e) => setMonto(e.target.value)}
                aria-describedby={`${id}-monto-ayuda`}
                className="h-11 text-base"
              />
              <p id={`${id}-monto-ayuda`} className="text-xs text-muted-foreground">
                {montoLeido.ok ? `Vas a declarar ${cop(montoLeido.monto)}` : "En pesos, por ejemplo 380.000"}
              </p>
            </div>
            <div className="min-w-0 space-y-1.5">
              <label htmlFor={`${id}-fecha`} className="text-xs font-medium text-muted-foreground">
                ¿Qué día pagaste? *
              </label>
              <Input
                id={`${id}-fecha`}
                name="fecha"
                type="date"
                max={hoy}
                value={fecha}
                onChange={(e) => setFecha(e.target.value)}
                className="h-11 text-base"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <span id={`${id}-archivo`} className="text-xs font-medium text-muted-foreground">
              Foto o PDF del comprobante *
            </span>
            <input
              ref={archivoRef}
              type="file"
              accept={ACCEPT_COMPROBANTE}
              className="hidden"
              aria-labelledby={`${id}-archivo`}
              onChange={(e) => {
                elegir(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            <input
              ref={camaraRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              aria-labelledby={`${id}-archivo`}
              onChange={(e) => {
                elegir(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            <div className="grid grid-cols-2 gap-2 sm:flex">
              <Button
                type="button"
                variant="outline"
                onClick={() => camaraRef.current?.click()}
                disabled={enviando}
                className="min-h-11 gap-2 px-3 text-sm"
              >
                <Camera className="h-4 w-4" aria-hidden />
                Tomar foto
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => archivoRef.current?.click()}
                disabled={enviando}
                className="min-h-11 gap-2 px-3 text-sm"
              >
                <FileUp className="h-4 w-4" aria-hidden />
                Elegir archivo
              </Button>
            </div>
            <p className="break-all text-xs text-muted-foreground">
              {archivo
                ? `${archivo.name} · ${(archivo.size / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`
                : "JPG, PNG, WebP o PDF · máximo 10 MB"}
            </p>
          </div>

          <div className="space-y-1.5">
            <label htmlFor={`${id}-nota`} className="text-xs font-medium text-muted-foreground">
              Nota para la administración (opcional)
            </label>
            <textarea
              id={`${id}-nota`}
              name="nota"
              rows={2}
              maxLength={500}
              value={nota}
              onChange={(e) => setNota(e.target.value)}
              className="w-full rounded-lg border border-input bg-card px-3 py-2 text-base text-foreground placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            />
          </div>

          {enviando ? (
            <p aria-live="polite" className="text-xs text-muted-foreground">
              Subiendo el comprobante. Con una foto grande o una red lenta puede tardar un poco.
            </p>
          ) : null}
          {/* Junto al botón que se acaba de tocar: en el celular, debajo del
              formulario podría quedar fuera de la pantalla. */}
          {error ? (
            <p role="alert" className="text-sm leading-snug text-destructive">
              {error}
            </p>
          ) : null}

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="ghost"
              onClick={cancelar}
              disabled={enviando}
              className="min-h-11"
            >
              Cancelar
            </Button>
            <Button type="submit" variant="brand" disabled={enviando} className="min-h-11 gap-2 px-5 text-[15px]">
              {enviando ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  Enviando…
                </>
              ) : (
                "Enviar comprobante"
              )}
            </Button>
          </div>
        </form>
      ) : null}

      {/* Con el formulario cerrado (p. ej. otro envío de la familia ocultó
          el botón mientras este subía), el rechazo se sigue viendo. */}
      {error && !(puedeEnviar && abierto) ? (
        <p role="alert" className="text-sm leading-snug text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function SoporteItem({ s, puedeReenviar }: { s: Soporte; puedeReenviar: boolean }) {
  const meta = ESTADO_SOPORTE[s.estado];
  return (
    <li className="rounded-lg border border-border/70 bg-card/60 px-3 py-2.5 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Badge tone={meta.tone}>{meta.label}</Badge>
        <span className="font-semibold tabular-nums text-foreground">
          {s.monto != null ? cop(s.monto) : "Sin monto declarado"}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {s.fechaPago != null ? `Pagado el ${fechaPlazo(s.fechaPago)} · ` : ""}
        Enviado el {fechaPlazo(s.createdAt)}
      </p>
      {s.estado === "rechazado" ? (
        <p className="mt-1 text-xs text-foreground">
          Motivo: {s.notaRevision?.trim() || "la administración no lo indicó."}
          {puedeReenviar ? " Puedes enviar uno nuevo." : ""}
        </p>
      ) : s.estado === "pendiente_revision" ? (
        <p className="mt-1 text-xs text-muted-foreground">La administración lo está revisando.</p>
      ) : (
        <p className="mt-1 text-xs text-muted-foreground">Tu pago quedó registrado.</p>
      )}
      <a
        href={s.url}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-1 inline-flex min-h-8 items-center text-xs font-medium text-brand hover:underline"
      >
        Ver archivo
      </a>
    </li>
  );
}
