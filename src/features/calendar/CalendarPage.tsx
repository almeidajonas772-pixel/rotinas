import { CalendarCheck, Eye, Link2, RotateCcw, Search, Unlink } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { APP_CALENDAR_NAME, GOOGLE_EVENT_COLORS, GOOGLE_SCOPES, type CalendarAccess, type CalendarBlock, type CalendarCommitResult } from '../../../shared/calendar';
import { useApp } from '../../app/context';
import { ConfirmDialog, Dialog } from '../../components/dialog';
import { CheckField, SelectField, TextField } from '../../components/form';
import { useToast } from '../../components/toast';
import { Button, LoadingState, Notice, PageHeader, Section, Tag } from '../../components/ui';
import { useAgendaItems, useHabits, useIntegration } from '../../db/hooks';
import { describeError } from '../../db/errors';
import { createAgendaItem, setExternalRef } from '../../db/repo-agenda';
import { clearIntegration, setIntegration } from '../../db/repo-misc';
import { setConsent } from '../../db/repo-profile';
import { expandAgenda } from '../../domain/agenda';
import { addDays, eachDay, minutesToTime, timeToMinutes, type CivilDate } from '../../domain/civil';
import { formatDuration, formatInstant, formatLongDate, formatShortDate, weekdayShort } from '../../domain/format';
import { googleEventDays } from '../../domain/nightly';
import { isScheduledOn } from '../../domain/schedule';
import { conflictsFor, proposeSlots, type BusyInterval, type SlotProposal } from '../../domain/slots';
import { wallTimeToInstant } from '../../domain/tz';
import { calendarCommit, calendarDisconnect, calendarFreeBusy, calendarPreview } from '../../lib/api';
import { ConsentDetails, ConsentDialog } from '../privacy/ConsentDialog';
import { clearGoogleEventsCache, useCalendarStatus, useConnectLinks, useGoogleEvents } from './calendar-client';

/** Link que abre a autorização do Google numa aba/janela própria (no iPad instalado, numa folha do Safari). */
function ConnectLink({ href, variant = 'secondary', icon, children }: { href?: string; variant?: 'primary' | 'secondary'; icon: ReactNode; children: ReactNode }) {
  if (!href) {
    return (
      <Button variant={variant} icon={icon} disabled>
        {children}
      </Button>
    );
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={`btn btn-${variant}`}>
      {icon}
      {children}
    </a>
  );
}

interface PlanRow extends SlotProposal {
  include: boolean;
}

