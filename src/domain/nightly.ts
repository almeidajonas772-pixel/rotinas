import type { GoogleEvent } from '../../shared/calendar';
import { expandAgenda } from './agenda';
import { addDays, diffDays, minutesToTime, nowTimeInZone, timeToMinutes, todayInZone, type CivilDate, type LocalTime } from './civil';
import { formatNumber, weekdayName } from './format';
import { computeGoalProgress, goalIsCurrent, type GoalProgress, type GoalProgressContext } from './goals';
import { isScheduledOn, timingSortKey } from './schedule';
import type { AgendaCompletion, AgendaItem, Checkin, DayPlan, Goal, Habit, HabitCompletion, HabitTiming, Profile, ProgressEvent } from './schemas';
import { windowsForDate, type TimeWindow } from './slots';
import { groupCompletions, habitStatsBetween } from './stats';
import { computeStreak } from './streak';
import { instantToWallTime } from './tz';

/**
 * Resumo da noite, calculado no aparelho a partir dos registros (sem IA). Serve para:
 * - a tela Noite funcionar mesmo sem o Kai (o app lê o próprio resumo em voz alta);
 * - montar os dados da sessão da noite enviados ao Kai (ver nightly-kai.ts).
 * Tudo aqui é determinístico e testável: nenhuma frase é inventada, só descrita a partir dos dados.
 */

/** Antes deste horário, a "noite" ainda é a do dia anterior (para quem fecha o dia depois da meia-noite). */
export const NIGHT_ROLLOVER = '04:00';
/** Janelas livres menores que isto não são sugeridas. */
export const MIN_FREE_MINUTES = 20;
/** Duração assumida para compromissos sem horário de fim. */
export const DEFAULT_BUSY_MINUTES = 30;
/** Quantos dias à frente procurar provas e prazos (a partir de amanhã). */
export const RADAR_DAYS = 7;

export type ItemFlag = 'prova' | 'prazo';

export interface NightHabit {
  habit: Habit;
  status: 'done' | 'skipped' | 'open';
  /** Ainda dá tempo hoje (aberto e dentro do horário do hábito). */
  stillPossible: boolean;
  streak: number;
}

export interface NightTask {
  key: string;
  title: string;
  kind: 'task' | 'event';
  time?: LocalTime;
  done: boolean;
}

export interface NightAgendaItem {
  key: string;
  title: string;
  kind: 'task' | 'event' | 'habit_block' | 'google';
  source: 'rotinas' | 'google';
  date: CivilDate;
  allDay: boolean;
  start?: LocalTime;
  end?: LocalTime;
  /** false quando o evento do Google está marcado como "Disponível". */
  busy: boolean;
  colorId?: string;
  flag?: ItemFlag;
  habitId?: string;
}

export interface NightTomorrowHabit {
  habit: Habit;
  start?: LocalTime;
  end?: LocalTime;
  /** O horário vem de um bloco de tempo na agenda. */
  fromBlock: boolean;
}

export interface NightGoal {
  goal: Goal;
  progress: GoalProgress;
  state: 'ahead' | 'on_track' | 'behind' | 'done' | 'no_target';
  daysLeft: number;
  needed: string | null;
}

export interface NightSignal {
  kind: 'streak_at_risk' | 'struggling' | 'steady' | 'goal_behind' | 'exam_soon' | 'deadline_soon' | 'busy_tomorrow';
  text: string;
  habitIds: string[];
  goalIds: string[];
  /** Chaves de itens de agenda citados (exigem a autorização "Agenda no Kai" para ir ao Kai). */
  agendaKeys: string[];
}

