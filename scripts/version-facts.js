#!/usr/bin/env node
/* ============================================================
   「版本号副本」的**唯一解析器**（审查 1.3.5 的 B-1 / H-5 / M-4 / M-6）

   为什么要有这个文件：
     1.3.0 的 D-02、1.3.5 的 B-1 是同一个缺陷的两次复发 ——
     「同一个判据被抄成多份」本身又变成了新的漂移点。

     B-1 的具体形态最典型：
       · android/sync-version.sh 用 `sed "0,/^version = .../"` 改**文件第一处**
         `^version =`（不是 Cargo.toml 的 [package] 段内）
       · 同一脚本的断言用 `sed -n '.../p' | head -1` 读**第一处**
       · CI（build.yml）与 checker 也各自读第一处
     ⇒ 改的地方与断言的地方共用同一个错误判据，断言恒等于改写结果。
     Cargo.toml 里只要在 [package] 之前多一个带 version 键的表，同步就会
     静默写到错误的表，而 [package].version 永远停在旧值，**三处检查同时报绿**。

   本文件是**唯一**的「某个副本现在是什么版本」的解析实现：
     · scripts/check-manifest-consistency.js  → require 本文件
     · .github/workflows/*.yml               → node scripts/version-facts.js --assert
     · android/sync-version.sh                → 写完之后 node ... --assert 复核

   关键约束：**Cargo.toml 必须段内定位**（[package] 段里的 version），
   绝不能改成「文件第一处 version =」。这是本文件存在的首要原因，
   改动时请先读一遍 desktop/build-frontend.sh:132-140 的同类实现。

   副本清单与 android/sync-version.sh 的同步目标**一一对应**（8 处）：
     android/app/build.gradle
     android/app/src/main/java/com/ripple/app/CrashLog.java
     android/app/src/main/java/com/ripple/app/RippleApp.java
     app/js/version.js
     app/sw.js
     desktop/src-tauri/tauri.conf.json
     desktop/src-tauri/Cargo.toml          ← [package] 段内，不是第一处
     desktop/src-tauri/Cargo.lock

   跑法：
     node scripts/version-facts.js                  # 全部副本 → JSON（不一致时退出码 1）
     node scripts/version-facts.js --assert         # 人读的检查（CI / sync 脚本用）
     node scripts/version-facts.js --get <key>      # 只取一个副本的值（bash 用）
     node scripts/version-facts.js --list           # 副本 key 与路径清单
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const VERSION_JSON = 'version.json';

const readText = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');

/* ---------------------------------------------------------------
 * 各副本的解析器
 *
 * 每个条目：{ key, path, field, parse(src) -> string|number|null }
 *   field = 'versionName' | 'versionCode'
 * 返回 null 表示「文件在，但解析不出来」—— 这不是「一致」，必须报红。
 * --------------------------------------------------------------- */

/**
 * Cargo.toml 的 [package] 段内 version。
 *
 * ⚠️ 这是 B-1 的核心：**先切段再取 version**。
 * 用 ^version = 直接搜全文会命中文件里第一处 version 键（可能是
 * [dependencies.foo] / [profile.release] / [lib] 里的），而 [package].version
 * 才是 Tauri 打包真正用的那个。
 */
function cargoTomlPackageVersion(src) {
  const head = src.match(/^\[package\][^\n]*$/m);
  if (!head) return null;
  const bodyStart = head.index + head[0].length;
  const rest = src.slice(bodyStart);
  const next = rest.search(/^\[/m);
  const seg = next < 0 ? rest : rest.slice(0, next);
  const v = seg.match(/^[ \t]*version[ \t]*=[ \t]*"([^"]+)"/m);
  return v ? v[1] : null;
}

