#!/usr/bin/env node
/**
 * Ripple 本地服务器（浏览器 / PWA 模式用）
 *
 * 1. 静态托管 app/ 目录（代码类资源 no-cache + ETag，改了就生效）
 * 2. POST /ncm/<cmd>  —— 真·网易云代理：Node 侧做 weapi 加密 + 带登录 cookie，
 *    和 APK 里 Java 的 NeteaseClient 是同一套协议（见 app/js/netease.js）
 *    鉴权：同源 + X-Ripple-Token，另按 IP 做令牌桶限流
 * 3. /ripple-token.js —— 页面加载时下发一次性短期令牌（见 settlePageNonce）
 *
 * 用法：node server.js [PORT] [--data-dir <目录>]
 * 手机与电脑同一 Wi-Fi 时，用打印出来的局域网地址访问即可。
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

/*
 * 安全判定（Host 白名单 / 同源 / 令牌有效性 / 上游路径）都在这个模块里。
 * 它们以前散在本文件：签发端一套、鉴权端另一套，1.2.1 的 S-01
 * （.local 页面签得出令牌但 API 全 403）就是两套逻辑漂移造成的。
 * 拆出去还有个收益：这些纯函数能直接 require，配上了自动化测试。
 */
const sec = require('./server-security');

/*
 * R-30：数据目录（.ripple-cookie / .ripple-token）默认仍是脚本所在目录，
 * 但允许 --data-dir <路径> 指到别处。默认目录在 /sdcard 这类 fuse 挂载上
 * chmod 是空操作（实测 0660），想真正 0600 就得把数据放进私有目录。
 * 解析放在最前面：后面的 COOKIE_FILE / TOKEN_FILE 都依赖它。
 */
let DATA_DIR = __dirname;
const POSITIONAL = [];
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--data-dir') {
    const v = process.argv[++i];
    if (!v) {
      console.error('\n  --data-dir 缺少目录路径，例如：'
        + 'node server.js 8080 --data-dir /data/data/<pkg>/files/ripple\n');
      process.exit(1);
    }
    DATA_DIR = path.resolve(v);
  } else if (a.startsWith('--data-dir=')) {
    DATA_DIR = path.resolve(a.slice('--data-dir='.length));
  } else {
    POSITIONAL.push(a);
  }
}
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (e) {
  console.error('\n  数据目录不可用：' + DATA_DIR + '\n  ' + (e && e.message) + '\n');
  process.exit(1);
}

/*
 * 端口必须是 1-65535 的纯数字。
 * 以前直接 Number() 后丢给 listen()：传 abc 会得到 NaN → listen 抛 RangeError
 * → 被 uncaughtException 兜住 → 进程以退出码 0 结束，用户以为服务已经起来了。
 * 但只判 Number.isInteger 还不够：Number('0x50')=80、Number('8e3')=8000，
 * 与「1-65535 的整数」这句提示不符，所以先用正则限定十进制写法。
 */
const RAW_PORT = String(POSITIONAL[0] || process.env.PORT || '8080');
if (!/^\d+$/.test(RAW_PORT)) {
  console.error('\n  端口参数非法：' + RAW_PORT + '\n'
    + '  需要一个 1-65535 的十进制整数，例如：node server.js 8081\n');
  process.exit(1);
}
const PORT = Number(RAW_PORT);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error('\n  端口参数非法：' + RAW_PORT + '\n'
    + '  需要一个 1-65535 的整数，例如：node server.js 8081\n');
  process.exit(1);
}
const ROOT = path.join(__dirname, 'app');
const HOST = 'https://music.163.com';

/* ================= weapi 加密（与 Enji / NeteaseCloudMusicApi 一致） ================= */

const IV = Buffer.from('0102030405060708');
const PRESET_KEY = Buffer.from('0CoJUm6Qyw8W8jud');
const MODULUS = Buffer.from(
  'e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135' +
  'fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b9' +
  '7ddef52741d546b8e289dc6935b3ece0462db0a22b8e7', 'hex');
const EXPONENT = BigInt(65537);
const B62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function aesCbcB64(text, key) {
  const c = crypto.createCipheriv('aes-128-cbc', key, IV);
  return Buffer.concat([c.update(Buffer.from(text, 'utf8')), c.final()]).toString('base64');
}

/** textbook RSA（无 padding），输入左侧补 0 到 128 字节 */
function rsaNoPadding(buf) {
  const block = Buffer.alloc(128);
  buf.copy(block, 128 - Math.min(buf.length, 128));
  let m = BigInt('0x' + block.toString('hex'));
  const n = BigInt('0x' + MODULUS.toString('hex'));
  let c = 1n;
  let e = EXPONENT;
  while (e > 0n) {
    if (e & 1n) c = (c * m) % n;
    m = (m * m) % n;
    e >>= 1n;
  }
  let hex = c.toString(16);
  if (hex.length < 256) hex = '0'.repeat(256 - hex.length) + hex;
  return hex;
}

function weapiForm(obj) {
  const text = JSON.stringify(obj || {});
  let sk = '';
  for (let i = 0; i < 16; i++) sk += B62[crypto.randomInt(62)];
  const first = aesCbcB64(text, PRESET_KEY);
  const params = aesCbcB64(first, Buffer.from(sk, 'utf8'));
  const encSecKey = rsaNoPadding(Buffer.from(sk.split('').reverse().join(''), 'utf8'));
  return 'params=' + encodeURIComponent(params) + '&encSecKey=' + encodeURIComponent(encSecKey);
}

/* ================= 会话 cookie ================= */

/* ================= 访问令牌（R-13：页面加载时轮换的短期令牌） ================= */

