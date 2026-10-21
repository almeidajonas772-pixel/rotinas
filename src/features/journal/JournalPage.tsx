import { ChevronLeft, ChevronRight, Lock, LockOpen, NotebookPen, Trash } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useApp } from '../../app/context';
import { ConfirmDialog } from '../../components/dialog';
import { SwitchRow, TextArea } from '../../components/form';
import { useToast } from '../../components/toast';
import { Button, EmptyState, IconButton, LoadingState, Notice, PageHeader, Section } from '../../components/ui';
import { useAgendaItems, useGoals, useHabits, useJournal, useJournalEntry } from '../../db/hooks';
import { describeError } from '../../db/errors';
import { deleteJournalEntry, saveJournalEntry } from '../../db/repo-journal';
import { expandAgenda } from '../../domain/agenda';
import { addDays, isCivilDate, type CivilDate } from '../../domain/civil';
import { formatInstant, formatLongDate } from '../../domain/format';
import { goalIsCurrent } from '../../domain/goals';
import { isScheduledOn } from '../../domain/schedule';
import type { JournalEntry } from '../../domain/schemas';
import { isClaudeRuntime } from '../../platform/runtime';

const PROMPTS: Array<{ key: 'didToday' | 'whatWorked' | 'toImprove' | 'nextStep'; label: string }> = [
  { key: 'didToday', label: 'O que eu fiz hoje?' },
  { key: 'whatWorked', label: 'O que funcionou? (ou o que aprendi)' },
  { key: 'toImprove', label: 'O que poderia melhorar?' },
  { key: 'nextStep', label: 'Qual é meu próximo passo?' },
];

