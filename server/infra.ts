import { timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import type { ServerConfig } from './config';

// ── Logs técnicos (sem conteúdo do usuário) ──────────────────────────────────

export interface TechLog {
  route: string;
  status: number;
  ms: number;
  code?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export type Logger = (entry: TechLog) => void;

/** Registra apenas metadados técnicos: rota, status, duração, modelo e contagem de tokens. Nunca o conteúdo. */
export const consoleLogger: Logger = (entry) => {
  console.info(JSON.stringify({ t: new Date().toISOString(), ...entry }));
};

// ── Limite de taxa ───────────────────────────────────────────────────────────

/**
 * Limite por chave (janela deslizante de 1 minuto) + teto diário global (dia UTC).
 * Em memória: adequado para a camada privada de uma pessoa rodando num único processo.
 */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  private day = '';
  private dayCount = 0;

  constructor(
    private perMinute: number,
    private perDay: number,
    private now: () => number = Date.now,
  ) {}

  check(key: string): { ok: true } | { ok: false; reason: 'rate_limited' | 'daily_limit'; retryAfterSec: number } {
    const t = this.now();
    const today = new Date(t).toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.dayCount = 0;
    }
    if (this.dayCount >= this.perDay) {
      const tomorrow = Date.parse(`${today}T00:00:00.000Z`) + 86_400_000;
      return { ok: false, reason: 'daily_limit', retryAfterSec: Math.ceil((tomorrow - t) / 1000) };
    }
    const recent = (this.hits.get(key) ?? []).filter((h) => t - h < 60_000);
    if (recent.length >= this.perMinute) {
      this.hits.set(key, recent);
      return { ok: false, reason: 'rate_limited', retryAfterSec: Math.ceil((60_000 - (t - recent[0])) / 1000) };
    }
    recent.push(t);
    this.hits.set(key, recent);
    this.dayCount += 1;
    return { ok: true };
  }
}

// ── Segurança das rotas /api ─────────────────────────────────────────────────

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function jsonError(c: Context, status: 400 | 401 | 403 | 404 | 409 | 410 | 415 | 422 | 429 | 500 | 502 | 503 | 504, code: string, message: string, extra: Record<string, unknown> = {}) {
  return c.json({ ok: false, error: { code, message, ...extra } }, status);
}

/**
 * - Recusa métodos que alteram estado vindos de outras origens (proteção CSRF para o servidor local).
 * - Exige JSON em POST (impede formulários simples de outros sites).
 * - Se ROTINAS_SERVER_TOKEN estiver definido, exige o cabeçalho x-rotinas-token.
 */
export function apiGuard(config: ServerConfig, options: { publicPaths: string[] }): MiddlewareHandler {
  return async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (options.publicPaths.includes(path)) return next();
    const method = c.req.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      const origin = c.req.header('origin');
      if (origin && !config.allowedOrigins.includes(origin)) {
        return jsonError(c, 403, 'forbidden_origin', 'Origem não autorizada para a camada privada.');
      }
      const type = c.req.header('content-type') ?? '';
      if (!type.toLowerCase().startsWith('application/json')) {
        return jsonError(c, 415, 'invalid_request', 'Envie JSON (content-type: application/json).');
      }
    }
    if (config.accessToken) {
      const provided = c.req.header('x-rotinas-token') ?? '';
      if (!safeEqual(provided, config.accessToken)) {
        return jsonError(c, 401, 'unauthorized', 'Senha da camada privada ausente ou incorreta.');
      }
    }
    c.header('cache-control', 'no-store');
    c.header('x-content-type-options', 'nosniff');
    return next();
  };
}

/** Cabeçalhos de segurança para o app estático servido pelo mesmo processo. */
export const STATIC_SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
  'x-content-type-options': 'nosniff',
  // Redundante com frame-ancestors, mas cobre navegadores antigos.
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'cross-origin-opener-policy': 'same-origin',
};
