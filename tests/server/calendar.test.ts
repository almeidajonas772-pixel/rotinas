// @vitest-environment node
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GOOGLE_SCOPES } from '../../shared/calendar';
import { createApp } from '../../server/app';
import { decrypt, encrypt, MemoryTokenStore } from '../../server/calendar/token-store';
import { loadConfig } from '../../server/config';

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
    if (url.includes('/events') && method === 'POST') {
      eventSeq += 1;
      return json({ id: `evt-${eventSeq}` });
    }
    return json({ error: { message: 'not found' } }, 404);
  };
  return { fetchFn, calls };
}

function setup(scopes: string[], env: Record<string, string> = {}) {
  const config = loadConfig({
    APP_ORIGIN: ORIGIN,
    GOOGLE_CLIENT_ID: 'client-id',
    GOOGLE_CLIENT_SECRET: 'client-secret',
    GOOGLE_REDIRECT_URI: 'http://127.0.0.1:5173/api/calendar/callback',
    TOKEN_ENCRYPTION_KEY: KEY,
    ...env,
  });
  const google = fakeGoogle(scopes);
  const store = new MemoryTokenStore();
  const app = createApp({ config, tokenStore: store, fetch: google.fetchFn, logger: () => undefined });
  const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify(body) });
  const connectAndAuthorize = async (access: 'availability' | 'write') => {
    const res = await post('/api/calendar/connect', { access });
    const url = new URL((await res.json()).data.url);
    const state = url.searchParams.get('state')!;
    const cb = await app.request(`/api/calendar/callback?state=${state}&code=codigo`);
    return { url, cb };
  };
  return { app, post, store, google, connectAndAuthorize };
}

