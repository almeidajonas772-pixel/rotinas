import type { BusyBlock, CalendarApiResponse, CalendarBlock, CalendarCommitResult, CalendarErrorCode, CalendarPreview, CalendarStatus, DailyReminderRequest, GoogleEvent } from '../../shared/calendar';
import { calendarBlockSchema, dailyReminderRequestSchema } from '../../shared/calendar';
import { addDays, minutesToTime, timeToMinutes } from '../domain/civil';
import { instantToWallTime } from '../domain/tz';
import { capabilityErrorCode, claudeCapability, GOOGLE_CALENDAR_CONNECTOR, newRandomId, permissionState, type ClaudeMcp, type McpError } from './claude';

/**
 * Google Agenda pelo conector "Google Calendar" do Claude da própria pessoa (capacidade `mcp`).
 * Não há projeto no Google Cloud, cliente OAuth nem tokens no app: as chamadas usam as
 * credenciais que a pessoa já deu ao Claude e a plataforma pede a permissão na primeira chamada.
 *
 * Mínimo de dados: de cada evento o app guarda só título, início, fim, dia inteiro, ocupado e cor.
 * Descrição, local, participantes e links que o conector devolve são descartados na hora (a
 * descrição só é olhada para reconhecer os eventos que o próprio Rotinas criou). As leituras
 * pedem `cache: false`: nada lido do Google fica guardado, nem no cache da plataforma.
 *
 * Escrita: só depois de uma prévia feita aqui (conflitos conferidos agora) e da confirmação
 * explícita da pessoa. Os blocos vão para uma agenda chamada “Rotinas”, se a pessoa tiver criado
 * uma no Google; senão, para a agenda principal, na cor amarela.
 */

const LIST_TOOL = 'list_events';
const CREATE_TOOL = 'create_event';
const CALENDARS_TOOL = 'list_calendars';
/** Ferramentas do conector que o Rotinas declara (o manifesto do artifact usa esta lista). */
export const CALENDAR_CONNECTOR_TOOLS = [LIST_TOOL, CREATE_TOOL, CALENDARS_TOOL] as const;
/** Cor padrão dos eventos criados pelo app no Google (5 = Banana, amarelo). */
export const BLOCK_COLOR_ID = '5';
/** Marca, na descrição, dos eventos criados pelo Rotinas (eles já estão na agenda do app). */
export const ROTINAS_EVENT_MARK = 'Criado pelo app Rotinas';
const APP_CALENDAR_NAME = 'rotinas';
const MAX_PAGES = 4;
const PREVIEW_TTL_MS = 10 * 60_000;
const NOT_IN_CLAUDE = 'O conector do Google só funciona com o Rotinas aberto dentro do Claude (claude.ai ou app do Claude).';

function ok<T>(data: T): CalendarApiResponse<T> {
  return { ok: true, data };
}

function fail<T>(code: CalendarErrorCode, message: string, partial?: CalendarCommitResult): CalendarApiResponse<T> {
  return { ok: false, error: { code, message, ...(partial ? { partial } : {}) } };
}

