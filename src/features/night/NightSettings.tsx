import { Link } from 'react-router';
import { GOOGLE_EVENT_COLORS } from '../../../shared/calendar';
import { useApp } from '../../app/context';
import { SelectField, SwitchRow, TextField } from '../../components/form';
import { useToast } from '../../components/toast';
import { Notice } from '../../components/ui';
import { describeError } from '../../db/errors';
import { setConsent, updatePrefs } from '../../db/repo-profile';
import type { ConsentKey } from '../../domain/schemas';
import { notificationPermission } from '../../lib/notifications';
import type { VoiceApi } from './use-voice';

/** Nomes das cores de evento do Google Agenda (colorId 1–11), com a cor comum entre parênteses. */
const GOOGLE_COLOR_NAMES: Array<[string, string]> = [
  ['6', 'Tangerina (laranja)'],
  ['11', 'Tomate (vermelho)'],
  ['5', 'Banana (amarelo)'],
  ['4', 'Flamingo (rosa)'],
  ['3', 'Uva (roxo)'],
  ['1', 'Lavanda (lilás)'],
  ['9', 'Mirtilo (azul-escuro)'],
  ['7', 'Pavão (azul)'],
  ['10', 'Manjericão (verde)'],
  ['2', 'Sálvia (verde-claro)'],
  ['8', 'Grafite (cinza)'],
];

