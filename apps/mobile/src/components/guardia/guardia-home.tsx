import { useEffect, useState } from "react";
import { View, Text, ScrollView, StyleSheet, ActivityIndicator } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useQuery } from "convex/react";
import { api } from "@vekino/backend/api";
import type { Id } from "@vekino/backend/dataModel";
import { SoftHomeHeader } from "@/components/ui/soft-home-header";
import { GlassCard, GlassBadge } from "@/components/ui/glass";
import { Tap } from "@/components/ui/tap";
import { AuthUI } from "@/lib/auth-ui";
import { C } from "@/lib/theme";
import { SoftUI } from "@/lib/soft-ui";
import { useCondominio } from "@/context/condominio-context";
import {
  refrescarContextoOperativo,
  useRefrescoOperativo,
} from "@/hooks/use-contexto-operativo";
import { etiquetaHasta } from "@/lib/contexto-guardia";
import { SolicitudesCobertura } from "@/components/guardia/solicitudes-cobertura";
import { CerrarTurnoModal } from "@/components/guardia/cerrar-turno-modal";

type Ionicon = React.ComponentProps<typeof Ionicons>["name"];

/** YYYY-MM-DD en zona America/Bogota. */
function fechaHoyBogota() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function startOfTodayBogotaMs() {
  const hoy = fechaHoyBogota();
  // Medianoche Bogotá ≈ UTC-5 (sin DST). Suficiente para filtrar “de hoy”.
  return new Date(`${hoy}T05:00:00.000Z`).getTime();
}

/**
 * Home de portería: resumen del día (contadores + lo relevante).
 * Los módulos viven en la pestaña «Más».
 *
 * Arriba, siempre, dónde opera hoy y por qué: su portería de siempre o la que
 * cubre temporalmente, con la hora en que termina. El conjunto lo decidió el
 * servidor (`contextoOperativoGuardia`); aquí solo se dice.
 */
