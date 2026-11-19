"use client";

import { usePaginatedQuery, type PaginationStatus } from "convex/react";
import { Loader2 } from "lucide-react";
import { api } from "@vekino/backend/api";
import type { Id } from "@vekino/backend/dataModel";
import { Button } from "@/components/ui/button";

/**
 * EL HISTORIAL DE RONDAS, POR PÁGINAS.
 *
 * Lo comparten las tres pantallas que lo muestran —el guarda, la
 * administración del conjunto y la supervisión—, así que el tamaño de página
 * y el botón viven aquí una sola vez.
 *
 * Pagina el servidor (`rondas.listarPagina`), con los cursores de Convex: cada
 * página lee sus rondas y lo que cuelga de ellas, no el historial entero. Si
 * cambia el conjunto o el guarda, `usePaginatedQuery` empieza de nuevo por la
 * primera página; si llega una ronda nueva, aparece arriba sin duplicar las ya
 * cargadas.
 */
export const RONDAS_POR_PAGINA = 20;

export function useRondasPaginadas(
  condominioId: Id<"condominios">,
  guardiaUserId?: Id<"users">,
) {
  return usePaginatedQuery(
    api.rondas.listarPagina,
    { condominioId, guardiaUserId },
    { initialNumItems: RONDAS_POR_PAGINA },
  );
}

/**
 * "Cargar más" mientras quede historial; deshabilitado mientras llega la
 * página (Convex además ignora un segundo `loadMore` en vuelo). Al final, solo
 * si hubo que paginar, una línea que dice que no hay nada más antiguo.
 */
export function CargarMasRondas({
  status,
  loadMore,
  cargadas,
}: {
  status: PaginationStatus;
  loadMore: (numItems: number) => void;
  cargadas: number;
}) {
  if (status === "CanLoadMore" || status === "LoadingMore") {
    const cargando = status === "LoadingMore";
    return (
      <div className="flex justify-center">
        <Button
          variant="outline"
          size="sm"
          disabled={cargando}
          onClick={() => loadMore(RONDAS_POR_PAGINA)}
        >
          {cargando ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              Cargando…
            </>
          ) : (
            "Cargar más"
          )}
        </Button>
      </div>
    );
  }
  if (status === "Exhausted" && cargadas > RONDAS_POR_PAGINA) {
    return (
      <p className="text-center text-xs text-muted-foreground">
        No hay rondas más antiguas · {cargadas} en total
      </p>
    );
  }
  return null;
}
