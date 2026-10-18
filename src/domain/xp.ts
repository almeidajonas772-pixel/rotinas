import type { AgendaCompletion, Goal, GoalHorizon, HabitCompletion, ProgressEvent } from './schemas';

/**
 * XP e nível são sempre reproduzíveis a partir do histórico:
 * - cada conclusão de hábito registrada gera um evento `habit:<id da conclusão>` com o XP
 *   gravado no momento da conclusão (mudar o XP do hábito depois não reescreve o passado);
 * - cada conclusão de tarefa (ou item da agenda com XP definido) gera `agenda:<id>`;
 * - concluir uma meta gera `goal:<id>` com XP fixo por horizonte;
 * - pular, abrir telas, escrever no diário ou fazer check-in não gera XP.
 * Os ids determinísticos tornam a gravação idempotente; desfazer remove o evento.
 */

export const GOAL_COMPLETION_XP: Record<GoalHorizon, number> = { day: 5, week: 20, month: 50, year: 150 };

export const DEFAULT_HABIT_XP = 10;
export const DEFAULT_TASK_XP = 5;

/** XP acumulado necessário para atingir o nível `level` (nível 1 = 0 XP; cada nível pede 100 XP a mais que o anterior). */
export function xpForLevel(level: number): number {
  const l = Math.max(1, Math.floor(level));
  return 50 * l * (l - 1);
}

export function levelForXp(xp: number): number {
  const safe = Math.max(0, Math.floor(xp));
  let level = Math.max(1, Math.floor((1 + Math.sqrt(1 + (4 * safe) / 50)) / 2));
  while (xpForLevel(level + 1) <= safe) level += 1;
  while (level > 1 && xpForLevel(level) > safe) level -= 1;
  return level;
}

export interface LevelProgress {
  xp: number;
  level: number;
  levelStartXp: number;
  nextLevelXp: number;
  intoLevel: number;
  levelSpan: number;
}

export function levelProgress(xp: number): LevelProgress {
  const level = levelForXp(xp);
  const levelStartXp = xpForLevel(level);
  const nextLevelXp = xpForLevel(level + 1);
  return { xp, level, levelStartXp, nextLevelXp, intoLevel: xp - levelStartXp, levelSpan: nextLevelXp - levelStartXp };
}

export const habitEventId = (completionId: string) => `habit:${completionId}`;
export const agendaEventId = (completionId: string) => `agenda:${completionId}`;
export const goalEventId = (goalId: string) => `goal:${goalId}`;

export function habitEvent(c: HabitCompletion): ProgressEvent | null {
  if (c.status !== 'done') return null;
  return { id: habitEventId(c.id), type: 'habit_completed', refId: c.id, xp: c.xpAwarded, occurredAt: c.completedAt, localDate: c.scheduledDate };
}

export function agendaEvent(c: AgendaCompletion): ProgressEvent | null {
  if (c.xpAwarded <= 0) return null;
  return { id: agendaEventId(c.id), type: 'agenda_completed', refId: c.id, xp: c.xpAwarded, occurredAt: c.completedAt, localDate: c.occurrenceDate };
}

/** Metas concluídas geram XP; arquivar depois de concluir não apaga a conclusão. */
export function goalEvent(g: Goal): ProgressEvent | null {
  if (g.status === 'active' || !g.completedAt || !g.completedOn) return null;
  return { id: goalEventId(g.id), type: 'goal_completed', refId: g.id, xp: GOAL_COMPLETION_XP[g.horizon], occurredAt: g.completedAt, localDate: g.completedOn };
}

/** Reconstrói todos os eventos de progresso a partir das fontes (conclusões e metas). */
export function deriveProgressEvents(sources: {
  habitCompletions: readonly HabitCompletion[];
  agendaCompletions: readonly AgendaCompletion[];
  goals: readonly Goal[];
}): ProgressEvent[] {
  const events: ProgressEvent[] = [];
  for (const c of sources.habitCompletions) {
    const e = habitEvent(c);
    if (e) events.push(e);
  }
  for (const c of sources.agendaCompletions) {
    const e = agendaEvent(c);
    if (e) events.push(e);
  }
  for (const g of sources.goals) {
    const e = goalEvent(g);
    if (e) events.push(e);
  }
  return events.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function totalXp(events: readonly Pick<ProgressEvent, 'xp'>[]): number {
  return events.reduce((sum, e) => sum + e.xp, 0);
}
