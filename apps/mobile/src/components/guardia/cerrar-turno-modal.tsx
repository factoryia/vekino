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
  Switch,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useMutation, useQuery } from "convex/react";
import { api } from "@vekino/backend/api";
import type { Doc, Id } from "@vekino/backend/dataModel";
import { CAMPOS_PEDIDOS_CIERRE, erroresCierreTurno } from "@vekino/backend/cierreTurno";
import { GlassCard } from "@/components/ui/glass";
import { Tap } from "@/components/ui/tap";
import { AuthUI } from "@/lib/auth-ui";
import { C } from "@/lib/theme";

/*
 * El cierre formal del turno, aparte de la minuta porque se abre desde dos
 * sitios: la minuta de su portería, y el inicio de la portería que el guarda
 * cubre cuando dejó abierto el turno de su conjunto de siempre (la excepción
 * de la cobertura; ver `guardia.turnoPendienteDeCierre`). La web hace lo mismo
 * con `apps/web/components/guardia/cerrar-turno-modal.tsx`.
 */

/** Chip del selector de relevo para escribir el nombre a mano. */
const RELEVO_OTRO = "__otro__";

/* Lo que el cierre pide hoy. Lo que no se pide no se pinta ni se manda, pero
 * su código se queda: se vuelve a pedir desde `CAMPOS_PEDIDOS_CIERRE`. */
const pide = CAMPOS_PEDIDOS_CIERRE;

