# Fase 6 — Dashboard operativo y métricas de Incidentes

## Resultado y ubicación

Ruta: `/vigilancia/incidentes/dashboard`, dentro del layout y la navegación existente de compañía. Se abre desde el botón **Dashboard** de la bandeja. El breadcrumb conserva Vigilancia → Incidentes → Dashboard.

La pantalla incluye:

- Filtros de periodo, conjunto autorizado, estado, prioridad y tipo exacto registrado.
- Cuatro tarjetas: total, activos, resueltos y cerrados. Investigación y seguimiento se consultan en la distribución de estados para evitar tarjetas redundantes.
- Distribuciones por estado y prioridad con `DonutChart`, valores y enlaces accesibles.
- Distribuciones por tipo y conjunto con barras y cantidades; diez categorías iniciales y expansión explícita. Se conservan todas las categorías recibidas, incluidas las históricas desconocidas.
- Evolución temporal con `AreaChart`, etiquetas espaciadas y alternativa textual con valores y enlaces por intervalo, incluidos los ceros.
- Atención operativa: acceso a activos críticos/altos, cantidad de activos con antigüedad de siete días y hasta cinco casos activos para abrir su ficha.
- Tiempo medio de resolución, tamaño de muestra y exclusiones por fecha ausente o inválida.

Se reutilizan PageContainer, PageHeader, Card, Button, Badge, Input, Select, Skeleton, EmptyState y ErrorBoundary. El campo de formulario se comparte con la bandeja. Los gráficos existentes incorporan opciones de presentación compatibles con sus consumidores previos: ocultar la leyenda cuando ya existe una lista de enlaces y espaciar etiquetas temporales conservando el tooltip completo.

En móvil las tarjetas y gráficas se apilan; las cuadrículas se amplían en tablet/escritorio. Los filtros permanecen visibles, las categorías largas pueden partirse y no se exige desplazamiento horizontal. Las cantidades, nombres, porcentajes y estados se presentan como texto; el color no es la única vía de lectura. Los SVG son complementos visuales y la alternativa textual permanece disponible para teclado y lectores de pantalla.

## Auditoría y reutilización

Se revisaron `convex/incidentes.ts`, `model/incidenteAcceso.ts`, `model/incidenteEvento.ts`, `model/acceso.ts`, las capacidades de vigilancia, el esquema y sus índices, las fechas y transiciones, las rutas web/guardia, la bandeja, sus filtros y los gráficos existentes.

La bandeja ya aplicaba autorización por compañía/conjunto/reportante y filtraba antes de paginar. Se extrajeron sus mismas reglas a `exigirAlcanceBandeja`, `obtenerContextoBandeja` y `model/incidenteConsulta.ts`; las usan la bandeja y la analítica. Las mutaciones, evidencias, personas, responsables, historial append-only y ciclo de vida conservan su semántica.

`ESTADOS_INCIDENTE` y `ESTADOS_ACTIVOS` residen en `convex/lib/incidentes.ts`. El validator del dominio y las opciones web utilizan la lista compartida. La métrica activa, la consulta normal y la referencia exacta utilizan esa misma definición. No hay estados analíticos adicionales ni scoring de prioridad.

## Fechas y periodos

El criterio de inclusión es exclusivamente **fecha de reporte (`reportadoEn`)**, porque mide la carga que ingresa a la operación. `ocurrioEn` conserva su significado de fecha del hecho y no interviene en estas métricas. Todas las métricas corresponden a la misma cohorte de reportes y sus filtros; los estados son los **estados actuales**, no reconstrucciones del estado al final del periodo.

Se implementan hoy, últimos 7 días, últimos 30 días, este mes, mes anterior y periodo personalizado. Los últimos N días incluyen hoy y los N−1 días previos. Este mes llega hasta el final de hoy; mes anterior incluye el mes civil completo. Personalizado incluye ambos días completos.

Los límites son días civiles de Colombia, UTC−5: desde 00:00:00.000 del primer día hasta 23:59:59.999 del último. Son inclusivos. Se validan fechas civiles inexistentes, límites invertidos, periodos desconocidos y rangos mayores de 5 × 366 días. El máximo se establece para acotar los intervalos de esta primera consulta, no como política de retención; se puede consultar cualquier fecha histórica dentro de un rango permitido.

