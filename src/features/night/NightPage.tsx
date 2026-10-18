import { Keyboard, LifeBuoy, Mic, MicOff, Play, RotateCcw, Send, Square, Volume2, VolumeX } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useApp } from '../../app/context';
import { ConfirmDialog } from '../../components/dialog';
import { useToast } from '../../components/toast';
import { Button, LoadingState, Notice, PageHeader, Section } from '../../components/ui';
import { newId, nowIso } from '../../db/db';
import { describeError } from '../../db/errors';
import {
  useAgendaCompletions,
  useAgendaItems,
  useCheckins,
  useCompletions,
  useDayPlan,
  useGoals,
  useHabits,
  useJournal,
  useNightSession,
  useProgressEvents,
} from '../../db/hooks';
import { createAgendaItem, deleteAgendaItem } from '../../db/repo-agenda';
import { recordHabit } from '../../db/repo-habits';
import { appendNightMessages, deleteNightSession, setPriority, setProposalState } from '../../db/repo-night';
import { setConsent, updatePrefs } from '../../db/repo-profile';
import { addDays } from '../../domain/civil';
import { formatLongDate } from '../../domain/format';
import { computeNightBrief, nightDateFor, nightSpeech, RADAR_DAYS } from '../../domain/nightly';
import { buildNightPayload, nightEvidence } from '../../domain/nightly-kai';
import type { ConsentKey, DayPlan, NightMessage } from '../../domain/schemas';
import { unlockSpeech } from '../../lib/speech';
import { useCalendarStatus, useGoogleEvents } from '../calendar/calendar-client';
import { KAI_SUPPORT_TEXT, runKai, useKaiAvailability, type KaiAvailability } from '../kai/kai-client';
import { ConsentDialog } from '../privacy/ConsentDialog';
import { useGoalContext, useNow } from '../shared/data';
import { NightBriefCards } from './NightBriefCards';
import { NightConversation, type ProposalActions } from './NightConversation';
import { NightOrb, type OrbPhase } from './NightOrb';
import { NightSettings } from './NightSettings';
import { PriorityCard } from './PriorityCard';
import { useVoice } from './use-voice';

const HISTORY_LIMIT = 16;

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const normalize = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();

function kaiNote(kai: KaiAvailability): { text: string; tone: 'ok' | 'warn' | 'neutral'; setup: boolean } {
  switch (kai.state) {
    case 'ready':
      return { text: 'Kai pronto. As respostas são geradas por IA (Anthropic) e podem conter erros.', tone: 'ok', setup: false };
    case 'off':
      return {
        text: kai.outdated ? 'A autorização do Kai mudou (agora inclui a sessão da noite): revise em Kai para voltar a usar. Enquanto isso, o app lê o resumo dele mesmo.' : 'Kai desligado: o resumo abaixo é calculado pelo app, sem IA, e nada sai do aparelho.',
        tone: 'neutral',
        setup: false,
      };
    case 'checking':
      return { text: 'Verificando o Kai…', tone: 'neutral', setup: false };
    case 'offline':
      return { text: 'Sem internet: o Kai volta quando a conexão voltar. O resumo do app continua funcionando.', tone: 'warn', setup: false };
    case 'unauthorized':
      return { text: 'A camada privada pediu a senha do servidor. Informe-a em Conectar Kai e Google.', tone: 'warn', setup: true };
    case 'unavailable':
      return { text: `Kai indisponível: ${kai.message}`, tone: 'warn', setup: true };
  }
}

