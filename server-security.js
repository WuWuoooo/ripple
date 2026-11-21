'use strict';
/**
 * server.js 里「安全判定」这一组的纯函数。
 *
 * 为什么单独拆出来：server.js 是启动即 listen 的脚本，require 它就会占端口，
 * 测不了。而 Host 白名单 / 同源判定 / 令牌有效期 / 上游路径校验这几段恰好是
 * 最不该出错的部分 —— 1.2.1 的 S-01（.local 能开页面但 API 全 403）就是
 * 「签发端与鉴权端各写了一套判定」造成的。拆成无状态模块后：
 *   · server.js 只保留「取当前允许的 Host 集合」这种带缓存的 IO 逻辑，判定逻辑唯一；
 *   · tests/server-security.test.js 能直接 require 本模块补回归。
 *
 * 约定：所有函数都无副作用，需要的外部状态（允许的 Host 集合、令牌表、当前时间）
 * 一律由调用方传进来 —— 测试才能构造任意边界场景。
 */

/** 恒定本机可达的 Host（与网卡 IP 一起构成长白名单） */
const LOCAL_HOST_NAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

/**
 * mDNS 主机名（dshgo.local 这类）。
 * 这类名字只能由同一局域网内的设备解析到本机，与「本机网卡 IP」同一信任级别；
 * README 里就是用 http://<主机名>:8080 这种写法访问的，所以放行。
 */
const MDNS_HOST_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.local$/;

/* 上游路径两道闸：拼 URL 之前的原始 path 只允许这组字符，归一化后的 pathname 还得对得上前缀 */
const SAFE_PATH_SEG_RE = /^[a-z0-9/_-]+$/i;
const UPSTREAM_PATH_RE = /^\/weapi\/[a-z0-9/_-]+$/i;

/** 取 Host 的比较键：IPv6 保留 [..] 形式，其余砍掉端口 */
function hostKey(host) {
  const h = String(host || '').toLowerCase().trim();
  if (!h) return '';
  return h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.split(':')[0];
}

/** Host 是否被接受。hostSet 由调用方传（server.js 那边是 5 秒实时网卡缓存） */
function hostIsAllowed(host, hostSet) {
  const raw = String(host || '').toLowerCase().trim();
  if (!raw) return false;
  const set = hostSet || LOCAL_HOST_NAMES;
  if (set.has(raw)) return true;
  const bare = hostKey(raw);
  if (set.has(bare)) return true;
  return MDNS_HOST_RE.test(bare);
}

/**
 * 请求的 Host 头是否在白名单里（DNS rebinding 就挡在这里）。
 * HTTP/1.1 必须有 Host，空 Host 一律拒。
 */
function hostAllowed(req, hostSet) {
  const raw = String((req && req.headers && req.headers.host) || '').toLowerCase().trim();
  if (!raw) return false;
  return hostIsAllowed(raw, hostSet);
}

/**
 * 把 candidate（Origin / Referer）与白名单比对。
 *
 * 关键点：
 *  ① 不能只拿 Host 跟 Origin 互相比对 —— 两者都是客户端可控的，
 *    把 evil.example.com 解析到 127.0.0.1 就能让两者相等（B-3）；
 *  ② 所以先把 candidate 的 host 过一遍与请求 Host **同一套**白名单（含 .local，
 *    这是 S-01 的修复点：以前这里另有一套精确集合，.local 页面签得出令牌却打不了 API）；
 *  ③ 再要求它与本次请求的 Host 完全一致 —— 同一个服务同时被 localhost 与网卡 IP
 *    访问时，Origin 指向另一个地址也算跨源，不该放行。
 */
function hostMatches(req, candidate, hostSet) {
  if (!candidate) return false;
  try {
    const u = new URL(candidate);
    const host = String(u.host || '').toLowerCase();
    if (!hostIsAllowed(host, hostSet)) return false;
    const reqHost = String((req && req.headers && req.headers.host) || '').toLowerCase();
    return !!reqHost && host === reqHost;
  } catch (e) {
    return false;
  }
}

/**
 * 同源判定。
 * 有 Origin 就比 Origin 与 Host；
 * 没有 Origin 时不再直接放行（那是旧漏洞：curl 不带 Origin 即可打 /ncm/*），
 * 只接受 Sec-Fetch-Site 为 same-origin / none —— 前者是同源 fetch，
 * 后者是用户在地址栏直接打开，两者都不是「别的站点发起的跨站请求」。
 */
function originAllowed(req, hostSet) {
  const h = (req && req.headers) || {};
  const org = h.origin;
  if (org) return hostMatches(req, org, hostSet);
  const site = String(h['sec-fetch-site'] || '').toLowerCase();
  return site === 'same-origin' || site === 'none';
}

