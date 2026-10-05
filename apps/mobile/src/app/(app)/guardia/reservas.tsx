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
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { useMutation, useQuery, useAction, Authenticated } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@vekino/backend/api";
import type { Id } from "@vekino/backend/dataModel";
import { useCondominio } from "@/context/condominio-context";
export { ErrorBoundaryOperativo as ErrorBoundary } from "@/components/guardia/error-operativo";
import { ScreenBackground, GlassCard, GlassBadge } from "@/components/ui/glass";
import { Tap } from "@/components/ui/tap";
import { AuthUI } from "@/lib/auth-ui";
import { C } from "@/lib/theme";
import { uploadLocalFile } from "@/lib/guardia-upload";

type ReservaRow = FunctionReturnType<typeof api.guardia.listReservasControl>[number];

const pesos = (n: number) => `$${n.toLocaleString("es-CO")}`;

export default function GuardiaReservasScreen() {
  return (
    <Authenticated>
      <Inner />
    </Authenticated>
  );
}

function Inner() {
  const router = useRouter();
  const { condominioId, isGuardia, canManage, isLoading } = useCondominio();
  const reservas = useQuery(
    api.guardia.listReservasControl,
    condominioId ? { condominioId } : "skip",
  );

  const validarIngreso = useMutation(api.guardia.validarIngresoReserva);
  const validarSalida = useMutation(api.guardia.validarSalidaReserva);
  const registrarDeposito = useMutation(api.guardia.registrarDepositoReserva);
  const resolverDeposito = useMutation(api.guardia.resolverDepositoReserva);
  const reportarIncidente = useMutation(api.guardia.reportarIncidenteReserva);
  const generateUploadUrl = useAction(api.files.generateUploadUrl);

  const [filtro, setFiltro] = useState<"hoy" | "todas">("hoy");
  /* Ids y no filas: la devolución tiene que ver lo que la administración
   * valore mientras el modal está abierto. */
  const [depositoId, setDepositoId] = useState<Id<"reservas"> | null>(null);
  const [devolverId, setDevolverId] = useState<Id<"reservas"> | null>(null);
  const [incidenteId, setIncidenteId] = useState<Id<"reservas"> | null>(null);
  const [monto, setMonto] = useState("");
  const [obs, setObs] = useState("");
  const [foto, setFoto] = useState<{ uri: string; mime: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const hoy = new Date().toISOString().slice(0, 10);

  const list = useMemo(() => {
    const rows = (reservas ?? []) as ReservaRow[];
    /* Un depósito que quedó en custodia de otro día sigue siendo trabajo de hoy. */
    if (filtro === "hoy") {
      return rows.filter((r) => r.fecha === hoy || r.deposito?.estado === "registrado");
    }
    return rows;
  }, [reservas, filtro, hoy]);

  const buscar = (id: Id<"reservas"> | null) =>
    id ? ((reservas ?? []) as ReservaRow[]).find((r) => r._id === id) ?? null : null;
  const depositoReserva = buscar(depositoId);
  const devolverReserva = buscar(devolverId);
  const incidenteReserva = buscar(incidenteId);

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

  function limpiar() {
    setMonto("");
    setObs("");
    setFoto(null);
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
    setFoto({ uri: a.uri, mime: a.mimeType ?? "image/jpeg" });
  }

  async function subirFoto(carpeta: string) {
    if (!foto) return undefined;
    const uploaded = await uploadLocalFile(generateUploadUrl, foto.uri, foto.mime, carpeta);
    return uploaded.url;
  }

  async function onIngreso(r: ReservaRow) {
    try {
      await validarIngreso({ reservaId: r._id });
    } catch (e) {
      Alert.alert("Error", e instanceof Error ? e.message : "No se pudo validar.");
    }
  }

  async function onSalida(r: ReservaRow) {
    try {
      await validarSalida({ reservaId: r._id });
    } catch (e) {
      Alert.alert("Error", e instanceof Error ? e.message : "No se pudo validar.");
    }
  }

  async function submitDeposito() {
    if (!depositoReserva) return;
    const montoNum = Number(monto.replace(/[^\d.]/g, ""));
    if (!Number.isFinite(montoNum) || montoNum <= 0) {
      Alert.alert("Monto inválido", "Ingresa un monto mayor a 0.");
      return;
    }
    setBusy(true);
    try {
      const fotoUrl = await subirFoto(`condominios/guardia/${depositoReserva.condominioId}/depositos`);
      await registrarDeposito({
        reservaId: depositoReserva._id,
        monto: montoNum,
        observaciones: obs || undefined,
        fotoUrl,
      });
      setDepositoId(null);
      limpiar();
    } catch (e) {
      Alert.alert("Error", e instanceof Error ? e.message : "No se pudo registrar.");
    } finally {
      setBusy(false);
    }
  }

  async function submitIncidente() {
    if (!incidenteReserva) return;
    if (!obs.trim()) {
      Alert.alert("Falta la descripción", "Describe qué pasó.");
      return;
    }
    setBusy(true);
    try {
      const url = await subirFoto(`condominios/guardia/${incidenteReserva.condominioId}/incidentes`);
      await reportarIncidente({
        reservaId: incidenteReserva._id,
        descripcion: obs.trim(),
        fotos: url ? [{ url }] : undefined,
      });
      setIncidenteId(null);
      limpiar();
    } catch (e) {
      Alert.alert("Error", e instanceof Error ? e.message : "No se pudo reportar.");
    } finally {
      setBusy(false);
    }
  }

  async function submitDevolucion() {
    const r = devolverReserva;
    const l = r?.liquidacion;
    if (!r?.deposito || !l) return;
    if (!l.puedeLiquidar) {
      Alert.alert(
        "Incidentes por valorar",
        "La administración debe valorar o descartar los incidentes antes de devolver el depósito.",
      );
      return;
    }
    if (l.razonObligatoria && !obs.trim()) {
      Alert.alert("Razón requerida", "Hubo incidentes: indica la razón de la devolución.");
      return;
    }
    setBusy(true);
    try {
      const fotoUrl = await subirFoto(`condominios/guardia/${r.condominioId}/depositos`);
      await resolverDeposito({
        depositoId: r.deposito._id,
        saldoEsperado: l.saldoDevolucion,
        observaciones: obs.trim() || undefined,
        fotoUrl,
      });
      setDevolverId(null);
      limpiar();
    } catch (e) {
      Alert.alert("Error", e instanceof Error ? e.message : "No se pudo devolver.");
    } finally {
      setBusy(false);
    }
  }

  const liq = devolverReserva?.liquidacion ?? null;

  return (
    <View style={{ flex: 1 }}>
      <ScreenBackground>
        <SafeAreaView style={{ flex: 1 }} edges={["top"]}>
          <View style={styles.header}>
            <Tap onPress={() => router.back()} style={styles.backBtn}>
              <Ionicons name="chevron-back" size={22} color={AuthUI.text} />
            </Tap>
            <Text style={styles.title}>Reservas</Text>
            <View style={{ width: 40 }} />
          </View>

          <View style={styles.tabs}>
            {(
              [
                ["hoy", "Hoy"],
                ["todas", "Todas"],
              ] as const
            ).map(([key, label]) => (
              <Tap
                key={key}
                onPress={() => setFiltro(key)}
                style={[styles.tab, filtro === key && styles.tabActive]}
              >
                <Text style={[styles.tabText, filtro === key && styles.tabTextActive]}>
                  {label}
                </Text>
              </Tap>
            ))}
          </View>

          <ScrollView
            contentContainerStyle={styles.scroll}
            showsVerticalScrollIndicator={false}
          >
            <Text style={styles.subtitle}>
              Valida ingresos y salidas de zonas comunes
            </Text>

            {reservas === undefined ? (
              <ActivityIndicator color={C.brand} style={{ marginTop: 24 }} />
            ) : list.length === 0 ? (
              <GlassCard style={styles.empty}>
                <Ionicons name="calendar-outline" size={28} color={AuthUI.textMuted} />
                <Text style={styles.emptyTitle}>Sin reservas</Text>
                <Text style={styles.emptyHint}>
                  {filtro === "hoy"
                    ? "No hay reservas aprobadas para hoy."
                    : "No hay reservas aprobadas pendientes de control."}
                </Text>
              </GlassCard>
            ) : (
              <View style={{ gap: 10 }}>
                {list.map((r) => {
                  const ingreso = !!r.ingresoValidadoAt;
                  const salida = !!r.salidaValidadaAt;
                  const enCustodia = r.deposito?.estado === "registrado";
                  const pendientes = r.liquidacion?.pendientes ?? 0;
                  const puedeDevolver = enCustodia && (salida || pendientes === 0);
                  const abrirDevolucion = () => {
                    limpiar();
                    setDevolverId(r._id);
                  };
                  return (
                    <GlassCard key={r._id} style={styles.card}>
                      <Text style={styles.zona}>{r.zonaNombre}</Text>
                      <Text style={styles.meta}>
                        Unidad {r.unidadNumero} · {r.solicitanteNombre}
                      </Text>
                      <Text style={styles.meta}>
                        {r.fecha} · {r.horaInicio}–{r.horaFin}
                      </Text>
                      <View style={styles.badges}>
                        {ingreso ? (
                          <GlassBadge label="Ingreso OK" tone="green" />
                        ) : (
                          <GlassBadge label="Sin ingreso" tone="yellow" />
                        )}
                        {salida ? (
                          <GlassBadge label="Salida OK" tone="green" />
                        ) : ingreso ? (
                          <GlassBadge label="En uso" tone="blue" />
                        ) : null}
                        {enCustodia ? (
                          <GlassBadge label="Depósito en custodia" tone="orange" />
                        ) : null}
                        {pendientes > 0 ? (
                          <GlassBadge
                            label={pendientes === 1 ? "1 incidente por valorar" : `${pendientes} por valorar`}
                            tone="yellow"
                          />
                        ) : null}
                      </View>

                      <View style={styles.actions}>
                        {!ingreso ? (
                          <>
                            <Tap
                              onPress={() => onIngreso(r)}
                              style={[styles.btn, styles.btnPrimary]}
                            >
                              <Text style={styles.btnPrimaryText}>Validar ingreso</Text>
                            </Tap>
                            <Tap
                              onPress={() => {
                                limpiar();
                                setMonto(r.depositoRequerido ? String(r.depositoRequerido) : "");
                                setDepositoId(r._id);
                              }}
                              style={[styles.btn, styles.btnOutline]}
                            >
                              <Text style={styles.btnOutlineText}>Con depósito</Text>
                            </Tap>
                          </>
                        ) : (
                          <>
                            {!salida && !puedeDevolver ? (
                              /* Con incidentes por valorar la salida no espera;
                               * el depósito se queda en portería. */
                              <Tap onPress={() => onSalida(r)} style={[styles.btn, styles.btnPrimary]}>
                                <Text style={styles.btnPrimaryText}>Validar salida</Text>
                              </Tap>
                            ) : null}
                            {puedeDevolver ? (
                              <Tap onPress={abrirDevolucion} style={[styles.btn, styles.btnPrimary]}>
                                <Text style={styles.btnPrimaryText}>Devolver depósito</Text>
                              </Tap>
                            ) : null}
                            {r.incidentesAbiertos ? (
                              <Tap
                                onPress={() => {
                                  limpiar();
                                  setIncidenteId(r._id);
                                }}
                                style={[styles.btn, styles.btnOutline]}
                              >
                                <Text style={styles.btnOutlineText}>Reportar incidente</Text>
                              </Tap>
                            ) : null}
                            {salida && !enCustodia ? (
                              <Text style={styles.done}>Control completo</Text>
                            ) : null}
                          </>
                        )}
                      </View>
                    </GlassCard>
                  );
                })}
              </View>
            )}
          </ScrollView>
        </SafeAreaView>
      </ScreenBackground>

      <Modal
        visible={!!depositoReserva}
        animationType="slide"
        presentationStyle="pageSheet"
      >
        <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
          <View style={styles.modalHead}>
            <Tap onPress={() => !busy && setDepositoId(null)}>
              <Text style={styles.cancel}>Cancelar</Text>
            </Tap>
            <Text style={styles.modalTitle}>Depósito</Text>
            <Tap onPress={submitDeposito} disabled={busy}>
              <Text style={[styles.save, busy && { opacity: 0.5 }]}>
                {busy ? "…" : "Registrar"}
              </Text>
            </Tap>
          </View>
          <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
            <Text style={styles.modalHint}>
              {depositoReserva?.zonaNombre} · Unidad {depositoReserva?.unidadNumero}
            </Text>
            <Field label="Monto *">
              <TextInput
                style={styles.input}
                value={monto}
                onChangeText={setMonto}
                keyboardType="numeric"
                placeholder="0"
                placeholderTextColor={AuthUI.textMuted}
              />
            </Field>
            <Field label="Observaciones">
              <TextInput
                style={styles.input}
                value={obs}
                onChangeText={setObs}
                placeholder="Opcional"
                placeholderTextColor={AuthUI.textMuted}
              />
            </Field>
            <FotoBoton foto={!!foto} etiqueta="Foto (opcional)" onPress={pickFoto} />
          </ScrollView>
        </SafeAreaView>
      </Modal>

      <Modal visible={!!incidenteReserva} animationType="slide" presentationStyle="pageSheet">
        <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
          <View style={styles.modalHead}>
            <Tap onPress={() => !busy && setIncidenteId(null)}>
              <Text style={styles.cancel}>Cancelar</Text>
            </Tap>
            <Text style={styles.modalTitle}>Reportar incidente</Text>
            <Tap onPress={submitIncidente} disabled={busy}>
              <Text style={[styles.save, busy && { opacity: 0.5 }]}>
                {busy ? "…" : "Reportar"}
              </Text>
            </Tap>
          </View>
          <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
            <Text style={styles.modalHint}>
              {incidenteReserva?.zonaNombre} · Unidad {incidenteReserva?.unidadNumero}
            </Text>
            <Field label="¿Qué pasó? *">
              <TextInput
                style={[styles.input, { minHeight: 90, textAlignVertical: "top" }]}
                value={obs}
                onChangeText={setObs}
                multiline
                placeholder="Se rompió una silla, quedó una mancha…"
                placeholderTextColor={AuthUI.textMuted}
              />
            </Field>
            <FotoBoton foto={!!foto} etiqueta="Foto (opcional)" onPress={pickFoto} />
            <Text style={styles.note}>
              La administración revisará el incidente y decidirá cuánto descontar del depósito.
            </Text>
          </ScrollView>
        </SafeAreaView>
      </Modal>

      <Modal visible={!!devolverReserva} animationType="slide" presentationStyle="pageSheet">
        <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
          <View style={styles.modalHead}>
            <Tap onPress={() => !busy && setDevolverId(null)}>
              <Text style={styles.cancel}>Cancelar</Text>
            </Tap>
            <Text style={styles.modalTitle}>Devolver depósito</Text>
            <Tap onPress={submitDevolucion} disabled={busy || !liq?.puedeLiquidar}>
              <Text style={[styles.save, (busy || !liq?.puedeLiquidar) && { opacity: 0.5 }]}>
                {busy ? "…" : "Confirmar"}
              </Text>
            </Tap>
          </View>
          <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
            <Text style={styles.modalHint}>
              {devolverReserva?.zonaNombre} · Unidad {devolverReserva?.unidadNumero}
            </Text>
            {liq ? (
              <GlassCard style={{ padding: 14, gap: 6 }}>
                <Fila etiqueta="Depósito recibido" valor={pesos(liq.deposito)} />
                {liq.valorados > 0 ? (
                  <Fila etiqueta={`Incidentes valorados (${liq.valorados})`} valor={pesos(liq.totalIncidentes)} />
                ) : null}
                <Fila
                  etiqueta="Descuento aplicado"
                  valor={liq.totalDescuento > 0 ? `− ${pesos(liq.totalDescuento)}` : pesos(0)}
                />
                <Fila etiqueta="Saldo a devolver" valor={pesos(liq.saldoDevolucion)} fuerte />
              </GlassCard>
            ) : null}
            {liq && liq.excedenteNoCubierto > 0 ? (
              <Text style={styles.note}>
                Los incidentes superan el depósito en {pesos(liq.excedenteNoCubierto)}. Esa diferencia
                se resuelve por fuera del sistema.
              </Text>
            ) : null}
            {liq && liq.pendientes > 0 ? (
              <Text style={styles.warning}>
                Hay incidentes pendientes de valoración. El depósito no se puede devolver hasta que la
                administración los valore o descarte.
              </Text>
            ) : null}
            {(devolverReserva?.incidentes ?? []).map((i) => (
              <GlassCard key={i._id} style={{ padding: 12, gap: 4 }}>
                <Text style={styles.incDesc}>{i.descripcion}</Text>
                <Text style={styles.meta}>
                  {i.estado === "pendiente"
                    ? "Pendiente de valoración"
                    : i.estado === "descartado"
                      ? "Descartado"
                      : `Valorado ${pesos(i.valor ?? 0)}`}
                  {" · "}Reportó {i.reportadoPorNombre}
                </Text>
              </GlassCard>
            ))}
            {liq?.puedeLiquidar ? (
              <>
                <Field label={liq.razonObligatoria ? "Razón de la devolución *" : "Razón de la devolución (opcional)"}>
                  <TextInput
                    style={[styles.input, { minHeight: 80, textAlignVertical: "top" }]}
                    value={obs}
                    onChangeText={setObs}
                    multiline
                    placeholder={
                      liq.totalDescuento > 0
                        ? `Devolución parcial. Se descontaron ${pesos(liq.totalDescuento)}.`
                        : "Opcional"
                    }
                    placeholderTextColor={AuthUI.textMuted}
                  />
                </Field>
                <FotoBoton foto={!!foto} etiqueta="Foto de la entrega (opcional)" onPress={pickFoto} />
              </>
            ) : null}
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

function Fila({ etiqueta, valor, fuerte }: { etiqueta: string; valor: string; fuerte?: boolean }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}>
      <Text style={fuerte ? styles.filaFuerte : styles.meta}>{etiqueta}</Text>
      <Text style={fuerte ? styles.filaFuerte : styles.filaValor}>{valor}</Text>
    </View>
  );
}

function FotoBoton({ foto, etiqueta, onPress }: { foto: boolean; etiqueta: string; onPress: () => void }) {
  return (
    <Tap onPress={onPress}>
      <GlassCard style={styles.fotoBtn}>
        <Ionicons name="camera-outline" size={20} color={AuthUI.text} />
        <Text style={styles.fotoLabel}>{foto ? "Foto lista" : etiqueta}</Text>
      </GlassCard>
    </Tap>
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
  scroll: { paddingHorizontal: 16, paddingBottom: 40 },
  subtitle: { fontSize: 13, color: AuthUI.textMuted, marginBottom: 14 },
  empty: { padding: 28, alignItems: "center", gap: 8 },
  emptyTitle: { fontSize: 15, fontFamily: AuthUI.font.semibold, color: AuthUI.text },
  emptyHint: { fontSize: 13, color: AuthUI.textMuted, textAlign: "center" },
  card: { padding: 14, gap: 4 },
  zona: { fontSize: 15, fontFamily: AuthUI.font.semibold, color: AuthUI.text },
  meta: { fontSize: 12, color: AuthUI.textMuted },
  badges: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 6 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 },
  btn: {
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  btnPrimary: { backgroundColor: C.brand },
  btnPrimaryText: { color: "#fff", fontFamily: AuthUI.font.semibold, fontSize: 13 },
  btnOutline: { borderWidth: 1, borderColor: C.border, backgroundColor: "#fff" },
  btnOutlineText: { color: AuthUI.text, fontFamily: AuthUI.font.medium, fontSize: 13 },
  done: { fontSize: 13, color: AuthUI.textMuted, fontFamily: AuthUI.font.medium },
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
  modalHint: { fontSize: 14, color: AuthUI.textMuted },
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
  fotoBtn: { padding: 14, flexDirection: "row", alignItems: "center", gap: 10 },
  fotoLabel: { fontSize: 14, color: AuthUI.text },
  note: { fontSize: 12, color: AuthUI.textMuted },
  warning: {
    fontSize: 12,
    color: "#b45309",
    backgroundColor: "rgba(245, 158, 11, 0.12)",
    padding: 10,
    borderRadius: 10,
  },
  incDesc: { fontSize: 14, color: AuthUI.text },
  filaValor: { fontSize: 13, color: AuthUI.text },
  filaFuerte: { fontSize: 14, color: AuthUI.text, fontFamily: AuthUI.font.semibold },
});
