import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportBackup, parseBackup, restoreBackup, clearAllData } from '../../src/db/backup';
import { RotinasDB, SCHEMA_V1, SCHEMA_V2 } from '../../src/db/db';
import { UserFacingError } from '../../src/db/errors';
import {
  completeAgendaOccurrence,
  createAgendaItem,
  deleteAgendaItem,
  undoAgendaOccurrence,
  updateAgendaItem,
} from '../../src/db/repo-agenda';
import { addManualProgress, completeGoal, createGoal, deleteGoal, reopenGoal } from '../../src/db/repo-goals';
import {
  archiveHabit,
  createHabit,
  deleteHabit,
  moveHabit,
  pauseHabit,
  recordHabit,
  resumeHabit,
  undoHabitRecord,
  updateHabit,
  type HabitDraft,
} from '../../src/db/repo-habits';
import { deleteJournalEntry, saveCheckin, saveJournalEntry } from '../../src/db/repo-journal';
import { rebuildProgressEvents, verifyProgressIntegrity } from '../../src/db/repo-misc';
import { appendNightMessages, clearPriority, setPriority, setPriorityOutcome, setProposalState } from '../../src/db/repo-night';
import { completeOnboarding, getPrefs, setConsent } from '../../src/db/repo-profile';
import { expandAgenda } from '../../src/domain/agenda';
import { computeGoalProgress } from '../../src/domain/goals';
import { buildKaiContext } from '../../src/domain/kai-context';
import { isScheduledOn } from '../../src/domain/schedule';
import { totalXp } from '../../src/domain/xp';

const TZ = 'America/Sao_Paulo';
let database: RotinasDB;

beforeEach(async () => {
  database = new RotinasDB(`test-${crypto.randomUUID()}`);
  await database.open();
});

afterEach(async () => {
  database.close();
  await Dexie.delete(database.name);
});

const draft = (overrides: Partial<HabitDraft> = {}): HabitDraft => ({
  title: 'Ler 20 minutos',
  category: 'Estudos',
  schedule: { kind: 'daily' },
  timing: { kind: 'time', time: '20:00' },
  reminder: { enabled: false },
  xp: 10,
  startDate: '2026-10-10',
  ...overrides,
});

describe('hábitos: criação, edição, pausa e exclusão', () => {
  it('valida campos e não aceita início no passado', async () => {
    await expect(createHabit(draft({ title: '  ' }), { today: '2026-10-10' }, database)).rejects.toBeInstanceOf(UserFacingError);
    await expect(createHabit(draft(), { today: '2026-10-11' }, database)).rejects.toThrow(/hoje ou numa data futura/);
    const h = await createHabit(draft(), { today: '2026-10-10' }, database);
    expect(h.order).toBe(0);
    expect((await createHabit(draft({ title: 'Outro' }), { today: '2026-10-10' }, database)).order).toBe(1);
  });

  it('editar a frequência vale a partir de hoje e preserva o passado', async () => {
    const h = await createHabit(draft(), { today: '2026-10-10' }, database);
    await updateHabit(h.id, draft({ schedule: { kind: 'weekly', days: [6] } }), { today: '2026-10-15' }, database);
    const edited = (await database.habits.get(h.id))!;
    expect(edited.scheduleHistory).toHaveLength(2);
    expect(isScheduledOn(edited, '2026-10-14')).toBe(true);
    expect(isScheduledOn(edited, '2026-10-16')).toBe(false);
    expect(isScheduledOn(edited, '2026-10-17')).toBe(true);
  });

  it('pausa e arquivamento removem ocorrências sem contar como perdidas', async () => {
    const h = await createHabit(draft(), { today: '2026-10-10' }, database);
    await pauseHabit(h.id, { today: '2026-10-12' }, database);
    await resumeHabit(h.id, { today: '2026-10-14' }, database);
    let saved = (await database.habits.get(h.id))!;
    expect(saved.status).toBe('active');
    expect(saved.pauses).toEqual([{ from: '2026-10-12', to: '2026-10-13' }]);
    await archiveHabit(h.id, { today: '2026-10-16' }, database);
    saved = (await database.habits.get(h.id))!;
    expect(saved.status).toBe('archived');
    expect(isScheduledOn(saved, '2026-10-20')).toBe(false);
  });

  it('reordena e exclui em cascata (registros, XP e blocos)', async () => {
    const a = await createHabit(draft({ title: 'A' }), { today: '2026-10-10' }, database);
    const b = await createHabit(draft({ title: 'B' }), { today: '2026-10-10' }, database);
    await moveHabit(b.id, -1, database);
    expect((await database.habits.orderBy('order').toArray()).map((h) => h.title)).toEqual(['B', 'A']);
    await recordHabit(a.id, '2026-10-10', 'done', { today: '2026-10-10', timezone: TZ }, database);
    await createAgendaItem({ kind: 'habit', habitId: a.id, title: 'Bloco A', date: '2026-10-11', allDay: false, startTime: '20:00', endTime: '20:30' }, { timezone: TZ }, database);
    await deleteHabit(a.id, database);
    expect(await database.habits.count()).toBe(1);
    expect(await database.completions.count()).toBe(0);
    expect(await database.progressEvents.count()).toBe(0);
    expect(await database.agendaItems.count()).toBe(0);
  });
});

