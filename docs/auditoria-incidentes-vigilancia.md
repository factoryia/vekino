# Auditoría técnica y propuesta de diseño: Incidentes y Novedades

**Fecha:** 29 de septiembre de 2026  
**Alcance:** análisis del código del repositorio, sin cambios de aplicación, esquema ni datos.  
**Estado:** propuesta para decisión; ninguna capacidad descrita aquí está implementada para el nuevo módulo.

## A. Resumen ejecutivo

Vekino es un monorepo Bun/Turborepo con backend Convex, web Next.js y móvil Expo. La vigilancia ya tiene un eje propio: `companiasSeguridad` → `companiaContratos` → `asignaciones` y `companiaMiembros`, conectado al conjunto mediante `condominioId`. El permiso se resuelve en funciones Convex, combinando rol, compañía activa, contrato y asignación vigentes. La experiencia web separa administración de compañía (`/dashboard/companias/[id]`), supervisión (`/vigilancia` y `/vigilancia/[condominioId]`) y portería (`/guardia/[id]`); móvil ofrece portería.

El módulo debe vivir en ese eje de vigilancia, con un caso `incidentes` cuyo dueño sea **una compañía concreta** y cuyo lugar sea **un conjunto concreto**. Ambos identificadores deben permanecer en cada caso y en sus registros relacionados. Un `condominioId` por sí solo no aísla compañías: el código permite contratos de empresas distintas simultáneos en el mismo conjunto. La autorización de incidentes debe comprobar **el par `(companiaId, condominioId)`**, la relación vigente para acciones nuevas y el alcance particular del actor, siempre en el servidor.

Ya existen reportes `guardiaNovedadReportes`, `minutaEventos`, `novedades` y `reservaIncidentes`. Ninguno modela el caso operativo solicitado. Se deben mantener separados. La minuta puede recibir una referencia o entrada breve al reportar un caso desde portería, mientras el historial del caso tendrá una secuencia propia de eventos inmutables. Las evidencias pueden usar la mecánica de subida S3 existente, pero **la autorización actual de archivos no sirve para evidencia sensible**: `files.generateUploadUrl` y `files.deleteObject` exigen sesión, sin verificar compañía, conjunto u objeto; las URLs generadas son públicas. La política de privacidad y retención es una decisión previa al desarrollo.

## B. Arquitectura actual relevante

| Área | Implementación comprobada | Consecuencia para incidentes |
|---|---|---|
| Persistencia y API | Convex, `packages/backend/convex/schema.ts`; funciones `query`, `mutation`, `action` en archivos por dominio; IDs tipados `Id<"tabla">`, validadores `v`, índices explícitos. No hay ORM SQL activo ni migraciones Prisma para este módulo. | Crear tablas/índices Convex solo en fase posterior. Listado y detalle por funciones Convex, no por API paralela. |
| Autenticación | Better Auth en `convex/auth.ts`; perfil en `users`, unido por `authId`; `model/authz.ts` obtiene usuario y comprueba `active`. Web y móvil consumen API Convex. | Actor siempre desde sesión, nunca desde argumento del cliente. Guardar ID y nombre congelado. |
| Autorización | `model/acceso.ts`, `model/asignacion.ts`, `lib/vigilancia.ts`; capacidades por rol, `exigirAcceso`, `exigirAccesoCompania`, `exigirAccesoContrato`; parte antigua aún usa `requireCondominioRole`. | Extender capacidades existentes para incidentes y añadir una comprobación específica del par compañía/conjunto, sin reutilizar `porteria.ver` como permiso suficiente. |
| Validación | `v` valida argumentos/esquema; las mutaciones hacen comprobaciones de pertenencia, longitud, vigencia y consistencia antes de escribir. Convex no impone `UNIQUE`; se comprueba por índice. | Validar referencias, transiciones y límites en mutaciones atómicas; modelar reglas puras bajo `lib/` cuando ayude a probarlas. |
| Servicios/repositorios | No hay capa genérica de repositorios. Predominan funciones Convex por dominio y helpers `model/` para acceso y escritura repetida (`logMinuta`, `logNovedadItem`). | Módulo `convex/incidentes.ts` y helpers específicos pequeños; evitar una nueva capa de repositorio. |
| Archivos | `convex/files.ts` ofrece S3 por PUT firmado o `uploadBytes`, borrado por key; legado Convex Storage en algunas tablas. Web `lib/upload-s3.ts`, `hooks/use-upload-s3.ts`, `AdjuntosPicker`; móvil `lib/guardia-upload.ts`. | Reutilizar transporte/UI tras endurecer autorización y privacidad; no copiar la política actual de URL pública sin decisión. |
| Auditoría | Minuta append-only por conjunto; `inventarioNovedades` append-only por ítem con `cambios[]`, actor y fecha. Otras tablas guardan solo el último actor/cambio. No existe auditoría genérica de todos los dominios. | Reutilizar el patrón `logNovedadItem` con historial append-only **del incidente**; `minutaEventos` no alcanza para estados, asignaciones y evidencia. |
| UI/routing | Next App Router y Expo Router; componentes comunes `PageContainer`, `PageHeader`, `Card`, `Badge`, `Table`, `Modal`, `EmptyState`, `Skeleton`, `ErrorBoundary`; navegación específica por rol. | Reutilizar shell y controles; detalle de caso con historial, no solo modal CRUD. |
| Errores y pruebas | Backend lanza `Error` con mensajes de dominio; web captura errores de mutación en formularios y `ErrorBoundary` captura queries. `pruebas/*.test.ts` usa Vitest/convex-test; `*.prueba.ts` usa `node:test`. | Probar cruces de compañía, contrato y estado con convex-test, más reglas puras; presentar errores accionables. |

