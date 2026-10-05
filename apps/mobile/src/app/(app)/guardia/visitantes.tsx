import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useMutation, useQuery, Authenticated } from "convex/react";
import { api } from "@vekino/backend/api";
import type { Id, Doc } from "@vekino/backend/dataModel";
import { useCondominio } from "@/context/condominio-context";
export { ErrorBoundaryOperativo as ErrorBoundary } from "@/components/guardia/error-operativo";
import { ScreenBackground, GlassCard, GlassBadge } from "@/components/ui/glass";
import { Tap } from "@/components/ui/tap";
import { AuthUI } from "@/lib/auth-ui";
import { C } from "@/lib/theme";

type ResumenScan = {
  accion: "ingreso" | "ya_activo" | "salida";
  id: string;
  nombre: string;
  documento: string;
  unidadNumero: string | null;
  anfitrionNombre: string | null;
  placa: string | null;
};
type Vis = Doc<"visitantes">;
type TabKey = "escanear" | "registrar" | "actividad";
type Filtro = "activo" | "esperando_aprobacion" | "finalizado";

const TIPO_DOC = ["CC", "CE", "NIT", "PASAPORTE", "OTRO"] as const;
const TIPO_VIS = ["visitante", "empresa", "domicilio"] as const;

function parseQr(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  try {
    const data = JSON.parse(text) as { id?: string };
    if (data && typeof data.id === "string") return data.id;
  } catch {
    /* id crudo */
  }
  return text;
}

function fmtHora(ts?: number) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("es-CO", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function GuardiaVisitantesScreen() {
  return (
    <Authenticated>
      <Inner />
    </Authenticated>
  );
}

function Inner() {
  const router = useRouter();
  const { tab: tabParam } = useLocalSearchParams<{ tab?: string }>();
  const { condominioId, isGuardia, canManage, isLoading } = useCondominio();
  const initial: TabKey =
    tabParam === "registrar" || tabParam === "actividad" || tabParam === "escanear"
      ? tabParam
      : "escanear";
  const [tab, setTab] = useState<TabKey>(initial);

  useEffect(() => {
    if (tabParam === "registrar" || tabParam === "actividad" || tabParam === "escanear") {
      setTab(tabParam);
    }
  }, [tabParam]);

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
        <Text style={{ color: C.text, fontFamily: AuthUI.font.semibold, fontSize: 16 }}>
          Sin acceso
        </Text>
        <Tap onPress={() => router.back()} style={{ marginTop: 16 }}>
          <Text style={{ color: C.brand }}>Volver</Text>
        </Tap>
      </SafeAreaView>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <ScreenBackground>
        <SafeAreaView style={{ flex: 1 }} edges={["top"]}>
          <View style={styles.header}>
            <Tap onPress={() => router.back()} style={styles.backBtn}>
              <Ionicons name="chevron-back" size={22} color={AuthUI.text} />
            </Tap>
            <Text style={styles.title}>Visitantes</Text>
            <View style={{ width: 40 }} />
          </View>

          <View style={styles.tabs}>
            {(
              [
                ["escanear", "Escanear", "qr-code-outline"],
                ["registrar", "Sin QR", "person-add-outline"],
                ["actividad", "Adentro", "people-outline"],
              ] as const
            ).map(([key, label, icon]) => {
              const active = tab === key;
              return (
                <Tap key={key} onPress={() => setTab(key)} style={{ flex: 1 }}>
                  <View style={[styles.tabPill, active && styles.tabPillActive]}>
                    <Ionicons
                      name={icon}
                      size={16}
                      color={active ? "#fff" : AuthUI.textMuted}
                    />
                    <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>
                      {label}
                    </Text>
                  </View>
                </Tap>
              );
            })}
          </View>

          {tab === "escanear" ? <EscanearTab /> : null}
          {tab === "registrar" ? <RegistrarTab condominioId={condominioId} /> : null}
          {tab === "actividad" ? <ActividadTab condominioId={condominioId} /> : null}
        </SafeAreaView>
      </ScreenBackground>
    </View>
  );
}