describe('conclusões: idempotência, desfazer e XP', () => {
  it('conclusão duplicada não soma duas vezes; desfazer recalcula; pular não dá XP', async () => {
    const h = await createHabit(draft(), { today: '2026-10-10' }, database);
    const ctx = { today: '2026-10-12', timezone: TZ };
    await recordHabit(h.id, '2026-10-12', 'done', ctx, database);
    await recordHabit(h.id, '2026-10-12', 'done', ctx, database);
    expect(await database.completions.count()).toBe(1);
    expect(totalXp(await database.progressEvents.toArray())).toBe(10);
    await recordHabit(h.id, '2026-10-11', 'skipped', ctx, database);
    expect(totalXp(await database.progressEvents.toArray())).toBe(10);
    await undoHabitRecord(h.id, '2026-10-12', database);
    expect(totalXp(await database.progressEvents.toArray())).toBe(0);
    expect((await verifyProgressIntegrity(database)).ok).toBe(true);
  });

  it('não aceita datas futuras nem dias sem ocorrência prevista', async () => {
    const h = await createHabit(draft({ schedule: { kind: 'weekly', days: [1] } }), { today: '2026-10-10' }, database);
    await expect(recordHabit(h.id, '2026-10-13', 'done', { today: '2026-10-12', timezone: TZ }, database)).rejects.toThrow(/futuras/);
    await expect(recordHabit(h.id, '2026-10-11', 'done', { today: '2026-10-12', timezone: TZ }, database)).rejects.toThrow(/não está previsto/);
  });

  it('o XP fica gravado no momento da conclusão e é reproduzível pelo histórico', async () => {
    const h = await createHabit(draft({ xp: 10 }), { today: '2026-10-10' }, database);
    await recordHabit(h.id, '2026-10-10', 'done', { today: '2026-10-10', timezone: TZ }, database);
    await updateHabit(h.id, draft({ xp: 50 }), { today: '2026-10-11' }, database);
    await recordHabit(h.id, '2026-10-11', 'done', { today: '2026-10-11', timezone: TZ }, database);
    expect(totalXp(await database.progressEvents.toArray())).toBe(60);
    await database.progressEvents.clear();
    await rebuildProgressEvents(database);
    expect(totalXp(await database.progressEvents.toArray())).toBe(60);
  });
});

