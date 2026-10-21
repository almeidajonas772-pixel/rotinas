import { Archive, ArchiveRestore, CalendarPlus, Check, Compass, Ellipsis, Link2, Pencil, Plus, RotateCcw, Trash, Unlink } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { KaiGoalBreakdownOutput } from '../../../shared/kai';
import { useApp } from '../../app/context';
import { ActionSheet, ConfirmDialog } from '../../components/dialog';
import { SelectField, TextField } from '../../components/form';
import { useToast } from '../../components/toast';
import { Button, ButtonLink, EmptyState, Explain, IconButton, LoadingState, Notice, PageHeader, Section, Tag } from '../../components/ui';
import { describeError } from '../../db/errors';
import { addManualProgress, archiveGoal, completeGoal, deleteGoal, deleteManualProgress, linkAgendaItemToGoal, reopenGoal, unarchiveGoal } from '../../db/repo-goals';
import { linkHabitToGoal } from '../../db/repo-habits';
import { seriesDates } from '../../domain/agenda';
import { addDays, minCivil } from '../../domain/civil';
import { formatDate, formatInstant, formatLongDate, formatRange } from '../../domain/format';
import { computeGoalProgress, goalTimeState, HORIZON_LABEL, HORIZON_ORDER, linkedItems } from '../../domain/goals';
import { buildKaiContext } from '../../domain/kai-context';
import { isScheduledOn } from '../../domain/schedule';
import type { Goal } from '../../domain/schemas';
import { GOAL_COMPLETION_XP } from '../../domain/xp';
import { runKai, useKaiAvailability, useKaiSnapshot } from '../kai/kai-client';
import { useGoalContext, type FullGoalContext } from '../shared/data';
import { GoalProgressView } from './goal-ui';

export function GoalDetailPage() {
  const { id } = useParams();
  const ctx = useGoalContext();
  if (!ctx) {
    return (
      <div className="page">
        <LoadingState />
      </div>
    );
  }
  const goal = ctx.goals.find((g) => g.id === id);
  if (!goal) {
    return (
      <div className="page">
        <PageHeader title="Meta não encontrada" back={{ to: '/metas', label: 'Metas' }} />
        <Notice tone="warn">Esta meta não existe mais.</Notice>
      </div>
    );
  }
  return <GoalDetail goal={goal} ctx={ctx} />;
}