export function CalendarPage() {
  const { prefs, today, timezone, profile } = useApp();
  const toast = useToast();
  const habits = useHabits();
  const items = useAgendaItems();
  const integration = useIntegration();
  const [params, setParams] = useSearchParams();
  const [status, refresh] = useCalendarStatus();
  const [asking, setAsking] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [habitId, setHabitId] = useState(params.get('habito') ?? '');
  const [days, setDays] = useState('7');
  const [duration, setDuration] = useState('30');
  const [rows, setRows] = useState<PlanRow[] | null>(null);
  const [busy, setBusy] = useState<BusyInterval[]>([]);
  const [planning, setPlanning] = useState(false);
  const [planNote, setPlanNote] = useState<string>();
  const [alsoGoogle, setAlsoGoogle] = useState(false);
  const [googlePreview, setGooglePreview] = useState<{ previewToken: string; blocks: CalendarBlock[]; conflicts: Array<Array<{ start: string; end: string }>> } | null>(null);
  const [committing, setCommitting] = useState(false);

  const google = status.state === 'ok' ? status.status : undefined;
  const canRead = Boolean(google?.connected && google.canReadAvailability);
  const canWrite = Boolean(google?.connected && google.canWrite);
  const canReadEvents = Boolean(google?.connected && google.canReadEvents);
  const levels: CalendarAccess[] = !google?.configured
    ? []
    : !google.connected
      ? ['availability', 'events']
      : ([!google.canReadEvents && 'events', !google.canWrite && 'write'].filter(Boolean) as CalendarAccess[]);
  const { links, error: linkError } = useConnectLinks(levels, levels.length > 0);
  const [events, refreshEvents] = useGoogleEvents(today, addDays(today, 6), canReadEvents);

  // Retorno do fluxo OAuth (o servidor redireciona para #/calendario?status=…).
  useEffect(() => {
    const s = params.get('status');
    if (!s) return;
    if (s === 'conectado') toast.show('Google Calendar conectado.');
    else toast.show(`Conexão não concluída: ${params.get('motivo') ?? 'tente de novo.'}`, { tone: 'danger' });
    const next = new URLSearchParams(params);
    next.delete('status');
    next.delete('motivo');
    setParams(next, { replace: true });
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Espelha no aparelho só o estado da conexão (nunca tokens).
  useEffect(() => {
    if (status.state !== 'ok') return;
    const s = status.status;
    if (s.connected) {
      void setIntegration({ status: 'connected', scopes: s.scopes, authorizedAt: s.authorizedAt, lastCheckedAt: new Date().toISOString(), metadata: { canWrite: s.canWrite, calendarName: s.calendarName } });
    } else if (integration) void clearIntegration();
  }, [status, integration]);

  const activeHabits = useMemo(() => (habits ?? []).filter((h) => h.status === 'active'), [habits]);
  const habit = activeHabits.find((h) => h.id === habitId);


  async function findSlots() {
    if (!habit || !items) return;
    setPlanning(true);
    setPlanNote(undefined);
    const n = Math.max(1, Math.min(14, Number(days) || 7));
    const dur = Math.max(5, Math.min(600, Number(duration) || 30));
    const dates = eachDay(today, addDays(today, n - 1));
    // Ocupado na agenda do Rotinas (itens com horário, inclusive blocos de outros hábitos).
    const native: BusyInterval[] = expandAgenda(items, today, addDays(today, n - 1), timezone)
      .filter((o) => !o.allDay && o.startTime)
      .map((o) => {
        const end = o.endTime ?? minutesToTime(timeToMinutes(o.startTime!) + 30);
        return { start: wallTimeToInstant(o.date, o.startTime!, timezone).toISOString(), end: wallTimeToInstant(o.date, end, timezone).toISOString(), source: 'rotinas' as const, label: o.title };
      });
    let external: BusyInterval[] = [];
    if (canRead) {
      try {
        const res = await calendarFreeBusy({ timeMin: wallTimeToInstant(today, '00:00', timezone).toISOString(), timeMax: wallTimeToInstant(addDays(today, n), '00:00', timezone).toISOString(), timeZone: timezone }, prefs);
        if (res.ok) external = res.data.busy.map((b) => ({ ...b, source: 'google' as const, label: 'Ocupado no Google Calendar' }));
        else setPlanNote(`Disponibilidade do Google não consultada: ${res.error.message}`);
      } catch (e) {
        setPlanNote(`Disponibilidade do Google não consultada: ${e instanceof Error ? e.message : 'falha na conexão'}`);
      }
    }
    const allBusy = [...native, ...external];
    const preferredWindow = habit.timing.kind === 'window' ? { start: habit.timing.start, end: habit.timing.end } : undefined;
    const proposals = proposeSlots({ dates: dates.filter((d) => isHabitDay(d)), durationMinutes: dur, timeZone: timezone, availability: profile.availability, preferredWindow, busy: allBusy, now: new Date() });
    setBusy(allBusy);
    setRows(proposals.map((p) => ({ ...p, include: p.hasFreeSlot })));
    setPlanning(false);
  }

  function isHabitDay(d: CivilDate): boolean {
    return habit ? isScheduledOn(habit, d) : false;
  }

  function updateRowTime(index: number, start: string) {
    if (!rows) return;
    const r = rows[index];
    const end = minutesToTime(timeToMinutes(start) + r.durationMinutes);
    const conflicts = conflictsFor(r.date, start, end, timezone, busy);
    setRows(rows.map((x, i) => (i === index ? { ...x, start, end, conflicts, hasFreeSlot: conflicts.length === 0 } : x)));
  }

  const chosen = (rows ?? []).filter((r) => r.include);

  /**
   * Cria os blocos escolhidos na agenda do Rotinas. Com `external`, liga cada um ao evento criado no Google;
   * com `onlyCreated` (falha parcial do Google), cria só os que existem lá e mantém os demais na lista.
   */
  async function createNative(external?: CalendarCommitResult, onlyCreated = false) {
    if (!habit) return;
    const createdRows = new Set<PlanRow>();
    for (const [index, r] of chosen.entries()) {
      const ev = external?.created.find((c) => c.index === index);
      if (onlyCreated && !ev) continue;
      const item = await createAgendaItem(
        { kind: 'habit', habitId: habit.id, title: habit.title, date: r.date, allDay: false, startTime: r.start, endTime: r.end, origin: 'proposal' },
        { timezone },
      );
      if (ev && external) await setExternalRef(item.id, { provider: 'google', calendarId: external.calendarId, eventId: ev.eventId });
      createdRows.add(r);
    }
    const count = createdRows.size;
    toast.show(`${count} bloco${count === 1 ? '' : 's'} criado${count === 1 ? '' : 's'} na agenda do Rotinas${external ? ' e no Google Calendar' : ''}.`);
    const remaining = (rows ?? []).filter((r) => !createdRows.has(r));
    setRows(onlyCreated && remaining.some((r) => r.include) ? remaining : null);
  }

  async function confirmPlan() {
    if (!habit || chosen.length === 0) return;
    if (!alsoGoogle) {
      try {
        await createNative();
      } catch (e) {
        toast.show(describeError(e), { tone: 'danger' });
      }
      return;
    }
    try {
      const blocks = chosen.map((r) => ({
        title: habit.title,
        start: wallTimeToInstant(r.date, r.start, timezone).toISOString(),
        end: wallTimeToInstant(r.date, r.end, timezone).toISOString(),
        timeZone: timezone,
        description: 'Bloco de tempo criado pelo Rotinas após sua confirmação.',
      }));
      const res = await calendarPreview(blocks, prefs);
      if (!res.ok) {
        toast.show(res.error.message, { tone: 'danger' });
        return;
      }
      // O comprovante vale para estes blocos exatos (o servidor confere na confirmação).
      setGooglePreview({ previewToken: res.data.previewToken, blocks, conflicts: res.data.blocks.map((b) => b.conflicts) });
    } catch (e) {
      toast.show(e instanceof Error ? e.message : 'Falha ao preparar a prévia.', { tone: 'danger' });
    }
  }

  async function commitGoogle() {
    if (!googlePreview) return;
    setCommitting(true);
    try {
      const res = await calendarCommit(googlePreview.previewToken, googlePreview.blocks, prefs);
      if (!res.ok) {
        if (res.error.partial && res.error.partial.created.length > 0) {
          // Parte foi criada no Google: registra só essas e mantém as outras para nova tentativa.
          await createNative(res.error.partial, true);
          setGooglePreview(null);
        }
        toast.show(res.error.message, { tone: 'danger' });
        return;
      }
      await createNative(res.data);
      setGooglePreview(null);
    } catch (e) {
      toast.show(e instanceof Error ? e.message : 'Falha ao criar eventos.', { tone: 'danger' });
    } finally {
      setCommitting(false);
    }
  }

  return (
    <div className="page">
      <PageHeader title="Calendário externo" subtitle="Conexão opcional. A agenda do Rotinas continua sendo a fonte de verdade dos itens criados nela." />

      <Section title="Google Calendar" id="cal-google">
        {status.state === 'off' && (
          <div className="panel stack">
            {prefs.consents.calendar.outdated ? (
              <Notice tone="info" title="A autorização mudou">
                Agora ela também cobre a leitura opcional de eventos (título, horário e cor). Revise o texto abaixo para voltar a usar o Google Calendar.
              </Notice>
            ) : (
              <p className="small muted">Desativado: nenhuma chamada é feita. Antes de autorizar, veja o que seria acessado.</p>
            )}
            <ConsentDetails consent="calendar" />
            <div>
              <Button variant="primary" onClick={() => setAsking(true)}>
                {prefs.consents.calendar.outdated ? 'Revisar e autorizar' : 'Autorizar uso do calendário externo'}
              </Button>
            </div>
          </div>
        )}
        {status.state === 'offline' && <Notice tone="warn">Sem conexão. O planejador abaixo continua funcionando com a agenda do Rotinas.</Notice>}
        {status.state === 'loading' && <LoadingState label="Consultando a camada privada…" lines={1} />}
        {status.state === 'error' && (
          <Notice
            tone="warn"
            title={status.kind === 'locked' ? 'Servidor bloqueado: falta a senha' : status.kind === 'unauthorized' ? 'Senha do servidor ausente ou incorreta' : status.kind === 'static' ? 'Site publicado sem a camada privada' : 'Integração indisponível'}
            action={
              <>
                <Link to="/conexoes" className="btn btn-secondary btn-sm">
                  Conectar Kai e Google
                </Link>
                <Button size="sm" icon={<RotateCcw size={16} aria-hidden="true" />} onClick={refresh}>
                  Verificar de novo
                </Button>
              </>
            }
          >
            <p>{status.message}</p>
            <p style={{ marginTop: 6 }}>O assistente “Conectar Kai e Google” mostra o passo exato que falta.</p>
          </Notice>
        )}
        {google && !google.configured && (
          <Notice
            tone="warn"
            title="Google Calendar não configurado no servidor"
            action={
              <>
                <Link to="/conexoes" className="btn btn-secondary btn-sm">
                  Ver o passo a passo
                </Link>
                <Button size="sm" variant="ghost" onClick={() => void setConsent('calendar', false)}>
                  Desativar
                </Button>
              </>
            }
          >
            <p>{google.reason ?? 'Faltam variáveis de ambiente no servidor.'}</p>
            <p style={{ marginTop: 6 }}>Nada é simulado enquanto isso: o planejador abaixo usa só a agenda do Rotinas.</p>
          </Notice>
        )}
        {google && google.configured && !google.connected && (
          <div className="panel stack">
            <p className="switch-label">Não conectado</p>
            <p className="small">Escolha o nível de acesso. A autorização abre numa aba (ou janela) do Google; ao terminar, volte para cá — a tela atualiza sozinha.</p>
            <ul className="small">
              <li>
                <strong>Disponibilidade</strong> (<code>{GOOGLE_SCOPES.availability.split('/').pop()}</code>): só horários ocupados, sem títulos.
              </li>
              <li>
                <strong>Ver meus eventos</strong> (<code>{GOOGLE_SCOPES.events.split('/').pop()}</code>): também título, horário e cor dos eventos da agenda principal, para a tela Noite e o planejador. Só leitura.
              </li>
            </ul>
            <div className="btn-row">
              <ConnectLink href={links.events} variant="primary" icon={<Eye size={18} aria-hidden="true" />}>
                Conectar e ver meus eventos
              </ConnectLink>
              <ConnectLink href={links.availability} icon={<Link2 size={18} aria-hidden="true" />}>
                Só disponibilidade
              </ConnectLink>
            </div>
            {linkError && <p className="field-error">{linkError}</p>}
          </div>
        )}
        {google && google.connected && (
          <div className="panel stack">
            <div className="row">
              <span className="status-dot is-on" aria-hidden="true" />
              <p className="switch-label">Conectado</p>
              {google.authorizedAt && <span className="meta">desde {formatInstant(google.authorizedAt, timezone)}</span>}
            </div>
            <ul className="small">
              <li>Disponibilidade (livre/ocupado): {google.canReadAvailability ? 'autorizada' : 'não autorizada'}</li>
              <li>Ver eventos da agenda principal (título, horário e cor): {google.canReadEvents ? 'autorizado' : 'não autorizado'}</li>
              <li>
                Criar blocos numa agenda própria “{APP_CALENDAR_NAME}”: {google.canWrite ? 'autorizado' : 'não autorizado'}
              </li>
            </ul>
            <div className="btn-row">
              {!google.canReadEvents && (
                <ConnectLink href={links.events} icon={<Eye size={18} aria-hidden="true" />}>
                  Ver meus eventos
                </ConnectLink>
              )}
              {!google.canWrite && (
                <ConnectLink href={links.write} icon={<CalendarCheck size={18} aria-hidden="true" />}>
                  Permitir criar blocos confirmados
                </ConnectLink>
              )}
              <Button variant="ghost" icon={<Unlink size={18} aria-hidden="true" />} onClick={() => setConfirmDisconnect(true)}>
                Desconectar e revogar
              </Button>
            </div>
            {linkError && <p className="field-error">{linkError}</p>}
            <p className="meta">O escopo de escrita ({GOOGLE_SCOPES.write.split('/').pop()}) só dá acesso à agenda “{APP_CALENDAR_NAME}” criada pelo app — nunca aos seus outros calendários.</p>
          </div>
        )}
        {canReadEvents && (
          <div className="panel stack" style={{ marginTop: 12 }}>
            <div className="row-between">
              <p className="switch-label">Próximos 7 dias no Google</p>
              <Button size="sm" variant="ghost" icon={<RotateCcw size={16} aria-hidden="true" />} onClick={() => { clearGoogleEventsCache(); refreshEvents(); }}>
                Atualizar
              </Button>
            </div>
            {events.state === 'loading' && <LoadingState label="Lendo eventos…" lines={2} />}
            {events.state === 'error' && <Notice tone="warn">{events.message}</Notice>}
            {events.state === 'ok' &&
              (events.events.length === 0 ? (
                <p className="meta">Nenhum evento na agenda principal nos próximos 7 dias.</p>
              ) : (
                <ul className="night-list" role="list">
                  {events.events
                    .flatMap((e) => googleEventDays(e, today, addDays(today, 6), timezone))
                    .slice(0, 40)
                    .map((i) => (
                      <li key={i.key}>
                        <span className="night-dot" style={{ background: i.colorId ? GOOGLE_EVENT_COLORS[i.colorId] : 'var(--chart-series-1)' }} aria-hidden="true" />
                        <span className="night-time">
                          {weekdayShort(i.date)} {formatShortDate(i.date)}
                        </span>
                        <span className="night-time" style={{ minWidth: 72 }}>
                          {i.allDay || !i.start ? 'Dia todo' : i.start}
                        </span>
                        <span className="grow">
                          {i.title}
                          {!i.busy && <span className="meta"> · livre</span>}
                        </span>
                      </li>
                    ))}
                </ul>
              ))}
            <p className="meta">Lidos agora da sua conta; não ficam guardados no servidor nem no backup.</p>
          </div>
        )}
      </Section>

      <Section title="Planejar blocos de tempo" id="cal-plan" description="Encontra horários livres para um hábito, considerando sua disponibilidade e a agenda do Rotinas (e o Google, se conectado). Nada é criado sem sua confirmação.">
        {!habits || !items ? (
          <LoadingState />
        ) : activeHabits.length === 0 ? (
          <p className="meta">Crie um hábito ativo para planejar blocos de tempo.</p>
        ) : (
          <div className="panel stack">
            <div>
              <SelectField label="Hábito" value={habitId} onChange={(v) => { setHabitId(v); setRows(null); const h = activeHabits.find((x) => x.id === v); if (h?.durationMinutes) setDuration(String(h.durationMinutes)); }} options={[{ value: '', label: 'Escolha um hábito' }, ...activeHabits.map((h) => ({ value: h.id, label: h.title }))]} />
              <div className="field-row">
                <SelectField label="Próximos" value={days} onChange={setDays} options={[{ value: '3', label: '3 dias' }, { value: '7', label: '7 dias' }, { value: '14', label: '14 dias' }]} />
                <TextField label="Duração (min)" type="number" min={5} max={600} value={duration} onChange={setDuration} />
              </div>
            </div>
            <p className="meta">
              Janela usada: {habit?.timing.kind === 'window' ? `a do hábito (${habit.timing.start}–${habit.timing.end})` : profile.availability.windows.length > 0 ? 'seus horários exatos (Configurações → Perfil)' : profile.availability.periods.length > 0 ? 'seus períodos livres' : '07:00–22:00 (defina sua disponibilidade em Configurações)'}.
              {canRead ? ' Inclui horários ocupados do Google.' : ' Sem Google conectado: considera só a agenda do Rotinas.'}
            </p>
            <div>
              <Button variant="primary" icon={<Search size={18} aria-hidden="true" />} disabled={!habit} busy={planning} onClick={() => void findSlots()}>
                Encontrar horários
              </Button>
            </div>
            {planNote && <Notice tone="warn">{planNote}</Notice>}
            {rows && rows.length === 0 && <p className="meta">Nenhum dia previsto para este hábito no intervalo, ou nenhuma janela disponível.</p>}
            {rows && rows.length > 0 && (
              <>
                <div className="table-wrap">
                  <table className="data-table">
                    <caption className="visually-hidden">Prévia dos blocos propostos</caption>
                    <thead>
                      <tr>
                        <th scope="col">Dia</th>
                        <th scope="col">Início</th>
                        <th scope="col">Fim e duração</th>
                        <th scope="col">Conflitos</th>
                        <th scope="col">Incluir</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r, i) => (
                        <tr key={r.date}>
                          <th scope="row" style={{ fontWeight: 500 }}>
                            {formatLongDate(r.date)}
                          </th>
                          <td>
                            <input className="input" type="time" aria-label={`Início em ${formatLongDate(r.date)}`} value={r.start} onChange={(e) => e.target.value && updateRowTime(i, e.target.value)} style={{ minWidth: 110 }} />
                          </td>
                          <td>
                            {r.end} ({formatDuration(r.durationMinutes)})
                          </td>
                          <td style={{ textAlign: 'left' }}>
                            {r.conflicts.length === 0 ? (
                              <Tag tone="ok">Livre</Tag>
                            ) : (
                              r.conflicts.map((c, j) => (
                                <span key={j} className="meta" style={{ display: 'block' }}>
                                  {c.label ?? 'Ocupado'} ({formatInstant(c.start, timezone).split(' às ')[1]}–{formatInstant(c.end, timezone).split(' às ')[1]})
                                </span>
                              ))
                            )}
                          </td>
                          <td>
                            <input type="checkbox" aria-label={`Incluir ${formatLongDate(r.date)}`} checked={r.include} onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, include: e.target.checked } : x)))} style={{ width: 20, height: 20, accentColor: 'var(--accent)' }} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <CheckField
                  label={`Também criar no Google Calendar (agenda “${APP_CALENDAR_NAME}”)`}
                  description={canWrite ? 'Você verá a confirmação final do Google antes de qualquer escrita.' : 'Requer conexão com permissão de criar blocos.'}
                  checked={alsoGoogle && canWrite}
                  disabled={!canWrite}
                  onChange={setAlsoGoogle}
                />
                <div className="btn-row end">
                  <Button onClick={() => setRows(null)}>Descartar prévia</Button>
                  <Button variant="primary" disabled={chosen.length === 0} onClick={() => void confirmPlan()}>
                    {alsoGoogle && canWrite ? `Revisar ${chosen.length} bloco${chosen.length === 1 ? '' : 's'} para o Google` : `Criar ${chosen.length} bloco${chosen.length === 1 ? '' : 's'} na agenda do Rotinas`}
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
      </Section>

      {asking && (
        <ConsentDialog
          consent="calendar"
          open
          onClose={() => setAsking(false)}
          onDecide={async (granted) => {
            await setConsent('calendar', granted);
            setAsking(false);
          }}
        />
      )}

      <Dialog
        open={googlePreview !== null}
        onClose={() => setGooglePreview(null)}
        title="Confirmar criação no Google Calendar"
        description={`Estes eventos serão criados na agenda “${APP_CALENDAR_NAME}” da sua conta Google. Conflitos foram verificados agora pelo servidor.`}
        footer={
          <>
            <Button onClick={() => setGooglePreview(null)}>Cancelar</Button>
            <Button variant="primary" busy={committing} onClick={() => void commitGoogle()}>
              Confirmar e criar {googlePreview?.blocks.length} evento{googlePreview?.blocks.length === 1 ? '' : 's'}
            </Button>
          </>
        }
      >
        <ul className="review-list" role="list">
          {googlePreview?.blocks.map((b, i) => (
            <li key={i} className="review-item">
              <div className="grow">
                <p className="row-title">{b.title}</p>
                <p className="meta">
                  {formatInstant(b.start, timezone)} até {formatInstant(b.end, timezone).split(' às ')[1]}
                </p>
                {(googlePreview.conflicts[i]?.length ?? 0) > 0 ? <Tag tone="warn">Conflita com {googlePreview.conflicts[i].length} período(s) ocupado(s)</Tag> : <Tag tone="ok">Sem conflito</Tag>}
              </div>
            </li>
          ))}
        </ul>
      </Dialog>

      <ConfirmDialog
        open={confirmDisconnect}
        onClose={() => setConfirmDisconnect(false)}
        title="Desconectar o Google Calendar?"
        confirmLabel="Desconectar e revogar"
        danger
        message={<p className="small">O servidor revoga o acesso no Google e apaga os tokens guardados. Blocos já criados continuam na sua agenda do Rotinas (e no Google, se foram criados lá).</p>}
        onConfirm={async () => {
          try {
            const res = await calendarDisconnect(prefs);
            if (!res.ok) toast.show(res.error.message, { tone: 'danger' });
            else toast.show(res.data.revoked ? 'Acesso revogado no Google e tokens apagados.' : 'Tokens apagados no servidor. Confira também em myaccount.google.com/permissions.');
            await clearIntegration();
            clearGoogleEventsCache();
          } catch (e) {
            toast.show(e instanceof Error ? e.message : 'Falha ao desconectar.', { tone: 'danger' });
          }
          setConfirmDisconnect(false);
          refresh();
        }}
      />
    </div>
  );
}
