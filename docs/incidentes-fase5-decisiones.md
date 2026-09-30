# Incidentes: evidencias privadas y personas involucradas (fase 5)

## Auditoría previa

Se revisaron `convex/incidentes.ts`, `model/incidenteAcceso.ts`, `model/incidenteEvento.ts`, el esquema, `files.ts`, `model/files.ts`, `model/s3.ts`, `lib/upload-s3.ts`, `use-upload-s3`, `AdjuntosPicker`, los componentes de documentos/archivos web, `mobile/src/lib/guardia-upload.ts`, las pantallas Expo de novedades/reservas y las pruebas existentes.

- No existía `incidenteEvidencias`. Personas tenía alta y campos parciales de retiro previstos; faltaban edición y retiro. El historial ya era append-only y conservaba actor/nombre/hora de servidor.
- S3 legado firma PUT por carpeta elegida por el cliente, devuelve URL pública y borra por clave con sesión. No verifica incidente ni tenant. Los helpers web y móvil propagan esa URL. `model/files.ts` también resuelve URLs públicas y referencias Storage legadas. Ninguna de esas rutas sirve como autorización de evidencia sensible.
- Se reutilizan el SDK S3, el transporte de bytes por action Convex, el límite server-side existente de **15 MiB**, la sesión, los helpers de autorización y el historial del incidente. El bucket, las actions y la política de lectura son específicos. No se cambia `files.ts` ni el comportamiento de otros módulos.
- `AdjuntosPicker` pertenece a soporte y fija 10 MB; el transporte server-side permite 15 MiB. La ficha usa la política de su nuevo endpoint, compartida entre backend y web, sin fallback al transporte público ni subida sin límite.
- Expo SDK 54 utiliza `expo-image-picker` y `uploadLocalFile`, pero estos flujos escriben en módulos distintos (`guardia`/reservas) con URL pública. **No hay pantalla nativa del nuevo expediente `api.incidentes`**. Se mantiene la ficha web adaptable a móvil; no se agrega una segunda lógica de almacenamiento ni se redirigen módulos existentes. Una futura pantalla Expo debe conservar la captura existente y enviar los bytes a `incidenteArchivos.subir`, nunca a `files.generateUploadUrl`.

## Implementado

### Evidencias

- `incidenteEvidencias`: incidente, compañía, conjunto, `storageKey`, nombre, MIME, tamaño real, usuario/nombre de carga, `createdAt`, `retiradoEn`, usuario/nombre de retiro y motivo. Se usa `retiradoEn` según las convenciones existentes. Índice `by_incidente`.
- `incidenteEvidenciaCargas`: preparación exclusivamente interna, asociada al padre, clave generada por el servidor, metadatos y actor congelado. Conserva la preparación si falla S3 o si el permiso cambia antes del registro. `evidenciaId` vincula la carga confirmada y evita duplicar el registro/evento en una finalización repetida. No aparece en la UI.
- `incidenteArchivos.subir`: valida nombre (1–120 caracteres, sin rutas/control), extensión, MIME permitido, tamaño real no vacío y firma binaria; prepara con autorización, escribe el objeto cifrado y registra mediante mutación interna con una segunda comprobación de vigencia/actor/padre. Retorna únicamente `evidenciaId`. No admite URL, carpeta, clave, tamaño declarado, compañía, conjunto ni autor del cliente.
- Formatos iniciales: JPEG, PNG, WebP y PDF. PDF cubre documento; no se admite SVG, HTML, audio, vídeo, HEIC o tipos genéricos. La política está en `lib/incidenteEvidencias.ts`, compartida con web. Verificación de firmas no equivale a inspección antivirus o validación forense del archivo.
- `incidenteEvidencias.listar`: autorización por padre y proyección de metadatos sin clave/URL. Muestra vigentes y retiradas en categorías diferentes.
- `incidenteArchivos.acceder`: recibe exclusivamente ID de evidencia, resuelve documento/padre y comprueba autorización vigente y contexto coherente; comprueba privacidad del bucket, obtiene los bytes mediante GET server-side, verifica tamaño registrado/real y vuelve a comprobar autorización después de leer S3. Devuelve bytes/nombre/MIME, nunca una URL S3, firma reutilizable o clave. Cada nueva lectura requiere sesión y autorización del caso.
- `incidenteEvidencias.retirar`: solo gestión vigente en un caso abierto; motivo obligatorio (máximo 2000 caracteres), fecha/actor de servidor. Conserva fila y objeto; nuevas solicitudes de contenido rechazan evidencia retirada.
- `EVIDENCIA_AGREGADA` y `EVIDENCIA_RETIRADA`: evidencia, actor/nombre, fecha, descripción y motivo de retiro. Documento, actualización del caso y evento se escriben en la misma transacción.
- Ficha: sección **Evidencias del incidente**, nombre/MIME/tamaño/fecha/autor/estado, selección de archivo, envío serializado, errores con selección preservada, consulta explícita de preview/documento y retiro con motivo. Preview mediante Blob local solo después de recibir bytes autorizados; se libera al minuto, al reemplazar la vista o desmontar el componente. PDF se descarga mediante Blob local y nombre original. Errores de imagen permiten solicitar acceso de nuevo. No se crea Blob si el usuario ya abandonó la ficha durante la petición.

