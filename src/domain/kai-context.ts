import type { KaiContext } from '../../shared/kai';
import { addDays, minCivil, type CivilDate } from './civil';
import { formatShortDate } from './format';
import { computeGoalProgress, type GoalProgressContext } from './goals';
import { describeSchedule, describeTiming, currentSchedule, isScheduledOn } from './schedule';
import type { Checkin, Goal, Habit, HabitCompletion, JournalEntry, KaiDataManifest, Preferences, Profile } from './schemas';
import { habitStatsBetween, groupCompletions } from './stats';
import { computeStreak } from './streak';
import { eachDay } from './civil';

/**
 * Monta o contexto mínimo e consentido enviado ao Kai. Regras:
 * - sem consentimento de coaching, nada é montado (lança KaiConsentError);
 * - nunca envia nome, notas de conclusões, textos de check-in nem ids internos;
 * - hábitos e metas viram referências curtas (h1, g1) e o mapa ref → id fica no aparelho;
 * - check-ins só entram com o recurso ativo E o consentimento específico;
 * - trechos do Diário só entram com o consentimento específico do Diário e apenas
 *   de entradas que não foram marcadas como privadas; cada trecho é truncado.
 */

export class KaiConsentError extends Error {
  constructor(message = 'O coaching por IA está desativado. Ative-o em Kai para enviar dados.') {
    super(message);
    this.name = 'KaiConsentError';
  }
}

export interface KaiSnapshot {
  today: CivilDate;
  profile: Profile;
  prefs: Preferences;
  habits: readonly Habit[];
  completions: readonly HabitCompletion[];
  goals: readonly Goal[];
  goalCtx: GoalProgressContext;
  checkins: readonly Checkin[];
  journal: readonly JournalEntry[];
}

export interface BuiltKaiContext {
  context: KaiContext;
  refMap: Record<string, string>;
  manifest: KaiDataManifest;
}

export const DEFAULT_KAI_PERIOD_DAYS = 14;
const JOURNAL_EXCERPT = 600;

export function journalAllowedForKai(prefs: Preferences, entry: Pick<JournalEntry, 'kaiAccess'>): boolean {
  return prefs.consents.kai.granted && prefs.consents.kaiJournal.granted && entry.kaiAccess === 'allowed';
}

export function checkinsAllowedForKai(prefs: Preferences): boolean {
  return prefs.consents.kai.granted && prefs.features.checkins && prefs.consents.kaiCheckins.granted;
}

function excerptOf(entry: JournalEntry): string {
  const parts = [
    entry.text.trim(),
    entry.didToday ? `O que fiz: ${entry.didToday}` : '',
    entry.whatWorked ? `O que funcionou: ${entry.whatWorked}` : '',
    entry.toImprove ? `O que melhorar: ${entry.toImprove}` : '',
    entry.nextStep ? `Próximo passo: ${entry.nextStep}` : '',
  ].filter((p) => p.length > 0);
  const joined = parts.join('\n').replace(/\s+\n/g, '\n');
  return joined.length > JOURNAL_EXCERPT ? `${joined.slice(0, JOURNAL_EXCERPT - 1)}…` : joined;
}

