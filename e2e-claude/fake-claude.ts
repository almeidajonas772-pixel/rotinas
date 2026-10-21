import { readFileSync } from 'node:fs';
import type { Browser, BrowserContext, Page } from '@playwright/test';

/**
 * Um "Claude" simulado para testar o artifact publicado: a página real (release/rotinas-claude)
 * dentro do mesmo esqueleto que o claude.ai acrescenta, com `window.claude` implementando as
 * capacidades usadas pelo app. O armazenamento (`db`) fica no Node e é compartilhado entre
 * contextos do navegador — cada contexto é um "aparelho" (iPad, computador) com o próprio IndexedDB.
 * Nada aqui fala com o Claude, o Google ou a internet.
 */

export const ARTIFACT_URL = 'https://rotinas.test/';
export const USER_ID = 'usuario-teste';

const SKELETON_HEAD =
  '<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"><style>*,*::before,*::after{box-sizing:border-box}body{margin:0}</style></head><body>';

export interface SampleCall {
  input: string;
  tier?: string;
}

export interface McpCall {
  tool: string;
  input: Record<string, unknown>;
  cache?: unknown;
}

/** Estado compartilhado entre os "aparelhos": o armazenamento da conta e o que foi pedido ao Claude/Google. */
export class World {
  readonly docs = new Map<string, Map<string, unknown>>();
  readonly samples: SampleCall[] = [];
  readonly mcpCalls: McpCall[] = [];
  readonly saved: Array<{ filename: string; data: string }> = [];
  private readonly page: string;

  constructor(pagePath = 'release/rotinas-claude/index.html') {
    this.page = readFileSync(pagePath, 'utf8');
  }

  html(): string {
    return `${SKELETON_HEAD}${this.page}</body></html>`;
  }

  collection(path: string): Map<string, unknown> {
    let c = this.docs.get(path);
    if (!c) {
      c = new Map();
      this.docs.set(path, c);
    }
    return c;
  }

  db(op: { op: 'list' | 'set' | 'delete'; path: string; id?: string; data?: unknown }): unknown {
    const c = this.collection(op.path);
    if (op.op === 'list') return [...c.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, data]) => ({ id, data }));
    if (!op.id) throw new Error('id ausente');
    if (op.op === 'set') c.set(op.id, JSON.parse(JSON.stringify(op.data)));
    else c.delete(op.id);
    return null;
  }

  sample(call: SampleCall): unknown {
    this.samples.push(call);
    const reply = /Teste de conexão do Rotinas/.test(call.input) ? 'Funcionando! O Kai está pronto.' : 'Resposta simulada do Kai.';
    return { text: JSON.stringify({ reply, suggestions: [], supportNotice: false }), truncated: false, modelTierApplied: call.tier ?? 'quick' };
  }

  mcp(call: { op: 'list' } | ({ op: 'call' } & McpCall)): unknown {
    if (call.op === 'list') {
      return { servers: [{ server: 'Google Calendar', authStatus: 'connected', tools: ['list_events', 'create_event', 'list_calendars'].map((name) => ({ name, description: '' })) }] };
    }
    this.mcpCalls.push({ tool: call.tool, input: call.input, cache: call.cache });
    if (call.tool === 'list_events') {
      const start = String(call.input.startTime).slice(0, 10);
      return {
        payload: {
          events: [
            { id: 'g1', summary: 'Aula de inglês', description: 'sala 12', start: { dateTime: `${start}T19:00:00-03:00` }, end: { dateTime: `${start}T20:00:00-03:00` }, colorId: '7' },
            { id: 'g2', summary: 'Bloco criado pelo app', description: 'Bloco.\n\nCriado pelo app Rotinas.', start: { dateTime: `${start}T07:00:00-03:00` }, end: { dateTime: `${start}T07:30:00-03:00` } },
          ],
        },
      };
    }
    if (call.tool === 'list_calendars') return { payload: { calendars: [{ id: 'principal@example.com', summary: 'principal@example.com' }] } };
    if (call.tool === 'create_event') return { payload: { id: `criado-${this.mcpCalls.length}` } };
    return { error: { code: 'not_in_manifest', message: 'fora do manifesto' } };
  }
}

