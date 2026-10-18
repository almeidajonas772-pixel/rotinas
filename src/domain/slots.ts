import { isoWeekday, minutesToTime, timeToMinutes, type CivilDate, type LocalTime } from './civil';
import type { Availability, DayPeriod } from './schemas';
import { wallTimeToInstant } from './tz';

/**
 * Proposta de blocos de tempo (determinística, sem IA): encontra o primeiro intervalo livre
 * de cada dia dentro das janelas permitidas, respeitando compromissos já existentes na agenda
 * do app e, se a pessoa conectou, períodos ocupados do Google Calendar. Nada é gravado aqui:
 * o resultado é só uma prévia para a pessoa revisar e confirmar.
 */

export interface BusyInterval {
  start: string; // ISO
  end: string; // ISO
  source: 'rotinas' | 'google';
  label?: string;
}

export interface TimeWindow {
  start: LocalTime;
  end: LocalTime;
}

export interface SlotProposal {
  date: CivilDate;
  start: LocalTime;
  end: LocalTime;
  durationMinutes: number;
  conflicts: BusyInterval[];
  /** Sem espaço livre na janela: a proposta mostra o primeiro horário possível e os conflitos. */
  hasFreeSlot: boolean;
}

export const PERIOD_WINDOWS: Record<DayPeriod, TimeWindow> = {
  manha: { start: '06:00', end: '12:00' },
  tarde: { start: '12:00', end: '18:00' },
  noite: { start: '18:00', end: '22:30' },
};

/** Janelas do dia: janelas exatas configuradas para o dia da semana, senão os períodos livres, senão 07:00–22:00. */
export function windowsForDate(date: CivilDate, availability: Availability | undefined, preferred?: TimeWindow): TimeWindow[] {
  if (preferred) return [preferred];
  const wd = isoWeekday(date);
  const exact = (availability?.windows ?? []).filter((w) => w.weekdays.includes(wd)).map((w) => ({ start: w.start, end: w.end }));
  if (exact.length > 0) return exact.sort((a, b) => (a.start < b.start ? -1 : 1));
  const periods = availability?.periods ?? [];
  if (periods.length > 0) {
    const order: DayPeriod[] = ['manha', 'tarde', 'noite'];
    return order.filter((p) => periods.includes(p)).map((p) => PERIOD_WINDOWS[p]);
  }
  return [{ start: '07:00', end: '22:00' }];
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

export function conflictsFor(date: CivilDate, start: LocalTime, end: LocalTime, timeZone: string, busy: readonly BusyInterval[]): BusyInterval[] {
  const s = wallTimeToInstant(date, start, timeZone).getTime();
  const e = wallTimeToInstant(date, end, timeZone).getTime();
  return busy.filter((b) => overlaps(s, e, Date.parse(b.start), Date.parse(b.end)));
}

export function proposeSlots(input: {
  dates: readonly CivilDate[];
  durationMinutes: number;
  timeZone: string;
  availability?: Availability;
  preferredWindow?: TimeWindow;
  busy: readonly BusyInterval[];
  now: Date;
  stepMinutes?: number;
}): SlotProposal[] {
  const step = input.stepMinutes ?? 15;
  const duration = Math.max(5, Math.min(600, Math.round(input.durationMinutes)));
  const out: SlotProposal[] = [];
  for (const date of input.dates) {
    const windows = windowsForDate(date, input.availability, input.preferredWindow);
    let chosen: SlotProposal | null = null;
    let fallback: SlotProposal | null = null;
    for (const w of windows) {
      const ws = timeToMinutes(w.start);
      const we = timeToMinutes(w.end);
      for (let m = Math.ceil(ws / step) * step; m + duration <= we; m += step) {
        const start = minutesToTime(m);
        const end = minutesToTime(m + duration);
        if (wallTimeToInstant(date, start, input.timeZone).getTime() < input.now.getTime()) continue;
        const conflicts = conflictsFor(date, start, end, input.timeZone, input.busy);
        const proposal: SlotProposal = { date, start, end, durationMinutes: duration, conflicts, hasFreeSlot: conflicts.length === 0 };
        if (conflicts.length === 0) {
          chosen = proposal;
          break;
        }
        if (!fallback) fallback = proposal;
      }
      if (chosen) break;
    }
    const pick = chosen ?? fallback;
    if (pick) out.push(pick);
  }
  return out;
}
