/* ============================================================
   Ripple · i18n.js
   界面多语言（中文 / English，可继续增加）
   ============================================================

   设计取向：**以中文原文为 key**，不发明 i18n 键名。

   为什么不走常见的 `t('settings.appearance.glass')` 那套：
     · 这个项目有 645 条界面文案、分散在 8600 行 app.js 与 890 行
       index.html 里，其中绝大多数是 `toast('已刷新', …)` 这种一次性字面量。
       改成键名意味着要动几百个调用点，每一处都是一次改错的机会，
       而改错的表现是「文案消失」或「键名露出来」，比不翻译更糟。
     · 以中文为 key 时，**没翻译的条目自动回落中文**，永远不会出现
       空字符串或者 `settings.appearance.glass` 这种裸键名给用户看。
     · 词条与代码同形，改代码时一眼能看出这句有没有译文。

   翻译的三条通路（缺一条就会漏）：
     ① 静态 HTML —— 页面加载时整棵 DOM 走一遍（index.html 里 190 条）
     ② 运行时插入的 DOM —— app.js 大量用 innerHTML 造面板/列表/toast，
        由 MutationObserver 接住（覆盖 500 多条字面量，无需改调用点）
     ③ 带插值的模板串 —— `${n}` 之类的动态文本无法做整串精确匹配，
        这些在源码里显式包一层 T('共 {n} 首', {n})（23 处）

   不做的事：
     · 不翻译用户在听的内容（歌名 / 艺人 / 专辑 / 歌词 / 评论）。
       这些是远程数据，词典里没有它们的词条，精确匹配天然不会命中；
       另外还显式跳过几个容器（见 SKIP_SEL），避免「正好叫『全部』的歌
       被译成 All」这种极小概率但很难解释的现象。
     · 不改 <symbol>/<svg> 内部：那里的 <text> 是图形的一部分。
   ============================================================ */
