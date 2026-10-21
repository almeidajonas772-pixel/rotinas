import type { ConsentKey } from '../../domain/schemas';
import { isClaudeRuntime } from '../../platform/runtime';

/**
 * Textos de cada autorização. Cada uma é específica: dizer "sim" para uma nunca liga outra.
 * Se um texto mudar, incremente a versão dele em CONSENT_VERSIONS (db/defaults.ts).
 * Dentro do Claude o caminho dos dados é outro (sem servidor próprio), então os textos também:
 * veja CLAUDE_CONSENT_TEXTS e as versões do Claude em db/defaults.ts.
 */

export interface ConsentText {
  title: string;
  summary: string;
  sends: string[];
  neverSends: string[];
  destination: string;
  when: string;
  revoke: string;
}

export const CONSENT_TEXTS: Record<ConsentKey, ConsentText> = {
  kai: {
    title: 'Coaching por IA (Kai)',
    summary: 'Permite que o Kai analise seus hábitos e metas para conversar, sugerir próximos passos e fazer revisões semanais.',
    sends: [
      'Seu objetivo principal, períodos livres e minutos por dia (se informados)',
      'Títulos, categorias, frequências e horários dos hábitos não arquivados',
      'Contagens do período analisado: previstas, concluídas, puladas, perdidas e sequências',
      'Títulos, períodos e progresso calculado das metas',
      'O texto que você escrever na conversa com o Kai',
      'Na sessão da noite: o que você falar ou escrever ao Kai, a prioridade do dia que você definir e o resumo calculado pelo app (hábitos de hoje, XP do dia, horários dos hábitos de amanhã e ritmo das metas)',
    ],
    neverSends: [
      'Seu nome',
      'Observações das conclusões',
      'Check-ins, Diário e títulos da agenda (exigem autorizações próprias)',
      'O áudio da sua voz (só o texto já reconhecido)',
      'Identificadores internos do banco local',
    ],
    destination: 'Sua camada privada (servidor do Rotinas) envia os dados à Anthropic, provedora do modelo de IA, e devolve a resposta.',
    when: 'Somente quando você pede algo ao Kai. Nada é enviado em segundo plano.',
    revoke: 'Desligue a qualquer momento em Kai ou em Configurações → Autorizações. Revogar também desliga as autorizações de check-ins, Diário e agenda no Kai.',
  },
  kaiCheckins: {
    title: 'Check-ins no Kai',
    summary: 'Inclui as notas de humor e energia (1 a 5) do período analisado no contexto do Kai.',
    sends: ['Data e notas numéricas de humor e energia do período analisado'],
    neverSends: ['O comentário escrito do check-in'],
    destination: 'Camada privada → Anthropic, junto do pedido ao Kai.',
    when: 'Somente nos pedidos ao Kai feitos enquanto esta autorização estiver ativa.',
    revoke: 'Desligue em Kai ou em Configurações → Autorizações.',
  },
  kaiJournal: {
    title: 'Diário no Kai',
    summary: 'Permite que o Kai leia trechos das suas reflexões para resumir padrões e sugerir ajustes.',
    sends: ['Trechos de até 600 caracteres das entradas do período analisado (no máximo 7 entradas)'],
    neverSends: ['Entradas que você marcar como “não compartilhar com o Kai”', 'Entradas fora do período analisado'],
    destination: 'Camada privada → Anthropic, junto do pedido ao Kai.',
    when: 'Somente nos pedidos ao Kai feitos enquanto esta autorização estiver ativa.',
    revoke: 'Desligue em Kai ou em Configurações → Autorizações (cada entrada também pode ser bloqueada no Diário). O Diário volta a ficar só no aparelho.',
  },
  kaiAgenda: {
    title: 'Agenda no Kai (sessão da noite)',
    summary: 'Permite que o Kai veja seus compromissos de hoje e de amanhã para ajudar a decidir o dia seguinte — inclusive eventos do Google Agenda, se você conectou a leitura de eventos.',
    sends: [
      'Títulos e horários das tarefas e eventos de hoje e de amanhã (do Rotinas e, se conectado, do Google Agenda)',
      'As janelas livres de amanhã calculadas pelo app',
      'Título e data de provas e prazos detectados nos próximos 7 dias',
    ],
    neverSends: ['Descrição, local e participantes dos eventos (o app nem pede esses dados ao Google)', 'Compromissos fora dos próximos 8 dias', 'Notas dos itens da agenda'],
    destination: 'Camada privada → Anthropic, junto do pedido da sessão da noite.',
    when: 'Somente nos pedidos da sessão da noite feitos enquanto esta autorização estiver ativa.',
    revoke: 'Desligue na tela Noite, em Kai ou em Configurações → Autorizações.',
  },
  calendar: {
    title: 'Calendário externo (Google Calendar)',
    summary:
      'Permite consultar quando você está ocupado, ler (se você permitir também no Google) título, horário e cor dos eventos da sua agenda principal e, se você autorizar a escrita, criar blocos confirmados numa agenda própria chamada “Rotinas”.',
    sends: [
      'Intervalo de datas consultado e seu fuso horário (para saber os horários ocupados ou listar eventos)',
      'Título, horário e duração dos blocos que você confirmar para criar no Google',
    ],
    neverSends: ['Hábitos, metas, Diário ou check-ins que não estejam num bloco confirmado por você'],
    destination: 'Camada privada → Google Calendar API. Os tokens de acesso ficam só no servidor, criptografados; os eventos lidos vêm para este aparelho e não ficam guardados no servidor.',
    when: 'Quando você abre as telas que usam a agenda (Calendário externo e Noite), pede horários no planejador ou confirma a criação de blocos.',
    revoke: 'Use “Desconectar e revogar” em Calendário externo: o servidor revoga o acesso no Google e apaga os tokens.',
  },
  voice: {
    title: 'Conversa por voz',
    summary: 'Permite falar com o Rotinas pelo microfone e ouvir as respostas com as vozes do navegador.',
    sends: [
      'O áudio do que você fala enquanto o microfone estiver ligado, para o serviço de reconhecimento de fala do seu navegador ou sistema (por exemplo: Google no Chrome, Microsoft no Edge, Apple no Safari), que pode processá-lo nos servidores do fabricante',
      'Se você escolher uma voz marcada como “online”: o texto lido em voz alta, para o serviço dessa voz',
    ],
    neverSends: ['O áudio não é gravado pelo Rotinas nem enviado à sua camada privada', 'Nada é ouvido com o microfone desligado'],
    destination: 'Serviço de voz do navegador ou do sistema (depende do aparelho). O texto reconhecido só vai ao Kai se o Kai estiver autorizado.',
    when: 'Só enquanto o microfone estiver ligado (indicador vermelho “Ouvindo”). Vozes do próprio aparelho leem as respostas sem enviar nada.',
    revoke: 'Desligue na tela Noite (Ajustes de voz) ou em Configurações → Autorizações. Também é possível bloquear o microfone nas permissões do site.',
  },
  notifications: {
    title: 'Notificações locais',
    summary: 'Permite que este aparelho mostre lembretes dos hábitos com lembrete ligado.',
    sends: ['Nada sai do aparelho: o próprio navegador mostra a notificação'],
    neverSends: ['Nenhum dado é enviado a provedores'],
    destination: 'Somente este navegador.',
    when: 'No horário de cada lembrete, fora da janela silenciosa e dentro do limite diário, com o app aberto.',
    revoke: 'Desligue em Configurações → Notificações ou bloqueie as notificações do site no navegador.',
  },
};