Fuentes principales: [README](../README.md), [package.json](../package.json), [schema](../packages/backend/convex/schema.ts), [acceso](../packages/backend/convex/model/acceso.ts), [roles/capacidades](../packages/backend/convex/lib/vigilancia.ts), [authz](../packages/backend/convex/model/authz.ts), [pruebas de compañía](../packages/backend/pruebas/adminCompania.test.ts).

**Convenciones visibles:** tablas y propiedades del nuevo eje en español (`companiaId`, `condominioId`); timestamps numéricos en milisegundos (`createdAt`, `updatedAt`, `...En`); nombres de funciones/archivos por dominio; referencias Convex y copias legibles de nombres en hechos históricos; índices que arrancan por tenant/consulta. La documentación inicial del README no refleja todos los módulos actuales, por lo que el diseño se basa en el código.

## C. Entidades existentes reutilizables

| Entidad / ID | Relaciones, restricciones y acceso actuales | API y UI relacionada | Uso propuesto |
|---|---|---|---|
| `companiasSeguridad` / `_id` | `nit` comprobado por código; `estado` activa/suspendida/inactiva. Dueña de miembros, contratos e inventario. Plataforma gestiona el directorio; `admin_compania` gestiona su compañía. | `companias.listAll/detail/miCompania/update/setEstado`; ficha `/dashboard/companias/[id]`. | Dueña inmutable del caso. |
| `condominios` / `_id` | Tenant residencial con `isActive`, zona horaria y marca. Contrato lo vincula a la empresa. | `condominios.*`, administración `/condominio/[id]`. | Lugar/contexto del caso; validar existencia y actividad al crear. |
| `users` / `_id` | Perfil de Better Auth, `active`, `platformRole`; nombre y documento. No hay tabla `guardias`. | `users.me`; login y rutas por rol. | Reportante, responsable y actor de historial mediante ID y nombre congelado. |
| `memberships` / `_id` | Usuario ↔ conjunto, roles operativos y `isActive`; `by_condominio_user`. Guardia propio del conjunto también existe sin compañía. | `memberships.*`; `requireCondominioRole`. | No convertirlo en miembro de compañía ni inferir una compañía para guardia propio. |
| `companiaMiembros` / `_id` | Usuario ↔ compañía; un rol efectivo entre `admin_compania`, `supervisor`, `guardia`; histórico de alta/baja y último cambio sensible. Se impide membresía activa simultánea a dos compañías en escrituras. | `companias.detail/crearMiembro/setRolesMiembro/desactivarMiembro`. | Verificar pertenencia del responsable y del reportante corporativo al momento de actuar. |
| `companiaContratos` / `_id` | Compañía ↔ conjunto, rango de vigencia y corte inmediato; se permiten dos compañías distintas simultáneas en un conjunto. Solo plataforma crea; admin de esa compañía puede terminar ahora. | `companias.crearContrato/terminarContrato`; `contratoVigente`. | Habilita nuevas operaciones sobre ese par; conservar ID del contrato de origen si hace falta explicar el reporte histórico. |
| `asignaciones` / `_id` | Miembro corporativo ↔ contrato, copia de `userId`, `companiaId`, `condominioId`; rol por conjunto `supervisor` o `guardia`; vigencia derivada de toda la cadena. | `asignaciones.miEquipo/porContrato`, `asignacionVigente`, `guardasDelConjunto`; supervisión web. | Alcance de supervisor y guarda; validar autor/responsable en su conjunto y empresa. |
| `minutaEventos` / `_id` | Append-only por conjunto, actor, turno/ronda, módulo, resumen. No tiene compañía ni ID de caso; lista acotada a 300. | `guardia.listMinuta/registrarEventoMinuta`, `logMinuta`; portería/supervisión. | Contexto operativo al crear desde portería, **no** fuente del historial del caso. |
| `guardiaNovedadReportes` / `_id` | Reporte de portería por conjunto, prioridad baja/media/alta, fotos/adjunto, gestión de cobro. No tiene compañía ni ciclo de investigación/cierre. | `guardia.reportarNovedad/listNovedadesGuardia/gestionarNovedad`; web/móvil y administración de conjunto. | Posible fuente enlazable, solo con atribución de empresa comprobada. Mantener significado actual. |
| `novedades` / `_id` | Registro simple por conjunto, `tipo` incluye `incidente`; sin estado ni responsable. | Esquema legado. | No reutilizar como caso. |
| `reservaIncidentes` / `_id` | Daños sobre reserva/depósito: pendiente, valorado o descartado; `condominioId`, `reservaId`, fotos, actor. | `reservas.registrarIncidente/valorarIncidente/descartarIncidente`, `guardia.reportarIncidenteReserva`. | No mezclar: objetivo financiero y regla de congelamiento propios. Enlace futuro opcional, no migración implícita. |
| `inventarioNovedades` / `_id` | Historial append-only de un ítem, `companiaId`, tipo, `cambios[]`, actor y fecha; `by_item`. | `model/inventarioNovedad.ts`, `inventarioGuardas.historialDeItem`. | Patrón de evento auditable, no tabla compartida con incidentes. |