/** Mensagem honesta para cada falha do conector (os códigos são do contrato da capacidade `mcp`). */
export function describeConnectorFailure(error: unknown, write = false): { code: CalendarErrorCode; message: string } {
  const code = capabilityErrorCode(error);
  const reported = (error as McpError | undefined)?.message;
  switch (code) {
    case 'needs_reauth':
      return { code: 'not_connected', message: 'A conexão do Google Calendar no seu Claude expirou. Reconecte em claude.ai → Configurações → Conectores e volte aqui.' };
    case 'server_not_connected':
    case 'server_not_found':
      return { code: 'not_connected', message: 'O Google Calendar não está conectado ao seu Claude. Conecte em claude.ai → Configurações → Conectores e volte aqui.' };
    case 'selection_required':
      return { code: 'not_connected', message: 'Há mais de uma conta do Google Calendar no seu Claude. Escolha qual usar quando o Claude perguntar e tente de novo.' };
    case 'not_in_manifest':
    case 'approval_required':
    case 'consent_required':
      return { code: 'not_connected', message: 'O Rotinas ainda não tem a sua permissão para usar o Google Calendar. Toque em “Permitir acesso ao Google Agenda” e aceite no aviso do Claude.' };
    case 'blocked_by_policy':
      return { code: 'calendar_disabled', message: 'A sua organização bloqueia este uso do Google Calendar.' };
    case 'not_granted':
    case 'capability_disabled':
    case 'capability_removed':
      return { code: 'calendar_disabled', message: 'Esta visualização não permite conectores. Abra o Rotinas pelo link no claude.ai.' };
    case 'tool_error':
      return { code: 'provider_error', message: `O Google recusou o pedido${reported ? `: ${reported.slice(0, 200)}` : '.'}` };
    case 'rate_limited':
      return { code: 'rate_limited', message: 'Muitos pedidos ao Google em sequência. Espere um pouco e tente de novo.' };
    case 'cancelled':
      return { code: 'provider_error', message: 'Pedido cancelado.' };
    default:
      return write
        ? { code: 'provider_error', message: 'O Google não confirmou a criação. O evento pode ter sido criado mesmo assim: confira sua agenda antes de tentar de novo.' }
        : { code: 'provider_error', message: 'O Google Calendar não respondeu agora. Tente de novo em instantes.' };
  }
}

// ── Estado da conexão ───────────────────────────────────────────────────────

/** Estado sem chamar ferramentas do conector (listar e ler permissões nunca pergunta nada à pessoa). */
export async function claudeCalendarStatus(): Promise<CalendarApiResponse<CalendarStatus>> {
  const base: CalendarStatus = { configured: true, connected: false, scopes: [], canReadAvailability: false, canReadEvents: false, canWrite: false, via: 'claude' };
  const mcp = await claudeCapability('mcp');
  if (!mcp) return ok({ ...base, configured: false, reason: NOT_IN_CLAUDE });
  let servers;
  try {
    servers = (await mcp.listTools(GOOGLE_CALENDAR_CONNECTOR)).servers;
  } catch (error) {
    const d = describeConnectorFailure(error);
    return ok({ ...base, reason: d.message });
  }
  const server = servers.find((s) => s.server === GOOGLE_CALENDAR_CONNECTOR);
  if (!server || server.tools.length === 0) {
    return ok({ ...base, reason: 'O Google Calendar não está conectado ao seu Claude (ou falta escolher qual conta usar). Conecte em claude.ai → Configurações → Conectores e volte aqui.' });
  }
  if (server.authStatus === 'needs_reauth') {
    return ok({ ...base, reason: 'A conexão do Google Calendar no seu Claude expirou. Reconecte em claude.ai → Configurações → Conectores.' });
  }
  const tools = new Set(server.tools.map((t) => t.name));
  const permission = await permissionState(`mcp:${GOOGLE_CALENDAR_CONNECTOR}`);
  return ok({
    ...base,
    connected: true,
    scopes: [...tools].sort(),
    canReadAvailability: tools.has(LIST_TOOL),
    canReadEvents: tools.has(LIST_TOOL),
    canWrite: tools.has(CREATE_TOOL),
    permission,
    // "unknown": a pessoa ainda não foi consultada sobre este conector nesta página.
    connector: server.authStatus === 'connected' ? 'ready' : 'unasked',
  });
}

// ── Leitura ─────────────────────────────────────────────────────────────────

/** Horário local sem fuso no formato que o conector pede (`2026-10-21T07:00:00`). */
export function toConnectorTime(instant: string, timeZone: string): string {
  const w = instantToWallTime(instant, timeZone);
  return `${w.date}T${w.time}:00`;
}

interface RawEventTime {
  date?: unknown;
  dateTime?: unknown;
}

