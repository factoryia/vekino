# Auditoría y pruebas end-to-end del módulo de facturación — Factory

| | |
|---|---|
| **Fecha** | 13 de octubre de 2026 |
| **Conjunto** | Factory (`j570ttbjpy06q0nnd6k15gnxbx8fxvcz`), conjunto de pruebas |
| **Backend** | `agreeable-bee-782`, el mismo que usan los residentes. El usuario autorizó hacer las cargas allí, en Factory. |
| **Web probada** | `localhost:3000`, con el código del repositorio (`7803c26` más los cambios sin commit de esta auditoría) |
| **Sesión** | Administrador de Factory (Factorio). El usuario inició la sesión en la pantalla real de login. |
| **Kit de la auditoría** | `qa/factory/auditoria-2026-10-13/` (no versionado): generador, PDFs sintéticos, valores esperados, observador de peticiones y salidas de las suites |

Todos los documentos usados son sintéticos: residente "RESIDENTE DE PRUEBA" y casas de prueba. No se importó ningún documento real de residentes.

---

## A. Resumen ejecutivo

- **La importación de facturas en PDF funciona de punta a punta con el código actual.** En Factory se probaron la lectura, la vista previa, la confirmación, el guardado, la publicación en S3, la idempotencia, la conciliación del mes anterior y las discrepancias. Todo se comportó como dice el diseño (sección C).
- **Los datos guardados coinciden con los documentos.** El lote tiene 18 facturas sintéticas:
  - 16 se leyeron exactamente como se generaron.
  - Las otras 2 son los casos hechos para que se marquen (hoja de continuación y período contradictorio). Sus montos se leyeron bien y quedaron marcadas con el motivo esperado.
  - Lo guardado en la base y el PDF publicado en S3 coinciden con el documento (sección D).
- **Se corrigieron 2 defectos confirmados.** Cada uno tiene una prueba automatizada que fallaba antes de la corrección:
  1. Un archivo vacío, de texto o dañado respondía **500** y mostraba el error interno de pdf-lib, en inglés. Ahora responde **400 o 422**, con un mensaje en español que dice qué hacer.
  2. Si no entraba ninguna factura, la pantalla decía **"¡Facturas cargadas!"**. Ahora dice **"No se cargó ninguna factura"** y el detalle explica por qué.
- **Producción no tiene este código.** La web publicada (www.vekino.com) sigue en la versión anterior a la Fase 1:
  - la ruta de subida responde sin sesión;
  - la ruta de confirmación no existe.

  Lo verificado aquí vale para el backend desplegado junto con la web del repositorio. No vale para la web publicada.
- **Quedan hallazgos abiertos** que no se corrigieron porque necesitan una decisión de negocio o un despliegue del backend. Los principales:
  - una factura manual da por "pagada" la del mes anterior (defecto 5, confirmado con datos);
  - el monto a pagar no descuenta los abonos.
- **Veredicto: APROBADO CON OBSERVACIONES** para el módulo con el código actual. La web publicada queda **NO APROBADO** hasta que se despliegue (sección J).

---

## B. Arquitectura y diagnóstico

### Flujo

1. **Pantalla** (`apps/web/components/upload-facturas.tsx`).
   - El administrador elige el PDF.
   - Cada petición sale con `fetchConSesion` (cabecera `Better-Auth-Cookie`, corrección de `7803c26`).
2. **Vista previa** (`POST /api/facturas/upload`).
   - Valida la sesión (`rechazoSinSesion`) y el permiso sobre el conjunto (`validarDestino` → `facturas.destinoCarga`). Pueden cargar el administrador y la contadora (`CARGA_ROLES`).
   - Lee el PDF (`lectura.ts`: pdf-lib, y unpdf para reconstruir las columnas).
   - Lo parte en facturas (`parser.ts`), cada una con sus dudas (`motivos`).
   - Devuelve lo leído y la huella SHA-256 del archivo.
   - **No escribe nada**, ni en la base ni en S3.
3. **Revisión en pantalla.**
   - El período sale de los documentos.
   - El lote se bloquea si los documentos tienen períodos distintos, si el período elegido no es el del documento o si el período es ilegible.
   - La pantalla empareja cada casa con una unidad del conjunto (`lib/emparejar-unidad.ts`) y marca los documentos repetidos.
