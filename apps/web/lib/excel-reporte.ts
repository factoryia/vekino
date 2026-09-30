/**
 * Genera el .xlsx de un REPORTE: un bloque de resumen arriba y la tabla debajo.
 *
 * Hermano de `excel-simple.ts`, que no sirve para esto a propósito: aquel arma
 * plantillas que vuelven a entrar por la carga masiva, y por eso exige los
 * encabezados en la fila 1 sin nada encima. Un reporte no se vuelve a cargar
 * —se lee y se cuadra contra la caja—, así que aquí sí cabe un resumen arriba.
 *
 * De allá se reutilizan el escape de XML, las letras de columna, el nombre de
 * hoja y la paleta. Lo que cambia es la disposición, y que las cifras, fechas
 * y horas se escriben como valores de Excel y no como texto: un "$260.000"
 * escrito como texto no se puede sumar ni filtrar, que es justo lo que se hace
 * con un reporte.
 *
 * La tabla principal sale como TABLA de Excel (no como un rango suelto): así
 * trae los botones de filtro en cada encabezado y las franjas se recalculan al
 * filtrar, en lugar de quedar desordenadas como pasaría pintándolas a mano.
 */
import JSZip from "jszip";
import { COLOR, colLetter, nombreDeHoja, xmlEscape } from "./excel-simple.ts";

// ─────────────────────────────────────────────────────────────
// Tipos públicos
// ─────────────────────────────────────────────────────────────

/**
 * Cómo se escribe una columna.
 *
 * `fecha` espera "AAAA-MM-DD" y `hora` "HH:MM". Si el valor no tiene esa forma
 * se escribe como texto tal cual: mejor una celda sin formato que un dato
 * inventado.
 */
export type TipoColumna = "texto" | "moneda" | "entero" | "fecha" | "hora";

/** `null` y `""` son celda vacía. */
export type ValorReporte = string | number | null;

export type ColumnaReporte = {
  encabezado: string;
  tipo?: TipoColumna;
  /** Ancho en caracteres. Si no se dice, se calcula a partir del contenido. */
  ancho?: number;
  /** Solo para texto. Las cifras van a la derecha y fechas/horas al centro. */
  alinear?: "izquierda" | "centro";
};

export type IndicadorReporte = {
  etiqueta: string;
  valor: number;
  tipo: "moneda" | "entero";
  /** Se pinta como fila de cierre del resumen. Solo cambia el aspecto. */
  destacado?: boolean;
};

export type OpcionesXlsxReporte = {
  nombreArchivo: string;
  hoja?: string;
  resumen: {
    titulo: string;
    subtitulo?: string;
    indicadores: readonly IndicadorReporte[];
    /** Líneas en gris bajo el resumen, para decir de dónde sale cada cifra. */
    notas?: readonly string[];
  };
  tabla: {
    titulo: string;
    columnas: readonly ColumnaReporte[];
    filas: readonly (readonly ValorReporte[])[];
    /** Nombre de la tabla de Excel (el que se ve en fórmulas). */
    nombreTabla?: string;
  };
};

// ─────────────────────────────────────────────────────────────
// Fechas y horas como números de Excel
// ─────────────────────────────────────────────────────────────

/**
 * Día cero del sistema 1900 de Excel.
 *
 * Es el 30 y no el 31 de diciembre porque Excel cuenta un 29 de febrero de
 * 1900 que no existió; desde marzo de 1900 en adelante, que es todo lo que
 * importa aquí, este origen da el serial exacto.
 */
const EPOCA_EXCEL = Date.UTC(1899, 11, 30);
const MS_POR_DIA = 86_400_000;

/** "2026-09-16" → 46281. `null` si no es una fecha real ("2026-02-30"). */
export function fechaASerialExcel(fecha: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fecha);
  if (!m) return null;
  const y = Number(m[1]);
  const mes = Number(m[2]);
  const d = Number(m[3]);
  const ms = Date.UTC(y, mes - 1, d);
  const f = new Date(ms);
  /* `Date.UTC` no rechaza el 30 de febrero: lo pasa al 2 de marzo. */
  if (f.getUTCFullYear() !== y || f.getUTCMonth() !== mes - 1 || f.getUTCDate() !== d) {
    return null;
  }
  return Math.round((ms - EPOCA_EXCEL) / MS_POR_DIA);
}

