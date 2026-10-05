import { v } from "convex/values";
import { query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  exigirAlcanceSobreGuarda,
  exigirGuardaActivo,
  guardasElegibles,
} from "./model/alcanceGuarda";
import { entradaVentanaValidator } from "./model/roles";
import { diaColombia } from "./lib/incidenteMetricas";
import { rigeEl, fechasDeVentana } from "./lib/horariosGuarda";
import {
  ORDEN_PARA_CUBRIR,
  evaluarDisponibilidadGuarda,
  ventanaDeConsulta,
  type HorarioEvaluable,
  type InasistenciaEvaluable,
  type MotivoDisponibilidad,
} from "./lib/disponibilidad";

/**
 * Disponibilidad de los guardas para una ventana: CALCULADA, nunca guardada.
 *
 * Solo lee horarios e inasistencias y se los pasa a
 * `evaluarDisponibilidadGuarda`, que es donde vive la regla. No escribe nada,
 * no mira asignaciones, contratos ni turnos, y ninguna puerta de acceso
 * depende de su resultado: es información para planificar.
 *
 * Quién puede: junta horarios e inasistencias, así que exige las DOS
 * capacidades y el alcance de `model/alcanceGuarda.ts` con ambas a la vez
 * —el administrador, toda su compañía; el supervisor, los guardas que hoy
 * trabajan en sus conjuntos—. No sirve para descubrir más guardas de los que
 * ya se ven en esos dos módulos.
 */

const CAPACIDADES = ["seguridad.horarios", "seguridad.inasistencias"] as const;

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
 * Los motivos con el nombre del conjunto puesto, para pintarlos. Nada más se
 * añade: el motivo escrito de una inasistencia nunca llega hasta aquí.
 */
async function conNombres(ctx: QueryCtx, motivos: readonly MotivoDisponibilidad[]) {
  const nombres = new Map<string, Promise<string>>();
  const nombre = (id: string) => {
    if (!nombres.has(id)) {
      nombres.set(
        id,
        ctx.db.get(id as Id<"condominios">).then((c) => c?.name ?? "(conjunto eliminado)"),
      );
    }
    return nombres.get(id)!;
  };
  return await Promise.all(
    motivos.map(async (m) =>
      m.tipo === "horario"
        ? {
            ...m,
            condominioNombre: m.condominioId == null ? null : await nombre(m.condominioId),
          }
        : m,
    ),
  );
}

/**
 * ¿Puede este guarda cubrir esta ventana completa?
 *
 * Devuelve el estado, los motivos, los horarios que rigen durante la ventana
 * (los bloques relevantes) y la ventana resuelta.
 */
export const deGuarda = query({
  args: {
    companiaId: v.id("companiasSeguridad"),
    userId: v.id("users"),
    ventana: entradaVentanaValidator,
  },
  handler: async (ctx, args) => {
    await exigirAlcanceSobreGuarda(ctx, args.companiaId, args.userId, CAPACIDADES);
    await exigirGuardaActivo(
      ctx,
      args.companiaId,
      args.userId,
      "Solo se evalúa la disponibilidad de guardas.",
    );
    const ventana = ventanaDeConsulta(args.ventana);

    /* Acotado por guarda y por fechas: solo lo que empezó antes de que acabe
     * la ventana. Lo que ya había terminado lo descarta la evaluación. */
    const [horarios, inasistencias] = await Promise.all([
      ctx.db
        .query("horariosGuarda")
        .withIndex("by_compania_user", (q) =>
          q
            .eq("companiaId", args.companiaId)
            .eq("userId", args.userId)
            .lte("fechaInicio", ultimoDiaDe(ventana)),
        )
        .collect(),
      ctx.db
        .query("inasistencias")
        .withIndex("by_compania_user", (q) =>
          q
            .eq("companiaId", args.companiaId)
            .eq("userId", args.userId)
            .lt("inicio", ventana.fin),
        )
        .collect(),
    ]);

    const evaluables = horarios.map(horarioEvaluable);
    const resultado = evaluarDisponibilidadGuarda({
      ventana,
      horarios: evaluables,
      inasistencias: inasistencias.map(inasistenciaEvaluable),
    });

    /* Los horarios que rigen algún día de la ventana: el contexto de por qué
     * se sabe (o no) lo que se sabe. */
    const fechas = fechasDeVentana(ventana);
    const vigentes = horarios.filter((h) => fechas.some((f) => rigeEl(h, f)));
    const nombresConjunto = await Promise.all(
      vigentes.map((h) => (h.condominioId ? ctx.db.get(h.condominioId) : null)),
    );

    return {
      userId: args.userId,
      estado: resultado.estado,
      motivos: await conNombres(ctx, resultado.motivos),
      ventana,
      horariosVigentes: vigentes.map((h, i) => ({
        horarioId: h._id,
        condominioId: h.condominioId ?? null,
        condominioNombre: h.condominioId
          ? (nombresConjunto[i]?.name ?? "(conjunto eliminado)")
          : null,
        bloques: h.bloques,
      })),
    };
  },
});

