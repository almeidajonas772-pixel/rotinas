import { DateTime, IANAZone } from 'luxon';
import type { CivilDate, LocalTime } from './civil';

/**
 * Conversões entre "horário de parede" (data + hora em um fuso) e instantes UTC.
 * Usadas apenas para itens com horário (agenda, lembretes, blocos de tempo).
 * Em horários inexistentes por causa do horário de verão (ex.: 02:30 no dia em
 * que o relógio pula de 02:00 para 03:00), o Luxon avança para o primeiro
 * horário válido; em horários ambíguos (relógio volta), usa a primeira ocorrência.
 */

export const DEFAULT_TIME_ZONE = 'America/Sao_Paulo';

export function isValidTimeZone(tz: string): boolean {
  return typeof tz === 'string' && tz.length > 0 && IANAZone.isValidZone(tz);
}

export function guessTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && isValidTimeZone(tz)) return tz;
  } catch {
    // ignore
  }
  return DEFAULT_TIME_ZONE;
}

const FALLBACK_ZONES = [
  'America/Sao_Paulo',
  'America/Manaus',
  'America/Belem',
  'America/Fortaleza',
  'America/Recife',
  'America/Bahia',
  'America/Cuiaba',
  'America/Porto_Velho',
  'America/Rio_Branco',
  'America/Noronha',
  'America/New_York',
  'America/Los_Angeles',
  'Europe/Lisbon',
  'Europe/London',
  'Europe/Madrid',
  'Asia/Tokyo',
  'UTC',
];

export function listTimeZones(): string[] {
  try {
    const supported = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone');
    if (supported && supported.length > 0) {
      return supported.includes('UTC') ? supported : [...supported, 'UTC'];
    }
  } catch {
    // ignore
  }
  return FALLBACK_ZONES;
}

export function wallTimeToInstant(date: CivilDate, time: LocalTime, timeZone: string): Date {
  const dt = DateTime.fromISO(`${date}T${time}`, { zone: timeZone });
  if (!dt.isValid) throw new Error(`Data/hora inválida: ${date} ${time} (${timeZone})`);
  return dt.toJSDate();
}

export function instantToWallTime(instant: Date | string | number, timeZone: string): { date: CivilDate; time: LocalTime } {
  const base = typeof instant === 'string' ? DateTime.fromISO(instant) : DateTime.fromJSDate(new Date(instant));
  const dt = base.setZone(timeZone);
  return { date: dt.toFormat('yyyy-MM-dd'), time: dt.toFormat('HH:mm') };
}

/** Converte um horário de parede de um fuso para outro (ex.: evento criado em São Paulo visto em Lisboa). */
export function convertWallTime(
  date: CivilDate,
  time: LocalTime,
  fromZone: string,
  toZone: string,
): { date: CivilDate; time: LocalTime } {
  if (fromZone === toZone) return { date, time };
  return instantToWallTime(wallTimeToInstant(date, time, fromZone), toZone);
}

/** Milissegundos até a próxima meia-noite local no fuso informado. */
export function msUntilNextMidnight(timeZone: string, now: Date = new Date()): number {
  const dt = DateTime.fromJSDate(now).setZone(timeZone);
  const next = dt.plus({ days: 1 }).startOf('day');
  return Math.max(1000, next.toMillis() - dt.toMillis());
}

export function zoneOffsetLabel(timeZone: string, at: Date = new Date()): string {
  const dt = DateTime.fromJSDate(at).setZone(timeZone);
  return `UTC${dt.toFormat('ZZ')}`;
}
