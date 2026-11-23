/* ============================================================
   「名单一致性」检查（审查 3.1 —— 本仓库的头号缺陷模式）

   背景：1.1.0 / 1.2.1 / 1.2.2 / 1.3.0 四轮审查，最集中的主题都是同一件事：
   **同一份名单抄成多份，然后各走各的**。
   1.3.0 的四轮复发：
     ① 扫码状态码 —— app.js 等 803，netease.js 白名单没有 803 → blocker，扫码登录全断
     ② 上游命令路径 —— Rust 写 personal/fm，另两端是 v1/radio/get → 桌面漫游兜底 404
     ③ 首页缓存清理 —— invalidateHomeCaches 全量，登录/退出路径各漏一项
     ④ 版本号 —— version.json 唯一来源，但 Cargo.toml/Cargo.lock 无人管

   这类缺陷的共同特征是：**单看任何一处都「读起来没问题」**，
   只有把几处放在一起比才看得出来。所以最有效的防护不是「注意一点」，
   而是让机器替人做这个比对 —— 就是本文件。

   检查项：
     A. 三端命令名集合必须完全相等（app/js → Java → server.js → Rust）
     B. 三端上游路径必须逐条相同（同一个命令在三端打到同一个 path）
     C. 扫码状态码单一来源（803 必须在白名单里）
     D. 版本号四处一致
     E. 首页缓存清理只允许一个入口

   跑法：node scripts/check-manifest-consistency.js
   退出码：0 = 一致；1 = 有不一致（CI 直接红）
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let failures = 0;
const fail = (msg) => { console.error('  ✗ ' + msg); failures++; };
const ok = (msg) => console.log('  ✓ ' + msg);

/* ---------------------------------------------------------------
 * A + B：命令名与上游路径
 *
 * 三端各有一份「命令名 → 上游 path」的映射：
 *   · app/js/netease.js  —— 前端调用（命令名清单的源头）
 *   · server.js          —— Node 侧 case 'xxx': ncmPost('path', ...)
 *   · Android NeteaseClient.java —— case "xxx": return post("path", ...)
 *   · desktop/src-tauri/src/netease.rs —— "xxx" => self.post("path", ...)
 * --------------------------------------------------------------- */

/** 从前端提取它真正调用的命令名 */
function frontendCommands() {
  const src = read('app/js/netease.js');
  const set = new Set();
  /* call('cmd' / call("cmd" */
  for (const m of src.matchAll(/\bcall\(\s*'([a-z_]+)'/g)) set.add(m[1]);
  for (const m of src.matchAll(/\bcall\(\s*"([a-z_]+)"/g)) set.add(m[1]);
  return set;
}

/** 从某个文本里提取 cmd → path 映射 */
function extractMap(src, patterns) {
  const map = new Map();
  for (const re of patterns) {
    for (const m of src.matchAll(re)) {
      /* m[1] = 命令名，m[2] = 上游 path */
      if (m[1] && m[2]) map.set(m[1], m[2]);
    }
  }
  return map;
}

function serverMap() {
  return extractMap(read('server.js'), [
    /case\s+'([a-z_]+)'\s*:\s*(?:[\s\S]{0,240}?)return\s+ncmPost\(\s*'([^']+)'/g,
  ]);
}

function javaMap() {
  return extractMap(read('android/app/src/main/java/com/ripple/app/NeteaseClient.java'), [
    /case\s+"([a-z_]+)"\s*:\s*(?:[\s\S]{0,240}?)post\(\s*"([^"]+)"/g,
  ]);
}

function rustMap() {
  return extractMap(read('desktop/src-tauri/src/netease.rs'), [
    /"([a-z_]+)"\s*=>\s*self\.post\(\s*"([^"]+)"/g,
  ]);
}

/**
 * 提取「这个文件实现了哪些命令名」——只看名字，不看路径。
 *
 * 为什么与 extractMap 分开：路径提取的正则要求「case 名 后面紧跟着 post(path)」，
 * 但真实代码里常有中间变量（server.js 的 search 先算 body 再 ncmPost）、
 * 也有委托到方法的情况（Java 的 `case "search": return search(p);`）。
 * 用路径正则去判「有没有实现」会大量误报，所以名字与路径分两套判据。
 */
