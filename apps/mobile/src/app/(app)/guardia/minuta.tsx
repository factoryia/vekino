import { useEffect, useMemo, useState } from "react";
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
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { useMutation, useQuery, useAction, Authenticated } from "convex/react";
import { api } from "@vekino/backend/api";
import type { Doc, Id } from "@vekino/backend/dataModel";
import { erroresCierreTurno } from "@vekino/backend/cierreTurno";
import { useCondominio } from "@/context/condominio-context";
import { ScreenBackground, GlassCard, GlassBadge } from "@/components/ui/glass";
import { Tap } from "@/components/ui/tap";
import { AuthUI } from "@/lib/auth-ui";
import { C } from "@/lib/theme";
import { uploadLocalFile } from "@/lib/guardia-upload";

type ChecklistRow = {
  item: string;
  obligatorio: boolean;
  cantidadEsperada: number;
  cantidadEncontrada: number;
  estadoOk: boolean;
  observacion: string;
};

type Modulo = Doc<"minutaEventos">["modulo"];

const MODULO_LABEL: Record<Modulo, string> = {
  visitantes: "Visitantes",
  paqueteria: "Paquetería",
  reservas: "Reservas",
  novedades: "Novedades",
  minuta: "Minuta",
};

const DEFAULT_CHECKLIST: ChecklistRow[] = [
  {
    item: "Radio de comunicación",
    obligatorio: true,
    cantidadEsperada: 1,
    cantidadEncontrada: 1,
    estadoOk: true,
    observacion: "",
  },
  {
    item: "Linterna",
    obligatorio: true,
    cantidadEsperada: 1,
    cantidadEncontrada: 1,
    estadoOk: true,
    observacion: "",
  },
  {
    item: "Llaves de portería",
    obligatorio: true,
    cantidadEsperada: 1,
    cantidadEncontrada: 1,
    estadoOk: true,
    observacion: "",
  },
];

function fmtFechaHora(ts: number) {
  const d = new Date(ts);
  const hoy = new Date().toDateString() === d.toDateString();
  const hora = d.toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" });
  if (hoy) return `Hoy ${hora}`;
  return (
    d.toLocaleDateString("es-CO", { day: "numeric", month: "short" }) + ` ${hora}`
  );
}

export default function GuardiaMinutaScreen() {
  return (
    <Authenticated>
      <Inner />
    </Authenticated>
  );
}

