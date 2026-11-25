/* ============================================================
   「名单一致性」检查的回归测试（审查 3.1）

   scripts/check-manifest-consistency.js 本身是个 CI 脚本，
   这里只做两件事：
     ① 断言它在**当前仓库**上必须通过（防止有人改坏了名单表）；
     ② 用临时副本注入已知的历史缺陷（1.3.0 的 G-01 / D-09），
        断言它**能抓出来** —— 一个抓不到问题的检查器比没有更糟。
   ============================================================ */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

/*
 * 注意：检查脚本把「失败项」打到 stderr、「通过项」打到 stdout
 * （这是脚本的合理设计：CI 里红色的是错误）。断言时必须看合并输出，
 * 否则会出现「确实失败了、但测试说没报出对应文案」的假阴性。
 */
const runCheck = (cwd) => {
  const r = spawnSync(process.execPath,
    [path.join(cwd, 'scripts', 'check-manifest-consistency.js')],
    { cwd: cwd, encoding: 'utf8', timeout: 30000 });
  r.all = (r.stdout || '') + (r.stderr || '');
  return r;
};

test('名单一致性：当前仓库必须通过', () => {
  const r = runCheck(ROOT);
  assert.strictEqual(r.status, 0,
    '名单检查未通过（三端命令/路径/状态码/版本号有不一致）：\n' + r.stdout + r.stderr);
});

