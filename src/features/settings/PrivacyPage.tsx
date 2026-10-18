import { HardDrive, Send, ShieldCheck } from 'lucide-react';
import { Link } from 'react-router';
import { useApp } from '../../app/context';
import { PageHeader, Section, Tag } from '../../components/ui';
import { CONSENT_TEXTS } from '../privacy/consent-texts';
import type { ConsentKey } from '../../domain/schemas';

const LOCAL_DATA = [
  'Perfil local: nome (opcional), fuso horário, objetivo, disponibilidade',
  'Preferências e autorizações (com data de cada decisão)',
  'Hábitos, frequências, pausas e todos os registros de conclusão',
  'Agenda: tarefas, eventos, blocos de tempo e conclusões',
  'Metas, vínculos e atualizações manuais',
  'Diário e check-ins',
  'Histórico de conversas e análises do Kai',
  'Sessões da noite (conversas) e a prioridade nº 1 de cada dia',
  'Estado da conexão com o Google Calendar (sem tokens). Eventos lidos do Google ficam só na memória enquanto o app está aberto',
];

export function PrivacyPage() {
  const { prefs } = useApp();
  const external: Array<{ key: ConsentKey; provider: string; route: string }> = [
    { key: 'kai', provider: 'Anthropic (via sua camada privada)', route: '/kai' },
    { key: 'kaiCheckins', provider: 'Anthropic (via sua camada privada)', route: '/kai' },
    { key: 'kaiJournal', provider: 'Anthropic (via sua camada privada)', route: '/kai' },
    { key: 'kaiAgenda', provider: 'Anthropic (via sua camada privada)', route: '/noite' },
    { key: 'calendar', provider: 'Google Calendar (via sua camada privada)', route: '/calendario' },
    { key: 'voice', provider: 'serviço de voz do navegador ou do sistema (Google, Microsoft ou Apple, conforme o aparelho)', route: '/noite' },
  ];
  return (
    <div className="page">
      <PageHeader title="Privacidade" subtitle="O que fica neste aparelho, o que poderia sair dele e como controlar cada envio." back={{ to: '/configuracoes', label: 'Configurações' }} />

      <Section title="Fica no aparelho" id="priv-local">
        <div className="panel stack">
          <div className="row">
            <HardDrive size={18} aria-hidden="true" />
            <p className="small">
              Guardado no IndexedDB deste navegador (banco “rotinas”). O <code>localStorage</code> guarda só conveniências de interface, como a última visualização escolhida.
            </p>
          </div>
          <ul className="small">
            {LOCAL_DATA.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        </div>
      </Section>

      <Section title="Pode sair do aparelho — só com autorização" id="priv-external">
        <ul className="data-flow" role="list">
          {external.map(({ key, provider, route }) => {
            const t = CONSENT_TEXTS[key];
            const on = prefs.consents[key].granted;
            return (
              <li key={key}>
                <div className="row-between">
                  <h3>{t.title}</h3>
                  <Tag tone={on ? 'ok' : undefined}>{on ? 'Autorizado' : 'Desligado'}</Tag>
                </div>
                <p className="small">
                  <Send size={14} aria-hidden="true" style={{ display: 'inline', marginRight: 6 }} />
                  Destino: {provider}. {t.when}
                </p>
                <ul>
                  {t.sends.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
                <p className="meta" style={{ marginTop: 8 }}>
                  Nunca enviado: {t.neverSends.join('; ')}. <Link to={route}>Gerenciar</Link>
                </p>
              </li>
            );
          })}
          <li>
            <div className="row-between">
              <h3>{CONSENT_TEXTS.notifications.title}</h3>
              <Tag tone={prefs.consents.notifications.granted ? 'ok' : undefined}>{prefs.consents.notifications.granted ? 'Autorizado' : 'Desligado'}</Tag>
            </div>
            <p className="small">Nada sai do aparelho: o navegador mostra os lembretes localmente.</p>
          </li>
        </ul>
      </Section>

      <Section title="O que o app nunca faz" id="priv-never">
        <div className="panel small">
          <ul>
            <li>Não cria conta, não pede login e não envia dados em segundo plano.</li>
            <li>Não usa analytics, anúncios, pixels de rastreamento, fontes externas ou CDNs.</li>
            <li>Não envia seu nome, observações de conclusões nem entradas privadas do Diário ao Kai.</li>
            <li>Não guarda chaves de API ou tokens OAuth no navegador: eles ficam só na camada privada.</li>
            <li>Não grava áudio: o microfone só fica ligado enquanto a tela Noite mostra “Ouvindo”, e só o texto reconhecido é usado.</li>
            <li>A camada privada registra apenas dados técnicos (rota, status, duração, modelo, contagem de tokens), sem conteúdo.</li>
          </ul>
        </div>
      </Section>

      <Section title="Seus controles" id="priv-controls">
        <div className="panel small stack">
          <p>
            <ShieldCheck size={16} aria-hidden="true" style={{ display: 'inline', marginRight: 6 }} />
            Revogar uma autorização interrompe envios futuros imediatamente. Exportar, importar e apagar tudo ficam em <Link to="/configuracoes#dados">Configurações → Seus dados</Link>.
          </p>
          <p className="muted">
            Dados já enviados a um provedor seguem a política dele (consulte os termos da Anthropic e do Google). Esta versão não alega certificações nem conformidade completa sem auditoria independente e requer revisão de segurança e jurídica antes de ser oferecida a outras pessoas.
          </p>
        </div>
      </Section>
    </div>
  );
}
