// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CalendarBlock } from '../../shared/calendar';
import {
  claudeCalendarCommit,
  claudeCalendarCreateDailyReminder,
  claudeCalendarEvents,
  claudeCalendarPreview,
  claudeCalendarStatus,
  describeConnectorFailure,
  minimalEvent,
  ROTINAS_EVENT_MARK,
} from '../../src/platform/calendar-claude';
import { resetClaudeCapabilitiesForTests, type McpServerInfo } from '../../src/platform/claude';
import { setRuntimeForTests } from '../../src/platform/runtime';

/**
 * Google Agenda pelo conector do Claude (capacidade `mcp`), com o conector simulado. Os dados
 * abaixo são fictícios: nenhum teste fala com o Google.
 */

interface Call {
  server: string;
  tool: string;
  input: Record<string, unknown>;
  options?: { cache?: unknown; signal?: AbortSignal };
}

type Handler = (call: Call) => unknown;

function installMcp(handlers: Record<string, Handler>, options: { servers?: McpServerInfo[]; permission?: string; noMcp?: boolean } = {}) {
  const calls: Call[] = [];
  const mcp = {
    async callTool(server: string, tool: string, input: Record<string, unknown> = {}, opts?: Call['options']) {
      const call = { server, tool, input, options: opts };
      calls.push(call);
      const handler = handlers[tool];
      if (!handler) throw { code: 'not_in_manifest', message: 'fora do manifesto' };
      return { content: [], payload: await handler(call) };
    },
    async listTools() {
      return {
        servers: options.servers ?? [
          { server: 'Google Calendar', authStatus: 'connected', tools: ['list_events', 'create_event', 'list_calendars'].map((name) => ({ name, description: '' })) },
        ],
      };
    },
  };
  const permissions = { state: async () => options.permission ?? 'granted', request: async () => ({}), manage: async () => undefined };
  const caps: Record<string, unknown> = { permissions, ...(options.noMcp ? {} : { mcp }) };
  (globalThis as { claude?: unknown }).claude = { use: async (name: string) => caps[name] ?? null };
  resetClaudeCapabilitiesForTests();
  return calls;
}

const range = { timeMin: '2026-10-21T03:00:00.000Z', timeMax: '2026-10-22T03:00:00.000Z', timeZone: 'America/Sao_Paulo' };

function block(start: string, end: string, title = 'Ler 20 minutos'): CalendarBlock {
  return { title, start, end, timeZone: 'America/Sao_Paulo', description: 'Bloco de tempo criado pelo Rotinas após sua confirmação.' };
}

beforeEach(() => setRuntimeForTests('claude'));

afterEach(() => {
  delete (globalThis as { claude?: unknown }).claude;
  resetClaudeCapabilitiesForTests();
  setRuntimeForTests('web');
});

describe('estado do conector', () => {
  it('fora do Claude: não configurado, com o motivo', async () => {
    installMcp({}, { noMcp: true });
    const res = await claudeCalendarStatus();
    expect(res).toMatchObject({ ok: true, data: { configured: false, connected: false, via: 'claude' } });
  });

  it('conector conectado: lista o que dá para fazer e a permissão, sem chamar ferramentas', async () => {
    const calls = installMcp({}, { permission: 'prompt' });
    const res = await claudeCalendarStatus();
    expect(res).toMatchObject({ ok: true, data: { connected: true, canReadEvents: true, canWrite: true, permission: 'prompt', connector: 'ready' } });
    expect(calls).toHaveLength(0);
  });

  it('conector ainda não consultado nesta página, ausente ou expirado', async () => {
    installMcp({}, { servers: [{ server: 'Google Calendar', authStatus: 'unknown', tools: [{ name: 'list_events', description: '' }] }] });
    expect(await claudeCalendarStatus()).toMatchObject({ ok: true, data: { connected: true, connector: 'unasked', canWrite: false } });

    installMcp({}, { servers: [] });
    expect(await claudeCalendarStatus()).toMatchObject({ ok: true, data: { connected: false } });

    installMcp({}, { servers: [{ server: 'Google Calendar', authStatus: 'needs_reauth', tools: [{ name: 'list_events', description: '' }] }] });
    const expired = await claudeCalendarStatus();
    expect(expired).toMatchObject({ ok: true, data: { connected: false } });
    if (expired.ok) expect(expired.data.reason).toMatch(/expirou/);
  });
});

