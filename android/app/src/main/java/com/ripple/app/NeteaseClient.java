package com.ripple.app;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.zip.GZIPInputStream;

/**
 * 真正的网易云客户端（Java 侧）。
 *
 * 和 Enji 走同一套协议：weapi 加密 POST + 登录 cookie 复用。
 * 网页侧只发「命令 + 参数」，加密、Cookie、UA、防盗链全部在这里做，
 * 所以网页不需要任何代理服务，也不需要跨域权限。
 *
 * 支持的命令（NeteaseClient.call）：
 *   status / login_qr_key / login_qr_check / logout
 *   search / song_detail / song_url / lyric / playlist / toplist
 *   recommend / likelist / like / user_playlist / personalized
 */
final class NeteaseClient {

    private static final String HOST = "https://music.163.com";
    /** 网易云只认自己的 Referer，且要 pc 版 UA 才完整返回数据 */
    private static final String UA =
            "Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) "
                    + "Chrome/124.0.0.0 Mobile Safari/537.36";
    private static final String COOKIE_KEY = "ripple_cookie";

    private final SharedPreferences sp;
    /**
     * 登录 cookie。
     * 用 volatile 是为了让读侧（isLoggedIn / getCookie）不必进锁 —— 写侧仍然
     * 做「读-改-写」，保证并发请求不会互相覆盖 Set-Cookie。
     */
    private volatile String cookie = "";

    /**
     * 请求锁：**整条 POST 串行化**。
     *
     * 以前 post() 只在 setCookie 里加了 synchronized，而
     * 「带上当前 cookie 发请求 → 读响应头里的 Set-Cookie → 合并回 cookie」
     * 这一整段在锁外 —— 两个并发请求各自拿到旧 cookie 快照，
     * 后写回的会把另一个刚更新的会话 cookie（比如 MUSIC_U 刷新）整个盖掉。
     * 网页侧一次刷新会同时打 status / likelist / playlist 好几个命令，
     * 撞上的概率不低。
     *
     * 代价是请求变成串行。考虑到每个命令本身就要 1-4 个串行 POST、
     * 前端也有超时兜底，这个代价远小于「登录态被随机写坏」。
     */
    private final Object REQ_LOCK = new Object();

    /**
     * cookie 字段的轻量锁 —— 只保护「赋值」这几纳秒，**绝不包裹网络 I/O**。
     *
     * 为什么必须分开：post() 持 REQ_LOCK 最长 30 秒（connect 12s + read 18s），
     * 而 setCookie() 是从**主线程**调进来的（MainActivity.harvestLogin 拿到
     * MUSIC_U 后立刻调）。如果 setCookie 也要抢 REQ_LOCK，网络一慢主线程就
     * 被冻住几十秒 —— 直接 ANR。
     *
     * 两者的一致性：cookie 是 volatile 的，赋值本身原子；setCookie 每次
     * 递增 cookieGen，absorbCookies 合并前先比对，发现期间有更新的登录态
     * 就放弃这次合并（让 setCookie 赢，那才是真正来自登录页的新 cookie）。
     */
    private final Object COOKIE_LOCK = new Object();
    private volatile int cookieGen = 0;

    NeteaseClient(Context ctx) {
        sp = ctx.getSharedPreferences("ripple", Context.MODE_PRIVATE);
        cookie = sp.getString(COOKIE_KEY, "");
    }

    String getCookie() {
        return cookie;
    }

    void setCookie(String raw) {
        synchronized (COOKIE_LOCK) {
            cookieGen++;
            applyCookie(raw == null ? "" : raw);
        }
    }

    /**
     * 清登录态。同时把 WebView 的 CookieManager 也清掉 ——
     * 以前只清了 Java 这份和 SharedPreferences，CookieManager 里那份还在，
     * 于是「退出登录」之后登录层一打开就又被判成已登录（三副本只清了两份）。
     */
    void clearCookie() {
        synchronized (COOKIE_LOCK) {
            cookieGen++;
            applyCookie("");
        }
        clearWebViewCookies();
    }

