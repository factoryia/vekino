import { useEffect, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  ActivityIndicator,
  Pressable,
  TextInput,
  Linking,
  Alert,
  Image,
  StyleSheet,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useQuery, useMutation, useAction, Authenticated } from "convex/react";
import * as ImagePicker from "expo-image-picker";
import { api } from "@vekino/backend/api";
import type { Id } from "@vekino/backend/dataModel";
import {
  mensajePagoEnVerificacion,
  montoAPagarHoy,
  vencimientoDePeriodo,
  type CarteraUnidad,
} from "@vekino/backend/cartera";
import { getDocumentPicker } from "@/lib/document-picker";
import { openDocument } from "@/lib/open-document";
import { useCondominio } from "@/context/condominio-context";
import { NoCondominioScreen } from "@/components/ui/no-condominio";
import { SoftHomeHeader } from "@/components/ui/soft-home-header";
import { BottomSheet } from "@/components/ui/bottom-sheet";
import { Tap } from "@/components/ui/tap";
import {
  ScreenBackground,
  GlassCard,
  GlassBadge,
  GlassButton,
  GlassSection,
} from "@/components/ui/glass";
import { cop, fmtPeriodo } from "@/lib/utils";
import {
  ETIQUETA_SIN_VERIFICAR,
  TEXTO_SIN_VERIFICAR,
  descuentoDe,
  estadoVisible,
  montoDeFila,
  plazosDe,
  tarjetaFacturas,
} from "@/lib/resumen-facturas";
import { AuthUI } from "@/lib/auth-ui";
import { SoftUI, softShadow } from "@/lib/soft-ui";

type Estado = "pendiente" | "pagada" | "vencida" | "abonada" | "saldo_a_favor";
/**
 * Lo que se muestra: el estado guardado, o "en revisión" si la lectura no se
 * ha verificado, "pago en verificación" (Fase 3) o "sin verificar" (Fase 4:
 * histórica que quedó pendiente; falta el estado de cuenta siguiente).
 */
type EstadoVisible = Estado | "en_revision" | "en_verificacion" | "sin_verificar";

const ESTADO_TONE: Record<EstadoVisible, "yellow" | "green" | "red" | "neutral" | "blue"> = {
  pendiente: "yellow",
  pagada: "green",
  vencida: "red",
  abonada: "blue",
  saldo_a_favor: "blue",
  en_revision: "blue",
  en_verificacion: "blue",
  sin_verificar: "neutral",
};

const ESTADO_LABEL: Record<EstadoVisible, string> = {
  pendiente: "Pendiente",
  pagada: "Pagada",
  vencida: "Vencida",
  abonada: "Abonada",
  saldo_a_favor: "Saldo a favor",
  en_revision: "En revisión",
  /* Fase 3: pagó y la contabilidad aún no lo refleja. */
  en_verificacion: "Pago en verificación",
  /* Fase 4: histórica que nadie pudo juzgar. */
  sin_verificar: ETIQUETA_SIN_VERIFICAR,
};

const ESTADO_ICON: Record<
  string,
  { name: React.ComponentProps<typeof Ionicons>["name"]; bg: string; fg: string }
> = {
  pendiente: { name: "time-outline", bg: SoftUI.warningSoft, fg: "#B8860B" },
  pagada: {
    name: "checkmark-circle-outline",
    bg: SoftUI.successSoft,
    fg: SoftUI.success,
  },
  vencida: {
    name: "alert-circle-outline",
    bg: SoftUI.dangerSoft,
    fg: SoftUI.danger,
  },
  abonada: { name: "wallet-outline", bg: SoftUI.infoSoft, fg: SoftUI.blue },
  saldo_a_favor: {
    name: "trending-up-outline",
    bg: SoftUI.infoSoft,
    fg: SoftUI.blue,
  },
  en_revision: { name: "search-outline", bg: SoftUI.infoSoft, fg: SoftUI.blue },
  en_verificacion: { name: "hourglass-outline", bg: SoftUI.infoSoft, fg: SoftUI.blue },
  sin_verificar: { name: "help-circle-outline", bg: SoftUI.bgSecondary, fg: SoftUI.textSecondary },
};

type FacturaRow = {
  _id: Id<"facturas">;
  /** La unidad (lista del residente): sirve para saber si es histórica. */
  unidadId?: string;
  /** El estado que se muestra, si ya lo calculó el backend (lista de la administración). */
  estadoVisible?: string;
  periodo: string;
  periodoLabel: string;
  residenteNombre: string;
  apto?: string;
  totalAPagar: number;
  totalConDescuento?: number;
  /** Hasta cuándo vale el descuento, según el documento (Fase 3). */
  fechaLimiteDescuento?: number;
  vrAdmon: number;
  estado: string;
  fechaEmision: number;
  fechaVencimiento: number;
  pdfUrl?: string | null;
  lineas: {
    codigo: number;
    concepto: string;
    saldoAnterior: number;
    actual: number;
    total: number;
  }[];
  lecturaDudosa?: { motivos: string[]; confirmada?: unknown };
  /** Un pago registrado que la contabilidad aún no refleja (Fase 3). */
  pagoEnVerificacion?: { monto: number } | null;
  /** Lo que prueban los pagos aprobados (Fase 3): un abono baja lo que falta. */
  estadoPago?: { estado: "pagada" | "abonada"; montoPagado: number } | null;
};

export default function FacturasScreen() {
  return (
    <View style={{ flex: 1 }}>
      <ScreenBackground>
        <Authenticated>
          <FacturasContent />
        </Authenticated>
      </ScreenBackground>
    </View>
  );
}

function FacturasContent() {
  const { condominioId, isSuperadmin, canManage } = useCondominio();

  if (isSuperadmin && !condominioId) return <NoCondominioScreen />;
  if (canManage && condominioId) {
    return <AdminFacturasView condominioId={condominioId} />;
  }
  return <ResidentFacturasView condominioId={condominioId} />;
}

/* ── Selector de período Soft UI ─────────────────── */
function PeriodoSelect({
  periodos,
  value,
  onChange,
}: {
  periodos: string[];
  value: string;
  onChange: (p: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { theme } = useCondominio();
  return (
    <>
      <Pressable onPress={() => setOpen(true)} style={styles.periodoBtn}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: SoftUI.space.sm }}>
          <View style={[styles.periodoIcon, { backgroundColor: theme.accentSoft }]}>
            <Ionicons name="calendar-outline" size={18} color={theme.accent} />
          </View>
          <Text style={styles.periodoLabel}>
            {value ? fmtPeriodo(value) : "Selecciona período"}
          </Text>
        </View>
        <Ionicons name="chevron-down" size={18} color={SoftUI.textSecondary} />
      </Pressable>

      <BottomSheet visible={open} onClose={() => setOpen(false)} maxHeight="70%">
        <ScrollView contentContainerStyle={{ padding: SoftUI.space.lg, paddingBottom: 40 }}>
          <Text style={styles.sheetTitle}>Período</Text>
          {periodos.map((p) => {
            const active = p === value;
            return (
              <Pressable
                key={p}
                onPress={() => {
                  onChange(p);
                  setOpen(false);
                }}
                style={[
                  styles.sheetRow,
                  active && { backgroundColor: theme.accentSoft },
                ]}
              >
                <Text
                  style={[
                    styles.sheetRowText,
                    active && { fontFamily: AuthUI.font.semibold, color: theme.accent },
                  ]}
                >
                  {fmtPeriodo(p)}
                </Text>
                {active && <Ionicons name="checkmark" size={18} color={theme.accent} />}
              </Pressable>
            );
          })}
        </ScrollView>
      </BottomSheet>
    </>
  );
}

