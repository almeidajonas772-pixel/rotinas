import type { Context } from 'hono';
import { Hono } from 'hono';
import {
  APP_CALENDAR_NAME,
  calendarCommitRequestSchema,
  calendarConnectRequestSchema,
  calendarEventsRequestSchema,
  calendarPreviewRequestSchema,
  freeBusyRequestSchema,
  GOOGLE_SCOPES,
  type BusyBlock,
  type CalendarAccess,
  type CalendarBlock,
  type CalendarErrorCode,
  type CalendarStatus,
} from '../../shared/calendar';
import type { ServerConfig } from '../config';
import { googleEventId, randomNonce, sha256, signPayload, verifyPayload, type SignedPayload } from '../crypto';
import type { Logger } from '../infra';
import { buildAuthUrl, createAppCalendar, exchangeCode, GoogleApiError, insertEvent, listEvents, queryFreeBusy, refreshAccessToken, revokeToken, type FetchLike, type OAuthClient } from './google';
import type { StoredTokens, TokenStore } from './token-store';

const STATE_TTL_MS = 10 * 60_000;
const PREVIEW_TTL_MS = 10 * 60_000;

const STATUS: Record<CalendarErrorCode, 400 | 401 | 403 | 409 | 410 | 429 | 502 | 503> = {
  calendar_disabled: 503,
  not_connected: 409,
  scope_missing: 403,
  invalid_request: 400,
  preview_expired: 410,
  provider_error: 502,
  unauthorized: 401,
  forbidden_origin: 403,
  server_locked: 503,
  rate_limited: 429,
};

export const SCOPES_FOR: Record<CalendarAccess, string[]> = {
  availability: [GOOGLE_SCOPES.availability],
  events: [GOOGLE_SCOPES.availability, GOOGLE_SCOPES.events],
  write: [GOOGLE_SCOPES.availability, GOOGLE_SCOPES.write],
};

export interface CalendarDeps {
  config: ServerConfig;
  store?: TokenStore;
  fetch: FetchLike;
  logger: Logger;
  now?: () => number;
}

interface StatePayload extends SignedPayload {
  access: CalendarAccess;
  n: string;
}

interface PreviewPayload extends SignedPayload {
  h: string;
  n: string;
}

function canonicalBlocks(blocks: readonly CalendarBlock[]): string {
  return JSON.stringify(blocks.map((b) => [b.title, b.start, b.end, b.timeZone, b.description ?? '']));
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch);
}

/**
 * Página mostrada ao fim do OAuth. Não redireciona sozinha: no iPad, com o app instalado na
 * Tela de Início, o Google abre numa janela à parte (com armazenamento próprio). Os tokens já
 * ficaram no servidor; o app atualiza o estado quando volta ao primeiro plano.
 */
