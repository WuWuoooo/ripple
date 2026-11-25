package com.ripple.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.webkit.JavascriptInterface;

import org.json.JSONObject;

import java.io.File;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 给网页用的原生桥。
 *
 *  v1.1 起在线音乐全部改走 netease()：Java 侧做 weapi 加密 + 带登录 cookie，
 *  网页只发命令名和参数，不再需要自建代理（老接口 /api/search/get 明文那套已弃用）。
 *
 *  其余保留：notify（低优先级静默通知，不打断播放）、
 *  mediaState / mediaProgress / setPlaying（通知栏与计时器联动）、
 *  日志与状态栏歌词那一组。
 *
 *  == 删除口径（J-07）==
 *  判定标准只有一条：**前端零调用、Java 侧也没有内部调用** → 纯暴露面，删。
 *  每个 @JavascriptInterface 方法都是「页面一旦被注入就能白嫖的 API」，
 *  留着不用的等于白送攻击面（`logout` 甚至能静默登出用户）。
 *
 *  已删除的桥方法：
 *    · httpGet / httpGetAsync —— 通用 GET，虽然限了域名，但任意页面脚本都能借它
 *      以用户身份去请求网易云；前端零调用。
 *    · exitApp  —— 网页可直接退出 App。
 *    · platform  —— 常量，页面自己就能判断。
 *    · loggedIn —— 前端用的是 `Netease.loggedIn` 这个**属性**（netease.js 按 _profile
 *      自己判定），从不走桥；留着等于多一个「探登录态」的口子。
 *    · logout   —— 前端登出走的是 `netease('logout')` 命令通道（NeteaseClient 会先
 *      让服务端注销会话再清 cookie）；桥上的这个只清本地 cookie，语义还不完整。
 *    · mediaStop —— 撤通知的收尾由 MainActivity.onDestroy 兜住（前端从不调它，
 *      这是当初 E-06 那条「服务被 FGS 白养」的成因之一）。
 *    · lockLyricOverlay —— 桥上的入口删了（前端不需要），但**能力保留在原生内部**：
 *      LyricOverlay.setLocked() 仍然存在且可用（H-14 修复后它是「改锁定」的
 *      语义化入口）。前端改锁定走的是 showLyricOverlay 带 locked 参数那条路，
 *      原生把它当「configure 后按 locked 重算窗口 flags」处理。
 *    · login / loginClose / loginFinish —— 1.3.0 起三端统一走扫码登录
 *      （普通命令通道 login_qr_key / login_qr_check），不再需要内嵌 WebView
 *      登录页；前端 Netease.login() 也已无调用方。详见下面那段说明。
 */
public class HttpBridge {

    private static final String CH_QUIET = "ripple_playback";
    private static final String CH_ALERT = "ripple_alert";
    /*
     * 两个渠道的显示名收敛成「通知 / 提示音」两类。
     * 老 id（ripple_playback）保持不变：渠道名可以改，id 一改用户在系统设置里
     * 对这个渠道做的调整（静音、重要性）就全丢了。
     *
     * 1.3.5 多语言：这两个渠道名和描述原来是 static final 常量，现在改成方法取值。
     * 不能继续用常量 —— 静态字段在类初始化时就算死了，而 L10n.init 是在
     * Application.onCreate 里跑的，两者的初始化顺序不受我们控制；一旦常量先于
     * init 求值，渠道名就会永远钉死在中文。方法则每次建渠道时才取当前语言。
     *
     * H-8：切语言后**能**更新渠道名 —— 只要每次调 createNotificationChannel()。
     * 官方文档写明它对已存在的渠道是「更新 name / description / group」，
     * 只有 importance / sound / vibration 这些用户可改项会被忽略。
     * 以前 ensureChannel 里写着 `if (ch != null) return;`，渠道存在就早退，
     * 根本走不到 createNotificationChannel()，于是切语言后系统设置里的渠道名
     * 永远是首次创建时那个语言。真正阻止更新的不是平台，就是那行 return。
     */
    private static String nameQuiet() {
        return L10n.t("Ripple 通知", "Ripple notifications");
    }

