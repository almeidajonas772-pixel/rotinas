import {
  endOfMonth,
  endOfWeek,
  endOfYear,
  rangesOverlap,
  startOfMonth,
  startOfWeek,
  startOfYear,
  type CivilDate,
  type WeekStart,
} from './civil';
import { formatShortDate } from './format';
import type {
  AgendaCompletion,
  AgendaItem,
  Goal,
  GoalHorizon,
  GoalProgressEntry,
  Habit,
  HabitCompletion,
} from './schemas';

export const HORIZON_LABEL: Record<GoalHorizon, string> = {
  year: 'Anual',
  month: 'Mensal',
  week: 'Semanal',
  day: 'Diária',
};

export const HORIZON_PLURAL: Record<GoalHorizon, string> = {
  year: 'Anuais',
  month: 'Mensais',
  week: 'Semanais',
  day: 'Diárias',
};

export const HORIZON_ORDER: readonly GoalHorizon[] = ['year', 'month', 'week', 'day'];

const RANK: Record<GoalHorizon, number> = { year: 0, month: 1, week: 2, day: 3 };

export function horizonRank(h: GoalHorizon): number {
  return RANK[h];
}

/** Período padrão do horizonte que contém `anchor`. */
export function periodFor(horizon: GoalHorizon, anchor: CivilDate, weekStartsOn: WeekStart): { start: CivilDate; end: CivilDate } {
  switch (horizon) {
    case 'year':
      return { start: startOfYear(anchor), end: endOfYear(anchor) };
    case 'month':
      return { start: startOfMonth(anchor), end: endOfMonth(anchor) };
    case 'week':
      return { start: startOfWeek(anchor, weekStartsOn), end: endOfWeek(anchor, weekStartsOn) };
    case 'day':
      return { start: anchor, end: anchor };
  }
}

/**
 * Vínculo pai → filha é opcional. Quando usado, a meta pai precisa ser de um horizonte
 * mais longo e os períodos precisam se sobrepor (ex.: uma meta semanal que cruza o fim
 * do mês ainda pode pertencer à meta mensal).
 */
export function parentProblem(parent: Pick<Goal, 'id' | 'horizon' | 'periodStart' | 'periodEnd' | 'status'>, child: Pick<Goal, 'id' | 'horizon' | 'periodStart' | 'periodEnd'>, all: readonly Goal[]): string | null {
  if (parent.id === child.id) return 'Uma meta não pode ser filha dela mesma.';
  if (parent.status === 'archived') return 'A meta escolhida está arquivada.';
  if (horizonRank(parent.horizon) >= horizonRank(child.horizon)) {
    return 'A meta pai precisa ter um horizonte mais longo (ex.: anual → mensal → semanal → diária).';
  }
  if (!rangesOverlap(parent.periodStart, parent.periodEnd, child.periodStart, child.periodEnd)) {
    return 'Os períodos das duas metas não se cruzam.';
  }
  // Evita ciclos: a pai não pode descender da filha.
  const byId = new Map(all.map((g) => [g.id, g]));
  let cursor: Goal | undefined = byId.get(parent.id);
  const seen = new Set<string>();
  while (cursor?.parentId && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    if (cursor.parentId === child.id) return 'Esse vínculo criaria um ciclo entre metas.';
    cursor = byId.get(cursor.parentId);
  }
  return null;
}

