/*
 * app/js/netease.js 里 heartMode() 的返回结构解析。
 *
 * 为什么单独测：这个接口的返回结构和别处**不一样**（多嵌一层 data），
 * 而错在解析层的表现极其难查 —— 列表永远是空的，外层 try 把
 * `list.map is not a function` 吞掉，用户只看到「心动模式取不到列表」。
 * 这类「结构假设错误」只能靠单测钉住。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC_PATH = path.join(__dirname, '..', 'app', 'js', 'netease.js');

/*
 * ============================================================
 * ⚠️ 这里**不能**手抄一份解析逻辑再测它（审查 1.3.5 的 M-8）
 * ============================================================
 *
 * 旧版是这么写的：测试文件里自己实现一个 extractList()，把 netease.js 里
 * 那段 if/else 链「按同样的规则跑一遍」，然后断言它返回什么。
 *
 * 那种测试是**重言式**：它测的是测试文件里的副本，不是产品代码。
 * 实测证据（报告给的）—— 把 netease.js 里 heartMode 的真实实现整个删掉
 * 换成 `return [];`，8 个用例里 **7 个仍然通过**，只有那条
 * `assert.match(SRC, ...)` 的正则断言会红。也就是说：产品坏了，测试几乎全绿。
 *
 * 现在改成**从源码里真的跑那段逻辑**：
 *   1. 从 netease.js 里切出 heartMode 函数体（用花括号配对，不靠缩进猜）；
 *   2. 用 new Function 把它包起来，注入一个假的 this（call / mapSong 都是桩）；
 *   3. 喂不同的返回结构，断言真实的解析结果。
 * 这样「源码里的 if/else 链改了」会立刻反映到测试结果上。
 */
const SRC = fs.readFileSync(SRC_PATH, 'utf8');

/** 从 openIdx 处的 '{' 找到配对的 '}'（跳过字符串与模板串） */
function matchBrace(src, openIdx) {
  let depth = 0;
  let i = openIdx;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      i++;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === q) { i++; break; }
        i++;
      }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
    i++;
  }
  return -1;
}

/**
 * 取出 netease.js 里 heartMode 的**函数体源码**。
 *
 * 找不到就抛错（而不是静默降级）—— 找不到意味着函数被改名/被移走，
 * 那测试必须红，否则它又会变成一个「测空气」的假测试。
 */
function heartModeBody() {
  const m = SRC.match(/async\s+heartMode\s*\(([^)]*)\)\s*\{/);
  if (!m) throw new Error('netease.js 里找不到 heartMode 函数 —— 测试需要更新');
  const open = m.index + m[0].length - 1;
  const close = matchBrace(SRC, open);
  if (close < 0) throw new Error('heartMode 函数体花括号不配对');
  return { params: m[1], body: SRC.slice(open + 1, close) };
}

/**
 * 用真实函数体构造一个可调用的 heartMode。
 *
 * 注入的 this 提供两样东西：
 *   · call(cmd, params) —— 返回测试指定的响应，不碰网络；
 *   · mapSong(x)       —— 忠实还原「取 songInfo/song/x 里的 neId」这一步，
 *                          返回 null 模拟无法映射的项。
 *   · Log              —— 空实现（真实代码里会记日志）。
 *   · _firstOwnPlaylistId —— 返回一个固定歌单 ID，避免走网络分支。
 */
async function makeHeartMode(response) {
  const { params, body } = heartModeBody();
  /*
   * 桩要**跟真实实现的调用面**对齐：heartMode 现在走 this.mapSongs(...)，
   * 而 mapSongs 内部再到 this.mapSong。这里照真实的两层结构桩，
   * 而不是只桩 mapSong —— 否则「测试替身与产品接口不一致」会以
   * 一堆 TypeError 的形式冒出来（这次就冒了）。
   * mapSongs / mapSong 的语义与 netease.js 里的实现保持一致：
   * 非对象返回 null，没有 id 的项被丢掉。
   */
  const mapSong = (x) => {
    if (!x || typeof x !== 'object') return null;
    const neId = x.id || x.songId || x.neId;
    return neId ? { neId } : null;
  };
  const stub = {
    call: async () => response,
    mapSong,
    mapSongs(arr, pick) {
      if (!Array.isArray(arr)) return [];
      const out = [];
      for (const x of arr) {
        if (!x || typeof x !== 'object') continue;
        const t = mapSong(pick ? pick(x) : x);
        if (t && t.neId) out.push(t);
      }
      return out;
    },
    _firstOwnPlaylistId: async () => '123456',
  };
  /*
   * new Function('Log', 'return (async function (...) {...})') 会**返回**
   * 那个内层函数 —— 所以 fn(Log) 的结果就是函数本身，直接 .call(stub)。
   * （第一版写成了 raw.bind(...)，而 raw 才是函数、fn(...) 已经返回它了。）
   */
  const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;
  /*
   * ⚠️ 两个容易踩的点：
   *   ① new AsyncFn(...) 造出来的是 **async 函数**，调用它返回 Promise，
   *      所以要 await 才能拿到内层那个函数（第一版没 await，
   *      拿到的是 Promise，报 'raw.bind is not a function'）。
   *   ② factory(Log) 的返回值才是 heartMode 本身，bind 它。
   */
  const factory = new AsyncFn('Log', 'return (async function (' + params + ') {' + body + '});');
  const raw = await factory({ add() {}, err() {} });
  return raw.bind(stub);
}

