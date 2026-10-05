import { Platform } from "react-native";
import { Tabs } from "expo-router";
import { NativeTabs, Icon, Label } from "expo-router/unstable-native-tabs";
import { ThemeProvider } from "@react-navigation/core";
import { DefaultTheme } from "@react-navigation/native";
import { GlassTabBar } from "@/components/ui/tab-bar";
import { useCondominio } from "@/context/condominio-context";

const TABS_CONDOMINIO = ["index", "facturas", "comunicados", "mas", "perfil"];
const TABS_PANEL = ["index", "administradores", "perfil"];
const TABS_GUARDIA = ["index", "mas", "perfil"];
/** Guarda de compañía sin portería hoy: no hay módulos que abrir. */
const TABS_SIN_PORTERIA = ["index", "perfil"];

/**
 * iOS → UITabBarController nativo (expo-router NativeTabs).
 * Hereda el efecto "Liquid Glass" del sistema en iOS 26+ y el blur
 * traslúcido nativo clásico en versiones anteriores — cero CSS a mano.
 */
function IosTabsLayout() {
  const { condominioId, isSuperadmin, isGuardia, estadoGuardia, theme } = useCondominio();
  const panelMode = isSuperadmin && !condominioId;
  const visible = panelMode
    ? TABS_PANEL
    : isGuardia
      ? TABS_GUARDIA
      : !condominioId && estadoGuardia
        ? TABS_SIN_PORTERIA
        : TABS_CONDOMINIO;

  const triggers = [
    visible.includes("index") && (
      <NativeTabs.Trigger key="index" name="index">
        <Icon sf={{ default: "house", selected: "house.fill" }} />
        <Label>{panelMode ? "Panel" : "Inicio"}</Label>
      </NativeTabs.Trigger>
    ),
    visible.includes("administradores") && (
      <NativeTabs.Trigger key="administradores" name="administradores">
        <Icon sf={{ default: "shield", selected: "shield.fill" }} />
        <Label>Admins</Label>
      </NativeTabs.Trigger>
    ),
    visible.includes("facturas") && (
      <NativeTabs.Trigger key="facturas" name="facturas">
        <Icon sf={{ default: "wallet.pass", selected: "wallet.pass.fill" }} />
        <Label>Facturas</Label>
      </NativeTabs.Trigger>
    ),
    visible.includes("comunicados") && (
      <NativeTabs.Trigger key="comunicados" name="comunicados">
        <Icon sf={{ default: "megaphone", selected: "megaphone.fill" }} />
        <Label>Avisos</Label>
      </NativeTabs.Trigger>
    ),
    visible.includes("mas") && (
      <NativeTabs.Trigger key="mas" name="mas">
        <Icon
          sf={{ default: "square.grid.2x2", selected: "square.grid.2x2.fill" }}
        />
        <Label>Más</Label>
      </NativeTabs.Trigger>
    ),
    visible.includes("perfil") && (
      <NativeTabs.Trigger key="perfil" name="perfil">
        <Icon
          sf={{ default: "person.crop.circle", selected: "person.crop.circle.fill" }}
        />
        <Label>Perfil</Label>
      </NativeTabs.Trigger>
    ),
  ].filter(Boolean);

  return (
    <ThemeProvider value={DefaultTheme}>
      <NativeTabs tintColor={theme.accent}>{triggers}</NativeTabs>
    </ThemeProvider>
  );
}

/** Android → cápsula flotante Soft UI (GlassTabBar, JS tabs). */
const androidTabBarStyle = {
  position: "absolute" as const,
  left: 0,
  right: 0,
  bottom: 0,
  backgroundColor: "transparent",
  borderTopWidth: 0,
  elevation: 0,
  shadowOpacity: 0,
  height: 90,
};

function AndroidTabsLayout() {
  return (
    <Tabs
      tabBar={(props) => <GlassTabBar {...props} />}
      screenOptions={{
        headerShown: false,
        tabBarStyle: androidTabBarStyle,
        tabBarShowLabel: false,
      }}
    >
      <Tabs.Screen name="index" />
      <Tabs.Screen name="administradores" />
      <Tabs.Screen name="facturas" />
      <Tabs.Screen name="comunicados" />
      <Tabs.Screen name="mas" />
      <Tabs.Screen name="perfil" />
    </Tabs>
  );
}

export default function TabsLayout() {
  return Platform.OS === "ios" ? <IosTabsLayout /> : <AndroidTabsLayout />;
}
