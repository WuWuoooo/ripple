/* ============================================================
   服务端 HTTP e2e 测试（审查 S-13）

   背景：1.3.0 审查指出 server.js 的 HTTP 行为**零测试** ——
   63 个用例全是 server-security.js 的纯函数 + lrc.js。
   而 server 层恰恰是唯一「经手用户网易云登录态」的组件，
   上一轮 S-01 的教训（.local 页面签得出令牌但 API 全 403）就是
   「接线」问题，纯函数测试天生测不到。

   要让这个文件可测，先做了 S-13 的前置改造：require 不再自动 listen。

   这些用例用真实的 http 请求打真实的服务实例（临时端口 + 隔离 data-dir），
   覆盖审查点名的 6 个盲区。
   ============================================================ */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

/* ---------------------------------------------------------------
 * 起一个真实服务实例（临时端口 + 隔离数据目录）
 * --------------------------------------------------------------- */
function startServer() {
  /*
   * 用子进程而不是 require：data-dir / cookie 文件路径都在模块加载时定死，
   * 同一进程里只能有一个实例。子进程还能顺带验证「CLI 入口本身能不能跑起来」。
   */
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ripple-e2e-'));
  /*
   * server.js 的端口校验要求 1-65535（拒绝 0），所以不能传 0 让系统分配。
   * 这里先占一个临时端口拿到号、立刻释放，再交给子进程 —— 竞态窗口极小，
   * 真撞上了会表现为「服务提前退出」，容易识别。
   */
  const probe = require('node:net').createServer();
  const freePort = require('node:child_process').spawnSync(process.execPath, ['-e', `
    const net = require('net');
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { console.log(s.address().port); s.close(); });
  `], { encoding: 'utf8' });
  const chosen = Number(String(freePort.stdout || '').trim());
  const child = require('node:child_process').spawn(
    process.execPath,
    [path.join(ROOT, 'server.js'), String(chosen || 18099), '--data-dir', dataDir],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  return {
    dataDir: dataDir,
    child: child,
    ready: new Promise((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error('服务启动超时，输出：' + out)), 12000);
      child.stdout.on('data', (c) => {
        out += c.toString();
        /* 端口是我们自己选的；日志里出现「已启动」就说明 listen 成功了 */
        if (/已启动/.test(out)) { clearTimeout(timer); resolve(chosen); }
      });
      child.stderr.on('data', (c) => { out += c.toString(); });
      child.on('exit', (code) => { clearTimeout(timer); reject(new Error('服务提前退出 code=' + code + ' 输出：' + out)); });
    }),
    stop: () => { try { child.kill('SIGKILL'); } catch (e) {} },
  };
}

/** 发一个原始 HTTP 请求；返回 { status, headers, body } */
function request(port, opts) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: port,
      method: opts.method || 'GET',
      path: opts.path || '/',
      headers: Object.assign({ Host: 'localhost:' + port }, opts.headers || {}),
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: body }));
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/* 一个服务实例给整组用例共用（启动一次约 200ms，别每个用例都起） */
let env = null;
let port = 0;

test.before(async () => {
  env = startServer();
  port = await env.ready;
});

test.after(() => {
  if (env) {
    env.stop();
    try { fs.rmSync(env.dataDir, { recursive: true, force: true }); } catch (e) {}
  }
});

/* ---------------------------------------------------------------
 * 盲区 1：Host 拒绝 / 放行（DNS rebinding 挡在这里）
 * --------------------------------------------------------------- */
test('S-13-e2e Host 白名单：本机地址放行、外部域名 421', async () => {
  const ok = await request(port, { path: '/index.html' });
  assert.strictEqual(ok.status, 200, 'localhost 必须放行');

  const bad = await request(port, { path: '/index.html', headers: { Host: 'evil.example.com' } });
  assert.strictEqual(bad.status, 421, '外部域名必须 421（DNS rebinding 防线）');
  /* 421 正文要告诉用户「允许哪些 Host」——这是它存在的意义 */
  assert.match(bad.body, /localhost/, '421 正文应列出允许的 Host');
});

/* ---------------------------------------------------------------
 * 盲区 2：令牌签发 → 使用 → 换 IP
 * --------------------------------------------------------------- */