/**
 * Textos do Rotinas dentro do Claude: o Kai usa o Claude da conta da pessoa e o Google usa o
 * conector do Claude. Mudou um texto daqui? Incremente a versão dele em CLAUDE_CONSENT_VERSIONS.
 */
export const CLAUDE_CONSENT_TEXTS: Record<ConsentKey, ConsentText> = {
  kai: {
    ...CONSENT_TEXTS.kai,
    sends: [
      'Seu objetivo principal, períodos livres e minutos por dia (se informados)',
      'Títulos, categorias, frequências e horários dos hábitos não arquivados',
      'Contagens do período analisado: previstas, concluídas, puladas, perdidas e sequências',
      'Títulos, períodos e progresso calculado das metas',
      'O texto que você escrever na conversa com o Kai',
      'Na sessão da noite: o que você escrever ao Kai (inclusive por ditado do teclado), a prioridade do dia que você definir e o resumo calculado pelo app (hábitos de hoje, XP do dia, horários dos hábitos de amanhã e ritmo das metas)',
    ],
    neverSends: ['Seu nome', 'Observações das conclusões', 'Check-ins, Diário e títulos da agenda (exigem autorizações próprias)', 'Áudio: dentro do Claude o Rotinas não usa o microfone', 'Identificadores internos do app'],
    destination:
      'O Claude, na sua própria conta (Anthropic), pela plataforma do claude.ai: o pedido conta no uso do seu plano, como uma conversa sua. Não há servidor do Rotinas no caminho nem chave de API. Na primeira vez, o próprio Claude pergunta se este app pode usá-lo.',
    revoke: 'Desligue a qualquer momento em Kai ou em Configurações → Autorizações. Revogar também desliga as autorizações de check-ins, Diário e agenda no Kai. Você também pode bloquear o uso do Claude por este app em Permissões, no menu do artifact.',
  },
  kaiCheckins: { ...CONSENT_TEXTS.kaiCheckins, destination: 'O Claude, na sua conta, junto do pedido ao Kai.' },
  kaiJournal: {
    ...CONSENT_TEXTS.kaiJournal,
    destination: 'O Claude, na sua conta, junto do pedido ao Kai.',
    revoke: 'Desligue em Kai ou em Configurações → Autorizações (cada entrada também pode ser bloqueada no Diário). O Diário volta a não ser enviado ao Kai.',
  },
  kaiAgenda: { ...CONSENT_TEXTS.kaiAgenda, destination: 'O Claude, na sua conta, junto do pedido da sessão da noite.' },
  calendar: {
    title: 'Google Agenda (pelo conector do Claude)',
    summary:
      'Permite que o Rotinas use o conector do Google Calendar que você conectou ao seu Claude para ler título, horário e cor dos eventos da agenda principal, saber quando você está ocupado e, só depois da sua confirmação, criar blocos de tempo e o lembrete da noite.',
    sends: [
      'Ao Google (pelo conector): o intervalo de datas consultado e o seu fuso horário',
      'Ao Google: título, horário e duração dos blocos e lembretes que você confirmar',
    ],
    neverSends: ['Hábitos, metas, Diário ou check-ins que não estejam num bloco confirmado por você', 'Descrição, local e participantes dos seus eventos (o app descarta esses campos ao ler)'],
    destination:
      'O conector do Google Calendar da sua conta do Claude, que fala com o Google em seu nome. O Rotinas não vê nem guarda senhas ou tokens do Google, e os eventos lidos não são guardados. Na primeira leitura, o Claude pergunta se este app pode usar o conector.',
    when: 'Quando você abre as telas que usam a agenda (Calendário externo e Noite), pede horários no planejador ou confirma a criação de blocos.',
    revoke: 'Desligue aqui no Rotinas (Calendário externo ou Configurações → Autorizações): o app para de usar o conector na hora. Para cortar o acesso do Claude ao Google, desconecte o Google Calendar em claude.ai → Configurações → Conectores.',
  },
  voice: {
    title: 'Vozes online',
    summary: 'Permite ler as respostas do Kai em voz alta também com vozes “online” do navegador. Vozes do próprio aparelho funcionam sem esta autorização.',
    sends: ['Se você escolher uma voz marcada como “online”: o texto lido em voz alta, para o serviço dessa voz (Google, Microsoft ou Apple, conforme o aparelho)'],
    neverSends: ['Áudio: dentro do Claude o Rotinas não usa o microfone (para falar, use o ditado do teclado)'],
    destination: 'Serviço de voz do navegador ou do sistema, só para vozes online.',
    when: 'Só quando uma resposta é lida em voz alta com uma voz online.',
    revoke: 'Desligue na tela Noite (Ajustes de voz) ou em Configurações → Autorizações.',
  },
  notifications: {
    ...CONSENT_TEXTS.notifications,
    summary: 'Dentro do Claude, o app não pode mostrar notificações. Para lembretes, use o lembrete da noite e os blocos no Google Agenda.',
  },
};

/** O texto da autorização no ambiente atual (site ou dentro do Claude). */
export function consentText(key: ConsentKey): ConsentText {
  return isClaudeRuntime() ? CLAUDE_CONSENT_TEXTS[key] : CONSENT_TEXTS[key];
}