describe('metas', () => {
  it('cria metas nos quatro horizontes com vínculo opcional e progresso por regra explícita', async () => {
    const year = await createGoal({ title: 'Ano', horizon: 'year', periodStart: '2026-01-01', periodEnd: '2026-12-31', progressRule: { kind: 'child_goals' } }, database);
    const month = await createGoal(
      { title: 'Outubro', horizon: 'month', periodStart: '2026-10-01', periodEnd: '2026-10-31', parentId: year.id, progressRule: { kind: 'linked_completions', target: 20, unit: 'sessões', includeDescendants: false } },
      database,
    );
    const week = await createGoal({ title: 'Semana', horizon: 'week', periodStart: '2026-10-12', periodEnd: '2026-10-18', parentId: month.id, progressRule: { kind: 'manual_completion' } }, database);
    await createGoal({ title: 'Hoje', horizon: 'day', periodStart: '2026-10-17', periodEnd: '2026-10-17', parentId: week.id, progressRule: { kind: 'manual_value', target: 3, unit: 'páginas' } }, database);
    await createGoal({ title: 'Solta', horizon: 'week', periodStart: '2026-10-12', periodEnd: '2026-10-18', progressRule: { kind: 'manual_completion' } }, database);
    await expect(
      createGoal({ title: 'Errada', horizon: 'year', periodStart: '2026-01-01', periodEnd: '2026-12-31', parentId: month.id, progressRule: { kind: 'manual_completion' } }, database),
    ).rejects.toThrow(/horizonte mais longo/);

    const habit = await createHabit(draft({ goalId: month.id }), { today: '2026-10-10' }, database);
    await recordHabit(habit.id, '2026-10-10', 'done', { today: '2026-10-11', timezone: TZ }, database);
    await recordHabit(habit.id, '2026-10-11', 'done', { today: '2026-10-11', timezone: TZ }, database);
    const ctx = {
      goals: await database.goals.toArray(),
      habits: await database.habits.toArray(),
      agendaItems: [],
      habitCompletions: await database.completions.toArray(),
      agendaCompletions: [],
      progressEntries: [],
    };
    expect(computeGoalProgress((await database.goals.get(month.id))!, ctx)).toMatchObject({ current: 2, target: 20, manual: false });
    await expect(addManualProgress(month.id, 5, undefined, database)).rejects.toThrow(/automaticamente/);
  });

  it('concluir dá XP fixo; reabrir remove; excluir desvincula itens', async () => {
    const goal = await createGoal({ title: 'Semana', horizon: 'week', periodStart: '2026-10-12', periodEnd: '2026-10-18', progressRule: { kind: 'manual_completion' } }, database);
    const habit = await createHabit(draft({ goalId: goal.id }), { today: '2026-10-10' }, database);
    await completeGoal(goal.id, { today: '2026-10-17' }, database);
    expect(totalXp(await database.progressEvents.toArray())).toBe(20);
    await reopenGoal(goal.id, database);
    expect(totalXp(await database.progressEvents.toArray())).toBe(0);
    await deleteGoal(goal.id, database);
    expect((await database.habits.get(habit.id))!.goalId).toBeUndefined();
  });
});

describe('agenda nativa', () => {
  it('cria, edita uma ocorrência, divide a série, conclui e exclui', async () => {
    const item = await createAgendaItem(
      { kind: 'task', title: 'Revisar física', date: '2026-10-12', allDay: false, startTime: '16:00', endTime: '17:00', recurrence: { freq: 'weekly', interval: 1, byWeekday: [1] } },
      { timezone: TZ },
      database,
    );
    await updateAgendaItem(item.id, { kind: 'task', title: 'Revisar física (sala 2)', date: '2026-10-20', allDay: false, startTime: '15:00', endTime: '16:00' }, { scope: 'this', originalDate: '2026-10-19', timezone: TZ }, database);
    let occ = expandAgenda(await database.agendaItems.toArray(), '2026-10-12', '2026-10-31', TZ);
    expect(occ.map((o) => `${o.date} ${o.startTime} ${o.title}`)).toEqual([
      '2026-10-12 16:00 Revisar física',
      '2026-10-20 15:00 Revisar física (sala 2)',
      '2026-10-26 16:00 Revisar física',
    ]);
    await completeAgendaOccurrence(item.id, '2026-10-26', { today: '2026-10-12', timezone: TZ }, database);
    await completeAgendaOccurrence(item.id, '2026-10-26', { today: '2026-10-12', timezone: TZ }, database);
    expect(totalXp(await database.progressEvents.toArray())).toBe(5);
    await updateAgendaItem(item.id, { kind: 'task', title: 'Revisar física', date: '2026-10-26', allDay: false, startTime: '18:00', endTime: '19:00', recurrence: { freq: 'weekly', interval: 1, byWeekday: [1] } }, { scope: 'following', originalDate: '2026-10-26', timezone: TZ }, database);
    expect(await database.agendaItems.count()).toBe(2);
    occ = expandAgenda(await database.agendaItems.toArray(), '2026-10-12', '2026-11-02', TZ);
    expect(occ.map((o) => `${o.date} ${o.startTime}`)).toEqual(['2026-10-12 16:00', '2026-10-20 15:00', '2026-10-26 18:00', '2026-11-02 18:00']);
    // A conclusão de 26/10 acompanhou a nova série; o XP não foi duplicado.
    expect(await database.agendaCompletions.count()).toBe(1);
    expect((await verifyProgressIntegrity(database)).ok).toBe(true);
    const newSeries = (await database.agendaItems.toArray()).find((i) => i.id !== item.id)!;
    await undoAgendaOccurrence(newSeries.id, '2026-10-26', {}, database);
    expect(totalXp(await database.progressEvents.toArray())).toBe(0);
    await deleteAgendaItem(item.id, { scope: 'all' }, database);
    expect(await database.agendaItems.count()).toBe(1);
  });

  it('concluir um bloco de hábito conclui o próprio hábito', async () => {
    const habit = await createHabit(draft(), { today: '2026-10-10' }, database);
    const block = await createAgendaItem({ kind: 'habit', habitId: habit.id, title: habit.title, date: '2026-10-11', allDay: false, startTime: '20:00', endTime: '20:30' }, { timezone: TZ }, database);
    await completeAgendaOccurrence(block.id, '2026-10-11', { today: '2026-10-11', timezone: TZ }, database);
    expect(await database.completions.get(`${habit.id}|2026-10-11`)).toMatchObject({ status: 'done' });
    expect(await database.agendaCompletions.count()).toBe(0);
  });
});

