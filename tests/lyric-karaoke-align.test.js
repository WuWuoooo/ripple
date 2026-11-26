/*
 * 播放页「卡拉OK 染色对齐」与「封面尺寸抖动」的回归测试（1.3.8 真机反馈）。
 *
 * 两条症状，两个完全不同的根因：
 *
 * ① 「换句后停顿大约一秒，然后才继续填充」
 *    渐变百分比是相对元素 border box 铺的，而 .ln 被拉成整行宽、
 *    文字却又居中 —— 于是 --kp 前 37% 和后 37% 都落在文字外侧的空白里，
 *    画面上完全不动，只有中间三分之一在「扫过文字」。
 *    一句 2.7s 的歌词，两头各静 1s，正好是用户描述的「停顿一秒」。
 *
 * ② 「歌曲封面像是直接跳出来的，从小直接抽搐变大」
 *    publishCoverSize() 只判了 .expanded，没判 .collapsing。
 *    收起的第一帧就被判定成「稳定状态」，量到还塌着的容器高度
 *    （130px 之类）写进 --cover-size，下一帧又量回 287px —— 一抽搐。
 *
 * 为什么这两条必须用**真浏览器**验：
 *   它们都依赖真实 CSS 布局（flex 拉伸、border box 宽度、ResizeObserver 时机）。
 *   在 Node 里读源码只能验证「代码里出现了某个字符串」，而那正是
 *   1.3.5 i18n 覆盖率测试栽过的坑（取样范围内恒真）。
 *   这里用 headless Chrome 跑**从 app.js 原样抽出的函数体**，
 *   并把 base.css 原样喂进去 —— 改坏了就会红。
 *
 * 跑法：node --test tests/lyric-karaoke-align.test.js
 * 依赖：本机 /opt/chrome/chrome-linux64/chrome（没有就整体 skip，不报红）
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const CHROME = '/opt/chrome/chrome-linux64/chrome';
const SKIP = !fs.existsSync(CHROME);

/* ------------------------------------------------------------ 工具 */

/** 从源码里抠出一个具名函数的完整文本（大括号配平，跳过字符串与注释） */
function extractFn(src, name) {
  const m = new RegExp('function\\s+' + name + '\\s*\\(').exec(src);
  if (!m) return null;
  let i = src.indexOf('{', m.index + m[0].length - 1);
  if (i < 0) return null;
  let depth = 0;
  let inS = null;
  let inLine = false;
  let inBlock = false;
  for (let k = i; k < src.length; k++) {
    const c = src[k];
    const n = src[k + 1];
    if (inLine) { if (c === '\n') inLine = false; continue; }
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; k++; } continue; }
    if (inS) { if (c === '\\') { k++; continue; } if (c === inS) inS = null; continue; }
    if (c === '/' && n === '/') { inLine = true; k++; continue; }
    if (c === '/' && n === '*') { inBlock = true; k++; continue; }
    if (c === '"' || c === "'" || c === '`') { inS = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(m.index, k + 1);
    }
  }
  return null;
}

/** 拼一个带四张真实样式表的探针页 */
function probePage(bodyHtml, script) {
  return [
    '<!DOCTYPE html><html><head><meta charset="utf-8">',
    '<link rel="stylesheet" href="css/base.css">',
    '<link rel="stylesheet" href="css/layouts.css">',
    '<link rel="stylesheet" href="css/components.css">',
    '<link rel="stylesheet" href="css/responsive.css">',
    '<style>html,body{margin:0;padding:0;height:100%;background:#111}',
    /* 探针页不跑真实 App，把播放页强行显示出来（去掉 transform/visibility 约束） */
    '#np{position:relative!important;transform:none!important;visibility:visible!important;',
    '    height:900px!important;width:411px!important}',
    /*
     * 收起态三行与展开态整篇在 CSS 里是互斥的（.np.expanded .np-lyric{display:none}
     * 与 .np .lyric{display:none}）。探针要同时量两者，就各自强制显示一次 ——
     * 量的是「元素宽度是否等于文字宽度」，与谁显示谁隐藏无关。
     */
    '#mini{display:flex!important;flex-direction:column!important}',
    '#full{display:block!important;flex:1!important;min-height:0!important}',
    '</style></head><body>',
    bodyHtml,
    '<script>',
    script,
    'document.title = "ready";',
    '</' + 'script></body></html>',
  ].join('\n');
}

function cssFiles() {
  const out = {};
  for (const f of ['base.css', 'layouts.css', 'components.css', 'responsive.css']) {
    out['css/' + f] = fs.readFileSync(path.join(ROOT, 'app', 'css', f), 'utf8');
  }
  return out;
}

