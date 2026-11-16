#!/usr/bin/env node
/**
 * Ripple 本地服务器（浏览器 / PWA 模式用）
 *
 * 1. 静态托管 app/ 目录（代码类资源 no-cache + ETag，改了就生效）
 * 2. POST /ncm/<cmd>  —— 真·网易云代理：Node 侧做 weapi 加密 + 带登录 cookie，
 *    和 APK 里 Java 的 NeteaseClient 是同一套协议（见 app/js/netease.js）
 *    鉴权：同源 + X-Ripple-Token，另按 IP 做令牌桶限流
 * 3. /ripple-token.js —— 访问令牌，只在同源请求下才下发
 *
 * 用法：node server.js [PORT]
 * 手机与电脑同一 Wi-Fi 时，用打印出来的局域网地址访问即可。
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

/*
 * 端口必须是 1-65535 的整数。以前直接 Number() 后丢给 listen()：
 * 传 abc 会得到 NaN → listen 抛 RangeError → 被 uncaughtException 兜住 →
 * 进程以退出码 0 结束，用户以为服务已经起来了。这里显式校验并 exit(1)。
 */
const RAW_PORT = process.argv[2] || process.env.PORT || '8080';
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

/*
 * 访问令牌：/ncm/ 会带着你的网易云登录态，绝不能对任意网页敞开。
 *
 * 做法（不破坏同源使用）：
 *  · token 落在 .ripple-token，页面由本服务托管时自动带同源头；
 *  · /ripple-token.js 只对「确实同源」的请求下发（见 tokenEndpointAllowed），
 *    否则令牌可被同网段任意网页读走，「同源 + 令牌」双校验就没有意义了；
 *  · 关键是把 CORS 从 '*' 改成「只回同源」，于是别的站点既读不到响应、
 *    也不能靠 fetch 直接调用（浏览器会拦）；
 *  · 再用自定义请求头 X-Ripple-Token 做一次显式校验，双击保险。
 */
const TOKEN_FILE = path.join(__dirname, '.ripple-token');
let ACCESS_TOKEN = '';
try {
  ACCESS_TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
} catch (e) {}
if (!ACCESS_TOKEN) {
  ACCESS_TOKEN = crypto.randomBytes(16).toString('hex');
  try { fs.writeFileSync(TOKEN_FILE, ACCESS_TOKEN, { encoding: 'utf8', mode: 0o600 }); } catch (e) {}
}
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
    + '     建议把项目放到应用私有目录（如 /data/data/<pkg>/files）再跑。\n');
}

/*
 * B-3：Host 头是客户端可控的，不能只拿它跟 Origin 互相比对。
 *
 * 攻击方式（已实测可行）：把 evil.example.com 解析到 127.0.0.1:8080，
 * 浏览器发起请求时 Host 与 Origin 都是 evil.example.com → 两者相等 → 同源通过，
 * /ripple-token.js 直接把令牌吐给恶意页面。Sec-Fetch-Site 还必然是 same-origin，
 * 所以它也不能单独当判据。
 *
 * 修法：启动时把「本机实际可达的 Host」收进白名单（localhost / 127.0.0.1 / 本机网卡 IP），
 * 白名单之外的 Host 一律 421，连静态文件都不给。
 */
const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function collectAllowedHosts() {
  try {
    const ifs = os.networkInterfaces();
    Object.keys(ifs).forEach((name) => {
      (ifs[name] || []).forEach((i) => {
        if (i && i.address) ALLOWED_HOSTS.add(String(i.address).toLowerCase());
      });
    });
  } catch (e) {}
}

function hostAllowed(req) {
  const raw = String(req.headers.host || '').toLowerCase().trim();
  if (!raw) return false;                       // HTTP/1.1 必须有 Host
  if (ALLOWED_HOSTS.has(raw)) return true;
  const bare = raw.startsWith('[') ? raw.slice(0, raw.indexOf(']') + 1) : raw.split(':')[0];
  return ALLOWED_HOSTS.has(bare);
}

