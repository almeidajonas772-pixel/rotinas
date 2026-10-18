// @vitest-environment node
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GOOGLE_SCOPES } from '../../shared/calendar';
import { createApp } from '../../server/app';
import { decrypt, encrypt, EncryptedKvTokenStore, MemoryTokenStore } from '../../server/calendar/token-store';
import { normalizeEvent } from '../../server/calendar/google';
import { loadConfig } from '../../server/config';
import { googleEventId, signPayload, verifyPayload } from '../../server/crypto';
import { FileKv, MemoryKv } from '../../server/storage';

/**
 * Testes LOCAIS da integração com o Google Calendar: as respostas do Google são simuladas
 * por um fetch falso. Eles não provam a integração real, que exige credenciais OAuth
 * configuradas pela pessoa (ver README, “Conectar o Google Calendar”).
 */

const ORIGIN = 'http://127.0.0.1:5173';
const KEY = randomBytes(32).toString('base64');

interface Call {
  url: string;
  method: string;
  body: string;
}

function fakeGoogle(grantedScopes: string[]) {
  const calls: Call[] = [];
  const created = new Map<string, Set<string>>();
  let eventSeq = 0;
  const fetchFn = async (input: string, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: String(init?.body ?? '') });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url === 'https://oauth2.googleapis.com/token') {
      return json({ access_token: 'access-1', expires_in: 3600, refresh_token: 'refresh-1', scope: grantedScopes.join(' '), token_type: 'Bearer' });
    }
    if (url === 'https://oauth2.googleapis.com/revoke') return json({});
    if (url.endsWith('/freeBusy')) {
      return json({ calendars: { primary: { busy: [{ start: '2026-10-19T10:00:00Z', end: '2026-10-19T11:00:00Z' }] } } });
    }
    if (url.endsWith('/calendars') && method === 'POST') return json({ id: 'cal-rotinas' });
    if (url.includes('/calendars/primary/events') && method === 'GET') {
      return json({
        items: [
          { id: 'e1', summary: 'Prova de Geografia', status: 'confirmed', colorId: '6', start: { date: '2026-10-20' }, end: { date: '2026-10-21' }, transparency: 'transparent' },
          { id: 'e2', summary: 'Aula de Química', status: 'confirmed', colorId: '8', start: { dateTime: '2026-10-20T10:00:00-03:00' }, end: { dateTime: '2026-10-20T10:50:00-03:00' } },
          { id: 'e3', summary: 'Cancelado', status: 'cancelled', start: { dateTime: '2026-10-20T11:00:00-03:00' }, end: { dateTime: '2026-10-20T12:00:00-03:00' } },
          { id: 'e4', eventType: 'workingLocation', start: { date: '2026-10-20' }, end: { date: '2026-10-21' } },
        ],
      });
    }
    if (url.includes('/events') && method === 'POST') {
      const calendar = url.split('/calendars/')[1]!.split('/')[0]!;
      const ids = created.get(calendar) ?? new Set<string>();
      created.set(calendar, ids);
      const body = JSON.parse(String(init?.body ?? '{}')) as { id?: string };
      if (body.id && ids.has(body.id)) return json({ error: { message: 'duplicate', errors: [{ reason: 'duplicate' }] } }, 409);
      eventSeq += 1;
      const id = body.id ?? `evt-${eventSeq}`;
      ids.add(id);
      return json({ id });
    }
    return json({ error: { message: 'not found' } }, 404);
  };
  return { fetchFn, calls, created };
}

const GOOGLE_ENV = {
  APP_ORIGIN: ORIGIN,
  GOOGLE_CLIENT_ID: 'client-id',
  GOOGLE_CLIENT_SECRET: 'client-secret',
  GOOGLE_REDIRECT_URI: 'http://127.0.0.1:5173/api/calendar/callback',
  TOKEN_ENCRYPTION_KEY: KEY,
};

