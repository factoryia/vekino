# Informe: corrección de errores en pagos, facturas y accesos del portal

**Proyecto:** Vekino (plataforma web y app móvil)
**Fecha:** 13 de octubre de 2026
**Origen:** revisión de calidad (QA) hecha en el conjunto de prueba Factory
**Estado:** corregido y probado. Falta revisarlo, guardarlo en el historial oficial y publicarlo.

---

## Resumen

- La revisión de calidad en Factory encontró **seis problemas importantes** en pagos, facturas y permisos del portal de residentes.
- Revisamos cada uno contra el sistema actual:
  - **uno ya estaba corregido** por un trabajo anterior (la carga de facturas en PDF);
  - **los otros cinco seguían presentes**, y **los corregimos todos**.
- Uno resultó **más grave** de lo que decía el informe. Una arrendataria con el contrato vencido no solo seguía viendo la casa en pantalla: el sistema también le permitía autorizar visitantes, que avisan a portería.
- Todo se probó en una **copia aislada**, sin datos reales:
  - agregamos **71 pruebas automáticas nuevas**;
  - las **2.031 pruebas** del sistema pasan.
- **No se publicó nada** ni se modificó información real.

## Antes y después, en una mirada

| # | Problema | Antes | Después |
|---|---|---|---|
| 1 | Carga de facturas en PDF | La plataforma rechazaba a administradores que sí habían iniciado sesión | Ya estaba corregido (trabajo del 13 de octubre). Falta publicarlo |
| 2 | Abonos | Quien abonaba $200.000 de $335.000 seguía viendo $335.000, y el botón de pago iba a cobrar los $335.000 otra vez | Ve $135.000 en todas partes, y el pago cobra $135.000 |
| 3 | Facturas vencidas | La misma factura decía "Vencida" en un lugar y "Pendiente" en otro. Finanzas mostraba 0 vencidas | Dice "Vencida" en todas partes, y Finanzas la cuenta |
| 4 | Arrendatarios con contrato vencido | Seguían viendo la casa. Podían autorizar visitantes, registrarse en asambleas y usar el bot a nombre de ella | Pierden el acceso a la casa al terminar el contrato, con un mensaje claro |
| 5 | Facturas creadas a mano | Crear la factura de septiembre marcaba agosto como "pagada" y sumaba ese dinero al recaudo, sin que nadie pagara | Agosto sigue sin pagar hasta que haya un pago real o un documento de la contabilidad |
| 6 | Pantalla de "Mis facturas" | La fila se desbordaba, el mensaje salía cortado y la fila quedaba corrida después de cancelar el formulario | La fila se ve completa en computador, tableta y celular |

---

## Detalle de cada problema

### 1. Carga de facturas en PDF: ya estaba resuelto

- **Antes:** al subir el PDF de facturas, la plataforma respondía "Inicia sesión", aunque el administrador ya la tuviera iniciada.
- **Ahora:**
  - Se corrigió en el trabajo anterior sobre el acceso (ver *Informe: corrección del acceso a la carga de facturas y al reporte de incidentes*, del 13 de octubre).
  - Confirmamos que la corrección sigue en el código y que sus pruebas pasan.
- **Pendiente:** publicarla.

### 2. Los abonos no se descontaban

- **Antes:** un residente tenía una factura de **$335.000**, pagó **$200.000** y la administración aprobó ese abono.
  - La administración veía "pagado $200.000 de $335.000".
  - El residente seguía viendo **$335.000** en el inicio, en "Mis facturas", en la campana de notificaciones y en la sugerencia del formulario "Ya pagué".
  - El pago en línea, el bot de WhatsApp y el asistente estaban listos para cobrar **$335.000** otra vez.
  - Mientras el pago en línea siga en modo de pruebas el riesgo es menor. Al activarlo, quien abonó habría pagado de nuevo el total.
- **Por qué pasaba:** el cálculo de "lo que se debe hoy" solo tenía en cuenta el valor de la factura y el descuento, e ignoraba los pagos ya aprobados.
- **Después:** el sistema descuenta lo que ya se abonó.
  - El residente ve **$135.000** y la nota "Abonado $200.000 de $335.000".
  - El pago en línea y el bot cobran **$135.000**.
  - Si el abono se hizo dentro del plazo del descuento, lo que falta se calcula con el precio con descuento.
  - Un comprobante que todavía no se aprueba, o que fue rechazado, **no** descuenta nada.
- **Un efecto extra corregido:** después de un abono, aprobar un comprobante sin monto inflaba el recaudo. Una factura de $335.000 quedaba con $535.000 recibidos. Ahora solo se cuenta lo que faltaba.

