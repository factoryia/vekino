# Informe: corrección del acceso a la carga de facturas y al reporte de incidentes

**Proyecto:** Vekino (plataforma web)
**Período del trabajo:** 9 al 13 de octubre de 2026
**Estado:** corregido y probado. Falta publicarlo.

---

## Resumen

- Dos funciones de la plataforma rechazaban a usuarios que **sí habían iniciado sesión**:
  - la **carga de facturas en PDF**, que usa la administración de cada conjunto;
  - la **descarga del reporte de incidentes**, que usan las compañías de vigilancia.
- Investigamos si era un error real o solo un problema del ambiente de pruebas. **Era un error real y afectaba a todos los usuarios.**
- Lo corregimos con un cambio pequeño y localizado, **sin debilitar la seguridad**.
- Lo probamos con pruebas automáticas y directamente en la aplicación, con usuarios de prueba. **Funciona.**
- **Falta publicarlo.** En este trabajo no se publicó nada ni se modificó información real, tal como se pidió.

---

## ¿Qué estaba pasando?

Cuando una persona inicia sesión, la plataforma le entrega una especie de **"pase"**, que queda guardado en su navegador. Casi toda la plataforma revisa ese pase directamente y funciona bien.

Hay tres operaciones que pasan por un intermediario: el servidor de la propia página web. Al llamar a ese intermediario, **el navegador no le mostraba el pase**. El servidor, al no verlo, respondía "inicia sesión" o "no tienes acceso", aunque la persona ya había iniciado sesión.

Las tres operaciones afectadas eran:

1. Ver la **vista previa** de un PDF de facturas antes de cargarlo.
2. **Confirmar** la carga de esas facturas.
3. **Descargar el reporte de incidentes** (en CSV, Excel o PDF).

**¿Desde cuándo?** El 2 de agosto se hizo un cambio para arreglar el inicio de sesión con Google, y ese cambio movió el lugar donde se guarda el pase. Las tres operaciones se construyeron después, así que **nunca funcionaron en un navegador real**. Las pruebas automáticas no lo detectaron porque simulaban que la sesión ya existía.

**¿La corrección afecta el inicio de sesión con Google?** No. La corrección no deshace el cambio del 2 de agosto: el pase se sigue guardando en el mismo lugar y el inicio de sesión no se modificó. Lo único nuevo es que, en esas tres operaciones, la página toma ese mismo pase y también se lo muestra al intermediario.

---

## ¿A quién afecta hoy?

En el sitio publicado (www.vekino.com):

- **Reporte de incidentes:** no se puede descargar. Quien lo intenta recibe el mensaje "No tienes acceso a este reporte. Revisa tu sesión."
- **Carga de facturas:** el sitio publicado tiene una versión anterior. No presenta este error porque **no comprueba quién la usa**, y eso es un riesgo de seguridad ya identificado en la auditoría de facturación. La versión nueva sí hace esa comprobación, pero sin esta corrección habría dejado a todas las administraciones sin poder cargar facturas.

---

## ¿Qué hicimos?

1. **Diagnóstico.** Revisamos el código y reprodujimos el problema en dos lugares:
   - una copia aislada en el computador, sin datos ni servicios reales;
   - el conjunto de prueba **Factory**, con un inicio de sesión real.

   Así confirmamos que no era un problema del ambiente de pruebas.

2. **Corrección.** La página web ahora **muestra el pase** cuando llama a esas tres operaciones.
   - Lo hace un solo componente, que se reutiliza en las tres.
   - Solo entrega el pase a la propia plataforma, nunca a sitios externos.
   - El servidor sigue comprobando, como antes, **quién es la persona y qué permisos tiene**.

3. **Pruebas automáticas.**
   - Agregamos **35 pruebas nuevas**, entre ellas una que reproduce todo el proceso de inicio de sesión.
   - Pasan las **342 pruebas** de la página web y las del servidor de datos.
   - Comprobamos que, **si se quita la corrección, las pruebas nuevas fallan**. Si el problema volviera a aparecer, lo detectarían.

4. **Pruebas en la aplicación real**, en el conjunto de prueba Factory y con cuentas de prueba:

| Qué probamos | Resultado |
|---|---|
| Vista previa de un PDF de facturas de prueba | ✅ Funciona: leyó correctamente las 2 facturas del documento |
| Confirmar la carga | ✅ La plataforma reconoce al usuario y sus permisos. La probamos solo hasta antes de guardar, para no crear facturas. El guardado completo se probó en la copia aislada |
| Descargar el reporte de incidentes | ✅ Funciona en CSV, Excel y PDF, con el contenido correcto |
| Intentos sin sesión o con una sesión falsa | ✅ La plataforma los sigue rechazando |
| Funciones que no se tocaron | ✅ Siguen funcionando igual |

---

## Cuidados que tuvimos

- **No se publicó nada** en el sitio que usan los clientes.
- **No se guardó el cambio en el historial oficial del código.** Queda listo para revisión.
- **No se modificaron datos reales.** Para probar el reporte creamos, con autorización, **un único incidente de prueba** en Factory, marcado claramente como prueba. Sigue abierto y se puede cerrar.
- **Los inicios de sesión los hizo la persona responsable.** El asistente no usó contraseñas reales, y no se mostraron ni guardaron datos de acceso.

---

## Pendientes y recomendaciones

1. **Publicar la corrección junto con la nueva versión de la web.**
   - Mientras no se publique, el reporte de incidentes seguirá fallando para todos, y la carga de facturas publicada seguirá sin comprobar quién la usa.
   - No conviene publicar la nueva carga de facturas sin esta corrección: nadie podría usarla.
2. **Revisar y aprobar los cambios** antes de incorporarlos al código oficial.
3. **Mejorar un mensaje.** Cuando alguien sin permiso intenta descargar el reporte, la plataforma le dice "revisa tu sesión". Conviene un mensaje distinto para "no has iniciado sesión" y para "no tienes permiso".
4. **Cerrar el incidente de prueba** de Factory cuando ya no se necesite.

---

## Conclusión

El problema está **entendido, corregido y comprobado** en la aplicación. Para que los usuarios vean el beneficio, **solo falta publicar** la nueva versión de la página web.

---

### Términos usados

- **Producción / sitio publicado:** la plataforma que usan los clientes (www.vekino.com).
- **Factory:** conjunto residencial de prueba dentro de la plataforma, que usamos para verificar cambios sin afectar a clientes reales.
- **Copia aislada:** versión de la plataforma en el computador, sin datos ni servicios reales, para probar sin riesgos.
