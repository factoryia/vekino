# Inicio de turno simplificado — auditoría, cambios y verificación

Fecha: 2026-10-07 · Rama de trabajo: `main` (sin commit) · Rama de referencia: `origin/feat/aval-multiconvenio`

## Resumen

- Al iniciar turno, el guarda ahora solo ve **Checklist de dotación** y **Compañero de turno (opcional)**.
- **"Tu nombre completo"** y **"Observaciones iniciales"** quedaron **ocultos**. No se eliminó ningún campo, columna, argumento, validador ni servicio.
- **Quién toma el turno sale de la sesión.** El turno ya pertenecía al usuario autenticado (`guardiaUserId`); ahora también el nombre (`guardiaNombre`) sale de ese usuario. Un nombre escrito a mano ya no puede contar otra persona, ni siquiera desde una app móvil sin actualizar.
- **Sin cambios de esquema ni migraciones.** `schema.ts` sigue idéntico al de la rama Aval (0 líneas de diferencia).
- Para volver a pedir un campo, se cambia un `false` por `true` en `CAMPOS_PEDIDOS_INICIO` ([inicioTurno.ts:46](../packages/backend/convex/lib/inicioTurno.ts)).
- Tests: 363/363 unitarias, 882/882 de integración y 8/8 archivos de pruebas web. Sobre `main` + Aval + este cambio: tsc OK, 370/370 unitarias y 882/882 de integración.

---

## 1. Auditoría (estado antes del cambio)

### 1.1 Cómo funcionaba el inicio

1. **Puntos de entrada.** Hay un formulario por app, y los dos son iguales:
   - Web: botón "Iniciar turno" de la minuta, cuando no hay turno abierto. Abre `IniciarTurnoModal` en [`apps/web/app/guardia/[id]/page.tsx`](../apps/web/app/guardia/[id]/page.tsx).
   - Móvil: botón "Iniciar turno" de la minuta. Abre `IniciarTurnoModal` en [`apps/mobile/src/app/(app)/guardia/minuta.tsx`](../apps/mobile/src/app/(app)/guardia/minuta.tsx). La tarjeta "Iniciar turno" del inicio del guarda (`components/guardia/guardia-home.tsx`) solo lleva a la minuta: no tiene formulario propio.
2. **Estado del formulario.** `rows` es el checklist, precargado desde `guardia.listChecklistTemplate` (los ítems activos de la plantilla) o, si la plantilla está vacía, con tres ítems por defecto. Además: `quienTurno`, `companero`, `observaciones`, `busy` y `error`.
3. **Validaciones del cliente.** El checklist no puede estar vacío y las filas sin nombre no se envían. `quienTurno` era **obligatorio**: el botón quedaba deshabilitado mientras estuviera vacío. En la web, "Escribe el nombre de quien toma el turno."; en el móvil, un `Alert` "Nombre requerido".
4. **Request.** `api.guardia.iniciarTurno({ condominioId, checklist, observacionesInicio, guardiaNombre, guardiaSecundarioNombre })`. Los formularios nunca envían `guardiaSecundarioUserId`; es una vía heredada.
5. **Servidor** (`guardia.iniciarTurno`, [guardia.ts:225](../packages/backend/convex/guardia.ts)):
   1. `requireCondominioRole(GUARD_ROLES)` obtiene el usuario de la sesión y autoriza por membresía de guardia, por asignación de compañía o por cobertura.
   2. Rechaza la operación si el guarda tiene un turno huérfano en otro conjunto (QA-008) o si ya hay un turno abierto en la portería.
   3. Exige un checklist con al menos un ítem.
   4. **`guardiaNombre = args.guardiaNombre?.trim() || displayNameFromUser(user)`**: el texto escrito tenía prioridad y la sesión solo servía de respaldo.
   5. Compañero: lo recorta y, si llega `guardiaSecundarioUserId`, comprueba que esté activo, que tenga rol de guardia aquí y que no sea quien inicia. Rechaza el compañero si su nombre coincide con el de quien inicia (sin distinguir mayúsculas).
   6. Sella `coberturaId` (`coberturaQueAmpara`), inserta el turno con `guardiaUserId: user._id` y escribe en la minuta "Inicio de Turno" con `actorUserId: user._id` y `actorNombre: guardiaNombre`.
