import Dexie from 'dexie';
import type { RotinasDB } from '../db/db';
import { isClaudeRuntime } from './runtime';

/**
 * Abre a cópia local (IndexedDB). Dentro do Claude, o navegador às vezes não deixa a página usar
 * o IndexedDB (janela privada, dados do site bloqueados, prévias da galeria). Nesse caso o app
 * usa um banco só na memória: nada se perde, porque os dados vêm do armazenamento da pessoa no
 * Claude a cada abertura. Fora do Claude, o erro continua sendo mostrado como antes.
 */

export type LocalDbMode = 'indexeddb' | 'memory';

const BLOCKED = new Set(['MissingAPIError', 'InvalidStateError', 'SecurityError', 'UnknownError', 'NotAllowedError']);

export function storageBlocked(error: unknown): boolean {
  const e = error as { name?: unknown; inner?: { name?: unknown } } | undefined;
  return BLOCKED.has(String(e?.name)) || BLOCKED.has(String(e?.inner?.name));
}

export async function openLocalDatabase(database: RotinasDB): Promise<LocalDbMode> {
  try {
    await database.open();
    return 'indexeddb';
  } catch (error) {
    if (!isClaudeRuntime() || !storageBlocked(error)) throw error;
    const fake = await import('fake-indexeddb');
    // Dexie guarda as dependências na instância ao ser criada; troca as duas e abre de novo.
    const deps = (database as unknown as { _deps?: { indexedDB: unknown; IDBKeyRange: unknown } })._deps;
    if (!deps) throw error;
    deps.indexedDB = fake.indexedDB;
    deps.IDBKeyRange = fake.IDBKeyRange;
    // Bancos criados depois (o da sincronização) também ficam na memória.
    Dexie.dependencies.indexedDB = fake.indexedDB as unknown as IDBFactory;
    Dexie.dependencies.IDBKeyRange = fake.IDBKeyRange as unknown as typeof IDBKeyRange;
    await database.open();
    return 'memory';
  }
}