/**
 * La disponibilidad de los guardas que quien pregunta puede gestionar, para
 * una ventana. Primero quien puede cubrir.
 *
 * No crea candidatos ni nada: es la lista que una pantalla de "disponibilidad
 * para cubrir" necesita mirar.
 */
export const deGuardasEnAlcance = query({
  args: {
    companiaId: v.id("companiasSeguridad"),
    ventana: entradaVentanaValidator,
  },
  handler: async (ctx, args) => {
    const guardas = await guardasElegibles(ctx, args.companiaId, CAPACIDADES);
    const ventana = ventanaDeConsulta(args.ventana);
    const visibles = new Set(guardas.map((g) => g.userId));

    /* Dos lecturas para toda la compañía, acotadas por fechas, en vez de dos
     * por guarda. Las inasistencias van por el índice de las activas que aún
     * no han terminado; los horarios, por los que empezaron antes del fin. */
    const [horarios, inasistencias] = await Promise.all([
      ctx.db
        .query("horariosGuarda")
        .withIndex("by_compania", (q) =>
          q.eq("companiaId", args.companiaId).lte("fechaInicio", ultimoDiaDe(ventana)),
        )
        .collect(),
      ctx.db
        .query("inasistencias")
        .withIndex("by_compania_estado_fin", (q) =>
          q.eq("companiaId", args.companiaId).eq("estado", "activa").gt("fin", ventana.inicio),
        )
        .collect(),
    ]);

    const horariosDe = new Map<Id<"users">, HorarioEvaluable[]>();
    for (const h of horarios) {
      if (!visibles.has(h.userId)) continue;
      horariosDe.set(h.userId, [...(horariosDe.get(h.userId) ?? []), horarioEvaluable(h)]);
    }
    const inasistenciasDe = new Map<Id<"users">, InasistenciaEvaluable[]>();
    for (const i of inasistencias) {
      if (!visibles.has(i.userId) || i.inicio >= ventana.fin) continue;
      inasistenciasDe.set(i.userId, [
        ...(inasistenciasDe.get(i.userId) ?? []),
        inasistenciaEvaluable(i),
      ]);
    }

    const filas = await Promise.all(
      guardas.map(async (g) => {
        const r = evaluarDisponibilidadGuarda({
          ventana,
          horarios: horariosDe.get(g.userId) ?? [],
          inasistencias: inasistenciasDe.get(g.userId) ?? [],
        });
        return {
          userId: g.userId,
          nombre: g.nombre,
          estado: r.estado,
          motivos: await conNombres(ctx, r.motivos),
        };
      }),
    );

    return {
      ventana,
      guardas: filas.sort(
        (a, b) =>
          ORDEN_PARA_CUBRIR[a.estado] - ORDEN_PARA_CUBRIR[b.estado] ||
          a.nombre.localeCompare(b.nombre, "es"),
      ),
    };
  },
});
