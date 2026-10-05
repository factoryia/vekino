import React, { createContext, useContext, useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Id } from "@vekino/backend/dataModel";
import { resolveCondoTheme, type CondoTheme } from "@/lib/condo-theme";
import { useMeOperativo } from "@/hooks/use-contexto-operativo";
import {
  condominioActivo,
  debeIrALaCobertura,
  esPorteriaDeGuarda,
  estadoDeGuardia,
  MANAGE_ROLES,
  opcionesDeCondominio,
  type ContextoGuardia,
  type EstadoGuardia,
  type OpcionCondominio,
} from "@/lib/contexto-guardia";

const STORAGE_KEY = "vekino.activeCondominio";
/** La última cobertura a cuya portería ya se llevó al guarda. */
const COBERTURA_VISTA_KEY = "vekino.coberturaVista";

interface CondominioCtx {
  condominioId: Id<"condominios"> | undefined;
  condominioName: string | null;
  /** Foto destacada del home (URL S3) o null. */
  coverImage: string | null;
  theme: CondoTheme;
  isSuperadmin: boolean;
  canManage: boolean;
  /** Contadora sin ser administrador del condo. */
  isContadora: boolean;
  /**
   * Se le muestra la portería de este conjunto: el servidor dice que opera
   * aquí como guarda (`contextoOperativoGuardia.conjuntos`) y no lo administra.
   */
  isGuardia: boolean;
  /** Miembro de junta directiva (portal + Consejo; no shell admin). */
  isJunta: boolean;
  /** Roles de la membresía en el conjunto activo, sin `guardia`. */
  roles: string[];
  /** Los conjuntos que se pueden abrir, con la cobertura primero. */
  opciones: OpcionCondominio[];
  /** El contexto operativo de guarda tal como lo resolvió el servidor. */
  contextoGuardia: ContextoGuardia | undefined;
  /** Por qué un guarda de compañía no tiene portería que abrir, si es el caso. */
  estadoGuardia: EstadoGuardia;
  isLoading: boolean;
  selectCondominio: (id: Id<"condominios">, name: string) => void;
  clearCondominio: () => void;
}

const JUNTA_ROLES = ["junta_directiva"];

const CondominioContext = createContext<CondominioCtx>({
  condominioId: undefined,
  condominioName: null,
  coverImage: null,
  theme: resolveCondoTheme(null),
  isSuperadmin: false,
  canManage: false,
  isContadora: false,
  isGuardia: false,
  isJunta: false,
  roles: [],
  opciones: [],
  contextoGuardia: undefined,
  estadoGuardia: null,
  isLoading: true,
  selectCondominio: () => {},
  clearCondominio: () => {},
});

/**
 * La sesión del móvil: qué conjunto está abierto y qué se puede hacer en él.
 *
 * Sale de `users.meOperativo`, no de `users.me`: es la misma respuesta, pero
 * se vuelve a pedir cuando una cobertura empieza o termina
 * (`useMeOperativo`), así que la portería cambia sola con la app abierta.
 *
 * Quién es guarda y dónde NO se deduce de las membresías: lo dice el servidor
 * en `contextoOperativoGuardia` (ver `lib/contexto-guardia.ts`). Con una
 * cobertura activa, la portería de siempre deja de ofrecerse y la que cubre
 * pasa a ser la activa; cuando termina, vuelve la de siempre, o ninguna si no
 * tiene. Las demás relaciones (residente, administración, junta) siguen
 * igual que antes.
 */
