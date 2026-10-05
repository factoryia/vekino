import { useMemo, useState } from "react";
import {
  View,
  Text,
  TextInput,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Alert,
  Modal,
  Image,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { useMutation, useQuery, useAction, Authenticated } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@vekino/backend/api";
import type { Doc, Id } from "@vekino/backend/dataModel";
import { useCondominio } from "@/context/condominio-context";
export { ErrorBoundaryOperativo as ErrorBoundary } from "@/components/guardia/error-operativo";
import { ScreenBackground, GlassCard, GlassBadge } from "@/components/ui/glass";
import { Tap } from "@/components/ui/tap";
import { AuthUI } from "@/lib/auth-ui";
import { C } from "@/lib/theme";
import { uploadLocalFile } from "@/lib/guardia-upload";

/**
 * El tipo sale de lo que DEVUELVE la query, no de una intersección escrita a
 * mano. `listPaquetes` resuelve las URLs de las fotos a `string | null`,
 * mientras que en el esquema son `v.optional(v.string())`; describir eso con
 * `Doc<"paquetes"> & { fotoUrl: string | null }` daba un tipo que no
 * coincidía con el real y rompía `setEntregarPaq`. Así no puede desalinearse.
 */
type Paq = FunctionReturnType<typeof api.guardia.listPaquetes>[number];
type TipoPaq = Doc<"paquetes">["tipo"];

const TIPOS: { key: TipoPaq; label: string }[] = [
  { key: "paquete", label: "Paquete" },
  { key: "sobre", label: "Sobre" },
  { key: "comida", label: "Comida" },
  { key: "mercado", label: "Mercado" },
  { key: "otro", label: "Otro" },
];

function fmtHora(ts?: number) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("es-CO", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function GuardiaPaqueteriaScreen() {
  return (
    <Authenticated>
      <Inner />
    </Authenticated>
  );
}

function Inner() {
  const router = useRouter();
  const { condominioId, isGuardia, canManage, isLoading } = useCondominio();
  const paquetes = useQuery(
    api.guardia.listPaquetes,
    condominioId ? { condominioId } : "skip",
  );
  const recibir = useMutation(api.guardia.recibirPaquete);
  const entregar = useMutation(api.guardia.entregarPaquete);
  const eliminar = useMutation(api.guardia.eliminarPaqueteReciente);

  /**
   * Deshace un registro mal hecho. El backend solo deja borrar paquetes
   * que aún no se han entregado.
   */
  function confirmarEliminar(id: Id<"paquetes">, unidad: string) {
    Alert.alert(
      "Eliminar registro",
      `¿Borrar el paquete de la unidad ${unidad}? Úsalo solo si lo registraste por error.`,
      [
        { text: "Cancelar", style: "cancel" },
        {
          text: "Eliminar",
          style: "destructive",
          onPress: async () => {
            try {
              await eliminar({ id });
            } catch (e) {
              Alert.alert(
                "No se pudo eliminar",
                e instanceof Error ? e.message : "Inténtalo de nuevo.",
              );
            }
          },
        },
      ],
    );
  }
  const generateUploadUrl = useAction(api.files.generateUploadUrl);

  const [tab, setTab] = useState<"recibido" | "entregado">("recibido");
  const [buscar, setBuscar] = useState("");
  const [nuevoOpen, setNuevoOpen] = useState(false);
  const [entregarPaq, setEntregarPaq] = useState<Paq | null>(null);

  const [unidad, setUnidad] = useState("");
  const [tipo, setTipo] = useState<TipoPaq>("paquete");
  const [remitente, setRemitente] = useState("");
  const [destinatario, setDestinatario] = useState("");
  const [descripcion, setDescripcion] = useState("");
  const [foto, setFoto] = useState<{ uri: string; mime: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const [entregadoA, setEntregadoA] = useState("");
  const [obsEntrega, setObsEntrega] = useState("");
  const [fotoEntrega, setFotoEntrega] = useState<{ uri: string; mime: string } | null>(null);

  const filtrados = useMemo(() => {
    return (paquetes ?? [])
      .filter((p) => p.estado === tab)
      .filter((p) => {
        if (!buscar.trim()) return true;
        const q = buscar.toLowerCase();
        return `${p.unidadNumero} ${p.destinatario ?? ""} ${p.remitente ?? ""}`
          .toLowerCase()
          .includes(q);
      });
  }, [paquetes, tab, buscar]);

  const pendientes = (paquetes ?? []).filter((p) => p.estado === "recibido").length;

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

  async function pickImage(setter: (v: { uri: string; mime: string } | null) => void) {
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
    setter({ uri: a.uri, mime: a.mimeType ?? "image/jpeg" });
  }

  function resetNuevo() {
    setUnidad("");
    setTipo("paquete");
    setRemitente("");
    setDestinatario("");
    setDescripcion("");
    setFoto(null);
  }

  async function submitRecibir() {
    if (!condominioId) return;
    if (!unidad.trim()) {
      Alert.alert("Unidad requerida", "Indica a qué unidad llega el paquete.");
      return;
    }
    setBusy(true);
    try {
      let fotoUrl: string | undefined;
      if (foto && condominioId) {
        const uploaded = await uploadLocalFile(
          generateUploadUrl,
          foto.uri,
          foto.mime,
          `condominios/guardia/${condominioId}/paquetes`,
        );
        fotoUrl = uploaded.url;
      }
      await recibir({
        condominioId,
        unidadNumero: unidad.trim(),
        tipo,
        remitente: remitente || undefined,
        destinatario: destinatario || undefined,
        descripcion: descripcion || undefined,
        fotoUrl,
      });
      setNuevoOpen(false);
      resetNuevo();
    } catch (e) {
      Alert.alert("Error", e instanceof Error ? e.message : "No se pudo registrar.");
    } finally {
      setBusy(false);
    }
  }

  async function submitEntregar() {
    if (!entregarPaq) return;
    setBusy(true);
    try {
      let fotoEntregaUrl: string | undefined;
      if (fotoEntrega) {
        const uploaded = await uploadLocalFile(
          generateUploadUrl,
          fotoEntrega.uri,
          fotoEntrega.mime,
          `condominios/guardia/${entregarPaq.condominioId}/paquetes`,
        );
        fotoEntregaUrl = uploaded.url;
      }
      await entregar({
        id: entregarPaq._id,
        entregadoA: entregadoA || undefined,
        observaciones: obsEntrega || undefined,
        fotoEntregaUrl,
      });
      setEntregarPaq(null);
      setEntregadoA("");
      setObsEntrega("");
      setFotoEntrega(null);
    } catch (e) {
      Alert.alert("Error", e instanceof Error ? e.message : "No se pudo entregar.");
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
            <Text style={styles.title}>Paquetería</Text>
            <Tap onPress={() => setNuevoOpen(true)} style={styles.backBtn}>
              <Ionicons name="add" size={24} color={AuthUI.text} />
            </Tap>
          </View>

          <View style={styles.tabs}>
            {(
              [
                ["recibido", `Por entregar${pendientes ? ` (${pendientes})` : ""}`],
                ["entregado", "Entregados"],
              ] as const
            ).map(([key, label]) => (
              <Tap
                key={key}
                onPress={() => setTab(key)}
                style={[styles.tab, tab === key && styles.tabActive]}
              >
                <Text style={[styles.tabText, tab === key && styles.tabTextActive]}>
                  {label}
                </Text>
              </Tap>
            ))}
          </View>

          <View style={styles.searchWrap}>
            <Ionicons name="search" size={16} color={AuthUI.textMuted} />
            <TextInput
              style={styles.search}
              value={buscar}
              onChangeText={setBuscar}
              placeholder="Unidad, destinatario…"
              placeholderTextColor={AuthUI.textMuted}
            />
          </View>

          <ScrollView
            contentContainerStyle={styles.scroll}
            showsVerticalScrollIndicator={false}
          >
            {paquetes === undefined ? (
              <ActivityIndicator color={C.brand} style={{ marginTop: 24 }} />
            ) : filtrados.length === 0 ? (
              <GlassCard style={styles.empty}>
                <Ionicons name="cube-outline" size={28} color={AuthUI.textMuted} />
                <Text style={styles.emptyTitle}>
                  {tab === "recibido" ? "Sin paquetes pendientes" : "Sin entregas"}
                </Text>
              </GlassCard>
            ) : (
              <View style={{ gap: 10 }}>
                {filtrados.map((p) => (
                  <GlassCard key={p._id} style={styles.card}>
                    <View style={styles.cardTop}>
                      <Text style={styles.unidad}>Unidad {p.unidadNumero}</Text>
                      <GlassBadge
                        label={TIPOS.find((t) => t.key === p.tipo)?.label ?? p.tipo}
                        tone="neutral"
                      />
                    </View>
                    {p.destinatario ? (
                      <Text style={styles.line}>Para: {p.destinatario}</Text>
                    ) : null}
                    {p.remitente ? (
                      <Text style={styles.lineMuted}>De: {p.remitente}</Text>
                    ) : null}
                    <Text style={styles.lineMuted}>
                      {p.estado === "recibido"
                        ? `Recibido ${fmtHora(p.fechaRecibido)}`
                        : `Entregado ${fmtHora(p.fechaEntregado)}`}
                    </Text>
                    {p.fotoUrl ? (
                      <Image source={{ uri: p.fotoUrl }} style={styles.thumb} />
                    ) : null}
                    {p.estado === "recibido" ? (
                      <>
                        <Tap
                          onPress={() => setEntregarPaq(p)}
                          style={styles.entregarBtn}
                        >
                          <Text style={styles.entregarText}>Marcar entregado</Text>
                        </Tap>
                        <Tap
                          onPress={() => confirmarEliminar(p._id, p.unidadNumero)}
                          style={styles.eliminarBtn}
                        >
                          <Ionicons name="trash-outline" size={15} color={C.danger} />
                          <Text style={styles.eliminarText}>Eliminar registro</Text>
                        </Tap>
                      </>
                    ) : null}
                  </GlassCard>
                ))}
              </View>
            )}
          </ScrollView>
        </SafeAreaView>
      </ScreenBackground>

      <Modal visible={nuevoOpen} animationType="slide" presentationStyle="pageSheet">
        <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
          <View style={styles.modalHead}>
            <Tap onPress={() => !busy && (setNuevoOpen(false), resetNuevo())}>
              <Text style={styles.cancel}>Cancelar</Text>
            </Tap>
            <Text style={styles.modalTitle}>Recibir</Text>
            <Tap onPress={submitRecibir} disabled={busy}>
              <Text style={[styles.save, busy && { opacity: 0.5 }]}>
                {busy ? "…" : "Guardar"}
              </Text>
            </Tap>
          </View>
          <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
            <Field label="Unidad *">
              <TextInput
                style={styles.input}
                value={unidad}
                onChangeText={setUnidad}
                placeholder="Ej. 401"
                placeholderTextColor={AuthUI.textMuted}
              />
            </Field>
            <Field label="Tipo">
              <View style={styles.chips}>
                {TIPOS.map((t) => (
                  <Tap
                    key={t.key}
                    onPress={() => setTipo(t.key)}
                    style={[styles.chip, tipo === t.key && styles.chipActive]}
                  >
                    <Text
                      style={[styles.chipText, tipo === t.key && styles.chipTextActive]}
                    >
                      {t.label}
                    </Text>
                  </Tap>
                ))}
              </View>
            </Field>
            <Field label="Remitente">
              <TextInput
                style={styles.input}
                value={remitente}
                onChangeText={setRemitente}
                placeholder="Courier / empresa"
                placeholderTextColor={AuthUI.textMuted}
              />
            </Field>
            <Field label="Destinatario">
              <TextInput
                style={styles.input}
                value={destinatario}
                onChangeText={setDestinatario}
                placeholder="Nombre"
                placeholderTextColor={AuthUI.textMuted}
              />
            </Field>
            <Field label="Descripción">
              <TextInput
                style={styles.input}
                value={descripcion}
                onChangeText={setDescripcion}
                placeholder="Notas"
                placeholderTextColor={AuthUI.textMuted}
              />
            </Field>
            <Tap onPress={() => pickImage(setFoto)}>
              <GlassCard style={styles.fotoBtn}>
                <Ionicons name="camera-outline" size={20} color={AuthUI.text} />
                <Text style={styles.fotoLabel}>
                  {foto ? "Foto seleccionada" : "Foto de llegada (opcional)"}
                </Text>
              </GlassCard>
            </Tap>
            {foto ? (
              <Image source={{ uri: foto.uri }} style={styles.preview} />
            ) : null}
          </ScrollView>
        </SafeAreaView>
      </Modal>

      <Modal
        visible={!!entregarPaq}
        animationType="slide"
        presentationStyle="pageSheet"
      >
        <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
          <View style={styles.modalHead}>
            <Tap
              onPress={() => {
                if (busy) return;
                setEntregarPaq(null);
                setEntregadoA("");
                setObsEntrega("");
                setFotoEntrega(null);
              }}
            >
              <Text style={styles.cancel}>Cancelar</Text>
            </Tap>
            <Text style={styles.modalTitle}>Entregar</Text>
            <Tap onPress={submitEntregar} disabled={busy}>
              <Text style={[styles.save, busy && { opacity: 0.5 }]}>
                {busy ? "…" : "Confirmar"}
              </Text>
            </Tap>
          </View>
          <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
            <Text style={styles.modalHint}>
              Unidad {entregarPaq?.unidadNumero}
              {entregarPaq?.destinatario ? ` · ${entregarPaq.destinatario}` : ""}
            </Text>
            <Field label="Entregado a">
              <TextInput
                style={styles.input}
                value={entregadoA}
                onChangeText={setEntregadoA}
                placeholder="Quién recibe"
                placeholderTextColor={AuthUI.textMuted}
              />
            </Field>
            <Field label="Observaciones">
              <TextInput
                style={styles.input}
                value={obsEntrega}
                onChangeText={setObsEntrega}
                placeholder="Opcional"
                placeholderTextColor={AuthUI.textMuted}
              />
            </Field>
            <Tap onPress={() => pickImage(setFotoEntrega)}>
              <GlassCard style={styles.fotoBtn}>
                <Ionicons name="camera-outline" size={20} color={AuthUI.text} />
                <Text style={styles.fotoLabel}>
                  {fotoEntrega ? "Evidencia lista" : "Foto de entrega (opcional)"}
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
  title: { fontSize: 17, fontFamily: AuthUI.font.semibold, color: AuthUI.text },
  tabs: {
    flexDirection: "row",
    marginHorizontal: 16,
    marginBottom: 10,
    backgroundColor: C.bgSubtle,
    borderRadius: 12,
    padding: 4,
  },
  tab: { flex: 1, paddingVertical: 8, borderRadius: 10, alignItems: "center" },
  tabActive: { backgroundColor: "#fff" },
  tabText: { fontSize: 13, color: AuthUI.textMuted, fontFamily: AuthUI.font.medium },
  tabTextActive: { color: AuthUI.text },
  searchWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: C.border,
  },
  search: { flex: 1, fontSize: 14, color: AuthUI.text },
  scroll: { paddingHorizontal: 16, paddingBottom: 40 },
  empty: { padding: 28, alignItems: "center", gap: 8 },
  emptyTitle: { fontSize: 15, fontFamily: AuthUI.font.semibold, color: AuthUI.text },
  card: { padding: 14, gap: 4 },
  cardTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  unidad: { fontSize: 15, fontFamily: AuthUI.font.semibold, color: AuthUI.text },
  line: { fontSize: 13, color: AuthUI.text },
  lineMuted: { fontSize: 12, color: AuthUI.textMuted },
  thumb: { width: "100%", height: 120, borderRadius: 10, marginTop: 8 },
  entregarBtn: {
    marginTop: 10,
    backgroundColor: C.brand,
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: "center",
  },
  entregarText: { color: "#fff", fontFamily: AuthUI.font.semibold, fontSize: 14 },
  eliminarBtn: {
    marginTop: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 8,
  },
  eliminarText: {
    color: C.danger,
    fontFamily: AuthUI.font.semibold,
    fontSize: 13,
  },
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
  modalHint: { fontSize: 14, color: AuthUI.textMuted, marginBottom: 4 },
  cancel: { color: AuthUI.textMuted, fontSize: 15 },
  save: { color: C.brand, fontSize: 15, fontFamily: AuthUI.font.semibold },
  fieldLabel: { fontSize: 12, fontFamily: AuthUI.font.medium, color: AuthUI.textMuted },
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
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: C.bgSubtle,
  },
  chipActive: { backgroundColor: C.brand },
  chipText: { fontSize: 13, color: AuthUI.text },
  chipTextActive: { color: "#fff" },
  fotoBtn: { padding: 14, flexDirection: "row", alignItems: "center", gap: 10 },
  fotoLabel: { fontSize: 14, color: AuthUI.text },
  preview: { width: "100%", height: 160, borderRadius: 12 },
});
