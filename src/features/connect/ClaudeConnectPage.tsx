import { CalendarCheck, Moon, RotateCcw, ShieldCheck, Sparkles } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useApp } from '../../app/context';
import { useToast } from '../../components/toast';
import { Button, Notice, PageHeader, Section, Tag } from '../../components/ui';
import { describeError } from '../../db/errors';
import { setConsent } from '../../db/repo-profile';
import { addDays } from '../../domain/civil';
import type { ConsentKey } from '../../domain/schemas';
import { wallTimeToInstant } from '../../domain/tz';
import { calendarEvents } from '../../lib/api';
import { GOOGLE_CALENDAR_CONNECTOR, openPermissionsPanel, requestPermissions } from '../../platform/claude';
import { useCloudSync } from '../../platform/cloud-sync';
import { useCalendarStatus } from '../calendar/calendar-client';
import { runKai, useKaiAvailability } from '../kai/kai-client';
import { ConsentDialog } from '../privacy/ConsentDialog';
import { CloudStatus } from '../shared/CloudStatus';

/**
 * Assistente de conexão do Rotinas dentro do Claude. Não há nada para publicar nem chave para
 * criar: o Kai usa o plano do Claude da pessoa, o Google usa o conector do Claude e os dados ficam
 * na área privada da conta. A tela mostra o estado de cada parte e o passo que falta.
 */

type StepState = 'ok' | 'todo' | 'unknown';

function Step({ state, title, children }: { state: StepState; title: string; children: ReactNode }) {
  return (
    <li className={`setup-step is-${state}`}>
      <div className="row-between">
        <h3>{title}</h3>
        {state === 'ok' && <Tag tone="ok">Pronto</Tag>}
        {state === 'todo' && <Tag tone="warn">Falta fazer</Tag>}
        {state === 'unknown' && <Tag>A verificar</Tag>}
      </div>
      <div className="small stack">{children}</div>
    </li>
  );
}

