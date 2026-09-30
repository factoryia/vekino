"use client";

import { useAction, useMutation, useQuery } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { api } from "@vekino/backend/api";
import type { Id } from "@vekino/backend/dataModel";
import type { FunctionReturnType } from "convex/server";
import { EVIDENCIA_ACCEPT, validarArchivoEvidencia } from "@vekino/backend/incidenteEvidencias";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { fechaIncidente } from "@/lib/incidentes-bandeja";
import { Campo, RetirarElemento, useOperacion } from "./incidente-controles";

type Evidencia = FunctionReturnType<typeof api.incidenteEvidencias.listar>[number];
export function errorEvidencia(error: unknown) {
  const msg = error instanceof Error ? error.message : String(error);
  if (/Solo se admiten|supera el límite|Archivo vacío|El nombre debe|extensión no coincide|contenido no corresponde/.test(msg)) return msg;
  if (/permiso|acceso|compañía|contrato|activo|sesión|autenticado/i.test(msg)) return "No tienes acceso vigente a esta evidencia. Actualiza la ficha o inicia sesión de nuevo.";
  if (/retirada|cerrado/i.test(msg)) return "La evidencia fue retirada o el caso se cerró. Actualiza la ficha.";
  return "No pudimos completar la operación de evidencia. Conservamos tu selección; inténtalo de nuevo.";
}

export function Evidencias({ incidenteId, agregar, retirar }: { incidenteId: Id<"incidentes">; agregar: boolean; retirar: boolean }) {
  const evidencias = useQuery(api.incidenteEvidencias.listar, { incidenteId });
  const subir = useAction(api.incidenteArchivos.subir);
  const retiro = useMutation(api.incidenteEvidencias.retirar);
  const operacion = useOperacion(errorEvidencia);
  const [archivo, setArchivo] = useState<File | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const activas = evidencias?.filter((e) => e.retiradoEn === undefined) ?? [];
  const retiradas = evidencias?.filter((e) => e.retiradoEn !== undefined) ?? [];
  return <Card className="space-y-4 p-5 sm:p-6"><h2 className="text-base font-semibold">Evidencias del incidente</h2>
    <p className="text-xs text-muted-foreground">Fotografías y documentos privados asociados a este caso.</p>
    {evidencias === undefined ? <Skeleton className="h-24" /> : <>
      {!activas.length ? <p className="text-sm text-muted-foreground">No hay evidencias vigentes.</p> : <ul className="space-y-4">{activas.map((e) => <li key={e._id} className="min-w-0 rounded-xl border border-border p-4"><ContenidoEvidencia evidencia={e} />{retirar && <RetirarElemento nombre="evidencia" retirar={(motivo) => retiro({ evidenciaId: e._id, motivo })} />}</li>)}</ul>}
      {!!retiradas.length && <details className="border-t border-border pt-3"><summary className="cursor-pointer text-sm font-medium">Evidencias retiradas ({retiradas.length})</summary><ul className="space-y-3 pt-3">{retiradas.map((e) => <li key={e._id} className="break-words text-sm"><Metadatos evidencia={e} /><p className="mt-1 text-xs text-muted-foreground">Retirada por {e.retiradoPorNombre} · {fechaIncidente(e.retiradoEn!)} · Motivo: {e.motivoRetiro}</p></li>)}</ul></details>}
    </>}
    {agregar && <form className="space-y-3 border-t border-border pt-4" onSubmit={(e) => {
      e.preventDefault(); if (!archivo) return;
      void operacion.ejecutar(async () => {
        const datos = validarArchivoEvidencia({ nombre: archivo.name, mimeType: archivo.type, size: archivo.size });
        await subir({ incidenteId, nombre: datos.nombre, mimeType: datos.mimeType, bytes: await archivo.arrayBuffer() });
      }, "Evidencia agregada y registrada en el historial.", () => { setArchivo(null); if (input.current) input.current.value = ""; });
    }}>{operacion.aviso}<fieldset disabled={operacion.ocupado} className="space-y-3">
      <Campo label="Agregar evidencia"><Input ref={input} type="file" accept={EVIDENCIA_ACCEPT} onChange={(e) => setArchivo(e.target.files?.[0] ?? null)} required /></Campo>
      <p className="text-xs text-muted-foreground">JPEG, PNG, WebP o PDF · máximo 15 MiB por archivo.</p>
      {archivo && <p className="break-words text-xs">Seleccionado: {archivo.name}</p>}
      <Button type="submit" disabled={!archivo || operacion.ocupado}>{operacion.ocupado ? "Validando y subiendo evidencia…" : "Agregar evidencia"}</Button>
    </fieldset></form>}
  </Card>;
}

function Metadatos({ evidencia: e }: { evidencia: Evidencia }) {
  return <><p className="break-words text-sm font-medium">{e.nombre}</p><p className="text-xs text-muted-foreground">{e.mimeType} · {new Intl.NumberFormat("es-CO", { maximumFractionDigits: 1 }).format(e.size / 1024)} KiB · {e.retiradoEn === undefined ? "Vigente" : "Retirada"}</p><p className="mt-1 text-xs text-muted-foreground">Agregada por {e.subidoPorNombre} · {fechaIncidente(e.createdAt)}</p></>;
}

export function ContenidoEvidencia({ evidencia }: { evidencia: Evidencia }) {
  const acceder = useAction(api.incidenteArchivos.acceder);
  const operacion = useOperacion(errorEvidencia);
  const [vista, setVista] = useState<{ url: string; expiraEn: number } | null>(null);
  const [errorVista, setErrorVista] = useState("");
  const montado = useRef(true);
  useEffect(() => { montado.current = true; return () => { montado.current = false; }; }, []);
  useEffect(() => {
    if (!vista) return;
    const timer = setTimeout(() => setVista(null), Math.max(0, vista.expiraEn - Date.now()));
    return () => { clearTimeout(timer); URL.revokeObjectURL(vista.url); };
  }, [vista]);
  const imagen = evidencia.mimeType.startsWith("image/");
  return <div className="space-y-3"><Metadatos evidencia={evidencia} />{operacion.aviso}
    {errorVista && <p role="alert" className="text-sm text-destructive">{errorVista}</p>}
    {vista && imagen && <img src={vista.url} alt={`Evidencia: ${evidencia.nombre}`} referrerPolicy="no-referrer" className="max-h-80 w-full rounded-lg object-contain" onError={() => { setVista(null); setErrorVista("No pudimos cargar la imagen. Solicita acceso de nuevo."); }} />}
    {vista && !imagen && <a href={vista.url} download={evidencia.nombre} referrerPolicy="no-referrer" className="inline-block text-sm font-medium underline">Descargar documento autorizado</a>}
    <Button type="button" variant="outline" disabled={operacion.ocupado} onClick={() => {
      setVista(null); setErrorVista("");
      void operacion.ejecutar(async () => {
        const archivo = await acceder({ evidenciaId: evidencia._id });
        if (!montado.current) return;
        setVista({ url: URL.createObjectURL(new Blob([archivo.bytes], { type: archivo.mimeType })), expiraEn: Date.now() + 60_000 });
      }, "Contenido autorizado. Vista local disponible durante un minuto.");
    }}>{operacion.ocupado ? "Comprobando acceso…" : imagen ? "Ver imagen" : "Solicitar documento"}</Button>
  </div>;
}
