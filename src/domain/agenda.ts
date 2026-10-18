import { addDays, diffDays, isoWeekday, startOfWeek, timeToMinutes, minutesToTime, type CivilDate, type LocalTime } from './civil';
import type { AgendaItem, AgendaKind, Habit, OccurrenceOverride } from './schemas';
import { isScheduledOn, occurrencesBetween } from './schedule';
import { convertWallTime } from './tz';

/**
 * Agenda nativa: itens (tarefa, evento, bloco de hábito) com recorrência opcional
 * (diária ou semanal, com intervalo, fim por data ou por número de vezes) e exceções
 * por ocorrência. Datas e horários de cada item são definidos no fuso do item e
 * exibidos no fuso atual do perfil.
 */

const MAX_ITERATIONS = 20_000;

export interface AgendaOccurrence {
  key: string;
  itemId: string;
  kind: AgendaKind;
  title: string;
  /** Data original da ocorrência na série (fuso do item) — chave para concluir/editar. */
  originalDate: CivilDate;
  /** Data exibida (fuso do perfil). */
  date: CivilDate;
  allDay: boolean;
  startTime?: LocalTime;
  endTime?: LocalTime;
  /** O fim cai no dia seguinte depois da conversão de fuso. */
  endsNextDay?: boolean;
  recurring: boolean;
  overridden: boolean;
  habitId?: string;
  goalId?: string;
  category?: string;
  notes?: string;
  origin: AgendaItem['origin'];
  xp: number;
  external?: AgendaItem['external'];
  /** Fuso do item difere do perfil. */
  shiftedZone?: string;
}

/** Ocorrência prevista de um hábito exibida na agenda (derivada da agenda do hábito; não é um item salvo). */
export interface HabitAgendaOccurrence {
  key: string;
  kind: 'habit';
  virtual: true;
  habitId: string;
  title: string;
  date: CivilDate;
  allDay: boolean;
  startTime?: LocalTime;
  endTime?: LocalTime;
  category: string;
  goalId?: string;
}

export function occurrenceKey(itemId: string, originalDate: CivilDate): string {
  return `${itemId}|${originalDate}`;
}

export function seriesKindOf(item: Pick<AgendaItem, 'date' | 'recurrence'>): AgendaItem['seriesKind'] {
  if (!item.date) return 'undated';
  return item.recurrence ? 'recurring' : 'single';
}

/** Datas da série entre `from` e `to` (inclusive), no fuso do item, sem aplicar exceções. */
export function seriesDates(item: Pick<AgendaItem, 'date' | 'recurrence'>, from: CivilDate, to: CivilDate): CivilDate[] {
  if (!item.date || from > to) return [];
  const start = item.date;
  const r = item.recurrence;
  if (!r) return start >= from && start <= to ? [start] : [];
  const limit = r.until && r.until < to ? r.until : to;
  if (limit < start) return [];
  const out: CivilDate[] = [];

  if (r.freq === 'daily') {
    let k = r.count ? 0 : Math.max(0, Math.ceil(diffDays(from, start) / r.interval));
    for (let i = 0; i < MAX_ITERATIONS; i++, k++) {
      if (r.count && k >= r.count) break;
      const d = addDays(start, k * r.interval);
      if (d > limit) break;
      if (d >= from) out.push(d);
    }
    return out;
  }

  const days = [...(r.byWeekday && r.byWeekday.length > 0 ? r.byWeekday : [isoWeekday(start)])].sort((a, b) => a - b);
  const week0 = startOfWeek(start, 1);
  let week = r.count ? 0 : Math.max(0, Math.floor(Math.floor(diffDays(from, week0) / 7) / r.interval) * r.interval);
  let produced = 0;
  for (let i = 0; i < MAX_ITERATIONS; i++, week += r.interval) {
    const weekStart = addDays(week0, week * 7);
    if (weekStart > limit) break;
    for (const wd of days) {
      const d = addDays(weekStart, wd - 1);
      if (d < start) continue;
      if (d > limit) break;
      if (r.count && produced >= r.count) return out;
      produced += 1;
      if (d >= from) out.push(d);
    }
  }
  return out;
}

export function isSeriesDate(item: Pick<AgendaItem, 'date' | 'recurrence'>, date: CivilDate): boolean {
  return seriesDates(item, date, date).length === 1;
}

interface RawOccurrence {
  originalDate: CivilDate;
  date: CivilDate;
  startTime?: LocalTime;
  endTime?: LocalTime;
  title: string;
  overridden: boolean;
}

function applyOverride(item: AgendaItem, originalDate: CivilDate, ex: OccurrenceOverride | undefined): RawOccurrence {
  return {
    originalDate,
    date: ex?.date ?? originalDate,
    startTime: ex?.startTime ?? item.startTime,
    endTime: ex?.endTime ?? item.endTime,
    title: ex?.title ?? item.title,
    overridden: ex !== undefined,
  };
}

