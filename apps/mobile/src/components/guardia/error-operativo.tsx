import React, { useEffect, useRef } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { ErrorBoundaryProps } from "expo-router";
import { useCondominio } from "@/context/condominio-context";
import { refrescarContextoOperativo } from "@/hooks/use-contexto-operativo";
import { firmaDeContexto } from "@/lib/contexto-guardia";
import { Tap } from "@/components/ui/tap";
import { AuthUI } from "@/lib/auth-ui";
import { C } from "@/lib/theme";

/**
 * QUÉ HACER CUANDO LA PORTERÍA DEJA DE SER LA SUYA A MEDIA PANTALLA.
 *
 * Si una cobertura empieza o termina, la inhabilitan, o cae su contrato
 * mientras el guarda tiene una pantalla abierta, la siguiente consulta de esa
 * portería vuelve con un "no tiene permiso" del servidor. Antes eso era el
 * error genérico de la app, y se quedaba ahí.
 *
 * Aquí no se decide nada: se vuelve a pedir el contexto
 * (`refrescarContextoOperativo`) y, en cuanto el servidor responde algo
 * distinto (otro conjunto activo, otra cobertura, otro estado), la pantalla
 * se vuelve a montar ya con la portería que vale. Si el contexto no cambia,
 * el error no era de contexto: se enseña con su mensaje y un "Reintentar".
 */
function Recuperando({
  error,
  reintentar,
}: {
  error: Error;
  reintentar: () => void;
}) {
  const { condominioId, contextoGuardia } = useCondominio();
  const firma = `${condominioId ?? ""}#${firmaDeContexto(contextoGuardia)}`;
  const inicial = useRef(firma);
  const reintentado = useRef(false);

  useEffect(() => {
    refrescarContextoOperativo();
  }, []);

  useEffect(() => {
    if (reintentado.current || firma === inicial.current) return;
    reintentado.current = true;
    reintentar();
  }, [firma, reintentar]);

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <ActivityIndicator color={C.brand} />
      <Text style={styles.title}>Actualizando tu portería…</Text>
      <Text style={styles.body}>{error.message}</Text>
      <Tap onPress={reintentar} style={styles.btn}>
        <Text style={styles.btnText}>Reintentar</Text>
      </Tap>
    </SafeAreaView>
  );
}

/** Para exportarlo como `ErrorBoundary` desde las rutas de `guardia/`. */
export function ErrorBoundaryOperativo({ error, retry }: ErrorBoundaryProps) {
  return <Recuperando error={error} reintentar={() => void retry()} />;
}

/**
 * Lo mismo para un trozo de pantalla que no es una ruta (el inicio del
 * guarda vive dentro de la pestaña Inicio, que comparten todos los roles).
 */
export class LimiteOperativo extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  reintentar = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      return <Recuperando error={this.state.error} reintentar={this.reintentar} />;
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    gap: 10,
  },
  title: { fontSize: 17, fontFamily: AuthUI.font.semibold, color: AuthUI.text },
  body: { fontSize: 13, color: AuthUI.textMuted, textAlign: "center", lineHeight: 18 },
  btn: {
    marginTop: 8,
    backgroundColor: C.brand,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 20,
  },
  btnText: { color: "#fff", fontFamily: AuthUI.font.semibold, fontSize: 14 },
});
