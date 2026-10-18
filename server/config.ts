/**
 * Configuração da camada privada, lida somente de variáveis de ambiente.
 * Nenhum valor secreto é devolvido ao navegador: /api/health informa apenas
 * se cada recurso está habilitado e, se não estiver, o motivo.
 */

export interface ServerConfig {
  host: string;
  port: number;
  /** Origens aceitas para chamadas que alteram estado (além da própria origem do servidor). */
  allowedOrigins: string[];
  appOrigin: string;
  accessToken?: string;
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
    encryptionKey?: Buffer;
    tokenFile: string;
  };
  staticDir?: string;
  version: string;
}

export const DEFAULT_MODELS = {
  // IDs conferidos na documentação oficial (platform.claude.com/docs/en/models/overview) em outubro de 2026.
  fast: 'claude-haiku-5-5',
  deep: 'claude-sonnet-5-5',
} as const;

function int(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clean(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const host = clean(env.ROTINAS_SERVER_HOST) ?? '127.0.0.1';
  const port = int(env.ROTINAS_SERVER_PORT, 8787, 1, 65535);
  const appOrigin = (clean(env.APP_ORIGIN) ?? 'http://127.0.0.1:5173').replace(/\/$/, '');
  const selfOrigins = [`http://${host}:${port}`, `http://127.0.0.1:${port}`, `http://localhost:${port}`];
  const allowedOrigins = [...new Set([appOrigin, ...selfOrigins, appOrigin.replace('127.0.0.1', 'localhost'), appOrigin.replace('localhost', '127.0.0.1')])];

  const apiKey = clean(env.ANTHROPIC_API_KEY);
  const kai: ServerConfig['kai'] = {
    enabled: Boolean(apiKey),
    reason: apiKey ? undefined : 'ANTHROPIC_API_KEY não definida no servidor.',
    apiKey,
    modelFast: clean(env.KAI_MODEL_FAST) ?? DEFAULT_MODELS.fast,
    modelDeep: clean(env.KAI_MODEL_DEEP) ?? DEFAULT_MODELS.deep,
    perMinute: int(env.KAI_RATE_LIMIT_PER_MINUTE, 6, 1, 120),
    perDay: int(env.KAI_DAILY_LIMIT, 60, 1, 5000),
    maxOutputTokens: int(env.KAI_MAX_OUTPUT_TOKENS, 2000, 256, 16000),
    timeoutMs: int(env.KAI_TIMEOUT_MS, 45000, 5000, 180000),
  };

  const clientId = clean(env.GOOGLE_CLIENT_ID);
  const clientSecret = clean(env.GOOGLE_CLIENT_SECRET);
  const redirectUri = clean(env.GOOGLE_REDIRECT_URI);
  const rawKey = clean(env.TOKEN_ENCRYPTION_KEY);
  let encryptionKey: Buffer | undefined;
  let calendarReason: string | undefined;
  if (rawKey) {
    const decoded = Buffer.from(rawKey, 'base64');
    if (decoded.length === 32) encryptionKey = decoded;
    else calendarReason = 'TOKEN_ENCRYPTION_KEY precisa ter 32 bytes em base64.';
  }
  const missing = [
    !clientId && 'GOOGLE_CLIENT_ID',
    !clientSecret && 'GOOGLE_CLIENT_SECRET',
    !redirectUri && 'GOOGLE_REDIRECT_URI',
    !rawKey && 'TOKEN_ENCRYPTION_KEY',
  ].filter(Boolean);
  if (!calendarReason && missing.length > 0) calendarReason = `Variáveis ausentes no servidor: ${missing.join(', ')}.`;
  const calendar: ServerConfig['calendar'] = {
    enabled: !calendarReason,
    reason: calendarReason,
    clientId,
    clientSecret,
    redirectUri,
    encryptionKey,
    tokenFile: clean(env.GOOGLE_TOKEN_FILE) ?? '.data/google-calendar.enc',
  };

  return {
    host,
    port,
    allowedOrigins,
    appOrigin,
    accessToken: clean(env.ROTINAS_SERVER_TOKEN),
    kai,
    calendar,
    staticDir: clean(env.ROTINAS_STATIC_DIR),
    version: '1.0.0',
  };
}
