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

/* ---------------------------------------------------------- 原生层文案（1.3.7） */

/**
 * 原生层（Java / Rust）里**会被用户看到**的中文字面量，必须包在
 * `L10n.t(zh, en)` / `i18n::t(zh, en)` 里。
 *
 * 为什么单列一节：
 *   1.3.6 之前 i18n 的覆盖面只算「前端 + index.html」，原生层那批字符串
 *   完全不在任何断言里 —— 于是 `NeteaseClient` 的「歌曲 id 不合法」和
 *   `netease.rs` 的整整十处错误串可以长期漏翻，而测试永远全绿。
 *   判据本身没错，错的是**取样范围**。
 *
 * 判据怎么定（这决定了它是不是一条好测试）：
 *   不是「文件里有没有中文」（注释、日志里全是中文，会淹没结论），
 *   而是「这一行会不会流到用户眼前」。三条可机械判定的排除：
 *     · 注释行（* / // / /*）
 *     · 日志调用（LogBridge.add / Log.* / eprintln!）
 *     · 纯内部异常（FileNotFoundException 之类，只在日志里出现）
 *   留下来的就是「会被 toast / 弹窗 / 崩溃页显示」的那批。
 */
/*
 * 原生层的取样范围（审查 1.3.8 · M-19）。
 *
 * 这里以前是**手写清单**（只有 NeteaseClient.java 和 HttpBridge.java）。
 * 后果：1.3.8 新增的 LyricOverlay.java（11 处 L10n.t 的原生 UI）完全不在
 * 检查范围内 —— 它当前是干净的，但那是**运气，不是护栏**。
 * 下一个往原生层加用户可见文案的人不会被任何测试拦住。
 *
 * 改成扫目录自动发现：*.java 里只要出现中文，就必须被这条规则看到。
 * 手写清单的毛病就是「加文件时忘了加」，而目录扫描根本不存在「忘」这件事。
 */
const NATIVE_I18N_DIR = 'android/app/src/main/java/com/ripple/app';
const NATIVE_I18N_FILES = fs
  .readdirSync(path.join(ROOT, NATIVE_I18N_DIR))
  .filter((f) => f.endsWith('.java'))
  .sort()
  .map((f) => NATIVE_I18N_DIR + '/' + f);

