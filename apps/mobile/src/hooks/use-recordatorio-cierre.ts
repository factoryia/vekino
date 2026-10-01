import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  claveRegistro,
  confirmarRecordatorio,
  evaluarRecordatorio,
  leerRegistro,
  msHastaRevision,
  type Franja,
  type RegistroRecordatorio,
} from "@vekino/backend/recordatorioCierre";

/**
 * Cuándo mostrarle al guarda el recordatorio de cierre de turno (05:50 y
 * 17:50, hora de Colombia, durante `VENTANA_RECORDATORIO_MINUTOS`) y cómo
 * dejar constancia de que lo leyó.
 *
 * Las reglas son las mismas que en la web (`lib/recordatorioCierre.ts` del
 * backend); aquí solo cambia el ciclo de vida. Con la app en segundo plano o
 * el teléfono bloqueado el JS no corre y los temporizadores no disparan, así
 * que se vuelve a mirar el reloj al volver a primer plano (`AppState`
 * "active"). Con la app abierta, un temporizador despierta justo después de
 * que abra o cierre cada ventana y, como mucho, cada minuto; al cerrarse, el
 * aviso sin confirmar se retira.
 *
 * Lo confirmado vive en AsyncStorage por usuario: es del dispositivo, que es
 * donde queda la sesión abierta. No es un secreto, por eso no va a
 * SecureStore. No cierra ni toca la sesión.
 *
 * `userId` null lo apaga (otro rol, o aún cargando).
 */
export function useRecordatorioCierre(userId: string | null): {
  pendiente: Franja | null;
  confirmar: () => void;
} {
  /* Atado al usuario: si cambia la cuenta, lo que estaba en pantalla para el
   * anterior no se le muestra al nuevo ni un render. */
  const [estado, setEstado] = useState<{ userId: string; franja: Franja } | null>(
    null,
  );
  /** Lo último leído o escrito, para no ir a AsyncStorage en cada revisión. */
  const memoria = useRef(new Map<string, RegistroRecordatorio>());

  useEffect(() => {
    if (!userId) {
      setEstado(null);
      return;
    }
    let vivo = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clave = claveRegistro(userId);

    const evaluar = async () => {
      let registro = memoria.current.get(userId) ?? null;
      if (!registro) {
        registro = leerRegistro(await AsyncStorage.getItem(clave).catch(() => null));
        if (registro) memoria.current.set(userId, registro);
      }
      if (!vivo) return;

      const ahora = Date.now();
      const r = evaluarRecordatorio(registro, ahora);
      if (r.mostrar) {
        if (r.nuevo) {
          memoria.current.set(userId, r.registro);
          void AsyncStorage.setItem(clave, JSON.stringify(r.registro)).catch(() => {});
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
      timer = setTimeout(() => void evaluar(), msHastaRevision(ahora));
    };

    void evaluar();
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") void evaluar();
    });
    return () => {
      vivo = false;
      clearTimeout(timer);
      sub.remove();
    };
  }, [userId]);

  const pendiente = estado && estado.userId === userId ? estado.franja : null;

  const confirmar = useCallback(() => {
    if (!userId || !pendiente) return;
    const registro = confirmarRecordatorio(
      memoria.current.get(userId) ?? null,
      pendiente,
      Date.now(),
    );
    memoria.current.set(userId, registro);
    void AsyncStorage.setItem(claveRegistro(userId), JSON.stringify(registro)).catch(
      () => {},
    );
    setEstado(null);
  }, [userId, pendiente]);

  return { pendiente, confirmar };
}
