import { deriveKeyFromPassword, subKey } from './crypto';

/**
 * Configuração da camada privada, lida somente de variáveis de ambiente.
 * Nenhum valor secreto é devolvido ao navegador: /api/health informa apenas
 * se cada recurso está habilitado e, se não estiver, o motivo.
 *
 * Dois modos:
 * - local (`npm run dev` / `npm start`): escuta em 127.0.0.1; senha opcional;
 * - nuvem (Vercel, detectada por VERCEL=1): endereço público, então a senha
 *   ROTINAS_SERVER_TOKEN é obrigatória — sem ela, todas as rotas protegidas ficam bloqueadas.
 */

export type Runtime = 'local' | 'vercel';

export const MIN_TOKEN_LENGTH = 12;

export interface ServerConfig {
  runtime: Runtime;
  host: string;
  port: number;
  /** Origens aceitas para chamadas que alteram estado (além da própria origem do pedido). */
  allowedOrigins: string[];
  appOrigin: string;
  accessToken?: string;
  /** A senha é obrigatória (nuvem, servidor exposto fora do computador ou ROTINAS_REQUIRE_TOKEN=1). */
  requireAccessToken: boolean;
  /** Quando preenchido, o servidor recusa tudo (exceto o retorno do OAuth) até a senha ser configurada. */
  lockReason?: string;
  secrets: {
    /** Cifra os tokens do Google em repouso (AES-256-GCM). */
    encryptionKey?: Buffer;
    /** Assina o `state` do OAuth e as prévias do calendário (HMAC). */
    signingKey?: Buffer;
    source: 'TOKEN_ENCRYPTION_KEY' | 'ROTINAS_SERVER_TOKEN' | 'none';
    error?: string;
  };
  storage: {
    kind: 'file' | 'blob' | 'none';
    reason?: string;
    /** Pasta e nome do arquivo de tokens no modo local. */
    fileDir: string;
    tokenName: string;
  };
  kai: {
    enabled: boolean;
    reason?: string;
    apiKey?: string;
    modelFast: string;
    modelDeep: string;
    perMinute: number;
    perDay: number;
    maxOutputTokens: number;
    timeoutMs: number;
  };
  calendar: {
    enabled: boolean;
    reason?: string;
    clientId?: string;
    clientSecret?: string;
    redirectUri?: string;
    redirectSource?: 'env' | 'vercel';
  };
  staticDir?: string;
  version: string;
}

export const DEFAULT_MODELS = {
  // IDs conferidos na documentação oficial (platform.claude.com/docs/en/models/overview) em outubro de 2026.
  fast: 'claude-haiku-5-5',
  deep: 'claude-sonnet-5-5',
} as const;

export const SERVER_VERSION = '1.1.0';

