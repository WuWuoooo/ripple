/* ============================================================
   状态 / 本地库 / 设置持久化
   ============================================================ */
(function (g) {
  const KEY = 'ripple.state.v1';
  /*
   * L-16：播放进度单独存一个小键。
   * 以前每 4 秒把整个 state（history 200 条 + onlineCache 60 条）JSON.stringify
   * 再同步写 localStorage —— 主线程卡顿与耗电的固定来源，而且这些数据 99% 没有变化。
   * 现在进度只写这一个小对象，整份 state 只在真正改设置/曲库时才整体落盘。
   */
  const KEY_PROGRESS = 'ripple.progress.v1';
  const DB_NAME = 'ripple-db';
  const DB_STORE = 'files';

  const DEFAULTS = {
    theme: 'auto',       // 默认跟随系统深浅色
    dynamicColor: true,
    glassBlur: 26,
    animSpeed: 1,
    compactList: false,
    quality: 'exhigh',
    eq: 'off',
    eqCustom: [0, 0, 0, 0, 0],   // 自定义均衡器的 5 段增益（dB）
    fade: 0.4,
    gapless: true,
    normalize: false,
    speed: 1,
    showLyric: true,
    /*
     * 软件内通知：控制顶部弹出的 toast（不是系统通知栏）。
     * 默认**开启** —— 2026-11-22 按用户要求设为默认打开。
     * （原注释说「顶部通知会盖住内容，默认关闭」，但实际用下来
     * 切歌/收藏/网络失败这些即时反馈没有提示反而不确定操作有没有生效。）
     * 注：底部的操作确认（如"再按一次退出"）不受这个开关影响。
     */
    inAppToast: true,
    showTrans: true,
    lyricSize: 11,
    lyricOffset: 0,
    mediaSession: true,
    notifyQuiet: true,
    apiBase: '',
    syncLikes: true,
    volume: 0.85,
    shuffle: false,
    repeat: 'all',
    playMode: 'list',
    lastIndex: 0,
    lastTrackId: '',
    lastPosition: 0,
    lastQueue: [],
    /* ---------- 状态栏歌词 ---------- */
    sbLyric: false,           // 开关
    sbLocked: true,           // 锁定：不可拖动、不可改
    sbColor: '#FFFFFF',       // 颜色
    sbSize: 12,               // 字号 sp
    sbAlpha: 0.92,            // 不透明度
    sbX: -1,                  // 位置（px，-1 = 默认）
    sbY: -1,
    sbBold: true,
    sbShadow: true,
    sbFill: true,             // 跟随播放进度填充（1.3.3 起默认开：卡拉OK染色是本版主功能）
    /*
     * 填充色默认用**强调紫**而不是原来的浅青 #7DE3D0。
     *
     * 原因：文字默认色是纯白 #FFFFFF，而浅青和白色都是高明度色，
     * 在深色状态栏上「已唱/未唱」两部分亮度几乎一样 ——
     * 用户反馈「打开填充就只是边缘发亮，没有填充效果」，根子就在这。
     * 换成和白色有明显色相差的紫，且明度低于白色，填充边界一眼可见。
     * （这两个值都取自主题的 --accent，和整体观感同族。）
     */
    sbFillColor: '#b3a2ff',   // 填充色：已播放部分的颜色
    /*
     * 状态栏歌词的两个「深色模式自动反色」开关。
     *
     * ⚠️ 默认**关闭**（与 karaokeInvert 的默认值不同，这是有意的）。
     *
     * 曾经一度默认开，结果是一个严重的回归：状态栏浮层盖在**系统状态栏**
     * 上，背景是用户的壁纸，**跟 App 的深/浅色主题毫无关系**。
     * 而用户的壁纸九成是深色 —— 默认反色就把白字变成纯黑
     *（实测日志 `overlay apply color=#000000`），暗橄榄色填充，
     * 在深色背景上完全看不见，用户报的「填充只有边缘发亮/完全没有填充」
     * 就是这个原因。
     *
     * 所以这里保持关闭：浮层颜色该由用户对着自己的壁纸调，
     * 不该被 App 主题的深浅联动。想要联动的用户可以自己打开。
     */
    sbInvert: false,
    sbFillInvert: false,
    /* ---------- 卡拉OK逐句染色（三端通用，与上面的状态栏浮层无关） ----------
     * 和 sbFill 的区别：
     *   sbFill     只管「状态栏浮层那一条」的文字填充，只在 APK 有意义；
     *   karaokeLyric 管四个歌词表面：状态栏浮层、展开的整篇、收起的三行、
     *               桌面端的独立歌词窗。桌面端和浏览器里只有它能生效。
     * 默认开 —— 它本来就是「歌词跟着播放进度染色」这个需求的正面实现，
     * 而不是可选装饰；给开关只是为了照顾「不喜欢花哨效果」的用户和省电模式。
     */
    karaokeLyric: true,
    karaokeDone: true,        // 已唱完的行是否做静态标记（关掉只留当前句染色）
    /*
     * 染色的「已播放」色。空串 = 用主题默认色（深色 #b3a2ff / 浅色 #5833ff）。
     *
     * 为什么默认空串而不是写死一个十六进制：
     *   主题有两套，同一个颜色在两套背景上的可读性完全不同
     *   （实测 #b3a2ff 在浅色底只有 1.91:1，必须压暗成 #5833ff 才有 5.45:1）。
     *   写死就必然有一套主题是错的。空串让 CSS 的 --karaoke-played 接管，
     *   用户主动选了颜色才覆盖。
     */
    karaokeColor: '',
    /*
     * 「跟随主题反色」：开启时，用户选的染色色在深浅两个主题下**互为反色**。
     *
     * 为什么需要：用户选了一个颜色（比如浅色主题下的黑 #000000），
     * 切到深色主题后，同一个黑色在深底上完全看不见。
     * 开着这个开关，深色主题会自动用它的反色（#FFFFFF），
     * 一个颜色选择就能在两套主题下都可用。
     * 默认**开**（用户要求）—— 大多数人只在一种主题下挑颜色，
     * 切到另一套主题后颜色失效是很常见的困惑，反色能自动兜住。
     * 不喜欢的人可以在取色器里关掉（关掉后两套主题都用同一个颜色）。
     */
    karaokeInvert: true,

    sleepMin: 0,          // 睡眠定时（分钟）；以前 DEFAULTS 里根本没有这一项
    sleepUntil: 0,        // 睡眠定时的绝对结束时刻，重启后据此恢复
  };

  /* ---------------- 设置项的坏值收敛 ----------------
   *
   * localStorage 里的 settings 是纯字符串，任何字段都可能被写坏：
   * 手工改、老版本遗留、写一半的配额错误、或者别的脚本污染。
   * 以前这里是 Object.assign({}, DEFAULTS, saved.settings) —— 坏值**原样**
   * 进入运行时，然后以各种难以定位的方式表现出来：
   *   theme: 42        → 掉进 else 分支当深色
   *   lyricSize:'abc'  → 生成 "abcpx"，浏览器直接丢弃，字号"调了没反应"
   *   glassBlur: null  → "nullpx" 同样被丢弃
   * 用户没有任何提示，只能逐项重设，而且完全不知道发生了什么。
   *
   * 这里按 DEFAULTS 的类型逐项校验，坏值回落默认。
   * 数值项额外钳到合理区间，避免 "glassBlur: 999999" 这类也不会崩、
   * 但会让每帧模糊计算爆炸的写入。
   */
  const NUM_RANGE = {
    glassBlur: [0, 40],
    animSpeed: [0.4, 2.5],
    fade: [0, 5],
    speed: [0.5, 2],
    lyricSize: [11, 19],
    lyricOffset: [-10, 10],
    volume: [0, 1],
    shuffle: [0, 1],          // 实际是 bool，见下
    sleepMin: [0, 24 * 60],
    sleepUntil: [0, Number.MAX_SAFE_INTEGER],
    sbSize: [8, 30],
    sbAlpha: [0, 1],
    sbX: [-100000, 100000],
    sbY: [-100000, 100000],
    lastIndex: [0, 100000],
    lastPosition: [0, 1e9],
  };
  // 白名单枚举：不在这几个值里的直接回落默认
  const ENUMS = {
    theme: ['auto', 'dark', 'light'],
    /*
     * quality 以 netease.js 的 LEVELS 为准：5 档（standard/higher/exhigh/lossless/hires）。
     * 以前白名单只有 4 档、漏了 hires —— 这是「eq 三处名单统一」整改的姊妹漏网：
     * 播放设置面板能选到 Hi-Res 并落盘，但 coerceSettings 不认这个值，
     * 重启后静默回落 exhigh。表现为「Hi-Res 只在当次会话有效」。
     */
    quality: ['standard', 'higher', 'exhigh', 'lossless', 'hires'],
    /*
     * eq 以 player.js 的 EQ_PRESETS 与均衡器面板的按钮为准。
     * 以前这里是 off/pop/rock/jazz/classical/vocal/custom —— 和实现、UI 三份名单
     * 各不相同：用户选「低频(bass)」「夜间(night)」存盘时白名单不认，重启回落 off，
     * 表现为「预设重启后失效」；反过来 jazz/classical 在白名单里，但
     * EQ_PRESETS 没有对应曲线，选中只会被当成 off 静音，两套都是坏的。
     * custom 保留：它不是预设，走 eqCustom 那一支。
     */
    eq: ['off', 'pop', 'rock', 'vocal', 'bass', 'night', 'custom'],
    repeat: ['off', 'one', 'all'],
    /*
     * playMode 以 app.js 的 MODES 为准：6 档 list/one/seq/rand/heart/roam。
     * 以前白名单只有 list/shuffle/heart/roam 四档，与 MODES 相差 one/seq/rand ——
     * 选「单曲循环 / 顺序播放 / 随机播放」时落盘的值不在白名单里，重启后被
     * 静默回落 list；而派生出来的 shuffle/repeat 各自都在白名单内被保留下来，
     * 于是界面显示「列表循环」、行为却还是单曲循环/随机（播放行为由
     * player.js 的 shuffle/repeat 决定）。白名单与 UI 名单必须同步维护。
     */
    playMode: ['list', 'one', 'seq', 'rand', 'heart', 'roam'],
  };
  /*
   * 已废弃的枚举值 → 现行值（按设置项分组）。
   *
   * jazz/classical 在早期实现里被写进过 eq 白名单，选过它们的用户设置就留在
   * localStorage 里。白名单收紧后如果不迁移，这些值会直接回落 off ——
   * 等于用户设置被静默清空。这两个曲线当时也没有真实实现（EQ_PRESETS 里
   * 根本没有对应频段），最近似的其实是「关闭」，所以统一映射到 off，
   * 并在设置加载时留一行日志，让愿意查日志的人知道自己的旧值被改过。
   */
  const MIGRATE = {
    eq: { jazz: 'off', classical: 'off' },
  };

  /*
   * 设置结构版本。
   *
   * 用途：DEFAULTS 里某一项的默认值改了之后，**老用户不会自动获得新默认值** ——
   * 他们的 localStorage 里存着旧值，coerceSettings 只是把旧值原样读回来。
   * 这对「新增功能」类改动是致命的：1.3.3 把 sbFill（状态栏歌词跟随进度填充）
   * 的默认值从 false 改成 true，结果只有全新安装的用户看得到填充动画，
   * 而所有老用户升级后**依然没有** —— 用户反馈的「状态栏歌词没有播放填充动画」
   * 正是这个原因，不是代码没生效。
   *
   * 这里记一个版本号，加载时若低于当前版本就执行一次「补默认值」迁移，
   * 然后写回新版本号，保证只迁一次、且用户之后手动关掉也不会被重置。
   */
  const SCHEMA_VERSION = 5;

  function migrateSettings(out, saved, fromVersion) {
    /*
     * v1 → v2（1.3.3）：把 sbFill 补成 true。
     *
     * 只在「用户从没碰过这个开关」时迁移才有意义，但我们无法区分
     * 「没碰过」和「主动关掉了」—— 所以用保守策略：只在版本升级的这一次
     * 把它打开，之后用户关了就不会再被改回来（版本号已经记成 2 了）。
     * 优先照顾「升级后能看到新功能」，代价是极少数主动关过它的人要再关一次。
     */
    if (fromVersion < 2) {
      if (saved.sbFill === false || saved.sbFill === undefined) {
        out.sbFill = true;
      }
    }
    /*
     * v2 → v3（1.3.3 第二轮）：把状态栏填充色从旧的浅青 #7DE3D0
     * 升级成和文字有明确色差的 #b3a2ff。
     *
     * 为什么要迁移而不是只改默认值：老用户的 localStorage 里存着
     * #7DE3D0。而这个颜色和默认白色文字都属高明度，
     * 在深色状态栏上「已唱/未唱」几乎看不出区别 ——
     * 这正是用户反馈「打开跟随进度填充只是边缘发亮」的根因。
     * 只改 DEFAULTS 对他们无效（同一个坑 1.3.3 已经踩过一次了）。
     *
     * 只改「恰好等于旧默认值」的情况：用户自己调过的颜色要尊重，
     * 不能因为升级就把人家的选择冲掉。
     */
    if (fromVersion < 3) {
      const c = String(out.sbFillColor || '').toUpperCase();
      if (!c || c === '#7DE3D0') {
        out.sbFillColor = DEFAULTS.sbFillColor;
      }
    }
    /*
     * v3 → v4（1.3.3 第三轮）：把状态栏浮层的反色开关关掉。
     *
     * 这两个字段是 v3 才加的、且当时默认值写成了 true —— 那是一次严重回归：
     * 浮层盖在系统状态栏上，背景是用户壁纸（九成深色），
     * 默认反色会把白字变成纯黑、把紫色填充变成暗橄榄色，
     * 在深色壁纸上完全看不见。用户报的「状态栏歌词没有填充」就是它。
     *
     * v3 的用户（包括刚装上试的那些）localStorage 里已经存了 true，
     * 只改 DEFAULTS 对他们无效 —— 所以必须有这条迁移。（同一个坑已踩过三次了。）
     *
     * 只改「确实是 v3 遗留下来的 true」；v4 起用户可以自己再打开。
     */
    if (fromVersion < 4) {
      out.sbInvert = false;
      out.sbFillInvert = false;
      /*
       * 还有一个连带污染：反色开着的时候，用户可能在设置面板里
       * 「看到」了黑色/暗橄榄色，然后**把它当成自己的选择存了下来**。
       * 这时 sbColor 已经是 #000000，光把开关关掉还是黑的。
       * 所以只在「颜色恰好是从白/紫反色而来的那两个值」时还原，
       * 用户真正手选的其他颜色不动。
       */
      const sc = String(out.sbColor || '').toUpperCase();
      const sf = String(out.sbFillColor || '').toUpperCase();
      if (!sc || sc === '#000000') {
        // #000000 只可能是 #FFFFFF 被反色后的结果（深色壁纸上没人会主动选纯黑文字）
        out.sbColor = DEFAULTS.sbColor;
      }
      /*
       * 填充色要还原两种值：
       *   #4C5D00 —— #b3a2ff 被反色后的结果（v3 迁移已知）
       *   #000000 —— 见 v4 → v5 迁移（那条专门处理，因为 v4 用户不会再跑到这里）
       */
      if (sf === '#4C5D00' || sf === '#000000') {
        out.sbFillColor = DEFAULTS.sbFillColor;
      }
    }
    /*
     * v4 → v5（1.3.3 第四轮）：把被存成纯黑的**填充色**还原。
     *
     * 为什么必须单独加一条，不能并进上面的 v3→v4：
     *   用户装上一版（schema=4）时已经跑过 v3→v4 了，存档里现在是 4。
     *   只要不动 SCHEMA_VERSION，`fromVersion < 4` 永远为 false ——
     *   **改迁移逻辑对老用户完全无效**。这个坑在 1.3.3 里已经是第四次了
     *   （改 DEFAULTS / 改迁移 / 改 coerce 各有一次栽在这上面）。
     *
     * 病因（2026-11-24 真机日志）：
     *   `timing diag: … color=#FFFBFB fillColor=#000000`
     *   文字是白的、填充是纯黑 —— 在深色壁纸上「已唱」和「未唱」
     *   亮度完全一样，用户看到的还是「没有填充」。
     *
     * 纯黑的来源有两个，都发生在上一版：
     *   ① 反色开关开着时 sbFillColor 被算成 #4C5D00，用户对着那个面板
     *      在取色器里确认了一次，落盘成反色后的值；
     *   ② HSV 取色器的明度滑块误触到最上边缘（V=0），直接存下 #000000。
     *
     * 只认「恰好是纯黑」这一种：正常人给状态栏填充调色不会主动选纯黑
     *（那等于让填充完全不可见），所以可以放心还原。
     * 用户真正手选的其他颜色一律不动。
     */
    if (fromVersion < 5) {
      const sf5 = String(out.sbFillColor || '').toUpperCase();
      if (sf5 === '#000000' || !sf5) {
        out.sbFillColor = DEFAULTS.sbFillColor;
      }
    }
    return out;
  }

  /**
   * @param {object} saved 存档里的 settings 对象
   * @param {object} [root] 整个存档（用来读 schema 这类**不属于 settings** 的元数据）
   *
   * 为什么要把 root 单独传进来：schema 写在存档最外层（{schema, settings, ...}），
   * 而这里拿到的是 saved.settings —— 第一版写成 `saved.schema`，
   * 永远读到 undefined，于是 fromVersion 恒为 1，迁移**每次启动都跑一遍**，
   * 用户手动关掉的 sbFill 一重启又被打开。这个 bug 被 store-migrate.test.js 抓到。
   */
  function coerceSettings(saved, root) {
    const out = Object.assign({}, DEFAULTS);
    if (!saved || typeof saved !== 'object') return out;
    Object.keys(DEFAULTS).forEach((k) => {
      const def = DEFAULTS[k];
      const v = saved[k];
      if (v === undefined) return;
      /* 布尔项：只接受真正的布尔，其余按"宁可关掉"处理
         （开着一个用户不认识的开关，比关掉更难排查） */
      if (typeof def === 'boolean') { if (typeof v === 'boolean') out[k] = v; return; }
      /* 数组项（eqCustom / lastQueue）：必须是数组，否则回落默认 */
      if (Array.isArray(def)) {
        if (Array.isArray(v)) {
          if (def.length && k === 'eqCustom') {
            /*
             * eqCustom 必须补齐到 5 段：老版本/手工改过的数据可能只有 2~3 个元素，
             * 而 player.js 的 setEQBands 是按 5 个滤波器索引取值的，越界就是
             * undefined → 那几段静默按 0dB 下发。界面上的自定义曲线是「补齐后」
             * 的样子，实际下发却不是 —— 用户调了没反应，还找不到原因。
             * 只截长不补短就是漏了这一半。
             */
            const out5 = v.slice(0, def.length).map((n) => (Number.isFinite(Number(n)) ? Number(n) : 0));
            while (out5.length < def.length) out5.push(0);
            out[k] = out5;
          } else {
            out[k] = v.filter((x) => typeof x === 'string');
          }
          return;
        }
        return;
      }
      if (ENUMS[k]) {
        if (ENUMS[k].indexOf(v) >= 0) { out[k] = v; return; }
        /* 已废弃的旧值先翻译一次（jazz/classical → off），翻译后的值也要在白名单里 */
        const legacy = MIGRATE[k];
        const migrated = legacy && legacy[v];
        if (migrated && ENUMS[k].indexOf(migrated) >= 0) {
          out[k] = migrated;
          try {
            if (g.Log) g.Log.info('STORE', '设置 ' + k + ' 的旧值 ' + v + ' 已迁移为 ' + migrated);
          } catch (e) {}
        }
        return;
      }
      /* 字符串项（apiBase / lastTrackId / sbColor 等） */
      if (typeof def === 'string') { if (typeof v === 'string') out[k] = v; return; }
      /* 数值项 */
      if (typeof def === 'number') {
        /*
         * 注意 typeof null === 'object'，但 Number(null) === 0 —— 会被当成
         * 合法的 0 而把「玻璃强度」静默关掉。null/undefined/空串都按无效处理。
         */
        if (v === null || v === undefined || v === '') return;
        const n = Number(v);
        if (!Number.isFinite(n)) return;
        const r = NUM_RANGE[k];
        out[k] = r ? Math.max(r[0], Math.min(r[1], n)) : n;
      }
    });
    const fromVersion = Number(root && root.schema) || 1;
    return migrateSettings(out, saved, fromVersion);
  }

  const Store = {
    state: null,
    localTracks: [],
    _db: null,

    /* ---------- 持久化 ---------- */
    load() {
      let saved = {};
      try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { saved = {}; }
      // 进度小对象独立读取；老版本没有这个键就退回整份 state 里的值
      let prog = null;
      try { prog = JSON.parse(localStorage.getItem(KEY_PROGRESS) || 'null'); } catch (e) { prog = null; }
      /*
       * localStorage 可能被写坏（手工改、版本升级、配额写一半）。
       * 以前这里直接用 saved.history，一旦它变成非数组，
       * 后面 h.slice() / for...of 就会抛错 → boot 整个失败、界面白屏。
       * 这里逐项兜底成数组。
       */
      const arr = (v) => (Array.isArray(v) ? v : []);
      this.state = {
        settings: coerceSettings(saved.settings, saved),
        liked: arr(saved.liked).filter((x) => typeof x === 'string'),
        history: arr(saved.history).filter((x) => x && x.id),
        playedSec: Number(saved.playedSec) > 0 ? Number(saved.playedSec) : 0,
        imports: arr(saved.imports),
        onlineCache: arr(saved.onlineCache).filter((x) => x && x.id),
      };
      // 进度小键优先（它比整份 state 更新），字段仍然挂在 settings 上，其他代码不用改
      if (prog && typeof prog === 'object') {
        if (typeof prog.lastTrackId === 'string') this.state.settings.lastTrackId = prog.lastTrackId;
        if (Number(prog.lastPosition) >= 0) this.state.settings.lastPosition = Number(prog.lastPosition);
        if (Array.isArray(prog.lastQueue)) this.state.settings.lastQueue = prog.lastQueue.filter((x) => typeof x === 'string');
        if (Number(prog.queueIndex) >= 0) this.state.settings.queueIndex = Number(prog.queueIndex);
      }
      return this.state;
    },
    /**
     * 落盘。
     *
     * 审查 E-16：以前 catch 是**空的** —— QuotaExceededError 被静默吞掉，
     * 无日志、无提示、无重试，于是「内存里改了、磁盘没改」可以持续整个会话：
     * 用户只看到「设了又变回去」，而开发者从日志里找不到任何痕迹。
     * 这是「重启丢设置」这一类最难排查的问题。
     *
     * 现在：首次失败时记一条日志 + 弹一次 toast（用 _saveFailed 防刷屏，
     * 免得拖滑块时每秒几十条），并主动瘦身后重试一次 ——
     * history 200→100、onlineCache 60→30 通常就够腾出空间。
     */
    save() {
      const s = this.state;
      const payload = () => JSON.stringify({
        /*
         * schema 必须写进去：它是「DEFAULTS 改过默认值」这类迁移只跑一次的凭据。
         * 不写的话每次启动都 fromVersion=1 → 每次都把 sbFill 强制改回 true，
         * 用户手动关掉状态栏歌词填充后一重启又自己开了，而且永远关不掉。
         */
        schema: SCHEMA_VERSION,
        settings: s.settings, liked: s.liked, history: s.history.slice(0, 200),
        playedSec: s.playedSec, imports: s.imports, onlineCache: (s.onlineCache || []).slice(0, 60),
      });
      try {
        localStorage.setItem(KEY, payload());
        this._saveFailed = false;          /* 成功一次就复位，允许下次再报 */
        return true;
      } catch (e) {
        /* 第一次失败：先瘦身重试，多数情况这样就能救回来 */
        try {
          const slim = JSON.stringify({
            schema: SCHEMA_VERSION,
            settings: s.settings, liked: s.liked, history: s.history.slice(0, 100),
            playedSec: s.playedSec, imports: s.imports, onlineCache: (s.onlineCache || []).slice(0, 30),
          });
          localStorage.setItem(KEY, slim);
          if (!this._saveWarnedSlim) {
            this._saveWarnedSlim = true;
            try { g.Log && g.Log.add('STORE', '存储接近上限，已裁剪 history/onlineCache 后写入'); } catch (e2) {}
          }
          this._saveFailed = false;
          return true;
        } catch (e2) {
          if (!this._saveFailed) {
            this._saveFailed = true;
            try { g.Log && g.Log.err('STORE', e2, '设置写入失败（本机存储已满）'); } catch (e3) {}
            try {
              const A = g.RippleApp;
              if (A && typeof A.toast === 'function') {
                A.toast('设置无法保存', '本机存储已满，请在「我的」里清理已导入的音乐', 'warn');
              }
            } catch (e3) {}
          }
          return false;
        }
      }
    },
    /**
     * L-16：只写进度相关的 4 个字段（几十字节），不碰 history / onlineCache。
     * 每 12 秒调用一次，开销可以忽略。
     */
    saveProgress(prog) {
      try {
        localStorage.setItem(KEY_PROGRESS, JSON.stringify({
          lastTrackId: prog.lastTrackId || '',
          lastPosition: Number(prog.lastPosition) || 0,
          lastQueue: Array.isArray(prog.lastQueue) ? prog.lastQueue.slice(0, 200) : [],
          queueIndex: Number(prog.queueIndex) || 0,
        }));
        this._progFailed = false;
      } catch (e) {
        /*
         * E-16 同源问题：进度写盘以前也是空 catch。
         * 进度写不进去的直接后果是「重启后从 0 开始」，而日志里毫无痕迹。
         * 这里只记一次日志（不弹 toast —— 进度丢失不像设置丢失那样需要立刻打扰）。
         */
        if (!this._progFailed) {
          this._progFailed = true;
          try { g.Log && g.Log.err('STORE', e, '播放进度写入失败'); } catch (e2) {}
        }
      }
    },
    /**
     * 改一个设置项。
     *
     * 审查 3.2：以前每次调用都立刻 save() —— 而 save() 会把
     * settings + liked + history(200) + playedSec + imports + onlineCache(60)
     * **全量序列化**写 localStorage。设置面板里拖滑块是每帧触发一次 input 事件，
     * 于是拖动一次滑块 = 几百次全量写盘，主线程被 JSON.stringify 拖住，
     * 观感就是「拖起来发涩」。
     *
     * 现在合并到下一帧之后再写：同一帧内的多次 set 只落盘一次。
     * 用 requestAnimationFrame 是因为它天然与渲染帧对齐。
     *
     * ⚠️ 但 rAF 在**页面不可见时会被浏览器暂停**，于是"设完就锁屏"
     * 这段写入会永远等不到回调 —— 最典型的就是睡眠定时：
     * 用户设 60 分钟 → 立刻按 Home → sleepUntil 没写进去 → 重启后
     * 定时器不存在，而界面还显示"60 分钟后暂停"。
     * 所以页面隐藏时退回 setTimeout（后台定时器仍会被节流到 ~1s，
     * 但至少一定会执行）。
     *
     * 需要「立刻落盘」的场景（比如切歌前）显式调 Store.save() 即可。
     */
    set(key, val) {
      this.state.settings[key] = val;
      if (this._saveRaf) return;
      const run = () => { this._saveRaf = 0; this.save(); };
      const hidden = typeof document !== 'undefined'
        && (document.hidden || document.visibilityState === 'hidden');
      this._saveRaf = (!hidden && typeof requestAnimationFrame === 'function')
        ? requestAnimationFrame(run)
        : setTimeout(run, 0);
    },

    /* ---------- IndexedDB ---------- */
    async db() {
      if (this._db) return this._db;
      /*
       * 并发首次调用会各自 indexedDB.open 一次，第二个连接打开后
       * 既不被使用也不关闭 —— 而 versionchange 时它还会挡住升级。
       * 这里缓存「打开中的 Promise」，让并发方共享同一次 open。
       */
      if (this._dbPromise) return this._dbPromise;
      // file:// 下（Android 外壳）部分内核禁用 IndexedDB，这里快速失败，
      // 让导入走「仅本次会话可用」的降级路径，而不是整段抛错。
      if (typeof indexedDB === 'undefined' || !indexedDB) throw new Error('IndexedDB 不可用');
      this._dbPromise = new Promise((res, rej) => {
        let r;
        try { r = indexedDB.open(DB_NAME, 1); }
        catch (e) { rej(e); return; }
        r.onupgradeneeded = () => {
          const db = r.result;
          if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE, { keyPath: 'id' });
        };
        r.onsuccess = () => {
          const db = r.result;
          /*
           * 别的标签页/窗口要升级这个库时会先发 versionchange，
           * 不关掉自己的连接就会把对方永久卡在 blocked 上。
           */
          db.onversionchange = () => { try { db.close(); } catch (e) {} this._db = null; this._dbPromise = null; };
          res(db);
        };
        r.onerror = () => {
          this._dbPromise = null;
          rej(r.error);
        };
        /*
         * 没有 onblocked：升级被别的连接挡住时 open 的成功/失败回调都不会来，
         * Promise 永远 pending → boot 卡在 await restoreLocal()，首页起不来。
         */
        r.onblocked = () => {
          this._dbPromise = null;
          rej(new Error('IndexedDB 被其它页面占用，无法打开'));
        };
      }).then((db) => { this._db = db; return db; });
      return this._dbPromise;
    },
    async dbPut(rec) {
      const db = await this.db();
      return new Promise((res, rej) => {
        const tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).put(rec);
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
        /*
         * B-7：配额满时事务走的是 abort 而不是 error，onerror 不触发，
         * Promise 永远 pending —— 导入界面就卡在「正在导入…」，只能杀进程。
         */
        tx.onabort = () => rej(tx.error || new Error('IndexedDB 事务被中止（可能是存储配额已满）'));
      });
    },
    async dbAll() {
      const db = await this.db();
      return new Promise((res, rej) => {
        const tx = db.transaction(DB_STORE, 'readonly');
        const q = tx.objectStore(DB_STORE).getAll();
        q.onsuccess = () => res(q.result || []);
        q.onerror = () => rej(q.error);
        /* 与 dbPut 一致：配额/中止走 abort，onerror 不触发。
           漏了它 boot 会卡在 await restoreLocal()，首页永远起不来。 */
        tx.onabort = () => rej(tx.error || new Error('IndexedDB 读取被中止'));
      });
    },
    async dbClear() {
      const db = await this.db();
      return new Promise((res, rej) => {
        const tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).clear();
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
        /* 同上：漏了 onabort 时「清空已导入的音乐」按下去毫无反应也没有提示 */
        tx.onabort = () => rej(tx.error || new Error('IndexedDB 清空被中止'));
      });
    },
    /**
     * 按主键删一条记录（restoreLocal 自清理坏条用）。
     * 以前坏记录只能跳过：记录一直留在 IDB 里，于是每次冷启动都要重新解析、
     * 重新告警一次，永远没有尽头；而用户侧也没有「只删坏条」的入口，
     * 唯一能清掉它们的办法是把整个曲库清空。
     */
    async dbDelete(id) {
      if (!id) return;
      const db = await this.db();
      return new Promise((res, rej) => {
        const tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).delete(id);
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
        tx.onabort = () => rej(tx.error || new Error('IndexedDB 删除被中止'));
      });
    },

    /* ---------- 曲库 ---------- */
    /**
     * 完整曲库 = 本机导入 + 播放过的在线曲目。
     *
     * 早年这里还拼过一份内置的演示曲目（DEMO），示例曲库移除后它变成恒空数组，
     * 只在 concat 时白跑一趟，现在一并删掉。
     * 曾经的问题（保留记录，避免再犯）：这里只返回本地导入、在线曲目只存在
     * onlineCache 里 → 曲库页的「在线」筛选永远 0 首、没有本地文件时曲库永远是空的、
     * 播放页在空曲库下打开毫无反应、队列 sheet 也是空列表。
     * 现在把在线缓存一起并进来（它们都排在本地之后，不抢本地文件的位置）。
     */
    all() {
      const local = this.localTracks;
      const seen = new Set(local.map((t) => t.id));
      const online = this.cached().filter((t) => !seen.has(t.id));
      return local.concat(online);
    },
    /** 曾经播放过的在线曲目（无直链，播放时重新解析） */
    cached() {
      // 老版本存下的缓存没有 source 字段，这里补齐，避免恢复时判不出是在线曲目
      return (this.state.onlineCache || []).map((t) => (
        t.source === 'online' ? t : Object.assign({}, t, { source: 'online' })
      ));
    },
    byId(id) {
      return this.all().find((t) => t.id === id);
    },
    async restoreLocal() {
      /*
       * 每次冷启动都会为每个本地曲目 createObjectURL 一批 blob URL，
       * 但从不回收 —— 反复冷启动会持续泄漏。
       * 重建之前先把上一批（同一会话内重入时）回收掉。
       */
      try {
        (this.localTracks || []).forEach((t) => {
          if (t && t.src && /^blob:/.test(t.src)) URL.revokeObjectURL(t.src);
        });
      } catch (e) {}
      /*
       * ⚠️ 这里以前是一个整体 try/catch，catch 里直接 this.localTracks = []。
       *
       * 后果比"少几首歌"严重得多：「从链接添加」会往同一个 ObjectStore
       * 写一条**没有 blob** 的记录（音频在远端，src 是 URL），下次启动
       * recs.map(...) 对那条记录执行 URL.createObjectURL(undefined) 抛
       * TypeError → 被外层吞掉 → localTracks 清空 →
       * **用户所有本机导入的歌在界面上一起消失**。
       * IDB 里的数据其实还在，但没有任何 UI 路径能把它们救回来。
       *
       * 现在：逐条 try/catch，坏记录跳过并记日志，其余正常恢复。
       * 链接导入的记录（有 remoteUrl 或没有 blob）走另一条路单独重建。
       *
       * 坏记录还要**顺手删掉**：只跳过的话它会一直躺在 IDB 里，
       * 每次冷启动都重新解析、重新告警一次，日志被同一句刷满，
       * 而用户没有「只删坏条」的入口，只能整库清空。
       */
      try {
        const recs = await this.dbAll();
        const out = [];
        const badIds = [];
        for (const r of recs) {
          if (!r || !r.id) { continue; }        // 连主键都没有，无法定位，只能跳过
          /* 链接导入的曲目：没有 blob，src 是远端地址。
             注意 source 必须保持 'local' —— 它确实是用户自己加进曲库的本地曲目，
             只是音频在远端。以前这里写成 'online'，连锁出三个问题：
               ① 「下载」视图要求 source==='local' && _blob，两种条件都不满足，
                  链接导入的歌重启后从下载视图里消失；
               ② player.js 的 _pickEl 据此走 elA（在线流元素），而首播走的是
                  elC（跨域直链专用，不带 crossOrigin）—— 同一首歌的播放元素路由
                  自相矛盾，第三方直链不返 CORS 头时 elA 会静音或判失败；
               ③ 它出现在「在线」筛选里，但语义是「我的链接」。
             */
          if (!r.blob) {
            if (r.remoteUrl && r.src) {
              out.push({
                id: r.id, source: 'local', title: r.title || '', artist: r.artist || '',
                album: r.album || '', duration: r.duration || 0,
                cover: r.cover || '', src: r.src, format: r.format || 'ONLINE',
                sampleRate: '', size: r.size || 0, addedAt: r.addedAt || 0,
                remoteUrl: true,
              });
            } else {
              badIds.push(r.id);
            }
            continue;
          }
          try {
            out.push({
              id: r.id, source: 'local', title: r.title, artist: r.artist, album: r.album,
              duration: r.duration || 0, cover: '', src: URL.createObjectURL(r.blob),
              format: (r.type || '').split('/')[1]?.toUpperCase() || 'AUDIO',
              sampleRate: '', size: r.size, addedAt: r.addedAt, _blob: r.blob,
            });
          } catch (e) {
            /* 单条坏掉不影响其它条 */
            badIds.push(r.id);
            try { if (window.Log) Log.err('STORE', e, 'restoreLocal 单条记录失败: ' + r.id); } catch (_) {}
          }
        }
        this.localTracks = out;
        if (badIds.length) {
          try {
            if (window.Log) {
              Log.info('STORE', badIds.length + ' 条本机曲库记录已损坏（缺少音频数据），已从曲库移除');
            }
          } catch (_) {}
          /*
           * 逐条删，且每条都吞掉自己的失败：清理是「顺手做的事」，
           * 删不掉（配额/事务被中止）也不能影响这一轮曲库恢复的结果 ——
           * 下一次启动还会再试一遍。
           */
          await Promise.all(badIds.map((id) => this.dbDelete(id).catch(() => {})));
        }
      } catch (e) {
        /* 读库本身失败（IDB 不可用/被占用）：这才是真的没有本地曲库 */
        this.localTracks = [];
        try { if (window.Log) Log.err('STORE', e, 'restoreLocal 读取失败'); } catch (_) {}
      }
      return this.localTracks;
    },
    async addFiles(files) {
      const added = [];
      /*
       * 候选先筛出来，再并发探测时长。
       * 之前是 for + await 串行：每个无法解析元数据的文件都要等满
       * _probe() 的超时（现在是 1.5 秒，上一版是 4 秒），
       * 导入 20 个不认识的格式就要等半分钟到一分多钟，
       * 期间界面只有一句「正在导入…」。
       */
      const cands = [];
      for (const f of files) {
        if (!/^audio\//.test(f.type) && !/\.(mp3|flac|m4a|wav|ogg|aac|opus)$/i.test(f.name)) continue;
        const id = 'loc_' + f.name + '_' + f.size + '_' + (f.lastModified || 0);
        if (this.localTracks.some((t) => t.id === id)) continue;
        const base = f.name.replace(/\.[^.]+$/, '');
        const dash = base.split(' - ');
        cands.push({
          f, id, base,
          title: dash.length > 1 ? dash[1].trim() : base,
          artist: dash.length > 1 ? dash[0].trim() : '本地文件',
        });
      }
      const durs = await Promise.all(cands.map((c) => this._probe(c.f)));
      for (let k = 0; k < cands.length; k++) {
        const c = cands[k];
        const f = c.f, id = c.id, dur = durs[k];
        const rec = {
          id, title: c.title, artist: c.artist, album: '本地导入', duration: dur, size: f.size,
          type: f.type, blob: f, addedAt: Date.now(),
        };
        try { await this.dbPut(rec); }
        catch (e) { this._volatile = true; }
        const track = {
          id, source: 'local', title: c.title, artist: c.artist, album: '本地导入', duration: dur,
          cover: '', src: URL.createObjectURL(f),
          format: (f.type.split('/')[1] || 'audio').toUpperCase(), sampleRate: '',
          size: f.size, addedAt: rec.addedAt, _blob: f,
        };
        this.localTracks.unshift(track);
        if (!this.state.imports.includes(id)) this.state.imports.push(id);
        added.push(track);
      }
      this.save();
      return added;
    },
    _probe(file) {
      return new Promise((res) => {
        const a = new Audio();
        const u = URL.createObjectURL(file);
        let done = false;
        const finish = (v) => { if (!done) { done = true; URL.revokeObjectURL(u); res(v); } };
        a.preload = 'metadata';
        a.onloadedmetadata = () => finish(isFinite(a.duration) ? Math.round(a.duration) : 0);
        a.onerror = () => finish(0);
        setTimeout(() => finish(0), 1500);
        a.src = u;
      });
    },
    /**
     * 清空本机曲库。
     *
     * ⚠️ 以前这里对所有本地曲目无条件 revokeObjectURL —— 包括**正在播放的那一首**。
     * 在播本地歌时点清空 → 当前音源立刻失效 → 触发 sourcefail → 自动跳歌，
     * 用户被连打断两次（歌断了，还被跳到别的曲目），而确认框文案
     * （「会删除本机保存的音频文件」）完全没提这件事。
     *
     * 现在留一个口子给「正在播的那一条」：不 revoke 它的 blob，
     * 这样正在听的歌不会被掐断；但曲库与 imports 照常清空（清空语义不变）。
     * 判断放在 store 这一层是为了让修复立刻生效 —— 如果要求调用方先做判断，
     * 所有入口（设置页、以后新增的入口）都得各自记住这一步，漏一个就复发。
     * 这里只「读」播放器的当前曲目，不反向驱动它（暂停/切歌的决定权仍在 app.js）。
     *
     * @returns {Promise<{revoked:string[], kept:string[]}>}
     *   revoked：本次被 revoke 掉的曲目 id；kept：为在播曲目保留下来、未 revoke 的 id。
     *   调用方可以据此提示「正在播放的歌已从曲库移除，播放结束后再回收音源」，
     *   或在切歌之后自行 revoke 那一条。
     */
    async clearLocal() {
      /* 找出「正在播放、且音源确实是本次要 revoke 的 blob」的那一条 */
      const cur = (g.Player && g.Player.track) || null;
      const playingSrc = cur && cur.source === 'local'
        && typeof cur.src === 'string' && /^blob:/i.test(cur.src) ? cur.src : '';
      await this.dbClear();
      /* 每个本地曲目的 src 都是 URL.createObjectURL(blob)，
         不 revoke 的话 blob 会一直挂在内存里（导入多张大专辑后很明显）。 */
      const revoked = [];
      const kept = [];
      this.localTracks.forEach((t) => {
        if (!t) return;
        if (playingSrc && t.src === playingSrc) { kept.push(t.id); return; }
        try {
          if (t.src && /^blob:/.test(t.src)) { URL.revokeObjectURL(t.src); revoked.push(t.id); }
        } catch (e) {}
      });
      this.localTracks = [];
      this.state.imports = [];
      this.save();
      return { revoked, kept };
    },

    /* ---------- 喜欢 / 记录 ---------- */
    isLiked(id) { return this.state.liked.includes(id); },
    toggleLike(id) {
      const a = this.state.liked;
      const i = a.indexOf(id);
      if (i >= 0) a.splice(i, 1); else a.push(id);
      this.save();
      return i < 0;
    },
    pushHistory(track) {
      const h = this.state.history;
      const last = h[0];
      if (!last || last.id !== track.id || Date.now() - last.at > 60000) {
        h.unshift({ id: track.id, title: track.title, artist: track.artist, at: Date.now() });
        if (h.length > 200) h.length = 200;
      }
    },
    addPlayed(sec) {
      this.state.playedSec += sec;
    },
    recent(n = 6) {
      const seen = new Set();
      const out = [];
      for (const h of this.state.history) {
        if (seen.has(h.id)) continue;
        seen.add(h.id);
        const t = this.byId(h.id);
        if (t) out.push(t);
        if (out.length >= n) break;
      }
      return out;
    },
  };

  g.Store = Store;
  /*
   * 这里原本还导出过 g.DEMO（内置示例曲库）。示例曲库早已移除，
   * DEMO 恒为空数组、全仓没有任何消费方，留着只会让人以为「里面还有演示歌」。
   */
  g.DEFAULTS = DEFAULTS;
})(window);
