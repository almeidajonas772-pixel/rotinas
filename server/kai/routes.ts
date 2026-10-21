import type { Context } from 'hono';
import { Hono } from 'hono';
import type { z } from 'zod';
import { kaiOutputSchemas, type KaiErrorCode, type KaiOutputFor, type KaiTask } from '../../shared/kai';
import { KAI_GATES, KAI_REQUEST_SCHEMAS, KAI_TASK_SETTINGS, kaiExtra, postprocess } from '../../shared/kai-core';
import type { ServerConfig } from '../config';
import { clientAddress, jsonError, type Logger, RateLimiter } from '../infra';
import { fitToSchema } from './json-schema';
import { buildUserPrompt, KAI_SYSTEM_PROMPT } from './prompts';
import { ProviderError, type KaiProvider } from './provider';
import type { DailyCounter } from './usage';

// Regras compartilhadas com o app (quando ele roda dentro do Claude): ver shared/kai-core.ts.
export { blockFits, postprocess } from '../../shared/kai-core';

const STATUS: Record<KaiErrorCode, 400 | 401 | 403 | 422 | 429 | 502 | 503 | 504> = {
  kai_disabled: 503,
  unauthorized: 401,
  forbidden_origin: 403,
  invalid_request: 400,
  insufficient_data: 422,
  rate_limited: 429,
  daily_limit: 429,
  provider_error: 502,
  provider_timeout: 504,
  invalid_output: 502,
  refused: 422,
  server_locked: 503,
};

export interface KaiDeps {
  config: ServerConfig;
  provider?: KaiProvider;
  logger: Logger;
  limiter?: RateLimiter;
  /** Teto diário persistente (nuvem). */
  counter?: DailyCounter;
}

export function kaiRoutes(deps: KaiDeps): Hono {
  const app = new Hono();
  const limiter = deps.limiter ?? new RateLimiter(deps.config.kai.perMinute, deps.config.kai.perDay);

  function fail(c: Context, code: KaiErrorCode, message: string, details?: string[]) {
    return c.json({ ok: false, error: { code, message, ...(details ? { details } : {}) } }, STATUS[code]);
  }


  async function handle<T extends KaiTask>(c: Context, task: T) {
    const schema = KAI_REQUEST_SCHEMAS[task];
    const gate = KAI_GATES[task];
    const started = Date.now();
    const log = (status: number, code?: string, extra: Partial<Parameters<Logger>[0]> = {}) =>
      deps.logger({ route: `kai/${task}`, status, ms: Date.now() - started, code, ...extra });

    if (!deps.config.kai.enabled || !deps.provider) {
      log(503, 'kai_disabled');
      return fail(c, 'kai_disabled', deps.config.kai.reason ?? 'O Kai não está configurado neste servidor.');
    }
    const raw = await c.req.json().catch(() => null);
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      log(400, 'invalid_request');
      return fail(c, 'invalid_request', 'Pedido inválido para o Kai.', parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`));
    }
    const body = parsed.data;
    if (gate) {
      const g = gate(body);
      if (!g.sufficient) {
        log(422, 'insufficient_data');
        return fail(c, 'insufficient_data', 'Ainda não há registros suficientes para esta análise.', g.reasons);
      }
    }
    let allowed: ReturnType<RateLimiter['check']> = limiter.check(clientAddress(c));
    if (allowed.ok && deps.counter && !(await deps.counter.take(new Date().toISOString().slice(0, 10), deps.config.kai.perDay))) {
      const tomorrow = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`) + 86_400_000;
      allowed = { ok: false, reason: 'daily_limit', retryAfterSec: Math.ceil((tomorrow - Date.now()) / 1000) };
    }
    if (!allowed.ok) {
      log(429, allowed.reason);
      c.header('retry-after', String(allowed.retryAfterSec));
      return fail(
        c,
        allowed.reason,
        allowed.reason === 'daily_limit' ? 'Limite diário de pedidos ao Kai atingido (proteção de custo). Volta amanhã.' : 'Muitos pedidos em sequência. Espere um minuto e tente de novo.',
      );
    }
    const settings = KAI_TASK_SETTINGS[task];
    const model = settings.tier === 'fast' ? deps.config.kai.modelFast : deps.config.kai.modelDeep;
    const extra = kaiExtra(task, body);
    try {
      const result = await deps.provider.generate({
        model,
        system: KAI_SYSTEM_PROMPT,
        user: buildUserPrompt(task, body.context, extra),
        schema: kaiOutputSchemas[task],
        maxTokens: Math.min(settings.maxTokens, deps.config.kai.maxOutputTokens),
      });
      // O período da revisão é sempre o pedido pelo app, nunca o informado pelo modelo.
      const raw =
        task === 'weekly-review' && result.json && typeof result.json === 'object'
          ? { ...(result.json as Record<string, unknown>), period: body.context.period }
          : result.json;
      const fitted = fitToSchema(raw, kaiOutputSchemas[task]);
      const validated = (kaiOutputSchemas[task] as unknown as z.ZodType<KaiOutputFor<T>>).safeParse(fitted);
      if (!validated.success) {
        log(502, 'invalid_output', { model: result.model, inputTokens: result.usage?.inputTokens, outputTokens: result.usage?.outputTokens });
        return fail(c, 'invalid_output', 'A resposta do provedor não passou na validação. Nada foi exibido; tente de novo.');
      }
      const data = postprocess(task, validated.data, body.context, extra);
      log(200, undefined, { model: result.model, inputTokens: result.usage?.inputTokens, outputTokens: result.usage?.outputTokens });
      return c.json({ ok: true, data, meta: { task, model: result.model, provider: 'anthropic', usage: result.usage } });
    } catch (error) {
      if (error instanceof ProviderError) {
        log(STATUS[error.code], error.code);
        return fail(c, error.code, error.message);
      }
      log(502, 'provider_error');
      return fail(c, 'provider_error', 'Falha inesperada ao consultar o provedor de IA.');
    }
  }

  app.post('/chat', (c) => handle(c, 'chat'));
  app.post('/plan', (c) => handle(c, 'plan'));
  app.post('/next-step', (c) => handle(c, 'next-step'));
  app.post('/weekly-review', (c) => handle(c, 'weekly-review'));
  app.post('/goal-breakdown', (c) => handle(c, 'goal-breakdown'));
  app.post('/nightly', (c) => handle(c, 'nightly'));
  app.all('*', (c) => jsonError(c, 404, 'invalid_request', 'Rota do Kai inexistente.'));
  return app;
}
