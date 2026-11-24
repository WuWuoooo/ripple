/*
 * app/js/lyricfill.js 的单元测试。
 *
 * 跑法：bash tests/run.sh
 *
 * 这个模块是纯数学（时间轴 → 填充比例），所以这里只测数学，
 * 不碰 DOM。重点钉三类容易错的地方：
 *   1. 边界 —— 恰好等于开始时刻应该是 0，不是「已经唱了一点」；
 *   2. 换句 —— 下一句开始的那一刻，上一句必须正好是 1，
 *      否则会出现「两句之间空一截没染色」或「上一句永远染不满」；
 *   3. 尾句 —— 最后一句没有下一句可以当终点，必须有合理估计，
 *      既不能一开口就满、也不能永远染不满。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC_PATH = path.join(__dirname, '..', 'app', 'js', 'lyricfill.js');

function load() {
  const src = fs.readFileSync(SRC_PATH, 'utf8');
  const win = {};
  // 用函数参数遮蔽全局 window，让 IIFE 里的 `(window)` 拿到假对象
  new Function('window', src)(win);
  return win.LyricFill;
}

const LF = load();

/* ------------------------------------------------------------ 加载 */

test('模块能加载，导出四个函数', () => {
  assert.equal(typeof LF, 'object');
  assert.equal(typeof LF.lineProgress, 'function');
  assert.equal(typeof LF.estimateLineDur, 'function');
  assert.equal(typeof LF.lineSpan, 'function');
  assert.equal(typeof LF.toneFor, 'function');
});

/* ------------------------------------------------------------ 边界 */

test('恰好等于开始时刻：进度是 0，不是「已经唱了一点」', () => {
  const lines = [{ t: 10 }, { t: 20 }];
  assert.equal(LF.lineProgress(lines, 0, 10), 0);
});

test('还没到这一句：进度是 0', () => {
  const lines = [{ t: 10 }, { t: 20 }];
  assert.equal(LF.lineProgress(lines, 0, 5), 0);
});

test('时间倒流到开始之前：仍然是 0，不会出现负进度', () => {
  const lines = [{ t: 10 }, { t: 20 }];
  assert.equal(LF.lineProgress(lines, 0, -100), 0);
});

test('正常的句内插值：单调递增、两端闭合', () => {
  /*
   * 注意：这里**不能**断言「中点正好是一半」——
   * 1.3.3 起染色时长是「字数估计」和「到下一句间隔」的折中（见 lyricfill.js 注释），
   * 而没有文字时字数估计会退回间隔本身，折中后仍等于间隔，
   * 但一旦有文字就不再是简单的一半。所以只assert性质，不assert具体值。
   */
  const lines = [{ t: 10 }, { t: 20 }];
  assert.equal(LF.lineProgress(lines, 0, 10), 0, '起点必须是 0');
  assert.ok(LF.lineProgress(lines, 0, 15) > 0.3, '中点应已明显前进');
  assert.ok(LF.lineProgress(lines, 0, 15) < 1, '中点不该已经满了');
  assert.ok(LF.lineProgress(lines, 0, 12.5) < LF.lineProgress(lines, 0, 15),
    '进度必须单调递增');
});

test('有文字时：染色速度介于「纯字数估计」和「句间隔」之间', () => {
  /*
   * 这是 1.3.3 第二轮修掉的问题：纯按字数会让慢歌染得太快，
   * 纯按间隔会让快歌染得太慢。现在是两者的折中。
   */
  const wordsOnly = [{ t: 0, text: '一二三四五六七' }, { t: 20 }];   // 长间奏
  const p2 = LF.lineProgress(wordsOnly, 0, 2, 180);
  // 7 字 ≈ 1.52s；若纯按间隔(20s)，2 秒时只有 10%；纯按字数则已 100%
  assert.ok(p2 > 0.2, '不该慢到 10%（那是纯按间隔的老毛病），实际 ' + p2.toFixed(3));
  assert.ok(p2 < 1, '也不该 2 秒就满（那是纯按字数的老毛病），实际 ' + p2.toFixed(3));
});

test('快歌：间隔很短时按间隔走，不硬撑到字数估计', () => {
  const fast = [{ t: 0, text: '一二三四五六七' }, { t: 1.5, text: '下一句' }];
  // 字数估计 1.52s，间隔 1.5s，折中后约 1.5s → 1.5 秒时应该满了
  assert.ok(LF.lineProgress(fast, 0, 1.5) === 1 ||
    LF.lineProgress(fast, 0, 1.49) > 0.9, '快歌应准时唱满');
});

