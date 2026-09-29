import { v } from "convex/values";

/**
 * ROLES EN 2 CAPAS
 *
 * Capa 1 — Plataforma (global, en `users.platformRole`):
 *   - superadmin: dueño del SaaS. Control maestro total (todos los condominios).
 *   - admin: staff de plataforma. Soporte / operación multi-condominio.
 *   - (undefined): usuario normal, sin poderes de plataforma.
 *
 * Capa 2 — Operativos por condominio (en `memberships.roles[]`):
 *   Un usuario puede tener varios roles dentro de un mismo condominio.
 */

export const PLATFORM_ROLES = ["superadmin", "admin"] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export const platformRoleValidator = v.union(
  v.literal("superadmin"),
  v.literal("admin"),
);

export const OPERATIONAL_ROLES = [
  "administrador", // admin del condominio (gestiona todo el conjunto)
  "propietario", // dueño de una o más unidades
  "apoderado", // representa a un propietario (poder / power of attorney)
  "arrendatario", // inquilino de una unidad
  "residente", // habita sin ser dueño ni arrendatario formal
  "contadora", // finanzas / cartera
  "guardia", // seguridad / portería
  "junta_directiva", // consejo de administración
  "representante_asamblea", // vocero en asambleas
] as const;

export type OperationalRole = (typeof OPERATIONAL_ROLES)[number];

export const operationalRoleValidator = v.union(
  v.literal("administrador"),
  v.literal("propietario"),
  v.literal("apoderado"),
  v.literal("arrendatario"),
  v.literal("residente"),
  v.literal("contadora"),
  v.literal("guardia"),
  v.literal("junta_directiva"),
  v.literal("representante_asamblea"),
);

// ─────────────────────────────────────────────────────────────
// QUIÉN TOCÓ UN DEPÓSITO DE RESERVA
// ─────────────────────────────────────────────────────────────

/**
 * De mayor a menor responsabilidad. El primero que se tenga, gana.
 *
 * El orden NO es la ventanilla: un administrador que opera la portería sigue
 * siendo administrador, y eso es lo que una auditoría tiene que poder decir.
 * Por dónde entró se guarda aparte (`origen`), que es la otra mitad.
 */
const JERARQUIA_ACTOR_DEPOSITO = [
  "administrador",
  "junta_directiva",
  "contadora",
  "guardia",
] as const satisfies readonly OperationalRole[];

/**
 * Con qué autoridad actuó quien recibió o devolvió un depósito.
 *
 * Se GUARDA en el momento de la acción y no se deduce al leer: quien recibió
 * un depósito siendo guarda y hoy administra el conjunto lo recibió como
 * guarda, y una auditoría que dijera lo contrario estaría inventando el
 * pasado. Por eso los depósitos anteriores a este campo lo dejan vacío en
 * lugar de rellenarlo con el rol de hoy.
 *
 * "plataforma" es el staff de Vekino, que entra a cualquier conjunto por
 * soporte: no es un rol del conjunto y no debe leerse como uno.
 */
export type RolActorDeposito =
  | (typeof JERARQUIA_ACTOR_DEPOSITO)[number]
  | "plataforma";

export const rolActorDepositoValidator = v.union(
  v.literal("administrador"),
  v.literal("junta_directiva"),
  v.literal("contadora"),
  v.literal("guardia"),
  v.literal("plataforma"),
);

/** Por qué ventanilla entró la acción. Hermano de `reservaIncidentes.origen`. */
export type OrigenDeposito = "porteria" | "administracion";

export const origenDepositoValidator = v.union(
  v.literal("porteria"),
  v.literal("administracion"),
);

/**
 * El rol con el que alguien actúa sobre un depósito, resuelto al escribir.
 *
 * Total a propósito: siempre devuelve uno de los literales del validador, así
 * que nunca puede tumbar la escritura que audita. Sin membresía solo se llega
 * de dos formas —staff de plataforma, o guarda de una compañía de vigilancia,
 * que no tiene fila en `memberships`—, y la ventanilla las desempata.
 */
