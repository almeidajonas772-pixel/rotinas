import { Activity, ArrowLeft, Check, Compass, HardDrive, Pencil, Plus, ShieldCheck, Trash, Upload } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { BrandMark } from '../../app/Shell';
import { Dialog } from '../../components/dialog';
import { SelectField, Segmented, SwitchRow, TextField } from '../../components/form';
import { useToast } from '../../components/toast';
import { Button, Notice, Tag } from '../../components/ui';
import { parseBackup, restoreBackup, TABLE_LABEL, type ParsedBackup, type BackupTableName } from '../../db/backup';
import { decidedConsent, defaultPreferences, HABIT_CATEGORIES } from '../../db/defaults';
import { describeError } from '../../db/errors';
import type { HabitDraft } from '../../db/repo-habits';
import { completeOnboarding, updatePrefs } from '../../db/repo-profile';
import { nowTimeInZone, todayInZone } from '../../domain/civil';
import { formatLongDate } from '../../domain/format';
import { buildKaiContext } from '../../domain/kai-context';
import { describeSchedule, describeTiming } from '../../domain/schedule';
import type { DayPeriod, Preferences, Profile } from '../../domain/schemas';
import { guessTimeZone, listTimeZones, zoneOffsetLabel } from '../../domain/tz';
import { callKai } from '../../lib/api';
import { goToToday, readFileAsText, requestPersistentStorage } from '../../lib/browser';
import { requestNotificationPermission } from '../../lib/notifications';
import { isClaudeRuntime } from '../../platform/runtime';
import { draftFromTemplate, emptyHabitDraft, HABIT_TEMPLATES, validateHabitDraft } from '../habits/draft';
import { HabitEditor } from '../habits/HabitEditor';
import { ConsentDetails } from '../privacy/ConsentDialog';

const STEPS = ['Boas-vindas', 'Perfil', 'Objetivo e tempo', 'Lembretes', 'Autorizações', 'Primeira rotina', 'Revisão'] as const;

interface KaiSuggestion {
  draft: HabitDraft;
  rationale: string;
  status: 'pending' | 'added' | 'discarded';
}