export interface NightBrief {
  /** Dia que está sendo fechado. */
  date: CivilDate;
  weekday: string;
  nowTime: LocalTime;
  /** A noite já passou da meia-noite (o dia fechado é ontem no calendário). */
  afterMidnight: boolean;
  tomorrow: CivilDate;
  tomorrowWeekday: string;
  today: {
    habits: NightHabit[];
    done: number;
    skipped: number;
    /** Previstos menos pulados (base do "X de Y"). */
    countable: number;
    xp: number;
    tasks: NightTask[];
  };
  tomorrowItems: NightAgendaItem[];
  tomorrowHabits: NightTomorrowHabit[];
  freeWindows: TimeWindow[];
  firstCommitment?: { title: string; start: LocalTime };
  /** Provas e prazos detectados pelo título, de amanhã até RADAR_DAYS dias. */
  radar: NightAgendaItem[];
  goals: NightGoal[];
  signals: NightSignal[];
  /** Prioridade que a pessoa definiu para hoje (na noite anterior). */
  todayPriority?: { text: string; outcome?: 'done' | 'not_done' };
  tomorrowPriority?: string;
  checkin?: { mood?: number; energy?: number };
  /** Há eventos do Google no resumo. */
  usesGoogle: boolean;
}

export interface NightInput {
  now: Date;
  profile: Pick<Profile, 'timezone' | 'availability'>;
  habits: readonly Habit[];
  completions: readonly HabitCompletion[];
  agendaItems: readonly AgendaItem[];
  agendaCompletions: readonly AgendaCompletion[];
  goals: readonly Goal[];
  goalCtx: GoalProgressContext;
  progressEvents: readonly Pick<ProgressEvent, 'xp' | 'localDate'>[];
  checkins: readonly Checkin[];
  todayPlan?: DayPlan | null;
  tomorrowPlan?: DayPlan | null;
  /** Eventos da agenda principal do Google (se a leitura de eventos estiver conectada). */
  googleEvents?: readonly GoogleEvent[];
  /** Cores do Google que a pessoa usa para provas e prazos (opcional). */
  flagColors?: FlagColors;
}

/** Dia que a noite fecha: depois da meia-noite (até 04:00), ainda é o dia anterior. */
export function nightDateFor(now: Date, timeZone: string): CivilDate {
  const today = todayInZone(timeZone, now);
  return nowTimeInZone(timeZone, now) < NIGHT_ROLLOVER ? addDays(today, -1) : today;
}

// ── Provas e prazos ─────────────────────────────────────────────────────────

// Palavras de prova (sem acentos). "agi": nome da prova de Português (Estudos Linguísticos) no
// colégio da pessoa que usa o app; "maratona", "intermediaria", "somativa" e "trimestral" também
// aparecem nos nomes das avaliações da escola.
const EXAM_RE =
  /\b(prova|provas|p[1-4]|av[1-4]|ap[1-4]|agi|avaliacao|avaliacoes|exame|exames|teste|simulado|simulados|quiz|vestibular|enem|fuvest|recuperacao|maratona|intermediaria|somativa|trimestral|bimestral|dissertacao)\b/;
const DEADLINE_RE = /\b(prazo|prazos|entrega|entregar|deadline|vence|vencimento|submissao|submeter|fecha|encerra|ultimo dia|homework|tarefa|tarefas|exercicios|moodle|self study|temas? \d+|lista de)\b/;
/** Eventos de preparação ("véspera da prova", "estudar para a prova") não são a prova em si. */
const PREP_RE = /\b(vespera|amanha|estudo|estudar|revisao|revisar|bloco|preparar|preparacao|aula|aulas|reforco|plantao)\b/;

