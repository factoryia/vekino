/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as acta from "../acta.js";
import type * as aporte from "../aporte.js";
import type * as asambleaInvitados from "../asambleaInvitados.js";
import type * as asambleaSala from "../asambleaSala.js";
import type * as asambleas from "../asambleas.js";
import type * as asignaciones from "../asignaciones.js";
import type * as auth from "../auth.js";
import type * as authMigrate from "../authMigrate.js";
import type * as automatizaciones from "../automatizaciones.js";
import type * as avalHttp from "../avalHttp.js";
import type * as companias from "../companias.js";
import type * as comunicados from "../comunicados.js";
import type * as condominios from "../condominios.js";
import type * as consejo from "../consejo.js";
import type * as credenciales from "../credenciales.js";
import type * as crons from "../crons.js";
import type * as dev from "../dev.js";
import type * as diagnosticoSala from "../diagnosticoSala.js";
import type * as documentos from "../documentos.js";
import type * as facturas from "../facturas.js";
import type * as files from "../files.js";
import type * as guardia from "../guardia.js";
import type * as historial from "../historial.js";
import type * as hogar from "../hogar.js";
import type * as http from "../http.js";
import type * as intervenciones from "../intervenciones.js";
import type * as inventario from "../inventario.js";
import type * as inventarioAsignaciones from "../inventarioAsignaciones.js";
import type * as inventarioGuardas from "../inventarioGuardas.js";
import type * as lib_aporte from "../lib/aporte.js";
import type * as lib_avalProduccion from "../lib/avalProduccion.js";
import type * as lib_brevo from "../lib/brevo.js";
import type * as lib_buscarCasa from "../lib/buscarCasa.js";
import type * as lib_cartera from "../lib/cartera.js";
import type * as lib_certificacion from "../lib/certificacion.js";
import type * as lib_cloudflareRealtime from "../lib/cloudflareRealtime.js";
import type * as lib_cobroParqueadero from "../lib/cobroParqueadero.js";
import type * as lib_codigoAsistencia from "../lib/codigoAsistencia.js";
import type * as lib_costoReserva from "../lib/costoReserva.js";
import type * as lib_depositoReserva from "../lib/depositoReserva.js";
import type * as lib_emailApoderado from "../lib/emailApoderado.js";
import type * as lib_emailCredenciales from "../lib/emailCredenciales.js";
import type * as lib_expoPush from "../lib/expoPush.js";
import type * as lib_fechaTexto from "../lib/fechaTexto.js";
import type * as lib_filtroAporte from "../lib/filtroAporte.js";
import type * as lib_guiasVekino from "../lib/guiasVekino.js";
import type * as lib_horarios from "../lib/horarios.js";
import type * as lib_importarVehiculos from "../lib/importarVehiculos.js";
import type * as lib_inventario from "../lib/inventario.js";
import type * as lib_livekitJwt from "../lib/livekitJwt.js";
import type * as lib_mensajesAcceso from "../lib/mensajesAcceso.js";
import type * as lib_passwordFuerte from "../lib/passwordFuerte.js";
import type * as lib_periodos from "../lib/periodos.js";
import type * as lib_permanencia from "../lib/permanencia.js";
import type * as lib_placa from "../lib/placa.js";
import type * as lib_redactor from "../lib/redactor.js";
import type * as lib_referenciaPago from "../lib/referenciaPago.js";
import type * as lib_ronda from "../lib/ronda.js";
import type * as lib_telefono from "../lib/telefono.js";
import type * as lib_vigilancia from "../lib/vigilancia.js";
import type * as lib_ycloud from "../lib/ycloud.js";
import type * as limpieza from "../limpieza.js";
import type * as memberships from "../memberships.js";
import type * as migrations from "../migrations.js";
import type * as model_acceso from "../model/acceso.js";
import type * as model_asignacion from "../model/asignacion.js";
import type * as model_authz from "../model/authz.js";
import type * as model_credencial from "../model/credencial.js";
import type * as model_depositoReserva from "../model/depositoReserva.js";
import type * as model_displayName from "../model/displayName.js";
import type * as model_files from "../model/files.js";
import type * as model_inventarioCustodia from "../model/inventarioCustodia.js";
import type * as model_inventarioNovedad from "../model/inventarioNovedad.js";
import type * as model_latidos from "../model/latidos.js";
import type * as model_minuta from "../model/minuta.js";
import type * as model_placa from "../model/placa.js";
import type * as model_quorum from "../model/quorum.js";
import type * as model_roles from "../model/roles.js";
import type * as model_s3 from "../model/s3.js";
import type * as model_userImage from "../model/userImage.js";
import type * as model_visitantes from "../model/visitantes.js";
import type * as notificacionesFeed from "../notificacionesFeed.js";
import type * as notifications from "../notifications.js";
import type * as novedades from "../novedades.js";
import type * as pagos from "../pagos.js";
import type * as pagosPruebas from "../pagosPruebas.js";
import type * as parqueadero from "../parqueadero.js";
import type * as platform from "../platform.js";
import type * as portal from "../portal.js";
import type * as pqrs from "../pqrs.js";
import type * as preguntaIa from "../preguntaIa.js";
import type * as push from "../push.js";
import type * as reservas from "../reservas.js";
import type * as rondas from "../rondas.js";
import type * as salaBitacora from "../salaBitacora.js";
import type * as salaCloudflare from "../salaCloudflare.js";
import type * as salaPermisos from "../salaPermisos.js";
import type * as salaToken from "../salaToken.js";
import type * as salaVideo from "../salaVideo.js";
import type * as soporte from "../soporte.js";
import type * as soportesPago from "../soportesPago.js";
import type * as unidades from "../unidades.js";
import type * as users from "../users.js";
import type * as uso from "../uso.js";
import type * as vehiculos from "../vehiculos.js";
import type * as visitantes from "../visitantes.js";
import type * as whatsapp from "../whatsapp.js";
import type * as whatsappAgente from "../whatsappAgente.js";
import type * as whatsappBroadcast from "../whatsappBroadcast.js";
import type * as whatsappInbox from "../whatsappInbox.js";
import type * as whatsappNotifs from "../whatsappNotifs.js";
import type * as whatsappTemplates from "../whatsappTemplates.js";
import type * as whatsappVinculacion from "../whatsappVinculacion.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  acta: typeof acta;
  aporte: typeof aporte;
  asambleaInvitados: typeof asambleaInvitados;
  asambleaSala: typeof asambleaSala;
  asambleas: typeof asambleas;
  asignaciones: typeof asignaciones;
  auth: typeof auth;
  authMigrate: typeof authMigrate;
  automatizaciones: typeof automatizaciones;
  avalHttp: typeof avalHttp;
  companias: typeof companias;
  comunicados: typeof comunicados;
  condominios: typeof condominios;
  consejo: typeof consejo;
  credenciales: typeof credenciales;
  crons: typeof crons;
  dev: typeof dev;
  diagnosticoSala: typeof diagnosticoSala;
  documentos: typeof documentos;
  facturas: typeof facturas;
  files: typeof files;
  guardia: typeof guardia;
  historial: typeof historial;
  hogar: typeof hogar;
  http: typeof http;
  intervenciones: typeof intervenciones;
  inventario: typeof inventario;
  inventarioAsignaciones: typeof inventarioAsignaciones;
  inventarioGuardas: typeof inventarioGuardas;
  "lib/aporte": typeof lib_aporte;
  "lib/avalProduccion": typeof lib_avalProduccion;
  "lib/brevo": typeof lib_brevo;
  "lib/buscarCasa": typeof lib_buscarCasa;
  "lib/cartera": typeof lib_cartera;
  "lib/certificacion": typeof lib_certificacion;
  "lib/cloudflareRealtime": typeof lib_cloudflareRealtime;
  "lib/cobroParqueadero": typeof lib_cobroParqueadero;
  "lib/codigoAsistencia": typeof lib_codigoAsistencia;
  "lib/costoReserva": typeof lib_costoReserva;
  "lib/depositoReserva": typeof lib_depositoReserva;
  "lib/emailApoderado": typeof lib_emailApoderado;
  "lib/emailCredenciales": typeof lib_emailCredenciales;
  "lib/expoPush": typeof lib_expoPush;
  "lib/fechaTexto": typeof lib_fechaTexto;
  "lib/filtroAporte": typeof lib_filtroAporte;
  "lib/guiasVekino": typeof lib_guiasVekino;
  "lib/horarios": typeof lib_horarios;
  "lib/importarVehiculos": typeof lib_importarVehiculos;
  "lib/inventario": typeof lib_inventario;
  "lib/livekitJwt": typeof lib_livekitJwt;
  "lib/mensajesAcceso": typeof lib_mensajesAcceso;
  "lib/passwordFuerte": typeof lib_passwordFuerte;
  "lib/periodos": typeof lib_periodos;
  "lib/permanencia": typeof lib_permanencia;
  "lib/placa": typeof lib_placa;
  "lib/redactor": typeof lib_redactor;
  "lib/referenciaPago": typeof lib_referenciaPago;
  "lib/ronda": typeof lib_ronda;
  "lib/telefono": typeof lib_telefono;
  "lib/vigilancia": typeof lib_vigilancia;
  "lib/ycloud": typeof lib_ycloud;
  limpieza: typeof limpieza;
  memberships: typeof memberships;
  migrations: typeof migrations;
  "model/acceso": typeof model_acceso;
  "model/asignacion": typeof model_asignacion;
  "model/authz": typeof model_authz;
  "model/credencial": typeof model_credencial;
  "model/depositoReserva": typeof model_depositoReserva;
  "model/displayName": typeof model_displayName;
  "model/files": typeof model_files;
  "model/inventarioCustodia": typeof model_inventarioCustodia;
  "model/inventarioNovedad": typeof model_inventarioNovedad;
  "model/latidos": typeof model_latidos;
  "model/minuta": typeof model_minuta;
  "model/placa": typeof model_placa;
  "model/quorum": typeof model_quorum;
  "model/roles": typeof model_roles;
  "model/s3": typeof model_s3;
  "model/userImage": typeof model_userImage;
  "model/visitantes": typeof model_visitantes;
  notificacionesFeed: typeof notificacionesFeed;
  notifications: typeof notifications;
  novedades: typeof novedades;
  pagos: typeof pagos;
  pagosPruebas: typeof pagosPruebas;
  parqueadero: typeof parqueadero;
  platform: typeof platform;
  portal: typeof portal;
  pqrs: typeof pqrs;
  preguntaIa: typeof preguntaIa;
  push: typeof push;
  reservas: typeof reservas;
  rondas: typeof rondas;
  salaBitacora: typeof salaBitacora;
  salaCloudflare: typeof salaCloudflare;
  salaPermisos: typeof salaPermisos;
  salaToken: typeof salaToken;
  salaVideo: typeof salaVideo;
  soporte: typeof soporte;
  soportesPago: typeof soportesPago;
  unidades: typeof unidades;
  users: typeof users;
  uso: typeof uso;
  vehiculos: typeof vehiculos;
  visitantes: typeof visitantes;
  whatsapp: typeof whatsapp;
  whatsappAgente: typeof whatsappAgente;
  whatsappBroadcast: typeof whatsappBroadcast;
  whatsappInbox: typeof whatsappInbox;
  whatsappNotifs: typeof whatsappNotifs;
  whatsappTemplates: typeof whatsappTemplates;
  whatsappVinculacion: typeof whatsappVinculacion;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  betterAuth: import("@convex-dev/better-auth/_generated/component.js").ComponentApi<"betterAuth">;
};
