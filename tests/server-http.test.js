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
    const o = {
      host: '127.0.0.1',
      port: port,
      method: opts.method || 'GET',
      path: opts.path || '/',
      headers: Object.assign({ Host: 'localhost:' + port }, opts.headers || {}),
    };
    /*
     * 审查 S-02（1.3.4）：支持指定**源地址**，才能真正测「换 IP 后失效」。
     *
     * 以前 helper 把 host 写死 127.0.0.1，而所谓「换 IP」其实还是同一个 IP ——
     * 那个 e2e 用例标题宣称的东西从来没有被测到，真正的 IP 绑定
     * （server.js 的 tokenValid）在 e2e 层零覆盖。
     *
     * 现在可以用 localAddress: '127.0.0.2' 从另一个回环地址发请求，
     * 服务端看到的 remoteAddress 就是 127.0.0.2，才构成真实的换 IP。
     */
    if (opts.localAddress) o.localAddress = opts.localAddress;
    const req = http.request(o, (res) => {
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
test('S-13-e2e 令牌：签发可用、同 IP 有效、换 IP 401、无令牌 401', async () => {
  /*
   * H-9：签发端现在要求真实 Origin/Referer（可伪造的 Sec-Fetch-* 不再够）。
   * 这里模拟真浏览器的子资源加载：同源页面带 Referer。
   */
  const tk = await request(port, {
    path: '/ripple-token.js',
    headers: {
      Referer: 'http://localhost:' + port + '/',
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'no-cors',
    },
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

  /*
   * 令牌本身有效，但换个 IP 来源就不该认（绑定来源 IP 是设计的一部分）。
   *
   * 审查 S-02（1.3.4）：以前这里没给 localAddress，所谓「换 IP」
   * 实际上还是 127.0.0.1 —— 断言也只能写成「本机同 IP 仍有效」，
   * 与用例标题宣称的「换 IP 后失效」完全相反，真正的 IP 绑定零覆盖。
   * 现在从 127.0.0.2 发请求，服务端看到的 remoteAddress 真的变了。
   */
  const useOtherIp = await request(port, {
    method: 'POST',
    path: '/ncm/status',
    localAddress: '127.0.0.2',
    headers: {
      Origin: 'http://localhost:' + port,
      'X-Ripple-Token': token,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  assert.strictEqual(useOtherIp.status, 401,
    '令牌绑定来源 IP，从另一个 IP 使用必须 401（实际 ' + useOtherIp.status + '）');

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
    headers: {
      Referer: 'http://localhost:' + port + '/',
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'no-cors',
    },
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
    headers: {
      Referer: 'http://localhost:' + port + '/',
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'no-cors',
    },
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

/* ---------------------------------------------------------------
 * H-7 [high]：413 之后的下一个请求不能被 keep-alive 池毒化（ECONNRESET）
 *
 * 修前：413 响应没有 Connection: close，随后 req.destroy() 硬断 socket；
 * 客户端仍以为这条连接可复用，把它放回空闲池 → 下一个请求复用它就 ECONNRESET。
 * 报告实测 30 次失败 4 次，本机实测修前 30 次失败 13 次。
 *
 * 这条用例用**单连接池化 agent**（maxSockets=1）放大问题：如果 413 不声明
 * close，下一个请求必然尝试复用那条已死的 socket。
 * --------------------------------------------------------------- */
test('H-7 413 必须声明 Connection: close，且不毒化下一个请求', async () => {
  const keepAliveAgent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const viaAgent = (opts) => new Promise((resolve, reject) => {
    const o = {
      host: '127.0.0.1',
      port: port,
      method: opts.method || 'GET',
      path: opts.path || '/',
      agent: keepAliveAgent,
      headers: Object.assign({ Host: 'localhost:' + port }, opts.headers || {}),
    };
    const req = http.request(o, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: body }));
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });

  try {
    const tk = await viaAgent({
      path: '/ripple-token.js',
      headers: {
        Referer: 'http://localhost:' + port + '/',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-Mode': 'no-cors',
      },
    });
    const token = (tk.body.match(/["']([a-f0-9]{32})["']/) || [])[1];
    assert.ok(token, '需要先拿到令牌');
    const authHeaders = {
      Origin: 'http://localhost:' + port,
      Referer: 'http://localhost:' + port + '/',
      'X-Ripple-Token': token,
      'Content-Type': 'application/json',
    };

    const big = 'x'.repeat(300 * 1024);
    const r413 = await viaAgent({
      method: 'POST',
      path: '/ncm/search',
      headers: Object.assign({ 'Content-Length': Buffer.byteLength(big) }, authHeaders),
      body: big,
    });
    assert.strictEqual(r413.status, 413, '300KB 请求体应 413');
    /* 关键断言：必须让客户端知道这条连接不可复用 */
    assert.strictEqual(String(r413.headers.connection || '').toLowerCase(), 'close',
      '413 响应必须带 Connection: close —— 否则客户端会把即将销毁的 socket 放回池子');

    /*
     * 紧接着在同一池化 agent 上发下一个请求。修前这里会随机 ECONNRESET（不是 4xx/5xx，
     * 而是连接层错误），所以这里断言「必须拿到一个 HTTP 响应」。
     */
    const next = await viaAgent({
      method: 'POST',
      path: '/ncm/song_detail',
      headers: authHeaders,
      body: '{"ids":"abc"}',   // 参数非法 → 400，不依赖外网
    });
    assert.strictEqual(next.status, 400,
      '413 之后的下一个请求必须正常拿到 HTTP 响应（400），实际 ' + next.status);
  } finally {
    keepAliveAgent.destroy();
  }
});

/* ---------------------------------------------------------------
 * H-9 [high]：默认必须只监听回环，并拒绝靠伪造 Sec-Fetch 头签发令牌
 *
 * 这条防的是「同一局域网内任何设备无需凭据就能操作用户网易云账号」：
 *   0.0.0.0 监听 → Host 白名单含网卡 IP → 伪造 Sec-Fetch 头签令牌
 *   → 令牌绑定攻击者自己的 IP 恰好可用 → 带用户的 MUSIC_U 打 /ncm/*。
 * --------------------------------------------------------------- */
test('H-9 默认只监听 127.0.0.1，局域网访问需显式 --lan', () => {
  /* 默认（不带 --lan）：监听地址必须是回环，而不是 0.0.0.0 */
  const out = execFileSync(process.execPath, ['-e', `
    const s = require(${JSON.stringify(path.join(ROOT, 'server.js'))});
    console.log('LISTEN_HOST=' + s.LISTEN_HOST);
    console.log('LAN_ENABLED=' + s.LAN_ENABLED);
  `], { cwd: ROOT, encoding: 'utf8', timeout: 15000 });
  assert.match(out, /LISTEN_HOST=127\.0\.0\.1/,
    '默认必须只监听 127.0.0.1（H-9：局域网访问要用户显式开启）。实际输出：' + out);
  assert.match(out, /LAN_ENABLED=false/, '默认不该开启局域网模式。实际输出：' + out);

  /* 带 --lan：才允许对外监听 */
  const outLan = execFileSync(process.execPath, ['-e', `
    process.argv = [process.argv[0], 'x', '--lan'];
    const s = require(${JSON.stringify(path.join(ROOT, 'server.js'))});
    console.log('LISTEN_HOST=' + s.LISTEN_HOST);
    console.log('LAN_ENABLED=' + s.LAN_ENABLED);
  `], { cwd: ROOT, encoding: 'utf8', timeout: 15000 });
  assert.match(outLan, /LISTEN_HOST=0\.0\.0\.0/, '--lan 时必须对外监听。实际输出：' + outLan);
  assert.match(outLan, /LAN_ENABLED=true/, '--lan 必须开启局域网模式。实际输出：' + outLan);
});

test('H-9 令牌签发：伪造 Sec-Fetch 头不再能拿令牌（必须有真实来源）', async () => {
  /* 报告里的越权链第 2 步：只有 Sec-Fetch-Site + Sec-Fetch-Mode，没有 Origin/Referer */
  const forged = await request(port, {
    path: '/ripple-token.js',
    headers: { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'no-cors' },
  });
  assert.strictEqual(forged.status, 403,
    '只有可伪造的 Sec-Fetch 头时必须 403（H-9 修前这里是 200，等于局域网设备可签令牌）');
  assert.ok(!/[a-f0-9]{32}/.test(forged.body), '403 响应里不该漏出令牌');

  /* 正常浏览器（同源页面 <script src> 带 Referer）仍然能签 —— 这条必须保持 200 */
  const browser = await request(port, {
    path: '/ripple-token.js',
    headers: {
      Referer: 'http://localhost:' + port + '/',
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'no-cors',
    },
  });
  assert.strictEqual(browser.status, 200, '正常浏览器页面加载必须仍能拿到令牌');
  assert.ok(/[a-f0-9]{32}/.test(browser.body), '正常浏览器应拿到令牌');

  /* 只带 Origin（没有 Sec-Fetch-*，某些浏览器/SW 场景）也要能签 */
  const viaOrigin = await request(port, {
    path: '/ripple-token.js',
    headers: { Origin: 'http://localhost:' + port },
  });
  assert.strictEqual(viaOrigin.status, 200, '只带同源 Origin 时也必须能签令牌');
});

/* ===============================================================
 * 1.3.8 服务端条目：H-10 / H-11 / L-8 / L-9
 *
 * 这一组用例的判据全部来自「真实 HTTP 响应」，不是读源码里的字符串 ——
 * H-10 的病根恰恰是「两套 CORS 口径」，只 grep 源码会发现两边都写了
 * Access-Control-Allow-Origin，看起来「都设了」，实际上一个是 * 一个是回显。
 * =============================================================== */

/** 取一份可用令牌（同源 Referer + 浏览器信号） */
async function grabToken(p) {
  const tk = await request(p, {
    path: '/ripple-token.js',
    headers: {
      Referer: 'http://localhost:' + p + '/',
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'no-cors',
    },
  });
  const t = (tk.body.match(/["']([a-f0-9]{32})["']/) || [])[1];
  assert.ok(t, '需要先拿到令牌');
  return t;
}

/* ---------------------------------------------------------------
 * H-11 [high]：静态资源必须带 nosniff / Referrer-Policy / X-Frame-Options
 * --------------------------------------------------------------- */
test('H-11 静态资源带 nosniff / Referrer-Policy / X-Frame-Options', async () => {
  /*
   * 挑三种扩展名分别验：HTML（页面本体）、JS（最容易被「猜成 HTML」的类型）、
   * 以及一个 .css（样式）。以前这三种一个安全头都没有。
   */
  for (const p of ['/index.html', '/js/app.js', '/css/base.css']) {
    const r = await request(port, { path: p });
    assert.strictEqual(r.status, 200, p + ' 应可正常服务，实际 ' + r.status);
    assert.strictEqual(r.headers['x-content-type-options'], 'nosniff',
      p + ' 必须带 X-Content-Type-Options: nosniff');
    assert.strictEqual(r.headers['referrer-policy'], 'no-referrer',
      p + ' 必须带 Referrer-Policy: no-referrer');
    assert.strictEqual(r.headers['x-frame-options'], 'SAMEORIGIN',
      p + ' 必须带 X-Frame-Options: SAMEORIGIN');
  }
});

test('H-11 304 命中时安全头也必须在（否则条件请求会「洗掉」防线）', async () => {
  const first = await request(port, { path: '/index.html' });
  const etag = first.headers.etag;
  assert.ok(etag, '静态响应应带 ETag');

  const second = await request(port, { path: '/index.html', headers: { 'If-None-Match': etag } });
  assert.strictEqual(second.status, 304, '条件请求应命中 304');
  /*
   * 304 走的是同一份 headers 对象，理应一并带上。这条断言守的是「将来有人
   * 给 304 单独写一套头」的回归 —— 那种改动会静默地让缓存命中的页面失去防线。
   */
  assert.strictEqual(second.headers['x-content-type-options'], 'nosniff', '304 也必须带 nosniff');
  assert.strictEqual(second.headers['x-frame-options'], 'SAMEORIGIN', '304 也必须带 X-Frame-Options');
});

test('H-11 明确不加 CSP（1.3.5 的权衡结论，本轮不推翻）', async () => {
  const r = await request(port, { path: '/index.html' });
  assert.strictEqual(r.headers['content-security-policy'], undefined,
    '本轮不动 CSP：加了会砸掉「检查更新跨域 fetch GitHub API」，必须单独评估');
});
/* ---------------------------------------------------------------
 * H-10 [high]：错误路径的 CORS 不再通配，与 200 路径同口径
 * --------------------------------------------------------------- */
test('H-10 错误路径（413/400）不再回 ACAO:*，而是回显本次 Origin', async () => {
  const token = await grabToken(port);
  const origin = 'http://localhost:' + port;

  /* 413：体积超限 */
  const big = 'x'.repeat(300 * 1024);
  const r413 = await request(port, {
    method: 'POST',
    path: '/ncm/search',
    headers: {
      Origin: origin,
      'X-Ripple-Token': token,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(big),
    },
    body: big,
  });
  assert.strictEqual(r413.status, 413, '300KB 请求体应 413');
  assert.strictEqual(r413.headers['access-control-allow-origin'], origin,
    '413 必须回显本次请求的 Origin（以前是硬编码 *）');
  assert.notStrictEqual(r413.headers['access-control-allow-origin'], '*',
    '413 不得再出现 Access-Control-Allow-Origin: *');
  assert.match(String(r413.headers.vary || ''), /Origin/i,
    '413 必须带 Vary: Origin —— 否则中间层会把回显了某 origin 的响应复用给别人');

  /* 400：未知命令（L-9 把它从 200 改成了 400） */
  const r400bad = await request(port, {
    method: 'POST',
    path: '/ncm/definitely_not_a_command',
    headers: { Origin: origin, 'X-Ripple-Token': token, 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.strictEqual(r400bad.status, 400, '未知命令应 400');
  assert.strictEqual(r400bad.headers['access-control-allow-origin'], origin,
    '400 必须回显本次请求的 Origin');
  assert.notStrictEqual(r400bad.headers['access-control-allow-origin'], '*',
    '400 不得再出现通配符');
  assert.match(String(r400bad.headers.vary || ''), /Origin/i, '400 必须带 Vary: Origin');
});

test('H-10 不带 Origin 的请求：错误响应不该凭空造出 ACAO 头', async () => {
  const token = await grabToken(port);
  /*
   * 与 200 路径完全同口径：`if (req.headers.origin) ...`。
   * 以前 json() 无条件写 '*'，于是连「同源 CLI 请求」的响应都宣称可跨域读。
   */
  const big = 'x'.repeat(300 * 1024);
  const r = await request(port, {
    method: 'POST',
    path: '/ncm/search',
    headers: {
      /*
       * 故意**不带 Origin**，只带同源信号：这是「同源页面之外、但仍是本机
       * 请求」的形状（例如 Service Worker / 无 Origin 的同源导航 fetch）。
       * 注意不能什么信号都不给 —— 那样会在 originAllowed() 就被 403 拦下，
       * 走不到 413 那条路径，也就测不到 json() 的 CORS 头。
       */
      'Sec-Fetch-Site': 'same-origin',
      'X-Ripple-Token': token,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(big),
    },
    body: big,
  });
  assert.strictEqual(r.status, 413, '300KB 请求体应 413');
  assert.strictEqual(r.headers['access-control-allow-origin'], undefined,
    '没有 Origin 就不该发 Access-Control-Allow-Origin（以前这里会冒出 *）');
});
/* ---------------------------------------------------------------
 * L-9 [low]：未知命令必须是 400，不是 200
 * --------------------------------------------------------------- */
test('L-9 未知命令返回 400 且 body 指明命令名', async () => {
  const token = await grabToken(port);
  const r = await request(port, {
    method: 'POST',
    path: '/ncm/totally_unknown_cmd',
    headers: {
      Origin: 'http://localhost:' + port,
      'X-Ripple-Token': token,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  /*
   * 修前这里是 200 + {"code":-2,...} —— 打错命令名在 HTTP 层完全看不出来，
   * 排查时表现为「接口 200 但页面什么都不显示」。
   */
  assert.strictEqual(r.status, 400, '未知命令是客户端错误，必须 400（修前是 200）');
  const j = JSON.parse(r.body);
  assert.strictEqual(j.code, 400, 'body 的 code 应为 400，实际 ' + j.code);
  assert.match(String(j.msg), /totally_unknown_cmd/,
    'body 应指明是哪个命令不认识（排查唯一线索）');
});

/* ---------------------------------------------------------------
 * L-8 [low]：上游响应体上限按真实字节，不按 UTF-16 码元
 * --------------------------------------------------------------- */
test('L-8 响应体计数器按 UTF-8 字节累计，与 data.length 判据分道扬镳', () => {
  /*
   * 这条是单元级对抗：这条判据没法用 e2e 测（要真让网易云吐出 16MB 中文），
   * 所以直接拿被测的计数器与「朴素的 data.length 计数」跑同一批 chunk，
   * 要求两者在中文/emoji 输入下给出**不同**结论 —— 如果相同，
   * 说明有人把它改回了按码元计数，这时本用例立刻红。
   */
  const srv = require(path.join(ROOT, 'server.js'));
  const LIMIT = 48;                       // 48 字节，方便构造边界
  const chunks = ['中文', '中文', '中文'];   // 每个 6 字节 = 2 码元

  /* 真实现：按字节 */
  const counted = srv.makeByteCounter(LIMIT);
  let naiveLength = 0;
  for (const c of chunks) {
    naiveLength += c.length;
    counted.add(c);
  }
  assert.strictEqual(counted.bytes, 18, '6 字节 × 3 块 = 18 字节，实际 ' + counted.bytes);
  assert.strictEqual(naiveLength, 6, '（对照）按码元只数到 6，这是修前的错误判据');

  /* 边界：刚好等于上限不算超限 */
  const at = srv.makeByteCounter(LIMIT);
  assert.strictEqual(at.add('x'.repeat(LIMIT)), false, '恰好等于上限时不该判定超限');
  /* 多一个字节就算超限 */
  const over = srv.makeByteCounter(LIMIT);
  assert.strictEqual(over.add('x'.repeat(LIMIT + 1)), true, '超出一个字节必须判超限');

  /*
   * 关键分歧演示：用 16MB 真实上限，喂「全中文」的等价负载。
   * 按字节 3n > 16MB 时触发；按码元要等到 n > 16MB 才触发 —— 相差约 3 倍。
   * 这里用小一点的等价比例做演示，避免真的分配 48MB 字符串。
   */
  const MB = 1024 * 1024;
  const piece = '中'.repeat(1024);         // 1024 个中文字 = 3072 字节 = 1024 码元
  const real = srv.makeByteCounter(16 * MB);
  let realTripped = 0;
  let realBytes = 0;
  let codeUnits = 0;
  while (realTripped === 0 && codeUnits < 20 * MB) {
    realTripped = real.add(piece) ? 1 : 0;
    realBytes += Buffer.byteLength(piece, 'utf8');
    codeUnits += piece.length;
  }
  assert.strictEqual(realTripped, 1, '全中文负载超过 16MB 后必须触发');
  assert.ok(realBytes > 16 * MB, '（前提）触发时真实字节确实已超 16MB');
  assert.ok(codeUnits < 16 * MB,
    '（关键）触发时 UTF-16 码元数 ' + codeUnits + ' 仍小于 16MB —— '
    + '修前按 data.length 判就永远等不到这一下，上限实际放宽到 ~48MB');
});
/* ---------------------------------------------------------------
 * 元测试：证明上面这组断言真的会红
 *
 * 判据来自真实 HTTP 响应，所以「把修复改坏」不能靠 monkey-patch 进程内的
 * 变量 —— 必须真的起一个「旧实现」的服务实例。这里直接用 git HEAD 版本的
 * server.js 起子进程，跑同一批关键字判据，要求它们呈现修复前的样子。
 * --------------------------------------------------------------- */

/** 在指定的代码根目录起一个服务实例（元测试要用「修复前」的 server.js） */
function startServerIn(rootDir) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ripple-e2e-'));
  const pick = require('node:child_process').spawnSync(process.execPath, ['-e',
    'const net = require("net"); const s = net.createServer();'
    + ' s.listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close(); });'],
    { encoding: 'utf8' });
  const chosen = Number(String(pick.stdout || '').trim()) || 18311;
  const child = require('node:child_process').spawn(
    process.execPath,
    [path.join(rootDir, 'server.js'), String(chosen), '--data-dir', dataDir],
    { cwd: rootDir, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  return {
    dataDir: dataDir,
    child: child,
    ready: new Promise((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error('旧实例启动超时，输出：' + out)), 12000);
      child.stdout.on('data', (c) => {
        out += c.toString();
        if (/已启动/.test(out)) { clearTimeout(timer); resolve(chosen); }
      });
      child.stderr.on('data', (c) => { out += c.toString(); });
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error('旧实例提前退出 code=' + code + ' 输出：' + out));
      });
    }),
    stop: () => { try { child.kill('SIGKILL'); } catch (e) {} },
  };
}

test('元测试：把三处修复逐个改回旧写法，上面的判据必须真的红', async () => {
  /*
   * 为什么不用 git HEAD 当基准：修复一旦提交，HEAD 就自带修复，
   * 这条元测试会静默失去意义（或者更糟：永久变红）。所以基准必须是
   * 「当前源码」——在临时目录里把修复**逐处改回旧写法**，再起同一个服务。
   *
   * 三处变异（与报告里的三条一一对应）：
   *   ① H-11：把三条静态安全头删掉；
   *   ② H-10：把 ACAO 通配符塞回 json()；
   *   ③ L-9：未知命令改回 return 200。
   * 每处变异都必须真的改动源码（否则元测试自己是假的）。
   */
  const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ripple-old-'));
  let oldEnv = null;
  try {
    const good = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

    /* ① H-11 → 删掉三条安全头 */
    const noSecHeaders = good.replace(
      /\n      'X-Content-Type-Options': 'nosniff',\n      'Referrer-Policy': 'no-referrer',\n      'X-Frame-Options': 'SAMEORIGIN',\n/,
      '\n'
    );
    assert.notEqual(noSecHeaders, good, '变异 ① 必须真的删掉安全头（否则元测试自欺）');

    /*
     * ② H-10 → 回显 origin 那行改回通配符。
     * 注意必须改**这一行**而不是往 headers 字面量里塞：json() 里
     * \`if (org) headers['...'] = org\` 在字面量之后执行，会把塞进去的 '*'
     * 覆盖掉 —— 那种「变异」根本改不了行为，元测试就变成自欺了。
     */
    const wildcard = noSecHeaders.replace(
      "  if (org) headers['Access-Control-Allow-Origin'] = org;",
      "  headers['Access-Control-Allow-Origin'] = '*';  // 变异：回到修复前"
    );
    assert.notEqual(wildcard, noSecHeaders, '变异 ② 必须真的改回 ACAO 通配符');

    /* ③ L-9 → 未知命令改回 return 200 */
    const unknown200 = wildcard.replace(
      "      throw badRequest('未知命令 ' + cmd);",
      "      return JSON.stringify({ code: -2, msg: '未知命令 ' + cmd });"
    );
    assert.notEqual(unknown200, wildcard, '变异 ③ 必须真的把未知命令改回 200');

    fs.writeFileSync(path.join(oldDir, 'server.js'), unknown200);
    fs.copyFileSync(path.join(ROOT, 'server-security.js'), path.join(oldDir, 'server-security.js'));
    fs.symlinkSync(path.join(ROOT, 'app'), path.join(oldDir, 'app'), 'dir');

    oldEnv = startServerIn(oldDir);
    const oldPort = await oldEnv.ready;

    /* ① H-11：旧实现没有安全头 */
    const stat = await request(oldPort, { path: '/index.html' });
    assert.strictEqual(stat.status, 200, '（元测试）旧实现也应能正常服务静态文件');
    assert.notStrictEqual(stat.headers['x-content-type-options'], 'nosniff',
      '（元测试）旧实现的静态响应不该已经带 nosniff，否则上面 H-11 的断言测不出东西');
    assert.strictEqual(stat.headers['x-frame-options'], undefined,
      '（元测试）旧实现没有 X-Frame-Options');

    /* ② H-10：旧实现的 413 是通配符 */
    const tk = await grabToken(oldPort);
    const big = 'x'.repeat(300 * 1024);
    const r413 = await request(oldPort, {
      method: 'POST',
      path: '/ncm/search',
      headers: {
        Origin: 'http://localhost:' + oldPort,
        'X-Ripple-Token': tk,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(big),
      },
      body: big,
    });
    assert.strictEqual(r413.status, 413, '（元测试）旧实现也应先到 413');
    assert.strictEqual(r413.headers['access-control-allow-origin'], '*',
      '（元测试）旧实现的 413 必须是 ACAO:* —— 这正是 H-10 要修的');

    /* ③ L-9：旧实现的未知命令是 200 */
    const rUnknown = await request(oldPort, {
      method: 'POST',
      path: '/ncm/totally_unknown_cmd',
      headers: {
        Origin: 'http://localhost:' + oldPort,
        'X-Ripple-Token': tk,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    assert.strictEqual(rUnknown.status, 200,
      '（元测试）旧实现的未知命令必须是 200 —— 这正是 L-9 要修的');
  } finally {
    if (oldEnv) {
      oldEnv.stop();
      try { fs.rmSync(oldEnv.dataDir, { recursive: true, force: true }); } catch (e) {}
    }
    try { fs.rmSync(oldDir, { recursive: true, force: true }); } catch (e) {}
  }
});

/* ---------------------------------------------------------------
 * L-8 的**接线**用例：不止计数器本身对，服务端真的用了它
 *
 * 上面那条只能证明 makeByteCounter 本身按字节算。它测不到「服务端有没有用它」——
 * 变异测试证实了这一点：把 ncmPost 里的 `seen.add(c)` 改回 `data.length > LIMIT`，
 * 上面那条依然全绿。所以这里补一条**真行为**用例：
 * 拦截 https.request 造一个「全中文超大响应」的上游，断言 /ncm/ 走到「上游响应体过大」。
 *
 * 为什么这个形状能区分两种判据：
 *   · 负载 = 6M 个中文字 = 18MB 真实字节，但只有 6M UTF-16 码元；
 *   · 按字节判：18MB > 16MB → 立刻触发（期望行为）；
 *   · 按 data.length 判：6M < 16M 码元 → **不会**触发（修前的错误行为，本用例会红）。
 */
test('L-8 服务端真的按字节判：全中文 18MB 上游响应必须被拦下', async () => {
  const https = require('node:https');
  const { EventEmitter } = require('node:events');
  const srv = require(path.join(ROOT, 'server.js'));

  /* 在进程内起一个独立实例（不占用上面的 env，也不碰它的 data-dir） */
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ripple-l8-'));
  const origRequest = https.request;
  let stubbed = 0;
  try {
    /* 用假的 https.request 顶掉真实上游 */
    https.request = function (opts, cb) {
      stubbed += 1;
      const reqEmitter = new EventEmitter();
      reqEmitter.write = () => {};
      reqEmitter.end = () => {
        /* 回调在下一拍触发，模拟真实异步 */
        setImmediate(() => {
          const resEmitter = new EventEmitter();
          resEmitter.setEncoding = () => {};
          resEmitter.headers = {};
          resEmitter.complete = true;
          cb(resEmitter);
          /* 分 12 块推 500K 个中文字 = 每块 1.5MB 字节，合计 18MB 字节 / 6M 码元 */
          const chunk = '中'.repeat(500000);
          let n = 0;
          const pump = () => {
            if (n >= 12) {
              resEmitter.emit('end');
              reqEmitter.emit('close');
              return;
            }
            n += 1;
            resEmitter.emit('data', chunk);
            /* 用宏任务推进，让超限分支的 destroy 有机会生效 */
            if (!reqEmitter.__destroyed) setImmediate(pump);
          };
          setImmediate(pump);
        });
      };
      reqEmitter.destroy = () => { reqEmitter.__destroyed = true; };
      reqEmitter.setTimeout = () => {};
      return reqEmitter;
    };

    await new Promise((resolve) => srv.server.listen(0, '127.0.0.1', resolve));
    const p = srv.server.address().port;
    const tk = await grabToken(p);

    const r = await request(p, {
      method: 'POST',
      path: '/ncm/lyric',
      headers: {
        Origin: 'http://localhost:' + p,
        'X-Ripple-Token': tk,
        'Content-Type': 'application/json',
      },
      body: '{"id":"1"}',
    });

    assert.ok(stubbed >= 1, '假上游必须真的被调用到（否则这条用例测的是空气）');
    assert.strictEqual(r.status, 502, '上游响应体超限应回 502（上游失败），实际 ' + r.status);
    assert.match(r.body, /上游响应体过大/,
      '响应必须是「上游响应体过大」，实际：' + r.body.slice(0, 200));
    assert.match(r.body, /16MB/, '错误文案应说明是 16MB 上限');
  } finally {
    https.request = origRequest;
    try { await new Promise((res) => srv.server.close(res)); } catch (e) {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
});
