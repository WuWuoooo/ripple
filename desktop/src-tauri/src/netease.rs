//! 网易云 API 客户端 —— 与 `android/.../NeteaseClient.java`、`server.js` 的命令表
//! 和参数口径逐条对齐。
//!
//! # 为什么三端必须有同一个命令表
//!
//! 前端 `app/js/netease.js` 只认 20 个命令名（status / search / song_url / ...），
//! 三端各实现一份。任何一端的参数口径漂了，就表现为「APK 能播、桌面端播不了」
//! 这类难查的差异。所以这里的每个 `match` 分支都标了对应的 Java/server.js 行，
//! 改一处必须三处同改。
//!
//! # 登录态
//!
//! 与 Java 侧一致，用 cookie 字符串持久化（`MUSIC_U` / `__csrf` 等）。
//! 桌面端落在应用配置目录，权限 0600（Windows 上没有 POSIX 权限位，退化到
//! 「用户 profile 目录本身即隔离」）。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;

use crate::i18n;
use crate::weapi;

const HOST: &str = "https://music.163.com";

/// 与 Java `NeteaseClient.java` 和 `server.js` 完全相同的 UA。
///
/// 网易云会按 UA 判断客户端类型；UA 不一致时部分接口（尤其 song_url）
/// 返回的可用音质档位会不同。
const UA: &str =
    "Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) \
                  Chrome/124.0.0.0 Mobile Safari/537.36";

/*
 * ================= 为什么 Client 不再需要「一把大锁」=================
 *
 * 1.3.9 之前的形状是 Arc<Mutex<Client>>，调用方 client.lock() 把**整条
 * 网络请求**包在锁里。当时这么写是为了 cookie_jar 不被并发写坏，但它把
 * 「数据竞争」和「并发度」绑在一起了 —— 代价是整个进程只剩一条网络通道。
 *
 * 这个代价有多大，本地实测过（不是推测）：
 *   单次 song_url 0.13s；8 条请求经那把锁串行 = 0.92s（几乎等于逐条相加）。
 *   桌面端一进首页就会并发发起十几条命令（每日推荐 / 推荐歌单 / 排行榜 /
 *   账号 status / 续播解析 …）。**网络正常时**排队几十毫秒，看不出来；
 *   而用户网络稍差、单条要 3~5 秒时，十条排队就是 30~50 秒 ——
 *   前端的 song_url 预算只有 25 秒，于是必然打出「请求超时（song_url）」。
 *
 * 这就是 Windows 用户「一首歌都播不了」的真实原因：**不是请求失败，
 * 是请求根本没机会发出去**。日志里看到的超时是排队超时，不是网络超时，
 * 两者在旧实现下长得一模一样，所以之前几轮都在猜网络。
 *
 * 现在的分法：
 *   · http —— reqwest 的 blocking Client 本身是 Clone 且线程安全的，
 *     多条请求可真正并发（内部单个 runtime 线程多路复用，不是串行）；
 *   · cookie —— 只有它需要互斥，且锁的临界区缩到「读一份快照」
 *     和「合并几条 Set-Cookie」这两段纯内存操作，**绝不包住网络 IO**。
 * 于是 Client 变成廉价可 Clone 的值类型：每个 worker 拿一份自己的副本，
 * 共享同一份 cookie，彼此不再排队。
 */
#[derive(Clone)]
pub struct Client {
    http: reqwest::blocking::Client,
    /// cookie 是**唯一**需要跨线程共享的可变状态。用 Arc<Mutex<..>> 单独锁，
    /// 而不是把整个 Client 塞进 Mutex —— 后者会让网络请求互相排队（见上）。
    cookie: Arc<Mutex<CookieJar>>,
    cookie_path: Arc<PathBuf>,
}

/// cookie 串的唯一持有者。
///
/// 单独成一个结构体而不是裸 String：合并 Set-Cookie 的规则（值的
/// deleted/null 视作删除、同名覆盖）需要专门测，抽出来才能被测到；
/// 裸 String 的话这段逻辑散在 post() 里，只能靠整条命令跑一遍才知道对不对。
#[derive(Default)]
struct CookieJar {
    raw: String,
}

impl CookieJar {
    /// 解析成 (k, v) 对。空 key 丢弃 —— 与 server.js 的口径一致。
    fn pairs(&self) -> Vec<(String, String)> {
        self.raw
            .split(';')
            .filter_map(|p| {
                let p = p.trim();
                let (k, v) = p.split_once('=')?;
                if k.is_empty() {
                    None
                } else {
                    Some((k.to_string(), v.to_string()))
                }
            })
            .collect()
    }

    /// 原始串快照（拼请求头用）。
    fn raw(&self) -> String {
        self.raw.clone()
    }