const COPIES = [
  {
    key: 'build.gradle',
    path: 'android/app/build.gradle',
    field: 'versionCode',
    parse: (s) => {
      const m = s.match(/^[ \t]*versionCode[ \t]*=?[ \t]*(\d+)[ \t]*$/m);
      return m ? Number(m[1]) : null;
    },
  },
  {
    key: 'build.gradle#name',
    path: 'android/app/build.gradle',
    field: 'versionName',
    parse: (s) => {
      const m = s.match(/^[ \t]*versionName[ \t]*=?[ \t]*['"]([^'"]+)['"]/m);
      return m ? m[1] : null;
    },
  },
  {
    key: 'CrashLog.java#name',
    path: 'android/app/src/main/java/com/ripple/app/CrashLog.java',
    field: 'versionName',
    /* 形状："version: 1.3.6 (" + 136 + ")" —— 名字和 code 在同一行 */
    parse: (s) => {
      const m = s.match(/"version:[ \t]*([0-9]+(?:\.[0-9]+)*)[ \t]*\("[ \t]*\+[ \t]*\d+[ \t]*\+[ \t]*"\)"/);
      return m ? m[1] : null;
    },
  },
  {
    key: 'CrashLog.java#code',
    path: 'android/app/src/main/java/com/ripple/app/CrashLog.java',
    field: 'versionCode',
    parse: (s) => {
      const m = s.match(/"version:[ \t]*[0-9]+(?:\.[0-9]+)*[ \t]*\("[ \t]*\+[ \t]*(\d+)[ \t]*\+[ \t]*"\)"/);
      return m ? Number(m[1]) : null;
    },
  },
  {
    key: 'RippleApp.java',
    path: 'android/app/src/main/java/com/ripple/app/RippleApp.java',
    field: 'versionName',
    /* 形状：version=1.3.6(136) */
    parse: (s) => {
      const m = s.match(/"version=([0-9]+(?:\.[0-9]+)*)\((\d+)\)"/);
      return m ? m[1] : null;
    },
  },
  {
    key: 'RippleApp.java#code',
    path: 'android/app/src/main/java/com/ripple/app/RippleApp.java',
    field: 'versionCode',
    parse: (s) => {
      const m = s.match(/"version=[0-9]+(?:\.[0-9]+)*\((\d+)\)"/);
      return m ? Number(m[1]) : null;
    },
  },
  {
    key: 'app/js/version.js#name',
    path: 'app/js/version.js',
    field: 'versionName',
    parse: (s) => {
      const m = s.match(/name:[ \t]*'([^']+)'/);
      return m ? m[1] : null;
    },
  },
  {
    key: 'app/js/version.js#code',
    path: 'app/js/version.js',
    field: 'versionCode',
    parse: (s) => {
      const m = s.match(/code:[ \t]*(\d+)/);
      return m ? Number(m[1]) : null;
    },
  },
  {
    key: 'app/sw.js',
    path: 'app/sw.js',
    field: 'versionCode',
    /* SW 的缓存名必须等于 ripple-<versionCode>（注意：没有 v 前缀） */
    parse: (s) => {
      const m = s.match(/^const CACHE = 'ripple-(\d+)';/m);
      return m ? Number(m[1]) : null;
    },
  },
  {
    key: 'tauri.conf.json',
    path: 'desktop/src-tauri/tauri.conf.json',
    field: 'versionName',
    parse: (s) => {
      try {
        const v = JSON.parse(s).version;
        return typeof v === 'string' ? v : null;
      } catch (e) {
        return null;
      }
    },
  },
  {
    key: 'Cargo.toml',
    path: 'desktop/src-tauri/Cargo.toml',
    field: 'versionName',
    /* ⚠️ 段内定位，见 cargoTomlPackageVersion 的注释（B-1） */
    parse: cargoTomlPackageVersion,
  },
  {
    key: 'Cargo.lock',
    path: 'desktop/src-tauri/Cargo.lock',
    field: 'versionName',
    parse: (s) => {
      const m = s.match(/\[\[package\]\][ \t]*\r?\nname[ \t]*=[ \t]*"ripple-desktop"[ \t]*\r?\nversion[ \t]*=[ \t]*"([^"]+)"/);
      return m ? m[1] : null;
    },
  },
];

/** 读 version.json —— 唯一真值源 */
function readTruth(root = ROOT) {
  const abs = path.join(root, VERSION_JSON);
  if (!fs.existsSync(abs)) {
    throw new Error(`找不到 ${VERSION_JSON}（版本号的唯一来源）`);
  }
  const vj = JSON.parse(fs.readFileSync(abs, 'utf8'));
  const versionName = vj.versionName;
  const versionCode = vj.versionCode;
  if (typeof versionName !== 'string' || !/^[0-9]+(\.[0-9]+)*$/.test(versionName)) {
    throw new Error(`${VERSION_JSON} 的 versionName 不合法：${JSON.stringify(versionName)}`);
  }
  if (!Number.isInteger(versionCode) || versionCode < 1) {
    throw new Error(`${VERSION_JSON} 的 versionCode 不合法：${JSON.stringify(versionCode)}`);
  }
  return { versionName, versionCode };
}

