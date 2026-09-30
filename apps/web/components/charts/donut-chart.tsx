"use client";

import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";

export interface DonutSlice {
  label: string;
  value: number;
  color: string; // css color
}

type Seg = DonutSlice & {
  frac: number;
  pct: number;
  startAngle: number; // degrees, 0 = top, clockwise
  endAngle: number;
};

/**
 * Donut chart SVG, theme-aware. Tooltip al pasar sobre el anillo o la leyenda.
 */
export function DonutChart({
  data,
  size = 168,
  thickness = 20,
  centerValue,
  centerLabel,
  showLegend = true,
  className,
}: {
  data: DonutSlice[];
  size?: number;
  thickness?: number;
  centerValue?: string | number;
  centerLabel?: string;
  showLegend?: boolean;
  className?: string;
}) {
  const total = data.reduce((s, d) => s + d.value, 0);
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  const cx = size / 2;
  const cy = size / 2;
  const [hover, setHover] = useState<number | null>(null);

  const segments: Seg[] = useMemo(() => {
    let angle = 0;
    return data
      .filter((d) => d.value > 0)
      .map((d) => {
        const frac = total > 0 ? d.value / total : 0;
        const sweep = frac * 360;
        const seg: Seg = {
          ...d,
          frac,
          pct: Math.round(frac * 100),
          startAngle: angle,
          endAngle: angle + sweep,
        };
        angle += sweep;
        return seg;
      });
  }, [data, total]);

  function pickSegment(clientX: number, clientY: number, el: Element) {
    const rect = el.getBoundingClientRect();
    const dx = clientX - (rect.left + rect.width / 2);
    const dy = clientY - (rect.top + rect.height / 2);
    const dist = Math.sqrt(dx * dx + dy * dy);
    const scale = size / rect.width;
    const r = dist * scale;
    const inner = radius - thickness / 2 - 4;
    const outer = radius + thickness / 2 + 4;
    if (r < inner || r > outer) {
      setHover(null);
      return;
    }
    // Ángulo desde arriba, sentido horario (coincide con -rotate-90 del SVG)
    let deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
    if (deg < 0) deg += 360;
    const idx = segments.findIndex(
      (s) => deg >= s.startAngle && deg < s.endAngle,
    );
    setHover(idx >= 0 ? idx : segments.length - 1);
  }

  const active = hover != null ? segments[hover] : null;
  let dashOffset = 0;

  return (
    <div className={cn("flex flex-col items-center gap-5", className)}>
      <div
        className="relative shrink-0"
        style={{ width: size, height: size }}
        onMouseLeave={() => setHover(null)}
      >
        <svg
          width={size}
          height={size}
          className="-rotate-90 cursor-pointer"
          onMouseMove={(e) => pickSegment(e.clientX, e.clientY, e.currentTarget)}
        >
          <circle
            cx={cx}
            cy={cy}
            r={radius}
            fill="none"
            stroke="hsl(var(--muted))"
            strokeWidth={thickness}
          />
          {total > 0 &&
            segments.map((s, i) => {
              const dash = s.frac * circumference;
              const gap = circumference - dash;
              const offset = -dashOffset;
              dashOffset += dash;
              const isActive = hover === i;
              const dimmed = hover != null && hover !== i;
              return (
                <circle
                  key={s.label}
                  cx={cx}
                  cy={cy}
                  r={radius}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={isActive ? thickness + 3 : thickness}
                  strokeDasharray={`${dash} ${gap}`}
                  strokeDashoffset={offset}
                  strokeLinecap="butt"
                  className="transition-[stroke-width,opacity] duration-150"
                  style={{ opacity: dimmed ? 0.72 : 1 }}
                  pointerEvents="none"
                />
              );
            })}
        </svg>

        {(centerValue != null || centerLabel || active) && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            {active ? (
              <>
                <span className="text-2xl font-semibold tracking-tight tabular-nums text-foreground">
                  {active.pct}%
                </span>
                <span className="max-w-28 truncate text-center text-xs text-muted-foreground">
                  {active.label} · {active.value}
                </span>
              </>
            ) : (
              <>
                {centerValue != null && (
                  <span className="text-2xl font-semibold tracking-tight tabular-nums text-foreground">
                    {centerValue}
                  </span>
                )}
                {centerLabel && (
                  <span className="text-xs text-muted-foreground">{centerLabel}</span>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {showLegend && <ul className="w-full space-y-2">
        {data.map((d) => {
          const pct = total > 0 ? Math.round((d.value / total) * 100) : 0;
          const segIdx = segments.findIndex((s) => s.label === d.label);
          const isActive = hover === segIdx;
          return (
            <li
              key={d.label}
              className={cn(
                "flex cursor-default items-center gap-2.5 rounded-lg px-1.5 py-1 text-sm transition-colors",
                isActive && "bg-muted/60",
              )}
              onMouseEnter={() => segIdx >= 0 && setHover(segIdx)}
              onMouseLeave={() => setHover(null)}
            >
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: d.color }}
              />
              <span className="flex-1 text-muted-foreground">{d.label}</span>
              <span className="font-medium tabular-nums text-foreground">{d.value}</span>
              <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">
                {pct}%
              </span>
            </li>
          );
        })}
      </ul>}
    </div>
  );
}
