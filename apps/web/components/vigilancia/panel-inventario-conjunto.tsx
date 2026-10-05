"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  AlertTriangle,
  Boxes,
  ClipboardList,
  HandCoins,
  History,
  Loader2,
  Package,
  Undo2,
  UserCheck,
} from "lucide-react";
import { api } from "@vekino/backend/api";
import { EtiquetaCobertura } from "@/components/vigilancia/etiqueta-cobertura";
import type { Id } from "@vekino/backend/dataModel";
import { MAX_OBSERVACION } from "@vekino/backend/inventario";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { Skeleton } from "@/components/ui/skeleton";
import {
  CellStack,
  Table,
  TableCard,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from "@/components/ui/table";

/**
 * EL MATERIAL DEL CONJUNTO, VISTO POR EL SUPERVISOR.
 *
 * Lo que la compañía entregó a esta portería y en manos de quién está. El
 * supervisor reparte y recibe dentro del conjunto; lo que NO puede hacer desde
 * aquí —y por eso no hay botón— es devolverlo a la compañía, moverlo a otro
 * conjunto, archivarlo ni cambiarle el estado: eso sigue siendo del
 * administrador de la empresa.
 *
 * Los "pendientes" son la razón de que esta pantalla exista y no sea una
 * lista más: un elemento en manos de alguien que hoy no opera en el conjunto
 * —ya no está asignado, cubre otro conjunto o terminó la cobertura con la que
 * lo recibió— no se cierra solo, y esconderlo es exactamente como se pierde
 * inventario.
 */

/**
 * Lo que se lee para cada causa de un pendiente. La causa la decide el
 * servidor (`causaPendiente`); aquí solo se traduce. Sin causa —no debería
 * pasar en una fila pendiente— se dice lo mínimo cierto.
 */
const TEXTO_PENDIENTE = {
  ya_no_asignado: "Ya no está asignado",
  cubriendo_otro_conjunto: "Cubriendo otro conjunto",
  cobertura_terminada: "Su cobertura terminó",
} as const;

function textoPendiente(causa: keyof typeof TEXTO_PENDIENTE | undefined): string {
  return causa ? TEXTO_PENDIENTE[causa] : "Hoy no opera aquí";
}

function fechaHora(ms: number): string {
  return new Date(ms).toLocaleString("es-CO", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

type Accion =
  | { tipo: "entregar"; itemId: Id<"inventarioItems">; nombre: string }
  | {
      tipo: "recibir";
      itemId: Id<"inventarioItems">;
      nombre: string;
      guarda: string;
    }
  | { tipo: "novedad"; itemId: Id<"inventarioItems">; nombre: string }
  | { tipo: "historial"; itemId: Id<"inventarioItems">; nombre: string };

export function PanelInventarioConjunto({
  condominioId,
}: {
  condominioId: Id<"condominios">;
}) {
  const datos = useQuery(api.inventarioGuardas.itemsDelCondominio, {
    condominioId,
  });
  const [accion, setAccion] = useState<Accion | null>(null);

  if (datos === undefined) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-14 rounded-xl" />
        ))}
      </div>
    );
  }

  if (datos.items.length === 0) {
    return (
      <EmptyState
        icon={Boxes}
        title="Sin material en este conjunto"
        description="Tu compañía todavía no ha entregado ningún elemento de su inventario a esta portería."
      />
    );
  }

  return (
    <div className="space-y-4">
      {datos.pendientes > 0 && (
        <div className="flex items-start gap-2.5 rounded-xl bg-amber-500/12 px-4 py-3 text-[13px] text-amber-800 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p>
            <strong>
              {datos.pendientes} elemento{datos.pendientes === 1 ? "" : "s"} sin
              resolver.
            </strong>{" "}
            {datos.pendientes === 1 ? "Está" : "Están"} en manos de alguien que
            hoy no opera en este conjunto. Regístrale la devolución cuando
            {datos.pendientes === 1 ? " lo" : " los"} entregue.
          </p>
        </div>
      )}

      <TableCard>
        <Table>
          <THead>
            <TR>
              <TH className="w-14">Foto</TH>
              <TH>Elemento</TH>
              <TH>Quién lo tiene</TH>
              <TH>Estado</TH>
              <TH className="text-right">Acciones</TH>
            </TR>
          </THead>
          <TBody>
            {datos.items.map((i) => (
              <TR key={i.itemId}>
                <TD>
                  {i.fotoUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={i.fotoUrl}
                      alt=""
                      className="h-9 w-9 rounded-lg border border-border object-cover"
                    />
                  ) : (
                    <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-dashed border-border bg-muted/40">
                      <Package
                        className="h-4 w-4 text-muted-foreground"
                        aria-hidden
                      />
                    </div>
                  )}
                </TD>
                <TD>
                  <CellStack
                    primary={i.nombre}
                    secondary={i.serial ?? undefined}
                  />
                </TD>
                <TD>
                  {i.custodia ? (
                    <div className="space-y-0.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge tone={i.custodia.pendiente ? "warning" : "info"}>
                          <UserCheck className="h-3 w-3" aria-hidden />
                          {i.custodia.guardaNombre}
                        </Badge>
                        <EtiquetaCobertura cobertura={i.custodia.cobertura} compacta />
                        {i.custodia.pendiente && (
                          <Badge tone="warning">{textoPendiente(i.custodia.causaPendiente)}</Badge>
                        )}
                      </div>
                      <p className="text-[11.5px] text-muted-foreground">
                        Desde {fechaHora(i.custodia.entregadaEn)}
                      </p>
                    </div>
                  ) : datos.custodiaIncompleta ? (
                    /* Sin custodia en un mapa que se quedó corto NO significa
                       "está en la caseta": significa que no se sabe. Decir lo
                       primero invitaría a entregar algo que alguien ya tiene. */
                    <span
                      className="text-[12.5px] text-muted-foreground"
                      title="Hay más elementos repartidos de los que caben en una consulta."
                    >
                      —
                    </span>
                  ) : (
                    <span className="text-[12.5px] text-muted-foreground">
                      En la portería
                    </span>
                  )}
                </TD>
                <TD>
                  {/* El estado FÍSICO, que es otro eje que la custodia: un
                      radio averiado en manos de Juan dice las dos cosas. */}
                  <Badge tone="success">{i.estado}</Badge>
                </TD>
                <TD>
                  <div className="flex flex-wrap justify-end gap-1.5">
                    {i.custodia ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() =>
                          setAccion({
                            tipo: "recibir",
                            itemId: i.itemId,
                            nombre: i.nombre,
                            guarda: i.custodia!.guardaNombre,
                          })
                        }
                      >
                        <Undo2 className="h-3.5 w-3.5" aria-hidden />
                        Recibir
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        onClick={() =>
                          setAccion({
                            tipo: "entregar",
                            itemId: i.itemId,
                            nombre: i.nombre,
                          })
                        }
                        /* Con el mapa incompleto no se sabe si alguien lo
                           tiene: ofrecer "Entregar" acabaría en un rechazo del
                           servidor que el usuario no puede anticipar. */
                        disabled={datos.custodiaIncompleta}
                      >
                        <HandCoins className="h-3.5 w-3.5" aria-hidden />
                        Entregar
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        setAccion({
                          tipo: "novedad",
                          itemId: i.itemId,
                          nombre: i.nombre,
                        })
                      }
                      aria-label={`Registrar novedad de ${i.nombre}`}
                    >
                      <ClipboardList className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        setAccion({
                          tipo: "historial",
                          itemId: i.itemId,
                          nombre: i.nombre,
                        })
                      }
                      aria-label={`Historial de ${i.nombre}`}
                    >
                      <History className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                  </div>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </TableCard>

      {(datos.truncado || datos.custodiaIncompleta) && (
        <p className="text-[12.5px] text-muted-foreground">
          {datos.truncado &&
            "Hay más elementos en este conjunto de los que caben en la lista. "}
          {datos.custodiaIncompleta &&
            "Hay más elementos repartidos de los que caben en una consulta: los marcados con “—” pueden estar en manos de un guarda, y el aviso de pendientes puede quedarse corto."}
        </p>
      )}

      {accion?.tipo === "entregar" && (
        <EntregarDialog
          condominioId={condominioId}
          itemId={accion.itemId}
          itemNombre={accion.nombre}
          onClose={() => setAccion(null)}
        />
      )}
      {accion?.tipo === "recibir" && (
        <RecibirDialog
          itemId={accion.itemId}
          itemNombre={accion.nombre}
          guarda={accion.guarda}
          onClose={() => setAccion(null)}
        />
      )}
      {accion?.tipo === "novedad" && (
        <NovedadDialog
          itemId={accion.itemId}
          itemNombre={accion.nombre}
          onClose={() => setAccion(null)}
        />
      )}
      {accion?.tipo === "historial" && (
        <HistorialDialog
          itemId={accion.itemId}
          itemNombre={accion.nombre}
          onClose={() => setAccion(null)}
        />
      )}
    </div>
  );
}

