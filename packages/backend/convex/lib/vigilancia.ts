/**
 * Las cuentas del modelo de vigilancia: vigencias, solapes y capacidades.
 *
 * Aparte del resto del modulo porque no tocan la base. Que un contrato este
 * vigente, que dos asignaciones choquen o que un rol habilite una operacion
 * son decisiones que conviene poder probar sin levantar nada, igual que se
 * hizo con `lib/ronda.ts`.
 */

/**
 * Un dia de margen al final.
 *
 * El contrato que vence "el 31" cubre el 31 completo, no hasta las 00:00 de
 * ese dia. Es el mismo criterio que `model/authz.ts:vigentes()` aplica a los
 * vinculos de unidad, y tienen que coincidir: si no, un arrendatario y un
 * guarda con la misma fecha de fin dejarian de tener acceso en dias
 * distintos.
 */
export const FIN_DEL_DIA = 24 * 60 * 60 * 1000;

/** Periodo de validez. Sin `vigenciaHasta` es indefinido. */
export type Rango = {
  vigenciaDesde: number;
  vigenciaHasta?: number | undefined;
  /**
   * CORTE INMEDIATO. El instante exacto en que se terminó a mano.
   *
   * `vigenciaHasta` es una FECHA —sale de un `<input type="date">` y por eso
   * `finDe` le suma el día entero—, así que no puede expresar "se acaba
   * ahora": terminar un contrato hoy lo dejaba vigente hasta mañana, y quien
   * pulsaba el botón no veía cambiar absolutamente nada. Ése era el bug.
   *
   * Se separa en lugar de retroceder `vigenciaHasta` porque son dos hechos
   * distintos: hasta cuándo se pactó y cuándo se cortó. Escribir "terminó
   * ayer" para conseguir el efecto habría falseado el histórico, que es justo
   * lo que este modelo existe para no hacer.
   *
   * Opcional: los rangos que no se cortaron a mano —todos los existentes— se
   * comportan exactamente igual que antes.
   */
  terminadoEn?: number | undefined;
};

/** Estado derivado de las fechas. No se guarda: se calcula al leer. */
export type EstadoVigencia = "programada" | "vigente" | "terminada";

/**
 * Instante en que el rango deja de cubrir. `Infinity` si es indefinido.
 *
 * Manda el que llegue primero: un corte a mano no puede alargar lo pactado, y
 * una fecha de fin posterior no puede resucitar lo ya cortado.
 */
export function finDe(r: Rango): number {
  const porFecha =
    r.vigenciaHasta == null ? Infinity : r.vigenciaHasta + FIN_DEL_DIA;
  return r.terminadoEn == null ? porFecha : Math.min(porFecha, r.terminadoEn);
}

/**
 * Si el rango cubre este instante.
 *
 * Se filtra al leer y no con un cron a proposito: un cron se puede caer,
 * atrasar o no haber corrido todavia, y el dia que eso pase habria personal
 * de una compania sin contrato entrando a un conjunto. Filtrando al leer, el
 * corte es exacto.
 */
export function estaVigente(r: Rango, ahora: number = Date.now()): boolean {
  return r.vigenciaDesde <= ahora && ahora < finDe(r);
}

/**
 * Terminado gana a programado.
 *
 * Un contrato que empieza el mes que viene y se cancela hoy esta TERMINADO,
 * no "programado": preguntar primero por el fin es lo que evita que aparezca
 * como pendiente de arrancar hasta la fecha en que iba a hacerlo. Para un
 * rango sin corte a mano el resultado es identico al de siempre, porque
 * `vigenciaDesde <= finDe` se cumple solo.
 */
export function estadoVigencia(
  r: Rango,
  ahora: number = Date.now(),
): EstadoVigencia {
  if (ahora >= finDe(r)) return "terminada";
  if (ahora < r.vigenciaDesde) return "programada";
  return "vigente";
}

/** Deja solo lo que cubre este instante. */
export function vigentes<T extends Rango>(
  items: readonly T[],
  ahora: number = Date.now(),
): T[] {
  return items.filter((i) => estaVigente(i, ahora));
}

/**
 * Si dos periodos se pisan en algun momento.
 *
 * Dos rangos que se tocan justo en el borde NO se solapan: un contrato que
 * termina el 30 de junio y otro que empieza el 1 de julio es un relevo
 * limpio, y tratarlo como conflicto obligaria a dejar un dia sin vigilancia.
 */
export function haySolape(a: Rango, b: Rango): boolean {
  return a.vigenciaDesde < finDe(b) && b.vigenciaDesde < finDe(a);
}

