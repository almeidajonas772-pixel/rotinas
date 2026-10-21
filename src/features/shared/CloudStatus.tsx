import { RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useApp } from '../../app/context';
import { Button, Notice } from '../../components/ui';
import { formatInstant } from '../../domain/format';
import { syncNow, useCloudSync } from '../../platform/cloud-sync';

/**
 * Estado dos dados guardados no Claude: onde estão, quando sincronizaram pela última vez e o que
 * fazer se algo falhou. Só aparece dentro do Claude.
 */
export function CloudStatus() {
  const sync = useCloudSync();
  const { timezone } = useApp();
  const [busy, setBusy] = useState(false);
  if (sync.phase === 'off') return null;
  const tone = sync.phase === 'synced' ? 'ok' : sync.phase === 'error' || sync.phase === 'blocked' || sync.phase === 'unavailable' ? 'warn' : 'info';
  const title =
    sync.phase === 'synced'
      ? 'Dados salvos na sua conta do Claude'
      : sync.phase === 'syncing' || sync.phase === 'connecting'
        ? 'Sincronizando com a sua conta do Claude…'
        : sync.phase === 'blocked'
          ? 'Atualize o Rotinas'
          : sync.phase === 'unavailable'
            ? 'Dados só neste navegador'
            : 'Sincronização com problema';
  const last = sync.lastSyncedAt ? formatInstant(new Date(sync.lastSyncedAt).toISOString(), timezone) : undefined;
  return (
    <Notice
      tone={tone}
      title={title}
      role="status"
      action={
        sync.phase === 'error' || sync.phase === 'synced' ? (
          <Button
            size="sm"
            icon={<RefreshCw size={16} aria-hidden="true" />}
            busy={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await syncNow();
              } finally {
                setBusy(false);
              }
            }}
          >
            Sincronizar agora
          </Button>
        ) : undefined
      }
    >
      <p>
        {sync.phase === 'synced' && `Tudo guardado na área privada da sua conta neste app${last ? ` (última sincronização: ${last})` : ''}. Abra o Rotinas no iPad e no computador com a mesma conta: os dados são os mesmos.`}
        {(sync.phase === 'syncing' || sync.phase === 'connecting') && `Enviando e recebendo alterações${sync.pending > 0 ? ` (${sync.pending} pendente${sync.pending === 1 ? '' : 's'})` : ''}.`}
        {(sync.phase === 'error' || sync.phase === 'blocked' || sync.phase === 'unavailable') && (sync.message ?? 'Seus dados continuam neste navegador.')}
      </p>
      {sync.memoryOnly && (
        <p style={{ marginTop: 6 }}>
          Este navegador não deixou guardar uma cópia local: antes de fechar, espere aparecer “Dados salvos na sua conta do Claude”.
        </p>
      )}
      {sync.unsyncable > 0 && (
        <p style={{ marginTop: 6 }}>
          {sync.unsyncable} registro{sync.unsyncable === 1 ? '' : 's'} grande{sync.unsyncable === 1 ? '' : 's'} demais para o armazenamento do Claude {sync.unsyncable === 1 ? 'ficou' : 'ficaram'} só neste navegador. Encurte textos muito longos para
          que {sync.unsyncable === 1 ? 'ele vá' : 'eles vão'} para a sua conta.
        </p>
      )}
      {sync.invalid > 0 && (
        <p style={{ marginTop: 6 }}>
          {sync.invalid} registro{sync.invalid === 1 ? '' : 's'} vindo{sync.invalid === 1 ? '' : 's'} da sua conta {sync.invalid === 1 ? 'foi ignorado' : 'foram ignorados'} por estar{sync.invalid === 1 ? '' : 'em'} em formato inválido.
        </p>
      )}
    </Notice>
  );
}
