import { isoWeekday, nowTimeInZone, timeToMinutes, todayInZone, type CivilDate, type LocalTime } from './civil';
import type { Habit, Preferences } from './schemas';
import { isScheduledOn } from './schedule';

/**
 * Decide quais lembretes locais disparar agora. Função pura (testável):
 * - só com canal "local", consentimento ativo e permissão do navegador concedida;
 * - só em dias permitidos e fora da janela silenciosa;
 * - só hábitos ativos, com lembrete ligado, previstos hoje e ainda sem registro;
 * - dispara dentro de uma tolerância após o horário (o app precisa estar aberto);
 * - nunca repete o mesmo lembrete no dia e respeita o limite diário.
 */

export const REMINDER_GRACE_MINUTES = 30;

export interface DueReminder {
  id: string;
  habitId: string;
  date: CivilDate;
  title: string;
  body: string;
}

export function isInQuietHours(time: LocalTime, quietStart: LocalTime, quietEnd: LocalTime): boolean {
  const t = timeToMinutes(time);
  const s = timeToMinutes(quietStart);
  const e = timeToMinutes(quietEnd);
  if (s === e) return false;
  return s < e ? t >= s && t < e : t >= s || t < e;
}

export function reminderLogId(habitId: string, date: CivilDate): string {
  return `habit_reminder|${habitId}|${date}`;
}

export function dueReminders(input: {
  now: Date;
  timeZone: string;
  prefs: Pick<Preferences, 'notifications' | 'consents'>;
  permission: 'granted' | 'denied' | 'default' | 'unsupported';
  habits: readonly Habit[];
  /** Hábitos com registro (concluído ou pulado) hoje. */
  recordedToday: ReadonlySet<string>;
  /** Ids de lembretes já enviados hoje. */
  sentToday: ReadonlySet<string>;
}): DueReminder[] {
  const { prefs } = input;
  if (prefs.notifications.channel !== 'local') return [];
  if (!prefs.consents.notifications.granted) return [];
  if (input.permission !== 'granted') return [];
  const today = todayInZone(input.timeZone, input.now);
  if (!prefs.notifications.allowedDays.includes(isoWeekday(today))) return [];
  const nowTime = nowTimeInZone(input.timeZone, input.now);
  if (isInQuietHours(nowTime, prefs.notifications.quietStart, prefs.notifications.quietEnd)) return [];
  const remaining = prefs.notifications.maxPerDay - input.sentToday.size;
  if (remaining <= 0) return [];
  const nowMin = timeToMinutes(nowTime);
  const due: DueReminder[] = [];
  const candidates = input.habits
    .filter((h) => h.status === 'active' && h.reminder.enabled && h.reminder.time)
    .sort((a, b) => (a.reminder.time! < b.reminder.time! ? -1 : 1));
  for (const habit of candidates) {
    const at = timeToMinutes(habit.reminder.time!);
    if (nowMin < at || nowMin >= at + REMINDER_GRACE_MINUTES) continue;
    if (!isScheduledOn(habit, today)) continue;
    if (input.recordedToday.has(habit.id)) continue;
    const id = reminderLogId(habit.id, today);
    if (input.sentToday.has(id)) continue;
    due.push({
      id,
      habitId: habit.id,
      date: today,
      title: habit.title,
      body: habit.firstStep ? `Primeiro passo: ${habit.firstStep}` : 'Previsto para agora. Marque no Rotinas quando concluir.',
    });
    if (due.length >= remaining) break;
  }
  return due;
}