export function callbackPage(ok: boolean, message: string): string {
  const title = ok ? 'Google Agenda conectado' : 'Conexão não concluída';
  const status = ok ? 'conectado' : 'erro';
  const link = `/#/calendario?status=${status}${ok ? '' : `&motivo=${encodeURIComponent(message)}`}`;
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} — Rotinas</title>
<style>
:root { color-scheme: light dark; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
main { max-width: 32rem; padding: 2rem 1.25rem; }
h1 { font-size: 1.6rem; margin: 0 0 .75rem; }
p { line-height: 1.55; margin: 0 0 1rem; }
.mark { font-size: 2.2rem; margin-bottom: .5rem; }
a { display: inline-block; margin-top: .5rem; padding: .7rem 1rem; border-radius: .6rem; border: 1px solid currentColor; color: inherit; text-decoration: none; font-weight: 600; }
.muted { opacity: .8; font-size: .95rem; }
</style>
</head>
<body>
<main>
<p class="mark" aria-hidden="true">${ok ? '✓' : '!'}</p>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
<p class="muted">Volte ao Rotinas. Se esta tela abriu por cima do app instalado (iPad/iPhone), toque em <strong>OK</strong> ou <strong>Concluído</strong> no canto. Se abriu numa aba nova, pode fechá-la: o app atualiza a conexão sozinho.</p>
<a href="${escapeHtml(link)}">Abrir o Rotinas nesta janela</a>
</main>
</body>
</html>`;
}

export function calendarRoutes(deps: CalendarDeps): Hono {
  const app = new Hono();
  const now = deps.now ?? Date.now;
  const cfg = deps.config.calendar;
  const signingKey = deps.config.secrets.signingKey;
  const usedStates = new Map<string, number>();
  const client: OAuthClient | null =
    cfg.enabled && cfg.clientId && cfg.clientSecret && cfg.redirectUri && signingKey ? { clientId: cfg.clientId, clientSecret: cfg.clientSecret, redirectUri: cfg.redirectUri } : null;

  const fail = (c: Context, code: CalendarErrorCode, message: string) => c.json({ ok: false, error: { code, message } }, STATUS[code]);
  const log = (route: string, status: number, started: number, code?: string) => deps.logger({ route: `calendar/${route}`, status, ms: now() - started, code });

  function pruneStates() {
    const t = now();
    for (const [k, at] of usedStates) if (t - at > STATE_TTL_MS) usedStates.delete(k);
  }

  async function status(): Promise<CalendarStatus> {
    if (!client || !deps.store) {
      return { configured: false, reason: cfg.reason, connected: false, scopes: [], canReadAvailability: false, canReadEvents: false, canWrite: false };
    }
    const tokens = await deps.store.load();
    const scopes = tokens?.scopes ?? [];
    return {
      configured: true,
      connected: Boolean(tokens?.refreshToken),
      scopes,
      canReadAvailability: Boolean(tokens) && scopes.includes(GOOGLE_SCOPES.availability),
      canReadEvents: Boolean(tokens) && scopes.includes(GOOGLE_SCOPES.events),
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
        // Acesso revogado ou expirado no Google: apaga os tokens do servidor.
        await deps.store.clear();
        return null;
      }
      throw error;
    }
  }

  app.get('/status', async (c) => {
    const started = now();
    try {
      const s = await status();
      log('status', 200, started);
      return c.json({ ok: true, data: s });
    } catch {
      log('status', 502, started, 'storage_error');
      return fail(c, 'provider_error', 'O armazenamento da camada privada não respondeu.');
    }
  });

  app.post('/connect', async (c) => {
    const started = now();
    if (!client || !signingKey) return fail(c, 'calendar_disabled', cfg.reason ?? 'Google Calendar não configurado no servidor.');
    const parsed = calendarConnectRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, 'invalid_request', 'Pedido de conexão inválido.');
    const state = signPayload({ typ: 'oauth-state', exp: now() + STATE_TTL_MS, access: parsed.data.access, n: randomNonce() } satisfies StatePayload, signingKey);
    log('connect', 200, started);
    return c.json({ ok: true, data: { url: buildAuthUrl(client, SCOPES_FOR[parsed.data.access], state) } });
  });

  /** Retorno do Google (navegação, não fetch): valida o state assinado, troca o código e mostra uma página de conclusão. */
  app.get('/callback', async (c) => {
    const started = now();
    const page = (ok: boolean, message: string, code?: string) => {
      log('callback', ok ? 200 : 400, started, code);
      c.header('content-type', 'text/html; charset=utf-8');
      return c.body(callbackPage(ok, message), ok ? 200 : 400);
    };
    if (deps.config.lockReason) return page(false, 'O servidor está bloqueado até a senha ROTINAS_SERVER_TOKEN ser configurada.', 'locked');
    if (!client || !deps.store || !signingKey) return page(false, 'A integração não está configurada no servidor.', 'disabled');
    const url = new URL(c.req.url);
    const stateParam = url.searchParams.get('state') ?? '';
    const state = verifyPayload<StatePayload>(stateParam, signingKey, 'oauth-state', now());
    pruneStates();
    if (!state || usedStates.has(state.n)) return page(false, 'O pedido expirou ou já foi usado. Volte ao Rotinas e toque em conectar de novo.', 'invalid_state');
    usedStates.set(state.n, now());
    if (url.searchParams.get('error')) return page(false, 'O acesso não foi autorizado no Google. Nada foi conectado.', 'denied');
    const code = url.searchParams.get('code');
    if (!code) return page(false, 'A resposta do Google veio sem código de autorização.', 'no_code');
    try {
      const tokens = await exchangeCode(deps.fetch, client, code);
      const previous = await deps.store.load();
      const refreshToken = tokens.refresh_token ?? previous?.refreshToken;
      if (!refreshToken) return page(false, 'O Google não enviou o token de renovação. Remova o acesso do app em myaccount.google.com/permissions e conecte de novo.', 'no_refresh');
      const granted = (tokens.scope ?? '').split(' ').filter(Boolean);
      await deps.store.save({
        refreshToken,
        accessToken: tokens.access_token,
        expiresAt: now() + tokens.expires_in * 1000,
        // Com include_granted_scopes, o Google devolve a união de tudo o que já foi concedido.
        scopes: granted.length > 0 ? [...new Set(granted)] : (previous?.scopes ?? []),
        authorizedAt: new Date(now()).toISOString(),
        calendarId: previous?.calendarId,
      });
      if (!granted.includes(GOOGLE_SCOPES.availability)) return page(false, 'A permissão de disponibilidade não foi concedida. Marque a caixa de permissão na tela do Google.', 'scope_denied');
      const extra = state.access === 'events' && !granted.includes(GOOGLE_SCOPES.events) ? ' A leitura de eventos não foi autorizada; o app usa só livre/ocupado.' : '';
      return page(true, `Pronto: o Rotinas já pode usar o seu Google Agenda.${extra}`);
    } catch {
      return page(false, 'Falha ao concluir a autorização com o Google. Tente conectar de novo.', 'exchange_failed');
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

  /** Eventos da agenda principal (só leitura): título, horário, cor e disponibilidade. Nada é guardado no servidor. */
  app.post('/events', async (c) => {
    const started = now();
    if (!client) return fail(c, 'calendar_disabled', cfg.reason ?? 'Google Calendar não configurado.');
    const parsed = calendarEventsRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, 'invalid_request', 'Intervalo inválido (máximo de 31 dias).');
    try {
      const auth = await accessToken();
      if (!auth) return fail(c, 'not_connected', 'Google Calendar não conectado.');
      if (!auth.tokens.scopes.includes(GOOGLE_SCOPES.events)) return fail(c, 'scope_missing', 'A leitura de eventos não foi autorizada. Conecte com "Ver meus eventos".');
      const events = await listEvents(deps.fetch, auth.token, 'primary', parsed.data, 'primary');
      log('events', 200, started);
      return c.json({ ok: true, data: { events } });
    } catch {
      log('events', 502, started, 'provider_error');
      return fail(c, 'provider_error', 'Não foi possível ler os eventos do Google agora.');
    }
  });

  /** Prévia: valida os blocos, verifica conflitos agora e devolve um comprovante assinado (10 minutos). */
  app.post('/preview', async (c) => {
    const started = now();
    if (!client || !signingKey) return fail(c, 'calendar_disabled', cfg.reason ?? 'Google Calendar não configurado.');
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
      const expiresAt = now() + PREVIEW_TTL_MS;
      const previewToken = signPayload({ typ: 'calendar-preview', exp: expiresAt, h: sha256(canonicalBlocks(blocks)), n: randomNonce() } satisfies PreviewPayload, signingKey);
      const withConflicts = blocks.map((b) => ({ ...b, conflicts: busy.filter((x) => Date.parse(x.start) < Date.parse(b.end) && Date.parse(b.start) < Date.parse(x.end)) }));
      log('preview', 200, started);
      return c.json({ ok: true, data: { previewToken, expiresAt: new Date(expiresAt).toISOString(), blocks: withConflicts } });
    } catch {
      log('preview', 502, started, 'provider_error');
      return fail(c, 'provider_error', 'Não foi possível preparar a prévia no Google.');
    }
  });

  /**
   * Escrita: só com o comprovante de uma prévia recente, os mesmos blocos e `confirm: true`.
   * Cada evento recebe um id derivado do comprovante: repetir a confirmação não duplica nada.
   */
  app.post('/commit', async (c) => {
    const started = now();
    if (!client || !deps.store || !signingKey) return fail(c, 'calendar_disabled', cfg.reason ?? 'Google Calendar não configurado.');
    const parsed = calendarCommitRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, 'invalid_request', 'Confirmação ausente: a criação de eventos exige uma prévia, os mesmos blocos e confirm: true.');
    const preview = verifyPayload<PreviewPayload>(parsed.data.previewToken, signingKey, 'calendar-preview', now());
    if (!preview) return fail(c, 'preview_expired', 'A prévia expirou ou é inválida. Gere uma nova prévia.');
    if (preview.h !== sha256(canonicalBlocks(parsed.data.blocks))) return fail(c, 'invalid_request', 'Os blocos não conferem com a prévia confirmada. Gere uma nova prévia.');
    const blocks = parsed.data.blocks;
    const created: Array<{ index: number; eventId: string }> = [];
    let calendarId: string | undefined;
    try {
      const auth = await accessToken();
      if (!auth) return fail(c, 'not_connected', 'Google Calendar não conectado.');
      if (!auth.tokens.scopes.includes(GOOGLE_SCOPES.write)) return fail(c, 'scope_missing', 'Permissão para criar blocos não concedida.');
      calendarId = auth.tokens.calendarId;
      if (!calendarId) {
        calendarId = await createAppCalendar(deps.fetch, auth.token, blocks[0].timeZone);
        await deps.store.save({ ...auth.tokens, calendarId });
      }
      for (const [index, block] of blocks.entries()) {
        const eventId = await insertEvent(deps.fetch, auth.token, calendarId, { ...block, id: googleEventId(`${preview.n}:${index}`) });
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
              message: `O Google criou ${created.length} de ${blocks.length} blocos e falhou nos demais. Os criados foram registrados; confirme de novo para tentar os que faltaram (sem duplicar).`,
              partial: { calendarId, created },
            },
          },
          STATUS.provider_error,
        );
      }
      return fail(c, 'provider_error', 'O Google não confirmou a criação dos eventos. Nada foi registrado; tente de novo (não haverá duplicatas).');
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
    log('disconnect', 200, started);
    return c.json({ ok: true, data: { revoked } });
  });

  app.all('*', (c) => fail(c, 'invalid_request', 'Rota de calendário inexistente.'));
  return app;
}