export function rolActorDeposito(args: {
  roles?: readonly OperationalRole[];
  esPlataforma: boolean;
  origen: OrigenDeposito;
}): RolActorDeposito {
  const roles = args.roles ?? [];
  for (const rol of JERARQUIA_ACTOR_DEPOSITO) {
    if (roles.includes(rol)) return rol;
  }
  if (args.esPlataforma) return "plataforma";
  return args.origen === "porteria" ? "guardia" : "plataforma";
}

/** Vínculo de una persona con una unidad concreta. */
export const vinculoUnidadValidator = v.union(
  v.literal("propietario"),
  v.literal("apoderado"),
  v.literal("arrendatario"),
  v.literal("residente"),
);

export const tipoDocumentoValidator = v.union(
  v.literal("CC"), // cédula de ciudadanía
  v.literal("CE"), // cédula de extranjería
  v.literal("NIT"),
  v.literal("PASAPORTE"),
  v.literal("TI"), // tarjeta de identidad
  v.literal("PEP"),
);

export const subscriptionPlanValidator = v.union(
  v.literal("basico"),
  v.literal("pro"),
  v.literal("enterprise"),
);

export const tipoUnidadValidator = v.union(
  v.literal("apartamento"),
  v.literal("casa"),
  v.literal("local"),
  v.literal("parqueadero"),
  v.literal("deposito"),
  v.literal("oficina"),
  v.literal("otro"),
);

export const estadoUnidadValidator = v.union(
  v.literal("ocupada"),
  v.literal("desocupada"),
  v.literal("en_mora"),
  v.literal("inactiva"),
);

// ─────────────────────────────────────────────────────────────
// EJE DE SEGURIDAD (compañías de vigilancia)
//
// Segundo eje de pertenencia, hermano del conjunto y no hijo suyo: una
// persona pertenece a una compañía, que existe antes de tener conjuntos y
// sobrevive a perderlos. Vive en `companiaMiembros`, espejo de `memberships`.
//
// El literal "guardia" se repite a propósito en los dos ejes. Nombrar
// "guarda" al de la compañía los haría distinguibles por una letra, que es
// una fábrica de errores silenciosos; como viven en tablas distintas y con
// validadores distintos, la ambigüedad real es nula.
// ─────────────────────────────────────────────────────────────

export const COMPANIA_ROLES = [
  "admin_compania", // gestiona el personal y las asignaciones de su compañía
  "supervisor", // supervisa la operación en los conjuntos donde se le asigne
  "guardia", // opera la portería en los conjuntos donde se le asigne
] as const;

export type CompaniaRole = (typeof COMPANIA_ROLES)[number];

export const companiaRoleValidator = v.union(
  v.literal("admin_compania"),
  v.literal("supervisor"),
  v.literal("guardia"),
);

/**
 * UN USUARIO DE COMPAÑÍA = UN ÚNICO ROL DE COMPAÑÍA.
 *
 * `companiaMiembros.roles` sigue siendo un array —cambiar la forma de la
 * tabla obligaría a migrar el esquema y a reescribir los ciento y pico sitios
 * que hoy preguntan `roles.includes(...)`, que funcionan igual de bien con un
 * array de un elemento—. Lo que cambia es que ahora hay una sola longitud
 * válida, y se comprueba aquí en vez de en cada formulario.
 *
 * El motivo es de ruteo, no de permisos: tras el login el sistema tiene que
 * poder decir a qué experiencia lleva a esta persona, y con dos roles a la vez
 * —guarda Y supervisor— no hay respuesta. La alternativa era desempatar por
 * orden de comprobación en el cliente, que es exactamente la clase de regla
 * que se olvida de actualizar cuando aparece el tercer rol.
 *
 * OJO: esto es SOLO el eje de vigilancia. `memberships.roles` sigue siendo
 * multi-rol a propósito —alguien es propietario Y miembro de la junta— y no
 * debe pasar por aquí.
 *
 * Lanza en vez de normalizar: quedarse en silencio con el primero de dos
 * roles enviados por error deja a una persona con menos permisos de los que
 * quien la dio de alta cree haberle puesto, y eso no se descubre hasta que
 * no puede entrar.
 */
