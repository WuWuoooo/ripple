/*
 * app/js/lrc.js 的单元测试。
 *
 * 跑法：node --test tests/      （只用 Node 内置模块，不需要 npm install）
 *
 * 为什么用 new Function 而不是 require：
 *   lrc.js 是一个 `(function (g) { ... })(window)` 的 IIFE，直接挂到 window 上，
 *   没有 module.exports。不改源文件的前提下，这里传一个假的 window 进去把
 *   导出的 LRC 取出来 —— 等于模拟一次浏览器里的加载。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC_PATH = path.join(__dirname, '..', 'app', 'js', 'lrc.js');

function loadLRC() {
  const src = fs.readFileSync(SRC_PATH, 'utf8');
  const win = {};
  // 用函数参数遮蔽全局 window，让 IIFE 里的 `(window)` 拿到我们的假对象
  // eslint-disable-next-line no-new-func
  new Function('window', src)(win);
  return win.LRC;
}

const LRC = loadLRC();

/** 浮点毫秒比较：时间戳是 min*60+sec+frac/1000 算出来的，不用 === */
function close(actual, expected, msg) {
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    msg || `期望 ${expected}，实际 ${actual}`
  );
}

/* ---------------------------------------------------------------- 加载 */

test('模块能加载，并导出 parse / merge 两个函数', () => {
  assert.equal(typeof LRC, 'object');
  assert.equal(typeof LRC.parse, 'function');
  assert.equal(typeof LRC.merge, 'function');
});

/* ---------------------------------------------------------------- 解析 */

test('空输入返回空数组', () => {
  assert.deepEqual(LRC.parse(''), []);
  assert.deepEqual(LRC.parse(null), []);
  assert.deepEqual(LRC.parse(undefined), []);
});

test('最基本的 [mm:ss] 能解析', () => {
  const out = LRC.parse('[00:01]hello');
  assert.equal(out.length, 1);
  close(out[0].t, 1);
  assert.equal(out[0].text, 'hello');
});

test('[mm:ss.xx] 两位小数 → 毫秒', () => {
  const out = LRC.parse('[01:23.45]hi');
  assert.equal(out.length, 1);
  close(out[0].t, 83.45);
  assert.equal(out[0].text, 'hi');
});

test('[mm:ss.x] 一位小数按十分之一秒算（右补零到三位）', () => {
  const out = LRC.parse('[00:00.5]a');
  close(out[0].t, 0.5);
});

test('[mm:ss.xxx] 三位小数保留毫秒精度', () => {
  const out = LRC.parse('[00:00.123]a');
  close(out[0].t, 0.123);
});

test('四种格式可以混排在同一个文件里', () => {
  const out = LRC.parse(
    ['[00:01]a', '[00:02.5]b', '[00:03.25]c', '[00:04.125]d'].join('\n')
  );
  assert.deepEqual(out.map((l) => l.text), ['a', 'b', 'c', 'd']);
  close(out[0].t, 1);
  close(out[1].t, 2.5);
  close(out[2].t, 3.25);
  close(out[3].t, 4.125);
});

test('冒号分隔的毫秒写法 [mm:ss:xx] 也能认（网易云常见）', () => {
  const out = LRC.parse('[00:02:50]a');
  close(out[0].t, 2.5);
});

test('一行多个时间戳 → 展开成多行同一段文字', () => {
  const out = LRC.parse('[00:01.00][00:05.00]副歌');
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((l) => l.text), ['副歌', '副歌']);
  close(out[0].t, 1);
  close(out[1].t, 5);
});

test('元信息标签（[ti:] / [ar:] / [by:]）不是歌词，跳过', () => {
  const text = '[ti:歌名]\n[ar:歌手]\n[by:某人]\n[offset:0]\n[00:01.00]第一句';
  const out = LRC.parse(text);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, '第一句');
});

test('有时间戳但没有文字的行走不到输出里', () => {
  assert.deepEqual(LRC.parse('[00:01.00]'), []);
  assert.deepEqual(LRC.parse('[00:01.00]    '), []);
});

test('空行被跳过，不产生空歌词', () => {
  const out = LRC.parse('\n\n[00:01.00]a\n\n[00:02.00]b\n\n');
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((l) => l.text), ['a', 'b']);
});

