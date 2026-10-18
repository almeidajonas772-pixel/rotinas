import type { BusyBlock, CalendarApiResponse, CalendarBlock, CalendarCommitResult, CalendarPreview, CalendarStatus } from '../../shared/calendar';
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
  constructor(message = 'A camada privada (servidor do Rotinas) não respondeu. Verifique se ela está rodando — veja o README.') {
    super(message);
    this.name = 'ServerUnavailableError';
  }
}

export class UnauthorizedError extends Error {
  constructor() {
    super('O servidor privado recusou o acesso. Confira a senha do servidor em Configurações.');
    this.name = 'UnauthorizedError';
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
  if (!type.includes('application/json')) throw new ServerUnavailableError('A camada privada não está disponível neste endereço (o app foi aberto sem o servidor).');
  if (response.status === 401) throw new UnauthorizedError();
  return (await response.json()) as T;
}

export function getHealth(feature: Feature, prefs: Preferences, signal?: AbortSignal): Promise<HealthResponse> {
  return apiRequest<HealthResponse>('/api/health', { feature, prefs, method: 'GET', signal });
}

const KAI_PATHS: Record<KaiTask, string> = {
  chat: '/api/kai/chat',
  plan: '/api/kai/plan',
  'next-step': '/api/kai/next-step',
  'weekly-review': '/api/kai/weekly-review',
  'goal-breakdown': '/api/kai/goal-breakdown',
};

export function callKai<T extends KaiTask>(task: T, payload: unknown, prefs: Preferences, signal?: AbortSignal): Promise<KaiApiResponse<KaiOutputFor<T>>> {
  return apiRequest<KaiApiResponse<KaiOutputFor<T>>>(KAI_PATHS[task], { feature: 'kai', prefs, body: payload, signal });
}

export function calendarStatus(prefs: Preferences, signal?: AbortSignal): Promise<CalendarApiResponse<CalendarStatus>> {
  return apiRequest('/api/calendar/status', { feature: 'calendar', prefs, method: 'GET', signal });
}

export function calendarConnect(access: 'availability' | 'write', prefs: Preferences): Promise<CalendarApiResponse<{ url: string }>> {
  return apiRequest('/api/calendar/connect', { feature: 'calendar', prefs, body: { access } });
}

export function calendarFreeBusy(range: { timeMin: string; timeMax: string; timeZone: string }, prefs: Preferences): Promise<CalendarApiResponse<{ busy: BusyBlock[] }>> {
  return apiRequest('/api/calendar/freebusy', { feature: 'calendar', prefs, body: range });
}

export function calendarPreview(blocks: CalendarBlock[], prefs: Preferences): Promise<CalendarApiResponse<CalendarPreview>> {
  return apiRequest('/api/calendar/preview', { feature: 'calendar', prefs, body: { blocks } });
}

/** Só existe com o id de uma prévia e `confirm: true`; o servidor recusa qualquer outra forma. */
export function calendarCommit(previewId: string, prefs: Preferences): Promise<CalendarApiResponse<CalendarCommitResult>> {
  return apiRequest('/api/calendar/commit', { feature: 'calendar', prefs, body: { previewId, confirm: true } });
}

export function calendarDisconnect(prefs: Preferences): Promise<CalendarApiResponse<{ revoked: boolean }>> {
  return apiRequest('/api/calendar/disconnect', { feature: 'calendar', prefs, body: {} });
}
