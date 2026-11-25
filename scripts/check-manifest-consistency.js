/* ============================================================
   「名单一致性」检查（审查 3.1 —— 本仓库的头号缺陷模式）

   背景：1.1.0 / 1.2.1 / 1.2.2 / 1.3.0 / 1.3.5 五轮审查，最集中的主题都是同一件事：
   **同一份名单抄成多份，然后各走各的**。
   1.3.0 的四轮复发：
     ① 扫码状态码 —— app.js 等 803，netease.js 白名单没有 803 → blocker，扫码登录全断
     ② 上游命令路径 —— Rust 写 personal/fm，另两端是 v1/radio/get → 桌面漫游兜底 404
     ③ 首页缓存清理 —— invalidateHomeCaches 全量，登录/退出路径各漏一项
     ④ 版本号 —— version.json 唯一来源，但 Cargo.toml/Cargo.lock 无人管
   1.3.5 又是同一形态的两条 blocker：
     ① B-1：Cargo.toml 的 [package].version 陈旧，而三处检查共用一个错误判据 → 同时报绿
     ② H-5：checker 只查 4 处版本副本，sync-version.sh 实际同步 8 处

   这类缺陷的共同特征是：**单看任何一处都「读起来没问题」**，
   只有把几处放在一起比才看得出来。所以最有效的防护不是「注意一点」，
   而是让机器替人做这个比对 —— 就是本文件。

   检查项：
     A. 三端命令名集合必须完全相等（app/js → Java → server.js → Rust）
     B. 三端上游路径必须逐条相同（同一个命令在三端打到同一个 path 集合）
     C. 扫码状态码单一来源（803 必须在白名单里）
     D. 版本号副本一致 —— 走 scripts/version-facts.js（唯一解析器，B-1 / M-4）
     E. 首页缓存清理只允许一个入口
     F. sw.js 的 SHELL 名单 vs index.html 的脚本/样式清单（M-2）
     G. 版本副本清单 ↔ sync-version.sh ↔ CONTRIBUTING.md 三方一致（H-5 自检 / M-6）

   跑法：node scripts/check-manifest-consistency.js
   退出码：0 = 一致；1 = 有不一致（CI 直接红）
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

let failures = 0;
const fail = (msg) => { console.error('  ✗ ' + msg); failures++; };
const ok = (msg) => console.log('  ✓ ' + msg);

/* 让每个检查项能独立记录「本项是否出错」—— 否则 early 检查失败后
   later 的 ok() 会因为 failures>0 而不打印，日志看不出哪项通过。 */
const runSection = (name, fn) => {
  const before = failures;
  try {
    fn();
  } catch (e) {
    fail(`${name} 检查自身抛异常：${e && e.message}`);
  }
  return failures === before;
};

/* ---------------------------------------------------------------
 * 源码预处理
 *
 * 提取「命令 → 上游 path」不能只靠正则碰运气，但也不需要写一个完整
 * 的 Java / Rust / JS 解析器。这里做两件够用的事：
 *   ① 去掉注释（保留字符串内容）—— 否则注释里出现的 post("...") 会被当成实现
 *   ② 用花括号配对切出 case 块 / match 臂 —— 而不是「到下一个 case 为止
 *      的固定字符窗口」。240 字符窗口正是 H-6 里 server.js 的 search 抓不到的原因。
 * --------------------------------------------------------------- */

/** 去注释，保留字符串字面量（含转义处理） */
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      out += c;
      i++;
      while (i < n) {
        const d = src[i];
        out += d;
        if (d === '\\') { out += src[i + 1] === undefined ? '' : src[i + 1]; i += 2; continue; }
        i++;
        if (d === q) break;
      }
      continue;
    }
    if (c === '/' && c2 === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** 从 openIdx 处的 '{' 找到配对的 '}'，返回其下标（找不到 -1） */
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
 * 把「命令名 → 该命令块内的上游 path 集合」里的 path 归一化。
 *
 * 三端对动态段的写法各不相同：
 *   Java   post("v1/resource/comments/R_SO_4_" + id)
 *   JS     ncmPost('v1/resource/comments/R_SO_4_' + cid)
 *   Rust   format!("v1/resource/comments/R_SO_4_{cid}")
 * 归一成 `v1/resource/comments/R_SO_4` 才能逐字比。
 */
function normPath(p) {
  return p
    .replace(/\$\{[^}]*\}/g, '*')
    .replace(/\{[^}]*\}/g, '*')
    .replace(/[_-]*\*$/, '')
    .replace(/[_-]+$/, '');
}

