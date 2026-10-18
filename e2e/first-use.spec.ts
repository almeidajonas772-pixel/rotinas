import { expect, test } from '@playwright/test';
import { go, onboard, trackConsoleErrors, trackNetwork } from './helpers';

test('primeiro uso sem IA: configurar, criar hábito, concluir, recarregar e ver histórico', async ({ page, baseURL }) => {
  const net = trackNetwork(page, baseURL!);
  const errors = trackConsoleErrors(page);

  await onboard(page, { name: 'Leo', template: 'Ler 10 páginas' });
  await expect(page.getByText(/Olá, Leo\./)).toBeVisible();

  await page.getByRole('button', { name: 'Concluir Ler 10 páginas' }).click();
  await expect(page.getByRole('button', { name: 'Desfazer conclusão de Ler 10 páginas' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('Concluído: Ler 10 páginas (+10 XP)')).toBeVisible();

  // Recarregar a página mantém o registro (IndexedDB).
  await page.reload();
  await expect(page.getByRole('button', { name: 'Desfazer conclusão de Ler 10 páginas' })).toBeVisible();

  // Histórico do hábito.
  await go(page, '#/habitos');
  await expect(page.getByRole('heading', { name: 'Hábitos', level: 1 })).toBeVisible();
  await page.getByRole('link', { name: /Ler 10 páginas/ }).first().click();
  await expect(page.getByRole('heading', { name: 'Ler 10 páginas', level: 1 })).toBeVisible();
  await expect(page.getByText('Sequência atual')).toBeVisible();
  await expect(page.getByText('1 ocorrência').first()).toBeVisible();

  // Relatório do período reflete o registro real.
  await go(page, '#/relatorios');
  await expect(page.getByRole('heading', { name: 'Relatórios', level: 1 })).toBeVisible();
  await expect(page.getByText('Concluídas × previstas')).toBeVisible();
  await page.getByRole('button', { name: 'Ver tabela' }).first().click();
  await expect(page.getByRole('table').first()).toBeVisible();

  // Sem Kai e sem calendário: nenhuma requisição externa nem para a camada privada.
  expect(net.external, 'requisições para outras origens').toEqual([]);
  expect(net.api, 'requisições para /api').toEqual([]);
  expect(errors, 'erros no console').toEqual([]);
});

test('desfazer e registrar de novo não duplica XP', async ({ page }) => {
  await onboard(page, { template: 'Ler 10 páginas' });
  const done = page.getByRole('button', { name: 'Desfazer conclusão de Ler 10 páginas' });
  const open = page.getByRole('button', { name: 'Concluir Ler 10 páginas' });
  await open.click();
  await done.click();
  await open.click();
  await expect(done).toBeVisible();
  const xp = await page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const req = indexedDB.open('rotinas');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const tx = req.result.transaction('progressEvents', 'readonly');
          const all = tx.objectStore('progressEvents').getAll();
          all.onsuccess = () => resolve((all.result as Array<{ xp: number }>).reduce((s, e) => s + e.xp, 0));
          all.onerror = () => reject(all.error);
        };
      }),
  );
  expect(xp).toBe(10);
});