6. **Errores.** En la web, `mensajeErrorUsuario` debajo del formulario. En el móvil, un `Alert` con `e.message`.
7. **Después.** `turnoActivo` es reactivo: la minuta muestra "Turno de {guardiaNombre}". El administrador ve el turno en *Vigilancia → Turnos*, con "Inicio: {observacionesInicio}" si hay observaciones. `operacionCompania` muestra a los guardas del turno por `guardiaNombre`.

### 1.2 Cómo se obtiene la identidad del guarda

| Paso | Dónde | Qué hace |
|---|---|---|
| Sesión | Better Auth → `ctx.auth.getUserIdentity()` | `identity.subject` es el id de autenticación |
| Perfil | `getCurrentAppUser` ([authz.ts:24](../packages/backend/convex/model/authz.ts)) | `users` por el índice `by_authId`; `requireAppUser` exige que esté activo |
| Autorización | `requireCondominioRole` ([authz.ts:122](../packages/backend/convex/model/authz.ts)) | Devuelve ese mismo `user` si opera aquí como guarda |
| Nombre visible | `displayNameFromUser` (`model/displayName.ts`) | `firstName + lastName` si suman dos palabras o más; si no, `users.name`; pasa a Title Case lo que venga en mayúsculas |

**La fuente única de verdad es el usuario autenticado.** `guardiaUserId` siempre ha salido de ahí: el cliente no puede mandarlo. `displayNameFromUser` es el mismo nombre que la portería web muestra en su cabecera (`guardia.home.userName`) y el mismo con el que `getTurno` muestra quién cerró.

**El riesgo que había:** como el texto escrito tenía prioridad, un turno podía quedar con `guardiaUserId` = Ana y `guardiaNombre` = "José Pérez". La minuta quedaba igual: `actorUserId` de Ana, `actorNombre` "José Pérez". Eran dos personas distintas en el mismo registro.

**De dónde venía el campo.** El comentario de la mutación decía "suele haber una sola cuenta compartida en portería". El proyecto ya se alejó de ese modelo: los guardas de compañía tienen cuenta propia (`companias.crearMiembro`), y `migrations.ts` trata la cuenta compartida como "un dato a retirar, no a portar".

### 1.3 Campos y obligatoriedad (antes)

| Campo en pantalla | Arg de `iniciarTurno` | Columna `guardiaTurnos` | Esquema | Validador de args | Cliente | Servidor | ¿Obligatorio? |
|---|---|---|---|---|---|---|---|
| Tu nombre completo | `guardiaNombre` | `guardiaNombre` | `v.string()` | `v.optional` | **Obligatorio** (web y móvil) | Opcional; respaldo: la sesión | **Sí, en pantalla.** La columna siempre se llena. |
| Checklist de dotación | `checklist` | `checklist` | `v.array(...)` | `v.array(...)` | Al menos una fila | Al menos un ítem; recorta ítem y observación | **Sí** |
| Compañero de turno | `guardiaSecundarioNombre` (`guardiaSecundarioUserId`, heredado) | ídem | `v.optional` | `v.optional` | Opcional | Distinto de quien inicia; por id: activo y con rol de guardia | No |
| Observaciones iniciales | `observacionesInicio` | `observacionesInicio` | `v.optional` | `v.optional` | Opcional | Recortadas; vacías → ausentes | No |
| (servidor) | — | `guardiaUserId` (sesión), `coberturaId` (sello), `estado`, `fechaInicio`, `createdAt`, `updatedAt` | `coberturaId` opcional; el resto obligatorio | — | — | Los fija el servidor | — |

### 1.4 Base de datos

- Columnas **obligatorias** de `guardiaTurnos` ([schema.ts:1670](../packages/backend/convex/schema.ts)), que se fijan al abrir el turno: `condominioId`, `guardiaUserId`, `guardiaNombre`, `checklist`, `estado`, `fechaInicio`, `createdAt` y `updatedAt`.
- Columnas **opcionales** del inicio: `guardiaSecundarioUserId`, `guardiaSecundarioNombre`, `observacionesInicio` y `coberturaId`. Todas las del cierre también son opcionales.
- **¿`guardiaNombre` ya se obtenía del usuario autenticado?** Solo como respaldo. Los dos formularios siempre enviaban el nombre escrito, así que en la práctica se guardaba el texto manual. Las pruebas de integración que llamaban sin nombre ya usaban el de la sesión, y por eso sus snapshots no cambian.
- **Riesgo para los datos históricos:** ninguno. No se toca ninguna columna. Los turnos viejos conservan el nombre que se escribió y sus observaciones.
- Convex no tiene SQL ni migraciones versionadas: el esquema es declarativo y se valida contra los documentos en cada deploy. Este cambio no toca `schema.ts`.