    /**
     * 清 CookieManager + 落盘。
     * CookieManager 的 API 在各版本上返回值不同（Boolean vs Unit），
     * 统一用 try-catch 吞掉，清不掉也不影响主流程。
     */
    static void clearWebViewCookies() {
        try {
            android.webkit.CookieManager cm = android.webkit.CookieManager.getInstance();
            cm.removeAllCookies(null);
            cm.flush();
        } catch (Throwable ignored) {
        }
    }

    boolean isLoggedIn() {
        return cookie.contains("MUSIC_U=");
    }

    /** 只做「写 cookie + 落盘」，调用方必须已经持有 COOKIE_LOCK */
    private void applyCookie(String raw) {
        cookie = raw;
        try {
            sp.edit().putString(COOKIE_KEY, raw).apply();
        } catch (Throwable ignored) {
        }
    }

    /* ================= 底层请求 ================= */

    /**
     * 发一个 weapi POST。
     *
     * 整段（拼请求头用的 cookie 快照 → 发请求 → 合并响应的 Set-Cookie）
     * 都在 REQ_LOCK 里完成，见字段注释。
     */
    private String post(String path, String jsonBody) throws Exception {
        assertSafePath(path);
        synchronized (REQ_LOCK) {
            String csrf = Weapi.csrf(cookie);
            String body = Weapi.form(jsonBody);
            String url = HOST + "/weapi/" + path
                    + (path.contains("?") ? "&" : "?") + "csrf_token=" + Weapi.urlEncode(csrf);

            HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
            try {
                conn.setRequestMethod("POST");
                conn.setConnectTimeout(12000);
                conn.setReadTimeout(18000);
                conn.setDoOutput(true);
                conn.setInstanceFollowRedirects(true);
                conn.setRequestProperty("User-Agent", UA);
                conn.setRequestProperty("Referer", "https://music.163.com/");
                conn.setRequestProperty("Origin", "https://music.163.com");
                conn.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
                conn.setRequestProperty("Accept", "*/*");
                conn.setRequestProperty("Accept-Encoding", "gzip");
                conn.setRequestProperty("Cookie", "os=android; appver=8.9.70; osver=13; " + cookie);

                byte[] raw = body.getBytes("UTF-8");
                conn.setFixedLengthStreamingMode(raw.length);
                // 只取一次输出流：getOutputStream() 每调用一次都可能重新开流
                java.io.OutputStream os = conn.getOutputStream();
                os.write(raw);
                os.flush();

                String text = readBody(conn);
                absorbCookies(conn);
                return text;            } finally {
                conn.disconnect();
            }
        }
    }

    /**
     * 断言 /weapi/ 后面的路径只包含安全字符。
     *
     * comments 命令以前把网页传来的 id 原样拼进路径
     * （"v1/resource/comments/R_SO_4_" + id），id="1../../logout"
     * 就能打到任意 /weapi/ 下的接口 —— 等于绕过命令白名单。
     * 这里做成最后一道闸：任何拼路径的地方出错都会被它拦住。
     *
     * 顺带把 ".." 这种目录穿越也挡掉（字符集里虽然有 '.'，但连续的点单独判）。
     */
    private static void assertSafePath(String path) throws Exception {
        if (path == null || path.isEmpty()) throw new Exception("非法接口路径");
        for (int i = 0; i < path.length(); i++) {
            char c = path.charAt(i);
            boolean ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
                    || (c >= '0' && c <= '9')
                    || c == '/' || c == '_' || c == '-' || c == '.' || c == '?'
                    || c == '=' || c == '&';
            if (!ok) throw new Exception("非法接口路径");
        }
        if (path.contains("..")) throw new Exception("非法接口路径");
    }

    private static String readBody(HttpURLConnection conn) throws Exception {
        int code = conn.getResponseCode();
        InputStream in = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
        if (in == null) return "{\"code\":" + code + "}";
        String enc = conn.getContentEncoding();
        if (enc != null && enc.toLowerCase().contains("gzip")) in = new GZIPInputStream(in);
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
        in.close();
        return bos.toString("UTF-8");
    }