function implementedNames(src, kind) {
  const set = new Set();
  let re;
  if (kind === 'js') re = /case\s+'([a-z_]+)'\s*:/g;
  else if (kind === 'java') re = /case\s+"([a-z_]+)"\s*:/g;
  else re = /"([a-z_]+)"\s*=>/g;
  for (const m of src.matchAll(re)) set.add(m[1]);
  return set;
}

function checkCommandsAndPaths() {
  console.log('\n[A/B] 三端命令名与上游路径');

  const fe = frontendCommands();
  const node = implementedNames(read('server.js'), 'js');
  const java = implementedNames(read('android/app/src/main/java/com/ripple/app/NeteaseClient.java'), 'java');
  const rust = implementedNames(read('desktop/src-tauri/src/netease.rs'), 'rust');

  /* 路径映射用另一套（要求紧邻 post(path) 的写法） */
  const nodePaths = serverMap();
  const javaPaths = javaMap();
  const rustPaths = rustMap();

  console.log(`  前端调用 ${fe.size} 个命令；server.js ${node.size} 条；Java ${java.size} 条；Rust ${rust.size} 条`);

  /* A. 命令名集合：前端调用的每一个命令，三端都要有 */
  for (const cmd of [...fe].sort()) {
    /* 这 4 条是纯前端/纯本地能力，不该出现在服务端的命令表里 */
    const LOCAL_ONLY = new Set(['logout', 'comment_add']);
    if (LOCAL_ONLY.has(cmd)) continue;
    if (!node.has(cmd)) fail(`命令 "${cmd}" 前端在用，但 server.js 没有实现`);
    if (!java.has(cmd)) fail(`命令 "${cmd}" 前端在用，但 Java 没有实现`);
    if (!rust.has(cmd)) fail(`命令 "${cmd}" 前端在用，但 Rust 没有实现`);
  }

  /* B. 上游路径：同一个命令在三端必须打到同一个 path */
  const allCmds = new Set([...javaPaths.keys(), ...nodePaths.keys(), ...rustPaths.keys()]);
  for (const cmd of [...allCmds].sort()) {
    const paths = [];
    if (javaPaths.has(cmd)) paths.push(['Java', javaPaths.get(cmd)]);
    if (nodePaths.has(cmd)) paths.push(['server.js', nodePaths.get(cmd)]);
    if (rustPaths.has(cmd)) paths.push(['Rust', rustPaths.get(cmd)]);
    if (paths.length < 2) continue;      /* 只有一端实现的命令不求一致 */
    const uniq = new Set(paths.map((p) => p[1]));
    if (uniq.size > 1) {
      fail(`命令 "${cmd}" 三端路径不一致：` + paths.map(([w, p]) => `${w}=${p}`).join(' / '));
    }
  }

  if (failures === 0) ok('命令名与上游路径三端一致');
}

/* ---------------------------------------------------------------
 * C：扫码状态码单一来源
 * --------------------------------------------------------------- */
function checkQrCodes() {
  console.log('\n[C] 扫码状态码单一来源');

  const ne = read('app/js/netease.js');
  const app = read('app/js/app.js');

  /* 803 必须在 QR_STATES 里 */
  const m = ne.match(/const QR_STATES = \{([^}]+)\}/);
  if (!m) { fail('netease.js 里找不到 QR_STATES 常量'); return; }
  for (const [name, code] of [['EXPIRED', 800], ['WAITING', 801], ['SCANNED', 802], ['SUCCESS', 803]]) {
    if (!new RegExp(`${name}:\\s*${code}`).test(m[1])) {
      fail(`QR_STATES 缺少 ${name}: ${code}`);
    }
  }
  /* 白名单必须由 QR_STATE_CODES 驱动 */
  if (!/QR_STATE_CODES\.indexOf\(codeNum\)/.test(ne)) {
    fail('codeOk 白名单必须由 QR_STATE_CODES 驱动（不能再散落字面量）');
  }
  /* app.js 不能自己抄一份，也不能出现裸 803 */
  if (!/Netease\.QR_STATES/.test(app)) {
    fail('app.js 必须从 Netease.QR_STATES 取状态码，不能自己抄一份');
  }
  if (/code === 803/.test(app)) {
    fail('app.js 里不该再有裸的 `code === 803`');
  }
  if (failures === 0) ok('扫码状态码只有一个来源，803 在白名单内');
}