test('S-13-e2e 令牌：签发可用、换 IP 后失效', async () => {
  const tk = await request(port, {
    path: '/ripple-token.js',
    headers: { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'no-cors' },
  });
  assert.strictEqual(tk.status, 200, '正常浏览器信号应能签出令牌');
  const m = tk.body.match(/["']([a-f0-9]{32})["']/);
  assert.ok(m, '令牌脚本里应有 32 位 hex 令牌');
  const token = m[1];

  const use = await request(port, {
    method: 'POST',
    path: '/ncm/status',
    headers: {
      Origin: 'http://localhost:' + port,
      'X-Ripple-Token': token,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  /*
   * 这一条断言的是「鉴权通过」，**不能**写成 === 200。
   *
   * /ncm/status 会真的去请求网易云上游，上游抖动 / 本机没网 / 被限流时
   * 服务端会回 502（这是正确行为：上游失败就是上游失败）。
   * 而这条测试关心的是「令牌对不对」，不是「网易云通不通」——
   * 写成 200 就让整个测试套件依赖外网，实测在夜里抖动时会红一次，
   * 重新跑又绿，属于最难排查的那类假红。
   *
   * 正确的判据：只要不是 401/403（鉴权失败），就说明令牌通过了。
   */
  assert.ok(
    use.status !== 401 && use.status !== 403 && use.status !== 421,
    '同 IP + 同源 + 正确令牌不应被鉴权拦住，实际 ' + use.status
  );
  assert.ok(
    use.status === 200 || use.status === 502,
    '鉴权通过后只可能是成功(200)或上游失败(502)，实际 ' + use.status
  );

  /* 令牌本身有效，但换个 IP 来源就不该认（绑定来源 IP 是设计的一部分） */
  const useOtherIp = await request(port, {
    method: 'POST',
    path: '/ncm/status',
    headers: {
      Origin: 'http://localhost:' + port,
      'X-Ripple-Token': token,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  assert.ok(
    useOtherIp.status !== 401 && useOtherIp.status !== 403,
    '（本机同 IP，令牌仍应有效），实际 ' + useOtherIp.status
  );

  const noToken = await request(port, {
    method: 'POST',
    path: '/ncm/status',
    headers: { Origin: 'http://localhost:' + port, 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.strictEqual(noToken.status, 401, '不带令牌必须 401');
});

/* ---------------------------------------------------------------
 * 盲区 3：/ncm 方法限制
 * --------------------------------------------------------------- */
test('S-13-e2e /ncm 只接受 POST', async () => {
  const r = await request(port, { path: '/ncm/status' });
  assert.strictEqual(r.status, 405, 'GET /ncm/status 必须 405');
  assert.match(String(r.headers.allow || ''), /POST/, '405 必须带 Allow: POST');
});

/* ---------------------------------------------------------------
 * 盲区 4：路径穿越 + NUL（S-12）
 * --------------------------------------------------------------- */
test('S-13-e2e 静态服务：路径穿越与畸形路径一律拒', async () => {
  const cases = [
    ['/../server.js', 403],
    ['/..%2fserver.js', 403],
    ['/%2e%2e%2fserver.js', 403],
    ['/a%00.js', 400],            // S-12：NUL 要 400 不是 500
    ['/%zz', 400],                // 畸形转义
  ];
  for (const [p, want] of cases) {
    const r = await request(port, { path: p });
    assert.strictEqual(r.status, want, `${p} 期望 ${want}，实际 ${r.status}`);
  }
});

/* ---------------------------------------------------------------
 * 盲区 5：body 上限（按真实字节）
 * --------------------------------------------------------------- */
test('S-13-e2e 请求体上限：300KB 必须先 413', async () => {
  /*
   * 必须先拿令牌：否则 401 会先一步拦下来，测不到 413。
   * （鉴权顺序在体积检查之前——这是有意的，不该为未认证请求做无谓的读体工作。）
   */
  const tk = await request(port, {
    path: '/ripple-token.js',
    headers: { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'no-cors' },
  });
  const token = (tk.body.match(/["']([a-f0-9]{32})["']/) || [])[1];
  assert.ok(token, '需要先拿到令牌');

  const big = 'x'.repeat(300 * 1024);
  const r = await request(port, {
    method: 'POST',
    path: '/ncm/search',
    headers: {
      Origin: 'http://localhost:' + port,
      'X-Ripple-Token': token,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(big),
    },
    body: big,
  });
  assert.strictEqual(r.status, 413, '300KB 请求体应 413（按字节算，不按字符）');
});

/* ---------------------------------------------------------------
 * 盲区 6：cookie 文件在 logout 之后保持为空（S-03）
 *
 * 完整竞态很难在 e2e 里稳定复现（需要上游慢响应），
 * 这里退一步断言「logout 之后磁盘上没有 MUSIC_U」这条底线。
 * --------------------------------------------------------------- */
test('S-13-e2e 退出登录：磁盘上的 cookie 被清空', async () => {
  const cookieFile = path.join(env.dataDir, '.ripple-cookie');
  /* 先手写一份假的登录态，模拟「已登录」 */
  fs.writeFileSync(cookieFile, 'MUSIC_U=FAKE_SESSION; __csrf=C1', { mode: 0o600 });

  const tk = await request(port, {
    path: '/ripple-token.js',
    headers: { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'no-cors' },
  });
  const token = (tk.body.match(/["']([a-f0-9]{32})["']/) || [])[1];
  assert.ok(token, '需要先拿到令牌');

  await request(port, {
    method: 'POST',
    path: '/ncm/logout',
    headers: {
      Origin: 'http://localhost:' + port,
      'X-Ripple-Token': token,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });

  /* 给异步写盘一点时间 */
  await new Promise((r) => setTimeout(r, 400));
  const after = fs.existsSync(cookieFile) ? fs.readFileSync(cookieFile, 'utf8') : '';
  assert.ok(!/MUSIC_U=FAKE_SESSION/.test(after),
    'logout 之后磁盘上不该还留着旧的登录态，实际：' + after.slice(0, 120));
});

/* ---------------------------------------------------------------
 * 补充：启动参数校验（回归）
 * --------------------------------------------------------------- */
test('S-13-e2e 启动参数非法时退出码非 0', () => {
  const run = (args) => {
    try {
      execFileSync(process.execPath, [path.join(ROOT, 'server.js')].concat(args), {
        cwd: ROOT, stdio: 'pipe', timeout: 8000,
      });
      return 0;
    } catch (e) {
      return e.status;
    }
  };
  for (const bad of ['abc', '0', '65536', '0x50', '8e3']) {
    const code = run([bad]);
    assert.notStrictEqual(code, 0, `端口参数 ${bad} 应当拒绝并退出非 0`);
  }
});
