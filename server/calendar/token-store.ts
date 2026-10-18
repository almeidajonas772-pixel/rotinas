import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Tokens OAuth do Google — existem só no servidor, criptografados em repouso (AES-256-GCM). */
export interface StoredTokens {
  refreshToken: string;
  accessToken?: string;
  /** Epoch ms de expiração do access token. */
  expiresAt?: number;
  scopes: string[];
  authorizedAt: string;
  /** Agenda secundária "Rotinas" criada pelo app (escopo calendar.app.created). */
  calendarId?: string;
}

export interface TokenStore {
  load(): Promise<StoredTokens | null>;
  save(tokens: StoredTokens): Promise<void>;
  clear(): Promise<void>;
}

export function encrypt(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), data.toString('base64')].join('.');
}

export function decrypt(payload: string, key: Buffer): string {
  const [version, iv, tag, data] = payload.trim().split('.');
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('Formato de token inválido');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

export class EncryptedFileTokenStore implements TokenStore {
  constructor(
    private file: string,
    private key: Buffer,
  ) {}

  async load(): Promise<StoredTokens | null> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch {
      return null;
    }
    try {
      return JSON.parse(decrypt(raw, this.key)) as StoredTokens;
    } catch {
      // Chave trocada ou arquivo corrompido: trata como desconectado (sem expor detalhes).
      return null;
    }
  }

  async save(tokens: StoredTokens): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, encrypt(JSON.stringify(tokens), this.key), { encoding: 'utf8', mode: 0o600 });
  }

  async clear(): Promise<void> {
    await rm(this.file, { force: true });
  }
}

export class MemoryTokenStore implements TokenStore {
  private value: StoredTokens | null = null;
  async load() {
    return this.value ? { ...this.value } : null;
  }
  async save(tokens: StoredTokens) {
    this.value = { ...tokens };
  }
  async clear() {
    this.value = null;
  }
}
