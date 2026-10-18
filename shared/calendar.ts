import { z } from 'zod';

/** Contrato da integração opcional com Google Calendar (camada privada). */

export const GOOGLE_SCOPES = {
  /** Somente disponibilidade (livre/ocupado). Não lê títulos nem detalhes de eventos. */
  availability: 'https://www.googleapis.com/auth/calendar.freebusy',
  /** Criar uma agenda secundária "Rotinas" e gerenciar apenas os eventos dela. */
  write: 'https://www.googleapis.com/auth/calendar.app.created',
} as const;

export const APP_CALENDAR_NAME = 'Rotinas';

const isoInstant = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'Data/hora inválida');

export interface CalendarStatus {
  configured: boolean;
  reason?: string;
  connected: boolean;
  scopes: string[];
  canReadAvailability: boolean;
  canWrite: boolean;
  calendarName?: string;
  authorizedAt?: string;
}

export const calendarConnectRequestSchema = z.object({ access: z.enum(['availability', 'write']) });

export const freeBusyRequestSchema = z
  .object({ timeMin: isoInstant, timeMax: isoInstant, timeZone: z.string().min(1).max(64) })
  .refine((r) => Date.parse(r.timeMax) > Date.parse(r.timeMin), 'Intervalo inválido')
  .refine((r) => Date.parse(r.timeMax) - Date.parse(r.timeMin) <= 62 * 86_400_000, 'Intervalo máximo de 62 dias');

export interface BusyBlock {
  start: string;
  end: string;
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
  previewId: string;
  expiresAt: string;
  blocks: Array<CalendarBlock & { conflicts: BusyBlock[] }>;
}

/** A escrita só acontece com o id de uma prévia recente e confirmação explícita. */
export const calendarCommitRequestSchema = z.object({
  previewId: z.string().uuid(),
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
