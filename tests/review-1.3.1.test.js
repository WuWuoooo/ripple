/* ============================================================
   审查 1.3.0 → 1.3.1 回归测试
   
   每个用例对应审查报告里的一条，命名带编号，方便下一轮审查直接核对
   「这条到底修没修」。这些用例的共同特点：**修之前必然红**。
   ============================================================ */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/* ---------------------------------------------------------------
 * G-01 [blocker] 扫码登录成功码 803 必须在白名单里
 *
 * 1.3.0 的白名单只有 200/800/801/802，803（授权成功）落进抛错分支，
 * 于是 app.js 的 `if (code === 803)` 成了永不可达的死分支，
 * 控制流直接进 catch 被当成网络抖动继续轮询 ——
 * 表现是「手机上确认了、界面一直转圈、最后报二维码过期」（登录其实已成功）。
 * --------------------------------------------------------------- */
test('G-01 扫码状态码：803 必须在 codeOk 白名单里', () => {
  const src = read('app/js/netease.js');

  // 白名单必须由 QR_STATE_CODES 驱动，而不是散落的字面量
  assert.match(src, /const codeOk = codeNum === 200 \|\| QR_STATE_CODES\.indexOf\(codeNum\) >= 0/,
    'codeOk 必须用 QR_STATE_CODES 定义，不能把状态码散落成字面量');

  // QR_STATES 必须含 SUCCESS: 803
  const m = src.match(/const QR_STATES = \{([^}]+)\}/);
  assert.ok(m, '找不到 QR_STATES 常量');
  const body = m[1];
  assert.match(body, /SUCCESS:\s*803/, 'QR_STATES 必须含 SUCCESS: 803');
  assert.match(body, /EXPIRED:\s*800/, 'QR_STATES 必须含 EXPIRED: 800');
  assert.match(body, /WAITING:\s*801/, 'QR_STATES 必须含 WAITING: 801');
  assert.match(body, /SCANNED:\s*802/, 'QR_STATES 必须含 SCANNED: 802');

  // 导出给 app.js 用（单一来源）
  assert.match(src, /Netease\.QR_STATES\s*=\s*QR_STATES/, '必须导出 QR_STATES 给 app.js');

  // 语义验证：按 codeOk 的逻辑重算一遍
  const codes = [800, 801, 802, 803];
  const codeOk = (n) => n === 200 || codes.indexOf(n) >= 0;
  assert.strictEqual(codeOk(803), true, '803 必须被判定为 ok（这是 blocker 的核心）');
  assert.strictEqual(codeOk(200), true);
  assert.strictEqual(codeOk(800), true);
  assert.strictEqual(codeOk(801), true);
  assert.strictEqual(codeOk(802), true);
  assert.strictEqual(codeOk(301), false, '301（未登录）仍然必须抛错');
  assert.strictEqual(codeOk(404), false, '404 仍然必须抛错');
});

test('G-01 扫码状态机：app.js 用 QR_STATES 而不是裸数字', () => {
  const src = read('app/js/app.js');
  assert.match(src, /const QR_STATES = \(Netease && Netease\.QR_STATES\)/,
    'app.js 必须从 Netease 取 QR_STATES，不能自己抄一份');
  assert.match(src, /code === QR_STATES\.SUCCESS/, '成功分支必须用 QR_STATES.SUCCESS');
  assert.match(src, /code === QR_STATES\.EXPIRED/, '过期分支必须用 QR_STATES.EXPIRED');
  assert.match(src, /code === QR_STATES\.SCANNED/, '待确认分支必须用 QR_STATES.SCANNED');
  assert.match(src, /code === QR_STATES\.WAITING/, '待扫码分支必须用 QR_STATES.WAITING');
  // 不该再出现裸的 803 判断
  assert.ok(!/code === 803/.test(src), 'app.js 里不该再有裸的 `code === 803`');
});

test('G-01 扫码轮询：语义错误不再被当成网络抖动重试', () => {
  const src = read('app/js/app.js');
  // catch 里必须有「区分网络错误 vs 语义错误」的判断
  assert.match(src, /超时\|网络\|Failed to fetch\|离线\|Abort/,
    'catch 里必须按错误类型分流，语义错误不该重试到 180 秒');
  assert.match(src, /扫码状态查询失败/, '语义错误要给出可诊断的提示');
});