La relación entre supervisor y conjunto **es la asignación con rol supervisor**, no un `supervisorId` en el conjunto. El guarda corporativo usa `users` + `companiaMiembros` + `asignaciones`; el guarda propio usa `memberships`. [Esquema de vigilancia](../packages/backend/convex/schema.ts), [asignación vigente](../packages/backend/convex/model/asignacion.ts), [compañías](../packages/backend/convex/companias.ts).

### Aislamiento requerido

1. Leer un caso por ID: cargar caso, obtener **de él** `companiaId` y `condominioId`, luego comprobar acceso a **esa compañía y ese conjunto**. Nunca autorizar con IDs paralelos enviados por el cliente.
2. Listar: índice inicial por `companiaId` y, para supervisor/guarda, por `companiaId + condominioId` o subconjunto de sus asignaciones vigentes. Filtrar en backend antes de paginar; no filtrar una página mezclada por `condominioId` en frontend.
3. Crear: derivar la compañía de la membresía/asignación autenticada o exigir que el `companiaId` pedido coincida con ella; comprobar contrato vigente para el par. Si el actor tiene varios contextos, pedir selección explícita y validarla.
4. Mutar hijos: cargar evidencia/persona/evento → incidente padre → autorización del padre. Verificar que referencias a usuarios y conjunto pertenezcan a la misma empresa y ámbito.
5. Si coinciden dos empresas en un conjunto, ninguna lectura, archivo, historial o contador de una debe incluir casos de la otra. El acceso residencial a la portería (`porteria.ver`) **no concede** acceso a casos corporativos de ambas empresas.

Hay pruebas de aislamiento por compañía y de dos empresas en una misma portería en [adminCompania.test.ts](../packages/backend/pruebas/adminCompania.test.ts) e [inventarioGuardas.test.ts](../packages/backend/pruebas/inventarioGuardas.test.ts); son precedente, no pruebas del módulo nuevo. También se debe revisar el comportamiento con múltiples roles del mismo usuario: `resolverAcceso` suma vías para portería y puede devolver una asignación de empresa aunque exista membresía residencial. Para incidentes hay que fijar contexto de compañía explícito.

## D. Modelo de dominio propuesto

```text
companiasSeguridad 1 ── N incidentes N ── 1 condominios
companiaContratos  1 ── N incidentes (contrato de origen, opcional según decisión)
users             1 ── N incidentes (reportante / responsable)
incidentes        1 ── N incidentePersonas
incidentes        1 ── N incidenteEvidencias
incidentes        1 ── N incidenteEventos (append-only)
```

**`incidentes` (nueva, necesaria):** caso principal, no sustituible por `guardiaNovedadReportes`. Campos propuestos: `_id`; `companiaId`, `condominioId`; código de tipo; `ubicacion` textual; `ocurrioEn`, `reportadoEn`; `reportadoPorUserId` y `reportadoPorNombre`; descripción inicial; prioridad; estado; `responsableUserId` y nombre congelado al asignar; `resueltoEn`, `cerradoEn`; `resolucionObservacion` o resumen de resolución; `createdAt`, `updatedAt`. Conservar `contratoOrigenId`, `turnoId`, `rondaId` y `novedadOrigenId` solo si el flujo decidido los usa. `reportadoEn` debe ser hora de servidor; `ocurrioEn` puede venir del usuario y validarse. El caso no se borra físicamente en el flujo normal. Índices previstos por `(companiaId, estado, reportadoEn)`, `(companiaId, condominioId, reportadoEn)` y/o variantes según pantallas y volumen real; detalle por `_id`. Evitar índices sin consulta concreta.