export function CerrarTurnoModal({
  turno,
  stats,
  condominioNombre,
  onClose,
}: {
  turno: Doc<"guardiaTurnos"> & { rondasCount: number };
  /** El resumen del turno. Desde otra portería no se tiene: no se pinta. */
  stats?: { visitantes: number; paquetes: number; incidentes: number; rondas: number };
  /** Si el turno es de otro conjunto (la excepción de la cobertura), cuál. */
  condominioNombre?: string;
  onClose: () => void;
}) {
  const cerrar = useMutation(api.guardia.cerrarTurno);
  /* Los relevos salen de la MISMA autorización que el cierre: así también los
   * recibe el guarda que cierra su turno desde la portería que cubre, y solo
   * aparecen los guardas que hoy operan en la portería del turno. */
  const equipo = useQuery(
    api.guardia.relevosDelTurno,
    pide.recibe ? { turnoId: turno._id } : "skip",
  );
  const [hayNovedades, setHayNovedades] = useState(false);
  const [detalleNovedades, setDetalleNovedades] = useState("");
  /* userId del relevo elegido, RELEVO_OTRO para escribirlo, o null. */
  const [relevo, setRelevo] = useState<string | null>(null);
  const [relevoManual, setRelevoManual] = useState("");
  const [consignas, setConsignas] = useState("");
  const [obs, setObs] = useState("");
  const [intentado, setIntentado] = useState(false);
  const [busy, setBusy] = useState(false);

  /* Quien entrega no se ofrece como relevo: ni el que abrió ni su compañero.
   * Ya viene filtrado del servidor. */
  const opciones = equipo ?? [];
  /* Cuenta compartida o portería sin más usuarios: el relevo se escribe. */
  const manual =
    relevo === RELEVO_OTRO || (equipo !== undefined && opciones.length === 0);
  const recibeNombre = manual
    ? relevoManual
    : (opciones.find((g) => g.userId === relevo)?.nombre ?? "");
  const elementos = turno.checklist;

  const errores = erroresCierreTurno({
    consignas,
    recibe: recibeNombre,
    observacionesCierre: obs,
    novedadesElementos: pide.elementos ? hayNovedades : undefined,
    novedadesElementosDetalle: detalleNovedades,
    elementosAsignados: elementos.length,
  });
  const valido = Object.keys(errores).length === 0;
  const mostrar = (campo: keyof typeof errores) =>
    intentado ? errores[campo] : undefined;

  async function confirmar() {
    if (busy) return;
    setIntentado(true);
    if (!valido) {
      Alert.alert(
        "Faltan datos",
        Object.values(errores).join("\n"),
      );
      return;
    }
    setBusy(true);
    try {
      await cerrar({
        turnoId: turno._id,
        ...(pide.recibe
          ? manual
            ? { recibe: relevoManual.trim() }
            : { recibeUserId: relevo as Id<"users"> }
          : {}),
        ...(pide.consignas ? { consignas: consignas.trim() } : {}),
        ...(pide.observacionesCierre ? { observacionesCierre: obs.trim() } : {}),
        /* Sin la pregunta no se manda un "no": no preguntar no es "sin novedad". */
        ...(pide.elementos
          ? {
              novedadesElementos: hayNovedades,
              novedadesElementosDetalle: hayNovedades ? detalleNovedades.trim() : undefined,
            }
          : {}),
      });
      onClose();
    } catch (e) {
      Alert.alert("Error", e instanceof Error ? e.message : "No se pudo cerrar.");
      setBusy(false);
    }
  }

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet">
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
        <View style={styles.modalHead}>
          <Tap onPress={() => !busy && onClose()}>
            <Text style={styles.cancel}>Cancelar</Text>
          </Tap>
          <Text style={styles.modalTitle} numberOfLines={1}>
            {condominioNombre ? `Cerrar turno en ${condominioNombre}` : "Cerrar turno"}
          </Text>
          <Tap onPress={confirmar} disabled={busy}>
            <Text style={[styles.save, (!valido || busy) && { opacity: 0.45 }]}>
              {busy ? "…" : "Cerrar"}
            </Text>
          </Tap>
        </View>
        <ScrollView
          contentContainerStyle={{ padding: 16, gap: 12 }}
          keyboardShouldPersistTaps="handled"
        >
          {stats ? (
            <View style={styles.stats}>
              {(
                [
                  ["Visitantes", stats.visitantes],
                  ["Paquetes", stats.paquetes],
                  ["Rondas", stats.rondas],
                  ["Incidentes", stats.incidentes],
                ] as const
              ).map(([label, value]) => (
                <GlassCard key={label} style={styles.statCard}>
                  <Text style={styles.statValue}>{value}</Text>
                  <Text style={styles.statLabel}>{label}</Text>
                </GlassCard>
              ))}
            </View>
          ) : null}
          <Field label="Entrega el turno">
            <TextInput
              style={[styles.input, { opacity: 0.7 }]}
              value={turno.guardiaNombre}
              editable={false}
            />
          </Field>

          {pide.elementos ? (
            <>
              {/* Los elementos son los que se firmaron al iniciar: aquí solo se leen. */}
              <Field label="Elementos asignados">
                {elementos.length === 0 ? (
                  <Text style={styles.hintRequired}>
                    Este turno no registró elementos al iniciar.
                  </Text>
                ) : (
                  <GlassCard style={styles.elementos}>
                    {elementos.map((c, i) => (
                      <View
                        key={i}
                        style={[styles.elementoRow, i > 0 && styles.elementoDivider]}
                      >
                        <Ionicons name="lock-closed-outline" size={14} color={AuthUI.textMuted} />
                        <View style={{ flex: 1 }}>
                          <Text style={styles.elementoNombre}>{c.item}</Text>
                          {!c.estadoOk ? (
                            <Text style={styles.elementoNovedad}>
                              Al recibir: {c.observacion || "con novedad"}
                            </Text>
                          ) : null}
                        </View>
                        <Text style={styles.elementoCantidad}>
                          {c.cantidadEncontrada}/{c.cantidadEsperada}
                        </Text>
                      </View>
                    ))}
                  </GlassCard>
                )}
                <Text style={styles.hintRequired}>
                  Registrados al iniciar el turno. No se modifican al cerrarlo.
                </Text>
              </Field>

              {elementos.length > 0 ? (
                <View style={{ gap: 8 }}>
                  <View style={styles.novedadesRow}>
                    <Text style={[styles.fieldLabel, { flex: 1 }]}>
                      ¿Existen novedades con los elementos asignados?
                    </Text>
                    <Switch
                      value={hayNovedades}
                      onValueChange={setHayNovedades}
                      trackColor={{ true: "#F59E0B", false: C.border }}
                    />
                  </View>
                  {hayNovedades ? (
                    <Field label="Detalle de la novedad *">
                      <TextInput
                        style={[styles.input, styles.inputMultiline]}
                        value={detalleNovedades}
                        onChangeText={setDetalleNovedades}
                        multiline
                        placeholder="Ej. La linterna presenta daño en el interruptor y el radio tiene la batería descargada."
                        placeholderTextColor={AuthUI.textMuted}
                      />
                      <FieldError mensaje={mostrar("novedadesElementosDetalle")} />
                    </Field>
                  ) : null}
                  <FieldError mensaje={mostrar("novedadesElementos")} />
                </View>
              ) : null}
            </>
          ) : null}

          {pide.recibe ? (
            <Field label="Guarda que recibe el turno *">
              {equipo === undefined ? (
                <ActivityIndicator color={C.brand} />
              ) : opciones.length > 0 ? (
                <View style={{ gap: 4 }}>
                  {[...opciones, { userId: RELEVO_OTRO, nombre: "Otro guarda (escribir nombre)" }].map(
                    (g) => (
                      <Tap
                        key={g.userId}
                        onPress={() => setRelevo(g.userId)}
                        style={[styles.chip, relevo === g.userId && styles.chipActive]}
                      >
                        <Text
                          style={[
                            styles.chipText,
                            relevo === g.userId && styles.chipTextActive,
                          ]}
                        >
                          {g.nombre}
                        </Text>
                      </Tap>
                    ),
                  )}
                </View>
              ) : (
                <Text style={styles.hintRequired}>
                  No hay otros guardas registrados en esta portería: escribe el nombre
                  del relevo.
                </Text>
              )}
              {manual ? (
                <TextInput
                  style={styles.input}
                  value={relevoManual}
                  onChangeText={setRelevoManual}
                  placeholder="Nombre del relevo"
                  placeholderTextColor={AuthUI.textMuted}
                  autoCapitalize="words"
                  autoCorrect={false}
                />
              ) : null}
              <FieldError mensaje={mostrar("recibe")} />
            </Field>
          ) : null}

          {pide.consignas ? (
            <Field label="Consignas / pendientes para el relevo *">
              <TextInput
                style={[styles.input, styles.inputMultiline]}
                value={consignas}
                onChangeText={setConsignas}
                multiline
                placeholder="Ej. Paquetes en portería, llaves pendientes…"
                placeholderTextColor={AuthUI.textMuted}
              />
              <FieldError mensaje={mostrar("consignas")} />
            </Field>
          ) : null}
          {pide.observacionesCierre ? (
            <Field label="Observaciones generales del cierre *">
              <TextInput
                style={[styles.input, styles.inputMultiline]}
                value={obs}
                onChangeText={setObs}
                multiline
                placeholder="Ej. Turno finalizado sin novedades adicionales. Se entrega puesto, documentación y elementos al relevo."
                placeholderTextColor={AuthUI.textMuted}
              />
              <FieldError mensaje={mostrar("observacionesCierre")} />
            </Field>
          ) : null}
          <Tap
            onPress={confirmar}
            disabled={busy}
            style={[styles.closeBtn, { marginTop: 4 }, busy && { opacity: 0.6 }]}
          >
            <Ionicons name="stop-circle-outline" size={18} color="#fff" />
            <Text style={styles.closeBtnText}>{busy ? "Cerrando…" : "Cerrar turno"}</Text>
          </Tap>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
    </View>
  );
}