/** Ocorrências de um item no intervalo, no fuso do próprio item, já com exceções aplicadas. */
export function expandItemRaw(item: AgendaItem, from: CivilDate, to: CivilDate): RawOccurrence[] {
  if (item.status !== 'active' || !item.date) return [];
  const out: RawOccurrence[] = [];
  for (const original of seriesDates(item, from, to)) {
    const ex = item.exceptions[original];
    if (ex?.cancelled) continue;
    const occ = applyOverride(item, original, ex);
    if (occ.date >= from && occ.date <= to) out.push(occ);
  }
  // Ocorrências movidas para dentro do intervalo a partir de uma data original fora dele.
  for (const [original, ex] of Object.entries(item.exceptions)) {
    if (ex.cancelled || !ex.date) continue;
    if (original >= from && original <= to) continue;
    if (ex.date < from || ex.date > to) continue;
    if (!isSeriesDate(item, original)) continue;
    out.push(applyOverride(item, original, ex));
  }
  return out;
}

/** Expande itens para exibição no fuso do perfil. */
export function expandAgenda(items: readonly AgendaItem[], from: CivilDate, to: CivilDate, displayZone: string): AgendaOccurrence[] {
  const out: AgendaOccurrence[] = [];
  for (const item of items) {
    const zoneDiffers = item.timezone !== displayZone;
    const pad = zoneDiffers && !item.allDay ? 1 : 0;
    for (const raw of expandItemRaw(item, addDays(from, -pad), addDays(to, pad))) {
      let date = raw.date;
      let startTime = raw.startTime;
      let endTime = raw.endTime;
      let endsNextDay = false;
      if (!item.allDay && zoneDiffers && startTime) {
        const s = convertWallTime(raw.date, startTime, item.timezone, displayZone);
        date = s.date;
        startTime = s.time;
        if (endTime) {
          const e = convertWallTime(raw.date, endTime, item.timezone, displayZone);
          endTime = e.time;
          endsNextDay = e.date > s.date;
        }
      }
      if (date < from || date > to) continue;
      out.push({
        key: occurrenceKey(item.id, raw.originalDate),
        itemId: item.id,
        kind: item.kind,
        title: raw.title,
        originalDate: raw.originalDate,
        date,
        allDay: item.allDay,
        startTime,
        endTime,
        endsNextDay: endsNextDay || undefined,
        recurring: item.recurrence !== undefined,
        overridden: raw.overridden,
        habitId: item.habitId,
        goalId: item.goalId,
        category: item.category,
        notes: item.notes,
        origin: item.origin,
        xp: item.xp,
        external: item.external,
        shiftedZone: zoneDiffers ? item.timezone : undefined,
      });
    }
  }
  return sortOccurrences(out);
}

export function sortOccurrences<T extends { date: CivilDate; allDay: boolean; startTime?: LocalTime; title: string }>(list: T[]): T[] {
  return list.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    const at = a.startTime ?? '99:99';
    const bt = b.startTime ?? '99:99';
    if (at !== bt) return at < bt ? -1 : 1;
    return a.title.localeCompare(b.title, 'pt-BR');
  });
}

/** Ocorrências previstas dos hábitos ativos na agenda, omitindo datas que já têm um bloco de tempo do mesmo hábito. */
export function habitOccurrencesForAgenda(
  habits: readonly Habit[],
  from: CivilDate,
  to: CivilDate,
  blocks: readonly Pick<AgendaOccurrence, 'kind' | 'habitId' | 'date'>[],
): HabitAgendaOccurrence[] {
  const blocked = new Set(blocks.filter((b) => b.kind === 'habit' && b.habitId).map((b) => `${b.habitId}|${b.date}`));
  const out: HabitAgendaOccurrence[] = [];
  for (const habit of habits) {
    if (habit.status === 'archived') continue;
    for (const date of occurrencesBetween(habit, from, to)) {
      if (blocked.has(`${habit.id}|${date}`)) continue;
      const t = habit.timing;
      let startTime: LocalTime | undefined;
      let endTime: LocalTime | undefined;
      if (t.kind === 'time') {
        startTime = t.time;
        if (habit.durationMinutes) endTime = minutesToTime(Math.min(timeToMinutes(t.time) + habit.durationMinutes, 23 * 60 + 59));
      } else if (t.kind === 'window') {
        startTime = t.start;
        endTime = t.end;
      }
      out.push({
        key: `habit|${habit.id}|${date}`,
        kind: 'habit',
        virtual: true,
        habitId: habit.id,
        title: habit.title,
        date,
        allDay: t.kind === 'anytime',
        startTime,
        endTime,
        category: habit.category,
        goalId: habit.goalId,
      });
    }
  }
  return out;
}

// ── Edição de séries ────────────────────────────────────────────────────────

export type EditScope = 'this' | 'following' | 'all';

export interface OccurrenceChanges {
  title?: string;
  date?: CivilDate;
  startTime?: LocalTime;
  endTime?: LocalTime;
}

function countBefore(item: AgendaItem, date: CivilDate): number {
  if (!item.date || date <= item.date) return 0;
  return seriesDates(item, item.date, addDays(date, -1)).length;
}

