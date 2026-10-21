import { recordHash, jsonBytes } from './hash';
import { defaultDocId, isSyncedTable, mergeFromSync, PRIMARY_KEY, projectForSync, soloDocId, SYNC_SCHEMAS, SYNCED_TABLES, type SyncedTable } from './layout';

/**
 * Sincronização entre a cópia local (IndexedDB) e o armazenamento da pessoa no Claude.
 *
 * Modelo: cada registro tem um carimbo `m` (milissegundos) da última mudança conhecida; vence o
 * mais recente ("último a gravar vence", por registro). Exclusões viram marcas (`d: null`) que
 * somem depois de 180 dias. Uma "sombra" local guarda, para cada registro, o carimbo e a
 * impressão digital do último estado sincronizado — é assim que o app sabe se a mudança foi
 * feita neste aparelho (enviar) ou em outro (aplicar aqui), mesmo depois de fechar o app.
 *
 * Tudo roda em fila (uma operação por vez). Nada aqui conhece Dexie ou o Claude: o armazenamento
 * local, o remoto e a sombra entram como interfaces (os testes usam versões em memória).
 */

export const TOMBSTONE = '-';
export const META_DOC_ID = 'meta';

export interface SyncRecord {
  m: number;
  d: Record<string, unknown> | null;
}

export interface SyncDoc {
  v: 1;
  t: SyncedTable;
  r: Record<string, SyncRecord>;
}

export interface SyncMeta {
  v: 1;
  schema: number;
  updatedAt: string;
  /** Momento do último "Apagar tudo": aparelhos que sincronizaram antes apagam a cópia local. */
  wipedAt?: number;
}

export interface RemoteSnapshot {
  docs: Map<string, SyncDoc>;
  meta?: SyncMeta;
  /** Confirmado pelo armazenamento (e não só a cópia em cache da primeira entrega). */
  definitive: boolean;
}

export interface RemoteStore {
  subscribe(next: (snapshot: RemoteSnapshot) => void, error: (code: string, message: string) => void): () => void;
  write(docId: string, doc: SyncDoc | SyncMeta): Promise<void>;
  remove(docId: string): Promise<void>;
}

export interface LocalChange {
  table: SyncedTable;
  key: string;
  /** `null` apaga o registro. */
  record: Record<string, unknown> | null;
}

export interface LocalStore {
  readTable(table: SyncedTable): Promise<Record<string, unknown>[]>;
  apply(changes: LocalChange[]): Promise<void>;
  onChange(listener: (tables: Set<string>) => void): () => void;
  afterRemoteApply?(tables: Set<SyncedTable>): Promise<void>;
  /** Apaga todos os dados locais (usado em "Apagar tudo"). */
  clearAll?(): Promise<void>;
}

export interface ShadowEntry {
  rk: string;
  m: number;
  h: string;
  doc: string;
}

export interface ShadowStore {
  load(): Promise<ShadowEntry[]>;
  save(put: ShadowEntry[], remove: string[]): Promise<void>;
  clear(): Promise<void>;
  loadMarker(name: string): Promise<number | undefined>;
  saveMarker(name: string, value: number): Promise<void>;
}

export type SyncState = 'connecting' | 'syncing' | 'synced' | 'error' | 'blocked' | 'stopped';

export interface SyncStatus {
  state: SyncState;
  message?: string;
  /** Código da última falha (para decidir se vale tentar de novo). */
  code?: string;
  lastSyncedAt?: number;
  pending: number;
  /** Registros grandes demais para o armazenamento (ficam só neste aparelho). */
  unsyncable: number;
  /** Registros recebidos com formato inválido (ignorados). */
  invalid: number;
  documents: number;
}

export interface SyncEngineOptions {
  local: LocalStore;
  remote: RemoteStore;
  shadow: ShadowStore;
  schemaVersion: number;
  now?: () => number;
  debounceMs?: number;
  /** Tamanho máximo de um pacote (o limite da plataforma é 256 KiB). */
  maxDocBytes?: number;
  tombstoneTtlMs?: number;
  retryMs?: number;
  onStatus?: (status: SyncStatus) => void;
}

