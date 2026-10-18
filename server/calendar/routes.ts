import { randomBytes, randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import { Hono } from 'hono';
import {
  APP_CALENDAR_NAME,
  calendarCommitRequestSchema,
  calendarConnectRequestSchema,
  calendarPreviewRequestSchema,
  freeBusyRequestSchema,
  GOOGLE_SCOPES,
  type BusyBlock,
  type CalendarBlock,
  type CalendarErrorCode,
  type CalendarStatus,
} from '../../shared/calendar';
import type { ServerConfig } from '../config';
import type { Logger } from '../infra';
import { buildAuthUrl, createAppCalendar, exchangeCode, GoogleApiError, insertEvent, queryFreeBusy, refreshAccessToken, revokeToken, type FetchLike, type OAuthClient } from './google';
import type { StoredTokens, TokenStore } from './token-store';

const STATE_TTL_MS = 10 * 60_000;
const PREVIEW_TTL_MS = 10 * 60_000;

const STATUS: Record<CalendarErrorCode, 400 | 401 | 403 | 409 | 410 | 502 | 503> = {
  calendar_disabled: 503,
  not_connected: 409,
  scope_missing: 403,
  invalid_request: 400,
  preview_expired: 410,
  provider_error: 502,
  unauthorized: 401,
  forbidden_origin: 403,
};

export interface CalendarDeps {
  config: ServerConfig;
  store?: TokenStore;
  fetch: FetchLike;
  logger: Logger;
  now?: () => number;
}

export function calendarRoutes(deps: CalendarDeps): Hono {
  const app = new Hono();
  const now = deps.now ?? Date.now;
  const states = new Map<string, { access: 'availability' | 'write'; createdAt: number }>();
  const previews = new Map<string, { blocks: CalendarBlock[]; createdAt: number }>();
  const cfg = deps.config.calendar;
  const client: OAuthClient | null = cfg.enabled && cfg.clientId && cfg.clientSecret && cfg.redirectUri ? { clientId: cfg.clientId, clientSecret: cfg.clientSecret, redirectUri: cfg.redirectUri } : null;

  const fail = (c: Context, code: CalendarErrorCode, message: string) => c.json({ ok: false, error: { code, message } }, STATUS[code]);
  const log = (route: string, status: number, started: number, code?: string) => deps.logger({ route: `calendar/${route}`, status, ms: now() - started, code });

  function prune() {
    const t = now();
    for (const [k, v] of states) if (t - v.createdAt > STATE_TTL_MS) states.delete(k);
    for (const [k, v] of previews) if (t - v.createdAt > PREVIEW_TTL_MS) previews.delete(k);
  }

  async function status(): Promise<CalendarStatus> {
    if (!client || !deps.store) return { configured: false, reason: cfg.reason, connected: false, scopes: [], canReadAvailability: false, canWrite: false };
    const tokens = await deps.store.load();
    const scopes = tokens?.scopes ?? [];
    return {
      configured: true,
      connected: Boolean(tokens?.refreshToken),
      scopes,
      canReadAvailability: Boolean(tokens) && scopes.includes(GOOGLE_SCOPES.availability),
      canWrite: Boolean(tokens) && scopes.includes(GOOGLE_SCOPES.write),
      calendarName: tokens?.calendarId ? APP_CALENDAR_NAME : undefined,
      authorizedAt: tokens?.authorizedAt,
    };
  }

  /** Access token válido (renova com o refresh token quando faltar menos de 1 minuto). */
  async function accessToken(): Promise<{ token: string; tokens: StoredTokens } | null> {
    if (!client || !deps.store) return null;
    const tokens = await deps.store.load();
    if (!tokens?.refreshToken) return null;
    if (tokens.accessToken && tokens.expiresAt && tokens.expiresAt - now() > 60_000) return { token: tokens.accessToken, tokens };
    try {
      const fresh = await refreshAccessToken(deps.fetch, client, tokens.refreshToken);
      const next: StoredTokens = { ...tokens, accessToken: fresh.access_token, expiresAt: now() + fresh.expires_in * 1000 };
      await deps.store.save(next);
      return { token: fresh.access_token, tokens: next };
    } catch (error) {
      if (error instanceof GoogleApiError && error.reason === 'invalid_grant') {
        // Acesso revogado no Google: apaga os tokens locais do servidor.
        await deps.store.clear();
        return null;
      }
      throw error;
    }
  }

  app.get('/status', async (c) => {
    const started = now();
    const s = await status();
    log('status', 200, started);
    return c.json({ ok: true, data: s });
  });

  app.post('/connect', async (c) => {
    const started = now();
    if (!client) return fail(c, 'calendar_disabled', cfg.reason ?? 'Google Calendar não configurado no servidor.');
    const parsed = calendarConnectRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, 'invalid_request', 'Pedido de conexão inválido.');
    prune();
    const state = randomBytes(24).toString('base64url');
    states.set(state, { access: parsed.data.access, createdAt: now() });
    const scopes = parsed.data.access === 'write' ? [GOOGLE_SCOPES.availability, GOOGLE_SCOPES.write] : [GOOGLE_SCOPES.availability];
    log('connect', 200, started);
    return c.json({ ok: true, data: { url: buildAuthUrl(client, scopes, state) } });
  });

  /** Retorno do Google (navegação, não fetch): valida o state, troca o código e redireciona para o app. */
  app.get('/callback', async (c) => {
    const started = now();
    const back = (status: 'conectado' | 'erro', reason?: string) => {
      const q = new URLSearchParams({ status, ...(reason ? { motivo: reason } : {}) });
      return c.redirect(`${deps.config.appOrigin}/#/calendario?${q.toString()}`, 302);
    };
    if (!client || !deps.store) return back('erro', 'integração não configurada');
    const url = new URL(c.req.url);
    const state = url.searchParams.get('state') ?? '';
    const pending = states.get(state);
    states.delete(state);
    if (!pending || now() - pending.createdAt > STATE_TTL_MS) {
      log('callback', 400, started, 'invalid_state');
      return back('erro', 'pedido expirado ou inválido; tente conectar de novo');
    }
    if (url.searchParams.get('error')) {
      log('callback', 400, started, 'denied');
      return back('erro', 'acesso não autorizado no Google');
    }
    const code = url.searchParams.get('code');
    if (!code) return back('erro', 'resposta do Google sem código');
    try {
      const tokens = await exchangeCode(deps.fetch, client, code);
      const previous = await deps.store.load();
      const refreshToken = tokens.refresh_token ?? previous?.refreshToken;
      if (!refreshToken) return back('erro', 'o Google não enviou o token de renovação; remova o acesso e conecte de novo');
      const granted = (tokens.scope ?? '').split(' ').filter(Boolean);
      await deps.store.save({
        refreshToken,
        accessToken: tokens.access_token,
        expiresAt: now() + tokens.expires_in * 1000,
        scopes: [...new Set([...(previous?.scopes ?? []), ...granted])],
        authorizedAt: new Date(now()).toISOString(),
        calendarId: previous?.calendarId,
      });
      log('callback', 302, started);
      if (!granted.includes(GOOGLE_SCOPES.availability)) return back('erro', 'a permissão de disponibilidade não foi concedida');
      return back('conectado');
    } catch {
      log('callback', 502, started, 'exchange_failed');
      return back('erro', 'falha ao concluir a autorização com o Google');
    }
  });

  app.post('/freebusy', async (c) => {
    const started = now();
    if (!client) return fail(c, 'calendar_disabled', cfg.reason ?? 'Google Calendar não configurado.');
    const parsed = freeBusyRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, 'invalid_request', 'Intervalo inválido.');
    try {
      const auth = await accessToken();
      if (!auth) return fail(c, 'not_connected', 'Google Calendar não conectado.');
      if (!auth.tokens.scopes.includes(GOOGLE_SCOPES.availability)) return fail(c, 'scope_missing', 'Permissão de disponibilidade não concedida.');
      const ids = ['primary', ...(auth.tokens.calendarId ? [auth.tokens.calendarId] : [])];
      const busy = await queryFreeBusy(deps.fetch, auth.token, parsed.data, ids);
      log('freebusy', 200, started);
      return c.json({ ok: true, data: { busy } });
    } catch {
      log('freebusy', 502, started, 'provider_error');
      return fail(c, 'provider_error', 'Não foi possível consultar a disponibilidade no Google.');
    }
  });

  /** Prévia: valida os blocos, verifica conflitos agora e devolve um id de uso único (10 minutos). */
  app.post('/preview', async (c) => {
    const started = now();
    if (!client) return fail(c, 'calendar_disabled', cfg.reason ?? 'Google Calendar não configurado.');
    const parsed = calendarPreviewRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, 'invalid_request', 'Blocos inválidos para a prévia.');
    try {
      const auth = await accessToken();
      if (!auth) return fail(c, 'not_connected', 'Google Calendar não conectado.');
      if (!auth.tokens.scopes.includes(GOOGLE_SCOPES.write)) return fail(c, 'scope_missing', 'Permissão para criar blocos não concedida.');
      const blocks = parsed.data.blocks;
      let busy: BusyBlock[] = [];
      if (auth.tokens.scopes.includes(GOOGLE_SCOPES.availability)) {
        const timeMin = blocks.map((b) => b.start).sort()[0];
        const timeMax = blocks.map((b) => b.end).sort().slice(-1)[0];
        busy = await queryFreeBusy(deps.fetch, auth.token, { timeMin, timeMax, timeZone: blocks[0].timeZone }, ['primary', ...(auth.tokens.calendarId ? [auth.tokens.calendarId] : [])]);
      }
      prune();
      const previewId = randomUUID();
      previews.set(previewId, { blocks, createdAt: now() });
      const withConflicts = blocks.map((b) => ({ ...b, conflicts: busy.filter((x) => Date.parse(x.start) < Date.parse(b.end) && Date.parse(b.start) < Date.parse(x.end)) }));
      log('preview', 200, started);
      return c.json({ ok: true, data: { previewId, expiresAt: new Date(now() + PREVIEW_TTL_MS).toISOString(), blocks: withConflicts } });
    } catch {
      log('preview', 502, started, 'provider_error');
      return fail(c, 'provider_error', 'Não foi possível preparar a prévia no Google.');
    }
  });

  /** Escrita: somente com uma prévia recente e confirmação explícita. Cria exatamente os blocos da prévia. */
  app.post('/commit', async (c) => {
    const started = now();
    if (!client || !deps.store) return fail(c, 'calendar_disabled', cfg.reason ?? 'Google Calendar não configurado.');
    const parsed = calendarCommitRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, 'invalid_request', 'Confirmação ausente: a criação de eventos exige uma prévia e confirm: true.');
    prune();
    const preview = previews.get(parsed.data.previewId);
    if (!preview) return fail(c, 'preview_expired', 'A prévia expirou ou já foi usada. Gere uma nova prévia.');
    previews.delete(parsed.data.previewId);
    const created: Array<{ index: number; eventId: string }> = [];
    let calendarId: string | undefined;
    try {
      const auth = await accessToken();
      if (!auth) return fail(c, 'not_connected', 'Google Calendar não conectado.');
      if (!auth.tokens.scopes.includes(GOOGLE_SCOPES.write)) return fail(c, 'scope_missing', 'Permissão para criar blocos não concedida.');
      calendarId = auth.tokens.calendarId;
      if (!calendarId) {
        calendarId = await createAppCalendar(deps.fetch, auth.token, preview.blocks[0].timeZone);
        await deps.store.save({ ...auth.tokens, calendarId });
      }
      for (const [index, block] of preview.blocks.entries()) {
        const eventId = await insertEvent(deps.fetch, auth.token, calendarId, block);
        created.push({ index, eventId });
      }
      log('commit', 200, started);
      return c.json({ ok: true, data: { calendarId, created } });
    } catch {
      log('commit', 502, started, created.length > 0 ? 'partial_failure' : 'provider_error');
      if (calendarId && created.length > 0) {
        // Informa exatamente o que já existe no Google, para o app registrar e não duplicar ao tentar de novo.
        return c.json(
          {
            ok: false,
            error: {
              code: 'provider_error' as const,
              message: `O Google criou ${created.length} de ${preview.blocks.length} blocos e falhou nos demais. Os criados foram registrados; gere uma nova prévia para tentar os que faltaram.`,
              partial: { calendarId, created },
            },
          },
          STATUS.provider_error,
        );
      }
      return fail(c, 'provider_error', 'O Google não confirmou a criação dos eventos. Nada foi registrado; confira a agenda “Rotinas” no Google antes de tentar de novo.');
    }
  });

  app.post('/disconnect', async (c) => {
    const started = now();
    if (!deps.store) return c.json({ ok: true, data: { revoked: false } });
    const tokens = await deps.store.load();
    let revoked = false;
    if (tokens?.refreshToken) {
      try {
        revoked = await revokeToken(deps.fetch, tokens.refreshToken);
      } catch {
        revoked = false;
      }
    }
    await deps.store.clear();
    previews.clear();
    log('disconnect', 200, started);
    return c.json({ ok: true, data: { revoked } });
  });

  app.all('*', (c) => fail(c, 'invalid_request', 'Rota de calendário inexistente.'));
  return app;
}
