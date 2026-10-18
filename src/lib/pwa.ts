import { useSyncExternalStore } from 'react';

/**
 * Registro do service worker (funcionamento offline). Em desenvolvimento o SW não é gerado;
 * em produção, uma nova versão fica em espera até a pessoa escolher atualizar — assim um
 * texto do Diário em edição nunca é interrompido por uma recarga automática.
 *
 * O registro acontece uma única vez, na inicialização (`registerServiceWorker` em main.tsx),
 * inclusive antes do onboarding; as telas apenas leem o estado com `usePwa`.
 */

export interface PwaState {
  needRefresh: boolean;
  offlineReady: boolean;
  update: () => void;
  dismiss: () => void;
}

interface PwaSnapshot {
  needRefresh: boolean;
  offlineReady: boolean;
}

let snapshot: PwaSnapshot = { needRefresh: false, offlineReady: false };
const listeners = new Set<() => void>();
let updateSW: ((reload?: boolean) => Promise<void>) | null = null;
let registered = false;

function setSnapshot(patch: Partial<PwaSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSnapshot = () => snapshot;

export function registerServiceWorker(): void {
  if (registered || !import.meta.env.PROD || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  registered = true;
  import('virtual:pwa-register')
    .then(({ registerSW }) => {
      updateSW = registerSW({
        immediate: true,
        onNeedRefresh: () => setSnapshot({ needRefresh: true }),
        onOfflineReady: () => setSnapshot({ offlineReady: true }),
        onRegisterError: (error: unknown) => console.warn('Service worker não registrado:', error),
      });
    })
    .catch((error) => console.warn('PWA indisponível:', error));
}

export function usePwa(): PwaState {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return {
    ...state,
    update: () => {
      void updateSW?.(true);
    },
    dismiss: () => setSnapshot({ needRefresh: false, offlineReady: false }),
  };
}