/*
 * /ncm/ 会带着你的网易云登录态，绝不能对任意网页敞开。
 *
 * 旧做法有两处问题（R-13）：
 *  · 令牌是一份长期有效的固定值，一旦泄露就永久可用；
 *  · /ripple-token.js 只看 Sec-Fetch-Site，而这个头客户端可以随便伪造，
 *    任何能在同机执行 curl 的程序加一个 -H 就能把令牌拿走（已实测）。
 *
 * 现在改成「页面加载时签发的短期令牌」：
 *  · 令牌 = 16 字节随机数，默认 30 分钟 TTL，并且绑定签发时的客户端 IP；
 *  · 每次页面请求 /ripple-token.js 就轮换一次：新令牌入列，只保留 2 个旧令牌
 *    当灰度窗口（正在飞的在途请求不至于立刻 401），更早的立即失效；
 *  · 令牌表落在 .ripple-token（0600，JSON），服务重启后已打开的页面还能继续用；
 *  · 签发端保留 Host 白名单 + Sec-Fetch-Site，并追加
 *    「Sec-Fetch-Mode 或 Origin/Referer 必须是本站」这一条（见 browserSignalOk）。
 *    这层挡的是**盲发**的跨站请求：网页 JS 改不了 Sec-Fetch-*，所以别的网站
 *    偷偷 fetch 你的令牌会被挡。但它拦不住同机上能执行程序的伪造 ——
 *    实测同时带头 `Sec-Fetch-Site: same-origin` + `Sec-Fetch-Mode: no-cors`
 *    就能签出令牌。真正的约束是 TTL + IP 绑定 + 轮换（见 SECURITY.md 的威胁模型）。
 *
 * 前端协议保持不变：仍然请求 /ripple-token.js，仍然读 window.RIPPLE_TOKEN。
 */
const TOKEN_FILE = path.join(DATA_DIR, '.ripple-token');
/*
 * 测试/调试时可覆盖（例如 RIPPLE_TOKEN_TTL_MS=20000 观察过期后的 401）。
 *
 * S-02 讨论过「把默认 TTL 再调短」：结论是**不调**。前端只在页面加载时取一次令牌
 * （index.html 的 <script src="/ripple-token.js">），拿到 401 也不会自动续签。
 * 而这是个「打开就一直放着听歌」的播放器 —— TTL 一旦短于用户开着的时长，
 * 到时接口就全 401 并提示「请用最新 server.js 打开本页」，属于把安全焦虑转嫁成可用性 bug。
 * 而且缩短 TTL 对同机攻击者的收益≈0：那种程序随时能再签一份（见 SECURITY.md 的威胁模型）。
 * 真正该收紧的方向是浏览器侧挑战（cookie / nonce 校验），本轮不做。
 */
const TOKEN_TTL_MS = (() => {
  const raw = Number(process.env.RIPPLE_TOKEN_TTL_MS);
  if (!Number.isFinite(raw) || raw <= 0) return 30 * 60 * 1000;
  return Math.min(Math.max(raw, 10 * 1000), 24 * 60 * 60 * 1000);
})();
const TOKEN_KEEP_PREV = 2;          // 轮换时保留的旧令牌个数
const TOKEN_ISSUE_PER_MIN = 30;     // 每个 IP 每分钟最多签发多少个（防刷爆轮换窗口）

/** 当前有效令牌：新的在前，每项 { t, ip, exp } */
let tokenList = [];

const normIp = sec.normIp;

/** 只在真的清掉了过期项时才换数组，避免每次鉴权都新建对象 */
function pruneTokens(now) {
  const keep = sec.pruneTokens(tokenList, now);
  if (keep !== tokenList) tokenList = keep;
}

function loadTokenStore() {
  let raw = '';
  try { raw = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch (e) { return; }
  if (!raw) return;
  try {
    const j = JSON.parse(raw);
    const arr = (j && Array.isArray(j.tokens)) ? j.tokens : [];
    tokenList = arr
      .filter((e) => e && typeof e.t === 'string' && /^[a-f0-9]{32}$/.test(e.t))
      .map((e) => ({ t: e.t, ip: normIp(e.ip), exp: Number(e.exp) || 0 }))
      .slice(0, TOKEN_KEEP_PREV + 1);
    pruneTokens(Date.now());
  } catch (e) {
    /* 旧版本文件里就是一行裸令牌，直接丢弃，按新格式重建（下次签发时写盘） */
    tokenList = [];
  }
}

function saveTokenStore() {
  /* R-14 同款：先写临时文件再 rename，写到一半被杀不会留下半截 JSON */
  const tmp = TOKEN_FILE + '.tmp-' + process.pid;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ v: 2, tokens: tokenList }), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, TOKEN_FILE);
    try { fs.chmodSync(TOKEN_FILE, 0o600); } catch (e) {}
  } catch (e) {
    console.warn('[ripple] 令牌表写入失败（' + TOKEN_FILE + '）：' + (e && e.message));
    try { fs.unlinkSync(tmp); } catch (e2) {}
  }
}

/** 签发新令牌并旋转：新令牌在前，只留 TOKEN_KEEP_PREV 个旧的 */
function issueToken(ip) {
  const now = Date.now();
  pruneTokens(now);
  const t = crypto.randomBytes(16).toString('hex');
  tokenList.unshift({ t: t, ip: normIp(ip), exp: now + TOKEN_TTL_MS });
  tokenList = tokenList.slice(0, TOKEN_KEEP_PREV + 1);
  saveTokenStore();
  return t;
}

/** 令牌是否有效：必须存在、未过期、且来源 IP 与签发时一致 */
function tokenValid(got, ip) {
  pruneTokens(Date.now());
  return sec.tokenValid(tokenList, got, ip);
}

loadTokenStore();
try { if (fs.existsSync(TOKEN_FILE)) fs.chmodSync(TOKEN_FILE, 0o600); } catch (e) {}
checkSecretMode(TOKEN_FILE);

/*
 * chmod 在 Android 内部存储（/sdcard，fuseblk）上是空操作：写完读回来还是 660。
 * 这里读回实际 mode 核对，不符就大声提醒 —— 不要抛错退出，服务还能正常用，
 * 只是「同机其它 App 读不到」这个承诺不成立，用户得知道。
 */