4. **Confirmación** (`POST /api/facturas/confirmar`).
   - Valida otra vez la sesión y el permiso.
   - Vuelve a leer el PDF y exige la misma huella; si cambió, responde 409.
   - `iniciarImportacion` planea cada factura (insertar, actualizar, omitir o rechazar) y da la idempotencia: el mismo conjunto, huella, período y opción "solo nuevas" devuelve `repetida`.
   - Publica cada PDF en S3 con `If-None-Match`, en la llave `condominios/facturas/{carpeta}/{periodo}/{importacionId}/unidad-{casa}-{hash12}.pdf`.
   - Escribe en lotes de 20 (`bulkUpsert`) y cierra con `finalizarImportacion`.
5. **Escritura** (`escribirFactura`, en `packages/backend/convex/model/facturas.ts:164`).
   - Es la única puerta de escritura.
   - La identidad de una factura es conjunto + unidad + período.
   - Una factura manual se reemplaza por la del PDF.
   - Nunca escribe el estado.
6. **Estado y conciliación** (`recalcularUnidades` → `calcularCadena`).
   - Los pagos aprobados son un piso.
   - El saldo anterior de la factura siguiente decide si la anterior quedó pagada, abonada o vencida (`veredictoConciliacion`, en `packages/backend/convex/lib/cartera.ts:180`).
   - Si ese saldo es mayor que lo adeudado menos lo pagado, se abre una discrepancia. Se resuelve sola cuando un documento posterior la corrige.

### Diagnóstico previo (lectura de código, antes de probar)

- Las salvaguardas principales están en el código, y las pruebas las confirmaron:
  - vista previa sin escritura;
  - huella entre vista previa y confirmación;
  - importación idempotente;
  - llave de S3 única por importación y sin sobrescritura;
  - una sola función que escribe;
  - estado calculado, no enviado por el cliente.
- Puntos débiles vistos en el código, detallados en la sección E:
  - el manejo de archivos que no son PDF (H-03);
  - el texto de resultado cuando no entra nada (H-04);
  - la regla de inferencia con facturas manuales (H-05);
  - el borrado de unidades (H-06);
  - la confianza en la unidad que asigna el cliente (H-07);
  - la republicación de documentos idénticos (H-08).

---

## C. Matriz de pruebas

**Estados:**
- ✅ pasa.
- ❌→✅ fallaba y se corrigió en esta auditoría.
- ⚠ pasa, con una observación.
- — no se ejecutó (el motivo está en la fila).

**Evidencia:**
- **Obs.**: registro del observador instalado en la página. Por cada petición a `/api/*` anota los nombres de las cabeceras (nunca sus valores), los campos sin el PDF, el estado y un resumen de la respuesta.
- **Pant.**: pantalla de Finanzas o detalle de la factura.
- **Parser**: `verificar-parser.mjs`, el parser real de la web comparado con `esperado.json`.
- **Auto**: prueba automatizada.

**Precondiciones comunes:**
- sesión de administrador en Factory;
- unidades 201–205 creadas para esta auditoría;
- lote de `qa/factory/auditoria-2026-10-13/pdfs/`.

### Fase 3 — Carga (vista previa)

