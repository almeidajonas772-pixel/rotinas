import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const api = { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false } };

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['favicon.svg', 'apple-touch-icon-180x180.png', 'sw-notifications.js'],
      manifest: {
        name: 'Rotinas',
        short_name: 'Rotinas',
        description: 'Organizador pessoal de hábitos, metas, agenda e reflexões. Os dados ficam neste dispositivo.',
        lang: 'pt-BR',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        background_color: '#f3f5f7',
        theme_color: '#f3f5f7',
        icons: [
          { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,webmanifest}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        importScripts: ['/sw-notifications.js'],
        cleanupOutdatedCaches: true,
        // A API nunca é cacheada: respostas do Kai e do calendário são sempre ao vivo.
        runtimeCaching: [],
      },
      devOptions: { enabled: false },
    }),
  ],
  server: { port: 5173, strictPort: true, host: '127.0.0.1', proxy: api },
  preview: { port: 4173, strictPort: true, host: '127.0.0.1', proxy: api },
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 900 },
});