/** "10:30" → 0,4375 (fracción del día). `null` si no es una hora del día. */
export function horaAFraccionExcel(hora: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hora);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return (h * 60 + min) / 1440;
}

// ─────────────────────────────────────────────────────────────
// Medidas y paleta
// ─────────────────────────────────────────────────────────────

/** Altos de fila, en puntos. Los "respiros" son filas vacías que separan. */
const ALTO = {
  seccion: 30,
  subtitulo: 18,
  respiro: 8,
  cabeceraResumen: 24,
  indicador: 22,
  destacado: 26,
  nota: 16,
  separacion: 28,
  cabecera: 34,
  fila: 21,
  linea: 15,
} as const;

const ANCHO_MIN = 10;
const ANCHO_MAX = 45;
/** Lo que se come la sangría de una celda, en caracteres. */
const SANGRIA = 3;
/**
 * Cuánto ocupa de verdad un carácter de texto frente al de referencia de
 * Excel (el "0"): las mayúsculas y las tildes son más anchas.
 */
const ANCHO_LETRA = 1.15;

/**
 * La paleta del producto (`COLOR`) más dos tonos de fondo, un paso sobre
 * `fondoSuave`: apenas se notan, que es lo que se busca en un documento que
 * se va a leer fila por fila.
 */
const TONO = {
  ...COLOR,
  franja: "FFF3F5F3",
  destacado: "FFEBEFEB",
} as const;

/** Estilo de tabla propio: solo franjas suaves. Lo demás lo ponen las celdas. */
const ESTILO_TABLA = "VekinoReporte";

/** Formatos propios. Los ids por debajo de 164 son de Excel y no se definen. */
const FORMATO = {
  /* Pesos sin decimales. El separador de miles lo pone la configuración
   * regional de quien abre el archivo: en Colombia sale "$ 260.000". */
  moneda: { id: 164, codigo: `"$ "#,##0` },
  fecha: { id: 165, codigo: "yyyy-mm-dd" },
  hora: { id: 166, codigo: "hh:mm" },
} as const;
/** Incorporados: 3 es `#,##0` y 49 es `@` (texto). */
const FORMATO_ENTERO = 3;
const FORMATO_TEXTO = 49;

// ─────────────────────────────────────────────────────────────
// Hoja de estilos
// ─────────────────────────────────────────────────────────────

/* Índices dentro de <fonts>, <fills> y <borders>. Tienen que coincidir con el
 * orden en que `estilosXml` los escribe. */
const FUENTE = { normal: 0, cabecera: 1, nota: 2, seccion: 3, subtitulo: 4, etiqueta: 5, valor: 6, destacado: 7 } as const;
const RELLENO = { ninguno: 0, tinta: 2, suave: 3, destacado: 4 } as const;
const BORDE = { ninguno: 0, fila: 1, caja: 2, seccion: 3, destacado: 4, cabecera: 5 } as const;

type Alineacion = {
  h: "left" | "center" | "right";
  v?: "top" | "center" | "bottom";
  ajustar?: boolean;
};

function xf(numFmtId: number, fuente: number, relleno: number, borde: number, al: Alineacion) {
  /* Un carácter de sangría despega el texto del borde; centrado no la admite. */
  const sangria = al.h === "center" ? "" : ' indent="1"';
  return (
    `<xf numFmtId="${numFmtId}" fontId="${fuente}" fillId="${relleno}" borderId="${borde}" xfId="0"` +
    ` applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">` +
    `<alignment horizontal="${al.h}" vertical="${al.v ?? "center"}"${sangria}${al.ajustar ? ' wrapText="1"' : ""}/>` +
    `</xf>`
  );
}

/**
 * Los estilos que usa el reporte, por nombre.
 *
 * El índice de cada uno se deriva del orden de este objeto, en lugar de
 * escribirse a mano: así una celda no puede quedar apuntando al estilo de al
 * lado cuando alguien añada uno en medio.
 */