| ID | Precondiciones | Acción | Esperado | Observado | Evidencia | Estado |
|---|---|---|---|---|---|---|
| 3A-1 | Sin facturas de 201–205 | Subir `auditoria-2026-09.pdf` (6 documentos) | 6 leídas, 4 entran, 1 en revisión (204), 1 sin unidad (299); período 2026-09 tomado de los documentos; nada escrito | Exacto. Botón "Confirmar 5 facturas". | Obs. (200, `better-auth-cookie`), Pant. | ✅ |
| 3B-1 | — | Comparar lo leído con los valores con que se generó cada PDF | Coinciden casa, número, período, saldo anterior, total, total con descuento, líneas y cuadre | 16 de 18 exactas. Las 2 restantes son 3C-5 y 3C-7: montos correctos y el motivo esperado. | Parser (`resultados-post/verificar-parser.txt`) | ✅ |
| 3B-2 | 3A-1 | Revisar qué muestra la vista previa | Lo necesario para decidir | Muestra casa, unidad, período, saldo anterior, total y cuadre. No muestra el total con descuento ni su fecha, aunque sí se leen y se guardan. | Pant. | ⚠ (H-11) |
| 3C-1 | — | Subir `invalido-texto.pdf` (texto con extensión .pdf) | Rechazo claro; nada escrito | Antes: 500, con la alerta "Failed to parse PDF document … No PDF header found". Después: 422, "El archivo no es un PDF válido o está dañado. Revísalo y vuelve a subirlo." | Obs., Auto | ❌→✅ |
| 3C-2 | — | Subir `invalido-vacio.pdf` (0 bytes) | Ídem | Antes: 500, con el mensaje de pdf-lib. Después: 400, "El archivo está vacío. Elige el PDF con las cuentas de cobro." | Obs., Auto | ❌→✅ |
| 3C-3 | — | Subir `invalido-truncado.pdf` (PDF cortado) | Ídem | Antes: 500, con el mensaje de pdf-lib. Después: 422, con el mensaje en español. | Obs., Auto | ❌→✅ |
| 3C-4 | — | Subir `invalido-sin-facturas.pdf` (PDF válido sin cuentas de cobro) | Nada que confirmar | 200, 0 leídas, aviso "No se pudieron leer". Confirmar deshabilitado. | Obs., Pant. | ✅ |
| 3C-5 | — | Subir `auditoria-continuacion.pdf` (hoja sin casa) | No entra sin unidad | Página sin casa, marcada `pagina_de_continuacion`. Confirmar deshabilitado. | Obs., Pant. | ✅ |
| 3C-6 | — | Subir `auditoria-sin-total.pdf` | Entra en revisión, nunca como válida | En revisión (`total_no_leido`, `totales_no_cuadran`). Confirmar habilitado, por diseño. No se confirmó. | Obs., Pant. | ✅ |
| 3C-7 | — | Subir `auditoria-periodo-contradictorio.pdf` (fecha de septiembre, cuota de diciembre) | No adivina el período | Período ilegible; pide "Elige el período". Confirmar deshabilitado. | Obs., Pant. | ✅ |
| 3D-1 | — | Subir `auditoria-mixto-11-12.pdf` (noviembre y diciembre) | Lote bloqueado | "Los documentos son de períodos distintos…". Confirmar deshabilitado. | Pant. | ✅ |
| 3D-2 | — | Subir `auditoria-2026-11-repetido.pdf` (dos documentos de la 201) | No entra ninguno sin una decisión | Los dos quedan marcados "documento repetido en el PDF · sin unidad". Confirmar deshabilitado. La regla del servidor (`documento_repetido`) no se alcanza desde la pantalla; la cubre `confirmarFacturasFase3.test.mjs`. | Pant., Auto | ✅ |
| 3D-3 | — | Factura de varias páginas | Se publica completa | No se ejecutó en Factory: el lote tiene una página por factura. Lo cubre `confirmarFacturas.test.mjs` con `cdc-consolidado-con-continuacion.pdf`. | Auto | — |

### Fase 4 — Confirmación y persistencia

| ID | Precondiciones | Acción | Esperado | Observado | Evidencia | Estado |
|---|---|---|---|---|---|---|
| 4A-1 | Vista previa 3A-1 | Confirmar | 5 guardadas (4 más 1 en revisión), la 299 rechazada, 5 PDF publicados | 200: insertadas 5, marcadas 1, rechazadas 1 (`sin_unidad`), publicadas 5. Importación `w972c1mn5sxrgk4jv8ytesxyvh8g64wq`. | Obs., Pant. | ✅ |
| 4A-2 | 4A-1 | Abrir el detalle de cada factura | Igual al documento | Coinciden líneas, totales, con y sin descuento, y fechas. La 203 queda en "Saldo a favor" con −65.000; la 204 en revisión con 355.000. Historial: "Creada por la carga del PDF". Ver sección D. | Pant. | ✅ |
| 4A-3 | 4A-1 | Descargar de forma anónima el PDF publicado de la 202 | El documento completo de esa casa; la huella coincide con la llave | 1 página con los valores de la 202. El SHA-256 empieza por `730aa5d98781`, igual que la llave. | `publicados/unidad-202.pdf` | ✅ |
| 4B-1 | Sin facturas de octubre | Vista previa de `auditoria-2026-10.pdf` y luego Cancelar | Nada guardado ni publicado | No hay facturas de octubre para 201–205 ni petición de confirmación. | Obs., Pant. | ✅ |
| 4C-1 | Vista previa de octubre | Confirmar enviando `auditoria-2026-10-modificado.pdf` con la huella de la vista previa | 409 antes de escribir | 409, "El archivo no es el mismo de la vista previa…". Nada escrito. | Obs. | ✅ |
| 4D-1 | Vista previa de octubre | Doble clic en Confirmar | Una sola confirmación | 1 petición, tipo `nueva`: insertadas 5, publicadas 5. Conciliación: pagadas 1, abonadas 1, vencidas 1 (ver 6-1). | Obs. | ✅ |
| 4D-2 | 4D-1 | Subir el mismo archivo con "Solo insertar facturas nuevas" | No repite nada | "Este archivo ya se había cargado" (`repetida`). Nada publicado. | Obs., Pant. | ✅ |
| 4D-3 | 4D-1 | Subir el mismo archivo sin "Solo insertar nuevas" | Actualiza sin duplicar | Actualizadas 5, sin duplicados. Pero republicó los 5 PDF idénticos con llave nueva (importación `w979zjehf1x0ce6w7gjqbfn2x18g7svh`) y dejó en el historial "Actualizada… (pdfUrl, importacionId)" aunque el documento no cambió. | Obs., Pant. | ⚠ (H-08) |
| 4E-1 | Lote de 5 facturas en vista previa | Confirmar con el período alterado a 2026-11 en la petición | Todas rechazadas, nada escrito, pantalla clara | Servidor: 5 rechazadas (`periodo_no_coincide`), 0 escritas, ninguna factura de noviembre. Pantalla: decía "¡Facturas cargadas!" con "0 nuevas · 5 no entraron". Corregido: ahora dice "No se cargó ninguna factura". | Obs., Pant., Auto | ❌→✅ |
| 4E-2 | — | Fallo del backend a mitad de la escritura | La importación se cierra como fallida y un reintento no duplica | No se ejecutó en producción: habría que provocar un fallo. Lo cubre `confirmarFacturas.test.mjs`: "si guardar falla, la importación se cierra como fallida y responde 500" y "un reintento que encuentra la llave ya publicada no la sobrescribe ni falla". | Auto | — |

