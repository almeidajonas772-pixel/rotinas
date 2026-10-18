import { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { useApp } from '../../app/context';
import { useToast } from '../../components/toast';
import { Button, LoadingState, Notice, PageHeader } from '../../components/ui';
import { useGoals, useHabit } from '../../db/hooks';
import { describeError, UserFacingError } from '../../db/errors';
import { createHabit, updateHabit, type HabitDraft } from '../../db/repo-habits';
import { habitStartDate } from '../../domain/schedule';
import type { Habit } from '../../domain/schemas';
import { draftFromHabit, emptyHabitDraft, validateHabitDraft } from './draft';
import { HabitEditor } from './HabitEditor';

export function HabitFormPage() {
  const { id } = useParams();
  const habit = useHabit(id);
  if (id && habit === undefined) {
    return (
      <div className="page">
        <LoadingState />
      </div>
    );
  }
  if (id && habit === null) {
    return (
      <div className="page">
        <PageHeader title="Hábito não encontrado" back={{ to: '/habitos', label: 'Hábitos' }} />
        <Notice tone="warn">Este hábito não existe mais. Ele pode ter sido excluído.</Notice>
      </div>
    );
  }
  return <HabitForm key={id ?? 'novo'} habit={habit ?? undefined} />;
}

function HabitForm({ habit }: { habit?: Habit }) {
  const { today } = useApp();
  const goals = useGoals();
  const navigate = useNavigate();
  const toast = useToast();
  const [params] = useSearchParams();
  const [draft, setDraft] = useState<HabitDraft>(() => {
    if (habit) return draftFromHabit(habit);
    // Pré-preenchimento vindo de uma sugestão revisável (ex.: passos do Kai para uma meta).
    const base = emptyHabitDraft(today);
    const days = (params.get('dias') ?? '')
      .split(',')
      .map(Number)
      .filter((d) => d >= 1 && d <= 7);
    return {
      ...base,
      title: (params.get('titulo') ?? '').slice(0, 80),
      description: (params.get('intencao') ?? '').slice(0, 500),
      goalId: params.get('meta') ?? undefined,
      schedule: days.length > 0 ? { kind: 'weekly', days } : base.schedule,
    };
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string>();
  const started = habit ? habitStartDate(habit) <= today : false;

  async function save() {
    const found = validateHabitDraft(draft, today, { startLocked: started });
    setErrors(found);
    if (Object.keys(found).length > 0) {
      setFormError('Revise os campos destacados.');
      return;
    }
    setSaving(true);
    setFormError(undefined);
    try {
      if (habit) {
        await updateHabit(habit.id, draft, { today });
        toast.show('Hábito atualizado.');
        navigate(`/habitos/${habit.id}`);
      } else {
        const created = await createHabit(draft, { today });
        toast.show('Hábito criado.');
        navigate(`/habitos/${created.id}`);
      }
    } catch (error) {
      if (error instanceof UserFacingError && error.fields) setErrors({ ...found, ...error.fields });
      setFormError(describeError(error));
      setSaving(false);
    }
  }

  const activeGoals = (goals ?? []).filter((g) => g.status === 'active');

  return (
    <div className="page">
      <PageHeader title={habit ? 'Editar hábito' : 'Novo hábito'} back={habit ? { to: `/habitos/${habit.id}`, label: habit.title } : { to: '/habitos', label: 'Hábitos' }} />
      <form
        className="panel stack-lg"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {habit && started && (
          <Notice tone="info">Mudanças na frequência valem a partir de hoje. Os dias anteriores continuam com a frequência antiga, para que suas métricas passadas não mudem.</Notice>
        )}
        <HabitEditor draft={draft} onChange={setDraft} errors={errors} today={today} goals={activeGoals} startLocked={started} />
        {formError && (
          <Notice tone="danger" role="alert">
            {formError}
          </Notice>
        )}
        <div className="btn-row end">
          <Button onClick={() => navigate(-1)}>Cancelar</Button>
          <Button type="submit" variant="primary" busy={saving}>
            {habit ? 'Salvar alterações' : 'Criar hábito'}
          </Button>
        </div>
      </form>
    </div>
  );
}