/** Abre um "aparelho": um contexto novo (IndexedDB vazio) com o Claude simulado. */
export async function openDevice(browser: Browser, world: World, options: { viewport?: { width: number; height: number } } = {}): Promise<{ context: BrowserContext; page: Page; external: string[]; errors: string[] }> {
  const context = await browser.newContext({ locale: 'pt-BR', timezoneId: 'America/Sao_Paulo', viewport: options.viewport ?? { width: 1280, height: 860 } });
  await context.exposeBinding('__fakeDb', (_source, op) => world.db(op));
  await context.exposeBinding('__fakeSample', (_source, call) => world.sample(call));
  await context.exposeBinding('__fakeMcp', (_source, call) => world.mcp(call));
  await context.exposeBinding('__fakeSave', (_source, file: { filename: string; data: string }) => {
    world.saved.push(file);
    return null;
  });
  await context.addInitScript(installFakeClaude, USER_ID);
  await context.route('https://rotinas.test/**', (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: world.html() }));
  const page = await context.newPage();
  const external: string[] = [];
  const errors: string[] = [];
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (url.protocol === 'data:' || url.protocol === 'blob:') return;
    if (url.origin !== new URL(ARTIFACT_URL).origin) external.push(req.url());
  });
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  return { context, page, external, errors };
}

/** Roda na página antes de qualquer script: o `window.claude` que o claude.ai forneceria. */
function installFakeClaude(userId: string) {
  type Binding = (payload: unknown) => Promise<unknown>;
  const w = window as unknown as Record<string, Binding> & { claude?: unknown };
  const call = (name: string, payload: unknown) => w[name](payload);
  const snapshot = (docs: Array<{ id: string; data: Record<string, unknown> }>) => {
    const list = docs.map(({ id, data }) => ({ id, exists: true, data: () => JSON.parse(JSON.stringify(data)), metadata: { fromCache: false, hasPendingWrites: false } }));
    return { docs: list, size: list.length, empty: list.length === 0, metadata: { fromCache: false, hasPendingWrites: false } };
  };
  const docRef = (path: string, id: string) => ({
    id,
    path: `${path}/${id}`,
    async get() {
      const docs = (await call('__fakeDb', { op: 'list', path })) as Array<{ id: string; data: Record<string, unknown> }>;
      const found = docs.find((d) => d.id === id);
      return { id, exists: Boolean(found), data: () => (found ? JSON.parse(JSON.stringify(found.data)) : undefined), metadata: { fromCache: false, hasPendingWrites: false } };
    },
    async set(data: unknown) {
      await call('__fakeDb', { op: 'set', path, id, data });
    },
    async delete() {
      await call('__fakeDb', { op: 'delete', path, id });
    },
  });
  const db = {
    collection(path: string) {
      return {
        path,
        doc: (id: string) => docRef(path, id),
        async get() {
          return snapshot((await call('__fakeDb', { op: 'list', path })) as Array<{ id: string; data: Record<string, unknown> }>);
        },
        onSnapshot(next: (s: unknown) => void, error?: (e: unknown) => void) {
          let stopped = false;
          let last = '';
          const tick = async () => {
            if (stopped) return;
            try {
              const docs = (await call('__fakeDb', { op: 'list', path })) as Array<{ id: string; data: Record<string, unknown> }>;
              const key = JSON.stringify(docs);
              if (key !== last) {
                last = key;
                next(snapshot(docs));
              }
            } catch (e) {
              error?.({ code: 'unavailable', message: String(e) });
            }
            if (!stopped) setTimeout(tick, 200);
          };
          setTimeout(tick, 0);
          return () => {
            stopped = true;
          };
        },
      };
    },
    doc(full: string) {
      const i = full.lastIndexOf('/');
      return docRef(full.slice(0, i), full.slice(i + 1));
    },
  };
  const sample = Object.assign(
    async (input: unknown, options: { modelTier?: string } = {}) => {
      const r = (await call('__fakeSample', { input, tier: options.modelTier })) as { error?: unknown };
      if (r.error) throw r.error;
      return r;
    },
    { json: async () => Promise.reject({ code: 'invalid_json', message: 'não usado' }) },
  );
  const mcp = {
    listTools: async () => call('__fakeMcp', { op: 'list' }),
    callTool: async (_server: string, tool: string, input: unknown, options?: { cache?: unknown }) => {
      const r = (await call('__fakeMcp', { op: 'call', tool, input, cache: options?.cache })) as { error?: unknown; payload?: unknown };
      if (r.error) throw r.error;
      return { content: [], payload: r.payload };
    },
  };
  const caps: Record<string, unknown> = {
    db,
    user: { id: async () => userId, isOwner: async () => true },
    sample,
    mcp,
    downloads: {
      save: async (req: { filename: string; data: unknown }) => {
        await call('__fakeSave', { filename: req.filename, data: typeof req.data === 'string' ? req.data : '' });
        return { status: 'saved' };
      },
    },
    permissions: {
      state: async (name?: string) => (name ? 'prompt' : {}),
      request: async (names?: string[]) => Object.fromEntries((names ?? []).map((n) => [n, 'granted'])),
      manage: async () => undefined,
    },
  };
  w.claude = { use: async (name: string) => caps[name] ?? null };
}
