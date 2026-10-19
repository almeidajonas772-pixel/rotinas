import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/app/App';
import { db } from '../../src/db/db';
import { createHabit } from '../../src/db/repo-habits';
import { setPriority } from '../../src/db/repo-night';
import { completeOnboarding, setConsent } from '../../src/db/repo-profile';
import { addDays, todayInZone } from '../../src/domain/civil';
import { nightDateFor } from '../../src/domain/nightly';

/**
 * Tela Noite e assistente de conexão com o app inteiro. A rede é um dublê que registra tudo:
 * sem autorização, nenhuma requisição pode acontecer.
 */

const TZ = 'America/Sao_Paulo';
type FetchArgs = [input: RequestInfo | URL, init?: RequestInit];
let fetchMock: ReturnType<typeof vi.fn<(...args: FetchArgs) => Promise<Response>>>;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const HEALTH_OK = {
  ok: true,
  service: 'rotinas-private-layer',
  version: '1.1.0',
  runtime: 'vercel',
  accessTokenRequired: true,
  storage: { ok: true, kind: 'blob' },
  kai: { enabled: true, provider: 'anthropic', models: { fast: 'claude-haiku-5-5', deep: 'claude-sonnet-5-5' } },
  calendar: { enabled: false, reason: 'Variáveis ausentes no servidor: GOOGLE_CLIENT_ID.', redirectUri: 'https://rotinas.example.app/api/calendar/callback' },
};