/* ---------------------------------------------------------------
 * D：版本号四处一致
 * --------------------------------------------------------------- */
function checkVersions() {
  console.log('\n[D] 版本号一致性');

  const vj = JSON.parse(read('version.json'));
  const VN = vj.versionName;
  const VC = vj.versionCode;

  const checks = [
    ['desktop/src-tauri/tauri.conf.json', () => JSON.parse(read('desktop/src-tauri/tauri.conf.json')).version],
    ['desktop/src-tauri/Cargo.toml', () => (read('desktop/src-tauri/Cargo.toml').match(/^version = "([0-9.]+)"/m) || [])[1]],
    ['desktop/src-tauri/Cargo.lock', () => (read('desktop/src-tauri/Cargo.lock').match(/\[\[package\]\]\s*\nname = "ripple-desktop"\s*\nversion = "([0-9.]+)"/) || [])[1]],
    ['app/js/version.js', () => (read('app/js/version.js').match(/name: '([0-9.]+)'/) || [])[1]],
  ];
  for (const [file, get] of checks) {
    const v = get();
    if (v !== VN) fail(`${file} 版本 ${v} ≠ version.json ${VN}`);
  }
  const swc = (read('app/sw.js').match(/const CACHE = '([^']+)'/) || [])[1];
  if (swc !== 'ripple-' + VC) fail(`app/sw.js 的 CACHE 应為 ripple-${VC}（实际 ${swc}）`);

  if (failures === 0) ok(`版本号 ${VN} (${VC}) 四处一致`);
}

/* ---------------------------------------------------------------
 * E：首页缓存清理只允许一个入口
 * --------------------------------------------------------------- */
function checkCacheInvalidation() {
  console.log('\n[E] 首页缓存清理入口唯一');

  const app = read('app/js/app.js');
  /*
   * 除了 invalidateHomeCaches 本体，别处不该再手写「整份名单」的清理。
   *
   * 但有一类**合理的单独重置**：首屏失败卡的「点这里重试」（E-01）只需要
   * 把出问题的那一份置空，不该顺手把另外两份也作废 —— 那不是漏项而是精确重试。
   * 所以这里只数「行首缩进 4 空格、单独一行」的那些赋值（= 清理名单里的成员），
   * 排除 `if (...) App._recPlCache = null;` 这种条件式单点重置。
   */
  const standalone = (app.match(/^    App\._recPlCache = null;$/gm) || []).length;
  if (standalone > 1) {
    fail(`「App._recPlCache = null」作为清理名单成员出现了 ${standalone} 次，`
      + '应当只在 invalidateHomeCaches() 里出现一次（这正是 1.3.0 的 E-07 那种漏项）');
  }
  if (!/function invalidateHomeCaches\(\)/.test(app)) {
    fail('找不到 invalidateHomeCaches() —— 它是唯一入口');
  }
  if (failures === 0) ok('首页缓存清理只有一个入口');
}

/* ---------------------------------------------------------------
 * 跑全部
 * --------------------------------------------------------------- */
console.log('名单一致性检查（审查 3.1 的结构性防护）');
checkCommandsAndPaths();
checkQrCodes();
checkVersions();
checkCacheInvalidation();

console.log('');
if (failures === 0) {
  console.log('全部通过 ✓ （三端名单一致）');
  process.exit(0);
}
console.error(`发现 ${failures} 处不一致 ✗`);
console.error('这类问题的典型症状是「单看每一处都没错，合起来就崩」——');
console.error('请把名单提成单一常量并让消费方共用，而不是在这一处偷偷改一下。');
process.exit(1);
