import type { CloudSyncState } from '../../platform/cloud-sync';

/** Texto curto do estado da sincronização (para a barra lateral e listas). */
export function cloudSummary(sync: CloudSyncState): string {
  switch (sync.phase) {
    case 'off':
      return 'Seus dados ficam neste navegador.';
    case 'unavailable':
      return 'Só neste navegador por enquanto.';
    case 'connecting':
      return 'Conectando aos seus dados no Claude…';
    case 'syncing':
      return 'Salvando na sua conta do Claude…';
    case 'synced':
      return 'Salvo na sua conta do Claude.';
    case 'error':
      return 'Não foi possível salvar no Claude agora.';
    case 'blocked':
      return 'Atualize o app para sincronizar.';
  }
}