export function GuardiaHome({
  displayName,
  saludo,
  avatarUrl,
  condominioId,
}: {
  displayName: string;
  saludo: string;
  avatarUrl?: string | null;
  condominioId: Id<"condominios">;
}) {
  const router = useRouter();
  const hoy = fechaHoyBogota();
  const hoyStart = startOfTodayBogotaMs();

  /* `refresco`: el mismo número con el que se vuelve a pedir la sesión
   * cuando una cobertura empieza o termina. Quién entra lo decide el servidor. */
  const refresco = useRefrescoOperativo();
  const access = useQuery(
    api.guardia.home,
    refresco ? { condominioId, refresco } : { condominioId },
  );
  const visitantes = useQuery(api.guardia.listVisitantes, { condominioId });
  const turno = useQuery(api.guardia.turnoActivo, { condominioId });
  const paquetes = useQuery(api.guardia.listPaquetes, { condominioId });
  const reservasHoy = useQuery(api.guardia.listReservasDia, {
    condominioId,
    fecha: hoy,
  });
  const avisos = useQuery(api.guardia.listAvisos, { condominioId });
  const novedades = useQuery(api.guardia.listNovedadReportes, { condominioId });
  const condo = useQuery(api.condominios.get, { condominioId });

  const adentro = (visitantes ?? []).filter((v) => v.estado === "activo").length;
  const porAprobar = (visitantes ?? []).filter(
    (v) => v.estado === "esperando_aprobacion",
  ).length;
  const paquetesPend = (paquetes ?? []).filter((p) => p.estado === "recibido").length;
  const reservasCount = reservasHoy?.length ?? 0;

  const avisoDestacado = [...(avisos ?? [])]
    .sort(
      (a, b) =>
        Number(b.fijado) - Number(a.fijado) ||
        (b.prioridad === "urgente" ? 1 : 0) - (a.prioridad === "urgente" ? 1 : 0) ||
        b.createdAt - a.createdAt,
    )
    .slice(0, 1)[0];

  const novedadesHoy = (novedades ?? [])
    .filter((n) => n.createdAt >= hoyStart)
    .slice(0, 2);
  const novedadReciente =
    novedadesHoy[0] ??
    (novedades ?? []).slice(0, 1)[0];

  if (access === undefined) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={C.brand} size="large" />
      </View>
    );
  }

  if (!access.allowed) return <PorteriaNoDisponible />;

  return (
    <View style={{ flex: 1 }}>
      <SoftHomeHeader
        saludo={saludo}
        displayName={displayName}
        avatarUrl={avatarUrl}
        badgeLabel={condo?.name ?? "Portería"}
      />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        <AvisoDeContexto />
        <TurnoPendienteDeCierre />
        <SolicitudesCobertura />

        <View style={styles.greetingRow}>
          <GlassBadge
            label={turno ? "Turno abierto" : "Sin turno"}
            tone={turno ? "blue" : "neutral"}
          />
        </View>

        {!turno ? (
          <Tap onPress={() => router.push("/(app)/guardia/minuta" as never)}>
            <GlassCard style={styles.turnoCard}>
              <Ionicons name="play-circle-outline" size={28} color={AuthUI.text} />
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={styles.actionLabel}>Iniciar turno</Text>
                <Text style={styles.actionHint}>
                  Checklist de dotación para abrir la jornada.
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={AuthUI.textMuted} />
            </GlassCard>
          </Tap>
        ) : (
          <Tap onPress={() => router.push("/(app)/guardia/minuta" as never)}>
            <GlassCard style={styles.turnoOpenCard}>
              <View style={styles.liveDot} />
              <View style={{ flex: 1 }}>
                <Text style={styles.actionLabel}>
                  Turno de {turno.guardiaNombre}
                </Text>
                <Text style={styles.actionHint}>
                  {turno.rondasCount} ronda{turno.rondasCount === 1 ? "" : "s"} · Abrir minuta
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={AuthUI.textMuted} />
            </GlassCard>
          </Tap>
        )}

        <Text style={styles.sectionTitle}>Hoy en portería</Text>
        <View style={styles.kpiGrid}>
          <KpiTile
            icon="people-outline"
            label="Adentro"
            value={visitantes === undefined ? "…" : String(adentro)}
            hint={porAprobar > 0 ? `${porAprobar} por aprobar` : "Visitantes activos"}
            onPress={() =>
              router.push({
                pathname: "/(app)/guardia/visitantes",
                params: { tab: "actividad" },
              } as never)
            }
          />
          <KpiTile
            icon="cube-outline"
            label="Paquetería"
            value={paquetes === undefined ? "…" : String(paquetesPend)}
            hint="Por entregar"
            onPress={() => router.push("/(app)/guardia/paqueteria" as never)}
          />
          <KpiTile
            icon="calendar-outline"
            label="Reservas"
            value={reservasHoy === undefined ? "…" : String(reservasCount)}
            hint="Programadas hoy"
            onPress={() => router.push("/(app)/guardia/reservas" as never)}
          />
          <KpiTile
            icon="person-add-outline"
            label="Walk-in"
            value={visitantes === undefined ? "…" : String(porAprobar)}
            hint="Esperando aprobación"
            onPress={() =>
              router.push({
                pathname: "/(app)/guardia/visitantes",
                params: { tab: "actividad" },
              } as never)
            }
          />
        </View>

        <Text style={styles.sectionTitle}>Reservas de hoy</Text>
        {reservasHoy === undefined ? (
          <ActivityIndicator color={C.brand} style={{ marginVertical: 12 }} />
        ) : reservasHoy.length === 0 ? (
          <GlassCard style={styles.emptyCard}>
            <Text style={styles.emptyText}>No hay reservas aprobadas para hoy.</Text>
          </GlassCard>
        ) : (
          <View style={{ gap: 8, marginBottom: 8 }}>
            {reservasHoy.slice(0, 4).map((r) => (
              <Tap
                key={r._id}
                onPress={() => router.push("/(app)/guardia/reservas" as never)}
              >
                <GlassCard style={styles.listCard}>
                  <View style={styles.listIcon}>
                    <Ionicons name="calendar-outline" size={18} color={AuthUI.text} />
                  </View>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={styles.listTitle}>{r.zonaNombre}</Text>
                    <Text style={styles.listMeta}>
                      {r.horaInicio}–{r.horaFin} · Un. {r.unidadNumero} ·{" "}
                      {r.solicitanteNombre}
                    </Text>
                  </View>
                  <Ionicons name="chevron-forward" size={16} color={AuthUI.textMuted} />
                </GlassCard>
              </Tap>
            ))}
            {reservasHoy.length > 4 ? (
              <Tap onPress={() => router.push("/(app)/guardia/reservas" as never)}>
                <Text style={styles.seeAll}>
                  Ver las {reservasHoy.length} reservas →
                </Text>
              </Tap>
            ) : null}
          </View>
        )}

        <Text style={styles.sectionTitle}>Aviso</Text>
        {avisos === undefined ? (
          <ActivityIndicator color={C.brand} style={{ marginVertical: 12 }} />
        ) : !avisoDestacado ? (
          <GlassCard style={styles.emptyCard}>
            <Text style={styles.emptyText}>Sin avisos para seguridad.</Text>
          </GlassCard>
        ) : (
          <Tap onPress={() => router.push("/(app)/guardia/avisos" as never)}>
            <GlassCard style={styles.listCard}>
              <View style={styles.listIcon}>
                <Ionicons name="megaphone-outline" size={18} color={AuthUI.text} />
              </View>
              <View style={{ flex: 1, gap: 4 }}>
                <View style={styles.badgeRow}>
                  <Text style={styles.listTitle} numberOfLines={1}>
                    {avisoDestacado.titulo}
                  </Text>
                  {avisoDestacado.prioridad === "urgente" ? (
                    <GlassBadge label="Urgente" tone="red" />
                  ) : avisoDestacado.fijado ? (
                    <GlassBadge label="Fijado" tone="blue" />
                  ) : null}
                </View>
                <Text style={styles.listMeta} numberOfLines={2}>
                  {avisoDestacado.cuerpo}
                </Text>
              </View>
            </GlassCard>
          </Tap>
        )}

        <Text style={[styles.sectionTitle, { marginTop: 18 }]}>Novedades</Text>
        {novedades === undefined ? (
          <ActivityIndicator color={C.brand} style={{ marginVertical: 12 }} />
        ) : !novedadReciente ? (
          <GlassCard style={styles.emptyCard}>
            <Text style={styles.emptyText}>Sin novedades reportadas.</Text>
          </GlassCard>
        ) : (
          <View style={{ gap: 8 }}>
            {(novedadesHoy.length > 0 ? novedadesHoy : [novedadReciente]).map((n) => (
              <Tap
                key={n._id}
                onPress={() => router.push("/(app)/guardia/novedades" as never)}
              >
                <GlassCard style={styles.listCard}>
                  <View style={styles.listIcon}>
                    <Ionicons name="warning-outline" size={18} color={AuthUI.text} />
                  </View>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={styles.listTitle} numberOfLines={1}>
                      {n.titulo}
                    </Text>
                    <Text style={styles.listMeta} numberOfLines={2}>
                      {n.descripcion}
                    </Text>
                  </View>
                  <GlassBadge
                    label={n.prioridad}
                    tone={
                      n.prioridad === "alta"
                        ? "red"
                        : n.prioridad === "media"
                          ? "yellow"
                          : "neutral"
                    }
                  />
                </GlassCard>
              </Tap>
            ))}
          </View>
        )}

        <Text style={styles.footerHint}>
          Los módulos de portería están en la pestaña Más.
        </Text>
      </ScrollView>
    </View>
  );
}

