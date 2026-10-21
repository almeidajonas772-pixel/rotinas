import Dexie, { type Table } from 'dexie';
import { useSyncExternalStore } from 'react';
import { clearAllData } from '../db/backup';
import { db as appDb, type RotinasDB } from '../db/db';
import { DB_SCHEMA_VERSION } from '../db/migrations';
import { rebuildProgressEvents } from '../db/repo-misc';
import { META_DOC_ID, SyncEngine, type LocalChange, type LocalStore, type RemoteSnapshot, type RemoteStore, type ShadowEntry, type ShadowStore, type SyncDoc, type SyncMeta, type SyncStatus } from '../sync/engine';
import { isSyncedTable, type SyncedTable } from '../sync/layout';
import { claudeCapability, type ClaudeDb } from './claude';
import { isClaudeRuntime } from './runtime';

/**
 * Liga a cópia local (IndexedDB) ao armazenamento da pessoa no Claude (capacidade `db`, caminho
 * privado `data/users/<id>/`, que nem o dono do artifact enxerga de outra conta). Só existe no
 * ambiente do Claude; no site (`web`) os dados ficam só no navegador, como antes.
 */

export type CloudPhase = 'off' | 'unavailable' | 'connecting' | 'syncing' | 'synced' | 'error' | 'blocked';

export interface CloudSyncState {
  phase: CloudPhase;
  message?: string;
  lastSyncedAt?: number;
  pending: number;
  unsyncable: number;
  invalid: number;
  documents: number;
  /** A cópia local está só na memória (o navegador não deixou usar o IndexedDB). */
  memoryOnly: boolean;
}

const OFF: CloudSyncState = { phase: 'off', pending: 0, unsyncable: 0, invalid: 0, documents: 0, memoryOnly: false };

let state: CloudSyncState = OFF;
const listeners = new Set<() => void>();
let engine: SyncEngine | null = null;
let starting: Promise<CloudSyncState> | null = null;

function setState(next: CloudSyncState): void {
  state = next;
  listeners.forEach((l) => l());
}

function fromStatus(status: SyncStatus, memoryOnly: boolean): CloudSyncState {
  const phase: CloudPhase = status.state === 'stopped' ? 'unavailable' : status.state;
  return { phase, message: status.message, lastSyncedAt: status.lastSyncedAt, pending: status.pending, unsyncable: status.unsyncable, invalid: status.invalid, documents: status.documents, memoryOnly };
}

export function getCloudSyncState(): CloudSyncState {
  return state;
}

export function useCloudSync(): CloudSyncState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => state,
  );
}

// ── Armazenamento local (Dexie) ─────────────────────────────────────────────

export class DexieLocalStore implements LocalStore {
  constructor(private readonly database: RotinasDB) {}

  readTable(table: SyncedTable): Promise<Record<string, unknown>[]> {
    return this.database.table(table).toArray() as Promise<Record<string, unknown>[]>;
  }

  async apply(changes: LocalChange[]): Promise<void> {
    const byTable = new Map<SyncedTable, LocalChange[]>();
    for (const c of changes) byTable.set(c.table, [...(byTable.get(c.table) ?? []), c]);
    const tables = [...byTable.keys()].map((t) => this.database.table(t));
    await this.database.transaction('rw', tables, async () => {
      for (const [table, list] of byTable) {
        const puts = list.filter((c) => c.record).map((c) => c.record!);
        const dels = list.filter((c) => !c.record).map((c) => c.key);
        if (puts.length > 0) await this.database.table(table).bulkPut(puts);
        if (dels.length > 0) await this.database.table(table).bulkDelete(dels);
      }
    });
  }

  onChange(listener: (tables: Set<string>) => void): () => void {
    const prefix = `idb://${this.database.name}/`;
    const handler = (parts: Record<string, unknown>) => {
      const tables = new Set<string>();
      for (const key of Object.keys(parts)) {
        if (!key.startsWith(prefix)) continue;
        const table = key.slice(prefix.length).split('/')[0];
        if (table) tables.add(table);
      }
      if (tables.size > 0) listener(tables);
    };
    Dexie.on('storagemutated', handler);
    return () => Dexie.on('storagemutated').unsubscribe(handler);
  }