interface Pending {
  table: SyncedTable;
  key: string;
  m: number;
  h: string;
  d: Record<string, unknown> | null;
}

interface Located {
  table: SyncedTable;
  key: string;
  m: number;
  d: Record<string, unknown> | null;
  doc: string;
}

const RETRYABLE = new Set(['unavailable', 'resource_exhausted', 'upstream_error', 'server_unavailable']);

const rkOf = (table: string, key: string) => `${table}|${key}`;

export class SyncEngine {
  private readonly o: Required<Omit<SyncEngineOptions, 'onStatus'>> & Pick<SyncEngineOptions, 'onStatus'>;
  private shadow = new Map<string, ShadowEntry>();
  private shadowPut = new Set<string>();
  private shadowRemove = new Set<string>();
  private pending = new Map<string, Pending>();
  private docs = new Map<string, SyncDoc>();
  private index = new Map<string, Located>();
  private meta: SyncMeta | undefined;
  private dirty = new Set<SyncedTable>();
  private unsyncable = new Set<string>();
  private invalid = 0;
  private chain: Promise<void> = Promise.resolve();
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private unsubLocal?: () => void;
  private unsubRemote?: () => void;
  private ready = false;
  private resolveReady!: (ok: boolean) => void;
  private readonly readyPromise: Promise<boolean>;
  private status: SyncStatus = { state: 'connecting', pending: 0, unsyncable: 0, invalid: 0, documents: 0 };
  private stopped = false;
  /** Durante "Apagar tudo", entregas do armazenamento são ignoradas (seriam retratos parciais). */
  private wiping = false;
  /** Último "Apagar tudo" já aplicado neste aparelho. */
  private knownWipe = 0;

  constructor(options: SyncEngineOptions) {
    this.o = {
      now: () => Date.now(),
      debounceMs: 800,
      maxDocBytes: 240_000,
      tombstoneTtlMs: 180 * 86_400_000,
      retryMs: 30_000,
      ...options,
    };
    this.readyPromise = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
  }

  // ── Ciclo de vida ─────────────────────────────────────────────────────────

  async start(): Promise<void> {
    for (const entry of await this.o.shadow.load()) this.shadow.set(entry.rk, entry);
    this.knownWipe = (await this.o.shadow.loadMarker('wipedAt')) ?? 0;
    this.unsubLocal = this.o.local.onChange((tables) => this.markDirty(tables));
    this.unsubRemote = this.o.remote.subscribe(
      (snapshot) => this.onRemote(snapshot),
      (code, message) => {
        this.setStatus({ state: 'error', code, message: `O armazenamento do Claude parou de responder (${message}). Seus dados continuam neste aparelho; recarregue a página para tentar de novo.` });
        if (!this.ready) this.resolveReady(false);
      },
    );
  }