    /**
     * 把响应里的 Set-Cookie（登录成功后就是 MUSIC_U 等）合并进本地 cookie。
     *
     * 调用时已经持有 REQ_LOCK（所以不会有第二个 post 并发合并），
     * 但主线程的 setCookie（登录页收割）可能中途插进来 ——
     * 那种情况必须让 setCookie 赢：它带的是用户刚登录成功的新 cookie。
     * 所以这里先记一个 cookieGen 快照，合并完发现变了就整段丢弃。
     */
    private void absorbCookies(HttpURLConnection conn) {
        final int gen = cookieGen;
        Map<String, String> jar = parseCookie(cookie);
        boolean changed = false;
        for (Map.Entry<String, List<String>> e : conn.getHeaderFields().entrySet()) {
            if (e.getKey() == null || !"set-cookie".equalsIgnoreCase(e.getKey())) continue;
            for (String line : e.getValue()) {
                if (line == null) continue;
                String pair = line.split(";", 2)[0].trim();
                int eq = pair.indexOf('=');
                if (eq <= 0) continue;
                String k = pair.substring(0, eq).trim();
                String v = pair.substring(eq + 1).trim();
                if (v.isEmpty() || "deleted".equalsIgnoreCase(v) || "null".equalsIgnoreCase(v)) {
                    jar.remove(k);
                } else {
                    jar.put(k, v);
                }
                changed = true;
            }
        }
        if (!changed) return;
        synchronized (COOKIE_LOCK) {
            // 期间有登录页写入了更新的 cookie：放弃这次合并，别把它盖回旧值
            if (cookieGen != gen) return;
            applyCookie(joinCookie(jar));
        }
    }

    private static Map<String, String> parseCookie(String raw) {
        Map<String, String> map = new LinkedHashMap<>();
        if (raw == null) return map;
        for (String part : raw.split(";")) {
            String p = part.trim();
            if (p.isEmpty()) continue;
            int eq = p.indexOf('=');
            if (eq <= 0) continue;
            map.put(p.substring(0, eq).trim(), p.substring(eq + 1).trim());
        }
        return map;
    }

    private static String joinCookie(Map<String, String> jar) {
        StringBuilder b = new StringBuilder();
        for (Map.Entry<String, String> e : jar.entrySet()) {
            if (b.length() > 0) b.append("; ");
            b.append(e.getKey()).append('=').append(e.getValue());
        }
        return b.toString();
    }

    /* ================= 命令分发 ================= */

