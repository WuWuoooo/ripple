/* ============================================================
   Release 正文生成器的回归测试（1.3.7 起）

   scripts/release-notes.js 原来是写在 .github/workflows/build.yml 里的一段
   awk + shell 重定向。它无法在本地跑、也无法被测试，只能推上去看 CI 红不红 ——
   1.3.5 那次「正文里 versionCode 标记是空的」就是在那种环境下静默发出去的。
   搬进 node 脚本的头号目的就是**能被这里直接 require 并断言**：
   四个硬失败分支每个都有用例，另有一条元测试证明判据真的会红。

   ⚠️ 所有用例都用**临时目录里的 fixture**，不读真实 CHANGELOG.md。
   原因很实际：别人正在改 CHANGELOG，如果断言绑在真实内容上，
   这些测试会因为「文案变了」而红 —— 那不是回归，那是噪音，
   最后所有人都学会无视红灯。真实仓库只在最后一条用例里验一次冒烟。

   跑法：node --test tests/release-notes.test.js
        （bash tests/run.sh 会连它一起跑）
   ============================================================ */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildReleaseNotes } = require('../scripts/release-notes.js');

const ROOT = path.join(__dirname, '..');

/* ---------------------------------------------------------------
 * fixture：在临时目录里造一个「迷你仓库」
 *
 * 目录结构与真实仓库一致（CHANGELOG.md + docs/en/CHANGELOG_en.md +
 * version.json），这样脚本里的相对路径解析被真正走到了，
 * 而不是被 mock 掉 —— 路径拼错这类问题才有机会被测出来。
 * --------------------------------------------------------------- */
function makeFixture(opts) {
  const o = opts || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ripple-notes-'));

  const versionJson = Object.prototype.hasOwnProperty.call(o, 'versionJson')
    ? o.versionJson                                  // 允许传 undefined → 测「缺失」
    : { versionCode: 138, versionName: '1.3.8' };
  if (versionJson !== undefined) {
    fs.writeFileSync(path.join(dir, 'version.json'),
      typeof versionJson === 'string' ? versionJson : JSON.stringify(versionJson, null, 2) + '\n',
      'utf8');
  }

  if (o.zh !== undefined) fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), o.zh, 'utf8');
  if (o.en !== undefined) {
    fs.mkdirSync(path.join(dir, 'docs', 'en'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'docs', 'en', 'CHANGELOG_en.md'), o.en, 'utf8');
  }
  if (o.extra) o.extra(dir);

  return dir;
}

const cleanup = (dir) => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 临时目录，删不掉也不影响结论 */ }
};

/* 跑一次并在结束时清理临时目录 */
function run(dir) {
  try {
    return buildReleaseNotes({ root: dir });
  } finally {
    cleanup(dir);
  }
}

/*
 * 一份「标准」中文版本段落：
 *   摘要块（### + - 列表） → 空行 → --- → 空行 → 详情块（不该进正文）
 * 后面再接一个旧版本段落，用来验证「切段到下一个 ## 为止」。
 */
const ZH_OK = [
  '# 更新记录',
  '',
  '---',
  '',
  '## 1.3.8 — 第十五个版本',
  '',
  '> **本次依据**：用户报的若干真机问题。',
  '',
  '这一版改的是三端同步的细节。',
  '',
  '### 三端共同',
  '- 增加三端歌词同步功能',
  '- 修复 Windows 的安装向导语言',
  '  - 缩进子项也属于摘要',
  '',
  '### Android',
  '- 状态栏歌词新增原生控制条',
  '',
  '---',
  '',
  '### 一、详情小节（不该出现在 Release 正文里）',
  '',
  '- 详情列表项（不该出现）',
  '',
  '> 详情引用（不该出现）',
  '',
  '## 1.3.7 — 第十四个版本',
  '',
  '### 三端共同',
  '- 上一版的条目（不该出现）',
  '',
].join('\n');

