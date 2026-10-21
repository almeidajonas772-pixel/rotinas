import { useEffect, useState, useSyncExternalStore } from 'react';
import { capabilityErrorCode, claudeCapability } from '../platform/claude';
import { isClaudeRuntime } from '../platform/runtime';

/** Utilidades de navegador: tema, conexão, arquivos, preferências leves de interface e armazenamento persistente. */

// ── Tema ──────────────────────────────────────────────────────────────────

/** Tema que o Claude aplicou à página antes de o app mudar algo (dentro do Claude). */
let hostTheme: string | undefined | null = null;

export function applyTheme(theme: 'system' | 'light' | 'dark'): void {
  const root = document.documentElement;
  if (isClaudeRuntime()) {
    // Dentro do Claude, "sistema" significa seguir o tema do próprio Claude (que marca a página).
    if (hostTheme === null) hostTheme = root.dataset.theme;
    if (theme !== 'system') root.dataset.theme = theme;
    else if (hostTheme) root.dataset.theme = hostTheme;
    else delete root.dataset.theme;
    return;
  }
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
}

// ── Conexão ───────────────────────────────────────────────────────────────

function subscribeOnline(callback: () => void) {
  window.addEventListener('online', callback);
  window.addEventListener('offline', callback);
  return () => {
    window.removeEventListener('online', callback);
    window.removeEventListener('offline', callback);
  };
}

export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
}

// ── Preferências leves de interface (por aparelho) ────────────────────────
// Somente conveniências (última visualização da agenda, período do relatório).
// Nunca guardam hábitos, metas, agenda ou diário — esses ficam no IndexedDB.

const UI_PREFIX = 'rotinas:ui:';

export function readUiPref<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(UI_PREFIX + key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writeUiPref(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(UI_PREFIX + key, JSON.stringify(value));
  } catch {
    // armazenamento indisponível (modo privado etc.): a conveniência apenas não é lembrada
  }
}

export function clearUiPrefs(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k?.startsWith(UI_PREFIX)) keys.push(k);
    }
    keys.forEach((k) => window.localStorage.removeItem(k));
  } catch {
    // ignore
  }
}

export function useUiPref<T>(key: string, fallback: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => readUiPref(key, fallback));
  const set = (next: T) => {
    setValue(next);
    writeUiPref(key, next);
  };
  return [value, set];
}

// ── Arquivos ──────────────────────────────────────────────────────────────

export type DownloadResult = 'saved' | 'declined' | 'busy' | 'unavailable';

/**
 * Entrega um arquivo gerado pelo app. No site, baixa direto. Dentro do Claude, o navegador não
 * deixa a página baixar sozinha: o Claude mostra uma confirmação e salva se a pessoa aceitar.
 */
export async function downloadText(filename: string, content: string, mime: string): Promise<DownloadResult> {
  if (isClaudeRuntime()) {
    const downloads = await claudeCapability('downloads');
    if (!downloads) return 'unavailable';
    try {
      await downloads.save({ filename, data: content });
      return 'saved';
    } catch (error) {
      const code = capabilityErrorCode(error);
      return code === 'declined' ? 'declined' : code === 'rate_limited' ? 'busy' : 'unavailable';
    }
  }
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return 'saved';
}

/**
 * Compartilhar um arquivo pela folha de compartilhamento do sistema (no iPhone/iPad: "Salvar em
 * Arquivos", iCloud Drive etc.). Só aparece onde o navegador aceita compartilhar esse tipo de arquivo.
 */
export function canShareFile(file: File): boolean {
  // Dentro do Claude, a folha de compartilhamento do sistema não está disponível para a página.
  if (isClaudeRuntime()) return false;
  try {
    return typeof navigator !== 'undefined' && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

export function makeTextFile(filename: string, content: string, mime: string): File {
  return new File([content], filename, { type: mime });
}

export type ShareResult = 'shared' | 'cancelled' | 'needs-gesture' | 'failed';

export async function shareFile(file: File, title: string): Promise<ShareResult> {
  try {
    await navigator.share({ files: [file], title });
    return 'shared';
  } catch (error) {
    const name = error instanceof DOMException ? error.name : '';
    if (name === 'AbortError') return 'cancelled';
    // O navegador exige um toque "fresco": a tela oferece um botão para compartilhar o arquivo já pronto.
    if (name === 'NotAllowedError') return 'needs-gesture';
    return 'failed';
  }
}

export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('Falha ao ler o arquivo'));
    reader.readAsText(file);
  });
}

// ── Armazenamento persistente ─────────────────────────────────────────────

export interface StorageInfo {
  supported: boolean;
  persisted: boolean | null;
  usage?: number;
  quota?: number;
}

export async function getStorageInfo(): Promise<StorageInfo> {
  if (!navigator.storage) return { supported: false, persisted: null };
  try {
    const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : null;
    const estimate = navigator.storage.estimate ? await navigator.storage.estimate() : undefined;
    return { supported: true, persisted, usage: estimate?.usage, quota: estimate?.quota };
  } catch {
    return { supported: true, persisted: null };
  }
}

/** Pede ao navegador para não apagar os dados locais automaticamente quando faltar espaço. */
export async function requestPersistentStorage(): Promise<boolean | null> {
  try {
    if (!navigator.storage?.persist) return null;
    return await navigator.storage.persist();
  } catch {
    return null;
  }
}

export function useStorageInfo(refreshKey: unknown = 0): StorageInfo | undefined {
  const [info, setInfo] = useState<StorageInfo>();
  useEffect(() => {
    let alive = true;
    getStorageInfo().then((i) => {
      if (alive) setInfo(i);
    });
    return () => {
      alive = false;
    };
  }, [refreshKey]);
  return info;
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace('.', ',')} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1).replace('.', ',')} GB`;
}

export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** Volta para a tela Hoje sem criar entrada no histórico (o app usa rotas por hash, também dentro do Claude). */
export function goToToday(): void {
  window.location.replace('#/');
}

/** Mensagem para o resultado de um download (o "salvo" de cada tela fica com quem chamou). */
export function downloadProblem(result: DownloadResult): string | null {
  switch (result) {
    case 'saved':
      return null;
    case 'declined':
      return 'Download cancelado.';
    case 'busy':
      return 'Já há um pedido de download aberto: responda a ele e tente de novo.';
    case 'unavailable':
      return 'Esta visualização não permite baixar arquivos. Abra o Rotinas pelo claude.ai e tente de novo.';
  }
}