function setup(scopes: string[], env: Record<string, string> = {}, fetchOverride?: (input: string, init?: RequestInit) => Promise<Response>) {
  const config = loadConfig({ ...GOOGLE_ENV, ...env });
  const google = fakeGoogle(scopes);
  const store = new MemoryTokenStore();
  const app = createApp({ config, tokenStore: store, fetch: fetchOverride ?? google.fetchFn, logger: () => undefined });
  const headers = (extra: Record<string, string> = {}) => ({ 'content-type': 'application/json', origin: ORIGIN, ...extra });
  const post = (path: string, body: unknown, extra: Record<string, string> = {}) => app.request(path, { method: 'POST', headers: headers(extra), body: JSON.stringify(body) });
  const connectAndAuthorize = async (access: 'availability' | 'events' | 'write', extra: Record<string, string> = {}) => {
    const res = await post('/api/calendar/connect', { access }, extra);
    const url = new URL((await res.json()).data.url);
    const state = url.searchParams.get('state')!;
    const cb = await app.request(`/api/calendar/callback?state=${encodeURIComponent(state)}&code=codigo`);
    return { url, cb, state };
  };
  return { app, post, store, google, connectAndAuthorize, config };
}

describe('Google Calendar: configuração e escopos mínimos', () => {
  it('sem credenciais fica indisponível de forma honesta', async () => {
    const app = createApp({ config: loadConfig({ APP_ORIGIN: ORIGIN }), logger: () => undefined });
    const status = await (await app.request('/api/calendar/status')).json();
    expect(status.data).toMatchObject({ configured: false, connected: false, canReadEvents: false });
    expect(status.data.reason).toMatch(/GOOGLE_CLIENT_ID/);
    const connect = await app.request('/api/calendar/connect', { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ access: 'availability' }) });
    expect(connect.status).toBe(503);
  });

  it('pede só disponibilidade primeiro, guarda tokens só no servidor e mostra uma página de conclusão', async () => {
    const { connectAndAuthorize, app, store } = setup([GOOGLE_SCOPES.availability]);
    const { url, cb } = await connectAndAuthorize('availability');
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('scope')).toBe(GOOGLE_SCOPES.availability);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('include_granted_scopes')).toBe('true');
    expect(cb.status).toBe(200);
    expect(cb.headers.get('content-type')).toMatch(/text\/html/);
    const html = await cb.text();
    expect(html).toContain('Google Agenda conectado');
    expect(html).not.toContain('refresh-1');
    expect(html).not.toContain('access-1');
    const status = await (await app.request('/api/calendar/status')).json();
    expect(status.data).toMatchObject({ connected: true, canReadAvailability: true, canReadEvents: false, canWrite: false });
    expect(JSON.stringify(status)).not.toContain('refresh-1');
    expect((await store.load())?.refreshToken).toBe('refresh-1');
  });

  it('o state é assinado pelo servidor: forjado, adulterado ou reutilizado é recusado', async () => {
    const { app, post } = setup([GOOGLE_SCOPES.availability]);
    const bad = await app.request('/api/calendar/callback?state=forjado&code=x');
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('Conexão não concluída');
    const res = await post('/api/calendar/connect', { access: 'availability' });
    const state = new URL((await res.json()).data.url).searchParams.get('state')!;
    const tampered = `${state.slice(0, -2)}xx`;
    expect((await app.request(`/api/calendar/callback?state=${encodeURIComponent(tampered)}&code=x`)).status).toBe(400);
    expect((await app.request(`/api/calendar/callback?state=${encodeURIComponent(state)}&code=x`)).status).toBe(200);
    expect((await app.request(`/api/calendar/callback?state=${encodeURIComponent(state)}&code=x`)).status).toBe(400);
  });

  it('consulta só livre/ocupado com o escopo de disponibilidade', async () => {
    const { connectAndAuthorize, post, google } = setup([GOOGLE_SCOPES.availability]);
    await connectAndAuthorize('availability');
    const res = await post('/api/calendar/freebusy', { timeMin: '2026-10-19T00:00:00Z', timeMax: '2026-10-20T00:00:00Z', timeZone: 'America/Sao_Paulo' });
    expect((await res.json()).data.busy).toEqual([{ start: '2026-10-19T10:00:00Z', end: '2026-10-19T11:00:00Z' }]);
    expect(google.calls.some((c) => c.url.includes('/events'))).toBe(false);
    const events = await post('/api/calendar/events', { timeMin: '2026-10-19T00:00:00Z', timeMax: '2026-10-26T00:00:00Z', timeZone: 'America/Sao_Paulo' });
    expect(events.status).toBe(403);
    expect((await events.json()).error.code).toBe('scope_missing');
  });
});

