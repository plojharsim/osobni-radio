// Minimální service worker: nic nekešuje ani nepřesměrovává, slouží jen k tomu, aby šla aplikace nainstalovat (Chrome, Firefox pro Android).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