/**
 * Dónde opera hoy. Con cobertura, el conjunto que cubre y hasta cuándo; sin
 * ella, su portería de siempre. Nada de la asignación permanente mientras
 * cubre: no le sirve para operar.
 */
function AvisoDeContexto() {
  const { contextoGuardia, condominioName } = useCondominio();
  const cobertura = contextoGuardia?.cobertura;

  if (cobertura) {
    return (
      <GlassCard style={{ ...styles.contextoCard, ...styles.contextoCobertura }}>
        <Ionicons name="swap-horizontal-outline" size={22} color={AuthUI.text} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={styles.actionHint}>Estás cubriendo temporalmente</Text>
          <Text style={styles.actionLabel}>{cobertura.condominioNombre}</Text>
          <Text style={styles.actionHint}>Hasta: {etiquetaHasta(cobertura.fin)}</Text>
        </View>
      </GlassCard>
    );
  }
  return (
    <GlassCard style={styles.contextoCard}>
      <Ionicons name="shield-checkmark-outline" size={22} color={AuthUI.text} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.actionHint}>Estás operando en</Text>
        <Text style={styles.actionLabel}>{condominioName ?? "tu portería"}</Text>
      </View>
    </GlassCard>
  );
}

/**
 * El turno que dejó abierto en su conjunto de siempre antes de empezar a
 * cubrir. Si el servidor lo devuelve, se puede cerrar desde aquí: la
 * portería de ese conjunto ya no se le abre. Qué turno vale lo decide el
 * servidor (`guardia.turnoPendienteDeCierre`); aquí no se mira ninguna fecha.
 */
