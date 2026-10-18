import { describe, expect, it } from 'vitest';
import { todayInZone } from '../../src/domain/civil';
import {
  describeSchedule,
  isScheduledOn,
  occurrencesBetween,
  withPauseEnded,
  withPauseStarted,
  withScheduleChange,
} from '../../src/domain/schedule';
import type { CompletionStatus } from '../../src/domain/schemas';
import { habitStatsBetween, lookupFor } from '../../src/domain/stats';
import { computeStreak } from '../../src/domain/streak';
import { deriveProgressEvents, levelForXp, levelProgress, totalXp, xpForLevel } from '../../src/domain/xp';
import { testCompletion, testGoal, testHabit } from '../fixtures/builders';

const map = (entries: Array<[string, CompletionStatus]>) => new Map(entries);

describe('agenda do hábito', () => {
  it('respeita início, dias da semana e pausas', () => {
    const h = testHabit({
      id: 'h1',
      scheduleHistory: [{ from: '2026-10-05', schedule: { kind: 'weekly', days: [1, 3, 5] } }],
      pauses: [{ from: '2026-10-12', to: '2026-10-14' }],
    });
    expect(isScheduledOn(h, '2026-10-02')).toBe(false); // antes do início
    expect(isScheduledOn(h, '2026-10-05')).toBe(true); // seg
    expect(isScheduledOn(h, '2026-10-06')).toBe(false); // ter
    expect(isScheduledOn(h, '2026-10-12')).toBe(false); // seg, pausado
    expect(isScheduledOn(h, '2026-10-16')).toBe(true); // sex
    expect(occurrencesBetween(h, '2026-10-01', '2026-10-18')).toEqual(['2026-10-05', '2026-10-07', '2026-10-09', '2026-10-16']);
  });

  it('mudança de frequência vale a partir da data efetiva e preserva o passado', () => {
    const h = testHabit({ id: 'h1', scheduleHistory: [{ from: '2026-10-01', schedule: { kind: 'daily' } }] });
    const history = withScheduleChange(h.scheduleHistory, { kind: 'weekly', days: [6] }, '2026-10-15');
    const changed = { ...h, scheduleHistory: history };
    expect(isScheduledOn(changed, '2026-10-14')).toBe(true); // quarta, ainda diário
    expect(isScheduledOn(changed, '2026-10-16')).toBe(false); // sexta, agora só sábado
    expect(isScheduledOn(changed, '2026-10-17')).toBe(true); // sábado
    expect(withScheduleChange(history, { kind: 'weekly', days: [6] }, '2026-10-20')).toEqual(history);
  });

  it('pausa e retomada no mesmo dia não deixam rastro', () => {
    const paused = withPauseStarted([], '2026-10-17');
    expect(paused).toEqual([{ from: '2026-10-17' }]);
    expect(withPauseEnded(paused, '2026-10-17')).toEqual([]);
    expect(withPauseEnded(paused, '2026-10-20')).toEqual([{ from: '2026-10-17', to: '2026-10-19' }]);
  });

  it('descreve frequências em português', () => {
    expect(describeSchedule({ kind: 'daily' })).toBe('Todos os dias');
    expect(describeSchedule({ kind: 'weekly', days: [1, 2, 3, 4, 5] })).toBe('Dias úteis (seg a sex)');
    expect(describeSchedule({ kind: 'weekly', days: [1, 3, 5] })).toBe('seg, qua e sex');
    expect(describeSchedule({ kind: 'weekly', days: [7] })).toBe('Todo domingo');
  });
});

