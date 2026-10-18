import { describe, expect, it } from 'vitest';
import {
  deleteOccurrence,
  editThisOccurrence,
  expandAgenda,
  expandItemRaw,
  habitOccurrencesForAgenda,
  seriesDates,
  splitSeries,
} from '../../src/domain/agenda';
import { computeGoalProgress, parentProblem, periodFor, type GoalProgressContext } from '../../src/domain/goals';
import { testCompletion, testGoal, testHabit, testItem } from '../fixtures/builders';

const NOW = '2026-10-17T12:00:00.000Z';

function ctx(partial: Partial<GoalProgressContext>): GoalProgressContext {
  return { goals: [], habits: [], agendaItems: [], habitCompletions: [], agendaCompletions: [], progressEntries: [], ...partial };
}

describe('metas em quatro horizontes', () => {
  it('calcula o período padrão de cada horizonte', () => {
    expect(periodFor('year', '2026-10-17', 1)).toEqual({ start: '2026-01-01', end: '2026-12-31' });
    expect(periodFor('month', '2026-10-17', 1)).toEqual({ start: '2026-10-01', end: '2026-10-31' });
    expect(periodFor('week', '2026-10-17', 1)).toEqual({ start: '2026-10-12', end: '2026-10-18' });
    expect(periodFor('week', '2026-10-17', 0)).toEqual({ start: '2026-10-11', end: '2026-10-17' });
    expect(periodFor('day', '2026-10-17', 1)).toEqual({ start: '2026-10-17', end: '2026-10-17' });
  });

  it('vínculo é opcional, exige horizonte mais longo, períodos que se cruzam e não aceita ciclos', () => {
    const year = testGoal({ id: 'y', horizon: 'year', periodStart: '2026-01-01', periodEnd: '2026-12-31' });
    const month = testGoal({ id: 'm', horizon: 'month', parentId: 'y' });
    const week = testGoal({ id: 'w', horizon: 'week', periodStart: '2026-09-28', periodEnd: '2026-10-04' });
    const all = [year, month, week];
    expect(parentProblem(year, month, all)).toBeNull();
    expect(parentProblem(month, week, all)).toBeNull(); // semana que cruza o início do mês
    expect(parentProblem(month, year, all)).toMatch(/horizonte mais longo/);
    expect(parentProblem(testGoal({ id: 'm2', horizon: 'month', periodStart: '2026-12-01', periodEnd: '2026-12-31' }), week, all)).toMatch(/não se cruzam/);
    const cyc = [testGoal({ id: 'a', horizon: 'year', periodStart: '2026-01-01', periodEnd: '2026-12-31', parentId: 'b' }), testGoal({ id: 'b', horizon: 'month' })];
    expect(parentProblem(cyc[0], cyc[1], cyc)).toMatch(/ciclo/);
  });

  it('progresso automático só existe quando há regra de vínculo — e conta só conclusões reais do período', () => {
    const goal = testGoal({ id: 'g', progressRule: { kind: 'linked_completions', target: 10, unit: 'sessões', includeDescendants: false } });
    const habit = testHabit({ id: 'h', goalId: 'g' });
    const other = testHabit({ id: 'x' });
    const task = testItem({ id: 't', kind: 'task', goalId: 'g', date: '2026-10-20', allDay: true, startTime: undefined, endTime: undefined, xp: 5 });
    const p = computeGoalProgress(
      goal,
      ctx({
        goals: [goal],
        habits: [habit, other],
        agendaItems: [task],
        habitCompletions: [
          testCompletion('h', '2026-10-02'),
          testCompletion('h', '2026-10-03', { status: 'skipped' }),
          testCompletion('h', '2026-09-30'), // fora do período
          testCompletion('x', '2026-10-02'), // hábito não vinculado
        ],
        agendaCompletions: [{ itemId: 't', occurrenceDate: '2026-10-20' }],
      }),
    );
    expect(p).toMatchObject({ current: 2, target: 10, manual: false, reached: false });
    expect(p.ratio).toBeCloseTo(0.2);
    expect(p.explanation).toMatch(/1 hábito e 1 tarefa/);
  });

  it('inclui itens das metas filhas somente quando a regra pede', () => {
    const parent = testGoal({ id: 'p', horizon: 'year', periodStart: '2026-01-01', periodEnd: '2026-12-31', progressRule: { kind: 'linked_completions', target: 100, unit: 'conclusões', includeDescendants: true } });
    const child = testGoal({ id: 'c', parentId: 'p' });
    const habit = testHabit({ id: 'h', goalId: 'c' });
    const context = ctx({ goals: [parent, child], habits: [habit], habitCompletions: [testCompletion('h', '2026-10-05')] });
    expect(computeGoalProgress(parent, context).current).toBe(1);
    const strict = { ...parent, progressRule: { kind: 'linked_completions' as const, target: 100, unit: 'conclusões', includeDescendants: false } };
    expect(computeGoalProgress(strict, context).current).toBe(0);
  });

  it('progresso manual é identificado e usa a última atualização', () => {
    const goal = testGoal({ id: 'g', progressRule: { kind: 'manual_value', target: 12, unit: 'livros' } });
    const p = computeGoalProgress(
      goal,
      ctx({
        goals: [goal],
        progressEntries: [
          { id: 'e1', goalId: 'g', value: 2, source: 'manual', createdAt: '2026-10-02T10:00:00.000Z' },
          { id: 'e2', goalId: 'g', value: 3, source: 'manual', createdAt: '2026-10-10T10:00:00.000Z' },
        ],
      }),
    );
    expect(p).toMatchObject({ current: 3, target: 12, manual: true });
  });

  it('meta por metas filhas e meta de conclusão manual', () => {
    const parent = testGoal({ id: 'p', horizon: 'year', periodStart: '2026-01-01', periodEnd: '2026-12-31', progressRule: { kind: 'child_goals' } });
    const done = testGoal({ id: 'a', parentId: 'p', status: 'completed', completedAt: NOW, completedOn: '2026-10-17' });
    const open = testGoal({ id: 'b', parentId: 'p' });
    const archived = testGoal({ id: 'c', parentId: 'p', status: 'archived' });
    expect(computeGoalProgress(parent, ctx({ goals: [parent, done, open, archived] }))).toMatchObject({ current: 1, target: 2 });
    expect(computeGoalProgress(parent, ctx({ goals: [parent] }))).toMatchObject({ target: null, ratio: null });
    const manual = testGoal({ id: 'm' });
    expect(computeGoalProgress(manual, ctx({ goals: [manual] }))).toMatchObject({ current: 0, manual: true });
  });
});

