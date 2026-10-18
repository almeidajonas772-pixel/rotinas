import type { Context } from 'hono';
import { Hono } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { z } from 'zod';
import {
  assessNextStep,
  assessWeeklyReview,
  KAI_THRESHOLDS,
  kaiChatRequestSchema,
  kaiGoalBreakdownRequestSchema,
  kaiNextStepRequestSchema,
  kaiOutputSchemas,
  kaiPlanRequestSchema,
  kaiWeeklyReviewRequestSchema,
  type KaiContext,
  type KaiErrorCode,
  type KaiOutputFor,
  type KaiTask,
} from '../../shared/kai';
import type { ServerConfig } from '../config';
import { jsonError, type Logger, RateLimiter } from '../infra';
import { fitToSchema } from './json-schema';
import { buildUserPrompt, KAI_SYSTEM_PROMPT } from './prompts';
import { ProviderError, type KaiProvider } from './provider';

const TASK_SETTINGS: Record<KaiTask, { tier: 'fast' | 'deep'; maxTokens: number }> = {
  chat: { tier: 'fast', maxTokens: 1200 },
  plan: { tier: 'deep', maxTokens: 2000 },
  'next-step': { tier: 'fast', maxTokens: 900 },
  'weekly-review': { tier: 'deep', maxTokens: 2500 },
  'goal-breakdown': { tier: 'deep', maxTokens: 1500 },
};

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
};

function validRefs(context: KaiContext): Set<string> {
  const refs = new Set<string>(['perfil']);
  context.habits.forEach((h) => refs.add(h.ref));
  context.goals.forEach((g) => refs.add(g.ref));
  context.journal?.forEach((j) => refs.add(j.ref));
  if (context.checkins) refs.add('checkins');
  return refs;
}

/** Ajustes pós-validação: remove referências inexistentes e aplica limites do pedido. */
export function postprocess<T extends KaiTask>(task: T, output: KaiOutputFor<T>, context: KaiContext, extra: Record<string, unknown>): KaiOutputFor<T> {
  const valid = validRefs(context);
  const keep = (refs: string[]) => [...new Set(refs.filter((r) => valid.has(r)))];
  switch (task) {
    case 'chat': {
      const o = output as KaiOutputFor<'chat'>;
      return { ...o, suggestions: o.suggestions.slice(0, 3).map((s) => ({ ...s, refs: keep(s.refs) })) } as KaiOutputFor<T>;
    }
    case 'next-step': {
      const o = output as KaiOutputFor<'next-step'>;
      return { ...o, step: { ...o.step, refs: keep(o.step.refs) } } as KaiOutputFor<T>;
    }
    case 'plan': {
      const o = output as KaiOutputFor<'plan'>;
      const max = Number(extra.maxHabits) || 6;
      return {
        ...o,
        habits: o.habits.slice(0, max).map((h) => {
          const days = [...new Set(h.days.filter((d) => d >= 1 && d <= 7))].sort((a, b) => a - b);
          return h.scheduleKind === 'weekly' && days.length === 0 ? { ...h, scheduleKind: 'daily' as const, days: [] } : { ...h, days: h.scheduleKind === 'daily' ? [] : days };
        }),
      } as KaiOutputFor<T>;
    }
    case 'weekly-review': {
      const o = output as KaiOutputFor<'weekly-review'>;
      const enough = (ref: string) => {
        if (!ref.startsWith('h')) return true;
        const a = context.aggregates.find((x) => x.ref === ref);
        return Boolean(a && a.done + a.missed >= KAI_THRESHOLDS.perHabitObservation.minClosedOccurrences);
      };
      const observations = o.observations
        .map((ob) => ({ ...ob, evidenceRefs: keep(ob.evidenceRefs).filter(enough) }))
        .filter((ob) => ob.evidenceRefs.length > 0)
        .slice(0, 5);
      return {
        ...o,
        period: context.period!,
        observations,
        suggestions: o.suggestions.slice(0, 4).map((s) => ({ ...s, refs: keep(s.refs) })),
      } as KaiOutputFor<T>;
    }
    case 'goal-breakdown': {
      const o = output as KaiOutputFor<'goal-breakdown'>;
      return { ...o, steps: o.steps.slice(0, Number(extra.maxSteps) || 8) } as KaiOutputFor<T>;
    }
  }
  return output;
}

export interface KaiDeps {
  config: ServerConfig;
  provider?: KaiProvider;
  logger: Logger;
  limiter?: RateLimiter;
}

export function kaiRoutes(deps: KaiDeps): Hono {
  const app = new Hono();
  const limiter = deps.limiter ?? new RateLimiter(deps.config.kai.perMinute, deps.config.kai.perDay);

  function fail(c: Context, code: KaiErrorCode, message: string, details?: string[]) {
    return c.json({ ok: false, error: { code, message, ...(details ? { details } : {}) } }, STATUS[code]);
  }

  function clientKey(c: Context): string {
    try {
      return getConnInfo(c).remote.address ?? 'local';
    } catch {
      return 'local';
    }
  }

  async function handle<T extends KaiTask>(
    c: Context,
    task: T,
    schema: z.ZodType<{ context: KaiContext } & Record<string, unknown>>,
    gate?: (body: { context: KaiContext } & Record<string, unknown>) => { sufficient: boolean; reasons: string[] },
  ) {
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
    const allowed = limiter.check(clientKey(c));
    if (!allowed.ok) {
      log(429, allowed.reason);
      c.header('retry-after', String(allowed.retryAfterSec));
      return fail(
        c,
        allowed.reason,
        allowed.reason === 'daily_limit' ? 'Limite diário de pedidos ao Kai atingido (proteção de custo). Volta amanhã.' : 'Muitos pedidos em sequência. Espere um minuto e tente de novo.',
      );
    }
    const settings = TASK_SETTINGS[task];
    const model = settings.tier === 'fast' ? deps.config.kai.modelFast : deps.config.kai.modelDeep;
    const extra: Record<string, unknown> = { ...body, ...(task === 'weekly-review' ? { start: body.context.period?.start, end: body.context.period?.end } : {}) };
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

  app.post('/chat', (c) => handle(c, 'chat', kaiChatRequestSchema));
  app.post('/plan', (c) => handle(c, 'plan', kaiPlanRequestSchema));
  app.post('/next-step', (c) => handle(c, 'next-step', kaiNextStepRequestSchema, (b) => assessNextStep(b.context)));
  app.post('/weekly-review', (c) => handle(c, 'weekly-review', kaiWeeklyReviewRequestSchema, (b) => assessWeeklyReview(b.context)));
  app.post('/goal-breakdown', (c) => handle(c, 'goal-breakdown', kaiGoalBreakdownRequestSchema));
  app.all('*', (c) => jsonError(c, 404, 'invalid_request', 'Rota do Kai inexistente.'));
  return app;
}
