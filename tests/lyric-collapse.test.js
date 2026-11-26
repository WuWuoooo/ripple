/*
 * 播放页「展开 / 收起歌词」动画对称性的回归测试（1.3.8）。
 *
 * 用户报的症状：「播放器里面收起歌词的动画应该是与展开相同 但相反的动画，
 * 现在的收起动画与展开不同 看着不顺」。
 *
 * 根因不是曲线参数调错了，而是**收起那一段动画根本不存在**：
 *   展开 → .np.expanded .lyric 挂着 lyricIn，0.3s 淡入；
 *   收起 → .expanded 一摘掉，.lyric 立刻回到 display:none，瞬间消失。
 * 于是同一秒里封面 0.3s 慢慢落回、歌名 0.3s 慢慢下移、
 * 整篇歌词「啪」一下整块没了 —— 两个节奏对不上，看起来像换了套动作。
 *
 * 所以这里测的是两件事，缺一不可：
 *   ① CSS：收起有自己的 lyricOut 关键帧，且**时长与曲线与 lyricIn 相同**、
 *      关键帧严格互为倒放（1→0 对 0→1）；
 *   ② JS：animateLyricBox(false) 真的挂了 .collapsing，并在
 *      「--dur-ani 的实际毫秒数」之后才摘掉（不是写死 300）。
 *
 * ⚠️ 为什么第 ② 条要把函数抠出来跑，而不是 grep 源码：
 *   「源码里出现了 collapsing 这个词」在函数根本没被调用时也成立。
 *   1.3.5 的 i18n 覆盖率测试就是栽在这种「取样范围里恒真」上。
 *   抠出来执行，才能断言「挂类了 / 到点摘了 / 时长跟着设置走」。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CSS_PATH = path.join(ROOT, 'app', 'css', 'base.css');
const JS_PATH = path.join(ROOT, 'app', 'js', 'app.js');

/* ---------------------------------------------------------------- CSS */

/** 取出某条规则的大括号内容（只处理顶层无嵌套的简单规则，够用） */
function ruleBody(css, selector) {
  const i = css.indexOf(selector + '{');
  if (i < 0) return null;
  let depth = 0;
  for (let k = i + selector.length; k < css.length; k++) {
    if (css[k] === '{') depth++;
    else if (css[k] === '}') {
      depth--;
      if (depth === 0) return css.slice(i + selector.length + 1, k);
    }
  }
  return null;
}

test('收起：CSS 里有独立的 lyricOut，且时长/曲线与 lyricIn 完全一致', () => {
  const css = fs.readFileSync(CSS_PATH, 'utf8');

  const inBody = ruleBody(css, '.np.expanded .lyric');
  const outBody = ruleBody(css, '.np.collapsing .lyric');
  assert.ok(inBody, '找不到 .np.expanded .lyric 规则（展开动画）');
  assert.ok(outBody, '找不到 .np.collapsing .lyric 规则（收起动画缺失 = 本 bug 复发）');

  /* 动画声明必须逐字一致，只有关键帧名可以不同 —— 这就是「同一个动作两个方向」 */
  const pick = (b) => {
    const m = b.match(/animation\s*:\s*([\w-]+)\s+var\(--dur-ani\)\s+var\(--ease-inout\)/);
    return m ? { name: m[1], decl: m[0] } : null;
  };
  const a = pick(inBody);
  const b = pick(outBody);
  assert.ok(a, '展开动画没有用 var(--dur-ani) / var(--ease-inout)：' + inBody.trim().slice(0, 120));
  assert.ok(b, '收起动画没有用 var(--dur-ani) / var(--ease-inout)：' + outBody.trim().slice(0, 120));
  assert.equal(a.name, 'lyricIn');
  assert.equal(b.name, 'lyricOut');
  assert.equal(a.decl.replace(a.name, 'X'), b.decl.replace(b.name, 'X'),
    '展开与收起的动画时长/曲线必须相同，否则正反节奏不一致');
});

