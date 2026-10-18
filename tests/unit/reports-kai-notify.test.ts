import { describe, expect, it } from 'vitest';
import { assessWeeklyReview, kaiContextSchema } from '../../shared/kai';
import { buildKaiContext, KaiConsentError, type KaiSnapshot } from '../../src/domain/kai-context';
import { resolveEvidence, verifyObservations } from '../../src/domain/kai-evidence';
import { dueReminders, isInQuietHours } from '../../src/domain/notifications-plan';
import { bucketsFor, categoryDistribution, completionSeries, rateSeriesIsMeaningful, resolvePeriod, totalsOf } from '../../src/domain/reports';
import { proposeSlots } from '../../src/domain/slots';
import { groupCompletions } from '../../src/domain/stats';
import { grantAll, testCheckin, testCompletion, testHabit, testJournal, testPrefs, testProfile } from '../fixtures/builders';

describe('relatórios', () => {
  it('cria baldes por tipo de período', () => {
    expect(bucketsFor(resolvePeriod('week', '2026-10-17', 1), 1)).toHaveLength(7);
    expect(bucketsFor(resolvePeriod('month', '2026-10-17', 1), 1)).toHaveLength(31);
    expect(bucketsFor(resolvePeriod('year', '2026-10-17', 1), 1)).toHaveLength(12);
    const custom = resolvePeriod('custom', '2026-10-17', 1, { start: '2026-06-01', end: '2026-10-17' });
    const weeks = bucketsFor(custom, 1);
    expect(weeks.length).toBeGreaterThan(15);
    expect(weeks[0].start).toBe('2026-06-01');
  });

  it('sem hábitos não produz números (estado vazio honesto)', () => {
    const period = resolvePeriod('week', '2026-10-17', 1);
    const points = completionSeries([], new Map(), bucketsFor(period, 1), '2026-10-17');
    expect(totalsOf(points)).toMatchObject({ scheduled: 0, done: 0, rate: null });
    expect(rateSeriesIsMeaningful(points)).toBe(false);
  });

  it('com histórico real calcula previstas × concluídas por dia e ignora dias futuros', () => {
    const h = testHabit({ id: 'h1', category: 'Estudos', scheduleHistory: [{ from: '2026-10-12', schedule: { kind: 'daily' } }] });
    const completions = [testCompletion('h1', '2026-10-12'), testCompletion('h1', '2026-10-14'), testCompletion('h1', '2026-10-15')];
    const period = resolvePeriod('week', '2026-10-15', 1); // 12/10 a 18/10
    const points = completionSeries([h], groupCompletions(completions), bucketsFor(period, 1), '2026-10-15');
    expect(points.map((p) => [p.scheduled, p.done])).toEqual([
      [1, 1],
      [1, 0],
      [1, 1],
      [1, 1],
      [0, 0],
      [0, 0],
      [0, 0],
    ]);
    expect(points.slice(4).every((p) => p.future)).toBe(true);
    expect(totalsOf(points)).toMatchObject({ scheduled: 4, done: 3, missed: 1 });
    expect(categoryDistribution([h], completions, period.start, period.end, '2026-10-15')).toEqual([{ category: 'Estudos', done: 3, scheduled: 4 }]);
  });
});

function snapshot(overrides: Partial<KaiSnapshot> = {}): KaiSnapshot {
  const habit = testHabit({ id: 'habit-uuid-1', title: 'Ler 20 minutos', scheduleHistory: [{ from: '2026-10-01', schedule: { kind: 'daily' } }] });
  return {
    today: '2026-10-17',
    profile: testProfile({ name: 'Leo', mainGoal: 'Estudar com constância' }),
    prefs: grantAll(testPrefs(), ['kai']),
    habits: [habit],
    completions: ['2026-10-10', '2026-10-11', '2026-10-13', '2026-10-15'].map((d) => testCompletion('habit-uuid-1', d)),
    goals: [],
    goalCtx: { goals: [], habits: [habit], agendaItems: [], habitCompletions: [], agendaCompletions: [], progressEntries: [] },
    checkins: [testCheckin('2026-10-12', 4, 3), testCheckin('2026-10-13', 2, 2)],
    journal: [
      testJournal({ id: 'j-allowed', date: '2026-10-14', text: 'Hoje estudei física por uma hora.' }),
      testJournal({ id: 'j-private', date: '2026-10-15', text: 'Assunto privado.', kaiAccess: 'blocked' }),
    ],
    ...overrides,
  };
}

