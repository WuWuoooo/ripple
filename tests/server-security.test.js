/*
 * server-security.js 的单元测试。
 *
 * 为什么要有这一组：令牌签发 / Host 白名单 / 同源判定 / 上游路径校验
 * 以前全靠手工 curl 验证，CI 只跑 lrc 的单测。1.2.1 的 S-01
 * （.local 页面签得出令牌但 API 全 403）就是「签发端和鉴权端各写一套判定」
 * 造成的 —— 这类「改一处漏一处」只有回归测试拦得住。
 *
 * 跑法：bash tests/run.sh（或 node --test tests/server-security.test.js）
 * 依赖：只用 Node 内置模块，不需要 npm install。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const sec = require('../server-security.js');

/* ---------------------------------------------------------------- 工具 */

/** 造一个「请求」：只需要 headers 这几个字段，和 server.js 里用到的形状一致 */
function req(headers) {
  return { headers: headers || {} };
}

/** 模拟服务端那份「5 秒刷新的网卡白名单」 */
function hostSet(...extra) {
  const s = new Set(sec.LOCAL_HOST_NAMES);
  extra.forEach((h) => s.add(h));
  return s;
}

const PORT = 8080;

/* ---------------------------------------------------------------- Host 白名单 */

test('Host 白名单：localhost / 127.0.0.1 / 本机网卡 IP 都放行', () => {
  const set = hostSet('192.168.1.7');
  assert.equal(sec.hostAllowed(req({ host: 'localhost:' + PORT }), set), true);
  assert.equal(sec.hostAllowed(req({ host: '127.0.0.1:' + PORT }), set), true);
  assert.equal(sec.hostAllowed(req({ host: '192.168.1.7:' + PORT }), set), true);
  // 不带端口的裸 Host 也要认（HTTP 默认端口时会这么写）
  assert.equal(sec.hostAllowed(req({ host: 'localhost' }), set), true);
  assert.equal(sec.hostAllowed(req({ host: '192.168.1.7' }), set), true);
});

test('Host 白名单：IPv6 各种写法都放行', () => {
  const set = hostSet();
  assert.equal(sec.hostAllowed(req({ host: '[::1]:' + PORT }), set), true);
  assert.equal(sec.hostAllowed(req({ host: '[::1]' }), set), true);
  // 网卡上的 IPv6 地址带端口时形如 [fe80::1]:8080，hostKey 会保留方括号部分
  const set6 = hostSet('[fe80::1]');
  assert.equal(sec.hostAllowed(req({ host: '[fe80::1]:' + PORT }), set6), true);
});

test('Host 白名单：.local（mDNS）放行，含多级子域', () => {
  const set = hostSet();
  assert.equal(sec.hostAllowed(req({ host: 'dshgo.local:' + PORT }), set), true);
  assert.equal(sec.hostAllowed(req({ host: 'dshgo.local' }), set), true);
  assert.equal(sec.hostAllowed(req({ host: 'a-b.c1.local:' + PORT }), set), true);
  // 大小写不敏感
  assert.equal(sec.hostAllowed(req({ host: 'DSHGO.LOCAL:' + PORT }), set), true);
});

test('Host 白名单：外部域名与畸形写法一律拒（DNS rebinding 挡在这里）', () => {
  const set = hostSet('192.168.1.7');
  assert.equal(sec.hostAllowed(req({ host: 'evil.com:' + PORT }), set), false);
  assert.equal(sec.hostAllowed(req({ host: 'localhost.evil.com:' + PORT }), set), false);
  // 后缀像但不以 .local 结尾
  assert.equal(sec.hostAllowed(req({ host: 'notlocal:' + PORT }), set), false);
  assert.equal(sec.hostAllowed(req({ host: 'x.local.evil.com:' + PORT }), set), false);
  // 空 Host / 缺 headers
  assert.equal(sec.hostAllowed(req({}), set), false);
  assert.equal(sec.hostAllowed(req({ host: '' }), set), false);
  assert.equal(sec.hostAllowed({}, set), false);
  assert.equal(sec.hostAllowed(req({ host: '   ' }), set), false);
});

test('hostKey：IPv6 保留方括号，IPv4 / 域名只砍端口', () => {
  assert.equal(sec.hostKey('[::1]:8080'), '[::1]');
  assert.equal(sec.hostKey('[::1]'), '[::1]');
  assert.equal(sec.hostKey('127.0.0.1:8080'), '127.0.0.1');
  assert.equal(sec.hostKey('dshgo.local:8888'), 'dshgo.local');
  assert.equal(sec.hostKey(''), '');
  assert.equal(sec.hostKey(null), '');
});

