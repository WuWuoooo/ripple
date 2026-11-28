/**
 * Ripple 桌面端 · 原生桥适配层
 *
 * 这 60 行是「前端零改动」的全部代价。
 *
 * app/ 那 13000 行前端是为 Android WebView 写的，它通过
 * `window.RippleNative` 这个 `@JavascriptInterface` 对象调用原生能力。
 * 桌面端没有这个对象，前端会走浏览器降级路径（在线功能直接不可用）。
 *
 * 所以我们在这里把它**照原样造出来**，内部转发给 Tauri 的 Rust 命令。
 * 前端完全感知不到差别 —— 它以为自己在跟 Java 说话。
 *
 * 必须在 app.js 之前执行，所以放在 index.html 的脚本列表最前面
 * （由构建脚本注入，源码 app/index.html 一行不改）。
 */
(function (g) {
  'use strict';

  // Tauri 2 的 IPC 挂在 window.__TAURI__ 上；未注入时说明跑在普通浏览器里，
  // 此时不要伪造 RippleNative —— 让前端正常走 proxy（server.js）路径。
  const TAURI = g.__TAURI__;
  if (!TAURI || !TAURI.core || typeof TAURI.core.invoke !== 'function') return;

  const invoke = TAURI.core.invoke;
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /*
   * 前端 → Rust 的调用约定保持与 Android 完全一致的「异步回调」形状：
   *   netease(cmd, paramsJson, cbId) 立刻返回，结果稍后走 __rippleNativeResult(cbId, text)
   *
   * 为什么不直接返回 Promise 给前端：前端的 nativeCall() 是按 Android 那套
   * pending 表 + 超时实现的，它不认识 Promise。改成 Promise 要动 netease.js，
   * 而「前端零改动」是这个移植方案的核心约束。
   */
  const pending = new Map();

  /* ================= 原生日志的 JS 侧缓冲 =================
   *
   * LOG_BUF 只保留**本次会话**（最多 400 行，与 app/js/log.js 的 MAX 一致）。
   * 它是 logDump() 的返回值，用来在不碰文件系统的情况下让前端拿到
   * 「刚才发生了什么」；完整历史在 Rust 写的 Ripple-log.txt 里。
   *
   * logFilePath 是启动时异步取回、之后缓存的路径：logPath() 必须同步返回
   * （前端直接把返回值当结果用），所以不能现 invoke。
   */
  const LOG_BUF = [];
  const LOG_MAX = 400;
  let logFilePath = '(日志路径尚未就绪)';

  function pushLog(line) {
    LOG_BUF.push(line);
    while (LOG_BUF.length > LOG_MAX) LOG_BUF.shift();
  }

  /* 启动时取一次日志路径。失败不抛 —— logPath 会返回占位串。 */
  try {
    invoke('log_path').then(function (p) {
      if (p && typeof p === 'string') logFilePath = p;
    }).catch(function () {});
  } catch (e) {}

  const bridge = {
    /**
     * 网易云命令通道（与 Java 的 HttpBridge.netease 同签名）
     * @param {string} cmd 命令名（status / search / song_url / ...）
     * @param {string} paramsJson 参数的 JSON 字符串
     * @param {string} cbId 回调 id，前端用它在自己的 pending 表里找 Promise
     */
    netease: function (cmd, paramsJson, cbId) {
      const id = String(cbId == null ? '' : cbId);
      pending.set(id, true);
      invoke('netease', { cmd: String(cmd), params: String(paramsJson || '{}'), cbId: id })
        .then(function () {
          /*
           * 成功路径也必须从在飞表里删掉。
           *
           * Rust 侧确实会自己调 __rippleNativeResult 把结果送回前端，
           * 所以这一行以前被当成「什么都不用做」。但 pending 表的作用是
           * 「记录还没回结果的调用」，成功之后它就不再是在飞状态了 ——
           * 不删的话这张 Map 只增不减（前端的 cbId 是严格递增的），
           * 桌面端长开一天按 1 次/秒就能堆到 8 万多条，且没有任何消费方。
           *
           * 审查 D-01 实测：10 万次成功调用后 pending.size = 100000。
           */
          pending.delete(id);
        })
        .catch(function (e) {
          // 通道本身出错（命令名拼错、Rust panic）：也要回一条，否则前端只能干等超时
          pending.delete(id);
          try {
            g.__rippleNativeResult(id, JSON.stringify({ code: -1, message: '桌面端调用失败：' + (e && e.message ? e.message : e) }));
          } catch (e2) {}
        });
    },

    /** 系统通知：桌面端暂不支持，返回 false 让前端走降级路径 */
    notify: function () { return false; },

    /*
     * ===== 这里**故意没有** mediaState =====
     *
     * 以前这里有一个 `mediaState: function () { return false; }` 的占位实现，
     * 看似「无害」，实际是个骗局：
     *
     *   · app/js/app.js 用 `typeof N.mediaState === 'function'` 判断
     *     「有没有原生媒体通知能力」，占位实现让这个判定恒为 true；
     *   · 于是设置页显示「通知栏 / 锁屏 / 耳机键可控」——
     *     而桌面端根本没有 PlaybackService + MediaSession 这套东西，
     *     用户去按耳机键、看锁屏，一个都不会动；
     *   · 更糟的是它把真正的调用点也骗进去了：pushMediaState() 开头就是
     *     这个 typeof 判定，通过之后会一路调到 N.mediaState(6 个参数)，
     *     而占位实现是 0 参 —— 形状对不上，将来补真实现时会被这层假皮掩盖。
     *
     * 这与本文件末尾那段注释的告诫是同一句话：
     * 「多造一个假实现反而会让 UI 显示支持但点下去没反应 —— 比不支持更糟」。
     * 所以直接不提供：typeof 判定自然为 false，前端走它自己的降级文案，
     * 桌面端也不再虚假承诺。
     */

    /* ================= 原生日志（桌面端排障的唯一取证手段） =================
     *
     * 为什么必须补：app/js/log.js 里所有原生调用都是 typeof 判空的，
     * 桌面端以前五个方法一个都没有 → 全部走内存兜底 → 日志只活在页面里，
     * **关掉窗口就没了**，用户报障时说「卡了一下」「刚才报错了」，
     * 我们手上什么都没有。Android 那边有 LogBridge 写文件，桌面端不该是个黑洞。
     *
     * 实现分工（重要）：
     *   · 落盘由 Rust 侧负责（invoke('log_write') 追加到 app_log_dir 下的
     *     Ripple-log.txt）—— 这样窗口崩了、被强杀了，文件还在。
     *   · logPath() / logDump() 必须是**同步返回**的（log.js 直接把返回值
     *     当结果用，不是 await），所以这两个不能 invoke。这里的做法是：
     *     logPath 返回启动时向 Rust 取回并缓存下来的路径；
     *     logDump 返回本会话累积在 JS 里的文本。
     *     换句话说：文件里是全量历史，logDump 是「本次会话」——
     *     这个差别在 README 的「日志」一节里写明了，不假装两者等价。
     */
    log: function (tag, msg) {
      const line = String(tag == null ? '' : tag) + ': ' + String(msg == null ? '' : msg);
      pushLog(line);
      invoke('log_write', { line: line }).catch(function () {});
    },
    logFlush: function () {
      /* Rust 侧每行都是 append + 立即落盘，没有用户态缓冲要刷。
         保留这个方法是为了满足前端的形状（它会 typeof 判空后调用），
         返回 true 表示「确实没有待刷内容」，而不是假装刷了。 */
      invoke('log_flush').catch(function () {});
      return true;
    },
    logPath: function () { return logFilePath; },
    logDump: function () { return LOG_BUF.join('\n'); },
    jsError: function (msg, stack) {
      const line = 'JS-ERROR: ' + String(msg == null ? '' : msg)
        + (stack ? '\n' + String(stack) : '');
      pushLog(line);
      invoke('log_write', { line: line }).catch(function () {});
    },

    /**
     * 系统是否处于深色外观（1.3.5 · 桌面端「跟随系统」主题）。
     *
     * 前端 app.js 用 N.systemDark() 读系统开关，拿不到就退回 CSS 媒体查询——
     * 而 Tauri 的 WebView 里 prefers-color-scheme **不跟系统设置走**
     * （Linux 上取决于 GTK 主题、Windows 上取决于 WebView2 的默认值），
     * 所以桌面端以前选「跟随系统」实际永远是浅色。
     *
     * 这里直接问 WebView 的媒体查询：Tauri 2 的 WebView 会把它桥接到
     * 系统外观（Windows WebView2 与 Linux WebKitGTK 都支持），
     * 比在 Rust 侧读注册表 / gsettings 更少平台分支，也没有新依赖。
     */
    systemDark: function () {
      try {
        return !!(g.matchMedia && g.matchMedia('(prefers-color-scheme: dark)').matches);
      } catch (e) {
        return false;
      }
    },

    /* ================= 歌词窗（状态栏歌词的桌面端对等物） =================
     *
     * Android 那边是盖在系统状态栏上的悬浮窗；桌面端没有系统状态栏，
     * 用一个独立的无边框置顶小窗口承担同一职责（见 src-tauri/src/main.rs
     * 的「歌词窗」注释块与 desktop/lyric.html）。
     *
     * 六个方法与 Java 侧**同名同签名**，前端 app.js 里那套调用一行都不用改 ——
     * 它仍然以为自己在跟 Android 说话。
     *
     * 与 Java 的唯一语义差别在这里说明白：
     *   · Java 的 canDrawOverlay 要问系统有没有「显示在其他应用上层」权限；
     *     桌面端没有这个概念，创建窗口不需要任何授权，所以恒 true。
     *   · 但「恒 true」不代表一定成功：没有合成器 / 没有 DISPLAY 的环境里
     *     窗口创建会失败，那时 showLyricOverlay 返回 false，
     *     前端看到 sbNative() 为真、却显示不出来 —— 这是真实的降级路径，
     *     不是 bug。日志里会有一条 LYRIC 记录说明原因。
     */

    /** 桌面端创建置顶窗口无需系统授权 */
    canDrawOverlay: function () { return true; },
    /** 同上：没有「去授权」这一步，直接返回 true 让前端继续 */
    requestOverlayPermission: function () { return true; },

    /**
     * 显示 / 更新歌词窗配置。10 个参数与 Java 的
     * `showLyricOverlay(locked, colorHex, sizeSp, alpha, x, y, bold, shadow, fill, fillHex)`
     * 完全一致，且都是字符串（前端传的就是 String(...)）。
     *
     * 返回值是 async（Rust 命令是异步的），但**不要**把它改成 Promise 交给前端：
     * app.js 那边是按 Android 的「同步调用、无返回值」写的，
     * 这里保持「发了就不管」的形状最安全 —— 失败只在控制台留一条记录。
     */
    showLyricOverlay: function (locked, colorHex, sizeSp, alpha, x, y,
                                 bold, shadow, fill, fillHex) {
      invoke('lyric_overlay_show', {
        locked: String(locked == null ? '' : locked),
        color: String(colorHex == null ? '' : colorHex),
        size: String(sizeSp == null ? '' : sizeSp),
        alpha: String(alpha == null ? '' : alpha),
        x: String(x == null ? '' : x),
        y: String(y == null ? '' : y),
        bold: String(bold == null ? '' : bold),
        shadow: String(shadow == null ? '' : shadow),
        fill: String(fill == null ? '' : fill),
        fillHex: String(fillHex == null ? '' : fillHex),
      }).then(function (ok) {
        if (!ok) {
          /*
           * 窗口创建失败（最常见原因：Linux 没有合成器 / DISPLAY 不可用）。
           * 这里**不改前端状态**，只在控制台说明 —— 前端的开关会保持打开，
           * 用户下次启动还会再试一次；若把开关强制关掉，
           * 用户会以为「这个功能没了」而不知道为什么。
           */
          console.warn('[ripple] 歌词窗口不可用（可能是没有桌面合成器）');
        }
      }).catch(function (e) {
        console.warn('[ripple] lyric_overlay_show 失败：', e);
      });
    },

    /** 更新当前这一句歌词 */
    updateLyricOverlay: function (text) {
      invoke('lyric_overlay_text', { text: String(text == null ? '' : text) })
        .catch(function () {});
    },

    /**
     * 推送「当前这一句」的进度 0..1。
     *
     * ⚠️ 语义是**句内**进度，不是整首进度。1.3.3 起前端 pushSbProgress()
     * 已经改成句内进度，三端共用同一个值 —— 桌面端直接当 --p 用，
     * 不做任何「除以时长」的换算。
     */
    setLyricProgress: function (p) {
      invoke('lyric_overlay_progress', { progress: String(p == null ? '' : p) })
        .catch(function () {});
    },

    /**
     * 推送填充的「基准点」，由歌词窗自己按时间外推（D-02，1.3.4）。
     *
     * ⚠️ 这个方法以前**不存在**，导致前端 app.js 的
     *     `typeof N.setLyricTiming === 'function'` 判定为 false，
     *     整条链路回退到「逐帧推真值」的旧路径。
     *
     * 而歌词窗最主要的用法恰恰是「切到别的程序时看」—— 那时主窗口
     * rAF 暂停、1 秒 ticker 被 clearInterval，逐帧推送断流，
     * 于是退化成「一下填满、换句才动」：正是 1.3.3 在 Android 上
     * 花十一轮才修掉的那个症状，在桌面端原封不动地留着。
     *
     * 参数与 Android 的 RippleNative.setLyricTiming 完全一致，
     * 所以 app.js 里不需要任何平台分支。
     *
     * @param {string} progress 句内进度 0..1
     * @param {string} lineDur  本句时长（秒），<=0 表示未知
     * @param {string} rate     播放倍速
     * @param {string} playing  'true' / 'false'
     */
    setLyricTiming: function (progress, lineDur, rate, playing) {
      invoke('lyric_overlay_timing', {
        progress: String(progress == null ? '' : progress),
        lineDur: String(lineDur == null ? '' : lineDur),
        rate: String(rate == null ? '' : rate),
        playing: String(playing == null ? '' : playing)
      }).catch(function () {});
    },

    /*
     * ===== 检查更新（1.3.4）=====
     *
     * 桌面端没有「下载并安装」这套能力：各平台安装方式差异太大
     * （Windows 跑 setup.exe、Linux 换 AppImage 或用 dpkg 装 deb），
     * 由网页安全唤起固定不现实。所以桌面端只做两件事：
     *   ① checkUpdate —— 由网页自己 fetch GitHub API（csp 为 null，可跨域）；
     *   ② openExternal —— 打开 Release 页面，用户自己下载。
     *
     * 注意这里**不提供** checkUpdate/downloadUpdate/installUpdate ——
     * app.js 会检测它们不存在，自动走桌面端的 fetch + 浏览器路径。
     */
    openExternal: function (url) {
      invoke('open_external', { url: String(url == null ? '' : url) })
        .catch(function () {});
    },

    /** 隐藏歌词窗（Rust 侧销毁窗口） */
    hideLyricOverlay: function () {
      invoke('lyric_overlay_hide').catch(function () {});
    },

    /*
     * 登录：桌面端用**扫码登录**，纯 HTTP 实现，不需要内嵌 webview。
     *
     * 这里不提供 `login`（内嵌登录页）是**有意为之**，不是缺项：
     * 1.3.0 起 `chooseLoginMode` 三端统一走扫码（见 app.js），
     * 而扫码只需要 `login_qr_key` / `login_qr_check` 两条普通命令 ——
     * 它们在 Rust 侧已实现，走的就是下面同一个 `netease` 通道。
     *
     * 所以桌面端点界面上的「登录网易云」就能扫码登录，UI 一行都不用改。
     * `login`（内嵌 webview 登录页）那条老链路只在历史上用过，现在三端都不走它，
     * 桌面端保持不提供即可 —— 前端所有原生调用点都有 `typeof === 'function'` 判空，
     * 不给就自动降级，不会报错。
     *
     * 备用：扫码不可用时可以把 MUSIC_U 写进配置目录的 netease-cookie（见 README）。
     */

    /** 内嵌登录页：三端都不再走这条链路（扫码才是主路径），保持不提供 */
    login: undefined,
    loginClose: function () {},

    /**
     * 平台标识。
     *
     * Android 的 Java 侧**不写**这个字段（那边一个都没有，前端读到 undefined
     * 就当手机端）。桌面端显式给 'desktop'，前端用它来隐藏那些只有手机上
     * 才有意义的功能 —— 目前是设置页「通知与后台」里的
     * 通知栏播放控件 / 通知不打断播放 / 发送测试通知 / 请求通知权限。
     *
     * 为什么用显式标记而不是靠能力探测（比如 typeof mediaState === 'function'）：
     * 桌面端为了「前端零改动」把所有方法都照签名造出来了，只是返回 false。
     * 靠探测会被这些占位实现骗过去，判断不出真实能力；而且以后补一个
     * 真实现就会悄悄改变布局。显式标记不会。
     */
    platform: 'desktop',

    /**
     * 界面语言同步（1.3.5）。
     *
     * 桌面端没有需要翻译的原生字符串 —— 窗口标题、系统菜单都是
     * Tauri/系统自己管的（而且 Ripple 用的是 decorations:false 无边框窗口，
     * 连标题栏都是网页自己画的）。但前端切语言时会**无条件**调这个方法，
     * 缺了它就会在控制台留下一串 TypeError。
     * 所以给一个什么都不做的实现：形状对得上、语义上确实是「无需处理」。
     */
    setLang: function (code) {
      /*
       * 1.3.7：不再是个空实现。
       *
       * 原生层也有一批**不经 DOM** 的字符串（网易云错误串、歌词窗创建失败…），
       * 前端 i18n 引擎碰不到它们，只能由原生自己翻。Android 那边 1.3.5 就
       * 用 L10n.t(zh, en) 包了 31 处；桌面端 1.3.6 之前一处都没有，
       * 于是英文界面下所有网络错误都是中文。
       *
       * 这里把语言码转给 Rust 的 set_lang 命令。失败不影响界面（DOM 那层
       * 仍然照常翻），只是原生错误串会停在默认的中文 —— 所以 catch 里
       * 只留一条日志，不抛给调用方。
       */
      try {
        invoke('set_lang', { code: String(code == null ? 'zh' : code) }).catch(function () {});
      } catch (e) {}
      return true;
    },

    /** 桌面端永远不是安全模式 */
    safeMode: function () { return false; }
  };

  /*
   * 只暴露「向前兼容」的最小面：故意不实现 Android 有的那几个
   * 媒体/通知方法（statusBarLyric 之类），让前端自己降级。
   * 多造一个假实现反而会让 UI 显示「支持」但点下去没反应 —— 比不支持更糟。
   */
  g.RippleNative = bridge;

  /* ================= 桌面端顶栏 / 播放页底部的呼吸空间 ================= 
   *
   * 用户 2026-11-27 用 Windows 截图报了两处「贴边」：
   *
   *   ① 顶栏第一行「15:43 · 星期五」离窗口上边缘太近；
   *   ② 播放页底部三个按钮（评论 / 歌曲详情 / 下载）离窗口下边缘太近。
   *
   * 两处的根因是同一个：前端那套间距是按**手机**设计的 ——
   * .topbar 的 padding-top 用 var(--safe-t)，.np-actions 的 padding-bottom
   * 用 var(--safe-b)，而这两个变量的语义是「系统状态栏 / 手势条占掉的高度」。
   * 手机上有真实值，APK 会把它改写成量出来的像素；
   * **桌面端两个变量都是 0** —— 没有状态栏，也没有手势条。
   * 于是本该由「系统 chrome」提供的留白在桌面端完全消失，内容贴着窗沿。
   *
   * 为什么不在 app/css 里给 .topbar / .np-actions 直接加固定 padding：
   *   app/ 是三端共享的前端。在那里加固定值，Android 上就会变成
   *   「状态栏高度 + 新加的值」= 双份留白，反而更难看。
   *   而「桌面端没有系统栏」这件事**只有桌面端自己知道**，
   *   所以补偿必须写在桌面端这一层。
   *
   * 实现方式：给 <html> 加一个 data-plat="desktop"，由 CSS 按它微调。
   * 用 CSS 变量而不是直接改 padding，是因为那两条规则本来就是
   * 「padding + var(--safe-*)」的形状 —— 只把变量补上，样式规则一个字都不用动，
   * 以后手机端改了 padding 也不会和这里打架。
   */
  (function applyDesktopInsets() {
    if (!document.documentElement) return;
    document.documentElement.setAttribute('data-plat', 'desktop');
  })();

  /* ================= 歌词窗创建失败 → 用户可见的提示 =================
   *
   * 1.3.9 之前这条链路是这样断的：
   *   Rust：`ensure_lyric_window(...).is_ok()` 把 Err 丢掉 → 无日志
   *   JS  ：失败只 `console.warn` → release 版没有可见控制台
   *   界面：开关拨上去了，但什么都没发生
   *
   * 用户因此只能得出「点了没反应」这个结论，连自己是不是点错了都不知道。
   * 1.3.9 起 Rust 会在失败时 emit `lyric-window-error`（并同时写日志），
   * 这里把它接住、弹一条 warn toast，把**真实原因**直接摊给用户看。
   *
   * 为什么放在 bridge.js 而不是 app.js：
   *   事件名只有 Rust 与这里两处知道，它们是同一件事的两端，放在一起
   *   才不会出现「改了 Rust 忘了改 JS」这种断链。app.js 只是被调用方。
   *
   * 为什么用 RippleApp.toast 而不是自己画一个：
   *   顶栏 toast 已经处理了「设置里关掉软件内通知」「同时最多 3 条」
   *   「连续相同内容去重」这些细节，再造一套只会分裂行为。
   *   注意 toast 对 warn 类型**不受** inAppToast 开关影响（见 app.js 注释），
   *   正是「出错必须告诉用户」这条原则。
   */
  function reportLyricWindowError(reason) {
    const ty = (reason == null ? '' : String(reason)).trim();
    try {
      const app = g.RippleApp;
      if (app && typeof app.toast === 'function') {
        /*
         * 第三个参数 'warn' 不能省：app.js 的 toast 在入口处统一拦
         * 「设置 → 软件内通知」关掉的情况，但显式排除 warn/check
         * —— 出错必须告诉用户。少了它，关过通知的用户就看不到这条。
         */
        app.toast(
          '歌词小窗未能创建',
          ty
            ? ty + '（详细原因已写入日志，可在「我的 → 软件日志」查看）'
            : '详细原因已写入日志，可在「我的 → 软件日志」查看',
          'warn'
        );
        return;
      }
    } catch (e) {
      /* toast 本身出错不能反过来把这里也变成静默失败 */
    }
    /*
     * 兜底：app.js 还没跑（极早期失败）。此时 console 至少留下了现场，
     * 而日志里已经有 Rust 写的那一行 —— 两条路都不会完全丢信息。
     */
    console.warn('[ripple] 歌词小窗创建失败：', ty || '(无原因)');
  }

  (function listenLyricWindowError() {
    const ev = TAURI.event;
    if (!ev || typeof ev.listen !== 'function') return;
    /* listen 返回 Promise；失败只影响提示，不影响主流程，所以安静吞掉 */
    ev.listen('lyric-window-error', (e) => {
      reportLyricWindowError(e && e.payload);
    }).catch(function () {});
  })();

  /* ================= 窗口按钮（融进顶栏） =================
   *
   * 为什么需要它：tauri.conf.json 里设了 decorations:false（关掉系统标题栏），
   * 这样才能让页面背景铺满整个窗口、做出沉浸感。代价是**拖动窗口和
   * 最小化/关闭按钮全没了**，必须自己补一套，否则窗口就拖不动了。
   *
   * ===== 为什么不再用「一条独立标题栏」=====
   * 上一版是 position:fixed 的 34px 深色横条 + `html{padding-top:34px}`。
   * 那种做法有个绕不过去的毛病：padding 会把整个页面往下推 34px，
   * 于是任何页面顶部的内容都被永久压住一块（用户实测「挡住 UI」），
   * 而且深色实底横条压在浅色页面上像贴了块胶布，与「沉浸」正好相反。
   *
   * 这一版改成参考 ZCode 的思路：**不存在「标题栏」这个东西**，
   * 只有三个按钮，零高度、不占布局，直接浮在页面右上角。
   * 页面自己的顶栏（.topbar）右侧本来就有搜索/主题/设置三个圆按钮，
   * 窗口按钮排在它们右边，视觉上是同一排控件 —— 不额外造一条横条。
   *
   * ===== 为什么按钮要盖在所有东西之上（z-index 极高）=====
   * 播放页 `.np` 是 position:fixed;inset:0;z-index:60 的全屏层，
   * 会把顶栏整个盖住。如果窗口按钮跟着顶栏一起被盖，
   * 打开播放页后就既关不掉窗口也最小化不了 —— 这是功能性问题，不是观感。
   * 所以按钮单独浮在最高层（比自定义弹窗的 z-index:120 还高）。
   *
   * ===== 为什么不改 app/index.html =====
   * app/ 是三端共享的前端：Android 有真·系统状态栏、浏览器有浏览器 chrome，
   * 它们都不需要这些按钮。注入在 bridge.js 里，只有桌面端会看到。
   */

  /** 窗口按钮的尺寸与右边距：和顶栏 .tb-btn 的 36px 圆保持同一套节奏 */
  const TB_BTN = 36;
  const TB_GAP = 6;
  const TB_EDGE = 12;   // 距窗口右边缘

  function injectTitlebar() {
    if (document.getElementById('tauri-winbtns')) return;

    const box = document.createElement('div');
    box.id = 'tauri-winbtns';
    /*
     * 窗口按钮的 aria-label / title 也要跟界面语言走（1.3.5 多语言）。
     *
     * 这三颗按钮是**桥注入**的，不在 index.html 里，i18n.js 的
     * 「加载时整页走一遍」碰不到它们 —— 那时这段代码还没跑。
     * 好在 i18n.js 的 MutationObserver 会接住后来插入的节点，
     * 所以这里只要写中文原文即可，英文态下会被自动替换。
     *
     * 为什么仍然显式写 t()：
     *   如果将来有一天关掉 Observer（比如为了性能），这三颗按钮会
     *   永久停在中文。显式 t() 让它不依赖那条通路。
     */
    const t = (zh, en) => {
      const I = g.I18n;
      if (I && typeof I.lang === 'string' && I.lang !== 'zh') return en;
      return zh;
    };
    box.innerHTML =
      '<button type="button" data-act="min" aria-label="' + t('最小化', 'Minimize')
      + '" title="' + t('最小化', 'Minimize') + '">'
      + '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6h7"/></svg></button>'
      + '<button type="button" data-act="max" aria-label="' + t('最大化', 'Maximize')
      + '" title="' + t('最大化', 'Maximize') + '">'
      + '<svg viewBox="0 0 12 12" aria-hidden="true"><rect x="2.5" y="2.5" width="7" height="7" rx="1"/></svg></button>'
      + '<button type="button" data-act="close" aria-label="' + t('关闭', 'Close')
      + '" title="' + t('关闭', 'Close') + '">'
      + '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6"/></svg></button>';

    const css = document.createElement('style');
    css.textContent = `
      /*
       * 容器：零高度、不参与页面布局，只负责把按钮摆到右上角。
       * pointer-events:none 让容器本身不挡内容，按钮再单独收回点击事件。
       */
      #tauri-winbtns{
        position:fixed;top:0;right:${TB_EDGE}px;z-index:99999;
        display:flex;align-items:center;gap:${TB_GAP}px;
        height:56px;              /* 与页面顶栏同一视觉中线，但不吃布局 */
        pointer-events:none;
        -webkit-app-region:no-drag;  /* 万一将来开 Tauri 原生 drag region，别把按钮算进去 */
      }
      /*
       * 按钮：极简线条、无实底背景，直接浮在内容上（ZCode 的做法）。
       * 颜色全部继承页面主题变量，深浅色自动跟随 —— 上一版写死 rgba
       * 深色是因为横条自带深底；现在按钮直接压在页面背景上，
       * 必须跟着主题走，否则浅色主题下白按钮就看不见了。
       */
      #tauri-winbtns button{
        pointer-events:auto;
        width:${TB_BTN}px;height:${TB_BTN}px;flex:none;
        display:grid;place-items:center;padding:0;
        border:0;border-radius:50%;
        background:transparent;
        color:var(--text2, #6b6b76);
        cursor:pointer;
        transition:background .16s ease,color .16s ease;
      }
      #tauri-winbtns button svg{
        width:12px;height:12px;
        fill:none;stroke:currentColor;stroke-width:1.25;
        stroke-linecap:round;
      }
      #tauri-winbtns button:hover{
        background:var(--panel, rgba(0,0,0,.07));
        color:var(--text, #1b1b22);
      }
      #tauri-winbtns button:active{transform:scale(.92)}
      #tauri-winbtns button:focus-visible{
        outline:2px solid var(--accent, #b23a48);outline-offset:-2px;
      }
      /* 关闭按钮悬停沿用桌面习惯的红底白字 */
      #tauri-winbtns button[data-act="close"]:hover{
        background:#e81123;color:#fff;
      }
      /*
       * 给页面顶栏右侧让出按钮的宽度，避免页面的搜索/主题/设置
       * 三个圆按钮与窗口按钮叠在一起。
       * 用 padding-right 而不是 margin：让顶栏自己的布局右边界内缩，
       * 不会把顶栏整体顶歪。
       */
      .topbar{padding-right:calc(${TB_EDGE + TB_BTN * 3 + TB_GAP * 2 + 10}px)!important}
      /*
       * 播放页：它自己的 .np-top 右侧有个「播放设置」按钮，
       * 同样要内缩，否则会被窗口按钮压住。
       */
      .np-inner{padding-right:calc(${TB_EDGE + TB_BTN * 3 + TB_GAP * 2 + 6}px)!important}
      /*
       * 拖动窗口：原来整条 titlebar 是 data-tauri-drag-region，
       * 现在没有那条区域了，改把顶栏左边那块「日期 + 问候语」（.hello）
       * 作为拖动区 —— 它是顶栏里唯一的纯文本空白区，拖它最符合直觉。
       *
       * 必须用 "deep" 而不是空值：Tauri 的裸属性只在**直接点到该元素本身**
       * 时才触发拖动（见 tauri/src/window/scripts/drag.js 的 isDragRegion：
       * attr 为空时要求 el === composedPath[0]）。
       * 而 .hello 里面还有 small 和 h1 两个子节点，点在文字上 target
       * 就是子节点，裸属性会失效 —— 实测拖不动。
       *
       * 双击最大化不用自己写：Tauri 的同一个脚本已经处理了
       * （e.detail === 2 时它自己发 internal_toggle_maximize）。
       * 所以这里不加 dblclick 监听，避免和它重复触发、互相抵消。
       */
      .topbar .hello{cursor:default}
    `;
    document.head.appendChild(css);

    const act = (a) => {
      const w = g.__TAURI__.window;
      const win = w && typeof w.getCurrentWindow === 'function' ? w.getCurrentWindow() : null;
      if (!win) return;
      if (a === 'min') win.minimize();
      else if (a === 'max') win.toggleMaximize();
      else if (a === 'close') win.close();
    };

    box.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => act(b.dataset.act));
    });

    /*
     * 挂载点：顶栏是一个 flex 容器，把按钮盒 append 到 <body> 而不是顶栏里，
     * 因为它必须能盖住播放页（播放页是 body 的兄弟层）。
     */
    document.body.appendChild(box);

    /*
     * 拖动区：把顶栏里的 .hello（左边那块「日期 + 问候语」）标记成拖动区。
     * 用 "deep" 让它的子节点（<small>/<h1>）也能触发拖动，理由见上面 CSS 注释。
     * 双击最大化由 Tauri 自己处理，这里不再重复监听。
     */
    const setDragRegion = () => {
      const hello = document.querySelector('.topbar .hello');
      if (hello && hello.getAttribute('data-tauri-drag-region') !== 'deep') {
        hello.setAttribute('data-tauri-drag-region', 'deep');
      }
    };
    setDragRegion();
    // 页面切换（JS 重绘顶栏）后再补一次，避免拖动区丢失
    setTimeout(setDragRegion, 1200);
    setTimeout(setDragRegion, 3000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectTitlebar, { once: true });
  } else {
    injectTitlebar();
  }

  // 桌面端不需要 Service Worker（没有「离线打开」的场景，且 SW 会缓存旧壳）
  if (g.navigator && g.navigator.serviceWorker && g.navigator.serviceWorker.register) {
    g.navigator.serviceWorker.register = function () {
      return Promise.reject(new Error('桌面端不注册 Service Worker'));
    };
  }
})(window);
