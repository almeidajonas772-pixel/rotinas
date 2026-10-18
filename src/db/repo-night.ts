import type { CivilDate } from '../domain/civil';
import { dayPlanSchema, nightSessionSchema, type DayPlan, type KaiDataManifest, type NightMessage, type NightProposal, type NightSession } from '../domain/schemas';
import { db, nowIso, type RotinasDB } from './db';
import { UserFacingError, validate } from './errors';

/**
 * Noite: prioridade nº 1 de cada dia (definida na noite anterior) e as conversas da
 * sessão da noite. Tudo fica só no aparelho e entra no backup.
 */

export const MAX_NIGHT_MESSAGES = 120;

// ── Prioridade do dia ───────────────────────────────────────────────────────

export async function getDayPlan(date: CivilDate, database: RotinasDB = db): Promise<DayPlan | undefined> {
  return database.dayPlans.get(date);
}

/** Define (ou troca) a prioridade nº 1 de um dia. Trocar o texto limpa o resultado anterior. */
export async function setPriority(date: CivilDate, text: string, source: NonNullable<DayPlan['prioritySource']>, database: RotinasDB = db): Promise<DayPlan> {
  const priority = text.replace(/\s+/g, ' ').trim();
  if (!priority) throw new UserFacingError('Escreva a prioridade antes de salvar.');
  return database.transaction('rw', database.dayPlans, async () => {
    const now = nowIso();
    const current = await database.dayPlans.get(date);
    const same = current?.priority === priority.slice(0, 200);
    const next = validate(dayPlanSchema, {
      ...current,
      date,
      priority: priority.slice(0, 200),
      prioritySource: source,
      prioritySetAt: now,
      outcome: same ? current?.outcome : undefined,
      outcomeAt: same ? current?.outcomeAt : undefined,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    });
    await database.dayPlans.put(next);
    return next;
  });
}

export async function clearPriority(date: CivilDate, database: RotinasDB = db): Promise<void> {
  await database.transaction('rw', database.dayPlans, async () => {
    const current = await database.dayPlans.get(date);
    if (!current) return;
    await database.dayPlans.delete(date);
  });
}

/** Marca se a prioridade do dia foi cumprida (ou volta a "sem resposta" com `undefined`). */
export async function setPriorityOutcome(date: CivilDate, outcome: DayPlan['outcome'], database: RotinasDB = db): Promise<void> {
  await database.transaction('rw', database.dayPlans, async () => {
    const current = await database.dayPlans.get(date);
    if (!current?.priority) throw new UserFacingError('Não há prioridade definida para este dia.');
    const now = nowIso();
    await database.dayPlans.put(validate(dayPlanSchema, { ...current, outcome, outcomeAt: outcome ? now : undefined, updatedAt: now }));
  });
}

// ── Sessões da noite ────────────────────────────────────────────────────────

export async function getNightSession(date: CivilDate, database: RotinasDB = db): Promise<NightSession | undefined> {
  return database.nightSessions.get(date);
}

/** Acrescenta mensagens à sessão da noite (cria a sessão na primeira fala). Guarda no máximo as 120 últimas. */
export async function appendNightMessages(
  date: CivilDate,
  messages: readonly NightMessage[],
  options: { dataUsed?: KaiDataManifest } = {},
  database: RotinasDB = db,
): Promise<NightSession> {
  return database.transaction('rw', database.nightSessions, async () => {
    const now = nowIso();
    const current = await database.nightSessions.get(date);
    const all = [...(current?.messages ?? []), ...messages].slice(-MAX_NIGHT_MESSAGES);
    const next = validate(nightSessionSchema, {
      id: date,
      date,
      messages: all,
      dataUsed: options.dataUsed ?? current?.dataUsed,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    });
    await database.nightSessions.put(next);
    return next;
  });
}

/** Atualiza o estado de uma proposta do Kai (aceita, dispensada ou de volta a pendente). */
export async function setProposalState(
  date: CivilDate,
  messageId: string,
  index: number,
  patch: Pick<NightProposal, 'status'> & { createdItemId?: string | null },
  database: RotinasDB = db,
): Promise<void> {
  await database.transaction('rw', database.nightSessions, async () => {
    const session = await database.nightSessions.get(date);
    if (!session) throw new UserFacingError('Sessão da noite não encontrada.');
    const messages = session.messages.map((m) => {
      if (m.id !== messageId || !m.proposals?.[index]) return m;
      const proposals = m.proposals.map((p, i) => {
        if (i !== index) return p;
        const next: NightProposal = { ...p, status: patch.status };
        if (patch.createdItemId === null) delete next.createdItemId;
        else if (patch.createdItemId !== undefined) next.createdItemId = patch.createdItemId;
        return next;
      });
      return { ...m, proposals };
    });
    await database.nightSessions.put(validate(nightSessionSchema, { ...session, messages, updatedAt: nowIso() }));
  });
}

export async function deleteNightSession(date: CivilDate, database: RotinasDB = db): Promise<void> {
  await database.nightSessions.delete(date);
}

export async function clearNightSessions(database: RotinasDB = db): Promise<void> {
  await database.nightSessions.clear();
}