**`incidentePersonas` (nueva propuesta):** varias personas pueden agregarse/corregirse en momentos distintos; cada cambio debe quedar en historial. Una fila por persona involucrada con `incidenteId`, `companiaId`, `condominioId`, nombre, tipo de persona, documento opcional, observación, `createdAt` y baja lógica si se permite retirar. No enlazar automáticamente con `users`: residentes, visitantes y terceros no son necesariamente usuarios y enlazarlos mal expondría datos. Si el alcance real se limita a una lista breve que se edita siempre junto con el caso, podría ser un arreglo embebido; la edición independiente y la trazabilidad exigidas favorecen tabla hija. `tipo de persona` y tratamiento del documento siguen pendientes.

**`incidenteEvidencias` (nueva necesaria):** varias fotos o documentos, incorporación en tiempos distintos, metadatos y posible retirada. `incidenteId`, `companiaId`, `condominioId`, `s3Key`/referencia de storage, nombre, MIME, tamaño, autor ID/nombre, fecha, descripción opcional, y marca de retiro/actor/motivo si se autoriza. Un simple `fotos[]` en el caso no preserva autor ni historia de cada archivo. No aceptar `url` arbitraria del cliente como prueba de posesión del objeto.

**`incidenteEventos` (nueva necesaria):** historial append-only, indexado por `incidenteId`, con `companiaId` y `condominioId` para aislamiento; `tipo` controlado, `descripcion` legible, `cambios[]` antes/después cuando aplique, actor ID/nombre y `createdAt`. Tipos mínimos: creación, clasificación, cambio de prioridad, asignación, cambio de estado, seguimiento/observación, cambio relevante, evidencia agregada/retirada, persona agregada/corregida/retirada, resolución y cierre. El estado actual es proyección en `incidentes`; el evento guarda el hecho. Escribir ambos en **la misma mutación Convex** mediante un helper único, como `logNovedadItem`, para evitar huecos.

**Observaciones:** evitar un único campo sobrescrito como historial. Seguimientos son eventos con texto y autor; en el caso puede mantenerse un resumen actual si la UI lo requiere. La observación de resolución se guarda también en el caso para filtros/detalle y en el evento de resolución para constancia de qué se declaró entonces.

**No crear:** tabla `guardias`, tabla `supervisores`, tabla `conjuntos` paralela, repositorio SQL, auditoría genérica ni catálogo de tipos hasta que se decida configurabilidad. IDs de usuario y asignación existentes son suficientes.

## E. Estados y transiciones propuestas

```text
REPORTADO → EN_INVESTIGACION → EN_SEGUIMIENTO → RESUELTO → CERRADO
                 ↑                    │             │
                 └────────────────────┘             └→ EN_SEGUIMIENTO (retrabajo)
```

La línea principal es propuesta. Se propone permitir `EN_INVESTIGACION ↔ EN_SEGUIMIENTO` por nueva información y `RESUELTO → EN_SEGUIMIENTO` si la solución falla, siempre con motivo obligatorio. No se propone salto directo de `REPORTADO` a `CERRADO`. La reapertura de `CERRADO` **queda PENDIENTE**: cambia el significado del cierre y las reglas de retención.

| Transición | Actor propuesto | Condiciones y evento obligatorio |
|---|---|---|
| Creación → `REPORTADO` | Guarda asignado; supervisor asignado; admin de compañía, dentro de su ámbito | Compañía activa, contrato vigente, conjunto válido, tipo, ubicación, hora del hecho, descripción y prioridad; reportante desde sesión. Evento de creación. |
| `REPORTADO` → `EN_INVESTIGACION` | Supervisor del conjunto o admin de compañía | Responsable válido y activo; clasificación revisada. Evento de estado y asignación si ocurre en la misma operación. |
| `EN_INVESTIGACION` → `EN_SEGUIMIENTO` | Supervisor o admin; responsable si su rol ya lo permite | Responsable existente; al menos una observación de investigación/plan de seguimiento. Evento y texto. |
| `EN_SEGUIMIENTO` → `RESUELTO` | Supervisor o admin | Responsable, observación de resolución obligatoria, `resueltoEn` de servidor. Evento con antes/después y actor. |
| `RESUELTO` → `CERRADO` | Admin de compañía **propuesto**, por confirmar | Revisión final y observación de cierre; `cerradoEn` de servidor. Evento irreversible salvo política de reapertura decidida. |
| Retroceso permitido | Supervisor/admin según alcance | Motivo obligatorio; registrar estado anterior/nuevo, actor y hora; limpiar o conservar `resueltoEn` según política decidida antes de construir. |

