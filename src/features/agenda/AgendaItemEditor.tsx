import { CheckField, SelectField, Segmented, SwitchRow, TextArea, TextField, WeekdayPicker } from '../../components/form';
import { isoWeekday } from '../../domain/civil';
import { HORIZON_LABEL } from '../../domain/goals';
import type { Goal, Habit } from '../../domain/schemas';
import type { EditorDraft } from './editor-draft';

export function AgendaItemEditor({
  draft,
  onChange,
  errors,
  habits,
  goals,
  occurrenceOnly,
}: {
  draft: EditorDraft;
  onChange: (d: EditorDraft) => void;
  errors: Record<string, string>;
  habits: readonly Habit[];
  goals: readonly Goal[];
  /** Editando "somente esta ocorrência": só título, data e horário. */
  occurrenceOnly?: boolean;
}) {
  const set = (p: Partial<EditorDraft>) => onChange({ ...draft, ...p });
  const needsDate = draft.kind !== 'task' || draft.hasDate;
  return (
    <div className="stack-lg">
      {!occurrenceOnly && (
        <Segmented
          label="Tipo"
          value={draft.kind}
          onChange={(kind) => set({ kind, allDay: kind === 'habit' ? false : draft.allDay, hasDate: kind === 'task' ? draft.hasDate : true, xp: kind === 'task' ? (draft.xp || 5) : 0 })}
          options={[
            { value: 'task', label: 'Tarefa' },
            { value: 'event', label: 'Evento' },
            { value: 'habit', label: 'Bloco de hábito' },
          ]}
        />
      )}
      <div>
        {draft.kind === 'habit' && !occurrenceOnly ? (
          <SelectField
            label="Hábito"
            value={draft.habitId}
            onChange={(habitId) => set({ habitId, title: habits.find((h) => h.id === habitId)?.title ?? draft.title })}
            error={errors.habitId}
            hint="Um bloco reserva tempo para o hábito. Concluir o bloco conclui o hábito daquele dia."
            options={[{ value: '', label: 'Escolha um hábito' }, ...habits.filter((h) => h.status !== 'archived').map((h) => ({ value: h.id, label: h.title }))]}
          />
        ) : (
          <TextField label="Título" value={draft.title} onChange={(title) => set({ title })} error={errors.title} maxLength={120} required autoComplete="off" />
        )}
      </div>

      <fieldset>
        <legend>Quando</legend>
        {draft.kind === 'task' && !occurrenceOnly && (
          <CheckField label="Definir data" description="Sem data, a tarefa fica na lista “Sem data”." checked={draft.hasDate} onChange={(hasDate) => set({ hasDate })} />
        )}
        {needsDate && (
          <>
            <div className="field-row">
              <TextField label="Data" type="date" value={draft.date} onChange={(date) => set({ date })} error={errors.date} />
            </div>
            {draft.kind !== 'habit' && !occurrenceOnly && (
              <SwitchRow label="Dia inteiro" checked={draft.allDay} onChange={(allDay) => set({ allDay })} />
            )}
            {!draft.allDay && (
              <div className="field-row">
                <TextField label="Início" type="time" value={draft.startTime} onChange={(startTime) => set({ startTime })} error={errors.startTime} />
                <TextField label="Fim" optional type="time" value={draft.endTime} onChange={(endTime) => set({ endTime })} error={errors.endTime} />
              </div>
            )}
          </>
        )}
      </fieldset>

      {needsDate && !occurrenceOnly && (
        <fieldset>
          <legend>Repetição</legend>
          <Segmented
            label="Repetição"
            hideLabel
            value={draft.repeat}
            onChange={(repeat) => set({ repeat, byWeekday: draft.byWeekday.length ? draft.byWeekday : [isoWeekday(draft.date)] })}
            options={[
              { value: 'none', label: 'Não se repete' },
              { value: 'daily', label: 'Diária' },
              { value: 'weekly', label: 'Semanal' },
            ]}
          />
          {draft.repeat !== 'none' && (
            <div className="stack" style={{ marginTop: 12 }}>
              <div className="field-row">
                <TextField
                  label={draft.repeat === 'daily' ? 'A cada quantos dias' : 'A cada quantas semanas'}
                  type="number"
                  min={1}
                  max={52}
                  value={String(draft.interval)}
                  onChange={(v) => set({ interval: Number(v) || 1 })}
                  error={errors.interval}
                />
              </div>
              {draft.repeat === 'weekly' && <WeekdayPicker label="Dias" value={draft.byWeekday} onChange={(byWeekday) => set({ byWeekday })} error={errors.byWeekday} />}
              <Segmented
                label="Termina"
                value={draft.ends}
                onChange={(ends) => set({ ends })}
                options={[
                  { value: 'never', label: 'Nunca' },
                  { value: 'until', label: 'Em uma data' },
                  { value: 'count', label: 'Após N vezes' },
                ]}
              />
              {draft.ends === 'until' && <TextField label="Última data" type="date" value={draft.until} min={draft.date} onChange={(until) => set({ until })} error={errors.until} />}
              {draft.ends === 'count' && <TextField label="Número de vezes" type="number" min={1} max={1000} value={String(draft.count)} onChange={(v) => set({ count: Number(v) || 1 })} error={errors.count} />}
            </div>
          )}
        </fieldset>
      )}

      {!occurrenceOnly && (
        <div>
          <SelectField
            label="Meta vinculada"
            optional
            value={draft.goalId}
            onChange={(goalId) => set({ goalId })}
            options={[{ value: '', label: 'Nenhuma' }, ...goals.filter((g) => g.status !== 'archived').map((g) => ({ value: g.id, label: `${g.title} (${HORIZON_LABEL[g.horizon]})` }))]}
          />
          {draft.kind !== 'habit' && <TextField label="Categoria" optional value={draft.category} onChange={(category) => set({ category })} maxLength={40} placeholder="Ex.: Estudos" />}
          {draft.kind === 'task' && (
            <TextField label="XP ao concluir" type="number" min={0} max={100} value={String(draft.xp)} onChange={(v) => set({ xp: Number(v) || 0 })} error={errors.xp} hint="Somado só quando você marca a tarefa como concluída." />
          )}
          <TextArea label="Notas" optional value={draft.notes} onChange={(notes) => set({ notes })} maxLength={1000} rows={2} />
        </div>
      )}
    </div>
  );
}
