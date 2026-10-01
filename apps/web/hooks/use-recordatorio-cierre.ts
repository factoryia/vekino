"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  claveRegistro,
  confirmarRecordatorio,
  evaluarRecordatorio,
  leerRegistro,
  msHastaRevision,
  type Franja,
  type RegistroRecordatorio,
} from "@vekino/backend/recordatorioCierre";

function leer(userId: string): RegistroRecordatorio | null {
  try {
    return leerRegistro(window.localStorage.getItem(claveRegistro(userId)));
  } catch {
    return null;
  }
}

function guardar(userId: string, registro: RegistroRecordatorio) {
  try {
    window.localStorage.setItem(claveRegistro(userId), JSON.stringify(registro));
  } catch {
    // Modo privado / almacenamiento bloqueado: queda el respaldo en memoria.
  }
}

/**
 * Cuándo mostrarle al guarda el recordatorio de cierre de turno (05:50 y
 * 17:50, hora de Colombia) y cómo dejar constancia de que lo leyó.
 *
 * Va montado en el shell de la portería y no en una pantalla, así que navegar
 * entre módulos no lo reinicia. Vuelve a mirar el reloj:
 *  - con un temporizador que despierta justo después de cada horario y, como
 *    mucho, cada minuto (sobrevive a cambios de fecha con la pestaña abierta);
 *  - al volver a la pestaña o al navegador (`visibilitychange`, `focus`,
 *    `pageshow`): el equipo bloqueado o la pestaña congelada no disparan
 *    temporizadores, así que es al volver cuando se entera;
 *  - cuando otra pestaña confirma (`storage`), para no pedirlo dos veces.
 *
 * Lo confirmado vive en `localStorage` por usuario: es del dispositivo, que es
 * justo donde queda la sesión abierta. No cierra ni toca la sesión.
 *
 * `userId` null lo apaga (otro rol, o aún cargando).
 */
export function useRecordatorioCierre(userId: string | null): {
  pendiente: Franja | null;
  confirmar: () => void;
} {
  /* Atado al usuario: si cambia la cuenta sin desmontar, lo que estaba en
   * pantalla para el anterior no se le muestra al nuevo ni un render. */
  const [estado, setEstado] = useState<{ userId: string; franja: Franja } | null>(
    null,
  );
  /** Respaldo si el almacenamiento falla: sin él, volvería a salir cada minuto. */
  const memoria = useRef(new Map<string, RegistroRecordatorio>());

  useEffect(() => {
    if (!userId) {
      setEstado(null);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;

    const evaluar = () => {
      const ahora = Date.now();
      const registro = leer(userId) ?? memoria.current.get(userId) ?? null;
      const r = evaluarRecordatorio(registro, ahora);
      if (r.mostrar) {
        if (r.nuevo) {
          guardar(userId, r.registro);
          memoria.current.set(userId, r.registro);
        }
        setEstado((prev) =>
          prev?.userId === userId && prev.franja.clave === r.franja.clave
            ? prev
            : { userId, franja: r.franja },
        );
      } else {
        setEstado(null);
      }
      clearTimeout(timer);
      timer = setTimeout(evaluar, msHastaRevision(ahora));
    };

    const alVolver = () => {
      if (document.visibilityState === "visible") evaluar();
    };
    const alCambiarEnOtraPestana = (e: StorageEvent) => {
      if (e.key === claveRegistro(userId)) evaluar();
    };

    evaluar();
    document.addEventListener("visibilitychange", alVolver);
    window.addEventListener("focus", evaluar);
    window.addEventListener("pageshow", evaluar);
    window.addEventListener("storage", alCambiarEnOtraPestana);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", alVolver);
      window.removeEventListener("focus", evaluar);
      window.removeEventListener("pageshow", evaluar);
      window.removeEventListener("storage", alCambiarEnOtraPestana);
    };
  }, [userId]);

  const pendiente = estado && estado.userId === userId ? estado.franja : null;

  const confirmar = useCallback(() => {
    if (!userId || !pendiente) return;
    const registro = confirmarRecordatorio(
      leer(userId) ?? memoria.current.get(userId) ?? null,
      pendiente,
      Date.now(),
    );
    guardar(userId, registro);
    memoria.current.set(userId, registro);
    setEstado(null);
  }, [userId, pendiente]);

  return { pendiente, confirmar };
}