### Fase 5 — Autenticación y permisos

| ID | Precondiciones | Acción | Esperado | Observado | Evidencia | Estado |
|---|---|---|---|---|---|---|
| 5-1 | — | Petición anónima a la vista previa y a la confirmación | 401 | 401 en las dos | Obs. | ✅ |
| 5-2 | — | Petición con una cabecera `Better-Auth-Cookie` inventada | 401 | 401 en las dos | Obs. | ✅ |
| 5-3 | — | Petición con un `Authorization: Bearer` inventado | 401 | 401 en las dos | Obs. | ✅ |
| 5-4 | Sesión válida | Cambiar el `condominioId` por el de otro conjunto, en la vista previa y en la confirmación | 403, nada escrito | 403, "No tienes permiso para subir facturas de este conjunto." | Obs. | ✅ |
| 5-5 | Sesión válida | Todas las peticiones de la pantalla | La sesión viaja en `better-auth-cookie`, sin cookies del navegador | Así en todas: las cabeceras se registraron por nombre y no hay cookies en el dominio. | Obs. | ✅ |
| 5-6 | Cuentas de contadora, junta y residente | Intentar cargar | Solo administrador y contadora | No se ejecutó con esas cuentas: habría que iniciar sesión con ellas. En el código, `CARGA_ROLES` = administrador, contadora (`facturas.ts:52`); el permiso lo deciden `destinoCarga` y `bulkUpsert`. | Código, Auto | — |

### Fase 6 — Coherencia financiera y regresión

Los pasos 6-3 a 6-8 usan los PDFs de la ronda 2 sobre las casas A–E (101–105), que tenían 6 facturas manuales.

| ID | Precondiciones | Acción | Esperado | Observado | Evidencia | Estado |
|---|---|---|---|---|---|---|
| 6-1 | 4D-1 | Revisar septiembre después de cargar octubre | 201 pagada (saldo anterior 0); 202 vencida (arrastra 485.000); 205 abonada (arrastra 135.000 de 335.000); 203 conserva su saldo a favor; 204 no se juzga (en revisión) | Exacto | Pant., Obs. | ✅ |
| 6-2 | 6-1 | Recaudo de septiembre | 335.000 (201) + 200.000 (205) = 535.000 | Recaudo (contabilidad): $535.000 | Pant. | ✅ |
| 6-3 | 103 y 105 de agosto, manuales | Cargar el PDF de agosto (103, 105) | Reemplaza las manuales sin perder los pagos | Actualizadas 2. La 103 sigue abonada con su pago de 200.000; la 105 sigue pagada. | Obs., Pant. | ✅ |
| 6-4 | 101, 104 y 105 de septiembre, manuales | Cargar el PDF de septiembre (101, 104, 105) | Reemplaza y recalcula | La 101 sigue pagada. La 104 queda pagada y en revisión, con total 355.000 y excedente recalculado a 45.000. La 105 de septiembre queda abonada. **La 105 de agosto pasa de Pagada a Vencida**: confirma el defecto 5 (H-05). | Pant. | ✅ (confirma H-05) |
| 6-5 | Abono de 200.000 a la 103 de agosto | Cargar la 103 de septiembre sin el abono reflejado | Discrepancia de 200.000 | Discrepancia abierta; "Pago en verificación" en la 103 de septiembre | Pant. | ✅ |
| 6-6 | 6-5 | Cargar la 103 de octubre, que sí refleja el abono | La discrepancia se cierra sola | Resuelta como "aplicado en documento posterior"; la 103 de septiembre pasa a abonada | Pant. | ✅ |
| 6-7 | 101 de septiembre pagada | Cargar la 101 de octubre sin el pago reflejado | Discrepancia de 335.000; el pago registrado no se degrada | Discrepancia de 335.000; la 101 de septiembre sigue pagada | Pant. | ✅ |
| 6-8 | 6-7 | Cargar la 101 de octubre corregida | Con "solo nuevas", omitida; sin esa opción, actualizada y discrepancia resuelta | Con "solo nuevas": omitida, la discrepancia sigue abierta. Sin la opción: actualizada (conserva `FAC-2026-10-101`), resuelta como "documento corregido". | Obs., Pant. | ✅ |
| 6-9 | — | Regresión en el resto de Finanzas | Pagos por revisar y totales coherentes | "Pagos por revisar" refleja el nuevo excedente de la 104 (45.000). Los pagos de la ronda 2 siguen aplicados: la 103 sigue abonada con 200.000. | Pant. | ✅ |

