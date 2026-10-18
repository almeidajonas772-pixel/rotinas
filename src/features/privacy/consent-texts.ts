import type { ConsentKey } from '../../domain/schemas';

/**
 * Textos de cada autorização. Cada uma é específica: dizer "sim" para uma nunca liga outra.
 * Se um texto mudar, incremente a versão dele em CONSENT_VERSIONS (db/defaults.ts).
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