  /** Resolve `true` depois da primeira sincronização completa; `false` se falhar ou passar do tempo. */
  whenReady(timeoutMs: number): Promise<boolean> {
    if (this.ready) return Promise.resolve(true);
    return Promise.race([this.readyPromise, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs))]);
  }

  stop(): void {
    this.stopped = true;
    this.unsubLocal?.();
    this.unsubRemote?.();
    if (this.debounce) clearTimeout(this.debounce);
    if (this.retry) clearTimeout(this.retry);
    this.setStatus({ state: 'stopped' });
  }

  getStatus(): SyncStatus {
    return this.status;
  }

  /** Espera a fila atual terminar (útil em testes e antes de operações destrutivas). */
  async flush(): Promise<void> {
    if (this.debounce) {
      clearTimeout(this.debounce);
      this.debounce = undefined;
      this.enqueue(() => this.pushLocal());
    }
    await this.chain;
  }

  /** Tenta de novo agora (botão "Sincronizar agora"). */
  syncNow(): Promise<void> {
    for (const t of SYNCED_TABLES) this.dirty.add(t);
    this.enqueue(() => this.pushLocal());
    return this.chain;
  }

  /**
   * Apaga tudo: os pacotes da pessoa no Claude e os dados deste aparelho. Roda na fila, então
   * nenhuma sincronização acontece no meio.
   */
  wipeEverything(): Promise<void> {
    let settle!: { resolve: () => void; reject: (e: unknown) => void };
    const done = new Promise<void>((resolve, reject) => {
      settle = { resolve, reject };
    });
    this.enqueue(async () => {
      try {
        await this.wipeNow();
        settle.resolve();
      } catch (error) {
        settle.reject(error);
        throw error;
      }
    });
    return done;
  }

  private async wipeNow(): Promise<void> {
    this.wiping = true;
    try {
      for (const id of [...this.docs.keys()]) await this.o.remote.remove(id);
      const wipedAt = this.o.now();
      const meta: SyncMeta = { v: 1, schema: this.o.schemaVersion, updatedAt: new Date(wipedAt).toISOString(), wipedAt };
      await this.o.remote.write(META_DOC_ID, meta);
      this.meta = meta;
      this.knownWipe = wipedAt;
      await this.o.shadow.saveMarker('wipedAt', wipedAt);
      this.docs.clear();
      this.index.clear();
      this.pending.clear();
      this.unsyncable.clear();
      this.shadow.clear();
      this.shadowPut.clear();
      this.shadowRemove.clear();
      await this.o.shadow.clear();
      await this.o.local.clearAll?.();
      this.dirty.clear();
    } finally {
      this.wiping = false;
    }
    this.setStatus({ state: 'synced', pending: 0, lastSyncedAt: this.o.now() });
  }

  /** Outro aparelho usou "Apagar tudo" depois da última sincronização deste: apaga a cópia local. */
  private async applyWipeMarker(): Promise<void> {
    const wipedAt = this.meta?.wipedAt ?? 0;
    if (wipedAt <= this.knownWipe) return;
    if (this.shadow.size > 0) {
      await this.o.local.clearAll?.();
      this.shadow.clear();
      this.shadowPut.clear();
      this.shadowRemove.clear();
      await this.o.shadow.clear();
      this.pending.clear();
      this.dirty.clear();
    }
    this.knownWipe = wipedAt;
    await this.o.shadow.saveMarker('wipedAt', wipedAt);
  }

  // ── Eventos ─────────────────────────────────────────────────────────────────

  private markDirty(tables: Set<string>): void {
    if (this.stopped) return;
    let any = false;
    for (const t of tables) {
      if (isSyncedTable(t)) {
        this.dirty.add(t);
        any = true;
      }
    }
    if (!any || !this.ready) return;
    // A tela mostra "salvando" já na mudança, não só depois da espera de agrupamento.
    if (this.status.state === 'synced' || this.status.state === 'error') this.setStatus({ state: 'syncing' });
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      this.enqueue(() => this.pushLocal());
    }, this.o.debounceMs);
  }

  private onRemote(snapshot: RemoteSnapshot): void {
    if (this.stopped || this.wiping) return;
    this.docs = snapshot.docs;
    this.meta = snapshot.meta;
    this.rebuildIndex();
    // Antes da primeira sincronização, só a resposta confirmada pelo armazenamento conta
    // (a entrega em cache pode estar incompleta).
    if (!this.ready && !snapshot.definitive) return;
    this.enqueue(() => this.reconcile());
  }

  private enqueue(task: () => Promise<void>): void {
    this.chain = this.chain
      .then(async () => {
        if (!this.stopped) await task();
      })
      .catch((error: unknown) => {
        const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'unknown';
        const message = typeof (error as { message?: unknown })?.message === 'string' ? (error as { message: string }).message : 'falha inesperada';
        this.setStatus({ state: 'error', code, message: describeWriteFailure(code, message) });
        if (RETRYABLE.has(code)) this.scheduleRetry();
      });
  }

  private scheduleRetry(): void {
    if (this.retry || this.stopped) return;
    this.retry = setTimeout(() => {
      this.retry = undefined;
      this.enqueue(() => this.pushLocal());
    }, this.o.retryMs);
  }

  // ── Núcleo ──────────────────────────────────────────────────────────────────

  private rebuildIndex(): void {
    const index = new Map<string, Located>();
    for (const [docId, doc] of this.docs) {
      for (const [key, rec] of Object.entries(doc.r)) {
        const rk = rkOf(doc.t, key);
        const cur = index.get(rk);
        // Cópias do mesmo registro em pacotes diferentes: vale a mais recente (empate: a que tem dados).
        if (!cur || rec.m > cur.m || (rec.m === cur.m && cur.d === null && rec.d !== null)) {
          index.set(rk, { table: doc.t, key, m: rec.m, d: rec.d, doc: docId });
        }
      }
    }
    this.index = index;
  }

  private blockedBySchema(): boolean {
    if (this.meta && this.meta.schema > this.o.schemaVersion) {
      this.setStatus({
        state: 'blocked',
        message: 'Uma versão mais nova do Rotinas já gravou seus dados no Claude. Recarregue a página para usar a versão nova; até lá, nada deste aparelho é enviado.',
      });
      return true;
    }
    return false;
  }

  private async reconcile(): Promise<void> {
    const first = !this.ready;
    this.setStatus({ state: 'syncing' });
    await this.applyWipeMarker();
    const tables = first ? [...SYNCED_TABLES] : [...this.dirty];
    this.dirty.clear();
    await this.detectLocal(tables);
    await this.applyRemote();
    if (first) {
      this.ready = true;
      this.resolveReady(true);
    }
    await this.push();
  }

  private async pushLocal(): Promise<void> {
    if (!this.ready) return;
    const tables = [...this.dirty];
    this.dirty.clear();
    if (tables.length > 0) {
      this.setStatus({ state: 'syncing' });
      await this.detectLocal(tables);
    }
    await this.push();
  }

  /** Compara as tabelas locais com a sombra e marca o que mudou neste aparelho. */
  private async detectLocal(tables: SyncedTable[]): Promise<void> {
    const now = this.o.now();
    for (const table of tables) {
      const rows = await this.o.local.readTable(table);
      const seen = new Set<string>();
      const pk = PRIMARY_KEY[table];
      for (const row of rows) {
        const key = String(row[pk]);
        const rk = rkOf(table, key);
        seen.add(rk);
        const projected = projectForSync(table, row);
        const h = recordHash(projected);
        const s = this.shadow.get(rk);
        if (s && s.h === h) {
          this.pending.delete(rk);
          continue;
        }
        if (this.pending.get(rk)?.h === h) continue;
        const remote = this.index.get(rk);
        if (remote?.d && recordHash(remote.d) === h) {
          // Já está igual no armazenamento (ex.: sombra perdida): só registra.
          this.setShadow({ rk, m: remote.m, h, doc: remote.doc });
          this.pending.delete(rk);
          continue;
        }
        this.pending.set(rk, { table, key, m: now, h, d: projected });
      }
      for (const [rk, s] of this.shadow) {
        if (!rk.startsWith(`${table}|`) || seen.has(rk) || s.h === TOMBSTONE) continue;
        if (this.pending.get(rk)?.d === null) continue;
        this.pending.set(rk, { table, key: rk.slice(table.length + 1), m: now, h: TOMBSTONE, d: null });
      }
      // Criado e apagado aqui antes de ser enviado: não há nada a enviar.
      for (const [rk, p] of this.pending) {
        if (p.table === table && p.d !== null && !seen.has(rk)) this.pending.delete(rk);
      }
    }
  }

  /** Aplica neste aparelho o que mudou em outro (o mais recente vence). */
  private async applyRemote(): Promise<void> {
    const changes: LocalChange[] = [];
    const touched = new Set<SyncedTable>();
    const localRows = new Map<SyncedTable, Map<string, Record<string, unknown>>>();
    const localRow = async (table: SyncedTable, key: string) => {
      let rows = localRows.get(table);
      if (!rows) {
        rows = new Map((await this.o.local.readTable(table)).map((r) => [String(r[PRIMARY_KEY[table]]), r]));
        localRows.set(table, rows);
      }
      return rows.get(key);
    };
    for (const [rk, r] of this.index) {
      const s = this.shadow.get(rk);
      if (s && s.m >= r.m) {
        if (s.m === r.m && s.doc !== r.doc) this.setShadow({ ...s, doc: r.doc });
        continue;
      }
      const p = this.pending.get(rk);
      if (p && p.m >= r.m) continue;
      let record: Record<string, unknown> | null = null;
      let h = TOMBSTONE;
      if (r.d) {
        const current = await localRow(r.table, r.key);
        const parsed = SYNC_SCHEMAS[r.table].safeParse(mergeFromSync(r.table, r.d, current));
        if (!parsed.success) {
          this.invalid += 1;
          continue;
        }
        record = parsed.data as Record<string, unknown>;
        h = recordHash(projectForSync(r.table, record));
      } else if (!(await localRow(r.table, r.key))) {
        // Exclusão de algo que já não existe aqui: só registra.
        this.setShadow({ rk, m: r.m, h: TOMBSTONE, doc: r.doc });
        this.pending.delete(rk);
        continue;
      }
      changes.push({ table: r.table, key: r.key, record });
      touched.add(r.table);
      this.setShadow({ rk, m: r.m, h, doc: r.doc });
      this.pending.delete(rk);
    }
    if (changes.length > 0) {
      await this.o.local.apply(changes);
      await this.o.local.afterRemoteApply?.(touched);
    }
    await this.flushShadow();
  }

  /** Envia as mudanças deste aparelho, agrupadas por pacote. */
  private async push(): Promise<void> {
    if (this.blockedBySchema()) return;
    if (this.pending.size === 0) {
      await this.flushShadow();
      this.setStatus({ state: 'synced', lastSyncedAt: this.o.now(), code: undefined, message: undefined });
      return;
    }
    if (!this.meta || this.meta.schema < this.o.schemaVersion) {
      const meta: SyncMeta = { ...(this.meta ?? {}), v: 1, schema: this.o.schemaVersion, updatedAt: new Date(this.o.now()).toISOString() };
      await this.o.remote.write(META_DOC_ID, meta);
      this.meta = meta;
    }
    const groups = new Map<string, Pending[]>();
    for (const [rk, p] of this.pending) {
      if (this.unsyncable.has(rk)) continue;
      const where = this.index.get(rk)?.doc ?? this.shadow.get(rk)?.doc ?? (p.d ? defaultDocId(p.table, p.key, p.d) : undefined);
      if (!where) {
        this.pending.delete(rk);
        continue;
      }
      const list = groups.get(where) ?? [];
      list.push(p);
      groups.set(where, list);
    }
    const now = this.o.now();
    for (const [docId, items] of groups) {
      const current = this.docs.get(docId);
      const doc: SyncDoc = current ? { v: 1, t: current.t, r: { ...current.r } } : { v: 1, t: items[0].table, r: {} };
      const writing = new Set(items.map((p) => p.key));
      for (const p of items) {
        const cur = doc.r[p.key];
        if (!cur || cur.m <= p.m) doc.r[p.key] = { m: p.m, d: p.d };
      }
      for (const [key, rec] of Object.entries(doc.r)) {
        if (rec.d === null && now - rec.m > this.o.tombstoneTtlMs && !writing.has(key)) delete doc.r[key];
      }
      const moved: Pending[] = [];
      if (jsonBytes(doc) > this.o.maxDocBytes) {
        const biggest = items.filter((p) => p.d !== null).sort((a, b) => jsonBytes(b.d) - jsonBytes(a.d));
        for (const p of biggest) {
          if (jsonBytes(doc) <= this.o.maxDocBytes) break;
          delete doc.r[p.key];
          moved.push(p);
        }
        if (jsonBytes(doc) > this.o.maxDocBytes) {
          this.setStatus({ state: 'error', code: 'too_large', message: 'Um pacote de dados passou do limite do armazenamento do Claude. Os dados continuam neste aparelho.' });
          continue;
        }
      }
      const stay = items.filter((p) => !moved.includes(p));
      if (stay.length > 0) {
        await this.o.remote.write(docId, doc);
        this.docs.set(docId, doc);
        for (const p of stay) this.settle(p, docId);
      }
      for (const p of moved) {
        const solo = soloDocId(p.table, p.key);
        const soloDoc: SyncDoc = { v: 1, t: p.table, r: { [p.key]: { m: p.m, d: p.d } } };
        if (jsonBytes(soloDoc) > this.o.maxDocBytes) {
          this.unsyncable.add(rkOf(p.table, p.key));
          continue;
        }
        await this.o.remote.write(solo, soloDoc);
        this.docs.set(solo, soloDoc);
        this.settle(p, solo);
      }
    }
    this.rebuildIndex();
    await this.flushShadow();
    this.setStatus({ state: this.pending.size > this.unsyncable.size ? 'syncing' : 'synced', lastSyncedAt: this.o.now(), code: undefined, message: undefined });
  }

  private settle(p: Pending, docId: string): void {
    const rk = rkOf(p.table, p.key);
    this.setShadow({ rk, m: p.m, h: p.h, doc: docId });
    this.pending.delete(rk);
  }

  private setShadow(entry: ShadowEntry): void {
    this.shadow.set(entry.rk, entry);
    this.shadowPut.add(entry.rk);
    this.shadowRemove.delete(entry.rk);
  }

  private async flushShadow(): Promise<void> {
    const now = this.o.now();
    // Marcas de exclusão antigas também saem da sombra.
    for (const [rk, s] of this.shadow) {
      if (s.h === TOMBSTONE && now - s.m > this.o.tombstoneTtlMs && !this.index.has(rk)) {
        this.shadow.delete(rk);
        this.shadowPut.delete(rk);
        this.shadowRemove.add(rk);
      }
    }
    if (this.shadowPut.size === 0 && this.shadowRemove.size === 0) return;
    const put = [...this.shadowPut].map((rk) => this.shadow.get(rk)).filter((e): e is ShadowEntry => Boolean(e));
    const remove = [...this.shadowRemove];
    this.shadowPut.clear();
    this.shadowRemove.clear();
    await this.o.shadow.save(put, remove);
  }

  private setStatus(patch: Partial<SyncStatus>): void {
    this.status = {
      ...this.status,
      ...patch,
      pending: this.pending.size,
      unsyncable: this.unsyncable.size,
      invalid: this.invalid,
      documents: this.docs.size,
    };
    this.o.onStatus?.(this.status);
  }
}

export function describeWriteFailure(code: string, message: string): string {
  switch (code) {
    case 'quota_exceeded':
      return 'O armazenamento deste app no Claude está cheio. Seus dados continuam neste aparelho; exporte um backup e apague registros antigos (por exemplo, conversas do Kai).';
    case 'resource_exhausted':
      return 'O Claude pediu para o app ir mais devagar. A sincronização tenta de novo sozinha em instantes.';
    case 'unavailable':
      return 'O armazenamento do Claude não respondeu agora. A sincronização tenta de novo sozinha em instantes.';
    case 'revoked':
    case 'not_granted':
    case 'capability_disabled':
      return 'O app perdeu o acesso ao armazenamento do Claude nesta visualização. Recarregue a página.';
    case 'invalid_argument':
      return 'O armazenamento recusou um pacote de dados. Seus dados continuam neste aparelho; avise quem mantém o app.';
    default:
      return `A sincronização falhou (${message}). Seus dados continuam neste aparelho e o app tenta de novo na próxima mudança.`;
  }
}
