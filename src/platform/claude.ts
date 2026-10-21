import { isClaudeRuntime } from './runtime';

/**
 * Acesso às capacidades do Claude (runtime dos artifacts, contrato 0.2.87). Só as partes que o
 * Rotinas usa estão tipadas aqui; o contrato completo é servido pela plataforma.
 *
 * Regras do contrato seguidas aqui:
 * - `window.claude` só tem `use`: cada capacidade chega por `await claude.use(nome)`, ou `null`
 *   quando esta visualização não pode usá-la (o app então esconde ou desliga o recurso);
 * - `use()` nunca pede permissão: o pedido aparece na primeira chamada de cada capacidade;
 * - o objeto devolvido é da plataforma e congelado: só chamamos as funções dele.
 */

// ── sample (perguntar ao Claude, na conta da própria pessoa) ────────────────

export type SampleModelTier = 'quick' | 'default' | 'complex';

export interface SampleMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface SampleOptions {
  onText?: (update: { text: string; delta: string }) => void;
  signal?: AbortSignal;
  modelTier?: SampleModelTier;
  cache?: boolean | { gcTime?: number; refresh?: boolean };
}

export interface SampleResult {
  text: string;
  truncated: boolean;
  modelTierApplied: SampleModelTier;
  modelApplied?: string;
}

export interface SampleError {
  code: string;
  message: string;
  text?: string;
}

export interface ClaudeSample {
  (input: string | SampleMessage[], options?: SampleOptions): Promise<SampleResult>;
  json<T = unknown>(input: string | SampleMessage[], options?: SampleOptions): Promise<T>;
}

// ── mcp (conectores do Claude da pessoa) ────────────────────────────────────

