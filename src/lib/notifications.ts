import { useEffect, useState } from 'react';
import { db } from '../db/db';
import { logNotification, notificationsSentOn, pruneNotificationLog } from '../db/repo-misc';
import { addDays, todayInZone } from '../domain/civil';
import { dueReminders } from '../domain/notifications-plan';
import type { Preferences, Profile } from '../domain/schemas';

/**
 * Lembretes locais: o navegador mostra a notificação, sem servidor de push. Por isso eles só
 * disparam enquanto o app estiver aberto (aba ou PWA em execução). Nada sai do aparelho.
 */

export type PermissionState = 'granted' | 'denied' | 'default' | 'unsupported';

export function notificationPermission(): PermissionState {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  return Notification.permission as PermissionState;
}

export async function requestNotificationPermission(): Promise<PermissionState> {
  if (notificationPermission() === 'unsupported') return 'unsupported';
  try {
    return (await Notification.requestPermission()) as PermissionState;
  } catch {
    return notificationPermission();
  }
}

export function useNotificationPermission(): [PermissionState, () => Promise<PermissionState>] {
  const [state, setState] = useState<PermissionState>(() => notificationPermission());
  useEffect(() => {
    const update = () => setState(notificationPermission());
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  const request = async () => {
    const result = await requestNotificationPermission();
    setState(result);
    return result;
  };
  return [state, request];
}

export async function showLocalNotification(title: string, body: string, tag: string): Promise<boolean> {
  if (notificationPermission() !== 'granted') return false;
  try {
    const registration = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
    if (registration) {
      await registration.showNotification(title, { body, tag, icon: '/pwa-192x192.png', badge: '/pwa-64x64.png', data: { url: '/#/' } });
      return true;
    }
    new Notification(title, { body, tag, icon: '/pwa-192x192.png' });
    return true;
  } catch {
    return false;
  }
}

const TICK_MS = 60_000;

/** Verifica lembretes a cada minuto e quando o app volta ao primeiro plano. */
export function useReminderScheduler(profile: Profile | null | undefined, prefs: Preferences | undefined): void {
  useEffect(() => {
    if (!profile || !prefs) return;
    if (prefs.notifications.channel !== 'local' || !prefs.consents.notifications.granted) return;
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        const permission = notificationPermission();
        if (permission !== 'granted') return;
        const now = new Date();
        const today = todayInZone(profile.timezone, now);
        const [habits, records, sent] = await Promise.all([
          db.habits.where('status').equals('active').toArray(),
          db.completions.where('scheduledDate').equals(today).toArray(),
          notificationsSentOn(today),
        ]);
        const due = dueReminders({
          now,
          timeZone: profile.timezone,
          prefs,
          permission,
          habits,
          recordedToday: new Set(records.map((r) => r.habitId)),
          sentToday: sent,
        });
        for (const reminder of due) {
          const shown = await showLocalNotification(reminder.title, reminder.body, reminder.id);
          if (shown) await logNotification(reminder.id, reminder.habitId, reminder.date);
        }
        await pruneNotificationLog(addDays(today, -14));
      } catch (error) {
        console.warn('Falha ao verificar lembretes:', error);
      } finally {
        running = false;
      }
    };
    void tick();
    const timer = window.setInterval(tick, TICK_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [profile, prefs]);
}
