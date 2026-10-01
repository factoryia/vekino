"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "convex/react";
import { Clock3, LogOut } from "lucide-react";
import { api } from "@vekino/backend/api";
import type { Id } from "@vekino/backend/dataModel";
import {
  horaColombia,
  nombreParaSaludo,
  type Franja,
} from "@vekino/backend/recordatorioCierre";
import { Button } from "@/components/ui/button";
import { useBrandThemeStyle } from "@/lib/brand-theme";
import { useRecordatorioCierre } from "@/hooks/use-recordatorio-cierre";

/**
 * Recordatorio de cierre de turno y sesión, montado en el shell de portería.
 *
 * Solo recuerda: no cierra el turno, no cierra la sesión y no bloquea nada más
 * allá de pedir que lo lea. `activo` lo decide el shell con los criterios de
 * rol de siempre (`recibeRecordatorioCierre`).
 */
export function RecordatorioCierreTurno({
  condominioId,
  userId,
  nombre,
  activo,
}: {
  condominioId: Id<"condominios">;
  userId: string;
  /** Nombre visible del usuario en sesión (`guardia.home`). */
  nombre: string;
  activo: boolean;
}) {
  const { pendiente, confirmar } = useRecordatorioCierre(activo ? userId : null);
  /* La misma consulta que ya pinta el chip "Turno abierto" del shell: Convex
   * la comparte, no es una lectura más. Solo se lee; el recordatorio no abre
   * ni cierra turnos. */
  const turno = useQuery(
    api.guardia.turnoActivo,
    pendiente ? { condominioId } : "skip",
  );

  if (!pendiente || turno === undefined) return null;

  const esSuyo =
    !!turno &&
    (turno.guardiaUserId === userId || turno.guardiaSecundarioUserId === userId);

  return (
    <RecordatorioCierreModal
      // Si empieza otra franja con el aviso abierto, la casilla vuelve a cero.
      key={pendiente.clave}
      nombre={nombre}
      franja={pendiente}
      turnoAbiertoDesde={esSuyo ? turno.fechaInicio : null}
      onConfirmar={confirmar}
    />
  );
}

/**
 * El aviso en sí. No se descarta tocando fuera, con Escape ni con una X: solo
 * con la casilla marcada y "Entendido". Por eso no usa `Modal`, que se cierra
 * de todas esas formas.
 */
export function RecordatorioCierreModal({
  nombre,
  franja,
  turnoAbiertoDesde,
  onConfirmar,
}: {
  nombre: string;
  franja: Franja;
  /** Inicio del turno abierto de ESTE guarda, o null si no tiene uno. */
  turnoAbiertoDesde: number | null;
  onConfirmar: () => void;
}) {
  const [leido, setLeido] = useState(false);
  const dialogo = useRef<HTMLDivElement>(null);
  const casilla = useRef<HTMLInputElement>(null);
  const tituloId = useId();
  const mensajeId = useId();
  const saludo = nombreParaSaludo(nombre);
  // El portal vive en `document.body`, fuera del color del condominio.
  const brandStyle = useBrandThemeStyle();

  // Como `Modal`: el portal necesita `document`, que en el servidor no existe.
  const [montado, setMontado] = useState(false);
  useEffect(() => setMontado(true), []);

  useEffect(() => {
    if (!montado) return;
    casilla.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      /* En captura: Escape tampoco debe llegar al `Modal` que haya debajo
       * (p. ej. un formulario de la minuta a medio llenar) y cerrarlo. */
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      if (e.key !== "Tab" || !dialogo.current) return;
      const enfocables = dialogo.current.querySelectorAll<HTMLElement>(
        "input, button:not([disabled])",
      );
      const primero = enfocables[0];
      const ultimo = enfocables[enfocables.length - 1];
      if (!primero || !ultimo) return;
      const actual = document.activeElement;
      const fuera = !dialogo.current.contains(actual);
      if (e.shiftKey && (actual === primero || fuera)) {
        e.preventDefault();
        ultimo.focus();
      } else if (!e.shiftKey && (actual === ultimo || fuera)) {
        e.preventDefault();
        primero.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [montado]);

  if (!montado) return null;

  return createPortal(
    <div
      className="animate-fade-in fixed inset-0 z-120 flex items-center justify-center overflow-y-auto bg-foreground/50 p-4 backdrop-blur-sm"
      style={brandStyle}
    >
      <div
        ref={dialogo}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={tituloId}
        aria-describedby={mensajeId}
        className="animate-scale-in my-auto w-full max-w-md overflow-hidden rounded-2xl border border-border bg-card shadow-floating"
      >
        <div className="h-1.5 bg-brand" aria-hidden />
        <div className="p-6">
          <div className="flex items-center gap-3">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand/10">
              <LogOut className="h-5 w-5 text-brand" aria-hidden />
            </span>
            <div className="min-w-0">
              {/* Sin `text-brand`: con un color de conjunto muy oscuro se pierde
                * en modo oscuro, y esta línea lleva la hora. */}
              <p className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                <Clock3 className="h-3 w-3" aria-hidden />
                Cambio de turno · {franja.etiqueta}
              </p>
              <h2
                id={tituloId}
                className="text-lg font-semibold tracking-tight text-foreground"
              >
                Recordatorio de cierre de turno
              </h2>
            </div>
          </div>

          <div id={mensajeId} className="mt-5 space-y-3">
            <p className="text-base font-semibold text-foreground">
              Hola{saludo ? `, ${saludo}` : ""} 👋
            </p>
            <p className="text-[15px] leading-relaxed text-foreground">
              Recuerda que al finalizar tu turno debes{" "}
              <strong className="font-semibold">
                cerrar correctamente el turno
              </strong>{" "}
              y{" "}
              <strong className="font-semibold">cerrar sesión</strong>.
            </p>
            {turnoAbiertoDesde != null && (
              <p className="rounded-xl border border-brand/25 bg-brand/5 px-3.5 py-2.5 text-sm leading-relaxed text-foreground">
                Desde las {horaColombia(turnoAbiertoDesde)} tienes un turno
                abierto. Ciérralo en la Minuta antes de entregar la portería.
              </p>
            )}
            <p className="text-sm leading-relaxed text-muted-foreground">
              Esto ayuda a garantizar que tus registros queden asociados a tu
              cuenta y evita que otro guarda utilice tu sesión por accidente.
            </p>
          </div>

          <label className="mt-5 flex cursor-pointer items-center gap-3 rounded-xl border border-border bg-muted/40 px-3.5 py-3 transition-colors hover:bg-muted/70 has-checked:border-brand/40 has-checked:bg-brand/5">
            <input
              ref={casilla}
              type="checkbox"
              checked={leido}
              onChange={(e) => setLeido(e.target.checked)}
              className="h-5 w-5 shrink-0 rounded border-border accent-brand"
            />
            <span className="text-sm font-medium text-foreground">
              He leído y entiendo este recordatorio.
            </span>
          </label>

          <Button
            type="button"
            variant="brand"
            size="lg"
            className="mt-4 w-full"
            disabled={!leido}
            onClick={onConfirmar}
          >
            Entendido
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
