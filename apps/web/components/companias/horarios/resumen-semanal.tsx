import { resumenSemanal, type BloqueSemanal } from "@vekino/backend/horariosGuarda";
import { cn } from "@/lib/utils";

/**
 * La semana de un horario, lunes primero. Los días sin bloques se pintan como
 * libres: así se representa un día libre, no con un registro propio.
 */
export function ResumenSemanal({
  bloques,
  compacto,
  className,
}: {
  bloques: readonly BloqueSemanal[];
  /** Solo los días con bloques, en una línea. Para tablas. */
  compacto?: boolean;
  className?: string;
}) {
  const semana = resumenSemanal(bloques);

  if (compacto) {
    const conTrabajo = semana.filter((d) => d.bloques.length > 0);
    return (
      <span className={cn("tabular-nums", className)}>
        {conTrabajo
          .map((d) => `${d.nombre.slice(0, 3)} ${d.bloques.join(", ")}`)
          .join(" · ")}
      </span>
    );
  }

  return (
    <ul className={cn("divide-y divide-border/60 rounded-lg border border-border text-sm", className)}>
      {semana.map((d) => (
        <li key={d.dia} className="flex items-center justify-between gap-3 px-3 py-1.5">
          <span className="text-muted-foreground">{d.nombre}</span>
          {d.bloques.length === 0 ? (
            <span className="text-muted-foreground">Libre</span>
          ) : (
            <span className="tabular-nums text-foreground">{d.bloques.join(" · ")}</span>
          )}
        </li>
      ))}
    </ul>
  );
}