function Inner() {
  const router = useRouter();
  const { condominioId, isGuardia, canManage, isLoading } = useCondominio();

  const turno = useQuery(
    api.guardia.turnoActivo,
    condominioId ? { condominioId } : "skip",
  );
  const minuta = useQuery(
    api.guardia.listMinuta,
    condominioId ? { condominioId, limit: 100 } : "skip",
  );

  const [modal, setModal] = useState<"iniciar" | "cerrar" | "ronda" | "nota" | null>(
    null,
  );

  const eventosTurno = useMemo(
    () => (minuta ?? []).filter((e) => turno && e.turnoId === turno._id),
    [minuta, turno],
  );
  const stats = useMemo(
    () => ({
      visitantes: eventosTurno.filter(
        (e) => e.modulo === "visitantes" && e.tipo === "Ingreso",
      ).length,
      paquetes: eventosTurno.filter((e) => e.modulo === "paqueteria").length,
      incidentes: eventosTurno.filter((e) => e.modulo === "novedades").length,
      rondas: turno?.rondasCount ?? 0,
    }),
    [eventosTurno, turno],
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

  return (
    <View style={{ flex: 1 }}>
      <ScreenBackground>
        <SafeAreaView style={{ flex: 1 }} edges={["top"]}>
          <View style={styles.header}>
            <Tap onPress={() => router.back()} style={styles.backBtn}>
              <Ionicons name="chevron-back" size={22} color={AuthUI.text} />
            </Tap>
            <Text style={styles.title}>Minuta</Text>
            <View style={{ width: 40 }} />
          </View>

          <ScrollView
            contentContainerStyle={styles.scroll}
            showsVerticalScrollIndicator={false}
          >
            <Text style={styles.subtitle}>
              Control de turno y bitácora de portería
            </Text>

            {turno === undefined ? (
              <ActivityIndicator color={C.brand} />
            ) : turno === null ? (
              <GlassCard style={styles.noTurno}>
                <Ionicons name="play-circle-outline" size={40} color={C.brand} />
                <Text style={styles.noTurnoTitle}>No hay turno abierto</Text>
                <Text style={styles.noTurnoHint}>
                  Inicia tu turno con el checklist de dotación para habilitar la
                  minuta, las rondas y el control.
                </Text>
                <Tap
                  onPress={() => setModal("iniciar")}
                  style={styles.primaryBtn}
                >
                  <Text style={styles.primaryBtnText}>Iniciar turno</Text>
                </Tap>
              </GlassCard>
            ) : (
              <>
                <GlassCard style={styles.turnoCard}>
                  <View style={styles.liveRow}>
                    <View style={styles.liveDot} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.turnoName}>
                        Turno de {turno.guardiaNombre}
                        {turno.guardiaSecundarioNombre
                          ? ` · con ${turno.guardiaSecundarioNombre}`
                          : ""}
                      </Text>
                      <Text style={styles.turnoMeta}>
                        Inició {fmtFechaHora(turno.fechaInicio)} · Checklist{" "}
                        {turno.checklist.length} ítems
                      </Text>
                    </View>
                  </View>
                </GlassCard>

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

                <View style={styles.actionRow}>
                  <Tap
                    onPress={() => setModal("nota")}
                    style={[styles.actionChip, { flex: 1 }]}
                  >
                    <Ionicons name="create-outline" size={18} color={AuthUI.text} />
                    <Text style={styles.actionChipText}>Anotación</Text>
                  </Tap>
                  <Tap
                    onPress={() => setModal("ronda")}
                    style={[styles.actionChip, { flex: 1 }]}
                  >
                    <Ionicons name="walk-outline" size={18} color={AuthUI.text} />
                    <Text style={styles.actionChipText}>Ronda</Text>
                  </Tap>
                </View>
                <Tap
                  onPress={() => setModal("cerrar")}
                  style={styles.closeBtn}
                >
                  <Ionicons name="stop-circle-outline" size={18} color="#fff" />
                  <Text style={styles.closeBtnText}>Cerrar turno</Text>
                </Tap>
              </>
            )}

            <Text style={styles.sectionTitle}>Bitácora</Text>
            {turno === null ? (
              <GlassCard style={styles.locked}>
                <Ionicons name="lock-closed-outline" size={18} color={AuthUI.textMuted} />
                <Text style={styles.lockedText}>
                  La minuta se habilita al iniciar turno.
                </Text>
              </GlassCard>
            ) : minuta === undefined ? (
              <ActivityIndicator color={C.brand} />
            ) : (minuta ?? []).length === 0 ? (
              <GlassCard style={styles.empty}>
                <Text style={styles.emptyTitle}>Sin eventos aún</Text>
              </GlassCard>
            ) : (
              <View style={{ gap: 8 }}>
                {(minuta ?? []).map((e) => (
                  <GlassCard key={e._id} style={styles.eventCard}>
                    <View style={styles.eventHead}>
                      <GlassBadge
                        label={MODULO_LABEL[e.modulo] ?? e.modulo}
                        tone="neutral"
                      />
                      <Text style={styles.eventTime}>{fmtFechaHora(e.createdAt)}</Text>
                    </View>
                    <Text style={styles.eventTipo}>{e.tipo}</Text>
                    <Text style={styles.eventResumen}>{e.resumen}</Text>
                    <Text style={styles.eventMeta}>
                      {e.unidad} · {e.actorNombre}
                    </Text>
                  </GlassCard>
                ))}
              </View>
            )}
          </ScrollView>
        </SafeAreaView>
      </ScreenBackground>

      {modal === "iniciar" && condominioId ? (
        <IniciarTurnoModal
          condominioId={condominioId}
          onClose={() => setModal(null)}
        />
      ) : null}
      {modal === "cerrar" && turno ? (
        <CerrarTurnoModal
          turno={turno}
          stats={stats}
          onClose={() => setModal(null)}
        />
      ) : null}
      {modal === "ronda" && condominioId ? (
        <RondaModal condominioId={condominioId} onClose={() => setModal(null)} />
      ) : null}
      {modal === "nota" && condominioId ? (
        <NotaModal condominioId={condominioId} onClose={() => setModal(null)} />
      ) : null}
    </View>
  );
}

