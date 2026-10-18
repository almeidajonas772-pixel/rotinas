import { maxCivil, type CivilDate } from '../domain/civil';
import { habitStartDate, isScheduledOn, withPauseEnded, withPauseStarted, withScheduleChange } from '../domain/schedule';
import {
  cleanText,
  habitCompletionSchema,
  habitSchema,
  type CompletionStatus,
  type Habit,
  type HabitCompletion,
  type HabitSchedule,
  type HabitTiming,
} from '../domain/schemas';
import { habitEvent, habitEventId } from '../domain/xp';
import { completionId, db, newId, nowIso, type RotinasDB } from './db';
import { UserFacingError, validate } from './errors';

export interface HabitDraft {
  title: string;
  description?: string;
  category: string;
  schedule: HabitSchedule;
  timing: HabitTiming;
  durationMinutes?: number;
  reminder: { enabled: boolean; time?: string };
  xp: number;
  goalId?: string;
  firstStep?: string;
  /** Data em que o hábito começa a ter ocorrências previstas. */
  startDate: CivilDate;
}

function normalizeDraft(d: HabitDraft) {
  return {
    title: d.title.trim(),
    description: cleanText(d.description),
    category: d.category.trim(),
    timing: d.timing,
    durationMinutes: d.durationMinutes && d.durationMinutes > 0 ? Math.round(d.durationMinutes) : undefined,
    reminder: d.reminder.enabled ? { enabled: true, time: d.reminder.time } : { enabled: false },
    xp: Math.round(d.xp),
    goalId: d.goalId || undefined,
    firstStep: cleanText(d.firstStep),
  };
}

export async function createHabitInTx(database: RotinasDB, draft: HabitDraft, ctx: { today: CivilDate }, order?: number): Promise<Habit> {
  if (draft.startDate < ctx.today) {
    throw new UserFacingError('O hábito pode começar hoje ou numa data futura (dias passados contariam como perdidos).', {
      startDate: 'Escolha hoje ou uma data futura',
    });
  }
  const now = nowIso();
  const nextOrder =
    order ??
    ((await database.habits.orderBy('order').last())?.order ?? -1) + 1;
  const habit = validate(habitSchema, {
    id: newId(),
    ...normalizeDraft(draft),
    status: 'active',
    scheduleHistory: [{ from: draft.startDate, schedule: draft.schedule }],
    pauses: [],
    order: nextOrder,
    createdAt: now,
    updatedAt: now,
  });
  await database.habits.add(habit);
  return habit;
}

export async function createHabit(draft: HabitDraft, ctx: { today: CivilDate }, database: RotinasDB = db): Promise<Habit> {
  return database.transaction('rw', database.habits, () => createHabitInTx(database, draft, ctx));
}

async function requireHabit(database: RotinasDB, id: string): Promise<Habit> {
  const habit = await database.habits.get(id);
  if (!habit) throw new UserFacingError('Hábito não encontrado. Ele pode ter sido excluído.');
  return habit;
}

/**
 * Edita um hábito. Mudanças de frequência valem a partir de hoje (ou do início, se o hábito
 * ainda não começou), preservando o histórico; a data de início só muda antes de o hábito começar.
 */
export async function updateHabit(id: string, draft: HabitDraft, ctx: { today: CivilDate }, database: RotinasDB = db): Promise<Habit> {
  return database.transaction('rw', database.habits, async () => {
    const habit = await requireHabit(database, id);
    const started = habitStartDate(habit) <= ctx.today;
    let history = habit.scheduleHistory;
    if (!started && draft.startDate !== habitStartDate(habit)) {
      if (draft.startDate < ctx.today) {
        throw new UserFacingError('O hábito pode começar hoje ou numa data futura.', { startDate: 'Escolha hoje ou uma data futura' });
      }
      history = [{ from: draft.startDate, schedule: draft.schedule }];
    } else {
      const effective = started ? maxCivil(ctx.today, habitStartDate(habit)) : habitStartDate(habit);
      history = withScheduleChange(history, draft.schedule, effective);
    }
    const next = validate(habitSchema, {
      ...habit,
      ...normalizeDraft(draft),
      scheduleHistory: history,
      updatedAt: nowIso(),
    });
    await database.habits.put(next);
    return next;
  });
}

export async function pauseHabit(id: string, ctx: { today: CivilDate }, database: RotinasDB = db): Promise<void> {
  await database.transaction('rw', database.habits, async () => {
    const habit = await requireHabit(database, id);
    if (habit.status !== 'active') return;
    await database.habits.put({ ...habit, status: 'paused', pauses: withPauseStarted(habit.pauses, ctx.today), updatedAt: nowIso() });
  });
}

export async function resumeHabit(id: string, ctx: { today: CivilDate }, database: RotinasDB = db): Promise<void> {
  await database.transaction('rw', database.habits, async () => {
    const habit = await requireHabit(database, id);
    if (habit.status === 'active') return;
    await database.habits.put({ ...habit, status: 'active', pauses: withPauseEnded(habit.pauses, ctx.today), updatedAt: nowIso() });
  });
}

export async function archiveHabit(id: string, ctx: { today: CivilDate }, database: RotinasDB = db): Promise<void> {
  await database.transaction('rw', database.habits, async () => {
    const habit = await requireHabit(database, id);
    if (habit.status === 'archived') return;
    await database.habits.put({ ...habit, status: 'archived', pauses: withPauseStarted(habit.pauses, ctx.today), updatedAt: nowIso() });
  });
}