describe('leitura de eventos', () => {
  it('guarda só o mínimo, sem cache, com paginação; ignora cancelados e os criados pelo Rotinas', async () => {
    const calls = installMcp({
      list_events: ({ input }) =>
        input.pageToken
          ? { events: [{ id: 'e3', summary: 'Prova de cálculo', start: { date: '2026-10-21' }, end: { date: '2026-10-22' } }] }
          : {
              nextPageToken: 'p2',
              events: [
                {
                  id: 'e1',
                  summary: 'Aula de inglês',
                  description: 'sala 12, levar livro',
                  location: 'Escola',
                  attendees: [{ email: 'alguem@example.com' }],
                  start: { dateTime: '2026-10-21T08:00:00-03:00' },
                  end: { dateTime: '2026-10-21T09:00:00-03:00' },
                  colorId: '7',
                },
                { id: 'e2', status: 'cancelled', summary: 'Cancelado', start: { dateTime: '2026-10-21T10:00:00-03:00' }, end: { dateTime: '2026-10-21T11:00:00-03:00' } },
                { id: 'e4', summary: 'Ler 20 minutos', description: `Bloco.\n\n${ROTINAS_EVENT_MARK}.`, start: { dateTime: '2026-10-21T19:00:00-03:00' }, end: { dateTime: '2026-10-21T19:20:00-03:00' } },
                { id: 'e5', summary: 'Almoço livre', transparency: 'transparent', start: { dateTime: '2026-10-21T12:00:00-03:00' }, end: { dateTime: '2026-10-21T13:00:00-03:00' } },
              ],
            },
    });
    const res = await claudeCalendarEvents(range);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.events.map((e) => e.id)).toEqual(['e1', 'e5', 'e3']);
    expect(res.data.events[0]).toEqual({ id: 'e1', title: 'Aula de inglês', allDay: false, start: '2026-10-21T08:00:00-03:00', end: '2026-10-21T09:00:00-03:00', busy: true, colorId: '7', calendar: 'primary' });
    expect(res.data.events[1].busy).toBe(false);
    expect(JSON.stringify(res.data)).not.toMatch(/sala 12|Escola|alguem@/);
    expect(calls).toHaveLength(2);
    expect(calls[0].input).toMatchObject({ startTime: '2026-10-21T00:00:00', endTime: '2026-10-22T00:00:00', timeZone: 'America/Sao_Paulo', orderBy: 'startTime' });
    expect(calls[0].options?.cache).toBe(false);
    expect(calls[1].input.pageToken).toBe('p2');
  });

  it('reconhece os eventos do Rotinas pela marca e descarta o resto da descrição', () => {
    const ev = minimalEvent({ id: 'x', summary: 'Bloco', description: `abc ${ROTINAS_EVENT_MARK}`, start: { dateTime: '2026-10-21T19:00:00-03:00' }, end: { dateTime: '2026-10-21T19:30:00-03:00' } });
    expect(ev).toMatchObject({ calendar: 'rotinas' });
    expect(ev && 'description' in ev).toBe(false);
  });

  it('falhas do conector viram mensagens com o passo certo', async () => {
    installMcp({
      list_events: () => {
        throw { code: 'needs_reauth', message: 'expirado' };
      },
    });
    expect(await claudeCalendarEvents(range)).toMatchObject({ ok: false, error: { code: 'not_connected' } });
    expect(describeConnectorFailure({ code: 'server_not_connected' }).message).toMatch(/Conectores/);
    expect(describeConnectorFailure({ code: 'not_in_manifest' }).message).toMatch(/Permitir acesso/);
    expect(describeConnectorFailure({ code: 'upstream_error' }, true).message).toMatch(/pode ter sido criado/);
  });
});

