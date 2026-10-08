# Cierre de turno simplificado — auditoría, cambios y verificación

Fecha: 2026-10-07 · Rama de trabajo: `main` (sin commit) · Rama de referencia: `origin/feat/aval-multiconvenio`

## Resumen

- El guarda cierra el turno desde el mismo modal de siempre, pero ahora solo ve **"Entrega el turno"** (su nombre, de solo lectura), el resumen del turno y el botón **Cerrar turno**.
- Elementos asignados, novedades de elementos, guarda que recibe, consignas y observaciones generales quedaron **ocultos y opcionales**. **No se eliminó** ningún campo, columna, relación, validador, query ni servicio.
- **El cierre no requirió cambio de esquema.** En Convex, todas las columnas del cierre ya eran opcionales. Lo único que las hacía obligatorias era la lógica de validación (la regla compartida y el validador `consignas: v.string()` de la mutación).
- **Aparte, `schema.ts` de `main` ahora declara los dos campos opcionales de Aval** (`condominios.avalNura` y `pagos.agrmId`). El deployment de dev ya tiene datos con esos campos, y `convex dev` desde `main` fallaba. Ver la sección 7.
- Para volver a pedir cualquiera de esos campos basta con cambiar un `false` por `true` en `CAMPOS_PEDIDOS_CIERRE` ([cierreTurno.ts:52](../packages/backend/convex/lib/cierreTurno.ts)). Eso lo vuelve visible y obligatorio en la web, en el móvil y en el servidor. Antes de hacerlo hay que leer la advertencia del §6.
- Tests: 357/357 unitarias y 868/868 de integración pasan en `main`. También pasan sobre la rama de Condominios Aval con este cambio aplicado.
- `bunx convex dev` desde `main` contra `dev:agreeable-bee-782`: **"Convex functions ready!"**, sin errores de esquema (sección 7).

---

## 1. Auditoría inicial (estado antes del cambio)

### 1.1 Cómo funcionaba el cierre

1. **Puntos de entrada.** Todos abren el mismo componente `CerrarTurnoModal` (uno por app):
   - Web: botón "Cerrar turno" en la minuta (`apps/web/app/guardia/[id]/page.tsx`). También el botón "Cerrar ese turno" de los avisos de turno pendiente (`components/guardia/aviso-turno-pendiente.tsx` y `aviso-cobertura.tsx`), que corresponde a la excepción de la cobertura o al turno huérfano.
   - Móvil: botón "Cerrar turno" en la minuta (`apps/mobile/src/app/(app)/guardia/minuta.tsx`) y aviso de turno pendiente (`components/guardia/guardia-home.tsx`).
2. **Formulario.** El modal pedía los campos de la tabla 1.2. Calculaba los errores con `erroresCierreTurno` (regla compartida) y los mostraba debajo de cada campo después del primer intento. En la web, `confirmar()` no enviaba nada si había errores. En el móvil, salía un `Alert` "Faltan datos".
3. **Datos de apoyo.** La query `guardia.relevosDelTurno` cargaba el catálogo de relevos (guardas vigentes de la portería, sin quien entrega). Si no había ninguno, el relevo se escribía a mano.
4. **Request.** `api.guardia.cerrarTurno` con `{ turnoId, recibeUserId | recibe, consignas, observacionesCierre, novedadesElementos, novedadesElementosDetalle }`.
5. **Servidor** (`guardia.cerrarTurno`, [guardia.ts:569](../packages/backend/convex/guardia.ts)):
   1. Carga el turno y aplica `autorizarCierre`: guarda del turno, admin, o la excepción de la cobertura.
   2. Exige `estado === "abierto"` y que quien cierra sea admin o del turno.
   3. Si llega `recibeUserId`, comprueba que el relevo sea un guarda vigente de la portería (`guardasDeLaPorteria`), distinto de quien entrega. El nombre se toma de la base de datos.
   4. `validarCierreTurno` aplica **las mismas reglas** que los formularios.
   5. `ctx.db.patch` del turno (campos del cierre, `cerradoPorUserId`, `estado: "cerrado"`, `fechaCierre`) y `logMinuta` "Cierre de Turno".