function checkSecretMode(file) {
  let mode;
  try { mode = fs.statSync(file).mode & 0o777; } catch (e) { return; }
  if (mode === 0o600) return;
  const got = '0' + mode.toString(8);
  console.warn('\n  ⚠️  安全警告：' + path.basename(file) + ' 的实际权限是 ' + got
    + '，不是预期的 0600。\n'
    + '     chmod 在当前文件系统（如 /sdcard 的 fuse 挂载）上是空操作，\n'
    + '     同机其它应用可能读到这个文件里的登录态 / 访问令牌。\n'
    + '     建议用 --data-dir 把数据目录指到应用私有目录再跑，例如：\n'
    + '       node server.js 8080 --data-dir /data/data/<pkg>/files/ripple\n');
}

/*
 * B-3：Host 头是客户端可控的，不能只拿它跟 Origin 互相比对。
 *
 * 攻击方式（已实测可行）：把 evil.example.com 解析到 127.0.0.1:8080，
 * 浏览器发起请求时 Host 与 Origin 都是 evil.example.com → 两者相等 → 同源通过，
 * /ripple-token.js 直接把令牌吐给恶意页面。Sec-Fetch-Site 还必然是 same-origin，
 * 所以它也不能单独当判据。
 *
 * 修法：只接受「本机实际可达的 Host」（localhost / 127.0.0.1 / 本机网卡 IP / .local 主机名），
 * 其余一律 421，连静态文件都不给。
 *
 * R-26：以前是启动时把网卡 IP 拷进 Set，手机切 Wi-Fi 或 IP 变了之后新地址一律 421，
 * 只能重启服务。现在改成**实时查询**网卡，带 5 秒短缓存（同一页面会连发几十个请求，
 * 不缓存的话每个请求都要枚举一次网卡）。
 */
const LOCAL_HOST_NAMES = sec.LOCAL_HOST_NAMES;
const HOST_CACHE_MS = 5 * 1000;

let hostCache = { at: 0, set: new Set(LOCAL_HOST_NAMES) };

/** 当前本机可达的 Host 集合（5 秒缓存） */
function allowedHosts() {
  const now = Date.now();
  if (now - hostCache.at < HOST_CACHE_MS) return hostCache.set;
  const set = new Set(LOCAL_HOST_NAMES);
  try {
    const ifs = os.networkInterfaces();
    Object.keys(ifs).forEach((name) => {
      (ifs[name] || []).forEach((i) => {
        if (i && i.address) set.add(String(i.address).toLowerCase());
      });
    });
  } catch (e) {}
  hostCache = { at: now, set: set };
  return set;
}

/**
 * Host 是否被接受（白名单 + `.local`）。
 * 判定本身在 server-security.js：签发令牌和 API 鉴权必须走同一个函数，
 * 否则又会出现「页面能开、令牌能签，但 API 全 403」那种两边口径不一致的问题。
 */
function hostAllowed(req) {
  return sec.hostAllowed(req, allowedHosts());
}

/** 421 响应体：把当前允许的 Host 列表带上，用户自己就能判断该怎么访问 */
function hostRejectBody(req) {
  const raw = String(req.headers.host || '').toLowerCase().trim();
  const list = [];
  try {
    allowedHosts().forEach((h) => {
      if (h === '0.0.0.0') return;
      /* 当前请求的 Host 已经实际可用，没必要再列一遍（它被拒说明不在白名单里） */
      list.push(h);
    });
  } catch (e) {}
  /* IPv4 / localhost 排在前面；IPv6 裸地址拼 URL 要加方括号，否则出来的链接是废的 */
  const urlFor = (h) => {
    if (h.startsWith('[')) return 'http://' + h + ':' + PORT + '/';
    if (h === '::1') return 'http://[::1]:' + PORT + '/';
    if (h.includes(':')) return 'http://[' + h + ']:' + PORT + '/';
    return 'http://' + h + ':' + PORT + '/';
  };
  const v4 = list.filter((h) => !h.includes(':') || h === 'localhost').sort();
  const v6 = list.filter((h) => h.includes(':') && h !== 'localhost').sort();
  return 'misdirected request: host not allowed\n'
    + '\n'
    + '  请求的 Host: ' + (raw || '(空)') + '\n'
    + '  当前允许的 Host（每 5 秒自动刷新，换网络/IP 变了不用重启）:\n'
    + v4.concat(v6).map((h) => '    ' + h + '\n      → ' + urlFor(h) + '\n').join('')
    + '    <主机名>.local       （mDNS，同一局域网内可直接用）\n'
    + '\n'
    + '  若确实要用别的域名（如反向代理），请让代理把 Host 改成上面某个值。\n';
}

/** 同源判定：Origin 与本机白名单 + 本次请求的 Host 比对（判定逻辑见 server-security.js） */
function originAllowed(req) {
  return sec.originAllowed(req, allowedHosts());
}

/*
 * R-13：/ripple-token.js 现在的门槛是三段。
 *
 *  ① Host 白名单 —— DNS rebinding 挡在这里（Sec-Fetch-Site 在那种场景下必然是
 *     same-origin，所以它只能当辅助，不能当判据）；
 *  ② 浏览器信号 —— Sec-Fetch-Site 必须是 same-origin，Sec-Fetch-Mode 必须是
 *     浏览器会用的那几个值，或者 Origin/Referer 至少有一个能对上本站。
 *     它挡的是**盲发**的跨站请求（别的网站的 JS 无法自定这几个头）；
 *     对同机上能执行程序的伪造请求头只算礼貌层，别把它当安全边界。
 *  ③ 令牌本身是短期 + IP 绑定 + 每次加载轮换（见 issueToken），
 *     所以即便有人把① ② 都伪造齐了，拿到的也只是一份很短命的令牌。
 *
 * 注意：这里不做「只允许一次」——index.html 与 SW 都可能重复取同一个脚本，
 * 一次性会导致页面刷新后立刻失效。用 TTL + 轮换达到同样的目标。
 */
function browserSignalOk(req) {
  return sec.browserSignalOk(req, allowedHosts());
}

