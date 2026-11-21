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

  // 桌面端不需要 Service Worker（没有「离线打开」的场景，且 SW 会缓存旧壳）
  if (g.navigator && g.navigator.serviceWorker && g.navigator.serviceWorker.register) {
    g.navigator.serviceWorker.register = function () {
      return Promise.reject(new Error('桌面端不注册 Service Worker'));
    };
  }
})(window);