/* ───────── Escanear ───────── */
function EscanearTab() {
  const ingreso = useMutation(api.guardia.registrarIngreso);
  const salida = useMutation(api.guardia.registrarSalida);
  const [permission, requestPermission] = useCameraPermissions();
  const [pausado, setPausado] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mensaje, setMensaje] = useState<{ tone: "ok" | "error"; texto: string } | null>(null);
  const [resumen, setResumen] = useState<ResumenScan | null>(null);
  const [salidaId, setSalidaId] = useState<ResumenScan | null>(null);
  const [manual, setManual] = useState("");
  const lastScan = useRef(0);

  const procesar = useCallback(
    async (raw: string) => {
      const id = parseQr(raw);
      if (!id || busy) return;
      const now = Date.now();
      if (now - lastScan.current < 1800) return;
      lastScan.current = now;

      setBusy(true);
      setPausado(true);
      setMensaje(null);
      setResumen(null);
      try {
        const result = await ingreso({ id: id as Id<"visitantes"> });
        if (result.accion === "ya_activo") {
          setSalidaId(result);
        } else {
          setResumen(result);
          setMensaje({ tone: "ok", texto: "Ingreso registrado." });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : "";
        if (msg.includes("YA_ACTIVO")) {
          setSalidaId({
            accion: "ya_activo",
            id,
            nombre: "Visitante",
            documento: "",
            unidadNumero: null,
            anfitrionNombre: null,
            placa: null,
          });
        } else {
          setMensaje({
            tone: "error",
            texto: msg || "Código no reconocido.",
          });
        }
      } finally {
        setBusy(false);
        setTimeout(() => setPausado(false), 1600);
      }
    },
    [busy, ingreso],
  );

  async function confirmarSalida() {
    if (!salidaId) return;
    setBusy(true);
    try {
      await salida({ id: salidaId.id as Id<"visitantes"> });
      setResumen({ ...salidaId, accion: "salida" });
      setMensaje({ tone: "ok", texto: "Salida registrada." });
    } catch {
      setMensaje({ tone: "error", texto: "No se pudo registrar la salida." });
    } finally {
      setSalidaId(null);
      setBusy(false);
    }
  }

  if (!permission) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={C.brand} />
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={[styles.pad, { gap: 12 }]}>
        <Text style={styles.hint}>Necesitamos la cámara para escanear el QR.</Text>
        <Tap onPress={() => void requestPermission()}>
          <View style={styles.primaryBtn}>
            <Text style={styles.primaryBtnText}>Permitir cámara</Text>
          </View>
        </Tap>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.pad} keyboardShouldPersistTaps="handled">
      <View style={styles.cameraBox}>
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={
            pausado || busy
              ? undefined
              : (r) => {
                  void procesar(r.data);
                }
          }
        />
        <View style={styles.scanFrame} pointerEvents="none" />
      </View>

      <Text style={styles.hint}>
        Apunta al QR del visitante. Solo vale el día de la visita. Si ya está adentro, te
        pediremos confirmar la salida.
      </Text>

      {mensaje ? (
        <View
          style={[
            styles.msg,
            mensaje.tone === "ok" ? styles.msgOk : styles.msgErr,
          ]}
        >
          <Text
            style={{
              color: mensaje.tone === "ok" ? C.success : C.danger,
              fontFamily: AuthUI.font.semibold,
              fontSize: 13,
            }}
          >
            {mensaje.texto}
          </Text>
        </View>
      ) : null}

      {resumen ? (
        <View style={styles.resumenCard}>
          <Text style={styles.resumenKicker}>
            {resumen.accion === "salida" ? "Salida" : "Ingreso"}
          </Text>
          <Text style={styles.resumenNombre}>{resumen.nombre}</Text>
          <Text style={styles.resumenLine}>
            Va a {resumen.unidadNumero ? `unidad ${resumen.unidadNumero}` : "—"}
          </Text>
          <Text style={styles.resumenLine}>
            Anfitrión: {resumen.anfitrionNombre ?? "—"}
          </Text>
          {resumen.placa ? (
            <Text style={styles.resumenLine}>Placa {resumen.placa}</Text>
          ) : null}
        </View>
      ) : null}

      <Text style={[styles.fieldLabel, { marginTop: 16 }]}>Código manual</Text>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <TextInput
          value={manual}
          onChangeText={setManual}
          placeholder="Pega el id del QR"
          placeholderTextColor={AuthUI.textMuted}
          style={[styles.input, { flex: 1 }]}
          autoCapitalize="none"
        />
        <Tap
          onPress={() => {
            void procesar(manual);
            setManual("");
          }}
          disabled={!manual.trim() || busy}
        >
          <View style={[styles.secondaryBtn, { opacity: !manual.trim() || busy ? 0.5 : 1 }]}>
            <Text style={styles.secondaryBtnText}>Validar</Text>
          </View>
        </Tap>
      </View>

      <Modal visible={!!salidaId} transparent animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Visitante adentro</Text>
            {salidaId ? (
              <>
                <Text style={[styles.resumenNombre, { marginTop: 8 }]}>{salidaId.nombre}</Text>
                <Text style={styles.resumenLine}>
                  Va a {salidaId.unidadNumero ? `unidad ${salidaId.unidadNumero}` : "—"}
                </Text>
                <Text style={styles.resumenLine}>
                  Anfitrión: {salidaId.anfitrionNombre ?? "—"}
                </Text>
              </>
            ) : null}
            <Text style={[styles.hint, { marginTop: 8 }]}>
              Ya tiene ingreso activo. ¿Registrar salida?
            </Text>
            <View style={{ flexDirection: "row", gap: 10, marginTop: 16 }}>
              <Tap onPress={() => setSalidaId(null)} style={{ flex: 1 }}>
                <View style={styles.secondaryBtn}>
                  <Text style={styles.secondaryBtnText}>Cancelar</Text>
                </View>
              </Tap>
              <Tap onPress={() => void confirmarSalida()} style={{ flex: 1 }} disabled={busy}>
                <View style={styles.primaryBtn}>
                  {busy ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.primaryBtnText}>Salida</Text>
                  )}
                </View>
              </Tap>
            </View>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

