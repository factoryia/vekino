import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useQuery } from "convex/react";
import { api } from "@vekino/backend/api";
import {
  horaColombia,
  nombreParaSaludo,
  type Franja,
} from "@vekino/backend/recordatorioCierre";
import { useCondominio } from "@/context/condominio-context";
import { useRecordatorioCierre } from "@/hooks/use-recordatorio-cierre";
import { useSplashCumplido } from "@/lib/arranque";
import { SALIDA_MS } from "@/components/ui/splash-marca";
import { greetingName } from "@/lib/utils";
import { AuthUI } from "@/lib/auth-ui";
import { SoftUI, softShadow } from "@/lib/soft-ui";

/**
 * Recordatorio de cierre de turno y sesión para el guarda.
 *
 * Va en el layout autenticado, no en una pantalla: así no depende de que el
 * guarda esté en el inicio para enterarse. Solo recuerda; no cierra el turno
 * ni la sesión. `isGuardia` es el mismo criterio que le muestra el inicio de
 * portería, así que lo ven exactamente quienes trabajan como guarda.
 */
export function RecordatorioCierreTurno() {
  const { condominioId, isGuardia, isLoading, theme } = useCondominio();
  const me = useQuery(api.users.me);
  const arranqueListo = useArranqueTerminado(!isLoading);

  const userId = arranqueListo && isGuardia && condominioId && me ? me.id : null;
  const { pendiente, confirmar } = useRecordatorioCierre(userId);
  /* Solo se lee: el recordatorio no abre ni cierra turnos. */
  const turno = useQuery(
    api.guardia.turnoActivo,
    pendiente && condominioId ? { condominioId } : "skip",
  );

  if (!pendiente || !me || turno === undefined) return null;

  const esSuyo =
    !!turno &&
    (turno.guardiaUserId === me.id || turno.guardiaSecundarioUserId === me.id);

  return (
    <RecordatorioCierreModal
      // Si empieza otra franja con el aviso abierto, la casilla vuelve a cero.
      key={pendiente.clave}
      nombre={nombreParaSaludo(greetingName(me))}
      franja={pendiente}
      turnoAbiertoDesde={esSuyo ? turno.fechaInicio : null}
      acento={theme.accent}
      acentoSuave={theme.accentSoft}
      onConfirmar={confirmar}
    />
  );
}

/**
 * Espera a que se retire el splash de arranque: un aviso encima del giro de
 * la marca se ve como un error. `Preparando` no expone cuándo termina, así que
 * se replica su condición (mínimo de splash cumplido + datos) más la salida.
 */
function useArranqueTerminado(datosListos: boolean): boolean {
  const splashCumplido = useSplashCumplido();
  const [listo, setListo] = useState(false);

  useEffect(() => {
    if (listo || !splashCumplido || !datosListos) return;
    const id = setTimeout(() => setListo(true), SALIDA_MS);
    return () => clearTimeout(id);
  }, [listo, splashCumplido, datosListos]);

  return listo;
}

