import { z } from 'zod';

/**
 * Contrato entre o app (cliente) e a camada privada do Kai (servidor).
 * O cliente monta um contexto MÍNIMO e consentido; o servidor valida tudo de novo,
 * chama o provedor com saída estruturada e valida a resposta antes de devolvê-la.
 */

export const KAI_LIMITS = {
  habits: 40,
  goals: 30,
  checkins: 62,
  journalEntries: 7,
  journalExcerpt: 600,
  message: 2000,
  historyMessages: 12,
  historyContent: 4000,
} as const;

/** Limiar mínimo de dados para análises. Abaixo dele, o Kai não é chamado. */
export const KAI_THRESHOLDS = {
  weeklyReview: { minClosedOccurrences: 7, minDaysWithSchedule: 5 },
  nextStep: { minHabitsOrGoal: 1 },
  /** Uma observação sobre um hábito específico exige ao menos estas ocorrências encerradas. */
  perHabitObservation: { minClosedOccurrences: 4 },
} as const;

const dateStr = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'Data inválida');
const timeStr = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Horário inválido');
export const habitRefSchema = z.string().regex(/^h\d{1,3}$/);
export const goalRefSchema = z.string().regex(/^g\d{1,3}$/);
export const journalRefSchema = z.string().regex(/^j\d{1,3}$/);
/** Referências que uma resposta pode citar como evidência. */
export const evidenceRefSchema = z.string().regex(/^((h|g|j)\d{1,3}|checkins|perfil)$/);

const periodSchema = z.object({ start: dateStr, end: dateStr }).refine((p) => p.start <= p.end, 'Período inválido');

export const kaiContextSchema = z.object({
  locale: z.literal('pt-BR'),
  timezone: z.string().min(1).max(64),
  today: dateStr,
  period: periodSchema.optional(),
  periodStats: z
    .object({
      daysElapsed: z.number().int().min(0).max(400),
      daysWithSchedule: z.number().int().min(0).max(400),
      closedOccurrences: z.number().int().min(0).max(100000),
    })
    .optional(),
  profile: z.object({
    mainGoal: z.string().max(200).optional(),
    periods: z.array(z.enum(['manha', 'tarde', 'noite'])).max(3).optional(),
    minutesPerDay: z.number().int().min(0).max(1440).optional(),
  }),
  habits: z
    .array(
      z.object({
        ref: habitRefSchema,
        title: z.string().max(80),
        category: z.string().max(40),
        schedule: z.string().max(80),
        timing: z.string().max(40),
        status: z.enum(['active', 'paused']),
        firstStep: z.string().max(200).optional(),
      }),
    )
    .max(KAI_LIMITS.habits),
  aggregates: z
    .array(
      z.object({
        ref: habitRefSchema,
        scheduled: z.number().int().min(0).max(100000),
        done: z.number().int().min(0).max(100000),
        skipped: z.number().int().min(0).max(100000),
        missed: z.number().int().min(0).max(100000),
        open: z.number().int().min(0).max(100000),
        rate: z.number().min(0).max(1).nullable(),
        currentStreak: z.number().int().min(0).max(100000),
        bestStreak: z.number().int().min(0).max(100000),
      }),
    )
    .max(KAI_LIMITS.habits),
  goals: z
    .array(
      z.object({
        ref: goalRefSchema,
        title: z.string().max(120),
        horizon: z.enum(['year', 'month', 'week', 'day']),
        periodStart: dateStr,
        periodEnd: dateStr,
        status: z.enum(['active', 'completed']),
        progress: z.object({
          current: z.number().min(0).max(1e9),
          target: z.number().min(0).max(1e9).nullable(),
          unit: z.string().max(30),
          manual: z.boolean(),
        }),
      }),
    )
    .max(KAI_LIMITS.goals),
  checkins: z
    .array(
      z.object({
        date: dateStr,
        mood: z.number().int().min(1).max(5).optional(),
        energy: z.number().int().min(1).max(5).optional(),
      }),
    )
    .max(KAI_LIMITS.checkins)
    .optional(),
  journal: z
    .array(z.object({ ref: journalRefSchema, date: dateStr, excerpt: z.string().max(KAI_LIMITS.journalExcerpt) }))
    .max(KAI_LIMITS.journalEntries)
    .optional(),
});
export type KaiContext = z.infer<typeof kaiContextSchema>;

// ── Pedidos ─────────────────────────────────────────────────────────────────

export const kaiTasks = ['chat', 'plan', 'next-step', 'weekly-review', 'goal-breakdown'] as const;
export type KaiTask = (typeof kaiTasks)[number];

export const kaiChatRequestSchema = z.object({
  context: kaiContextSchema,
  message: z.string().trim().min(1, 'Escreva uma mensagem').max(KAI_LIMITS.message),
  history: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(KAI_LIMITS.historyContent) }))
    .max(KAI_LIMITS.historyMessages),
});