La granularidad es diaria hasta 31 días; semanal hasta 180 días; mensual para rangos mayores. Las semanas se anclan al inicio del periodo y comprenden hasta siete días; los meses respetan límites civiles, con posibles extremos parciales. Se generan como máximo 61 puntos para el rango permitido. Cada intervalo conserva sus límites exactos en backend, y se puede abrir la bandeja con sus fechas equivalentes.

La navegación desde el dashboard fija `fecha=reportadoEn`, `zona=America/Bogota`, `desde` y `hasta`. La bandeja comparte la conversión de días y conserva la zona al aplicar filtros. La bandeja abierta por otras rutas mantiene su interpretación previa de fechas locales. Los reportes mostrados en el dashboard y la bandeja contextual se formatean en Colombia.

## Definiciones de métricas

Fuente común: documentos reales de `incidentes`, dentro de la compañía y los conjuntos/reportantes autorizados, seleccionados por `reportadoEn` en el periodo y por conjunto, estado, prioridad y tipo. No se cuentan evidencias ni eventos como incidentes adicionales.

| Métrica | Definición y fórmula |
| --- | --- |
| Total | Número de incidentes coincidentes con el alcance, periodo y filtros. |
| Activos | Número de esos incidentes cuyo estado actual es REPORTADO, EN_INVESTIGACION o EN_SEGUIMIENTO. RESUELTO y CERRADO no se incluyen. |
| Resueltos | Número cuyo estado actual es RESUELTO. No incluye casos actualmente cerrados. |
| Cerrados | Número cuyo estado actual es CERRADO. |
| Por estado | Conteo por cada estado del dominio; su suma es el total. |
| Por prioridad | Conteo por BAJA, MEDIA, ALTA y CRITICA, sin reinterpretar valores; su suma es el total. |
| Por tipo | Conteo por valor textual exacto almacenado. Las sugerencias del formulario solo aportan etiquetas de presentación cuando coinciden. |
| Por conjunto | Conteo por `condominioId`; el nombre se consulta en servidor después de agregar los documentos autorizados. Orden descendente por cantidad, desempate por nombre. |
| Por intervalo | Conteo de `reportadoEn` dentro de cada intervalo inclusivo. Se incluyen intervalos con cero y la suma es el total. |
| Porcentaje de categoría | `100 × cantidad / total filtrado`, redondeado a entero para presentación. Los porcentajes redondeados pueden no sumar exactamente 100. |
| Activos con antigüedad | Activos cuyo `ahora − reportadoEn >= 7 × 86.400.000`. Solo casos de la cohorte seleccionada; no pretende mostrar todo el backlog fuera del periodo. El umbral se centraliza en `ANTIGUEDAD_ACTIVA_DIAS`, modificable en código. |
| Casos relevantes | Hasta cinco activos del periodo, ordenados por prioridad existente CRITICA → ALTA → MEDIA → BAJA, luego por reporte más antiguo y referencia como desempate. Es una selección operativa explícita, sin puntaje ni etiqueta de riesgo. |
| Tiempo de resolución | Media aritmética de `resueltoEn − reportadoEn` entre incidentes de la cohorte cuyo estado actual es RESUELTO o CERRADO y cuya fecha de resolución es finita y no anterior al reporte. Se presenta en horas, con muestra y excluidos. |

El tiempo de resolución corresponde a la **última resolución vigente**. La transición existente RESUELTO → EN_SEGUIMIENTO elimina `resueltoEn`; el caso sale de la muestra hasta volver a resolverse. `cerradoEn` no interviene. No se calcula tiempo hasta cierre, primera resolución histórica, tiempo laboral, SLA ni resolución de casos cuyo reporte está fuera de la cohorte. Sin muestra válida se muestra ese hecho, no cero horas.

La antigüedad se evalúa en el instante de la consulta backend. Las consultas son reactivas a cambios de datos; no se incorpora un temporizador, cron ni automatización para refrescar por el mero paso del tiempo. Recargar la página vuelve a evaluar la fecha relativa y la antigüedad.

## Seguridad y alcance