function GoalDetail({ goal, ctx }: { goal: Goal; ctx: FullGoalContext }) {
  const { today, timezone, prefs } = useApp();
  const navigate = useNavigate();
  const toast = useToast();
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [manualValue, setManualValue] = useState('');
  const [manualNote, setManualNote] = useState('');
  const [manualError, setManualError] = useState<string>();
  const [linkHabitId, setLinkHabitId] = useState('');
  const [linkTaskId, setLinkTaskId] = useState('');
  const [kai] = useKaiAvailability();
  const snapshot = useKaiSnapshot();
  const [breakdown, setBreakdown] = useState<{ status: 'idle' | 'loading' | 'error' | 'done'; message?: string; data?: KaiGoalBreakdownOutput; dismissed: number[] }>({ status: 'idle', dismissed: [] });

  const progress = computeGoalProgress(goal, ctx);
  const time = goalTimeState(goal, today);
  const parent = ctx.goals.find((g) => g.id === goal.parentId);
  const children = ctx.goals.filter((g) => g.parentId === goal.id);
  const direct = linkedItems(goal, ctx, false);
  const linkedHabits = ctx.habits.filter((h) => h.goalId === goal.id);
  const linkedTasks = ctx.agendaItems.filter((i) => i.goalId === goal.id && i.kind !== 'habit');
  const freeHabits = ctx.habits.filter((h) => h.goalId !== goal.id && h.status !== 'archived');
  const freeTasks = ctx.agendaItems.filter((i) => i.kind === 'task' && i.goalId !== goal.id);
  const entries = ctx.progressEntries.filter((e) => e.goalId === goal.id).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const doneAgenda = new Set(ctx.agendaCompletions.map((c) => `${c.itemId}|${c.occurrenceDate}`));

  // Próximos passos: metas filhas ativas, ocorrências futuras de tarefas vinculadas e hábitos vinculados de hoje ainda abertos.
  const horizonEnd = minCivil(goal.periodEnd, addDays(today, 30));
  const nextTasks = linkedTasks
    .flatMap((t) => (t.date ? seriesDates(t, today, horizonEnd).map((d) => ({ item: t, date: d })) : [{ item: t, date: undefined as string | undefined }]))
    .filter(({ item, date }) => !date || !doneAgenda.has(`${item.id}|${date}`))
    .slice(0, 6);
  const habitsToday = linkedHabits.filter(
    (h) => h.status === 'active' && isScheduledOn(h, today) && !ctx.habitCompletions.some((c) => c.habitId === h.id && c.scheduledDate === today),
  );
  const activeChildren = children.filter((c) => c.status === 'active');
  const childHorizon = HORIZON_ORDER[HORIZON_ORDER.indexOf(goal.horizon) + 1] as Goal['horizon'] | undefined;
  const counted =
    goal.progressRule.kind === 'linked_completions'
      ? (() => {
          const all = linkedItems(goal, ctx, goal.progressRule.includeDescendants);
          const habitIds = new Set(all.habits.map((h) => h.id));
          const titles = new Map([...all.habits.map((h) => [h.id, h.title] as const), ...all.tasks.map((t) => [t.id, t.title] as const)]);
          const fromHabits = ctx.habitCompletions
            .filter((c) => c.status === 'done' && habitIds.has(c.habitId) && c.scheduledDate >= goal.periodStart && c.scheduledDate <= goal.periodEnd)
            .map((c) => ({ date: c.scheduledDate, title: titles.get(c.habitId) ?? 'Hábito' }));
          const taskIds = new Set(all.tasks.map((t) => t.id));
          const fromTasks = ctx.agendaCompletions
            .filter((c) => taskIds.has(c.itemId) && c.occurrenceDate >= goal.periodStart && c.occurrenceDate <= goal.periodEnd)
            .map((c) => ({ date: c.occurrenceDate, title: titles.get(c.itemId) ?? 'Tarefa' }));
          return [...fromHabits, ...fromTasks].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 10);
        })()
      : [];

  async function run(action: () => Promise<void>, message: string) {
    try {
      await action();
      toast.show(message);
    } catch (e) {
      toast.show(describeError(e), { tone: 'danger' });
    }
  }

  async function askBreakdown() {
    if (!snapshot) return;
    setBreakdown({ status: 'loading', dismissed: [] });
    try {
      const built = buildKaiContext(snapshot, { period: { start: addDays(today, -13), end: today } });
      const res = await runKai(
        'goal-breakdown',
        {
          context: built.context,
          goal: { title: goal.title, description: goal.description, horizon: goal.horizon, periodStart: goal.periodStart, periodEnd: goal.periodEnd },
          childHorizon: childHorizon ?? null,
          maxSteps: 5,
        },
        prefs,
      );
      if (!res.ok) setBreakdown({ status: 'error', message: res.message, dismissed: [] });
      else setBreakdown({ status: 'done', data: res.data, dismissed: [] });
    } catch (e) {
      setBreakdown({ status: 'error', message: e instanceof Error ? e.message : 'Falha ao montar o contexto.', dismissed: [] });
    }
  }

  function reviewStep(step: KaiGoalBreakdownOutput['steps'][number]) {
    const p = new URLSearchParams({ titulo: step.title });
    if (step.kind === 'meta_filha') {
      p.set('pai', goal.id);
      if (step.horizon) p.set('horizonte', step.horizon);
      if (step.detail) p.set('descricao', step.detail);
      navigate(`/metas/nova?${p.toString()}`);
    } else if (step.kind === 'habito') {
      p.set('meta', goal.id);
      if (step.detail) p.set('intencao', step.detail);
      if (step.scheduleKind === 'weekly' && step.days.length > 0) p.set('dias', step.days.join(','));
      navigate(`/habitos/novo?${p.toString()}`);
    } else {
      p.set('novo', '1');
      p.set('meta', goal.id);
      p.set('tipo', 'task');
      navigate(`/agenda?${p.toString()}`);
    }
  }

  return (
    <div className="page">
      <PageHeader
        title={goal.title}
        subtitle={`Meta ${HORIZON_LABEL[goal.horizon].toLowerCase()}, de ${formatLongDate(goal.periodStart, true)} a ${formatLongDate(goal.periodEnd, true)}.`}
        back={{ to: '/metas', label: 'Metas' }}
        actions={
          <>
            <ButtonLink to={`/metas/${goal.id}/editar`} icon={<Pencil size={18} aria-hidden="true" />}>
              Editar
            </ButtonLink>
            <IconButton label="Mais ações" onClick={() => setMenuOpen(true)}>
              <Ellipsis size={20} aria-hidden="true" />
            </IconButton>
          </>
        }
      />

      {goal.description && <p className="prose" style={{ marginBottom: 16 }}>{goal.description}</p>}
      {goal.status === 'completed' && (
        <Notice tone="ok" title="Meta concluída" action={<Button size="sm" icon={<RotateCcw size={16} aria-hidden="true" />} onClick={() => void run(() => reopenGoal(goal.id), 'Meta reaberta.')}>Reabrir</Button>}>
          Concluída em {goal.completedOn ? formatDate(goal.completedOn) : '—'} (+{GOAL_COMPLETION_XP[goal.horizon]} XP).
        </Notice>
      )}
      {goal.status === 'archived' && <Notice tone="neutral" title="Meta arquivada">Fica fora das listas ativas. Conclusões e XP anteriores são mantidos.</Notice>}
      {time === 'past' && goal.status === 'active' && <Notice tone="warn">O período desta meta já terminou. Você pode concluí-la, arquivá-la ou editar o período.</Notice>}

      <Section title="Progresso" id="goal-progress">
        <div className="panel stack">
          <GoalProgressView progress={progress} />
          <p className="small muted">{progress.explanation}</p>
          {progress.reached && goal.status === 'active' && (
            <Notice tone="ok" title="Alvo atingido" action={<Button size="sm" variant="primary" icon={<Check size={16} aria-hidden="true" />} onClick={() => void run(() => completeGoal(goal.id, { today }), 'Meta concluída.')}>Marcar como concluída</Button>}>
              A meta não é concluída sozinha: confirme quando fizer sentido para você.
            </Notice>
          )}
          {goal.status === 'active' && !progress.reached && (
            <div>
              <Button icon={<Check size={18} aria-hidden="true" />} onClick={() => void run(() => completeGoal(goal.id, { today }), 'Meta concluída.')}>
                Marcar como concluída
              </Button>
            </div>
          )}
          <Explain summary="O que conta para esta meta">
            <p>
              Hábitos e tarefas vinculados só alteram o progresso quando a regra é “itens vinculados”. Com outras regras, eles aparecem aqui como apoio, mas não provam a meta sozinhos.
            </p>
            <p>Concluir a meta registra {GOAL_COMPLETION_XP[goal.horizon]} XP (valor fixo por horizonte). Reabrir remove esse XP.</p>
          </Explain>
        </div>
      </Section>

      {goal.progressRule.kind === 'manual_value' && (
        <Section title="Atualizar valor" id="goal-manual" description="Informe o valor atual. Cada atualização fica no histórico, marcada como manual.">
          <form
            className="panel"
            noValidate
            onSubmit={async (e) => {
              e.preventDefault();
              const v = Number(manualValue.replace(',', '.'));
              if (!Number.isFinite(v) || v < 0) {
                setManualError('Informe um número maior ou igual a zero');
                return;
              }
              setManualError(undefined);
              await run(() => addManualProgress(goal.id, v, manualNote), 'Progresso atualizado.');
              setManualValue('');
              setManualNote('');
            }}
          >
            <div className="field-row">
              <TextField label={`Valor atual (${progress.unit})`} inputMode="decimal" value={manualValue} onChange={setManualValue} error={manualError} />
              <TextField label="Nota" optional value={manualNote} onChange={setManualNote} maxLength={300} />
            </div>
            <div className="btn-row end" style={{ marginTop: 12 }}>
              <Button type="submit" variant="primary">
                Salvar atualização
              </Button>
            </div>
          </form>
          {entries.length > 0 && (
            <ul className="list" role="list" style={{ marginTop: 12 }}>
              {entries.map((e) => (
                <li key={e.id} className="list-row">
                  <div className="row-main">
                    <span className="row-title">
                      {e.value} {progress.unit}
                    </span>
                    <span className="row-meta">
                      <Tag tone="warn">Manual</Tag>
                      <span>{formatInstant(e.createdAt, timezone)}</span>
                      {e.note && <span>{e.note}</span>}
                    </span>
                  </div>
                  <IconButton label="Apagar atualização" onClick={() => void run(() => deleteManualProgress(e.id), 'Atualização apagada.')}>
                    <Trash size={18} aria-hidden="true" />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      <Section title="Próximos passos" id="goal-next">
        {activeChildren.length === 0 && nextTasks.length === 0 && habitsToday.length === 0 ? (
          <EmptyState
            title="Nenhum próximo passo definido"
            action={
              <>
                <ButtonLink to={`/agenda?novo=1&tipo=task&meta=${goal.id}`} icon={<CalendarPlus size={18} aria-hidden="true" />}>
                  Nova tarefa
                </ButtonLink>
                {childHorizon && (
                  <ButtonLink to={`/metas/nova?pai=${goal.id}&horizonte=${childHorizon}`} icon={<Plus size={18} aria-hidden="true" />}>
                    Nova meta filha
                  </ButtonLink>
                )}
              </>
            }
          >
            <p>Crie uma tarefa, vincule um hábito ou divida a meta em metas menores.</p>
          </EmptyState>
        ) : (
          <ul className="list" role="list">
            {habitsToday.map((h) => (
              <li key={`h-${h.id}`} className="list-row">
                <div className="row-main">
                  <Link to={`/habitos/${h.id}`} className="row-link">
                    <span className="row-title">{h.title}</span>
                  </Link>
                  <span className="row-meta">Hábito previsto para hoje, ainda em aberto</span>
                </div>
              </li>
            ))}
            {nextTasks.map(({ item, date }) => (
              <li key={`t-${item.id}-${date ?? 'sem-data'}`} className="list-row">
                <div className="row-main">
                  <span className="row-title">{item.title}</span>
                  <span className="row-meta">{date ? `Tarefa em ${formatDate(date)}` : 'Tarefa sem data'}</span>
                </div>
              </li>
            ))}
            {activeChildren.map((c) => (
              <li key={`g-${c.id}`} className="list-row">
                <div className="row-main">
                  <Link to={`/metas/${c.id}`} className="row-link">
                    <span className="row-title">{c.title}</span>
                  </Link>
                  <span className="row-meta">
                    Meta filha {HORIZON_LABEL[c.horizon].toLowerCase()}, {formatRange(c.periodStart, c.periodEnd)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Itens vinculados" id="goal-links" description="Vincular é opcional e pode ser desfeito a qualquer momento.">
        <div className="panel stack">
          {direct.habits.length + direct.tasks.length === 0 && <p className="meta">Nenhum hábito ou tarefa vinculado.</p>}
          {linkedHabits.length > 0 && (
            <ul className="list" role="list">
              {linkedHabits.map((h) => (
                <li key={h.id} className="list-row">
                  <div className="row-main">
                    <Link to={`/habitos/${h.id}`} className="row-link">
                      <span className="row-title">{h.title}</span>
                    </Link>
                    <span className="row-meta">Hábito</span>
                  </div>
                  <IconButton label={`Desvincular ${h.title}`} onClick={() => void run(() => linkHabitToGoal(h.id, undefined), 'Hábito desvinculado.')}>
                    <Unlink size={18} aria-hidden="true" />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
          {linkedTasks.length > 0 && (
            <ul className="list" role="list">
              {linkedTasks.map((t) => (
                <li key={t.id} className="list-row">
                  <div className="row-main">
                    <span className="row-title">{t.title}</span>
                    <span className="row-meta">{t.kind === 'task' ? 'Tarefa' : 'Evento'}{t.date ? `, ${formatDate(t.date)}` : ', sem data'}</span>
                  </div>
                  <IconButton label={`Desvincular ${t.title}`} onClick={() => void run(() => linkAgendaItemToGoal(t.id, undefined), 'Item desvinculado.')}>
                    <Unlink size={18} aria-hidden="true" />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
          <div className="field-row">
            <div>
              <SelectField label="Vincular hábito" value={linkHabitId} onChange={setLinkHabitId} options={[{ value: '', label: freeHabits.length ? 'Escolha um hábito' : 'Nenhum hábito disponível' }, ...freeHabits.map((h) => ({ value: h.id, label: h.title }))]} />
              <Button size="sm" icon={<Link2 size={16} aria-hidden="true" />} disabled={!linkHabitId} style={{ marginTop: 8 }} onClick={() => void run(() => linkHabitToGoal(linkHabitId, goal.id), 'Hábito vinculado.').then(() => setLinkHabitId(''))}>
                Vincular
              </Button>
            </div>
            <div>
              <SelectField label="Vincular tarefa" value={linkTaskId} onChange={setLinkTaskId} options={[{ value: '', label: freeTasks.length ? 'Escolha uma tarefa' : 'Nenhuma tarefa disponível' }, ...freeTasks.map((t) => ({ value: t.id, label: t.title }))]} />
              <Button size="sm" icon={<Link2 size={16} aria-hidden="true" />} disabled={!linkTaskId} style={{ marginTop: 8 }} onClick={() => void run(() => linkAgendaItemToGoal(linkTaskId, goal.id), 'Tarefa vinculada.').then(() => setLinkTaskId(''))}>
                Vincular
              </Button>
            </div>
          </div>
        </div>
      </Section>

      <Section
        title="Metas filhas"
        id="goal-children"
        action={
          childHorizon ? (
            <Link to={`/metas/nova?pai=${goal.id}&horizonte=${childHorizon}`} className="btn btn-ghost btn-sm">
              <Plus size={16} aria-hidden="true" />
              Nova meta filha
            </Link>
          ) : undefined
        }
      >
        {children.length === 0 ? (
          <p className="meta">{childHorizon ? 'Nenhuma. Metas filhas são opcionais.' : 'Metas diárias não têm metas filhas.'}</p>
        ) : (
          <ul className="list" role="list">
            {children.map((c) => (
              <li key={c.id} className="list-row">
                <div className="row-main" style={{ gap: 6 }}>
                  <Link to={`/metas/${c.id}`} className="row-link">
                    <span className="row-title">{c.title}</span>
                  </Link>
                  <span className="row-meta">
                    <span>{HORIZON_LABEL[c.horizon]}</span>
                    <span>{formatRange(c.periodStart, c.periodEnd)}</span>
                    {c.status === 'completed' && <Tag tone="ok">Concluída</Tag>}
                    {c.status === 'archived' && <Tag>Arquivada</Tag>}
                  </span>
                  <GoalProgressView progress={computeGoalProgress(c, ctx)} compact />
                </div>
              </li>
            ))}
          </ul>
        )}
        {parent && (
          <p className="meta" style={{ marginTop: 12 }}>
            Esta meta faz parte de <Link to={`/metas/${parent.id}`}>{parent.title}</Link>.
          </p>
        )}
      </Section>

      {counted.length > 0 && (
        <Section title="Conclusões que contaram" id="goal-history">
          <ul className="list" role="list">
            {counted.map((c, i) => (
              <li key={i} className="list-row">
                <div className="row-main">
                  <span className="row-title">{c.title}</span>
                  <span className="row-meta">{formatDate(c.date)}</span>
                </div>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Dividir em passos com o Kai" id="goal-kai">
        {kai.state === 'off' ? (
          <p className="meta">
            Opcional. Ative o Kai em <Link to="/kai">Kai</Link> para pedir uma divisão desta meta em passos menores. Cada passo vira rascunho para você revisar.
          </p>
        ) : kai.state !== 'ready' ? (
          <Notice tone="warn" title="Kai indisponível agora">
            {kai.state === 'offline' ? 'Sem conexão.' : kai.state === 'checking' ? 'Verificando o Kai…' : kai.message}
          </Notice>
        ) : (
          <div className="panel stack">
            <div className="row-between">
              <p className="small muted grow">O Kai sugere passos; nada é criado até você revisar e salvar cada um.</p>
              <Button icon={<Compass size={18} aria-hidden="true" />} busy={breakdown.status === 'loading'} onClick={() => void askBreakdown()}>
                {breakdown.data ? 'Pedir de novo' : 'Sugerir passos'}
              </Button>
            </div>
            {breakdown.status === 'error' && (
              <Notice tone="warn" title="O Kai não respondeu" role="alert">
                {breakdown.message}
              </Notice>
            )}
            {breakdown.data && (
              <ul className="review-list" role="list">
                {breakdown.data.steps.map((s, i) =>
                  breakdown.dismissed.includes(i) ? null : (
                    <li key={i} className="review-item">
                      <div className="grow">
                        <p className="row-title">
                          {s.title} <Tag tone="accent">{s.kind === 'meta_filha' ? 'Meta filha' : s.kind === 'habito' ? 'Hábito' : 'Tarefa'}</Tag>
                        </p>
                        {s.detail && <p className="small muted">{s.detail}</p>}
                        <div className="btn-row" style={{ marginTop: 8 }}>
                          <Button size="sm" variant="primary" onClick={() => reviewStep(s)}>
                            Revisar e criar
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setBreakdown({ ...breakdown, dismissed: [...breakdown.dismissed, i] })}>
                            Descartar
                          </Button>
                        </div>
                      </div>
                    </li>
                  ),
                )}
              </ul>
            )}
            {breakdown.data && breakdown.data.notes.length > 0 && (
              <ul className="small muted">
                {breakdown.data.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Section>

      <ActionSheet
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        title={goal.title}
        actions={[
          { label: 'Marcar como concluída', icon: <Check size={18} aria-hidden="true" />, hidden: goal.status !== 'active', onSelect: () => void run(() => completeGoal(goal.id, { today }), 'Meta concluída.') },
          { label: 'Reabrir', icon: <RotateCcw size={18} aria-hidden="true" />, hidden: goal.status !== 'completed', onSelect: () => void run(() => reopenGoal(goal.id), 'Meta reaberta.') },
          { label: 'Arquivar', icon: <Archive size={18} aria-hidden="true" />, hidden: goal.status === 'archived', onSelect: () => void run(() => archiveGoal(goal.id), 'Meta arquivada.') },
          { label: 'Desarquivar', icon: <ArchiveRestore size={18} aria-hidden="true" />, hidden: goal.status !== 'archived', onSelect: () => void run(() => unarchiveGoal(goal.id), 'Meta desarquivada.') },
          { label: 'Excluir definitivamente', icon: <Trash size={18} aria-hidden="true" />, danger: true, onSelect: () => setConfirmDelete(true) },
        ]}
      />
      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Excluir meta?"
        danger
        confirmLabel="Excluir meta"
        message={<p className="small">A meta e suas atualizações manuais serão apagadas. Hábitos, tarefas e metas filhas continuam existindo, só perdem o vínculo. Não dá para desfazer.</p>}
        onConfirm={async () => {
          try {
            await deleteGoal(goal.id);
            toast.show('Meta excluída.');
            navigate('/metas');
          } catch (e) {
            toast.show(describeError(e), { tone: 'danger' });
          }
        }}
      />
    </div>
  );
}