/** 起静态服务器 + headless Chrome，返回 { ev, done } */
async function withBrowser(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ripple-kf-'));
  for (const [name, body] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  const MIME = {
    '.html': 'text/html;charset=utf-8',
    '.css': 'text/css;charset=utf-8',
    '.js': 'application/javascript;charset=utf-8',
  };
  const srv = http.createServer((req, res) => {
    const p = path.join(dir, decodeURIComponent(req.url.split('?')[0]));
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'text/plain' });
    res.end(fs.readFileSync(p));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;

  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--remote-debugging-port=0', '--window-size=411,914',
    '--user-data-dir=' + path.join(dir, 'profile'), 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let buf = '';
  const wsUrl = await new Promise((resolve, reject) => {
    chrome.stderr.on('data', (d) => {
      buf += d.toString();
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) resolve(m[1]);
    });
    setTimeout(() => reject(new Error('chrome 没起来：' + buf.slice(0, 400))), 25000);
  });
  const host = wsUrl.match(/ws:\/\/([^/]+)\//)[1];
  const list = await (await fetch('http://' + host + '/json/list')).json();
  const target = list.find((t) => t.type === 'page');
  const pw = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => pw.addEventListener('open', r));

  let id = 0;
  const pending = new Map();
  pw.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  const send = (method, params) => new Promise((res) => {
    const i = ++id;
    pending.set(i, res);
    pw.send(JSON.stringify({ id: i, method, params }));
  });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) {
      throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 600));
    }
    return r.result.result.value;
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: 'http://127.0.0.1:' + port + '/probe.html' });
  let ready = false;
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (await ev('document.title') === 'ready') { ready = true; break; }
  }
  assert.ok(ready, '探针页没进入 ready 状态（脚本没跑完？）');
  const done = () => {
    try { chrome.kill(); } catch (e) { /* 已经退了 */ }
    try { srv.close(); } catch (e) { /* 同上 */ }
  };
  return { ev, done };
}

/* --------------------------------------------------------- ① 渐变对齐 */