6. **Errores.** Web: `mensajeErrorUsuario` debajo del formulario. Móvil: `Alert` con `e.message`.
7. **Después del cierre.** Se cierra el modal. `turnoActivo` es reactivo y pasa a `null`: la minuta vuelve a "Iniciar turno" y el aviso de turno pendiente desaparece. El administrador ve el turno en *Vigilancia → Turnos* (`apps/web/app/condominio/[id]/vigilancia/page.tsx`), con detalle y exportación CSV.

### 1.2 Campos y obligatoriedad

| Campo en pantalla | Arg de `cerrarTurno` | Columna `guardiaTurnos` | Esquema | Validador de args (antes) | Regla compartida (antes) | ¿Obligatorio antes? |
|---|---|---|---|---|---|---|
| Resumen (visitantes/paquetes/rondas/incidentes) | — (prop `stats`) | — (calculado) | — | — | — | Solo lectura |
| **Entrega el turno** | — | `guardiaNombre` | `v.string()` (se fija al abrir) | — | — | Solo lectura |
| Elementos asignados | — (no hay arg: se rechaza) | `checklist` | `v.array(...)` (se fija al abrir) | — | — | Solo lectura |
| ¿Existen novedades con los elementos? | `novedadesElementos` | `novedadesElementos` | `v.optional(v.boolean())` | opcional | `== null` → "Indica si hay novedades…" | **Sí** (el formulario siempre mandaba `true`/`false`) |
| Detalle de la novedad | `novedadesElementosDetalle` | ídem | `v.optional(v.string())` | opcional | si hay novedad y está vacío → error; si hay novedad y 0 elementos → error | Condicional |
| Guarda que recibe el turno | `recibeUserId` / `recibe` | `recibeUserId`, `recibe` | `v.optional(...)` | opcional | vacío → "Indica el guarda que recibe el turno." | **Sí** |
| Consignas / pendientes | `consignas` | `consignas` | `v.optional(v.string())` | **`v.string()` (requerido)** | vacío → "Escribe las consignas…" | **Sí** (doble: validador y regla) |
| Observaciones generales | `observacionesCierre` | `observacionesCierre` | `v.optional(v.string())` | opcional | vacío → "Escribe las observaciones generales…" | **Sí** |
| (servidor) | — | `cerradoPorUserId`, `estado`, `fechaCierre`, `updatedAt` | `estado` y fechas obligatorias | — | — | Las fija el servidor |

### 1.3 Qué los hacía obligatorios

| Dónde | Qué |
|---|---|
| `packages/backend/convex/lib/cierreTurno.ts` → `erroresCierreTurno` / `validarCierreTurno` | Regla compartida por el servidor y los dos formularios: exigía respuesta de novedades, relevo, consignas y observaciones. |
| `packages/backend/convex/guardia.ts` → `cerrarTurno.args.consignas: v.string()` | Validador de argumentos de Convex: un request sin `consignas` fallaba antes de llegar al handler. |
| Web `cerrar-turno-modal.tsx` → `confirmar()` | No enviaba nada si `erroresCierreTurno` devolvía errores. |
| Móvil `cerrar-turno-modal.tsx` → `confirmar()` | `Alert` "Faltan datos" con los errores. |
| Base de datos | **Nada.** Ninguna columna del cierre es obligatoria en el esquema. |

### 1.4 Base de datos y "migraciones"

- El backend es **Convex**: no hay SQL ni archivos de migración versionados. El esquema es declarativo (`packages/backend/convex/schema.ts`) y Convex lo valida contra los documentos existentes en cada `convex deploy` / `convex dev`. `convex/migrations.ts` solo tiene migraciones de datos puntuales, y ninguna toca `guardiaTurnos`.
- El equivalente a `NOT NULL` en Convex es un campo sin `v.optional`. En `guardiaTurnos` ([schema.ts:1666](../packages/backend/convex/schema.ts)) solo son obligatorios los campos que se fijan **al abrir** el turno: `condominioId`, `guardiaUserId`, `guardiaNombre`, `checklist`, `estado`, `fechaInicio`, `createdAt`, `updatedAt`. Los del cierre (`consignas`, `recibe`, `recibeUserId`, `observacionesCierre`, `novedadesElementos`, `novedadesElementosDetalle`, `cerradoPorUserId`, `fechaCierre`) ya eran `v.optional`.
- No hay defaults, constraints ni claves foráneas a nivel de base. `v.id(...)` solo valida el tipo de referencia: no hay cascadas.
- **Backslash y escapes:** no aplican. No existe SQL de turnos. El único SQL del repo es `_fact.mjs`, un script de lectura sobre la base legada de facturas, sin relación con turnos.
- Esquema esperado por el código vs. esquema real: coinciden. El código ahora puede escribir campos `undefined` (ausentes), que el esquema ya admitía.

