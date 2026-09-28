import type { FunctionReturnType } from "convex/server";
import { Car, Home, Paperclip } from "lucide-react";
import { api } from "@vekino/backend/api";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type Reporte = FunctionReturnType<typeof api.guardia.listNovedadReportes>[number];

const PRIORIDAD_META = {
  baja: { label: "Baja", cls: "bg-slate-500/10 text-slate-600", dot: "bg-slate-400" },
  media: { label: "Media", cls: "bg-amber-500/10 text-amber-600", dot: "bg-amber-500" },
  alta: { label: "Alta", cls: "bg-red-500/10 text-red-600", dot: "bg-red-500" },
};

function fmtFechaHora(ts: number) {
  return new Date(ts).toLocaleString("es-CO", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function textoPropietarios(ps: Reporte["propietarios"]) {
  const variasCasas = new Set(ps.map((p) => p.unidadId)).size > 1;
  const nombres = ps.map((p) => (variasCasas ? `${p.numero} ${p.nombre}` : p.nombre));
  return `${ps.length > 1 ? "Propietarios" : "Propietario"}: ${nombres.join(" · ")}`;
}

/** Presentación común: conserva evidencia, unidades y datos del autor en ambos apartados. */
export function ReporteCard({ n }: { n: Reporte }) {
  const meta = PRIORIDAD_META[n.prioridad];
  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        <span className={cn("mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full", meta.dot)} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-semibold text-foreground">{n.titulo}</p>
            <span className={cn("rounded-md px-2 py-0.5 text-[11px] font-semibold", meta.cls)}>
              Prioridad {meta.label}
            </span>
          </div>
          {(n.vehiculoPlaca || n.unidades.length > 0) && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {n.vehiculoPlaca && (
                <span className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-0.5 font-mono text-[12px] font-bold tracking-wider text-foreground">
                  <Car className="h-3 w-3" aria-hidden /> {n.vehiculoPlaca}
                </span>
              )}
              {n.unidades.map((u) => (
                <span key={u.unidadId} className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-[12px] text-foreground">
                  <Home className="h-3 w-3 text-muted-foreground" aria-hidden /> {u.numero}
                </span>
              ))}
            </div>
          )}
          {n.propietarios.length > 0 && (
            <p className="mt-1 text-[13px] text-muted-foreground">{textoPropietarios(n.propietarios)}</p>
          )}
          <p className="mt-1 whitespace-pre-line text-sm text-foreground">{n.descripcion}</p>
          {n.fotos.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {n.fotos.map((fo) => (
                <a key={fo.url} href={fo.url} target="_blank" rel="noreferrer" className="block h-16 w-16 overflow-hidden rounded-lg border border-border">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={fo.url} alt={fo.nombre ?? "Evidencia"} className="h-full w-full object-cover" />
                </a>
              ))}
            </div>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>{n.reportadoPorNombre}</span>
            <span>·</span>
            <span>{fmtFechaHora(n.ocurrioEn)}</span>
            {n.ocurrioEn !== n.createdAt && (
              <span className="text-muted-foreground/70">(registrada {fmtFechaHora(n.createdAt)})</span>
            )}
            {n.archivoUrl && (
              <a href={n.archivoUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-brand hover:underline">
                <Paperclip className="h-3 w-3" /> {n.archivoNombre ?? "Adjunto"}
              </a>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}