describe('agenda nativa: recorrência, exceções e fuso', () => {
  it('gera ocorrências diárias com intervalo e limite de vezes', () => {
    const item = testItem({ id: 'a', date: '2026-10-01', recurrence: { freq: 'daily', interval: 2, count: 4 } });
    expect(seriesDates(item, '2026-10-01', '2026-10-31')).toEqual(['2026-10-01', '2026-10-03', '2026-10-05', '2026-10-07']);
    expect(seriesDates(item, '2026-10-04', '2026-10-31')).toEqual(['2026-10-05', '2026-10-07']);
  });

  it('gera ocorrências semanais em dias escolhidos, a cada duas semanas, até uma data', () => {
    const item = testItem({ id: 'b', date: '2026-10-05', recurrence: { freq: 'weekly', interval: 2, byWeekday: [1, 3], until: '2026-11-04' } });
    expect(seriesDates(item, '2026-10-01', '2026-11-30')).toEqual(['2026-10-05', '2026-10-07', '2026-10-19', '2026-10-21', '2026-11-02', '2026-11-04']);
  });

  it('"somente esta" altera ou move uma única ocorrência', () => {
    const item = testItem({ id: 'c', date: '2026-10-05', recurrence: { freq: 'weekly', interval: 1, byWeekday: [1] } });
    const moved = editThisOccurrence(item, '2026-10-12', { date: '2026-10-13', startTime: '11:00' }, NOW);
    const occ = expandItemRaw(moved, '2026-10-01', '2026-10-31');
    expect(occ.map((o) => [o.originalDate, o.date, o.startTime])).toEqual([
      ['2026-10-05', '2026-10-05', '09:00'],
      ['2026-10-12', '2026-10-13', '11:00'],
      ['2026-10-19', '2026-10-19', '09:00'],
      ['2026-10-26', '2026-10-26', '09:00'],
    ]);
    // Movida para dentro de um intervalo que não contém a data original.
    expect(expandItemRaw(moved, '2026-10-13', '2026-10-13').map((o) => o.originalDate)).toEqual(['2026-10-12']);
  });

  it('"esta e as próximas" divide a série sem alterar o passado', () => {
    const item = testItem({ id: 'd', date: '2026-10-05', recurrence: { freq: 'weekly', interval: 1, byWeekday: [1], count: 6 } });
    const { previous, next } = splitSeries(item, '2026-10-19', { startTime: '18:00', endTime: '19:00' }, 'd2', NOW);
    expect(previous).not.toBeNull();
    expect(seriesDates(previous!, '2026-10-01', '2026-12-31')).toEqual(['2026-10-05', '2026-10-12']);
    expect(next.id).toBe('d2');
    expect(next.startTime).toBe('18:00');
    expect(seriesDates(next, '2026-10-01', '2026-12-31')).toEqual(['2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09']);
  });

  it('exclui uma ocorrência, as próximas ou a série', () => {
    const item = testItem({ id: 'e', date: '2026-10-05', recurrence: { freq: 'daily', interval: 1 } });
    const one = deleteOccurrence(item, '2026-10-06', 'this', NOW)!;
    expect(seriesDates(one, '2026-10-05', '2026-10-07')).toHaveLength(3);
    expect(expandItemRaw(one, '2026-10-05', '2026-10-07').map((o) => o.date)).toEqual(['2026-10-05', '2026-10-07']);
    const following = deleteOccurrence(item, '2026-10-07', 'following', NOW)!;
    expect(expandItemRaw(following, '2026-10-01', '2026-10-31').map((o) => o.date)).toEqual(['2026-10-05', '2026-10-06']);
    expect(deleteOccurrence(item, '2026-10-05', 'following', NOW)).toBeNull();
    expect(deleteOccurrence(item, '2026-10-09', 'all', NOW)).toBeNull();
  });

  it('exibe horários no fuso atual do perfil e mantém o horário de parede através do horário de verão', () => {
    const item = testItem({ id: 'f', date: '2026-10-17', startTime: '22:30', endTime: '23:30', timezone: 'America/Sao_Paulo' });
    const [occ] = expandAgenda([item], '2026-10-17', '2026-10-18', 'Europe/Lisbon');
    expect(occ).toMatchObject({ date: '2026-10-18', startTime: '02:30', endTime: '03:30', originalDate: '2026-10-17', shiftedZone: 'America/Sao_Paulo' });
    expect(expandAgenda([item], '2026-10-17', '2026-10-17', 'Europe/Lisbon')).toHaveLength(0);

    const ny = testItem({ id: 'g', date: '2026-10-26', timezone: 'America/New_York', startTime: '09:00', endTime: '10:00', recurrence: { freq: 'weekly', interval: 1, byWeekday: [1] } });
    const list = expandAgenda([ny], '2026-10-26', '2026-11-09', 'America/New_York');
    expect(list.map((o) => o.startTime)).toEqual(['09:00', '09:00', '09:00']);
  });

  it('itens de dia inteiro não mudam de data com o fuso', () => {
    const item = testItem({ id: 'h', date: '2026-10-21', allDay: true, startTime: undefined, endTime: undefined });
    expect(expandAgenda([item], '2026-10-21', '2026-10-21', 'Asia/Tokyo')[0].date).toBe('2026-10-21');
  });

  it('mostra hábitos previstos e omite a data que já tem bloco de tempo do mesmo hábito', () => {
    const habit = testHabit({ id: 'hb', timing: { kind: 'time', time: '07:00' }, durationMinutes: 30 });
    const list = habitOccurrencesForAgenda([habit], '2026-10-16', '2026-10-18', [{ kind: 'habit', habitId: 'hb', date: '2026-10-17' }]);
    expect(list.map((o) => [o.date, o.startTime, o.endTime])).toEqual([
      ['2026-10-16', '07:00', '07:30'],
      ['2026-10-18', '07:00', '07:30'],
    ]);
  });
});