/** Ajustes da sessão da noite: voz, autorizações específicas, cores do radar e lembrete. */
export function NightSettings({ voice, onAsk }: { voice: VoiceApi; onAsk: (key: ConsentKey) => void }) {
  const { prefs } = useApp();
  const toast = useToast();
  const n = prefs.nightly;
  const set = (patch: Partial<typeof n>) =>
    void updatePrefs((p) => ({ ...p, nightly: { ...p.nightly, ...patch } })).catch((e) => toast.show(describeError(e), { tone: 'danger' }));
  const revoke = (key: ConsentKey) =>
    void setConsent(key, false)
      .then(() => toast.show('Autorização revogada.'))
      .catch((e) => toast.show(describeError(e), { tone: 'danger' }));

  /** Uma cor indica um tipo só: marcar em "provas" tira de "prazos" e vice-versa. */
  const toggleColor = (kind: 'prova' | 'prazo', id: string) => {
    const other = kind === 'prova' ? 'prazo' : 'prova';
    const current = n.flagColors ?? { prova: [], prazo: [] };
    const list = current[kind].includes(id) ? current[kind].filter((c) => c !== id) : [...current[kind], id];
    set({ flagColors: { ...current, [kind]: list, [other]: current[other].filter((c) => c !== id) } as NonNullable<typeof n.flagColors> });
  };

  const ptVoices = voice.voices.filter((v) => v.lang.toLowerCase().startsWith('pt'));
  const listed = ptVoices.length > 0 ? ptVoices : voice.voices;
  const notificationsOn = prefs.notifications.channel === 'local' && prefs.consents.notifications.granted && notificationPermission() === 'granted';

  return (
    <div className="panel">
      <SwitchRow
        label="Ler em voz alta"
        description={voice.support.synthesis ? 'O resumo e as respostas do Kai são lidos pela voz escolhida.' : 'Este navegador não oferece síntese de voz.'}
        checked={n.speak && voice.support.synthesis}
        disabled={!voice.support.synthesis}
        onChange={(speak) => set({ speak })}
      />
      {voice.support.synthesis && (
        <div className="field-row" style={{ marginTop: 8 }}>
          <SelectField
            label="Voz"
            value={n.voiceURI && listed.some((v) => v.uri === n.voiceURI) ? n.voiceURI : ''}
            onChange={(v) => set({ voiceURI: v || undefined })}
            hint={
              voice.voice
                ? `Em uso: ${voice.voice.name}${voice.voice.local ? ' (no aparelho)' : ' (online)'}.`
                : 'Nenhuma voz em português encontrada neste aparelho: a leitura usa a voz padrão do sistema.'
            }
            options={[
              { value: '', label: 'Automática (prefere vozes do aparelho)' },
              ...listed.map((v) => ({
                value: v.uri,
                label: `${v.name} — ${v.local ? 'no aparelho' : 'online'}`,
                disabled: !v.local && !prefs.consents.voice.granted,
              })),
            ]}
          />
          <SelectField
            label="Velocidade"
            value={String(n.rate)}
            onChange={(v) => set({ rate: Number(v) })}
            options={[
              { value: '0.9', label: 'Calma' },
              { value: '1', label: 'Normal' },
              { value: '1.1', label: 'Um pouco mais rápida' },
              { value: '1.2', label: 'Rápida' },
            ]}
          />
        </div>
      )}
      {voice.support.synthesis && !prefs.consents.voice.granted && listed.some((v) => !v.local) && (
        <p className="meta">Vozes “online” enviam o texto ao fabricante; ficam disponíveis com a autorização de voz.</p>
      )}

      <SwitchRow
        label="Falar pelo microfone"
        description={
          voice.support.recognition
            ? 'Usa o reconhecimento de fala do navegador (o áudio pode ir aos servidores do fabricante). O Rotinas não grava áudio.'
            : voice.support.iosStandalone
              ? 'No app instalado no iPad/iPhone, use o microfone do teclado no campo de texto. Esta autorização vale para vozes online.'
              : 'Este navegador não oferece reconhecimento de fala; use o campo de texto. Esta autorização vale para vozes online.'
        }
        checked={prefs.consents.voice.granted}
        onChange={(on) => (on ? onAsk('voice') : revoke('voice'))}
      />
      {prefs.consents.voice.outdated && <p className="meta">O texto desta autorização mudou: revise para voltar a usar.</p>}
      <SwitchRow
        label="Conversa contínua"
        description="Depois que o Kai fala, o microfone volta a ouvir sozinho. Toque na esfera para parar."
        checked={n.handsFree && voice.support.recognition}
        disabled={!voice.support.recognition || !prefs.consents.voice.granted}
        onChange={(handsFree) => set({ handsFree })}
      />
      <SwitchRow
        label="Agenda no Kai"
        description={
          prefs.consents.kai.granted
            ? 'O Kai vê títulos e horários de hoje e amanhã (inclusive do Google, se conectado) e provas/prazos da semana. Sem isto, ele só vê números e horários dos hábitos.'
            : 'Ative o Kai primeiro.'
        }
        checked={prefs.consents.kaiAgenda.granted}
        disabled={!prefs.consents.kai.granted}
        onChange={(on) => (on ? onAsk('kaiAgenda') : revoke('kaiAgenda'))}
      />

      <fieldset className="night-colors">
        <legend className="switch-label">Cores do Google para provas e prazos</legend>
        <p className="meta">
          Se você pinta avaliações e prazos com cores próprias no Google Agenda, marque-as: eventos dessas cores entram no radar mesmo sem palavras como “prova” ou “entrega” no título. Aulas,
          reforços e blocos de estudo nunca entram.
        </p>
        {(['prova', 'prazo'] as const).map((kind) => (
          <div key={kind} className="night-color-row">
            <p className="field-label">{kind === 'prova' ? 'Provas e avaliações' : 'Prazos e entregas'}</p>
            <div className="chips">
              {GOOGLE_COLOR_NAMES.map(([id, name]) => {
                const on = (n.flagColors?.[kind] ?? []).includes(id);
                return (
                  <button key={id} type="button" className="chip" aria-pressed={on} onClick={() => toggleColor(kind, id)}>
                    <span className="month-dot" style={{ background: GOOGLE_EVENT_COLORS[id] }} aria-hidden="true" />
                    {name}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </fieldset>

      <SwitchRow
        label="Lembrete da noite"
        description={
          notificationsOn
            ? `Uma notificação diária no horário escolhido, com o app aberto (aba ou app instalado). Nada sai do aparelho.`
            : 'Requer os lembretes locais ativos (Configurações → Notificações).'
        }
        checked={n.reminder.enabled && notificationsOn}
        disabled={!notificationsOn}
        onChange={(enabled) => set({ reminder: { ...n.reminder, enabled } })}
      />
      {!notificationsOn && (
        <p className="meta" style={{ marginBottom: 8 }}>
          <Link to="/configuracoes#notificacoes">Ativar lembretes locais</Link>
        </p>
      )}
      {n.reminder.enabled && notificationsOn && (
        <div style={{ maxWidth: 220 }}>
          <TextField label="Horário do lembrete" type="time" value={n.reminder.time} onChange={(time) => time && set({ reminder: { ...n.reminder, time } })} />
        </div>
      )}
      {voice.support.iosStandalone && (
        <Notice tone="neutral">
          No iPad/iPhone com o Rotinas instalado na Tela de Início, o navegador não libera o reconhecimento de fala para apps instalados. Para falar com o Kai, toque no campo de texto e use o microfone do teclado; a resposta continua sendo lida em voz alta.
        </Notice>
      )}
    </div>
  );
}