    private static String descQuiet() {
        return L10n.t("低频通知，不发声、不打断音乐播放",
                "Low-priority notifications that stay silent and never interrupt playback");
    }

    private static String nameAlert() {
        return L10n.t("Ripple 提示（有声音）", "Ripple alerts (with sound)");
    }

    private static String descAlert() {
        return L10n.t("设置里关掉「通知不打断播放」后使用，会发出提示音",
                "Used when \"Don't interrupt playback\" is turned off; plays a sound");
    }

    /*
     * 提示类通知的固定 id 段。
     * 以前用的是 currentTimeMillis() % 100000，而播放通知 0x9A01(=39425)
     * 正好落在这个区间里 —— 点一次「测试通知」就可能把正在播放的通知整条顶掉。
     * 这里单独占 0x9A10 起的一段，并在段内递增，避免 100 秒内互相覆盖。
     */
    private static final int NOTIF_TEST_BASE = 0x9A10;
    private static final AtomicInteger NOTIFY_SEQ = new AtomicInteger(0);

    /*
     * 桥调用线程池：以前每次 netease() 都 new Thread()，一个页面刷列表就能
     * 起几十个线程。改成固定大小 + 有界队列；队列满了明确回错误，
     * 而不是让请求静默消失（前端会等到超时才报「请求超时」，看不出真正原因）。
     */
    private static final int POOL_SIZE = 5;
    private static final int QUEUE_CAP = 64;
    private static volatile ThreadPoolExecutor POOL;

    private final Context ctx;
    private final MainActivity act;
    private final NeteaseClient ncm;

    HttpBridge(MainActivity act, NeteaseClient ncm) {
        this.act = act;
        this.ctx = act.getApplicationContext();
        this.ncm = ncm;
        ensureChannel();
    }

    /** 惰性建池：线程是守护线程，App 退出后不会吊着进程 */
    private static ThreadPoolExecutor pool() {
        ThreadPoolExecutor p = POOL;
        if (p != null) return p;
        synchronized (HttpBridge.class) {
            if (POOL == null) {
                POOL = new ThreadPoolExecutor(POOL_SIZE, POOL_SIZE,
                        30, TimeUnit.SECONDS,
                        new ArrayBlockingQueue<>(QUEUE_CAP),
                        new java.util.concurrent.ThreadFactory() {
                            private final AtomicInteger seq = new AtomicInteger(0);

                            @Override
                            public Thread newThread(Runnable r) {
                                Thread t = new Thread(r, "ripple-ncm-" + seq.incrementAndGet());
                                t.setDaemon(true);
                                return t;
                            }
                        },
                        new ThreadPoolExecutor.AbortPolicy());
            }
            return POOL;
        }
    }

    /* ================= 网易云（真接口，weapi） ================= */

    /**
     * 异步调用网易云。字符串会被转成 JSON 空对象。
     * 回调 window.__rippleNativeResult(cbId, jsonText)。
     */
    @JavascriptInterface
    public void netease(final String cmd, final String paramsJson, final String cbId) {
        try {
            pool().execute(() -> {
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
            });
        } catch (Throwable e) {
            // 队列满 / 池已关闭：明确告诉网页，别让它干等到超时
            // 1.3.5 多语言：这段 msg 会被前端原样弹给用户，所以跟着语言走
            act.replyToWeb(cbId, "{\"code\":-1,\"msg\":\"" + L10n.t(
                    "原生请求队列已满，请稍后重试",
                    "Native request queue is full, please try again later") + "\"}");
        }
    }