export const kaiPlanRequestSchema = z.object({
  context: kaiContextSchema,
  objective: z.string().trim().min(1, 'Informe seu objetivo principal').max(200),
  maxHabits: z.number().int().min(1).max(6),
});

export const kaiNextStepRequestSchema = z.object({ context: kaiContextSchema });

export const kaiWeeklyReviewRequestSchema = z.object({
  context: kaiContextSchema.extend({ period: periodSchema, periodStats: kaiContextSchema.shape.periodStats.unwrap() }),
});

export const kaiGoalBreakdownRequestSchema = z.object({
  context: kaiContextSchema,
  goal: z.object({
    title: z.string().trim().min(1).max(120),
    description: z.string().max(1000).optional(),
    horizon: z.enum(['year', 'month', 'week', 'day']),
    periodStart: dateStr,
    periodEnd: dateStr,
  }),
  childHorizon: z.enum(['month', 'week', 'day']).nullable(),
  maxSteps: z.number().int().min(1).max(8),
});

export type KaiChatRequest = z.infer<typeof kaiChatRequestSchema>;
export type KaiPlanRequest = z.infer<typeof kaiPlanRequestSchema>;
export type KaiNextStepRequest = z.infer<typeof kaiNextStepRequestSchema>;
export type KaiWeeklyReviewRequest = z.infer<typeof kaiWeeklyReviewRequestSchema>;
export type KaiGoalBreakdownRequest = z.infer<typeof kaiGoalBreakdownRequestSchema>;

// ── Respostas estruturadas do provedor ──────────────────────────────────────
// Os limites de tamanho abaixo são verificados no servidor; o provedor recebe
// um JSON Schema sem limites numéricos (não suportados) e instruções de tamanho no prompt.

export const confidenceSchema = z.enum(['baixa', 'media', 'alta']);
export type Confidence = z.infer<typeof confidenceSchema>;

export const kaiSuggestionSchema = z.object({
  title: z.string().min(1).max(200).describe('Sugestão curta e prática, no imperativo'),
  detail: z.string().max(900).describe('Como aplicar, em até 3 frases'),
  refs: z.array(evidenceRefSchema).max(8).describe('Referências (h1, g2, j1, checkins) que motivam a sugestão; vazio se for geral'),
});

export const kaiChatOutputSchema = z.object({
  reply: z.string().min(1).max(4000).describe('Resposta em português do Brasil, clara e calma, em até 6 frases'),
  suggestions: z.array(kaiSuggestionSchema).max(4).describe('Até 3 sugestões opcionais; vazio quando não couber'),
  supportNotice: z
    .boolean()
    .describe('true quando a mensagem envolve crise, saúde mental, sintomas, medicamentos ou finanças e apoio profissional deve ser indicado'),
});
export type KaiChatOutput = z.infer<typeof kaiChatOutputSchema>;

export const kaiPlanHabitSchema = z.object({
  title: z.string().min(1).max(120).describe('Nome curto do hábito (até 60 caracteres)'),
  description: z.string().max(500).describe('Intenção do hábito em 1 frase'),
  category: z.string().min(1).max(60).describe('Uma categoria: Saúde, Estudos, Trabalho, Mente, Casa, Finanças pessoais, Relações, Lazer ou Outro'),
  scheduleKind: z.enum(['daily', 'weekly']),
  days: z.array(z.number().int().min(1).max(7)).max(7).describe('Dias ISO (1=seg … 7=dom) quando scheduleKind=weekly; vazio para daily'),
  time: timeStr.nullable().describe('Horário sugerido HH:mm dentro da disponibilidade, ou null'),
  durationMinutes: z.number().int().min(1).max(600).nullable(),
  firstStep: z.string().max(300).describe('Primeiro passo muito pequeno (até 2 minutos)'),
  xp: z.number().int().min(1).max(100).describe('XP por conclusão, entre 5 e 30'),
  rationale: z.string().max(500).describe('Por que este hábito ajuda o objetivo, em 1 frase'),
});

export const kaiPlanOutputSchema = z.object({
  habits: z.array(kaiPlanHabitSchema).min(1).max(8),
  notes: z.array(z.string().max(500)).max(5).describe('Observações curtas sobre o plano e suas limitações'),
});
export type KaiPlanOutput = z.infer<typeof kaiPlanOutputSchema>;

export const kaiNextStepOutputSchema = z.object({
  step: z.object({
    title: z.string().min(1).max(200),
    detail: z.string().max(900),
    durationMinutes: z.number().int().min(1).max(600).nullable(),
    refs: z.array(evidenceRefSchema).max(8),
  }),
  rationale: z.string().max(900).describe('Por que este passo, citando os dados quando houver'),
  confidence: confidenceSchema,
  limitations: z.array(z.string().max(500)).max(5),
});
export type KaiNextStepOutput = z.infer<typeof kaiNextStepOutputSchema>;

