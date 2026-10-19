import { describe, expect, it } from 'vitest';
import type { GoogleEvent } from '../../shared/calendar';
import { kaiNightlyRequestSchema } from '../../shared/kai';
import { decidedConsent } from '../../src/db/defaults';
import { dueNightReminder, nightReminderLogId } from '../../src/domain/notifications-plan';
import { computeNightBrief, detectFlag, freeWindowsFrom, googleEventDays, nightDateFor, nightSpeech, speechTime, type NightInput } from '../../src/domain/nightly';
import { buildNightPayload, nightEvidence } from '../../src/domain/nightly-kai';
import type { KaiSnapshot } from '../../src/domain/kai-context';
import type { Preferences } from '../../src/domain/schemas';
import { grantAll, testCheckin, testCompletion, testGoal, testHabit, testItem, testPrefs, testProfile } from '../fixtures/builders';

const TZ = 'America/Sao_Paulo';
// Domingo, 18/10/2026, 20:30 em São Paulo.
const NOW = new Date('2026-10-18T23:30:00.000Z');

describe('noite: datas, horários e sinais simples', () => {
  it('depois da meia-noite (até 4h) a noite ainda é a do dia anterior', () => {
    expect(nightDateFor(new Date('2026-10-19T03:30:00.000Z'), TZ)).toBe('2026-10-18'); // 00:30 do dia 19
    expect(nightDateFor(new Date('2026-10-19T07:30:00.000Z'), TZ)).toBe('2026-10-19'); // 04:30 do dia 19
    expect(nightDateFor(NOW, TZ)).toBe('2026-10-18');
  });

  it('fala horários do jeito natural', () => {
    expect(speechTime('07:30')).toBe('7h30');
    expect(speechTime('19:00')).toBe('19h');
    expect(speechTime('00:05')).toBe('0h05');
  });

  it('detecta provas e prazos pelo título, sem confundir palavras parecidas', () => {
    expect(detectFlag('Prova de Geografia')).toBe('prova');
    expect(detectFlag('P2 de Cálculo')).toBe('prova');
    expect(detectFlag('AVALIAÇÃO bimestral')).toBe('prova');
    expect(detectFlag('Simulado ENEM')).toBe('prova');
    expect(detectFlag('AGI — Estudos Linguísticos')).toBe('prova');
    expect(detectFlag('Fuvest 1ª fase')).toBe('prova');
    expect(detectFlag('Agilidade no treino')).toBeUndefined();
    expect(detectFlag('Entrega do trabalho de História')).toBe('prazo');
    expect(detectFlag('Questionário 3 fecha')).toBe('prazo');
    expect(detectFlag('Vencimento do boleto')).toBe('prazo');
    expect(detectFlag('Aula de Química')).toBeUndefined();
    expect(detectFlag('Comprovante de residência')).toBeUndefined();
    expect(detectFlag('Reunião de equipe')).toBeUndefined();
  });

  it('calcula janelas livres a partir da disponibilidade e dos compromissos', () => {
    const windows = [{ start: '06:00', end: '12:00' }];
    const busy = [
      { start: 7 * 60, end: 7 * 60 + 30 },
      { start: 10 * 60, end: 10 * 60 + 50 },
    ];
    expect(freeWindowsFrom(windows, busy)).toEqual([
      { start: '06:00', end: '07:00' },
      { start: '07:30', end: '10:00' },
      { start: '10:50', end: '12:00' },
    ]);
    // Sobras menores que 20 minutos não viram janela.
    expect(freeWindowsFrom(windows, [{ start: 6 * 60 + 10, end: 11 * 60 + 45 }])).toEqual([]);
  });

  it('converte eventos do Google para os dias do fuso do perfil (dia inteiro com fim exclusivo)', () => {
    const allDay: GoogleEvent = { id: 'a', title: 'Viagem', allDay: true, start: '2026-10-19', end: '2026-10-22', busy: false, calendar: 'primary' };
    expect(googleEventDays(allDay, '2026-10-20', '2026-10-30', TZ).map((i) => i.date)).toEqual(['2026-10-20', '2026-10-21']);
    const timed: GoogleEvent = { id: 'b', title: 'Aula', allDay: false, start: '2026-10-19T13:00:00Z', end: '2026-10-19T13:50:00Z', busy: true, colorId: '8', calendar: 'primary' };
    expect(googleEventDays(timed, '2026-10-19', '2026-10-25', TZ)).toEqual([
      expect.objectContaining({ date: '2026-10-19', start: '10:00', end: '10:50', allDay: false, source: 'google', colorId: '8' }),
    ]);
    const overnight: GoogleEvent = { id: 'c', title: 'Plantão', allDay: false, start: '2026-10-20T01:00:00Z', end: '2026-10-20T13:00:00Z', busy: true, calendar: 'primary' };
    expect(googleEventDays(overnight, '2026-10-19', '2026-10-25', TZ).map((i) => [i.date, i.start, i.end])).toEqual([
      ['2026-10-19', '22:00', '23:59'],
      ['2026-10-20', '00:00', '10:00'],
    ]);
  });
});

