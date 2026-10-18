import type { HabitDraft } from '../../db/repo-habits';
import { isLocalTime, type CivilDate } from '../../domain/civil';
import { currentSchedule, habitStartDate } from '../../domain/schedule';
import type { Habit } from '../../domain/schemas';
import { DEFAULT_HABIT_XP } from '../../domain/xp';

export function emptyHabitDraft(today: CivilDate): HabitDraft {
  return {
    title: '',
    description: '',
    category: 'Saúde',
    schedule: { kind: 'daily' },
    timing: { kind: 'anytime' },
    reminder: { enabled: false },
    xp: DEFAULT_HABIT_XP,
    firstStep: '',
    startDate: today,
  };
}

export function draftFromHabit(habit: Habit): HabitDraft {
  return {
    title: habit.title,
    description: habit.description ?? '',
    category: habit.category,
    schedule: currentSchedule(habit),
    timing: habit.timing,
    durationMinutes: habit.durationMinutes,
    reminder: habit.reminder,
    xp: habit.xp,
    goalId: habit.goalId,
    firstStep: habit.firstStep ?? '',
    startDate: habitStartDate(habit),
  };
}

/** Validação amigável do formulário (o repositório valida de novo com o esquema completo). */
export function validateHabitDraft(d: HabitDraft, today: CivilDate, options: { startLocked?: boolean } = {}): Record<string, string> {
  const errors: Record<string, string> = {};
  if (d.title.trim().length === 0) errors.title = 'Dê um nome ao hábito';
  else if (d.title.trim().length > 80) errors.title = 'Use no máximo 80 caracteres';
  if ((d.description ?? '').length > 500) errors.description = 'Use no máximo 500 caracteres';
  if ((d.firstStep ?? '').length > 200) errors.firstStep = 'Use no máximo 200 caracteres';
  if (d.schedule.kind === 'weekly' && d.schedule.days.length === 0) errors.days = 'Escolha ao menos um dia da semana';
  if (d.timing.kind === 'time' && !isLocalTime(d.timing.time)) errors.time = 'Informe o horário';
  if (d.timing.kind === 'window') {
    if (!isLocalTime(d.timing.start) || !isLocalTime(d.timing.end)) errors.window = 'Informe início e fim da janela';
    else if (d.timing.start >= d.timing.end) errors.window = 'O fim da janela precisa ser depois do início';
  }
  if (d.reminder.enabled && !isLocalTime(d.reminder.time ?? '')) errors.reminder = 'Escolha o horário do lembrete';
  if (!Number.isFinite(d.xp) || d.xp < 0 || d.xp > 100) errors.xp = 'Use um valor entre 0 e 100';
  if (d.durationMinutes !== undefined && (d.durationMinutes < 1 || d.durationMinutes > 600)) errors.duration = 'Use entre 1 e 600 minutos';
  if (!options.startLocked && d.startDate < today) errors.startDate = 'Escolha hoje ou uma data futura';
  return errors;
}

export interface HabitTemplate {
  title: string;
  category: string;
  schedule: HabitDraft['schedule'];
  timing?: HabitDraft['timing'];
  durationMinutes?: number;
  firstStep?: string;
}

/** Modelos para começar mais rápido. São só sugestões: nada é salvo sem a pessoa adicionar e confirmar. */
export const HABIT_TEMPLATES: HabitTemplate[] = [
  { title: 'Beber um copo de água ao acordar', category: 'Saúde', schedule: { kind: 'daily' }, firstStep: 'Deixar o copo ao lado da cama na noite anterior' },
  { title: 'Ler 10 páginas', category: 'Mente', schedule: { kind: 'daily' }, timing: { kind: 'window', start: '20:00', end: '22:00' }, durationMinutes: 20, firstStep: 'Abrir o livro e ler uma página' },
  { title: 'Estudar 30 minutos', category: 'Estudos', schedule: { kind: 'weekly', days: [1, 2, 3, 4, 5] }, durationMinutes: 30, firstStep: 'Separar o material e abrir no primeiro exercício' },
  { title: 'Caminhar 20 minutos', category: 'Saúde', schedule: { kind: 'weekly', days: [1, 3, 5] }, durationMinutes: 20, firstStep: 'Calçar o tênis' },
  { title: 'Planejar o dia seguinte', category: 'Trabalho', schedule: { kind: 'daily' }, timing: { kind: 'time', time: '21:30' }, durationMinutes: 5, firstStep: 'Escrever as três prioridades de amanhã' },
  { title: 'Alongar 5 minutos', category: 'Saúde', schedule: { kind: 'daily' }, durationMinutes: 5, firstStep: 'Fazer um alongamento de pescoço' },
  { title: 'Organizar a mesa', category: 'Casa', schedule: { kind: 'weekly', days: [7] }, durationMinutes: 15, firstStep: 'Guardar três objetos fora do lugar' },
  { title: 'Revisar os gastos da semana', category: 'Finanças pessoais', schedule: { kind: 'weekly', days: [7] }, durationMinutes: 10, firstStep: 'Abrir o extrato da semana' },
];

export function draftFromTemplate(t: HabitTemplate, today: CivilDate): HabitDraft {
  return {
    ...emptyHabitDraft(today),
    title: t.title,
    category: t.category,
    schedule: t.schedule,
    timing: t.timing ?? { kind: 'anytime' },
    durationMinutes: t.durationMinutes,
    firstStep: t.firstStep ?? '',
  };
}