test('收起：lyricOut 的关键帧是 lyricIn 的严格倒放', () => {
  const css = fs.readFileSync(CSS_PATH, 'utf8');
  const kf = (name) => {
    const m = css.match(new RegExp('@keyframes\\s+' + name + '\\s*\\{([\\s\\S]*?)\\n\\}', ''));
    return m ? m[1] : null;
  };
  const inn = kf('lyricIn');
  const out = kf('lyricOut');
  assert.ok(inn, '找不到 @keyframes lyricIn');
  assert.ok(out, '找不到 @keyframes lyricOut（收起时没有淡出 = 会瞬消失）');

  const op = (body) => {
    const from = (body.match(/from\s*\{[^}]*opacity\s*:\s*([\d.]+)/) || [])[1];
    const to = (body.match(/to\s*\{[^}]*opacity\s*:\s*([\d.]+)/) || [])[1];
    return { from, to };
  };
  const i = op(inn);
  const o = op(out);
  assert.deepEqual(i, { from: '0', to: '1' }, 'lyricIn 应该是 0 → 1');
  assert.deepEqual(o, { from: '1', to: '0' }, 'lyricOut 应该是 1 → 0（严格倒放）');
});

test('收起：三行与整篇是同一条时间轴上的交叉淡化（没有硬切）', () => {
  const css = fs.readFileSync(CSS_PATH, 'utf8');
  const body = ruleBody(css, '.np.collapsing .np-lyric');
  assert.ok(body, '缺少 .np.collapsing .np-lyric 规则');

  /*
   * 上一版这里断言的是 display:none（三行全程隐藏、动画结束那一帧才出现）。
   * 真机反馈「收起时三行凭空一闪」，所以改成同时淡入。
   *
   * 判据不能只写「有 animation」—— 必须要求：
   *   ① 三行在收起过程中可见（display 不是 none）；
   *   ② 它有自己的淡入关键帧，且**时长/曲线与整篇淡出完全相同**
   *      （不同时长就会出现「一个已经淡完、另一个还在半透明」的空档）。
   */
  assert.doesNotMatch(body, /display\s*:\s*none/,
    '收起过程中三行被隐藏了：整篇淡完后三行会「啪」地出现，那是硬切');
  assert.match(body, /animation\s*:\s*[\w-]+\s+var\(--dur-ani\)\s+var\(--ease-inout\)/,
    '三行的淡入没有复用 --dur-ani / --ease-inout，与整篇淡出的节奏会不一致');

  /* 交叉淡化的方向必须相反：整篇 1→0，三行 0→1 */
  const out = css.match(/@keyframes\s+lyricOut\s*\{([\s\S]*?)\n\}/);
  const mini = css.match(/@keyframes\s+lyricMiniIn\s*\{([\s\S]*?)\n\}/);
  assert.ok(out, '缺少 @keyframes lyricOut');
  assert.ok(mini, '缺少 @keyframes lyricMiniIn');
  const op = (b) => ({
    from: (b.match(/from\s*\{[^}]*opacity\s*:\s*([\d.]+)/) || [])[1],
    to: (b.match(/to\s*\{[^}]*opacity\s*:\s*([\d.]+)/) || [])[1],
  });
  assert.deepEqual(op(out[1]), { from: '1', to: '0' }, '整篇收起应该是 1 → 0');
  assert.deepEqual(op(mini[1]), { from: '0', to: '1' }, '三行淡入应该是 0 → 1（交叉）');
});

/* -------------------------------------------------------------- JS 侧 */

/**
 * 找出源码里某个具名函数的完整文本（大括号配平，跳过字符串与注释）。
 *
 * 不用正则一把梭：函数体里有大量 { } 出现在模板串里，正则会切歪。
 */
function extractFn(src, name) {
  const m = new RegExp('function\\s+' + name + '\\s*\\(').exec(src);
  if (!m) return null;
  let i = src.indexOf('{', m.index + m[0].length - 1);
  if (i < 0) return null;
  let depth = 0;
  let inS = null;
  let inLine = false;
  let inBlock = false;
  for (let k = i; k < src.length; k++) {
    const c = src[k];
    const n = src[k + 1];
    if (inLine) { if (c === '\n') inLine = false; continue; }
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; k++; } continue; }
    if (inS) {
      if (c === '\\') { k++; continue; }
      if (c === inS) inS = null;
      continue;
    }
    if (c === '/' && n === '/') { inLine = true; k++; continue; }
    if (c === '/' && n === '*') { inBlock = true; k++; continue; }
    if (c === '"' || c === "'" || c === '`') { inS = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(m.index, k + 1);
    }
  }
  return null;
}

