import type { CivilDate } from '../domain/civil';
import { checkinSchema, cleanText, journalEntrySchema, type Checkin, type JournalEntry } from '../domain/schemas';
import { db, newId, nowIso, type RotinasDB } from './db';
import { validate } from './errors';

export interface JournalDraft {
  text: string;
  didToday?: string;
  whatWorked?: string;
  toImprove?: string;
  nextStep?: string;
  links?: JournalEntry['links'];
  kaiAccess?: JournalEntry['kaiAccess'];
}

/** Cria ou atualiza a entrada do Diário daquele dia (uma por data local). */
export async function saveJournalEntry(date: CivilDate, draft: JournalDraft, database: RotinasDB = db): Promise<JournalEntry> {
  return database.transaction('rw', database.journal, async () => {
    const now = nowIso();
    const existing = await database.journal.where('date').equals(date).first();
    const entry = validate(journalEntrySchema, {
      id: existing?.id ?? newId(),
      date,
      text: draft.text,
      didToday: cleanText(draft.didToday),
      whatWorked: cleanText(draft.whatWorked),
      toImprove: cleanText(draft.toImprove),
      nextStep: cleanText(draft.nextStep),
      links: draft.links ?? existing?.links ?? { habitIds: [], goalIds: [], agendaItemIds: [] },
      kaiAccess: draft.kaiAccess ?? existing?.kaiAccess ?? 'allowed',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    await database.journal.put(entry);
    return entry;
  });
}

export async function setJournalKaiAccess(id: string, access: JournalEntry['kaiAccess'], database: RotinasDB = db): Promise<void> {
  await database.journal.update(id, { kaiAccess: access, updatedAt: nowIso() });
}

export async function deleteJournalEntry(id: string, database: RotinasDB = db): Promise<void> {
  await database.journal.delete(id);
}

export interface CheckinDraft {
  mood?: number;
  energy?: number;
  note?: string;
}

export async function saveCheckin(date: CivilDate, draft: CheckinDraft, database: RotinasDB = db): Promise<Checkin> {
  return database.transaction('rw', database.checkins, async () => {
    const now = nowIso();
    const existing = await database.checkins.get(date);
    const checkin = validate(checkinSchema, {
      date,
      mood: draft.mood,
      energy: draft.energy,
      note: cleanText(draft.note),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    await database.checkins.put(checkin);
    return checkin;
  });
}

export async function deleteCheckin(date: CivilDate, database: RotinasDB = db): Promise<void> {
  await database.checkins.delete(date);
}
