import { z } from 'zod';
import { isCivilDate, isLocalTime } from './civil';
import { isValidTimeZone } from './tz';

/**
 * Esquemas de validação das entidades locais. São a fonte única dos tipos do
 * app (z.infer) e validam toda escrita no IndexedDB e toda importação de backup.
 */

export const civilDateSchema = z.string().refine(isCivilDate, { message: 'Data inválida' });
export const localTimeSchema = z.string().refine(isLocalTime, { message: 'Horário inválido (use HH:mm)' });
export const isoInstantSchema = z.string().refine((s) => !Number.isNaN(Date.parse(s)), { message: 'Data/hora inválida' });
export const weekdaySchema = z.number().int().min(1).max(7);
export const timeZoneSchema = z.string().refine(isValidTimeZone, { message: 'Fuso horário inválido' });
export const idSchema = z.string().min(1).max(120);

/** Texto opcional. Strings vazias são normalizadas para `undefined` pela camada de repositório (`cleanText`). */
const optionalText = (max: number) => z.string().trim().max(max, { message: `Use no máximo ${max} caracteres` }).optional();

/** Normaliza texto opcional: remove espaços nas pontas e troca string vazia por `undefined`. */
export function cleanText(value: string | undefined | null): string | undefined {
  if (value === undefined || value === null) return undefined;
  const t = value.trim();
  return t.length > 0 ? t : undefined;
}

// ── Perfil e preferências ───────────────────────────────────────────────────

export const dayPeriodSchema = z.enum(['manha', 'tarde', 'noite']);
export type DayPeriod = z.infer<typeof dayPeriodSchema>;

export const availabilityWindowSchema = z
  .object({
    weekdays: z.array(weekdaySchema).min(1, { message: 'Escolha ao menos um dia' }),
    start: localTimeSchema,
    end: localTimeSchema,
  })
  .refine((w) => w.start < w.end, { message: 'O fim precisa ser depois do início', path: ['end'] });

export const availabilitySchema = z.object({
  periods: z.array(dayPeriodSchema).max(3),
  minutesPerDay: z.number().int().min(0).max(1440).optional(),
  windows: z.array(availabilityWindowSchema).max(21),
});
export type Availability = z.infer<typeof availabilitySchema>;

export const profileSchema = z.object({
  id: z.literal('me'),
  name: optionalText(60),
  timezone: timeZoneSchema,
  mainGoal: optionalText(200),
  availability: availabilitySchema,
  createdAt: isoInstantSchema,
  updatedAt: isoInstantSchema,
  onboardingCompletedAt: isoInstantSchema.optional(),
});
export type Profile = z.infer<typeof profileSchema>;

export const consentSchema = z.object({
  granted: z.boolean(),
  /** Momento da última decisão (concessão ou revogação). */
  updatedAt: isoInstantSchema.optional(),
  /** Versão do texto de explicação aceito. */
  version: z.number().int().min(1),
  /**
   * Só em memória (nunca gravado): a pessoa autorizou um texto anterior desta autorização.
   * Enquanto não revisar o texto novo, o recurso fica desligado.
   */
  outdated: z.boolean().optional(),
});
export type Consent = z.infer<typeof consentSchema>;

export const consentKeys = ['kai', 'kaiCheckins', 'kaiJournal', 'kaiAgenda', 'calendar', 'voice', 'notifications'] as const;
export type ConsentKey = (typeof consentKeys)[number];

export const preferencesSchema = z.object({
  id: z.literal('prefs'),
  language: z.literal('pt-BR'),
  theme: z.enum(['system', 'light', 'dark']),
  weekStartsOn: z.union([z.literal(0), z.literal(1)]),
  notifications: z.object({
    channel: z.enum(['none', 'local']),
    quietStart: localTimeSchema,
    quietEnd: localTimeSchema,
    allowedDays: z.array(weekdaySchema),
    maxPerDay: z.number().int().min(1).max(20),
  }),
  features: z.object({
    /** Check-in diário de humor/energia (opcional, só local). */
    checkins: z.boolean(),
  }),
  consents: z.object({
    kai: consentSchema,
    kaiCheckins: consentSchema,
    kaiJournal: consentSchema,
    /** Títulos e horários da agenda (inclusive do Google) na sessão da noite. */
    kaiAgenda: consentSchema,
    calendar: consentSchema,
    /** Reconhecimento de fala do navegador e vozes online. */
    voice: consentSchema,
    notifications: consentSchema,
  }),
  server: z.object({
    /** Senha da camada privada (ROTINAS_SERVER_TOKEN). Não é chave de provedor. */
    accessToken: optionalText(200),
  }),
  /** Sessão da noite: lembrete local e voz. */
  nightly: z.object({
    reminder: z.object({ enabled: z.boolean(), time: localTimeSchema }),
    /** Ler em voz alta o resumo e as respostas do Kai. */
    speak: z.boolean(),
    /** Voz escolhida (identificador do navegador). Ausente = automática, preferindo vozes locais em português. */
    voiceURI: optionalText(300),
    rate: z.number().min(0.7).max(1.4),
    /** Depois que o Kai fala, o microfone volta a ouvir sozinho (onde o navegador permite). */
    handsFree: z.boolean(),
  }),
  updatedAt: isoInstantSchema,
});
export type Preferences = z.infer<typeof preferencesSchema>;

