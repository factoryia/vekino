import { useState } from "react";
import {
  View,
  Text,
  ScrollView,
  ActivityIndicator,
  Alert,
  Image,
  StyleSheet,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useQuery, useMutation, useAction, Authenticated } from "convex/react";
import { api } from "@vekino/backend/api";
import * as ImagePicker from "expo-image-picker";
import {
  ScreenBackground,
  GlassBadge,
  GlassCard,
  GlassButton,
  GlassInput,
} from "@/components/ui/glass";
import { BottomSheet } from "@/components/ui/bottom-sheet";
import { Tap } from "@/components/ui/tap";
import { useCondominio } from "@/context/condominio-context";
import { initials } from "@/lib/utils";
import { authClient } from "@/lib/auth-client";
import { AuthUI } from "@/lib/auth-ui";
import { SoftUI } from "@/lib/soft-ui";
import type { Id } from "@vekino/backend/dataModel";
import { uploadLocalFile } from "@/lib/guardia-upload";
import { themeFromPrimary } from "@/lib/condo-theme";
import { evaluarPassword } from "@vekino/backend/passwordFuerte";

/** Color de la barra de seguridad por puntaje (0 a 4). */
const COLOR_FUERZA = [
  SoftUI.danger,
  SoftUI.danger,
  SoftUI.warning,
  SoftUI.success,
  SoftUI.success,
];

const ROL_LABEL: Record<string, string> = {
  administrador: "Administrador",
  junta_directiva: "Junta directiva",
  contadora: "Contadora",
  guardia: "Guardia",
  propietario: "Propietario",
  arrendatario: "Arrendatario",
  residente: "Residente",
};

const ROL_TONE: Record<string, "orange" | "blue" | "green" | "neutral"> = {
  administrador: "orange",
  junta_directiva: "blue",
  contadora: "green",
  guardia: "neutral",
  propietario: "blue",
  arrendatario: "neutral",
  residente: "neutral",
};

export default function PerfilScreen() {
  return (
    <View style={{ flex: 1 }}>
      <ScreenBackground>
        <Authenticated>
          <PerfilContent />
        </Authenticated>
      </ScreenBackground>
    </View>
  );
}