    String call(String cmd, JSONObject p) throws Exception {
        p = p == null ? new JSONObject() : p;
        switch (cmd) {
            case "status":        return status();
            case "login_qr_key":  return post("login/qrcode/unikey", json("type", 3));
            case "login_qr_check": {
                JSONObject o = new JSONObject();
                o.put("key", p.optString("key"));
                o.put("type", 3);
                return post("login/qrcode/client/login", o.toString());
            }
            /*
             * 先让服务端注销会话，再清本地 cookie。
             * 反过来（先 clearCookie）会让 post 带着空 cookie 去请求 logout，
             * 服务端根本不知道要注销谁的会话 —— 只是本地看起来退出了。
             */
            case "logout": {
                String r = "";
                try { r = post("logout", "{}"); } catch (Throwable ignored) {}
                clearCookie();
                return r;
            }
            case "search":       return search(p);
            case "song_detail":  return songDetail(p.optString("ids"));
            case "song_url":     return songUrl(p.optString("id"), p.optString("level", "exhigh"));
            case "lyric": {
                JSONObject o = new JSONObject();
                o.put("id", p.optString("id"));
                o.put("tv", -1); o.put("lv", -1); o.put("rv", -1); o.put("kv", -1); o.put("_nmclfl", 1);
                return post("song/lyric", o.toString());
            }
            case "playlist": {
                JSONObject o = new JSONObject();
                o.put("id", p.optString("id"));
                /*
                 * H-7：以前要 100000 首，万人歌单会一次性 innerHTML 上万个节点，
                 * 主线程阻塞数秒到数十秒。网页端只要 300 首，这里跟着降。
                 */
                o.put("n", 300);
                o.put("s", 8);
                return post("v6/playlist/detail", o.toString());
            }
            case "comment_add": {
                /*
                 * 第 16 条：发评论。
                 * 网易云的接口是 /api/v1/resource/comments/add（weapi 路径去掉 /api 前缀），
                 * 需要 threadId（歌曲是 R_SO_4_<id>）和 content；
                 * csrf_token 由 post() 统一从 cookie 里取（Weapi.csrf），不用这里管。
                 */
                JSONObject o = new JSONObject();
                o.put("threadId", "R_SO_4_" + p.optString("id"));
                o.put("content", p.optString("content"));
                return post("v1/resource/comments/add", o.toString());
            }
            case "playlist_tracks": return playlistTracks(p);
            case "toplist":      return post("toplist", "{}");
            case "recommend": {
                // 登录后是真正的「每日推荐」，未登录退化为公开的新歌推荐
                String r = post("v3/discovery/recommend/songs", "{}");
                if (!isLoggedIn() || r.contains("\"code\":301")) {
                    r = post("personalized/newsong", json("limit", 30));
                }
                return r;
            }
            case "likelist": {
                String uid = p.optString("uid");
                JSONObject o = new JSONObject();
                o.put("uid", uid);
                return post("song/like/get", o.toString());
            }
            case "like": {
                JSONObject o = new JSONObject();
                o.put("trackId", p.optString("id"));
                o.put("userid", p.optString("uid"));
                o.put("like", p.optBoolean("like", true));
                return post("song/like", o.toString());
            }
            case "user_playlist": {
                JSONObject o = new JSONObject();
                o.put("uid", p.optString("uid"));
                o.put("limit", p.optInt("limit", 100));
                o.put("offset", p.optInt("offset", 0));
                o.put("includeVideo", true);
                return post("user/playlist", o.toString());
            }
            case "personalized": {
                JSONObject o = new JSONObject();
                o.put("limit", p.optInt("limit", 12));
                o.put("total", true);
                o.put("n", 1000);
                return post("personalized/playlist", o.toString());
            }
            case "hot_search":   return post("search/hot/detail", "{}");
            // 心动模式：根据当前歌曲 + 歌单生成同口味队列（网易云「心动模式」）
            case "heart_mode": {
                JSONObject o = new JSONObject();
                o.put("songId", p.optString("songId"));
                o.put("type", "fromPlayOne");
                o.put("playlistId", p.optString("playlistId", "0"));
                o.put("startMusicId", p.optString("startMusicId", p.optString("songId")));
                o.put("count", p.optInt("count", 20));
                return post("playmode/intelligence/list", o.toString());
            }
            // 无限漫游：拿相似歌曲续队列（未登录也能用，等价于「漫游/无限」）
            case "simi_song": {
                JSONObject o = new JSONObject();
                o.put("songid", p.optString("songId"));
                o.put("limit", p.optInt("limit", 20));
                o.put("offset", p.optInt("offset", 0));
                return post("v1/discovery/simiSong", o.toString());
            }
            // 歌曲评论（热评 + 最新）
            case "comments": {
                /*
                 * id 会被拼进 URL 路径（v1/resource/comments/R_SO_4_<id>），
                 * 所以这里必须只接受纯数字：以前直接拼，id="1../../logout"
                 * 就能打到 /weapi/ 下任意接口。post() 里还有一道通用的路径断言，
                 * 两处都做是为了不依赖单一防线。
                 */
                String id = p.optString("id").trim();
                if (!id.matches("^\\d+$")) {
                    return "{\"code\":-1,\"msg\":\"歌曲 id 不合法\"}";
                }
                JSONObject o = new JSONObject();
                o.put("rid", id);
                o.put("limit", p.optInt("limit", 20));
                o.put("offset", p.optInt("offset", 0));
                o.put("beforeTime", p.optString("before", "0"));
                return post("v1/resource/comments/R_SO_4_" + id, o.toString());
            }
            // 私人 FM（未登录可用的无限电台兜底）
            case "personal_fm": return post("v1/radio/get", "{}");
            // 原 raw 命令（网页可传任意 /weapi/ 路径）已删除：前端从未使用，留着等于
            // 一旦页面被注入就能以用户身份调用任意接口（含改歌单、改资料等写操作）。
            default:
                return "{\"code\":-2,\"msg\":\"未知命令 " + cmd + "\"}";
        }
    }