// ── Hábitos ─────────────────────────────────────────────────────────────────

export const habitScheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('daily') }),
  z.object({
    kind: z.literal('weekly'),
    days: z
      .array(weekdaySchema)
      .min(1, { message: 'Escolha ao menos um dia da semana' })
      .max(7)
      .transform((days) => [...new Set(days)].sort((a, b) => a - b)),
  }),
]);
export type HabitSchedule = z.infer<typeof habitScheduleSchema>;

export const habitTimingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('anytime') }),
  z.object({ kind: z.literal('time'), time: localTimeSchema }),
  z.object({ kind: z.literal('window'), start: localTimeSchema, end: localTimeSchema }),
]);
export type HabitTiming = z.infer<typeof habitTimingSchema>;

export const habitStatusSchema = z.enum(['active', 'paused', 'archived']);
export type HabitStatus = z.infer<typeof habitStatusSchema>;

export const habitSchema = z
  .object({
    id: idSchema,
    title: z.string().trim().min(1, { message: 'Dê um nome ao hábito' }).max(80, { message: 'Use no máximo 80 caracteres' }),
    description: optionalText(500),
    category: z.string().trim().min(1, { message: 'Escolha uma categoria' }).max(40),
    status: habitStatusSchema,
    /** Versões da frequência; cada uma vale a partir de `from` (inclusive). A primeira define o início do hábito. */
    scheduleHistory: z.array(z.object({ from: civilDateSchema, schedule: habitScheduleSchema })).min(1),
    /** Intervalos sem ocorrências previstas (pausa/arquivamento). `to` inclusive; ausente = em aberto. */
    pauses: z.array(z.object({ from: civilDateSchema, to: civilDateSchema.optional() })),
    timing: habitTimingSchema,
    durationMinutes: z.number().int().min(1).max(600).optional(),
    reminder: z.object({ enabled: z.boolean(), time: localTimeSchema.optional() }),
    xp: z.number().int().min(0, { message: 'XP não pode ser negativo' }).max(100, { message: 'Use no máximo 100 XP' }),
    goalId: idSchema.optional(),
    firstStep: optionalText(200),
    order: z.number(),
    createdAt: isoInstantSchema,
    updatedAt: isoInstantSchema,
  })
  .superRefine((h, ctx) => {
    if (h.timing.kind === 'window' && h.timing.start >= h.timing.end) {
      ctx.addIssue({ code: 'custom', message: 'O fim da janela precisa ser depois do início', path: ['timing', 'end'] });
    }
    if (h.reminder.enabled && !h.reminder.time) {
      ctx.addIssue({ code: 'custom', message: 'Escolha o horário do lembrete', path: ['reminder', 'time'] });
    }
    for (let i = 1; i < h.scheduleHistory.length; i++) {
      if (h.scheduleHistory[i].from <= h.scheduleHistory[i - 1].from) {
        ctx.addIssue({ code: 'custom', message: 'Histórico de frequência fora de ordem', path: ['scheduleHistory', i] });
      }
    }
    for (const [i, p] of h.pauses.entries()) {
      if (p.to !== undefined && p.to < p.from) {
        ctx.addIssue({ code: 'custom', message: 'Pausa com fim antes do início', path: ['pauses', i] });
      }
    }
  });
export type Habit = z.infer<typeof habitSchema>;

export const completionStatusSchema = z.enum(['done', 'skipped']);
export type CompletionStatus = z.infer<typeof completionStatusSchema>;