function RecordatorioCierreModal({
  nombre,
  franja,
  turnoAbiertoDesde,
  acento,
  acentoSuave,
  onConfirmar,
}: {
  nombre: string;
  franja: Franja;
  turnoAbiertoDesde: number | null;
  acento: string;
  acentoSuave: string;
  onConfirmar: () => void;
}) {
  const [leido, setLeido] = useState(false);

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      statusBarTranslucent
      // El botón atrás de Android no lo descarta: hay que confirmarlo.
      onRequestClose={() => {}}
    >
      <View style={styles.overlay}>
        <View style={styles.card} accessibilityViewIsModal>
          <View style={[styles.franja, { backgroundColor: acento }]} />
          <ScrollView
            contentContainerStyle={styles.body}
            showsVerticalScrollIndicator={false}
            bounces={false}
          >
            <View style={styles.header}>
              <View style={[styles.icono, { backgroundColor: acentoSuave }]}>
                <Ionicons name="log-out-outline" size={24} color={acento} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.eyebrow, { color: acento }]}>
                  CAMBIO DE TURNO · {franja.etiqueta.toUpperCase()}
                </Text>
                <Text style={styles.titulo} accessibilityRole="header">
                  Recordatorio de cierre de turno
                </Text>
              </View>
            </View>

            <Text style={styles.saludo}>
              Hola{nombre ? `, ${nombre}` : ""} 👋
            </Text>
            <Text style={styles.mensaje}>
              Recuerda que al finalizar tu turno debes{" "}
              <Text style={styles.fuerte}>cerrar el turno</Text> y{" "}
              <Text style={styles.fuerte}>cerrar sesión</Text>.
            </Text>

            {turnoAbiertoDesde != null ? (
              <View style={[styles.turno, { borderColor: acento, backgroundColor: acentoSuave }]}>
                <Text style={styles.turnoTexto}>
                  Desde las {horaColombia(turnoAbiertoDesde)} tienes un turno
                  abierto. Ciérralo en la Minuta antes de entregar la portería.
                </Text>
              </View>
            ) : null}

            <Text style={styles.porque}>
              Esto ayuda a que tus registros queden asociados correctamente a tu
              cuenta y evita que otro guarda use tu sesión por accidente.
            </Text>

            <Pressable
              onPress={() => setLeido((v) => !v)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: leido }}
              style={[
                styles.casilla,
                leido && { borderColor: acento, backgroundColor: acentoSuave },
              ]}
            >
              <Ionicons
                name={leido ? "checkbox" : "square-outline"}
                size={26}
                color={leido ? acento : SoftUI.textSecondary}
              />
              <Text style={styles.casillaTexto}>
                He leído y entiendo este recordatorio.
              </Text>
            </Pressable>

            <Pressable
              onPress={onConfirmar}
              disabled={!leido}
              accessibilityRole="button"
              accessibilityState={{ disabled: !leido }}
              style={({ pressed }) => [
                styles.boton,
                { backgroundColor: acento },
                !leido && styles.botonApagado,
                pressed && leido && { opacity: 0.85 },
              ]}
            >
              <Text style={styles.botonTexto}>Entendido</Text>
            </Pressable>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: "center",
    padding: SoftUI.space.lg,
    backgroundColor: "rgba(17,18,22,0.55)",
  },
  card: {
    maxHeight: "90%",
    overflow: "hidden",
    borderRadius: SoftUI.radius.card,
    backgroundColor: SoftUI.card,
    ...softShadow,
  },
  franja: { height: 6 },
  body: { padding: SoftUI.space.xl, gap: SoftUI.space.md },
  header: { flexDirection: "row", alignItems: "center", gap: SoftUI.space.md },
  icono: {
    width: 48,
    height: 48,
    borderRadius: SoftUI.radius.icon,
    alignItems: "center",
    justifyContent: "center",
  },
  eyebrow: {
    fontFamily: AuthUI.font.semibold,
    fontSize: 11,
    letterSpacing: 0.6,
  },
  titulo: {
    fontFamily: AuthUI.font.bold,
    fontSize: 19,
    lineHeight: 25,
    color: SoftUI.text,
  },
  saludo: {
    marginTop: SoftUI.space.sm,
    fontFamily: AuthUI.font.semibold,
    fontSize: 18,
    color: SoftUI.text,
  },
  mensaje: {
    fontFamily: AuthUI.font.regular,
    fontSize: 16,
    lineHeight: 24,
    color: SoftUI.text,
  },
  fuerte: { fontFamily: AuthUI.font.semibold },
  turno: {
    borderWidth: 1,
    borderRadius: SoftUI.radius.icon,
    paddingHorizontal: SoftUI.space.base,
    paddingVertical: SoftUI.space.md,
  },
  turnoTexto: {
    fontFamily: AuthUI.font.medium,
    fontSize: 14,
    lineHeight: 20,
    color: SoftUI.text,
  },
  porque: {
    fontFamily: AuthUI.font.regular,
    fontSize: 14,
    lineHeight: 20,
    color: SoftUI.textSecondary,
  },
  casilla: {
    marginTop: SoftUI.space.sm,
    flexDirection: "row",
    alignItems: "center",
    gap: SoftUI.space.md,
    minHeight: SoftUI.touch + 12,
    borderWidth: 1,
    borderColor: SoftUI.divider,
    borderRadius: SoftUI.radius.icon,
    backgroundColor: SoftUI.field,
    paddingHorizontal: SoftUI.space.base,
    paddingVertical: SoftUI.space.md,
  },
  casillaTexto: {
    flex: 1,
    fontFamily: AuthUI.font.medium,
    fontSize: 15,
    color: SoftUI.text,
  },
  boton: {
    height: SoftUI.buttonH,
    borderRadius: SoftUI.radius.button,
    alignItems: "center",
    justifyContent: "center",
  },
  botonApagado: { opacity: 0.4 },
  botonTexto: {
    fontFamily: AuthUI.font.semibold,
    fontSize: 16,
    color: SoftUI.white,
  },
});