/* 工具：把仓库复制到临时目录，改一处，跑检查 */
function withMutatedCopy(mutate, cb) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ripple-manifest-'));
  try {
    /*
     * 只复制检查需要的文件，比全仓 cp -a 快得多。
     *
     * ⚠️ 这份清单必须覆盖 checker **每一段**要读的文件。漏一个的后果不是
     * 「少测一条」，而是整段检查在临时副本里直接崩掉（ENOENT / require 失败），
     * 于是「确实失败了」碰巧成立、而「失败原因是我们注入的那个缺陷」不成立 ——
     * 断言具体报错文案的那一行就会红。1.3.5 加 [D] 的唯一解析器
     * （scripts/version-facts.js）时就是漏了它，导致「能抓出版本漂移」这条
     * 回归测试变成了假失败：报的是「解析器不可用」而不是「Cargo.toml 版本不对」。
     */
    const need = [
      'scripts/check-manifest-consistency.js',
      /* [D]/[G] 的唯一版本解析器 —— 漏了它 D 段直接报「不可用」 */
      'scripts/version-facts.js',
      'version.json',
      'server.js', 'app/js/netease.js', 'app/js/app.js', 'app/js/version.js',
      'app/sw.js', 'android/app/src/main/java/com/ripple/app/NeteaseClient.java',
      'desktop/src-tauri/src/netease.rs', 'desktop/src-tauri/tauri.conf.json',
      'desktop/src-tauri/Cargo.toml', 'desktop/src-tauri/Cargo.lock',
      /* [D] 的其余版本副本（少一个只会多报一条「文件不存在」，但会让
         「Cargo.toml 漂移」这条用例的失败原因变得不干净） */
      'android/app/build.gradle',
      'android/app/src/main/java/com/ripple/app/CrashLog.java',
      'android/app/src/main/java/com/ripple/app/RippleApp.java',
      /* [F] SHELL vs index.html */
      'app/index.html', 'app/manifest.webmanifest',
      /* [G] 同步侧声明 + 文档侧清单 */
      'android/sync-version.sh', 'CONTRIBUTING.md',
    ];
    for (const rel of need) {
      const dst = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(path.join(ROOT, rel), dst);
    }
    mutate(tmp);
    cb(runCheck(tmp), tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('名单一致性：能抓出「Rust 上游路径漂移」（D-09 同类）', () => {
  withMutatedCopy((tmp) => {
    const f = path.join(tmp, 'desktop/src-tauri/src/netease.rs');
    const s = fs.readFileSync(f, 'utf8');
    fs.writeFileSync(f, s.replace('"personal_fm" => self.post("v1/radio/get"',
      '"personal_fm" => self.post("personal/fm"'));
  }, (r) => {
    assert.notStrictEqual(r.status, 0, '改错 Rust 的 personal_fm 路径后，检查必须失败');
    assert.match(r.all, /三端路径不一致/, '应报「三端路径不一致」，实际：' + r.stdout);
  });
});

test('名单一致性：能抓出「扫码状态码漏项」（G-01 blocker 同类）', () => {
  withMutatedCopy((tmp) => {
    const f = path.join(tmp, 'app/js/netease.js');
    const s = fs.readFileSync(f, 'utf8');
    fs.writeFileSync(f, s.replace('SUCCESS: 803', 'SUCCESS: 804'));
  }, (r) => {
    assert.notStrictEqual(r.status, 0, 'QR_STATES 里把 803 改错后，检查必须失败');
    assert.match(r.all, /QR_STATES 缺少 SUCCESS: 803/);
  });
});

test('名单一致性：能抓出「白名单绕过常量」（G-01 的根因形态）', () => {
  withMutatedCopy((tmp) => {
    const f = path.join(tmp, 'app/js/netease.js');
    const s = fs.readFileSync(f, 'utf8');
    fs.writeFileSync(f, s.replace('QR_STATE_CODES.indexOf(codeNum)', 'codeNum === 200'));
  }, (r) => {
    assert.notStrictEqual(r.status, 0, '白名单不再由 QR_STATE_CODES 驱动时，检查必须失败');
    assert.match(r.all, /QR_STATE_CODES/);
  });
});

test('名单一致性：能抓出「桌面端版本漂移」（D-02 同类）', () => {
  withMutatedCopy((tmp) => {
    const f = path.join(tmp, 'desktop/src-tauri/Cargo.toml');
    const s = fs.readFileSync(f, 'utf8');
    fs.writeFileSync(f, s.replace(/^version = "[0-9.]+"/m, 'version = "1.2.3"'));
  }, (r) => {
    assert.notStrictEqual(r.status, 0, 'Cargo.toml 版本落后时，检查必须失败');
    assert.match(r.all, /Cargo\.toml/);
  });
});

/* ============================================================
   B-1 的真实场景：Cargo.toml 里 [package] 之前还有别的 version 键

   这是 1.3.5 报告里那一条 blocker 的**原始形态**，比上面那条「直接改
   [package].version」更刁钻：文件里第一处 ^version = 是别的表，
   而 [package].version 是旧的。

   旧实现（sed "0,/^version = .../" + 四处 sed|head -1）会：
     · 同步时改错表（改到第一处），[package].version 纹丝不动；
     · 检查时也读错表（读第一处），于是刚好读到「刚被改对的那个」→ 报绿。
   写与查共用同一个错误判据，断言恒等于改写结果。

   现在 scripts/version-facts.js 先切 [package] 段再取 version，
   所以这条必须能抓出来。
   ============================================================ */
test('名单一致性：能抓出「Cargo.toml [package] 之前有 version 键」的漂移（B-1）', () => {
  withMutatedCopy((tmp) => {
    const f = path.join(tmp, 'desktop/src-tauri/Cargo.toml');
    const s = fs.readFileSync(f, 'utf8');
    /*
     * 构造：在文件最前面插一个带 version 键的表（真实版本号，看起来完全正常），
     * 再把 [package].version 改成旧值。按「读第一处」的旧判据会读到 1.3.6 报绿，
     * 而 Tauri 打包实际用的是 [package].version = 1.2.3。
     */
    const vj = JSON.parse(fs.readFileSync(path.join(tmp, 'version.json'), 'utf8'));
    const mutated = '[patch.crates-io]\nversion = "' + vj.versionName + '"\n\n'
      + s.replace(/^(\[package\][^\n]*\n(?:[^\n]*\n)*?version = ")[0-9.]+(")/m,
        '$11.2.3$2');
    fs.writeFileSync(f, mutated);
  }, (r) => {
    assert.notStrictEqual(r.status, 0,
      '[package].version 是 1.2.3、文件第一处 version 是最新值时，检查必须失败');
    assert.match(r.all, /Cargo\.toml/,
      '失败信息要点名 Cargo.toml（实际输出：\n' + r.all + '）');
  });
});
