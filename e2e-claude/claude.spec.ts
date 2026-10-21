import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { ARTIFACT_URL, openDevice, USER_ID, World } from './fake-claude';

/**
 * O Rotinas publicado como artifact no Claude, com o Claude simulado (fake-claude.ts):
 * dados guardados na conta e iguais em dois aparelhos, Kai pelo plano do Claude, Google pelo
 * conector do Claude, lembrete da noite no Google, backup pelo download do Claude, telas sem erros
 * de acessibilidade graves — e nenhuma requisição de rede feita pela página.
 */

const go = (page: Page, hash: string) =>
  page.evaluate((h) => {
    window.location.hash = h;
  }, hash);

async function onboard(page: Page, name: string, template: string) {
  await page.goto(ARTIFACT_URL);
  await expect(page.getByRole('heading', { name: 'Sua rotina, do seu jeito.' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('tudo fica salvo na sua conta do Claude')).toBeVisible();
  await page.getByRole('button', { name: 'Começar a configuração' }).click();
  await expect(page.getByRole('heading', { name: 'Perfil', exact: true })).toBeVisible();
  await page.getByLabel(/Como quer ser chamado/).fill(name);
  await page.getByLabel('Fuso horário').selectOption('America/Sao_Paulo');
  for (const heading of ['Objetivo e tempo disponível', 'Lembretes', 'Autorizações opcionais', 'Primeira rotina']) {
    await page.getByRole('button', { name: 'Continuar' }).click();
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
  }
  await page.getByRole('button', { name: new RegExp(template) }).click();
  const dialog = page.getByRole('dialog', { name: 'Novo hábito' });
  await dialog.getByRole('button', { name: 'Adicionar à rotina' }).click();
  await page.getByRole('button', { name: 'Continuar' }).click();
  await expect(page.getByRole('heading', { name: 'Revisão' })).toBeVisible();
  await page.getByRole('button', { name: 'Salvar e começar' }).click();
  await expect(page.getByRole('heading', { name: 'Hoje', level: 1 })).toBeVisible();
}

const saved = (page: Page) => expect(page.locator('.nav-footer')).toHaveText('Salvo na sua conta do Claude.', { timeout: 15_000 });

test('dois aparelhos: os dados ficam na conta, atualizam ao vivo e “Apagar tudo” vale para os dois', async ({ browser }) => {
  test.setTimeout(120_000);
  const world = new World();
  const ipad = await openDevice(browser, world, { viewport: { width: 1180, height: 820 } });
  await onboard(ipad.page, 'Leo', 'Ler 10 páginas');
  await ipad.page.getByRole('button', { name: 'Concluir Ler 10 páginas' }).click();
  await expect(ipad.page.getByRole('button', { name: 'Desfazer conclusão de Ler 10 páginas' })).toBeVisible();
  await saved(ipad.page);

  // O que foi para a conta: só pacotes do app, na área privada da pessoa.
  expect([...world.docs.keys()]).toEqual([`data/users/${USER_ID}`]);
  const ids = [...world.collection(`data/users/${USER_ID}`).keys()];
  expect(ids).toContain('meta');
  expect(ids).toContain('c~habits');
  expect(ids.some((id) => id.startsWith('c~completions~'))).toBe(true);
  expect(JSON.stringify([...world.collection(`data/users/${USER_ID}`).values()])).not.toContain('accessToken');

  // Computador novo (IndexedDB vazio): abre direto no Hoje, com o registro feito no iPad.
  const pc = await openDevice(browser, world);
  await pc.page.goto(ARTIFACT_URL);
  await expect(pc.page.getByRole('heading', { name: 'Hoje', level: 1 })).toBeVisible({ timeout: 30_000 });
  await expect(pc.page.getByText(/Olá, Leo\./)).toBeVisible();
  await expect(pc.page.getByRole('button', { name: 'Desfazer conclusão de Ler 10 páginas' })).toBeVisible();

  // Desfazer no computador aparece no iPad sem recarregar.
  await pc.page.getByRole('button', { name: 'Desfazer conclusão de Ler 10 páginas' }).click();
  await saved(pc.page);
  await expect(ipad.page.getByRole('button', { name: 'Concluir Ler 10 páginas' })).toBeVisible({ timeout: 15_000 });

  // Apagar tudo no iPad: a conta fica vazia e o computador volta ao começo.
  await go(ipad.page, '#/configuracoes');
  await expect(ipad.page.getByRole('heading', { name: 'Configurações', level: 1 })).toBeVisible();
  await expect(ipad.page.getByText('Dados salvos na sua conta do Claude')).toBeVisible();
  await ipad.page.getByRole('button', { name: 'Apagar tudo' }).click();
  const confirm = ipad.page.getByRole('dialog', { name: 'Apagar todos os dados?' });
  await confirm.getByLabel('Para confirmar, digite APAGAR').fill('APAGAR');
  await confirm.getByRole('button', { name: 'Apagar tudo' }).click();
  await expect(ipad.page.getByRole('heading', { name: 'Sua rotina, do seu jeito.' })).toBeVisible({ timeout: 15_000 });
  await expect(pc.page.getByRole('heading', { name: 'Sua rotina, do seu jeito.' })).toBeVisible({ timeout: 15_000 });
  expect([...world.collection(`data/users/${USER_ID}`).keys()]).toEqual(['meta']);
  await pc.page.reload();
  await expect(pc.page.getByRole('heading', { name: 'Sua rotina, do seu jeito.' })).toBeVisible({ timeout: 30_000 });

  for (const device of [ipad, pc]) {
    expect(device.external, 'requisições de rede feitas pela página').toEqual([]);
    expect(device.errors, 'erros no console').toEqual([]);
    await device.context.close();
  }
});

test('Kai pelo plano do Claude, Google pelo conector, lembrete da noite e backup', async ({ browser }) => {
  test.setTimeout(120_000);
  const world = new World();
  const device = await openDevice(browser, world);
  const { page } = device;
  await onboard(page, 'Leo', 'Ler 10 páginas');

  // Kai: ativar, ver o estado e testar com uma frase fixa.
  await go(page, '#/kai');
  await page.getByRole('button', { name: 'Revisar e ativar o Kai' }).click();
  const consent = page.getByRole('dialog', { name: /Autorizar: Coaching por IA/ });
  await expect(consent.getByText(/O Claude, na sua própria conta/)).toBeVisible();
  await consent.getByRole('button', { name: 'Autorizar' }).click();
  await expect(page.getByText(/O Kai usa o Claude da sua conta, dentro do seu plano/)).toBeVisible();
  await go(page, '#/conexoes');
  await expect(page.getByRole('heading', { name: 'Conectar Kai e Google', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Testar o Kai agora' }).click();
  await expect(page.getByText('Resposta real do Kai: Funcionando! O Kai está pronto. (Claude (rápido))')).toBeVisible();
  expect(world.samples).toHaveLength(1);
  expect(world.samples[0].input.startsWith('<regras_do_kai>')).toBe(true);
  expect(world.samples[0].input).not.toContain('Leo');

  // Conversa de verdade com o Kai (o contexto vai, o nome não).
  await go(page, '#/kai');
  await page.getByLabel(/Mensagem para o Kai/).fill('Como encaixo a leitura?');
  await page.getByRole('button', { name: 'Enviar' }).click();
  await expect(page.getByText('Resposta simulada do Kai.')).toBeVisible();
  expect(world.samples[1].input).toContain('Ler 10 páginas');
  expect(world.samples[1].input).not.toContain('Leo');

  // Google: autorizar no app e ler os próximos 7 dias pelo conector (sem guardar nada).
  await go(page, '#/calendario');
  await page.getByRole('button', { name: 'Autorizar uso do calendário externo' }).click();
  await page.getByRole('dialog', { name: /Autorizar: Google Agenda/ }).getByRole('button', { name: 'Autorizar' }).click();
  await expect(page.getByText('Conector do Google Calendar encontrado no seu Claude')).toBeVisible();
  await expect(page.getByText('Aula de inglês').first()).toBeVisible();
  await expect(page.getByText('Bloco criado pelo app')).toHaveCount(0);
  expect(world.mcpCalls.find((c) => c.tool === 'list_events')?.cache).toBe(false);

  // Lembrete da noite no Google (o app não pode notificar dentro do Claude).
  await go(page, '#/noite');
  await expect(page.getByRole('heading', { name: 'Noite', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Criar no Google Agenda' }).click();
  await page.getByRole('dialog', { name: 'Criar o lembrete da noite?' }).getByRole('button', { name: 'Criar no Google Agenda' }).click();
  await expect(page.getByText(/Criado: todo dia às/)).toBeVisible();
  const reminder = world.mcpCalls.find((c) => c.tool === 'create_event');
  expect(reminder?.input).toMatchObject({ summary: 'Sessão da noite (Rotinas)', recurrenceData: ['RRULE:FREQ=DAILY'], availability: 'AVAILABILITY_FREE' });

  // Backup pelo download do Claude.
  await go(page, '#/configuracoes');
  await page.getByRole('button', { name: 'Exportar backup (JSON)' }).first().click();
  await expect(page.getByText('Backup JSON exportado.')).toBeVisible();
  expect(world.saved).toHaveLength(1);
  expect(world.saved[0].filename).toMatch(/\.json$/);
  expect(JSON.parse(world.saved[0].data).format).toBe('rotinas-backup');
  // Sem servidor próprio dentro do Claude: a seção de senha do servidor não aparece.
  await expect(page.getByRole('heading', { name: 'Servidor privado' })).toHaveCount(0);

  expect(device.external, 'requisições de rede feitas pela página').toEqual([]);
  expect(device.errors, 'erros no console').toEqual([]);
  await device.context.close();
});

test('telas no Claude: um título, sem rolagem lateral e sem violações graves de acessibilidade', async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  const world = new World();
  const routes: Array<[string, string]> = [
    ['#/', 'Hoje'],
    ['#/noite', 'Noite'],
    ['#/kai', 'Kai'],
    ['#/calendario', 'Calendário externo'],
    ['#/dinheiro', 'Dinheiro'],
    ['#/conexoes', 'Conectar Kai e Google'],
    ['#/configuracoes', 'Configurações'],
    ['#/configuracoes/privacidade', 'Privacidade'],
    ['#/mais', 'Mais'],
  ];
  for (const [label, viewport] of [
    ['ipad', { width: 820, height: 1180 }],
    ['computador', { width: 1366, height: 860 }],
  ] as const) {
    const device = await openDevice(browser, world, { viewport });
    if (label === 'ipad') await onboard(device.page, 'Leo', 'Ler 10 páginas');
    else {
      await device.page.goto(ARTIFACT_URL);
      await expect(device.page.getByRole('heading', { name: 'Hoje', level: 1 })).toBeVisible({ timeout: 30_000 });
    }
    const problems: string[] = [];
    for (const [hash, title] of routes) {
      await go(device.page, hash);
      await expect(device.page.getByRole('heading', { level: 1, name: title })).toBeVisible();
      await device.page.waitForTimeout(200);
      const h1 = await device.page.locator('h1').count();
      if (h1 !== 1) problems.push(`${label} ${hash}: ${h1} elementos h1`);
      const overflow = await device.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (overflow > 1) problems.push(`${label} ${hash}: rolagem horizontal de ${overflow}px`);
      const axe = await new AxeBuilder({ page: device.page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      for (const v of axe.violations.filter((x) => x.impact === 'serious' || x.impact === 'critical')) {
        problems.push(`${label} ${hash}: ${v.id} (${v.impact}) em ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`);
      }
      const name = hash.replace(/[#/]+/g, '-').replace(/^-|-$/g, '') || 'hoje';
      await device.page.screenshot({ path: testInfo.outputPath(`${label}-${name}.png`), fullPage: true });
    }
    expect(problems).toEqual([]);
    expect(device.external).toEqual([]);
    expect(device.errors).toEqual([]);
    await device.context.close();
  }
});

test('Dinheiro: lançar gasto e entrada, ver o relatório, sincronizar e exportar a planilha', async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const world = new World();
  const device = await openDevice(browser, world);
  const { page } = device;
  await onboard(page, 'Leo', 'Ler 10 páginas');
  await go(page, '#/dinheiro');
  await expect(page.getByRole('heading', { name: 'Dinheiro', level: 1 })).toBeVisible();
  await expect(page.getByText('Registre seu primeiro gasto')).toBeVisible();

  await page.getByRole('button', { name: 'Novo gasto' }).first().click();
  let dialog = page.getByRole('dialog', { name: 'Novo gasto' });
  await dialog.getByLabel('Valor (R$)').fill('45,90');
  await dialog.getByRole('button', { name: 'Alimentação' }).click();
  await dialog.getByRole('button', { name: 'Supérfluo' }).click();
  await dialog.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(page.getByText('Gasto de R$ 45,90 registrado.')).toBeVisible();

  await page.getByRole('button', { name: 'Nova entrada' }).first().click();
  dialog = page.getByRole('dialog', { name: 'Nova entrada' });
  await dialog.getByLabel('Valor (R$)').fill('500');
  await dialog.getByRole('button', { name: 'Mesada' }).click();
  await dialog.getByRole('button', { name: 'Salvar', exact: true }).click();

  await expect(page.locator('.stat').filter({ hasText: 'Entradas' })).toContainText('R$ 500,00');
  await expect(page.locator('.stat').filter({ hasText: 'Gastos' }).first()).toContainText('R$ 45,90');
  await expect(page.getByText('Sobrou R$ 454,10 — 91% do que entrou.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Para onde vai o seu dinheiro' })).toBeVisible();

  // Os lançamentos vão para a conta, num pacote do mês.
  await expect(page.locator('.nav-footer')).toHaveText('Salvo na sua conta do Claude.', { timeout: 15_000 });
  const ids = [...world.collection(`data/users/${USER_ID}`).keys()];
  expect(ids.some((id) => id.startsWith('c~moneyEntries~'))).toBe(true);

  // Relatório com dados: acessibilidade e captura para revisão visual.
  const axeMonth = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(axeMonth.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('dinheiro-mes.png'), fullPage: true });

  // Visão do ano e planilha.
  await page.getByRole('radio', { name: 'Ano', exact: true }).click();
  await expect(page.getByText('Mês a mês').first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('dinheiro-ano.png'), fullPage: true });
  await page.getByRole('button', { name: 'Exportar planilha' }).click();
  await expect(page.getByText(/Planilha exportada/)).toBeVisible();
  const csv = world.saved.find((f) => f.filename.endsWith('.csv'));
  expect(csv?.data).toContain('Alimentação');
  expect(csv?.data).toContain('-45,90');

  expect(device.external).toEqual([]);
  expect(device.errors).toEqual([]);
  await device.context.close();
});