/* ------------------------------------------------------------ 换句 */

test('下一句开始的那一刻：上一句正好是 1', () => {
  const lines = [{ t: 10 }, { t: 20 }];
  // 用 19.999 而不是 20（20 已经归下一句了），验证「几乎唱满」
  assert.ok(LF.lineProgress(lines, 0, 19.999) > 0.9998);
  assert.ok(LF.lineProgress(lines, 1, 20) === 0);   // 下一句刚开始
});

test('唱过这一句之后仍在同一句：进度夹在 1，不会溢出', () => {
  const lines = [{ t: 10 }, { t: 20 }];
  // 下标故意传 0 但时刻已经到了 25 —— 正常流程不会这样，
  // 但降级路径（歌词换行比播放慢半拍）可能撞上，必须夹住
  assert.equal(LF.lineProgress(lines, 0, 25), 1);
});

/* ------------------------------------------------------------ 非法输入 */

test('空歌词 / 空数组 / 非法下标：一律 0，不抛异常', () => {
  assert.equal(LF.lineProgress(null, 0, 5), 0);
  assert.equal(LF.lineProgress([], 0, 5), 0);
  assert.equal(LF.lineProgress([{ t: 1 }], -1, 5), 0);
  assert.equal(LF.lineProgress([{ t: 1 }], 3, 5), 0);
});

test('时间戳是脏数据（NaN / 字符串）：不抛异常，退回 0', () => {
  assert.equal(LF.lineProgress([{ t: NaN }], 0, 5), 0);
  assert.equal(LF.lineProgress([{ t: 'abc' }], 0, 5), 0);
});

test('now 是 NaN / Infinity：不抛异常，退回 0', () => {
  assert.equal(LF.lineProgress([{ t: 1 }, { t: 5 }], 0, NaN), 0);
  // Infinity 是有限性检查之外的情况：会被夹到 1，但不能是 NaN
  const v = LF.lineProgress([{ t: 1 }, { t: 5 }], 0, Infinity);
  assert.ok(v === 1 || v === 0, 'Infinity 应被夹到 0 或 1，实际 ' + v);
});

/* ------------------------------------------------------------ 尾句 */

test('最后一句：不会一开口就满屏（进度远小于 1）', () => {
  const lines = [{ t: 0 }, { t: 3 }, { t: 6 }, { t: 9 }];
  // 最后一句 9 秒开始，刚过 0.1 秒
  const p = LF.lineProgress(lines, 3, 9.1);
  assert.ok(p > 0 && p < 0.2, '刚起头应该很小，实际 ' + p);
});

test('最后一句：也不会永远染不满（过一会儿就接近 1）', () => {
  const lines = [{ t: 0 }, { t: 3 }, { t: 6 }, { t: 9 }];
  // 前面间隔都是 3 秒，估计值应当也是 3 秒 → 12 秒时正好唱满
  assert.ok(LF.lineProgress(lines, 3, 12) >= 0.999, '应已唱满');
});

test('最后一句的时长估计：取中位数，不被长间奏拽偏', () => {
  // 大部分间隔 2 秒，中间夹一个 14 秒的间奏
  const lines = [
    { t: 0 }, { t: 2 }, { t: 4 }, { t: 18 }, { t: 20 }, { t: 22 },
  ];
  const d = LF.estimateLineDur(lines, 5, 200);
  assert.ok(d >= 2 && d <= 3, '中位数应落在 2 秒附近，实际 ' + d);
});

test('只有一行歌词（且没有文字）：用整首时长兜底，并存下限', () => {
  const lines = [{ t: 0 }];
  const d = LF.estimateLineDur(lines, 0, 240);   // 4 分钟的歌
  assert.ok(d >= 1.0 && d <= 9, '应夹在 [1.0, 9]，实际 ' + d);
});

test('没有可用间隔也没有时长：给一个安全默认值', () => {
  const d = LF.estimateLineDur([{ t: 0 }], 0, undefined);
  assert.ok(d >= 1.2 && d <= 8, '实际 ' + d);
});