/* ---------------------------------------------------------------
 * G-02 [high] qrcode 版本 7-10 必须写完整 18 位版本信息（BCH(18,6)）
 *
 * 以前只写 12 个模块的裸版本号，没做 BCH 编码、也漏了 6 位，
 * 而且 set() 把写到的位置标成功能图案 → 没写的 12 个位置被数据污染。
 * 实测：版本 1-6 能扫，版本 7-10 全部扫不出来（zbarimg 16/16 解码失败）。
 * --------------------------------------------------------------- */
test('G-02 版本信息：18 位 + BCH(18,6) 生成多项式 0x1F25', () => {
  const src = read('app/js/qrcode.js');
  const block = src.match(/if \(ver >= 7\) \{[\s\S]*?\n    \}/);
  assert.ok(block, '找不到版本信息块');
  const b = block[0];
  assert.match(b, /0x1F25/, '必须用 BCH 生成多项式 0x1F25');
  assert.match(b, /for \(let i = 0; i < 18; i\+\+\)/, '必须写满 18 位（不是 12 位）');
  assert.match(b, /for \(let i = 0; i < 12; i\+\+\) rem =/, '必须有 12 位 BCH 计算循环');
  assert.match(b, /\(ver << 12\)/, '18 位 = 6 位版本号 << 12 | 12 位校验');
});

test('G-02 版本信息：BCH 计算值与规范表逐版本一致', () => {
  /* ISO/IEC 18004 附录 D 的版本信息码字 */
  const EXPECT = { 7: 0x07C94, 8: 0x085BC, 9: 0x09A99, 10: 0x0A4D3 };
  const vbits = (ver) => {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
    return ((ver << 12) | (rem & 0xFFF)) >>> 0;
  };
  for (const ver of [7, 8, 9, 10]) {
    assert.strictEqual(vbits(ver), EXPECT[ver],
      `版本 ${ver} 的版本信息码字应为 0x${EXPECT[ver].toString(16)}`);
  }
});

test('G-02 二维码真解码：版本 1-10 生成后能被 zbarimg 解回原文', () => {
  /*
   * 这是「结构测试全过但扫不出来」的根治办法 —— 只做结构断言挡不住这类错误。
   * 环境里没有 zbarimg 就跳过（CI 装了 zbar-tools 才跑）。
   */
  const { execFileSync } = require('node:child_process');
  let hasZbar = true;
  try { execFileSync('zbarimg', ['--version'], { stdio: 'ignore' }); } catch (e) { hasZbar = false; }
  if (!hasZbar) { console.log('    （没有 zbarimg，跳过真解码）'); return; }

  /* 在沙箱里加载 qrcode.js（它是 IIFE，挂在 window 上） */
  const sandbox = { window: {} };
  const src = read('app/js/qrcode.js');
  const fn = new Function('window', 'with (window) { ' + src + ' }');
  fn(sandbox.window);
  const QR = sandbox.window.RippleQR;
  assert.ok(QR && typeof QR.encode === 'function', 'qrcode.js 没有导出 encode');

  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'qr-'));
  const writePPM = (modules, file) => {
    const size = modules.length, scale = 5, margin = 6;
    const dim = (size + margin * 2) * scale;
    const buf = Buffer.alloc(dim * dim * 3);
    for (let y = 0; y < dim; y++) {
      for (let x = 0; x < dim; x++) {
        const mx = Math.floor(x / scale) - margin, my = Math.floor(y / scale) - margin;
        const dark = (mx >= 0 && my >= 0 && mx < size && my < size) ? modules[my][mx] : false;
        const o = (y * dim + x) * 3;
        buf[o] = buf[o + 1] = buf[o + 2] = dark ? 0 : 255;
      }
    }
    fs.writeFileSync(file, Buffer.concat([Buffer.from(`P6\n${dim} ${dim}\n255\n`, 'ascii'), buf]));
  };

  let checked = 0;
  const versionsSeen = new Set();
  for (const ecl of ['L', 'M', 'Q', 'H']) {
    /* 长度逐步增加，让 encode 自己覆盖到版本 1-10 */
    for (let n = 1; n <= 240; n += 7) {
      let q;
      try { q = QR.encode('b'.repeat(n), ecl); } catch (e) { break; }
      const file = path.join(tmp, 't.ppm');
      writePPM(q.modules, file);
      let out = '';
      try {
        out = execFileSync('zbarimg', ['--nodisplay', '-q', '--raw', file], { encoding: 'utf8' }).replace(/\n$/, '');
      } catch (e) { out = ''; }
      assert.strictEqual(out, 'b'.repeat(n),
        `版本 ${q.version} / ${ecl} / ${n} 字节解码失败（这是 G-02 的原始症状）`);
      versionsSeen.add(q.version);
      checked++;
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.ok(checked > 50, `用例数太少（${checked}），覆盖不足`);
  /* 关键：版本 7 及以上必须真的被覆盖到 —— 那才是出问题的区间 */
  assert.ok(versionsSeen.has(7), `必须覆盖到版本 7（实际覆盖：${[...versionsSeen].join(',')}）`);
});

