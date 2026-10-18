import { Archive, ArchiveRestore, ChevronLeft, ChevronRight, Ellipsis, Pause, Pencil, Play, Trash } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useApp } from '../../app/context';
import { ActionSheet, ConfirmDialog } from '../../components/dialog';
import { useToast } from '../../components/toast';
import { Button, ButtonLink, Explain, IconButton, LoadingState, Notice, PageHeader, Section, Stat, Tag } from '../../components/ui';
import { useGoals, useHabit, useHabitCompletions } from '../../db/hooks';
import { describeError } from '../../db/errors';
import { archiveHabit, deleteHabit, pauseHabit, recordHabit, resumeHabit, unarchiveHabit, undoHabitRecord } from '../../db/repo-habits';
import { addDays, addMonths, eachDay, endOfMonth, parseCivil, startOfMonth, startOfWeek, type CivilDate } from '../../domain/civil';
import { formatDate, formatInstant, formatLongDate, formatMonthYear, plural, weekdayShort } from '../../domain/format';
import { HORIZON_LABEL } from '../../domain/goals';
import { describeSchedule, describeTiming, habitStartDate, isScheduledOn } from '../../domain/schedule';
import type { CompletionStatus, Habit, HabitCompletion } from '../../domain/schemas';
import { formatRate, habitStatsBetween, lookupFor } from '../../domain/stats';
import { computeStreak } from '../../domain/streak';

export function HabitDetailPage() {
  const { id } = useParams();
  const habit = useHabit(id);
  const completions = useHabitCompletions(id);
  if (habit === undefined || completions === undefined) {
    return (
      <div className="page">
        <LoadingState />
      </div>
    );
  }
  if (habit === null) {
    return (
      <div className="page">
        <PageHeader title="Hábito não encontrado" back={{ to: '/habitos', label: 'Hábitos' }} />
        <Notice tone="warn">Este hábito não existe mais.</Notice>
      </div>
    );
  }
  return <HabitDetail habit={habit} completions={completions} />;
}