  async afterRemoteApply(tables: Set<SyncedTable>): Promise<void> {
    // O XP é derivado do histórico: recalcula quando chegam conclusões ou metas de outro aparelho.
    if (tables.has('completions') || tables.has('agendaCompletions') || tables.has('goals')) await rebuildProgressEvents(this.database);
  }

  clearAll(): Promise<void> {
    return clearAllData(this.database);
  }
}

// ── Sombra (estado da última sincronização, por aparelho) ───────────────────

class SyncMetaDB extends Dexie {
  shadow!: Table<ShadowEntry, string>;
  kv!: Table<{ k: string; v: unknown }, string>;
  constructor() {
    super('rotinas-sync');
    this.version(1).stores({ shadow: 'rk', kv: 'k' });
  }
}

class DexieShadowStore implements ShadowStore {
  constructor(private readonly meta: SyncMetaDB) {}
  load(): Promise<ShadowEntry[]> {
    return this.meta.shadow.toArray();
  }
  async save(put: ShadowEntry[], remove: string[]): Promise<void> {
    await this.meta.transaction('rw', this.meta.shadow, async () => {
      if (put.length > 0) await this.meta.shadow.bulkPut(put);
      if (remove.length > 0) await this.meta.shadow.bulkDelete(remove);
    });
  }
  async clear(): Promise<void> {
    await this.meta.shadow.clear();
  }
  async loadMarker(name: string): Promise<number | undefined> {
    const v = (await this.meta.kv.get(`marker:${name}`))?.v;
    return typeof v === 'number' ? v : undefined;
  }
  async saveMarker(name: string, value: number): Promise<void> {
    await this.meta.kv.put({ k: `marker:${name}`, v: value });
  }
}

// ── Armazenamento remoto (capacidade `db` do Claude) ────────────────────────

function isSyncDoc(value: unknown): value is SyncDoc {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return v.v === 1 && typeof v.t === 'string' && isSyncedTable(v.t) && Boolean(v.r) && typeof v.r === 'object' && !Array.isArray(v.r);
}

function cleanDoc(doc: SyncDoc): SyncDoc {
  const r: SyncDoc['r'] = {};
  for (const [key, rec] of Object.entries(doc.r)) {
    if (!rec || typeof rec !== 'object') continue;
    const m = (rec as { m?: unknown }).m;
    const d = (rec as { d?: unknown }).d;
    if (typeof m !== 'number' || !Number.isFinite(m)) continue;
    if (d !== null && (typeof d !== 'object' || Array.isArray(d))) continue;
    r[key] = { m, d: d as Record<string, unknown> | null };
  }
  return { v: 1, t: doc.t, r };
}

export class ClaudeDbRemoteStore implements RemoteStore {
  private readonly path: string;
  constructor(
    private readonly store: ClaudeDb,
    uid: string,
  ) {
    this.path = `data/users/${uid}`;
  }

  subscribe(next: (snapshot: RemoteSnapshot) => void, error: (code: string, message: string) => void): () => void {
    return this.store.collection(this.path).onSnapshot(
      (snap) => {
        const docs = new Map<string, SyncDoc>();
        let meta: SyncMeta | undefined;
        for (const d of snap.docs) {
          if (!d.exists) continue;
          const data = d.data();
          if (d.id === META_DOC_ID) {
            if (data && data.v === 1 && typeof data.schema === 'number') meta = data as unknown as SyncMeta;
            continue;
          }
          if (isSyncDoc(data)) docs.set(d.id, cleanDoc(data));
        }
        next({ docs, meta, definitive: !snap.metadata.fromCache });
      },
      (e) => error(e.code, e.message),
    );
  }

