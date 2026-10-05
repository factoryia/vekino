import { useState } from "react";
import {
  View,
  Text,
  TextInput,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Alert,
  Modal,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { useMutation, useQuery, useAction, Authenticated } from "convex/react";
import { api } from "@vekino/backend/api";
import type { Id } from "@vekino/backend/dataModel";
import { useCondominio } from "@/context/condominio-context";
export { ErrorBoundaryOperativo as ErrorBoundary } from "@/components/guardia/error-operativo";
import { ScreenBackground, GlassCard, GlassBadge } from "@/components/ui/glass";
import { Tap } from "@/components/ui/tap";
import { AuthUI } from "@/lib/auth-ui";
import { C } from "@/lib/theme";
import { openDocument } from "@/lib/open-document";
import { uploadLocalFile } from "@/lib/guardia-upload";

type Prioridad = "baja" | "media" | "alta";

const PRIORIDAD: { key: Prioridad; label: string; tone: "neutral" | "yellow" | "red" }[] = [
  { key: "baja", label: "Baja", tone: "neutral" },
  { key: "media", label: "Media", tone: "yellow" },
  { key: "alta", label: "Alta", tone: "red" },
];

function fmtFechaHora(ts: number) {
  return new Date(ts).toLocaleString("es-CO", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function GuardiaNovedadesScreen() {
  return (
    <Authenticated>
      <Inner />
    </Authenticated>
  );
}

function Inner() {
  const router = useRouter();
  const { condominioId, isGuardia, canManage, isLoading } = useCondominio();
  const reportes = useQuery(
    api.guardia.listNovedadReportes,
    condominioId ? { condominioId } : "skip",
  );
  const reportar = useMutation(api.guardia.reportarNovedad);
  const generateUploadUrl = useAction(api.files.generateUploadUrl);

  const [formOpen, setFormOpen] = useState(false);
  const [titulo, setTitulo] = useState("");
  const [descripcion, setDescripcion] = useState("");
  const [prioridad, setPrioridad] = useState<Prioridad>("media");
  const [foto, setFoto] = useState<{ uri: string; mime: string; nombre: string } | null>(null);
  const [busy, setBusy] = useState(false);

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

  async function pickFoto() {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("Permiso necesario", "Activa el acceso a fotos.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 0.8,
    });
    if (result.canceled || !result.assets?.[0]) return;
    const a = result.assets[0];
    setFoto({
      uri: a.uri,
      mime: a.mimeType ?? "image/jpeg",
      nombre: a.fileName ?? "evidencia.jpg",
    });
  }

  async function submit() {
    if (!condominioId) return;
    if (!titulo.trim() || !descripcion.trim()) {
      Alert.alert("Completa el reporte", "Título y descripción son obligatorios.");
      return;
    }
    setBusy(true);
    try {
      let archivoUrl: string | undefined;
      if (foto) {
        const uploaded = await uploadLocalFile(
          generateUploadUrl,
          foto.uri,
          foto.mime,
          `condominios/guardia/${condominioId}/novedades`,
          foto.nombre,
        );
        archivoUrl = uploaded.url;
      }
      await reportar({
        condominioId,
        titulo: titulo.trim(),
        descripcion: descripcion.trim(),
        prioridad,
        archivoUrl,
        archivoNombre: foto?.nombre,
      });
      setFormOpen(false);
      setTitulo("");
      setDescripcion("");
      setPrioridad("media");
      setFoto(null);
    } catch (e) {
      Alert.alert("Error", e instanceof Error ? e.message : "No se pudo reportar.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ flex: 1 }}>
      <ScreenBackground>
        <SafeAreaView style={{ flex: 1 }} edges={["top"]}>
          <View style={styles.header}>
            <Tap onPress={() => router.back()} style={styles.backBtn}>
              <Ionicons name="chevron-back" size={22} color={AuthUI.text} />
            </Tap>
            <Text style={styles.title}>Novedades</Text>
            <Tap onPress={() => setFormOpen(true)} style={styles.backBtn}>
              <Ionicons name="add" size={24} color={AuthUI.text} />
            </Tap>
          </View>

          <ScrollView
            contentContainerStyle={styles.scroll}
            showsVerticalScrollIndicator={false}
          >
            <Text style={styles.subtitle}>
              Reporta incidentes de seguridad a la administración
            </Text>

            <Tap onPress={() => setFormOpen(true)}>
              <GlassCard style={styles.cta}>
                <Ionicons name="warning-outline" size={22} color={AuthUI.text} />
                <Text style={styles.ctaLabel}>Reportar novedad</Text>
              </GlassCard>
            </Tap>

            {reportes === undefined ? (
              <ActivityIndicator color={C.brand} style={{ marginTop: 24 }} />
            ) : reportes.length === 0 ? (
              <GlassCard style={styles.empty}>
                <Text style={styles.emptyTitle}>Sin novedades</Text>
                <Text style={styles.emptyHint}>
                  Los incidentes que reportes quedan aquí y en la minuta.
                </Text>
              </GlassCard>
            ) : (
              <View style={{ gap: 10, marginTop: 14 }}>
                {reportes.map((n) => {
                  const meta = PRIORIDAD.find((p) => p.key === n.prioridad)!;
                  return (
                    <GlassCard key={n._id} style={styles.card}>
                      <View style={styles.row}>
                        <Text style={styles.cardTitle}>{n.titulo}</Text>
                        <GlassBadge label={meta.label} tone={meta.tone} />
                      </View>
                      <Text style={styles.body}>{n.descripcion}</Text>
                      <Text style={styles.meta}>
                        {n.reportadoPorNombre} · {fmtFechaHora(n.createdAt)}
                      </Text>
                      {n.archivoUrl ? (
                        <Tap
                          onPress={() => openDocument(n.archivoUrl)}
                          style={styles.attach}
                        >
                          <Ionicons name="attach" size={14} color={C.brand} />
                          <Text style={styles.attachText}>
                            {n.archivoNombre ?? "Adjunto"}
                          </Text>
                        </Tap>
                      ) : null}
                    </GlassCard>
                  );
                })}
              </View>
            )}
          </ScrollView>
        </SafeAreaView>
      </ScreenBackground>

      <Modal visible={formOpen} animationType="slide" presentationStyle="pageSheet">
        <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
          <View style={styles.modalHead}>
            <Tap onPress={() => !busy && setFormOpen(false)}>
              <Text style={styles.cancel}>Cancelar</Text>
            </Tap>
            <Text style={styles.modalTitle}>Reportar</Text>
            <Tap onPress={submit} disabled={busy}>
              <Text style={[styles.save, busy && { opacity: 0.5 }]}>
                {busy ? "…" : "Enviar"}
              </Text>
            </Tap>
          </View>
          <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }}>
            <Field label="Título">
              <TextInput
                style={styles.input}
                value={titulo}
                onChangeText={setTitulo}
                placeholder="Ej. Ruido en zona común"
                placeholderTextColor={AuthUI.textMuted}
              />
            </Field>
            <Field label="Descripción">
              <TextInput
                style={[styles.input, { minHeight: 100, textAlignVertical: "top" }]}
                value={descripcion}
                onChangeText={setDescripcion}
                multiline
                placeholder="Detalle del incidente…"
                placeholderTextColor={AuthUI.textMuted}
              />
            </Field>
            <Field label="Prioridad">
              <View style={styles.prioRow}>
                {PRIORIDAD.map((p) => (
                  <Tap
                    key={p.key}
                    onPress={() => setPrioridad(p.key)}
                    style={[
                      styles.prioChip,
                      prioridad === p.key && styles.prioActive,
                    ]}
                  >
                    <Text
                      style={[
                        styles.prioText,
                        prioridad === p.key && styles.prioTextActive,
                      ]}
                    >
                      {p.label}
                    </Text>
                  </Tap>
                ))}
              </View>
            </Field>
            <Tap onPress={pickFoto}>
              <GlassCard style={styles.fotoBtn}>
                <Ionicons name="camera-outline" size={20} color={AuthUI.text} />
                <Text style={styles.fotoLabel}>
                  {foto ? foto.nombre : "Adjuntar foto (opcional)"}
                </Text>
              </GlassCard>
            </Tap>
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </View>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
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
    marginBottom: 14,
  },
  cta: {
    padding: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  ctaLabel: {
    fontSize: 15,
    fontFamily: AuthUI.font.semibold,
    color: AuthUI.text,
  },
  empty: { padding: 24, alignItems: "center", gap: 6, marginTop: 14 },
  emptyTitle: { fontSize: 15, fontFamily: AuthUI.font.semibold, color: AuthUI.text },
  emptyHint: { fontSize: 13, color: AuthUI.textMuted, textAlign: "center" },
  card: { padding: 14, gap: 6 },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  cardTitle: {
    flex: 1,
    fontSize: 15,
    fontFamily: AuthUI.font.semibold,
    color: AuthUI.text,
  },
  body: { fontSize: 14, color: AuthUI.text, lineHeight: 20 },
  meta: { fontSize: 12, color: AuthUI.textMuted },
  attach: { flexDirection: "row", alignItems: "center", gap: 4 },
  attachText: { fontSize: 13, color: C.brand, fontFamily: AuthUI.font.medium },
  denied: { fontSize: 16, fontFamily: AuthUI.font.semibold, color: AuthUI.text },
  modalHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.border,
  },
  modalTitle: { fontSize: 16, fontFamily: AuthUI.font.semibold, color: AuthUI.text },
  cancel: { color: AuthUI.textMuted, fontSize: 15 },
  save: { color: C.brand, fontSize: 15, fontFamily: AuthUI.font.semibold },
  fieldLabel: {
    fontSize: 12,
    fontFamily: AuthUI.font.medium,
    color: AuthUI.textMuted,
  },
  input: {
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: AuthUI.text,
    backgroundColor: "#fff",
  },
  prioRow: { flexDirection: "row", gap: 8 },
  prioChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: C.bgSubtle,
  },
  prioActive: { backgroundColor: C.brand },
  prioText: { fontSize: 13, color: AuthUI.text, fontFamily: AuthUI.font.medium },
  prioTextActive: { color: "#fff" },
  fotoBtn: {
    padding: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  fotoLabel: { fontSize: 14, color: AuthUI.text },
});