function PerfilContent() {
  const router = useRouter();
  const me = useQuery(api.users.me);
  const pushStatus = useQuery(api.notifications.myStatus);
  const { condominioId, selectCondominio, theme, opciones, isSuperadmin } = useCondominio();
  /* Los conjuntos que se pueden abrir los da la sesión, no las membresías
   * crudas: con una cobertura activa la portería de siempre no se ofrece, y
   * la de un guarda de compañía (que no tiene membresía) sí. El superadmin
   * conserva su lista de siempre. */
  const condominios = isSuperadmin
    ? me?.memberships.map((m) => ({
        condominioId: m.condominioId as string,
        nombre: m.condominioName,
        logo: m.condominioLogo,
        color: m.condominioPrimaryColor,
        roles: m.roles,
        guardiaPor: null,
      })) ?? []
    : opciones;
  const generateUploadUrl = useAction(api.files.generateUploadUrl);
  const setMyAvatar = useMutation(api.users.setMyAvatar);
  const clearMyAvatar = useMutation(api.users.clearMyAvatar);
  const deleteMyAccount = useAction(api.users.deleteMyAccount);
  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [editando, setEditando] = useState(false);
  const [cambiandoClave, setCambiandoClave] = useState(false);

  async function signOut() {
    Alert.alert("Cerrar sesión", "¿Seguro que quieres salir?", [
      { text: "Cancelar", style: "cancel" },
      {
        text: "Salir",
        style: "destructive",
        onPress: async () => {
          await authClient.signOut();
          router.replace("/(auth)/login" as never);
        },
      },
    ]);
  }

  async function runDelete() {
    if (deleting) return;
    setDeleting(true);
    try {
      await deleteMyAccount({});
      await authClient.signOut().catch(() => {});
      router.replace("/(auth)/login" as never);
    } catch (e) {
      setDeleting(false);
      Alert.alert(
        "No se pudo eliminar",
        e instanceof Error
          ? e.message
          : "Ocurrió un error al eliminar tu cuenta. Intenta de nuevo.",
      );
    }
  }

  function deleteAccount() {
    // Doble confirmación: Apple exige que el borrado sea intencional pero real.
    Alert.alert(
      "Eliminar cuenta",
      "Tu cuenta se eliminará de forma permanente y no podrás volver a iniciar " +
        "sesión. Se borrarán tus datos personales (nombre, correo, teléfono, " +
        "documento y foto). La administración conserva el historial de cobros de " +
        "tu inmueble por obligación contable. Esta acción no se puede deshacer.",
      [
        { text: "Cancelar", style: "cancel" },
        {
          text: "Eliminar cuenta",
          style: "destructive",
          onPress: () => {
            Alert.alert(
              "¿Confirmar eliminación?",
              "Tu cuenta se eliminará de forma permanente y no podrás iniciar sesión de nuevo.",
              [
                { text: "Cancelar", style: "cancel" },
                {
                  text: "Sí, eliminar",
                  style: "destructive",
                  onPress: () => void runDelete(),
                },
              ],
            );
          },
        },
      ],
    );
  }

  async function pickAvatar() {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert(
        "Permiso necesario",
        "Activa el acceso a fotos para cambiar tu avatar.",
      );
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.7,
    });
    if (result.canceled || !result.assets[0]) return;

    const asset = result.assets[0];
    setUploading(true);
    try {
      const { url, key } = await uploadLocalFile(
        generateUploadUrl,
        asset.uri,
        asset.mimeType ?? "image/jpeg",
        "avatars",
        asset.fileName ?? "avatar.jpg",
      );
      await setMyAvatar({ url, s3Key: key });
    } catch (e) {
      Alert.alert(
        "No se pudo subir",
        e instanceof Error ? e.message : "Intenta de nuevo.",
      );
    } finally {
      setUploading(false);
    }
  }

  function onAvatarPress() {
    const options: {
      text: string;
      style?: "cancel" | "destructive";
      onPress?: () => void;
    }[] = [{ text: "Elegir foto", onPress: () => void pickAvatar() }];
    if (me?.image) {
      options.push({
        text: "Quitar foto",
        style: "destructive",
        onPress: () => void clearMyAvatar({}),
      });
    }
    options.push({ text: "Cancelar", style: "cancel" });
    Alert.alert("Avatar", "¿Qué quieres hacer?", options);
  }

  if (!me) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={theme.accent} size="large" />
      </View>
    );
  }

  const firstName = me.firstName ?? me.name.split(" ")[0] ?? me.name;
  const lastName = me.lastName ?? me.name.split(" ").slice(1).join(" ") ?? "";

  return (
    <SafeAreaView style={{ flex: 1 }} edges={["top"]}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        <GlassCard style={styles.profileCard}>
        <View
          onTouchEnd={() => {
            if (uploading) return;
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            onAvatarPress();
          }}
          style={{ alignItems: "center" }}
        >
          <View
            style={[
              styles.avatarRing,
              { backgroundColor: theme.accentSoft },
            ]}
          >
            {uploading ? (
              <ActivityIndicator color={theme.accent} />
            ) : me.image ? (
              <Image
                source={{ uri: me.image }}
                style={styles.avatarImg}
                resizeMode="cover"
              />
            ) : (
              <Text style={[styles.avatarInitials, { color: theme.accent }]}>
                {initials(me.name)}
              </Text>
            )}
          </View>
          <View style={[styles.cameraBadge, { backgroundColor: theme.accent }]}>
            <Ionicons name="camera" size={14} color={SoftUI.white} />
          </View>
          <Text style={styles.avatarHint}>Toca para cambiar foto</Text>
        </View>

        <Text style={styles.name}>
          {[firstName, lastName].filter(Boolean).join(" ")}
        </Text>
        <Text style={styles.email}>{me.email}</Text>
        {me.telefono ? <Text style={styles.phone}>{me.telefono}</Text> : null}
        {me.isSuperadmin ? (
          <View style={{ marginTop: SoftUI.space.md }}>
            <GlassBadge label="Superadmin" tone="orange" />
          </View>
        ) : null}
        <View
          style={{
            flexDirection: "row",
            gap: SoftUI.space.sm,
            marginTop: SoftUI.space.md,
          }}
        >
          <GlassButton
            label="Editar datos"
            variant="secondary"
            size="sm"
            icon={<Ionicons name="create-outline" size={16} color={theme.accent} />}
            onPress={() => setEditando(true)}
            style={{ width: "auto" }}
          />
          <GlassButton
            label="Contraseña"
            variant="secondary"
            size="sm"
            icon={<Ionicons name="key-outline" size={16} color={theme.accent} />}
            onPress={() => setCambiandoClave(true)}
            style={{ width: "auto" }}
          />
        </View>
      </GlassCard>

      {/* Mientras siga con la clave que le enviaron, se lo recordamos. */}
      {me.claveTemporal ? (
        <Tap onPress={() => setCambiandoClave(true)}>
          <GlassCard style={styles.avisoClave}>
            <Ionicons name="shield-half-outline" size={22} color={SoftUI.danger} />
            <View style={{ flex: 1, gap: 2, minWidth: 0 }}>
              <Text style={styles.avisoClaveTitulo}>
                Estás usando una clave temporal
              </Text>
              <Text style={styles.avisoClaveSub}>
                Es la que te envió la administración. Cámbiala para que sea solo
                tuya.
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={SoftUI.textDisabled} />
          </GlassCard>
        </Tap>
      ) : null}

      <CambiarPasswordSheet
        key={cambiandoClave ? "clave-abierta" : "clave-cerrada"}
        visible={cambiandoClave}
        onClose={() => setCambiandoClave(false)}
        email={me.email}
        nombre={me.name}
      />

      <EditarPerfilSheet
        // Remonta al abrir para que los campos partan de los datos actuales.
        key={editando ? "abierto" : "cerrado"}
        visible={editando}
        onClose={() => setEditando(false)}
        inicial={{
          firstName: me.firstName ?? "",
          lastName: me.lastName ?? "",
          telefono: me.telefono ?? "",
        }}
      />

      {condominios.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Mis condominios</Text>
          <View style={styles.listGap}>
            {condominios.map((m) => {
              const condoTheme = m.color ? themeFromPrimary(m.color) : theme;
              const active = m.condominioId === condominioId;
              /* El rol de guarda sale de la sesión: dónde opera hoy. */
              const etiquetas = [
                ...m.roles.map((r) => ({ key: r, label: ROL_LABEL[r] ?? r, tone: ROL_TONE[r] ?? "neutral" })),
                ...(m.guardiaPor === "cobertura"
                  ? [{ key: "cobertura", label: "Cobertura", tone: "orange" as const }]
                  : m.guardiaPor
                    ? [{ key: "guardia", label: ROL_LABEL.guardia!, tone: ROL_TONE.guardia! }]
                    : []),
              ];
              return (
                <Tap
                  key={m.condominioId}
                  onPress={() => {
                    if (!m.condominioId || !m.nombre) return;
                    selectCondominio(m.condominioId as Id<"condominios">, m.nombre);
                  }}
                >
                  <GlassCard style={styles.condoRow}>
                    {m.logo ? (
                      <Image
                        source={{ uri: m.logo }}
                        style={styles.condoLogo}
                        resizeMode="cover"
                      />
                    ) : (
                      <View
                        style={[
                          styles.condoLogoFallback,
                          { backgroundColor: condoTheme.accentSoft },
                        ]}
                      >
                        <Text
                          style={[
                            styles.condoInitials,
                            { color: condoTheme.accent },
                          ]}
                        >
                          {initials(m.nombre ?? "?")}
                        </Text>
                      </View>
                    )}
                    <View style={styles.rowBody}>
                      <Text style={styles.condoName} numberOfLines={1}>
                        {m.nombre}
                      </Text>
                      {/* Antes salía "{subdomain}.vekino.app": un dominio que
                          no existe. `subdomain` es un identificador interno
                          (mapea el convenio de Aval), no un host publicado. */}
                      <View style={styles.badgeRow}>
                        {etiquetas.map((e) => (
                          <GlassBadge key={e.key} label={e.label} tone={e.tone} />
                        ))}
                      </View>
                    </View>
                    {active ? (
                      <Ionicons
                        name="checkmark-circle"
                        size={20}
                        color={condoTheme.accent}
                      />
                    ) : (
                      <Ionicons
                        name="ellipse-outline"
                        size={20}
                        color={SoftUI.textDisabled}
                      />
                    )}
                  </GlassCard>
                </Tap>
              );
            })}
          </View>
        </View>
      )}

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>Información</Text>
        <GlassCard style={styles.infoCard}>
          {(
            [
              {
                icon: "shield-checkmark-outline" as const,
                label: "Privacidad",
                subtitle: "Cómo usamos tus datos",
                route: "/(app)/privacidad",
              },
              {
                icon: "notifications-outline" as const,
                label: "Notificaciones",
                subtitle:
                  pushStatus === undefined
                    ? "Cargando…"
                    : pushStatus.enabled
                      ? "Activas"
                      : "Inactivas",
                route: "/(app)/notificaciones",
              },
              {
                icon: "help-circle-outline" as const,
                label: "Soporte",
                subtitle: "Pedir ayuda a admin y Vekino",
                route: "/(app)/soporte",
              },
            ] as const
          ).map((item, i, arr) => (
            <Tap
              key={item.label}
              style={[styles.infoRow, i < arr.length - 1 && styles.infoBorder]}
              onPress={() => router.push(item.route as never)}
            >
              <View style={[styles.infoIcon, { backgroundColor: theme.accentSoft }]}>
                <Ionicons name={item.icon} size={18} color={theme.accent} />
              </View>
              <View style={styles.rowBody}>
                <Text style={styles.infoLabel}>{item.label}</Text>
                <Text style={styles.infoSub}>{item.subtitle}</Text>
              </View>
              <View style={[styles.chevron, { backgroundColor: theme.accentSoft }]}>
                <Ionicons
                  name="chevron-forward"
                  size={16}
                  color={theme.accent}
                />
              </View>
            </Tap>
          ))}
        </GlassCard>
      </View>

        <Text style={styles.version}>Vekino v1.0 · Powered by Zyntek</Text>

        <View
          style={styles.signOut}
          onTouchEnd={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            signOut();
          }}
        >
          <Ionicons name="log-out-outline" size={18} color={SoftUI.danger} />
          <Text style={styles.signOutText}>Cerrar sesión</Text>
        </View>

        <View
          style={styles.deleteAccount}
          onTouchEnd={() => {
            if (deleting) return;
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            deleteAccount();
          }}
        >
          {deleting ? (
            <ActivityIndicator color={SoftUI.textSecondary} size="small" />
          ) : (
            <>
              <Ionicons name="trash-outline" size={16} color={SoftUI.textSecondary} />
              <Text style={styles.deleteAccountText}>Eliminar cuenta</Text>
            </>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

/**
 * Cambio de contraseña. Reusa `users.cambiarMiPassword`, que además apaga la
 * bandera `claveTemporal`: a partir de ahí la clave es del usuario y deja de
 * salir el aviso.
 */
function CambiarPasswordSheet({
  visible,
  onClose,
  email,
  nombre,
}: {
  visible: boolean;
  onClose: () => void;
  email?: string;
  nombre?: string;
}) {
  const cambiar = useAction(api.users.cambiarMiPassword);
  const [actual, setActual] = useState("");
  const [nueva, setNueva] = useState("");
  const [repetir, setRepetir] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Un solo interruptor para los tres campos: escribir una clave a ciegas y
  // repetirla es la causa más común de "no coinciden".
  const [verClaves, setVerClaves] = useState(false);

  // Misma función que valida el backend: las pistas coinciden con lo que
  // realmente va a aceptar al guardar.
  const fuerza = evaluarPassword(nueva, { email, nombre });

  const ojo = (
    <Tap onPress={() => setVerClaves((v) => !v)} haptic={false}>
      <Ionicons
        name={verClaves ? "eye-off-outline" : "eye-outline"}
        size={20}
        color={SoftUI.textSecondary}
      />
    </Tap>
  );

  async function guardar() {
    if (!fuerza.ok) {
      setError(fuerza.problemas[0]!);
      return;
    }
    if (nueva !== repetir) {
      setError("Las contraseñas nuevas no coinciden.");
      return;
    }
    setGuardando(true);
    setError(null);
    try {
      await cambiar({ actual, nueva });
      Alert.alert("Listo", "Tu contraseña quedó actualizada.");
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo cambiar.");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <BottomSheet visible={visible} onClose={onClose} maxHeight="88%">
      <ScrollView
        bounces={false}
        contentContainerStyle={styles.editScroll}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.editTitle}>Cambiar contraseña</Text>

        <GlassInput
          label="Contraseña actual"
          value={actual}
          onChangeText={setActual}
          placeholder="La que usas hoy"
          secureTextEntry={!verClaves}
          autoCapitalize="none"
          autoCorrect={false}
          rightAction={ojo}
        />
        <GlassInput
          label="Nueva contraseña"
          value={nueva}
          onChangeText={setNueva}
          placeholder="Mínimo 8 caracteres"
          secureTextEntry={!verClaves}
          autoCapitalize="none"
          autoCorrect={false}
          rightAction={ojo}
        />

        {nueva.length > 0 ? (
          <View style={{ gap: 6 }}>
            <View style={styles.barraFondo}>
              <View
                style={[
                  styles.barraLlena,
                  {
                    width: `${(fuerza.puntaje / 4) * 100}%`,
                    backgroundColor: COLOR_FUERZA[fuerza.puntaje] ?? SoftUI.danger,
                  },
                ]}
              />
            </View>
            <Text
              style={[
                styles.fuerzaTexto,
                { color: COLOR_FUERZA[fuerza.puntaje] ?? SoftUI.danger },
              ]}
            >
              Seguridad: {fuerza.etiqueta}
            </Text>
            {fuerza.problemas.map((p) => (
              <Text key={p} style={styles.fuerzaPista}>
                • {p}
              </Text>
            ))}
          </View>
        ) : null}
        <GlassInput
          label="Repite la nueva"
          value={repetir}
          onChangeText={setRepetir}
          placeholder="Escríbela otra vez"
          secureTextEntry={!verClaves}
          autoCapitalize="none"
          autoCorrect={false}
          rightAction={ojo}
        />

        {error ? <Text style={styles.editError}>{error}</Text> : null}

        <View style={{ gap: SoftUI.space.sm, marginTop: SoftUI.space.sm }}>
          <GlassButton
            label="Cambiar contraseña"
            loading={guardando}
            onPress={guardando ? undefined : guardar}
          />
          <GlassButton label="Cancelar" variant="secondary" onPress={onClose} />
        </View>
      </ScrollView>
    </BottomSheet>
  );
}

/**
 * Edición de los datos propios. Mismos campos que el portal web
 * (`/mi/[id]/perfil`) porque comparten la mutation `users.updateMyProfile`.
 *
 * El correo no se edita aquí: es la credencial de acceso y cambiarlo pasa por
 * la administración. El teléfono sí, y ojo que importa más de lo que parece:
 * es por donde el bot de WhatsApp reconoce a la persona.
 */
function EditarPerfilSheet({
  visible,
  onClose,
  inicial,
}: {
  visible: boolean;
  onClose: () => void;
  inicial: { firstName: string; lastName: string; telefono: string };
}) {
  const actualizar = useMutation(api.users.updateMyProfile);
  const [firstName, setFirstName] = useState(inicial.firstName);
  const [lastName, setLastName] = useState(inicial.lastName);
  const [telefono, setTelefono] = useState(inicial.telefono);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function guardar() {
    if (!firstName.trim()) {
      setError("El nombre es obligatorio.");
      return;
    }
    setGuardando(true);
    setError(null);
    try {
      await actualizar({
        firstName: firstName.trim(),
        lastName: lastName.trim() || undefined,
        telefono: telefono.trim() || undefined,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo guardar.");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <BottomSheet visible={visible} onClose={onClose} maxHeight="88%">
      <ScrollView
        bounces={false}
        contentContainerStyle={styles.editScroll}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.editTitle}>Editar datos</Text>

        <GlassInput
          label="Nombre"
          value={firstName}
          onChangeText={setFirstName}
          placeholder="Tu nombre"
          autoCapitalize="words"
        />
        <GlassInput
          label="Apellidos"
          value={lastName}
          onChangeText={setLastName}
          placeholder="Tus apellidos"
          autoCapitalize="words"
        />
        <GlassInput
          label="Teléfono"
          value={telefono}
          onChangeText={setTelefono}
          placeholder="Ej: 300 123 4567"
          keyboardType="phone-pad"
        />

        {error ? <Text style={styles.editError}>{error}</Text> : null}

        <View style={{ gap: SoftUI.space.sm, marginTop: SoftUI.space.sm }}>
          <GlassButton
            label="Guardar cambios"
            loading={guardando}
            onPress={guardando ? undefined : guardar}
          />
          <GlassButton label="Cancelar" variant="secondary" onPress={onClose} />
        </View>
      </ScrollView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  editScroll: {
    paddingHorizontal: SoftUI.padH,
    paddingTop: SoftUI.space.xs,
    paddingBottom: SoftUI.space.base,
    gap: SoftUI.space.md,
  },
  editTitle: {
    color: SoftUI.text,
    fontSize: SoftUI.type.hero.size - 4,
    fontFamily: AuthUI.font.bold,
    marginBottom: SoftUI.space.xs,
  },
  editError: {
    color: SoftUI.danger,
    fontSize: 13,
    fontFamily: AuthUI.font.regular,
  },
  barraFondo: {
    height: 6,
    borderRadius: 3,
    backgroundColor: SoftUI.bgSecondary,
    overflow: "hidden",
  },
  barraLlena: {
    height: "100%",
    borderRadius: 3,
  },
  fuerzaTexto: {
    fontSize: 12,
    fontFamily: AuthUI.font.semibold,
  },
  fuerzaPista: {
    color: SoftUI.textSecondary,
    fontSize: 12,
    lineHeight: 17,
    fontFamily: AuthUI.font.regular,
  },
  avisoClave: {
    marginTop: SoftUI.space.base,
    padding: SoftUI.space.base,
    flexDirection: "row",
    alignItems: "center",
    gap: SoftUI.space.md,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: SoftUI.dangerSoft,
  },
  avisoClaveTitulo: {
    color: SoftUI.text,
    fontSize: SoftUI.type.body.size - 1,
    fontFamily: AuthUI.font.semibold,
  },
  avisoClaveSub: {
    color: SoftUI.textSecondary,
    fontSize: SoftUI.type.chip.size,
    lineHeight: SoftUI.type.chip.size + 5,
    fontFamily: AuthUI.font.regular,
  },
  loading: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  scroll: {
    paddingBottom: 150,
    paddingHorizontal: SoftUI.padH,
    paddingTop: SoftUI.space.md,
  },
  profileCard: {
    paddingVertical: SoftUI.space.xl,
    paddingHorizontal: SoftUI.space.lg,
    alignItems: "center",
    marginBottom: SoftUI.space.xl,
  },
  avatarRing: {
    width: 88,
    height: 88,
    borderRadius: SoftUI.radius.chip,
    backgroundColor: SoftUI.infoSoft,
    borderWidth: 2,
    borderColor: SoftUI.white,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  avatarImg: {
    width: "100%",
    height: "100%",
  },
  avatarInitials: {
    color: SoftUI.blue,
    fontSize: 28,
    fontFamily: AuthUI.font.semibold,
  },
  cameraBadge: {
    marginTop: -12,
    backgroundColor: SoftUI.blue,
    width: 28,
    height: 28,
    borderRadius: SoftUI.radius.chip,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: SoftUI.white,
  },
  avatarHint: {
    color: SoftUI.textSecondary,
    fontSize: SoftUI.type.chip.size,
    fontFamily: AuthUI.font.regular,
    marginTop: SoftUI.space.sm,
  },
  name: {
    color: SoftUI.text,
    fontSize: SoftUI.type.section.size,
    fontFamily: AuthUI.font.bold,
    marginTop: SoftUI.space.md,
    textAlign: "center",
  },
  email: {
    color: SoftUI.textSecondary,
    fontSize: SoftUI.type.caption.size + 1,
    fontFamily: AuthUI.font.regular,
    marginTop: SoftUI.space.xs,
  },
  phone: {
    color: SoftUI.textDisabled,
    fontSize: SoftUI.type.caption.size,
    fontFamily: AuthUI.font.regular,
    marginTop: 2,
  },
  section: {
    marginBottom: SoftUI.space.xl,
  },
  sectionLabel: {
    color: SoftUI.text,
    fontSize: SoftUI.type.section.size - 2,
    fontFamily: AuthUI.font.semibold,
    marginBottom: SoftUI.space.md,
  },
  listGap: {
    gap: SoftUI.space.md,
  },
  condoRow: {
    flexDirection: "row",
    alignItems: "center",
    padding: SoftUI.space.base,
    gap: SoftUI.space.md,
  },
  condoLogo: {
    width: SoftUI.iconBtn,
    height: SoftUI.iconBtn,
    borderRadius: SoftUI.radius.icon,
    backgroundColor: SoftUI.bgSecondary,
  },
  condoLogoFallback: {
    width: SoftUI.iconBtn,
    height: SoftUI.iconBtn,
    borderRadius: SoftUI.radius.chip,
    alignItems: "center",
    justifyContent: "center",
  },
  condoInitials: {
    fontSize: SoftUI.type.caption.size + 1,
    fontFamily: AuthUI.font.bold,
  },
  rowBody: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  condoName: {
    color: SoftUI.text,
    fontSize: SoftUI.type.body.size,
    fontFamily: AuthUI.font.semibold,
  },
  badgeRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    marginTop: SoftUI.space.sm,
    gap: SoftUI.space.sm,
  },
  infoCard: {
    paddingVertical: SoftUI.space.xs,
    overflow: "hidden",
  },
  infoRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: SoftUI.space.base,
    paddingVertical: SoftUI.space.md,
    width: "100%",
    gap: SoftUI.space.md,
  },
  infoBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: SoftUI.divider,
  },
  infoIcon: {
    width: SoftUI.iconBtn - 8,
    height: SoftUI.iconBtn - 8,
    borderRadius: SoftUI.radius.chip,
    backgroundColor: SoftUI.infoSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  infoLabel: {
    color: SoftUI.text,
    fontSize: SoftUI.type.body.size - 1,
    fontFamily: AuthUI.font.semibold,
  },
  infoSub: {
    color: SoftUI.textSecondary,
    fontSize: SoftUI.type.chip.size,
    fontFamily: AuthUI.font.regular,
  },
  chevron: {
    width: 28,
    height: 28,
    borderRadius: SoftUI.radius.chip,
    backgroundColor: SoftUI.infoSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  version: {
    color: SoftUI.textDisabled,
    fontSize: SoftUI.type.chip.size,
    fontFamily: AuthUI.font.regular,
    textAlign: "center",
    marginBottom: SoftUI.space.base,
  },
  signOut: {
    height: SoftUI.buttonH,
    borderRadius: SoftUI.radius.button,
    backgroundColor: SoftUI.dangerSoft,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: SoftUI.space.sm,
  },
  signOutText: {
    color: SoftUI.danger,
    fontSize: SoftUI.type.body.size + 1,
    fontFamily: AuthUI.font.semibold,
  },
  deleteAccount: {
    height: 46,
    marginTop: SoftUI.space.md,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: SoftUI.space.sm,
  },
  deleteAccountText: {
    color: SoftUI.textSecondary,
    fontSize: SoftUI.type.body.size,
    fontFamily: AuthUI.font.medium,
  },
});
