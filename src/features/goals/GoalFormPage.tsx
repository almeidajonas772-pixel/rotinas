import { useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { useApp } from '../../app/context';
import { CheckField, SelectField, Segmented, TextArea, TextField } from '../../components/form';
import { useToast } from '../../components/toast';
import { Button, LoadingState, Notice, PageHeader } from '../../components/ui';
import { useGoals } from '../../db/hooks';
import { describeError, UserFacingError } from '../../db/errors';
import { createGoal, updateGoal, type GoalDraft } from '../../db/repo-goals';
import { isCivilDate } from '../../domain/civil';
import { formatRange } from '../../domain/format';
import { HORIZON_LABEL, HORIZON_ORDER, parentProblem, periodFor } from '../../domain/goals';
import type { Goal, GoalHorizon, GoalProgressRule } from '../../domain/schemas';

type RuleKind = GoalProgressRule['kind'];

const RULE_HELP: Record<RuleKind, string> = {
  manual_completion: 'Sem número: você marca a meta como concluída quando cumprir.',
  manual_value: 'Você informa o valor atual quando quiser (ex.: 3 de 12 livros). Fica identificado como atualização manual.',
  linked_completions: 'Soma conclusões reais de hábitos e tarefas vinculados a esta meta dentro do período.',
  child_goals: 'Progresso = metas filhas concluídas ÷ metas filhas vinculadas.',
};

export function GoalFormPage() {
  const { id } = useParams();
  const goals = useGoals();
  if (!goals) {
    return (
      <div className="page">
        <LoadingState />
      </div>
    );
  }
  const goal = id ? goals.find((g) => g.id === id) : undefined;
  if (id && !goal) {
    return (
      <div className="page">
        <PageHeader title="Meta não encontrada" back={{ to: '/metas', label: 'Metas' }} />
        <Notice tone="warn">Esta meta não existe mais.</Notice>
      </div>
    );
  }
  return <GoalForm key={id ?? 'nova'} goal={goal} goals={goals} />;
}

function GoalForm({ goal, goals }: { goal?: Goal; goals: Goal[] }) {
  const { today, weekStartsOn } = useApp();
  const navigate = useNavigate();
  const toast = useToast();
  const [params] = useSearchParams();

  const initial = useMemo<GoalDraft>(() => {
    if (goal) {
      return {
        title: goal.title,
        description: goal.description ?? '',
        horizon: goal.horizon,
        periodStart: goal.periodStart,
        periodEnd: goal.periodEnd,
        progressRule: goal.progressRule,
        parentId: goal.parentId,
      };
    }
    const parent = goals.find((g) => g.id === params.get('pai'));
    const requested = params.get('horizonte') as GoalHorizon | null;
    const horizon: GoalHorizon = requested && HORIZON_ORDER.includes(requested) ? requested : parent ? HORIZON_ORDER[Math.min(3, HORIZON_ORDER.indexOf(parent.horizon) + 1)] : 'month';
    const anchor = parent && parent.periodStart > today ? parent.periodStart : today;
    const p = periodFor(horizon, anchor, weekStartsOn);
    return {
      title: (params.get('titulo') ?? '').slice(0, 120),
      description: (params.get('descricao') ?? '').slice(0, 1000),
      horizon,
      periodStart: p.start,
      periodEnd: p.end,
      progressRule: { kind: 'manual_completion' },
      parentId: parent?.id,
    };
  }, [goal, goals, params, today, weekStartsOn]);

  const [draft, setDraft] = useState<GoalDraft>(initial);
  const [target, setTarget] = useState(() => ('target' in initial.progressRule ? String(initial.progressRule.target) : '10'));
  const [unit, setUnit] = useState(() => ('unit' in initial.progressRule ? initial.progressRule.unit : 'conclusões'));
  const [includeDescendants, setIncludeDescendants] = useState(() => (initial.progressRule.kind === 'linked_completions' ? initial.progressRule.includeDescendants : false));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string>();
  const [saving, setSaving] = useState(false);

  const candidateParents = goals.filter(
    (g) =>
      g.id !== goal?.id &&
      g.status !== 'archived' &&
      !parentProblem(g, { id: goal?.id ?? '__nova__', horizon: draft.horizon, periodStart: draft.periodStart, periodEnd: draft.periodEnd }, goals),
  );

  function changeHorizon(h: GoalHorizon) {
    const p = periodFor(h, draft.periodStart > today ? draft.periodStart : today, weekStartsOn);
    setDraft({ ...draft, horizon: h, periodStart: p.start, periodEnd: p.end });
  }

  function buildRule(): GoalProgressRule | null {
    const kind = draft.progressRule.kind;
    if (kind === 'manual_completion' || kind === 'child_goals') return { kind };
    const t = Number(target);
    if (!Number.isFinite(t) || t <= 0) return null;
    if (kind === 'manual_value') return { kind, target: t, unit: unit.trim() };
    return { kind, target: Math.round(t), unit: unit.trim(), includeDescendants };
  }

  async function save() {
    const found: Record<string, string> = {};
    if (!draft.title.trim()) found.title = 'Dê um título à meta';
    if (!isCivilDate(draft.periodStart)) found.periodStart = 'Informe a data de início';
    if (!isCivilDate(draft.periodEnd)) found.periodEnd = 'Informe a data de fim';
    else if (draft.periodEnd < draft.periodStart) found.periodEnd = 'O fim precisa ser depois do início';
    const rule = buildRule();
    if (!rule) found.target = 'Informe um alvo maior que zero';
    if (rule && 'unit' in rule && !rule.unit) found.unit = 'Informe a unidade (ex.: sessões, livros, km)';
    setErrors(found);
    if (Object.keys(found).length > 0 || !rule) {
      setFormError('Revise os campos destacados.');
      return;
    }
    setSaving(true);
    setFormError(undefined);
    try {
      const payload = { ...draft, progressRule: rule };
      if (goal) {
        await updateGoal(goal.id, payload);
        toast.show('Meta atualizada.');
        navigate(`/metas/${goal.id}`);
      } else {
        const created = await createGoal(payload);
        toast.show('Meta criada.');
        navigate(`/metas/${created.id}`);
      }
    } catch (error) {
      if (error instanceof UserFacingError && error.fields) setErrors({ ...found, ...error.fields });
      setFormError(describeError(error));
      setSaving(false);
    }
  }

  const ruleKind = draft.progressRule.kind;

  return (
    <div className="page">
      <PageHeader title={goal ? 'Editar meta' : 'Nova meta'} back={goal ? { to: `/metas/${goal.id}`, label: goal.title } : { to: '/metas', label: 'Metas' }} />
      <form
        className="panel stack-lg"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div>
          <TextField label="Título" value={draft.title} onChange={(title) => setDraft({ ...draft, title })} error={errors.title} maxLength={120} required placeholder="Ex.: Terminar o curso de inglês" />
          <TextArea label="Descrição" optional value={draft.description ?? ''} onChange={(description) => setDraft({ ...draft, description })} maxLength={1000} rows={2} />
        </div>

        <fieldset>
          <legend>Horizonte e período</legend>
          <Segmented label="Horizonte" hideLabel value={draft.horizon} onChange={changeHorizon} options={HORIZON_ORDER.map((h) => ({ value: h, label: HORIZON_LABEL[h] }))} />
          <div className="field-row" style={{ marginTop: 12 }}>
            <TextField label="Início" type="date" value={draft.periodStart} onChange={(periodStart) => setDraft({ ...draft, periodStart })} error={errors.periodStart} />
            <TextField label="Fim" type="date" value={draft.periodEnd} min={draft.periodStart} onChange={(periodEnd) => setDraft({ ...draft, periodEnd })} error={errors.periodEnd} />
          </div>
          <p className="field-hint" style={{ marginTop: 6 }}>
            O período padrão segue o horizonte ({formatRange(draft.periodStart, draft.periodEnd)}); ajuste se precisar.
          </p>
        </fieldset>

        <fieldset>
          <legend>Como medir o progresso</legend>
          <Segmented
            label="Regra de progresso"
            hideLabel
            value={ruleKind}
            onChange={(kind) =>
              setDraft({
                ...draft,
                progressRule:
                  kind === 'manual_completion' || kind === 'child_goals'
                    ? { kind }
                    : kind === 'manual_value'
                      ? { kind, target: Number(target) || 1, unit }
                      : { kind, target: Math.max(1, Math.round(Number(target) || 1)), unit, includeDescendants },
              })
            }
            options={[
              { value: 'manual_completion', label: 'Conclusão manual' },
              { value: 'manual_value', label: 'Valor manual' },
              { value: 'linked_completions', label: 'Itens vinculados' },
              { value: 'child_goals', label: 'Metas filhas' },
            ]}
          />
          <p className="field-hint" style={{ marginTop: 6 }}>
            {RULE_HELP[ruleKind]}
          </p>
          {(ruleKind === 'manual_value' || ruleKind === 'linked_completions') && (
            <div className="field-row" style={{ marginTop: 12 }}>
              <TextField label="Alvo" type="number" inputMode="decimal" min={1} value={target} onChange={setTarget} error={errors.target} />
              <TextField label="Unidade" value={unit} onChange={setUnit} error={errors.unit} maxLength={30} placeholder="sessões, livros, km…" />
            </div>
          )}
          {ruleKind === 'linked_completions' && (
            <CheckField
              label="Incluir itens das metas filhas"
              description="Soma também os hábitos e tarefas vinculados às metas filhas desta meta."
              checked={includeDescendants}
              onChange={setIncludeDescendants}
            />
          )}
        </fieldset>

        <SelectField
          label="Faz parte de outra meta?"
          optional
          hint={candidateParents.length === 0 ? 'Nenhuma meta compatível: a meta pai precisa ter horizonte mais longo e período que se cruze com este.' : 'Opcional. Só aparecem metas de horizonte mais longo com período compatível.'}
          value={draft.parentId ?? ''}
          onChange={(parentId) => setDraft({ ...draft, parentId: parentId || undefined })}
          error={errors.parentId}
          options={[{ value: '', label: 'Não' }, ...candidateParents.map((g) => ({ value: g.id, label: `${g.title} (${HORIZON_LABEL[g.horizon]}, ${formatRange(g.periodStart, g.periodEnd)})` }))]}
        />

        {formError && (
          <Notice tone="danger" role="alert">
            {formError}
          </Notice>
        )}
        <div className="btn-row end">
          <Button onClick={() => navigate(-1)}>Cancelar</Button>
          <Button type="submit" variant="primary" busy={saving}>
            {goal ? 'Salvar alterações' : 'Criar meta'}
          </Button>
        </div>
      </form>
    </div>
  );
}