function TurnoPendienteDeCierre() {
  const { contextoGuardia } = useCondominio();
  const refresco = useRefrescoOperativo();
  const pendiente = useQuery(
    api.guardia.turnoPendienteDeCierre,
    contextoGuardia?.tipo === "cobertura" ? (refresco ? { refresco } : {}) : "skip",
  );
  const [cerrando, setCerrando] = useState(false);
  if (!pendiente) return null;

  return (
    <>
      <Tap onPress={() => setCerrando(true)}>
        <GlassCard style={{ ...styles.contextoCard, ...styles.pendienteCard }}>
          <Ionicons name="stop-circle-outline" size={22} color="#DC2626" />
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={styles.actionLabel}>
              Finalizar turno pendiente en {pendiente.condominioNombre}
            </Text>
            <Text style={styles.actionHint}>
              Quedó abierto desde el {etiquetaHasta(pendiente.turno.fechaInicio)}.
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={AuthUI.textMuted} />
        </GlassCard>
      </Tap>
      {cerrando ? (
        <CerrarTurnoModal
          turno={pendiente.turno}
          condominioNombre={pendiente.condominioNombre}
          onClose={() => setCerrando(false)}
        />
      ) : null}
    </>
  );
}

/**
 * El servidor dice que esta portería ya no es suya (la cobertura empezó o
 * terminó, la inhabilitaron, cayó su contrato) antes de que la sesión lo
 * supiera. No es un error que haya que dejar en pantalla: se vuelve a pedir
 * el contexto y la app pasa sola a la portería que vale.
 */
function PorteriaNoDisponible() {
  useEffect(() => {
    refrescarContextoOperativo();
  }, []);
  return (
    <SafeAreaView style={{ flex: 1, padding: 24, gap: 12 }} edges={["top"]}>
      <Text style={styles.deniedTitle}>Actualizando tu portería…</Text>
      <Text style={styles.deniedBody}>
        Esta portería ya no está disponible para ti. En un momento verás la que
        te corresponde.
      </Text>
      <Tap onPress={refrescarContextoOperativo}>
        <Text style={styles.seeAll}>Reintentar</Text>
      </Tap>
    </SafeAreaView>
  );
}

