import { CheckCircle2, Copy, ExternalLink, KeyRound, Moon, RotateCcw, Server, Sparkles } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { HealthResponse } from '../../../shared/kai';
import { useApp } from '../../app/context';
import { TextField } from '../../components/form';
import { useToast } from '../../components/toast';
import { Button, Notice, PageHeader, Section, Tag } from '../../components/ui';
import { describeError } from '../../db/errors';
import { setConsent, updatePrefs } from '../../db/repo-profile';
import type { ConsentKey } from '../../domain/schemas';
import { checkServer, type ServerCheck } from '../../lib/api';
import { useOnline } from '../../lib/browser';
import { runKai } from '../kai/kai-client';
import { ConsentDialog } from '../privacy/ConsentDialog';
import { isClaudeRuntime } from '../../platform/runtime';
import { ClaudeConnectPage } from './ClaudeConnectPage';

/**
 * Assistente de conexão: verifica a camada privada passo a passo e mostra exatamente o que falta
 * (publicação com servidor, senha, armazenamento, Kai e Google). Segredos nunca passam por aqui:
 * chaves e senhas do servidor são cadastradas pela pessoa no painel da Vercel.
 */

const VERCEL_DASHBOARD = 'https://vercel.com/dashboard';
const ANTHROPIC_KEYS = 'https://platform.claude.com/settings/keys';
const ANTHROPIC_BILLING = 'https://platform.claude.com/settings/billing';
const GOOGLE_CONSOLE = 'https://console.cloud.google.com/';
const GOOGLE_CALENDAR_API = 'https://console.cloud.google.com/apis/library/calendar-json.googleapis.com';
const GOOGLE_AUTH_PLATFORM = 'https://console.cloud.google.com/auth/overview';

type StepState = 'ok' | 'todo' | 'unknown';

function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children} <ExternalLink size={13} aria-hidden="true" style={{ display: 'inline', verticalAlign: '-1px' }} />
    </a>
  );
}

function CopyField({ value, label }: { value: string; label: string }) {
  const toast = useToast();
  return (
    <div className="copy-field">
      <code aria-label={label}>{value}</code>
      <Button
        size="sm"
        icon={<Copy size={16} aria-hidden="true" />}
        onClick={() =>
          void navigator.clipboard
            ?.writeText(value)
            .then(() => toast.show('Copiado.'))
            .catch(() => toast.show('Não foi possível copiar: selecione o texto e copie manualmente.', { tone: 'danger' }))
        }
      >
        Copiar
      </Button>
    </div>
  );
}

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

function Redeploy() {
  return (
    <li>
      Depois de salvar variáveis, publique de novo: <strong>Deployments</strong> → na publicação mais recente, menu <strong>⋯</strong> → <strong>Redeploy</strong>. Variáveis novas só valem para publicações novas.
    </li>
  );
}

export function ConnectPage() {
  return isClaudeRuntime() ? <ClaudeConnectPage /> : <WebConnectPage />;
}

