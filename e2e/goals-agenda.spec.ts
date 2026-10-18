import { expect, test } from '@playwright/test';
import { go, onboard } from './helpers';

test('metas: mensal com valor manual identificado, meta filha semanal e conclusão com XP', async ({ page }) => {
  await onboard(page, { template: 'Ler 10 páginas' });
  await go(page, '#/metas/nova');
  await expect(page.getByRole('heading', { name: 'Nova meta', level: 1 })).toBeVisible();
  await page.getByLabel('Título').fill('Ler 2 livros');
  await page.getByRole('radio', { name: 'Mensal', exact: true }).click();
  await page.getByRole('radio', { name: 'Valor manual', exact: true }).click();
  await page.getByLabel('Alvo').fill('2');
  await page.getByLabel('Unidade').fill('livros');
  await page.getByRole('button', { name: 'Criar meta' }).click();
  await expect(page.getByRole('heading', { name: 'Ler 2 livros', level: 1 })).toBeVisible();

  // Progresso manual fica marcado como manual no histórico.
  await page.getByLabel('Valor atual (livros)').fill('1');
  await page.getByRole('button', { name: 'Salvar atualização' }).click();
  await expect(page.getByText('Manual', { exact: true })).toBeVisible();

  // Meta filha semanal, já ligada à mensal.
  await page.getByRole('link', { name: 'Nova meta filha' }).first().click();
  await expect(page.getByRole('heading', { name: 'Nova meta', level: 1 })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Semanal', exact: true })).toHaveAttribute('aria-checked', 'true');
  await page.getByLabel('Título').fill('Ler 50 páginas');
  await page.getByRole('button', { name: 'Criar meta' }).click();
  await expect(page.getByRole('heading', { name: 'Ler 50 páginas', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Marcar como concluída' }).click();
  await expect(page.getByText('Meta concluída', { exact: true })).toBeVisible();
  await expect(page.getByText(/\(\+20 XP\)/)).toBeVisible();

  // A lista de metas mostra os quatro horizontes.
  await go(page, '#/metas');
  await expect(page.getByRole('heading', { name: 'Metas', level: 1 })).toBeVisible();
  for (const h of ['Anuais', 'Mensais', 'Semanais', 'Diárias']) await expect(page.getByText(h).first()).toBeVisible();
});

test('agenda: tarefa concluída, evento que se repete e edição só desta ocorrência', async ({ page }) => {
  await onboard(page);
  await go(page, '#/agenda');
  await expect(page.getByRole('heading', { name: 'Agenda', level: 1 })).toBeVisible();
  await page.getByRole('radio', { name: 'Dia', exact: true }).click();

  await page.getByRole('button', { name: 'Novo item' }).click();
  const editor = page.getByRole('dialog', { name: 'Novo item na agenda' });
  await editor.getByLabel('Título').fill('Pagar conta de luz');
  await editor.getByRole('button', { name: 'Criar' }).click();
  await page.getByRole('button', { name: 'Concluir Pagar conta de luz' }).click();
  await expect(page.getByRole('button', { name: 'Desfazer conclusão de Pagar conta de luz' })).toBeVisible();

  await page.getByRole('button', { name: 'Novo item' }).click();
  await editor.getByRole('radio', { name: 'Evento', exact: true }).click();
  await editor.getByLabel('Título').fill('Aula de inglês');
  const allDay = editor.getByRole('switch', { name: 'Dia inteiro' });
  if ((await allDay.getAttribute('aria-checked')) === 'true') await allDay.click();
  await editor.getByLabel('Início').fill('19:00');
  await editor.getByLabel(/^Fim/).fill('20:00');
  await editor.getByRole('radio', { name: 'Diária', exact: true }).click();
  await editor.getByRole('radio', { name: 'Após N vezes', exact: true }).click();
  await editor.getByLabel('Número de vezes').fill('3');
  await editor.getByRole('button', { name: 'Criar' }).click();
  await expect(page.getByText('19:00')).toBeVisible();

  await page.getByRole('button', { name: 'Ações para Aula de inglês' }).click();
  await page.getByRole('button', { name: 'Editar ou mover' }).click();
  const scope = page.getByRole('dialog', { name: 'Editar item que se repete' });
  await expect(scope.getByRole('button', { name: 'Esta e as próximas' })).toBeVisible();
  await scope.getByRole('button', { name: 'Somente esta ocorrência' }).click();
  const once = page.getByRole('dialog', { name: 'Editar somente esta ocorrência' });
  await once.getByLabel('Início').fill('21:00');
  await once.getByLabel(/^Fim/).fill('22:00');
  await once.getByRole('button', { name: 'Salvar' }).click();
  await expect(page.getByText('21:00')).toBeVisible();
  await expect(page.getByText('Alterada')).toBeVisible();

  // O dia seguinte continua com o horário original da série.
  await page.getByRole('button', { name: 'Próximo' }).click();
  await expect(page.getByText('19:00')).toBeVisible();
  await expect(page.getByText('Alterada')).toHaveCount(0);
});
