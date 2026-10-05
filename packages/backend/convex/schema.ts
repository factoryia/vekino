import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  platformRoleValidator,
  operationalRoleValidator,
  vinculoUnidadValidator,
  tipoDocumentoValidator,
  subscriptionPlanValidator,
  tipoUnidadValidator,
  estadoUnidadValidator,
  companiaRoleValidator,
  estadoCompaniaValidator,
  rolAsignacionValidator,
  prioridadIncidenteValidator,
  estadoIncidenteValidator,
  tipoEventoIncidenteValidator,
  estadoItemValidator,
  tipoNovedadItemValidator,
  rolActorDepositoValidator,
  origenDepositoValidator,
  tipoInasistenciaValidator,
  estadoInasistenciaValidator,
} from "./model/roles";

/**
 * SCHEMA VEKINO (unificado, multi-tenant en una sola base Convex).
 *
 * La identidad/credenciales (email, password hash, sesiones) las gestiona el
 * componente Better Auth (`@convex-dev/better-auth`) en sus propias tablas
 * internas. Aquí guardamos el PERFIL de aplicación y toda la lógica de negocio,
 * enlazando con Better Auth mediante `users.authId`.
 *
 * Aislamiento entre condominios: por `condominioId` en cada tabla de negocio
 * (reemplaza el esquema anterior de una base de datos por condominio).
 */