function FacturaListCard({
  f,
  cadena,
  cartera,
  onPress,
  showResident,
}: {
  f: FacturaRow;
  /** Las facturas de la misma unidad (Fase 4: "sin verificar"). */
  cadena?: FacturaRow[];
  /** La cartera de hoy de su unidad: la vigente en mora se ve "vencida" (H2). */
  cartera?: CarteraUnidad | null;
  onPress: () => void;
  showResident?: boolean;
}) {
  const { theme } = useCondominio();
  const estado = estadoVisible(f, cadena, cartera);
  const iconMeta = ESTADO_ICON[estado] ?? ESTADO_ICON.abonada;
  /* El descuento vale hasta SU fecha (la del documento, o el 15 del mes del
   * período), no hasta el vencimiento (Fase 3, F-06). */
  const descuento = descuentoDe(f, Date.now());
  return (
    <Tap onPress={onPress}>
      <GlassCard style={styles.facturaCard}>
        <View style={[styles.facturaIcon, { backgroundColor: iconMeta.bg }]}>
          <Ionicons name={iconMeta.name} size={22} color={iconMeta.fg} />
        </View>
        <View style={styles.facturaBody}>
          <Text style={styles.facturaTitle} numberOfLines={1}>
            {showResident ? f.residenteNombre : fmtPeriodo(f.periodo)}
          </Text>
          <Text style={styles.facturaMeta} numberOfLines={1}>
            {showResident
              ? f.apto
                ? `Apto ${f.apto}`
                : "Sin apto"
              : f.apto
                ? `Apto ${f.apto}`
                : f.residenteNombre}
          </Text>
          <View style={{ marginTop: 6, flexDirection: "row", alignItems: "center", gap: 8 }}>
            <GlassBadge
              label={ESTADO_LABEL[estado as EstadoVisible] ?? estado}
              tone={ESTADO_TONE[estado as EstadoVisible] ?? "neutral"}
            />
            {!showResident && estado !== "sin_verificar" && (
              <Text style={styles.facturaDue}>
                {/* Fase 4: el fin de mes es el plazo del precio completo. */}
                Precio completo hasta el{" "}
                {new Date(f.fechaVencimiento).toLocaleDateString("es-CO", {
                  day: "numeric",
                  month: "short",
                  timeZone: "America/Bogota",
                })}
              </Text>
            )}
          </View>
          {estado === "sin_verificar" ? (
            <Text style={styles.facturaDue}>{TEXTO_SIN_VERIFICAR}</Text>
          ) : null}
          {!showResident && descuento?.vigente && estado === "pendiente" ? (
            <View style={styles.descuentoRow}>
              <Ionicons name="pricetag" size={12} color={SoftUI.success} />
              <Text style={styles.descuentoText}>
                Con descuento hasta el{" "}
                {new Date(descuento.hasta).toLocaleDateString("es-CO", {
                  day: "numeric",
                  month: "short",
                  timeZone: "America/Bogota",
                })}
                : {cop(descuento.monto)}
              </Text>
            </View>
          ) : null}
        </View>
        <View style={styles.facturaRight}>
          {/* En la vigente con un abono aprobado, lo que falta (H1). */}
          <Text style={styles.facturaMonto}>{cop(montoDeFila(f, cadena))}</Text>
          <View style={[styles.glassAction, { backgroundColor: theme.accentSoft }]}>
            <Ionicons name="chevron-forward" size={18} color={theme.accent} />
          </View>
        </View>
      </GlassCard>
    </Tap>
  );
}