    private static String json(String k, Object v) throws Exception {
        JSONObject o = new JSONObject();
        o.put(k, v);
        return o.toString();
    }

    private String status() throws Exception {
        String r = post("w/nuser/account/get", "{}");
        if (!isLoggedIn()) return r;
        // 已登录：顺带把 VIP 信息与等级一起带上，界面直接用
        try {
            JSONObject acc = new JSONObject(r);
            if (acc.optJSONObject("profile") != null) {
                JSONObject extra = new JSONObject();
                extra.put("vip", new JSONObject(post("vip/info/v2", "{}")));
                extra.put("level", new JSONObject(post("user/level", "{}")));
                extra.put("like", new JSONObject(post("song/like/get",
                        json("uid", acc.optJSONObject("profile").optString("userId")))));
                acc.put("_extra", extra);
                return acc.toString();
            }
        } catch (Exception ignored) {
        }
        return r;
    }

    /* ---------- 搜索：云搜索 → 老搜索兜底 ---------- */
    private String search(JSONObject p) throws Exception {
        String kw = p.optString("keywords");
        int type = p.optInt("type", 1);
        int limit = p.optInt("limit", 30);
        int offset = p.optInt("offset", 0);
        JSONObject o = new JSONObject();
        o.put("s", kw);
        o.put("type", type);
        o.put("limit", limit);
        o.put("offset", offset);
        o.put("total", true);
        String r = post("cloudsearch/pc", o.toString());
        // 云搜索偶尔对未登录限流，回落明文老接口（同一个域名，不需要登录）
        try {
            JSONObject j = new JSONObject(r);
            boolean has = j.optJSONObject("result") != null
                    && j.optJSONObject("result").optJSONArray("songs") != null;
            if (!has && j.optInt("code", 200) != 200) throw new Exception("fallback");
        } catch (Exception e) {
            return post("search/get", o.toString());
        }
        return r;
    }

    private String songDetail(String idsCsv) throws Exception {
        JSONArray c = new JSONArray();
        for (String s : idsCsv.split(",")) {
            String t = s.trim();
            if (t.isEmpty()) continue;
            JSONObject one = new JSONObject();
            one.put("id", Long.parseLong(t));
            c.put(one);
        }
        JSONObject o = new JSONObject();
        o.put("c", c.toString());
        return post("v3/song/detail", o.toString());
    }

    private String songUrl(String id, String level) throws Exception {
        JSONObject o = new JSONObject();
        o.put("ids", "[" + id + "]");
        o.put("level", level);
        o.put("encodeType", "flac");
        return post("song/enhance/player/url/v1", o.toString());
    }

    private String playlistTracks(JSONObject p) throws Exception {
        String detail = post("v6/playlist/detail", json("id", p.optString("id")));
        JSONObject j = new JSONObject(detail);
        JSONObject pl = j.optJSONObject("playlist");
        if (pl == null) return detail;
        JSONArray trackIds = pl.optJSONArray("trackIds");
        int limit = p.optInt("limit", 1000);
        int offset = p.optInt("offset", 0);
        if (trackIds == null) return detail;
        StringBuilder ids = new StringBuilder();
        for (int i = offset; i < Math.min(trackIds.length(), offset + limit); i++) {
            JSONObject t = trackIds.optJSONObject(i);
            if (t == null) continue;
            if (ids.length() > 0) ids.append(',');
            ids.append(t.optLong("id"));
        }
        return songDetail(ids.toString());
    }
}
