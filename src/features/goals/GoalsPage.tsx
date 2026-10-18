import { Plus, Target } from 'lucide-react';
import { useMemo } from 'react';
import { Link } from 'react-router';
import { useApp } from '../../app/context';
import { Segmented } from '../../components/form';
import { ButtonLink, EmptyState, LoadingState, PageHeader, Section, Tag } from '../../components/ui';
import { formatRange } from '../../domain/format';
import { computeGoalProgress, goalTimeState, HORIZON_LABEL, HORIZON_ORDER, HORIZON_PLURAL } from '../../domain/goals';
import type { Goal, GoalHorizon } from '../../domain/schemas';
import { useUiPref } from '../../lib/browser';
import { useGoalContext } from '../shared/data';
import { GoalProgressView } from './goal-ui';

type HorizonFilter = 'all' | GoalHorizon;
type StatusFilter = 'active' | 'completed' | 'archived';

export function GoalsPage() {
  const { today } = useApp();
  const ctx = useGoalContext();
  const [horizon, setHorizon] = useUiPref<HorizonFilter>('goals.horizon', 'all');
  const [status, setStatus] = useUiPref<StatusFilter>('goals.status', 'active');

  const grouped = useMemo(() => {
    if (!ctx) return null;
    const list = ctx.goals.filter((g) => g.status === status && (horizon === 'all' || g.horizon === horizon));
    const byHorizon = new Map<GoalHorizon, Goal[]>();
    for (const h of HORIZON_ORDER) byHorizon.set(h, []);
    for (const g of list.sort((a, b) => (a.periodStart < b.periodStart ? -1 : 1))) byHorizon.get(g.horizon)!.push(g);
    return byHorizon;
  }, [ctx, horizon, status]);

  const titleOf = (id: string | undefined) => ctx?.goals.find((g) => g.id === id)?.title;

  return (
    <div className="page">
      <PageHeader
        title="Metas"
        subtitle="Anuais, mensais, semanais e diárias. Vincular metas entre si é opcional."
        actions={
          <ButtonLink to="/metas/nova" variant="primary" icon={<Plus size={18} aria-hidden="true" />}>
            Nova meta
          </ButtonLink>
        }
      />
      <div className="row" style={{ gap: 16, marginBottom: 16, alignItems: 'flex-end' }}>
        <Segmented
          label="Horizonte"
          value={horizon}
          onChange={setHorizon}
          options={[{ value: 'all', label: 'Todas' }, ...HORIZON_ORDER.map((h) => ({ value: h, label: HORIZON_PLURAL[h] }))]}
        />
        <Segmented
          label="Estado"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'active', label: 'Ativas' },
            { value: 'completed', label: 'Concluídas' },
            { value: 'archived', label: 'Arquivadas' },
          ]}
        />
      </div>

      {!ctx || !grouped ? (
        <LoadingState />
      ) : ctx.goals.length === 0 ? (
        <EmptyState
          icon={<Target size={20} />}
          title="Nenhuma meta ainda"
          action={
            <ButtonLink to="/metas/nova" variant="primary" icon={<Plus size={18} aria-hidden="true" />}>
              Criar primeira meta
            </ButtonLink>
          }
        >
          <p>
            Uma meta tem período e um jeito explícito de medir: conclusão manual, valor que você atualiza, conclusões de hábitos e tarefas vinculados, ou metas filhas concluídas. Você pode ligar uma meta anual a metas mensais, e assim por diante, se quiser.
          </p>
        </EmptyState>
      ) : [...grouped.values()].every((l) => l.length === 0) ? (
        <EmptyState title="Nenhuma meta neste filtro">
          <p>Troque o horizonte ou o estado acima.</p>
        </EmptyState>
      ) : (
        HORIZON_ORDER.filter((h) => grouped.get(h)!.length > 0).map((h) => (
          <Section key={h} title={HORIZON_PLURAL[h]} id={`goals-${h}`}>
            <ul className="list" role="list">
              {grouped.get(h)!.map((g) => {
                const progress = computeGoalProgress(g, ctx);
                const time = goalTimeState(g, today);
                const children = ctx.goals.filter((c) => c.parentId === g.id && c.status !== 'archived').length;
                return (
                  <li key={g.id} className="list-row" style={{ alignItems: 'flex-start', paddingTop: 12, paddingBottom: 12 }}>
                    <div className="row-main" style={{ gap: 8 }}>
                      <Link to={`/metas/${g.id}`} className="row-link">
                        <span className="row-title">{g.title}</span>
                      </Link>
                      <span className="row-meta">
                        <span>{formatRange(g.periodStart, g.periodEnd)}</span>
                        {time === 'upcoming' && <Tag>Futura</Tag>}
                        {time === 'past' && g.status === 'active' && <Tag tone="warn">Período encerrado</Tag>}
                        {g.parentId && <span>Parte de: {titleOf(g.parentId) ?? 'meta removida'}</span>}
                        {children > 0 && <span>{children} meta{children === 1 ? '' : 's'} filha{children === 1 ? '' : 's'}</span>}
                      </span>
                      <GoalProgressView progress={progress} compact />
                    </div>
                    <Tag>{HORIZON_LABEL[g.horizon]}</Tag>
                  </li>
                );
              })}
            </ul>
          </Section>
        ))
      )}
    </div>
  );
}
