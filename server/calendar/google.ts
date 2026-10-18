import { APP_CALENDAR_NAME, type BusyBlock } from '../../shared/calendar';

/**
 * Cliente mínimo da API do Google (OAuth 2.0 para apps web + Calendar v3) via fetch.
 * Endpoints conferidos na documentação oficial (developers.google.com) em out/2026.
 */

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const GOOGLE_CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class GoogleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason?: string,
  ) {
    super(message);
    this.name = 'GoogleApiError';
  }
}

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function buildAuthUrl(client: OAuthClient, scopes: string[], state: string): string {
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    access_type: 'offline',
    include_granted_scopes: 'true',
    state,
    prompt: 'consent',
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  token_type: string;
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function exchangeCode(fetchFn: FetchLike, client: OAuthClient, code: string): Promise<TokenResponse> {
  const res = await fetchFn(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: client.clientId, client_secret: client.clientSecret, redirect_uri: client.redirectUri, grant_type: 'authorization_code' }).toString(),
  });
  const body = await readJson(res);
  if (!res.ok) throw new GoogleApiError('O Google recusou a troca do código de autorização.', res.status, String(body.error ?? ''));
  return body as unknown as TokenResponse;
}

export async function refreshAccessToken(fetchFn: FetchLike, client: OAuthClient, refreshToken: string): Promise<TokenResponse> {
  const res = await fetchFn(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ refresh_token: refreshToken, client_id: client.clientId, client_secret: client.clientSecret, grant_type: 'refresh_token' }).toString(),
  });
  const body = await readJson(res);
  if (!res.ok) throw new GoogleApiError('O Google recusou a renovação do acesso.', res.status, String(body.error ?? ''));
  return body as unknown as TokenResponse;
}

export async function revokeToken(fetchFn: FetchLike, token: string): Promise<boolean> {
  const res = await fetchFn(GOOGLE_REVOKE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }).toString(),
  });
  return res.ok;
}

async function api(fetchFn: FetchLike, accessToken: string, path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const res = await fetchFn(`${GOOGLE_CALENDAR_API}${path}`, {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
  });
  const body = await readJson(res);
  if (!res.ok) {
    const err = body.error as { message?: string; errors?: Array<{ reason?: string }> } | undefined;
    throw new GoogleApiError('A API do Google Calendar retornou um erro.', res.status, err?.errors?.[0]?.reason);
  }
  return body;
}

/** Consulta apenas intervalos ocupados (sem títulos ou detalhes dos eventos). */
export async function queryFreeBusy(
  fetchFn: FetchLike,
  accessToken: string,
  range: { timeMin: string; timeMax: string; timeZone: string },
  calendarIds: string[],
): Promise<BusyBlock[]> {
  const body = await api(fetchFn, accessToken, '/freeBusy', {
    method: 'POST',
    body: JSON.stringify({ timeMin: range.timeMin, timeMax: range.timeMax, timeZone: range.timeZone, items: calendarIds.map((id) => ({ id })) }),
  });
  const calendars = (body.calendars ?? {}) as Record<string, { busy?: Array<{ start: string; end: string }> }>;
  const busy: BusyBlock[] = [];
  for (const cal of Object.values(calendars)) for (const b of cal.busy ?? []) busy.push({ start: b.start, end: b.end });
  return busy.sort((a, b) => (a.start < b.start ? -1 : 1));
}

/** Cria a agenda secundária do app (escopo calendar.app.created). */
export async function createAppCalendar(fetchFn: FetchLike, accessToken: string, timeZone: string): Promise<string> {
  const body = await api(fetchFn, accessToken, '/calendars', {
    method: 'POST',
    body: JSON.stringify({ summary: APP_CALENDAR_NAME, description: 'Blocos de tempo confirmados no app Rotinas.', timeZone }),
  });
  return String(body.id);
}

export async function insertEvent(
  fetchFn: FetchLike,
  accessToken: string,
  calendarId: string,
  event: { title: string; start: string; end: string; timeZone: string; description?: string },
): Promise<string> {
  const body = await api(fetchFn, accessToken, `/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: 'POST',
    body: JSON.stringify({
      summary: event.title,
      description: event.description,
      start: { dateTime: event.start, timeZone: event.timeZone },
      end: { dateTime: event.end, timeZone: event.timeZone },
    }),
  });
  return String(body.id);
}
