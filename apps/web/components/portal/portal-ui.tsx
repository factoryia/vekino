import type { LucideIcon } from "lucide-react";
import { CheckCircle2, Clock, AlertTriangle, CircleDollarSign } from "lucide-react";

/** Fecha larga en español a partir de un timestamp (ms). */
export function fechaLarga(ts: number): string {
  return new Intl.DateTimeFormat("es-CO", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(ts));
}

/**
 * La fecha de un plazo de la factura (vencimiento, límite del descuento) en
 * hora de Colombia, donde se fijan: el límite del descuento es el último
 * instante del día 15, y en otra zona horaria se leería como el 16.
 */
export function fechaPlazo(ts: number): string {
  return new Intl.DateTimeFormat("es-CO", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "America/Bogota",
  }).format(new Date(ts));
}

/** Fecha corta desde un string ISO "YYYY-MM-DD" (sin desfase de zona). */
export function fechaISO(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Intl.DateTimeFormat("es-CO", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(y, m - 1, d));
}

export type FacturaEstado =
  | "pendiente"
  | "pagada"
  | "vencida"
  | "abonada"
  | "saldo_a_favor";

export const ESTADO_FACTURA: Record<
  FacturaEstado,
  { label: string; tone: "success" | "warning" | "destructive" | "info"; icon: LucideIcon }
> = {
  pagada: { label: "Pagada", tone: "success", icon: CheckCircle2 },
  pendiente: { label: "Pendiente", tone: "warning", icon: Clock },
  vencida: { label: "Vencida", tone: "destructive", icon: AlertTriangle },
  abonada: { label: "Abono parcial", tone: "info", icon: CircleDollarSign },
  saldo_a_favor: {
    label: "Saldo a favor",
    tone: "info",
    icon: CircleDollarSign,
  },
};

/**
 * Lo que ve quien no tiene ninguna casa vinculada HOY —por ejemplo, una
 * arrendataria con el contrato vencido, a quien el backend ya no le da la
 * casa—: ni "Estás al día" ni deuda, porque no hay de qué (QA de
 * comprobantes, H3). Es el mismo aviso de "Mi unidad".
 */
export const TITULO_SIN_UNIDAD = "No tienes una unidad vinculada";
export const TEXTO_SIN_UNIDAD =
  "Pide a la administración que asocie tu apartamento o casa a tu cuenta.";

export const VINCULO_LABEL: Record<string, string> = {
  propietario: "Propietario",
  apoderado: "Apoderado",
  arrendatario: "Arrendatario",
  residente: "Residente",
};

export const TIPO_UNIDAD_LABEL: Record<string, string> = {
  apartamento: "Apartamento",
  casa: "Casa",
  local: "Local",
  parqueadero: "Parqueadero",
  deposito: "Depósito",
  oficina: "Oficina",
  otro: "Unidad",
};

/** "Apartamento 204" · "Apartamento 204 · Torre A" · "… · Bloque B" */
export function etiquetaUnidad(u: {
  numero?: string | null;
  tipo?: string | null;
  torre?: string | null;
  bloque?: string | null;
  unidadNumero?: string | null;
  unidadTipo?: string | null;
  unidadTorre?: string | null;
  unidadBloque?: string | null;
}): string {
  const numero = u.numero ?? u.unidadNumero;
  if (!numero) return "Unidad";
  const tipo = TIPO_UNIDAD_LABEL[u.tipo ?? u.unidadTipo ?? ""] ?? "Unidad";
  const partes = [`${tipo} ${numero}`];
  const torre = (u.torre ?? u.unidadTorre)?.trim();
  const bloque = (u.bloque ?? u.unidadBloque)?.trim();
  if (torre) {
    partes.push(/^torre\b/i.test(torre) ? torre : `Torre ${torre}`);
  }
  if (bloque && bloque.toLowerCase() !== torre?.toLowerCase()) {
    partes.push(/^bloque\b/i.test(bloque) ? bloque : `Bloque ${bloque}`);
  }
  return partes.join(" · ");
}

const MESES_ES = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];

/** "2026-06" | "01-junio-2026" | "Junio / 2026" → "Junio de 2026" */
export function periodoHumano(periodoOrLabel: string): string {
  const ym = periodoOrLabel.match(/^(\d{4})-(\d{2})$/);
  if (ym) {
    const mes = MESES_ES[Number(ym[2]) - 1];
    if (mes) {
      return `${mes.charAt(0).toUpperCase()}${mes.slice(1)} de ${ym[1]}`;
    }
  }
  const dash = periodoOrLabel.match(/^\d{1,2}-([a-záéíóúñ]+)-(\d{4})$/i);
  if (dash?.[1] && dash[2]) {
    const mes = dash[1].toLowerCase();
    return `${mes.charAt(0).toUpperCase()}${mes.slice(1)} de ${dash[2]}`;
  }
  return periodoOrLabel
    .replace(/\s*\/\s*/g, " de ")
    .replace(/\bde de\b/gi, "de");
}