/** 把 candidate（Origin / Referer）与白名单比对（不再用可伪造的 Host 当基准） */
function hostMatches(req, candidate) {
  if (!candidate) return false;
  try {
    const u = new URL(candidate);
    const host = String(u.host || '').toLowerCase();
    const bare = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
    // 必须同时满足：来源 Host 在白名单里，且和请求的 Host 一致
    return ALLOWED_HOSTS.has(host) || ALLOWED_HOSTS.has(bare)
      ? host === String(req.headers.host || '').toLowerCase()
      : false;
  } catch (e) {
    return false;
  }
}

/*
 * 同源判定。
 * 有 Origin 就比 Origin 与 Host；
 * 没有 Origin 时不再直接放行（那是旧漏洞：curl 不带 Origin 即可打 /ncm/*），
 * 只接受 Sec-Fetch-Site 为 same-origin / none —— 前者是同源 fetch，
 * 后者是用户在地址栏直接打开，两者都不是「别的站点发起的跨站请求」。
 */
function originAllowed(req) {
  const org = req.headers.origin;
  if (org) return hostMatches(req, org);
  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  return site === 'same-origin' || site === 'none';
}

/*
 * /ripple-token.js 的门槛：只允许同源请求取令牌。
 * 优先看 Sec-Fetch-Site；缺失该头（老浏览器 / 非浏览器客户端）时退化为
 * 用 Origin 或 Referer 与 Host 比对；两者都没有就一律拒绝。
 */
function tokenEndpointAllowed(req) {
  /*
   * B-3：Sec-Fetch-Site 只能当「辅助」。
   * 在 DNS rebinding 场景下它必然是 same-origin（浏览器眼里确实是同源），
   * 所以先过 Host 白名单，再看同源信号。
   */
  if (!hostAllowed(req)) return false;
  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (site) return site === 'same-origin';
  return hostMatches(req, req.headers.origin) || hostMatches(req, req.headers.referer);
}

const COOKIE_FILE = path.join(__dirname, '.ripple-cookie');
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
function saveCookie() {
  try { fs.writeFileSync(COOKIE_FILE, cookieJar, { encoding: 'utf8', mode: 0o600 }); } catch (e) {}
}
function csrfToken() {
  return cookieMap(cookieJar).__csrf || '';
}

/* ================= 网易云请求 ================= */

const UA = 'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) '
  + 'Chrome/124.0.0.0 Mobile Safari/537.36';

/*
 * 上游路径校验。ncmCall 的 switch 是逻辑白名单，但它靠字符串拼出 path，
 * 只要某个命令把用户参数直接拼进路径（comments 就是这样），
 * `x/../../../../user/level` 这种就能靠 WHATWG URL 的 .. 归一化跳出白名单。
 *
 * 注意：只在 new URL() 之后校验 pathname 是**不够的** —— URL 构造时已经把
 * `..` 归一化掉了，`/weapi/v1/.../x/../../../../user/level` 会先变成
 * `/weapi/user/level`，一个「必须以 /weapi/ 且只含 [a-z0-9/_-]」的正则
 * 照样通过，等于没拦住。所以真正的关口在**拼 URL 之前**检查原始 path：
 * 只允许 [a-z0-9/_-]，天然排除了 `.`、`..`、`%`、`\`、`?`、`#` 等一切
 * 能改变路径含义的字符。归一化后的 pathname 再校验一次，纯属纵深防御。
 */
const SAFE_PATH_SEG_RE = /^[a-z0-9/_-]+$/i;
const UPSTREAM_PATH_RE = /^\/weapi\/[a-z0-9/_-]+$/i;