const XFS = {
  // Títulos de sección y textos sueltos
  seccion: xf(0, FUENTE.seccion, RELLENO.ninguno, BORDE.seccion, { h: "left", v: "bottom" }),
  subtitulo: xf(0, FUENTE.subtitulo, RELLENO.ninguno, BORDE.ninguno, { h: "left" }),
  nota: xf(0, FUENTE.nota, RELLENO.ninguno, BORDE.ninguno, { h: "left" }),
  // Resumen
  resumenCabecera: xf(0, FUENTE.cabecera, RELLENO.tinta, BORDE.cabecera, { h: "left" }),
  resumenCabeceraDerecha: xf(0, FUENTE.cabecera, RELLENO.tinta, BORDE.cabecera, { h: "right" }),
  indicador: xf(0, FUENTE.etiqueta, RELLENO.suave, BORDE.caja, { h: "left" }),
  indicadorEntero: xf(FORMATO_ENTERO, FUENTE.valor, RELLENO.ninguno, BORDE.caja, { h: "right" }),
  indicadorMoneda: xf(FORMATO.moneda.id, FUENTE.valor, RELLENO.ninguno, BORDE.caja, { h: "right" }),
  destacado: xf(0, FUENTE.destacado, RELLENO.destacado, BORDE.destacado, { h: "left" }),
  destacadoEntero: xf(FORMATO_ENTERO, FUENTE.destacado, RELLENO.destacado, BORDE.destacado, { h: "right" }),
  destacadoMoneda: xf(FORMATO.moneda.id, FUENTE.destacado, RELLENO.destacado, BORDE.destacado, { h: "right" }),
  // Tabla
  cabecera: xf(0, FUENTE.cabecera, RELLENO.tinta, BORDE.cabecera, { h: "left", ajustar: true }),
  cabeceraCentro: xf(0, FUENTE.cabecera, RELLENO.tinta, BORDE.cabecera, { h: "center", ajustar: true }),
  cabeceraDerecha: xf(0, FUENTE.cabecera, RELLENO.tinta, BORDE.cabecera, { h: "right", ajustar: true }),
  texto: xf(FORMATO_TEXTO, FUENTE.normal, RELLENO.ninguno, BORDE.fila, { h: "left", ajustar: true }),
  textoCentro: xf(FORMATO_TEXTO, FUENTE.normal, RELLENO.ninguno, BORDE.fila, { h: "center", ajustar: true }),
  moneda: xf(FORMATO.moneda.id, FUENTE.normal, RELLENO.ninguno, BORDE.fila, { h: "right" }),
  entero: xf(FORMATO_ENTERO, FUENTE.normal, RELLENO.ninguno, BORDE.fila, { h: "right" }),
  fecha: xf(FORMATO.fecha.id, FUENTE.normal, RELLENO.ninguno, BORDE.fila, { h: "center" }),
  hora: xf(FORMATO.hora.id, FUENTE.normal, RELLENO.ninguno, BORDE.fila, { h: "center" }),
};
type NombreEstilo = keyof typeof XFS;
const NOMBRES_ESTILO = Object.keys(XFS) as NombreEstilo[];
/* +1: el 0 es el estilo por omisión del libro y tiene que quedarse primero. */
const E = Object.fromEntries(NOMBRES_ESTILO.map((k, i) => [k, i + 1])) as Record<NombreEstilo, number>;

type Lado = readonly ["thin" | "medium", string];

function borde(l: { left?: Lado; right?: Lado; top?: Lado; bottom?: Lado }) {
  /* El orden left, right, top, bottom, diagonal es el del esquema. */
  const lados = (["left", "right", "top", "bottom"] as const)
    .map((n) => {
      const lado = l[n];
      return lado ? `<${n} style="${lado[0]}"><color rgb="${lado[1]}"/></${n}>` : `<${n}/>`;
    })
    .join("");
  return `<border>${lados}<diagonal/></border>`;
}

