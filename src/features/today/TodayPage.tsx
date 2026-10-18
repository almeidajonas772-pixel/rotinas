import { CalendarPlus, Check, ChevronRight, Ellipsis, NotebookPen, Plus, SkipForward, Star, Undo2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useApp } from '../../app/context';
import { ActionSheet, Dialog } from '../../components/dialog';
import { ScalePicker, TextArea } from '../../components/form';
import { useToast } from '../../components/toast';
import { Button, ButtonLink, EmptyState, LoadingState, Notice, PageHeader, ProgressBar, Section, Tag } from '../../components/ui';
import { useAgendaCompletions, useAgendaItems, useCheckin, useCompletions, useDayPlan, useHabits, useJournalEntry } from '../../db/hooks';
import { describeError } from '../../db/errors';
import { completeAgendaOccurrence, undoAgendaOccurrence } from '../../db/repo-agenda';
import { recordHabit, setCompletionNote, undoHabitRecord } from '../../db/repo-habits';
import { setPriorityOutcome } from '../../db/repo-night';
import { deleteCheckin, saveCheckin } from '../../db/repo-journal';
import { expandAgenda, occurrenceKey, type AgendaOccurrence } from '../../domain/agenda';
import { addDays, eachDay, nowTimeInZone, startOfWeek, timeToMinutes, type CivilDate } from '../../domain/civil';
import { formatLongDate, plural, weekdayShort } from '../../domain/format';
import { describeTiming, isScheduledOn, timingSortKey } from '../../domain/schedule';
import type { Checkin, CompletionStatus, Habit } from '../../domain/schemas';
import { dailyAggregates, groupCompletions } from '../../domain/stats';
import { computeStreak } from '../../domain/streak';
import { useLevel, useNow } from '../shared/data';
import { DayDial, type DialItem } from './DayDial';