function normalizeTitle(title: string): string {
  return title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

export interface FlagColors {
  prova: readonly string[];
  prazo: readonly string[];
}

/**
 * Marca provas e prazos (heurística simples e transparente; pode errar):
 * 1. eventos de preparação ou aula nunca são marcados;
 * 2. palavras do título (prova, avaliação, AGI, entrega, prazo…);
 * 3. se a pessoa indicou, a cor do evento no Google (ex.: laranja = avaliação, vermelho = prazo).
 */
export function detectFlag(title: string, colorId?: string, colors?: FlagColors): ItemFlag | undefined {
  const t = normalizeTitle(title);
  if (PREP_RE.test(t)) return undefined;
  if (EXAM_RE.test(t)) return 'prova';
  if (DEADLINE_RE.test(t)) return 'prazo';
  if (colorId && colors?.prova.includes(colorId)) return 'prova';
  if (colorId && colors?.prazo.includes(colorId)) return 'prazo';
  return undefined;
}

// ── Horários ────────────────────────────────────────────────────────────────

/** "07:30" → "7h30"; "19:00" → "19h" (forma natural para a fala). */
export function speechTime(time: LocalTime): string {
  const h = Number(time.slice(0, 2));
  const m = time.slice(3, 5);
  return m === '00' ? `${h}h` : `${h}h${m}`;
}

function timingStillPossible(timing: HabitTiming, nowMin: number): boolean {
  switch (timing.kind) {
    case 'anytime':
      return nowMin < 23 * 60 + 30;
    case 'time':
      return nowMin < timeToMinutes(timing.time) + 60;
    case 'window':
      return nowMin < timeToMinutes(timing.end);
  }
}

interface Busy {
  start: number;
  end: number;
}

/** Subtrai períodos ocupados das janelas do dia e devolve as livres com pelo menos `min` minutos. */
export function freeWindowsFrom(windows: readonly TimeWindow[], busy: readonly Busy[], min = MIN_FREE_MINUTES): TimeWindow[] {
  const sorted = [...busy].filter((b) => b.end > b.start).sort((a, b) => a.start - b.start);
  const out: TimeWindow[] = [];
  for (const w of windows) {
    let cursor = timeToMinutes(w.start);
    const end = timeToMinutes(w.end);
    for (const b of sorted) {
      if (b.end <= cursor || b.start >= end) continue;
      if (b.start - cursor >= min) out.push({ start: minutesToTime(cursor), end: minutesToTime(b.start) });
      cursor = Math.max(cursor, b.end);
      if (cursor >= end) break;
    }
    if (end - cursor >= min) out.push({ start: minutesToTime(cursor), end: minutesToTime(end) });
  }
  return out.slice(0, 12);
}

// ── Google ──────────────────────────────────────────────────────────────────

/** Converte um evento do Google para os dias e horários do fuso do perfil; devolve uma entrada por dia coberto no intervalo. */
export function googleEventDays(event: GoogleEvent, from: CivilDate, to: CivilDate, timeZone: string, colors?: FlagColors): NightAgendaItem[] {
  const base = { title: event.title, kind: 'google' as const, source: 'google' as const, busy: event.busy, colorId: event.colorId, flag: detectFlag(event.title, event.colorId, colors) };
  const out: NightAgendaItem[] = [];
  if (event.allDay) {
    // Datas do Google: início inclusivo, fim exclusivo.
    const last = addDays(event.end, -1);
    for (let d = event.start > from ? event.start : from; d <= to && d <= last; d = addDays(d, 1)) {
      out.push({ ...base, key: `google|${event.id}|${d}`, date: d, allDay: true });
    }
    return out;
  }
  const s = instantToWallTime(event.start, timeZone);
  const e = instantToWallTime(event.end, timeZone);
  for (let d = s.date > from ? s.date : from; d <= to && d <= e.date; d = addDays(d, 1)) {
    if (d === e.date && e.time === '00:00' && d !== s.date) break; // termina exatamente à meia-noite
    const start = d === s.date ? s.time : '00:00';
    const end = d === e.date ? e.time : '23:59';
    out.push({ ...base, key: `google|${event.id}|${d}`, date: d, allDay: false, start, end: end > start ? end : undefined });
  }
  return out;
}

export function sortAgendaItems(list: NightAgendaItem[]): NightAgendaItem[] {
  return list.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    const as = a.start ?? '99:99';
    const bs = b.start ?? '99:99';
    if (as !== bs) return as < bs ? -1 : 1;
    return a.title.localeCompare(b.title, 'pt-BR');
  });
}

// ── Metas ───────────────────────────────────────────────────────────────────

export function goalPace(goal: Goal, progress: GoalProgress, date: CivilDate): Pick<NightGoal, 'state' | 'daysLeft' | 'needed'> {
  const daysLeft = Math.max(0, diffDays(goal.periodEnd, date));
  if (goal.status === 'completed' || progress.reached) return { state: 'done', daysLeft, needed: null };
  if (progress.target === null || progress.kind === 'manual_completion') return { state: 'no_target', daysLeft, needed: null };
  const total = diffDays(goal.periodEnd, goal.periodStart) + 1;
  const elapsed = Math.min(total, Math.max(1, diffDays(date, goal.periodStart) + 1));
  const expected = (progress.target * elapsed) / total;
  const ratio = expected > 0 ? progress.current / expected : 1;
  const state = ratio >= 1.1 ? 'ahead' : ratio >= 0.9 ? 'on_track' : 'behind';
  const remaining = Math.max(0, progress.target - progress.current);
  const needed =
    remaining > 0 ? `faltam ${formatNumber(remaining)} ${progress.unit} ${daysLeft > 0 ? `em ${daysLeft} ${daysLeft === 1 ? 'dia' : 'dias'}` : 'até hoje'}` : null;
  return { state, daysLeft, needed };
}

