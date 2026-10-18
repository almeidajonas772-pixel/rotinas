import { CalendarPlus, Check, LifeBuoy, ListTodo, NotebookPen, PencilLine, Star, Undo2, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button, Tag } from '../../components/ui';
import { formatTimeOfInstant } from '../../domain/format';
import type { NightMessage, NightProposal } from '../../domain/schemas';
import { KAI_SUPPORT_TEXT } from '../kai/kai-client';
import { EvidenceList } from '../kai/kai-render';

const CONFIDENCE: Record<'baixa' | 'media' | 'alta', string> = { baixa: 'confiança baixa', media: 'confiança média', alta: 'confiança alta' };

const KIND_LABEL: Record<NightProposal['kind'], string> = {
  bloco_amanha: 'Bloco amanhã',
  tarefa_amanha: 'Tarefa para amanhã',
  ajustar_habito: 'Ajustar hábito',
  revisar_agenda: 'Revisar agenda',
  reflexao: 'Reflexão',
};

function acceptLabel(p: NightProposal): { label: string; icon: ReactNode } {
  switch (p.kind) {
    case 'bloco_amanha':
      return { label: `Criar bloco ${p.start}–${p.end}`, icon: <CalendarPlus size={16} aria-hidden="true" /> };
    case 'tarefa_amanha':
      return { label: 'Criar tarefa para amanhã', icon: <ListTodo size={16} aria-hidden="true" /> };
    case 'ajustar_habito':
      return { label: 'Abrir o hábito', icon: <PencilLine size={16} aria-hidden="true" /> };
    case 'revisar_agenda':
      return { label: 'Abrir a agenda de amanhã', icon: <CalendarPlus size={16} aria-hidden="true" /> };
    case 'reflexao':
      return { label: 'Abrir o Diário', icon: <NotebookPen size={16} aria-hidden="true" /> };
  }
}

export interface ProposalActions {
  accept: (message: NightMessage, index: number) => void;
  dismiss: (message: NightMessage, index: number) => void;
  undo: (message: NightMessage, index: number) => void;
  usePriority: (text: string) => void;
}

export function NightConversation({
  messages,
  timezone,
  tomorrowPriority,
  actions,
  busyKey,
}: {
  messages: readonly NightMessage[];
  timezone: string;
  tomorrowPriority?: string;
  actions: ProposalActions;
  /** Proposta sendo aplicada agora (`${messageId}:${index}`). */
  busyKey?: string;
}) {
  return (
    <div className="chat night-chat">
      {messages.map((m) =>
        m.role === 'user' ? (
          <div key={m.id} className="msg is-user">
            {m.content}
            <p className="msg-meta">
              Você{m.via === 'voice' ? ' (por voz)' : ''}, {formatTimeOfInstant(m.createdAt, timezone)}
            </p>
          </div>
        ) : (
          <div key={m.id} className={`msg is-kai${m.source === 'app' ? ' is-app' : ''}`}>
            <p>{m.content}</p>
            {m.question && <p className="night-question">{m.question}</p>}
            {m.supportNotice && (
              <div className="notice is-warn" style={{ marginTop: 10, whiteSpace: 'normal' }}>
                <LifeBuoy size={18} aria-hidden="true" />
                <span>{KAI_SUPPORT_TEXT}</span>
              </div>
            )}
            {m.observations && m.observations.length > 0 && (
              <div className="night-observations">
                {m.observations.map((o, i) => (
                  <div key={i} className="night-observation">
                    <p className="small">
                      {o.text} <span className="meta">({CONFIDENCE[o.confidence]})</span>
                    </p>
                    {m.evidence && <EvidenceList refs={o.refs} evidence={m.evidence} />}
                  </div>
                ))}
              </div>
            )}
            {m.proposals && m.proposals.length > 0 && (
              <div className="night-proposals">
                {m.proposals.map((p, i) => {
                  const key = `${m.id}:${i}`;
                  const accept = acceptLabel(p);
                  return (
                    <div key={key} className={`kai-card night-proposal is-${p.status}`}>
                      <div className="row-between">
                        <Tag tone="accent">{KIND_LABEL[p.kind]}</Tag>
                        {p.status === 'accepted' && <Tag tone="ok">Aceita</Tag>}
                        {p.status === 'dismissed' && <Tag>Dispensada</Tag>}
                      </div>
                      <p className="row-title" style={{ marginTop: 6 }}>
                        {p.title}
                      </p>
                      {p.detail && <p className="small">{p.detail}</p>}
                      {m.evidence && p.refs.length > 0 && <EvidenceList refs={p.refs} evidence={m.evidence} />}
                      <div className="btn-row" style={{ marginTop: 10 }}>
                        {p.status === 'pending' && (
                          <>
                            <Button size="sm" variant="primary" icon={accept.icon} busy={busyKey === key} onClick={() => actions.accept(m, i)}>
                              {accept.label}
                            </Button>
                            <Button size="sm" variant="ghost" icon={<X size={16} aria-hidden="true" />} onClick={() => actions.dismiss(m, i)}>
                              Agora não
                            </Button>
                          </>
                        )}
                        {p.status === 'accepted' && p.createdItemId && (
                          <Button size="sm" variant="ghost" icon={<Undo2 size={16} aria-hidden="true" />} busy={busyKey === key} onClick={() => actions.undo(m, i)}>
                            Desfazer
                          </Button>
                        )}
                        {p.status === 'dismissed' && (
                          <Button size="sm" variant="ghost" icon={<Undo2 size={16} aria-hidden="true" />} onClick={() => actions.undo(m, i)}>
                            Reconsiderar
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {m.priority && (
              <div className="night-priority-suggestion">
                <Star size={16} aria-hidden="true" />
                <span className="grow">
                  Prioridade sugerida: <strong>{m.priority}</strong>
                </span>
                {tomorrowPriority === m.priority ? (
                  <Tag tone="ok">
                    <Check size={14} aria-hidden="true" /> Definida
                  </Tag>
                ) : (
                  <Button size="sm" onClick={() => actions.usePriority(m.priority!)}>
                    Usar para amanhã
                  </Button>
                )}
              </div>
            )}
            <p className="msg-meta">
              {m.source === 'app' ? 'Resumo calculado pelo app (sem IA)' : `Kai${m.model ? ` (${m.model})` : ''} · resposta gerada por IA, pode conter erros`}, {formatTimeOfInstant(m.createdAt, timezone)}
            </p>
          </div>
        ),
      )}
    </div>
  );
}
