import { Bell, Download, HardDrive, Plus, RotateCcw, Server, Share, ShieldCheck, Trash, Upload } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { useApp } from '../../app/context';
import { ConfirmDialog, Dialog } from '../../components/dialog';
import { CheckField, SelectField, Segmented, SwitchRow, TextField, WeekdayPicker } from '../../components/form';
import { useToast } from '../../components/toast';
import { Button, Notice, PageHeader, Section, Tag } from '../../components/ui';
import { backupFileName, clearAllData, exportBackup, exportReadable, parseBackup, restoreBackup, TABLE_LABEL, type BackupTableName, type ParsedBackup } from '../../db/backup';
import { describeError } from '../../db/errors';
import { useIntegration } from '../../db/hooks';
import { rebuildProgressEvents, verifyProgressIntegrity } from '../../db/repo-misc';
import { saveProfile, setConsent, updatePrefs } from '../../db/repo-profile';
import { nowTimeInZone } from '../../domain/civil';
import { formatInstant } from '../../domain/format';
import type { Availability, ConsentKey, DayPeriod } from '../../domain/schemas';
import { listTimeZones, zoneOffsetLabel } from '../../domain/tz';
import { calendarDisconnect, getHealth } from '../../lib/api';
import { canShareFile, clearUiPrefs, downloadText, formatBytes, goToToday, makeTextFile, readFileAsText, requestPersistentStorage, shareFile, useStorageInfo } from '../../lib/browser';
import { showLocalNotification, useNotificationPermission } from '../../lib/notifications';
import { CONSENT_TEXTS } from '../privacy/consent-texts';
import { ConsentDialog } from '../privacy/ConsentDialog';

export function SettingsPage() {
  const location = useLocation();
  useEffect(() => {
    if (!location.hash) return;
    const id = location.hash.slice(1);
    requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: 'start' }));
  }, [location.hash]);

  return (
    <div className="page">
      <PageHeader title="Configurações" subtitle="Perfil local, notificações, autorizações, servidor privado e seus dados." />
      <ProfileSection />
      <AppearanceSection />
      <CheckinSection />
      <NotificationsSection />
      <ConsentsSection />
      <ServerSection />
      <DataSection />
      <AboutSection />
    </div>
  );
}