No se crea ninguna capacidad nueva. Se utiliza `incidentes.ver` y la misma cadena existente de sesión, membresía, compañía activa, contrato y asignación aplicable al rol.

- Administrador: toda su compañía, incluido el histórico después de terminar el contrato, como la bandeja. Seleccionar un conjunto mantiene el filtro de compañía.
- Supervisor: únicamente conjuntos de sus asignaciones vigentes y contratos autorizados. La selección de conjuntos llega autorizada desde backend.
- Guarda: el shell existente de `/vigilancia` continúa reservado a administrador/supervisor. No se amplía su acceso a la pantalla de compañía. Si llama directamente a la consulta analítica, solo recibe sus propios reportes dentro de cada asignación autorizada, utilizando el mismo índice y filtro por reportante de la bandeja. Su experiencia de guardia permanece intacta.
- Sin membresía o sin alcance: la consulta devuelve ausencia de alcance, distinguible del agregado válido con total cero. Los rechazos de sesión o autorización se capturan en los boundaries.

La consulta `incidentes.dashboard` **no acepta compañía del cliente**: la obtiene de la membresía de la sesión. Cada recorrido de incidentes empieza por un índice cuyo prefijo contiene esa compañía. Para personal se autoriza cada conjunto antes del recorrido, y en guardia se añade `reportadoPorUserId` al prefijo. El agregado nunca recibe documentos de otra compañía.

Se añadió una opción explícita de bandeja `todosMisConjuntos` para que un total agregado del supervisor pueda abrir exactamente su unión autorizada. El servidor obtiene los ámbitos mediante el mismo helper; no confía en una lista enviada por frontend. Cada ámbito conserva su filtro de reportante cuando el acceso es de guarda. La ruta habitual continúa seleccionando un conjunto por defecto. La búsqueda por referencia, búsqueda textual y consulta paginada respetan también la unión. No aumenta las capacidades ni permite conjuntos nuevos.

Por tanto, dos compañías en el mismo conjunto usan prefijos distintos y no comparten totales, porcentajes, tipos, resolución, evolución, selección de casos ni volumen por conjunto. Una prueba compara el agregado completo antes y después de insertar casos de la otra compañía y exige igualdad exacta.

## Navegación y estado de URL

Tarjetas, categorías y periodos abren la bandeja existente con filtros equivalentes. Las fichas conservan el retorno a esa bandeja. El parámetro `dashboard` guarda únicamente el contexto de filtros para ofrecer **Volver al dashboard**; no contiene documentos, evidencias, información de personas ni tokens. Los periodos y filtros del dashboard son compartibles mediante URL.

Supervisor sin conjunto seleccionado abre `alcance=mis-conjuntos`; supervisor con un conjunto único lo fija automáticamente. La distribución por conjunto siempre puede abrir una bandeja específica. Los enlaces de activos críticos/altos aplican directamente estado y prioridad en el dashboard, desde donde se puede abrir la bandeja.

Se distinguen carga, resultado, ausencia de datos, ausencia de autorización y error. Durante la carga no se renderizan métricas con ceros. Los errores conservan los filtros y permiten reintentar; los mensajes de usuario no exponen trazas internas.

## Consultas, índices y rendimiento

Se incorpora una sola query pública: `incidentes.dashboard`. Devuelve agregados y una proyección de hasta cinco casos; el navegador no descarga expedientes para calcular el dashboard. Se reutiliza `incidentes.contextoBandeja` para opciones de ámbito.

La consulta recorre documentos por índice y acumula conteos en servidor, sin mantener una copia de todos los expedientes. Se usa iteración incremental, sin múltiples `paginate` dentro de una función Convex. Prioridad y tipo se filtran mediante el predicado compartido con referencia exacta; el estado también puede restringir el índice existente.

Índices de incidentes utilizados por la analítica:

- `by_compania_reportado`: compañía y rango de reportes.
- `by_compania_estado_reportado`: compañía, estado concreto y rango.
- `by_compania_condominio_reportado`: compañía, conjunto y rango.
- `by_compania_condominio_estado_reportado`: compañía, conjunto, estado y rango.
- `by_compania_condominio_reportante`: compañía, conjunto, reportante y rango para guardas.

