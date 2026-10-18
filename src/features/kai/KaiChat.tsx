import { LifeBuoy, Plus, Send } from 'lucide-react';
import { useRef, useState } from 'react';
import { useApp } from '../../app/context';
import { SelectField } from '../../components/form';
import { Button, LoadingState, Notice } from '../../components/ui';
import { newId, nowIso } from '../../db/db';
import { useKaiConversations } from '../../db/hooks';
import { saveConversation } from '../../db/repo-misc';
import { formatInstant } from '../../domain/format';
import { buildKaiContext } from '../../domain/kai-context';
import { resolveEvidence } from '../../domain/kai-evidence';
import type { KaiConversation, KaiMessage } from '../../domain/schemas';
import { KAI_SUPPORT_TEXT, runKai, useKaiSnapshot } from './kai-client';
import { EvidenceList } from './kai-render';

const NEW = '__nova__';

export function KaiChat({ ready }: { ready: boolean }) {
  const { prefs, timezone } = useApp();
  const conversations = useKaiConversations();
  const snapshot = useKaiSnapshot();
  const [selected, setSelected] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<{ message: string; retry?: { conversation: KaiConversation; message: string } }>();
  const listRef = useRef<HTMLDivElement>(null);

  if (!conversations) return <LoadingState />;
  const current = selected === NEW ? undefined : (conversations.find((c) => c.id === selected) ?? (selected === null ? conversations[0] : undefined));

  async function request(conversation: KaiConversation, message: string) {
    if (!snapshot) return;
    let built;
    try {
      built = buildKaiContext(snapshot);
    } catch (e) {
      setError({ message: e instanceof Error ? e.message : 'Não foi possível montar o contexto.' });
      return;
    }
    const history = conversation.messages
      .slice(0, -1)
      .slice(-12)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
    setSending(true);
    setError(undefined);
    const res = await runKai('chat', { context: built.context, message, history }, prefs);
    setSending(false);
    if (!res.ok) {
      setError({ message: res.message, retry: { conversation, message } });
      return;
    }
    const assistant: KaiMessage = {
      id: newId(),
      role: 'assistant',
      content: res.data.reply,
      createdAt: nowIso(),
      dataUsed: built.manifest,
      refMap: built.refMap,
      model: res.model,
      supportNotice: res.data.supportNotice || undefined,
      suggestions: res.data.suggestions.map((s) => ({
        title: s.title,
        detail: s.detail,
        refs: s.refs,
        evidence: resolveEvidence(s.refs, built.context).items.map((i) => ({ label: i.label, detail: i.detail })),
      })),
    };
    await saveConversation({ ...conversation, messages: [...conversation.messages, assistant].slice(-200), updatedAt: nowIso() });
    requestAnimationFrame(() => listRef.current?.lastElementChild?.scrollIntoView({ block: 'nearest' }));
  }

  async function send() {
    const message = text.trim();
    if (!message || sending || !ready) return;
    const now = nowIso();
    const base: KaiConversation = current ?? { id: newId(), title: message.slice(0, 60), messages: [], createdAt: now, updatedAt: now };
    const userMsg: KaiMessage = { id: newId(), role: 'user', content: message.slice(0, 2000), createdAt: now };
    const conversation = { ...base, messages: [...base.messages, userMsg].slice(-200), updatedAt: now };
    await saveConversation(conversation);
    setSelected(conversation.id);
    setText('');
    await request(conversation, message);
  }

  return (
    <div className="stack">
      <div className="row" style={{ alignItems: 'flex-end' }}>
        {conversations.length > 0 && (
          <div className="grow" style={{ minWidth: 200 }}>
            <SelectField
              label="Conversa"
              value={current?.id ?? NEW}
              onChange={(v) => setSelected(v)}
              options={[{ value: NEW, label: 'Nova conversa' }, ...conversations.map((c) => ({ value: c.id, label: `${c.title} (${formatInstant(c.updatedAt, timezone)})` }))]}
            />
          </div>
        )}
        {current && (
          <Button icon={<Plus size={18} aria-hidden="true" />} onClick={() => setSelected(NEW)}>
            Nova conversa
          </Button>
        )}
      </div>

      <div className="chat" ref={listRef} aria-live="polite">
        {!current || current.messages.length === 0 ? (
          <p className="meta">Pergunte sobre seus hábitos, sua semana ou como encaixar algo na rotina. O Kai responde com base nos dados autorizados e diz quando não há registros suficientes.</p>
        ) : (
          current.messages.map((m) =>
            m.role === 'user' ? (
              <div key={m.id} className="msg is-user">
                {m.content}
              </div>
            ) : (
              <div key={m.id} className="msg is-kai">
                {m.content}
                {m.supportNotice && (
                  <div className="notice is-warn" style={{ marginTop: 10, whiteSpace: 'normal' }}>
                    <LifeBuoy size={18} aria-hidden="true" />
                    <span>{KAI_SUPPORT_TEXT}</span>
                  </div>
                )}
                {m.suggestions && m.suggestions.length > 0 && (
                  <div style={{ marginTop: 10, whiteSpace: 'normal' }}>
                    {m.suggestions.map((s, i) => (
                      <div key={i} className="kai-card" style={{ padding: 12 }}>
                        <p className="row-title">{s.title}</p>
                        {s.detail && <p className="small">{s.detail}</p>}
                        {s.evidence && s.evidence.length > 0 && (
                          <EvidenceList refs={s.evidence.map((_, j) => String(j))} evidence={Object.fromEntries(s.evidence.map((e, j) => [String(j), e]))} />
                        )}
                      </div>
                    ))}
                  </div>
                )}
                <p className="msg-meta">
                  Kai, {formatInstant(m.createdAt, timezone)}
                  {m.model ? `, ${m.model}` : ''}. Resposta gerada por IA.
                </p>
              </div>
            ),
          )
        )}
        {sending && (
          <p className="meta" role="status">
            O Kai está respondendo…
          </p>
        )}
      </div>

      {error && (
        <Notice
          tone="warn"
          title="Sem resposta do Kai"
          role="alert"
          action={
            error.retry ? (
              <Button size="sm" onClick={() => void request(error.retry!.conversation, error.retry!.message)}>
                Tentar de novo
              </Button>
            ) : undefined
          }
        >
          {error.message} Nenhuma resposta foi gerada.
        </Notice>
      )}

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <label className="visually-hidden" htmlFor="kai-message">
          Mensagem para o Kai
        </label>
        <textarea
          id="kai-message"
          className="textarea"
          value={text}
          maxLength={2000}
          rows={2}
          placeholder={ready ? 'Ex.: Como posso encaixar leitura nos dias de semana?' : 'O Kai ainda não está disponível'}
          disabled={!ready}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <Button type="submit" variant="primary" icon={<Send size={18} aria-hidden="true" />} disabled={!ready || !text.trim()} busy={sending}>
          Enviar
        </Button>
      </form>
    </div>
  );
}