describe('Google Calendar: leitura de eventos (opcional, só leitura)', () => {
  it('pede o escopo mínimo de leitura e devolve só título, horário, cor e disponibilidade', async () => {
    const { connectAndAuthorize, post, google } = setup([GOOGLE_SCOPES.availability, GOOGLE_SCOPES.events]);
    const { url } = await connectAndAuthorize('events');
    expect(url.searchParams.get('scope')).toBe(`${GOOGLE_SCOPES.availability} ${GOOGLE_SCOPES.events}`);
    const res = await post('/api/calendar/events', { timeMin: '2026-10-19T00:00:00Z', timeMax: '2026-10-26T00:00:00Z', timeZone: 'America/Sao_Paulo' });
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.events).toEqual([
      { id: 'e1', title: 'Prova de Geografia', allDay: true, start: '2026-10-20', end: '2026-10-21', busy: false, colorId: '6', calendar: 'primary' },
      { id: 'e2', title: 'Aula de Química', allDay: false, start: '2026-10-20T10:00:00-03:00', end: '2026-10-20T10:50:00-03:00', busy: true, colorId: '8', calendar: 'primary' },
    ]);
    const call = google.calls.find((c) => c.url.includes('/calendars/primary/events'))!;
    const params = new URL(call.url).searchParams;
    expect(params.get('singleEvents')).toBe('true');
    expect(params.get('fields')).toMatch(/^items\(id,summary,status,transparency,colorId,eventType,start,end\)/);
    expect(params.get('fields')).not.toMatch(/description|location|attendees/);
  });

  it('recusa intervalos maiores que 31 dias', async () => {
    const { connectAndAuthorize, post } = setup([GOOGLE_SCOPES.availability, GOOGLE_SCOPES.events]);
    await connectAndAuthorize('events');
    const res = await post('/api/calendar/events', { timeMin: '2026-10-01T00:00:00Z', timeMax: '2026-12-01T00:00:00Z', timeZone: 'America/Sao_Paulo' });
    expect(res.status).toBe(400);
  });

  it('normaliza eventos e descarta título vazio com marcador neutro', () => {
    expect(normalizeEvent({ id: 'x', start: { dateTime: '2026-10-20T08:00:00Z' }, end: { dateTime: '2026-10-20T09:00:00Z' } }, 'primary')?.title).toBe('(sem título)');
    expect(normalizeEvent({ id: 'y', status: 'cancelled', start: { date: '2026-10-20' }, end: { date: '2026-10-21' } }, 'primary')).toBeNull();
  });
});

describe('Google Calendar: proposta exige confirmação antes de qualquer escrita', () => {
  const blocks = [
    { title: 'Ler', start: '2026-10-19T10:30:00Z', end: '2026-10-19T11:00:00Z', timeZone: 'America/Sao_Paulo' },
    { title: 'Ler', start: '2026-10-20T22:00:00Z', end: '2026-10-20T22:30:00Z', timeZone: 'America/Sao_Paulo' },
  ];

  it('sem escopo de escrita a prévia é recusada', async () => {
    const { connectAndAuthorize, post } = setup([GOOGLE_SCOPES.availability]);
    await connectAndAuthorize('availability');
    const res = await post('/api/calendar/preview', { blocks });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('scope_missing');
  });

  it('prévia não escreve; commit exige comprovante válido, os mesmos blocos e confirm: true; repetir não duplica', async () => {
    const { connectAndAuthorize, post, google } = setup([GOOGLE_SCOPES.availability, GOOGLE_SCOPES.write]);
    await connectAndAuthorize('write');
    const preview = await (await post('/api/calendar/preview', { blocks })).json();
    expect(preview.ok).toBe(true);
    expect(preview.data.blocks[0].conflicts).toHaveLength(1);
    expect(preview.data.blocks[1].conflicts).toHaveLength(0);
    const writesBefore = google.calls.filter((c) => c.method === 'POST' && (c.url.includes('/events') || c.url.endsWith('/calendars')));
    expect(writesBefore).toHaveLength(0);

    const token = preview.data.previewToken as string;
    expect((await post('/api/calendar/commit', { previewToken: token, blocks })).status).toBe(400);
    expect((await post('/api/calendar/commit', { previewToken: token, blocks, confirm: 'sim' })).status).toBe(400);
    expect((await post('/api/calendar/commit', { previewToken: `${token.slice(0, -3)}abc`, blocks, confirm: true })).status).toBe(410);
    const altered = [{ ...blocks[0], start: '2026-10-19T09:00:00Z' }, blocks[1]];
    expect((await post('/api/calendar/commit', { previewToken: token, blocks: altered, confirm: true })).status).toBe(400);

    const commit = await (await post('/api/calendar/commit', { previewToken: token, blocks, confirm: true })).json();
    expect(commit.ok).toBe(true);
    expect(commit.data.calendarId).toBe('cal-rotinas');
    expect(commit.data.created).toHaveLength(2);
    for (const c of commit.data.created) expect(c.eventId).toMatch(/^[a-v0-9]{5,1024}$/);
    const created = google.calls.filter((c) => c.method === 'POST' && c.url.includes('/calendars/cal-rotinas/events'));
    expect(created).toHaveLength(2);
    expect(JSON.parse(created[0].body)).toMatchObject({ summary: 'Ler', start: { dateTime: blocks[0].start, timeZone: 'America/Sao_Paulo' } });

    // Confirmar de novo (ex.: a resposta se perdeu) não cria eventos duplicados.
    const again = await (await post('/api/calendar/commit', { previewToken: token, blocks, confirm: true })).json();
    expect(again.data.created).toEqual(commit.data.created);
    expect(google.created.get('cal-rotinas')?.size).toBe(2);
  });

  it('desconectar revoga no Google e apaga os tokens', async () => {
    const { connectAndAuthorize, post, store, google } = setup([GOOGLE_SCOPES.availability]);
    await connectAndAuthorize('availability');
    const res = await (await post('/api/calendar/disconnect', {})).json();
    expect(res.data.revoked).toBe(true);
    expect(google.calls.some((c) => c.url === 'https://oauth2.googleapis.com/revoke' && c.body.includes('refresh-1'))).toBe(true);
    expect(await store.load()).toBeNull();
  });
});

