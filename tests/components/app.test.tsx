import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/app/App';
import { db } from '../../src/db/db';
import { completeOnboarding, setConsent } from '../../src/db/repo-profile';
import { todayInZone } from '../../src/domain/civil';

/**
 * Testes de componentes com o app inteiro (IndexedDB simulado por fake-indexeddb).
 * A rede é substituída por um dublê que registra qualquer tentativa de requisição.
 */

const TZ = 'America/Sao_Paulo';
type FetchArgs = [input: RequestInfo | URL, init?: RequestInit];
let fetchMock: ReturnType<typeof vi.fn<(...args: FetchArgs) => Promise<Response>>>;
let xhrOpen: ReturnType<typeof vi.spyOn>;

function htmlNotFound() {
  // O que um servidor estático (sem a camada privada) devolve para /api/*.
  return new Response('<!doctype html><title>404</title>', { status: 404, headers: { 'content-type': 'text/html' } });
}

beforeEach(async () => {
  if (!db.isOpen()) await db.open();
  await Promise.all(db.tables.map((t) => t.clear()));
  window.location.hash = '#/';
  localStorage.clear();
  fetchMock = vi.fn(async () => htmlNotFound());
  vi.stubGlobal('fetch', fetchMock);
  xhrOpen = vi.spyOn(XMLHttpRequest.prototype, 'open');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function seedProfile(consents: { kai?: boolean; kaiJournal?: boolean } = {}) {
  await completeOnboarding({
    name: 'Leo',
    timezone: TZ,
    mainGoal: 'Estudar com constância',
    availability: { periods: ['noite'], windows: [] },
    weekStartsOn: 1,
    checkins: false,
    notifications: { wanted: false, quietStart: '22:00', quietEnd: '07:00' },
    consents: { kai: Boolean(consents.kai), kaiCheckins: false, kaiJournal: Boolean(consents.kaiJournal) },
    habits: [],
    today: todayInZone(TZ),
  });
}

async function walkOnboardingTo(user: ReturnType<typeof userEvent.setup>, options: { kai?: boolean } = {}) {
  await screen.findByRole('heading', { name: 'Sua rotina, do seu jeito.' });
  await user.click(screen.getByRole('button', { name: 'Começar a configuração' }));
  await screen.findByRole('heading', { name: 'Perfil local' });
  await user.type(screen.getByLabelText(/Como quer ser chamado/), 'Leo');
  await user.selectOptions(screen.getByLabelText('Fuso horário'), TZ);
  await user.click(screen.getByRole('button', { name: 'Continuar' }));
  await screen.findByRole('heading', { name: 'Objetivo e tempo disponível' });
  await user.type(screen.getByLabelText(/Objetivo principal/), 'Ler mais e dormir melhor');
  await user.click(screen.getByRole('button', { name: 'Continuar' }));
  await screen.findByRole('heading', { name: 'Lembretes' });
  await user.click(screen.getByRole('button', { name: 'Continuar' }));
  await screen.findByRole('heading', { name: 'Autorizações opcionais' });
  for (const sw of screen.getAllByRole('switch')) expect(sw).toHaveAttribute('aria-checked', 'false');
  if (options.kai) await user.click(screen.getByRole('switch', { name: 'Coaching por IA (Kai)' }));
  await user.click(screen.getByRole('button', { name: 'Continuar' }));
  await screen.findByRole('heading', { name: 'Primeira rotina' });
}

describe('primeiro uso sem IA', () => {
  it('onboarding → hábito → Hoje → concluir, desfazer, recarregar e ver histórico, sem nenhuma requisição', async () => {
    const user = userEvent.setup();
    const first = render(<App />);
    await walkOnboardingTo(user);

    await user.click(screen.getByRole('button', { name: /Ler 10 páginas/ }));
    const editor = await screen.findByRole('dialog', { name: 'Novo hábito' });
    expect(within(editor).getByLabelText('Nome do hábito')).toHaveValue('Ler 10 páginas');
    await user.click(within(editor).getByRole('button', { name: 'Adicionar à rotina' }));
    expect(await screen.findByRole('heading', { name: 'Sua rotina (1)' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Continuar' }));
    await screen.findByRole('heading', { name: 'Revisão' });
    expect(screen.getByText('Hábitos a criar (1)')).toBeInTheDocument();
    // Check-in e Kai ficam desligados quando nada é autorizado.
    expect(screen.getAllByText('Desativado', { selector: 'dd' })).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Salvar e começar' }));

    const check = await screen.findByRole('button', { name: 'Concluir Ler 10 páginas' });
    const [habit] = await db.habits.toArray();
    expect(habit).toMatchObject({ title: 'Ler 10 páginas', xp: 10, status: 'active' });

    await user.click(check);
    expect(await screen.findByRole('button', { name: 'Desfazer conclusão de Ler 10 páginas' })).toHaveAttribute('aria-pressed', 'true');
    expect(await screen.findByText('Concluído: Ler 10 páginas (+10 XP)')).toBeInTheDocument();
    expect(await db.completions.count()).toBe(1);
    expect((await db.progressEvents.toArray()).map((e) => e.xp)).toEqual([10]);

    // Desfazer remove a conclusão e o XP correspondente.
    await user.click(screen.getByRole('button', { name: 'Desfazer conclusão de Ler 10 páginas' }));
    await screen.findByRole('button', { name: 'Concluir Ler 10 páginas' });
    expect(await db.completions.count()).toBe(0);
    expect(await db.progressEvents.count()).toBe(0);

    // Clique duplo não duplica registro (idempotência).
    await user.click(screen.getByRole('button', { name: 'Concluir Ler 10 páginas' }));
    await screen.findByRole('button', { name: 'Desfazer conclusão de Ler 10 páginas' });
    expect(await db.completions.count()).toBe(1);

    // “Recarregar”: desmonta e monta o app de novo a partir do IndexedDB.
    first.unmount();
    render(<App />);
    expect(await screen.findByRole('button', { name: 'Desfazer conclusão de Ler 10 páginas' })).toBeInTheDocument();

    window.location.hash = `#/habitos/${habit.id}`;
    expect(await screen.findByRole('heading', { name: 'Ler 10 páginas' })).toBeInTheDocument();
    expect((await screen.findAllByText('1 ocorrência')).length).toBeGreaterThanOrEqual(1);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(xhrOpen).not.toHaveBeenCalled();
  });
});

describe('Kai opcional e honesto', () => {
  it('com Kai autorizado mas sem servidor: só chama /api, não envia o nome e não inventa sugestões', async () => {
    const user = userEvent.setup();
    render(<App />);
    await walkOnboardingTo(user, { kai: true });
    await user.click(screen.getByRole('button', { name: 'Pedir rascunho ao Kai' }));
    expect(await screen.findByText('O Kai não respondeu')).toBeInTheDocument();
    expect(screen.queryByText('Sugestão do Kai')).not.toBeInTheDocument();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/kai/plan');
    const body = String(init?.body);
    expect(body).not.toContain('Leo');
    expect(JSON.parse(body).context.profile).toEqual({ mainGoal: 'Ler mais e dormir melhor' });

    // A configuração manual continua possível.
    await user.click(screen.getByRole('button', { name: 'Criar do zero' }));
    expect(await screen.findByRole('dialog', { name: 'Novo hábito' })).toBeInTheDocument();
  });

  it('Kai desligado: a tela explica e nenhuma verificação de servidor é feita', async () => {
    await seedProfile();
    window.location.hash = '#/kai';
    render(<App />);
    expect(await screen.findByText('O Kai está desativado')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('servidor sem chave: mostra indisponível com instruções, sem resposta fictícia', async () => {
    await seedProfile({ kai: true });
    fetchMock.mockImplementation(async () =>
      new Response(JSON.stringify({ ok: true, version: '1.0.0', kai: { enabled: false, reason: 'ANTHROPIC_API_KEY não definida no servidor.' }, calendar: { enabled: false, reason: 'x' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    window.location.hash = '#/kai';
    render(<App />);
    expect(await screen.findByText('Kai indisponível')).toBeInTheDocument();
    expect(screen.getByText('ANTHROPIC_API_KEY não definida no servidor.')).toBeInTheDocument();
    expect(fetchMock.mock.calls.every(([u]) => u === '/api/health')).toBe(true);
  });
});

describe('estados vazios e privacidade', () => {
  it('relatórios sem registros mostram estado vazio, sem números de enfeite', async () => {
    await seedProfile();
    window.location.hash = '#/relatorios';
    render(<App />);
    expect(await screen.findByText('Os relatórios nascem dos seus registros')).toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('diário salva localmente e avisa que o Kai não lê sem autorização específica', async () => {
    const user = userEvent.setup();
    await seedProfile({ kai: true });
    window.location.hash = '#/diario';
    render(<App />);
    expect(await screen.findByText('O Kai não lê o seu Diário.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Escrita livre'), 'Hoje estudei duas horas.');
    await user.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(async () => expect(await db.journal.count()).toBe(1));
    expect((await db.journal.toArray())[0].text).toBe('Hoje estudei duas horas.');

    // Com a autorização do Diário, cada entrada ganha um controle próprio.
    await setConsent('kaiJournal', true);
    expect(await screen.findByRole('switch', { name: 'Permitir que o Kai leia esta entrada' })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