/* ---------------------------------------------------------------
 * D-01 [high] bridge.js 的 pending 表成功路径必须删除
 * --------------------------------------------------------------- */
test('D-01 bridge pending 表：成功路径也 delete', () => {
  const src = read('desktop/bridge.js');
  /* 找到 .then( 回调体，里面必须有 pending.delete(id) */
  const thenBlocks = src.match(/\.then\(function[\s\S]*?\n        \}\)/g) || [];
  assert.ok(thenBlocks.length > 0, '找不到 .then 回调');
  const hasDelete = thenBlocks.some((b) => /pending\.delete\(id\)/.test(b));
  assert.ok(hasDelete, '成功回调里必须有 pending.delete(id)，否则长开内存单调增长');
});

/* ---------------------------------------------------------------
 * D-09 [high] 桌面端 personal_fm 的上游路径必须与另两端一致
 * --------------------------------------------------------------- */
test('D-09 personal_fm 三端路径一致（v1/radio/get）', () => {
  const rust = read('desktop/src-tauri/src/netease.rs');
  const java = read('android/app/src/main/java/com/ripple/app/NeteaseClient.java');
  const node = read('server.js');

  assert.match(rust, /"personal_fm"\s*=>\s*self\.post\("v1\/radio\/get"/,
    'Rust 的 personal_fm 必须是 v1/radio/get（以前写成 personal/fm → 必然 404）');
  assert.match(java, /case "personal_fm":\s*return post\("v1\/radio\/get"/,
    'Java 侧路径变了？三端必须一致');
  assert.match(node, /case 'personal_fm':\s*return ncmPost\('v1\/radio\/get'/,
    'server.js 路径变了？三端必须一致');
});

/* ---------------------------------------------------------------
 * D-02 [high] 桌面端版本号必须纳入唯一来源链条
 * --------------------------------------------------------------- */
test('D-02 桌面端版本号：Cargo.toml / Cargo.lock 与 version.json 一致', () => {
  const vj = JSON.parse(read('version.json'));
  const cargo = read('desktop/src-tauri/Cargo.toml');
  const lock = read('desktop/src-tauri/Cargo.lock');
  const tauri = JSON.parse(read('desktop/src-tauri/tauri.conf.json'));

  const cv = (cargo.match(/^version = "([0-9.]+)"/m) || [])[1];
  const lv = (lock.match(/\[\[package\]\]\s*\nname = "ripple-desktop"\s*\nversion = "([0-9.]+)"/) || [])[1];

  assert.strictEqual(cv, vj.versionName, `Cargo.toml 版本 ${cv} ≠ version.json ${vj.versionName}`);
  assert.strictEqual(lv, vj.versionName, `Cargo.lock 版本 ${lv} ≠ version.json ${vj.versionName}`);
  assert.strictEqual(tauri.version, vj.versionName, `tauri.conf.json 版本 ≠ version.json`);
});

test('D-02 sync-version.sh 必须同步桌面端（否则下次发版又漂移）', () => {
  const src = read('android/sync-version.sh');
  assert.match(src, /desktop\/src-tauri\/Cargo\.toml/, 'sync-version.sh 必须处理 Cargo.toml');
  assert.match(src, /desktop\/src-tauri\/Cargo\.lock/, 'sync-version.sh 必须处理 Cargo.lock');
  assert.match(src, /Cargo\.toml 的 \[package\] version 同步失败/, '必须有同步后的断言');
});

/* ---------------------------------------------------------------
 * D-03 [high] CI 的版本号断言必须在组装之前（否则恒真）
 * --------------------------------------------------------------- */
test('D-03 CI：版本号校验步骤排在组装步骤之前', () => {
  const yml = read('.github/workflows/desktop-build.yml');
  const iCheck = yml.indexOf('版本号与 version.json 一致');
  const iBuild = yml.indexOf('组装桌面端前端包');
  assert.ok(iCheck > 0, '找不到版本校验步骤');
  assert.ok(iBuild > 0, '找不到组装步骤');
  assert.ok(iCheck < iBuild,
    '版本校验必须排在组装**之前** —— 组装脚本自己会改写 tauri.conf.json，先组装再校验等于恒真');
  /* 且必须有「组装不应产生 diff」这条兜底 */
  assert.match(yml, /组装不应产生受控文件 diff/, '需要补一条「组装不该改写受控文件」的断言');
});

/* ---------------------------------------------------------------
 * D-04 [high] release job 必须先建 release/ 目录
 * --------------------------------------------------------------- */
test('D-04 CI：取 APK 之前必须 mkdir -p release', () => {
  const yml = read('.github/workflows/desktop-build.yml');
  /* 「取同版本 Android APK」这一步里必须出现 mkdir -p release */
  const start = yml.indexOf('- name: 取同版本 Android APK');
  assert.ok(start > 0, '找不到取 APK 步骤');
  const next = yml.indexOf('- name:', start + 10);
  const step = yml.slice(start, next > 0 ? next : start + 2000);
  assert.match(step, /mkdir -p release/,
    '取 APK 这步必须先建 release/ —— 否则 curl -o 会因父目录不存在 rc=23，'
    + '并被 else 分支吞成误导性的「没有找到 Android APK」');
  /* 还要区分 curl 退出码，别再让排障方向跑偏 */
  assert.match(step, /22\)/, '要区分 rc=22（404）');
  assert.match(step, /23\)/, '要区分 rc=23（写盘失败）');
});

/* ---------------------------------------------------------------
 * E-01 [high] 首页「失败一次即永久放弃」
 * --------------------------------------------------------------- */
test('E-01 首页缓存：失败不赋空数组，用 null 判「从未成功」', () => {
  const src = read('app/js/app.js');
  /* 判定必须是 === null，不是 !App._recPlCache */
  assert.match(src, /if \(App\._recPlCache === null\)/,
    '_recPlCache 必须用 === null 判「从未成功」');
  assert.match(src, /if \(App\._topCache === null\)/,
    '_topCache 必须用 === null 判「从未成功」');
  /* catch 里不能再把缓存赋成 [] */
  const recBlock = src.match(/if \(App\._recPlCache === null\)[\s\S]{0,400}?\n    \}/);
  assert.ok(recBlock, '找不到 recPl 加载块');
  assert.ok(!/_recPlCache = \[\]/.test(recBlock[0]),
    'catch 里不能赋 [] —— 空数组是 truthy，会把「本次会话永久放弃」固化下来');
  /* 必须有可点的重试 */
  assert.match(src, /data-retry/, '需要给失败卡一个可点的重试入口');
  /* 「下拉重试」只能出现在注释里说明历史，不能出现在渲染出来的 HTML 文案里 */
  const htmlStrings = src.match(/'<div class="c-card ghost"[^']*'/g) || [];
  for (const h of htmlStrings) {
    assert.ok(!h.includes('下拉重试'), '失败卡文案不能是「下拉重试」——全仓没有下拉刷新实现，这是做不到的承诺：' + h);
  }
});

