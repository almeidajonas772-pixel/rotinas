import { useNavigate } from 'react-router';
import type { Confidence, KaiNextStepOutput, KaiWeeklyReviewOutput } from '../../../shared/kai';
import { Button, Notice, Tag } from '../../components/ui';
import { formatRange } from '../../domain/format';

export interface StoredEvidence {
  label: string;
  detail: string;
}

/** Formato guardado em kaiInsights.response: a saída validada + as evidências descritas pelo app. */
export interface StoredReview {
  output: KaiWeeklyReviewOutput;
  evidence: Record<string, StoredEvidence>;
  discarded: number;
  keptIndexes: number[];
}

export interface StoredNextStep {
  output: KaiNextStepOutput;
  evidence: Record<string, StoredEvidence>;
}

const CONFIDENCE_LABEL: Record<Confidence, string> = { baixa: 'Confiança baixa', media: 'Confiança média', alta: 'Confiança alta' };

export function EvidenceList({ refs, evidence }: { refs: string[]; evidence: Record<string, StoredEvidence> }) {
  const items = [...new Set(refs)].map((r) => evidence[r]).filter((e): e is StoredEvidence => Boolean(e));
  if (items.length === 0) return null;
  return (
    <ul className="evidence" aria-label="Evidências">
      {items.map((e) => (
        <li key={e.label + e.detail}>
          <span className="evidence-label">{e.label}:</span> {e.detail}
        </li>
      ))}
    </ul>
  );
}

const SUGGESTION_KIND: Record<KaiWeeklyReviewOutput['suggestions'][number]['kind'], string> = {
  ajustar_habito: 'Ajustar hábito',
  novo_habito: 'Novo hábito',
  tarefa: 'Tarefa',
  bloco_de_tempo: 'Bloco de tempo',
  reflexao: 'Reflexão',
  outro: 'Sugestão',
};

export function ReviewResult({ stored, refMap, onDecision }: { stored: StoredReview; refMap: Record<string, string>; onDecision?: (d: 'accepted' | 'ignored') => void }) {
  const navigate = useNavigate();
  const { output, evidence, discarded, keptIndexes } = stored;
  const observations = keptIndexes.map((i) => output.observations[i]).filter(Boolean);

  function act(s: KaiWeeklyReviewOutput['suggestions'][number]) {
    onDecision?.('accepted');
    const habitRef = s.refs.find((r) => r.startsWith('h'));
    const habitId = habitRef ? refMap[habitRef] : undefined;
    const q = new URLSearchParams({ titulo: s.title });
    if (s.kind === 'novo_habito') navigate(`/habitos/novo?${q.toString()}&intencao=${encodeURIComponent(s.detail)}`);
    else if (s.kind === 'tarefa') navigate(`/agenda?novo=1&tipo=task&${q.toString()}`);
    else if (s.kind === 'ajustar_habito' && habitId) navigate(`/habitos/${habitId}/editar`);
    else if (s.kind === 'bloco_de_tempo') navigate(habitId ? `/calendario?habito=${habitId}` : '/calendario');
    else if (s.kind === 'reflexao') navigate('/diario');
  }

  return (
    <div className="stack">
      <div className="row">
        <Tag>Período: {formatRange(output.period.start, output.period.end)}</Tag>
        <Tag tone="accent">{CONFIDENCE_LABEL[output.overallConfidence]}</Tag>
      </div>
      <div>
        <h3 className="section-title" style={{ fontSize: '1rem', marginBottom: 8 }}>
          Observações
        </h3>
        {observations.length === 0 ? (
          <p className="meta">Nenhuma observação com evidência verificável neste período.</p>
        ) : (
          <div>
            {observations.map((o, i) => (
              <div key={i} className="kai-card">
                <p>{o.text}</p>
                <p className="meta" style={{ marginTop: 4 }}>
                  {CONFIDENCE_LABEL[o.confidence]}
                </p>
                <EvidenceList refs={o.evidenceRefs} evidence={evidence} />
              </div>
            ))}
          </div>
        )}
        {discarded > 0 && (
          <p className="meta" style={{ marginTop: 8 }}>
            {discarded} observação{discarded === 1 ? '' : 'ões'} descartada{discarded === 1 ? '' : 's'} pelo app por não citar registros válidos ou por falta de dados suficientes do hábito.
          </p>
        )}
      </div>
      {output.limitations.length > 0 && (
        <div>
          <h3 className="section-title" style={{ fontSize: '1rem', marginBottom: 8 }}>
            Limitações
          </h3>
          <ul className="small muted">
            {output.limitations.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <h3 className="section-title" style={{ fontSize: '1rem', marginBottom: 8 }}>
          Sugestões opcionais
        </h3>
        {output.suggestions.length === 0 ? (
          <p className="meta">Nenhuma sugestão.</p>
        ) : (
          output.suggestions.map((s, i) => (
            <div key={i} className="kai-card">
              <p className="row-title">
                {s.title} <Tag>{SUGGESTION_KIND[s.kind]}</Tag>
              </p>
              {s.detail && <p className="small" style={{ marginTop: 4 }}>{s.detail}</p>}
              <EvidenceList refs={s.refs} evidence={evidence} />
              {onDecision && s.kind !== 'outro' && (
                <div className="btn-row" style={{ marginTop: 8 }}>
                  <Button size="sm" variant="primary" onClick={() => act(s)}>
                    {s.kind === 'ajustar_habito' ? 'Abrir hábito para ajustar' : s.kind === 'bloco_de_tempo' ? 'Planejar horário' : s.kind === 'reflexao' ? 'Abrir Diário' : 'Revisar e criar'}
                  </Button>
                </div>
              )}
            </div>
          ))
        )}
      </div>
      <Notice tone="neutral">Isto descreve associações nos seus registros, não causas nem previsões. Use como apoio para decidir.</Notice>
    </div>
  );
}

export function NextStepResult({ stored }: { stored: StoredNextStep }) {
  const { output, evidence } = stored;
  return (
    <div className="stack">
      <div className="kai-card">
        <p className="row-title">{output.step.title}</p>
        {output.step.detail && <p className="small" style={{ marginTop: 4 }}>{output.step.detail}</p>}
        {output.step.durationMinutes && <p className="meta">Cerca de {output.step.durationMinutes} min</p>}
        <EvidenceList refs={output.step.refs} evidence={evidence} />
      </div>
      <p className="small">
        <strong>Por quê:</strong> {output.rationale}
      </p>
      <p className="meta">{CONFIDENCE_LABEL[output.confidence]}</p>
      {output.limitations.length > 0 && (
        <ul className="small muted">
          {output.limitations.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
