import { useEffect, useState } from 'react';
import {
  useAgendaCompletions,
  useAgendaItems,
  useCompletions,
  useGoalProgressEntries,
  useGoals,
  useHabits,
  useProgressEvents,
} from '../../db/hooks';
import type { AgendaCompletion, AgendaItem, Goal, GoalProgressEntry, Habit, HabitCompletion } from '../../domain/schemas';
import { levelProgress, totalXp, type LevelProgress } from '../../domain/xp';

/** Contexto completo (entidades inteiras) — compatível com GoalProgressContext. */
export interface FullGoalContext {
  goals: Goal[];
  habits: Habit[];
  agendaItems: AgendaItem[];
  habitCompletions: HabitCompletion[];
  agendaCompletions: AgendaCompletion[];
  progressEntries: GoalProgressEntry[];
}

/** Contexto de cálculo de metas montado a partir das consultas reativas (undefined enquanto carrega). */
export function useGoalContext(): FullGoalContext | undefined {
  const goals = useGoals();
  const habits = useHabits();
  const agendaItems = useAgendaItems();
  const habitCompletions = useCompletions();
  const agendaCompletions = useAgendaCompletions();
  const progressEntries = useGoalProgressEntries();
  if (!goals || !habits || !agendaItems || !habitCompletions || !agendaCompletions || !progressEntries) return undefined;
  return { goals, habits, agendaItems, habitCompletions, agendaCompletions, progressEntries };
}

export function useLevel(): LevelProgress | undefined {
  const events = useProgressEvents();
  if (!events) return undefined;
  return levelProgress(totalXp(events));
}

/** Relógio que atualiza a cada `intervalMs` (padrão: 30 s). */
export function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}
