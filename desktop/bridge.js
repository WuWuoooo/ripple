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

    /** 桌面端永远不是安全模式 */
    safeMode: function () { return false; }
  };

  /*
   * 只暴露「向前兼容」的最小面：故意不实现 Android 有的那几个
   * 媒体/通知方法（statusBarLyric 之类），让前端自己降级。
   * 多造一个假实现反而会让 UI 显示「支持」但点下去没反应 —— 比不支持更糟。
   */
  g.RippleNative = bridge;

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
    box.innerHTML =
      '<button type="button" data-act="min" aria-label="最小化" title="最小化">'
      + '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6h7"/></svg></button>'
      + '<button type="button" data-act="max" aria-label="最大化" title="最大化">'
      + '<svg viewBox="0 0 12 12" aria-hidden="true"><rect x="2.5" y="2.5" width="7" height="7" rx="1"/></svg></button>'
      + '<button type="button" data-act="close" aria-label="关闭" title="关闭">'
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
