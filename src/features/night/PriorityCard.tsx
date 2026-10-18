import { Check, Mic, Star, Trash, X } from 'lucide-react';
import { useState } from 'react';
import { TextField } from '../../components/form';
import { useToast } from '../../components/toast';
import { Button, Tag } from '../../components/ui';
import { describeError } from '../../db/errors';
import { clearPriority, setPriority, setPriorityOutcome } from '../../db/repo-night';
import type { CivilDate } from '../../domain/civil';
import type { DayPlan } from '../../domain/schemas';

const SOURCE_LABEL: Record<NonNullable<DayPlan['prioritySource']>, string> = { manual: 'escrita por você', voice: 'ditada por você', kai: 'sugerida pelo Kai e aceita por você' };

/**
 * Prioridade nº 1 de amanhã (e o fechamento da de hoje). A decisão é sempre da pessoa:
 * o Kai só sugere; nada é salvo sem um toque.
 */
export function PriorityCard({
  date,
  tomorrow,
  todayPlan,
  tomorrowPlan,
  draft,
  onDraftConsumed,
  canDictate,
  onDictate,
  dictating,
}: {
  date: CivilDate;
  tomorrow: CivilDate;
  todayPlan: DayPlan | null;
  tomorrowPlan: DayPlan | null;
  /** Texto vindo da voz ou do Kai, para a pessoa confirmar. */
  draft: { text: string; source: NonNullable<DayPlan['prioritySource']> } | null;
  onDraftConsumed: () => void;
  canDictate: boolean;
  onDictate: () => void;
  dictating: boolean;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const showForm = !tomorrowPlan?.priority || editing || draft !== null;
  const value = draft?.text ?? text;

  async function save(source: NonNullable<DayPlan['prioritySource']>) {
    if (!value.trim()) return;
    setBusy(true);
    try {
      await setPriority(tomorrow, value, source);
      toast.show('Prioridade de amanhã salva. Ela aparece na tela Hoje.');
      setText('');
      setEditing(false);
      onDraftConsumed();
    } catch (e) {
      toast.show(describeError(e), { tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  async function outcome(o: DayPlan['outcome']) {
    try {
      await setPriorityOutcome(date, o);
    } catch (e) {
      toast.show(describeError(e), { tone: 'danger' });
    }
  }

  return (
    <div className="panel stack">
      {todayPlan?.priority && (
        <div className="night-priority-today">
          <p className="field-label">Prioridade de hoje</p>
          <p className="row-title">{todayPlan.priority}</p>
          {todayPlan.outcome ? (
            <p className="small">
              {todayPlan.outcome === 'done' ? <Tag tone="ok">Cumprida</Tag> : <Tag>Não deu hoje</Tag>}{' '}
              <button type="button" className="link-btn" onClick={() => void outcome(undefined)}>
                Mudar resposta
              </button>
            </p>
          ) : (
            <div className="btn-row">
              <Button size="sm" icon={<Check size={16} aria-hidden="true" />} onClick={() => void outcome('done')}>
                Cumpri
              </Button>
              <Button size="sm" variant="ghost" icon={<X size={16} aria-hidden="true" />} onClick={() => void outcome('not_done')}>
                Não deu
              </Button>
            </div>
          )}
        </div>
      )}

      {tomorrowPlan?.priority && !showForm && (
        <div>
          <p className="field-label">Amanhã</p>
          <p className="night-priority-text">
            <Star size={18} aria-hidden="true" /> {tomorrowPlan.priority}
          </p>
          <p className="meta">{tomorrowPlan.prioritySource ? `Prioridade ${SOURCE_LABEL[tomorrowPlan.prioritySource]}.` : ''}</p>
          <div className="btn-row" style={{ marginTop: 8 }}>
            <Button
              size="sm"
              onClick={() => {
                setText(tomorrowPlan.priority ?? '');
                setEditing(true);
              }}
            >
              Trocar
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={<Trash size={16} aria-hidden="true" />}
              onClick={() =>
                void clearPriority(tomorrow)
                  .then(() => toast.show('Prioridade de amanhã removida.'))
                  .catch((e) => toast.show(describeError(e), { tone: 'danger' }))
              }
            >
              Remover
            </Button>
          </div>
        </div>
      )}

      {showForm && (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void save(draft?.source ?? 'manual');
          }}
        >
          <TextField
            label="Prioridade de amanhã"
            value={value}
            maxLength={200}
            onChange={(v) => {
              if (draft) onDraftConsumed();
              setText(v);
            }}
            placeholder="Ex.: Revisar o capítulo 3 antes da aula"
            hint={draft ? (draft.source === 'kai' ? 'Sugestão do Kai: revise e salve se fizer sentido.' : 'Ditado por voz: confira o texto e salve.') : 'Uma coisa só, concreta. Ela aparece amanhã na tela Hoje.'}
          />
          <div className="btn-row">
            <Button type="submit" variant="primary" disabled={!value.trim()} busy={busy}>
              Salvar prioridade
            </Button>
            {canDictate && (
              <Button icon={<Mic size={18} aria-hidden="true" />} onClick={onDictate} aria-pressed={dictating}>
                {dictating ? 'Ouvindo…' : 'Ditar'}
              </Button>
            )}
            {(editing || draft) && tomorrowPlan?.priority && (
              <Button
                variant="ghost"
                onClick={() => {
                  setEditing(false);
                  onDraftConsumed();
                }}
              >
                Cancelar
              </Button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
