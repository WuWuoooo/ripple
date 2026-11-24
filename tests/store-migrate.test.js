/*
 * app/js/store.js 设置迁移的单元测试。
 *
 * 为什么必须测这个：迁移逻辑写错的后果是**用户设置被静默改掉**，
 * 而且「sbFill 一直被强制打开、关不掉」这种症状极难从界面上看出来
 * （用户只会觉得「设置不管用」）。这类 bug 只能靠单测钉住。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC_PATH = path.join(__dirname, '..', 'app', 'js', 'store.js');

/*
 * 造一个最小的 localStorage 替身。
 * store.js 是 (function(g){...})(window) 的 IIFE，内部还引用了
 * localStorage。用一个可控的假对象喂进去，就能在不启动浏览器的前提下
 * 测「给定一份旧存档，load 之后得到什么设置」。
 */
function makeStorage(initial) {
  const data = Object.assign({}, initial || {});
  return {
    getItem(k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
    setItem(k, v) { data[k] = String(v); },
    removeItem(k) { delete data[k]; },
    _raw: data,
  };
}

function loadStore(storage) {
  const src = fs.readFileSync(SRC_PATH, 'utf8');
  const win = {};
  const ls = storage || makeStorage();
  // eslint-disable-next-line no-new-func
  new Function('window', 'localStorage', 'navigator', 'document', src)(
    win, ls,
    { userAgent: 'node-test' },
    {
      addEventListener() {},
      querySelector() { return null; },
      querySelectorAll() { return []; },
      documentElement: { classList: { add() {}, remove() {}, toggle() {} }, style: { setProperty() {}, removeProperty() {} } },
    }
  );
  return { Store: win.Store, ls };
}

const KEY = 'ripple.state.v1';

/* ------------------------------------------------------------ 基本加载 */

test('store 能加载并导出 Store', () => {
  const { Store } = loadStore();
  assert.equal(typeof Store, 'object');
  assert.equal(typeof Store.load, 'function');
  assert.equal(typeof Store.save, 'function');
});

test('空存储：拿到全套默认设置，新功能默认开启', () => {
  const { Store } = loadStore();
  Store.load();
  const s = Store.state.settings;
  assert.equal(s.karaokeLyric, true, '卡拉OK染色应默认开启');
  assert.equal(s.karaokeDone, true, '标记已唱完应默认开启');
  assert.equal(s.karaokeColor, '', '染色颜色默认跟随主题');
  assert.equal(s.sbFill, true, '状态栏歌词填充应默认开启（1.3.3）');
});

/* ---------------------------------------------------- 老用户迁移（v1 → v2） */

test('E-06：老存档（无标记）升级后补成 true', () => {
  /*
   * 这是用户实测反馈的「状态栏歌词没有播放填充动画」的根本原因：
   * 1.3.2 及以前 DEFAULTS 里 sbFill 是 false，老用户的 localStorage
   * 存着 false；1.3.3 把默认值改成 true 只影响全新安装的人。
   *
   * E-06（审查报告，1.3.4）：迁移的判据从「值是 false 就改」收窄成
   * 「存档里没有 sbFillUserSet 标记」。老存档没有这个字段，
   * 视为「用户从没碰过这个开关」，仍然补成 true。
   */
  const { Store } = loadStore(makeStorage({
    [KEY]: JSON.stringify({
      settings: { theme: 'dark' },
    }),
  }));
  Store.load();
  const s = Store.state.settings;
  assert.equal(s.sbFill, true, '从没碰过开关的老用户升级后应获得填充动画');
  assert.equal(s.theme, 'dark', '其他设置不能被迁移动到');
});

test('E-06：主动关掉过的老用户（有标记）不会被重新打开', () => {
  /*
   * 1.3.2 里用户主动关掉填充，升级后被偷偷打开 ——「我明明关了，怎么又开了」。
   * 现在靠 sbFillUserSet 标记区分「没碰过」和「主动关掉」：
   * 有标记就绝对尊重用户的选择。
   */
  const { Store } = loadStore(makeStorage({
    [KEY]: JSON.stringify({
      settings: { sbFill: false, sbFillUserSet: true },
    }),
  }));
  Store.load();
  assert.equal(Store.state.settings.sbFill, false,
    '用户主动关掉过的开关，升级时绝不能被重新打开');
});

test('已经在 v2 的存档：不会再把 sbFill 改回 true（用户关掉就关掉了）', () => {
  /*
   * 迁移只能跑一次。若每次都跑，用户手动关掉「跟随进度填充」之后
   * 一重启又被打开，而且永远关不掉 —— 这是比不迁移更糟的 bug。
   */
  const { Store } = loadStore(makeStorage({
    [KEY]: JSON.stringify({
      schema: 4,
      settings: { sbFill: false },
    }),
  }));
  Store.load();
  assert.equal(Store.state.settings.sbFill, false,
    'v2 存档里用户手动关掉的 sbFill 必须被尊重');
});

test('save() 会把 schema 版本一起写进去', () => {
  const { Store, ls } = loadStore();
  Store.load();
  Store.save();
  const raw = JSON.parse(ls.getItem(KEY));
  assert.equal(raw.schema, 5, 'schema 必须落盘，否则迁移每次启动都会重跑');
});

test('迁移后立刻 save()，再 load() 一次不会重复迁移', () => {
  /*
   * 存档里**不带 sbFill**（模拟「用户从没碰过这个开关」的 1.3.2 老用户）——
   * 这正是 v1→v2 迁移该处理的情形。
   *
   * ⚠️ 不能写成 { sbFill: false }：E-06 起那代表「用户主动关过」，
   * 迁移会尊重它、不打开（见上面那条专门测它的用例）。
   */
  const storage = makeStorage({
    [KEY]: JSON.stringify({ settings: {} }),
  });
  const first = loadStore(storage);
  first.Store.load();
  assert.equal(first.Store.state.settings.sbFill, true);
  /*
   * 模拟：用户手动关掉，然后落盘。
   *
   * E-06 起必须同时写 sbFillUserSet 标记 —— 真实 UI 里
   * onSettingChange('sbFill') 会写它，这里手动设置要模拟同样的效果，
   * 否则下一次启动时「无标记」会被判成「从没碰过」而重新打开。
   */
  first.Store.state.settings.sbFill = false;
  first.Store.state.settings.sbFillUserSet = true;
  first.Store.save();

  // 再启动一次（同一个 storage）
  const second = loadStore(storage);
  second.Store.load();
  assert.equal(second.Store.state.settings.sbFill, false,
    '第二次启动不该把用户关掉的开关又打开');
});

/* ------------------------------------------------------ 坏值收敛（回归） */

test('坏值仍然按 DEFAULTS 类型收敛（回归，不受迁移影响）', () => {
  const { Store } = loadStore(makeStorage({
    [KEY]: JSON.stringify({
      schema: 4,
      settings: {
        lyricSize: 'abc',
        glassBlur: null,
        volume: 999,
        theme: 'rainbow',
        karaokeColor: 12345,   // 不是字符串 → 应回落默认空串
      },
    }),
  }));
  Store.load();
  const s = Store.state.settings;
  assert.equal(s.lyricSize, 11, 'lyricSize 坏值应回落默认');
  assert.equal(s.glassBlur, 26, 'glassBlur 为 null 应回落默认');
  assert.equal(s.volume, 1, 'volume 应被钳到 [0,1]');
  assert.equal(s.theme, 'auto', '非法枚举应回落默认');
  assert.equal(s.karaokeColor, '', 'karaokeColor 不是字符串应回落空串');
});

test('karaokeColor 是合法 hex 时能存下来', () => {
  const { Store } = loadStore(makeStorage({
    [KEY]: JSON.stringify({
      schema: 4,
      settings: { karaokeColor: '#ff8800' },
    }),
  }));
  Store.load();
  assert.equal(Store.state.settings.karaokeColor, '#ff8800');
});

/* ------------------------------------------------ v2 → v3：填充色迁移 */

test('v2 → v3：旧的浅青填充色 #7DE3D0 升级成有明显色差的新默认值', () => {
  /*
   * 用户反馈「打开跟随进度填充只是边缘发亮，没有填充效果」的根因：
   * 旧默认色 #7DE3D0（浅青）和默认文字色 #FFFFFF（白）都是高明度，
   * 在深色状态栏上「已唱/未唱」几乎看不出区别。
   * 只改 DEFAULTS 对老用户无效（他们的 localStorage 里存着旧值），
   * 所以必须有这条迁移。
   */
  const { Store } = loadStore(makeStorage({
    [KEY]: JSON.stringify({
      schema: 2,
      settings: { sbFill: true, sbFillColor: '#7DE3D0' },
    }),
  }));
  Store.load();
  assert.notEqual(Store.state.settings.sbFillColor.toUpperCase(), '#7DE3D0',
    '旧默认色应该被迁移掉');
  assert.equal(Store.state.settings.sbFillColor, '#b3a2ff');
});

test('v2 → v3：用户自己调过的填充色不能被冲掉', () => {
  const { Store } = loadStore(makeStorage({
    [KEY]: JSON.stringify({
      schema: 2,
      settings: { sbFill: true, sbFillColor: '#FF0000' },
    }),
  }));
  Store.load();
  assert.equal(Store.state.settings.sbFillColor, '#FF0000',
    '用户主动选的红色必须保留');
});

test('v3 存档：不会重复迁移填充色', () => {
  const { Store } = loadStore(makeStorage({
    [KEY]: JSON.stringify({
      schema: 4,
      settings: { sbFill: true, sbFillColor: '#7DE3D0' },
    }),
  }));
  Store.load();
  // 已经是 v3，说明用户在新版里主动把颜色改回了浅青 —— 要尊重
  assert.equal(Store.state.settings.sbFillColor, '#7DE3D0');
});

/* ------------------------------------------- 卡拉OK染色相关的新设置项 */

test('karaokeInvert 默认开启（用户要求）', () => {
  const { Store } = loadStore();
  Store.load();
  assert.equal(Store.state.settings.karaokeInvert, true,
    '大多数人只在一种主题下挑颜色，反色能自动兜住切换主题后的失效');
});

test('sbInvert / sbFillInvert 默认关闭（与 karaokeInvert 不同，这是有意的）', () => {
  /*
   * 状态栏浮层盖在**系统状态栏**上，背景是用户壁纸（九成深色），
   * 跟 App 主题无关。默认反色会把白字变纯黑，在深色壁纸上完全看不见 ——
   * 实测日志 `overlay apply color=#000000` 就是这次回归的痕迹。
   */
  const { Store } = loadStore();
  Store.load();
  assert.equal(Store.state.settings.sbInvert, false);
  assert.equal(Store.state.settings.sbFillInvert, false);
});

/* ------------------------- v3 → v4：修正反色回归 ------------------------- */

test('v3 → v4：反色开关被强制关掉（老用户 localStorage 里存着 true）', () => {
  const { Store } = loadStore(makeStorage({
    [KEY]: JSON.stringify({
      schema: 3,
      settings: { sbInvert: true, sbFillInvert: true },
    }),
  }));
  Store.load();
  assert.equal(Store.state.settings.sbInvert, false,
    '不迁移的话老用户永远看不到状态栏歌词（黑色字配深色壁纸）');
  assert.equal(Store.state.settings.sbFillInvert, false);
});

test('v3 → v4：被反色污染的颜色一起还原', () => {
  /*
   * 反色开着时，用户看到的和存下来的可能是反色后的值。
   * 光关掉开关不还原颜色，字还是黑的。
   */
  const { Store } = loadStore(makeStorage({
    [KEY]: JSON.stringify({
      schema: 3,
      settings: { sbColor: '#000000', sbFillColor: '#4C5D00' },
    }),
  }));
  Store.load();
  assert.equal(Store.state.settings.sbColor, '#FFFFFF', '#000000 是 #FFFFFF 的反色');
  assert.equal(Store.state.settings.sbFillColor, '#b3a2ff', '#4C5D00 是 #b3a2ff 的反色');
});

test('v3 → v4：用户自己选的正常颜色不能被还原', () => {
  const { Store } = loadStore(makeStorage({
    [KEY]: JSON.stringify({
      schema: 3,
      settings: { sbColor: '#FFD166', sbFillColor: '#FF0000' },
    }),
  }));
  Store.load();
  assert.equal(Store.state.settings.sbColor, '#FFD166');
  assert.equal(Store.state.settings.sbFillColor, '#FF0000');
});

test('v4 存档：不会重复修正反色开关', () => {
  const { Store } = loadStore(makeStorage({
    [KEY]: JSON.stringify({
      schema: 4,
      settings: { sbInvert: true },
    }),
  }));
  Store.load();
  assert.equal(Store.state.settings.sbInvert, true,
    'v4 起用户主动打开的反色要尊重');
});

test('karaokeInvert 是布尔值存下来', () => {
  const { Store } = loadStore(makeStorage({
    [KEY]: JSON.stringify({ schema: 3, settings: { karaokeInvert: true } }),
  }));
  Store.load();
  assert.equal(Store.state.settings.karaokeInvert, true);
});

/* ------------------ v4 → v5：修正「填充色被存成纯黑」 ------------------ */

test('v4 → v5：纯黑填充色被还原成默认紫', () => {
  /*
   * 真机日志证据（2026-11-24）：
   *   timing diag: … color=#FFFBFB fillColor=#000000
   * 文字白、填充黑 —— 深色壁纸上两部分亮度一样，用户看到的
   * 依然等于「没有填充」。这个值要么是反色后又被确认落盘，
   * 要么是 HSV 取色器明度滑块误触到最上边缘。
   */
  const { Store } = loadStore(makeStorage({
    [KEY]: JSON.stringify({
      schema: 4,
      settings: { sbFillColor: '#000000' },
    }),
  }));
  Store.load();
  assert.equal(Store.state.settings.sbFillColor, '#b3a2ff',
    '纯黑填充在深色壁纸上等于没有填充，必须还原');
});

test('v4 → v5：用户自己选的正常填充色不受影响', () => {
  const { Store } = loadStore(makeStorage({
    [KEY]: JSON.stringify({
      schema: 4,
      settings: { sbFillColor: '#FF6B6B' },
    }),
  }));
  Store.load();
  assert.equal(Store.state.settings.sbFillColor, '#FF6B6B',
    '只有纯黑才还原，用户手选的其他颜色一律尊重');
});

test('v5 存档：不会重复修正填充色', () => {
  const { Store } = loadStore(makeStorage({
    [KEY]: JSON.stringify({
      schema: 5,
      settings: { sbFillColor: '#000000' },
    }),
  }));
  Store.load();
  assert.equal(Store.state.settings.sbFillColor, '#000000',
    'v5 起用户如果真选了纯黑也要尊重，迁移不能无限重跑');
});

test('v3 → v5 一次跑完：反色关掉且填充色还原', () => {
  const { Store } = loadStore(makeStorage({
    [KEY]: JSON.stringify({
      schema: 3,
      settings: { sbInvert: true, sbFillInvert: true, sbFillColor: '#4C5D00' },
    }),
  }));
  Store.load();
  assert.equal(Store.state.settings.sbInvert, false);
  assert.equal(Store.state.settings.sbFillInvert, false);
  assert.equal(Store.state.settings.sbFillColor, '#b3a2ff');
});