describe('Diário e check-in', () => {
  it('cria, edita e exclui entradas (uma por dia) e mantém privacidade sem consentimento', async () => {
    const e1 = await saveJournalEntry('2026-10-17', { text: 'Primeira versão' }, database);
    const e2 = await saveJournalEntry('2026-10-17', { text: 'Versão editada', toImprove: 'Dormir mais cedo' }, database);
    expect(e2.id).toBe(e1.id);
    expect(await database.journal.count()).toBe(1);
    await expect(saveJournalEntry('2026-10-18', { text: '   ' }, database)).rejects.toThrow(/Escreva algo/);
    await saveCheckin('2026-10-17', { mood: 4, energy: 3 }, database);

    const prefs = await setConsent('kai', true, database);
    const snapshot = {
      today: '2026-10-17',
      profile: { id: 'me' as const, timezone: TZ, availability: { periods: [], windows: [] }, createdAt: e1.createdAt, updatedAt: e1.createdAt },
      prefs,
      habits: [],
      completions: [],
      goals: [],
      goalCtx: { goals: [], habits: [], agendaItems: [], habitCompletions: [], agendaCompletions: [], progressEntries: [] },
      checkins: await database.checkins.toArray(),
      journal: await database.journal.toArray(),
    };
    const ctx = buildKaiContext(snapshot);
    expect(ctx.context.journal).toBeUndefined();
    expect(JSON.stringify(ctx.context)).not.toContain('Versão editada');
    await deleteJournalEntry(e1.id, database);
    expect(await database.journal.count()).toBe(0);
  });
});

describe('consentimentos e onboarding', () => {
  it('revogar o coaching revoga os consentimentos dependentes', async () => {
    await setConsent('kai', true, database);
    await setConsent('kaiJournal', true, database);
    let prefs = await getPrefs(database);
    expect(prefs.consents.kaiJournal.granted).toBe(true);
    prefs = await setConsent('kai', false, database);
    expect(prefs.consents.kaiJournal.granted).toBe(false);
    await expect(setConsent('kaiJournal', true, database)).rejects.toThrow(/Ative o coaching/);
  });

  it.each([
    [false, false],
    [true, true],
  ])('onboarding salva perfil, preferências e hábitos (IA autorizada: %s)', async (kai) => {
    await completeOnboarding(
      {
        name: 'Leo',
        timezone: TZ,
        mainGoal: 'Estudar todo dia',
        availability: { periods: ['noite'], minutesPerDay: 60, windows: [] },
        weekStartsOn: 1,
        checkins: false,
        notifications: { wanted: false, quietStart: '22:00', quietEnd: '07:00' },
        consents: { kai, kaiCheckins: false, kaiJournal: kai },
        habits: [draft()],
        today: '2026-10-10',
      },
      database,
    );
    const prefs = await getPrefs(database);
    expect(prefs.consents.kai.granted).toBe(kai);
    expect(prefs.consents.kaiJournal.granted).toBe(kai);
    expect(prefs.consents.kaiCheckins.granted).toBe(false);
    expect((await database.profile.get('me'))?.onboardingCompletedAt).toBeDefined();
    expect(await database.habits.count()).toBe(1);
  });
});