function ProfileSection() {
  const { profile, prefs } = useApp();
  const toast = useToast();
  const zones = useMemo(() => listTimeZones(), []);
  const [name, setName] = useState(profile.name ?? '');
  const [timezone, setTimezone] = useState(profile.timezone);
  const [mainGoal, setMainGoal] = useState(profile.mainGoal ?? '');
  const [weekStartsOn, setWeekStartsOn] = useState<'0' | '1'>(String(prefs.weekStartsOn) as '0' | '1');
  const [periods, setPeriods] = useState<DayPeriod[]>(profile.availability.periods);
  const [minutes, setMinutes] = useState(profile.availability.minutesPerDay ? String(profile.availability.minutesPerDay) : '');
  const [windows, setWindows] = useState<Availability['windows']>(profile.availability.windows);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    setError(undefined);
    try {
      await saveProfile({
        name: name.trim() || undefined,
        timezone,
        mainGoal: mainGoal.trim() || undefined,
        availability: { periods, minutesPerDay: minutes ? Number(minutes) : undefined, windows },
      });
      await updatePrefs((p) => ({ ...p, weekStartsOn: weekStartsOn === '1' ? 1 : 0 }));
      toast.show('Perfil salvo.');
    } catch (e) {
      setError(describeError(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section title="Perfil local" id="perfil">
      <div className="panel stack">
        <TextField label="Nome" optional value={name} onChange={setName} maxLength={60} hint="Usado só em saudações. Nunca é enviado ao Kai." />
        <SelectField
          label="Fuso horário"
          value={timezone}
          onChange={setTimezone}
          options={zones.map((z) => ({ value: z, label: z.replace(/_/g, ' ') }))}
          hint={`Agora: ${nowTimeInZone(timezone)} (${zoneOffsetLabel(timezone)}). Mudar o fuso não altera as datas dos registros já feitos; itens da agenda com horário passam a ser exibidos convertidos para o novo fuso.`}
        />
        <Segmented label="A semana começa em" value={weekStartsOn} onChange={setWeekStartsOn} options={[{ value: '1', label: 'Segunda-feira' }, { value: '0', label: 'Domingo' }]} />
        <TextField label="Objetivo principal" optional value={mainGoal} onChange={setMainGoal} maxLength={200} />
        <fieldset>
          <legend>Períodos livres</legend>
          <div className="chips">
            {(
              [
                ['manha', 'Manhã'],
                ['tarde', 'Tarde'],
                ['noite', 'Noite'],
              ] as Array<[DayPeriod, string]>
            ).map(([v, l]) => (
              <button key={v} type="button" className="chip" aria-pressed={periods.includes(v)} onClick={() => setPeriods(periods.includes(v) ? periods.filter((p) => p !== v) : [...periods, v])}>
                {l}
              </button>
            ))}
          </div>
        </fieldset>
        <SelectField
          label="Tempo por dia para hábitos"
          optional
          value={minutes}
          onChange={setMinutes}
          options={[{ value: '', label: 'Não informado' }, ...[15, 30, 45, 60, 90, 120, 180].map((m) => ({ value: String(m), label: m < 60 ? `${m} minutos` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` }))]}
        />
        <fieldset>
          <legend>Horários exatos disponíveis (opcional)</legend>
          <p className="field-hint" style={{ marginBottom: 8 }}>
            Usados pelo planejador de blocos de tempo. Têm prioridade sobre os períodos livres.
          </p>
          <div className="stack">
            {windows.map((w, i) => (
              <div key={i} className="panel-flat stack">
                <WeekdayPicker label={`Janela ${i + 1}: dias`} value={w.weekdays} onChange={(weekdays) => setWindows(windows.map((x, j) => (j === i ? { ...x, weekdays } : x)))} />
                <div className="field-row">
                  <TextField label="Das" type="time" value={w.start} onChange={(start) => setWindows(windows.map((x, j) => (j === i ? { ...x, start } : x)))} />
                  <TextField label="Até" type="time" value={w.end} onChange={(end) => setWindows(windows.map((x, j) => (j === i ? { ...x, end } : x)))} error={w.end <= w.start ? 'O fim precisa ser depois do início' : undefined} />
                </div>
                <div>
                  <Button size="sm" variant="ghost" icon={<Trash size={16} aria-hidden="true" />} onClick={() => setWindows(windows.filter((_, j) => j !== i))}>
                    Remover janela
                  </Button>
                </div>
              </div>
            ))}
            <div>
              <Button size="sm" icon={<Plus size={16} aria-hidden="true" />} onClick={() => setWindows([...windows, { weekdays: [1, 2, 3, 4, 5], start: '18:00', end: '20:00' }])} disabled={windows.length >= 21}>
                Adicionar janela
              </Button>
            </div>
          </div>
        </fieldset>
        {error && (
          <Notice tone="danger" role="alert">
            {error}
          </Notice>
        )}
        <div className="btn-row end">
          <Button variant="primary" busy={saving} onClick={() => void save()}>
            Salvar perfil
          </Button>
        </div>
      </div>
    </Section>
  );
}

function AppearanceSection() {
  const { prefs } = useApp();
  return (
    <Section title="Aparência" id="aparencia">
      <div className="panel">
        <Segmented
          label="Tema"
          value={prefs.theme}
          onChange={(theme) => void updatePrefs((p) => ({ ...p, theme }))}
          options={[
            { value: 'system', label: 'Do sistema' },
            { value: 'light', label: 'Claro' },
            { value: 'dark', label: 'Escuro' },
          ]}
        />
        <p className="field-hint" style={{ marginTop: 8 }}>
          Animações seguem a preferência de “reduzir movimento” do seu sistema.
        </p>
      </div>
    </Section>
  );
}

function CheckinSection() {
  const { prefs } = useApp();
  return (
    <Section title="Check-in diário" id="checkin">
      <div className="panel">
        <SwitchRow
          label="Ativar check-in de humor e energia"
          description="Opcional e só local. Duas escalas de 1 a 5 e uma nota, para você notar padrões. Não é avaliação clínica."
          checked={prefs.features.checkins}
          onChange={async (on) => {
            await updatePrefs((p) => ({ ...p, features: { checkins: on } }));
            if (!on && prefs.consents.kaiCheckins.granted) await setConsent('kaiCheckins', false);
          }}
        />
      </div>
    </Section>
  );
}

function NotificationsSection() {
  const { prefs } = useApp();
  const toast = useToast();
  const [permission, requestPermission] = useNotificationPermission();
  const [asking, setAsking] = useState(false);
  const enabled = prefs.notifications.channel === 'local' && prefs.consents.notifications.granted;

  async function enable() {
    const result = await requestPermission();
    if (result === 'granted') {
      await updatePrefs((p) => ({ ...p, notifications: { ...p.notifications, channel: 'local' } }));
      toast.show('Lembretes locais ativados.');
    } else if (result === 'denied') {
      toast.show('O navegador bloqueou as notificações. Veja como liberar abaixo.', { tone: 'danger' });
    } else if (result === 'unsupported') {
      toast.show('Este navegador não oferece notificações.', { tone: 'danger' });
    }
  }

  const n = prefs.notifications;
  const setN = (patch: Partial<typeof n>) => void updatePrefs((p) => ({ ...p, notifications: { ...p.notifications, ...patch } }));

  return (
    <Section title="Notificações" id="notificacoes">
      <div className="panel stack">
        <SwitchRow
          label="Lembretes locais"
          description="O próprio navegador mostra os lembretes dos hábitos com lembrete ligado. Nada sai do aparelho."
          checked={enabled}
          onChange={async (on) => {
            if (!on) {
              await setConsent('notifications', false);
              toast.show('Lembretes desativados.');
              return;
            }
            if (!prefs.consents.notifications.granted) setAsking(true);
            else await enable();
          }}
        />
        <p className="small">
          Permissão do navegador:{' '}
          <Tag tone={permission === 'granted' ? 'ok' : permission === 'denied' ? 'danger' : undefined}>
            {permission === 'granted' ? 'Concedida' : permission === 'denied' ? 'Bloqueada' : permission === 'unsupported' ? 'Não suportada' : 'Ainda não pedida'}
          </Tag>
        </p>
        {permission === 'denied' && (
          <Notice tone="warn" title="Notificações bloqueadas neste navegador">
            Para liberar, abra as permissões do site (ícone de cadeado ou de ajustes ao lado do endereço), permita notificações e recarregue o Rotinas. Os hábitos continuam funcionando sem lembretes.
          </Notice>
        )}
        {permission === 'unsupported' && <Notice tone="neutral">Este navegador não oferece notificações. Em celulares, instalar o app na tela inicial costuma habilitar.</Notice>}
        <Notice tone="info">Lembretes disparam com o Rotinas aberto (aba ou app instalado). Notificações com o app totalmente fechado exigiriam um servidor de push, fora do escopo desta versão.</Notice>
        <div className="field-row">
          <TextField label="Silêncio a partir de" type="time" value={n.quietStart} onChange={(quietStart) => quietStart && setN({ quietStart })} />
          <TextField label="Silêncio até" type="time" value={n.quietEnd} onChange={(quietEnd) => quietEnd && setN({ quietEnd })} />
          <SelectField label="Máximo por dia" value={String(n.maxPerDay)} onChange={(v) => setN({ maxPerDay: Number(v) })} options={[1, 2, 3, 4, 5, 6, 8, 10, 15, 20].map((v) => ({ value: String(v), label: String(v) }))} />
        </div>
        <WeekdayPicker label="Dias em que lembretes podem aparecer" value={n.allowedDays} onChange={(allowedDays) => setN({ allowedDays })} hint="Lembretes também podem ser ligados ou desligados em cada hábito." />
        {enabled && permission === 'granted' && (
          <div>
            <Button
              size="sm"
              icon={<Bell size={16} aria-hidden="true" />}
              onClick={async () => {
                const ok = await showLocalNotification('Rotinas', 'Notificação de teste: os lembretes estão funcionando.', 'teste');
                if (!ok) toast.show('O navegador não mostrou a notificação.', { tone: 'danger' });
              }}
            >
              Enviar notificação de teste
            </Button>
          </div>
        )}
      </div>
      {asking && (
        <ConsentDialog
          consent="notifications"
          open
          onClose={() => setAsking(false)}
          onDecide={async (granted) => {
            setAsking(false);
            if (!granted) return;
            // O pedido ao sistema sai primeiro, ainda dentro do toque: iPhone/iPad só mostram o
            // diálogo de permissão quando ele nasce diretamente de um gesto da pessoa.
            const pending = enable();
            await setConsent('notifications', true);
            await pending;
          }}
        />
      )}
    </Section>
  );
}

function ConsentsSection() {
  const { prefs, timezone } = useApp();
  const toast = useToast();
  const keys: ConsentKey[] = ['kai', 'kaiCheckins', 'kaiJournal', 'kaiAgenda', 'calendar', 'voice', 'notifications'];
  return (
    <Section title="Autorizações" id="autorizacoes" description="Cada autorização é independente e pode ser revogada a qualquer momento. Revogar interrompe envios futuros.">
      <ul className="list" role="list">
        {keys.map((k) => {
          const c = prefs.consents[k];
          return (
            <li key={k} className="list-row">
              <span className={`status-dot ${c.granted ? 'is-on' : 'is-off'}`} aria-hidden="true" />
              <div className="row-main">
                <span className="row-title">{CONSENT_TEXTS[k].title}</span>
                <span className="row-meta">
                  {c.granted ? 'Autorizado' : c.outdated ? 'Texto atualizado: revise para voltar a usar' : 'Não autorizado'}
                  {c.updatedAt ? `, decisão em ${formatInstant(c.updatedAt, timezone)}` : ''}
                </span>
              </div>
              {c.granted && (
                <Button
                  size="sm"
                  onClick={async () => {
                    await setConsent(k, false);
                    toast.show('Autorização revogada.');
                  }}
                >
                  Revogar
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      <p className="meta" style={{ marginTop: 8 }}>
        Para conceder, use a tela de cada recurso (Kai, Noite, Calendário externo, Notificações). Detalhes em <Link to="/configuracoes/privacidade">Privacidade</Link>.
      </p>
    </Section>
  );
}

function ServerSection() {
  const { prefs } = useApp();
  const toast = useToast();
  const [token, setToken] = useState(prefs.server.accessToken ?? '');
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<string>();
  const feature = prefs.consents.kai.granted ? 'kai' : prefs.consents.calendar.granted ? 'calendar' : null;
  return (
    <Section
      title="Servidor privado"
      id="servidor"
      description={
        <>
          A camada privada roda sob seu controle (na sua conta da Vercel ou no seu computador) e guarda os segredos de Kai e Google. Este app só fala com ela na mesma origem, em /api. Passo a passo em{' '}
          <Link to="/conexoes">Conectar Kai e Google</Link>.
        </>
      }
    >
      <div className="panel stack">
        <TextField
          label="Senha do servidor"
          optional
          type="password"
          autoComplete="off"
          value={token}
          onChange={setToken}
          hint="A mesma senha definida em ROTINAS_SERVER_TOKEN no servidor (obrigatória na Vercel). Fica guardada só neste aparelho e vai no cabeçalho das chamadas à sua camada privada. Não é a chave da Anthropic nem do Google."
        />
        <div className="btn-row">
          <Button
            onClick={async () => {
              await updatePrefs((p) => ({ ...p, server: { accessToken: token.trim() || undefined } }));
              toast.show('Senha do servidor salva neste aparelho.');
            }}
          >
            Salvar senha
          </Button>
          <Button
            icon={<Server size={18} aria-hidden="true" />}
            disabled={!feature}
            busy={testing}
            onClick={async () => {
              if (!feature) return;
              setTesting(true);
              try {
                const h = await getHealth(feature, { ...prefs, server: { accessToken: token.trim() || undefined } });
                setResult(`Servidor respondeu. Kai: ${h.kai.enabled ? 'configurado' : `não configurado (${h.kai.reason ?? 'sem motivo informado'})`}. Google Calendar: ${h.calendar.enabled ? 'configurado' : `não configurado (${h.calendar.reason ?? ''})`}.`);
              } catch (e) {
                setResult(e instanceof Error ? e.message : 'Sem resposta.');
              } finally {
                setTesting(false);
              }
            }}
          >
            Testar conexão
          </Button>
        </div>
        {!feature && <p className="meta">Para testar, ative o Kai ou o calendário externo — sem nenhuma autorização, o app não faz chamadas de rede.</p>}
        {result && (
          <Notice tone="neutral" role="status">
            {result}
          </Notice>
        )}
      </div>
    </Section>
  );
}

function DataSection() {
  const { today, prefs } = useApp();
  const toast = useToast();
  const integration = useIntegration();
  const [storageKey, setStorageKey] = useState(0);
  const storage = useStorageInfo(storageKey);
  const fileRef = useRef<HTMLInputElement>(null);
  const [importState, setImportState] = useState<{ backup?: ParsedBackup; errors?: string[]; understood?: boolean; busy?: boolean } | null>(null);
  const [integrity, setIntegrity] = useState<string>();
  const [confirmClear, setConfirmClear] = useState(false);
  const [alsoDisconnect, setAlsoDisconnect] = useState(true);
  const [pendingShare, setPendingShare] = useState<File | null>(null);
  // Compartilhar (ex.: "Salvar em Arquivos" no iPad) só aparece onde o navegador aceita arquivos JSON.
  const [shareSupported] = useState(() => canShareFile(makeTextFile('teste.json', '{}', 'application/json')));

  async function exportJson() {
    try {
      const file = await exportBackup();
      downloadText(backupFileName('json', today), JSON.stringify(file, null, 2), 'application/json');
      toast.show('Backup JSON exportado.');
    } catch (e) {
      toast.show(describeError(e), { tone: 'danger' });
    }
  }

  async function exportMd() {
    try {
      downloadText(backupFileName('md', today), await exportReadable(), 'text/markdown');
      toast.show('Exportação legível gerada.');
    } catch (e) {
      toast.show(describeError(e), { tone: 'danger' });
    }
  }

  async function handleShare(file: File) {
    const result = await shareFile(file, 'Backup do Rotinas');
    if (result === 'shared') {
      setPendingShare(null);
      toast.show('Backup compartilhado.');
    } else if (result === 'needs-gesture') setPendingShare(file);
    else if (result === 'failed') toast.show('Não foi possível compartilhar. Use "Exportar backup (JSON)".', { tone: 'danger' });
  }

  async function shareJson() {
    try {
      const file = makeTextFile(backupFileName('json', today), JSON.stringify(await exportBackup(), null, 2), 'application/json');
      await handleShare(file);
    } catch (e) {
      toast.show(describeError(e), { tone: 'danger' });
    }
  }

  async function pick(file: File | undefined) {
    if (!file) return;
    try {
      const parsed = parseBackup(await readFileAsText(file));
      setImportState(parsed.ok ? { backup: parsed.backup } : { errors: parsed.errors });
    } catch {
      setImportState({ errors: ['Não foi possível ler o arquivo.'] });
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  return (
    <Section title="Seus dados" id="dados">
      <div className="panel stack">
        <div className="row">
          <HardDrive size={18} aria-hidden="true" />
          <p className="small grow">
            Armazenamento neste navegador: {storage?.supported ? `${formatBytes(storage.usage)} usados` : 'informação indisponível'}.{' '}
            {storage?.persisted === true ? 'Persistente (o navegador não apaga sozinho).' : storage?.persisted === false ? 'Não persistente: o navegador pode apagar dados se faltar espaço.' : ''}
          </p>
          {storage?.persisted === false && (
            <Button
              size="sm"
              onClick={async () => {
                const ok = await requestPersistentStorage();
                setStorageKey((k) => k + 1);
                toast.show(ok ? 'Armazenamento persistente concedido.' : 'O navegador não concedeu agora. Instalar o app ajuda.');
              }}
            >
              Pedir persistência
            </Button>
          )}
        </div>
        <p className="small muted">Não há sincronização em nuvem: faça backups para trocar de aparelho ou se proteger de uma limpeza do navegador.</p>
        <div className="btn-row">
          <Button variant="primary" icon={<Download size={18} aria-hidden="true" />} onClick={() => void exportJson()}>
            Exportar backup (JSON)
          </Button>
          {shareSupported && (
            <Button icon={<Share size={18} aria-hidden="true" />} onClick={() => void shareJson()}>
              Compartilhar backup
            </Button>
          )}
          <Button icon={<Download size={18} aria-hidden="true" />} onClick={() => void exportMd()}>
            Exportar versão legível (Markdown)
          </Button>
          <Button icon={<Upload size={18} aria-hidden="true" />} onClick={() => fileRef.current?.click()}>
            Importar backup
          </Button>
          <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(e) => void pick(e.target.files?.[0])} />
        </div>
        {pendingShare && (
          <Notice
            tone="info"
            title="Backup pronto"
            action={
              <Button size="sm" variant="primary" icon={<Share size={16} aria-hidden="true" />} onClick={() => void handleShare(pendingShare)}>
                Compartilhar agora
              </Button>
            }
          >
            O navegador pediu um novo toque para abrir o compartilhamento.
          </Notice>
        )}
        <p className="meta">O backup inclui o Diário. A senha do servidor e o estado das integrações não entram no arquivo.</p>
        <hr className="divider" />
        <div className="row">
          <Button
            size="sm"
            icon={<ShieldCheck size={16} aria-hidden="true" />}
            onClick={async () => {
              const r = await verifyProgressIntegrity();
              setIntegrity(r.ok ? `XP íntegro: ${r.storedXp} XP batem com o histórico.` : `Divergência: gravado ${r.storedXp} XP, histórico produz ${r.derivedXp} XP. Use “Recalcular”.`);
            }}
          >
            Verificar XP
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={<RotateCcw size={16} aria-hidden="true" />}
            onClick={async () => {
              const n = await rebuildProgressEvents();
              setIntegrity(`XP recalculado a partir de ${n} eventos do histórico.`);
            }}
          >
            Recalcular a partir do histórico
          </Button>
        </div>
        {integrity && <p className="small" role="status">{integrity}</p>}
        <hr className="divider" />
        <div>
          <p className="switch-label">Apagar todos os dados locais</p>
          <p className="small muted" style={{ marginTop: 4 }}>
            Remove perfil, hábitos, registros, metas, agenda, Diário, check-ins e histórico do Kai deste navegador. Exporte um backup antes.
          </p>
          <div className="btn-row" style={{ marginTop: 8 }}>
            <Button icon={<Download size={18} aria-hidden="true" />} onClick={() => void exportJson()}>
              Exportar antes
            </Button>
            <Button variant="danger" icon={<Trash size={18} aria-hidden="true" />} onClick={() => setConfirmClear(true)}>
              Apagar tudo
            </Button>
          </div>
        </div>
      </div>

      <Dialog
        open={importState !== null}
        onClose={() => setImportState(null)}
        title="Importar backup"
        footer={
          importState?.backup ? (
            <>
              <Button onClick={() => setImportState(null)}>Cancelar</Button>
              <Button
                variant="danger"
                disabled={!importState.understood}
                busy={importState.busy}
                onClick={async () => {
                  if (!importState.backup) return;
                  setImportState({ ...importState, busy: true });
                  try {
                    await restoreBackup(importState.backup);
                    toast.show('Backup restaurado.');
                    setImportState(null);
                  } catch (e) {
                    setImportState({ errors: [describeError(e)] });
                  }
                }}
              >
                Substituir meus dados
              </Button>
            </>
          ) : (
            <Button onClick={() => setImportState(null)}>Fechar</Button>
          )
        }
      >
        {importState?.errors && (
          <Notice tone="danger" title="Este arquivo não pode ser importado" role="alert">
            <ul>
              {importState.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </Notice>
        )}
        {importState?.backup && (
          <div className="stack">
            <p className="small">Backup gerado em {new Date(importState.backup.exportedAt).toLocaleString('pt-BR')} (versão de dados {importState.backup.schemaVersion}).</p>
            <ul className="small">
              {(Object.entries(importState.backup.counts) as Array<[BackupTableName, number]>)
                .filter(([, n]) => n > 0)
                .map(([k, n]) => (
                  <li key={k}>
                    {TABLE_LABEL[k]}: {n}
                  </li>
                ))}
            </ul>
            {importState.backup.warnings.map((w) => (
              <Notice key={w} tone="warn">
                {w}
              </Notice>
            ))}
            <Notice tone="warn">Restaurar substitui todos os dados atuais deste navegador pelo conteúdo do backup. O XP é recalculado a partir do histórico importado.</Notice>
            <CheckField label="Entendo que os dados atuais serão substituídos" checked={Boolean(importState.understood)} onChange={(understood) => setImportState({ ...importState, understood })} />
          </div>
        )}
      </Dialog>

      <ConfirmDialog
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        title="Apagar todos os dados locais?"
        danger
        requireText="APAGAR"
        confirmLabel="Apagar tudo"
        message={
          <div className="stack small">
            <p>Tudo o que o Rotinas guardou neste navegador será removido. Não dá para desfazer sem um backup.</p>
            {integration?.status === 'connected' && prefs.consents.calendar.granted && (
              <CheckField label="Também desconectar o Google Calendar no servidor (revogar e apagar tokens)" checked={alsoDisconnect} onChange={setAlsoDisconnect} />
            )}
          </div>
        }
        onConfirm={async () => {
          try {
            if (alsoDisconnect && integration?.status === 'connected' && prefs.consents.calendar.granted) {
              await calendarDisconnect(prefs).catch(() => undefined);
            }
            await clearAllData();
            clearUiPrefs();
            // Um novo começo (ou restauração) abre na tela Hoje, não nesta.
            goToToday();
            toast.show('Todos os dados locais foram apagados.');
          } catch (e) {
            toast.show(describeError(e), { tone: 'danger' });
          }
          setConfirmClear(false);
        }}
      />
    </Section>
  );
}

function AboutSection() {
  return (
    <Section title="Sobre esta versão" id="sobre">
      <div className="panel stack small">
        <p>Rotinas 1.0 — organizador pessoal local. Sem conta, sem anúncios, sem telemetria e sem fontes ou scripts de terceiros: tudo o que a interface usa vem junto com o app.</p>
        <p>O Rotinas não faz diagnósticos nem promete resultados de saúde, produtividade ou finanças.</p>
        <p className="muted">Esta versão aplica privacidade por padrão, mas não foi auditada de forma independente e não alega certificações ou conformidade completa com leis de proteção de dados. Antes de oferecê-la a outras pessoas, ela requer revisão de segurança e jurídica.</p>
      </div>
    </Section>
  );
}
