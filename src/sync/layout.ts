import type { z } from 'zod';
import {
  agendaCompletionSchema,
  agendaItemSchema,
  checkinSchema,
  dayPlanSchema,
  goalProgressEntrySchema,
  goalSchema,
  habitCompletionSchema,
  habitSchema,
  journalEntrySchema,
  kaiConversationSchema,
  kaiInsightSchema,
  nightSessionSchema,
  preferencesSchema,
  profileSchema,
} from '../domain/schemas';
import { bucketOf } from './hash';

/**
 * Como os dados do Rotinas são guardados no armazenamento do Claude (capacidade `db`).
 *
 * Cada registro vive dentro de um "pacote" (um documento) com vários registros da mesma tabela,
 * agrupados por período ou por um balde estável — assim um ano de uso cabe em poucas centenas de
 * documentos pequenos (limite da plataforma: 256 KiB por documento, 25.000 por artifact).
 * O app lê todos os pacotes da pessoa, então um registro pode estar em qualquer pacote: a
 * posição padrão só decide onde um registro novo entra.
 *
 * Ficam de fora: eventos de XP (recalculados do histórico), o registro técnico de lembretes e o
 * estado de integrações (específicos do aparelho).
 */

export const SYNCED_TABLES = [
  'profile',
  'prefs',
  'habits',
  'completions',
  'agendaItems',
  'agendaCompletions',
  'checkins',
  'journal',
  'goals',
  'goalProgress',
  'kaiInsights',
  'kaiConversations',
  'dayPlans',
  'nightSessions',
] as const;

export type SyncedTable = (typeof SYNCED_TABLES)[number];

export function isSyncedTable(name: string): name is SyncedTable {
  return (SYNCED_TABLES as readonly string[]).includes(name);
}

/** Campo da chave primária de cada tabela (o mesmo do IndexedDB). */
export const PRIMARY_KEY: Record<SyncedTable, string> = {
  profile: 'id',
  prefs: 'id',
  habits: 'id',
  completions: 'id',
  agendaItems: 'id',
  agendaCompletions: 'id',
  checkins: 'date',
  journal: 'id',
  goals: 'id',
  goalProgress: 'id',
  kaiInsights: 'id',
  kaiConversations: 'id',
  dayPlans: 'date',
  nightSessions: 'id',
};

/** Esquema de validação aplicado a cada registro que chega do armazenamento antes de entrar no aparelho. */
export const SYNC_SCHEMAS: Record<SyncedTable, z.ZodType> = {
  profile: profileSchema,
  prefs: preferencesSchema,
  habits: habitSchema,
  completions: habitCompletionSchema,
  agendaItems: agendaItemSchema,
  agendaCompletions: agendaCompletionSchema,
  checkins: checkinSchema,
  journal: journalEntrySchema,
  goals: goalSchema,
  goalProgress: goalProgressEntrySchema,
  kaiInsights: kaiInsightSchema,
  kaiConversations: kaiConversationSchema,
  dayPlans: dayPlanSchema,
  nightSessions: nightSessionSchema,
};

function str(record: Record<string, unknown>, field: string): string | undefined {
  const v = record[field];
  return typeof v === 'string' && v.length >= 7 ? v : undefined;
}

const month = (record: Record<string, unknown>, field: string) => str(record, field)?.slice(0, 7);
const year = (record: Record<string, unknown>, field: string) => str(record, field)?.slice(0, 4);

/** Pacote padrão de um registro (só letras, dígitos e `~ - .`, como pede a gramática de caminhos). */
export function defaultDocId(table: SyncedTable, key: string, record: Record<string, unknown> | null): string {
  const r = record ?? {};
  const hashed = (n: number) => `c~${table}~h${bucketOf(key, n)}`;
  switch (table) {
    case 'profile':
    case 'prefs':
    case 'habits':
      return `c~${table}`;
    case 'goals':
      return hashed(4);
    case 'agendaItems':
      return hashed(8);
    case 'completions': {
      const m = month(r, 'scheduledDate');
      return m ? `c~completions~${m}` : hashed(4);
    }
    case 'agendaCompletions': {
      const m = month(r, 'occurrenceDate');
      return m ? `c~agendaCompletions~${m}` : hashed(4);
    }
    case 'checkins': {
      const y = year(r, 'date') ?? key.slice(0, 4);
      return `c~checkins~${y}`;
    }
    case 'dayPlans': {
      const y = year(r, 'date') ?? key.slice(0, 4);
      return `c~dayPlans~${y}`;
    }
    case 'journal': {
      const m = month(r, 'date');
      return m ? `c~journal~${m}~${bucketOf(key, 4)}` : hashed(8);
    }
    case 'goalProgress': {
      const m = month(r, 'createdAt');
      return m ? `c~goalProgress~${m}` : hashed(4);
    }
    case 'kaiInsights': {
      const m = month(r, 'createdAt');
      return m ? `c~kaiInsights~${m}` : hashed(4);
    }
    case 'kaiConversations': {
      const m = month(r, 'createdAt');
      return m ? `c~kaiConversations~${m}~${bucketOf(key, 4)}` : hashed(8);
    }
    case 'nightSessions': {
      const m = month(r, 'date');
      return m ? `c~nightSessions~${m}~${bucketOf(key, 8)}` : hashed(8);
    }
  }
}

/** Pacote só de um registro grande demais para dividir pacote com outros. */
export function soloDocId(table: SyncedTable, key: string): string {
  return `s~${table}~${bucketOf(key, 1_000_000_007).toString(36)}${bucketOf(`${key}#`, 1_000_000_009).toString(36)}`;
}

/**
 * A parte de um registro que é sincronizada. Preferências específicas do aparelho ficam de fora:
 * a senha do servidor (nunca sai do aparelho) e a voz escolhida (cada aparelho tem as suas).
 */
export function projectForSync(table: SyncedTable, record: Record<string, unknown>): Record<string, unknown> {
  if (table !== 'prefs') return record;
  const nightly = (record.nightly ?? {}) as Record<string, unknown>;
  const { voiceURI: _voice, ...nightlyShared } = nightly;
  void _voice;
  return { ...record, server: {}, nightly: nightlyShared };
}

/** Junta um registro que veio do armazenamento com o que é só deste aparelho. */
export function mergeFromSync(table: SyncedTable, remote: Record<string, unknown>, local: Record<string, unknown> | undefined): Record<string, unknown> {
  if (table !== 'prefs') return remote;
  const localNightly = (local?.nightly ?? {}) as Record<string, unknown>;
  const remoteNightly = (remote.nightly ?? {}) as Record<string, unknown>;
  return {
    ...remote,
    server: (local?.server as Record<string, unknown> | undefined) ?? {},
    nightly: { ...remoteNightly, ...(typeof localNightly.voiceURI === 'string' ? { voiceURI: localNightly.voiceURI } : {}) },
  };
}
