import { Compass } from 'lucide-react';
import { useMemo, useState } from 'react';
import { assessWeeklyReview } from '../../../shared/kai';
import { useApp } from '../../app/context';
import { Segmented } from '../../components/form';
import { Button, Notice } from '../../components/ui';
import { newId, nowIso } from '../../db/db';
import { saveInsight, setInsightDecision } from '../../db/repo-misc';
import { addDays, diffDays, isCivilDate, startOfWeek, type CivilDate } from '../../domain/civil';
import { formatRange } from '../../domain/format';
import { buildKaiContext } from '../../domain/kai-context';
import { resolveEvidence, verifyObservations } from '../../domain/kai-evidence';
import { runKai, useKaiSnapshot } from './kai-client';
import { ReviewResult, type StoredReview } from './kai-render';

type Choice = 'last7' | 'lastWeek' | 'custom';

function parseRange(value: string | null): { start: CivilDate; end: CivilDate } | null {
  if (!value) return null;
  const [start, end] = value.split(',');
  if (!isCivilDate(start) || !isCivilDate(end) || end < start || diffDays(end, start) > 62) return null;
  return { start, end };
}

export function KaiWeeklyReview({ ready, initialRange }: { ready: boolean; initialRange: string | null }) {
  const { prefs, today, weekStartsOn } = useApp();
  const snapshot = useKaiSnapshot();
  const fromParam = useMemo(() => parseRange(initialRange), [initialRange]);
  const [choice, setChoice] = useState<Choice>(fromParam ? 'custom' : 'last7');
  const [state, setState] = useState<{ status: 'idle' | 'loading' | 'insufficient' | 'error' | 'done'; reasons?: string[]; message?: string; stored?: StoredReview; refMap?: Record<string, string>; insightId?: string }>({ status: 'idle' });

  const period = useMemo(() => {
    if (choice === 'custom' && fromParam) return { start: fromParam.start, end: fromParam.end > today ? today : fromParam.end };
    if (choice === 'lastWeek') {
      const thisWeek = startOfWeek(today, weekStartsOn);
      return { start: addDays(thisWeek, -7), end: addDays(thisWeek, -1) };
    }
    return { start: addDays(today, -6), end: today };
  }, [choice, fromParam, today, weekStartsOn]);

  async function run() {
    if (!snapshot) return;
    let built;
    try {
      built = buildKaiContext(snapshot, { period });
    } catch (e) {
      setState({ status: 'error', message: e instanceof Error ? e.message : 'Falha ao montar o contexto.' });
      return;
    }
    const id = newId();
    const base = { id, kind: 'weekly_review' as const, periodStart: period.start, periodEnd: period.end, dataUsed: built.manifest, refMap: built.refMap, origin: 'kai' as const, createdAt: nowIso() };
    const sufficiency = assessWeeklyReview(built.context);
    if (!sufficiency.sufficient) {
      await saveInsight({ ...base, status: 'insufficient_data' });
      setState({ status: 'insufficient', reasons: sufficiency.reasons });
      return;
    }
    setState({ status: 'loading' });
    const res = await runKai('weekly-review', { context: built.context }, prefs);
    if (!res.ok) {
      await saveInsight({ ...base, status: 'error', errorCode: res.code.slice(0, 60) });
      setState({ status: 'error', message: res.message });
      return;
    }
    const { kept } = verifyObservations(res.data.observations, built.context);
    const keptIndexes = kept.map((k) => res.data.observations.indexOf(k.observation));
    const refs = [...res.data.observations.flatMap((o) => o.evidenceRefs), ...res.data.suggestions.flatMap((s) => s.refs)];
    const evidence = Object.fromEntries(resolveEvidence(refs, built.context).items.map((i) => [i.ref, { label: i.label, detail: i.detail }]));
    const stored: StoredReview = { output: res.data, evidence, discarded: res.data.observations.length - kept.length, keptIndexes };
    await saveInsight({ ...base, status: 'ok', response: stored, decision: 'pending', provider: 'anthropic', model: res.model });
    setState({ status: 'done', stored, refMap: built.refMap, insightId: id });
  }

  return (
    <div className="stack">
      <p className="small muted">Uma análise estruturada de um período explícito: observações com evidências, limitações e sugestões opcionais. Abaixo do mínimo de dados, o Kai não é chamado.</p>
      <Segmented
        label="Período analisado"
        value={choice}
        onChange={setChoice}
        options={[
          { value: 'last7', label: 'Últimos 7 dias' },
          { value: 'lastWeek', label: 'Semana passada' },
          ...(fromParam ? [{ value: 'custom' as const, label: 'Período do relatório' }] : []),
        ]}
      />
      <p className="meta">Período: {formatRange(period.start, period.end)}</p>
      <div>
        <Button variant="primary" icon={<Compass size={18} aria-hidden="true" />} disabled={!ready} busy={state.status === 'loading'} onClick={() => void run()}>
          Fazer revisão
        </Button>
      </div>
      {state.status === 'insufficient' && (
        <Notice tone="info" title="Ainda não há registros suficientes para uma revisão">
          <ul>
            {state.reasons?.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <p style={{ marginTop: 6 }}>Continue registrando conclusões por mais alguns dias ou ajuste a rotina manualmente em Hábitos.</p>
        </Notice>
      )}
      {state.status === 'error' && (
        <Notice tone="warn" title="Sem resposta do Kai" role="alert">
          {state.message} Nenhuma análise foi gerada.
        </Notice>
      )}
      {state.status === 'done' && state.stored && state.refMap && (
        <div className="panel">
          <ReviewResult
            stored={state.stored}
            refMap={state.refMap}
            onDecision={(d) => {
              if (state.insightId) void setInsightDecision(state.insightId, d);
            }}
          />
        </div>
      )}
    </div>
  );
}