export function FieldError({ mensaje }: { mensaje?: string }) {
  if (!mensaje) return null;
  return <Text style={styles.fieldError}>{mensaje}</Text>;
}

const styles = StyleSheet.create({
  stats: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 12 },
  statCard: { width: "47%", padding: 12, alignItems: "center" },
  statValue: { fontSize: 20, fontFamily: AuthUI.font.semibold, color: AuthUI.text },
  statLabel: { fontSize: 11, color: AuthUI.textMuted, marginTop: 2 },
  closeBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: "#DC2626",
    marginBottom: 20,
  },
  closeBtnText: { color: "#fff", fontFamily: AuthUI.font.semibold, fontSize: 14 },
  modalHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.border,
  },
  modalTitle: {
    flexShrink: 1,
    fontSize: 16,
    fontFamily: AuthUI.font.semibold,
    color: AuthUI.text,
  },
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
    letterSpacing: 0,
    fontFamily: AuthUI.font.regular,
    color: AuthUI.text,
    backgroundColor: "#fff",
  },
  inputMultiline: {
    minHeight: 90,
    textAlignVertical: "top",
  },
  hintRequired: {
    fontSize: 12,
    color: AuthUI.textMuted,
    lineHeight: 17,
    marginTop: 4,
  },
  fieldError: { fontSize: 12, color: "#DC2626", lineHeight: 17 },
  elementos: { paddingHorizontal: 12, paddingVertical: 4 },
  elementoRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 8,
  },
  elementoDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.border,
  },
  elementoNombre: { fontSize: 14, color: AuthUI.text },
  elementoNovedad: { fontSize: 12, color: "#B45309", marginTop: 2 },
  elementoCantidad: { fontSize: 13, color: AuthUI.textMuted },
  novedadesRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: C.bgSubtle,
    marginBottom: 4,
  },
  chipActive: { backgroundColor: C.brand },
  chipText: { fontSize: 14, color: AuthUI.text },
  chipTextActive: { color: "#fff" },
});
