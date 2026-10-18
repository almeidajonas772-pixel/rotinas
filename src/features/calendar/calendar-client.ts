import { useCallback, useEffect, useRef, useState } from 'react';
import type { CalendarAccess, CalendarStatus, GoogleEvent } from '../../../shared/calendar';
import { useApp } from '../../app/context';
import { addDays, type CivilDate } from '../../domain/civil';
import { wallTimeToInstant } from '../../domain/tz';
import { calendarConnect, calendarEvents, calendarStatus, OfflineError, ServerLockedError, ServerUnavailableError, UnauthorizedError } from '../../lib/api';
import { useOnline } from '../../lib/browser';

/**
 * Estado da conexão com o Google Calendar. Sem a autorização do calendário, nada é consultado.
 * Volta a verificar quando o app volta ao primeiro plano — é assim que a tela percebe que a
 * pessoa terminou a autorização no Google (numa aba ou janela à parte).
 */

export type CalendarStatusState =
  | { state: 'off' }
  | { state: 'offline' }
  | { state: 'loading' }
  | { state: 'error'; message: string; kind: 'static' | 'locked' | 'unauthorized' | 'error' }
  | { state: 'ok'; status: CalendarStatus };

function classify(error: unknown): Extract<CalendarStatusState, { state: 'error' }> {
  if (error instanceof ServerLockedError) return { state: 'error', kind: 'locked', message: error.message };
  if (error instanceof UnauthorizedError) return { state: 'error', kind: 'unauthorized', message: error.message };
  if (error instanceof ServerUnavailableError && error.staticOnly) return { state: 'error', kind: 'static', message: error.message };
  return { state: 'error', kind: 'error', message: error instanceof Error ? error.message : 'A camada privada não respondeu.' };
}

/** Chama `fn` quando o app volta ao primeiro plano (no máximo a cada `minGapMs`). */
export function useOnForeground(fn: () => void, enabled: boolean, minGapMs = 3000): void {
  const last = useRef(0);
  const ref = useRef(fn);
  useEffect(() => {
    ref.current = fn;
  });
  useEffect(() => {
    if (!enabled) return;
    const run = () => {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (now - last.current < minGapMs) return;
      last.current = now;
      ref.current();
    };
    document.addEventListener('visibilitychange', run);
    window.addEventListener('focus', run);
    return () => {
      document.removeEventListener('visibilitychange', run);
      window.removeEventListener('focus', run);
    };
  }, [enabled, minGapMs]);
}

export function useCalendarStatus(): [CalendarStatusState, () => void] {
  const { prefs } = useApp();
  const online = useOnline();
  const [nonce, setNonce] = useState(0);
  const granted = prefs.consents.calendar.granted;
  // Cada verificação tem uma chave; enquanto a resposta da chave atual não chega, o estado é "carregando".
  const key = `${prefs.consents.calendar.updatedAt}|${nonce}|${prefs.server.accessToken ?? ''}`;
  const [result, setResult] = useState<{ key: string; value: CalendarStatusState } | null>(null);
  const [last, setLast] = useState<CalendarStatusState | null>(null);
  useEffect(() => {
    if (!granted || !online) return;
    const controller = new AbortController();
    calendarStatus(prefs, controller.signal)
      .then((res) => {
        const value: CalendarStatusState = res.ok ? { state: 'ok', status: res.data } : { state: 'error', kind: 'error', message: res.error.message };
        setResult({ key, value });
        setLast(value);
      })
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        if (e instanceof OfflineError) return;
        const value = classify(e);
        setResult({ key, value });
        setLast(value);
      });
    return () => controller.abort();
    // `key` resume as preferências que mudam a verificação; o restante não.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [granted, online, key]);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  useOnForeground(refresh, granted && online);
  if (!granted) return [{ state: 'off' }, refresh];
  if (!online) return [{ state: 'offline' }, refresh];
  // Durante uma nova verificação, mantém o último estado conhecido (evita "piscar" a tela).
  if (result?.key === key) return [result.value, refresh];
  return [last ?? { state: 'loading' }, refresh];
}

const LINK_TTL_MS = 8 * 60_000;

