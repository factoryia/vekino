import { afterEach, beforeEach, describe, expect, test } from "bun:test";

/**
 * `uploadToS3` (lib/upload-s3.ts) después de la Fase 4 de S3.
 *
 * El PUT firmado de la web ya no publica el archivo: llega a una llave
 * temporal, y solo `files.confirmarSubida` —que lee el objeto en el
 * servidor— lo deja en su llave con el tipo verificado. La web tiene que
 * confirmar después de cada PUT y usar lo que devuelve la confirmación; si la
 * confirmación falla, la subida falla (no se usa una URL sin validar).
 *
 * Lo simulado: las acciones de Convex (funciones de prueba) y el
 * `XMLHttpRequest` del navegador. No sale nada a la red.
 */

const MiB = 1024 * 1024;

/** Lo que el XHR del navegador recibió, y cómo responde. */
let puts;
let estadoDelPut;
class XHRFalso {
  upload = {};
  cabeceras = {};
  open(metodo, url) {
    this.metodo = metodo;
    this.url = url;
  }
  setRequestHeader(nombre, valor) {
    this.cabeceras[nombre] = valor;
  }
  send(cuerpo) {
    puts.push({ metodo: this.metodo, url: this.url, cabeceras: this.cabeceras, cuerpo });
    this.status = estadoDelPut;
    queueMicrotask(() => this.onload?.());
  }
}

beforeEach(() => {
  puts = [];
  estadoDelPut = 200;
  globalThis.XMLHttpRequest = XHRFalso;
});

afterEach(() => {
  delete globalThis.XMLHttpRequest;
});

const { uploadToS3 } = await import("../lib/upload-s3");

/** Un archivo grande (no pasa por `uploadBytes`), sin reservar sus bytes. */
const grande = (tipo = "video/webm") => ({ size: 20 * MiB, type: tipo, name: "parte-1.webm" });

function acciones({ confirmar } = {}) {
  const llamadas = { generar: [], confirmar: [], bytes: [] };
  return {
    llamadas,
    generateUploadUrl: async (args) => {
      llamadas.generar.push(args);
      return {
        uploadUrl: "https://vekino.s3.us-east-1.amazonaws.com/pendientes/abc?X-Amz-Signature=x",
        key: "asambleas/a1/grabacion/1-0a1b2c3d-parte-1.webm",
        publicUrl: "https://vekino.s3.us-east-1.amazonaws.com/asambleas/a1/grabacion/1-0a1b2c3d-parte-1.webm",
      };
    },
    confirmarSubida:
      confirmar ??
      (async (args) => {
        llamadas.confirmar.push(args);
        return { key: args.key, publicUrl: `https://vekino.s3.us-east-1.amazonaws.com/${args.key}` };
      }),
    uploadBytes: async (args) => {
      llamadas.bytes.push(args);
      return { key: `${args.folder}/1-0a1b2c3d-x`, publicUrl: `https://vekino.s3.us-east-1.amazonaws.com/${args.folder}/1-0a1b2c3d-x` };
    },
  };
}

describe("subida firmada: siempre se confirma antes de usar la URL", () => {
  test("pide con el tamaño, hace el PUT con su tipo y devuelve lo que confirma el servidor", async () => {
    const a = acciones();
    const r = await uploadToS3(a.generateUploadUrl, a.confirmarSubida, grande(), "asambleas/a1/grabacion");
    expect(a.llamadas.generar).toEqual([
      { folder: "asambleas/a1/grabacion", contentType: "video/webm", fileName: "parte-1.webm", size: 20 * MiB },
    ]);
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({ metodo: "PUT", cabeceras: { "Content-Type": "video/webm" } });
    expect(a.llamadas.confirmar).toEqual([{ key: "asambleas/a1/grabacion/1-0a1b2c3d-parte-1.webm" }]);
    expect(r).toEqual({
      key: "asambleas/a1/grabacion/1-0a1b2c3d-parte-1.webm",
      url: "https://vekino.s3.us-east-1.amazonaws.com/asambleas/a1/grabacion/1-0a1b2c3d-parte-1.webm",
    });
  });

  test("si el servidor rechaza el contenido, la subida falla con su mensaje y no devuelve URL", async () => {
    const a = acciones({
      confirmar: async () => {
        throw new Error("El contenido del archivo no corresponde a un tipo permitido.");
      },
    });
    await expect(uploadToS3(a.generateUploadUrl, a.confirmarSubida, grande(), "asambleas/a1/grabacion")).rejects.toThrow(
      "El contenido del archivo no corresponde a un tipo permitido.",
    );
  });

  test("si el PUT falla, no se confirma", async () => {
    estadoDelPut = 403;
    const a = acciones();
    await expect(uploadToS3(a.generateUploadUrl, a.confirmarSubida, grande(), "asambleas/a1/grabacion")).rejects.toThrow("(403)");
    expect(a.llamadas.confirmar).toEqual([]);
  });
});

describe("subida por el servidor (archivos pequeños): sin PUT ni confirmación", () => {
  test("uploadBytes ya valida los bytes en el servidor", async () => {
    const a = acciones();
    const pequeno = new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], { type: "application/pdf" });
    const r = await uploadToS3(a.generateUploadUrl, a.confirmarSubida, pequeno, "condominios/documentos/c1", a.uploadBytes);
    expect(a.llamadas.bytes).toHaveLength(1);
    expect(puts).toEqual([]);
    expect(a.llamadas.confirmar).toEqual([]);
    expect(r.key.startsWith("condominios/documentos/c1/")).toBe(true);
  });

  test("si uploadBytes falla, el respaldo por PUT también confirma", async () => {
    const a = acciones();
    const pequeno = new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], { type: "application/pdf" });
    const falla = async () => {
      throw new Error("servidor caído");
    };
    await uploadToS3(a.generateUploadUrl, a.confirmarSubida, pequeno, "condominios/documentos/c1", falla);
    expect(puts).toHaveLength(1);
    expect(a.llamadas.confirmar).toHaveLength(1);
  });
});
