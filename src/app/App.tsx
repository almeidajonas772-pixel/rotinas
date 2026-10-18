import { useEffect, useState, type ReactNode } from 'react';
import { RouterProvider } from 'react-router/dom';
import { Button, Notice } from '../components/ui';
import { ToastProvider } from '../components/toast';
import { db } from '../db/db';
import { usePrefs, useProfile } from '../db/hooks';
import { rebuildProgressEvents, verifyProgressIntegrity } from '../db/repo-misc';
import { applyTheme } from '../lib/browser';
import { useReminderScheduler } from '../lib/notifications';
import { Onboarding } from '../features/onboarding/Onboarding';
import { AppProvider } from './context';
import { router } from './router';

type DbState = { status: 'opening' } | { status: 'ready' } | { status: 'error'; title: string; message: string } | { status: 'blocked' };

function describeOpenError(error: unknown): { title: string; message: string } {
  const name = error instanceof Error ? error.name : '';
  if (name === 'VersionError') {
    return {
      title: 'Dados de uma versão mais nova',
      message: 'O banco local foi gravado por uma versão mais nova do Rotinas. Atualize o app (recarregue a página) antes de continuar.',
    };
  }
  if (name === 'MissingAPIError' || name === 'InvalidStateError' || name === 'SecurityError') {
    return {
      title: 'Armazenamento local indisponível',
      message:
        'O Rotinas guarda seus dados no IndexedDB deste navegador, que está bloqueado ou indisponível (isso acontece em algumas janelas anônimas ou com o armazenamento de sites desativado). Abra o app numa janela normal ou libere o armazenamento para este site.',
    };
  }
  return { title: 'Não foi possível abrir seus dados', message: 'O banco local não abriu. Recarregue a página; se continuar, feche outras abas do Rotinas e tente de novo.' };
}

function DbGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DbState>({ status: 'opening' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    const onBlocked = () => alive && setState({ status: 'blocked' });
    db.on('blocked', onBlocked);
    db.open()
      .then(async () => {
        if (!alive) return;
        setState({ status: 'ready' });
        // Autocorreção: se o XP gravado divergir do histórico, recalcula a partir das fontes.
        const check = await verifyProgressIntegrity();
        if (!check.ok) await rebuildProgressEvents();
      })
      .catch((error) => {
        if (alive) setState({ status: 'error', ...describeOpenError(error) });
      });
    return () => {
      alive = false;
      db.on('blocked').unsubscribe(onBlocked);
    };
  }, [attempt]);

  if (state.status === 'ready') return <>{children}</>;
  return (
    <div className="page" style={{ paddingTop: 64 }}>
      {state.status === 'opening' && (
        <p className="meta" role="status">
          Abrindo seus dados locais…
        </p>
      )}
      {state.status === 'blocked' && (
        <Notice tone="warn" title="Atualização em espera" role="alert">
          Outra aba do Rotinas está aberta com uma versão anterior. Feche as outras abas para concluir a atualização dos dados locais.
        </Notice>
      )}
      {state.status === 'error' && (
        <Notice tone="danger" title={state.title} role="alert" action={<Button size="sm" onClick={() => setAttempt((a) => a + 1)}>Tentar de novo</Button>}>
          {state.message}
        </Notice>
      )}
    </div>
  );
}

function Root() {
  const profile = useProfile();
  const prefs = usePrefs();
  useEffect(() => {
    applyTheme(prefs?.theme ?? 'system');
  }, [prefs?.theme]);
  useReminderScheduler(profile, prefs);

  if (profile === undefined || prefs === undefined) {
    return (
      <div className="page" style={{ paddingTop: 64 }}>
        <p className="meta" role="status">
          Carregando…
        </p>
      </div>
    );
  }
  if (!profile || !profile.onboardingCompletedAt) return <Onboarding existing={profile} />;
  return (
    <AppProvider profile={profile} prefs={prefs}>
      <RouterProvider router={router} />
    </AppProvider>
  );
}

export function App() {
  return (
    <ToastProvider>
      <DbGate>
        <Root />
      </DbGate>
    </ToastProvider>
  );
}
