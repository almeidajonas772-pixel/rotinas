import type { AgendaDraft } from '../../db/repo-agenda';
import { isCivilDate, isLocalTime, isoWeekday, type CivilDate } from '../../domain/civil';
import type { AgendaItem, Habit, Recurrence } from '../../domain/schemas';

/** Modelo do formulário de itens da agenda (sem componentes, para testes e reaproveitamento). */

export interface EditorDraft {
  kind: AgendaDraft['kind'];
  title: string;
  notes: string;
  hasDate: boolean;
  date: CivilDate;
  allDay: boolean;
  startTime: string;
  endTime: string;
  repeat: 'none' | 'daily' | 'weekly';
  interval: number;
  byWeekday: number[];
  ends: 'never' | 'until' | 'count';
  until: CivilDate;
  count: number;
  habitId: string;
  goalId: string;
  category: string;
  xp: number;
}

export function emptyEditorDraft(date: CivilDate, kind: AgendaDraft['kind'] = 'task'): EditorDraft {
  return {
    kind,
    title: '',
    notes: '',
    hasDate: true,
    date,
    allDay: kind === 'task',
    startTime: '09:00',
    endTime: '10:00',
    repeat: 'none',
    interval: 1,
    byWeekday: [isoWeekday(date)],
    ends: 'never',
    until: date,
    count: 10,
    habitId: '',
    goalId: '',
    category: '',
    xp: kind === 'task' ? 5 : 0,
  };
}

export function editorDraftFromItem(
  item: AgendaItem,
  today: CivilDate,
  occurrence?: { date: CivilDate; title: string; startTime?: string; endTime?: string },
): EditorDraft {
  const r = item.recurrence;
  const date = occurrence?.date ?? item.date ?? '';
  return {
    kind: item.kind,
    title: occurrence?.title ?? item.title,
    notes: item.notes ?? '',
    hasDate: Boolean(item.date),
    date: date || today,
    allDay: item.allDay,
    startTime: occurrence?.startTime ?? item.startTime ?? '09:00',
    endTime: occurrence?.endTime ?? item.endTime ?? '',
    repeat: r ? r.freq : 'none',
    interval: r?.interval ?? 1,
    byWeekday: r?.byWeekday ?? (item.date ? [isoWeekday(item.date)] : [1]),
    ends: r?.until ? 'until' : r?.count ? 'count' : 'never',
    until: r?.until ?? item.date ?? '',
    count: r?.count ?? 10,
    habitId: item.habitId ?? '',
    goalId: item.goalId ?? '',
    category: item.category ?? '',
    xp: item.xp,
  };
}

export function validateEditorDraft(d: EditorDraft): Record<string, string> {
  const e: Record<string, string> = {};
  if (d.kind === 'habit' && !d.habitId) e.habitId = 'Escolha o hábito';
  if (d.kind !== 'habit' && !d.title.trim()) e.title = 'Dê um título';
  if (d.title.length > 120) e.title = 'Use no máximo 120 caracteres';
  const needsDate = d.kind !== 'task' || d.hasDate;
  if (needsDate && !isCivilDate(d.date)) e.date = 'Informe a data';
  if (needsDate && !d.allDay) {
    if (!isLocalTime(d.startTime)) e.startTime = 'Informe o início';
    if (d.endTime && !isLocalTime(d.endTime)) e.endTime = 'Horário inválido';
    else if (d.endTime && d.endTime <= d.startTime) e.endTime = 'O fim precisa ser depois do início (no mesmo dia)';
  }
  if (needsDate && d.repeat !== 'none') {
    if (!Number.isInteger(d.interval) || d.interval < 1 || d.interval > 52) e.interval = 'Use um intervalo entre 1 e 52';
    if (d.repeat === 'weekly' && d.byWeekday.length === 0) e.byWeekday = 'Escolha ao menos um dia';
    if (d.ends === 'until' && (!isCivilDate(d.until) || d.until < d.date)) e.until = 'A data final precisa ser depois do início';
    if (d.ends === 'count' && (!Number.isInteger(d.count) || d.count < 1 || d.count > 1000)) e.count = 'Use entre 1 e 1000 vezes';
  }
  if (d.kind === 'task' && (d.xp < 0 || d.xp > 100)) e.xp = 'Use entre 0 e 100';
  return e;
}

export function toAgendaDraft(d: EditorDraft, habits: readonly Habit[]): AgendaDraft {
  const needsDate = d.kind !== 'task' || d.hasDate;
  let recurrence: Recurrence | undefined;
  if (needsDate && d.repeat !== 'none') {
    recurrence = {
      freq: d.repeat,
      interval: d.interval,
      byWeekday: d.repeat === 'weekly' ? [...d.byWeekday].sort((a, b) => a - b) : undefined,
      until: d.ends === 'until' ? d.until : undefined,
      count: d.ends === 'count' ? d.count : undefined,
    };
  }
  const habit = habits.find((h) => h.id === d.habitId);
  return {
    kind: d.kind,
    title: d.kind === 'habit' ? habit?.title ?? d.title : d.title,
    notes: d.notes,
    date: needsDate ? d.date : undefined,
    allDay: needsDate ? d.allDay : true,
    startTime: needsDate && !d.allDay ? d.startTime : undefined,
    endTime: needsDate && !d.allDay && d.endTime ? d.endTime : undefined,
    recurrence,
    habitId: d.kind === 'habit' ? d.habitId : undefined,
    goalId: d.goalId || undefined,
    category: d.category || undefined,
    xp: d.kind === 'task' ? d.xp : 0,
  };
}