No editar silenciosamente hechos anteriores tras cierre. Permitir solo anotaciones correctivas trazadas si se decide ese flujo. No usar `updatedAt` como sustituto del historial. Todas las transiciones y operaciones relevantes deben salir de mutaciones de dominio, no de un `patch` genérico.

## F. Prioridades y tipos

**Prioridad:** `BAJA`, `MEDIA`, `ALTA`, `CRITICA` como conjunto fijo de valores validados en Convex y compartidos con web/móvil. Es severidad operativa transversal; hacerla configurable por compañía dificultaría filtros, métricas y escalamiento. La novedad actual solo tiene baja/media/alta y en minúsculas: no convertir implícitamente; definir mapeo si algún día se enlaza o importa. Prioridad inicial sugerida `MEDIA`, confirmable por producto. Cada cambio requiere evento antes/después y razón si sube a `CRITICA` o baja de ella.

**Tipo:** proponer códigos estables iniciales `SEGURIDAD`, `ACCESO`, `HURTO_ROBO`, `DANO_PROPIEDAD`, `EMERGENCIA`, `CONVIVENCIA`, `ACCIDENTE`, `ALTERACION_ORDEN`, `PERSONA_SOSPECHOSA`, `VEHICULO`, `OTRO`, con etiqueta separada. Para primera versión, catálogo en código/validador o configuración compartida, siguiendo catálogos ya presentes en `model/roles.ts` y motivos configurables de vehículos en `guardia.ts`. Si cada compañía necesita agregar, desactivar, ordenar o renombrar tipos, se justifica una tabla `incidenteTipos` con `companiaId`, código estable, etiqueta y estado, **solo después de decidirlo**. No fijar enum rígido antes de esa decisión. Conservar etiqueta/código histórico al desactivar un tipo; no reescribir casos.

## G. Matriz inicial de permisos por rol

**Permisos actuales constatados (antes del módulo):**

| Rol actual | Compañía y personal | Conjunto e información operativa |
|---|---|---|
| `superadmin` / `admin` de plataforma | Las funciones de plataforma y `exigirAccesoCompania` les dan alcance maestro; no son administradores de una compañía concreta. | `resolverAcceso` les da todas las capacidades de vigilancia. Esta vía privilegiada debe quedar explícita en consultas de casos. |
| `admin_compania` | Miembros y datos de su compañía mediante `seguridad.personal`, asignaciones mediante `seguridad.asignar`, fin inmediato de contrato propio, inventario corporativo. | Lee portería del conjunto **solo si hay contrato vigente**; no recibe `porteria.operar`. |
| `supervisor` | Puede ver detalle de su compañía recortado a los conjuntos que supervisa; puede asignar personal bajo contrato de su compañía en ese ámbito. | `porteria.ver` e `inventario.custodiar` por asignación vigente de supervisor; no administra toda la compañía ni opera el turno por ese rol. |
| `guardia` corporativo | No accede al directorio de compañía ni al inventario corporativo. | `porteria.operar` y `porteria.ver` por asignación vigente; puede reportar novedad/minuta según las reglas específicas de esas funciones. |
| `guardia` propio del conjunto | No tiene compañía implícita. | Mismas capacidades de portería por `memberships.roles`, pero su dato no atribuye un caso a ninguna empresa. |

El alcance de `superadmin` y `admin` de plataforma es una característica existente, no un rol nuevo propuesto. La decisión de exponer casos corporativos al administrador del conjunto (`administrador` en `memberships`) permanece pendiente: hoy puede consultar operación de **su conjunto** mediante `porteria.ver`, pero eso no identifica a cuál compañía pertenecen casos cuando hay contratos solapados. [Capacidades](../packages/backend/convex/lib/vigilancia.ts), [resolución de acceso](../packages/backend/convex/model/acceso.ts), [detalle de compañía](../packages/backend/convex/companias.ts).

**Condiciones comunes:** sesión y `users.active`; compañía activa; actor de esa compañía; contrato vigente para nuevas operaciones; supervisor/guarda con asignación vigente en ese conjunto y en esa compañía. `admin_compania` puede actuar en conjuntos contratados por su empresa; supervisor solo en conjuntos supervisados; guarda solo en su conjunto y, para lectura, inicialmente los casos que reportó (alcance final pendiente). Superadmin y `admin` de plataforma tienen paso maestro en los helpers actuales, pero deben seleccionar el contexto de compañía del caso para evitar mezclar datos. Esta matriz **requiere capacidades nuevas** de incidentes en `lib/vigilancia.ts`; no se consigue dando `porteria.gestionar` ni `seguridad.personal`.