function scenario(overrides: Partial<NightInput> = {}): NightInput {
  const habits = [
    testHabit({ id: 'ler', title: 'Ler', order: 0 }),
    testHabit({ id: 'correr', title: 'Correr', order: 1, timing: { kind: 'time', time: '07:00' }, durationMinutes: 30 }),
    testHabit({ id: 'meditar', title: 'Meditar', order: 2, timing: { kind: 'window', start: '20:00', end: '22:00' } }),
  ];
  const completions = [
    testCompletion('ler', '2026-10-18'),
    testCompletion('meditar', '2026-10-16'),
    testCompletion('meditar', '2026-10-17'),
    ...['2026-10-05', '2026-10-08', '2026-10-11', '2026-10-14', '2026-10-17'].map((d) => testCompletion('ler', d)),
  ];
  const items = [
    testItem({ id: 'conta', kind: 'task', title: 'Pagar a conta de luz', date: '2026-10-18', startTime: '14:00', endTime: undefined, xp: 5 }),
    testItem({ id: 'reuniao', kind: 'event', title: 'Reunião com a orientadora', date: '2026-10-19', startTime: '09:00', endTime: '10:00' }),
  ];
  const goal = testGoal({ id: 'g-leitura', title: 'Ler todo dia em outubro', progressRule: { kind: 'linked_completions', target: 31, unit: 'leituras', includeDescendants: false } });
  const lerComMeta = { ...habits[0], goalId: 'g-leitura' };
  const allHabits = [lerComMeta, habits[1], habits[2]];
  const google: GoogleEvent[] = [
    { id: 'quimica', title: 'Aula de Química', allDay: false, start: '2026-10-19T13:00:00Z', end: '2026-10-19T13:50:00Z', busy: true, colorId: '8', calendar: 'primary' },
    { id: 'prova', title: 'Prova de Geografia', allDay: true, start: '2026-10-21', end: '2026-10-22', busy: false, colorId: '6', calendar: 'primary' },
  ];
  return {
    now: NOW,
    profile: testProfile({ name: 'Jonas', availability: { periods: ['manha', 'noite'], windows: [] } }),
    habits: allHabits,
    completions,
    agendaItems: items,
    agendaCompletions: [{ id: 'conta|2026-10-18', itemId: 'conta', occurrenceDate: '2026-10-18', completedAt: '2026-10-18T17:00:00.000Z', timezone: TZ, xpAwarded: 5 }],
    goals: [goal],
    goalCtx: { goals: [goal], habits: allHabits, agendaItems: items, habitCompletions: completions, agendaCompletions: [], progressEntries: [] },
    progressEvents: [
      { xp: 10, localDate: '2026-10-18' },
      { xp: 5, localDate: '2026-10-18' },
      { xp: 10, localDate: '2026-10-17' },
    ],
    checkins: [testCheckin('2026-10-18', 4, 2)],
    todayPlan: { date: '2026-10-18', priority: 'Ler 30 páginas', prioritySource: 'manual', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() },
    tomorrowPlan: null,
    googleEvents: google,
    ...overrides,
  };
}