function tokenEndpointAllowed(req) {
  if (!hostAllowed(req)) return false;
  return browserSignalOk(req);
}

/* 每个 IP 的令牌签发限流：轮换窗口只有 3 个槽位，不限制的话别人能把它刷没 */
function issueTokenLimited(req) {
  const waitS = rateLimitTake(normIp(clientIp(req)) + '|tok', TOKEN_ISSUE_PER_MIN);
  return waitS;
}

const COOKIE_FILE = path.join(DATA_DIR, '.ripple-cookie');
let cookieJar = '';
/** 串行化 Set-Cookie 合并，避免并发响应互相覆盖 */
let cookieWriteChain = Promise.resolve();
try { cookieJar = fs.readFileSync(COOKIE_FILE, 'utf8').trim(); } catch (e) {}
/* 这个文件里是明文的 MUSIC_U 登录态，期望权限 0600（生效与否由 checkSecretMode 核对） */
try { if (fs.existsSync(COOKIE_FILE)) fs.chmodSync(COOKIE_FILE, 0o600); } catch (e) {}
checkSecretMode(COOKIE_FILE);

/* ================= 速率限制（按 IP 的内存令牌桶） ================= */

/*
 * /ncm/* 每命中一次就是一次真实的网易云 weapi 请求，带着用户的 cookie。
 * 不做限流的话，同网段设备（或用户自己写错的循环）能轻易把账号送进风控。
 * 令牌桶：容量 = 每分钟上限，按秒匀速回填；桶表定期清理，不会无限增长。
 */
const RATE_LIMIT_PER_MIN = 60;
const RATE_WINDOW_MS = 60 * 1000;
const BUCKET_IDLE_MS = 10 * 60 * 1000;   // 空闲超过 10 分钟的桶直接回收
const buckets = new Map();               // key: 'ip|bucketName' → { tokens, ts }

function clientIp(req) {
  const ip = (req.socket && req.socket.remoteAddress) || '';
  return String(ip).replace(/^::ffff:/, '') || 'unknown';
}

/** 命中返回 0；限流则返回建议的 Retry-After 秒数 */
function rateLimitTake(key, perMin) {
  const now = Date.now();
  const refillPerMs = perMin / RATE_WINDOW_MS;
  let b = buckets.get(key);
  if (!b) {
    b = { tokens: perMin, ts: now };
    buckets.set(key, b);
  } else {
    b.tokens = Math.min(perMin, b.tokens + (now - b.ts) * refillPerMs);
    b.ts = now;
  }
  if (b.tokens >= 1) {
    b.tokens -= 1;
    return 0;
  }
  return Math.max(1, Math.ceil((1 - b.tokens) / refillPerMs / 1000));
}

const bucketSweeper = setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) {
    if (now - b.ts > BUCKET_IDLE_MS) buckets.delete(k);
  }
}, 5 * 60 * 1000);
if (bucketSweeper.unref) bucketSweeper.unref();   // 不阻止进程退出

function cookieMap(raw) {
  const m = {};
  (raw || '').split(';').forEach((p) => {
    const s = p.trim();
    const i = s.indexOf('=');
    if (i > 0) m[s.slice(0, i)] = s.slice(i + 1);
  });
  return m;
}
function cookieStr(m) {
  return Object.entries(m).map(([k, v]) => k + '=' + v).join('; ');
}
/*
 * R-14：以前直接 writeFileSync 原地截断重写。
 * 进程在写一半时被杀 / 磁盘满，会留下半截 cookie，下次启动读到残值 → 「莫名掉登录」，
 * 而且 catch (e) {} 连一行日志都没有。改成「写临时文件 + rename 原子替换」，
 * 失败时明确 warn 一条，用户至少能在控制台看见。
 */
function saveCookie() {
  const tmp = COOKIE_FILE + '.tmp-' + process.pid;
  try {
    fs.writeFileSync(tmp, cookieJar, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, COOKIE_FILE);
    /* rename 不会改权限，重新 align 一次；在某些挂载上（如 /sdcard）这一步是空操作 */
    try { fs.chmodSync(COOKIE_FILE, 0o600); } catch (e) {}
  } catch (e) {
    console.warn('[ripple] 会话 cookie 写入失败（' + COOKIE_FILE + '）：' + (e && e.message));
    try { fs.unlinkSync(tmp); } catch (e2) {}
  }
}
function csrfToken() {
  return cookieMap(cookieJar).__csrf || '';
}

/* ================= 网易云请求 ================= */

const UA = 'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) '
  + 'Chrome/124.0.0.0 Mobile Safari/537.36';

/*
 * 上游路径校验（实现在 server-security.js，那里连注释一起搬过去了）。
 * ncmCall 的 switch 是逻辑白名单，但它靠字符串拼出 path，
 * 只要某个命令把用户参数直接拼进路径（comments 就是这样），
 * `x/../../../../user/level` 这种就能靠 WHATWG URL 的 .. 归一化跳出白名单。
 * 真正的关口在**拼 URL 之前**检查原始 path：
 * 只允许 [a-z0-9/_-]，天然排除了 `.`、`..`、`%`、`\`、`?`、`#` 等一切
 * 能改变路径含义的字符。归一化后的 pathname 再校验一次，纯属纵深防御。
 */
function assertUpstreamPath(rawPath, url) {
  sec.assertUpstreamPath(rawPath, url);
}