function estilosXml() {
  const fuente = (extra: string, tamano: number, color: string) =>
    `<font>${extra}<sz val="${tamano}"/><color rgb="${color}"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>`;
  const solido = (rgb: string) =>
    `<fill><patternFill patternType="solid"><fgColor rgb="${rgb}"/><bgColor indexed="64"/></patternFill></fill>`;
  const linea: Lado = ["thin", TONO.linea];
  const formatos = Object.values(FORMATO)
    .map((f) => `<numFmt numFmtId="${f.id}" formatCode="${xmlEscape(f.codigo)}"/>`)
    .join("");

  /* El orden de los bloques —numFmts, fonts, fills, borders, cellStyleXfs,
   * cellXfs, cellStyles, dxfs, tableStyles— es obligatorio: Excel no lo
   * reordena, lo rechaza. */
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="${Object.keys(FORMATO).length}">${formatos}</numFmts>
  <fonts count="8">
    ${fuente("", 11, TONO.tinta)}
    ${fuente("<b/>", 11, TONO.blanco)}
    ${fuente("<i/>", 9, TONO.apagado)}
    ${fuente("<b/>", 15, TONO.tinta)}
    ${fuente("", 10, TONO.apagado)}
    ${fuente("", 11, TONO.tintaSuave)}
    ${fuente("<b/>", 11, TONO.tinta)}
    ${fuente("<b/>", 12, TONO.tinta)}
  </fonts>
  <fills count="5">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    ${solido(TONO.tinta)}
    ${solido(TONO.fondoSuave)}
    ${solido(TONO.destacado)}
  </fills>
  <borders count="6">
    ${borde({})}
    ${borde({ bottom: linea })}
    ${borde({ left: linea, right: linea, top: linea, bottom: linea })}
    ${borde({ bottom: ["medium", TONO.tinta] })}
    ${borde({ left: linea, right: linea, top: ["thin", TONO.tinta], bottom: ["medium", TONO.tinta] })}
    ${borde({ left: ["thin", TONO.tintaSuave], right: ["thin", TONO.tintaSuave] })}
  </borders>
  <cellStyleXfs count="1">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
  </cellStyleXfs>
  <cellXfs count="${NOMBRES_ESTILO.length + 1}"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>${NOMBRES_ESTILO.map((k) => XFS[k]).join("")}</cellXfs>
  <cellStyles count="1">
    <cellStyle name="Normal" xfId="0" builtinId="0"/>
  </cellStyles>
  <dxfs count="1">
    <dxf><fill><patternFill patternType="solid"><fgColor rgb="${TONO.franja}"/><bgColor rgb="${TONO.franja}"/></patternFill></fill></dxf>
  </dxfs>
  <tableStyles count="1" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16">
    <tableStyle name="${ESTILO_TABLA}" pivot="0" count="1">
      <tableStyleElement type="firstRowStripe" dxfId="0"/>
    </tableStyle>
  </tableStyles>
</styleSheet>`;
}

// ─────────────────────────────────────────────────────────────
// Valores y medidas de celda
// ─────────────────────────────────────────────────────────────

/** Convierte el valor según la columna. Lo que no encaja se deja como texto. */
function aCelda(col: ColumnaReporte, v: ValorReporte): { valor: ValorReporte; estilo: number } {
  const tipo = col.tipo ?? "texto";
  const texto = col.alinear === "centro" ? E.textoCentro : E.texto;
  const estilo = tipo === "texto" ? texto : E[tipo];
  if (v == null || v === "") return { valor: null, estilo };
  if (tipo === "fecha" || tipo === "hora") {
    if (typeof v === "number") return { valor: v, estilo };
    const n = tipo === "fecha" ? fechaASerialExcel(v) : horaAFraccionExcel(v);
    return n == null ? { valor: v, estilo: texto } : { valor: n, estilo };
  }
  if (tipo === "moneda" || tipo === "entero") {
    return typeof v === "number" ? { valor: v, estilo } : { valor: v, estilo: texto };
  }
  return { valor: String(v), estilo };
}

/** Cuántos caracteres ocupa el valor ya formateado, para el ancho a ojo. */
function largoDe(tipo: TipoColumna, v: ValorReporte): number {
  if (v == null || v === "") return 0;
  if (typeof v === "number" && (tipo === "moneda" || tipo === "entero")) {
    const digitos = String(Math.trunc(Math.abs(v))).length;
    return digitos + Math.floor((digitos - 1) / 3) + (tipo === "moneda" ? 2 : 0) + (v < 0 ? 1 : 0);
  }
  if (tipo === "fecha") return 10;
  if (tipo === "hora") return 5;
  return String(v)
    .split("\n")
    .reduce((max, linea) => Math.max(max, linea.length), 0);
}

/**
 * Alto de una fila de datos según cuántas líneas ocupe su texto más largo.
 *
 * Excel no recalcula el alto de las filas con texto ajustado al abrir un
 * archivo generado: sin esto, una observación de tres líneas se vería cortada
 * en la primera. Se estima un poco por lo alto (las mayúsculas son más anchas
 * que el carácter de referencia), que es mejor que cortar.
 */
function altoDeFila(
  fila: readonly ValorReporte[],
  columnas: readonly ColumnaReporte[],
  anchos: readonly number[],
): number {
  let lineas = 1;
  columnas.forEach((c, i) => {
    if ((c.tipo ?? "texto") !== "texto") return;
    const v = fila[i];
    if (v == null || v === "") return;
    const util = Math.max(1, (anchos[i] ?? ANCHO_MIN) - SANGRIA);
    const n = String(v)
      .split("\n")
      .reduce((s, l) => s + Math.max(1, Math.ceil((l.length * ANCHO_LETRA) / util)), 0);
    lineas = Math.max(lineas, n);
  });
  return lineas === 1 ? ALTO.fila : lineas * ALTO.linea + 6;
}

/** Nombre admisible para una tabla de Excel: letras, dígitos y `_`, sin parecer una celda. */
function nombreDeTabla(bruto: string) {
  let s = bruto.replace(/[^A-Za-z0-9_]/g, "_");
  if (!/^[A-Za-z_]/.test(s) || /^[A-Za-z]{1,3}\d+$/.test(s) || /^[RrCc]$/.test(s)) s = `_${s}`;
  return s.slice(0, 255) || "Tabla1";
}

// ─────────────────────────────────────────────────────────────
// Construcción del libro
// ─────────────────────────────────────────────────────────────

/**
 * Arma el .xlsx y devuelve sus bytes.
 *
 * Separado de `descargarXlsxReporte` para poder probarlo fuera del navegador.
 */
export async function construirXlsxReporte(opts: OpcionesXlsxReporte): Promise<Uint8Array> {
  const hoja = nombreDeHoja(opts.hoja ?? "Reporte");
  const { columnas, filas } = opts.tabla;
  const { indicadores } = opts.resumen;

  /* Textos en la tabla de cadenas compartidas, como las guarda el propio
   * Excel: es la forma que cualquier lector entiende, y la que Excel espera
   * en los encabezados de una tabla. */
  const cadenas: string[] = [];
  const indiceCadena = new Map<string, number>();
  let usosCadena = 0;
  const cadena = (s: string) => {
    usosCadena += 1;
    let i = indiceCadena.get(s);
    if (i === undefined) {
      i = cadenas.length;
      cadenas.push(s);
      indiceCadena.set(s, i);
    }
    return i;
  };

  const celda = (ref: string, valor: ValorReporte, estilo: number) => {
    const s = ` s="${estilo}"`;
    if (valor == null || valor === "") return `<c r="${ref}"${s}/>`;
    if (typeof valor === "number") {
      return Number.isFinite(valor) ? `<c r="${ref}"${s}><v>${valor}</v></c>` : `<c r="${ref}"${s}/>`;
    }
    return `<c r="${ref}"${s} t="s"><v>${cadena(valor)}</v></c>`;
  };

  /** Varias celdas con el mismo estilo; solo la primera lleva el valor. */
  const tramo = (fila: number, desde: number, hasta: number, valor: ValorReporte, estilo: number) => {
    let xml = "";
    for (let i = desde; i <= hasta; i += 1) {
      xml += celda(`${colLetter(i)}${fila}`, i === desde ? valor : null, estilo);
    }
    return xml;
  };

  /* La etiqueta del indicador ocupa las primeras columnas combinadas y el
   * valor va en la siguiente. Se combinan porque la primera columna de la
   * tabla es una fecha, estrecha, y "Alquiler pactado estimado" no cabe. */
  const tramoEtiqueta = Math.max(1, Math.min(3, columnas.length - 1));
  const colValor = tramoEtiqueta;

  // ── Anchos ──────────────────────────────────────────────────
  const anchos = columnas.map((c, i) => {
    if (c.ancho) return c.ancho;
    const tipo = c.tipo ?? "texto";
    const contenido = filas.reduce((max, f) => Math.max(max, largoDe(tipo, f[i] ?? null)), 0);
    /* El texto se mide con el mismo margen que usa `altoDeFila`: si no, lo
     * más largo de cada columna "no cabría" y su fila saldría el doble de alta. */
    const texto = tipo === "texto" ? Math.ceil(contenido * ANCHO_LETRA) : contenido;
    return Math.min(ANCHO_MAX, Math.max(ANCHO_MIN, c.encabezado.length + SANGRIA, texto + SANGRIA));
  });
  while (anchos.length <= colValor) anchos.push(ANCHO_MIN);

  const etiquetaMax =
    indicadores.reduce((max, ind) => Math.max(max, ind.etiqueta.length), "Indicador".length) + SANGRIA + 2;
  const anchoEtiqueta = anchos.slice(0, tramoEtiqueta).reduce((s, w) => s + w, 0);
  if (anchoEtiqueta < etiquetaMax) {
    anchos[tramoEtiqueta - 1] = (anchos[tramoEtiqueta - 1] ?? 0) + (etiquetaMax - anchoEtiqueta);
  }
  const valorMax =
    indicadores.reduce((max, ind) => Math.max(max, largoDe(ind.tipo, ind.valor)), "Valor".length) + SANGRIA + 3;
  anchos[colValor] = Math.max(anchos[colValor] ?? 0, valorMax);

  const cols = anchos
    .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`)
    .join("");

  const ultimaColIdx = anchos.length - 1;
  const ultimaCol = colLetter(ultimaColIdx);
  const ultimaColTabla = colLetter(Math.max(0, columnas.length - 1));

  // ── Filas ───────────────────────────────────────────────────
  const filasXml: string[] = [];
  const combinadas: string[] = [];
  let n = 1;
  const agregar = (celdas: string, alto: number) => {
    filasXml.push(`<row r="${n}" ht="${alto}" customHeight="1">${celdas}</row>`);
    n += 1;
  };
  /* El título de sección lleva la raya de abajo de lado a lado del documento:
   * es lo que separa a simple vista el resumen de la tabla. */
  const seccion = (titulo: string) => agregar(tramo(n, 0, ultimaColIdx, titulo, E.seccion), ALTO.seccion);
  const combinarEtiqueta = () => {
    if (tramoEtiqueta > 1) combinadas.push(`A${n}:${colLetter(tramoEtiqueta - 1)}${n}`);
  };

  // Resumen
  seccion(opts.resumen.titulo);
  if (opts.resumen.subtitulo) agregar(celda(`A${n}`, opts.resumen.subtitulo, E.subtitulo), ALTO.subtitulo);
  agregar("", ALTO.respiro);
  combinarEtiqueta();
  agregar(
    tramo(n, 0, tramoEtiqueta - 1, "Indicador", E.resumenCabecera) +
      celda(`${colLetter(colValor)}${n}`, "Valor", E.resumenCabeceraDerecha),
    ALTO.cabeceraResumen,
  );
  for (const ind of indicadores) {
    combinarEtiqueta();
    const moneda = ind.tipo === "moneda";
    const [etiqueta, valor] = ind.destacado
      ? [E.destacado, moneda ? E.destacadoMoneda : E.destacadoEntero]
      : [E.indicador, moneda ? E.indicadorMoneda : E.indicadorEntero];
    agregar(
      tramo(n, 0, tramoEtiqueta - 1, ind.etiqueta, etiqueta) + celda(`${colLetter(colValor)}${n}`, ind.valor, valor),
      ind.destacado ? ALTO.destacado : ALTO.indicador,
    );
  }
  const notas = opts.resumen.notas ?? [];
  if (notas.length) agregar("", ALTO.respiro);
  for (const nota of notas) agregar(celda(`A${n}`, nota, E.nota), ALTO.nota);

  agregar("", ALTO.separacion);

  // Tabla
  seccion(opts.tabla.titulo);
  agregar("", ALTO.respiro);
  const filaCabecera = n;
  agregar(
    columnas
      .map((c, i) => {
        const tipo = c.tipo ?? "texto";
        const estilo =
          tipo === "moneda" || tipo === "entero"
            ? E.cabeceraDerecha
            : tipo === "fecha" || tipo === "hora" || c.alinear === "centro"
              ? E.cabeceraCentro
              : E.cabecera;
        return celda(`${colLetter(i)}${n}`, c.encabezado, estilo);
      })
      .join(""),
    ALTO.cabecera,
  );
  for (const f of filas) {
    agregar(
      columnas
        .map((c, i) => {
          const { valor, estilo } = aCelda(c, f[i] ?? null);
          return celda(`${colLetter(i)}${n}`, valor, estilo);
        })
        .join(""),
      altoDeFila(f, columnas, anchos),
    );
  }
  const ultimaFila = n - 1;

  // ── Tabla de Excel, filtro y combinadas ─────────────────────
  /* Excel exige encabezados únicos (sin distinguir mayúsculas) y al menos una
   * fila de datos para una tabla. Si no se cumple, se cae a un filtro sobre
   * el rango, que también sirve; sin filas no hay nada que filtrar. */
  const hayDatos = filas.length > 0 && columnas.length > 0;
  const encabezadosUnicos =
    new Set(columnas.map((c) => c.encabezado.trim().toLowerCase())).size === columnas.length &&
    columnas.every((c) => c.encabezado.trim() !== "");
  const conTabla = hayDatos && encabezadosUnicos;
  const conFiltroSuelto = hayDatos && !encabezadosUnicos;
  const refTabla = `A${filaCabecera}:${ultimaColTabla}${ultimaFila}`;
  const nombre = nombreDeTabla(opts.tabla.nombreTabla ?? "TablaReporte");

  const autoFilter = conFiltroSuelto ? `<autoFilter ref="${refTabla}"/>` : "";
  const mergeCells = combinadas.length
    ? `<mergeCells count="${combinadas.length}">${combinadas.map((r) => `<mergeCell ref="${r}"/>`).join("")}</mergeCells>`
    : "";

  /* Pie de página al imprimir. En estos códigos `&` es especial: el del
   * título se duplica para que salga literal. */
  const pie = `&L${opts.tabla.titulo.replace(/&/g, "&&")}&RPágina &P de &N`;

  /* El orden de los hijos de <worksheet> también es obligatorio: autoFilter,
   * mergeCells, márgenes, página, pie y, al final, las tablas. */
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheetPr><tabColor rgb="${TONO.tinta}"/><pageSetUpPr fitToPage="1"/></sheetPr>
  <dimension ref="A1:${ultimaCol}${ultimaFila}"/>
  <sheetViews>
    <sheetView tabSelected="1" showGridLines="0" zoomScale="100" workbookViewId="0">
      <selection activeCell="A1" sqref="A1"/>
    </sheetView>
  </sheetViews>
  <sheetFormatPr defaultRowHeight="18"/>
  <cols>${cols}</cols>
  <sheetData>${filasXml.join("")}</sheetData>
  ${autoFilter}
  ${mergeCells}
  <pageMargins left="0.4" right="0.4" top="0.5" bottom="0.6" header="0.3" footer="0.3"/>
  <pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/>
  <headerFooter><oddFooter>${xmlEscape(pie)}</oddFooter></headerFooter>
  ${conTabla ? `<tableParts count="1"><tablePart r:id="rId1"/></tableParts>` : ""}
