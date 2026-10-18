// Gera release/rotinas-web: o app compilado (dist/) + vercel.json só com cabeçalhos de segurança,
// pronto para arrastar em https://vercel.com/drop (ou outro host estático com HTTPS).
// Uso: npm run package:web
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { STATIC_SECURITY_HEADERS } from '../server/infra';

const out = 'release/rotinas-web';
if (!existsSync('dist/index.html')) {
  console.error('dist/ não encontrado. Rode "npm run build:app" antes.');
  process.exit(1);
}
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync('dist', out, { recursive: true });

const headers = Object.entries(STATIC_SECURITY_HEADERS).map(([key, value]) => ({ key, value }));
const config = {
  headers: [
    { source: '/(.*)', headers },
    // Atualizações do app chegam assim que publicadas (o service worker pede a confirmação).
    { source: '/sw.js', headers: [{ key: 'Cache-Control', value: 'no-cache' }] },
    { source: '/index.html', headers: [{ key: 'Cache-Control', value: 'no-cache' }] },
  ],
};
writeFileSync(`${out}/vercel.json`, `${JSON.stringify(config, null, 2)}\n`);
console.info(`Pronto: ${out} (arraste esta pasta em https://vercel.com/drop)`);
