/*
 * app/js/i18n.js + app/js/lang/en.js 的单元测试。
 *
 * 为什么必须测这两件事：
 *   ① 词典缺条目的后果是**静默回落中文** —— 界面看起来「基本是英文」，
 *      只有那几条还是中文，而且没人会一条条去数 668 个界面文案。
 *      这类问题只能靠机器比对「源码里出现的所有中文串」与「词典里的键」。
 *   ② 翻译引擎的 bug 更难发现：翻串了、翻重了、切回中文回不去，
 *      表现都是「某处文字不对」，从界面上根本定位不到引擎。
 *
 * 这里不启动浏览器，用一个最小的 document 替身喂给 i18n.js。
 * 只测三样东西：
 *   · 引擎本身（精确命中 / 插值 / 片段拼接 / 中英往返）
 *   · 词典完整性（源码里每个中文 UI 串都在词典里）
 *   · 词典自洽（没有空值、没有键值相同却声称翻译了的条目）
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/* ---------------------------------------------------------- 加载引擎 */

/**
 * 造一个够用的 document 替身。
 * i18n.js 只用它做三件事：判断 body 是否存在、给根元素挂 class/属性、读 title。
 * 真正的 DOM 遍历在测试里不跑（没有真实节点），测的是纯函数部分。
 */
function fakeDocument() {
  const html = {
    _classes: new Set(),
    classList: {
      toggle(name, on) {
        if (on) html._classes.add(name); else html._classes.delete(name);
      },
      contains(name) { return html._classes.has(name); },
    },
    _attrs: {},
    setAttribute(k, v) { html._attrs[k] = v; },
    getAttribute(k) { return html._attrs[k]; },
  };
  return {
    body: null,                       // 让 boot 走「等 DOMContentLoaded」分支（什么也不做）
    documentElement: html,
    title: 'Ripple 涟漪',
    addEventListener() {},
  };
}

function loadEngine() {
  const src = fs.readFileSync(path.join(ROOT, 'app', 'js', 'i18n.js'), 'utf8');
  const win = {};
  win.window = win;
  win.document = fakeDocument();
  win.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
  win.MutationObserver = undefined;    // 引擎要能容忍没有 MutationObserver 的环境
  win.CustomEvent = function () {};
  win.dispatchEvent = function () {};
  /* 用 Function 而不是 vm：i18n.js 是 IIFE，只需要一个 window 参数 */
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'localStorage', 'MutationObserver', 'CustomEvent', 'dispatchEvent', src)(
    win, win.document, win.localStorage, win.MutationObserver, win.CustomEvent, win.dispatchEvent);
  return win;
}

function loadLang(win) {
  const src = fs.readFileSync(path.join(ROOT, 'app', 'js', 'lang', 'en.js'), 'utf8');
  // eslint-disable-next-line no-new-func
  new Function('window', src)(win);
  return win.I18n;
}

function boot() {
  const win = loadEngine();
  const I = loadLang(win);
  return I;
}

/* ---------------------------------------------------------- 引擎行为 */

test('中文态：T() 原样返回，不做任何替换', () => {
  const I = boot();
  assert.equal(I.lang, 'zh');
  assert.equal(I.T('发现'), '发现');
  assert.equal(I.T('界面语言'), '界面语言');
});

test('英文态：精确命中词典', () => {
  const I = boot();
  I.setLang('en', true);
  assert.equal(I.T('发现'), 'Discover');
  assert.equal(I.T('检查更新'), 'Check for updates');
});

test('英文态：没有译文的串原样返回（不允许变成空串）', () => {
  const I = boot();
  I.setLang('en', true);
  const unknown = '这条一定不在词典里';
  assert.equal(I.T(unknown), unknown);
  assert.ok(I.T(unknown).length > 0, '回落必须是原文，不能是空串');
});

test('插值：{name} 被替换，缺失的变量原样保留', () => {
  const I = boot();
  I.setLang('en', true);
  assert.equal(I.T('{name} · {n} 首', { name: 'Jay', n: 12 }), 'Jay · 12 songs');
  /* 少传一个变量时不能变成 "undefined"，要把占位符留着 */
  assert.equal(I.T('{name} · {n} 首', { n: 3 }), '{name} · 3 songs');
});

test('插值：中文态同样生效（不必为中文写第二条路径）', () => {
  const I = boot();
  assert.equal(I.T('{name} · {n} 首', { name: '周杰伦', n: 12 }), '周杰伦 · 12 首');
});

test('片段拼接：数量 + 量词这类拼出来的串能被翻译', () => {
  const I = boot();
  I.setLang('en', true);
  /* 源码里是 `n + ' 首'` / `n + ' 分钟'` 这样拼的，整串在词典里没有 */
  assert.equal(I.T('30 分钟'), '30 min');
  assert.equal(I.T('12 首'), '12 songs');
});

