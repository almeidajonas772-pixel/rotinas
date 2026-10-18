// Gera .vercel/output (Build Output API v3) para publicar na Vercel com a camada privada:
//  - static/: o app compilado (dist/), servido pela CDN;
//  - functions/api.func/: a camada privada (Hono) empacotada num único arquivo Node;
//  - config.json: cabeçalhos de segurança e a rota /api/* → função.
// Uso: npm run build:vercel  (a Vercel roda este comando ao publicar a partir do Git)
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';

const OUT = '.vercel/output';
if (!existsSync('dist/index.html')) {
  console.error('dist/ não encontrado. Rode "vite build" antes (npm run build:vercel faz os dois).');
  process.exit(1);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(`${OUT}/static`, { recursive: true });
cpSync('dist', `${OUT}/static`, { recursive: true });

const FUNC = `${OUT}/functions/api.func`;
mkdirSync(FUNC, { recursive: true });
await build({
  entryPoints: ['server/vercel.ts'],
  outfile: `${FUNC}/index.js`,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  legalComments: 'none',
  logLevel: 'warning',
});
writeFileSync(`${FUNC}/package.json`, `${JSON.stringify({ type: 'commonjs' })}\n`);
writeFileSync(
  `${FUNC}/.vc-config.json`,
  `${JSON.stringify({ runtime: 'nodejs22.x', handler: 'index.js', launcherType: 'Nodejs', shouldAddHelpers: false, maxDuration: 60 }, null, 2)}\n`,
);

// Cabeçalhos de segurança: a mesma fonte usada pelo servidor local.
const headersBuild = await build({ entryPoints: ['shared/security-headers.ts'], bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'warning' });
const { SECURITY_HEADERS } = await import(`data:text/javascript;base64,${Buffer.from(headersBuild.outputFiles[0].text).toString('base64')}`);

const config = {
  version: 3,
  routes: [
    { src: '/(.*)', headers: SECURITY_HEADERS, continue: true },
    { src: '/sw\\.js', headers: { 'cache-control': 'no-cache' }, continue: true },
    { src: '/(index\\.html)?', headers: { 'cache-control': 'no-cache' }, continue: true },
    { src: '/manifest\\.webmanifest', headers: { 'cache-control': 'no-cache' }, continue: true },
    { src: '/assets/(.*)', headers: { 'cache-control': 'public, max-age=31536000, immutable' }, continue: true },
    { handle: 'filesystem' },
    { src: '/api/(.*)', dest: '/api?__rotinas_path=$1', check: true },
  ],
};
writeFileSync(`${OUT}/config.json`, `${JSON.stringify(config, null, 2)}\n`);

const kb = (file) => `${Math.round(statSync(file).size / 1024)} KB`;
console.info(`Pronto: ${OUT} (função /api ${kb(`${FUNC}/index.js`)}; app estático copiado de dist/)`);
