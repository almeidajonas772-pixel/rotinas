import { APP_CALENDAR_NAME, type BusyBlock, type GoogleEvent } from '../../shared/calendar';

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

/**
 * Cria um evento com id definido pelo app. Se o Google responder 409 (o id já existe), o evento
 * já foi criado numa tentativa anterior: devolve o mesmo id em vez de duplicar.
 */
export async function insertEvent(
  fetchFn: FetchLike,
  accessToken: string,
  calendarId: string,
  event: { id?: string; title: string; start: string; end: string; timeZone: string; description?: string },
): Promise<string> {
  try {
    const body = await api(fetchFn, accessToken, `/calendars/${encodeURIComponent(calendarId)}/events`, {
      method: 'POST',
      body: JSON.stringify({
        ...(event.id ? { id: event.id } : {}),
        summary: event.title,
        description: event.description,
        start: { dateTime: event.start, timeZone: event.timeZone },
        end: { dateTime: event.end, timeZone: event.timeZone },
      }),
    });
    return String(body.id);
  } catch (error) {
    if (event.id && error instanceof GoogleApiError && error.status === 409) return event.id;
    throw error;
  }
}

interface RawEvent {
  id?: string;
  summary?: string;
  status?: string;
  transparency?: string;
  colorId?: string;
  eventType?: string;
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
}

/** Converte um evento da API no formato mínimo do app; descarta cancelados e "local de trabalho". */
export function normalizeEvent(raw: RawEvent, calendar: GoogleEvent['calendar']): GoogleEvent | null {
  if (!raw.id || raw.status === 'cancelled' || raw.eventType === 'workingLocation') return null;
  const allDay = Boolean(raw.start?.date && !raw.start?.dateTime);
  const start = allDay ? raw.start?.date : raw.start?.dateTime;
  const end = allDay ? (raw.end?.date ?? raw.start?.date) : (raw.end?.dateTime ?? raw.start?.dateTime);
  if (!start || !end) return null;
  const title = (raw.summary ?? '').trim() || '(sem título)';
  return {
    id: raw.id,
    title: title.length > 200 ? `${title.slice(0, 199)}…` : title,
    allDay,
    start,
    end,
    busy: raw.transparency !== 'transparent',
    colorId: raw.colorId && /^\d{1,2}$/.test(raw.colorId) ? raw.colorId : undefined,
    calendar,
  };
}

/**
 * Lê eventos de uma agenda (escopo calendar.events.owned.readonly). Pede só os campos
 * necessários: título, horário, cor e disponibilidade — nunca descrição, local ou participantes.
 */
export async function listEvents(
  fetchFn: FetchLike,
  accessToken: string,
  calendarId: string,
  range: { timeMin: string; timeMax: string; timeZone: string },
  calendar: GoogleEvent['calendar'],
  maxEvents = 250,
): Promise<GoogleEvent[]> {
  const out: GoogleEvent[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 4 && out.length < maxEvents; page++) {
    const params = new URLSearchParams({
      timeMin: new Date(range.timeMin).toISOString(),
      timeMax: new Date(range.timeMax).toISOString(),
      timeZone: range.timeZone,
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: String(Math.min(250, maxEvents)),
      fields: 'items(id,summary,status,transparency,colorId,eventType,start,end),nextPageToken',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const body = await api(fetchFn, accessToken, `/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`, { method: 'GET' });
    for (const raw of (body.items as RawEvent[] | undefined) ?? []) {
      const event = normalizeEvent(raw, calendar);
      if (event) out.push(event);
    }
    pageToken = typeof body.nextPageToken === 'string' ? body.nextPageToken : undefined;
    if (!pageToken) break;
  }
  return out.slice(0, maxEvents);
}