test('片段拼接优先匹配更长的片段', () => {
  const I = boot();
  I.setLang('en', true);
  /*
   * ' 首' 和 ' 首本机文件' 都以「首」结尾。
   * 如果短的先命中，'12 首本机文件' 会被拆成 '12 songs本机文件' ——
   * 这正是必须「长的先试」的原因。
   */
  assert.equal(I.T('12 首本机文件'), '12 local files');
});

test('切回中文：词典里翻过的串必须完全回到原文', () => {
  const I = boot();
  I.setLang('en', true);
  assert.equal(I.T('发现'), 'Discover');
  I.setLang('zh', true);
  assert.equal(I.T('发现'), '发现', '切回中文不能留下英文，也不能多出空格');
});

test('setLang 拒绝没有词典的语言 code', () => {
  const I = boot();
  const got = I.setLang('klingon', true);
  assert.equal(got, 'zh', '未知语言必须回落中文');
  assert.equal(I.has('klingon'), false);
});

test('list() 至少包含 zh 与 en，且 zh 排第一', () => {
  const I = boot();
  const list = I.list().map((x) => x.code);
  assert.equal(list[0], 'zh');
  assert.ok(list.includes('en'));
});

test('register() 能加第三门语言，且立刻可切换', () => {
  const I = boot();
  /*
   * 用户明确要求「后续可增加」。这里真的加一门假语言验证通路 ——
   * 如果引擎有硬编码 'en' 的地方，这条会红。
   */
  I.register('xx', 'Testish', { '发现': 'Discoverage', ' 首': ' toons' });
  assert.equal(I.setLang('xx', true), 'xx');
  assert.equal(I.T('发现'), 'Discoverage');
  assert.equal(I.T('5 首'), '5 toons');
  I.setLang('zh', true);
});

/* ---------------------------------------------------------- 词典完整性 */

/**
 * 从源码里抽「所有可能是界面文案的中文字面量」。
 *
 * 这套抽取规则必须与当初生成 keys.txt 时用的**同一套**，否则
 * 「缺条目」的结论就不可信。三条排除：
 *   · 注释行（以 * / // / /* 开头的）
 *   · 日志调用（Log.* / console.*）—— 这些是给开发者看的
 *   · 带 ${} 的模板串（单独用另一套清单覆盖）
 */
function extractUiStrings() {
  const CJK = /[\u4e00-\u9fff]/;
  const STR = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
  const SKIP = /(Log\.\w+|console\.\w+|LogBridge)\s*\(/;
  const out = new Set();
  const dyn = new Set();

  const files = [
    'app/js/app.js', 'app/js/store.js', 'app/js/player.js', 'app/js/netease.js',
    'app/js/log.js', 'app/js/perf.js', 'app/js/qrcode.js', 'app/js/lrc.js',
  ];
  /*
   * 显式包了 TT('…') 的模板串单独收集。
   *
   * 为什么不再用「带 ${} 的整串」那种抽法：
   *   接线之后那些串长这样 ——  TT('{name} · {n} 首', { name: … })
   *   整串里既有插值又有我们自己的函数调用，把它们当成「词典里该有的键」
   *   是错的（键是 '{name} · {n} 首'，不是整行模板）。
   *   这里只取 TT 的**第一个字符串实参**，那才是真正的词条。
   */
  const TT_RE = /\bTT\(\s*(['"])((?:[^'\\\n]|\\.)*)\1/g;
  const TT_HTML_RE = /TT\(\s*(['"])((?:[^'\\\n]|\\.)*)\1/g;

  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const lines = src.split('\n');
    for (const line of lines) {
      const t = line.trim();
      if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*') || t.startsWith('*/')) continue;
      TT_RE.lastIndex = 0;
      let tm;
      while ((tm = TT_RE.exec(line)) !== null) {
        const body = tm[2].replace(/\\'/g, "'");
        if (CJK.test(body)) dyn.add(body);
      }
      STR.lastIndex = 0;
      let m;
      while ((m = STR.exec(line)) !== null) {
        const body = m[0].slice(1, -1);
        if (!CJK.test(body)) continue;
        if (SKIP.test(line.slice(0, m.index).slice(-40))) continue;
        /* 带 ${} 的串不可能是词典里的键，跳过（它们内部的 TT 实参上面已经收过） */
        if (body.includes('${')) continue;
        out.add(body.replace(/\\'/g, "'").replace(/\\"/g, '"'));
      }
    }
  }

  /* index.html 的静态文案 */
  let html = fs.readFileSync(path.join(ROOT, 'app', 'index.html'), 'utf8');
  html = html.replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<symbol[\s\S]*?<\/symbol>/g, '');
  for (const m of html.matchAll(/>([^<>]+)</g)) {
    const s = m[1].replace(/\s+/g, ' ').trim();
    if (s && CJK.test(s)) out.add(s);
  }
  for (const m of html.matchAll(/(aria-label|title|placeholder|alt|content)="([^"]*)"/g)) {
    const s = m[2].trim();
    if (s && CJK.test(s)) out.add(s);
  }
  return { static: out, dyn };
}

