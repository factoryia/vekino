"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@vekino/backend/api";
import type { Id } from "@vekino/backend/dataModel";
import { Home, Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

type Vinculo = "propietario" | "residente" | "arrendatario" | "apoderado";

export type UnidadElegida = {
  _id: Id<"unidades">;
  numero: string;
  torre: string | null;
  /** Quien vive ahí, para que el guarda sepa que escogió la casa correcta. */
  residente?: string | null;
  vinculo?: Vinculo | null;
};

/** Cuántas trae el backend como máximo (`LIMITE_CASAS` en guardia.ts). */
const LIMITE = 50;

const VINCULO_LABEL: Record<Vinculo, string> = {
  propietario: "propietario",
  residente: "residente",
  arrendatario: "arrendatario",
  apoderado: "apoderado",
};

export const etiquetaUnidad = (u: Pick<UnidadElegida, "numero" | "torre">) =>
  [u.torre, u.numero].filter(Boolean).join(" ");

/**
 * Escoge una o varias casas, mostrando quién vive en cada una.
 *
 * Es el selector de casa de toda la portería: paquetería, aporte voluntario y
 * "otra novedad". Al abrirlo se ven las casas; al escribir se filtran por
 * número o por nombre —el domiciliario dice "para Carlos", no "para la 101"—.
 * Cada opción lleva el nombre porque "101" a secas no le dice al guarda si
 * escogió bien, y con dos torres puede haber dos 101.
 *
 * Ninguna es una respuesta válida en las novedades: la mayoría son de la
 * portería o de una zona común y no le competen a nadie en particular. Por
 * eso no hay estado de error cuando la lista está vacía.
 *
 * Varias porque hay novedades que tocan a más de una casa —una gotera entre
 * dos apartamentos, un ruido que afecta a la manzana—. Cuando solo se podía
 * una, el guarda abría un reporte y escribía el resto en la descripción,
 * donde después no se puede buscar. Con `unica` se escoge una sola (un
 * paquete va a una casa).
 *
 * `onTextoLibre`: para lo que no está en la lista. La portería no puede
 * quedarse sin recibir un paquete porque la casa no esté cargada todavía.
 */
export function SelectorUnidades({
  condominioId,
  elegidas,
  onChange,
  unica = false,
  onTextoLibre,
  placeholder = "Buscar casa por número o residente…",
}: {
  condominioId: Id<"condominios">;
  elegidas: UnidadElegida[];
  onChange: (u: UnidadElegida[]) => void;
  unica?: boolean;
  onTextoLibre?: (texto: string) => void;
  placeholder?: string;
}) {
  const [texto, setTexto] = useState("");
  const [busqueda, setBusqueda] = useState("");
  const [abierto, setAbierto] = useState(false);
  const [activo, setActivo] = useState(0);
  const contenedor = useRef<HTMLDivElement>(null);

  // Espera a que deje de escribir: si no, va una consulta por tecla.
  useEffect(() => {
    const t = setTimeout(() => setBusqueda(texto.trim()), 250);
    return () => clearTimeout(t);
  }, [texto]);

  const resultados = useQuery(
    api.guardia.buscarUnidad,
    abierto ? { condominioId, texto: busqueda } : "skip",
  );

  /* Mientras llega la consulta nueva se deja la anterior en pantalla: si no,
     la lista parpadea a un spinner con cada letra. */
  const [previos, setPrevios] = useState<typeof resultados>(undefined);
  useEffect(() => {
    if (resultados) setPrevios(resultados);
  }, [resultados]);
  const lista = resultados ?? previos;
  const cargando = abierto && resultados === undefined;

  useEffect(() => setActivo(0), [busqueda]);

  const yaEsta = (id: Id<"unidades">) => elegidas.some((e) => e._id === id);
  const lleno = unica && elegidas.length > 0;

  function elegir(u: UnidadElegida) {
    if (yaEsta(u._id)) return;
    onChange(unica ? [u] : [...elegidas, u]);
    setTexto("");
    setBusqueda("");
    if (unica) setAbierto(false);
  }

  function teclado(e: React.KeyboardEvent<HTMLInputElement>) {
    const n = lista?.length ?? 0;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setAbierto(true);
      if (n) setActivo((a) => (a + 1) % n);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (n) setActivo((a) => (a - 1 + n) % n);
    } else if (e.key === "Enter") {
      /* Enter dentro de un modal no debe enviar el formulario a medias. */
      e.preventDefault();
      const u = lista?.[activo];
      if (abierto && u) elegir(u);
    } else if (e.key === "Escape" && abierto) {
      e.stopPropagation();
      setAbierto(false);
    }
  }

  return (
    <div
      ref={contenedor}
      className="space-y-2"
      onBlur={(e) => {
        if (!contenedor.current?.contains(e.relatedTarget as Node | null)) setAbierto(false);
      }}
    >
      {elegidas.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {elegidas.map((u) => (
            <span
              key={u._id}
              className="inline-flex max-w-full items-center gap-1.5 rounded-lg bg-muted px-2 py-1 text-[13px] font-medium text-foreground"
            >
              <Home className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
              <span className="truncate">
                {etiquetaUnidad(u)}
                {u.residente && (
                  <span className="font-normal text-muted-foreground"> — {u.residente}</span>
                )}
              </span>
              <button
                type="button"
                onClick={() => onChange(elegidas.filter((e) => e._id !== u._id))}
                aria-label={`Quitar ${etiquetaUnidad(u)}`}
                className="rounded p-0.5 text-muted-foreground hover:text-destructive"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      {!lleno && (
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={texto}
            onChange={(e) => {
              setTexto(e.target.value);
              setAbierto(true);
            }}
            onFocus={() => setAbierto(true)}
            onClick={() => setAbierto(true)}
            onKeyDown={teclado}
            placeholder={placeholder}
            className="pl-9"
            role="combobox"
            aria-expanded={abierto}
            aria-autocomplete="list"
          />
          {cargando && (
            <Spinner className="absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2" />
          )}
        </div>
      )}

      {abierto && !lleno && (
        lista === undefined ? (
          <div className="flex justify-center py-2">
            <Spinner className="h-4 w-4" />
          </div>
        ) : lista.length > 0 ? (
          <ul
            role="listbox"
            className="max-h-56 divide-y divide-border overflow-y-auto rounded-xl border border-border"
          >
            {lista.map((u, i) => (
              <li key={u._id} role="option" aria-selected={i === activo}>
                <button
                  type="button"
                  disabled={yaEsta(u._id)}
                  onClick={() => elegir(u)}
                  onMouseEnter={() => setActivo(i)}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-accent disabled:opacity-40",
                    i === activo && "bg-accent",
                  )}
                >
                  <Home className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="shrink-0 font-medium text-foreground">{etiquetaUnidad(u)}</span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {u.residente ? (
                      <>
                        — {u.residente}
                        {u.vinculo && u.vinculo !== "propietario" && (
                          <span className="text-xs"> ({VINCULO_LABEL[u.vinculo]})</span>
                        )}
                      </>
                    ) : (
                      <span className="italic">— sin residente registrado</span>
                    )}
                  </span>
                  {yaEsta(u._id) && (
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">ya está</span>
                  )}
                </button>
              </li>
            ))}
            {lista.length >= LIMITE && (
              <li className="px-3 py-2 text-[12px] text-muted-foreground">
                Hay más casas: escribe el número o el nombre para encontrarla.
              </li>
            )}
          </ul>
        ) : (
          <div className="space-y-1.5 px-1">
            <p className="text-[13px] text-muted-foreground">
              {busqueda ? "Ninguna casa con ese número o residente." : "El conjunto no tiene casas cargadas."}
            </p>
            {onTextoLibre && busqueda && (
              <button
                type="button"
                onClick={() => {
                  onTextoLibre(busqueda);
                  setTexto("");
                  setBusqueda("");
                  setAbierto(false);
                }}
                className="text-[13px] font-medium text-brand hover:underline"
              >
                Usar «{busqueda}» aunque no esté en la lista
              </button>
            )}
          </div>
        )
      )}
    </div>
  );
}
