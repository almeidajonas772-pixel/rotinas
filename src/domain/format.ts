import { isoWeekday, parseCivil, type CivilDate } from './civil';

/** Formatação em pt-BR. Datas civis são formatadas sem conversão de fuso (são datas locais por definição). */

const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const MONTHS_SHORT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const WEEKDAYS = ['segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado', 'domingo'];
const WEEKDAYS_SHORT = ['seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom'];

export function monthName(m: number): string {
  return MONTHS[m - 1];
}

export function monthShort(m: number): string {
  return MONTHS_SHORT[m - 1];
}

export function weekdayName(date: CivilDate): string {
  return WEEKDAYS[isoWeekday(date) - 1];
}

export function weekdayShort(date: CivilDate): string {
  return WEEKDAYS_SHORT[isoWeekday(date) - 1];
}

/** "17/10" */
export function formatShortDate(date: CivilDate): string {
  const { m, d } = parseCivil(date);
  return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}`;
}

/** "17/10/2026" */
export function formatDate(date: CivilDate): string {
  const { y, m, d } = parseCivil(date);
  return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;
}

/** "sábado, 17 de outubro" */
export function formatLongDate(date: CivilDate, withYear = false): string {
  const { y, m, d } = parseCivil(date);
  return `${weekdayName(date)}, ${d} de ${monthName(m)}${withYear ? ` de ${y}` : ''}`;
}

/** "17 de outubro de 2026" */
export function formatDayMonthYear(date: CivilDate): string {
  const { y, m, d } = parseCivil(date);
  return `${d} de ${monthName(m)} de ${y}`;
}

/** "outubro de 2026" */
export function formatMonthYear(date: CivilDate): string {
  const { y, m } = parseCivil(date);
  return `${monthName(m)} de ${y}`;
}

export function formatRange(from: CivilDate, to: CivilDate): string {
  if (from === to) return formatDate(from);
  const a = parseCivil(from);
  const b = parseCivil(to);
  if (a.y === b.y) return `${formatShortDate(from)} a ${formatShortDate(to)}/${b.y}`;
  return `${formatDate(from)} a ${formatDate(to)}`;
}

/** Instante → "17/10/2026 às 14:32" no fuso informado. */
export function formatInstant(instant: string | Date, timeZone: string): string {
  const d = typeof instant === 'string' ? new Date(instant) : instant;
  const date = new Intl.DateTimeFormat('pt-BR', { timeZone, day: '2-digit', month: '2-digit', year: 'numeric' }).format(d);
  const time = new Intl.DateTimeFormat('pt-BR', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  return `${date} às ${time}`;
}

export function formatTimeOfInstant(instant: string | Date, timeZone: string): string {
  const d = typeof instant === 'string' ? new Date(instant) : instant;
  return new Intl.DateTimeFormat('pt-BR', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
}

export function formatNumber(n: number, maxFraction = 1): string {
  return new Intl.NumberFormat('pt-BR', { maximumFractionDigits: maxFraction }).format(n);
}

export function plural(n: number, singular: string, pluralForm: string): string {
  return `${formatNumber(n, 0)} ${n === 1 ? singular : pluralForm}`;
}

export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}
