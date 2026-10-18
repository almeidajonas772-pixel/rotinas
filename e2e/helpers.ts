import { expect, type Page } from '@playwright/test';

/** Registra toda requisição que sai da página: externas (outra origem) e para a camada privada (/api). */
export function trackNetwork(page: Page, baseURL: string) {
  const origin = new URL(baseURL).origin;
  const external: string[] = [];
  const api: string[] = [];
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (url.protocol === 'data:' || url.protocol === 'blob:') return;
    if (url.origin !== origin) external.push(req.url());
    else if (url.pathname.startsWith('/api/')) api.push(req.url());
  });
  return { external, api };
}

export function trackConsoleErrors(page: Page) {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

/** Primeiro uso completo pela interface, sem autorizar nada opcional. */
export async function onboard(page: Page, options: { name?: string; template?: string } = {}) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sua rotina, do seu jeito.' })).toBeVisible();
  await page.getByRole('button', { name: 'Começar a configuração' }).click();
  await expect(page.getByRole('heading', { name: 'Perfil local' })).toBeVisible();
  if (options.name) await page.getByLabel(/Como quer ser chamado/).fill(options.name);
  await page.getByLabel('Fuso horário').selectOption('America/Sao_Paulo');
  for (const heading of ['Objetivo e tempo disponível', 'Lembretes', 'Autorizações opcionais', 'Primeira rotina']) {
    await page.getByRole('button', { name: 'Continuar' }).click();
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
  }
  if (options.template) {
    await page.getByRole('button', { name: new RegExp(options.template) }).click();
    const dialog = page.getByRole('dialog', { name: 'Novo hábito' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Adicionar à rotina' }).click();
    await expect(page.getByRole('heading', { name: 'Sua rotina (1)' })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Continuar' }).click();
  await expect(page.getByRole('heading', { name: 'Revisão' })).toBeVisible();
  await page.getByRole('button', { name: 'Salvar e começar' }).click();
  await expect(page.getByRole('heading', { name: 'Hoje', level: 1 })).toBeVisible();
}

/** Navegação por hash (o app usa HashRouter) e espera o título da página. */
export async function go(page: Page, hashPath: string) {
  await page.evaluate((h) => {
    window.location.hash = h;
  }, hashPath);
}