    /// 把一批 Set-Cookie 行合并进 jar。
    ///
    /// 返回值：合并后内容是否真的有变化（没变就不用落盘）。
    /// 值形如 deleted / null / 空的按「删除」处理 —— 网易云退出登录就是用
    /// Set-Cookie: MUSIC_U=deleted 表达的，当成普通值存下来的话下次启动
    /// 会以为自己还登录着。
    ///
    /// ===== 为什么同名键要**就地替换**而不是「删掉再追加」=====
    ///
    /// 后果不只是顺序难看了：删掉再追加会把那个键挪到末尾，于是
    /// 「同一个值重复下发」也会被判定成内容有变化 → 触发 save_cookie()。
    /// 而网易云**几乎每个响应都带 Set-Cookie**（漏一次就掉登录，所以它很勤快），
    /// 等于每条请求都白做两次文件系统操作：写 tmp + rename。
    ///
    /// 这是 crypto_merge_reports_unchanged 那条单测抓出来的 ——
    /// 重构时这段是从 post() 里原样搬过来的，肉眼看着没毛病。
    fn merge(&mut self, lines: &[String]) -> bool {
        if lines.is_empty() {
            return false;
        }
        let before = self.raw.clone();
        let mut jar = self.pairs();
        for line in lines {
            let pair = line.split(';').next().unwrap_or("").trim();
            let Some((k, v)) = pair.split_once('=') else {
                continue;
            };
            if k.is_empty() {
                continue;
            }
            let deleted =
                v.is_empty() || v.eq_ignore_ascii_case("deleted") || v.eq_ignore_ascii_case("null");
            match jar.iter_mut().find(|(jk, _)| jk == k) {
                Some(slot) if deleted => {
                    /* 就地标成待删，循环结束后统一移除，避免边遍历边删 */
                    slot.0.clear();
                }
                Some(slot) => slot.1 = v.to_string(),
                None if !deleted => jar.push((k.to_string(), v.to_string())),
                None => {}
            }
        }
        jar.retain(|(k, _)| !k.is_empty());
        self.raw = jar
            .into_iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join("; ");
        self.raw != before
    }
}

/// 上游路径白名单（D-07，1.3.4）。
///
/// 为什么抽成独立函数：
///   以前这段判据是**内联在 Client::post 里**的，而单元测试又自己重写了一遍
///   同样逻辑 —— 两边口径还不一致：测试要求「全部小写、不许 ? = &」，
///   而生产实现允许大写（`R_SO_4_` 这种接口名）和查询串。
///   结果是：删掉生产里的 `..` 检查，测试照样全绿（它测的是自己那份副本），
///   而合法请求在测试语境下反而被判成非法 —— 一个永远抓不到真 bug 的测试。
///
/// 现在两边共用这一份实现，测试才真正覆盖生产逻辑。
///
/// 允许的字符：A-Z a-z 0-9 / _ - . ? = &
///   · 大写字母是刚需（`v1/resource/comments/R_SO_4_<id>`）
///   · `. ? = &` 给带查询串的路径留口子（Java 侧本来就允许）
///   拒绝 `..`：防路径穿越，这是这条白名单存在的真正原因。
fn is_safe_upstream_path(path: &str) -> Result<(), String> {
    if path.is_empty()
        || path.contains("..")
        || !path.chars().all(|c| {
            c.is_ascii_alphanumeric()
                || c == '/'
                || c == '_'
                || c == '-'
                || c == '.'
                || c == '?'
                || c == '='
                || c == '&'
        })
    {
        return Err(i18n::tf(
            "非法上游路径：{path}",
            "Invalid upstream path: {path}",
            &[("path", path.to_string())],
        ));
    }
    Ok(())
}

impl Client {
    pub fn new(data_dir: &Path) -> Result<Self, String> {
        fs::create_dir_all(data_dir).map_err(|e| {
            i18n::tf(
                "创建配置目录失败：{e}",
                "Failed to create config dir: {e}",
                &[("e", e.to_string())],
            )
        })?;
        let cookie_path = data_dir.join("netease-cookie");
        let cookie_jar = fs::read_to_string(&cookie_path).unwrap_or_default();

        /*
         * 1.3.9：单请求超时从 25s 收紧到 12s，并单独给连接阶段一个更短的超时。
         *
         * 原来「一个超时 25 秒」+「status 内部串行 4 次」= 最坏 100 秒占住
         * 一个 worker。而工作池只有 2 个线程（现已扩到 8），网络差的时候
         * 几条这样的请求就能让整个 IPC 通道排队 —— 用户看到的是
         * 「所有请求都超时」+「顶栏按钮点了没反应」。
         *
         * 12 秒的依据：前端 song_url 的超时是 25 秒、status 是 60 秒，
         * 单次要留出「重试一次」的余量；同时 `connect_timeout` 单独设 6 秒 ——
         * 连不上和连上了没响应是两种故障，前者应该很快失败，
         * 不要把 12 秒耗在等 TCP 握手/代理上。
         */
        let http = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(12))
            .connect_timeout(Duration::from_secs(6))
            .user_agent(UA)
            .gzip(true)
            .build()
            .map_err(|e| {
                i18n::tf(
                    "HTTP 客户端初始化失败：{e}",
                    "Failed to init HTTP client: {e}",
                    &[("e", e.to_string())],
                )
            })?;