export function exigirRolUnicoCompania(
  roles: readonly CompaniaRole[],
): CompaniaRole {
  if (roles.length === 0) throw new Error("Selecciona un rol.");
  if (roles.length > 1) {
    throw new Error(
      "Una persona solo puede tener un rol en la compañía. Selecciona uno.",
    );
  }
  return roles[0]!;
}

/**
 * El rol de un miembro tal como lo leen el ruteo y la interfaz.
 *
 * Tolerante a propósito, al revés que `exigirRolUnicoCompania`: las filas
 * anteriores a la regla pueden traer varios roles hasta que se normalicen, y
 * una pantalla que reviente al pintarlas sería peor que una que muestre el de
 * mayor responsabilidad. La jerarquía es la misma que usa la normalización.
 */
export function rolPrincipalDeCompania(
  roles: readonly CompaniaRole[],
): CompaniaRole | null {
  for (const rol of COMPANIA_ROLES) {
    if (roles.includes(rol)) return rol;
  }
  return null;
}

/**
 * Estado de la compañía. El único enum nuevo del modelo.
 *
 * `suspendida` existe porque un booleano no puede expresar "bloqueada pero
 * todavía contratada": la plataforma necesita cortar la operación de una
 * compañía —impago, incidente— sin terminar sus contratos, porque terminarlos
 * invalidaría todas sus asignaciones y perdería la relación comercial.
 */
export const estadoCompaniaValidator = v.union(
  v.literal("activa"),
  v.literal("suspendida"),
  v.literal("inactiva"),
);

export type EstadoCompania = "activa" | "suspendida" | "inactiva";

/**
 * Rol con el que alguien queda asignado a un conjunto concreto.
 *
 * Valor único y no array: en un conjunto se es una cosa. Va en la asignación
 * y no en la persona para que un supervisor pueda cubrir un turno como guarda
 * en otro conjunto sin cambiar quién es.
 */
export const rolAsignacionValidator = v.union(
  v.literal("supervisor"),
  v.literal("guardia"),
);

export type RolAsignacion = "supervisor" | "guardia";

/** Caso operativo de vigilancia; independiente de la prioridad de una novedad. */
export const prioridadIncidenteValidator = v.union(
  v.literal("BAJA"), v.literal("MEDIA"), v.literal("ALTA"), v.literal("CRITICA"),
);
export const estadoIncidenteValidator = v.union(
  v.literal("REPORTADO"), v.literal("EN_INVESTIGACION"),
  v.literal("EN_SEGUIMIENTO"), v.literal("RESUELTO"), v.literal("CERRADO"),
);
export const tipoEventoIncidenteValidator = v.union(
  v.literal("CREACION"), v.literal("CLASIFICACION"),
  v.literal("CAMBIO_PRIORIDAD"), v.literal("ASIGNACION"),
  v.literal("CAMBIO_ESTADO"), v.literal("SEGUIMIENTO"),
  v.literal("CAMBIO_RELEVANTE"), v.literal("RESOLUCION"),
  v.literal("CIERRE"), v.literal("PERSONA_AGREGADA"),
);

// ─────────────────────────────────────────────────────────────
// INVENTARIO DE LA COMPAÑÍA
//
// Los elementos físicos que la empresa entrega a su gente: radios, linternas,
// chalecos, bastones. Pertenecen a la COMPAÑÍA, no al conjunto: sobreviven a
// perder un contrato y se mueven de una portería a otra.
// ─────────────────────────────────────────────────────────────

/**
 * CONDICIÓN del elemento. NO es dónde está ni quién lo tiene.
 *
 * La distinción es la decisión estructural del módulo. La tentación es meter
 * aquí "asignado" o "en conjunto", y entonces un radio averiado que además
 * está prestado a un guarda no se puede representar: hay que elegir una de
 * las dos verdades y se pierde la otra. La custodia se derivará de filas con
 * vigencia —como hace `asignaciones` con el personal—, y este enum se queda
 * hablando solo del estado físico del aparato.
 *
 * Un único valor hoy a propósito. `averiado`, `mantenimiento` y `perdido`
 * son las siguientes y entran añadiendo un literal, que en Convex es un
 * cambio retrocompatible: las filas existentes siguen validando. Declararlos
 * ahora sería peor —serían estados a los que ninguna operación lleva, y el
 * primero que los usara descubriría que nadie decidió qué significan para el
 * resto del sistema—.
 */
