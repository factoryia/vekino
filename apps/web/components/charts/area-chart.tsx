"use client";

import { useId, useState } from "react";
import { cn } from "@/lib/utils";

export interface AreaPoint {
  label: string;
  value: number;
}

/**
 * Area chart SVG con curva suave + gradiente y tooltip al hover.
 * Labels del eje X fuera del SVG (evita recortes por stretch).
 */
export function AreaChart({
  data,
  color = "hsl(var(--brand))",
  height = 200,
  format = (n) => String(n),
  className,
  labelEvery = 1,
}: {
  data: AreaPoint[];
  color?: string;
  height?: number;
  format?: (n: number) => string;
  className?: string;
  labelEvery?: number;
}) {
  const gradId = useId();
  const [hover, setHover] = useState<number | null>(null);

  const W = 640;
  const H = height;
  const padX = 44;
  const padTop = 16;
  const padBottom = 8;

  const n = data.length;
  const max = Math.max(1, ...data.map((d) => d.value));
  const innerW = W - padX * 2;
  const innerH = H - padTop - padBottom;

  const x = (i: number) => (n <= 1 ? W / 2 : padX + (i / (n - 1)) * innerW);
  const y = (v: number) => padTop + innerH - (v / max) * innerH;

  const points = data.map((d, i) => ({ x: x(i), y: y(d.value), ...d }));
  const linePath = smoothPath(points.map((p) => [p.x, p.y] as [number, number]));
  const areaPath =
    points.length > 0
      ? `${linePath} L ${points[points.length - 1]!.x} ${padTop + innerH} L ${points[0]!.x} ${padTop + innerH} Z`
      : "";

  const active = hover != null ? points[hover] : null;
  const yTicks = [0, 0.5, 1].map((f) => ({
    f,
    value: max * (1 - f),
    y: padTop + innerH * f,
  }));

  return (
    <div className={cn("w-full", className)}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        style={{ maxHeight: height }}
        preserveAspectRatio="xMidYMid meet"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - rect.left) / rect.width) * W;
          let nearest = 0;
          let best = Infinity;
          points.forEach((p, i) => {
            const d = Math.abs(p.x - px);
            if (d < best) {
              best = d;
              nearest = i;
            }
          });
          setHover(nearest);
        }}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.28} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>

        {yTicks.map((t) => (
          <g key={t.f}>
            <line
              x1={padX}
              x2={W - padX}
              y1={t.y}
              y2={t.y}
              stroke="hsl(var(--border))"
              strokeWidth={1}
              strokeDasharray="3 4"
            />
            <text
              x={padX - 8}
              y={t.y + 3}
              textAnchor="end"
              fill="hsl(var(--muted-foreground))"
              style={{ fontSize: 10 }}
            >
              {compact(t.value)}
            </text>
          </g>
        ))}

        {areaPath && <path d={areaPath} fill={`url(#${gradId})`} />}
        {linePath && (
          <path
            d={linePath}
            fill="none"
            stroke={color}
            strokeWidth={2.5}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        )}

        {points.map((p, i) => (
          <circle
            key={i}
            cx={p.x}
            cy={p.y}
            r={hover === i ? 5 : 3}
            fill={color}
            stroke="hsl(var(--card))"
            strokeWidth={2}
            opacity={hover == null || hover === i ? 1 : 0.35}
          />
        ))}

        {active && (
          <line
            x1={active.x}
            x2={active.x}
            y1={padTop}
            y2={padTop + innerH}
            stroke="hsl(var(--border))"
            strokeWidth={1}
          />
        )}
      </svg>

      {/* Labels X fuera del SVG — no se cortan */}
      <div
        className="mt-2 grid gap-1"
        style={{
          gridTemplateColumns: `repeat(${Math.max(n, 1)}, minmax(0, 1fr))`,
          paddingLeft: `${(padX / W) * 100}%`,
          paddingRight: `${(padX / W) * 100}%`,
        }}
      >
        {data.map((d, i) => (
          <span
            key={i}
            className={cn(
              "truncate text-center text-[11px] tabular-nums",
              hover === i
                ? "font-medium text-foreground"
                : "text-muted-foreground",
            )}
          >
            {i % labelEvery === 0 || i === data.length - 1 ? d.label : ""}
          </span>
        ))}
      </div>

      {active && (
        <div className="mt-3 flex items-center justify-center gap-2 rounded-lg bg-muted/50 px-3 py-2 text-xs">
          <span className="font-medium text-foreground">{active.label}</span>
          <span className="text-muted-foreground">·</span>
          <span className="font-semibold tabular-nums text-foreground">
            {format(active.value)}
          </span>
        </div>
      )}
    </div>
  );
}

function compact(n: number) {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(Math.round(n));
}

function smoothPath(pts: [number, number][]): string {
  if (pts.length === 0) return "";
  if (pts.length === 1) return `M ${pts[0]![0]} ${pts[0]![1]}`;
  const p = pts;
  let d = `M ${p[0]![0]} ${p[0]![1]}`;
  for (let i = 0; i < p.length - 1; i++) {
    const p0 = p[i === 0 ? 0 : i - 1]!;
    const p1 = p[i]!;
    const p2 = p[i + 1]!;
    const p3 = p[i + 2 < p.length ? i + 2 : i + 1]!;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2[0]} ${p2[1]}`;
  }
  return d;
}