### 1.5 Archivos que participan

| Capa | Archivo |
|---|---|
| Regla compartida | `packages/backend/convex/lib/cierreTurno.ts` (exportada como `@vekino/backend/cierreTurno`) |
| Mutación y queries | `packages/backend/convex/guardia.ts` → `cerrarTurno`, `relevosDelTurno`, `turnoPendienteDeCierre`, `autorizarCierre`, `cerrarTurnoHuerfano` (cierre administrativo, sin cambios), `getTurno`, `listTurnos` |
| Esquema | `packages/backend/convex/schema.ts` → `guardiaTurnos` (sin cambios; los únicos cambios de `schema.ts` son los campos de Aval de la sección 7) |
| Web | `apps/web/components/guardia/cerrar-turno-modal.tsx`, `apps/web/app/guardia/[id]/page.tsx`, `components/guardia/aviso-turno-pendiente.tsx`, `aviso-cobertura.tsx`, `apps/web/app/condominio/[id]/vigilancia/page.tsx` (vista del administrador) |
| Móvil | `apps/mobile/src/components/guardia/cerrar-turno-modal.tsx`, `src/app/(app)/guardia/minuta.tsx`, `src/components/guardia/guardia-home.tsx` |
| Tests | `packages/backend/pruebas/cierreTurno.prueba.ts`, `cierreTurno.test.ts` y otros 9 archivos de integración que cierran turnos (sección 4) |

---

## 2. Cambios realizados

### 2.1 Qué se ocultó (web y móvil)

Elementos asignados, la pregunta y el detalle de novedades, guarda que recibe, consignas y observaciones generales. Cada bloque quedó envuelto en `pide.<campo> && …`. El JSX, el estado y los textos siguen en el componente, intactos. La query de relevos se omite (`"skip"`) mientras el relevo no se pida.

**Se mantiene visible:** "Entrega el turno" (nombre de quien entrega, solo lectura), el resumen del turno (solo lectura, no pide nada), Cancelar y Cerrar turno. La descripción del modal web cambia a "Confirma que entregas la portería y cierras el turno" mientras no se pidan elementos ni consignas.

### 2.2 Qué pasó de obligatorio a opcional

| Campo | Antes | Ahora |
|---|---|---|
| `novedadesElementos` | Respuesta obligatoria | Opcional. Si no llega se guarda **ausente**, no `false`: "no se preguntó" no es "sin novedad". |
| `recibe` / `recibeUserId` | Obligatorio | Opcional |
| `consignas` | Obligatorio (validador + regla) | Opcional (`v.optional(v.string())`) |
| `observacionesCierre` | Obligatorio | Opcional |

Un texto vacío o de solo espacios se guarda como ausente, no como `""`.

### 2.3 Qué se mantuvo intacto

- Esquema, columnas, índices y relaciones de `guardiaTurnos`. **El cierre no tocó `schema.ts`.** Los únicos cambios en ese archivo son los dos campos de Aval (sección 7).
- Todos los argumentos de `cerrarTurno`, que ahora son opcionales. Un request antiguo con todos los datos sigue funcionando igual.
- Validaciones de lo que **sí llega**: relevo del catálogo (vigente, distinto de quien entrega, nombre tomado de la base), novedad marcada sin detalle, novedad en un turno sin elementos, y la prohibición de enviar `checklist` al cerrar.
- Autorización: solo el guarda del turno, un admin o la excepción de la cobertura. Un turno cerrado no se vuelve a cerrar.
- `relevosDelTurno`, `equipo`, `cerrarTurnoHuerfano`, `getTurno` y `listTurnos`.
- Formato de la minuta cuando hay datos: el texto es idéntico al de antes.

### 2.4 Cambios por capa

**Backend**

