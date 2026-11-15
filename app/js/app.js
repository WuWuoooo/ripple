/* ============================================================
   Ripple · app.js  (v1.1)
   · 单套观感：液态玻璃
   · 在线内容全部来自真网易云接口（Netease.call → weapi）
   ============================================================ */
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const S = () => Store.state.settings;

  const App = {
    page: 'home',
    context: [],          // 当前播放上下文
    scope: 'online',
    filter: 'all',
    onlineResults: null,
    onlinePlaylists: null,
    _paletteSeq: 0,
    _dailyCache: null,
    _dailyAt: 0,
    _topCache: null,
    _plCache: new Map(),   // plId -> 歌单详情
  };

  /* ================= 启动 ================= */
  async function boot() {
    Log.add('BOOT', 'start, mode=' + Netease.mode + ' native=' + !!window.RippleNative);
    Store.load();
    applyTheme();
    applyVars();
    Player.init();
    Player.setVolume(S().volume);
    applyEQFromSettings();
    Player.setRate(S().speed);
    Player.setNormalize(S().normalize);
    Player.setGapless(S().gapless);
    if (S().apiBase) Netease.setBase(S().apiBase);

    await Store.restoreLocal();
    App.context = Store.all().slice();
    bindEvents();
    bindPlayer();
    renderAll();
    /*
     * restoreLast 里可能会为在线曲目串行试好几档音质（每档最长 22s，最多 5 次）。
     * 以前用 await 挡在 boot 里：界面和 toast 全被推迟，最坏十几秒才刷新。
     * 现在是「先让界面正常起来，续播在后台补上」。
     */
    restoreLast().catch((e) => Log.err('RESTORE', e, 'restoreLast failed'));

    /* safeMode 会静默关掉 edge-to-edge 与 cookie —— 用户看不到任何原因，这里明说 */
    try {
      const N = window.RippleNative;
      if (N && typeof N.safeMode === 'function' && N.safeMode()) {
        toast('已进入安全模式', '上次启动异常，本次关闭全屏铺边；连续正常启动后会恢复', 'warn');
        Log.add('BOOT', 'safeMode is ON');
      }
    } catch (e) {}

    const d = new Date();
    $('#helloDate').textContent =
      d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0') +
      ' · 星期' + '日一二三四五六'[d.getDay()];
    $('#helloTitle').textContent = greet() + '，欢迎回来';

    syncConnectionUI();
    refreshSystemBars();
    Log.add('BOOT', 'ready, logPath=' + Log.path());
    setTimeout(refreshSystemBars, 400);
    setTimeout(() => {
      toast('Ripple 已就绪', Netease.ready ? '真网易云接口 · 可登录你的账号' : '在线功能不可用', 'info');
    }, 900);
    registerSW();
    setInterval(() => {
      Player.updatePositionState();
      updateTimes();
      rememberProgress(false);
      if (Player.track) pushMediaState(false);   // 通知栏进度条
      pushSbProgress();                          // 状态栏歌词的填充进度
    }, 1000);

    // 启动后异步拉在线内容（失败不打扰）
    refreshAccount().then(() => {
      loadHomeOnline();
    }).catch(() => loadHomeOnline());
  }

  /* ================= 主题 ================= */
  function greet() {
    const h = new Date().getHours();
    if (h < 5) return '夜深了';
    if (h < 11) return '早上好';
    if (h < 14) return '中午好';
    if (h < 18) return '下午好';
    return '晚上好';
  }

  /* 原生在系统深色/浅色切换时回调这里 */
  window.__rippleSystemTheme = function () {
    if (S().theme !== 'auto') return;
    applyTheme();
    if (Player.track) paletteFor(Player.track);
    Log.add('THEME', 'system theme changed -> ' + resolvedTheme());
  };

  /**
   * 解析出实际使用的主题。
   *
   * auto 模式下**不能**只看 prefers-color-scheme：
   * WebView 里这个媒体查询跟随的是 App 自己的 uiMode，
   * 而 Ripple 的 Activity 主题是 Theme.Material（深色基座），
   * 所以它一律返回 dark —— 手机明明没开深色模式，「自动」也会变深色。
   * 原生侧用 systemDark() 读真正的系统开关，取不到时才退回媒体查询。
   */
  function systemPrefersDark() {
    const N = window.RippleNative;
    if (N && typeof N.systemDark === 'function') {
      try { return !!N.systemDark(); } catch (e) { /* 落到媒体查询 */ }
    }
    return !matchMedia('(prefers-color-scheme: light)').matches;
  }

  function resolvedTheme() {
    if (S().theme === 'auto') return systemPrefersDark() ? 'dark' : 'light';
    return S().theme;
  }

  function applyTheme() {
    const theme = resolvedTheme();
    document.documentElement.dataset.theme = theme;
    const bg = theme === 'light' ? '#F1EEEA' : '#07070B';
    const meta = $('meta[name="theme-color"]');
    if (meta) meta.content = bg;
    syncSystemBars(bg, theme === 'light');
    $('#btnTheme').innerHTML = resolvedTheme() === 'light'
      ? '<svg><use href="#i-moon"/></svg>' : '<svg><use href="#i-sun"/></svg>';
    $$('#themeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.theme === S().theme));
  }

  /** 把窗口背景色同步给原生状态栏（否则顶上会是一条纯黑） */
  function syncSystemBars(bg, lightTheme) {
    const N = window.RippleNative;
    if (!N || typeof N.systemBars !== 'function') {
      Log.add('BARS', 'no native bridge, skip ' + bg);
      return;
    }
    try {
      N.systemBars(bg, bg, !!lightTheme);
      Log.add('BARS', 'send ' + bg + ' light=' + !!lightTheme);
    } catch (e) {
      Log.err('BARS', e, 'systemBars failed');
    }
  }

  /** 取一个「和页面观感一致」的颜色给状态栏用 */
  function currentBarColor() {
    const theme = resolvedTheme();
    const cs = getComputedStyle(document.documentElement);
    if (theme === 'light') {
      // 浅色主题：直接用页面的 --bg（比写死一个值更准）
      const bg = cs.getPropertyValue('--bg').trim();
      const rgb = cssColorToRgb(bg);
      if (rgb) {
        return '#' + rgb.map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');
      }
      return '#F1EEEA';
    }
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    // 取色后把主色压暗，接近页面顶部那种暗调，不至于太跳
    const rgb = cssColorToRgb(accent);
    if (!rgb) return '#07070B';
    // 压到 35% 左右：既保留封面主色调，又不会在浅色封面上刺眼
    const mix = (v, d) => Math.round(v * 0.34 + d * 0.66);
    return '#' + [mix(rgb[0], 7), mix(rgb[1], 7), mix(rgb[2], 11)]
      .map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');
  }

  function cssColorToRgb(c) {
    if (!c) return null;
    if (c.startsWith('#')) {
      const h = c.slice(1);
      if (h.length === 3) {
        return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)];
      }
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
    const m = c.match(/hsla?\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%/i);
    if (m) return hsl2rgb(+m[1], +m[2], +m[3]);
    const r = c.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (r) return [+r[1], +r[2], +r[3]];
    return null;
  }

  /** 页面/取色变化后刷新状态栏 */
  function refreshSystemBars() {
    syncSystemBars(currentBarColor(), resolvedTheme() === 'light');
  }

  /** 按设置里的 eq / eqCustom 真正下发到音频图 */
  function applyEQFromSettings() {
    const s = S();
    if (s.eq === 'custom' && Array.isArray(s.eqCustom)) {
      Player.setEQBands(s.eqCustom);
    } else {
      Player.setEQ(s.eq);
    }
  }

  function applyVars() {
    const r = document.documentElement.style;
    const k = Math.max(0.4, Math.min(2.5, Number(S().animSpeed) || 1));
    r.setProperty('--glass-blur', S().glassBlur + 'px');
    r.setProperty('--anim', k);
    /* 动画速度拆成三档时长，CSS 里按用途取用：
       --dur    普通过渡（背景、颜色、悬停）
       --dur-s  快档（按钮按压、图标）
       --dur-l  慢档（面板滑出、播放页推入）
       总时长 = 基准 / 速度倍率，1.0 时与原来手写的数值一致。 */
    r.setProperty('--dur', (0.42 / k).toFixed(2) + 's');
    r.setProperty('--dur-s', (0.22 / k).toFixed(2) + 's');
    r.setProperty('--dur-l', (0.52 / k).toFixed(2) + 's');
    r.setProperty('--lyric-size', S().lyricSize + 'px');
  }

  /* ================= 取色 ================= */
  function rgb2hsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0; const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return [Math.round(h), Math.round(s * 100), Math.round(l * 100)];
  }

  function hashHue(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
    return h;
  }

  function hashCover(str) {
    const h1 = hashHue(str), h2 = (h1 + 48) % 360;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${h1},58%,44%)"/><stop offset=".6" stop-color="hsl(${h2},62%,38%)"/>
      <stop offset="1" stop-color="hsl(${(h1 + 300) % 360},50%,16%)"/></linearGradient></defs>
      <rect width="400" height="400" fill="url(#g)"/>
      <circle cx="290" cy="300" r="130" fill="none" stroke="rgba(255,255,255,.25)"/>
      <circle cx="290" cy="300" r="180" fill="none" stroke="rgba(255,255,255,.14)"/>
      <circle cx="290" cy="300" r="60" fill="rgba(255,255,255,.10)"/>
      </svg>`;
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  function coverOf(t) {
    if (!t) return hashCover('ripple');
    if (t.cover) return t.cover;
    return hashCover(t.title + t.artist);
  }

  function applyPaletteFrom(rgb) {
    const theme = resolvedTheme();
    let [h, s, l] = rgb2hsl(rgb[0], rgb[1], rgb[2]);
    s = Math.max(42, Math.min(88, s + 18));
    l = theme === 'dark' ? Math.max(56, Math.min(72, l + 12)) : Math.max(34, Math.min(50, l - 6));
    const root = document.documentElement.style;
    root.setProperty('--accent', `hsl(${h},${s}%,${l}%)`);
    root.setProperty('--accent2', `hsl(${(h + 42) % 360},${Math.max(40, s - 10)}%,${Math.min(70, l + 4)}%)`);
    root.setProperty('--accent3', `hsl(${(h + 320) % 360},${Math.max(38, s - 12)}%,${Math.min(66, l)}%)`);
    root.setProperty('--accent-soft', `hsla(${h},${s}%,${l}%,.17)`);
    root.setProperty('--accent-ink', l > 62 ? '#120a24' : '#ffffff');
    refreshSystemBars();
  }

  function paletteFor(track) {
    if (!S().dynamicColor) {
      const root = document.documentElement.style;
      const theme = resolvedTheme();
      const l = theme === 'dark' ? 68 : 42;
      const h = 258;
      root.setProperty('--accent', `hsl(${h},70%,${l}%)`);
      root.setProperty('--accent-soft', `hsla(${h},70%,${l}%,.16)`);
      root.setProperty('--accent2', `hsl(${(h + 40) % 360},66%,${l}%)`);
      root.setProperty('--accent3', `hsl(${(h + 320) % 360},60%,${l}%)`);
      root.setProperty('--accent-ink', theme === 'dark' ? '#120a24' : '#fff');
      refreshSystemBars();
      return;
    }
    const seq = ++App._paletteSeq;
    const src = coverOf(track);
    const img = new Image();
    /*
     * 取色要读画布像素，所以必须 crossOrigin。
     * 网易云图片 CDN（p*.music.126.net）确实会返回 Access-Control-Allow-Origin: *，
     * 因此 crossOrigin 能正常工作；万一某个来源没有 CORS 头，
     * onerror / SecurityError 都会退到 hashHue 兜底，不会卡住。
     */
    img.crossOrigin = 'anonymous';
    img.referrerPolicy = 'no-referrer';
    img.onload = () => {
      if (seq !== App._paletteSeq) return;
      try {
        const c = document.createElement('canvas');
        c.width = c.height = 20;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, 20, 20);
        const d = ctx.getImageData(0, 0, 20, 20).data;
        let r = 0, g = 0, b = 0, n = 0;
        for (let i = 0; i < d.length; i += 4) {
          const mx = Math.max(d[i], d[i + 1], d[i + 2]);
          const mn = Math.min(d[i], d[i + 1], d[i + 2]);
          if (mx - mn < 8 && mx < 40) continue;
          r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
        }
        if (n) applyPaletteFrom([r / n, g / n, b / n]);
        else throw new Error('mono');
      } catch (e) {
        applyPaletteFrom(hsl2rgb(hashHue((track && track.title || '') + (track && track.artist || '')), 62, 45));
      }
    };
    img.onerror = () => {
      if (seq !== App._paletteSeq) return;
      applyPaletteFrom(hsl2rgb(hashHue((track && track.title || '') + (track && track.artist || '')), 62, 45));
    };
    img.src = src;
  }

  function hsl2rgb(h, s, l) {
    s /= 100; l /= 100;
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
  }

  /* ================= 渲染工具 ================= */
  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return m + ':' + String(s).padStart(2, '0');
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function artHTML(t, cls) {
    return `<div class="${cls} art"><img src="${coverOf(t)}" alt="" loading="lazy"><div class="ripple"></div></div>`;
  }

  function rowHTML(t, i, isOn) {
    const fmt = t.vip ? 'VIP' : (t.format || '');
    const cls = /Hi-Res|FLAC|ALAC|DSD/i.test(fmt) ? ' hi' : (t.vip ? ' vip' : '');
    return `<div class="row${isOn ? ' on' : ''}" data-id="${esc(t.id)}">
      <div class="r-idx">${isOn ? '<div class="eq"><i></i><i></i><i></i><i></i></div>' : String(i + 1).padStart(2, '0')}</div>
      <div class="body">
        ${artHTML(t, 'r-th')}
        <div class="r-tx"><b>${esc(t.title)}</b><span>${esc(t.artist)}${t.album ? ' · ' + esc(t.album) : ''}</span></div>
      </div>
      <div class="r-al">${esc(t.album || '')}</div>
      <div class="r-fmt${cls}">${esc(fmt || 'AUDIO')}</div>
      <div class="r-du">${fmtTime(t.duration)}</div>
    </div>`;
  }

  function gridHTML(t, isOn) {
    return `<div class="gcard${isOn ? ' on' : ''}" data-id="${esc(t.id)}">
      ${artHTML(t, 'th')}
      <b>${esc(t.title)}</b><span>${esc(t.artist)}</span>
    </div>`;
  }

  function carouselHTML(items) {
    return items.map((it) => `<div class="c-card" data-pl="${it.plId || ''}" data-id="${it.id || ''}">
      ${artHTML(it, 'c-art')}
      <div class="c-k">${esc(it.kind || '歌单')}</div>
      <div class="c-tx"><b>${esc(it.title)}</b><span>${esc(it.sub || '')}</span></div>
      <div class="c-play"><svg width="12" height="12"><use href="#i-play"/></svg></div>
    </div>`).join('');
  }

  function plRowHTML(p) {
    return `<div class="plrow" data-pl="${p.plId}">
      ${artHTML(p, 'th')}
      <div class="tx"><b>${esc(p.title)}</b><span>${esc(p.sub || '')}${p.creator ? ' · ' + esc(p.creator) : ''}</span></div>
      <div class="go"><svg><use href="#i-chev-right"/></svg></div>
    </div>`;
  }

  function renderAll() {
    renderHome();
    renderLibrary();
    renderSearchDefaults();
    syncSettingsUI();
    updateDock();
    renderNP();
    const mb = (Store.localTracks.reduce((a, t) => a + (t.size || 0), 0) / 1048576).toFixed(1);
    $('#storageHint').textContent = Store.localTracks.length + ' 首 · ' + mb + ' MB';
    updateAccountCard();
  }

  /* ================= 首页 ================= */
  function renderHome() {
    const cur = Player.track;
    const rec = Store.recent(6);
    const list = (rec.length ? rec : Store.all()).slice(0, 6);
    const hero = (App._dailyCache && App._dailyCache[0]) || list[0];

    $('#heroArt').src = coverOf(hero);
    /*
     * 首页大标题以前写死「深夜的低频」，早上打开也是「深夜」，很出戏。
     * 现在按时段给一句话，并且���日的歌有真实标题时优先用它。
     */
    const heroHour = new Date().getHours();
    const HERO_LINES = [
      [5, '天快亮了，<br>再来最后一首'],
      [9, '早晨的第一首，<br>慢慢醒过来'],
      [12, '中午的间隙，<br>听点轻的'],
      [14, '下午的光正好，<br>配一点低频'],
      [18, '傍晚了，<br>让耳朵先回家'],
      [22, '夜色上来，<br>和一点失真的暖意'],
      [24, '深夜的低频，<br>和一点失真的暖意'],
    ];
    const heroLine = (HERO_LINES.find(([h]) => heroHour < h) || HERO_LINES[HERO_LINES.length - 1])[1];
    $('#heroTitle').innerHTML = heroLine;
    $('#heroKicker').textContent = Netease.loggedIn ? 'DAILY MIX' : '今日推荐';
    const h = new Date();
    $('#heroSub').textContent = App._dailyCache && App._dailyCache.length
      ? `${h.getMonth() + 1} 月 ${h.getDate()} 日 · ${App._dailyCache.length} 首 · 来自你的口味`
      : '根据你最近的播放生成';

    $('#gridView').innerHTML = list.map((t) => gridHTML(t, cur && cur.id === t.id)).join('');
    /*
     * #listView 在 layouts.css 里是 display:none（首页只保留网格），
     * 以前仍然每帧把整份列表 DOM 也渲染一遍 —— 纯属浪费。
     * 只有它真的可见时才渲染。
     */
    const lv = $('#listView');
    if (lv && getComputedStyle(lv).display !== 'none') {
      lv.innerHTML = list.map((t, i) => rowHTML(t, i, cur && cur.id === t.id)).join('');
    }
  }

  /** 拉在线首页内容：每日推荐 + 排行榜 */
  async function loadHomeOnline() {
    if (!Netease.ready) {
      renderCarousel([], '在线功能不可用');
      $('#toplistCarousel').innerHTML = '<div class="c-card ghost">填好接口后再来</div>';
      return;
    }
    // 每日推荐（10 分钟缓存，避免每次切页都打接口）
    if (!App._dailyCache || Date.now() - App._dailyAt > 600000) {
      try {
        const songs = await Netease.dailyRecommend();
        if (songs.length) {
          App._dailyCache = songs;
          App._dailyAt = Date.now();
          $('#dailyTitle').textContent = Netease.loggedIn ? '每日推荐' : '今日推荐';
          renderCarousel(songs.slice(0, 10).map((t) => ({
            id: t.id, title: t.title, sub: t.artist, cover: t.cover, kind: '推荐',
          })), '暂无推荐');
        }
      } catch (e) {
        renderCarousel([], e.needLogin ? '登录后可见每日推荐' : '推荐加载失败');
      }
    } else if (App._dailyCache.length) {
      renderCarousel(App._dailyCache.slice(0, 10).map((t) => ({
        id: t.id, title: t.title, sub: t.artist, cover: t.cover, kind: '推荐',
      })), '暂无推荐');
    }

    // 排行榜 / 推荐歌单
    if (!App._topCache) {
      try {
        let pls = await Netease.toplist();
        if (!pls.length) pls = await Netease.personalizedPlaylists(8);
        App._topCache = pls;
      } catch (e) {
        App._topCache = [];
      }
    }
    $('#toplistCarousel').innerHTML = App._topCache && App._topCache.length
      ? carouselHTML(App._topCache)
      : '<div class="c-card ghost">榜单加载失败<br>下拉重试</div>';
  }

  function renderCarousel(items, emptyText) {
    $('#carousel').innerHTML = items.length
      ? carouselHTML(items)
      : `<div class="c-card ghost">${esc(emptyText || '暂无内容')}</div>`;
  }

  function libFiltered() {
    let list = Store.all();
    if (App.filter === 'local') list = list.filter((t) => t.source === 'local');
    else if (App.filter === 'lossless') list = list.filter((t) => /FLAC|Hi-Res|ALAC|DSD/i.test(t.format || ''));
    else if (App.filter === 'online') list = list.filter((t) => t.source === 'online');
    return list;
  }

  function renderLibrary() {
    const list = libFiltered();
    const cur = Player.track;
    const seg = App._libSeg || 'songs';
    if (seg !== 'songs') {
      renderLibGrouped(list, seg, cur);
      return;
    }
    $('#libList').innerHTML = list.length
      ? list.map((t, i) => rowHTML(t, i, cur && cur.id === t.id)).join('')
      : `<div class="empty"><b>这里还没有音乐</b><p>点下面「从手机导入音乐」，或在搜索页搜网易云</p></div>`;
    $('#libCount').textContent = list.length + ' 首';
  }

  /**
   * 专辑 / 艺人 / 下载 三个分组视图。
   * 分组本身不需要额外数据，全从已经并入库的曲目里聚合出来。
   */
  function renderLibGrouped(list, seg, cur) {
    if (seg === 'albums') {
      const map = new Map();
      list.forEach((t) => {
        const k = (t.album || '未知专辑') + '\u0000' + (t.artist || '');
        if (!map.has(k)) map.set(k, { album: t.album || '未知专辑', artist: t.artist || '未知', n: 0, first: t });
        const e = map.get(k); e.n++;
      });
      const rows = [...map.values()];
      $('#libList').innerHTML = rows.length
        ? rows.map((e) => `<div class="row" data-album="${esc(e.album)}">
            <div class="r-th art"><img src="${esc(coverOf(e.first))}" alt="" loading="lazy"></div>
            <div class="r-tx"><b>${esc(e.album)}</b><span>${esc(e.artist)} · ${e.n} 首</span></div>
          </div>`).join('')
        : `<div class="empty"><b>还没有专辑</b><p>导入本地音乐或播放网易云曲目后会出现在这里</p></div>`;
      $('#libCount').textContent = rows.length + ' 张专辑';
      return;
    }
    if (seg === 'artists') {
      const map = new Map();
      list.forEach((t) => {
        const k = t.artist || '未知艺人';
        if (!map.has(k)) map.set(k, { artist: k, n: 0, first: t });
        map.get(k).n++;
      });
      const rows = [...map.values()];
      $('#libList').innerHTML = rows.length
        ? rows.map((e) => `<div class="row" data-artist="${esc(e.artist)}">
            <div class="r-th art"><img src="${esc(coverOf(e.first))}" alt="" loading="lazy"></div>
            <div class="r-tx"><b>${esc(e.artist)}</b><span>${e.n} 首</span></div>
          </div>`).join('')
        : `<div class="empty"><b>还没有艺人</b><p>导入本地音乐或播放网易云曲目后会出现在这里</p></div>`;
      $('#libCount').textContent = rows.length + ' 位艺人';
      return;
    }
    // downloads：只有确实是本机文件（有 blob）的才算「已下载到本机」
    const dl = list.filter((t) => t.source === 'local' && t._blob);
    $('#libList').innerHTML = dl.length
      ? dl.map((t, i) => rowHTML(t, i, cur && cur.id === t.id)).join('')
      : `<div class="empty"><b>本机还没有下载</b><p>「从手机导入音乐」保留的就是本机文件</p></div>`;
    $('#libCount').textContent = dl.length + ' 首本机文件';
  }

  /** 我的歌单（登录后拉网易云） */
  async function loadMyPlaylists() {
    const box = $('#myPlaylists');
    if (!Netease.loggedIn) {
      $('#myPlTitle').textContent = '我的歌单';
      $('#myPlHint').textContent = '登录后可见';
      box.innerHTML = `<div class="empty" style="padding:26px 10px">
        <b>还没有绑定网易云账号</b><p>在「我的」里登录，就能看到你的歌单与收藏</p></div>`;
      return;
    }
    if (App._myPl) {
      box.innerHTML = App._myPl.map(plRowHTML).join('');
      return;
    }
    box.innerHTML = `<div class="plrow"><div class="tx"><b>读取中…</b></div></div>`;
    try {
      const pls = await Netease.userPlaylists(100);
      App._myPl = pls;
      $('#myPlHint').textContent = pls.length + ' 个';
      box.innerHTML = pls.length ? pls.map(plRowHTML).join('')
        : `<div class="empty" style="padding:26px 10px"><b>没有歌单</b></div>`;
    } catch (e) {
      box.innerHTML = `<div class="empty" style="padding:26px 10px"><b>读取失败</b><p>${esc(e.message)}</p></div>`;
    }
  }

  function renderSearchDefaults() {
    $('#hotWords').innerHTML = ['周杰伦', '草东没有派对', 'City Pop', '陈粒', 'Lofi', '钢琴']
      .map((w) => `<button class="chip" data-hot="${w}">${w}</button>`).join('');
    $('#recList').innerHTML = Store.all().slice(0, 4).map((t, i) => rowHTML(t, i, false)).join('');
  }

  /* ================= 账号 ================= */
  async function refreshAccount() {
    if (!Netease.ready) { updateAccountCard(); return null; }
    try {
      const p = await Netease.status();
      updateAccountCard();
      return p;
    } catch (e) {
      updateAccountCard();
      return null;
    }
  }

  function updateAccountCard() {
    const p = Netease.profile;
    const card = $('#acctCard');
    if (!card) return;
    const ava = $('#acctAva');
    if (p && p.avatar) {
      ava.src = p.avatar;
      ava.hidden = false;
    } else {
      ava.hidden = true;
    }
    $('#acctName').innerHTML = p
      ? esc(p.nickname) + (p.vip ? `<span class="badge">黑胶 VIP${p.vipLevel ? ' V' + p.vipLevel : ''}</span>` : '')
      : '未登录网易云';
    $('#acctSub').textContent = p
      ? (p.signature || ('Lv.' + (p.level || 0) + ' · 已连接网易云账号'))
      : '登录后可听会员曲目、同步我喜欢与每日推荐';
    $('#statSongs').textContent = Math.round(Store.state.playedSec / 60);
    $('#statLikes').textContent = Store.state.liked.filter((id) => String(id).startsWith('ne_')).length
      || (p && p.likeIds ? p.likeIds.length : 0);
    $('#statPl').textContent = App._myPl ? App._myPl.length : (p ? '—' : 0);

    const btns = $('#acctBtns');
    if (p) {
      btns.innerHTML = '<button class="btn ghost" id="btnReload">刷新资料</button>'
        + '<button class="btn ghost" id="btnLogout">退出</button>';
      $('#btnReload').onclick = async () => {
        App._myPl = null;
        await refreshAccount();
        loadMyPlaylists();
        loadHomeOnline();
        // status() 失败时 Netease.profile 是 null，直接取 .nickname 会抛 TypeError
        toast('已刷新', (Netease.profile && Netease.profile.nickname) || '已重新拉取账号信息', 'check');
      };
      $('#btnLogout').onclick = doLogout;
      $('#rowLogout').hidden = false;
    } else {
      btns.innerHTML = '<button class="btn solid" id="btnLogin">登录网易云</button>';
      $('#btnLogin').onclick = chooseLoginMode;
      $('#rowLogout').hidden = true;
    }
  }

  /* 登录：先选方式（手机号 / 扫码），再打开官方页面 */
  function chooseLoginMode() {
    if (!Netease.ready) return toast('在线功能不可用', '请先确认网络', 'warn');
    if (Netease.mode !== 'native') {
      return toast('浏览器里无法内嵌登录', '请用 APK 登录，或把 MUSIC_U 写进 .ripple-cookie', 'warn');
    }
    modal(`
      <h3>登录网易云</h3>
      <p style="margin-bottom:14px">选择登录方式，会打开网易云官方页面完成验证。</p>
      <button class="login-opt" data-mode="phone">
        <div class="ic"><svg><use href="#i-user"/></svg></div>
        <div class="tx"><b>手机号登录</b><span>短信验证码 / 密码，官方页面内完成</span></div>
        <div class="go"><svg><use href="#i-chev-right"/></svg></div>
      </button>
      <button class="login-opt" data-mode="qr">
        <div class="ic"><svg><use href="#i-qr"/></svg></div>
        <div class="tx"><b>扫码登录</b><span>用网易云 App 扫一扫，登录最快</span></div>
        <div class="go"><svg><use href="#i-chev-right"/></svg></div>
      </button>
      <div class="modal-btns"><button class="btn ghost" data-cancel>取消</button></div>
    `, {
      onMount: (wrap, close) => {
        wrap.querySelectorAll('[data-mode]').forEach((b) => {
          b.addEventListener('click', () => {
            const mode = b.dataset.mode;
            close(true);
            doLogin(mode);
          });
        });
      },
    });
  }

  async function doLogin(mode) {
    if (!Netease.ready) return toast('在线功能不可用', '请先确认网络', 'warn');
    if (Netease.mode !== 'native') {
      return toast('浏览器里无法内嵌登录', '请用 APK 登录，或把 MUSIC_U 写进 .ripple-cookie', 'warn');
    }
    Log.add('LOGIN', 'open page mode=' + mode);
    toast(mode === 'qr' ? '已打开扫码登录' : '已打开登录页',
      '在官方页面完成验证，成功后自动返回', 'cloud');
    try {
      const p = await Netease.login(mode);
      Log.add('LOGIN', 'success ' + (p && p.nickname));
      App._myPl = null;
      App._dailyCache = null;
      App._topCache = null;
      updateAccountCard();
      loadHomeOnline();
      loadMyPlaylists();
      toast('登录成功', p.nickname + (p.vip ? ' · 黑胶 VIP' : ''), 'check');
      if (S().syncLikes) syncLikes();
    } catch (e) {
      Log.err('LOGIN', e, mode);
      toast('登录未完成', e.message, 'warn');
    }
  }

  async function doLogout() {
    await Netease.logout();
    App._myPl = null;
    App._dailyCache = null;
    App._topCache = null;
    Netease._profile = null;
    updateAccountCard();
    loadMyPlaylists();
    loadHomeOnline();
    toast('已退出网易云', '在线演奏仍可用（非会员曲目）', 'check');
  }

  async function syncLikes() {
    if (!Netease.loggedIn) return toast('需要先登录', '', 'warn');
    try {
      const ids = await Netease.likelist();
      const mapped = ids.map((id) => 'ne_' + id);
      const merged = Array.from(new Set(Store.state.liked.concat(mapped)));
      Store.state.liked = merged;
      Store.save();
      renderAll();
      toast('已同步我喜欢', ids.length + ' 首', 'heart');
    } catch (e) {
      toast('同步失败', e.message, 'warn');
    }
  }

  /* ================= 播放 ================= */
  let _resolvingId = null;

  function playTrack(track, context) {
    if (!track) return;
    let list = context && context.length ? context : Store.all();
    let i = list.findIndex((t) => t.id === track.id);
    if (i < 0) { list = [track]; i = 0; }
    /*
     * findTrack() 可能返回「另一份同一个 id 的对象」（onlineCache 里的那份），
     * 而 ctx 里放的是搜索结果里的那份。两份对象各自有 src 字段，
     * 解析结果写在 A 上，Player 却去播 B 的空 src —— 于是「解析成功但永远不播」。
     * 这里统一引用：ctx 里同 id 的位置直接换成 track 这一份。
     */
    if (list[i] !== track) list[i] = track;
    App.context = list;
    if (track.source === 'online') {
      // 已经在解析同一首就不用重复发起（Player.playAt 会回调回来）
      if (_resolvingId === track.id && !track.src) return;
      _resolvingId = track.id;
      playOnline(track, list, i).finally(() => {
        if (_resolvingId === track.id) _resolvingId = null;
      });
      return;
    }
    Player.playAt(list, i);
    Store.set('lastTrackId', track.id);
    Store.set('lastIndex', i);
  }

  async function playOnline(track, list, i) {
    Log.add('ONLINE', 'resolve ' + track.title + ' neId=' + track.neId + ' cached=' + !!track.src);
    try {
      if (!track.src) {
        toast('正在解析音源…', track.title, 'cloud');
        const lv = qualityLevel();
        let got = null;
        let lastErr = null;
        /*
         * 从设定音质往下退，最多退 2 档。
         * 一路退到 standard（最多 5 次串行）在连点时太伤：10 首歌 = 50 个请求，
         * 网易云很容易直接限流/返回 301。2 档足够覆盖「会员不够」的常见情况。
         */
        const floor = Math.max(0, lv - 2);
        for (let k = lv; k >= floor; k--) {
          try { got = await Netease.songUrl(track.neId, k); break; } catch (e) { lastErr = e; }
        }
        if (!got) throw lastErr || new Error('无法获取播放地址');
        Log.add('ONLINE', 'url ok level=' + got.level + ' br=' + got.br + ' trial=' + got.trial);
        track.src = got.url;
        track.format = (got.type || 'mp3').toUpperCase() + (got.br ? ' ' + Math.round(got.br / 1000) + 'k' : '');
        track.trial = got.trial;
        /* 双保险：ctx 里同 id 的另一份对象也写上 src，
           避免它被别处（队列/最近播放）拿去播时又是空地址 */
        const twin = (list || []).find((x) => x && x.id === track.id);
        if (twin && twin !== track) {
          twin.src = track.src;
          twin.format = track.format;
          twin.trial = track.trial;
        }
        if (got.trial) toast('只能试听片段', '该曲目需要会员或已购', 'warn');
      }
      await ensureLyric(track);
      if (!track.src) throw new Error('没有拿到播放地址');
      // 已经解析好了，直接播（这里不会再触发 defer）
      if (i >= 0) Player.playAt(list, i);
      else { Player.playAt([track], 0); }
      Store.set('lastTrackId', track.id);
      rememberOnline(track);
    } catch (e) {
      Log.err('ONLINE', e, (track && track.title) + ' neId=' + (track && track.neId));
      if (e.needLogin) {
        toast('这首歌需要登录', '在「我的」里登录网易云账号后再试', 'warn');
        openNP();
        return;
      }
      toast('这首歌放不了', e.message + '（Ripple 不会绕过版权限制）', 'warn');
    }
  }

  /** 记住在线曲目，退出后还能在「最近播放」里看到封面和标题 */
  function rememberOnline(track) {
    const arr = Store.state.onlineCache = Store.state.onlineCache || [];
    const rec = {
      id: track.id,
      source: 'online',          // 关键：恢复时靠它判断「需要重新解析音源」
      neId: track.neId, title: track.title, artist: track.artist,
      album: track.album, duration: track.duration, cover: track.cover,
      format: track.format || '', vip: !!track.vip,
      at: Date.now(),
    };
    const i = arr.findIndex((x) => x.id === track.id);
    if (i >= 0) arr.splice(i, 1);
    arr.unshift(rec);
    if (arr.length > 60) arr.length = 60;
    Store.save();
  }

  /**
   * 确保这首歌的歌词已加载（在线曲目）。
   *
   * 歌词不进 onlineCache（几千行 LRC 存 localStorage 太重），
   * 所以任何「让某首在线歌成为当前曲目」的路径都必须显式补一次，
   * 否则会出现「重启后歌能放但没歌词，切一下才有」。
   * 已加载过（track.lyric 是数组）就直接返回，不重复请求。
   */
  async function ensureLyric(track) {
    if (!track) return [];
    if (Array.isArray(track.lyric)) return track.lyric;
    if (track.source !== 'online' && !/^ne_/.test(track.id)) return [];
    if (!track.neId) return [];
    try {
      const ly = await Netease.lyric(track.neId);
      track.lyric = LRC.merge(LRC.parse(ly.lrc), LRC.parse(ly.tlrc));
      Log.add('LYRIC', 'loaded ' + track.title + ' lines=' + track.lyric.length);
    } catch (e) {
      track.lyric = [];      // 失败也记成空数组，避免反复重试
      Log.err('LYRIC', e, (track && track.title) + ' neId=' + (track && track.neId));
    }
    // 如果这首歌现在正播着，立刻刷新界面
    if (Player.track && Player.track.id === track.id) {
      renderLyric();
      syncLyric(true);
    }
    return track.lyric;
  }

  function qualityLevel() {
    return { standard: 0, higher: 1, exhigh: 2, lossless: 3, hires: 4 }[S().quality] ?? 2;
  }

  function bindPlayer() {
    Player.on('track', (t) => {
      if (t) { S().lastPosition = 0; rememberProgress(true); }
      paletteFor(t);
      updateDock();
      renderNP();
      renderHome();
      renderLibrary();
      $('#npBg').style.backgroundImage = `url("${coverOf(t)}")`;
      $('#npCover img').style.opacity = 1;
      /*
       * 兜底：任何途径让一首在线歌成为当前曲目，只要它还没歌词就补一次。
       * ensureLyric 内部有「已经是数组就不请求」的短路，
       * 所以正常切歌路径（playOnline 已拉过）不会产生额外请求。
       */
      if (t && !Array.isArray(t.lyric)) ensureLyric(t).catch(() => {});
    });
    Player.on('state', (playing) => {
      // 告诉原生「现在在不在放」，决定切后台时要不要停 WebView 计时器
      reportPlaying(playing);
      // 只有「真的在播」时才记进度；暂停时保留最后位置，
      // 否则重新打开会从 0 开始（之前重启丢进度就是这个）
      if (playing) rememberProgress(true);
      document.body.classList.toggle('paused', !playing);
      updatePlayIcons(playing);
      if (playing) Player.updatePositionState();
      pushMediaState(true);      // 通知栏的播放/暂停图标也跟着换
    });
    Player.on('time', () => { updateTimes(); syncLyric(); });
    // 曲目变化 → 立刻把新歌推给通知栏（封面/标题/时长）
    Player.on('track', () => { _mediaPushedKey = ''; pushMediaState(true); });
    Player.on('needmore', (t) => {
      // 心动 / 漫游：剩余不到 3 首就续队列
      const mode = S().playMode;
      if (mode !== 'roam' && mode !== 'heart') return;
      const left = Player.queue.length - Player.index - 1;
      if (left > 3) return;
      if (!t || t.source !== 'online' || !t.neId) return;
      if (mode === 'heart') {
        Netease.heartMode(t.neId, 0, 20).then((list) => {
          if (!list.length) return;
          const queue = Player.queue.concat(list);
          Player.queueSet(queue, Player.index);
          renderQueue();
        }).catch(() => {});
      } else {
        extendRoam(t.neId, t);
      }
    });
    Player.on('error', () => toast('播放出错', '音源可能已失效，试试下一首', 'warn'));
    Player.on('sourcefail', (t) => {
      Log.add('PLAY', 'sourcefail: ' + (t && t.title));
      if (App._skipCount == null) App._skipCount = 0;
      App._skipCount++;
      if (App._skipCount > 3) {
        App._skipCount = 0;
        toast('连续多首无法播放', '可能需要会员或版权限制', 'warn');
        return;
      }
      toast('这首放不了', (t && t.title) + ' · 已跳过', 'warn');
      setTimeout(() => Player.next(), 600);
    });
    /*
     * 连续跳过计数：
     * 以前只要某一瞬间 state=true 就清零，坏音源批量出现时会无限
     * 「跳过 → 提示 → 跳过」。现在要求真的播够 3 秒才算「这首能放」。
     */
    Player.on('state', (p) => {
      clearTimeout(App._skipResetTimer);
      if (!p) return;
      App._skipResetTimer = setTimeout(() => { App._skipCount = 0; }, 3000);
    });
    Player.on('blocked', (e) => {
      Log.err('PLAY', e, 'autoplay blocked, user gesture required');
      toast('点一下屏幕继续播放', '系统要求一次触摸才能出声', 'warn');
    });
    Player.on('track', (t) => Log.add('PLAY', 'track changed -> ' + (t && t.title)));
    Player.on('state', (p) => Log.add('PLAY', 'state ' + (p ? 'playing' : 'paused')));
    Player.on('recovered', () => { /* 静音起播成功，无声恢复，不打扰 */ });
  }

  function updatePlayIcons(playing) {
    const html = `<svg><use href="#i-${playing ? 'pause' : 'play'}"/></svg>`;
    $('#dockPlay').innerHTML = html;
    $('#npPlay').innerHTML = html;
  }

  function updateDock() {
    const t = Player.track;
    if (!t) return;
    $('#dockThumb img').src = coverOf(t);
    $('#dockTitle').textContent = t.title;
    $('#dockArtist').textContent = t.artist + (t.album ? ' · ' + t.album : '');
  }

  function updateTimes() {
    const d = Player.duration(), c = Player.time();
    const p = d ? Math.min(1, c / d) : 0;
    $('#dockProg').style.width = (p * 100) + '%';
    $('#npFill').style.width = (p * 100) + '%';
    $('#npKnob').style.left = (p * 100) + '%';
    $('#npCur').textContent = fmtTime(c);
    $('#npDur').textContent = fmtTime(d);
    /*
     * 缓冲进度用真实的 audio.buffered，而不是「已播 + 18%」这种假数据。
     * 取不到（还没元数据、或浏览器不给 buffered）时就不画，别误导人。
     */
    const buf = Player.bufferedEnd();
    if (buf && d) {
      $('#npBuf').style.width = Math.min(100, (buf / d) * 100) + '%';
    } else if (p <= 0.02) {
      $('#npBuf').style.width = '0%';
    }
  }

  /* ================= 播放页 ================= */
  function renderNP() {
    const t = Player.track;
    if (!t) {
      $('#npTitle').textContent = '未在播放';
      $('#npArtist').textContent = '从曲库挑一首开始';
      return;
    }
    $('#npCover img').src = coverOf(t);
    $('#npBg').style.backgroundImage = `url("${coverOf(t)}")`;
    $('#npBg').style.backgroundSize = 'cover';
    $('#npBg').style.backgroundPosition = 'center';
    $('#npTitle').textContent = t.title;
    // VIP 角标：会员曲目 / 需要付费的曲目在歌名右边明确标注
    const isVip = t.source === 'online' && (t.vip || t.fee === 1 || t.fee === 4
      || (t.privilege && t.privilege.fee === 1));
    const vipEl = $('#npVip');
    if (vipEl) vipEl.hidden = !isVip;
    $('#npArtist').textContent = [t.artist, t.album, t.format].filter(Boolean).join(' · ');
    $('#npFrom').textContent = t.source === 'online' ? '网易云 · 在线' : t.source === 'local' ? '本地文件' : '示例曲库';
    const liked = Store.isLiked(t.id);
    $('#npLike').classList.toggle('on', liked);
    $('#npLike').innerHTML = `<svg><use href="#i-${liked ? 'heart' : 'heart-o'}"/></svg>`;
    renderLyric();
    renderQueue();
    syncModeButtons();
    updateTimes();
  }

  let lyricLines = [];

  function lyricOf(t) {
    if (t.lyric && t.lyric.length) return t.lyric;
    if (t.lrc) {
      t.lyric = LRC.merge(LRC.parse(t.lrc), LRC.parse(t.tr || ''));
      return t.lyric;
    }
    return [];
  }

  /* ---------- 三行歌词（播放页常驻） ---------- */
  let lyricIdx = -1;

  function renderLyric() {
    const t = Player.track;
    if (!t) {
      $('#lyrPrev').textContent = '';
      $('#lyrCur').textContent = '—';
      $('#lyrNext').textContent = '';
      lyricLines = [];
      return;
    }
    lyricLines = lyricOf(t);
    // 完整歌词（展开后在同一页面里显示）
    const box = $('#npLyric');
    if (!lyricLines.length) {
      box.innerHTML = `<div class="empty">暂无歌词<br><span style="opacity:.6">在线曲目会自动匹配</span></div>`;
    } else {
      box.innerHTML = lyricLines.map((l, i) =>
        `<div class="ln" data-i="${i}" data-t="${l.t}">${esc(l.text)}`
        + `${l.tr && S().showTrans ? `<span class="tr">${esc(l.tr)}</span>` : ''}</div>`
      ).join('');
      /*
       * 展开后的完整歌词由 JS 直接设字号（元素多、每行还带译文）。
       * 注意选择器必须限定在 #npLyric 内：以前写的是 '.lyric .ln'，
       * 而 box 是 #npLyricBox，querySelectorAll 会连 .np-lyric 的三行歌词一起命中，
       * 于是播放页那三行的字号被行内样式钉死，设置里的「歌词字号」滑块看起来完全没用。
       */
      $$('.lyric .ln', box).forEach((el) => {
        if (el.closest('.np-lyric')) return;      // 三行歌词交给 CSS 变量控制
        el.style.fontSize = S().lyricSize + 'px';
      });
    }
    lyricIdx = -2;
    syncLyric();
  }

  /** force=true 时即使还在同一句也会重新计算（改歌词偏移后需要用） */
  function syncLyric(force) {
    if (!lyricLines.length) {
      $('#lyrPrev').textContent = '';
      $('#lyrCur').textContent = '♪';
      $('#lyrNext').textContent = '';
      return;
    }
    const t = Player.time() + (S().lyricOffset || 0);
    let i = -1;
    for (let k = 0; k < lyricLines.length; k++) {
      if (lyricLines[k].t <= t) i = k; else break;
    }
    // 三行：上一个 / 当前 / 下一个
    const prevTx = i - 1 >= 0 ? lyricLines[i - 1].text : '';
    const curTx = i >= 0 ? lyricLines[i].text : '♪';
    const nextTx = i + 1 < lyricLines.length ? lyricLines[i + 1].text : '';
    $('#lyrPrev').textContent = prevTx || '';
    $('#lyrCur').textContent = curTx;
    $('#lyrNext').textContent = nextTx || '';
    // 状态栏浮层跟着走（内部有去重，同一行不会重复发）
    if (S().sbLyric) pushSbText(false);
    $('#lyrPrev').classList.toggle('blank', !prevTx);
    $('#lyrNext').classList.toggle('blank', !nextTx);

    // 展开层：高亮 + 居中
    const box = $('#npLyric');
    if (!box || !box.children.length) return;
    const rows = box.children;
    const focus = i >= 0 ? i : 0;   // 第一句之前先把第一句顶上去
    const changed = force || i !== lyricIdx;
    if (changed) {
      lyricIdx = i;
      for (let k = 0; k < rows.length; k++) {
        // 还没到第一句（i<0）时把第一句当当前句显示，避免展开后一片空白没有焦点
        rows[k].classList.toggle('on', k === focus);
        rows[k].classList.toggle('near', false);
      }
    }
    // 展开且可见时才滚动（每次调用都校正一次，防止刚展开时高度为 0）
    if (rows[focus] && $('#np').classList.contains('expanded') && box.clientHeight > 0) {
      const target = Math.max(0, rows[focus].offsetTop - box.clientHeight * 0.42);
      if (changed || Math.abs(box.scrollTop - target) > 4) {
        box.scrollTo({ top: target, behavior: changed ? 'smooth' : 'auto' });
      }
    }
  }

  /* ---------- 播放列表 sheet ---------- */
  function renderQueue() {
    const q = Player.queue.length ? Player.queue : Store.all();
    $('#npQueueCount').textContent = q.length + ' 首';
    $('#npQueue').innerHTML = q.map((t, i) =>
      `<div class="qitem${Player.track && Player.track.id === t.id ? ' on' : ''}"
            data-i="${i}" data-id="${esc(t.id)}">
        <div class="idx">${Player.track && Player.track.id === t.id ? '▮▮' : String(i + 1).padStart(2, '0')}</div>
        <div class="tx"><b>${esc(t.title)}</b><span>${esc(t.artist)}</span></div>
        <div class="du">${fmtTime(t.duration)}</div>
      </div>`).join('');
  }

  /* ================= 播放设置面板（右上角 … 弹出） ================= */
  /*
   * 进来的都是「只影响音乐本身」的设置：音质、音量、速度、淡入淡出、
   * 无缝、归一化、均衡器、睡眠定时、歌词。界面外观（主题/玻璃/动画）
   * 仍然留在「我的」里，免得这个面板变成第二个设置页。
   */

  function optRow(icon, title, sub, control) {
    return `<div class="opt-row">
      <div class="ic"><svg><use href="#${icon}"/></svg></div>
      <div class="tx"><b>${esc(title)}</b><span>${esc(sub || '')}</span></div>
      ${control || ''}
    </div>`;
  }

  function optSlider(key, min, max, step, hintId) {
    return `<div class="sld"><input type="range" min="${min}" max="${max}" step="${step}"
      data-opt="${key}" id="${hintId || ''}"></div>`;
  }

  function optSeg(key, items) {
    return `<div class="segmini" data-optseg="${key}">${items.map(([v, label]) =>
      `<button data-v="${v}">${esc(label)}</button>`).join('')}</div>`;
  }

  function optSwitch(key) {
    return `<label class="sw" data-optsw="${key}"></label>`;
  }

  function renderOptSheet() {
    const s = S();
    const EQ_NAMES = { off: '关闭', pop: '流行', rock: '摇滚', vocal: '人声', bass: '低频', night: '夜间' };
    const Q_NAMES = { standard: '标准', higher: '较高', exhigh: '极高', lossless: '无损', hires: 'Hi-Res' };
    const html = `
      <div class="opt-sec">
        <div class="h">分享</div>
        <div class="opt-acts">
          <button data-optact="share"><svg><use href="#i-download"/></svg>分享这首歌</button>
          <button data-optact="copy"><svg><use href="#i-link"/></svg>复制链接</button>
        </div>
      </div>

      <div class="opt-sec">
        <div class="h">音量与音质</div>
        <div class="opt-card">
          ${optRow('i-volume', '音量', Math.round((s.volume == null ? 0.85 : s.volume) * 100) + '%',
            `<div class="sld"><input type="range" min="0" max="1" step="0.05" data-opt="volume"></div>`)}
          ${optRow('i-cloud', '音质偏好', Q_NAMES[s.quality] || '极高',
            `<div class="val">${Q_NAMES[s.quality] || '极高'} ›</div>`).replace('class="opt-row"', 'class="opt-row" data-optact="quality"')}
          ${optRow('i-eq', '音量归一化', '不同来源音量拉平', optSwitch('normalize'))}
        </div>
      </div>

      <div class="opt-sec">
        <div class="h">播放</div>
        <div class="opt-card">
          ${optRow('i-play', '播放速度', (+s.speed).toFixed(2).replace(/0$/, '') + '×',
            `<div class="sld"><input type="range" min="0.75" max="1.5" step="0.05" data-opt="speed"></div>`)}
          ${optRow('i-play', '无缝播放', '预加载下一首，曲间零间隔', optSwitch('gapless'))}
          ${optRow('i-eq', '淡入淡出', s.fade ? s.fade + 's' : '关闭',
            optSeg('fade', [[0, '关'], [0.4, '0.4s'], [0.8, '0.8s']]))}
          ${optRow('i-eq', '均衡器', EQ_NAMES[s.eq] || '关闭',
            `<div class="val">${EQ_NAMES[s.eq] || '关闭'} ›</div>`).replace('class="opt-row"', 'class="opt-row" data-optact="eq"')}
          ${optRow('i-moon', '睡眠定时', s.sleepMin ? s.sleepMin + ' 分钟后暂停' : '关闭',
            `<div class="val">${s.sleepMin ? s.sleepMin + ' 分钟 ›' : '关闭 ›'}</div>`).replace('class="opt-row"', 'class="opt-row" data-optact="sleep"')}
        </div>
      </div>

      <div class="opt-sec">
        <div class="h">歌词</div>
        <div class="opt-card">
          ${optRow('i-lyric', '显示歌词', '播放页底部三行歌词', optSwitch('showLyric'))}
          ${optRow('i-lyric', '翻译', '有译文时显示第二行', optSwitch('showTrans'))}
          ${optRow('i-lyric', '歌词字号', s.lyricSize + ' px',
            `<div class="sld"><input type="range" min="11" max="19" step="1" data-opt="lyricSize"></div>`)}
          ${optRow('i-lyric', '歌词偏移', (s.lyricOffset > 0 ? '+' : '') + (+s.lyricOffset).toFixed(1) + 's',
            `<div class="sld"><input type="range" min="-2" max="2" step="0.1" data-opt="lyricOffset"></div>`)}
        </div>
      </div>

      <div class="opt-sec">
        <div class="h">状态栏歌词</div>
        <div class="opt-card">
          ${optRow('i-lyric', '状态栏歌词', sbNative() ? '在状态栏区域显示当前播放歌词' : '仅 APK 可用',
            optSwitch('sbLyric'))}
          ${optRow('i-eq', '样式', S().sbLocked ? '已锁定 · 不可拖动' : '可拖动 · 点一下可调整',
            '<div class="val">调整 ›</div>').replace('class="opt-row"', 'class="opt-row" data-optact="sbtune"')}
        </div>
      </div>
    `;
    const body = $('#npOptBody');
    body.innerHTML = html;
    syncOptSheet();
    bindOptSheet();
  }

  /** 面板内的控件状态与设置保持一致 */
  function syncOptSheet() {
    const s = S();
    const body = $('#npOptBody');
    if (!body) return;
    $$('[data-opt]', body).forEach((el) => {
      const k = el.dataset.opt;
      el.value = s[k];
      paintSlider(el, false);
    });
    $$('[data-optseg]', body).forEach((seg) => {
      const k = seg.dataset.optseg;
      $$('button', seg).forEach((b) => b.classList.toggle('on', +b.dataset.v === +s[k]));
    });
    $$('[data-optsw]', body).forEach((el) => {
      el.classList.toggle('on', !!s[el.dataset.optsw]);
    });
    // 副标题里的实时数字
    const rows = $$('.opt-row', body);
    const setSub = (actKey, txt) => {
      const r = rows.find((x) => x.dataset.optact === actKey);
      if (!r) return;
      const sub = r.querySelector('.tx span'); if (sub) sub.textContent = txt;
      const val = r.querySelector('.val'); if (val) val.textContent = txt + ' ›';
    };
    setSub('quality', { standard: '标准', higher: '较高', exhigh: '极高', lossless: '无损', hires: 'Hi-Res' }[s.quality] || '极高');
    setSub('sleep', s.sleepMin ? s.sleepMin + ' 分钟' : '关闭');
    setSub('sbtune', s.sbLocked ? '已锁定 · 不可拖动' : '可拖动 · 点一下可调整');
    const volSub = body.querySelector('[data-opt="volume"]');
    if (volSub) {
      const r = volSub.closest('.opt-row');
      const t = r && r.querySelector('.tx span');
      if (t) t.textContent = Math.round((s.volume == null ? 0.85 : s.volume) * 100) + '%';
    }
    const spSub = body.querySelector('[data-opt="speed"]');
    if (spSub) {
      const r = spSub.closest('.opt-row');
      const t = r && r.querySelector('.tx span');
      if (t) t.textContent = (+s.speed).toFixed(2).replace(/0$/, '') + '×';
    }
    const lzSub = body.querySelector('[data-opt="lyricSize"]');
    if (lzSub) {
      const r = lzSub.closest('.opt-row');
      const t = r && r.querySelector('.tx span');
      if (t) t.textContent = s.lyricSize + ' px';
    }
    const loSub = body.querySelector('[data-opt="lyricOffset"]');
    if (loSub) {
      const r = loSub.closest('.opt-row');
      const t = r && r.querySelector('.tx span');
      if (t) t.textContent = (s.lyricOffset > 0 ? '+' : '') + (+s.lyricOffset).toFixed(1) + 's';
    }
  }

  function bindOptSheet() {
    const body = $('#npOptBody');
    if (!body || body.dataset.bound) return;
    body.dataset.bound = '1';

    /*
     * 调歌词参数时让面板变淡：这两个值必须靠眼睛看歌词才好判断。
     * 拖动（pointerdown → pointerup）期间挂 .peek，松手就撤掉。
     */
    /*
     * 调歌词参数时面板变淡（.peek）。
     *
     * 之前用全局 pointerup/touchend 来「松手取消」——这是错的：
     * 长按拖滑条的过程中，浏览器会因为接管滚动而发 touchcancel，
     * 或者 pointerup 提前到，peek 中途就被撤掉，看上去就是「变暗一下又亮回来」。
     * 现在改成：
     *   · 开始：pointerdown / touchstart / input 任一命中歌词项就亮
     *   · 结束：只认这个滑块自己的 change（真正松手才有），
     *     再加一个兜底 —— 指针在面板外抬起时才取消
     */
    const PEEK_KEYS = new Set(['lyricSize', 'lyricOffset', 'showLyric', 'showTrans']);
    let peekHeld = null;            // 正在拖的那个元素
    const setPeek = (on) => {
      const sh = $('#npOptSheet');
      const mk = $('#npOptMask');
      if (sh) sh.classList.toggle('peek', on);
      if (mk) mk.classList.toggle('peek', on);
    };
    const beginPeek = (el) => {
      peekHeld = el || true;
      setPeek(true);
    };
    const endPeek = () => { peekHeld = null; setPeek(false); };

    const peekTarget = (e) => {
      const el = e.target.closest && e.target.closest('[data-opt]');
      return el && PEEK_KEYS.has(el.dataset.opt) ? el : null;
    };
    body.addEventListener('pointerdown', (e) => {
      const el = peekTarget(e);
      if (el) beginPeek(el);
    });
    body.addEventListener('touchstart', (e) => {
      const el = peekTarget(e);
      if (el) beginPeek(el);
    }, { passive: true });
    body.addEventListener('input', (e) => {
      // 拖动过程中持续保证 peek 在（防止被 touchcancel 打断后没恢复）
      const el = peekTarget(e);
      if (el) { peekHeld = el; setPeek(true); }
    }, true);
    // 只在「这个滑块松手」时结束
    body.addEventListener('change', (e) => {
      const el = peekTarget(e);
      if (el && peekHeld === el) endPeek();
    }, true);
    // 兜底：指针在面板以外抬起 → 一定结束
    document.addEventListener('pointerup', (e) => {
      if (!peekHeld) return;
      if (body.contains(e.target)) return;   // 还在面板里，可能是拖到一半
      endPeek();
    });
    document.addEventListener('pointercancel', (e) => {
      if (!peekHeld) return;
      if (body.contains(e.target)) return;
      endPeek();
    });

    body.addEventListener('input', (e) => {
      const el = e.target.closest('[data-opt]');
      if (!el) return;
      const k = el.dataset.opt;
      const v = +el.value;
      S()[k] = v;
      paintSlider(el, true);
      applyVars();
      onSettingChange(k, v);
      syncOptSheet();
    });
    body.addEventListener('change', (e) => {
      const el = e.target.closest('[data-opt]');
      if (!el) return;
      const k = el.dataset.opt;
      S()[k] = +el.value;
      Store.save();
      paintSlider(el, false);
      onSettingChange(k, +el.value, true);
      syncOptSheet();
      endPeek();
    });

    body.addEventListener('click', (e) => {
      // switch
      const sw = e.target.closest('[data-optsw]');
      if (sw) {
        const k = sw.dataset.optsw;
        const v = !S()[k];
        S()[k] = v; Store.save();
        sw.classList.toggle('on', v);
        applyVars();
        onSettingChange(k, v, true);
        syncOptSheet();
        return;
      }
      // segment
      const seg = e.target.closest('[data-optseg]');
      if (seg) {
        const b = e.target.closest('button[data-v]');
        if (!b) return;
        const k = seg.dataset.optseg;
        const v = +b.dataset.v;
        S()[k] = v; Store.save();
        $$('button', seg).forEach((x) => x.classList.toggle('on', x === b));
        onSettingChange(k, v, true);
        syncOptSheet();
        return;
      }
      // 行级动作
      const act = e.target.closest('[data-optact]');
      if (act) return optAction(act.dataset.optact);
    });
  }

  async function optAction(what) {
    const t = Player.track;
    if (what === 'share') {
      if (!t) return toast('还没在播放', '先挑一首歌', 'info');
      const text = `${t.title} - ${t.artist}`;
      // APK 内有原生分享；浏览器里优先系统分享面板
      if (navigator.share) {
        try { await navigator.share({ title: t.title, text }); return; } catch (e) { /* 用户取消 */ }
      }
      copyText(text, '已复制歌名', '粘贴给朋友吧');
      return;
    }
    if (what === 'copy') {
      if (!t) return toast('还没在播放', '', 'info');
      const link = t.source === 'online' && t.neId
        ? 'https://music.163.com/song?id=' + t.neId
        : `${t.title} - ${t.artist}`;
      copyText(link, '已复制链接', t.source === 'online' ? '网易云歌曲页' : '本地曲目没有在线链接');
      return;
    }
    if (what === 'quality') {
      const list = ['standard', 'higher', 'exhigh', 'lossless', 'hires'];
      const names = ['标准', '较高', '极高', '无损', 'Hi-Res'];
      const i = list.indexOf(S().quality);
      const next = list[(i + 1) % list.length];
      S().quality = next; Store.save();
      // 换音质要重新解析地址
      if (Player.track && Player.track.source === 'online') Player.track.src = null;
      syncOptSheet(); syncSettingsUI();
      toast('音质偏好', names[list.indexOf(next)], 'cloud');
      return;
    }
    if (what === 'eq') {
      closeOptSheet();
      setTimeout(() => openEQ(), 260);
      return;
    }
    if (what === 'sbtune') {
      closeOptSheet();
      setTimeout(() => openSbTune(), 260);
      return;
    }
    if (what === 'sleep') {
      const vals = [0, 15, 30, 60, 90];
      const i = vals.indexOf(+S().sleepMin || 0);
      const next = vals[(i + 1) % vals.length];
      S().sleepMin = next; Store.save();
      Player.sleep(next, () => toast('睡眠定时', '已暂停播放', 'moon'));
      syncOptSheet(); syncSettingsUI();
      toast('睡眠定时', next ? next + ' 分钟后暂停' : '已关闭', 'moon');
    }
  }

  /** 统一复制到剪贴板（原生/浏览器都兜住） */
  function copyText(text, okTitle, okDesc) {
    const done = () => toast(okTitle, okDesc || text, 'check');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
      return;
    }
    fallbackCopy(text, done);
  }
  function fallbackCopy(text, done) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      done();
    } catch (e) {
      toast('复制失败', String(e.message || e), 'warn');
    }
  }

  /* ================= 均衡器面板 ================= */
  /*
   * 预设模式：5 条竖条只做展示，滑块置灰不可动。
   * 自定义模式：可以自由拖动，松手后写进 Player，并存到设置里。
   * 在线歌曲时 WebAudio 图接不上（CORS），面板顶部会明说「对在线流不生效」。
   */
  const EQ_BANDS = [
    { f: 60, name: '60' },
    { f: 230, name: '230' },
    { f: 910, name: '910' },
    { f: 3600, name: '3.6k' },
    { f: 14000, name: '14k' },
  ];
  const EQ_PRESETS_UI = [
    ['off', '关闭'], ['pop', '流行'], ['rock', '摇滚'],
    ['vocal', '人声'], ['bass', '低频'], ['night', '夜间'],
  ];

  function currentEQBands() {
    const s = S();
    if (s.eq === 'custom' && Array.isArray(s.eqCustom)) {
      return s.eqCustom.map((x) => Math.max(-12, Math.min(12, Number(x) || 0)));
    }
    return (window.EQ_PRESETS && window.EQ_PRESETS[s.eq]) || [0, 0, 0, 0, 0];
  }

  function renderEQ() {
    const s = S();
    const custom = s.eq === 'custom';
    const bands = currentEQBands();
    const usable = Player.eqUsable();
    const body = $('#eqBody');
    body.innerHTML = `
      <div class="eq-note${usable ? '' : ' warn'}" id="eqNote">
        ${usable
          ? '均衡器作用于本地 / 同源音源（走 WebAudio 滤波链）'
          : '当前音源是在线流：音频 CDN 不允许跨域读取，均衡器对它不生效。<br>换成「从手机导入」的本地歌曲即可听到效果。'}
      </div>
      <div class="eq-presets" id="eqPresets">
        ${EQ_PRESETS_UI.map(([k, n]) =>
          `<button data-eq="${k}" class="${s.eq === k ? 'on' : ''}">${n}</button>`).join('')}
        <button data-eq="custom" class="${custom ? 'on' : ''}">自定义</button>
      </div>
      <div class="eq-bands${custom ? '' : ' locked'}" id="eqBands">
        ${bands.map((g, i) => `
          <div class="eq-band">
            <div class="eq-val" data-eqv="${i}">${g > 0 ? '+' : ''}${(+g).toFixed(1)}</div>
            <div class="eq-track"><input type="range" min="-12" max="12" step="0.5"
              value="${g}" data-eqb="${i}" ${custom ? '' : 'disabled'}></div>
            <div class="eq-hz">${EQ_BANDS[i].name}</div>
          </div>`).join('')}
      </div>
      <div class="eq-scale"><span>+12</span><span>0</span><span>-12</span></div>
      <div class="sheet-hd" style="padding:6px 2px 0">
        <button class="x" id="eqReset" style="margin-left:0">${custom ? '归零' : '预设不可调'}</button>
      </div>
    `;
    syncEQHint();
    bindEQ();
  }

  /** 把均衡器状态同步回「我的」页那一行（面板和设置页必须一致） */
  function syncEQHint() {
    const s = S();
    const EQ_LABELS = { off: '关闭', pop: '流行', rock: '摇滚', vocal: '人声', bass: '低频', night: '夜间', custom: '自定义' };
    const v = $('#eqVal'); if (v) v.textContent = (EQ_LABELS[s.eq] || '关闭') + ' ›';
    const h = $('#eqHint');
    if (h) h.textContent = s.eq === 'off' ? '关闭' : '已启用 · 对本地/同源音源生效';
  }

  function bindEQ() {
    const body = $('#eqBody');
    if (!body) return;
    $('#eqPresets').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-eq]');
      if (!b) return;
      const k = b.dataset.eq;
      S().eq = k;
      if (k === 'custom' && !Array.isArray(S().eqCustom)) S().eqCustom = currentEQBands().slice();
      Store.save();
      if (k === 'custom') Player.setEQBands(S().eqCustom || [0, 0, 0, 0, 0]);
      else Player.setEQ(k);
      renderEQ();
      syncOptSheet();
      syncEQHint();
      toast('均衡器', k === 'custom' ? '自定义（可自由拖动）' : (EQ_PRESETS_UI.find((x) => x[0] === k) || [])[1] || k, 'eq');
    });

    $('#eqBands').addEventListener('input', (e) => {
      const el = e.target.closest('input[data-eqb]');
      if (!el || el.disabled) return;
      const i = +el.dataset.eqb;
      const v = +el.value;
      const arr = Array.isArray(S().eqCustom) ? S().eqCustom.slice() : currentEQBands().slice();
      arr[i] = v;
      S().eqCustom = arr;
      const lab = body.querySelector(`[data-eqv="${i}"]`);
      if (lab) lab.textContent = (v > 0 ? '+' : '') + v.toFixed(1);
      Player.setEQBands(arr);
      // 竖条高度也跟着走，纯 CSS 变量驱动
      el.parentElement.parentElement.style.setProperty('--h', ((v + 12) / 24 * 100) + '%');
    });
    $('#eqBands').addEventListener('change', () => {
      Store.save();
      syncEQHint();
      toast('自定义均衡器', '已保存', 'eq');
      syncOptSheet();
    });

    const rs = $('#eqReset');
    if (rs) rs.addEventListener('click', () => {
      if (S().eq !== 'custom') return toast('预设模式不可调', '切到「自定义」才能编辑', 'info');
      S().eqCustom = [0, 0, 0, 0, 0];
      Store.save();
      Player.setEQBands([0, 0, 0, 0, 0]);
      renderEQ();
      syncEQHint();
      toast('已归零', '所有频段回到 0 dB', 'eq');
    });
  }

  function openEQ() {
    closeQueue(); closeComments(); closeOptSheet();
    renderEQ();
    $('#eqMask').classList.add('on');
    $('#eqSheet').classList.add('on');
  }
  function closeEQ() {
    $('#eqMask').classList.remove('on');
    $('#eqSheet').classList.remove('on');
  }

  function openOptSheet() {
    closeQueue(); closeComments(); closeEQ();
    renderOptSheet();
    $('#npOptMask').classList.add('on');
    $('#npOptSheet').classList.add('on');
  }
  function closeOptSheet() {
    $('#npOptMask').classList.remove('on');
    $('#npOptSheet').classList.remove('on');
  }

  function openQueue() {
    // 两个 sheet 会叠在一起，开一个先关掉另一个
    closeComments(); closeOptSheet(); closeEQ();
    renderQueue();
    $('#npMask').classList.add('on');
    $('#npQueueSheet').classList.add('on');
  }
  function closeQueue() {
    $('#npMask').classList.remove('on');
    $('#npQueueSheet').classList.remove('on');
  }

  /* ---------- 播放模式：一个按钮循环 6 种 ---------- */
  const MODES = [
    { key: 'list',  icon: 'repeat',  tag: '列表',  name: '列表循环', need: null },
    { key: 'one',   icon: 'repeat1', tag: '单曲',  name: '单曲循环', need: null },
    { key: 'seq',   icon: 'order',   tag: '顺序',  name: '顺序播放', need: null },
    { key: 'rand',  icon: 'shuffle', tag: '随机',  name: '随机播放', need: null },
    { key: 'heart', icon: 'heart',   tag: '心动',  name: '心动模式', need: 'login' },
    { key: 'roam',  icon: 'infinite',tag: '漫游',  name: '无限漫游', need: null },
  ];

  function currentModeIndex() {
    const k = S().playMode || 'list';
    const i = MODES.findIndex((m) => m.key === k);
    return i < 0 ? 0 : i;
  }

  function syncModeButtons() {
    const m = MODES[currentModeIndex()];
    $('#npModeIcon').setAttribute('href', '#' + 'i-' + m.icon);
    $('#npModeTag').textContent = m.tag;
    const usable = !m.need || Netease.loggedIn;
    $('#npMode').classList.toggle('on', usable);
    $('#npMode').classList.toggle('off', !usable);
    // 旧的 shuffle / repeat 设置与新模式同步，播放核心仍然只认这两个
    S().shuffle = m.key === 'rand';
    S().repeat = m.key === 'one' ? 'one' : (m.key === 'seq' ? 'off' : 'all');
    Store.save();
  }

  /** 封面始终正方形：取容器宽高较小值（容器由 flex 吸收剩余高度） */
  function sizeCover() {
    const wrap = $('.cover-wrap');
    const cover = $('#npCover');
    if (!wrap || !cover) return;
    const cs = getComputedStyle(wrap);
    const padTop = parseFloat(cs.paddingTop) || 0;
    const padBottom = parseFloat(cs.paddingBottom) || 0;
    const r = wrap.getBoundingClientRect();
    const availH = r.height - padTop - padBottom;
    if (r.width < 2 || availH < 2) return;
    const size = Math.max(120, Math.floor(Math.min(r.width, availH)));
    cover.style.width = size + 'px';
    cover.style.height = size + 'px';
  }

  window.addEventListener('resize', () => { if ($('#np').classList.contains('open')) sizeCover(); });
  window.addEventListener('orientationchange', () => setTimeout(sizeCover, 140));

  function openNP() {
    if (!Player.track) {
      const all = Store.all();
      if (all.length) playTrack(all[0], all);
    }
    renderNP();
    closeQueue();
    closeComments();
    if (isLyricExpanded()) collapseLyric();
    $('#np').classList.add('open');
    refreshSystemBars();
    requestAnimationFrame(sizeCover);
    setTimeout(sizeCover, 220);
    updatePlayIcons(Player.playing);
    $('#np').setAttribute('aria-hidden', 'false');
  }
  function closeNP() {
    $('#np').classList.remove('open');
    $('#np').setAttribute('aria-hidden', 'true');
    if (isLyricExpanded()) collapseLyric();
    setTimeout(refreshSystemBars, 120);
  }

  /* ================= 歌词展开（当前页内移动布局） ================= */

  function isLyricExpanded() {
    return $('#np').classList.contains('expanded');
  }

  function expandLyric() {
    const t = Player.track;
    if (!t) return;
    if (!lyricLines.length) {
      toast('暂无歌词', '这首歌还没匹配到歌词', 'info');
      return;
    }
    $('#np').classList.add('expanded');
    // 展开时信息都还在，只是封面收走、歌词长高
    lyricIdx = -2;
    syncLyric();
    const rollToCurrent = () => {
      const box = $('#npLyric');
      if (!box || !box.clientHeight) return;
      const cur = box.querySelector('.ln.on') || box.querySelector('.ln');
      if (cur) box.scrollTop = Math.max(0, cur.offsetTop - box.clientHeight * 0.36);
    };
    requestAnimationFrame(rollToCurrent);
    setTimeout(rollToCurrent, 300);
    setTimeout(rollToCurrent, 640);
    Log.add('LYRIC', 'expanded');
  }

  function collapseLyric() {
    $('#np').classList.remove('expanded');
    // 收回后重新算一次封面尺寸
    setTimeout(sizeCover, 60);
    setTimeout(sizeCover, 420);
    Log.add('LYRIC', 'collapsed');
  }

  function toggleLyric() {
    if (isLyricExpanded()) collapseLyric(); else expandLyric();
  }

  /* ================= 心动模式 ================= */
  async function applyHeartMode() {
    const t = Player.track;
    if (!t || t.source !== 'online' || !t.neId) {
      toast('心动模式需要一首在线歌曲', '先播一首网易云的歌', 'warn');
      return;
    }
    if (!Netease.loggedIn) {
      toast('心动模式需要登录', '登录后按你的口味生成队列', 'warn');
      return;
    }
    toast('正在生成心动队列…', t.title, 'cloud');
    try {
      const pl = App._plCurrent && App._plCurrent.plId ? App._plCurrent.plId : 0;
      let list = await Netease.heartMode(t.neId, pl, 30);
      if (!list.length) list = await Netease.roamSongs(t.neId, 30);
      if (!list.length) throw new Error('没有拿到推荐');
      // 把当前歌放在最前面
      const cur = list.find((x) => x.neId === t.neId);
      const rest = list.filter((x) => x.neId !== t.neId);
      const queue = (cur ? [cur] : [t]).concat(rest);
      App.context = queue;
      Player.queueSet(queue, 0);
      renderQueue();
      syncModeButtons();
      toast('心动模式已开启', queue.length + ' 首 · 按口味生成', 'heart');
    } catch (e) {
      S().playMode = 'list';
      Store.save();
      syncModeButtons();
      toast('心动模式取不到队列', e.message, 'warn');
    }
  }

  /* ================= 无限漫游 ================= */
  let _roamBusy = false;
  async function applyRoamMode() {
    const t = Player.track;
    if (!t || t.source !== 'online' || !t.neId) {
      toast('漫游需要一首在线歌曲', '先播一首网易云的歌', 'warn');
      return;
    }
    await extendRoam(t.neId, t);
  }

  /** 往队列尾部续一批相似歌曲 */
  async function extendRoam(seedId, seedTrack) {
    if (_roamBusy) return;
    _roamBusy = true;
    try {
      toast('正在续漫游队列…', '', 'cloud');
      let list = [];
      try { list = await Netease.roamSongs(seedId, 20); } catch (e) { list = []; }
      if (!list.length) {
        try { list = await Netease.personalFm(); } catch (e) { list = []; }
      }
      if (!list.length) throw new Error('没有拿到相似歌曲');
      const queue = (Player.queue.length ? Player.queue.slice() : [seedTrack])
        .concat(list.filter((x) => x && x.id));
      Player.queueSet(queue, Player.index);
      App.context = queue;
      renderQueue();
      syncModeButtons();
      toast('漫游中', '队列已扩展到 ' + queue.length + ' 首', 'infinite');
    } catch (e) {
      toast('漫游取不到歌', e.message, 'warn');
    } finally {
      _roamBusy = false;
    }
  }

  /* ================= 评论 / 详情 / 下载 ================= */
  /* 评论：从下方弹出（和播放列表同一套交互） */
  function openComments() {
    closeQueue(); closeOptSheet(); closeEQ();
    $('#cmtMask').classList.add('on');
    $('#cmtSheet').classList.add('on');
  }
  function closeComments() {
    $('#cmtMask').classList.remove('on');
    $('#cmtSheet').classList.remove('on');
  }

  /** 评论骨架屏：纯占位，不闪、不跳 */
  function skeletonComments(n) {
    const one = `<div class="cmt sk">
      <div class="ava sk-ava"></div>
      <div class="bd">
        <i class="sk-line" style="width:32%"></i>
        <i class="sk-line" style="width:92%"></i>
        <i class="sk-line" style="width:64%"></i>
      </div>
    </div>`;
    return `<div class="sk-wrap">${one.repeat(Math.max(1, n))}</div>`;
  }

  async function showComments() {
    const t = Player.track;
    if (!t) return toast('还没在播放', '', 'info');
    if (t.source !== 'online') {
      return toast('本地曲目没有评论', t.title, 'info');
    }
    if (!Netease.ready) return toast('在线功能不可用', '评论需要联网', 'warn');

    /*
     * 拉评论要一两秒，之前这里只有一句「正在读取评论…」，
     * 打开面板时是一块空白，观感上像卡住了。
     * 现在先铺一层骨架屏（头像圆点 + 两行灰条），数据回来再换掉。
     */
    $('#cmtCount').textContent = '读取中…';
    $('#cmtBody').innerHTML = skeletonComments(6);
    openComments();

    let data;
    try {
      data = await Netease.comments(t.neId, 30, 0);
      Log.add('CMMT', 'loaded ' + t.title + ' total=' + data.total
        + ' hot=' + data.hot.length + ' list=' + data.list.length);
    } catch (e) {
      Log.err('CMMT', e, t.title);
      $('#cmtCount').textContent = '失败';
      $('#cmtBody').innerHTML = `<div class="empty" style="padding:30px 0">
        <b>评论读取失败</b><p>${esc(e.message)}</p></div>`;
      return;
    }

    const fmtN = (n) => (n >= 10000 ? (n / 10000).toFixed(1) + ' 万' : String(n));
    const line = (c) => `<div class="cmt">
        <div class="ava"><img src="${c.avatar || ''}" alt="" loading="lazy"></div>
        <div class="bd">
          <b>${esc(c.user)}</b>
          <p>${esc(c.content)}</p>
          <small>${fmtN(c.liked)} 赞</small>
        </div>
      </div>`;
    const hot = data.hot.length
      ? `<div class="cmt-hd">精彩评论 · ${data.hot.length}</div>${data.hot.map(line).join('')}`
      : '';
    const list = data.list.length
      ? `<div class="cmt-hd">最新评论 · ${fmtN(data.total)}</div>${data.list.map(line).join('')}`
      : '<div class="empty" style="padding:26px 0"><b>还没有评论</b></div>';

    $('#cmtCount').textContent = fmtN(data.total) + ' 条';
    $('#cmtBody').innerHTML = hot + list;
    $('#cmtBody').scrollTop = 0;
  }

  function showTrackDetail() {
    const t = Player.track;
    if (!t) return toast('还没在播放', '', 'info');
    const rows = [
      ['歌曲', t.title],
      ['歌手', t.artist],
      ['专辑', t.album || '—'],
      ['时长', fmtTime(t.duration)],
      ['来源', t.source === 'online' ? '网易云' : t.source === 'local' ? '本地文件' : '示例曲库'],
      ['音质', t.format || '—'],
    ];
    if (t.source === 'online') {
      rows.push(['歌曲 ID', t.neId]);
      if (t.maxBr) rows.push(['最高码率', Math.round(t.maxBr / 1000) + ' kbps']);
    }
    modal(`
      <h3>歌曲详情</h3>
      <div class="detail-list">
        ${rows.map(([k, v]) => `<div class="drow"><b>${esc(k)}</b><span>${esc(String(v))}</span></div>`).join('')}
      </div>
      <div class="modal-btns"><button class="btn solid" data-ok>知道了</button></div>
    `, { confirm: true });
  }

  async function downloadTrack() {
    const t = Player.track;
    if (!t) return toast('还没在播放', '', 'info');
    if (t.source !== 'online') {
      return toast('已经是本地文件了', t.title, 'info');
    }
    if (!t.src) {
      try {
        const got = await Netease.songUrl(t.neId, qualityLevel());
        t.src = got.url;
        t.format = (got.type || 'mp3').toUpperCase();
      } catch (e) {
        return toast('取不到下载地址', e.message, 'warn');
      }
    }
    const name = (t.artist ? t.artist + ' - ' : '') + t.title + '.mp3';
    try {
      const a = document.createElement('a');
      a.href = t.src;
      a.download = name;
      a.target = '_blank';
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast('已开始下载', name, 'download');
    } catch (e) {
      toast('下载失败', e.message, 'warn');
    }
  }

  /* ================= 进度拖动 ================= */
  function bindSeek() {
    const bar = $('#npBar');
    const seek = $('.np-seek');
    if (!bar) return;
    let dragging = false;
    const at = (e) => {
      const r = bar.getBoundingClientRect();
      const x = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
      return Math.max(0, Math.min(1, x / r.width));
    };
    const apply = (e) => {
      const d = Player.duration();
      if (!d) return;
      const p = at(e);
      $('#npFill').style.width = (p * 100) + '%';
      $('#npKnob').style.left = (p * 100) + '%';
      $('#npCur').textContent = fmtTime(p * d);
      return p;
    };
    bar.addEventListener('pointerdown', (e) => {
      dragging = true;
      seek.classList.add('dragging');
      apply(e);
      try { bar.setPointerCapture(e.pointerId); } catch (err) {}
    });
    bar.addEventListener('pointermove', (e) => { if (dragging) apply(e); });
    bar.addEventListener('pointerup', (e) => {
      if (!dragging) return;
      dragging = false;
      seek.classList.remove('dragging');
      const p = apply(e);
      if (p != null) Player.seek(p * Player.duration());
    });
    bar.addEventListener('pointercancel', () => {
      dragging = false;
      seek.classList.remove('dragging');
    });
  }

  /* ================= 导航 ================= */
  /* 页面标题：既更新浏览器/任务切换里显示的名字，也给读屏用 */
  const TITLES = { home: '发现', library: '曲库', search: '搜索', settings: '我的', playlist: '歌单' };

  function go(page) {
    if (App.page === page) {
      const cur = $('.page.on');
      if (cur) cur.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    App.page = page;
    $$('.page').forEach((p) => p.classList.toggle('on', p.dataset.page === page));
    $$('#tabbar a').forEach((a) => a.classList.toggle('on', a.dataset.nav === page));
    document.title = (TITLES[page] ? TITLES[page] + ' · ' : '') + 'Ripple 涟漪';
    setTimeout(refreshSystemBars, 30);
    if (page === 'library') { renderLibrary(); loadMyPlaylists(); }
    if (page === 'home') { renderHome(); loadHomeOnline(); }
    if (page === 'settings') updateAccountCard();
  }

  /* ================= 每日推荐（当成一个歌单展示） ================= */
  function openDaily() {
    const songs = App._dailyCache || [];
    if (!songs.length) return toast('还没有推荐', '稍后再来，或先登录', 'info');
    App._plCurrent = {
      title: Netease.loggedIn ? '每日推荐' : '今日推荐',
      sub: `${songs.length} 首 · 按你的口味生成`,
      kind: '每日',
      cover: songs[0] && songs[0].cover,
      tracks: songs,
    };
    go('playlist');
    $('#plTitle').textContent = App._plCurrent.title;
    $('#plSub').textContent = App._plCurrent.sub;
    $('#plKind').textContent = '每日';
    $('#plArt img').src = coverOf(songs[0]);
    $('#plCount').textContent = songs.length + ' 首';
    const plLoad2 = $('#plLoading');
    if (plLoad2) plLoad2.textContent = '';
    const cur = Player.track;
    $('#plTracks').innerHTML = songs.map((t, i) => rowHTML(t, i, cur && cur.id === t.id)).join('');
  }

  /* ================= 歌单详情 ================= */
  async function openPlaylist(plId, meta) {
    go('playlist');
    $('#plTitle').textContent = (meta && meta.title) || '歌单';
    $('#plSub').textContent = (meta && meta.sub) || '读取中…';
    $('#plKind').textContent = (meta && meta.kind) || '歌单';
    $('#plArt img').src = coverOf(meta || {});
    $('#plTracks').innerHTML = '<div class="plrow"><div class="tx"><b>正在读取曲目…</b></div></div>';
    $('#plCount').textContent = '曲目';
    // 这个 id 以前在 HTML 里但没人写入，一直空着；现在当加载指示用
    const plLoad = $('#plLoading');
    if (plLoad) plLoad.textContent = '读取中…';

    let data = App._plCache.get(String(plId));
    if (!data) {
      try {
        data = await Netease.playlist(plId);
        // 详情里 tracks 可能为空（新歌单），再拉一次完整曲目
        if (!data.tracks || !data.tracks.length) {
          data.tracks = await Netease.playlistTracks(plId, 300);
        }
        App._plCache.set(String(plId), data);
      } catch (e) {
        $('#plTracks').innerHTML = `<div class="empty"><b>读取失败</b><p>${esc(e.message)}</p></div>`;
        const plLoad3 = $('#plLoading');
        if (plLoad3) plLoad3.textContent = '失败';
        return;
      }
    }
    $('#plTitle').textContent = data.title;
    $('#plSub').textContent = [data.creator, data.sub, data.desc].filter(Boolean).join(' · ');
    $('#plArt img').src = coverOf(data);
    $('#plCount').textContent = data.tracks.length + ' 首';
    const cur = Player.track;
    $('#plTracks').innerHTML = data.tracks.map((t, i) => rowHTML(t, i, cur && cur.id === t.id)).join('')
      || '<div class="empty"><b>空歌单</b></div>';
    App._plCurrent = data;
  }

  /* ================= 设置 UI ================= */
  function syncSettingsUI() {
    const s = S();
    $$('[data-set]').forEach((el) => {
      const k = el.dataset.set;
      if (el.classList.contains('sw')) el.classList.toggle('on', !!s[k]);
      if (el.tagName === 'INPUT') {
        el.value = s[k];
        paintSlider(el);
      }
    });
    // 「我的 → 关于」那行的版本号，从 RIPPLE_VERSION 注入（以前写死在 HTML 里，
    // 改版本要同时改两处，结果常年显示 1.1.0）
    const av = $('#aboutVer');
    if (av) {
      const v = (typeof RIPPLE_VERSION !== 'undefined' && RIPPLE_VERSION) || {};
      av.textContent = (v.name || '?') + ' · build ' + (v.code == null ? '?' : v.code);
    }
    $$('#themeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.theme === s.theme));
    $$('#fadeSeg button').forEach((b) => b.classList.toggle('on', +b.dataset.fade === +s.fade));
    $$('#qualitySeg button').forEach((b) => b.classList.toggle('on', b.dataset.q === s.quality));
    const EQ_LABELS = { off: '关闭', pop: '流行', rock: '摇滚', vocal: '人声', bass: '低频', night: '夜间', custom: '自定义' };
    $('#eqVal').textContent = (EQ_LABELS[s.eq] || '关闭') + ' ›';
    $('#eqHint').textContent = s.eq === 'off'
      ? '关闭'
      : '已启用 · 对本地/同源音源生效';
    /*
     * 所有数值型设置的「当前值」都集中在这里刷新，
     * 滑块旁边的小字和拖动气泡用的是同一套格式，不会出现两处数字不一致。
     */
    const setTx = (sel, txt) => { const e = $(sel); if (e) e.textContent = txt; };
    setTx('#speedHint', (+s.speed).toFixed(2).replace(/0$/, '') + '×');
    setTx('#volHint', Math.round((s.volume == null ? 0.85 : s.volume) * 100) + '%');
    setTx('#lyricSizeHint', s.lyricSize + ' px');
    setTx('#lyricOffsetHint', (s.lyricOffset > 0 ? '+' : '') + (+s.lyricOffset).toFixed(1) + 's');
    setTx('#glassBlurHint', s.glassBlur + ' px');
    setTx('#animSpeedHint', (+s.animSpeed).toFixed(1) + '×');
    syncSbOverlay();
    syncNotifyPermUI();
    /*
     * APK 内的媒体通知由原生 PlaybackService 提供（前台服务 + MediaSession），
     * 跟浏览器的 navigator.mediaSession 是两套东西。
     * 之前这里只看网页 API，于是在 APK 里也显示「此浏览器不支持」，
     * 而实际上通知栏控件一直是好的。
     */
    const hasNativeMedia = !!(window.RippleNative && typeof window.RippleNative.mediaState === 'function');
    $('#mediaHint').textContent = hasNativeMedia
      ? '通知栏 / 锁屏 / 耳机键可控'
      : (('mediaSession' in navigator) ? '锁屏 / 通知中心显示' : '此环境不支持');
    $('#sleepVal').textContent = (s.sleepMin ? s.sleepMin + ' 分钟 ›' : '关闭 ›');
    syncConnectionUI();
    refreshSystemBars();
    Log.add('BOOT', 'ready, logPath=' + Log.path());
    setTimeout(refreshSystemBars, 400);
  }

  function syncConnectionUI() {
    const el = $('#apiHint');
    if (!el) return;
    const mode = Netease.mode;
    el.textContent = mode === 'native'
      ? '原生通道 · weapi 加密 · 可登录账号'
      : mode === 'proxy'
        ? Netease.base
        : '未启用（用 APK 或 node server.js）';
    $('#apiVal').textContent = { native: 'APP', proxy: '代理', none: '离线' }[mode] || '—';
    const bv = $('#apiBaseVal');
    if (bv) bv.textContent = (S().apiBase ? '自定义 ›' : '默认 ›');
    const bh = $('#apiBaseHint');
    if (bh) {
      bh.textContent = Netease.nativeOn
        ? 'APK 内走原生通道，无需填写'
        : (S().apiBase || '留空 = 同源 server.js');
    }
  }

  /* 每个滑块在设置里的「单位/格式」 */
  const SLD_FMT = {
    glassBlur: (v) => v + 'px',
    animSpeed: (v) => (+v).toFixed(1) + '×',
    volume: (v) => Math.round(v * 100) + '%',
    speed: (v) => (+v).toFixed(2).replace(/0$/, '') + '×',
    lyricSize: (v) => v + 'px',
    lyricOffset: (v) => (v > 0 ? '+' : '') + (+v).toFixed(1) + 's',
  };

  function paintSlider(el, showTip) {
    const min = +el.min || 0, max = +el.max || 100, v = +el.value;
    const p = ((v - min) / (max - min)) * 100;
    el.style.setProperty('--p', p + '%');
    /*
     * 拖动时在滑块上方弹出数值气泡。
     * 用 ——p 算一个 0..1 的比例，再叠加 thumb 半径的偏移，
     * 气泡中心才能跟着拇指走（而不是永远贴在最左边）。
     */
    const wrap = el.closest('.sld');
    if (!wrap) return;
    let tip = wrap.querySelector('.sld-tip');
    if (!tip) {
      tip = document.createElement('span');
      tip.className = 'sld-tip';
      wrap.appendChild(tip);
    }
    const key = el.dataset.set;
    const fmt = SLD_FMT[key] || ((x) => String(x));
    tip.textContent = fmt(v);
    // thumb 14px 宽，可用轨道宽度 = 容器宽 - 14（容器还有 0 padding）
    const trackW = Math.max(1, wrap.clientWidth - 14);
    tip.style.left = (7 + (p / 100) * trackW) + 'px';
    if (showTip) tip.classList.add('on');
    else tip.classList.remove('on');
  }

  /** 拖动结束后收起气泡（input 事件里亮、change/松手后灭） */
  function hideSliderTip(el) {
    const wrap = el.closest && el.closest('.sld');
    if (!wrap) return;
    const tip = wrap.querySelector('.sld-tip');
    if (tip) tip.classList.remove('on');
  }

  /* ================= 事件 ================= */
  function bindEvents() {
    $$('[data-nav]').forEach((el) => el.addEventListener('click', (e) => {
      e.preventDefault();
      go(el.dataset.nav);
    }));
    $('#btnSearch').addEventListener('click', () => { go('search'); setTimeout(() => $('#searchInput').focus(), 260); });
    $('#btnSettings').addEventListener('click', () => go('settings'));
    $('#btnTheme').addEventListener('click', () => {
      const order = ['dark', 'light', 'auto'];
      const next = order[(order.indexOf(S().theme) + 1) % 3];
      S().theme = next; Store.save();
      applyTheme();
      if (Player.track) paletteFor(Player.track);
      toast('主题已切换', { dark: '深色', light: '浅色', auto: '跟随系统' }[next], 'theme');
    });

    // 首页
    $('#btnHeroPlay').addEventListener('click', () => {
      const list = (App._dailyCache && App._dailyCache.length) ? App._dailyCache : Store.all();
      if (!list.length) return toast('还没有可播的歌', '先导入音乐或搜索网易云', 'info');
      playTrack(list[0], list);
      openNP();
    });
    $('#btnHeroShuffle').addEventListener('click', () => {
      const list = (App._dailyCache && App._dailyCache.length) ? App._dailyCache : Store.all();
      if (!list.length) return;
      S().playMode = 'rand'; Store.save(); syncModeButtons();
      playTrack(list[Math.floor(Math.random() * list.length)], list);
      openNP();
    });
    $('#dailyMore').addEventListener('click', () => {
      if (!App._dailyCache || !App._dailyCache.length) return;
      openDaily();
    });

    // 卡片 / 列表点击（委派）
    document.addEventListener('click', (e) => {
      if (e.target.closest('#dock')) return;

      // 歌单卡 / 歌单行
      const plEl = e.target.closest('[data-pl]');
      if (plEl && plEl.dataset.pl) {
        openPlaylist(plEl.dataset.pl, {
          title: (plEl.querySelector('b') || {}).textContent,
          sub: (plEl.querySelector('.c-tx span, .tx span') || {}).textContent,
          cover: (plEl.querySelector('img') || {}).src,
          kind: (plEl.querySelector('.c-k') || {}).textContent,
        });
        return;
      }

      const card = e.target.closest('[data-id]');
      if (!card) return;
      const id = card.dataset.id;
      const t = findTrack(id);
      if (!t) return;

      if (card.closest('#npQueue')) {
        Player.playAt(Player.queue, +card.dataset.i);
        return;
      }
      if (card.closest('#plTracks') && App._plCurrent) {
        playTrack(t, App._plCurrent.tracks);
        openNP();
        return;
      }
      if (card.closest('#carousel')) {
        // 推荐卡：播放整张推荐列表
        const ctx = (App._dailyCache || []).length ? App._dailyCache : Store.all();
        playTrack(t, ctx);
        openNP();
        return;
      }
      if (card.closest('#toplistCarousel')) return; // 已在上面处理
      const ctx = card.closest('#libList') ? libFiltered()
        : card.closest('#searchBody') ? (App.onlineResults || Store.all())
          : card.closest('#recList') ? Store.all()
            : Store.all();
      playTrack(t, ctx);
    });

    // 曲库筛选
    $$('#libChips .chip').forEach((c) => c.addEventListener('click', () => {
      $$('#libChips .chip').forEach((x) => x.classList.remove('on'));
      c.classList.add('on');
      App.filter = c.dataset.filter;
      renderLibrary();
    }));
    /*
     * 曲库顶部那四个 tab（歌曲/专辑/艺人/下载）。
     * 之前它们完全没有绑定，点了既不切换也不生效 —— 用户会以为 App 坏了。
     * 现在「歌曲」回到默认列表；另外三个用只读视图展示分组结果，
     * 不再假装有功能却什么都不做。
     */
    const seg = $('#segline');
    if (seg) {
      seg.addEventListener('click', (e) => {
        const b = e.target.closest('b[data-seg]');
        if (!b) return;
        $$('#segline b').forEach((x) => x.classList.toggle('on', x === b));
        App._libSeg = b.dataset.seg;
        renderLibrary();
      });
    }
    const tlMore = $('#toplistMore');
    if (tlMore) {
      tlMore.addEventListener('click', () => {
        if (!Netease.ready) return toast('在线功能不可用', '用 APK 或先 node server.js', 'warn');
        go('search');
        App.scope = 'online';
        // 同步搜索页的 scope 高亮（没有单独的 syncScope，直接操作 chip）
        $$('#searchScope .chip').forEach((x) => x.classList.toggle('on', x.dataset.scope === 'online'));
        showOnlineIntro();
      });
    }
    $('#rowImport').addEventListener('click', () => $('#filePicker').click());
    $('#filePicker').addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      if (!files.length) return;
      toast('正在导入…', files.length + ' 个文件', 'folder');
      const added = await Store.addFiles(files);
      e.target.value = '';
      renderAll();
      toast(added.length ? '导入完成' : '没有可导入的音频',
        added.length ? (Store._volatile ? `本次会话可用 ${added.length} 首（存储受限）` : `新增 ${added.length} 首`) : '请选择音频文件',
        'check');
    });
    $('#rowSheet').addEventListener('click', async () => {
      const url = await promptDialog('从链接添加', '粘贴音频直链', 'https://…');
      if (!url) return;
      const t = {
        id: 'url_' + Date.now(), source: 'local', title: url.split('/').pop().split('?')[0] || '网络音频',
        artist: '链接导入', album: '', duration: 0, cover: '', src: url, format: 'URL',
      };
      Store.localTracks.unshift(t);
      renderAll();
      toast('已添加', t.title, 'check');
    });

    // 歌单详情返回
    $('#plBack').addEventListener('click', () => go('library'));
    $('#plPlay').addEventListener('click', () => {
      if (!App._plCurrent || !App._plCurrent.tracks.length) return toast('空歌单', '', 'info');
      S().playMode = 'list'; Store.save(); syncModeButtons();
      playTrack(App._plCurrent.tracks[0], App._plCurrent.tracks);
      openNP();
    });
    $('#plShuffle').addEventListener('click', () => {
      if (!App._plCurrent || !App._plCurrent.tracks.length) return;
      S().playMode = 'rand'; Store.save(); syncModeButtons();
      const l = App._plCurrent.tracks;
      playTrack(l[Math.floor(Math.random() * l.length)], l);
      openNP();
    });

    // 搜索
    let searchTimer = 0;
    $('#searchInput').addEventListener('input', (e) => {
      const v = e.target.value.trim();
      $('#searchClear').hidden = !v;
      clearTimeout(searchTimer);
      if (!v) { renderSearchDefaults(); return; }
      searchTimer = setTimeout(() => doSearch(v), 420);
    });
    $('#searchClear').addEventListener('click', () => {
      $('#searchInput').value = '';
      $('#searchClear').hidden = true;
      renderSearchDefaults();
    });
    $$('#searchScope .chip').forEach((c) => c.addEventListener('click', () => {
      $$('#searchScope .chip').forEach((x) => x.classList.remove('on'));
      c.classList.add('on');
      App.scope = c.dataset.scope;
      const v = $('#searchInput').value.trim();
      if (v) doSearch(v);
      else if (App.scope === 'online') showOnlineIntro();
      else renderSearchDefaults();
    }));
    $('#searchBody').addEventListener('click', (e) => {
      const hot = e.target.closest('[data-hot]');
      if (hot) {
        $('#searchInput').value = hot.dataset.hot;
        $('#searchClear').hidden = false;
        doSearch(hot.dataset.hot);
      }
    });

    // 播放页
    $('#npClose').addEventListener('click', closeNP);
    $('#npPlay').addEventListener('click', () => Player.toggle());
    $('#dockPlay').addEventListener('click', (e) => { e.stopPropagation(); Player.toggle(); });
    $('#dockNext').addEventListener('click', (e) => { e.stopPropagation(); Player.next(); });
    $('#dockInner').addEventListener('click', () => openNP());
    $('#npPrev').addEventListener('click', () => Player.prev());
    $('#npNext').addEventListener('click', () => Player.next());

    // 播放模式：一个按钮循环切换
    $('#npMode').addEventListener('click', async () => {
      let next = (currentModeIndex() + 1) % MODES.length;
      const m = MODES[next];
      if (m.need === 'login' && !Netease.loggedIn) {
        toast('心动模式需要登录', '在「我的」里登录网易云账号后再试', 'warn');
        // 跳过这一档，继续找下一个可用模式
        next = (next + 1) % MODES.length;
      }
      const mode = MODES[next];
      S().playMode = mode.key;
      Store.save();
      syncModeButtons();
      toast('播放模式', mode.name, 'repeat');
      if (mode.key === 'heart') await applyHeartMode();
      if (mode.key === 'roam') await applyRoamMode();
    });

    // 播放列表
    $('#npQueueBtn').addEventListener('click', openQueue);
    // 右上角「…」→ 播放设置面板（以前完全没有绑定，点了没反应）
    $('#npMore').addEventListener('click', () => { closeQueue(); closeComments(); openOptSheet(); });
    $('#npOptMask').addEventListener('click', closeOptSheet);
    $('#npOptClose').addEventListener('click', closeOptSheet);
    $('#eqMask').addEventListener('click', closeEQ);
    $('#eqClose').addEventListener('click', closeEQ);
    $('#sbMask').addEventListener('click', closeSbTune);
    $('#sbClose').addEventListener('click', closeSbTune);
    $('#pickMask').addEventListener('click', closeColorPicker);
    $('#pickClose').addEventListener('click', closeColorPicker);
    const sbTuneRow = $('#rowSbTune');
    if (sbTuneRow) sbTuneRow.addEventListener('click', () => openSbTune());
    $('#npMask').addEventListener('click', closeQueue);
    $('#npQueueClose').addEventListener('click', closeQueue);

    // 评论（下方弹出）
    $('#cmtMask').addEventListener('click', closeComments);
    $('#cmtClose').addEventListener('click', closeComments);

    // 歌词：点三行 → 页内展开；展开后再点行 → 跳转播放位置
    $('#npLyricMini').addEventListener('click', expandLyric);
    $('#npLyric').addEventListener('click', (e) => {
      const ln = e.target.closest('.ln');
      if (ln && ln.dataset.t) Player.seek(+ln.dataset.t);
    });
    // 展开态下：点歌名区域收起；返回键/下滑也能收
    $('#npMeta').addEventListener('click', () => {
      if (isLyricExpanded()) collapseLyric();
    });

    // 底部三个按钮
    $('#npComment').addEventListener('click', showComments);
    $('#npDetail').addEventListener('click', showTrackDetail);
    $('#npDownload').addEventListener('click', downloadTrack);

    $('#npLike').addEventListener('click', async () => {
      if (!Player.track) return;
      const t = Player.track;
      const on = Store.toggleLike(t.id);
      $('#npLike').classList.toggle('on', on);
      $('#npLike').innerHTML = `<svg><use href="#i-${on ? 'heart' : 'heart-o'}"/></svg>`;
      renderAll();
      if (t.source === 'online' && Netease.loggedIn) {
        try {
          await Netease.like(t.neId, on);
          toast(on ? '已同步到网易云' : '已从网易云取消', t.title, 'heart');
        } catch (e) {
          toast(on ? '只存在于本机' : '只在本机移除', e.message, 'warn');
        }
      } else {
        toast(on ? '已加入我喜欢' : '已取消喜欢', t.title, 'heart');
      }
    });

    bindSeek();

    // 设置
    $('#acctRow').addEventListener('click', () => {
      if (!Netease.loggedIn) chooseLoginMode();
    });
    $('#themeSeg').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-theme]');
      if (!b) return;
      S().theme = b.dataset.theme; Store.save();
      applyTheme();
      paletteFor(Player.track || { title: 'ripple', artist: '' });
    });
    $('#fadeSeg').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-fade]');
      if (!b) return;
      S().fade = +b.dataset.fade; Store.save(); syncSettingsUI();
    });
    $('#qualitySeg').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-q]');
      if (!b) return;
      S().quality = b.dataset.q; Store.save(); syncSettingsUI();
      // 换音质要重新解析地址
      if (Player.track && Player.track.source === 'online') Player.track.src = null;
    });
    $$('[data-set]').forEach((el) => {
      if (el.classList.contains('sw')) {
        el.addEventListener('click', () => {
          const k = el.dataset.set;
          const v = !S()[k];
          S()[k] = v; Store.save();
          el.classList.toggle('on', v);
          applyVars();
          onSettingChange(k, v);
        });
      } else if (el.tagName === 'INPUT') {
        /*
         * 拖动中：立刻写入设置并走一遍 onSettingChange，让效果实时可见，
         *          同时把数值气泡亮出来。
         * 松手：收起气泡，并把这一项的变化补一次（有些设置需要
         *          「停下来再算」才划算，比如重排歌词）。
         */
        el.addEventListener('input', () => {
          const k = el.dataset.set;
          const v = +el.value;
          S()[k] = v;
          paintSlider(el, true);
          applyVars();
          onSettingChange(k, v);
        });
        el.addEventListener('change', () => {
          const k = el.dataset.set;
          S()[k] = +el.value;
          Store.save();
          paintSlider(el, false);
          onSettingChange(k, +el.value, true);
        });
        // 手指/鼠标按下就亮，便于看清当前值
        el.addEventListener('pointerdown', () => paintSlider(el, true));
      }
    });
    // 「我的 → 均衡器」不再就地循环取值，改成打开和播放页同一个面板
    (function bindEqEntry() {
      const el = $('#eqVal');
      if (!el) return;
      const row = el.closest('.set-row');
      if (row) row.addEventListener('click', (e) => { e.stopPropagation(); openEQ(); });
    })();
    Player.restoreSleep(() => toast('睡眠定时', '已暂停播放', 'moon'));
    // 上次开着状态栏歌词的话，启动后接上（权限还在就自动显示）
    if (S().sbLyric) setTimeout(() => syncSbOverlay(), 900);
    // README 写的是 15/30/60/90，实际只有到 60，这里补齐
    cycleSetting('#sleepVal', 'sleepMin', [0, 15, 30, 60, 90], () => {
      Player.sleep(S().sleepMin, () => toast('睡眠定时', '已暂停播放', 'moon'));
      syncSettingsUI();
      $('#sleepHint').textContent = S().sleepMin ? S().sleepMin + ' 分钟后暂停' : '关闭';
    });
    $('#rowTestNotify').addEventListener('click', testNotification);
    $('#permVal').addEventListener('click', requestPerm);
    $('#rowApiBase').addEventListener('click', async () => {
      if (Netease.nativeOn) {
        return toast('APK 内不需要接口地址', '已走原生 weapi 通道', 'info');
      }
      const cur = S().apiBase || '';
      const v = await promptDialog('网易云接口地址',
        '填一个自建的 NeteaseCloudMusicApi 地址，例如 http://192.168.1.9:3000；留空表示用同源 server.js', cur);
      if (v == null) return;
      const base = String(v).trim().replace(/\/+$/, '');
      S().apiBase = base; Store.save();
      Netease.setBase(base);
      syncConnectionUI();
      toast(base ? '接口地址已保存' : '已恢复默认', base || '同源 / 原生通道', 'check');
    });
    $('#rowApiTest').addEventListener('click', doTest);
    $('#rowRefreshLike').addEventListener('click', syncLikes);
    $('#rowLogout').addEventListener('click', doLogout);
    $('#clearLocal').addEventListener('click', async () => {
      if (!Store.localTracks.length) return toast('没有可清空的音乐', '', 'info');
      if (!(await confirmDialog('清空已导入的音乐？', '会删除本机保存的音频文件'))) return;
      await Store.clearLocal();
      renderAll();
      toast('已清空', '本地导入的音乐已删除', 'trash');
    });
    $('#rowClearHistory').addEventListener('click', () => {
      Store.state.history = [];
      Store.state.playedSec = 0;
      Store.save(); renderAll();
      toast('已清除', '播放记录已清空', 'trash');
    });
    $('#rowReset').addEventListener('click', async () => {
      if (!(await confirmDialog('恢复默认设置？', '主题与播放选项都会重置（不影响登录与续播位置）'))) return;
      /*
       * 以前只换了 settings 对象，播放器与实际界面都没跟着回滚：
       * 音量、均衡器、速度、播放模式、列表密度全停在旧值，和 UI 显示不一致。
       * 另外 lastTrackId / lastPosition 也被一起清掉了，恢复默认后就丢续播。
       */
      const keepTrack = S().lastTrackId;
      const keepPos = S().lastPosition;
      const keepQueue = S().lastQueue;
      Store.state.settings = Object.assign({}, DEFAULTS);
      S().lastTrackId = keepTrack;
      S().lastPosition = keepPos;
      S().lastQueue = keepQueue;
      Store.save();
      applyTheme(); applyVars();
      Player.setVolume(S().volume);
      applyEQFromSettings();
      Player.setRate(S().speed);
      Player.setNormalize(S().normalize);
      Player.setGapless(S().gapless);
      syncModeButtons();
      document.body.classList.toggle('compact', !!S().compactList);
      applyVars();
      syncSettingsUI(); renderAll();
      toast('已恢复默认', '液态玻璃 · 深色', 'check');
    });
    $('#rowLog').addEventListener('click', showLog);
    $('#rowAbout').addEventListener('click', showAbout);

    // 退出/切后台时保存进度（移动端点返回键、切 App 都会走这里）
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) rememberProgress(true);
    });
    window.addEventListener('pagehide', () => rememberProgress(true));
    window.addEventListener('beforeunload', () => rememberProgress(true));

    // 键盘（桌面调试用）
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT') return;
      if (e.code === 'Space') { e.preventDefault(); Player.toggle(); }
      if (e.key === 'ArrowRight') Player.next();
      if (e.key === 'ArrowLeft') Player.prev();
      if (e.key === 'Escape') closeNP();
    });

    /*
     * auto 模式要跟着系统走。除了媒体查询（浏览器里有效），
     * 再加一条「回到前台就重新解析」—— 用户在系统设置里切了深色浅色再回来，
     * 主题会立即跟上；原生的 uiMode 变化也会触发 Activity 重建前的这次检查。
     */
    matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
      if (S().theme === 'auto') { applyTheme(); if (Player.track) paletteFor(Player.track); }
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      // 用户可能刚从系统设置里授权回来，回前台就刷新一次真实状态
      syncNotifyPermUI();
      if (S().theme !== 'auto') return;
      const want = systemPrefersDark() ? 'dark' : 'light';
      if (document.documentElement.dataset.theme !== want) {
        applyTheme();
        if (Player.track) paletteFor(Player.track);
        Log.add('THEME', 'auto re-resolved -> ' + want);
      }
    });

    bindGestures();
  }

  function findTrack(id) {
    return Store.byId(id)
      || (App.onlineResults || []).find((x) => x.id === id)
      || (App._dailyCache || []).find((x) => x.id === id)
      || (App._plCurrent && App._plCurrent.tracks || []).find((x) => x.id === id)
      || Store.cached().find((x) => x.id === id)
      || (Player.queue || []).find((x) => x.id === id)
      || (App.context || []).find((x) => x.id === id);
  }

  /**
   * 设置变化 → 立刻反映到界面/播放器，不需要重进软件。
   * `settled` 为真表示这次是「松手/确定」，可以做一些比较贵的操作（整体重排）。
   */
  function onSettingChange(k, v, settled) {
    if (k === 'mediaSession') { Player._updateMediaSession(); if (v) Player.updatePositionState(); }

    /* ---- 播放 ---- */
    if (k === 'speed') {
      Player.setRate(v);
      const h = $('#speedHint'); if (h) h.textContent = (+v).toFixed(2).replace(/0$/, '') + '×';
    }
    if (k === 'volume') {
      Player.setVolume(v);
      const h = $('#volHint'); if (h) h.textContent = Math.round(v * 100) + '%';
    }
    if (k === 'normalize') Player.setNormalize(v);
    if (k === 'gapless') { Player.setGapless(v); if (v) Player._prefetchNext(); }
    if (k === 'notifyQuiet') { /* 只是偏好，发通知时读取 */ }
    if (k === 'sbLyric') {
      if (v && !(window.RippleNative && window.RippleNative.canDrawOverlay && window.RippleNative.canDrawOverlay())) {
        // 没权限：开关退回去，并引导授权
        S().sbLyric = false; Store.save();
        const sw = $('[data-set="sbLyric"]'); if (sw) sw.classList.remove('on');
        toast('需要悬浮窗权限', '在系统设置里允许「显示在其他应用上层」', 'warn');
        try { window.RippleNative.requestOverlayPermission(); } catch (e) {}
        syncSbOverlay();
        return;
      }
      syncSbOverlay();
    }
    if (k === 'apiBase') { Netease.setBase(v); syncConnectionUI(); }

    /* ---- 歌词 ---- */
    if (k === 'showLyric') $('#npLyricMini').classList.toggle('hidden', !v);
    if (k === 'lyricSize') {
      // CSS 变量管三行歌词的字号+行高；展开层由 renderLyric 写行内样式
      applyVars();
      const h = $('#lyricSizeHint'); if (h) h.textContent = v + ' px';
      if (settled) renderLyric(); else updateFullLyricFont(v);
    }
    if (k === 'lyricOffset') {
      const h = $('#lyricOffsetHint');
      if (h) h.textContent = (v > 0 ? '+' : '') + (+v).toFixed(1) + 's';
      // 偏移改了立刻按新时间轴重算当前行，不用等下一句
      syncLyric(true);
    }
    if (k === 'showTrans') renderLyric();

    /* ---- 界面 ---- */
    if (k === 'compactList') document.body.classList.toggle('compact', v);
    if (k === 'glassBlur') {
      applyVars();
      // 效果本来就是靠 CSS 变量实时生效的，这里补上左侧的小字
      const h = $('#glassBlurHint'); if (h) h.textContent = v + ' px';
    }
    if (k === 'animSpeed') {
      applyVars();
      const h = $('#animSpeedHint'); if (h) h.textContent = (+v).toFixed(1) + '×';
    }
  }

  /** 只更新展开歌词的字号，不重建整个歌词列表（拖动时用，避免闪烁） */
  function updateFullLyricFont(px) {
    const box = $('#npLyric');
    if (!box) return;
    $$('.ln', box).forEach((el) => {
      if (el.closest('.np-lyric')) return;
      el.style.fontSize = px + 'px';
    });
  }

  function cycleSetting(sel, key, values, after) {
    const el = $(sel);
    if (!el) return;
    const row = el.closest('.set-row');
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      const i = values.indexOf(S()[key]);
      S()[key] = values[(i + 1) % values.length];
      Store.save();
      after && after();
    });
  }

  async function doTest() {
    if (!Netease.ready) return toast('在线功能不可用', '用 APK，或先 node server.js', 'warn');
    toast('正在测试…', Netease.mode === 'native' ? '原生 weapi 通道' : Netease.base, 'cloud');
    try {
      const r = await Netease.test();
      toast(r.ok ? '连接成功' : '返回异常',
        r.ok ? `${r.ms} ms · 示例：${r.name}` : '请检查网络或接口',
        r.ok ? 'check' : 'warn');
    } catch (e) {
      toast('连接失败', e.message, 'warn');
    }
  }

  /* ================= 搜索 ================= */
  async function doSearch(kw) {
    const body = $('#searchBody');
    if (App.scope === 'online') {
      if (!Netease.ready) { showOnlineIntro(); return; }
      body.innerHTML = `<div class="empty"><b>搜索中…</b><p>${esc(kw)}</p></div>`;
      try {
        const [songs, pls] = await Promise.all([
          Netease.searchSongs(kw, 30),
          Netease.searchPlaylists(kw, 8).catch(() => ({ list: [] })),
        ]);
        App.onlineResults = songs.list;
        let html = '';
        if (pls.list.length) {
          html += `<div class="sec-head"><span class="n">PL</span><h2>歌单 · ${pls.list.length}</h2></div>
            <div class="list">${pls.list.map(plRowHTML).join('')}</div>`;
        }
        html += `<div class="sec-head"><span class="n">NE</span><h2>单曲 · ${songs.total || songs.list.length}</h2></div>`;
        html += songs.list.length
          ? `<div class="list">${songs.list.map((t, i) => rowHTML(t, i, false)).join('')}</div>`
          : `<div class="empty"><b>没有找到</b><p>换个关键词试试</p></div>`;
        body.innerHTML = html;
      } catch (e) {
        body.innerHTML = `<div class="empty"><b>搜索失败</b><p>${esc(e.message)}</p></div>`;
      }
      return;
    }
    const q = kw.toLowerCase();
    const res = Store.all().filter((t) =>
      (t.title || '').toLowerCase().includes(q)
      || (t.artist || '').toLowerCase().includes(q)
      || (t.album || '').toLowerCase().includes(q));
    App.onlineResults = null;
    body.innerHTML = res.length
      ? `<div class="sec-head"><span class="n">LOCAL</span><h2>本机 · ${res.length} 个结果</h2></div>
         <div class="list">${res.map((t, i) => rowHTML(t, i, false)).join('')}</div>`
      : `<div class="empty"><b>没有找到</b><p>试试切到「网易云」范围搜在线曲目</p></div>`;
  }

  function showOnlineIntro() {
    App.onlineResults = null;
    const ok = Netease.ready;
    $('#searchBody').innerHTML = `<div class="empty">
      <svg><use href="#i-cloud"/></svg>
      <b>${ok ? '搜索你想听的歌' : '在线搜索不可用'}</b>
      <p>${ok
        ? '输入歌名或歌手，直接播放网易云曲目。'
        : '在线功能需要 APK（内置原生通道），或在本机跑 <code>node server.js</code> 再从这里访问。'}</p>
    </div>`;
  }

  /* ================= 原生：播放状态上报 ================= */
  let _lastPlayingReport = null;
  function reportPlaying(playing) {
    const N = window.RippleNative;
    if (!N || typeof N.setPlaying !== 'function') return;
    if (_lastPlayingReport === playing) return;
    _lastPlayingReport = playing;
    try { N.setPlaying(!!playing); } catch (e) {}
  }

  /* ================= 状态栏歌词 ================= */
  /*
   * 真正的状态栏歌词在 Android 上是「盖在状态栏区域的悬浮窗」，
   * 需要「显示在其他应用上层」权限。原生那边是 LyricOverlay，
   * 这里负责：开关、把当前歌词行推过去、锁定、以及未锁定时弹出的调整面板。
   */
  let _sbNativeReady = false;
  let _lastSbText = '';

  function sbNative() {
    const N = window.RippleNative;
    return !!(N && typeof N.showLyricOverlay === 'function');
  }

  function sbEnabled() {
    return !!S().sbLyric && sbNative();
  }

  /** 把配置推给原生并（重新）显示 */
  function applySbOverlay() {
    const N = window.RippleNative;
    if (!N || typeof N.showLyricOverlay !== 'function') return;
    const s = S();
    try {
      N.showLyricOverlay(
        String(!!s.sbLocked), s.sbColor || '#FFFFFF', String(s.sbSize || 12),
        String(s.sbAlpha == null ? 0.92 : s.sbAlpha),
        String(s.sbX == null ? -1 : s.sbX), String(s.sbY == null ? -1 : s.sbY),
        String(!!s.sbBold), String(!!s.sbShadow),
        String(!!s.sbFill), s.sbFillColor || '#7DE3D0'
      );
      _sbNativeReady = true;
      Log.add('LYRIC', 'overlay apply locked=' + s.sbLocked + ' color=' + s.sbColor);
    } catch (e) {
      Log.err('LYRIC', e, 'showLyricOverlay failed');
    }
    pushSbText(true);
  }

  function stopSbOverlay() {
    const N = window.RippleNative;
    if (!N || typeof N.hideLyricOverlay !== 'function') return;
    try { N.hideLyricOverlay(); } catch (e) {}
    _sbNativeReady = false;
    _lastSbText = '';
  }

  /** 把「当前这一行歌词」推到浮层 */
  function pushSbText(force) {
    const N = window.RippleNative;
    if (!N || typeof N.updateLyricOverlay !== 'function') return;
    if (!sbEnabled() || !_sbNativeReady) return;
    let line = '';
    if (Player.track && lyricLines && lyricLines.length) {
      const t = Player.time() + (S().lyricOffset || 0);
      let i = -1;
      for (let k = 0; k < lyricLines.length; k++) {
        if (lyricLines[k].t <= t) i = k; else break;
      }
      if (i >= 0) line = lyricLines[i].text || '';
    }
    if (!force && line === _lastSbText) return;
    _lastSbText = line;
    try { N.updateLyricOverlay(line); } catch (e) {}
    pushSbProgress();
  }

  /** 把播放进度（0..1）推给浮层，用于文字填充效果 */
  function pushSbProgress() {
    const N = window.RippleNative;
    if (!N || typeof N.setLyricProgress !== 'function') return;
    if (!sbEnabled() || !_sbNativeReady || !S().sbFill) return;
    const d = Player.duration();
    if (!d || !isFinite(d)) return;
    const p = Math.max(0, Math.min(1, (Player.time() || 0) / d));
    try { N.setLyricProgress(String(p)); } catch (e) {}
  }

  /** 开关状态变化时的统一入口 */
  function syncSbOverlay() {
    if (S().sbLyric) applySbOverlay();
    else stopSbOverlay();
    // 设置页那一行的状态
    const h = $('#sbHint');
    if (h) {
      h.textContent = !sbNative()
        ? '仅 APK 可用'
        : (S().sbLyric ? (S().sbLocked ? '已开启 · 已锁定' : '已开启 · 可拖动调整') : '关闭');
    }
    const lk = $('#sbLockVal');
    if (lk) lk.textContent = S().sbLocked ? '已锁定 ›' : '可调整 ›';
  }

  /** 未锁定时点一下浮层 → 弹出调整面板 */
  window.__rippleLyricTap = function () {
    if (!sbEnabled() || S().sbLocked) return;
    openSbTune();
  };

  /** 拖动结束，原生回传新位置 */
  window.__rippleLyricMoved = function (x, y) {
    S().sbX = x; S().sbY = y;
    Store.save();
    Log.add('LYRIC', 'overlay moved to ' + x + ',' + y);
  };

  /* ---------- 调整面板 ---------- */
  const SB_COLORS = [
    ['#FFFFFF', '白'], ['#FFD166', '暖黄'], ['#8FD8FF', '天蓝'],
    ['#B3A2FF', '浅紫'], ['#FF9EC4', '樱粉'], ['#7DE3D0', '薄荷'],
    ['#000000', '黑'], ['#F1EEEA', '米白'],
  ];

  function renderSbTune() {
    const s = S();
    const body = $('#sbBody');
    if (!body) return;
    const can = window.RippleNative && typeof window.RippleNative.canDrawOverlay === 'function'
      ? window.RippleNative.canDrawOverlay() : false;
    body.innerHTML = `
      ${can ? '' : `<div class="eq-note warn">还没有「显示在其他应用上层」权限。<br>
        <button class="btn ghost" id="sbPermBtn" style="margin-top:8px;height:34px">去授权</button></div>`}
      <div class="opt-sec">
        <div class="h">颜色</div>
        <div class="sb-colors" id="sbColors">
          ${SB_COLORS.map(([hex, name]) =>
            `<button data-hex="${hex}" class="${s.sbColor === hex ? 'on' : ''}"
               style="--c:${hex}" title="${name}"><i></i></button>`).join('')}
          <button data-hex="__custom" class="sb-custom ${SB_COLORS.some(([h]) => h === s.sbColor) ? '' : 'on'}"
            style="--c:${SB_COLORS.some(([h]) => h === s.sbColor) ? (s.sbColor || '#FFFFFF') : s.sbColor}"
            title="自定义"><i></i><em>+</em></button>
        </div>
        <div class="sb-custom-row">
          <span>当前颜色</span>
          <button class="sb-swatch" id="sbOpenPicker" style="--c:${s.sbColor || '#FFFFFF'}"></button>
          <code id="sbColorHex">${(s.sbColor || '#FFFFFF').toUpperCase()}</code>
          <button class="sb-pick-btn" id="sbPickBtn">自定义 ›</button>
        </div>
      </div>
      <div class="opt-sec">
        <div class="h">外观</div>
        <div class="opt-card">
          ${optRow('i-lyric', '字号', s.sbSize + ' sp',
            `<div class="sld"><input type="range" min="9" max="22" step="1" data-sb="sbSize"></div>`)}
          ${optRow('i-eq', '不透明度', Math.round((s.sbAlpha == null ? 0.92 : s.sbAlpha) * 100) + '%',
            `<div class="sld"><input type="range" min="0.2" max="1" step="0.05" data-sb="sbAlpha"></div>`)}
          ${optRow('i-eq', '加粗', '让歌词更醒目', `<label class="sw" data-sbsw="sbBold"></label>`)}
          ${optRow('i-eq', '描边阴影', '深色壁纸上更清楚', `<label class="sw" data-sbsw="sbShadow"></label>`)}
          ${optRow('i-play', '跟随进度填充', '已播放部分用另一种颜色',
            `<label class="sw" data-sbsw="sbFill"></label>`)}
          ${s.sbFill ? `<div class="sb-custom-row">
            <span>填充色</span>
            <button class="sb-swatch" id="sbFillPickBtn" style="--c:${s.sbFillColor || '#7DE3D0'}"></button>
            <code id="sbFillHex">${(s.sbFillColor || '#7DE3D0').toUpperCase()}</code>
            <button class="sb-pick-btn" data-pickfill>自定义 ›</button>
          </div>` : ''}
        </div>
      </div>
      <div class="opt-sec">
        <div class="h">位置</div>
        <div class="opt-card">
          <div class="opt-row" data-sbact="reset">
            <div class="ic"><svg><use href="#i-play"/></svg></div>
            <div class="tx"><b>恢复默认位置</b><span>回到状态栏下方居中</span></div>
            <div class="val">重置 ›</div>
          </div>
        </div>
      </div>
      <div class="opt-sec">
        <div class="h">锁定</div>
        <div class="opt-card">
          <div class="opt-row" data-sbact="lock">
            <div class="ic"><svg><use href="#i-check"/></svg></div>
            <div class="tx"><b>${s.sbLocked ? '当前已锁定' : '当前可调整'}</b>
              <span>${s.sbLocked ? '锁定后不可拖动、不影响正常使用' : '可拖动位置，点一下打开此面板'}</span></div>
            <div class="val">${s.sbLocked ? '解锁 ›' : '锁定 ›'}</div>
          </div>
        </div>
      </div>
    `;
    bindSbTune();
    syncSbTuneValues();
  }

  function syncSbTuneValues() {
    const body = $('#sbBody');
    if (!body) return;
    const s = S();
    $$('[data-sb]', body).forEach((el) => { el.value = s[el.dataset.sb]; paintSlider(el, false); });
    $$('[data-sbsw]', body).forEach((el) => el.classList.toggle('on', !!s[el.dataset.sbsw]));
    const sz = body.querySelector('[data-sb="sbSize"]');
    if (sz) {
      const r = sz.closest('.opt-row'); const t = r && r.querySelector('.tx span');
      if (t) t.textContent = s.sbSize + ' sp';
    }
    const al = body.querySelector('[data-sb="sbAlpha"]');
    if (al) {
      const r = al.closest('.opt-row'); const t = r && r.querySelector('.tx span');
      if (t) t.textContent = Math.round((s.sbAlpha == null ? 0.92 : s.sbAlpha) * 100) + '%';
    }
  }

  function bindSbTune() {
    const body = $('#sbBody');
    if (!body || body.dataset.bound) return;
    body.dataset.bound = '1';

    body.addEventListener('input', (e) => {
      const el = e.target.closest('[data-sb]');
      if (!el) return;
      const k = el.dataset.sb;
      S()[k] = +el.value;
      paintSlider(el, true);
      applySbOverlay();
      syncSbTuneValues();
    });
    body.addEventListener('change', (e) => {
      const el = e.target.closest('[data-sb]');
      if (!el) return;
      S()[el.dataset.sb] = +el.value;
      Store.save();
      paintSlider(el, false);
      applySbOverlay();
      syncSbTuneValues();
    });
    body.addEventListener('click', (e) => {
      const col = e.target.closest('#sbColors button');
      if (col) {
        // 「+」或「自定义」都打开自绘取色器
        if (col.dataset.hex === '__custom') {
          openColorPicker('sbColor', S().sbColor || '#FFFFFF');
          return;
        }
        S().sbColor = col.dataset.hex;
        Store.save();
        $$('#sbColors button').forEach((b) => b.classList.toggle('on', b === col));
        applySbOverlay();
        renderSbTune();
        return;
      }
      // 面板里的两个「自定义」入口
      if (e.target.closest('#sbOpenPicker') || e.target.closest('#sbPickBtn')) {
        openColorPicker('sbColor', S().sbColor || '#FFFFFF');
        return;
      }
      if (e.target.closest('#sbFillPickBtn') || e.target.closest('[data-pickfill]')) {
        openColorPicker('sbFillColor', S().sbFillColor || '#7DE3D0');
        return;
      }
      const sw = e.target.closest('[data-sbsw]');
      if (sw) {
        const k = sw.dataset.sbsw;
        S()[k] = !S()[k];
        Store.save();
        applySbOverlay();
        // 打开「跟随进度填充」需要多出「填充色」那一行，整块重画
        if (k === 'sbFill') renderSbTune();
        else sw.classList.toggle('on', !!S()[k]);
        return;
      }
      const act = e.target.closest('[data-sbact]');
      if (act) {
        if (act.dataset.sbact === 'reset') {
          S().sbX = -1; S().sbY = -1; Store.save();
          applySbOverlay();
          toast('已恢复默认位置', '状态栏下方居中', 'check');
        } else if (act.dataset.sbact === 'lock') {
          S().sbLocked = !S().sbLocked;
          Store.save();
          applySbOverlay();
          renderSbTune();
          syncSbOverlay();
          toast(S().sbLocked ? '已锁定' : '已解锁', S().sbLocked ? '不可拖动，不影响使用' : '可拖动位置', 'check');
        }
        return;
      }
      const perm = e.target.closest('#sbPermBtn');
      if (perm && window.RippleNative && window.RippleNative.requestOverlayPermission) {
        window.RippleNative.requestOverlayPermission();
      }
    });
  }

  /* ================= 自定义取色器（底部弹出） ================= */
  /*
   * 不用系统 <input type=color>：那个在 WebView 里长得太简陋，
   * 而且一弹就是系统模态，跟 App 的风格完全不搭。
   * 这里自己画一个：左侧饱和度/明度二维取色区（点哪取哪），
   * 右侧色相竖条，底部十六进制输入 + 预设插槽。
   */
  let _pickTarget = 'sbColor';     // 当前在改哪个颜色
  let _pickH = 0, _pickS = 0, _pickV = 100;

  function hexToHsv(hex) {
    const c = String(hex || '').replace('#', '');
    if (c.length !== 6) return [0, 0, 100];
    const r = parseInt(c.slice(0, 2), 16) / 255;
    const g = parseInt(c.slice(2, 4), 16) / 255;
    const b = parseInt(c.slice(4, 6), 16) / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d > 0) {
      if (mx === r) h = ((g - b) / d) % 6;
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    return [h, mx === 0 ? 0 : (d / mx) * 100, mx * 100];
  }

  function hsvToHex(h, s, v) {
    s /= 100; v /= 100;
    const f = (n) => {
      const k = (n + h / 60) % 6;
      return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
    };
    const to = (x) => Math.round(Math.max(0, Math.min(1, x)) * 255)
      .toString(16).padStart(2, '0');
    return '#' + to(f(5)) + to(f(3)) + to(f(1));
  }

  function openColorPicker(key, current) {
    _pickTarget = key;
    const hsv = hexToHsv(current);
    _pickH = hsv[0]; _pickS = hsv[1]; _pickV = hsv[2];
    renderPicker();
    $('#pickMask').classList.add('on');
    $('#pickSheet').classList.add('on');
  }
  function closeColorPicker() {
    $('#pickMask').classList.remove('on');
    $('#pickSheet').classList.remove('on');
  }

  function renderPicker() {
    const body = $('#pickBody');
    if (!body) return;
    body.innerHTML = `
      <div class="pick-hd">
        <div class="pick-preview" id="pickPreview"></div>
        <div class="pick-info">
          <code id="pickHex">#FFFFFF</code>
          <span>${_pickTarget === 'sbFillColor' ? '进度填充色' : '歌词颜色'}</span>
        </div>
      </div>
      <div class="pick-main">
        <div class="pick-sv" id="pickSV"><i class="pick-knob" id="pickKnob"></i></div>
        <div class="pick-hue" id="pickHue"><i class="pick-hbar" id="pickHBar"></i></div>
      </div>
      <div class="pick-hex">
        <span>#</span>
        <input id="pickHexInput" maxlength="6" inputmode="latin" autocomplete="off" spellcheck="false">
      </div>
      <div class="pick-quick" id="pickQuick">
        ${['#FFFFFF', '#FFD166', '#8FD8FF', '#B3A2FF', '#FF9EC4', '#7DE3D0',
           '#FF6B6B', '#FFA94D', '#51CF66', '#339AF0', '#845EF7', '#F06595']
          .map((h) => `<button data-q="${h}" style="--c:${h}"></button>`).join('')}
      </div>
      <div class="modal-btns" style="margin-top:14px">
        <button class="btn ghost" id="pickCancel">取消</button>
        <button class="btn solid" id="pickOk">使用这个颜色</button>
      </div>
    `;
    syncPickerUI();
    bindPicker();
  }

  function syncPickerUI() {
    const hex = hsvToHex(_pickH, _pickS, _pickV);
    const prev = $('#pickPreview'); if (prev) prev.style.background = hex;
    const code = $('#pickHex'); if (code) code.textContent = hex.toUpperCase();
    const inp = $('#pickHexInput'); if (inp && document.activeElement !== inp) inp.value = hex.slice(1).toUpperCase();
    const sv = $('#pickSV');
    if (sv) sv.style.background = hsvToHex(_pickH, 100, 100);
    const knob = $('#pickKnob');
    if (knob) {
      knob.style.left = _pickS + '%';
      knob.style.top = (100 - _pickV) + '%';
      knob.style.background = hex;
    }
    const hbar = $('#pickHBar');
    if (hbar) hbar.style.top = (_pickH / 360 * 100) + '%';
  }

  function bindPicker() {
    const sv = $('#pickSV');
    const hue = $('#pickHue');
    if (sv && !sv.dataset.bound) {
      sv.dataset.bound = '1';
      const pick = (e) => {
        const r = sv.getBoundingClientRect();
        const x = Math.max(0, Math.min(r.width, (e.touches ? e.touches[0].clientX : e.clientX) - r.left));
        const y = Math.max(0, Math.min(r.height, (e.touches ? e.touches[0].clientY : e.clientY) - r.top));
        _pickS = (x / r.width) * 100;
        _pickV = 100 - (y / r.height) * 100;
        syncPickerUI();
      };
      sv.addEventListener('pointerdown', (e) => {
        // setPointerCapture 在部分环境（含合成事件）会抛，别让它挡住取色
        try { sv.setPointerCapture(e.pointerId); } catch (err) {}
        pick(e);
        const move = (ev) => pick(ev);
        const up = () => {
          sv.removeEventListener('pointermove', move);
          sv.removeEventListener('pointerup', up);
          sv.removeEventListener('pointercancel', up);
        };
        sv.addEventListener('pointermove', move);
        sv.addEventListener('pointerup', up);
        sv.addEventListener('pointercancel', up);
      });
    }
    if (hue && !hue.dataset.bound) {
      hue.dataset.bound = '1';
      const pick = (e) => {
        const r = hue.getBoundingClientRect();
        const y = Math.max(0, Math.min(r.height, (e.touches ? e.touches[0].clientY : e.clientY) - r.top));
        _pickH = (y / r.height) * 360;
        syncPickerUI();
      };
      hue.addEventListener('pointerdown', (e) => {
        try { hue.setPointerCapture(e.pointerId); } catch (err) {}
        pick(e);
        const move = (ev) => pick(ev);
        const up = () => {
          hue.removeEventListener('pointermove', move);
          hue.removeEventListener('pointerup', up);
          hue.removeEventListener('pointercancel', up);
        };
        hue.addEventListener('pointermove', move);
        hue.addEventListener('pointerup', up);
        hue.addEventListener('pointercancel', up);
      });
    }
    const inp = $('#pickHexInput');
    if (inp && !inp.dataset.bound) {
      inp.dataset.bound = '1';
      inp.addEventListener('input', () => {
        let v = inp.value.replace(/[^0-9a-fA-F]/g, '').slice(0, 6);
        inp.value = v.toUpperCase();
        if (v.length === 6) {
          const hsv = hexToHsv('#' + v);
          _pickH = hsv[0]; _pickS = hsv[1]; _pickV = hsv[2];
          syncPickerUI();
        }
      });
    }
    const quick = $('#pickQuick');
    if (quick && !quick.dataset.bound) {
      quick.dataset.bound = '1';
      quick.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-q]');
        if (!b) return;
        const hsv = hexToHsv(b.dataset.q);
        _pickH = hsv[0]; _pickS = hsv[1]; _pickV = hsv[2];
        syncPickerUI();
      });
    }
    const ok = $('#pickOk');
    if (ok && !ok.dataset.bound) {
      ok.dataset.bound = '1';
      ok.addEventListener('click', () => {
        const hex = hsvToHex(_pickH, _pickS, _pickV);
        S()[_pickTarget] = hex;
        Store.save();
        applySbOverlay();
        renderSbTune();      // 让面板里的圆点/hex 跟着变
        closeColorPicker();
        toast('颜色已保存', hex.toUpperCase(), 'check');
      });
    }
    const cancel = $('#pickCancel');
    if (cancel && !cancel.dataset.bound) {
      cancel.dataset.bound = '1';
      cancel.addEventListener('click', closeColorPicker);
    }
  }

  function openSbTune() {
    closeQueue(); closeComments(); closeOptSheet(); closeEQ();
    renderSbTune();
    $('#sbMask').classList.add('on');
    $('#sbSheet').classList.add('on');
  }
  function closeSbTune() {
    $('#sbMask').classList.remove('on');
    $('#sbSheet').classList.remove('on');
  }

  /* ================= 媒体播放通知（原生） ================= */
  /*
   * 把当前播放状态推给原生，让通知栏/锁屏显示封面、标题、进度和控制按钮。
   * 真正的播放动作仍在网页里：原生把按钮点击转成 __rippleMediaCmd。
   */
  let _mediaPushedKey = '';

  function mediaNative() {
    const N = window.RippleNative;
    return !!(N && typeof N.mediaState === 'function');
  }

  function pushMediaState(force) {
    const N = window.RippleNative;
    if (!N || typeof N.mediaState !== 'function') return;
    const t = Player.track;
    if (!t) return;
    const dur = Math.round((Player.duration() || 0) * 1000);
    const pos = Math.round((Player.time() || 0) * 1000);
    const cover = coverOf(t);
    // 曲目信息没变就只推进度，省掉每次重设 metadata 的开销
    const key = [t.id, t.title, t.artist, t.album, cover, dur].join('|');
    if (!force && key === _mediaPushedKey) {
      try { N.mediaProgress(String(pos), String(dur), !!Player.playing); } catch (e) {}
      return;
    }
    _mediaPushedKey = key;
    try {
      N.mediaState(t.title || '', t.artist || '', t.album || '', cover,
        String(dur), String(pos), !!Player.playing);
      Log.add('MEDIA', 'push state ' + t.title + ' playing=' + Player.playing);
    } catch (e) {
      Log.err('MEDIA', e, 'mediaState failed');
    }
  }

  /* 通知栏 / 锁屏 / 耳机键 → 这里的命令 */
  window.__rippleMediaCmd = function (cmd) {
    Log.add('MEDIA', 'native cmd: ' + cmd);
    if (cmd === 'play') Player.play();
    else if (cmd === 'pause') Player.pause();
    else if (cmd === 'toggle') Player.toggle();
    else if (cmd === 'next') Player.next();
    else if (cmd === 'prev') Player.prev();
    else if (cmd === 'stop') { Player.pause(); }
    setTimeout(() => pushMediaState(true), 60);
  };
  window.__rippleMediaSeek = function (ms) {
    const sec = Math.max(0, Number(ms) / 1000);
    Log.add('MEDIA', 'seek to ' + sec.toFixed(1));
    Player.seek(sec);
    setTimeout(() => pushMediaState(true), 40);
  };

  /* ================= 通知 ================= */
  /** 问原生「通知权限到底有没有」，并刷新设置页那一行 */
  function syncNotifyPermUI() {
    const N = window.RippleNative;
    const h = $('#permHint'), v = $('#permVal');
    if (!h || !v) return;
    if (N && typeof N.notifyGranted === 'function') {
      let ok = false;
      try { ok = !!N.notifyGranted(); } catch (e) {}
      h.textContent = ok ? '已授权 · 静默通知' : '未授权';
      v.textContent = ok ? '已开启' : '授权 ›';
      return ok;
    }
    if ('Notification' in window) {
      const ok = Notification.permission === 'granted';
      h.textContent = ok ? '已授权' : (Notification.permission === 'denied' ? '已被拒绝' : '未授权');
      v.textContent = ok ? '已开启' : '授权 ›';
      return ok;
    }
    h.textContent = '此环境不支持';
    v.textContent = '—';
    return false;
  }

  /* 原生申请权限后会回调这里，让设置页立刻显示真实状态 */
  window.__rippleNotifyPerm = function (ok) {
    syncNotifyPermUI();
    toast(ok ? '通知权限已开启' : '通知权限被拒绝', '', ok ? 'check' : 'warn');
  };
  function nativeNotify() {
    return !!(window.RippleNative && typeof window.RippleNative.notify === 'function');
  }

  async function requestPerm() {
    if (nativeNotify()) {
      // 原生侧不再在启动时弹框，这里让用户主动触发一次申请
      const N = window.RippleNative;
      if (typeof N.requestNotifyPermission === 'function') {
        try { N.requestNotifyPermission(); } catch (e) {}
        toast('已请求通知权限', '允许后才能在通知栏显示播放提示', 'bell');
      } else {
        $('#permHint').textContent = '原生通知通道已启用';
        $('#permVal').textContent = '已开启';
        toast('通知已就绪', '低优先级静默通知，不打断播放', 'check');
      }
      return;
    }
    if (!('Notification' in window)) return toast('不支持通知', '当前浏览器没有通知能力', 'warn');
    const p = await Notification.requestPermission();
    $('#permHint').textContent = p === 'granted' ? '已授权' : '未授权';
    $('#permVal').textContent = p === 'granted' ? '已开启' : '授权 ›';
    toast(p === 'granted' ? '通知权限已开启' : '通知权限被拒绝', '', p === 'granted' ? 'check' : 'warn');
  }

  async function testNotification() {
    const title = Player.track ? Player.track.title : 'Ripple';
    const body = Player.track ? `${Player.track.artist} · 正在播放，通知不会打断` : '通知不会打断音乐播放';
    if (nativeNotify()) {
      // quiet 来自设置里的「通知不打断播放」；关掉它会走另一个有提示音的通道
      const quiet = S().notifyQuiet !== false;
      let ok;
      try {
        ok = window.RippleNative.notify('Ripple · ' + title, body, quiet);
      } catch (e) {
        ok = window.RippleNative.notify('Ripple · ' + title, body);   // 老版本桥只有两个参数
      }
      return toast(ok ? '通知已发送' : '通知发送失败',
        ok ? (quiet ? '静默通道 · 音乐继续播放' : '提示音通道 · 会响一声') : '',
        ok ? 'bell' : 'warn');
    }
    if (!('Notification' in window)) return toast('不支持通知', '', 'warn');
    if (Notification.permission !== 'granted') await requestPerm();
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.ready) {
        const reg = await navigator.serviceWorker.ready;
        await reg.showNotification('Ripple · 通知测试', {
          body, icon: 'assets/icons/icon-192.png', badge: 'assets/icons/icon-192.png',
          tag: 'ripple-test', silent: true, requireInteraction: false,
        });
      } else {
        new Notification('Ripple · 通知测试', { body, silent: true });
      }
      toast('通知已发送', '音乐继续播放，未被暂停', 'bell');
    } catch (e) {
      toast('通知发送失败', e.message, 'warn');
    }
  }

  /* ================= 手势 ================= */
  function bindGestures() {
    const np = $('#np');
    let sx = 0, sy0 = 0, dragging = false, fromTop = false;

    /*
     * 下拉关闭只在「顶部空白 / 关闭键 / 封面」上生效。
     * 展开歌词后，可滚动的 .lyric 正好占据屏幕上部，
     * 以前它落在 clientY < 220 的范围里，用户想滚歌词却把整个播放页拖了下来。
     */
    const inScrollable = (el) => !!(el && el.closest && el.closest('.lyric, .queue, .np-lyricbox'));
    /*
     * 面板（底部 sheet）和它的遮罩里，绝对不能触发「整页下拉关闭」。
     * 之前没有这一条：手指按在面板上往下拖，拖动的其实是整个播放页，
     * 面板也跟着一起走，看上去就是「列表在跟着整页一起动」。
     */
    const inSheet = (el) => !!(el && el.closest
      && el.closest('.np-sheet, .sheet-mask, .queue, .opt-body, .cmt-body, .sb-colors'));
    np.addEventListener('touchstart', (e) => {
      const t = e.targetTouches[0];
      sy0 = t.clientY; sx = t.clientX;
      if (inSheet(e.target)) {           // 面板内：整页手势完全不介入
        dragging = false;
        fromTop = false;
        return;
      }
      const onScroll = inScrollable(e.target);
      fromTop = !onScroll && (
        t.clientY < 220 || e.target.closest('#npClose') || e.target.closest('.np-cover'));
      dragging = !onScroll || !!e.target.closest('.np-cover');
    }, { passive: true });

    np.addEventListener('touchmove', (e) => {
      if (!dragging) return;
      const t = e.targetTouches[0];
      const dy = t.clientY - sy0;
      const dx = t.clientX - sx;
      if (dy > 8 && fromTop && Math.abs(dy) > Math.abs(dx)) {
        np.style.transform = `translateY(${Math.max(0, dy)}px)`;
        np.style.transition = 'none';
      }
    }, { passive: true });

    np.addEventListener('touchend', (e) => {
      if (!dragging) return;
      dragging = false;
      const t = e.changedTouches[0];
      const dy = t.clientY - sy0;
      const dx = t.clientX - sx;
      np.style.transition = '';
      np.style.transform = '';
      if (fromTop && dy > 90) { closeNP(); return; }
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.6) {
        dx < 0 ? Player.next() : Player.prev();
      }
    });

    /*
     * 面板顶部的小白条（.grab）单独支持「按住往下拖 = 关闭面板」。
     * 之前它只是个装饰，用户长按/下拉它没有任何反应，
     * 反而因为落在 #np 的手势区里，把整个播放页拖走了。
     */
    const sheets = [
      { sheet: '#npQueueSheet', close: closeQueue },
      { sheet: '#cmtSheet', close: closeComments },
      { sheet: '#npOptSheet', close: closeOptSheet },
      { sheet: '#eqSheet', close: closeEQ },
      { sheet: '#sbSheet', close: closeSbTune },
      { sheet: '#pickSheet', close: closeColorPicker },
    ];
    sheets.forEach(({ sheet, close }) => {
      const box = $(sheet);
      if (!box) return;
      const grab = box.querySelector('.grab');
      if (!grab) return;
      let y0 = 0, active = false, dy = 0;
      const reset = () => {
        box.style.transition = '';
        box.style.transform = '';
      };
      grab.addEventListener('touchstart', (e) => {
        active = true; dy = 0;
        y0 = e.touches[0].clientY;
        box.style.transition = 'none';
      }, { passive: true });
      grab.addEventListener('touchmove', (e) => {
        if (!active) return;
        dy = e.touches[0].clientY - y0;
        if (dy > 0) box.style.transform = `translateY(${dy}px)`;
      }, { passive: true });
      grab.addEventListener('touchend', () => {
        if (!active) return;
        active = false;
        reset();
        if (dy > 60) close();
      });
      // 鼠标（桌面调试）也支持
      grab.style.touchAction = 'none';
    });

    const dock = $('#dock');
    let dy0 = 0;
    dock.addEventListener('touchstart', (e) => { dy0 = e.touches[0].clientY; }, { passive: true });
    dock.addEventListener('touchend', (e) => {
      const dy = e.changedTouches[0].clientY - dy0;
      if (dy < -40) openNP();
    });
  }

  /* ================= 弹窗 ================= */
  function modal(html, opts = {}) {
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.className = 'modal-wrap';
      wrap.innerHTML = `<div class="modal glass">${html}</div>`;
      document.body.appendChild(wrap);
      requestAnimationFrame(() => wrap.classList.add('on'));
      const close = (v) => {
        wrap.classList.remove('on');
        setTimeout(() => wrap.remove(), 260);
        resolve(v);
      };
      wrap.addEventListener('click', (e) => { if (e.target === wrap) close(null); });
      const ok = $('[data-ok]', wrap), cancel = $('[data-cancel]', wrap);
      if (ok) ok.addEventListener('click', () => close(opts.confirm ? true : ($('input', wrap) ? $('input', wrap).value : true)));
      if (cancel) cancel.addEventListener('click', () => close(null));
      const inp = $('input', wrap);
      if (inp) setTimeout(() => inp.focus(), 120);
      opts.onMount && opts.onMount(wrap, close);
    });
  }

  function promptDialog(title, hint, value) {
    return modal(`
      <h3>${esc(title)}</h3>
      <p>${esc(hint)}</p>
      <input class="modal-input" value="${esc(value || '')}" placeholder="${esc(hint)}" autocomplete="off">
      <div class="modal-btns"><button class="btn ghost" data-cancel>取消</button><button class="btn solid" data-ok>确定</button></div>
    `);
  }

  function confirmDialog(title, desc) {
    return modal(`
      <h3>${esc(title)}</h3>
      <p>${esc(desc)}</p>
      <div class="modal-btns"><button class="btn ghost" data-cancel>取消</button><button class="btn solid" data-ok>确定</button></div>
    `, { confirm: true });
  }

  function showLog() {
    const text = Log.nativeDump() || '(日志为空)';
    const where = Log.path();
    $('#logHint').textContent = where || '记录中';
    modal(`
      <h3>软件日志</h3>
      <p style="margin-bottom:6px">文件位置：<code style="font-family:var(--mono);font-size:10px">${esc(where)}</code></p>
      <div class="log-wrap"><pre>${esc(text)}</pre></div>
      <div class="modal-btns">
        <button class="btn ghost" id="logCopy">复制</button>
        <button class="btn solid" data-ok>关闭</button>
      </div>
    `, {
      confirm: true,
      onMount: (wrap) => {
        const btn = wrap.querySelector('#logCopy');
        if (!btn) return;
        // 复用统一实现：优先 navigator.clipboard（execCommand 在部分 WebView 已失效）
        btn.addEventListener('click', () => copyText(text, '已复制日志', '可以粘贴给开发者'));
      },
    });
  }

  function showAbout() {
    const v = (typeof RIPPLE_VERSION !== 'undefined' && RIPPLE_VERSION) || {};
    const verText = (v.name || '?') + ' · build ' + (v.code == null ? '?' : v.code);
    modal(`
      <h3>Ripple 涟漪</h3>
      <p>版本 ${verText}<br>一个会呼吸的手机音乐播放器。<br><br>
      液态玻璃单套观感；在线内容走网易云真实接口（weapi 加密），
      支持用你自己的账号登录、听每日推荐与会员曲目。</p>
      <p style="margin-top:10px;font-size:10.5px;line-height:1.8;opacity:.7">
      第三方客户端，不提供任何音乐资源，不绕过会员与版权限制。<br>
      在线内容版权归网易云音乐及权利人所有。<br><br>
      图标与示例音频为本项目原创，仅用于演示。</p>
      <div class="modal-btns"><button class="btn solid" data-ok>知道了</button></div>
    `, { confirm: true });
  }

  /* ================= Toast ================= */
  const ICONS = {
    info: 'i-info', check: 'i-check', warn: 'i-info', heart: 'i-heart', layout: 'i-lib',
    theme: 'i-moon', cloud: 'i-cloud', bell: 'i-bell', folder: 'i-folder', link: 'i-link',
    trash: 'i-trash', eq: 'i-eq', shuffle: 'i-shuffle', repeat: 'i-repeat', moon: 'i-moon',
    // 这两个以前缺了，"漫游中"/"已开始下载" 会 fallback 成信息图标
    infinite: 'i-infinite', download: 'i-download', comment: 'i-comment',
    list: 'i-list', order: 'i-order', user: 'i-user', qr: 'i-qr', queue: 'i-queue',
  };
  /*
   * Toast 栈。
   * 以前没有上限：连续十几条失败会把屏幕铺满，还会堆叠到看不见内容。
   * 现在最多同时 3 条，超出的从最老的开始收走；
   * 内容完全相同的连发（比如批量失败）只保留一条，避免刷屏。
   */
  const TOAST_MAX = 3;
  let _lastToastKey = '';
  let _lastToastAt = 0;

  function toast(title, desc, icon) {
    const wrap = $('#toasts');
    if (!wrap) return;
    const key = title + '\u0000' + (desc || '');
    const now = Date.now();
    // 同一内容 1.2 秒内不重复弹
    if (key === _lastToastKey && now - _lastToastAt < 1200) return;
    _lastToastKey = key;
    _lastToastAt = now;

    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = `<div class="ic"><svg><use href="#${ICONS[icon] || 'i-info'}"/></svg></div>
      <div class="ti"><b>${esc(title)}</b>${desc ? `<p>${esc(desc)}</p>` : ''}</div>`;
    wrap.appendChild(el);

    // 超出上限：把最老的立刻收走
    const alive = $$('.toast:not(.out)', wrap);
    while (alive.length > TOAST_MAX) {
      const o = alive.shift();
      o.classList.add('out');
      setTimeout(() => o.remove(), 320);
    }

    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320); }, 3200);
  }

  /* ================= 杂项 ================= */
  /* ================= 记忆上次播放（歌曲 + 进度 + 队列） ================= */

  /** 节流保存进度，避免每秒写 localStorage */
  let _progressAt = 0;
  function rememberProgress(force) {
    const t = Player.track;
    if (!t) return;
    const now = Date.now();
    if (!force && now - _progressAt < 4000) return;
    /* 「已听分钟」统计：顺手把两次调用之间真正在播的秒数累加进去。
       以前 Store.addPlayed() 定义了却从没人调用，统计永远显示 0。 */
    if (Player.playing && _progressAt) {
      const dt = (now - _progressAt) / 1000;
      if (dt > 0 && dt < 30) Store.addPlayed(dt);   // 超过 30s 视为挂起/后台，不计入
    }
    _progressAt = now;
    S().lastTrackId = t.id;
    S().lastPosition = Math.max(0, Player.time() || 0);
    // 队列只存 id，重启后重新映射到曲目对象
    const q = (Player.queue && Player.queue.length ? Player.queue : [t])
      .slice(0, 200).map((x) => x.id);
    S().lastQueue = q;
    S().queueIndex = Player.index;
    Store.save();
  }

  /** 把 id 列表还原成曲目对象（本地曲目、在线缓存、搜索结果都能找回来） */
  function tracksFromIds(ids) {
    if (!ids || !ids.length) return [];
    const out = [];
    for (const id of ids) {
      const t = findTrack(id);
      if (t) out.push(t);
    }
    return out;
  }

  async function restoreLast() {
    const id = S().lastTrackId;
    const savedPos = Math.max(0, Number(S().lastPosition) || 0);
    const savedQueue = Array.isArray(S().lastQueue) ? S().lastQueue : [];
    let t = id ? findTrack(id) : null;

    // 队列优先用上次保存的（顺序和内容都对），找不到就退回本地曲库
    let list = tracksFromIds(savedQueue);
    if (!list.length) {
      // 队列丢失（例如在线曲目不在缓存里）：至少把当前这首放进去
      list = t ? [t] : Store.all();
    } else if (t && !list.some((x) => x.id === t.id)) {
      list = list.concat([t]);
    }

    // 下标按「当前歌曲在队列中的真实位置」算，不要沿用旧下标
    let at = list.findIndex((x) => t && x.id === t.id);
    if (at < 0) at = Math.max(0, Math.min(list.length - 1, Number(S().queueIndex) || 0));
    App.context = list;

    if (!t) {
      // 没有记录：什么都不自动播，交给用户
      renderAll();
      return;
    }

    if (!t.src && (t.source === 'online' || /^ne_/.test(t.id))) {
      // 在线曲目重启后没有直链：先尝试解析，成功就恢复到上次位置
      Log.add('RESTORE', 'resolve online ' + t.title + ' neId=' + t.neId + ' pos=' + savedPos);
      /*
       * 从设定音质往下退，但最多退 2 档。
       * 原来一路退到 0（最多 5 次串行请求，每次最长 22s），
       * 连续点十几首歌就会打出几十个 song_url，很容易触发风控。
       */
      const lvTop = qualityLevel();
      const lvFloor = Math.max(0, lvTop - 2);
      for (let k = lvTop; k >= lvFloor; k--) {
        try {
          const got = await Netease.songUrl(t.neId, k);
          if (got && got.url) {
            t.src = got.url;
            t.format = (got.type || 'mp3').toUpperCase();
            Log.add('RESTORE', 'resolve ok level=' + got.level + ' trial=' + got.trial);
            break;
          }
        } catch (e) {
          Log.add('RESTORE', 'level ' + k + ' failed: ' + e.message);
        }
      }
    }

    if (!t.src) {
      // 还是拿不到音源（VIP/无版权/离线）：只恢复界面，点播放再重试
      Log.add('RESTORE', 'no src, ui only: ' + t.title);
      Player.track = t;
      Player.queueSet(list, at);
      updateDock();
      paletteFor(t);
      renderNP();
      updatePlayIcons(false);
      updateTimes();
      ensureLyric(t).catch(() => {});   // 界面已恢复，歌词随后补上
      return;
    }

    // 真正还原：设好队列 + 音源 + 上次进度，但不自动播放
    Player.queueSet(list, at);
    Player.track = t;
    Player.el = Player._pickEl(t);
    Player.el.src = new URL(t.src, location.href).href;
    Player.el.volume = S().volume;

    const applyPos = () => {
      const d = Player.el.duration;
      const pos = (isFinite(d) && d > 0) ? Math.min(savedPos, d - 1) : savedPos;
      if (pos > 0.5) {
        try { Player.el.currentTime = pos; } catch (e) {}
      }
      updateTimes();
      Log.add('RESTORE', 'restored ' + t.title + ' @' + pos.toFixed(1) + 's');
    };
    if (Player.el.readyState >= 1) applyPos();
    else Player.el.addEventListener('loadedmetadata', applyPos, { once: true });
    // 兜底：某些内核不触发 loadedmetadata
    setTimeout(applyPos, 1200);

    updateDock();
    paletteFor(t);
    renderNP();
    updatePlayIcons(false);
    /*
     * 恢复后必须自己拉一次歌词。
     * onlineCache 里不存歌词（太长），而以前只有 playOnline() 才会拉，
     * 走「重启恢复」这条路就永远是「♪」——必须切歌再切回来才有。
     */
    ensureLyric(t).catch(() => {});
    setTimeout(() => {
      syncLyric();
      updateTimes();
    }, 500);
  }

  async function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol === 'file:') return;
    try {
      await navigator.serviceWorker.register('sw.js');
    } catch (e) {}
  }

  App.play = playTrack;
  App.go = go;
  window.RippleApp = App;
  document.addEventListener('DOMContentLoaded', boot);
})();
