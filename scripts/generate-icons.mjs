// Gera os ícones PNG do PWA a partir de SVG (rodar uma vez: node scripts/generate-icons.mjs).
// Usa o Chromium do Playwright; os PNGs gerados ficam versionados em public/.
import { chromium } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const out = (name) => fileURLToPath(new URL(`../public/${name}`, import.meta.url));

const mark = (scale) => {
  const s = scale;
  const c = 32;
  return `
  <circle cx="${c}" cy="${c}" r="${19 * s}" fill="none" stroke="#3b4855" stroke-width="${3 * s}"/>
  <path d="M${c} ${c - 19 * s}a${19 * s} ${19 * s} 0 0 1 ${19 * s} ${19 * s}" fill="none" stroke="#8aa9ff" stroke-width="${5 * s}" stroke-linecap="round"/>
  <line x1="${c}" y1="${c}" x2="${c}" y2="${c - 12.5 * s}" stroke="#ffb547" stroke-width="${4 * s}" stroke-linecap="round"/>
  <circle cx="${c}" cy="${c}" r="${3.6 * s}" fill="#ffb547"/>`;
};

const rounded = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0e1318"/>${mark(1)}</svg>`;
const fullBleed = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#0e1318"/>${mark(1)}</svg>`;
const maskable = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#0e1318"/>${mark(0.72)}</svg>`;

const targets = [
  ['pwa-64x64.png', 64, rounded],
  ['pwa-192x192.png', 192, rounded],
  ['pwa-512x512.png', 512, rounded],
  ['maskable-icon-512x512.png', 512, maskable],
  ['apple-touch-icon-180x180.png', 180, fullBleed],
];

const browser = await chromium.launch(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {});
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const [name, size, svg] of targets) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  const buf = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  await writeFile(out(name), buf);
  console.log('gerado', name);
}
await browser.close();