export const habitCompletionSchema = z.object({
  /** Chave determinística `${habitId}|${scheduledDate}`: garante uma conclusão por ocorrência. */
  id: idSchema,
  habitId: idSchema,
  scheduledDate: civilDateSchema,
  status: completionStatusSchema,
  /** Horário real em que a pessoa registrou (instante UTC). */
  completedAt: isoInstantSchema,
  /** Fuso do perfil no momento do registro. */
  timezone: timeZoneSchema,
  note: optionalText(500),
  source: z.enum(['manual', 'calendar']),
  xpAwarded: z.number().int().min(0).max(100),
});
export type HabitCompletion = z.infer<typeof habitCompletionSchema>;

// ── Agenda ──────────────────────────────────────────────────────────────────

export const recurrenceSchema = z
  .object({
    freq: z.enum(['daily', 'weekly']),
    interval: z.number().int().min(1).max(52),
    byWeekday: z.array(weekdaySchema).min(1).max(7).optional(),
    until: civilDateSchema.optional(),
    count: z.number().int().min(1).max(1000).optional(),
  })
  .superRefine((r, ctx) => {
    if (r.freq === 'weekly' && (!r.byWeekday || r.byWeekday.length === 0)) {
      ctx.addIssue({ code: 'custom', message: 'Escolha os dias da semana da repetição', path: ['byWeekday'] });
    }
  });
export type Recurrence = z.infer<typeof recurrenceSchema>;

export const occurrenceOverrideSchema = z.object({
  cancelled: z.boolean().optional(),
  date: civilDateSchema.optional(),
  startTime: localTimeSchema.optional(),
  endTime: localTimeSchema.optional(),
  title: z.string().trim().min(1).max(120).optional(),
});
export type OccurrenceOverride = z.infer<typeof occurrenceOverrideSchema>;

export const agendaKindSchema = z.enum(['task', 'event', 'habit']);
export type AgendaKind = z.infer<typeof agendaKindSchema>;

export const agendaItemSchema = z
  .object({
    id: idSchema,
    kind: agendaKindSchema,
    title: z.string().trim().min(1, { message: 'Dê um título ao item' }).max(120, { message: 'Use no máximo 120 caracteres' }),
    notes: optionalText(1000),
    /** Data (no fuso do item). Obrigatória para eventos e blocos de hábito; opcional para tarefas. */
    date: civilDateSchema.optional(),
    allDay: z.boolean(),
    startTime: localTimeSchema.optional(),
    endTime: localTimeSchema.optional(),
    /** Fuso em que data/horários foram definidos. */
    timezone: timeZoneSchema,
    status: z.enum(['active', 'cancelled']),
    recurrence: recurrenceSchema.optional(),
    /** Alterações de uma única ocorrência ("somente esta"), indexadas pela data original. */
    exceptions: z.record(z.string(), occurrenceOverrideSchema),
    habitId: idSchema.optional(),
    goalId: idSchema.optional(),
    category: optionalText(40),
    /** Como o item nasceu: criado à mão, aceito de uma proposta de horários ou de uma sugestão do Kai. */
    origin: z.enum(['manual', 'proposal', 'kai']),
    /** Cópia confirmada no Google Calendar (somente referência; a agenda do app continua a fonte de verdade). */
    external: z
      .object({ provider: z.literal('google'), calendarId: z.string().min(1), eventId: z.string().min(1) })
      .optional(),
    xp: z.number().int().min(0).max(100),
    /** Derivado: 'undated' | 'single' | 'recurring' (índice de consulta). */
    seriesKind: z.enum(['undated', 'single', 'recurring']),
    createdAt: isoInstantSchema,
    updatedAt: isoInstantSchema,
  })
  .superRefine((item, ctx) => {
    if ((item.kind === 'event' || item.kind === 'habit') && !item.date) {
      ctx.addIssue({ code: 'custom', message: 'Escolha a data', path: ['date'] });
    }
    if (item.kind === 'habit' && !item.habitId) {
      ctx.addIssue({ code: 'custom', message: 'Escolha o hábito do bloco', path: ['habitId'] });
    }
    if (!item.allDay && item.date && !item.startTime) {
      ctx.addIssue({ code: 'custom', message: 'Escolha o horário de início ou marque “dia inteiro”', path: ['startTime'] });
    }
    if (item.startTime && item.endTime && item.endTime <= item.startTime) {
      ctx.addIssue({ code: 'custom', message: 'O fim precisa ser depois do início (no mesmo dia)', path: ['endTime'] });
    }
    if (item.recurrence && !item.date) {
      ctx.addIssue({ code: 'custom', message: 'Itens recorrentes precisam de data de início', path: ['date'] });
    }
    if (item.recurrence?.until && item.date && item.recurrence.until < item.date) {
      ctx.addIssue({ code: 'custom', message: 'A repetição precisa terminar depois do início', path: ['recurrence', 'until'] });
    }
    const expected = !item.date ? 'undated' : item.recurrence ? 'recurring' : 'single';
    if (item.seriesKind !== expected) {
      ctx.addIssue({ code: 'custom', message: 'seriesKind inconsistente', path: ['seriesKind'] });
    }
  });
