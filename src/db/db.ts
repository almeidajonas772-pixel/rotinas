import Dexie, { type EntityTable } from 'dexie';
import type {
  AgendaCompletion,
  AgendaItem,
  Budget,
  Checkin,
  DayPlan,
  Goal,
  GoalProgressEntry,
  Habit,
  HabitCompletion,
  Integration,
  JournalEntry,
  KaiConversation,
  KaiInsight,
  MoneyEntry,
  NightSession,
  NotificationLog,
  Preferences,
  Profile,
  ProgressEvent,
} from '../domain/schemas';
import { DB_SCHEMA_VERSION, upgradeHabitToV2, upgradePrefsToV2, upgradePrefsToV3 } from './migrations';

export const DB_NAME = 'rotinas';

/** Índices de cada versão. Mudou um índice ou tabela? Crie uma nova versão — nunca edite uma já publicada. */
export const SCHEMA_V1 = {
  profile: 'id',
  prefs: 'id',
  habits: 'id, status, order, goalId',
  completions: 'id, habitId, scheduledDate, [habitId+scheduledDate]',
  agendaItems: 'id, seriesKind, [seriesKind+date], kind, habitId, goalId',
  agendaCompletions: 'id, itemId, occurrenceDate',
  checkins: 'date',
  journal: 'id, &date',
  goals: 'id, horizon, status, parentId',
  goalProgress: 'id, goalId, createdAt',
  progressEvents: 'id, type, refId, localDate',
  kaiInsights: 'id, kind, createdAt',
  kaiConversations: 'id, updatedAt',
  integrations: 'id',
} as const;

export const SCHEMA_V2 = {
  ...SCHEMA_V1,
  notificationLog: 'id, date',
} as const;

export const SCHEMA_V3 = {
  ...SCHEMA_V2,
  dayPlans: 'date',
  nightSessions: 'id, date, updatedAt',
} as const;

/** v4: aba Dinheiro (gastos e entradas) e limites mensais por categoria. */
export const SCHEMA_V4 = {
  ...SCHEMA_V3,
  moneyEntries: 'id, date, kind, category',
  budgets: 'id',
} as const;

export const TABLE_NAMES = Object.keys(SCHEMA_V4) as Array<keyof typeof SCHEMA_V4>;

export class RotinasDB extends Dexie {
  profile!: EntityTable<Profile, 'id'>;
  prefs!: EntityTable<Preferences, 'id'>;
  habits!: EntityTable<Habit, 'id'>;
  completions!: EntityTable<HabitCompletion, 'id'>;
  agendaItems!: EntityTable<AgendaItem, 'id'>;
  agendaCompletions!: EntityTable<AgendaCompletion, 'id'>;
  checkins!: EntityTable<Checkin, 'date'>;
  journal!: EntityTable<JournalEntry, 'id'>;
  goals!: EntityTable<Goal, 'id'>;
  goalProgress!: EntityTable<GoalProgressEntry, 'id'>;
  progressEvents!: EntityTable<ProgressEvent, 'id'>;
  kaiInsights!: EntityTable<KaiInsight, 'id'>;
  kaiConversations!: EntityTable<KaiConversation, 'id'>;
  integrations!: EntityTable<Integration, 'id'>;
  notificationLog!: EntityTable<NotificationLog, 'id'>;
  dayPlans!: EntityTable<DayPlan, 'date'>;
  nightSessions!: EntityTable<NightSession, 'id'>;
  moneyEntries!: EntityTable<MoneyEntry, 'id'>;
  budgets!: EntityTable<Budget, 'id'>;

  constructor(name: string = DB_NAME) {
    super(name);
    this.version(1).stores(SCHEMA_V1);
    this.version(2)
      .stores(SCHEMA_V2)
      .upgrade(async (tx) => {
        await tx
          .table('prefs')
          .toCollection()
          .modify((p: Record<string, unknown>) => {
            Object.assign(p, upgradePrefsToV2(p));
          });
        await tx
          .table('habits')
          .toCollection()
          .modify((h: Record<string, unknown>) => {
            Object.assign(h, upgradeHabitToV2(h));
          });
      });
    this.version(3)
      .stores(SCHEMA_V3)
      .upgrade(async (tx) => {
        await tx
          .table('prefs')
          .toCollection()
          .modify((p: Record<string, unknown>) => {
            Object.assign(p, upgradePrefsToV3(p));
          });
      });
    // Só tabelas novas: nada a converter.
    this.version(4).stores(SCHEMA_V4);
  }
}

if (DB_SCHEMA_VERSION !== 4) {
  throw new Error('Atualize RotinasDB ao mudar DB_SCHEMA_VERSION.');
}

export const db = new RotinasDB();

export function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // Alternativa para contextos sem randomUUID (ex.: http em rede local).
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function completionId(habitId: string, date: string): string {
  return `${habitId}|${date}`;
}

export function agendaCompletionId(itemId: string, originalDate: string): string {
  return `${itemId}|${originalDate}`;
}