| Acción | Admin compañía | Supervisor | Guarda |
|---|---|---|---|
| Ver incidentes | Todos los de su compañía | Los de sus conjuntos | Propios del conjunto asignado (propuesta) |
| Crear incidente | Sí, conjunto contratado | Sí, conjunto asignado | Sí, conjunto asignado |
| Editar incidente | Sí, con historial; campos permitidos | Sí, en su conjunto | Solo corrección inicial limitada; definir ventana |
| Cambiar prioridad | Sí | Sí, en su conjunto | No |
| Asignar responsable | Sí | Sí, en su conjunto | No |
| Cambiar estado | Sí, según transición | Sí hasta `RESUELTO` | No |
| Agregar evidencia | Sí | Sí | Sí, en caso propio y abierto |
| Agregar involucrados | Sí | Sí | Sí, en caso propio y abierto |
| Registrar seguimiento | Sí | Sí | Sí, solo observación en caso propio abierto (propuesta) |
| Resolver | Sí | Sí, en su conjunto | No |
| Cerrar | Sí, propuesto | No, pendiente de decisión | No |
| Ver historial | Sí | Sí, en su conjunto | Sí, en caso visible |

El responsable se propone como `users` con membresía activa en la **misma compañía**; pueden ser admin o supervisor, y el supervisor debe cubrir ese conjunto. La posibilidad de responsabilizar a un guarda o a un admin sin asignación está pendiente. Un guarda propio del conjunto sin compañía no puede crear un caso corporativo hasta decidir a cuál empresa pertenece el caso. El administrador residencial del conjunto tampoco recibe acceso corporativo por ser administrador: decidir una vista compartida separada si producto la necesita.

**Histórico tras pérdida de vigencia:** el código actual corta acceso operativo inmediatamente al terminar contrato/asignación. Para incidentes, conservar datos no equivale a conceder acceso. Se propone bloquear escrituras y definir explícitamente quién conserva lectura histórica; decisión pendiente, especialmente para casos abiertos y transferencia de custodia.

## H. Integración UX

**Web de compañía:** añadir “Incidentes” en la sección Operación del `CompanyNavigationShell`, junto a “Mis conjuntos”, con vista de casos filtrada por compañía y filtros de conjunto, estado, prioridad, tipo, fecha, responsable. Ruta conceptual `/vigilancia/incidentes` y detalle `/vigilancia/incidentes/[id]`; la ficha de cada conjunto `/vigilancia/[condominioId]` puede enlazar a la lista prefiltrada. El admin conserva su ficha de personal/contratos/inventario en `/dashboard/companias/[id]`; no insertar allí un CRUD inconexo. Ajustar resaltado de navegación/breadcrumbs para que rutas de detalle sean reconocidas, pues hoy la navegación activa compara rutas exactas. [Navegación](../apps/web/components/vigilancia/company-navigation.tsx), [shell](../apps/web/components/vigilancia/vigilancia-shell.tsx), [supervisión](../apps/web/app/vigilancia/[condominioId]/page.tsx).

**Supervisor:** misma lista/detalle en el shell de vigilancia, con alcance del servidor restringido a sus asignaciones; entrada por conjunto y, si resulta útil, bandeja agregada de sus conjuntos. No llevarlo a `/guardia`, que es la experiencia de turno.

**Guarda:** una acción “Reportar incidente” separada de “Novedades” y “Minuta” en web `/guardia/[id]` y móvil Expo. Mostrar sus casos y estado en una vista simple; evitar que “Novedades” parezca el mismo flujo. El reporte actual puede seguir existiendo para actividad operativa/cobro; una conversión explícita futura debe enlazar origen sin cambiar el registro original. [Guardia web](../apps/web/components/guardia/guardia-shell.tsx), [guardia móvil](../apps/mobile/src/components/guardia/guardia-home.tsx), [reporte existente](../apps/web/components/guardia/novedad-modal.tsx).

**Reutilización UI:** `PageContainer`, `PageHeader`, `Card`, `Badge`, `Table`, `Input/Select`, `Modal`, `EmptyState`, `Skeleton`, `ErrorBoundary`; patrón de filtros y tablas de rondas; línea temporal visual de minuta/rondas e inventario; `AdjuntosPicker` y hook de subida como base de experiencia, tras adaptar política/metadata. Detalle con cabecera, datos del caso, responsable, evidencias, involucrados e historial paginado. No se encontró un componente universal de timeline o uploader con seguridad por entidad; la presentación puede reutilizar estilos, no prometer un componente inexistente.

## I. Evidencias y auditoría

### Infraestructura de archivo: hallazgos y trabajo necesario