/**
 * 采集全部副本的当前值，与真值源逐一比对。
 * @returns {{versionName, versionCode, copies: Object, failures: string[], ok: boolean}}
 */
function collect(root = ROOT) {
  const truth = readTruth(root);
  const copies = {};
  const failures = [];

  for (const c of COPIES) {
    const expected = c.field === 'versionCode' ? truth.versionCode : truth.versionName;
    const abs = path.join(root, c.path);
    let actual = null;
    let missing = false;
    if (!fs.existsSync(abs)) {
      missing = true;
    } else {
      try {
        actual = c.parse(fs.readFileSync(abs, 'utf8'));
      } catch (e) {
        actual = null;
      }
    }
    const ok = !missing && actual !== null && String(actual) === String(expected);
    copies[c.key] = { path: c.path, field: c.field, expected, actual, ok, missing };
    if (missing) {
      failures.push(`缺少副本文件 ${c.path}（期望 ${c.field}=${expected}）`);
    } else if (actual === null) {
      failures.push(`${c.path} 里解析不出 ${c.field}（期望 ${expected}）—— 文件格式变了？`);
    } else if (!ok) {
      failures.push(`${c.path} 的 ${c.field} 是 ${JSON.stringify(actual)}，`
        + `≠ ${VERSION_JSON} 的 ${expected}`);
    }
  }

  return { versionName: truth.versionName, versionCode: truth.versionCode, copies, failures, ok: failures.length === 0 };
}

/** 副本涉及的**文件**清单（去重、按原顺序）—— checker 的自检 / 文档校验用 */
function copyPaths() {
  const seen = [];
  for (const c of COPIES) if (!seen.includes(c.path)) seen.push(c.path);
  return seen;
}

/* ---------------------------------------------------------------
 * CLI
 * --------------------------------------------------------------- */
function main(argv) {
  const root = ROOT;
  const args = argv.slice(2);

  if (args.includes('--list')) {
    for (const c of COPIES) console.log(`${c.key}\t${c.path}\t${c.field}`);
    return 0;
  }

  let facts;
  try {
    facts = collect(root);
  } catch (e) {
    console.error(`✗ ${e.message}`);
    return 1;
  }

  if (args.includes('--get')) {
    const i = args.indexOf('--get');
    const key = args[i + 1];
    const hit = facts.copies[key];
    if (!hit) {
      console.error(`✗ 不认识的副本 key：${key}`);
      console.error('  可用 key 用 --list 查看');
      return 1;
    }
    if (hit.actual === null) {
      console.error(`✗ ${hit.path} 里解析不出 ${hit.field}`);
      return 1;
    }
    console.log(String(hit.actual));
    return 0;
  }

  if (args.includes('--assert')) {
    console.log(`[D] 版本号一致性（唯一解析器 scripts/version-facts.js）`);
    console.log(`  真值源 ${VERSION_JSON} → ${facts.versionName} (${facts.versionCode})`);
    const files = copyPaths();
    for (const f of files) {
      const rows = Object.values(facts.copies).filter((c) => c.path === f);
      const bad = rows.filter((r) => !r.ok);
      if (bad.length === 0) {
        console.log(`  ✓ ${f}`);
      } else {
        for (const r of bad) {
          console.error(`  ✗ ${r.path} 的 ${r.field}：`
            + (r.missing ? '文件不存在' : `实际 ${JSON.stringify(r.actual)}`)
            + `，期望 ${JSON.stringify(r.expected)}`);
        }
      }
    }
    if (!facts.ok) {
      console.error(`发现 ${facts.failures.length} 处版本副本不一致 ✗`);
      return 1;
    }
    console.log(`  ✓ 版本号 ${facts.versionName} (${facts.versionCode}) ${files.length} 处副本一致`);
    return 0;
  }

  /* 默认：JSON */
  console.log(JSON.stringify(facts, null, 2));
  return facts.ok ? 0 : 1;
}

module.exports = {
  ROOT,
  VERSION_JSON,
  COPIES,
  copyPaths,
  cargoTomlPackageVersion,
  readTruth,
  collect,
};

if (require.main === module) {
  process.exitCode = main(process.argv);
}
