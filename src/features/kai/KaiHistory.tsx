import { Trash } from 'lucide-react';
import { useState } from 'react';
import { useApp } from '../../app/context';
import { ConfirmDialog, Dialog } from '../../components/dialog';
import { useToast } from '../../components/toast';
import { Button, EmptyState, IconButton, LoadingState, Section, Tag } from '../../components/ui';
import { useKaiConversations, useKaiInsights } from '../../db/hooks';
import { clearKaiHistory, deleteConversation, deleteInsight } from '../../db/repo-misc';
import { formatInstant, formatRange } from '../../domain/format';
import type { KaiInsight } from '../../domain/schemas';
import { NextStepResult, ReviewResult, type StoredNextStep, type StoredReview } from './kai-render';

const KIND_LABEL: Record<KaiInsight['kind'], string> = {
  weekly_review: 'Revisão semanal',
  next_step: 'Próximo passo',
  initial_plan: 'Plano inicial',
  goal_breakdown: 'Divisão de meta',
};

const STATUS_LABEL: Record<KaiInsight['status'], string> = { ok: 'Concluída', insufficient_data: 'Dados insuficientes', error: 'Falhou' };

export function KaiHistory() {
  const { timezone } = useApp();
  const insights = useKaiInsights();
  const conversations = useKaiConversations();
  const toast = useToast();
  const [open, setOpen] = useState<KaiInsight | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  if (!insights || !conversations) return <LoadingState />;
  if (insights.length === 0 && conversations.length === 0) {
    return (
      <EmptyState title="Nada no histórico">
        <p>Revisões, sugestões de próximo passo e conversas ficam guardadas aqui, só neste aparelho.</p>
      </EmptyState>
    );
  }

  return (
    <div className="stack">
      <Section title="Análises" id="kai-insights">
        {insights.length === 0 ? (
          <p className="meta">Nenhuma análise.</p>
        ) : (
          <ul className="list" role="list">
            {insights.map((i) => (
              <li key={i.id} className="list-row">
                <div className="row-main">
                  <button type="button" className="row-link" style={{ background: 'none', border: 0, padding: 0, textAlign: 'left', cursor: i.status === 'ok' ? 'pointer' : 'default' }} onClick={() => i.status === 'ok' && setOpen(i)}>
                    <span className="row-title">{KIND_LABEL[i.kind]}</span>
                  </button>
                  <span className="row-meta">
                    <span>{formatInstant(i.createdAt, timezone)}</span>
                    {i.periodStart && i.periodEnd && <span>Período {formatRange(i.periodStart, i.periodEnd)}</span>}
                    <Tag tone={i.status === 'ok' ? 'accent' : i.status === 'error' ? 'warn' : undefined}>{STATUS_LABEL[i.status]}</Tag>
                    {i.decision && i.decision !== 'pending' && <span>{i.decision === 'accepted' ? 'Sugestão usada' : i.decision === 'ignored' ? 'Ignorada' : 'Editada'}</span>}
                    <span>Dados: {i.dataUsed.categories.length} categorias</span>
                  </span>
                </div>
                <IconButton label="Apagar análise" onClick={() => void deleteInsight(i.id)}>
                  <Trash size={18} aria-hidden="true" />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="Conversas" id="kai-conversations">
        {conversations.length === 0 ? (
          <p className="meta">Nenhuma conversa.</p>
        ) : (
          <ul className="list" role="list">
            {conversations.map((c) => (
              <li key={c.id} className="list-row">
                <div className="row-main">
                  <span className="row-title">{c.title}</span>
                  <span className="row-meta">
                    <span>{c.messages.length} mensagens</span>
                    <span>{formatInstant(c.updatedAt, timezone)}</span>
                  </span>
                </div>
                <IconButton label="Apagar conversa" onClick={() => void deleteConversation(c.id)}>
                  <Trash size={18} aria-hidden="true" />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <div>
        <Button variant="ghost" icon={<Trash size={18} aria-hidden="true" />} onClick={() => setConfirmClear(true)}>
          Apagar todo o histórico do Kai
        </Button>
      </div>

      <Dialog open={open !== null} onClose={() => setOpen(null)} title={open ? KIND_LABEL[open.kind] : ''} footer={<Button onClick={() => setOpen(null)}>Fechar</Button>}>
        {open && open.kind === 'weekly_review' && open.response != null && <ReviewResult stored={open.response as StoredReview} refMap={open.refMap} />}
        {open && open.kind === 'next_step' && open.response != null && <NextStepResult stored={open.response as StoredNextStep} />}
        {open && (
          <details className="explain" style={{ marginTop: 12 }}>
            <summary>Dados usados nesta análise</summary>
            <ul className="small">
              {open.dataUsed.categories.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            {open.model && <p className="meta">Modelo: {open.model}</p>}
          </details>
        )}
      </Dialog>
      <ConfirmDialog
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        title="Apagar histórico do Kai?"
        danger
        confirmLabel="Apagar histórico"
        message={<p className="small">Conversas e análises guardadas neste aparelho serão apagadas. Hábitos, metas e o Diário não são afetados.</p>}
        onConfirm={async () => {
          await clearKaiHistory();
          setConfirmClear(false);
          toast.show('Histórico do Kai apagado.');
        }}
      />
    </div>
  );
}