### Personas

- Alta conserva el alcance anterior: gestor o guarda reportante, siempre con relación vigente para escritura y caso abierto. La comprobación de vigencia también se usa al calcular los permisos visibles.
- `editarPersona` y `retirarPersona` reciben exclusivamente ID de persona y datos/motivo. Cargan persona → incidente, autorizan `incidentes.gestionar`, comprueban consistencia de tenants y bloquean casos cerrados/personas retiradas.
- Edición completa de nombre, tipo, documento y observación. Omitir un opcional lo vacía; la UI permite hacerlo. Validación mantiene 160/80/80/2000 caracteres existentes. Una operación sin cambios no genera eventos vacíos.
- `PERSONA_AGREGADA` incluye ID (también para altas iniciales). `PERSONA_EDITADA` registra cada diferencia antes/después, incluso al vaciar opcionales. `PERSONA_RETIRADA` conserva ID, actor/nombre, hora y motivo.
- Retiro lógico con motivo obligatorio; no hay eliminación física. Ficha separa **Actualmente involucradas** y **Personas retiradas del caso**. Alta/edición/retiro tienen formularios, confirmación del resultado y datos conservados ante errores; las queries reactivas actualizan la ficha.
- Las personas son snapshots del hecho y no dependen de `users`, de membresías activas ni de que la relación laboral subsista. Dar de baja un usuario no invalida ni retira automáticamente a una persona involucrada.

### Responsable

Se conserva la política histórica existente: `responsableUserId` y `responsableNombre` permanecen en el caso, y ficha/bandeja leen el nombre congelado. No se reemplaza por el nombre actual ni se limpia al desactivar usuario/miembro/asignación. La lectura histórica no da autoridad al responsable antiguo: cualquier nueva acción exige la cadena vigente del actor.

La selección y nueva asignación siguen usando `exigirResponsableIncidente`: usuario activo, miembro activo de la misma compañía; supervisor con asignación vigente al conjunto o administrador de compañía. La reasignación explícita ya existe y registra antes/después. No se crea reasignación automática por baja ni se modifica retroactivamente la identidad.

## Seguridad y privacidad

La autorización sigue siendo la del incidente: **sesión → hijo almacenado → incidente padre → compañía/conjunto almacenados → rol, contrato, asignación y relación vigente → operación**. Para altas, todavía sin hijo, el punto de entrada es el incidente almacenado. Los tenants duplicados del hijo se comprueban como consistencia, nunca como fuente independiente de autoridad. Las APIs públicas no aceptan tenants/identidad para hijos ni acceso por `storageKey`.