const EN_OK = [
  '# Changelog',
  '',
  '---',
  '',
  '## 1.3.8 — Fifteenth Version',
  '',
  '> **Basis**: issues reported by the owner.',
  '',
  'This release is about sync details.',
  '',
  '### Shared',
  '- Three-platform lyric sync',
  '- Windows installer language fix',
  '  - indented sub item is part of the summary',
  '',
  '### Android',
  '- Native control bar for the status-bar lyric overlay',
  '',
  '---',
  '',
  '### 1. Detail section (must not appear in the release body)',
  '',
  '- detail list item (must not appear)',
  '',
  '> detail quote (must not appear)',
  '',
  '## 1.3.7 — Fourteenth Version',
  '',
  '### Shared',
  '- previous version item (must not appear)',
  '',
].join('\n');

/* ---------------------------------------------------------------
 * 1. 正常路径
 * --------------------------------------------------------------- */
test('正常：中英摘要块各两块，正文含两个大标题 + 四条列表项 + versionCode 标记', () => {
  const dir = makeFixture({ zh: ZH_OK, en: EN_OK });
  const out = run(dir);

  assert.equal(out.versionCode, 138);

  /* 机器可读的 versionCode 标记：App 内「检查更新」靠它判新旧，绝不能丢 */
  assert.match(out.body, /^<!-- ripple-version-code: 138 -->$/m);
  assert.match(out.body, /^## 本次更新$/m);
  assert.match(out.body, /^## This release$/m);

  /* 四条摘要列表项（中英各两条） */
  assert.match(out.body, /^- 增加三端歌词同步功能$/m);
  assert.match(out.body, /^- 修复 Windows 的安装向导语言$/m);
  assert.match(out.body, /^- Three-platform lyric sync$/m);
  assert.match(out.body, /^- Windows installer language fix$/m);

  /* 分块标题保留 ### 前缀原样输出 */
  assert.match(out.body, /^### 三端共同$/m);
  assert.match(out.body, /^### Android$/m);
  assert.match(out.body, /^### Shared$/m);

  /* 中文块在前、英文块在后，中间不加分隔线也不加说明行 */
  assert.ok(out.body.indexOf('## 本次更新') < out.body.indexOf('## This release'),
    '中文块必须在英文块之前');
  const between = out.body.slice(
    out.body.indexOf('## 本次更新'),
    out.body.indexOf('## This release'));
  assert.ok(!/^---$/m.test(between), '两个语言块之间不允许出现 --- 分隔线');
  assert.ok(!/bilingual|双语/.test(out.body), '正文不允许出现双语说明行');
});

/* ---------------------------------------------------------------
 * 2. 只挑列表项：引用 / 段落 / 四级标题 / 代码块里的假列表都不能漏出来
 * --------------------------------------------------------------- */
test('只挑分块标题与列表项：引用、段落、#### 四级标题、代码块里的假列表都不出现', () => {
  const zh = [
    '# 更新记录',
    '',
    '## 1.3.8',
    '',
    '> 这一行是引用，不该出现',
    '',
    '这一行是普通段落文字，不该出现。',
    '',
    '#### 四级小标题不该出现',
    '',
    '### 三端共同',
    '- 保留的条目',
    '',
    '```text',
    '- 代码块里的假列表',
    '```',
    '',
    '## 1.3.7',
    '',
  ].join('\n');

  const en = [
    '# Changelog',
    '',
    '## 1.3.8',
    '',
    '> a quote that must not appear',
    '',
    'A plain paragraph that must not appear.',
    '',
    '#### a fourth-level heading that must not appear',
    '',
    '### Shared',
    '- kept entry',
    '',
    '```text',
    '- a fake list item inside a code fence',
    '```',
    '',
    '## 1.3.7',
    '',
  ].join('\n');

  const dir = makeFixture({ zh: zh, en: en });
  const out = run(dir);

  /* 该留的留下了 */
  assert.match(out.body, /^- 保留的条目$/m);
  assert.match(out.body, /^### 三端共同$/m);
  assert.match(out.body, /^- kept entry$/m);

  /* 不该留的一个字都别出现 */
  assert.ok(!out.body.includes('这一行是引用'), '> 引用行不该出现在正文里');
  assert.ok(!out.body.includes('这一行是普通段落文字'), '普通段落不该出现在正文里');
  assert.ok(!out.body.includes('四级小标题'), '#### 四级标题不该出现在正文里（只认三个 #）');
  assert.ok(!out.body.includes('代码块里的假列表'), '围栏代码块里的 - 行是代码，不是列表项');
  assert.ok(!out.body.includes('a quote that must not appear'));
  assert.ok(!out.body.includes('A plain paragraph that must not appear.'));
  assert.ok(!out.body.includes('a fourth-level heading'));
  assert.ok(!out.body.includes('a fake list item inside a code fence'));
});

/* ---------------------------------------------------------------
 * 3. 缩进子项要保留（层级信息是摘要的一部分）
 * --------------------------------------------------------------- */
test('缩进子项（两个空格 + 短横线 + 空格）原样保留', () => {
  const zh = [
    '## 1.3.8', '', '### 三端共同', '- 条目', '  - 缩进子项', '', '## 1.3.7', '',
  ].join('\n');
  const en = [
    '## 1.3.8', '', '### Shared', '- item', '  - indented child', '', '## 1.3.7', '',
  ].join('\n');

  const dir = makeFixture({ zh: zh, en: en });
  const out = run(dir);

  assert.match(out.body, /^ {2}- 缩进子项$/m, '缩进子项必须原样保留（含两个空格缩进）');
  assert.match(out.body, /^ {2}- indented child$/m);
});

/* ---------------------------------------------------------------
 * 3b. ★ 只取第一个 --- 之前 —— 「正文别又变成长篇大论」的机器防线
 *
 * 真实 CHANGELOG 的版本段落是两段式：前半是摘要（### + 列表项），
 * 分隔线 --- 之后是详情（大段正文，也含 ### / 列表项 / 引用 / 代码块）。
 * 用户明确要求「不要长篇大论」，所以详情整段不能进 Release 正文。
 * --------------------------------------------------------------- */
test('只取第一个 --- 之前：详情段落的 ### 与列表项都不出现在正文里', () => {
  const zh = [
    '## 1.3.8',
    '',
    '### 三端共同',
    '- 摘要条目一',
    '',
    '---',
    '',
    '### 一、详情小节不该出现',
    '- 详情列表项不该出现',
    '',
    '> 详情引用不该出现',
    '',
    '## 1.3.7',
    '',
  ].join('\n');
  const en = [
    '## 1.3.8',
    '',
    '### Shared',
    '- summary item one',
    '',
    '---',
    '',
    '### 1. Detail section must not appear',
    '- detail list item must not appear',
    '',
    '> detail quote must not appear',
    '',
    '## 1.3.7',
    '',
  ].join('\n');

  const dir = makeFixture({ zh: zh, en: en });
  const out = run(dir);

  assert.match(out.body, /^- 摘要条目一$/m);
  assert.match(out.body, /^- summary item one$/m);

  assert.ok(!out.body.includes('详情小节不该出现'), '分隔线之后的详情小节标题不该进正文');
  assert.ok(!out.body.includes('详情列表项不该出现'), '分隔线之后的详情列表项不该进正文');
  assert.ok(!out.body.includes('详情引用不该出现'));
  assert.ok(!out.body.includes('Detail section must not appear'));
  assert.ok(!out.body.includes('detail list item must not appear'));

  /* 分隔线本身也不该留在正文里 */
  assert.ok(!/^---$/m.test(out.body), '摘要/详情之间的分隔线不该出现在正文里');
});

/* ---------------------------------------------------------------
 * 4. versionCode 为 0 / 非数字 / 缺失 → 抛错，且报错里出现 versionCode
 * --------------------------------------------------------------- */
test('versionCode 为 0 → throw，错误消息里出现 versionCode', () => {
  const dir = makeFixture({
    versionJson: { versionCode: 0, versionName: '1.3.8' }, zh: ZH_OK, en: EN_OK,
  });
  try {
    assert.throws(() => buildReleaseNotes({ root: dir }),
      (e) => {
        assert.match(String(e.message), /versionCode/);
        return true;
      });
  } finally {
    cleanup(dir);
  }
});

test('versionCode 是字符串 137abc → throw，错误消息里出现 versionCode', () => {
  const dir = makeFixture({
    versionJson: { versionCode: '137abc', versionName: '1.3.8' }, zh: ZH_OK, en: EN_OK,
  });
  try {
    assert.throws(() => buildReleaseNotes({ root: dir }),
      (e) => {
        assert.match(String(e.message), /versionCode/);
        return true;
      });
  } finally {
    cleanup(dir);
  }
});

test('versionCode 缺失 → throw，错误消息里出现 versionCode', () => {
  const dir = makeFixture({
    versionJson: { versionName: '1.3.8' }, zh: ZH_OK, en: EN_OK,
  });
  try {
    assert.throws(() => buildReleaseNotes({ root: dir }),
      (e) => {
        assert.match(String(e.message), /versionCode/);
        return true;
      });
  } finally {
    cleanup(dir);
  }
});

/* ---------------------------------------------------------------
 * 5. 中文 CHANGELOG 里没有该版本 → throw，消息里出现版本号
 * --------------------------------------------------------------- */
test('CHANGELOG.md 里没有该版本段落 → throw，消息里出现版本号', () => {
  const zh = ['# 更新记录', '', '## 1.3.7', '', '### 三端共同', '- 旧条目', ''].join('\n');
  const dir = makeFixture({ zh: zh, en: EN_OK });
  try {
    assert.throws(() => buildReleaseNotes({ root: dir }),
      (e) => {
        assert.match(String(e.message), /1\.3\.8/);
        assert.match(String(e.message), /CHANGELOG\.md/);
        return true;
      });
  } finally {
    cleanup(dir);
  }
});

/* ---------------------------------------------------------------
 * 6. 英文 CHANGELOG 里没有该版本 → throw
 * --------------------------------------------------------------- */
test('docs/en/CHANGELOG_en.md 里没有该版本段落 → throw', () => {
  const en = ['# Changelog', '', '## 1.3.7', '', '### Shared', '- old item', ''].join('\n');
  const dir = makeFixture({ zh: ZH_OK, en: en });
  try {
    assert.throws(() => buildReleaseNotes({ root: dir }),
      (e) => {
        assert.match(String(e.message), /CHANGELOG_en\.md/);
        assert.match(String(e.message), /1\.3\.8/);
        return true;
      });
  } finally {
    cleanup(dir);
  }
});

/* ---------------------------------------------------------------
 * 7. 摘要块里一个列表项都没有 → throw（避免发一个只有标题的空正文）
 *
 * 注意 fixture 的构造：分隔线之后**故意放着列表项**。
 * 这样这条用例同时钉住两件事 —— 「详情里的列表项不算摘要」，
 * 以及「摘要空了就必须红」。
 * --------------------------------------------------------------- */
test('摘要块里一个列表项都没有 → throw', () => {
  const zh = [
    '## 1.3.8', '', '> 只有引用，没有列表项', '', '这一版什么都没写清楚。',
    '', '---', '', '### 详情', '- 详情里有列表项，但那是分隔线之后的，不算摘要',
    '', '## 1.3.7', '',
  ].join('\n');
  const en = [
    '## 1.3.8', '', '> only a quote', '', 'A paragraph with no list at all.',
    '', '---', '', '### Detail', '- a list item after the rule, not part of the summary',
    '', '## 1.3.7', '',
  ].join('\n');

  const dir = makeFixture({ zh: zh, en: en });
  try {
    assert.throws(() => buildReleaseNotes({ root: dir }),
      (e) => {
        assert.match(String(e.message), /列表项/);
        return true;
      });
  } finally {
    cleanup(dir);
  }
});

/* ---------------------------------------------------------------
 * 8. 元测试（必须有）
 *
 * 上面第 4 条断言「versionCode 为 0 会抛」。如果 buildReleaseNotes 里的
 * versionCode 校验被删掉、或者变成了「因为别的原因抛」，那条测试可能恒真。
 * 这里做两件事证明判据不是恒真：
 *   ① 对照组：同一份 fixture，versionCode 正常时必须**成功**；
 *   ② 实验组：只把 versionCode 改成 0，其余字节完全相同，必须**抛错**，
 *      且报错点名 versionCode、带上读到的实际值。
 * 两条放在同一个用例里，是因为「翻转」这个性质只有并排看才成立。
 * --------------------------------------------------------------- */
test('元测试：同一 fixture 只改 versionCode 138 ↔ 0，成功/抛错必须真的翻转', () => {
  /* ① 对照组：versionCode 正常时必须成功 —— 否则「会抛」这件事什么都证明不了 */
  const okDir = makeFixture({ versionJson: { versionCode: 138, versionName: '1.3.8' }, zh: ZH_OK, en: EN_OK });
  let okBody = null;
  try {
    okBody = buildReleaseNotes({ root: okDir }).body;
  } finally {
    cleanup(okDir);
  }
  assert.match(okBody, /^<!-- ripple-version-code: 138 -->$/m,
    '对照组必须成功且带正确的 versionCode 标记');

  /* ② 实验组：只把 versionCode 改成 0，其余完全相同 → 必须抛 */
  const zeroDir = makeFixture({ versionJson: { versionCode: 0, versionName: '1.3.8' }, zh: ZH_OK, en: EN_OK });
  let thrown = null;
  try {
    buildReleaseNotes({ root: zeroDir });
  } catch (e) {
    thrown = e;
  } finally {
    cleanup(zeroDir);
  }

  assert.ok(thrown,
    '把 versionCode 改成 0 之后必须抛错 —— 不抛说明 versionCode 校验已经失效，' +
    'Release 正文会带着空的 version-code 标记发出去，App 内「检查更新」将永远解析失败' +
    '（1.3.5 的事故形态）');
  assert.match(String(thrown.message), /versionCode/,
    '报错必须点名 versionCode，否则运维看不出是哪个字段坏了');
  assert.match(String(thrown.message), /0/,
    '报错里应带上读到的实际值（0），便于定位');
});

/* ---------------------------------------------------------------
 * 9. 真实仓库冒烟：只断言「能跑通且带标记」，不断言具体文案
 *
 * 这一条和上面那些 fixture 用例的分工：fixture 守住**规则**，
 * 这里只守住**真实 CHANGELOG.md 的段落形状没把脚本搞崩**。
 * 特意不比对任何一条真实文案 —— 别人改 CHANGELOG 不该让测试变红。
 * --------------------------------------------------------------- */
test('真实仓库冒烟：当前 version.json 能生成带 versionCode 标记的正文', () => {
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'version.json'), 'utf8'));
  const out = buildReleaseNotes({ root: ROOT });

  assert.equal(out.versionCode, Number(version.versionCode));
  assert.match(out.body, /^<!-- ripple-version-code: \d+ -->$/m);
  assert.match(out.body, /^## 本次更新$/m);
  assert.match(out.body, /^## This release$/m);
  assert.ok(!/^---$/m.test(out.body), '真实仓库生成的正文里也不该有分隔线');
});

/* --------------------------------------------------- 续行（1.3.8） */

test('列表项写两行时，续行必须保留，且不能被空行与上一条隔开', () => {
  /*
   * 现象：CHANGELOG 里一条变更常写成两行（第二行缩进两格接着写）。
   * 提取器原来只认 '- ' 开头那一行 → Release 正文里长条目全部腰斩成半句话；
   * 渲染器又给续行前面插了空行 → Markdown 把它断成「半句话 + 独立段落」。
   * 实测「换句后停顿一秒才动」那条只剩「……文字却居中，」然后就断了。
   * 半句话比不写更糟：读者会以为作者漏字。
   */
  const dir = makeFixture({
    zh: [
      '# 更新记录',
      '',
      '## 1.3.8 — 测试',
      '',
      '### 三端共同',
      '- **一条长的变更**：前半句写在这里，',
      '  后半句缩进两格接着写，不能被丢掉',
      '- 一条短的',
      '',
      '---',
      '',
      '### 详情（不该出现）',
      '- 详情列表项',
    ].join('\n'),
    en: [
      '# Changelog',
      '',
      '## 1.3.8 — Test',
      '',
      '### Shared',
      '- **A long change**: first half here,',
      '  second half indented two spaces and must not be dropped',
    ].join('\n'),
  });
  const out = run(dir);

  /* ① 续行必须出现在正文里 */
  assert.match(out.body, /后半句缩进两格接着写，不能被丢掉/,
    '续行被丢了 —— 条目会在 Release 页面上变成半句话');
  assert.match(out.body, /second half indented two spaces and must not be dropped/);

  /* ② 续行必须紧贴上一条（中间不能有空行，否则 Markdown 会断开列表） */
  const zhPart = out.body.slice(out.body.indexOf('## 本次更新'),
    out.body.indexOf('## This release'));
  assert.match(zhPart, /前半句写在这里，\n {2}后半句缩进两格接着写/,
    '续行和上一条之间被插了空行，Markdown 会把这条断成两段');

  /* ③ 详情块仍然一个字段都不许进来 */
  assert.doesNotMatch(out.body, /详情列表项/);
});

test('元测试：抹掉续行判据，上面那条必须真的会红', () => {
  /*
   * 只断言「正文里有那半句话」是不够的 —— 砍掉续行逻辑后它当然不在了，
   * 但万一是 fixture 写错（比如两行合成一行）也一样会「通过」。
   * 这里直接对源码做变异：删掉 lastWasItem 分支，用同一套判据必须报错。
   */
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'release-notes.js'), 'utf8');
  const i = src.indexOf('if (lastWasItem');
  assert.ok(i > 0, '源码里找不到续行判据（lastWasItem）—— 判据可能只在注释里');
  const end = src.indexOf('continue;', i);
  assert.ok(end > i);
  const mutated = src.slice(0, i) + 'if (false) ' + src.slice(i);
  assert.notEqual(mutated, src);
  /* 变异后 writeFileSync 到临时文件再 require，确保跑的是真代码 */
  const tmp = path.join(os.tmpdir(), 'ripple-notes-mut-' + process.pid + '.js');
  let bm = null;
  try {
    fs.writeFileSync(tmp, mutated, 'utf8');
    /* eslint-disable-next-line global-require */
    bm = require(tmp);
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
    try { delete require.cache[tmp]; } catch (_) {}
  }
  assert.ok(bm, '变异版脚本没加载起来');

  const dir = makeFixture({
    zh: [
      '# 更新记录',
      '',
      '## 1.3.8 — 测试',
      '',
      '### 三端共同',
      '- **一条长的变更**：前半句写在这里，',
      '  后半句缩进两格接着写，不能被丢掉',
    ].join('\n'),
    en: [
      '# Changelog',
      '',
      '## 1.3.8 — Test',
      '',
      '### Shared',
      '- a change',
    ].join('\n'),
  });
  let body = '';
  try {
    body = bm.buildReleaseNotes({ root: dir }).body;
  } finally {
    cleanup(dir);
  }
  assert.doesNotMatch(body, /后半句缩进两格接着写/,
    '删掉续行判据之后续行居然还在 —— 说明那条判据是恒真的');
});
