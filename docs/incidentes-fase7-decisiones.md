# Fase 7 — Reportes operativos y exportación de Incidentes

## Reportes

Ruta: `/vigilancia/incidentes/reportes`, dentro del shell existente de compañía. Se accede mediante **Reportes** en la bandeja y **Generar reporte** en el dashboard. No se añade una experiencia de reportes al módulo de guardia.

La pantalla utiliza los mismos controles de periodo, conjunto, estado (incluido ACTIVOS), prioridad y tipo exacto del dashboard. El formulario se comparte en `incidentes-filtros-reporte.tsx`; se mantienen etiquetas, teclado, diseño adaptable y boundaries con reintento sin perder filtros. Antes de exportar deben aplicarse los cambios pendientes del formulario.

El resumen incluye periodo, conjunto, filtros efectivos, total, activos, resueltos y cerrados. Los valores se calculan exclusivamente en backend mediante `obtenerAnaliticaIncidentes`, la misma función del dashboard. No se incorpora un contador ni una interpretación de métricas en la UI.

La tabla presenta hasta 50 incidentes recientes: referencia, fecha de reporte, fecha del hecho, conjunto, tipo, prioridad, estado, responsable y ubicación. Indica cuántos de los resultados muestra y ofrece **Consultar todos en la bandeja**, con filtros y unión autorizada equivalentes. La referencia abre la ficha existente y conserva el retorno a la bandeja contextual. La región de tabla admite teclado y desplazamiento horizontal en móvil; tiene caption y encabezados semánticos.

Los periodos reutilizan `periodoIncidentes`, con `reportadoEn` como cohorte, días civiles de `America/Bogota` y estados actuales. Se preservan hoy, 7 días, 30 días, este mes, mes anterior y personalizado, incluidos sus límites inclusivos y validaciones. Dashboard → reporte fija las fechas concretas resueltas en servidor y conserva conjunto/estado/prioridad/tipo; aparece como periodo personalizado para evitar que un cambio de día cambie la cohorte durante la navegación. La exportación fija también los días del resumen visible.

Se reproducen parámetros y alcance vigente, no un snapshot histórico persistente: cada generación vuelve a autorizar y consultar los datos. Una modificación concurrente del incidente puede cambiar su estado o los resultados entre consulta y descarga. La UI explica esta característica.

## Auditoría y reutilización

Se revisaron `convex/incidentes.ts`, `model/incidenteConsulta.ts`, `model/incidenteAnalitica.ts`, `model/incidenteAcceso.ts`, constantes y fechas del dominio, índices, rutas de bandeja/dashboard/ficha/guardia, shell de compañía, tablas, descargas y dependencias.

El producto ya genera CSV y Excel en reservas/parqueaderos. `excel-reporte.ts` y `excel-simple.ts` producen OOXML con JSZip, estilos, textos y tablas de Excel. Se añadió una función compatible de dos hojas a `excel-reporte.ts`; los consumidores anteriores conservan sus funciones y comportamiento. La suite unitaria que cubre esos generadores sigue aprobada, y el libro de incidentes se abrió adicionalmente con openpyxl.

Existen documentos PDF de asamblea y auditoría mediante `pdf-lib`, además del tratamiento de facturas en Next. Por ello se reutiliza esa dependencia para un PDF operacional sencillo en el servidor web, sin introducir un motor documental ni ejecutar PDF/ZIP dentro de Convex. La descarga mantiene la convención Blob/enlace/object URL del producto.

No existe una auditoría genérica adecuada para generación de archivos. `incidenteEventos` exige un incidente concreto y documenta cambios en su expediente; un reporte puede abarcar muchos incidentes sin modificarlos. No se añade `REPORTE_GENERADO` a ese historial ni se crea otra tabla. La auditoría de generación queda pendiente de una definición transversal posterior.

## Exportaciones

`POST /api/incidentes/reporte` recibe únicamente formato y parámetros de filtros. Utiliza `fetchAuthQuery` con la sesión Better Auth y la query `incidentes.reporte` en modo exportación. No recibe filas, compañía, actor, totales ni listas de conjuntos del navegador. El servidor genera el archivo completo y devuelve Content-Disposition, MIME apropiado, `private, no-store` y `nosniff`.