/* ---------------------------------------------------------------- Origin / Host 一致性 */

test('Origin 与请求 Host 一致 → 同源', () => {
  const set = hostSet('192.168.1.7');
  assert.equal(
    sec.hostMatches(req({ host: '127.0.0.1:' + PORT }), 'http://127.0.0.1:' + PORT, set), true);
  assert.equal(
    sec.hostMatches(req({ host: '192.168.1.7:' + PORT }), 'http://192.168.1.7:' + PORT, set), true);
});

test('S-01 回归：.local 的 Origin 与 Host 都一致时算同源（修前这里是 false）', () => {
  const set = hostSet();
  // 修前 hostMatches 走的是 allowedHosts() 精确集合，.local 不在里面 → 一律 false
  assert.equal(
    sec.hostMatches(req({ host: 'dshgo.local:' + PORT }), 'http://dshgo.local:' + PORT, set), true);
  assert.equal(sec.originAllowed(req({
    host: 'dshgo.local:' + PORT,
    origin: 'http://dshgo.local:' + PORT,
  }), set), true);
});

test('Origin 与请求 Host 不一致 → 跨源，拒（这是安全回归必须守住的一条）', () => {
  const set = hostSet('192.168.1.7');
  // 同一个服务的两种地址互相当 Origin：仍算跨源
  assert.equal(
    sec.hostMatches(req({ host: '127.0.0.1:' + PORT }), 'http://192.168.1.7:' + PORT, set), false);
  assert.equal(
    sec.hostMatches(req({ host: 'dshgo.local:' + PORT }), 'http://127.0.0.1:' + PORT, set), false);
  assert.equal(
    sec.hostMatches(req({ host: '127.0.0.1:' + PORT }), 'http://evil.com:' + PORT, set), false);
  // 端口不同也算不同源
  assert.equal(
    sec.hostMatches(req({ host: '127.0.0.1:8080' }), 'http://127.0.0.1:9999', set), false);
});

test('Origin 非法 / 缺失 / 请求缺 Host 时一律拒', () => {
  const set = hostSet();
  assert.equal(sec.hostMatches(req({ host: '127.0.0.1:' + PORT }), '', set), false);
  assert.equal(sec.hostMatches(req({ host: '127.0.0.1:' + PORT }), null, set), false);
  assert.equal(sec.hostMatches(req({ host: '127.0.0.1:' + PORT }), 'not a url', set), false);
  assert.equal(sec.hostMatches(req({ host: '127.0.0.1:' + PORT }), 'chrome-extension://abc/x', set), false);
  // 请求没有 Host 头时，Origin 再白也没用
  assert.equal(sec.hostMatches(req({}), 'http://127.0.0.1:' + PORT, set), false);
});

test('originAllowed：无 Origin 时只看 Sec-Fetch-Site（same-origin / none）', () => {
  const set = hostSet();
  assert.equal(sec.originAllowed(req({ 'sec-fetch-site': 'same-origin' }), set), true);
  assert.equal(sec.originAllowed(req({ 'sec-fetch-site': 'none' }), set), true);
  assert.equal(sec.originAllowed(req({ 'sec-fetch-site': 'cross-site' }), set), false);
  assert.equal(sec.originAllowed(req({ 'sec-fetch-site': 'same-site' }), set), false);
  // 没有 Origin 也没有 Sec-Fetch-Site：旧漏洞的入口，必须拒
  assert.equal(sec.originAllowed(req({}), set), false);
});

/* ---------------------------------------------------------------- Sec-Fetch 组合 */

test('browserSignalOk：真浏览器的两种典型组合放行', () => {
  const set = hostSet();
  const host = '127.0.0.1:' + PORT;
  // <script src="/ripple-token.js"> 的加载
  assert.equal(sec.browserSignalOk(req({
    host: host, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'no-cors',
  }), set), true);
  // 只带 Origin（SW / 某些老浏览器不带 Sec-Fetch-*）
  assert.equal(sec.browserSignalOk(req({
    host: host, origin: 'http://' + host,
  }), set), true);
  // 只带 Referer 也能对上
  assert.equal(sec.browserSignalOk(req({
    host: host, referer: 'http://' + host + '/index.html',
  }), set), true);
});