/** 按「到下一个 case 之前」切块（在已确定的 switch 体内） */
function sliceCaseBlocks(region, caseRe) {
  const hits = [...region.matchAll(caseRe)];
  const out = [];
  for (let i = 0; i < hits.length; i++) {
    const start = hits[i].index;
    const end = i + 1 < hits.length ? hits[i + 1].index : region.length;
    out.push([hits[i][1], region.slice(start, end)]);
  }
  return out;
}

/** Java：<method> 名 → 方法体（用花括号配对切，而不是猜缩进） */
function javaMethods(src) {
  const map = new Map();
  const re = /(?:private|public|protected)\s+(?:static\s+)?String\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  for (const m of src.matchAll(re)) {
    const open = src.indexOf('{', m.index + m[0].length);
    if (open < 0) continue;
    const close = matchBrace(src, open);
    if (close < 0) continue;
    map.set(m[1], src.slice(open, close + 1));
  }
  return map;
}

/* ---------------------------------------------------------------
 * A + B：命令名与上游路径
 *
 * 三端各有一份「命令名 → 上游 path」的映射：
 *   · app/js/netease.js  —— 前端调用（命令名清单的源头）
 *   · server.js          —— Node 侧 case 'xxx': ncmPost('path', ...)
 *   · Android NeteaseClient.java —— case "xxx": post("path", ...) / 委托给私有方法
 *   · desktop/src-tauri/src/netease.rs —— "xxx" => { self.post("path") }
 * --------------------------------------------------------------- */