export const estadoItemValidator = v.union(v.literal("disponible"));

export type EstadoItem = "disponible";

/**
 * Los eventos del historial de un elemento.
 *
 * Enum y no texto libre: sobre texto libre no se puede filtrar, ni contar, ni
 * pintar un icono distinto, ni construir después "todo lo que le pasó a este
 * radio en la portería norte". La descripción legible va aparte y se compone
 * al escribir.
 *
 * Solo los cuatro que alguna operación produce hoy. Los de asignación
 * —`ITEM_ASSIGNED_TO_CONDOMINIUM`, `ITEM_ASSIGNED_TO_GUARD`, `ITEM_RETURNED`—
 * y los de condición —`ITEM_DAMAGED`, `ITEM_MAINTENANCE`— entran igual que los
 * estados: añadiendo un literal, sin tocar lo escrito.
 */
export const tipoNovedadItemValidator = v.union(
  v.literal("ITEM_CREATED"),
  v.literal("ITEM_UPDATED"),
  v.literal("ITEM_ARCHIVED"),
  /** Alta por carga masiva. Se separa de `ITEM_CREATED` porque responde a
   *  "¿esto lo tecleó alguien o entró en el Excel de marzo?", que es la
   *  primera pregunta cuando aparecen doscientos elementos iguales. */
  v.literal("ITEM_IMPORTED"),

  /**
   * La custodia: el elemento sale a un conjunto y vuelve.
   *
   * Dos literales y no uno con un campo "direccion" porque son dos hechos
   * distintos que se leen distinto en la linea de tiempo, y porque filtrar
   * "todo lo que salio y no ha vuelto" tiene que poder hacerse por el tipo.
   *
   * El conjunto va en `inventarioNovedades.condominioId`, que la tarea 1 dejo
   * declarado justamente para esto.
   */
  v.literal("ITEM_ASSIGNED_TO_CONDOMINIUM"),
  v.literal("ITEM_RETURNED_FROM_CONDOMINIUM"),

  /**
   * La custodia INTERNA del conjunto: el supervisor entrega el elemento a un
   * guarda y se lo recibe de vuelta.
   *
   * Son otro nivel, no otro valor del mismo: mientras un guarda lo tiene, el
   * elemento SIGUE asignado al conjunto. Por eso hay cuatro literales y no
   * dos con un campo "a quién": la linea de tiempo tiene que poder decir
   * "salió a la portería" y "se lo quedó Juan" como dos hechos distintos.
   */
  v.literal("ITEM_ASSIGNED_TO_GUARD"),
  v.literal("ITEM_RETURNED_BY_GUARD"),

  /**
   * Una nota sobre el elemento. NO cambia su estado.
   *
   * "El radio presenta interferencia" es una observación, no un diagnóstico:
   * convertirla automáticamente en `averiado` haría que cualquiera pudiera
   * sacar material de circulación con una frase, y que el estado dejara de
   * significar lo que dice. Quien decide que un radio está averiado es una
   * operación propia, y todavía no existe.
   *
   * Va al MISMO historial y no a una bitácora aparte: el modelo de la tarea 1
   * ya lo soporta entero —conjunto, guarda, actor, descripción, fecha— y una
   * segunda auditoría partiría en dos la historia del elemento.
   */
  v.literal("ITEM_NOTE"),
);

export type TipoNovedadItem =
  | "ITEM_CREATED"
  | "ITEM_UPDATED"
  | "ITEM_ARCHIVED"
  | "ITEM_IMPORTED"
  | "ITEM_ASSIGNED_TO_CONDOMINIUM"
  | "ITEM_RETURNED_FROM_CONDOMINIUM"
  | "ITEM_ASSIGNED_TO_GUARD"
  | "ITEM_RETURNED_BY_GUARD"
  | "ITEM_NOTE";