function HabitDetail({ habit, completions }: { habit: Habit; completions: HabitCompletion[] }) {
  const { today, timezone, weekStartsOn } = useApp();
  const goals = useGoals();
  const navigate = useNavigate();
  const toast = useToast();
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [month, setMonth] = useState(() => startOfMonth(today));
  const [dayMenu, setDayMenu] = useState<CivilDate | null>(null);

  const lookup = useMemo(() => lookupFor(habit.id, completions), [habit.id, completions]);
  const streak = computeStreak(habit, lookup, today);
  const start = habitStartDate(habit);
  const s7 = habitStatsBetween(habit, lookup, addDays(today, -6), today, today);
  const s30 = habitStatsBetween(habit, lookup, addDays(today, -29), today, today);
  const s90 = habitStatsBetween(habit, lookup, addDays(today, -89), today, today);
  const sAll = habitStatsBetween(habit, lookup, start, today, today);
  const goal = goals?.find((g) => g.id === habit.goalId);
  const recent = [...completions].sort((a, b) => (a.scheduledDate < b.scheduledDate ? 1 : -1)).slice(0, 12);
  const byDate = new Map(completions.map((c) => [c.scheduledDate, c]));

  async function run(action: () => Promise<void>, message: string) {
    try {
      await action();
      toast.show(message);
    } catch (e) {
      toast.show(describeError(e), { tone: 'danger' });
    }
  }

  async function record(date: CivilDate, status: CompletionStatus | 'clear') {
    try {
      if (status === 'clear') await undoHabitRecord(habit.id, date);
      else await recordHabit(habit.id, date, status, { today, timezone });
    } catch (e) {
      toast.show(describeError(e), { tone: 'danger' });
    }
  }

  const rateNote = (s: { done: number; missed: number }) => (s.done + s.missed > 0 ? `${s.done} de ${s.done + s.missed} encerradas` : 'Sem ocorrências encerradas');

  // Calendário mensal
  const monthStart = startOfMonth(month);
  const gridStart = startOfWeek(monthStart, weekStartsOn);
  const gridEnd = addDays(startOfWeek(endOfMonth(month), weekStartsOn), 6);
  const days = eachDay(gridStart, gridEnd);
  const heads = eachDay(gridStart, addDays(gridStart, 6)).map(weekdayShort);

  return (
    <div className="page">
      <PageHeader
        title={habit.title}
        subtitle={habit.description ?? `${habit.category}. ${describeSchedule(habit.scheduleHistory[habit.scheduleHistory.length - 1].schedule)}.`}
        back={{ to: '/habitos', label: 'Hábitos' }}
        actions={
          <>
            <ButtonLink to={`/habitos/${habit.id}/editar`} icon={<Pencil size={18} aria-hidden="true" />}>
              Editar
            </ButtonLink>
            <IconButton label="Mais ações" onClick={() => setMenuOpen(true)}>
              <Ellipsis size={20} aria-hidden="true" />
            </IconButton>
          </>
        }
      />

      {habit.status === 'paused' && (
        <Notice tone="warn" title="Hábito pausado" action={<Button size="sm" icon={<Play size={16} aria-hidden="true" />} onClick={() => void run(() => resumeHabit(habit.id, { today }), 'Hábito retomado.')}>Retomar</Button>}>
          Enquanto pausado, não há ocorrências previstas: os dias da pausa não contam como perdidos nem quebram a sequência.
        </Notice>
      )}
      {habit.status === 'archived' && (
        <Notice tone="neutral" title="Hábito arquivado" action={<Button size="sm" icon={<ArchiveRestore size={16} aria-hidden="true" />} onClick={() => void run(() => unarchiveHabit(habit.id, { today }), 'Hábito reativado.')}>Reativar</Button>}>
          Fica fora da tela Hoje e da agenda. O histórico continua aqui e nos relatórios.
        </Notice>
      )}
      {start > today && <Notice tone="info">Este hábito começa em {formatLongDate(start, true)}. Antes disso não há ocorrências previstas.</Notice>}

      <Section title="Desempenho" id="habit-stats">
        <div className="stats">
          <Stat label="Sequência atual" value={plural(streak.current, 'ocorrência', 'ocorrências')} note={streak.todayOpen ? 'Hoje ainda em aberto' : streak.lastDone ? `Última: ${formatDate(streak.lastDone)}` : undefined} />
          <Stat label="Melhor sequência" value={plural(streak.best, 'ocorrência', 'ocorrências')} />
          <Stat label="Últimos 7 dias" value={formatRate(s7.rate)} note={rateNote(s7)} />
          <Stat label="Últimos 30 dias" value={formatRate(s30.rate)} note={rateNote(s30)} />
          <Stat label="Últimos 90 dias" value={formatRate(s90.rate)} note={rateNote(s90)} />
          <Stat label="Desde o início" value={formatRate(sAll.rate)} note={`${sAll.done} concluídas, ${sAll.skipped} puladas, ${sAll.missed} perdidas`} />
        </div>
        <div style={{ marginTop: 12 }}>
          <Explain summary="Como estes números são calculados">
            <p>
              <strong>Ocorrências previstas</strong> são os dias em que este hábito estava agendado (pela frequência vigente em cada data), desde {formatDate(start)}. Dias fora da frequência e períodos de pausa não contam.
            </p>
            <p>
              <strong>Taxa de conclusão</strong> = concluídas ÷ (concluídas + perdidas). Ocorrências puladas saem do cálculo, e a de hoje só entra depois de registrada ou quando o dia acabar.
            </p>
            <p>
              <strong>Sequência</strong> conta ocorrências previstas concluídas em seguida. Uma ocorrência prevista sem registro em um dia que já passou zera a sequência; pular é neutro. Conclusões em dias não previstos não entram.
            </p>
          </Explain>
        </div>
      </Section>

      <Section
        title="Calendário de conclusões"
        id="habit-calendar"
        action={
          <div className="row" style={{ gap: 0 }}>
            <IconButton label="Mês anterior" onClick={() => setMonth(addMonths(month, -1))}>
              <ChevronLeft size={20} aria-hidden="true" />
            </IconButton>
            <span className="small" style={{ minWidth: '9.5em', textAlign: 'center', fontWeight: 600 }} aria-live="polite">
              {formatMonthYear(month)}
            </span>
            <IconButton label="Próximo mês" onClick={() => setMonth(addMonths(month, 1))}>
              <ChevronRight size={20} aria-hidden="true" />
            </IconButton>
          </div>
        }
      >
        <div className="panel">
          <div className="heatmap" role="group" aria-label={`Conclusões de ${formatMonthYear(month)}`}>
            {heads.map((h, i) => (
              <div key={i} className="heatmap-head" aria-hidden="true">
                {h}
              </div>
            ))}
            {days.map((d) => {
              const inMonth = d >= monthStart && d <= endOfMonth(month);
              const scheduled = isScheduledOn(habit, d);
              const rec = byDate.get(d);
              const future = d > today;
              const cls = ['heat'];
              if (!inMonth) return <div key={d} className="heat" aria-hidden="true" />;
              if (scheduled || rec) cls.push('is-scheduled');
              if (rec?.status === 'done') cls.push('is-done');
              else if (rec?.status === 'skipped') cls.push('is-skipped');
              else if (scheduled && !future && d < today) cls.push('is-missed');
              if (d === today) cls.push('is-today');
              if (future) cls.push('is-future');
              const status = rec?.status === 'done' ? 'concluído' : rec?.status === 'skipped' ? 'pulado' : scheduled ? (future ? 'previsto' : d === today ? 'previsto hoje, em aberto' : 'perdido') : 'sem ocorrência prevista';
              const interactive = (scheduled || rec) && !future;
              // Número visível primeiro; data por extenso e situação para leitores de tela.
              const content = (
                <>
                  {parseCivil(d).d}
                  <span className="visually-hidden">
                    {' '}
                    ({formatLongDate(d)}: {status})
                  </span>
                </>
              );
              return interactive ? (
                <button key={d} type="button" className={cls.join(' ')} onClick={() => setDayMenu(d)}>
                  {content}
                </button>
              ) : (
                <div key={d} className={cls.join(' ')}>
                  {content}
                </div>
              );
            })}
          </div>
          <div className="legend" style={{ marginTop: 12 }}>
            <span className="legend-item">
              <span className="swatch" style={{ background: 'var(--accent)' }} /> Concluído
            </span>
            <span className="legend-item">
              <span className="swatch" style={{ background: 'var(--surface-3)', borderColor: 'var(--line)' }} /> Perdido
            </span>
            <span className="legend-item">
              <span className="swatch" style={{ border: '1px dashed var(--ink-3)' }} /> Pulado
            </span>
            <span className="legend-item">
              <span className="swatch" style={{ border: '1px solid var(--line-input)', background: 'var(--surface)' }} /> Previsto
            </span>
            <span className="legend-item">
              <span className="swatch" style={{ boxShadow: '0 0 0 2px var(--now)' }} /> Hoje
            </span>
          </div>
          <p className="meta" style={{ marginTop: 8 }}>
            Toque num dia previsto para registrar ou corrigir. Dias futuros não podem ser marcados.
          </p>
        </div>
      </Section>

      <Section title="Configuração" id="habit-config">
        <div className="panel">
          <dl className="kv">
            <dt>Frequência</dt>
            <dd>
              {habit.scheduleHistory.map((v, i) => (
                <span key={v.from} style={{ display: 'block' }}>
                  {describeSchedule(v.schedule)} {i === 0 ? `desde ${formatDate(v.from)}` : `a partir de ${formatDate(v.from)}`}
                </span>
              ))}
            </dd>
            <dt>Horário</dt>
            <dd>{describeTiming(habit.timing)}{habit.durationMinutes ? `, cerca de ${habit.durationMinutes} min` : ''}</dd>
            <dt>Lembrete</dt>
            <dd>{habit.reminder.enabled ? `Às ${habit.reminder.time}` : 'Desligado'}</dd>
            <dt>Primeiro passo</dt>
            <dd>{habit.firstStep ?? 'Não definido'}</dd>
            <dt>XP por conclusão</dt>
            <dd>{habit.xp}</dd>
            <dt>Meta vinculada</dt>
            <dd>{goal ? <Link to={`/metas/${goal.id}`}>{goal.title} ({HORIZON_LABEL[goal.horizon]})</Link> : 'Nenhuma'}</dd>
            <dt>Pausas</dt>
            <dd>
              {habit.pauses.length === 0
                ? 'Nenhuma'
                : habit.pauses.map((p) => (
                    <span key={p.from} style={{ display: 'block' }}>
                      {formatDate(p.from)} a {p.to ? formatDate(p.to) : 'agora'}
                    </span>
                  ))}
            </dd>
          </dl>
        </div>
      </Section>

      <Section title="Registros recentes" id="habit-records">
        {recent.length === 0 ? (
          <p className="meta">Nenhum registro ainda. Conclua pela tela Hoje ou pelo calendário acima.</p>
        ) : (
          <ul className="list" role="list">
            {recent.map((c) => (
              <li key={c.id} className="list-row">
                <div className="row-main">
                  <span className="row-title">{capitalize(formatLongDate(c.scheduledDate))}</span>
                  <span className="row-meta">
                    <Tag tone={c.status === 'done' ? 'accent' : undefined}>{c.status === 'done' ? 'Concluído' : 'Pulado'}</Tag>
                    <span>Registrado em {formatInstant(c.completedAt, timezone)}</span>
                    {c.status === 'done' && <span>+{c.xpAwarded} XP</span>}
                  </span>
                  {c.note && <span className="small muted">{c.note}</span>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <ActionSheet
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        title={habit.title}
        actions={[
          { label: 'Pausar', icon: <Pause size={18} aria-hidden="true" />, hidden: habit.status !== 'active', onSelect: () => void run(() => pauseHabit(habit.id, { today }), 'Hábito pausado.') },
          { label: 'Retomar', icon: <Play size={18} aria-hidden="true" />, hidden: habit.status !== 'paused', onSelect: () => void run(() => resumeHabit(habit.id, { today }), 'Hábito retomado.') },
          { label: 'Arquivar', icon: <Archive size={18} aria-hidden="true" />, hidden: habit.status === 'archived', onSelect: () => void run(() => archiveHabit(habit.id, { today }), 'Hábito arquivado.') },
          { label: 'Reativar', icon: <ArchiveRestore size={18} aria-hidden="true" />, hidden: habit.status !== 'archived', onSelect: () => void run(() => unarchiveHabit(habit.id, { today }), 'Hábito reativado.') },
          { label: 'Excluir definitivamente', icon: <Trash size={18} aria-hidden="true" />, danger: true, onSelect: () => setConfirmDelete(true) },
        ]}
      />

      <ActionSheet
        open={dayMenu !== null}
        onClose={() => setDayMenu(null)}
        title={dayMenu ? capitalize(formatLongDate(dayMenu, true)) : ''}
        description={dayMenu && !isScheduledOn(habit, dayMenu) ? 'Este dia não tem ocorrência prevista na frequência atual; você pode apenas remover o registro existente.' : undefined}
        actions={
          dayMenu
            ? [
                { label: 'Marcar como concluído', hidden: byDate.get(dayMenu)?.status === 'done' || !isScheduledOn(habit, dayMenu), onSelect: () => void record(dayMenu, 'done') },
                { label: 'Marcar como pulado (neutro)', hidden: byDate.get(dayMenu)?.status === 'skipped' || !isScheduledOn(habit, dayMenu), onSelect: () => void record(dayMenu, 'skipped') },
                { label: 'Remover registro', hidden: !byDate.get(dayMenu), danger: true, onSelect: () => void record(dayMenu, 'clear') },
              ]
            : []
        }
      />

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Excluir hábito?"
        danger
        confirmLabel="Excluir hábito"
        message={
          <div className="stack small">
            <p>
              Isso apaga <strong>{habit.title}</strong>, {plural(completions.length, 'registro', 'registros')}, o XP ganho com ele e os blocos de tempo na agenda. Não dá para desfazer.
            </p>
            <p>Se quiser só tirar da rotina mantendo o histórico, prefira arquivar.</p>
          </div>
        }
        onConfirm={async () => {
          try {
            await deleteHabit(habit.id);
            toast.show('Hábito excluído.');
            navigate('/habitos');
          } catch (e) {
            toast.show(describeError(e), { tone: 'danger' });
          }
        }}
      />
    </div>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