/** Reduz um evento do conector ao mínimo que o app usa (descarta descrição, local, participantes…). */
export function minimalEvent(raw: unknown): GoogleEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  if (e.status === 'cancelled') return null;
  if (typeof e.id !== 'string' || !e.id) return null;
  const start = (e.start ?? {}) as RawEventTime;
  const end = (e.end ?? {}) as RawEventTime;
  const allDay = typeof start.date === 'string' && !start.dateTime;
  let s: string | undefined;
  let f: string | undefined;
  if (allDay) {
    s = String(start.date).slice(0, 10);
    f = typeof end.date === 'string' ? String(end.date).slice(0, 10) : undefined;
  } else {
    s = typeof start.dateTime === 'string' ? start.dateTime : undefined;
    f = typeof end.dateTime === 'string' ? end.dateTime : undefined;
  }
  if (!s || !f) return null;
  if (!allDay && (Number.isNaN(Date.parse(s)) || Number.isNaN(Date.parse(f)))) return null;
  const transparent = e.transparency === 'transparent' || e.availability === 'AVAILABILITY_FREE';
  const title = typeof e.summary === 'string' && e.summary.trim() ? e.summary.trim().slice(0, 200) : '(sem título)';
  const colorId = typeof e.colorId === 'string' && /^(?:[1-9]|1[01])$/.test(e.colorId) ? e.colorId : undefined;
  const fromApp = typeof e.description === 'string' && e.description.includes(ROTINAS_EVENT_MARK);
  return { id: e.id.slice(0, 200), title, allDay, start: s, end: f, busy: !transparent, ...(colorId ? { colorId } : {}), calendar: fromApp ? 'rotinas' : 'primary' };
}

/**
 * Eventos da agenda principal no intervalo. Os que o próprio Rotinas criou ficam de fora: eles já
 * estão na agenda do app (assim nada aparece duplicado na Noite nem no planejador).
 */
export async function claudeCalendarEvents(range: { timeMin: string; timeMax: string; timeZone: string }, signal?: AbortSignal): Promise<CalendarApiResponse<{ events: GoogleEvent[] }>> {
  const mcp = await claudeCapability('mcp');
  if (!mcp) return fail('calendar_disabled', NOT_IN_CLAUDE);
  const events: GoogleEvent[] = [];
  const seen = new Set<string>();
  let pageToken: string | undefined;
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const input: Record<string, unknown> = {
        startTime: toConnectorTime(range.timeMin, range.timeZone),
        endTime: toConnectorTime(range.timeMax, range.timeZone),
        timeZone: range.timeZone,
        orderBy: 'startTime',
        pageSize: 250,
        ...(pageToken ? { pageToken } : {}),
      };
      const result = await mcp.callTool(GOOGLE_CALENDAR_CONNECTOR, LIST_TOOL, input, { signal, cache: false });
      const payload = (result.payload ?? {}) as { events?: unknown; nextPageToken?: unknown };
      const list = Array.isArray(payload.events) ? payload.events : [];
      for (const raw of list) {
        const ev = minimalEvent(raw);
        if (ev && ev.calendar === 'primary' && !seen.has(ev.id)) {
          seen.add(ev.id);
          events.push(ev);
        }
      }
      pageToken = typeof payload.nextPageToken === 'string' && payload.nextPageToken ? payload.nextPageToken : undefined;
      if (!pageToken) break;
    }
  } catch (error) {
    if (capabilityErrorCode(error) === 'cancelled' && signal?.aborted) throw new DOMException('Pedido cancelado.', 'AbortError');
    const d = describeConnectorFailure(error);
    return fail(d.code, d.message);
  }
  return ok({ events });
}

/** Horários ocupados (eventos com horário e marcados como ocupados), para o planejador. */
export async function claudeCalendarFreeBusy(range: { timeMin: string; timeMax: string; timeZone: string }): Promise<CalendarApiResponse<{ busy: BusyBlock[] }>> {
  const res = await claudeCalendarEvents(range);
  if (!res.ok) return res;
  const busy = res.data.events
    .filter((e) => !e.allDay && e.busy)
    .map((e) => ({ start: new Date(e.start).toISOString(), end: new Date(e.end).toISOString() }))
    .filter((b) => Date.parse(b.end) > Date.parse(b.start));
  return ok({ busy });
}

