#!/usr/bin/env node
/* ============================================================
   GitHub Release 正文生成器（1.3.7 起）

   为什么要有这个文件：
     这段逻辑原来写在 .github/workflows/build.yml 里，是一坨 awk + 函数 +
     多个 shell 重定向拼出来的。它无法在本地跑、无法被测试，每次改格式
     只能推上去看 CI 红不红 —— 1.3.5 那次「versionCode 标记写成空」的事故
     就是在这种环境下发生的：YAML 里 VC 从上一个 step 拿（跨 step 不存在），
     渲染出来是 "<!-- ripple-version-code:  -->"，没有任何检查能拦住它。

   搬进 node 脚本的收益（这是本次重构的全部理由）：
     ① 可测试：tests/release-notes.test.js 用临时 fixture 直接 require 本文件，
        四个硬失败分支每个都有用例，还有一条元测试证明判据真的会红；
     ② 可本地复现："node scripts/release-notes.js" 当场看到 CI 会发出去的正文，
        不用等一轮 CI、也不用猜；
     ③ 纯 node、零依赖、CommonJS —— 与 scripts/ 下其它脚本同一风格，
        CI 里用 runner 自带的 Node 就能跑，不需要 npm install。

   正文格式（用户 2026-11 定的规则，改之前先问）：
     只要两块 —— "## 本次更新" 与 "## This release"，各是「分块标题 + 列表项」。
     没有双语说明行、没有「本版包含」目录、没有安装包表格、没有 SHA-256、
     没有 <details> 折叠、没有 unsigned 提示 —— 那些信息 README 里早就有，
     在 Release 页面重复一遍只是让人多滚几屏。

   唯一绝对不能丢的一行：
     "<!-- ripple-version-code: N -->"
     Android 端 UpdateChecker.parseCodeFromBody() 靠它判新旧。GitHub Release API
     不提供 versionCode（只存在于 APK 内部），没有这行 App 内「检查更新」就
     永远解析失败，只能退化成版本名比较（1.3.10 vs 1.3.9 会判错）。
     所以 versionCode 的校验是**硬失败**，不是警告。

   跑法：
     node scripts/release-notes.js                      # 正文打到 stdout
     node scripts/release-notes.js --out /tmp/notes.md  # 写文件（CI 用这个）
     退出码 0 = 成功；非 0 = 失败（原因打到 stderr，中文）
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const DEFAULTS = {
  root: ROOT,
  versionJson: 'version.json',
  zhFile: 'CHANGELOG.md',
  enFile: 'docs/en/CHANGELOG_en.md',
};

const readText = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');

/* ---------------------------------------------------------------
 * versionCode / versionName
 *
 * versionCode 必须是**正整数**。这里的严格程度是事故换来的：
 *   1.3.5 的 Release 正文里那行标记是 "<!-- ripple-version-code:  -->"，
 *   数字整个是空的（YAML 里跨 step 取了不存在的变量），而 App 端解析失败时
 *   **不报错、静默退化成版本名比较** —— 于是「产物看起来正常、但一行关键
 *   元数据是空的」这件事直到发布后人工核对才发现。
 *   所以这里宁可让 CI 红，也不发一个解析不出新旧版本的 Release。
 *
 * 允许数字型的字符串（"137"），因为历史上 YAML 是用 sed 抓字段的，
 * 抓出来天然是字符串；但 "137abc" / 0 / -1 / 1.5 / 缺失 一律拒绝。
 * --------------------------------------------------------------- */
