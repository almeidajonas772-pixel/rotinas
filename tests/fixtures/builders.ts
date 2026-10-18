/**
 * Construtores de dados SOMENTE para testes. Nada aqui é importado pelo app:
 * uma instalação nova do Rotinas nunca contém hábitos, conclusões ou metas de exemplo.
 */
import type {
  AgendaItem,
  Checkin,
  Goal,
  Habit,
  HabitCompletion,
  JournalEntry,
  Preferences,
  Profile,
} from '../../src/domain/schemas';
import { defaultPreferences, newProfile } from '../../src/db/defaults';

const NOW = '2026-10-17T12:00:00.000Z';

export function testHabit(overrides: Partial<Habit> & { id: string }): Habit {
  return {
    title: `Hábito ${overrides.id}`,
    category: 'Saúde',
    status: 'active',
    scheduleHistory: [{ from: '2026-10-01', schedule: { kind: 'daily' } }],
    pauses: [],
    timing: { kind: 'anytime' },
    reminder: { enabled: false },
    xp: 10,
    order: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function testCompletion(habitId: string, scheduledDate: string, overrides: Partial<HabitCompletion> = {}): HabitCompletion {
  return {
    id: `${habitId}|${scheduledDate}`,
    habitId,
    scheduledDate,
    status: 'done',
    completedAt: `${scheduledDate}T15:00:00.000Z`,
    timezone: 'America/Sao_Paulo',
    source: 'manual',
    xpAwarded: 10,
    ...overrides,
  };
}

export function testGoal(overrides: Partial<Goal> & { id: string }): Goal {
  return {
    title: `Meta ${overrides.id}`,
    horizon: 'month',
    periodStart: '2026-10-01',
    periodEnd: '2026-10-31',
    progressRule: { kind: 'manual_completion' },
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function testItem(overrides: Partial<AgendaItem> & { id: string }): AgendaItem {
  const base: AgendaItem = {
    id: overrides.id,
    kind: 'event',
    title: `Item ${overrides.id}`,
    date: '2026-10-19',
    allDay: false,
    startTime: '09:00',
    endTime: '10:00',
    timezone: 'America/Sao_Paulo',
    status: 'active',
    exceptions: {},
    origin: 'manual',
    xp: 0,
    seriesKind: 'single',
    createdAt: NOW,
    updatedAt: NOW,
  };
  const merged = { ...base, ...overrides };
  merged.seriesKind = !merged.date ? 'undated' : merged.recurrence ? 'recurring' : 'single';
  return merged;
}

export function testJournal(overrides: Partial<JournalEntry> & { id: string; date: string }): JournalEntry {
  return {
    text: 'Texto de teste do diário.',
    links: { habitIds: [], goalIds: [], agendaItemIds: [] },
    kaiAccess: 'allowed',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function testCheckin(date: string, mood?: number, energy?: number): Checkin {
  return { date, mood, energy, createdAt: NOW, updatedAt: NOW };
}

export function testProfile(overrides: Partial<Profile> = {}): Profile {
  return { ...newProfile({ timezone: 'America/Sao_Paulo', now: NOW }), onboardingCompletedAt: NOW, ...overrides };
}

export function testPrefs(overrides: Partial<Preferences> = {}): Preferences {
  return { ...defaultPreferences(NOW), ...overrides };
}

export function grantAll(prefs: Preferences, keys: Array<keyof Preferences['consents']>): Preferences {
  const consents = { ...prefs.consents };
  for (const k of keys) consents[k] = { ...consents[k], granted: true, updatedAt: NOW };
  return { ...prefs, consents };
}