export function NightPage() {
  const { profile, prefs, timezone, today } = useApp();
  const toast = useToast();
  const navigate = useNavigate();
  const now = useNow(30_000);
  const date = nightDateFor(now, timezone);
  const tomorrow = addDays(date, 1);

  const habits = useHabits();
  const completions = useCompletions();
  const items = useAgendaItems();
  const agendaCompletions = useAgendaCompletions();
  const goals = useGoals();
  const goalCtx = useGoalContext();
  const progressEvents = useProgressEvents();
  const checkins = useCheckins();
  const journal = useJournal();
  const todayPlan = useDayPlan(date);
  const tomorrowPlan = useDayPlan(tomorrow);
  const session = useNightSession(date);

  const [kai] = useKaiAvailability();
  const [calendar] = useCalendarStatus();
  const canReadEvents = calendar.state === 'ok' && calendar.status.connected && calendar.status.canReadEvents;
  const [events] = useGoogleEvents(tomorrow, addDays(date, RADAR_DAYS), canReadEvents);
  const googleEvents = events.state === 'ok' ? events.events : undefined;

  const voice = useVoice({ allowOnline: prefs.consents.voice.granted, preferredUri: prefs.nightly.voiceURI, rate: prefs.nightly.rate });
  const [thinking, setThinking] = useState(false);
  /** `retry` guarda o pedido (não uma função), para que a nova tentativa use os dados atuais da conversa. */
  const [error, setError] = useState<{ message: string; retry?: { message?: string; via?: 'voice' | 'text' } } | null>(null);
  const [text, setText] = useState('');
  const [asking, setAsking] = useState<{ key: ConsentKey; then?: () => void } | null>(null);
  const [priorityDraft, setPriorityDraft] = useState<{ text: string; source: NonNullable<DayPlan['prioritySource']> } | null>(null);
  const [busyKey, setBusyKey] = useState<string>();
  const [confirmReset, setConfirmReset] = useState(false);
  const [dictatingPriority, setDictatingPriority] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const loaded = Boolean(habits && completions && items && agendaCompletions && goals && goalCtx && progressEvents && checkins && journal) && todayPlan !== undefined && tomorrowPlan !== undefined && session !== undefined;

  const brief = useMemo(() => {
    if (!habits || !completions || !items || !agendaCompletions || !goals || !goalCtx || !progressEvents || !checkins || todayPlan === undefined || tomorrowPlan === undefined) return null;
    return computeNightBrief({
      now,
      profile,
      habits,
      completions,
      agendaItems: items,
      agendaCompletions,
      goals,
      goalCtx,
      progressEvents,
      checkins,
      todayPlan,
      tomorrowPlan,
      googleEvents,
    });
  }, [now, profile, habits, completions, items, agendaCompletions, goals, goalCtx, progressEvents, checkins, todayPlan, tomorrowPlan, googleEvents]);

  const kaiReady = kai.state === 'ready';
  const messages = session?.messages ?? [];
  const phase: OrbPhase = voice.listening ? 'listening' : thinking ? 'thinking' : voice.speaking ? 'speaking' : 'idle';
  const canListen = voice.support.recognition;
  const note = kaiNote(kai);

  if (!loaded || !brief || !habits || !completions || !goals || !goalCtx || !checkins || !journal) {
    return (
      <div className="page">
        <PageHeader title="Noite" subtitle={capitalize(formatLongDate(date))} />
        <LoadingState />
      </div>
    );
  }

  const snapshot = { today: brief.date, profile, prefs, habits, completions, goals, goalCtx, checkins, journal };

  // ── Fala e escuta ─────────────────────────────────────────────────────────

  function speakOut(content: string) {
    if (!prefs.nightly.speak || !voice.support.synthesis) return;
    void voice.say(content).then((result) => {
      if (result === 'ended' && prefs.nightly.handsFree && canListen && prefs.consents.voice.granted && !voice.support.iosStandalone) startListening();
    });
  }

  /** `consented`: a autorização acabou de ser concedida (o `prefs` deste render ainda não a enxerga). */
  function startListening(consented = false) {
    setError(null);
    if (!canListen) {
      composerRef.current?.focus();
      return;
    }
    if (!consented && !prefs.consents.voice.granted) {
      setAsking({ key: 'voice', then: () => startListening(true) });
      return;
    }
    voice.listen({
      onFinal: (heard) => void handleUtterance(heard, 'voice'),
      onError: (message) => setError({ message }),
    });
  }

  function dictatePriority(consented = false) {
    if (!consented && !prefs.consents.voice.granted) {
      setAsking({ key: 'voice', then: () => dictatePriority(true) });
      return;
    }
    setDictatingPriority(true);
    voice.listen({
      onFinal: (heard) => {
        setDictatingPriority(false);
        setPriorityDraft({ text: heard.slice(0, 200), source: 'voice' });
      },
      onError: (message) => {
        setDictatingPriority(false);
        setError({ message });
      },
    });
  }

  function onOrb() {
    unlockSpeech();
    if (voice.listening) voice.stopListening();
    else if (voice.speaking) {
      voice.stopSpeaking();
      if (canListen && prefs.consents.voice.granted) startListening();
    } else if (thinking) abortRef.current?.abort();
    else if (messages.length === 0) void openSession();
    else startListening();
  }

  // ── Sessão ────────────────────────────────────────────────────────────────

  async function openSession() {
    unlockSpeech();
    setError(null);
    if (kaiReady) await askKai();
    else await localBrief();
  }

  async function localBrief() {
    const { say, question } = nightSpeech(brief!, profile.name);
    const message: NightMessage = { id: newId(), role: 'assistant', source: 'app', content: say, question, createdAt: nowIso() };
    try {
      await appendNightMessages(date, [message]);
    } catch (e) {
      toast.show(describeError(e), { tone: 'danger' });
    }
    speakOut(`${say} ${question}`);
  }

  async function handleUtterance(raw: string, via: 'voice' | 'text') {
    const message = raw.replace(/\s+/g, ' ').trim().slice(0, 2000);
    if (!message) return;
    if (kaiReady) {
      await askKai(message, via);
      return;
    }
    // Sem o Kai: a resposta à pergunta da noite vira um rascunho de prioridade para confirmar.
    try {
      await appendNightMessages(date, [{ id: newId(), role: 'user', content: message, via, createdAt: nowIso() }]);
    } catch (e) {
      toast.show(describeError(e), { tone: 'danger' });
    }
    setPriorityDraft({ text: message.slice(0, 200), source: via === 'voice' ? 'voice' : 'manual' });
    const reply = 'Anotei como rascunho da prioridade de amanhã. Confira o texto e toque em Salvar prioridade.';
    try {
      await appendNightMessages(date, [{ id: newId(), role: 'assistant', source: 'app', content: reply, createdAt: nowIso() }]);
    } catch {
      // a conversa local é só um registro
    }
    speakOut(reply);
  }

  async function askKai(message?: string, via?: 'voice' | 'text', retry = false) {
    let payload: ReturnType<typeof buildNightPayload>;
    try {
      payload = buildNightPayload(snapshot, brief!, { includeAgenda: prefs.consents.kaiAgenda.granted });
    } catch (e) {
      setError({ message: e instanceof Error ? e.message : 'Não foi possível montar os dados da noite.' });
      return;
    }
    const prior = session?.messages ?? [];
    if (message && !retry) {
      try {
        await appendNightMessages(date, [{ id: newId(), role: 'user', content: message, via, createdAt: nowIso() }]);
      } catch (e) {
        toast.show(describeError(e), { tone: 'danger' });
      }
    }
    const before = message && retry ? prior.slice(0, -1) : prior;
    const history = before.slice(-HISTORY_LIMIT).map((m) => ({
      role: m.role,
      content: (m.role === 'assistant' ? [m.content, m.question].filter(Boolean).join(' ') : m.content).slice(0, 4000),
    }));
    setThinking(true);
    setError(null);
    const controller = new AbortController();
    abortRef.current = controller;
    const res = await runKai('nightly', { context: payload.context, night: payload.night, message, history }, prefs, controller.signal);
    if (abortRef.current === controller) abortRef.current = null;
    setThinking(false);
    if (!res.ok) {
      if (res.code === 'aborted') return;
      setError({ message: `${res.message} Nenhuma resposta foi gerada.`, retry: { message, via } });
      return;
    }
    const d = res.data;
    const refs = [...d.observations.flatMap((o) => o.refs), ...d.proposals.flatMap((p) => p.refs)];
    const assistant: NightMessage = {
      id: newId(),
      role: 'assistant',
      source: 'kai',
      content: d.say,
      question: d.question ?? undefined,
      priority: d.priority ?? undefined,
      observations: d.observations,
      proposals: d.proposals.map((p) => ({
        kind: p.kind,
        title: p.title,
        detail: p.detail,
        refs: p.refs,
        start: p.start,
        end: p.end,
        habitId: p.habitRef ? payload.refMap[p.habitRef] : undefined,
        goalId: p.goalRef ? payload.refMap[p.goalRef] : undefined,
        status: 'pending',
      })),
      evidence: nightEvidence(refs, payload),
      supportNotice: d.supportNotice || undefined,
      model: res.model,
      createdAt: nowIso(),
    };
    try {
      await appendNightMessages(date, [assistant], { dataUsed: payload.manifest });
    } catch (e) {
      toast.show(describeError(e), { tone: 'danger' });
    }
    speakOut([d.say, d.question].filter(Boolean).join(' '));
  }

  async function sendText() {
    const message = text.trim();
    if (!message || thinking) return;
    unlockSpeech();
    setText('');
    await handleUtterance(message, 'text');
  }

  // ── Propostas do Kai ──────────────────────────────────────────────────────

  const actions: ProposalActions = {
    accept: (m, index) => {
      const p = m.proposals?.[index];
      if (!p) return;
      const key = `${m.id}:${index}`;
      setBusyKey(key);
      const run = async () => {
        let createdItemId: string | undefined;
        if (p.kind === 'bloco_amanha' && p.start && p.end) {
          const habit = p.habitId ? habits.find((h) => h.id === p.habitId && h.status !== 'archived') : undefined;
          const sameHabit = habit && (normalize(p.title).includes(normalize(habit.title)) || normalize(habit.title).includes(normalize(p.title)));
          const item = await createAgendaItem(
            sameHabit && habit
              ? { kind: 'habit', habitId: habit.id, title: habit.title, date: tomorrow, allDay: false, startTime: p.start, endTime: p.end, origin: 'kai', goalId: p.goalId }
              : { kind: 'task', title: p.title, date: tomorrow, allDay: false, startTime: p.start, endTime: p.end, origin: 'kai', goalId: p.goalId },
            { timezone },
          );
          createdItemId = item.id;
          toast.show(`Bloco criado na agenda de amanhã, ${p.start}–${p.end}.`);
        } else if (p.kind === 'tarefa_amanha' || p.kind === 'bloco_amanha') {
          const item = await createAgendaItem({ kind: 'task', title: p.title, date: tomorrow, allDay: true, origin: 'kai', goalId: p.goalId }, { timezone });
          createdItemId = item.id;
          toast.show('Tarefa criada para amanhã. Ajuste o horário na Agenda, se quiser.');
        }
        await setProposalState(date, m.id, index, { status: 'accepted', createdItemId });
        if (p.kind === 'ajustar_habito') navigate(p.habitId ? `/habitos/${p.habitId}/editar` : '/habitos');
        else if (p.kind === 'revisar_agenda') navigate(`/agenda?data=${tomorrow}`);
        else if (p.kind === 'reflexao') navigate(`/diario?data=${date}`);
      };
      void run()
        .catch((e) => toast.show(describeError(e), { tone: 'danger' }))
        .finally(() => setBusyKey(undefined));
    },
    dismiss: (m, index) => {
      void setProposalState(date, m.id, index, { status: 'dismissed' }).catch((e) => toast.show(describeError(e), { tone: 'danger' }));
    },
    undo: (m, index) => {
      const p = m.proposals?.[index];
      if (!p) return;
      const key = `${m.id}:${index}`;
      setBusyKey(key);
      const run = async () => {
        if (p.createdItemId) {
          try {
            await deleteAgendaItem(p.createdItemId, { scope: 'all' });
          } catch {
            // o item já pode ter sido apagado na Agenda
          }
        }
        await setProposalState(date, m.id, index, { status: 'pending', createdItemId: null });
        if (p.createdItemId) toast.show('Item removido da agenda.');
      };
      void run()
        .catch((e) => toast.show(describeError(e), { tone: 'danger' }))
        .finally(() => setBusyKey(undefined));
    },
    usePriority: (value) => {
      void setPriority(tomorrow, value, 'kai')
        .then(() => toast.show('Prioridade de amanhã definida. Ela aparece na tela Hoje.'))
        .catch((e) => toast.show(describeError(e), { tone: 'danger' }));
    },
  };

  // ── Interface ─────────────────────────────────────────────────────────────

  const statusText =
    phase === 'listening'
      ? 'Ouvindo… toque na esfera quando terminar.'
      : phase === 'thinking'
        ? 'O Kai está pensando… toque para cancelar.'
        : phase === 'speaking'
          ? 'Falando… toque na esfera para interromper.'
          : messages.length === 0
            ? kaiReady
              ? 'Toque na esfera para começar a sessão da noite com o Kai.'
              : 'Toque na esfera para ouvir o resumo da noite.'
            : canListen
              ? 'Toque na esfera para falar, ou escreva abaixo.'
              : 'Escreva sua resposta abaixo.';

  const orbLabel =
    phase === 'listening' ? 'Parar de ouvir' : phase === 'speaking' ? 'Interromper a fala' : phase === 'thinking' ? 'Cancelar o pedido ao Kai' : messages.length === 0 ? 'Começar a sessão da noite' : 'Falar';

  const googleNote = !prefs.consents.calendar.granted
    ? 'Google Agenda: desligado. Só a agenda do Rotinas entra no resumo.'
    : calendar.state === 'ok' && calendar.status.connected
      ? calendar.status.canReadEvents
        ? events.state === 'ok'
          ? `Inclui ${events.events.length === 1 ? '1 evento' : `${events.events.length} eventos`} do Google Agenda dos próximos dias.`
          : events.state === 'error'
            ? `Eventos do Google não carregaram: ${events.message}`
            : 'Lendo eventos do Google Agenda…'
        : 'Google conectado só com livre/ocupado: os títulos dos eventos não entram. Ative “Ver meus eventos” em Calendário externo.'
      : 'Google Agenda não conectado: só a agenda do Rotinas entra no resumo.';

  return (
    <div className="page night-page">
      <PageHeader title="Noite" subtitle={`${capitalize(formatLongDate(brief.date))}${brief.afterMidnight ? ' (fechando o dia depois da meia-noite)' : ''} · ${brief.nowTime}`} />

      <section className={`night-stage is-${phase}`} aria-label="Sessão da noite">
        <button type="button" className="orb-button" onClick={onOrb} aria-label={orbLabel}>
          <NightOrb phase={phase} />
        </button>
        <p className="night-status" role="status" aria-live="polite">
          {statusText}
        </p>
        {voice.partial && <p className="night-partial">“{voice.partial}”</p>}
        <div className="night-controls">
          {messages.length === 0 ? (
            <Button variant="primary" icon={<Play size={18} aria-hidden="true" />} onClick={() => void openSession()} disabled={thinking}>
              {kaiReady ? 'Começar com o Kai' : 'Ouvir o resumo'}
            </Button>
          ) : (
            <>
              {canListen ? (
                <Button
                  variant={voice.listening ? 'danger' : 'primary'}
                  icon={voice.listening ? <MicOff size={18} aria-hidden="true" /> : <Mic size={18} aria-hidden="true" />}
                  onClick={() => {
                    unlockSpeech();
                    if (voice.listening) voice.stopListening();
                    else startListening();
                  }}
                  disabled={thinking}
                  aria-pressed={voice.listening}
                >
                  {voice.listening ? 'Parar' : 'Falar'}
                </Button>
              ) : (
                <Button icon={<Keyboard size={18} aria-hidden="true" />} onClick={() => composerRef.current?.focus()}>
                  Escrever
                </Button>
              )}
              {!kaiReady && (
                <Button icon={<Play size={18} aria-hidden="true" />} onClick={() => void localBrief()}>
                  Ouvir de novo
                </Button>
              )}
            </>
          )}
          {voice.speaking && (
            <Button variant="ghost" icon={<Square size={16} aria-hidden="true" />} onClick={voice.stopSpeaking}>
              Silenciar
            </Button>
          )}
          {voice.support.synthesis && (
            <Button
              variant="ghost"
              icon={prefs.nightly.speak ? <Volume2 size={18} aria-hidden="true" /> : <VolumeX size={18} aria-hidden="true" />}
              aria-pressed={prefs.nightly.speak}
              onClick={() => {
                if (prefs.nightly.speak) voice.stopSpeaking();
                void updatePrefs((p) => ({ ...p, nightly: { ...p.nightly, speak: !p.nightly.speak } }));
              }}
            >
              {prefs.nightly.speak ? 'Voz ligada' : 'Voz desligada'}
            </Button>
          )}
        </div>
        <p className={`night-mode is-${note.tone}`}>
          {note.text}{' '}
          {note.setup && (
            <Link to="/conexoes" className="night-link">
              Conectar Kai e Google
            </Link>
          )}
          {kai.state === 'off' && (
            <Link to="/kai" className="night-link">
              {kai.outdated ? 'Revisar autorização' : 'Ativar o Kai'}
            </Link>
          )}
        </p>
      </section>

      {error && (
        <Notice
          tone="warn"
          role="alert"
          action={
            error.retry ? (
              <Button size="sm" icon={<RotateCcw size={16} aria-hidden="true" />} onClick={() => void askKai(error.retry?.message, error.retry?.via, Boolean(error.retry?.message))}>
                Tentar de novo
              </Button>
            ) : undefined
          }
        >
          {error.message}
        </Notice>
      )}

      {messages.length > 0 && (
        <Section
          title="Conversa desta noite"
          id="night-chat"
          action={
            <Button size="sm" variant="ghost" icon={<RotateCcw size={16} aria-hidden="true" />} onClick={() => setConfirmReset(true)}>
              Recomeçar
            </Button>
          }
        >
          <NightConversation messages={messages} timezone={timezone} tomorrowPriority={tomorrowPlan?.priority} actions={actions} busyKey={busyKey} />
          {thinking && (
            <p className="meta" role="status" style={{ marginTop: 8 }}>
              O Kai está respondendo…
            </p>
          )}
        </Section>
      )}

      {(messages.length > 0 || kaiReady) && (
        <form
          className="composer night-composer"
          onSubmit={(e) => {
            e.preventDefault();
            void sendText();
          }}
        >
          <label className="visually-hidden" htmlFor="night-message">
            {kaiReady ? 'Mensagem para o Kai' : 'Sua resposta'}
          </label>
          <textarea
            id="night-message"
            ref={composerRef}
            className="textarea"
            value={text}
            maxLength={2000}
            rows={2}
            placeholder={kaiReady ? 'Responda ao Kai (ou use o microfone do teclado para ditar)…' : 'Escreva a prioridade de amanhã…'}
            disabled={thinking}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void sendText();
              }
            }}
          />
          <Button type="submit" variant="primary" icon={<Send size={18} aria-hidden="true" />} disabled={!text.trim() || thinking} busy={thinking}>
            Enviar
          </Button>
        </form>
      )}

      <Section title="Prioridade nº 1 de amanhã" id="night-priority" description="Uma decisão só, tomada hoje à noite. Amanhã ela aparece no topo da tela Hoje.">
        <PriorityCard
          date={date}
          tomorrow={tomorrow}
          todayPlan={todayPlan ?? null}
          tomorrowPlan={tomorrowPlan ?? null}
          draft={priorityDraft}
          onDraftConsumed={() => setPriorityDraft(null)}
          canDictate={canListen}
          onDictate={() => dictatePriority()}
          dictating={dictatingPriority && voice.listening}
        />
      </Section>

      <Section title="Resumo da noite" id="night-brief" description="Calculado no aparelho a partir dos seus registros. É o que o app lê em voz alta quando o Kai está desligado.">
        <NightBriefCards
          brief={brief}
          googleNote={googleNote}
          onCompleteHabit={(habitId) => {
            const h = habits.find((x) => x.id === habitId);
            void recordHabit(habitId, brief.date, 'done', { today, timezone })
              .then(() => toast.show(`Concluído: ${h?.title ?? 'hábito'}${h?.xp ? ` (+${h.xp} XP)` : ''}`))
              .catch((e) => toast.show(describeError(e), { tone: 'danger' }));
          }}
        />
      </Section>

      <Section title="Ajustes da noite" id="night-settings">
        <NightSettings voice={voice} onAsk={(key) => setAsking({ key })} />
        {session?.dataUsed && (
          <details className="explain" style={{ marginTop: 12 }}>
            <summary>O que foi enviado ao Kai nesta noite</summary>
            <ul className="small">
              {session.dataUsed.categories.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </details>
        )}
      </Section>

      <div className="notice" style={{ marginTop: 32 }}>
        <LifeBuoy size={18} aria-hidden="true" />
        <p className="small">{KAI_SUPPORT_TEXT}</p>
      </div>

      {asking && (
        <ConsentDialog
          consent={asking.key}
          open
          onClose={() => setAsking(null)}
          onDecide={async (granted) => {
            const next = asking.then;
            setAsking(null);
            try {
              await setConsent(asking.key, granted);
              if (granted) toast.show('Autorização concedida.');
            } catch (e) {
              toast.show(describeError(e), { tone: 'danger' });
              return;
            }
            // A escuta precisa começar depois que a autorização valer (o próximo render já a enxerga).
            if (granted && next) window.setTimeout(next, 0);
          }}
        />
      )}

      <ConfirmDialog
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        title="Recomeçar a conversa desta noite?"
        confirmLabel="Apagar e recomeçar"
        danger
        message={<p className="small">A conversa desta noite é apagada deste aparelho. Itens criados na agenda e a prioridade de amanhã continuam salvos.</p>}
        onConfirm={async () => {
          voice.stopSpeaking();
          await deleteNightSession(date);
          setConfirmReset(false);
        }}
      />
    </div>
  );
}
