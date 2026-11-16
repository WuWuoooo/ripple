package com.ripple.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.webkit.JavascriptInterface;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.zip.GZIPInputStream;

/**
 * 给网页用的原生桥。
 *
 *  v1.1 起在线音乐全部改走 netease()：Java 侧做 weapi 加密 + 带登录 cookie，
 *  网页只发命令名和参数，不再需要自建代理（老接口 /api/search/get 明文那套已弃用）。
 *
 *  其余保留：httpGet（通用 GET）、notify（低优先级静默通知，不打断播放）、
 *  login / loginClose（内嵌官方登录页）。
 */
public class HttpBridge {

    private static final String UA =
            "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36";
    private static final String CH_ID = "ripple_playback";
    private static final String CH_ALERT = "ripple_alert";
    /*
     * 提示类通知的固定 id 段。
     * 以前用的是 currentTimeMillis() % 100000，而播放通知 0x9A01(=39425)
     * 正好落在这个区间里 —— 点一次「测试通知」就可能把正在播放的通知整条顶掉。
     * 这里单独占 0x9A10 起的一段，并在段内递增，避免 100 秒内互相覆盖。
     */
    private static final int NOTIF_TEST_BASE = 0x9A10;
    private static final java.util.concurrent.atomic.AtomicInteger NOTIFY_SEQ =
            new java.util.concurrent.atomic.AtomicInteger(0);

    private final Context ctx;
    private final MainActivity act;
    private final NeteaseClient ncm;

    HttpBridge(MainActivity act, NeteaseClient ncm) {
        this.act = act;
        this.ctx = act.getApplicationContext();
        this.ncm = ncm;
        ensureChannel();
    }

    /* ================= 网易云（真接口，weapi） ================= */

    /**
     * 异步调用网易云。字符串会被转成 JSON 空对象。
     * 回调 window.__rippleNativeResult(cbId, jsonText)。
     */
    /**
     * 第 5 条：网页里「两次下拉」确认后调用，关掉界面回到桌面。
     * 放在网页侧判断是因为只有网页知道当前页面滚到顶了没有、
     * 是否在 2 秒的确认窗口内。
     */
    @JavascriptInterface
    public void exitApp() {
        try {
            act.runOnUiThread(() -> act.finish());
        } catch (Throwable ignored) {
        }
    }

    @JavascriptInterface
    public void netease(final String cmd, final String paramsJson, final String cbId) {
        new Thread(() -> {
            String out;
            try {
                JSONObject p = null;
                if (paramsJson != null && paramsJson.trim().startsWith("{")) {
                    p = new JSONObject(paramsJson);
                }
                out = ncm.call(cmd, p);
            } catch (Exception e) {
                out = "{\"code\":-1,\"msg\":\"" + safe(e) + "\"}";
            }
            act.replyToWeb(cbId, out);
        }, "ripple-ncm").start();
    }

    /** 当前是否已登录（有 MUSIC_U） */
    @JavascriptInterface
    public boolean loggedIn() {
        return ncm.isLoggedIn();
    }

    /**
     * 打开官方登录页；登录成功后回调 cbId，payload 是 status 接口的返回
     * @param mode "phone" = 手机号/短信登录，"qr" = 扫码登录
     */
    @JavascriptInterface
    public void login(final String mode, final String cbId) {
        act.openLogin(mode == null ? "phone" : mode, cbId);
    }

    @JavascriptInterface
    public void loginClose() {
        act.closeLoginFromWeb();
    }

    @JavascriptInterface
    public void loginFinish(String cbId) {
        act.finishLoginFromWeb(cbId);
    }

    @JavascriptInterface
    public void logout() {
        ncm.clearCookie();
    }

    /* ================= 通用 ================= */

    /**
     * 只允许网易云自己的域名。
     * 原来这个方法接受任意 URL，等于给网页开了一个「访问任意内网地址」的入口。
     */
    private static boolean allowedHost(String host) {
        if (host == null) return false;
        host = host.toLowerCase();
        if (host.equals("music.163.com") || host.equals("163.com") || host.endsWith(".163.com")) return true;
        if (host.equals("126.net") || host.endsWith(".126.net")) return true;
        return false;
    }