describe('escrita com prévia e confirmação', () => {
  const blocks = [block('2026-10-21T22:00:00.000Z', '2026-10-21T22:30:00.000Z'), block('2026-10-22T22:00:00.000Z', '2026-10-22T22:30:00.000Z')];

  it('confere conflitos, escolhe a agenda “Rotinas” se existir e cria só com a prévia dos mesmos blocos', async () => {
    const calls = installMcp({
      list_events: () => ({ events: [{ id: 'b1', summary: 'Ocupado', start: { dateTime: '2026-10-21T19:15:00-03:00' }, end: { dateTime: '2026-10-21T20:00:00-03:00' } }] }),
      list_calendars: () => ({ calendars: [{ id: 'principal@example.com', summary: 'principal@example.com' }, { id: 'rot@group.calendar.google.com', summary: ' Rotinas ' }] }),
      create_event: ({ input }) => ({ id: `novo-${String(input.startTime)}` }),
    });
    const preview = await claudeCalendarPreview(blocks);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.data.target).toBe('agenda “Rotinas” do Google');
    expect(preview.data.blocks[0].conflicts).toHaveLength(1);
    expect(preview.data.blocks[1].conflicts).toHaveLength(0);

    // Blocos diferentes dos da prévia: nada é criado.
    expect(await claudeCalendarCommit(preview.data.previewToken, [blocks[0]])).toMatchObject({ ok: false, error: { code: 'preview_expired' } });
    expect(calls.filter((c) => c.tool === 'create_event')).toHaveLength(0);

    const preview2 = await claudeCalendarPreview(blocks);
    if (!preview2.ok) throw new Error('prévia falhou');
    const res = await claudeCalendarCommit(preview2.data.previewToken, blocks);
    expect(res).toEqual({ ok: true, data: { calendarId: 'rot@group.calendar.google.com', created: [{ index: 0, eventId: 'novo-2026-10-21T19:00:00' }, { index: 1, eventId: 'novo-2026-10-22T19:00:00' }] } });
    const creates = calls.filter((c) => c.tool === 'create_event');
    expect(creates).toHaveLength(2);
    expect(creates[0].input).toMatchObject({ summary: 'Ler 20 minutos', startTime: '2026-10-21T19:00:00', endTime: '2026-10-21T19:30:00', timeZone: 'America/Sao_Paulo', colorId: '5', calendarId: 'rot@group.calendar.google.com' });
    expect(String(creates[0].input.description)).toContain(ROTINAS_EVENT_MARK);
    // Escrita sem sinal de cancelamento (o resultado ficaria incerto).
    expect(creates[0].options).toBeUndefined();
    // O comprovante vale uma vez só.
    expect(await claudeCalendarCommit(preview2.data.previewToken, blocks)).toMatchObject({ ok: false, error: { code: 'preview_expired' } });
  });

  it('sem agenda “Rotinas”, usa a principal; falha no meio informa o que já foi criado', async () => {
    let n = 0;
    const calls = installMcp({
      list_events: () => ({ events: [] }),
      list_calendars: () => ({ calendars: [{ id: 'principal@example.com', summary: 'principal@example.com' }] }),
      create_event: () => {
        n += 1;
        if (n === 2) throw { code: 'tool_error', message: 'Quota exceeded' };
        return { event: { id: 'criado-1' } };
      },
    });
    const preview = await claudeCalendarPreview(blocks);
    if (!preview.ok) throw new Error('prévia falhou');
    expect(preview.data.target).toMatch(/agenda principal/);
    const res = await claudeCalendarCommit(preview.data.previewToken, blocks);
    expect(res).toMatchObject({ ok: false, error: { code: 'provider_error', partial: { calendarId: 'primary', created: [{ index: 0, eventId: 'criado-1' }] } } });
    if (!res.ok) expect(res.error.message).toMatch(/1 de 2/);
    expect(calls.filter((c) => c.tool === 'create_event')[0].input.calendarId).toBeUndefined();
  });

  it('cria o lembrete diário da noite como evento livre que se repete, com notificação na hora', async () => {
    const calls = installMcp({ create_event: () => ({ id: 'lembrete-1' }) });
    const res = await claudeCalendarCreateDailyReminder({ title: 'Sessão da noite (Rotinas)', time: '23:50', date: '2026-10-21', timeZone: 'America/Sao_Paulo', durationMinutes: 15 });
    expect(res).toEqual({ ok: true, data: { eventId: 'lembrete-1' } });
    expect(calls[0].input).toMatchObject({
      summary: 'Sessão da noite (Rotinas)',
      startTime: '2026-10-21T23:50:00',
      endTime: '2026-10-22T00:05:00',
      timeZone: 'America/Sao_Paulo',
      recurrenceData: ['RRULE:FREQ=DAILY'],
      availability: 'AVAILABILITY_FREE',
      useDefaultReminders: false,
      overrideReminders: [{ method: 'popup', minutes: 0 }],
    });
    expect(String(calls[0].input.description)).toContain(ROTINAS_EVENT_MARK);
    expect(await claudeCalendarCreateDailyReminder({ title: 'x', time: '25:00', date: '2026-10-21', timeZone: 'America/Sao_Paulo', durationMinutes: 15 })).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
  });
});
