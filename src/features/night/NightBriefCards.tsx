import { CalendarClock, Check, Flag, Sunrise, Target, Sun } from 'lucide-react';
import { Link } from 'react-router';
import { GOOGLE_EVENT_COLORS } from '../../../shared/calendar';
import { Button, Tag } from '../../components/ui';
import { diffDays } from '../../domain/civil';
import { formatShortDate, plural } from '../../domain/format';
import { HORIZON_LABEL } from '../../domain/goals';
import type { NightAgendaItem, NightBrief, NightGoal, NightTomorrowHabit } from '../../domain/nightly';

const PACE_LABEL: Record<NightGoal['state'], { label: string; tone?: 'ok' | 'warn' | 'accent' }> = {
  ahead: { label: 'Acima do ritmo', tone: 'ok' },
  on_track: { label: 'No ritmo', tone: 'accent' },
  behind: { label: 'Abaixo do ritmo', tone: 'warn' },
  done: { label: 'Alcançada', tone: 'ok' },
  no_target: { label: 'Sem alvo numérico' },
};

function itemTime(i: Pick<NightAgendaItem, 'allDay' | 'start' | 'end'>): string {
  if (i.allDay || !i.start) return 'Dia todo';
  return i.end ? `${i.start}–${i.end}` : i.start;
}

function SourceDot({ item }: { item: NightAgendaItem }) {
  const color = item.source === 'google' ? (item.colorId ? GOOGLE_EVENT_COLORS[item.colorId] : 'var(--chart-series-1)') : item.kind === 'habit_block' ? 'var(--accent)' : 'var(--ink-3)';
  return <span className="night-dot" style={{ background: color }} aria-hidden="true" />;
}

function whenLabel(date: string, base: string): string {
  const d = diffDays(date, base);
  if (d === 1) return 'amanhã';
  return `em ${d} dias (${formatShortDate(date)})`;
}