describe('Google Calendar: falhas do provedor', () => {
  const blocks = [
    { title: 'Ler', start: '2026-10-19T10:30:00Z', end: '2026-10-19T11:00:00Z', timeZone: 'America/Sao_Paulo' },
    { title: 'Ler', start: '2026-10-20T22:00:00Z', end: '2026-10-20T22:30:00Z', timeZone: 'America/Sao_Paulo' },
    { title: 'Ler', start: '2026-10-21T22:00:00Z', end: '2026-10-21T22:30:00Z', timeZone: 'America/Sao_Paulo' },
  ];

  it('falha no meio do lote devolve o que já foi criado; tentar de novo completa sem duplicar', async () => {
    const base = fakeGoogle([GOOGLE_SCOPES.availability, GOOGLE_SCOPES.write]);
    let inserts = 0;
    let failSecond = true;
    // A segunda inserção de evento falha no Google (só na primeira tentativa).
    const failing = async (input: string, init?: RequestInit) => {
      if (String(input).includes('/events') && init?.method === 'POST') {
        inserts += 1;
        if (failSecond && inserts === 2) {
          failSecond = false;
          return new Response(JSON.stringify({ error: { message: 'backendError', errors: [{ reason: 'backendError' }] } }), { status: 503, headers: { 'content-type': 'application/json' } });
        }
      }
      return base.fetchFn(input, init);
    };
    const { post, connectAndAuthorize } = setup([GOOGLE_SCOPES.availability, GOOGLE_SCOPES.write], {}, failing);
    await connectAndAuthorize('write');
    const pv = await (await post('/api/calendar/preview', { blocks })).json();
    const first = await post('/api/calendar/commit', { previewToken: pv.data.previewToken, blocks, confirm: true });
    expect(first.status).toBe(502);
    const body = await first.json();
    expect(body.error.partial.calendarId).toBe('cal-rotinas');
    expect(body.error.partial.created).toHaveLength(1);
    expect(body.error.message).toMatch(/1 de 3 blocos/);

    const retry = await (await post('/api/calendar/commit', { previewToken: pv.data.previewToken, blocks, confirm: true })).json();
    expect(retry.ok).toBe(true);
    expect(retry.data.created).toHaveLength(3);
    expect(retry.data.created[0].eventId).toBe(body.error.partial.created[0].eventId);
    expect(base.created.get('cal-rotinas')?.size).toBe(3);
  });

  it('acesso revogado ou expirado no Google (invalid_grant) apaga os tokens e mostra desconectado', async () => {
    let t = Date.parse('2026-10-17T12:00:00Z');
    const base = fakeGoogle([GOOGLE_SCOPES.availability]);
    const fetchFn = async (input: string, init?: RequestInit) => {
      if (String(input) === 'https://oauth2.googleapis.com/token' && String(init?.body).includes('grant_type=refresh_token')) {
        return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
      return base.fetchFn(input, init);
    };
    const config = loadConfig(GOOGLE_ENV);
    const store = new MemoryTokenStore();
    const app = createApp({ config, tokenStore: store, fetch: fetchFn, logger: () => undefined, now: () => t });
    const p = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify(body) });
    const state = new URL((await (await p('/api/calendar/connect', { access: 'availability' })).json()).data.url).searchParams.get('state')!;
    await app.request(`/api/calendar/callback?state=${encodeURIComponent(state)}&code=x`);
    expect((await (await app.request('/api/calendar/status')).json()).data.connected).toBe(true);

    t += 2 * 3600_000; // access token vencido → servidor tenta renovar
    const res = await p('/api/calendar/freebusy', { timeMin: '2026-10-19T00:00:00Z', timeMax: '2026-10-20T00:00:00Z', timeZone: 'America/Sao_Paulo' });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('not_connected');
    expect(await store.load()).toBeNull();
    expect((await (await app.request('/api/calendar/status')).json()).data.connected).toBe(false);
  });
});