---

## 2. Cambios realizados

### 2.1 Qué se ocultó, qué se mantuvo y qué pasó a ser opcional

| Campo | Antes | Ahora |
|---|---|---|
| Tu nombre completo | Visible y obligatorio en pantalla | **Oculto.** No se envía. El servidor toma el nombre de la sesión. |
| Checklist de dotación | Visible, al menos un ítem | **Sin cambios**: plantilla, estado OK/novedad, cantidades, observación por ítem, validación, persistencia y visualización posterior |
| Compañero de turno (opcional) | Visible, opcional | **Sin cambios.** Sigue visible, opcional y con las mismas validaciones (vía heredada por id incluida) |
| Observaciones iniciales | Visible, opcional | **Oculto** y opcional. Si llega (app vieja), se guarda igual que antes |

Lo oculto quedó envuelto en `pideInicio.<campo> && …`. El JSX, el estado y los textos siguen en los dos componentes, intactos.

### 2.2 Cómo se obtiene ahora el nombre del guarda

`guardiaNombre = nombreDeQuienInicia(args.guardiaNombre, displayNameFromUser(user))` ([guardia.ts:264](../packages/backend/convex/guardia.ts)):

- Mientras el nombre **no se pide** (hoy), el nombre sale **solo de la sesión** y se descarta el que llegue escrito. Así, una app móvil sin actualizar, que todavía lo pide, tampoco puede guardar otra persona.
- Si se vuelve a pedir (`guardiaNombre: true`), vuelve exactamente el comportamiento anterior: manda el texto escrito y la sesión queda de respaldo.
- La comparación "el compañero no puede ser el mismo nombre" ahora se hace contra el nombre de la sesión.

### 2.3 Cambios por capa

**Backend**

- **Nuevo** `packages/backend/convex/lib/inicioTurno.ts`, con el mismo patrón que `lib/cierreTurno.ts`:
  - `CamposPedidosInicio` (`guardiaNombre`, `observacionesInicio`).
  - `INICIO_COMPLETO`: todo en `true`, el formulario de antes.
  - `CAMPOS_PEDIDOS_INICIO`: todo en `false`, el de hoy.
  - `nombreDeQuienInicia(escrito, deLaSesion, pide)`.
- `guardia.ts` → `iniciarTurno`: usa `nombreDeQuienInicia`. **Los argumentos no cambian**: mismos nombres, tipos y opcionalidad, así que un request antiguo pasa el validador igual que antes. `observacionesInicio` se sigue recortando y guardando si llega.
- `package.json`: nueva exportación `@vekino/backend/inicioTurno` para la web y el móvil, igual que `./cierreTurno`.
- `convex/_generated/api.d.ts`: dos líneas que registran `lib/inicioTurno` en el orden alfabético que usa el codegen de Convex. Se agregaron a mano para no ejecutar el CLI de Convex contra el deployment de dev compartido (ver §5).

**Frontend**

- Web `app/guardia/[id]/page.tsx` y móvil `app/(app)/guardia/minuta.tsx`:
  - Ambos usan `const pideInicio = CAMPOS_PEDIDOS_INICIO`.
  - Lo que no se pide no se pinta ni se envía: no va `guardiaNombre` ni `observacionesInicio` en el request.
  - La exigencia del nombre (mensaje, `Alert` y botón deshabilitado) solo aplica si se pide.
  - El botón "Iniciar turno"/"Iniciar" queda activo con el checklist cargado.

**Documentación**

- `docs/guardas-planificacion-coberturas.md` §12: el inicio se describe como simplificado.

### 2.4 Cambios de base de datos

**Ninguno.** No se requieren, no se creó ninguna migración y no se tocó `schema.ts`.

