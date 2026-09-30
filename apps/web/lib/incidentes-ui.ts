/** Opciones de presentación del registro. El dominio conserva `tipo` como texto. */
export const TIPOS_INCIDENTE = [
  { value: "SEGURIDAD", label: "Seguridad" },
  { value: "ACCESO", label: "Acceso" },
  { value: "HURTO_ROBO", label: "Hurto o robo" },
  { value: "DANO_PROPIEDAD", label: "Daño a propiedad" },
  { value: "EMERGENCIA", label: "Emergencia" },
  { value: "CONVIVENCIA", label: "Convivencia" },
  { value: "ACCIDENTE", label: "Accidente" },
  { value: "ALTERACION_ORDEN", label: "Alteración del orden" },
  { value: "PERSONA_SOSPECHOSA", label: "Persona sospechosa" },
  { value: "VEHICULO", label: "Vehículo" },
  { value: "OTRO", label: "Otro" },
] as const;

export const PRIORIDADES_INCIDENTE = [
  { value: "BAJA", label: "Baja", hint: "Puede atenderse en el curso habitual", tone: "neutral" },
  { value: "MEDIA", label: "Media", hint: "Requiere atención oportuna", tone: "info" },
  { value: "ALTA", label: "Alta", hint: "Requiere atención pronta", tone: "warning" },
  { value: "CRITICA", label: "Crítica", hint: "Requiere atención inmediata", tone: "destructive" },
] as const;

export const TIPOS_PERSONA = [
  { value: "RESIDENTE", label: "Residente" },
  { value: "VISITANTE", label: "Visitante" },
  { value: "EMPLEADO", label: "Empleado" },
  { value: "PROVEEDOR", label: "Proveedor" },
  { value: "CONTRATISTA", label: "Contratista" },
  { value: "GUARDA", label: "Guarda" },
  { value: "TERCERO", label: "Tercero" },
  { value: "OTRO", label: "Otra persona" },
] as const;

export type PrioridadIncidente = (typeof PRIORIDADES_INCIDENTE)[number]["value"];
export type PersonaBorrador = {
  nombre: string;
  tipoPersona: string;
  documento: string;
  observacion: string;
};
export type IncidenteBorrador = {
  condominioId: string;
  tipo: string;
  prioridad: string;
  ocurrioEn: string;
  ubicacion: string;
  descripcion: string;
  personas: PersonaBorrador[];
};

export function fechaHoraLocal(fecha: Date): string {
  const dos = (n: number) => String(n).padStart(2, "0");
  return `${fecha.getFullYear()}-${dos(fecha.getMonth() + 1)}-${dos(fecha.getDate())}T${dos(fecha.getHours())}:${dos(fecha.getMinutes())}`;
}

export function validarIncidenteBorrador(
  borrador: IncidenteBorrador,
  conjuntosPermitidos: readonly string[],
  ahora: number,
): Record<string, string> {
  const errores: Record<string, string> = {};
  if (!borrador.condominioId || !conjuntosPermitidos.includes(borrador.condominioId)) {
    errores.condominioId = "Selecciona un conjunto de tu operación vigente.";
  }
  if (!TIPOS_INCIDENTE.some((x) => x.value === borrador.tipo)) {
    errores.tipo = "Selecciona el tipo de incidente.";
  }
  if (!PRIORIDADES_INCIDENTE.some((x) => x.value === borrador.prioridad)) {
    errores.prioridad = "Selecciona una prioridad.";
  }
  const fecha = Date.parse(borrador.ocurrioEn);
  if (!borrador.ocurrioEn || !Number.isFinite(fecha) || fecha <= 0) {
    errores.ocurrioEn = "Indica una fecha y hora válidas para el hecho.";
  } else if (fecha > ahora) {
    errores.ocurrioEn = "La fecha del hecho no puede ser futura.";
  }
  const ubicacion = borrador.ubicacion.trim();
  if (!ubicacion || ubicacion.length > 200) {
    errores.ubicacion = "Indica la ubicación (máximo 200 caracteres).";
  }
  const descripcion = borrador.descripcion.trim();
  if (!descripcion || descripcion.length > 5000) {
    errores.descripcion = "Describe lo ocurrido (máximo 5000 caracteres).";
  }
  borrador.personas.forEach((persona, i) => {
    if (!persona.nombre.trim() || persona.nombre.trim().length > 160) {
      errores[`personas.${i}.nombre`] = "Indica el nombre (máximo 160 caracteres).";
    }
    if (!TIPOS_PERSONA.some((x) => x.value === persona.tipoPersona)) {
      errores[`personas.${i}.tipoPersona`] = "Selecciona el tipo de persona.";
    }
    if (persona.documento.trim().length > 80) {
      errores[`personas.${i}.documento`] = "Máximo 80 caracteres.";
    }
    if (persona.observacion.trim().length > 2000) {
      errores[`personas.${i}.observacion`] = "Máximo 2000 caracteres.";
    }
  });
  return errores;
}

/** Campos aceptados por `incidentes.crear`; identidad, compañía y estado quedan en Convex. */
export function argumentosCrearIncidente(borrador: IncidenteBorrador) {
  return {
    condominioId: borrador.condominioId,
    tipo: borrador.tipo,
    prioridad: borrador.prioridad as PrioridadIncidente,
    ocurrioEn: Date.parse(borrador.ocurrioEn),
    ubicacion: borrador.ubicacion.trim(),
    descripcion: borrador.descripcion.trim(),
    personas: borrador.personas.map(({ nombre, tipoPersona, documento, observacion }) => ({
      nombre: nombre.trim(), tipoPersona,
      ...(documento.trim() ? { documento: documento.trim() } : {}),
      ...(observacion.trim() ? { observacion: observacion.trim() } : {}),
    })),
  };
}

/** Bloquea un segundo clic hasta que Convex responda. El éxito mantiene el bloqueo hasta navegar. */
export function registrarIncidenteUnaVez<T>(
  bloqueo: { current: boolean },
  crear: () => Promise<T>,
): Promise<T> | null {
  if (bloqueo.current) return null;
  bloqueo.current = true;
  try {
    return crear().catch((error: unknown) => {
      bloqueo.current = false;
      throw error;
    });
  } catch (error) {
    bloqueo.current = false;
    throw error;
  }
}

export function mensajeErrorIncidente(error: unknown): string {
  const texto = error instanceof Error ? error.message : String(error);
  if (/No autenticado|perfil inexistente|Unauthenticated/i.test(texto)) {
    return "Tu sesión terminó. Inicia sesión de nuevo para registrar el incidente.";
  }
  if (/no pertenece a una compañía|no pertenece a la compañía|no tiene permiso|no tiene acceso/i.test(texto)) {
    return "Ya no tienes permiso para esta operación. Consulta al administrador de tu compañía.";
  }
  if (/contrato vigente|conjunto no está activo|compañía no está activa|compañía o conjunto no encontrado/i.test(texto)) {
    return "Este conjunto ya no está disponible para tu compañía. Actualiza la página y elige uno vigente.";
  }
  if (/fecha del incidente/i.test(texto)) return "La fecha del hecho debe ser válida y no futura.";
  if (/Tipo debe|Ubicación debe|Descripción debe|Nombre debe|Tipo de persona debe|Documento debe|Observación debe/i.test(texto)) {
    return "Revisa los campos del formulario y vuelve a intentarlo.";
  }
  return "No pudimos registrar el incidente. Conservamos tus datos; inténtalo de nuevo.";
}

export function etiquetaTipoIncidente(tipo: string): string {
  return TIPOS_INCIDENTE.find((x) => x.value === tipo)?.label ?? tipo;
}
