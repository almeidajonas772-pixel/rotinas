import type { ConsentKey } from '../../domain/schemas';

/**
 * Textos de cada autorização (versão 1). Cada uma é específica: dizer "sim" para uma
 * nunca liga outra. Se um texto mudar, incremente CONSENT_TEXT_VERSION em db/defaults.ts.
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
    ],
    neverSends: ['Seu nome', 'Observações das conclusões', 'Check-ins e Diário (exigem autorizações próprias)', 'Identificadores internos do banco local'],
    destination: 'Sua camada privada (servidor do Rotinas) envia os dados à Anthropic, provedora do modelo de IA, e devolve a resposta.',
    when: 'Somente quando você pede algo ao Kai. Nada é enviado em segundo plano.',
    revoke: 'Desligue a qualquer momento em Kai ou em Configurações → Autorizações. Revogar também desliga as autorizações de check-ins e Diário no Kai.',
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
  calendar: {
    title: 'Calendário externo (Google Calendar)',
    summary: 'Permite consultar quando você está ocupado e, se você autorizar a escrita, criar blocos confirmados numa agenda própria chamada “Rotinas”.',
    sends: [
      'Intervalo de datas consultado e seu fuso horário (para saber os horários ocupados)',
      'Título, horário e duração dos blocos que você confirmar para criar no Google',
    ],
    neverSends: ['Hábitos, metas, Diário ou check-ins que não estejam num bloco confirmado por você'],
    destination: 'Camada privada → Google Calendar API. Os tokens de acesso ficam só no servidor, criptografados.',
    when: 'Somente quando você pede horários no planejador (consulta de livre/ocupado) ou confirma a criação de blocos. Abrir a tela só pergunta à sua camada privada se a conexão existe.',
    revoke: 'Use “Desconectar e revogar” em Calendário externo: o servidor revoga o acesso no Google e apaga os tokens.',
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