### Fase 7 — Pruebas automatizadas

Ver la sección G. Todas pasan después de las correcciones. El lint no se puede ejecutar: en Next 16 no existe `next lint` y la web no tiene configuración de ESLint.

### Fase 8 — Despliegue

Ver la sección H. La web publicada no está actualizada. No se desplegó nada.

---

## D. Calidad de datos: PDF, vista previa y lo guardado

### Septiembre (`auditoria-2026-09.pdf`, importación `w972c1mn…`)

| Casa | Documento (PDF) | Vista previa | Guardado (detalle de la factura) |
|---|---|---|---|
| 201 | Nro. 92011. Saldo anterior 0. Cuota 314.000 + pozo 21.000. Total 335.000. Con descuento 295.000 hasta el 15. | Igual; cuadra | `FAC-2026-09-201`. Mismas líneas. Con descuento 295.000 hasta el 15 de septiembre; sin descuento 335.000 hasta el 30 de septiembre. Pendiente. |
| 202 | Saldo anterior 150.000 (cuota 140.000 + pozo 10.000). Total 485.000. Con descuento 445.000. | Igual; cuadra | Cuota 140.000 / 314.000 / 454.000; pozo 10.000 / 21.000 / 31.000. 445.000 y 485.000. Pendiente. |
| 203 | Saldo anterior −400.000. Total −65.000 (a favor). Con descuento −105.000. | Igual; cuadra | Cuota −400.000 / 314.000 / −86.000; pozo 21.000. Total −65.000. **Saldo a favor**. Muestra solo el total a pagar (−65.000), sin la línea de descuento. |
| 204 | Las líneas suman 335.000, pero el total dice 355.000. Con descuento 315.000. | **En revisión** (las líneas y los totales no cuadran) | Total 355.000, como dice el documento, y marcada en revisión. Con descuento 315.000. |
| 205 | Igual que la 201 | Igual; cuadra | Igual que la 201 |
| 299 | Casa que no existe en el conjunto | Sin unidad | **No se guardó** (rechazada por `sin_unidad`) |

- **PDF publicado:** el de la 202, descargado de S3, tiene 1 página con sus valores, y su SHA-256 coincide con la llave.
- **Número de la factura:** el sistema numera por período y casa (`FAC-2026-09-201`). El número del documento (92011…) se guarda en `numeroInterno` y sirve para buscar.

### Octubre (`auditoria-2026-10.pdf`)

- Se leyeron los 5 documentos tal como se generaron:

  | Casa | Saldo anterior | Total | Con descuento |
  |---|---|---|---|
  | 201 | 0 | 335.000 | 295.000 |
  | 202 | 485.000 | 820.000 | 780.000 |
  | 203 | −65.000 | 270.000 | 230.000 |
  | 204 | 0 | 335.000 | 295.000 |
  | 205 | 135.000 | 470.000 | 430.000 |

- **Lo guardado:** se revisó el detalle completo de la 201 (295.000 hasta el 15 de octubre y 335.000 hasta el 31 de octubre). En la 202 a la 205 se verificaron el estado, el historial y el efecto en la conciliación (6-1).

### Lote completo

- `verificar-parser.mjs`: 16 de 18 facturas exactas.
- Las 2 restantes difieren solo en el campo "cuadra" del script. Son los casos diseñados para quedar marcados:
  - la hoja de continuación (`pagina_de_continuacion`);
  - la del período contradictorio (`periodo_no_leido`).
