import { v } from "convex/values";
import { query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  exigirAlcanceSobreGuarda,
  exigirGuardaActivo,
  guardasElegibles,
} from "./model/alcanceGuarda";
import {
  CAPACIDADES_DISPONIBILIDAD,
  evaluarDisponibilidadDe,
} from "./model/disponibilidad";
import { entradaVentanaValidator } from "./model/roles";
import { rigeEl, fechasDeVentana } from "./lib/horariosGuarda";
import {
  ORDEN_PARA_CUBRIR,
  ventanaDeConsulta,
  type MotivoDisponibilidad,
} from "./lib/disponibilidad";

/**
 * Disponibilidad de los guardas para una ventana: CALCULADA, nunca guardada.
 *
 * Solo lee horarios, inasistencias y las coberturas que ya ocupan al guarda,
 * y se los pasa a `evaluarDisponibilidadGuarda`, que es donde vive la regla.
 * No escribe nada, no mira asignaciones, contratos ni turnos, y ninguna puerta
 * de acceso depende de su resultado: es información para planificar.
 *
 * Quién puede: junta horarios e inasistencias, así que exige las DOS
 * capacidades y el alcance de `model/alcanceGuarda.ts` con ambas a la vez
 * —el administrador, toda su compañía; el supervisor, los guardas que hoy
 * trabajan en sus conjuntos—. No sirve para descubrir más guardas de los que
 * ya se ven en esos dos módulos.
 */

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
        : m.tipo === "cobertura"
          ? { ...m, condominioNombre: await nombre(m.condominioId) }
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
    await exigirAlcanceSobreGuarda(ctx, args.companiaId, args.userId, CAPACIDADES_DISPONIBILIDAD);
    await exigirGuardaActivo(
      ctx,
      args.companiaId,
      args.userId,
      "Solo se evalúa la disponibilidad de guardas.",
    );
    const ventana = ventanaDeConsulta(args.ventana);
    const resultado = await evaluarDisponibilidadDe(ctx, args.companiaId, args.userId, ventana);

    /* Los horarios que rigen algún día de la ventana: el contexto de por qué
     * se sabe (o no) lo que se sabe. */
    const fechas = fechasDeVentana(ventana);
    const vigentes = resultado.horarios.filter((h) => fechas.some((f) => rigeEl(h, f)));
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
 *
 * Cada guarda se evalúa con `evaluarDisponibilidadDe`, la MISMA carga y la
 * misma regla que la consulta individual y que la revalidación de `crear` y
 * `aceptar`. Antes esta lista cargaba los datos por su cuenta y solo veía las
 * coberturas de esta compañía, así que un guarda ocupado por otra salía
 * "disponible" aquí y "ocupado" al pedírsela. La compañía decide a qué
 * guardas alcanza; lo que ocupa a cada uno se mira entero.
 */
export const deGuardasEnAlcance = query({
  args: {
    companiaId: v.id("companiasSeguridad"),
    ventana: entradaVentanaValidator,
  },
  handler: async (ctx, args) => {
    const guardas = await guardasElegibles(ctx, args.companiaId, CAPACIDADES_DISPONIBILIDAD);
    const ventana = ventanaDeConsulta(args.ventana);

    const filas = await Promise.all(
      guardas.map(async (g) => {
        const r = await evaluarDisponibilidadDe(ctx, args.companiaId, g.userId, ventana);
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