function readVersion(root, versionJson) {
  const p = path.join(root, versionJson);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error(
      '读取 ' + versionJson + ' 失败：' + (e && e.message) +
      '。它是版本号的唯一来源，必须在仓库根目录且是合法 JSON。'
    );
  }

  const vc = raw && raw.versionCode;
  let code = NaN;
  if (typeof vc === 'number') {
    code = vc;
  } else if (typeof vc === 'string' && /^[0-9]+$/.test(vc.trim())) {
    code = Number(vc.trim());
  }
  if (!Number.isInteger(code) || code <= 0) {
    throw new Error(
      'versionCode 不是正整数（' + versionJson + ' 里读到的值：' +
      JSON.stringify(vc) + '）。' +
      'Release 正文必须带 <!-- ripple-version-code: N --> 这行标记，' +
      '而 App 内「检查更新」靠它按整数比新旧；空了或不是正整数，' +
      'App 端会静默退化成版本名比较（1.3.10 vs 1.3.9 判错）。' +
      '请检查 ' + versionJson + ' 的 versionCode。'
    );
  }

  const vn = raw && raw.versionName;
  if (typeof vn !== 'string' || vn.trim() === '') {
    throw new Error(
      'versionName 缺失或不是非空字符串（' + versionJson + ' 里读到的值：' +
      JSON.stringify(vn) + '）。正文按 "## <versionName>" 去 CHANGELOG 里找段落，' +
      '没有版本名就无从定位。'
    );
  }

  return { versionCode: code, versionName: vn.trim() };
}

/* ---------------------------------------------------------------
 * 在 CHANGELOG 里切出「某一版」的段落
 *
 * 段落 = 从 "## <versionName>" 那一行开始，到下一个 "## " 之前。
 * 判定版本标题时必须看**版本名后面紧跟的字符**：只用 startsWith(versionName)
 * 会让 1.3.7 命中 1.3.70 / 1.3.77，取错段落却毫无征兆。
 * --------------------------------------------------------------- */
function isVersionHeading(line, versionName) {
  if (!line.startsWith('## ')) return false;          // '### ' / '#### ' 天然不匹配
  const rest = line.slice(3).trim();
  if (!rest.startsWith(versionName)) return false;
  const next = rest.charAt(versionName.length);
  return next === '' || /\s/.test(next);
}

function findSection(src, versionName) {
  const lines = src.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isVersionHeading(lines[i], versionName)) { start = i; break; }
  }
  if (start < 0) return null;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) { end = i; break; }
  }
  return lines.slice(start, end);
}

/* ---------------------------------------------------------------
 * 从版本段落里**只挑「摘要块」：第一个 --- 之前的分块标题 + 列表项**
 *
 * ⚠️ 这是本文件最重要的规则，也是「正文别又变成长篇大论」的机器防线。
 *
 * 版本段落的实际结构（1.3.8 起，见 CHANGELOG.md）是**两段式**：
 *
 *     ## 1.3.8 — 第十五个版本
 *     > 本次依据：……            ← 引用块，丢弃
 *     正文段落……                 ← 普通段落，丢弃
 *     ### 三端共同               ← 摘要，保留
 *     - 条目                     ← 保留
 *     ### Android
 *     - 条目
 *     ---                        ← ★ 分隔线：之后是「详情」，**整段不要**
 *     ### 一、详情小节
 *     （大段正文 + 列表 + 引用 + 代码块）
 *
 * 用户的要求是「不要长篇大论」。摘要块就是给人一眼看完的版本要点；
 * 详情留在 CHANGELOG.md 里，想看的人点进去看。所以这里**只取第一个 --- 之前**。
 * 找不到 --- 时取整段 —— 兼容 1.3.7 及更早的旧格式（它们没有详情分隔线）。
 *
 * 保留：
 *   "### 标题"（恰好三个 # —— 四级标题 "#### " 是正文解释，不要；
 *              输出时**保留 "### " 前缀原样**，渲染成 Markdown 三级标题）
 *   "- 项"、"  - 子项"（缩进原样保留，层级信息别丢）
 * 丢弃：
 *   "> 引用"、普通段落、空行、围栏代码块（含块内的假列表行）、
 *   第一个 --- 之后的**一切**
 *
 * 为什么代码块要单独跟踪：CHANGELOG 里大量用围栏贴配置与 diff，
 * 块内以 "- " 开头的行是**代码**而不是列表项。只按行首正则过滤的话，
 * 这些行会混进 Release 正文，看起来像功能条目，实际是配置文件片段。
 * 同一个道理：代码块里的一行 "---" 也不是分隔线，不能在那里切段。
 *
 * 「连续空行压成一个」：空行一律不产生输出，块与块之间由渲染阶段补
 * 一个空行 —— 效果就是任意多个连续空行都只变成一个。
 *
 * 返回：保留行的数组（顺序与原段落一致），例如
 *   ["### 三端共同", "- 条目A", "### Android", "- 条目B"]
 * --------------------------------------------------------------- */
