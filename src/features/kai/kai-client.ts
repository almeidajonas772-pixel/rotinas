import { useCallback, useEffect, useState } from 'react';
import type { KaiOutputFor, KaiTask } from '../../../shared/kai';
import { useApp } from '../../app/context';
import { useCheckins, useCompletions, useGoals, useHabits, useJournal } from '../../db/hooks';
import type { KaiSnapshot } from '../../domain/kai-context';
import { KaiConsentError } from '../../domain/kai-context';
import type { Preferences } from '../../domain/schemas';
import { callKai, FeatureDisabledError, getHealth, OfflineError, ServerLockedError, ServerUnavailableError, UnauthorizedError } from '../../lib/api';
import { useOnline } from '../../lib/browser';
import { useGoalContext } from '../shared/data';

export type KaiAvailability =
  | { state: 'off'; outdated?: boolean }
  | { state: 'offline' }
  | { state: 'checking' }
  | { state: 'unavailable'; message: string; setup: boolean; reason: 'static' | 'locked' | 'not_configured' | 'error' }
  | { state: 'unauthorized'; message: string }
  | { state: 'ready'; models?: { fast: string; deep: string } };

/**
 * Estado do Kai. Sem consentimento, nada é verificado na rede.
 * Com consentimento, consulta /api/health da camada privada (mesma origem).
 */
export function useKaiAvailability(): [KaiAvailability, () => void] {
  const { prefs } = useApp();
  const online = useOnline();
  const [nonce, setNonce] = useState(0);
  const granted = prefs.consents.kai.granted;
  // Cada verificação tem uma chave; enquanto a resposta da chave atual não chega, o estado é "verificando".
  const key = `${prefs.consents.kai.updatedAt}|${nonce}|${prefs.server.accessToken ?? ''}`;
  const [result, setResult] = useState<{ key: string; value: KaiAvailability } | null>(null);

  useEffect(() => {
    if (!granted || !online) return;
    const controller = new AbortController();
    const settle = (value: KaiAvailability) => setResult({ key, value });
    getHealth('kai', prefs, controller.signal)
      .then((health) => {
        if (health.kai.enabled) settle({ state: 'ready', models: health.kai.models });
        else settle({ state: 'unavailable', setup: true, reason: 'not_configured', message: health.kai.reason ?? 'O Kai não está configurado na camada privada.' });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        if (error instanceof UnauthorizedError) settle({ state: 'unauthorized', message: error.message });
        else if (error instanceof OfflineError) settle({ state: 'offline' });
        else if (error instanceof ServerLockedError) settle({ state: 'unavailable', setup: true, reason: 'locked', message: error.message });
        else if (error instanceof ServerUnavailableError && error.staticOnly) settle({ state: 'unavailable', setup: true, reason: 'static', message: error.message });
        else settle({ state: 'unavailable', setup: true, reason: 'error', message: error instanceof Error ? error.message : 'A camada privada não respondeu.' });
      });
    return () => controller.abort();
    // `key` resume as preferências que mudam a verificação; o restante não.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [granted, online, key]);

  const recheck = useCallback(() => setNonce((n) => n + 1), []);
  if (!granted) return [{ state: 'off', outdated: prefs.consents.kai.outdated }, recheck];
  if (!online) return [{ state: 'offline' }, recheck];
  return [result?.key === key ? result.value : { state: 'checking' }, recheck];
}

/** Reúne os dados locais necessários para montar o contexto do Kai. */
export function useKaiSnapshot(): KaiSnapshot | undefined {
  const { profile, prefs, today } = useApp();
  const habits = useHabits();
  const completions = useCompletions();
  const goals = useGoals();
  const goalCtx = useGoalContext();
  const checkins = useCheckins();
  const journal = useJournal();
  if (!habits || !completions || !goals || !goalCtx || !checkins || !journal) return undefined;
  return { today, profile, prefs, habits, completions, goals, goalCtx, checkins, journal };
}

export type KaiRunResult<T extends KaiTask> = { ok: true; data: KaiOutputFor<T>; model: string } | { ok: false; code: string; message: string };

/** Chama o Kai e converte qualquer falha em mensagem honesta — nunca há resposta inventada. */
export async function runKai<T extends KaiTask>(task: T, payload: unknown, prefs: Preferences, signal?: AbortSignal): Promise<KaiRunResult<T>> {
  try {
    const res = await callKai(task, payload, prefs, signal);
    if (res.ok) return { ok: true, data: res.data, model: res.meta.model };
    return { ok: false, code: res.error.code, message: res.error.message };
  } catch (error) {
    if (error instanceof KaiConsentError || error instanceof FeatureDisabledError) return { ok: false, code: 'kai_disabled', message: error.message };
    if (error instanceof OfflineError) return { ok: false, code: 'offline', message: error.message };
    if (error instanceof UnauthorizedError) return { ok: false, code: 'unauthorized', message: error.message };
    if (error instanceof ServerLockedError) return { ok: false, code: 'server_locked', message: error.message };
    if (error instanceof ServerUnavailableError) return { ok: false, code: 'server_unavailable', message: error.message };
    if (error instanceof DOMException && error.name === 'AbortError') return { ok: false, code: 'aborted', message: 'Pedido cancelado.' };
    return { ok: false, code: 'unknown', message: 'Não foi possível falar com o Kai agora.' };
  }
}

export const KAI_SUPPORT_TEXT =
  'O Kai não substitui apoio profissional e não faz diagnósticos. Se você estiver em sofrimento ou em risco, procure ajuda agora: CVV, ligue 188 (gratuito, 24 horas) ou acesse cvv.org.br; em emergência, SAMU 192.';