export default defineSchema({
  // ─────────────────────────────────────────────────────────────
  // Condominios (tenants)
  // ─────────────────────────────────────────────────────────────
  condominios: defineTable({
    name: v.string(),
    subdomain: v.optional(v.string()),

    // Institucional
    nit: v.optional(v.string()),
    address: v.optional(v.string()),
    city: v.optional(v.string()),
    country: v.optional(v.string()),
    timezone: v.optional(v.string()), // IANA, ej "America/Bogota"

    // Marca
    logo: v.optional(v.string()),
    /** Foto destacada del home (app móvil / portal). URL pública S3. */
    coverImage: v.optional(v.string()),
    primaryColor: v.optional(v.string()),

    // Pagos: URL del portal público de AvalPayCenter (deep-link por convenio,
    // ej ...realizar-pago?idConv=00003230). Si está presente, el botón "Pagar"
    // abre este portal en vez de usar la API de la pasarela.
    avalPortalUrl: v.optional(v.string()),

    /**
     * Aporte voluntario de areas comunes (el cupo de parqueadero).
     *
     * No se guarda quien pago: eso ya esta en las facturas, en la linea de
     * concepto "CONT VOLUNTARIA AREAS COMUN". Lo unico que hace falta
     * configurar es con que se comparan esos montos.
     *
     * Va en el condominio y no quemado en el codigo porque las tarifas suben
     * cada ano con el IPC, y porque el umbral de mora es una decision de
     * cada administracion. Si Adriana dice que la regla es otra, esto es
     * cambiar un numero.
     */
    aporteVoluntario: v.optional(
      v.object({
        /** Tarifa mensual por carro. En Ciudad del Campo, $7.000. */
        tarifaCarro: v.number(),
        /** Tarifa mensual por moto. En Ciudad del Campo, $3.000. */
        tarifaMoto: v.number(),
        /**
         * Meses de atraso a partir de los cuales sale en rojo.
         *
         * Adriana dijo "60 dias o mas". Dos meses es la lectura directa de
         * eso con lo que se puede calcular hoy: cuanto debe, dividido entre
         * la tarifa. Configurable porque la regla exacta esta por confirmar.
         */
        mesesParaMora: v.number(),
      }),
    ),

    // Plan / límites
    subscriptionPlan: v.optional(subscriptionPlanValidator),
    unitLimit: v.optional(v.number()),
    planExpiresAt: v.optional(v.number()),
    activeModules: v.array(v.string()),

    isActive: v.boolean(),

    // Trazabilidad de la migración desde el sistema anterior (Prisma/Cockroach)
    legacyDatabaseName: v.optional(v.string()),
    legacyId: v.optional(v.string()),

    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_subdomain", ["subdomain"])
    .index("by_isActive", ["isActive"])
    .index("by_legacyDatabaseName", ["legacyDatabaseName"]),

  // ─────────────────────────────────────────────────────────────
  // Usuarios (perfil de aplicación) — Capa 1 de roles
  // ─────────────────────────────────────────────────────────────
  users: defineTable({
    // Enlace con el usuario de Better Auth (fuente de la credencial)
    authId: v.optional(v.string()),

    name: v.string(),
    email: v.string(),
    emailVerified: v.boolean(),
    image: v.optional(v.string()),
    /** Avatar en Convex Storage; la URL se resuelve al leer (no caduca). */
    imageStorageId: v.optional(v.id("_storage")),
    /** Object key en S3 del avatar actual (para borrar al reemplazar). */
    imageS3Key: v.optional(v.string()),

    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    tipoDocumento: v.optional(tipoDocumentoValidator),
    numeroDocumento: v.optional(v.string()),
    telefono: v.optional(v.string()),
    /**
     * Teléfono canónico E.164 ("+573001234567"), derivado de `telefono` en
     * cada escritura (lib/telefono.ts). Es lo único indexado: WhatsApp/YCloud
     * identifica al remitente por este valor. OJO: no es único (parejas
     * comparten número) — consultar con .collect(), nunca .unique().
     */
    telefonoE164: v.optional(v.string()),

    /**
     * La contraseña actual la generó la administración (envío masivo de
     * credenciales) y el usuario todavía no la ha cambiado. Sirve para
     * recordárselo al entrar; NO bloquea el acceso.
     */
    claveTemporal: v.optional(v.boolean()),
    /**
     * Identidad de WhatsApp de Meta, cuando la persona activó su @usuario y
     * dejó de compartir su número. Es lo único con lo que se le puede
     * reconocer: sin esto, cada vez que escribe hay que volver a preguntarle
     * quién es. Se guarda al vincularla a mano una primera vez.
     */
    waBsuid: v.optional(v.string()),
    waUsername: v.optional(v.string()),
    /**
     * Cuándo entró de verdad por última vez. `authId` NO sirve para esto: se
     * estampa al CREAR al residente (users.createCondoMember), así que hay
     * gente marcada como si tuviera cuenta activa sin haber abierto nunca la
     * plataforma. Esto lo escribe `ensureProfile`, que solo corre con una
     * sesión resuelta.
     */
    ultimoIngresoAt: v.optional(v.number()),

    /**
     * Última vez que el usuario abrió su campana de notificaciones. Todo lo
     * creado después cuenta como "sin leer" en el feed (notificaciones.feed).
     */
    notificacionesVistasAt: v.optional(v.number()),

    active: v.boolean(),

    // Capa 1: rol de plataforma. undefined = usuario normal.
    platformRole: v.optional(platformRoleValidator),

    // Trazabilidad de migración
    legacyId: v.optional(v.string()),
    legacyDatabaseName: v.optional(v.string()),

    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_authId", ["authId"])
    .index("by_email", ["email"])
    .index("by_numeroDocumento", ["numeroDocumento"])
    .index("by_platformRole", ["platformRole"])
    .index("by_legacyId", ["legacyId"])
    .index("by_telefono", ["telefonoE164"])
    .index("by_wa_bsuid", ["waBsuid"]),

  // ─────────────────────────────────────────────────────────────
  // Membresías (usuario ↔ condominio) — Capa 2 de roles
  // ─────────────────────────────────────────────────────────────
  memberships: defineTable({
    userId: v.id("users"),
    condominioId: v.id("condominios"),

    // Capa 2: uno o varios roles operativos dentro de este condominio.
    roles: v.array(operationalRoleValidator),

    // Para "apoderado": a qué usuario (propietario) representa dentro del condominio.
    representaAUserId: v.optional(v.id("users")),

    isActive: v.boolean(),

    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_condominio", ["condominioId"])
    .index("by_condominio_user", ["condominioId", "userId"]),

  // ─────────────────────────────────────────────────────────────
  // Unidades (inmuebles)
  // ─────────────────────────────────────────────────────────────
  unidades: defineTable({
    condominioId: v.id("condominios"),
    tipo: tipoUnidadValidator,
    estado: estadoUnidadValidator,

    torre: v.optional(v.string()),
    bloque: v.optional(v.string()),
    numero: v.string(),
    coeficiente: v.optional(v.number()), // coeficiente de copropiedad (%)

    legacyId: v.optional(v.string()),

    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_condominio", ["condominioId"])
    .index("by_condominio_numero", ["condominioId", "numero"])
    .index("by_legacyId", ["legacyId"]),

  // ─────────────────────────────────────────────────────────────
  // Usuario ↔ Unidad (una persona puede estar en varias unidades y viceversa)
  // ─────────────────────────────────────────────────────────────
  usuarioUnidad: defineTable({
    membershipId: v.id("memberships"),
    unidadId: v.id("unidades"),
    condominioId: v.id("condominios"), // desnormalizado para filtros por tenant
    vinculo: vinculoUnidadValidator,
    esPrincipal: v.boolean(), // unidad principal del usuario

    /**
     * Vigencia del vinculo. Para los arrendatarios, el periodo del contrato.
     *
     * Un arrendatario no deberia seguir viendo las facturas, los visitantes
     * ni las asambleas de una casa donde ya no vive. Con `vigenciaHasta`
     * puesta, el acceso se corta solo el dia que se vence: `misUnidadIds` no
     * devuelve la unidad y con eso deja de ver todo lo que cuelga de ella.
     *
     * Se filtra al leer y no con un cron a proposito. Un cron se puede caer,
     * atrasar o no haber corrido todavia, y el dia que eso pase alguien
     * estaria viendo la casa de otro. Filtrando al leer, el corte es exacto.
     *
     * Sin fechas el vinculo es indefinido, que es lo normal para el
     * propietario y para quien vive con el.
     */
    vigenciaDesde: v.optional(v.number()),
    vigenciaHasta: v.optional(v.number()),

    /**
     * Quien creo el vinculo, cuando no fue la administracion.
     *
     * El propietario puede dar de alta a los suyos, asi que hace falta poder
     * responder quien metio a alguien a una casa.
     */
    creadoPorUserId: v.optional(v.id("users")),
    createdAt: v.number(),
  })
    .index("by_membership", ["membershipId"])
    .index("by_unidad", ["unidadId"])
    .index("by_condominio", ["condominioId"]),

  // ─────────────────────────────────────────────────────────────
  // Facturas / Cuentas de cobro
  // ─────────────────────────────────────────────────────────────
  facturas: defineTable({
    condominioId: v.id("condominios"),
    unidadId: v.id("unidades"),
    membershipId: v.optional(v.id("memberships")), // responsable del pago

    // Identificación
    numeroFactura: v.string(), // ej "FAC-2026-03-0001"
    numeroInterno: v.string(), // consecutivo puntosoftware, ej "8956"
    periodo: v.string(), // ej "2026-03"
    periodoLabel: v.string(), // ej "01-marzo-2026"

    // Residente/unidad
    residenteNombre: v.string(),
    apto: v.optional(v.string()), // ej "4201"
    vrAdmon: v.number(), // cuota base del mes (ej 274000)

    // Desglose de líneas (cada concepto con su saldo anterior + actual + total)
    lineas: v.array(
      v.object({
        codigo: v.number(), // 1-7
        concepto: v.string(), // "Administración de marzo", "Intereses mora", etc
        saldoAnterior: v.number(),
        actual: v.number(),
        total: v.number(),
      })
    ),

    // Totales
    saldoAFavor: v.number(),
    totalAPagar: v.number(), // sin descuento (pago del 16 al 30)
    totalConDescuento: v.optional(v.number()), // pago del 1 al 15

    // Fechas
    fechaEmision: v.number(), // timestamp
    fechaVencimiento: v.number(), // timestamp (día 15 del siguiente mes)
    estado: v.union(
      v.literal("pendiente"),
      v.literal("pagada"),
      v.literal("vencida"),
      v.literal("abonada"),
      v.literal("saldo_a_favor"),
    ),

    // Archivos
    pdfUrl: v.optional(v.string()),

    // Trazabilidad de migración
    legacyId: v.optional(v.string()),

    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_condominio", ["condominioId"])
    .index("by_unidad", ["unidadId"])
    .index("by_membership", ["membershipId"])
    .index("by_periodo", ["periodo"])
    .index("by_condominio_periodo", ["condominioId", "periodo"])
    .index("by_estado", ["estado"])
    .index("by_legacyId", ["legacyId"]),

  // ─────────────────────────────────────────────────────────────
  // Pagos — Pasarela de Pagos Aval (AV Villas / PSE, tarjeta, Pagos Aval)
  //
  // Cada intento de pago de una factura contra la pasarela Aval. El flujo es:
  //   1. crearPagoFactura  → oauth2-token + Payments_Trn/Trn  → estado "iniciada",
  //      guarda pmtAuthId y la URL de la pasarela a la que redirigimos.
  //   2. El usuario paga en la pasarela y vuelve a nuestra URL de retorno.
  //   3. consultarEstado   → Payments_BasicData/BasicData/{pmtAuthId}. Se reintenta
  //      cada 2 min hasta un estado final (aprobada/rechazada/...). Al aprobar,
  //      la factura asociada pasa a "pagada" en tiempo real.
  // ─────────────────────────────────────────────────────────────
  pagos: defineTable({
    condominioId: v.id("condominios"),
    unidadId: v.id("unidades"),
    facturaId: v.id("facturas"),
    membershipId: v.optional(v.id("memberships")),
    userId: v.optional(v.id("users")),

    // Identificadores de la pasarela
    rqUID: v.string(),                 // X-RqUID único que enviamos por transacción
    pmtAuthId: v.optional(v.string()), // PmtAuthId devuelto por Trn (== PmtId en BasicData)
    invoiceNum: v.string(),            // referencia enviada a Aval: el numero de la casa (lib/referenciaPago.ts)
    approvalId: v.optional(v.string()), // X-ApprovalId final (ACH/banco/Redeban)

    // Montos
    monto: v.number(),                 // en pesos colombianos
    moneda: v.string(),                // "COP"

    // Estado del pago
    estado: v.union(
      v.literal("iniciada"),       // Trn creada, redirigido a la pasarela
      v.literal("pendiente"),      // Aval reporta pendiente (StatusCode 1)
      v.literal("aprobada"),       // StatusCode 4
      v.literal("rechazada"),      // StatusCode 2
      v.literal("fallida"),        // StatusCode 3
      v.literal("expirada"),       // StatusCode 5
      v.literal("no_autorizada"),  // StatusCode 6
      v.literal("error")           // fallo nuestro creando la transacción
    ),
    statusCodeAval: v.optional(v.string()), // StatusCode crudo de Aval
    medioPago: v.optional(v.string()),      // "PSE" | "TC" | "Pagos AVAL"
    banco: v.optional(v.string()),          // BankName (para PSE)

    // URLs y ambiente
    redirectUrl: v.optional(v.string()),    // front de la pasarela (destino del usuario)
    ambiente: v.string(),                    // "qa" | "prod"

    // Trazabilidad (respuestas crudas para auditoría/soporte)
    trnRaw: v.optional(v.any()),
    basicDataRaw: v.optional(v.any()),
    error: v.optional(v.string()),

    intentosConsulta: v.number(),   // cuántas veces se ha consultado BasicData
    fechaPago: v.optional(v.number()), // timestamp del pago aprobado (EffDt)

    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_factura", ["facturaId"])
    .index("by_condominio", ["condominioId"])
    .index("by_pmtAuthId", ["pmtAuthId"])
    .index("by_rqUID", ["rqUID"])
    .index("by_estado", ["estado"]),

  // ─────────────────────────────────────────────────────────────
  // Vehículos registrados por unidad
  // ─────────────────────────────────────────────────────────────
  vehiculos: defineTable({
    condominioId: v.id("condominios"),
    unidadId: v.id("unidades"),
    placa: v.string(),
    tipo: v.union(v.literal("carro"), v.literal("moto"), v.literal("bicicleta"), v.literal("otro")),
    marca: v.optional(v.string()),
    color: v.optional(v.string()),
    observaciones: v.optional(v.string()),
    /**
     * Cuando se archivo. Un vehiculo archivado no sale en los buscadores.
     *
     * Se archiva en vez de borrarse porque el guarda necesita poder mirar
     * atras: si el carro se vendio y alguien pregunta por un reporte de hace
     * tres meses, la placa tiene que seguir existiendo. Y si el vehiculo
     * vuelve, se desarchiva en vez de quedar registrado dos veces.
     */
    archivadoEn: v.optional(v.number()),
    legacyId: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_condominio", ["condominioId"])
    .index("by_unidad", ["unidadId"])
    .index("by_legacyId", ["legacyId"]),

  // ─────────────────────────────────────────────────────────────
  // Visitantes (control de acceso)
  //
  // Flujo A: propietario autoriza (estado "pendiente") → QR del día →
  //          guardia escanea → "activo" → salida → "finalizado".
  //          Si no ingresó ese día, el QR expira y se elimina.
  // Flujo B: walk-in en portería → "esperando_aprobacion" → el residente
  //          acepta → "activo" (o rechaza → se elimina).
  // ─────────────────────────────────────────────────────────────
  visitantes: defineTable({
    condominioId: v.id("condominios"),
    unidadId: v.id("unidades"),
    unidadNumero: v.optional(v.string()),
    autorizadoPorUserId: v.optional(v.id("users")), // propietario que autorizó
    membershipId: v.optional(v.id("memberships")),

    nombre: v.string(),
    documento: v.string(),
    tipoDocumento: v.union(
      v.literal("CC"),
      v.literal("CE"),
      v.literal("NIT"),
      v.literal("PASAPORTE"),
      v.literal("OTRO")
    ),
    tipo: v.union(
      v.literal("visitante"),
      v.literal("empresa"),
      v.literal("domicilio")
    ),
    placa: v.optional(v.string()),

    // Ventana autorizada (día civil America/Bogota)
    fechaVisitaInicio: v.optional(v.number()),
    fechaVisitaFin: v.optional(v.number()),

    estado: v.union(
      v.literal("pendiente"),
      v.literal("esperando_aprobacion"),
      v.literal("activo"),
      v.literal("finalizado"),
      v.literal("rechazado")
    ),
    fechaIngreso: v.optional(v.number()),
    fechaSalida: v.optional(v.number()),
    observaciones: v.optional(v.string()),
    qrInvalidado: v.boolean(),

    registradoPorGuardia: v.optional(v.boolean()),

    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_condominio", ["condominioId"])
    .index("by_unidad", ["unidadId"])
    .index("by_autorizado", ["autorizadoPorUserId"])
    .index("by_estado", ["condominioId", "estado"]),

  // ─────────────────────────────────────────────────────────────
  // Zonas comunes (para reservas)
  // ─────────────────────────────────────────────────────────────
  zonasComunes: defineTable({
    condominioId: v.id("condominios"),
    nombre: v.string(),
    /** Catálogo: piscina, salón, etc. */
    tipo: v.optional(
      v.union(
        v.literal("salon_social"),
        v.literal("zona_bbq"),
        v.literal("sauna"),
        v.literal("casa_eventos"),
        v.literal("gimnasio"),
        v.literal("piscina"),
        v.literal("cancha_deportiva"),
        v.literal("parqueadero"),
        v.literal("otro"),
      ),
    ),
    /** Modalidad de reserva. */
    unidadTiempo: v.optional(
      v.union(v.literal("hora"), v.literal("dia"), v.literal("mes")),
    ),
    precioPorHora: v.optional(v.number()),
    precioPorDia: v.optional(v.number()),
    precioPorMes: v.optional(v.number()),
    /** 0=Domingo … 6=Sábado */
    horariosPorDia: v.optional(
      v.array(
        v.object({
          dia: v.number(),
          horaInicio: v.string(),
          horaFin: v.string(),
        }),
      ),
    ),
    requiereAprobacion: v.optional(v.boolean()),
    /**
     * Deposito que se deja al reservar y se devuelve si se entrega limpio.
     *
     * Va en la zona y no en cada reserva porque es una regla del conjunto
     * —en Ciudad del Campo son $60.000 para las areas comunes—, no algo que
     * se negocie reserva por reserva. La reserva copia el monto vigente al
     * crearse, para que subir la tarifa no cambie lo que ya se pacto.
     */
    depositoRequerido: v.optional(v.number()),
    capacidad: v.optional(v.number()),
    descripcion: v.optional(v.string()),
    activa: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_condominio", ["condominioId"]),

  // ─────────────────────────────────────────────────────────────
  // Reservas de zonas comunes
  // ─────────────────────────────────────────────────────────────
  reservas: defineTable({
    condominioId: v.id("condominios"),
    unidadId: v.id("unidades"),
    zonaId: v.id("zonasComunes"),
    zonaNombre: v.string(),
    unidadNumero: v.string(),
    solicitanteNombre: v.string(),
    fecha: v.string(),       // "2026-07-15"
    horaInicio: v.string(),  // "09:00"
    horaFin: v.string(),     // "12:00"
    estado: v.union(
      v.literal("pendiente"),
      v.literal("aprobada"),
      v.literal("rechazada"),
      v.literal("cancelada")
    ),
    observaciones: v.optional(v.string()),
    /**
     * Deposito pactado, copiado de la zona al crear la reserva.
     *
     * Copiado y no leido de la zona: si la administracion sube el deposito
     * en marzo, una reserva hecha en febrero sigue debiendo lo que se
     * acordo. Lo que el guarda recibe de verdad vive en
     * `guardiaReservaDepositos`; esto es lo que se esperaba recibir.
     */
    depositoRequerido: v.optional(v.number()),
    /**
     * Lo que cuesta usar el espacio, congelado al crear la reserva.
     *
     * Se guarda por el mismo motivo que el deposito: la tarifa de la zona
     * cambia, y una reserva de febrero no puede empezar a valer lo que la
     * administracion cobre en marzo. Sin este campo el valor solo existia en
     * la pantalla del residente mientras llenaba el formulario, y la
     * administracion no podia verlo despues en ninguna parte.
     *
     * `undefined` cuando la zona no tiene tarifa configurada: no es gratis,
     * es que nadie le puso precio, y un cero diria lo primero.
     */
    valorReserva: v.optional(v.number()),
    /**
     * Lo que la administración (o portería) cobró de alquiler.
     *
     * El valor pactado no es un pago: hasta que alguien marca que lo recibió,
     * el reporte no puede decir "se cobró" ni "no se cobró" — solo "falta
     * registrar". Estos campos son esa marca.
     */
    pagoAlquilerMonto: v.optional(v.number()),
    pagoAlquilerAt: v.optional(v.number()),
    pagoAlquilerPorNombre: v.optional(v.string()),
    pagoAlquilerNotas: v.optional(v.string()),
    // Control operativo en portería (guardia).
    ingresoValidadoAt: v.optional(v.number()),
    salidaValidadaAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_condominio", ["condominioId"])
    .index("by_zona", ["zonaId"])
    .index("by_unidad", ["unidadId"])
    .index("by_condominio_fecha", ["condominioId", "fecha"]),

  // ─────────────────────────────────────────────────────────────
  // Novedades / Minuta de control (guardia y admin)
  // ─────────────────────────────────────────────────────────────
  novedades: defineTable({
    condominioId: v.id("condominios"),
    tipo: v.union(
      v.literal("visita"),
      v.literal("paquete"),
      v.literal("incidente"),
      v.literal("mantenimiento"),
      v.literal("otro")
    ),
    descripcion: v.string(),
    unidadNumero: v.optional(v.string()),
    autorNombre: v.string(),
    turno: v.union(v.literal("mañana"), v.literal("tarde"), v.literal("noche")),
    createdAt: v.number(),
  })
    .index("by_condominio", ["condominioId"]),

  // ─────────────────────────────────────────────────────────────
  // Documentos del condominio (Convex File Storage)
  // ─────────────────────────────────────────────────────────────
  documentos: defineTable({
    condominioId: v.id("condominios"),
    nombre: v.string(),
    categoria: v.union(
      v.literal("reglamento"),
      v.literal("acta"),
      v.literal("contrato"),
      v.literal("comunicado"),
      v.literal("financiero"),
      v.literal("otro")
    ),
    storageId: v.optional(v.id("_storage")), // legacy Convex Storage
    url: v.optional(v.string()), // S3 public URL
    s3Key: v.optional(v.string()),
    mimeType: v.string(),
    tamanio: v.number(),
    autorNombre: v.string(),
    descripcion: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_condominio", ["condominioId"])
    .index("by_categoria", ["condominioId", "categoria"]),

  // ─────────────────────────────────────────────────────────────
  // Comunicados / Avisos a residentes
  // ─────────────────────────────────────────────────────────────
  comunicados: defineTable({
    condominioId: v.id("condominios"),
    autorUserId: v.optional(v.id("users")),
    autorNombre: v.string(),

    titulo: v.string(),
    cuerpo: v.string(),

    // A quién va dirigido
    audiencia: v.union(
      v.literal("todos"),
      v.literal("propietario"),
      v.literal("arrendatario"),
      v.literal("residente"),
      v.literal("junta_directiva"),
      v.literal("guardia") // avisos dirigidos a seguridad/portería
    ),
    prioridad: v.union(
      v.literal("normal"),
      v.literal("importante"),
      v.literal("urgente")
    ),
    fijado: v.boolean(),

    // Archivos adjuntos (imágenes, PDF, documentos) — S3 preferido
    archivos: v.optional(v.array(v.object({
      storageId: v.optional(v.id("_storage")), // legacy
      url: v.optional(v.string()),
      s3Key: v.optional(v.string()),
      mimeType: v.string(),
      nombre: v.string(),
    }))),

    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_condominio", ["condominioId"]),

  // ─────────────────────────────────────────────────────────────
  // Asambleas (reuniones de propietarios)
  // ─────────────────────────────────────────────────────────────
  asambleas: defineTable({
    /* Totales del censo de unidades, congelados al abrir la sala.
     *
     * `salaEnVivo` los necesitaba para el quórum y los sacaba leyendo TODAS
     * las unidades del conjunto en cada ejecución: 384 documentos, por cada
     * uno de los 140 conectados, cada vez que alguien entraba o salía. Son dos
     * números que no cambian durante la reunión; guardarlos corta el 60% de
     * las lecturas sin que la pantalla note nada. */
    totalCoeficiente: v.optional(v.number()),
    totalUnidades: v.optional(v.number()),
    condominioId: v.id("condominios"),
    titulo: v.string(),
    tipo: v.union(v.literal("ordinaria"), v.literal("extraordinaria")),
    modalidad: v.union(v.literal("presencial"), v.literal("virtual"), v.literal("mixta")),
    fecha: v.string(),      // "2026-08-15"
    hora: v.string(),       // "18:00"
    lugar: v.optional(v.string()),
    estado: v.union(
      v.literal("programada"),
      v.literal("en_curso"),
      v.literal("finalizada"),
      v.literal("cancelada")
    ),
    quorumRequerido: v.optional(v.number()),  // % coeficiente requerido
    quorumAlcanzado: v.optional(v.number()),  // % coeficiente asistente
    agenda: v.array(v.string()),  // legado: orden del día como texto simple
    // Orden del día estructurado: cada punto puede tener su votación ligada.
    ordenDia: v.optional(
      v.array(
        v.object({
          titulo: v.string(),
          descripcion: v.optional(v.string()),
          votacionId: v.optional(v.id("votaciones")),
          /** true cuando la mesa marca el punto como realizado. */
          hecho: v.optional(v.boolean()),
        })
      )
    ),
    descripcion: v.optional(v.string()),
    actaStorageId: v.optional(v.id("_storage")), // legacy
    actaUrl: v.optional(v.string()),
    /**
     * Semilla del código rotativo de asistencia (asambleas virtuales).
     *
     * SECRETA: solo se entrega al administrador, que es quien proyecta el
     * código en la pantalla compartida. De ella se deriva un código distinto
     * cada 60 s sin escribir en la base de datos. Ver
     * `convex/lib/codigoAsistencia.ts`.
     */
    codigoAsistenciaSemilla: v.optional(v.string()),
    /**
     * Enlace externo de la reunión (Meet, Zoom…) mientras el video propio no
     * está integrado. Solo https; lo sanea `saneaEnlaceReunion`.
     */
    enlaceReunion: v.optional(v.string()),
    /**
     * Momentos reales de inicio y cierre, no la hora programada.
     *
     * La permanencia se mide contra esta ventana: si la asamblea estaba
     * citada a las 18:00 pero arrancó 18:40, quien llegó 18:35 estuvo el
     * 100 % del tiempo, no el 90 %. Los pone `setEstado`.
     */
    iniciadaEn: v.optional(v.number()),
    finalizadaEn: v.optional(v.number()),
    /**
     * Si es true, para votar hay que tener una conexión ABIERTA en la sala
     * (ver `asambleaSesiones`), no basta con haber marcado asistencia.
     *
     * Por defecto va apagado a propósito: mientras el frontend de la sala no
     * envíe latidos, todas las conexiones se cerrarían por inactividad y
     * nadie podría votar. Se enciende cuando la sala esté en producción.
     */
    exigirConexionParaVotar: v.optional(v.boolean()),
    /**
     * Presidente de esta asamblea (para acta / bitácora).
     * Lo asigna la mesa; no implica rol de sistema.
     */
    presidenteUserId: v.optional(v.id("users")),
    presidenteNombre: v.optional(v.string()),
    /**
     * Código del enlace de invitados (sin voto ni quórum).
     * Quien entra por `/invitado?codigo=…` puede hablar/compartir pantalla
     * si la mesa le da la palabra; no registra asistencia.
     */
    codigoInvitado: v.optional(v.string()),
    /**
     * Transcripción en vivo encendida (ver `salaIntervenciones`).
     *
     * Va APAGADA por defecto y solo la enciende la mesa, porque transcribir
     * es tratamiento de datos personales: mientras esté encendida la sala
     * muestra el aviso y sin ese aviso previo la grabación no es defendible.
     * El transcriptor consulta este campo y se sale de la sala si se apaga.
     */
    transcripcionActiva: v.optional(v.boolean()),
    /** Instante en que se encendió: es la constancia de cuándo se avisó. */
    transcripcionIniciadaEn: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_condominio", ["condominioId"])
    .index("by_codigo_invitado", ["codigoInvitado"])
    // El transcriptor pregunta cada pocos segundos a qué salas debe entrar.
    // Sin este índice esa consulta barrería todas las asambleas históricas
    // del sistema en cada vuelta.
    .index("by_estado", ["estado"]),

  // ─────────────────────────────────────────────────────────────
  // Asistencia a asambleas (quórum en tiempo real)
  //
  // Una fila por unidad presente. El coeficiente de la unidad suma al quórum.
  // ─────────────────────────────────────────────────────────────
  asambleaAsistentes: defineTable({
    condominioId: v.id("condominios"),
    asambleaId: v.id("asambleas"),
    unidadId: v.id("unidades"),
    unidadNumero: v.string(),
    userId: v.id("users"),
    userNombre: v.string(),
    coeficiente: v.optional(v.number()),
    esPoder: v.optional(v.boolean()), // true si asiste en representación (poder)
    createdAt: v.number(),
  })
    .index("by_asamblea", ["asambleaId"])
    .index("by_asamblea_unidad", ["asambleaId", "unidadId"])
    .index("by_asamblea_user", ["asambleaId", "userId"]),

  // ─────────────────────────────────────────────────────────────
  // Conexiones a la sala de la asamblea (permanencia y quórum instantáneo)
  //
  // `asambleaAsistentes` responde "¿entró?" con una sola marca de tiempo.
  // Esta tabla responde "¿cuánto estuvo?" y "¿estaba conectado a las 19:42,
  // cuando se votó el punto 4?" — que es lo que sostiene un acta cuando
  // alguien la impugna.
  //
  // Una fila = UN TRAMO continuo de conexión. Quien se cae y vuelve genera
  // dos filas; la permanencia es la suma de los tramos, no la resta entre la
  // primera entrada y la última salida.
  // ─────────────────────────────────────────────────────────────
  asambleaSesiones: defineTable({
    condominioId: v.id("condominios"),
    asambleaId: v.id("asambleas"),
    unidadId: v.id("unidades"),
    unidadNumero: v.string(),
    /** Quién estaba conectado por esa unidad: el dueño o su apoderado. */
    userId: v.id("users"),
    userNombre: v.string(),
    coeficiente: v.optional(v.number()),
    esPoder: v.optional(v.boolean()),

    entroEn: v.number(),
    salioEn: v.optional(v.number()),
    /**
     * Duplica `salioEn === undefined`, pero como booleano indexable.
     * Convex necesita un campo concreto para filtrar por índice, y buscar
     * las conexiones abiertas es la consulta más caliente de toda la sala.
     * Se escriben SIEMPRE juntos, en la misma mutación.
     */
    abierta: v.boolean(),
    motivoSalida: v.optional(
      v.union(
        v.literal("salida"),          // cerró la sala a propósito
        v.literal("inactividad"),     // dejó de latir: se le cayó la conexión
        v.literal("retirada_admin"),  // la mesa le quitó la asistencia
        v.literal("cierre_asamblea")  // se acabó la asamblea con él dentro
      )
    ),
    origen: v.union(
      v.literal("codigo"),        // código rotativo de la asamblea virtual
      v.literal("sala"),          // entró (o reconectó) por la sala de Vekino
      v.literal("manual_admin"),  // la mesa lo registró
      v.literal("poder_codigo"),  // apoderado con el código de su poder
      v.literal("presencial")     // asistencia presencial sin sala virtual
    ),
    /** Última señal de vida. El cron cierra lo que lleva rato mudo. */
    ultimoLatido: v.number(),
  })
    .index("by_asamblea", ["asambleaId"])
    .index("by_asamblea_unidad", ["asambleaId", "unidadId"])
    .index("by_asamblea_abierta", ["asambleaId", "abierta"])
    // Para el cron, que barre TODAS las asambleas a la vez.
    .index("by_abierta_latido", ["abierta", "ultimoLatido"]),

  // ─────────────────────────────────────────────────────────────
  // Poderes de asamblea (delegación de voto por unidad)
  //
  // Un propietario (otorgante) delega su unidad a un representante para una
  // asamblea. Debe ser validado por el representante para contar. Una unidad
  // tiene máximo un poder por asamblea.
  // ─────────────────────────────────────────────────────────────
  // ─────────────────────────────────────────────────────────────
  // Quién tiene la pestaña de la sala abierta AHORA (como Meet).
  // Distinto de asambleaSesiones: eso es permanencia por unidad / quórum.
  // Aquí cuenta PERSONAS en la reunión, aunque la mesa no tenga unidades.
  // ─────────────────────────────────────────────────────────────
  salaPresencias: defineTable({
    condominioId: v.id("condominios"),
    asambleaId: v.id("asambleas"),
    userId: v.optional(v.id("users")),
    /** Apoderado externo sin cuenta: se identifica por el código del poder. */
    codigoPoder: v.optional(v.string()),
    /**
     * Invitado externo (enlace de invitados): sesión única por persona.
     * No suma quórum ni puede votar.
     */
    codigoInvitado: v.optional(v.string()),
    nombre: v.string(),
    /** Foto de perfil (URL) para las cards tipo Meet. */
    imageUrl: v.optional(v.string()),
    esMesa: v.boolean(),
    ultimoLatido: v.number(),
  })
    .index("by_asamblea", ["asambleaId"])
    .index("by_asamblea_user", ["asambleaId", "userId"])
    .index("by_asamblea_codigo", ["asambleaId", "codigoPoder"])
    .index("by_asamblea_invitado", ["asambleaId", "codigoInvitado"])
    .index("by_latido", ["ultimoLatido"]),

  /**
   * Sesiones de invitados a la sala (enlace compartido).
   * Cada persona que entra con nombre obtiene un `sesionCodigo` propio.
   * Nunca crea filas en asambleaAsistentes / asambleaSesiones.
   */
  asambleaInvitadoSesiones: defineTable({
    condominioId: v.id("condominios"),
    asambleaId: v.id("asambleas"),
    /** Código del enlace de la asamblea al momento de unirse. */
    codigoEnlace: v.string(),
    /** Identidad de esta persona en la sala (única). */
    sesionCodigo: v.string(),
    nombre: v.string(),
    ultimoLatido: v.number(),
    createdAt: v.number(),
  })
    .index("by_sesion", ["sesionCodigo"])
    .index("by_asamblea", ["asambleaId"])
    .index("by_asamblea_enlace", ["asambleaId", "codigoEnlace"]),

  // ─────────────────────────────────────────────────────────────
  // Video propio de la sala (WebRTC, señalización por Convex)
  //
  // Sin Meet, sin Zoom, sin proveedor: la mesa publica cámara/pantalla desde
  // su navegador y cada asistente se conecta punto a punto. Convex solo
  // transporta la señalización (ofertas SDP, respuestas, candidatos ICE);
  // el video NUNCA pasa por la base de datos.
  // ─────────────────────────────────────────────────────────────
  salaEmisores: defineTable({
    condominioId: v.id("condominios"),
    asambleaId: v.id("asambleas"),
    /** Identidad de la PESTAÑA emisora (uuid por sesión de navegador). */
    clienteId: v.string(),
    userId: v.optional(v.id("users")),
    /** Invitado externo emitiendo con palabra concedida. */
    codigoInvitado: v.optional(v.string()),
    /** Apoderado por código de poder emitiendo con palabra concedida. */
    codigoPoder: v.optional(v.string()),
    nombre: v.string(),
    medio: v.union(v.literal("camara"), v.literal("pantalla")),
    /** Cámara deshabilitada (frames negros): el espectador pinta avatar. */
    camApagada: v.optional(v.boolean()),
    /** Micrófono en silencio: el espectador pinta el tachado. */
    micApagado: v.optional(v.boolean()),
    /** El emisor late; sin latido ~90 s, el cron lo retira. */
    ultimoLatido: v.number(),
    createdAt: v.number(),
  })
    .index("by_asamblea", ["asambleaId"])
    .index("by_asamblea_cliente", ["asambleaId", "clienteId"]),

  /**
   * La palabra: el residente levanta la mano, la mesa la concede y con eso
   * puede encender micrófono/cámara (equivalente al "unmute" de una reunión
   * grande). Una fila por persona y asamblea.
   */
  salaPalabra: defineTable({
    condominioId: v.id("condominios"),
    asambleaId: v.id("asambleas"),
    userId: v.optional(v.id("users")),
    /** Invitado externo (sesión del enlace de invitados). */
    codigoInvitado: v.optional(v.string()),
    /** Apoderado externo (código de poder, sin cuenta). */
    codigoPoder: v.optional(v.string()),
    nombre: v.string(),
    estado: v.union(v.literal("pedida"), v.literal("concedida")),
    /** Instantes de la concesión (auditoría / cronómetro). */
    concedidaEn: v.optional(v.number()),
    /** Si hay límite: la palabra se retira sola al llegar. */
    cierraEn: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_asamblea", ["asambleaId"])
    .index("by_asamblea_user", ["asambleaId", "userId"])
    .index("by_asamblea_invitado", ["asambleaId", "codigoInvitado"])
    .index("by_asamblea_poder", ["asambleaId", "codigoPoder"]),

  /**
   * El pulso de quien está conectado, separado de todo lo demás.
   *
   * ── Por qué existe esta tabla ─────────────────────────────────────────
   * Convex reejecuta una consulta cuando cambia CUALQUIER documento que
   * leyó, y la granularidad es el documento entero, no el campo. Mientras
   * `ultimoLatido` vivía dentro de `asambleaSesiones` y `salaPresencias`
   * —las dos tablas que lee `salaEnVivo`—, cada latido de cada persona
   * invalidaba la consulta de TODAS las demás.
   *
   * Con N personas en la sala eso son 2N escrituras cada 30 s, y cada una
   * dispara N reejecuciones: **2N² llamadas cada medio minuto**. Medido en
   * la práctica: `salaEnVivo` era la mitad del consumo de todo el proyecto,
   * y una asamblea de 300 personas —el tope del servidor de medios— habría
   * costado del orden de 87 millones de llamadas.
   *
   * Aquí el pulso cae en documentos que `salaEnVivo` no lee jamás, así que
   * latir dejó de despertar a nadie. La consulta solo se recalcula cuando
   * alguien entra o sale de verdad.
   *
   * El precio: a quien se le cae la conexión sin cerrar la pestaña deja de
   * verse en la lista cuando pasa el cron (hasta un minuto más tarde que
   * antes) en vez de al vencer su propio latido. El quórum no cambia —ya
   * dependía del cron, porque se calcula sobre `abierta`.
   */
  salaLatidos: defineTable({
    asambleaId: v.id("asambleas"),
    // Uno de los dos. Qué documento mantiene vivo este pulso.
    sesionId: v.optional(v.id("asambleaSesiones")),
    presenciaId: v.optional(v.id("salaPresencias")),
    /* El emisor del respaldo P2P. Repetía el mismo error que costó los 41 GB:
     * `salaVideo.latidoEmisor` reescribía `ultimoLatido` DENTRO de
     * `salaEmisores`, que es la tabla que la consulta `emisores` lee y filtra
     * — o sea que cada pulso despertaba la consulta de todos los
     * espectadores. No estalló porque ese día se usó LiveKit y la malla
     * quedó inerte. Ahora late aquí, como todo lo demás. */
    emisorId: v.optional(v.id("salaEmisores")),
    ultimoLatido: v.number(),
  })
    .index("by_sesion", ["sesionId"])
    .index("by_presencia", ["presenciaId"])
    .index("by_emisor", ["emisorId"])
    // Para el cron, que barre por antigüedad sin importar la asamblea.
    .index("by_latido", ["ultimoLatido"]),

  /**
   * Directorio de pistas en vivo del SFU de Cloudflare.
   *
   * Cloudflare repite medios pero no sabe quién es quién: no tiene lista de
   * participantes ni concepto de sala. Esta tabla es esa lista — lo único que
   * un cliente necesita para saber a qué suscribirse.
   *
   * Se escribe SOLO cuando alguien empieza o deja de publicar, o sea cinco o
   * seis veces en toda una asamblea. Nada de latidos aquí: ese fue el error
   * que costó 185 GB, y se repitió dos veces en este mismo proyecto (las
   * presencias y los emisores P2P). La frescura vive en `salaLatidos`.
   */
  salaPistasCf: defineTable({
    asambleaId: v.id("asambleas"),
    /** Sesión de Cloudflare de quien publica. */
    sessionId: v.string(),
    /** Nombre de la pista según Cloudflare: con esto se suscriben los demás. */
    trackName: v.string(),
    tipo: v.union(v.literal("audio"), v.literal("video"), v.literal("pantalla")),
    /** Quién publica. Uno de los tres, igual que en el resto de la sala. */
    userId: v.optional(v.id("users")),
    codigoPoder: v.optional(v.string()),
    codigoInvitado: v.optional(v.string()),
    nombre: v.string(),
    createdAt: v.number(),
  })
    .index("by_asamblea", ["asambleaId"])
    .index("by_sesion", ["sessionId"])
    .index("by_asamblea_track", ["asambleaId", "trackName"]),

  /**
   * Trozos de la grabación de una asamblea, ya a salvo en S3.
   *
   * La grabación se hace en el navegador de quien preside y hasta ahora solo
   * se descargaba a su disco AL TERMINAR: si ese portátil se dormía, se
   * quedaba sin batería o se cerraba la pestaña, el acta de una asamblea de
   * Ley 675 se quedaba sin respaldo, y nadie se enteraba hasta buscarlo.
   *
   * Ahora se sube un trozo por minuto. Lo peor que puede pasar es perder el
   * último minuto en vez de las diez horas. Los trozos van numerados porque
   * un WebM solo se reconstruye concatenándolos EN ORDEN: el primero lleva
   * la cabecera y los demás no valen nada sueltos.
   */
  salaGrabacionPartes: defineTable({
    condominioId: v.id("condominios"),
    asambleaId: v.id("asambleas"),
    /** Quién graba. Se permite más de una grabación en paralelo a propósito. */
    grabadorUserId: v.id("users"),
    /** Distingue dos grabaciones simultáneas del mismo usuario tras un F5. */
    sesionGrabacion: v.string(),
    orden: v.number(),
    url: v.string(),
    bytes: v.number(),
    createdAt: v.number(),
  })
    .index("by_asamblea", ["asambleaId"])
    .index("by_sesion_orden", ["sesionGrabacion", "orden"]),

  /** Reacciones efímeras tipo Meet (👍👏❤️…): viven unos segundos en pantalla. */
  salaReacciones: defineTable({
    condominioId: v.id("condominios"),
    asambleaId: v.id("asambleas"),
    emoji: v.string(),
    nombre: v.string(),
    userId: v.optional(v.id("users")),
    codigoPoder: v.optional(v.string()),
    codigoInvitado: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_asamblea_created", ["asambleaId", "createdAt"]),

  /** Chat de la sala: mensajes cortos entre quienes están en la llamada. */
  salaMensajes: defineTable({
    condominioId: v.id("condominios"),
    asambleaId: v.id("asambleas"),
    /* La foto se congela AQUI, al escribir el mensaje.
     *
     * Antes el chat la resolvia al leer: un `ctx.db.get` por autor mas un
     * barrido completo de `salaPresencias` para buscar avatares. Eso ataba la
     * consulta del chat a la tabla de presencias, asi que cada entrada y cada
     * salida de la sala reejecutaba el chat para los 173 conectados. 27 GB en
     * una sola asamblea. El nombre ya se guardaba asi; la foto faltaba. */
    imageUrl: v.optional(v.string()),
    texto: v.string(),
    nombre: v.string(),
    userId: v.optional(v.id("users")),
    codigoPoder: v.optional(v.string()),
    codigoInvitado: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_asamblea_created", ["asambleaId", "createdAt"]),

  /**
   * Silenciados del chat: la mesa bloquea a quien se pasa de la raya.
   * Pueden seguir viendo el chat; no pueden enviar.
   */
  salaChatSilenciados: defineTable({
    condominioId: v.id("condominios"),
    asambleaId: v.id("asambleas"),
    userId: v.optional(v.id("users")),
    codigoPoder: v.optional(v.string()),
    codigoInvitado: v.optional(v.string()),
    nombre: v.string(),
    silenciadoPorUserId: v.optional(v.id("users")),
    createdAt: v.number(),
  })
    .index("by_asamblea", ["asambleaId"])
    .index("by_asamblea_user", ["asambleaId", "userId"])
    .index("by_asamblea_poder", ["asambleaId", "codigoPoder"])
    .index("by_asamblea_invitado", ["asambleaId", "codigoInvitado"]),

  /**
   * Bitácora de la sala: entradas, palabra, votos, chat, grabación…
   * Respaldo textual de lo que pasó, alineado con el audio grabado.
   */
  salaBitacora: defineTable({
    condominioId: v.id("condominios"),
    asambleaId: v.id("asambleas"),
    tipo: v.union(
      v.literal("entrada"),
      v.literal("salida"),
      v.literal("palabra_pedida"),
      v.literal("palabra_concedida"),
      v.literal("palabra_retirada"),
      v.literal("votacion_abierta"),
      v.literal("votacion_cerrada"),
      v.literal("voto"),
      v.literal("chat"),
      v.literal("reaccion"),
      v.literal("grabacion_inicio"),
      v.literal("grabacion_fin"),
      v.literal("transcripcion_inicio"),
      v.literal("transcripcion_fin"),
      v.literal("presidente_asignado"),
    ),
    nombre: v.string(),
    detalle: v.optional(v.string()),
    userId: v.optional(v.id("users")),
    createdAt: v.number(),
  }).index("by_asamblea_created", ["asambleaId", "createdAt"]),

  /**
   * Lo que se habló, transcrito en vivo.
   *
   * Vive aparte de `salaBitacora` por volumen: una asamblea de cuatro horas
   * deja decenas de eventos y varios miles de intervenciones. Mezclarlas
   * volvería lenta la consulta de la bitácora, que es la que se pinta en
   * pantalla durante toda la reunión.
   *
   * Quién habla NO se deduce del audio. El servidor de medios entrega una
   * pista por participante y el token trae la identidad firmada, así que
   * cada segmento llega ya atribuido: no hay diarización ni conjeturas.
   *
   * El audio no se guarda en ningún momento. Pasa por el transcriptor, se
   * convierte en texto y se descarta; esto es lo único que queda.
   */
  salaIntervenciones: defineTable({
    condominioId: v.id("condominios"),
    asambleaId: v.id("asambleas"),

    // Misma identidad que el resto de la sala: usuario con cuenta o invitado
    // externo por código de sesión.
    userId: v.optional(v.id("users")),
    codigoInvitado: v.optional(v.string()),
    /**
     * Nombre y unidad tal como estaban AL HABLAR. Copiados a propósito: un
     * acta ya emitida no puede cambiar porque después se renombre a alguien
     * o se le reasigne la unidad.
     */
    nombre: v.string(),
    unidadNumero: v.optional(v.string()),

    /** Ventana real del segmento hablado. */
    inicioEn: v.number(),
    finEn: v.number(),

    texto: v.string(),
    /** 0–1 del motor. Por debajo de 0.6 la interfaz lo marca como dudoso. */
    confianza: v.optional(v.number()),

    /**
     * Contexto del momento, resuelto AL INSERTAR y no al leer.
     *
     * El orden del día se reordena y se edita durante la asamblea. Si esto
     * se calculara al generar el acta, una intervención terminaría colgada
     * del punto equivocado. Congelarlo aquí es lo que hace que la frase
     * quede pegada al punto que de verdad se estaba discutiendo.
     */
    puntoIndice: v.optional(v.number()),
    /**
     * Votación abierta en ese instante, si la había. Es lo que permite
     * responder «qué se dijo justo antes de decidir este punto», que es
     * exactamente lo que se pide cuando impugnan un acta.
     */
    votacionId: v.optional(v.id("votaciones")),

    fuente: v.union(
      v.literal("stt"),    // motor de transcripción
      v.literal("manual"), // la secretaría la escribió a mano
    ),

    /**
     * Corrección de la secretaría.
     *
     * El texto original NO se pisa. Una transcripción automática se
     * equivoca con nombres y cifras, y hay que poder corregirla; pero si la
     * corrección borrara el original, el acta dejaría de ser auditable y
     * cualquiera podría reescribir lo que se dijo sin dejar rastro.
     */
    textoOriginal: v.optional(v.string()),
    editadoPorUserId: v.optional(v.id("users")),
    editadoEn: v.optional(v.number()),

    createdAt: v.number(),
  })
    .index("by_asamblea_inicio", ["asambleaId", "inicioEn"])
    .index("by_asamblea_votacion", ["asambleaId", "votacionId"]),

  /**
   * Resumen redactado de cada punto del orden del día.
   *
   * Es la ÚNICA parte del acta que escribe un modelo, y por eso vive en su
   * propia tabla y no mezclada con los datos duros: el quórum, los votos y
   * los coeficientes se calculan de la base y se pueden reproducir; esto no.
   * Tenerlo separado deja claro qué hay que revisar antes de firmar.
   */
  asambleaResumenes: defineTable({
    condominioId: v.id("condominios"),
    asambleaId: v.id("asambleas"),
    puntos: v.array(
      v.object({
        puntoIndice: v.number(),
        titulo: v.string(),
        resumen: v.string(),
        /** Cuántas intervenciones se resumieron. Cero = no se habló del punto. */
        intervenciones: v.number(),
        /** La secretaría reescribió este punto a mano. */
        editado: v.optional(v.boolean()),
      }),
    ),
    /** Qué modelo lo redactó. Va impreso en el acta. */
    modelo: v.string(),
    generadoEn: v.number(),
    generadoPorUserId: v.id("users"),
  }).index("by_asamblea", ["asambleaId"]),

  /** Sesión de grabación activa (la mesa graba en el navegador). */
  salaGrabacion: defineTable({
    condominioId: v.id("condominios"),
    asambleaId: v.id("asambleas"),
    iniciadaPorUserId: v.id("users"),
    iniciadaPorNombre: v.string(),
    estado: v.union(v.literal("activa"), v.literal("terminada")),
    startedAt: v.number(),
    endedAt: v.optional(v.number()),
  }).index("by_asamblea", ["asambleaId"]),

  salaSenales: defineTable({
    asambleaId: v.id("asambleas"),
    deClienteId: v.string(),
    paraClienteId: v.string(),
    tipo: v.union(
      v.literal("oferta"),
      v.literal("respuesta"),
      v.literal("ice"),
      v.literal("lleno") // el emisor alcanzó su tope de conexiones P2P
    ),
    /** SDP o candidato ICE, en JSON. Se borra al ser consumida. */
    datos: v.string(),
    createdAt: v.number(),
  }).index("by_asamblea_para", ["asambleaId", "paraClienteId"]),

  poderesAsamblea: defineTable({
    condominioId: v.id("condominios"),
    asambleaId: v.id("asambleas"),
    unidadId: v.id("unidades"),
    unidadNumero: v.string(),
    coeficiente: v.optional(v.number()),
    otorganteUserId: v.id("users"),
    otorganteNombre: v.string(),
    // Apoderado: usuario existente (opcional) o persona externa con código.
    representanteUserId: v.optional(v.id("users")),
    representanteNombre: v.string(),
    apoderadoDocumento: v.optional(v.string()),
    codigoAcceso: v.string(), // código que usa el apoderado para ingresar y votar
    documentoStorageId: v.optional(v.id("_storage")), // legacy
    documentoUrl: v.optional(v.string()),
    validado: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_asamblea", ["asambleaId"])
    .index("by_asamblea_unidad", ["asambleaId", "unidadId"])
    .index("by_representante", ["asambleaId", "representanteUserId"])
    .index("by_otorgante", ["asambleaId", "otorganteUserId"])
    .index("by_codigo", ["codigoAcceso"]),

  // ─────────────────────────────────────────────────────────────
  // Votos individuales (un voto por unidad por votación)
  // ─────────────────────────────────────────────────────────────
  votosAsamblea: defineTable({
    condominioId: v.id("condominios"),
    asambleaId: v.id("asambleas"),
    votacionId: v.id("votaciones"),
    unidadId: v.id("unidades"),
    unidadNumero: v.string(),
    userId: v.optional(v.id("users")),      // quién emitió (si es usuario)
    codigoApoderado: v.optional(v.string()), // o el código del apoderado
    opcionIndex: v.number(),
    coeficiente: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_votacion", ["votacionId"])
    .index("by_votacion_unidad", ["votacionId", "unidadId"])
    .index("by_asamblea", ["asambleaId"])
    /* Para que "¿yo ya voté?" no tenga que leer los votos de los demás.
     *
     * Con `by_asamblea` esa pregunta barría la asamblea entera y filtraba en
     * memoria — y como la consulta había LEÍDO el rango completo, el voto de
     * cualquiera la reejecutaba en los 173 conectados. Con este índice cada
     * quien lee solo lo suyo y el voto ajeno ya no despierta a nadie. */
    .index("by_asamblea_user", ["asambleaId", "userId"]),

  // ─────────────────────────────────────────────────────────────
  // Votaciones (dentro de una asamblea)
  // ─────────────────────────────────────────────────────────────
  votaciones: defineTable({
    condominioId: v.id("condominios"),
    asambleaId: v.id("asambleas"),
    asambleaTitulo: v.string(),
    pregunta: v.string(),
    opciones: v.array(v.object({ texto: v.string(), votos: v.number() })),
    estado: v.union(v.literal("abierta"), v.literal("cerrada")),
    /** true si alguna vez se abrió (para resultados: ocultar puntos nunca abiertos). */
    abiertaAlgunaVez: v.optional(v.boolean()),
    /**
     * Ventana real de la votación. Sin estas dos fechas no se puede
     * reconstruir el quórum del instante en que se decidió el punto, que es
     * exactamente lo que se discute cuando se impugna un acta.
     */
    abiertaEn: v.optional(v.number()),
    cerradaEn: v.optional(v.number()),
    /**
     * Si está abierta con temporizador: instante en que debe cerrarse sola.
     * La mesa puede extenderlo o cerrar antes. Sin este campo = sin límite.
     */
    cierraEn: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_condominio", ["condominioId"])
    .index("by_asamblea", ["asambleaId"]),

  // ─────────────────────────────────────────────────────────────
  // PQRS (Peticiones, Quejas, Reclamos, Sugerencias)
  // ─────────────────────────────────────────────────────────────
  pqrs: defineTable({
    condominioId: v.id("condominios"),
    radicado: v.string(),   // consecutivo, ej "PQRS-2026-0001"
    tipo: v.union(
      v.literal("peticion"),
      v.literal("queja"),
      v.literal("reclamo"),
      v.literal("sugerencia"),
      v.literal("felicitacion")
    ),
    asunto: v.string(),
    descripcion: v.string(),
    solicitanteNombre: v.string(),
    solicitanteUserId: v.optional(v.id("users")),
    unidadNumero: v.optional(v.string()),
    estado: v.union(
      v.literal("abierto"),
      v.literal("en_gestion"),
      v.literal("resuelto"),
      v.literal("cerrado")
    ),
    prioridad: v.union(v.literal("baja"), v.literal("media"), v.literal("alta")),
    // Hilo de conversación (historial admin ↔ residente).
    mensajes: v.optional(
      v.array(
        v.object({
          autorNombre: v.string(),
          autorUserId: v.optional(v.id("users")),
          esAdmin: v.boolean(),
          texto: v.string(),
          createdAt: v.number(),
        })
      )
    ),
    // Legado: primera respuesta única (antes del hilo).
    respuesta: v.optional(v.string()),
    respondidoPor: v.optional(v.string()),
    resueltoAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_condominio", ["condominioId"])
    .index("by_estado", ["condominioId", "estado"]),

  // ─────────────────────────────────────────────────────────────
  // Consejo administrativo — documentos por categoría (versión + comentarios)
  // ─────────────────────────────────────────────────────────────
  consejoCategorias: defineTable({
    condominioId: v.id("condominios"),
    nombre: v.string(),
    slug: v.string(),
    /** Legado: clave lucide. Preferir iconType + iconValue. */
    iconKey: v.optional(v.string()),
    colorKey: v.optional(v.string()),
    /** Notion-like: lucide | emoji | svg | image */
    iconType: v.optional(
      v.union(
        v.literal("lucide"),
        v.literal("emoji"),
        v.literal("svg"),
        v.literal("image"),
      ),
    ),
    /** lucide key, emoji, markup SVG sanitizado, o URL de imagen */
    iconValue: v.optional(v.string()),
    orden: v.number(),
    activo: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_condominio", ["condominioId"])
    .index("by_condominio_slug", ["condominioId", "slug"]),

  consejoDocumentos: defineTable({
    condominioId: v.id("condominios"),
    categoriaId: v.id("consejoCategorias"),
    titulo: v.string(),
    descripcion: v.optional(v.string()),
    periodoMes: v.optional(v.string()), // "2026-04"
    fileUrl: v.string(),
    fileName: v.string(),
    mimeType: v.string(),
    sizeBytes: v.number(),
    s3Key: v.optional(v.string()),
    version: v.number(),
    estado: v.union(
      v.literal("pendiente"),
      v.literal("en_revision"),
      v.literal("aprobado"),
      v.literal("reemplazado"),
    ),
    createdByUserId: v.optional(v.id("users")),
    createdByNombre: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_condominio", ["condominioId"])
    .index("by_categoria", ["categoriaId"]),

  consejoDocumentoVersiones: defineTable({
    condominioId: v.id("condominios"),
    documentoId: v.id("consejoDocumentos"),
    version: v.number(),
    fileUrl: v.string(),
    fileName: v.string(),
    mimeType: v.string(),
    sizeBytes: v.number(),
    s3Key: v.optional(v.string()),
    subidoPorUserId: v.optional(v.id("users")),
    subidoPorNombre: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_documento", ["documentoId"]),

  consejoDocumentoComentarios: defineTable({
    condominioId: v.id("condominios"),
    documentoId: v.id("consejoDocumentos"),
    userId: v.id("users"),
    autorNombre: v.string(),
    contenido: v.string(),
    /** Respuesta a otro comentario */
    parentId: v.optional(v.id("consejoDocumentoComentarios")),
    activo: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_documento", ["documentoId"])
    .index("by_parent", ["parentId"]),

  consejoComentarioReacciones: defineTable({
    condominioId: v.id("condominios"),
    comentarioId: v.id("consejoDocumentoComentarios"),
    userId: v.id("users"),
    emoji: v.string(),
    createdAt: v.number(),
  })
    .index("by_comentario", ["comentarioId"])
    .index("by_comentario_user_emoji", ["comentarioId", "userId", "emoji"]),

  // ─────────────────────────────────────────────────────────────
  // Consejo administrativo — miembros (catálogo de cargos)
  // ─────────────────────────────────────────────────────────────
  consejoMiembros: defineTable({
    condominioId: v.id("condominios"),
    nombre: v.string(),
    cargo: v.union(
      v.literal("presidente"),
      v.literal("vicepresidente"),
      v.literal("secretario"),
      v.literal("tesorero"),
      v.literal("vocal"),
      v.literal("fiscal"),
      v.literal("suplente")
    ),
    unidadNumero: v.optional(v.string()),
    telefono: v.optional(v.string()),
    email: v.optional(v.string()),
    periodoInicio: v.optional(v.string()),
    periodoFin: v.optional(v.string()),
    activo: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_condominio", ["condominioId"]),

  // ─────────────────────────────────────────────────────────────
  // Consejo administrativo — sesiones / reuniones
  // ─────────────────────────────────────────────────────────────
  consejoSesiones: defineTable({
    condominioId: v.id("condominios"),
    titulo: v.string(),
    tipo: v.union(v.literal("ordinaria"), v.literal("extraordinaria")),
    fecha: v.string(),
    asistentes: v.optional(v.number()),
    temas: v.optional(v.string()),
    acuerdos: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_condominio", ["condominioId"]),

  // ─────────────────────────────────────────────────────────────
  // Paquetería (portería / guardia)
  //
  // El guardia recibe un paquete para una unidad ("recibido") y luego lo
  // marca "entregado" cuando el residente lo recoge.
  // ─────────────────────────────────────────────────────────────
  paquetes: defineTable({
    condominioId: v.id("condominios"),
    /**
     * La unidad de verdad, no solo su numero.
     *
     * Sin esto no habia forma de avisarle al residente que le llego un
     * paquete: la porteria guardaba el numero como texto y nadie podia
     * resolver quien vive ahi. Es opcional porque los paquetes anteriores
     * no lo traen; para esos se sigue comparando por numero.
     */
    unidadId: v.optional(v.id("unidades")),
    unidadNumero: v.string(),
    destinatario: v.optional(v.string()),      // nombre de quien recibe
    remitente: v.optional(v.string()),          // empresa / transportadora
    tipo: v.union(
      v.literal("paquete"),
      v.literal("sobre"),
      v.literal("comida"),
      v.literal("mercado"),
      v.literal("otro")
    ),
    descripcion: v.optional(v.string()),
    estado: v.union(v.literal("recibido"), v.literal("entregado")),
    // Evidencia fotográfica (llegada y entrega). Preferir URL S3.
    fotoStorageId: v.optional(v.id("_storage")), // legacy
    fotoUrl: v.optional(v.string()),
    fotoEntregaStorageId: v.optional(v.id("_storage")), // legacy
    fotoEntregaUrl: v.optional(v.string()),
    observacionesEntrega: v.optional(v.string()),
    recibidoPorNombre: v.string(),              // guardia que recibió
    entregadoPorNombre: v.optional(v.string()), // guardia que entregó
    entregadoANombre: v.optional(v.string()),   // quién recogió
    fechaRecibido: v.number(),
    fechaEntregado: v.optional(v.number()),
  })
    .index("by_condominio", ["condominioId"])
    .index("by_estado", ["condominioId", "estado"]),

  // ─────────────────────────────────────────────────────────────
  // Guardia — turnos, checklist, rondas, minuta digital
  //
  // Réplica de la lógica de VekinoApi: el turno gobierna la operación
  // (sin turno abierto no hay minuta ni rondas); solo puede existir UN
  // turno abierto por condominio; el cierre es la "entrega" del turno
  // (novedades de los elementos del checklist + quién recibe + consignas +
  // observaciones generales). La minuta es append-only: cada acción
  // del guardia genera un evento automáticamente.
  // ─────────────────────────────────────────────────────────────

  /** Plantilla de ítems que el guardia verifica al iniciar turno (dotación). */
  guardiaChecklistTemplates: defineTable({
    condominioId: v.id("condominios"),
    nombre: v.string(),
    obligatorio: v.boolean(),
    cantidadEsperada: v.number(),
    activo: v.boolean(),
    orden: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_condominio", ["condominioId"]),

  /** Catálogo de zonas de inspección para las rondas. */
  guardiaRondaZonas: defineTable({
    condominioId: v.id("condominios"),
    nombre: v.string(),
    activa: v.boolean(),
    orden: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_condominio", ["condominioId"]),

  /**
   * Motivos por los que un guarda puede senalar un vehiculo.
   *
   * Cada conjunto tiene sus propias reglas —unos cobran por parquear en
   * visitantes, otros ni lo miran—, asi que la lista la arma la
   * administracion. Mientras no configure ninguno se usan los de
   * `MOTIVOS_VEHICULO_POR_DEFECTO`: un desplegable vacio dejaria al guarda
   * sin poder reportar, y eso es peor que una lista generica.
   */
  guardiaMotivosVehiculo: defineTable({
    condominioId: v.id("condominios"),
    nombre: v.string(),
    activo: v.boolean(),
    orden: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_condominio", ["condominioId"]),

  guardiaTurnos: defineTable({
    condominioId: v.id("condominios"),
    guardiaUserId: v.id("users"),
    guardiaNombre: v.string(),
    // Turno compartido (segundo guardia): si uno cierra, se cierra para ambos.
    guardiaSecundarioUserId: v.optional(v.id("users")),
    guardiaSecundarioNombre: v.optional(v.string()),
    observacionesInicio: v.optional(v.string()),
    // Snapshot del checklist de dotación al abrir el turno.
    checklist: v.array(
      v.object({
        item: v.string(),
        obligatorio: v.boolean(),
        cantidadEsperada: v.number(),
        cantidadEncontrada: v.number(),
        estadoOk: v.boolean(),
        observacion: v.optional(v.string()),
      })
    ),
    // Cierre formal / entrega del turno.
    consignas: v.optional(v.string()),          // pendientes para el relevo
    recibe: v.optional(v.string()),             // quién recibe el turno (nombre copiado)
    /* El relevo elegido del catálogo de guardas de la portería (`guardia.equipo`).
     * Ausente cuando se escribió a mano —cuenta compartida, relevo sin usuario—
     * y en los cierres anteriores a que existiera el selector. `recibe` sigue
     * llevando el nombre copiado, igual que `guardiaSecundarioNombre`. */
    recibeUserId: v.optional(v.id("users")),
    /* Observaciones generales del cierre. Obligatorias desde que el cierre
     * registra los elementos; opcional aquí por los cierres de antes. */
    observacionesCierre: v.optional(v.string()),
    /* Novedades con los elementos del `checklist` al cerrar. Los elementos no
     * se copian ni se editan al cerrar: son los que se firmaron al iniciar, y
     * esto solo dice si volvieron con novedad. Ausente en los cierres de antes
     * = no se preguntó, que no es lo mismo que "sin novedades". */
    novedadesElementos: v.optional(v.boolean()),
    novedadesElementosDetalle: v.optional(v.string()),
    /* Quién firmó el cierre: el guarda del turno o un administrador. */
    cerradoPorUserId: v.optional(v.id("users")),
    estado: v.union(v.literal("abierto"), v.literal("cerrado")),
    fechaInicio: v.number(),
    fechaCierre: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_condominio", ["condominioId"])
    .index("by_condominio_fecha", ["condominioId", "fechaInicio"])
    .index("by_condominio_estado", ["condominioId", "estado"]),

  /**
   * Un recorrido de vigilancia, con principio y fin.
   *
   * Nacio como un apunte suelto —zona, novedad y fotos— dentro del turno. La
   * administracion pidio trazabilidad: quien la hizo, a que hora empezo, que
   * paso durante el recorrido y cuanto duro. Asi que ahora tiene estado.
   *
   * Vive DENTRO del turno y no lo reemplaza: un turno son ocho o doce horas
   * y contiene varias rondas de una hora. El turno responde por la jornada
   * (dotacion, entrega al relevo); la ronda, por el recorrido.
   *
   * Todos los campos nuevos son opcionales porque las rondas viejas —las que
   * eran un simple apunte— siguen en la tabla y tienen que seguir leyendose.
   */
  guardiaRondas: defineTable({
    condominioId: v.id("condominios"),
    turnoId: v.id("guardiaTurnos"),
    zonaId: v.optional(v.id("guardiaRondaZonas")),
    zona: v.string(), // nombre denormalizado
    novedad: v.optional(v.string()),
    fotos: v.array(v.string()), // URLs S3 (o storageId legacy como string)

    /** Consecutivo por condominio, para poder nombrarla: "Ronda #14". */
    numero: v.optional(v.number()),
    /* Quien la hizo, copiado. El turno tiene su titular, pero una ronda la
     * puede hacer el guarda secundario, y el reporte debe decir cual. */
    guardiaUserId: v.optional(v.id("users")),
    guardiaNombre: v.optional(v.string()),

    /**
     * `en_curso` admite registros; `finalizada` ya no.
     *
     * Ausente en las rondas viejas, que nunca tuvieron ciclo de vida: se
     * leen como finalizadas, porque desde luego no estan en curso.
     */
    estado: v.optional(
      v.union(v.literal("en_curso"), v.literal("finalizada")),
    ),
    fechaInicio: v.optional(v.number()),
    fechaCierre: v.optional(v.number()),
    observacionesCierre: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_turno", ["turnoId"])
    .index("by_condominio", ["condominioId"])
    .index("by_condominio_fecha", ["condominioId", "createdAt"])
    .index("by_condominio_estado", ["condominioId", "estado"]),

  /**
   * Minuta digital (bitácora append-only). Los eventos se generan
   * automáticamente desde cada acción del guardia y también manualmente.
   * Sin update/delete: es el registro de auditoría de portería.
   */
  minutaEventos: defineTable({
    condominioId: v.id("condominios"),
    turnoId: v.optional(v.id("guardiaTurnos")), // turno activo al momento (si había)
    /* Ronda en curso al momento del evento, si la habia. Se rellena sola en
     * logMinuta: la especificacion pide que cada registro quede asociado a la
     * ronda activa sin que el guarda tenga que acordarse de indicarlo. */
    rondaId: v.optional(v.id("guardiaRondas")),
    modulo: v.union(
      v.literal("visitantes"),
      v.literal("paqueteria"),
      v.literal("reservas"),
      v.literal("novedades"),
      v.literal("minuta") // turnos, rondas y eventos manuales
    ),
    tipo: v.string(),     // "Ingreso", "Salida", "Registro", "Ronda de Control"…
    unidad: v.string(),   // unidad relacionada o "Portería"
    resumen: v.string(),
    estado: v.union(v.literal("abierto"), v.literal("cerrado")),
    actorUserId: v.optional(v.id("users")),
    actorNombre: v.string(),
    createdAt: v.number(),
  })
    .index("by_condominio", ["condominioId"])
    .index("by_condominio_fecha", ["condominioId", "createdAt"])
    .index("by_turno", ["turnoId"]),

  /** Reporte de novedad / incidente de seguridad (con adjunto opcional). */
  guardiaNovedadReportes: defineTable({
    condominioId: v.id("condominios"),
    turnoId: v.optional(v.id("guardiaTurnos")),
    /** Ronda durante la cual se reporto, si habia una en curso. */
    rondaId: v.optional(v.id("guardiaRondas")),

    /**
     * Estado del cobro de este reporte.
     *
     * Un reporte de vehiculo con evidencia es, casi siempre, plata por
     * cobrar: la casa parqueo sin aporte y hay que pasarle el cargo. Sin
     * llevar el estado, la administracion tiene que acordarse de cual ya paso
     * a la factura, y entre doscientos reportes eso termina en cobros
     * repetidos o en cobros que nunca se hicieron.
     *
     * Ausente se lee como "pendiente": los reportes que existian antes de que
     * esto se llevara siguen contando como por cobrar.
     */
    cobroEstado: v.optional(
      v.union(
        v.literal("pendiente"),
        v.literal("facturado"),
        v.literal("descartado"),
      ),
    ),
    /** Periodo de la factura donde quedo el cargo. "2026-10". */
    cobroPeriodo: v.optional(v.string()),
    cobroMonto: v.optional(v.number()),
    cobradoPorNombre: v.optional(v.string()),
    cobradoEn: v.optional(v.number()),
    /** Por que se descarto, cuando se descarta. */
    cobroNota: v.optional(v.string()),
    /** Apartado del guarda. Ausente en reportes anteriores a la separación. */
    tipoReporte: v.optional(v.union(v.literal("novedad"), v.literal("aporte_voluntario"))),
    titulo: v.string(),
    descripcion: v.string(),
    prioridad: v.union(v.literal("baja"), v.literal("media"), v.literal("alta")),
    archivoStorageId: v.optional(v.id("_storage")), // legacy
    archivoUrl: v.optional(v.string()),
    archivoNombre: v.optional(v.string()),

    /**
     * Vehiculo senalado, cuando la novedad es sobre uno.
     *
     * La placa, la unidad y el duenno van COPIADOS, no solo referenciados: si
     * despues venden el carro o lo reasignan a otra unidad, la novedad tiene
     * que seguir diciendo a quien se le hizo. Es lo que sostiene el cobro
     * cuando el propietario reclama meses despues.
     */
    vehiculoId: v.optional(v.id("vehiculos")),
    vehiculoPlaca: v.optional(v.string()),
    vehiculoDescripcion: v.optional(v.string()), // "Carro · Mazda · Gris"

    /**
     * Casas a las que toca la novedad. Ninguna, una o varias.
     *
     * Varias porque hay novedades que son de mas de una casa —una gotera
     * entre dos apartamentos, un ruido que afecta a la manzana— y obligar a
     * abrir un reporte por casa hacia que el guarda abriera uno solo y
     * escribiera el resto en la descripcion, donde no se puede buscar.
     *
     * Ninguna porque tampoco puede ser obligatorio: la mayoria de las
     * novedades son de la porteria o de una zona comun.
     *
     * El numero va copiado junto al id por lo mismo de siempre: el reporte
     * tiene que seguir diciendo a que casa se referia.
     */
    unidades: v.optional(
      v.array(v.object({ unidadId: v.id("unidades"), numero: v.string() })),
    ),
    /** Legado: la unica unidad de antes de que se aceptaran varias. */
    unidadId: v.optional(v.id("unidades")),
    unidadNumero: v.optional(v.string()),

    /**
     * Cuando OCURRIO, que no es cuando se registro.
     *
     * El guarda ve algo a las 2 a. m. y lo escribe cuando vuelve a la
     * caseta. `createdAt` guarda lo segundo; para cobrar y para el acta
     * importa lo primero. Si no se indica, se asume que fue al registrar.
     */
    ocurrioEn: v.optional(v.number()),

    /**
     * Evidencia fotografica. Varias, no una.
     *
     * Una sola foto casi nunca prueba un mal parqueo: hace falta la placa
     * legible Y el sitio donde esta. El campo `archivoUrl` de arriba se deja
     * para las novedades que ya existian.
     */
    fotos: v.optional(
      v.array(v.object({ url: v.string(), nombre: v.optional(v.string()) })),
    ),

    /**
     * Estado del cobro. Lo mueve la administracion, no el guarda: el guarda
     * reporta lo que ve, quien decide si se cobra es la mesa.
     */
    gestion: v.optional(
      v.union(
        v.literal("pendiente"),  // recien reportada
        v.literal("cobrada"),    // se le paso a la unidad
        v.literal("descartada"), // se reviso y no procede
      ),
    ),
    gestionNota: v.optional(v.string()),
    gestionPorUserId: v.optional(v.id("users")),
    gestionEn: v.optional(v.number()),

    reportadoPorUserId: v.id("users"),
    reportadoPorNombre: v.string(),
    createdAt: v.number(),
  })
    .index("by_condominio", ["condominioId"])
    .index("by_condominio_fecha", ["condominioId", "createdAt"])
    // Historial de un vehiculo: "esta placa ya lleva tres veces este mes".
    .index("by_vehiculo", ["vehiculoId"]),

  /**
   * Depósito / garantía de una reserva de zona común.
   *
   * La salida de la reserva NO se puede validar mientras el depósito siga
   * "registrado", salvo que haya incidentes esperando valoración: la salida
   * física no espera a la administración, pero el dinero sí.
   *
   * La devolución la calcula `lib/depositoReserva.ts` a partir de los
   * incidentes (`reservaIncidentes`); ya no hay "retener" a criterio de quien
   * resuelve.
   */
  guardiaReservaDepositos: defineTable({
    condominioId: v.id("condominios"),
    reservaId: v.id("reservas"),
    monto: v.number(),
    observacionesIngreso: v.optional(v.string()),
    fotoIngresoStorageId: v.optional(v.id("_storage")), // legacy
    fotoIngresoUrl: v.optional(v.string()),
    estado: v.union(
      v.literal("registrado"),
      /** Se devolvió completo. */
      v.literal("devuelto"),
      /**
       * Se devolvió $0. En los depósitos anteriores a los incidentes era la
       * retención a criterio; desde entonces solo se llega con incidentes
       * valorados que cubren todo el depósito.
       */
      v.literal("no_devuelto"),
      /** Se devolvió una parte: los incidentes valorados descontaron el resto. */
      v.literal("devuelto_parcial"),
    ),
    /** Razón de la devolución. Obligatoria cuando hubo incidentes. */
    observacionesSalida: v.optional(v.string()),
    fotoSalidaStorageId: v.optional(v.id("_storage")), // legacy
    fotoSalidaUrl: v.optional(v.string()),
    recibidoPorNombre: v.string(),
    recibidoPorUserId: v.optional(v.id("users")),
    /**
     * Con qué rol y por qué ventanilla se actuó, sellado en el momento.
     *
     * Existe porque el nombre solo no basta para auditar: el rol de hoy de esa
     * persona no es necesariamente el que tenía al recibir el dinero, y
     * deducirlo al leer sería inventar el pasado. Vacíos en los depósitos
     * anteriores a estos campos, que la auditoría muestra como "sin registrar"
     * en vez de rellenar.
     */
    recibidoPorRol: v.optional(rolActorDepositoValidator),
    recibidoOrigen: v.optional(origenDepositoValidator),
    resueltoPorNombre: v.optional(v.string()),
    resueltoPorUserId: v.optional(v.id("users")),
    resueltoPorRol: v.optional(rolActorDepositoValidator),
    resueltoOrigen: v.optional(origenDepositoValidator),
    fechaRegistro: v.number(),
    fechaResolucion: v.optional(v.number()),
    /**
     * La liquidación congelada al devolver.
     *
     * Se guarda y no se recalcula al leer: es lo que se entregó en mano, y un
     * incidente tocado después (no debería poder pasar, pero) no puede cambiar
     * lo que dice el comprobante. Vacíos en los depósitos resueltos antes de
     * que existieran los incidentes; `montosDeDepositoResuelto` los deduce
     * del estado.
     */
    totalIncidentes: v.optional(v.number()),
    montoDescontado: v.optional(v.number()),
    montoDevuelto: v.optional(v.number()),
  })
    .index("by_reserva", ["reservaId"])
    .index("by_condominio", ["condominioId"])
    /* La auditoría pregunta por rango de fechas; sin esto leería el histórico
       entero del conjunto para quedarse con un mes. */
    .index("by_condominio_registro", ["condominioId", "fechaRegistro"]),

  /**
   * Incidente ocurrido durante una reserva: un daño, un faltante.
   *
   * Separa quién lo VE de quién le pone PRECIO. Portería lo reporta sin valor
   * y queda `pendiente`; la administración lo valora o lo descarta. Solo los
   * `valorado` descuentan del depósito, y como máximo lo que el depósito
   * alcanza: el excedente no se registra como deuda en ningún lado.
   *
   * No es una `guardiaNovedadReportes`: allí "cobrada" significa pasarle el
   * cobro a la unidad, que es justo lo que un incidente no debe hacer.
   *
   * Cuando el depósito de la reserva se liquida, sus incidentes quedan
   * congelados.
   */
  reservaIncidentes: defineTable({
    condominioId: v.id("condominios"),
    reservaId: v.id("reservas"),
    descripcion: v.string(),
    fotos: v.optional(
      v.array(v.object({ url: v.string(), nombre: v.optional(v.string()) })),
    ),
    estado: v.union(
      v.literal("pendiente"),
      v.literal("valorado"),
      v.literal("descartado"),
    ),
    /** Pesos. Solo lo pone la administración; solo cuenta si está `valorado`. */
    valor: v.optional(v.number()),
    /**
     * Por dónde entró, que no es lo mismo que el rol: un administrador también
     * puede operar la portería.
     */
    origen: v.union(v.literal("porteria"), v.literal("administracion")),
    reportadoPorUserId: v.id("users"),
    reportadoPorNombre: v.string(),
    /** Quién decidió el valor o el descarte, y cuándo. */
    revisadoPorUserId: v.optional(v.id("users")),
    revisadoPorNombre: v.optional(v.string()),
    revisadoEn: v.optional(v.number()),
    notaRevision: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_reserva", ["reservaId"])
    .index("by_condominio", ["condominioId"]),

  // ─────────────────────────────────────────────────────────────
  // Push notifications (tokens de dispositivo)
  // ─────────────────────────────────────────────────────────────
  pushTokens: defineTable({
    userId: v.id("users"),
    token: v.string(),
    platform: v.union(v.literal("ios"), v.literal("android"), v.literal("web")),
    enabled: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_token", ["token"]),

  // ─────────────────────────────────────────────────────────────
  // Soporte (ayuda al residente → admin del condo + superadmin)
  // ─────────────────────────────────────────────────────────────
  soporteTickets: defineTable({
    condominioId: v.optional(v.id("condominios")),
    condominioNombre: v.optional(v.string()),
    userId: v.id("users"),
    userNombre: v.string(),
    userEmail: v.string(),
    categoria: v.union(
      v.literal("factura"),
      v.literal("acceso"),
      v.literal("app"),
      v.literal("otro"),
    ),
    asunto: v.string(),
    mensaje: v.string(),
    /** Capturas de pantalla y archivos que adjunta quien reporta (S3). */
    archivos: v.optional(
      v.array(
        v.object({
          url: v.string(),
          s3Key: v.optional(v.string()),
          mimeType: v.string(),
          nombre: v.string(),
        }),
      ),
    ),
    estado: v.union(
      v.literal("abierto"),
      v.literal("en_gestion"),
      v.literal("resuelto"),
      v.literal("cerrado"),
    ),
    respuesta: v.optional(v.string()),
    /** Adjuntos de la respuesta de soporte. */
    archivosRespuesta: v.optional(
      v.array(
        v.object({
          url: v.string(),
          s3Key: v.optional(v.string()),
          mimeType: v.string(),
          nombre: v.string(),
        }),
      ),
    ),
    respondidoPorUserId: v.optional(v.id("users")),
    respondidoPorNombre: v.optional(v.string()),
    respondidoAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_condominio", ["condominioId"])
    .index("by_estado", ["estado"]),

  /**
   * Enlace de un solo uso para entrar sin teclear la clave.
   *
   * Guarda la contraseña temporal en claro a propósito: es la MISMA que ya va
   * viajando por WhatsApp, dura 30 minutos, se usa una vez y se borra al
   * usarse. A cambio, el residente entra tocando un botón en vez de copiar
   * "Vekino-RPMKGT-3687" a mano en el teléfono.
   */
  accesosRapidos: defineTable({
    token: v.string(),
    userId: v.id("users"),
    email: v.string(),
    password: v.string(),
    expiraAt: v.number(),
    usadoAt: v.optional(v.number()),
    createdAt: v.number(),
  }).index("by_token", ["token"]),

  // ─────────────────────────────────────────────────────────────
  // Automatizaciones: envíos programados (fecha y hora)
  // ─────────────────────────────────────────────────────────────

  /**
   * Un envío agendado. La ejecución la dispara el scheduler de Convex con
   * `runAt`, no un cron que barre: así el envío sale a la hora exacta y no
   * hay que revisar la tabla cada minuto.
   */
  enviosProgramados: defineTable({
    condominioId: v.id("condominios"),
    tipo: v.union(
      /** Enlace de la asamblea al propietario, para que se lo pase a su apoderado. */
      v.literal("apoderados_asamblea"),
      /** Mensaje libre a los residentes del condominio. */
      v.literal("mensaje_residentes"),
      /** Una plantilla aprobada de WhatsApp, elegida y con sus variables. */
      v.literal("plantilla_whatsapp"),
      /**
       * Los datos de acceso, por correo, a quienes nunca han entrado. No envía
       * de a un mensaje como los demás tipos: arranca el motor de lotes de
       * `credenciales.ts` (que rota contraseñas y sabe hacer rollback) y esta
       * fila queda como el espejo programable de ese trabajo.
       */
      v.literal("credenciales_acceso"),
      /**
       * Difunde un comunicado ya publicado: la plantilla por WhatsApp y el
       * cuerpo completo por correo. Nace del propio comunicado, no de un
       * formulario, para que nadie tenga que volver a escribir el título.
       */
      v.literal("comunicado_difusion"),
    ),
    asambleaId: v.optional(v.id("asambleas")),
    /** Solo en `comunicado_difusion`. */
    comunicadoId: v.optional(v.id("comunicados")),
    /** Solo en `credenciales_acceso`. Por defecto no toca a quien ya entró. */
    modoCredenciales: v.optional(
      v.union(
        v.literal("solo_sin_clave"),
        v.literal("nunca_ingreso"),
        v.literal("todos"),
      ),
    ),
    /** Solo en `credenciales_acceso`: el job real que hace el trabajo. */
    credencialesJobId: v.optional(v.id("envioCredencialesJobs")),
    /** Solo en `mensaje_residentes`. */
    asunto: v.optional(v.string()),
    mensaje: v.optional(v.string()),
    /** A quién va: rol operativo, o "todos". */
    audiencia: v.optional(v.string()),
    /** Solo en `plantilla_whatsapp`: nombre de la plantilla y sus variables. */
    plantilla: v.optional(v.string()),
    parametros: v.optional(v.array(v.string())),
    canal: v.union(
      v.literal("correo"),
      v.literal("whatsapp"),
      v.literal("ambos"),
    ),
    programadoPara: v.number(),
    /**
     * Reenvío: solo va a quienes NO recibieron el envío original (fallidos y
     * sin contacto). Sirve tras corregir teléfonos o correos en la plataforma.
     */
    reintentoDe: v.optional(v.id("enviosProgramados")),
    estado: v.union(
      v.literal("programado"),
      v.literal("enviando"),
      v.literal("completado"),
      v.literal("cancelado"),
      v.literal("fallido"),
    ),
    /** Id del job del scheduler, para poder cancelarlo. */
    scheduledFunctionId: v.optional(v.id("_scheduled_functions")),
    total: v.number(),
    enviados: v.number(),
    fallidos: v.number(),
    sinContacto: v.number(),
    error: v.optional(v.string()),
    creadoPorUserId: v.id("users"),
    creadoPorNombre: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_condominio", ["condominioId"])
    .index("by_estado", ["estado"]),

  /** Resultado por destinatario de un envío programado. */
  enviosProgramadosDetalle: defineTable({
    envioId: v.id("enviosProgramados"),
    condominioId: v.id("condominios"),
    /** Identidad estable del destinatario, para cruzar reenvíos. */
    clave: v.optional(v.string()),
    nombre: v.string(),
    destino: v.optional(v.string()),
    canal: v.string(),
    estado: v.union(
      v.literal("enviado"),
      v.literal("fallido"),
      v.literal("sin_contacto"),
    ),
    motivo: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_envio", ["envioId"]),

  // ─────────────────────────────────────────────────────────────
  // Envío masivo de credenciales de acceso (onboarding por correo)
  // ─────────────────────────────────────────────────────────────

  /**
   * Un envío masivo en curso o terminado. La cola (`pendientes`) vive en el
   * documento para que el proceso pueda reanudarse por lotes sin perder el
   * hilo si una tanda falla.
   */
  envioCredencialesJobs: defineTable({
    condominioId: v.id("condominios"),
    /**
     * - solo_sin_clave: no toca a quien ya tiene contraseña propia en Better Auth.
     * - nunca_ingreso:  a quien no hay evidencia de que haya entrado.
     * - todos:          a todos, rotando la clave incluso a quien ya usa la suya.
     */
    modo: v.union(
      v.literal("solo_sin_clave"),
      v.literal("nunca_ingreso"),
      v.literal("todos"),
    ),
    estado: v.union(
      v.literal("en_curso"),
      v.literal("completado"),
      v.literal("cancelado"),
    ),
    pendientes: v.array(v.id("users")),
    total: v.number(),
    procesados: v.number(),
    enviados: v.number(),
    fallidos: v.number(),
    omitidos: v.number(),
    iniciadoPorUserId: v.id("users"),
    iniciadoPorNombre: v.string(),
    /**
     * Si el job nació de un envío programado, aquí queda el vínculo de vuelta:
     * al terminar le copia los totales para que Automatizaciones muestre a
     * quién le llegó y a quién no, sin tener que mirar en dos sitios.
     */
    envioProgramadoId: v.optional(v.id("enviosProgramados")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_condominio", ["condominioId"])
    .index("by_condominio_estado", ["condominioId", "estado"]),

  /**
   * Resultado por destinatario. NUNCA guarda la contraseña en claro: solo
   * queda constancia de a quién se le envió, cuándo y con qué resultado.
   */
  envioCredenciales: defineTable({
    jobId: v.optional(v.id("envioCredencialesJobs")),
    condominioId: v.id("condominios"),
    userId: v.id("users"),
    nombre: v.string(),
    email: v.string(),
    estado: v.union(
      v.literal("enviado"),
      v.literal("fallido"),
      v.literal("omitido"),
    ),
    motivo: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_condominio", ["condominioId"])
    .index("by_job", ["jobId"]),

  // ─────────────────────────────────────────────────────────────
  // WhatsApp (YCloud) — bot conversacional + fan-out de plantillas
  // ─────────────────────────────────────────────────────────────

  /**
   * Una conversación por teléfono (número WABA compartido entre condominios:
   * el tenant activo se resuelve por el usuario y se fija aquí).
   */
  waConversations: defineTable({
    /**
     * E.164 con "+". OPCIONAL desde los usernames de WhatsApp: si el usuario
     * activó su @usuario, Meta deja de mandar el teléfono y solo llega el
     * BSUID (salvo interacción en los últimos 30 días).
     */
    telefono: v.optional(v.string()),
    /**
     * Business-Scoped User ID de Meta (`fromUserId`, formato "US.1349...").
     * Es estable por negocio y SIEMPRE viene, con o sin username: es la
     * identidad primaria de la conversación.
     */
    bsuid: v.optional(v.string()),
    /** @usuario de WhatsApp, si lo tiene. Solo para mostrar. */
    username: v.optional(v.string()),
    userId: v.optional(v.id("users")),
    nombrePerfil: v.optional(v.string()), // customerProfile.name de WhatsApp
    condominioId: v.optional(v.id("condominios")),
    membershipId: v.optional(v.id("memberships")),

    /** Mensajes entrantes sin leer en el inbox del equipo. */
    noLeidos: v.optional(v.number()),
    /**
     * Mientras esté en el futuro, el agente NO responde: hay una persona del
     * equipo atendiendo. Se fija sola cuando alguien escribe desde el panel.
     */
    agentePausadoHasta: v.optional(v.number()),
    /** Quién del equipo respondió por última vez (para mostrarlo en el hilo). */
    ultimoAgenteNombre: v.optional(v.string()),
    /** El agente pidió ayuda humana: queda marcada en el inbox. */
    escaladaAt: v.optional(v.number()),
    escaladaMotivo: v.optional(v.string()),

    /** Paso de la máquina de estados del bot ("menu", "reserva:fecha", ...). */
    paso: v.string(),
    /** Datos del paso en curso (borrador de reserva, factura elegida, etc.). */
    contexto: v.optional(v.any()),

    /** Fin de la ventana de 24 h (último entrante + 24 h). Fuera de ella solo plantillas. */
    ventanaExpiraAt: v.optional(v.number()),
    /**
     * Marca del último mensaje ENTRANTE. Sirve para agrupar ráfagas: si al
     * ejecutarse el agente resulta que llegó algo más nuevo, se calla y deja
     * responder al último, que ya ve toda la conversación.
     */
    ultimoEntranteAt: v.optional(v.number()),
    /** Última vez que se le mandaron accesos por pedir ayuda para entrar. */
    ultimoRescateAccesoAt: v.optional(v.number()),
    ultimoMensajeAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_telefono", ["telefono"])
    .index("by_bsuid", ["bsuid"])
    .index("by_user", ["userId"]),

  waMessages: defineTable({
    conversacionId: v.id("waConversations"),
    telefono: v.optional(v.string()),
    direccion: v.union(v.literal("entrante"), v.literal("saliente")),
    tipo: v.string(), // text | image | document | interactive | template | ...
    contenido: v.string(),
    /** Media re-alojada en nuestro S3 (los links de YCloud caducan). */
    mediaUrl: v.optional(v.string()),
    mediaMime: v.optional(v.string()),
    mediaNombre: v.optional(v.string()),
    /** Nombre de quien respondió desde el panel (null = lo mandó el bot). */
    agenteNombre: v.optional(v.string()),
    /** Id del mensaje en YCloud: idempotencia de entrantes y correlación de estados. */
    ycloudMessageId: v.optional(v.string()),
    estado: v.optional(v.string()), // sent | delivered | read | failed
    error: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_conversacion", ["conversacionId"])
    .index("by_ycloudMessageId", ["ycloudMessageId"]),

  /** Registro de cada plantilla enviada en un fan-out (auditoría + no re-enviar). */
  waEnvios: defineTable({
    tipo: v.union(
      v.literal("comunicado"),
      v.literal("pago_aprobado"),
      v.literal("soporte_revisado"),
      v.literal("manual"),
    ),
    comunicadoId: v.optional(v.id("comunicados")),
    condominioId: v.id("condominios"),
    userId: v.optional(v.id("users")),
    telefono: v.optional(v.string()),
    template: v.string(),
    ycloudMessageId: v.optional(v.string()),
    estado: v.union(
      v.literal("enviado"),
      v.literal("fallido"),
      v.literal("sin_telefono"),
    ),
    error: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_comunicado", ["comunicadoId"])
    .index("by_condominio", ["condominioId"]),

  /**
   * Comprobante de pago subido por el propietario (foto/PDF por WhatsApp o web).
   * La administración lo revisa: aprobar marca la factura vinculada como pagada.
   */
  /**
   * Uso real de la plataforma, para saber qué módulos le importan a la gente.
   *
   * Hasta ahora lo único que sabíamos de un usuario era `authId`: si había
   * entrado ALGUNA VEZ. Ni cuándo, ni cada cuánto, ni a qué. Con eso no se
   * puede decidir qué construir después.
   *
   * Va agregada por (usuario, día, módulo) en vez de un evento por acción:
   * lo que interesa es "cuánta gente distinta usó reservas en agosto", no la
   * hora exacta de cada clic. Así la tabla crece con los usuarios activos y
   * no con su actividad, y el panel se puede consultar por índice.
   */
  actividadUso: defineTable({
    userId: v.id("users"),
    condominioId: v.optional(v.id("condominios")),
    /** "2026-08-07" en la zona del condominio, no UTC: si no, la actividad
     *  de la noche colombiana cae en el día siguiente y el mapa miente. */
    dia: v.string(),
    /** "app", "pagos", "asamblea", "reservas", "soporte"… */
    modulo: v.string(),
    veces: v.number(),
    ultimoAt: v.number(),
  })
    .index("by_dia", ["dia"])
    .index("by_user_dia_modulo", ["userId", "dia", "modulo"])
    .index("by_condominio_dia", ["condominioId", "dia"]),

  soportesPago: defineTable({
    condominioId: v.id("condominios"),
    unidadId: v.optional(v.id("unidades")),
    facturaId: v.optional(v.id("facturas")),
    userId: v.optional(v.id("users")),
    telefono: v.optional(v.string()),
    origen: v.union(
      v.literal("whatsapp"),
      v.literal("web"),
      v.literal("app"), // subido por el propietario desde la app móvil
    ),

    url: v.string(), // comprobante en S3
    mimeType: v.optional(v.string()),
    nota: v.optional(v.string()), // caption que acompañó la imagen

    estado: v.union(
      v.literal("pendiente_revision"),
      v.literal("aprobado"),
      v.literal("rechazado"),
    ),
    revisadoPorUserId: v.optional(v.id("users")),
    revisadoPorNombre: v.optional(v.string()),
    revisadoAt: v.optional(v.number()),
    notaRevision: v.optional(v.string()),

    createdAt: v.number(),
  })
    .index("by_condominio", ["condominioId"])
    .index("by_condominio_estado", ["condominioId", "estado"])
    .index("by_factura", ["facturaId"]),

  // ─────────────────────────────────────────────────────────────
  // VIGILANCIA — compañías de seguridad, personal, contratos y asignaciones
  //
  // Segundo eje de pertenencia. Hoy el sistema solo sabe que una persona
  // pertenece a un conjunto (`memberships`); aquí se añade que pertenece a
  // una compañía, y el contrato que conecta ambos ejes.
  //
  // La identidad NO se bifurca: un guarda sigue siendo un `users` con su
  // credencial de Better Auth. Una tabla `guardias` propia rompería el login,
  // el avatar, las notificaciones push y todo el histórico ya atribuido a
  // `userId`.
  //
  // Sigue habiendo una segunda vía legítima de ser guarda —
  // `memberships.roles ∋ "guardia"`, el vigilante propio del conjunto— y por
  // eso nada de esto es obligatorio: un conjunto que no contrate compañía no
  // ve la diferencia.
  // ─────────────────────────────────────────────────────────────

  /** La empresa de vigilancia. Tenant de servicio, hermano de `condominios`. */
  companiasSeguridad: defineTable({
    nombre: v.string(),
    /**
     * Único de hecho. Convex no tiene UNIQUE: la unicidad se comprueba en
     * código leyendo por `by_nit` antes de insertar, igual que se hace hoy
     * con `users.email`.
     */
    nit: v.optional(v.string()),

    contactoEmail: v.optional(v.string()),
    contactoTelefono: v.optional(v.string()),

    // Marca, para que el panel de compañía se vea como el del conjunto.
    logo: v.optional(v.string()),
    primaryColor: v.optional(v.string()),

    estado: estadoCompaniaValidator,
    /**
     * Quién la archivó y cuándo. Archivar es `estado: "inactiva"` —el estado
     * ya existía— y esto es solo su rastro: sin él la ficha decía que estaba
     * dada de baja pero no desde cuándo ni por orden de quién, que es lo
     * primero que se pregunta meses después. Se limpian al reactivarla.
     */
    archivadaEn: v.optional(v.number()),
    archivadaPorUserId: v.optional(v.id("users")),

    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_estado", ["estado"])
    .index("by_nit", ["nit"]),

  /**
   * Persona ↔ compañía. Espejo exacto de `memberships` en el otro eje.
   *
   * Aquí es donde irían los datos laborales (código de empleado, ARL,
   * vigencia del contrato laboral) si alguna vez hacen falta. No están porque
   * la jerarquía no los necesita y `users` ya carga con demasiadas
   * responsabilidades.
   */
  companiaMiembros: defineTable({
    userId: v.id("users"),
    companiaId: v.id("companiasSeguridad"),

    /**
     * UN SOLO ROL. Sigue siendo un array —la forma de la tabla no cambia y
     * `roles.includes(...)` se lee igual en los ciento y pico sitios que ya
     * preguntan— pero la única longitud válida es 1, y eso lo impone
     * `exigirRolUnicoCompania` en todos los puntos de escritura.
     *
     * Nació multi-rol pensando en el supervisor que además cubre turnos. El
     * caso existe, pero se paga en el sitio equivocado: tras el login hay que
     * decidir a qué experiencia entra la persona, y con guarda Y supervisor a
     * la vez no hay respuesta. Cubrir un turno siendo supervisor ya tiene su
     * sitio propio y mejor —`asignaciones.rol`, que es por conjunto—, así que
     * el array no compraba nada que el modelo no diera ya.
     */
    roles: v.array(companiaRoleValidator),

    /** Texto libre para el organigrama real ("Supervisor zona norte"). */
    cargo: v.optional(v.string()),

    isActive: v.boolean(),

    /**
     * Rastro de las operaciones sensibles sobre esta persona.
     *
     * No hay tabla de auditoría en el proyecto y no se inventa una aquí: el
     * modelo deja constancia en la propia fila afectada —`terminadoPorUserId`
     * en contratos y asignaciones, `archivadaPorUserId` en la compañía— y
     * esto sigue ese mismo camino. Responde "quién le cambió los datos" y
     * "quién le reescribió la clave, y cuándo", que es lo que se pregunta
     * cuando alguien dice que no puede entrar.
     *
     * Lo que NUNCA se guarda aquí es la clave, su hash ni nada derivado: solo
     * el hecho de que se fijó.
     */
    actualizadoPorUserId: v.optional(v.id("users")),
    passwordFijadaEn: v.optional(v.number()),
    passwordFijadaPorUserId: v.optional(v.id("users")),

    /**
     * El último cambio de rol: cuál era, cuándo se cambió y quién lo ordenó.
     *
     * Mismo mecanismo que las tres líneas de arriba y por el mismo motivo: el
     * rol decide a qué experiencia entra la persona y qué puede hacer en la
     * portería, así que "quién le cambió el rol" es exactamente la clase de
     * pregunta que se hace cuando algo no cuadra. El rol NUEVO no se duplica
     * aquí — es `roles`, que está a tres líneas.
     *
     * Guarda solo el último cambio, igual que `passwordFijadaEn`. Un
     * histórico completo pediría una tabla de auditoría, y este modelo
     * deliberadamente no tiene ninguna.
     */
    rolAnterior: v.optional(companiaRoleValidator),
    rolCambiadoEn: v.optional(v.number()),
    rolCambiadoPorUserId: v.optional(v.id("users")),

    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_compania", ["companiaId"])
    .index("by_compania_user", ["companiaId", "userId"]),

  /**
   * El contrato entre una compañía y un conjunto. Es lo que autoriza.
   *
   * No lleva enum de estado: la vigencia son fechas y el estado se deriva al
   * leer. Un enum exigiría que algo lo actualizara al vencer —un cron, que se
   * puede caer, atrasar o no haber corrido— y el día que eso pasara habría
   * personal de una compañía sin contrato entrando a un conjunto.
   *
   * Cambiar de compañía es cerrar este contrato y abrir otro. No se edita ni
   * se borra nada más, así que el histórico queda íntegro.
   */
  companiaContratos: defineTable({
    companiaId: v.id("companiasSeguridad"),
    condominioId: v.id("condominios"),

    vigenciaDesde: v.number(),
    /** Ausente = indefinido, igual que en `usuarioUnidad`. */
    vigenciaHasta: v.optional(v.number()),

    /**
     * Instante del corte a mano, y quién lo ordenó.
     *
     * `vigenciaHasta` es la fecha PACTADA y `lib/vigilancia` le regala el día
     * entero; terminar "ahora" no cabía ahí y por eso el botón no cambiaba
     * nada durante 24 horas. `finDe` toma el menor de los dos, así que basta
     * con esto para que el corte sea exacto: ninguna asignación hay que
     * tocar, que es la razón de que cuelguen del contrato.
     */
    terminadoEn: v.optional(v.number()),
    terminadoPorUserId: v.optional(v.id("users")),

    /** Referencia del contrato comercial. No autoriza nada. */
    notas: v.optional(v.string()),

    creadoPorUserId: v.id("users"),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_compania", ["companiaId"])
    .index("by_condominio", ["condominioId"])
    .index("by_condominio_compania", ["condominioId", "companiaId"]),

  /**
   * Quién opera en qué conjunto, desde cuándo y hasta cuándo.
   *
   * Cuelga del CONTRATO y no del conjunto. Es la decisión estructural del
   * modelo: terminar un contrato corta el acceso de todo su personal sin
   * escribir una sola fila más — sin cascada que ejecutar, sin cron que se
   * pueda caer y sin asignaciones huérfanas que sigan dando acceso porque
   * alguien olvidó desactivarlas.
   *
   * Es el mismo criterio con el que `usuarioUnidad` cuelga de `membershipId`
   * y no de `userId`.
   *
   * Nunca se borra: se le pone `vigenciaHasta`. Así se puede responder dónde
   * estaba asignada una persona en una fecha dada.
   */
  asignaciones: defineTable({
    contratoId: v.id("companiaContratos"),
    /**
     * Colgar del miembro y no del usuario: dar de baja al miembro invalida
     * sus asignaciones sin tener que tocarlas una por una.
     */
    companiaMiembroId: v.id("companiaMiembros"),

    /**
     * Denormalizados. `userId` responde la pregunta del arranque de sesión
     * ("¿dónde trabajo?") sin escanear `companiaMiembros`; `condominioId`
     * sigue la convención del proyecto de que toda tabla de negocio pueda
     * indexarse por tenant sin saltar por una tabla intermedia.
     */
    userId: v.id("users"),
    condominioId: v.id("condominios"),
    companiaId: v.id("companiasSeguridad"),

    /**
     * Valor único, no array: en un conjunto concreto se es una cosa. Va en la
     * asignación y no en la persona para que un supervisor pueda cubrir un
     * turno como guarda en otro conjunto.
     */
    rol: rolAsignacionValidator,

    vigenciaDesde: v.number(),
    vigenciaHasta: v.optional(v.number()),

    /** El corte a mano, igual que en el contrato y por el mismo motivo. */
    terminadoEn: v.optional(v.number()),
    terminadoPorUserId: v.optional(v.id("users")),

    creadoPorUserId: v.id("users"),
    /** Sin `updatedAt`: una asignación se termina, no se reescribe. */
    createdAt: v.number(),
  })
    .index("by_contrato", ["contratoId"])
    .index("by_miembro", ["companiaMiembroId"])
    .index("by_user", ["userId"])
    // La ruta caliente de la autorización: "¿puede esta persona operar aquí?"
    .index("by_user_condominio", ["userId", "condominioId"])
    .index("by_condominio_rol", ["condominioId", "rol"])
    .index("by_compania", ["companiaId"]),
  /** Caso operativo de una compañía en un conjunto; distinto de la minuta. */
  incidentes: defineTable({
    companiaId: v.id("companiasSeguridad"),
    condominioId: v.id("condominios"),
    tipo: v.string(),
    ubicacion: v.string(),
    ocurrioEn: v.number(),
    reportadoEn: v.number(),
    reportadoPorUserId: v.id("users"),
    reportadoPorNombre: v.string(),
    descripcion: v.string(),
    prioridad: prioridadIncidenteValidator,
    estado: estadoIncidenteValidator,
    responsableUserId: v.optional(v.id("users")),
    responsableNombre: v.optional(v.string()),
    resueltoEn: v.optional(v.number()),
    cerradoEn: v.optional(v.number()),
    resolucionObservacion: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_compania_reportado", ["companiaId", "reportadoEn"])
    .index("by_compania_estado_reportado", ["companiaId", "estado", "reportadoEn"])
    .index("by_compania_condominio_reportado", ["companiaId", "condominioId", "reportadoEn"])
    .index("by_compania_condominio_reportante", ["companiaId", "condominioId", "reportadoPorUserId", "reportadoEn"])
    .index("by_compania_condominio_estado_reportado", ["companiaId", "condominioId", "estado", "reportadoEn"])
    .index("by_compania_ocurrio", ["companiaId", "ocurrioEn"])
    .index("by_compania_condominio_ocurrio", ["companiaId", "condominioId", "ocurrioEn"])
    .index("by_compania_condominio_reportante_ocurrio", ["companiaId", "condominioId", "reportadoPorUserId", "ocurrioEn"])
    .searchIndex("buscar_ubicacion", { searchField: "ubicacion", filterFields: ["companiaId", "condominioId", "reportadoPorUserId", "estado", "prioridad", "tipo"] })
    .searchIndex("buscar_descripcion", { searchField: "descripcion", filterFields: ["companiaId", "condominioId", "reportadoPorUserId", "estado", "prioridad", "tipo"] }),

  /** Datos de terceros del caso; no se presupone una cuenta en users. */
  incidentePersonas: defineTable({
    incidenteId: v.id("incidentes"),
    companiaId: v.id("companiasSeguridad"),
    condominioId: v.id("condominios"),
    nombre: v.string(),
    tipoPersona: v.string(),
    documento: v.optional(v.string()),
    observacion: v.optional(v.string()),
    retiradoEn: v.optional(v.number()),
    retiradoPorUserId: v.optional(v.id("users")),
    retiradoPorNombre: v.optional(v.string()),
    motivoRetiro: v.optional(v.string()),
    updatedAt: v.optional(v.number()),
    createdAt: v.number(),
  }).index("by_incidente", ["incidenteId"]),

  /** Objetos del bucket privado; nunca URLs aportadas por el cliente. */
  incidenteEvidencias: defineTable({
    incidenteId: v.id("incidentes"),
    companiaId: v.id("companiasSeguridad"),
    condominioId: v.id("condominios"),
    storageKey: v.string(),
    nombre: v.string(),
    mimeType: v.string(),
    size: v.number(),
    subidoPorUserId: v.id("users"),
    subidoPorNombre: v.string(),
    createdAt: v.number(),
    retiradoEn: v.optional(v.number()),
    retiradoPorUserId: v.optional(v.id("users")),
    retiradoPorNombre: v.optional(v.string()),
    motivoRetiro: v.optional(v.string()),
  }).index("by_incidente", ["incidenteId"]),

  /** Preparación interna antes de S3. Un fallo conserva el objeto/carga para conciliación. */
  incidenteEvidenciaCargas: defineTable({
    incidenteId: v.id("incidentes"),
    companiaId: v.id("companiasSeguridad"),
    condominioId: v.id("condominios"),
    storageKey: v.string(),
    nombre: v.string(),
    mimeType: v.string(),
    size: v.number(),
    subidoPorUserId: v.id("users"),
    subidoPorNombre: v.string(),
    createdAt: v.number(),
    evidenciaId: v.optional(v.id("incidenteEvidencias")),
  }).index("by_incidente", ["incidenteId"]),

  /** Historial inmutable del caso; solo se inserta mediante logIncidenteEvento. */
  incidenteEventos: defineTable({
    incidenteId: v.id("incidentes"),
    companiaId: v.id("companiasSeguridad"),
    condominioId: v.id("condominios"),
    tipo: tipoEventoIncidenteValidator,
    descripcion: v.string(),
    personaId: v.optional(v.id("incidentePersonas")),
    evidenciaId: v.optional(v.id("incidenteEvidencias")),
    motivo: v.optional(v.string()),
    cambios: v.optional(v.array(v.object({
      campo: v.string(),
      antes: v.optional(v.string()),
      despues: v.optional(v.string()),
    }))),
    actorUserId: v.id("users"),
    actorNombre: v.string(),
    createdAt: v.number(),
  }).index("by_incidente", ["incidenteId"]),
  // ─────────────────────────────────────────────────────────────
  // INVENTARIO DE LA COMPAÑÍA
  //
  // Los elementos físicos de la empresa de vigilancia: radios, linternas,
  // chalecos, bastones. Cuelgan de la COMPAÑÍA y no del conjunto, por lo
  // mismo que `companiaMiembros`: existen antes de tener contratos, se mueven
  // de una portería a otra y sobreviven a perderlas todas.
  //
  // Dos ejes que NO se mezclan:
  //   - `estado`      → cómo está el aparato (condición física).
  //   - `archivadoEn` → si el REGISTRO sigue de alta.
  // Un radio averiado sigue estando de alta; uno archivado pudo archivarse
  // estando perfecto. Meterlo todo en un solo enum obliga a elegir cuál de
  // las dos verdades se guarda, y la otra se pierde.
  //
  // Lo que deliberadamente NO está todavía: dónde está y quién lo tiene. Eso
  // es custodia, no atributo, y va a ser una tabla con vigencia calcada de
  // `asignaciones` —no un campo aquí— para poder responder dónde estaba un
  // elemento en una fecha dada y no solo dónde está hoy.
  // ─────────────────────────────────────────────────────────────

  inventarioItems: defineTable({
    /** El tenant. Toda lectura y toda escritura pasa por él. */
    companiaId: v.id("companiasSeguridad"),

    nombre: v.string(),

    /**
     * El serial grabado en el aparato. Único de hecho por compañía entre los
     * NO archivados; Convex no tiene UNIQUE, así que se comprueba en código
     * leyendo por `by_compania_serial`, igual que `companiasSeguridad.nit` y
     * `users.email`. La mutación es una transacción serializable, así que
     * leer-comprobar-escribir dentro de ella es atómico de verdad.
     *
     * OPCIONAL, y no por descuido: media bodega de una compañía de vigilancia
     * no tiene serial —chalecos, botas, conos, bastones—. Exigirlo obliga a
     * inventar "N/A" o "SIN-SERIAL-7", que además de ser basura choca contra
     * la propia regla de unicidad que se quiere proteger. Sin serial no hay
     * nada que comprobar; con serial, no se repite.
     *
     * Se guarda normalizado —mayúsculas, sin espacios— por `normalizarSerial`:
     * el mismo aparato tecleado dos veces con distinta caja es exactamente el
     * error que la unicidad existe para atrapar.
     */
    serial: v.optional(v.string()),

    descripcion: v.optional(v.string()),

    /**
     * URL pública en S3, como `companiasSeguridad.logo` y las fotos de las
     * novedades de portería. No es `_storage`: el proyecto sube a S3 desde
     * antes y todo lo nuevo sigue por ahí.
     */
    fotoUrl: v.optional(v.string()),

    /** Condición física. Ver `estadoItemValidator` en model/roles.ts. */
    estado: estadoItemValidator,

    /**
     * El archivo (soft delete). Nunca se borra una fila: el historial de un
     * elemento dado de baja es justo el que se consulta cuando aparece un
     * faltante meses después.
     *
     * Timestamp opcional y no booleano, igual que `vehiculos.archivadoEn`:
     * "archivado" sin fecha no responde desde cuándo, que es lo primero que
     * se pregunta. Y con quién al lado, igual que `companiasSeguridad`.
     */
    archivadoEn: v.optional(v.number()),
    archivadoPorUserId: v.optional(v.id("users")),

    creadoPorUserId: v.id("users"),
    actualizadoPorUserId: v.optional(v.id("users")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    /* Sin `by_compania` a secas: es prefijo de los dos de abajo, así que no
     * responde ninguna consulta que ellos no respondan, y Convex lo mantendría
     * en cada escritura para nada. */
    /* La comprobación de duplicados. Por (compañía, serial) y no por serial a
     * secas: dos empresas distintas pueden tener el mismo número grabado y
     * eso no es conflicto de nadie. */
    .index("by_compania_serial", ["companiaId", "serial"])
    /* Activos y archivados son dos listados distintos y se separan EN LA BASE,
     * no filtrando en memoria: la pantalla de archivados de una compañía con
     * miles de elementos no puede costar leerlos todos. */
    .index("by_compania_archivado", ["companiaId", "archivadoEn"]),

  /**
   * EL HISTORIAL DE UN ELEMENTO. Append-only: nunca se edita ni se borra.
   *
   * Misma forma que `minutaEventos` y por el mismo motivo: hay un único sitio
   * que escribe aquí —`model/inventarioNovedad.ts:logNovedadItem`— y las
   * mutaciones lo llaman. Repartir el registro por cada mutación garantiza
   * que la sexta se olvide.
   *
   * `tipo` es un enum y no una cadena suelta: sobre texto libre no se filtra,
   * no se cuenta y no se pinta distinto. La frase legible va en `descripcion`
   * y se compone al escribir; el dato duro va en `tipo` y `cambios`.
   */
  inventarioNovedades: defineTable({
    itemId: v.id("inventarioItems"),

    /**
     * Denormalizado desde el item. El proyecto ya lo hace en `asignaciones`
     * con `condominioId`, por lo mismo: toda tabla de negocio tiene que poder
     * indexarse por su tenant sin saltar a la tabla padre.
     */
    companiaId: v.id("companiasSeguridad"),

    tipo: tipoNovedadItemValidator,

    /** Frase legible ya compuesta. Es lo que se pinta en la línea de tiempo. */
    descripcion: v.string(),

    /**
     * QUÉ cambió exactamente, campo por campo.
     *
     * Sin esto, "Item editado" no dice nada útil: el motivo por el que se
     * mira un historial es saber quién le cambió el serial, no que alguien lo
     * tocó. Valores como texto ya formateado —no tipados— porque se pintan,
     * no se recalculan, y así el registro sobrevive a que un campo cambie de
     * tipo más adelante.
     */
    cambios: v.optional(
      v.array(
        v.object({
          campo: v.string(),
          antes: v.optional(v.string()),
          despues: v.optional(v.string()),
        }),
      ),
    ),

    /**
     * PREPARADOS Y SIN USAR. No los escribe nada todavía.
     *
     * Están aquí porque añadir un campo opcional a una tabla con filas es
     * gratis en Convex, pero declararlos desde el principio documenta hacia
     * dónde va el módulo y evita que la asignación a conjuntos termine
     * inventándose su propio historial paralelo.
     *
     * Con ellos, "¿quién recibió este radio, en qué conjunto y cuándo lo
     * devolvió?" se responde recorriendo `by_item`, sin tabla nueva.
     */
    condominioId: v.optional(v.id("condominios")),
    guardaUserId: v.optional(v.id("users")),

    actorUserId: v.id("users"),
    /* Copiado, no solo referenciado: el mismo criterio que
     * `guardiaNovedadReportes.reportadoPorNombre`. Si la persona se da de baja
     * o cambia de nombre, el historial tiene que seguir diciendo quién obró. */
    actorNombre: v.string(),

    /* Sin `updatedAt`: una novedad ocurrió, no se reescribe. */
    createdAt: v.number(),
  })
    /* La línea de tiempo de un elemento: la ruta caliente del detalle, y la
     * única forma en que se lee esta tabla. Un índice por compañía se
     * mantendría en cada novedad —la escritura más frecuente del módulo— sin
     * que nadie lo consulte. */
    .index("by_item", ["itemId"]),
  /**
   * LA CUSTODIA: dónde está un elemento y desde cuándo.
   *
   * Tabla propia y no un `condominioId` dentro de `inventarioItems`, porque un
   * campo solo sabe dónde está HOY: el día que el radio vuelve y sale a otro
   * conjunto, la respuesta anterior se pierde y con ella la pregunta que de
   * verdad se hace —"¿por dónde ha pasado esto?"—.
   *
   * ── Por qué NO cuelga del contrato ──────────────────────────────────
   * `asignaciones` (el personal) cuelga de `companiaContratos` para que
   * terminar un contrato corte el acceso de toda su gente sin escribir una
   * fila. Aquí sería un error copiarlo: terminar un contrato NO devuelve
   * físicamente el radio. Si la custodia caducara con el contrato, el sistema
   * diría que está en la bodega mientras sigue en la portería, y el faltante
   * se volvería invisible justo cuando hay que reclamarlo.
   *
   * El contrato decide si se PUEDE entregar —solo a un conjunto que la
   * compañía atiende hoy— y se guarda para poder preguntar después qué se
   * quedó sin devolver al terminarlo. Pero solo un acto explícito de
   * devolución cierra una custodia.
   *
   * ── Por qué no hay `vigenciaHasta` ──────────────────────────────────
   * No existe fecha pactada de devolución de un radio. Y si se declarara,
   * habría dos fuentes de verdad para "¿está aquí?" —la fecha y el hecho— que
   * acabarían discrepando; el índice `by_item_devuelto`, que es lo que hace
   * que la custodia activa se resuelva en UNA lectura y sin ambigüedad,
   * seguiría solo a una de las dos. Un único final: `devueltaEn`.
   *
   * Nunca se borra ni se reescribe una fila cerrada: el ciclo
   * compañía → A → compañía → B deja dos filas, no una editada.
   * ─────────────────────────────────────────────────────────────
   */
  inventarioAsignaciones: defineTable({
    itemId: v.id("inventarioItems"),

    /**
     * Denormalizado desde el elemento, igual que `asignaciones.condominioId`
     * y por lo mismo: toda tabla de negocio tiene que poder indexarse por su
     * tenant sin saltar a la tabla padre. Además cierra el aislamiento — leer
     * una custodia no obliga a cargar el item para saber de quién es.
     */
    companiaId: v.id("companiasSeguridad"),

    condominioId: v.id("condominios"),

    /**
     * El contrato bajo el que salió. NO la termina, y por eso no hay índice
     * por él: es rastro, no autorización. Responde "¿qué nos quedamos sin
     * devolver cuando se acabó ese contrato?", que es la primera pregunta al
     * cerrar una relación comercial.
     *
     * Opcional porque la plataforma puede obrar sin contrato de por medio, y
     * porque un contrato borrado no debe impedir cerrar la custodia.
     */
    contratoId: v.optional(v.id("companiaContratos")),

    /** Cuándo salió, y quién la entregó. */
    asignadaEn: v.number(),
    asignadaPorUserId: v.id("users"),
    /** Lo que dijo quien la entregó. Opcional. */
    observacionAsignacion: v.optional(v.string()),

    /**
     * EL ÚNICO FINAL. Ausente = el elemento sigue en ese conjunto.
     *
     * Timestamp y no booleano, igual que `inventarioItems.archivadoEn`:
     * "devuelto" sin fecha no responde desde cuándo, que es lo primero que se
     * pregunta al cuadrar un inventario.
     */
    devueltaEn: v.optional(v.number()),
    devueltaPorUserId: v.optional(v.id("users")),
    observacionDevolucion: v.optional(v.string()),

    /* Sin `updatedAt`: una custodia se abre y se cierra, no se reescribe. */
    createdAt: v.number(),
  })
    /* El historial de un elemento, del más reciente al más antiguo. */
    .index("by_item", ["itemId"])
    /**
     * LA RUTA CALIENTE. `.eq("devueltaEn", undefined)` da la custodia activa
     * de un elemento en una sola lectura, y es lo que convierte "como máximo
     * una activa" en una regla comprobable en vez de en una esperanza. Mismo
     * truco que `inventarioItems.by_compania_archivado`.
     */
    .index("by_item_devuelta", ["itemId", "devueltaEn"])
    /**
     * Qué tiene HOY una compañía en un conjunto.
     *
     * Lleva `companiaId` delante a propósito. Un índice solo por conjunto
     * mezcla el material de las dos empresas que pueden cubrir la misma
     * portería, y filtrar después de acotar la lectura daría cero elementos a
     * quien sí tiene material allí — el peor resultado posible en la pantalla
     * con la que se reclama un faltante.
     */
    .index("by_compania_condominio_devuelta", [
      "companiaId",
      "condominioId",
      "devueltaEn",
    ])
    /* Todo lo que la compañía tiene fuera. Sostiene el listado sin N+1: una
     * lectura da la custodia de todos los elementos de la página. */
    .index("by_compania_devuelta", ["companiaId", "devueltaEn"]),
  /**
   * LA CUSTODIA INTERNA: qué guarda tiene el elemento dentro del conjunto.
   *
   * ── Por qué CUELGA de `inventarioAsignaciones` ──────────────────────
   * Es el mismo mecanismo con el que `asignaciones` cuelga de
   * `companiaContratos`, y la tarea 2 lo dejó prometido a propósito: cerrar la
   * custodia del conjunto invalida la del guarda sin escribir una sola fila,
   * sin cascada que ejecutar y sin custodias huérfanas que sigan diciendo que
   * alguien tiene un radio de un conjunto que ya devolvió todo.
   *
   * La alternativa —colgar del elemento y guardar el conjunto al lado— dejaba
   * dos verdades sobre dónde está la cosa, que es exactamente lo que este
   * módulo existe para no tener.
   *
   * ── Lo que NO es ────────────────────────────────────────────────────
   * NO es `compañía → guarda`. El elemento sigue asignado al conjunto
   * mientras un guarda lo tiene; ésta es una custodia ANIDADA dentro de
   * aquélla, no una que la sustituya. Por eso son dos tablas y no una con un
   * campo "tipo de destinatario": con una sola, un elemento en el conjunto A
   * en manos de Juan tendría dos filas activas y la regla "una custodia
   * activa" dejaría de poder comprobarse.
   *
   * ── La relación laboral NO la cierra ────────────────────────────────
   * Que a Juan se le acabe la asignación al conjunto no devuelve el radio,
   * igual que terminar un contrato no lo devuelve a la bodega. La asignación
   * laboral decide si puede RECIBIR material nuevo; esta fila dice dónde está
   * físicamente, y solo se cierra con una devolución explícita. Un guarda sin
   * asignación y con custodia abierta es un pendiente que hay que resolver, y
   * la pantalla del supervisor lo señala en vez de esconderlo.
   * ─────────────────────────────────────────────────────────────
   */
  inventarioCustodiaGuardas: defineTable({
    /** La custodia del conjunto de la que depende. La que manda. */
    inventarioAsignacionId: v.id("inventarioAsignaciones"),

    /**
     * Denormalizados desde la asignación padre, igual que en `asignaciones` y
     * por lo mismo: poder indexar por elemento, por tenant y por conjunto sin
     * saltar a la tabla de arriba en cada lectura.
     */
    itemId: v.id("inventarioItems"),
    companiaId: v.id("companiasSeguridad"),
    condominioId: v.id("condominios"),

    /**
     * Quién lo tiene. Es un `users` y no un `companiaMiembros` porque la
     * identidad del guarda nunca se bifurcó en este proyecto —lo dice el
     * schema de vigilancia— y porque la custodia sigue siendo suya aunque se
     * le dé de baja como miembro: lo que hay que poder responder es "quién
     * tiene el radio", no "quién lo tenía mientras estuvo contratado".
     */
    guardaUserId: v.id("users"),

    entregadaEn: v.number(),
    /** El supervisor que se lo entregó. */
    entregadaPorUserId: v.id("users"),
    observacionEntrega: v.optional(v.string()),

    /**
     * EL ÚNICO FINAL. Ausente = el guarda todavía lo tiene.
     *
     * Mismo criterio que `inventarioAsignaciones.devueltaEn` y que
     * `inventarioItems.archivadoEn`: un timestamp opcional, nunca un booleano,
     * porque "devuelto" sin fecha no responde desde cuándo.
     */
    devueltaEn: v.optional(v.number()),
    /** El supervisor que se lo recibió. */
    devueltaPorUserId: v.optional(v.id("users")),
    observacionDevolucion: v.optional(v.string()),

    /* Sin `updatedAt`: una custodia se abre y se cierra, no se reescribe. */
    createdAt: v.number(),
  })
    /* El historial de manos por las que pasó un elemento. */
    .index("by_item", ["itemId"])
    /**
     * LA RUTA CALIENTE, y la que sostiene DOS reglas a la vez: que un elemento
     * no pueda estar en manos de dos guardas, y que el conjunto no pueda
     * devolverlo a la compañía mientras alguien lo tenga. Una lectura.
     */
    .index("by_item_devuelta", ["itemId", "devueltaEn"])
    /**
     * Todo lo que está repartido hoy en una portería. Con la compañía DELANTE:
     * dos empresas pueden cubrir el mismo conjunto, y acotar la lectura por
     * conjunto para filtrar después por compañía se lleva las filas de la otra
     * — el error que la tarea 2 ya pagó una vez.
     */
    .index("by_compania_condominio_devuelta", [
      "companiaId",
      "condominioId",
      "devueltaEn",
    ]),

  // ─────────────────────────────────────────────────────────────
  // INASISTENCIAS DEL PERSONAL DE GUARDA
  //
  // "Durante esta ventana este guarda no está disponible para planificar, y
  // por qué." Es información de planificación, no de autorización: no
  // termina asignaciones, no cierra turnos ni quita acceso a ningún conjunto.
  //
  // Pertenece al guarda DENTRO de su compañía, no a una asignación ni a un
  // conjunto: el guarda que cubre dos porterías tiene una sola incapacidad.
  // Solo guardas (`companiaMiembros.roles` = ["guardia"]), igual que la
  // futura cobertura temporal.
  //
  // No se borra ni se reescribe: se registra y, si sobra, se anula. La fila
  // lleva su propio rastro —quién la registró, quién la anuló y cuándo—, el
  // mismo camino que `terminadoPorUserId` en contratos y asignaciones.
  // ─────────────────────────────────────────────────────────────

  inasistencias: defineTable({
    companiaId: v.id("companiasSeguridad"),
    /** El guarda. */
    userId: v.id("users"),

    tipo: tipoInasistenciaValidator,
    /** Obligatorio en `inasistencia` y `otro`; ver `lib/inasistencias.ts`. */
    motivo: v.optional(v.string()),

    /**
     * La ventana, en instantes exactos y con `fin` EXCLUIDO, en las dos
     * modalidades: las consultas por rango y el solape no distinguen casos.
     */
    inicio: v.number(),
    fin: v.number(),
    /**
     * Días completos: además de los instantes se guarda la fecha civil tal
     * como se pidió (`fechaFin` incluida), que es lo que se muestra. Ausentes
     * cuando la ventana va con hora.
     */
    diaCompleto: v.boolean(),
    fechaInicio: v.optional(v.string()),
    fechaFin: v.optional(v.string()),

    /** Solo `activa` cuenta como indisponibilidad. */
    estado: estadoInasistenciaValidator,

    registradaPorUserId: v.id("users"),
    /** Cuándo se registró. Sin `updatedAt`: no se reescribe. */
    createdAt: v.number(),
    anuladaEn: v.optional(v.number()),
    anuladaPorUserId: v.optional(v.id("users")),
  })
    /* El historial de un guarda y el solape al registrar: una lectura. */
    .index("by_compania_user", ["companiaId", "userId", "inicio"])
    /* Las activas de la compañía que aún no han terminado en una fecha: el
     * listado por rango empieza por aquí y descarta las que empiezan tarde. */
    .index("by_compania_estado_fin", ["companiaId", "estado", "fin"]),
});
