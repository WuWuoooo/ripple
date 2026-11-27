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

pub struct Client {
    http: reqwest::blocking::Client,
    cookie_jar: String,
    cookie_path: PathBuf,
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
            cookie_jar,
            cookie_path,
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
        let tmp = self.cookie_path.with_extension("tmp");
        let ok = fs::write(&tmp, &self.cookie_jar).is_ok()
            && fs::rename(&tmp, &self.cookie_path).is_ok();
        if !ok {
            let _ = fs::remove_file(&tmp);
        }
        // POSIX 上收紧权限；Windows 会失败，忽略即可
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&self.cookie_path, fs::Permissions::from_mode(0o600));
        }
    }

    fn csrf(&self) -> String {
        weapi::csrf(&self.cookie_jar)
    }

    /// 发一条 weapi 请求，返回原始响应文本。
    ///
    /// 与 Java / Node 两侧完全一致：
    ///   POST https://music.163.com/weapi/<path>?csrf_token=<csrf>
    ///   Header: Referer / Origin 都是 music.163.com，Cookie 带 os=android 前缀。
    /// 那个 `os=android` 不是装饰：不带它时 song_url 给的部分音质档会被降级。
    fn post(&mut self, path: &str, body: Value) -> Result<String, String> {
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
        let cookie = format!("os=android; appver=8.9.70; osver=13; {}", self.cookie_jar);

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

        // 并发请求可能同时收到 Set-Cookie；这里按行合并进 jar，
        // 值形如 deleted/null 的按「删除」处理（与 server.js 一致）
        let set_cookies: Vec<String> = res
            .headers()
            .get_all(reqwest::header::SET_COOKIE)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .map(|s| s.to_string())
            .collect();
        if !set_cookies.is_empty() {
            let mut jar: Vec<(String, String)> = self
                .cookie_jar
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
                .collect();
            for line in &set_cookies {
                let pair = line.split(';').next().unwrap_or("").trim();
                let Some((k, v)) = pair.split_once('=') else {
                    continue;
                };
                if k.is_empty() {
                    continue;
                }
                let deleted = v.is_empty()
                    || v.eq_ignore_ascii_case("deleted")
                    || v.eq_ignore_ascii_case("null");
                jar.retain(|(jk, _)| jk != k);
                if !deleted {
                    jar.push((k.to_string(), v.to_string()));
                }
            }
            self.cookie_jar = jar
                .into_iter()
                .map(|(k, v)| format!("{k}={v}"))
                .collect::<Vec<_>>()
                .join("; ");
            self.save_cookie();
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
    pub fn call(&mut self, cmd: &str, params: &Value) -> Result<String, String> {
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
                if !self.cookie_jar.contains("MUSIC_U=") {
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
                self.cookie_jar.clear();
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
                if !self.cookie_jar.contains("MUSIC_U=") || r.contains("\"code\":301") {
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
}