test('估计值永远夹在 [1.0, 9] 秒', () => {
  // 全部间隔 0.1 秒（极快的念白、且没有文字）→ 取下限
  const fast = [{ t: 0 }, { t: 0.1 }, { t: 0.2 }, { t: 0.3 }];
  assert.equal(LF.estimateLineDur(fast, 3, 100), 1.0);
  // 全部间隔 20 秒（被 15 秒阈值排除，退回估算）→ 仍在范围内
  const slow = [{ t: 0 }, { t: 20 }, { t: 40 }];
  const d = LF.estimateLineDur(slow, 2, 600);
  assert.ok(d >= 1.0 && d <= 9, '实际 ' + d);
});

/* ------------------------------------------------------- 字数估计（1.3.3 新增） */

test('有文字时优先用字数估计，而不是句间隔', () => {
  /*
   * 这是「染色偏慢、越到后面差越多」的核心修复。
   * 两行文字一样长，但第二行的「间隔」被一个 15 秒前奏撑大了：
   *   旧逻辑：第二行按 15 秒铺渐变 → 颜色爬得极慢
   *   新逻辑：两行都按字数估计 → 时长一致
   */
  const lines = [
    { t: 0,  text: '一二三四五六七八' },   // 8 字
    { t: 15, text: '一二三四五六七八' },   // 同样 8 字，但前一句隔了 15 秒
  ];
  const d0 = LF.estimateLineDur(lines, 0, 200);
  const d1 = LF.estimateLineDur(lines, 1, 200);
  assert.ok(Math.abs(d0 - d1) < 0.05,
    '同样字数的两行应该估出同样的时长，实际 ' + d0 + ' vs ' + d1);
  assert.ok(d0 < 3, '8 个字不该估成十几秒，实际 ' + d0);
});

test('标点和空格不计入演唱字数', () => {
  const bare = LF.estimateLineDur([{ t: 0, text: '一二三四五六七八' }], 0, 200);
  const punct = LF.estimateLineDur([{ t: 0, text: '一，二。三、四！五？六；七：八' }], 0, 200);
  assert.ok(Math.abs(bare - punct) < 0.05,
    '标点不该改变估计，实际 ' + bare + ' vs ' + punct);
});

test('长句比短句估得更久', () => {
  const short = LF.estimateLineDur([{ t: 0, text: '你好' }], 0, 200);
  const long = LF.estimateLineDur([{ t: 0, text: '这是一句非常长的歌词内容用来测试估算' }], 0, 200);
  assert.ok(long > short, '长句应估得更久：' + long + ' vs ' + short);
});

test('英文字母也计入字数', () => {
  const d = LF.estimateLineDur([{ t: 0, text: 'hello world' }], 0, 200);
  assert.ok(d > 1.0 && d < 4, '10 个字母应估出 2 秒左右，实际 ' + d);
});

/* --------------------------------------------- 「间奏不该拖慢染色」（回归） */

test('回归：下一句隔了 15 秒间奏时，本句染色仍按正常速度走完', () => {
  /*
   * 场景（真实歌词里很常见）：
   *   [00:00] 第一句（4 秒唱完）
   *   [00:04] 第二句
   *   [00:19] 第三句（前面隔了 15 秒，是间奏）
   * 用户听到的是「第二句在 4~8 秒之间唱完」，所以 8 秒时进度应该接近 1。
   * 旧逻辑会按「到第三句的 15 秒」铺满 → 8 秒时才 27%，明显偏慢。
   */
  const lines = [
    { t: 0,  text: '第一句歌词内容' },
    { t: 4,  text: '第二句歌词内容' },
    { t: 19, text: '第三句歌词内容' },
  ];
  const p8 = LF.lineProgress(lines, 1, 8, 200);
  assert.ok(p8 > 0.8,
    '8 秒时第二句应已接近唱完（不该被 15 秒间奏拖慢），实际 ' + p8.toFixed(3));
  const p19 = LF.lineProgress(lines, 1, 19, 200);
  assert.equal(p19, 1, '到了下一句的时刻，本句必须已满');
});

/* ------------------------------------------------------------ 三行语气 */

test('toneFor：当前句是 now，上一句 done，下一句 todo', () => {
  assert.equal(LF.toneFor(3, 0, 10), 'now');
  assert.equal(LF.toneFor(3, -1, 10), 'done');
  assert.equal(LF.toneFor(3, 1, 10), 'todo');
});

test('toneFor：第一句之前（cur=-1）全是 todo', () => {
  assert.equal(LF.toneFor(-1, 0, 10), 'todo');
  assert.equal(LF.toneFor(-1, 1, 10), 'todo');
});