  write(docId: string, doc: SyncDoc | SyncMeta): Promise<void> {
    return this.store.collection(this.path).doc(docId).set(JSON.parse(JSON.stringify(doc)) as Record<string, unknown>);
  }

  remove(docId: string): Promise<void> {
    return this.store.collection(this.path).doc(docId).delete();
  }
}

// ── Início ──────────────────────────────────────────────────────────────────

const READY_TIMEOUT_MS = 12_000;

/**
 * Começa a sincronização (uma vez). Espera a primeira sincronização completa por até 12 s, para
 * que um aparelho novo mostre os dados da pessoa em vez da configuração inicial.
 */
export function startCloudSync(options: { database?: RotinasDB; memoryOnly?: boolean } = {}): Promise<CloudSyncState> {
  if (!isClaudeRuntime()) return Promise.resolve(OFF);
  if (starting) return starting;
  const database = options.database ?? appDb;
  const memoryOnly = Boolean(options.memoryOnly);
  starting = (async () => {
    setState({ ...OFF, phase: 'connecting', memoryOnly });
    const [store, user] = await Promise.all([claudeCapability('db'), claudeCapability('user')]);
    const uid = user ? await user.id().catch(() => null) : null;
    if (!store || !uid) {
      setState({
        ...OFF,
        phase: 'unavailable',
        memoryOnly,
        message: !store
          ? 'O armazenamento do Claude não está disponível nesta visualização. Seus dados ficam só neste navegador até você abrir o Rotinas pelo link no claude.ai.'
          : 'Não foi possível identificar sua conta do Claude (entre no claude.ai). Seus dados ficam só neste navegador por enquanto.',
      });
      return state;
    }
    const meta = new SyncMetaDB();
    // Outra conta usou este navegador antes: a cópia local era dela (e está guardada na conta dela).
    const previous = (await meta.kv.get('uid'))?.v;
    if (previous && previous !== uid) {
      await clearAllData(database);
      await meta.shadow.clear();
    }
    await meta.kv.put({ k: 'uid', v: uid });
    engine = new SyncEngine({
      local: new DexieLocalStore(database),
      remote: new ClaudeDbRemoteStore(store, uid),
      shadow: new DexieShadowStore(meta),
      schemaVersion: DB_SCHEMA_VERSION,
      onStatus: (status) => setState(fromStatus(status, memoryOnly)),
    });
    await engine.start();
    // Ao sair do app (trocar de aba, fechar, bloquear o iPad), envia na hora o que estiver esperando.
    const flushOnLeave = () => {
      if (document.visibilityState === 'hidden') void engine?.flush();
    };
    document.addEventListener('visibilitychange', flushOnLeave);
    window.addEventListener('pagehide', () => void engine?.flush());
    await engine.whenReady(READY_TIMEOUT_MS);
    return state;
  })().catch((error: unknown) => {
    setState({ ...OFF, phase: 'error', memoryOnly, message: `A sincronização não começou: ${error instanceof Error ? error.message : 'falha inesperada'}. Seus dados ficam neste navegador.` });
    return state;
  });
  return starting;
}

export function cloudSyncActive(): boolean {
  return engine !== null;
}

/** Tenta enviar agora o que estiver pendente. */
export async function syncNow(): Promise<void> {
  await engine?.syncNow();
}

/** Espera a fila de sincronização terminar (antes de sair de uma tela importante, por exemplo). */
export async function flushCloudSync(): Promise<void> {
  await engine?.flush();
}

/**
 * Apaga os dados da pessoa no Claude e neste aparelho. Sem sincronização ativa, apaga só o local.
 * Os outros aparelhos apagam a cópia deles na próxima vez que abrirem o app (marca no armazenamento).
 */
export async function wipeCloudAndLocal(database: RotinasDB = appDb): Promise<'cloud' | 'local'> {
  if (engine) {
    await engine.wipeEverything();
    return 'cloud';
  }
  await clearAllData(database);
  return 'local';
}

