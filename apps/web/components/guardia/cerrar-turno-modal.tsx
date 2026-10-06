"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Loader2, Lock, StopCircle, Users } from "lucide-react";
import { api } from "@vekino/backend/api";
import type { Doc, Id } from "@vekino/backend/dataModel";
import { erroresCierreTurno } from "@vekino/backend/cierreTurno";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Skeleton } from "@/components/ui/skeleton";
import { Input, Select, Textarea } from "@/components/ui/input";
import { mensajeErrorUsuario } from "@/lib/utils";

/*
 * El cierre formal del turno, aparte de la página de la portería porque se
 * abre desde dos sitios: la minuta de su conjunto, y la portería que el guarda
 * cubre cuando dejó abierto el turno de su conjunto de siempre (la excepción
 * de la cobertura; ver `guardia.turnoPendienteDeCierre`).
 */

/** Valor del selector de relevo para escribir el nombre a mano. */
const RELEVO_OTRO = "__otro__";

export function CerrarTurnoModal({
  turno, stats, condominioNombre, onClose,
}: {
  turno: Doc<"guardiaTurnos"> & { rondasCount: number };
  /** El resumen del turno. Desde otra portería no se tiene: no se pinta. */
  stats?: { visitantes: number; paquetes: number; incidentes: number; rondas: number };
  /** Si el turno es de otro conjunto (la excepción de la cobertura), cuál. */
  condominioNombre?: string;
  onClose: () => void;
}) {
  const cerrar = useMutation(api.guardia.cerrarTurno);
  /* Los relevos salen de la MISMA autorización que el cierre: así también
   * los recibe el guarda que cierra su turno desde la portería que cubre. */
  const equipo = useQuery(api.guardia.relevosDelTurno, { turnoId: turno._id });
  const [hayNovedades, setHayNovedades] = useState(false);
  const [detalleNovedades, setDetalleNovedades] = useState("");
  const [relevo, setRelevo] = useState("");
  const [relevoManual, setRelevoManual] = useState("");
  const [consignas, setConsignas] = useState("");
  const [obs, setObs] = useState("");
  const [intentado, setIntentado] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* Quien entrega no se ofrece como relevo: ni el que abrió ni su compañero.
   * Ya viene filtrado del servidor. */
  const opciones = equipo ?? [];
  /* Cuenta compartida o portería sin más usuarios: el relevo se escribe. */
  const manual = relevo === RELEVO_OTRO || (equipo !== undefined && opciones.length === 0);
  const recibeNombre = manual
    ? relevoManual
    : opciones.find((g) => g.userId === relevo)?.nombre ?? "";
  const elementos = turno.checklist;

  const errores = erroresCierreTurno({
    consignas,
    recibe: recibeNombre,
    observacionesCierre: obs,
    novedadesElementos: hayNovedades,
    novedadesElementosDetalle: detalleNovedades,
    elementosAsignados: elementos.length,
  });
  const mostrar = (campo: keyof typeof errores) => (intentado ? errores[campo] : undefined);

  async function confirmar() {
    setIntentado(true);
    if (Object.keys(errores).length > 0) return;
    setBusy(true); setError(null);
    try {
      await cerrar({
        turnoId: turno._id,
        ...(manual ? { recibe: relevoManual } : { recibeUserId: relevo as Id<"users"> }),
        consignas,
        observacionesCierre: obs,
        novedadesElementos: hayNovedades,
        novedadesElementosDetalle: hayNovedades ? detalleNovedades : undefined,
      });
      onClose();
    } catch (e) {
      setError(mensajeErrorUsuario(e, "No se pudo cerrar el turno."));
      setBusy(false);
    }
  }

  return (
    <Modal
      open onClose={onClose}
      title={condominioNombre ? `Cierre de turno en ${condominioNombre}` : "Cierre formal de turno"}
      description="Entrega la portería, sus elementos y las consignas al relevo"
      className="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>Cancelar</Button>
          <Button variant="destructive" size="sm" onClick={confirmar} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <StopCircle className="h-4 w-4" />}
            Cerrar turno
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {stats && (
          <div className="grid grid-cols-4 gap-2 rounded-xl bg-muted/40 p-3 text-center">
            {[["Visitantes", stats.visitantes], ["Paquetes", stats.paquetes], ["Rondas", stats.rondas], ["Incidentes", stats.incidentes]].map(([l, vNum]) => (
              <div key={l as string}>
                <p className="text-lg font-bold tabular-nums text-foreground">{vNum as number}</p>
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{l as string}</p>
              </div>
            ))}
          </div>
        )}
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-foreground">Entrega el turno</label>
          <Input value={turno.guardiaNombre} disabled className="bg-muted/40" />
        </div>

        {/* Los elementos son los que se firmaron al iniciar: aquí solo se leen. */}
        <div className="space-y-2">
          <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <Lock className="h-3.5 w-3.5" /> Elementos asignados
          </p>
          {elementos.length === 0 ? (
            <p className="rounded-lg bg-muted/40 p-3 text-sm text-muted-foreground">
              Este turno no registró elementos al iniciar.
            </p>
          ) : (
            <ul className="divide-y divide-border rounded-xl border border-border">
              {elementos.map((c, i) => (
                <li key={i} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                  <span className="min-w-0 text-foreground">{c.item}</span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="tabular-nums text-muted-foreground">{c.cantidadEncontrada}/{c.cantidadEsperada}</span>
                    {!c.estadoOk && (
                      <span className="max-w-48 truncate rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-700" title={c.observacion}>
                        Al recibir: {c.observacion || "con novedad"}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="text-[11px] text-muted-foreground">
            Registrados al iniciar el turno. No se modifican al cerrarlo.
          </p>
        </div>

        {elementos.length > 0 && (
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm font-medium text-foreground">
              <input
                type="checkbox"
                checked={hayNovedades}
                onChange={(e) => setHayNovedades(e.target.checked)}
                className="h-4 w-4 rounded border-border accent-brand"
              />
              ¿Existen novedades con los elementos asignados?
            </label>
            {hayNovedades && (
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-foreground">Detalle de la novedad *</label>
                <Textarea
                  value={detalleNovedades}
                  onChange={(e) => setDetalleNovedades(e.target.value)}
                  rows={3}
                  placeholder="Ej. La linterna presenta daño en el interruptor y el radio tiene la batería descargada."
                  aria-invalid={!!mostrar("novedadesElementosDetalle")}
                  autoFocus
                />
                <CampoError mensaje={mostrar("novedadesElementosDetalle")} />
              </div>
            )}
            <CampoError mensaje={mostrar("novedadesElementos")} />
          </div>
        )}

        <div className="space-y-1.5">
          <label className="flex items-center gap-1.5 text-xs font-medium text-foreground">
            <Users className="h-3.5 w-3.5" /> Guarda que recibe el turno *
          </label>
          {equipo === undefined ? (
            <Skeleton className="h-10 rounded-lg" />
          ) : opciones.length > 0 ? (
            <Select value={relevo} onChange={(e) => setRelevo(e.target.value)} aria-invalid={!!mostrar("recibe") && !manual}>
              <option value="">Selecciona el guarda…</option>
              {opciones.map((g) => <option key={g.userId} value={g.userId}>{g.nombre}</option>)}
              <option value={RELEVO_OTRO}>Otro guarda (escribir nombre)</option>
            </Select>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              No hay otros guardas registrados en esta portería: escribe el nombre del relevo.
            </p>
          )}
          {manual && (
            <Input
              value={relevoManual}
              onChange={(e) => setRelevoManual(e.target.value)}
              placeholder="Nombre de quien recibe el turno"
              aria-invalid={!!mostrar("recibe")}
            />
          )}
          <CampoError mensaje={mostrar("recibe")} />
        </div>

        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-foreground">Consignas / pendientes para el relevo *</label>
          <Textarea
            value={consignas}
            onChange={(e) => setConsignas(e.target.value)}
            rows={3}
            placeholder="Qué queda pendiente, llaves, paquetes por entregar…"
            aria-invalid={!!mostrar("consignas")}
          />
          <CampoError mensaje={mostrar("consignas")} />
        </div>

        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-foreground">Observaciones generales del cierre *</label>
          <Textarea
            value={obs}
            onChange={(e) => setObs(e.target.value)}
            rows={3}
            placeholder="Ej. Turno finalizado sin novedades adicionales. Se entrega puesto, documentación y elementos al guarda de relevo."
            aria-invalid={!!mostrar("observacionesCierre")}
          />
          <CampoError mensaje={mostrar("observacionesCierre")} />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
    </Modal>
  );
}

function CampoError({ mensaje }: { mensaje?: string }) {
  if (!mensaje) return null;
  return <p className="text-xs text-destructive">{mensaje}</p>;
}