describe('contexto do Kai: mínimo e consentido', () => {
  it('sem consentimento de coaching não monta nada', () => {
    expect(() => buildKaiContext(snapshot({ prefs: testPrefs() }))).toThrow(KaiConsentError);
  });

  it('não envia nome, ids internos, check-ins nem Diário sem consentimentos específicos', () => {
    const built = buildKaiContext(snapshot());
    const json = JSON.stringify(built.context);
    expect(kaiContextSchema.safeParse(built.context).success).toBe(true);
    expect(json).not.toContain('Leo');
    expect(json).not.toContain('habit-uuid-1');
    expect(built.context.checkins).toBeUndefined();
    expect(built.context.journal).toBeUndefined();
    expect(json).not.toContain('estudei física');
    expect(built.refMap).toEqual({ h1: 'habit-uuid-1' });
    expect(built.context.aggregates[0]).toMatchObject({ ref: 'h1', done: 4 });
  });

  it('check-ins exigem o recurso ativo e o consentimento próprio', () => {
    const onlyConsent = grantAll(testPrefs(), ['kai', 'kaiCheckins']);
    expect(buildKaiContext(snapshot({ prefs: onlyConsent })).context.checkins).toBeUndefined();
    const both = { ...onlyConsent, features: { checkins: true } };
    expect(buildKaiContext(snapshot({ prefs: both })).context.checkins).toEqual([
      { date: '2026-10-12', mood: 4, energy: 3 },
      { date: '2026-10-13', mood: 2, energy: 2 },
    ]);
  });

  it('o Diário só entra com consentimento separado e nunca inclui entradas privadas', () => {
    const prefs = grantAll(testPrefs(), ['kai', 'kaiJournal']);
    const built = buildKaiContext(snapshot({ prefs }));
    expect(built.context.journal).toHaveLength(1);
    expect(built.context.journal![0].excerpt).toContain('estudei física');
    expect(JSON.stringify(built.context)).not.toContain('Assunto privado');
    // Revogar o consentimento interrompe o envio futuro.
    const revoked = { ...prefs, consents: { ...prefs.consents, kaiJournal: { ...prefs.consents.kaiJournal, granted: false } } };
    expect(buildKaiContext(snapshot({ prefs: revoked })).context.journal).toBeUndefined();
  });

  it('aplica o limiar mínimo de dados da revisão semanal', () => {
    const few = buildKaiContext(snapshot({ completions: [] }), { period: { start: '2026-10-15', end: '2026-10-17' } });
    expect(assessWeeklyReview(few.context).sufficient).toBe(false);
    const enough = buildKaiContext(snapshot(), { period: { start: '2026-10-04', end: '2026-10-17' } });
    expect(assessWeeklyReview(enough.context).sufficient).toBe(true);
  });

  it('evidências vêm do contexto local; referências inexistentes são descartadas', () => {
    const built = buildKaiContext(snapshot(), { period: { start: '2026-10-04', end: '2026-10-17' } });
    const { items, invalid } = resolveEvidence(['h1', 'h9', 'g1'], built.context);
    expect(items[0].detail).toBe('4 de 13 ocorrências previstas já encerradas foram concluídas (31%), de 04/10 a 17/10; hoje ainda em aberto.');
    expect(invalid).toEqual(['h9', 'g1']);
    const verified = verifyObservations(
      [
        { text: 'ok', evidenceRefs: ['h1'] },
        { text: 'sem base', evidenceRefs: ['h7'] },
      ],
      built.context,
    );
    expect(verified.kept).toHaveLength(1);
    expect(verified.discarded).toBe(1);
  });
});