test('词典覆盖源码里所有中文界面文案（缺一条就会静默回落中文）', () => {
  const I = boot();
  const dict = I.dict('en');
  const { static: statics, dyn } = extractUiStrings();
  const missing = [];
  for (const k of statics) if (!(k in dict)) missing.push(k);
  for (const k of dyn) if (!(k in dict)) missing.push('[dyn] ' + k);

  assert.deepEqual(missing, [],
    `以下 ${missing.length} 条没有英文译文：\n` + missing.slice(0, 40).join('\n'));
});

test('词典里没有空译文（空串会渲染成空白，比没翻译更糟）', () => {
  const dict = boot().dict('en');
  const empty = Object.keys(dict).filter((k) => !String(dict[k] || '').trim());
  assert.deepEqual(empty, [], '这些键的译文是空的：' + empty.join(', '));
});

/*
 * 这些条目的值就该等于键（或者就该保留中文），不算「没翻」：
 *   · 语言自名：中文在当前语言里就该显示「中文」
 *   · 艺人名 / 曲风名：周杰伦、陈粒、草东没有派对是搜索热词里的专有名词，
 *     译成 Jay Chou 反而让用户搜不到；「钢琴」作为曲风标签在音乐 App 里
 *     通常也保留（Piano 也行，但这条不是错误，只是风格选择）
 *
 * ⚠️ 允许名单要写死具体条目，不要写成「含人名就不查」那种模糊规则 ——
 * 模糊规则会连真正漏翻的条目一起放过。
 */
const SAME_AS_KEY_OK = new Set([
  '中文', '周杰伦', '草东没有派对', '陈粒', '钢琴',
]);

test('词典里没有「键值完全相同且含中文」的条目', () => {
  const dict = boot().dict('en');
  /*
   * 值等于键、且键里还有中文 = 那条其实没翻。
   * 允许例外：语言名（English / 中文）这类本来就是自名的词，
   * 以及纯符号串 —— 所以只挑「含中文且长度 > 1」的。
   */
  const bad = Object.keys(dict).filter((k) =>
    dict[k] === k && /[\u4e00-\u9fff]/.test(k) && k.trim().length > 1
    && !SAME_AS_KEY_OK.has(k));
  assert.deepEqual(bad, [], '这些条目看起来没有真正翻译：' + bad.slice(0, 20).join(' | '));
});

test('含 HTML 标签的条目：译文里的标签与原文一致', () => {
  const dict = boot().dict('en');
  /*
   * 标签个数对不上 = 译文里少写了闭合标签，会把后面的布局吞掉。
   * 只比较「标签名 + 出现次数」，不管属性顺序和 class 名 ——
   * 翻译时把 class 加个引号风格改掉是无害的。
   */
  const tagRe = /<\/?([a-zA-Z][\w-]*)/g;
  const bad = [];
  for (const k of Object.keys(dict)) {
    if (!k.includes('<')) continue;
    const a = (k.match(tagRe) || []).map((x) => x.toLowerCase()).sort();
    const b = (String(dict[k]).match(tagRe) || []).map((x) => x.toLowerCase()).sort();
    if (a.join(',') !== b.join(',')) bad.push(k.slice(0, 60));
  }
  assert.deepEqual(bad, [], '这些条目的 HTML 结构与原文不一致：' + bad.join(' | '));
});

/* ---------------------------------------------------------- 与 store 的白名单一致 */

test('store.js 的 ENUMS.lang 与内置语言列表一致', () => {
  const I = boot();
  const store = fs.readFileSync(path.join(ROOT, 'app', 'js', 'store.js'), 'utf8');
  const m = store.match(/lang:\s*\[([^\]]*)\]/);
  assert.ok(m, 'store.js 里找不到 lang 白名单');
  const allowed = m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  const builtin = I.list().map((x) => x.code);
  /*
   * 两边必须相等。只在内置那边多一门语言 = 用户能选但存档会被丢；
   * 只在白名单那边多一个 code = 界面上选了没反应。
   * 这条是「同一份名单抄成两份」那个老毛病的机器防护。
   */
  assert.deepEqual(allowed.slice().sort(), builtin.slice().sort(),
    'store.js 的 ENUMS.lang 与 I18n.list() 不一致');
});