---

## 3. Compatibilidad

### 3.1 Registros históricos

- Los turnos anteriores conservan su `guardiaNombre` escrito a mano y su `observacionesInicio`. `turnoActivo`, `listTurnos` y `getTurno` los devuelven intactos, y se pueden cerrar con el cierre simplificado (prueba "caso 5").
- La vista del administrador ya pintaba "Inicio: …" solo cuando hay observaciones, así que los turnos nuevos, que no las tienen, se ven bien sin cambios.

### 3.2 Esquema y deployment de Convex

- `schema.ts`: sin cambios. Sigue siendo idéntico al de `origin/feat/aval-multiconvenio` (`git diff` de 0 líneas). Siguen presentes `condominios.avalNura` y `pagos.agrmId`.
- Funciones: `iniciarTurno` mantiene el mismo validador de argumentos. **El orden de despliegue no importa**:
  - Cliente nuevo con servidor viejo: el cliente no manda el nombre, el servidor viejo cae al respaldo `displayNameFromUser(user)` y el resultado es el mismo.
  - Cliente viejo con servidor nuevo: el servidor descarta el nombre escrito y guarda las observaciones.
- No se ejecutó `convex dev` ni `convex deploy`: el deployment de dev sigue con el `iniciarTurno` anterior hasta el próximo push.

### 3.3 Compatibilidad con Condominios Aval

- La rama Aval no toca `guardia.ts`, `guardiaTurnos` ni los modales. El único archivo que comparten es `_generated/api.d.ts`: Aval registra `lib/avalConvenio` y este cambio `lib/inicioTurno`, en hunks distintos.
- **Verificación 1:** el parche aplicado sobre `origin/feat/aval-multiconvenio` en un worktree temporal. `git apply --check` pasó limpio y tsc del backend quedó OK.
  - En esa rama sola, 176/178 pasan. Las 2 que fallan son pruebas nuevas que cierran el turno sin datos, y ese cierre simplificado (`043ccfa`) solo existe en `main`: Aval exige `consignas`. No es un conflicto de este cambio.
- **Verificación 2, el estado real futuro:** `main` + `git merge --no-commit origin/feat/aval-multiconvenio` + este parche.
  - Merge automático sin conflictos; el parche aplicó limpio.
  - `api.d.ts` queda con las dos entradas y `schema.ts` sin cambios frente a `main`.
  - tsc del backend OK, **370/370** unitarias (incluidas las de Aval) y **882/882** de integración.
  - El worktree temporal se eliminó y no se hizo ningún commit.
- No se revirtieron `avalNura` ni `agrmId`.

---

## 4. Pruebas

### 4.1 Tests ejecutados

| Suite | Antes | Después |
|---|---|---|
| `pruebas/inicioTurno.prueba.ts` (unitarias de la regla, **nuevo**) | — | **6/6** |
| `pruebas/inicioTurno.test.ts` (integración por la API pública, **nuevo**) | — | **14/14** |
| Todas las unitarias del backend (`node --test pruebas/*.prueba.ts`) | 357/357 | **363/363** |
| Todo vitest del backend | 38 archivos, 868/868 | **39 archivos, 882/882** |
| Web `pruebas/erroresCrudos.test.mjs` (monta la página real de la minuta) | 5 | **8/8** (1 actualizada, 3 nuevas) |
| Las demás pruebas web (`incidentes*`, `navegacionCompania`, `operacionCompania`, `recordatorioCierre`) | — | todas en verde (18, 13, 15, 25, 22, 7, 29) |
| Móvil `pruebas/*.prueba.ts` | — | 13/13 |
| `tsc --noEmit` backend / web | — | sin errores |
| `tsc --noEmit` móvil | — | solo el error preexistente de `convex/auth.ts(34,11)`, que ya existe en `HEAD` |
| `main` + Aval + este cambio | — | tsc OK, 370/370 unitarias, 882/882 de integración |

La suite de integración incluye todos los archivos que abren turnos: `cierreTurno`, `supervisor`, `adminCompania`, `coberturas`, `coberturasAcceso`, `coberturasRegresion` (snapshot), `contextoMovil`, `correccionesPostQa`, `hardeningVigilancia`, `horariosGuarda`, `inasistencias` y `trazabilidadCoberturas`. También cubre autenticación y autorización (`seguridad`, `rolUnicoCompania`). Ninguna necesitó cambios. Los snapshots no cambiaron porque esas pruebas ya iniciaban sin nombre.

