import { Eye, LifeBuoy, RotateCcw } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useApp } from '../../app/context';
import { Dialog } from '../../components/dialog';
import { Segmented, SwitchRow } from '../../components/form';
import { useToast } from '../../components/toast';
import { Button, LoadingState, Notice, PageHeader, Section } from '../../components/ui';
import { describeError } from '../../db/errors';
import { setConsent } from '../../db/repo-profile';
import { buildKaiContext } from '../../domain/kai-context';
import type { ConsentKey } from '../../domain/schemas';
import { useUiPref } from '../../lib/browser';
import { ConsentDetails, ConsentDialog } from '../privacy/ConsentDialog';
import { KaiChat } from './KaiChat';
import { KAI_SUPPORT_TEXT, useKaiAvailability, useKaiSnapshot, type KaiAvailability } from './kai-client';
import { KaiHistory } from './KaiHistory';
import { KaiNextStep } from './KaiNextStep';
import { KaiWeeklyReview } from './KaiWeeklyReview';

type Tab = 'chat' | 'next' | 'review' | 'history';

export function KaiPage() {
  const { prefs } = useApp();
  const toast = useToast();
  const [availability, recheck] = useKaiAvailability();
  const [params] = useSearchParams();
  const [tab, setTab] = useUiPref<Tab>('kai.tab', 'chat');
  const [asking, setAsking] = useState<ConsentKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(false);
  const reviewParam = params.get('revisao');
  const activeTab: Tab = reviewParam ? 'review' : tab;

  async function decide(key: ConsentKey, granted: boolean) {
    setBusy(true);
    try {
      await setConsent(key, granted);
      toast.show(granted ? 'Autorização concedida.' : 'Autorização não concedida.');
    } catch (e) {
      toast.show(describeError(e), { tone: 'danger' });
    } finally {
      setBusy(false);
      setAsking(null);
    }
  }

  async function revoke(key: ConsentKey) {
    try {
      await setConsent(key, false);
      toast.show(key === 'kai' ? 'Kai desativado. Nenhum dado será enviado.' : 'Autorização revogada.');
    } catch (e) {
      toast.show(describeError(e), { tone: 'danger' });
    }
  }

  return (
    <div className="page">
      <PageHeader title="Kai" subtitle="Assistente opcional de rotina. Conversa, sugere próximos passos e revisa sua semana com base nos registros que você autorizar." />

      <KaiStatus availability={availability} onRecheck={recheck} onEnable={() => setAsking('kai')} onDisable={() => void revoke('kai')} />

      {prefs.consents.kai.granted && (
        <Section title="Dados que o Kai pode usar" id="kai-data">
          <div className="panel">
            <SwitchRow label="Hábitos, metas e contagens do período" description="Necessário para o Kai funcionar. Nunca inclui seu nome nem observações de conclusões." checked disabled onChange={() => undefined} />
            <SwitchRow
              label="Check-ins de humor e energia"
              description={prefs.features.checkins ? 'Só as notas de 1 a 5 do período analisado.' : 'Ative o check-in em Configurações para poder incluir.'}
              checked={prefs.consents.kaiCheckins.granted}
              disabled={!prefs.features.checkins}
              onChange={(v) => (v ? setAsking('kaiCheckins') : void revoke('kaiCheckins'))}
            />
            <SwitchRow
              label="Trechos do Diário"
              description="Autorização separada. Entradas marcadas como privadas nunca são incluídas."
              checked={prefs.consents.kaiJournal.granted}
              onChange={(v) => (v ? setAsking('kaiJournal') : void revoke('kaiJournal'))}
            />
            <div className="btn-row" style={{ marginTop: 8 }}>
              <Button size="sm" icon={<Eye size={16} aria-hidden="true" />} onClick={() => setPreview(true)}>
                Ver exatamente o que seria enviado
              </Button>
              <Link to="/configuracoes/privacidade" className="btn btn-ghost btn-sm">
                Privacidade
              </Link>
            </div>
          </div>
        </Section>
      )}

      {prefs.consents.kai.granted && (
        <Section title="Usar o Kai" id="kai-use">
          <div style={{ marginBottom: 16 }}>
            <Segmented
              label="Seção do Kai"
              hideLabel
              value={activeTab}
              onChange={setTab}
              options={[
                { value: 'chat', label: 'Conversa' },
                { value: 'next', label: 'Próximo passo' },
                { value: 'review', label: 'Revisão semanal' },
                { value: 'history', label: 'Histórico' },
              ]}
            />
          </div>
          {activeTab === 'chat' && <KaiChat ready={availability.state === 'ready'} />}
          {activeTab === 'next' && <KaiNextStep ready={availability.state === 'ready'} />}
          {activeTab === 'review' && <KaiWeeklyReview ready={availability.state === 'ready'} initialRange={reviewParam} />}
          {activeTab === 'history' && <KaiHistory />}
        </Section>
      )}

      <div className="notice" style={{ marginTop: 32 }}>
        <LifeBuoy size={18} aria-hidden="true" />
        <p className="small">{KAI_SUPPORT_TEXT}</p>
      </div>

      {asking && <ConsentDialog consent={asking} open onClose={() => setAsking(null)} busy={busy} onDecide={(g) => decide(asking, g)} />}
      {preview && <ContextPreview onClose={() => setPreview(false)} />}
    </div>
  );
}

