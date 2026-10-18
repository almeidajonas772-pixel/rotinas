/**
 * Datas civis ("data local" do usuário) representadas como strings `YYYY-MM-DD`.
 *
 * Toda a lógica de recorrência, streak e métricas opera sobre datas civis, que
 * não carregam fuso horário. Assim, horário de verão ou troca de timezone nunca
 * deslocam o dia em que uma ocorrência foi prevista ou concluída. O fuso só é
 * usado para descobrir "que dia é hoje" e para converter horários de agenda.
 */

export type CivilDate = string;
export type LocalTime = string;
/** Dia da semana ISO: 1 = segunda … 7 = domingo. */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;
/** Primeiro dia da semana para períodos semanais: 0 = domingo, 1 = segunda. */
export type WeekStart = 0 | 1;

const CIVIL_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_MS = 86_400_000;

export function isCivilDate(value: unknown): value is CivilDate {
  if (typeof value !== 'string') return false;
  const m = CIVIL_RE.exec(value);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || y < 1900 || y > 2200) return false;
  return d <= daysInMonth(y, mo);
}

export function isLocalTime(value: unknown): value is LocalTime {
  return typeof value === 'string' && TIME_RE.test(value);
}

export function parseCivil(date: CivilDate): { y: number; m: number; d: number } {
  const m = CIVIL_RE.exec(date);
  if (!m) throw new Error(`Data civil inválida: ${date}`);
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

export function civilFromParts(y: number, m: number, d: number): CivilDate {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function toEpochDay(date: CivilDate): number {
  const { y, m, d } = parseCivil(date);
  return Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
}

export function fromEpochDay(day: number): CivilDate {
  const dt = new Date(day * DAY_MS);
  return civilFromParts(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

export function addDays(date: CivilDate, n: number): CivilDate {
  return fromEpochDay(toEpochDay(date) + n);
}

/** Diferença em dias: `a - b`. */
export function diffDays(a: CivilDate, b: CivilDate): number {
  return toEpochDay(a) - toEpochDay(b);
}

export function compareCivil(a: CivilDate, b: CivilDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function minCivil(a: CivilDate, b: CivilDate): CivilDate {
  return a <= b ? a : b;
}

export function maxCivil(a: CivilDate, b: CivilDate): CivilDate {
  return a >= b ? a : b;
}

export function isoWeekday(date: CivilDate): IsoWeekday {
  const day = new Date(toEpochDay(date) * DAY_MS).getUTCDay();
  return (day === 0 ? 7 : day) as IsoWeekday;
}

export function startOfWeek(date: CivilDate, weekStartsOn: WeekStart): CivilDate {
  const wd = isoWeekday(date);
  const first = weekStartsOn === 1 ? 1 : 7;
  const offset = (wd - first + 7) % 7;
  return addDays(date, -offset);
}

export function endOfWeek(date: CivilDate, weekStartsOn: WeekStart): CivilDate {
  return addDays(startOfWeek(date, weekStartsOn), 6);
}

export function startOfMonth(date: CivilDate): CivilDate {
  const { y, m } = parseCivil(date);
  return civilFromParts(y, m, 1);
}

export function endOfMonth(date: CivilDate): CivilDate {
  const { y, m } = parseCivil(date);
  return civilFromParts(y, m, daysInMonth(y, m));
}

export function startOfYear(date: CivilDate): CivilDate {
  return civilFromParts(parseCivil(date).y, 1, 1);
}

export function endOfYear(date: CivilDate): CivilDate {
  return civilFromParts(parseCivil(date).y, 12, 31);
}

export function addMonths(date: CivilDate, n: number): CivilDate {
  const { y, m, d } = parseCivil(date);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return civilFromParts(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

/** Todos os dias entre `from` e `to`, inclusive. Retorna lista vazia se `from > to`. */
export function eachDay(from: CivilDate, to: CivilDate): CivilDate[] {
  const out: CivilDate[] = [];
  const start = toEpochDay(from);
  const end = toEpochDay(to);
  for (let n = start; n <= end; n++) out.push(fromEpochDay(n));
  return out;
}

export function isBetween(date: CivilDate, from: CivilDate, to: CivilDate): boolean {
  return date >= from && date <= to;
}

export function rangesOverlap(aStart: CivilDate, aEnd: CivilDate, bStart: CivilDate, bEnd: CivilDate): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

export function timeToMinutes(time: LocalTime): number {
  const m = TIME_RE.exec(time);
  if (!m) throw new Error(`Horário inválido: ${time}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

export function minutesToTime(total: number): LocalTime {
  const clamped = Math.max(0, Math.min(24 * 60 - 1, Math.round(total)));
  return `${String(Math.floor(clamped / 60)).padStart(2, '0')}:${String(clamped % 60).padStart(2, '0')}`;
}

function partsInZone(timeZone: string, now: Date): Record<string, string> {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const out: Record<string, string> = {};
  for (const part of fmt.formatToParts(now)) out[part.type] = part.value;
  return out;
}

/** Data civil de "agora" no fuso informado. */
export function todayInZone(timeZone: string, now: Date = new Date()): CivilDate {
  const p = partsInZone(timeZone, now);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Horário local (HH:mm) de "agora" no fuso informado. */
export function nowTimeInZone(timeZone: string, now: Date = new Date()): LocalTime {
  const p = partsInZone(timeZone, now);
  const hour = p.hour === '24' ? '00' : p.hour;
  return `${hour}:${p.minute}`;
}