function ncmPost(path, body) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(HOST + '/weapi/' + path);
      assertUpstreamPath(path, url);
    } catch (e) {
      return reject(e);
    }
    const form = weapiForm(body);
    url.searchParams.set('csrf_token', csrfToken());

    const req = https.request({
      host: url.host,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'User-Agent': UA,
        Referer: 'https://music.163.com/',
        Origin: 'https://music.163.com',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(form),
        Accept: '*/*',
        Cookie: 'os=android; appver=8.9.70; osver=13; ' + cookieJar,
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        const sc = res.headers['set-cookie'];
        if (sc && sc.length) {
          /*
           * 并发请求会同时收到 Set-Cookie。以前每个响应各自
           * cookieMap(cookieJar) → 改 → 整体写回，后写的会盖掉先写的，
           * 丢掉刚拿到的会话字段。这里用一个串行队列把「合并」串起来，
           * 保证每次都基于最新值改、且只有一处写盘。
           */
          cookieWriteChain = cookieWriteChain.then(() => {
            const jar = cookieMap(cookieJar);
            sc.forEach((line) => {
              const pair = line.split(';')[0].trim();
              const i = pair.indexOf('=');
              if (i <= 0) return;
              const k = pair.slice(0, i);
              const v = pair.slice(i + 1);
              if (!v || /^(deleted|null)$/i.test(v)) delete jar[k];
              else jar[k] = v;
            });
            cookieJar = cookieStr(jar);
            saveCookie();
          }).catch(() => {});
        }
        resolve(data);
      });
    });
    req.on('error', reject);
    req.setTimeout(18000, () => req.destroy(new Error('timeout')));
    req.write(form);
    req.end();
  });
}

/**
 * E-18：参数校验错误统一构造，实现在 server-security.js（测试要能直接 require）。
 * 以前只靠错误信息前缀正则判断「是不是客户端的问题」，漏一条就变成 502（上游失败）。
 * 现在改成带 err.badRequest = true 标记，错误处理优先看这个标记。
 * 正则兜底仍然保留（兼容历史上直接 throw new Error 的路径）。
 */
const badRequest = sec.badRequest;

