# Incidentes: bandeja operativa y gestión del caso (fase 4)

## Auditoría de las fases 2 y 3

Se revisaron `convex/incidentes.ts`, `model/incidenteAcceso.ts`, `model/incidenteEvento.ts`, `lib/incidentes.ts`, el esquema, las rutas de compañía y guarda, el formulario de creación, la vista inicial y sus pruebas.

- Ya existían creación atómica con personas iniciales, lectura del incidente, personas e historial paginado; corrección de datos, clasificación, prioridad, responsable, estados, seguimiento y alta de personas.
- La entrada principal solo ofrecía registrar. La ficha solo mostraba los datos iniciales y personas. `listar` ya paginaba por compañía, pero rechazaba combinar conjunto y estado; no tenía búsqueda, prioridad, tipo ni periodo.
- No existen mutaciones para editar o retirar personas. El tipo sigue siendo texto acotado: las opciones del formulario son sugerencias de presentación, no un catálogo de dominio.
- El guarda consulta solo sus reportes y puede agregar personas; no gestiona ni registra seguimiento. El supervisor gestiona en su asignación vigente; solo el administrador de compañía (o plataforma según el dominio existente) cierra.

## Implementación

- Se mantienen `/vigilancia/incidentes`, `/guardia/[id]/incidentes`, sus rutas `/nuevo` y `/[incidenteId]`. Ambas entradas comparten bandeja y ficha. La creación y sus mutaciones conservan su comportamiento.
- `listar` se amplía con búsqueda, estado/activos, prioridad, tipo, conjunto, fechas de reporte/hecho y orden ascendente/descendente. Devuelve una proyección para tarjetas sin descripción ni resolución. Los nombres de conjuntos se resuelven una vez por conjunto de la página, sin consultas cliente por fila.
- Se añaden dos queries necesarias: `contextoBandeja` devuelve los ámbitos de lectura y creación; `responsablesDisponibles` ofrece candidatos del incidente. Las reglas de responsable se extraen sin cambios a `exigirResponsableIncidente`, compartido por selección y asignación.
- `obtener` incorpora permisos y transiciones derivados de la autorización y del único mapa del ciclo de vida en el backend. Cada mutación vuelve a validar acceso y transición. No se mantiene un segundo ciclo de vida en cliente.
- La ficha presenta información actual, resolución, responsables, personas y timeline de `incidenteEventos` como bloques separados. El historial carga 30 eventos por solicitud y permite consultar anteriores. Nunca se reconstruye a partir del documento actual.
- Seguimiento, prioridad, asignación, alta de personas y cambios de estado usan las mutaciones existentes. Motivo y observación de resolución se envían al servidor; actor, fechas e historial atómico siguen determinados allí. Cierre y resolución tienen explicaciones y confirmaciones distintas.

## Decisiones de UX y consultas

- La vista predeterminada muestra **activos** (reportados, investigación y seguimiento), por reporte más reciente. Resueltos/cerrados se consultan con Todos o un estado concreto. No se inventa una puntuación ni se reordena una compañía completa en navegador.
- La búsqueda permite elegir ubicación, descripción o referencia completa exacta. Ubicación y descripción utilizan índices full text de Convex con compañía y los filtros de igualdad aplicables dentro del índice; se ordenan por relevancia. Referencia utiliza acceso por ID y comprueba toda la combinación de criterios antes de devolver la proyección. No se expone un caso de otra compañía.
- Se agregan índices por fecha del hecho para compañía, conjunto y reportante, además del índice conjunto/estado/reporte. Los rangos de fecha se aplican al índice elegido cuando no hay texto. Otros criterios se evalúan en el servidor **antes** de paginar, sin filtrar páginas descargadas.
- No hay un dato de volumen real disponible en el repositorio. La bandeja pide 20 filas y el backend limita la petición a 50. Para consultas ordinarias se fija un presupuesto de 300 filas leídas y 2 MB por solicitud. Un tramo sin coincidencias puede conservar un cursor: se ofrece continuar, sin afirmar que la búsqueda completa esté vacía. Se probó ese caso con más de 300 registros. Las búsquedas full text usan paginación y los límites propios de Convex; su presupuesto de lectura no tiene la misma garantía que un índice ordinario.
- Se conserva la consulta de **un conjunto a la vez** para supervisores/guardas. El administrador consulta todos los conjuntos de su compañía, incluyendo el histórico tras terminar un contrato. Los ámbitos históricos se identifican y no habilitan gestión ni creación.
- Tipo ofrece las sugerencias soportadas por el registro y acepta el valor textual exacto de casos clasificados desde el backend; no agrega configuración de tipos.
- Búsqueda, filtros, cursor y selección se mantienen en la URL. Aplicar filtros elimina el cursor anterior. Volver desde la ficha recupera la página y enfoca la tarjeta si aún coincide. La paginación ofrece Siguiente y Primera página.
- Tarjetas en móvil y escritorio conservan tipo, prioridad, estado, conjunto y ambas fechas. Conjunto, tipo y fechas se agrupan en un desplegable para que la bandeja móvil no quede desplazada por todos los controles.
- Se distinguen loading, ausencia de alcance, ausencia de incidentes, ausencia de coincidencias y error. Para distinguir los dos vacíos se consulta una sola fila sin filtros, únicamente cuando la primera página filtrada está vacía y agotada. Los errores utilizan los boundaries de Vekino; los errores de mutación conservan el formulario y no exponen trazas.

