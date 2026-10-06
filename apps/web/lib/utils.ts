import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Combina clases condicionales resolviendo conflictos de Tailwind. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Formatea un número como pesos colombianos, sin decimales. */
export function cop(n: number) {
  return new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0,
  }).format(n);
}

/** Número con separadores de miles (es-CO). */
export function num(n: number) {
  return new Intl.NumberFormat("es-CO").format(n);
}

/** Iniciales (máx. 2) a partir de un nombre. */
export function initials(name: string) {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .filter((p) => /[\p{L}\p{N}]/u.test(p[0] ?? ""));
  return parts
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

/**
 * Convierte `#RRGGBB` a canales HSL sin `hsl()` — listos para
 * `hsl(var(--brand))` en el design system.
 */
export function hexToHslChannels(hex: string): string | null {
  const raw = hex.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(raw)) return null;

  const r = parseInt(raw.slice(0, 2), 16) / 255;
  const g = parseInt(raw.slice(2, 4), 16) / 255;
  const b = parseInt(raw.slice(4, 6), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        break;
      case g:
        h = ((b - r) / d + 2) / 6;
        break;
      default:
        h = ((r - g) / d + 4) / 6;
        break;
    }
  }

  return `${Math.round(h * 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}

/**
 * Texto sobre `--brand`: blanco si el color es oscuro/medio;
 * casi negro si es muy claro (ej. lima Growin).
 */
export function hexToBrandForeground(hex: string): string {
  const raw = hex.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(raw)) return "0 0% 100%";

  const r = parseInt(raw.slice(0, 2), 16) / 255;
  const g = parseInt(raw.slice(2, 4), 16) / 255;
  const b = parseInt(raw.slice(4, 6), 16) / 255;
  // Luminancia relativa (WCAG)
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.62 ? "120 6% 10%" : "0 0% 100%";
}

/**
 * Extrae el mensaje humano de un error de Convex/JS.
 *
 * El cliente de Convex entrega el error con todo su andamiaje alrededor del
 * mensaje de negocio:
 *
 *   [CONVEX M(inasistencias:crear)] [Request ID: 3f88…] Server Error
 *   Uncaught Error: El guarda tiene una cobertura aceptada…
 *       at handler (../convex/inasistencias.ts:144:8)
 *     Called by client
 *
 * Lo que va a la pantalla es solo la frase de en medio (QA-007): ni el
 * identificador de la petición, ni el archivo y la línea, ni nada de Convex.
 * Si no hay frase de negocio —un fallo interno, una validación de
 * argumentos— queda el texto de respaldo de quien llama.
 */
export function mensajeErrorUsuario(
  e: unknown,
  fallback = "Algo salió mal. Intenta de nuevo.",
): string {
  const raw =
    e instanceof Error
      ? e.message
      : typeof e === "string"
        ? e
        : fallback;

  if (/connection lost|while action was in flight/i.test(raw)) {
    return "Se perdió la conexión al guardar. Espera un momento e intenta de nuevo; si ya quedó creado, no lo vuelvas a crear.";
  }

  /* La frase de negocio va tras "Uncaught Error:", en la misma línea o en la
   * siguiente según el cliente (React o HTTP). */
  const tras = raw.match(/Uncaught (?:Convex)?Error:\s*([\s\S]*)/i);
  const texto = (tras ? tras[1]! : raw)
    .replace(/\[CONVEX[^\]]*\]\s*/gi, "")
    .replace(/\[Request ID:[^\]]*\]\s*/gi, "")
    .replace(/^\s*Server Error\b\s*/i, "")
    /* Y se corta en el primer rastro técnico. */
    .split(/\n|\s+at (?:async )?\S+ \(|\s+Called by client/i)[0]!
    .trim();

  if (
    !texto ||
    texto.startsWith("at ") ||
    /called by client/i.test(texto) ||
    /^(Argument|Returns)ValidationError\b/.test(texto)
  ) {
    return fallback;
  }
  return texto;
}
