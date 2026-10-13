/**
 * Estado de cartera de una unidad: si debe, y desde cuando.
 *
 * ── De donde sale el dato ────────────────────────────────────────────────
 * De ningun lado nuevo. Ya esta en las facturas que carga la administracion:
 * el estado lo pone la conciliacion por saldo anterior (`facturas.ts`) y el
 * vencimiento viene en la propia factura. Aqui no se decide quien debe: se
 * lee lo que el modulo financiero ya decidio y se traduce a una frase que
 * sirva en una tabla.
 *
 * ── Que cuenta como sin pagar ────────────────────────────────────────────
 * Los tres estados que dejan saldo: `pendiente` (la ultima de la cadena, que
 * todavia no tiene una factura siguiente que la juzgue), `vencida` (la
 * siguiente arrastro la deuda entera) y `abonada` (pago parcial: abonar no es
 * pagar, la unidad sigue debiendo). `pagada` y `saldo_a_favor` estan saldadas.
 *
 * ── Como se miden los dias ───────────────────────────────────────────────
 * Contra el inicio de la mora, no contra la emision: una factura de
 * septiembre no lleva un mes de mora el 20 de septiembre, lleva cero. Desde
 * la Fase 4 la mora empieza el dia 16 del mes siguiente al del periodo
 * (`inicioDeMora`, decision B): el fin de mes es el plazo del precio completo
 * que se le muestra al residente, no el inicio de la mora.
 *
 * ── Que NO hace ──────────────────────────────────────────────────────────
 * No bloquea nada. Devuelve informacion para que la administracion decida:
 * una unidad puede tener mora y un acuerdo de por medio, y esa decision es de
 * quien administra, no de esta funcion.
 *
 * Sin dependencias: se prueba con `node`, sin base de datos.
 */

export type EstadoFactura =
  | "pendiente"
  | "pagada"
  | "vencida"
  | "abonada"
  | "saldo_a_favor";

export type LineaFactura = {
  codigo: number;
  /** Codigo no numerico del documento (`CI`, `NCC`); entonces `codigo` es 0. */
  codigoTexto?: string;
  concepto: string;
  /** Lo que esta linea arrastra del periodo anterior. */
  saldoAnterior: number;
  /** El cargo nuevo del mes. */
  actual: number;
  /** `saldoAnterior + actual`. */
  total: number;
};

/**
 * Marca de una factura cuya lectura no se pudo tomar como cierta (el PDF no
 * cuadra, no trae el total, no se le leyo el periodo...). Ver
 * `lib/lecturaFactura.ts`. Mientras no la confirme la administracion, la
 * factura esta "en revision" (`enRevision`).
 */
export type LecturaDudosa = {
  motivos: readonly string[];
  confirmada?: unknown;
};

/**
 * Lo que la factura siguiente de la cadena dice de esta (Fase 3): el
 * veredicto de la contabilidad, guardado aparte de la evidencia de pago. Ver
 * `lib/estadoFactura.ts`.
 */
export type VeredictoGuardado = {
  estado: Veredicto;
  motivo?: "mes_faltante" | "heredado";
};

/** Hay un pago registrado que la contabilidad todavia no refleja (solo en la vigente). */
export type PagoEnVerificacion = { monto: number };

/**
 * Lo que prueban los pagos APROBADOS de la factura —la pasarela y los
 * comprobantes—, tal como lo guarda la conciliacion (`estadoPago`, Fase 3;
 * lo calcula `evidenciaDePago` en `lib/estadoFactura.ts`). Un comprobante sin
 * revisar o rechazado no esta aqui.
 */
export type EvidenciaGuardada = { estado: "pagada" | "abonada"; montoPagado: number };

/**
 * Lo que hace falta de una factura para juzgar la cartera.
 *
 * `totalAPagar` NO es la cuota del mes: es la deuda acumulada a esa fecha,
 * arrastre incluido. Sin ese dato no se puede responder cuanto debe hoy la
 * unidad, y por eso entra aqui.
 */
export type FacturaCartera = {
  periodo: string;
  estado: EstadoFactura;
  /**
   * Timestamp: el ultimo dia para pagar el precio completo, a medianoche de
   * Colombia. Desde la Fase 3, el ultimo dia del mes del periodo
   * (`vencimientoDePeriodo`); las cargadas antes llevan el dia 15 del mes
   * siguiente. La mora no empieza al dia siguiente sino el 16 del mes
   * siguiente (`inicioDeMora`, Fase 4).
   */
  fechaVencimiento: number;
  /** La deuda acumulada que reclama esta factura. */
  totalAPagar: number;
  lineas: readonly LineaFactura[];
  /** El saldo anterior que imprime el documento (fila Totales), si lo trae. */
  saldoAnteriorDocumento?: number;
  lecturaDudosa?: LecturaDudosa | null;
  veredictoContable?: VeredictoGuardado | null;
  pagoEnVerificacion?: PagoEnVerificacion | null;
  estadoPago?: EvidenciaGuardada | null;
};

/**
 * Si el saldo anterior de la factura es un dato de la contabilidad, es decir,
 * si la factura puede decir algo de la ANTERIOR.
 *
 * Una factura hecha a mano (`facturas.createManual`) no: el formulario no
 * pide saldo anterior y sus lineas lo traen en 0 porque nadie lo escribio.
 * Leer ese 0 como "la anterior quedo pagada" inventaba un pago que nadie hizo
 * y lo sumaba al recaudo (QA de comprobantes, H4). Cuando llega el PDF del
 * mismo periodo la reemplaza (`model/facturas.ts`), y ese si habla.
 */
export function informaSaldoAnterior(f: { origen?: string | null }): boolean {
  return f.origen !== "manual";
}

/**
 * Deuda que la factura declara arrastrar del periodo anterior.
 *
 * Vive aqui y no en `facturas.ts` porque la usan tres: la conciliacion, que
 * con ella decide el estado; el estado de cuenta, que con ella dice cuanto
 * quedo debiendo cada mes; y el saldo vigente. Es la misma cuenta; tenerla
 * repetida era la manera de que un dia dejaran de coincidir.
 *
 * Si el documento imprime su propio saldo anterior (la fila Totales de
 * Ciudad del Campo) manda ese: las lineas pueden venir incompletas —una hoja
 * de continuacion— o sin la fila de un credito, y entonces su suma no es lo
 * que la contabilidad dijo que se debia.
 */
export function saldoAnteriorDe(f: {
  lineas: readonly LineaFactura[];
  saldoAnteriorDocumento?: number;
}): number {
  return f.saldoAnteriorDocumento ?? f.lineas.reduce((s, l) => s + l.saldoAnterior, 0);
}