- `lib/cierreTurno.ts`:
  - Nuevo tipo `CamposPedidosCierre` y dos configuraciones: `CIERRE_COMPLETO` (todo `true`, el formulario de antes) y `CAMPOS_PEDIDOS_CIERRE` (todo `false`, el de hoy).
  - `erroresCierreTurno(e, pide = CAMPOS_PEDIDOS_CIERRE)` y `validarCierreTurno(e, pide = …)` solo exigen lo que se pide. Lo que llega se sigue validando igual.
  - `validarCierreTurno` devuelve `undefined` para lo vacío o no contestado.
- `guardia.ts` → `cerrarTurno`:
  - `consignas: v.string()` pasa a `v.optional(v.string())`.
  - El resumen de la minuta ya no dice "Recibe:" si no hay relevo, ni "Elementos sin novedad." si no se preguntó. Un cierre simplificado queda como `Turno de X cerrado por Y.`

**Frontend**

- Web y móvil `cerrar-turno-modal.tsx`: `const pide = CAMPOS_PEDIDOS_CIERRE`. Lo que no se pide no se pinta ni se envía. En particular, no se envía `novedadesElementos: false` ni un `recibeUserId` vacío.
- Web `vigilancia/page.tsx` (detalle del turno para el administrador): el bloque del cierre se mostraba solo si había `consignas`, así que un cierre simplificado no habría mostrado ni quién cerró. Ahora se muestra si `estado === "cerrado"` y cada línea solo si tiene dato. Esto también corrige el cierre administrativo de turnos huérfanos, que ya no mostraba sus observaciones. El CSV incluye la fila "Consignas" si hay consignas, relevo u observaciones.

**Documentación**

- `docs/guardas-planificacion-coberturas.md` §12: el cierre ahora se describe como simplificado.

### 2.5 Cambios de base de datos

**Ninguno para el cierre.** No se requieren: las columnas ya admitían ausencia. No se creó ninguna migración. El único cambio de esquema es ajeno al cierre: los dos campos opcionales de Aval, para que `main` acepte los documentos que ya existen en el deployment (sección 7).

---

## 3. Compatibilidad con Condominios Aval

### 3.1 Cambios de esquema encontrados

`origin/feat/aval-multiconvenio` tiene 2 commits sobre `main@0ab49e1`: `dd5fa24` "credenciales de Aval por convenio" y `c5d2cb6` "setAvalNura". En `schema.ts` solo hay dos campos nuevos, ambos opcionales:

| Tabla | Campo | Tipo |
|---|---|---|
| `condominios` | `avalNura` | `v.optional(v.string())` |
| `pagos` | `agrmId` | `v.optional(v.string())` |

Además: `lib/avalConvenio.ts` (nuevo), `lib/avalProduccion.ts`, `pagos.ts`, `condominios.ts` (`update` con `avalNura` y la mutación interna `setAvalNura`), `_generated/api.d.ts` (registra `lib/avalConvenio`), y en la web `edit-condo-dialog.tsx` y las páginas de condominios.

### 3.2 Cómo afectan este trabajo

- **No tocan** `guardiaTurnos`, `guardia.ts`, `lib/cierreTurno.ts` ni los modales. No hay solapamiento de archivos con este cambio: son 7 archivos de código/tests más 2 documentos, ninguno de ellos tocado por la rama Aval.
- El cierre **no toca `schema.ts`** ni `_generated/api.d.ts`: cambiar un validador de argumentos no regenera tipos. `schema.ts` sí cambió después, pero quedó **idéntico byte a byte** al de Aval (mismo blob `655acff`; sección 7). Fusionar Aval lo dejará igual, sin conflicto.
- No hay orden de migraciones que respetar: no se agregó ninguna.

### 3.3 Medidas y verificación

- Apliqué este diff sobre `origin/feat/aval-multiconvenio` en un worktree temporal (ya eliminado). `git apply --check` pasó y el parche se aplicó **limpio** en los 7 archivos.
- Sobre esa combinación: `tsc --noEmit` del backend sin errores; 29/29 unitarias (`cierreTurno` + `avalConvenio` + `avalProduccion`); 201/201 de integración en los 10 archivos que cierran turnos.
- **Limitación de esa verificación:** se hizo sobre la rama Aval, no sobre `main`. `main` siguió sin los campos de Aval, y eso es lo que hacía fallar `convex dev`. Se corrigió en la sección 7.

