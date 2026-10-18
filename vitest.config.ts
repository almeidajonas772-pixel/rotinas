import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// Configuração de testes separada do vite.config.ts (que mantém o PWA de produção).
// O registro do service worker é substituído por um stub nos testes.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: 'virtual:pwa-register', replacement: here('./tests/stubs/pwa-register.ts') },
      // react-router publica builds ESM e CJS. Sem fixar o ESM, os testes carregavam
      // duas cópias do contexto do roteador (RouterProvider de uma, useLocation de outra).
      { find: /^react-router\/dom$/, replacement: here('./node_modules/react-router/dist/development/dom-export.mjs') },
      { find: /^react-router$/, replacement: here('./node_modules/react-router/dist/development/index.mjs') },
    ],
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
    restoreMocks: true,
    server: { deps: { inline: [/react-router/] } },
    testTimeout: 15000,
    coverage: {
      provider: 'v8',
      include: ['src/**', 'server/**', 'shared/**'],
      exclude: ['src/main.tsx', '**/*.d.ts'],
    },
  },
});
