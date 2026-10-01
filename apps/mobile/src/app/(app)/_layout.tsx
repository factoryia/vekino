import { useEffect, useState } from "react";
import { View, StyleSheet } from "react-native";
import { Stack, useRouter, useRootNavigationState } from "expo-router";
import { Authenticated, Unauthenticated, AuthLoading, useQuery } from "convex/react";
import { api } from "@vekino/backend/api";
import { CondominioProvider, useCondominio } from "@/context/condominio-context";
import { PushBootstrap } from "@/components/push-bootstrap";
import { RecordatorioCierreTurno } from "@/components/guardia/recordatorio-cierre";
import { SplashPantalla, SALIDA_MS } from "@/components/ui/splash-marca";
import { useSplashCumplido, precargarImagenes } from "@/lib/arranque";

function RedirectToLogin() {
  const router = useRouter();
  const navState = useRootNavigationState();

  useEffect(() => {
    if (!navState?.key) return;
    router.replace("/(auth)/login" as never);
  }, [router, navState?.key]);

  return <SplashPantalla />;
}

/**
 * Sostiene el splash sobre la app recién montada hasta que valga la pena
 * mostrarla: cuando la primera pantalla ya tiene datos y sus imágenes están en
 * caché, y cuando la animación de marca alcanzó a verse completa.
 *
 * Va aquí y no en la ruta raíz a propósito: aquí las consultas ya están
 * corriendo, así que la espera se usa para cargar en vez de solo retrasar.
 */
function Preparando() {
  const { condominioId, coverImage } = useCondominio();
  const splashCumplido = useSplashCumplido();

  const facturas = useQuery(
    api.facturas.listMia,
    condominioId ? { condominioId } : "skip",
  );
  const comunicados = useQuery(
    api.comunicados.listRecent,
    condominioId ? { condominioId, limit: 3 } : "skip",
  );

  const portadaAviso = comunicados?.[0]?.imagenUrl ?? null;

  useEffect(() => {
    precargarImagenes([coverImage, portadaAviso]);
  }, [coverImage, portadaAviso]);

  // Sin condominio resuelto no hay nada que esperar (p. ej. superadmin).
  const datosListos =
    !condominioId || (facturas !== undefined && comunicados !== undefined);
  const listo = splashCumplido && datosListos;

  const [saliendo, setSaliendo] = useState(false);
  const [retirado, setRetirado] = useState(false);

  // El giro de salida ES la transición: primero se reproduce, y solo cuando
  // termina soltamos la pantalla. Van en dos efectos separados a propósito:
  // con `saliendo` como dependencia del mismo efecto, activarlo lo re-ejecuta
  // y su limpieza cancelaba el temporizador — el velo se quedaba para siempre.
  useEffect(() => {
    if (listo) setSaliendo(true);
  }, [listo]);

  useEffect(() => {
    if (!saliendo) return;
    const id = setTimeout(() => setRetirado(true), SALIDA_MS);
    return () => clearTimeout(id);
  }, [saliendo]);

  if (retirado) return null;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents={saliendo ? "none" : "auto"}>
      <SplashPantalla saliendo={saliendo} />
    </View>
  );
}

/**
 * Stack encima de Tabs → gesto “atrás” de iOS en módulos (Residentes, etc.)
 * y historial real al salir de Más.
 */
export default function AppLayout() {
  return (
    <>
      <AuthLoading>
        <SplashPantalla />
      </AuthLoading>
      <Unauthenticated>
        <RedirectToLogin />
      </Unauthenticated>
      <Authenticated>
        <CondominioProvider>
          <PushBootstrap />
          {/* Aquí y no en una pantalla: sigue vivo al navegar entre módulos. */}
          <RecordatorioCierreTurno />
          <Stack
            screenOptions={{ headerShown: false, animation: "slide_from_right" }}
          >
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="residentes" options={{ gestureEnabled: true }} />
            <Stack.Screen name="unidades" options={{ gestureEnabled: true }} />
            <Stack.Screen name="reservas" options={{ gestureEnabled: true }} />
            <Stack.Screen name="vehiculos" options={{ gestureEnabled: true }} />
            <Stack.Screen name="visitantes" options={{ gestureEnabled: true }} />
            <Stack.Screen
              name="guardia/visitantes"
              options={{ gestureEnabled: true }}
            />
            <Stack.Screen
              name="guardia/minuta"
              options={{ gestureEnabled: true }}
            />
            <Stack.Screen
              name="guardia/paqueteria"
              options={{ gestureEnabled: true }}
            />
            <Stack.Screen
              name="guardia/reservas"
              options={{ gestureEnabled: true }}
            />
            <Stack.Screen
              name="guardia/novedades"
              options={{ gestureEnabled: true }}
            />
            <Stack.Screen
              name="guardia/avisos"
              options={{ gestureEnabled: true }}
            />
            <Stack.Screen name="pqrs" options={{ gestureEnabled: true }} />
            <Stack.Screen name="privacidad" options={{ gestureEnabled: true }} />
            <Stack.Screen
              name="notificaciones"
              options={{ gestureEnabled: true }}
            />
            <Stack.Screen name="soporte" options={{ gestureEnabled: true }} />
            <Stack.Screen
              name="asambleas/index"
              options={{ gestureEnabled: true }}
            />
            <Stack.Screen
              name="asambleas/[id]"
              options={{ gestureEnabled: true }}
            />
            {/* Sin gesto de volver: un roce en el borde colgaría la llamada
             * en plena asamblea. Se sale con el botón rojo, adrede. */}
            <Stack.Screen
              name="asambleas/sala/[id]"
              options={{ gestureEnabled: false }}
            />
            <Stack.Screen
              name="asambleas/apoderado"
              options={{ gestureEnabled: true }}
            />
            <Stack.Screen name="consejo" options={{ gestureEnabled: true }} />
            <Stack.Screen name="documentos" options={{ gestureEnabled: true }} />
            <Stack.Screen name="control" options={{ gestureEnabled: true }} />
            <Stack.Screen name="historial" options={{ gestureEnabled: true }} />
            <Stack.Screen name="reportes" options={{ gestureEnabled: true }} />
          </Stack>
          {/* Va después del Stack para quedar por encima mientras prepara. */}
          <Preparando />
        </CondominioProvider>
      </Authenticated>
    </>
  );
}