</worksheet>`;

  const tabla = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="${nombre}" displayName="${nombre}" ref="${refTabla}" totalsRowShown="0">
  <autoFilter ref="${refTabla}"/>
  <tableColumns count="${columnas.length}">${columnas
    .map((c, i) => `<tableColumn id="${i + 1}" name="${xmlEscape(c.encabezado)}"/>`)
    .join("")}</tableColumns>
  <tableStyleInfo name="${ESTILO_TABLA}" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/>
</table>`;

  /* Al imprimir se repite la cabecera de la tabla en cada página. */
  const enFormula = `'${xmlEscape(hoja.replace(/'/g, "''"))}'`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="${xmlEscape(hoja)}" sheetId="1" r:id="rId1"/>
  </sheets>
  <definedNames>
    ${conFiltroSuelto ? `<definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">${enFormula}!$A$${filaCabecera}:$${ultimaColTabla}$${ultimaFila}</definedName>` : ""}
    <definedName name="_xlnm.Print_Titles" localSheetId="0">${enFormula}!$${filaCabecera}:$${filaCabecera}</definedName>
  </definedNames>
</workbook>`;

  const sharedStrings = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${usosCadena}" uniqueCount="${cadenas.length}">${cadenas
    .map((s) => `<si><t xml:space="preserve">${xmlEscape(s)}</t></si>`)
    .join("")}</sst>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
  ${conTabla ? `<Override PartName="/xl/tables/table1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/>` : ""}
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`;

  const sheetRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table1.xml"/>
</Relationships>`;

  const zip = new JSZip();
  zip.file("[Content_Types].xml", contentTypes);
  zip.folder("_rels")!.file(".rels", rels);
  const xl = zip.folder("xl")!;
  xl.file("workbook.xml", workbook);
  xl.file("styles.xml", estilosXml());
  /* Después de recorrer las celdas: la tabla de cadenas se llena sobre la marcha. */
  xl.file("sharedStrings.xml", sharedStrings);
  xl.folder("_rels")!.file("workbook.xml.rels", workbookRels);
  const hojas = xl.folder("worksheets")!;
  hojas.file("sheet1.xml", sheet);
  if (conTabla) {
    hojas.folder("_rels")!.file("sheet1.xml.rels", sheetRels);
    xl.folder("tables")!.file("table1.xml", tabla);
  }

  return zip.generateAsync({ type: "uint8array" });
}