describe('Google Calendar: configuração e escopos mínimos', () => {
  it('sem credenciais fica indisponível de forma honesta', async () => {
    const app = createApp({ config: loadConfig({ APP_ORIGIN: ORIGIN }), logger: () => undefined });
    const status = await (await app.request('/api/calendar/status')).json();
    expect(status.data).toMatchObject({ configured: false, connected: false });
    expect(status.data.reason).toMatch(/GOOGLE_CLIENT_ID/);
    const connect = await app.request('/api/calendar/connect', { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ access: 'availability' }) });
    expect(connect.status).toBe(503);
  });

  it('pede só disponibilidade primeiro e guarda tokens somente no servidor', async () => {
    const { connectAndAuthorize, app, store } = setup([GOOGLE_SCOPES.availability]);
    const { url, cb } = await connectAndAuthorize('availability');
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('scope')).toBe(GOOGLE_SCOPES.availability);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('include_granted_scopes')).toBe('true');
    expect(cb.status).toBe(302);
    expect(cb.headers.get('location')).toBe(`${ORIGIN}/#/calendario?status=conectado`);
    const status = await (await app.request('/api/calendar/status')).json();
    expect(status.data).toMatchObject({ connected: true, canReadAvailability: true, canWrite: false });
    expect(JSON.stringify(status)).not.toContain('refresh-1');
    expect(JSON.stringify(status)).not.toContain('access-1');
    expect((await store.load())?.refreshToken).toBe('refresh-1');
  });

  it('recusa retorno com state inválido ou reutilizado', async () => {
    const { app, post } = setup([GOOGLE_SCOPES.availability]);
    const bad = await app.request('/api/calendar/callback?state=forjado&code=x');
    expect(bad.headers.get('location')).toMatch(/status=erro/);
    const res = await post('/api/calendar/connect', { access: 'availability' });
    const state = new URL((await res.json()).data.url).searchParams.get('state');
    await app.request(`/api/calendar/callback?state=${state}&code=x`);
    const reuse = await app.request(`/api/calendar/callback?state=${state}&code=x`);
    expect(reuse.headers.get('location')).toMatch(/status=erro/);
  });

  it('consulta só livre/ocupado', async () => {
    const { connectAndAuthorize, post, google } = setup([GOOGLE_SCOPES.availability]);
    await connectAndAuthorize('availability');
    const res = await post('/api/calendar/freebusy', { timeMin: '2026-10-19T00:00:00Z', timeMax: '2026-10-20T00:00:00Z', timeZone: 'America/Sao_Paulo' });
    expect((await res.json()).data.busy).toEqual([{ start: '2026-10-19T10:00:00Z', end: '2026-10-19T11:00:00Z' }]);
    expect(google.calls.some((c) => c.url.includes('/events'))).toBe(false);
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

  it('prévia não escreve; commit sem confirmação ou com prévia inválida é recusado; a prévia vale uma vez', async () => {
    const { connectAndAuthorize, post, google } = setup([GOOGLE_SCOPES.availability, GOOGLE_SCOPES.write]);
    await connectAndAuthorize('write');
    const preview = await (await post('/api/calendar/preview', { blocks })).json();
    expect(preview.ok).toBe(true);
    expect(preview.data.blocks[0].conflicts).toHaveLength(1);
    expect(preview.data.blocks[1].conflicts).toHaveLength(0);
    const writesBefore = google.calls.filter((c) => c.method === 'POST' && (c.url.includes('/events') || c.url.endsWith('/calendars')));
    expect(writesBefore).toHaveLength(0);

    expect((await post('/api/calendar/commit', { previewId: preview.data.previewId })).status).toBe(400);
    expect((await post('/api/calendar/commit', { previewId: preview.data.previewId, confirm: 'sim' })).status).toBe(400);
    expect((await post('/api/calendar/commit', { previewId: crypto.randomUUID(), confirm: true })).status).toBe(410);

    const commit = await (await post('/api/calendar/commit', { previewId: preview.data.previewId, confirm: true })).json();
    expect(commit).toEqual({ ok: true, data: { calendarId: 'cal-rotinas', created: [{ index: 0, eventId: 'evt-1' }, { index: 1, eventId: 'evt-2' }] } });
    const created = google.calls.filter((c) => c.url.includes('/calendars/cal-rotinas/events'));
    expect(created).toHaveLength(2);
    expect(JSON.parse(created[0].body)).toMatchObject({ summary: 'Ler', start: { dateTime: blocks[0].start, timeZone: 'America/Sao_Paulo' } });

    const again = await post('/api/calendar/commit', { previewId: preview.data.previewId, confirm: true });
    expect(again.status).toBe(410);
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

  it('falha no meio do lote devolve exatamente o que já foi criado, para não duplicar', async () => {
    const base = fakeGoogle([GOOGLE_SCOPES.availability, GOOGLE_SCOPES.write]);
    let inserts = 0;
    // A segunda inserção de evento falha no Google.
    const failing = async (input: string, init?: RequestInit) => {
      if (String(input).includes('/events') && init?.method === 'POST') {
        inserts += 1;
        if (inserts === 2) return new Response(JSON.stringify({ error: { message: 'backendError', errors: [{ reason: 'backendError' }] } }), { status: 503, headers: { 'content-type': 'application/json' } });
      }
      return base.fetchFn(input, init);
    };
    const config = loadConfig({ APP_ORIGIN: ORIGIN, GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's', GOOGLE_REDIRECT_URI: 'http://127.0.0.1:5173/api/calendar/callback', TOKEN_ENCRYPTION_KEY: KEY });
    const app = createApp({ config, tokenStore: new MemoryTokenStore(), fetch: failing, logger: () => undefined });
    const p = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify(body) });
    const state = new URL((await (await p('/api/calendar/connect', { access: 'write' })).json()).data.url).searchParams.get('state');
    await app.request(`/api/calendar/callback?state=${state}&code=x`);
    const pv = await (await p('/api/calendar/preview', { blocks })).json();
    expect(pv.ok).toBe(true);
    const res = await p('/api/calendar/commit', { previewId: pv.data.previewId, confirm: true });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.partial).toEqual({ calendarId: 'cal-rotinas', created: [{ index: 0, eventId: 'evt-1' }] });
    expect(body.error.message).toMatch(/1 de 3 blocos/);
    expect(inserts).toBe(2);
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
    const config = loadConfig({ APP_ORIGIN: ORIGIN, GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's', GOOGLE_REDIRECT_URI: 'http://127.0.0.1:5173/api/calendar/callback', TOKEN_ENCRYPTION_KEY: KEY });
    const store = new MemoryTokenStore();
    const app = createApp({ config, tokenStore: store, fetch: fetchFn, logger: () => undefined, now: () => t });
    const p = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify(body) });
    const state = new URL((await (await p('/api/calendar/connect', { access: 'availability' })).json()).data.url).searchParams.get('state');
    await app.request(`/api/calendar/callback?state=${state}&code=x`);
    expect((await (await app.request('/api/calendar/status')).json()).data.connected).toBe(true);

    t += 2 * 3600_000; // access token vencido → servidor tenta renovar
    const res = await p('/api/calendar/freebusy', { timeMin: '2026-10-19T00:00:00Z', timeMax: '2026-10-20T00:00:00Z', timeZone: 'America/Sao_Paulo' });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('not_connected');
    expect(await store.load()).toBeNull();
    expect((await (await app.request('/api/calendar/status')).json()).data.connected).toBe(false);
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
});