### 3. La misma factura aparecía "Vencida" y "Pendiente" a la vez

- **Antes:** la casa 103 tenía agosto sin pagar el 9 de octubre, y su mora había empezado el 16 de septiembre. Esa misma factura se mostraba así:
  - el resumen de "Mis facturas" decía "Vencida";
  - la fila de la factura y el inicio decían "Pendiente";
  - la campana decía "Por pagar";
  - Finanzas mostraba **0 vencidas**.
- **Por qué pasaba:** unas pantallas calculaban la mora según la fecha. Otras leían un dato guardado que solo cambia cuando llega la factura del mes siguiente.
- **Después:** hay una sola regla en toda la plataforma: si la casa está en mora, su factura vigente se muestra **"Vencida"**.
  - Aplica en el inicio, "Mis facturas", la campana, Finanzas (también en el contador de vencidas), el estado de cuenta, el tablero de la administración, la app y el bot.
  - No cambian las facturas que están dentro del plazo, las que se pagaron tarde ni las que quedaron en cero.
- **Se mantuvo una regla actual:** si la casa abonó a la factura, no se considera en mora. El informe de QA dejó esto como una pregunta para el negocio (ver "Pendientes y recomendaciones").

### 4. Arrendatarios con el contrato vencido seguían entrando a la casa

- **Antes:** una arrendataria tenía un contrato con la casa 102 que terminó el 1 de septiembre.
  - Ya no veía las facturas, lo cual era correcto.
  - Pero el inicio le decía "Estás al día", y el encabezado, "Casa 102 · Arrendatario".
  - "Mi unidad" le mostraba la casa con sus vehículos.
  - "Visitantes" le ofrecía "Autorizar visitante".
- **Lo que encontramos al revisar a fondo:** el sistema **no solo lo mostraba, también lo permitía**. Con su sesión, la persona podía:
  - autorizar visitantes, lo que avisa a portería;
  - registrar asistencia y votar por esa casa en una asamblea;
  - usar el bot de WhatsApp para reservar a nombre de la casa.
- **Por qué pasaba:** la regla que revisa la fecha de fin del contrato existía, pero varias partes del sistema no la usaban. Una de ellas tenía su propia copia de la regla, sin la fecha.
- **Después:** todas las partes usan la misma regla.
  - El último día del contrato cuenta completo. Desde el día siguiente, la persona pierde el acceso a la casa.
  - En lugar de "Estás al día" ve **"No tienes una unidad vinculada"**.
  - Ya no se le ofrece autorizar visitantes, reservar ni registrar vehículos para esa casa.
  - Propietarios y arrendatarios con contrato vigente **siguen igual**.
  - La persona sigue siendo parte del conjunto: ve avisos, solicitudes y documentos.

### 5. Una factura hecha a mano daba por pagada la del mes anterior

- **Antes:** la administración creó a mano, para la casa 105, las facturas de agosto ($335.000) y septiembre ($670.000).
  - El sistema concluyó por su cuenta que agosto se había pagado: "La factura siguiente dice que quedó pagada (saldo anterior $0)".
  - Además, sumó esos $335.000 al recaudo de la contabilidad, **sin que nadie hubiera pagado**.
- **Por qué pasaba:** la factura hecha a mano no pide el "saldo anterior". El sistema leía ese espacio vacío como "no quedó debiendo nada".
- **Después:**
  - Una factura hecha a mano ya no decide si la anterior se pagó.
  - Agosto queda sin pagar hasta que haya un pago real o llegue el estado de cuenta de la contabilidad.
  - El recaudo de la contabilidad ya no cuenta ese dinero. Reportes incluye esas casas entre las que quedan "sin calcular".
  - Los pagos reales, los comprobantes y los estados de cuenta en PDF siguen funcionando igual.
- **Lo que ya había quedado mal:** se corrige solo cuando el sistema vuelve a calcular esa casa, por ejemplo con el botón "Conciliar" de Finanzas (ver recomendaciones).

### 6. La fila de "Mis facturas" se desbordaba

- **Antes:** en un portátil común (1.280 píxeles de ancho), con el pago en línea en modo de pruebas:
  - la fila tenía más contenido del que cabía: 1.140 píxeles en un espacio de 954;
  - los datos de la factura quedaban con una palabra por línea;
  - el mensaje sobre el pago en línea salía cortado ("…y, si quie");
  - al abrir y cancelar "Ya pagué", la fila quedaba corrida unos 186 píxeles.