/** 抽出一个文件里「用户可见但没包 L10n.t / i18n::t」的中文字面量 */
function untranslatedUserFacingStrings(relPath) {
  const src = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
  const lines = src.split('\n');
  const CJK = /[\u4e00-\u9fff]/;
  const out = [];
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (inBlock) {
      if (line.includes('*/')) inBlock = false;
      continue;
    }
    if (line.includes('/*')) {
      if (!line.includes('*/')) inBlock = true;
      continue;
    }
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*')) continue;
    if (!CJK.test(t)) continue;
    if (!/"[^"]*"/.test(t)) continue;
    /*
     * 判据必须在**拼接后的语句**上做，不能只看本行。
     *
     * 原因（审查 1.3.8 · M-19 把取样范围从「手写 2 个文件」扩大到
     * 「扫目录所有 *.java」之后暴露出来的假阳性）：
     *   ① 多行日志调用：LogBridge.add(..., "MEDIA", 在上一行、
     *      中文字面量在下一行 —— 只看本行就认不出它在写日志；
     *   ② 异常/内部错误串：FileNotFoundException("路径形状非法") 这类
     *      只会进日志或抛给调用方，界面上永远看不到原文；
     *   ③ 日志缓冲区/轨迹截断标记："…(更早的日志已截断)…"、"…（trace 已截断于 …KB）"。
     * 三类都不是 UI 文案，按 log.js 的口径（日志不翻译）一律跳过。
     */
    const stmt = lines.slice(Math.max(0, i - 4), i + 1).join('\n');
    /* ① 日志：它写给开发者看，翻了反而不好检索 */
    if (/LogBridge\.|Log\.|log\(|eprintln!|println!/.test(stmt)) continue;
    /* ② 异常/内部错误串 */
    if (/new\s+\w*Exception\s*\(/.test(stmt)) continue;
    /* ③ 崩溃记录 / 轨迹截断标记 */
    if (/CrashLog\.record|recordMessage|trace|已截断|BUF\.insert/.test(stmt)) continue;
    /*
     * 多行 L10n.t(...) 的**第二行**（英文串那一行）不含中文，不会被误抓；
     * 而中文串那一行往往也不含 `L10n.t` —— 它在上一行。所以往上多看两行。
     */
    const ctx = lines.slice(Math.max(0, i - 3), i + 1).join('\n');
    if (/L10n\.t\(/.test(ctx)) continue;
    out.push(relPath + ':' + (i + 1) + '  ' + t.slice(0, 100));
  }
  return out;
}

test('原生层：会被用户看到的中文文案都已包 L10n.t', () => {
  const bad = [];
  for (const f of NATIVE_I18N_FILES) bad.push(...untranslatedUserFacingStrings(f));
  assert.deepEqual(bad, [],
    '以下 ' + bad.length + ' 处会在英文界面下显示中文：\n' + bad.join('\n'));
});

/**
 * 元测试：证明上面那条**真的会红**。
 *
 * 没有这一条，"断言通过" 可能只是因为它什么都没看见 —— 1.3.6 的
 * i18n 覆盖率测试就是这个毛病（取样范围里没有原生层，恒真）。
 * 这里临时构造一个未包装的字面量，喂给同一套判据，要求必须被抓出来。
 */
test('原生层判据有效：未包 L10n.t 的中文串会被抓出', () => {
  const tmp = path.join(ROOT, 'tests', '.tmp-native-i18n.java');
  try {
    fs.writeFileSync(tmp, [
      'class X {',
      '  String a() { return "这条没包，必须被抓到"; }',
      '  String b() { return L10n.t("这条包了", "wrapped"); }',
      '  void c() { LogBridge.add(ctx, "LOG", "日志里的中文不算文案"); }',
      '}',
    ].join('\n'));
    const found = untranslatedUserFacingStrings(path.relative(ROOT, tmp));
    assert.equal(found.length, 1, '应当只有第一条被抓到，实际：' + JSON.stringify(found));
    assert.match(found[0], /必须被抓到/);
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) {}
  }
});

/**
 * 元测试（审查 1.3.8 · M-19 的配套）：证明取样范围**覆盖了所有原生文件**。
 *
 * M-19 的病根是「NATIVE_I18N_FILES 是手写清单，加文件时忘了加」。
 * 只把清单改成扫目录还不够 —— 必须有一条断言盯着「扫描结果 == 目录实际内容」，
 * 否则将来有人把扫目录改回手写、或加了子目录，就又回到「恒真」状态。
 */
test('原生层取样范围完整：目录里每个 .java 都在取样清单里', () => {
  const onDisk = fs
    .readdirSync(path.join(ROOT, NATIVE_I18N_DIR))
    .filter((f) => f.endsWith('.java'))
    .map((f) => NATIVE_I18N_DIR + '/' + f)
    .sort();
  assert.deepEqual(
    NATIVE_I18N_FILES,
    onDisk,
    '取样清单与目录实际内容不一致 —— 有文件漏检（这正是 M-19 的病根）'
  );
  /* 1.3.8 新增的 LyricOverlay.java 必须在内（它是本轮最容易漏的那个） */
  assert.ok(
    NATIVE_I18N_FILES.some((p) => p.endsWith('LyricOverlay.java')),
    'LyricOverlay.java（1.3.8 新增的原生 UI）不在取样范围里'
  );
});

/* ---------------------------------------------------------- DOM 层：剪枝（1.3.8 B-1 / B-1a / H-8） */

/*
 * 这一节真的把 index.html + i18n.js + en.js 装进 jsdom 跑，断言「英文界面下
 * 歌名 / 艺人 / 歌词保持中文，静态标签被翻成英文」。
 *
 * 为什么前面那些测试挡不住 B-1：它们全部在**纯函数**层面（T() / 词典 / 白名单），
 * 而 B-1 的缺陷在 **MutationObserver → walk() → inSkip() 的调用链**里 ——
 * 一条通路漏了守卫，纯函数测试一条都看不见。1.3.6 之所以把 B-1 当成
 * 「1.3.5 的 H-1 已经修好」，正是因为 tests/i18n.test.js 全文对
 * SKIP_SEL / inSkip / textContent 零覆盖。
 *
 * jsdom 是**仓库外**的依赖（本机在 /tmp/node_modules/jsdom，仓库里没有
 * package.json，CI 也不跑 npm install）。所以这里做两件事：
 *   ① 找不到 jsdom 时**跳过并大声说明**（列出因此失去的覆盖面），不静默；
 *   ② 另加一条不依赖任何外部包的**名单漂移断言**（见本节末尾），
 *      保证「有人把 #dockTitle 从名单里删掉」这种回退在 CI 上也能被抓到。
 */

/** jsdom 解析顺序：显式环境变量 → 正常 require → 本机 /tmp 兜底 */
function loadJsdom() {
  const cands = [];
  if (process.env.RIPPLE_JSDOM) cands.push(process.env.RIPPLE_JSDOM);
  cands.push('jsdom', '/tmp/node_modules/jsdom');
  for (const c of cands) {
    try {
      const mod = require(c);
      /* jsdom 的导出形状有两套：新版是 { JSDOM }，老版/直连路径直接是构造函数 */
      if (typeof mod === 'function') return mod;
      if (mod && typeof mod.JSDOM === 'function') return mod.JSDOM;
    } catch (e) { /* 继续试下一个 */ }
  }
  return null;
}

const JSDOM = loadJsdom();
const NO_JSDOM = JSDOM ? false
  : 'jsdom 不可用（试过 $RIPPLE_JSDOM / jsdom / /tmp/node_modules/jsdom）'
    + ' —— 回调层（MutationObserver → walk → inSkip）的断言本次未执行';

/**
 * 往引擎源码里打一个「破坏补丁」，用来做元测试。
 *
 * 每处补丁都**断言锚点确实存在**：锚点漂了（有人重构了这段代码）时
 * 必须当场报错，而不是安静地打一个空补丁、让元测试变成重言式。
 */
function breakEngine(src, p) {
  if (src.indexOf(p.from) < 0) {
    throw new Error('破坏补丁的锚点不存在（' + p.why + '）：' + JSON.stringify(p.from.slice(0, 60)));
  }
  return src.replace(p.from, p.to);
}

/** 三个破坏补丁，分别对应 B-1 / B-1a / H-8 的修复 */
const BREAK_B1 = {
  from: '      if (inSkip(node)) return;\n      translateTextNode(node);',
  to: '      translateTextNode(node);',
  why: 'B-1：去掉 walk() 文本节点分支的 inSkip 守卫',
};
const BREAK_B1A = {
  from: "    '#dockTitle', '#dockArtist',                 // 底部 dock 歌名/艺人（与播放页同源数据）\n",
  to: '',
  why: 'B-1a：把 #dockTitle / #dockArtist 从 SKIP_SEL 里删掉',
};
const BREAK_H8 = {
  from: "  var UNSKIP_SEL = '.c-k';",
  to: "  var UNSKIP_SEL = '.c-k-disabled';",
  why: 'H-8：让反剪枝名单不再命中 .c-k（等价于「只从 SKIP_SEL 删掉 .c-k」这一步）',
};

/**
 * 用真实 index.html 起一个英文界面的 jsdom 页面。
 * @param {string} [src] 引擎源码（默认读仓库里的；元测试传破坏版）
 */
function bootDom(src) {
  const engine = src || fs.readFileSync(path.join(ROOT, 'app', 'js', 'i18n.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'app', 'index.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window;
  w.eval(engine);
  w.eval(fs.readFileSync(path.join(ROOT, 'app', 'js', 'lang', 'en.js'), 'utf8'));
  return {
    w, d: w.document, I: w.I18n,
    close() { try { w.close(); } catch (e) { /* 已关 */ } },
  };
}

/** 等 MutationObserver 的回调跑完（观察器回调是微任务，150ms 足够宽松） */
function domTick() {
  return new Promise((r) => setTimeout(r, 150));
}

/** 五个「远程数据」元素 + 真实业务会写进去的中文短词 */
const REMOTE_CASES = [
  ['#npTitle', '全部', '播放页歌名'],
  ['#npArtist', '深', '播放页艺人'],
  ['#lyrCur', '全部', '收起态当前句歌词'],
  ['#dockTitle', '全部', '底部 dock 歌名'],
  ['#dockArtist', '深', '底部 dock 艺人'],
];

/**
 * 公共流程：英文态 → 给五个元素赋中文短词 → 读回。
 * @param {string} [src] 引擎源码（元测试传破坏版）
 */
async function assignRemoteAndRead(src) {
  const page = bootDom(src);
  try {
    page.I.setLang('en', true);
    await domTick();
    for (const c of REMOTE_CASES) {
      const el = page.d.querySelector(c[0]);
      assert.ok(el, 'index.html 里找不到 ' + c[0] + '（选择器或结构变了，本节断言失去依据）');
      /* 用 textContent 赋值 = 真实业务写法（app.js:2578 / :2662 / :3293）。
         它在 DOM 层产生 childList 变更，正是 B-1 漏掉的那条通路。 */
      el.textContent = c[1];
    }
    await domTick();
    const got = {};
    for (const c of REMOTE_CASES) got[c[0]] = page.d.querySelector(c[0]).textContent;
    return got;
  } finally {
    page.close();
  }
}

test('B-1 / B-1a：英文态下歌名、艺人、歌词不被翻译（inSkip 必须覆盖 textContent 通路）', { skip: NO_JSDOM }, async () => {
  const got = await assignRemoteAndRead();
  /*
   * 判据是「等于中文原文」，不是「不等于 All」—— 后者在引擎整体瘫痪时也通过，
   * 那正是这类测试最容易变成空转的地方（见下一条对照测试）。
   */
  for (const c of REMOTE_CASES) {
    assert.equal(got[c[0]], c[1],
      c[2] + '（' + c[0] + '）被翻译了：期望 ' + JSON.stringify(c[1])
      + '，实际 ' + JSON.stringify(got[c[0]])
      + ' —— 用户在听的内容必须原样显示');
  }
});

test('对照：同一次赋值里，静态界面文案确实被翻成英文（否则上面那条是空转）', { skip: NO_JSDOM }, async () => {
  /*
   * 这条是前一条的**有效性前提**：如果引擎压根没跑起来（en.js 没加载、
   * setLang 没生效、观察器没启动），前一条会因为「什么都没变」而假通过。
   * 所以这里断言同一份页面里普通元素确实变成了英文 ——
   * 证明「仍是中文」是剪枝的结果，而不是翻译整体失效。
   */
  const page = bootDom();
  try {
    page.I.setLang('en', true);
    await domTick();
    const tab = page.d.querySelector('.tabbar a[data-nav="home"]');
    assert.ok(tab, '找不到底部导航的「发现」项');
    assert.equal(tab.textContent.trim(), 'Discover', '英文态下静态标签没被翻译，说明引擎没生效');
    assert.equal(page.I.T('发现'), 'Discover', 'T() 本身在英文态应返回译文');
  } finally {
    page.close();
  }
});

test('H-8：首页卡片里的 .c-k 静态标签要被翻译，同一张卡的远程标题仍保持中文', { skip: NO_JSDOM }, async () => {
  const page = bootDom();
  try {
    page.I.setLang('en', true);
    await domTick();
    const car = page.d.querySelector('#carousel');
    assert.ok(car, 'index.html 里找不到 #carousel');
    /*
     * 复刻 app.js:916-922 的 carouselHTML：.c-card 整张卡既有远程数据
     * （.c-tx 里的歌单标题/副标题），也有写死的界面标签（.c-k 的 kind）。
     */
    car.innerHTML = '<div class="c-card"><div class="c-k">歌单</div>'
      + '<div class="c-tx"><b>全部</b><span>深</span></div></div>';
    await domTick();
    const k = car.querySelector('.c-k');
    assert.equal(k.textContent, 'Playlists',
      '.c-k 是静态界面标签（netease.js 的 歌单/收藏 两个字面量），英文态必须翻译；'
      + '实际 ' + JSON.stringify(k.textContent));
    /* 反向保护：不能为了修 H-8 把整张卡的远程数据一起放出来 */
    assert.equal(car.querySelector('.c-tx b').textContent, '全部',
      '.c-card 里的歌单标题是远程数据，必须保持中文');
    assert.equal(car.querySelector('.c-tx span').textContent, '深',
      '.c-card 里的副标题是远程数据，必须保持中文');
    /* 真实渲染会反复重建卡片，重写一次 .c-k 也要翻（childList 通路） */
    k.textContent = '收藏';
    await domTick();
    assert.equal(k.textContent, 'Favorite',
      '.c-k 重新赋值后应变成 Favorite，实际 ' + JSON.stringify(k.textContent));
  } finally {
    page.close();
  }
});

test('剪枝是可逆的：切回中文再切英文，被跳过的容器内容仍是原文', { skip: NO_JSDOM }, async () => {
  /*
   * 剪枝最容易写错的方向是「英文态不翻、切回中文也回不去」。
   * 这里走一遍 en → zh → en。
   */
  const page = bootDom();
  try {
    page.I.setLang('en', true);
    await domTick();
    for (const c of REMOTE_CASES) page.d.querySelector(c[0]).textContent = c[1];
    const car = page.d.querySelector('#carousel');
    car.innerHTML = '<div class="c-card"><div class="c-k">歌单</div></div>';
    await domTick();

    page.I.setLang('zh', true);
    await domTick();
    for (const c of REMOTE_CASES) {
      assert.equal(page.d.querySelector(c[0]).textContent, c[1], '切回中文后 ' + c[0] + ' 应是原文');
    }
    assert.equal(car.querySelector('.c-k').textContent, '歌单', '切回中文后 .c-k 应是原文');

    page.I.setLang('en', true);
    await domTick();
    for (const c of REMOTE_CASES) {
      assert.equal(page.d.querySelector(c[0]).textContent, c[1], '再切英文后 ' + c[0] + ' 仍应是原文');
    }
    assert.equal(car.querySelector('.c-k').textContent, 'Playlists', '再切英文后 .c-k 应重新翻译');
  } finally {
    page.close();
  }
});

/*
 * ---------- 元测试：证明上面那些断言不是空转 ----------
 *
 * 做法与「原生层判据有效」那条一致：把修复**故意破坏**，用同一套断言去跑，
 * 要求它必须变红。三条修复各配一个补丁，缺一条都会让对应修复失去防线。
 *
 * 特别注意 BREAK_H8：它把 UNSKIP_SEL 改成一个匹配不到任何元素的值 ——
 * 这正是「只把 .c-k 从 SKIP_SEL 里删掉、忘了祖先 .c-card 会整棵剪掉」的状态。
 * 1.3.8 的修复建议里只写了「去掉 .c-k」，本机实测那样改之后 .c-k 仍是中文。
 */

test('元测试：去掉 walk() 文本分支的 inSkip → B-1/B-1a 断言必须变红', { skip: NO_JSDOM }, async () => {
  const broken = breakEngine(fs.readFileSync(path.join(ROOT, 'app', 'js', 'i18n.js'), 'utf8'), BREAK_B1);
  const got = await assignRemoteAndRead(broken);
  /* 破坏之后至少 #npTitle 与 #dockTitle 必须被翻掉，否则元测试本身无效 */
  assert.notEqual(got['#npTitle'], '全部',
    '去掉 inSkip 守卫后 #npTitle 仍是中文 —— 说明这条元测试没有真的破坏到 B-1 的修复路径');
  assert.equal(got['#npTitle'], 'All', '破坏版应把「全部」译成 All，实际 ' + JSON.stringify(got['#npTitle']));
  assert.equal(got['#dockTitle'], 'All', '破坏版应把 dockTitle「全部」译成 All');
});

test('元测试：把 #dockTitle / #dockArtist 从 SKIP_SEL 删掉 → B-1a 断言必须变红', { skip: NO_JSDOM }, async () => {
  const broken = breakEngine(fs.readFileSync(path.join(ROOT, 'app', 'js', 'i18n.js'), 'utf8'), BREAK_B1A);
  const got = await assignRemoteAndRead(broken);
  assert.equal(got['#dockTitle'], 'All', '删掉 #dockTitle 后它应被翻译（B-1a 的原始症状）');
  assert.equal(got['#dockArtist'], 'Dark', '删掉 #dockArtist 后它应被翻译');
  /* 反向：播放页那几个还在名单里，破坏这一条不该波及它们 —— 证明两条根因是独立的 */
  assert.equal(got['#npTitle'], '全部', 'B-1 的修复独立生效，不该被 B-1a 的破坏波及');
});

test('元测试：让反剪枝名单不命中 .c-k → H-8 断言必须变红', { skip: NO_JSDOM }, async () => {
  const broken = breakEngine(fs.readFileSync(path.join(ROOT, 'app', 'js', 'i18n.js'), 'utf8'), BREAK_H8);
  const page = bootDom(broken);
  try {
    page.I.setLang('en', true);
    await domTick();
    const car = page.d.querySelector('#carousel');
    car.innerHTML = '<div class="c-card"><div class="c-k">歌单</div></div>';
    await domTick();
    assert.equal(car.querySelector('.c-k').textContent, '歌单',
      '反剪枝失效后 .c-k 应仍是中文（这正是「只从 SKIP_SEL 删掉 .c-k」的实测结果）');
  } finally {
    page.close();
  }
});

/*
 * ---------- 名单漂移防护（不需要任何外部依赖，CI 一定跑得到） ----------
 *
 * jsdom 缺席时上面整节会 skip，于是「有人把 #dockTitle 从 SKIP_SEL 里删掉」
 * 这类回退在 CI 上就是隐形的。这条测试直接读源码里的两份名单，
 * 断言 1.3.8 修复过的条目一个都不许少 —— 它抓不到逻辑错误，但抓得住回退。
 */

/**
 * 从源码里抠出 `var NAME = ...;` 这一句里所有单/双引号字面量。
 * 用来在**不依赖 jsdom** 的情况下读 SKIP_SEL / UNSKIP_SEL 名单。
 */
function extractSelectorList(src, name) {
  const m = new RegExp('var ' + name + ' = ').exec(src);
  if (!m) return null;
  const end = src.indexOf(';\n', m.index);
  const body = src.slice(m.index + m[0].length, end < 0 ? src.length : end);
  const re = /'([^']*)'|"([^"]*)"/g;
  const out = [];
  let x;
  while ((x = re.exec(body)) !== null) {
    const v = x[1] !== undefined ? x[1] : x[2];
    if (v && v !== ',') out.push(v);   // ',' 是 .join 的分隔符，不是选择器
  }
  return out;
}

test('名单漂移：SKIP_SEL / UNSKIP_SEL 里 1.3.8 修复过的条目一个都不许少', () => {
  const src = fs.readFileSync(path.join(ROOT, 'app', 'js', 'i18n.js'), 'utf8');
  const skip = extractSelectorList(src, 'SKIP_SEL');
  const unskip = extractSelectorList(src, 'UNSKIP_SEL');

  /* 先证明解析器真的读到了东西（否则下面的 includes 全是空转） */
  assert.ok(skip && skip.length > 10,
    'SKIP_SEL 解析失败或条目数异常（实际 ' + (skip ? skip.length : 'null')
    + '）—— 正则与源码形状对不上了，这条测试已经失效');
  assert.ok(unskip && unskip.length >= 1, 'UNSKIP_SEL 解析失败');

  /* B-1a：底部 dock 的两个 id 必须在跳过名单里 */
  assert.ok(skip.indexOf('#dockTitle') >= 0,
    '#dockTitle 掉了 → 底部 dock 歌名会被翻译（B-1a 复发）');
  assert.ok(skip.indexOf('#dockArtist') >= 0,
    '#dockArtist 掉了 → 底部 dock 艺人会被翻译（B-1a 复发）');

  /* H-8：.c-k 必须**不在** SKIP_SEL、而在 UNSKIP_SEL 里（两半缺一不可） */
  assert.equal(skip.indexOf('.c-k'), -1,
    '.c-k 又回到 SKIP_SEL 了 —— 首页卡片的「歌单/收藏」在英文界面会永远中文（H-8 复发）');
  assert.ok(unskip.indexOf('.c-k') >= 0,
    '.c-k 不在 UNSKIP_SEL 里 —— 光从 SKIP_SEL 删掉是不够的，祖先 .c-card 仍会整棵剪掉');

  /* 播放页三项是 1.3.5 修的，一并钉住，防止以后清名单时误删 */
  for (const id of ['#npTitle', '#npArtist', '#npMeta']) {
    assert.ok(skip.indexOf(id) >= 0, id + ' 掉了 → 播放页歌名/艺人会被翻译');
  }
});

/*
 * 元测试：证明名单漂移断言不是空转 ——
 * 把 1.3.8 的三处修复全部回退成「修复前」的名单，同一套判据必须报错。
 */
test('元测试：把 SKIP_SEL / UNSKIP_SEL 回退成修复前状态 → 漂移断言必须变红', () => {
  const repaired = fs.readFileSync(path.join(ROOT, 'app', 'js', 'i18n.js'), 'utf8');
  let reverted = breakEngine(repaired, BREAK_B1A);
  reverted = breakEngine(reverted, BREAK_H8);

  const skip = extractSelectorList(reverted, 'SKIP_SEL');
  const unskip = extractSelectorList(reverted, 'UNSKIP_SEL');

  /* 回退之后：dock 两项不在名单里、.c-k 也不在反剪枝名单里 */
  assert.equal(skip.indexOf('#dockTitle'), -1, '回退版里 #dockTitle 应当不在 SKIP_SEL');
  assert.equal(unskip.indexOf('.c-k'), -1, '回退版里 .c-k 应当不在 UNSKIP_SEL');

  /* 这正是修复前会漏掉的两条断言 —— 证明上面的检查对这类回退是敏感的 */
  const problems = [];
  if (skip.indexOf('#dockTitle') < 0) problems.push('dock');
  if (unskip.indexOf('.c-k') < 0) problems.push('ck');
  assert.deepEqual(problems, ['dock', 'ck'],
    '回退后必须同时触发 dock 与 .c-k 两项告警，实际 ' + JSON.stringify(problems));
});

/*
 * ---------- H-8 的连带风险：.c-k 被翻译后，读回显示文本的代码会拿到英文 ----------
 *
 * app.js:5898-5903 打开歌单详情页时这样取 kind：
 *   kind: (plEl.querySelector('.c-k') || {}).textContent
 * 再写进 #plKind（app.js:5290）。.c-k 不翻译时读到的是中文原文，链路自洽；
 * 一旦按 H-8 翻成英文，读回来就是 Playlists —— 实测切回中文后 #plKind 仍留英文。
 *
 * 根治要改 app.js（读事实源别读显示文本），但那不在本文件的写入范围。
 * 所以 i18n.js 负责把原文暴露成 data-i18n-src，这里断言它确实可用；
 * 同时把「读 textContent 会拿到英文」这个事实钉住 —— 它一旦变了，
 * 说明 app.js 那边已经改成读 data-i18n-src 了，这条测试该更新。
 */
test('H-8 连带：.c-k 的原文通过 data-i18n-src 暴露，供读回显示文本的代码改用', { skip: NO_JSDOM }, async () => {
  const page = bootDom();
  try {
    page.I.setLang('en', true);
    await domTick();
    const car = page.d.querySelector('#carousel');
    car.innerHTML = '<div class="c-card" data-pl="p1"><div class="c-k">歌单</div></div>';
    await domTick();
    const k = car.querySelector('.c-k');
    assert.equal(k.textContent, 'Playlists', '英文态显示值应是译文');
    assert.equal(k.getAttribute('data-i18n-src'), '歌单',
      'data-i18n-src 必须留着中文原文 —— app.js:5902 拿它当 kind 用；'
      + '实际 ' + JSON.stringify(k.getAttribute('data-i18n-src')));
    /* 切回中文：显示值回原文，data-i18n-src 仍是原文 */
    page.I.setLang('zh', true);
    await domTick();
    assert.equal(k.textContent, '歌单', '切回中文后 .c-k 应显示原文');
    assert.equal(k.getAttribute('data-i18n-src'), '歌单', 'data-i18n-src 应保持原文');
  } finally {
    page.close();
  }
});