/**
 * Links de autorização no Google, preparados com antecedência para que o toque abra uma
 * aba/janela própria (sem bloqueio de pop-up). Cada link vale 10 minutos e é renovado antes.
 */
export function useConnectLinks(levels: readonly CalendarAccess[], enabled: boolean): { links: Partial<Record<CalendarAccess, string>>; error?: string } {
  const { prefs } = useApp();
  const [state, setState] = useState<{ at: number; key: string; links: Partial<Record<CalendarAccess, string>>; error?: string }>({ at: 0, key: '', links: {} });
  const [tick, setTick] = useState(0);
  const key = `${levels.join(',')}|${prefs.server.accessToken ?? ''}`;
  useEffect(() => {
    if (!enabled || levels.length === 0) return;
    const controller = new AbortController();
    Promise.all(
      levels.map(async (access) => {
        const res = await calendarConnect(access, prefs, controller.signal);
        return [access, res] as const;
      }),
    )
      .then((pairs) => {
        const links: Partial<Record<CalendarAccess, string>> = {};
        let error: string | undefined;
        for (const [access, res] of pairs) {
          if (res.ok) links[access] = res.data.url;
          else error = res.error.message;
        }
        setState({ at: Date.now(), key, links, error });
      })
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setState({ at: Date.now(), key, links: {}, error: e instanceof Error ? e.message : 'Não foi possível preparar a conexão.' });
      });
    const timer = window.setTimeout(() => setTick((t) => t + 1), LINK_TTL_MS);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key, tick]);
  useOnForeground(() => {
    if (Date.now() - state.at > LINK_TTL_MS) setTick((t) => t + 1);
  }, enabled);
  if (!enabled || state.key !== key) return { links: {} };
  return { links: state.links, error: state.error };
}

// ── Eventos (só leitura) ────────────────────────────────────────────────────

export type GoogleEventsState =
  | { state: 'off' }
  | { state: 'loading' }
  | { state: 'ok'; events: GoogleEvent[]; fetchedAt: number }
  | { state: 'error'; message: string };

const EVENTS_TTL_MS = 5 * 60_000;
/** Cache só em memória (nunca no armazenamento do navegador): some ao fechar o app. */
const eventsCache = new Map<string, { at: number; events: GoogleEvent[] }>();

export function clearGoogleEventsCache(): void {
  eventsCache.clear();
}

/** Eventos da agenda principal entre `from` e `to` (inclusive), no fuso do perfil. */
export function useGoogleEvents(from: CivilDate, to: CivilDate, enabled: boolean): [GoogleEventsState, () => void] {
  const { prefs, timezone } = useApp();
  const online = useOnline();
  const cacheKey = `${from}|${to}|${timezone}`;
  const [nonce, setNonce] = useState(0);
  const [result, setResult] = useState<{ key: string; value: GoogleEventsState } | null>(null);
  const active = enabled && online && prefs.consents.calendar.granted;
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const load = async (): Promise<GoogleEventsState> => {
      const cached = eventsCache.get(cacheKey);
      if (cached && Date.now() - cached.at < EVENTS_TTL_MS && nonce === 0) return { state: 'ok', events: cached.events, fetchedAt: cached.at };
      const range = {
        timeMin: wallTimeToInstant(from, '00:00', timezone).toISOString(),
        timeMax: wallTimeToInstant(addDays(to, 1), '00:00', timezone).toISOString(),
        timeZone: timezone,
      };
      const res = await calendarEvents(range, prefs, controller.signal);
      if (!res.ok) return { state: 'error', message: res.error.message };
      const at = Date.now();
      eventsCache.set(cacheKey, { at, events: res.data.events });
      return { state: 'ok', events: res.data.events, fetchedAt: at };
    };
    load()
      .then((value) => setResult({ key: cacheKey, value }))
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setResult({ key: cacheKey, value: { state: 'error', message: e instanceof Error ? e.message : 'Não foi possível ler os eventos agora.' } });
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, cacheKey, nonce]);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  useOnForeground(() => {
    const cached = eventsCache.get(cacheKey);
    if (!cached || Date.now() - cached.at > EVENTS_TTL_MS) refresh();
  }, active);
  if (!active) return [{ state: 'off' }, refresh];
  return [result?.key === cacheKey ? result.value : { state: 'loading' }, refresh];
}
