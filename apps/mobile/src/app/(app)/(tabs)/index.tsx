import { useEffect } from "react";
import {
  View,
  Text,
  ScrollView,
  ActivityIndicator,
  Pressable,
  Image,
  StyleSheet,
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useQuery, useMutation, Authenticated } from "convex/react";
import { api } from "@vekino/backend/api";
import type { Id } from "@vekino/backend/dataModel";
import {
  ScreenBackground,
  GlassCard,
  GlassBadge,
  GlassSection,
  SoftGradientCard,
} from "@/components/ui/glass";
import { SoftHomeHeader } from "@/components/ui/soft-home-header";
import { Tap } from "@/components/ui/tap";
import { cop, fmtPeriodo, formatDisplayName, greetingName } from "@/lib/utils";
import { useCondominio } from "@/context/condominio-context";
import { C } from "@/lib/theme";
import { AuthUI } from "@/lib/auth-ui";
import { SoftUI, softShadow } from "@/lib/soft-ui";
import { SuperadminPanel } from "@/components/platform/superadmin-panel";
import { AdminCondominioHome } from "@/components/condominio/admin-home";
import { GuardiaHome } from "@/components/guardia/guardia-home";
import { AvisoEstadoGuardia, SinPorteria } from "@/components/guardia/sin-porteria";
import { SolicitudesCobertura } from "@/components/guardia/solicitudes-cobertura";
import { LimiteOperativo } from "@/components/guardia/error-operativo";

const ESTADO_TONE: Record<
  string,
  "yellow" | "green" | "red" | "neutral" | "blue"
> = {
  pendiente: "yellow",
  pagada: "green",
  vencida: "red",
  abonada: "blue",
};
const ESTADO_LABEL: Record<string, string> = {
  pendiente: "Pendiente",
  pagada: "Pagada",
  vencida: "Vencida",
  abonada: "Abonada",
};

const ESTADO_ICON: Record<
  string,
  { name: React.ComponentProps<typeof Ionicons>["name"]; bg: string; fg: string }
> = {
  pendiente: {
    name: "time-outline",
    bg: SoftUI.warningSoft,
    fg: "#B8860B",
  },
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
  abonada: {
    name: "wallet-outline",
    bg: SoftUI.infoSoft,
    fg: SoftUI.blue,
  },
};

/** Fallback remoto si el condo aún no tiene foto destacada en BD. */
const FEATURED_FALLBACK_URI =
  "https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?auto=format&fit=crop&w=800&q=70";

/** Fondo de la tarjeta destacada: la portada del condominio. */
function featuredImageSource(coverImage: string | null | undefined) {
  const uri = coverImage?.trim();
  if (uri) return { uri };
  return { uri: FEATURED_FALLBACK_URI };
}

export default function HomeScreen() {
  return (
    <View style={{ flex: 1 }}>
      <ScreenBackground>
        <Authenticated>
          <HomeContent />
        </Authenticated>
      </ScreenBackground>
    </View>
  );
}

function HomeContent() {
  const ensureProfile = useMutation(api.users.ensureProfile);
  const me = useQuery(api.users.me);
  const {
    condominioId,
    condominioName,
    isSuperadmin,
    canManage,
    isGuardia,
    estadoGuardia,
    isLoading,
    clearCondominio,
  } = useCondominio();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const id = await ensureProfile();
      if (cancelled || id) return;
      await new Promise((r) => setTimeout(r, 400));
      if (!cancelled) await ensureProfile();
    })();
    return () => {
      cancelled = true;
    };
  }, [ensureProfile]);

  const hora = new Date().getHours();
  const saludo =
    hora < 12 ? "Buenos días" : hora < 18 ? "Buenas tardes" : "Buenas noches";
  const displayName = me ? greetingName(me) : "";

  if (!me || isLoading) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={C.brand} size="large" />
      </View>
    );
  }

  if (isSuperadmin && !condominioId) {
    return <SuperadminPanel firstName={displayName} saludo={saludo} />;
  }

  if (canManage && condominioId) {
    return (
      <AdminCondominioHome
        firstName={displayName}
        saludo={saludo}
        avatarUrl={me.image}
        condominioId={condominioId}
        condominioName={condominioName}
        isSuperadmin={isSuperadmin}
        onClearCondominio={clearCondominio}
      />
    );
  }

  if (isGuardia && condominioId) {
    /* El límite se reinicia al cambiar de portería: si la de antes dejó de
     * valer a media pantalla, la nueva arranca limpia. */
    return (
      <LimiteOperativo key={condominioId}>
        <GuardiaHome
          displayName={displayName}
          saludo={saludo}
          avatarUrl={me.image}
          condominioId={condominioId}
        />
      </LimiteOperativo>
    );
  }

  /* Guarda de compañía sin portería hoy (o con el contexto bloqueado): no es
   * "no estás vinculado a ningún condominio", y no se le inventa uno. */
  if (!condominioId && estadoGuardia) {
    return (
      <SinPorteria
        estado={estadoGuardia}
        saludo={saludo}
        displayName={displayName}
        avatarUrl={me.image}
      />
    );
  }

  return (
    <ResidentHome
      firstName={displayName}
      saludo={saludo}
      avatarUrl={me.image}
      condominioId={condominioId}
      condominioName={condominioName}
      esGuardaDeCompania={!!me.compania?.roles.includes("guardia")}
      bloqueado={estadoGuardia === "bloqueado"}
    />
  );
}