## Autorización y auditoría

Toda lectura empieza por una compañía autorizada y, para personal asignado, por el conjunto vigente. Los índices y búsquedas incluyen compañía; el guarda incluye también reportante. `exigirIncidente` protege ficha, personas e historial y obtiene los tenants del documento almacenado. `exigirAccesoIncidente` conserva la validación de compañía activa, conjunto, contrato, rol y asignación.

La UI recibe permisos del mismo helper y solo presenta acciones autorizadas, sin sustituir la validación en la mutación. No se agregan transiciones, reapertura de cerrado, usuarios globales, escritura sobre eventos existentes ni campos de identidad elegidos por el cliente.

## Verificación

- 8 nuevas pruebas backend: filtros combinados, búsquedas/ID y aislamiento, paginación/orden, vacíos/activos, presupuesto de lectura, permisos/transiciones, candidatos/vigencia y seguimiento con actor/hora de servidor. El módulo tiene 25 pruebas de integración.
- 8 nuevas pruebas frontend: composición y argumentos enviados al servidor, navegación/cursor, vacíos/loading, alcance de ruta del guarda, propagación de errores a boundaries, campos obligatorios de transición, ficha/historial y cerrado/solo lectura. Suite frontend: 18 pruebas.
- Suite backend: 284 unitarias y 490 de integración/seguridad (20 archivos), todas aprobadas. La verificación final usa `bun run --cwd packages/backend test:seguridad -- --maxWorkers=2`; una ejecución concurrente con el build agotó hooks de preparación de otros módulos, resuelto al repetir sin build y con dos workers, sin modificar la configuración.
- Typecheck de web y backend: aprobado. El comando global también comprueba mobile y falla en `convex/auth.ts:34` por un parámetro `s` con `any` implícito; ese archivo no se modifica en esta fase.
- Build de Next: aprobado con acceso a Google Fonts. El primer intento restringido falló al descargar Inter/Poppins; no se cambió la configuración de fuentes.
- Rutas verificadas en el build. Revisión visual de componentes reales renderizados con datos sintéticos y CSS de producción a 390 y 1280 px, sin desbordamiento horizontal. La ruta real lleva al login cuando no hay sesión. No se realizó una sesión completa contra datos desplegados/autenticados.
- `git diff --check`: aprobado.
- Lint: sigue pendiente el script `next lint`, que Next 16 interpreta como un directorio inexistente. No se refactoriza el pipeline.

## Despliegue y pendientes

Los índices nuevos deben publicarse con el despliegue habitual de Convex antes de publicar el frontend. No hay campos nuevos que requieran migrar los incidentes existentes; los índices de búsqueda usan ubicación y descripción ya almacenadas. Esta tarea no despliega a producción.

Edición/retiro de personas y política de responsable dado de baja siguen pendientes del dominio. No se implementan evidencias privadas, fotografías, archivos, dashboard, reportes, exportaciones, métricas, SLA, notificaciones ni configuraciones avanzadas.
