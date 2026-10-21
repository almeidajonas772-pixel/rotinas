/**
 * Versões em memória do armazenamento local, remoto e da sombra, SOMENTE para testes da
 * sincronização. O remoto imita a capacidade `db` do Claude: entrega retratos de toda a coleção
 * a cada mudança (primeiro um em cache, incompleto, depois o confirmado).
 */
import type { LocalChange, LocalStore, RemoteSnapshot, RemoteStore, ShadowEntry, ShadowStore, SyncDoc, SyncMeta } from '../../src/sync/engine';
import { PRIMARY_KEY, type SyncedTable } from '../../src/sync/layout';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export class MemoryRemote implements RemoteStore {
  docs = new Map<string, SyncDoc | SyncMeta>();
  writes: string[] = [];
  removes: string[] = [];
  failNext: { code: string; message: string } | null = null;
  private listeners = new Set<(s: RemoteSnapshot) => void>();

  subscribe(next: (s: RemoteSnapshot) => void): () => void {
    this.listeners.add(next);
    // Primeiro uma entrega em cache (vazia), depois a confirmada — como no Claude.
    queueMicrotask(() => next({ docs: new Map(), definitive: false }));
    queueMicrotask(() => next(this.snapshot()));
    return () => this.listeners.delete(next);
  }

  snapshot(): RemoteSnapshot {
    const docs = new Map<string, SyncDoc>();
    let meta: SyncMeta | undefined;
    for (const [id, d] of this.docs) {
      if (id === 'meta') meta = clone(d as SyncMeta);
      else docs.set(id, clone(d as SyncDoc));
    }
    return { docs, meta, definitive: true };
  }

  async write(docId: string, doc: SyncDoc | SyncMeta): Promise<void> {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    this.docs.set(docId, clone(doc));
    this.writes.push(docId);
    this.emit();
  }

  async remove(docId: string): Promise<void> {
    this.docs.delete(docId);
    this.removes.push(docId);
    this.emit();
  }

  emit(): void {
    for (const l of this.listeners) queueMicrotask(() => l(this.snapshot()));
  }

  /** Todos os registros guardados de uma tabela (o mais recente de cada chave). */
  records(table: SyncedTable): Map<string, { m: number; d: Record<string, unknown> | null }> {
    const out = new Map<string, { m: number; d: Record<string, unknown> | null }>();
    for (const [id, doc] of this.docs) {
      if (id === 'meta') continue;
      const d = doc as SyncDoc;
      if (d.t !== table) continue;
      for (const [k, r] of Object.entries(d.r)) if (!out.has(k) || out.get(k)!.m < r.m) out.set(k, r);
    }
    return out;
  }
}

export class MemoryLocal implements LocalStore {
  tables = new Map<SyncedTable, Map<string, Record<string, unknown>>>();
  applied: LocalChange[][] = [];
  afterApply: Array<Set<SyncedTable>> = [];
  private listeners = new Set<(t: Set<string>) => void>();

  private table(name: SyncedTable): Map<string, Record<string, unknown>> {
    let t = this.tables.get(name);
    if (!t) {
      t = new Map();
      this.tables.set(name, t);
    }
    return t;
  }

  async readTable(table: SyncedTable): Promise<Record<string, unknown>[]> {
    return [...this.table(table).values()].map(clone);
  }

  async apply(changes: LocalChange[]): Promise<void> {
    this.applied.push(changes);
    const touched = new Set<string>();
    for (const c of changes) {
      if (c.record) this.table(c.table).set(c.key, clone(c.record));
      else this.table(c.table).delete(c.key);
      touched.add(c.table);
    }
    this.notify(touched);
  }

  onChange(listener: (t: Set<string>) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async afterRemoteApply(tables: Set<SyncedTable>): Promise<void> {
    this.afterApply.push(tables);
  }

  async clearAll(): Promise<void> {
    const touched = new Set<string>(this.tables.keys());
    this.tables.clear();
    this.notify(touched);
  }

  /** Simula uma gravação do app neste aparelho. */
  put(table: SyncedTable, record: Record<string, unknown>): void {
    this.table(table).set(String(record[PRIMARY_KEY[table]]), clone(record));
    this.notify(new Set([table]));
  }

  remove(table: SyncedTable, key: string): void {
    this.table(table).delete(key);
    this.notify(new Set([table]));
  }

  get(table: SyncedTable, key: string): Record<string, unknown> | undefined {
    return this.table(table).get(key);
  }

  private notify(tables: Set<string>): void {
    for (const l of this.listeners) l(tables);
  }
}

export class MemoryShadow implements ShadowStore {
  entries = new Map<string, ShadowEntry>();
  markers = new Map<string, number>();
  async load(): Promise<ShadowEntry[]> {
    return [...this.entries.values()].map(clone);
  }
  async save(put: ShadowEntry[], remove: string[]): Promise<void> {
    for (const e of put) this.entries.set(e.rk, clone(e));
    for (const rk of remove) this.entries.delete(rk);
  }
  async clear(): Promise<void> {
    this.entries.clear();
  }
  async loadMarker(name: string): Promise<number | undefined> {
    return this.markers.get(name);
  }
  async saveMarker(name: string, value: number): Promise<void> {
    this.markers.set(name, value);
  }
}

/** Espera microtarefas e temporizadores curtos assentarem. */
export async function settle(ms = 30): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}