    /*
     * 审查 AND-02：内嵌 WebView 登录链的三个桥方法已删除
     * （login / loginClose / loginFinish）。
     *
     * 理由：
     *   · 三端从 1.3.0 起统一走扫码登录（app.js 的 chooseLoginMode → startQrLogin），
     *     走的是普通命令通道 login_qr_key / login_qr_check，不碰这里；
     *   · 前端 `Netease.login()` / `loginCancel()` 已无任何调用方
     *     （全目录 grep 只命中定义本身）；
     *   · 留着的实际代价不是「多几行」：`login` 会在主 Activity 上叠第二个 WebView
     *     加载 music.163.com，并暴露 @JavascriptInterface —— 是额外的攻击面；
     *     而本文件头注释还宣称在用、NeteaseClient 的注释却写着「不再用内嵌登录页」，
     *     两份注释互相矛盾，后来人无法判断哪句是真的。
     *
     * 如果将来真要恢复内嵌登录页，正确做法是连同 MainActivity 的登录浮层、
     * 前端登录按钮一起加回来（上轮 J-07 就是按「前端零调用就删」的口径删的）。
     */

    /* ================= 通用 ================= */

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
     *
     * L-16：Android 13+ 没授 POST_NOTIFICATIONS 时**返回 false**。
     * NotificationManager.notify() 在没权限时不会抛异常，只是静默丢弃 ——
     * 以前这里照样 return true，前端就弹「通知已发送 · 静默通道」，
     * 而通知栏里什么都没有，用户完全不知道是自己没授权。
     * 让返回值说实话，前端才能提示「去开通知权限」。
     */
    @JavascriptInterface
    public boolean notify(String title, String body, boolean quiet) {
        try {
            if (!canPostNotifications()) return false;
            NotificationManager nm =
                    (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return false;
            ensureChannel(quiet);

            Notification.Builder b = Build.VERSION.SDK_INT >= 26
                    ? new Notification.Builder(ctx, quiet ? CH_QUIET : CH_ALERT)
                    : new Notification.Builder(ctx);

            b.setContentTitle(title == null ? "Ripple" : title)
                    .setContentText(body == null ? "" : body)
                    .setSmallIcon(R.drawable.ic_stat_music)
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
     *
     * 只替换反斜杠/引号/换行还不够：制表符、\u0000 之类的控制字符
     * 同样会让 JSON.parse 失败，于是「接口报错」变成「返回内容不是 JSON」，
     * 排查时看不到真正原因。这里把所有控制字符一起转义掉。
     *
     * M-13：U+2028 / U+2029 也必须转义。
     * 它们在 JSON 规范里是合法字符串字符，但在 JavaScript 字符串字面量里
     * 是**行终止符** —— 而这段文本后续会被 MainActivity.replyToWeb() 拼成
     * JS 字面量交给 evaluateJavascript。只要错误消息里含这两个字符，
     * 整段脚本就是语法错误 → 回调永远不会触发 → 前端只能干等到超时，
     * 报的还是「请求超时」而不是真实原因。
     */
    private static String safe(Exception e) {
        String msg = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
        StringBuilder b = new StringBuilder(msg.length() + 16);
        for (int i = 0; i < msg.length(); i++) {
            char c = msg.charAt(i);
            if (c == '"') b.append("\\\"");
            else if (c == '\\') b.append("\\\\");
            else if (c < 0x20 || c == 0x7f) b.append(' ');
            else if (c == '\u2028' || c == '\u2029') b.append(c == '\u2028' ? "\\u2028" : "\\u2029");
            else b.append(c);
        }
        return b.toString();
    }

    private void ensureChannel() { ensureChannel(true); }

    /**
     * 建 / 更新通知渠道（幂等）。
     *
     * H-8：**不能**因为渠道已存在就 return。
     * createNotificationChannel() 对已存在渠道的语义是「更新 name / description」，
     * 这正是「切语言后渠道名跟着变」唯一的实现手段；只要提前 return，渠道名
     * 就会永远停在首次创建时那个语言，且只有清数据/重装才能自愈。
     * 每次调用的成本只是几次字符串拼接 + 一次 binder 调用，可以忽略。
     */
    private void ensureChannel(boolean quiet) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm =
                (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        String id = quiet ? CH_QUIET : CH_ALERT;
        NotificationChannel ch;
        if (quiet) {
            ch = new NotificationChannel(id, nameQuiet(), NotificationManager.IMPORTANCE_LOW);
            ch.setDescription(descQuiet());
            ch.setSound(null, null);
            ch.enableVibration(false);
            ch.setShowBadge(false);
        } else {
            ch = new NotificationChannel(id, nameAlert(), NotificationManager.IMPORTANCE_DEFAULT);
            ch.setDescription(descAlert());
        }
        nm.createNotificationChannel(ch);   // ← 每次都调：对已存在渠道即「改名」
    }

    /* ================= 多语言（1.3.5） ================= */

    /**
     * 前端切换界面语言时调用，把语言同步给原生层并落盘。
     *
     * 为什么原生也需要知道：通知渠道名、通知栏那几个动作按钮（上一首/暂停/播放/
     * 下一首/喜欢）、Toast、崩溃兜底页都是 Java 侧直接构造的，前端翻了它们也不会变。
     *
     * 参数只认 "en"（大小写不敏感），其余一律当中文 —— 前端传上来未知语言码时，
     * 宁可回落到中文，也不要让原生层停在两套文案都不是的状态。
     *
     * 线程：只改一个 volatile 字段 + 一次 SharedPreferences.apply()，不碰 UI，
     * 所以不像 systemBars 那样需要 runOnUiThread；而且 apply() 本来就是异步落盘。
     */
    @JavascriptInterface
    public void setLang(String code) {
        try {
            L10n.setLang(ctx, code);
            /*
             * H-8：语言一变就立刻把两个渠道名/描述刷一遍。
             *
             * 不刷的话，系统设置 → 通知 → Ripple 里那三个渠道名会一直是旧语言，
             * 而界面、Toast、通知栏按钮都已经切过去了 —— 同一个 App 里中英混排，
             * 且这个状态永远不会自愈（除非清数据/重装）。
             * ensureChannel 现在是幂等更新（见它的注释），重复调是安全的。
             */
            ensureChannel(true);
            ensureChannel(false);
            /*
             * 播放通知的动作按钮标题（上一首/暂停/下一首/喜欢）不在渠道里，
             * 而在 PlaybackService 的 MediaStyle 上，由它自己根据 L10n 重建；
             * 这里通知它一次，让常驻通知不用等下一首歌才换成新语言（M-12 的配合项）。
             */
            PlaybackService svc = PlaybackService.get();
            if (svc != null) svc.onLangChanged();
        } catch (Throwable ignored) {
        }
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

    /** 记录一次 JS 错误（落盘单独限速，避免一个每秒复发的错误把盘写爆） */
    @JavascriptInterface
    public void jsError(String msg, String stack) {
        try {
            LogBridge.addError(ctx, "JS-ERROR", msg + "\n" + (stack == null ? "" : stack));
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
        return canPostNotifications();
    }

    /**
     * 真正能不能发出一条通知（权限 + 系统总开关）。
     *
     * 抽出来给两处共用（L-16）：
     *   · notifyGranted() —— 网页查状态；
     *   · notify() —— 发之前先自检，没有权限就返回 false。
     * 两处共用一个判定，避免「状态页说已授权、发送却静默失败」这种自相矛盾。
     */
    private boolean canPostNotifications() {
        try {
            NotificationManager nm =
                    (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null || !nm.areNotificationsEnabled()) return false;
            /* Android 13 起多了运行时权限 POST_NOTIFICATIONS，总开关之外还要看它 */
            if (Build.VERSION.SDK_INT >= 33
                    && ctx.checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                       != PackageManager.PERMISSION_GRANTED) {
                return false;
            }
            return true;
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

    /**
     * 推送「进度基准点」，由原生侧按时间外推进度。
     *
     * @param progress 当前这一句的进度 0..1
     * @param lineDur  当前这一句的总时长（秒），<=0 表示未知（原生不退推）
     * @param rate     播放倍速
     * @param playing  是否正在播放（false 时原生冻结不推进）
     *
     * 与 setLyricProgress 的区别：那个是「一次性真值」，这个是「基准 + 自行外推」。
     * 后者是状态栏歌词的正确做法 —— 它要在**别的 App 前台**时也顺滑，
     * 而那时 WebView 的定时器基本停摆（见 LyricOverlay.setTiming 注释）。
     */
    @JavascriptInterface
    public void setLyricTiming(String progress, String lineDur, String rate, String playing) {
        try { act.setLyricTiming(progress, lineDur, rate, playing); } catch (Throwable ignored) {}
    }

    @JavascriptInterface
    public void updateLyricOverlay(String text) {
        try { act.updateLyricOverlay(text); } catch (Throwable ignored) {}
    }

    @JavascriptInterface
    public void hideLyricOverlay() {
        try { act.hideLyricOverlay(); } catch (Throwable ignored) {}
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

    /* ================= 检查更新 ================= */
    /*
     * 与其它桥方法不同的地方：这三个是**异步**的。
     *
     * 网页侧调用后立刻返回，结果通过 evaluateJavascript 回调
     * window.__rippleUpdate* 系列函数送回去。
     *
     * 为什么不用同步返回值：检查更新要发 HTTPS 请求，同步做会把 JS 桥线程
     * 卡住几秒（弱网下更久），而那条线程同时还在处理播放进度推送 ——
     * 用户会看到整个界面卡死。所以必须异步 + 回调。
     */

    /**
     * 检查更新。
     *
     * @param manual "true" = 用户在设置页主动点的，不做 6 小时节流
     */
    @JavascriptInterface
    public void checkUpdate(final String manual) {
        final boolean m = "true".equalsIgnoreCase(String.valueOf(manual).trim());
        LogBridge.add(ctx, "UPDATE", "checkUpdate called, manual=" + m);
        UpdateChecker.check(ctx, m, new UpdateChecker.ResultCb() {
            @Override
            public void onResult(boolean hasNew, String version, int code, String notes,
                                 String apkUrl, long size, String error) {
                try {
                    JSONObject o = new JSONObject();
                    o.put("hasNew", hasNew);
                    o.put("version", version == null ? "" : version);
                    o.put("code", code);
                    /* 正文可能很长（整份 CHANGELOG），只截一个够弹窗显示的摘要 */
                    o.put("notes", brief(notes, 600));
                    o.put("apkUrl", apkUrl == null ? "" : apkUrl);
                    o.put("size", size);
                    o.put("error", error == null ? "" : error);
                    String js = "window.__rippleUpdateChecked && window.__rippleUpdateChecked("
                            + o + ")";
                    act.runJs(js);
                } catch (Throwable e) {
                    LogBridge.add(ctx, "UPDATE", "callback failed: " + e);
                }
            }
        });
    }

    /**
     * 下载更新包。下载进度与完成都通过回调送回网页。
     *
     * @param url       APK 下载地址（来自 checkUpdate 的回调）
     * @param expectSize 期望字节数，0 = 不校验
     * @param version   版本名，用于给下载的文件命名
     */
    @JavascriptInterface
    public void downloadUpdate(final String url, final String expectSize, final String version) {
        long sz = 0;
        try { sz = Long.parseLong(String.valueOf(expectSize).trim()); } catch (Throwable ignored) {}
        LogBridge.add(ctx, "UPDATE", "downloadUpdate: " + version + " " + url);
        UpdateChecker.download(ctx, url, sz, version == null ? "new" : version,
                new UpdateChecker.DownloadCb() {
                    @Override
                    public void onProgress(int percent) {
                        try {
                            act.runJs("window.__rippleUpdateProgress && "
                                    + "window.__rippleUpdateProgress(" + percent + ")");
                        } catch (Throwable ignored) {}
                    }

                    @Override
                    public void onDone(File file) {
                        /*
                         * 下载完先问网页「现在就装吗」，而不是直接弹安装器。
                         *
                         * 理由：弹安装器会盖住整个屏幕，是一种很强的打断。
                         * 用户可能只是想先下好、等会儿再装；
                         * 也可能下载是自动触发的，不该突然跳走。
                         * 推一个路径给网页，由网页弹确认框决定何时调用 installUpdate。
                         */
                        try {
                            JSONObject o = new JSONObject();
                            o.put("ok", true);
                            o.put("path", file.getAbsolutePath());
                            o.put("size", file.length());
                            o.put("sha256", UpdateChecker.sha256(file));
                            act.runJs("window.__rippleUpdateDownloaded && "
                                    + "window.__rippleUpdateDownloaded(" + o + ")");
                            /* 同时记进待安装槽位，供 installUpdate() 无参调用 */
                            pendingApk = file;
                        } catch (Throwable e) {
                            LogBridge.add(ctx, "UPDATE", "onDone failed: " + e);
                        }
                    }

                    @Override
                    public void onError(String msg) {
                        try {
                            JSONObject o = new JSONObject();
                            o.put("ok", false);
                            o.put("error", msg == null ? "" : msg);
                            act.runJs("window.__rippleUpdateDownloaded && "
                                    + "window.__rippleUpdateDownloaded(" + o + ")");
                        } catch (Throwable ignored) {}
                    }
                });
    }

    /** 上一次下载好的安装包（供 installUpdate 无参调用） */
    private static File pendingApk = null;

    /** 拉起系统安装器安装刚下载的包 */
    @JavascriptInterface
    public void installUpdate() {
        final File f = pendingApk;
        if (f == null || !f.isFile()) {
            LogBridge.add(ctx, "UPDATE", "installUpdate: 没有待安装的包");
            try {
                /*
                 * 1.3.5 多语言：这个 msg 会被前端 toast 出来（__rippleUpdateInstallResult），
                 * 属于用户可见文案，所以要翻。
                 *
                 * 注意英文串里不能出现单引号：它被拼进一段用单引号包起来的 JS 字面量，
                 * 多一个 ' 就会让整个 evaluateJavascript 变成语法错误、回调反而丢了。
                 */
                act.runJs("window.__rippleUpdateInstallResult && "
                        + "window.__rippleUpdateInstallResult(false,'"
                        + L10n.t("没有待安装的包", "No update package is ready") + "')");
            } catch (Throwable ignored) {}
            return;
        }
        act.runOnUiThread(() -> {
            try {
                UpdateChecker.install(act, f);
                try {
                    act.runJs("window.__rippleUpdateInstallResult && "
                            + "window.__rippleUpdateInstallResult(true,'')");
                } catch (Throwable ignored) {}
            } catch (Throwable e) {
                LogBridge.add(ctx, "UPDATE", "installUpdate failed: " + e);
                try {
                    act.runJs("window.__rippleUpdateInstallResult && "
                            + "window.__rippleUpdateInstallResult(false,'"
                            + brief(String.valueOf(e), 120).replace("'", " ") + "')");
                } catch (Throwable ignored) {}
            }
        });
    }

    /** 当前版本信息（网页侧显示用；比读 version.js 更准，因为来自安装包本身） */
    @JavascriptInterface
    public String updateCurrentVersion() {
        try {
            JSONObject o = new JSONObject();
            o.put("code", UpdateChecker.currentCode(ctx));
            o.put("name", UpdateChecker.currentName(ctx));
            return o.toString();
        } catch (Throwable e) {
            return "{}";
        }
    }

    /**
     * 把长正文压成适合弹窗的摘要。
     *
     * Release 正文包含整份 CHANGELOG（上千行），直接塞进弹窗会撑爆界面，
     * 也不适合当通知内容。这里保留开头若干行，中间转折处补一个省略号。
     */
    private static String brief(String s, int max) {
        if (s == null) return "";
        String t = s.trim();
        if (t.length() <= max) return t;
        return t.substring(0, max).trim() + "…";
    }
}
