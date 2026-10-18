import {
  addDays,
  addMonths,
  diffDays,
  eachDay,
  endOfMonth,
  endOfWeek,
  endOfYear,
  minCivil,
  parseCivil,
  startOfMonth,
  startOfWeek,
  startOfYear,
  type CivilDate,
  type WeekStart,
} from './civil';
import { formatDate, formatLongDate, formatMonthYear, formatShortDate, monthShort, weekdayShort } from './format';
import type { Checkin, CompletionStatus, Habit, HabitCompletion } from './schemas';
import { isScheduledOn } from './schedule';
import { computeStreak, type CompletionLookup } from './streak';

/**
 * Conjuntos de dados dos relatórios. Tudo é derivado dos registros locais;
 * quando não há base suficiente, a função devolve indicação explícita em vez de números.
 */

export type PeriodKind = 'day' | 'week' | 'month' | 'year' | 'custom';

export interface ReportPeriod {
  kind: PeriodKind;
  start: CivilDate;
  end: CivilDate;
  label: string;
}

export const PERIOD_LABEL: Record<PeriodKind, string> = {
  day: 'Dia',
  week: 'Semana',
  month: 'Mês',
  year: 'Ano',
  custom: 'Personalizado',
};

export const MAX_CUSTOM_DAYS = 366;

export function resolvePeriod(kind: PeriodKind, anchor: CivilDate, weekStartsOn: WeekStart, custom?: { start: CivilDate; end: CivilDate }): ReportPeriod {
  switch (kind) {
    case 'day':
      return { kind, start: anchor, end: anchor, label: formatLongDate(anchor, true) };
    case 'week': {
      const start = startOfWeek(anchor, weekStartsOn);
      const end = endOfWeek(anchor, weekStartsOn);
      return { kind, start, end, label: `Semana de ${formatShortDate(start)} a ${formatShortDate(end)}` };
    }
    case 'month':
      return { kind, start: startOfMonth(anchor), end: endOfMonth(anchor), label: capitalize(formatMonthYear(anchor)) };
    case 'year':
      return { kind, start: startOfYear(anchor), end: endOfYear(anchor), label: String(parseCivil(anchor).y) };
    case 'custom': {
      const start = custom?.start ?? addDays(anchor, -29);
      let end = custom?.end ?? anchor;
      if (end < start) end = start;
      if (diffDays(end, start) + 1 > MAX_CUSTOM_DAYS) end = addDays(start, MAX_CUSTOM_DAYS - 1);
      return { kind, start, end, label: `${formatDate(start)} a ${formatDate(end)}` };
    }
  }
}

