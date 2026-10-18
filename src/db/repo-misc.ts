import type { CivilDate } from '../domain/civil';
import {
  integrationSchema,
  kaiConversationSchema,
  kaiInsightSchema,
  notificationLogSchema,
  type Integration,
  type KaiConversation,
  type KaiInsight,
} from '../domain/schemas';
import { deriveProgressEvents, totalXp } from '../domain/xp';
import { db, nowIso, type RotinasDB } from './db';
import { validate } from './errors';

// ── Kai ─────────────────────────────────────────────────────────────────────

export async function saveInsight(insight: KaiInsight, database: RotinasDB = db): Promise<void> {
  await database.kaiInsights.put(validate(kaiInsightSchema, insight));
}

export async function setInsightDecision(id: string, decision: NonNullable<KaiInsight['decision']>, database: RotinasDB = db): Promise<void> {
  await database.kaiInsights.update(id, { decision });
}

export async function deleteInsight(id: string, database: RotinasDB = db): Promise<void> {
  await database.kaiInsights.delete(id);
}

export async function saveConversation(conversation: KaiConversation, database: RotinasDB = db): Promise<void> {
  await database.kaiConversations.put(validate(kaiConversationSchema, conversation));
}

export async function deleteConversation(id: string, database: RotinasDB = db): Promise<void> {
  await database.kaiConversations.delete(id);
}

/** Apaga o histórico do Kai guardado no aparelho (conversas e análises). */
export async function clearKaiHistory(database: RotinasDB = db): Promise<void> {
  await database.transaction('rw', [database.kaiInsights, database.kaiConversations], async () => {
    await database.kaiInsights.clear();
    await database.kaiConversations.clear();
  });
}

// ── Progresso ───────────────────────────────────────────────────────────────

/** Recalcula a tabela de eventos de XP a partir das fontes (conclusões e metas). */
export async function rebuildProgressEvents(database: RotinasDB = db): Promise<number> {
  return database.transaction(
    'rw',
    [database.progressEvents, database.completions, database.agendaCompletions, database.goals],
    async () => {
      const events = deriveProgressEvents({
        habitCompletions: await database.completions.toArray(),
        agendaCompletions: await database.agendaCompletions.toArray(),
        goals: await database.goals.toArray(),
      });
      await database.progressEvents.clear();
      await database.progressEvents.bulkPut(events);
      return events.length;
    },
  );
}

/** Confere se o XP gravado bate com o que o histórico produz. */
export async function verifyProgressIntegrity(database: RotinasDB = db): Promise<{ ok: boolean; storedXp: number; derivedXp: number }> {
  const [stored, completions, agendaCompletions, goals] = await Promise.all([
    database.progressEvents.toArray(),
    database.completions.toArray(),
    database.agendaCompletions.toArray(),
    database.goals.toArray(),
  ]);
  const derived = deriveProgressEvents({ habitCompletions: completions, agendaCompletions, goals });
  const storedIds = stored.map((e) => `${e.id}:${e.xp}`).sort();
  const derivedIds = derived.map((e) => `${e.id}:${e.xp}`).sort();
  const ok = storedIds.length === derivedIds.length && storedIds.every((v, i) => v === derivedIds[i]);
  return { ok, storedXp: totalXp(stored), derivedXp: totalXp(derived) };
}

// ── Integrações ─────────────────────────────────────────────────────────────

export async function setIntegration(patch: Omit<Integration, 'id' | 'provider' | 'updatedAt'>, database: RotinasDB = db): Promise<void> {
  await database.integrations.put(validate(integrationSchema, { ...patch, id: 'google_calendar', provider: 'google', updatedAt: nowIso() }));
}

export async function clearIntegration(database: RotinasDB = db): Promise<void> {
  await database.integrations.delete('google_calendar');
}

// ── Notificações ────────────────────────────────────────────────────────────

export async function logNotification(id: string, refId: string, date: CivilDate, database: RotinasDB = db): Promise<void> {
  await database.notificationLog.put(validate(notificationLogSchema, { id, kind: 'habit_reminder', refId, date, sentAt: nowIso() }));
}

export async function notificationsSentOn(date: CivilDate, database: RotinasDB = db): Promise<Set<string>> {
  const rows = await database.notificationLog.where('date').equals(date).toArray();
  return new Set(rows.map((r) => r.id));
}

/** Mantém só os registros recentes de lembretes enviados (são técnicos, sem conteúdo). */
export async function pruneNotificationLog(before: CivilDate, database: RotinasDB = db): Promise<void> {
  await database.notificationLog.where('date').below(before).delete();
}