export const kaiObservationSchema = z.object({
  text: z.string().min(1).max(800).describe('Observação factual sobre o período; sem afirmar causalidade'),
  evidenceRefs: z.array(evidenceRefSchema).min(1).max(8).describe('Registros do contexto que sustentam a observação'),
  confidence: confidenceSchema,
});

export const kaiWeeklyReviewOutputSchema = z.object({
  period: periodSchema,
  observations: z.array(kaiObservationSchema).max(8),
  limitations: z.array(z.string().max(500)).max(8).describe('O que os dados não permitem concluir'),
  suggestions: z
    .array(
      kaiSuggestionSchema.extend({
        kind: z.enum(['ajustar_habito', 'novo_habito', 'tarefa', 'bloco_de_tempo', 'reflexao', 'outro']),
      }),
    )
    .max(5),
  overallConfidence: confidenceSchema,
});
export type KaiWeeklyReviewOutput = z.infer<typeof kaiWeeklyReviewOutputSchema>;

export const kaiGoalStepSchema = z.object({
  title: z.string().min(1).max(160),
  kind: z.enum(['meta_filha', 'tarefa', 'habito']),
  detail: z.string().max(600),
  horizon: z.enum(['month', 'week', 'day']).nullable().describe('Para meta_filha: horizonte da meta filha'),
  scheduleKind: z.enum(['daily', 'weekly']).nullable().describe('Para habito: frequência'),
  days: z.array(z.number().int().min(1).max(7)).max(7).describe('Para habito semanal: dias ISO'),
});

export const kaiGoalBreakdownOutputSchema = z.object({
  steps: z.array(kaiGoalStepSchema).min(1).max(10),
  notes: z.array(z.string().max(500)).max(5),
});
export type KaiGoalBreakdownOutput = z.infer<typeof kaiGoalBreakdownOutputSchema>;

export const kaiOutputSchemas = {
  chat: kaiChatOutputSchema,
  plan: kaiPlanOutputSchema,
  'next-step': kaiNextStepOutputSchema,
  'weekly-review': kaiWeeklyReviewOutputSchema,
  'goal-breakdown': kaiGoalBreakdownOutputSchema,
} as const;

export type KaiOutputFor<T extends KaiTask> = z.infer<(typeof kaiOutputSchemas)[T]>;

// ── Envelope da API ─────────────────────────────────────────────────────────

export const kaiErrorCodes = [
  'kai_disabled',
  'unauthorized',
  'forbidden_origin',
  'invalid_request',
  'insufficient_data',
  'rate_limited',
  'daily_limit',
  'provider_error',
  'provider_timeout',
  'invalid_output',
  'refused',
] as const;
export type KaiErrorCode = (typeof kaiErrorCodes)[number];

export interface KaiMeta {
  task: KaiTask;
  model: string;
  provider: 'anthropic';
  usage?: { inputTokens: number; outputTokens: number };
}

export type KaiApiResponse<T> =
  | { ok: true; data: T; meta: KaiMeta }
  | { ok: false; error: { code: KaiErrorCode; message: string; details?: string[] } };

export interface HealthResponse {
  ok: true;
  service: 'rotinas-private-layer';
  version: string;
  accessTokenRequired: boolean;
  kai: { enabled: boolean; reason?: string; provider?: 'anthropic'; models?: { fast: string; deep: string } };
  calendar: { enabled: boolean; reason?: string };
}

/** Avaliação compartilhada (cliente e servidor) do mínimo de dados para a revisão semanal. */
export function assessWeeklyReview(context: KaiContext): { sufficient: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const stats = context.periodStats;
  const t = KAI_THRESHOLDS.weeklyReview;
  if (!context.period || !stats) {
    reasons.push('Período da revisão não informado.');
    return { sufficient: false, reasons };
  }
  if (context.habits.length === 0) reasons.push('Ainda não há hábitos cadastrados.');
  if (stats.closedOccurrences < t.minClosedOccurrences) {
    reasons.push(`São necessárias ao menos ${t.minClosedOccurrences} ocorrências encerradas no período (há ${stats.closedOccurrences}).`);
  }
  if (stats.daysWithSchedule < t.minDaysWithSchedule) {
    reasons.push(`São necessários ao menos ${t.minDaysWithSchedule} dias com hábitos previstos no período (há ${stats.daysWithSchedule}).`);
  }
  return { sufficient: reasons.length === 0, reasons };
}

export function assessNextStep(context: KaiContext): { sufficient: boolean; reasons: string[] } {
  const hasHabits = context.habits.some((h) => h.status === 'active');
  const hasGoals = context.goals.some((g) => g.status === 'active');
  const hasObjective = Boolean(context.profile.mainGoal);
  if (hasHabits || hasGoals || hasObjective) return { sufficient: true, reasons: [] };
  return { sufficient: false, reasons: ['Cadastre um hábito, uma meta ou um objetivo principal para o Kai sugerir um próximo passo.'] };
}
