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
    /* hero 的漫游数据（见 loadRoamHero） */
    _roamHero: null,
    _roamHeroSeed: '',

    _dailyAt: 0,
    _topCache: null,
    /* 推荐歌单（首页区块 02）的缓存，与排行榜分开 —— 两个接口互不影响 */
    _recPlCache: null,
    _plCache: new Map(),   // plId -> 歌单详情
    /* 从「专辑 / 艺人」分组点进来的筛选：{ kind:'album'|'artist', name } */
    _libGroup: null,
  };

  /* ================= 启动 ================= */
  let _booted = false;
  async function boot() {
    /*
     * 防重入：DOMContentLoaded 与某些内核的 onPageFinished 都会推一次启动，
     * 重复执行 boot 会把 Player.init() 里的两个 <audio> 丢掉重建、
     * 并把下面那个 1 秒定时器再挂一份 —— 表现就是启动后立刻翻倍的
     * BARS: send / 每秒两次跨桥。这里保证只跑一次。
     */
    if (_booted) return;
    _booted = true;
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
        /*
         * safeMode 的症状很有辨识度：视口比正常矮约 60px、状态栏区域
         * 不被网页背景覆盖、整页内容往下移一截。用户完全不知道是为什么。
         *
         * 提示里直接给出自救入口（点一下调 clearSafeMode 清计数），
         * 而不是让用户一直停在降级状态里。
         */
        Log.add('BOOT', 'safeMode is ON');
        toastBottom('当前是安全模式', '状态栏未铺满、页面下移；点这里恢复正常', 'warn', 9000);
        const tip = $('#toastsBottom .toast:last-child');
        if (tip) {
          tip.style.pointerEvents = 'auto';
          tip.style.cursor = 'pointer';
          tip.addEventListener('click', () => {
            try {
              const ok = N.clearSafeMode ? N.clearSafeMode() : false;
              if (ok) {
                tip.remove();
                toastBottom('已恢复', '下次打开软件就是完整全屏', 'check');
              } else {
                toast('恢复失败', '可以到「我的 → 软件日志」把信息发给开发者', 'warn');
              }
            } catch (e) {
              toast('恢复失败', String(e && e.message || e), 'warn');
            }
          });
        }
      }
    } catch (e) {}

    renderClock();
    $('#helloTitle').textContent = greet() + '，欢迎回来';

    syncConnectionUI();
    refreshSystemBars();
    Log.add('BOOT', 'ready, logPath=' + Log.path());
    /* 进入软件不再弹「Ripple 已就绪」：每次启动都出现，纯噪音。
      在线接口不可用的情况在顶部连接状态区已有常驻标识。 */
    registerSW();
    /*
     * L-18：全局 1 秒定时器。
     * 以前它无条件跑：后台时照样每秒写 5 个 DOM 节点、并跨桥推进度，
     * 把原生侧 pauseTimers 的努力抵消掉。现在后台直接跳过；
     * 跨桥调用本身也加了值级幂等（见 pushMediaState / pushSbProgress）。
     * 句柄存下来，回到前台立刻补一次，避免进度显示停在离开时的那一秒。
     */
    /*
     * 左上角「时间 · 星期」。
     *
     * 以前只在 boot 时写一次，之后永远停在启动那一刻 ——
     * 早上打开、晚上再看还是「08:12」，用户会以为软件没刷新或时间错了。
     * 现在挂进每秒的 tick 里（那个定时器本来就在跑，成本几乎为零），
     * 并且只在文本真的变了时才写 DOM，避免每秒都动一次布局。
     *
     * 跨天时星期也要跟着换，所以不能只更新分钟。
     */
    /*
     * 注意：变量声明必须写在 boot 的最前面。
     * renderClock() 在 boot() 中间就被调用了一次，而 `let` 声明在
     * 同作用域里是「暂时性死区」（TDZ）—— 声明位置之前访问会直接抛
     * ReferenceError，整个 boot 就此中断，页面看起来像「什么都没加载」。
     * 这里把它提到函数开头（紧跟 boot 定义之后的位置）。
     */
    var _lastClock = '';
    function renderClock() {
      const el = $('#helloDate');
      if (!el) return;
      const d = new Date();
      const txt = d.getHours().toString().padStart(2, '0') + ':'
        + d.getMinutes().toString().padStart(2, '0')
        + ' · 星期' + '日一二三四五六'[d.getDay()];
      if (txt === _lastClock) return;
      _lastClock = txt;
      el.textContent = txt;
    }

    function startTicker() {
      clearInterval(App._tickTimer);
      App._tickTimer = setInterval(() => {
        if (document.hidden) return;
        renderClock();                             // 左上角时间每分钟（跨天含星期）自动更新
        Player.updatePositionState();
        updateTimes();
        rememberProgress(false);
        if (Player.track) pushMediaState(false);   // 通知栏进度条
        pushSbProgress();                          // 状态栏歌词的填充进度
      }, 1000);
    }
    /*
     * H-4：以前只在回调里判断 document.hidden —— 定时器本身一直在跑，
     * 后台每秒照样醒来两次。现在进后台直接 clearInterval（省电、减少后台唤醒），
     * 回前台再重建并立刻对齐一次时间轴。
     */
    startTicker();
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        clearInterval(App._tickTimer);
        App._tickTimer = null;
        return;
      }
      startTicker();
      updateTimes();
      if (Player.track) pushMediaState(false);
      pushSbProgress();
    });

    // 启动后异步拉在线内容（失败不打扰）
    /*
     * 以前是 refreshAccount().then(() => loadHomeOnline()) —— 串行。
     * 而 status 内部 4 次串行请求、最坏 60 秒，已登录用户弱网下
     * 首页会长时间停在骨架屏。每日推荐/榜单这些内容本就不依赖账号，
     * 所以并行发起：账号查询自己有超时兜底，不该拖住首页。
     */
    loadHomeOnline();
    refreshAccount().catch(() => {});
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
    /*
     * 这里以前直接 syncSystemBars(bg)（写死的 #07070B），而 paletteFor /
     * refreshSystemBars 用的是从 CSS 变量算出来的颜色 —— 同一个状态栏
     * 一次启动被推两个不同的值，日志里就是成对的 BARS: send。
     * 统一走 refreshSystemBars（同一帧内合并、值没变不重复跨桥）。
     */
    refreshSystemBars();
    $('#btnTheme').innerHTML = theme === 'light'
      ? '<svg><use href="#i-moon"/></svg>' : '<svg><use href="#i-sun"/></svg>';
    $$('#themeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.theme === S().theme));
  }

  /**
   * 把窗口背景色同步给原生状态栏（否则顶上会是一条纯黑）。
   *
   * 跨桥调用是启动期最主要的重复开销：一次启动里 applyTheme / renderAll /
   * paletteFor / refreshSystemBars 各自都会调一次，日志里就是两三秒内好几条
   * `BARS: send`。这里做值级幂等 —— 颜色和明暗都没变就不再跨桥、不再写日志。
   */
  let _lastBarsKey = '';
  function syncSystemBars(bg, lightTheme, force) {
    const N = window.RippleNative;
    if (!N || typeof N.systemBars !== 'function') {
      Log.add('BARS', 'no native bridge, skip ' + bg);
      return;
    }
    const key = bg + '|' + (lightTheme ? 1 : 0);
    if (!force && key === _lastBarsKey) return;   // 值没变：不跨桥、不写日志
    _lastBarsKey = key;
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

  /**
   * 页面/取色变化后刷新状态栏。
   * 注意 currentBarColor() 会 getComputedStyle 读 CSS 变量 —— 本身不便宜，
   * 而它被 applyTheme / paletteFor / go() / openNP / closeNP 各调一次。
   * 这里合并同一帧内的多次调用（批量提交），避免启动与切歌时连续读样式。
   */
  let _barsRaf = 0;
  function refreshSystemBars() {
    if (_barsRaf) return;
    _barsRaf = requestAnimationFrame(() => {
      _barsRaf = 0;
      syncSystemBars(currentBarColor(), resolvedTheme() === 'light');
    });
  }

  /** 按设置里的 eq / eqCustom 真正下发到音频图 */
  function applyEQFromSettings() {
    const s = S();
    if (s.eq === 'custom' && Array.isArray(s.eqCustom)) {
      Player.setEQBands(s.eqCustom);
    } else {
      Player.setEQ(s.eq);
    }
    /*
     * F-5：均衡器状态有两个显示面（设置页那一行 + 弹层面板），
     * 而 renderEQ() 以前只在「打开面板」时执行。于是在别处改了 EQ
     * （恢复默认设置、切歌导致可用性变化）后，面板/那一行显示的还是旧状态。
     * 这里统一收口：下发完就同步两个显示面（面板关着时不重建，省开销）。
     */
    refreshEQUI();
  }

  /**
   * 均衡器的显示面统一刷新：
   * · 设置页那一行（文本，便宜，总是刷）
   * · 弹层面板（贵，只在打开时重建）
   */
  function refreshEQUI() {
    /* H-11：以前这两个 catch 是空的 —— 面板空白时日志里什么都没有，没法排查 */
    try { syncEQHint(); } catch (e) { if (window.Log) Log.err('EQ', e, 'syncEQHint'); }
    const sheet = $('#eqSheet');
    if (sheet && sheet.classList.contains('on')) {
      try { renderEQ(); } catch (e) { if (window.Log) Log.err('EQ', e, 'renderEQ'); }
    }
  }

  function applyVars() {
    const r = document.documentElement.style;
    const k = Math.max(0.4, Math.min(2.5, Number(S().animSpeed) || 1));
    r.setProperty('--glass-blur', S().glassBlur + 'px');
    /*
     * 液态玻璃强度：把「玻璃强度」滑块的 0~40px 折算成 0~1。
     *
     * 为什么需要这个额外的量：blur 的 px 值只控制「模糊多大」，
     * 而液态玻璃还有折射位移、反射高光、按压响应这一整套 ——
     * 它们都应该跟着同一个滑块一起变强变弱，不能只改模糊。
     * 用 0~1 的归一化值去缩放这三项的幅度（见 base.css 的液态玻璃段落）。
     *
     * 40px 是滑块上限，对应「最强」；0 就是完全没有玻璃效果。
     */
    const gs = Math.max(0, Math.min(1, (Number(S().glassBlur) || 0) / 40));
    r.setProperty('--glass-strength', gs.toFixed(3));
    /*
     * 强度为 0 时给 <html> 挂 lg-off，CSS 那边据此彻底关掉 backdrop-filter。
     * 这不只是省性能 —— 强度 0 时还保留模糊会显得参数没生效。
     */
    document.documentElement.classList.toggle('lg-off', gs <= 0.02);
    r.setProperty('--anim', k);
    /* 动画速度拆成三档时长，CSS 里按用途取用：
       --dur    普通过渡（背景、颜色、悬停）
       --dur-s  快档（按钮按压、图标）
       --dur-l  慢档（面板滑出、播放页推入）
       总时长 = 基准 / 速度倍率，1.0 时与原来手写的数值一致。 */
    r.setProperty('--dur', (0.42 / k).toFixed(2) + 's');
    r.setProperty('--dur-s', (0.22 / k).toFixed(2) + 's');
    r.setProperty('--dur-l', (0.52 / k).toFixed(2) + 's');
    /*
     * 展开/收回（封面 + 歌词）单独一档：基准 .3s，随速度倍率缩放，
     * 但**上限 0.3s** —— 主人要求这段动画不超过 0.3 秒，
     * 以前速度调到 0.5× 会变成 0.6s。
     */
    r.setProperty('--dur-ani', Math.min(0.3, 0.3 / k).toFixed(2) + 's');
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
    /*
     * 取色是唯一「要下封面图 + 画进 canvas + 读像素」的路径，
     * 而 paletteFor 会被 Player.on('track') / applyTheme / 系统主题变化各调一次，
     * 同一首歌常常连着跑两三遍（启动期尤其明显）。
     * 这里按「曲目签名 + 主题 + 动态色开关」做幂等：同一份输入直接跳过。
     */
    const sig = (track ? coverOf(track) : '') + '|' + resolvedTheme() + '|' + (S().dynamicColor ? 1 : 0);
    if (sig === App._paletteSig) return;
    App._paletteSig = sig;
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
    // F-17：补上单引号转义。属性里用双引号时单引号不影响，但只要有一处
    // 写成单引号属性（或拼接进 onclick 之类），不转义就是注入点。
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /**
   * F-4：封面 URL 是唯一没走 esc() 就直接进 innerHTML 的字段（在线曲目来自
   * 网易云返回的 picUrl）。这里统一过一遍：只放行 http/https/相对地址/data:image，
   * 其他协议（javascript:、file: 等）一律退回内置渐变色封面。
   */
  function safeCoverUrl(url) {
    const s = String(url == null ? '' : url).trim();
    if (!s) return '';
    if (/^(https?:)?\/\//i.test(s) || /^data:image\//i.test(s)) return s;
    /*
     * 相对路径（assets/a.png、./x.png、../x.png）没有协议头，是安全的；
     * 判断方式：第一个 '/' 之前不出现 ':'，就不会是 javascript:/vbscript:/file:。
     */
    const head = s.split('/')[0];
    if (head.indexOf(':') < 0 && !/^\s*javascript:/i.test(s)) return s;
    return '';                                    // 其他协议：丢弃，调用方会退回默认封面
  }

  /** 进 innerHTML 属性用（还要做 HTML 转义） */
  function safeCover(url) {
    return esc(safeCoverUrl(url));
  }

  /** 进 style.backgroundImage 用（不能做 HTML 转义，否则 URL 里的 & 会被写坏） */
  function cssUrl(url) {
    const s = safeCoverUrl(url);
    if (!s) return '';
    /* H-14：只转义 \ 和 " 不够 —— 含 ) 会直接截断 url()，换行/控制字符同理 */
    return 'url("' + s.replace(/[\\"()\u0000-\u001f\u007f]/g, '') + '")';
  }

  function artHTML(t, cls) {
    const cover = safeCover(coverOf(t));
    return `<div class="${cls} art"><img src="${cover}" alt="" loading="lazy"><div class="ripple"></div></div>`;
  }

  /*
   * 会员/付费曲目的统一判定。
   *
   * 以前是两处各写一套：列表行只看 t.vip，播放页还额外认 fee===1/4 与
   * privilege.fee===1。后果是同一首歌在列表里显示普通音质标签、
   * 进播放页却冒出 VIP 角标，用户会以为标签判错了。
   *
   * fee：1 = 需要会员，4 = 付费专辑/单曲，8 = 免费试听（不算会员）。
   */
  function isVipTrack(t) {
    if (!t || t.source !== 'online') return false;
    return !!(t.vip || t.fee === 1 || t.fee === 4 || (t.privilege && t.privilege.fee === 1));
  }

  function rowHTML(t, i, isOn) {
    const vip = isVipTrack(t);
    const fmt = vip ? 'VIP' : (t.format || '');
    const cls = /Hi-Res|FLAC|ALAC|DSD/i.test(fmt) ? ' hi' : (vip ? ' vip' : '');
    /*
     * tabindex="0" + role="button" 让键盘/读屏能用。
     *
     * 以前这些行全是纯 div，没有 tabindex、没有 role、没有键盘激活 ——
     * 全站 grep tabindex/role 在 app.js 里 0 命中。
     * 后果是"用键盘或读屏播一首歌"在结构上就不可能：
     * Tab 一遍只会停在顶栏 3 个按钮、tabbar 4 个链接、滑块与开关上。
     * 激活逻辑由 document 上的 keydown 委派统一处理（见 bindRowKeyboard）。
     * aria-label 给读屏一句完整的话，否则它只会念出一堆无关联的文本。
     */
    const label = [t.title, t.artist].filter(Boolean).join(' - ')
      + (t.duration ? '，' + fmtTime(t.duration) : '');
    return `<div class="row${isOn ? ' on' : ''}" data-id="${esc(t.id)}"
      role="button" tabindex="0" aria-label="${esc(label)}">
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
    return `<div class="gcard${isOn ? ' on' : ''}" data-id="${esc(t.id)}"
      role="button" tabindex="0" aria-label="${esc([t.title, t.artist].filter(Boolean).join(' - '))}">
      ${artHTML(t, 'th')}
      <b>${esc(t.title)}</b><span>${esc(t.artist)}</span>
    </div>`;
  }

  function carouselHTML(items) {
    return items.map((it) => `<div class="c-card" data-pl="${it.plId || ''}" data-id="${it.id || ''}"
      role="button" tabindex="0" aria-label="${esc([it.title, it.sub].filter(Boolean).join(' - '))}">
      ${artHTML(it, 'c-art')}
      <div class="c-k">${esc(it.kind || '歌单')}</div>
      <div class="c-tx"><b>${esc(it.title)}</b><span>${esc(it.sub || '')}</span></div>
      <div class="c-play"><svg width="12" height="12"><use href="#i-play"/></svg></div>
    </div>`).join('');
  }

  function plRowHTML(p) {
    // F-17：data-pl 以前是裸插（esc 也只管 title/sub），属性值一律走 esc()
    return `<div class="plrow" data-pl="${esc(p.plId)}"
      role="button" tabindex="0" aria-label="${esc([p.title, p.sub, p.creator].filter(Boolean).join(' - '))}">
      ${artHTML(p, 'th')}
      <div class="tx"><b>${esc(p.title)}</b><span>${esc(p.sub || '')}${p.creator ? ' · ' + esc(p.creator) : ''}</span></div>
      <div class="go"><svg><use href="#i-chev-right"/></svg></div>
    </div>`;
  }

  /**
   * 歌单的网格卡（首页「推荐歌单 → 更多」展开时用）。
   *
   * 和 gridHTML 的区别只在数据字段：歌单走 data-pl（点击打开歌单详情），
   * 歌曲走 data-id（点击播放）。视觉上完全复用 .gcard 的样式，
   * 所以两种卡片在同一页里看起来是一套。
   */
  function plGridHTML(p) {
    return `<div class="gcard" data-pl="${esc(p.plId)}"
      role="button" tabindex="0" aria-label="${esc([p.title, p.sub, p.creator].filter(Boolean).join(' - '))}">
      ${artHTML(p, 'th')}
      <b>${esc(p.title)}</b><span>${esc(p.sub || '')}</span>
    </div>`;
  }

  function renderAll() {
    renderHome();
    renderLibrary();
    /*
     * 搜索页要单独判断：这里以前无条件调 renderSearchDefaults()，
     * 而它会把 #searchBody 整个清空、再放回热搜。
     * 于是「点♥ / 导入音乐 / 清空本机 / 恢复默认 / 同步我喜欢」任一次
     * 都会把用户当前的搜索结果抹掉，搜索框里的关键词却还在 ——
     * 变成「有关键词、没结果」。
     *
     * 只在「当前不在搜索页」或「搜索框是空的」时才重置：
     * 用户正看着结果集时，renderAll 不应该动它。
     */
    const kw = ($('#searchInput') && $('#searchInput').value || '').trim();
    if (App.page !== 'search' || !kw) renderSearchDefaults();
    syncSettingsUI();
    updateDock();
    renderNP();
    const mb = (Store.localTracks.reduce((a, t) => a + (t.size || 0), 0) / 1048576).toFixed(1);
    $('#storageHint').textContent = Store.localTracks.length + ' 首 · ' + mb + ' MB';
    updateAccountCard();
  }

  /* ================= 首页 ================= */
  /*
   * 首页 / 曲库的「数据签名短路」。
   * 切歌时 Player.on('track') 会调 renderHome() + renderLibrary()，
   * 而这两个函数以前无条件 innerHTML 重建整块列表 —— 平板上 300 首曲库
   * 每切一次歌就要重新布局一遍几百个行节点。现在先算签名：
   * 曲目集合、当前曲目、筛选/分组都没变就直接返回，一次 DOM 都不碰。
   */
  function listSig(list, extra) {
    let h = 0;
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      const s = t.id + '\u0001' + (t.title || '') + '\u0001' + (t.artist || '') + '\u0001' + (t.album || '')
        /*
         * 末尾要带上 VIP 角标的**全部**输入：角标现在由 isVipTrack() 判定
         * （vip / fee / privilege.fee 三者任一），只把 t.vip 算进签名的话，
         * 同一批曲目换了 fee 字段签名不变，行就不会重建、角标还停在旧的。
         */
        + '\u0001' + (t.cover || '') + '\u0001' + (t.duration || 0) + '\u0001' + (t.format || '')
        + '\u0001' + (t.vip ? 1 : 0) + '\u0001' + (t.fee || 0)
        + '\u0001' + ((t.privilege && t.privilege.fee) || 0);
      for (let k = 0; k < s.length; k++) h = (h * 31 + s.charCodeAt(k)) | 0;
      h = (h * 31 + i) | 0;
    }
    return (extra || '') + '|' + list.length + '|' + h;
  }

  /*
   * ============ hero 的漫游数据 ============
   *
   * 拉「从某个种子出发的相似歌曲」，取第一首当 hero 的展示内容。
   *
   * 两个要点：
   *   ① 结果按种子 id 缓存，同一种子不重复请求（切歌回来不会重打接口）；
   *   ② 冷启动时先用 localStorage 里上一次的结果，网络回来再平滑替换 ——
   *      否则每次进软件 hero 都先空一块（用户报过这个）。
   */
  function pickSeedForRoam() {
    const cur = Player.track;
    if (cur && cur.source === 'online' && cur.neId) return cur;
    /* ② 我喜欢的第一首在线歌 —— liked 里存的是 id，需要找回到曲目对象 */
    const liked = Store.state.liked || [];
    for (let i = 0; i < liked.length; i++) {
      const id = liked[i];
      if (String(id).indexOf('ne_') !== 0) continue;   // 只取在线曲目
      const t = findTrack(id) || Store.cached().find((x) => x.id === id);
      if (t && t.neId) return t;
    }
    /* ③ 每日推荐里随机一首（按天固定，同一天内不跳） */
    const daily = App._dailyCache;
    if (daily && daily.length) {
      const d = new Date();
      const dayKey = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
      const t = daily[dayKey % daily.length];
      if (t && t.neId) return t;
    }
    return null;
  }

  const ROAM_HERO_KEY = 'ripple.roamHero.v1';
  let _roamHeroBusy = false;
  /* busy 期间又来的 force 请求：只保留最后一个，当前这轮结束后补跑 */
  let _roamHeroQueued = null;
  let _roamHeroBusyPromise = null;

  function loadRoamHeroCache() {
    try {
      const raw = localStorage.getItem(ROAM_HERO_KEY);
      if (!raw) return null;
      const o = JSON.parse(raw);
      if (!o || !o.track) return null;
      return o;
    } catch (e) { return null; }
  }

  function saveRoamHeroCache(seedId, track) {
    try {
      localStorage.setItem(ROAM_HERO_KEY, JSON.stringify({
        seedId: seedId, track: track, at: Date.now(),
      }));
    } catch (e) {}
  }

  /**
   * 拉取漫游 hero。seed 为 null 时什么都不做（没种子就显示兜底卡片）。
   * force 为真时忽略「同种子已缓存」的短路（用户点刷新/切歌后强制更新）。
   *
   * force 请求撞上在飞的同名请求时不再被直接丢弃：排队等前一个结束再跑。
   * 以前是静默 return 旧 hero，调用方却照样 toast「换了一首」+ 旧歌名，
   * 用户会觉得按钮点了个寂寞。
   */
  async function loadRoamHero(seed, force) {
    if (!seed || !seed.neId) { App._roamHero = null; return null; }
    if (!Netease.ready) return null;
    /* 同一个种子已经拉过：直接复用，不重复打接口 */
    if (!force && App._roamHeroSeed === seed.neId && App._roamHero) return App._roamHero;
    if (_roamHeroBusy) {
      /*
       * 正在拉的时候用户又点了「换一首」：记下待办，当前这一轮结束后再拉一次。
       * 只保留最后一次请求（连点多次没必要排一长串）。
       */
      if (!force) return App._roamHero;
      _roamHeroQueued = seed;
      return _roamHeroBusyPromise;
    }
    _roamHeroBusy = true;
    _roamHeroBusyPromise = (async () => {
      try {
        const list = await Netease.roamSongs(seed.neId, 12);
        /*
         * 挑一首当 hero：跳过种子本身（否则封面和「当前播放」重复），
         * 按天做确定性随机，同一天内不会每次刷新都跳。
         * force 时错开一位，否则同一天同一批候选永远挑到同一首，
         * 「换一首」点了等于没点。
         */
        const pool = list.filter((x) => x && x.neId && x.neId !== seed.neId);
        const use = pool.length ? pool : list;
        if (!use.length) return null;
        const d = new Date();
        const dayKey = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
        const picked = use[(dayKey + (force ? 1 : 0)) % use.length];
        App._roamHero = picked;
        App._roamHeroSeed = seed.neId;
        saveRoamHeroCache(seed.neId, picked);
        Log.add('ROAM', 'hero <- ' + picked.title + ' (seed ' + seed.title + ', ' + use.length + ' 候选)');
        /* 数据变了必须重绘（清签名） */
        App._homeSig = '';
        renderHome();
        return picked;
      } catch (e) {
        Log.err('ROAM', e, 'loadRoamHero seed=' + (seed && seed.neId));
        return null;
      }
    })();
    try {
      return await _roamHeroBusyPromise;
    } finally {
      _roamHeroBusy = false;
      /* 期间又有人点了「换一首」：补跑一次，把最新的展示出来 */
      const queued = _roamHeroQueued;
      _roamHeroQueued = null;
      if (queued) loadRoamHero(queued, true).catch(() => {});
    }
  }

  /*
   * 冷启动先把上次的漫游 hero 恢复出来。
   * 这样首页第一帧就有封面，不用等网络回来（用户报过「重进没封面」）。
   *
   * 注意位置：必须放在 ROAM_HERO_KEY / loadRoamHeroCache 定义**之后**。
   * 它们是 const/function 混用，`const` 在声明前访问会触发 TDZ 直接抛错，
   * 而且这个错发生在 boot 阶段，会让整个首页渲染中断。
   */
  (function restoreRoamHero() {
    try {
      const c = loadRoamHeroCache();
      if (c && c.track) {
        App._roamHero = c.track;
        App._roamHeroSeed = c.seedId || '';
        Log.add('ROAM', 'hero restored from cache: ' + (c.track.title || ''));
      }
    } catch (e) { Log.err('ROAM', e, 'restoreRoamHero'); }
  })();

  function renderHome() {
    const cur = Player.track;
    const rec = Store.recent(6);
    const list = (rec.length ? rec : Store.all()).slice(0, 6);
    /*
     * hero 的取图优先级：
     *   ① 每日推荐第一首（有真实封面，最贴「今日推荐」的语义）
     *   ② 最近播放 / 曲库里的第一首（也有真实封面）
     *   ③ 都没有 → coverOf(undefined) 会给一张固定的渐变兜底图
     *
     * ①② 都能出真封面；只有全新安装、且在线推荐还没回来的那一两秒
     * 会落到 ③。等推荐回来时必须重刷一次（见 loadHomeOnline）。
     */
    /*
     * ============ hero：无限漫游的入口 ============
     *
     * hero 展示的是「漫游推荐里的一首歌」，点它直接开启漫游模式
     * （把相似歌曲灌满队列），而不是只播这一首。
     *
     * 数据来自 Netease.roamSongs(seedId) —— 网易云的
     * v1/discovery/simiSong（相似歌曲）。它**必须有种子歌曲**，所以按优先级取：
     *   ① 当前正在播放的在线歌（最贴「你现在想听什么」）
     *   ② 我喜欢的第一首在线歌
     *   ③ 每日推荐里随机一首
     *   ④ 都没有 → 只能显示普通的兜底卡片，点进去提示需要先播一首
     *
     * 漫游结果缓存在 App._roamHero，按种子 id 失效；
     * 冷启动时先用上一次的缓存（App._roamHeroCache，落 localStorage），
     * 避免「每次进来都是灰块」。
     */


    const roamSeed = pickSeedForRoam();
    const hourNow = new Date().getHours();
    /*
     * hero 当前展示的那首歌。
     *
     * 来源优先级：
     *   ① 漫游回来的第一首（App._roamHero，见 loadRoamHero）
     *   ② 种子歌本身（漫游还没回来 / 请求失败）
     *   ③ coverOf(null) 的渐变兜底
     *
     * 缓存也参与：冷启动时先用 localStorage 里上一次的 hero，
     * 网络回来再替换 —— 这样不会每次进软件都先空一块。
     */
    const roamHero = App._roamHero || null;
    const hero = roamHero || roamSeed || null;
    /*
     * 签名必须包含封面的实际 URL：hero 会在「种子 → 漫游结果」之间切换，
     * 如果只比较 id，切换瞬间可能算出相同签名导致不重绘，封面就停在旧图上。
     */
    const heroCoverSrc = coverOf(hero);
    const sig = listSig(list, (cur ? cur.id : '') + '|' + hourNow
      + '|' + (hero ? hero.id : '')
      + '|' + (roamSeed ? roamSeed.id : '')
      + '|' + (App._dailyCache ? App._dailyCache.length : 0) + '|' + (Netease.loggedIn ? 1 : 0)
      + '|' + heroCoverSrc.length + '|' + heroCoverSrc.slice(-24));
    if (sig === App._homeSig) return;          // 数据和当前曲目都没变：跳过整轮 DOM 写入
    App._homeSig = sig;

    /* 只在真的变了时才写 src：重复赋同一个 URL 也会触发一次加载/重绘，
       首页每次 renderAll 都调这里，会造成封面轻微闪一下。 */
    const artEl = $('#heroArt');
    if (artEl && artEl.getAttribute('src') !== heroCoverSrc) artEl.src = heroCoverSrc;
    /*
     * 首页大标题以前写死「深夜的低频」，早上打开也是「深夜」，很出戏。
     * 现在按时段给一句话，并且今日的歌有真实标题时优先用它。
     */
    const heroHour = hourNow;
    /*
     * 主标题：hero 现在是「无限漫游」入口，文案也要跟着这个语义走 ——
     * 按时段给一句「带你一直听下去」的邀请，而不是描述某首歌。
     */
    const HERO_LINES = [
      [5, '天快亮了，<br>沿着这首歌听下去'],
      [9, '早上好，<br>从一首歌出发'],
      [12, '中午了，<br>让歌带你走一段'],
      [14, '下午的光正好，<br>顺着歌单漫游'],
      [18, '傍晚了，<br>让耳朵自己找下一首'],
      [22, '夜色上来，<br>一直听下去'],
      [24, '深夜很长，<br>歌会一首接一首'],
    ];
    const heroLine = (HERO_LINES.find(([h]) => heroHour < h) || HERO_LINES[HERO_LINES.length - 1])[1];
    $('#heroTitle').innerHTML = heroLine;
    /*
     * hero 现在是**漫游入口**：
     *   · kicker 写「无限漫游」，明确这一块是干什么的
     *   · 副标题放当前展示的这首歌（漫游推荐 / 种子），点进去就按它漫游
     */
    $('#heroKicker').textContent = roamSeed ? '无限漫游' : '还没有可漫游的歌';
    $('#heroSub').textContent = hero && hero.title
      ? `${hero.title}${hero.artist ? ' · ' + hero.artist : ''}`
      : '先播一首在线歌曲，或收藏几首，这里会从它们出发';
    /* 主按钮文案也跟着变：它现在是「开启漫游」而不是「播放今天推荐」 */
    const heroPlayBtn = $('#btnHeroPlay');
    if (heroPlayBtn) {
      heroPlayBtn.innerHTML = '<svg width="13" height="13"><use href="#i-infinite"/></svg>'
        + (roamSeed ? '无限漫游' : '先播一首');
    }

    /*
     * 首页的「最近播放」区块已移除（改为「推荐歌单」）。
     * 这两个容器现在在 HTML 里不存在，$() 返回 null ——
     * 直接写 .innerHTML 会抛 TypeError 把整个 renderHome 打断，
     * 连上面的 hero 更新都白做。所以必须判空。
     * 保留这段渲染是为了兼容旧缓存页面（SW 可能还在供旧 HTML）。
     */
    const gv = $('#gridView');
    if (gv) gv.innerHTML = list.map((t) => gridHTML(t, cur && cur.id === t.id)).join('');
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

  /**
   * 第 12 条：首屏骨架。
   * 以前首屏是一片空白等到每日推荐回来，看起来像卡死。
   * 只给两个在线横滑区铺占位 —— 下面的网格有本地「最近播放」可以立刻填，
   * 铺骨架反而会闪一下。
   */
  function renderSkeletonHome() {
    const card = `<div class="c-card sk-card"><div class="sk-box"></div>
      <i class="sk-line" style="width:70%"></i><i class="sk-line" style="width:44%"></i></div>`;
    $('#carousel').innerHTML = card + card + card;
    const tl = $('#toplistCarousel');
    if (tl) tl.innerHTML = card + card + card;
  }

  /**
   * 丢掉首页的三份在线缓存（每日推荐 / 推荐歌单 / 排行榜）。
   *
   * 「刷新资料」以前只清 App._myPl 就调 loadHomeOnline()，而后者对这三份
   * 都有 10 分钟级的缓存短路（见 939/1005 的判断），于是刷新完首页纹丝不动，
   * 用户只能等 TTL 过期或者杀进程重开。
   */
  function invalidateHomeCaches() {
    App._dailyCache = null;
    App._dailyAt = 0;
    App._recPlCache = null;
    App._topCache = null;
    App._homeSig = '';        // 数据换了，签名必须作废，否则 renderHome 直接返回
  }

  /** 拉在线首页内容：每日推荐 + 排行榜 */
  async function loadHomeOnline() {
    if (!Netease.ready) {
      renderCarousel([], '在线功能不可用');
      $('#toplistCarousel').innerHTML = '<div class="c-card ghost">填好接口后再来</div>';
      return;
    }
    // 首次加载、还没有任何缓存时先铺骨架（有缓存就不要闪）
    if (!App._dailyCache && !App._topCache) renderSkeletonHome();
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
          /*
           * 关键：推荐数据回来了必须重刷首页。
           *
           * 以前这里只更新了下面的横滑卡片，**没有重绘 hero** ——
           * 于是开始那张「和一点失真的暖意」大卡片会一直停在
           * 启动瞬间的兜底图（一块灰色渐变色块），
           * 直到用户切页面、切歌才碰巧重绘一次。
           * 这就是「每次重进软件随机卡片都没有歌曲封面」。
           */
          App._homeSig = '';        // 清掉签名，强制 renderHome 真的跑
          renderHome();
          /*
           * 推荐回来了 → 现在有稳定的种子了，顺手拉一次漫游 hero。
           * 不 await：hero 换图是锦上添花，不该挡住下面的卡片渲染。
           */
          loadRoamHero(pickSeedForRoam()).catch(() => {});
          /* 封面是网络图，回来再补一次：首帧可能还是占位 */
          const artEl = $('#heroArt');
          if (artEl && songs[0] && songs[0].cover) {
            const want = coverOf(songs[0]);
            artEl.onload = null;
            if (artEl.getAttribute('src') !== want) artEl.src = want;
          }
        }
      } catch (e) {
        renderCarousel([], e.needLogin ? '登录后可见每日推荐' : '推荐加载失败');
        /*
         * 推荐失败了，但 hero 不该停在那张渐变兜底图上 ——
         * 只要本地有播放记录/曲库，就用它们的封面。
         * 用户重进软件时大部分情况是有历史记录的，这样至少不会是一块灰。
         */
        App._homeSig = '';
        renderHome();
      }
    } else if (App._dailyCache.length) {
      renderCarousel(App._dailyCache.slice(0, 10).map((t) => ({
        id: t.id, title: t.title, sub: t.artist, cover: t.cover, kind: '推荐',
      })), '暂无推荐');
    }

    // 推荐歌单（区块 02）：personalized 接口，与排行榜分开缓存
    if (!App._recPlCache) {
      try {
        App._recPlCache = await Netease.personalizedPlaylists(10);
      } catch (e) {
        App._recPlCache = [];
      }
    }
    const recPlEl = $('#recPlCarousel');
    if (recPlEl) {
      recPlEl.innerHTML = App._recPlCache && App._recPlCache.length
        ? carouselHTML(App._recPlCache)
        : '<div class="c-card ghost">推荐歌单加载失败<br>下拉重试</div>';
    }

    // 排行榜（区块 03）
    if (!App._topCache) {
      try {
        App._topCache = await Netease.toplist();
      } catch (e) {
        App._topCache = [];
      }
    }
    const topEl = $('#toplistCarousel');
    if (topEl) {
      topEl.innerHTML = App._topCache && App._topCache.length
        ? carouselHTML(App._topCache)
        : '<div class="c-card ghost">榜单加载失败<br>下拉重试</div>';
    }
    /*
     * 每日推荐是在启动之后异步回来的，而 renderHome 的 hero 封面取的是
     * App._dailyCache[0]。以前这里不重刷首页，于是首屏大图永远是「最近播放」
     * 的封面，要等下一次切歌才换成每日推荐。现在签名的输入里已经包含
     * _dailyCache 的长度，重刷一次很便宜（数据没变会直接短路）。
     */
    renderHome();
  }

  function renderCarousel(items, emptyText) {
    $('#carousel').innerHTML = items.length
      ? carouselHTML(items)
      : `<div class="c-card ghost">${esc(emptyText || '暂无内容')}</div>`;
  }

  function libFiltered(opts) {
    let list = Store.all();
    if (App.filter === 'local') list = list.filter((t) => t.source === 'local');
    else if (App.filter === 'lossless') list = list.filter((t) => /FLAC|Hi-Res|ALAC|DSD/i.test(t.format || ''));
    else if (App.filter === 'online') list = list.filter((t) => t.source === 'online');
    /*
     * 从「专辑 / 艺人」分组点进来的筛选（App._libGroup）。
     * 只看「歌曲」tab：分组视图自己不能再被它过滤，
     * 否则点了某个专辑后再切「专辑」tab，聚合结果里只剩那一张。
     */
    const g = App._libGroup;
    if (g && !(opts && opts.noGroup)) {
      if (g.kind === 'album') list = list.filter((t) => (t.album || '未知专辑') === g.name);
      else if (g.kind === 'artist') list = list.filter((t) => (t.artist || '未知艺人') === g.name);
    }
    return list;
  }

  /* 切回「歌曲」tab，并把分段高亮同步过去 */
  function setLibSeg(seg) {
    App._libSeg = seg;
    $$('#segline b').forEach((x) => x.classList.toggle('on', x.dataset.seg === seg));
  }

  function renderLibrary() {
    const seg = App._libSeg || 'songs';
    /*
     * 「歌曲」tab 用带分组筛选的列表；分组视图用不带分组筛选的列表 ——
     * 否则点进某个专辑后再切「专辑」tab，聚合结果里只剩那一张专辑。
     */
    const list = seg === 'songs' ? libFiltered() : libFiltered({ noGroup: true });
    const cur = Player.track;
    // 数据签名没变就直接返回：切歌时只有「当前曲目高亮」会变，
    // 曲目集合没变就不该重建几百行 DOM（平板上这是切歌卡顿的主因之一）
    const sig = listSig(list, seg + '|' + (cur ? cur.id : '') + '|' + (App.filter || '')
      + '|' + (App._libGroup ? App._libGroup.kind + ':' + App._libGroup.name : ''));
    if (sig === App._libSig) return;
    App._libSig = sig;
    if (seg !== 'songs') {
      renderLibGrouped(list, seg, cur);
      return;
    }
    const g = App._libGroup;
    $('#libList').innerHTML = list.length
      ? list.map((t, i) => rowHTML(t, i, cur && cur.id === t.id)).join('')
      : `<div class="empty"><b>这里还没有音乐</b><p>点下面「从手机导入音乐」，或在搜索页搜网易云</p></div>`;
    $('#libCount').textContent = g
      ? `${g.name} · ${list.length} 首`
      : list.length + ' 首';
  }

  /**
   * 专辑 / 艺人 / 下载 三个分组视图。
   * 分组本身不需要额外数据，全从已经并入库的曲目里聚合出来。
   *
   * 点分组行会筛出组内的歌并切回「歌曲」tab（见 App._libGroup）；
   * 分组行以前只是纯展示，样式却和可点的歌曲行一模一样，
   * 用户点下去毫无反应，会以为列表卡了。
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
        ? rows.map((e) => `<div class="row" data-album="${esc(e.album)}" data-artist="${esc(e.artist)}"
            role="button" tabindex="0" aria-label="专辑 ${esc(e.album)}，共 ${e.n} 首，查看歌曲">
            <div class="r-th art"><img src="${safeCover(coverOf(e.first))}" alt="" loading="lazy"></div>
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
        ? rows.map((e) => `<div class="row" data-artist="${esc(e.artist)}"
            role="button" tabindex="0" aria-label="艺人 ${esc(e.artist)}，共 ${e.n} 首，查看歌曲">
            <div class="r-th art"><img src="${safeCover(coverOf(e.first))}" alt="" loading="lazy"></div>
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
    /* B-1：回到默认态时把介绍区放出来、结果区清空 */
    const intro = $('#searchIntro');
    if (intro) intro.hidden = false;
    const sbody = $('#searchBody');
    if (sbody) sbody.innerHTML = '';
    const hot = $('#hotWords');
    if (!hot) return;                      // 结构被挪动时不再炸掉 renderAll()
    hot.innerHTML = ['周杰伦', '草东没有派对', 'City Pop', '陈粒', 'Lofi', '钢琴']
      .map((w) => `<button class="chip" data-hot="${w}">${w}</button>`).join('');
    $('#recList').innerHTML = Store.all().slice(0, 4).map((t, i) => rowHTML(t, i, false)).join('');
  }

  /* ================= 账号 ================= */
  /** 网络异常导致「查不到」时置 true —— 用于区分「真的没登录」和「没查成」 */
  let _accountUnknown = false;

  async function refreshAccount() {
    if (!Netease.ready) { updateAccountCard(); return null; }
    try {
      const p = await Netease.status();
      _accountUnknown = false;
      updateAccountCard();
      return p;
    } catch (e) {
      /*
       * 以前这里完全吞错，一失败就 updateAccountCard()。
       * 而 status() 是 4 次串行请求，网络稍差就会超时 ——
       * 结果是**登录态明明还有效，界面却显示「未登录网易云」**，
       * 用户会以为被登出了，重新登录一次又「好了」，反复来回。
       *
       * 现在区分两种情况：
       *   · 网络失败 → 保留上一次的 profile，只在卡片上标一句「状态未知」，
       *     不把昵称抹成「未登录」；
       *   · 真的 401 / 未登录 → status() 正常返回 null，走正常分支。
       */
      _accountUnknown = true;
      Log.err('ACCOUNT', e, 'refreshAccount failed');
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
      // 走属性赋值本身不构成 XSS，但同样只放行 http/https，避免被塞进奇怪协议
      ava.src = safeCoverUrl(p.avatar);
      ava.hidden = false;
    } else {
      ava.hidden = true;
    }
    $('#acctName').innerHTML = p
      ? esc(p.nickname) + (p.vip ? `<span class="badge">黑胶 VIP${p.vipLevel ? ' V' + p.vipLevel : ''}</span>` : '')
      : (_accountUnknown ? '账号状态未知' : '未登录网易云');
    $('#acctSub').textContent = p
      ? (_accountUnknown
          ? '网络不好，暂时没拿到最新资料；你的登录仍然有效'
          : (p.signature || ('Lv.' + (p.level || 0) + ' · 已连接网易云账号')))
      : (_accountUnknown
          ? '网络恢复后会自动重新查询'
          : '登录后可听会员曲目、同步我喜欢与每日推荐');
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
        invalidateHomeCaches();
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
  /*
   * F-13：_resolvingId 是单槽位，只够回答「同一首是否正在解析」，
   * 回答不了「这是不是最后一次请求」。解析 A 期间点 B，A 后返回时
   * 仍会 Player.playAt() 把播放器抢回 A —— 用户点了 B 却听到 A。
   * 这里改用递增序号：只有最新一次请求有权落地播放。
   */
  let _resolveSeq = 0;
  /*
   * 歌单详情的请求序号（见 openPlaylist）。
   * 放在这里而不是靠近 openPlaylist 的 4200 行处：那里是 let 声明，
   * 而 openPlaylist 在 3200 行就会用到它 —— 靠"函数调用晚于模块执行"
   * 侥幸能跑不算对，挪到前面就不存在 TDZ 风险。
   */
  let _plSeq = 0;
  /*
   * 打开的模态框栈（见 modal() / modalTop()）。
   * 必须声明在这里而不是 modal() 旁边：__rippleBack（约 2790 行）
   * 会调用 modalTop()，而 const 有暂时性死区，提前用会直接抛错。
   */
  const _modalStack = [];
  /* 模态框标题 id 的自增序号（给 aria-labelledby 用） */
  let _modalIdSeq = 0;
  /*
   * 启动恢复的接管序号：restoreLast() 开始时自增并记下自己的值，
   * 任何「用户主动播放」都再自增一次，让前者后续所有写入作废。
   * 放在这里而不是 App 上，是为了让它在最早期就能用（boot 里会先调
   * playTrack 吗？不会，但 restoreLast 本身可能很早执行）。
   */
  if (App._restoreSeq == null) App._restoreSeq = 0;

  function playTrack(track, context) {
    if (!track) return;
    /*
     * 用户主动播放 = 接管播放器。
     * 自增这个序号会作废所有还在飞的 restoreLast()（它可能正在解析
     * 上次那首在线歌的地址，最多要等几十秒），避免它稍后把用户
     * 刚点的歌换掉、或者把旧进度写进新歌。
     */
    App._restoreSeq++;
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
      /*
       * 同一首已经在解析：给出明确反馈（以前是静默 return，用户以为没点上），
       * 同时不重复发请求。
       */
      if (_resolvingId === track.id && !track.src) {
        toast('正在解析这一首', '稍等一下，马上开始播放', 'cloud');
        return;
      }
      _resolvingId = track.id;
      const seq = ++_resolveSeq;
      playOnline(track, list, i, seq).finally(() => {
        if (_resolvingId === track.id) _resolvingId = null;
      });
      return;
    }
    _resolveSeq++;                    // 本地曲目立即生效，作废所有在飞的在线解析
    Player.playAt(list, i);
    Store.set('lastTrackId', track.id);
    Store.set('lastIndex', i);
  }

  /*
   * 第 14 条：网易云直链大约 20 分钟就过期。
   * 以前只判断 track.src 是否非空 —— 而 src 会被 rememberOnline() 写进
   * onlineCache，下次启动恢复队列时带着上次的旧地址，直接拿去播就是
   * 「no supported sources」，表现成「这首之前明明放过，现在却说放不了」。
   * 现在给每个 src 记时间戳，超过 TTL 就丢掉重新解析。
   */
  const URL_TTL = 15 * 60 * 1000;

  function srcFresh(track) {
    return !!(track && track.src && (Date.now() - (track.srcAt || 0)) <= URL_TTL);
  }

  async function playOnline(track, list, i, seq) {
    if (track.src && !srcFresh(track)) {
      Log.add('ONLINE', 'src expired -> refetch: ' + track.title);
      track.src = '';
      track.srcAt = 0;
    }
    Log.add('ONLINE', 'resolve ' + track.title + ' neId=' + track.neId
      + ' cached=' + !!track.src + ' level=' + qualityLevel() + ' trial=' + !!track.trial);
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
        track.srcAt = Date.now();
        track.format = (got.type || 'mp3').toUpperCase() + (got.br ? ' ' + Math.round(got.br / 1000) + 'k' : '');
        track.trial = got.trial;
        /* 双保险：ctx 里同 id 的另一份对象也写上 src，
           避免它被别处（队列/最近播放）拿去播时又是空地址 */
        const twin = (list || []).find((x) => x && x.id === track.id);
        if (twin && twin !== track) {
          twin.src = track.src;
          twin.srcAt = track.srcAt;
          twin.format = track.format;
          twin.trial = track.trial;
        }
        if (got.trial) {
          /* 以前这里弹「只能试听片段 · 该曲目需要会员或已购」。
             歌名右边已经有 VIP 角标了，同一件事说两遍是噪音，去掉提示，
             只留日志。试听到 30 秒会自然停，用户看角标就知道原因。 */
          Log.add('ONLINE', 'trial only: ' + (track.title || ''));
        }
      }
      /*
       * ⚠️ 以前这里是 `await ensureLyric(track)`，然后才 playAt。
       * 歌词是可选数据（lyric 命令的预算是 18 秒），却挡在出声之前 ——
       * 歌词接口慢的时候，点一首歌要等十几秒才听见声音，
       * 用户只会觉得「点了没反应」。
       *
       * 现在：先播，再后台补歌词。Player.on('track') 里已经有一层
       * 「切歌后补拉歌词」的兜底，所以这条路不会漏。
       */
      /*
       * F-13：await 期间用户可能已经点了别的歌（或换了音质）。
       * 只有仍是「最后一次请求」才有权把播放器切到这首 ——
       * 否则就是「最后解析完成的赢」，用户点了 B 却听到 A。
       */
      if (seq != null && seq !== _resolveSeq) {
        Log.add('ONLINE', 'stale resolve dropped: ' + track.title);
        return;
      }
      if (!track.src) throw new Error('没有拿到播放地址');
      // 已经解析好了，直接播（这里不会再触发 defer）
      if (i >= 0) Player.playAt(list, i);
      else { Player.playAt([track], 0); }
      Store.set('lastTrackId', track.id);
      rememberOnline(track);
      /* 出声之后再补歌词，失败也不影响播放 */
      ensureLyric(track).catch(() => {});
    } catch (e) {
      Log.err('ONLINE', e, (track && track.title) + ' neId=' + (track && track.neId));
      // 过期请求的失败不该弹到用户脸上（他已经在听/在点别的歌了）
      if (seq != null && seq !== _resolveSeq) return;
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

  /**
   * F-12：切换音质后，为「正在播放/暂停中的在线曲目」重新解析地址。
   *
   * 旧做法是把 track.src 置成 null，等下一次播放时再解析 —— 问题是
   * 暂停→播放会先撞上 Player.play() 里的空 src 检查，被当成音源失效并自动跳歌。
   * 现在保持旧地址可继续播，同时静默取一档新地址替换；
   * 取不到（会员不足/风控）就保留旧地址，用户还能继续听，只是音质没变。
   */
  let _qualitySeq = 0;
  async function reResolveQuality() {
    const t = Player.track;
    if (!t || t.source !== 'online' || !t.neId) return;
    const my = ++_qualitySeq;
    try {
      let got = null;
      const lv = qualityLevel();
      const floor = Math.max(0, lv - 2);
      for (let k = lv; k >= floor; k--) {
        try { got = await Netease.songUrl(t.neId, k); break; } catch (e) { /* 继续降档 */ }
      }
      // 期间又换了音质 / 已经切歌：丢弃这次结果，别覆盖新的
      if (my !== _qualitySeq || Player.track !== t) return;
      if (!got || !got.url) return;
      const changed = got.url !== t.src;
      t.src = got.url;
      /* 必须同时写 srcAt：音源地址有 15 分钟 TTL（见 srcIsFresh），
         只写 src 不写时间戳，TTL 判定会拿一个过期时间戳去算，
         这套过期机制等于形同虚设 —— 用户会遇到「播到一半地址失效」。 */
      t.srcAt = Date.now();
      t.format = (got.type || 'mp3').toUpperCase() + (got.br ? ' ' + Math.round(got.br / 1000) + 'k' : '');
      t.trial = got.trial;
      const twin = (App.context || []).find((x) => x && x.id === t.id);
      if (twin && twin !== t) { twin.src = t.src; twin.srcAt = t.srcAt; twin.format = t.format; twin.trial = t.trial; }
      /*
       * 刻意**不去**改 <audio> 当前已加载的地址。
       * 换 src 会让元素重新加载，正在播的歌会顿一下、并从 0 开始 —— 为了换音质
       * 打断收听是不划算的。新地址已经写进曲目对象，下一次 load（切歌/重播）
       * 自然就用上新音质；已加载的旧地址仍然有效，暂停后恢复也不会再被误判失效。
       */
      if (changed) Log.add('ONLINE', 'quality re-resolve ok level=' + got.level + ' trial=' + got.trial);
    } catch (e) {
      Log.add('ONLINE', 'quality re-resolve failed: ' + e.message);
    }
  }

  function bindPlayer() {
    Player.on('track', (t) => {
      if (t) { S().lastPosition = 0; rememberProgress(true); }
      paletteFor(t);
      updateDock();
      // renderNP() 内部已经把封面/背景/队列/歌词/模式按钮都刷过了，
      // 这里再赋值一次 backgroundImage 是重复的样式写入（切歌时白做一遍重排）
      renderNP();
      renderHome();
      renderLibrary();
      $('#npCover img').style.opacity = 1;
      syncNormalizeRow();
      // F-5：切歌会改变「均衡器对当前音源是否可用」，面板/那一行要跟着说真话
      refreshEQUI();
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
        /*
         * 审查 3.1：心动模式续队列以前**没有**并发保护，
         * 而 extendRoam（漫游）一直有 _roamBusy。后果是快速切歌时
         * 每次切歌都触发一次续队列请求，几个请求回来各自 concat 一遍，
         * 队列里就出现重复歌曲，而且越切越重复。
         *
         * 这里补上同样的互斥：一次只允许一个续队列在飞。
         */
        if (_heartBusy) return;
        _heartBusy = true;
        Netease.heartMode(t.neId, 0, 20).then((list) => {
          if (!list.length) return;
          /* 回来时可能已经切歌了：只把「当前队列里还没有的」补进去 */
          if (Player.track !== t) return;
          const have = new Set(Player.queue.map((x) => x && x.id));
          const add = list.filter((x) => x && !have.has(x.id));
          if (!add.length) return;
          const queue = Player.queue.concat(add);
          Player.queueSet(queue, Player.index);
          renderQueue();
        }).catch(() => {}).then(() => { _heartBusy = false; });
      } else {
        extendRoam(t.neId, t);
      }
    });
    /* 审查 3.2：缓冲状态可视化，至少让用户知道「在转圈」而不是死机 */
    Player.on('buffering', (on) => {
      const bar = document.querySelector('.np-seek .bar');
      if (bar) bar.classList.toggle('buffering', !!on);
      const dock = document.getElementById('dockInner');
      if (dock) dock.classList.toggle('buffering', !!on);
    });
    Player.on('error', () => toast('播放出错', '音源可能已失效，试试下一首', 'warn'));
    Player.on('sourcefail', (t) => {
      Log.add('PLAY', 'sourcefail: ' + (t && t.title) + ' neId=' + (t && t.neId)
        + ' hasSrc=' + !!(t && t.src) + ' trial=' + !!(t && t.trial)
        + ' age=' + (t && t.srcAt ? Math.round((Date.now() - t.srcAt) / 1000) + 's' : 'n/a'));
      /*
       * 第 14 条：第一次失败先别急着判死刑。
       * 绝大多数「之前放过的歌现在放不了」都是直链过期，清掉重新解析一次
       * 就能放；只有重取之后还失败才真的跳过。
       */
      if (t && t.source === 'online' && t.neId && !t._srcRetried) {
        t._srcRetried = true;
        t.src = '';
        t.srcAt = 0;
        Log.add('PLAY', 'retry with fresh src: ' + t.title);
        playTrack(t, App.context);
        return;
      }
      if (t) t._srcRetried = false;
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
    /*
     * 用户正在拖进度条时，ticker 绝不能写进度。
     *
     * 以前 bindSeek 里有个局部 dragging 变量，但 updateTimes 根本不看它，
     * 于是拖动时每秒（甚至每 100ms）都会被真实播放位置抢回去 ——
     * 手指按着不动，滑块自己弹回原处。
     * 现在把「正在拖」提到 App._seeking 这个跨函数可见的标记上，
     * 拖动期间这里直接跳过进度写入（时间文字仍然更新到松手那一刻）。
     */
    if (!App._seeking) {
      /*
       * 播放进度是「每 100ms 一次、每次 6 个节点」的热路径，而它几乎总是
       * 在 0.3% 的粒度内变化 —— 逐次写 style/textContent 会让平板上的
       * 合成层一直重算。这里做值级短路：只有真的变了才碰 DOM。
       */
      const pct = Math.round(p * 1000) / 10;
      if (pct !== App._lastPct) {
        App._lastPct = pct;
        /* 两条进度条都走合成层，不触发 layout。
           dockProg 是纯色条，直接 scaleX；
           npFill 是渐变条，配 transform-origin:left 后 scaleX 会把整条渐变
           压进已填充的那一段 —— 视觉上等宽，且不用改 width。
           knob 是绝对定位的 10px 圆点，left 变化只影响它自己这一层，
           保持 left 才能正确按「轨道宽度」的百分比定位（transform 的百分比
           基准是圆点自身尺寸，用它定位会算错）。 */
        $('#dockProg').style.transform = 'scaleX(' + p.toFixed(4) + ')';
        $('#npFill').style.transform = 'scaleX(' + p.toFixed(4) + ')';
        $('#npKnob').style.left = (p * 100) + '%';
      }
    }
    const curTxt = fmtTime(c);
    if (curTxt !== App._lastCur) { App._lastCur = curTxt; $('#npCur').textContent = curTxt; }
    const durTxt = fmtTime(d);
    if (durTxt !== App._lastDur) { App._lastDur = durTxt; $('#npDur').textContent = durTxt; }
    /*
     * 缓冲进度用真实的 audio.buffered，而不是「已播 + 18%」这种假数据。
     * 取不到（还没元数据、或浏览器不给 buffered）时就不画，别误导人。
     */
    const buf = Player.bufferedEnd();
    if (buf && d) {
      const bp = Math.round(Math.min(100, (buf / d) * 100));
      if (bp !== App._lastBufPct) {
        App._lastBufPct = bp;
        $('#npBuf').style.width = bp + '%';
      }
    } else if (p <= 0.02) {
      if (App._lastBufPct !== 0) { App._lastBufPct = 0; $('#npBuf').style.width = '0%'; }
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
    // 封面只在真的变了时才写（同一首歌 renderNP 会被多次调用）
    const cover = coverOf(t);
    if (App._npCover !== cover) {
      App._npCover = cover;
      $('#npCover img').src = cover;
      $('#npBg').style.backgroundImage = cssUrl(cover);
      $('#npBg').style.backgroundSize = 'cover';
      $('#npBg').style.backgroundPosition = 'center';
      /*
       * 「这首歌真的没有封面」用 class 表达，不再靠 CSS 选择器猜。
       *
       * 以前的降级规则是 .np-bg:not([style*="url"]){opacity:0}，
       * 但 coverOf() **永远**返回一个 URL（没封面时返回 hashCover() 生成的
       * data: SVG），所以 style 里永远含 url(...)，选择器永不匹配 ——
       * 每首没封面的歌照样整屏铺 blur(44px)，白白多一层全屏模糊。
       * 现在按 t.cover 的真实性挂 .no-cover，CSS 那边已经改好了。
       */
      document.body.classList.toggle('no-cover', !t.cover);
    }
    $('#npTitle').textContent = t.title;
    // VIP 角标：判定统一走 isVipTrack()，与列表行的角标口径一致
    const vipEl = $('#npVip');
    if (vipEl) vipEl.hidden = !isVipTrack(t);
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

  /*
   * H-3：renderLyric() 被 renderNP() 无条件调用，每次都把 40~80 个歌词节点
   * 整体重建，还给每一行写行内 style.fontSize —— 播放页根本没打开时也在做。
   * 这里用签名短路：曲子、行数、首尾时间、字号、译文开关没变就直接跳过。
   */
  let _lyricSig = '';

  function renderLyric() {
    const t = Player.track;
    if (!t) {
      _lyricSig = '';
      $('#lyrPrev').textContent = '';
      $('#lyrCur').textContent = '—';
      $('#lyrNext').textContent = '';
      lyricLines = [];
      return;
    }
    const nextLines = lyricOf(t);
    const sig = [t.id, nextLines.length,
      nextLines.length ? nextLines[0].t : -1,
      nextLines.length ? nextLines[nextLines.length - 1].t : -1,
      S().lyricSize, S().showTrans ? 1 : 0].join('|');
    if (sig === _lyricSig) return;          // 内容没变：连 DOM 都不碰
    _lyricSig = sig;
    lyricLines = nextLines;
    // 完整歌词（展开后在同一页面里显示）
    const box = $('#npLyric');
    if (!lyricLines.length) {
      box.innerHTML = `<div class="empty">暂无歌词<br><span style="opacity:.6">在线曲目会自动匹配</span></div>`;
      _lyricSig = '';
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
        /*
         * 写 CSS 变量而不是 font-size。
         * 行内 font-size 优先级高于样式表，会把 .ln.on 的
         * 「当前行放大 1.12 倍」彻底压掉 —— 长歌词里"唱到哪一句"
         * 只剩颜色差异，字号完全一样。
         * 现在 CSS 用 calc(var(--ln-size) * 1.12) 表达放大，两边不再打架。
         */
        el.style.setProperty('--ln-size', S().lyricSize + 'px');
      });
    }
    lyricIdx = -2;
    lyricFollow = true;
    _lyricRecenter = true;
    if (box) box.classList.remove('free');
    bindLyricScroll();
    syncLyric();
  }

  /* ---------- 展开歌词的滚动（第 6、7 条） ----------
   * 第 6 条：当前句要停在容器「垂直正中」，而不是原来那个 42% 的偏上位置。
   * 第 7 条：用户主动往上/往下翻看时不能再被强制拉回来 ——
   *   · 离开当前句超过一行 → 判定为用户在翻看，暂停跟随
   *   · 停手 1 秒后再判断：离当前句在 2 行以内就自动回到跟随并居中，
   *     否则继续保持脱离（继续翻不会被抢）
   *   · 点任意歌词行（会跳转播放位置）时立刻恢复跟随
   */
  let lyricFollow = true;      // false = 用户在翻看，不许再自动校正
  let _lyricIdle = null;
  let _lyricAutoAt = 0;        // 程序自己滚动的时刻
  let _lyricTouch = false;     // 手指还按在歌词上
  let _lyricRecenter = true;   // 下一次 syncLyric 必须校正一次（展开/换歌/缩放后）

  /** 让某一行停在滚动容器的垂直正中 */
  function lyricCenterTarget(box, row) {
    if (!box || !row) return 0;
    const h = row.offsetHeight || 1;
    return Math.max(0, row.offsetTop + h / 2 - box.clientHeight / 2);
  }

  /** 程序滚动：记时间戳，避免自己的滚动被当成用户操作 */
  function scrollLyric(box, top, smooth) {
    _lyricAutoAt = Date.now();
    try { box.scrollTo({ top: top, behavior: smooth ? 'smooth' : 'auto' }); }
    catch (e) { box.scrollTop = top; }
  }

  /** 停手 1 秒后判断：离当前句在 2 行以内就恢复跟随，否则继续保持脱离 */
  function scheduleLyricReattach(box) {
    clearTimeout(_lyricIdle);
    _lyricIdle = setTimeout(() => {
      if (_lyricTouch) return;                    // 手指还在屏幕上，别插手
      const rows = box.children;
      const c = rows[lyricIdx >= 0 ? lyricIdx : 0];
      if (!c) return;
      const t2 = lyricCenterTarget(box, c);
      if (Math.abs(box.scrollTop - t2) <= (c.offsetHeight || 1) * 2) {
        lyricFollow = true;
        box.classList.remove('free');
        scrollLyric(box, t2, true);
      }
    }, 1000);
  }

  function bindLyricScroll() {
    const box = $('#npLyric');
    if (!box || box._boundLyricScroll) return;
    box._boundLyricScroll = true;

    /*
     * 关键：用 touchstart 立刻判定「用户在翻」，不要等 scroll 事件去猜。
     *
     * 上一版的错误：靠 scroll 事件 + 「离当前句超过一行才脱离」来判定，
     * 但 syncLyric() 每 100ms 就会因为「还差 4px 以上」把位置拽回当前句，
     * 而且每次校正都会刷新 _lyricAutoAt，让 scroll 监听以为这是程序滚的、
     * 直接 return —— 结果 lyricFollow 永远变不成 false，手指滑多远都会被抢。
     *
     * 现在：手指一碰就脱离，松手 1 秒后再决定要不要回跟，
     * syncLyric 只在「换句 / 明确要求」时才校正一次。
     */
    box.addEventListener('touchstart', () => {
      _lyricTouch = true;
      clearTimeout(_lyricIdle);
      if (lyricFollow) {
        lyricFollow = false;
        box.classList.add('free');
      }
    }, { passive: true });
    box.addEventListener('touchend', () => {
      _lyricTouch = false;
      scheduleLyricReattach(box);
    }, { passive: true });
    box.addEventListener('touchcancel', () => {
      _lyricTouch = false;
      scheduleLyricReattach(box);
    }, { passive: true });

    // 滚轮 / 键盘 / 拖动滚动条（桌面预览）走这条兜底
    box.addEventListener('scroll', () => {
      if (Date.now() - _lyricAutoAt < 700) return;   // 程序自己滚的
      if (_lyricTouch) return;                       // 触摸路径已处理
      if (lyricFollow) {
        lyricFollow = false;
        box.classList.add('free');
      }
      scheduleLyricReattach(box);
    }, { passive: true });
  }

  /**
   * 审查 3.1：歌词行索引以前在 syncLyric 和 pushSbText 里各做一遍线性全表扫描。
   * 10Hz × 2 × 80 行 ≈ 每秒 2400 次迭代，而歌词本来就按时间升序排好，
   * 二分是 log2(80)≈7 次。改成二分。
   */
  function lyricIndexAt(sec) {
    let lo = 0, hi = lyricLines.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lyricLines[mid].t <= sec) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  }

  /** force=true 时即使还在同一句也会重新计算（改歌词偏移后需要用） */
  function syncLyric(force) {
    if (!lyricLines.length) {
      if (lyricIdx !== -1) {
        lyricIdx = -1;
        $('#lyrPrev').textContent = '';
        $('#lyrCur').textContent = '♪';
        $('#lyrNext').textContent = '';
      }
      return;
    }
    const t = Player.time() + (S().lyricOffset || 0);
    const i = lyricIndexAt(t);
    /*
     * 三行歌词只在「当前句变了」时才写 DOM。
     * 这个函数被 Player 的 time 事件每 100ms 调一次，
     * 而一句歌词通常持续两三秒 —— 旧代码每次都在重写同样三个字符串，
     * 白白产生每秒十几次文本节点变更（平板上的合成开销很实在）。
     */
    const lineChanged = force || i !== lyricIdx;
    if (lineChanged) {
      const prevTx = i - 1 >= 0 ? lyricLines[i - 1].text : '';
      const curTx = i >= 0 ? lyricLines[i].text : '♪';
      const nextTx = i + 1 < lyricLines.length ? lyricLines[i + 1].text : '';
      $('#lyrPrev').textContent = prevTx || '';
      $('#lyrCur').textContent = curTx;
      $('#lyrNext').textContent = nextTx || '';
      $('#lyrPrev').classList.toggle('blank', !prevTx);
      $('#lyrNext').classList.toggle('blank', !nextTx);
      // 状态栏浮层跟着走（内部有去重，同一行不会重复发）
      if (S().sbLyric) pushSbText(false);
    }

    // 展开层：高亮 + 居中
    const box = $('#npLyric');
    if (!box || !box.children.length) return;
    const rows = box.children;
    const focus = i >= 0 ? i : 0;   // 第一句之前先把第一句顶上去
    const changed = lineChanged;
    if (changed) {
      lyricIdx = i;
      for (let k = 0; k < rows.length; k++) {
        // 还没到第一句（i<0）时把第一句当当前句显示，避免展开后一片空白没有焦点
        rows[k].classList.toggle('on', k === focus);
        rows[k].classList.toggle('near', false);
      }
    }
    /* 展开且可见时才滚动。
       两个前置条件缺一不可：
         · lyricFollow —— 用户在翻看时一次都不许动
         · !_lyricTouch —— 手指按着的时候也别抢
       而且只在「当前句真的变了」或「明确要求校正」时动一次。
       以前末尾还带着 `|| Math.abs(scrollTop - target) > 4`，等于每 100ms
       抢一次位置，用户根本翻不动歌词 —— 这条是那个 bug 的根源，已删除。 */
    if (lyricFollow && !_lyricTouch && rows[focus]
        && $('#np').classList.contains('expanded') && box.clientHeight > 0) {
      if (changed || _lyricRecenter) {
        _lyricRecenter = false;
        scrollLyric(box, lyricCenterTarget(box, rows[focus]), true);
      }
    }
  }

  /* ---------- 播放列表 sheet ---------- */
  /**
   * F-14：以前每次切歌都无条件 innerHTML 全量重建（300 首 = 300 个节点，
   * 平板上非常明显），而且面板关着也重建、还把 scrollTop 冲回顶部。
   * 现在：面板不可见时只登记「脏了」，等真正打开再渲染；
   * 队列内容没变（签名相同）就跳过；渲染时保留滚动位置。
   */
  let _queueSig = '';
  let _queueDirty = true;
  let _queueCountTxt = '';

  /** 队列条数只在文字真的变了时才写 DOM（切歌时会反复调用） */
  function setQueueCount(n) {
    const txt = n + ' 首';
    if (txt === _queueCountTxt) return;
    _queueCountTxt = txt;
    const el = $('#npQueueCount');
    if (el) el.textContent = txt;
  }

  function queueSignature(q) {
    // 签名要覆盖「标题/歌手/时长/当前曲目」，任何一项变化都要重建
    const cur = Player.track ? Player.track.id : '';
    let h = 0;
    for (let i = 0; i < q.length; i++) {
      const s = q[i].id + '\u0001' + q[i].title + '\u0001' + q[i].artist + '\u0001' + q[i].duration;
      for (let k = 0; k < s.length; k++) h = (h * 31 + s.charCodeAt(k)) | 0;
      h = (h * 31 + i) | 0;
    }
    return cur + '|' + q.length + '|' + h;
  }

  function queueVisible() {
    const sheet = $('#npQueueSheet');
    return !!(sheet && sheet.classList.contains('on'));
  }

  function renderQueue(force) {
    const q = Player.queue.length ? Player.queue : Store.all();
    const sig = queueSignature(q);
    // 面板没打开时不做 DOM 重建，只记个标记（打开时会强制渲染）
    if (!force && !queueVisible()) {
      if (sig !== _queueSig) _queueDirty = true;
      return;
    }
    setQueueCount(q.length);
    if (!force && !_queueDirty && sig === _queueSig) return;
    _queueSig = sig;
    _queueDirty = false;
    const box = $('#npQueue');
    if (!box) return;
    const keep = box.scrollTop;                 // 保留滚动位置，切歌不再跳回顶部
    box.innerHTML = q.map((t, i) =>
      `<div class="qitem${Player.track && Player.track.id === t.id ? ' on' : ''}"
            data-i="${i}" data-id="${esc(t.id)}">
        <div class="idx">${Player.track && Player.track.id === t.id ? '▮▮' : String(i + 1).padStart(2, '0')}</div>
        <div class="tx"><b>${esc(t.title)}</b><span>${esc(t.artist)}</span></div>
        <div class="du">${fmtTime(t.duration)}</div>
      </div>`).join('');
    if (keep) box.scrollTop = keep;
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
          ${optRow('i-eq', '音量归一化',
            Player.normalizeUsable()
              ? '按实测响度拉平（本地/同源音源）'
              : '当前是在线流，对它不生效（只能在本机音源上用）',
            optSwitch('normalize'))}
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
    /*
     * F-1：归一化那一行的副标题也要跟着「当前音源能不能用」变。
     * 播在线流时明确说要它不生效，而不是让用户反复开关找不到原因。
     */
    const nzSw = body.querySelector('[data-optsw="normalize"]');
    if (nzSw) {
      const r = nzSw.closest('.opt-row');
      if (r) {
        r.style.opacity = Player.normalizeUsable() ? '' : '0.55';
        const t = r.querySelector('.tx span');
        if (t) {
          t.textContent = !s.normalize
            ? '仅对本地/同源音源生效（在线流跨域不可测）'
            : (Player.normalizeUsable() ? '已启用 · 按实测响度拉平' : '当前是在线流，对它不生效');
        }
      }
    }
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
        /* 与主设置页一致：switch 语义的控件要同步 aria-checked */
        if (sw.getAttribute('role') === 'switch') sw.setAttribute('aria-checked', v ? 'true' : 'false');
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
      /*
       * F-12：换音质不能把当前曲目的 src 置空。
       * 旧代码 `Player.track.src = null`：<audio> 里已经加载的地址还能响，
       * 但曲目对象已经没有地址 —— 用户暂停后再播放时 Player.play() 看到空 src，
       * 判定「音源失效」→ 弹「这首放不了 · 已跳过」→ 自动跳到下一首。
       * 正确做法是保持能播，同时在后台重新解析一档新音质的地址替换上去。
       */
      reResolveQuality();
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

  /*
   * H-20：按需提升合成层。
   *
   * will-change 常驻会让浏览器为元素永久保留合成层和显存 ——
   * 播放页/面板这些铺满屏幕的元素，静止时也占着，纯属浪费。
   * 正确做法是「动作开始时挂上、结束后摘掉」，这里就是那个开关。
   *
   * 用 setTimeout 而不是 transitionend：多个属性共用一次过渡时
   * transitionend 会触发多次，还要自己判重；而这里的时长本来就知道。
   */
  const _liftTimers = new WeakMap();
  function liftWhileAnimating(el, ms) {
    if (!el) return;
    el.classList.add('animating');
    const prev = _liftTimers.get(el);
    if (prev) clearTimeout(prev);
    _liftTimers.set(el, setTimeout(() => {
      el.classList.remove('animating');
      _liftTimers.delete(el);
    }, ms));
  }

  function openQueue() {
    // 两个 sheet 会叠在一起，开一个先关掉另一个
    closeComments(); closeOptSheet(); closeEQ();
    /* H-20：面板滑出这段时间才需要合成层 */
    liftWhileAnimating($('#npQueueSheet'), 520);
    liftWhileAnimating($('#npMask'), 520);
    $('#npMask').classList.add('on');
    $('#npQueueSheet').classList.add('on');
    // 面板可见之后再渲染（renderQueue 会据可见性决定是否重建，脏了才真重建）
    renderQueue();
  }
  function closeQueue() {
    liftWhileAnimating($('#npQueueSheet'), 520);
    liftWhileAnimating($('#npMask'), 520);
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
    /*
     * H-2：这里以前无条件 Store.save()，而它被 renderNP() 调用 ——
     * 每切一次歌就把 history(200) + onlineCache(60) 全量序列化写盘一次，
     * 是切歌卡顿的固定来源。现在只在值真的变了时才存。
     */
    const nextShuffle = m.key === 'rand';
    const nextRepeat = m.key === 'one' ? 'one' : (m.key === 'seq' ? 'off' : 'all');
    if (S().shuffle !== nextShuffle || S().repeat !== nextRepeat) {
      S().shuffle = nextShuffle;
      S().repeat = nextRepeat;
      Store.save();
    }
  }


  /*
   * ============ 封面尺寸：单一来源，只发布不补偿 ============
   *
   * 唯一职责：在**收起稳定态**把封面边长算出来，写到 :root 的 --cover-size。
   * CSS 那边 .np-cover 直接用 width/height:var(--cover-size)，
   * 不再有任何 max-height:100% 之类的自适应 —— 所以动画期间它不可能变。
   *
   * 为什么用 ResizeObserver 而不是手动绑一堆事件：
   *   以前 sizeCover() 有 6 个触发点（resize / orientationchange /
   *   打开播放页 / __rippleViewport / 动画结束 / 滑动结束），
   *   每个都在赌「此刻布局已经稳定」。只要有一个跑在容器还没长开的时候，
   *   就会把小值写进 inline style 并一直错着 —— 这就是「偶见封面变小」。
   *   ResizeObserver 只在容器**真的**改变尺寸时回调，且回调时机是布局完成后，
   *   天然不会量到半成品。
   *
   * 展开态一律跳过：此时容器高度已经塌了，量出来必然偏小。
   */
  function publishCoverSize() {
    const wrap = document.querySelector('.cover-wrap');
    const np = $('#np');
    if (!wrap || !np) return;
    /* 展开态 / 播放页没打开：不发布，保持上一次的值 */
    if (np.classList.contains('expanded')) return;
    if (!np.classList.contains('open')) return;
    const cs = getComputedStyle(wrap);
    const padL = parseFloat(cs.paddingLeft) || 0;
    const padR = parseFloat(cs.paddingRight) || 0;
    const r = wrap.getBoundingClientRect();
    const availW = r.width - padL - padR;
    if (availW < 2) return;
    /*
     * ⚠️ 封面边长**只跟宽度走，绝不读容器高度**。
     *
     * 这是「偶见封面变小」的最终修法。旧实现是
     *   size = Math.max(120, Math.min(r.width, availH))
     * —— 只要某一刻 cover-wrap 的高度比宽度小（比如歌词占位多了一个瞬时状态、
     * 键盘弹出、小窗切换、或者切歌时歌名从一行变两行），
     * Math.min 就会取到那个高度值，算出 185 这种小尺寸并**写进 inline style**，
     * 之后一直错着，直到下一次测量才纠正。用户看到的就是「偶见封面缩小」。
     *
     * 现在改成只由宽度决定，并给一个「不超过视口高度的一部分」的上限来兜底：
     *   · 宽度是稳定的（左右内边距固定，不随内容变化）
     *   · 高度只作为上限参与一次性的钳制，且用视口高度算，不读容器高度
     * 于是同一台设备上，无论歌词/歌名怎么变，算出来的边长恒定不变。
     */
    /*
     * 边长 = min(容器可用宽度, 容器可用高度)，但高度那一侧要「稳」。
     *
     * 这里踩过三个坑，记录清楚免得再来一次：
     *
     * ① 直接用容器高度 → 它会随歌词/歌名/键盘瞬时变化，
     *    量到一次小值就被写死 → 用户看到的「偶见封面缩小」。
     * ② 用屏高固定比例（46%）→ 横屏 411 高时算出 189px，像个小图标，
     *    因为横屏是两栏布局，纵向根本没被挤占。
     * ③ 取 max(容器空间, 屏高×92%) → 等于永远用屏高兜底，
     *    **容器被压扁时封面不肯缩**。小窗 411×685 实测：容器只有 251px，
     *    封面仍是 367px，顶出屏幕 18px，把歌名、歌词、进度条全挤乱了。
     *
     * 现在的做法：老老实实取 min(宽, 容器高)，但**只在容器高度稳定时更新**。
     * 「稳定」的判据是：本次算出的值与上次相差超过 4px 才采纳 ——
     * 这样瞬时抖动（动画中间帧、一次性的布局重排）不会改尺寸，
     * 而窗口真的变小（小窗/横屏/键盘）时尺寸会跟着缩，不会溢出。
     *
     * 另外加一条硬约束：封面绝不允许超过容器可用高度，这是「不溢出」的底线。
     */
    const padTop = parseFloat(cs.paddingTop) || 0;
    const padBottom = parseFloat(cs.paddingBottom) || 0;
    const wrapRoom = Math.max(0, r.height - padTop - padBottom);
    if (wrapRoom < 2) return;
    const size = Math.floor(Math.min(availW, wrapRoom));
    /* 尺寸已经稳定在同一个值上：不重复写（写 CSS 变量会触发全树 style 重算） */
    if (size === App._coverSize) return;
    /*
     * 抖动抑制：只有当变化足够大时才采纳。
     * 阈值 4px 远大于一次布局重排的误差，又远小于「小窗把容器压掉一半」这种
     * 真实变化，所以既能挡住抖动，又不会让封面在小窗里溢出。
     */
    if (App._coverSize && Math.abs(size - App._coverSize) <= 4) return;
    App._coverSize = size;
    document.documentElement.style.setProperty('--cover-size', size + 'px');
  }

  (function initCoverSize() {
    const wrap = document.querySelector('.cover-wrap');
    if (!wrap || typeof ResizeObserver !== 'function') return;
    let queued = false;
    const ro = new ResizeObserver(() => {
      /* 合并到下一帧，避免同一批布局变化里连续回调多次 */
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; publishCoverSize(); });
    });
    ro.observe(wrap);
    /*
     * 打开播放页时容器从「隐藏」变成「有尺寸」，ResizeObserver 会回调；
     * 但 --lyric-size（歌词字号）变化会改兄弟元素高度、间接影响可用高度，
     * 那种变化 observer 也能捕捉到，所以不需要额外监听设置项。
     */
    /* 对外暴露一个「强制发布」入口，供 openNP() 在打开动画结束后调用一次 */
    App._publishCoverSize = publishCoverSize;
  })();

  /*
   * 窗口信息（设置页里的只读诊断行）。
   *
   * 为什么加它：平板上反馈「中间还是一条窄栏」时，三种原因在画面上几乎一样，
   * 但修法完全不同 ——
   *   a) 装的不是新包          → 「关于」里的版本号对不上
   *   b) 系统把窗口限成了窄窗    → 视口宽度明显小于屏幕宽度（letterbox / 分屏 / 兼容模式），
   *                              这种情况 CSS 怎么改都没用，得去系统侧放开
   *   c) 断点判据没命中        → 视口够宽、但 --rail-w 还是 0，那才是 CSS 的问题
   * 没有这行信息的时候只能对着截图猜，来回改好几轮都打不中。
   *
   * 注意：这里不重算断点，直接读 responsive.css 算出来的最终值（--rail-w / --content-max）。
   * 重写一遍判据迟早会和 CSS 漂移，那样这行字反而会骗人。
   */
  /* H-12：#winHint 独立 DOM 已并进「软件日志」，不再需要同步函数 */


  /*
   * 小窗 / 分屏：原生侧在窗口尺寸变化时会把新的逻辑尺寸推过来。
   * WebView 在小窗里不会自己重算视口，所以这里显式同步一次，
   * 并重算封面尺寸与断点相关的量。第三参数是 dpr，暂时只用于日志，
   * 但留着可以让以后做「按物理像素选画质」时少改一处桥。
   */
  window.__rippleViewport = function (w, h, dpr) {
    try {
      App._vp = { w: w, h: h, dpr: dpr };
      Log.add('VIEW', 'viewport ' + w + 'x' + h + ' @' + dpr);
      requestAnimationFrame(() => {
        /* 断点切换后 carousel / 网格列数都会变，滚动位置可能越界，钳一下 */
        $$('.page').forEach((p) => {
          if (p.scrollTop > p.scrollHeight) p.scrollTop = 0;
        });
      });
    } catch (e) {}
  };
  /*
   * 返回键（第 11 条）：优先级从高到低 ——
   *   1. 任何弹出的面板（播放列表 / 音质选项 / 评论 / 均衡器 / 选曲 / 状态栏歌词）
   *   2. 歌词展开态（先收回三行，不是整个关掉播放页）
   *   3. 播放页
   *   4. 搜索框聚焦（先收键盘）
   *   5. 都没有 → 交回系统（退出 App）
   *
   * 这段逻辑以前写死在 Java 的 onBackPressed 里，只认识「歌词展开」和「播放页」，
   * 所以列表还开着的时候按返回，先收起来的是播放页，列表挂在后面 —— 用户要按两次
   * 才能把列表收掉，而且中间播放页已经跳下去了。
   */
  window.__rippleBack = function () {
    try {
      /*
       * 模态框（确认/输入/关于）优先级最高。
       *
       * 以前这里只认 .np-sheet.on 和播放页，完全不知道 .modal-wrap 的存在，
       * 于是：设置里点「清除播放记录」→ 弹出确认框 → 连按两次返回 →
       * **App 直接退出，对话框还挂在屏幕上**，而 `await confirmDialog()`
       * 永远等不到 resolve，那个"清空/不清空"的意图就被无声丢弃了。
       * 现在按返回先关最上层的模态框，等于"取消"。
       */
      const mt = modalTop();
      if (mt) { mt.close(null); return 'handled'; }
      const sheet = $('.np-sheet.on');
      if (sheet) {
        const id = sheet.id || '';
        if (id === 'npQueueSheet') closeQueue();
        else if (id === 'npOptSheet') closeOptSheet();
        else if (id === 'cmtSheet') closeComments();
        else {
          // eq / pick / sb 这些没有专门 close 函数的，统一摘类 + 收遮罩
          sheet.classList.remove('on');
          $$('.sheet-mask.on').forEach((m) => m.classList.remove('on'));
          const nm = $('#npMask');
          if (nm) nm.classList.remove('on');
        }
        return 'handled';
      }
      const np = $('#np');
      if (np && np.classList.contains('expanded')) { collapseLyric(); return 'handled'; }
      if (np && np.classList.contains('open')) { closeNP(); return 'handled'; }
      const si = $('#searchInput');
      if (si && document.activeElement === si) { si.blur(); return 'handled'; }
      /*
       * 第 2 条：返回键两次确认退出。
       * 没有可收的东西时不再直接退出，先在底部胶囊提示一次，
       * 2.5 秒内再按一次才真的交回系统去 finish()。
       */
      const now = Date.now();
      if (now - _exitHintAt < 2500) { _exitHintAt = 0; return 'exit'; }
      _exitHintAt = now;
      // H-10：判定窗口是 2500ms，提示也必须显示同样久，否则「提示没了却还能退出」
      toastBottom('再按一次返回退出', '2 秒内再按一次就退出', 'info', 2500);
      return 'handled';
    } catch (e) { return 'exit'; }
  };

  function openNP() {
    if (!Player.track) {
      const all = Store.all();
      if (all.length) playTrack(all[0], all);
    }
    renderNP();
    closeQueue();
    closeComments();
    if (isLyricExpanded()) collapseLyric();
    /* H-20：播放页推入的 0.52s 里才提升合成层 */
    liftWhileAnimating($('#np'), 560);
    liftWhileAnimating($('#npBg'), 560);
    $('#np').classList.add('open');
    /*
     * inert 是 CSS visibility 之外的第二层兜底：
     * visibility:hidden 已经不接收焦点，但 inert 还能把整棵子树
     * 从无障碍树和命中测试里彻底摘掉（更严格，也更省心）。
     * 两层不冲突，同时存在最稳。
     */
    try { $('#np').removeAttribute('inert'); } catch (e) {}
    refreshSystemBars();
    /*
     * 打开播放页时强制发布一次封面尺寸 —— 这时播放页刚变成可见，
     * 容器第一次有了真实高度，是该发布的时候。
     * 只调用一次，且 publishCoverSize() 内部有「展开态跳过」和
     * 「值没变不重复写」两道保护，不会在动画中乱改。
     */
    if (App._publishCoverSize) App._publishCoverSize();
    updatePlayIcons(Player.playing);
    $('#np').setAttribute('aria-hidden', 'false');
  }
  function closeNP() {
    /* H-20：收起同样是 0.52s */
    liftWhileAnimating($('#np'), 560);
    liftWhileAnimating($('#npBg'), 560);
    $('#np').classList.remove('open');
    $('#np').setAttribute('aria-hidden', 'true');
    /*
     * 收起后整页内容不该再被 Tab 到 / 被读屏念到。
     * CSS 那边已经用 visibility:hidden 拦了一道（transition-delay 保证
     * 收起动画走完才真正隐藏），inert 作为第二层更彻底的兜底。
     */
    try { $('#np').setAttribute('inert', ''); } catch (e) {}
    if (isLyricExpanded()) collapseLyric();
    setTimeout(refreshSystemBars, 120);
  }

  /* ================= 歌词展开（当前页内移动布局） ================= */

  function isLyricExpanded() {
    return $('#np').classList.contains('expanded');
  }

  /**
   * 歌词区高度过渡（FLIP 思路）。
   *
   * 直接给 `flex-grow` 写过渡有两个坑，都实测过：
   *   ① 收起态 flex:none（basis auto）→ 展开态 flex:1（basis 0%），
   *      basis 不能插值，高度会先塌成 0 再长回来，开头抖一下；
   *   ② 用 min-height 托底也不行：实测 126 → 109 → 170 → 452，
   *      min-height 掉得比 flex-grow 涨得快，开头仍有 17px 下跌。
   * 所以改成先量起始高度、切类后量目标高度，再用显式 height 过渡，
   * 结束后清掉内联样式交还给 CSS。这样高度是严格单调的。
   */
  function animateLyricBox(expand) {
    /*
     * 现在整个函数只剩一次 class 切换。
     *
     * 早期实现里有一整套「冻结封面尺寸 / 到点解冻 / 结束后重算」的补偿逻辑，
     * 是围绕 JS 量尺寸那套架构长出来的。现在封面尺寸完全由 CSS 的
     * width:100% + aspect-ratio + max-height 决定，浏览器在布局阶段自己算，
     * 动画过程中它只会跟着容器一起变，不存在需要冻结的 inline 值，
     * 也就不需要任何计时器去「事后修正」。
     *
     * 这同时消掉了两个老问题：
     *   · 偶见封面变小 —— 某次测量在容器还没长开时跑了一遍，把 120px 那样
     *     的小值写进 inline style，之后一直错着；
     *   · 收回时歌名「再往下闪一下」—— 解冻后立刻重算尺寸，
     *     在动画刚结束的那一刻又改了一次布局。
     */
    const np = $('#np');
    if (!np) return;
    np.classList.toggle('expanded', !!expand);
  }

  function expandLyric() {
    const t = Player.track;
    if (!t) return;
    if (!lyricLines.length) {
      toast('暂无歌词', '这首歌还没匹配到歌词', 'info');
      return;
    }
    animateLyricBox(true);
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
    animateLyricBox(false);
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
  /* 漫游队列上限：漫游是常开的，续下去不封顶会让队列与渲染无限膨胀 */
  const ROAM_QUEUE_MAX = 300;
  /* 审查 3.1：心动模式的续队列互斥锁（漫游那边的 _roamBusy 已有） */
  let _heartBusy = false;
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
      /*
       * 必须按 id 去重：漫游是无限续的，上游按 seed 推荐的歌跟已有队列
       * 大面积重叠，直接 concat 会让队列越听越长、重复项越堆越多，
       * 随机权的权重也就失真了（和心动模式续队列同一个道理）。
       *
       * 队列还得有上限：漫游是常开的，不封顶的话一次长听能积累到
       * 几千首，renderQueue 和队列面板都会变慢。
       */
      const base = Player.queue.length ? Player.queue.slice() : [seedTrack];
      const have = new Set(base.map((x) => x && x.id));
      const add = [];
      for (const x of list) {
        if (!x || !x.id || have.has(x.id)) continue;
        have.add(x.id);
        add.push(x);
      }
      if (!add.length) {
        toast('漫游中', '暂时没有新的相似歌曲', 'infinite');
        return;
      }
      const queue = base.concat(add).slice(-ROAM_QUEUE_MAX);
      /* 截掉的是队头，当前这首歌的下标要跟着前移，否则会指向别的歌 */
      const index = Math.max(0, Player.index - Math.max(0, base.length + add.length - queue.length));
      Player.queueSet(queue, index);
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
     * L-17：拉评论要一两秒，期间用户可能已经切歌。
     * 之前 `t` 在 await 之前捕获、之后没有任何复核，
     * 于是上一首歌的评论会直接覆盖到新歌的评论面板里。
     * 现在请求回来先核对「当前曲目还是不是这首歌」，不是就整段丢弃。
     */
    const wantId = t.id;

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
      if (!Player.track || Player.track.id !== wantId) return;   // 已经切歌，别污染新面板
      $('#cmtCount').textContent = '失败';
      $('#cmtBody').innerHTML = `<div class="empty" style="padding:30px 0">
        <b>评论读取失败</b><p>${esc(e.message)}</p></div>`;
      return;
    }
    // 切歌了就丢弃这次结果（面板可能已经为新歌清空/重填）
    if (!Player.track || Player.track.id !== wantId) {
      Log.add('CMMT', 'stale comments dropped for ' + t.title);
      return;
    }

    const fmtN = (n) => (n >= 10000 ? (n / 10000).toFixed(1) + ' 万' : String(n));
    const line = (c) => `<div class="cmt">
        <div class="ava"><img src="${safeCover(c.avatar)}" alt="" loading="lazy"></div>
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
        t.srcAt = Date.now();          // 与 src 成对写入，否则 TTL 判定失效
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
      /*
       * F-16：这里必须说真话。
       * 网易云音频在 m*.music.126.net（跨域），浏览器会忽略 download 属性；
       * 同时 MainActivity 的 shouldOverrideUrlLoading 会把 http(s) 链接交给系统浏览器。
       * 所以文件根本不会进 App 存储，「曲库 → 下载」筛选也永远看不到它。
       * 旧文案「已开始下载」是带着成功提示的静默失败。
       */
      toast('已交给系统处理', '受网易云 CDN 限制，文件不会存进 Ripple 曲库；请到浏览器下载列表里找', 'download');
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
      /*
       * 拖动期间同步写 _lastPct，否则 ticker 那边会认为"百分比变了"
       * 而立刻把滑块拉回真实播放位置（E-03 的另一个入口）。
       */
      App._lastPct = Math.round(p * 1000) / 10;
      $('#npFill').style.transform = 'scaleX(' + p.toFixed(4) + ')';
      $('#npKnob').style.left = (p * 100) + '%';
      $('#npCur').textContent = fmtTime(p * d);
      return p;
    };
    bar.addEventListener('pointerdown', (e) => {
      dragging = true;
      /*
       * 关键的跨函数标记：updateTimes() 看到它为 true 就完全不碰进度，
       * 这样按住不动的时候滑块不会被每秒的 ticker 抢回去。
       */
      App._seeking = true;
      seek.classList.add('dragging');
      apply(e);
      try { bar.setPointerCapture(e.pointerId); } catch (err) {}
    });
    bar.addEventListener('pointermove', (e) => { if (dragging) apply(e); });
    bar.addEventListener('pointerup', (e) => {
      if (!dragging) return;
      dragging = false;
      App._seeking = false;
      seek.classList.remove('dragging');
      const p = apply(e);
      if (p != null) Player.seek(p * Player.duration());
    });
    bar.addEventListener('pointercancel', () => {
      dragging = false;
      App._seeking = false;
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
    /*
     * 请求序号：快速切换歌单时旧请求可能后返回，会把 header、封面、
     * 曲目、App._plCurrent 全改成上一张，而用户在看新的那张。
     * App._plCurrent 被覆盖后点「播放全部」会播错歌单。
     * doSearch 早就有 _searchSeq，这里是同一套做法。
     */
    const my = ++_plSeq;
    /*
     * H-1：#plPlay / #plShuffle 读的是 App._plCurrent。
     * 失败时不清空就会保留「上一张歌单」，点播放全部会播上一张的歌，
     * 标题却是新歌单 —— 张冠李戴。请求前先置空，成功后再赋值。
     */
    App._plCurrent = null;
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
        /* 过期请求的失败不该覆盖新歌单的画面 */
        if (my !== _plSeq) return;
        $('#plTracks').innerHTML = `<div class="empty"><b>读取失败</b><p>${esc(e.message)}</p></div>`;
        const plLoad3 = $('#plLoading');
        if (plLoad3) plLoad3.textContent = '失败';
        return;
      }
    }
    /* 期间用户已经点了别的歌单：这一份结果直接丢掉 */
    if (my !== _plSeq) return;
    $('#plTitle').textContent = data.title;
    $('#plSub').textContent = [data.creator, data.sub, data.desc].filter(Boolean).join(' · ');
    $('#plArt img').src = coverOf(data);
    /*
     * H-7：再兜一层上限。上游虽然已经降到 300，但缓存/别的入口也可能塞进超长数组；
     * 一次 innerHTML 上万个节点会把主线程卡死。
     *
     * 只截断**渲染副本**，绝不能改 data.tracks：App._plCache 里存的就是这个对象，
     * 写回以后第二次打开同一张歌单就只能看到 300 首，提示里的「共 N 首」
     * 也变成了 300。队列仍用完整曲目，播到第 300 首还能继续往下。
     */
    const PL_MAX = 300;
    const total = data.tracks.length;
    const shown = total > PL_MAX ? data.tracks.slice(0, PL_MAX) : data.tracks;
    $('#plCount').textContent = total > PL_MAX
      ? `前 ${PL_MAX} 首（共 ${total} 首）`
      : total + ' 首';
    const cur = Player.track;
    $('#plTracks').innerHTML = shown.map((t, i) => rowHTML(t, i, cur && cur.id === t.id)).join('')
      || '<div class="empty"><b>空歌单</b></div>';
    /*
     * 成功路径必须把这个指示清掉。
     * 以前只在进入时设成「读取中…」、失败时设成「失败」，
     * 成功路径什么都没写 —— 于是这个 span 永远挂在「曲目」标题右边。
     */
    if (plLoad) plLoad.textContent = '';
    App._plCurrent = data;
  }

  /* ================= 设置 UI ================= */
  function syncSettingsUI() {
    const s = S();
    /*
     * 「设置 → 界面」这类开关的 DOM 副作用必须在这里补做一次。
     *
     * 以前只有 onSettingChange() 里写（那函数只在用户手动改设置时触发），
     * 启动流程里没有任何一处补写，于是：
     *   · 「列表密度」重启后回到标准行距
     *   · 「显示歌词」关掉后重启，播放页三行歌词又出现
     * 两项都表现为「设置没保存」，其实是保存了、只是没被应用。
     * syncSettingsUI() 在 boot 里会跑一次，放这里最省事也最不容易漏。
     */
    document.body.classList.toggle('compact', !!s.compactList);
    const mini = $('#npLyricMini');
    if (mini) mini.classList.toggle('hidden', !s.showLyric);
    $$('[data-set]').forEach((el) => {
      const k = el.dataset.set;
      if (el.classList.contains('sw')) {
        el.classList.toggle('on', !!s[k]);
        /* 开关现在是有语义的 role="switch"，状态要同步给读屏 */
        if (el.getAttribute('role') === 'switch') el.setAttribute('aria-checked', s[k] ? 'true' : 'false');
      }
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
    /* 窗口信息跟着设置页一起刷新：断点/方向变了以后这一行要跟着变 */
    $$('#themeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.theme === s.theme));
    $$('#fadeSeg button').forEach((b) => b.classList.toggle('on', +b.dataset.fade === +s.fade));
    $$('#qualitySeg button').forEach((b) => b.classList.toggle('on', b.dataset.q === s.quality));
    /* 画面性能档位：读 RipplePerf 的真实状态（它还有一档是「实测帧率后自动降级」，
       所以不能只看 localStorage，要看 html 上实际挂着的类）。 */
    const perfMode = (window.RipplePerf && RipplePerf.mode()) || 'auto';
    const perfLow = !!(window.RipplePerf && RipplePerf.isLow());
    $$('#perfSeg button').forEach((b) => b.classList.toggle('on', b.dataset.perf === perfMode));
    const perfHint = $('#perfHint');
    if (perfHint) {
      perfHint.textContent = perfMode === 'high' ? '高画质（始终开启毛玻璃与模糊）'
        : perfMode === 'low' ? '省电（关闭毛玻璃、减少模糊）'
        : perfLow ? '自动 · 已降级（实测帧率偏低）'
        : '自动 · 当前高画质';
    }
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
    /*
     * F-15：这两行是从 boot() 复制过来忘了删的。
     * syncSettingsUI() 被 renderAll() 调用，而 renderAll() 又被点赞、导入、
     * 清空、重置等每一个用户动作触发 —— 于是日志里塞满假的「BOOT: ready」，
     * 每次还要多排一个 refreshSystemBars 定时器（启动期日志里那 3 次 BOOT: ready、
     * 8 次 BARS: send 有一半来自这里）。
     * 状态栏颜色已经由 applyTheme()/paletteFor() 负责，这里不需要再刷。
     */
    syncNormalizeRow();
  }

  /**
   * F-1：让「音量归一化」这一行诚实反映它到底有没有效果。
   * 归一化靠 gainNode，只有能接进音频图的音源（本地/同源）才走这条链路；
   * 在线流是跨域直连，进了图会被判污染而静音，所以对在线曲目不生效。
   * 播在线歌时把这一行置灰 + 换副标题说明，而不是让用户反复开关找不到原因。
   */
  function syncNormalizeRow() {
    const sw = $('[data-set="normalize"]');
    if (!sw) return;
    const row = sw.closest('.set-row');
    const sub = row && row.querySelector('.tx span');
    const usable = Player.normalizeUsable ? Player.normalizeUsable() : false;
    /*
     * 播在线流时这一行置灰（点击仍然允许 —— 用户可以先开着，
     * 切到本地歌就自动生效，没必要强制他先播本地歌才能设置）。
     * CSS 不能改，所以用行内样式做视觉降级。
     */
    if (row) row.style.opacity = usable ? '' : '0.55';
    if (sub) {
      sub.textContent = !S().normalize
        ? '仅对本地/同源音源生效（在线流跨域不可测）'
        : (usable
          ? '已启用 · 正在按实测响度拉平'
          : '当前是在线流，对它不生效（CDN 不允许跨域读取）');
    }
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
    /*
     * 格式键两套写法都认：
     *   · 设置页的滑块用 data-set="volume" 之类；
     *   · 播放页「…」面板的滑块用 data-opt="volume" 之类（它同时是设置键名）。
     * 以前只读 dataset.set，面板里那四个滑块全都取不到格式，
     * 气泡显示成裸数字 0.85 / 1.05 / 12 / 0.5，和设置页的同名滑块对不上。
     */
    const key = el.dataset.set || el.dataset.opt;
    const fmt = SLD_FMT[key] || ((x) => String(x));
    tip.textContent = fmt(v);
    // thumb 14px 宽，可用轨道宽度 = 容器宽 - 14（容器还有 0 padding）
    const trackW = Math.max(1, wrap.clientWidth - 14);
    tip.style.left = (7 + (p / 100) * trackW) + 'px';
    if (showTip) tip.classList.add('on');
    else tip.classList.remove('on');
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

    // 首页 · hero 是「无限漫游」入口
    /*
     * 主按钮：从 hero 当前展示的歌出发，开启漫游。
     *
     * 行为与播放页那个「无限漫游」模式一致：把相似歌曲灌进队列并立刻播放，
     * 之后队列见底时会自动续（tail 里有 extendRoam 的钩子）。
     */
    $('#btnHeroPlay').addEventListener('click', async () => {
      const seed = App._roamHero || pickSeedForRoam();
      if (!seed || !seed.neId) {
        return toast('还没有可漫游的歌', '先播一首在线歌，或在「我的」里收藏几首', 'info');
      }
      if (!Netease.ready) {
        return toast('在线功能不可用', '漫游需要联网', 'warn');
      }
      toast('正在开启漫游…', seed.title, 'cloud');
      try {
        let list = await Netease.roamSongs(seed.neId, 30);
        if (!list.length) list = await Netease.personalFm();
        if (!list.length) throw new Error('没有拿到相似歌曲');
        /*
         * 队列顺序：**先播 hero 当前展示的那首**，再是它的相似歌曲。
         *
         * 以前这里是 [seed].concat(rest) —— 而 seed 是「种子歌」
         * （当前播放 / 我喜欢的第一首 / 每日推荐随机），
         * hero 卡片上写的却是另一首（漫游推荐）。
         * 于是用户点了「无限漫游」，播出来的不是卡片上那首，
         * 视觉和数据对不上。
         *
         * 现在以 hero 那首为起点：它既是第一首播的，也是这一轮漫游的种子。
         */
        const startTrack = App._roamHero && App._roamHero.neId ? App._roamHero : seed;
        const rest = list.filter((x) => x && x.neId !== startTrack.neId);
        const queue = [startTrack].concat(rest);
        S().playMode = 'roam'; Store.save(); syncModeButtons();
        App.context = queue;
        playTrack(queue[0], queue);
        openNP();
        toast('漫游已开启', queue.length + ' 首 · 会一直续下去', 'infinite');
      } catch (e) {
        toast('漫游开启失败', e.message, 'warn');
        Log.err('ROAM', e, 'hero play');
      }
    });
    /*
     * 副按钮：换一首。
     * 不重播、只换 hero 展示的那首（重新拉一批相似歌曲再挑一首）。
     */
    $('#btnHeroShuffle').addEventListener('click', async () => {
      const seed = pickSeedForRoam();
      if (!seed || !seed.neId) {
        return toast('还没有可漫游的歌', '先播一首在线歌，或收藏几首', 'info');
      }
      if (!Netease.ready) return toast('在线功能不可用', '漫游需要联网', 'warn');
      if (_roamHeroBusy) {
        /*
         * 在飞的时候再点：把它登记进队列（loadRoamHero 内部只留最后一次），
         * 当前这轮结束后会补跑一次。
         *
         * 这里**不 await** 它的返回值 —— 那拿到的是「当前这一轮」的结果，
         * 拿它去 toast 等于还是提示旧歌名，正是要修的那个问题。
         * 补跑的那一轮只负责把新歌换到 hero 上，提示由这里给出手反馈即可。
         */
        loadRoamHero(seed, true).catch(() => {});
        return toast('正在换，稍等', '', 'info');
      }
      const got = await loadRoamHero(seed, true);
      if (got) toast('换了一首', got.title, 'shuffle');
      else toast('没拿到新的推荐', '稍后再试', 'warn');
    });
    $('#dailyMore').addEventListener('click', () => {
      if (!App._dailyCache || !App._dailyCache.length) return;
      openDaily();
    });

    /*
     * 「推荐歌单 → 更多」：在首页内把横滑卡片换成 2 列网格，再点收起。
     *
     * 不新建页面：这一块的语义就是"多看几个推荐"，
     * 跳走反而多一步、还要再返回。展开用 hidden 属性控制，
     * 网格是懒渲染的（只有第一次展开才写 DOM）。
     */
    const recPlMore = $('#recPlMore');
    if (recPlMore) {
      recPlMore.addEventListener('click', () => {
        const grid = $('#recPlGrid');
        const car = $('#recPlCarousel');
        if (!grid || !car) return;
        const open = grid.hidden;
        if (open) {
          const items = App._recPlCache || [];
          if (!items.length) {
            toast('推荐歌单还没加载好', '稍等一下再试', 'info');
            return;
          }
          grid.innerHTML = items.map(plGridHTML).join('');
        }
        grid.hidden = !open;
        car.hidden = open;                 // 展开时把横滑那一排收起来，避免同一批内容出现两次
        recPlMore.setAttribute('aria-expanded', open ? 'true' : 'false');
        recPlMore.innerHTML = open
          ? '收起 <svg width="12" height="12" aria-hidden="true"><use href="#i-chev-down"/></svg>'
          : '更多 <svg width="12" height="12" aria-hidden="true"><use href="#i-chev-right"/></svg>';
        if (open) {
          /* 展开后把这一块滚进视野，否则用户看不到下面多出来的内容 */
          try { grid.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) {}
        }
      });
    }

    // 卡片 / 列表点击（委派）
    /*
     * 键盘激活：把 Enter / Space 转成一次 click。
     *
     * 行/卡现在带 role="button" tabindex="0"（见 rowHTML/gridHTML/
     * carouselHTML/plRowHTML），但 div 不会因为回车就触发 click ——
     * 浏览器原生只有真正的 <button> 会那样做。
     * 这里统一补一层：命中带 tabindex 的可激活元素时合成 click 事件，
     * 于是上面那套 document 级 click 委派原样复用，
     * 不需要给每个处理分支再写一遍键盘版本。
     */
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const t = e.target;
      if (!t || !t.matches) return;
      if (!t.matches('[role="button"][tabindex], .row[tabindex], .gcard[tabindex], .plrow[tabindex], .c-card[tabindex]')) return;
      e.preventDefault();
      const active = document.activeElement;
      t.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      /* 保持焦点，方便连续用键盘浏览 */
      if (active && active.focus) { try { active.focus(); } catch (err) {} }
    });

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

      /*
       * 曲库「专辑 / 艺人」分组行：筛出该组的歌并切回「歌曲」tab。
       * 必须放在 [data-id] 之前判断 —— 分组行没有 data-id，
       * 但下面那套逻辑遇到没有 data-id 的元素会直接 return。
       */
      const grp = e.target.closest('#libList [data-album], #libList [data-artist]');
      if (grp) {
        const name = grp.dataset.album != null ? grp.dataset.album : grp.dataset.artist;
        App._libGroup = { kind: grp.dataset.album != null ? 'album' : 'artist', name: name };
        setLibSeg('songs');
        renderLibrary();
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
        /*
         * 用户主动切到别的 tab 就不再保留分组筛选，
         * 否则再点「歌曲」时列表里只剩上次那个专辑的歌，看起来像丢歌了。
         */
        App._libGroup = null;
        renderLibrary();
      });
    }
    /* 分组筛选的「返回全部」提示：点它就清掉筛选 */
    const libHead = $('#libCount');
    if (libHead) {
      libHead.addEventListener('click', () => {
        if (!App._libGroup) return;
        App._libGroup = null;
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
        /*
         * B-4：标记成跨域直链。
         * 这类地址不返回 CORS 头，而 source:'local' 会把它路由到带
         * crossOrigin='anonymous' 的 elB → 媒体加载按 CORS 判失败，
         * 用户只看到「音源可能已失效」。remoteUrl 让 _pickEl 走不带
         * crossOrigin 的 elC。
         */
        remoteUrl: true,
      };
      /*
       * 审查 3.3：以前只 unshift 进内存数组 Store.localTracks ——
       * 既不写 IndexedDB、也不写 state.imports，**重启即消失**。
       * 用户加了一首歌，下次打开发现没了，而且没有任何提示，
       * 只会以为「软件坏了」。
       *
       * 现在：
       *   · 记进 state.imports（这是持久化的清单，localStorage 里）
       *   · 立刻 save() 落盘
       *   · 同时尝试写 IndexedDB（元数据），失败也不影响使用
       *     —— 直链曲目的音频本身在远端，不需要存文件，
       *     但把元数据存下来可以让「曲库」列表在重启后完整恢复。
       */
      Store.localTracks.unshift(t);
      const imps = Store.state.imports = Store.state.imports || [];
      if (!imps.some((x) => x && x.id === t.id)) {
        imps.unshift({
          id: t.id, source: 'local', title: t.title, artist: t.artist,
          album: t.album, duration: t.duration, cover: t.cover,
          src: t.src, format: t.format, remoteUrl: true,
          at: Date.now(),
        });
      }
      Store.save();
      /* IndexedDB 写元数据：失败只记日志，不影响「本次会话可用」 */
      if (!Store._volatile) {
        Promise.resolve(Store.dbPut(t)).catch((e) => Log.err('IMPORT', e, 'url import dbPut'));
      }
      renderAll();
      toast('已添加', '重启后仍在曲库里', 'check');
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
      // 清空输入时也作废在飞的搜索，否则旧结果会盖回空搜索页
      if (!v) { resetSearchSeq(); renderSearchDefaults(); return; }
      searchTimer = setTimeout(() => doSearch(v), 420);
    });
    $('#searchClear').addEventListener('click', () => {
      $('#searchInput').value = '';
      $('#searchClear').hidden = true;
      clearTimeout(searchTimer);
      resetSearchSeq();                       // F-3：清空后旧请求不得再写回结果
      renderSearchDefaults();
    });
    $$('#searchScope .chip').forEach((c) => c.addEventListener('click', () => {
      $$('#searchScope .chip').forEach((x) => x.classList.remove('on'));
      c.classList.add('on');
      App.scope = c.dataset.scope;
      clearTimeout(searchTimer);
      resetSearchSeq();                       // 换范围也作废上一范围的在飞请求
      const v = $('#searchInput').value.trim();
      if (v) doSearch(v);
      else if (App.scope === 'online') showOnlineIntro();
      else renderSearchDefaults();
    }));
    $('#searchBody').addEventListener('click', (e) => {
      /* H-6：加载更多（按钮自己会 disabled，这里再挡一次重复点击） */
      const more = e.target.closest('#searchMore');
      if (more) { if (!more.disabled) loadMoreSearch(); return; }
      const hot = e.target.closest('[data-hot]');
      if (hot) {
        $('#searchInput').value = hot.dataset.hot;
        $('#searchClear').hidden = false;
        doSearch(hot.dataset.hot);
      }
    });
    /*
     * H-6：滚到底自动续取。
     * 滚动容器是 .page[data-page="search"]（#searchBody 自己不是滚动容器），
     * 距离底部 240px 内就预取下一页，loadMoreSearch 内部有 loading 锁，
     * 连续滚动不会打出一串重复请求。
     */
    const searchPage = $('.page[data-page="search"]');
    if (searchPage) {
      searchPage.addEventListener('scroll', () => {
        if (!_searchSession || _searchSession.loading) return;
        if (_searchSession.loaded >= (_searchSession.total || 0)) return;
        const rest = searchPage.scrollHeight - searchPage.scrollTop - searchPage.clientHeight;
        if (rest < 240) loadMoreSearch();
      }, { passive: true });
    }

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

    /* ---------- 第 16 条：发表评论 ---------- */
    const _cmtBtn = $('#cmtSend'), _cmtIn = $('#cmtInput');
    if (_cmtBtn && _cmtIn) {
      const doSendComment = async () => {
        const t = Player.track;
        if (!t || t.source !== 'online' || !t.neId) {
          return toast('只能给在线歌曲评论', '', 'info');
        }
        if (!Netease.loggedIn) {
          return toast('先登录网易云', '登录后才能发表评论', 'warn');
        }
        const text = _cmtIn.value.trim();
        if (!text) return;
        _cmtBtn.disabled = true;
        _cmtBtn.textContent = '发送中';
        try {
          await Netease.addComment(t.neId, text);
          _cmtIn.value = '';
          toast('评论已发布', '', 'check');
          // 重新拉一次，让刚发的评论立刻出现（接口有延迟就等它自己刷）
          showComments();
        } catch (e) {
          toast('发表失败', e.message || '', 'warn');
          if (e.needLogin) Log.add('CMT', 'need login to post');
        } finally {
          _cmtBtn.disabled = false;
          _cmtBtn.textContent = '发送';
        }
      };
      _cmtBtn.addEventListener('click', doSendComment);
      _cmtIn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); doSendComment(); }
      });
    }

    // 歌词：点三行 → 页内展开；展开后再点行 → 跳转播放位置
    $('#npLyricMini').addEventListener('click', () => {
      lyricFollow = true;
      _lyricTouch = false;
      _lyricRecenter = true;
      const b = $('#npLyric');
      if (b) b.classList.remove('free');
      expandLyric();
    });
    $('#npLyric').addEventListener('click', (e) => {
      const ln = e.target.closest('.ln');
      if (!ln || !ln.dataset.t) return;
      // 用户点某一句 = 明确想回到这一句，恢复跟随
      lyricFollow = true;
      const box = $('#npLyric');
      if (box) box.classList.remove('free');
      /*
       * 必须扣掉 lyricOffset。
       * 高亮判定用的是 (歌词时间 + offset)，而这里以前直接 seek 原始时间，
       * 于是设了 +2s 偏移之后，点哪一句跳过去都会落在别的句上 ——
       * 越是靠后的歌词差得越明显。
       */
      const off = Number(S().lyricOffset) || 0;
      Player.seek(Math.max(0, +ln.dataset.t - off));
    });
    /* 滚动监听是挂在 #npLyric 容器上的，启动时绑一次就够；
       以前只在 renderLyric 里绑，没有歌词时完全没监听。 */
    bindLyricScroll();
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
      if (!Netease.loggedIn) { chooseLoginMode(); return; }
      /* 登录之后这张卡右边的 › 以前是纯装饰，点了什么都不发生（空实现）。
         现在打开账号详情：昵称 / VIP / 签名，外加刷新资料。 */
      const p = Netease.profile || {};
      modal(`
        <h3>${esc(p.nickname || '我的账号')}</h3>
        <p style="margin-bottom:14px">${esc(p.vip ? '黑胶 VIP' : '普通账号')}${p.signature ? ' · ' + esc(p.signature) : ''}</p>
        <div class="modal-btns">
          <button class="btn ghost" data-cancel>关闭</button>
          <button class="btn solid" id="acctReload">刷新资料</button>
        </div>
      `);
      $('#acctReload').onclick = async () => {
        App._myPl = null;
        invalidateHomeCaches();
        await refreshAccount();
        loadMyPlaylists();
        loadHomeOnline();
        toast('已刷新', (Netease.profile && Netease.profile.nickname) || '已重新拉取账号信息', 'check');
      };
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
      // F-12：同上 —— 不置空 src，改为后台重新解析地址
      reResolveQuality();
    });
    /* 画面性能档位：自动 / 高画质 / 省电。改完立刻生效，不用重进 App。 */
    $('#perfSeg').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-perf]');
      if (!b) return;
      const m = b.dataset.perf;
      const low = (window.RipplePerf ? RipplePerf.set(m) : false);
      syncSettingsUI();
      toast(m === 'high' ? '已切到高画质' : m === 'low' ? '已切到省电' : '已交给自动判断',
        low ? '当前：关闭毛玻璃、减少模糊' : '当前：毛玻璃与模糊全部开启', 'info');
    });
    $$('[data-set]').forEach((el) => {
      if (el.classList.contains('sw')) {
        el.addEventListener('click', () => {
          const k = el.dataset.set;
          const v = !S()[k];
          S()[k] = v; Store.save();
          el.classList.toggle('on', v);
          /* role="switch" 的状态要同步，否则读屏念的永远是初始值 */
          if (el.getAttribute('role') === 'switch') el.setAttribute('aria-checked', v ? 'true' : 'false');
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
    $('#rowClearHistory').addEventListener('click', async () => {
      /* H-9：相邻的「清空已导入的音乐」有二次确认，这条却没有 ——
         两个按钮长得一样，误触就永久删掉记录。补齐确认。 */
      if (!(await confirmDialog('清除播放记录？', '已听时长与最近播放都会被清空，不影响已导入的音乐'))) return;
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
      /*
       * 这两项以前漏了，于是"恢复默认"之后 UI 说关闭、运行时还在用旧值：
       *   · 接口地址：显示"默认"，实际仍用旧的 apiBase 发请求
       *   · 睡眠定时：显示"关闭"，已设的定时照旧到点暂停
       * 都要真的回滚。
       */
      try { Netease.setBase(S().apiBase || ''); } catch (e) {}
      try { Player.sleep(0); } catch (e) {}
      try {
        const sh = $('#sleepHint'); if (sh) sh.textContent = '关闭';
        const sl = $('[data-set="sleepMin"]'); if (sl) { sl.value = 0; paintSlider(sl); }
      } catch (e) {}
      document.body.classList.toggle('compact', !!S().compactList);
      applyVars();
      syncSettingsUI(); renderAll();
      /*
       * toast 文案以前写死「液态玻璃 · 深色」，而 DEFAULTS.theme 其实是 'auto'。
       * 按实际值说，别再给用户一个错误的结论。
       */
      const THEME_LABEL = { auto: '跟随系统', dark: '深色', light: '浅色' };
      toast('已恢复默认', '主题 · ' + (THEME_LABEL[S().theme] || '跟随系统'), 'check');
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
      /*
       * 只在"没有输入焦点、也没有可激活控件"时才接管全局快捷键。
       *
       * 以前只判了 INPUT，漏掉 TEXTAREA 和 contenteditable ——
       * 评论框里按空格会变成播放/暂停，字打不出来。
       * 更要命的是 Space 被无条件 preventDefault 后，
       * 键盘用户 Tab 到任意按钮上按空格，激活被吞、反而切换了播放。
       */
      const t = e.target;
      const tag = (t && t.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (t && t.isContentEditable) return;
      /* 焦点在可激活控件上时，把 Space/Enter 让给控件本身 */
      const act = t && t.closest && t.closest('button, a, [role="button"], [role="switch"], [tabindex]');
      if (act && (e.code === 'Space' || e.key === 'Enter')) return;
      if (e.code === 'Space') { e.preventDefault(); Player.toggle(); return; }
      if (e.key === 'ArrowRight') { Player.next(); return; }
      if (e.key === 'ArrowLeft') { Player.prev(); return; }
      /*
       * Esc 的优先级要跟返回键一致：先关遮罩/面板，最后才收播放页。
       * 以前无条件 closeNP()，桌面端按 Esc 想关个评论面板，
       * 结果整页播放页被收走了。
       *
       * 这里不再另写一套，直接复用 __rippleBack 的判定（见其注释）。
       * 旧实现引用的 closeAnySheet 与 [data-modal-cancel] 在仓库里都不存在，
       * 于是「命中 .modal-wrap」时既关不掉对话框、又无条件 return，
       * 按 Esc 在弹窗状态下完全没反应。
       * Esc 不承担「再按一次退出」，返回值只看它有没有关掉东西。
       */
      if (e.key === 'Escape') {
        const mt = modalTop();
        if (mt) { mt.close(null); return; }
        const sheet = $('.np-sheet.on');
        if (sheet) {
          const id = sheet.id || '';
          if (id === 'npQueueSheet') closeQueue();
          else if (id === 'npOptSheet') closeOptSheet();
          else if (id === 'cmtSheet') closeComments();
          else {
            sheet.classList.remove('on');
            $$('.sheet-mask.on').forEach((m) => m.classList.remove('on'));
            const nm = $('#npMask');
            if (nm) nm.classList.remove('on');
          }
          return;
        }
        closeNP();
      }
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
      // 用户可能刚从系统设置里授权回来，回前台就强制重问一次真实状态
      syncNotifyPermUI(true);
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
    if (k === 'normalize') { Player.setNormalize(v); syncNormalizeRow(); }
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
      /* 同上：变量而不是行内 font-size，否则 .on 的放大永远不生效 */
      el.style.setProperty('--ln-size', px + 'px');
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
  /*
   * F-3：搜索请求序号。
   * 输入框只有 420ms 防抖，没有请求序号：输入「周杰伦」后马上改成「林俊杰」，
   * 两个请求并发，先发的（周杰伦）如果后返回，会把林俊杰的结果覆盖掉 ——
   * 输入框写着林俊杰，列表却是周杰伦。这里只接受最新一次请求的结果。
   */
  let _searchSeq = 0;
  /* 歌单详情的请求序号：快速切换时只接受最新一次的结果（见 openPlaylist） */
  function resetSearchSeq() { _searchSeq++; }

  /*
   * ============ 搜索分页 ============
   *
   * H-6：以前固定只取 30 条，`offset` 参数在 Netease.searchSongs 里定义了却
   * 全项目没人传 —— 界面还显示 songs.total（比如「单曲 · 3127」），
   * 用户以为只有 30 首，剩下 99% 的结果永远取不到。
   *
   * 现在维护一份搜索会话（关键词 + 已取条数 + 总数），
   * 滚到底或点「加载更多」时按 offset 继续取，并把结果**追加**到列表末尾。
   * 换关键词/换范围都会重置会话，旧的在飞请求由 _searchSeq 作废。
   */
  const SEARCH_PAGE = 30;
  let _searchSession = null;   // { kw, loaded, total, plLoaded }

  /** 单曲行 + 末尾的「加载更多 / 已全部加载」提示 */
  function searchSongsTailHTML(sess) {
    if (!sess) return '';
    const total = sess.total || sess.loaded;
    if (sess.loaded >= total) {
      return total > SEARCH_PAGE
        ? `<div class="search-done">已经到底了 · 共 ${total} 首</div>` : '';
    }
    return `<button class="search-more" id="searchMore" type="button">
      加载更多<span>${sess.loaded} / ${total}</span></button>`;
  }

  /** 把一批新单曲追加到现有列表（不重建已有节点，滚动位置不变） */
  function appendSearchSongs(list, startIndex) {
    const body = $('#searchBody');
    const more = body.querySelector('#searchMore');
    const done = body.querySelector('.search-done');
    const host = more ? more.parentElement : (done ? done.parentElement : null);
    if (!host) return;
    /* 新行的 data-index 要接在已有行后面，否则点击播放会拿错曲目 */
    const frag = document.createElement('div');
    frag.innerHTML = list.map((t, i) => rowHTML(t, startIndex + i, false)).join('');
    /*
     * 必须精确命中「单曲」那个列表。
     *
     * 以前写的是 host.querySelector('.list')，而 doSearch 的渲染顺序是
     * 「歌单 div.list → 单曲标题 → 单曲 div.list → 加载更多按钮」，
     * 于是这个选择器永远命中**第一个** .list（歌单容器）——
     * 加载更多的新歌被插进了歌单区块，单曲区仍是 30 行，
     * 但按钮计数已经变成 60 / 3127。
     *
     * 现在 doSearch 给单曲容器打了 id="searchSongList"，直接按 id 定位；
     * 保留兜底是为了兼容旧缓存页面（SW 可能还在供旧 HTML）。
     *
     * ⚠️ 新行只能 appendChild 到列表尾部，不能 insertBefore(..., more)：
     * 「加载更多」按钮是 #searchSongList 的**兄弟**节点，拿它当参照节点
     * 按 DOM 规范必抛 NotFoundError，于是每次加载更多都变成「加载失败」。
     */
    const listEl = body.querySelector('#searchSongList');
    if (listEl) {
      while (frag.firstChild) listEl.appendChild(frag.firstChild);
      return;
    }
    /*
     * 旧缓存页面：没有 id，只能按位置找。
     * 单曲列表就是紧挨在「加载更多 / 到底了」前面的那个 .list
     * （doSearch 的顺序是「歌单 .list → 单曲标题 → 单曲 .list → 按钮」，
     * 用 querySelector('.list') 会命中前面那个歌单容器，又是一次老 bug）。
     * 找不到就退回父容器，至少别把行丢掉。
     */
    const tail = more || done;
    const prev = tail && tail.previousElementSibling;
    const fallbackList = prev && prev.classList.contains('list') ? prev
      : (host.classList.contains('list') ? host : null);
    if (fallbackList) {
      while (frag.firstChild) fallbackList.appendChild(frag.firstChild);
      return;
    }
    while (frag.firstChild) host.insertBefore(frag.firstChild, tail || null);
  }

  async function loadMoreSearch() {
    const sess = _searchSession;
    if (!sess || sess.loading) return;
    if (sess.loaded >= (sess.total || 0)) return;
    sess.loading = true;
    const btn = $('#searchMore');
    if (btn) { btn.disabled = true; btn.classList.add('loading'); }
    const my = _searchSeq;
    try {
      const r = await Netease.searchSongs(sess.kw, SEARCH_PAGE, sess.loaded);
      if (my !== _searchSeq) return;            // 期间换了关键词，丢弃
      const got = (r && r.list) || [];
      if (r && typeof r.total === 'number') sess.total = r.total;
      if (!got.length) {
        /* 上游给不出更多了：把总数收口到已取条数，尾巴换成「到底了」 */
        sess.total = sess.loaded;
        const more = $('#searchMore');
        if (more) more.outerHTML = `<div class="search-done">已经到底了 · 共 ${sess.loaded} 首</div>`;
        return;
      }
      appendSearchSongs(got, sess.loaded);
      sess.loaded += got.length;
      App.onlineResults = (App.onlineResults || []).concat(got);
      const more = $('#searchMore');
      if (more) {
        if (sess.loaded >= sess.total) {
          more.outerHTML = `<div class="search-done">已经到底了 · 共 ${sess.total} 首</div>`;
        } else {
          more.disabled = false;
          more.classList.remove('loading');
          const sp = more.querySelector('span');
          if (sp) sp.textContent = sess.loaded + ' / ' + sess.total;
        }
      }
    } catch (e) {
      const more = $('#searchMore');
      if (more) {
        more.disabled = false;
        more.classList.remove('loading');
        const sp = more.querySelector('span');
        if (sp) sp.textContent = '加载失败，点这里重试';
      }
      Log.err('SEARCH', e, 'loadMoreSearch');
    } finally {
      sess.loading = false;
    }
  }

  async function doSearch(kw) {
    const body = $('#searchBody');
    /* B-1：有搜索结果时收起热搜/推荐介绍区，避免它们挂在结果上面 */
    const intro = $('#searchIntro');
    if (intro) intro.hidden = true;
    const my = ++_searchSeq;                 // 每次调用都占一个序号（本地/在线都算）
    _searchSession = null;                   // 新搜索：作废旧会话
    if (App.scope === 'online') {
      if (!Netease.ready) { showOnlineIntro(); return; }
      body.innerHTML = `<div class="empty"><b>搜索中…</b><p>${esc(kw)}</p></div>`;
      try {
        const [songs, pls] = await Promise.all([
          Netease.searchSongs(kw, SEARCH_PAGE, 0),
          Netease.searchPlaylists(kw, 8).catch(() => ({ list: [] })),
        ]);
        if (my !== _searchSeq) return;         // 已有更新的请求，丢弃这次结果
        App.onlineResults = songs.list;
        /* H-6：记下这次搜索的会话，供「加载更多」继续取 */
        _searchSession = {
          kw: kw,
          loaded: songs.list.length,
          total: typeof songs.total === 'number' ? songs.total : songs.list.length,
          loading: false,
        };
        let html = '';
        if (pls.list.length) {
          html += `<div class="sec-head"><span class="n">PL</span><h2>歌单 · ${pls.list.length}</h2></div>
            <div class="list">${pls.list.map(plRowHTML).join('')}</div>`;
        }
        html += `<div class="sec-head"><span class="n">NE</span><h2>单曲 · ${songs.total || songs.list.length}</h2></div>`;
        html += songs.list.length
          ? `<div class="list" id="searchSongList">${songs.list.map((t, i) => rowHTML(t, i, false)).join('')}</div>
             ${searchSongsTailHTML(_searchSession)}`
          : `<div class="empty"><b>没有找到</b><p>换个关键词试试</p></div>`;
        body.innerHTML = html;
      } catch (e) {
        if (my !== _searchSeq) return;         // 过期请求的失败也不该覆盖新结果
        body.innerHTML = `<div class="empty"><b>搜索失败</b><p>${esc(e.message)}</p></div>`;
      }
      return;
    }
    const q = kw.toLowerCase();
    const res = Store.all().filter((t) =>
      (t.title || '').toLowerCase().includes(q)
      || (t.artist || '').toLowerCase().includes(q)
      || (t.album || '').toLowerCase().includes(q));
    if (my !== _searchSeq) return;
    App.onlineResults = null;
    body.innerHTML = res.length
      ? `<div class="sec-head"><span class="n">LOCAL</span><h2>本机 · ${res.length} 个结果</h2></div>
         <div class="list">${res.map((t, i) => rowHTML(t, i, false)).join('')}</div>`
      : `<div class="empty"><b>没有找到</b><p>试试切到「网易云」范围搜在线曲目</p></div>`;
  }

  function showOnlineIntro() {
    App.onlineResults = null;
    const ok = Netease.ready;
    const intro = $('#searchIntro');
    if (intro) intro.hidden = false;
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
  let _sbHidden = false;      // 已经确认隐藏过（避免重复跨桥，同时不误判页面重载后的状态）
  let _lastSbText = '';

  function sbNative() {
    const N = window.RippleNative;
    return !!(N && typeof N.showLyricOverlay === 'function');
  }

  function sbEnabled() {
    return !!S().sbLyric && sbNative();
  }

  /** 把配置推给原生并（重新）显示 */
  let _sbApplySig = '';
  function applySbOverlay(force) {
    const N = window.RippleNative;
    if (!N || typeof N.showLyricOverlay !== 'function') return;
    const s = S();
    /*
     * 跨桥幂等：syncSettingsUI() 每次用户动作都会走到这里，
     * 而这里的参数（颜色/位置/字号/填充）九成没变。
     * 参数签名没变且浮层已经在显示，就不再跨桥，省一次主线程 JNI 往返。
     */
    const sig = [!!s.sbLocked, s.sbColor, s.sbSize, s.sbAlpha, s.sbX, s.sbY,
      !!s.sbBold, !!s.sbShadow, !!s.sbFill, s.sbFillColor].join('|');
    if (!force && _sbNativeReady && sig === _sbApplySig) return;
    _sbApplySig = sig;
    try {
      N.showLyricOverlay(
        String(!!s.sbLocked), s.sbColor || '#FFFFFF', String(s.sbSize || 12),
        String(s.sbAlpha == null ? 0.92 : s.sbAlpha),
        String(s.sbX == null ? -1 : s.sbX), String(s.sbY == null ? -1 : s.sbY),
        String(!!s.sbBold), String(!!s.sbShadow),
        String(!!s.sbFill), s.sbFillColor || '#7DE3D0'
      );
      _sbNativeReady = true;
      _sbHidden = false;
      Log.add('LYRIC', 'overlay apply locked=' + s.sbLocked + ' color=' + s.sbColor);
    } catch (e) {
      Log.err('LYRIC', e, 'showLyricOverlay failed');
    }
    pushSbText(true);
  }

  function stopSbOverlay() {
    const N = window.RippleNative;
    if (!N || typeof N.hideLyricOverlay !== 'function') return;
    /*
     * 幂等但保守：只有在「上一次已确认隐藏成功」时才跳过跨桥。
     * 不能用 _sbNativeReady 反推 —— 页面重载后它是 false，而原生那边的
     * 浮层可能还留着，那种情况必须真的发一次 hide，否则浮层会卡在屏幕上。
     */
    if (_sbHidden) return;
    try { N.hideLyricOverlay(); } catch (e) {}
    _sbHidden = true;
    _sbNativeReady = false;
    _sbApplySig = '';
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
      const i = lyricIndexAt(t);          // 二分，见 lyricIndexAt
      if (i >= 0) line = lyricLines[i].text || '';
    }
    if (!force && line === _lastSbText) return;
    _lastSbText = line;
    try { N.updateLyricOverlay(line); } catch (e) {}
    pushSbProgress();
  }

  /** 把播放进度（0..1）推给浮层，用于文字填充效果 */
  let _sbProgLast = -1;
  function pushSbProgress() {
    const N = window.RippleNative;
    if (!N || typeof N.setLyricProgress !== 'function') return;
    if (!sbEnabled() || !_sbNativeReady || !S().sbFill) return;
    const d = Player.duration();
    if (!d || !isFinite(d)) return;
    const p = Math.max(0, Math.min(1, (Player.time() || 0) / d));
    // 每 1% 才推一次：进度填充肉眼看不出更细的差别，没必要每秒跨桥
    if (Math.abs(p - _sbProgLast) < 0.01) return;
    _sbProgLast = p;
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
          ${optRow('i-eq', '加粗', '让歌词更醒目', `<label class="sw${s.sbBold ? ' on' : ''}" data-sbsw="sbBold"></label>`)}
          ${optRow('i-eq', '描边阴影', '深色壁纸上更清楚', `<label class="sw${s.sbShadow ? ' on' : ''}" data-sbsw="sbShadow"></label>`)}
          ${optRow('i-play', '跟随进度填充', '已播放部分用另一种颜色',
            `<label class="sw${s.sbFill ? ' on' : ''}" data-sbsw="sbFill"></label>`)}
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

  let _mediaProgressKey = '';

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
      /*
       * 进度也做值级幂等：暂停时每秒推同一个位置毫无意义，
       * 而跨桥调用（JNI）正是启动/后台卡顿的主要来源之一。
       * 位置变化不到 1 秒、播放态也没变，就整条跳过。
       */
      const pkey = pos + '|' + (Player.playing ? 1 : 0);
      if (pkey === _mediaProgressKey) return;
      _mediaProgressKey = pkey;
      try { N.mediaProgress(String(pos), String(dur), !!Player.playing); } catch (e) {}
      return;
    }
    _mediaPushedKey = key;
    _mediaProgressKey = pos + '|' + (Player.playing ? 1 : 0);
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
    /* 第 8 条：通知栏的「喜欢」。
       直接借用播放页那个心形按钮的点击处理 —— 收藏/取消收藏、未登录提示、
       与云端的同步都在那一个处理函数里，不重复实现一遍。 */
    else if (cmd === 'like') {
      const b = document.getElementById('npLike');
      if (b) b.click();
    }
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
  /** 上次问到的通知权限状态；null = 还没问过 */
  let _notifyPermCache = null;
  function syncNotifyPermUI(force) {
    const N = window.RippleNative;
    const h = $('#permHint'), v = $('#permVal');
    if (!h || !v) return;
    if (N && typeof N.notifyGranted === 'function') {
      /*
       * notifyGranted() 是一次跨桥调用，而 syncSettingsUI() 会被每个用户动作触发。
       * 权限状态平时不会变，只有「从系统设置回来」或原生回调才会变 ——
       * 所以这里缓存结果，只在 force 时才真的跨桥问一次（省 JNI 往返）。
       */
      let ok;
      if (!force && _notifyPermCache !== null) {
        ok = _notifyPermCache;
      } else {
        ok = false;
        try { ok = !!N.notifyGranted(); } catch (e) {}
        _notifyPermCache = ok;
      }
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
    _notifyPermCache = null;
    syncNotifyPermUI(true);
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
    let sx = 0, sy0 = 0, dragging = false, fromTop = false, onCoverStart = false;

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
    /* ---------- 第 4 条：封面横向跟手 + 下一首封面滑入 ----------
     * 交互约定：
     *   · 手指按在封面上横向拖 → 当前封面跟手位移并轻微缩小，
     *     下一首（往左拖）或上一首（往右拖）的封面从对面滑进来
     *   · 松手超过封面宽度 30% → 完成切换并播完滑入动画
     *   · 没到 30% → 弹回原位
     *   · 竖向为主的拖动仍然交给「下滑关闭播放页」那条老逻辑，
     *     两套手势在第一帧按主轴方向分流，互不抢
     */
    const _cv = $('#npCover');
    const _cvPeek = $('#npCoverPeek');
    const _cvPeekImg = $('#npCoverPeekImg');
    let _cvArmed = false;      // 起点在封面上，等方向判断
    let _cvActive = false;     // 已判定为横向，接管手势
    let _cvW = 240;
    let _cvSign = 1;           // +1 = 下一首从右侧进；-1 = 上一首从左侧进

    function _cvNeighbor(next) {
      const q = (Player && Player.queue) || [];
      if (!q.length) return null;
      const n = q.length;
      const i = (Player.index == null ? 0 : Player.index);
      return next ? q[(i + 1) % n] : q[(i - 1 + n) % n];
    }
    function _cvUrl(t) {
      return (t && (t.cover || t.picUrl || (t.al && t.al.picUrl))) || '';
    }
    function _cvPeekAt(offset, opacity) {
      if (!_cvPeek) return;
      _cvPeek.style.transform = 'translate(-50%,-50%) translateX(' + offset + 'px)';
      _cvPeek.style.opacity = String(opacity);
    }
    function _cvBegin(dx) {
      if (!_cv) return;
      _cvW = _cv.getBoundingClientRect().width || 240;
      _cvSign = dx < 0 ? 1 : -1;                 // 往左拖 → 下一首
      const nb = _cvNeighbor(_cvSign === 1);
      const url = _cvUrl(nb);
      if (_cvPeekImg) _cvPeekImg.src = url;
      if (_cvPeek) _cvPeek.style.visibility = url ? '' : 'hidden';
      _cv.style.transition = 'none';
      if (_cvPeek) _cvPeek.style.transition = 'none';
    }
    function _cvDrag(dx) {
      if (!_cv) return;
      const gap = _cvW + 14;
      const p = Math.min(1, Math.abs(dx) / (_cvW * 0.45));
      _cv.style.transform = 'translateX(' + dx + 'px) scale('
        + (1 - Math.min(0.05, Math.abs(dx) / _cvW * 0.05)).toFixed(3) + ')';
      _cvPeekAt(_cvSign * gap + dx, p);
    }
    function _cvEnd(commit) {
      if (!_cv) return;
      const w = _cvW || 240;
      const gap = w + 14;
      const tr = 'transform .24s var(--ease-soft),opacity .24s var(--ease-soft)';
      _cv.style.transition = tr;
      if (_cvPeek) _cvPeek.style.transition = tr;
      if (commit) {
        // 当前封面飞出，预览封面归位 → 再真正切歌，然后无动画复位
        _cv.style.transform = 'translateX(' + (-_cvSign * (w + 40)) + 'px) scale(.94)';
        _cvPeekAt(0, 1);
        setTimeout(() => {
          try { _cvSign === 1 ? Player.next() : Player.prev(); } catch (e) {}
          _cv.style.transition = 'none';
          if (_cvPeek) _cvPeek.style.transition = 'none';
          _cv.style.transform = '';
          _cvPeekAt(_cvSign * gap, 0);
          void _cv.offsetWidth;   // 强制 reflow，避免复位被当成一次动画
        }, 230);
      } else {
        _cv.style.transform = '';
        _cvPeekAt(_cvSign * gap, 0);
      }
    }

    np.addEventListener('touchstart', (e) => {
      const t = e.targetTouches[0];
      sy0 = t.clientY; sx = t.clientX;
      if (inSheet(e.target)) {           // 面板内：整页手势完全不介入
        dragging = false;
        fromTop = false;
        return;
      }
      const onScroll = inScrollable(e.target);
      /*
       * H-5：以前「播放页顶部 220px 内横滑 60px」就切歌，顶部误触很容易换掉歌。
       * 现在竖向下滑关闭仍允许从顶部区域开始（<120px），
       * 但横向切歌只在封面起手时才生效。
       */
      const onCover = !!e.target.closest('.np-cover');
      onCoverStart = onCover;            // H-5：只有封面起手才允许横向切歌
      fromTop = !onScroll && (t.clientY < 120 || e.target.closest('#npClose') || onCover);
      dragging = !onScroll || onCover;
      // 起点在封面上：可能是横切封面、也可能是纵向下滑关闭，等第一帧定方向
      _cvArmed = !inSheet(e.target) && !!e.target.closest('.np-cover');
      _cvActive = false;
    }, { passive: true });

    np.addEventListener('touchmove', (e) => {
      if (!dragging) return;
      const t = e.targetTouches[0];
      const dy = t.clientY - sy0;
      const dx = t.clientX - sx;
      /* 第一帧按主轴方向分流：横向 = 封面跟手切歌，纵向 = 下滑关闭 */
      if (_cvArmed && !_cvActive) {
        if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.2) {
          _cvActive = true;
          _cvBegin(dx);
        } else if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {
          _cvArmed = false;
        }
      }
      if (_cvActive) { _cvDrag(dx); return; }
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
      if (_cvActive) {
        _cvActive = false;
        _cvArmed = false;
        // 超过封面宽度 30% 才算切歌，否则弹回
        _cvEnd(Math.abs(dx) > (_cvW || 240) * 0.3);
        return;
      }
      _cvArmed = false;
      np.style.transition = '';
      np.style.transform = '';
      if (fromTop && dy > 90) { closeNP(); return; }
      if (onCoverStart && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.6) {
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
  /**
   * 当前打开的模态框栈。
   *
   * 以前 modal() 只是往 body 塞一个 .modal-wrap：
   *   · 没有 role="dialog" / aria-modal，读屏不知道这是对话框
   *   · 不把焦点移进去，也不做焦点陷阱，Tab 会跑到底下的页面里
   *   · Esc 不关（反而会把播放页收走）
   *   · **返回键完全不认识它** —— __rippleBack 只认 .np-sheet.on 和播放页，
   *     所以确认框开着时按一次返回提示"再按一次退出"，再按一次 App 就退了，
   *     而 `await confirmDialog()` 永远不 resolve，用户的操作被无声丢弃。
   * 这里用一个栈记录，返回键/Esc 都优先处理最上层的那个。
   * （_modalStack 本身声明在文件前部的序号区，因为 __rippleBack 更早用到它。）
   */

  function modal(html, opts = {}) {
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.className = 'modal-wrap';
      /* 对话框语义：读屏会念"对话框"，且知道它是模态的 */
      wrap.setAttribute('role', 'dialog');
      wrap.setAttribute('aria-modal', 'true');
      wrap.innerHTML = `<div class="modal glass">${html}</div>`;
      document.body.appendChild(wrap);
      requestAnimationFrame(() => wrap.classList.add('on'));
      /* 记下打开前的焦点，关闭时还回去 */
      const prevFocus = document.activeElement;
      let closed = false;
      const close = (v) => {
        if (closed) return;
        closed = true;
        const i = _modalStack.indexOf(entry);
        if (i >= 0) _modalStack.splice(i, 1);
        /*
         * L-19：关闭弹窗前必须 blur() 里面的输入框。
         * Android WebView 里 input 失去 DOM 后焦点不会自动释放，
         * 软键盘会一直盖在页面上、挡住底部按钮（用户只能手动按返回）。
         * 先 blur 再移除节点，键盘才会真的收起。
         */
        const active = document.activeElement;
        if (active && (wrap.contains(active) || active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
          try { active.blur(); } catch (e) {}
        }
        wrap.classList.remove('on');
        setTimeout(() => wrap.remove(), 260);
        /* 焦点还原，键盘用户不会掉回 body */
        try { if (prevFocus && prevFocus.focus) prevFocus.focus(); } catch (e) {}
        resolve(v);
      };
      const entry = { wrap, close };
      _modalStack.push(entry);
      /* 给标题一个 id，用 aria-labelledby 关联，读屏念得出这是什么框 */
      const h3 = wrap.querySelector('h3');
      if (h3) {
        const hid = 'modal-h-' + (++_modalIdSeq);
        h3.id = hid;
        wrap.setAttribute('aria-labelledby', hid);
      }
      wrap.addEventListener('click', (e) => { if (e.target === wrap) close(null); });
      const ok = $('[data-ok]', wrap), cancel = $('[data-cancel]', wrap);
      if (ok) ok.addEventListener('click', () => close(opts.confirm ? true : ($('input', wrap) ? $('input', wrap).value : true)));
      if (cancel) cancel.addEventListener('click', () => close(null));
      /*
       * 焦点接管 + 陷阱：打开时把焦点移到第一个可聚焦元素（或输入框），
       * Tab / Shift+Tab 在框内循环，不会跑到后面的页面去。
       */
      const focusables = () => $$('input, textarea, button, [tabindex]:not([tabindex="-1"])', wrap)
        .filter((el) => !el.disabled && el.offsetParent !== null);
      wrap.addEventListener('keydown', (e) => {
        if (e.key !== 'Tab') return;
        const f = focusables();
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      });
      const inp = $('input', wrap);
      if (inp) setTimeout(() => inp.focus(), 120);
      else setTimeout(() => { const f = focusables(); if (f.length) f[0].focus(); }, 120);
      opts.onMount && opts.onMount(wrap, close);
    });
  }

  /** 有没有开着的模态框（返回键/Esc 要优先处理它） */
  function modalTop() {
    return _modalStack.length ? _modalStack[_modalStack.length - 1] : null;
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

  /**
   * 第 4 条：窗口信息并入「软件日志」。
   * 以前它单独占一行，但它的用途只是排查（窄栏/断点没命中），
   * 和日志是同一类东西；合在一起以后复制日志时窗口信息会一起带出去。
   */
  function winInfoText() {
    const w = Math.round(innerWidth || 0), h = Math.round(innerHeight || 0);
    const d = Math.round((window.devicePixelRatio || 1) * 100) / 100;
    let railW = 0, cmax = '';
    try {
      const cs = getComputedStyle(document.documentElement);
      railW = parseFloat(cs.getPropertyValue('--rail-w')) || 0;
      cmax = (cs.getPropertyValue('--content-max') || '').trim();
    } catch (e) {}
    let out = '视口 ' + w + '×' + h + ' · dpr ' + d
      + ' · ' + (railW > 0 ? '竖排导航' : '底部导航')
      + (cmax ? ' · 内容上限 ' + cmax : '');
    try {
      const sw = Math.round(screen.width || 0), sh = Math.round(screen.height || 0);
      const full = w > h ? Math.max(sw, sh) : Math.min(sw, sh);
      if (full > 0 && w < full * 0.8) out += ' · 窗口被系统限宽（屏幕 ' + full + '）';
    } catch (e) {}
    const v = (typeof RIPPLE_VERSION !== 'undefined' && RIPPLE_VERSION) || {};
    return '[设备] ' + out + '\n[版本] ' + (v.name || '?') + ' · build ' + (v.code == null ? '?' : v.code);
  }

  function showLog() {
    const text = winInfoText() + '\n\n' + (Log.nativeDump() || '(日志为空)');
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
    /*
     * 「设置 → 软件内通知」关掉后，顶部弹出的通知不再显示。
     *
     * 这是在**函数入口**统一拦住，而不是去改 106 个调用点 ——
     * 那样改必然漏，而且以后新加通知又会忘。
     *
     * 以下几类不被开关影响：
     *   ① warn（失败/异常）—— 「登录未完成」「这首歌放不了」这类
     *      如果也被吞掉，用户只会觉得"点了没反应"，反而更糟。
     *      关通知的意图是"别打扰我"，不是"出错了也别告诉我"。
     *   ② check（操作成功确认）—— 「已添加」「登录成功」「已恢复默认」
     *      同样承担"告诉我做成了"的职责，吞掉会和 ① 一样变成"点了没反应"。
     *   ③ 底部 toastBottom（"再按一次返回退出"这类操作确认），
     *      它是另一套通道，压根不走这里。
     * 原生系统通知由 settings.notifyQuiet 单独控制，与这个开关无关。
     */
    if (!S().inAppToast && icon !== 'warn' && icon !== 'check') return;
    const wrap = $('#toasts');
    if (!wrap) return;
    /*
     * L-15：去重键必须带上 type。
     * 旧键只有「标题+正文」，不同事件撞键就会被吞掉 ——
     * 例如 1.2 秒内连点两首歌，两条「正在解析音源…」只弹一条，
     * 用户以为第二次没点上（也正是 F-13 反馈里那种「点了没反应」）。
     */
    const key = (icon || '') + '\u0000' + title + '\u0000' + (desc || '');
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

  /* ---------- 第 5 条：底部 dock 胶囊提示 + 两次下拉退出 ----------
   * 顶部 toasts 表达「通知」，底部这个表达「操作确认」：
   * 只保留一条、短、贴着 dock 上方，做成胶囊形状。
   */
  let _toastBottomTimer = null;
  let _exitHintAt = 0;

  function toastBottom(title, desc, icon, ms) {
    const wrap = $('#toastsBottom');
    if (!wrap) return;
    wrap.innerHTML = '';            // 底部只留一条，避免堆叠盖住 dock
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = `<div class="ic"><svg><use href="#${ICONS[icon] || 'i-info'}"/></svg></div>
      <div class="ti"><b>${esc(title)}</b>${desc ? `<p>${esc(desc)}</p>` : ''}</div>`;
    wrap.appendChild(el);
    clearTimeout(_toastBottomTimer);
    _toastBottomTimer = setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 300);
    }, ms || 1800);
  }

  /* ================= 杂项 ================= */
  /* ================= 记忆上次播放（歌曲 + 进度 + 队列） ================= */

  /** 节流保存进度，避免每秒写 localStorage */
  let _progressAt = 0;
  /*
   * L-16：两个层面的降频。
   * ① 时间：从 4 秒放宽到 12 秒（进度是用来「续播」的，秒级精度没有意义）。
   * ② 数据量：不再 Store.save() 序列化整个 state（history 200 + onlineCache 60），
   *    改走 Store.saveProgress() 只写 4 个进度字段（几十字节）。
   */
  const PROGRESS_EVERY = 12000;
  function rememberProgress(force) {
    const t = Player.track;
    if (!t) return;
    const now = Date.now();
    if (!force && now - _progressAt < PROGRESS_EVERY) return;
    /* 「已听分钟」统计：顺手把两次调用之间真正在播的秒数累加进去。
       以前 Store.addPlayed() 定义了却从没人调用，统计永远显示 0。 */
    if (Player.playing && _progressAt) {
      const dt = (now - _progressAt) / 1000;
      if (dt > 0 && dt < 40) Store.addPlayed(dt);   // 超过 40s 视为挂起/后台，不计入
    }
    _progressAt = now;
    const pos = Math.max(0, Player.time() || 0);
    const q = (Player.queue && Player.queue.length ? Player.queue : [t])
      .slice(0, 200).map((x) => x.id);
    S().lastTrackId = t.id;
    S().lastPosition = pos;
    S().lastQueue = q;
    S().queueIndex = Player.index;
    Store.saveProgress({
      lastTrackId: t.id, lastPosition: pos, lastQueue: q, queueIndex: Player.index,
    });
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
    /*
     * 接管序号必须在函数最开头登记。
     *
     * 下面解析在线直链要串行试档、每档最长 22s，这期间用户完全可能自己点了歌。
     * 序号若等到解析完再自增，等于把自己追平到最新值，stillMine() 恒为真，
     * 守卫就形同虚设——这正是上一版「注释说修好了、实际没生效」的地方。
     */
    const myRestore = ++App._restoreSeq;
    const stillMine = () => App._restoreSeq === myRestore;

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
            t.srcAt = Date.now();      // 与 src 成对写入
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
      if (!stillMine()) return;
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
    /*
     * ⚠️ 这是一个「后台异步恢复」的过程，而 boot 并没有 await 它
     * （见 boot 里的 restoreLast().catch(...)），界面早已可交互。
     * 解析在线地址最多要串行试 3 档、每档最长 25s，用户完全可能
     * 在这 75 秒里自己点了别的歌。
     *
     * 以前这里没有任何「用户已接管」的判断，于是会直接把用户正在听的歌换掉；
     * 更隐蔽的是 applyPos 读的是外层 Player.el（而不是当时这首歌的元素），
     * 延迟 1.2 秒执行时若已切歌，会把**新歌**的 currentTime 写成旧进度。
     *
     * 现在：
     *   · 每次 restoreLast 开始时记一个序号，用户任何播放动作都会 ++
     *   · 每个可能写播放器状态的节点都先校验序号没变
     *   · applyPos 闭包捕获当时的元素与期望位置，不再读 Player.el
     *   · 序号已在函数开头登记（见上方说明），这里不能再自增，否则会把自己追平
     */
    if (!stillMine()) return;
    Player.queueSet(list, at);
    Player.track = t;
    /*
     * 走 Player.load() 而不是直接写 el.src。
     *
     * load() 会顺带做完整套：设 playbackRate（播放速度）、发 track 事件、
     * 更新 MediaSession、必要时建 WebAudio 图并重下发 EQ。
     * 以前恢复路径只写了 src/volume，于是：
     *   · 变速 1.5× → 重启后回到 1.0×
     *   · 本地歌的均衡器预设看起来开着但不生效
     *   · 通知栏元数据要等下次交互才刷新
     *
     * 第二个参数传 false：恢复不该自动出声，仍停在暂停态等用户点。
     */
    let loadOk = true;
    try {
      Player.load(t, false);
    } catch (e) {
      loadOk = false;
      Log.err('RESTORE', e, 'Player.load failed: ' + t.title);
    }
    if (!loadOk) {
      /* load 失败（非法 URL 等）时退回最小实现，至少界面是对的 */
      if (!stillMine()) return;
      Player.el = Player._pickEl(t);
      try { Player.el.src = new URL(t.src, location.href).href; } catch (e) {}
      Player.el.volume = S().volume;
    }

    /*
     * 元素也一起捕获进闭包：1.2 秒后的兜底调用如果去读 Player.el，
     * 那时它可能已经指向另一首歌的元素，就把旧进度写进新歌了。
     * 序号校验是第一道闸，这里是不依赖序号的第二道。
     */
    const posEl = Player.el;
    const applyPos = () => {
      /* 用户已经接管播放：这次恢复的一切都不许再写播放器 */
      if (!stillMine()) return;
      const el = posEl;
      if (!el) return;
      const d = el.duration;
      const pos = (isFinite(d) && d > 0) ? Math.min(savedPos, d - 1) : savedPos;
      if (pos > 0.5) {
        try { el.currentTime = pos; } catch (e) {}
      }
      updateTimes();
      Log.add('RESTORE', 'restored ' + t.title + ' @' + pos.toFixed(1) + 's');
    };
    if (Player.el.readyState >= 1) applyPos();
    else Player.el.addEventListener('loadedmetadata', applyPos, { once: true });
    // 兜底：某些内核不触发 loadedmetadata
    setTimeout(applyPos, 1200);

    /* 走到这里说明恢复仍然有效；再校验一次，避免上面这一段同步调用期间被接管 */
    if (!stillMine()) return;
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
  /*
   * 导出 toast / toastBottom。
   *
   * perf.js 会自动降画质后想告诉用户"发生了什么"，
   * 它写的是 `if (g.RippleApp && typeof g.RippleApp.toast === 'function')`，
   * 但这里以前只导出了 play 和 go —— toast 是 IIFE 内部函数，
   * 那个判断恒为 false，于是低端机上画面**突然变丑、没有任何解释**。
   * 同理 showAbout 之类的内部函数如需外部调用也在这里补。
   */
  App.toast = toast;
  App.toastBottom = toastBottom;
  window.RippleApp = App;
  document.addEventListener('DOMContentLoaded', boot);
})();
