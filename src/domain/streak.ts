import type { CivilDate } from './civil';
import type { CompletionStatus, Habit } from './schemas';
import { habitStartDate, occurrencesBetween } from './schedule';

/**
 * Sequência (streak) calculada contra a agenda do hábito, nunca contando registros soltos:
 * - percorre apenas as ocorrências previstas, em ordem;
 * - ocorrência concluída soma 1;
 * - ocorrência pulada (decisão registrada pela pessoa) é neutra: não soma nem quebra;
 * - a ocorrência de hoje ainda em aberto é neutra (o dia não acabou);
 * - qualquer outra ocorrência prevista sem conclusão quebra a sequência;
 * - dias sem ocorrência prevista são ignorados (não quebram);
 * - conclusões em dias não previstos não entram na sequência.
 * Como as conclusões são indexadas por data civil, duplicatas são impossíveis e
 * desfazer uma conclusão recalcula o resultado automaticamente.
 */

export interface StreakResult {
  current: number;
  best: number;
  /** Ocorrência de hoje prevista e ainda sem registro. */
  todayOpen: boolean;
  lastDone?: CivilDate;
}

export type CompletionLookup = ReadonlyMap<CivilDate, CompletionStatus>;

export function computeStreak(
  habit: Pick<Habit, 'scheduleHistory' | 'pauses'>,
  completions: CompletionLookup,
  today: CivilDate,
): StreakResult {
  const start = habitStartDate(habit);
  if (today < start) return { current: 0, best: 0, todayOpen: false };
  const occurrences = occurrencesBetween(habit, start, today);
  let run = 0;
  let best = 0;
  let lastDone: CivilDate | undefined;
  for (const date of occurrences) {
    const status = completions.get(date);
    if (status === 'done') {
      run += 1;
      best = Math.max(best, run);
      lastDone = date;
    } else if (status === 'skipped') {
      continue;
    } else if (date === today) {
      continue;
    } else {
      run = 0;
    }
  }
  const todayOpen = occurrences[occurrences.length - 1] === today && !completions.has(today);
  return { current: run, best, todayOpen, lastDone };
}