beforeEach(async () => {
  if (!db.isOpen()) await db.open();
  await Promise.all(db.tables.map((t) => t.clear()));
  window.location.hash = '#/';
  localStorage.clear();
  fetchMock = vi.fn(async () => new Response('<!doctype html><title>404</title>', { status: 404, headers: { 'content-type': 'text/html' } }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function seed(kai = false) {
  const today = todayInZone(TZ);
  await completeOnboarding({
    name: 'Leo',
    timezone: TZ,
    mainGoal: 'Estudar com constância',
    availability: { periods: ['manha', 'noite'], windows: [] },
    weekStartsOn: 1,
    checkins: false,
    notifications: { wanted: false, quietStart: '22:00', quietEnd: '07:00' },
    consents: { kai, kaiCheckins: false, kaiJournal: false },
    habits: [],
    today,
  });
  await createHabit({ title: 'Ler 20 minutos', category: 'Estudos', schedule: { kind: 'daily' }, timing: { kind: 'anytime' }, reminder: { enabled: false }, xp: 10, startDate: today }, { today });
  await db.agendaItems.add({
    id: 'reuniao',
    kind: 'event',
    title: 'Reunião secreta',
    date: addDays(nightDateFor(new Date(), TZ), 1),
    allDay: false,
    startTime: '09:00',
    endTime: '10:00',
    timezone: TZ,
    status: 'active',
    exceptions: {},
    origin: 'manual',
    xp: 0,
    seriesKind: 'single',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

describe('Noite sem IA', () => {
  it('mostra o resumo calculado e lê o resumo do app sem nenhuma requisição', async () => {
    const user = userEvent.setup();
    await seed();
    window.location.hash = '#/noite';
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Noite' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Resumo da noite' })).toBeInTheDocument();
    expect(screen.getByText(/Kai desligado: o resumo abaixo é calculado pelo app/)).toBeInTheDocument();
    expect(screen.getByText('Reunião secreta')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Ouvir o resumo' }));
    expect(await screen.findByText(/Resumo calculado pelo app \(sem IA\)/)).toBeInTheDocument();
    expect(screen.getByText('Qual vai ser a sua prioridade número um para amanhã?')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a resposta escrita vira rascunho de prioridade e só é salva com um toque', async () => {
    const user = userEvent.setup();
    await seed();
    window.location.hash = '#/noite';
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Ouvir o resumo' }));
    await user.type(await screen.findByLabelText('Sua resposta'), 'Revisar o capítulo 3{Enter}');
    const field = await screen.findByLabelText('Prioridade de amanhã');
    // O rascunho chega depois que a fala é registrada na conversa.
    await waitFor(() => expect(field).toHaveValue('Revisar o capítulo 3'));
    const tomorrow = addDays(nightDateFor(new Date(), TZ), 1);
    expect(await db.dayPlans.get(tomorrow)).toBeUndefined();
    await user.click(screen.getByRole('button', { name: 'Salvar prioridade' }));
    await waitFor(async () => expect((await db.dayPlans.get(tomorrow))?.priority).toBe('Revisar o capítulo 3'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a tela Hoje mostra a prioridade do dia e permite marcar como cumprida', async () => {
    const user = userEvent.setup();
    await seed();
    const today = todayInZone(TZ);
    await setPriority(today, 'Entregar o relatório', 'manual');
    window.location.hash = '#/';
    render(<App />);
    expect(await screen.findByText('Entregar o relatório')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cumpri' }));
    await waitFor(async () => expect((await db.dayPlans.get(today))?.outcome).toBe('done'));
  });
});

describe('Noite com o Kai', () => {
  it('servidor sem senha: explica e leva ao assistente, sem resposta inventada', async () => {
    await seed(true);
    fetchMock.mockImplementation(async () => json({ ok: false, error: { code: 'server_locked', message: 'Defina ROTINAS_SERVER_TOKEN (uma senha com 12 ou mais caracteres) nas variáveis de ambiente do servidor.' } }, 503));
    window.location.hash = '#/noite';
    render(<App />);
    expect(await screen.findByText(/Kai indisponível: Defina ROTINAS_SERVER_TOKEN/)).toBeInTheDocument();
    const stage = screen.getByRole('region', { name: 'Sessão da noite' });
    expect(within(stage).getByRole('link', { name: 'Conectar Kai e Google' })).toHaveAttribute('href', '#/conexoes');
    expect(fetchMock.mock.calls.every(([u]) => u === '/api/health')).toBe(true);
  });

  it('abre a sessão com dados autorizados (sem agenda nem nome) e aceitar cria a tarefa de amanhã', async () => {
    const user = userEvent.setup();
    await seed(true);
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/api/health') return json(HEALTH_OK);
      if (url === '/api/kai/nightly') {
        return json({
          ok: true,
          data: {
            say: 'Boa noite. Hoje a leitura ficou em aberto.',
            observations: [],
            proposals: [{ kind: 'tarefa_amanha', title: 'Separar o livro na mesa', detail: 'Facilita começar.', refs: ['h1'], start: null, end: null, habitRef: 'h1', goalRef: null }],
            question: 'Qual vai ser a prioridade de amanhã?',
            priority: 'Ler 20 minutos antes do almoço',
            supportNotice: false,
          },
          meta: { task: 'nightly', model: 'claude-haiku-5-5', provider: 'anthropic' },
        });
      }
      return json({ ok: false, error: { code: 'invalid_request', message: 'x' } }, 404);
    });
    window.location.hash = '#/noite';
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Começar com o Kai' }));
    expect(await screen.findByText('Boa noite. Hoje a leitura ficou em aberto.')).toBeInTheDocument();

    const call = fetchMock.mock.calls.find(([u]) => u === '/api/kai/nightly')!;
    const body = JSON.parse(String(call[1]?.body));
    expect(body.message).toBeUndefined();
    expect(body.night.tomorrowAgenda).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('Reunião secreta');
    expect(JSON.stringify(body)).not.toContain('Leo');

    await user.click(screen.getByRole('button', { name: 'Criar tarefa para amanhã' }));
    const tomorrow = addDays(nightDateFor(new Date(), TZ), 1);
    await waitFor(async () => {
      const created = (await db.agendaItems.toArray()).find((i) => i.origin === 'kai');
      expect(created).toMatchObject({ kind: 'task', title: 'Separar o livro na mesa', date: tomorrow, allDay: true });
    });
    expect(await screen.findByRole('button', { name: 'Desfazer' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Usar para amanhã' }));
    await waitFor(async () => expect((await db.dayPlans.get(tomorrow))?.prioritySource).toBe('kai'));
  });
});

describe('assistente de conexão', () => {
  it('sem autorização, pede para escolher o que ativar e não faz chamadas', async () => {
    await seed();
    window.location.hash = '#/conexoes';
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Primeiro: o que você quer ativar?' })).toBeInTheDocument();
    expect(screen.getByText(/redirect URIs/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('com o Kai autorizado e site sem servidor, aponta o primeiro passo', async () => {
    await seed(true);
    window.location.hash = '#/conexoes';
    render(<App />);
    expect(await screen.findByText(/publicado só com o app, sem o servidor/)).toBeInTheDocument();
    expect(screen.getAllByText('Falta fazer').length).toBeGreaterThan(0);
  });

  it('servidor pronto: mostra o endereço de retorno do Google para copiar', async () => {
    await seed(true);
    await setConsent('calendar', true);
    fetchMock.mockImplementation(async (input) => (String(input) === '/api/health' ? json(HEALTH_OK) : json({ ok: true, data: { configured: false, connected: false, scopes: [], canReadAvailability: false, canReadEvents: false, canWrite: false } })));
    window.location.hash = '#/conexoes';
    render(<App />);
    expect(await screen.findByText(/Camada privada respondendo/)).toBeInTheDocument();
    expect(screen.getAllByText('https://rotinas.example.app/api/calendar/callback').length).toBeGreaterThan(0);
  });
});
