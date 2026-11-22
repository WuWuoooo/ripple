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

impl Client {
    pub fn new(data_dir: &Path) -> Result<Self, String> {
        fs::create_dir_all(data_dir).map_err(|e| format!("创建配置目录失败：{e}"))?;
        let cookie_path = data_dir.join("netease-cookie");
        let cookie_jar = fs::read_to_string(&cookie_path).unwrap_or_default();

        let http = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(25))
            .user_agent(UA)
            .gzip(true)
            .build()
            .map_err(|e| format!("HTTP 客户端初始化失败：{e}"))?;

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
    fn save_cookie(&self) {
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
            return Err(format!("非法上游路径：{path}"));
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
            .map_err(|e| format!("请求失败（{path}）：{e}"))?;

        // 并发请求可能同时收到 Set-Cookie；这里按行合并进 jar，
        // 值形如 deleted/null 的按「删除」处理（与 server.js 一致）
        if let Some(lines) = res
            .headers()
            .get_all(reqwest::header::SET_COOKIE)
            .iter()
            .next()
        {
            let _ = lines;
        }
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
            return Err(format!("上游返回 HTTP {}", res.status().as_u16()));
        }
        res.text().map_err(|e| format!("读取响应失败：{e}"))
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
                // E-15：只有「拿不到 result.songs」且「code != 200」时才回落老接口，
                // 与 Java:331-341 同口径。早的判据是「没有 result.songs 就回落」，
                // 于是云搜索被限流但返回 {"result":{},"code":200} 时会多打一次请求
                // 并给出另一批数据。
                let ok = serde_json::from_str::<Value>(&r)
                    .ok()
                    .and_then(|v| v.get("result").and_then(|x| x.get("songs")).map(|_| ()))
                    .is_some();
                if ok {
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
                        return Err("song_detail: ids 必须是数字逗号串".into());
                    }
                    items.push(format!("{{\"id\":{t}}}"));
                }
                if items.is_empty() {
                    return Err("song_detail: ids 不能为空".into());
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
                .map_err(|e| format!("歌单详情不是 JSON：{e}"))?;
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
                    return Err("comment_add: id 必须是数字".into());
                }
                let txt = s("content").trim().to_string();
                if txt.is_empty() {
                    return Err("comment_add: 内容不能为空".into());
                }
                if txt.chars().count() > 140 {
                    return Err("comment_add: 最多 140 字".into());
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
                    return Err("comments: id 必须是数字".into());
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

            "personal_fm" => self.post("personal/fm", Value::Object(Default::default())),

            other => Err(format!("未知命令：{other}")),
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
        // 这条白名单与 server-security.js 的 assertUpstreamPath 同口径：
        // 小写字母 / 数字 / 斜杠 / 下划线 / 连字符之外一律拒
        let bad = [
            "../user/level",
            "a%2e%2e/b",
            "a\\b",
            "a?x=1",
            "a#frag",
            "A/uppercase",
        ];
        for b in bad {
            let ok = !b.is_empty()
                && b.chars().all(|c| {
                    c.is_ascii_lowercase() || c.is_ascii_digit() || c == '/' || c == '_' || c == '-'
                });
            assert!(!ok, "路径 {b} 不该通过白名单");
        }
        for g in [
            "w/nuser/account/get",
            "v3/song/detail",
            "song/enhance/player/url/v1",
        ] {
            let ok = g.chars().all(|c| {
                c.is_ascii_lowercase() || c.is_ascii_digit() || c == '/' || c == '_' || c == '-'
            });
            assert!(ok, "合法路径 {g} 应通过");
        }
    }
}