// ── Resumo ──────────────────────────────────────────────────────────────────

export function computeNightBrief(input: NightInput): NightBrief {
  const tz = input.profile.timezone;
  const date = nightDateFor(input.now, tz);
  const calendarToday = todayInZone(tz, input.now);
  const afterMidnight = date !== calendarToday;
  const nowTime = nowTimeInZone(tz, input.now);
  const nowMin = afterMidnight ? 24 * 60 : timeToMinutes(nowTime);
  const tomorrow = addDays(date, 1);
  const byHabit = groupCompletions(input.completions);
  const active = input.habits.filter((h) => h.status === 'active');

  // Hoje: hábitos
  const todayHabits: NightHabit[] = active
    .filter((h) => isScheduledOn(h, date))
    .sort((a, b) => timingSortKey(a.timing) - timingSortKey(b.timing) || a.order - b.order)
    .map((habit) => {
      const lookup = byHabit.get(habit.id) ?? new Map();
      const status = lookup.get(date) ?? 'open';
      return {
        habit,
        status,
        stillPossible: status === 'open' && timingStillPossible(habit.timing, nowMin),
        streak: computeStreak(habit, lookup, date).current,
      };
    });
  const done = todayHabits.filter((h) => h.status === 'done').length;
  const skipped = todayHabits.filter((h) => h.status === 'skipped').length;
  const xp = input.progressEvents.filter((e) => e.localDate === date).reduce((s, e) => s + e.xp, 0);

  // Hoje: tarefas e eventos do Rotinas
  const doneKeys = new Set(input.agendaCompletions.map((c) => c.id));
  const tasks: NightTask[] = expandAgenda(input.agendaItems, date, date, tz)
    .filter((o) => o.kind !== 'habit')
    .map((o) => ({ key: o.key, title: o.title, kind: o.kind === 'event' ? ('event' as const) : ('task' as const), time: o.allDay ? undefined : o.startTime, done: doneKeys.has(o.key) }));

  // Amanhã e próximos dias: agenda do Rotinas + Google
  const radarEnd = addDays(date, RADAR_DAYS);
  const rotinas: NightAgendaItem[] = expandAgenda(input.agendaItems, tomorrow, radarEnd, tz).map((o) => ({
    key: o.key,
    title: o.title,
    kind: o.kind === 'habit' ? 'habit_block' : o.kind,
    source: 'rotinas',
    date: o.date,
    allDay: o.allDay,
    start: o.allDay ? undefined : o.startTime,
    end: o.allDay ? undefined : (o.endTime ?? undefined),
    busy: true,
    flag: o.kind === 'habit' ? undefined : detectFlag(o.title),
    habitId: o.habitId,
  }));
  const google = (input.googleEvents ?? []).flatMap((e) => googleEventDays(e, tomorrow, radarEnd, tz, input.flagColors));
  const all = sortAgendaItems([...rotinas, ...google]);
  const tomorrowItems = all.filter((i) => i.date === tomorrow);
  const radar = all.filter((i) => i.flag && i.kind !== 'habit_block').slice(0, 30);

  // Amanhã: hábitos previstos (com o horário do bloco, quando houver)
  const tomorrowHabits: NightTomorrowHabit[] = active
    .filter((h) => isScheduledOn(h, tomorrow))
    .sort((a, b) => timingSortKey(a.timing) - timingSortKey(b.timing) || a.order - b.order)
    .map((habit) => {
      const block = tomorrowItems.find((i) => i.kind === 'habit_block' && i.habitId === habit.id && i.start);
      if (block) return { habit, start: block.start, end: block.end, fromBlock: true };
      const t = habit.timing;
      if (t.kind === 'time') {
        const end = habit.durationMinutes ? minutesToTime(Math.min(timeToMinutes(t.time) + habit.durationMinutes, 23 * 60 + 59)) : undefined;
        return { habit, start: t.time, end, fromBlock: false };
      }
      if (t.kind === 'window') return { habit, start: t.start, end: t.end, fromBlock: false };
      return { habit, fromBlock: false };
    });

  // Janelas livres de amanhã
  const busy: Busy[] = [];
  for (const i of tomorrowItems) {
    if (i.allDay || !i.start || !i.busy) continue;
    const s = timeToMinutes(i.start);
    busy.push({ start: s, end: i.end ? timeToMinutes(i.end) : s + DEFAULT_BUSY_MINUTES });
  }
  for (const h of tomorrowHabits) {
    if (h.fromBlock || h.habit.timing.kind !== 'time' || !h.start) continue;
    const s = timeToMinutes(h.start);
    busy.push({ start: s, end: s + (h.habit.durationMinutes ?? DEFAULT_BUSY_MINUTES) });
  }
  const freeWindows = freeWindowsFrom(windowsForDate(tomorrow, input.profile.availability), busy);

  const timed = [
    ...tomorrowItems.filter((i) => !i.allDay && i.start && i.busy).map((i) => ({ title: i.title, start: i.start! })),
    ...tomorrowHabits.filter((h) => !h.fromBlock && h.habit.timing.kind === 'time' && h.start).map((h) => ({ title: h.habit.title, start: h.start! })),
  ].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  const firstCommitment = timed[0];

  // Metas em andamento
  const goals: NightGoal[] = input.goals
    .filter((g) => g.status === 'active' && goalIsCurrent(g, date))
    .map((goal) => {
      const progress = computeGoalProgress(goal, input.goalCtx);
      return { goal, progress, ...goalPace(goal, progress, date) };
    });

  // Sinais (fatos calculados, sem interpretação de causa)
  const signals: NightSignal[] = [];
  const push = (s: Omit<NightSignal, 'habitIds' | 'goalIds' | 'agendaKeys'> & Partial<Pick<NightSignal, 'habitIds' | 'goalIds' | 'agendaKeys'>>) =>
    signals.push({ habitIds: [], goalIds: [], agendaKeys: [], ...s });
  for (const h of todayHabits) {
    if (h.stillPossible && h.streak >= 2) push({ kind: 'streak_at_risk', text: `${h.habit.title}: sequência de ${h.streak} e ainda dá tempo hoje.`, habitIds: [h.habit.id] });
  }
  const weekStart = addDays(date, -6);
  for (const habit of active) {
    const st = habitStatsBetween(habit, byHabit.get(habit.id) ?? new Map(), weekStart, date, date);
    const closed = st.done + st.missed;
    if (closed >= 4 && st.rate !== null && st.rate < 0.5) {
      push({ kind: 'struggling', text: `${habit.title}: ${st.done} de ${closed} nos últimos 7 dias.`, habitIds: [habit.id] });
    } else if (closed >= 5 && st.rate !== null && st.rate >= 0.85) {
      push({ kind: 'steady', text: `${habit.title}: ${st.done} de ${closed} nos últimos 7 dias.`, habitIds: [habit.id] });
    }
  }
  for (const g of goals) {
    if (g.state === 'behind') push({ kind: 'goal_behind', text: `Meta “${g.goal.title}” abaixo do ritmo${g.needed ? `: ${g.needed}` : ''}.`, goalIds: [g.goal.id] });
  }
  for (const item of radar) {
    const inDays = diffDays(item.date, date);
    if (inDays > 3) continue;
    const when = inDays === 1 ? 'amanhã' : `em ${inDays} dias`;
    push({ kind: item.flag === 'prova' ? 'exam_soon' : 'deadline_soon', text: `${item.flag === 'prova' ? 'Prova' : 'Prazo'} ${when}: ${item.title}.`, agendaKeys: [item.key] });
  }
  const timedTomorrow = tomorrowItems.filter((i) => !i.allDay && i.start && i.busy);
  if (timedTomorrow.length >= 5) {
    const widest = [...freeWindows].sort((a, b) => timeToMinutes(b.end) - timeToMinutes(b.start) - (timeToMinutes(a.end) - timeToMinutes(a.start)))[0];
    push({
      kind: 'busy_tomorrow',
      text: `Amanhã tem ${timedTomorrow.length} compromissos com horário${widest ? `; a maior janela livre é das ${widest.start} às ${widest.end}` : ''}.`,
      agendaKeys: timedTomorrow.map((i) => i.key).slice(0, 4),
    });
  }

  const checkin = input.checkins.find((c) => c.date === date);
  return {
    date,
    weekday: weekdayName(date),
    nowTime,
    afterMidnight,
    tomorrow,
    tomorrowWeekday: weekdayName(tomorrow),
    today: { habits: todayHabits, done, skipped, countable: todayHabits.length - skipped, xp, tasks },
    tomorrowItems,
    tomorrowHabits,
    freeWindows,
    firstCommitment,
    radar,
    goals,
    signals: signals.slice(0, 8),
    todayPriority: input.todayPlan?.priority ? { text: input.todayPlan.priority, outcome: input.todayPlan.outcome } : undefined,
    tomorrowPriority: input.tomorrowPlan?.priority,
    checkin: checkin && (checkin.mood !== undefined || checkin.energy !== undefined) ? { mood: checkin.mood, energy: checkin.energy } : undefined,
    usesGoogle: google.length > 0,
  };
}