describe('lembretes locais', () => {
  const habit = testHabit({ id: 'h1', reminder: { enabled: true, time: '07:00' } });
  const base = {
    timeZone: 'America/Sao_Paulo',
    habits: [habit],
    recordedToday: new Set<string>(),
    sentToday: new Set<string>(),
    permission: 'granted' as const,
  };
  const prefsOn = (() => {
    const p = grantAll(testPrefs(), ['notifications']);
    return { ...p, notifications: { ...p.notifications, channel: 'local' as const } };
  })();

  it('janela silenciosa que atravessa a meia-noite', () => {
    expect(isInQuietHours('23:00', '22:00', '07:00')).toBe(true);
    expect(isInQuietHours('06:59', '22:00', '07:00')).toBe(true);
    expect(isInQuietHours('07:00', '22:00', '07:00')).toBe(false);
    expect(isInQuietHours('13:00', '12:00', '14:00')).toBe(true);
  });

  it('só dispara com opt-in, permissão, horário certo e sem repetição', () => {
    const at = new Date('2026-10-17T10:05:00Z'); // 07:05 em São Paulo
    expect(dueReminders({ ...base, now: at, prefs: testPrefs() })).toHaveLength(0);
    expect(dueReminders({ ...base, now: at, prefs: prefsOn, permission: 'denied' })).toHaveLength(0);
    const due = dueReminders({ ...base, now: at, prefs: prefsOn });
    expect(due).toHaveLength(1);
    expect(dueReminders({ ...base, now: at, prefs: prefsOn, sentToday: new Set([due[0].id]) })).toHaveLength(0);
    expect(dueReminders({ ...base, now: at, prefs: prefsOn, recordedToday: new Set(['h1']) })).toHaveLength(0);
    expect(dueReminders({ ...base, now: new Date('2026-10-17T09:55:00Z'), prefs: prefsOn })).toHaveLength(0);
    const quiet = { ...prefsOn, notifications: { ...prefsOn.notifications, quietStart: '06:00', quietEnd: '08:00' } };
    expect(dueReminders({ ...base, now: at, prefs: quiet })).toHaveLength(0);
    const limit = { ...prefsOn, notifications: { ...prefsOn.notifications, maxPerDay: 1 } };
    expect(dueReminders({ ...base, now: at, prefs: limit, sentToday: new Set(['outro']) })).toHaveLength(0);
  });
});

describe('proposta de blocos de tempo', () => {
  it('evita horários ocupados, não propõe o passado e informa conflitos', () => {
    const busy = [{ start: '2026-10-19T10:00:00.000Z', end: '2026-10-19T12:00:00.000Z', source: 'google' as const }]; // 07:00–09:00 SP
    const slots = proposeSlots({
      dates: ['2026-10-19'],
      durationMinutes: 30,
      timeZone: 'America/Sao_Paulo',
      availability: { periods: [], windows: [{ weekdays: [1], start: '07:00', end: '10:00' }] },
      busy,
      now: new Date('2026-10-17T12:00:00Z'),
    });
    expect(slots[0]).toMatchObject({ start: '09:00', end: '09:30', hasFreeSlot: true });
    const full = proposeSlots({
      dates: ['2026-10-19'],
      durationMinutes: 30,
      timeZone: 'America/Sao_Paulo',
      availability: { periods: [], windows: [{ weekdays: [1], start: '07:00', end: '09:00' }] },
      busy,
      now: new Date('2026-10-17T12:00:00Z'),
    });
    expect(full[0].hasFreeSlot).toBe(false);
    expect(full[0].conflicts).toHaveLength(1);
  });
});