function EstadoChips({
  value,
  onChange,
}: {
  value: "" | Estado;
  onChange: (e: "" | Estado) => void;
}) {
  const { theme } = useCondominio();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{ marginBottom: SoftUI.space.base }}
      contentContainerStyle={{ gap: SoftUI.space.sm, paddingVertical: 2 }}
    >
      {(["", "pendiente", "pagada", "vencida", "saldo_a_favor"] as const).map((e) => {
        const active = value === e;
        return (
          <Pressable
            key={e}
            onPress={() => onChange(e)}
            style={[
              styles.chip,
              active && { backgroundColor: theme.accent },
            ]}
          >
            <Text style={[styles.chipText, active && styles.chipTextActive]}>
              {e === "" ? "Todas" : ESTADO_LABEL[e]}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/* ── Vista admin: todas las facturas del período ────────────── */
function AdminFacturasView({ condominioId }: { condominioId: Id<"condominios"> }) {
  const me = useQuery(api.users.me);
  const { condominioName, theme } = useCondominio();
  const periodos = useQuery(api.facturas.listPeriodos, { condominioId });
  const [selectedPeriodo, setSelectedPeriodo] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const periodo = selectedPeriodo ?? periodos?.[0] ?? "";
  const resumen = useQuery(api.facturas.resumenPeriodo, periodo ? { condominioId, periodo } : "skip");
  const facturas = useQuery(api.facturas.listByPeriodo, periodo ? { condominioId, periodo } : "skip");

  const [estadoFiltro, setEstadoFiltro] = useState<"" | Estado>("");
  const [search, setSearch] = useState("");
  const [detalle, setDetalle] = useState<FacturaRow | null>(null);

  const q = search.trim().toLowerCase();
  const filtered = ((facturas ?? []) as FacturaRow[])
    .filter((f) => !estadoFiltro || f.estado === estadoFiltro)
    .filter((f) => !q || f.residenteNombre.toLowerCase().includes(q) || (f.apto ?? "").toLowerCase().includes(q));

  const hora = new Date().getHours();
  const saludo =
    hora < 12 ? "Buenos días" : hora < 18 ? "Buenas tardes" : "Buenas noches";

  return (
    <View style={{ flex: 1 }}>
      <SoftHomeHeader
        saludo={saludo}
        displayName={me?.name ?? "Admin"}
        avatarUrl={me?.image}
        badgeLabel={condominioName ?? "Facturas"}
      />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.periodoRow}>
          {periodos && periodos.length > 0 ? (
            <View style={{ flex: 1 }}>
              <PeriodoSelect
                periodos={periodos}
                value={periodo}
                onChange={setSelectedPeriodo}
              />
            </View>
          ) : (
            <View style={{ flex: 1 }} />
          )}
          <Tap style={[styles.nuevaBtn, { backgroundColor: theme.accent }]} onPress={() => setShowForm(true)}>
            <Ionicons name="add" size={18} color={SoftUI.white} />
            <Text style={styles.nuevaBtnText}>Nueva</Text>
          </Tap>
        </View>

        {resumen && (
          <View style={styles.kpiRow}>
            {[
              { label: "Pendientes", value: resumen.pendientes, color: SoftUI.warning },
              { label: "Pagadas", value: resumen.pagadas, color: SoftUI.success },
              { label: "Vencidas", value: resumen.vencidas, color: SoftUI.danger },
            ].map((s) => (
              <GlassCard key={s.label} style={styles.kpiCard}>
                <Text style={[styles.kpiValue, { color: s.color }]}>{s.value}</Text>
                <Text style={styles.kpiLabel}>{s.label}</Text>
              </GlassCard>
            ))}
          </View>
        )}

        {resumen && (
          <GlassCard style={styles.summaryCard}>
            <View style={[styles.summaryIcon, { backgroundColor: theme.accent }]}>
              <Ionicons name="wallet-outline" size={22} color={SoftUI.white} />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={styles.summaryTitle}>{cop(resumen.sumaTotalAPagar)}</Text>
              <Text style={styles.summarySub}>
                Cartera · {resumen.total} unidad{resumen.total === 1 ? "" : "es"}
              </Text>
            </View>
          </GlassCard>
        )}

        <View style={styles.searchBox}>
          <Ionicons name="search" size={18} color={SoftUI.textSecondary} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Buscar por nombre o apto…"
            placeholderTextColor={SoftUI.textDisabled}
            style={styles.searchInput}
          />
          {search.length > 0 && (
            <Pressable onPress={() => setSearch("")} hitSlop={8}>
              <Ionicons name="close-circle" size={18} color={SoftUI.textSecondary} />
            </Pressable>
          )}
        </View>

        <EstadoChips value={estadoFiltro} onChange={setEstadoFiltro} />

        <GlassSection
          title={`${filtered.length} factura${filtered.length === 1 ? "" : "s"}`}
        >
          {facturas === undefined ? (
            <ActivityIndicator color={theme.accent} style={{ marginTop: 20 }} />
          ) : filtered.length === 0 ? (
            <GlassCard style={styles.emptyCard}>
              <Ionicons name="wallet-outline" size={32} color={SoftUI.textSecondary} />
              <Text style={styles.emptyText}>
                {q ? "Sin resultados para tu búsqueda" : "Sin facturas en esta categoría"}
              </Text>
            </GlassCard>
          ) : (
            <View style={{ gap: SoftUI.space.md }}>
              {filtered.map((f) => (
                <FacturaListCard
                  key={f._id}
                  f={f}
                  showResident
                  onPress={() => setDetalle(f)}
                />
              ))}
            </View>
          )}
        </GlassSection>
      </ScrollView>

      <FacturaDetalleModal
        detalle={detalle}
        condominioId={condominioId}
        onClose={() => setDetalle(null)}
      />
      <CrearFacturaSheet
        visible={showForm}
        onClose={() => setShowForm(false)}
        condominioId={condominioId}
        defaultPeriodo={periodo}
      />
    </View>
  );
}

/* ── Vista residente: mis propias facturas ──────────────────── */
function ResidentFacturasView({
  condominioId,
}: {
  condominioId: Id<"condominios"> | undefined;
}) {
  const me = useQuery(api.users.me);
  const { condominioName, theme } = useCondominio();
  const facturas = useQuery(
    api.facturas.listMia,
    condominioId ? { condominioId } : "skip",
  );
  const [estadoFiltro, setEstadoFiltro] = useState<"" | Estado>("");
  const [detalle, setDetalle] = useState<FacturaRow | null>(null);

  const filtered = (facturas ?? []).filter(
    (f) => !estadoFiltro || f.estado === estadoFiltro,
  ) as FacturaRow[];
  /* Las facturas de la misma unidad: dicen si una es histórica (Fase 4). */
  const cadenaDe = (f: FacturaRow) =>
    ((facturas ?? []) as FacturaRow[]).filter((x) => x.unidadId === f.unidadId);

  // Misma regla de cartera que la web y la administración (lib/resumen-facturas).
  const tarjeta = tarjetaFacturas(facturas ?? [], Date.now());

  const hora = new Date().getHours();
  const saludo =
    hora < 12 ? "Buenos días" : hora < 18 ? "Buenas tardes" : "Buenas noches";

  return (
    <View style={{ flex: 1 }}>
      <SoftHomeHeader
        saludo={saludo}
        displayName={me?.name ?? "Residente"}
        avatarUrl={me?.image}
        badgeLabel={condominioName ?? "Facturas"}
      />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        <GlassCard style={styles.summaryCard}>
          <View style={[styles.summaryIcon, { backgroundColor: theme.accent }]}>
            <Ionicons name="wallet-outline" size={22} color={SoftUI.white} />
          </View>
          <View style={{ flex: 1, gap: 2, minWidth: 0 }}>
            <Text style={styles.summaryTitle} numberOfLines={1}>
              {facturas === undefined ? "…" : tarjeta.titulo}
            </Text>
            <Text style={styles.summarySub} numberOfLines={1}>
              {tarjeta.porPagar > 0
                ? `${cop(tarjeta.porPagar)} por pagar`
                : tarjeta.alDia
                  ? "No tienes saldos pendientes"
                  : "Consulta con la administración"}
            </Text>
          </View>
        </GlassCard>

        <EstadoChips value={estadoFiltro} onChange={setEstadoFiltro} />

        <View style={{ marginTop: SoftUI.space.xs }}>
          <GlassSection
            title={`${filtered.length} factura${filtered.length === 1 ? "" : "s"}`}
          >
            {facturas === undefined ? (
              <ActivityIndicator color={theme.accent} style={{ marginTop: 20 }} />
            ) : filtered.length === 0 ? (
              <GlassCard style={styles.emptyCard}>
                <Ionicons name="wallet-outline" size={32} color={SoftUI.textSecondary} />
                <Text style={styles.emptyText}>Sin facturas en esta categoría</Text>
              </GlassCard>
            ) : (
              <View style={{ gap: SoftUI.space.md }}>
                {filtered.map((f) => (
                  <FacturaListCard
                    key={f._id}
                    f={f}
                    cadena={cadenaDe(f)}
                    cartera={tarjeta.carteras.get(String(f.unidadId))}
                    onPress={() => setDetalle(f)}
                  />
                ))}
              </View>
            )}
          </GlassSection>
        </View>
      </ScrollView>

      <FacturaDetalleModal
        detalle={detalle}
        cadena={detalle ? cadenaDe(detalle) : undefined}
        cartera={detalle ? tarjeta.carteras.get(String(detalle.unidadId)) : undefined}
        condominioId={condominioId}
        onClose={() => setDetalle(null)}
      />
    </View>
  );
}

function currentPeriodo() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * El vencimiento que se propone: el último día del mes del período (Fase 3:
 * "del 16 a 30 se paga el precio completo"), la misma regla de la carga por
 * PDF. Antes era el 15 del mes siguiente a HOY, sin importar el período.
 */
function defaultVencimientoIso(periodo: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(periodo)) return "";
  /* Medianoche de Colombia = 05:00 UTC: la fecha UTC es la misma. */
  return new Date(vencimientoDePeriodo(periodo)).toISOString().slice(0, 10);
}

type PendingAdjunto = {
  uri: string;
  mimeType: string;
  nombre: string;
};

type UnidadOption = {
  _id: Id<"unidades">;
  numero: string;
  torre: string | null;
  residentes: { name: string | null }[];
};

function unidadLabel(u: UnidadOption) {
  const apto = u.torre ? `${u.numero} ${u.torre}` : u.numero;
  const nombre = u.residentes.find((r) => r.name)?.name;
  return nombre ? `${apto} · ${nombre}` : apto;
}

function CrearFacturaSheet({
  visible,
  onClose,
  condominioId,
  defaultPeriodo,
}: {
  visible: boolean;
  onClose: () => void;
  condominioId: Id<"condominios">;
  defaultPeriodo?: string;
}) {
  const { theme } = useCondominio();
  const createManual = useMutation(api.facturas.createManual);
  const generateUploadUrl = useAction(api.files.generateUploadUrl);
  const unidades = useQuery(
    api.unidades.listDetailed,
    visible ? { condominioId } : "skip",
  );

  const [unidadId, setUnidadId] = useState<Id<"unidades"> | null>(null);
  const [unidadPicker, setUnidadPicker] = useState(false);
  const [unidadSearch, setUnidadSearch] = useState("");
  const [periodo, setPeriodo] = useState(defaultPeriodo || currentPeriodo());
  const [fechaVencimiento, setFechaVencimiento] = useState(
    defaultVencimientoIso(defaultPeriodo || currentPeriodo()),
  );
  const [valor, setValor] = useState("");
  const [saldoAFavor, setSaldoAFavor] = useState("0");
  const [totalConDescuento, setTotalConDescuento] = useState("");
  const [adjunto, setAdjunto] = useState<PendingAdjunto | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setPeriodo(defaultPeriodo || currentPeriodo());
    setFechaVencimiento(defaultVencimientoIso(defaultPeriodo || currentPeriodo()));
    setError(null);
  }, [visible, defaultPeriodo]);

  const selectedUnidad = (unidades ?? []).find((u) => u._id === unidadId) as
    | UnidadOption
    | undefined;

  const filteredUnidades = ((unidades ?? []) as UnidadOption[])
    .filter((u) => {
      const q = unidadSearch.trim().toLowerCase();
      if (!q) return true;
      const label = unidadLabel(u).toLowerCase();
      return label.includes(q) || u.numero.toLowerCase().includes(q);
    })
    .sort((a, b) => a.numero.localeCompare(b.numero, undefined, { numeric: true }));

  function reset() {
    setUnidadId(null);
    setUnidadSearch("");
    setPeriodo(defaultPeriodo || currentPeriodo());
    setFechaVencimiento(defaultVencimientoIso(defaultPeriodo || currentPeriodo()));
    setValor("");
    setSaldoAFavor("0");
    setTotalConDescuento("");
    setAdjunto(null);
    setError(null);
  }

  async function pickImage() {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("Permiso necesario", "Activa el acceso a fotos para adjuntar.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 0.85,
    });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    setAdjunto({
      uri: asset.uri,
      mimeType: asset.mimeType ?? "image/jpeg",
      nombre: asset.fileName ?? "factura.jpg",
    });
  }

  async function pickPdf() {
    const DocumentPicker = await getDocumentPicker();
    if (!DocumentPicker) return;
    const result = await DocumentPicker.getDocumentAsync({
      type: ["application/pdf"],
      copyToCacheDirectory: true,
    });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    setAdjunto({
      uri: asset.uri,
      mimeType: asset.mimeType ?? "application/pdf",
      nombre: asset.name ?? "factura.pdf",
    });
  }

  async function submit() {
    if (!unidadId) {
      setError("Selecciona una unidad.");
      return;
    }
    if (!/^\d{4}-\d{2}$/.test(periodo.trim())) {
      setError("El período debe ser YYYY-MM (ej. 2026-06).");
      return;
    }
    const valorNum = Number(valor.replace(/[^\d.]/g, ""));
    if (!Number.isFinite(valorNum) || valorNum < 0) {
      setError("Ingresa un valor válido.");
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaVencimiento.trim())) {
      setError("Fecha de vencimiento: YYYY-MM-DD.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      let pdfUrl: string | undefined;
      if (adjunto) {
        const { uploadUrl, publicUrl } = await generateUploadUrl({
          folder: `condominios/facturas/${condominioId}`,
          contentType: adjunto.mimeType,
          fileName: adjunto.nombre,
        });
        const blobRes = await fetch(adjunto.uri);
        const blob = await blobRes.blob();
        const upload = await fetch(uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": adjunto.mimeType },
          body: blob,
        });
        if (!upload.ok) throw new Error("No se pudo subir el archivo.");
        pdfUrl = publicUrl;
      }

      const saldo = Number(saldoAFavor.replace(/[^\d.]/g, "")) || 0;
      const descRaw = totalConDescuento.trim();
      const desc = descRaw
        ? Number(descRaw.replace(/[^\d.]/g, ""))
        : undefined;
      if (desc !== undefined && (!Number.isFinite(desc) || desc < 0)) {
        throw new Error("Valor con descuento inválido.");
      }

      /* Medianoche de Colombia del día elegido, como la carga por PDF: ese
       * día todavía se paga y la mora empieza al siguiente. */
      const venc = Date.parse(`${fechaVencimiento.trim()}T00:00:00-05:00`);
      await createManual({
        condominioId,
        unidadId,
        periodo: periodo.trim(),
        fechaVencimiento: venc,
        valor: valorNum,
        saldoAFavor: saldo,
        totalConDescuento: desc,
        pdfUrl,
      });
      reset();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al crear factura");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <BottomSheet visible={visible} onClose={onClose} maxHeight="92%">
        <ScrollView
          contentContainerStyle={{
            padding: SoftUI.padH,
            paddingBottom: SoftUI.space.xxl,
          }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Text style={styles.sheetTitle}>Nueva factura</Text>

          <Text style={styles_label}>Unidad *</Text>
          <Tap
            style={inputStyle}
            onPress={() => setUnidadPicker(true)}
            haptic={false}
          >
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <Text
                style={{
                  color: selectedUnidad ? SoftUI.text : SoftUI.textDisabled,
                  fontSize: SoftUI.type.body.size,
                  fontFamily: AuthUI.font.regular,
                  flex: 1,
                }}
                numberOfLines={1}
              >
                {selectedUnidad
                  ? unidadLabel(selectedUnidad)
                  : "Selecciona una unidad"}
              </Text>
              <Ionicons
                name="chevron-down"
                size={18}
                color={SoftUI.textSecondary}
              />
            </View>
          </Tap>

          <Text style={[styles_label, { marginTop: SoftUI.space.base }]}>
            Período * (YYYY-MM)
          </Text>
          <TextInput
            value={periodo}
            onChangeText={(t) => {
              setPeriodo(t);
              /* El vencimiento propuesto sigue al período. */
              const propuesto = defaultVencimientoIso(t.trim());
              if (propuesto) setFechaVencimiento(propuesto);
            }}
            placeholder="2026-06"
            placeholderTextColor={SoftUI.textDisabled}
            autoCapitalize="none"
            style={inputStyle}
          />

          <Text style={[styles_label, { marginTop: SoftUI.space.base }]}>
            Fecha vencimiento * (YYYY-MM-DD)
          </Text>
          <TextInput
            value={fechaVencimiento}
            onChangeText={setFechaVencimiento}
            placeholder="2026-07-15"
            placeholderTextColor={SoftUI.textDisabled}
            autoCapitalize="none"
            style={inputStyle}
          />

          <Text style={[styles_label, { marginTop: SoftUI.space.base }]}>
            Valor (sin descuento) *
          </Text>
          <TextInput
            value={valor}
            onChangeText={setValor}
            placeholder="360000"
            placeholderTextColor={SoftUI.textDisabled}
            keyboardType="numeric"
            style={inputStyle}
          />

          <Text style={[styles_label, { marginTop: SoftUI.space.base }]}>
            Saldo a favor (opcional)
          </Text>
          <TextInput
            value={saldoAFavor}
            onChangeText={setSaldoAFavor}
            placeholder="0"
            placeholderTextColor={SoftUI.textDisabled}
            keyboardType="numeric"
            style={inputStyle}
          />

          <Text style={[styles_label, { marginTop: SoftUI.space.base }]}>
            Valor con descuento (opcional)
          </Text>
          <TextInput
            value={totalConDescuento}
            onChangeText={setTotalConDescuento}
            placeholder="Ej: 140000"
            placeholderTextColor={SoftUI.textDisabled}
            keyboardType="numeric"
            style={inputStyle}
          />

          <Text style={[styles_label, { marginTop: SoftUI.space.base }]}>
            Adjunto (PDF o imagen)
          </Text>
          <View
            style={{
              flexDirection: "row",
              gap: SoftUI.space.sm,
              marginBottom: SoftUI.space.md,
            }}
          >
            <Tap style={styles_attachBtn} onPress={pickImage} disabled={saving}>
              <Ionicons name="image-outline" size={18} color={theme.accent} />
              <Text style={styles_attachBtnText}>Foto</Text>
            </Tap>
            <Tap style={styles_attachBtn} onPress={pickPdf} disabled={saving}>
              <Ionicons
                name="document-text-outline"
                size={18}
                color={theme.accent}
              />
              <Text style={styles_attachBtnText}>PDF</Text>
            </Tap>
          </View>
          {adjunto ? (
            <View style={[styles_attachRow, { marginBottom: SoftUI.space.sm }]}>
              {adjunto.mimeType.startsWith("image/") ? (
                <Image source={{ uri: adjunto.uri }} style={styles_thumb} />
              ) : (
                <View style={styles_attachIcon}>
                  <Ionicons
                    name="document-text"
                    size={18}
                    color={theme.accent}
                  />
                </View>
              )}
              <Text style={styles_attachName} numberOfLines={1}>
                {adjunto.nombre}
              </Text>
              <Tap onPress={() => setAdjunto(null)} haptic={false}>
                <Ionicons
                  name="close-circle"
                  size={22}
                  color={SoftUI.textSecondary}
                />
              </Tap>
            </View>
          ) : null}

          {error ? (
            <Text
              style={{
                color: SoftUI.danger,
                fontSize: SoftUI.type.caption.size,
                fontFamily: AuthUI.font.medium,
                marginTop: SoftUI.space.sm,
              }}
            >
              {error}
            </Text>
          ) : null}

          <View
            style={{
              flexDirection: "row",
              gap: SoftUI.space.sm,
              marginTop: SoftUI.space.xl,
            }}
          >
            <Tap
              style={[styles_footerBtn, styles_footerCancel]}
              onPress={() => {
                reset();
                onClose();
              }}
              disabled={saving}
            >
              <Text
                style={{
                  color: SoftUI.text,
                  fontSize: SoftUI.type.body.size,
                  fontFamily: AuthUI.font.semibold,
                }}
              >
                Cancelar
              </Text>
            </Tap>
            <Tap
              style={[styles_footerBtn, styles_footerPrimary]}
              onPress={submit}
              disabled={saving}
            >
              {saving ? (
                <ActivityIndicator color={SoftUI.white} />
              ) : (
                <Text
                  style={{
                    color: SoftUI.white,
                    fontSize: SoftUI.type.body.size,
                    fontFamily: AuthUI.font.bold,
                  }}
                >
                  Crear
                </Text>
              )}
            </Tap>
          </View>
        </ScrollView>
      </BottomSheet>

      <BottomSheet
        visible={unidadPicker}
        onClose={() => setUnidadPicker(false)}
        maxHeight="80%"
      >
        <View
          style={{
            padding: SoftUI.padH,
            paddingBottom: SoftUI.space.sm,
          }}
        >
          <Text style={styles.sheetTitle}>Seleccionar unidad</Text>
          <View style={styles.searchBox}>
            <Ionicons name="search" size={16} color={SoftUI.textSecondary} />
            <TextInput
              value={unidadSearch}
              onChangeText={setUnidadSearch}
              placeholder="Buscar apto o nombre…"
              placeholderTextColor={SoftUI.textDisabled}
              style={styles.searchInput}
            />
          </View>
        </View>
        <ScrollView
          contentContainerStyle={{
            paddingHorizontal: SoftUI.padH,
            paddingBottom: SoftUI.space.section,
          }}
        >
          {unidades === undefined ? (
            <ActivityIndicator color={theme.accent} />
          ) : filteredUnidades.length === 0 ? (
            <Text style={styles.emptyText}>Sin unidades</Text>
          ) : (
            filteredUnidades.map((u) => {
              const active = u._id === unidadId;
              return (
                <Pressable
                  key={u._id}
                  onPress={() => {
                    setUnidadId(u._id);
                    setUnidadPicker(false);
                    setUnidadSearch("");
                  }}
                  style={[styles.sheetRow, active && styles.sheetRowActive]}
                >
                  <Text
                    style={[
                      styles.sheetRowText,
                      active && {
                        fontFamily: AuthUI.font.semibold,
                        color: theme.accent,
                      },
                    ]}
                  >
                    {unidadLabel(u)}
                  </Text>
                  {active ? (
                    <Ionicons name="checkmark" size={18} color={theme.accent} />
                  ) : null}
                </Pressable>
              );
            })
          )}
        </ScrollView>
      </BottomSheet>
    </>
  );
}

