import { beforeEach, afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { montar } from "./helpers/incidentes";
import { MAX_EVIDENCIA_BYTES } from "../convex/lib/incidenteEvidencias";

const aws = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class { send = aws.send; },
  PutObjectCommand: class { constructor(public input: unknown) {} },
  DeleteObjectCommand: class { constructor(public input: unknown) {} },
  GetObjectCommand: class { constructor(public input: unknown) {} },
  GetPublicAccessBlockCommand: class { constructor(public input: unknown) {} },
}));

type Escenario = Awaited<ReturnType<typeof montar>>;
const foto = () => ({ nombre: "foto.jpg", mimeType: "image/jpeg", bytes: new Uint8Array([255, 216, 255, 224]).buffer });
describe("expediente privado: evidencias, personas e identidad histórica", () => {
  let e: Escenario;
  beforeEach(async () => {
    e = await montar();
    vi.stubEnv("AWS_INCIDENTES_BUCKET_NAME", "evidencias-privadas");
    vi.stubEnv("AWS_S3_BUCKET_NAME", "archivos-publicos");
    vi.stubEnv("AWS_INCIDENTES_ACCESS_KEY_ID", "fake");
    vi.stubEnv("AWS_INCIDENTES_SECRET_ACCESS_KEY", "fake-secret");
    aws.send.mockReset().mockImplementation(async (command) => command.constructor.name === "GetObjectCommand" ? { ContentLength: 4, Body: { transformToByteArray: async () => new Uint8Array([255, 216, 255, 224]) } } : { PublicAccessBlockConfiguration: {
      BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true,
    } });
  });
  afterEach(() => vi.unstubAllEnvs());
  const crear = async () => e.como("guardaA").mutation(api.incidentes.crear, e.datos());
  const subir = async () => {
    const incidenteId = await crear();
    const evidenciaId = await e.como("guardaA").action(api.incidenteArchivos.subir, { incidenteId, ...foto() });
    return { incidenteId, evidenciaId };
  };

  test("subida autorizada: bucket separado, clave del padre, bytes acotados, actor y hora de servidor", async () => {
    const antes = Date.now();
    const { incidenteId, evidenciaId } = await subir();
    const doc = await e.t.run((ctx) => ctx.db.get(evidenciaId));
    expect(doc).toMatchObject({ incidenteId, companiaId: e.companiaA, condominioId: e.conjunto,
      nombre: "foto.jpg", mimeType: "image/jpeg", size: 4, subidoPorUserId: e.guardaA, subidoPorNombre: "Gabriel Andina" });
    expect(doc!.createdAt).toBeGreaterThanOrEqual(antes);
    expect(doc!.createdAt).toBeLessThanOrEqual(Date.now());
    expect(doc!.storageKey).toContain(`incidentes/${e.companiaA}/${e.conjunto}/${incidenteId}/`);
    expect(aws.send.mock.calls[1]![0].input).toMatchObject({ Bucket: "evidencias-privadas", Key: doc!.storageKey,
      ContentLength: 4, ContentType: "image/jpeg", ServerSideEncryption: "AES256", CacheControl: "private, no-store" });
    const lista = await e.como("adminA").query(api.incidenteEvidencias.listar, { incidenteId });
    expect(lista).toHaveLength(1); expect(lista[0]).not.toHaveProperty("storageKey"); expect(lista[0]).not.toHaveProperty("url");
    const eventos = await e.como("adminA").query(api.incidentes.listarEventos, { incidenteId, paginationOpts: e.paginar });
    expect(eventos.page[0]).toMatchObject({ tipo: "EVIDENCIA_AGREGADA", evidenciaId, actorUserId: e.guardaA, createdAt: doc!.createdAt });
  });

  test("lectura autorizada por ID devuelve bytes; ninguna URL o clave habilita descargas", async () => {
    const { evidenciaId } = await subir();
    const acceso = await e.como("supervisorA").action(api.incidenteArchivos.acceder, { evidenciaId });
    expect(new Uint8Array(acceso.bytes)).toEqual(new Uint8Array([255, 216, 255, 224]));
    expect(acceso).toMatchObject({ nombre: "foto.jpg", mimeType: "image/jpeg" });
    expect(acceso).not.toHaveProperty("url"); expect(acceso).not.toHaveProperty("storageKey");
    expect(aws.send.mock.calls.at(-1)![0].input).toMatchObject({ Bucket: "evidencias-privadas" });
  });

  test("retiro durante la descarga niega devolver bytes; objeto con tamaño incoherente se rechaza", async () => {
    const { evidenciaId } = await subir();
    aws.send.mockImplementation(async (command) => {
      if (command.constructor.name === "GetObjectCommand") {
        await e.como("adminA").mutation(api.incidenteEvidencias.retirar, { evidenciaId, motivo: "Retiro durante lectura" });
        return { ContentLength: 4, Body: { transformToByteArray: async () => new Uint8Array([255, 216, 255, 224]) } };
      }
      return { PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true } };
    });
    await expect(e.como("adminA").action(api.incidenteArchivos.acceder, { evidenciaId })).rejects.toThrow("retirada");
    const otra = await subir();
    aws.send.mockImplementation(async (command) => command.constructor.name === "GetObjectCommand"
      ? { ContentLength: 100, Body: { transformToByteArray: async () => new Uint8Array(100) } }
      : { PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true } });
    await expect(e.como("adminA").action(api.incidenteArchivos.acceder, { evidenciaId: otra.evidenciaId })).rejects.toThrow("no coincide");
  });

  test.each(["adminB", "supervisorB", "guardaB", "sinEmpresa"])("%s no puede subir, leer, listar ni retirar evidencia de A en el conjunto compartido", async (actor) => {
    const { incidenteId, evidenciaId } = await subir(); aws.send.mockClear();
    await expect(e.como(actor).action(api.incidenteArchivos.subir, { incidenteId, ...foto() })).rejects.toThrow();
    await expect(e.como(actor).action(api.incidenteArchivos.acceder, { evidenciaId })).rejects.toThrow();
    await expect(e.como(actor).query(api.incidenteEvidencias.listar, { incidenteId })).rejects.toThrow();
    await expect(e.como(actor).mutation(api.incidenteEvidencias.retirar, { evidenciaId, motivo: "Ajeno" })).rejects.toThrow();
    expect(aws.send).not.toHaveBeenCalled();
  });

  test("guarda no accede a evidencia de otro reportante de su compañía", async () => {
    const incidenteId = await e.como("adminA").mutation(api.incidentes.crear, e.datos());
    const evidenciaId = await e.como("adminA").action(api.incidenteArchivos.subir, { incidenteId, ...foto() });
    await expect(e.como("guardaA").action(api.incidenteArchivos.acceder, { evidenciaId })).rejects.toThrow("acceso");
    await expect(e.como("guardaA").action(api.incidenteArchivos.subir, { incidenteId, ...foto() })).rejects.toThrow("acceso");
  });

  test("sin sesión no accede ni administra evidencias o personas", async () => {
    const { incidenteId, evidenciaId } = await subir();
    const personaId = await e.como("adminA").mutation(api.incidentes.agregarPersona, { incidenteId, nombre: "Juan", tipoPersona: "TERCERO" });
    await expect(e.t.action(api.incidenteArchivos.subir, { incidenteId, ...foto() })).rejects.toThrow();
    await expect(e.t.action(api.incidenteArchivos.acceder, { evidenciaId })).rejects.toThrow();
    await expect(e.t.mutation(api.incidenteEvidencias.retirar, { evidenciaId, motivo: "X" })).rejects.toThrow();
    await expect(e.t.mutation(api.incidentes.editarPersona, { personaId, nombre: "X", tipoPersona: "TERCERO" })).rejects.toThrow();
    await expect(e.t.mutation(api.incidentes.retirarPersona, { personaId, motivo: "X" })).rejects.toThrow();
  });

  test("conocer la clave privada no permite al transporte legado tocar su bucket", async () => {
    const { evidenciaId } = await subir();
    const evidencia = await e.t.run((ctx) => ctx.db.get(evidenciaId));
    vi.stubEnv("AWS_ACCESS_KEY_ID", "legacy-fake"); vi.stubEnv("AWS_SECRET_ACCESS_KEY", "legacy-fake");
    aws.send.mockClear();
    await e.como("adminB").action(api.files.deleteObject, { key: evidencia!.storageKey });
    expect(aws.send.mock.calls[0]![0].input).toEqual({ Bucket: "archivos-publicos", Key: evidencia!.storageKey });
    expect(await e.t.run((ctx) => ctx.db.get(evidenciaId))).toEqual(evidencia);
  });

  test("terminar contrato conserva lectura histórica del administrador pero impide altas, edición y retiro", async () => {
    const { incidenteId, evidenciaId } = await subir();
    const personaId = await e.como("adminA").mutation(api.incidentes.agregarPersona, { incidenteId, nombre: "Juan", tipoPersona: "TERCERO" });
    await e.t.run((ctx) => ctx.db.patch(e.kA, { terminadoEn: Date.now() }));
    expect((await e.como("adminA").query(api.incidentes.obtener, { incidenteId })).permisos.agregarEvidencia).toBe(false);
    expect(await e.como("adminA").action(api.incidenteArchivos.acceder, { evidenciaId })).toHaveProperty("bytes");
    await expect(e.como("adminA").action(api.incidenteArchivos.subir, { incidenteId, ...foto() })).rejects.toThrow("contrato");
    await expect(e.como("adminA").mutation(api.incidentes.agregarPersona, { incidenteId, nombre: "X", tipoPersona: "TERCERO" })).rejects.toThrow("contrato");
    await expect(e.como("adminA").mutation(api.incidentes.editarPersona, { personaId, nombre: "X", tipoPersona: "TERCERO" })).rejects.toThrow("contrato");
    await expect(e.como("adminA").mutation(api.incidenteEvidencias.retirar, { evidenciaId, motivo: "X" })).rejects.toThrow("contrato");
  });

  test("conjunto fuera de asignación y relación vencida no autorizan lectura ni nuevas cargas", async () => {
    const { incidenteId, evidenciaId } = await subir();
    await e.t.run(async (ctx) => { await ctx.db.patch(incidenteId, { condominioId: e.ajeno }); await ctx.db.patch(evidenciaId, { condominioId: e.ajeno }); });
    await expect(e.como("supervisorA").action(api.incidenteArchivos.acceder, { evidenciaId })).rejects.toThrow("contrato");
    await expect(e.como("guardaA").action(api.incidenteArchivos.subir, { incidenteId, ...foto() })).rejects.toThrow("contrato");
  });

  test.each(["companiaId", "condominioId"] as const)("rechaza %s del hijo incoherente aun con padre autorizado", async (campo) => {
    const { evidenciaId } = await subir();
    await e.t.run((ctx) => ctx.db.patch(evidenciaId, campo === "companiaId" ? { companiaId: e.companiaB } : { condominioId: e.ajeno }));
    await expect(e.como("adminA").action(api.incidenteArchivos.acceder, { evidenciaId })).rejects.toThrow("contexto");
    await expect(e.como("adminA").mutation(api.incidenteEvidencias.retirar, { evidenciaId, motivo: "Error" })).rejects.toThrow("contexto");
  });

  test("retiro lógico conserva objeto, actor y motivo, agrega evento y niega nuevos accesos", async () => {
    const { incidenteId, evidenciaId } = await subir();
    const originales = await e.t.run((ctx) => ctx.db.query("incidenteEventos").collect());
    const antes = Date.now(); aws.send.mockClear();
    await e.como("supervisorA").mutation(api.incidenteEvidencias.retirar, { evidenciaId, motivo: " Archivo incorrecto " });
    const doc = await e.t.run((ctx) => ctx.db.get(evidenciaId));
    expect(doc).toMatchObject({ retiradoPorUserId: e.supervisorA, retiradoPorNombre: "Sofia Andina", motivoRetiro: "Archivo incorrecto" });
    expect(doc!.retiradoEn).toBeGreaterThanOrEqual(antes); expect(doc!.retiradoEn).toBeLessThanOrEqual(Date.now());
    expect(doc!.storageKey).toBeTruthy(); expect(aws.send).not.toHaveBeenCalled();
    await expect(e.como("adminA").action(api.incidenteArchivos.acceder, { evidenciaId })).rejects.toThrow("retirada");
    await expect(e.como("adminA").mutation(api.incidenteEvidencias.retirar, { evidenciaId, motivo: "Otra" })).rejects.toThrow("retirada");
    const eventos = await e.como("adminA").query(api.incidentes.listarEventos, { incidenteId, paginationOpts: e.paginar });
    expect(eventos.page[0]).toMatchObject({ tipo: "EVIDENCIA_RETIRADA", evidenciaId, motivo: "Archivo incorrecto", actorUserId: e.supervisorA, createdAt: doc!.retiradoEn });
    for (const evento of originales) expect(await e.t.run((ctx) => ctx.db.get(evento._id))).toEqual(evento);
  });

  test("rechaza vacío, exceso, nombre/ruta, MIME, extensión y firma falsificada antes de tocar AWS", async () => {
    const incidenteId = await crear();
    for (const archivo of [
      { ...foto(), bytes: new ArrayBuffer(0) }, { ...foto(), bytes: new ArrayBuffer(MAX_EVIDENCIA_BYTES + 1) },
      { ...foto(), nombre: "../foto.jpg" }, { ...foto(), nombre: " " },
      { ...foto(), mimeType: "text/html" }, { ...foto(), nombre: "foto.pdf" }, { ...foto(), bytes: new Uint8Array([1, 2, 3]).buffer },
    ]) await expect(e.como("guardaA").action(api.incidenteArchivos.subir, { incidenteId, ...archivo })).rejects.toThrow();
    expect(aws.send).not.toHaveBeenCalled();
    expect(await e.t.run((ctx) => ctx.db.query("incidenteEvidencias").collect())).toHaveLength(0);
  });

  test("PDF soportado se entrega como bytes autorizados sin URL publica", async () => {
    const incidenteId = await crear();
    const evidenciaId = await e.como("guardaA").action(api.incidenteArchivos.subir, { incidenteId, nombre: "acta.pdf", mimeType: "application/pdf", bytes: new TextEncoder().encode("%PDF-1.7").buffer });
    aws.send.mockImplementation(async (command) => command.constructor.name === "GetObjectCommand" ? { ContentLength: 8, Body: { transformToByteArray: async () => new TextEncoder().encode("%PDF-1.7") } } : { PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true } });
    const acceso = await e.como("adminA").action(api.incidenteArchivos.acceder, { evidenciaId });
    expect(acceso.mimeType).toBe("application/pdf"); expect(acceso).not.toHaveProperty("url");
  });

  test("configuración ausente, bucket público/reutilizado o bloqueo parcial fallan sin registrar evidencia", async () => {
    const incidenteId = await crear();
    vi.stubEnv("AWS_INCIDENTES_BUCKET_NAME", "");
    await expect(e.como("adminA").action(api.incidenteArchivos.subir, { incidenteId, ...foto() })).rejects.toThrow("configurado");
    vi.stubEnv("AWS_INCIDENTES_BUCKET_NAME", "archivos-publicos");
    await expect(e.como("adminA").action(api.incidenteArchivos.subir, { incidenteId, ...foto() })).rejects.toThrow("distinto");
    vi.stubEnv("AWS_INCIDENTES_BUCKET_NAME", "evidencias-privadas"); aws.send.mockResolvedValue({ PublicAccessBlockConfiguration: { BlockPublicAcls: true } });
    await expect(e.como("adminA").action(api.incidenteArchivos.subir, { incidenteId, ...foto() })).rejects.toThrow("bloqueado");
    expect(await e.t.run((ctx) => ctx.db.query("incidenteEvidencias").collect())).toHaveLength(0);
  });

  test("fallo de S3 no crea evidencia ni evento, y deja preparación conciliable", async () => {
    const incidenteId = await crear(); aws.send.mockRejectedValue(new Error("S3 caído"));
    await expect(e.como("adminA").action(api.incidenteArchivos.subir, { incidenteId, ...foto() })).rejects.toThrow("S3 caído");
    expect(await e.t.run((ctx) => ctx.db.query("incidenteEvidencias").collect())).toHaveLength(0);
    expect(await e.t.run((ctx) => ctx.db.query("incidenteEvidenciaCargas").collect())).toHaveLength(1);
    expect((await e.como("adminA").query(api.incidentes.listarEventos, { incidenteId, paginationOpts: e.paginar })).page.map((x) => x.tipo)).toEqual(["CREACION"]);
  });

  test("revocación entre preparación y registro impide el alta; tampoco se finaliza una carga de otro actor", async () => {
    const incidenteId = await crear();
    const carga = await e.como("guardaA").mutation(internal.incidenteEvidencias.preparar, { incidenteId, objetoId: "00000000-0000-4000-8000-000000000001", nombre: "foto.jpg", mimeType: "image/jpeg", size: 4 });
    await expect(e.como("adminA").mutation(internal.incidenteEvidencias.registrar, { cargaId: carga.cargaId })).rejects.toThrow("actor");
    await e.t.run((ctx) => ctx.db.patch(e.mgA, { isActive: false }));
    await expect(e.como("guardaA").mutation(internal.incidenteEvidencias.registrar, { cargaId: carga.cargaId })).rejects.toThrow();
    expect(await e.t.run((ctx) => ctx.db.query("incidenteEvidencias").collect())).toHaveLength(0);
  });

  test("registrar la misma carga dos veces es idempotente y no duplica evento", async () => {
    const { evidenciaId } = await subir();
    const carga = (await e.t.run((ctx) => ctx.db.query("incidenteEvidenciaCargas").collect()))[0]!;
    expect(await e.como("guardaA").mutation(internal.incidenteEvidencias.registrar, { cargaId: carga._id })).toBe(evidenciaId);
    expect((await e.t.run((ctx) => ctx.db.query("incidenteEventos").collect())).filter((x) => x.tipo === "EVIDENCIA_AGREGADA")).toHaveLength(1);
  });

  test("personas: agregar, editar y retirar conservan cambios, actor y timestamps, sin tocar eventos anteriores", async () => {
    const incidenteId = await crear();
    const personaId = await e.como("guardaA").mutation(api.incidentes.agregarPersona, { incidenteId, nombre: "Juan", tipoPersona: "VISITANTE", documento: "123", observacion: "Testigo" });
    const originales = await e.t.run((ctx) => ctx.db.query("incidenteEventos").collect());
    await e.como("adminA").mutation(api.incidentes.editarPersona, { personaId, nombre: "Juan Pérez", tipoPersona: "RESIDENTE" });
    const editado = (await e.como("adminA").query(api.incidentes.listarEventos, { incidenteId, paginationOpts: e.paginar })).page[0]!;
    expect(editado).toMatchObject({ tipo: "PERSONA_EDITADA", personaId, actorUserId: e.adminA, actorNombre: "Ana Andina" });
    expect(editado.cambios).toEqual([
      { campo: "nombre", antes: "Juan", despues: "Juan Pérez" }, { campo: "tipoPersona", antes: "VISITANTE", despues: "RESIDENTE" },
      { campo: "documento", antes: "123" }, { campo: "observacion", antes: "Testigo" },
    ]);
    const antes = Date.now();
    await e.como("supervisorA").mutation(api.incidentes.retirarPersona, { personaId, motivo: "No participó" });
    const persona = (await e.como("adminA").query(api.incidentes.listarPersonas, { incidenteId }))[0]!;
    expect(persona).toMatchObject({ nombre: "Juan Pérez", tipoPersona: "RESIDENTE", retiradoPorUserId: e.supervisorA, retiradoPorNombre: "Sofia Andina", motivoRetiro: "No participó" });
    expect(persona.retiradoEn).toBeGreaterThanOrEqual(antes); expect(persona.retiradoEn).toBeLessThanOrEqual(Date.now());
    expect((await e.como("adminA").query(api.incidentes.listarEventos, { incidenteId, paginationOpts: e.paginar })).page[0]).toMatchObject({ tipo: "PERSONA_RETIRADA", personaId, motivo: "No participó", actorUserId: e.supervisorA, createdAt: persona.retiradoEn });
    for (const evento of originales) expect(await e.t.run((ctx) => ctx.db.get(evento._id))).toEqual(evento);
    await expect(e.como("adminA").mutation(api.incidentes.editarPersona, { personaId, nombre: "Otra", tipoPersona: "TERCERO" })).rejects.toThrow("retirada");
    await expect(e.como("adminA").mutation(api.incidentes.retirarPersona, { personaId, motivo: "Otra" })).rejects.toThrow("retirada");
  });

  test.each(["adminB", "supervisorB", "guardaA"])("%s no edita ni retira por ID de persona", async (actor) => {
    const incidenteId = await crear();
    const personaId = await e.como("adminA").mutation(api.incidentes.agregarPersona, { incidenteId, nombre: "Tercero", tipoPersona: "PROVEEDOR" });
    await expect(e.como(actor).mutation(api.incidentes.editarPersona, { personaId, nombre: "X", tipoPersona: "TERCERO" })).rejects.toThrow();
    await expect(e.como(actor).mutation(api.incidentes.retirarPersona, { personaId, motivo: "X" })).rejects.toThrow();
  });

  test("persona con contexto inconsistente, campos inválidos o motivo vacío no se modifica", async () => {
    const incidenteId = await crear();
    const personaId = await e.como("adminA").mutation(api.incidentes.agregarPersona, { incidenteId, nombre: "Juan", tipoPersona: "TERCERO" });
    await expect(e.como("adminA").mutation(api.incidentes.editarPersona, { personaId, nombre: " ", tipoPersona: "TERCERO" })).rejects.toThrow("Nombre");
    await expect(e.como("adminA").mutation(api.incidentes.retirarPersona, { personaId, motivo: " " })).rejects.toThrow("Motivo");
    await e.t.run((ctx) => ctx.db.patch(personaId, { companiaId: e.companiaB }));
    await expect(e.como("adminA").mutation(api.incidentes.editarPersona, { personaId, nombre: "X", tipoPersona: "TERCERO" })).rejects.toThrow("contexto");
  });

  test("cierre impide cambios de personas y evidencias pero conserva consulta", async () => {
    const { incidenteId, evidenciaId } = await subir();
    const personaId = await e.como("adminA").mutation(api.incidentes.agregarPersona, { incidenteId, nombre: "Juan", tipoPersona: "TERCERO" });
    await e.t.run((ctx) => ctx.db.patch(incidenteId, { estado: "CERRADO" }));
    await expect(e.como("adminA").action(api.incidenteArchivos.subir, { incidenteId, ...foto() })).rejects.toThrow("cerrado");
    await expect(e.como("adminA").mutation(api.incidenteEvidencias.retirar, { evidenciaId, motivo: "X" })).rejects.toThrow("cerrado");
    await expect(e.como("adminA").mutation(api.incidentes.editarPersona, { personaId, nombre: "X", tipoPersona: "TERCERO" })).rejects.toThrow("cerrado");
    await expect(e.como("adminA").mutation(api.incidentes.retirarPersona, { personaId, motivo: "X" })).rejects.toThrow("cerrado");
    const caso = await e.como("adminA").query(api.incidentes.obtener, { incidenteId });
    expect(Object.values(caso.permisos).every((v) => !v)).toBe(true);
    expect(await e.como("adminA").action(api.incidenteArchivos.acceder, { evidenciaId })).toHaveProperty("bytes");
  });

  test("baja de responsable y persona no borra contexto; relaciones antiguas no autorizan y nueva asignación exige vigencia", async () => {
    const incidenteId = await crear();
    await e.como("adminA").mutation(api.incidentes.asignarResponsable, { incidenteId, responsableUserId: e.supervisorA });
    const personaId = await e.como("adminA").mutation(api.incidentes.agregarPersona, { incidenteId, nombre: "Sofia Andina", tipoPersona: "EMPLEADO", documento: "123" });
    await e.t.run(async (ctx) => {
      await ctx.db.patch(e.supervisorA, { active: false, name: "Nombre posterior" });
      const miembro = await ctx.db.query("companiaMiembros").withIndex("by_user", (q) => q.eq("userId", e.supervisorA)).first();
      await ctx.db.patch(miembro!._id, { isActive: false });
    });
    expect(await e.como("adminA").query(api.incidentes.obtener, { incidenteId })).toMatchObject({ responsableUserId: e.supervisorA, responsableNombre: "Sofia Andina" });
    expect(await e.t.run((ctx) => ctx.db.get(personaId))).toMatchObject({ nombre: "Sofia Andina", documento: "123" });
    expect((await e.como("adminA").query(api.incidentes.listar, { companiaId: e.companiaA, paginationOpts: e.paginar })).page[0]!.responsableNombre).toBe("Sofia Andina");
    await expect(e.como("supervisorA").query(api.incidentes.obtener, { incidenteId })).rejects.toThrow();
    await expect(e.como("adminA").mutation(api.incidentes.asignarResponsable, { incidenteId, responsableUserId: e.supervisorA })).rejects.toThrow("activo");
    expect((await e.como("adminA").query(api.incidentes.responsablesDisponibles, { incidenteId })).map((r) => r.userId)).not.toContain(e.supervisorA);
    await e.como("adminA").mutation(api.incidentes.asignarResponsable, { incidenteId, responsableUserId: e.adminA });
    expect((await e.como("adminA").query(api.incidentes.listarEventos, { incidenteId, paginationOpts: e.paginar })).page.find((x) => x.tipo === "ASIGNACION")!.cambios![0]!.antes).toBe("Sofia Andina");
  });
});