export interface McpToolInfo {
  name: string;
  description: string;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

export interface McpServerInfo {
  server: string;
  kind?: 'connector' | 'artifact';
  authStatus: 'connected' | 'needs_reauth' | 'unknown' | string;
  tools: McpToolInfo[];
}

export interface McpCallResult {
  content: Array<{ type: string; text?: string; [k: string]: unknown }>;
  structuredContent?: unknown;
  payload?: unknown;
  cache?: { storedAt: number; revalidating: boolean };
}

export interface McpError {
  code: string;
  server?: string;
  message: string;
  retryable?: boolean;
  retryAfterMs?: number;
  result?: unknown;
}

export interface ClaudeMcp {
  callTool(server: string, tool: string, input?: unknown, options?: { cache?: false | { staleTime?: number; gcTime?: number; refresh?: boolean }; signal?: AbortSignal }): Promise<McpCallResult>;
  listTools(server?: string): Promise<{ servers: McpServerInfo[] }>;
  invalidate?(server?: string, tool?: string, input?: unknown): Promise<void>;
}

// ── db (armazenamento do artifact; data/users/<id>/ é privado de cada pessoa) ─

export interface DbSnapshotMetadata {
  fromCache: boolean;
  hasPendingWrites: boolean;
}

export interface DbDocumentSnapshot {
  id: string;
  exists: boolean;
  data(): Record<string, unknown> | undefined;
  metadata: DbSnapshotMetadata;
}

export interface DbQuerySnapshot {
  docs: DbDocumentSnapshot[];
  size: number;
  empty: boolean;
  metadata: DbSnapshotMetadata;
}

export interface DbError {
  code: string;
  message: string;
}

export interface DbDocumentReference {
  id: string;
  path: string;
  get(): Promise<DbDocumentSnapshot>;
  set(data: Record<string, unknown>): Promise<void>;
  delete(): Promise<void>;
}

export interface DbCollectionReference {
  path: string;
  doc(id?: string): DbDocumentReference;
  get(): Promise<DbQuerySnapshot>;
  onSnapshot(next: (snap: DbQuerySnapshot) => void, error?: (e: DbError) => void): () => void;
}

export interface ClaudeDb {
  doc(path: string): DbDocumentReference;
  collection(path: string): DbCollectionReference;
}

// ── user, downloads, permissions ─────────────────────────────────────────────

export interface ClaudeUser {
  id(): Promise<string | null>;
  isOwner(): Promise<boolean>;
}

export interface ClaudeDownloads {
  save(request: { filename: string; data: string | Blob }): Promise<{ status: 'saved' | 'delivered' }>;
}

export type PermissionState = 'granted' | 'prompt' | 'denied' | 'unavailable';

export interface ClaudePermissions {
  state(): Promise<Record<string, PermissionState>>;
  state(name: string): Promise<PermissionState>;
  request(names?: readonly string[]): Promise<Record<string, PermissionState>>;
  manage(): Promise<void>;
}

export interface ClaudeCapabilities {
  sample: ClaudeSample;
  mcp: ClaudeMcp;
  db: ClaudeDb;
  user: ClaudeUser;
  downloads: ClaudeDownloads;
  permissions: ClaudePermissions;
}

export type CapabilityName = keyof ClaudeCapabilities;

interface ClaudeGlobal {
  use(name: string): Promise<unknown>;
}

function claudeGlobal(): ClaudeGlobal | undefined {
  const g = (globalThis as { claude?: ClaudeGlobal }).claude;
  return g && typeof g.use === 'function' ? g : undefined;
}

const cache = new Map<CapabilityName, Promise<unknown>>();

/**
 * A capacidade pedida, ou `null` quando esta visualização não pode usá-la (fora do Claude,
 * não concedida ou não carregada). Nunca rejeita. O resultado é memorizado.
 */
export function claudeCapability<K extends CapabilityName>(name: K): Promise<ClaudeCapabilities[K] | null> {
  if (!isClaudeRuntime()) return Promise.resolve(null);
  const g = claudeGlobal();
  if (!g) return Promise.resolve(null);
  let pending = cache.get(name);
  if (!pending) {
    pending = Promise.resolve()
      .then(() => g.use(name))
      .then((ns) => ns ?? null)
      .catch(() => null);
    cache.set(name, pending);
  }
  return pending as Promise<ClaudeCapabilities[K] | null>;
}

/** Só para testes: esquece as capacidades já resolvidas (para trocar o `window.claude` simulado). */
export function resetClaudeCapabilitiesForTests(): void {
  cache.clear();
}

/** Lê o estado de uma permissão sem perguntar nada (`unavailable` quando não há como saber). */
export async function permissionState(name: string): Promise<PermissionState> {
  const permissions = await claudeCapability('permissions');
  if (!permissions) return 'unavailable';
  try {
    return await permissions.state(name);
  } catch {
    return 'unavailable';
  }
}

/** Pede uma ou mais permissões com no máximo um diálogo da plataforma. Nunca rejeita. */
export async function requestPermissions(names: readonly string[]): Promise<Record<string, PermissionState>> {
  const permissions = await claudeCapability('permissions');
  if (!permissions) return Object.fromEntries(names.map((n) => [n, 'unavailable' as const]));
  try {
    return await permissions.request(names);
  } catch {
    return Object.fromEntries(names.map((n) => [n, 'unavailable' as const]));
  }
}

/** Abre o painel de permissões do artifact (só por ação da pessoa). */
export async function openPermissionsPanel(): Promise<boolean> {
  const permissions = await claudeCapability('permissions');
  if (!permissions) return false;
  try {
    await permissions.manage();
    return true;
  } catch {
    return false;
  }
}

/** O código de erro de uma rejeição das capacidades (são objetos `{code, message}`, não `Error`). */
export function capabilityErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string') return (error as { code: string }).code;
  if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled';
  return 'upstream_error';
}

/** Nome do conector do Google Agenda no Claude (nome de exibição, como aparece em Conectores). */
export const GOOGLE_CALENDAR_CONNECTOR = 'Google Calendar';

/** Identificador aleatório (para prévias e marcações locais). */
export function newRandomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