**Prueba actualizada:** en `erroresCrudos.test.mjs`, el modal ya no tiene el campo "Tu nombre completo", así que `abrirModal` dejó de escribir en él. La regresión "sin rechazo el turno se inicia" ahora comprueba que el request **no** lleve `guardiaNombre`.

### 4.2 Casos del pedido

| Caso | Dónde | Qué se comprueba |
|---|---|---|
| 1 — Inicio normal | `inicioTurno.test.ts` "caso 1"; web "solo pide el checklist…" | No se pide el nombre. El turno queda con `guardiaUserId` y `guardiaNombre` de la sesión, y la minuta queda como "Turno iniciado por Ana Guarda. Checklist: 3 ítems." con `actorUserId`/`actorNombre` de la sesión. El nombre es el mismo que muestra la cabecera (`home.userName`, también con `firstName`/`lastName`). Un nombre distinto enviado por una app vieja se descarta. El checklist se guarda igual (recortes, novedad, cantidades) y `getTurno` lo devuelve. Las validaciones de siempre (checklist vacío, turno ya abierto) siguen igual. |
| 2 — Sin observaciones | "caso 2"; web "sin nombre, observaciones ni compañero" | El turno inicia sin observaciones. Vacías o de solo espacios quedan ausentes. Si las manda una app vieja, se guardan. El formulario web no las manda. |
| 3 — Sin compañero | "casos 3 y 4"; web | Inicia sin compañero, no queda compartido y la minuta no dice "compartido". |
| 4 — Con compañero | "casos 3 y 4"; web "con compañero: se manda su nombre" | El nombre escrito se guarda recortado y sale en la minuta. La vía heredada por id sigue funcionando. El compañero no puede ser quien inicia, comparado contra la sesión, aunque una app vieja mande otro nombre. El compañero por id puede cerrar el turno compartido. |
| 5 — Datos históricos | "caso 5" | Un turno con nombre escrito, compañero y observaciones iniciales se lee en `turnoActivo`, `listTurnos` y `getTurno`, se cierra, y convive con un turno nuevo que ya usa el nombre de la sesión. `convex-test` valida cada escritura contra `schema.ts`. |
| 6 — Web y móvil | Mismo `CAMPOS_PEDIDOS_INICIO` en los dos formularios | Web: render real del componente (abajo). Móvil: typecheck y lectura del código (abajo). |
| 7 — Regresión | §4.1 | Suites completas en verde. |

### 4.3 Web

`erroresCrudos.test.mjs` monta la página real `GuardiaMinutaHome` con happy-dom; solo el servidor está simulado. Se comprueba que:

- El modal muestra "Checklist de dotación" (los 3 ítems por defecto) y "Compañero de turno (opcional)".
- No aparecen "Quién toma el turno", "La cuenta es compartida", el input "Tu nombre completo", "Observaciones iniciales" ni ningún `textarea`.
- El botón "Iniciar turno" está activo sin escribir nada.
- El request no lleva `guardiaNombre` ni `observacionesInicio`.
- El error del turno huérfano se sigue mostrando sin rastro técnico.

**No se verificó en un navegador.** El login local va contra el deployment de dev con usuarios reales, y el modal no se puede montar aislado porque consulta la plantilla con autenticación.

### 4.4 Móvil

Typecheck sin errores nuevos. El cambio en el formulario es el mismo de la web, con el mismo `CAMPOS_PEDIDOS_INICIO`, y la importación `@vekino/backend/inicioTurno` sigue el mismo camino que `@vekino/backend/cierreTurno`, que ya funciona en Metro. **No se ejecutó en un dispositivo ni en un simulador.**

### 4.5 Casos manuales que deben probarse

1. **Web, guarda propio del conjunto:** minuta → Iniciar turno.
   - Solo se ven el checklist y el compañero; Iniciar turno funciona sin escribir nada.
   - La tarjeta dice "Turno de <nombre de su perfil>" y la bitácora, "Turno iniciado por <nombre>…".
