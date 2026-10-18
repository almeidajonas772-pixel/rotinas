import { eachDay, minCivil, type CivilDate } from './civil';
import type { CompletionStatus, Habit, HabitCompletion } from './schemas';
import { isScheduledOn, occurrencesBetween } from './schedule';
import type { CompletionLookup } from './streak';

/**
 * Métricas de conclusão. Definição usada em todo o app:
 *  previstas   = ocorrências previstas no período, até hoje (dias futuros não contam);
 *  concluídas  = previstas com conclusão registrada;
 *  puladas     = previstas que a pessoa marcou como "pular" (saem do cálculo);
 *  em aberto   = a ocorrência de hoje ainda sem registro (sai do cálculo até o dia acabar);
 *  perdidas    = previstas já encerradas sem registro;
 *  taxa        = concluídas ÷ (concluídas + perdidas). Sem ocorrências encerradas, a taxa não existe (null).
 */

export interface OccurrenceStats {
  scheduled: number;
  done: number;
  skipped: number;
  open: number;
  missed: number;
  /** Conclusões registradas em dias sem ocorrência prevista (não entram na taxa). */
  extra: number;
  rate: number | null;
}

export const EMPTY_STATS: OccurrenceStats = { scheduled: 0, done: 0, skipped: 0, open: 0, missed: 0, extra: 0, rate: null };

export function lookupFor(habitId: string, completions: readonly HabitCompletion[]): Map<CivilDate, CompletionStatus> {
  const map = new Map<CivilDate, CompletionStatus>();
  for (const c of completions) if (c.habitId === habitId) map.set(c.scheduledDate, c.status);
  return map;
}

export function groupCompletions(completions: readonly HabitCompletion[]): Map<string, Map<CivilDate, CompletionStatus>> {
  const out = new Map<string, Map<CivilDate, CompletionStatus>>();
  for (const c of completions) {
    let m = out.get(c.habitId);
    if (!m) {
      m = new Map();
      out.set(c.habitId, m);
    }
    m.set(c.scheduledDate, c.status);
  }
  return out;
}

export function habitStatsBetween(
  habit: Pick<Habit, 'scheduleHistory' | 'pauses'>,
  completions: CompletionLookup,
  from: CivilDate,
  to: CivilDate,
  today: CivilDate,
): OccurrenceStats {
  const end = minCivil(to, today);
  if (end < from) return { ...EMPTY_STATS };
  const stats: OccurrenceStats = { ...EMPTY_STATS };
  const scheduledSet = new Set<CivilDate>();
  for (const date of occurrencesBetween(habit, from, end)) {
    scheduledSet.add(date);
    stats.scheduled += 1;
    const status = completions.get(date);
    if (status === 'done') stats.done += 1;
    else if (status === 'skipped') stats.skipped += 1;
    else if (date === today) stats.open += 1;
    else stats.missed += 1;
  }
  for (const [date, status] of completions) {
    if (status === 'done' && date >= from && date <= end && !scheduledSet.has(date)) stats.extra += 1;
  }
  const eligible = stats.done + stats.missed;
  stats.rate = eligible > 0 ? stats.done / eligible : null;
  return stats;
}

export function sumStats(list: readonly OccurrenceStats[]): OccurrenceStats {
  const total: OccurrenceStats = { ...EMPTY_STATS };
  for (const s of list) {
    total.scheduled += s.scheduled;
    total.done += s.done;
    total.skipped += s.skipped;
    total.open += s.open;
    total.missed += s.missed;
    total.extra += s.extra;
  }
  const eligible = total.done + total.missed;
  total.rate = eligible > 0 ? total.done / eligible : null;
  return total;
}

export interface DayAggregate {
  date: CivilDate;
  scheduled: number;
  done: number;
  skipped: number;
  open: number;
  missed: number;
}

/** Agregado diário (todos os hábitos) — base dos relatórios e do resumo semanal. */
export function dailyAggregates(
  habits: readonly Pick<Habit, 'id' | 'scheduleHistory' | 'pauses'>[],
  completionsByHabit: ReadonlyMap<string, CompletionLookup>,
  from: CivilDate,
  to: CivilDate,
  today: CivilDate,
): DayAggregate[] {
  const end = minCivil(to, today);
  if (end < from) return [];
  return eachDay(from, end).map((date) => {
    const agg: DayAggregate = { date, scheduled: 0, done: 0, skipped: 0, open: 0, missed: 0 };
    for (const habit of habits) {
      if (!isScheduledOn(habit, date)) continue;
      agg.scheduled += 1;
      const status = completionsByHabit.get(habit.id)?.get(date);
      if (status === 'done') agg.done += 1;
      else if (status === 'skipped') agg.skipped += 1;
      else if (date === today) agg.open += 1;
      else agg.missed += 1;
    }
    return agg;
  });
}

export function formatRate(rate: number | null): string {
  if (rate === null) return '—';
  return `${Math.round(rate * 100)}%`;
}
