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
 *
 * 审查 1.3.8 · M-18：这里以前是无理由的 Set（`new Set(['logout','comment_add'])`），
 * 谁都能往里面塞一个命令就把断言绕过去，而且没人知道为什么它在里面。
 * 现在改成 Map —— **值必须是豁免理由**，且空理由会被判定为不合格。
 * 这条规则对标同文件 SHELL_EXTRA_ALLOWED（「每一项都必须写明为什么」），
 * 全仓库只保留一种豁免标准，不再有第二套宽松口径。
 */
const LOCAL_ONLY = new Map([
  [
    'logout',
    /* 纯本地动作：只清本机 cookie / 登录态并刷新 UI，不需要打上游接口，
       所以三端都没有对应实现，也不该有。 */
    '纯本地动作：只清本机 cookie 与登录态并刷新 UI，不打上游接口，三端本就无实现',
  ],
  [
    'comment_add',
    /* 走的是已登录态下的表单提交，前端在 app.js 里直接拼 payload 后
       复用 comment 系的桥；没有独立的上游 path，故不参与路径比对。 */
    '走已登录态的表单提交，复用 comment 系桥，没有独立上游 path，故不参与路径比对',
  ],
]);

/*
 * 豁免判定：光在名单里不够，**必须带非空理由**。
 *
 * 这条函数就是 M-18 的机械防线 —— 以后有人往 LOCAL_ONLY 里加命令却
 * 不写为什么，这里会直接报红（在 [A/B] 检查开头统一扫一遍），
 * 而不是让一条无名豁免悄悄改变断言语义。
 */
function isExemptLocalOnly(cmd) {
  if (!LOCAL_ONLY.has(cmd)) return false;
  const why = String(LOCAL_ONLY.get(cmd) || '').trim();
  return why.length > 0;
}

function checkCommandsAndPaths() {
  console.log('\n[A/B] 三端命令名与上游路径');

  /* 先校验豁免名单本身的合法性（M-18）：每一项都必须写明理由 */
  for (const [cmd, why] of LOCAL_ONLY) {
    if (!String(why || '').trim()) {
      fail(`LOCAL_ONLY 里的 "${cmd}" 没有写明豁免理由`
        + '（豁免必须带为什么，否则它就是一个无约束的口子）');
    }
  }

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
    if (isExemptLocalOnly(cmd)) continue;
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
    if (isExemptLocalOnly(cmd)) continue;

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

/* ---------------------------------------------------------------
 * H：桌面端 capabilities 不得用 core:default（审查 1.3.8 · H-9 配套）
 *
 * 为什么要这条：`core:default` 一次性把 core:path / core:image /
 * core:tray / core:menu / core:webview 等**全部**默认权限开给窗口，
 * 而本项目一个都没用到。其中 core:path 的 resolve_directory 能解析出
 * 用户主目录/文档目录的绝对路径 —— 今天不可利用（没有 XSS），
 * 但它是「零成本就能拥有的探针」，一旦将来引入任何注入点就立刻有价值。
 *
 * 加权限应该是**有意为之**的动作，而不是复制一个 core:default 就顺带全开。
 * 所以这里直接禁止，需要哪项就显式列哪项。
 * --------------------------------------------------------------- */
function checkCapabilityScopes() {
  console.log('\n[H] 桌面端 capabilities 权限面（禁止 core:default）');

  const before = failures;
  const dir = 'desktop/src-tauri/capabilities';
  let files = [];
  try {
    files = fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith('.json'));
  } catch (e) {
    fail(`读不到 ${dir}/：${e && e.message}`);
    return;
  }
  if (!files.length) {
    fail(`${dir}/ 里没有 .json 能力文件（桌面端窗口将无任何权限）`);
    return;
  }

  for (const f of files.sort()) {
    const src = read(`${dir}/${f}`);
    let json;
    try {
      json = JSON.parse(src);
    } catch (e) {
      fail(`${dir}/${f} 不是合法 JSON：${e && e.message}`);
      continue;
    }
    const perms = Array.isArray(json.permissions) ? json.permissions : [];
    if (perms.includes('core:default')) {
      fail(`${dir}/${f} 用了 core:default`
        + '（它会把 core:path / core:image / core:tray / core:menu 等全部默认权限开给窗口，'
        + '本项目一项都没用到；请按需显式列出具体权限）');
    }
  }

  if (failures === before) {
    ok(`${files.length} 个能力文件都没有 core:default（权限面按需显式）`);
  }
}