### 3.4 Riesgo de despliegue (ocurrió; resuelto en la sección 7)

Convex valida el esquema contra los datos en cada deploy. El deployment de dev ya tenía `avalNura` en dos condominios, así que `convex dev` desde `main` (sin el campo) fue rechazado: *"Object contains extra field `avalNura` that is not in the validator"*. Ahora `main` declara los dos campos y el push pasa.

---

## 4. Pruebas

### 4.1 Tests ejecutados

| Suite | Antes del cambio | Después |
|---|---|---|
| `pruebas/cierreTurno.prueba.ts` (unitarias de la regla) | 11/11 | **15/15** (4 nuevas) |
| `pruebas/cierreTurno.test.ts` (integración, API pública) | 21/21 | **24/24** (3 reescritas por el nuevo comportamiento, 6 nuevas) |
| 10 archivos de integración que cierran turnos* | 198/198 | **201/201** |
| Todas las unitarias del backend (`node --test pruebas/*.prueba.ts`) | — | **357/357** |
| Todo vitest del backend (38 archivos) | — | **868/868** |
| `tsc --noEmit` backend / web | — | sin errores |
| `tsc --noEmit` móvil | — | solo el error preexistente de `convex/auth.ts(34,11)`, que ya existe en `HEAD` |
| Lo mismo sobre `feat/aval-multiconvenio` + este cambio | — | tsc OK, 29/29 unitarias, 201/201 integración |
| `main` con los campos de Aval en el esquema (sección 7) | — | tsc backend/web OK, 15/15 unitarias del cierre, 201/201 integración |
| `bunx convex dev --once` y `bunx convex dev` desde `main` | Falla: extra field `avalNura` | **"Convex functions ready!"** |

\* `cierreTurno`, `supervisor`, `hardeningVigilancia`, `coberturasAcceso`, `coberturasRegresion` (snapshot), `contextoMovil`, `correccionesPostQa`, `inasistencias`, `trazabilidadCoberturas`, `trazabilidadRegresion`.

**Tests actualizados, solo donde el comportamiento cambió a propósito:**

- Unitarias: las pruebas que exigían relevo, consignas, observaciones o la respuesta de novedades ahora pasan `CIERRE_COMPLETO` explícitamente. Así siguen probando que la funcionalidad completa se conserva y funciona.
- Integración: se reescribieron las 3 pruebas que esperaban rechazo por un campo ahora oculto ("observaciones vacías", "relevo ausente", "app vieja sin la pregunta de novedades"), porque ahora el cierre debe pasar.

**Casos cubiertos por las pruebas nuevas:**

| Caso | Prueba |
|---|---|
| 1 — Cierre normal | `cerrarTurno({ turnoId })` cierra, guarda quién cerró y cuándo, deja la minuta como "Turno de Ana Guarda cerrado por Ana Guarda.", libera la portería y el relevo puede abrir el siguiente turno. |
| 2 — Campos ocultos vacíos | Ausentes, `""` o de solo espacios no bloquean el cierre y no se guardan como texto. Lo no contestado no se guarda como "sin novedad". |
| 3 — Datos históricos | Un cierre completo y uno simplificado conviven en `listTurnos`/`getTurno`. El cierre con el formulario antiguo (prueba existente) se sigue leyendo. |
| 4 — Backend | Un request sin ningún dato del formulario pasa validador, regla, persistencia y minuta. Lo que llega mal se sigue rechazando: relevo ajeno, novedad sin detalle. Las autorizaciones no cambian. |
| 5 — Base de datos | `convex-test` valida cada escritura contra `schema.ts`, y los cierres con campos ausentes pasan esa validación. Además, `convex dev` validó el esquema de `main` contra todos los documentos del deployment de dev (sección 7). |
| 6 — Condominios Aval | Sección 3.3. |
| 7 — Regresión | Suite completa del backend en verde. |

### 4.2 Migraciones verificadas

No hay migraciones nuevas ni SQL. El esquema de `guardiaTurnos` se verificó por lectura y por `convex-test`, que aplica `schema.ts`. Después, a pedido, se ejecutó `bunx convex dev` contra `dev:agreeable-bee-782` y el esquema pasó la validación (sección 7). No se ejecutó `convex deploy` a producción.