describe('noite: prioridade do dia e sessões', () => {
  it('define, troca, marca e remove a prioridade; trocar o texto limpa o resultado', async () => {
    await expect(setPriority('2026-10-19', '   ', 'manual', database)).rejects.toBeInstanceOf(UserFacingError);
    await setPriority('2026-10-19', '  Revisar   Geografia ', 'voice', database);
    expect(await database.dayPlans.get('2026-10-19')).toMatchObject({ priority: 'Revisar Geografia', prioritySource: 'voice' });
    await setPriorityOutcome('2026-10-19', 'done', database);
    expect((await database.dayPlans.get('2026-10-19'))?.outcome).toBe('done');
    await setPriority('2026-10-19', 'Revisar Geografia', 'manual', database);
    expect((await database.dayPlans.get('2026-10-19'))?.outcome).toBe('done');
    await setPriority('2026-10-19', 'Entregar o relatório', 'kai', database);
    expect((await database.dayPlans.get('2026-10-19'))?.outcome).toBeUndefined();
    await expect(setPriorityOutcome('2026-10-20', 'done', database)).rejects.toBeInstanceOf(UserFacingError);
    await clearPriority('2026-10-19', database);
    expect(await database.dayPlans.get('2026-10-19')).toBeUndefined();
  });

  it('guarda a conversa da noite (máximo de 120 falas) e o estado de cada proposta', async () => {
    const now = '2026-10-18T23:00:00.000Z';
    const many = Array.from({ length: 125 }, (_, i) => ({ id: `m${i}`, role: 'user' as const, content: `fala ${i}`, createdAt: now }));
    const session = await appendNightMessages('2026-10-18', many, {}, database);
    expect(session.messages).toHaveLength(120);
    expect(session.messages[0].id).toBe('m5');
    await appendNightMessages(
      '2026-10-18',
      [
        {
          id: 'k1',
          role: 'assistant',
          source: 'kai',
          content: 'Boa noite.',
          createdAt: now,
          proposals: [{ kind: 'tarefa_amanha', title: 'Separar o material', detail: '', refs: [], start: null, end: null, status: 'pending' }],
        },
      ],
      { dataUsed: { categories: ['x'], counts: {} } },
      database,
    );
    await setProposalState('2026-10-18', 'k1', 0, { status: 'accepted', createdItemId: 'item-1' }, database);
    let stored = await database.nightSessions.get('2026-10-18');
    expect(stored?.messages.at(-1)?.proposals?.[0]).toMatchObject({ status: 'accepted', createdItemId: 'item-1' });
    expect(stored?.dataUsed?.categories).toEqual(['x']);
    await setProposalState('2026-10-18', 'k1', 0, { status: 'pending', createdItemId: null }, database);
    stored = await database.nightSessions.get('2026-10-18');
    expect(stored?.messages.at(-1)?.proposals?.[0].createdItemId).toBeUndefined();
  });

  it('a agenda no Kai depende do Kai: sem ele não se autoriza, e revogar o Kai a desliga', async () => {
    await expect(setConsent('kaiAgenda', true, database)).rejects.toBeInstanceOf(UserFacingError);
    await setConsent('kai', true, database);
    await setConsent('kaiAgenda', true, database);
    await setConsent('voice', true, database);
    expect((await getPrefs(database)).consents.kaiAgenda.granted).toBe(true);
    await setConsent('kai', false, database);
    const prefs = await getPrefs(database);
    expect(prefs.consents.kaiAgenda.granted).toBe(false);
    // Voz é independente do Kai.
    expect(prefs.consents.voice.granted).toBe(true);
  });

  it('revogar as notificações também desliga o lembrete da noite', async () => {
    await setConsent('notifications', true, database);
    await database.prefs.update('prefs', { nightly: { reminder: { enabled: true, time: '21:30' }, speak: true, rate: 1, handsFree: false } });
    await setConsent('notifications', false, database);
    expect((await getPrefs(database)).nightly.reminder.enabled).toBe(false);
  });
});