function int(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clean(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}

function splitPath(file: string): { dir: string; name: string } {
  const normalized = file.replace(/\\/g, '/');
  const i = normalized.lastIndexOf('/');
  return i < 0 ? { dir: '.', name: normalized } : { dir: normalized.slice(0, i) || '/', name: normalized.slice(i + 1) };
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const runtime: Runtime = env.VERCEL === '1' || env.VERCEL === 'true' ? 'vercel' : 'local';
  const host = clean(env.ROTINAS_SERVER_HOST) ?? '127.0.0.1';
  const port = int(env.ROTINAS_SERVER_PORT, 8787, 1, 65535);
  const productionHost = clean(env.VERCEL_PROJECT_PRODUCTION_URL)?.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const appOrigin = (clean(env.APP_ORIGIN) ?? (runtime === 'vercel' && productionHost ? `https://${productionHost}` : 'http://127.0.0.1:5173')).replace(/\/$/, '');
  const selfOrigins = [`http://${host}:${port}`, `http://127.0.0.1:${port}`, `http://localhost:${port}`];
  const vercelOrigins = [productionHost, clean(env.VERCEL_URL), clean(env.VERCEL_BRANCH_URL)].filter((h): h is string => Boolean(h)).map((h) => `https://${h.replace(/^https?:\/\//, '')}`);
  const allowedOrigins = [
    ...new Set([appOrigin, ...selfOrigins, ...vercelOrigins, appOrigin.replace('127.0.0.1', 'localhost'), appOrigin.replace('localhost', '127.0.0.1')]),
  ];

  // ── Senha da camada privada ────────────────────────────────────────────────
  const accessToken = clean(env.ROTINAS_SERVER_TOKEN);
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  const requireAccessToken = runtime === 'vercel' || !loopback || env.ROTINAS_REQUIRE_TOKEN === '1';
  let lockReason: string | undefined;
  if (requireAccessToken && !accessToken) {
    lockReason = `Defina ROTINAS_SERVER_TOKEN (uma senha com ${MIN_TOKEN_LENGTH} ou mais caracteres) nas variáveis de ambiente do servidor. Até lá, Kai e Google ficam bloqueados.`;
  } else if (requireAccessToken && accessToken && accessToken.length < MIN_TOKEN_LENGTH) {
    lockReason = `ROTINAS_SERVER_TOKEN é curta demais: use ${MIN_TOKEN_LENGTH} ou mais caracteres.`;
  }

  // ── Chaves: TOKEN_ENCRYPTION_KEY ou derivada da senha ───────────────────────
  const secrets: ServerConfig['secrets'] = { source: 'none' };
  const rawKey = clean(env.TOKEN_ENCRYPTION_KEY);
  if (rawKey) {
    const decoded = Buffer.from(rawKey, 'base64');
    if (decoded.length === 32) {
      secrets.source = 'TOKEN_ENCRYPTION_KEY';
      // Compatível com arquivos de tokens já gravados com a chave direta.
      secrets.encryptionKey = decoded;
      secrets.signingKey = subKey(decoded, 'signing');
    } else secrets.error = 'TOKEN_ENCRYPTION_KEY precisa ter 32 bytes em base64.';
  } else if (accessToken && accessToken.length >= MIN_TOKEN_LENGTH) {
    const master = deriveKeyFromPassword(accessToken);
    secrets.source = 'ROTINAS_SERVER_TOKEN';
    secrets.encryptionKey = subKey(master, 'token-encryption');
    secrets.signingKey = subKey(master, 'signing');
  }

  // ── Armazenamento ──────────────────────────────────────────────────────────
  const tokenFile = splitPath(clean(env.GOOGLE_TOKEN_FILE) ?? '.data/google-calendar.enc');
  const blobConfigured = Boolean(clean(env.BLOB_STORE_ID) || clean(env.BLOB_READ_WRITE_TOKEN));
  const storage: ServerConfig['storage'] = blobConfigured
    ? { kind: 'blob', fileDir: tokenFile.dir, tokenName: 'google-calendar.enc' }
    : runtime === 'vercel'
      ? { kind: 'none', reason: 'Conecte um armazenamento Blob privado ao projeto na Vercel (Storage → Blob).', fileDir: tokenFile.dir, tokenName: tokenFile.name }
      : { kind: 'file', fileDir: tokenFile.dir, tokenName: tokenFile.name };

  // ── Kai ────────────────────────────────────────────────────────────────────
  const apiKey = clean(env.ANTHROPIC_API_KEY);
  const kai: ServerConfig['kai'] = {
    enabled: Boolean(apiKey),
    reason: apiKey ? undefined : 'ANTHROPIC_API_KEY não definida no servidor.',
    apiKey,
    modelFast: clean(env.KAI_MODEL_FAST) ?? DEFAULT_MODELS.fast,
    modelDeep: clean(env.KAI_MODEL_DEEP) ?? DEFAULT_MODELS.deep,
    perMinute: int(env.KAI_RATE_LIMIT_PER_MINUTE, 10, 1, 120),
    perDay: int(env.KAI_DAILY_LIMIT, 80, 1, 5000),
    maxOutputTokens: int(env.KAI_MAX_OUTPUT_TOKENS, 2000, 256, 16000),
    timeoutMs: int(env.KAI_TIMEOUT_MS, 45000, 5000, 180000),
  };

  // ── Google Calendar ────────────────────────────────────────────────────────
  const clientId = clean(env.GOOGLE_CLIENT_ID);
  const clientSecret = clean(env.GOOGLE_CLIENT_SECRET);
  const explicitRedirect = clean(env.GOOGLE_REDIRECT_URI);
  const redirectUri = explicitRedirect ?? (runtime === 'vercel' && productionHost ? `https://${productionHost}/api/calendar/callback` : undefined);
  const missing = [
    !clientId && 'GOOGLE_CLIENT_ID',
    !clientSecret && 'GOOGLE_CLIENT_SECRET',
    !redirectUri && 'GOOGLE_REDIRECT_URI',
    !secrets.encryptionKey && !secrets.error && 'TOKEN_ENCRYPTION_KEY (ou ROTINAS_SERVER_TOKEN)',
  ].filter(Boolean);
  let calendarReason: string | undefined;
  if (missing.length > 0) calendarReason = `Variáveis ausentes no servidor: ${missing.join(', ')}.`;
  else if (secrets.error) calendarReason = secrets.error;
  else if (storage.kind === 'none') calendarReason = storage.reason;
  const calendar: ServerConfig['calendar'] = {
    enabled: !calendarReason,
    reason: calendarReason,
    clientId,
    clientSecret,
    redirectUri,
    redirectSource: explicitRedirect ? 'env' : redirectUri ? 'vercel' : undefined,
  };

  return {
    runtime,
    host,
    port,
    allowedOrigins,
    appOrigin,
    accessToken,
    requireAccessToken,
    lockReason,
    secrets,
    storage,
    kai,
    calendar,
    staticDir: clean(env.ROTINAS_STATIC_DIR),
    version: SERVER_VERSION,
  };
}