### 4.3 Verificación visual

Se cargó el modal web con un turno de prueba en una ruta temporal (ya borrada). Muestra solo el resumen, "Entrega el turno", Cancelar y Cerrar turno, sin errores en consola. El móvil no se verificó visualmente: se revisó por typecheck y por lectura del código.

### 4.4 Casos manuales que deben probarse

1. **Web, guarda con turno abierto**: minuta → Cerrar turno. Solo se ve "Entrega el turno". Cerrar turno cierra sin errores, la minuta vuelve a "Iniciar turno" y en la bitácora queda "Turno de … cerrado por …".
2. **Móvil (build nueva)**: igual que el punto 1 desde la minuta. El botón "Cerrar" de la cabecera está activo y no aparece el `Alert` "Faltan datos".
3. **Turno pendiente por cobertura o huérfano**: cerrar desde el aviso "Cerrar ese turno" (web y móvil).
4. **Turno compartido**: lo cierra el secundario. Lo cierra un administrador.
5. **Administrador, Vigilancia → Turnos → Detalle**: en un turno cerrado con el formulario simplificado se ve "Cerró: …". En un turno antiguo se siguen viendo consignas, relevo, novedades y observaciones. Exportar CSV en ambos.
6. **App móvil publicada sin actualizar**: sigue mostrando el formulario completo y exigiéndolo; el servidor lo acepta y lo guarda entero.
7. **Siguiente turno**: después del cierre simplificado, el relevo puede iniciar turno en esa portería.

---

## 5. Cómo volver a pedir un campo

1. En [cierreTurno.ts](../packages/backend/convex/lib/cierreTurno.ts), en `CAMPOS_PEDIDOS_CIERRE`, cambiar el campo a `true`: `elementos`, `recibe`, `consignas` u `observacionesCierre`.
2. Ajustar la prueba `"hoy el cierre no pide ninguno de los campos ocultos"` en `cierreTurno.prueba.ts` y las de "el cierre simplificado" en `cierreTurno.test.ts`.
3. **Primero** publicar la build móvil que ya muestre el campo y **después** activar la regla en el servidor (ver riesgo 6.2).

---

## 6. Riesgos y pendientes

1. **"RRH" no existe en el código.** No aparece en ningún archivo del repo. Lo interpreté como el campo "Entrega el turno" (nombre de quien entrega, solo lectura), que es lo que quedó visible. **Hay que confirmar** si "RRH" se refiere a otra cosa.
2. **Reactivar campos y apps móviles publicadas.** La regla es compartida: activar un campo lo vuelve obligatorio también en el servidor. Las builds móviles que lo ocultan dejarían de poder cerrar turno. Ese es el orden de la sección 5.
3. **El móvil no tiene actualizaciones OTA** (no hay `expo-updates`). Los guardas solo ven el formulario simplificado cuando instalan una build nueva. Mientras tanto, la app publicada sigue pidiendo todo, y el servidor lo acepta igual.
4. **Menos información en los cierres nuevos.** Los turnos cerrados desde ahora no tendrán relevo, consignas, observaciones ni novedades de elementos, a menos que se reactiven. Las vistas lo toleran: el detalle del administrador muestra lo que haya, y la minuta no afirma "sin novedad".
5. **CSV del detalle:** "Cerró: …" solo sale en la fila de novedades de elementos, que un cierre simplificado no tiene. El modal de detalle sí lo muestra. Es un ajuste menor, y lo dejé pendiente para no ampliar el alcance.
6. **Comentario desactualizado en `schema.ts`.** Sobre `observacionesCierre` dice "Obligatorias desde que el cierre registra los elementos". No lo cambié para que `schema.ts` siga idéntico al de la rama Aval. Conviene actualizarlo después de fusionarla.
7. **Resumen del turno visible.** Lo mantuve porque es de solo lectura y no le pide nada al guarda. Si se quiere un modal con únicamente "Entrega el turno", basta con quitar el bloque `stats` de los dos modales (o pasarlo detrás de la misma configuración).
8. **Orden de despliegue con Condominios Aval** (sección 3.4): resuelto para el esquema. Queda el efecto sobre las funciones desplegadas descrito en la sección 7.5.