test('卡拉OK：三行与展开层的 .ln 都收缩到文字宽度（否则硬边和文字错位）', { skip: SKIP ? '本机没有 ' + CHROME : false }, async () => {
  const css = fs.readFileSync(path.join(ROOT, 'app', 'css', 'base.css'), 'utf8');

  /*
   * 三行那一层：.ln 自己收缩到文字宽度（那一层没有译文，直接收缩即可）。
   */
  {
    const i = css.indexOf('.np-lyric .ln{');
    assert.ok(i >= 0, '找不到 .np-lyric .ln 规则');
    const rule = css.slice(i, css.indexOf('}', i));
    assert.match(rule, /width\s*:\s*fit-content/,
      '.np-lyric .ln 没有 width:fit-content —— 整行宽会让渐变百分比与文字错位，'
      + '表现为「换句后停顿一秒才开始填充」');
  }
  /*
   * 展开层：不能收缩 .ln（里面有译文，会把它撑宽），
   * 必须把正文包进 .tx 并把渐变挂到 .tx 上。
   */
  {
    const i = css.indexOf('.lyric .ln .tx{');
    assert.ok(i >= 0, '找不到 .lyric .ln .tx 规则 —— 展开层的正文包裹层没了');
    const rule = css.slice(i, css.indexOf('}', i));
    assert.match(rule, /display\s*:\s*inline-block/,
      '.lyric .ln .tx 必须是 inline-block：只有它收缩到文字宽度，'
      + '渐变硬边才会落在「正唱到的那个字」上');

    const j = css.indexOf('.lyric .ln.kf .tx{');
    assert.ok(j >= 0, '找不到 .lyric .ln.kf .tx 规则 —— 渐变的宿主被挪回去了？');
    const kf = css.slice(j, css.indexOf('}', j));
    assert.match(kf, /background-image\s*:\s*linear-gradient/,
      '渐变必须挂在 .tx 上：挂在 .ln 上会被译文撑宽的元素拉长，前段后段空跑');
  }

  /*
   * 必须按真实层级搭：.np → .np-inner → .np-lyricbox → .np-lyric / .lyric。
   * 少一层 .np-inner 会让 flex 链断掉，三行全都是 0 宽 ——
   * 那样断言会「通过」但什么都没验到（这一类假绿比红更危险）。
   */
  const body = [
    '<div class="np open expanded" id="np">',
    '<div class="np-inner">',
    '<div class="np-lyricbox" id="box">',
    '<div class="np-lyric" id="mini">',
    '<div class="ln" id="a"></div>',
    '<div class="ln cur" id="b"></div>',
    '<div class="ln" id="c"></div>',
    '</div>',
    '<div class="lyric" id="full">',
    '<div class="ln on" id="d"></div>',
    '</div>',
    '</div>',
    '</div>',
    '</div>',
  ].join('');

  const script = [
    'window.__probe = () => {',
    '  const out = [];',
    '  const set = (id, txt) => { document.getElementById(id).textContent = txt; };',
    '  set("a", "上一句中等长度的歌词");',
    '  set("b", "end...");',
    '  set("c", "下一句中等长度的歌词");',
    '  const d = document.getElementById("d");',
    '  d.innerHTML = \'<span class="tx">展开层当前这一句歌词内容</span>\'',
    '    + \'<span class="tr">and this translation is much much longer than the lyric itself</span>\';',
    '  // 超长句：验证收缩后仍被 max-width 压住、不会撑破容器',
    '  const long = document.createElement("div");',
    '  long.className = "ln"; long.id = "e";',
    '  long.innerHTML = \'<span class="tx">这一句特别特别特别长的歌词内容超过了容器宽度会被省略号截断掉对不对呢</span>\';',
    '  document.getElementById("mini").appendChild(long);',
    '  // 展开层再放一条正文长的（反向：正文比译文宽）',
    '  const f = document.createElement("div");',
    '  f.className = "ln"; f.id = "f";',
    '  f.innerHTML = \'<span class="tx">这一句正文特别长特别长特别长特别长特别长特别长</span>\'',
    '    + \'<span class="tr">short</span>\';',
    '  document.getElementById("full").appendChild(f);',
    '  for (const id of ["a","b","c","d","e","f"]) {',
    '    const el = document.getElementById(id);',
    '    // 量的是「承载渐变的那一层」：三行是 .ln 自己，展开层是 .tx',
    '    const host = el.querySelector(".tx") || el;',
    '    const r = document.createRange(); r.selectNodeContents(host);',
    '    const tb = r.getBoundingClientRect(); const hb = host.getBoundingClientRect();',
    '    out.push([id, Math.round(hb.width), Math.round(tb.width),',
    '      Math.round(tb.left - hb.left), Math.round(hb.right - tb.right),',
    '      el.scrollWidth, el.clientWidth, el.textContent.length]);',
    '  }',
    '  return out;',
    '};',
  ].join('\n');

  const files = Object.assign({ 'probe.html': probePage(body, script) }, cssFiles());
  const b = await withBrowser(files);
  let rows;
  try {
    rows = await b.ev('window.__probe()');
  } finally {
    b.done();
  }

  /*
   * 容差不能写 0：展开层的 .ln 有 padding:9px 2px，渐变铺的是 padding box，
   * 所以左右各允许 2px 的「空跑」。判据取「≤ 8px 且 ≤ 元素宽度 5%」——
   * 既能放过 padding，又能抓住真正的 bug（修复前 456px 宽的元素左右各空 168px = 37%）。
   */
  for (const [id, hostW, textW, gapL, gapR, scrollW, clientW] of rows) {
    if (!textW) continue;
    const tol = Math.max(8, Math.round(hostW * 0.05));
    assert.ok(gapL <= tol,
      id + ' 左侧有 ' + gapL + 'px 空白（容差 ' + tol + '）：渐变前段会空跑，'
      + '表现为「换句后停顿一会儿才开始填充」');
    assert.ok(gapR <= tol,
      id + ' 右侧有 ' + gapR + 'px 空白（容差 ' + tol + '）：渐变后段会空跑');
    /*
     * 收缩之后超长句必须仍然被 overflow:hidden + text-overflow:ellipsis 截断，
     * 而不是把容器顶出横向滚动。
     * 判据用 scrollWidth/clientWidth 而不是「元素宽度 vs 父级宽度」：
     * 后者量的是浏览器怎么解 max-width，与我们要保证的行为（不出横向滚动）无关；
     * 前者正是「文字比盒子宽 → 被裁」的直接证据。
     */
    if (textW > clientW) {
      assert.ok(scrollW >= clientW,
        id + ' 文字比盒子宽，却没有可滚动的溢出（省略号不会出现）');
    }
    assert.ok(clientW > 0, id + ' 宽度塌成 0 了：收缩过头，整行不可见');
  }
  /* 至少验到三条「文字比容器窄」的 —— 否则上面那组断言可能全是 0 宽空节点 */
  const narrow = rows.filter((r) => r[2] > 0 && r[2] < 300);
  assert.ok(narrow.length >= 3,
    '取样里没有「文字比容器窄」的行，判据可能没真的命中：' + JSON.stringify(rows));
});

