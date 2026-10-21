import type { z } from 'zod';
import {
  assessNextStep,
  assessWeeklyReview,
  KAI_THRESHOLDS,
  kaiChatRequestSchema,
  kaiGoalBreakdownRequestSchema,
  kaiNextStepRequestSchema,
  kaiNightlyRequestSchema,
  kaiPlanRequestSchema,
  kaiWeeklyReviewRequestSchema,
  type KaiContext,
  type KaiOutputFor,
  type KaiTask,
  type NightlyContext,
} from './kai';

/**
 * Regras do Kai que valem em qualquer caminho até o modelo — pela camada privada (servidor,
 * chave da Anthropic) ou pelo Claude da própria pessoa (app publicado como artifact):
 * esquema de cada pedido, limiar mínimo de dados, nível de modelo por tarefa e os ajustes
 * feitos depois da validação (referências inexistentes descartadas, limites do pedido).
 */

/** Nível de modelo e tamanho máximo da resposta por tarefa. */
export const KAI_TASK_SETTINGS: Record<KaiTask, { tier: 'fast' | 'deep'; maxTokens: number }> = {
  chat: { tier: 'fast', maxTokens: 1200 },
  plan: { tier: 'deep', maxTokens: 2000 },
  'next-step': { tier: 'fast', maxTokens: 900 },
  'weekly-review': { tier: 'deep', maxTokens: 2500 },
  'goal-breakdown': { tier: 'deep', maxTokens: 1500 },
  // Sessão da noite: modelo rápido, porque a resposta é falada e precisa chegar logo.
  nightly: { tier: 'fast', maxTokens: 1000 },
};

export type KaiRequestBody = { context: KaiContext } & Record<string, unknown>;

/** Esquema de validação de cada pedido (o mesmo no servidor e no app dentro do Claude). */
export const KAI_REQUEST_SCHEMAS: Record<KaiTask, z.ZodType<KaiRequestBody>> = {
  chat: kaiChatRequestSchema as unknown as z.ZodType<KaiRequestBody>,
  plan: kaiPlanRequestSchema as unknown as z.ZodType<KaiRequestBody>,
  'next-step': kaiNextStepRequestSchema as unknown as z.ZodType<KaiRequestBody>,
  'weekly-review': kaiWeeklyReviewRequestSchema as unknown as z.ZodType<KaiRequestBody>,
  'goal-breakdown': kaiGoalBreakdownRequestSchema as unknown as z.ZodType<KaiRequestBody>,
  nightly: kaiNightlyRequestSchema as unknown as z.ZodType<KaiRequestBody>,
};

/** Limiar de dados mínimos: abaixo dele o modelo não é chamado. */
export const KAI_GATES: Partial<Record<KaiTask, (body: KaiRequestBody) => { sufficient: boolean; reasons: string[] }>> = {
  'next-step': (b) => assessNextStep(b.context),
  'weekly-review': (b) => assessWeeklyReview(b.context),
};

/** Dados extras que as instruções de cada tarefa usam (o período da revisão vem sempre do pedido). */
export function kaiExtra(task: KaiTask, body: KaiRequestBody): Record<string, unknown> {
  return { ...body, ...(task === 'weekly-review' ? { start: body.context.period?.start, end: body.context.period?.end } : {}) };
}

function validRefs(context: KaiContext, night?: NightlyContext): Set<string> {
  const refs = new Set<string>(['perfil']);
  context.habits.forEach((h) => refs.add(h.ref));
  context.goals.forEach((g) => refs.add(g.ref));
  context.journal?.forEach((j) => refs.add(j.ref));
  if (context.checkins) refs.add('checkins');
  night?.todayTasks?.forEach((t) => refs.add(t.ref));
  night?.tomorrowAgenda?.forEach((a) => refs.add(a.ref));
  night?.upcoming?.forEach((u) => refs.add(u.ref));
  return refs;
}

const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** Um bloco proposto para amanhã só mantém horário se couber numa janela livre e não sobrepuser a agenda. */
export function blockFits(night: NightlyContext, start: string, end: string): boolean {
  const s = toMin(start);
  const e = toMin(end);
  if (!(e > s)) return false;
  const windows = night.freeWindowsTomorrow;
  if (!windows || windows.length === 0) return false;
  if (!windows.some((w) => toMin(w.start) <= s && e <= toMin(w.end))) return false;
  return !(night.tomorrowAgenda ?? []).some((a) => !a.allDay && a.start && a.end && toMin(a.start) < e && s < toMin(a.end));
}

/** Ajustes pós-validação: remove referências inexistentes e aplica limites do pedido. */
export function postprocess<T extends KaiTask>(task: T, output: KaiOutputFor<T>, context: KaiContext, extra: Record<string, unknown>): KaiOutputFor<T> {
  const night = task === 'nightly' ? (extra.night as NightlyContext | undefined) : undefined;
  const valid = validRefs(context, night);
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
    case 'nightly': {
      const o = output as KaiOutputFor<'nightly'>;
      const enough = (ref: string) => {
        if (!ref.startsWith('h')) return true;
        const a = context.aggregates.find((x) => x.ref === ref);
        return Boolean(a && a.done + a.missed >= KAI_THRESHOLDS.perHabitObservation.minClosedOccurrences);
      };
      const observations = o.observations
        .map((ob) => ({ ...ob, refs: keep(ob.refs).filter(enough) }))
        .filter((ob) => ob.refs.length > 0)
        .slice(0, 3);
      const proposals = o.proposals.slice(0, 3).map((p) => {
        const habitRef = p.habitRef && valid.has(p.habitRef) ? p.habitRef : null;
        const goalRef = p.goalRef && valid.has(p.goalRef) ? p.goalRef : null;
        let { kind, start, end } = p;
        if (kind === 'bloco_amanha' && !(night && start && end && blockFits(night, start, end))) {
          // Sem janela válida: vira tarefa para amanhã, e o horário é escolhido pela pessoa ao aceitar.
          kind = 'tarefa_amanha';
          start = null;
          end = null;
        }
        if (kind !== 'bloco_amanha') {
          start = null;
          end = null;
        }
        return { ...p, kind, start, end, habitRef, goalRef, refs: keep(p.refs) };
      });
      return { ...o, observations, proposals } as KaiOutputFor<T>;
    }
  }
  return output;
}
