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
     2) 启动 3 秒后实测帧率，低于阈值就自动降级并记下来，
        但同时尊重用户手动选择（用户选了「高画质」就不再自动降）。
   ============================================================ */
(function (g) {
  'use strict';

  var KEY = 'ripple.perf.v1';          // 用户选择：'auto' | 'high' | 'low'
  var KEY_AUTO = 'ripple.perf.auto';   // 自动判断的结论：'1' = 该降级

  /* ---------- 硬件粗判（不依赖任何 API 也能给出保守答案） ---------- */
  function guessLow() {
    var low = false;
    try {
      /* 物理像素总量：超过约 200 万（≈ 1080×1920）才开始考虑降级。
         注意用物理像素而不是 CSS px —— 一块 1024 CSS px、dpr 2 的平板
         实际要渲染 2048×1400 ≈ 287 万像素，比 1080p 手机还多。 */
      var dpr = g.devicePixelRatio || 1;
      var w = (g.screen && g.screen.width) || 0;
      var h = (g.screen && g.screen.height) || 0;
      var phys = w * h * dpr * dpr;
      if (phys > 2000000) low = true;

      /* 核心数偏少 / 内存偏小：这两个 API 有的浏览器不给，拿不到就跳过 */
      var cores = g.navigator && g.navigator.hardwareConcurrency;
      if (cores && cores <= 4) low = true;
      var mem = g.navigator && g.navigator.deviceMemory;
      if (mem && mem <= 3) low = true;

      /* 系统层面要求减少动画：直接按最低档走 */
      if (g.matchMedia && g.matchMedia('(prefers-reduced-motion: reduce)').matches) low = true;
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

  function apply() {
    var m = mode();
    var low = m === 'low' || (m === 'auto' && (autoLow() || guessLow()));
    var root = document.documentElement;
    root.classList.toggle('perf-low', low);
    /* 顺手把选择广播出去，设置页/别的脚本想知道当前档位时读这个属性即可 */
    root.setAttribute('data-perf', low ? 'low' : 'high');
    return low;
  }

  /* 暴露给设置页用 */
  var Perf = {
    mode: mode,
    isLow: function () { return document.documentElement.classList.contains('perf-low'); },
    /* 设置页切换：auto / high / low */
    set: function (m) {
      try {
        if (m === 'high' || m === 'low') g.localStorage.setItem(KEY, m);
        else g.localStorage.removeItem(KEY);
      } catch (e) {}
      return apply();
    },
    /* 实测帧率。只在「自动」档下改结论，且一旦测出低帧就永久记住，
       避免每次启动都要先卡 3 秒才降级。 */
    measure: function (ms, threshold) {
      if (mode() !== 'auto') return;
      ms = ms || 3000;
      threshold = threshold || 45;
      var frames = 0, start = 0, done = false;
      function tick(ts) {
        if (done) return;
        if (!start) start = ts;
        frames++;
        if (ts - start < ms) { g.requestAnimationFrame(tick); return; }
        done = true;
        var fps = frames / ((ts - start) / 1000);
        /* 页面在后台时 rAF 会被节流到 1Hz 甚至停掉，那种情况不能当依据 */
        if (document.hidden) return;
        if (fps < threshold && !autoLow()) {
          try { g.localStorage.setItem(KEY_AUTO, '1'); } catch (e) {}
          apply();
          /* 告诉用户发生了什么，而不是让它悄悄地变丑 */
          if (g.RippleApp && typeof g.RippleApp.toast === 'function') {
            try {
              g.RippleApp.toast('已自动降低画面效果', '实测 ' + Math.round(fps) + ' 帧，可在「我的 → 性能模式」里改回高画质', 'info');
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
