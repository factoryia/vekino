"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@vekino/backend/api";
import type { Id } from "@vekino/backend/dataModel";
import { Camera, Car, Check, Loader2, Search, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { useUploadToS3 } from "@/hooks/use-upload-s3";
import { SelectorUnidades, type UnidadElegida } from "./selector-unidades";

/**
 * Reporte de un vehículo desde la ronda.
 *
 * Está pensado para usarse de pie, en el parqueadero y con una mano: el
 * guarda escribe la placa, la app le dice de qué unidad es, toma las fotos y
 * envía. Nada más.
 *
 * La placa que NO está registrada también se puede reportar. Es el caso más
 * común de todos —un visitante que se parquea donde no debe— y si el flujo
 * exigiera escoger de una lista, el guarda no podría dejar constancia justo
 * cuando más falta hace.
 */

type Prioridad = "baja" | "media" | "alta";

type Foto = { url: string; nombre?: string; preview: string };

/** Lado más largo al que se reduce una foto antes de subirla. */
const LADO_MAX = 1600;

/**
 * Reduce la foto antes de subirla.
 *
 * Una foto de celular pesa entre 3 y 8 MB. Tres de esas, por el wifi de una
 * portería, es medio minuto de espera con el guarda parado ahí. A 1600 px de
 * lado y calidad 0.75 la placa se sigue leyendo perfectamente y el archivo
 * baja a unos cientos de kilobytes.
 */
async function comprimir(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file; // formato que el navegador no sabe abrir: va tal cual

  const escala = Math.min(1, LADO_MAX / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * escala);
  const h = Math.round(bitmap.height * escala);

  const lienzo = document.createElement("canvas");
  lienzo.width = w;
  lienzo.height = h;
  const ctx = lienzo.getContext("2d");
  if (!ctx) return file;
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  const blob = await new Promise<Blob | null>((r) =>
    lienzo.toBlob(r, "image/jpeg", 0.75),
  );
  // Si comprimir salió más pesado (fotos ya pequeñas), se manda la original.
  return blob && blob.size < file.size ? blob : file;
}

export function NovedadVehiculoModal({
  condominioId,
  onClose,
}: {
  condominioId: Id<"condominios">;
  onClose: () => void;
}) {
  const reportar = useMutation(api.guardia.reportarNovedad);
  const subir = useUploadToS3();

  const [placa, setPlaca] = useState("");
  const [busqueda, setBusqueda] = useState("");
  const [elegido, setElegido] = useState<{
    _id: Id<"vehiculos">;
    placa: string;
    descripcion: string | null;
    unidadNumero: string | null;
    unidadTorre: string | null;
    residente: string | null;
  } | null>(null);

  const [motivo, setMotivo] = useState("");
  /* Casa que el guarda le asigna a una placa desconocida, y los datos con los
   * que queda registrada en el parque automotor del conjunto. */
  const [casas, setCasas] = useState<UnidadElegida[]>([]);
  const [tipoNuevo, setTipoNuevo] = useState<"carro" | "moto" | "bicicleta" | "otro">("carro");
  const [guardarVehiculo, setGuardarVehiculo] = useState(true);
  const [prioridad, setPrioridad] = useState<Prioridad>("media");
  const [nota, setNota] = useState("");
  const [fotos, setFotos] = useState<Foto[]>([]);
  const [subiendo, setSubiendo] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const camara = useRef<HTMLInputElement>(null);

  /* La búsqueda espera a que el guarda deje de escribir: sin esto se dispara
   * una consulta por tecla mientras teclea la placa. */
  useEffect(() => {
    const t = setTimeout(() => setBusqueda(placa.trim()), 250);
    return () => clearTimeout(t);
  }, [placa]);

  /* Los motivos los configura la administración; si no ha puesto ninguno el
   * backend devuelve los de por defecto para que el guarda nunca se quede
   * sin poder escoger. */
  const catalogo = useQuery(api.guardia.listMotivosVehiculo, { condominioId });
  const motivos = catalogo?.motivos ?? [];

  // Se elige el primero en cuanto llega la lista, no antes.
  useEffect(() => {
    if (!motivo && motivos.length > 0) setMotivo(motivos[0]!);
  }, [motivo, motivos]);

  const resultados = useQuery(
    api.guardia.buscarVehiculo,
    !elegido && busqueda.replace(/[^a-z0-9]/gi, "").length >= 2
      ? { condominioId, texto: busqueda }
      : "skip",
  );

  async function agregarFotos(files: FileList | null) {
    if (!files?.length) return;
    setError(null);
    setSubiendo(true);
    try {
      for (const file of Array.from(files).slice(0, 6 - fotos.length)) {
        const blob = await comprimir(file);
        const subida = await subir(
          Object.assign(blob, { name: file.name }),
          `condominios/guardia/${condominioId}/vehiculos`,
        );
        setFotos((f) => [
          ...f,
          { url: subida.url, nombre: file.name, preview: URL.createObjectURL(blob) },
        ]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo subir la foto.");
    } finally {
      setSubiendo(false);
    }
  }

  const placaFinal = elegido?.placa ?? placa.trim().toUpperCase();
  const valido =
    placaFinal.length >= 3 && motivo.length > 0 && fotos.length > 0 && !subiendo;

  async function enviar() {
    if (!valido) return;
    setEnviando(true);
    setError(null);
    try {
      const hora = new Date().toLocaleTimeString("es-CO", {
        hour: "2-digit",
        minute: "2-digit",
      });
      const donde = elegido?.unidadNumero
        ? `unidad ${[elegido.unidadTorre, elegido.unidadNumero].filter(Boolean).join(" ")}`
        : casas.length > 0
          ? `casa ${casas.map((c) => c.numero).join(", ")} segun el guarda`
          : "placa no registrada en el conjunto";

      await reportar({
        condominioId,
        tipoReporte: "aporte_voluntario",
        titulo: `${motivo} · ${placaFinal}`,
        descripcion: [
          `Placa ${placaFinal} (${donde}).`,
          elegido?.descripcion ? `Vehículo: ${elegido.descripcion}.` : null,
          `Detectado a las ${hora} durante la ronda.`,
          nota.trim() || null,
        ]
          .filter(Boolean)
          .join(" "),
        prioridad,
        vehiculoId: elegido?._id,
        unidadIds: casas.map((c) => c._id),
        /* Solo cuando la placa es nueva Y el guarda pidio guardarla: si ya
         * existe el vehiculo, `vehiculoId` manda y esto ni se mira. */
        vehiculoNuevo:
          !elegido && guardarVehiculo && casas[0]
            ? {
                placa: placaFinal,
                unidadId: casas[0]._id,
                tipo: tipoNuevo,
              }
            : undefined,
        fotos: fotos.map((f) => ({ url: f.url, nombre: f.nombre })),
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo reportar.");
      setEnviando(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Reporte aporte voluntario"
      description="Queda con la unidad, la hora y la evidencia para la administración"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={enviando}>
            Cancelar
          </Button>
          <Button size="sm" onClick={enviar} disabled={!valido || enviando}>
            {enviando ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Check className="h-4 w-4" />
            )}
            Reportar
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {/* ── Placa ── */}
        {elegido ? (
          <div className="flex items-start gap-3 rounded-xl border border-border bg-muted/40 p-3.5">
            <Car className="mt-0.5 h-5 w-5 shrink-0 text-brand" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="font-mono text-base font-bold tracking-wider text-foreground">
                {elegido.placa}
              </p>
              <p className="text-sm text-muted-foreground">
                {elegido.unidadNumero
                  ? `Unidad ${[elegido.unidadTorre, elegido.unidadNumero].filter(Boolean).join(" ")}`
                  : "Sin unidad asignada"}
                {elegido.residente ? ` — ${elegido.residente}` : ""}
                {elegido.descripcion ? ` · ${elegido.descripcion}` : ""}
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setElegido(null);
                setPlaca("");
              }}
              aria-label="Cambiar vehículo"
              className="rounded-lg p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ) : (
          <div className="space-y-1.5">
            <label className="flex items-center gap-1.5 text-xs font-medium text-foreground">
              <Search className="h-3.5 w-3.5" /> Placa *
            </label>
            <Input
              value={placa}
              onChange={(e) => setPlaca(e.target.value.toUpperCase())}
              placeholder="ABC123"
              autoFocus
              autoCapitalize="characters"
              className="font-mono text-lg tracking-wider"
            />

            {resultados === undefined && busqueda.length >= 2 ? (
              <div className="flex justify-center py-3">
                <Spinner className="h-4 w-4" />
              </div>
            ) : resultados && resultados.length > 0 ? (
              <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
                {resultados.map((v) => (
                  <li key={v._id}>
                    <button
                      type="button"
                      onClick={() => setElegido(v)}
                      className="flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors hover:bg-accent"
                    >
                      <span className="font-mono text-sm font-bold tracking-wider text-foreground">
                        {v.placa}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                        {v.unidadNumero
                          ? `Unidad ${[v.unidadTorre, v.unidadNumero].filter(Boolean).join(" ")}`
                          : "Sin unidad"}
                        {v.residente ? ` — ${v.residente}` : ""}
                        {v.descripcion ? ` · ${v.descripcion}` : ""}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : resultados && busqueda.length >= 2 ? (
              /* Que no esté registrada no impide reportar —casi siempre el mal
                 parqueo es de un visitante—, pero cuando el guarda SÍ sabe de
                 qué casa es, antes se perdía ese dato y el reporte quedaba
                 huérfano. Ahora puede decirlo aquí mismo. */
              <div className="space-y-3 rounded-lg bg-amber-500/10 p-3">
                <p className="text-[13px] text-amber-700 dark:text-amber-400">
                  Esa placa no está registrada. Si sabes de qué casa es,
                  asígnala aquí; si no, repórtala igual.
                </p>
                <SelectorUnidades
                  condominioId={condominioId}
                  elegidas={casas}
                  onChange={setCasas}
                />
                {casas.length > 0 && (
                  <div className="flex flex-wrap items-center gap-3">
                    <label className="flex items-center gap-2 text-[13px] text-foreground">
                      <input
                        type="checkbox"
                        checked={guardarVehiculo}
                        onChange={(e) => setGuardarVehiculo(e.target.checked)}
                        className="h-4 w-4 rounded border-border"
                      />
                      Guardar la placa en la casa {casas[0]!.numero}
                    </label>
                    {guardarVehiculo && (
                      <Select
                        value={tipoNuevo}
                        onChange={(e) => setTipoNuevo(e.target.value as typeof tipoNuevo)}
                        className="w-auto"
                      >
                        <option value="carro">Carro</option>
                        <option value="moto">Moto</option>
                        <option value="bicicleta">Bicicleta</option>
                        <option value="otro">Otro</option>
                      </Select>
                    )}
                  </div>
                )}
              </div>
            ) : null}
          </div>
        )}

        {/* ── Motivo ── */}
        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2 space-y-1.5">
            <label className="block text-xs font-medium text-foreground">Motivo</label>
            <Select
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              disabled={catalogo === undefined}
            >
              {catalogo === undefined ? (
                <option>Cargando…</option>
              ) : (
                <>
                  {motivos.map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                  {/* "Otro" no se configura: siempre tiene que haber salida
                      para lo que nadie previó. Lo que pasó se escribe en la
                      observación. */}
                  <option>Otro</option>
                </>
              )}
            </Select>
          </div>
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-foreground">Prioridad</label>
            <Select
              value={prioridad}
              onChange={(e) => setPrioridad(e.target.value as Prioridad)}
            >
              <option value="baja">Baja</option>
              <option value="media">Media</option>
              <option value="alta">Alta</option>
            </Select>
          </div>
        </div>

        {/* ── Evidencia ── */}
        <div className="space-y-2">
          <label className="flex items-center gap-1.5 text-xs font-medium text-foreground">
            <Camera className="h-3.5 w-3.5" /> Evidencia * (al menos una foto)
          </label>

          {fotos.length > 0 && (
            <div className="grid grid-cols-3 gap-2">
              {fotos.map((f, i) => (
                <div
                  key={f.url}
                  className="group relative aspect-square overflow-hidden rounded-lg border border-border"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={f.preview} alt="" className="h-full w-full object-cover" />
                  <button
                    type="button"
                    onClick={() => setFotos((prev) => prev.filter((_, j) => j !== i))}
                    aria-label="Quitar foto"
                    className="absolute right-1 top-1 rounded-md bg-black/60 p-1 text-white opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {fotos.length < 6 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full"
              disabled={subiendo}
              onClick={() => camara.current?.click()}
            >
              {subiendo ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Camera className="h-4 w-4" />
              )}
              {fotos.length === 0 ? "Tomar foto" : "Agregar otra"}
            </Button>
          )}

          {/* `capture` abre la cámara directamente en el celular, que es donde
              se usa esto. En computador cae al selector de archivos solo. */}
          <input
            ref={camara}
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            className="hidden"
            onChange={(e) => {
              void agregarFotos(e.target.files);
              e.target.value = "";
            }}
          />

          <p className="text-[11px] text-muted-foreground">
            Conviene una foto donde se lea la placa y otra donde se vea dónde
            está parqueado.
          </p>
        </div>

        {/* ── Nota ── */}
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-foreground">
            Observación (opcional)
          </label>
          <Textarea
            value={nota}
            onChange={(e) => setNota(e.target.value)}
            rows={2}
            placeholder="Algo que la foto no muestre…"
          />
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}
        {!valido && fotos.length === 0 && (
          <p className={cn("text-[13px] text-muted-foreground")}>
            Falta la evidencia: sin foto el reporte no sirve para cobrar.
          </p>
        )}
      </div>
    </Modal>
  );
}