export type AgendaItem = z.infer<typeof agendaItemSchema>;

export const agendaCompletionSchema = z.object({
  /** `${itemId}|${occurrenceDate}` */
  id: idSchema,
  itemId: idSchema,
  /** Data original da ocorrência na série (no fuso do item). */
  occurrenceDate: civilDateSchema,
  completedAt: isoInstantSchema,
  timezone: timeZoneSchema,
  xpAwarded: z.number().int().min(0).max(100),
});
export type AgendaCompletion = z.infer<typeof agendaCompletionSchema>;

// ── Check-in e Diário ───────────────────────────────────────────────────────

export const checkinSchema = z
  .object({
    date: civilDateSchema,
    mood: z.number().int().min(1).max(5).optional(),
    energy: z.number().int().min(1).max(5).optional(),
    note: optionalText(500),
    createdAt: isoInstantSchema,
    updatedAt: isoInstantSchema,
  })
  .refine((c) => c.mood !== undefined || c.energy !== undefined || c.note !== undefined, {
    message: 'Preencha ao menos um campo do check-in',
  });
export type Checkin = z.infer<typeof checkinSchema>;

export const journalEntrySchema = z
  .object({
    id: idSchema,
    date: civilDateSchema,
    text: z.string().max(20000, { message: 'Texto muito longo (máx. 20.000 caracteres)' }),
    didToday: optionalText(2000),
    whatWorked: optionalText(2000),
    toImprove: optionalText(2000),
    nextStep: optionalText(2000),
    links: z.object({
      habitIds: z.array(idSchema),
      goalIds: z.array(idSchema),
      agendaItemIds: z.array(idSchema),
    }),
    /** Preferência desta entrada para o Kai. Só tem efeito se o consentimento do Diário estiver ativo. */
    kaiAccess: z.enum(['allowed', 'blocked']),
    createdAt: isoInstantSchema,
    updatedAt: isoInstantSchema,
  })
  .refine(
    (e) =>
      e.text.trim().length > 0 ||
      [e.didToday, e.whatWorked, e.toImprove, e.nextStep].some((v) => v !== undefined && v.trim().length > 0),
    { message: 'Escreva algo antes de salvar' },
  );
export type JournalEntry = z.infer<typeof journalEntrySchema>;

// ── Metas ───────────────────────────────────────────────────────────────────

export const goalHorizonSchema = z.enum(['year', 'month', 'week', 'day']);
export type GoalHorizon = z.infer<typeof goalHorizonSchema>;

export const goalProgressRuleSchema = z.discriminatedUnion('kind', [
  /** Sem alvo numérico: cumprida quando a pessoa marca como concluída. */
  z.object({ kind: z.literal('manual_completion') }),
  /** Valor atualizado manualmente pela pessoa (ex.: 3 de 12 livros). */
  z.object({
    kind: z.literal('manual_value'),
    target: z.number().positive({ message: 'O alvo precisa ser maior que zero' }).max(1e9),
    unit: z.string().trim().min(1, { message: 'Informe a unidade' }).max(30),
  }),
  /** Conta conclusões reais de hábitos e tarefas vinculados dentro do período da meta. */
  z.object({
    kind: z.literal('linked_completions'),
    target: z.number().int().positive({ message: 'O alvo precisa ser maior que zero' }).max(100000),
    unit: z.string().trim().min(1, { message: 'Informe a unidade' }).max(30),
    includeDescendants: z.boolean(),
  }),
  /** Fração de metas filhas concluídas. */
  z.object({ kind: z.literal('child_goals') }),
]);
export type GoalProgressRule = z.infer<typeof goalProgressRuleSchema>;