/** 把可选的分页参数收敛成整数：非法就用默认值，再 clamp 到 [min, max] */
function clampInt(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** 与 NeteaseClient.call 的命令表一一对应 */
async function ncmCall(cmd, p = {}) {
  switch (cmd) {
    case 'status': {
      const r = await ncmPost('w/nuser/account/get', {});
      if (!/MUSIC_U=/.test(cookieJar)) return r;
      try {
        const acc = JSON.parse(r);
        if (acc.profile) {
          acc._extra = {
            vip: JSON.parse(await ncmPost('vip/info/v2', {})),
            level: JSON.parse(await ncmPost('user/level', {})),
            like: JSON.parse(await ncmPost('song/like/get', { uid: String(acc.profile.userId) })),
          };
          return JSON.stringify(acc);
        }
      } catch (e) {}
      return r;
    }
    case 'login_qr_key':
      return ncmPost('login/qrcode/unikey', { type: 3 });
    case 'login_qr_check':
      return ncmPost('login/qrcode/client/login', { key: p.key, type: 3 });
    case 'logout': {
      /*
       * E-14：顺序不能反（与 NeteaseClient.java:174-184 一致）。
       * 必须**先**带着当前 cookie 请求上游 logout，让服务端会话真正失效，
       * 之后再清本地 jar。反过来的话是「带空 cookie 去注销」：
       * 界面显示已退出，但那个 MUSIC_U 在服务端依然有效。
       */
      let r = '';
      try { r = await ncmPost('logout', {}); } catch (e) { r = ''; }
      cookieJar = '';
      saveCookie();
      /* 上游失败也照样清本地（用户点了退出，界面必须回到未登录），
         但回一个合法 JSON，别让前端 JSON.parse 炸掉 */
      return r || JSON.stringify({ code: 200 });
    }
    case 'search': {
      const body = { s: p.keywords, type: p.type || 1, limit: p.limit || 30, offset: p.offset || 0, total: true };
      const r = await ncmPost('cloudsearch/pc', body);
      /*
       * E-15：兜底判据与 NeteaseClient.java:331-341 保持一致 ——
       * 只有「拿不到 result.songs」**且**「code != 200」时才回落老接口。
       * 以前是「没有 result.songs 就回落」，于是云搜索被限流但返回
       * {"result":{},"code":200} 时，APK 给空结果、网页版却回落出另一批数据。
       */
      try {
        const j = JSON.parse(r);
        const has = !!(j.result && j.result.songs);
        const code = typeof j.code === 'number' ? j.code : 200;
        if (!has && code !== 200) throw new Error('fallback');
      } catch (e) {
        return ncmPost('search/get', body);
      }
      return r;
    }
    case 'song_detail': {
      /*
       * E-35：ids 必须是非空的「数字逗号串」（Java 侧用 Long.parseLong 也是这个强度）。
       * 以前 ids="abc" 会构造出 [{"id":null}] 发给上游，既查不到也看不出是谁的错。
       * 参数错误带 badRequest 标记，由错误处理回 400 而不是 502。
       */
      const c = [];
      String(p.ids == null ? '' : p.ids).split(',').forEach((part) => {
        const t = part.trim();
        if (!t) return;
        if (!/^\d+$/.test(t) || !Number.isSafeInteger(Number(t))) {
          throw badRequest('song_detail: ids 必须是数字逗号串');
        }
        c.push({ id: Number(t) });
      });
      if (!c.length) throw badRequest('song_detail: ids 不能为空');
      return ncmPost('v3/song/detail', { c: JSON.stringify(c) });
    }
    case 'song_url':
      return ncmPost('song/enhance/player/url/v1', {
        ids: '[' + p.id + ']', level: p.level || 'exhigh', encodeType: 'flac',
      });
    case 'lyric':
      return ncmPost('song/lyric', { id: p.id, tv: -1, lv: -1, rv: -1, kv: -1, _nmclfl: 1 });
    case 'playlist':
      /* E-16：与 NeteaseClient.java:194-204 一致，只要 300 首（以前是 100000） */
      return ncmPost('v6/playlist/detail', { id: p.id, n: 300, s: 8 });
    case 'playlist_tracks': {
      /*
       * E-16：与 NeteaseClient.java:366-383 对齐 —— 上游只取 n=300 条 trackIds，
       * 页内按 offset/limit 取窗口（limit 默认 200，收敛到 1..1000，防一次要一万首）。
       * 以前这里是 n=100000、limit 默认 200 且完全忽略 offset：
       * 同一个万人歌单，APK 显示 300 首，网页版把 10 万条 trackIds 全拉下来再截前 N 条，
       * 而且前端传 offset 也无效（翻页永远拿第一页）。
       */
      const detail = JSON.parse(await ncmPost('v6/playlist/detail', { id: p.id, n: 300, s: 8 }));
      const all = (detail.playlist && detail.playlist.trackIds) || [];
      const offset = clampInt(p.offset, 0, 300, 0);
      const limit = clampInt(p.limit, 1, 1000, 200);
      const ids = all.slice(offset, offset + limit)
        .map((t) => (t && t.id != null ? t.id : null))
        .filter((id) => id != null);
      /* 翻到末尾（或上游没给 trackIds）时回 detail 本身，与 Java「trackIds 为空就 return detail」一致 */
      if (!ids.length) return JSON.stringify(detail);
      return ncmCall('song_detail', { ids: ids.join(',') });
    }
    case 'toplist':
      return ncmPost('toplist', {});
    case 'recommend': {
      let r = await ncmPost('v3/discovery/recommend/songs', {});
      if (!/MUSIC_U=/.test(cookieJar) || r.includes('"code":301')) {
        r = await ncmPost('personalized/newsong', { limit: 30 });
      }
      return r;
    }
    case 'likelist':
      return ncmPost('song/like/get', { uid: String(p.uid || '') });
    case 'like':
      return ncmPost('song/like', { trackId: p.id, userid: p.uid, like: !!p.like });
    case 'user_playlist':
      return ncmPost('user/playlist', {
        uid: String(p.uid || ''), limit: p.limit || 100, offset: p.offset || 0, includeVideo: true,
      });
    case 'personalized':
      return ncmPost('personalized/playlist', { limit: p.limit || 12, total: true, n: 1000 });
    case 'hot_search':
      return ncmPost('search/hot/detail', {});
    case 'heart_mode':
      return ncmPost('playmode/intelligence/list', {
        songId: p.songId, type: 'fromPlayOne', playlistId: p.playlistId || '0',
        startMusicId: p.startMusicId || p.songId, count: p.count || 20,
      });
    case 'simi_song':
      return ncmPost('v1/discovery/simiSong', {
        songid: p.songId, limit: p.limit || 20, offset: p.offset || 0,
      });
    case 'comment_add': {
      /* 第 16 条：发评论，和 Java 侧 NeteaseClient 的 comment_add 保持一致 */
      const cid2 = String(p.id == null ? '' : p.id);
      if (!/^\d+$/.test(cid2)) throw badRequest('comment_add: id 必须是数字');
      const txt = String(p.content == null ? '' : p.content).trim();
      if (!txt) throw badRequest('comment_add: 内容不能为空');
      if (txt.length > 140) throw badRequest('comment_add: 最多 140 字');
      return ncmPost('v1/resource/comments/add', {
        threadId: 'R_SO_4_' + cid2, content: txt,
      });
    }
    case 'comments': {
      /*
       * id 要拼进上游 URL 路径，只允许纯数字。
       * 不做这层的话 `x/../../../../user/level` 能靠 URL 归一化跳出白名单。
       * 抛错而不是返回 {code:-1}，让 /ncm/ 回 4xx，攻击/手误在状态码上就看得见。
       */
      const cid = String(p.id == null ? '' : p.id);
      if (!/^\d+$/.test(cid)) throw badRequest('comments: id 必须是数字');
      return ncmPost('v1/resource/comments/R_SO_4_' + cid, {
        rid: cid, limit: p.limit || 20, offset: p.offset || 0,
        beforeTime: p.before || 0,
      });
    }
    case 'personal_fm':
      return ncmPost('v1/radio/get', {});
    default:
      return JSON.stringify({ code: -2, msg: '未知命令 ' + cmd });
  }
}

/* ================= HTTP 服务 ================= */

/*
 * R-25：以前缺 woff2/woff/ttf/gif/webp，实测 .woff2 被当成 application/octet-stream，
 * 而 ASSET_EXT 又会给这些扩展名打「一天」的强缓存 —— 类型错了还会被缓存一整天。
 * 这里补齐常见静态类型；缺了也只会回 octet-stream，不会出错，但浏览器行为不标准。
 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/* 代码类资源必须每次回源校验（配 ETag 走 304），否则改了前端 24 小时不生效 */
const CODE_EXT = new Set(['.html', '.js', '.css', '.json', '.webmanifest', '.txt']);
/* 图片/字体这类内容基本不变，可以放心长缓存 */
const ASSET_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg',
  '.woff', '.woff2', '.ttf', '.otf', '.mp3', '.wav']);

function cacheControlFor(ext) {
  if (CODE_EXT.has(ext)) return 'no-cache';
  if (ASSET_EXT.has(ext)) return 'public, max-age=86400';
  return 'no-cache';
}

/** 弱 ETag：size + mtime 足够定位一次内容变更，且不用读整文件 */
function etagFor(st) {
  return 'W/"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"';
}

function serveStatic(req, res) {
  /*
   * decodeURIComponent 对畸形转义（/%、/%zz、/%E0%A4%A）会抛 URIError。
   * 之前这行没有任何保护 → 一个畸形 GET 就能让整个 Node 进程退出，
   * 局域网里所有正在用这个服务的手机全部断连。必须自己接住。
   */
  let p;
  try {
    p = decodeURIComponent(req.url.split('?')[0]);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('bad request');
  }
  if (p === '/' || p === '') p = '/index.html';
  const file = path.normalize(path.join(ROOT, p));
  /* 前缀校验要带分隔符：只判断 startsWith(ROOT) 时，
     `/../app2/x` 归一化后仍以 `.../app` 开头会被误放行 */
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
    res.writeHead(403);
    return res.end('forbidden');
  }

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404');
    }
    const ext = path.extname(file).toLowerCase();
    const etag = etagFor(st);
    const cache = cacheControlFor(ext);
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': cache,
      ETag: etag,
    };
    /* 编辑器改名/覆盖后 mtime+size 通常会变；配合 ETag 让客户端少下一份 */
    if (ext === '.html' || cache === 'no-cache') headers['Last-Modified'] = st.mtime.toUTCString();

    /* 客户端已有同一版本 → 304，别再传一遍 body */
    const inm = req.headers['if-none-match'];
    if (inm && inm.split(',').some((t) => t.trim() === etag)) {
      res.writeHead(304, headers);
      return res.end();
    }

    headers['Content-Length'] = st.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    /*
     * R-19：stat 到 open 之间文件可能被删 / 权限变了。
     * pipe 不会转发源流的 'error'，没人监听就会走成 uncaughtException，
     * 而这个响应已经写了 200 头 —— 只能销毁连接，否则客户端会挂到超时。
     */
    const stream = fs.createReadStream(file);
    stream.on('error', (err) => {
      console.warn('[ripple] 静态文件读取失败（' + ext + '）：' + (err && err.message));
      try { res.destroy(); } catch (_) {}
    });
    stream.pipe(res);
  });
}