/* ───────── Walk-in ───────── */
function RegistrarTab({ condominioId }: { condominioId: Id<"condominios"> }) {
  const registrar = useMutation(api.guardia.registrarDirecto);
  const [unidadNumero, setUnidadNumero] = useState("");
  const [nombre, setNombre] = useState("");
  const [documento, setDocumento] = useState("");
  const [tipoDocumento, setTipoDocumento] = useState<(typeof TIPO_DOC)[number]>("CC");
  const [tipo, setTipo] = useState<(typeof TIPO_VIS)[number]>("visitante");
  const [placa, setPlaca] = useState("");
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState(false);

  const valid = nombre.trim() && documento.trim() && unidadNumero.trim();

  async function save() {
    if (!valid) return;
    setBusy(true);
    setOk(false);
    try {
      await registrar({
        condominioId,
        unidadNumero: unidadNumero.trim(),
        nombre: nombre.trim(),
        documento: documento.trim(),
        tipoDocumento,
        tipo,
        placa: placa.trim() || undefined,
      });
      setOk(true);
      setUnidadNumero("");
      setNombre("");
      setDocumento("");
      setPlaca("");
    } catch (e) {
      Alert.alert("Error", e instanceof Error ? e.message : "No se pudo registrar.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.pad} keyboardShouldPersistTaps="handled">
      <GlassCard style={{ padding: 14, marginBottom: 14, gap: 6 }}>
        <Text style={{ color: AuthUI.text, fontFamily: AuthUI.font.semibold, fontSize: 14 }}>
          Antes de dejar pasar
        </Text>
        <Text style={styles.hint}>
          Llama o avisa al dueño de la unidad. La solicitud queda esperando su aceptación en la
          app; solo entonces el visitante queda adentro.
        </Text>
      </GlassCard>

      <Text style={styles.fieldLabel}>Nombre *</Text>
      <TextInput
        value={nombre}
        onChangeText={setNombre}
        placeholder="Nombre completo"
        placeholderTextColor={AuthUI.textMuted}
        style={styles.input}
      />

      <Text style={styles.fieldLabel}>Documento *</Text>
      <View style={styles.chipRow}>
        {TIPO_DOC.map((t) => {
          const active = tipoDocumento === t;
          return (
            <Tap key={t} onPress={() => setTipoDocumento(t)}>
              <View style={[styles.chip, active && styles.chipActive]}>
                <Text style={[styles.chipText, active && styles.chipTextActive]}>{t}</Text>
              </View>
            </Tap>
          );
        })}
      </View>
      <TextInput
        value={documento}
        onChangeText={setDocumento}
        placeholder="Número de documento"
        placeholderTextColor={AuthUI.textMuted}
        style={styles.input}
        keyboardType="number-pad"
      />

      <Text style={styles.fieldLabel}>Unidad *</Text>
      <TextInput
        value={unidadNumero}
        onChangeText={setUnidadNumero}
        placeholder="Ej. 409"
        placeholderTextColor={AuthUI.textMuted}
        style={styles.input}
      />

      <Text style={styles.fieldLabel}>Tipo</Text>
      <View style={styles.chipRow}>
        {TIPO_VIS.map((t) => {
          const active = tipo === t;
          const label = t === "visitante" ? "Visitante" : t === "empresa" ? "Empresa" : "Domicilio";
          return (
            <Tap key={t} onPress={() => setTipo(t)}>
              <View style={[styles.chip, active && styles.chipActive]}>
                <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
              </View>
            </Tap>
          );
        })}
      </View>

      <Text style={styles.fieldLabel}>Placa (opcional)</Text>
      <TextInput
        value={placa}
        onChangeText={(t) => setPlaca(t.toUpperCase())}
        placeholder="ABC123"
        placeholderTextColor={AuthUI.textMuted}
        style={styles.input}
        autoCapitalize="characters"
      />

      {ok ? (
        <Text style={{ color: C.success, marginTop: 12, fontFamily: AuthUI.font.semibold }}>
          Solicitud enviada. Espera la aceptación del residente.
        </Text>
      ) : null}

      <Tap onPress={() => void save()} disabled={!valid || busy} style={{ marginTop: 18 }}>
        <View style={[styles.primaryBtn, { opacity: !valid || busy ? 0.5 : 1 }]}>
          {busy ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.primaryBtnText}>Solicitar autorización</Text>
          )}
        </View>
      </Tap>
    </ScrollView>
  );
}

