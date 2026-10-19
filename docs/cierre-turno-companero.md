# Cierre del turno de un compañero

Fecha: 2026-10-19 · Rama: `main` (sin commit) · Sin despliegue.

## El problema

En una portería solo puede haber un turno abierto a la vez (`guardia.iniciarTurno`). Si el guarda A termina su jornada sin cerrar el turno, el guarda B no puede abrir el suyo, y `guardia.cerrarTurno` no le deja cerrar el de A: *"Solo el guardia del turno puede cerrarlo."* Hasta ahora solo podía cerrarlo la administración del conjunto.

## La solución

Una vía **explícita y aparte** para que cualquier guarda de la portería cierre el turno que dejó abierto un compañero, con confirmación y trazabilidad. `cerrarTurno` no se afloja: un cierre normal sigue diciendo que lo cerró su guarda.

### Flujo

1. B abre la minuta (web: `/guardia/[id]`; móvil: *Guardia → Minuta*). `guardia.turnoActivo` devuelve el turno de A con `cierraComo: "companero"`.
2. La tarjeta del turno explica el bloqueo: *"Este turno es de Ana Guarda y sigue abierto: para iniciar el tuyo, primero debe cerrarse…"*. El botón normal "Cerrar turno" no se ofrece; en su lugar sale **"Cerrar turno de Ana Guarda"**.
3. La confirmación (modal en la web, `Alert` en el móvil) dice de quién es el turno, desde cuándo está abierto y que el cierre quedará a nombre de B.
4. `guardia.cerrarTurnoDeCompanero({ turnoId, condominioId })` lo cierra. Si falla, se muestra el motivo y no se da nada por hecho.
5. Cerrado, se abre directamente "Iniciar turno" para B (el flujo de siempre, con sus reglas).

## Backend (`packages/backend/convex/guardia.ts`)

| Pieza | Qué hace |
|---|---|
| `cerrarTurnoDeCompanero` (nueva) | Autoriza, valida y cierra. Devuelve `{ ok: true }`. |
| `sellarCierreDeTurno` (nuevo helper) | Lo que escribe **todo** cierre: patch del turno (`estado`, `cerradoPorUserId`, `fechaCierre`, campos del cierre) + `logMinuta`. Lo usan `cerrarTurno`, `cerrarTurnoHuerfano` y `cerrarTurnoDeCompanero`, con la misma salida que antes en los dos primeros. |
| `cierraComoPropio` (nuevo helper) | La regla "es del turno o administra" que antes estaba en línea en `cerrarTurno`. La comparten `cerrarTurno` y `turnoActivo`. |
| `turnoActivo` | Añade `cierraComo: "propio" \| "companero"` (aditivo: las apps que no lo leen siguen igual). |

### Acceso por conjunto

Todo en el servidor, sin confiar en el cliente:

- `requireCondominioRole(ctx, condominioId, ["guardia"])`: quien cierra necesita **hoy** una vía de guarda en el conjunto seleccionado (membresía activa con rol guardia, asignación vigente de compañía o cobertura en ese conjunto). Con una cobertura activa en otro conjunto, la vía permanente está suspendida y se rechaza. Administración, junta, supervisores, residentes y la administración de la compañía **no** ganan esta vía; la administración sigue cerrando con `cerrarTurno`.
- El turno debe ser de ese mismo conjunto. Un turno de otra portería responde lo mismo que uno inexistente (*"Turno no encontrado en esta portería."*), para que el id no sirva de sonda.
- Debe seguir abierto, y no puede ser de quien cierra (titular o secundario): el suyo va por `cerrarTurno`.
- Cada llamada vuelve a validar el contexto: cambiar de conjunto seleccionado no arrastra ninguna autorización.

### Trazabilidad

Sin sistemas nuevos: se usan la minuta (`minutaEventos`, solo inserción) y los campos de cierre del turno.

