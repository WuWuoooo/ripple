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
          // Rust 侧已经负责在完成后调 __rippleNativeResult，这里什么都不用做
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

    /** 是否提供通知能力（前端用 typeof 判断，这里给一个恒 false 的实现即可） */
    mediaState: function () { return false; },

    /** 桌面端无悬浮窗概念 */
    canDrawOverlay: function () { return false; },
    requestOverlayPermission: function () { return false; },

    /*
     * 登录：桌面端用**扫码登录**，纯 HTTP 实现，不需要内嵌 webview。
     *
     * 为什么不提供 `login` 而是留空：前端的登录界面判断 `Netease.mode !== 'native'`
     * 就直接拒绝（见 app.js 的 chooseLoginMode），而 mode 又取决于
     * `RippleNative.netease` 是否存在 —— 也就是说桌面端**自动**就落进了
     * 「浏览器模式」，前端提示「浏览器里无法内嵌登录」。
     *
     * 要打通它，必须在前端那 13000 行里加一个桌面专属的登录弹窗。
     * 那是「前端零改动」这条约束的第一次破例，值得单独决策，所以本轮
     * 先把底层命令（login_qr_key / login_qr_check）备好，UI 留到下一轮。
     *
     * 换句话说：现在桌面端可以用「把 MUSIC_U 写进配置目录」的方式登录
     * （见 README），扫码界面是待补的一项。
     */

    /** 前端判断登录能力时会看这个；恒 false 让它走「浏览器模式」的降级提示 */
    login: undefined,
    loginClose: function () {},

    /** 桌面端永远不是安全模式 */
    safeMode: function () { return false; }
  };

  /*
   * 只暴露「向前兼容」的最小面：故意不实现 Android 有的那几个
   * 媒体/通知方法（statusBarLyric 之类），让前端自己降级。
   * 多造一个假实现反而会让 UI 显示「支持」但点下去没反应 —— 比不支持更糟。
   */
  g.RippleNative = bridge;

  /* ================= 自绘标题栏 =================
   *
   * 为什么需要它：tauri.conf.json 里设了 decorations:false（关掉系统标题栏），
   * 这样才能让页面背景铺满整个窗口、做出沉浸感。代价是**拖动窗口和
   * 最小化/关闭按钮全没了**，必须自己补一套，否则窗口就拖不动了。
   *
   * 为什么注入在这里而不是改 app/index.html：
   *   app/ 是三端共享的前端，Android 有真·系统状态栏、浏览器有浏览器 chrome，
   *   它们都不需要这条标题栏。往源码里加会在另外两端多出一条多余的横条。
   *   注入在这里，只有桌面端会看到它。
   */
  function injectTitlebar() {
    if (document.getElementById('tauri-titlebar')) return;
    const bar = document.createElement('div');
    bar.id = 'tauri-titlebar';
    // data-tauri-drag-region 是 Tauri 约定的拖动区域标记
    bar.setAttribute('data-tauri-drag-region', '');
    bar.innerHTML =
      '<div class="tb-drag" data-tauri-drag-region>'
      + '<span class="tb-title">Ripple 涟漪</span>'
      + '</div>'
      + '<div class="tb-btns">'
      + '<button type="button" data-act="min" aria-label="最小化">&#x2013;</button>'
      + '<button type="button" data-act="max" aria-label="最大化">&#x25A1;</button>'
      + '<button type="button" data-act="close" aria-label="关闭">&#x2715;</button>'
      + '</div>';

    const css = document.createElement('style');
    css.textContent = `
      #tauri-titlebar{
        position:fixed;left:0;right:0;top:0;height:34px;z-index:99999;
        display:flex;align-items:center;
        /*
         * 背景不能用 transparent：页面顶部是一块带渐变的内容区，
         * 透明会让标题栏文字直接压在内容上，浅色主题下几乎看不见
         * （实测深色文字配浅色渐变，对比度不够）。
         * 用页面自身的 --bg 实色，视觉上仍然与页面连成一片 = 沉浸，
         * 同时保证文字始终清晰。
         */
        /*
         * 配色不用 var(--bg)/var(--text)：
         *   · 这两个变量在页面里由 JS 按主题动态改，
         *   · 而标题栏注入发生在页面加载早期，取到的可能是初始值。
         * 实测用变量出来是「深底 + 深字」，几乎看不清。
         * 直接给固定的高对比配色，深浅主题下都能读（标题栏只有 34px，
         * 不承担主题表达，可读性优先）。
         */
        background:rgba(16,16,22,.92);
        color:rgba(235,235,245,.88);
        font:500 11.5px/1 var(--font,system-ui,sans-serif);
        user-select:none;-webkit-user-select:none;
        /* 玻璃质感的细分隔线，和 UI 其它地方的 border 语言一致 */
        box-shadow:inset 0 -1px 0 rgba(255,255,255,.10);
      }
      #tauri-titlebar .tb-drag{
        flex:1;height:100%;display:flex;align-items:center;
        padding-left:calc(var(--safe-l,0px) + 16px);
        cursor:default;
      }
      #tauri-titlebar .tb-title{opacity:.85;letter-spacing:.06em}
      #tauri-titlebar .tb-btns{display:flex;height:100%;flex:none}
      #tauri-titlebar .tb-btns button{
        width:46px;height:100%;border:0;background:transparent;
        color:inherit;font-size:11px;cursor:pointer;
        transition:background .15s ease,color .15s ease;
      }
      #tauri-titlebar .tb-btns button:hover{background:rgba(255,255,255,.09);color:#fff}
      #tauri-titlebar .tb-btns button[data-act="close"]:hover{background:#e81123;color:#fff}
      /* 给页面顶部让出标题栏高度：只影响桌面端 */
      html{padding-top:34px;box-sizing:border-box}
      html,body{height:100%}
    `;
    document.head.appendChild(css);
    document.body.appendChild(bar);

    const act = (a) => {
      const w = g.__TAURI__.window;
      // Tauri 2 的窗口操作走 getCurrentWindow()
      const win = w && typeof w.getCurrentWindow === 'function' ? w.getCurrentWindow() : null;
      if (!win) return;
      if (a === 'min') win.minimize();
      else if (a === 'max') win.toggleMaximize();
      else if (a === 'close') win.close();
    };
    bar.querySelectorAll('.tb-btns button').forEach((b) => {
      b.addEventListener('click', () => {
        act(b.dataset.act);
      });
    });

    /*
     * 把标题栏的实际几何写进 <title>，方便从外部（xwininfo / 截图之外的
     * 手段）确认它真的渲染出来了、按钮在什么位置。
     * 这是排查手段而不是功能，正常使用时无副作用。
     */
    setTimeout(() => {
      try {
        const r = bar.getBoundingClientRect();
        const btns = $$('.tb-btns button', bar);
        const br = btns.length ? btns[btns.length - 1].getBoundingClientRect() : null;
        document.title = 'Ripple 涟漪 [' + Math.round(r.width) + 'x' + Math.round(r.height)
          + (br ? ' close@' + Math.round(br.left) + ',' + Math.round(br.top)
                + ' ' + Math.round(br.width) + 'x' + Math.round(br.height) : ' nobtn') + ']';
      } catch (e) {}
    }, 1500);
    // 双击拖动区 = 最大化/还原（和系统标题栏一致的习惯）
    bar.querySelector('.tb-drag').addEventListener('dblclick', () => act('max'));
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