function KpiTile({
  icon,
  label,
  value,
  hint,
  onPress,
}: {
  icon: Ionicon;
  label: string;
  value: string;
  hint: string;
  onPress: () => void;
}) {
  return (
    <Tap onPress={onPress} style={styles.kpiTap}>
      <GlassCard style={styles.kpiCard}>
        <Ionicons name={icon} size={18} color={AuthUI.textMuted} />
        <Text style={styles.kpiValue}>{value}</Text>
        <Text style={styles.kpiLabel}>{label}</Text>
        <Text style={styles.kpiHint} numberOfLines={1}>
          {hint}
        </Text>
      </GlassCard>
    </Tap>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingHorizontal: SoftUI.padH, paddingBottom: 140 },
  greetingRow: {
    marginTop: SoftUI.space.sm,
    marginBottom: SoftUI.space.base,
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: SoftUI.space.sm,
  },
  greeting: {
    fontSize: SoftUI.type.section.size - 1,
    fontFamily: AuthUI.font.medium,
    color: SoftUI.textSecondary,
  },
  greetingName: {
    fontSize: SoftUI.type.section.size - 1,
    fontFamily: AuthUI.font.semibold,
    color: SoftUI.text,
  },
  turnoCard: {
    padding: SoftUI.space.base,
    flexDirection: "row",
    alignItems: "center",
    gap: SoftUI.space.md,
    marginBottom: SoftUI.space.lg,
    borderWidth: 0,
    backgroundColor: SoftUI.successSoft,
  },
  contextoCard: {
    padding: SoftUI.space.base,
    flexDirection: "row",
    alignItems: "center",
    gap: SoftUI.space.md,
    marginTop: SoftUI.space.sm,
    marginBottom: SoftUI.space.md,
  },
  contextoCobertura: { backgroundColor: SoftUI.infoSoft, borderWidth: 0 },
  pendienteCard: { backgroundColor: SoftUI.dangerSoft, borderWidth: 0 },
  turnoOpenCard: {
    padding: SoftUI.space.base,
    flexDirection: "row",
    alignItems: "center",
    gap: SoftUI.space.md,
    marginBottom: SoftUI.space.lg,
  },
  liveDot: {
    width: 10,
    height: 10,
    borderRadius: SoftUI.radius.chip,
    backgroundColor: SoftUI.success,
  },
  sectionTitle: {
    fontSize: SoftUI.type.section.size - 3,
    fontFamily: AuthUI.font.semibold,
    color: SoftUI.text,
    marginBottom: SoftUI.space.md,
    marginTop: SoftUI.space.xs,
  },
  kpiGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: SoftUI.space.md,
    marginBottom: SoftUI.space.lg,
  },
  kpiTap: { width: "47.5%" },
  kpiCard: {
    padding: SoftUI.space.base,
    gap: SoftUI.space.xs,
    minHeight: 112,
  },
  kpiValue: {
    fontSize: SoftUI.type.hero.size,
    fontFamily: AuthUI.font.semibold,
    color: SoftUI.text,
    marginTop: SoftUI.space.xs,
  },
  kpiLabel: {
    fontSize: SoftUI.type.caption.size + 1,
    fontFamily: AuthUI.font.semibold,
    color: SoftUI.text,
  },
  kpiHint: {
    fontSize: SoftUI.type.chip.size - 1,
    color: SoftUI.textSecondary,
    fontFamily: AuthUI.font.regular,
  },
  listCard: {
    padding: SoftUI.space.md,
    flexDirection: "row",
    alignItems: "center",
    gap: SoftUI.space.md,
  },
  listIcon: {
    width: 40,
    height: 40,
    borderRadius: SoftUI.radius.chip,
    backgroundColor: SoftUI.infoSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  listTitle: {
    fontSize: SoftUI.type.caption.size + 1,
    fontFamily: AuthUI.font.semibold,
    color: SoftUI.text,
  },
  listMeta: {
    fontSize: SoftUI.type.chip.size,
    color: SoftUI.textSecondary,
    lineHeight: SoftUI.type.caption.line,
  },
  badgeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  emptyCard: { padding: 16, marginBottom: 4 },
  emptyText: {
    fontSize: 13,
    color: AuthUI.textMuted,
    textAlign: "center",
  },
  seeAll: {
    fontSize: 13,
    color: C.brand,
    fontFamily: AuthUI.font.medium,
    textAlign: "right",
    marginTop: 2,
  },
  actionLabel: {
    fontSize: 15,
    fontFamily: AuthUI.font.semibold,
    color: AuthUI.text,
  },
  actionHint: {
    fontSize: 12,
    color: AuthUI.textMuted,
    fontFamily: AuthUI.font.regular,
  },
  footerHint: {
    marginTop: 22,
    marginBottom: 8,
    textAlign: "center",
    fontSize: 12,
    color: AuthUI.textMuted,
  },
  deniedTitle: {
    fontSize: 18,
    fontFamily: AuthUI.font.semibold,
    color: AuthUI.text,
    marginBottom: 8,
  },
  deniedBody: {
    fontSize: 14,
    color: AuthUI.textMuted,
  },
});
