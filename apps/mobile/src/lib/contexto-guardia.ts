import type { FunctionReturnType } from "convex/server";
import type { api } from "@vekino/backend/api";
import { textoLocalColombia } from "@vekino/backend/inasistencias";

/**
 * EL CONTEXTO DE GUARDA, TAL COMO LO CONSUME EL MÓVIL.
 *
 * Nada de aquí decide si una cobertura está activa, si un contrato sigue
 * vigente o si una asignación vale: todo eso lo resolvió el servidor y llega
 * en `users.meOperativo` → `contextoOperativoGuardia`:
 *
 *   tipo       → permanente | cobertura | bloqueado;
 *   cobertura  → el conjunto que cubre y hasta cuándo, si la hay;
 *   conjuntos  → las porterías donde opera como guarda AHORA (con el
 *                contexto ya aplicado: con cobertura, solo la que cubre);
 *   refrescarEn → cuándo volver a preguntar.
 *
 * Aquí solo se traduce eso a lo que la app necesita para navegar: qué
 * conjuntos se pueden abrir, cuál está activo y si en él se es guarda. Las
 * funciones son puras para poder probarlas sin la app montada
 * (`pruebas/contextoGuardia.prueba.ts`).
 */

export type Sesion = NonNullable<FunctionReturnType<typeof api.users.meOperativo>>;
export type ContextoGuardia = Sesion["contextoOperativoGuardia"];
export type ViaDeGuardia = ContextoGuardia["conjuntos"][number]["por"];

/** Un conjunto que la persona puede abrir en la app. */
export type OpcionCondominio = {
  condominioId: string;
  nombre: string | null;
  logo: string | null;
  color: string | null;
  coverImage: string | null;
  /**
   * Los roles de su membresía allí, SIN `guardia`. Ser guarda no se lee de la
   * membresía: sale de `contextoOperativoGuardia.conjuntos`, que ya sabe si
   * una cobertura la suspende.
   */
  roles: string[];
  /** Si opera allí como guarda ahora, y por qué vía. Null si no. */
  guardiaPor: ViaDeGuardia | null;
};

/**
 * Los conjuntos que se pueden abrir: los de sus membresías (con sus roles de
 * residente o administración) y las porterías que el servidor dice que opera.
 *
 * Una membresía que SOLO era de guarda y que hoy no está entre las porterías
 * no se ofrece: el servidor la tiene suspendida (cobertura o bloqueo) y abrir
 * ese conjunto no serviría para nada. La de la cobertura va primero.
 */
export function opcionesDeCondominio(
  sesion: Pick<Sesion, "memberships" | "contextoOperativoGuardia">,
): OpcionCondominio[] {
  const porterias = new Map(
    sesion.contextoOperativoGuardia.conjuntos.map((c) => [c.condominioId as string, c]),
  );
  const opciones: OpcionCondominio[] = [];
  const vistos = new Set<string>();

  for (const m of sesion.memberships) {
    const id = m.condominioId as string;
    const porteria = porterias.get(id);
    const roles = m.roles.filter((r) => r !== "guardia");
    const soloDeGuarda = m.roles.length > 0 && roles.length === 0;
    if (soloDeGuarda && !porteria) continue;
    vistos.add(id);
    opciones.push({
      condominioId: id,
      nombre: m.condominioName,
      logo: m.condominioLogo,
      color: m.condominioPrimaryColor,
      coverImage: m.condominioCoverImage,
      roles,
      guardiaPor: porteria?.por ?? null,
    });
  }

  for (const c of sesion.contextoOperativoGuardia.conjuntos) {
    const id = c.condominioId as string;
    if (vistos.has(id)) continue;
    opciones.push({
      condominioId: id,
      nombre: c.condominioNombre,
      logo: c.condominioLogo,
      color: c.condominioColor,
      coverImage: c.condominioCoverImage,
      roles: [],
      guardiaPor: c.por,
    });
  }

  const cubierto = sesion.contextoOperativoGuardia.cobertura?.condominioId as string | undefined;
  return cubierto
    ? [...opciones.filter((o) => o.condominioId === cubierto), ...opciones.filter((o) => o.condominioId !== cubierto)]
    : opciones;
}