- **Por qué pasaba:** el mensaje se dibujaba como una sola línea muy larga, que sacaba de su espacio al resto de la fila.
- **Después:**
  - El mensaje se acomoda en su propia línea, debajo del valor.
  - La fila cabe completa, sin cortes.
  - Abrir y cancelar el formulario ya no mueve nada.
  - Lo revisamos con cada variante del botón de pago, en computador (1.280 y 1.024 píxeles), tableta (768) y celular (375).

---

## ¿Cómo lo comprobamos?

1. **Reprodujimos cada problema** en una copia aislada de la plataforma, en el computador. No usamos datos reales ni servicios externos: ni el banco, ni WhatsApp, ni el servidor de producción.
2. **Escribimos 71 pruebas automáticas nuevas.** Las que reproducen los errores reportados **fallaban con la versión anterior** y **pasan con la corrección**. Así, si un problema vuelve, se detecta.
3. **Corrimos todas las pruebas del sistema: las 2.031 pasan.** La página web se construye sin errores.
4. **Revisamos las pantallas en un navegador**, a varios tamaños. Medimos que nada se desborde y que los textos y los montos sean los correctos.

## Cuidados que tuvimos

- **No se publicó nada** en el sitio que usan los clientes ni en la app.
- **No se guardó en el historial oficial del código.** Los cambios quedan listos para revisión.
- **No se modificaron datos reales**, ni de Factory ni de otros conjuntos.
- **No se hizo ningún pago** ni se habló con el banco.
- **No se cambió la estructura de la base de datos** ni se agregaron programas externos.
- **Ajustamos 5 verificaciones automáticas que ya existían.** Describían justo el comportamiento que se corrigió; por ejemplo, esperaban "Por pagar" donde ahora corresponde "Vencida". No se volvieron menos exigentes.

## Pendientes y recomendaciones

1. **Revisar y aprobar los cambios**, y guardarlos en el historial oficial.
2. **Publicar en este orden:**
   - primero el servidor;
   - después la página web, que además lleva pendientes correcciones anteriores, como la de la carga de PDF;
   - por último, una **nueva versión de la app en las tiendas**: la app no se actualiza sola.

   Mientras no se publique, el sitio y la app siguen funcionando como antes. Mientras salga la nueva versión de la app, esta seguirá mostrando el valor completo de la factura, aunque el cobro en línea ya descuente el abono.
3. **Antes de publicar, revisar los datos de los demás conjuntos.**
   - Hay que contar cuántas facturas quedaron como "pagadas" por error a causa de facturas hechas a mano.
   - Cuando el sistema las vuelva a calcular, esas casas pueden aparecer en mora y el recaudo de esos meses puede bajar.
   - Conviene avisar antes a las administraciones.
4. **Decisiones del negocio pendientes:**
   - ¿Un abono parcial debe sacar a una casa de la mora? Hoy sí la saca.
   - Cuando la mora viene de un mes anterior, ¿la factura actual debe llamarse "Vencida"? Hoy sí.
5. **Otro hallazgo, fuera de este trabajo:** cualquier residente puede consultar la lista completa de vehículos del conjunto, con el nombre de sus dueños. Lo dejamos propuesto como una tarea aparte: cambiarlo afecta a otros perfiles que sí la necesitan.
6. **Lo que no se pudo probar aquí**, y conviene repetir en Factory cuando se publique:
   - el pago real con el banco;
   - el bot de WhatsApp real;
   - la app en un teléfono;
   - los datos reales de producción.

## Conclusión

Revisamos los seis problemas. Uno ya estaba corregido, y los otros cinco **quedaron corregidos y comprobados** en una copia aislada. Para que residentes y administraciones vean el beneficio, falta **revisar y publicar** los cambios y **sacar una nueva versión** de la app.

---

### Términos usados

- **Abono:** pago parcial de una factura.
- **Factura vigente:** la más reciente de una casa. Reúne todo lo que se debe hoy.
- **Mora:** deuda vencida. En Vekino empieza el día 16 del mes siguiente al de la factura.
- **Factura hecha a mano:** la que crea la administración desde Finanzas mientras llega el estado de cuenta de la contabilidad.
- **Conciliar:** botón de Finanzas que vuelve a calcular el estado de todas las facturas del conjunto.
- **Recaudo de la contabilidad:** lo que la contabilidad da por recibido en un mes, según el estado de cuenta del mes siguiente.
- **Pago en línea:** el botón de pago de Vekino, conectado con el banco.
- **Factory:** conjunto residencial de prueba dentro de la plataforma.
- **Copia aislada:** versión de la plataforma en el computador, sin datos ni servicios reales.