export function NightBriefCards({
  brief,
  googleNote,
  onCompleteHabit,
}: {
  brief: NightBrief;
  /** Situação da leitura de eventos do Google, para deixar claro de onde vem a agenda. */
  googleNote: string;
  onCompleteHabit: (habitId: string) => void;
}) {
  const { today } = brief;
  const possible = today.habits.filter((h) => h.stillPossible);
  const openTasks = today.tasks.filter((t) => !t.done);
  // Amanhã em ordem cronológica: dia inteiro primeiro, depois por horário (agenda, Google e hábitos juntos).
  const tomorrowRows: Array<{ type: 'item'; item: NightAgendaItem; sort: string } | { type: 'habit'; habit: NightTomorrowHabit; sort: string }> = [
    ...brief.tomorrowItems.map((item) => ({ type: 'item' as const, item, sort: item.allDay ? '00:00:0' : `${item.start ?? '99:99'}:1` })),
    ...brief.tomorrowHabits.filter((h) => !h.fromBlock).map((habit) => ({ type: 'habit' as const, habit, sort: `${habit.start ?? '99:99'}:2` })),
  ].sort((a, b) => (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0));
  return (
    <div className="night-grid">
      <article className="night-card" aria-labelledby="night-today">
        <h3 id="night-today" className="night-card-title">
          <Sun size={18} aria-hidden="true" /> Hoje
        </h3>
        {today.habits.length === 0 ? (
          <p className="small muted">Nenhum hábito previsto hoje.</p>
        ) : (
          <p className="night-big">
            {today.done} <span className="night-big-of">de {today.countable}</span>
            <span className="night-big-label">{today.countable === 1 ? 'hábito concluído' : 'hábitos concluídos'}</span>
          </p>
        )}
        <p className="meta">
          {today.xp > 0 ? `${today.xp} XP hoje` : 'Sem XP registrado hoje'}
          {today.skipped > 0 ? ` · ${plural(today.skipped, 'pulado', 'pulados')}` : ''}
          {today.tasks.length > 0 ? ` · tarefas: ${today.tasks.length - openTasks.length} de ${today.tasks.length}` : ''}
        </p>
        {possible.length > 0 && (
          <div className="stack-sm" style={{ marginTop: 10 }}>
            <p className="field-label">Ainda dá tempo</p>
            <ul className="night-list" role="list">
              {possible.map((h) => (
                <li key={h.habit.id}>
                  <span className="grow">
                    {h.habit.title}
                    {h.habit.firstStep && <span className="meta"> · {h.habit.firstStep}</span>}
                  </span>
                  <Button size="sm" icon={<Check size={16} aria-hidden="true" />} onClick={() => onCompleteHabit(h.habit.id)} aria-label={`Concluir ${h.habit.title}`}>
                    Feito
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </article>

      <article className="night-card" aria-labelledby="night-tomorrow">
        <h3 id="night-tomorrow" className="night-card-title">
          <Sunrise size={18} aria-hidden="true" /> Amanhã, {brief.tomorrowWeekday}
        </h3>
        {brief.firstCommitment ? (
          <p className="small">
            Primeiro compromisso: <strong>{brief.firstCommitment.start}</strong> · {brief.firstCommitment.title}
          </p>
        ) : (
          <p className="small muted">Nenhum compromisso com horário.</p>
        )}
        {tomorrowRows.length > 0 && (
          <ul className="night-list" role="list" style={{ marginTop: 8 }}>
            {tomorrowRows.slice(0, 12).map((row) =>
              row.type === 'item' ? (
                <li key={row.item.key}>
                  <SourceDot item={row.item} />
                  <span className="night-time">{itemTime(row.item)}</span>
                  <span className="grow">
                    {row.item.title}
                    {row.item.source === 'google' && <span className="meta"> · Google</span>}
                    {row.item.kind === 'habit_block' && <span className="meta"> · bloco</span>}
                    {!row.item.busy && <span className="meta"> · livre</span>}
                  </span>
                  {row.item.flag && <Tag tone="warn">{row.item.flag === 'prova' ? 'Prova?' : 'Prazo?'}</Tag>}
                </li>
              ) : (
                <li key={row.habit.habit.id}>
                  <span className="night-dot" style={{ background: 'var(--accent)' }} aria-hidden="true" />
                  <span className="night-time">{row.habit.start ? (row.habit.end ? `${row.habit.start}–${row.habit.end}` : row.habit.start) : 'Sem horário'}</span>
                  <span className="grow">
                    {row.habit.habit.title} <span className="meta">· hábito</span>
                  </span>
                </li>
              ),
            )}
          </ul>
        )}
        {tomorrowRows.length > 12 && <p className="meta">E mais {tomorrowRows.length - 12} na agenda.</p>}
        <p className="field-label" style={{ marginTop: 12 }}>
          Janelas livres
        </p>
        {brief.freeWindows.length > 0 ? (
          <div className="chips">
            {brief.freeWindows.map((w) => (
              <span key={`${w.start}-${w.end}`} className="tag">
                {w.start}–{w.end}
              </span>
            ))}
          </div>
        ) : (
          <p className="small muted">Nenhuma janela livre de 20 minutos ou mais dentro da sua disponibilidade.</p>
        )}
        <p className="meta" style={{ marginTop: 10 }}>
          <CalendarClock size={14} aria-hidden="true" style={{ display: 'inline', verticalAlign: '-2px', marginRight: 4 }} />
          {googleNote}
        </p>
      </article>

      <article className="night-card" aria-labelledby="night-radar">
        <h3 id="night-radar" className="night-card-title">
          <Flag size={18} aria-hidden="true" /> No radar (7 dias)
        </h3>
        {brief.radar.length === 0 ? (
          <p className="small muted">Nenhuma prova ou prazo encontrado pelos títulos da agenda.</p>
        ) : (
          <ul className="night-list" role="list">
            {brief.radar.slice(0, 8).map((i) => (
              <li key={i.key}>
                <Tag tone={i.flag === 'prova' ? 'warn' : 'accent'}>{i.flag === 'prova' ? 'Prova' : 'Prazo'}</Tag>
                <span className="grow">
                  {i.title}
                  <span className="meta">
                    {' '}
                    · {whenLabel(i.date, brief.date)}
                    {!i.allDay && i.start ? `, ${i.start}` : ''}
                    {i.source === 'google' ? ' · Google' : ''}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="meta" style={{ marginTop: 8 }}>
          Detectado pelo título (palavras como prova, avaliação, entrega, prazo). Pode errar: confira na agenda.
        </p>
      </article>

      <article className="night-card" aria-labelledby="night-goals">
        <h3 id="night-goals" className="night-card-title">
          <Target size={18} aria-hidden="true" /> Metas em andamento
        </h3>
        {brief.goals.length === 0 ? (
          <p className="small muted">
            Nenhuma meta ativa no período de hoje. <Link to="/metas">Ver metas</Link>
          </p>
        ) : (
          <ul className="night-list" role="list">
            {brief.goals.slice(0, 6).map((g) => (
              <li key={g.goal.id}>
                <span className="grow">
                  <Link to={`/metas/${g.goal.id}`}>{g.goal.title}</Link>
                  <span className="meta">
                    {' '}
                    · {HORIZON_LABEL[g.goal.horizon]}
                    {g.progress.target !== null ? ` · ${g.progress.current} de ${g.progress.target} ${g.progress.unit}` : ''}
                    {g.needed ? ` · ${g.needed}` : ''}
                  </span>
                </span>
                <Tag tone={PACE_LABEL[g.state].tone}>{PACE_LABEL[g.state].label}</Tag>
              </li>
            ))}
          </ul>
        )}
        {brief.goals.some((g) => g.state !== 'no_target' && g.state !== 'done') && (
          <p className="meta" style={{ marginTop: 8 }}>
            Ritmo = progresso atual comparado ao esperado para os dias já passados do período.
          </p>
        )}
      </article>
    </div>
  );
}