/* ── Modal de detalle (hoja suave) ───────────────────────────── */
function FacturaDetalleModal({
  detalle,
  cadena,
  cartera,
  condominioId,
  onClose,
}: {
  detalle: FacturaRow | null;
  /** Las facturas de la misma unidad (Fase 4: "sin verificar" y la mora). */
  cadena?: FacturaRow[];
  /** La cartera de hoy de su unidad: la vigente en mora se ve "vencida" (H2). */
  cartera?: CarteraUnidad | null;
  condominioId?: Id<"condominios">;
  onClose: () => void;
}) {
  const { theme } = useCondominio();
  const condo = useQuery(
    api.condominios.get,
    condominioId ? { condominioId } : "skip",
  );
  const crearPago = useAction(api.pagos.crearPagoFactura);
  const generateUploadUrl = useAction(api.files.generateUploadUrl);
  const crearSoporte = useMutation(api.soportesPago.crearMio);
  const misSoportes = useQuery(
    api.soportesPago.listMios,
    condominioId ? { condominioId } : "skip",
  );
  const [pagando, setPagando] = useState(false);
  const [subiendo, setSubiendo] = useState(false);
  /* "Ya pagué" pide cuánto y cuándo (Fase 3): el comprobante aprobado prueba
   * un pago por ese monto, no "pagada" a secas. */
  const [datosPago, setDatosPago] = useState<{ monto: string; fecha: string } | null>(null);
  useEffect(() => setDatosPago(null), [detalle?._id]);

  /* "Pagar" y "Ya pagué" solo donde el backend lo aceptaría: la factura
   * VIGENTE de una unidad suya y con saldo. Se le pregunta al servidor en vez
   * de deducirlo del estado: una factura vieja `vencida`, cuyo saldo ya va
   * dentro de la siguiente, no se ofrece para pagar otra vez.
   *
   * Fase 4: `opcionesDePago` separa las dos cosas. Con la pasarela en QA, a
   * una casa real no se le abre una transacción de prueba, pero la factura
   * sigue debiéndose: se paga por el portal del banco (si el conjunto lo
   * tiene) y el comprobante se puede enviar. Antes las dos dependían de
   * `pagos.puedePagar`, que ahora dice que no en ese caso. */
  const opciones = useQuery(
    api.pagos.opcionesDePago,
    detalle ? { facturaId: detalle._id } : "skip",
  );
  const portalBanco =
    condo?.avalPortalUrl?.trim() || avalPortalFallback(condo?.subdomain) || null;
  const debe = detalle != null && opciones?.debe === true;
  const puedePagar = debe && (portalBanco !== null || opciones?.pasarela === true);
  /* Sin portal del banco y con la pasarela en QA: se dice por qué no hay "Pagar". */
  const sinPagoEnLinea = debe && !puedePagar ? (opciones?.motivo ?? null) : null;

  // Comprobante más reciente que el residente ya envió por esta factura.
  const soporte = detalle
    ? (misSoportes ?? []).find((s) => s.facturaId === detalle._id)
    : undefined;

  /**
   * Canal manual mientras la pasarela Aval queda en producción: el residente
   * adjunta el comprobante y la administración lo valida en el portal.
   */
  async function enviarSoporte(adjunto: PendingAdjunto) {
    if (!detalle || !condominioId) return;
    const monto = Number((datosPago?.monto ?? "").replace(/[^\d]/g, ""));
    const fecha = (datosPago?.fecha ?? "").trim();
    if (!Number.isFinite(monto) || monto <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
      Alert.alert("Faltan datos", "Escribe cuánto pagaste y la fecha del pago (AAAA-MM-DD).");
      return;
    }
    setSubiendo(true);
    try {
      const { uploadUrl, publicUrl } = await generateUploadUrl({
        folder: `condominios/soportes/${condominioId}`,
        contentType: adjunto.mimeType,
        fileName: adjunto.nombre,
      });
      const blobRes = await fetch(adjunto.uri);
      const blob = await blobRes.blob();
      const upload = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": adjunto.mimeType },
        body: blob,
      });
      if (!upload.ok) throw new Error("No se pudo subir el comprobante.");

      await crearSoporte({
        condominioId,
        facturaId: detalle._id,
        url: publicUrl,
        mimeType: adjunto.mimeType,
        monto,
        /* Mediodía de Colombia: el día escrito, en cualquier zona. */
        fechaPago: Date.parse(`${fecha}T12:00:00-05:00`),
      });
      setDatosPago(null);
      Alert.alert(
        "Comprobante enviado",
        "La administración lo revisará y te confirmará el pago.",
      );
    } catch (e) {
      Alert.alert(
        "No se pudo enviar",
        e instanceof Error ? e.message : "Inténtalo de nuevo.",
      );
    } finally {
      setSubiendo(false);
    }
  }

  async function pickSoporteFoto() {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("Permiso necesario", "Activa el acceso a fotos para adjuntar.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 0.85,
    });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    await enviarSoporte({
      uri: asset.uri,
      mimeType: asset.mimeType ?? "image/jpeg",
      nombre: asset.fileName ?? "comprobante.jpg",
    });
  }

  async function pickSoportePdf() {
    const DocumentPicker = await getDocumentPicker();
    if (!DocumentPicker) return;
    const result = await DocumentPicker.getDocumentAsync({
      type: ["application/pdf"],
      copyToCacheDirectory: true,
    });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    await enviarSoporte({
      uri: asset.uri,
      mimeType: asset.mimeType ?? "application/pdf",
      nombre: asset.name ?? "comprobante.pdf",
    });
  }

  function elegirSoporte() {
    Alert.alert("Enviar comprobante", "¿De dónde tomamos el soporte?", [
      { text: "Foto de la galería", onPress: pickSoporteFoto },
      { text: "Archivo PDF", onPress: pickSoportePdf },
      { text: "Cancelar", style: "cancel" },
    ]);
  }

  /**
   * Salida al navegador externo. Reservada para la pasarela del banco: ahí el
   * usuario puede necesitar saltar a la app de su entidad y volver, así que no
   * la metemos en el visor incrustado (los PDF sí, con `openDocument`).
   */
  async function openUrl(url: string) {
    const can = await Linking.canOpenURL(url);
    if (!can) {
      Alert.alert("No se pudo abrir", "No hay una app para abrir este enlace.");
      return;
    }
    await Linking.openURL(url);
  }

  async function pagar() {
    if (!detalle) return;
    const avalPortalUrl =
      condo?.avalPortalUrl?.trim() ||
      avalPortalFallback(condo?.subdomain) ||
      null;
    if (avalPortalUrl) {
      try {
        await openUrl(avalPortalUrl);
      } catch {
        Alert.alert("Error", "No se pudo abrir la pasarela de pago.");
      }
      return;
    }

    setPagando(true);
    try {
      const { redirectUrl } = await crearPago({ facturaId: detalle._id });
      await openUrl(redirectUrl);
    } catch (e) {
      Alert.alert(
        "No se pudo pagar",
        e instanceof Error ? e.message : "Inténtalo de nuevo en unos minutos.",
      );
    } finally {
      setPagando(false);
    }
  }

  return (
    <BottomSheet visible={detalle !== null} onClose={onClose} maxHeight="88%">
      {detalle && (
        <ScrollView
          bounces={false}
          contentContainerStyle={{
            paddingHorizontal: SoftUI.padH,
            paddingTop: SoftUI.space.xs,
            paddingBottom: SoftUI.space.base,
          }}
          showsVerticalScrollIndicator={false}
        >
          <View
            style={{
              flexDirection: "row",
              justifyContent: "space-between",
              alignItems: "flex-start",
              marginBottom: SoftUI.space.md,
              gap: SoftUI.space.md,
            }}
          >
            <View style={{ gap: SoftUI.space.xs, flex: 1 }}>
              <Text
                style={{
                  color: SoftUI.textSecondary,
                  fontSize: SoftUI.type.caption.size,
                  fontFamily: AuthUI.font.medium,
                }}
              >
                Factura
              </Text>
              <Text
                style={{
                  color: SoftUI.text,
                  fontSize: SoftUI.type.hero.size - 2,
                  lineHeight: SoftUI.type.hero.line,
                  fontFamily: AuthUI.font.bold,
                }}
              >
                {fmtPeriodo(detalle.periodo)}
              </Text>
              {detalle.residenteNombre ? (
                <Text
                  style={{
                    color: SoftUI.textSecondary,
                    fontSize: SoftUI.type.body.size - 1,
                    fontFamily: AuthUI.font.regular,
                  }}
                >
                  {detalle.residenteNombre}
                </Text>
              ) : null}
              {detalle.apto ? (
                <Text
                  style={{
                    color: SoftUI.textSecondary,
                    fontSize: SoftUI.type.caption.size,
                    fontFamily: AuthUI.font.regular,
                  }}
                >
                  Apto {detalle.apto}
                </Text>
              ) : null}
            </View>
            <GlassBadge
              label={ESTADO_LABEL[estadoVisible(detalle, cadena, cartera) as EstadoVisible] ?? detalle.estado}
              tone={ESTADO_TONE[estadoVisible(detalle, cadena, cartera) as EstadoVisible] ?? "neutral"}
            />
          </View>

          <GlassCard
            style={{
              paddingHorizontal: SoftUI.space.base,
              marginBottom: SoftUI.space.md,
            }}
          >
            {detalle.lineas.map((l, i) => (
              <View
                key={i}
                style={{
                  flexDirection: "row",
                  justifyContent: "space-between",
                  paddingVertical: SoftUI.space.md,
                  borderBottomWidth:
                    i < detalle.lineas.length - 1 ? StyleSheet.hairlineWidth : 0,
                  borderColor: SoftUI.divider,
                }}
              >
                <Text
                  style={{
                    color: SoftUI.textSecondary,
                    fontSize: SoftUI.type.caption.size,
                    fontFamily: AuthUI.font.regular,
                    flex: 1,
                    paddingRight: SoftUI.space.md,
                  }}
                >
                  {l.concepto}
                </Text>
                <Text
                  style={{
                    color: SoftUI.text,
                    fontSize: SoftUI.type.caption.size,
                    fontFamily: AuthUI.font.semibold,
                  }}
                >
                  {cop(l.total)}
                </Text>
              </View>
            ))}
          </GlassCard>

          <GlassCard
            style={{
              padding: SoftUI.space.base,
              gap: SoftUI.space.sm,
              marginBottom: SoftUI.space.base,
              backgroundColor: SoftUI.bgSecondary,
            }}
          >
            <View
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
              }}
            >
              <Text
                style={{
                  color: SoftUI.textSecondary,
                  fontSize: SoftUI.type.body.size - 1,
                  fontFamily: AuthUI.font.regular,
                }}
              >
                {/* Las fechas reales (Fase 3): el descuento vale hasta la del
                    documento (o el 15 del mes del período), y sin descuento
                    hasta el vencimiento. */}
                Sin descuento, hasta el{" "}
                {new Date(detalle.fechaVencimiento).toLocaleDateString("es-CO", {
                  day: "numeric",
                  month: "short",
                  timeZone: "America/Bogota",
                })}
              </Text>
              <Text
                style={{
                  color: SoftUI.text,
                  fontSize: SoftUI.type.body.size - 1,
                  fontFamily: AuthUI.font.bold,
                }}
              >
                {cop(detalle.totalAPagar)}
              </Text>
            </View>
            {descuentoDe(detalle, Date.now()) ? (
              <View
                style={{
                  flexDirection: "row",
                  justifyContent: "space-between",
                }}
              >
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: SoftUI.space.xs,
                  }}
                >
                  <Ionicons name="pricetag" size={14} color={SoftUI.success} />
                  <Text
                    style={{
                      color: SoftUI.success,
                      fontSize: SoftUI.type.body.size - 1,
                      fontFamily: AuthUI.font.semibold,
                    }}
                  >
                    Con descuento, hasta el{" "}
                    {new Date(descuentoDe(detalle, Date.now())!.hasta).toLocaleDateString("es-CO", {
                      day: "numeric",
                      month: "short",
                      timeZone: "America/Bogota",
                    })}
                  </Text>
                </View>
                <Text
                  style={{
                    color: SoftUI.success,
                    fontSize: SoftUI.type.body.size - 1,
                    fontFamily: AuthUI.font.bold,
                  }}
                >
                  {cop(detalle.totalConDescuento ?? 0)}
                </Text>
              </View>
            ) : null}
          </GlassCard>

          {detalle.pagoEnVerificacion ? (
            <GlassCard
              style={{
                padding: SoftUI.space.base,
                marginBottom: SoftUI.space.base,
                flexDirection: "row",
                gap: SoftUI.space.sm,
                alignItems: "flex-start",
              }}
            >
              <Ionicons name="hourglass-outline" size={18} color={SoftUI.blue} />
              <Text
                style={{
                  flex: 1,
                  color: SoftUI.text,
                  fontSize: SoftUI.type.caption.size,
                  fontFamily: AuthUI.font.regular,
                }}
              >
                {mensajePagoEnVerificacion(detalle.pagoEnVerificacion.monto)}
              </Text>
            </GlassCard>
          ) : null}

          {soporte ? <SoporteEstado soporte={soporte} /> : null}

          {datosPago ? (
            <GlassCard style={{ padding: SoftUI.space.base, marginBottom: SoftUI.space.base, gap: SoftUI.space.sm }}>
              <Text style={styles_label}>¿Cuánto pagaste? *</Text>
              <TextInput
                value={datosPago.monto}
                onChangeText={(t) => setDatosPago({ ...datosPago, monto: t })}
                keyboardType="number-pad"
                placeholder="340000"
                placeholderTextColor={SoftUI.textDisabled}
                style={inputStyle}
              />
              <Text style={styles_label}>¿Qué día pagaste? * (AAAA-MM-DD)</Text>
              <TextInput
                value={datosPago.fecha}
                onChangeText={(t) => setDatosPago({ ...datosPago, fecha: t })}
                placeholder="2026-09-10"
                placeholderTextColor={SoftUI.textDisabled}
                autoCapitalize="none"
                style={inputStyle}
              />
            </GlassCard>
          ) : null}

          {(() => {
            /* Fase 4: desde cuándo cuenta como mora (el 16 del mes siguiente,
             * decisión B), "sin verificar" en una histórica que nadie pudo
             * juzgar, y por qué no hay "Pagar" con la pasarela en pruebas. */
            const plazos = plazosDe(detalle);
            const visible = estadoVisible(detalle, cadena, cartera);
            const esVigente = !(cadena ?? []).some((x) => x.periodo > detalle.periodo);
            const sinPagar = ["pendiente", "vencida", "abonada"].includes(detalle.estado);
            const nota = { color: SoftUI.textSecondary, fontSize: SoftUI.type.caption.size, fontFamily: AuthUI.font.regular };
            return (
              <View style={{ gap: SoftUI.space.xs, marginBottom: SoftUI.space.base }}>
                {plazos && esVigente && sinPagar && visible !== "sin_verificar" ? (
                  <Text style={nota}>
                    En mora desde el{" "}
                    {new Date(plazos.moraDesde).toLocaleDateString("es-CO", {
                      day: "numeric",
                      month: "long",
                      timeZone: "America/Bogota",
                    })}
                  </Text>
                ) : null}
                {visible === "sin_verificar" ? <Text style={nota}>{TEXTO_SIN_VERIFICAR}</Text> : null}
                {sinPagoEnLinea ? <Text style={nota}>{sinPagoEnLinea}</Text> : null}
              </View>
            );
          })()}

          <View style={{ gap: SoftUI.space.sm }}>
            {puedePagar ? (
              <GlassButton
                label={pagando ? "Abriendo pasarela…" : "Pagar"}
                icon={
                  pagando ? undefined : (
                    <Ionicons name="card-outline" size={18} color={SoftUI.white} />
                  )
                }
                onPress={pagando ? undefined : pagar}
                disabled={pagando || condo === undefined}
              />
            ) : null}
            {debe && soporte?.estado !== "pendiente_revision" ? (
              <GlassButton
                label={
                  subiendo
                    ? "Enviando…"
                    : datosPago
                      ? "Elegir el comprobante y enviar"
                      : "Ya pagué, enviar soporte"
                }
                variant="secondary"
                loading={subiendo}
                icon={
                  subiendo ? undefined : (
                    <Ionicons
                      name="cloud-upload-outline"
                      size={18}
                      color={theme.accent}
                    />
                  )
                }
                onPress={
                  subiendo
                    ? undefined
                    : datosPago
                      ? elegirSoporte
                      : () =>
                          setDatosPago({
                            /* Lo que se cobraba hoy, como punto de partida. */
                            monto: String(montoAPagarHoy(detalle, Date.now())),
                            fecha: new Date(Date.now() - 5 * 60 * 60 * 1000)
                              .toISOString()
                              .slice(0, 10),
                          })
                }
              />
            ) : null}
            {detalle.pdfUrl ? (
              <GlassButton
                label="Ver PDF"
                variant={puedePagar ? "secondary" : "primary"}
                icon={
                  <Ionicons
                    name="document-text-outline"
                    size={18}
                    color={puedePagar ? theme.accent : SoftUI.white}
                  />
                }
                onPress={() =>
                  openDocument(detalle.pdfUrl, { accent: theme.accent })
                }
              />
            ) : (
              <GlassButton
                label="PDF no disponible"
                variant="secondary"
                disabled
              />
            )}
            <GlassButton label="Cerrar" variant="secondary" onPress={onClose} />
          </View>
        </ScrollView>
      )}
    </BottomSheet>
  );
}