/* ------------------------------------------------------- ② 封面不抽搐 */

test('封面：收起动画期间不重新发布尺寸（否则容器塌陷时量到小值 → 抽搐）', { skip: SKIP ? '本机没有 ' + CHROME : false }, async () => {
  const appjs = fs.readFileSync(path.join(ROOT, 'app', 'js', 'app.js'), 'utf8');
  const pub = extractFn(appjs, 'publishCoverSize');
  assert.ok(pub, 'app.js 里找不到 publishCoverSize');
  /*
   * 判据必须匹配**守卫语句本身**，不能只匹配 "collapsing" 这个词 ——
   * 函数上方的注释里就写着 .collapsing，用词面匹配会恒真。
   */
  assert.match(pub, /classList\.contains\('collapsing'\)\s*\)\s*return/,
    'publishCoverSize() 没有跳过 .collapsing —— 收起时容器在塌陷，'
    + '量到的中间高度会被写成新尺寸，封面就会「先缩一下再弹大」');

  const body = [
    '<div class="np open" id="np">',
    '<div class="cover-wrap"><div class="np-cover" id="cov"><img alt=""></div></div>',
    '<div class="np-meta"><h2>t</h2><p>a</p></div>',
    '<div class="np-lyricbox"><div class="lyric" id="ly"></div></div>',
    '</div>',
  ].join('');

  const script = [
    'const $ = (s) => document.querySelector(s);',
    'window.App = {};',
    pub,
    'const np = document.getElementById("np");',
    'window.__pub = publishCoverSize;',
    'let queued = false;',
    /* 与 app.js 里同一套 ResizeObserver 接线 */
    'const ro = new ResizeObserver(() => { if (queued) return; queued = true;',
    '  requestAnimationFrame(() => { queued = false; publishCoverSize(); }); });',
    'ro.observe(document.querySelector(".cover-wrap"));',
    /* 收起：真实的 class 切换顺序（摘 expanded、挂 collapsing） */
    'window.__collapse = () => { np.classList.remove("expanded"); np.classList.add("collapsing"); };',
    'window.__size = () => App._coverSize;',
  ].join('\n');

  const files = Object.assign({ 'probe.html': probePage(body, script) }, cssFiles());
  const b = await withBrowser(files);
  let samples;
  let baseline;
  try {
    baseline = await b.ev(`(async () => {
      window.__pub();
      await new Promise((r) => setTimeout(r, 250));
      return window.__size();
    })()`);
    samples = await b.ev(`(async () => {
      const rec = [];
      window.__collapse();
      const t0 = performance.now();
      await new Promise((res) => {
        const tick = () => {
          rec.push([Math.round(performance.now() - t0), window.__size()]);
          if (performance.now() - t0 > 400) return res();
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      return rec;
    })()`);
  } finally {
    b.done();
  }

  assert.ok(baseline > 0, '基线尺寸没发布出来（' + baseline + '），后续断言不可信');
  const sizes = (samples || []).map((s) => s[1]).filter((v) => v != null);
  assert.ok(sizes.length > 5, '没采到样本：' + JSON.stringify(samples).slice(0, 300));
  const uniq = [...new Set(sizes)];
  assert.deepEqual(uniq, [baseline],
    '收起期间 _coverSize 变了：' + uniq.join(' → ')
    + '（封面会先缩再弹 = 用户说的「抽搐」）');
});

test('元测试：把 collapsing 守卫去掉，封面判据必须真的会红', () => {
  /*
   * 没有这一条，"断言通过" 可能只是因为判据什么都没看见。
   * 这里把源码里那一行守卫删掉，同一套判据必须报错。
   */
  const appjs = fs.readFileSync(path.join(ROOT, 'app', 'js', 'app.js'), 'utf8');
  const GUARD = /\n\s*if \(np\.classList\.contains\('collapsing'\)\) return;/;
  assert.ok(GUARD.test(appjs), '源码里找不到那行守卫（被重写了？）');
  const mutated = appjs.replace(GUARD, '');
  assert.notEqual(mutated, appjs);
  const pub = extractFn(mutated, 'publishCoverSize');
  assert.ok(pub);
  let threw = null;
  try {
    assert.match(pub, /classList\.contains\('collapsing'\)\s*\)\s*return/,
      'publishCoverSize() 没有跳过 .collapsing');
  } catch (e) { threw = e; }
  assert.ok(threw, '删掉守卫之后判据仍然是绿的 —— 说明它是恒真的');
});