- Sus montos se leyeron bien.

---

## E. Hallazgos por severidad

| ID | Severidad | Hallazgo | Evidencia | Estado |
|---|---|---|---|---|
| H-01 | **Alta** (producción) | **La web publicada está desactualizada.** En www.vekino.com, el 13 de octubre: un POST anónimo a `/api/facturas/upload` responde 400 "Faltan campos: pdf, condominioLegacyId, periodo", es decir, contesta sin sesión. `/api/facturas/confirmar` responde 404. Es la ruta anterior a la Fase 1, que según auditorías previas publica en S3 durante la vista previa (F-07). El backend sí está actualizado. | Sondeo HTTP sin sesión ni archivo | Abierto. Hay que desplegar la web. |
| H-02 | **Alta** | **El monto a pagar no descuenta los abonos.** `montoAPagarHoy` (`lib/cartera.ts:790`) devuelve el total con o sin descuento e ignora lo ya pagado. Después de un abono aprobado, el residente ve y la pasarela cobra el monto completo. Viene de la ronda 2. | Código; ronda 2 (B2) | Abierto. Requiere decidir cómo se aplica el descuento a un pago parcial. |
| H-03 | Media | **Archivo inválido: 500 con el error interno en inglés.** | 3C-1 a 3C-3 | **Corregido** (sección F) |
| H-04 | Media | **"¡Facturas cargadas!" sin que entrara ninguna.** | 4E-1 | **Corregido** (sección F) |
| H-05 | Media | **Defecto 5: una factura manual da por pagada la del mes anterior.** La factura manual no trae `saldoAnteriorDocumento`, así que `saldoAnteriorDe` usa la suma de sus líneas (0) y `veredictoConciliacion` juzga "pagada" la anterior. Confirmado con datos: la 105 de agosto figuraba pagada y pasó a vencida cuando su septiembre llegó en PDF con saldo anterior. | 6-4; `lib/cartera.ts:117` y `:180` | Abierto. Propuesta: sin saldo anterior del documento, `sin_veredicto`. Cambia estados en todos los conjuntos con facturas manuales, así que requiere decisión, despliegue del backend y un plan de recálculo. |
| H-06 | Media | **Borrar una unidad deja sus facturas huérfanas.** `unidades.remove` (`unidades.ts:232`) borra los vínculos de residentes y la unidad, pero no sus facturas, que quedan apuntando a una unidad que ya no existe. Hay una docena de tablas con `unidadId` en el esquema. | Código | Abierto. Propuesta: impedir el borrado si la unidad tiene facturas, o archivarla. |
| H-07 | Baja | **El servidor confía en la unidad que asigna el cliente.** Verifica que la unidad sea del conjunto (`unidad_ajena`), pero no que corresponda a la casa del documento. Solo afecta a roles con permiso de carga, que pueden crear facturas manuales de todos modos; el riesgo es un error de emparejamiento en la pantalla que nadie note. | Código (`confirmar/route.ts`, `bulkUpsert`) | Abierto |
| H-08 | Baja | **Recargar el mismo archivo sin "solo nuevas" republica PDFs idénticos.** Como la llave lleva el `importacionId`, cada recarga crea 5 objetos nuevos en S3 y un evento "Actualizada" sin cambios en el documento. | 4D-3 | Abierto. Propuesta: conservar la URL si la huella del documento es la misma. |
| H-09 | Baja | **El excedente se calcula contra un total en revisión.** La 104 muestra un excedente de 45.000 contra 355.000; si el total real es 335.000 (la suma de sus líneas), el excedente es 65.000. | 6-4 | Abierto |
| H-10 | Baja | **Roles inconsistentes.** La junta directiva puede crear facturas manuales (`facturas.createManual`) pero no importar PDF (`CARGA_ROLES`). | Código | Abierto. Requiere decisión. |
| H-11 | Baja | **La vista previa no muestra el total con descuento ni su fecha**, aunque se leen y se guardan. | 3B-2 | Abierto (mejora) |
| H-12 | Baja (riesgo) | **Tamaño del archivo.** El PDF viaja por las rutas de Next, y en Vercel el cuerpo de una petición a una función tiene un tope de 4,5 MB. Un PDF consolidado grande fallaría antes de llegar al código. | No se probó | Abierto. Medir el tamaño de un consolidado real. |
| H-13 | Baja | **El 403 "Revisa tu sesión" de `/api/incidentes/reporte` mezcla falta de sesión con falta de rol.** Viene de la tarea anterior; está fuera del módulo de facturación. | Código | Abierto |
| H-14 | Trivial | **Plural del botón:** dice "Confirmar 1 facturas". | Pant. | Abierto |