/**
 * `interno` recortado a lo que `externo` le permite cubrir de verdad.
 *
 * Una asignacion no puede dar acceso mas alla de su contrato: asi esta hecho
 * el modelo —cuelga del contrato justamente para que terminarlo corte a todo
 * su personal sin tocar una fila—, y `asignacionVigente` ya lo aplica al
 * leer. Pero una asignacion sin `vigenciaHasta` bajo un contrato terminado
 * SIGUE pareciendo abierta si se mira la fila sola, y ahi es donde se
 * colaba el error: un contrato de pruebas terminado hace meses bloqueaba
 * asignaciones nuevas para siempre.
 *
 * Recortar antes de comparar deja las dos lecturas —quien puede operar y que
 * choca con que— diciendo lo mismo.
 */
export function acotado(interno: Rango, externo: Rango): Rango {
  const fin = Math.min(finDe(interno), finDe(externo));
  return {
    vigenciaDesde: Math.max(interno.vigenciaDesde, externo.vigenciaDesde),
    /* `terminadoEn` y no `vigenciaHasta`: es un instante exacto, ya calculado,
     * al que no hay que regalarle el dia entero otra vez. */
    terminadoEn: Number.isFinite(fin) ? fin : undefined,
  };
}

/**
 * Si el periodo `interno` cabe dentro de `externo`.
 *
 * Una asignacion no puede durar mas que el contrato que la ampara: asignar
 * un guarda hasta enero bajo un contrato que termina en diciembre promete un
 * acceso que el modelo va a negar, y el error aparece un mes despues en la
 * porteria en vez de al guardar.
 */
export function cabeDentro(interno: Rango, externo: Rango): boolean {
  return (
    interno.vigenciaDesde >= externo.vigenciaDesde &&
    finDe(interno) <= finDe(externo)
  );
}

// ─────────────────────────────────────────────────────────────
// Capacidades
//
// Reemplazan a las listas de roles sueltas que hoy declara cada modulo
// (`GUARD_ROLES` esta duplicada en guardia.ts, rondas.ts y aporte.ts, y
// novedades.ts tiene otra distinta). Con dos ejes de pertenencia la pregunta
// "puede operar aqui" deja de ser un rol: es rol + contrato + vigencia, y una
// lista de literales no puede expresar eso.
// ─────────────────────────────────────────────────────────────

export const CAPACIDADES = [
  /** Abrir y cerrar turno, minuta, rondas, visitantes, paqueteria, novedades. */
  "porteria.operar",
  /** Leer todo lo de porteria sin escribir. */
  "porteria.ver",
  /** Zonas de ronda, plantillas de checklist, motivos de vehiculo. */
  "porteria.configurar",
  /** Mover una novedad a cobrada o descartada. */
  "porteria.gestionar",
  /** Alta, baja y roles del personal de una compania. */
  "seguridad.personal",
  /** Crear y terminar asignaciones bajo un contrato. */
  "seguridad.asignar",
  /** Crear, suspender y terminar contratos compania <-> conjunto. */
  "seguridad.contratar",
  /**
   * Terminar un contrato de LA PROPIA compania.
   *
   * Aparte de `seguridad.contratar` a proposito: firmar un contrato es la
   * relacion comercial del SaaS y sigue siendo solo de la plataforma, pero
   * renunciar al servicio que uno presta es una decision de la empresa. Darle
   * `seguridad.contratar` al administrador de compania para que pudiera
   * terminar le habria dejado tambien contratar conjuntos a su antojo.
   */
  "seguridad.terminar",

  /**
   * Ver el inventario de la propia compania.
   *
   * Separada de gestionar porque el dia que el supervisor necesite consultar
   * que radios hay antes de pedir uno, se le da esta y no la otra: mirar la
   * bodega no es poder darla de baja. Hoy no la tiene nadie mas que el
   * administrador, pero la costura ya esta hecha.
   */
  "inventario.ver",
  /** Crear, editar, archivar e importar elementos del inventario. */
  "inventario.gestionar",
  /**
   * Entregar a un guarda el material que el conjunto ya tiene, y recibirlo.
   *
   * Separada de `inventario.gestionar` y no reutilizada: aquella es de
   * COMPANIA ENTERA —quien la tiene puede crear, editar, archivar e importar
   * todo el inventario— y esto es la custodia interna de UN conjunto. Darle
   * la de compania al supervisor para que pudiera repartir radios le habria
   * abierto la bodega completa de la empresa.
   *
   * Vive en `POR_ROL_ASIGNACION`, que es por conjunto, asi que el supervisor
   * de la zona norte no reparte material en la zona sur.
   */
  "inventario.custodiar",
  /** Casos de la compañía; el alcance concreto se comprueba sobre compañía y conjunto. */
  "incidentes.ver",
  "incidentes.crear",
  "incidentes.gestionar",
  "incidentes.cerrar",
  /**
   * Registrar, consultar y anular las inasistencias de los guardas.
   *
   * La tiene el administrador para toda su compañía y el supervisor solo
   * sobre los guardas que hoy trabajan en alguno de los conjuntos que
   * supervisa: va en `POR_ROL_ASIGNACION`, igual que `inventario.custodiar`.
   * El guarda no la tiene: no registra ni anula sus propias inasistencias.
   */
  "seguridad.inasistencias",
] as const;

