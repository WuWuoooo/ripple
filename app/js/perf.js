/* ============================================================
   Ripple · perf.js
   性能档位判断 + 运行时降级

   背景：用户反馈安卓平板（rk3576s，1024 CSS px）上只有 30 帧。
   渲染开销的大头是这几项，全都是「整个视口每帧重新合成」的量级：
     · 氛围光：父层 filter:blur(76px) 包住三个一直在动的子元素
     · 颗粒噪点：整屏 mix-blend-mode:overlay
     · 玻璃：十几个元素各自 backdrop-filter（每个都是一次离屏重采样）
     · 播放页背景：整屏 blur(52px)
   这些在旗舰手机上 GPU 能扛，在中端平板/低端机上直接把帧率砍半。

   策略：
     1) 启动前（<head> 里的内联脚本）先按硬件信息做一次粗判，
        把 perf-low 类挂上去，避免首屏按高画质渲染完再降级（会闪一下）；
     2) 启动若干秒后实测帧率，低于阈值就自动降级并记下来，
        但同时尊重用户手动选择（用户选了「高画质」就不再自动降）。
   ============================================================ */
(function (g) {
  'use strict';

  var KEY = 'ripple.perf.v1';          // 用户选择：'auto' | 'high' | 'low'
  var KEY_AUTO = 'ripple.perf.auto';   // 自动判断的结论：'1' = 该降级

  /*
   * ---------- 硬件粗判（不依赖任何 API 也能给出保守答案） ----------
   *
   * ⚠️ 阈值曾经是 200 万物理像素，注释还写着「≈ 1080×1920 才开始考虑降级」，
   * 但 1080×1920 自己就是 207 万 —— 等于把参考分辨率本身划进了降级区。
   * 实测后果：393×873 @dpr2.75 = 259 万 → 低配；1920×1080 桌面 = 207 万 → 低配。
   * 只有 720p 且 dpr2（92 万）才判高配，也就是**几乎所有手机都是低配**，
   * 液态玻璃（CHANGELOG 的主打卖点）永远不出现。
   *
   * 现在改成 450 万：这是 1440p（约 368 万）之上、2K 手机（约 460 万）附近的位置，
   * 让 1080p / 1.5K 这个主流区间能正常拿到高画质。
   * 真正扛不住的机器还有下面两条更可靠的信号（核心数、内存），
   * 以及运行时实测帧率兜底 —— 靠像素数一个人判断本来就不准。
   */
  var PHYS_LOW = 4500000;

  function guessLow() {
    var low = false;
    try {
      /* 物理像素总量。用物理而非 CSS px —— 一块 1024 CSS px、dpr 2 的平板
         实际要渲染 2048×1400 ≈ 287 万像素。 */
      var dpr = g.devicePixelRatio || 1;
      var w = (g.screen && g.screen.width) || 0;
      var h = (g.screen && g.screen.height) || 0;
      var phys = w * h * dpr * dpr;
      if (phys > PHYS_LOW) low = true;

      /* 核心数偏少 / 内存偏小：这两个 API 有的浏览器不给，拿不到就跳过 */
      var cores = g.navigator && g.navigator.hardwareConcurrency;
      if (cores && cores <= 4) low = true;
      var mem = g.navigator && g.navigator.deviceMemory;
      if (mem && mem <= 3) low = true;

      /*
       * 「减少动效」不再参与低配判定。
       *
       * 这个偏好的语义是「别让画面动」，而不是「这台机器弱」。
       * 以前把它当硬件信号挂 perf-low，会顺手关掉氛围光、噪点和**所有**
       * backdrop-filter、面板换实色 —— 一台旗舰机只要系统开了
       * 「移除动画」，Ripple 就变成没有玻璃质感的省电外观，属于明显的误伤。
       * 关动画的部分交给 responsive.css 里的 @media (prefers-reduced-motion) 处理。
       */
    } catch (e) {}
    return low;
  }

  function mode() {
    try {
      var v = g.localStorage.getItem(KEY);
      return v === 'high' || v === 'low' ? v : 'auto';
    } catch (e) { return 'auto'; }
  }

  function autoLow() {
    try { return g.localStorage.getItem(KEY_AUTO) === '1'; } catch (e) { return false; }
  }

  /*
   * 把当前档位落到 <html> 上，并在**真的翻转**时广播一次。
   *
   * 为什么必须广播：低配判定有一条是运行时自动降级（measure() 实测帧率偏低），
   * 那条路径不经过设置页，app.js 里那些「按档位决定要不要做某个效果」的开关
   * （典型是歌词模糊的 html.lyr-blur 类）就永远收不到通知 ——
   * 于是自动降级之后毛玻璃关了，但每一行歌词仍然是一个独立的 filter:blur
   * 合成层，低配机照样掉帧，低配的全部意义落空。
   *
   * 只在类真的变化时发：apply() 在启动、手动切换、自动降级三处都会被调，
   * 每次都发一遍事件会让设置页做无意义的整轮重算。
   */
  function apply() {
    var m = mode();
    var low = m === 'low' || (m === 'auto' && (autoLow() || guessLow()));
    var root = document.documentElement;
    var changed = root.classList.contains('perf-low') !== low;
    root.classList.toggle('perf-low', low);
    /* 顺手把选择广播出去，设置页/别的脚本想知道当前档位时读这个属性即可 */
    root.setAttribute('data-perf', low ? 'low' : 'high');
    if (changed) {
      /*
       * ⚠️ 必须派发到 **document**，不是 window（审查 1.3.8 的 H-1）。
       *
       * DOM 事件的传播方向只有「target → 祖先」这一条，**不会向下**
       * 传给子节点。window.dispatchEvent() 的 target 就是 window，
       * 它只触发 window 自己的监听器；挂在 document 上的监听器永远收不到。
       * 而 app.js 的监听器当初就是加在 document 上的（见那里的注释），
       * 两边目标对象不一致 —— 这条「降级通知」通路从上线起从未生效过：
       * 自动降级后 html.perf-low 挂上了、毛玻璃也关了，但 html.lyr-blur
       * 还留着，每一行歌词仍是一个独立的 filter:blur 合成层，
       * 低配降级省下的那笔开销又原样花了回来。
       *
       * 顺带把「自定义事件一律在 document 上派发与监听」定为约定，
       * 免得下次又在两个目标之间各写一半。
       */
      try {
        (g.document || document).dispatchEvent(new g.CustomEvent('ripple:perf', { detail: { low: low } }));
      } catch (e) {}
    }
    return low;
  }

  /* 暴露给设置页用 */
  var Perf = {
    mode: mode,
    isLow: function () { return document.documentElement.classList.contains('perf-low'); },
    /* 为什么被判成低配 —— 设置页可以直接显示出来，用户不用猜 */
    why: function () {
      /*
       * 多语言（1.3.5）：这里的文案是**拼接**出来的（数值夹在句子中间），
       * 英文语序和中文完全不同 —— 「屏幕物理像素 259 万，超过 450 万」
       * 直译成「screen pixels 259 万 over 450 万」是读不通的。
       * 所以不走片段替换，直接按语言各写一条完整句式。
       *
       * 数值单位也要换：中文用「万」，英文没有这个量级词，
       * 用 K px（千像素）表达同一个数量级更自然。
       */
      var en = !!(g.I18n && g.I18n.lang === 'en');
      if (mode() === 'low') return en ? 'Manually set to power saving' : '手动选择省电';
      if (mode() === 'high') return en ? 'Manually set to high quality' : '手动选择高画质';
      if (autoLow()) return en ? 'Measured frame rate is low (auto)' : '实测帧率偏低（自动）';
      if (guessLow()) {
        try {
          var dpr = g.devicePixelRatio || 1;
          var w = (g.screen && g.screen.width) || 0;
          var h = (g.screen && g.screen.height) || 0;
          var phys = Math.round(w * h * dpr * dpr / 10000) / 100;
          var cores = g.navigator && g.navigator.hardwareConcurrency;
          var mem = g.navigator && g.navigator.deviceMemory;
          if (phys > PHYS_LOW / 10000) {
            return en
              ? 'Screen has ' + Math.round(phys) + ' K px, above the ' + (PHYS_LOW / 10000) + ' K limit'
              : '屏幕物理像素 ' + phys + ' 万，超过 ' + (PHYS_LOW / 10000) + ' 万';
          }
          if (cores && cores <= 4) return (en ? 'CPU cores: ' : 'CPU 核心数 ') + cores;
          if (mem && mem <= 3) return en ? 'Device memory ~' + mem + ' GB' : '设备内存约 ' + mem + ' GB';
        } catch (e) {}
        return en ? 'Detected as low-end hardware' : '硬件信息判定为低配';
      }
      return en ? 'Currently high quality' : '当前高画质';
    },
    /* 设置页切换：auto / high / low */
    set: function (m) {
      try {
        if (m === 'high' || m === 'low') g.localStorage.setItem(KEY, m);
        else g.localStorage.removeItem(KEY);
      } catch (e) {}
      /* 手动切换时清掉"自动降级"的历史结论，否则选回"自动"会立刻又变低配 */
      if (m === 'high') { try { g.localStorage.removeItem(KEY_AUTO); } catch (e) {} }
      return apply();
    },
    /*
     * 实测帧率。只在「自动」档下改结论，且一旦测出低帧就永久记住，
     * 避免每次启动都要先卡几秒才降级。
     *
     * ⚠️ 这里修的是「断网/切后台时测量被误判」：
     * 旧实现从第 1 帧开始记 start，若用户在这 3 秒内切走/锁屏，
     * rAF 被暂停，回到前台时 ts-start 已远超 3s 而 frames 很少，
     * fps 被算成个位数 → 永久降级 + 弹提示。
     * 反向情况（完成时仍隐藏）则直接丢弃这次测量、也不重测。
     *
     * 现在逐帧跳过不可见时段：只在 document.visibilityState === 'visible'
     * 时累计帧数与时间，并且只统计「连续可见」的那一段。
     */
    measure: function (ms, threshold) {
      if (mode() !== 'auto') return;
      ms = ms || 3000;
      threshold = threshold || 45;
      var frames = 0, start = 0, done = false, bailed = false;

      function visible() {
        return typeof document.visibilityState === 'string'
          ? document.visibilityState === 'visible'
          : !document.hidden;
      }
      function tick(ts) {
        if (done) return;
        if (!visible()) {
          /* 一旦不可见就作废这次测量，回到可见时重新计时 ——
             把"后台被节流"当成"性能差"是最容易误伤的一条路径。 */
          start = 0; frames = 0; bailed = true;
          g.requestAnimationFrame(tick);
          return;
        }
        if (bailed) { bailed = false; }
        if (!start) start = ts;
        frames++;
        if (ts - start < ms) { g.requestAnimationFrame(tick); return; }
        done = true;
        var fps = frames / ((ts - start) / 1000);
        if (fps < threshold && !autoLow()) {
          try { g.localStorage.setItem(KEY_AUTO, '1'); } catch (e) {}
          apply();
          /* 告诉用户发生了什么，而不是让它悄悄地变丑 */
          if (g.RippleApp && typeof g.RippleApp.toast === 'function') {
            try {
              g.RippleApp.toast('已自动降低画面效果', '实测 ' + Math.round(fps) + ' 帧，可在「我的 → 画面性能」里改回高画质', 'info');
            } catch (e) {}
          }
        }
      }
      g.requestAnimationFrame(tick);
    },
  };

  g.RipplePerf = Perf;
  apply();

  /* 启动后测一次。等 2.5 秒让首屏渲染和首批网络请求过去，测出来才有意义。 */
  g.addEventListener('load', function () {
    setTimeout(function () { Perf.measure(3000, 45); }, 2500);
  });
})(window);