/*
 * 从 CONTRIBUTING.md 的「版本同步清单」表格里提取**文档声称的**版本副本路径。
 *
 * 只认表格里用反引号包起来的、看起来像文件路径的条目 ——
 * 不扫全文反引号，否则「跑 `bash android/sync-version.sh`」这种命令
 * 也会被当成路径，反向比对立刻全是假阳性。
 */
function versionCopyPathsMentionedIn(doc) {
  const out = new Set();
  /* 表格行：以 | 开头，首列就是被描述的文件路径 */
  for (const line of doc.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    const m = t.match(/^\|\s*`([^`]+)`/);
    if (!m) continue;
    const p = m[1].trim();
    /* 过滤掉明显不是路径的（含空格 / 以 bash 开头 / 是命令） */
    if (!p || /\s/.test(p)) continue;
    if (!/\.(json|js|gradle|java|toml|lock)$/.test(p)) continue;
    out.add(p);
  }
  return [...out];
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

  /* ② CONTRIBUTING.md 的版本同步清单表格 —— **双向**比对（审查 1.3.8 · M-17）
   *
   * 以前只查一个方向（文档漏列解析器里的路径），于是文档里**凭空多列**一个
   * 根本不存在的文件也能报绿 —— 那份表格的标题是「三方一致」，
   * 单向比对配不上这个措辞。现在两个方向都查：
   *   · 解析器有、文档没有 → 改这处的人不知道要跑 sync-version.sh（原有方向）
   *   · 文档有、解析器没有 → 文档在骗人（新加方向）
   */
  const doc = read('CONTRIBUTING.md');
  const backendMissing = factsCopyPaths.filter((p) => !doc.includes('`' + p + '`'));
  if (backendMissing.length) {
    fail('CONTRIBUTING.md 的「版本同步清单」表格漏了：'
      + backendMissing.map((p) => '`' + p + '`').join('、')
      + '（文档少列一处 = 改这处的人不知道要跑 sync-version.sh）');
  }

  /*
   * 反方向：文档里列了、但解析器里根本没有这个副本。
   *
   * 为什么这条重要：这份表格的语义是「这些文件里有版本号，改了一个要同步」。
   * 文档多列一个不存在的文件，读者会去找一个不存在的路径；
   * 更糟的是它会掩盖「真副本被删了但文档没同步」这件事。
   */
  const docListed = versionCopyPathsMentionedIn(doc);
  const ghostInDoc = docListed.filter((p) => !factsCopyPaths.includes(p));
  if (ghostInDoc.length) {
    fail('CONTRIBUTING.md 的「版本同步清单」表格列了这些路径，'
      + '但 scripts/version-facts.js 的 COPIES 里没有它们：'
      + ghostInDoc.map((p) => '`' + p + '`').join('、')
      + '（文档在描述不存在的副本 = 读者会去找一个没有的文件）');
  }

  if (failures === before) {
    ok(`版本副本 ${factsCopyPaths.length} 处：解析器 / sync-version.sh / CONTRIBUTING.md 三方一致（双向）`);
  }
}

/* ---------------------------------------------------------------
 * I：构建链的「判据不许再抄一份」机械防护（审查 1.3.8 的 B-3 / B-4 / H-12 ~ H-16）
 *
 * 思路与 A/B 一致：不是「这次把某处改对」，而是让**复发本身被拦住**。
 * 每条都对着报告里一个已发生的缺陷：
 *   B-4  —— 两个 workflow + 一个测试里各有一份「读 Cargo.toml 第一处 version」
 *   H-12 —— sync-version.sh 的**写入侧**也是「改第一处」
 *   H-14 —— build-apk.sh 用 mapfile（bash 4+，macOS 3.2 不可用）
 *   H-15 —— build-apk.sh 没有与 build.gradle noCompress 等价参数
 *   H-13 —— desktop-build.yml 的 push 触发缺 main
 *   B-3  —— PublicFile 用 RELATIVE_PATH 等值 + 强制 owner 非 null 当复用判据
 *
 * 这些文件在 tests/manifest-consistency.test.js 的「临时副本」里大多不存在，
 * 所以每项都做「锚点不存在 ⇒ 跳过」，而不是 ENOENT 把整段打崩。
 * --------------------------------------------------------------- */

/** 读文件，不存在返回 null（用于可选锚点） */
function readIfExists(rel) {
  return exists(rel) ? read(rel) : null;
}

/**
 * 去掉 YAML / shell 的**整行注释**，只留下真正会执行的文本。
 *
 * 为什么必须有这一步：下面几条断言要禁的是「代码里再用错误判据」，
 * 而注释里恰恰会**引用**那些被禁的写法（"以前这里是 sed ..."）。
 * 不剥注释就会把修复说明本身判成违规 —— 这是「机械检查器误报」的典型形态，
 * 一旦发生，下一个人就会去删掉注释里的历史解释，把知识一起扔掉。
 */
function stripLineComments(src) {
  if (!src) return '';
  return src
    .split('\n')
    .filter((line) => !/^[ \t]*#/.test(line))
    .join('\n');
}

/** 是否含「读 Cargo.toml 第一处 version」的判据（B-4 的形态） */
function hasFirstVersionHeuristic(src) {
  if (!src) return false;
  return /^.*sed[^\n]*\^version/m.test(src)
    || /^.*awk[^\n]*\^version/m.test(src)
    || /match\(\/\^version = /.test(src);
}

function checkBuildChainGuards() {
  console.log('\n[I] 构建链判据不重复 / 平台下限 / 产物等价');

  const before = failures;
  let checked = 0;

  /* ---------- B-4：CI 必须调唯一解析器，不许再抄第一处判据 ---------- */
  const wfDir = '.github/workflows';
  let wfiles = null;
  try {
    wfiles = fs.readdirSync(path.join(ROOT, wfDir)).filter((f) => /[.]ya?ml$/.test(f));
  } catch (e) {
    wfiles = null;
  }
  if (!wfiles) {
    console.log('  （临时副本里没有 .github/workflows，跳过 CI 判据检查）');
  } else {
    checked++;
    const calledIn = new Set();
    for (const f of wfiles.sort()) {
      const rel = wfDir + '/' + f;
      const raw = readIfExists(rel);
      if (raw === null) continue;
      /* 只看可执行文本（YAML 里 "#" 开头是注释；工作流正文都是 shell） */
      const src = stripLineComments(raw);
      if (/version-facts[.]js[^\n]*--assert/.test(src)) calledIn.add(f);
      if (src.includes('Cargo.toml') && hasFirstVersionHeuristic(src)) {
        fail(rel + ' 里仍有「读 Cargo.toml 第一处 version」的判据'
          + '（B-4：只要 [package] 之前出现一个 version 键就会读到错的表而报绿。'
          + ' 请改成 node scripts/version-facts.js --assert）');
      }
    }
    if (calledIn.size === 0) {
      fail('没有任何 workflow 调用 scripts/version-facts.js --assert'
        + '（B-4：版本判据必须以唯一解析器为唯一入口，否则迟早再抄出第四份）');
    } else {
      for (const need of ['build.yml', 'desktop-build.yml']) {
        if (!wfiles.includes(need)) continue;
        if (!calledIn.has(need)) {
          fail(wfDir + '/' + need + ' 没有调用 scripts/version-facts.js --assert'
            + '（它自己那套版本校验必须整段交给唯一解析器）');
        }
      }
    }
  }

  /* ---------- H-12：写入侧不许「改第一处」，且必须是 [package] 段内 ---------- */
  const syncShRaw = readIfExists('android/sync-version.sh');
  if (syncShRaw !== null) {
    checked++;
    const syncSh = stripLineComments(syncShRaw);
    if (/0,\/\^version/.test(syncSh)) {
      fail('android/sync-version.sh 里仍有 sed "0,/^version = .../" —— 那是「改文件第一处 version」'
        + '（H-12：会把版本号写进 [profile.release] 之类的表，而 [package].version 纹丝不动）。'
        + '请改成 [package] 段内定位，与 desktop/build-frontend.sh 的 sync_toml() 同一套实现');
    }
    if (!/\[package\]/.test(syncSh)) {
      fail('android/sync-version.sh 的 Cargo.toml 写入侧没有 [package] 段内定位的痕迹（H-12）');
    }
    if (/^[ \t]*if \[ -f "\$ROOT\/scripts\/version-facts\.js" \] && command -v node/m.test(syncSh)) {
      fail('android/sync-version.sh 的收尾复核仍是「文件与 node 都在才跑」的条件式 —— '
        + 'B-4：那等于「脚本还能跑，但没人验证」，必须改成缺失即硬失败');
    }
  }

  /* ---------- H-14：不许用 bash 4+ 才有的语法 ---------- */
  for (const rel of ['android/build-apk.sh', 'android/sync-version.sh', 'tests/run.sh']) {
    const src = readIfExists(rel);
    if (src === null) continue;
    checked++;
    /* 先去注释再判，避免注释里解释 mapfile 历史被误报 */
    const code = stripComments(src);
    if (/^[ \t]*mapfile\b/m.test(code)) {
      fail(rel + ' 用了 mapfile（bash 4.0+）——'
        + 'H-14：macOS 自带 /bin/bash 是 3.2，会报 "mapfile: command not found"，'
        + '紧接着下游工具收到空参数列表、报出与真实原因无关的错。请改用 xargs -0');
    }
  }

  /* ---------- H-15：两条构建路径的「不压缩扩展名」必须一致 ---------- */
  const gradle = readIfExists('android/app/build.gradle');
  const apkSh = readIfExists('android/build-apk.sh');
  if (gradle !== null && apkSh !== null) {
    checked++;
    const gm = gradle.match(/aaptOptions\s*\{([\s\S]*?)\n\s*\}/);
    const gradleExts = [];
    if (gm) {
      for (const m of gm[1].matchAll(/noCompress\s+((?:'[^']*'\s*,?\s*)+)/g)) {
        for (const q of m[1].matchAll(/'([^']*)'/g)) gradleExts.push(q[1]);
      }
    }
    /* build-apk.sh 侧：NO_COMPRESS_REGEX='\\.mp3$' → 抽出扩展名 */
    const rm = apkSh.match(/NO_COMPRESS_REGEX=['"]([^'"]+)['"]/);
    const shExts = [];
    if (rm) {
      for (const m of rm[1].matchAll(/\.([A-Za-z0-9]+)\$/g)) shExts.push(m[1]);
    }
    const norm = (arr) => [...new Set(arr.map((s) => s.trim().toLowerCase()).filter(Boolean))].sort();
    const a = norm(gradleExts);
    const b = norm(shExts);
    if (a.join(',') !== b.join(',')) {
      fail('两条构建路径的「不压缩扩展名」不一致：'
        + 'android/app/build.gradle = [' + a.join(', ') + ']，'
        + 'android/build-apk.sh = [' + b.join(', ') + ']'
        + '（H-15：Gradle 与 build-apk.sh 出的 APK 不是同一个包。'
        + ' aapt2 的 --no-compress 是布尔开关、不吃扩展名，等价参数是 --no-compress-regex）');
    }
    /* 只看 shell 的可执行文本：注释里正是在解释「报告建议的 --no-compress mp3 会炸」 */
    if (/--no-compress[ \t]+[a-zA-Z0-9]/.test(stripLineComments(apkSh))) {
      fail('android/build-apk.sh 里出现了 --no-compress <扩展名> —— '
        + 'aapt2 link 的 --no-compress 是布尔开关，会把扩展名当成**输入文件**'
        + '（实测：mp3: error: failed to open file）。请用 --no-compress-regex');
    }
  }

  /* ---------- H-13：桌面端 CI 的 push 触发必须包含 main ---------- */
  const desktopYml = readIfExists(wfDir + '/desktop-build.yml');
  if (desktopYml !== null) {
    checked++;
    const pushBlock = desktopYml.match(/\n\s*push:\s*\n([\s\S]*?)(?=\n\s*(?:pull_request|workflow_dispatch|concurrency):)/);
    if (!pushBlock) {
      fail('.github/workflows/desktop-build.yml 里找不到 push 触发块');
    } else if (!/^\s*-\s*main\s*$/m.test(pushBlock[1])) {
      fail('.github/workflows/desktop-build.yml 的 push 触发里没有 main —— '
        + 'H-13：在 main 上直接提交（不走 PR）时桌面端 CI 一次都不跑，'
        + '发版前最后一次改动完全没被验证过');
    }
  }

  /* ---------- B-3：PublicFile 的 MediaStore 复用判据 ---------- */
  const pf = readIfExists('android/app/src/main/java/com/ripple/app/PublicFile.java');
  const cl = readIfExists('android/app/src/main/java/com/ripple/app/CrashLog.java');
  if (pf !== null) {
    checked++;
    const code = stripComments(pf);
    const sel = code.match(/cr\.query\(MediaStore\.Downloads\.EXTERNAL_CONTENT_URI[\s\S]*?\);/);
    if (sel && /RELATIVE_PATH\s*\+\s*"=\?"/.test(sel[0])) {
      fail('PublicFile.writeMediaStore 的查询 selection 里带上了 RELATIVE_PATH（B-3）：'
        + 'MediaStore 落库的是 "Download/"，等值比较命不中 → 每次 insert → '
        + 'MediaStore 自动改名 → 日志碎成几十份（真机实测 32 份 Ripple-log）');
    }
    if (!/who\s*==\s*null\s*\|\|\s*who\.equals\(owner\)/.test(code)) {
      fail('PublicFile.writeMediaStore 的复用判据没有容忍「OWNER_PACKAGE_NAME 为 null」（B-3）：'
        + '该列 API 29 才引入、且大量 ROM 对自家文件也返回 null，强制非 null '
        + '会让覆盖写永远失效（1.3.6 的 L-15 修复就这样把日志写碎了）');
    }
  }
  if (cl !== null) {
    checked++;
    const clCode = stripComments(cl);
    /*
     * ⚠️ 判据必须看**函数定义**，不能只看「有没有出现这个名字」。
     *   第一次写这条时用的是 /downloadPoolOf\s*\(/ —— 把定义行改名后，
     *   调用点 downloadPoolOf(row[0]) 仍然命中，检查器照样报绿（变异测试抓到的）。
     *   这类「断言比它以为的宽松」正是本文件存在要防的东西，所以自己也要挨这一刀。
     */
    const poolDef = /private\s+static\s+int\s+downloadPoolOf\s*\(\s*String\s+\w+\s*\)\s*\{/.test(clCode);
    const tagDef = /private\s+static\s+String\s+tagOf\s*\(\s*String\s+\w+\s*,\s*String\s+\w+\s*\)\s*\{/.test(clCode);
    if (!poolDef || !tagDef) {
      fail('CrashLog 的下载目录清理没有「按语义 tag 分池」的实现（B-3）：'
        + '需要 downloadPoolOf(String) 与 tagOf(String,String) 两个方法的定义 —— '
        + '同一前缀里混着真崩溃与 1.3.5 之前的旧格式证据，10 份配额会把历史现场删光'
        + '（真机 101 份 Ripple-crash-* 里那 11 份 lyric-redraw 是 1.3.3 歌词根因的关键证据）');
    } else if (!/POOL_CRASH/.test(clCode) || !/POOL_LEGACY/.test(clCode)) {
      fail('CrashLog 的分池没有区分「真崩溃池」与「旧格式证据池」（B-3）：'
        + '两池必须各有独立配额，否则真崩溃与历史现场仍然互挤');
    }
    if (!/POOL_NONE/.test(clCode)) {
      fail('CrashLog 没有「不属于任何清理池」的判定（B-3）：'
        + '固定名覆盖写的高频文件（Ripple-log / Ripple-trace / Ripple-exit-info）'
        + '是单份文件，不能被任何配额逻辑删掉');
    }
  }

  if (failures === before) {
    ok('构建链 ' + checked + ' 项防护通过（版本判据 / 平台下限 / 产物等价 / 触发分支 / 日志复用）');
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
runSection('H', checkCapabilityScopes);
runSection('F', checkServiceWorkerShell);
runSection('G', checkVersionTargetsAgree);
runSection('I', checkBuildChainGuards);

console.log('');
if (failures === 0) {
  console.log('全部通过 ✓ （三端名单一致）');
  process.exit(0);
}
console.error(`发现 ${failures} 处不一致 ✗`);
console.error('这类问题的典型症状是「单看每一处都没错，合起来就崩」——');
console.error('请把名单提成单一常量并让消费方共用，而不是在这一处偷偷改一下。');
process.exit(1);
