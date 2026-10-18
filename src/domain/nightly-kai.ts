import type { KaiContext, NightlyContext } from '../../shared/kai';
import { KAI_LIMITS } from '../../shared/kai';
import { addDays, type CivilDate } from './civil';
import { formatShortDate } from './format';
import { buildKaiContext, checkinsAllowedForKai, type KaiSnapshot } from './kai-context';
import { describeEvidence } from './kai-evidence';
import { speechTime, type NightAgendaItem, type NightBrief } from './nightly';
import type { KaiDataManifest } from './schemas';

/**
 * Dados da sessão da noite enviados ao Kai. Regras (além das de kai-context.ts):
 * - títulos e horários da agenda (inclusive do Google) e as janelas livres só entram com a
 *   autorização "Agenda no Kai"; sem ela, o Kai recebe apenas números e horários dos hábitos;
 * - itens de agenda viram referências curtas (t1 = hoje, a1 = amanhã, u1 = próximos dias) e o
 *   mapa referência → item fica no aparelho;
 * - o check-in de hoje só entra com a autorização de check-ins;
 * - o nome da pessoa nunca é enviado.
 */

export interface NightPayloadOptions {
  /** Autorização "Agenda no Kai" ativa. */
  includeAgenda: boolean;
}

export interface BuiltNightPayload {
  context: KaiContext;
  night: NightlyContext;
  /** Referência → id local (hábitos, metas, Diário) ou chave do item de agenda (t/a/u). */
  refMap: Record<string, string>;
  manifest: KaiDataManifest;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function buildNightPayload(snapshot: KaiSnapshot, brief: NightBrief, options: NightPayloadOptions): BuiltNightPayload {
  // O dia que está sendo fechado é o "hoje" do contexto (importa depois da meia-noite).
  const built = buildKaiContext({ ...snapshot, today: brief.date }, { period: { start: addDays(brief.date, -13), end: brief.date } });
  const refMap: Record<string, string> = { ...built.refMap };
  const idToRef = new Map(Object.entries(built.refMap).map(([ref, id]) => [id, ref]));
  const ref = (id: string) => idToRef.get(id);

  const night: NightlyContext = {
    date: brief.date,
    weekday: brief.weekday,
    now: brief.afterMidnight ? '23:59' : brief.nowTime,
    tomorrowDate: brief.tomorrow,
    tomorrowWeekday: brief.tomorrowWeekday,
    todayHabits: brief.today.habits.flatMap((h) => {
      const r = ref(h.habit.id);
      return r ? [{ ref: r, status: h.status, stillPossible: h.stillPossible }] : [];
    }),
    xpToday: Math.min(100000, brief.today.xp),
    tomorrowHabits: brief.tomorrowHabits.flatMap((h) => {
      const r = ref(h.habit.id);
      return r ? [{ ref: r, start: h.start ?? null, end: h.end ?? null }] : [];
    }),
    goalsPace: brief.goals.flatMap((g) => {
      const r = ref(g.goal.id);
      return r ? [{ ref: r, state: g.state, daysLeft: Math.min(4000, g.daysLeft), needed: g.needed ? clip(g.needed, 120) : null }] : [];
    }),
    signals: [],
  };

  const agendaRef = new Map<string, string>();
  if (options.includeAgenda) {
    night.todayTasks = brief.today.tasks.slice(0, KAI_LIMITS.nightItems).map((t, i) => {
      const r = `t${i + 1}`;
      refMap[r] = t.key;
      agendaRef.set(t.key, r);
      return { ref: r, title: clip(t.title, 120), kind: t.kind, time: t.time ?? null, done: t.done };
    });
    night.tomorrowAgenda = brief.tomorrowItems.slice(0, KAI_LIMITS.nightItems).map((a, i) => {
      const r = `a${i + 1}`;
      refMap[r] = a.key;
      agendaRef.set(a.key, r);
      return { ref: r, title: clip(a.title, 200), kind: a.kind, allDay: a.allDay, start: a.start ?? null, end: a.end ?? null };
    });
    night.freeWindowsTomorrow = brief.freeWindows.slice(0, 12);
    night.upcoming = brief.radar.slice(0, KAI_LIMITS.nightItems).map((u, i) => {
      const r = `u${i + 1}`;
      refMap[r] = u.key;
      agendaRef.set(u.key, r); // para sinais, a referência do radar tem preferência
      return { ref: r, date: u.date, title: clip(u.title, 200), allDay: u.allDay, time: u.start ?? null, source: u.source, flag: u.flag ?? null };
    });
  }

  night.signals = brief.signals
    .filter((s) => options.includeAgenda || s.agendaKeys.length === 0)
    .map((s) => ({
      refs: [...s.habitIds.map(ref), ...s.goalIds.map(ref), ...s.agendaKeys.map((k) => agendaRef.get(k))].filter((r): r is string => Boolean(r)).slice(0, 4),
      text: clip(s.text, 240),
    }))
    .slice(0, 8);

  if (brief.todayPriority) night.lastPriority = { text: clip(brief.todayPriority.text, 200), outcome: brief.todayPriority.outcome ?? 'unknown' };
  if (brief.tomorrowPriority) night.priorityTomorrow = clip(brief.tomorrowPriority, 200);
  if (brief.checkin && checkinsAllowedForKai(snapshot.prefs)) night.checkinToday = brief.checkin;

  const categories = [
    ...built.manifest.categories,
    'Sessão da noite: resultado de hoje (hábitos e XP), horários dos hábitos de amanhã e ritmo das metas',
  ];
  const counts: Record<string, number> = { ...built.manifest.counts, todayHabits: night.todayHabits.length };
  if (options.includeAgenda) {
    categories.push(`Agenda: títulos e horários de hoje e de amanhã${brief.usesGoogle ? ' (inclusive do Google Agenda)' : ''}, janelas livres de amanhã e provas/prazos dos próximos dias`);
    counts.agenda = (night.todayTasks?.length ?? 0) + (night.tomorrowAgenda?.length ?? 0) + (night.upcoming?.length ?? 0);
  }
  if (night.lastPriority || night.priorityTomorrow) categories.push('Prioridade do dia definida por você');
  if (night.checkinToday) categories.push('Check-in de hoje (somente as notas numéricas)');
  return { context: built.context, night, refMap, manifest: { categories, counts, period: built.manifest.period } };
}

// ── Evidências descritas pelo app ───────────────────────────────────────────

function describeAgendaItem(item: Pick<NightAgendaItem, 'date' | 'allDay' | 'start' | 'end' | 'source' | 'flag'>, base: CivilDate): string {
  const google = item.source === 'google' ? ' (Google Agenda)' : '';
  const day = item.date === addDays(base, 1) ? 'Amanhã' : formatShortDate(item.date);
  const time = item.allDay || !item.start ? 'dia inteiro' : item.end ? `das ${speechTime(item.start)} às ${speechTime(item.end)}` : `às ${speechTime(item.start)}`;
  const flag = item.flag === 'prova' ? 'Prova (detectada pelo título). ' : item.flag === 'prazo' ? 'Prazo (detectado pelo título). ' : '';
  return `${flag}${day}, ${time}${google}.`;
}

/** Evidência de uma referência citada pelo Kai, descrita a partir dos dados enviados (nunca do texto do modelo). */
export function describeNightRef(refKey: string, payload: Pick<BuiltNightPayload, 'context' | 'night'>): { label: string; detail: string } | null {
  const { night } = payload;
  if (refKey.startsWith('t')) {
    const t = night.todayTasks?.find((x) => x.ref === refKey);
    if (!t) return null;
    return { label: t.title, detail: `Hoje${t.time ? `, às ${speechTime(t.time)}` : ''}: ${t.done ? 'concluída' : 'em aberto'}.` };
  }
  if (refKey.startsWith('a')) {
    const a = night.tomorrowAgenda?.find((x) => x.ref === refKey);
    if (!a) return null;
    return { label: a.title, detail: describeAgendaItem({ date: night.tomorrowDate, allDay: a.allDay, start: a.start ?? undefined, end: a.end ?? undefined, source: a.kind === 'google' ? 'google' : 'rotinas' }, night.date) };
  }
  if (refKey.startsWith('u')) {
    const u = night.upcoming?.find((x) => x.ref === refKey);
    if (!u) return null;
    return { label: u.title, detail: describeAgendaItem({ date: u.date, allDay: u.allDay, start: u.time ?? undefined, source: u.source, flag: u.flag ?? undefined }, night.date) };
  }
  const item = describeEvidence(refKey, payload.context);
  return item ? { label: item.label, detail: item.detail } : null;
}

export function nightEvidence(refs: readonly string[], payload: Pick<BuiltNightPayload, 'context' | 'night'>): Record<string, { label: string; detail: string }> {
  const out: Record<string, { label: string; detail: string }> = {};
  for (const r of new Set(refs)) {
    const e = describeNightRef(r, payload);
    if (e) out[r] = { label: clip(e.label, 200), detail: clip(e.detail, 400) };
  }
  return out;
}