/** "Somente esta": grava uma exceção para a data original. */
export function editThisOccurrence(item: AgendaItem, originalDate: CivilDate, changes: OccurrenceChanges, nowIso: string): AgendaItem {
  const prev = item.exceptions[originalDate] ?? {};
  const next: OccurrenceOverride = { ...prev };
  if (changes.title !== undefined) next.title = changes.title === item.title ? undefined : changes.title;
  if (changes.date !== undefined) next.date = changes.date === originalDate ? undefined : changes.date;
  if (changes.startTime !== undefined) next.startTime = changes.startTime === item.startTime ? undefined : changes.startTime;
  if (changes.endTime !== undefined) next.endTime = changes.endTime === item.endTime ? undefined : changes.endTime;
  const clean = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined)) as OccurrenceOverride;
  const exceptions = { ...item.exceptions };
  if (Object.keys(clean).length === 0) delete exceptions[originalDate];
  else exceptions[originalDate] = clean;
  return { ...item, exceptions, updatedAt: nowIso };
}

/**
 * "Esta e as próximas": encerra a série original no dia anterior e cria uma nova série
 * a partir da ocorrência escolhida com as mudanças. Na primeira ocorrência, equivale a "todas".
 */
export function splitSeries(
  item: AgendaItem,
  originalDate: CivilDate,
  patch: Partial<AgendaItem>,
  newId: string,
  nowIso: string,
): { previous: AgendaItem | null; next: AgendaItem } {
  if (!item.recurrence || !item.date || originalDate <= item.date) {
    const merged = { ...item, ...patch, id: item.id, updatedAt: nowIso };
    return { previous: null, next: { ...merged, seriesKind: seriesKindOf(merged) } };
  }
  const before = countBefore(item, originalDate);
  const r = item.recurrence;
  const previous: AgendaItem = {
    ...item,
    recurrence: { ...r, until: addDays(originalDate, -1), count: r.count ? before : undefined },
    exceptions: Object.fromEntries(Object.entries(item.exceptions).filter(([d]) => d < originalDate)),
    updatedAt: nowIso,
  };
  const remaining = r.count ? Math.max(1, r.count - before) : undefined;
  const nextDate = patch.date ?? originalDate;
  const carried = nextDate === originalDate ? Object.fromEntries(Object.entries(item.exceptions).filter(([d]) => d >= originalDate)) : {};
  let nextRecurrence: AgendaItem['recurrence'];
  if (!('recurrence' in patch)) nextRecurrence = { ...r, count: remaining };
  else if (!patch.recurrence) nextRecurrence = undefined;
  else if (JSON.stringify(patch.recurrence) === JSON.stringify(r)) nextRecurrence = { ...r, count: remaining };
  else nextRecurrence = patch.recurrence;
  const draft: AgendaItem = {
    ...item,
    ...patch,
    id: newId,
    date: nextDate,
    recurrence: nextRecurrence,
    exceptions: carried,
    external: undefined,
    createdAt: nowIso,
    updatedAt: nowIso,
    seriesKind: 'recurring',
  };
  return { previous, next: { ...draft, seriesKind: seriesKindOf(draft) } };
}

/** Exclusão: "somente esta" vira exceção cancelada; "esta e as próximas" encerra a série; "todas" remove o item. */
export function deleteOccurrence(item: AgendaItem, originalDate: CivilDate, scope: EditScope, nowIso: string): AgendaItem | null {
  if (!item.recurrence || scope === 'all') return null;
  if (scope === 'this') {
    return { ...item, exceptions: { ...item.exceptions, [originalDate]: { cancelled: true } }, updatedAt: nowIso };
  }
  if (!item.date || originalDate <= item.date) return null;
  const before = countBefore(item, originalDate);
  return {
    ...item,
    recurrence: { ...item.recurrence, until: addDays(originalDate, -1), count: item.recurrence.count ? before : undefined },
    exceptions: Object.fromEntries(Object.entries(item.exceptions).filter(([d]) => d < originalDate)),
    updatedAt: nowIso,
  };
}

export function describeRecurrence(r: AgendaItem['recurrence']): string {
  if (!r) return 'Não se repete';
  const every = r.interval === 1 ? '' : ` a cada ${r.interval}`;
  let base: string;
  if (r.freq === 'daily') base = r.interval === 1 ? 'Todos os dias' : `A cada ${r.interval} dias`;
  else {
    const names = ['seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom'];
    const days = (r.byWeekday ?? []).slice().sort((a, b) => a - b).map((d) => names[d - 1]);
    base = `Semanal${every ? `${every} semanas` : ''}: ${days.join(', ')}`;
  }
  if (r.until) {
    const [y, m, d] = r.until.split('-');
    base += `, até ${d}/${m}/${y}`;
  }
  if (r.count) base += `, ${r.count} vez${r.count === 1 ? '' : 'es'}`;
  return base;
}

export function isHabitScheduledOn(habit: Habit, date: CivilDate): boolean {
  return habit.status !== 'archived' && isScheduledOn(habit, date);
}