describe('noite: resumo calculado no aparelho', () => {
  const brief = computeNightBrief(scenario());

  it('fecha o dia com os números exatos', () => {
    expect(brief.date).toBe('2026-10-18');
    expect(brief.tomorrow).toBe('2026-10-19');
    expect(brief.tomorrowWeekday).toBe('segunda-feira');
    expect(brief.today).toMatchObject({ done: 1, skipped: 0, countable: 3, xp: 15 });
    expect(brief.today.habits.map((h) => [h.habit.id, h.status, h.stillPossible, h.streak])).toEqual([
      ['correr', 'open', false, 0],
      ['meditar', 'open', true, 2],
      ['ler', 'done', false, 2],
    ]);
    expect(brief.today.tasks).toEqual([{ key: 'conta|2026-10-18', title: 'Pagar a conta de luz', kind: 'task', time: '14:00', done: true }]);
    expect(brief.todayPriority).toEqual({ text: 'Ler 30 páginas', outcome: undefined });
    expect(brief.checkin).toEqual({ mood: 4, energy: 2 });
  });

  it('monta o amanhã com a agenda do Rotinas, o Google e as janelas livres', () => {
    expect(brief.tomorrowItems.map((i) => [i.title, i.start, i.end, i.source])).toEqual([
      ['Reunião com a orientadora', '09:00', '10:00', 'rotinas'],
      ['Aula de Química', '10:00', '10:50', 'google'],
    ]);
    expect(brief.tomorrowHabits.map((h) => [h.habit.id, h.start ?? null, h.end ?? null])).toEqual([
      ['correr', '07:00', '07:30'],
      ['meditar', '20:00', '22:00'],
      ['ler', null, null],
    ]);
    expect(brief.firstCommitment).toEqual({ title: 'Correr', start: '07:00' });
    expect(brief.freeWindows).toEqual([
      { start: '06:00', end: '07:00' },
      { start: '07:30', end: '09:00' },
      { start: '10:50', end: '12:00' },
      { start: '18:00', end: '22:30' },
    ]);
    expect(brief.usesGoogle).toBe(true);
  });

  it('põe provas e prazos no radar e gera sinais verificáveis', () => {
    expect(brief.radar.map((r) => [r.title, r.date, r.flag])).toEqual([['Prova de Geografia', '2026-10-21', 'prova']]);
    const kinds = brief.signals.map((s) => s.kind);
    expect(kinds).toContain('streak_at_risk');
    expect(kinds).toContain('goal_behind');
    expect(kinds).toContain('exam_soon');
    expect(brief.signals.find((s) => s.kind === 'exam_soon')?.text).toBe('Prova em 3 dias: Prova de Geografia.');
    const goal = brief.goals[0];
    expect(goal).toMatchObject({ state: 'behind', daysLeft: 13 });
    expect(goal.progress.current).toBe(6);
    expect(goal.needed).toBe('faltam 25 leituras em 13 dias');
  });

  it('depois da meia-noite nada "ainda dá tempo" e o dia fechado continua o mesmo', () => {
    const late = computeNightBrief(scenario({ now: new Date('2026-10-19T03:30:00.000Z') }));
    expect(late.date).toBe('2026-10-18');
    expect(late.afterMidnight).toBe(true);
    expect(late.today.habits.every((h) => !h.stillPossible)).toBe(true);
  });

  it('sem nada cadastrado, o resumo é vazio e honesto', () => {
    const empty = computeNightBrief(scenario({ habits: [], completions: [], agendaItems: [], agendaCompletions: [], goals: [], googleEvents: [], progressEvents: [], todayPlan: null, checkins: [] }));
    expect(empty.today).toMatchObject({ done: 0, countable: 0, xp: 0, tasks: [] });
    expect(empty.signals).toEqual([]);
    expect(empty.firstCommitment).toBeUndefined();
    expect(nightSpeech(empty).say).toBe('Boa noite. Hoje não havia hábitos previstos. Amanhã, segunda, a agenda está livre.');
  });

  it('a fala do app só descreve os dados e termina com a pergunta da prioridade', () => {
    const { say, question } = nightSpeech(brief, 'Jonas');
    expect(say).toBe(
      'Boa noite, Jonas. Hoje você concluiu 1 de 3 hábitos e somou 15 XP. Ainda dá tempo de: Meditar. A prioridade de hoje era: Ler 30 páginas. Amanhã, segunda, o primeiro compromisso é às 7h: Correr. No radar: Prova de Geografia, quarta, dia 21. A meta Ler todo dia em outubro está abaixo do ritmo.',
    );
    expect(question).toBe('Qual vai ser a sua prioridade número um para amanhã?');
  });
});