describe('streak calculado contra a agenda', () => {
  const weekly = testHabit({
    id: 'h1',
    scheduleHistory: [{ from: '2026-10-05', schedule: { kind: 'weekly', days: [1, 3, 5] } }],
  });

  it('dias sem ocorrência prevista não quebram a sequência', () => {
    const c = map([
      ['2026-10-05', 'done'],
      ['2026-10-07', 'done'],
      ['2026-10-09', 'done'],
      ['2026-10-12', 'done'],
    ]);
    // 13/10 (ter) e 14/10 antes do horário: terça não é prevista; quarta 14 ainda é "hoje"
    expect(computeStreak(weekly, c, '2026-10-14')).toMatchObject({ current: 4, best: 4, todayOpen: true });
    expect(computeStreak(weekly, c, '2026-10-13')).toMatchObject({ current: 4, todayOpen: false });
  });

  it('uma ocorrência prevista perdida zera a sequência atual, mas mantém a melhor', () => {
    const c = map([
      ['2026-10-05', 'done'],
      ['2026-10-07', 'done'],
      ['2026-10-12', 'done'],
    ]);
    expect(computeStreak(weekly, c, '2026-10-13')).toMatchObject({ current: 1, best: 2 });
  });

  it('conclusão duplicada não soma duas vezes e desfazer recalcula', () => {
    const completions = [testCompletion('h1', '2026-10-05'), testCompletion('h1', '2026-10-05'), testCompletion('h1', '2026-10-07')];
    const lookup = lookupFor('h1', completions);
    expect(computeStreak(weekly, lookup, '2026-10-08').current).toBe(2);
    const undone = lookupFor('h1', completions.filter((c) => c.scheduledDate !== '2026-10-07'));
    expect(computeStreak(weekly, undone, '2026-10-08').current).toBe(0);
  });

  it('ocorrência pulada é neutra', () => {
    const c = map([
      ['2026-10-05', 'done'],
      ['2026-10-07', 'skipped'],
      ['2026-10-09', 'done'],
    ]);
    expect(computeStreak(weekly, c, '2026-10-10')).toMatchObject({ current: 2, best: 2 });
  });

  it('pausas não quebram a sequência', () => {
    const daily = testHabit({ id: 'h2', scheduleHistory: [{ from: '2026-10-10', schedule: { kind: 'daily' } }], pauses: [{ from: '2026-10-12', to: '2026-10-13' }] });
    const c = map([
      ['2026-10-10', 'done'],
      ['2026-10-11', 'done'],
      ['2026-10-14', 'done'],
    ]);
    expect(computeStreak(daily, c, '2026-10-14').current).toBe(3);
  });

  it('mudança de timezone não desloca o dia local das conclusões', () => {
    const daily = testHabit({ id: 'h3', scheduleHistory: [{ from: '2026-10-15', schedule: { kind: 'daily' } }] });
    // Concluído às 23:30 de 17/10 em São Paulo (02:30Z de 18/10).
    const completions = [
      testCompletion('h3', '2026-10-15'),
      testCompletion('h3', '2026-10-16'),
      testCompletion('h3', '2026-10-17', { completedAt: '2026-10-18T02:30:00.000Z' }),
    ];
    const lookup = lookupFor('h3', completions);
    const instant = new Date('2026-10-18T02:45:00Z');
    const todaySp = todayInZone('America/Sao_Paulo', instant);
    const todayLisbon = todayInZone('Europe/Lisbon', instant);
    expect(todaySp).toBe('2026-10-17');
    expect(todayLisbon).toBe('2026-10-18');
    expect(computeStreak(daily, lookup, todaySp)).toMatchObject({ current: 3, todayOpen: false });
    // Após mudar o perfil para Lisboa, 17/10 continua concluído e 18/10 está em aberto.
    expect(computeStreak(daily, lookup, todayLisbon)).toMatchObject({ current: 3, todayOpen: true });
  });

  it('a transição de horário de verão não cria nem remove dias', () => {
    const daily = testHabit({ id: 'h4', scheduleHistory: [{ from: '2026-03-07', schedule: { kind: 'daily' } }] });
    const lookup = map([
      ['2026-03-07', 'done'],
      ['2026-03-08', 'done'], // dia de 23h em Nova York
      ['2026-03-09', 'done'],
    ]);
    expect(occurrencesBetween(daily, '2026-03-07', '2026-03-09')).toHaveLength(3);
    expect(computeStreak(daily, lookup, todayInZone('America/New_York', new Date('2026-03-09T23:00:00Z'))).current).toBe(3);
  });
});

describe('taxa de conclusão', () => {
  it('não penaliza o dia de hoje em aberto e exclui puladas', () => {
    const h = testHabit({ id: 'h1', scheduleHistory: [{ from: '2026-10-10', schedule: { kind: 'daily' } }] });
    const c = map([
      ['2026-10-10', 'done'],
      ['2026-10-11', 'skipped'],
      ['2026-10-13', 'done'],
      ['2026-10-09', 'done'], // antes do início: não conta como prevista
    ]);
    const s = habitStatsBetween(h, c, '2026-10-01', '2026-10-31', '2026-10-14');
    expect(s).toMatchObject({ scheduled: 5, done: 2, skipped: 1, missed: 1, open: 1 });
    expect(s.rate).toBeCloseTo(2 / 3);
  });

  it('sem ocorrências encerradas a taxa não existe', () => {
    const h = testHabit({ id: 'h1', scheduleHistory: [{ from: '2026-10-17', schedule: { kind: 'daily' } }] });
    expect(habitStatsBetween(h, new Map(), '2026-10-17', '2026-10-17', '2026-10-17').rate).toBeNull();
  });
});

describe('XP e nível', () => {
  it('segue a curva documentada', () => {
    expect(xpForLevel(1)).toBe(0);
    expect(xpForLevel(2)).toBe(100);
    expect(xpForLevel(3)).toBe(300);
    expect(levelForXp(0)).toBe(1);
    expect(levelForXp(99)).toBe(1);
    expect(levelForXp(100)).toBe(2);
    expect(levelForXp(299)).toBe(2);
    expect(levelForXp(300)).toBe(3);
    expect(levelProgress(120)).toMatchObject({ level: 2, intoLevel: 20, levelSpan: 200 });
  });

  it('é reproduzível a partir do histórico e ignora puladas', () => {
    const sources = {
      habitCompletions: [
        testCompletion('h1', '2026-10-10', { xpAwarded: 10 }),
        testCompletion('h1', '2026-10-11', { status: 'skipped', xpAwarded: 0 }),
        testCompletion('h2', '2026-10-11', { xpAwarded: 25 }),
      ],
      agendaCompletions: [
        { id: 't1|2026-10-12', itemId: 't1', occurrenceDate: '2026-10-12', completedAt: '2026-10-12T10:00:00.000Z', timezone: 'America/Sao_Paulo', xpAwarded: 5 },
        { id: 'e1|2026-10-12', itemId: 'e1', occurrenceDate: '2026-10-12', completedAt: '2026-10-12T10:00:00.000Z', timezone: 'America/Sao_Paulo', xpAwarded: 0 },
      ],
      goals: [
        testGoal({ id: 'g1', horizon: 'week', status: 'completed', completedAt: '2026-10-12T10:00:00.000Z', completedOn: '2026-10-12' }),
        testGoal({ id: 'g2' }),
      ],
    };
    const a = deriveProgressEvents(sources);
    const b = deriveProgressEvents(sources);
    expect(a).toEqual(b);
    expect(a.map((e) => e.id)).toEqual(['agenda:t1|2026-10-12', 'goal:g1', 'habit:h1|2026-10-10', 'habit:h2|2026-10-11']);
    expect(totalXp(a)).toBe(10 + 25 + 5 + 20);
  });
});