- Administrador de compañía y plataforma mantienen su alcance preexistente; supervisor requiere asignación vigente; guarda solo sus incidentes. El administrador conserva lectura histórica tras terminar contrato, pero no puede escribir. CERRADO conserva lectura y bloquea toda escritura.
- Alta de persona/evidencia usa el mismo helper operativo; edición/retiro usan gestión. Los permisos de UI se calculan desde estos helpers; cada función backend vuelve a comprobarlos. No se crean capacidades de rol independientes.
- El bucket de evidencias es **distinto del público**, con credenciales específicas y los cuatro bloqueos públicos. Cada subida y lectura comprueba `GetPublicAccessBlock`; configuración ausente, bucket reutilizado, bloqueo parcial o fallo de comprobación rechazan la operación.
- Conocer la clave no habilita la API de evidencias. Las actions legadas siguen fijando su bucket público, por lo que no pueden borrar/escribir objetos del bucket privado usando una clave conocida.
- No se emiten URLs S3, ni públicas ni firmadas, al cliente. Conocer la URL del objeto, la clave o un ID no permite descargar: el bucket deniega acceso anónimo y la action exige sesión/alcance por el padre en cada lectura. El navegador representa bytes ya autorizados mediante `blob:` local; esa referencia no es una URL de almacenamiento y no permite a otra sesión descargar desde S3. Se revoca al minuto o al salir/reemplazar la vista. Como cualquier descarga autorizada, no se puede revocar una copia de los bytes que el usuario ya recibió. El cliente no persiste URLs y usa `no-referrer`.
- Las lecturas usan el mismo transporte acotado de Convex que la subida. No se recurre a un fallback de URL pública o firmada por tamaño/red; los archivos fuera del límite se rechazan. El cifrado y `CacheControl: private, no-store` se fijan al escribir el objeto.

