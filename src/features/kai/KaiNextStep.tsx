import { CalendarPlus, Compass } from 'lucide-react';
import { useState } from 'react';
import { assessNextStep } from '../../../shared/kai';
import { useApp } from '../../app/context';
import { useToast } from '../../components/toast';
import { Button, Notice } from '../../components/ui';
import { newId, nowIso } from '../../db/db';
import { describeError } from '../../db/errors';
import { createAgendaItem } from '../../db/repo-agenda';
import { saveInsight, setInsightDecision } from '../../db/repo-misc';
import { buildKaiContext } from '../../domain/kai-context';
import { resolveEvidence } from '../../domain/kai-evidence';
import { runKai, useKaiSnapshot } from './kai-client';
import { NextStepResult, type StoredNextStep } from './kai-render';

export function KaiNextStep({ ready }: { ready: boolean }) {
  const { prefs, today, timezone } = useApp();
  const snapshot = useKaiSnapshot();
  const toast = useToast();
  const [state, setState] = useState<{ status: 'idle' | 'loading' | 'insufficient' | 'error' | 'done'; reasons?: string[]; message?: string; stored?: StoredNextStep; insightId?: string; decided?: boolean }>({ status: 'idle' });

  async function ask() {
    if (!snapshot) return;
    let built;
    try {
      built = buildKaiContext(snapshot);
    } catch (e) {
      setState({ status: 'error', message: e instanceof Error ? e.message : 'Falha ao montar o contexto.' });
      return;
    }
    const id = newId();
    const base = { id, kind: 'next_step' as const, periodStart: built.manifest.period?.start, periodEnd: built.manifest.period?.end, dataUsed: built.manifest, refMap: built.refMap, origin: 'kai' as const, createdAt: nowIso() };
    const sufficiency = assessNextStep(built.context);
    if (!sufficiency.sufficient) {
      await saveInsight({ ...base, status: 'insufficient_data' });
      setState({ status: 'insufficient', reasons: sufficiency.reasons });
      return;
    }
    setState({ status: 'loading' });
    const res = await runKai('next-step', { context: built.context }, prefs);
    if (!res.ok) {
      await saveInsight({ ...base, status: 'error', errorCode: res.code.slice(0, 60) });
      setState({ status: 'error', message: res.message });
      return;
    }
    const refs = [...res.data.step.refs];
    const evidence = Object.fromEntries(resolveEvidence(refs, built.context).items.map((i) => [i.ref, { label: i.label, detail: i.detail }]));
    const stored: StoredNextStep = { output: res.data, evidence };
    await saveInsight({ ...base, status: 'ok', response: stored, decision: 'pending', provider: 'anthropic', model: res.model });
    setState({ status: 'done', stored, insightId: id });
  }

  async function addAsTask() {
    if (!state.stored || !state.insightId) return;
    try {
      await createAgendaItem(
        { kind: 'task', title: state.stored.output.step.title.slice(0, 120), notes: state.stored.output.step.detail.slice(0, 1000), date: today, allDay: true, origin: 'kai', xp: 5 },
        { timezone },
      );
      await setInsightDecision(state.insightId, 'accepted');
      setState({ ...state, decided: true });
      toast.show('Tarefa criada para hoje na Agenda.');
    } catch (e) {
      toast.show(describeError(e), { tone: 'danger' });
    }
  }

  return (
    <div className="stack">
      <p className="small muted">O Kai olha os últimos 14 dias e sugere um passo pequeno e concreto. Você decide se vira tarefa.</p>
      <div>
        <Button variant="primary" icon={<Compass size={18} aria-hidden="true" />} disabled={!ready} busy={state.status === 'loading'} onClick={() => void ask()}>
          Sugerir um próximo passo
        </Button>
      </div>
      {state.status === 'insufficient' && (
        <Notice tone="info" title="Ainda não há registros suficientes">
          <ul>
            {state.reasons?.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </Notice>
      )}
      {state.status === 'error' && (
        <Notice tone="warn" title="Sem resposta do Kai" role="alert">
          {state.message} Nenhuma sugestão foi gerada.
        </Notice>
      )}
      {state.status === 'done' && state.stored && (
        <div className="panel stack">
          <NextStepResult stored={state.stored} />
          {!state.decided ? (
            <div className="btn-row">
              <Button variant="primary" icon={<CalendarPlus size={18} aria-hidden="true" />} onClick={() => void addAsTask()}>
                Adicionar como tarefa de hoje
              </Button>
              <Button
                variant="ghost"
                onClick={async () => {
                  if (state.insightId) await setInsightDecision(state.insightId, 'ignored');
                  setState({ ...state, decided: true });
                }}
              >
                Ignorar
              </Button>
            </div>
          ) : (
            <p className="meta">Decisão registrada no histórico.</p>
          )}
        </div>
      )}
    </div>
  );
}