function EntregarDialog({
  condominioId,
  itemId,
  itemNombre,
  onClose,
}: {
  condominioId: Id<"condominios">;
  itemId: Id<"inventarioItems">;
  itemNombre: string;
  onClose: () => void;
}) {
  const guardas = useQuery(api.inventarioGuardas.guardasDisponibles, {
    condominioId,
  });
  const entregar = useMutation(api.inventarioGuardas.entregar);

  const [guardaUserId, setGuardaUserId] = useState("");
  const [observacion, setObservacion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sinGuardas = guardas !== undefined && guardas.length === 0;

  async function guardar(e: React.FormEvent) {
    e.preventDefault();
    if (!guardaUserId) return;
    setError(null);
    setBusy(true);
    try {
      await entregar({
        itemId,
        guardaUserId: guardaUserId as Id<"users">,
        observacion: observacion.trim() || undefined,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo entregar.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Entregar a un guarda"
      description={itemNombre}
      className="max-w-md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button
            type="submit"
            form="form-entregar-guarda"
            disabled={busy || !guardaUserId}
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            Entregar
          </Button>
        </>
      }
    >
      <form id="form-entregar-guarda" onSubmit={guardar} className="space-y-4">
        <label className="block space-y-1.5">
          <span className="block text-xs font-medium text-foreground">
            Guarda <span className="text-destructive">*</span>
          </span>
          <Select
            value={guardaUserId}
            onChange={(e) => setGuardaUserId(e.target.value)}
            disabled={guardas === undefined || sinGuardas}
            required
          >
            <option value="">
              {guardas === undefined ? "Cargando…" : "Selecciona un guarda"}
            </option>
            {(guardas ?? []).map((g) => (
              <option key={g.userId} value={g.userId}>
                {g.nombre}
              </option>
            ))}
          </Select>
          <p className="text-[11.5px] text-muted-foreground">
            Solo los guardas de tu compañía asignados hoy a este conjunto.
          </p>
        </label>

        {sinGuardas && (
          <p className="rounded-lg bg-amber-500/12 px-3 py-2 text-[13px] text-amber-700 dark:text-amber-400">
            No hay guardas de tu compañía asignados a este conjunto ahora mismo.
          </p>
        )}

        <label className="block space-y-1.5">
          <span className="block text-xs font-medium text-foreground">
            Observación
          </span>
          <Input
            value={observacion}
            onChange={(e) => setObservacion(e.target.value)}
            maxLength={MAX_OBSERVACION}
            placeholder="Para el turno de noche"
          />
        </label>

        {error && <Aviso>{error}</Aviso>}
      </form>
    </Modal>
  );
}

function RecibirDialog({
  itemId,
  itemNombre,
  guarda,
  onClose,
}: {
  itemId: Id<"inventarioItems">;
  itemNombre: string;
  guarda: string;
  onClose: () => void;
}) {
  const recibir = useMutation(api.inventarioGuardas.recibir);
  const [observacion, setObservacion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function guardar(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await recibir({ itemId, observacion: observacion.trim() || undefined });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo registrar.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Registrar la devolución"
      description={itemNombre}
      className="max-w-md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button type="submit" form="form-recibir-guarda" disabled={busy}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            Confirmar
          </Button>
        </>
      }
    >
      <form id="form-recibir-guarda" onSubmit={guardar} className="space-y-4">
        <p className="text-[13px] text-foreground">
          <strong>{guarda}</strong> devuelve el elemento. Vuelve a quedar
          disponible en la portería —no se devuelve a la compañía— y la entrega
          anterior se conserva en el historial.
        </p>

        <label className="block space-y-1.5">
          <span className="block text-xs font-medium text-foreground">
            Observación
          </span>
          <Input
            value={observacion}
            onChange={(e) => setObservacion(e.target.value)}
            maxLength={MAX_OBSERVACION}
            placeholder="Vuelve completo, sin novedad"
          />
        </label>

        {error && <Aviso>{error}</Aviso>}
      </form>
    </Modal>
  );
}

function NovedadDialog({
  itemId,
  itemNombre,
  onClose,
}: {
  itemId: Id<"inventarioItems">;
  itemNombre: string;
  onClose: () => void;
}) {
  const registrar = useMutation(api.inventarioGuardas.registrarNovedad);
  const [descripcion, setDescripcion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function guardar(e: React.FormEvent) {
    e.preventDefault();
    if (!descripcion.trim()) return;
    setError(null);
    setBusy(true);
    try {
      await registrar({ itemId, descripcion: descripcion.trim() });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo registrar.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Registrar una novedad"
      description={itemNombre}
      className="max-w-md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button
            type="submit"
            form="form-novedad-item"
            disabled={busy || !descripcion.trim()}
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            Registrar
          </Button>
        </>
      }
    >
      <form id="form-novedad-item" onSubmit={guardar} className="space-y-4">
        <label className="block space-y-1.5">
          <span className="block text-xs font-medium text-foreground">
            Qué pasó <span className="text-destructive">*</span>
          </span>
          <Textarea
            value={descripcion}
            onChange={(e) => setDescripcion(e.target.value)}
            maxLength={MAX_OBSERVACION}
            rows={3}
            placeholder="El radio presenta interferencia en la zona norte"
            autoFocus
          />
        </label>

        {/* El aviso importa: sin él, quien escribe "presenta fallas" espera
            que el elemento quede marcado como averiado y no lo estará. */}
        <p className="text-[11.5px] text-muted-foreground">
          Queda en el historial del elemento junto al guarda que lo tiene. No
          cambia su estado: dar de baja o marcar como averiado lo decide la
          compañía.
        </p>

        {error && <Aviso>{error}</Aviso>}
      </form>
    </Modal>
  );
}

function HistorialDialog({
  itemId,
  itemNombre,
  onClose,
}: {
  itemId: Id<"inventarioItems">;
  itemNombre: string;
  onClose: () => void;
}) {
  const historial = useQuery(api.inventarioGuardas.historialDeItem, { itemId });

  return (
    <Modal
      open
      onClose={onClose}
      title="Por qué manos ha pasado"
      description={itemNombre}
      className="max-w-lg"
    >
      {historial === undefined ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-14 rounded-xl" />
          ))}
        </div>
      ) : historial.length === 0 ? (
        <EmptyState
          icon={History}
          title="Todavía no se ha entregado"
          description="Este elemento no ha estado en manos de ningún guarda de este conjunto."
        />
      ) : (
        <ol className="space-y-2">
          {historial.map((c) => (
            <li
              key={c._id}
              className="rounded-xl border border-border px-3 py-2.5 text-[12.5px]"
            >
              <div className="flex flex-wrap items-center gap-2">
                <UserCheck
                  className="h-3.5 w-3.5 text-muted-foreground"
                  aria-hidden
                />
                <span className="font-medium text-foreground">
                  {c.guardaNombre}
                </span>
                <EtiquetaCobertura cobertura={c.cobertura} />
                {c.activa && <Badge tone="info">Lo tiene ahora</Badge>}
                {c.pendiente && (
                  <Badge tone="warning">{textoPendiente(c.causaPendiente)}</Badge>
                )}
              </div>
              <p className="mt-1 text-muted-foreground">
                Entregado el {fechaHora(c.entregadaEn)}
                {c.entregadaPorNombre ? ` por ${c.entregadaPorNombre}` : ""}
                {c.observacionEntrega ? ` · ${c.observacionEntrega}` : ""}
              </p>
              {c.devueltaEn != null && (
                <p className="text-muted-foreground">
                  Devuelto el {fechaHora(c.devueltaEn)}
                  {c.devueltaPorNombre ? ` a ${c.devueltaPorNombre}` : ""}
                  {c.observacionDevolucion ? ` · ${c.observacionDevolucion}` : ""}
                </p>
              )}
            </li>
          ))}
        </ol>
      )}
    </Modal>
  );
}

function Aviso({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
      {children}
    </p>
  );
}
