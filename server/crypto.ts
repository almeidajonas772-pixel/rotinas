import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Utilitários criptográficos da camada privada (somente servidor).
 * - chave mestra: TOKEN_ENCRYPTION_KEY (32 bytes) ou derivada da senha do servidor com scrypt;
 * - subchaves por finalidade (HMAC-SHA256), para cifrar tokens e assinar pedidos sem guardar estado;
 * - tokens assinados (HMAC) com tipo e validade, usados no `state` do OAuth e nas prévias do calendário,
 *   o que funciona em funções serverless (sem memória compartilhada entre execuções).
 */

const passwordKeys = new Map<string, Buffer>();

export function deriveKeyFromPassword(password: string): Buffer {
  const cached = passwordKeys.get(password);
  if (cached) return cached;
  const key = scryptSync(password, 'rotinas/master-key/v1', 32, { N: 1 << 14, r: 8, p: 1 });
  passwordKeys.set(password, key);
  return key;
}

export function subKey(master: Buffer, purpose: string): Buffer {
  return createHmac('sha256', master).update(`rotinas/${purpose}/v1`).digest();
}

export function randomNonce(bytes = 16): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface SignedPayload {
  typ: string;
  /** Validade (epoch ms). */
  exp: number;
  [key: string]: unknown;
}

export function signPayload(payload: SignedPayload, key: Buffer): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = createHmac('sha256', key).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/** Devolve o conteúdo só se a assinatura confere, o tipo é o esperado e não expirou. */
export function verifyPayload<T extends SignedPayload>(token: string, key: Buffer, typ: string, now: number): T | null {
  if (typeof token !== 'string' || token.length > 4096) return null;
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return null;
  const expected = createHmac('sha256', key).update(body).digest();
  let given: Buffer;
  try {
    given = Buffer.from(sig, 'base64url');
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
    if (!payload || payload.typ !== typ || typeof payload.exp !== 'number' || payload.exp < now) return null;
    return payload;
  } catch {
    return null;
  }
}

const BASE32HEX = '0123456789abcdefghijklmnopqrstuv';

/**
 * Id de evento do Google Calendar derivado de uma semente (base32hex: a–v e 0–9, 5 a 1024 caracteres).
 * Repetir a mesma confirmação gera o mesmo id, então o Google recusa a duplicata em vez de criar outra.
 */
export function googleEventId(seed: string): string {
  const digest = createHash('sha256').update(seed).digest();
  let value = 0;
  let bits = 0;
  let out = '';
  for (const byte of digest) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32HEX[(value >> bits) & 31];
    }
    value &= (1 << bits) - 1;
  }
  return `rot${out.slice(0, 32)}`;
}