/** 从前端提取它真正调用的命令名 */
function frontendCommands() {
  const src = read('app/js/netease.js');
  const set = new Set();
  for (const m of src.matchAll(/\bcall\(\s*'([a-z_]+)'/g)) set.add(m[1]);
  for (const m of src.matchAll(/\bcall\(\s*"([a-z_]+)"/g)) set.add(m[1]);
  return set;
}

/**
 * Java 侧：扫整个 `switch (cmd)` 块，逐 case 取路径集合。
 *
 * H-6 之前只认「case "x": return post(...)」这种紧邻写法，于是
 *   case "search":       return search(p);
 *   case "recommend":    { ... post("v3/...") ... }
 * 里**委托给私有方法**的那一半完全看不到 —— logout / playlist_tracks /
 * recommend 因此被当成「只有一端实现」而跳过一致性检查。
 * 现在：case 块内直接出现的 post("...") 收进来，并且把块内调用的
 * NeteaseClient 私有方法体递归展开（带环保护），方法体里的 post 也算。
 */
function javaMap(srcRaw) {
  const src = stripComments(srcRaw);
  const methods = javaMethods(src);
  const map = new Map();

  const sw = src.indexOf('switch (cmd)');
  if (sw < 0) return map;
  const braceOpen = src.indexOf('{', sw);
  const braceClose = matchBrace(src, braceOpen);
  if (braceOpen < 0 || braceClose < 0) return map;

  const cases = sliceCaseBlocks(src.slice(braceOpen, braceClose + 1), /case\s+"([a-z_]+)"\s*:/g);
  const collect = (body, seen) => {
    const found = [];
    for (const m of body.matchAll(/\bpost\s*\(\s*"([^"]+)"/g)) found.push(normPath(m[1]));
    for (const m of body.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
      const name = m[1];
      if (name === 'post' || name === 'json' || name === 'codeOf' || seen.has(name)) continue;
      const body2 = methods.get(name);
      if (!body2) continue;
      seen.add(name);
      found.push(...collect(body2, seen));
    }
    return found;
  };
  for (const [cmd, body] of cases) {
    map.set(cmd, [...new Set(collect(body, new Set()))].sort());
  }
  return map;
}

/**
 * Rust 侧：扫整个 `match cmd { ... }` 块，逐 match 臂取路径集合。
 *
 * H-6 之前要求 `"cmd" => self.post("path")` 在同一行紧邻，于是
 *   "recommend" => { let r = self.post(...); ... }
 * 这种「臂内换行/多语句」的写法抓不到。现在按臂切块，臂内任意位置的
 * `.post("...")` 都算；`format!("...")` 形式的动态路径也算（归一化后比）。
 */
function rustMap(srcRaw) {
  const src = stripComments(srcRaw);
  const map = new Map();

  const mw = src.indexOf('match cmd');
  if (mw < 0) return map;
  const braceOpen = src.indexOf('{', mw);
  const braceClose = matchBrace(src, braceOpen);
  if (braceOpen < 0 || braceClose < 0) return map;

  const region = src.slice(braceOpen, braceClose + 1);
  const arms = sliceCaseBlocks(region, /^[ \t]+"([a-z_]+)"\s*=>/gm);
  for (const [cmd, body] of arms) {
    const paths = [];
    for (const m of body.matchAll(/\.post\s*\(\s*"([^"]+)"/g)) paths.push(normPath(m[1]));
    for (const m of body.matchAll(/\.post\s*\(\s*&?format!\s*\(\s*"([^"]+)"/g)) paths.push(normPath(m[1]));
    for (const m of body.matchAll(/\.post\s*\(\s*&?format!\s*\(\s*"([^"]+)"/g)) paths.push(normPath(m[1]));

    // 第三种写法：先算到局部变量，再传引用（comments 就是这样）。
    // 路径被复用一次是因为它要先校验 cid 是纯数字（防路径穿越），
    // 而上面两条正则都要求 format!/字面量紧贴 .post( —— 于是提取不到。
    const locals = new Map();
    for (const m of body.matchAll(/let\s+([a-z_][a-z0-9_]*)\s*(?::\s*String\s*)?=\s*&?format!\s*\(\s*"([^"]+)"/g)) {
      locals.set(m[1], m[2]);
    }
    for (const m of body.matchAll(/let\s+([a-z_][a-z0-9_]*)\s*(?::\s*&?str\s*)?=\s*"([^"]+)"/g)) {
      locals.set(m[1], m[2]);
    }
    for (const [name, tpl] of locals) {
      const used = new RegExp('\\.post\\s*\\(\\s*&?' + name + '\\b').test(body);
      if (used) paths.push(normPath(tpl));
    }

    map.set(cmd, [...new Set(paths)].sort());
  }
  return map;
}

/**
 * server.js 侧：扫整个 `switch (cmd)` 块，逐 case 取路径集合。
 *
 * H-6 之前用「case 名后 240 字符内」的窗口，search 那类
 *   case 'search': { const body = {...}; const r = await ncmPost('cloudsearch/pc', body); }
 * 一超窗口就丢。现在按 case 切块；并且把 `ncmCall('other_cmd', ...)`
 * 这种「按命令名委派」也展开（playlist_tracks → song_detail）。
 */
function serverMap(srcRaw) {
  const src = stripComments(srcRaw);
  const map = new Map();

  const sw = src.indexOf('switch (cmd)');
  if (sw < 0) return map;
  const braceOpen = src.indexOf('{', sw);
  const braceClose = matchBrace(src, braceOpen);
  if (braceOpen < 0 || braceClose < 0) return map;

  const cases = sliceCaseBlocks(src.slice(braceOpen, braceClose + 1), /case\s+'([a-z_]+)'\s*:/g);
  for (const [cmd, body] of cases) {
    const paths = [];
    for (const m of body.matchAll(/ncmPost\(\s*'([^']+)'/g)) paths.push(normPath(m[1]));
    map.set(cmd, paths);
  }
  /* 按命令名委派展开：case 'playlist_tracks' 里是 ncmCall('song_detail', ...) */
  const resolve = (cmd, seen) => {
    if (seen.has(cmd)) return [];
    seen.add(cmd);
    const out = [...(map.get(cmd) || [])];
    const body = cases.find(([c]) => c === cmd);
    if (body) {
      for (const m of body[1].matchAll(/ncmCall\(\s*'([a-z_]+)'/g)) {
        out.push(...resolve(m[1], seen));
      }
    }
    return out;
  };
  for (const [cmd] of cases) {
    map.set(cmd, [...new Set(resolve(cmd, new Set()))].sort());
  }
  return map;
}

/** 某个文件实现了哪些命令名（只看名字，不看路径） */
function implementedNames(srcRaw, kind) {
  const src = stripComments(srcRaw);
  const set = new Set();
  let re;
  if (kind === 'js') re = /case\s+'([a-z_]+)'\s*:/g;
  else if (kind === 'java') re = /case\s+"([a-z_]+)"\s*:/g;
  else re = /^[ \t]+"([a-z_]+)"\s*=>/gm;
  for (const m of src.matchAll(re)) set.add(m[1]);
  return set;
}

/*
 * 这些命令是纯前端 / 纯本地能力，不该出现在三端的命令表里 ——
 * 它们**豁免**「三端都必须实现」的断言（这是历史结论，不是漏项）。
 */
const LOCAL_ONLY = new Set(['logout', 'comment_add']);

function checkCommandsAndPaths() {
  console.log('\n[A/B] 三端命令名与上游路径');

  const fe = frontendCommands();
  const javaSrc = read('android/app/src/main/java/com/ripple/app/NeteaseClient.java');
  const nodeSrc = read('server.js');
  const rustSrc = read('desktop/src-tauri/src/netease.rs');

  const node = implementedNames(nodeSrc, 'js');
  const java = implementedNames(javaSrc, 'java');
  const rust = implementedNames(rustSrc, 'rust');

  const nodePaths = serverMap(nodeSrc);
  const javaPaths = javaMap(javaSrc);
  const rustPaths = rustMap(rustSrc);

  console.log(`  前端调用 ${fe.size} 个命令；server.js ${node.size} 条；Java ${java.size} 条；Rust ${rust.size} 条`);
  console.log(`  上游路径已提取：server.js ${nodePaths.size} 条 / Java ${javaPaths.size} 条 / Rust ${rustPaths.size} 条`);

  /* ---- A. 命令名：每条命令三端都要有实现，缺哪端明确报出来 ---- */
  const allCmds = new Set([...fe, ...node, ...java, ...rust]);
  for (const cmd of [...allCmds].sort()) {
    if (LOCAL_ONLY.has(cmd)) continue;
    const missing = [];
    if (!node.has(cmd)) missing.push('server.js');
    if (!java.has(cmd)) missing.push('Java');
    if (!rust.has(cmd)) missing.push('Rust');
    if (missing.length) {
      fail(`命令 "${cmd}" 缺 ${missing.join(' / ')} 端的实现（三端命令表必须一致）`);
    }
  }

  /* ---- B. 上游路径：同一命令在三端必须打到同一个 path 集合 ---- */
  const ends = [
    ['Java', javaPaths, java],
    ['server.js', nodePaths, node],
    ['Rust', rustPaths, rust],
  ];
  for (const cmd of [...allCmds].sort()) {
    /* 只看三端都有实现的命令；缺端的情况 A 已经报过，不重复报 */
    if (!ends.every(([, , names]) => names.has(cmd))) continue;
    if (LOCAL_ONLY.has(cmd)) continue;

    const detail = ends
      .map(([name, paths]) => `${name}=${JSON.stringify(paths.get(cmd) || [])}`)
      .join(' / ');
    const empty = ends.filter(([, paths]) => !(paths.get(cmd) || []).length).map(([n]) => n);
    if (empty.length) {
      /* 命令实现了，却一条上游 path 都提取不出来 = 提取器失效（不是真的没问题） */
      fail(`命令 "${cmd}" 在 ${empty.join(' / ')} 端提取不出上游路径（提取规则可能已失配）：${detail}`);
      continue;
    }
    const uniq = new Set(ends.map(([, paths]) => JSON.stringify(paths.get(cmd))));
    if (uniq.size > 1) {
      fail(`命令 "${cmd}" 三端路径不一致：${detail}`);
    }
  }

  if (failures === 0) ok('命令名与上游路径三端一致');
}

/* ---------------------------------------------------------------
 * C：扫码状态码单一来源
 * --------------------------------------------------------------- */
function checkQrCodes() {
  console.log('\n[C] 扫码状态码单一来源');

  const before = failures;
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
  if (failures === before) ok('扫码状态码只有一个来源，803 在白名单内');
}

/* ---------------------------------------------------------------
 * D：版本号副本一致（走唯一解析器）
 *
 * 这一项以前是本文件里手抄的 4 条正则（tauri.conf.json / Cargo.toml /
 * Cargo.lock / version.js），而 sync-version.sh 实际同步 8 处 ——
 * 检查器与被检查对象的名单本身就不一致（H-5），并且 Cargo.toml 读的
 * 是「文件第一处 version =」，与同步脚本**同一个错误判据**（B-1）。
 *
 * 现在：一切版本解析都交给 scripts/version-facts.js，本文件不再自带
 * 任何版本正则。新增副本只需要改那一个文件。
 * --------------------------------------------------------------- */
function checkVersions() {
  console.log('\n[D] 版本号一致性');

  const before = failures;
  let facts;
  try {
    facts = require('./version-facts.js').collect(ROOT);
  } catch (e) {
    fail(`版本解析器 scripts/version-facts.js 不可用：${e && e.message}`);
    return;
  }

  console.log(`  真值源 version.json → ${facts.versionName} (${facts.versionCode})`);
  for (const f of require('./version-facts.js').copyPaths()) {
    const rows = Object.values(facts.copies).filter((c) => c.path === f);
    const bad = rows.filter((r) => !r.ok);
    if (bad.length === 0) {
      console.log(`  ✓ ${f}`);
    } else {
      for (const r of bad) {
        fail(`${r.path} 的 ${r.field}：`
          + (r.missing ? '文件不存在' : `实际 ${JSON.stringify(r.actual)}`)
          + `，期望 ${JSON.stringify(r.expected)}`);
      }
    }
  }
  if (failures === before) {
    ok(`版本号 ${facts.versionName} (${facts.versionCode}) ${require('./version-facts.js').copyPaths().length} 处副本一致`);
  }
}

/* ---------------------------------------------------------------
 * E：首页缓存清理只允许一个入口
 * --------------------------------------------------------------- */
function checkCacheInvalidation() {
  console.log('\n[E] 首页缓存清理入口唯一');

  const before = failures;
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
  if (failures === before) ok('首页缓存清理只有一个入口');
}

/* ---------------------------------------------------------------
 * F：sw.js 的 SHELL 名单 vs index.html 的脚本清单（1.3.5 的 M-2 / H-4）
 *
 * SHELL 是一份**需要人工维护的文件清单**，而 sw.js 的注释还在用
 * 「加新语言时这两行旁边要再补一条」提醒人 —— 正是本项目要消灭的模式。
 * 1.3.3 加 js/lyricfill.js 时只改了 index.html，SHELL 漏了它，
 * 结果离线首开该脚本 504、window.LyricFill 为 null，app.js 里一条没有
 * 空值守卫的调用每 100ms 抛一次 TypeError（H-4）。
 *
 * 所以：index.html 引用到的每一个脚本/样式，都必须在 SHELL 里
 * （唯一允许的例外是 /ripple-token.js，原因见白名单注释）；
 * 反过来，SHELL 里的每一项也必须是 index.html 真的会加载的东西，
 * 防止删掉文件后 SHELL 留一条 404 的死链。
 * --------------------------------------------------------------- */
/*
 * SHELL 里允许存在、但 index.html 并不直接引用的条目。
 * 每一项都必须写明**为什么** —— 白名单不做无理由的兜底。
 */
const SHELL_EXTRA_ALLOWED = new Map([
  [
    'index.html',
    /* SHELL 里的 './' 与 './index.html' 是文档自身，index.html 当然不会
       「引用」自己 —— 但离线时必须能打开它，所以必须预缓存。 */
  ],
  [
    'manifest.webmanifest',
    /* PWA 清单，由 <link rel="manifest"> 引用；它的 icons 由下面单独展开 */
  ],
]);

/*
 * index.html 里允许出现、但故意不进 SHELL 的条目。
 * 只允许一个，且必须说明原因 —— 这正是 M-2 报告的要求。
 */
const SHELL_HTML_ONLY_WHITELIST = new Map([
  [
    'ripple-token.js',
    /* 故意不预缓存：它由 server.js 在响应 index.html 时**就地注入**内容
       （window.RIPPLE_TOKEN="..."，服务端按 IP 签发、会轮换），不是静态文件。
       预缓存它既拿不到正确内容，还会把一个属于服务端的短期令牌写进
       Cache Storage 长期留存。见 app/sw.js 里那段长注释。 */
  ],
]);

/** 把 './x' / '/x' / './' 归一成「相对 app/ 的路径」 */
const normRef = (u) => {
  const s = u.trim().replace(/^\.\//, '').replace(/^\//, '');
  return s === '' || s === '.' ? 'index.html' : s;
};

/** index.html（含它引用的 manifest 的 icons）里被引用的本地文件 */
function offlineRequiredRefs() {
  const html = read('app/index.html');
  const set = new Set();
  for (const m of html.matchAll(/<script[^>]*\bsrc\s*=\s*"([^"]+)"/g)) {
    const u = normRef(m[1]);
    if (!/^https?:/i.test(u)) set.add(u);
  }
  for (const m of html.matchAll(/<link[^>]*\bhref\s*=\s*"([^"]+)"/g)) {
    const u = normRef(m[1]);
    if (!/^https?:/i.test(u)) set.add(u);
  }
  /* manifest 里声明的 icons 也是「离线可用」的一部分（装到桌面后要第一屏就有图标） */
  if (exists('app/manifest.webmanifest')) {
    try {
      const mf = JSON.parse(read('app/manifest.webmanifest'));
      for (const ic of mf.icons || []) {
        if (ic && typeof ic.src === 'string') set.add(normRef(ic.src));
      }
    } catch (e) {
      /* manifest 解析失败不在这里报（有别的检查管它），跳过即可 */
    }
  }
  return set;
}

/**
 * sw.js 的 SHELL 数组条目（归一成相对 app/ 的路径）。
 *
 * ⚠️ 必须**先剥掉注释**再抽字符串字面量。
 *
 * 这里踩过一次：SHELL 里有一段解释「lyricfill.js 曾经漏在这里」的注释，
 * 注释正文里写着 './js/lyricfill.js' —— 于是这条被当成数组元素抽出来，
 * 与真正的数组项重复，检查器报「SHELL 里有重复项：js/lyricfill.js」。
 * 一个只在注释里出现的路径不该被当成「预缓存了一条什么」。
 *
 * 同理 './' 与 './index.html' 经 normRef 都会归一成 index.html，
 * 那是**同一个文件**的两种写法，不算重复 —— 重复判定要在归一之前
 * 按「原始条目」做，否则会误报。
 */
function shellRawList() {
  const sw = read('app/sw.js');
  const m = sw.match(/const SHELL = \[([\s\S]*?)\];/);
  if (!m) return null;
  /* 先删 /* 块 *\/ 与 // 行注释，再抽字符串 */
  const body = m[1]
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const raw = [];
  for (const s of body.matchAll(/'([^']+)'/g)) raw.push(s[1]);
  return raw;
}

function shellList() {
  const raw = shellRawList();
  return raw === null ? null : raw.map(normRef);
}

function checkServiceWorkerShell() {
  console.log('\n[F] sw.js 的 SHELL 名单 vs index.html');

  const before = failures;
  const refs = offlineRequiredRefs();
  const shell = shellList();
  if (!shell) {
    fail('app/sw.js 里找不到 `const SHELL = [...]` 数组');
    return;
  }
  const shellSet = new Set(shell);

  /* 方向一：index.html 加载了、但 SHELL 没预缓存 → 离线首开会 504 */
  for (const ref of [...refs].sort()) {
    if (shellSet.has(ref)) continue;
    if (SHELL_HTML_ONLY_WHITELIST.has(ref)) continue;
    fail(`app/index.html 引用了 "${ref}"，但 app/sw.js 的 SHELL 没有它`
      + '（离线首开该文件会 504；加新脚本/语言包时两处都要改）');
  }

  /* 方向二：SHELL 里预缓存了、但没有任何页面/清单会加载它 → 404 死链 */
  for (const s of shell) {
    if (refs.has(s) || SHELL_EXTRA_ALLOWED.has(s)) continue;
    fail(`app/sw.js 的 SHELL 里有 "${s}"，但 index.html / manifest 都不加载它`
      + '（删文件/改名后忘了删 SHELL 项 = 预缓存一条 404 死链）');
  }

  /* 重复项：按**原始条目**判，不按归一后的路径 ——
     './' 与 './index.html' 归一后都是 index.html，但那是同一文件的两种写法，
     写出来是正常的（前者让离线打开根路径也能命中）。 */
  const raw = shellRawList() || [];
  const dup = raw.filter((s, i) => raw.indexOf(s) !== i);
  if (dup.length) fail(`app/sw.js 的 SHELL 里有重复项：${[...new Set(dup)].join(', ')}`);

  if (failures === before) {
    ok(`SHELL 与 index.html 一致（需离线可用 ${refs.size} 项 / 预缓存 ${shell.length} 项）`);
  }
}

/* ---------------------------------------------------------------
 * G：版本副本清单 ↔ sync-version.sh ↔ CONTRIBUTING.md 三方一致
 *    （1.3.5 的 H-5 自检 + M-6）
 *
 * H-5 的机制：checker 查 4 处、同步脚本写 8 处，「检查器与被检查对象
 * 之间的名单漂移」—— 这本身就是本仓库头号缺陷模式的一种。
 * 光把 4 改成 8 只能修这一次；要让它不再复发，必须让「同步目标清单」
 * 只有一个来源，并且**文档也要跟着它**。
 *
 * 现在的单一来源是 scripts/version-facts.js 的 COPIES。
 * 这里额外断言两件事：
 *   ① android/sync-version.sh 里的 SYNC_TARGETS 数组 == COPIES 涉及的文件
 *   ② CONTRIBUTING.md 的版本同步表格里列出了每一个副本文件（M-6）
 * 任何一处漂移都直接红，而不是等下一个人肉眼发现。
 * --------------------------------------------------------------- */
function parseSyncTargets() {
  const src = read('android/sync-version.sh');
  const m = src.match(/SYNC_TARGETS=\(([\s\S]*?)\)\n/);
  if (!m) return null;
  const list = [];
  for (const s of m[1].matchAll(/'([^']+)'|"([^"]+)"/g)) list.push(s[1] || s[2]);
  return list;
}

function checkVersionTargetsAgree() {
  console.log('\n[G] 版本副本清单三方一致（解析器 / 同步脚本 / 文档）');

  const before = failures;
  const factsCopyPaths = require('./version-facts.js').copyPaths();

  /* ① sync-version.sh 的 SYNC_TARGETS */
  const syncTargets = parseSyncTargets();
  if (syncTargets === null) {
    fail('android/sync-version.sh 里找不到 SYNC_TARGETS=(...) 数组 —— '
      + '它就是「版本副本清单」在同步侧的唯一声明，checker 靠它做自检');
  } else {
    const a = [...new Set(syncTargets)].sort();
    const b = [...new Set(factsCopyPaths)].sort();
    const onlySync = a.filter((x) => !b.includes(x));
    const onlyFacts = b.filter((x) => !a.includes(x));
    if (onlySync.length) {
      fail(`android/sync-version.sh 的 SYNC_TARGETS 里有 ${onlySync.join(', ')}，`
        + '但 scripts/version-facts.js 的 COPIES 没覆盖它'
        + '（同步了却没人检查 = H-5 那种名单漂移）');
    }
    if (onlyFacts.length) {
      fail(`scripts/version-facts.js 的 COPIES 里有 ${onlyFacts.join(', ')}，`
        + '但 android/sync-version.sh 的 SYNC_TARGETS 没写它'
        + '（检查了却没人同步 = 每次构建都要红）');
    }
  }

  /* ② CONTRIBUTING.md 的版本同步清单表格 */
  const doc = read('CONTRIBUTING.md');
  const backendMissing = factsCopyPaths.filter((p) => !doc.includes('`' + p + '`'));
  if (backendMissing.length) {
    fail('CONTRIBUTING.md 的「版本同步清单」表格漏了：'
      + backendMissing.map((p) => '`' + p + '`').join('、')
      + '（文档少列一处 = 改这处的人不知道要跑 sync-version.sh）');
  }

  if (failures === before) {
    ok(`版本副本 ${factsCopyPaths.length} 处：解析器 / sync-version.sh / CONTRIBUTING.md 三方一致`);
  }
}

/* ---------------------------------------------------------------
 * 跑全部
 * --------------------------------------------------------------- */
console.log('名单一致性检查（审查 3.1 的结构性防护）');
runSection('A/B', checkCommandsAndPaths);
runSection('C', checkQrCodes);
runSection('D', checkVersions);
runSection('E', checkCacheInvalidation);
runSection('F', checkServiceWorkerShell);
runSection('G', checkVersionTargetsAgree);

console.log('');
if (failures === 0) {
  console.log('全部通过 ✓ （三端名单一致）');
  process.exit(0);
}
console.error(`发现 ${failures} 处不一致 ✗`);
console.error('这类问题的典型症状是「单看每一处都没错，合起来就崩」——');
console.error('请把名单提成单一常量并让消费方共用，而不是在这一处偷偷改一下。');
process.exit(1);