const server = http.createServer((req, res) => {
  /*
   * 整个请求处理包一层：任何一处抛异常都只应该让这一个请求 500，
   * 而不是把进程带走（之前畸形 URL 就是这么打挂服务的）。
   */
  try {
    handleRequest(req, res);
  } catch (e) {
    console.error('[ripple] request failed:', e && e.message);
    try { json(res, 500, { code: 500, msg: 'internal error' }); } catch (e2) {}
  }
});

function handleRequest(req, res) {
  /* B-3：Host 白名单。DNS rebinding 的请求在这里就被挡掉，连静态文件都拿不到。 */
  if (!hostAllowed(req)) {
    /* R-26：把当前允许的 Host 列表一起回出去，换网络后用户自己就能找到该用哪个地址 */
    const body = Buffer.from(hostRejectBody(req), 'utf8');
    res.writeHead(421, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': body.length,
    });
    return res.end(body);
  }
  /* new URL 对畸形请求目标（如 'http://['）会抛 TypeError，同样要接住 */
  let u;
  try {
    u = new URL(req.url, 'http://localhost');
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('bad request');
  }

  if (req.method === 'OPTIONS') {
    if (!originAllowed(req)) { res.writeHead(403); return res.end(); }
    const h = {
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Ripple-Token',
      'Vary': 'Origin',
    };
    const org = req.headers.origin;
    if (org) h['Access-Control-Allow-Origin'] = org;
    res.writeHead(204, h);
    return res.end();
  }

  if (u.pathname.startsWith('/ncm/')) {
    /*
     * E-34：/ncm/* 是「POST 命令」接口，必须限定方法。
     * 以前只校验前缀和令牌，没有任何方法检查：带令牌的 GET /ncm/logout
     * 会真的把用户注销、GET /ncm/comment_add 也能发评论（实测均成立）。
     * 预检 OPTIONS 在上面已经放行，这里只允许 POST，其余 405 + Allow。
     */
    if (req.method !== 'POST') {
      res.writeHead(405, {
        'Allow': 'POST, OPTIONS',
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      return res.end('method not allowed: use POST');
    }
    /*
     * 这个接口用着你的网易云登录态：未登录时是公开搜索，
     * 一旦 .ripple-cookie 里有 MUSIC_U，它就能读你喜欢、改收藏、甚至把你登出。
     * 所以必须「同源 + 令牌」双校验，不能像以前那样对任意 Origin 开 '*'。
     */
    if (!originAllowed(req)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('origin not allowed');
    }
    const ip = clientIp(req);
    /* R-13：令牌短期 + 绑定 IP；过期/换 IP 都算无效，前端会因 401 提示重新打开页面 */
    const got = String(req.headers['x-ripple-token'] || '');
    if (!tokenValid(got, ip)) {
      res.writeHead(401, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      return res.end(JSON.stringify({
        code: 401,
        msg: 'missing or expired X-Ripple-Token',
        hint: '令牌按来源 IP 绑定且有有效期，刷新页面即可重新签发',
      }));
    }
    /* 限流放在鉴权之后：没令牌的扫描不该消耗用户自己的配额 */
    const waitS = rateLimitTake(ip + '|ncm', RATE_LIMIT_PER_MIN);
    if (waitS > 0) {
      res.writeHead(429, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Retry-After': String(waitS),
      });
      return res.end(JSON.stringify({ code: 429, msg: 'too many requests', retryAfter: waitS }));
    }
    const cmd = u.pathname.slice(5);
    let body = '';
    let bodyBytes = 0;
    let tooBig = false;
    /* 客户端提前断开（关页面 / 快速连点）后，await 回来的结果不该再写出去 */
    let closed = false;
    res.on('close', () => { closed = true; });
    const MAX_BODY = 256 * 1024;   // 参数都是小对象，256KB 足够，防止有人灌满内存
    req.setEncoding('utf8');
    req.on('data', (c) => {
      if (tooBig) return;
      /*
       * R-20：setEncoding('utf8') 之后 body.length 是 UTF-16 码元数，
       * 一个中文 3 字节、一个 emoji 4 字节 —— 按 length 计数，256KB 的上限
       * 实际能吃到约 700KB。改按真实字节累计。
       */
      bodyBytes += Buffer.byteLength(c, 'utf8');
      body += c;
      if (bodyBytes > MAX_BODY) {
        tooBig = true;
        body = '';
        try { json(res, 413, { code: 413, msg: 'body too large' }); } catch (e) {}
        try { req.destroy(); } catch (e) {}
      }
    });
    req.on('end', async () => {
      if (tooBig) return;
      let params = {};
      try { params = body ? JSON.parse(body) : {}; } catch (e) {}
      try {
        const out = await ncmCall(cmd, params);
        /* 断开后直接返回：不写响应，也不让上游的 Set-Cookie 覆盖用户当前会话 */
        if (closed) return;
        const okH = {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'Vary': 'Origin',
        };
        if (req.headers.origin) okH['Access-Control-Allow-Origin'] = req.headers.origin;
        res.writeHead(200, okH);
        res.end(out);
      } catch (e) {
        /* 客户端已经走了就别再写，否则又是 write-after-end 噪音 */
        if (closed) return;
        const msg = String(e.message || e);
        /*
         * 参数/路径不合法是 400（客户端的问题），上游失败才是 502。
         * E-18：优先看显式的 err.badRequest 标记（badRequest() 统一打上），
         * 保留原来那两条正则当兜底 —— 万一有路径还在直接 throw new Error。
         */
        const bad = e && e.badRequest === true
          || /^bad upstream path/.test(msg)
          || /^(comments|comment_add|song_detail): /.test(msg);
        json(res, bad ? 400 : 502, { code: bad ? 400 : 502, msg: msg });
      }
    });
    return;
  }

  /*
   * R-13：页面加载时签发一份**新的**短期令牌（30 分钟、绑定来源 IP、每次加载轮换）。
   * 协议不变：前端仍然请求 /ripple-token.js，仍然只读 window.RIPPLE_TOKEN。
   * 旧令牌保留 2 个在灰度窗口内，正在飞的在途请求不会立刻 401。
   */
  if (u.pathname === '/ripple-token.js') {
    if (!tokenEndpointAllowed(req)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      /* 别在 403 文案里承诺「同机一定拿不到」—— 伪造请求头可以过这一层（S-02） */
      return res.end('forbidden: token is only served to browser requests from this page');
    }
    /* 轮换窗口只有 3 个槽位，不对签发做限流的话别人能把它一直刷掉 */
    const waitS = issueTokenLimited(req);
    if (waitS > 0) {
      res.writeHead(429, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'Retry-After': String(waitS),
      });
      return res.end('too many token requests, retry after ' + waitS + 's');
    }
    const token = issueToken(clientIp(req));
    const body = '/* Ripple 临时令牌：绑定来源 IP，有效期 '
      + Math.round(TOKEN_TTL_MS / 1000) + ' 秒，每次页面加载轮换 */\n'
      + 'window.RIPPLE_TOKEN=' + JSON.stringify(token) + ';\n';
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body),
    });
    return res.end(body);
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  return serveStatic(req, res);
}

