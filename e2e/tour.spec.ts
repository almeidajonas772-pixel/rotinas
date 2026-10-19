import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { go, onboard, trackConsoleErrors, trackNetwork } from './helpers';

/**
 * Percorre todas as telas com dados reais criados pela interface, verificando:
 * um único título h1, ausência de rolagem horizontal, ausência de erros no console,
 * nenhuma requisição externa e nenhuma violação grave/crítica de acessibilidade (axe-core).
 * Também salva capturas de tela para revisão visual.
 */

const ROUTES: Array<[string, string]> = [
  ['#/', 'Hoje'],
  ['#/noite', 'Noite'],
  ['#/habitos', 'Hábitos'],
  ['#/habitos/novo', 'Novo hábito'],
  ['#/metas', 'Metas'],
  ['#/metas/nova', 'Nova meta'],
  ['#/agenda', 'Agenda'],
  ['#/relatorios', 'Relatórios'],
  ['#/diario', 'Diário'],
  ['#/kai', 'Kai'],
  ['#/calendario', 'Calendário externo'],
  ['#/conexoes', 'Conectar Kai e Google'],
  ['#/configuracoes', 'Configurações'],
  ['#/configuracoes/privacidade', 'Privacidade'],
  ['#/mais', 'Mais'],
  ['#/nao-existe', 'Página não encontrada'],
];

test('todas as telas: título, layout, acessibilidade e rede', async ({ page, baseURL }, testInfo) => {
  test.setTimeout(180_000);
  const net = trackNetwork(page, baseURL!);
  const errors = trackConsoleErrors(page);
  await onboard(page, { name: 'Leo', template: 'Ler 10 páginas' });
  await page.getByRole('button', { name: 'Concluir Ler 10 páginas' }).click();
  await expect(page.getByRole('button', { name: 'Desfazer conclusão de Ler 10 páginas' })).toBeVisible();

  // Telas que dependem de dados: detalhe e edição do hábito criado.
  await go(page, '#/habitos');
  await page.getByRole('link', { name: /Ler 10 páginas/ }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Ler 10 páginas' })).toBeVisible();
  const habitHash = await page.evaluate(() => window.location.hash);
  const routes: Array<[string, string]> = [...ROUTES, [habitHash, 'Ler 10 páginas'], [`${habitHash}/editar`, 'Editar hábito']];

  const problems: string[] = [];
  for (const [hash, title] of routes) {
    await go(page, hash);
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
    await page.waitForTimeout(150);
    const h1 = await page.locator('h1').count();
    if (h1 !== 1) problems.push(`${hash}: ${h1} elementos h1`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 1) problems.push(`${hash}: rolagem horizontal de ${overflow}px`);
    const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    for (const v of axe.violations.filter((x) => x.impact === 'serious' || x.impact === 'critical')) {
      problems.push(`${hash}: ${v.id} (${v.impact}) em ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`);
    }
    const name = (hash === habitHash ? 'habito-detalhe' : hash === `${habitHash}/editar` ? 'habito-editar' : hash.replace(/[#/]+/g, '-').replace(/^-|-$/g, '')) || 'hoje';
    await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true });
  }

  // Visões de mês e dia da agenda.
  await go(page, '#/agenda');
  for (const view of ['Mês', 'Dia']) {
    await page.getByRole('radio', { name: view, exact: true }).click();
    await page.waitForTimeout(150);
    const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    for (const v of axe.violations.filter((x) => x.impact === 'serious' || x.impact === 'critical')) {
      problems.push(`agenda (${view}): ${v.id} em ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`);
    }
    await page.screenshot({ path: testInfo.outputPath(`agenda-${view === 'Mês' ? 'mes' : 'dia'}.png`), fullPage: true });
  }

  // Tema escuro também precisa passar no contraste.
  await page.emulateMedia({ colorScheme: 'dark' });
  for (const [hash] of [ROUTES[0], ROUTES[1], ROUTES[7]]) {
    await go(page, hash);
    await page.waitForTimeout(150);
    const axe = await new AxeBuilder({ page }).withTags(['wcag2aa']).analyze();
    for (const v of axe.violations.filter((x) => x.impact === 'serious' || x.impact === 'critical')) {
      problems.push(`escuro ${hash}: ${v.id} em ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`);
    }
    await page.screenshot({ path: testInfo.outputPath(`escuro${hash.replace(/[#/]+/g, '-')}.png`), fullPage: true });
  }

  expect(problems).toEqual([]);
  expect(net.external).toEqual([]);
  expect(net.api).toEqual([]);
  expect(errors).toEqual([]);
});

test('teclado: navegação principal alcançável e foco visível', async ({ page }) => {
  await onboard(page, { template: 'Ler 10 páginas' });
  await page.keyboard.press('Tab');
  const first = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return el ? { tag: el.tagName, text: el.textContent?.trim(), outline: getComputedStyle(el).outlineStyle } : null;
  });
  expect(first).not.toBeNull();
  expect(first?.outline).not.toBe('none');
  await expect(page.getByRole('link', { name: 'Pular para o conteúdo' })).toBeFocused();
});