2. **Web, guarda de compañía** (por asignación) y **guarda cubriendo otro conjunto:** igual que el punto 1. El turno del que cubre queda con la cobertura sellada.
3. **Móvil, build nueva:** igual que el punto 1. El botón "Iniciar" de la cabecera está activo desde que carga el checklist.
4. **Con compañero:** escribir el nombre del segundo guarda; "· con <compañero>" se ve en la tarjeta y en el detalle del administrador.
5. **Checklist con novedad:** marcar un ítem en rojo con observación; en *Vigilancia → Turnos → Detalle* se ve la novedad.
6. **Administrador, turnos antiguos:** siguen mostrando su nombre escrito y "Inicio: …".
7. **App móvil publicada sin actualizar:**
   - Sigue pidiendo nombre y observaciones.
   - Al iniciar, el turno queda con el nombre del perfil, no con el escrito.
   - Las observaciones se guardan.
8. **Perfiles de guardas:** revisar que `firstName`/`lastName` estén completos (ver §6.3).

---

## 5. Cómo volver a pedir un campo

1. En [inicioTurno.ts](../packages/backend/convex/lib/inicioTurno.ts), dentro de `CAMPOS_PEDIDOS_INICIO`, cambiar el campo a `true`: `guardiaNombre` u `observacionesInicio`.
2. Ajustar la prueba "hoy el inicio no pide el nombre ni las observaciones" de `inicioTurno.prueba.ts`, las de "app sin actualizar" de `inicioTurno.test.ts` y las del bloque "Iniciar turno simplificado" de `erroresCrudos.test.mjs`.
3. A diferencia del cierre, reactivar no rompe las apps publicadas: el servidor nunca exigió estos campos.
4. **Ojo:** reactivar `guardiaNombre` vuelve a dar prioridad al texto escrito y, con eso, el riesgo de §1.2.
5. Cuando corra `convex dev`, revisar que el codegen no cambie `_generated/api.d.ts`. Debería generar exactamente las dos líneas agregadas a mano.

---

## 6. Pendientes y riesgos

1. **Cuentas compartidas de portería.** Si algún conjunto todavía opera con una sola cuenta para todos los guardas (por ejemplo, un usuario "Portería Norte"), sus turnos quedarán a nombre de esa cuenta y se perderá qué persona estaba de turno.
   - **Hay que confirmar si existe alguna.**
   - La solución recomendada es crear cuentas individuales (`companias.crearMiembro`, o membresías con rol `guardia`).
   - Reactivar `guardiaNombre` es global, no por conjunto: devolvería el campo a todos.
2. **App móvil sin OTA.** No hay `expo-updates`, así que mientras no se instale la build nueva los guardas siguen viendo y llenando "Tu nombre completo" y las observaciones. El servidor descarta ese nombre: si alguien escribe uno distinto al de su perfil, verá "Turno de <su perfil>". Es lo que se busca, pero puede sorprender.
3. **La calidad del nombre depende del perfil.** El nombre sale de `users.firstName`/`lastName`/`name`. Un perfil incompleto (solo el nombre de pila, o un `name` mal escrito) queda así en la minuta. Conviene revisar los perfiles de los guardas.
4. **El modal no dice "inicias como X".** El nombre de la sesión ya se ve en la cabecera de la portería (web) y en el inicio del guarda (móvil), así que no se agregó al formulario, para respetar "solo checklist y compañero". Si se quiere una confirmación explícita, basta con una línea de solo lectura con `home.userName`.
5. **El compañero sigue siendo texto libre** (sin cambios, a propósito).
   - Los formularios no envían `guardiaSecundarioUserId`, así que un compañero escrito no queda vinculado a su usuario: no puede cerrar el turno compartido ni cuenta en `operacionCompania`, que filtra por id.
   - Es comportamiento previo, fuera del alcance de este cambio.
6. **El CSV del detalle no incluye `observacionesInicio`.** Es preexistente; el modal sí las muestra. No se tocó.
7. **`_generated/api.d.ts` editado a mano** (2 líneas, igual que lo haría el codegen). Ver §5.5.
8. **Sin desplegar.** El deployment de dev sigue con el `iniciarTurno` anterior. Como se explica en §3.2, el resultado es el mismo en cualquier orden de despliegue.