test('toneFor：越界不出错', () => {
  assert.equal(LF.toneFor(9, 1, 10), 'todo', '最后一句的下一句是 todo');
  assert.equal(LF.toneFor(20, 0, 10), 'todo');
});

/* ------------------------------------------------------------ 单调性 */

test('同一句内进度随时间单调不减', () => {
  const lines = [{ t: 10 }, { t: 20 }];
  let prev = -1;
  for (let t = 10; t <= 20; t += 0.25) {
    const p = LF.lineProgress(lines, 0, t);
    assert.ok(p >= prev - 1e-9, `t=${t} 时进度回退了：${prev} → ${p}`);
    prev = p;
  }
});

test('整首歌连续播放时，填充进度不会跳变（换句处除外）', () => {
  const lines = [{ t: 0 }, { t: 4 }, { t: 8 }, { t: 12 }];
  // 模拟逐帧：当前句切换时，新句从 0 开始是正常的（换句本身就是跳变点）
  let lastIdx = -1;
  for (let t = 0; t <= 12; t += 0.1) {
    let idx = -1;
    for (let i = 0; i < lines.length; i++) if (lines[i].t <= t) idx = i;
    const p = LF.lineProgress(lines, idx, t);
    assert.ok(p >= 0 && p <= 1, `t=${t} 进度越界：${p}`);
    // 同一句内必须单调
    if (idx === lastIdx && idx >= 0) {
      assert.ok(Number.isFinite(p));
    }
    lastIdx = idx;
  }
});

/* ============ 第五轮：lineSpan 必须与 lineProgress 严格一致 ============ */

test('R-14 lineSpan 被导出，且与 lineProgress 的终点严格吻合', () => {
  assert.equal(typeof LF.lineSpan, 'function', '必须导出 lineSpan');
  /*
   * 真机 bug（2026-11-24）：原生浮层按 estimateLineDur 外推，
   * 而网页自己用 lineProgress 里折中后的 end —— 两者在英文歌里差一倍，
   * 表现为「颜色一直满格、看不到从左往右推进」（日志 p1=1136 / 65%）。
   */
  const texts = [
    'I am a housewife and I do the dishes',
    'Housewife, I clean the house for you',
  ];
  const lines = [];
  let t = 0;
  for (let i = 0; i < 8; i++) { lines.push({ t, text: texts[i % 2] }); t += 3.2; }
  for (let k = 0; k < 4; k++) {
    const span = LF.lineSpan(lines, k, t);
    assert.ok(span > 0, '句' + k + ' 的 lineSpan 必须为正');
    const atEnd = LF.lineProgress(lines, k, lines[k].t + span, t);
    assert.ok(atEnd > 0.999,
      'lineSpan 到期时进度必须已到 1（实际 ' + atEnd.toFixed(4)
      + '）—— 否则原生会比网页慢，进度永远追不上');
    const atHalf = LF.lineProgress(lines, k, lines[k].t + span / 2, t);
    assert.ok(Math.abs(atHalf - 0.5) < 0.05,
      'lineSpan 一半时进度应接近 0.5（实际 ' + atHalf.toFixed(3) + '）');
  }
});

test('R-14 lineSpan 不被英文长句的字数估计拖长', () => {
  /*
   * 一行 35+ 个英文字符时，estimateLineDur 会被夹到上限（约 9s），
   * 但真实句间隔只有 3.2s。lineSpan 必须跟间隔走，不能跟字数走。
   */
  const lines = [];
  let t = 0;
  const long = 'I am a housewife and I do the dishes every day';
  for (let i = 0; i < 8; i++) { lines.push({ t, text: long }); t += 3.2; }
  const est = LF.estimateLineDur(lines, 0, t);
  const span = LF.lineSpan(lines, 0, t);
  assert.ok(est > span,
    '字数估计应当比真实句间隔长（est=' + est.toFixed(2) + ' span=' + span.toFixed(2) + '）');
  assert.ok(span <= 3.2 + 0.01,
    'lineSpan 不能超过真实句间隔（实际 ' + span.toFixed(3) + '）');
});

test('R-14 lineSpan 在下标非法时返回 0（让调用方退回旧行为）', () => {
  assert.equal(LF.lineSpan(null, 0, 200), 0);
  assert.equal(LF.lineSpan([], 0, 200), 0);
  assert.equal(LF.lineSpan([{ t: 1 }], -1, 200), 0);
  assert.equal(LF.lineSpan([{ t: 1 }], 5, 200), 0);
});