/**
 * 把 aniDurationMs + animateLyricBox 摘出来，喂假 DOM 执行。
 *
 * 这是一份**最小可执行切片**：不改源文件、不装浏览器，
 * 但跑的是仓库里那份真实函数体，所以改坏了它会红。
 */
function makeHarness(src, opts) {
  const o = opts || {};
  const ani = extractFn(src, 'aniDurationMs');
  const anim = extractFn(src, 'animateLyricBox');
  assert.ok(ani, 'app.js 里找不到 aniDurationMs');
  assert.ok(anim, 'app.js 里找不到 animateLyricBox');

  const classes = new Set(o.classes || ['open', 'expanded']);
  const np = {
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); },
    },
  };

  const timers = [];
  const cleared = [];
  const timersObj = {
    setTimeout: (fn, ms) => { timers.push({ fn: fn, ms: ms }); return timers.length; },
    clearTimeout: (id) => { cleared.push(id); },
  };
  const win = {
    getComputedStyle: () => ({ getPropertyValue: () => o.durAni || '0.3s' }),
    document: { documentElement: {} },
  };
  const fake$ = (sel) => (sel === '#np' ? np : null);

  // eslint-disable-next-line no-new-func
  const factory = new Function('$', 'getComputedStyle', 'document', 'setTimeout', 'clearTimeout',
    'let _collapseTimer = null;\n' + ani + '\n' + anim + '\n' +
    'return { aniDurationMs: aniDurationMs, animateLyricBox: animateLyricBox };');
  const api = factory(fake$, win.getComputedStyle, win.document,
    timersObj.setTimeout, timersObj.clearTimeout);
  return { api: api, classes: classes, timers: timers, cleared: cleared };
}

test('收起：animateLyricBox(false) 挂 .collapsing，到点才摘', () => {
  const src = fs.readFileSync(JS_PATH, 'utf8');
  const h = makeHarness(src, { durAni: '0.3s' });

  h.api.animateLyricBox(false);
  assert.equal(h.classes.has('expanded'), false, '收起必须摘掉 .expanded');
  assert.equal(h.classes.has('collapsing'), true,
    '收起没有挂 .collapsing → 歌词会瞬间 display:none，与本 bug 现象一致');

  assert.equal(h.timers.length, 1, '应当只排一个收摊定时器');
  assert.equal(h.timers[0].ms, 300, '默认 --dur-ani 是 .3s');

  /* 到点前还挂着 collapsing（否则动画会被腰斩） */
  assert.equal(h.classes.has('collapsing'), true);
  h.timers[0].fn();
  assert.equal(h.classes.has('collapsing'), false, '定时器到点后必须摘掉 .collapsing');
});

test('收起：收摊时长跟着 --dur-ani 走，不是写死 300', () => {
  const src = fs.readFileSync(JS_PATH, 'utf8');
  /* 「动画速度」设置会把 --dur-ani 等比缩小（上限仍是 .3s） */
  const h = makeHarness(src, { durAni: '0.12s' });
  assert.equal(h.api.aniDurationMs(), 120);
  h.api.animateLyricBox(false);
  assert.equal(h.timers[0].ms, 120,
    '写死 300 会让摘类比动画晚一倍时长 —— 收完之后还要愣一下才能再点展开');
});

test('展开：仍然只挂 .expanded，不排任何定时器', () => {
  const src = fs.readFileSync(JS_PATH, 'utf8');
  const h = makeHarness(src, { classes: ['open'] });
  h.api.animateLyricBox(true);
  assert.equal(h.classes.has('expanded'), true);
  assert.equal(h.classes.has('collapsing'), false);
  assert.equal(h.timers.length, 0, '展开是纯 CSS 动画，不需要 JS 计时器');
});