---

## F. Cambios implementados

Todos están en el árbol de trabajo, **sin commit**. No hubo cambios en el backend.

| Archivo | Cambio |
|---|---|
| `apps/web/app/api/facturas/lectura.ts` | Nueva clase `PdfIlegible`. Lo que falla al **abrir o recorrer** el PDF (pdf-lib o la extracción de texto) se lanza como `PdfIlegible`; lo que falla al **interpretar** el texto no. Así un error del parser no se presenta como "archivo dañado". |
| `apps/web/app/api/facturas/upload/route.ts` | Después de validar la sesión y el permiso: un archivo de 0 bytes responde **400** "El archivo está vacío…", y un `PdfIlegible` responde **422** "El archivo no es un PDF válido o está dañado…". El detalle técnico solo va al registro del servidor. Cualquier otro error sigue en el 500 de siempre. |
| `apps/web/components/upload-facturas.tsx` | Si la carga es `nueva` y no insertó ni actualizó nada (las marcadas en revisión ya están contadas en esas dos cifras), el resultado dice **"No se cargó ninguna factura"**, con ícono de alerta en lugar del visto verde. El detalle de abajo (rechazadas u omitidas, y sus motivos) no cambia. |
| `apps/web/pruebas/subidaFacturas.test.mjs` | 5 pruebas nuevas: archivo vacío (400); texto y PDF cortado (422, sin el mensaje interno); sin sesión con un archivo dañado (sigue siendo 401); y que `PdfIlegible` cubra solo lo que no se pudo abrir. |
| `apps/web/pruebas/cargaFacturas.test.mjs` | 2 pruebas nuevas: todas rechazadas y todas omitidas no dicen "¡Facturas cargadas!". |

**Reproducción antes de corregir:**
- Las 3 pruebas de archivo inválido fallaban con "Expected 400/422, Received 500".
- Las 2 de la pantalla fallaban porque aparecía "¡Facturas cargadas!".

**Verificación en la pantalla real** (Factory, `localhost:3000`, después de corregir):

| Archivo | Respuesta | Mensaje |
|---|---|---|
| `invalido-texto.pdf` | 422 | En español |
| `invalido-vacio.pdf` | 400 | En español |
| `invalido-truncado.pdf` | 422 | En español |

- En los tres casos el diálogo vuelve a pedir el archivo.
- Un PDF válido sigue dando la misma vista previa (6 leídas). Se canceló sin confirmar.

---

## G. Resultados automatizados

Se ejecutaron en secuencia (`qa/factory/auditoria-2026-10-13/correr-suites*.sh`). Las salidas completas están en `resultados/` (antes) y `resultados-post/` (después).

| Comando (carpeta) | Antes de corregir | Después |
|---|---|---|
| `bun run test` (`apps/web`) | 342 pasan, 0 fallan | **349 pasan, 0 fallan** (+7 nuevas) |
| `bun test pruebas/subidaFacturas.test.mjs` (`apps/web`) | 3 fallan (500 en lugar de 400/422) | **11 de 11** |
| `bun test pruebas/cargaFacturas.test.mjs` (`apps/web`) | 2 fallan ("¡Facturas cargadas!") | **11 de 11** |
| `bun test pruebas/confirmarFacturas.test.mjs` (`apps/web`) | 15 de 15 | **15 de 15** |
| `bun run test:facturacion` (`packages/backend`) | 55 de 55 | **55 de 55** |
| `bun run test:unit` (`packages/backend`) | 458 de 458 | **458 de 458** |
| `bun run test:seguridad` (`packages/backend`) | 1124 de 1124 | **1124 de 1124** |
| `node ../../node_modules/typescript/bin/tsc --noEmit` (`apps/web`) | 0 errores | **0 errores** |
| `node ../../node_modules/typescript/bin/tsc --noEmit` (`packages/backend`) | 0 errores | **0 errores** |
| `node ../../node_modules/next/dist/bin/next build` (`apps/web`) | Compila | **Compila** (32 páginas) |
| Lint | No se puede ejecutar | No se puede ejecutar: Next 16 no tiene `next lint` y la web no tiene configuración de ESLint |

`next build` reescribe `apps/web/next-env.d.ts`; se revirtió con `git checkout` después de cada build.

---

## H. Estado de producción

