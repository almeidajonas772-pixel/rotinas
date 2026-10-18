import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { go, onboard } from './helpers';

test('depois da primeira visita, abre e registra sem internet', async ({ page, context }) => {
  await onboard(page, { template: 'Ler 10 páginas' });
  await expect(page.getByRole('button', { name: 'Concluir Ler 10 páginas' })).toBeVisible();
  // O service worker do build de produção precisa estar ativo antes de cortar a rede.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });

  await context.setOffline(true);
  try {
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Hoje', level: 1 })).toBeVisible();
    await expect(page.getByText(/Sem conexão\. Tudo continua funcionando/)).toBeVisible();
    await page.getByRole('button', { name: 'Concluir Ler 10 páginas' }).click();
    await expect(page.getByRole('button', { name: 'Desfazer conclusão de Ler 10 páginas' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Desfazer conclusão de Ler 10 páginas' })).toBeVisible();

    // Kai sem internet: estado claro, sem tentativa de rede.
    await go(page, '#/kai');
    await expect(page.getByText('O Kai está desativado')).toBeVisible();
  } finally {
    await context.setOffline(false);
  }
});

test('já na primeira visita, antes do onboarding, o app fica disponível offline', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sua rotina, do seu jeito.' })).toBeVisible();
  await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    if (reg.active?.state !== 'activated') {
      await new Promise<void>((resolve) => reg.active?.addEventListener('statechange', () => reg.active?.state === 'activated' && resolve()));
    }
  });
  await context.setOffline(true);
  try {
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Sua rotina, do seu jeito.' })).toBeVisible();
  } finally {
    await context.setOffline(false);
  }
});

test('exportar backup, apagar tudo com confirmação forte e restaurar', async ({ page }, testInfo) => {
  await onboard(page, { template: 'Ler 10 páginas' });
  await page.getByRole('button', { name: 'Concluir Ler 10 páginas' }).click();
  await expect(page.getByRole('button', { name: 'Desfazer conclusão de Ler 10 páginas' })).toBeVisible();

  await go(page, '#/configuracoes');
  await expect(page.getByRole('heading', { name: 'Configurações', level: 1 })).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Exportar backup (JSON)' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^rotinas-backup-\d{4}-\d{2}-\d{2}\.json$/);
  const file = testInfo.outputPath('backup.json');
  await download.saveAs(file);
  const backup = JSON.parse(await readFile(file, 'utf8'));
  expect(backup.format).toBe('rotinas-backup');
  expect(backup.tables.habits).toHaveLength(1);
  expect(backup.tables.completions).toHaveLength(1);
  expect(JSON.stringify(backup.tables.prefs)).not.toContain('accessToken');

  const [readable] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Exportar versão legível (Markdown)' }).click()]);
  expect(readable.suggestedFilename()).toMatch(/\.md$/);

  await page.getByRole('button', { name: 'Apagar tudo' }).click();
  const dialog = page.getByRole('dialog', { name: 'Apagar todos os dados locais?' });
  const confirm = dialog.getByRole('button', { name: 'Apagar tudo' });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel('Para confirmar, digite APAGAR').fill('APAGAR');
  await confirm.click();
  await expect(page.getByRole('heading', { name: 'Sua rotina, do seu jeito.' })).toBeVisible();

  // Passa o conteúdo como buffer: o Chromium ignora caminhos locais com acentos (a pasta do teste tem “confirmação”).
  await page.locator('input[type="file"]').setInputFiles({ name: 'rotinas-backup.json', mimeType: 'application/json', buffer: await readFile(file) });
  const restore = page.getByRole('dialog', { name: 'Restaurar backup' });
  await expect(restore.getByText('Hábitos: 1', { exact: true })).toBeVisible();
  await expect(restore.getByText('Registros de hábitos: 1', { exact: true })).toBeVisible();
  await restore.getByRole('button', { name: 'Restaurar' }).click();
  await expect(page.getByRole('button', { name: 'Desfazer conclusão de Ler 10 páginas' })).toBeVisible();
});

test('arquivo inválido não é restaurado e explica o motivo', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type="file"]').setInputFiles({ name: 'nao-e-backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ hello: 'world' })) });
  const dialog = page.getByRole('dialog', { name: 'Restaurar backup' });
  await expect(dialog.getByText('Este arquivo não pode ser restaurado')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Restaurar' })).toHaveCount(0);
});
