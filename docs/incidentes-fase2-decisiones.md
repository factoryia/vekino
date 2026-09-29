# Incidentes: decisiones de la fase 2

Esta nota complementa la [auditoría de la fase 1](./auditoria-incidentes-vigilancia.md). Describe las reglas efectivamente implementadas en el backend, sin anticipar la interfaz ni el manejo de evidencias.

## Reglas aplicadas

- Un incidente pertenece de forma inmutable a `companiaId` y `condominioId`. La creación deduce la compañía de la membresía corporativa de la sesión y exige contrato vigente; el guarda o supervisor también necesita asignación vigente del mismo par. El guarda propio del conjunto, sin empresa, no crea un caso corporativo.
- Admin de compañía lista todos los casos de su compañía y conserva **lectura histórica** cuando termina un contrato, mientras la compañía siga activa. No puede crear ni modificar casos de un conjunto cuyo contrato terminó. Supervisor y guarda pierden acceso cuando termina su asignación o contrato. Plataforma mantiene lectura y gestión maestra de casos existentes; para crear necesita pertenecer a una compañía y se usa esa identidad. Esta política de lectura histórica es una decisión técnica explícita para que un caso ya registrado no desaparezca de la custodia de la empresa. Cualquier transferencia a otra compañía sigue pendiente.
- Guarda corporativo ve solo casos reportados por él en su conjunto. Supervisor ve los casos de su compañía en el conjunto de su asignación. Admin de compañía ve la empresa entera. Los listados se paginan mediante índices que comienzan por `companiaId`; no se mezclan compañías.
- Se permite `REPORTADO → EN_INVESTIGACION → EN_SEGUIMIENTO → RESUELTO → CERRADO`, `EN_SEGUIMIENTO → EN_INVESTIGACION` y `RESUELTO → EN_SEGUIMIENTO`. Los dos retrocesos requieren motivo. Resolver requiere observación no vacía, registrada en el evento y en el estado actual. Volver de `RESUELTO` a seguimiento limpia el campo de resolución **actual**, mientras el evento histórico conserva la resolución anterior. `CERRADO` no se reabre ni se edita. Cerrar corresponde al admin de compañía y requiere que el caso esté `RESUELTO`; no se añadió aprobación adicional.
- No se exige responsable para comenzar investigación porque la fase 2 no fijó ese requisito como decisión final. El responsable que se asigne debe ser admin de la misma compañía o supervisor vigente en ese conjunto. El tratamiento de un responsable dado de baja sigue pendiente.
- `tipo` es texto validado y acotado; no existe catálogo configurable. `prioridad` y `estado` son valores controlados. La persona involucrada es dato del caso, sin relación automática con `users`. Por ahora solo se agrega: edición, retiro y tratamiento avanzado del documento quedan pendientes.
- La entrada `CREACION` y cada operación de gestión se registran en `incidenteEventos` mediante el helper append-only en la misma mutación del caso. No hay API de actualización o eliminación de eventos.

## Pendiente para la siguiente fase

- Evidencias privadas y su autorización, metadatos, retiro y retención.
- Interfaz de creación, bandeja, detalle, filtros y móvil.
- Si el guarda puede ver casos del conjunto que no reportó y si puede registrar seguimientos.
- Política de reapertura, traspaso de casos tras cambio de contratista, SLA y tipos por compañía.
- Corrección y baja lógica de personas involucradas; conservación y acceso a documentos personales.
- Paginación de la bandeja agregada de varios conjuntos para supervisor y combinación de filtros por conjunto y estado; esta fase expone páginas por un conjunto a la vez.