/* ───────── Lista ───────── */
function ActividadTab({ condominioId }: { condominioId: Id<"condominios"> }) {
  const visitantes = useQuery(api.guardia.listVisitantes, { condominioId });
  const salida = useMutation(api.guardia.registrarSalida);
  const [filtro, setFiltro] = useState<Filtro>("activo");
  const [buscar, setBuscar] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const filtrados = useMemo(() => {
    const q = buscar.trim().toLowerCase();
    return (visitantes ?? [])
      .filter((v) => v.estado === filtro)
      .filter((v) => {
        if (!q) return true;
        return `${v.nombre} ${v.documento} ${v.unidadNumero ?? ""} ${v.placa ?? ""}`
          .toLowerCase()
          .includes(q);
      });
  }, [visitantes, filtro, buscar]);

  async function marcarSalida(id: Id<"visitantes">) {
    setBusyId(id);
    try {
      await salida({ id });
    } catch (e) {
      Alert.alert("Error", e instanceof Error ? e.message : "No se pudo registrar la salida.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.pad} keyboardShouldPersistTaps="handled">
      <View style={styles.chipRow}>
        {(
          [
            ["activo", "Adentro"],
            ["esperando_aprobacion", "Por aprobar"],
            ["finalizado", "Historial"],
          ] as const
        ).map(([k, label]) => {
          const active = filtro === k;
          return (
            <Tap key={k} onPress={() => setFiltro(k)}>
              <View style={[styles.chip, active && styles.chipActive]}>
                <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
              </View>
            </Tap>
          );
        })}
      </View>

      <TextInput
        value={buscar}
        onChangeText={setBuscar}
        placeholder="Buscar nombre, doc, unidad…"
        placeholderTextColor={AuthUI.textMuted}
        style={[styles.input, { marginTop: 10 }]}
      />

      {visitantes === undefined ? (
        <ActivityIndicator color={C.brand} style={{ marginTop: 24 }} />
      ) : filtrados.length === 0 ? (
        <Text style={[styles.hint, { marginTop: 24, textAlign: "center" }]}>
          {filtro === "activo"
            ? "Nadie adentro"
            : filtro === "esperando_aprobacion"
              ? "Sin solicitudes pendientes"
              : "Sin historial"}
        </Text>
      ) : (
        <View style={{ gap: 10, marginTop: 14 }}>
          {filtrados.map((v) => (
            <VisitanteRow
              key={v._id}
              v={v}
              busy={busyId === v._id}
              onSalida={() => void marcarSalida(v._id)}
            />
          ))}
        </View>
      )}
    </ScrollView>
  );
}

function VisitanteRow({
  v,
  busy,
  onSalida,
}: {
  v: Vis;
  busy: boolean;
  onSalida: () => void;
}) {
  const badge =
    v.estado === "activo"
      ? { label: "Adentro", tone: "green" as const }
      : v.estado === "esperando_aprobacion"
        ? { label: "Esperando residente", tone: "yellow" as const }
        : { label: "Salió", tone: "neutral" as const };

  return (
    <GlassCard style={{ padding: 14, gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }}>
        <View style={{ flex: 1, gap: 4 }}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
            <Text style={{ color: AuthUI.text, fontFamily: AuthUI.font.semibold, fontSize: 15 }}>
              {v.nombre}
            </Text>
            <GlassBadge label={badge.label} tone={badge.tone} />
          </View>
          <Text style={{ color: AuthUI.textMuted, fontSize: 12 }}>
            {v.tipoDocumento} {v.documento}
            {v.unidadNumero ? ` · U. ${v.unidadNumero}` : ""}
            {v.placa ? ` · ${v.placa}` : ""}
          </Text>
          {v.fechaIngreso ? (
            <Text style={{ color: AuthUI.textMuted, fontSize: 11 }}>
              Entró: {fmtHora(v.fechaIngreso)}
            </Text>
          ) : null}
          {v.estado === "esperando_aprobacion" ? (
            <Text style={{ color: "#B45309", fontSize: 12, marginTop: 2 }}>
              Avisa al residente para que acepte en la app.
            </Text>
          ) : null}
        </View>
        {v.estado === "activo" ? (
          <Tap onPress={onSalida} disabled={busy}>
            <View style={[styles.secondaryBtn, { paddingHorizontal: 12 }]}>
              {busy ? (
                <ActivityIndicator size="small" color={AuthUI.text} />
              ) : (
                <Text style={styles.secondaryBtnText}>Salida</Text>
              )}
            </View>
          </Tap>
        ) : null}
      </View>
    </GlassCard>
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
  tabs: {
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 16,
    marginBottom: 8,
  },
  tabPill: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: "rgba(14,14,15,0.04)",
  },
  tabPillActive: {
    backgroundColor: "#0E0E0F",
  },
  tabLabel: {
    fontSize: 12,
    fontFamily: AuthUI.font.medium,
    color: AuthUI.textMuted,
  },
  tabLabelActive: {
    color: "#fff",
  },
  pad: {
    paddingHorizontal: 16,
    paddingBottom: 40,
    paddingTop: 8,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  cameraBox: {
    height: Platform.OS === "ios" ? 320 : 280,
    borderRadius: 16,
    overflow: "hidden",
    backgroundColor: "#0E0E0F",
    marginBottom: 12,
  },
  scanFrame: {
    position: "absolute",
    top: "22%",
    left: "14%",
    right: "14%",
    bottom: "22%",
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.7)",
    borderRadius: 16,
  },
  hint: {
    fontSize: 13,
    color: AuthUI.textMuted,
    fontFamily: AuthUI.font.regular,
    lineHeight: 18,
  },
  fieldLabel: {
    marginTop: 12,
    marginBottom: 6,
    fontSize: 12,
    fontFamily: AuthUI.font.semibold,
    color: AuthUI.textMuted,
  },
  input: {
    height: 44,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(14,14,15,0.1)",
    paddingHorizontal: 12,
    backgroundColor: "#fff",
    color: AuthUI.text,
    fontFamily: AuthUI.font.regular,
    fontSize: 14,
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 8,
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: "rgba(14,14,15,0.05)",
  },
  chipActive: {
    backgroundColor: "#0E0E0F",
  },
  chipText: {
    fontSize: 12,
    fontFamily: AuthUI.font.medium,
    color: AuthUI.textMuted,
  },
  chipTextActive: {
    color: "#fff",
  },
  primaryBtn: {
    height: 46,
    borderRadius: 12,
    backgroundColor: "#0E0E0F",
    alignItems: "center",
    justifyContent: "center",
  },
  primaryBtnText: {
    color: "#fff",
    fontFamily: AuthUI.font.semibold,
    fontSize: 14,
  },
  secondaryBtn: {
    height: 44,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(14,14,15,0.12)",
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  secondaryBtnText: {
    color: AuthUI.text,
    fontFamily: AuthUI.font.semibold,
    fontSize: 13,
  },
  msg: {
    marginTop: 12,
    padding: 12,
    borderRadius: 12,
  },
  msgOk: {
    backgroundColor: "#F0FDF4",
  },
  msgErr: {
    backgroundColor: "#FEF2F2",
  },
  resumenCard: {
    marginTop: 12,
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(14,14,15,0.1)",
    backgroundColor: "#fff",
    gap: 4,
  },
  resumenKicker: {
    fontSize: 11,
    fontFamily: AuthUI.font.semibold,
    color: AuthUI.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  resumenNombre: {
    fontSize: 18,
    fontFamily: AuthUI.font.semibold,
    color: AuthUI.text,
  },
  resumenLine: {
    fontSize: 13,
    fontFamily: AuthUI.font.regular,
    color: AuthUI.textMuted,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  modalCard: {
    width: "100%",
    maxWidth: 360,
    borderRadius: 16,
    backgroundColor: "#fff",
    padding: 20,
  },
  modalTitle: {
    fontSize: 17,
    fontFamily: AuthUI.font.semibold,
    color: AuthUI.text,
    marginBottom: 8,
  },
});