export function CondominioProvider({ children }: { children: React.ReactNode }) {
  const me = useMeOperativo();
  const [override, setOverride] = useState<{
    id: Id<"condominios">;
    name: string;
  } | null>(null);
  const [coberturaVista, setCoberturaVista] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    let cancelled = false;
    AsyncStorage.multiGet([STORAGE_KEY, COBERTURA_VISTA_KEY])
      .then(([[, raw], [, vista]]) => {
        if (cancelled) return;
        if (vista) setCoberturaVista(vista);
        if (!raw) return;
        try {
          const parsed = JSON.parse(raw) as { id?: string; name?: string };
          if (parsed.id && parsed.name) {
            setOverride({
              id: parsed.id as Id<"condominios">,
              name: parsed.name,
            });
          }
        } catch {
          // ignore corrupt cache
        }
      })
      .finally(() => {
        if (!cancelled) setHydrated(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const isSuperadmin = me?.isSuperadmin ?? false;
  const contextoGuardia = me?.contextoOperativoGuardia;
  const opciones = me ? opcionesDeCondominio(me) : [];
  const activa = condominioActivo(opciones, override?.id);

  /* Una cobertura que empieza lleva a su portería, una vez: si después pasa a
   * su casa en otro conjunto, la app no lo devuelve a cada momento. */
  useEffect(() => {
    if (!hydrated || isSuperadmin || !contextoGuardia) return;
    if (!debeIrALaCobertura(contextoGuardia, coberturaVista)) return;
    const cobertura = contextoGuardia.cobertura!;
    const elegido = { id: cobertura.condominioId, name: cobertura.condominioNombre };
    setOverride(elegido);
    setCoberturaVista(cobertura.coberturaId);
    void AsyncStorage.multiSet([
      [STORAGE_KEY, JSON.stringify(elegido)],
      [COBERTURA_VISTA_KEY, cobertura.coberturaId],
    ]);
  }, [hydrated, isSuperadmin, contextoGuardia, coberturaVista]);

  /* El superadmin abre cualquier conjunto (el que eligió en el panel), como
   * siempre; los demás, solo los que el servidor les ofrece. */
  const memberships = me?.memberships ?? [];
  const membershipDelSuper =
    memberships.find((m) => m.condominioId === override?.id) ?? memberships[0];
  const effectiveId: Id<"condominios"> | undefined = isSuperadmin
    ? override?.id
    : (activa?.condominioId as Id<"condominios"> | undefined);
  const effectiveName: string | null = isSuperadmin
    ? (override?.name ?? membershipDelSuper?.condominioName ?? null)
    : (activa?.nombre ?? null);
  const primaryColor = isSuperadmin
    ? (membershipDelSuper?.condominioPrimaryColor ?? null)
    : (activa?.color ?? null);
  const coverImage =
    (isSuperadmin ? membershipDelSuper?.condominioCoverImage : activa?.coverImage)?.trim() ||
    null;

  const theme = resolveCondoTheme(effectiveName, primaryColor);

  const roles = isSuperadmin
    ? (membershipDelSuper?.roles.filter((r) => r !== "guardia") ?? [])
    : (activa?.roles ?? []);
  const isAdminCondo = isSuperadmin || roles.includes("administrador");
  const isContadora = !isAdminCondo && roles.includes("contadora");
  const canManage = isSuperadmin ? true : roles.some((r) => MANAGE_ROLES.includes(r));
  const isGuardia = !isSuperadmin && esPorteriaDeGuarda(activa);
  const isJunta = roles.some((r) => JUNTA_ROLES.includes(r));
  const estadoGuardia = me ? estadoDeGuardia(me) : null;

  function selectCondominio(id: Id<"condominios">, name: string) {
    setOverride({ id, name });
    void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ id, name }));
  }

  function clearCondominio() {
    setOverride(null);
    void AsyncStorage.removeItem(STORAGE_KEY);
  }

  return (
    <CondominioContext.Provider
      value={{
        condominioId: effectiveId,
        condominioName: effectiveName,
        coverImage,
        theme,
        isSuperadmin,
        canManage,
        isContadora,
        isGuardia,
        isJunta,
        roles,
        opciones,
        contextoGuardia,
        estadoGuardia,
        isLoading: me === undefined || !hydrated,
        selectCondominio,
        clearCondominio,
      }}
    >
      {children}
    </CondominioContext.Provider>
  );
}

export function useCondominio() {
  return useContext(CondominioContext);
}