function extractBlocks(sectionLines) {
  const kept = [];
  let inFence = false;
  /* 上一行是不是刚收进来的列表项（决定下一行缩进算不算续行） */
  let lastWasItem = false;
  const fenceRe = /^\s*(```|~~~)/;
  const hrRe = /^ {0,3}-{3,}[ \t]*$/;      // 摘要/详情分隔线

  for (const raw of sectionLines) {
    const line = raw.replace(/[ \t]+$/, '');

    // 围栏代码块：开闭都可能是三反引号或三个波浪线，块内一律丢弃
    if (fenceRe.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;

    // 第一个 --- 就是摘要与详情的分界；之后的详情一个字都不进 Release 正文
    if (hrRe.test(line)) break;

    // 只认恰好三个 #：'#### ' 在位置 3 是 '#' 而不是空格，天然不匹配
    if (line.startsWith('### ')) {
      kept.push(line);                     // '### ' 前缀原样保留
      lastWasItem = false;
      continue;
    }
    const m = /^ {0,2}- (.*)$/.exec(line);  // 无缩进或两空格缩进的列表项
    if (m) {
      if (m[1].trim() === '') continue;     // 空列表项不算内容
      kept.push(line);
      lastWasItem = true;
      continue;
    }
    /*
     * 列表项的**续行**必须一起保留。
     *
     * 现象：CHANGELOG 里一条变更常常写两行（第二行缩进两格接着写），
     * 而这里原来只认 '- ' 开头的那一行。结果 Release 正文里所有长条目
     * 都被腰斩成半句话 —— 实测「换句后停顿一秒才动」那条只剩
     * 「渐变百分比铺在整行宽的元素上，文字却居中，」然后就断了。
     * 半句话比不写更糟：读者会以为作者漏字。
     *
     * 判据：上一行刚收进一条列表项，且当前行以空白开头（markdown 的续行写法），
     * 且不是另一个列表项/标题（那些在上面已经分支掉了）。
     * 全是空白的行不算续行（它只是段落之间空行）。
     */
    if (lastWasItem && /^[ \t]+\S/.test(line)) {
      kept.push(line);
      continue;
    }
    // 其余（> 引用 / 普通段落 / 空行 / 其它缩进）全部丢弃
    lastWasItem = false;
  }
  return kept;
}

/* 列表项条数 —— 用来判「这版是不是一个字都没写」 */
const countItems = (blocks) =>
  blocks.filter((l) => /^ {0,2}- /.test(l)).length;

/* 渲染一侧：标题行 + 一个空行 + 保留行；块之间用一个空行隔开 */
function renderSide(title, blocks) {
  const lines = [title];
  for (const line of blocks) {
    /*
     * 三种行，各自的「前面要不要空一行」不同：
     *   · '### ' 小节标题 —— 要空行（否则 Markdown 会把它当成上一段的延续）
     *   · '- ' 列表项    —— 不要（紧跟在上一条后面，保持列表连续）
     *   · 缩进续行        —— **绝对不要**：中间插一个空行，这条列表项就被
     *                        Markdown 断成「半句话 + 一个独立缩进段落」，
     *                        在 Release 页面上看起来就是一句话被劈开。
     *                        这正是「长条目被腰斩」的直接原因。
     */
    if (/^[ 	]+\S/.test(line)) {
      lines.push(line);
    } else if (line.startsWith('- ')) {
      lines.push(line);
    } else {
      lines.push('');
      lines.push(line);
    }
  }
  return lines;
}

/* ---------------------------------------------------------------
 * 主入口（测试直接 require 这个函数，不起子进程）
 * --------------------------------------------------------------- */
function buildReleaseNotes(opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  const root = o.root;

  const v = readVersion(root, o.versionJson);
  const versionCode = v.versionCode;
  const versionName = v.versionName;

  const zhSrc = readText(root, o.zhFile);
  const zhSection = findSection(zhSrc, versionName);
  if (!zhSection) {
    throw new Error(
      '在 ' + o.zhFile + ' 里找不到版本 ' + versionName + ' 的段落' +
      '（期望有一行以 "## ' + versionName + '" 开头）。' +
      '发版前请先在 CHANGELOG.md 里补这一版的更新条目 —— ' +
      'Release 正文就是从这里生成的，找不到就没有正文可发。'
    );
  }

  const enSrc = readText(root, o.enFile);
  const enSection = findSection(enSrc, versionName);
  if (!enSection) {
    throw new Error(
      '在 ' + o.enFile + ' 里找不到版本 ' + versionName + ' 的段落' +
      '（期望有一行以 "## ' + versionName + '" 开头）。' +
      '中英两版必须同时有该版本段落，否则 Release 正文只有一半。'
    );
  }

  const zhBlocks = extractBlocks(zhSection);
  const enBlocks = extractBlocks(enSection);

  const zhItems = countItems(zhBlocks);
  const enItems = countItems(enBlocks);
  if (zhItems === 0 || enItems === 0) {
    const empty = [];
    if (zhItems === 0) empty.push(o.zhFile + '（中文）');
    if (enItems === 0) empty.push(o.enFile + '（英文）');
    throw new Error(
      '版本 ' + versionName + ' 的说明里一个列表项都没有：' + empty.join(' / ') +
      '。正文只取「第一个 --- 分隔线之前」那一段，并且只保留' +
      '「分块标题（###）+ 列表项（- ）」；' +
      '其余（> 引用、普通段落、代码块、--- 之后的详情）全部丢弃 —— ' +
      '所以如果摘要块没写列表项，渲染出来就是一个只有标题的空正文。' +
      '请在这一版的第一个 --- 之前用 "### 小节标题" + "- 条目" 写摘要。'
    );
  }

  const lines = [];
  lines.push('<!-- ripple-version-code: ' + versionCode + ' -->');
  lines.push('');
  lines.push.apply(lines, renderSide('## 本次更新', zhBlocks));
  lines.push('');
  lines.push.apply(lines, renderSide('## This release', enBlocks));

  const body = lines.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
  return { body: body, versionCode: versionCode, versionName: versionName,
           zhBlocks: zhBlocks, enBlocks: enBlocks };
}

/* ---------------------------------------------------------------
 * 命令行入口
 *   --out <path>  写到文件；省略则打到 stdout
 *   失败：中文原因打到 stderr，退出码 1
 * --------------------------------------------------------------- */
function parseArgs(argv) {
  const args = { out: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out' || a === '-o') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error('--out 后面必须跟一个文件路径');
      }
      args.out = next;
      i++;
    } else if (a === '--help' || a === '-h') {
      args.help = true;
    } else {
      throw new Error('不认识的参数：' + a + '（支持 --out <path>）');
    }
  }
  return args;
}

function main(argv) {
  try {
    const args = parseArgs(argv || process.argv.slice(2));
    if (args.help) {
      process.stdout.write(
        '跑法：node scripts/release-notes.js [--out <file>]\n' +
        '  省略 --out 时正文打到 stdout（便于本地看一眼）。\n'
      );
      return 0;
    }

    const built = buildReleaseNotes();
    if (args.out) {
      fs.writeFileSync(args.out, built.body, 'utf8');
      process.stderr.write(
        '已生成 Release 正文：' + args.out +
        '（版本 ' + built.versionName + ' · versionCode ' + built.versionCode +
        ' · 中文 ' + countItems(built.zhBlocks) + ' 条 / 英文 ' +
        countItems(built.enBlocks) + ' 条 · ' +
        built.body.split('\n').length + ' 行）\n'
      );
    } else {
      process.stdout.write(built.body);
    }
    return 0;
  } catch (e) {
    process.stderr.write('\n✗ Release 正文生成失败：\n' +
      (e && e.message ? e.message : String(e)) + '\n\n');
    return 1;
  }
}

module.exports = {
  buildReleaseNotes: buildReleaseNotes,
  main: main,
  // 供测试细粒度使用（不是对外契约，但元测试要能单独验一层）
  extractBlocks: extractBlocks,
  findSection: findSection,
  readVersion: readVersion,
};

if (require.main === module) {
  process.exit(main());
}