/**
 * Si la factura esta en revision: su lectura se marco como dudosa y nadie de
 * la administracion la ha confirmado. Con ella no se paga, no se concilia y
 * no se decide "al dia" ni "mora".
 */
export function enRevision(f: { lecturaDudosa?: LecturaDudosa | null }): boolean {
  return !!f.lecturaDudosa && !f.lecturaDudosa.confirmada;
}

/** Tolerancia en pesos para considerar una deuda como saldada (redondeos). */
export const TOLERANCIA_PAGO = 1;

/** "2026-09" → "2026-10". */
export function periodoSiguiente(periodo: string): string {
  const [a, m] = periodo.split("-").map(Number) as [number, number];
  return m === 12 ? `${a + 1}-01` : `${a}-${String(m + 1).padStart(2, "0")}`;
}

/** Si `siguiente` es exactamente el mes despues de `anterior`. */
export function periodosConsecutivos(anterior: string, siguiente: string): boolean {
  return periodoSiguiente(anterior) === siguiente;
}

/**
 * Lo que la conciliacion puede decir de una factura. `sin_veredicto`: entre
 * ella y la siguiente falta un mes, y el saldo anterior no habla de ella.
 */
export type Veredicto = "pagada" | "abonada" | "vencida" | "saldo_a_favor" | "sin_veredicto";

/**
 * El veredicto de la conciliacion sobre una factura, a partir de la factura
 * SIGUIENTE de su cadena: su saldo anterior dice cuanto quedo debiendo la
 * unidad.
 *
 *   saldo anterior == 0                 -> la anterior quedo PAGADA (o en saldo
 *                                          a favor, si su total era negativo)
 *   0 < saldo anterior < total anterior -> ABONADA (pago parcial)
 *   saldo anterior >= total anterior    -> VENCIDA (no pago; con intereses
 *                                          puede venir aun mayor)
 *
 * ── Meses faltantes (F-09) ───────────────────────────────────────────────
 * Solo se juzga un par de meses CONSECUTIVOS. Si entre agosto y octubre falta
 * septiembre, el saldo anterior de octubre es lo que quedo debiendo al cerrar
 * septiembre, que lleva dentro la cuota de septiembre: no dice nada de
 * agosto. Entonces `sin_veredicto`. La excepcion es un saldo anterior en
 * cero: si al cerrar septiembre no se debia nada, agosto tambien quedo
 * saldada, hubiera hueco o no.
 *
 * `null` si el par no se puede juzgar: alguna de las dos esta en revision, y
 * con un documento que no cuadra no se decide si la anterior se pago. Quien
 * llama conserva el veredicto que ya tenia.
 *
 * Tambien `null` si la siguiente es una factura hecha a mano: su saldo
 * anterior no lo escribio nadie (`informaSaldoAnterior`), asi que no dice si
 * la anterior se pago. Con ella la anterior no se juzga; ver
 * `calcularCadena` (`lib/estadoFactura.ts`), que ademas descarta lo que una
 * manual le hubiera puesto antes.
 *
 * Es la regla de la conciliacion (`model/estadoFactura.ts`) y la del
 * re-procesamiento (`lib/reproceso.ts`): una sola, para que lo que se simula
 * sea lo que se aplica.
 */
export function veredictoConciliacion(
  anterior: { periodo: string; totalAPagar: number; lecturaDudosa?: LecturaDudosa | null },
  siguiente: {
    periodo: string;
    lineas: readonly LineaFactura[];
    saldoAnteriorDocumento?: number;
    lecturaDudosa?: LecturaDudosa | null;
    origen?: string | null;
  },
): Veredicto | null {
  if (!informaSaldoAnterior(siguiente)) return null;
  if (enRevision(anterior) || enRevision(siguiente)) return null;
  const deuda = saldoAnteriorDe(siguiente);
  if (deuda <= TOLERANCIA_PAGO) return anterior.totalAPagar < 0 ? "saldo_a_favor" : "pagada";
  if (!periodosConsecutivos(anterior.periodo, siguiente.periodo)) return "sin_veredicto";
  if (deuda < anterior.totalAPagar - TOLERANCIA_PAGO) return "abonada";
  return "vencida";
}

/**
 * Tres estados, y cada uno responde algo distinto.
 *
 * `sin_facturas` no es `al_dia`: en un conjunto al que no le han cargado la
 * cartera, decir "al dia" seria afirmar algo que nadie ha comprobado.
 *
 * `pendiente` es "debe, pero no esta incumpliendo": o la obligacion vigente
 * todavia no vence, o el ultimo periodo que vencio quedo cubierto.
 *
 * Hubo un cuarto, `con_saldo`, para "arrastra deuda vieja pero esta pagando".
 * Se quito: nombraba un saldo anterior que YA esta dentro del saldo vigente,
 * porque cada factura absorbe lo que quedo debiendo la anterior. Era contar
 * dos veces con palabras.
 *
 * `en_revision` no es un estado de deuda: es "no se puede decir". La factura
 * vigente —o la que decide la mora— tiene una lectura dudosa, y afirmar "al
 * dia" o "en mora" con ella seria afirmar lo que el documento no permite.
 */
export type EstadoCartera = "sin_facturas" | "al_dia" | "pendiente" | "en_mora" | "en_revision";

/**
 * Por que una unidad esta `en_revision`:
 *   · `lectura`: la vigente, o el periodo que decidiria la mora, tiene una
 *     lectura dudosa sin confirmar;
 *   · `pago_en_verificacion`: hay un pago registrado que la contabilidad
 *     todavia no refleja (una discrepancia abierta);
 *   · `mes_faltante`: el periodo que decidiria la mora no se puede juzgar
 *     porque falta el mes siguiente.
 */
export type MotivoRevision = "lectura" | "pago_en_verificacion" | "mes_faltante";

export type CarteraUnidad = {
  estado: EstadoCartera;
  /** Lo que la unidad debe HOY. No la suma de saldos historicos. */
  saldoActual: number;
  /** El periodo de la obligacion vigente. */
  periodoActual: string | null;
  /** Dias de la mora ACTUAL. 0 cuando no la hay, por vieja que sea la deuda. */
  diasMora: number;
  /** El periodo que provoca la mora actual. */
  periodoEnMora: string | null;
  /**
   * Su vencimiento: el plazo del precio completo que se le mostro. Desde
   * cuando esta en mora lo dice `inicioDeMora({ periodo: periodoEnMora,
   * fechaVencimiento: vencimientoEnMora })`.
   */
  vencimientoEnMora: number | null;
  /** Solo con `en_revision`. */
  motivoRevision?: MotivoRevision;
  /** Con `pago_en_verificacion`: lo pagado que la contabilidad no muestra. */
  montoEnVerificacion?: number;
};

