import { defineConfig } from '@playwright/test';

// E2E do Rotinas publicado como artifact no Claude: a página de release/rotinas-claude (gerada por
// `npm run build:claude`) com o Claude simulado em e2e-claude/fake-claude.ts. Não precisa de servidor:
// a página é entregue pelo próprio Playwright num endereço fictício.
const executablePath = process.env.PW_CHROMIUM_PATH || undefined;

export default defineConfig({
  testDir: './e2e-claude',
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-claude' }]],
  outputDir: 'test-results-claude',
  use: {
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    trace: 'retain-on-failure',
    launchOptions: executablePath ? { executablePath } : {},
  },
});