        Ok(Self {
            http,
            cookie: Arc::new(Mutex::new(CookieJar { raw: cookie_jar })),
            cookie_path: Arc::new(cookie_path),
        })
    }

    /// 落盘 cookie。
    ///
    /// 与 `server.js` 的 R-14 整改一致：先写临时文件再 rename，
    /// 避免进程在写一半时被杀留下半截 cookie（下次启动就是「莫名掉登录」）。
    /// 落盘 cookie。
    ///
    /// 审查 D-07：改成 `pub` 以便 main.rs 在 `RunEvent::Exit` 里兜底调一次
    /// （原来那个分支是空的，只有注释说「这里只是兜底」）。
    pub fn save_cookie(&self) {
        /*
         * 先把 cookie 快照出来，**在锁外**做文件 IO。
         *
         * 锁的临界区只该覆盖「读这几百字节字符串」——把 fs::write + rename
         * 包在锁里没有任何正确性收益（写盘的是快照，不是共享状态本体），
         * 却会让一次慢盘（机械盘 / 杀软扫描 / 网络盘）卡住所有请求。
         */
        let snap = match self.cookie.lock() {
            Ok(g) => g.raw(),
            Err(e) => e.into_inner().raw(),
        };
        let path: &std::path::Path = self.cookie_path.as_path();
        let tmp = path.with_extension("tmp");
        let ok = fs::write(&tmp, &snap).is_ok() && fs::rename(&tmp, path).is_ok();
        if !ok {
            let _ = fs::remove_file(&tmp);
        }
        // POSIX 上收紧权限；Windows 会失败，忽略即可
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
        }
    }

    fn csrf(&self) -> String {
        weapi::csrf(&self.cookie_snapshot())
    }

    /// 取一份 cookie 串快照。
    ///
    /// 锁只包住「克隆一个 String」这一步 —— 调用的地方（拼请求头、算 csrf）
    /// 全都在锁外。这样即使有 8 条请求同时在飞，它们也只在这几百纳秒里
    /// 争一下锁，而不是整条网络请求都在排队。
    fn cookie_snapshot(&self) -> String {
        match self.cookie.lock() {
            Ok(g) => g.raw(),
            /* poison 不该让整个网络层停摆：cookie 是纯数据，没有「一半无效」的中间态，
            取回内部值继续用即可（与 worker 池里 catch_unwind 的取向一致）。 */
            Err(e) => e.into_inner().raw(),
        }
    }

    /// 发一条 weapi 请求，返回原始响应文本。
    ///
    /// 与 Java / Node 两侧完全一致：
    ///   POST https://music.163.com/weapi/<path>?csrf_token=<csrf>
    ///   Header: Referer / Origin 都是 music.163.com，Cookie 带 os=android 前缀。
    /// 那个 `os=android` 不是装饰：不带它时 song_url 给的部分音质档会被降级。
    fn post(&self, path: &str, body: Value) -> Result<String, String> {
        /*
         * 上游路径白名单。
         *
         * 与 Android 的 `NeteaseClient.assertSafePath` 保持**同一套字符集** ——
         * 两端各写一份最容易在这里漂移。这里之前只允许小写字母，
         * 而 comments 的路径是 `v1/resource/comments/R_SO_4_<id>`，
         * 里面有大写的 `R_SO`，于是「评论」在桌面端直接报「非法上游路径」。
         *
         * 允许的字符：A-Z a-z 0-9 / _ - . ? = &
         *   · 大写字母是刚需（R_SO_4_ 这种接口名）
         *   · . ? = & 给带查询串的路径留口子（Java 侧本来就允许）
         * 拒绝 `..`：防路径穿越，这是这条白名单存在的真正原因。
         */
        if let Err(e) = is_safe_upstream_path(path) {
            return Err(e);
        }

        let form = weapi::form(&body.to_string());
        let url = format!(
            "{HOST}/weapi/{path}?csrf_token={}",
            weapi::url_encode(&self.csrf())
        );
        /*
         * ⚠️ 这里必须在 post() 开头取一次快照，**不能在锁里发请求**。
         * 快照点比理想值早了一点点（理论上并发写 cookie 的那一瞬间，这条请求
         * 可能用的是上一份 csrf/cookie），但代价可以忽略：Set-Cookie 只在下单、
         * 登录、退出这类写操作上出现，而这些命令本身就不会和读请求抢同一个
         * 时序窗口；反过来若为了让两者严格同步而把 http.send() 包进锁，
         * 就又回到「全进程一条网络通道」那个要命的形状了。
         */
        let cookie = format!(
            "os=android; appver=8.9.70; osver=13; {}",
            self.cookie_snapshot()
        );

        let res = self
            .http
            .post(&url)
            .header("Referer", "https://music.163.com/")
            .header("Origin", "https://music.163.com")
            .header("Content-Type", "application/x-www-form-urlencoded")
            .header("Accept", "*/*")
            .header("Cookie", cookie)
            .body(form)
            .send()
            .map_err(|e| {
                i18n::tf(
                    "请求失败（{path}）：{e}",
                    "Request failed ({path}): {e}",
                    &[("path", path.to_string()), ("e", e.to_string())],
                )
            })?;

        /*
         * 并发请求会同时收到 Set-Cookie，所以合并这一步必须加锁 ——
         * 但锁的临界区只有上面那几十行纯内存操作，**不含网络 IO**。
         * 机制细节（deleted/null 视作删除、同名覆盖）在 CookieJar::merge 里，
         * 那份实现有独立单测，不再靠「跑通一整条命令」来间接验证。
         */
        let set_cookies: Vec<String> = res
            .headers()
            .get_all(reqwest::header::SET_COOKIE)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .map(|s| s.to_string())
            .collect();
        if !set_cookies.is_empty() {
            let changed = match self.cookie.lock() {
                Ok(mut g) => g.merge(&set_cookies),
                /* 锁被污染：cookie 是纯数据，取回内部值继续用 */
                Err(e) => e.into_inner().merge(&set_cookies),
            };
            /* 内容没变就不写盘 —— 网易云几乎每个响应都带 Set-Cookie，
            无条件 save_cookie() 等于每次请求都做两次文件系统操作。 */
            if changed {
                self.save_cookie();
            }
        }

        if !res.status().is_success() {
            return Err(i18n::tf(
                "上游返回 HTTP {code}",
                "Upstream returned HTTP {code}",
                &[("code", res.status().as_u16().to_string())],
            ));
        }
        res.text().map_err(|e| {
            i18n::tf(
                "读取响应失败：{e}",
                "Failed to read response: {e}",
                &[("e", e.to_string())],
            )
        })
    }

    /// 命令分发 —— 20 个命令与 Java / Node 两侧一一对应。
    ///
    /// `params` 是前端传的 JSON 对象；返回的字符串会被前端 `JSON.parse`，
    /// 所以**必须**是合法 JSON（哪怕出错也要回 `{"code":...}`）。
    pub fn call(&self, cmd: &str, params: &Value) -> Result<String, String> {
        let p = params;
        let s = |k: &str| -> String {
            p.get(k)
                .and_then(|v| match v {
                    Value::String(s) => Some(s.clone()),
                    Value::Number(n) => Some(n.to_string()),
                    _ => None,
                })
                .unwrap_or_default()
        };
        let i = |k: &str, d: i64| -> i64 { p.get(k).and_then(Value::as_i64).unwrap_or(d) };

        match cmd {
            // 与 server.js:case 'status' 一致：先查账号，拿到 profile 再补
            // vip / level / like 三个额外的块（前端 N.status() 依赖 _extra）
            "status" => {
                let r = self.post("w/nuser/account/get", Value::Object(Default::default()))?;
                if !self.cookie_snapshot().contains("MUSIC_U=") {
                    return Ok(r);
                }
                let mut acc: Value = serde_json::from_str(&r).unwrap_or(Value::Null);
                let uid = acc
                    .get("profile")
                    .and_then(|x| x.get("userId"))
                    .and_then(Value::as_i64);
                if let Some(uid) = uid {
                    let mut extra = serde_json::Map::new();
                    if let Ok(v) = self.post("vip/info/v2", Value::Object(Default::default())) {
                        extra.insert("vip".into(), serde_json::from_str(&v).unwrap_or(Value::Null));
                    }
                    if let Ok(v) = self.post("user/level", Value::Object(Default::default())) {
                        extra.insert("level".into(), serde_json::from_str(&v).unwrap_or(Value::Null));
                    }
                    if let Ok(v) = self.post("song/like/get", serde_json::json!({ "uid": uid.to_string() })) {
                        extra.insert("like".into(), serde_json::from_str(&v).unwrap_or(Value::Null));
                    }
                    if let Value::Object(ref mut m) = acc {
                        m.insert("_extra".into(), Value::Object(extra));
                    }
                }
                Ok(acc.to_string())
            }

            /*
             * 二维码登录（桌面端专属）。
             *
             * 为什么桌面端需要它：手机端的登录是「内嵌 WebView 打开官方页面」，
             * 桌面端如果照搬就要在 Tauri 里再套一个 webview，代价高且体验怪。
             * 网易云的二维码登录是**纯 HTTP 接口**，不需要浏览器参与：
             *   1. login_qr_key   → 拿到一个 unikey
             *   2. 前端把 unikey 画成二维码，用户用手机网易云 App 扫
             *   3. login_qr_check → 轮询状态（801 等待 / 802 待确认 / 803 成功）
             * 成功时上游下发 MUSIC_U，我们像普通请求一样收进 cookie jar 即可。
             *
             * 这两条命令 Java 端也有（登录页内部会用到），但前端 `app/js/netease.js`
             * 目前没有调用它们 —— 桌面端是我们第一个真实消费者。
             */
            "login_qr_key" => self.post(
                "login/qrcode/unikey",
                serde_json::json!({ "type": 3 }),
            ),

            "login_qr_check" => self.post(
                "login/qrcode/client/login",
                serde_json::json!({ "key": s("key"), "type": 3 }),
            ),

            // 与 NeteaseClient.java:174-184 一致：必须先带上当前 cookie 请求上游
            // logout，让服务端会话真正失效，之后再清本地 jar。反过来就是
            // 「界面显示已退出，但那个 MUSIC_U 在服务端依然有效」。
            "logout" => {
                let r = self.post("logout", Value::Object(Default::default())).unwrap_or_default();
                /*
                 * 清空也要走同一把锁：直接改 raw 会和并发的 merge() 打架，
                 * 结果是「刚退出登录，另一个请求的 Set-Cookie 又把 MUSIC_U 写回去」，
                 * 用户看到的是退出后过一会儿又自动登录了。
                 */
                match self.cookie.lock() {
                    Ok(mut g) => g.raw.clear(),
                    Err(e) => e.into_inner().raw.clear(),
                }
                self.save_cookie();
                if r.is_empty() { Ok(r#"{"code":200}"#.to_string()) } else { Ok(r) }
            }

            "search" => {
                let body = serde_json::json!({
                    "s": s("keywords"),
                    "type": i("type", 1),
                    "limit": i("limit", 30),
                    "offset": i("offset", 0),
                    "total": true,
                });
                let r = self.post("cloudsearch/pc", body)?;
                /*
                 * E-15 + H-4（审查报告，1.3.8）：回落老接口的判据必须与
                 * server.js / NeteaseClient.java **完全同口径** ——
                 *   有 result.songs  **或**  code == 200  → 信任这次云搜索的结果，不回落；
                 *   两者都不成立                            → 才回落 search/get。
                 *
                 * 为什么 code == 200 这一半不能少（H-4 的实质）：
                 * 上游最常见的限流形态是 {"result":{},"code":200} ——
                 * 即 HTTP 与业务码都成功、只是结果为空。
                 *   · Java（NeteaseClient.java）与 Node（server.js）：has=false 但
                 *     code==200 → **不回落** → 前端拿到空结果；
                 *   · 本文件以前只判 has → **回落** → 多打一次 search/get，
                 *     返回一批**不一样**的数据。
                 * 后果就是同一时刻、同一账号、同一关键词，APK/网页版给空结果、
                 * 桌面端给另一批搜索结果；而且限流时多打一次请求
                 * 更容易被二次风控。
                 *
                 * 以前这里注释已经写着「且 code != 200」，但代码只抄了前半句 ——
                 * 注释与实现不符比没注释更危险（下一个人会以为已经修好了）。
                 * 现在把两个量一起算出来，判据写在一行里，注释与代码不可能再漂。
                 */
                let (has, code) = serde_json::from_str::<Value>(&r)
                    .ok()
                    .map(|v| {
                        let has = v.get("result").and_then(|x| x.get("songs")).is_some();
                        /* code 缺失按 200 处理：与 Java 的 j.optInt("code", 200)、
                        Node 的 typeof j.code === 'number' ? j.code : 200 一致。 */
                        let code = v.get("code").and_then(Value::as_i64).unwrap_or(200);
                        (has, code)
                    })
                    /*
                     * 响应根本不是合法 JSON —— 与「code 缺失」是两件事，不能混：
                     *   · code 缺失但 JSON 合法 → 按 200（与 Java 的 optInt 默认值、
                     *     Node 的 typeof 判定一致，见上一段）；
                     *   · 整段不是 JSON → 拿不到任何可用结果，按「既不 has 也不是 200」
                     *     处理 → 走回落老接口，多试一条可能还能给用户结果。
                     * 这里刻意**不**照抄 Java：那边 JSON 解析失败会直接抛异常、
                     * 整条命令失败；而桌面端回落到 search/get 仍有机会成功，
                     * 对用户更有用。差异点写在这里，避免以后有人以为是抄漏了。
                     */
                    .unwrap_or((false, 0));
                if has || code == 200 {
                    return Ok(r);
                }
                let old = self.post(
                    "search/get",
                    serde_json::json!({
                        "s": s("keywords"),
                        "type": i("type", 1),
                        "limit": i("limit", 30),
                        "offset": i("offset", 0),
                        "total": true,
                    }),
                )?;
                Ok(old)
            }

            "song_detail" => {
                // 与 server.js:619 和 NeteaseClient 一致：上游参数名是 `c`，
                // 形如 [{"id":1},{"id":2}]（不是 ids）。ids 必须是非空数字逗号串 ——
                // 传 "abc" 会构造出 [{"id":null}]，既查不到也看不出是谁的错。
                let raw = s("ids");
                let mut items = Vec::new();
                for part in raw.split(',') {
                    let t = part.trim();
                    if t.is_empty() {
                        continue;
                    }
                    if !t.bytes().all(|b| b.is_ascii_digit()) {
                        return Err(i18n::t("song_detail: ids 必须是数字逗号串",
                            "song_detail: ids must be a comma-separated list of numbers").into());
                    }
                    items.push(format!("{{\"id\":{t}}}"));
                }
                if items.is_empty() {
                    return Err(i18n::t("song_detail: ids 不能为空",
                            "song_detail: ids must not be empty").into());
                }
                self.post(
                    "v3/song/detail",
                    serde_json::json!({ "c": format!("[{}]", items.join(",")) }),
                )
            }

            "song_url" => {
                self.post(
                    "song/enhance/player/url/v1",
                    serde_json::json!({
                        "ids": format!("[{}]", s("id")),
                        "level": or_default(&s("level"), "exhigh"),
                        "encodeType": "flac",
                    }),
                )
            }

            "lyric" => self.post(
                "song/lyric",
                serde_json::json!({ "id": s("id"), "tv": -1, "lv": -1, "rv": -1, "kv": -1, "_nmclfl": 1 }),
            ),

            "playlist" => self.post(
                "v6/playlist/detail",
                serde_json::json!({ "id": s("id"), "n": 300, "s": 8 }),
            ),

            "playlist_tracks" => {
                // E-16：与 Java:366-383 对齐 —— 上游只取 n=300 条 trackIds，
                // 页内按 offset/limit 取窗口（limit 默认 200，收敛到 1..1000）
                let detail: Value = serde_json::from_str(
                    &self.post("v6/playlist/detail", serde_json::json!({ "id": s("id"), "n": 300, "s": 8 }))?,
                )
                .map_err(|e| {
                    i18n::tf(
                        "歌单详情不是 JSON：{e}",
                        "Playlist detail is not JSON: {e}",
                        &[("e", e.to_string())],
                    )
                })?;
                let all: Vec<i64> = detail
                    .get("playlist")
                    .and_then(|x| x.get("trackIds"))
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(|x| x.get("id").and_then(Value::as_i64)).collect())
                    .unwrap_or_default();
                let offset = i("offset", 0).max(0) as usize;
                let limit = i("limit", 200).clamp(1, 1000) as usize;
                let window: Vec<i64> = all.iter().skip(offset).take(limit).copied().collect();
                if window.is_empty() {
                    return Ok(r#"{"code":200,"songs":[]}"#.to_string());
                }
                let ids = window.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(",");
                let body = serde_json::json!({
                    "c": format!("[{}]", window.iter().map(|x| format!("{{\"id\":{x}}}")).collect::<Vec<_>>().join(",")),
                    "ids": format!("[{ids}]"),
                });
                self.post("v3/song/detail", body)
            }

            "toplist" => self.post("toplist", Value::Object(Default::default())),

            "recommend" => {
                // 与 server.js:667 和 NeteaseClient.java:345 一致：
                // 先打推荐歌曲，未登录或上游回 301 时回落到 personalized/newsong
                let r = self.post("v3/discovery/recommend/songs", Value::Object(Default::default()))?;
                if !self.cookie_snapshot().contains("MUSIC_U=") || r.contains("\"code\":301") {
                    return self.post(
                        "personalized/newsong",
                        serde_json::json!({ "limit": 30 }),
                    );
                }
                Ok(r)
            }

            "likelist" => self.post(
                "song/like/get",
                serde_json::json!({ "uid": s("uid") }),
            ),

            // 与 server.js:676 和 NeteaseClient.java:368 一致：走 song/like，
            // 参数是 trackId + userid + like（不是 radio/like，也不是 id）
            "like" => self.post(
                "song/like",
                serde_json::json!({
                    "trackId": s("id"),
                    "userid": s("uid"),
                    "like": p.get("like").and_then(Value::as_bool).unwrap_or(true),
                }),
            ),

            "user_playlist" => self.post(
                "user/playlist",
                serde_json::json!({
                    "uid": s("uid"), "limit": i("limit", 100), "offset": i("offset", 0),
                    "includeVideo": true,
                }),
            ),

            "personalized" => self.post(
                "personalized/playlist",
                serde_json::json!({ "limit": i("limit", 12), "total": true, "n": 1000 }),
            ),

            "hot_search" => self.post("search/hot/detail", Value::Object(Default::default())),

            "heart_mode" => self.post(
                "playmode/intelligence/list",
                serde_json::json!({
                    "songId": s("songId"),
                    "type": "fromPlayOne",
                    "playlistId": or_default(&s("playlistId"), "0"),
                    "startMusicId": or_default(&s("startMusicId"), &s("songId")),
                    "count": i("count", 20),
                }),
            ),

            "simi_song" => self.post(
                "v1/discovery/simiSong",
                serde_json::json!({
                    "songid": s("songId"), "limit": i("limit", 20), "offset": i("offset", 0),
                }),
            ),

            "comment_add" => {
                // 与 server.js:695 一致：id 会拼进上游路径，只允许纯数字；
                // 内容去空白、非空、≤140 字。抛错而不是回 code:-1，
                // 让前端能区分「参数不合法」和「上游失败」。
                let cid = s("id");
                if cid.is_empty() || !cid.bytes().all(|b| b.is_ascii_digit()) {
                    return Err(i18n::t("comment_add: id 必须是数字",
                            "comment_add: id must be numeric").into());
                }
                let txt = s("content").trim().to_string();
                if txt.is_empty() {
                    return Err(i18n::t("comment_add: 内容不能为空",
                            "comment_add: content must not be empty").into());
                }
                if txt.chars().count() > 140 {
                    return Err(i18n::t("comment_add: 最多 140 字",
                            "comment_add: at most 140 characters").into());
                }
                self.post(
                    "v1/resource/comments/add",
                    serde_json::json!({ "threadId": format!("R_SO_4_{cid}"), "content": txt }),
                )
            }

            "comments" => {
                // id 要拼进上游 URL 路径，只允许纯数字 —— 否则
                // `x/../../../../user/level` 能靠 WHATWG URL 的 .. 归一化跳出白名单。
                let cid = s("id");
                if cid.is_empty() || !cid.bytes().all(|b| b.is_ascii_digit()) {
                    return Err(i18n::t("comments: id 必须是数字",
                            "comments: id must be numeric").into());
                }
                let path = format!("v1/resource/comments/R_SO_4_{cid}");
                self.post(
                    &path,
                    serde_json::json!({
                        "rid": cid,
                        "limit": i("limit", 20),
                        "offset": i("offset", 0),
                        "beforeTime": i("before", 0),
                    }),
                )
            }

            "personal_fm" => self.post("v1/radio/get", Value::Object(Default::default())),

            other => Err(i18n::tf("未知命令：{other}", "Unknown command: {other}", &[("other", other.to_string())])),
        }
    }
}

fn or_default(v: &str, d: &str) -> String {
    if v.is_empty() {
        d.to_string()
    } else {
        v.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upstream_path_whitelist_rejects_traversal() {
        /*
         * D-07（审查报告，1.3.4）：这个测试以前**自己重写了一套判据**，
         * 不调用生产实现，而且口径与生产相反 ——
         * 它要求「全部小写、不许 ? = &」，把合法的大写接口名和查询串判成非法。
         * 后果：删掉生产里的 `..` 检查，这个测试照样绿。
         *
         * 现在直接调 `is_safe_upstream_path`（生产用的同一份实现），
         * 这样改坏生产代码测试一定会红。
         */
        let bad = [
            "",
            "../user/level",
            "v1/user/../../etc/passwd",
            "a%2e%2e/b",
            "a\\b",
            "a#frag",
            "a;drop",
            "中文/路径",
            "a b",
        ];
        for b in bad {
            assert!(
                is_safe_upstream_path(b).is_err(),
                "路径 {b:?} 不该通过白名单"
            );
        }

        let good = [
            "w/nuser/account/get",
            "v3/song/detail",
            "song/enhance/player/url/v1",
            /* 大写是刚需：评论接口的路径就是这个形状 */
            "v1/resource/comments/R_SO_4_123456",
            /* 查询串：Java 侧本来就允许 */
            "v1/search/get?type=1&limit=30",
            /* 点、等号、与号单独出现也要放行 */
            "a.b/c=d&e",
        ];
        for g in good {
            assert!(
                is_safe_upstream_path(g).is_ok(),
                "合法路径 {g:?} 应通过白名单"
            );
        }
    }

    /* ================= CookieJar 合并规则 ================= */

    /*
     * 这几条测的是 1.3.9 重构时**从 post() 里抽出来**的那段规则。
     *
     * 抽出来的理由与 D-07 的教训完全一样：这段逻辑以前散在 post() 内部，
     * 只能靠「跑通一整条命令 + 看登录态对不对」去间接验证 ——
     * 而那种验证在离线 CI 里根本跑不了，所以它一直没被测过。
     * 现在它是纯内存函数，可以直接断言每条规则。
     */

    fn jar(raw: &str) -> CookieJar {
        CookieJar {
            raw: raw.to_string(),
        }
    }

    #[test]
    fn cookie_merge_adds_new_pairs() {
        let mut j = jar("a=1");
        let changed = j.merge(&["b=2".to_string()]);
        assert!(
            changed,
            "新增 cookie 必须报告内容有变化（否则不会落盘，重启就掉登录）"
        );
        assert_eq!(j.raw, "a=1; b=2");
    }

    #[test]
    fn cookie_merge_overwrites_same_key() {
        let mut j = jar("MUSIC_U=old; a=1");
        j.merge(&["MUSIC_U=new".to_string()]);
        /*
         * 断言「覆盖」这件事，用**键值对**而不是整串。
         *
         * 整串断言会把「键的顺序」也一起锁死，而顺序不是契约：
         * 就地替换保序、删了重加换到尾，两种实现都能正确表达「覆盖」。
         * 拿整串去断言，等于让测试规定实现细节，改一次实现就红一次
         * —— 那种测试最后只会被改成「跟实现一样」而失去意义。
         */
        let pairs = j.pairs();
        assert_eq!(
            pairs.iter().filter(|(k, _)| k == "MUSIC_U").count(),
            1,
            "同名只能有一份 —— 并存时拼进请求头会带两个值，上游取哪个不确定"
        );
        assert_eq!(
            pairs
                .iter()
                .find(|(k, _)| k == "MUSIC_U")
                .map(|(_, v)| v.as_str()),
            Some("new"),
            "同名必须被新值覆盖"
        );
        assert!(
            pairs.iter().any(|(k, v)| k == "a" && v == "1"),
            "别的键不能丢"
        );
    }

    /*
     * deleted / null / 空值 = 删除。
     *
     * 网易云退出登录就是用 `Set-Cookie: MUSIC_U=deleted` 表达的。
     * 当成普通值存下来的话，下次启动会以为自己还登录着 ——
     * 用户表现是「退出登录后重启又自动登录了」。
     */
    #[test]
    fn cookie_merge_treats_deleted_null_empty_as_removal() {
        for marker in ["deleted", "DELETED", "null", ""] {
            let mut j = jar("MUSIC_U=abc; a=1");
            j.merge(&[format!("MUSIC_U={marker}")]);
            assert!(
                !j.raw.contains("MUSIC_U"),
                "Set-Cookie: MUSIC_U={marker} 应当删除该键，实际得到 {:?}",
                j.raw
            );
            assert!(j.raw.contains("a=1"), "删一个键不能误伤其他键");
        }
    }

    #[test]
    fn cookie_merge_ignores_attributes_and_empty_keys() {
        let mut j = jar("a=1");
        /* 属性段（Path/Domain/HttpOnly）不能当成 cookie 值存进来 */
        j.merge(&["b=2; Path=/; HttpOnly; Secure".to_string()]);
        assert_eq!(j.raw, "a=1; b=2", "只取第一个分号前的 k=v，属性段必须丢弃");

        let mut j2 = jar("a=1");
        let changed = j2.merge(&["=broken".to_string(), "".to_string()]);
        assert!(!changed, "空 key / 空行不该改动 jar");
        assert_eq!(j2.raw, "a=1");
    }

    #[test]
    fn cookie_merge_reports_unchanged() {
        let mut j = jar("a=1; b=2");
        /* 完全相同的值：不该报告变化，否则每个响应都白写两次盘 */
        assert!(!j.merge(&["a=1".to_string()]), "值没变不该触发落盘");
        assert!(!j.merge(&[]), "空批次不该触发落盘");
    }

    #[test]
    fn cookie_pairs_skips_malformed() {
        /*
         * 存档被外部改坏（手工编辑 / 旧版本残留）时不能整段失效。
         * 解析失败的部分丢掉，能认的继续用 —— 与 server.js 的口径一致。
         */
        let j = jar("a=1; garbage; =nokey; b=2");
        assert_eq!(
            j.pairs(),
            vec![
                ("a".to_string(), "1".to_string()),
                ("b".to_string(), "2".to_string()),
            ]
        );
    }

    /*
     * ===== Client 必须是 Clone + Send + Sync =====
     *
     * 这条不是「顺手写写」的断言：整个 1.3.9 的并发修复依赖它。
     * 如果有人以后给 Client 加一个 Rc 字段、或把 cookie 换成 RefCell，
     * 下面这行会直接编译失败 —— 而它失败的位置正好是「能不能跨线程」
     * 这个语义上，比等到 main.rs 里 pool.execute 报一大串 trait bound 好读得多。
     */
    #[test]
    fn client_is_clone_send_sync() {
        fn assert_traits<T: Clone + Send + Sync + 'static>() {}
        assert_traits::<Client>();
    }
}