const DIA = 24 * 60 * 60 * 1000;

const SIN_PAGAR: ReadonlySet<EstadoFactura> = new Set<EstadoFactura>([
  "pendiente",
  "vencida",
  "abonada",
]);

/** Si la factura deja saldo. Abonada tambien: abonar no es pagar. */
export function sinPagar(estado: EstadoFactura): boolean {
  return SIN_PAGAR.has(estado);
}

/**
 * Si la factura muestra que la casa respondio.
 *
 * OJO: no es lo contrario de `sinPagar`, y la diferencia es justo la regla de
 * negocio. `abonada` esta en los DOS conjuntos a proposito: deja saldo —por
 * eso suma a la deuda— y a la vez prueba que hubo un pago —por eso, si es el
 * ultimo periodo vencido, no hay mora—. Una casa que abona todos los meses
 * debe plata y esta cumpliendo; las dos cosas son ciertas al tiempo.
 *
 * `pendiente` no prueba nada: es la ultima de la cadena, a la que ninguna
 * factura posterior ha juzgado todavia. Ausencia de veredicto, no de deuda.
 */
export function conEvidenciaDePago(estado: EstadoFactura): boolean {
  return estado === "pagada" || estado === "abonada" || estado === "saldo_a_favor";
}

/**
 * Si la factura quedo saldada del todo. Para el dinero, no para la mora.
 *
 * `abonada` NO entra: dejo saldo. Es la contraparte de `conEvidenciaDePago`,
 * donde si entra, y esa asimetria es la regla: abonar prueba que la casa
 * responde, pero no borra lo que falta.
 */
export function conEvidenciaTotalDePago(estado: EstadoFactura): boolean {
  return estado === "pagada" || estado === "saldo_a_favor";
}

/** Dias completos entre el vencimiento y hoy. Negativo si aun no vence. */
export function diasDesde(vencimiento: number, ahora: number): number {
  return Math.floor((ahora - vencimiento) / DIA);
}

/**
 * Lo ya abonado a la factura que todavia no la salda: lo que prueban sus
 * pagos aprobados (`estadoPago`) si con ellos quedo `abonada`. 0 sin pagos, y
 * 0 si ya quedo pagada: entonces no hay saldo del cual descontarlo.
 */
export function abonoAprobado(f: { estadoPago?: EvidenciaGuardada | null }): number {
  return f.estadoPago?.estado === "abonada" ? Math.max(0, f.estadoPago.montoPagado) : 0;
}

/**
 * Lo que queda de la deuda que reclama la factura: su total menos lo ya
 * abonado, y nada si esta saldada (`conEvidenciaTotalDePago`). Sin descuento:
 * es la deuda, no el cobro de hoy (ese es `montoAPagarHoy`).
 *
 * Una factura `abonada` sin el monto de sus abonos (un estado heredado de
 * antes de la Fase 3) reporta el total: preferir pasarse a quedarse corto.
 */
function saldoPendienteDe(f: {
  estado: EstadoFactura;
  totalAPagar: number;
  estadoPago?: EvidenciaGuardada | null;
}): number {
  return conEvidenciaTotalDePago(f.estado) ? 0 : f.totalAPagar - abonoAprobado(f);
}

/** Las facturas del periodo mas reciente de la cadena. Normalmente una. */
function delUltimoPeriodo<F extends { periodo: string }>(cadena: readonly F[]): F[] {
  let ultimas: F[] = [];
  for (const f of cadena) {
    const orden = ultimas.length === 0 ? 1 : f.periodo.localeCompare(ultimas[0]!.periodo);
    if (orden > 0) ultimas = [f];
    else if (orden === 0) ultimas.push(f);
  }
  return ultimas;
}

/**
 * La factura vigente de una unidad: la del periodo mas reciente de su cadena.
 *
 * ── Por que esa ──────────────────────────────────────────────────────────
 * Cada factura absorbe lo que quedo debiendo la anterior (ver
 * `carteraDeUnidad`), asi que la ultima por periodo es la unica que dice
 * cuanto se debe hoy. Las demas son historial: aunque esten `vencida`,
 * `abonada` o `pendiente`, su saldo ya va dentro de una posterior, y
 * cobrarlas es cobrar dos veces lo mismo.
 *
 * ── Que NO la decide ─────────────────────────────────────────────────────
 * Ni el orden en que se cargaron, ni `_creationTime`, ni el id, ni el orden
 * en que llegaron los PDF: julio subido despues de septiembre sigue siendo
 * historial. Solo se compara el periodo, y el resultado no cambia aunque
 * `cadena` llegue en otro orden. Tampoco el estado: si la vigente esta
 * pagada la casa esta al dia, y no se retrocede a buscar una anterior sin
 * pagar.
 *
 * `null` si no hay facturas, o si dos comparten el periodo mas reciente (no
 * deberia pasar: es una por unidad y periodo). Elegir una de las dos seria
 * volver a depender del orden de carga, asi que no se adivina: nada se
 * ofrece para pagar hasta que la administracion lo revise.
 *
 * Es la definicion de toda la aplicacion: la usan el cobro
 * (`pagos.armarDatosTrn`, por `motivoNoPagable`), el bot y el agente
 * (`soportesPago.facturaVigenteDeUnidad`), la campana y la web y el movil
 * (por `resumenResidente`). Contencion de la Fase 1 de la auditoria de
 * facturacion: la Fase 3 la reemplaza por el modelo de obligaciones y pagos.
 */
export function facturaVigente<F extends { periodo: string }>(
  cadena: readonly F[],
): F | null {
  const ultimas = delUltimoPeriodo(cadena);
  return ultimas.length === 1 ? ultimas[0]! : null;
}

/** Por que no se puede pagar una factura. */
export type MotivoNoPagable =
  | "pagada"
  | "historica"
  | "vigente_ambigua"
  | "en_revision"
  | "pago_en_verificacion"
  | "sin_saldo";