export async function descargarXlsxReporte(opts: OpcionesXlsxReporte) {
  const bytes = await construirXlsxReporte(opts);
  const blob = new Blob([bytes as BlobPart], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const nombre = opts.nombreArchivo.endsWith(".xlsx") ? opts.nombreArchivo : `${opts.nombreArchivo}.xlsx`;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = nombre;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** Dos hojas con el mismo generador y estilos: resumen y tabla operacional. */
export async function construirXlsxReporteConResumen(opts: OpcionesXlsxReporte, contexto: readonly (readonly ValorReporte[])[]): Promise<Uint8Array> {
  const resumen = await JSZip.loadAsync(await construirXlsxReporte({ ...opts, hoja: "Resumen",
    tabla: { titulo: "Contexto de la consulta", nombreTabla: "ContextoReporte", columnas: [{ encabezado: "Filtro", ancho: 26 }, { encabezado: "Valor", ancho: 65 }], filas: contexto } }));
  const datos = await JSZip.loadAsync(await construirXlsxReporte({ ...opts, hoja: "Incidentes" }));
  const leer = (zip: JSZip, path: string) => zip.file(path)!.async("string");
  const s1 = await leer(resumen, "xl/sharedStrings.xml");
  const s2 = await leer(datos, "xl/sharedStrings.xml");
  const cadenas1 = s1.match(/<si>[\s\S]*?<\/si>/g) ?? [];
  const cadenas2 = s2.match(/<si>[\s\S]*?<\/si>/g) ?? [];
  const count = Number(s1.match(/ count="(\d+)"/)![1]) + Number(s2.match(/ count="(\d+)"/)![1]);
  resumen.file("xl/sharedStrings.xml", `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${count}" uniqueCount="${cadenas1.length + cadenas2.length}">${[...cadenas1, ...cadenas2].join("")}</sst>`);
  const hoja = (await leer(datos, "xl/worksheets/sheet1.xml")).replace(/(<c\b[^>]*\bt="s"[^>]*><v>)(\d+)(<\/v>)/g, (_, antes, indice, despues) => antes + (Number(indice) + cadenas1.length) + despues);
  resumen.file("xl/worksheets/sheet2.xml", hoja);
  const tabla = datos.file("xl/tables/table1.xml");
  if (tabla) {
    resumen.file("xl/tables/table2.xml", (await tabla.async("string")).replace('id="1"', 'id="2"'));
    resumen.file("xl/worksheets/_rels/sheet2.xml.rels", (await leer(datos, "xl/worksheets/_rels/sheet1.xml.rels")).replace("table1.xml", "table2.xml"));
  }
  // El rId4 queda libre: 1 hoja, 2 estilos y 3 sharedStrings en el generador.
  const workbook = await leer(resumen, "xl/workbook.xml");
  const nombres = (await leer(datos, "xl/workbook.xml")).match(/<definedNames>([\s\S]*?)<\/definedNames>/)?.[1] ?? "";
  resumen.file("xl/workbook.xml", workbook.replace("</sheets>", '<sheet name="Incidentes" sheetId="2" r:id="rId4"/></sheets>').replace("</definedNames>", nombres.replace(/localSheetId="0"/g, 'localSheetId="1"') + "</definedNames>"));
  resumen.file("xl/_rels/workbook.xml.rels", (await leer(resumen, "xl/_rels/workbook.xml.rels")).replace("</Relationships>", '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>'));
  resumen.file("[Content_Types].xml", (await leer(resumen, "[Content_Types].xml")).replace("</Types>", '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' + (tabla ? '<Override PartName="/xl/tables/table2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/>' : "") + "</Types>"));
  return resumen.generateAsync({ type: "uint8array" });
}
