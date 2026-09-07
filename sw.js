// 每日养分 Service Worker：静态资源缓存，支持离线打开与添加到桌面
const CACHE = 'daily-nutrients-v2';
const ASSETS = ['/', '/index.html', '/styles.css', '/app.js', '/heat-core.js', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  // 网络优先，失败回退缓存（保证新闻/数据实时，静态资源可离线）
  e.respondWith(
    fetch(request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(request, copy));
        return res;
      })
      .catch(() => caches.match(request).then((m) => m || caches.match('/index.html')))
  );
});