- **CSV:** UTF-8 con BOM, separador coma, CRLF, encabezados estables y escape de comillas/saltos de línea. Las celdas textuales que pueden interpretarse como fórmulas se neutralizan con apóstrofo. El contexto se repite en columnas al final de cada fila, conservando una cabecera tabular válida: generación, periodo desde/hasta y filtros de conjunto/estado/prioridad/tipo. No se antepone un preámbulo incompatible con lectores CSV.
- **Excel:** hoja **Resumen** con periodo, filtros, generación oficial y cuatro indicadores; hoja **Incidentes** con la tabla completa. Se reutilizan estilos, tablas, cadenas compartidas, filtros y títulos de impresión. Los textos se almacenan como texto, nunca como fórmulas. No se generan distribuciones adicionales innecesarias.
- **PDF:** documento A4 sencillo con contexto, indicadores y listado operacional, ajuste de líneas, encabezados de continuación, referencia cuando un caso continúa en otra página y numeración. Máximo 100 páginas. Las fuentes estándar existentes soportan español; si aparece un carácter incompatible (por ejemplo, un emoji), se rechaza el PDF y se indica exportar CSV/Excel. No se sustituyen datos silenciosamente. La ampliación a tipografías Unicode o documentos complejos queda pendiente.

Los nombres son deterministas: `incidentes-2026-09-01-2026-09-30.csv`, o `incidentes-conjunto-norte-2026-09-01-2026-09-30.xlsx`. El nombre opcional del conjunto se normaliza y limita; no se incluyen IDs ni nombres de usuarios en el archivo. Las fechas de celdas se expresan con hora y offset `-05:00`.

La fecha oficial de generación procede del servidor Next después de la consulta autorizada, independientemente de la caché de consultas Convex. Se incorpora al CSV, al contexto Excel/PDF y a `X-Reporte-Generado`. La fecha de la consulta visible procede de Convex.

La UX distingue Preparando, Generando, Descargando, Completado y Error mediante una región de estado accesible. Completado significa archivo recibido y entregado al navegador; no certifica que el usuario lo haya guardado en disco. Un bloqueo con ref impide doble solicitud incluso antes del rerender. Cambiar filtros/desmontar aborta la solicitud y evita una descarga tardía del contexto anterior. No se anuncia éxito ni se descarga si la respuesta falla, está vacía o no tiene nombre válido.

## Seguridad y datos

La query de reportes exige membresía de administración de compañía o supervisión en backend, además de la cadena de acceso existente. Un guarda no puede invocarla para obtener ni vista ni exportación. Su bandeja y lectura de reportes propios permanecen intactas.

La compañía sale de la sesión. Cada recorrido comienza con índices que contienen esa compañía. El administrador mantiene el histórico propio como en dashboard/bandeja; seleccionar un conjunto no elimina el prefijo de compañía. El supervisor obtiene sus conjuntos en backend y se autoriza cada ámbito mediante `exigirAlcanceBandeja`. Los filtros por reportante del acceso existente también se conservan si hay datos legados con asignaciones de guardia. Ninguna lista enviada por cliente concede autoridad.

La prueba específica de dos compañías en el mismo conjunto exige igualdad del reporte de A después de insertar incidentes de B; comprueba además los archivos de ambos. Otra prueba exige exactamente A+B para un supervisor y excluye C, incluida la selección explícita no autorizada.

Campos exportados: referencia operacional existente, reporte, hecho, conjunto, tipo, prioridad, estado, ubicación, nombre de reportante, nombre de responsable y fechas de resolución/cierre. La referencia usa el identificador que ya permite buscar y abrir la ficha; no se agregan IDs técnicos de compañía, conjunto, usuarios ni hijos.

Se excluyen descripción libre, observaciones de resolución/cierre, documentos y datos de involucrados, evidencias/fotografías, claves S3/storageKey, URLs de almacenamiento, tokens, metadatos de seguridad e historial. Reportante/responsable se justifican por trazabilidad operacional. Los campos operacionales de texto reflejan lo registrado por el usuario; no se exploran adjuntos ni metadatos para completarlos.

## Rendimiento y límites

Política central en `convex/lib/incidenteReporte.ts`:

| Límite | Valor |
| --- | --- |
| Vista inicial | 50 filas |
| Exportación completa | 1.000 incidentes |
| Proyección exportable | 1.500.000 bytes serializados |
| PDF | 100 páginas |
| Lectura analítica heredada | 5.000 documentos / 6.000.000 bytes |