(function (g) {
  'use strict';

  var doc = g.document;

  /* ---------- 语言注册表 ---------- */

  /**
   * 词典：code → { 中文原文: 译文 }
   * 基础语言 zh 不存词典（恒等映射，直接返回原文）。
   */
  var DICT = {};
  /** 显示名：code → 该语言自己的写法（中文显示「中文」，英文显示 English） */
  var NAMES = {};
  /** 注册顺序 = 设置页按钮顺序；'zh' 永远排第一 */
  var ORDER = ['zh'];
  NAMES.zh = '中文';

  var CUR = 'zh';

  /** 环境里是否已经有一份 state（早于 store.js 加载时没有） */
  var STATE_KEY = 'ripple.state.v1';

  /* ---------- 不翻译的容器 ---------- */

  /**
   * 这些容器里装的是**远程数据**（歌名、歌词、评论、歌单名……），
   * 整棵子树跳过。用 id/class 精确列出而不是靠「看起来像不像」猜。
   *
   * 两条维护规则（都是踩过的坑）：
   *   ① 只写**真实存在**的选择器。之前这里挂着 #searchRes / #cmtList /
   *      #queList / #queueList 四个 id，而 index.html 里一个都没有 ——
   *      看着像有四道保护，实际是四道空气。写完必须回 index.html 核一遍。
   *   ② 优先枚举「一行 = 一条远程数据」的**整个容器**，而不是逐个字段。
   *      `.row`（曲库/搜索行）、`.qitem`（队列行）、`.plrow`（歌单行）都是这种
   *      容器：行内新增任何一个显示远程数据的元素，只要容器整行跳过就天然安全，
   *      不必再回来加一条规则。
   *
   * data-i18n-skip 是给以后的动态内容留的显式逃生口。
   */
  var SKIP_SEL = [
    '.lyric',            // 展开歌词（整篇 LRC，#npLyric）
    '.np-lyric',         // 收起态三行歌词（#npLyricMini）
    '#npTitle', '#npArtist', '#npMeta',          // 播放页歌名/艺人
    '.row', '.qitem', '.plrow',                  // 一行 = 一首远程歌 / 一个歌单
    '.r-tx', '.r-fmt', '.r-du',                  // 行内歌名/艺人/音质/时长（容器之外也兜一层）
    '.gcard', '.c-card', '.c-k',                 // 网格卡 / 首页卡片
    '#plTracks', '#npQueue',                     // 歌单曲目 / 播放队列
    '#cmtBody',                                  // 评论列表（真 id）
    '#searchBody',                               // 搜索结果
    '.cmt-body',
    '[data-i18n-skip]'
  ].join(',');

  /** 这些标签整体跳过（脚本/样式/图形） */
  var SKIP_TAG = {
    SCRIPT: 1, STYLE: 1, SYMBOL: 1, PATH: 1, TEXT: 1, TSPAN: 1,
    CODE: 1, PRE: 1, IFRAME: 1, NOSCRIPT: 1, TEMPLATE: 1
  };

  /** 需要翻译的属性（都是「会被人读到」的那些） */
  var ATTRS = ['aria-label', 'title', 'placeholder', 'alt'];

  /**
   * 这个节点是否落在「不翻译」的容器里（含自身）。
   *
   * 为什么必须抽成一个函数、并且**三条通路共用**：
   *   以前只有 walk()（innerHTML 插入）查了 SKIP_SEL，而运行时改 DOM 有三条
   *   通路 —— innerHTML 插入、textContent 赋值（→ characterData）、
   *   setAttribute（→ attributes）。后两条完全绕过剪枝，于是
   *   `$('#npTitle').textContent = t.title` 把歌名「全部」写进去之后，
   *   观察器接住 characterData 直接翻译，界面上歌名真的变成了 All。
   *   这正是文件头承诺「不翻译用户在听的内容」被打脸的地方。
   *
   * 实现上向上遍历祖先而不是只看自身：`#cmtBody` 里的 `.cmt` 子节点自己
   * 不命中任何 SKIP_SEL 规则，但它的祖先命中，所以必须往上找。
   */
  function inSkip(node) {
    var el = node;
    if (!el) return false;
    if (el.nodeType !== 1) el = el.parentElement;   // 文本节点/属性节点都从父元素起算
    while (el) {
      if (el.nodeType === 1) {
        if (SKIP_TAG[el.tagName]) return true;
        if (el.matches && el.matches(SKIP_SEL)) return true;
      }
      el = el.parentElement;
    }
    return false;
  }

  /* ---------- 含 HTML 的条目 → 内部文本段 ---------- */

  /**
   * 有些词条是一整段 HTML（`<div class="empty"><b>这里还没有音乐</b>…`）。
   *
   * 为什么光有整串不够：
   *   整串键只在「整段 HTML 被当成一个字符串去查词典」时才命中。
   *   而运行时那些 HTML 是 innerHTML 写进 DOM 的，浏览器会把它解析成
   *   一堆**文本节点**；翻译引擎看到的是「这里还没有音乐」这 6 个字，
   *   不是整段带标签的串 —— 于是整串键永远匹配不上，
   *   表现就是「空的曲库页还是中文，别的页面都变英文了」。
   *
   * 做法：把键和值都按标签切开，把对应位置的文本段配成新条目。
   * 切法必须一致，否则会错位（把「还没有评论」翻成别处的句子）。
   * 只在原词典没有该条目时补，不覆盖人工写的短词条。
   */
  function deriveHtmlSegments(code, dict) {
    var out = {};
    Object.keys(dict).forEach(function (k) { out[k] = dict[k]; });
    Object.keys(dict).forEach(function (k) {
      if (k.indexOf('<') < 0) return;
      var v = String(dict[k] == null ? '' : dict[k]);
      /* 按标签切成文本段；标签本身丢弃，剩下的非空段一一对应 */
      var ks = k.split(/<[^>]*>/).map(trimAll).filter(Boolean);
      var vs = v.split(/<[^>]*>/).map(trimAll).filter(Boolean);
      if (!ks.length || ks.length !== vs.length) return;   // 结构对不上：宁可不翻
      for (var i = 0; i < ks.length; i++) {
        if (!/[\u4e00-\u9fff]/.test(ks[i])) continue;
        if (has(out, ks[i])) continue;                      // 已有条目不动
        out[ks[i]] = vs[i];
      }
    });
    return out;
  }

  function trimAll(x) { return String(x).replace(/^\s+|\s+$/g, ''); }

  /* ---------- 工具 ---------- */

  function has(obj, k) { return Object.prototype.hasOwnProperty.call(obj, k); }

  /** 早于 store.js 时从存档里直接读语言 */
  function readLangFromStorage() {
    try {
      var raw = g.localStorage && g.localStorage.getItem(STATE_KEY);
      if (!raw) return 'zh';
      var st = JSON.parse(raw);
      var v = st && st.settings && st.settings.lang;
      return typeof v === 'string' && has(DICT, v) || v === 'zh' ? v : 'zh';
    } catch (e) { return 'zh'; }
  }

  /* ---------- 翻译 ---------- */

  /**
   * 翻译一个字符串。
   *
   * @param {string} s 中文原文
   * @param {object} [vars] 插值变量，替换 {name} 占位符
   * @returns {string} 译文；没有译文时原样返回（保证永远不出现空串）
   */
  function T(s, vars) {
    if (typeof s !== 'string' || !s) return s;
    var out = s;
    if (CUR !== 'zh') {
      var d = DICT[CUR];
      if (d && has(d, s)) out = d[s];
      /*
       * 整串没命中 → ① 按 ' · ' 切段逐段翻 → ② 两端片段。
       *
       * 这两级都放在 T() 里面而不是只放在文本节点通路里，是为了让**两条通路**
       * 都能用：'30 分钟' 这种拼接串既可能是 innerHTML 写进去的文本节点，
       * 也可能是显式 T(n + ' 分钟') 拼出来的，只覆盖一条就会有一半漏掉。
       *
       * 顺序不能反：先切段再片段。'主题 · 跟随系统' 两段都是完整的词条，
       * 切段能整段换成 'Theme · Follow system'；若先走片段，只会在两端
       * 找 ' 跟随系统' 这类片段，结果是半中半英。
       */
      else {
        var bySep = translateBySeparator(s);
        out = bySep !== s ? bySep : translateByFragment(s);
      }
    }
    if (vars) {
      /*
       * 插值放在翻译之后：词典里存的是带 {n} 的模板，
       * 这样同一个模板串可以被不同数量复用，不必为每种数量存一条。
       */
      out = out.replace(/\{(\w+)\}/g, function (m, k) {
        return has(vars, k) ? String(vars[k]) : m;
      });
    }
    return out;
  }

  /*
   * ---------- 分隔符切段 ----------
   *
   * 有一类拼接串是「完整词条 + ' · ' + 完整词条」：
   *   '主题 · 跟随系统'、'歌单 · 12'、'本机 · 3 个结果'、'精彩评论 · 5'
   * 每一段单独看都是词典里的键（或者能被片段匹配翻掉），但整串不是。
   *
   * 为什么片段匹配救不了它：片段规则要求**以非中文打头**（见
   * fragmentsFor 里那段注释，防「深」误伤「深夜」）。而这类串开头是中文，
   * 一个候选都进不去，整串原样返回 —— 英文界面里就露出这半截中文。
   *
   * 所以补这一级：按 ' · ' 切开，**逐段整串命中词典才替换**。
   * 判据刻意保守：
   *   · 只认 ' · '（带空格的间隔号）这一个分隔符，不去猜别的标点；
   *   · 段内必须有词典条目（或片段可翻），否则那段原样留着；
   *   · 全文一段都没换成 → 返回原串，让上层继续试片段匹配。
   * 这样最坏情况是「没翻」，不会出现「翻坏」。
   */
  var SEP = ' · ';

  function translateSegment(seg) {
    var d = DICT[CUR];
    if (!d) return seg;
    if (has(d, seg)) return d[seg];
    /* 段内也可能是「数字 + 量词」：'12' 翻不了，'3 个结果' 要能翻 */
    var frag = translateByFragment(seg);
    return frag;
  }

  function translateBySeparator(core) {
    if (CUR === 'zh') return core;
    if (!core || core.indexOf(SEP) < 0) return core;
    var parts = core.split(SEP);
    if (parts.length < 2) return core;
    var changed = false;
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var seg = parts[i];
      /* 首尾空白不属于词条，剥掉再查；查不到就原样放回 */
      var ws = splitWs(seg);
      var got = translateSegment(ws[1]);
      if (got !== ws[1]) {
        changed = true;
        out.push(ws[0] + got + ws[2]);
      } else {
        out.push(seg);
      }
    }
    return changed ? out.join(SEP) : core;
  }

  /*
   * ---------- 片段匹配 ----------
   *
   * 有些文案是**拼接**出来的：`sleepMin + ' 分钟'`、`n + ' 首'`、`' · 星期'`。
   * 它们在词典里只有那个片段有译文（「 分钟」→「 min」），
   * 整串「30 分钟」不可能整条命中。
   *
   * 只做「开头 / 结尾」两个位置的片段替换，不做中间替换：
   *   · 中文的修饰成分本来就在两端（数量 + 量词、时间 + 后缀）；
   *   · 中间替换容易误伤 —— 比如歌名恰好含「全部」两个字，
   *     中间替换会把它改成 "All"。两端匹配时这种情况几乎不会发生。
   *
   * 只考虑**含中文**、长度 ≥1 的键，避免把 "OK" 这类纯拉丁词条当片段用。
   */
  var FRAG_CACHE = {};     // lang -> { byFirst: {字符: [frags 长→短]}, byLast: {...} }

  function fragmentsFor(lang) {
    if (FRAG_CACHE[lang]) return FRAG_CACHE[lang];
    var d = DICT[lang] || {};
    var byFirst = {}, byLast = {};
    Object.keys(d).forEach(function (k) {
      if (!k || k.length > 12) return;              // 太长的不是片段，是整句
      if (!/[\u4e00-\u9fff]/.test(k)) return;      // 必须含中文
      /*
       * ⚠️ 片段必须**以非中文开头**（空格、标点）。
       *
       * 这一条是真机上抓到 bug 之后补的：词典里有单字条目
       * 「深」→「Dark」、「浅」→「Light」（主题分段控件那三个按钮），
       * 而 hero 的时段文案是「深夜很长，歌会一首接一首」。
       * 开头片段匹配一旦允许中文打头，「深」就把「深夜很长，」
       * 改成了「Dark夜很长，」—— 界面上真的出现了这行字。
       *
       * 以空格/标点开头的片段不会误伤：正文文本节点的首尾空白
       * 会被 splitWs 剥掉，所以「 首」这种片段不可能匹配到开头，
       * 只可能在结尾命中（那正是我们要的用法）。
       */
      if (/[\u4e00-\u9fff]/.test(k.charAt(0))) return;
      var f = k.charAt(0), l = k.charAt(k.length - 1);
      (byFirst[f] || (byFirst[f] = [])).push(k);
      (byLast[l] || (byLast[l] = [])).push(k);
    });
    /* 长的先试：' 首本机文件' 优先于 ' 首'，否则会被拆成两段 */
    var byLen = function (a, b) { return b.length - a.length; };
    Object.keys(byFirst).forEach(function (c) { byFirst[c].sort(byLen); });
    Object.keys(byLast).forEach(function (c) { byLast[c].sort(byLen); });
    FRAG_CACHE[lang] = { byFirst: byFirst, byLast: byLast };
    return FRAG_CACHE[lang];
  }

  /** 整串没命中时，试两端片段。返回替换后的串；没有可换的就原样返回 */
  function translateByFragment(core) {
    if (CUR === 'zh') return core;
    var d = DICT[CUR];
    if (!d) return core;
    var frags = fragmentsFor(CUR);
    var i, k;

    /* ① 结尾片段：'30 分钟' ← ' 分钟' */
    var lastCh = core.charAt(core.length - 1);
    var cands = frags.byLast[lastCh];
    if (cands) {
      for (i = 0; i < cands.length; i++) {
        k = cands[i];
        if (core.length > k.length && core.slice(-k.length) === k) {
          return core.slice(0, core.length - k.length) + d[k];
        }
      }
    }
    /* ② 开头片段：'，欢迎回来' ← 一般出现在拼接结果里，这里兜底 */
    var firstCh = core.charAt(0);
    cands = frags.byFirst[firstCh];
    if (cands) {
      for (i = 0; i < cands.length; i++) {
        k = cands[i];
        if (core.length > k.length && core.slice(0, k.length) === k) {
          return d[k] + core.slice(k.length);
        }
      }
    }
    return core;
  }

  /** 拆出首尾空白，只翻译中间 —— 缩进换行不能被吃掉 */
  function splitWs(txt) {
    var m = /^(\s*)([\s\S]*?)(\s*)$/.exec(txt);
    return m ? [m[1], m[2], m[3]] : ['', txt, ''];
  }

  /**
   * 翻译一个文本节点。
   *
   * 两个状态变量：
   *   · __i18nSrc  —— 这段文字的**原文**（中文）。切语言时靠它回到中文，
   *                   而不是反向查词典（反向会撞上一词多译）。
   *   · __i18nLast —— 我们上次写进 DOM 的值，用来认出「这条变更是我自己写的」。
   *
   * 源文本的刷新规则（修的是「记下就再也不变」那个 bug）：
   *   当前 DOM 值 == __i18nLast → 说明这是我们自己写的译文，原文另存，不动；
   *   当前 DOM 值 ≠ __i18nLast → 说明业务代码改了内容，那它**就是新原文**。
   * 以前写的是「只有 __i18nSrc 不是字符串才赋值」，一旦记下就冻住 ——
   * 于是中文态改过的文案切回英文时还是中文，英文态改过的文案会被翻回旧译文。
   *
   * 中文态也走这条路径，只是算出来的 next 就是原文本身，绝大多数情况下
   * `full !== raw` 不成立 → 不写 DOM。所以「中文态零副作用」是自然结果，
   * 不需要单独开一个 if 分支把它短路掉（短路掉反而会让源文本重新冻住）。
   */
  function translateTextNode(node) {
    var raw = node.nodeValue;
    if (!raw) return;
    var parts = splitWs(raw);
    var core = parts[1];
    if (!core) return;

    var mine = (typeof node.__i18nLast === 'string' && node.__i18nLast === raw);
    if (!mine || typeof node.__i18nSrc !== 'string') node.__i18nSrc = core;

    var next = CUR === 'zh' ? node.__i18nSrc : T(node.__i18nSrc);
    var full = parts[0] + next + parts[2];
    if (full !== raw) {
      node.__i18nLast = full;             // 标记「这是我们写的」，防止自激
      node.nodeValue = full;
    }
  }

  /**
   * 翻译一个属性。缓存/自激的规则与 translateTextNode 完全同构：
   *   __i18nAttr[name]     原文
   *   __i18nAttrLast[name] 我们上次写进去的值
   *
   * 修的原 bug：原文只在第一次缓存，且 attributes 通路没有自激判据 →
   * 业务 setAttribute('aria-label', '展开导航') 之后，引擎拿着旧原文
   * '收起导航' 翻出 'Collapse navigation' 又写回去，把新状态覆盖掉。
   * 屏幕阅读器于是永远读同一个错误状态（折叠按钮不管展开还是收起都读「收起」）。
   */
  function translateAttr(el, name) {
    var v = el.getAttribute(name);
    if (!v) return;
    var parts = splitWs(v);
    var core = parts[1];
    if (!core) return;
    if (!el.__i18nAttr) el.__i18nAttr = {};
    if (!el.__i18nAttrLast) el.__i18nAttrLast = {};

    var mine = has(el.__i18nAttrLast, name) && el.__i18nAttrLast[name] === v;
    if (!mine || !has(el.__i18nAttr, name)) el.__i18nAttr[name] = core;

    var src = el.__i18nAttr[name];
    var next = CUR === 'zh' ? src : T(src);
    var full = parts[0] + next + parts[2];
    if (full !== v) {
      el.__i18nAttrLast[name] = full;
      el.setAttribute(name, full);
    }
  }

  /**
   * 翻译一棵子树（含自身）。
   * 用递归而不是 TreeWalker：需要「遇到 SKIP_SEL 就整棵不进去」，
   * TreeWalker 的 filter 只能按节点拒绝，剪枝要额外判断祖先，反而更绕。
   *
   * @param {Node} node
   * @param {boolean} isRoot true = 这是遍历入口，需连**祖先**一起查跳过规则。
   *   为什么不一律用 inSkip：递归里父节点已经验过了，每个子节点再向上爬一遍
   *   就是 O(深度²)。入口要查祖先是因为 childList 通路会把「刚插进
   *   #cmtBody 的一个节点」直接传进来 —— 它自己是干净的，祖先才是脏的。
   */
  function walk(node, isRoot) {
    if (!node) return;
    if (node.nodeType === 3) { translateTextNode(node); return; }
    if (node.nodeType !== 1) return;

    if (isRoot ? inSkip(node) : (SKIP_TAG[node.tagName] ||
        (node.matches && node.matches(SKIP_SEL)))) return;

    for (var i = 0; i < ATTRS.length; i++) translateAttr(node, ATTRS[i]);

    /* 子节点可能在遍历中被替换（不会——这里只改 text 值），直接递归 */
    var kids = node.childNodes;
    for (var j = 0; j < kids.length; j++) walk(kids[j], false);
  }

  /** 整页走一遍（切语言时用）：先全部回到原文再按新语言翻，保证可逆 */
  function applyAll() {
    if (!doc || !doc.body) return;
    walk(doc.body, true);
    /*
     * 标题同一套源文本规则：页面切换（发现/曲库/我的）会在中文态改
     * document.title，若只记第一次的值，切英文后标题永远停在最初那一页。
     */
    if (doc.title) {
      var mineTitle = doc.__i18nTitleLast === doc.title;
      if (!mineTitle || typeof doc.__i18nTitle !== 'string') doc.__i18nTitle = doc.title;
      var wantTitle = CUR === 'zh' ? doc.__i18nTitle : T(doc.__i18nTitle);
      if (wantTitle !== doc.title) {
        doc.__i18nTitleLast = wantTitle;
        doc.title = wantTitle;
      }
    }
    var html = doc.documentElement;
    html.setAttribute('lang', CUR === 'zh' ? 'zh-CN' : CUR);
    /* CSS 钩子：英文排版要单独调字号/断词（见 base.css 的 html.lang-en 段） */
    html.classList.toggle('lang-en', CUR === 'en');
    html.setAttribute('data-lang', CUR);
  }

  /* ---------- MutationObserver：接住运行时插入的 DOM ---------- */

  var obs = null;
  var OBS_CFG = {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ATTRS.concat(['content'])
  };

  function onMutate(muts) {
    /*
     * 中文态也要处理，但只**记原文、不写 DOM**。
     *
     * 以前这里是 `if (CUR === 'zh') return;`，再配合 setLang 里中文态
     * stopObserve() —— 中文态下业务代码改的文案永远进不了 __i18nSrc。
     * 于是出现了「英文态打开评论 → 切回中文 → 换一首歌（评论数更新为中文）
     * → 再切英文，评论数还是中文」这种夹生状态：源文本是旧的，翻出来当然不对。
     *
     * 代价要说清楚：中文态每一条文本变更都会多一次回调。所以这条分支里
     * 只做「splitWs + 三行赋值」，不查词典、不碰 DOM、不建缓存 ——
     * 比英文态轻得多，且不会引发新的 mutation（不写 DOM 就不会自激）。
     */
    var zh = (CUR === 'zh');
    /*
     * 先断开：我们接下来会写 DOM，写出来的变更又会触发回调（自激）。
     * disconnect() 会清空记录队列，之后再 observe() 就只收到新变更。
     */
    if (obs) obs.disconnect();
    try {
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (m.type === 'characterData') {
          var t = m.target;
          /* 自己写的那一次：值等于我们上次写入的结果 → 跳过 */
          if (t.__i18nLast === t.nodeValue) continue;
          /* 远程数据容器（歌名/歌词/评论）：一个字节都不要动 */
          if (inSkip(t)) continue;
          t.__i18nSrc = null;          // 内容被业务代码改过，重新取原文
          if (zh) {
            /* 只刷新源文本，算出来的抄写值等于原值 → translateTextNode 不写 DOM */
            refreshSrcOnly(t);
          } else {
            translateTextNode(t);
          }
        } else if (m.type === 'childList') {
          for (var a = 0; a < m.addedNodes.length; a++) walk(m.addedNodes[a], true);
        } else if (m.type === 'attributes') {
          var el = m.target, nm = m.attributeName;
          /* 自己写的那一次：属性值等于我们上次写入的结果 → 跳过（自激保护） */
          if (el.__i18nAttrLast && el.__i18nAttrLast[nm] === el.getAttribute(nm)) continue;
          if (inSkip(el)) continue;
          if (zh) refreshAttrSrcOnly(el, nm);
          else translateAttr(el, nm);
        }
      }
    } catch (e) {
      if (g.Log) { try { g.Log.err('I18N', e, 'observer'); } catch (e2) {} }
    }
    /* 把这次自己写出的变更记录丢掉，再从干净的队列继续观察 */
    if (obs) {
      obs.takeRecords();
      if (doc && doc.body) obs.observe(doc.body, OBS_CFG);
    }
  }

  /**
   * 中文态专用：只把当前 DOM 文本记成原文，不写回 DOM。
   *
   * 与 translateTextNode 的区别仅在于「不做翻译、不赋值」。
   * 单独一个函数而不是给 translateTextNode 加参数，是为了让英文态那条
   * 性能敏感路径保持原样（多一个布尔判断都不加）。
   */
  function refreshSrcOnly(node) {
    var raw = node.nodeValue;
    if (!raw) return;
    var core = splitWs(raw)[1];
    if (!core) return;
    node.__i18nSrc = core;
    /* 中文态的 DOM 值就是原文，让 __i18nLast 跟着走，别留下旧译文当判据 */
    if (node.__i18nLast !== raw) node.__i18nLast = raw;
  }

  /** 中文态专用：刷新属性的原文缓存，不写回属性 */
  function refreshAttrSrcOnly(el, name) {
    var v = el.getAttribute(name);
    if (!v) return;
    var core = splitWs(v)[1];
    if (!core) return;
    if (!el.__i18nAttr) el.__i18nAttr = {};
    el.__i18nAttr[name] = core;
    if (!el.__i18nAttrLast) el.__i18nAttrLast = {};
    el.__i18nAttrLast[name] = v;
  }

  function startObserve() {
    if (obs || !doc || !doc.body) return;
    if (typeof g.MutationObserver !== 'function') return;   // 极老环境：只翻静态部分
    obs = new g.MutationObserver(onMutate);
    obs.observe(doc.body, OBS_CFG);
  }

  function stopObserve() {
    if (!obs) return;
    obs.disconnect();
    obs = null;
  }

  /* ---------- 对外 API ---------- */

  var I18n = {
    /** 当前语言 code */
    get lang() { return CUR; },

    /** 已注册的语言列表：[{code, name}]，顺序即设置页按钮顺序 */
    list: function () {
      return ORDER.map(function (c) { return { code: c, name: NAMES[c] || c }; });
    },

    has: function (code) { return code === 'zh' || has(DICT, code); },

    /**
     * 注册一门语言。
     *
     * @param {string} code 'en'
     * @param {string} name 该语言自己的写法（'English'）
     * @param {object} dict { 中文原文: 译文 }
     *
     * 以后加第三门语言：新建 js/lang/xx.js 调本函数，
     * 再在 index.html 里加一个 <script>。其余代码零改动。
     */
    register: function (code, name, dict) {
      if (!code) return;
      if (!has(DICT, code)) ORDER.push(code);
      DICT[code] = deriveHtmlSegments(code, dict || {});
      /* 词典换了，片段索引必须作废 —— 否则语言包晚于首次使用加载时，
         片段匹配还在用空表，拼接文案永远翻不出来。 */
      FRAG_CACHE[code] = null;
      NAMES[code] = name || code;
      /* 语言包可能在页面初始化之后才加载（动态 load），此时要补翻一次 */
      if (code === CUR) applyAll();
    },

    T: T,

    /** 按当前语言挑一个字符串：pick('待翻译','English') —— 给极少数两面文案用 */
    pick: function (zh, en) { return CUR === 'zh' ? zh : (en == null ? zh : en); },

    /**
     * 切换语言。
     * @param {string} code
     * @param {boolean} [silent] true = 不写存档（仅预览/初始化用）
     */
    setLang: function (code, silent) {
      if (!I18n.has(code)) code = 'zh';
      var changed = code !== CUR;
      CUR = code;
      /*
       * 观察器在**两种语言下都保持开启**。
       *
       * 中文态曾经是关掉的（“不翻译就不需要观察”），代价是中文态下业务改的
       * 文案永远进不了源文本缓存 —— 见 onMutate 顶部的长注释。
       * 现在中文态只做「记原文」，成本是每条文本变更一次回调，
       * 不做词典查找、不写 DOM，不会再触发自身。
       */
      startObserve();
      applyAll();
      if (!silent) {
        /* Store 已经加载 → 走正常的设置写入（会落盘、会触发 onSettingChange） */
        try {
          if (g.Store && g.Store.state && g.Store.state.settings) {
            g.Store.state.settings.lang = code;
            g.Store.save();
          }
        } catch (e) {}
      }
      if (changed) {
        try {
          g.dispatchEvent(new g.CustomEvent('ripple:lang', { detail: { lang: code } }));
        } catch (e) {}
      }
      return code;
    },

    /** 某个中文原文在当前语言下有没有译文（自检/测试用） */
    missing: function () {
      var d = DICT[CUR];
      return !d;
    },

    /** 词典本体（只读，给测试用） */
    dict: function (code) { return code === 'zh' ? null : (DICT[code] || null); },

    /** 重新整页翻译一次（主题切换等会重建 DOM 的场景可以手动调） */
    refresh: applyAll
  };

  g.I18n = I18n;

  /* ---------- 启动 ---------- */

  /*
   * 这一段必须在**同步执行期**跑完：i18n.js 的 <script> 位于 body 末尾，
   * 此时上方 DOM 已解析完、首帧还没绘制。所以在这里翻译 = 用户看不到中文闪一下。
   * 若放到 DOMContentLoaded 里，英文用户会先看到一帧中文。
   */
  function boot() {
    var want = readLangFromStorage();
    if (want !== 'zh' && !has(DICT, want)) want = 'zh';
    CUR = want;
    /* 中文态也观察（只记原文不写 DOM），理由见 onMutate 顶部 */
    startObserve();
    applyAll();
  }

  if (doc) {
    if (doc.body) boot();
    /* 有 body 就立刻翻译（正常情况）；DOM 还没解析完就等 DOMContentLoaded。
       addEventListener 的存在性要显式判断 —— 单测里喂进来的 document 替身
       没有它，不判断的话 require 就直接抛异常了。 */
    else if (typeof doc.addEventListener === 'function') {
      doc.addEventListener('DOMContentLoaded', boot, { once: true });
    }
  }
})(window);