test('browserSignalOk：什么都不齐时拒绝（含只带 Sec-Fetch-Site: none 的直开）', () => {
  const set = hostSet();
  const host = '127.0.0.1:' + PORT;
  // 三样全无
  assert.equal(sec.browserSignalOk(req({ host: host }), set), false);
  // 只有 Sec-Fetch-Site，没有 Mode、也没有对得上的 Origin/Referer
  assert.equal(sec.browserSignalOk(req({
    host: host, 'sec-fetch-site': 'same-origin',
  }), set), false);
  /*
   * 地址栏直接打开 /ripple-token.js（site=none、mode=navigate）也是拒的：
   * 这一层比 originAllowed 更严，签发端只认「页面发起的子资源加载」。
   * 正常前端是由 index.html 的 <script src> 取，带的是 same-origin，不受影响。
   */
  assert.equal(sec.browserSignalOk(req({
    host: host, 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate',
  }), set), false);
  // 跨站
  assert.equal(sec.browserSignalOk(req({
    host: host, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors',
  }), set), false);
  // 伪造的杂值 Mode
  assert.equal(sec.browserSignalOk(req({
    host: host, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'websocket',
  }), set), false);
  // Referer 指向外部站点
  assert.equal(sec.browserSignalOk(req({
    host: host, 'sec-fetch-site': 'same-origin', referer: 'http://evil.com/',
  }), set), false);
});

test('S-02 现状固化：Sec-Fetch 全套伪造能过这一层（安全边界不在这里）', () => {
  /*
   * 报告 S-02 实测：同机程序同时发 Sec-Fetch-Site: same-origin + Mode: no-cors
   * 就能签出令牌。这里把这个**已知现状**固化成用例，避免以后有人误以为
   * 「加了这套头校验 = 同机伪造被挡住了」。真正起作用的是 TTL + IP 绑定 + 轮换。
   */
  const set = hostSet();
  const host = '127.0.0.1:' + PORT;
  assert.equal(sec.browserSignalOk(req({
    host: host, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'no-cors',
  }), set), true);
});

test('browserSignalOk：.local 站点同样能通过（S-01 的签发端回归）', () => {
  const set = hostSet();
  const host = 'dshgo.local:' + PORT;
  assert.equal(sec.browserSignalOk(req({
    host: host, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'no-cors',
  }), set), true);
  assert.equal(sec.browserSignalOk(req({
    host: host, origin: 'http://' + host,
  }), set), true);
});

/* ---------------------------------------------------------------- 令牌有效性 */

const T0 = 1_700_000_000_000;

test('tokenValid：有效 / 过期 / IP 不符 / 不存在，四种情形', () => {
  const list = [
    { t: 'aaa', ip: '127.0.0.1', exp: T0 + 60_000 },
    { t: 'bbb', ip: '192.168.1.7', exp: T0 + 60_000 },
  ];
  // 有效
  assert.equal(sec.tokenValid(list, 'aaa', '127.0.0.1', T0), true);
  // 恰好到点也算过期（与 pruneTokens 的 now < exp 一致）
  assert.equal(sec.tokenValid(list, 'aaa', '127.0.0.1', T0 + 60_000), false);
  // IP 不符：令牌按签发 IP 绑定
  assert.equal(sec.tokenValid(list, 'aaa', '192.168.1.7', T0), false);
  assert.equal(sec.tokenValid(list, 'bbb', '127.0.0.1', T0), false);
  // 不存在 / 空
  assert.equal(sec.tokenValid(list, 'ccc', '127.0.0.1', T0), false);
  assert.equal(sec.tokenValid(list, '', '127.0.0.1', T0), false);
  assert.equal(sec.tokenValid(list, null, '127.0.0.1', T0), false);
  assert.equal(sec.tokenValid([], 'aaa', '127.0.0.1', T0), false);
});

test('tokenValid：::ffff: 前缀的 IPv4 映射写法归一成同一个 IP', () => {
  const list = [{ t: 'aaa', ip: sec.normIp('::ffff:127.0.0.1'), exp: T0 + 60_000 }];
  assert.equal(sec.tokenValid(list, 'aaa', '127.0.0.1', T0), true);
  assert.equal(sec.tokenValid(list, 'aaa', '::ffff:127.0.0.1', T0), true);
  // 大小写归一（IPv6 可能带大写）
  assert.equal(sec.normIp('::FFFF:127.0.0.1'), '127.0.0.1');
  assert.equal(sec.normIp(''), 'unknown');
  assert.equal(sec.normIp(null), 'unknown');
});

