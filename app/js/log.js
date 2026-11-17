/* ============================================================
   Ripple · 运行日志
   APK 里写进原生日志文件（可在「下载/Ripple-log.txt」看到）；
   浏览器里写到控制台 + 内存缓冲。
   ============================================================ */
(function (g) {
  const BUF = [];
  const MAX = 400;

  const N = () => g.RippleNative;

  function stamp() {
    const d = new Date();
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
      + '.' + p(d.getMilliseconds(), 3);
  }

  function fmt(v) {
    if (v === null) return 'null';
    if (v === undefined) return 'undefined';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    try { return JSON.stringify(v); } catch (e) { return String(v); }
  }

  const Log = {
    /** 写一行日志 */
    add(tag, ...args) {
      const msg = args.map(fmt).join(' ');
      const line = `${stamp()} ${tag}: ${msg}`;
      BUF.push(line);
      if (BUF.length > MAX) BUF.shift();
      let nativeOk = false;
      try {
        const n = N();
        if (n && typeof n.log === 'function') { n.log(String(tag), msg); nativeOk = true; }
      } catch (e) {}
      /*
       * APK 里已经有原生日志（写 Download/Ripple-log.txt），
       * 再往 console 打一份就是纯噪音，而且 console 在 WebView 里
       * 只有接了调试器才看得到，日常排障用不上。
       * 只在浏览器/PWA 模式（没有原生桥）时保留 console 输出。
       */
      if (!nativeOk) {
        try { console.log('[ripple]', tag, msg); } catch (e) {}
      }
    },

    info(tag, ...args) { this.add(tag, ...args); },

    /** 记录一次异常（带堆栈），立刻落盘 */
    err(tag, e, extra) {
      const msg = (e && (e.message || e)) + '';
      const stack = (e && e.stack) ? e.stack : '';
      const line = `${stamp()} ${tag}: ERROR ${msg}${extra ? ' | ' + fmt(extra) : ''}`;
      BUF.push(line);
      if (stack) BUF.push(stack);
      /*
       * err() 一次 push 两行（message + stack），以前完全不做上限裁剪，
       * 而 add() 只 shift 一次。反复报错的场景（比如每秒复发的歌词渲染错误）
       * 会让 BUF 缓慢突破 MAX，内存和 dump 输出一起膨胀。
       * 这里统一裁到 MAX，多出来的从头部丢掉。
       */
      while (BUF.length > MAX) BUF.shift();
      try {
        const n = N();
        if (n && typeof n.jsError === 'function') {
          n.jsError(msg + (extra ? ' | ' + fmt(extra) : ''), stack);
        } else if (n && typeof n.log === 'function') {
          n.log(tag, 'ERROR ' + msg + ' ' + stack);
          if (typeof n.logFlush === 'function') n.logFlush();
        }
      } catch (err) {}
      /*
       * console 只在「没有原生桥」时才打 —— 与 add() 的策略保持一致。
       * APK 里已经有原生日志，再往 console 打一份纯噪音。
       */
      let nativeOk = false;
      try { const n = N(); nativeOk = !!(n && typeof n.jsError === 'function'); } catch (e2) {}
      if (!nativeOk) {
        try { console.error('[ripple]', tag, e); } catch (err) {}
      }
    },

    flush() {
      try {
        const n = N();
        if (n && typeof n.logFlush === 'function') n.logFlush();
      } catch (e) {}
    },

    /** 内存里的日志（浏览器兜底查看） */
    dump() {
      return BUF.join('\n');
    },

    /** 原生日志文件路径 */
    path() {
      try {
        const n = N();
        if (n && typeof n.logPath === 'function') return n.logPath();
      } catch (e) {}
      return '(浏览器环境，日志在控制台)';
    },

    /** 原生日志全文 */
    nativeDump() {
      try {
        const n = N();
        if (n && typeof n.logDump === 'function') return n.logDump();
      } catch (e) {}
      return this.dump();
    },
  };

  /* 全局兜底：任何未捕获异常都进日志 */
  g.addEventListener('error', (e) => {
    if (e && e.message) {
      Log.err('WINDOW-ERROR', e.error || new Error(e.message),
        (e.filename || '') + ':' + (e.lineno || 0));
    }
  });
  g.addEventListener('unhandledrejection', (e) => {
    const r = e && e.reason;
    Log.err('PROMISE', r && r.message ? r : new Error(String(r)));
  });

  g.Log = Log;
})(window);