function IniciarTurnoModal({
  condominioId,
  onClose,
}: {
  condominioId: Id<"condominios">;
  onClose: () => void;
}) {
  const template = useQuery(api.guardia.listChecklistTemplate, { condominioId });
  const iniciar = useMutation(api.guardia.iniciarTurno);

  const [rows, setRows] = useState<ChecklistRow[] | null>(null);
  const [quienTurno, setQuienTurno] = useState("");
  const [companero, setCompanero] = useState("");
  const [observaciones, setObservaciones] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (rows !== null || template === undefined) return;
    const activos = template.filter((t) => t.activo);
    setRows(
      activos.length > 0
        ? activos.map((t) => ({
            item: t.nombre,
            obligatorio: t.obligatorio,
            cantidadEsperada: t.cantidadEsperada,
            cantidadEncontrada: t.cantidadEsperada,
            estadoOk: true,
            observacion: "",
          }))
        : DEFAULT_CHECKLIST.map((r) => ({ ...r })),
    );
  }, [rows, template]);

  function setRow(i: number, patch: Partial<ChecklistRow>) {
    setRows((prev) => (prev ?? []).map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  async function confirmar() {
    if (!rows || rows.length === 0) return;
    if (!quienTurno.trim()) {
      Alert.alert("Nombre requerido", "Escribe el nombre de quien toma el turno.");
      return;
    }
    setBusy(true);
    try {
      await iniciar({
        condominioId,
        checklist: rows
          .filter((r) => r.item.trim())
          .map((r) => ({
            item: r.item,
            obligatorio: r.obligatorio,
            cantidadEsperada: r.cantidadEsperada,
            cantidadEncontrada: r.cantidadEncontrada,
            estadoOk: r.estadoOk,
            observacion: r.observacion || undefined,
          })),
        observacionesInicio: observaciones || undefined,
        guardiaNombre: quienTurno.trim(),
        guardiaSecundarioNombre: companero.trim() || undefined,
      });
      onClose();
    } catch (e) {
      Alert.alert("Error", e instanceof Error ? e.message : "No se pudo iniciar.");
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
          <Text style={styles.modalTitle}>Iniciar turno</Text>
          <Tap
            onPress={confirmar}
            disabled={busy || !rows?.length || !quienTurno.trim()}
          >
            <Text style={[styles.save, busy && { opacity: 0.5 }]}>
              {busy ? "…" : "Iniciar"}
            </Text>
          </Tap>
        </View>
        <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
          <View style={{ gap: 6 }}>
            <Text style={styles.fieldLabel}>Quién toma el turno</Text>
            <TextInput
              style={styles.input}
              value={quienTurno}
              onChangeText={setQuienTurno}
              placeholder="Tu nombre completo"
              placeholderTextColor={AuthUI.textMuted}
              autoFocus
            />
            <Text style={{ fontSize: 11, color: AuthUI.textMuted }}>
              Cuenta compartida: escribe tu nombre para la minuta.
            </Text>
          </View>

          <View style={{ gap: 6 }}>
            <Text style={styles.fieldLabel}>Compañero de turno (opcional)</Text>
            <TextInput
              style={styles.input}
              value={companero}
              onChangeText={setCompanero}
              placeholder="Nombre del segundo guardia"
              placeholderTextColor={AuthUI.textMuted}
            />
          </View>

          <Text style={styles.fieldLabel}>Checklist de dotación</Text>
          {rows === null ? (
            <ActivityIndicator color={C.brand} />
          ) : (
            rows.map((r, i) => (
              <GlassCard key={i} style={styles.checkRow}>
                <View style={styles.checkTop}>
                  <Switch
                    value={r.estadoOk}
                    onValueChange={(v) => setRow(i, { estadoOk: v })}
                    trackColor={{ true: "#22C55E", false: "#F87171" }}
                  />
                  <TextInput
                    style={[styles.input, { flex: 1 }]}
                    value={r.item}
                    onChangeText={(t) => setRow(i, { item: t })}
                  />
                </View>
                {!r.estadoOk ? (
                  <TextInput
                    style={styles.input}
                    value={r.observacion}
                    onChangeText={(t) => setRow(i, { observacion: t })}
                    placeholder="¿Qué novedad tiene este ítem?"
                    placeholderTextColor={AuthUI.textMuted}
                  />
                ) : null}
              </GlassCard>
            ))
          )}

          <View style={{ gap: 6 }}>
            <Text style={styles.fieldLabel}>Observaciones iniciales</Text>
            <TextInput
              style={[styles.input, { minHeight: 70, textAlignVertical: "top" }]}
              value={observaciones}
              onChangeText={setObservaciones}
              multiline
              placeholder="Cómo recibes la portería…"
              placeholderTextColor={AuthUI.textMuted}
            />
          </View>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

/** Chip del selector de relevo para escribir el nombre a mano. */
const RELEVO_OTRO = "__otro__";

function CerrarTurnoModal({
  turno,
  stats,
  onClose,
}: {
  turno: Doc<"guardiaTurnos"> & { rondasCount: number };
  stats: { visitantes: number; paquetes: number; incidentes: number; rondas: number };
  onClose: () => void;
}) {
  const cerrar = useMutation(api.guardia.cerrarTurno);
  const equipo = useQuery(api.guardia.equipo, { condominioId: turno.condominioId });
  const [hayNovedades, setHayNovedades] = useState(false);
  const [detalleNovedades, setDetalleNovedades] = useState("");
  /* userId del relevo elegido, RELEVO_OTRO para escribirlo, o null. */
  const [relevo, setRelevo] = useState<string | null>(null);
  const [relevoManual, setRelevoManual] = useState("");
  const [consignas, setConsignas] = useState("");
  const [obs, setObs] = useState("");
  const [intentado, setIntentado] = useState(false);
  const [busy, setBusy] = useState(false);

  /* Quien entrega no se ofrece como relevo: ni el que abrió ni su compañero. */
  const opciones = (equipo ?? []).filter(
    (g) =>
      g.userId !== turno.guardiaUserId && g.userId !== turno.guardiaSecundarioUserId,
  );
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
    novedadesElementos: hayNovedades,
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
        ...(manual
          ? { recibe: relevoManual.trim() }
          : { recibeUserId: relevo as Id<"users"> }),
        consignas: consignas.trim(),
        observacionesCierre: obs.trim() || undefined,
        novedadesElementos: hayNovedades,
        novedadesElementosDetalle: hayNovedades ? detalleNovedades.trim() : undefined,
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
          <Text style={styles.modalTitle}>Cerrar turno</Text>
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
          <Field label="Entrega el turno">
            <TextInput
              style={[styles.input, { opacity: 0.7 }]}
              value={turno.guardiaNombre}
              editable={false}
            />
          </Field>

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
          <Field label="Observaciones generales del cierre (opcional)">
            <TextInput
              style={[styles.input, styles.inputMultiline]}
              value={obs}
              onChangeText={setObs}
              multiline
              placeholder="Si no hay nada que agregar, déjalo vacío."
              placeholderTextColor={AuthUI.textMuted}
            />
          </Field>
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

function RondaModal({
  condominioId,
  onClose,
}: {
  condominioId: Id<"condominios">;
  onClose: () => void;
}) {
  const zonas = useQuery(api.guardia.listRondaZonas, { condominioId });
  const registrar = useMutation(api.guardia.registrarRonda);
  const generateUploadUrl = useAction(api.files.generateUploadUrl);

  const [zonaId, setZonaId] = useState<Id<"guardiaRondaZonas"> | null>(null);
  const [zonaLibre, setZonaLibre] = useState("");
  const [novedad, setNovedad] = useState("");
  const [fotos, setFotos] = useState<{ uri: string; mime: string }[]>([]);
  const [busy, setBusy] = useState(false);

  const activas = (zonas ?? []).filter((z) => z.activa);

  async function pickFotos() {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("Permiso necesario", "Activa el acceso a fotos.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 0.75,
      allowsMultipleSelection: true,
      selectionLimit: 5 - fotos.length,
    });
    if (result.canceled || !result.assets?.length) return;
    setFotos((prev) => [
      ...prev,
      ...result.assets.map((a) => ({
        uri: a.uri,
        mime: a.mimeType ?? "image/jpeg",
      })),
    ].slice(0, 5));
  }

  async function confirmar() {
    if (!zonaId && !zonaLibre.trim()) {
      Alert.alert("Zona requerida", "Selecciona o escribe la zona de la ronda.");
      return;
    }
    setBusy(true);
    try {
      const fotoUrls: string[] = [];
      for (const f of fotos) {
        const { url } = await uploadLocalFile(
          generateUploadUrl,
          f.uri,
          f.mime,
          `condominios/guardia/${condominioId}/rondas`,
        );
        fotoUrls.push(url);
      }
      await registrar({
        condominioId,
        zonaId: zonaId ?? undefined,
        zonaNombre: zonaId ? undefined : zonaLibre.trim(),
        novedad: novedad || undefined,
        fotos: fotoUrls,
      });
      onClose();
    } catch (e) {
      Alert.alert("Error", e instanceof Error ? e.message : "No se pudo registrar.");
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
          <Text style={styles.modalTitle}>Ronda</Text>
          <Tap onPress={confirmar} disabled={busy}>
            <Text style={[styles.save, busy && { opacity: 0.5 }]}>
              {busy ? "…" : "Registrar"}
            </Text>
          </Tap>
        </View>
        <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
          <Text style={styles.fieldLabel}>Zona</Text>
          {activas.map((z) => (
            <Tap
              key={z._id}
              onPress={() => {
                setZonaId(z._id);
                setZonaLibre("");
              }}
              style={[styles.chip, zonaId === z._id && styles.chipActive]}
            >
              <Text
                style={[styles.chipText, zonaId === z._id && styles.chipTextActive]}
              >
                {z.nombre}
              </Text>
            </Tap>
          ))}
          <TextInput
            style={styles.input}
            value={zonaLibre}
            onChangeText={(t) => {
              setZonaLibre(t);
              setZonaId(null);
            }}
            placeholder="O escribe una zona…"
            placeholderTextColor={AuthUI.textMuted}
          />
          <Field label="Novedad (opcional)">
            <TextInput
              style={[styles.input, { minHeight: 70, textAlignVertical: "top" }]}
              value={novedad}
              onChangeText={setNovedad}
              multiline
              placeholder="Sin novedad / detalle…"
              placeholderTextColor={AuthUI.textMuted}
            />
          </Field>
          <Tap onPress={pickFotos}>
            <GlassCard style={styles.fotoBtn}>
              <Ionicons name="camera-outline" size={20} color={AuthUI.text} />
              <Text style={styles.fotoLabel}>
                Fotos ({fotos.length}/5)
              </Text>
            </GlassCard>
          </Tap>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

function NotaModal({
  condominioId,
  onClose,
}: {
  condominioId: Id<"condominios">;
  onClose: () => void;
}) {
  const registrar = useMutation(api.guardia.registrarEventoMinuta);
  const [tipo, setTipo] = useState("Anotación");
  const [unidad, setUnidad] = useState("");
  const [resumen, setResumen] = useState("");
  const [busy, setBusy] = useState(false);

  async function confirmar() {
    if (!resumen.trim()) {
      Alert.alert("Detalle requerido", "Escribe la anotación.");
      return;
    }
    setBusy(true);
    try {
      await registrar({
        condominioId,
        tipo: tipo.trim() || "Anotación",
        unidad: unidad.trim() || undefined,
        resumen: resumen.trim(),
      });
      onClose();
    } catch (e) {
      Alert.alert("Error", e instanceof Error ? e.message : "No se pudo guardar.");
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
          <Text style={styles.modalTitle}>Anotación</Text>
          <Tap onPress={confirmar} disabled={busy}>
            <Text style={[styles.save, busy && { opacity: 0.5 }]}>
              {busy ? "…" : "Guardar"}
            </Text>
          </Tap>
        </View>
        <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
          <Field label="Tipo">
            <TextInput
              style={styles.input}
              value={tipo}
              onChangeText={setTipo}
              placeholder="Anotación"
              placeholderTextColor={AuthUI.textMuted}
            />
          </Field>
          <Field label="Unidad / zona">
            <TextInput
              style={styles.input}
              value={unidad}
              onChangeText={setUnidad}
              placeholder="Opcional"
              placeholderTextColor={AuthUI.textMuted}
            />
          </Field>
          <Field label="Detalle *">
            <TextInput
              style={[styles.input, { minHeight: 100, textAlignVertical: "top" }]}
              value={resumen}
              onChangeText={setResumen}
              multiline
              placeholder="Qué ocurrió…"
              placeholderTextColor={AuthUI.textMuted}
            />
          </Field>
        </ScrollView>
      </SafeAreaView>
    </Modal>
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

function FieldError({ mensaje }: { mensaje?: string }) {
  if (!mensaje) return null;
  return <Text style={styles.fieldError}>{mensaje}</Text>;
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
  scroll: { paddingHorizontal: 16, paddingBottom: 40 },
  subtitle: { fontSize: 13, color: AuthUI.textMuted, marginBottom: 14 },
  noTurno: { padding: 24, alignItems: "center", gap: 10 },
  noTurnoTitle: { fontSize: 17, fontFamily: AuthUI.font.semibold, color: AuthUI.text },
  noTurnoHint: { fontSize: 13, color: AuthUI.textMuted, textAlign: "center", lineHeight: 18 },
  primaryBtn: {
    marginTop: 8,
    backgroundColor: C.brand,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 20,
  },
  primaryBtnText: { color: "#fff", fontFamily: AuthUI.font.semibold, fontSize: 15 },
  turnoCard: { padding: 14, marginBottom: 12 },
  liveRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  liveDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: "#22C55E",
  },
  turnoName: { fontSize: 15, fontFamily: AuthUI.font.semibold, color: AuthUI.text },
  turnoMeta: { fontSize: 12, color: AuthUI.textMuted, marginTop: 2 },
  stats: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 12 },
  statCard: { width: "47%", padding: 12, alignItems: "center" },
  statValue: { fontSize: 20, fontFamily: AuthUI.font.semibold, color: AuthUI.text },
  statLabel: { fontSize: 11, color: AuthUI.textMuted, marginTop: 2 },
  actionRow: { flexDirection: "row", gap: 8, marginBottom: 8 },
  actionChip: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: C.border,
  },
  actionChipText: { fontSize: 14, fontFamily: AuthUI.font.medium, color: AuthUI.text },
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
  sectionTitle: {
    fontSize: 13,
    fontFamily: AuthUI.font.semibold,
    color: AuthUI.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.4,
    marginBottom: 10,
  },
  locked: {
    padding: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  lockedText: { flex: 1, fontSize: 13, color: AuthUI.textMuted },
  empty: { padding: 20, alignItems: "center" },
  emptyTitle: { fontSize: 14, color: AuthUI.textMuted },
  eventCard: { padding: 12, gap: 4 },
  eventHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  eventTime: { fontSize: 11, color: AuthUI.textMuted },
  eventTipo: { fontSize: 14, fontFamily: AuthUI.font.semibold, color: AuthUI.text },
  eventResumen: { fontSize: 13, color: AuthUI.text, lineHeight: 18 },
  eventMeta: { fontSize: 11, color: AuthUI.textMuted },
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
  checkRow: { padding: 10, gap: 8 },
  checkTop: { flexDirection: "row", alignItems: "center", gap: 8 },
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
  fotoBtn: { padding: 14, flexDirection: "row", alignItems: "center", gap: 10 },
  fotoLabel: { fontSize: 14, color: AuthUI.text },
});
