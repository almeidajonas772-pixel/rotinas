import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Armazenamento chave-valor da camada privada.
 * - Local (`npm start`/`npm run dev`): arquivos em `.data/` com permissão 600.
 * - Vercel: Blob **privado** conectado ao projeto (autenticação por OIDC, sem segredo no código).
 * O conteúdo sensível (tokens do Google) chega aqui já cifrado; este módulo não interpreta nada.
 */

export interface KvStore {
  readonly kind: 'file' | 'blob' | 'memory';
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

const KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,80}$/;

function checkKey(key: string): string {
  if (!KEY_PATTERN.test(key)) throw new Error('Chave de armazenamento inválida');
  return key;
}

export class FileKv implements KvStore {
  readonly kind = 'file' as const;
  constructor(private dir: string) {}

  async get(key: string): Promise<string | null> {
    try {
      return await readFile(join(this.dir, checkKey(key)), 'utf8');
    } catch {
      return null;
    }
  }

  async set(key: string, value: string): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, checkKey(key)), value, { encoding: 'utf8', mode: 0o600 });
  }

  async delete(key: string): Promise<void> {
    await rm(join(this.dir, checkKey(key)), { force: true });
  }
}

/** Vercel Blob privado. Leituras ignoram o cache da CDN para sempre ver a última gravação. */
export class BlobKv implements KvStore {
  readonly kind = 'blob' as const;
  constructor(private prefix = 'rotinas/') {}

  async get(key: string): Promise<string | null> {
    const { get } = await import('@vercel/blob');
    const result = await get(`${this.prefix}${checkKey(key)}`, { access: 'private', useCache: false });
    if (!result || result.statusCode !== 200) return null;
    return new Response(result.stream).text();
  }

  async set(key: string, value: string): Promise<void> {
    const { put } = await import('@vercel/blob');
    await put(`${this.prefix}${checkKey(key)}`, value, {
      access: 'private',
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: 'application/octet-stream',
      cacheControlMaxAge: 60,
    });
  }

  async delete(key: string): Promise<void> {
    const { del } = await import('@vercel/blob');
    await del(`${this.prefix}${checkKey(key)}`);
  }
}

export class MemoryKv implements KvStore {
  readonly kind = 'memory' as const;
  private data = new Map<string, string>();
  async get(key: string) {
    return this.data.get(checkKey(key)) ?? null;
  }
  async set(key: string, value: string) {
    this.data.set(checkKey(key), value);
  }
  async delete(key: string) {
    this.data.delete(checkKey(key));
  }
}