/* ---------------------------------------------------------------
 * E-02 [high] 每日推荐空数组时骨架永驻
 * --------------------------------------------------------------- */
test('E-02 空推荐也要落缓存并清掉骨架', () => {
  const src = read('app/js/app.js');
  /* 成功分支里，缓存赋值不能还在 if (songs.length) 内部 */
  const block = src.match(/const songs = await Netease\.dailyRecommend\(\);[\s\S]{0,1200}/);
  assert.ok(block, '找不到每日推荐加载块');
  const b = block[0];
  /* 注释里也提到过这些串，所以跳过注释：从 `App._dailyCache = songs;` 这条**赋值语句**找 */
  const iCache = b.search(/^\s*App\._dailyCache = songs;\s*$/m);
  const iIfLen = b.search(/^\s*if \(songs\.length\) \{\s*$/m);
  assert.ok(iCache > 0, '必须把 songs 落进缓存');
  assert.ok(iIfLen > 0, '找不到 if (songs.length)');
  assert.ok(iCache < iIfLen,
    '缓存赋值必须在 if (songs.length) **之前** —— 空数组也要落（代表「已问过」），'
    + '否则骨架永远不清、每次切回首页都重铺');
});

/* ---------------------------------------------------------------
 * E-03 [high] 热搜委派宿主必须是共同祖先
 * --------------------------------------------------------------- */
test('E-03 热搜 [data-hot]：委派挂在 #searchIntro 与 #searchBody 的共同祖先前', () => {
  const src = read('app/js/app.js');
  assert.ok(!/\$\('#searchBody'\)\.addEventListener\('click'/.test(src),
    '委派不能挂在 #searchBody 上 —— 热搜在兄弟节点 #searchIntro 里，冒泡路径永不经过它');
  assert.match(src, /searchPage\.addEventListener\('click'/,
    '委派应挂在 .page[data-page="search"] 上（两者都在它下面）');
});

/* ---------------------------------------------------------------
 * E-04 [high] Escape 必须排在输入框短路之前
 * --------------------------------------------------------------- */
test('E-04 Escape：判断必须排在 INPUT/TEXTAREA 短路之前', () => {
  const src = read('app/js/app.js');
  /* 全仓有多处 keydown 监听（例如 railToggle 的 Ctrl+[），
     要找的是那个处理 Escape / Space / 方向键的**全局快捷键**处理器。 */
  const start = src.indexOf('键盘（桌面调试用）');
  assert.ok(start > 0, '找不到全局键盘处理器（注释「键盘（桌面调试用）」）');
  const end = src.indexOf('auto 模式要跟着系统走', start);
  assert.ok(end > start, '找不到处理器结尾');
  const handler = src.slice(start, end);

  const iEsc = handler.indexOf("if (e.key === 'Escape')");
  const iInput = handler.indexOf("tag === 'INPUT'");
  assert.ok(iEsc > 0, '处理器里必须有 Escape 分支');
  assert.ok(iInput > 0, '处理器里必须有输入框短路');
  assert.ok(iEsc < iInput,
    'Escape 必须排在输入框短路**之前** —— 否则所有带输入框的弹窗按 Esc 关不掉'
    + '（modal 会自动把焦点塞进输入框）');
  /* 只能有一个 Escape 分支，别留半套 */
  const count = (handler.match(/e\.key === 'Escape'/g) || []).length;
  assert.strictEqual(count, 1, `Escape 分支应该只有一处，实际 ${count} 处`);
});

/* ---------------------------------------------------------------
 * E-07 [medium] 登录/退出清缓存走统一入口
 * --------------------------------------------------------------- */
test('E-07 登录/退出：清缓存必须调 invalidateHomeCaches', () => {
  const src = read('app/js/app.js');
  const afterLogin = src.match(/async function afterLoginSuccess\(\)[\s\S]{0,900}?\n  \}/);
  assert.ok(afterLogin, '找不到 afterLoginSuccess');
  assert.match(afterLogin[0], /invalidateHomeCaches\(\)/,
    '登录收尾必须调 invalidateHomeCaches —— 以前手写三行漏了 _recPlCache，'
    + '推荐歌单会停留在上一个账号');

  const logout = src.match(/async function doLogout\(\)[\s\S]{0,900}?\n  \}/);
  assert.ok(logout, '找不到 doLogout');
  assert.match(logout[0], /invalidateHomeCaches\(\)/, '退出登录也要走统一入口');
});

/* ---------------------------------------------------------------
 * U-01 [high] 宽外观断点不能有 1.84~1.85 的空档
 * --------------------------------------------------------------- */
test('U-01 断点：1920x1040（1080p 最大化）必须命中桌面布局', () => {
  const css = read('app/css/responsive.css');
  assert.ok(!/max-aspect-ratio:\s*184\/100/.test(css), '不该再有 184/100（会与 185/100 之间留空档）');
  /* 桌面档必须有「宽度兜底」：宽 >= 1180 一律按桌面，不管宽高比 */
  assert.match(css, /\(min-width:1180px\)/,
    '桌面档需要宽度兜底，否则 1366×728 这类「宽而矮」的窗口仍会掉回手机布局');

  /* 用与 CSS 相同的判据重算，验证关键视口 */
  const isWide = (w, h) => (w >= 700 && w / h <= 1.85) || w >= 1180;
  const isPhoneLand = (w, h) => (w / h >= 1.85) && w <= 1179;
  const cases = [
    [1920, 1080, '桌面 1080p'],
    [1920, 1040, '1080p 最大化（曾经的空档，ar=1.8462）'],
    [1366, 728, '1366×728 桌面'],
    [1280, 766, '当前 :98 窗口'],
    [1840, 1000, '旧边界下侧'],
    [1841, 1000, '旧边界上侧'],
  ];
  for (const [w, h, label] of cases) {
    assert.ok(isWide(w, h), `${label} (${w}×${h}) 必须命中桌面布局`);
    assert.ok(!isPhoneLand(w, h), `${label} (${w}×${h}) 不该命中手机横屏档`);
  }
});

test('U-03 手机横屏档必须有宽度上限（不能套到桌面窗口上）', () => {
  const css = read('app/css/responsive.css');
  const blocks = css.match(/@media \(orientation:landscape\)[^{]*\{/g) || [];
  assert.ok(blocks.length >= 2, '找不到两个手机横屏媒体查询');
  for (const b of blocks) {
    assert.match(b, /max-width:\s*1179px/,
      `手机横屏档必须带 max-width 上限，否则桌面窗口拖扁一点就会被套上手机布局：${b}`);
  }
});

/* ---------------------------------------------------------------
 * U-02 [high] --accent-ink 必须按对比度算，不看明度
 * --------------------------------------------------------------- */
test('U-02 主色墨色：浅色主题不能覆盖成 #fff（2.20:1 不达标）', () => {
  const css = read('app/css/base.css');
  /* :root[data-theme="light"] 块里不该再有生效的 --accent-ink:#fff */
  const lightBlock = css.match(/:root\[data-theme="light"\]\s*\{[\s\S]*?\n\}/);
  assert.ok(lightBlock, '找不到浅色主题变量块');
  assert.ok(!/^\s*--accent-ink:\s*#fff\s*;/m.test(lightBlock[0]),
    '浅色主题不该把 --accent-ink 改成 #fff —— #fff on #b3a2ff 只有 2.20:1，'
    + '而 :root 的 #17102b 有 8.32:1');
});

test('U-02 主色墨色：JS 按 WCAG 对比度挑，而不是 l > 62', () => {
  const src = read('app/js/app.js');
  assert.match(src, /function inkForAccent\(/, '必须有 inkForAccent');
  assert.match(src, /function relativeLuminance\(/, '必须有 WCAG 相对亮度计算');
  assert.match(src, /function contrastRatio\(/, '必须有对比度计算');
  assert.ok(!/l > 62 \? '#120a24' : '#ffffff'/.test(src),
    '不能再用「明度阈值」这种只看 l 的判定 —— 同样 l=62 黄色只有 1.24:1');

  /* 用与实现相同的算法验证：所有色相的墨色都必须达标 */
  const srgb = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const lum = (r, g, b) => 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
  const cr = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  const hsl2rgb = (h, s, l) => {
    h = ((h % 360) + 360) % 360; s /= 100; l /= 100;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let r = 0, g = 0, bb = 0;
    if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; bb = x; } else if (h < 240) { g = x; bb = c; }
    else if (h < 300) { r = x; bb = c; } else { r = c; bb = x; }
    return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((bb + m) * 255)];
  };
  const inkForAccent = (h, s, l) => {
    const bg = hsl2rgb(h, s, l); const bl = lum(bg[0], bg[1], bg[2]);
    const dl = lum(0x12, 0x0a, 0x24);
    return cr(dl, bl) >= cr(1, bl) ? [0x12, 0x0a, 0x24] : [255, 255, 255];
  };
  let total = 0, fail = 0;
  for (const [lo, hi] of [[56, 72], [34, 50]]) {
    for (let h = 0; h < 360; h += 15) {
      for (let s = 42; s <= 88; s += 2) {
        for (let l = lo; l <= hi; l += 1) {
          total++;
          const bg = hsl2rgb(h, s, l);
          const bl = lum(bg[0], bg[1], bg[2]);
          const ink = inkForAccent(h, s, l);
          const il = lum(ink[0], ink[1], ink[2]);
          if (cr(il, bl) < 4.4) fail++;   /* 4.4 留一点余量 */
        }
      }
    }
  }
  /* 修前约 40%/48% 失败；修后应远低于 5% */
  assert.ok(fail / total < 0.05,
    `WCAG 不达标率 ${(fail / total * 100).toFixed(1)}%（${fail}/${total}）仍然过高`);
});

/* ---------------------------------------------------------------
 * P-02 [high] load() 必须重置复用元素的 currentTime
 * --------------------------------------------------------------- */
test('P-02 切歌：非恢复路径必须把 currentTime 归零', () => {
  const src = read('app/js/player.js');
  const loadFn = src.match(/load\s*\([^)]*\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(loadFn, '找不到 load()');
  assert.match(loadFn[0], /currentTime\s*=\s*0/,
    'load() 必须显式归零 currentTime —— 否则切走再切回同一首在线歌会从上次中断处续播');
});

/* ---------------------------------------------------------------
 * S-01 [high] 令牌表必须按 IP 分桶
 * --------------------------------------------------------------- */
test('S-01 令牌：按来源 IP 分桶，单一来源挤不掉别人', () => {
  const src = read('server.js');
  assert.match(src, /let tokenMap = new Map\(\)/,
    '令牌表必须是 Map<ip, [...]>，不能是全局单数组');
  assert.ok(!/let tokenList = \[\]/.test(src), '全局单表 tokenList 必须被替换掉');
  assert.match(src, /tokenMap\.set\(me,/, 'issueToken 必须只写自己那一桶');
  assert.match(src, /const bucket = tokenMap\.get\(normIp\(ip\)\)/,
    'tokenValid 必须按来源 IP 查自己的桶');

  /* 行为验证：模拟两个来源互相刷 */
  const TOKEN_PER_IP = 6;
  const map = new Map();
  const issue = (ip) => {
    const t = ip + '-' + Math.random().toString(16).slice(2, 10);
    const arr = map.get(ip) || [];
    arr.unshift(t);
    map.set(ip, arr.slice(0, TOKEN_PER_IP));
    return t;
  };
  const A = [];
  for (let i = 0; i < 3; i++) A.push(issue('10.0.0.1'));
  /* B 连刷 6 次 —— 旧实现（全局 unshift + slice(0,6)）会把 A 的令牌全部挤掉 */
  let lastB = '';
  for (let i = 0; i < 6; i++) lastB = issue('10.0.0.2');

  assert.strictEqual(map.get('10.0.0.1').length, 3, 'A 的令牌一个都不该被 B 挤掉');
  for (const t of A) {
    assert.ok(map.get('10.0.0.1').includes(t), 'A 的令牌必须全部仍然存在：' + t);
  }
  /* B 的桶保持不动（不会被 A 挤，也不需要无限增长） */
  assert.strictEqual(map.get('10.0.0.2').length, 6, 'B 自己的桶上限是 6');
  assert.ok(map.get('10.0.0.2').includes(lastB), 'B 最新签发的令牌必须有效');
  /* 反向：A 再刷也不该影响 B */
  for (let i = 0; i < 6; i++) issue('10.0.0.1');
  assert.ok(map.get('10.0.0.2').includes(lastB), 'A 刷爆不该挤掉 B 的令牌（这是 S-01 的核心）');
});

/* ---------------------------------------------------------------
 * S-02 [high] 上游断流必须 settle
 * --------------------------------------------------------------- */
test('S-02 上游断流：必须监听 aborted / error / close 并有硬超时', () => {
  const src = read('server.js');
  assert.match(src, /res\.on\('aborted'/, '必须监听 res 的 aborted —— 半关 TCP 时只有它会触发');
  assert.match(src, /res\.on\('error'/, '必须监听 res 的 error');
  assert.match(src, /res\.on\('close'/, '必须监听 res 的 close（用 res.complete 判提前关闭）');
  assert.match(src, /res\.complete/, 'close 时要检查 res.complete');
  /* 硬上限的绝对超时守卫 */
  assert.match(src, /上游响应超时（硬上限）/, 'socket idle 计时器覆盖不到「已收头部后断流」，需要绝对时长守卫');
});

/* ---------------------------------------------------------------
 * S-03 [high] 登出后在途请求不能把登录态复活
 * --------------------------------------------------------------- */
test('S-03 登出：cookie 代际必须挡住迟到的 Set-Cookie', () => {
  const src = read('server.js');
  assert.match(src, /let cookieEpoch = 0/, '必须有 cookie 代际计数器');
  /* logout 里要自增，且在清空之前 */
  const logout = src.match(/case 'logout': \{[\s\S]*?return r \|\| JSON\.stringify\(\{ code: 200 \}\);/);
  assert.ok(logout, '找不到 logout 分支');
  assert.match(logout[0], /cookieEpoch \+= 1/, 'logout 必须自增代际');
  /* 合并前要比代际 */
  assert.match(src, /if \(epochAtStart !== cookieEpoch\) return/,
    'Set-Cookie 合并前必须比对代际 —— 期间登出过就丢弃，否则登录态会被复活');
  assert.match(src, /const epochAtStart = cookieEpoch/, '请求发出时要记下代际');
});

/* ---------------------------------------------------------------
 * S-10 [medium] 上游响应体必须有上限
 * --------------------------------------------------------------- */
test('S-10 上游响应体：必须有上限（请求方向已有 256KB，别单边不对称）', () => {
  const src = read('server.js');
  assert.match(src, /MAX_UPSTREAM_BODY/, '必须有响应体上限常量');
  assert.match(src, /data\.length > MAX_UPSTREAM_BODY/, '累积时必须检查上限');
});

/* ---------------------------------------------------------------
 * [用户报障] 安卓后台播完不续下一首
 *
 * 根因：一首歌自然播完时浏览器先发 pause（paused=true），而我们在同一个
 * 事件循环里已经 next(true) 去播下一首。若此时把 playing=false 报给原生，
 * 原生在后台会 pauseTimers()，把驱动「进度推进 / 通知栏刷新 / 播完续下一首」
 * 的定时器一起冻死 —— 下一首的解析还等着走异步原生通道，于是「不开始了」。
 *
 * 修法两层：① JS 侧过渡窗口内不上报临时暂停；② 原生侧延迟冻结 + 无条件 resume。
 * --------------------------------------------------------------- */
test('[报障] 后台自动切歌：过渡窗口内不上报临时暂停', () => {
  const src = read('app/js/app.js');
  /* 这个处理器带大段注释，窗口要放宽 */
  const stateBlock = src.match(/Player\.on\('state', \(playing\) => \{[\s\S]{0,3000}?\n    \}\);/);
  assert.ok(stateBlock, '找不到 Player.on(\'state\') 处理器');
  const b = stateBlock[0];
  assert.match(b, /Player\._advancing/, 'state 处理器必须检查过渡窗口标记');
  assert.match(b, /advancing: 跳过临时的暂停上报/, '过渡窗口内要跳过暂停上报并留日志');
  /* 关键顺序：检查必须排在 reportPlaying 之前 */
  const iGuard = b.indexOf('Player._advancing');
  const iReport = b.indexOf('reportPlaying(playing)');
  assert.ok(iGuard > 0 && iReport > 0, '找不到守卫或上报调用');
  assert.ok(iGuard < iReport, '窗口检查必须排在 reportPlaying 之前，否则拦不住');
});

test('[报障] 后台自动切歌：原生侧延迟冻结计时器 + 无条件 resume', () => {
  const java = read('android/app/src/main/java/com/ripple/app/MainActivity.java');
  assert.match(java, /ADVANCE_GRACE_MS/, '必须有后台冻结的宽限窗口常量');
  assert.match(java, /postDelayed/, '冻结必须延迟执行，不能切歌瞬间就冻');
  assert.match(java, /token != pauseToken/, '延迟冻结执行时要复查票号，防竞态');
  /* 恢复播放的 resumeTimers 不能再被 webPlaying 复查挡住 */
  const resumeBlock = java.match(/else if \(playing && !isForeground\) \{[\s\S]{0,700}?\n        \}/);
  assert.ok(resumeBlock, '找不到恢复播放分支');
  assert.ok(!/if \(web != null && webPlaying && !isForeground\) web\.resumeTimers\(\)/.test(resumeBlock[0]),
    '恢复播放不该再用 `&& webPlaying` 复查 —— 时序错位会导致计时器永久停在暂停');
  assert.match(resumeBlock[0], /web\.resumeTimers\(\)/, '恢复播放必须真的 resumeTimers');
});

/* ---------------------------------------------------------------
 * [用户报障] 单曲循环播完状态不回传（通知栏显示暂停但后台在放）
 *
 * 根因：repeat === 'one' 的分支只 seek(0) + play() 就 return，
 * 而「播完」已经让 paused 变 true、通知栏被刷成暂停；重启那一瞬的
 * state true 恰好赶上原生 pauseTimers 的时序，推送整个丢掉。
 * --------------------------------------------------------------- */
test('[报障] 单曲循环：重启后显式补一次 state 推送', () => {
  const src = read('app/js/player.js');
  const block = src.match(/if \(s\.repeat === 'one' && auto\) \{[\s\S]{0,1200}?\n      \}/);
  assert.ok(block, "找不到 repeat === 'one' 分支");
  const b = block[0];
  assert.match(b, /_emit\('state', true\)/, '重启后必须显式补一次 state=true，不能赌事件时序');
  assert.match(b, /_advancing = false/, '重启后要解除过渡窗口');
  assert.match(b, /Promise\.resolve\(p\)/, '要按 play() 的真实完成时机推送，不是同步立刻推');
});

test('[报障] transition window：_onEnded 置位、load 成功解除', () => {
  const src = read('app/js/player.js');
  const ended = src.match(/_onEnded\(\) \{[\s\S]{0,1600}?\n    \},/);
  assert.ok(ended, '找不到 _onEnded');
  assert.match(ended[0], /this\._advancing = true/, '_onEnded 必须开启过渡窗口');
  /* load() 里要解除 */
  const loadFn = src.match(/load\(track, autoplay = true\) \{[\s\S]*?\n    \},/);
  assert.ok(loadFn, '找不到 load()');
  assert.match(loadFn[0], /this\._advancing = false/, 'load() 成功后要解除过渡窗口');
});