| Dato | Dónde queda |
|---|---|
| Tipo de evento | `minutaEventos.tipo = "Cierre de Turno por Compañero"` |
| Turno afectado | `minutaEventos.turnoId` |
| Guarda propietario | `guardiaTurnos.guardiaUserId` / `guardiaNombre` (intactos) y el resumen del evento |
| Guarda que cerró | `guardiaTurnos.cerradoPorUserId`, `minutaEventos.actorUserId` / `actorNombre` |
| Conjunto | `condominioId` del turno y del evento |
| Fecha y hora | `guardiaTurnos.fechaCierre`, `minutaEventos.createdAt` |
| Motivo | `observacionesCierre = "Cierre por compañero (turno olvidado): lo cerró <B>, que no es del turno."` (mismo patrón que "Cierre administrativo: …") y el resumen del evento |
| Estado anterior y final | Resumen: *"… Estado: abierto → cerrado."* |

Resumen de ejemplo: *"Turno de Ana Guarda cerrado por Beto Guarda, compañero de portería: quedó abierto sin cerrar (turno olvidado). Estado: abierto → cerrado."*

El administrador lo ve en *Vigilancia → Turnos → Detalle* ("Cerró: Beto Guarda", la observación y el evento) y en la minuta. No se inventa un relevo (`recibe` queda vacío): nadie entregó la portería. Los eventos históricos no se tocan.

### Atomicidad y concurrencia

El cierre del turno y su evento de minuta se escriben en la **misma mutación**. Convex la confirma entera o no confirma nada: si falla la minuta, el turno sigue abierto. Si dos guardas (o el titular y un compañero) cierran a la vez, Convex serializa las mutaciones. La segunda encuentra el turno cerrado y falla sin escribir nada. Si B confirma sobre un turno que ya se cerró y se reabrió, el `turnoId` que trae es el viejo y el turno nuevo no se toca.

## Esquema

**Sin cambios.** `minutaEventos.tipo` es texto libre y todos los campos de cierre de `guardiaTurnos` ya existían y eran opcionales. No hay migraciones.

## Archivos

| Archivo | Cambio |
|---|---|
| `packages/backend/convex/guardia.ts` | Mutación, helpers, `turnoActivo.cierraComo`, `cerrarTurno` y `cerrarTurnoHuerfano` sobre el helper común |
| `apps/web/components/guardia/cerrar-turno-companero.tsx` (nuevo) | `AvisoTurnoDeCompanero` y `CerrarTurnoCompaneroModal` |
| `apps/web/app/guardia/[id]/page.tsx` | Aviso en la tarjeta del turno, sin "Cerrar turno" para el compañero, y luego "Iniciar turno" |
| `apps/mobile/src/app/(app)/guardia/minuta.tsx` | Aviso, botón "Cerrar turno de …" con `Alert` de confirmación, y luego "Iniciar turno" |
| `packages/backend/pruebas/cierreTurnoCompanero.test.ts` (nuevo) | 23 pruebas de integración (convex-test) |
| `packages/backend/pruebas/coberturasRegresion.test.ts` | `cierraComo` se comprueba aparte y no entra en la instantánea anterior a la Fase 8 (misma convención que con `miAcceso`); la instantánea no se regeneró |
| `apps/web/pruebas/cierreTurnoCompanero.test.mjs` (nuevo) + `apps/web/package.json` | 7 pruebas de componente, añadidas a `bun run test` |

## Riesgos y límites

1. **El turno es compartido**: B puede cerrar el turno de A aunque A siga trabajando. Lo mitigan la confirmación explícita y que queda a nombre de B en la minuta. Se descartó un tiempo mínimo, porque bloquearía cierres legítimos.
2. **Sesión compartida en el dispositivo**: si B opera con la sesión de A (el caso que motivó `recordatorioCierre`), el servidor ve a A y el cierre es normal. Esto no lo puede detectar.
3. **Rondas en curso**: igual que el cierre normal, cerrar el turno no finaliza una ronda que A dejara en curso (comportamiento previo, sin cambios).
4. **Móvil sin OTA**: los guardas ven el nuevo botón solo con una build nueva. Las builds publicadas siguen recibiendo el rechazo de siempre al pulsar "Cerrar turno".
5. No se ha desplegado. Hasta desplegar el backend, la web nueva llamaría a una mutación que no existe en el deployment.