/* 端口被占时给一句人话，而不是甩一段未捕获的 EADDRINUSE 堆栈 */
server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.error('\n  端口 ' + PORT + ' 已被占用。\n'
      + '  要么换一个端口：node server.js 8081\n'
      + '  要么先结束占用的进程：pkill -f "node server.js"\n');
  } else {
    console.error('[ripple] server error:', e && (e.message || e));
  }
  process.exit(1);
});

/*
 * 兜底：只打印，不退出。单个请求的畸形输入已经在 handleRequest 里接住了，
 * 走到这里通常是没人 await 的偶发异常；让服务继续活着比杀进程对用户更友好。
 * 端口非法这一类「启动参数错」的问题在加载阶段就显式 exit(1)，不靠这里兜。
 */
process.on('uncaughtException', (e) => {
  console.error('[ripple] uncaught:', e && (e.stack || e.message || e));
});

/*
 * O-06：Node ≥15 对未处理的 Promise rejection 默认直接抛（进程退出）。
 * 现在 req.on('end', async …) / ncmPost 的错误都包在 try-catch 或 .catch 里，
 * 但「某个分支漏了 await」就会让服务静默死掉。与上面的策略保持一致：
 * 记录、不退出。
 */
process.on('unhandledRejection', (reason) => {
  console.error('[ripple] unhandled rejection:',
    reason && (reason.stack || reason.message || reason) || reason);
});

/** 启动时打印数据目录与两个状态文件的真实权限（R-30） */
function reportDataDir() {
  console.log('  数据目录   ' + DATA_DIR + (DATA_DIR === __dirname ? '（默认，脚本所在目录）' : ''));
  let bad = false;
  [COOKIE_FILE, TOKEN_FILE].forEach((f) => {
    let mode = null;
    try { mode = fs.statSync(f).mode & 0o777; } catch (e) { mode = null; }
    if (mode === null) {
      console.log('    ' + path.basename(f) + '  尚未创建');
      return;
    }
    const str = '0' + mode.toString(8);
    if (mode === 0o600) {
      console.log('    ' + path.basename(f) + '  ' + str + '  ✓');
    } else {
      bad = true;
      console.log('    ' + path.basename(f) + '  ' + str + '  ✗ 不是 0600');
    }
  });
  if (!bad) return;
  console.warn('\n  ⚠️⚠️  权限告警：数据文件的权限不是 0600，服务却在 0.0.0.0 上监听。\n'
    + '     这通常是因为数据目录在 /sdcard 这类 fuse 挂载上 —— chmod 在那里是空操作。\n'
    + '     同机的其它应用可能读到你的网易云登录态与访问令牌。\n'
    + '     想真正收紧权限，把数据目录指到应用私有目录：\n'
    + '       node server.js ' + PORT + ' --data-dir /data/data/<pkg>/files/ripple\n'
    + '     （详见 README 的「安全与隐私」一节。）\n');
}

server.listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const k of Object.keys(nets)) {
    for (const n of nets[k] || []) {
      if (n.family === 'IPv4' && !n.internal) ips.push(n.address);
    }
  }
  console.log('\n  Ripple 涟漪 · 本地服务已启动\n');
  console.log('  电脑访问   http://localhost:' + PORT);
  ips.forEach((ip) => console.log('  手机访问   http://' + ip + ':' + PORT + '   （需同一 Wi-Fi）'));
  console.log('\n  网易云真接口已就绪：POST /ncm/<cmd>（weapi 加密，可带登录态）');
  console.log('  未登录也能搜索/试听；登录请用 APK，或在 .ripple-cookie 里放 MUSIC_U');
  console.log('  访问令牌  每次页面加载轮换，绑定来源 IP，有效期 '
    + sec.formatTtl(TOKEN_TTL_MS));
  reportDataDir();
  console.log('\n  按 Ctrl+C 停止\n');
});
