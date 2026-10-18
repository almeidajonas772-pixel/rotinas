import type { BusyBlock, CalendarAccess, CalendarApiResponse, CalendarBlock, CalendarCommitResult, CalendarPreview, CalendarStatus, GoogleEvent } from '../../shared/calendar';
import type { HealthResponse, KaiApiResponse, KaiOutputFor, KaiTask } from '../../shared/kai';
import type { Preferences } from '../domain/schemas';

/**
 * Único ponto de saída de rede do app para a camada privada (mesma origem, rota /api).
 * Antes de qualquer chamada, verifica o consentimento do recurso: com Kai e calendário
 * desligados, nenhuma requisição é feita — nem mesmo a verificação de saúde do servidor.
 */

export type Feature = 'kai' | 'calendar';

export class FeatureDisabledError extends Error {
  constructor(feature: Feature) {
    super(feature === 'kai' ? 'O coaching por IA está desativado.' : 'A integração com calendário externo está desativada.');
    this.name = 'FeatureDisabledError';
  }
}

export class OfflineError extends Error {
  constructor() {
    super('Sem conexão com a internet. O app continua funcionando localmente; recursos externos voltam quando a conexão voltar.');
    this.name = 'OfflineError';
  }
}

export class ServerUnavailableError extends Error {
  /** O endereço respondeu com o app (HTML), não com a camada privada: site publicado sem o servidor. */
  readonly staticOnly: boolean;
  constructor(message = 'A camada privada (servidor do Rotinas) não respondeu. Verifique a publicação — veja Conectar Kai e Google.', staticOnly = false) {
    super(message);
    this.name = 'ServerUnavailableError';
    this.staticOnly = staticOnly;
  }
}

export class UnauthorizedError extends Error {
  constructor() {
    super('O servidor privado recusou o acesso: a senha do servidor está ausente ou incorreta neste aparelho.');
    this.name = 'UnauthorizedError';
  }
}

/** Servidor publicado sem a senha ROTINAS_SERVER_TOKEN: tudo fica bloqueado até ela ser definida. */
export class ServerLockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServerLockedError';
  }
}

export function isFeatureAllowed(feature: Feature, prefs: Preferences): boolean {
  return feature === 'kai' ? prefs.consents.kai.granted : prefs.consents.calendar.granted;
}

interface RequestOptions {
  feature: Feature;
  prefs: Preferences;
  method?: 'GET' | 'POST';
  body?: unknown;
  signal?: AbortSignal;
}

async function apiRequest<T>(path: string, options: RequestOptions): Promise<T> {
  if (!isFeatureAllowed(options.feature, options.prefs)) throw new FeatureDisabledError(options.feature);
  if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new OfflineError();
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.prefs.server.accessToken) headers['x-rotinas-token'] = options.prefs.server.accessToken;
  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? 'POST',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ServerUnavailableError();
  }
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) {
    throw new ServerUnavailableError('A camada privada não está disponível neste endereço: o site foi publicado só com o app, sem o servidor.', true);
  }
  if (response.status === 401) throw new UnauthorizedError();
  const body = (await response.json()) as T;
  const error = (body as { ok?: boolean; error?: { code?: string; message?: string } }).error;
  if (response.status === 503 && error?.code === 'server_locked') throw new ServerLockedError(error.message ?? 'Servidor bloqueado até a senha ser configurada.');
  return body;
}

export async function getHealth(feature: Feature, prefs: Preferences, signal?: AbortSignal): Promise<HealthResponse> {
  const body = await apiRequest<HealthResponse | { ok: false; error: { message: string } }>('/api/health', { feature, prefs, method: 'GET', signal });
  if (!body.ok) throw new ServerUnavailableError(body.error.message);
  return body;
}

export type ServerCheck =
  | { state: 'ok'; health: HealthResponse }
  | { state: 'static'; message: string }
  | { state: 'locked'; message: string }
  | { state: 'unauthorized'; message: string }
  | { state: 'offline'; message: string }
  | { state: 'error'; message: string };

/** Verificação para o assistente de conexão: diz exatamente em que passo a publicação está. */
export async function checkServer(feature: Feature, prefs: Preferences, signal?: AbortSignal): Promise<ServerCheck> {
  try {
    return { state: 'ok', health: await getHealth(feature, prefs, signal) };
  } catch (error) {
    if (error instanceof ServerLockedError) return { state: 'locked', message: error.message };
    if (error instanceof UnauthorizedError) return { state: 'unauthorized', message: error.message };
    if (error instanceof OfflineError) return { state: 'offline', message: error.message };
    if (error instanceof ServerUnavailableError && error.staticOnly) return { state: 'static', message: error.message };
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    return { state: 'error', message: error instanceof Error ? error.message : 'A camada privada não respondeu.' };
  }
}

const KAI_PATHS: Record<KaiTask, string> = {
  chat: '/api/kai/chat',
  plan: '/api/kai/plan',
  'next-step': '/api/kai/next-step',
  'weekly-review': '/api/kai/weekly-review',
  'goal-breakdown': '/api/kai/goal-breakdown',
  nightly: '/api/kai/nightly',
};

export function callKai<T extends KaiTask>(task: T, payload: unknown, prefs: Preferences, signal?: AbortSignal): Promise<KaiApiResponse<KaiOutputFor<T>>> {
  return apiRequest<KaiApiResponse<KaiOutputFor<T>>>(KAI_PATHS[task], { feature: 'kai', prefs, body: payload, signal });
}

export function calendarStatus(prefs: Preferences, signal?: AbortSignal): Promise<CalendarApiResponse<CalendarStatus>> {
  return apiRequest('/api/calendar/status', { feature: 'calendar', prefs, method: 'GET', signal });
}

export function calendarConnect(access: CalendarAccess, prefs: Preferences, signal?: AbortSignal): Promise<CalendarApiResponse<{ url: string }>> {
  return apiRequest('/api/calendar/connect', { feature: 'calendar', prefs, body: { access }, signal });
}

/** Eventos da agenda principal (só leitura; até 31 dias por pedido). */
export function calendarEvents(range: { timeMin: string; timeMax: string; timeZone: string }, prefs: Preferences, signal?: AbortSignal): Promise<CalendarApiResponse<{ events: GoogleEvent[] }>> {
  return apiRequest('/api/calendar/events', { feature: 'calendar', prefs, body: range, signal });
}

export function calendarFreeBusy(range: { timeMin: string; timeMax: string; timeZone: string }, prefs: Preferences): Promise<CalendarApiResponse<{ busy: BusyBlock[] }>> {
  return apiRequest('/api/calendar/freebusy', { feature: 'calendar', prefs, body: range });
}

export function calendarPreview(blocks: CalendarBlock[], prefs: Preferences): Promise<CalendarApiResponse<CalendarPreview>> {
  return apiRequest('/api/calendar/preview', { feature: 'calendar', prefs, body: { blocks } });
}

/**
 * Só existe com o comprovante de uma prévia recente, os mesmos blocos e `confirm: true`;
 * o servidor recusa qualquer outra forma. Repetir não duplica eventos.
 */
export function calendarCommit(previewToken: string, blocks: CalendarBlock[], prefs: Preferences): Promise<CalendarApiResponse<CalendarCommitResult>> {
  return apiRequest('/api/calendar/commit', { feature: 'calendar', prefs, body: { previewToken, blocks, confirm: true } });
}

export function calendarDisconnect(prefs: Preferences): Promise<CalendarApiResponse<{ revoked: boolean }>> {
  return apiRequest('/api/calendar/disconnect', { feature: 'calendar', prefs, body: {} });
}
