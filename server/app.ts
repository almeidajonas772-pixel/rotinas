import { Hono } from 'hono';
import type { HealthResponse } from '../shared/kai';
import { calendarRoutes } from './calendar/routes';
import type { FetchLike } from './calendar/google';
import { EncryptedKvTokenStore, type TokenStore } from './calendar/token-store';
import type { ServerConfig } from './config';
import { apiGuard, AuthThrottle, consoleLogger, jsonError, type Logger, RateLimiter } from './infra';
import { AnthropicProvider, type KaiProvider } from './kai/provider';
import { kaiRoutes } from './kai/routes';
import { KvDailyCounter, type DailyCounter } from './kai/usage';
import { BlobKv, FileKv, type KvStore } from './storage';

export interface AppDeps {
  config: ServerConfig;
  provider?: KaiProvider;
  tokenStore?: TokenStore;
  kv?: KvStore;
  counter?: DailyCounter;
  fetch?: FetchLike;
  logger?: Logger;
  limiter?: RateLimiter;
  throttle?: AuthThrottle;
  now?: () => number;
}

/** Armazenamento conforme o ambiente: Blob privado (Vercel), arquivo (local) ou nenhum. */
export function createKv(config: ServerConfig): KvStore | undefined {
  if (config.storage.kind === 'blob') return new BlobKv();
  if (config.storage.kind === 'file') return new FileKv(config.storage.fileDir);
  return undefined;
}

/** Monta a camada privada (somente rotas /api). O app estático é servido por server/node.ts ou pela CDN da Vercel. */
export function createApp(deps: AppDeps): Hono {
  const { config } = deps;
  const logger = deps.logger ?? consoleLogger;
  const kv = deps.kv ?? createKv(config);
  const provider = deps.provider ?? (config.kai.enabled && config.kai.apiKey ? new AnthropicProvider(config.kai.apiKey, config.kai.timeoutMs) : undefined);
  const tokenStore =
    deps.tokenStore ??
    (config.calendar.enabled && config.secrets.encryptionKey && kv ? new EncryptedKvTokenStore(kv, config.secrets.encryptionKey, config.storage.tokenName) : undefined);
  const counter = deps.counter ?? (config.runtime === 'vercel' && kv ? new KvDailyCounter(kv) : undefined);

  const app = new Hono();
  app.use('/api/*', apiGuard(config, { publicPaths: ['/api/calendar/callback'], throttle: deps.throttle }));

  app.get('/api/health', (c) => {
    const body: HealthResponse = {
      ok: true,
      service: 'rotinas-private-layer',
      version: config.version,
      runtime: config.runtime,
      accessTokenRequired: Boolean(config.accessToken) || config.requireAccessToken,
      storage: { ok: config.storage.kind !== 'none', kind: config.storage.kind, reason: config.storage.reason },
      kai: config.kai.enabled
        ? { enabled: true, provider: 'anthropic', models: { fast: config.kai.modelFast, deep: config.kai.modelDeep } }
        : { enabled: false, reason: config.kai.reason },
      calendar: config.calendar.enabled
        ? { enabled: true, redirectUri: config.calendar.redirectUri }
        : { enabled: false, reason: config.calendar.reason, redirectUri: config.calendar.redirectUri },
    };
    return c.json(body);
  });

  app.route('/api/kai', kaiRoutes({ config, provider, logger, limiter: deps.limiter, counter }));
  app.route('/api/calendar', calendarRoutes({ config, store: tokenStore, fetch: deps.fetch ?? ((input, init) => fetch(input, init)), logger, now: deps.now }));
  app.all('/api/*', (c) => jsonError(c, 404, 'invalid_request', 'Rota inexistente na camada privada.'));
  app.onError((_error, c) => jsonError(c, 500, 'server_error', 'Erro interno na camada privada.'));
  return app;
}
