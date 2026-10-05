import { ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SoftHomeHeader } from "@/components/ui/soft-home-header";
import { GlassCard } from "@/components/ui/glass";
import { SolicitudesCobertura } from "@/components/guardia/solicitudes-cobertura";
import type { EstadoGuardia } from "@/lib/contexto-guardia";
import { AuthUI } from "@/lib/auth-ui";
import { SoftUI } from "@/lib/soft-ui";

/**
 * El inicio del guarda de compañía que hoy no tiene portería que abrir.
 *
 * No es "no tienes cuenta" ni "no perteneces a nada": tiene sesión y es de una
 * compañía, pero el servidor no le da hoy ninguna vía de guarda —ni
 * asignación ni cobertura— o tiene el contexto bloqueado. No se le inventa un
 * conjunto: se le dice qué pasa y se le dejan responder sus solicitudes de
 * cobertura, que es lo único que puede hacer como guarda.
 */
export function SinPorteria({
  estado,
  saludo,
  displayName,
  avatarUrl,
}: {
  estado: Exclude<EstadoGuardia, null>;
  saludo: string;
  displayName: string;
  avatarUrl?: string | null;
}) {
  return (
    <View style={{ flex: 1 }}>
      <SoftHomeHeader
        saludo={saludo}
        displayName={displayName}
        avatarUrl={avatarUrl}
        badgeLabel="Portería"
      />
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <AvisoEstadoGuardia estado={estado} />
        <SolicitudesCobertura />
      </ScrollView>
    </View>
  );
}

/**
 * Por qué no hay portería, en una tarjeta. Sale también en el inicio de quien
 * además es residente de otro conjunto: el bloqueo se le dice igual, aunque
 * tenga su casa para mirar.
 */
export function AvisoEstadoGuardia({ estado }: { estado: Exclude<EstadoGuardia, null> }) {
  const bloqueado = estado === "bloqueado";
  return (
    <GlassCard style={bloqueado ? { ...styles.card, ...styles.bloqueado } : styles.card}>
      <Ionicons
        name={bloqueado ? "alert-circle-outline" : "shield-outline"}
        size={32}
        color={bloqueado ? SoftUI.danger : AuthUI.textMuted}
      />
      <Text style={styles.title}>
        {bloqueado ? "Operación como guarda en pausa" : "Hoy no tienes una portería asignada"}
      </Text>
      <Text style={styles.body}>
        {bloqueado
          ? "Tienes más de una cobertura activa a la vez. Hasta que tu compañía lo corrija no puedes operar ninguna portería."
          : "Cuando tengas una asignación o una cobertura activa, tu portería aparecerá aquí sola."}
      </Text>
    </GlassCard>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingHorizontal: SoftUI.padH, paddingTop: SoftUI.space.base, paddingBottom: 140 },
  card: {
    padding: SoftUI.space.xl,
    alignItems: "center",
    gap: 10,
    marginBottom: SoftUI.space.lg,
  },
  bloqueado: { backgroundColor: SoftUI.dangerSoft, borderWidth: 0 },
  title: {
    fontSize: 17,
    fontFamily: AuthUI.font.semibold,
    color: AuthUI.text,
    textAlign: "center",
  },
  body: { fontSize: 14, color: AuthUI.textMuted, textAlign: "center", lineHeight: 20 },
});
