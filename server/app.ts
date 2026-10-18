import { Hono } from 'hono';
import type { HealthResponse } from '../shared/kai';
import { calendarRoutes } from './calendar/routes';
import type { FetchLike } from './calendar/google';
import { EncryptedFileTokenStore, type TokenStore } from './calendar/token-store';
import type { ServerConfig } from './config';
import { apiGuard, consoleLogger, jsonError, type Logger, RateLimiter } from './infra';
import { AnthropicProvider, type KaiProvider } from './kai/provider';
import { kaiRoutes } from './kai/routes';

export interface AppDeps {
  config: ServerConfig;
  provider?: KaiProvider;
  tokenStore?: TokenStore;
  fetch?: FetchLike;
  logger?: Logger;
  limiter?: RateLimiter;
  now?: () => number;
}

/** Monta a camada privada (somente rotas /api). O app estático é servido por server/node.ts. */
export function createApp(deps: AppDeps): Hono {
  const { config } = deps;
  const logger = deps.logger ?? consoleLogger;
  const provider = deps.provider ?? (config.kai.enabled && config.kai.apiKey ? new AnthropicProvider(config.kai.apiKey, config.kai.timeoutMs) : undefined);
  const tokenStore =
    deps.tokenStore ?? (config.calendar.enabled && config.calendar.encryptionKey ? new EncryptedFileTokenStore(config.calendar.tokenFile, config.calendar.encryptionKey) : undefined);

  const app = new Hono();
  app.use('/api/*', apiGuard(config, { publicPaths: ['/api/calendar/callback'] }));

  app.get('/api/health', (c) => {
    const body: HealthResponse = {
      ok: true,
      service: 'rotinas-private-layer',
      version: config.version,
      accessTokenRequired: Boolean(config.accessToken),
      kai: config.kai.enabled
        ? { enabled: true, provider: 'anthropic', models: { fast: config.kai.modelFast, deep: config.kai.modelDeep } }
        : { enabled: false, reason: config.kai.reason },
      calendar: config.calendar.enabled ? { enabled: true } : { enabled: false, reason: config.calendar.reason },
    };
    return c.json(body);
  });

  app.route('/api/kai', kaiRoutes({ config, provider, logger, limiter: deps.limiter }));
  app.route('/api/calendar', calendarRoutes({ config, store: tokenStore, fetch: deps.fetch ?? ((input, init) => fetch(input, init)), logger, now: deps.now }));
  app.all('/api/*', (c) => jsonError(c, 404, 'invalid_request', 'Rota inexistente na camada privada.'));
  app.onError((_error, c) => jsonError(c, 500, 'server_error', 'Erro interno na camada privada.'));
  return app;
}
