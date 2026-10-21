import { z } from 'zod';

/** Contrato da integração opcional com Google Calendar (camada privada). */

export const GOOGLE_SCOPES = {
  /** Somente disponibilidade (livre/ocupado). Não lê títulos nem detalhes de eventos. */
  availability: 'https://www.googleapis.com/auth/calendar.freebusy',
  /** Só leitura dos eventos das agendas que a pessoa possui (título, horário e cor) — opcional. */
  events: 'https://www.googleapis.com/auth/calendar.events.owned.readonly',
  /** Criar uma agenda secundária "Rotinas" e gerenciar apenas os eventos dela. */
  write: 'https://www.googleapis.com/auth/calendar.app.created',
} as const;

export type CalendarAccess = 'availability' | 'events' | 'write';

export const APP_CALENDAR_NAME = 'Rotinas';

const isoInstant = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'Data/hora inválida');

export interface CalendarStatus {
  configured: boolean;
  reason?: string;
  connected: boolean;
  scopes: string[];
  canReadAvailability: boolean;
  canReadEvents: boolean;
  canWrite: boolean;
  calendarName?: string;
  authorizedAt?: string;
  /** Por onde o app fala com o Google: a camada privada (OAuth próprio) ou o conector do Claude. */
  via?: 'server' | 'claude';
  /** Só pelo Claude: estado da permissão do app para usar o conector (sem perguntar nada). */
  permission?: 'granted' | 'prompt' | 'denied' | 'unavailable';
  /** Só pelo Claude: `unasked` = a pessoa ainda não foi consultada sobre o conector nesta página. */
  connector?: 'ready' | 'unasked';
}

export const calendarConnectRequestSchema = z.object({ access: z.enum(['availability', 'events', 'write']) });

export const freeBusyRequestSchema = z
  .object({ timeMin: isoInstant, timeMax: isoInstant, timeZone: z.string().min(1).max(64) })
  .refine((r) => Date.parse(r.timeMax) > Date.parse(r.timeMin), 'Intervalo inválido')
  .refine((r) => Date.parse(r.timeMax) - Date.parse(r.timeMin) <= 62 * 86_400_000, 'Intervalo máximo de 62 dias');

/** Leitura de eventos: no máximo 31 dias por pedido. */
export const calendarEventsRequestSchema = z
  .object({ timeMin: isoInstant, timeMax: isoInstant, timeZone: z.string().min(1).max(64) })
  .refine((r) => Date.parse(r.timeMax) > Date.parse(r.timeMin), 'Intervalo inválido')
  .refine((r) => Date.parse(r.timeMax) - Date.parse(r.timeMin) <= 31 * 86_400_000, 'Intervalo máximo de 31 dias');

export interface BusyBlock {
  start: string;
  end: string;
}

/** Evento do Google reduzido ao mínimo necessário (nunca descrição, local ou participantes). */
export interface GoogleEvent {
  id: string;
  title: string;
  allDay: boolean;
  /** `AAAA-MM-DD` (dia inteiro) ou instante ISO. */
  start: string;
  /** Exclusivo, como na API do Google. */
  end: string;
  /** false quando o evento está marcado como "Disponível" no Google. */
  busy: boolean;
  colorId?: string;
  calendar: 'primary' | 'rotinas';
}

export const calendarBlockSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    start: isoInstant,
    end: isoInstant,
    timeZone: z.string().min(1).max(64),
    description: z.string().max(500).optional(),
  })
  .refine((b) => Date.parse(b.end) > Date.parse(b.start), 'O fim precisa ser depois do início');
export type CalendarBlock = z.infer<typeof calendarBlockSchema>;

export const calendarPreviewRequestSchema = z.object({ blocks: z.array(calendarBlockSchema).min(1).max(20) });

export interface CalendarPreview {
  /** Comprovante assinado pelo servidor, válido por 10 minutos e preso a estes blocos exatos. */
  previewToken: string;
  expiresAt: string;
  blocks: Array<CalendarBlock & { conflicts: BusyBlock[] }>;
  /** Onde os eventos serão criados, em texto para a pessoa (ex.: agenda “Rotinas” ou agenda principal). */
  target?: string;
}

/** Lembrete diário criado no Google Agenda (para a sessão da noite, quando o app não pode notificar). */
export const dailyReminderRequestSchema = z.object({
  title: z.string().trim().min(1).max(120),
  /** Horário local `HH:mm` no fuso informado. */
  time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  /** Primeiro dia (`AAAA-MM-DD`). */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timeZone: z.string().min(1).max(64),
  durationMinutes: z.number().int().min(5).max(120),
  description: z.string().max(500).optional(),
});
export type DailyReminderRequest = z.infer<typeof dailyReminderRequestSchema>;

/**
 * A escrita só acontece com o comprovante de uma prévia recente, os mesmos blocos e confirmação explícita.
 * Repetir a confirmação não duplica eventos (ids determinísticos no Google).
 */
export const calendarCommitRequestSchema = z.object({
  previewToken: z.string().min(20).max(4096),
  blocks: z.array(calendarBlockSchema).min(1).max(20),
  confirm: z.literal(true),
});

export interface CalendarCommitResult {
  calendarId: string;
  created: Array<{ index: number; eventId: string }>;
}

export const calendarErrorCodes = [
  'calendar_disabled',
  'not_connected',
  'scope_missing',
  'invalid_request',
  'preview_expired',
  'provider_error',
  'unauthorized',
  'forbidden_origin',
  'server_locked',
  'rate_limited',
] as const;
export type CalendarErrorCode = (typeof calendarErrorCodes)[number];

export type CalendarApiResponse<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: {
        code: CalendarErrorCode;
        message: string;
        /** Na escrita em lote: eventos que o Google chegou a criar antes da falha (para não duplicar). */
        partial?: CalendarCommitResult;
      };
    };

/** Paleta padrão de cores de evento do Google (colorId 1–11), para mostrar a mesma cor no app. */
export const GOOGLE_EVENT_COLORS: Record<string, string> = {
  '1': '#7986cb',
  '2': '#33b679',
  '3': '#8e24aa',
  '4': '#e67c73',
  '5': '#f6bf26',
  '6': '#f4511e',
  '7': '#039be5',
  '8': '#616161',
  '9': '#3f51b5',
  '10': '#0b8043',
  '11': '#d50000',
};
