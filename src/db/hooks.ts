import { useLiveQuery } from 'dexie-react-hooks';
import type { CivilDate } from '../domain/civil';
import type {
  AgendaCompletion,
  AgendaItem,
  Checkin,
  Goal,
  GoalProgressEntry,
  Habit,
  HabitCompletion,
  Integration,
  JournalEntry,
  KaiConversation,
  KaiInsight,
  Preferences,
  Profile,
  ProgressEvent,
} from '../domain/schemas';
import { db } from './db';
import { defaultPreferences } from './defaults';

/**
 * Consultas reativas ao IndexedDB. `undefined` significa "carregando"; listas vazias e
 * `null` significam que não há dados. Toda tela distingue esses estados.
 */

export function useProfile(): Profile | null | undefined {
  return useLiveQuery(async () => (await db.profile.get('me')) ?? null, []);
}

export function usePrefs(): Preferences | undefined {
  return useLiveQuery(async () => (await db.prefs.get('prefs')) ?? defaultPreferences(new Date(0).toISOString()), []);
}

export function useHabits(): Habit[] | undefined {
  return useLiveQuery(() => db.habits.orderBy('order').toArray(), []);
}

export function useHabit(id: string | undefined): Habit | null | undefined {
  return useLiveQuery(async () => (id ? ((await db.habits.get(id)) ?? null) : null), [id]);
}

export function useCompletions(): HabitCompletion[] | undefined {
  return useLiveQuery(() => db.completions.toArray(), []);
}

export function useCompletionsBetween(from: CivilDate, to: CivilDate): HabitCompletion[] | undefined {
  return useLiveQuery(() => db.completions.where('scheduledDate').between(from, to, true, true).toArray(), [from, to]);
}

export function useHabitCompletions(habitId: string | undefined): HabitCompletion[] | undefined {
  return useLiveQuery(async () => (habitId ? db.completions.where('habitId').equals(habitId).toArray() : []), [habitId]);
}

export function useAgendaItems(): AgendaItem[] | undefined {
  return useLiveQuery(() => db.agendaItems.toArray(), []);
}

export function useAgendaCompletions(): AgendaCompletion[] | undefined {
  return useLiveQuery(() => db.agendaCompletions.toArray(), []);
}

export function useGoals(): Goal[] | undefined {
  return useLiveQuery(() => db.goals.toArray(), []);
}

export function useGoalProgressEntries(): GoalProgressEntry[] | undefined {
  return useLiveQuery(() => db.goalProgress.toArray(), []);
}

export function useCheckins(): Checkin[] | undefined {
  return useLiveQuery(() => db.checkins.toArray(), []);
}

export function useCheckin(date: CivilDate): Checkin | null | undefined {
  return useLiveQuery(async () => (await db.checkins.get(date)) ?? null, [date]);
}

export function useJournal(): JournalEntry[] | undefined {
  return useLiveQuery(() => db.journal.orderBy('date').reverse().toArray(), []);
}

export function useJournalEntry(date: CivilDate): JournalEntry | null | undefined {
  return useLiveQuery(async () => (await db.journal.where('date').equals(date).first()) ?? null, [date]);
}

export function useProgressEvents(): ProgressEvent[] | undefined {
  return useLiveQuery(() => db.progressEvents.toArray(), []);
}

export function useKaiInsights(): KaiInsight[] | undefined {
  return useLiveQuery(() => db.kaiInsights.orderBy('createdAt').reverse().toArray(), []);
}

export function useKaiConversations(): KaiConversation[] | undefined {
  return useLiveQuery(() => db.kaiConversations.orderBy('updatedAt').reverse().toArray(), []);
}

export function useIntegration(): Integration | null | undefined {
  return useLiveQuery(async () => (await db.integrations.get('google_calendar')) ?? null, []);
}
