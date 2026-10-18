import { deleteOccurrence, editThisOccurrence, isSeriesDate, seriesKindOf, splitSeries, type EditScope } from '../domain/agenda';
import type { CivilDate, LocalTime } from '../domain/civil';
import { agendaCompletionSchema, agendaItemSchema, cleanText, type AgendaCompletion, type AgendaItem, type AgendaKind, type Recurrence } from '../domain/schemas';
import { agendaEvent, agendaEventId, DEFAULT_TASK_XP } from '../domain/xp';
import { agendaCompletionId, db, newId, nowIso, type RotinasDB } from './db';
import { UserFacingError, validate } from './errors';
import { recordHabit, undoHabitRecord } from './repo-habits';

export interface AgendaDraft {
  kind: AgendaKind;
  title: string;
  notes?: string;
  date?: CivilDate;
  allDay: boolean;
  startTime?: LocalTime;
  endTime?: LocalTime;
  recurrence?: Recurrence;
  habitId?: string;
  goalId?: string;
  category?: string;
  xp?: number;
  origin?: AgendaItem['origin'];
}

function build(draft: AgendaDraft, base: Partial<AgendaItem>, timezone: string): AgendaItem {
  const now = nowIso();
  const allDay = draft.date ? draft.allDay : true;
  const candidate: AgendaItem = {
    id: base.id ?? newId(),
    kind: draft.kind,
    title: draft.title.trim(),
    notes: cleanText(draft.notes),
    date: draft.date || undefined,
    allDay,
    startTime: allDay ? undefined : draft.startTime,
    endTime: allDay ? undefined : draft.endTime || undefined,
    timezone: base.timezone ?? timezone,
    status: 'active',
    recurrence: draft.date ? draft.recurrence : undefined,
    exceptions: base.exceptions ?? {},
    habitId: draft.kind === 'habit' ? draft.habitId : undefined,
    goalId: draft.goalId || undefined,
    category: cleanText(draft.category),
    origin: draft.origin ?? base.origin ?? 'manual',
    external: base.external,
    xp: draft.kind === 'task' ? Math.round(draft.xp ?? DEFAULT_TASK_XP) : Math.round(draft.xp ?? 0),
    seriesKind: 'single',
    createdAt: base.createdAt ?? now,
    updatedAt: now,
  };
  candidate.seriesKind = seriesKindOf(candidate);
  return validate(agendaItemSchema, candidate);
}

export async function createAgendaItem(draft: AgendaDraft, ctx: { timezone: string }, database: RotinasDB = db): Promise<AgendaItem> {
  return database.transaction('rw', [database.agendaItems, database.habits], async () => {
    if (draft.kind === 'habit') {
      if (!draft.habitId || !(await database.habits.get(draft.habitId))) throw new UserFacingError('Escolha um hábito existente para o bloco.');
    }
    const item = build(draft, {}, ctx.timezone);
    await database.agendaItems.add(item);
    return item;
  });
}

async function requireItem(database: RotinasDB, id: string): Promise<AgendaItem> {
  const item = await database.agendaItems.get(id);
  if (!item) throw new UserFacingError('Item da agenda não encontrado. Ele pode ter sido excluído.');
  return item;
}

/**
 * Edita um item. Para itens recorrentes, `scope` define o alcance:
 *  - 'this': só a ocorrência da data original (título, data e horários);
 *  - 'following': a ocorrência e as próximas (a série é dividida, o passado fica intacto);
 *  - 'all': a série inteira.
 */
export async function updateAgendaItem(
  id: string,
  draft: AgendaDraft,
  options: { scope: EditScope; originalDate?: CivilDate; timezone: string },
  database: RotinasDB = db,
): Promise<AgendaItem> {
  return database.transaction('rw', [database.agendaItems, database.agendaCompletions, database.progressEvents], async () => {
    const item = await requireItem(database, id);
    const recurring = item.recurrence !== undefined;
    if (!recurring || options.scope === 'all' || !options.originalDate) {
      const next = build(draft, item, options.timezone);
      await database.agendaItems.put(next);
      return next;
    }
    if (options.scope === 'this') {
      if (draft.allDay !== item.allDay) {
        throw new UserFacingError('Para mudar entre “dia inteiro” e horário marcado, edite esta e as próximas ocorrências.');
      }
      const next = validate(
        agendaItemSchema,
        editThisOccurrence(
          item,
          options.originalDate,
          { title: draft.title.trim(), date: draft.date, startTime: draft.startTime, endTime: draft.endTime },
          nowIso(),
        ),
      );
      await database.agendaItems.put(next);
      return next;
    }
    // following
    const patchDraft = build(draft, { ...item, id: '__tmp__' }, options.timezone);
    const { id: _tmp, createdAt: _c, exceptions: _e, ...patch } = patchDraft;
    const { previous, next } = splitSeries(item, options.originalDate, patch, newId(), nowIso());
    const validNext = validate(agendaItemSchema, next);
    if (previous) {
      await database.agendaItems.put(validate(agendaItemSchema, previous));
      await database.agendaItems.add(validNext);
      // Conclusões de ocorrências que passaram para a nova série acompanham a série.
      const moved = (await database.agendaCompletions.where('itemId').equals(item.id).toArray()).filter(
        (c) => c.occurrenceDate >= options.originalDate! && isSeriesDate(validNext, c.occurrenceDate),
      );
      for (const c of moved) {
        const copy: AgendaCompletion = { ...c, id: agendaCompletionId(validNext.id, c.occurrenceDate), itemId: validNext.id };
        await database.agendaCompletions.delete(c.id);
        await database.progressEvents.delete(agendaEventId(c.id));
        await database.agendaCompletions.put(copy);
        const ev = agendaEvent(copy);
        if (ev) await database.progressEvents.put(ev);
      }
    } else {
      await database.agendaItems.put(validNext);
    }
    return validNext;
  });
}