describe('persistência, migração e backup', () => {
  it('migra um banco da versão 1 para a 2 preservando os dados', async () => {
    const name = `legacy-${crypto.randomUUID()}`;
    const legacy = new Dexie(name);
    legacy.version(1).stores(SCHEMA_V1);
    await legacy.open();
    await legacy.table('prefs').put({ id: 'prefs', language: 'pt-BR', theme: 'system', weekStartsOn: 1, features: { checkins: false }, consents: { kai: { granted: false, version: 1 }, kaiCheckins: { granted: false, version: 1 }, kaiJournal: { granted: false, version: 1 }, calendar: { granted: false, version: 1 } }, server: {}, updatedAt: '2026-10-01T00:00:00.000Z' });
    await legacy.table('habits').put({ id: 'h-old', title: 'Antigo', category: 'Saúde', status: 'active', scheduleHistory: [{ from: '2026-09-01', schedule: { kind: 'daily' } }], pauses: [], timing: { kind: 'anytime' }, xp: 10, order: 0, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' });
    legacy.close();

    const upgraded = new RotinasDB(name);
    await upgraded.open();
    expect(upgraded.verno).toBe(4);
    const prefs = (await upgraded.prefs.get('prefs'))!;
    expect(prefs.notifications.channel).toBe('none');
    expect(prefs.consents.notifications.granted).toBe(false);
    expect(prefs.consents.kaiAgenda.granted).toBe(false);
    expect(prefs.consents.voice.granted).toBe(false);
    expect(prefs.nightly).toMatchObject({ reminder: { enabled: false, time: '21:30' }, speak: true, handsFree: false });
    expect((await upgraded.habits.get('h-old'))!.reminder).toEqual({ enabled: false });
    expect(await upgraded.notificationLog.count()).toBe(0);
    expect(await upgraded.dayPlans.count()).toBe(0);
    expect(await upgraded.nightSessions.count()).toBe(0);
    upgraded.close();
    await Dexie.delete(name);
  });

  it('migra da versão 2 para a 3 sem mexer nas autorizações já dadas; textos novos pedem revisão', async () => {
    const name = `v2-${crypto.randomUUID()}`;
    const v2 = new Dexie(name);
    v2.version(1).stores(SCHEMA_V1);
    v2.version(2).stores(SCHEMA_V2);
    await v2.open();
    const at = '2026-10-01T00:00:00.000Z';
    await v2.table('prefs').put({
      id: 'prefs',
      language: 'pt-BR',
      theme: 'dark',
      weekStartsOn: 1,
      notifications: { channel: 'local', quietStart: '22:00', quietEnd: '07:00', allowedDays: [1, 2, 3, 4, 5, 6, 7], maxPerDay: 4 },
      features: { checkins: true },
      consents: {
        kai: { granted: true, updatedAt: at, version: 1 },
        kaiCheckins: { granted: true, updatedAt: at, version: 1 },
        kaiJournal: { granted: false, version: 1 },
        calendar: { granted: true, updatedAt: at, version: 1 },
        notifications: { granted: true, updatedAt: at, version: 1 },
      },
      server: { accessToken: 'senha-do-servidor' },
      updatedAt: at,
    });
    v2.close();

    const upgraded = new RotinasDB(name);
    await upgraded.open();
    const raw = (await upgraded.prefs.get('prefs'))!;
    // O que estava gravado continua igual (nada é revogado silenciosamente no banco).
    expect(raw.consents.kai).toEqual({ granted: true, updatedAt: at, version: 1 });
    expect(raw.server.accessToken).toBe('senha-do-servidor');
    expect(raw.theme).toBe('dark');
    // O app enxerga o Kai e o calendário desligados até a revisão dos textos novos.
    const effective = await getPrefs(upgraded);
    expect(effective.consents.kai).toMatchObject({ granted: false, outdated: true });
    expect(effective.consents.calendar).toMatchObject({ granted: false, outdated: true });
    expect(effective.consents.kaiCheckins.granted).toBe(true);
    expect(effective.consents.notifications.granted).toBe(true);
    // Rever e conceder de novo grava a versão atual.
    await setConsent('kai', true, upgraded);
    expect((await getPrefs(upgraded)).consents.kai).toMatchObject({ granted: true, version: 2 });
    upgraded.close();
    await Dexie.delete(name);
  });

  it('exporta, valida e restaura um backup completo em outro banco', async () => {
    await setConsent('kai', true, database);
    await database.prefs.update('prefs', { server: { accessToken: 'segredo-local' } });
    const h = await createHabit(draft(), { today: '2026-10-10' }, database);
    await recordHabit(h.id, '2026-10-10', 'done', { today: '2026-10-10', timezone: TZ }, database);
    await saveJournalEntry('2026-10-10', { text: 'Dia bom.' }, database);
    await setPriority('2026-10-11', 'Correr cedo', 'manual', database);
    await appendNightMessages('2026-10-10', [{ id: 'n1', role: 'user', content: 'Amanhã quero correr cedo.', via: 'voice', createdAt: '2026-10-11T00:00:00.000Z' }], {}, database);
    const file = await exportBackup(database);
    const json = JSON.stringify(file);
    expect(json).not.toContain('segredo-local');

    const parsed = parseBackup(json);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const target = new RotinasDB(`restore-${crypto.randomUUID()}`);
    await target.open();
    await restoreBackup(parsed.backup, target);
    expect(await target.habits.count()).toBe(1);
    expect(await target.completions.count()).toBe(1);
    expect(totalXp(await target.progressEvents.toArray())).toBe(10);
    expect((await target.journal.toArray())[0].text).toBe('Dia bom.');
    expect((await target.dayPlans.get('2026-10-11'))?.priority).toBe('Correr cedo');
    expect((await target.nightSessions.get('2026-10-10'))?.messages[0].content).toBe('Amanhã quero correr cedo.');
    expect((await verifyProgressIntegrity(target)).ok).toBe(true);
    target.close();
    await Dexie.delete(target.name);
  });

  it('rejeita arquivos inválidos e migra backups antigos', () => {
    expect(parseBackup('não é json')).toMatchObject({ ok: false });
    expect(parseBackup(JSON.stringify({ hello: 'world' }))).toMatchObject({ ok: false });
    expect(parseBackup(JSON.stringify({ format: 'rotinas-backup', formatVersion: 1, schemaVersion: 99, exportedAt: 'x', tables: {} }))).toMatchObject({ ok: false });
    const old = parseBackup(
      JSON.stringify({
        format: 'rotinas-backup',
        formatVersion: 1,
        schemaVersion: 1,
        exportedAt: '2026-10-01T00:00:00.000Z',
        tables: {
          habits: [{ id: 'h1', title: 'Antigo', category: 'Saúde', status: 'active', scheduleHistory: [{ from: '2026-09-01', schedule: { kind: 'daily' } }], pauses: [], timing: { kind: 'anytime' }, xp: 10, order: 0, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' }],
          completions: [{ id: 'zz|2026-09-02', habitId: 'zz', scheduledDate: '2026-09-02', status: 'done', completedAt: '2026-09-02T10:00:00.000Z', timezone: TZ, source: 'manual', xpAwarded: 10 }],
        },
      }),
    );
    expect(old.ok).toBe(true);
    if (old.ok) {
      expect(old.backup.tables.habits[0].reminder).toEqual({ enabled: false });
      expect(old.backup.tables.dayPlans).toEqual([]);
      expect(old.backup.tables.nightSessions).toEqual([]);
      expect(old.backup.tables.completions).toHaveLength(0);
      expect(old.backup.warnings.join(' ')).toMatch(/sem referência válida/);
    }
  });

  it('limpa todos os dados locais', async () => {
    const h = await createHabit(draft(), { today: '2026-10-10' }, database);
    await recordHabit(h.id, '2026-10-10', 'done', { today: '2026-10-10', timezone: TZ }, database);
    await clearAllData(database);
    for (const table of database.tables) expect(await table.count()).toBe(0);
  });
});