describe('na nuvem (Vercel): senha obrigatória e chaves derivadas', () => {
  const CLOUD = { VERCEL: '1', VERCEL_PROJECT_PRODUCTION_URL: 'rotinas.example.app', GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's', BLOB_STORE_ID: 'store_123' };

  it('sem ROTINAS_SERVER_TOKEN tudo fica bloqueado com o motivo, exceto o retorno do OAuth', async () => {
    const app = createApp({ config: loadConfig(CLOUD), tokenStore: new MemoryTokenStore(), logger: () => undefined });
    const health = await app.request('/api/health');
    expect(health.status).toBe(503);
    expect((await health.json()).error.code).toBe('server_locked');
    expect((await app.request('/api/calendar/status')).status).toBe(503);
    const cb = await app.request('/api/calendar/callback?state=x&code=y');
    expect(cb.status).toBe(400);
    expect(await cb.text()).toContain('bloqueado');
  });

  it('senha curta não destrava o servidor', () => {
    expect(loadConfig({ ...CLOUD, ROTINAS_SERVER_TOKEN: 'curta' }).lockReason).toMatch(/curta demais/);
  });

  it('com senha: deriva as chaves, monta o endereço de retorno e exige o cabeçalho', async () => {
    const config = loadConfig({ ...CLOUD, ROTINAS_SERVER_TOKEN: 'uma-senha-bem-longa' });
    expect(config.lockReason).toBeUndefined();
    expect(config.secrets.source).toBe('ROTINAS_SERVER_TOKEN');
    expect(config.secrets.encryptionKey?.length).toBe(32);
    expect(config.calendar.redirectUri).toBe('https://rotinas.example.app/api/calendar/callback');
    expect(config.calendar.enabled).toBe(true);
    expect(config.storage.kind).toBe('blob');
    const app = createApp({ config, tokenStore: new MemoryTokenStore(), logger: () => undefined });
    expect((await app.request('/api/health')).status).toBe(401);
    const ok = await app.request('/api/health', { headers: { 'x-rotinas-token': 'uma-senha-bem-longa' } });
    const body = await ok.json();
    expect(body).toMatchObject({ runtime: 'vercel', accessTokenRequired: true, storage: { ok: true, kind: 'blob' }, calendar: { enabled: true, redirectUri: 'https://rotinas.example.app/api/calendar/callback' } });
    expect(JSON.stringify(body)).not.toContain('uma-senha-bem-longa');
  });

  it('aceita a própria origem pública atrás do proxy e recusa outras', async () => {
    const config = loadConfig({ ...CLOUD, ROTINAS_SERVER_TOKEN: 'uma-senha-bem-longa' });
    const app = createApp({ config, tokenStore: new MemoryTokenStore(), logger: () => undefined });
    const req = (origin: string) =>
      app.request('/api/calendar/connect', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, 'x-forwarded-host': 'rotinas-xyz.vercel.app', 'x-rotinas-token': 'uma-senha-bem-longa' },
        body: JSON.stringify({ access: 'availability' }),
      });
    expect((await req('https://rotinas-xyz.vercel.app')).status).toBe(200);
    expect((await req('https://rotinas.example.app')).status).toBe(200);
    expect((await req('https://site-malicioso.example')).status).toBe(403);
  });

  it('bloqueia tentativas repetidas de senha errada', async () => {
    const config = loadConfig({ ...CLOUD, ROTINAS_SERVER_TOKEN: 'uma-senha-bem-longa' });
    const app = createApp({ config, tokenStore: new MemoryTokenStore(), logger: () => undefined });
    for (let i = 0; i < 10; i++) expect((await app.request('/api/health', { headers: { 'x-rotinas-token': `errada-${i}`, 'x-forwarded-for': '203.0.113.9' } })).status).toBe(401);
    const blocked = await app.request('/api/health', { headers: { 'x-rotinas-token': 'uma-senha-bem-longa', 'x-forwarded-for': '203.0.113.9' } });
    expect(blocked.status).toBe(429);
    const other = await app.request('/api/health', { headers: { 'x-rotinas-token': 'uma-senha-bem-longa', 'x-forwarded-for': '198.51.100.7' } });
    expect(other.status).toBe(200);
  });

  it('sem Blob conectado, o calendário explica o que falta', () => {
    const config = loadConfig({ VERCEL: '1', VERCEL_PROJECT_PRODUCTION_URL: 'r.example.app', ROTINAS_SERVER_TOKEN: 'uma-senha-bem-longa', GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's' });
    expect(config.calendar.enabled).toBe(false);
    expect(config.calendar.reason).toMatch(/Blob/);
  });
});