// ── Onde escrever ───────────────────────────────────────────────────────────

interface Target {
  /** Ausente = agenda principal. */
  calendarId?: string;
  label: string;
}

const PRIMARY_TARGET: Target = { label: 'agenda principal do Google (em amarelo)' };

/** Uma agenda chamada “Rotinas” na conta da pessoa (se ela criou uma); senão, a principal. */
export async function resolveTargetCalendar(mcp: ClaudeMcp): Promise<Target> {
  try {
    const result = await mcp.callTool(GOOGLE_CALENDAR_CONNECTOR, CALENDARS_TOOL, { pageSize: 250 }, { cache: false });
    const list = (result.payload as { calendars?: unknown } | undefined)?.calendars;
    if (!Array.isArray(list)) return PRIMARY_TARGET;
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue;
      const c = raw as { id?: unknown; summary?: unknown; accessRole?: unknown };
      const name = typeof c.summary === 'string' ? c.summary.normalize('NFC').trim().toLowerCase() : '';
      const writable = c.accessRole === undefined || c.accessRole === 'owner' || c.accessRole === 'writer';
      if (name === APP_CALENDAR_NAME && typeof c.id === 'string' && c.id && writable) return { calendarId: c.id, label: 'agenda “Rotinas” do Google' };
    }
  } catch {
    // Sem a lista, escreve na agenda principal (a criação ainda passa pela confirmação).
  }
  return PRIMARY_TARGET;
}

function withMark(description: string | undefined): string {
  const text = (description ?? 'Bloco de tempo confirmado no app Rotinas.').trim();
  return text.includes(ROTINAS_EVENT_MARK) ? text : `${text}\n\n${ROTINAS_EVENT_MARK}.`;
}

function createdEventId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const p = payload as Record<string, unknown>;
  if (typeof p.id === 'string' && p.id) return p.id.slice(0, 300);
  const nested = (p.event ?? p.createdEvent) as Record<string, unknown> | undefined;
  if (nested && typeof nested.id === 'string' && nested.id) return nested.id.slice(0, 300);
  if (typeof p.eventId === 'string' && p.eventId) return p.eventId.slice(0, 300);
  return undefined;
}

// ── Escrita com prévia e confirmação ────────────────────────────────────────

interface StoredPreview {
  token: string;
  expiresAt: number;
  blocksKey: string;
  target: Target;
}

/** Prévias só em memória: valem 10 minutos e só para os mesmos blocos. */
const previews = new Map<string, StoredPreview>();

function blocksKey(blocks: readonly CalendarBlock[]): string {
  return JSON.stringify(blocks.map((b) => [b.title, b.start, b.end, b.timeZone, b.description ?? '']));
}

export async function claudeCalendarPreview(blocks: CalendarBlock[]): Promise<CalendarApiResponse<CalendarPreview>> {
  const valid = blocks.every((b) => calendarBlockSchema.safeParse(b).success);
  if (!valid || blocks.length === 0 || blocks.length > 20) return fail('invalid_request', 'Blocos inválidos para a prévia.');
  const mcp = await claudeCapability('mcp');
  if (!mcp) return fail('calendar_disabled', NOT_IN_CLAUDE);
  const starts = blocks.map((b) => Date.parse(b.start));
  const ends = blocks.map((b) => Date.parse(b.end));
  const range = { timeMin: new Date(Math.min(...starts)).toISOString(), timeMax: new Date(Math.max(...ends)).toISOString(), timeZone: blocks[0].timeZone };
  const busy = await claudeCalendarFreeBusy(range);
  if (!busy.ok) return busy;
  const target = await resolveTargetCalendar(mcp);
  for (const [key, p] of previews) if (p.expiresAt < Date.now()) previews.delete(key);
  const token = newRandomId();
  const expiresAt = Date.now() + PREVIEW_TTL_MS;
  previews.set(token, { token, expiresAt, blocksKey: blocksKey(blocks), target });
  return ok({
    previewToken: token,
    expiresAt: new Date(expiresAt).toISOString(),
    target: target.label,
    blocks: blocks.map((b) => ({
      ...b,
      conflicts: busy.data.busy.filter((x) => Date.parse(x.start) < Date.parse(b.end) && Date.parse(b.start) < Date.parse(x.end)),
    })),
  });
}