/**
 * 「浏览器信号」判定：这一层挡的是**盲发**的跨站请求，不是「无头请求一律 403」。
 *
 * 看清楚它的边界（S-02）：Sec-Fetch-* 对浏览器是强制头、网页 JS 改不了，
 * 所以它能挡住「别的网站偷偷 fetch 你的 /ripple-token.js」；
 * 但同机上能执行程序的人可以随便伪造这些头（实测同时带 same-origin + no-cors
 * 就能签出令牌）—— 那不是这一层能解决的，真正的约束是令牌的 TTL + IP 绑定 + 轮换，
 * 以及「同机程序本来就能读你的 cookie」这个前提（见 SECURITY.md 的威胁模型）。
 */
function browserSignalOk(req, hostSet) {
  const h = (req && req.headers) || {};
  const site = String(h['sec-fetch-site'] || '').toLowerCase();
  const mode = String(h['sec-fetch-mode'] || '').toLowerCase();
  const sameOriginRef = hostMatches(req, h.origin, hostSet) || hostMatches(req, h.referer, hostSet);
  /* 三者全无 —— 既不是浏览器导航/子资源加载，也没有来源，拒绝 */
  if (!site && !mode && !sameOriginRef) return false;
  /* 有 Sec-Fetch-Site 就必须是 same-origin（cross-site/same-site 都不行） */
  if (site && site !== 'same-origin') return false;
  /* Sec-Fetch-Mode 的取值是浏览器定的；不在这些值里说明是伪造的杂值 */
  if (mode && mode !== 'navigate' && mode !== 'no-cors' && mode !== 'cors') return false;
  /* <script src> 加载是 no-cors，地址栏直开是 navigate；两者都不看来源 */
  if (mode === 'no-cors' || mode === 'cors' || mode === 'navigate') return true;
  return sameOriginRef;
}

/** loopback 的 IPv4 映射写法会以 ::ffff: 前缀出现，统一成同一个键 */
function normIp(ip) {
  /* 先转小写再去前缀：::FFFF:127.0.0.1 这种大写写法的 socker 地址也见过，不归一就会
     让「签发时是一个键、校验时是另一个键」，表现为令牌莫名失效 */
  return String(ip || '').toLowerCase().replace(/^::ffff:/, '') || 'unknown';
}

/** 丢掉过期令牌；没变化就原样返回（调用方据此决定要不要写盘） */
function pruneTokens(list, now) {
  const src = Array.isArray(list) ? list : [];
  const keep = src.filter((e) => e && e.t && now < e.exp);
  return keep.length === src.length ? src : keep;
}

/**
 * 令牌是否有效：必须存在、未过期、且来源 IP 与签发时一致。
 *
 * 令牌本身是 128 位随机值，用普通比较即可：猜中的概率与穷举相同。
 * now 可传，测试才能构造「刚好过期」这种边界，不用 sleep。
 */
function tokenValid(list, got, ip, now) {
  const v = String(got || '');
  if (!v) return false;
  const me = normIp(ip);
  const at = Number.isFinite(now) ? now : Date.now();
  return (Array.isArray(list) ? list : [])
    .some((e) => e && e.t === v && e.ip === me && at < e.exp);
}

/**
 * E-18：参数校验错误统一构造。
 * 以前只靠错误信息前缀正则判断「是不是客户端的问题」，漏一条就变成 502（上游失败）。
 * 现在改成带 err.badRequest = true 标记，错误处理优先看这个标记。
 * 正则兜底仍然保留（兼容历史上直接 throw new Error 的路径）。
 */
function badRequest(msg) {
  const e = new Error(msg);
  e.badRequest = true;
  return e;
}

/**
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
function assertUpstreamPath(rawPath, url) {
  if (typeof rawPath !== 'string' || !SAFE_PATH_SEG_RE.test(rawPath) || rawPath.includes('..')) {
    throw badRequest('bad upstream path');
  }
  const p = url && url.pathname;
  if (typeof p !== 'string' || p.includes('..') || !UPSTREAM_PATH_RE.test(p)) {
    throw badRequest('bad upstream path: ' + p);
  }
}

/**
 * 令牌有效期的人话。
 * TTL 可以用 RIPPLE_TOKEN_TTL_MS 调到 10 秒（调试用），
 * 这时按分钟四舍五入会印出「有效期 0 分钟」—— 所以小于 1 分钟按秒显示。
 */
function formatTtl(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '0 秒';
  if (n < 60 * 1000) return Math.round(n / 1000) + ' 秒';
  return Math.round(n / (60 * 1000)) + ' 分钟';
}

module.exports = {
  LOCAL_HOST_NAMES,
  hostKey,
  hostIsAllowed,
  hostAllowed,
  hostMatches,
  originAllowed,
  browserSignalOk,
  normIp,
  pruneTokens,
  tokenValid,
  badRequest,
  assertUpstreamPath,
  formatTtl,
};
