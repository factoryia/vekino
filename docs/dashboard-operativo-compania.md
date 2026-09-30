# Dashboard operativo de compañía

## Auditoría previa y decisiones

El monorepo usa Convex para datos y autorización, Next.js para web y Expo para móvil. La identidad del guarda vive en `users`, su pertenencia empresarial en `companiaMiembros` y su alcance operativo en `asignaciones`, vinculadas a `companiaContratos`. El dashboard sigue esos ejes; no crea un directorio de guardas ni tablas de estadísticas.

- `guardiaTurnos`: apertura, titular, secundario opcional, cierre y estado. Un turno compartido es una jornada única con dos participantes.
- `guardiaRondas`: recorridos con estado y fechas opcionales para compatibilidad histórica. `estadoDeRonda` interpreta los antiguos como finalizados. No consta el autor de algunas rondas antiguas; el titular del turno no demuestra quién hizo el recorrido.
- `minutaEventos`: bitácora append-only, con módulo, tipo libre, fecha de registro y actor opcional. Incluye eventos automáticos; contar entradas no equivale a contar documentos ni reportes de seguridad.
- `guardiaNovedadReportes`: reportes con prioridad y tipo opcional (`novedad` / `aporte_voluntario`). La clasificación antigua de aportes ya existía en `guardia.ts`; se extrajo a un helper compartido conservando el comportamiento.
- `novedades`: módulo anterior independiente. No se mezcla con los reportes de guardia porque no existe vínculo que permita deduplicarlos.
- `incidentes`: casos de compañía con ciclo de gestión propio y analítica existente (`model/incidenteAnalitica.ts`). Se enlaza su dashboard, sin sumar casos independientes a las novedades de minuta.
- `guardia.resumenPeriodo`: resumen por conjunto con dos conteos, sin filtros completos ni atribución empresarial. Los listados de minuta/rondas/reportes tienen límites orientados a pantallas de detalle; no se agregan sus primeras páginas para producir totales.

### Limitaciones documentadas antes de implementar

Las asignaciones son vigencias de acceso, no programación de jornadas. No hay horarios esperados, calendario de turnos, frecuencia obligatoria de rondas ni metas por zona. No es posible calcular faltantes, retrasos o porcentajes de cumplimiento. El estado de finalización de una ronda tampoco demuestra cumplimiento de una meta inexistente.

No existe categoría temática normalizada en el reporte de novedad: título y descripción son libres. Se distribuyen prioridades y tipos reales, sin inferir categorías a partir del texto. Los registros sin identificador de autor no permiten probar pertenencia a la compañía y se muestran explícitamente sin atribución individual. No se amplió el modelo de negocio para resolver estas limitaciones.

## Implementación y fuentes

Ruta inicial: `/vigilancia/inicio`. Se conserva `/vigilancia` para conjuntos, `/vigilancia/[condominioId]` para supervisión y `/dashboard/companias/[id]` para personal, contratos e inventario. El ruteo inicial del administrador tiene prioridad aunque posea además membresías o asignaciones; la plataforma conserva su experiencia.

Consulta: `companias.operacion`, implementada en `model/operacionCompania.ts`. Exige usuario activo, miembro activo con `admin_compania`, compañía activa y los helpers existentes de acceso empresarial y `porteria.ver`. La compañía deriva de la sesión; no es un argumento del cliente. Los conjuntos de portería requieren contrato vigente hoy, igual que `miEquipo`. Un contrato finalizado deja de habilitar consulta; esto difiere de los incidentes empresariales, que tienen su propia autorización histórica.

Para autoría conocida, cada registro exige asignación de guarda de esa empresa válida en el instante del registro y acotada a su contrato, usando `acotado` y `estaVigente`. Las asignaciones terminadas y personas dadas de baja conservan su actividad histórica durante sus vigencias. Los registros sin autor se incluyen en compañía/conjunto durante una vigencia contractual, separados de toda estadística individual; no se presume un autor a partir del turno. Actores conocidos sin asignación empresarial válida quedan excluidos.