/**
 * Cria os eventos no Google, um por vez, só com uma prévia recente dos mesmos blocos.
 * Uma falha no meio informa o que já foi criado (para não duplicar numa nova tentativa).
 * Sem `signal`: cancelar uma escrita deixaria o resultado incerto.
 */
export async function claudeCalendarCommit(previewToken: string, blocks: CalendarBlock[]): Promise<CalendarApiResponse<CalendarCommitResult>> {
  const preview = previews.get(previewToken);
  if (!preview || preview.expiresAt < Date.now() || preview.blocksKey !== blocksKey(blocks)) {
    return fail('preview_expired', 'A prévia expirou ou mudou. Revise os blocos de novo antes de criar.');
  }
  previews.delete(previewToken);
  const mcp = await claudeCapability('mcp');
  if (!mcp) return fail('calendar_disabled', NOT_IN_CLAUDE);
  const calendarId = preview.target.calendarId ?? 'primary';
  const created: Array<{ index: number; eventId: string }> = [];
  for (const [index, block] of blocks.entries()) {
    try {
      const result = await mcp.callTool(GOOGLE_CALENDAR_CONNECTOR, CREATE_TOOL, {
        summary: block.title,
        startTime: toConnectorTime(block.start, block.timeZone),
        endTime: toConnectorTime(block.end, block.timeZone),
        timeZone: block.timeZone,
        description: withMark(block.description),
        colorId: BLOCK_COLOR_ID,
        ...(preview.target.calendarId ? { calendarId: preview.target.calendarId } : {}),
      });
      created.push({ index, eventId: createdEventId(result.payload) ?? `rotinas-${previewToken.slice(0, 8)}-${index}` });
    } catch (error) {
      const d = describeConnectorFailure(error, true);
      const partial = created.length > 0 ? { calendarId, created } : undefined;
      const message = created.length > 0 ? `O Google criou ${created.length} de ${blocks.length} blocos e parou: ${d.message}` : d.message;
      return fail(d.code, message, partial);
    }
  }
  return ok({ calendarId, created });
}

/**
 * Lembrete diário no Google Agenda (dentro do Claude o app não pode mostrar notificações): um
 * evento que se repete todo dia, marcado como "livre", com notificação do próprio Google na hora.
 * Fica sempre na agenda principal, onde as notificações do Google costumam estar ligadas.
 */
export async function claudeCalendarCreateDailyReminder(request: DailyReminderRequest): Promise<CalendarApiResponse<{ eventId?: string }>> {
  const parsed = dailyReminderRequestSchema.safeParse(request);
  if (!parsed.success) return fail('invalid_request', 'Lembrete inválido.');
  const r = parsed.data;
  const mcp = await claudeCapability('mcp');
  if (!mcp) return fail('calendar_disabled', NOT_IN_CLAUDE);
  const startMin = timeToMinutes(r.time);
  const endMin = startMin + r.durationMinutes;
  const endDate = endMin >= 24 * 60 ? addDays(r.date, 1) : r.date;
  try {
    const result = await mcp.callTool(GOOGLE_CALENDAR_CONNECTOR, CREATE_TOOL, {
      summary: r.title,
      startTime: `${r.date}T${r.time}:00`,
      endTime: `${endDate}T${minutesToTime(endMin % (24 * 60))}:00`,
      timeZone: r.timeZone,
      description: withMark(r.description),
      colorId: BLOCK_COLOR_ID,
      recurrenceData: ['RRULE:FREQ=DAILY'],
      availability: 'AVAILABILITY_FREE',
      useDefaultReminders: false,
      overrideReminders: [{ method: 'popup', minutes: 0 }],
    });
    return ok({ eventId: createdEventId(result.payload) });
  } catch (error) {
    const d = describeConnectorFailure(error, true);
    return fail(d.code, d.message);
  }
}
