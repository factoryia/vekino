import type { QueryCtx, MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import {
  estaActiva,
  proximoCambioDeContexto,
  ventanaQueOcupa,
} from "../lib/coberturas";
import type { CoberturaQueOcupa } from "../lib/disponibilidad";
import { estaVigente, finDe } from "../lib/vigilancia";
import { cacheDeCadena, type CacheDeCadena } from "./asignacion";
import { rolPrincipalDeCompania } from "./roles";

type Ctx = QueryCtx | MutationCtx;

/**
 * Las coberturas de un guarda leídas para tres preguntas: qué lo ocupa
 * (disponibilidad), cuáles están activas (pantalla) y cuál le da HOY una vía
 * de guarda en otro conjunto (acceso).
 *
 * Solo la tercera da acceso, y no la da la fila sola: la da la cobertura
 * aceptada, dentro de su ventana, que además pasa su propia cadena. Las reglas
 * del ciclo de vida viven en `lib/coberturas.ts`; aquí se leen las filas y se
 * juzga la cadena.
 */

/**
 * Las coberturas de un guarda en un estado que todavía no terminan en
 * `desde`. Por `fin`, así que el histórico no se recorre.
 */
async function sinTerminar(
  ctx: Ctx,
  userId: Id<"users">,
  estado: Doc<"coberturas">["estado"],
  desde: number,
): Promise<Doc<"coberturas">[]> {
  return await ctx.db
    .query("coberturas")
    .withIndex("by_user_estado_fin", (q) =>
      q.eq("userId", userId).eq("estado", estado).gt("fin", desde),
    )
    .collect();
}

/** Las aceptadas de un guarda que todavía no terminan: la que corre y las que vienen. */
async function aceptadasSinTerminar(
  ctx: Ctx,
  userId: Id<"users">,
  ahora: number,
): Promise<Doc<"coberturas">[]> {
  return await sinTerminar(ctx, userId, "aceptada", ahora);
}

/**
 * Lo que ya ocupa al guarda durante una ventana, en CUALQUIER conjunto y
 * compañía: una aceptada lo ocupa entera; una inhabilitada, hasta su corte.
 *
 * Es la única carga de coberturas de la disponibilidad —individual, masiva y
 * la que revalida `crear` y `aceptar`—: si la lista dijera "disponible" y la
 * solicitud "ocupado", sería porque alguna de las dos leyó otra cosa. Mira
 * todas las compañías a propósito: la compañía que pregunta decide a qué
 * guardas alcanza, no qué compromisos suyos existen.
 *
 * Solo lee las que no habían terminado al empezar la ventana (por `fin`), así
 * que no recorre el histórico del guarda.
 *
 * Una aceptada cuenta solo si su cadena sigue en pie (`cadenaEnPie`): si el
 * guarda ya no es de esa compañía, o le terminaron el contrato, esa cobertura
 * no lo va a llevar a ninguna parte y no debe tenerlo "ocupado" para siempre
 * (QA-001). Una inhabilitada ocupó lo que ocupó hasta su corte, como antes.
 */
export async function coberturasQueOcupan(
  ctx: Ctx,
  userId: Id<"users">,
  ventana: { inicio: number; fin: number },
): Promise<CoberturaQueOcupa[]> {
  const [aceptadas, inhabilitadas] = await Promise.all([
    sinTerminar(ctx, userId, "aceptada", ventana.inicio),
    sinTerminar(ctx, userId, "inhabilitada", ventana.inicio),
  ]);
  const ahora = Date.now();
  const cache = cacheDeCadena(ctx);
  const vigentes = [];
  for (const c of aceptadas) {
    if (await cadenaEnPie(ctx, c, ahora, cache)) vigentes.push(c);
  }
  return [...vigentes, ...inhabilitadas].flatMap((c) => {
    const ocupa = ventanaQueOcupa(c);
    return ocupa && ocupa.inicio < ventana.fin && ocupa.fin > ventana.inicio
      ? [{ id: c._id, condominioId: c.condominioId, ...ocupa }]
      : [];
  });
}

/**
 * La cobertura ACEPTADA del guarda que se cruza con una ventana, si la hay,
 * en cualquier conjunto y compañía.
 *
 * Es la contradicción que no puede existir: una cobertura aceptada es un
 * compromiso confirmado y una inasistencia dice que ese guarda no está. Solo
 * las aceptadas: una inhabilitada ya no compromete a nadie, que es justamente
 * el camino para registrar una incapacidad en mitad de una cobertura
 * (inhabilitarla primero). Intervalos semiabiertos: tocarse en un borde no es
 * cruzarse.
 *
 * Y solo las que siguen siendo una vía posible (`cadenaEnPie`). Una cobertura
 * de otra compañía de la que el guarda ya se fue no compromete a nadie, y
 * nadie con acceso a esta compañía podía inhabilitarla: bloqueaba la
 * inasistencia sin salida (QA-001). La fila se conserva como histórico.
 */
export async function coberturaAceptadaQueSolapa(
  ctx: Ctx,
  userId: Id<"users">,
  ventana: { inicio: number; fin: number },
): Promise<Doc<"coberturas"> | null> {
  const vivas = await sinTerminar(ctx, userId, "aceptada", ventana.inicio);
  const ahora = Date.now();
  const cache = cacheDeCadena(ctx);
  for (const c of vivas) {
    if (c.inicio < ventana.fin && (await cadenaEnPie(ctx, c, ahora, cache))) return c;
  }
  return null;
}

/**
 * Las coberturas activas de un guarda: aceptadas y con `ahora` dentro de su
 * ventana. Derivado al leer, nunca guardado. Es la lista que se PINTA: no
 * mira la cadena, eso es cosa de `coberturaActivaDeGuardia`, que es la ÚNICA
 * que decide acceso. Esto no se usa para autorizar nada.
 */
export async function coberturasActivasDe(
  ctx: Ctx,
  userId: Id<"users">,
  ahora: number,
): Promise<Doc<"coberturas">[]> {
  const vivas = await aceptadasSinTerminar(ctx, userId, ahora);
  return vivas.filter((c) => estaActiva(c, ahora));
}

/**
 * Una cobertura que da acceso AHORA, con la procedencia a la vista.
 *
 * Tiene los mismos campos de arriba que las otras vías de `model/vias.ts`
 * —quién, dónde, por qué compañía, con qué rol— y los documentos que la
 * prueban. El rol es siempre `guardia`: solo un guarda de la compañía puede
 * cubrir (`exigirElegible` en `coberturas.ts`).
 */
export type ViaCobertura = {
  tipo: "cobertura";
  userId: Id<"users">;
  condominioId: Id<"condominios">;
  companiaId: Id<"companiasSeguridad">;
  rol: "guardia";
  cobertura: Doc<"coberturas">;
  contrato: Doc<"companiaContratos">;
  compania: Doc<"companiasSeguridad">;
  condominio: Doc<"condominios">;
};

/** La persona sigue de alta en la compañía, y como guarda. */
async function guardaDeAlta(
  ctx: Ctx,
  companiaId: Id<"companiasSeguridad">,
  userId: Id<"users">,
): Promise<boolean> {
  const filas = await ctx.db
    .query("companiaMiembros")
    .withIndex("by_compania_user", (q) =>
      q.eq("companiaId", companiaId).eq("userId", userId),
    )
    .collect();
  return filas.some(
    (m) => m.isActive && rolPrincipalDeCompania(m.roles) === "guardia",
  );
}

/*
 * LA CADENA DE LA COBERTURA.
 *
 * Los mismos cinco eslabones que la asignación (`model/asignacion.ts`), sobre
 * la fila de la cobertura en vez de la de la asignación:
 *
 *   1. aceptada y `ahora` dentro de [inicio, fin)  → `estaActiva`;
 *   2. su contrato existe, es del mismo par compañía-conjunto y está vigente
 *      (terminarlo corta la cobertura en ese instante);
 *   3. la compañía está activa (suspenderla la corta);
 *   4. el guarda sigue de alta en ella, como guarda (darlo de baja la corta);
 *   5. el conjunto existe y está activo.
 *
 * Ninguna fila se toca: cuando un eslabón cae, la cobertura deja de ser vía
 * al leer, y el guarda vuelve a sus vías permanentes sin que nadie haga nada.
 * El contrato, la compañía y el conjunto se leen con los lectores de la
 * cadena de asignación, para compartir el caché cuando se juzgan varias.
 */
/**
 * Los eslabones 2 a 5 sin mirar el reloj de la ventana: si la cobertura,
 * llegado su momento, todavía podría ser una vía. Contrato del mismo par y sin
 * terminar, compañía activa, guarda de alta en ella y conjunto activo.
 *
 * Es el "operativamente válida" de la planificación (QA-001): lo usan la
 * disponibilidad y la regla de la inasistencia, nunca el acceso, que sigue
 * siendo solo de `coberturaActivaDeGuardia`.
 */
async function cadenaEnPie(
  ctx: Ctx,
  c: Doc<"coberturas">,
  ahora: number,
  cache: CacheDeCadena,
): Promise<boolean> {
  const contrato = await cache.contrato(c.contratoId);
  if (
    !contrato ||
    contrato.companiaId !== c.companiaId ||
    contrato.condominioId !== c.condominioId ||
    finDe(contrato) <= ahora
  ) {
    return false;
  }
  const compania = await cache.compania(c.companiaId);
  if (!compania || compania.estado !== "activa") return false;
  if (!(await guardaDeAlta(ctx, c.companiaId, c.userId))) return false;
  const condominio = await cache.condominio(c.condominioId);
  return !!condominio && condominio.isActive;
}

async function viaDeCobertura(
  ctx: Ctx,
  c: Doc<"coberturas">,
  ahora: number,
  cache: CacheDeCadena,
): Promise<ViaCobertura | null> {
  if (!estaActiva(c, ahora)) return null;

  const contrato = await cache.contrato(c.contratoId);
  if (
    !contrato ||
    contrato.companiaId !== c.companiaId ||
    contrato.condominioId !== c.condominioId ||
    !estaVigente(contrato, ahora)
  ) {
    return null;
  }

  const compania = await cache.compania(c.companiaId);
  if (!compania || compania.estado !== "activa") return null;

  if (!(await guardaDeAlta(ctx, c.companiaId, c.userId))) return null;

  const condominio = await cache.condominio(c.condominioId);
  if (!condominio || !condominio.isActive) return null;

  return {
    tipo: "cobertura",
    userId: c.userId,
    condominioId: c.condominioId,
    companiaId: c.companiaId,
    rol: "guardia",
    cobertura: c,
    contrato,
    compania,
    condominio,
  };
}

/**
 * La cobertura con la que un guarda opera HOY, si tiene una.
 *
 *   ninguna       → opera con sus vías permanentes, como siempre;
 *   activa        → opera como guarda SOLO en el conjunto de la cobertura;
 *   inconsistente → hay más de una que pasa la cadena a la vez. No debería
 *                   ocurrir —crear y aceptar rechazan los choques—, y si
 *                   ocurre no se elige ninguna: elegir sería adivinar en qué
 *                   portería está. Quien pregunta lo trata como bloqueo.
 *
 * `refrescarEn` es el próximo instante en que la respuesta cambia sola (ver
 * `proximoCambioDeContexto`). Se calcula con TODAS las aceptadas que no han
 * terminado, pasen o no su cadena: es solo un aviso de cuándo volver a
 * preguntar, y preguntar de más no cuesta nada.
 */
export type CoberturaActivaDeGuardia =
  | { estado: "ninguna"; refrescarEn: number | null }
  | { estado: "activa"; via: ViaCobertura; refrescarEn: number | null }
  | {
      estado: "inconsistente";
      coberturaIds: Id<"coberturas">[];
      refrescarEn: number | null;
    };

export async function coberturaActivaDeGuardia(
  ctx: Ctx,
  userId: Id<"users">,
  ahora: number = Date.now(),
): Promise<CoberturaActivaDeGuardia> {
  const vivas = await aceptadasSinTerminar(ctx, userId, ahora);
  const refrescarEn = proximoCambioDeContexto(vivas, ahora);
  if (vivas.length === 0) return { estado: "ninguna", refrescarEn };

  const cache = cacheDeCadena(ctx);
  const vias = (
    await Promise.all(vivas.map((c) => viaDeCobertura(ctx, c, ahora, cache)))
  ).filter((v): v is ViaCobertura => v !== null);

  const [unica, ...otras] = vias;
  if (!unica) return { estado: "ninguna", refrescarEn };
  if (otras.length === 0) return { estado: "activa", via: unica, refrescarEn };
  return {
    estado: "inconsistente",
    coberturaIds: vias.map((v) => v.cobertura._id),
    refrescarEn,
  };
}

/**
 * Las coberturas que HOY dan vía de guarda en un conjunto, de cualquier
 * persona: los guardas que llegan a esta portería de paso.
 *
 * Cada una se confirma contra el contexto de su guarda: si esa persona tiene
 * dos activas a la vez no está en ninguna de las dos porterías, y no puede
 * salir como relevo en ésta.
 */
export async function coberturasActivasEnConjunto(
  ctx: Ctx,
  condominioId: Id<"condominios">,
  ahora: number = Date.now(),
): Promise<ViaCobertura[]> {
  const filas = await ctx.db
    .query("coberturas")
    .withIndex("by_condominio_estado_fin", (q) =>
      q.eq("condominioId", condominioId).eq("estado", "aceptada").gt("fin", ahora),
    )
    .collect();
  const vias = await Promise.all(
    filas
      .filter((c) => estaActiva(c, ahora))
      .map(async (c) => {
        const suya = await coberturaActivaDeGuardia(ctx, c.userId, ahora);
        return suya.estado === "activa" && suya.via.cobertura._id === c._id
          ? suya.via
          : null;
      }),
  );
  return vias.filter((v): v is ViaCobertura => v !== null);
}

/*
 * LA TRAZABILIDAD: BAJO QUÉ CONTEXTO SE HIZO CADA OPERACIÓN.
 *
 * Dos preguntas que no se mezclan:
 *
 *   ahora     → ¿puede operar aquí? Lo responde `coberturaActivaDeGuardia`
 *               con el reloj de la petición (Fase 8). Es autorización.
 *   entonces  → ¿bajo qué contexto hizo ESTO? Lo responde la propia
 *               operación, que guarda el `coberturaId` con el que se creó.
 *
 * El sello se pone UNA vez, dentro de la mutación que crea la operación y con
 * la misma resolución que acaba de autorizarla (`coberturaQueAmpara`). Nunca
 * se reescribe: que la cobertura termine, la inhabiliten o pierda su contrato
 * cambia quién puede operar desde ese momento, no lo que ya pasó. Y nunca se
 * reconstruye: las lecturas históricas leen el sello
 * (`lectorDeCoberturasHistoricas`), no el contexto actual ni las ventanas de
 * las coberturas. Lo que se creó antes de que existiera el sello no lo tiene
 * y se queda así: no se adivina.
 */

/**
 * La cobertura bajo la que esta persona opera AHORA en este conjunto, o null.
 *
 * Es el sello de una operación nueva: se llama dentro de la mutación que la
 * crea, después de autorizarla, y su resultado se guarda tal cual. Null si no
 * tiene cobertura activa, si la tiene en OTRO conjunto (el guarda que cierra
 * en su conjunto de siempre el turno que dejó abierto antes de cubrir) o si
 * su contexto está bloqueado. No se fía de nada que mande el cliente.
 */
export async function coberturaQueAmpara(
  ctx: Ctx,
  userId: Id<"users">,
  condominioId: Id<"condominios">,
): Promise<Id<"coberturas"> | null> {
  const activa = await coberturaActivaDeGuardia(ctx, userId);
  return activa.estado === "activa" && activa.via.condominioId === condominioId
    ? activa.via.cobertura._id
    : null;
}

/** El contexto de una operación hecha bajo cobertura, tal como se enseña. */
export type CoberturaDeOperacion = {
  coberturaId: Id<"coberturas">;
  condominioId: Id<"condominios">;
  /** La ventana pactada. Ni quién la pidió ni por qué se cortó: no hace falta. */
  inicio: number;
  fin: number;
};

/**
 * Lee el contexto REGISTRADO de operaciones históricas.
 *
 * Devuelve, para cada fila, `{ cobertura }` si se creó bajo una cobertura y
 * `{}` si no: así una fila sin sello sale exactamente igual que antes de que
 * existiera. La cobertura se lee tal cual está guardada, sin mirar el reloj ni
 * su estado: una inhabilitada después sigue amparando lo que se hizo antes.
 * Cada cobertura se lee una sola vez por consulta.
 */
export function lectorDeCoberturasHistoricas(ctx: Ctx) {
  const vistas = new Map<Id<"coberturas">, Promise<CoberturaDeOperacion | null>>();
  const leer = (id: Id<"coberturas">) => {
    if (!vistas.has(id)) {
      vistas.set(
        id,
        ctx.db.get(id).then((c) =>
          c
            ? { coberturaId: c._id, condominioId: c.condominioId, inicio: c.inicio, fin: c.fin }
            : null,
        ),
      );
    }
    return vistas.get(id)!;
  };
  return async (fila: {
    coberturaId?: Id<"coberturas">;
  }): Promise<{ cobertura?: CoberturaDeOperacion }> => {
    if (!fila.coberturaId) return {};
    const cobertura = await leer(fila.coberturaId);
    return cobertura ? { cobertura } : {};
  };
}
