import type { Context, MiddlewareHandler } from 'hono';
import { SECURITY_HEADERS } from '../shared/security-headers';
import type { ServerConfig } from './config';
import { safeEqual } from './crypto';

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
 * Limite por chave (janela deslizante de 1 minuto) + teto diário (dia UTC) em memória.
 * Na nuvem cada instância tem a sua memória; o teto diário persistente fica no armazenamento
 * (server/kai/usage.ts) e o teto de gasto definitivo é o limite configurado no Console da Anthropic.
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

export function jsonError(c: Context, status: 400 | 401 | 403 | 404 | 409 | 410 | 415 | 422 | 429 | 500 | 502 | 503 | 504, code: string, message: string, extra: Record<string, unknown> = {}) {
  return c.json({ ok: false, error: { code, message, ...extra } }, status);
}

/** Endereço do cliente para limites (primeiro IP do proxy, quando houver). */
export function clientAddress(c: Context): string {
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim() || 'desconhecido';
  return c.req.header('x-real-ip') ?? 'local';
}

/** O pedido vem de uma página da mesma origem? Compara o host do cabeçalho Origin com o host público. */
function sameHost(origin: string, c: Context): boolean {
  try {
    const host = c.req.header('x-forwarded-host') ?? c.req.header('host');
    return Boolean(host) && new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Tentativas de senha erradas por endereço: depois de 10 em 10 minutos, bloqueia por 10 minutos. */
export class AuthThrottle {
  private failures = new Map<string, number[]>();
  constructor(private now: () => number = Date.now) {}
  blocked(key: string): boolean {
    const t = this.now();
    const recent = (this.failures.get(key) ?? []).filter((x) => t - x < 600_000);
    this.failures.set(key, recent);
    return recent.length >= 10;
  }
  fail(key: string): void {
    const list = this.failures.get(key) ?? [];
    list.push(this.now());
    this.failures.set(key, list.slice(-20));
  }
}

/**
 * - Servidor bloqueado (nuvem sem senha): recusa tudo com o motivo, exceto rotas públicas.
 * - Recusa métodos que alteram estado vindos de outras origens (proteção CSRF).
 * - Exige JSON em POST (impede formulários simples de outros sites).
 * - Com ROTINAS_SERVER_TOKEN definido, exige o cabeçalho x-rotinas-token (comparação em tempo constante).
 */
export function apiGuard(config: ServerConfig, options: { publicPaths: string[]; throttle?: AuthThrottle }): MiddlewareHandler {
  const throttle = options.throttle ?? new AuthThrottle();
  return async (c, next) => {
    const path = new URL(c.req.url).pathname;
    c.header('cache-control', 'no-store');
    c.header('x-content-type-options', 'nosniff');
    if (options.publicPaths.includes(path)) return next();
    if (config.lockReason) return jsonError(c, 503, 'server_locked', config.lockReason);
    const method = c.req.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      const origin = c.req.header('origin');
      if (origin && !config.allowedOrigins.includes(origin) && !sameHost(origin, c)) {
        return jsonError(c, 403, 'forbidden_origin', 'Origem não autorizada para a camada privada.');
      }
      const type = c.req.header('content-type') ?? '';
      if (!type.toLowerCase().startsWith('application/json')) {
        return jsonError(c, 415, 'invalid_request', 'Envie JSON (content-type: application/json).');
      }
    }
    if (config.accessToken) {
      const who = clientAddress(c);
      if (throttle.blocked(who)) return jsonError(c, 429, 'rate_limited', 'Muitas tentativas de senha. Espere 10 minutos.');
      const provided = c.req.header('x-rotinas-token') ?? '';
      if (!safeEqual(provided, config.accessToken)) {
        throttle.fail(who);
        return jsonError(c, 401, 'unauthorized', 'Senha da camada privada ausente ou incorreta.');
      }
    }
    return next();
  };
}

/** Cabeçalhos de segurança para o app estático servido pelo mesmo processo. */
export const STATIC_SECURITY_HEADERS: Record<string, string> = SECURITY_HEADERS;