export function ClaudeConnectPage() {
  const { prefs, today, timezone } = useApp();
  const toast = useToast();
  const sync = useCloudSync();
  const [kai, recheckKai] = useKaiAvailability();
  const [calendar, refreshCalendar] = useCalendarStatus();
  const [asking, setAsking] = useState<ConsentKey | null>(null);
  const [kaiTest, setKaiTest] = useState<{ state: 'idle' | 'running' | 'ok' | 'error'; message?: string }>({ state: 'idle' });
  const [calTest, setCalTest] = useState<{ state: 'idle' | 'running' | 'ok' | 'error'; message?: string }>({ state: 'idle' });

  const inClaude = sync.phase !== 'unavailable' || kai.state === 'ready';
  const dataState: StepState = sync.phase === 'synced' ? 'ok' : sync.phase === 'unavailable' || sync.phase === 'error' || sync.phase === 'blocked' ? 'todo' : 'unknown';
  const kaiState: StepState = !prefs.consents.kai.granted ? 'todo' : kai.state === 'ready' ? (kaiTest.state === 'error' ? 'todo' : 'ok') : kai.state === 'unavailable' ? 'todo' : 'unknown';
  const google = calendar.state === 'ok' ? calendar.status : undefined;
  const calState: StepState = !prefs.consents.calendar.granted
    ? 'todo'
    : !google
      ? 'unknown'
      : !google.configured || !google.connected || google.permission === 'denied'
        ? 'todo'
        : calTest.state === 'error'
          ? 'todo'
          : 'ok';

  async function testKai() {
    setKaiTest({ state: 'running' });
    // Pedido mínimo, sem nenhum dado pessoal: confirma que o Claude responde para o Rotinas.
    const context = { locale: 'pt-BR' as const, timezone, today, profile: {}, habits: [], aggregates: [], goals: [] };
    const res = await runKai('chat', { context, message: 'Teste de conexão do Rotinas. Responda apenas com uma frase curta confirmando que está funcionando.', history: [] }, prefs);
    if (res.ok) setKaiTest({ state: 'ok', message: `${res.data.reply} (${res.model})` });
    else setKaiTest({ state: 'error', message: res.message });
    recheckKai();
  }

  async function testCalendar() {
    setCalTest({ state: 'running' });
    try {
      const range = { timeMin: wallTimeToInstant(today, '00:00', timezone).toISOString(), timeMax: wallTimeToInstant(addDays(today, 1), '00:00', timezone).toISOString(), timeZone: timezone };
      const res = await calendarEvents(range, prefs);
      if (res.ok) {
        const n = res.data.events.length;
        setCalTest({ state: 'ok', message: n === 0 ? 'Leitura funcionando: nenhum evento hoje na agenda principal.' : `Leitura funcionando: ${n} evento${n === 1 ? '' : 's'} hoje na agenda principal.` });
      } else setCalTest({ state: 'error', message: res.error.message });
    } catch (e) {
      setCalTest({ state: 'error', message: describeError(e) });
    }
    refreshCalendar();
  }

  async function allowCalendar() {
    const result = await requestPermissions([`mcp:${GOOGLE_CALENDAR_CONNECTOR}`]);
    const state = result[`mcp:${GOOGLE_CALENDAR_CONNECTOR}`];
    if (state === 'denied') toast.show('Permissão não concedida. Você pode liberar depois em Permissões, no menu do artifact.', { tone: 'danger' });
    refreshCalendar();
  }

  async function openPermissions() {
    const opened = await openPermissionsPanel();
    if (!opened) toast.show('Abra o menu do artifact no Claude e escolha “Permissões”.', { tone: 'danger' });
    recheckKai();
    refreshCalendar();
  }

  return (
    <div className="page">
      <PageHeader
        title="Conectar Kai e Google"
        subtitle="Dentro do Claude não há servidor, chave de API nem conta extra: o Kai usa o seu plano do Claude e o Google usa o conector do seu Claude. Esta tela mostra o que já funciona e o passo que falta."
      />

      <Section title="Passo a passo" id="conn-steps">
        <ol className="setup-steps">
          <Step state={inClaude ? 'ok' : 'todo'} title="Abrir o Rotinas dentro do Claude">
            {inClaude ? (
              <p>Você está usando o Rotinas dentro do Claude. No iPad e no computador, abra este mesmo app no Claude (claude.ai ou app do Claude), com a mesma conta.</p>
            ) : (
              <p>Esta página não está conseguindo falar com o Claude. Abra o Rotinas pelo link do artifact no claude.ai (ou no app do Claude) e recarregue.</p>
            )}
          </Step>

          <Step state={dataState} title="Seus dados na sua conta do Claude">
            <p>Tudo o que você registra fica numa área privada da sua conta neste app e aparece igual no iPad e no computador.</p>
            <CloudStatus />
          </Step>

          <Step state={kaiState} title="Kai pelo seu plano do Claude">
            {!prefs.consents.kai.granted ? (
              <div className="stack">
                <p>O Kai está desligado. Ao ativar, você vê exatamente o que ele recebe.</p>
                <div>
                  <Button variant="primary" icon={<Sparkles size={18} aria-hidden="true" />} onClick={() => setAsking('kai')}>
                    Ativar o Kai
                  </Button>
                </div>
              </div>
            ) : kai.state === 'unavailable' ? (
              <div className="stack">
                <Notice tone="warn">{kai.message}</Notice>
                {kai.reason === 'claude_denied' && (
                  <div>
                    <Button icon={<ShieldCheck size={18} aria-hidden="true" />} onClick={() => void openPermissions()}>
                      Abrir permissões
                    </Button>
                  </div>
                )}
              </div>
            ) : (
              <div className="stack">
                <p>Sem chave de API e sem créditos: cada pedido ao Kai conta no uso do seu plano do Claude, como uma conversa sua. Na primeira vez, o Claude pergunta se o Rotinas pode usá-lo — escolha “Permitir”.</p>
                <div>
                  <Button icon={<Sparkles size={18} aria-hidden="true" />} busy={kaiTest.state === 'running'} disabled={kai.state !== 'ready'} onClick={() => void testKai()}>
                    Testar o Kai agora
                  </Button>
                </div>
                {kaiTest.state === 'ok' && (
                  <Notice tone="ok" role="status">
                    Resposta real do Kai: {kaiTest.message}
                  </Notice>
                )}
                {kaiTest.state === 'error' && (
                  <Notice tone="warn" role="alert">
                    {kaiTest.message}
                  </Notice>
                )}
                <p className="meta">O teste envia só uma frase fixa, sem nenhum dado seu.</p>
              </div>
            )}
          </Step>

          <Step state={calState} title="Google Agenda pelo conector do Claude">
            {!prefs.consents.calendar.granted ? (
              <div className="stack">
                <p>O Rotinas usa o conector do Google Calendar do seu Claude — sem Google Cloud, sem senha e sem custo. Ao ativar, você vê o que seria acessado.</p>
                <div>
                  <Button variant="primary" icon={<CalendarCheck size={18} aria-hidden="true" />} onClick={() => setAsking('calendar')}>
                    Ativar o Google Agenda
                  </Button>
                </div>
              </div>
            ) : !google ? (
              <p>{calendar.state === 'error' ? calendar.message : 'Verificando o conector…'}</p>
            ) : !google.configured ? (
              <Notice tone="warn">{google.reason}</Notice>
            ) : !google.connected ? (
              <div className="stack">
                <ol>
                  <li>
                    No Claude, abra <strong>Configurações</strong> → <strong>Conectores</strong>.
                  </li>
                  <li>
                    Em <strong>Google Calendar</strong>, toque em <strong>Conectar</strong> e entre na sua conta Google.
                  </li>
                  <li>Volte aqui e toque em “Verificar de novo”.</li>
                </ol>
                {google.reason && <p className="meta">{google.reason}</p>}
                <div>
                  <Button icon={<RotateCcw size={18} aria-hidden="true" />} onClick={refreshCalendar}>
                    Verificar de novo
                  </Button>
                </div>
              </div>
            ) : google.permission === 'denied' ? (
              <div className="stack">
                <p>O Google Calendar está conectado ao seu Claude, mas você não permitiu que o Rotinas o use.</p>
                <div>
                  <Button icon={<ShieldCheck size={18} aria-hidden="true" />} onClick={() => void openPermissions()}>
                    Abrir permissões
                  </Button>
                </div>
              </div>
            ) : (
              <div className="stack">
                <p>
                  Conector encontrado.{' '}
                  {google.permission === 'granted' ? 'O Rotinas já tem sua permissão para usá-lo.' : 'Na primeira leitura, o Claude pergunta se o Rotinas pode usá-lo — escolha “Permitir”.'}
                </p>
                <div className="btn-row">
                  {google.permission !== 'granted' && (
                    <Button variant="primary" icon={<ShieldCheck size={18} aria-hidden="true" />} onClick={() => void allowCalendar()}>
                      Permitir acesso ao Google Agenda
                    </Button>
                  )}
                  <Button icon={<CalendarCheck size={18} aria-hidden="true" />} busy={calTest.state === 'running'} onClick={() => void testCalendar()}>
                    Testar: ler meus eventos de hoje
                  </Button>
                </div>
                {calTest.state === 'ok' && (
                  <Notice tone="ok" role="status">
                    {calTest.message}
                  </Notice>
                )}
                {calTest.state === 'error' && (
                  <Notice tone="warn" role="alert">
                    {calTest.message}
                  </Notice>
                )}
                <p className="meta">
                  Depois, em <Link to="/calendario">Calendário externo</Link>, veja seus próximos 7 dias e crie blocos dos hábitos no Google.
                </p>
              </div>
            )}
          </Step>

          <Step state={kaiState === 'ok' ? 'ok' : 'unknown'} title="Usar à noite">
            <p>Abra a aba Noite: o Kai lê o seu dia, a agenda de amanhã (com sua autorização) e ajuda a decidir a prioridade nº 1. Para falar em vez de digitar, use o ditado do teclado (no iPad, o microfone do teclado; no Windows, Win + H).</p>
            <div>
              <Link to="/noite" className="btn btn-secondary">
                <Moon size={18} aria-hidden="true" /> Abrir a Noite
              </Link>
            </div>
          </Step>
        </ol>
      </Section>

      <Section title="Custos e segurança" id="conn-costs">
        <div className="panel small stack">
          <p>
            <strong>Custo extra: zero.</strong> O Kai usa o limite de uso do seu plano do Claude (o mesmo das suas conversas). Se o limite acabar, o Kai avisa e volta quando o limite renovar — nada é cobrado à parte.
          </p>
          <p>Sem Vercel, sem chave de API e sem Google Cloud. O Rotinas nunca vê senhas ou tokens: o acesso ao Google é do conector do seu Claude.</p>
          <p>Para bloquear o Claude ou o Google para este app, use “Permissões” no menu do artifact. Para desconectar o Google do seu Claude: Configurações → Conectores.</p>
        </div>
      </Section>

      {asking && (
        <ConsentDialog
          consent={asking}
          open
          onClose={() => setAsking(null)}
          onDecide={async (granted) => {
            const key = asking;
            setAsking(null);
            try {
              await setConsent(key, granted);
              if (granted) toast.show('Autorização concedida.');
            } catch (e) {
              toast.show(describeError(e), { tone: 'danger' });
            }
          }}
        />
      )}
    </div>
  );
}
