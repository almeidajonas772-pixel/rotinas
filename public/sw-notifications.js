/* Rotinas — complemento do service worker: ao tocar num lembrete, foca o app aberto (e abre a tela certa) ou abre o app. */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/#/';
  const absolute = new URL(target, self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clients) => {
      for (const client of clients) {
        if ('focus' in client) {
          const focused = await client.focus();
          if (target !== '/#/' && 'navigate' in focused) {
            try {
              await focused.navigate(absolute);
            } catch {
              /* janela não controlada por este service worker: fica só em foco */
            }
          }
          return focused;
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(absolute);
      return undefined;
    }),
  );
});