export function buildKaiContext(
  snapshot: KaiSnapshot,
  options: { period?: { start: CivilDate; end: CivilDate }; includeGoals?: boolean } = {},
): BuiltKaiContext {
  const { prefs, profile, today } = snapshot;
  if (!prefs.consents.kai.granted) throw new KaiConsentError();

  const period = options.period ?? { start: addDays(today, -(DEFAULT_KAI_PERIOD_DAYS - 1)), end: today };
  const refMap: Record<string, string> = {};
  const counts: Record<string, number> = {};
  const categories: string[] = ['Configuração da rotina (objetivo principal, períodos livres e minutos por dia)'];

  const habits = snapshot.habits.filter((h) => h.status !== 'archived').sort((a, b) => a.order - b.order).slice(0, 40);
  const byHabit = groupCompletions(snapshot.completions);
  const habitEntries: KaiContext['habits'] = [];
  const aggregates: KaiContext['aggregates'] = [];
  habits.forEach((habit, index) => {
    const ref = `h${index + 1}`;
    refMap[ref] = habit.id;
    habitEntries.push({
      ref,
      title: habit.title,
      category: habit.category,
      schedule: describeSchedule(currentSchedule(habit)),
      timing: describeTiming(habit.timing),
      status: habit.status === 'paused' ? 'paused' : 'active',
      firstStep: habit.firstStep,
    });
    const lookup = byHabit.get(habit.id) ?? new Map();
    const stats = habitStatsBetween(habit, lookup, period.start, period.end, today);
    const streak = computeStreak(habit, lookup, today);
    aggregates.push({
      ref,
      scheduled: stats.scheduled,
      done: stats.done,
      skipped: stats.skipped,
      missed: stats.missed,
      open: stats.open,
      rate: stats.rate,
      currentStreak: streak.current,
      bestStreak: streak.best,
    });
  });
  if (habitEntries.length > 0) {
    categories.push('Hábitos (título, categoria, frequência e horário) e contagens de conclusão do período');
    counts.habits = habitEntries.length;
  }

  const goals: KaiContext['goals'] = [];
  if (options.includeGoals !== false) {
    const relevant = snapshot.goals
      .filter((g) => g.status !== 'archived' && g.periodEnd >= addDays(period.start, -31) && g.periodStart <= addDays(period.end, 366))
      .slice(0, 30);
    relevant.forEach((goal, index) => {
      const ref = `g${index + 1}`;
      refMap[ref] = goal.id;
      const progress = computeGoalProgress(goal, snapshot.goalCtx);
      goals.push({
        ref,
        title: goal.title,
        horizon: goal.horizon,
        periodStart: goal.periodStart,
        periodEnd: goal.periodEnd,
        status: goal.status === 'completed' ? 'completed' : 'active',
        progress: { current: progress.current, target: progress.target, unit: progress.unit, manual: progress.manual },
      });
    });
    if (goals.length > 0) {
      categories.push('Metas (título, período e progresso calculado)');
      counts.goals = goals.length;
    }
  }

  let checkins: KaiContext['checkins'];
  if (checkinsAllowedForKai(prefs)) {
    checkins = snapshot.checkins
      .filter((c) => c.date >= period.start && c.date <= period.end && (c.mood !== undefined || c.energy !== undefined))
      .sort((a, b) => (a.date < b.date ? -1 : 1))
      .slice(-62)
      .map((c) => ({ date: c.date, mood: c.mood, energy: c.energy }));
    categories.push('Check-ins de humor e energia do período (somente as notas numéricas, sem os comentários)');
    counts.checkins = checkins.length;
  }

  let journal: KaiContext['journal'];
  if (prefs.consents.kaiJournal.granted) {
    const allowed = snapshot.journal
      .filter((e) => journalAllowedForKai(prefs, e) && e.date >= period.start && e.date <= period.end)
      .sort((a, b) => (a.date < b.date ? 1 : -1))
      .slice(0, 7);
    journal = allowed.map((entry, index) => {
      const ref = `j${index + 1}`;
      refMap[ref] = entry.id;
      return { ref, date: entry.date, excerpt: excerptOf(entry) };
    });
    categories.push(`Trechos do Diário (até ${JOURNAL_EXCERPT} caracteres por entrada, sem as entradas marcadas como privadas)`);
    counts.journal = journal.length;
  }

  // Estatísticas do período usadas para o limiar de dados mínimos.
  const lastDay = minCivil(period.end, today);
  let daysWithSchedule = 0;
  let closed = 0;
  if (lastDay >= period.start) {
    for (const date of eachDay(period.start, lastDay)) {
      if (habits.some((h) => isScheduledOn(h, date))) daysWithSchedule += 1;
    }
  }
  for (const a of aggregates) closed += a.done + a.missed;

  const context: KaiContext = {
    locale: 'pt-BR',
    timezone: profile.timezone,
    today,
    period,
    periodStats: {
      daysElapsed: lastDay >= period.start ? eachDay(period.start, lastDay).length : 0,
      daysWithSchedule,
      closedOccurrences: closed,
    },
    profile: {
      mainGoal: profile.mainGoal,
      periods: profile.availability.periods.length > 0 ? profile.availability.periods : undefined,
      minutesPerDay: profile.availability.minutesPerDay,
    },
    habits: habitEntries,
    aggregates,
    goals,
    checkins,
    journal,
  };

  return {
    context,
    refMap,
    manifest: { categories, counts, period: { start: period.start, end: period.end } },
  };
}

export function describePeriod(period: { start: CivilDate; end: CivilDate }): string {
  return `${formatShortDate(period.start)} a ${formatShortDate(period.end)}`;
}