/** Estado del comprobante que el residente envió para esta factura. */
function SoporteEstado({
  soporte,
}: {
  soporte: { estado: string; notaRevision: string | null };
}) {
  const meta =
    soporte.estado === "pendiente_revision"
      ? {
          icon: "time-outline" as const,
          bg: SoftUI.warningSoft,
          fg: "#B8860B",
          titulo: "Comprobante en revisión",
          sub: "La administración lo está validando.",
        }
      : soporte.estado === "aprobado"
        ? {
            icon: "checkmark-circle-outline" as const,
            bg: SoftUI.successSoft,
            fg: SoftUI.success,
            titulo: "Comprobante aprobado",
            sub: "Tu pago quedó registrado.",
          }
        : {
            icon: "close-circle-outline" as const,
            bg: SoftUI.dangerSoft,
            fg: SoftUI.danger,
            titulo: "Comprobante rechazado",
            sub: "Puedes enviar uno nuevo.",
          };

  return (
    <GlassCard
      style={{
        padding: SoftUI.space.base,
        marginBottom: SoftUI.space.md,
        flexDirection: "row",
        alignItems: "center",
        gap: SoftUI.space.md,
      }}
    >
      <View
        style={{
          width: SoftUI.iconBtn,
          height: SoftUI.iconBtn,
          borderRadius: SoftUI.radius.chip,
          backgroundColor: meta.bg,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Ionicons name={meta.icon} size={20} color={meta.fg} />
      </View>
      <View style={{ flex: 1, gap: 2, minWidth: 0 }}>
        <Text
          style={{
            color: SoftUI.text,
            fontSize: SoftUI.type.body.size - 1,
            fontFamily: AuthUI.font.semibold,
          }}
        >
          {meta.titulo}
        </Text>
        <Text
          style={{
            color: SoftUI.textSecondary,
            fontSize: SoftUI.type.chip.size,
            fontFamily: AuthUI.font.regular,
          }}
        >
          {soporte.notaRevision || meta.sub}
        </Text>
      </View>
    </GlassCard>
  );
}

/** Fallback Aval Pay Center por convenio (mismo patrón que VekinoWeb). */
function avalPortalFallback(subdomain?: string | null): string | null {
  if (!subdomain) return null;
  const key = subdomain.toLowerCase();
  const map: Record<string, string> = {
    arboleda:
      "https://www.avalpaycenter.com/wps/portal/portal-de-pagos/web/pagos-aval/resultado-busqueda/realizar-pago?idConv=00014484&origen=buscar",
    "ciudad-del-campo-ii":
      "https://www.avalpaycenter.com/wps/portal/portal-de-pagos/web/pagos-aval/resultado-busqueda/realizar-pago?idConv=00003230&origen=buscar",
    "condominio-ciudad-del-campo-ii":
      "https://www.avalpaycenter.com/wps/portal/portal-de-pagos/web/pagos-aval/resultado-busqueda/realizar-pago?idConv=00003230&origen=buscar",
  };
  return map[key] ?? null;
}

const styles_label = {
  color: SoftUI.text,
  fontSize: SoftUI.type.caption.size,
  fontFamily: AuthUI.font.semibold,
  marginBottom: SoftUI.space.sm,
};
const inputStyle = {
  backgroundColor: SoftUI.field,
  borderRadius: SoftUI.radius.field,
  paddingHorizontal: SoftUI.space.base,
  paddingVertical: SoftUI.space.md,
  fontSize: SoftUI.type.body.size,
  color: SoftUI.text,
  fontFamily: AuthUI.font.regular,
  minHeight: SoftUI.fieldH,
};
const styles_attachBtn = {
  flex: 1,
  flexDirection: "row" as const,
  alignItems: "center" as const,
  justifyContent: "center" as const,
  gap: SoftUI.space.sm,
  paddingVertical: SoftUI.space.md,
  borderRadius: SoftUI.radius.button,
  backgroundColor: SoftUI.card,
  ...softShadow,
};
const styles_attachBtnText = {
  color: SoftUI.text,
  fontSize: SoftUI.type.caption.size + 1,
  fontFamily: AuthUI.font.semibold,
};
const styles_attachRow = {
  flexDirection: "row" as const,
  alignItems: "center" as const,
  gap: SoftUI.space.md,
  paddingVertical: SoftUI.space.md,
  paddingHorizontal: SoftUI.space.md,
  borderRadius: SoftUI.radius.cardSm,
  backgroundColor: SoftUI.card,
  ...softShadow,
};
const styles_attachIcon = {
  width: SoftUI.iconBtn - 8,
  height: SoftUI.iconBtn - 8,
  borderRadius: SoftUI.radius.icon,
  backgroundColor: SoftUI.infoSoft,
  alignItems: "center" as const,
  justifyContent: "center" as const,
};
const styles_thumb = {
  width: SoftUI.iconBtn - 8,
  height: SoftUI.iconBtn - 8,
  borderRadius: SoftUI.radius.icon,
  backgroundColor: SoftUI.bgSecondary,
};
const styles_attachName = {
  flex: 1,
  color: SoftUI.text,
  fontSize: SoftUI.type.caption.size,
  fontFamily: AuthUI.font.medium,
};
const styles_footerBtn = {
  flex: 1,
  alignItems: "center" as const,
  justifyContent: "center" as const,
  paddingVertical: SoftUI.space.base,
  borderRadius: SoftUI.radius.button,
  minHeight: SoftUI.buttonH - 4,
};
const styles_footerCancel = {
  backgroundColor: SoftUI.card,
  borderWidth: StyleSheet.hairlineWidth,
  borderColor: SoftUI.divider,
};
const styles_footerPrimary = {
  backgroundColor: SoftUI.blue,
};

const styles = StyleSheet.create({
  scroll: {
    paddingBottom: 150,
    paddingHorizontal: SoftUI.padH,
    paddingTop: SoftUI.space.md,
  },
  periodoRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: SoftUI.space.sm,
    marginBottom: SoftUI.space.base,
  },
  periodoBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: SoftUI.card,
    borderRadius: SoftUI.radius.cardSm,
    paddingHorizontal: SoftUI.space.base,
    paddingVertical: SoftUI.space.md,
    minHeight: SoftUI.fieldH,
    ...softShadow,
  },
  periodoIcon: {
    width: 36,
    height: 36,
    borderRadius: SoftUI.radius.chip,
    backgroundColor: SoftUI.infoSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  periodoLabel: {
    color: SoftUI.text,
    fontSize: SoftUI.type.body.size,
    fontFamily: AuthUI.font.semibold,
  },
  sheetTitle: {
    color: SoftUI.text,
    fontSize: SoftUI.type.section.size,
    fontFamily: AuthUI.font.bold,
    marginBottom: SoftUI.space.base,
  },
  sheetRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: SoftUI.space.md,
    paddingHorizontal: SoftUI.space.md,
    borderRadius: SoftUI.radius.cardSm,
    marginBottom: 2,
  },
  sheetRowActive: {
    backgroundColor: SoftUI.infoSoft,
  },
  sheetRowText: {
    color: SoftUI.text,
    fontSize: SoftUI.type.body.size,
    fontFamily: AuthUI.font.regular,
  },
  nuevaBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: SoftUI.space.xs,
    backgroundColor: SoftUI.blue,
    paddingHorizontal: SoftUI.space.base,
    paddingVertical: SoftUI.space.sm + 2,
    borderRadius: SoftUI.radius.chip,
    minHeight: SoftUI.touch,
  },
  nuevaBtnText: {
    color: SoftUI.white,
    fontSize: SoftUI.type.chip.size,
    fontFamily: AuthUI.font.semibold,
  },
  kpiRow: {
    flexDirection: "row",
    gap: SoftUI.space.sm,
    marginBottom: SoftUI.space.base,
  },
  kpiCard: {
    flex: 1,
    paddingVertical: SoftUI.space.base,
    paddingHorizontal: SoftUI.space.sm,
    alignItems: "center",
    gap: SoftUI.space.xs,
  },
  kpiValue: {
    fontSize: SoftUI.type.section.size,
    fontFamily: AuthUI.font.bold,
  },
  kpiLabel: {
    color: SoftUI.textSecondary,
    fontSize: SoftUI.type.chip.size - 1,
    fontFamily: AuthUI.font.medium,
  },
  summaryCard: {
    padding: SoftUI.space.base,
    marginBottom: SoftUI.space.base,
    flexDirection: "row",
    alignItems: "center",
    gap: SoftUI.space.md,
    minHeight: 82,
  },
  summaryIcon: {
    width: SoftUI.iconBtn,
    height: SoftUI.iconBtn,
    borderRadius: SoftUI.radius.chip,
    backgroundColor: SoftUI.blue,
    alignItems: "center",
    justifyContent: "center",
  },
  summaryTitle: {
    color: SoftUI.text,
    fontSize: SoftUI.type.cardTitle.size - 1,
    fontFamily: AuthUI.font.semibold,
  },
  summarySub: {
    color: SoftUI.textSecondary,
    fontSize: SoftUI.type.caption.size,
    fontFamily: AuthUI.font.regular,
  },
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: SoftUI.field,
    borderRadius: SoftUI.radius.field,
    paddingHorizontal: SoftUI.space.base,
    marginBottom: SoftUI.space.base,
    minHeight: SoftUI.fieldH,
    gap: SoftUI.space.sm,
  },
  searchInput: {
    flex: 1,
    color: SoftUI.text,
    fontSize: SoftUI.type.body.size,
    paddingVertical: SoftUI.space.md,
    fontFamily: AuthUI.font.regular,
  },
  chip: {
    paddingHorizontal: SoftUI.space.base,
    paddingVertical: SoftUI.space.sm,
    borderRadius: SoftUI.radius.chip,
    backgroundColor: SoftUI.card,
    ...softShadow,
  },
  chipActive: {
    backgroundColor: SoftUI.blue,
  },
  chipText: {
    color: SoftUI.textSecondary,
    fontSize: SoftUI.type.chip.size,
    fontFamily: AuthUI.font.semibold,
  },
  chipTextActive: {
    color: SoftUI.white,
  },
  facturaCard: {
    padding: SoftUI.space.base,
    flexDirection: "row",
    alignItems: "center",
    gap: SoftUI.space.md,
  },
  facturaIcon: {
    width: SoftUI.iconBtn,
    height: SoftUI.iconBtn,
    borderRadius: SoftUI.radius.chip,
    alignItems: "center",
    justifyContent: "center",
  },
  facturaBody: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  facturaTitle: {
    color: SoftUI.text,
    fontSize: SoftUI.type.body.size,
    fontFamily: AuthUI.font.semibold,
  },
  facturaMeta: {
    color: SoftUI.textSecondary,
    fontSize: SoftUI.type.chip.size,
    fontFamily: AuthUI.font.regular,
  },
  facturaDue: {
    color: SoftUI.textSecondary,
    fontSize: SoftUI.type.chip.size - 1,
    fontFamily: AuthUI.font.regular,
  },
  descuentoRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: SoftUI.space.xs,
    marginTop: SoftUI.space.sm,
  },
  descuentoText: {
    color: SoftUI.success,
    fontSize: SoftUI.type.chip.size,
    fontFamily: AuthUI.font.semibold,
  },
  facturaRight: {
    alignItems: "flex-end",
    gap: SoftUI.space.sm,
  },
  facturaMonto: {
    color: SoftUI.text,
    fontSize: SoftUI.type.body.size,
    fontFamily: AuthUI.font.bold,
  },
  glassAction: {
    width: 36,
    height: 36,
    borderRadius: SoftUI.radius.chip,
    backgroundColor: SoftUI.infoSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyCard: {
    padding: SoftUI.space.xxl,
    alignItems: "center",
    gap: SoftUI.space.md,
  },
  emptyText: {
    color: SoftUI.textSecondary,
    fontSize: SoftUI.type.caption.size + 1,
    fontFamily: AuthUI.font.regular,
    textAlign: "center",
  },
});
