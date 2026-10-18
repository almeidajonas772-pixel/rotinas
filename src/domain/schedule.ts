import { addDays, eachDay, isoWeekday, maxCivil, type CivilDate, type IsoWeekday } from './civil';
import type { Habit, HabitSchedule, HabitTiming } from './schemas';

/**
 * Agenda de um hábito = definição (frequência versionada) − pausas.
 * Uma ocorrência prevista existe na data D quando:
 *  1. D é igual ou posterior ao início do hábito (primeira versão da frequência);
 *  2. a versão da frequência vigente em D inclui D (todos os dias ou dia da semana escolhido);
 *  3. D não está dentro de uma pausa/arquivamento.
 */

type ScheduledHabit = Pick<Habit, 'scheduleHistory' | 'pauses'>;

export const WEEKDAY_SHORT: Record<IsoWeekday, string> = {
  1: 'seg',
  2: 'ter',
  3: 'qua',
  4: 'qui',
  5: 'sex',
  6: 'sáb',
  7: 'dom',
};

export const WEEKDAY_LONG: Record<IsoWeekday, string> = {
  1: 'segunda-feira',
  2: 'terça-feira',
  3: 'quarta-feira',
  4: 'quinta-feira',
  5: 'sexta-feira',
  6: 'sábado',
  7: 'domingo',
};

export function habitStartDate(habit: Pick<Habit, 'scheduleHistory'>): CivilDate {
  return habit.scheduleHistory[0].from;
}

export function scheduleOn(habit: Pick<Habit, 'scheduleHistory'>, date: CivilDate): HabitSchedule | null {
  let current: HabitSchedule | null = null;
  for (const version of habit.scheduleHistory) {
    if (version.from <= date) current = version.schedule;
    else break;
  }
  return current;
}

export function isPausedOn(habit: Pick<Habit, 'pauses'>, date: CivilDate): boolean {
  return habit.pauses.some((p) => p.from <= date && (p.to === undefined || date <= p.to));
}

export function scheduleMatches(schedule: HabitSchedule, date: CivilDate): boolean {
  if (schedule.kind === 'daily') return true;
  return schedule.days.includes(isoWeekday(date));
}

export function isScheduledOn(habit: ScheduledHabit, date: CivilDate): boolean {
  const schedule = scheduleOn(habit, date);
  return schedule !== null && !isPausedOn(habit, date) && scheduleMatches(schedule, date);
}

/** Datas com ocorrência prevista entre `from` e `to` (inclusive). */
export function occurrencesBetween(habit: ScheduledHabit, from: CivilDate, to: CivilDate): CivilDate[] {
  const start = maxCivil(from, habitStartDate(habit));
  if (start > to) return [];
  return eachDay(start, to).filter((d) => isScheduledOn(habit, d));
}

export function currentSchedule(habit: Pick<Habit, 'scheduleHistory'>): HabitSchedule {
  return habit.scheduleHistory[habit.scheduleHistory.length - 1].schedule;
}

export function sameSchedule(a: HabitSchedule, b: HabitSchedule): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'weekly' && b.kind === 'weekly') {
    return a.days.length === b.days.length && a.days.every((d, i) => d === b.days[i]);
  }
  return true;
}

/**
 * Registra uma nova frequência a partir de `effectiveFrom`, preservando as versões
 * anteriores — assim métricas de dias passados não mudam retroativamente.
 */
export function withScheduleChange(
  history: Habit['scheduleHistory'],
  schedule: HabitSchedule,
  effectiveFrom: CivilDate,
): Habit['scheduleHistory'] {
  const effective = scheduleOn({ scheduleHistory: history }, effectiveFrom);
  if (effective && sameSchedule(effective, schedule)) {
    // Nenhuma mudança na data efetiva; descarta versões futuras que divergiam.
    return history.filter((v) => v.from <= effectiveFrom);
  }
  if (effectiveFrom <= history[0].from) {
    // Hábito ainda não começou: a nova frequência substitui tudo, mantendo a data de início.
    return [{ from: history[0].from, schedule }];
  }
  const kept = history.filter((v) => v.from < effectiveFrom);
  return [...kept, { from: effectiveFrom, schedule }];
}

/** Abre uma pausa a partir de `from` (inclusive). Ignora se já houver pausa aberta. */
export function withPauseStarted(pauses: Habit['pauses'], from: CivilDate): Habit['pauses'] {
  if (pauses.some((p) => p.to === undefined)) return pauses;
  return [...pauses, { from }];
}

/** Fecha a pausa aberta: ocorrências voltam a existir a partir de `resumeOn`. */
export function withPauseEnded(pauses: Habit['pauses'], resumeOn: CivilDate): Habit['pauses'] {
  const out: Habit['pauses'] = [];
  for (const p of pauses) {
    if (p.to !== undefined) {
      out.push(p);
      continue;
    }
    const to = addDays(resumeOn, -1);
    if (to >= p.from) out.push({ from: p.from, to });
    // Pausa iniciada e encerrada no mesmo dia não deixa rastro.
  }
  return out;
}

export function describeSchedule(schedule: HabitSchedule): string {
  if (schedule.kind === 'daily') return 'Todos os dias';
  const days = schedule.days as IsoWeekday[];
  if (days.length === 7) return 'Todos os dias';
  if (days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d as IsoWeekday))) return 'Dias úteis (seg a sex)';
  if (days.length === 2 && days.includes(6) && days.includes(7)) return 'Fins de semana';
  const labels = days.map((d) => WEEKDAY_SHORT[d]);
  if (labels.length === 1) {
    const day = days[0];
    return `${day === 6 || day === 7 ? 'Todo' : 'Toda'} ${WEEKDAY_LONG[day]}`;
  }
  return `${labels.slice(0, -1).join(', ')} e ${labels[labels.length - 1]}`;
}

export function describeTiming(timing: HabitTiming): string {
  switch (timing.kind) {
    case 'anytime':
      return 'Qualquer horário';
    case 'time':
      return `Às ${timing.time}`;
    case 'window':
      return `Entre ${timing.start} e ${timing.end}`;
  }
}

/** Minuto do dia usado para ordenar hábitos na tela Hoje (sem horário vai para o fim). */
export function timingSortKey(timing: HabitTiming): number {
  if (timing.kind === 'time') return Number(timing.time.slice(0, 2)) * 60 + Number(timing.time.slice(3));
  if (timing.kind === 'window') return Number(timing.start.slice(0, 2)) * 60 + Number(timing.start.slice(3));
  return 24 * 60 + 1;
}