/** Move o período para trás/frente mantendo o tipo. */
export function shiftPeriod(period: ReportPeriod, direction: -1 | 1, weekStartsOn: WeekStart): ReportPeriod {
  switch (period.kind) {
    case 'day':
      return resolvePeriod('day', addDays(period.start, direction), weekStartsOn);
    case 'week':
      return resolvePeriod('week', addDays(period.start, 7 * direction), weekStartsOn);
    case 'month':
      return resolvePeriod('month', addMonths(period.start, direction), weekStartsOn);
    case 'year':
      return resolvePeriod('year', addMonths(period.start, 12 * direction), weekStartsOn);
    case 'custom': {
      const len = diffDays(period.end, period.start) + 1;
      return resolvePeriod('custom', period.start, weekStartsOn, {
        start: addDays(period.start, len * direction),
        end: addDays(period.end, len * direction),
      });
    }
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export interface Bucket {
  key: string;
  start: CivilDate;
  end: CivilDate;
  /** Rótulo curto do eixo. */
  label: string;
  /** Rótulo completo para tooltip/tabela. */
  fullLabel: string;
}

export function bucketsFor(period: ReportPeriod, weekStartsOn: WeekStart): Bucket[] {
  const days = diffDays(period.end, period.start) + 1;
  if (period.kind === 'year') {
    const out: Bucket[] = [];
    let cursor = startOfMonth(period.start);
    while (cursor <= period.end) {
      const end = minCivil(endOfMonth(cursor), period.end);
      const m = parseCivil(cursor).m;
      out.push({ key: cursor.slice(0, 7), start: cursor, end, label: monthShort(m), fullLabel: capitalize(formatMonthYear(cursor)) });
      cursor = addMonths(cursor, 1);
    }
    return out;
  }
  if (period.kind === 'custom' && days > 62) {
    const out: Bucket[] = [];
    let cursor = startOfWeek(period.start, weekStartsOn);
    while (cursor <= period.end) {
      const start = cursor < period.start ? period.start : cursor;
      const end = minCivil(addDays(cursor, 6), period.end);
      out.push({ key: start, start, end, label: formatShortDate(start), fullLabel: `${formatShortDate(start)} a ${formatShortDate(end)}` });
      cursor = addDays(cursor, 7);
    }
    return out;
  }
  return eachDay(period.start, period.end).map((d) => ({
    key: d,
    start: d,
    end: d,
    label: period.kind === 'week' || days <= 7 ? weekdayShort(d) : String(parseCivil(d).d),
    fullLabel: formatLongDate(d),
  }));
}

export interface CompletionPoint {
  bucket: Bucket;
  scheduled: number;
  done: number;
  skipped: number;
  open: number;
  missed: number;
  /** concluídas ÷ (concluídas + perdidas); null sem ocorrências encerradas. */
  rate: number | null;
  /** Bucket inteiramente no futuro. */
  future: boolean;
}

export function completionSeries(
  habits: readonly Pick<Habit, 'id' | 'scheduleHistory' | 'pauses'>[],
  completionsByHabit: ReadonlyMap<string, CompletionLookup>,
  buckets: readonly Bucket[],
  today: CivilDate,
): CompletionPoint[] {
  return buckets.map((bucket) => {
    const point: CompletionPoint = { bucket, scheduled: 0, done: 0, skipped: 0, open: 0, missed: 0, rate: null, future: bucket.start > today };
    if (point.future) return point;
    const end = minCivil(bucket.end, today);
    for (const date of eachDay(bucket.start, end)) {
      for (const habit of habits) {
        if (!isScheduledOn(habit, date)) continue;
        point.scheduled += 1;
        const status = completionsByHabit.get(habit.id)?.get(date);
        if (status === 'done') point.done += 1;
        else if (status === 'skipped') point.skipped += 1;
        else if (date === today) point.open += 1;
        else point.missed += 1;
      }
    }
    const eligible = point.done + point.missed;
    point.rate = eligible > 0 ? point.done / eligible : null;
    return point;
  });
}

export interface PeriodTotals {
  scheduled: number;
  done: number;
  skipped: number;
  open: number;
  missed: number;
  rate: number | null;
}

export function totalsOf(points: readonly CompletionPoint[]): PeriodTotals {
  const t: PeriodTotals = { scheduled: 0, done: 0, skipped: 0, open: 0, missed: 0, rate: null };
  for (const p of points) {
    t.scheduled += p.scheduled;
    t.done += p.done;
    t.skipped += p.skipped;
    t.open += p.open;
    t.missed += p.missed;
  }
  const eligible = t.done + t.missed;
  t.rate = eligible > 0 ? t.done / eligible : null;
  return t;
}

/** Linha de taxa só faz sentido com ao menos dois pontos com ocorrências encerradas. */
export function rateSeriesIsMeaningful(points: readonly CompletionPoint[]): boolean {
  return points.filter((p) => p.rate !== null).length >= 2;
}

export interface CategorySlice {
  category: string;
  done: number;
  scheduled: number;
}

export function categoryDistribution(
  habits: readonly Pick<Habit, 'id' | 'category' | 'scheduleHistory' | 'pauses'>[],
  completions: readonly Pick<HabitCompletion, 'habitId' | 'scheduledDate' | 'status'>[],
  start: CivilDate,
  end: CivilDate,
  today: CivilDate,
): CategorySlice[] {
  const byHabit = new Map(habits.map((h) => [h.id, h]));
  const out = new Map<string, CategorySlice>();
  const last = minCivil(end, today);
  for (const habit of habits) {
    const slice = out.get(habit.category) ?? { category: habit.category, done: 0, scheduled: 0 };
    if (last >= start) for (const d of eachDay(start, last)) if (isScheduledOn(habit, d)) slice.scheduled += 1;
    out.set(habit.category, slice);
  }
  for (const c of completions) {
    if (c.status !== 'done' || c.scheduledDate < start || c.scheduledDate > last) continue;
    const habit = byHabit.get(c.habitId);
    if (!habit) continue;
    const slice = out.get(habit.category)!;
    slice.done += 1;
  }
  return [...out.values()].filter((s) => s.done > 0 || s.scheduled > 0).sort((a, b) => b.done - a.done || a.category.localeCompare(b.category, 'pt-BR'));
}

export interface StreakRow {
  habitId: string;
  title: string;
  current: number;
  best: number;
}

export function streakRows(
  habits: readonly Pick<Habit, 'id' | 'title' | 'status' | 'scheduleHistory' | 'pauses'>[],
  completionsByHabit: ReadonlyMap<string, ReadonlyMap<CivilDate, CompletionStatus>>,
  today: CivilDate,
): StreakRow[] {
  return habits
    .filter((h) => h.status !== 'archived')
    .map((h) => {
      const s = computeStreak(h, completionsByHabit.get(h.id) ?? new Map(), today);
      return { habitId: h.id, title: h.title, current: s.current, best: s.best };
    })
    .sort((a, b) => b.current - a.current || b.best - a.best || a.title.localeCompare(b.title, 'pt-BR'));
}

export interface CheckinPoint {
  bucket: Bucket;
  mood: number | null;
  energy: number | null;
  count: number;
}

export const MIN_CHECKINS_FOR_TREND = 5;

export function checkinSeries(checkins: readonly Checkin[], buckets: readonly Bucket[]): CheckinPoint[] {
  return buckets.map((bucket) => {
    const inBucket = checkins.filter((c) => c.date >= bucket.start && c.date <= bucket.end);
    const moods = inBucket.map((c) => c.mood).filter((v): v is number => v !== undefined);
    const energies = inBucket.map((c) => c.energy).filter((v): v is number => v !== undefined);
    const avg = (xs: number[]) => (xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    return { bucket, mood: avg(moods), energy: avg(energies), count: inBucket.length };
  });
}