/**
 * Si una factura se puede pagar hoy y, si no, por que.
 *
 * Solo se paga la vigente (`facturaVigente`) y solo si deja saldo. Una
 * historica no, este como este: lo que quedo debiendo ya lo cobra una
 * posterior. Es la regla del backend de pagos y la de los botones "Pagar",
 * para que lo que se ofrece y lo que se acepta no dejen de coincidir.
 *
 * Tampoco una vigente en revision: su total salio de una lectura dudosa del
 * PDF, y cobrarlo seria cobrar un numero que nadie ha verificado.
 *
 * Ni una vigente con un pago en verificacion (Fase 3): Vekino registro un
 * pago que la contabilidad todavia no refleja, y su total lo vuelve a
 * cobrar. Cobrarlo seria hacerle pagar dos veces al residente.
 *
 * `cadena` son TODAS las facturas de la unidad, `factura` incluida.
 */
export function motivoNoPagable(
  cadena: readonly { periodo: string }[],
  factura: {
    periodo: string;
    estado: EstadoFactura;
    totalAPagar: number;
    lecturaDudosa?: LecturaDudosa | null;
    pagoEnVerificacion?: PagoEnVerificacion | null;
  },
): MotivoNoPagable | null {
  if (factura.estado === "pagada") return "pagada";
  const ultimas = delUltimoPeriodo(cadena);
  if (ultimas.length > 0 && factura.periodo.localeCompare(ultimas[0]!.periodo) < 0) {
    return "historica";
  }
  if (ultimas.length > 1) return "vigente_ambigua";
  if (enRevision(factura)) return "en_revision";
  if (factura.pagoEnVerificacion) return "pago_en_verificacion";
  if (!sinPagar(factura.estado) || factura.totalAPagar <= 0) return "sin_saldo";
  return null;
}

/**
 * Lo que se le responde a quien intenta pagar. Estables a proposito: el bot
 * y la web los reconocen por el texto. Sin ids ni detalles internos.
 */
export const MENSAJE_NO_PAGABLE: Readonly<Record<MotivoNoPagable, string>> = {
  pagada: "Esta factura ya está pagada.",
  historica:
    "Esta factura ya no está vigente: su saldo quedó incluido en la factura más reciente de la unidad.",
  vigente_ambigua:
    "Esta factura no se puede pagar en línea: la unidad tiene más de una factura del mismo período. Comunícate con la administración.",
  en_revision:
    "Esta factura está en revisión: la administración debe verificar su lectura antes de que se pueda pagar.",
  pago_en_verificacion:
    "Tu pago está registrado, pero la contabilidad aún no lo refleja. La administración lo está verificando; mientras tanto esta factura no se puede pagar en línea.",
  sin_saldo: "Esta factura no tiene saldo por pagar.",
};

/**
 * La frase de "pago en verificacion" con el monto, para las pantallas que lo
 * conocen (`pagoEnVerificacion.monto`). Los errores usan la de
 * `MENSAJE_NO_PAGABLE`, que no cambia.
 */
export function mensajePagoEnVerificacion(monto: number): string {
  return `Tu pago de ${formatoPesos(monto)} está registrado; la contabilidad aún no lo refleja. La administración lo está verificando.`;
}