test('输出按时间升序排序（源文件乱序也要排好）', () => {
  const out = LRC.parse('[00:03.00]c\n[00:01.00]a\n[00:02.00]b');
  assert.deepEqual(out.map((l) => l.text), ['a', 'b', 'c']);
  close(out[0].t, 1);
  close(out[2].t, 3);
});

test('CRLF 换行不会在文字里留下 \\r', () => {
  const out = LRC.parse('[00:01.00]a\r\n[00:02.00]b\r\n');
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((l) => l.text), ['a', 'b']);
});

test('分钟位支持 1~3 位数字', () => {
  const out = LRC.parse('[100:00.00]超长');
  close(out[0].t, 6000);
});

/* ------------------------------------------- 同时间戳去重（阈值 0.05s） */

test('同一时间戳被写两遍 → 只保留一条', () => {
  const out = LRC.parse('[01:23.00]每一次心跳\n[01:23.00]每一次心跳');
  assert.equal(out.length, 1);
  assert.equal(out[0].text, '每一次心跳');
});

test('副歌重复（间隔 3.5 秒）必须保留两条', () => {
  const out = LRC.parse('[01:23.00]每一次心跳\n[01:26.50]每一次心跳');
  assert.equal(out.length, 2);
});

test('间隔 0.2 秒的相同文字必须保留（旧阈值 0.3 会误删）', () => {
  // 这正是注释里记录的回归：念白/快歌的连续短句被当成重复删掉
  const out = LRC.parse('[00:10.00]啊\n[00:10.20]啊');
  assert.equal(out.length, 2, '0.2 秒间隔是正常歌词，不能被去重');
});

test('间隔小于 0.05 秒才算重复', () => {
  const out = LRC.parse('[00:10.00]啊\n[00:10.02]啊');
  assert.equal(out.length, 1);
});

test('间隔刚好 0.05 秒保留（阈值是 >=）', () => {
  const out = LRC.parse('[00:10.00]啊\n[00:10.05]啊');
  assert.equal(out.length, 2);
});

test('同一时间戳的不同文字都保留', () => {
  const out = LRC.parse('[00:10.00]原文\n[00:10.00]译文');
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((l) => l.text), ['原文', '译文']);
});

test('文字不同、时间也相同的重复长段不会被误合并', () => {
  const out = LRC.parse(
    ['[00:01.00]a', '[00:01.00]a', '[00:01.00]b', '[00:02.00]b'].join('\n')
  );
  // 第一条保留；第二条同字同时间被删；b(1.00) 与上一条 a 不同字保留；b(2.00) 保留
  assert.deepEqual(out.map((l) => l.text), ['a', 'b', 'b']);
});

/* ------------------------------------------------------ 原文 / 译文合并 */

test('没有译文时原样返回原数组', () => {
  const orig = [{ t: 1, text: 'a' }];
  assert.equal(LRC.merge(orig, null), orig);
  assert.equal(LRC.merge(orig, []), orig);
  assert.equal(LRC.merge(orig, undefined), orig);
});

test('时间戳完全一致 → 挂上译文', () => {
  const out = LRC.merge(
    [{ t: 1, text: '原文' }],
    [{ t: 1, text: '译文' }]
  );
  assert.equal(out[0].tr, '译文');
  assert.equal(out[0].text, '原文');
});

test('时间戳差 100ms 仍能配上（300ms 容差）', () => {
  const out = LRC.merge(
    [{ t: 10.0, text: '原文' }],
    [{ t: 10.08, text: '译文' }]
  );
  assert.equal(out[0].tr, '译文');
});

test('时间戳差 30ms 也能配上（旧实现按 100ms 取整会丢）', () => {
  const out = LRC.merge(
    [{ t: 1.04, text: '原文' }],
    [{ t: 1.06, text: '译文' }]
  );
  assert.equal(out[0].tr, '译文');
});

test('差 300ms 是容差边界，能配上', () => {
  const out = LRC.merge(
    [{ t: 5, text: '原文' }],
    [{ t: 5.3, text: '译文' }]
  );
  assert.equal(out[0].tr, '译文');
});

