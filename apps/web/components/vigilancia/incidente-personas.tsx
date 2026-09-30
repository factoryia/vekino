"use client";

import { useMutation, useQuery } from "convex/react";
import { api } from "@vekino/backend/api";
import type { Id, Doc } from "@vekino/backend/dataModel";
import { Card } from "@/components/ui/card";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { TIPOS_PERSONA } from "@/lib/incidentes-ui";
import { fechaIncidente } from "@/lib/incidentes-bandeja";
import { Campo, RetirarElemento, useOperacion } from "./incidente-controles";

export function Personas({ incidenteId, agregar, editar, retirar }: {
  incidenteId: Id<"incidentes">; agregar: boolean; editar: boolean; retirar: boolean;
}) {
  const personas = useQuery(api.incidentes.listarPersonas, { incidenteId });
  const alta = useMutation(api.incidentes.agregarPersona);
  const edicion = useMutation(api.incidentes.editarPersona);
  const retiro = useMutation(api.incidentes.retirarPersona);
  const activas = personas?.filter((p) => p.retiradoEn === undefined) ?? [];
  const retiradas = personas?.filter((p) => p.retiradoEn !== undefined) ?? [];
  return <Card className="space-y-4 p-5 sm:p-6"><h2 className="text-base font-semibold">Personas involucradas</h2>
    {personas === undefined ? <Skeleton className="h-12" /> : <>
      <h3 className="text-sm font-medium">Actualmente involucradas</h3>
      {!activas.length ? <p className="text-sm text-muted-foreground">No hay personas actualmente involucradas.</p> : <ul className="divide-y divide-border">{activas.map((p) => <li key={p._id} className="break-words py-3 text-sm">
        <DatosPersona persona={p} />
        {editar && <details className="mt-3"><summary className="cursor-pointer text-xs font-medium">Editar persona</summary><FormularioPersona persona={p} guardar={(datos) => edicion({ personaId: p._id, ...datos })} /></details>}
        {retirar && <RetirarElemento nombre="persona" retirar={(motivo) => retiro({ personaId: p._id, motivo })} />}
      </li>)}</ul>}
      {!!retiradas.length && <details className="border-t border-border pt-3"><summary className="cursor-pointer text-sm font-medium">Personas retiradas del caso ({retiradas.length})</summary><ul className="divide-y divide-border">{retiradas.map((p) => <li key={p._id} className="break-words py-3 text-sm"><DatosPersona persona={p} /><p className="mt-2 text-xs text-muted-foreground">Retirada por {p.retiradoPorNombre ?? "Actor registrado en el historial"} · {fechaIncidente(p.retiradoEn!)}</p>{p.motivoRetiro && <p className="text-xs">Motivo: {p.motivoRetiro}</p>}</li>)}</ul></details>}
    </>}
    {agregar && <details className="border-t border-border pt-4"><summary className="cursor-pointer text-sm font-medium">Agregar persona involucrada</summary><FormularioPersona guardar={(datos) => alta({ incidenteId, ...datos })} /></details>}
  </Card>;
}

function DatosPersona({ persona: p }: { persona: Doc<"incidentePersonas"> }) {
  return <><p className="font-medium">{p.nombre} <span className="font-normal text-muted-foreground">· {TIPOS_PERSONA.find((t) => t.value === p.tipoPersona)?.label ?? p.tipoPersona}</span></p>{p.documento && <p className="text-xs text-muted-foreground">Documento: {p.documento}</p>}{p.observacion && <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{p.observacion}</p>}</>;
}

type Datos = { nombre: string; tipoPersona: string; documento?: string; observacion?: string };
export function FormularioPersona({ persona, guardar }: { persona?: Doc<"incidentePersonas">; guardar: (datos: Datos) => Promise<unknown> }) {
  const operacion = useOperacion();
  return <form className="mt-4 space-y-3" onSubmit={(e) => {
    e.preventDefault(); const form = e.currentTarget; const datos = new FormData(form);
    void operacion.ejecutar(() => guardar({ nombre: String(datos.get("nombre")).trim(), tipoPersona: String(datos.get("tipoPersona")).trim(),
      documento: String(datos.get("documento")).trim() || undefined, observacion: String(datos.get("observacion")).trim() || undefined,
    }), persona ? "Persona editada y registrada en el historial." : "Persona agregada y registrada en el historial.", () => { if (!persona) form.reset(); });
  }}>{operacion.aviso}<fieldset disabled={operacion.ocupado} className="grid gap-3 sm:grid-cols-2">
    <Campo label="Nombre"><Input name="nombre" required maxLength={160} defaultValue={persona?.nombre} /></Campo>
    <Campo label="Tipo de persona"><Select name="tipoPersona" required defaultValue={persona?.tipoPersona ?? ""}><option value="">Selecciona el tipo</option>{persona && !TIPOS_PERSONA.some((t) => t.value === persona.tipoPersona) && <option value={persona.tipoPersona}>{persona.tipoPersona}</option>}{TIPOS_PERSONA.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</Select></Campo>
    <Campo label="Documento (opcional)"><Input name="documento" maxLength={80} defaultValue={persona?.documento} /></Campo>
    <Campo label="Observación (opcional)"><Textarea name="observacion" maxLength={2000} defaultValue={persona?.observacion} /></Campo>
    <div><Button type="submit">{operacion.ocupado ? "Guardando…" : persona ? "Guardar persona" : "Agregar persona"}</Button></div>
  </fieldset></form>;
}