- **Carga:** `files.generateUploadUrl` firma PUT S3 10 minutos; `files.uploadBytes` admite hasta 15 MiB y web cae a PUT firmado; móvil sube por el mismo endpoint. Hay Convex Storage legado en `documentos` y reportes, pero la práctica reciente es S3. [files.ts](../packages/backend/convex/files.ts), [upload-s3.ts](../apps/web/lib/upload-s3.ts).
- **Almacenamiento/metadata:** S3 usa key saneada y URL pública; `documentos` y adjuntos de soporte guardan MIME/nombre y a veces key/tamaño; `guardiaNovedadReportes` guarda URL/nombre y fotos, sin key/MIME/tamaño completos. `AdjuntosPicker` admite imágenes/PDF, 5 archivos, 10 MiB c/u en cliente. El modal de novedad valida 15 MiB aunque su etiqueta dice 20 MiB: límite inconsistente que no debe heredarse. [schema.ts](../packages/backend/convex/schema.ts), [adjuntos-picker.tsx](../apps/web/components/soporte/adjuntos-picker.tsx).
- **Acceso/eliminación:** `files.generateUploadUrl` permite a cualquier sesión elegir carpeta; `files.deleteObject` permite borrar cualquier key conocida por una sesión. La URL pública de S3 evita control de lectura por incidente. El saneamiento de carpeta evita rutas peligrosas, pero no autoriza tenant. Se necesita una ruta de subida/borrado vinculada a incidente y autorización comprobada, y decidir bucket privado/URL temporal/proxy para lectura. El cliente no debe poder fabricar una evidencia con una URL ajena. Borrado físico, retención y preservación forense siguen pendientes.
- **Flujo seguro propuesto:** obtener permiso de subida para un caso ya autorizado, limitar prefijo a compañía/caso desde servidor, validar MIME, tamaño, cantidad y key; registrar metadatos en una mutación que revalide caso y actor; servir solo a lectores autorizados; marcar retirada en metadata y evento sin perder referencia histórica. Resolver archivos subidos que no llegaron a asociarse. La garantía de tipo real del contenido, escaneo si aplica y política de privacidad requieren definición.

### Historial

`minutaEventos` registra actividad de portería por conjunto y no tiene compañía ni identidad de caso. `inventarioNovedades` sí demuestra el patrón adecuado: helper único, append-only, tipo controlado, diferencias antes/después, actor ID/nombre y consulta por índice. Adoptar ese patrón en `incidenteEventos`, dentro de la misma transacción que actualiza el caso. No reescribir ni borrar eventos. Guardar snapshots legibles de tipo/responsable si sus nombres cambian. Paginar por `incidenteId` y orden de creación; definir empates temporales mediante `_creationTime`/ID o secuencia si el orden estricto importa. Registrar tanto cambios de estado/prioridad/asignación como observaciones, personas y evidencias. Las métricas deben contar casos de `incidentes`, no entradas de minuta (hoy la UI llama “incidentes” a algunas novedades operativas). [minuta.ts](../packages/backend/convex/model/minuta.ts), [inventarioNovedad.ts](../packages/backend/convex/model/inventarioNovedad.ts), [guardia.ts](../packages/backend/convex/guardia.ts).

## J. Riesgos y decisiones pendientes

`DECIDIDA` significa comprobada en el sistema o fijada por el objetivo de esta fase. `PROPUESTA` describe una opción técnica aún por aprobar. `PENDIENTE` bloquea una parte del diseño o su política.

