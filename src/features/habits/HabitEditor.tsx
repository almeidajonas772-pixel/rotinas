import { SelectField, Segmented, SwitchRow, TextArea, TextField, WeekdayPicker } from '../../components/form';
import { HABIT_CATEGORIES } from '../../db/defaults';
import type { HabitDraft } from '../../db/repo-habits';
import type { CivilDate } from '../../domain/civil';
import type { Goal } from '../../domain/schemas';
import { HORIZON_LABEL } from '../../domain/goals';

/** Campos do hábito, usados no onboarding, na criação e na edição. */
export function HabitEditor({
  draft,
  onChange,
  errors,
  today,
  goals,
  startLocked,
  compact,
}: {
  draft: HabitDraft;
  onChange: (next: HabitDraft) => void;
  errors: Record<string, string>;
  today: CivilDate;
  goals?: readonly Goal[];
  startLocked?: boolean;
  compact?: boolean;
}) {
  const set = (patch: Partial<HabitDraft>) => onChange({ ...draft, ...patch });
  const categories = HABIT_CATEGORIES.includes(draft.category as (typeof HABIT_CATEGORIES)[number])
    ? HABIT_CATEGORIES
    : [...HABIT_CATEGORIES, draft.category];

  return (
    <div className="stack-lg">
      <div>
        <TextField
          label="Nome do hábito"
          value={draft.title}
          onChange={(title) => set({ title })}
          error={errors.title}
          maxLength={80}
          autoComplete="off"
          placeholder="Ex.: Ler 10 páginas"
          required
        />
        {!compact && (
          <TextArea
            label="Intenção"
            optional
            hint="Por que este hábito importa para você? Ajuda a lembrar o motivo nos dias difíceis."
            value={draft.description ?? ''}
            onChange={(description) => set({ description })}
            error={errors.description}
            maxLength={500}
            rows={2}
          />
        )}
        <SelectField
          label="Categoria"
          value={draft.category}
          onChange={(category) => set({ category })}
          options={categories.map((c) => ({ value: c, label: c }))}
        />
      </div>

      <fieldset>
        <legend>Frequência</legend>
        <Segmented
          label="Frequência"
          hideLabel
          value={draft.schedule.kind}
          options={[
            { value: 'daily', label: 'Todos os dias' },
            { value: 'weekly', label: 'Dias da semana' },
          ]}
          onChange={(kind) => set({ schedule: kind === 'daily' ? { kind: 'daily' } : { kind: 'weekly', days: draft.schedule.kind === 'weekly' ? draft.schedule.days : [1, 3, 5] } })}
        />
        {draft.schedule.kind === 'weekly' && (
          <div style={{ marginTop: 12 }}>
            <WeekdayPicker label="Dias previstos" value={draft.schedule.days} onChange={(days) => set({ schedule: { kind: 'weekly', days } })} error={errors.days} />
          </div>
        )}
        <p className="field-hint" style={{ marginTop: 8 }}>
          Dias sem ocorrência prevista não contam como falha e não quebram sua sequência.
        </p>
      </fieldset>

      <fieldset>
        <legend>Horário preferido</legend>
        <Segmented
          label="Horário preferido"
          hideLabel
          value={draft.timing.kind}
          options={[
            { value: 'anytime', label: 'Qualquer horário' },
            { value: 'time', label: 'Horário fixo' },
            { value: 'window', label: 'Janela' },
          ]}
          onChange={(kind) =>
            set({
              timing: kind === 'anytime' ? { kind: 'anytime' } : kind === 'time' ? { kind: 'time', time: '07:00' } : { kind: 'window', start: '18:00', end: '20:00' },
            })
          }
        />
        {draft.timing.kind === 'time' && (
          <div className="field-row" style={{ marginTop: 12 }}>
            <TextField label="Horário" type="time" value={draft.timing.time} onChange={(time) => set({ timing: { kind: 'time', time } })} error={errors.time} />
          </div>
        )}
        {draft.timing.kind === 'window' && (
          <div className="field-row" style={{ marginTop: 12 }}>
            <TextField
              label="Início da janela"
              type="time"
              value={draft.timing.start}
              onChange={(start) => set({ timing: { kind: 'window', start, end: draft.timing.kind === 'window' ? draft.timing.end : '20:00' } })}
            />
            <TextField
              label="Fim da janela"
              type="time"
              value={draft.timing.end}
              onChange={(end) => set({ timing: { kind: 'window', start: draft.timing.kind === 'window' ? draft.timing.start : '18:00', end } })}
              error={errors.window}
            />
          </div>
        )}
        <div className="field-row" style={{ marginTop: 12 }}>
          <TextField
            label="Duração estimada (min)"
            optional
            type="number"
            inputMode="numeric"
            min={1}
            max={600}
            value={draft.durationMinutes ? String(draft.durationMinutes) : ''}
            onChange={(v) => set({ durationMinutes: v === '' ? undefined : Number(v) })}
            error={errors.duration}
          />
        </div>
      </fieldset>

      <div>
        <TextField
          label="Primeiro passo pequeno"
          optional
          hint="Algo que leve menos de 2 minutos e torne o começo fácil."
          value={draft.firstStep ?? ''}
          onChange={(firstStep) => set({ firstStep })}
          error={errors.firstStep}
          maxLength={200}
          placeholder="Ex.: Abrir o livro na página marcada"
        />
        <TextField
          label="XP por conclusão"
          type="number"
          inputMode="numeric"
          min={0}
          max={100}
          hint="O XP só é somado quando você marca a conclusão. Mudar este valor depois não altera conclusões já registradas."
          value={String(draft.xp)}
          onChange={(v) => set({ xp: v === '' ? 0 : Number(v) })}
          error={errors.xp}
        />
        {goals && goals.length > 0 && (
          <SelectField
            label="Meta vinculada"
            optional
            hint="Vincular não muda o progresso da meta sozinho: só conta se a meta usar a regra “conclusões de itens vinculados”."
            value={draft.goalId ?? ''}
            onChange={(goalId) => set({ goalId: goalId || undefined })}
            options={[{ value: '', label: 'Nenhuma' }, ...goals.map((g) => ({ value: g.id, label: `${g.title} (${HORIZON_LABEL[g.horizon]})` }))]}
          />
        )}
        {!startLocked && (
          <TextField
            label="Começa em"
            type="date"
            min={today}
            value={draft.startDate}
            onChange={(startDate) => set({ startDate })}
            error={errors.startDate}
            hint="Ocorrências só passam a existir a partir desta data."
          />
        )}
      </div>

      <div>
        <SwitchRow
          label="Lembrete"
          description="Notificação local deste aparelho, só se as notificações estiverem ativadas em Configurações."
          checked={draft.reminder.enabled}
          onChange={(enabled) =>
            set({
              reminder: enabled
                ? { enabled: true, time: draft.reminder.time ?? (draft.timing.kind === 'time' ? draft.timing.time : draft.timing.kind === 'window' ? draft.timing.start : '08:00') }
                : { enabled: false },
            })
          }
        />
        {draft.reminder.enabled && (
          <div className="field-row">
            <TextField label="Horário do lembrete" type="time" value={draft.reminder.time ?? ''} onChange={(time) => set({ reminder: { enabled: true, time } })} error={errors.reminder} />
          </div>
        )}
      </div>
    </div>
  );
}