test('pruneTokens：清掉过期项；没变化时返回原数组引用', () => {
  const list = [
    { t: 'ok', ip: 'x', exp: T0 + 1000 },
    { t: 'old', ip: 'x', exp: T0 - 1000 },
  ];
  const kept = sec.pruneTokens(list, T0);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].t, 'ok');
  // 全都没过期 → 原样返回，调用方据此避免无谓的写盘
  assert.equal(sec.pruneTokens(kept, T0), kept);
  // 非数组容错
  assert.deepEqual(sec.pruneTokens(null, T0), []);
});

/* ---------------------------------------------------------------- 上游路径 */

test('assertUpstreamPath：正常命令路径都放行', () => {
  assert.doesNotThrow(() => sec.assertUpstreamPath('w/nuser/account/get',
    new URL('https://music.163.com/weapi/w/nuser/account/get')));
  assert.doesNotThrow(() => sec.assertUpstreamPath('v3/song/detail',
    new URL('https://music.163.com/weapi/v3/song/detail')));
  // 带下划线与短横线的上游命令也合法
  assert.doesNotThrow(() => sec.assertUpstreamPath('login/qrcode/unikey',
    new URL('https://music.163.com/weapi/login/qrcode/unikey')));
  assert.doesNotThrow(() => sec.assertUpstreamPath('v1/discovery/simiSong',
    new URL('https://music.163.com/weapi/v1/discovery/simiSong')));
});

test('assertUpstreamPath：路径穿越、编码绕过、双斜杠、绝对 URL 全部拒', () => {
  const bad = [
    'x/../../../../user/level',        // 拼进 path 后靠 URL 归一化跳出白名单
    'x/..',
    '..',
    'x/%2e%2e/user/level',             // 编码过的 ..
    'x%2F..%2Fuser',
    '//evil.com/weapi/x',              // 双斜杠（协议相对）
    'http://evil.com/weapi/x',         // 绝对 URL
    'https://evil.com/',
    'x/../y',
    'x?y=1',                           // 能改变 URL 语义的字符
    'x#frag',
    'x\\y',
    '',
    null,
    undefined,
    123,
  ];
  bad.forEach((p) => {
    assert.throws(
      () => sec.assertUpstreamPath(p, new URL('https://music.163.com/weapi/x')),
      (e) => e && e.badRequest === true && /bad upstream path/.test(e.message),
      '应当拒绝：' + JSON.stringify(p)
    );
  });
});

test('assertUpstreamPath：归一化后的 pathname 不在 /weapi/ 下也拒（纵深防御）', () => {
  // 原始 path 干净，但传进来的 url 已经不是 /weapi/ 开头
  assert.throws(
    () => sec.assertUpstreamPath('song/detail', new URL('https://music.163.com/user/level')),
    (e) => e && e.badRequest === true
  );
  // url 缺失
  assert.throws(
    () => sec.assertUpstreamPath('song/detail', null),
    (e) => e && e.badRequest === true
  );
});

test('badRequest：带 badRequest 标记（错误处理据此回 400 而不是 502）', () => {
  const e = sec.badRequest('nope');
  assert.equal(e.badRequest, true);
  assert.equal(e.message, 'nope');
  assert.ok(e instanceof Error);
});

/* ---------------------------------------------------------------- 启动日志的 TTL 文案 */

test('formatTtl：短 TTL 按秒显示，不再出现「有效期 0 分钟」（S-03）', () => {
  assert.equal(sec.formatTtl(20_000), '20 秒');
  assert.equal(sec.formatTtl(10_000), '10 秒');
  assert.equal(sec.formatTtl(1000), '1 秒');
  assert.equal(sec.formatTtl(59_000), '59 秒');
  // 正好 1 分钟起按分钟
  assert.equal(sec.formatTtl(60_000), '1 分钟');
  assert.equal(sec.formatTtl(30 * 60 * 1000), '30 分钟');
  // 非法值兜底，不抛
  assert.equal(sec.formatTtl(0), '0 秒');
  assert.equal(sec.formatTtl(-1), '0 秒');
  assert.equal(sec.formatTtl(NaN), '0 秒');
  assert.equal(sec.formatTtl(undefined), '0 秒');
});