test('差超过 300ms 不配对（有行已配上时不会启动兜底）', () => {
  const out = LRC.merge(
    [{ t: 5, text: '原文一' }, { t: 20, text: '原文二' }],
    [{ t: 5, text: '译一' }, { t: 20.31, text: '译二' }]
  );
  assert.equal(out[0].tr, '译一');
  assert.equal(out[1].tr, undefined, '0.31 秒超出 300ms 容差');
});

test('一行都没配上时，超容差也会走行号兜底（已知行为，别当成 bug）', () => {
  // merge() 的设计是「只要一个 tr 都没挂上，就按行号对齐」，
  // 所以单行、偏移 310ms 这种情况仍然会挂上译文。
  // 这里把行为钉住，避免以后改容差时误伤兜底逻辑。
  const out = LRC.merge(
    [{ t: 5, text: '原文' }],
    [{ t: 5.31, text: '译文' }]
  );
  assert.equal(out[0].tr, '译文');
});

test('译文与原文文字相同时不重复挂 tr', () => {
  const out = LRC.merge(
    [{ t: 1, text: '同一句' }],
    [{ t: 1, text: '同一句' }]
  );
  assert.ok(!('tr' in out[0]), '文字相同就不该有 tr 字段');
});

test('一条译文只用一次，不会被多行原文重复占用', () => {
  const out = LRC.merge(
    [{ t: 1.0, text: 'a' }, { t: 1.1, text: 'b' }],
    [{ t: 1.05, text: '译' }]
  );
  assert.equal(out[0].tr, '译');
  assert.equal(out[1].tr, undefined);
});

test('时间轴完全对不上时，按行号兜底挂译文', () => {
  const out = LRC.merge(
    [{ t: 10, text: '第一句' }, { t: 20, text: '第二句' }],
    [{ t: 0, text: 'TRANSLATED 1' }, { t: 0.01, text: 'TRANSLATED 2' }]
  );
  assert.equal(out[0].tr, 'TRANSLATED 1');
  assert.equal(out[1].tr, 'TRANSLATED 2');
});

test('兜底按较短的一方做索引（行数不等也不至于一行译文都没有）', () => {
  const out = LRC.merge(
    [{ t: 10, text: 'a' }, { t: 20, text: 'b' }, { t: 30, text: 'c' }],
    [{ t: 0, text: 'A' }]
  );
  assert.equal(out[0].tr, 'A');
  assert.equal(out[1].tr, undefined);
  assert.equal(out[2].tr, undefined);
});

test('已经配上任何一行，就不启动行号兜底', () => {
  const out = LRC.merge(
    [{ t: 1, text: 'a' }, { t: 100, text: 'b' }],
    [{ t: 1, text: 'A' }]
  );
  assert.equal(out[0].tr, 'A');
  assert.equal(out[1].tr, undefined, '不能因为第二行没配上就整首兜底');
});

test('合并返回新对象，不修改传入的原文数组', () => {
  const orig = [{ t: 1, text: 'a' }];
  const out = LRC.merge(orig, [{ t: 1, text: 'A' }]);
  assert.notEqual(out, orig);
  assert.ok(!('tr' in orig[0]), '原数组不应被写入 tr');
  assert.equal(out[0].tr, 'A');
});

test('没有译文可配时仍然返回逐行拷贝（不共享引用）', () => {
  const orig = [{ t: 1, text: 'a' }];
  const out = LRC.merge(orig, [{ t: 9, text: '远' }]);
  assert.notEqual(out[0], orig[0]);
  assert.equal(out[0].text, 'a');
});

/* --------------------------------------------- 解析 + 合并 端到端 */

test('端到端：解析两份 LRC 后合并出双语歌词', () => {
  const orig = LRC.parse('[00:01.00]第一句\n[00:03.00]第二句');
  const trans = LRC.parse('[00:01.05]first line\n[00:03.05]second line');
  const out = LRC.merge(orig, trans);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((l) => l.tr), ['first line', 'second line']);
});

test('端到端：译文时间轴整体错位时按行号兜底仍能显示', () => {
  const orig = LRC.parse('[00:10.00]第一句\n[00:20.00]第二句');
  const trans = LRC.parse('[00:01.00]one\n[00:02.00]two');
  const out = LRC.merge(orig, trans);
  assert.deepEqual(out.map((l) => l.tr), ['one', 'two']);
});
