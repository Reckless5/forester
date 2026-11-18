// Forester service worker: shows push notifications for flag reports and
// opens the app on the report when the notification is tapped.
// (No offline caching yet.)

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    (async () => {
      await self.registration.showNotification(data.title || 'Forester', {
        body: data.body || '',
        tag: data.tag,
        icon: 'icon-192.png',
        badge: 'icon-192.png',
        data: { url: data.url || './' },
      });
      // Let open app windows refresh their list of reports
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      windows.forEach((w) => w.postMessage({ type: 'flag-report' }));
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || './', self.registration.scope).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const w of windows) {
        if ('focus' in w) {
          await w.focus();
          w.postMessage({ type: 'open-url', url });
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