describe('noite: o que vai para o Kai', () => {
  const input = scenario();
  const brief = computeNightBrief(input);
  const basePrefs = grantAll(testPrefs(), ['kai']);
  const snapshot = (prefs: Preferences): KaiSnapshot => ({
    today: '2026-10-18',
    profile: input.profile as KaiSnapshot['profile'],
    prefs,
    habits: input.habits,
    completions: input.completions,
    goals: input.goals,
    goalCtx: input.goalCtx,
    checkins: input.checkins,
    journal: [],
  });

  it('sem a autorização da agenda, nenhum título de compromisso ou evento sai do aparelho', () => {
    const built = buildNightPayload(snapshot(basePrefs), brief, { includeAgenda: false });
    const json = JSON.stringify(built);
    for (const secret of ['Prova de Geografia', 'Reunião', 'Aula de Química', 'Pagar a conta', 'Jonas']) expect(json).not.toContain(secret);
    expect(built.night.todayTasks).toBeUndefined();
    expect(built.night.tomorrowAgenda).toBeUndefined();
    expect(built.night.freeWindowsTomorrow).toBeUndefined();
    expect(built.night.signals.some((s) => s.text.includes('Prova'))).toBe(false);
    expect(built.night.checkinToday).toBeUndefined();
    expect(built.night.lastPriority).toEqual({ text: 'Ler 30 páginas', outcome: 'unknown' });
    expect(kaiNightlyRequestSchema.safeParse({ context: built.context, night: built.night, history: [] }).success).toBe(true);
  });

  it('com a autorização da agenda, envia referências curtas e o mapa fica no aparelho', () => {
    const prefs = grantAll(basePrefs, ['kaiAgenda']);
    const built = buildNightPayload(snapshot(prefs), brief, { includeAgenda: true });
    expect(built.night.tomorrowAgenda?.map((a) => [a.ref, a.title, a.kind])).toEqual([
      ['a1', 'Reunião com a orientadora', 'event'],
      ['a2', 'Aula de Química', 'google'],
    ]);
    expect(built.night.upcoming).toEqual([{ ref: 'u1', date: '2026-10-21', title: 'Prova de Geografia', allDay: true, time: null, source: 'google', flag: 'prova' }]);
    expect(built.night.freeWindowsTomorrow?.[0]).toEqual({ start: '06:00', end: '07:00' });
    expect(built.night.signals.find((s) => s.text.startsWith('Prova'))?.refs).toEqual(['u1']);
    expect(built.refMap.a1).toBe('reuniao|2026-10-19');
    expect(built.refMap.h1).toBe('ler');
    expect(built.manifest.categories.join(' ')).toMatch(/Google Agenda/);
    expect(JSON.stringify(built)).not.toContain('Jonas');
    expect(kaiNightlyRequestSchema.safeParse({ context: built.context, night: built.night, history: [] }).success).toBe(true);

    const evidence = nightEvidence(['a2', 'u1', 'h1', 'zz'], built);
    expect(evidence.a2).toEqual({ label: 'Aula de Química', detail: 'Amanhã, das 10h às 10h50 (Google Agenda).' });
    expect(evidence.u1.detail).toBe('Prova (detectada pelo título). 21/10, dia inteiro (Google Agenda).');
    expect(evidence.h1.label).toBe('Ler');
    expect(evidence.zz).toBeUndefined();
  });

  it('o check-in de hoje só entra com o recurso ligado e a autorização própria', () => {
    const prefs: Preferences = { ...grantAll(basePrefs, ['kaiCheckins']), features: { checkins: true } };
    const built = buildNightPayload(snapshot(prefs), brief, { includeAgenda: false });
    expect(built.night.checkinToday).toEqual({ mood: 4, energy: 2 });
  });

  it('sem o Kai autorizado, nada é montado', () => {
    expect(() => buildNightPayload(snapshot(testPrefs()), brief, { includeAgenda: true })).toThrow();
  });
});

describe('lembrete da noite', () => {
  const prefs = (patch: Partial<Preferences> = {}): Preferences => {
    const base = testPrefs();
    return {
      ...base,
      notifications: { ...base.notifications, channel: 'local' },
      consents: { ...base.consents, notifications: decidedConsent('notifications', true, NOW.toISOString()) },
      nightly: { ...base.nightly, reminder: { enabled: true, time: '20:15' } },
      ...patch,
    };
  };

  it('dispara uma vez no horário escolhido, mesmo na janela silenciosa', () => {
    const p = prefs({ notifications: { channel: 'local', quietStart: '20:00', quietEnd: '07:00', allowedDays: [1], maxPerDay: 1 } });
    const due = dueNightReminder({ now: NOW, timeZone: TZ, prefs: p, permission: 'granted', sentToday: new Set() });
    expect(due).toMatchObject({ id: nightReminderLogId('2026-10-18'), title: 'Sessão da noite' });
    expect(dueNightReminder({ now: NOW, timeZone: TZ, prefs: p, permission: 'granted', sentToday: new Set([nightReminderLogId('2026-10-18')]) })).toBeNull();
  });

  it('respeita o desligamento, a permissão e a tolerância de horário', () => {
    expect(dueNightReminder({ now: NOW, timeZone: TZ, prefs: prefs({ nightly: { ...testPrefs().nightly, reminder: { enabled: false, time: '20:15' } } }), permission: 'granted', sentToday: new Set() })).toBeNull();
    expect(dueNightReminder({ now: NOW, timeZone: TZ, prefs: prefs(), permission: 'denied', sentToday: new Set() })).toBeNull();
    expect(dueNightReminder({ now: new Date('2026-10-18T23:00:00.000Z'), timeZone: TZ, prefs: prefs(), permission: 'granted', sentToday: new Set() })).toBeNull(); // 20:00, antes
    expect(dueNightReminder({ now: new Date('2026-10-19T00:00:00.000Z'), timeZone: TZ, prefs: prefs(), permission: 'granted', sentToday: new Set() })).toBeNull(); // 21:00, passou da tolerância
  });
});
