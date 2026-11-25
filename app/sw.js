const CACHE = 'ripple-136';
const SHELL = [
  './', './index.html', './manifest.webmanifest',
  './css/base.css', './css/layouts.css', './css/components.css', './css/responsive.css',
  /*
   * 顺序与 index.html 里 <script src> 的出现顺序一致 —— 不是为了加载语义
   * （预缓存不分先后），而是为了让「对着 index.html 逐行核对 SHELL」这件事
   * 做得到：两份清单只要顺序一致，肉眼 diff 就能发现漏项。
   *
   * './js/lyricfill.js' 曾经漏在这里：它是卡拉OK 逐字染色模块，index.html 里
   * 一直加载着，但 1.3.3 加它时只改了 index.html。漏项的后果不是「少个功能」
   * 而是离线首开时这个脚本拿到 504、window.LyricFill 为 null，而 app.js 里
   * 有一条没做空值守卫的调用会在播放时每 100ms 抛一次 TypeError。
   */
  './js/version.js', './js/perf.js', './js/log.js', './js/lrc.js', './js/lyricfill.js',
  './js/netease.js',
  './js/store.js', './js/player.js', './js/qrcode.js',
  /* 多语言（1.3.5）：语言包必须预缓存，否则离线首开只有中文。
     加新语言时这两行旁边要再补一条 lang/<code>.js。 */
  './js/i18n.js', './js/lang/en.js',
  './js/app.js',
  /* 示例音频 / 封面已从项目中移除（7 个文件约 5.4 MB），代码里从不引用它们 */
  './assets/icons/icon-192.png', './assets/icons/icon-512.png', './assets/icons/icon-180.png'
];

/*
 * 预缓存逐个 add，不用 caches.addAll(SHELL)。
 *
 * addAll 是「全有全无」：SHELL 里任何一个 URL 404 / 断网，整个 install 就
 * reject，Service Worker 装不上 —— 离线能力**完全**没有，而不是少了那一个
 * 文件。而 SHELL 是一份需要人工维护的清单，迟早会有一项变 404（改名、删
 * 资源、新增语言包时手滑）。用 addAll 等于把「清单里某一项错了」放大成
 * 「离线全废」。
 *
 * 逐个 add + 每项 catch，把失败降级成「这个文件没进缓存」：其它资源照常
 * 预缓存，SW 照常装上，缺的那项在联网后用网络优先路径自动补进缓存。
 * 但失败不能静默 —— 全部完成后把失败清单打出来，这样「清单漏项/路径错」
 * 仍然在控制台可见，只是不再摧毁整个离线能力。
 */
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => c.add(u).then(
      () => null,
      (err) => u
    )))).then((failed) => {
      const bad = failed.filter(Boolean);
      if (bad.length) {
        console.warn('[sw] 预缓存失败 ' + bad.length + ' 项（其余已缓存）：', bad);
      }
      return self.skipWaiting();
    })
  );
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

  /*
   * 令牌脚本：**完全不接管**（既不缓存，也不做离线回落）。
   *
   * /ripple-token.js 由 server.js 下发，响应带 Cache-Control: no-store ——
   * 它是会轮换的短期令牌，服务端每 IP 保留 6 个（新 + 5 旧，见 server.js 的 TOKEN_PER_IP），刷新页面就换一个。
   * 但 SW 的 Cache.put 不看 HTTP 缓存语义，照存不误，于是：
   *   · 弱网 / server.js 重启窗口里 fetch 失败 → 回落缓存里的**旧令牌脚本**
   *     → 令牌早已被轮换出窗口 → 所有 /ncm/* 成片 401；
   *   · 离线首开更糟：token 脚本不在 SHELL 预缓存里，caches.match 无命中，
   *     于是回落到下方那句 ./index.html 兜底 —— 令牌脚本拿到一份 HTML 文本，
   *     window.RIPPLE_TOKEN 是 undefined，同样成片 401，而且现象上完全
   *     看不出「离线」还是「令牌坏了」。
   * 所以这里直接放行、不 respondWith：请求按网络语义走，失败就失败，
   * 由 index.html 的 onerror 与上层的 401 文案去解释。绝不缓存。
   */
  if (url.pathname === '/ripple-token.js') return;

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
      }).catch(() => caches.match(req).then((hit) => {
        if (hit) return hit;
        /*
         * 离线兜底只给文档用：回落到入口 HTML，至少能打开壳。
         *
         * 代码类请求（js/css/webmanifest/json）**不能**回落到 index.html ——
         * HTML 对 JS/CSS 加载器是纯毒药：脚本拿到一段 HTML 文本会在解析阶段
         * 直接报语法错，样式表拿到 HTML 会被整份丢弃，而控制台里的错误
         * 完全指不出「离线且没缓存」这个真实原因。这类资源「要么给真身、
         * 要么明确失败」，统一回 504，和下面音频/图片的处理保持一致。
         */
        if (isDoc) return caches.match('./index.html');
        return new Response('', { status: 504, statusText: 'Offline' });
      }))
    );
    return;
  }

  /*
   * 音频 / 图片：缓存优先。
   *
   * 离线且缓存里也没有时**不要**回退 index.html —— 以前这里写的是
   * `.catch(() => caches.match('./index.html'))`，结果是 <audio>/<img>
   * 拿到一份 HTML 文本：媒体解码立刻失败，控制台只剩一句莫名的
   * 「不支持该格式」，从现象上完全看不出真实原因是「离线且没缓存」。
   * 音频和图片都属于「要么给真身、要么明确失败」的资源，统一回 504，
   * 让上层把失败按网络错误处理。
   */
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => new Response('', { status: 504, statusText: 'Offline' })))
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window' }).then((list) => {
    for (const c of list) { if ('focus' in c) return c.focus(); }
    return clients.openWindow('./');
  }));
});