function WebConnectPage() {
  const { prefs } = useApp();
  const toast = useToast();
  const online = useOnline();
  const [check, setCheck] = useState<ServerCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [asking, setAsking] = useState<ConsentKey | null>(null);
  const [password, setPassword] = useState(prefs.server.accessToken ?? '');
  const [kaiTest, setKaiTest] = useState<{ state: 'idle' | 'running' | 'ok' | 'error'; message?: string }>({ state: 'idle' });
  const feature = prefs.consents.kai.granted ? 'kai' : prefs.consents.calendar.granted ? 'calendar' : null;
  const origin = typeof window !== 'undefined' ? window.location.origin : '';

  async function verify(override?: string) {
    if (!feature) return;
    setChecking(true);
    try {
      const token = override ?? prefs.server.accessToken;
      setCheck(await checkServer(feature, { ...prefs, server: { accessToken: token || undefined } }));
    } catch (e) {
      setCheck({ state: 'error', message: describeError(e) });
    } finally {
      setChecking(false);
    }
  }

  // Verifica ao abrir (só com alguma autorização ativa: sem autorização, o app não faz chamadas de rede).
  useEffect(() => {
    if (!feature || !online) return;
    let alive = true;
    checkServer(feature, prefs)
      .then((result) => {
        if (alive) setCheck(result);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feature, online, prefs.server.accessToken]);

  async function savePassword() {
    const value = password.trim();
    try {
      await updatePrefs((p) => ({ ...p, server: { accessToken: value || undefined } }));
      toast.show(value ? 'Senha salva só neste aparelho.' : 'Senha removida deste aparelho.');
      await verify(value);
    } catch (e) {
      toast.show(describeError(e), { tone: 'danger' });
    }
  }

  async function testKai() {
    setKaiTest({ state: 'running' });
    // Pedido mínimo, sem nenhum dado pessoal: só confirma que a chave da Anthropic funciona.
    const context = { locale: 'pt-BR' as const, timezone: 'America/Sao_Paulo', today: new Date().toISOString().slice(0, 10), profile: {}, habits: [], aggregates: [], goals: [] };
    const res = await runKai('chat', { context, message: 'Teste de conexão do Rotinas. Responda apenas com uma frase curta confirmando que está funcionando.', history: [] }, prefs);
    if (res.ok) setKaiTest({ state: 'ok', message: `${res.data.reply} (modelo ${res.model})` });
    else setKaiTest({ state: 'error', message: res.message });
  }

  const health: HealthResponse | undefined = check?.state === 'ok' ? check.health : undefined;
  const published: StepState = !check ? 'unknown' : check.state === 'static' ? 'todo' : check.state === 'error' || check.state === 'offline' ? 'unknown' : 'ok';
  const passwordState: StepState = !check || published !== 'ok' ? 'unknown' : check.state === 'locked' || check.state === 'unauthorized' ? 'todo' : 'ok';
  const storageState: StepState = !health ? 'unknown' : health.storage.ok ? 'ok' : 'todo';
  const kaiState: StepState = !health ? 'unknown' : health.kai.enabled ? (kaiTest.state === 'error' ? 'todo' : 'ok') : 'todo';
  const calendarState: StepState = !health ? 'unknown' : health.calendar.enabled ? 'ok' : 'todo';
  const redirectUri = health?.calendar.redirectUri ?? `${origin}/api/calendar/callback`;

  return (
    <div className="page">
      <PageHeader
        title="Conectar Kai e Google"
        subtitle="Assistente passo a passo. O app verifica a sua camada privada e mostra exatamente o que falta. Chaves e senhas são cadastradas por você no painel da Vercel — nunca aqui."
      />

      {!feature ? (
        <Section title="Primeiro: o que você quer ativar?" id="conn-start">
          <div className="panel stack">
            <p className="small">Sem nenhuma autorização, o Rotinas não faz chamadas de rede — nem para verificar o servidor. Escolha o que quer usar; cada autorização mostra o que seria enviado e pode ser revogada depois.</p>
            <div className="btn-row">
              <Button variant="primary" icon={<Sparkles size={18} aria-hidden="true" />} onClick={() => setAsking('kai')}>
                Ativar o Kai
              </Button>
              <Button onClick={() => setAsking('calendar')}>Ativar o Google Agenda</Button>
            </div>
          </div>
        </Section>
      ) : (
        <Section
          title="Situação agora"
          id="conn-status"
          action={
            <Button size="sm" icon={<RotateCcw size={16} aria-hidden="true" />} busy={checking} disabled={!online} onClick={() => void verify()}>
              Verificar de novo
            </Button>
          }
        >
          {!online && <Notice tone="warn">Sem internet: conecte-se para verificar a camada privada.</Notice>}
          {check?.state === 'ok' && (
            <Notice tone={health?.kai.enabled && health.calendar.enabled ? 'ok' : 'info'} role="status">
              Camada privada respondendo ({health?.runtime === 'vercel' ? 'Vercel' : 'servidor local'}, versão {health?.version}). Kai: {health?.kai.enabled ? 'configurado' : 'falta configurar'}. Google Agenda:{' '}
              {health?.calendar.enabled ? 'configurado' : 'falta configurar'}.
            </Notice>
          )}
          {check && check.state !== 'ok' && (
            <Notice tone="warn" role="status">
              {check.message}
            </Notice>
          )}
        </Section>
      )}

      <Section title="Passo a passo" id="conn-steps">
        <ol className="setup-steps">
          <Step state={published} title="Publicar o app junto com a camada privada">
            <p>
              O Kai e o Google precisam do servidor do Rotinas (a “camada privada”), que guarda as chaves com segurança. Publicar arrastando a pasta (Vercel Drop) envia só o app — por isso nada se conectava.
            </p>
            {published !== 'ok' && (
              <ol>
                <li>
                  Abra o <Ext href={VERCEL_DASHBOARD}>painel da Vercel</Ext> e entre no projeto deste site.
                </li>
                <li>
                  <strong>Settings</strong> → <strong>Git</strong> → <strong>Connect Git Repository</strong> → GitHub → escolha o repositório do Rotinas (ramo <code>main</code>).
                </li>
                <li>A Vercel publica sozinha a cada atualização do repositório, já com a camada privada em <code>/api</code>. O endereço do site continua o mesmo (e seus dados neste aparelho também).</li>
              </ol>
            )}
          </Step>

          <Step state={passwordState} title="Senha do servidor">
            <p>
              Na internet, a camada privada só atende quem tem a senha. Crie uma senha longa (12 ou mais caracteres; uma frase com espaços serve) e cadastre-a na Vercel como <code>ROTINAS_SERVER_TOKEN</code>. Depois, salve a mesma senha em cada aparelho
              (iPad e computador).
            </p>
            {check?.state === 'locked' && (
              <ol>
                <li>
                  Vercel → projeto → <strong>Settings</strong> → <strong>Environment Variables</strong> → <strong>Add</strong>: nome <code>ROTINAS_SERVER_TOKEN</code>, valor = sua senha, ambiente <strong>Production</strong>, marque{' '}
                  <strong>Sensitive</strong>.
                </li>
                <Redeploy />
              </ol>
            )}
            <form
              className="stack"
              onSubmit={(e) => {
                e.preventDefault();
                void savePassword();
              }}
            >
              <TextField
                label="Senha do servidor neste aparelho"
                type="password"
                autoComplete="off"
                value={password}
                onChange={setPassword}
                hint="Fica só neste aparelho (não entra no backup). Não é a chave da Anthropic nem do Google."
              />
              <div>
                <Button type="submit" icon={<KeyRound size={18} aria-hidden="true" />} disabled={!feature}>
                  Salvar e verificar
                </Button>
              </div>
            </form>
            {check?.state === 'unauthorized' && <p className="field-error">O servidor recusou a senha salva neste aparelho. Confira se ela é igual à da Vercel.</p>}
          </Step>

          <Step state={storageState} title="Armazenamento privado (Blob)">
            <p>Guarda, cifrado, o acesso ao seu Google Agenda e o contador diário de uso do Kai. Seus hábitos e o Diário continuam só no aparelho.</p>
            {storageState !== 'ok' && (
              <ol>
                <li>
                  Vercel → projeto → aba <strong>Storage</strong> → <strong>Create Storage</strong> → <strong>Blob</strong> → <strong>Continue</strong> → acesso <strong>Private</strong> → crie e conecte ao projeto.
                </li>
                <Redeploy />
              </ol>
            )}
            {health && !health.storage.ok && health.storage.reason && <p className="meta">Servidor: {health.storage.reason}</p>}
          </Step>

          <Step state={kaiState} title="Kai (Anthropic)">
            {kaiState !== 'ok' && (
              <ol>
                <li>
                  Crie uma chave em <Ext href={ANTHROPIC_KEYS}>Claude Console → API keys</Ext> e adicione créditos em <Ext href={ANTHROPIC_BILLING}>Billing</Ext>. Defina lá um limite de gasto mensal: é a proteção definitiva de custo.
                </li>
                <li>
                  Na Vercel, adicione a variável <code>ANTHROPIC_API_KEY</code> (Production, <strong>Sensitive</strong>) com a chave. Não cole a chave em nenhum outro lugar.
                </li>
                <Redeploy />
              </ol>
            )}
            {health && !health.kai.enabled && health.kai.reason && <p className="meta">Servidor: {health.kai.reason}</p>}
            {health?.kai.enabled && (
              <div className="stack">
                <p>
                  Chave configurada. Modelos: {health.kai.models?.fast} (conversa e noite) e {health.kai.models?.deep} (revisões e planos).
                </p>
                {prefs.consents.kai.granted ? (
                  <div>
                    <Button icon={<Sparkles size={18} aria-hidden="true" />} busy={kaiTest.state === 'running'} onClick={() => void testKai()}>
                      Testar o Kai agora
                    </Button>
                  </div>
                ) : (
                  <p className="meta">
                    Para testar, ative o Kai em <Link to="/kai">Kai</Link>.
                  </p>
                )}
                {kaiTest.state === 'ok' && (
                  <Notice tone="ok" role="status">
                    Resposta real do Kai: {kaiTest.message}
                  </Notice>
                )}
                {kaiTest.state === 'error' && (
                  <Notice tone="warn" role="alert">
                    {kaiTest.message} Confira a chave e os créditos no Console e publique de novo.
                  </Notice>
                )}
                <p className="meta">O teste envia só uma frase fixa, sem nenhum dado seu.</p>
              </div>
            )}
          </Step>

          <Step state={calendarState} title="Google Agenda">
            {calendarState !== 'ok' ? (
              <ol>
                <li>
                  No <Ext href={GOOGLE_CONSOLE}>Google Cloud Console</Ext>, crie um projeto (ex.: “Rotinas”) e ative a <Ext href={GOOGLE_CALENDAR_API}>Google Calendar API</Ext>.
                </li>
                <li>
                  Em <Ext href={GOOGLE_AUTH_PLATFORM}>Google Auth Platform</Ext>, toque em <strong>Get started</strong>: nome do app “Rotinas”, seu e-mail, público <strong>External</strong>.
                </li>
                <li>
                  Em <strong>Clients</strong> → <strong>Create client</strong> → tipo <strong>Web application</strong>. Em <strong>Authorized redirect URIs</strong>, cole exatamente:
                  <CopyField value={redirectUri} label="Endereço de retorno do Google" />
                </li>
                <li>Copie o Client ID e o Client secret na janela que aparece ao criar (o segredo não é mostrado de novo; baixe o JSON se preferir).</li>
                <li>
                  Na Vercel, adicione <code>GOOGLE_CLIENT_ID</code> e <code>GOOGLE_CLIENT_SECRET</code> (Production, <strong>Sensitive</strong>).
                </li>
                <Redeploy />
                <li>
                  Em <strong>Audience</strong>, toque em <strong>Publish app</strong> (status “In production”). Em “Testing”, o Google derruba a conexão a cada 7 dias. Como o app não passa pela verificação do Google, na hora de conectar aparece o aviso
                  “o Google não verificou este app”: em <strong>Avançado</strong>, continue para Rotinas (é o seu próprio app).
                </li>
              </ol>
            ) : (
              <div className="stack">
                <p>Credenciais configuradas no servidor. Endereço de retorno em uso:</p>
                <CopyField value={redirectUri} label="Endereço de retorno do Google" />
                <div>
                  <Link to="/calendario" className="btn btn-primary">
                    Conectar minha conta Google
                  </Link>
                </div>
              </div>
            )}
            {health && !health.calendar.enabled && health.calendar.reason && <p className="meta">Servidor: {health.calendar.reason}</p>}
          </Step>

          <Step state={kaiState === 'ok' ? 'ok' : 'unknown'} title="Usar à noite">
            <p>Com tudo pronto, abra a aba Noite: o Kai lê o seu dia, a agenda de amanhã (com sua autorização) e ajuda a decidir a prioridade nº 1 — por voz ou texto.</p>
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
            <Server size={16} aria-hidden="true" style={{ display: 'inline', verticalAlign: '-3px', marginRight: 6 }} />
            A camada privada roda na sua conta da Vercel. As chaves ficam nas variáveis de ambiente de lá; o app nunca as vê.
          </p>
          <p>
            O Kai cobra por uso na sua conta da Anthropic. O servidor limita os pedidos (padrão: 10 por minuto e 80 por dia; ajustável com <code>KAI_RATE_LIMIT_PER_MINUTE</code> e <code>KAI_DAILY_LIMIT</code>), e o limite de gasto do Console é o teto
            definitivo.
          </p>
          <p>
            <CheckCircle2 size={16} aria-hidden="true" style={{ display: 'inline', verticalAlign: '-3px', marginRight: 6 }} />
            Revogue o acesso ao Google quando quiser em Calendário externo (ou em myaccount.google.com/permissions).
          </p>
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
              if (granted) toast.show('Autorização concedida. Verificando o servidor…');
            } catch (e) {
              toast.show(describeError(e), { tone: 'danger' });
            }
          }}
        />
      )}
    </div>
  );
}