El límite de lectura se aplica antes de los filtros residuales, como en Fase 6, para evitar recorridos ilimitados con prioridad/tipo sin coincidencias. El límite de exportación se comprueba incrementalmente y después de incorporar nombres de conjuntos. Se rechaza la generación completa cuando se excede un límite; no se devuelve un archivo parcial. El usuario debe acotar periodo o seleccionar conjunto. Un reporte vacío presenta ceros y explicación; el backend rechaza su exportación.

Resumen y proyección salen del mismo recorrido de la consulta analítica, sin volver a consultar incidentes para contar. La vista mantiene una selección de 50 filas; la exportación retiene exclusivamente la proyección permitida y acotada. Los archivos se construyen en memoria del servidor Next dentro de esos límites. No hay descarga de expedientes completos para filtrarlos o generar archivos en frontend.

Se reutilizan `by_compania_reportado`, `by_compania_estado_reportado`, `by_compania_condominio_reportado`, `by_compania_condominio_estado_reportado` y, cuando el alcance lo exige, `by_compania_condominio_reportante`. No se añaden índices, tablas, agregados persistentes ni paginaciones Convex múltiples en una misma función. El orden es reporte descendente y referencia descendente como desempate; la diferencia de presentación de 50 filas no altera los totales.

## Pruebas y verificación técnica

| Verificación | Resultado |
| --- | --- |
| Backend Fase 7 | 21 pruebas aprobadas: tenants compartidos, supervisor A+B sin C, guarda, sesión/vigencia, seis periodos, filtros combinados, equivalencia dashboard/bandeja/reporte, estado actual, privacidad, CSV, nombre, vacío y límites de filas/bytes. |
| Suite backend completa | 284 unitarias + 569 de seguridad/integración = 853 aprobadas. |
| Frontend/endpoint Fase 7 | 25 pruebas aprobadas: DOM, filtros pendientes, navegación contextual, alcance, cuatro estados de progreso, doble clic, cancelación, formatos, nombre, errores, vacío, endpoint autenticado, contenido CSV/Excel/PDF, límites PDF y caracteres no compatibles. |
| Suite frontend Incidentes | 18 + 13 + 15 + 25 = 71 aprobadas; archivos ejecutados en procesos separados para aislar mocks. |
| Typecheck web y backend | Aprobados. |
| Typecheck global | Persiste TS7006 en `packages/backend/convex/auth.ts:34`, parámetro `s`, al comprobar móvil; problema previo sin modificar. |
| Build global | Aprobado; incluye `/vigilancia/incidentes/reportes` y `/api/incidentes/reporte`. |
| `git diff --check` | Aprobado. |
| Lint global | Persiste `next lint` incompatible con Next 16: busca el directorio inexistente `apps/web/lint`. Pipeline sin modificar. |
| Archivos | Excel validado adicionalmente con openpyxl; PDF sintético renderizado con Poppler y revisado visualmente, incluidas continuaciones y texto extenso. |

El sandbox bloqueó inicialmente la resolución esbuild de Vitest y la descarga de Inter/Poppins durante el build. Las comprobaciones se repitieron con acceso autorizado, sin cambiar dependencias, fuentes ni scripts de build.

Las pruebas backend usan convex-test y datos sintéticos; frontend usa React/Happy DOM y el endpoint real con la sesión/conector simulados. No equivalen a una sesión autenticada contra un despliegue real o una revisión en dispositivos físicos. No se usaron archivos de producción ni se desplegó la aplicación.

## Decisiones pendientes

No se persisten reportes ni archivos. Quedan fuera: programación, correos, notificaciones, automatizaciones, SLA, alertas, plantillas configurables, reportes ejecutivos, documentos complejos, exportación de evidencias, historial/re-descarga, retención documental, firmas y compartición pública.

La auditoría de generación necesita una decisión posterior sobre un mecanismo transversal y su retención; el historial append-only de incidentes conserva su propósito actual. El PDF avanzado/Unicode y los volúmenes que excedan los límites requieren evaluación independiente. Los límites actuales son conservadores respecto de la consulta Fase 6; no constituyen un benchmark de carga de producción ni una política de retención.