/** Desarquivar reativa o hábito; o período arquivado continua sem ocorrências (não conta como perdido). */
export async function unarchiveHabit(id: string, ctx: { today: CivilDate }, database: RotinasDB = db): Promise<void> {
  await resumeHabit(id, ctx, database);
}

/** Exclusão definitiva: remove o hábito, seus registros, XP derivado e blocos de tempo da agenda. */
export async function deleteHabit(id: string, database: RotinasDB = db): Promise<void> {
  await database.transaction(
    'rw',
    [database.habits, database.completions, database.progressEvents, database.agendaItems, database.journal],
    async () => {
      const completions = await database.completions.where('habitId').equals(id).toArray();
      await database.progressEvents.bulkDelete(completions.map((c) => habitEventId(c.id)));
      await database.completions.bulkDelete(completions.map((c) => c.id));
      const blocks = await database.agendaItems.where('habitId').equals(id).primaryKeys();
      await database.agendaItems.bulkDelete(blocks);
      await database.journal.toCollection().modify((entry) => {
        if (entry.links.habitIds.includes(id)) entry.links = { ...entry.links, habitIds: entry.links.habitIds.filter((h) => h !== id) };
      });
      await database.habits.delete(id);
    },
  );
}

/** Reordena hábitos conforme a lista de ids informada (os ausentes mantêm a posição relativa ao fim). */
export async function reorderHabits(orderedIds: readonly string[], database: RotinasDB = db): Promise<void> {
  await database.transaction('rw', database.habits, async () => {
    const all = await database.habits.orderBy('order').toArray();
    const rank = new Map(orderedIds.map((id, i) => [id, i]));
    const sorted = [...all].sort((a, b) => (rank.get(a.id) ?? 1e6 + a.order) - (rank.get(b.id) ?? 1e6 + b.order));
    await database.habits.bulkPut(sorted.map((h, i) => ({ ...h, order: i })));
  });
}

export async function moveHabit(id: string, direction: -1 | 1, database: RotinasDB = db): Promise<void> {
  const all = (await database.habits.orderBy('order').toArray()).filter((h) => h.status !== 'archived');
  const index = all.findIndex((h) => h.id === id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= all.length) return;
  const ids = all.map((h) => h.id);
  [ids[index], ids[target]] = [ids[target], ids[index]];
  await reorderHabits(ids, database);
}

/**
 * Registra a ocorrência de um hábito (concluída ou pulada). Idempotente: registrar de novo
 * o mesmo estado não cria duplicatas nem soma XP duas vezes.
 */
export async function recordHabit(
  habitId: string,
  date: CivilDate,
  status: CompletionStatus,
  ctx: { today: CivilDate; timezone: string; source?: 'manual' | 'calendar'; note?: string },
  database: RotinasDB = db,
): Promise<HabitCompletion> {
  return database.transaction('rw', [database.habits, database.completions, database.progressEvents], async () => {
    const habit = await requireHabit(database, habitId);
    if (date > ctx.today) throw new UserFacingError('Não é possível registrar ocorrências futuras.');
    if (!isScheduledOn(habit, date)) throw new UserFacingError('Este hábito não está previsto para esta data.');
    const id = completionId(habitId, date);
    const existing = await database.completions.get(id);
    if (existing && existing.status === status) return existing;
    const completion = validate(habitCompletionSchema, {
      id,
      habitId,
      scheduledDate: date,
      status,
      completedAt: nowIso(),
      timezone: ctx.timezone,
      note: cleanText(ctx.note ?? existing?.note),
      source: ctx.source ?? 'manual',
      xpAwarded: status === 'done' ? habit.xp : 0,
    });
    await database.completions.put(completion);
    const event = habitEvent(completion);
    if (event) await database.progressEvents.put(event);
    else await database.progressEvents.delete(habitEventId(id));
    return completion;
  });
}

/** Desfaz o registro (concluído ou pulado) e remove o XP correspondente. */
export async function undoHabitRecord(habitId: string, date: CivilDate, database: RotinasDB = db): Promise<void> {
  await database.transaction('rw', [database.completions, database.progressEvents], async () => {
    const id = completionId(habitId, date);
    await database.completions.delete(id);
    await database.progressEvents.delete(habitEventId(id));
  });
}

export async function setCompletionNote(habitId: string, date: CivilDate, note: string, database: RotinasDB = db): Promise<void> {
  await database.transaction('rw', database.completions, async () => {
    const id = completionId(habitId, date);
    const existing = await database.completions.get(id);
    if (!existing) throw new UserFacingError('Registre a ocorrência antes de adicionar uma observação.');
    await database.completions.put(validate(habitCompletionSchema, { ...existing, note: cleanText(note) }));
  });
}

export async function linkHabitToGoal(habitId: string, goalId: string | undefined, database: RotinasDB = db): Promise<void> {
  await database.transaction('rw', [database.habits, database.goals], async () => {
    const habit = await requireHabit(database, habitId);
    if (goalId && !(await database.goals.get(goalId))) throw new UserFacingError('Meta não encontrada.');
    await database.habits.put({ ...habit, goalId: goalId || undefined, updatedAt: nowIso() });
  });
}