function assertUpstreamPath(rawPath, url) {
  if (typeof rawPath !== 'string' || !SAFE_PATH_SEG_RE.test(rawPath) || rawPath.includes('..')) {
    throw new Error('bad upstream path');
  }
  const p = url.pathname;
  if (p.includes('..') || !UPSTREAM_PATH_RE.test(p)) {
    throw new Error('bad upstream path: ' + p);
  }
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
    case 'logout':
      cookieJar = '';
      saveCookie();
      return ncmPost('logout', {});
    case 'search': {
      const body = { s: p.keywords, type: p.type || 1, limit: p.limit || 30, offset: p.offset || 0, total: true };
      const r = await ncmPost('cloudsearch/pc', body);
      try {
        const j = JSON.parse(r);
        if (!j.result || !j.result.songs) throw new Error('fallback');
      } catch (e) {
        return ncmPost('search/get', body);
      }
      return r;
    }
    case 'song_detail': {
      const c = (p.ids || '').split(',').filter(Boolean).map((id) => ({ id: Number(id) }));
      return ncmPost('v3/song/detail', { c: JSON.stringify(c) });
    }
    case 'song_url':
      return ncmPost('song/enhance/player/url/v1', {
        ids: '[' + p.id + ']', level: p.level || 'exhigh', encodeType: 'flac',
      });
    case 'lyric':
      return ncmPost('song/lyric', { id: p.id, tv: -1, lv: -1, rv: -1, kv: -1, _nmclfl: 1 });
    case 'playlist':
      return ncmPost('v6/playlist/detail', { id: p.id, n: 100000, s: 8 });
    case 'playlist_tracks': {
      const detail = JSON.parse(await ncmPost('v6/playlist/detail', { id: p.id, n: 100000, s: 8 }));
      const ids = ((detail.playlist && detail.playlist.trackIds) || []).slice(0, p.limit || 200).map((t) => t.id);
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
      if (!/^\d+$/.test(cid2)) throw new Error('comment_add: id 必须是数字');
      const txt = String(p.content == null ? '' : p.content).trim();
      if (!txt) throw new Error('comment_add: 内容不能为空');
      if (txt.length > 140) throw new Error('comment_add: 最多 140 字');
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
      if (!/^\d+$/.test(cid)) throw new Error('comments: id 必须是数字');
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

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
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
    fs.createReadStream(file).pipe(res);
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
    res.writeHead(421, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('misdirected request: host not allowed');
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
     * 这个接口用着你的网易云登录态：未登录时是公开搜索，
     * 一旦 .ripple-cookie 里有 MUSIC_U，它就能读你喜欢、改收藏、甚至把你登出。
     * 所以必须「同源 + 令牌」双校验，不能像以前那样对任意 Origin 开 '*'。
     */
    if (!originAllowed(req)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('origin not allowed');
    }
    const got = String(req.headers['x-ripple-token'] || '');
    if (got !== ACCESS_TOKEN) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ code: 401, msg: 'missing or bad X-Ripple-Token' }));
    }
    /* 限流放在鉴权之后：没令牌的扫描不该消耗用户自己的配额 */
    const ip = clientIp(req);
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
    let tooBig = false;
    /* 客户端提前断开（关页面 / 快速连点）后，await 回来的结果不该再写出去 */
    let closed = false;
    res.on('close', () => { closed = true; });
    const MAX_BODY = 256 * 1024;   // 参数都是小对象，256KB 足够，防止有人灌满内存
    req.setEncoding('utf8');
    req.on('data', (c) => {
      if (tooBig) return;
      body += c;
      if (body.length > MAX_BODY) {
        tooBig = true;
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
        /* 参数/路径不合法是 400（客户端的问题），上游失败才是 502 */
        const bad = /^bad upstream path|^comments: id 必须是数字/.test(msg);
        json(res, bad ? 400 : 502, { code: bad ? 400 : 502, msg: msg });
      }
    });
    return;
  }

  /*
   * 同源托管时把访问令牌交给页面（动态生成，不落盘到 app/ 里）。
   * 只对确实同源的请求下发 —— 否则令牌本身是公开的，
   * 「同源 + 令牌」双校验就退化成只剩同源一层。
   */
  if (u.pathname === '/ripple-token.js') {
    if (!tokenEndpointAllowed(req)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end('forbidden: token is only served to same-origin requests');
    }
    const body = 'window.RIPPLE_TOKEN=' + JSON.stringify(ACCESS_TOKEN) + ';\n';
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

collectAllowedHosts();
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
  console.log('  按 Ctrl+C 停止\n');
});