export function JournalPage() {
  const { today } = useApp();
  const [params, setParams] = useSearchParams();
  const requested = params.get('data');
  const date = requested && isCivilDate(requested) && requested <= today ? requested : today;
  const entry = useJournalEntry(date);
  const history = useJournal();

  const go = (d: CivilDate) => setParams({ data: d });

  return (
    <div className="page">
      <PageHeader title="Diário" subtitle="Privado por padrão. Escreva livremente; as perguntas são só um apoio." />
      <div className="agenda-toolbar">
        <IconButton label="Dia anterior" onClick={() => go(addDays(date, -1))}>
          <ChevronLeft size={20} aria-hidden="true" />
        </IconButton>
        <input
          type="date"
          className="input"
          style={{ width: 'auto' }}
          aria-label="Escolher data"
          value={date}
          max={today}
          onChange={(e) => e.target.value && isCivilDate(e.target.value) && go(e.target.value)}
        />
        <IconButton label="Próximo dia" onClick={() => go(addDays(date, 1))} disabled={date >= today}>
          <ChevronRight size={20} aria-hidden="true" />
        </IconButton>
        {date !== today && (
          <Button size="sm" variant="ghost" onClick={() => go(today)}>
            Hoje
          </Button>
        )}
        <span className="agenda-range">{capitalize(formatLongDate(date, date.slice(0, 4) !== today.slice(0, 4)))}</span>
      </div>
      {entry === undefined ? <LoadingState /> : <JournalEditor key={date} date={date} entry={entry} />}

      <Section title="Entradas anteriores" id="journal-history">
        {!history ? (
          <LoadingState />
        ) : history.length === 0 ? (
          <EmptyState icon={<NotebookPen size={20} />} title="Nenhuma entrada ainda">
            <p>Suas reflexões aparecem aqui, da mais recente para a mais antiga.</p>
          </EmptyState>
        ) : (
          <ul className="journal-history" role="list">
            {history.slice(0, 60).map((e) => (
              <li key={e.id}>
                <Link to={`/diario?data=${e.date}`} aria-current={e.date === date ? 'page' : undefined}>
                  <span className="jh-date">{capitalize(formatLongDate(e.date, true))}</span>
                  {e.kaiAccess === 'blocked' && (
                    <span className="meta">
                      {' '}
                      <Lock size={12} aria-hidden="true" style={{ display: 'inline' }} /> fora do Kai
                    </span>
                  )}
                  <span className="jh-excerpt">{excerpt(e)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function excerpt(e: JournalEntry): string {
  const text = [e.text, e.didToday, e.whatWorked, e.toImprove, e.nextStep].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  return text.length > 180 ? `${text.slice(0, 179)}…` : text;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function JournalEditor({ date, entry }: { date: CivilDate; entry: JournalEntry | null }) {
  const { prefs, timezone } = useApp();
  const toast = useToast();
  const habits = useHabits();
  const goals = useGoals();
  const items = useAgendaItems();
  const [text, setText] = useState(entry?.text ?? '');
  const [prompts, setPrompts] = useState({
    didToday: entry?.didToday ?? '',
    whatWorked: entry?.whatWorked ?? '',
    toImprove: entry?.toImprove ?? '',
    nextStep: entry?.nextStep ?? '',
  });
  const [links, setLinks] = useState<JournalEntry['links']>(entry?.links ?? { habitIds: [], goalIds: [], agendaItemIds: [] });
  const [kaiAccess, setKaiAccess] = useState<JournalEntry['kaiAccess']>(entry?.kaiAccess ?? 'allowed');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [savedAt, setSavedAt] = useState(entry?.updatedAt);

  const dirty =
    text !== (entry?.text ?? '') ||
    PROMPTS.some((p) => prompts[p.key] !== (entry?.[p.key] ?? '')) ||
    JSON.stringify(links) !== JSON.stringify(entry?.links ?? { habitIds: [], goalIds: [], agendaItemIds: [] }) ||
    kaiAccess !== (entry?.kaiAccess ?? 'allowed');
  const empty = text.trim() === '' && PROMPTS.every((p) => prompts[p.key].trim() === '');

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const options = useMemo(() => {
    const dayHabits = (habits ?? []).filter((h) => h.status !== 'archived' && isScheduledOn(h, date));
    const dayGoals = (goals ?? []).filter((g) => g.status !== 'archived' && goalIsCurrent(g, date));
    const dayItems = items ? expandAgenda(items.filter((i) => i.kind !== 'habit'), date, date, timezone) : [];
    return { dayHabits, dayGoals, dayItems };
  }, [habits, goals, items, date, timezone]);

  async function save() {
    if (empty) {
      setError('Escreva algo antes de salvar.');
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const saved = await saveJournalEntry(date, { text, ...prompts, links, kaiAccess });
      setSavedAt(saved.updatedAt);
      toast.show('Entrada do Diário salva.');
    } catch (e) {
      setError(describeError(e));
    } finally {
      setSaving(false);
    }
  }

  const toggleLink = (kind: keyof JournalEntry['links'], id: string) =>
    setLinks({ ...links, [kind]: links[kind].includes(id) ? links[kind].filter((x) => x !== id) : [...links[kind], id] });

  const kaiConsent = prefs.consents.kai.granted && prefs.consents.kaiJournal.granted;
  const hasPrompts = PROMPTS.some((p) => prompts[p.key].trim() !== '');

  return (
    <form
      className="journal-editor stack-lg"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
          e.preventDefault();
          void save();
        }
      }}
    >
      <div className="panel stack">
        <TextArea
          label="Escrita livre"
          value={text}
          onChange={setText}
          inputClassName="is-main"
          maxLength={20000}
          placeholder="Como foi o dia? O que você fez, sentiu ou percebeu?"
          hint="Atalho: Ctrl+S (ou ⌘S) salva."
        />
        <details className="explain" open={hasPrompts || undefined}>
          <summary>Reflexão guiada (opcional)</summary>
          <div className="stack" style={{ paddingTop: 4 }}>
            {PROMPTS.map((p) => (
              <TextArea key={p.key} label={p.label} optional value={prompts[p.key]} onChange={(v) => setPrompts({ ...prompts, [p.key]: v })} maxLength={2000} rows={2} />
            ))}
          </div>
        </details>
      </div>

      {(options.dayHabits.length > 0 || options.dayGoals.length > 0 || options.dayItems.length > 0) && (
        <div className="panel stack">
          <p className="field-label">Relacionar a esta reflexão (opcional)</p>
          {options.dayHabits.length > 0 && (
            <fieldset>
              <legend className="meta" style={{ fontWeight: 500 }}>
                Hábitos do dia
              </legend>
              <div className="chips">
                {options.dayHabits.map((h) => (
                  <button key={h.id} type="button" className="chip" aria-pressed={links.habitIds.includes(h.id)} onClick={() => toggleLink('habitIds', h.id)}>
                    {h.title}
                  </button>
                ))}
              </div>
            </fieldset>
          )}
          {options.dayGoals.length > 0 && (
            <fieldset>
              <legend className="meta" style={{ fontWeight: 500 }}>
                Metas em andamento
              </legend>
              <div className="chips">
                {options.dayGoals.map((g) => (
                  <button key={g.id} type="button" className="chip" aria-pressed={links.goalIds.includes(g.id)} onClick={() => toggleLink('goalIds', g.id)}>
                    {g.title}
                  </button>
                ))}
              </div>
            </fieldset>
          )}
          {options.dayItems.length > 0 && (
            <fieldset>
              <legend className="meta" style={{ fontWeight: 500 }}>
                Agenda do dia
              </legend>
              <div className="chips">
                {options.dayItems.map((o) => (
                  <button key={o.key} type="button" className="chip" aria-pressed={links.agendaItemIds.includes(o.itemId)} onClick={() => toggleLink('agendaItemIds', o.itemId)}>
                    {o.title}
                  </button>
                ))}
              </div>
            </fieldset>
          )}
        </div>
      )}

      <div className="panel">
        {kaiConsent ? (
          <SwitchRow
            label="Permitir que o Kai leia esta entrada"
            description={isClaudeRuntime() ? 'Você autorizou o Kai a ler trechos do Diário. Desligue aqui para que esta entrada nunca vá ao Kai.' : 'Você autorizou o Kai a ler trechos do Diário. Desligue aqui para manter esta entrada só no aparelho.'}
            checked={kaiAccess === 'allowed'}
            onChange={(v) => setKaiAccess(v ? 'allowed' : 'blocked')}
          />
        ) : (
          <div className="row" style={{ alignItems: 'flex-start', gap: 12 }}>
            <Lock size={18} aria-hidden="true" style={{ marginTop: 3 }} />
            <p className="small">
              <strong>O Kai não lê o seu Diário.</strong> Sem a autorização específica do Diário, nada daqui sai do aparelho.{' '}
              <Link to="/configuracoes#autorizacoes">Gerenciar autorizações</Link>
            </p>
          </div>
        )}
        {kaiConsent && kaiAccess === 'allowed' && (
          <p className="meta" style={{ marginTop: 4 }}>
            <LockOpen size={12} aria-hidden="true" style={{ display: 'inline' }} /> Até 600 caracteres desta entrada podem ir ao Kai, só quando você pedir uma análise que inclua esta data.
          </p>
        )}
      </div>

      {error && (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      )}
      <div className="row-between">
        <p className="meta" role="status">
          {dirty ? 'Alterações não salvas' : savedAt ? `Salvo em ${formatInstant(savedAt, timezone)}` : 'Nada escrito ainda'}
        </p>
        <div className="btn-row">
          {entry && (
            <Button variant="ghost" icon={<Trash size={18} aria-hidden="true" />} onClick={() => setConfirmDelete(true)}>
              Excluir entrada
            </Button>
          )}
          <Button type="submit" variant="primary" busy={saving} disabled={!dirty}>
            Salvar
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Excluir entrada do Diário?"
        danger
        confirmLabel="Excluir"
        message={<p className="small">A entrada de {formatLongDate(date, true)} será apagada{isClaudeRuntime() ? ' (em todos os seus aparelhos)' : ' deste aparelho'}. Não dá para desfazer (a menos que você tenha um backup).</p>}
        onConfirm={async () => {
          if (!entry) return;
          try {
            await deleteJournalEntry(entry.id);
            setText('');
            setPrompts({ didToday: '', whatWorked: '', toImprove: '', nextStep: '' });
            setLinks({ habitIds: [], goalIds: [], agendaItemIds: [] });
            setSavedAt(undefined);
            toast.show('Entrada excluída.');
          } catch (e) {
            toast.show(describeError(e), { tone: 'danger' });
          }
          setConfirmDelete(false);
        }}
      />
    </form>
  );
}
