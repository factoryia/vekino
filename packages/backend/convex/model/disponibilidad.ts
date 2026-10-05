import type { QueryCtx, MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { diaColombia } from "../lib/incidenteMetricas";
import {
  evaluarDisponibilidadGuarda,
  type Disponibilidad,
  type HorarioEvaluable,
  type InasistenciaEvaluable,
} from "../lib/disponibilidad";
import { coberturasQueOcupan } from "./cobertura";

type Ctx = QueryCtx | MutationCtx;

/**
 * Cargar lo de un guarda y evaluarlo, en un solo sitio.
 *
 * Lo usan las dos consultas de disponibilidad —la de un guarda y la lista de
 * todos— y las mutaciones de cobertura —al solicitar y otra vez al aceptar—,
 * para que "disponible" signifique lo mismo en la lista, en el detalle y en la
 * validación. La regla está en `lib/disponibilidad.ts`.
 */

/**
 * Lo que hay que poder ver para evaluar a un guarda: sus horarios y sus
 * inasistencias. Con `model/alcanceGuarda.ts` el alcance es la intersección
 * de las dos, así que evaluar no enseña nada que por separado no se vea.
 */
export const CAPACIDADES_DISPONIBILIDAD = [
  "seguridad.horarios",
  "seguridad.inasistencias",
] as const;

function horarioEvaluable(h: Doc<"horariosGuarda">): HorarioEvaluable {
  return {
    id: h._id,
    condominioId: h.condominioId ?? null,
    fechaInicio: h.fechaInicio,
    fechaFin: h.fechaFin,
    terminaEl: h.terminaEl,
    bloques: h.bloques,
  };
}

function inasistenciaEvaluable(i: Doc<"inasistencias">): InasistenciaEvaluable {
  return { id: i._id, tipo: i.tipo, inicio: i.inicio, fin: i.fin, estado: i.estado };
}

/** El último día civil que toca la ventana: los horarios que empiezan después no cuentan. */
function ultimoDiaDe(ventana: { inicio: number; fin: number }): string {
  return diaColombia(ventana.fin - 1);
}

/**
 * Evalúa a un guarda para una ventana.
 *
 * Acotado por guarda y por fechas: los horarios y las inasistencias que
 * empezaron antes de que acabe la ventana, y las coberturas que lo ocupan.
 * Devuelve también los horarios leídos, para quien quiera mostrarlos.
 */
export async function evaluarDisponibilidadDe(
  ctx: Ctx,
  companiaId: Id<"companiasSeguridad">,
  userId: Id<"users">,
  ventana: { inicio: number; fin: number },
): Promise<Disponibilidad & { horarios: Doc<"horariosGuarda">[] }> {
  const [horarios, inasistencias, coberturas] = await Promise.all([
    ctx.db
      .query("horariosGuarda")
      .withIndex("by_compania_user", (q) =>
        q
          .eq("companiaId", companiaId)
          .eq("userId", userId)
          .lte("fechaInicio", ultimoDiaDe(ventana)),
      )
      .collect(),
    ctx.db
      .query("inasistencias")
      .withIndex("by_compania_user", (q) =>
        q.eq("companiaId", companiaId).eq("userId", userId).lt("inicio", ventana.fin),
      )
      .collect(),
    coberturasQueOcupan(ctx, userId, ventana),
  ]);

  const resultado = evaluarDisponibilidadGuarda({
    ventana,
    horarios: horarios.map(horarioEvaluable),
    inasistencias: inasistencias.map(inasistenciaEvaluable),
    coberturas,
  });
  return { ...resultado, horarios };
}
