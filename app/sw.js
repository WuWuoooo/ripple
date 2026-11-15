const CACHE = 'ripple-v19';
const SHELL = [
  './', './index.html', './manifest.webmanifest',
  './css/base.css', './css/layouts.css', './css/components.css',
  './js/version.js', './js/log.js', './js/lrc.js', './js/netease.js', './js/store.js', './js/player.js', './js/app.js',
  /* 示例音频 / 封面已从项目中移除（7 个文件约 5.4 MB），代码里从不引用它们 */
  './assets/icons/icon-192.png', './assets/icons/icon-512.png', './assets/icons/icon-180.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

/* 收到 SKIP_WAITING 就立刻接管，不用等所有页面关掉（新版代码能马上生效） */
self.addEventListener('message', (e) => {
  if (e.data === 'SKIP_WAITING') { self.skipWaiting(); }
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // 音频：range 请求交给网络，避免缓存破坏拖动
  if (req.headers.get('range')) return;

  const isDoc = req.mode === 'navigate' || url.pathname.endsWith('.html');
  // code 一律网络优先：改完前端立刻生效，不会因为 SW 缓存跑旧代码
  const isCode = /\.(js|css|webmanifest|json)$/.test(url.pathname);

  // 文档与代码：网络优先，离线回落缓存
  if (isDoc || isCode) {
    e.respondWith(
      fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
    );
    return;
  }

  // 音频 / 图片：缓存优先
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match('./index.html')))
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window' }).then((list) => {
    for (const c of list) { if ('focus' in c) return c.focus(); }
    return clients.openWindow('./');
  }));
});
