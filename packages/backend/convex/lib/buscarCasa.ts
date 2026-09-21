/**
 * Búsqueda de casas para la portería: por número o por quien vive ahí.
 *
 * Función pura, sin Convex, para poder probarla en Node sin montar nada. La
 * usa `guardia.buscarUnidad`, que es el selector de casa de paquetería, del
 * aporte voluntario y de "otra novedad".
 *
 * El guarda escribe lo que tenga a mano: el número que dice la guía del
 * paquete ("101"), el nombre que le dio el domiciliario ("carlos") o las dos
 * cosas ("101 carlos"). Todas las palabras tienen que aparecer, en la casa o
 * en el nombre de una misma persona, y sin importar tildes ni mayúsculas:
 * nadie escribe "María" con tilde en el celular de la portería.
 */

export type Vinculo = "propietario" | "residente" | "arrendatario" | "apoderado";

export type Ocupante = { nombre: string; vinculo: Vinculo };

export type CasaParaBuscar = {
  numero: string;
  torre?: string | null;
  bloque?: string | null;
  tipo?: string | null;
  ocupantes: Ocupante[];
};

/**
 * A quién se nombra primero cuando una casa tiene varias personas.
 *
 * El propietario responde por la casa; después quien vive ahí. El apoderado
 * de último: representa al dueño en la asamblea pero normalmente no vive en
 * el conjunto, y a él no se le entrega un paquete.
 */
export function ordenVinculo(v: string): number {
  return v === "propietario" ? 0 : v === "residente" ? 1 : v === "arrendatario" ? 2 : 3;
}

/** Minúsculas, sin tildes y con un solo espacio entre palabras. */
export function normalizar(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/* "apto" es como se escribe en la portería; el tipo guardado es "apartamento". */
const ALIAS_TIPO: Record<string, string> = { apartamento: "apartamento apto" };

function textoDeCasa(c: CasaParaBuscar): string {
  const tipo = c.tipo ? (ALIAS_TIPO[c.tipo] ?? c.tipo) : "";
  return normalizar(`${tipo} ${c.torre ?? ""} ${c.bloque ?? ""} ${c.numero}`);
}

/**
 * Qué tan bien casa el número con lo escrito: el número exacto primero, luego
 * los que empiezan así, y el resto. Quien escribe "10" busca la 101 antes que
 * la 210.
 */
function rango(c: CasaParaBuscar, palabras: string[]): number {
  const numero = normalizar(c.numero);
  if (palabras.some((p) => p === numero)) return 0;
  if (palabras.some((p) => numero.startsWith(p))) return 1;
  return 2;
}

/**
 * Las casas que responden a `texto`, cada una con la persona que se muestra.
 *
 * La persona es la que casó con la búsqueda —si el guarda buscó "ana" y en la
 * 101 viven Carlos (propietario) y Ana (arrendataria), se muestra Ana, que es
 * a quien buscaba—. Si la búsqueda fue por número, o no hay búsqueda, se
 * muestra el titular según `ordenVinculo`.
 *
 * Texto vacío devuelve todas: es la lista que se ve al abrir el selector.
 */
export function buscarCasas<T extends CasaParaBuscar>(
  casas: T[],
  texto: string,
  limite: number,
): Array<T & { persona: Ocupante | null }> {
  const palabras = normalizar(texto).split(" ").filter(Boolean);

  const coinciden: Array<T & { persona: Ocupante | null }> = [];
  for (const casa of casas) {
    const ordenados = [...casa.ocupantes].sort(
      (a, b) => ordenVinculo(a.vinculo) - ordenVinculo(b.vinculo),
    );
    const titular = ordenados[0] ?? null;
    if (palabras.length === 0) {
      coinciden.push({ ...casa, persona: titular });
      continue;
    }

    const deCasa = textoDeCasa(casa);
    const cabe = (heno: string) => palabras.every((p) => heno.includes(p));

    const porNombre = ordenados.find((o) =>
      cabe(`${deCasa} ${normalizar(o.nombre)}`),
    );
    if (porNombre) coinciden.push({ ...casa, persona: porNombre });
    else if (cabe(deCasa)) coinciden.push({ ...casa, persona: titular });
  }

  return coinciden
    .sort(
      (a, b) =>
        rango(a, palabras) - rango(b, palabras) ||
        normalizar(a.torre).localeCompare(normalizar(b.torre), "es", { numeric: true }) ||
        a.numero.localeCompare(b.numero, "es", { numeric: true }),
    )
    .slice(0, limite);
}
