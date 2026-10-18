import type { IncomingMessage, ServerResponse } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import { createApp } from './app';
import { loadConfig } from './config';

/**
 * Ponto de entrada da camada privada na Vercel (função Node em /api).
 * O app estático é servido pela CDN da Vercel; esta função atende só /api/*.
 * As variáveis de ambiente vêm das configurações do projeto na Vercel (nunca do código).
 */

let listener: ReturnType<typeof getRequestListener> | undefined;

function getListener() {
  if (!listener) listener = getRequestListener(createApp({ config: loadConfig(process.env) }).fetch);
  return listener;
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value?.split(',')[0]?.trim();
}

/**
 * Normaliza a URL vista pela aplicação: esquema e host públicos (atrás do proxy da Vercel)
 * e o caminho original, mesmo quando a rota chega reescrita para /api?__rotinas_path=….
 */
export function normalizeIncoming(req: Pick<IncomingMessage, 'url' | 'headers'>): string {
  const proto = first(req.headers['x-forwarded-proto']) ?? 'https';
  const host = first(req.headers['x-forwarded-host']) ?? first(req.headers.host) ?? 'localhost';
  const url = new URL(req.url ?? '/', `${proto === 'http' ? 'http' : 'https'}://${host}`);
  const original = url.searchParams.get('__rotinas_path');
  if (original !== null) {
    url.searchParams.delete('__rotinas_path');
    if (url.pathname === '/api' || url.pathname === '/api/') url.pathname = `/api/${original.replace(/^\/+/, '')}`;
  }
  return url.toString();
}

export default function handler(req: IncomingMessage, res: ServerResponse) {
  req.url = normalizeIncoming(req);
  return getListener()(req, res);
}