export function descendantIds(goalId: string, all: readonly Goal[]): Set<string> {
  const children = new Map<string, string[]>();
  for (const g of all) {
    if (!g.parentId) continue;
    const list = children.get(g.parentId) ?? [];
    list.push(g.id);
    children.set(g.parentId, list);
  }
  const out = new Set<string>();
  const stack = [...(children.get(goalId) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    stack.push(...(children.get(id) ?? []));
  }
  return out;
}

export interface GoalProgressContext {
  goals: readonly Goal[];
  habits: readonly Pick<Habit, 'id' | 'goalId' | 'title'>[];
  agendaItems: readonly Pick<AgendaItem, 'id' | 'goalId' | 'kind' | 'title'>[];
  habitCompletions: readonly Pick<HabitCompletion, 'habitId' | 'scheduledDate' | 'status'>[];
  agendaCompletions: readonly Pick<AgendaCompletion, 'itemId' | 'occurrenceDate'>[];
  progressEntries: readonly GoalProgressEntry[];
}

export interface GoalProgress {
  kind: Goal['progressRule']['kind'];
  current: number;
  target: number | null;
  /** 0..1 quando há alvo; null quando o progresso não é mensurável. */
  ratio: number | null;
  unit: string;
  reached: boolean;
  /** true quando o valor vem de atualização manual da pessoa. */
  manual: boolean;
  explanation: string;
  linkedHabitIds: string[];
  linkedTaskIds: string[];
}

export function linkedItems(goal: Pick<Goal, 'id'>, ctx: Pick<GoalProgressContext, 'habits' | 'agendaItems' | 'goals'>, includeDescendants: boolean) {
  const ids = new Set<string>([goal.id]);
  if (includeDescendants) for (const d of descendantIds(goal.id, ctx.goals)) ids.add(d);
  const habits = ctx.habits.filter((h) => h.goalId !== undefined && ids.has(h.goalId));
  const tasks = ctx.agendaItems.filter((i) => i.goalId !== undefined && ids.has(i.goalId) && i.kind !== 'habit');
  return { goalIds: ids, habits, tasks };
}

export function computeGoalProgress(goal: Goal, ctx: GoalProgressContext): GoalProgress {
  const rule = goal.progressRule;
  const direct = linkedItems(goal, ctx, false);
  const base = {
    kind: rule.kind,
    linkedHabitIds: direct.habits.map((h) => h.id),
    linkedTaskIds: direct.tasks.map((t) => t.id),
  };
  const period = `${formatShortDate(goal.periodStart)} a ${formatShortDate(goal.periodEnd)}`;

  switch (rule.kind) {
    case 'manual_completion': {
      const done = goal.status === 'completed';
      return {
        ...base,
        current: done ? 1 : 0,
        target: 1,
        ratio: done ? 1 : 0,
        unit: 'conclusão',
        reached: done,
        manual: true,
        explanation: 'Conclusão manual: a meta conta como cumprida quando você a marca como concluída.',
      };
    }
    case 'manual_value': {
      const entries = ctx.progressEntries
        .filter((e) => e.goalId === goal.id)
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
      const last = entries[entries.length - 1];
      const current = last ? last.value : 0;
      return {
        ...base,
        current,
        target: rule.target,
        ratio: Math.min(1, current / rule.target),
        unit: rule.unit,
        reached: current >= rule.target,
        manual: true,
        explanation: last
          ? `Valor informado manualmente por você (${entries.length} atualização${entries.length === 1 ? '' : 'ões'}). Hábitos e tarefas não alteram este número.`
          : 'Valor informado manualmente por você. Nenhuma atualização registrada ainda.',
      };
    }
    case 'linked_completions': {
      const linked = linkedItems(goal, ctx, rule.includeDescendants);
      const habitIds = new Set(linked.habits.map((h) => h.id));
      const taskIds = new Set(linked.tasks.map((t) => t.id));
      const habitDone = ctx.habitCompletions.filter(
        (c) => c.status === 'done' && habitIds.has(c.habitId) && c.scheduledDate >= goal.periodStart && c.scheduledDate <= goal.periodEnd,
      ).length;
      const taskDone = ctx.agendaCompletions.filter(
        (c) => taskIds.has(c.itemId) && c.occurrenceDate >= goal.periodStart && c.occurrenceDate <= goal.periodEnd,
      ).length;
      const current = habitDone + taskDone;
      const scope = rule.includeDescendants ? ' (incluindo itens das metas filhas)' : '';
      const noLinks = linked.habits.length === 0 && linked.tasks.length === 0;
      return {
        ...base,
        current,
        target: rule.target,
        ratio: Math.min(1, current / rule.target),
        unit: rule.unit,
        reached: current >= rule.target,
        manual: false,
        explanation: noLinks
          ? `Esta meta soma conclusões de hábitos e tarefas vinculados${scope}, mas ainda não há itens vinculados. Vincule um hábito ou tarefa para o progresso começar a contar.`
          : `Soma das conclusões registradas de ${linked.habits.length} hábito${linked.habits.length === 1 ? '' : 's'} e ${linked.tasks.length} tarefa${linked.tasks.length === 1 ? '' : 's'} vinculados${scope}, entre ${period}.`,
      };
    }
    case 'child_goals': {
      const children = ctx.goals.filter((g) => g.parentId === goal.id && g.status !== 'archived');
      const done = children.filter((g) => g.status === 'completed').length;
      if (children.length === 0) {
        return {
          ...base,
          current: 0,
          target: null,
          ratio: null,
          unit: 'metas filhas',
          reached: false,
          manual: false,
          explanation: 'O progresso vem das metas filhas concluídas, mas nenhuma meta filha foi vinculada ainda.',
        };
      }
      return {
        ...base,
        current: done,
        target: children.length,
        ratio: done / children.length,
        unit: 'metas filhas',
        reached: done === children.length,
        manual: false,
        explanation: `Metas filhas concluídas: ${done} de ${children.length} (arquivadas não contam).`,
      };
    }
  }
}

export function goalIsCurrent(goal: Pick<Goal, 'periodStart' | 'periodEnd'>, today: CivilDate): boolean {
  return goal.periodStart <= today && today <= goal.periodEnd;
}

export function goalTimeState(goal: Pick<Goal, 'periodStart' | 'periodEnd'>, today: CivilDate): 'upcoming' | 'current' | 'past' {
  if (today < goal.periodStart) return 'upcoming';
  if (today > goal.periodEnd) return 'past';
  return 'current';
}