/* ─────────────── Home RESIDENTE (layout Soft UI referencia) ─────────────── */

function ResidentHome({
  firstName,
  saludo,
  avatarUrl,
  condominioId,
  condominioName,
  esGuardaDeCompania,
  bloqueado,
}: {
  firstName: string;
  saludo: string;
  avatarUrl?: string | null;
  condominioId: Id<"condominios"> | undefined;
  condominioName: string | null;
  /** Guarda de compañía mirando su casa: sus solicitudes también salen aquí. */
  esGuardaDeCompania: boolean;
  /** Y si su operación como guarda está bloqueada, se le dice igual. */
  bloqueado: boolean;
}) {
  const router = useRouter();
  const { theme, coverImage } = useCondominio();
  const facturas = useQuery(
    api.facturas.listMia,
    condominioId ? { condominioId } : "skip",
  );
  const comunicados = useQuery(
    api.comunicados.listRecent,
    condominioId ? { condominioId, limit: 3 } : "skip",
  );
  const pendientes = (facturas ?? []).filter((f) => f.estado === "pendiente");
  const totalAPagar = pendientes.reduce((s, f) => s + f.totalAPagar, 0);
  const linkColor = theme.accent;
  const featuredAviso = (comunicados ?? []).find((c) => c.fijado) ?? comunicados?.[0];

  return (
    <View style={{ flex: 1 }}>
      <SoftHomeHeader
        saludo={saludo}
        displayName={firstName}
        avatarUrl={avatarUrl}
        badgeLabel={condominioName ?? "Residente"}
        showNotifDot={false}
      />

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        {bloqueado && <AvisoEstadoGuardia estado="bloqueado" />}
        {esGuardaDeCompania && <SolicitudesCobertura />}

        {/* 1. Tarjeta de uso / plan (facturas) */}
        {condominioId && (
          <GlassCard style={styles.usageCard}>
            <View
              style={[styles.usageIcon, { backgroundColor: SoftUI.bgSecondary }]}
            >
              <Ionicons
                name="wallet-outline"
                size={22}
                color={SoftUI.text}
              />
            </View>
            <View style={{ flex: 1, gap: 2, minWidth: 0 }}>
              <Text style={styles.usageTitle} numberOfLines={1}>
                {facturas === undefined
                  ? "…"
                  : pendientes.length === 0
                    ? "Estás al día"
                    : pendientes.length === 1
                      ? "1 factura pendiente"
                      : `${pendientes.length} facturas pendientes`}
              </Text>
              <Text style={styles.usageSub} numberOfLines={1}>
                {facturas === undefined
                  ? "Cargando…"
                  : totalAPagar > 0
                    ? `${cop(totalAPagar)} por pagar`
                    : "No tienes saldos pendientes"}
              </Text>
            </View>
            <Tap
              onPress={() => router.push("/(app)/(tabs)/facturas" as never)}
              style={[styles.capsuleBtn, { backgroundColor: SoftUI.text }]}
            >
              <Text style={styles.capsuleBtnText}>Ver</Text>
            </Tap>
          </GlassCard>
        )}

        {/* 2. Tarjeta destacada con foto */}
        {condominioId && (
          <Tap
            onPress={() =>
              router.push("/(app)/(tabs)/comunicados" as never)
            }
            style={styles.featuredWrap}
          >
            {/* De fondo va SIEMPRE la foto del conjunto: es horizontal y está
                hecha para esto. Los avisos son flyers verticales llenos de
                texto — de fondo se recortan mal y chocan con el título, así
                que el del aviso va aparte, como miniatura. */}
            <Image
              source={featuredImageSource(coverImage)}
              style={styles.featuredImage}
              resizeMode="cover"
            />
            <LinearGradient
              colors={[
                "rgba(8,63,82,0.35)",
                "transparent",
                "rgba(8,63,82,0.85)",
              ]}
              locations={[0, 0.4, 1]}
              style={StyleSheet.absoluteFill}
            />
            <View style={styles.featuredChip}>
              <Text style={styles.featuredChipText}>
                {featuredAviso ? "AVISO" : "EN TU CONDO"}
              </Text>
            </View>
            <View style={styles.featuredBottom}>
              <View style={{ flex: 1, gap: SoftUI.space.sm, minWidth: 0 }}>
                <Text style={styles.featuredTitle} numberOfLines={2}>
                  {featuredAviso?.titulo ?? condominioName ?? "Tu comunidad"}
                </Text>
                <View style={styles.featuredMeta}>
                  <Ionicons name="calendar-outline" size={14} color="rgba(255,255,255,0.9)" />
                  <Text style={styles.featuredDate}>
                    {featuredAviso
                      ? new Date(featuredAviso.createdAt).toLocaleDateString("es-CO", {
                          day: "numeric",
                          month: "short",
                          year: "numeric",
                        })
                      : "Novedades y espacios"}
                  </Text>
                </View>
              </View>
              {/* Miniatura del flyer: avisa que el aviso trae imagen sin
                  competir con el título. Se ve entera (contain), no recortada. */}
              {featuredAviso?.imagenUrl ? (
                <View style={styles.featuredThumbWrap}>
                  <Image
                    source={{ uri: featuredAviso.imagenUrl }}
                    style={styles.featuredThumb}
                    resizeMode="contain"
                  />
                </View>
              ) : null}
            </View>
          </Tap>
        )}

        {/* 3. Título de sección + CTA */}
        <Text style={styles.sectionTitle}>Planea tu día</Text>

        {condominioId && (
          <SoftGradientCard style={{ marginBottom: SoftUI.space.base }}>
            <View style={styles.wave} pointerEvents="none" />
            <View style={styles.wave2} pointerEvents="none" />
            <View style={styles.ctaRow}>
              <View style={{ flex: 1, gap: SoftUI.space.sm }}>
                <Text style={styles.ctaTitle}>Reserva un espacio</Text>
                <Text style={styles.ctaSub}>¿Qué zona quieres usar?</Text>
                <Text style={styles.ctaHint}>
                  Salón · piscina · BBQ · amenidades
                </Text>
              </View>
              <Tap
                onPress={() => router.push("/(app)/reservas" as never)}
                style={styles.ctaCircle}
              >
                <Ionicons name="paper-plane" size={22} color={theme.accent} />
              </Tap>
            </View>
          </SoftGradientCard>
        )}

        {/* 4. Tarjeta secundaria — visitas */}
        {condominioId && (
          <GlassCard style={styles.secondaryCard}>
            <View style={styles.secondaryHead}>
              <View style={[styles.secondaryIcon, { backgroundColor: theme.accentSoft }]}>
                <Ionicons name="person-add-outline" size={20} color={theme.accent} />
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <View style={styles.secondaryTitleRow}>
                  <Text style={styles.secondaryTitle}>Visitas</Text>
                  <View style={styles.freeChip}>
                    <Text style={styles.freeChipText}>Gratis</Text>
                  </View>
                </View>
                <Text style={styles.secondaryDesc}>
                  Autoriza visitantes y comparte el acceso con portería.
                </Text>
              </View>
            </View>
            <Tap
              onPress={() => router.push("/(app)/visitantes" as never)}
              style={styles.secondaryField}
            >
              <Text style={styles.secondaryFieldText} numberOfLines={1}>
                Registrar o ver visitas activas
              </Text>
              <View style={[styles.copyBtn, { backgroundColor: theme.accent }]}>
                <Ionicons name="arrow-forward" size={16} color={SoftUI.white} />
                <Text style={styles.copyBtnText}>Ir</Text>
              </View>
            </Tap>
          </GlassCard>
        )}

        {/* Acceso rápido compacto */}
        <View style={{ marginTop: SoftUI.space.xl }}>
          <GlassSection title="Acceso rápido">
            <View style={styles.quickRow}>
              {(
                [
                  {
                    icon: "wallet-outline" as const,
                    label: "Facturas",
                    route: "/(app)/(tabs)/facturas",
                  },
                  {
                    icon: "megaphone-outline" as const,
                    label: "Avisos",
                    route: "/(app)/(tabs)/comunicados",
                  },
                  {
                    icon: "calendar-outline" as const,
                    label: "Reservas",
                    route: "/(app)/reservas",
                  },
                  {
                    icon: "chatbox-ellipses-outline" as const,
                    label: "PQRS",
                    route: "/(app)/pqrs",
                  },
                ] as const
              ).map((a) => (
                <View key={a.label} style={styles.quickItem}>
                  <Tap
                    style={{ width: "100%" }}
                    onPress={() => router.push(a.route as never)}
                  >
                    <View style={styles.quickCard}>
                      <View
                        style={[
                          styles.quickIcon,
                          { backgroundColor: theme.tabActiveBg },
                        ]}
                      >
                        <Ionicons name={a.icon} size={18} color={theme.accent} />
                      </View>
                      <Text style={styles.quickLabel} numberOfLines={1}>
                        {a.label}
                      </Text>
                    </View>
                  </Tap>
                </View>
              ))}
            </View>
          </GlassSection>
        </View>

        {/* Mis facturas */}
        {condominioId && (
          <View style={{ marginTop: SoftUI.space.xl }}>
            <GlassSection
              title="Mis facturas"
              action={
                <Pressable
                  onPress={() => router.push("/(app)/(tabs)/facturas" as never)}
                >
                  <Text style={[styles.link, { color: linkColor }]}>
                    Ver todas
                  </Text>
                </Pressable>
              }
            >
              {facturas === undefined ? (
                <ActivityIndicator color={C.textSoft} />
              ) : facturas.length === 0 ? (
                <GlassCard style={styles.emptyPad}>
                  <Text style={styles.emptyText}>Sin facturas registradas</Text>
                </GlassCard>
              ) : (
                <View style={{ gap: SoftUI.space.md }}>
                  {facturas.slice(0, 3).map((f) => {
                    const iconMeta =
                      ESTADO_ICON[f.estado] ?? ESTADO_ICON.abonada;
                    return (
                      <Tap
                        key={f._id}
                        onPress={() =>
                          router.push("/(app)/(tabs)/facturas" as never)
                        }
                      >
                        <GlassCard style={styles.facturaCard}>
                          <View
                            style={[
                              styles.facturaIcon,
                              { backgroundColor: iconMeta.bg },
                            ]}
                          >
                            <Ionicons
                              name={iconMeta.name}
                              size={22}
                              color={iconMeta.fg}
                            />
                          </View>
                          <View style={styles.facturaBody}>
                            <Text style={styles.facturaPeriodo} numberOfLines={1}>
                              {fmtPeriodo(f.periodo)}
                            </Text>
                            <Text style={styles.facturaMeta} numberOfLines={1}>
                              {formatDisplayName(f.residenteNombre)}
                            </Text>
                            <View style={{ marginTop: 6 }}>
                              <GlassBadge
                                label={ESTADO_LABEL[f.estado] ?? f.estado}
                                tone={ESTADO_TONE[f.estado] ?? "neutral"}
                              />
                            </View>
                          </View>
                          <View style={styles.facturaRight}>
                            <Text style={styles.facturaMonto}>
                              {cop(f.totalAPagar)}
                            </Text>
                            <View style={styles.glassAction}>
                              <Ionicons
                                name="chevron-forward"
                                size={18}
                                color={theme.accent}
                              />
                            </View>
                          </View>
                        </GlassCard>
                      </Tap>
                    );
                  })}
                </View>
              )}
            </GlassSection>
          </View>
        )}

        {!condominioId && (
          <GlassCard
            style={{
              padding: SoftUI.space.xl,
              alignItems: "center",
              marginTop: SoftUI.space.xl,
              gap: 12,
            }}
          >
            <Ionicons name="business-outline" size={36} color={C.textMuted} />
            <Text style={[styles.emptyText, { textAlign: "center" }]}>
              No estás vinculado a ningún condominio.{"\n"}Contacta a tu administrador.
            </Text>
          </GlassCard>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: {
    paddingBottom: 150,
    paddingHorizontal: SoftUI.padH,
    paddingTop: SoftUI.space.base,
  },
  usageCard: {
    padding: SoftUI.space.base,
    marginBottom: SoftUI.space.base,
    minHeight: 82,
    flexDirection: "row",
    alignItems: "center",
    gap: SoftUI.space.md,
  },
  usageIcon: {
    width: SoftUI.iconBtn,
    height: SoftUI.iconBtn,
    borderRadius: SoftUI.radius.chip,
    alignItems: "center",
    justifyContent: "center",
  },
  usageTitle: {
    color: SoftUI.text,
    fontSize: SoftUI.type.cardTitle.size - 1,
    fontFamily: AuthUI.font.semibold,
  },
  usageSub: {
    color: SoftUI.textSecondary,
    fontSize: SoftUI.type.caption.size,
    fontFamily: AuthUI.font.regular,
  },
  capsuleBtn: {
    borderRadius: SoftUI.radius.chip,
    paddingHorizontal: SoftUI.space.base,
    paddingVertical: SoftUI.space.sm + 2,
    minHeight: SoftUI.touch,
    justifyContent: "center",
  },
  capsuleBtnText: {
    color: SoftUI.white,
    fontSize: SoftUI.type.chip.size,
    fontFamily: AuthUI.font.semibold,
  },
  featuredWrap: {
    width: "100%",
    aspectRatio: 1000 / 562,
    borderRadius: SoftUI.radius.card,
    overflow: "hidden",
    marginBottom: SoftUI.space.xl,
    backgroundColor: SoftUI.deep,
    ...softShadow,
  },
  featuredImage: {
    ...StyleSheet.absoluteFillObject,
    width: "100%",
    height: "100%",
  },
  featuredChip: {
    position: "absolute",
    top: SoftUI.space.base,
    left: SoftUI.space.base,
    backgroundColor: "rgba(255,255,255,0.92)",
    borderRadius: SoftUI.radius.chip,
    paddingHorizontal: SoftUI.space.md,
    paddingVertical: 6,
  },
  featuredChipText: {
    color: SoftUI.text,
    fontSize: SoftUI.type.chip.size - 1,
    fontFamily: AuthUI.font.semibold,
    letterSpacing: 0.4,
  },
  featuredBottom: {
    position: "absolute",
    left: SoftUI.space.lg,
    right: SoftUI.space.lg,
    bottom: SoftUI.space.lg,
    flexDirection: "row",
    alignItems: "flex-end",
    gap: SoftUI.space.md,
  },
  featuredThumbWrap: {
    width: 104,
    height: 134,
    borderRadius: SoftUI.radius.cardSm,
    overflow: "hidden",
    backgroundColor: "rgba(255,255,255,0.95)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.6)",
    padding: 3,
  },
  featuredThumb: {
    width: "100%",
    height: "100%",
    borderRadius: 4,
  },
  featuredTitle: {
    color: SoftUI.white,
    fontSize: SoftUI.type.section.size,
    lineHeight: SoftUI.type.section.line,
    fontFamily: AuthUI.font.bold,
  },
  featuredMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: SoftUI.space.sm,
  },
  featuredDate: {
    color: "rgba(255,255,255,0.9)",
    fontSize: SoftUI.type.caption.size,
    fontFamily: AuthUI.font.medium,
  },
  sectionTitle: {
    color: SoftUI.text,
    fontSize: SoftUI.type.section.size,
    lineHeight: SoftUI.type.section.line,
    fontFamily: AuthUI.font.semibold,
    marginBottom: SoftUI.space.base,
  },
  wave: {
    position: "absolute",
    right: -24,
    top: -40,
    width: 140,
    height: 140,
    borderRadius: 70,
    backgroundColor: "rgba(255,255,255,0.12)",
  },
  wave2: {
    position: "absolute",
    right: 40,
    bottom: -50,
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  ctaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: SoftUI.space.base,
  },
  ctaTitle: {
    color: SoftUI.white,
    fontSize: SoftUI.type.section.size,
    lineHeight: SoftUI.type.section.line,
    fontFamily: AuthUI.font.bold,
  },
  ctaSub: {
    color: "rgba(255,255,255,0.92)",
    fontSize: SoftUI.type.body.size,
    fontFamily: AuthUI.font.medium,
  },
  ctaHint: {
    color: "rgba(255,255,255,0.75)",
    fontSize: SoftUI.type.caption.size,
    fontFamily: AuthUI.font.regular,
  },
  ctaCircle: {
    width: SoftUI.iconBtn + 6,
    height: SoftUI.iconBtn + 6,
    borderRadius: SoftUI.radius.chip,
    backgroundColor: SoftUI.white,
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryCard: {
    padding: SoftUI.space.lg,
    gap: SoftUI.space.base,
    marginBottom: SoftUI.space.sm,
  },
  secondaryHead: {
    flexDirection: "row",
    gap: SoftUI.space.md,
    alignItems: "flex-start",
  },
  secondaryIcon: {
    width: SoftUI.iconBtn,
    height: SoftUI.iconBtn,
    borderRadius: SoftUI.radius.chip,
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: SoftUI.space.sm,
  },
  secondaryTitle: {
    color: SoftUI.text,
    fontSize: SoftUI.type.cardTitle.size,
    fontFamily: AuthUI.font.semibold,
  },
  freeChip: {
    backgroundColor: SoftUI.text,
    borderRadius: SoftUI.radius.chip,
    paddingHorizontal: SoftUI.space.sm + 2,
    paddingVertical: 3,
  },
  freeChipText: {
    color: SoftUI.white,
    fontSize: SoftUI.type.chip.size - 1,
    fontFamily: AuthUI.font.semibold,
  },
  secondaryDesc: {
    color: SoftUI.textSecondary,
    fontSize: SoftUI.type.caption.size,
    lineHeight: SoftUI.type.caption.line,
    fontFamily: AuthUI.font.regular,
  },
  secondaryField: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: SoftUI.field,
    borderRadius: SoftUI.radius.field,
    paddingLeft: SoftUI.space.base,
    paddingRight: SoftUI.space.sm,
    minHeight: SoftUI.fieldH,
    gap: SoftUI.space.sm,
  },
  secondaryFieldText: {
    flex: 1,
    color: SoftUI.textSecondary,
    fontSize: SoftUI.type.caption.size + 1,
    fontFamily: AuthUI.font.regular,
  },
  copyBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: SoftUI.radius.chip,
    paddingHorizontal: SoftUI.space.md,
    paddingVertical: SoftUI.space.sm,
  },
  copyBtnText: {
    color: SoftUI.white,
    fontSize: SoftUI.type.chip.size,
    fontFamily: AuthUI.font.semibold,
  },
  quickRow: {
    flexDirection: "row",
    gap: SoftUI.space.sm,
  },
  quickItem: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
  },
  quickCard: {
    width: "100%",
    minHeight: SoftUI.touch + 30,
    paddingVertical: SoftUI.space.md,
    alignItems: "center",
    justifyContent: "center",
    gap: SoftUI.space.sm,
    borderRadius: SoftUI.radius.cardSm,
    backgroundColor: SoftUI.card,
    ...softShadow,
  },
  quickIcon: {
    width: 36,
    height: 36,
    borderRadius: SoftUI.radius.chip,
    alignItems: "center",
    justifyContent: "center",
  },
  quickLabel: {
    color: SoftUI.textSecondary,
    fontSize: SoftUI.type.chip.size - 1,
    fontFamily: AuthUI.font.semibold,
  },
  link: {
    fontSize: SoftUI.type.caption.size,
    fontFamily: AuthUI.font.semibold,
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
  facturaRight: {
    alignItems: "flex-end",
    gap: SoftUI.space.sm,
  },
  glassAction: {
    width: 36,
    height: 36,
    borderRadius: SoftUI.radius.chip,
    backgroundColor: SoftUI.infoSoft,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.9)",
    alignItems: "center",
    justifyContent: "center",
  },
  facturaRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  facturaPeriodo: {
    color: SoftUI.text,
    fontSize: SoftUI.type.body.size,
    fontFamily: AuthUI.font.semibold,
  },
  facturaMeta: {
    color: SoftUI.textSecondary,
    fontSize: SoftUI.type.chip.size,
    fontFamily: AuthUI.font.regular,
  },
  facturaMonto: {
    color: SoftUI.text,
    fontSize: SoftUI.type.body.size,
    fontFamily: AuthUI.font.bold,
  },
  emptyPad: {
    padding: SoftUI.space.xl,
    alignItems: "center",
  },
  emptyText: {
    color: SoftUI.textSecondary,
    fontSize: SoftUI.type.caption.size + 1,
    fontFamily: AuthUI.font.regular,
  },
});