---

## 7. Corrección: esquema de Aval en `main` y `convex dev` (2026-10-07)

### 7.1 El problema

`bunx convex dev` desde `main` fallaba con:

```text
Document with ID "j57539w0yhh0bzvc6r7xmmg67s8avkrw" in table "condominios" does not match the schema:
Object contains extra field `avalNura` that is not in the validator.
```

El deployment `dev:agreeable-bee-782` estaba corriendo el código de la rama Aval. Lo confirmé con `convex function-spec`: tenía `condominios:setAvalNura`, que no existe en `main`. Con ese código ya se había escrito `avalNura` en condominios. La verificación de la sección 3.3 aplicó el cierre **sobre la rama Aval**, así que no detectó que `main` seguía sin esos campos.

### 7.2 Diferencia entre `main` y `origin/feat/aval-multiconvenio`

- Código: 2 commits de Aval que `main` no tiene (`dd5fa24`, `c5d2cb6`), en 10 archivos (sección 3.1).
- **Esquema:** `git diff origin/feat/aval-multiconvenio -- packages/backend/convex/schema.ts` sobre `main` mostraba exactamente dos líneas faltantes, nada más:

| Tabla | Campo | Definición en Aval | ¿Estaba en `main`? |
|---|---|---|---|
| `condominios` | `avalNura` | `v.optional(v.string())` | No |
| `pagos` | `agrmId` | `v.optional(v.string())` | No |

- La otra rama remota, `feat/whatsapp-bsuid-usernames`, ya está contenida en `main` (su punta es el merge-base), así que no aporta campos al esquema.

### 7.3 Qué se cambió

| Archivo | Cambio |
|---|---|
| `packages/backend/convex/schema.ts` | Agregué `avalNura: v.optional(v.string())` en `condominios` y `agrmId: v.optional(v.string())` en `pagos`, con el mismo texto, comentarios y posición que en Aval. |

Nada más. El resto del código de Aval (`pagos.ts`, `condominios.ts`, `lib/avalConvenio.ts`, …) **no** se trajo, por decisión explícita: solo lo necesario del esquema. No se borraron datos, no se creó ninguna migración y no se tocó el cierre de turno.

### 7.4 Verificación

| Comprobación | Resultado |
|---|---|
| `schema.ts` de `main` vs. el de Aval | **Idéntico byte a byte** (`cmp` sin diferencias; blob `655acff` en ambos). Ambos campos son `v.optional(v.string())`, igual que en Aval. |
| `tsc --noEmit` backend y web | Sin errores |
| `cierreTurno.prueba.ts` | 15/15 |
| 10 archivos de integración que cierran turnos | 201/201 |
| `bunx convex dev --once` (cwd `packages/backend`) | `✔ Convex functions ready! (5.07s)`, exit 0. Convex validó el esquema contra **todos** los documentos existentes y no reportó ningún campo extra. |
| `bunx convex dev` (modo normal, 90 s y detenido) | `✔ Convex functions ready! (3.93s)` y luego `Preparing to watch files...`, sin errores |
| Datos después del push (lectura con `convex data`) | Siguen intactos los dos condominios con `avalNura`: `j57539w0yhh0bzvc6r7xmmg67s8avkrw` = `"00030713"` y `j57d339y8p86ph8jhwnfqct4w98av727` = `"00030830"`. `pagos` no tiene documentos en dev. |
| `_generated/` | Sin cambios después del push |
| Funciones desplegadas | `guardia:cerrarTurno` ahora tiene `consignas` opcional: el cierre simplificado quedó desplegado en dev. |

### 7.5 Efecto en el deployment de dev (por decisión de traer solo el esquema)

Al empujar `main`, el deployment ahora corre **el código de `main`**, no el de Aval:

- Se quitó `condominios:setAvalNura`. Es la única función que desapareció: 670 → 669.
- `pagos.ts` y `condominios.update` corren la versión de `main`, sin las credenciales de Aval por convenio. Los condominios conservan su `avalNura`, pero el código desplegado no lo usa.

Esto se restablece cuando se fusione Aval en `main`, o cuando alguien vuelva a desplegar la rama Aval. Esto último ya es seguro: el esquema es el mismo.