export const goalSchema = z
  .object({
    id: idSchema,
    title: z.string().trim().min(1, { message: 'Dê um título à meta' }).max(120, { message: 'Use no máximo 120 caracteres' }),
    description: optionalText(1000),
    horizon: goalHorizonSchema,
    periodStart: civilDateSchema,
    periodEnd: civilDateSchema,
    progressRule: goalProgressRuleSchema,
    status: z.enum(['active', 'completed', 'archived']),
    completedAt: isoInstantSchema.optional(),
    completedOn: civilDateSchema.optional(),
    parentId: idSchema.optional(),
    createdAt: isoInstantSchema,
    updatedAt: isoInstantSchema,
  })
  .superRefine((g, ctx) => {
    if (g.periodEnd < g.periodStart) {
      ctx.addIssue({ code: 'custom', message: 'O fim do período precisa ser depois do início', path: ['periodEnd'] });
    }
    if (g.status === 'completed' && (!g.completedAt || !g.completedOn)) {
      ctx.addIssue({ code: 'custom', message: 'Meta concluída sem data de conclusão', path: ['completedAt'] });
    }
    if (g.parentId === g.id) {
      ctx.addIssue({ code: 'custom', message: 'Uma meta não pode ser filha dela mesma', path: ['parentId'] });
    }
  });
export type Goal = z.infer<typeof goalSchema>;

export const goalProgressEntrySchema = z.object({
  id: idSchema,
  goalId: idSchema,
  /** Novo valor atual informado manualmente. */
  value: z.number().min(0).max(1e9),
  note: optionalText(300),
  source: z.literal('manual'),
  createdAt: isoInstantSchema,
});
export type GoalProgressEntry = z.infer<typeof goalProgressEntrySchema>;

// ── Progresso (XP) ──────────────────────────────────────────────────────────

export const progressEventSchema = z.object({
  /** Chave de idempotência: `habit:<conclusão>`, `agenda:<conclusão>` ou `goal:<meta>`. */
  id: idSchema,
  type: z.enum(['habit_completed', 'agenda_completed', 'goal_completed']),
  refId: idSchema,
  xp: z.number().int().min(0).max(1000),
  occurredAt: isoInstantSchema,
  localDate: civilDateSchema,
});
export type ProgressEvent = z.infer<typeof progressEventSchema>;

// ── Kai ─────────────────────────────────────────────────────────────────────

export const kaiDataManifestSchema = z.object({
  categories: z.array(z.string()),
  counts: z.record(z.string(), z.number()),
  period: z.object({ start: civilDateSchema, end: civilDateSchema }).optional(),
});
export type KaiDataManifest = z.infer<typeof kaiDataManifestSchema>;

export const kaiInsightSchema = z.object({
  id: idSchema,
  kind: z.enum(['weekly_review', 'next_step', 'initial_plan', 'goal_breakdown']),
  periodStart: civilDateSchema.optional(),
  periodEnd: civilDateSchema.optional(),
  dataUsed: kaiDataManifestSchema,
  refMap: z.record(z.string(), z.string()),
  response: z.unknown().optional(),
  status: z.enum(['ok', 'insufficient_data', 'error']),
  decision: z.enum(['pending', 'accepted', 'edited', 'ignored']).optional(),
  errorCode: z.string().max(60).optional(),
  provider: z.string().max(40).optional(),
  model: z.string().max(80).optional(),
  origin: z.literal('kai'),
  createdAt: isoInstantSchema,
});
export type KaiInsight = z.infer<typeof kaiInsightSchema>;

export const kaiMessageSchema = z.object({
  id: idSchema,
  role: z.enum(['user', 'assistant']),
  content: z.string().max(8000),
  createdAt: isoInstantSchema,
  dataUsed: kaiDataManifestSchema.optional(),
  refMap: z.record(z.string(), z.string()).optional(),
  suggestions: z
    .array(
      z.object({
        title: z.string().max(200),
        detail: z.string().max(900),
        refs: z.array(z.string().max(20)),
        /** Evidências descritas pelo app a partir do contexto enviado (não pelo modelo). */
        evidence: z.array(z.object({ label: z.string().max(200), detail: z.string().max(400) })).optional(),
      }),
    )
    .optional(),
  supportNotice: z.boolean().optional(),
  model: z.string().max(80).optional(),
});
export type KaiMessage = z.infer<typeof kaiMessageSchema>;

export const kaiConversationSchema = z.object({
  id: idSchema,
  title: z.string().max(120),
  messages: z.array(kaiMessageSchema).max(200),
  createdAt: isoInstantSchema,
  updatedAt: isoInstantSchema,
});
export type KaiConversation = z.infer<typeof kaiConversationSchema>;

