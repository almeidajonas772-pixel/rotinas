import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from './app';
import { loadConfig } from './config';
import { STATIC_SECURITY_HEADERS } from './infra';

/**
 * Ponto de entrada da camada privada.
 * - `npm run server:dev`: só a API em 127.0.0.1:8787 (o Vite em 5173 encaminha /api para cá).
 * - `npm start`: API + app compilado (dist/) no mesmo endereço, com cabeçalhos de segurança.
 */

if (existsSync('.env') && typeof process.loadEnvFile === 'function') process.loadEnvFile('.env');

const config = loadConfig(process.env);
const app = createApp({ config });

const staticDir = resolve(config.staticDir ?? 'dist');
const serveApp = process.argv.includes('--static') || process.env.npm_lifecycle_event === 'start';
if (serveApp && existsSync(staticDir)) {
  app.use('/*', async (c, next) => {
    await next();
    for (const [k, v] of Object.entries(STATIC_SECURITY_HEADERS)) c.header(k, v);
    const path = new URL(c.req.url).pathname;
    if (path === '/sw.js' || path === '/index.html' || path === '/') c.header('cache-control', 'no-cache');
  });
  app.use('/*', serveStatic({ root: staticDir }));
  app.get('*', serveStatic({ root: staticDir, path: 'index.html' }));
}

serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  const lines = [
    `Rotinas — camada privada em http://${info.address}:${info.port}`,
    serveApp ? `App compilado servido de ${staticDir}` : 'Somente API (use o Vite em desenvolvimento)',
    `Kai: ${config.kai.enabled ? `ativo (${config.kai.modelFast} / ${config.kai.modelDeep})` : `desativado — ${config.kai.reason}`}`,
    `Google Calendar: ${config.calendar.enabled ? 'configurado' : `desativado — ${config.calendar.reason}`}`,
    `Senha da camada privada: ${config.accessToken ? 'exigida' : 'não definida'}`,
  ];
  console.info(lines.join('\n'));
  if (config.host !== '127.0.0.1' && config.host !== 'localhost' && !config.accessToken) {
    console.warn('Atenção: o servidor está acessível fora deste computador sem ROTINAS_SERVER_TOKEN. Defina uma senha ou use 127.0.0.1.');
  }
});
