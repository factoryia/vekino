import { useState } from "react";
import { ActivityIndicator, Alert, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useMutation, useQuery } from "convex/react";
import { api } from "@vekino/backend/api";
import type { Id } from "@vekino/backend/dataModel";
import { GlassCard } from "@/components/ui/glass";
import { Tap } from "@/components/ui/tap";
import { etiquetaHasta } from "@/lib/contexto-guardia";
import { AuthUI } from "@/lib/auth-ui";
import { SoftUI } from "@/lib/soft-ui";
import { C } from "@/lib/theme";

/**
 * Las solicitudes de cobertura que el guarda tiene que responder: dónde,
 * cuándo y quién la pide, y aceptar o rechazar. Nada más: ni editar, ni
 * cancelar, ni inhabilitar, que son de la compañía. No sale si no hay nada
 * pendiente. La misma superficie que la web (`solicitudes-cobertura.tsx`).
 *
 * Aceptar no cambia nada en el móvil por sí solo: la cobertura empieza en su
 * hora, y entonces el servidor la devuelve como contexto operativo y la app
 * pasa sola a esa portería (`useMeOperativo` vuelve a preguntar en ese
 * instante, porque aceptarla cambia `refrescarEn`).
 */
export function SolicitudesCobertura() {
  const pendientes = useQuery(api.coberturas.pendientesDeGuarda, {});
  if (!pendientes || pendientes.length === 0) return null;

  return (
    <View style={styles.wrap}>
      <View style={styles.head}>
        <Ionicons name="swap-horizontal-outline" size={18} color={AuthUI.text} />
        <Text style={styles.headText}>
          {pendientes.length === 1
            ? "Tienes una solicitud de cobertura"
            : `Tienes ${pendientes.length} solicitudes de cobertura`}
        </Text>
      </View>
      {pendientes.map((c) => (
        <Solicitud
          key={c._id}
          coberturaId={c._id}
          conjunto={c.condominioNombre}
          desde={c.inicio}
          hasta={c.fin}
          pidio={c.solicitadoPorNombre}
        />
      ))}
    </View>
  );
}

function Solicitud({
  coberturaId,
  conjunto,
  desde,
  hasta,
  pidio,
}: {
  coberturaId: Id<"coberturas">;
  conjunto: string;
  desde: number;
  hasta: number;
  pidio: string;
}) {
  const aceptar = useMutation(api.coberturas.aceptar);
  const rechazar = useMutation(api.coberturas.rechazar);
  const [busy, setBusy] = useState(false);

  async function responder(accion: typeof aceptar) {
    if (busy) return;
    setBusy(true);
    try {
      await accion({ coberturaId });
    } catch (e) {
      Alert.alert("No se pudo responder", e instanceof Error ? e.message : "Intenta de nuevo.");
      setBusy(false);
    }
  }

  return (
    <GlassCard style={styles.card}>
      <Text style={styles.titulo}>Cubrir {conjunto}</Text>
      <Text style={styles.meta}>
        {etiquetaHasta(desde)} → {etiquetaHasta(hasta)} · hora de Colombia
      </Text>
      <Text style={styles.meta}>La pidió {pidio}</Text>
      <View style={styles.acciones}>
        {busy ? (
          <ActivityIndicator color={C.brand} />
        ) : (
          <>
            <Tap onPress={() => void responder(rechazar)} style={[styles.btn, styles.btnSec]}>
              <Text style={styles.btnSecText}>Rechazar</Text>
            </Tap>
            <Tap onPress={() => void responder(aceptar)} style={[styles.btn, styles.btnPri]}>
              <Text style={styles.btnPriText}>Aceptar</Text>
            </Tap>
          </>
        )}
      </View>
    </GlassCard>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: SoftUI.space.sm, marginBottom: SoftUI.space.lg },
  head: { flexDirection: "row", alignItems: "center", gap: 8 },
  headText: { fontSize: 14, fontFamily: AuthUI.font.semibold, color: AuthUI.text },
  card: { padding: SoftUI.space.base, gap: 4, backgroundColor: SoftUI.warningSoft, borderWidth: 0 },
  titulo: { fontSize: 15, fontFamily: AuthUI.font.semibold, color: AuthUI.text },
  meta: { fontSize: 12, color: AuthUI.textMuted, fontFamily: AuthUI.font.regular },
  acciones: { flexDirection: "row", justifyContent: "flex-end", gap: 8, marginTop: 8 },
  btn: { borderRadius: 10, paddingVertical: 8, paddingHorizontal: 16 },
  btnPri: { backgroundColor: C.brand },
  btnPriText: { color: "#fff", fontFamily: AuthUI.font.semibold, fontSize: 14 },
  btnSec: { backgroundColor: "#fff", borderWidth: 1, borderColor: C.border },
  btnSecText: { color: AuthUI.text, fontFamily: AuthUI.font.medium, fontSize: 14 },
});