async function removeItemCompletions(database: RotinasDB, itemId: string, filter?: (c: AgendaCompletion) => boolean) {
  const all = await database.agendaCompletions.where('itemId').equals(itemId).toArray();
  const target = filter ? all.filter(filter) : all;
  await database.progressEvents.bulkDelete(target.map((c) => agendaEventId(c.id)));
  await database.agendaCompletions.bulkDelete(target.map((c) => c.id));
}

export async function deleteAgendaItem(
  id: string,
  options: { scope: EditScope; originalDate?: CivilDate },
  database: RotinasDB = db,
): Promise<void> {
  await database.transaction('rw', [database.agendaItems, database.agendaCompletions, database.progressEvents, database.journal], async () => {
    const item = await requireItem(database, id);
    const next = item.recurrence && options.originalDate ? deleteOccurrence(item, options.originalDate, options.scope, nowIso()) : null;
    if (next === null) {
      await removeItemCompletions(database, id);
      await database.journal.toCollection().modify((entry) => {
        if (entry.links.agendaItemIds.includes(id)) {
          entry.links = { ...entry.links, agendaItemIds: entry.links.agendaItemIds.filter((x) => x !== id) };
        }
      });
      await database.agendaItems.delete(id);
      return;
    }
    await database.agendaItems.put(validate(agendaItemSchema, next));
    const od = options.originalDate!;
    if (options.scope === 'this') await removeItemCompletions(database, id, (c) => c.occurrenceDate === od);
    else await removeItemCompletions(database, id, (c) => c.occurrenceDate >= od);
  });
}

/**
 * Conclui uma ocorrência. Blocos de hábito concluem o próprio hábito (uma única fonte de
 * verdade para conclusões de hábito); tarefas e eventos ganham um registro próprio.
 */
export async function completeAgendaOccurrence(
  itemId: string,
  originalDate: CivilDate,
  ctx: { today: CivilDate; timezone: string; displayDate?: CivilDate },
  database: RotinasDB = db,
): Promise<void> {
  const item = await requireItem(database, itemId);
  if (item.kind === 'habit' && item.habitId) {
    await recordHabit(item.habitId, ctx.displayDate ?? originalDate, 'done', { today: ctx.today, timezone: ctx.timezone }, database);
    return;
  }
  await database.transaction('rw', [database.agendaItems, database.agendaCompletions, database.progressEvents], async () => {
    const fresh = await requireItem(database, itemId);
    if (fresh.date && !isSeriesDate(fresh, originalDate)) throw new UserFacingError('Esta ocorrência não existe mais na agenda.');
    const id = agendaCompletionId(itemId, originalDate);
    if (await database.agendaCompletions.get(id)) return;
    const completion = validate(agendaCompletionSchema, {
      id,
      itemId,
      occurrenceDate: originalDate,
      completedAt: nowIso(),
      timezone: ctx.timezone,
      xpAwarded: fresh.xp,
    });
    await database.agendaCompletions.put(completion);
    const event = agendaEvent(completion);
    if (event) await database.progressEvents.put(event);
  });
}

export async function undoAgendaOccurrence(
  itemId: string,
  originalDate: CivilDate,
  ctx: { displayDate?: CivilDate } = {},
  database: RotinasDB = db,
): Promise<void> {
  const item = await requireItem(database, itemId);
  if (item.kind === 'habit' && item.habitId) {
    await undoHabitRecord(item.habitId, ctx.displayDate ?? originalDate, database);
    return;
  }
  await database.transaction('rw', [database.agendaCompletions, database.progressEvents], async () => {
    const id = agendaCompletionId(itemId, originalDate);
    await database.agendaCompletions.delete(id);
    await database.progressEvents.delete(agendaEventId(id));
  });
}

/** Grava a referência do evento criado no Google Calendar (após confirmação explícita). */
export async function setExternalRef(itemId: string, external: NonNullable<AgendaItem['external']>, database: RotinasDB = db): Promise<void> {
  await database.transaction('rw', database.agendaItems, async () => {
    const item = await requireItem(database, itemId);
    await database.agendaItems.put({ ...item, external, updatedAt: nowIso() });
  });
}