/**
 * El conjunto activo: el elegido si todavía se puede abrir.
 *
 * Un conjunto elegido que dejó de valer (el de siempre durante una cobertura,
 * el de la cobertura cuando terminó o la inhabilitaron) cae solo: no hay una
 * ruta que lo mantenga abierto. Si cae, se vuelve a una portería —la de la
 * cobertura va primera; si no, la permanente—, porque quien estaba operando
 * sigue de turno. Sin nada elegido, el primero, como siempre.
 */
export function condominioActivo(
  opciones: readonly OpcionCondominio[],
  elegido: string | undefined,
): OpcionCondominio | undefined {
  const vigente = opciones.find((o) => o.condominioId === elegido);
  if (vigente) return vigente;
  if (elegido) {
    const porteria = opciones.find((o) => o.guardiaPor !== null);
    if (porteria) return porteria;
  }
  return opciones[0];
}

/**
 * Si hay que llevar a la persona a la portería que cubre: una cobertura que
 * todavía no se le ha mostrado. Una sola vez por cobertura, para que pueda
 * pasar a su casa (si es residente en otro conjunto) sin que la app la
 * devuelva a la portería a cada momento.
 */
export function debeIrALaCobertura(
  contexto: ContextoGuardia,
  coberturaVista: string | null,
): boolean {
  const id = contexto.cobertura?.coberturaId as string | undefined;
  return !!id && id !== coberturaVista;
}

/** Roles con herramientas de administración en el móvil. */
export const MANAGE_ROLES = ["administrador", "contadora", "representante_asamblea"];

/**
 * Si en este conjunto se le muestra la portería: opera allí como guarda
 * según el servidor y no lo administra (la administración tiene su panel).
 */
export function esPorteriaDeGuarda(opcion: OpcionCondominio | undefined): boolean {
  if (!opcion?.guardiaPor) return false;
  return !opcion.roles.some((r) => MANAGE_ROLES.includes(r));
}

/**
 * Por qué un guarda de compañía no tiene portería que abrir, para no
 * confundirlo con "no tiene cuenta" ni con "no pertenece a nada":
 *
 *   bloqueado    → el servidor detectó dos coberturas activas a la vez;
 *   sin_porteria → hoy no tiene ni asignación de guarda ni cobertura.
 *
 * Null cuando no aplica: tiene portería, o no es guarda de compañía.
 */
export type EstadoGuardia = "bloqueado" | "sin_porteria" | null;

export function estadoDeGuardia(
  sesion: Pick<Sesion, "compania" | "contextoOperativoGuardia">,
): EstadoGuardia {
  const contexto = sesion.contextoOperativoGuardia;
  if (contexto.tipo === "bloqueado") return "bloqueado";
  const esGuardaDeCompania = !!sesion.compania?.roles.includes("guardia");
  if (esGuardaDeCompania && contexto.conjuntos.length === 0) return "sin_porteria";
  return null;
}

const MESES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio", "julio",
  "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

/** "09 de octubre · 06:00", siempre en hora de Colombia. */
export function etiquetaHasta(ms: number): string {
  const [fecha, hora] = textoLocalColombia(ms).split("T");
  const [, mes, dia] = fecha!.split("-");
  return `${dia} de ${MESES[Number(mes) - 1]} · ${hora}`;
}

/**
 * Lo que cambia cuando cambia el contexto: si esta firma cambia, la portería
 * que se estaba mirando puede haber dejado de valer.
 */
export function firmaDeContexto(contexto: ContextoGuardia | undefined): string {
  if (!contexto) return "";
  return [
    contexto.tipo,
    contexto.cobertura?.coberturaId ?? "",
    ...contexto.conjuntos.map((c) => `${c.condominioId}:${c.por}`),
  ].join("|");
}
