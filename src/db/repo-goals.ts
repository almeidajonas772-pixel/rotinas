import type { CivilDate } from '../domain/civil';
import { parentProblem } from '../domain/goals';
import { cleanText, goalProgressEntrySchema, goalSchema, type Goal, type GoalHorizon, type GoalProgressRule } from '../domain/schemas';
import { goalEvent, goalEventId } from '../domain/xp';
import { db, newId, nowIso, type RotinasDB } from './db';
import { UserFacingError, validate } from './errors';

export interface GoalDraft {
  title: string;
  description?: string;
  horizon: GoalHorizon;
  periodStart: CivilDate;
  periodEnd: CivilDate;
  progressRule: GoalProgressRule;
  parentId?: string;
}

async function requireGoal(database: RotinasDB, id: string): Promise<Goal> {
  const goal = await database.goals.get(id);
  if (!goal) throw new UserFacingError('Meta não encontrada. Ela pode ter sido excluída.');
  return goal;
}

async function checkParent(database: RotinasDB, candidate: Goal): Promise<void> {
  if (!candidate.parentId) return;
  const all = await database.goals.toArray();
  const parent = all.find((g) => g.id === candidate.parentId);
  if (!parent) throw new UserFacingError('A meta pai escolhida não existe mais.', { parentId: 'Escolha outra meta' });
  const problem = parentProblem(parent, candidate, all.map((g) => (g.id === candidate.id ? candidate : g)));
  if (problem) throw new UserFacingError(problem, { parentId: problem });
}

export async function createGoal(draft: GoalDraft, database: RotinasDB = db): Promise<Goal> {
  return database.transaction('rw', database.goals, async () => {
    const now = nowIso();
    const goal = validate(goalSchema, {
      id: newId(),
      title: draft.title.trim(),
      description: cleanText(draft.description),
      horizon: draft.horizon,
      periodStart: draft.periodStart,
      periodEnd: draft.periodEnd,
      progressRule: draft.progressRule,
      status: 'active',
      parentId: draft.parentId || undefined,
      createdAt: now,
      updatedAt: now,
    });
    await checkParent(database, goal);
    await database.goals.add(goal);
    return goal;
  });
}

export async function updateGoal(id: string, draft: GoalDraft, database: RotinasDB = db): Promise<Goal> {
  return database.transaction('rw', database.goals, async () => {
    const goal = await requireGoal(database, id);
    const next = validate(goalSchema, {
      ...goal,
      title: draft.title.trim(),
      description: cleanText(draft.description),
      horizon: draft.horizon,
      periodStart: draft.periodStart,
      periodEnd: draft.periodEnd,
      progressRule: draft.progressRule,
      parentId: draft.parentId || undefined,
      updatedAt: nowIso(),
    });
    await checkParent(database, next);
    // Metas filhas que deixariam de ser compatíveis perdem o vínculo explicitamente (nunca em silêncio).
    const children = await database.goals.where('parentId').equals(id).toArray();
    const all = await database.goals.toArray();
    for (const child of children) {
      if (parentProblem(next, child, all.map((g) => (g.id === next.id ? next : g)))) {
        throw new UserFacingError(`A meta filha “${child.title}” deixaria de ser compatível. Ajuste ou desvincule-a antes.`);
      }
    }
    await database.goals.put(next);
    return next;
  });
}

export async function completeGoal(id: string, ctx: { today: CivilDate }, database: RotinasDB = db): Promise<void> {
  await database.transaction('rw', [database.goals, database.progressEvents], async () => {
    const goal = await requireGoal(database, id);
    if (goal.status === 'completed') return;
    const now = nowIso();
    const next = validate(goalSchema, { ...goal, status: 'completed', completedAt: now, completedOn: ctx.today, updatedAt: now });
    await database.goals.put(next);
    const event = goalEvent(next);
    if (event) await database.progressEvents.put(event);
  });
}

export async function reopenGoal(id: string, database: RotinasDB = db): Promise<void> {
  await database.transaction('rw', [database.goals, database.progressEvents], async () => {
    const goal = await requireGoal(database, id);
    await database.goals.put({ ...goal, status: 'active', completedAt: undefined, completedOn: undefined, updatedAt: nowIso() });
    await database.progressEvents.delete(goalEventId(id));
  });
}

/** Arquivar só esconde a meta das listas ativas; uma conclusão anterior (e seu XP) é preservada. */
export async function archiveGoal(id: string, database: RotinasDB = db): Promise<void> {
  await database.transaction('rw', database.goals, async () => {
    const goal = await requireGoal(database, id);
    if (goal.status === 'archived') return;
    await database.goals.put({ ...goal, status: 'archived', updatedAt: nowIso() });
  });
}

export async function unarchiveGoal(id: string, database: RotinasDB = db): Promise<void> {
  await database.transaction('rw', database.goals, async () => {
    const goal = await requireGoal(database, id);
    if (goal.status !== 'archived') return;
    await database.goals.put({ ...goal, status: goal.completedOn ? 'completed' : 'active', updatedAt: nowIso() });
  });
}

/** Exclusão definitiva: desvincula metas filhas, hábitos e tarefas e remove atualizações manuais e XP. */
export async function deleteGoal(id: string, database: RotinasDB = db): Promise<void> {
  await database.transaction(
    'rw',
    [database.goals, database.goalProgress, database.progressEvents, database.habits, database.agendaItems, database.journal],
    async () => {
      await database.goals.where('parentId').equals(id).modify((g) => {
        delete g.parentId;
      });
      await database.habits.where('goalId').equals(id).modify((h) => {
        delete h.goalId;
      });
      await database.agendaItems.where('goalId').equals(id).modify((i) => {
        delete i.goalId;
      });
      await database.goalProgress.where('goalId').equals(id).delete();
      await database.progressEvents.delete(goalEventId(id));
      await database.journal.toCollection().modify((entry) => {
        if (entry.links.goalIds.includes(id)) entry.links = { ...entry.links, goalIds: entry.links.goalIds.filter((g) => g !== id) };
      });
      await database.goals.delete(id);
    },
  );
}

/** Atualização manual do valor atual de uma meta (identificada como manual no histórico). */
export async function addManualProgress(goalId: string, value: number, note: string | undefined, database: RotinasDB = db): Promise<void> {
  await database.transaction('rw', [database.goals, database.goalProgress], async () => {
    const goal = await requireGoal(database, goalId);
    if (goal.progressRule.kind !== 'manual_value') {
      throw new UserFacingError('Esta meta calcula o progresso automaticamente a partir de uma regra; não aceita valor manual.');
    }
    await database.goalProgress.add(
      validate(goalProgressEntrySchema, { id: newId(), goalId, value, note: cleanText(note), source: 'manual', createdAt: nowIso() }),
    );
  });
}

export async function deleteManualProgress(entryId: string, database: RotinasDB = db): Promise<void> {
  await database.goalProgress.delete(entryId);
}

export async function linkAgendaItemToGoal(itemId: string, goalId: string | undefined, database: RotinasDB = db): Promise<void> {
  await database.transaction('rw', [database.agendaItems, database.goals], async () => {
    const item = await database.agendaItems.get(itemId);
    if (!item) throw new UserFacingError('Item da agenda não encontrado.');
    if (goalId && !(await database.goals.get(goalId))) throw new UserFacingError('Meta não encontrada.');
    await database.agendaItems.put({ ...item, goalId: goalId || undefined, updatedAt: nowIso() });
  });
}