// ── Integrações e notificações ──────────────────────────────────────────────

export const integrationSchema = z.object({
  id: z.literal('google_calendar'),
  provider: z.literal('google'),
  status: z.enum(['disconnected', 'connected', 'error']),
  scopes: z.array(z.string()),
  authorizedAt: isoInstantSchema.optional(),
  lastCheckedAt: isoInstantSchema.optional(),
  metadata: z.object({ canWrite: z.boolean(), calendarName: z.string().max(80).optional() }).optional(),
  updatedAt: isoInstantSchema,
});
export type Integration = z.infer<typeof integrationSchema>;

export const notificationLogSchema = z.object({
  /** `${kind}|${refId}|${date}` — evita lembrete duplicado. */
  id: idSchema,
  kind: z.enum(['habit_reminder', 'night_reminder']),
  refId: idSchema,
  date: civilDateSchema,
  sentAt: isoInstantSchema,
});
export type NotificationLog = z.infer<typeof notificationLogSchema>;

// ── Noite: prioridade do dia e sessões com o Kai ───────────────────────────

/** Plano de um dia: a prioridade nº 1 (definida na noite anterior) e o resultado. */
export const dayPlanSchema = z.object({
  date: civilDateSchema,
  priority: z.string().trim().min(1).max(200).optional(),
  prioritySource: z.enum(['manual', 'voice', 'kai']).optional(),
  prioritySetAt: isoInstantSchema.optional(),
  outcome: z.enum(['done', 'not_done']).optional(),
  outcomeAt: isoInstantSchema.optional(),
  createdAt: isoInstantSchema,
  updatedAt: isoInstantSchema,
});
export type DayPlan = z.infer<typeof dayPlanSchema>;

export const nightProposalKindSchema = z.enum(['bloco_amanha', 'tarefa_amanha', 'ajustar_habito', 'revisar_agenda', 'reflexao']);
export type NightProposalKind = z.infer<typeof nightProposalKindSchema>;

export const nightProposalSchema = z.object({
  kind: nightProposalKindSchema,
  title: z.string().max(120),
  detail: z.string().max(400),
  refs: z.array(z.string().max(20)).max(6),
  start: localTimeSchema.nullable(),
  end: localTimeSchema.nullable(),
  /** Ids locais resolvidos a partir das referências no momento da resposta. */
  habitId: idSchema.optional(),
  goalId: idSchema.optional(),
  status: z.enum(['pending', 'accepted', 'dismissed']),
  /** Item criado na agenda ao aceitar (permite desfazer). */
  createdItemId: idSchema.optional(),
});
export type NightProposal = z.infer<typeof nightProposalSchema>;

export const nightMessageSchema = z.object({
  id: idSchema,
  role: z.enum(['user', 'assistant']),
  /** Texto exibido; no Kai, é o que foi falado. */
  content: z.string().max(4000),
  /** Quem produziu a fala do assistente: o Kai (IA) ou o resumo calculado pelo app. */
  source: z.enum(['kai', 'app']).optional(),
  /** Como a pessoa respondeu. */
  via: z.enum(['voice', 'text']).optional(),
  question: z.string().max(300).optional(),
  priority: z.string().max(200).optional(),
  observations: z
    .array(z.object({ text: z.string().max(300), refs: z.array(z.string().max(20)).max(6), confidence: z.enum(['baixa', 'media', 'alta']) }))
    .max(3)
    .optional(),
  proposals: z.array(nightProposalSchema).max(3).optional(),
  /** Evidências descritas pelo app (não pelo modelo) para as referências citadas. */
  evidence: z.record(z.string(), z.object({ label: z.string().max(200), detail: z.string().max(400) })).optional(),
  supportNotice: z.boolean().optional(),
  model: z.string().max(80).optional(),
  createdAt: isoInstantSchema,
});
export type NightMessage = z.infer<typeof nightMessageSchema>;

export const nightSessionSchema = z.object({
  /** Uma sessão por noite: o id é a data. */
  id: civilDateSchema,
  date: civilDateSchema,
  messages: z.array(nightMessageSchema).max(120),
  /** O que foi enviado ao Kai na última chamada (categorias e contagens). */
  dataUsed: kaiDataManifestSchema.optional(),
  createdAt: isoInstantSchema,
  updatedAt: isoInstantSchema,
});
export type NightSession = z.infer<typeof nightSessionSchema>;

/** Converte erros do Zod em um mapa campo → mensagem para formulários. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.map(String).join('.') || '_';
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}