// ── Fala do app (sem IA) ────────────────────────────────────────────────────

function whenPhrase(item: NightAgendaItem, date: CivilDate): string {
  const inDays = diffDays(item.date, date);
  if (inDays === 1) return 'amanhã';
  const wd = weekdayName(item.date).replace('-feira', '');
  return `${wd}, dia ${Number(item.date.slice(8, 10))}`;
}

/**
 * Texto curto que o app lê em voz alta quando o Kai está desligado (ou antes dele).
 * Só descreve números e itens calculados; termina com a pergunta da prioridade.
 */
export function nightSpeech(brief: NightBrief, name?: string): { say: string; question: string } {
  const parts: string[] = [];
  parts.push(name ? `Boa noite, ${name}.` : 'Boa noite.');
  const { today } = brief;
  if (today.habits.length === 0) parts.push('Hoje não havia hábitos previstos.');
  else if (today.countable === 0) parts.push('Hoje você pulou os hábitos previstos.');
  else {
    const xp = today.xp > 0 ? ` e somou ${today.xp} XP` : '';
    parts.push(`Hoje você concluiu ${today.done} de ${today.countable} ${today.countable === 1 ? 'hábito' : 'hábitos'}${xp}.`);
  }
  const possible = today.habits.filter((h) => h.stillPossible).map((h) => h.habit.title);
  if (possible.length === 1) parts.push(`Ainda dá tempo de: ${possible[0]}.`);
  else if (possible.length > 1) parts.push(`Ainda dá tempo de: ${possible.slice(0, 2).join(' e ')}.`);
  if (brief.todayPriority && !brief.todayPriority.outcome) parts.push(`A prioridade de hoje era: ${brief.todayPriority.text}.`);
  const wd = brief.tomorrowWeekday.replace('-feira', '');
  if (brief.firstCommitment) parts.push(`Amanhã, ${wd}, o primeiro compromisso é às ${speechTime(brief.firstCommitment.start)}: ${brief.firstCommitment.title}.`);
  else if (brief.tomorrowItems.length === 0 && brief.tomorrowHabits.length === 0) parts.push(`Amanhã, ${wd}, a agenda está livre.`);
  else parts.push(`Amanhã é ${wd}.`);
  const soon = brief.radar.filter((r) => diffDays(r.date, brief.date) <= 3).slice(0, 2);
  if (soon.length > 0) parts.push(`No radar: ${soon.map((r) => `${r.title}, ${whenPhrase(r, brief.date)}`).join('; ')}.`);
  const behind = brief.goals.filter((g) => g.state === 'behind').slice(0, 1);
  if (behind.length > 0) parts.push(`A meta ${behind[0].goal.title} está abaixo do ritmo.`);
  const question = brief.tomorrowPriority ? `Sua prioridade de amanhã está definida: ${brief.tomorrowPriority}. Quer manter?` : 'Qual vai ser a sua prioridade número um para amanhã?';
  return { say: parts.join(' '), question };
}