La configuración de los cuatro bloqueos sigue el mecanismo documentado por [AWS S3 Block Public Access](https://docs.aws.amazon.com/AmazonS3/latest/userguide/access-control-block-public-access.html). La subida conserva el margen existente respecto al [límite de argumentos de Convex](https://docs.convex.dev/production/state/limits).

## Configuración y despliegue

Plantilla versionada: `infra/incidentes/storage.cloudformation.json`. Crea bucket privado con ownership `BucketOwnerEnforced`, cifrado AES256, versionado, TLS obligatorio, cuatro bloqueos, `DeletionPolicy`/`UpdateReplacePolicy: Retain`. No incluye CORS (el browser no hace PUT), ACL pública ni lifecycle de eliminación. Genera una política IAM con **solo** `s3:GetBucketPublicAccessBlock` en el bucket y `s3:PutObject`/`s3:GetObject` en `incidentes/*`; no concede DeleteObject, ACL ni cambios de bucket.

Pasos para el responsable del despliegue (no ejecutados en esta tarea):

1. Crear la infraestructura en la cuenta/región habitual con la plantilla, un `BucketName` único distinto del público y capacidad `CAPABILITY_IAM`. Conservar los outputs `BucketName` y `RuntimePolicyArn`.
2. Adjuntar la política del output a un principal dedicado al backend de incidentes, sin permisos públicos ni permisos adicionales de borrado. Gestionar sus credenciales mediante el procedimiento habitual de secretos de la organización; no guardarlas en el repositorio ni en `NEXT_PUBLIC_*`.
3. Configurar en **Convex backend** `AWS_INCIDENTES_BUCKET_NAME`, `AWS_INCIDENTES_REGION`, `AWS_INCIDENTES_ACCESS_KEY_ID` y `AWS_INCIDENTES_SECRET_ACCESS_KEY`. Región usa `AWS_REGION`/`us-east-1` si no se define; fijarla explícitamente para el despliegue. No cambiar `AWS_S3_BUCKET_NAME` del resto de módulos.
4. Publicar esquema/funciones mediante el flujo habitual de Convex antes del frontend. Nuevas tablas tienen `by_incidente`; los campos nuevos en personas/eventos son opcionales para compatibilidad con históricos. No requiere reconstruir nombres antiguos ni modificar eventos existentes.
5. En un entorno autorizado de validación, subir un archivo válido, comprobar lectura autenticada de bytes, rechazar sesión fuera de alcance, comprobar acceso anónimo denegado a su objeto y comprobar retiro. Las pruebas automatizadas simulan AWS; no confirman configuración real de una cuenta S3.

La primera ejecución de `convex codegen --typecheck disable` generó correctamente bindings/bundles de los nuevos módulos. La revisión automática rechazó repetir el comando ordinario por el riesgo de enviar bundles al entorno configurado. La comprobación final usó el modo oficial `convex codegen --dry-run --typecheck disable` y pasó. El CLI de componentes analiza el bundle sin ejecutar `finishPush`; el modo final envía además `dryRun: true`. No se ejecutó `convex deploy`, infraestructura AWS ni despliegue de producción.

## Verificación

Las pruebas nuevas cubren autorización por padre, aislamiento de compañías en conjunto compartido, conjunto ajeno, incoherencia de tenants del hijo, guarda/otro reportante, ausencia de sesión, contratos terminados, baja histórica, nuevas asignaciones, actor/hora de servidor, eventos append-only, retiro, MIME/firma/nombre/tamaño, privacidad del bucket, fallo de S3, cambio de vigencia entre preparación y registro e idempotencia de registro. Frontend prueba componentes reales con React/Happy DOM, eventos de formulario y respuestas Convex simuladas; no usa URLs públicas reales de S3.

| Comprobación | Resultado |
| --- | --- |
| Nuevas pruebas backend | 28 aprobadas; módulo de incidentes: 53 en total |
| Suite backend unitaria (`test:unit`) | 284 aprobadas |
| Suite backend integración/seguridad (`test:seguridad -- --maxWorkers=2`) | 518 aprobadas en 21 archivos |
| Frontend (`test:incidentes`) | 31 aprobadas: 18 anteriores y 13 nuevas de interacción |
| Typecheck web y backend | Ambos aprobados |
| Typecheck global (`bun run typecheck`) | Continúa el error ajeno de móvil en `convex/auth.ts:34`, TS7006, parámetro `s` con `any` implícito. `auth.ts` no se modifica |
| Build global (`bun run build`) | Aprobado, Next 16 genera las rutas web de incidentes/guardia |
| Codegen Convex | Bindings iniciales generados; comprobación final aprobada con `--dry-run`, incluido el esquema en el bundle de análisis |
| Plantilla storage | JSON válido; verificados bloqueos, Retain y acciones IAM. No aplicada/validada contra una cuenta AWS |
| `git diff --check` | Aprobado |
| Lint web | Sigue fallando `next lint`: Next 16 interpreta `apps/web/lint` como ruta inexistente. Fuera de alcance; script sin modificar |

La verificación de UI es automatizada mediante SSR y DOM con eventos. No se realizó una sesión autenticada contra Convex/S3 desplegados ni una validación nativa Expo. El build descarga las fuentes remotas configuradas por el proyecto; no se cambió ese mecanismo. La dependencia de prueba Happy DOM se limita a `devDependencies`. El archivo `next-env.d.ts` alterado automáticamente por el build se restauró a su contenido original y el typecheck web volvió a pasar.

## Decisiones pendientes

- Retención y eliminación física definitiva, tanto de evidencias retiradas como de objetos/preparaciones sin registro final. Se conservan objeto, preparación y auditoría; no se programa limpieza ni se añade DeleteObject. Hace falta acordar plazo, responsabilidades, conciliación y requisitos de conservación antes de automatizar.
- Reasignación automática o avisos por baja de responsable. Continúa disponible la reasignación explícita existente; no se inventan automatismos.
- Integración de una futura ficha nativa Expo del nuevo módulo. La infraestructura móvil auditada utiliza los módulos anteriores y no es una ruta segura para evidencias del expediente. La operación móvil actual de esta fase es la ficha web responsive.

No se implementan dashboard, métricas, reportes, exportaciones, SLA, notificaciones, catálogos configurables, automatizaciones ni un sistema documental general.