describe('tokens criptografados em repouso', () => {
  it('cifra e decifra com AES-256-GCM e detecta adulteração', () => {
    const key = randomBytes(32);
    const sealed = encrypt('{"refreshToken":"abc"}', key);
    expect(sealed).not.toContain('abc');
    expect(decrypt(sealed, key)).toBe('{"refreshToken":"abc"}');
    const parts = sealed.split('.');
    parts[3] = Buffer.from('outro conteúdo').toString('base64');
    expect(() => decrypt(parts.join('.'), key)).toThrow();
    expect(() => decrypt(sealed, randomBytes(32))).toThrow();
  });

  it('o armazenamento só recebe o conteúdo cifrado; chave errada vira "desconectado"', async () => {
    const kv = new MemoryKv();
    const key = randomBytes(32);
    const store = new EncryptedKvTokenStore(kv, key);
    await store.save({ refreshToken: 'segredo-do-google', scopes: [GOOGLE_SCOPES.availability], authorizedAt: '2026-10-18T12:00:00Z' });
    const raw = await kv.get('google-calendar.enc');
    expect(raw).not.toContain('segredo-do-google');
    expect((await store.load())?.refreshToken).toBe('segredo-do-google');
    expect(await new EncryptedKvTokenStore(kv, randomBytes(32)).load()).toBeNull();
    await store.clear();
    expect(await kv.get('google-calendar.enc')).toBeNull();
  });

  it('no modo local, o arquivo é gravado só para o dono (permissão 600)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rotinas-kv-'));
    const kv = new FileKv(dir);
    await kv.set('teste.enc', 'conteudo');
    expect(await readFile(join(dir, 'teste.enc'), 'utf8')).toBe('conteudo');
    if (process.platform !== 'win32') expect((await stat(join(dir, 'teste.enc'))).mode & 0o777).toBe(0o600);
    await expect(kv.set('../fora', 'x')).rejects.toThrow();
  });
});

describe('assinaturas e ids determinísticos', () => {
  it('tokens assinados verificam tipo, validade e integridade', () => {
    const key = randomBytes(32);
    const token = signPayload({ typ: 'a', exp: 2000, v: 1 }, key);
    expect(verifyPayload(token, key, 'a', 1000)).toMatchObject({ v: 1 });
    expect(verifyPayload(token, key, 'b', 1000)).toBeNull();
    expect(verifyPayload(token, key, 'a', 3000)).toBeNull();
    expect(verifyPayload(token, randomBytes(32), 'a', 1000)).toBeNull();
  });

  it('ids de evento seguem o formato do Google e são estáveis', () => {
    const id = googleEventId('n:0');
    expect(id).toMatch(/^[a-v0-9]{5,1024}$/);
    expect(googleEventId('n:0')).toBe(id);
    expect(googleEventId('n:1')).not.toBe(id);
  });
});