| Estado | Decisión | Impacto técnico |
|---|---|---|
| DECIDIDA | Una compañía jamás ve/modifica incidentes de otra; minuta y caso son objetos distintos. | `companiaId` en caso/hijos, guardas backend por par empresa/conjunto, pruebas de dos compañías en un mismo conjunto. |
| DECIDIDA | Identidad de guardas/supervisores en `users`; compañía, contrato y asignación existentes. | No crear tablas de personal duplicadas; mantener snapshots históricos. |
| DECIDIDA | El contrato y asignación vigentes cortan el acceso operativo actual; puede haber empresas solapadas en un conjunto. | Autorizar cada operación; no inferir empresa por `condominioId`. |
| PROPUESTA | Admin de compañía cierra; supervisor resuelve; guarda reporta y agrega datos a sus casos. | Capacidades nuevas y transiciones diferenciadas. |
| PENDIENTE | ¿Quién puede cerrar, y requiere validación del administrador residencial? | Política de cierre y visibilidad externa. |
| PENDIENTE | ¿Puede reabrirse `CERRADO`? ¿Retrocesos desde `RESUELTO`? | Grafo de estados, timestamps y eventos; inmutabilidad. |
| PENDIENTE | ¿Qué ocurre con casos abiertos e histórico cuando termina contrato, empresa se suspende o cambia la compañía? | Continuidad operativa, lector histórico y posible transferencia explícita sin cruzar tenants. |
| PENDIENTE | ¿Puede cambiarse el conjunto o la compañía del caso? Se propone no hacerlo; corregir mediante caso nuevo/enlace. | Integridad de índices, evidencia, historial y aislamiento. |
| PENDIENTE | ¿Responsable admin, supervisor o ambos? ¿Guarda asignable? ¿Qué pasa cuando deja la empresa? | Validación de elegibles, reasignación y snapshots. |
| PENDIENTE | ¿Guardia propio del conjunto y administración residencial pueden crear/ver casos corporativos? | Atribución de compañía y posible vista compartida independiente. |
| PENDIENTE | ¿Tipos personalizados por compañía? ¿Quién los administra? | Catálogo en código frente a tabla e índices; conservación de nombres históricos. |
| PROPUESTA | Prioridades fijas y `CRITICA` agregada al caso. | Validador estable, filtros y reglas de escalamiento; no reutilizar enum de novedad de portería. |
| PENDIENTE | ¿Evidencias pueden retirarse o borrarse físicamente? ¿Por cuánto tiempo? ¿Quién las ve? | S3 privado/acceso firmado, retención, soft delete y auditoría. Bloquea una implementación segura de evidencias. |
| PENDIENTE | ¿Datos de involucrados: documento, consentimiento, retención, tipos, acceso? | Estructura y protección de datos personales. |
| PENDIENTE | ¿SLA/fecha límite, alertas por `CRITICA` y escalamiento? | Campos, índices, jobs/notificaciones; no agregar hasta acordar. |
| PENDIENTE | ¿Qué es inmutable tras cierre y cómo se corrige un dato errado? | Permisos de edición, eventos correctivos y política de evidencia. |
| PENDIENTE | ¿Convertir reportes de `guardiaNovedadReportes` existentes a casos? | Sin `companiaId`, la atribución histórica no es segura; requerir conversión explícita verificada y enlace, no migración automática. |
| PENDIENTE | Alcance del guarda: solo propios o todos los casos de su conjunto; plazo para corregir reporte. | Filtros/índices y exposición de datos sensibles. |

**Riesgo inmediato de seguridad:** la infraestructura S3 pública y sus acciones genéricas están diseñadas para otros módulos. Reutilizar su transporte sin una capa de autorización específica expondría evidencia a quien conozca la URL/key. Esta observación no modifica la infraestructura existente en esta fase.

## K. Plan técnico de implementación posterior

1. **Cerrar decisiones de producto y privacidad:** responsables/cierre/reapertura, acceso histórico tras fin de contrato, acceso de guardia y conjunto, retención y visibilidad de archivos, tipos configurables, SLA. Especificar invariantes y ejemplos de dos compañías concurrentes.
2. **Diseño de API y autorización:** definir capacidades de incidentes en `lib/vigilancia.ts`, helper que valide compañía/conjunto desde el caso, matriz efectiva y pruebas de roles/tenants. Alinear nombres de errores y contexto de sesión.
3. **Persistencia Convex:** agregar solo las tablas acordadas (`incidentes`, eventos, evidencias, personas), validadores e índices dirigidos a consultas; funciones de lista/detalle y paginación. No tocar tablas de minuta/reportes salvo un enlace opcional aprobado.
4. **Ciclo de vida e historial:** mutaciones atómicas de reportar, clasificar, asignar, cambiar prioridad, seguimiento, resolver/cerrar; helper append-only; pruebas de transición, permisos, carrera/reintento y actor histórico.
5. **Archivos:** definir almacenamiento privado/autorizado, límites y verificación de metadata; usar transporte S3 y componentes existentes solo tras asegurar subida, lectura y retiro. Probar keys ajenas, enlaces y acceso después de terminar contrato.
6. **UX web:** bandeja y detalle en shell de vigilancia para admin/supervisor; reporte y consulta acotada para guarda; filtros, estados y timeline. Mantener “Minuta” y “Novedades” operativas como flujos separados.
7. **UX móvil y cierre operativo:** reporte simple del guarda y consulta de estado; pruebas de integración entre web/móvil, accesibilidad, paginación, métricas, errores y observabilidad. Activar solo cuando se cumplan los escenarios de aislamiento y evidencia.

### Criterios de aceptación previos al desarrollo

- El mismo `condominioId` con dos contratos vigentes no permite leer ni mutar caso/evidencia/historial de la otra empresa.
- Al terminar asignación/contrato o suspender compañía, se corta la escritura inmediatamente; el acceso histórico responde a la política aprobada.
- Crear, cambiar prioridad, asignar, resolver y cerrar dejan evento inmutable con actor y valores anteriores/nuevos en la misma transacción.
- La minuta sigue siendo bitácora operativa; un caso puede vincularse, pero no se reconstruye desde ella.
- Ninguna evidencia se publica o borra por conocer una URL/key sin autorización del caso.

