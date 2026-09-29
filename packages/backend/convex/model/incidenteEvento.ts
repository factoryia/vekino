import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { displayNameFromUser } from "./displayName";

export type CambioIncidente = {
  campo: string;
  antes?: string;
  despues?: string;
};

/** Único punto de escritura del historial. Se llama dentro de la mutación del caso. */
export async function logIncidenteEvento(
  ctx: MutationCtx,
  args: {
    incidente: Doc<"incidentes"> | {
      _id: Id<"incidentes">;
      companiaId: Id<"companiasSeguridad">;
      condominioId: Id<"condominios">;
    };
    tipo: Doc<"incidenteEventos">["tipo"];
    descripcion: string;
    actor: Doc<"users">;
    cambios?: CambioIncidente[];
    ahora: number;
  },
): Promise<Id<"incidenteEventos">> {
  return await ctx.db.insert("incidenteEventos", {
    incidenteId: args.incidente._id,
    companiaId: args.incidente.companiaId,
    condominioId: args.incidente.condominioId,
    tipo: args.tipo,
    descripcion: args.descripcion,
    ...(args.cambios?.length ? { cambios: args.cambios } : {}),
    actorUserId: args.actor._id,
    actorNombre: displayNameFromUser(args.actor),
    createdAt: args.ahora,
  });
}