| Métrica | Fuente y criterio |
| --- | --- |
| Turnos iniciados / participaciones | `guardiaTurnos.fechaInicio`. Una fila por jornada; participación para titular y secundario pertenecientes al ámbito. |
| Aperturas como titular | `guardiaTurnos.guardiaUserId`. No añade una apertura por el secundario. |
| Turnos cerrados | Estado actual de las jornadas iniciadas en el periodo; no cantidad de cierres ocurridos en el periodo. |
| Guardas participantes | Guardas distintos con al menos una participación en jornadas seleccionadas. |
| Turnos abiertos ahora | `by_condominio_estado`, separado del periodo; filtros de conjunto/guarda sí aplican. |
| Rondas finalizadas / en curso | `guardiaRondas`, normalización existente de estado; fecha de inicio o `createdAt` para legado. |
| Duración promedio | `duracionMs`, solo finalizadas con ambas fechas válidas; se informa tamaño de muestra. |
| Entradas de minuta | `minutaEventos.createdAt`, manuales y automáticas; distribuidas por `modulo` y `tipo` guardados. |
| Novedades reportadas | `guardiaNovedadReportes.createdAt`, excluyendo aportes mediante el helper compartido. Se distribuyen por prioridad. |
| Aportes voluntarios | Mismos reportes, clasificación explícita o regla histórica existente. |
| Tendencias y comparaciones | Agregaciones de las fuentes anteriores. Los eventos de minuta y sus reportes no se suman como una única métrica. |

Las rondas nuevas sellan inicio y creación en la misma escritura, como documenta el resumen operativo existente. El índice recorta por creación y la agregación comprueba también la fecha de inicio efectiva. No se atribuyen duraciones al legado sin ambas fechas.

## Filtros, visualizaciones y protección de consultas

Fechas inclusivas con días civiles de Colombia; accesos rápidos hoy/7 días/30 días; conjunto y guarda; agrupación compañía/conjunto/guarda; tendencias diarias, semanales (desde el inicio seleccionado) y mensuales (mes civil, extremos parciales). Los cambios de fechas o conjunto limpian el filtro de guarda. Se incluyen filas sin actividad y periodos en cero. Las participaciones de turnos compartidos no son aditivas entre guardas; el resto de filas atribuibles más registros sin autor reconcilia con compañía.

Tarjetas principales, turnos abiertos con enlace a supervisión, tendencia con selector de métrica y tabla accesible, barras por módulo/prioridad/tipo, comparación de hasta diez filas y tabla completa, duración y advertencia de registros sin autor. Seleccionar un nombre en la comparación actualiza el filtro y reconstruye el detalle. Se reutilizan Card, Input, Select, Button, Skeleton, EmptyState, ErrorBoundary, AreaChart, HBars y la paleta existente. Filtros avanzados desplegables con rango/ámbito visibles en el resumen y accesos rápidos siempre disponibles. Filtros permanecen disponibles ante error, con reintento y restablecimiento. Tablas desplazables y rejillas responsive.

Se añadieron únicamente cuatro índices `by_condominio_fecha`, sobre fechas que ya existían. No hay nuevos campos, tablas, escrituras operativas ni contadores persistidos. Las consultas recorren índices acotados, hasta 366 días y con presupuesto conjunto de 6.000 documentos / 6 MB; al excederlo se rechaza la consulta completa y se pide reducir el ámbito. Nunca se publican totales truncados. La salida solo contiene agregados, catálogos y un resumen de turnos abiertos, sin descripciones, adjuntos o evidencias.

## Validación

13 pruebas de integración en `packages/backend/pruebas/operacionCompania.test.ts`: fuentes, fechas inclusivas, turnos compartidos, legacy, filtrado, tendencias y reconciliación, vigencias históricas, cierre de contratos, sesión/roles/empresa, snapshot actual, validación del periodo y rechazo del presupuesto sin totales parciales. 7 pruebas web en `apps/web/pruebas/operacionCompania.test.mjs`: loading, filtros, agrupación, profundización, vacío, error/reintento, ocultación de detalles internos y datos accesibles.

Resultados: 284 pruebas unitarias de backend y 581 pruebas de integración en la ejecución completa (incluía 12 pruebas nuevas antes de añadir la de presupuesto); las 13 pruebas nuevas también pasaron en una ejecución final. Las 71 pruebas existentes de incidentes web y las 7 nuevas de operación pasaron. Typecheck de backend y web y build Next.js aprobados. Inspección visual de los componentes reales con datos sintéticos en escritorio y viewport móvil de 390 × 844; el panel no desborda horizontalmente y las tablas usan desplazamiento propio. No se verificó una sesión con datos remotos ni se publicaron cambios en Convex.

La validación global detectó limitaciones previas ajenas al dashboard: typecheck móvil falla en `convex/auth.ts:34` con TS7006 (parámetro `s` inferido como `any` bajo la configuración Expo); lint web usa `next lint`, que la versión Next.js instalada interpreta como un directorio inexistente. Se ejecutaron y se reportan; no se modificó autenticación ni la configuración de lint como parte de este cambio.

Para habilitar en un despliegue existente se debe publicar el backend (función e índices) junto con el frontend por el procedimiento habitual. Este trabajo no ejecuta despliegues remotos.
