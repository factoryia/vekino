import { View, Text, ScrollView, StyleSheet, ActivityIndicator } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useQuery, Authenticated } from "convex/react";
import { api } from "@vekino/backend/api";
import { useCondominio } from "@/context/condominio-context";
export { ErrorBoundaryOperativo as ErrorBoundary } from "@/components/guardia/error-operativo";
import { ScreenBackground, GlassCard, GlassBadge } from "@/components/ui/glass";
import { Tap } from "@/components/ui/tap";
import { AuthUI } from "@/lib/auth-ui";
import { C } from "@/lib/theme";
import { openDocument } from "@/lib/open-document";

function fmtFecha(ts: number) {
  return new Date(ts).toLocaleDateString("es-CO", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export default function GuardiaAvisosScreen() {
  return (
    <Authenticated>
      <Inner />
    </Authenticated>
  );
}

function Inner() {
  const router = useRouter();
  const { condominioId, isGuardia, canManage, isLoading } = useCondominio();
  const avisos = useQuery(
    api.guardia.listAvisos,
    condominioId ? { condominioId } : "skip",
  );

  if (isLoading) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={C.brand} />
      </View>
    );
  }

  if (!condominioId || (!isGuardia && !canManage)) {
    return (
      <SafeAreaView style={{ flex: 1, padding: 24 }} edges={["top"]}>
        <Text style={styles.denied}>Sin acceso</Text>
        <Tap onPress={() => router.back()} style={{ marginTop: 16 }}>
          <Text style={{ color: C.brand }}>Volver</Text>
        </Tap>
      </SafeAreaView>
    );
  }

  const sorted = [...(avisos ?? [])].sort(
    (a, b) => Number(b.fijado) - Number(a.fijado) || b.createdAt - a.createdAt,
  );

  return (
    <View style={{ flex: 1 }}>
      <ScreenBackground>
        <SafeAreaView style={{ flex: 1 }} edges={["top"]}>
          <View style={styles.header}>
            <Tap onPress={() => router.back()} style={styles.backBtn}>
              <Ionicons name="chevron-back" size={22} color={AuthUI.text} />
            </Tap>
            <Text style={styles.title}>Avisos</Text>
            <View style={{ width: 40 }} />
          </View>

          <ScrollView
            contentContainerStyle={styles.scroll}
            showsVerticalScrollIndicator={false}
          >
            <Text style={styles.subtitle}>
              Comunicados de la administración para seguridad
            </Text>

            {avisos === undefined ? (
              <ActivityIndicator color={C.brand} style={{ marginTop: 40 }} />
            ) : sorted.length === 0 ? (
              <GlassCard style={styles.empty}>
                <Ionicons name="megaphone-outline" size={32} color={AuthUI.textMuted} />
                <Text style={styles.emptyTitle}>Sin avisos</Text>
                <Text style={styles.emptyHint}>
                  Los comunicados dirigidos a portería aparecerán aquí.
                </Text>
              </GlassCard>
            ) : (
              <View style={{ gap: 10 }}>
                {sorted.map((c) => (
                  <GlassCard
                    key={c._id}
                    style={
                      c.prioridad === "urgente"
                        ? { ...styles.card, ...styles.urgente }
                        : styles.card
                    }
                  >
                    <View style={styles.cardHead}>
                      {c.fijado ? (
                        <Ionicons name="pin" size={14} color={C.brand} />
                      ) : null}
                      <Text style={styles.cardTitle}>{c.titulo}</Text>
                    </View>
                    <View style={styles.badges}>
                      {c.prioridad === "urgente" ? (
                        <GlassBadge label="Urgente" tone="red" />
                      ) : c.prioridad === "importante" ? (
                        <GlassBadge label="Importante" tone="yellow" />
                      ) : null}
                      {c.audiencia === "guardia" ? (
                        <GlassBadge label="Solo seguridad" tone="blue" />
                      ) : null}
                    </View>
                    <Text style={styles.body}>{c.cuerpo}</Text>
                    <Text style={styles.meta}>
                      {c.autorNombre} · {fmtFecha(c.createdAt)}
                    </Text>
                    {(c.archivos ?? [])
                      .filter((a) => a.url)
                      .map((a, i) => (
                        <Tap
                          key={i}
                          onPress={() => openDocument(a.url)}
                          style={styles.attach}
                        >
                          <Ionicons name="attach" size={14} color={C.brand} />
                          <Text style={styles.attachText}>{a.nombre}</Text>
                        </Tap>
                      ))}
                  </GlassCard>
                ))}
              </View>
            )}
          </ScrollView>
        </SafeAreaView>
      </ScreenBackground>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingBottom: 8,
  },
  backBtn: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    fontSize: 17,
    fontFamily: AuthUI.font.semibold,
    color: AuthUI.text,
  },
  scroll: { paddingHorizontal: 16, paddingBottom: 40 },
  subtitle: {
    fontSize: 13,
    color: AuthUI.textMuted,
    marginBottom: 16,
    fontFamily: AuthUI.font.regular,
  },
  empty: {
    padding: 28,
    alignItems: "center",
    gap: 8,
  },
  emptyTitle: {
    fontSize: 16,
    fontFamily: AuthUI.font.semibold,
    color: AuthUI.text,
  },
  emptyHint: {
    fontSize: 13,
    color: AuthUI.textMuted,
    textAlign: "center",
  },
  card: { padding: 14, gap: 8 },
  urgente: { borderColor: "#FCA5A5" },
  cardHead: { flexDirection: "row", alignItems: "center", gap: 6 },
  cardTitle: {
    flex: 1,
    fontSize: 15,
    fontFamily: AuthUI.font.semibold,
    color: AuthUI.text,
  },
  badges: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  body: {
    fontSize: 14,
    color: AuthUI.text,
    lineHeight: 20,
    fontFamily: AuthUI.font.regular,
  },
  meta: {
    fontSize: 12,
    color: AuthUI.textMuted,
    fontFamily: AuthUI.font.regular,
  },
  attach: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 2,
  },
  attachText: {
    fontSize: 13,
    color: C.brand,
    fontFamily: AuthUI.font.medium,
  },
  denied: {
    fontSize: 16,
    fontFamily: AuthUI.font.semibold,
    color: AuthUI.text,
  },
});