El contexto reutiliza `companiaMiembros.by_user`, `companiaContratos.by_compania` y `asignaciones.by_user`, además de las comprobaciones existentes de contrato/asignación. La bandeja mantiene sus índices por `ocurrioEn` y búsqueda textual. Para la unión de conjuntos del supervisor, la bandeja usa el índice de compañía/fecha y filtra los ámbitos autorizados antes de paginar, conservando sus límites previos de 300 filas/2 MB por solicitud.

No se añaden índices, tablas de agregados, cachés ni infraestructura analítica. Las distribuciones por conjunto y tipo se ordenan en servidor. La selección de cinco activos se mantiene acotada durante el recorrido. La serie temporal se calcula en backend.

La analítica limita el recorrido total a 5.000 documentos y aproximadamente 6 MB de documentos serializados, centralizados en `MAX_INCIDENTES_ANALITICA` y `MAX_BYTES_ANALITICA`. Se cuenta lo leído antes de filtrar prioridad/tipo para que un filtro sin coincidencias no produzca una lectura ilimitada. Si se supera un límite, falla la consulta completa: nunca se entregan porcentajes o totales parciales. La UI pide reducir el periodo o elegir un conjunto. Los límites propios de Convex también pueden provocar un error capturado.

La evolución posterior debe basarse en volúmenes/costos reales: medir consultas amplias y cantidad de conjuntos, y evaluar índices adicionales, paginación analítica o agregados únicamente si la lectura simple deja de ser adecuada.

## Verificación técnica

| Comprobación | Resultado |
| --- | --- |
| Nuevas pruebas backend | 30 aprobadas en `pruebas/incidentesFase6.test.ts`: tenants compartidos, histórico, supervisor con múltiples conjuntos, guarda, vigencias, cohortes, límites temporales, filtros combinados, tipos históricos, conteos, antigüedad, resolución/reapertura, granularidad y límite de lectura. |
| Suite backend completa | 284 unitarias + 548 de seguridad/integración aprobadas, 832 en total. |
| Nuevas pruebas frontend | 15 aprobadas: dashboard montado con Happy DOM y eventos, carga, indicadores, filtros, periodos, URL, errores y reintentos, falta de datos/alcance, estructura responsive, listas extensas y recorrido real entre componentes dashboard y bandeja. |
| Suite frontend de Incidentes | 46 aprobadas: 18 anteriores + 13 de Fase 5 + 15 de Fase 6. Los archivos se ejecutan en procesos separados para aislar mocks. |
| Typecheck web y backend | Aprobados. |
| Typecheck global | Persiste el error previo de móvil en `packages/backend/convex/auth.ts:34`, TS7006, parámetro `s` con `any` implícito. Archivo sin modificar. |
| Build global | Aprobado; Next 16 genera `/vigilancia/incidentes/dashboard`. |
| `git diff --check` | Aprobado. |
| Lint web | Persiste `next lint`: Next 16 interpreta `apps/web/lint` como directorio inexistente. Pipeline sin modificar. |

El sandbox impidió inicialmente a esbuild resolver la configuración y al build descargar Inter/Poppins de Google Fonts. Se repitieron las comprobaciones con acceso autorizado, conservando los scripts y fuentes del proyecto.

Las pruebas frontend verifican DOM, interacción y estructura responsive; no son una sesión autenticada en un navegador contra un Convex desplegado ni una validación visual en dispositivos físicos. Las pruebas backend usan convex-test con queries/mutaciones reales y base simulada. No se despliega ni modifica información de una cuenta real.

## Decisiones posteriores

- Validar con volumen real si los límites de lectura y la consulta de unión de conjuntos requieren una optimización adicional.
- Si se solicita estado al cierre de un periodo, primera resolución o métricas por fecha de resolución, definir cohortes y reconstrucción histórica aparte. Esta fase mide reportes del periodo y estado actual.
- Si se requiere actualización por paso del tiempo sin recargar, acordar la frecuencia de refresco y su costo antes de incorporar un mecanismo.
- Cualquier experiencia analítica adicional para guardas debe acordarse sin ampliar implícitamente el alcance de lectura existente.
- Reportes, PDF, Excel/CSV, SLA configurable, notificaciones, automatizaciones, alertas, catálogos configurables y retención/eliminación permanecen fuera de esta fase.