export type Capacidad = (typeof CAPACIDADES)[number];

/** Rol operativo dentro de un conjunto, tal como vive en `memberships.roles`. */
type RolConjunto = string;

/**
 * Lo que habilita cada rol del eje residencial.
 *
 * Replica lo que hoy hacen las constantes locales: GUARD_ROLES incluye a
 * administrador y junta_directiva, no solo a guardia.
 */
const POR_ROL_CONJUNTO: Record<string, readonly Capacidad[]> = {
  administrador: [
    "porteria.operar",
    "porteria.ver",
    "porteria.configurar",
    "porteria.gestionar",
  ],
  junta_directiva: ["porteria.operar", "porteria.ver", "porteria.configurar"],
  guardia: ["porteria.operar", "porteria.ver"],
  contadora: [],
};

/**
 * Lo que habilita el rol con el que alguien esta asignado a un conjunto.
 *
 * El guarda de compania recibe hoy lo mismo que el guarda directo. La
 * distincion existe como costura —son dos tablas distintas— pero no se
 * estrecha todavia: hacerlo bien exige decidir que datos personales de los
 * residentes puede tratar un tercero, y eso es una decision legal (Ley 1581)
 * que no corresponde tomar aqui. Cuando se tome, se cambia esta tabla y no
 * ciento noventa llamadas.
 */
const POR_ROL_ASIGNACION: Record<string, readonly Capacidad[]> = {
  guardia: ["porteria.operar", "porteria.ver", "incidentes.ver", "incidentes.crear"],
  supervisor: ["porteria.ver", "seguridad.asignar", "seguridad.inasistencias", "inventario.custodiar", "incidentes.ver", "incidentes.crear", "incidentes.gestionar"],
};

/** Lo que habilita pertenecer a una compania, sin mirar conjunto alguno. */
/*
 * El administrador de compania NO recibe `inventario.custodiar`.
 *
 * Conserva la consulta —`inventarioAsignaciones.porCondominio` dice que hay
 * en cada porteria y quien lo tiene— pero repartir material dentro de un
 * conjunto es del supervisor, que es quien esta alli. Darselo "por si acaso"
 * habria hecho que dos personas con criterios distintos movieran el mismo
 * material sin coordinarse.
 */
const POR_ROL_COMPANIA: Record<string, readonly Capacidad[]> = {
  admin_compania: [
    "seguridad.personal",
    "seguridad.asignar",
    "seguridad.terminar",
    /* El inventario es de la empresa y lo lleva quien la administra. El
     * supervisor y el guarda no aparecen aqui a proposito: entregar y recibir
     * elementos es la tarea 3, y darles permiso antes de que exista ese flujo
     * les abriria hoy el CRUD entero de la bodega. */
    "inventario.ver",
    "inventario.gestionar",
    "incidentes.ver",
    "incidentes.crear",
    "incidentes.gestionar",
    "incidentes.cerrar",
    "seguridad.inasistencias",
  ],
  supervisor: [],
  guardia: [],
};

function desde(
  tabla: Record<string, readonly Capacidad[]>,
  roles: readonly string[],
): Set<Capacidad> {
  const out = new Set<Capacidad>();
  for (const rol of roles) {
    for (const cap of tabla[rol] ?? []) out.add(cap);
  }
  return out;
}

export function capacidadesDeRolesConjunto(
  roles: readonly RolConjunto[],
): Set<Capacidad> {
  return desde(POR_ROL_CONJUNTO, roles);
}

export function capacidadesDeRolAsignacion(rol: string): Set<Capacidad> {
  return desde(POR_ROL_ASIGNACION, [rol]);
}

export function capacidadesDeRolesCompania(
  roles: readonly string[],
): Set<Capacidad> {
  return desde(POR_ROL_COMPANIA, roles);
}

/** El staff de plataforma mantiene el paso libre que ya tiene hoy. */
export function capacidadesDePlataforma(): Set<Capacidad> {
  return new Set(CAPACIDADES);
}

export function unir(...conjuntos: Set<Capacidad>[]): Set<Capacidad> {
  const out = new Set<Capacidad>();
  for (const c of conjuntos) for (const x of c) out.add(x);
  return out;
}