/** 跑一次并拿到「映射后的列表长度 + neId」 */
async function run(response, args) {
  const hm = await makeHeartMode(response);
  const list = await hm(1, 0, 20);
  return list;
}

test('源码里确实是逐层探测，不是写死 r.data 或 r.data.data', () => {
  assert.match(SRC, /Array\.isArray\(r && r\.data\)/,
    '必须能处理一层结构');
  assert.match(SRC, /Array\.isArray\(r\.data\.data\)/,
    '必须能处理两层结构（上游可能改成 data.data）');
  assert.doesNotMatch(SRC, /const list = r\.data \|\| \[\];/,
    '不能退回旧的单层假设 —— 那正是「取不到列表」的根因');
});

/* ===== 以下用例都跑**真实源码**（见文件头的 M-8 说明） ===== */

test('两层结构：能正确取到并映射', async () => {
  const list = await run({ code: 200, data: { data: [{ songInfo: { id: 1 } }, { songInfo: { id: 2 } }] } });
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((t) => t.neId), [1, 2]);
});

test('一层结构（实测结构）：能正确取到并映射', async () => {
  const list = await run({ code: 200, data: [{ songInfo: { id: 1 } }] });
  assert.equal(list.length, 1);
  assert.equal(list[0].neId, 1);
});

test('未登录（code 301，没有 data）：返回空数组，不抛异常', async () => {
  const list = await run({ code: 301, message: null });
  assert.deepEqual(list, []);
});

test('data 是空对象：返回空数组，不抛异常', async () => {
  assert.deepEqual(await run({ code: 200, data: {} }), []);
});

test('data.data 不是数组（坏数据）：返回空数组', async () => {
  assert.deepEqual(await run({ code: 200, data: { data: null } }), []);
  assert.deepEqual(await run({ code: 200, data: { data: 'oops' } }), []);
});

test('songs 兜底结构：也能取到', async () => {
  const list = await run({ code: 200, songs: [{ id: 7 }] });
  assert.equal(list.length, 1);
  assert.equal(list[0].neId, 7);
});

test('空数组：正常返回空，不误判成结构不对', async () => {
  assert.deepEqual(await run({ code: 200, data: { data: [] } }), []);
  assert.deepEqual(await run({ code: 200, data: [] }), []);
});

test('无法映射的项被过滤掉（filter 生效）', async () => {
  /* mapSong 返回 null 的项必须被 filter 掉，否则上层会拿到空对象 */
  const list = await run({ code: 200, data: [{ songInfo: { id: 3 } }, { songInfo: {} }, null] });
  assert.equal(list.length, 1);
  assert.equal(list[0].neId, 3);
});

/* ============================================================
   M-8 的**元测试**：证明这套测试真的能抓到产品代码被改坏。

   这条用例的意义比上面所有断言加起来还大：
   它验证「测试与产品代码之间存在真实的因果关系」。
   旧版用副本时，把实现删空仍然 7/8 通过 —— 那就是没有因果关系。
   ============================================================ */
test('元测试：把真实实现的逐层探测删掉后，上面的用例会红', async () => {
  const { body } = heartModeBody();
  /* 模拟「实现被改坏」：把三层探测整段换成一个错误的单层假设 */
  const broken = body.replace(
    /if \(Array\.isArray\(r && r\.data\)\)[\s\S]*?\}\s*else if \(Array\.isArray\(r && r\.songs\)\)\s*\{[\s\S]*?\}/,
    'if (Array.isArray(r && r.songs)) { list = r.songs; }'
  );
  assert.notEqual(broken, body, '替换必须真的改动了函数体（否则元测试自己就是假的）');

  /* 用改坏后的函数体跑同一条断言：两层结构必须取不到 → 说明断言有效 */
  const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;
  const factory = new AsyncFn('Log', 'return (async function (songId, playlistId, count) {' + broken + '});');
  const fn = await factory({ add() {} });
  const stub = {
    call: async () => ({ code: 200, data: { data: [{ songInfo: { id: 1 } }] } }),
    mapSong: (x) => ({ neId: x && x.songInfo && x.songInfo.id }),
    mapSongs(arr, pick) {
      if (!Array.isArray(arr)) return [];
      return arr.map((x) => ({ neId: x && x.songInfo && x.songInfo.id }))
        .filter((t) => t && t.neId);
    },
    _firstOwnPlaylistId: async () => '123456',
  };
  const got = await fn.call(stub, 1, 0, 20);
  assert.deepEqual(got, [],
    '改坏后「两层结构」应当取不到数据 —— 如果还能取到，说明上面的用例测不出这种破坏');
});