function KaiStatus({ availability, onRecheck, onEnable, onDisable }: { availability: KaiAvailability; onRecheck: () => void; onEnable: () => void; onDisable: () => void }) {
  switch (availability.state) {
    case 'off':
      return (
        <div className="panel stack">
          <p className="switch-label">O Kai está desativado</p>
          <p className="small muted">Com o Kai desligado, nenhum dado sai deste aparelho e o app funciona por completo. Para ativar, revise o que seria enviado:</p>
          <details className="explain">
            <summary>O que o Kai recebe e para onde vai</summary>
            <ConsentDetails consent="kai" />
          </details>
          <div>
            <Button variant="primary" onClick={onEnable}>
              Revisar e ativar o Kai
            </Button>
          </div>
        </div>
      );
    case 'offline':
      return (
        <Notice tone="warn" title="Sem conexão">
          O Kai precisa de internet. Seus dados e o restante do app continuam funcionando normalmente.
        </Notice>
      );
    case 'checking':
      return <LoadingState label="Verificando a camada privada…" lines={1} />;
    case 'unauthorized':
      return (
        <Notice tone="warn" title="Acesso recusado pelo servidor" action={<Link to="/configuracoes#servidor" className="btn btn-secondary btn-sm">Ajustar senha do servidor</Link>}>
          {availability.message}
        </Notice>
      );
    case 'unavailable':
      return (
        <Notice
          tone="warn"
          title="Kai indisponível"
          role="status"
          action={
            <>
              <Button size="sm" icon={<RotateCcw size={16} aria-hidden="true" />} onClick={onRecheck}>
                Verificar de novo
              </Button>
              <Button size="sm" variant="ghost" onClick={onDisable}>
                Desativar Kai
              </Button>
            </>
          }
        >
          <p>{availability.message}</p>
          <p style={{ marginTop: 6 }}>
            Para ativar: rode a camada privada deste projeto com <code>ANTHROPIC_API_KEY</code> no arquivo <code>.env</code> (veja o README, seção “Ativar o Kai”). Nenhuma resposta é inventada enquanto isso: o Kai só aparece quando o servidor responde de verdade.
          </p>
        </Notice>
      );
    case 'ready':
      return (
        <Notice
          tone="ok"
          title="Kai pronto"
          action={
            <Button size="sm" variant="ghost" onClick={onDisable}>
              Desativar Kai
            </Button>
          }
        >
          Respostas geradas por IA (Anthropic{availability.models ? `; modelos ${availability.models.fast} e ${availability.models.deep}` : ''}). Podem conter erros: confira as evidências citadas.
        </Notice>
      );
  }
}

function ContextPreview({ onClose }: { onClose: () => void }) {
  const snapshot = useKaiSnapshot();
  let built: ReturnType<typeof buildKaiContext> | undefined;
  let buildError: string | undefined;
  if (snapshot) {
    try {
      built = buildKaiContext(snapshot);
    } catch (e) {
      buildError = e instanceof Error ? e.message : 'Não foi possível montar a prévia.';
    }
  }
  let content: ReactNode = <LoadingState />;
  if (buildError) content = <Notice tone="warn">{buildError}</Notice>;
  else if (built)
    content = (
      <div className="stack">
        <p className="small">Exemplo para uma conversa (últimos 14 dias). Isto é exatamente o que a camada privada repassaria ao provedor — além do texto que você escrever:</p>
        <ul className="small">
          {built.manifest.categories.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <pre className="small" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', background: 'var(--surface-2)', padding: 12, borderRadius: 8, maxHeight: 320, overflow: 'auto' }}>
          {JSON.stringify(built.context, null, 2)}
        </pre>
        <p className="meta">As referências h1, g1, j1 substituem os identificadores internos; o mapa entre elas fica só no aparelho.</p>
      </div>
    );
  return (
    <Dialog open onClose={onClose} title="O que seria enviado ao Kai" footer={<Button onClick={onClose}>Fechar</Button>}>
      {content}
    </Dialog>
  );
}
