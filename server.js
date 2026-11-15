#!/usr/bin/env node
/**
 * Ripple 本地服务器（浏览器 / PWA 模式用）
 *
 * 1. 静态托管 app/ 目录
 * 2. POST /ncm/<cmd>  —— 真·网易云代理：Node 侧做 weapi 加密 + 带登录 cookie，
 *    和 APK 里 Java 的 NeteaseClient 是同一套协议（见 app/js/netease.js）
 * 3. /audio?u=… —— 音频流代理（带 Range，便于拖动进度）
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

const PORT = Number(process.argv[2] || process.env.PORT || 8080);
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

/** 同源判定：允许没有 Origin（同源 fetch / curl）与本站 Origin */
function originAllowed(req) {
  const org = req.headers.origin;
  if (!org) return true;
  try {
    const u = new URL(org);
    const host = String(req.headers.host || '');
    return u.host === host;
  } catch (e) {
    return false;
  }
}

const COOKIE_FILE = path.join(__dirname, '.ripple-cookie');
let cookieJar = '';
/** 串行化 Set-Cookie 合并，避免并发响应互相覆盖 */
let cookieWriteChain = Promise.resolve();
try { cookieJar = fs.readFileSync(COOKIE_FILE, 'utf8').trim(); } catch (e) {}
/* 这个文件里是明文的 MUSIC_U 登录态，权限收到 0600，同机其它用户读不到 */
try { if (fs.existsSync(COOKIE_FILE)) fs.chmodSync(COOKIE_FILE, 0o600); } catch (e) {}

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

function ncmPost(path, body) {
  return new Promise((resolve, reject) => {
    const form = weapiForm(body);
    const url = new URL(HOST + '/weapi/' + path);
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
    case 'comments':
      return ncmPost('v1/resource/comments/R_SO_4_' + p.id, {
        rid: p.id, limit: p.limit || 20, offset: p.offset || 0,
        beforeTime: p.before || 0,
      });
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

const UPSTREAM_HEADERS = {
  'User-Agent': UA,
  Referer: 'https://music.163.com/',
  Accept: '*/*',
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

/*
 * /audio?u= 的 SSRF 防护：只允许网易云的音频/封面域名。
 * 之前只校验协议，局域网里任何网页都能借这个代理读 http://192.168.x.x/admin 之类的内网地址。
 */
const AUDIO_HOSTS = [
  /(^|\.)music\.126\.net$/i,
  /(^|\.)music\.163\.com$/i,
  /(^|\.)126\.net$/i,
  /(^|\.)127\.net$/i,
  /(^|\.)163\.com$/i,
];

function hostAllowed(host) {
  const h = String(host || '').toLowerCase();
  if (!h) return false;
  return AUDIO_HOSTS.some((re) => re.test(h));
}

function proxyAudio(req, res, raw) {
  let target;
  try { target = new URL(raw); } catch (e) { res.writeHead(400); return res.end('bad url'); }
  if (!/^https?:$/.test(target.protocol)) { res.writeHead(400); return res.end('bad protocol'); }
  if (!hostAllowed(target.hostname)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('host not allowed');
  }

  const headers = Object.assign({}, UPSTREAM_HEADERS);
  if (req.headers.range) headers.Range = req.headers.range;

  const mod = target.protocol === 'https:' ? https : http;
  const r = mod.request(target, { method: 'GET', headers }, (pr) => {
    const h = {
      'Content-Type': pr.headers['content-type'] || 'audio/mpeg',
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': pr.headers['accept-ranges'] || 'bytes',
      'Cache-Control': 'public, max-age=3600',
    };
    if (pr.headers['content-length']) h['Content-Length'] = pr.headers['content-length'];
    if (pr.headers['content-range']) h['Content-Range'] = pr.headers['content-range'];
    res.writeHead(pr.statusCode || 200, h);
    pr.pipe(res);
  });
  r.on('error', () => { try { res.writeHead(502); res.end('audio proxy error'); } catch (e) {} });
  r.end();
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
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400',
    });
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
    const cmd = u.pathname.slice(5);
    let body = '';
    let tooBig = false;
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
        const okH = {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'Vary': 'Origin',
        };
        if (req.headers.origin) okH['Access-Control-Allow-Origin'] = req.headers.origin;
        res.writeHead(200, okH);
        res.end(out);
      } catch (e) {
        json(res, 502, { code: 502, msg: String(e.message || e) });
      }
    });
    return;
  }

  /* 同源托管时把访问令牌交给页面（动态生成，不落盘到 app/ 里） */
  if (u.pathname === '/ripple-token.js') {
    const body = 'window.RIPPLE_TOKEN=' + JSON.stringify(ACCESS_TOKEN) + ';\n';
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body),
    });
    return res.end(body);
  }

  if (u.pathname === '/audio') {
    const raw = u.searchParams.get('u');
    if (!raw) { res.writeHead(400); return res.end('missing u'); }
    return proxyAudio(req, res, raw);
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

process.on('uncaughtException', (e) => {
  console.error('[ripple] uncaught:', e && (e.stack || e.message || e));
});

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