    /**
     * 同步 GET。
     * 不再是 @JavascriptInterface：同步桥方法跑在 WebView 的 JS 线程上，
     * 一次超时就把整个界面冻住，前端只用异步版本。
     */
    private String httpGet(String url) {
        HttpURLConnection conn = null;
        try {
            URL u = new URL(url);
            if (!allowedHost(u.getHost())) {
                return "{\"code\":-1,\"msg\":\"host not allowed\"}";
            }
            conn = (HttpURLConnection) u.openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(5000);
            conn.setReadTimeout(5000);
            conn.setRequestProperty("User-Agent", UA);
            conn.setRequestProperty("Referer", "https://music.163.com/");
            conn.setRequestProperty("Accept", "*/*");
            conn.setRequestProperty("Accept-Encoding", "gzip");
            conn.setInstanceFollowRedirects(true);

            int code = conn.getResponseCode();
            InputStream in = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
            if (in == null) return "{\"code\":" + code + ",\"msg\":\"empty\"}";

            String enc = conn.getContentEncoding();
            if (enc != null && enc.toLowerCase().contains("gzip")) {
                in = new GZIPInputStream(in);
            }

            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            in.close();
            return bos.toString("UTF-8");
        } catch (Exception e) {
            String msg = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
            msg = msg.replace("\\", " ").replace("\"", "'").replace("\n", " ");
            return "{\"code\":-1,\"msg\":\"" + msg + "\"}";
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    @JavascriptInterface
    public void httpGetAsync(final String url, final String cbId) {
        new Thread(() -> {
            final String res = httpGet(url);
            act.replyToWeb(cbId, res);
        }, "ripple-http").start();
    }

    /**
     * 静默通知：低优先级 + 无声 + 不震动，所以不会打断正在播放的音乐。
     */
    @JavascriptInterface
    public boolean notify(String title, String body) {
        // 默认走静默通道（设置里的「通知不打断播放」开着时的行为）
        return notify(title, body, true);
    }

    /**
     * quiet=true  → 低优先级 + 无声 + 不震动（不打断播放）
     * quiet=false → 默认重要度，会有提示音（对应设置里关掉「通知不打断播放」）
     * 之前这个开关只存在于 UI 上，原生侧永远是静默的，怎么点都没区别。
     */
    @JavascriptInterface
    public boolean notify(String title, String body, boolean quiet) {
        try {
            NotificationManager nm =
                    (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return false;
            ensureChannel(quiet);

            Notification.Builder b = Build.VERSION.SDK_INT >= 26
                    ? new Notification.Builder(ctx, quiet ? CH_ID : CH_ALERT)
                    : new Notification.Builder(ctx);

            b.setContentTitle(title == null ? "Ripple" : title)
                    .setContentText(body == null ? "" : body)
                    .setSmallIcon(android.R.drawable.ic_media_play)
                    .setAutoCancel(true)
                    .setOnlyAlertOnce(true);
            if (quiet) {
                b.setSound(null).setVibrate(null)
                        .setPriority(Notification.PRIORITY_LOW);
            } else {
                b.setPriority(Notification.PRIORITY_DEFAULT);
            }

            if (Build.VERSION.SDK_INT >= 21) {
                b.setVisibility(Notification.VISIBILITY_PUBLIC);
            }
            nm.notify(NOTIF_TEST_BASE + (NOTIFY_SEQ.incrementAndGet() & 0x0FFF), b.build());
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * 把异常信息塞进一段手写的 JSON 字符串里。
     * 只替换反斜杠/引号/换行还不够：制表符、\u0000 之类的控制字符
     * 同样会让 JSON.parse 失败，于是「接口报错」变成「返回内容不是 JSON」，
     * 排查时看不到真正原因。这里把所有控制字符一起转义掉。
     */
    private static String safe(Exception e) {
        String msg = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
        StringBuilder b = new StringBuilder(msg.length() + 16);
        for (int i = 0; i < msg.length(); i++) {
            char c = msg.charAt(i);
            if (c == '"') b.append("\\\"");
            else if (c == '\\') b.append("\\\\");
            else if (c < 0x20 || c == 0x7f) b.append(' ');
            else b.append(c);
        }
        return b.toString();
    }

    private void ensureChannel() { ensureChannel(true); }

    private void ensureChannel(boolean quiet) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm =
                (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        String id = quiet ? CH_ID : CH_ALERT;
        NotificationChannel ch = nm.getNotificationChannel(id);
        if (ch != null) return;
        if (quiet) {
            ch = new NotificationChannel(id, "播放与提示", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("低频通知，不发声、不打断音乐播放");
            ch.setSound(null, null);
            ch.enableVibration(false);
            ch.setShowBadge(false);
        } else {
            ch = new NotificationChannel(id, "提示（有声音）", NotificationManager.IMPORTANCE_DEFAULT);
            ch.setDescription("设置里关掉「通知不打断播放」后使用，会发出提示音");
        }
        nm.createNotificationChannel(ch);
    }

    /* ================= 运行日志 ================= */

    /** 网页写一行日志：tag 用来区分模块，msg 是内容 */
    @JavascriptInterface
    public void log(String tag, String msg) {
        try {
            LogBridge.add(ctx, tag, msg);
        } catch (Throwable ignored) {
        }
    }

    /** 强制落盘（关键节点调用） */
    @JavascriptInterface
    public void logFlush() {
        try {
            LogBridge.flush(ctx);
        } catch (Throwable ignored) {
        }
    }

    /** 日志文件在哪（网页可以显示给用户看） */
    @JavascriptInterface
    public String logPath() {
        try {
            return LogBridge.path();
        } catch (Throwable e) {
            return "";
        }
    }

    /** 日志全文（设置页里可以预览） */
    @JavascriptInterface
    public String logDump() {
        try {
            return LogBridge.dump();
        } catch (Throwable e) {
            return "";
        }
    }

    /** 记录一次 JS 错误 */
    @JavascriptInterface
    public void jsError(String msg, String stack) {
        try {
            LogBridge.add(ctx, "JS-ERROR", msg + "\n" + (stack == null ? "" : stack));
            LogBridge.flush(ctx);
        } catch (Throwable ignored) {
        }
    }

    /** 让系统状态栏 / 导航栏颜色跟网页背景一致（避免顶部一条纯黑） */
    @JavascriptInterface
    public void systemBars(final String statusHex, final String navHex, final boolean lightIcons) {
        act.runOnUiThread(() -> act.applySystemBars(statusHex, navHex, lightIcons));
    }

    /**
     * 通知权限现在到底有没有。
     * 之前网页只看自己有没有原生桥就写「未授权」，
     * 用户明明授权了也一直显示未授权 —— 必须问系统。
     */
    @JavascriptInterface
    public boolean notifyGranted() {
        try {
            if (Build.VERSION.SDK_INT < 33) {
                // Android 13 以下没有运行时通知权限，看通知总开关
                NotificationManager nm =
                        (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
                return nm != null && nm.areNotificationsEnabled();
            }
            if (ctx.checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                    == PackageManager.PERMISSION_GRANTED) {
                NotificationManager nm =
                        (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
                return nm != null && nm.areNotificationsEnabled();
            }
            return false;
        } catch (Throwable e) {
            return false;
        }
    }

    /** 由网页在用户主动想发通知时调用（启动时不再自动弹权限框） */
    @JavascriptInterface
    public void requestNotifyPermission() {
        try {
            act.requestNotifyPermissionNow();
        } catch (Throwable ignored) {
        }
    }

    /**
     * 页面告诉原生「我这边有没有在放音频」。
     * 播放中切到后台时不能 pauseTimers()，否则网页里 setInterval 驱动的
     * 「播完自动下一首」「进度保存」会一起停摆；不播时则应该停掉省电。
     */
    @JavascriptInterface
    public void setPlaying(boolean playing) {
        try {
            act.setWebPlaying(playing);
        } catch (Throwable ignored) {
        }
    }

    /**
     * 系统的深色模式开关。
     *
     * 网页里的 prefers-color-scheme 在 WebView 里并不可靠：
     * 它跟的是「本 App 的 uiMode」，而我们的主题是 Theme.Material（深色基座），
     * 于是系统明明是浅色，网页也一直被判定成深色 ——
     * 「主题 = 自动跟随系统」就永远变成深色。
     * 这里直接读系统配置给网页用。
     */
    @JavascriptInterface
    public boolean systemDark() {
        try {
            int mode = ctx.getResources().getConfiguration().uiMode
                    & android.content.res.Configuration.UI_MODE_NIGHT_MASK;
            return mode == android.content.res.Configuration.UI_MODE_NIGHT_YES;
        } catch (Throwable e) {
            return true;
        }
    }

    /**
     * 网页上报「正在播放什么」，原生据此维护通知栏与锁屏控件。
     * 参数全用字符串，避免 @JavascriptInterface 在数字类型上的歧义。
     */
    @JavascriptInterface
    public void mediaState(String title, String artist, String album, String coverUrl,
                           String durationMs, String positionMs, boolean playing) {
        try {
            act.updateMediaNotification(title, artist, album, coverUrl,
                    durationMs, positionMs, playing);
        } catch (Throwable ignored) {
        }
    }

    /** 只要进度时用这个（每秒一次，成本更低） */
    @JavascriptInterface
    public void mediaProgress(String positionMs, String durationMs, boolean playing) {
        try {
            act.updateMediaProgress(positionMs, durationMs, playing);
        } catch (Throwable ignored) {
        }
    }

    /** 停止播放并撤掉通知（用户主动暂停到底 / 关闭 App 时） */
    @JavascriptInterface
    public void mediaStop() {
        try {
            act.stopMediaNotification();
        } catch (Throwable ignored) {
        }
    }

    /* ---------- 状态栏歌词浮层 ---------- */

    @JavascriptInterface
    public boolean canDrawOverlay() {
        try { return act.canDrawOverlay(); } catch (Throwable e) { return false; }
    }

    @JavascriptInterface
    public void requestOverlayPermission() {
        try { act.requestOverlayPermission(); } catch (Throwable ignored) {}
    }

    @JavascriptInterface
    public void showLyricOverlay(String locked, String colorHex, String sizeSp, String alpha,
                                 String x, String y, String bold, String shadow,
                                 String fill, String fillHex) {
        try {
            act.showLyricOverlay(locked, colorHex, sizeSp, alpha, x, y, bold, shadow, fill, fillHex);
        } catch (Throwable ignored) {}
    }

    @JavascriptInterface
    public void setLyricProgress(String p) {
        try { act.setLyricProgress(p); } catch (Throwable ignored) {}
    }

    @JavascriptInterface
    public void updateLyricOverlay(String text) {
        try { act.updateLyricOverlay(text); } catch (Throwable ignored) {}
    }

    @JavascriptInterface
    public void hideLyricOverlay() {
        try { act.hideLyricOverlay(); } catch (Throwable ignored) {}
    }

    @JavascriptInterface
    public void lockLyricOverlay(boolean locked) {
        try { act.lockLyricOverlay(locked); } catch (Throwable ignored) {}
    }

    @JavascriptInterface
    public String platform() {
        return "android";
    }

    /**
     * safeMode 状态。
     * 进入 safeMode 会关掉 edge-to-edge（界面不再全屏铺边）并跳过 cookie 初始化
     * （登录态可能失效），但在网页侧完全看不出来 —— 用户只会觉得「怎么突然变样了」。
     * 所以把这个标志暴露给页面，由它在界面上给一条明确提示。
     */
    @JavascriptInterface
    public boolean safeMode() {
        return StrictModes.safeMode;
    }

    /**
     * 退出安全模式：清掉连续失败计数，让下次启动重新启用 edge-to-edge。
     *
     * 为什么需要它：safeMode 的判据是「连续多次没走到前台就重启」，
     * 而计数住在 SharedPreferences 里。只要中途因为任何原因（用户在 2.6 秒内
     * 退出、系统强杀、编译期）累积到阈值，就会**一直**降级，
     * 症状是视口变矮约 60px、状态栏不被背景覆盖、页面整体下移 ——
     * 用户完全不知道发生了什么，也没有任何自救入口。
     *
     * 这里只清计数，不立即重启（重启由网页侧提示用户后自行决定）。
     * 返回 true 表示计数已清零，下次启动就是正常模式。
     */
    @JavascriptInterface
    public boolean clearSafeMode() {
        try {
            ctx.getSharedPreferences("ripple", android.content.Context.MODE_PRIVATE)
                    .edit().putInt("boot_streak", 0).apply();
            StrictModes.safeMode = false;
            LogBridge.add(ctx, "APP", "clearSafeMode：计数已清零，下次启动恢复 edge-to-edge");
            return true;
        } catch (Throwable t) {
            LogBridge.add(ctx, "APP", "clearSafeMode failed: " + t);
            return false;
        }
    }
}