/** "$ 300.000", como lo muestran la web y el móvil. */
export function formatoPesos(monto: number): string {
  const entero = Math.round(Math.abs(monto))
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${monto < 0 ? "-" : ""}$ ${entero}`;
}

/**
 * Un monto en pesos como lo escribe una persona: "340000", "340.000",
 * "$ 340.000", "340,000", "340.000,00", "pagué 340.000 ayer". El primero que
 * aparezca en el texto, en pesos enteros, o `null` si no hay ninguno
 * creíble (menos de $1.000 o más de $100 millones: una cuota no es eso, y un
 * "15" suelto es más probablemente un día que un pago).
 */
export function leerMontoPesos(texto: string): number | null {
  const candidatos = texto.match(/\d[\d.,]*/g) ?? [];
  for (const crudo of candidatos) {
    const t = crudo.replace(/[.,]$/, "");
    let valor: number | null = null;
    if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(t)) valor = Number(t.split(",")[0]!.replace(/\./g, ""));
    else if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(t)) valor = Number(t.split(".")[0]!.replace(/,/g, ""));
    else if (/^\d+$/.test(t)) valor = Number(t);
    if (valor !== null && valor >= 1_000 && valor <= 100_000_000) return valor;
  }
  return null;
}

/**
 * Cuanto debe HOY la unidad, y si esta incumpliendo.
 *
 * ── Las facturas no son deudas sumables ──────────────────────────────────
 * Cada factura ABSORBE lo que quedo debiendo la anterior: su `totalAPagar`
 * no es la cuota del mes, es la deuda acumulada a esa fecha. Sumar los
 * saldos de las facturas viejas para saber cuanto debe una casa no es contar
 * dos veces: es resucitar deuda que ya se pago.
 *
 * El caso que lo destapo, una unidad real:
 *
 *   abril   deja 400.800 debiendo
 *     -> mayo los absorbe:  837.800 = 437.000 nuevos + 400.800 arrastrados
 *   mayo    deja 264.600
 *     -> junio los absorbe: 638.600 = 374.000 nuevos + 264.600 arrastrados
 *   junio   se paga COMPLETO -> saldo 0
 *
 * Sumando saldos salian 1.083.400. Lo cierto es que abril y mayo se pagaron
 * en junio y no se deben; lo vigente son los 380.000 de septiembre, que ya
 * llevan dentro los 38.000 que quedaron de agosto.
 *
 * ── De donde sale entonces el saldo vigente ──────────────────────────────
 * De la ultima factura de la cadena, porque el modelo garantiza que arrastra
 * todo lo anterior. Cuanto queda de ella lo diria la factura siguiente —su
 * saldo anterior—, pero esa todavia no existe, asi que lo dicen su estado y
 * sus pagos aprobados: saldada si esta `pagada` o en `saldo_a_favor`, y si no
 * el total menos lo ya abonado (`saldoPendienteDe`).
 *
 * ── La mora es otra pregunta ─────────────────────────────────────────────
 * La decide el ultimo periodo que YA vencio, no el mas antiguo sin pagar.
 * Una casa que arrastra deuda pero cubrio —pago o abono— el ultimo periodo
 * vencido no esta incumpliendo hoy: debe plata y esta respondiendo, y las
 * dos cosas son ciertas al tiempo.
 *
 * Lo cubre tambien una factura POSTERIOR de la cadena que muestre pago,
 * porque absorbio ese saldo: agosto `vencida` que septiembre arrastro, y
 * septiembre `pagada`, es una casa que pago todo. Mirar solo a agosto la
 * dejaba en mora con saldo cero hasta que venciera septiembre (hallazgo de
 * la Fase 0 de la auditoria de facturacion). Y sin saldo no hay mora: la
 * mora es deber algo vencido, no haber debido.
 *
 * `vencida` no cuenta como cubierta, evidentemente. Y `pendiente` tampoco:
 * no es un estado de pago, es la ultima de la cadena, a la que todavia
 * ninguna factura posterior ha juzgado. Ausencia de veredicto, no constancia
 * de pago. Si contara, un conjunto que dejara de cargar facturas se veria
 * entero al dia mientras la deuda corre.
 *
 * Es una contencion sobre los estados que hoy pone la conciliacion: la Fase
 * 3 de la auditoria reemplaza esta inferencia por el modelo estructural de
 * obligaciones y pagos.
 *
 * ── Lecturas dudosas ─────────────────────────────────────────────────────
 * Si la vigente esta en revision (`enRevision`), o lo esta el periodo que
 * decidiria la mora, el estado es `en_revision`: ni "al dia" ni "mora" se
 * pueden afirmar con un documento cuyos numeros no cuadran. El saldo se
 * informa igual, como referencia para quien revisa.
 *
 * ── Pagos en verificacion y meses faltantes (Fase 3) ─────────────────────
 * Tambien es `en_revision` una vigente con un pago en verificacion: Vekino
 * registro un pago que la contabilidad no refleja, y declarar mora por ese
 * monto seria cobrarle al residente lo que ya pago. Y un periodo SIN
 * VEREDICTO —le falta el mes siguiente para juzgarlo— no decide la mora: no
 * se sabe si se pago, y "en mora" seria inventarlo. Ninguno de los dos
 * inventa "al dia" tampoco: el saldo se informa igual.
 */
export function carteraDeUnidad(
  facturas: readonly FacturaCartera[],
  ahora: number,
): CarteraUnidad {
  const vacia: CarteraUnidad = {
    estado: "sin_facturas",
    saldoActual: 0,
    periodoActual: null,
    diasMora: 0,
    periodoEnMora: null,
    vencimientoEnMora: null,
  };

  if (facturas.length === 0) return vacia;

  /* La obligacion vigente, la del periodo mas reciente (`facturaVigente`):
   * el orden de la cadena es el de la conciliacion, por periodo, que es como
   * el saldo pasa de una a otra. Si dos compartieran ese periodo —no deberia:
   * es una por unidad y periodo— no se elige por el orden de carga: se
   * reporta la que mas debe. */
  const ultimas = delUltimoPeriodo(facturas);

  /* Si la vigente esta `abonada`, lo abonado lo dicen sus pagos aprobados
   * (`estadoPago`, Fase 3): se descuenta. Antes se reportaba el total —"eso lo
   * diria la siguiente, que no existe"— y un abono aprobado no bajaba la
   * deuda en ninguna pantalla (QA de comprobantes, H1). Sin ese monto (un
   * estado heredado) se sigue reportando el total: preferir pasarse a
   * quedarse corto. */
  const saldoActual = Math.max(0, ...ultimas.map(saldoPendienteDe));

  const base: CarteraUnidad = {
    ...vacia,
    saldoActual,
    periodoActual: ultimas[0]!.periodo,
    estado: saldoActual > 0 ? "pendiente" : "al_dia",
  };

  if (ultimas.some(enRevision)) {
    return { ...base, estado: "en_revision", motivoRevision: "lectura" };
  }

  /* Un pago registrado que la contabilidad no refleja: ni mora ni al dia. */
  const enVerificacion = ultimas.reduce((s, f) => s + (f.pagoEnVerificacion?.monto ?? 0), 0);
  if (ultimas.some((f) => f.pagoEnVerificacion)) {
    return {
      ...base,
      estado: "en_revision",
      motivoRevision: "pago_en_verificacion",
      montoEnVerificacion: enVerificacion,
    };
  }

  /* Los periodos cuya mora ya empezo (`inicioDeMora`: el 16 del mes
   * siguiente, decision B de la Fase 4), del mas viejo al mas nuevo. Se
   * ordena por esa fecha y no por el orden en que entraron a la base: lo que
   * define "el ultimo" es la fecha de la obligacion, no cuando alguien la
   * cargo. El periodo desempata para que dos fechas iguales no bailen.
   *
   * Las migradas con `fechaVencimiento` en 0 (`backfillFechas` las arregla)
   * quedan fuera: sin fecha no se puede decir si vencieron ni cuando. */
  const yaVencidas = facturas
    .filter((f) => f.fechaVencimiento > 0 && ahora >= inicioDeMora(f))
    .sort(
      (a, b) => inicioDeMora(a) - inicioDeMora(b) || a.periodo.localeCompare(b.periodo),
    );

  const ultimoVencido = yaVencidas[yaVencidas.length - 1];

  /* Nada ha vencido todavia: debe, pero dentro de plazo. */
  if (!ultimoVencido) return base;

  /* Lo que vencio quedo cubierto —por el mismo o por una posterior que lo
   * absorbio—, o ya no queda nada que deber. Llamarlo mora seria cobrarle un
   * atraso que no tiene. */
  const cubierto = facturas.some(
    (f) =>
      f.periodo.localeCompare(ultimoVencido.periodo) >= 0 && conEvidenciaDePago(f.estado),
  );
  if (cubierto || saldoActual === 0) return base;

  /* El periodo que decidiria la mora tiene una lectura dudosa: no se sabe. */
  if (enRevision(ultimoVencido)) {
    return { ...base, estado: "en_revision", motivoRevision: "lectura" };
  }

  /* Le falta el mes siguiente para juzgarlo: tampoco se sabe. */
  if (ultimoVencido.veredictoContable?.estado === "sin_veredicto") {
    return { ...base, estado: "en_revision", motivoRevision: "mes_faltante" };
  }

  /* Los dias se cuentan desde la vispera del inicio de la mora: el 16 es el
   * dia 1. Para las facturas con el vencimiento viejo (15 del mes siguiente)
   * es exactamente la cuenta de siempre. */
  const inicio = inicioDeMora(ultimoVencido);
  return {
    ...base,
    estado: "en_mora",
    diasMora: diasDesde(inicio - DIA, ahora),
    periodoEnMora: ultimoVencido.periodo,
    vencimientoEnMora: ultimoVencido.fechaVencimiento,
  };
}

// ─────────────────────────────────────────────────────────────
// Lo que ve el residente: la misma regla, por unidad
// ─────────────────────────────────────────────────────────────

/** Una unidad del residente, tal como se le muestra. */
export type UnidadResidente<F> = {
  unidadId: string;
  /** El mismo calculo que ve la administracion (`carteraDeUnidad`). */
  cartera: CarteraUnidad;
  /** La vigente (`facturaVigente`), pagada o no. */
  vigente: F | null;
  /** La vigente, si hoy se puede pagar (`motivoNoPagable`). */
  pagable: F | null;
};

export type ResumenResidente<F> = {
  /**
   * El de la unidad que peor esta: en mora, en revision, pendiente, al dia,
   * sin facturas.
   */
  estado: EstadoCartera;
  unidades: UnidadResidente<F>[];
  /** A lo sumo una por unidad: su vigente, cuando se puede pagar. */
  pagables: F[];
};

const PEOR_PRIMERO: readonly EstadoCartera[] = ["en_mora", "en_revision", "pendiente", "al_dia"];

/**
 * El estado de cuenta del residente, con la MISMA regla de la administracion.
 *
 * La web y el movil lo pintaban mirando el historial entero: bastaba una
 * factura vieja `vencida` —ya absorbida y saldada por las siguientes— para
 * mostrar "Vencida" a una casa al dia, y con la vigente pagada se ofrecia
 * pagar otra vez la anterior. Aqui no hay regla propia: por unidad, la
 * cartera sale de `carteraDeUnidad` y lo que se puede pagar de
 * `facturaVigente` + `motivoNoPagable`, que son las del backend.
 *
 * `facturas` son las del residente, de una o varias unidades, en cualquier
 * orden: tal como las entrega `facturas.listMia`.
 */
export function resumenResidente<F extends FacturaCartera & { unidadId: string }>(
  facturas: readonly F[],
  ahora: number,
): ResumenResidente<F> {
  const porUnidad = new Map<string, F[]>();
  for (const f of facturas) {
    const cadena = porUnidad.get(f.unidadId);
    if (cadena) cadena.push(f);
    else porUnidad.set(f.unidadId, [f]);
  }

  const unidades = [...porUnidad.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([unidadId, cadena]): UnidadResidente<F> => {
      const vigente = facturaVigente(cadena);
      return {
        unidadId,
        cartera: carteraDeUnidad(cadena, ahora),
        vigente,
        pagable: vigente && motivoNoPagable(cadena, vigente) === null ? vigente : null,
      };
    });

  return {
    estado:
      PEOR_PRIMERO.find((e) => unidades.some((u) => u.cartera.estado === e)) ??
      "sin_facturas",
    unidades,
    pagables: unidades.flatMap((u) => (u.pagable ? [u.pagable] : [])),
  };
}

// ─────────────────────────────────────────────────────────────
// Estado de cuenta: la misma cadena, factura por factura
// ─────────────────────────────────────────────────────────────

export type FacturaCadena = FacturaCartera & { periodoLabel: string };

export type FilaEstadoCuenta = {
  periodo: string;
  periodoLabel: string;
  estado: EstadoFactura;
  fechaVencimiento: number;
  totalAPagar: number;
};

/**
 * Las facturas de una unidad, una por una, tal como las dejo la conciliacion.
 *
 * ── Esto es historial, no deuda ──────────────────────────────────────────
 * Sirve para auditar como se llego hasta aqui. Cuanto se debe hoy lo dice
 * `carteraDeUnidad`, y sale de una sola factura: la vigente.
 *
 * Por lo mismo no se devuelven dias de vencida por factura. Ver "116 dias"
 * en abril y "85" en mayo invita a leerlos como dos moras que se acumulan,
 * cuando son la misma deuda contada dos veces. La mora es una y esta en
 * `carteraDeUnidad`.
 *
 * Tampoco se devuelven concepto, abono ni saldo por factura: el estado de
 * cuenta ya no los muestra. Si quedo pagada, abonada o vencida lo dice el
 * estado que puso la conciliacion.
 *
 * `cadena` debe venir ordenada del periodo mas viejo al mas nuevo.
 */
export function estadoCuentaDeCadena(
  cadena: readonly FacturaCadena[],
): FilaEstadoCuenta[] {
  return cadena.map((f) => ({
    periodo: f.periodo,
    periodoLabel: f.periodoLabel,
    estado: f.estado,
    fechaVencimiento: f.fechaVencimiento,
    totalAPagar: f.totalAPagar,
  }));
}

// ─────────────────────────────────────────────────────────────
// Descuento por pronto pago y vencimiento (Fase 3, F-06)
// ─────────────────────────────────────────────────────────────

/** Colombia no tiene horario de verano: siempre UTC−5. */
const BOGOTA_UTC_HORAS = 5;

/** Medianoche (hora de Colombia) del dia `dia` del mes del periodo "AAAA-MM". */
function medianocheDelPeriodo(periodo: string, dia: number): number {
  const [a, m] = periodo.split("-").map(Number) as [number, number];
  return Date.UTC(a, m - 1, dia, BOGOTA_UTC_HORAS);
}

/**
 * El dia del mes del periodo hasta el que vale el descuento cuando el
 * documento no lo dice. Es la unica regla documentada: la de Ciudad del
 * Campo, que imprime "HASTA EL DIA 15 DEL PRESENTE MES" y "Pague con
 * descuento del 1 - 15". Arboleda no ofrece descuento (sus facturas no
 * traen `totalConDescuento`), asi que la regla no le aplica.
 */
export const DIA_LIMITE_DESCUENTO = 15;

/** El ultimo instante del dia `dia` del mes del periodo, hora de Colombia. */
export function finDelDiaDelPeriodo(periodo: string, dia: number): number {
  return medianocheDelPeriodo(periodo, dia + 1) - 1;
}

/**
 * Hasta cuando vale `totalConDescuento`, o `null` si la factura no tiene
 * descuento.
 *
 * Manda la fecha que trae el documento (`fechaLimiteDescuento`, que el
 * parser lee de "HASTA EL DIA N DEL PRESENTE MES"). Si no la trae —las
 * cargadas antes de la Fase 3—, el dia 15 del mes del PERIODO: la cuenta de
 * septiembre tiene descuento hasta el 15 de septiembre. Antes se usaba el
 * vencimiento (15 de octubre) y el descuento se extendia un mes (F-06).
 */
export function fechaLimiteDescuentoDe(f: {
  periodo: string;
  totalConDescuento?: number | null;
  fechaLimiteDescuento?: number | null;
}): number | null {
  if (typeof f.totalConDescuento !== "number") return null;
  if (typeof f.fechaLimiteDescuento === "number") return f.fechaLimiteDescuento;
  return finDelDiaDelPeriodo(f.periodo, DIA_LIMITE_DESCUENTO);
}

/** Si hoy todavia vale el descuento. */
export function descuentoVigente(
  f: { periodo: string; totalConDescuento?: number | null; fechaLimiteDescuento?: number | null },
  ahora: number,
): boolean {
  const limite = fechaLimiteDescuentoDe(f);
  return limite !== null && ahora <= limite;
}

/**
 * Lo que se cobra HOY por la factura: con descuento si todavia vale, y si no
 * el total, MENOS lo que ya se abono. Es lo que cobra la pasarela
 * (`pagos.armarDatosTrn`) y lo que muestran la web, el movil, el bot, el
 * agente y la campana, y de donde parte la revision de un comprobante.
 *
 * ── Abonos (QA de comprobantes, H1) ──────────────────────────────────────
 * Antes solo elegia entre el total y el total con descuento: aprobado un
 * abono de $200.000 de $335.000, se seguian mostrando y cobrando $335.000.
 * Ahora es la regla de `evidenciaDePago` vista desde el cobro: pagar hoy esto
 * deja la factura pagada.
 *   · Con el descuento vigente, lo pagado dentro del plazo suma para el, asi
 *     que falta el total con descuento menos lo abonado.
 *   · Vencido el descuento, falta el total menos lo abonado.
 *   · Si los pagos ya la saldaron, nada. Nunca negativo.
 * Solo cuentan los pagos aprobados (`estadoPago`): un comprobante en
 * revision o rechazado no descuenta nada.
 */
export function montoAPagarHoy(
  f: {
    periodo: string;
    totalAPagar: number;
    totalConDescuento?: number | null;
    fechaLimiteDescuento?: number | null;
    estadoPago?: EvidenciaGuardada | null;
  },
  ahora: number,
): number {
  if (f.estadoPago?.estado === "pagada") return 0;
  const monto = descuentoVigente(f, ahora) ? (f.totalConDescuento as number) : f.totalAPagar;
  const abonado = abonoAprobado(f);
  return abonado > 0 ? Math.max(0, monto - abonado) : monto;
}

/**
 * Lo que se cobra cuando ya no vale el descuento: el total menos lo abonado.
 * Es el "Después $ X" que acompaña al precio con descuento.
 */
export function montoSinDescuento(f: {
  totalAPagar: number;
  estadoPago?: EvidenciaGuardada | null;
}): number {
  if (f.estadoPago?.estado === "pagada") return 0;
  const abonado = abonoAprobado(f);
  return abonado > 0 ? Math.max(0, f.totalAPagar - abonado) : f.totalAPagar;
}

/**
 * El vencimiento de una factura NUEVA (decision de la administracion para la
 * Fase 3): "Pagar con descuento hasta el 15 del presente mes, del 16 a 30 se
 * paga el precio completo". Es decir, el ultimo dia del mes del periodo, a
 * medianoche de Colombia: ese dia todavia se paga el precio completo. La mora
 * NO empieza al dia siguiente sino el 16 del mes siguiente (`inicioDeMora`,
 * decision B de la Fase 4). El "30" se lee como el ultimo dia del mes (28 o
 * 29 en febrero, 31 donde lo hay).
 *
 * Solo para lo que se carga desde ahora: las facturas ya guardadas conservan
 * el suyo (dia 15 del mes siguiente) hasta que se autorice re-fecharlas.
 */
export function vencimientoDePeriodo(periodo: string): number {
  const [a, m] = periodo.split("-").map(Number) as [number, number];
  /* Dia 0 del mes siguiente = ultimo dia de este. */
  return Date.UTC(a, m, 0, BOGOTA_UTC_HORAS);
}

// ─────────────────────────────────────────────────────────────
// Cuando empieza la mora (Fase 4, decision B del responsable)
// ─────────────────────────────────────────────────────────────

/**
 * El dia del mes SIGUIENTE al del periodo en que empieza la mora.
 *
 * Decision del responsable para la Fase 4 (opcion B): "El fin de mes es el
 * plazo del precio completo, que es lo que se le muestra al residente. Para
 * Vekino, la mora empieza el dia 16 del mes siguiente".
 *
 * Por que: con el vencimiento a fin de mes (Fase 3), entre el dia 1 y la
 * carga del PDF siguiente la vigente ya habia vencido y Vekino todavia no veia
 * los pagos hechos por fuera (banco, portal): de 8 a 16 dias al mes, la
 * mayoria de las casas se veian en mora sin estarlo (Fase 3, Anexo V1). Las
 * facturas de Ciudad del Campo llegan antes del 16, asi que la mora se decide
 * ya con el documento que dice si se pago.
 */
export const DIA_INICIO_MORA = 16;

/**
 * Desde cuando una factura sin pagar cuenta como mora: la medianoche
 * (Colombia) del dia 16 del mes siguiente al del periodo, o el dia despues de
 * su vencimiento si este es posterior.
 *
 * - Facturas nuevas (vencen el ultimo dia del mes): el 16 del mes siguiente.
 * - Las ya guardadas (vencen el 15 del mes siguiente): el 16, como siempre.
 *   No se re-fecha nada: la regla sale del periodo.
 * - Una factura con un plazo propio mas largo (la manual, por ejemplo) no
 *   entra en mora antes de su plazo.
 */
export function inicioDeMora(f: { periodo: string; fechaVencimiento: number }): number {
  const dia16 = medianocheDelPeriodo(periodoSiguiente(f.periodo), DIA_INICIO_MORA);
  return Math.max(dia16, f.fechaVencimiento + DIA);
}

const MESES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

/**
 * "16 de noviembre de 2026": el dia, en hora de Colombia. Sin `Intl`, para
 * que dé lo mismo en el servidor, la web, el movil y las pruebas.
 */
export function fechaEnPalabras(ts: number): string {
  const d = new Date(ts - BOGOTA_UTC_HORAS * 60 * 60 * 1000);
  return `${d.getUTCDate()} de ${MESES[d.getUTCMonth()]} de ${d.getUTCFullYear()}`;
}

export type PlazosFactura = {
  /** Ultimo instante con descuento, si la factura lo tiene. */
  descuentoHasta: number | null;
  /** El plazo del precio completo que se le muestra al residente (`fechaVencimiento`). */
  precioCompletoHasta: number;
  /** Desde cuando cuenta como mora (`inicioDeMora`). */
  moraDesde: number;
};

/** Los tres plazos de una factura, en un solo lugar. */
export function plazosDeFactura(f: {
  periodo: string;
  fechaVencimiento: number;
  totalConDescuento?: number | null;
  fechaLimiteDescuento?: number | null;
}): PlazosFactura {
  return {
    descuentoHasta: fechaLimiteDescuentoDe(f),
    precioCompletoHasta: f.fechaVencimiento,
    moraDesde: inicioDeMora(f),
  };
}

/**
 * Lo que se le dice al residente sobre sus plazos, igual en la web, el movil,
 * el bot y el agente:
 *
 *   "Con descuento hasta el 15 de octubre de 2026"   (si tiene descuento)
 *   "Precio completo hasta el 31 de octubre de 2026"
 *   "En mora desde el 16 de noviembre de 2026"
 *
 * Sin fecha de vencimiento (migradas sin `backfillFechas`) no se dice nada:
 * inventar un plazo seria peor que no darlo.
 */
export function textosDePlazos(f: {
  periodo: string;
  fechaVencimiento: number;
  totalConDescuento?: number | null;
  fechaLimiteDescuento?: number | null;
}): string[] {
  if (!(f.fechaVencimiento > 0)) return [];
  const p = plazosDeFactura(f);
  return [
    ...(p.descuentoHasta !== null ? [`Con descuento hasta el ${fechaEnPalabras(p.descuentoHasta)}`] : []),
    `Precio completo hasta el ${fechaEnPalabras(p.precioCompletoHasta)}`,
    `En mora desde el ${fechaEnPalabras(p.moraDesde)}`,
  ];
}

// ─────────────────────────────────────────────────────────────
// Lo que se muestra de cada factura (Fase 4): "Sin verificar"
// ─────────────────────────────────────────────────────────────

/**
 * El estado que se MUESTRA de una factura. El campo `estado` no cambia.
 *
 * - `en_revision`: su lectura esta en revision (Fase 2).
 * - `en_verificacion`: tiene un pago registrado que la contabilidad aun no
 *   refleja (Fase 3; solo la vigente).
 * - `sin_verificar`: es HISTORICA y quedo `pendiente`. Una historica
 *   pendiente es una que ninguna factura siguiente pudo juzgar —falta el mes
 *   siguiente (julio en Ciudad del Campo, mayo en parte de Arboleda) o se
 *   cargo antes de tiempo—: no se sabe si se pago. Mostrarla "Pendiente"
 *   decia que se debe, y lo que se debe hoy ya esta en la vigente.
 * - `vencida`: es la VIGENTE, sigue `pendiente` y la unidad esta HOY en mora
 *   (`cartera`, de `carteraDeUnidad`). En la base sigue `pendiente` porque
 *   ninguna factura posterior la ha juzgado (`vencida` como estado lo pone
 *   solo un veredicto), pero ya paso la fecha de mora y nada la cubre. Antes
 *   el resumen y la tarjeta decian "Vencida" y la fila, Finanzas y la campana
 *   "Pendiente" (QA de comprobantes, H2). Sin `cartera` no se juzga la mora.
 * - Cualquier otra: su estado.
 *
 * `cadena` son las facturas de la misma unidad (con la factura incluida).
 */
export type EstadoVisible = EstadoFactura | "en_revision" | "en_verificacion" | "sin_verificar";

export function estadoVisibleDeFactura(
  f: {
    periodo: string;
    estado: EstadoFactura | string;
    lecturaDudosa?: LecturaDudosa | null;
    pagoEnVerificacion?: PagoEnVerificacion | null;
  },
  cadena: readonly { periodo: string }[],
  cartera?: Pick<CarteraUnidad, "estado"> | null,
): EstadoVisible {
  if (enRevision(f)) return "en_revision";
  if (f.pagoEnVerificacion) return "en_verificacion";
  const ultimas = delUltimoPeriodo(cadena);
  const historica =
    ultimas.length > 0 && f.periodo.localeCompare(ultimas[0]!.periodo) < 0;
  if (historica && f.estado === "pendiente") return "sin_verificar";
  if (!historica && f.estado === "pendiente" && cartera?.estado === "en_mora") return "vencida";
  return f.estado as EstadoFactura;
}

/**
 * El estado que se muestra de CADA factura de una unidad, con su cartera de
 * hoy: lo que usan Finanzas, el estado de cuenta, la campana y el bot para no
 * contradecir a la cartera (`estadoVisibleDeFactura`). `cadena`: todas las
 * facturas de la unidad, en cualquier orden.
 */
export function estadosVisiblesDeUnidad<F extends FacturaCartera & { _id: string }>(
  cadena: readonly F[],
  ahora: number,
): Map<string, EstadoVisible> {
  const cartera = carteraDeUnidad(cadena, ahora);
  return new Map(cadena.map((f) => [f._id, estadoVisibleDeFactura(f, cadena, cartera)]));
}

export const ETIQUETA_SIN_VERIFICAR = "Sin verificar";
export const TEXTO_SIN_VERIFICAR =
  "Falta el estado de cuenta del mes siguiente para saber si se pagó.";

// ─────────────────────────────────────────────────────────────
// La lista del residente (Fase 4, F-16)
// ─────────────────────────────────────────────────────────────

/**
 * Las facturas que se le entregan al residente, de una o varias unidades.
 *
 * `porUnidad`: las de cada unidad, de la mas reciente a la mas vieja por
 * periodo. Salen siempre TODAS las del periodo mas reciente de cada unidad
 * —la vigente, y su gemela si la hubiera, para que `facturaVigente` detecte
 * el empate—, y el resto hasta `limite`, de lo mas reciente a lo mas viejo.
 * Cada factura una sola vez.
 *
 * Antes se recortaba a 50 por fecha de carga entre todas las unidades: con
 * muchas facturas, la vigente de una casa podia quedarse por fuera, y con ella
 * el estado, el boton de pago y el resumen.
 */
export function facturasDelResidente<
  F extends { _id: string; periodo: string; fechaEmision?: number },
>(porUnidad: readonly (readonly F[])[], limite: number): F[] {
  const vistas = new Set<string>();
  const vigentes: F[] = [];
  const resto: F[] = [];
  for (const lista of porUnidad) {
    const ultimas = new Set(delUltimoPeriodo(lista).map((f) => f._id));
    for (const f of lista) {
      if (vistas.has(f._id)) continue;
      vistas.add(f._id);
      (ultimas.has(f._id) ? vigentes : resto).push(f);
    }
  }
  const reciente = (a: F, b: F) =>
    b.periodo.localeCompare(a.periodo) || (b.fechaEmision ?? 0) - (a.fechaEmision ?? 0);
  resto.sort(reciente);
  return [...vigentes, ...resto.slice(0, Math.max(0, limite - vigentes.length))].sort(reciente);
}