export function Onboarding({ existing }: { existing: Profile | null }) {
  const toast = useToast();
  const claude = isClaudeRuntime();
  const [step, setStep] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const [name, setName] = useState(existing?.name ?? '');
  const [timezone, setTimezone] = useState(existing?.timezone ?? guessTimeZone());
  const [weekStartsOn, setWeekStartsOn] = useState<'1' | '0'>('1');
  const [mainGoal, setMainGoal] = useState(existing?.mainGoal ?? '');
  const [periods, setPeriods] = useState<DayPeriod[]>(existing?.availability.periods ?? []);
  const [minutes, setMinutes] = useState<string>(existing?.availability.minutesPerDay ? String(existing.availability.minutesPerDay) : '');
  const [reminders, setReminders] = useState(false);
  const [quietStart, setQuietStart] = useState('22:00');
  const [quietEnd, setQuietEnd] = useState('07:00');
  const [checkins, setCheckins] = useState(false);
  const [kai, setKai] = useState(false);
  const [kaiCheckins, setKaiCheckins] = useState(false);
  const [kaiJournal, setKaiJournal] = useState(false);
  const [habits, setHabits] = useState<HabitDraft[]>([]);
  const [editing, setEditing] = useState<{ index: number | 'new'; draft: HabitDraft; errors: Record<string, string> } | null>(null);
  const [suggestions, setSuggestions] = useState<KaiSuggestion[]>([]);
  const [kaiState, setKaiState] = useState<{ status: 'idle' | 'loading' | 'error' | 'done'; message?: string }>({ status: 'idle' });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [restore, setRestore] = useState<{ backup?: ParsedBackup; errors?: string[]; busy?: boolean } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const zones = useMemo(() => listTimeZones(), []);
  const today = todayInZone(timezone);

  useEffect(() => {
    headingRef.current?.focus();
  }, [step]);

  const draftPrefs = (): Preferences => {
    const now = new Date().toISOString();
    const base = defaultPreferences(now);
    return {
      ...base,
      features: { checkins },
      consents: {
        ...base.consents,
        kai: decidedConsent('kai', kai, now),
        kaiCheckins: decidedConsent('kaiCheckins', kai && checkins && kaiCheckins, now),
        kaiJournal: decidedConsent('kaiJournal', kai && kaiJournal, now),
      },
    };
  };

  const availability = { periods, minutesPerDay: minutes ? Number(minutes) : undefined, windows: [] };

  async function askKaiForPlan() {
    setKaiState({ status: 'loading' });
    try {
      const prefs = draftPrefs();
      const now = new Date().toISOString();
      const profile: Profile = { id: 'me', timezone, mainGoal: mainGoal.trim() || undefined, availability, createdAt: now, updatedAt: now };
      const built = buildKaiContext(
        {
          today,
          profile,
          prefs,
          habits: [],
          completions: [],
          goals: [],
          goalCtx: { goals: [], habits: [], agendaItems: [], habitCompletions: [], agendaCompletions: [], progressEntries: [] },
          checkins: [],
          journal: [],
        },
        { includeGoals: false },
      );
      const res = await callKai('plan', { context: built.context, objective: mainGoal.trim() || 'Organizar minha rotina com hábitos simples', maxHabits: 4 }, prefs);
      if (!res.ok) {
        setKaiState({ status: 'error', message: res.error.message });
        return;
      }
      setSuggestions(
        res.data.habits.map((h) => ({
          rationale: h.rationale,
          status: 'pending',
          draft: {
            ...emptyHabitDraft(today),
            title: h.title.slice(0, 80),
            description: h.description.slice(0, 500),
            category: (HABIT_CATEGORIES as readonly string[]).includes(h.category) ? h.category : 'Outro',
            schedule: h.scheduleKind === 'weekly' && h.days.length > 0 ? { kind: 'weekly', days: [...new Set(h.days)].sort((a, b) => a - b) } : { kind: 'daily' },
            timing: h.time ? { kind: 'time', time: h.time } : { kind: 'anytime' },
            durationMinutes: h.durationMinutes ?? undefined,
            xp: Math.min(100, Math.max(1, Math.round(h.xp))),
            firstStep: h.firstStep.slice(0, 200),
          },
        })),
      );
      setKaiState({ status: 'done' });
    } catch (error) {
      setKaiState({ status: 'error', message: error instanceof Error ? error.message : 'Não foi possível falar com o Kai.' });
    }
  }

  function saveEditing() {
    if (!editing) return;
    const errors = validateHabitDraft(editing.draft, today);
    if (Object.keys(errors).length > 0) {
      setEditing({ ...editing, errors });
      return;
    }
    if (editing.index === 'new') setHabits([...habits, editing.draft]);
    else setHabits(habits.map((h, i) => (i === editing.index ? editing.draft : h)));
    setEditing(null);
  }

  async function finish() {
    // Pedido de permissão feito já no clique de "Salvar e começar" (depois do opt-in explícito na
    // etapa Lembretes): iPhone/iPad só mostram o diálogo quando ele nasce diretamente do toque.
    const permissionRequest = reminders ? requestNotificationPermission() : null;
    setSaving(true);
    setSaveError(undefined);
    try {
      await completeOnboarding({
        name,
        timezone,
        mainGoal,
        availability,
        weekStartsOn: weekStartsOn === '1' ? 1 : 0,
        checkins,
        notifications: { wanted: reminders, quietStart, quietEnd },
        consents: { kai, kaiCheckins, kaiJournal },
        habits: habits.map((h) => ({ ...h, startDate: h.startDate < today ? today : h.startDate })),
        today,
      });
      // Depois da configuração, o app abre sempre na tela Hoje.
      goToToday();
      void requestPersistentStorage();
      if (permissionRequest) {
        const permission = await permissionRequest;
        if (permission === 'granted') {
          await updatePrefs((p) => ({ ...p, notifications: { ...p.notifications, channel: 'local' } }));
        } else {
          toast.show('As notificações não foram permitidas pelo navegador. Você pode tentar de novo em Configurações.');
        }
      }
    } catch (error) {
      setSaveError(describeError(error));
      setSaving(false);
    }
  }

  async function onPickBackup(file: File | undefined) {
    if (!file) return;
    try {
      const text = await readFileAsText(file);
      const parsed = parseBackup(text);
      setRestore(parsed.ok ? { backup: parsed.backup } : { errors: parsed.errors });
    } catch {
      setRestore({ errors: ['Não foi possível ler o arquivo.'] });
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function confirmRestore() {
    if (!restore?.backup) return;
    setRestore({ ...restore, busy: true });
    try {
      await restoreBackup(restore.backup);
      goToToday();
      toast.show('Backup restaurado.');
    } catch (error) {
      setRestore({ errors: [describeError(error)] });
    }
  }

  const canNext = (() => {
    if (step === 1) return Boolean(timezone);
    return true;
  })();

  const pendingSuggestions = suggestions.filter((s) => s.status === 'pending');

  return (
    <div className="onboarding">
      <div className="onboarding-top">
        <span className="brand" style={{ padding: 0 }}>
          <BrandMark />
          Rotinas
        </span>
        {step > 0 && (
          <div className="steps" aria-hidden="true">
            {STEPS.slice(1).map((label, i) => (
              <span key={label} className={i + 1 < step ? 'is-done' : i + 1 === step ? 'is-current' : ''} />
            ))}
          </div>
        )}
      </div>

      <main className="page" style={{ flex: 1 }}>
        {step > 0 && (
          <p className="meta" style={{ marginBottom: 8 }}>
            Etapa {step} de {STEPS.length - 1}
          </p>
        )}

        {step === 0 && (
          <div className="stack-lg">
            <h1 className="welcome-title" tabIndex={-1} ref={headingRef}>
              Sua rotina, do seu jeito.
            </h1>
            <p className="page-subtitle" style={{ fontSize: '1.125rem', maxWidth: '52ch' }}>
              {claude
                ? 'Organize hábitos, metas, agenda e reflexões em um só lugar. Sem cadastro extra e sem custo: tudo fica salvo na sua conta do Claude.'
                : 'Organize hábitos, metas, agenda e reflexões em um só lugar. Sem conta e sem login: tudo fica salvo neste navegador.'}
            </p>
            <ul className="welcome-points" role="list">
              <li>
                <HardDrive size={20} aria-hidden="true" />
                <div>
                  <h2>{claude ? 'Seus dados ficam na sua conta' : 'Seus dados ficam aqui'}</h2>
                  <p className="small muted">
                    {claude
                      ? 'Numa área privada da sua conta do Claude neste app — os mesmos no iPad e no computador. Faça backups em Configurações quando quiser.'
                      : 'Tudo fica no armazenamento local deste navegador (IndexedDB) e funciona sem internet. Faça backups em Configurações.'}
                  </p>
                </div>
              </li>
              <li>
                <ShieldCheck size={20} aria-hidden="true" />
                <div>
                  <h2>{claude ? 'Você decide o que vai ao Kai e ao Google' : 'Você decide o que sai do aparelho'}</h2>
                  <p className="small muted">
                    {claude
                      ? 'O Kai (pelo seu plano do Claude) e o Google Agenda (pelo conector do Claude) são opcionais e só funcionam depois de autorizações específicas, uma para cada tipo de dado.'
                      : 'O assistente Kai e o Google Calendar são opcionais e só funcionam depois de autorizações específicas, uma para cada tipo de dado.'}
                  </p>
                </div>
              </li>
              <li>
                <Activity size={20} aria-hidden="true" />
                <div>
                  <h2>Números de verdade</h2>
                  <p className="small muted">Progresso, sequências e XP vêm só do que você registra. Sem registros, o app diz isso em vez de mostrar números de enfeite.</p>
                </div>
              </li>
            </ul>
            <div className="btn-row">
              <Button variant="primary" onClick={() => setStep(1)}>
                Começar a configuração
              </Button>
              <Button icon={<Upload size={18} aria-hidden="true" />} onClick={() => fileRef.current?.click()}>
                Restaurar um backup
              </Button>
              <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(e) => void onPickBackup(e.target.files?.[0])} />
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="stack-lg">
            <div>
              <h1 className="page-title" tabIndex={-1} ref={headingRef}>
                {claude ? 'Perfil' : 'Perfil local'}
              </h1>
              <p className="page-subtitle">{claude ? 'Fica na sua conta do Claude, só para você. Nenhum cadastro extra é criado.' : 'Fica só neste aparelho. Nenhum cadastro é criado.'}</p>
            </div>
            <div className="panel">
              <TextField label="Como quer ser chamado?" optional value={name} onChange={setName} maxLength={60} autoComplete="given-name" hint="Usado só para saudações no app. Nunca é enviado ao Kai." />
              <SelectField label="Idioma" value="pt-BR" onChange={() => undefined} options={[{ value: 'pt-BR', label: 'Português (Brasil)' }]} hint="Único idioma disponível nesta versão." />
              <SelectField
                label="Fuso horário"
                value={timezone}
                onChange={setTimezone}
                options={zones.map((z) => ({ value: z, label: z.replace(/_/g, ' ') }))}
                hint={`Agora são ${nowTimeInZone(timezone)} (${zoneOffsetLabel(timezone)}) nesse fuso — hoje é ${formatLongDate(today)}. É ele que define o “hoje” dos seus hábitos.`}
              />
              <div style={{ marginTop: 16 }}>
                <Segmented
                  label="A semana começa em"
                  value={weekStartsOn}
                  options={[
                    { value: '1', label: 'Segunda-feira' },
                    { value: '0', label: 'Domingo' },
                  ]}
                  onChange={setWeekStartsOn}
                />
              </div>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="stack-lg">
            <div>
              <h1 className="page-title" tabIndex={-1} ref={headingRef}>
                Objetivo e tempo disponível
              </h1>
              <p className="page-subtitle">Ajuda a montar uma rotina que caiba no seu dia. Tudo é opcional.</p>
            </div>
            <div className="panel">
              <TextField label="Objetivo principal" optional value={mainGoal} onChange={setMainGoal} maxLength={200} placeholder="Ex.: Estudar com constância e dormir melhor" />
              <fieldset style={{ marginTop: 16 }}>
                <legend>Quando você costuma ter tempo livre?</legend>
                <div className="chips">
                  {(
                    [
                      ['manha', 'Manhã'],
                      ['tarde', 'Tarde'],
                      ['noite', 'Noite'],
                    ] as Array<[DayPeriod, string]>
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      className="chip"
                      aria-pressed={periods.includes(value)}
                      onClick={() => setPeriods(periods.includes(value) ? periods.filter((p) => p !== value) : [...periods, value])}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </fieldset>
              <SelectField
                label="Tempo por dia para hábitos"
                optional
                value={minutes}
                onChange={setMinutes}
                options={[
                  { value: '', label: 'Prefiro não dizer' },
                  ...[15, 30, 45, 60, 90, 120, 180].map((m) => ({ value: String(m), label: m < 60 ? `${m} minutos` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` })),
                ]}
              />
              <p className="field-hint" style={{ marginTop: 8 }}>
                Horários exatos por dia da semana podem ser definidos depois em Configurações → Perfil.
              </p>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="stack-lg">
            <div>
              <h1 className="page-title" tabIndex={-1} ref={headingRef}>
                Lembretes
              </h1>
              <p className="page-subtitle">
                {claude ? 'Dentro do Claude, os lembretes vêm do Google Agenda — que avisa no celular, no iPad e no computador.' : 'Lembretes são notificações deste aparelho, sem envio de dados. Você liga por hábito.'}
              </p>
            </div>
            {claude ? (
              <div className="panel stack small">
                <p>O Claude não deixa apps dentro dele mostrarem notificações. Por isso, sem custo nenhum, o Rotinas usa o seu Google Agenda:</p>
                <ul>
                  <li>
                    <strong>Lembrete da noite:</strong> em Noite → Ajustes, o app cria um evento diário com notificação na hora.
                  </li>
                  <li>
                    <strong>Hábitos:</strong> em Calendário externo, o app planeja horários livres e cria os blocos no Google, com os lembretes da sua agenda.
                  </li>
                </ul>
                <p className="muted">Você configura isso depois da configuração inicial. Nada é criado sem a sua confirmação.</p>
              </div>
            ) : (
            <div className="panel">
              <SwitchRow
                label="Quero receber lembretes"
                description="O navegador vai pedir permissão quando você concluir a configuração. Os lembretes disparam com o app aberto (aba ou app instalado)."
                checked={reminders}
                onChange={setReminders}
              />
              <div className="field-row" style={{ marginTop: 8 }}>
                <TextField label="Silêncio a partir de" type="time" value={quietStart} onChange={setQuietStart} />
                <TextField label="Silêncio até" type="time" value={quietEnd} onChange={setQuietEnd} />
              </div>
              <p className="field-hint" style={{ marginTop: 8 }}>
                Nenhum lembrete é mostrado nesse intervalo. Dias permitidos e limite diário ficam em Configurações.
              </p>
            </div>
            )}
          </div>
        )}

        {step === 4 && (
          <div className="stack-lg">
            <div>
              <h1 className="page-title" tabIndex={-1} ref={headingRef}>
                Autorizações opcionais
              </h1>
              <p className="page-subtitle">Tudo começa desligado. Recusar não limita o uso local: hábitos, metas, agenda, diário e relatórios funcionam do mesmo jeito.</p>
            </div>
            <div className="panel">
              <SwitchRow
                label="Check-in diário de humor e energia"
                description={
                  claude
                    ? 'Duas escalas de 1 a 5 e uma nota, quando você quiser. Serve para você notar padrões ao longo do tempo; não é avaliação de saúde. Só vai ao Kai com autorização própria.'
                    : 'Duas escalas de 1 a 5 e uma nota, quando você quiser. Serve para você notar padrões ao longo do tempo; não é avaliação de saúde. Fica só neste aparelho.'
                }
                checked={checkins}
                onChange={(v) => {
                  setCheckins(v);
                  if (!v) setKaiCheckins(false);
                }}
              />
            </div>
            <div className="panel">
              <SwitchRow label="Coaching por IA (Kai)" description={claude ? 'Usa o Claude da sua conta, sem custo extra. Envia dados mínimos somente quando você pede algo ao Kai.' : 'Envia dados mínimos ao provedor de IA somente quando você pede algo ao Kai.'} checked={kai} onChange={(v) => {
                setKai(v);
                if (!v) {
                  setKaiCheckins(false);
                  setKaiJournal(false);
                }
              }} />
              <details className="explain" style={{ marginTop: 8 }}>
                <summary>Ver exatamente o que o Kai recebe</summary>
                <ConsentDetails consent="kai" />
              </details>
              {kai && (
                <div style={{ marginTop: 12 }}>
                  <SwitchRow
                    label="Incluir check-ins no Kai"
                    description={checkins ? 'Só as notas de humor e energia do período analisado.' : 'Ative o check-in diário acima para poder incluir.'}
                    checked={kaiCheckins}
                    disabled={!checkins}
                    onChange={setKaiCheckins}
                  />
                  <SwitchRow label="Permitir que o Kai leia trechos do Diário" description="Autorização separada. Você ainda pode marcar entradas específicas como privadas." checked={kaiJournal} onChange={setKaiJournal} />
                  <Notice tone="info">
                    {claude
                      ? 'O Kai funciona com o seu plano do Claude. Na primeira vez, o Claude pergunta se o Rotinas pode usá-lo — escolha “Permitir”.'
                      : 'O Kai precisa da camada privada (servidor do Rotinas) configurada com uma chave da Anthropic. Sem ela, o app avisa que o Kai está indisponível — e todo o resto continua funcionando.'}
                  </Notice>
                </div>
              )}
            </div>
            <div className="panel">
              <p className="switch-label">{claude ? 'Google Agenda' : 'Google Calendar'}</p>
              <p className="meta" style={{ marginTop: 4 }}>
                {claude ? (
                  <>
                    Opcional, feito depois em <strong>Calendário externo</strong>: o Rotinas usa o conector do Google Calendar do seu Claude (sem Google Cloud e sem custo). A agenda do Rotinas funciona sem ele.
                  </>
                ) : (
                  <>
                    Conexão opcional, feita depois em <strong>Calendário externo</strong>. Antes de conectar, o app mostra os dados acessados e pede os menores escopos possíveis. A agenda do Rotinas funciona sem ele.
                  </>
                )}
              </p>
            </div>
          </div>
        )}

        {step === 5 && (
          <div className="stack-lg">
            <div>
              <h1 className="page-title" tabIndex={-1} ref={headingRef}>
                Primeira rotina
              </h1>
              <p className="page-subtitle">Comece pequeno: dois ou três hábitos bastam. Nada é salvo até a revisão.</p>
            </div>

            {kai && (
              <div className="panel stack">
                <div className="row-between">
                  <div>
                    <p className="switch-label">Rascunho sugerido pelo Kai</p>
                    <p className="meta">Baseado no seu objetivo e disponibilidade. Você revisa cada hábito antes de adicionar.</p>
                  </div>
                  <Button icon={<Compass size={18} aria-hidden="true" />} onClick={() => void askKaiForPlan()} busy={kaiState.status === 'loading'}>
                    {suggestions.length > 0 ? 'Pedir outro rascunho' : 'Pedir rascunho ao Kai'}
                  </Button>
                </div>
                {kaiState.status === 'loading' && <p className="meta" role="status">Consultando o Kai…</p>}
                {kaiState.status === 'error' && (
                  <Notice tone="warn" title="O Kai não respondeu" role="alert">
                    {kaiState.message} Você pode montar a rotina manualmente abaixo.
                  </Notice>
                )}
                {pendingSuggestions.length > 0 && (
                  <ul className="review-list" role="list">
                    {suggestions.map((s, i) =>
                      s.status !== 'pending' ? null : (
                        <li key={i} className="review-item">
                          <div className="grow">
                            <p className="row-title">
                              {s.draft.title} <Tag tone="accent">Sugestão do Kai</Tag>
                            </p>
                            <p className="row-meta">
                              <span>{describeSchedule(s.draft.schedule)}</span>
                              <span>{describeTiming(s.draft.timing)}</span>
                            </p>
                            <p className="small muted" style={{ marginTop: 4 }}>
                              {s.rationale}
                            </p>
                            <div className="btn-row" style={{ marginTop: 8 }}>
                              <Button
                                size="sm"
                                variant="primary"
                                icon={<Plus size={16} aria-hidden="true" />}
                                onClick={() => {
                                  setHabits([...habits, s.draft]);
                                  setSuggestions(suggestions.map((x, j) => (j === i ? { ...x, status: 'added' } : x)));
                                }}
                              >
                                Adicionar
                              </Button>
                              <Button
                                size="sm"
                                icon={<Pencil size={16} aria-hidden="true" />}
                                onClick={() => {
                                  setSuggestions(suggestions.map((x, j) => (j === i ? { ...x, status: 'added' } : x)));
                                  setEditing({ index: 'new', draft: s.draft, errors: {} });
                                }}
                              >
                                Editar antes
                              </Button>
                              <Button size="sm" variant="ghost" onClick={() => setSuggestions(suggestions.map((x, j) => (j === i ? { ...x, status: 'discarded' } : x)))}>
                                Descartar
                              </Button>
                            </div>
                          </div>
                        </li>
                      ),
                    )}
                  </ul>
                )}
              </div>
            )}

            <div className="panel stack">
              <p className="switch-label">Modelos para começar</p>
              <p className="meta">Toque para abrir já preenchido; ajuste o que quiser.</p>
              <div className="template-grid">
                {HABIT_TEMPLATES.map((t) => (
                  <button key={t.title} type="button" className="template" onClick={() => setEditing({ index: 'new', draft: draftFromTemplate(t, today), errors: {} })}>
                    <span className="row-title">{t.title}</span>
                    <span className="meta">
                      {t.category}, {describeSchedule(t.schedule).toLowerCase()}
                    </span>
                  </button>
                ))}
              </div>
              <Button icon={<Plus size={18} aria-hidden="true" />} onClick={() => setEditing({ index: 'new', draft: emptyHabitDraft(today), errors: {} })}>
                Criar do zero
              </Button>
            </div>

            <div>
              <h2 className="section-title" style={{ marginBottom: 8 }}>
                Sua rotina ({habits.length})
              </h2>
              {habits.length === 0 ? (
                <p className="meta">Nenhum hábito ainda. Você também pode começar sem hábitos e criar depois.</p>
              ) : (
                <ul className="list" role="list">
                  {habits.map((h, i) => (
                    <li key={i} className="list-row">
                      <div className="row-main">
                        <span className="row-title">{h.title}</span>
                        <span className="row-meta">
                          <span>{describeSchedule(h.schedule)}</span>
                          <span>{describeTiming(h.timing)}</span>
                          <span>{h.xp} XP</span>
                        </span>
                      </div>
                      <button type="button" className="icon-btn" aria-label={`Editar ${h.title}`} onClick={() => setEditing({ index: i, draft: h, errors: {} })}>
                        <Pencil size={18} aria-hidden="true" />
                      </button>
                      <button type="button" className="icon-btn" aria-label={`Remover ${h.title}`} onClick={() => setHabits(habits.filter((_, j) => j !== i))}>
                        <Trash size={18} aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        {step === 6 && (
          <div className="stack-lg">
            <div>
              <h1 className="page-title" tabIndex={-1} ref={headingRef}>
                Revisão
              </h1>
              <p className="page-subtitle">Confira antes de salvar. Tudo pode ser mudado depois em Configurações.</p>
            </div>
            <div className="panel">
              <dl className="kv">
                <dt>Nome</dt>
                <dd>{name.trim() || 'Não informado'}</dd>
                <dt>Fuso horário</dt>
                <dd>{timezone}</dd>
                <dt>Semana começa</dt>
                <dd>{weekStartsOn === '1' ? 'Segunda-feira' : 'Domingo'}</dd>
                <dt>Objetivo</dt>
                <dd>{mainGoal.trim() || 'Não informado'}</dd>
                <dt>Tempo livre</dt>
                <dd>{periods.length ? periods.map((p) => ({ manha: 'manhã', tarde: 'tarde', noite: 'noite' })[p]).join(', ') : 'Não informado'}{minutes ? `, ${minutes} min/dia` : ''}</dd>
                <dt>Lembretes</dt>
                <dd>{reminders ? `Sim, silêncio das ${quietStart} às ${quietEnd}` : 'Não'}</dd>
                <dt>Check-in</dt>
                <dd>{checkins ? 'Ativado (só local)' : 'Desativado'}</dd>
                <dt>Kai</dt>
                <dd>{kai ? `Autorizado${kaiCheckins ? ', com check-ins' : ''}${kaiJournal ? ', com trechos do Diário' : ''}` : 'Desativado'}</dd>
              </dl>
            </div>
            <div>
              <h2 className="section-title" style={{ marginBottom: 8 }}>
                Hábitos a criar ({habits.length})
              </h2>
              {habits.length === 0 ? (
                <p className="meta">Nenhum. Você verá a tela Hoje vazia, com atalhos para criar o primeiro hábito.</p>
              ) : (
                <ul className="review-list" role="list">
                  {habits.map((h, i) => (
                    <li key={i} className="review-item">
                      <Check size={18} aria-hidden="true" style={{ marginTop: 3, color: 'var(--accent)' }} />
                      <div className="grow">
                        <p className="row-title">{h.title}</p>
                        <p className="row-meta">
                          <span>{h.category}</span>
                          <span>{describeSchedule(h.schedule)}</span>
                          <span>{describeTiming(h.timing)}</span>
                        </p>
                        {h.firstStep && <p className="meta">Primeiro passo: {h.firstStep}</p>}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {saveError && (
              <Notice tone="danger" title="Não foi possível salvar" role="alert">
                {saveError}
              </Notice>
            )}
          </div>
        )}
      </main>

      {step > 0 && (
        <div className="onboarding-foot">
          <div className="inner">
            <Button variant="ghost" icon={<ArrowLeft size={18} aria-hidden="true" />} onClick={() => setStep(step - 1)} disabled={saving}>
              Voltar
            </Button>
            {step < STEPS.length - 1 ? (
              <Button variant="primary" onClick={() => setStep(step + 1)} disabled={!canNext}>
                Continuar
              </Button>
            ) : (
              <Button variant="primary" onClick={() => void finish()} busy={saving}>
                Salvar e começar
              </Button>
            )}
          </div>
        </div>
      )}

      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing?.index === 'new' ? 'Novo hábito' : 'Editar hábito'}
        footer={
          <>
            <Button onClick={() => setEditing(null)}>Cancelar</Button>
            <Button variant="primary" onClick={saveEditing}>
              {editing?.index === 'new' ? 'Adicionar à rotina' : 'Salvar alterações'}
            </Button>
          </>
        }
      >
        {editing && <HabitEditor draft={editing.draft} onChange={(draft) => setEditing({ ...editing, draft })} errors={editing.errors} today={today} />}
      </Dialog>

      <Dialog
        open={restore !== null}
        onClose={() => setRestore(null)}
        title="Restaurar backup"
        footer={
          restore?.backup ? (
            <>
              <Button onClick={() => setRestore(null)}>Cancelar</Button>
              <Button variant="primary" busy={restore.busy} onClick={() => void confirmRestore()}>
                Restaurar
              </Button>
            </>
          ) : (
            <Button onClick={() => setRestore(null)}>Fechar</Button>
          )
        }
      >
        {restore?.errors && (
          <Notice tone="danger" title="Este arquivo não pode ser restaurado" role="alert">
            <ul>
              {restore.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </Notice>
        )}
        {restore?.backup && (
          <div className="stack">
            <p>Backup de {new Date(restore.backup.exportedAt).toLocaleString('pt-BR')}. Conteúdo:</p>
            <ul className="small">
              {(Object.entries(restore.backup.counts) as Array<[BackupTableName, number]>)
                .filter(([, n]) => n > 0)
                .map(([k, n]) => (
                  <li key={k}>
                    {TABLE_LABEL[k]}: {n}
                  </li>
                ))}
            </ul>
            {restore.backup.warnings.map((w) => (
              <Notice key={w} tone="warn">
                {w}
              </Notice>
            ))}
          </div>
        )}
      </Dialog>
    </div>
  );
}
