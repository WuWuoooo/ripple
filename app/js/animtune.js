/*
 * Ripple · 动画调参器（内置，临时工具）
 *
 * 用途：主人自己调歌词展开/收回的时长与缓动，调好后导出参数发给软软。
 * 特点：
 *   · 曲线是「任意多点折线」，不是四次贝塞尔 —— 直接用 CSS 的 linear() 表达，
 *     Chrome 113+ 支持，安卓 14/15 的 WebView 都够。
 *   · 图上拖动点即可改形状；双击空白处加点；点选中的点可以删除。
 *   · 同时能调「基准时长」和「速度倍率」（实际时长 = 基准 ÷ 速度）。
 *
 * 打开方式：地址后加 #animtune，或长按「设置 → Ripple 涟漪」那一行。
 * 移除方式：删掉本文件、index.html 里的 <script>、以及 app.js 里那一行 hook。
 */
(function (g) {
  'use strict';
  var KEY = 'ripple.anim.v1';
  /**
   * 把三次贝塞尔采样成多点折线。
   * 这样默认值就是主人此前调好的 cubic-bezier(.85,.53,.31,.02) 的近似，
   * 同时折线上的每个点都能直接拖 —— 上一版默认只有 [[0,0],[1,1]] 两个端点，
   * 又都压在图形最角落，手机上手根本点不中，看起来就是「拖不了」。
   */
  function sampleBezier(p1x, p1y, p2x, p2y, n) {
    var out = [];
    for (var i = 0; i <= n; i++) {
      var t = i / n, u = 1 - t;
      var x = 3 * p1x * t * u * u + 3 * p2x * t * t * u + t * t * t;
      var y = 3 * p1y * t * u * u + 3 * p2y * t * t * u + t * t * t;
      out.push([+Math.max(0, Math.min(1, x)).toFixed(3), +Math.max(0, Math.min(1, y)).toFixed(3)]);
    }
    out[0][0] = 0; out[out.length - 1][0] = 1;
    return out;
  }
  /*
   * 主人 2026-11-15 手绘选定的形状：前段几乎贴平，中后段加速冲上去（ease-in）。
   * 直接写成多点折线，比硬凑三次贝塞尔更贴，也方便主人在调参器里继续拖。
   */
  var REV = 4;   // 默认形状换了就 +1，老存档自动迁移
  var DEF = { base: 0.3, speed: 1, points: [[0.0,0.0],[0.062,0.0099],[0.125,0.021],[0.188,0.0335],[0.25,0.0476],[0.312,0.0638],[0.375,0.0826],[0.438,0.1045],[0.5,0.1304],[0.562,0.1617],[0.625,0.2],[0.688,0.2481],[0.75,0.3103],[0.812,0.3939],[0.875,0.5122],[0.938,0.6923],[1.0,1.0]] };
  var state = null;

  function load() {
    try {
      var o = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (o && typeof o.base === 'number' && Array.isArray(o.points) && o.points.length > 1) {
        var pts = o.points.map(function (p) { return [+p[0], +p[1]]; });
        /* 存档形状版本对不上（或旧版只存了两个端点）就用新的默认形状，
           但保留主人调好的时长与倍率 */
        if (o.rev !== REV || pts.length < 3) pts = DEF.points.map(function (q) { return [q[0], q[1]]; });
        return { base: o.base, speed: +o.speed || 1, points: pts, rev: REV };
      }
    } catch (e) {}
    return JSON.parse(JSON.stringify(DEF));
  }
  function save() { state.rev = REV; try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {} }

  /* CSS linear() 用不了时退回三次贝塞尔 */
  function hasLinear() {
    try { return !!(g.CSS && CSS.supports && CSS.supports('transition-timing-function', 'linear(0,1)')); }
    catch (e) { return false; }
  }

  function normalize(pts) {
    var a = pts.map(function (p) { return [Math.max(0, Math.min(1, +p[0])), Math.max(0, Math.min(1, +p[1]))]; });
    a.sort(function (p, q) { return p[0] - q[0]; });
    a[0] = [0, a[0][1]];
    a[a.length - 1] = [1, a[a.length - 1][1]];
    return a;
  }

  function easeString() {
    var pts = normalize(state.points);
    if (!hasLinear()) {
      // 退化：取两端切线做一条贝塞尔，至少形状接近
      var p1y = pts.length > 1 ? pts[1][1] : 0.5;
      var p2y = pts.length > 1 ? pts[pts.length - 2][1] : 0.5;
      return 'cubic-bezier(0.25,' + p1y.toFixed(2) + ',0.75,' + p2y.toFixed(2) + ')';
    }
    var parts = pts.map(function (p, i) {
      var y = (+p[1]).toFixed(4).replace(/\.?0+$/, '') || '0';
      if (i === 0) return y;
      if (i === pts.length - 1) return y;
      return y + ' ' + (p[0] * 100).toFixed(2).replace(/\.?0+$/, '') + '%';
    });
    return 'linear(' + parts.join(', ') + ')';
  }

  /*
   * 这段动画（歌词展开 + 封面平移）主人要求不超过 0.3 秒，所以这里也夹一下。
   * 调参器仍然能显示 0.1~0.3 之间的值，超过就按 0.3 算。
   */
  function dur() { return Math.min(0.3, Math.max(0.05, state.base / (state.speed || 1))); }

  function applyVars(root) {
    var r = root || document.documentElement.style;
    r.setProperty('--dur-ani', dur().toFixed(2) + 's');
    r.setProperty('--ease-inout', easeString());
  }

  /* ---------- app.js 的 applyVars() 会覆盖，这里给它一个钩子 ---------- */
  g.RippleAnimTune = {
    override: function (r) { applyVars(r); },
    open: function () { build(); }
  };

  /* 首屏先应用一次（app.js 之后加载也会通过 hook 再应用） */
  state = load();
  if (document.documentElement) applyVars();

  /* ---------- 界面 ---------- */
  var STYLE = [
    '#atune{position:fixed;inset:0;z-index:300;background:rgba(8,8,12,.97);color:#fff;',
    'font-family:-apple-system,"Noto Sans SC",system-ui,sans-serif;display:flex;flex-direction:column;',
    'padding:calc(max(env(safe-area-inset-top), var(--safe-t, 0px)) + 10px) 16px ',
    'calc(max(env(safe-area-inset-bottom), var(--safe-b, 0px)) + 10px);}',
    '#atune .hd{display:flex;align-items:center;gap:8px;flex:none;padding-bottom:8px}',
    '#atune .hd b{flex:1;font-size:14px}',
    '#atune .hd button{font-size:11px;padding:7px 12px;border-radius:10px;',
    'border:1px solid rgba(255,255,255,.18);background:transparent;color:rgba(255,255,255,.7)}',
    '#atune .body{flex:1;min-height:0;overflow-y:auto}',
    '#atune .graph{width:100%;height:38vh;min-height:190px;background:rgba(255,255,255,.04);',
    'border:1px solid rgba(255,255,255,.12);border-radius:14px;touch-action:none;display:block}',
    '#atune .row{display:flex;align-items:center;gap:10px;padding:8px 0}',
    '#atune .row label{width:74px;font-size:11px;color:rgba(255,255,255,.62);flex:none}',
    '#atune .row input[type=range]{flex:1;accent-color:#7DE3D0}',
    '#atune .row .v{width:54px;text-align:right;font-size:11px;font-variant-numeric:tabular-nums}',
    '#atune .tip{font-size:10px;color:rgba(255,255,255,.36);line-height:1.7;padding:4px 0 8px}',
    '#atune .out{width:100%;min-height:78px;font-family:ui-monospace,monospace;font-size:10.5px;',
    'line-height:1.6;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.18);',
    'border-radius:10px;color:#fff;padding:10px;resize:vertical}',
    '#atune .acts{display:flex;gap:8px;padding:10px 0 0}',
    '#atune .acts button{flex:1;font-size:12px;padding:12px;border-radius:12px;',
    'border:1px solid rgba(255,255,255,.18);background:transparent;color:rgba(255,255,255,.72)}',
    '#atune .acts button.primary{background:#7DE3D0;color:#062018;border-color:transparent;font-weight:600}'
  ].join('');

  var el = null, svg = null, dragging = -1, sel = -1;

  function build() {
    if (el) { el.style.display = 'flex'; redraw(); return; }
    if (!document.getElementById('atune-style')) {
      var st = document.createElement('style');
      st.id = 'atune-style'; st.textContent = STYLE;
      document.head.appendChild(st);
    }
    el = document.createElement('div');
    el.id = 'atune';
    el.innerHTML =
      '<div class="hd"><b>动画调参</b>'
      + '<button id="at-play">播放</button>'
      + '<button id="at-close">关闭</button></div>'
      + '<div class="body">'
      + '<svg class="graph" id="at-graph" viewBox="0 0 100 100" preserveAspectRatio="none"></svg>'
      + '<div class="tip">线上拖动圆点改形状；<b>双击空白处加点</b>；点中圆点后按「删点」移除。'
      + '曲线是任意多点折线，走 CSS <code>linear()</code>。</div>'
      + '<div class="row"><label>基准时长</label><input id="at-base" type="range" min="0.1" max="1.5" step="0.01"><span class="v" id="at-base-v"></span></div>'
      + '<div class="row"><label>速度倍率</label><input id="at-speed" type="range" min="0.4" max="2.5" step="0.05"><span class="v" id="at-speed-v"></span></div>'
      + '<div class="row"><label>实际时长</label><span class="v" id="at-dur-v" style="width:auto;flex:1;text-align:left;color:#7DE3D0"></span></div>'
      + '<textarea class="out" id="at-out" readonly></textarea>'
      + '<div class="acts"><button id="at-copy" class="primary">复制参数</button>'
      + '<button id="at-add">加点</button><button id="at-del">删点</button>'
      + '<button id="at-reset">复位</button></div>'
      + '</div>';
    document.body.appendChild(el);
    svg = document.getElementById('at-graph');

    document.getElementById('at-close').onclick = function () { el.style.display = 'none'; };
    document.getElementById('at-play').onclick = function () {
      var np = document.getElementById('np');
      if (!np) return;
      if (np.classList.contains('expanded')) {
        if (g.__rippleCollapseLyric) g.__rippleCollapseLyric(); else np.classList.remove('expanded');
      } else {
        if (g.__rippleExpandLyric) g.__rippleExpandLyric(); else np.classList.add('expanded');
      }
    };
    document.getElementById('at-base').oninput = function (e) {
      state.base = +e.target.value; save(); refresh();
    };
    document.getElementById('at-speed').oninput = function (e) {
      state.speed = +e.target.value; save(); refresh();
    };
    document.getElementById('at-add').onclick = function () {
      /* 手机不触发 dblclick，所以加点必须有按钮；插在最大的空档中间 */
      var pts = normalize(state.points), gi = 0, gd = -1;
      for (var i = 0; i < pts.length - 1; i++) {
        var d = pts[i + 1][0] - pts[i][0];
        if (d > gd) { gd = d; gi = i; }
      }
      var a = pts[gi], b = pts[gi + 1];
      state.points.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
      state.points = normalize(state.points);
      sel = state.points.findIndex(function (p) { return p[0] === (a[0] + b[0]) / 2; });
      save(); refresh();
    };
    document.getElementById('at-del').onclick = function () {
      if (sel <= 0 || sel >= state.points.length - 1) return;
      state.points.splice(sel, 1); sel = -1; save(); refresh();
    };
    document.getElementById('at-reset').onclick = function () {
      state = JSON.parse(JSON.stringify(DEF)); save(); refresh();
    };
    document.getElementById('at-copy').onclick = function () {
      var t = document.getElementById('at-out').value;
      var b = document.getElementById('at-copy');
      var ok = function () { b.textContent = '已复制'; setTimeout(function () { b.textContent = '复制参数'; }, 1400); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(t).then(ok, fb);
      } else fb();
      function fb() {
        var ta = document.getElementById('at-out');
        ta.removeAttribute('readonly'); ta.select();
        try { document.execCommand('copy'); ok(); } catch (e) { b.textContent = '请长按选中'; }
        ta.setAttribute('readonly', '');
      }
    };

    ['pointerdown', 'touchstart', 'touchmove', 'click'].forEach(function (t) {
      el.addEventListener(t, function (e) { e.stopPropagation(); }, { passive: false });
    });
    bindGraph();
    refresh();
  }

  function toSvg(evt) {
    var r = svg.getBoundingClientRect();
    var x = (evt.clientX - r.left) / r.width * 100;
    var y = (evt.clientY - r.top) / r.height * 100;
    return [Math.max(0, Math.min(100, x)), Math.max(0, Math.min(100, y))];
  }

  function bindGraph() {
    svg.addEventListener('pointerdown', function (e) {
      var t = toSvg(e);
      // 命中最近的点？
      var best = -1, bd = 16;
      state.points.forEach(function (p, i) {
        var d = Math.hypot(p[0] * 100 - t[0], (1 - p[1]) * 100 - t[1]);
        if (d < bd) { bd = d; best = i; }
      });
      if (best >= 0) {
        dragging = best; sel = best;
        svg.setPointerCapture && svg.setPointerCapture(e.pointerId);
        redraw();
      } else {
        sel = -1; redraw();
      }
      e.preventDefault();
    });
    svg.addEventListener('pointermove', function (e) {
      if (dragging < 0) return;
      var t = toSvg(e);
      var i = dragging, pts = state.points;
      var y = 1 - t[1] / 100;
      if (i === 0 || i === pts.length - 1) {
        pts[i][1] = Math.max(0, Math.min(1, y));       // 端点只上下动
      } else {
        var lo = pts[i - 1][0] + 0.02, hi = pts[i + 1][0] - 0.02;
        pts[i][0] = Math.max(lo, Math.min(hi, t[0] / 100));
        pts[i][1] = Math.max(0, Math.min(1, y));
      }
      save(); refresh();
      e.preventDefault();
    });
    function up() { dragging = -1; }
    svg.addEventListener('pointerup', up);
    svg.addEventListener('pointercancel', up);
    // 双击加点
    svg.addEventListener('dblclick', function (e) {
      var t = toSvg(e);
      var x = t[0] / 100, y = 1 - t[1] / 100;
      if (x <= 0.02 || x >= 0.98) return;
      state.points.push([x, y]);
      state.points = normalize(state.points);
      save(); refresh();
      e.preventDefault();
    });
  }

  function redraw() {
    if (!svg) return;
    var pts = normalize(state.points);
    var poly = pts.map(function (p) { return (p[0] * 100).toFixed(2) + ',' + ((1 - p[1]) * 100).toFixed(2); }).join(' ');
    var circles = pts.map(function (p, i) {
      return '<circle cx="' + (p[0] * 100).toFixed(2) + '" cy="' + ((1 - p[1]) * 100).toFixed(2) + '" r="' + (i === sel ? 4.6 : 3.4) + '" fill="' + (i === sel ? '#fff' : '#7DE3D0') + '" stroke="#07070b" stroke-width="0.6"/>';
    }).join('');
    svg.innerHTML =
      '<line x1="0" y1="100" x2="100" y2="0" stroke="rgba(255,255,255,.12)" stroke-width="0.5" stroke-dasharray="2 2"/>'
      + '<polyline points="' + poly + '" fill="none" stroke="#7DE3D0" stroke-width="1.4" vector-effect="non-scaling-stroke"/>'
      + circles;
  }

  function refresh() {
    if (!el) return;
    var b = document.getElementById('at-base'), sp = document.getElementById('at-speed');
    if (b) b.value = state.base;
    if (sp) sp.value = state.speed;
    var bv = document.getElementById('at-base-v'), sv = document.getElementById('at-speed-v');
    if (bv) bv.textContent = state.base.toFixed(2) + 's';
    if (sv) sv.textContent = state.speed.toFixed(2) + '×';
    var dv = document.getElementById('at-dur-v');
    if (dv) dv.textContent = dur().toFixed(2) + 's';
    applyVars();
    redraw();
    var out = document.getElementById('at-out');
    if (out) {
      out.value = 'RIPPLE-ANIM v2 | base=' + state.base.toFixed(2)
        + ' | speed=' + state.speed.toFixed(2)
        + ' | dur=' + dur().toFixed(2)
        + ' | points=' + JSON.stringify(normalize(state.points).map(function (p) {
          return [+p[0].toFixed(3), +p[1].toFixed(3)];
        }))
        + ' | css=--dur-ani:' + dur().toFixed(2) + 's;--ease-ani:' + easeString();
    }
  }

  /* 打开入口：hash 或长按关于行 */
  function hookOpen() {
    if (location.hash === '#animtune') build();
    var row = document.getElementById('rowAbout');
    if (row) {
      var timer = null;
      row.addEventListener('pointerdown', function () {
        timer = setTimeout(build, 700);
      }, { passive: true });
      ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (t) {
        row.addEventListener(t, function () { clearTimeout(timer); }, { passive: true });
      });
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', hookOpen);
  } else hookOpen();
})(window);
