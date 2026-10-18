import { ArrowDown, ArrowUp, Plus, Repeat } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useApp } from '../../app/context';
import { Segmented, SelectField } from '../../components/form';
import { useToast } from '../../components/toast';
import { ButtonLink, EmptyState, LoadingState, PageHeader, Tag } from '../../components/ui';
import { useCompletions, useHabits } from '../../db/hooks';
import { moveHabit } from '../../db/repo-habits';
import { describeError } from '../../db/errors';
import { addDays } from '../../domain/civil';
import { currentSchedule, describeSchedule, describeTiming } from '../../domain/schedule';
import { formatRate, groupCompletions, habitStatsBetween } from '../../domain/stats';
import { computeStreak } from '../../domain/streak';
import { useUiPref } from '../../lib/browser';

type StatusFilter = 'active' | 'paused' | 'archived' | 'all';

export function HabitsPage() {
  const { today } = useApp();
  const habits = useHabits();
  const completions = useCompletions();
  const toast = useToast();
  const [status, setStatus] = useUiPref<StatusFilter>('habits.status', 'active');
  const [category, setCategory] = useState('');

  const rows = useMemo(() => {
    if (!habits || !completions) return null;
    const by = groupCompletions(completions);
    return habits
      .filter((h) => (status === 'all' ? true : h.status === status))
      .filter((h) => (category ? h.category === category : true))
      .map((h) => {
        const lookup = by.get(h.id) ?? new Map();
        return { habit: h, streak: computeStreak(h, lookup, today), stats30: habitStatsBetween(h, lookup, addDays(today, -29), today, today) };
      });
  }, [habits, completions, status, category, today]);

  const categories = useMemo(() => [...new Set((habits ?? []).map((h) => h.category))].sort((a, b) => a.localeCompare(b, 'pt-BR')), [habits]);
  const reorderable = status === 'active' && !category;

  return (
    <div className="page">
      <PageHeader
        title="Hábitos"
        subtitle="Crie, ajuste, pause e acompanhe cada hábito."
        actions={
          <ButtonLink to="/habitos/novo" variant="primary" icon={<Plus size={18} aria-hidden="true" />}>
            Novo hábito
          </ButtonLink>
        }
      />
      <div className="row" style={{ marginBottom: 16, alignItems: 'flex-end', gap: 16 }}>
        <Segmented
          label="Mostrar"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'active', label: 'Ativos' },
            { value: 'paused', label: 'Pausados' },
            { value: 'archived', label: 'Arquivados' },
            { value: 'all', label: 'Todos' },
          ]}
        />
        {categories.length > 1 && (
          <div style={{ minWidth: 200 }}>
            <SelectField label="Categoria" value={category} onChange={setCategory} options={[{ value: '', label: 'Todas' }, ...categories.map((c) => ({ value: c, label: c }))]} />
          </div>
        )}
      </div>

      {!rows ? (
        <LoadingState />
      ) : habits && habits.length === 0 ? (
        <EmptyState
          icon={<Repeat size={20} />}
          title="Nenhum hábito ainda"
          action={
            <ButtonLink to="/habitos/novo" variant="primary" icon={<Plus size={18} aria-hidden="true" />}>
              Criar primeiro hábito
            </ButtonLink>
          }
        >
          <p>Um hábito tem nome, frequência (todos os dias ou dias da semana) e, se quiser, horário, lembrete e um primeiro passo pequeno.</p>
        </EmptyState>
      ) : rows.length === 0 ? (
        <EmptyState title="Nenhum hábito neste filtro">
          <p>Troque o filtro acima para ver os demais.</p>
        </EmptyState>
      ) : (
        <ul className="list" role="list">
          {rows.map(({ habit: h, streak, stats30 }, index) => (
            <li key={h.id} className="list-row">
              <div className="row-main">
                <Link to={`/habitos/${h.id}`} className="row-link">
                  <span className="row-title">{h.title}</span>
                </Link>
                <span className="row-meta">
                  <span>{h.category}</span>
                  <span>{describeSchedule(currentSchedule(h))}</span>
                  <span>{describeTiming(h.timing)}</span>
                  {h.status === 'paused' && <Tag tone="warn">Pausado</Tag>}
                  {h.status === 'archived' && <Tag>Arquivado</Tag>}
                </span>
                <span className="row-meta">
                  <span>Sequência: {streak.current}</span>
                  <span>
                    30 dias: {formatRate(stats30.rate)}
                    {stats30.done + stats30.missed > 0 ? ` (${stats30.done}/${stats30.done + stats30.missed})` : ''}
                  </span>
                </span>
              </div>
              {reorderable && (
                <div className="row" style={{ gap: 0 }}>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Mover ${h.title} para cima`}
                    disabled={index === 0}
                    onClick={() => void moveHabit(h.id, -1).catch((e) => toast.show(describeError(e), { tone: 'danger' }))}
                  >
                    <ArrowUp size={18} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Mover ${h.title} para baixo`}
                    disabled={index === rows.length - 1}
                    onClick={() => void moveHabit(h.id, 1).catch((e) => toast.show(describeError(e), { tone: 'danger' }))}
                  >
                    <ArrowDown size={18} aria-hidden="true" />
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {reorderable && rows && rows.length > 1 && <p className="meta" style={{ marginTop: 8 }}>A ordem vale para listas e para hábitos com o mesmo horário na tela Hoje.</p>}
    </div>
  );
}
