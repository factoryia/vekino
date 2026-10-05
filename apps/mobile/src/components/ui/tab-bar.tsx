import React from "react";
import { View, Text, Pressable, StyleSheet, Platform } from "react-native";
import { BlurView } from "expo-blur";
import * as Haptics from "expo-haptics";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import type { BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { useCondominio } from "@/context/condominio-context";
import { AuthUI } from "@/lib/auth-ui";
import { SoftUI, floatShadow } from "@/lib/soft-ui";

type IoniconName = React.ComponentProps<typeof Ionicons>["name"];

const TAB_CONFIG: Record<
  string,
  { label: string; labelPanel?: string; icon: IoniconName; iconActive: IoniconName }
> = {
  index: { label: "Inicio", labelPanel: "Panel", icon: "grid-outline", iconActive: "grid" },
  administradores: { label: "Admins", icon: "shield-outline", iconActive: "shield" },
  facturas: { label: "Facturas", icon: "wallet-outline", iconActive: "wallet" },
  comunicados: { label: "Avisos", icon: "megaphone-outline", iconActive: "megaphone" },
  mas: { label: "Más", icon: "apps-outline", iconActive: "apps" },
  perfil: { label: "Perfil", icon: "person-outline", iconActive: "person" },
};

const TABS_CONDOMINIO = ["index", "facturas", "comunicados", "mas", "perfil"];
const TABS_PANEL = ["index", "administradores", "perfil"];
const TABS_GUARDIA = ["index", "mas", "perfil"];
/** Guarda de compañía sin portería hoy: no hay módulos que abrir. */
const TABS_SIN_PORTERIA = ["index", "perfil"];

const IS_IOS = Platform.OS === "ios";

function TabItem({
  name,
  focused,
  panelMode,
  accent,
  activeBg,
  onPress,
}: {
  name: string;
  focused: boolean;
  panelMode: boolean;
  accent: string;
  activeBg: string;
  onPress: () => void;
}) {
  const config = TAB_CONFIG[name] ?? {
    label: name,
    icon: "ellipse-outline" as IoniconName,
    iconActive: "ellipse" as IoniconName,
  };
  const label = panelMode && config.labelPanel ? config.labelPanel : config.label;
  const color = focused ? (panelMode ? AuthUI.text : accent) : AuthUI.textMuted;
  const pillBg = focused
    ? panelMode
      ? "rgba(14,14,15,0.06)"
      : activeBg
    : undefined;

  return (
    <Pressable
      onPress={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onPress();
      }}
      style={styles.tabItem}
      hitSlop={4}
    >
      <View style={styles.tabCol}>
        <View
          style={[
            styles.iconWrap,
            pillBg ? { backgroundColor: pillBg } : null,
          ]}
        >
          <Ionicons
            name={focused ? config.iconActive : config.icon}
            size={22}
            color={color}
          />
        </View>
        <Text
          style={[
            styles.tabLabel,
            { color },
            focused && styles.tabLabelActive,
          ]}
          numberOfLines={1}
        >
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

function TabRoutes({
  routes,
  state,
  navigation,
  panelMode,
  accent,
  activeBg,
}: {
  routes: { key: string; name: string }[];
  state: BottomTabBarProps["state"];
  navigation: BottomTabBarProps["navigation"];
  panelMode: boolean;
  accent: string;
  activeBg: string;
}) {
  return (
    <View style={styles.tabs}>
      {routes.map((route) => {
        const originalIndex = state.routes.findIndex((r) => r.key === route.key);
        const focused = state.index === originalIndex;
        return (
          <TabItem
            key={route.key}
            name={route.name}
            focused={focused}
            panelMode={panelMode}
            accent={accent}
            activeBg={activeBg}
            onPress={() => {
              const event = navigation.emit({
                type: "tabPress",
                target: route.key,
                canPreventDefault: true,
              });
              if (!event.defaultPrevented) navigation.navigate(route.name);
            }}
          />
        );
      })}
    </View>
  );
}

/**
 * Android → cápsula flotante Soft UI (márgenes + radio completo).
 * iOS → barra nativa pegada abajo (solo topLeft / topRight).
 */
export function GlassTabBar({ state, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const { condominioId, isSuperadmin, isGuardia, estadoGuardia, theme } = useCondominio();
  const panelMode = isSuperadmin && !condominioId;
  const visible = panelMode
    ? TABS_PANEL
    : isGuardia
      ? TABS_GUARDIA
      : !condominioId && estadoGuardia
        ? TABS_SIN_PORTERIA
        : TABS_CONDOMINIO;
  const routes = state.routes.filter((r) => visible.includes(r.name));
  const tabsProps = {
    routes,
    state,
    navigation,
    panelMode,
    accent: theme.accent,
    activeBg: theme.tabActiveBg,
  };

  // ── iOS: barra nativa docked (home indicator) ──────
  if (IS_IOS) {
    return (
      <View style={styles.iosRoot}>
        <View
          style={[
            styles.iosBar,
            { paddingBottom: Math.max(insets.bottom, 8) },
          ]}
        >
          <TabRoutes {...tabsProps} />
        </View>
      </View>
    );
  }

  // ── Android: cápsula flotante (como la referencia Soft UI) ──
  return (
    <View
      pointerEvents="box-none"
      style={[
        styles.androidRoot,
        { paddingBottom: Math.max(insets.bottom, 12) },
      ]}
    >
      <View style={styles.androidPill}>
        <View style={styles.androidFill} />
        <View style={styles.androidSheen} pointerEvents="none" />
        <TabRoutes {...tabsProps} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Android — floating pill
  androidRoot: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: SoftUI.padH,
    zIndex: 50,
  },
  androidPill: {
    borderRadius: SoftUI.radius.tabBar,
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(231,232,236,0.95)",
    backgroundColor: "rgba(255,255,255,0.94)",
    ...floatShadow,
  },
  androidFill: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(255,255,255,0.92)",
  },
  androidSheen: {
    ...StyleSheet.absoluteFillObject,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(255,255,255,0.95)",
  },

  // iOS — docked native
  iosRoot: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    width: "100%",
    zIndex: 50,
  },
  iosBar: {
    width: "100%",
    backgroundColor: SoftUI.white,
    borderTopLeftRadius: SoftUI.radius.tabBar,
    borderTopRightRadius: SoftUI.radius.tabBar,
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: SoftUI.divider,
  },

  tabs: {
    flexDirection: "row",
    paddingHorizontal: 4,
    paddingTop: 8,
    paddingBottom: 6,
  },
  tabItem: {
    flex: 1,
    alignItems: "center",
  },
  tabCol: {
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
    minWidth: SoftUI.touch,
    minHeight: SoftUI.touch,
  },
  /** Solo el icono lleva el fondo activo (círculo suave). */
  iconWrap: {
    width: 40,
    height: 40,
    borderRadius: SoftUI.radius.chip,
    alignItems: "center",
    justifyContent: "center",
  },
  tabLabel: {
    fontFamily: AuthUI.font.medium,
    fontSize: SoftUI.type.chip.size,
  },
  tabLabelActive: {
    fontFamily: AuthUI.font.semibold,
  },
});