export function TodayPage() {
  const { profile, prefs, today, timezone, weekStartsOn } = useApp();
  const habits = useHabits();
  const completions = useCompletions();
  const items = useAgendaItems();
  const agendaCompletions = useAgendaCompletions();
  const checkin = useCheckin(today);
  const journal = useJournalEntry(today);
  const plan = useDayPlan(today);
  const level = useLevel();
  const now = useNow();
  const toast = useToast();
  const navigate = useNavigate();
  const [menu, setMenu] = useState<Habit | null>(null);
  const [noteFor, setNoteFor] = useState<{ habit: Habit; date: CivilDate; text: string } | null>(null);
  const [checkinOpen, setCheckinOpen] = useState(false);

  const data = useMemo(() => {
    if (!habits || !completions || !items || !agendaCompletions) return null;
    const byHabit = groupCompletions(completions);
    const active = habits.filter((h) => h.status === 'active');
    const todays = active
      .filter((h) => isScheduledOn(h, today))
      .sort((a, b) => timingSortKey(a.timing) - timingSortKey(b.timing) || a.order - b.order);
    const statusOf = (h: Habit, d: CivilDate): CompletionStatus | undefined => byHabit.get(h.id)?.get(d);
    const yesterday = addDays(today, -1);
    const yesterdayOpen = active.filter((h) => isScheduledOn(h, yesterday) && !statusOf(h, yesterday));
    const agendaDone = new Set(agendaCompletions.map((c) => c.id));
    const occ = expandAgenda(items, today, today, timezone);
    const tasks = occ.filter((o) => o.kind !== 'habit');
    const blocks = occ.filter((o) => o.kind === 'habit');
    const weekStart = startOfWeek(today, weekStartsOn);
    const week = dailyAggregates(active.concat(habits.filter((h) => h.status === 'paused')), byHabit, weekStart, addDays(weekStart, 6), today);
    return { byHabit, todays, statusOf, yesterday, yesterdayOpen, tasks, blocks, agendaDone, weekStart, week, hasHabits: habits.length > 0 };
  }, [habits, completions, items, agendaCompletions, today, timezone, weekStartsOn]);

  if (!data || checkin === undefined || journal === undefined) {
    return (
      <div className="page">
        <PageHeader title="Hoje" subtitle={formatLongDate(today)} />
        <LoadingState />
      </div>
    );
  }

  const { todays, statusOf, tasks, blocks, agendaDone } = data;
  const doneCount = todays.filter((h) => statusOf(h, today) === 'done').length;
  const skippedCount = todays.filter((h) => statusOf(h, today) === 'skipped').length;
  const countable = todays.length - skippedCount;

  async function toggleHabit(h: Habit, date: CivilDate) {
    const status = statusOf(h, date);
    try {
      if (status === 'done') {
        await undoHabitRecord(h.id, date);
        toast.show(`Conclusão desfeita: ${h.title}`);
      } else {
        await recordHabit(h.id, date, 'done', { today, timezone });
        toast.show(`Concluído: ${h.title}${h.xp > 0 ? ` (+${h.xp} XP)` : ''}`, {
          action: { label: 'Desfazer', onSelect: () => void undoHabitRecord(h.id, date) },
        });
      }
    } catch (error) {
      toast.show(describeError(error), { tone: 'danger' });
    }
  }

  async function toggleAgenda(o: AgendaOccurrence) {
    const done = agendaDone.has(occurrenceKey(o.itemId, o.originalDate));
    try {
      if (done) await undoAgendaOccurrence(o.itemId, o.originalDate);
      else {
        await completeAgendaOccurrence(o.itemId, o.originalDate, { today, timezone });
        toast.show(`Concluído: ${o.title}${o.xp > 0 ? ` (+${o.xp} XP)` : ''}`, {
          action: { label: 'Desfazer', onSelect: () => void undoAgendaOccurrence(o.itemId, o.originalDate) },
        });
      }
    } catch (error) {
      toast.show(describeError(error), { tone: 'danger' });
    }
  }

  // Mostrador: hábitos (horário ou janela; bloco de tempo do dia tem prioridade) e itens com horário.
  const dialItems: DialItem[] = [];
  for (const h of todays) {
    const block = blocks.find((b) => b.habitId === h.id && b.startTime);
    const done = statusOf(h, today) === 'done';
    if (block?.startTime) {
      dialItems.push({ id: h.id, label: h.title, kind: 'habit', start: timeToMinutes(block.startTime), end: block.endTime ? timeToMinutes(block.endTime) : undefined, done });
    } else if (h.timing.kind === 'time') dialItems.push({ id: h.id, label: h.title, kind: 'habit', start: timeToMinutes(h.timing.time), done });
    else if (h.timing.kind === 'window') dialItems.push({ id: h.id, label: h.title, kind: 'habit', start: timeToMinutes(h.timing.start), end: timeToMinutes(h.timing.end), done });
  }
  for (const t of tasks) {
    if (!t.startTime) continue;
    dialItems.push({ id: t.key, label: t.title, kind: t.kind === 'event' ? 'event' : 'task', start: timeToMinutes(t.startTime), end: t.endTime ? timeToMinutes(t.endTime) : undefined, done: agendaDone.has(t.key) });
  }
  const nowLabel = nowTimeInZone(timezone, now);
  const nowMin = timeToMinutes(nowLabel);
  const next = dialItems.filter((i) => !i.done && (i.end ?? i.start) >= nowMin).sort((a, b) => a.start - b.start)[0];
  const untimed = todays.filter((h) => h.timing.kind === 'anytime' && !blocks.some((b) => b.habitId === h.id && b.startTime)).length;
  const nextTime = next ? `${String(Math.floor(next.start / 60)).padStart(2, '0')}:${String(next.start % 60).padStart(2, '0')}` : '';
  const caption = next
    ? `Próximo: ${next.label}, ${next.start <= nowMin ? 'agora' : `às ${nextTime}`}`
    : dialItems.length > 0
      ? 'Nada mais com horário hoje'
      : untimed > 0
        ? `${untimed === 1 ? '1 hábito' : `${untimed} hábitos`} sem horário definido`
        : 'Nenhum horário marcado hoje';
  const summary = `Mostrador do dia. Agora são ${nowLabel}. ${todays.length > 0 ? `${doneCount} de ${countable} hábitos concluídos.` : 'Nenhum hábito previsto.'} ${next ? `Próximo: ${next.label}.` : ''}`;

  const evening = nowMin >= 18 * 60;
  const weekClosed = data.week.reduce((s, d) => s + d.done + d.missed, 0);
  const weekDone = data.week.reduce((s, d) => s + d.done, 0);
  const greeting = profile.name ? `Olá, ${profile.name}.` : undefined;

  return (
    <div className="page">
      <PageHeader title="Hoje" subtitle={greeting ? `${greeting} ${capitalize(formatLongDate(today))}` : capitalize(formatLongDate(today))} />

      {plan?.priority && (
        <div className={`today-priority${plan.outcome === 'done' ? ' is-done' : ''}`}>
          <Star size={22} aria-hidden="true" />
          <div className="grow">
            <p className="field-label">Prioridade nº 1 de hoje</p>
            <p className="row-title">{plan.priority}</p>
          </div>
          {plan.outcome === 'done' ? (
            <Button size="sm" variant="ghost" icon={<Undo2 size={16} aria-hidden="true" />} onClick={() => void setPriorityOutcome(today, undefined)}>
              Cumprida
            </Button>
          ) : (
            <Button
              size="sm"
              icon={<Check size={16} aria-hidden="true" />}
              onClick={() =>
                void setPriorityOutcome(today, 'done')
                  .then(() => toast.show('Prioridade do dia cumprida.'))
                  .catch((e) => toast.show(describeError(e), { tone: 'danger' }))
              }
            >
              Cumpri
            </Button>
          )}
        </div>
      )}

      {evening && <NightInvite />}

      <section className="today-hero" aria-label="Resumo do dia">
        <div>
          <DayDial nowMinutes={nowMin} nowLabel={nowLabel} items={dialItems} summary={summary} />
          <p className="dial-next">{caption}</p>
        </div>
        <div className="hero-summary">
          {todays.length > 0 ? (
            <>
              <div>
                <p className="hero-count">
                  {doneCount} de {countable} {countable === 1 ? 'hábito concluído' : 'hábitos concluídos'}
                </p>
                {skippedCount > 0 && <p className="meta">{plural(skippedCount, 'pulado hoje', 'pulados hoje')} (não contam no cálculo)</p>}
              </div>
              <ProgressBar value={doneCount} max={Math.max(1, countable)} label="Progresso de hoje" valueText={`${doneCount} de ${countable}`} />
            </>
          ) : (
            <div>
              <p className="hero-count">{data.hasHabits ? 'Nenhum hábito previsto hoje' : 'Comece pelo primeiro hábito'}</p>
              <p className="meta">{data.hasHabits ? 'Dias sem ocorrência prevista não contam como falha.' : 'Seu progresso aparece aqui assim que você criar e concluir hábitos.'}</p>
            </div>
          )}
          {level && (
            <div>
              <div className="level-line">
                <span>
                  <strong className="wide" style={{ color: 'var(--ink)' }}>Nível {level.level}</strong> <span>({level.xp} XP no total)</span>
                </span>
                <span className="num">
                  {level.intoLevel}/{level.levelSpan} para o nível {level.level + 1}
                </span>
              </div>
              <div style={{ marginTop: 6 }}>
                <ProgressBar value={level.intoLevel} max={level.levelSpan} label="Progresso até o próximo nível" />
              </div>
            </div>
          )}
          <WeekStrip week={data.week} today={today} weekDone={weekDone} weekClosed={weekClosed} />
        </div>
      </section>

      <Section
        title="Hábitos de hoje"
        id="today-habits"
        action={
          <Link to="/habitos/novo" className="btn btn-ghost btn-sm">
            <Plus size={16} aria-hidden="true" />
            Novo
          </Link>
        }
      >
        {todays.length === 0 ? (
          data.hasHabits ? (
            <EmptyState title="Nada previsto para hoje" action={<ButtonLink to="/habitos">Ver meus hábitos</ButtonLink>}>
              <p>Seus hábitos aparecem aqui nos dias em que estão previstos. Hábitos pausados ficam fora da lista até você retomar.</p>
            </EmptyState>
          ) : (
            <EmptyState
              icon={<Plus size={20} />}
              title="Você ainda não tem hábitos"
              action={
                <ButtonLink to="/habitos/novo" variant="primary" icon={<Plus size={18} aria-hidden="true" />}>
                  Criar primeiro hábito
                </ButtonLink>
              }
            >
              <p>Escolha algo pequeno que caiba no seu dia. Quando você marcar a conclusão, ela fica registrada aqui e nos relatórios.</p>
            </EmptyState>
          )
        ) : (
          <ul className="list" role="list">
            {todays.map((h) => {
              const status = statusOf(h, today);
              const streak = computeStreak(h, data.byHabit.get(h.id) ?? new Map(), today);
              const block = blocks.find((b) => b.habitId === h.id && b.startTime);
              return (
                <li key={h.id} className={`list-row${status === 'done' ? ' is-done' : ''}`}>
                  <CheckButton
                    pressed={status === 'done'}
                    skipped={status === 'skipped'}
                    label={status === 'done' ? `Desfazer conclusão de ${h.title}` : `Concluir ${h.title}`}
                    onClick={() => void toggleHabit(h, today)}
                  />
                  <div className="row-main">
                    <Link to={`/habitos/${h.id}`} className="row-link">
                      <span className="row-title">{h.title}</span>
                    </Link>
                    <span className="row-meta">
                      <span>{block?.startTime ? `Bloco ${block.startTime}${block.endTime ? `–${block.endTime}` : ''}` : describeTiming(h.timing)}</span>
                      {streak.current > 0 && <span>Sequência: {streak.current}</span>}
                      {status === 'skipped' && <Tag>Pulado</Tag>}
                      {status !== 'done' && h.firstStep && <span>Primeiro passo: {h.firstStep}</span>}
                    </span>
                  </div>
                  <button type="button" className="icon-btn" aria-label={`Mais ações para ${h.title}`} onClick={() => setMenu(h)}>
                    <Ellipsis size={20} aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {data.yesterdayOpen.length > 0 && (
          <details className="explain" style={{ marginTop: 12 }}>
            <summary>Ontem: {plural(data.yesterdayOpen.length, 'ocorrência sem registro', 'ocorrências sem registro')}</summary>
            <p className="small muted" style={{ marginBottom: 8 }}>
              Esqueceu de marcar? Registre agora; a conclusão fica com a data de ontem e o horário real do registro.
            </p>
            <ul className="list" role="list">
              {data.yesterdayOpen.map((h) => (
                <li key={h.id} className="list-row">
                  <CheckButton pressed={false} label={`Concluir ${h.title} (ontem)`} onClick={() => void toggleHabit(h, data.yesterday)} />
                  <div className="row-main">
                    <span className="row-title">{h.title}</span>
                    <span className="row-meta">{capitalize(formatLongDate(data.yesterday))}</span>
                  </div>
                </li>
              ))}
            </ul>
          </details>
        )}
      </Section>

      <Section
        title="Agenda de hoje"
        id="today-agenda"
        action={
          <Link to="/agenda" className="btn btn-ghost btn-sm">
            Abrir agenda
            <ChevronRight size={16} aria-hidden="true" />
          </Link>
        }
      >
        {tasks.length === 0 ? (
          <EmptyState title="Nada na agenda de hoje" action={<ButtonLink to="/agenda?novo=1" icon={<CalendarPlus size={18} aria-hidden="true" />}>Adicionar à agenda</ButtonLink>}>
            <p>Tarefas e eventos criados na Agenda aparecem aqui no dia certo.</p>
          </EmptyState>
        ) : (
          <ul className="list" role="list">
            {tasks.map((o) => {
              const done = agendaDone.has(o.key);
              return (
                <li key={o.key} className={`list-row${done ? ' is-done' : ''}`}>
                  <span className={`kind-bar kind-${o.kind}`} aria-hidden="true" />
                  <CheckButton pressed={done} label={done ? `Desfazer conclusão de ${o.title}` : `Concluir ${o.title}`} onClick={() => void toggleAgenda(o)} />
                  <span className="row-time">{o.allDay ? 'Dia' : o.startTime}</span>
                  <div className="row-main">
                    <span className="row-title">{o.title}</span>
                    <span className="row-meta">
                      <span>{o.kind === 'task' ? 'Tarefa' : 'Evento'}</span>
                      {o.endTime && <span>até {o.endTime}</span>}
                      {o.recurring && <span>Repete</span>}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section title="Check-in e reflexão" id="today-reflect">
        <div className="quick-links">
          {prefs.features.checkins ? (
            <button type="button" className="quick-link" onClick={() => setCheckinOpen(true)} style={{ textAlign: 'left', cursor: 'pointer' }}>
              <Check size={20} aria-hidden="true" />
              <span className="grow">
                Check-in de hoje
                <span className="meta" style={{ display: 'block' }}>
                  {checkin ? `Humor ${checkin.mood ?? '—'}/5, energia ${checkin.energy ?? '—'}/5` : 'Opcional, leva 10 segundos'}
                </span>
              </span>
            </button>
          ) : (
            <Link to="/configuracoes#checkin" className="quick-link">
              <Check size={20} aria-hidden="true" />
              <span className="grow">
                Check-in diário
                <span className="meta" style={{ display: 'block' }}>
                  Desativado. Ative em Configurações, se quiser.
                </span>
              </span>
            </Link>
          )}
          <Link to={`/diario?data=${today}`} className="quick-link">
            <NotebookPen size={20} aria-hidden="true" />
            <span className="grow">
              Diário de hoje
              <span className="meta" style={{ display: 'block' }}>
                {journal ? 'Entrada escrita. Toque para continuar.' : 'O que você fez, o que funcionou, o que melhorar.'}
              </span>
            </span>
          </Link>
        </div>
      </Section>

      <ActionSheet
        open={menu !== null}
        onClose={() => setMenu(null)}
        title={menu?.title ?? ''}
        actions={
          menu
            ? [
                {
                  label: 'Pular hoje (não conta e não quebra a sequência)',
                  icon: <SkipForward size={18} aria-hidden="true" />,
                  hidden: statusOf(menu, today) === 'skipped',
                  onSelect: () =>
                    void recordHabit(menu.id, today, 'skipped', { today, timezone })
                      .then(() => toast.show(`Pulado hoje: ${menu.title}`))
                      .catch((e) => toast.show(describeError(e), { tone: 'danger' })),
                },
                {
                  label: 'Desfazer registro de hoje',
                  icon: <Undo2 size={18} aria-hidden="true" />,
                  hidden: !statusOf(menu, today),
                  onSelect: () => void undoHabitRecord(menu.id, today).then(() => toast.show('Registro desfeito.')),
                },
                {
                  label: 'Adicionar observação',
                  icon: <NotebookPen size={18} aria-hidden="true" />,
                  hidden: !statusOf(menu, today),
                  onSelect: () => {
                    const existing = completions?.find((c) => c.habitId === menu.id && c.scheduledDate === today);
                    setNoteFor({ habit: menu, date: today, text: existing?.note ?? '' });
                  },
                },
                { label: 'Ver detalhes e histórico', icon: <ChevronRight size={18} aria-hidden="true" />, onSelect: () => navigate(`/habitos/${menu.id}`) },
              ]
            : []
        }
      />

      <Dialog
        open={noteFor !== null}
        onClose={() => setNoteFor(null)}
        title="Observação do registro"
        footer={
          <>
            <Button onClick={() => setNoteFor(null)}>Cancelar</Button>
            <Button
              variant="primary"
              onClick={async () => {
                if (!noteFor) return;
                try {
                  await setCompletionNote(noteFor.habit.id, noteFor.date, noteFor.text);
                  toast.show('Observação salva.');
                  setNoteFor(null);
                } catch (e) {
                  toast.show(describeError(e), { tone: 'danger' });
                }
              }}
            >
              Salvar observação
            </Button>
          </>
        }
      >
        {noteFor && <TextArea label={noteFor.habit.title} value={noteFor.text} onChange={(text) => setNoteFor({ ...noteFor, text })} maxLength={500} rows={3} hint="Fica só no aparelho e não é enviada ao Kai." />}
      </Dialog>

      <CheckinDialog open={checkinOpen} onClose={() => setCheckinOpen(false)} date={today} />
    </div>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function NightInvite() {
  return (
    <Link to="/noite" className="night-invite">
      <span className="night-invite-orb" aria-hidden="true" />
      <span className="grow">
        <strong>Sessão da noite</strong>
        <span className="meta" style={{ display: 'block' }}>
          Feche o dia e decida a prioridade nº 1 de amanhã — por voz ou texto.
        </span>
      </span>
      <ChevronRight size={20} aria-hidden="true" />
    </Link>
  );
}

export function CheckButton({ pressed, skipped, label, onClick }: { pressed: boolean; skipped?: boolean; label: string; onClick: () => void }) {
  return (
    <button type="button" className={`check-btn${skipped ? ' is-skipped' : ''}`} aria-pressed={pressed} aria-label={label} onClick={onClick}>
      <span className="ring">{pressed && <Check size={18} strokeWidth={3} aria-hidden="true" />}</span>
    </button>
  );
}

function WeekStrip({ week, today, weekDone, weekClosed }: { week: Array<{ date: CivilDate; scheduled: number; done: number }>; today: CivilDate; weekDone: number; weekClosed: number }) {
  const start = week[0]?.date;
  const days = start ? eachDay(start, addDays(start, 6)) : [];
  const byDate = new Map(week.map((d) => [d.date, d]));
  const max = Math.max(1, ...week.map((d) => d.scheduled));
  return (
    <div>
      <p className="level-line">
        <span>
          <strong style={{ color: 'var(--ink)' }}>Esta semana</strong>
        </span>
        <span className="num">{weekClosed > 0 ? `${weekDone} de ${weekClosed} concluídas` : 'Sem ocorrências encerradas'}</span>
      </p>
      <div role="img" aria-label={`Resumo semanal: ${weekDone} de ${weekClosed} ocorrências encerradas concluídas.`} style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 6, marginTop: 8 }}>
        {days.map((d) => {
          const agg = byDate.get(d);
          const scheduled = agg?.scheduled ?? 0;
          const done = agg?.done ?? 0;
          const future = d > today;
          return (
            <div key={d} style={{ display: 'grid', gap: 4, justifyItems: 'center' }}>
              <div style={{ position: 'relative', width: 14, height: 36, borderRadius: 4, background: future || scheduled === 0 ? 'var(--surface-2)' : 'color-mix(in srgb, var(--chart-track) 45%, var(--surface))' }}>
                {scheduled > 0 && !future && (
                  <span style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: `${(done / max) * 100}%`, background: 'var(--chart-done)', borderRadius: 4 }} />
                )}
              </div>
              <span className="meta" style={{ fontSize: '0.6875rem', color: d === today ? 'var(--now)' : undefined, fontWeight: d === today ? 700 : 500 }}>
                {weekdayShort(d)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CheckinDialog({ open, onClose, date }: { open: boolean; onClose: () => void; date: CivilDate }) {
  const existing = useCheckin(date);
  if (!open || existing === undefined) return null;
  return <CheckinForm key={`${date}-${existing?.updatedAt ?? 'novo'}`} date={date} existing={existing} onClose={onClose} />;
}

function CheckinForm({ date, existing, onClose }: { date: CivilDate; existing: Checkin | null; onClose: () => void }) {
  const toast = useToast();
  const [mood, setMood] = useState<number | undefined>(existing?.mood);
  const [energy, setEnergy] = useState<number | undefined>(existing?.energy);
  const [note, setNote] = useState(existing?.note ?? '');
  const empty = mood === undefined && energy === undefined && note.trim() === '';
  return (
    <Dialog
      open
      onClose={onClose}
      title="Check-in de hoje"
      description="Só para você acompanhar como se sente. Não é uma avaliação clínica e fica neste aparelho."
      footer={
        <>
          {existing && (
            <Button
              variant="ghost"
              onClick={async () => {
                await deleteCheckin(date);
                toast.show('Check-in apagado.');
                onClose();
              }}
            >
              Apagar
            </Button>
          )}
          <Button onClick={onClose}>Cancelar</Button>
          <Button
            variant="primary"
            disabled={empty}
            onClick={async () => {
              try {
                await saveCheckin(date, { mood, energy, note });
                toast.show('Check-in salvo.');
                onClose();
              } catch (e) {
                toast.show(describeError(e), { tone: 'danger' });
              }
            }}
          >
            Salvar check-in
          </Button>
        </>
      }
    >
      <div className="stack-lg">
        <ScalePicker label="Humor" value={mood} onChange={setMood} low="muito baixo" high="muito bom" />
        <ScalePicker label="Energia" value={energy} onChange={setEnergy} low="muito baixa" high="muito alta" />
        <TextArea label="Nota" optional value={note} onChange={setNote} maxLength={500} rows={2} />
        {empty && <Notice tone="neutral">Preencha ao menos um campo para salvar. Tudo é opcional.</Notice>}
      </div>
    </Dialog>
  );
}