| Pieza | Estado | Cómo se comprobó |
|---|---|---|
| Backend `agreeable-bee-782` | **Actualizado** con lo que usa este flujo: `destinoCarga`, `iniciarImportacion`, `bulkUpsert` con importación, `finalizarImportacion`, conciliación y discrepancias | Todas las confirmaciones de esta auditoría corrieron contra ese backend |
| Web www.vekino.com | **Desactualizada** (anterior a la Fase 1) | 13 de octubre, sin sesión: POST `/api/facturas/upload` → 400 "Faltan campos: pdf, condominioLegacyId, periodo"; GET `/api/facturas/confirmar` → 404; `/api/incidentes/reporte` → 405 (GET) y 403 (POST) |
| Correcciones de esta auditoría | Solo en el árbol de trabajo | Sin commit y sin despliegue |

**Para llevarlo a producción:**
1. Hacer commit de estos cambios.
2. Publicar la web (incluye `7803c26`, `fetchConSesion`). Esta vez no hay cambios de backend.
3. Repetir el sondeo en www.vekino.com:
   - la subida anónima debe dar 401;
   - `/api/facturas/confirmar` debe existir (401 sin sesión);
   - en Factory, la vista previa debe dar 200.
4. Subir `invalido-texto.pdf` y comprobar el 422.

Lo verificado en `localhost` **no** prueba que producción esté corregida.

---

## I. Estado final

### Repositorio

- **Modificados, sin commit:**
  - `apps/web/app/api/facturas/lectura.ts`
  - `apps/web/app/api/facturas/upload/route.ts`
  - `apps/web/components/upload-facturas.tsx`
  - `apps/web/pruebas/cargaFacturas.test.mjs`
  - `apps/web/pruebas/subidaFacturas.test.mjs`
- **Nuevo:** este informe.
- **Kit de la auditoría:** `qa/factory/auditoria-2026-10-13/` (ignorado por git).
- `next-env.d.ts` se revirtió después del build.

### Datos en Factory

Backend de producción, conjunto de pruebas. No se borró nada.

- **Unidades 201–205:** creadas para la auditoría, sin residentes.
- **Facturas desde PDF:**
  - septiembre 201–205 (5) y octubre 201–205 (5);
  - la 299 no se guardó.
- **Casas A–E (101–105):**
  - Reemplazadas, de manual a PDF: agosto 103 y 105; septiembre 101, 104 y 105. Ya no existen como manuales; sus pagos y comprobantes se conservaron.
  - Creadas desde PDF: septiembre 103, octubre 101 y octubre 103.
  - Octubre 102 sigue manual.
- **Discrepancias:**
  - 103 de septiembre (200.000): abierta y luego resuelta como "aplicado en documento posterior";
  - 101 de octubre (335.000): abierta y luego resuelta como "documento corregido".
- **Importaciones:** una por cada confirmación, incluida una con 0 escritas (período alterado). Las recargas `repetida` no publicaron nada.
- **S3** (bucket público):
  - Ruta: `condominios/facturas/j570ttbjpy06q0nnd6k15gnxbx8fxvcz/{2026-08|2026-09|2026-10}/{importacionId}/unidad-{casa}-{hash12}.pdf`.
  - Son documentos sintéticos, sin datos reales.
  - Incluye los 5 duplicados de la recarga de octubre (H-08).
- **De la tarea anterior:** sigue abierto el incidente de prueba `vh73cp7anj12cfmjm4mbtbhpt58g7nb2` de "Seguridad Factory". Se puede cerrar.

### Entorno local

- El servidor temporal de PDFs está detenido.
- El observador se quitó: se recargó la página.
- El `next dev` del usuario sigue corriendo y la sesión sigue activa.

---

## J. Veredicto

| Alcance | Veredicto |
|---|---|
| **Módulo de facturación**: backend desplegado y web del repositorio con las correcciones | **APROBADO CON OBSERVACIONES** |
| **Web publicada** (www.vekino.com), tal como está hoy | **NO APROBADO**: sigue en la versión anterior a la Fase 1 (H-01) |

**Por qué el módulo queda "con observaciones":**
- La importación es correcta y segura en todo lo probado: lectura, huella, idempotencia, permisos, persistencia, S3 y conciliación.
- Los dos defectos que tocaban esta pantalla quedaron corregidos y con pruebas.
- Quedan abiertos H-02 (abonos) y H-05 (inferencia desde facturas manuales). Afectan la coherencia financiera y requieren una decisión de negocio.

**Lo que no se verificó:**
- Producción con este código.
- Roles distintos del administrador con sesiones reales.
- Facturas de varias páginas y fallos a mitad de la escritura en Factory (los cubren las pruebas automatizadas).
- PDFs de más de 4,5 MB.