test('关闭播放页时不播收起动画（否则整页下滑里会闪一下）', () => {
  const src = fs.readFileSync(JS_PATH, 'utf8');
  /* 没有 .open = 播放页正在关闭 */
  const h = makeHarness(src, { classes: ['expanded'] });
  h.api.animateLyricBox(false);
  assert.equal(h.classes.has('expanded'), false, '状态仍要清干净');
  assert.equal(h.classes.has('collapsing'), false,
    '整页正在下滑时内部再演一遍淡出，0.3s 后三行会在滑动中突然出现');
  assert.equal(h.timers.length, 0);
});

/*
 * 下面三条是**元测试**：把被测对象故意改坏，要求上面那套判据真的报错。
 *
 * 没有它们，"断言通过" 可能只是因为判据什么都没看见 ——
 * 1.3.5 的 i18n 覆盖率测试就是这个毛病（取样范围里恒真，永远绿）。
 * 这里要求 mutation 之后**抛错**，而不是断言某个值等于 false：
 * 后者在函数被整个删掉时也会"通过"。
 */
function expectRed(fn, label) {
  let threw = null;
  try { fn(); } catch (e) { threw = e; }
  assert.ok(threw, label + ' —— 改坏之后判据仍然是绿的，说明它是恒真的');
  return threw;
}

test('元测试：抹掉 CSS 的 lyricOut 关键帧，对称性判据必须报错', () => {
  const css = fs.readFileSync(CSS_PATH, 'utf8');
  const i = css.indexOf('@keyframes lyricOut');
  assert.ok(i > 0, '源码里找不到 @keyframes lyricOut');
  /* 只删这一个关键帧（保留 .np.collapsing .lyric 规则），模拟"收起只剩空壳" */
  const mutated = css.slice(0, i) + css.slice(i).replace(/@keyframes lyricOut\{[\s\S]*?\n\}/, '');
  assert.notEqual(mutated, css);
  expectRed(() => {
    const m = mutated.match(/@keyframes\s+lyricOut\s*\{/);
    assert.ok(m, '找不到 @keyframes lyricOut（收起时没有淡出 = 会瞬消失）');
  }, '删掉 lyricOut 之后仍然找到了它');
});

test('元测试：把收起动画的时长改成 --dur-l，正反对称判据必须报错', () => {
  const css = fs.readFileSync(CSS_PATH, 'utf8');
  /* 只改 .np.collapsing .lyric 那一条里的时长，展开保持 --dur-ani */
  const mutated = css.replace(
    '.np.collapsing .lyric{display:block;\n  animation:lyricOut var(--dur-ani)',
    '.np.collapsing .lyric{display:block;\n  animation:lyricOut var(--dur-l)');
  assert.notEqual(mutated, css, '变异没生效：找不到那条动画声明');
  const pick = (str, sel) => {
    const i = str.indexOf(sel + '{');
    const body = str.slice(i + sel.length + 1, str.indexOf('}', i));
    const m = body.match(/animation\s*:\s*([\w-]+)\s+var\(--dur-ani\)\s+var\(--ease-inout\)/);
    return m ? m[1] : null;
  };
  expectRed(() => {
    assert.ok(pick(mutated, '.np.collapsing .lyric'),
      '收起动画没有用 var(--dur-ani)：时长与展开不一致');
  }, '改成 --dur-l 之后仍然通过');
});

test('元测试：把挂 .collapsing 那一行删掉，JS 侧判据必须报错', () => {
  const src = fs.readFileSync(JS_PATH, 'utf8');
  const mutated = src.replace("np.classList.add('collapsing');", '/* removed */');
  assert.notEqual(mutated, src, '变异没生效：源码里找不到那行（函数被重写了？）');
  expectRed(() => {
    const h = makeHarness(mutated, { durAni: '0.3s' });
    h.api.animateLyricBox(false);
    assert.equal(h.classes.has('collapsing'), true,
      '收起没有挂 .collapsing → 歌词会瞬间 display:none，与本 bug 现象一致');
  }, '删掉挂类之后仍然判定有 collapsing');
});
