package com.ripple.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import java.io.InputStream;
import java.lang.ref.WeakReference;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 媒体播放通知（前台服务）。
 *
 * 为什么要单独一个 Service：
 *   · 只有前台服务里的媒体会话，Android 才会把通知固定在通知栏、
 *     并且允许锁屏和耳机键控制（普通通知会被划掉、也拿不到媒体键）。
 *   · 通知的**外观**由系统按 MediaSession 的元数据渲染，
 *     封面/标题/歌手/播放暂停/上一首下一首/进度条都是系统给的，
 *     第三方的自绘按钮（比如网易云那个「词」）是它自己画的自定义 RemoteViews，我们做不了。
 *
 * 与控制端的分工：
 *   Java 只负责「展示 + 把用户动作转给网页」，真正的播放逻辑仍然在 WebView 里。
 *   JS 通过 RippleNative.mediaState(...) 上报状态，Java 把按钮回调通过
 *   evaluateJavascript 发回页面的 window.__rippleMediaCmd(cmd)。
 */
public class PlaybackService extends Service {

    public static final String CH_PLAYING = "ripple_now_playing";
    public static final int NOTIF_ID = 0x9A01;

    /**
     * 无主自动退出：Sink 为 null（Activity 已销毁）且连续这么久没有收到任何
     * 网页上报，就认为已经没人控制播放了，自己 stopAndQuit()。
     *
     * E-06：前端从不调 mediaStop()，退出 App 后服务会被 FGS 一直保活，
     * 通知栏留下一条滑不掉、按钮全失效的「正在播放」。
     * 这里是最外层兜底 —— 即使 Activity 的 onDestroy 没走到，也能自己收尾。
     */
    private static final long IDLE_EXIT_MS = 5000;

    /** 网页侧的指令入口（由 MainActivity 注入的回调转发） */
    public interface Sink {
        void onMediaCommand(String cmd);
        void onSeekTo(long ms);
    }

    private static PlaybackService instance;
    /**
     * 网页侧回调。必须是弱引用：原来的静态强引用会让服务一直持有已销毁的
     * MainActivity（连同整棵 View 树），反复进出 App 就一路泄漏到 OOM。
     */
    private static WeakReference<Sink> sinkRef;

    private MediaSession session;
    private final Handler main = new Handler(Looper.getMainLooper());

    /* 当前展示状态（由网页上报）。只在主线程读写，见各入口的注释。 */
    private String title = "";
    private String artist = "";
    private String album = "";
    private String coverUrl = "";
    private long duration = 0;
    private long position = 0;
    private boolean playing = false;
    private Bitmap coverBmp;
    private String coverLoadedFor = "";
    /*
     * ===== L-14：封面下载的并发与代次 =====
     *
     * 旧实现每次换歌都 `new Thread(...).start()`，没有并发上限；
     * 快速切歌（连播/电台/随机）会同时拉起十几条线程，每条做一次 HTTPS
     * + 一次**不限尺寸**的 decodeStream（上游给 2000x2000 就照着分配 16MB），
     * 而最后只有最后一张留下来，其余全白做 —— 峰值内存被抬得很高，低端机直接 LMK。
     *
     * 现在：
     *   · 固定 2 条 daemon 线程：同时最多两张大图在解，排队的不占内存；
     *   · coverGen 代次号：每次换歌 +1，在飞的任务回主线程后发现代次变了就丢弃，
     *     连 updateMetadata/pushNotification 都不必做；
     *   · decode 用 inSampleSize 限到 1024px 以内，够通知栏/锁屏用（系统自己还会再缩）。
     * releaseCover() 也会推进代次，让在飞结果失效（否则「刚释放又写回来」）。
     */
    private static final int COVER_MAX_PX = 1024;
    private static final ExecutorService COVER_POOL =
            Executors.newFixedThreadPool(2, r -> {
                Thread t = new Thread(r, "ripple-cover");
                t.setDaemon(true);
                return t;
            });
    private volatile int coverGen = 0;
    private boolean foregroundStarted = false;

    /*
     * R-06：通知构建结果缓存。
     * 以前 updateProgress() 每秒都 pushNotification() → buildNofitication()，
     * 也就是每秒重建一次 MediaStyle + 4 个 Action + PendingIntent。
     * 现在只有「这些字段变了」才重建，进度只走 setPlaybackState（系统自己插值）。
     */
    private String lastNotifKey = null;

    /** 最近一次收到网页上报的时间；超过 IDLE_EXIT_MS 且没有 Sink 就自杀 */
    private long lastReportAt = 0;
    private final Runnable idleCheck = new Runnable() {
        @Override
        public void run() {
            try {
                if (sink() != null) {
                    // 还有人控制，继续看
                    lastReportAt = System.currentTimeMillis();
                    main.postDelayed(this, IDLE_EXIT_MS);
                    return;
                }
                long idle = System.currentTimeMillis() - lastReportAt;
                /*
                 * 审查 1.3.8 · M-14：sink 为 null **不等于**「没人要这个服务」。
                 *
                 * sink 是 WeakReference<MainActivity>，Activity 被系统回收
                 * （内存紧张 / 多任务里被划走）后它就自动变 null —— 但播放
                 * 可能还在继续，网页线程也还在每秒上报。以前这里只看
                 * 「sink == null 且 idle 够久」，于是 Activity 一被回收，
                 * 5 秒后服务自杀、通知消失：用户看到「后台播放被杀了」，
                 * 实际上是 App 自己收的。
                 *
                 * 现在多一道判据：**只要还在播放就不自杀**。
                 * 真正的「用户退出」由 MainActivity.onDestroy 的 userExiting
                 * 分支显式调 stopAndQuit() 收尾（M-15 已改），服务不需要
                 * 靠超时来猜测用户意图。
                 */
                if (playing) {
                    lastReportAt = System.currentTimeMillis();
                    main.postDelayed(this, IDLE_EXIT_MS);
                    return;
                }
                if (lastReportAt > 0 && idle >= IDLE_EXIT_MS) {
                    LogBridge.add(PlaybackService.this, "MEDIA",
                            "无人上报且无控制端且未在播放，自动退出（idle=" + idle + "ms）");
                    stopAndQuit();
                    return;
                }
                main.postDelayed(this, IDLE_EXIT_MS);
            } catch (Throwable ignored) {
            }
        }
    };

    public static void setSink(Sink s) {
        sinkRef = s == null ? null : new WeakReference<>(s);
    }

    /** 取当前还活着的回调（Activity 已被回收时返回 null） */
    private static Sink sink() {
        WeakReference<Sink> r = sinkRef;
        return r == null ? null : r.get();
    }

    public static boolean isRunning() {
        return instance != null;
    }

    /** 拿当前活着的服务实例（没起就返回 null） */
    public static PlaybackService get() {
        return instance;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        try {
            createChannel();
            session = new MediaSession(this, "Ripple");
            session.setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS
                    | MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS);
            session.setCallback(new MediaSession.Callback() {
                @Override
                public void onPlay() {
                    send("play");
                }

                @Override
                public void onPause() {
                    send("pause");
                }

                @Override
                public void onSkipToNext() {
                    send("next");
                }

                @Override
                public void onSkipToPrevious() {
                    send("prev");
                }

                @Override
                public void onStop() {
                    send("stop");
                }

                @Override
                public void onSeekTo(long pos) {
                    Sink s = sink();
                    if (s != null) s.onSeekTo(pos);
                }
            });
            updatePlaybackState();
            LogBridge.add(this, "MEDIA", "service created");
        } catch (Throwable e) {
            CrashLog.recordAsync(this, "media-create", e);
        }
        // E-06 兜底：没有控制端且长时间没有上报就自己退出，不让 FGS 白养进程
        lastReportAt = System.currentTimeMillis();
        main.postDelayed(idleCheck, IDLE_EXIT_MS);
    }

    private void send(String cmd) {
        Sink s = sink();
        if (s != null) s.onMediaCommand(cmd);
    }

    /**
     * 建 / 更新播放通知渠道（幂等）。
     *
     * H-8：**不能**写成「渠道已存在就 return」。
     * createNotificationChannel() 对已存在的渠道是「更新 name / description」——
     * 这正是切语言后渠道名能跟着变的唯一手段。以前这里有一句
     * `if (ch != null) return;`，于是系统设置里的渠道名永远是首次创建时那个语言。
     * 现在的调用时机：onCreate（首次）、onLangChanged（切语言）、
     * update()（每次状态上报，成本只是几次字符串拼接，但能兜住漏网的路径）。
     */
    private void createChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        NotificationChannel ch = new NotificationChannel(CH_PLAYING,
                // 1.3.5 多语言：渠道名/描述用户在系统设置里能直接看到，必须跟着语言走
                L10n.t("正在播放", "Now playing"), NotificationManager.IMPORTANCE_LOW);
        ch.setDescription(L10n.t("媒体播放控制，不发声",
                "Playback controls, no sound"));
        ch.setSound(null, null);
        ch.enableVibration(false);
        ch.setShowBadge(false);
        ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(ch);   // 每次都调：已存在时即「改名」
    }

    /**
     * 语言切换回调（由 HttpBridge.setLang 调用，H-8 / M-12）。
     *
     * 做两件事：
     *   ① 刷新渠道名（系统设置里那一条）；
     *   ② 让常驻通知按新语言重建一次 —— 动作按钮标题（上一首/暂停/下一首/喜欢）
     *      是 buildNofitication() 里用 L10n.t 现取的，而 notifKey 现在含语言位
     *      （见 notifKey），所以只要把指纹清掉再 push 一次就会重建，
     *      不用等下一首歌。
     */
    void onLangChanged() {
        main.post(() -> {
            try {
                createChannel();
                lastNotifKey = null;
                if (foregroundStarted) pushNotification();
            } catch (Throwable ignored) {
            }
        });
    }

    /* ================= 网页上报 ================= */

    /**
     * 由 JS 调用：更新通知里的曲目信息与进度。
     * 参数都做成字符串，避免 @JavascriptInterface 的类型歧义。
     *
     * R-10：入口统一切回主线程，字段只在主线程读写。
     */
    public void update(final String title, final String artist, final String album,
                       final String coverUrl, final String durationMs,
                       final String positionMs, final boolean playing) {
        main.post(() -> {
            try {
                lastReportAt = System.currentTimeMillis();
                this.title = nz(title);
                this.artist = nz(artist);
                this.album = nz(album);
                this.duration = parseLong(durationMs);
                this.position = parseLong(positionMs);
                this.playing = playing;
                if (!nz(coverUrl).equals(this.coverUrl)) {
                    this.coverUrl = nz(coverUrl);
                    this.coverBmp = null;
                    this.coverLoadedFor = "";
                    loadCoverAsync(this.coverUrl);
                }
                updateMetadata();
                updatePlaybackState();
                pushNotification();
            } catch (Throwable e) {
                CrashLog.recordAsync(this, "media-update", e);
            }
        });
    }

    /**
     * 当前是否正在播放。
     *
     * 审查 1.3.8 · M-15 需要它：MainActivity.onDestroy() 要区分
     * 「用户真的退出了」与「系统把 Activity 回收了但播放还在继续」——
     * 判据就是这条。以前 onDestroy 无条件 stopService，于是
     * 后台播放被系统回收 Activity 时，通知与控制入口一起消失，
     * 用户看到的是「后台播放被杀了」。
     *
     * 只读 volatile 之外的字段，必须回主线程读：playing 是主线程写的普通字段。
     * 这里做成同步 getter 会跨线程读非 volatile 字段 —— 所以直接在主线程调用
     * （onDestroy 就在主线程）。
     */
    public boolean isPlaying() {
        return playing;
    }

    /** 只更新进度（每秒一次），成本更低 */
    public void updateProgress(final String positionMs, final String durationMs, final boolean playing) {
        main.post(() -> {
            try {
                lastReportAt = System.currentTimeMillis();
                final boolean wasPlaying = this.playing;
                this.position = parseLong(positionMs);
                long d = parseLong(durationMs);
                if (d > 0) this.duration = d;
                this.playing = playing;
                /*
                 * J-02 的自愈口径：updateProgress 只带进度，不带标题/歌手/封面。
                 * 如果首条 mediaState 因为服务实例还没就绪而丢了（MainActivity 侧
                 * 只等固定延时的那段历史实现），后面每秒的进度上报会把状态推到通知栏，
                 * 但标题永远是空的 → 通知栏长期显示「Ripple 涟漪 · 未在播放」。
                 * 这里给一条兜底日志，让排查时能一眼看出「元数据确实没收到过」，
                 * 而不是误以为标题丢失是通知构建的问题。真正的补齐由 MainActivity
                 * 的重试逻辑负责（它手里有完整字段）。
                 */
                if (title.isEmpty() && wasPlaying != playing) {
                    LogBridge.add(PlaybackService.this, "MEDIA",
                            "进度上报早于完整元数据（title 仍为空），等 mediaState 补齐");
                }
                /*
                 * 每秒都要把最新的 position 交给 MediaSession。
                 * 以前只在 playing 变化时才重建 PlaybackState，而系统靠 setState 里的
                 * position 做进度插值 —— 于是锁屏/通知栏的进度条长期停滞或跳变。
                 */
                updatePlaybackState();
                /*
                 * R-06：进度变了**不重建通知** —— 通知只展示标题/歌手/封面/播放态，
                 * 进度条由系统的 MediaStyle 按 PlaybackState 自己插值。
                 * 只有播放态真的翻转（播放/暂停图标要换）时才需要重画，
                 * 这里直接比较布尔值，连指纹字符串都不用拼。
                 */
                if (wasPlaying == playing) return;
                pushNotification();
            } catch (Throwable e) {
                /* 进度更新失败不打扰 */
            }
        });
    }

    /**
     * 退出前把「前台」坐实。
     *
     * J-01 ②：只要 startForegroundService() 已经发出去，系统就记了一笔
     * 「5 秒内必须 startForeground()」的账。直接 stopSelf() 并不会撤销这笔账 ——
     * 到点仍然抛 ForegroundServiceDidNotStartInTimeException 把进程杀掉，
     * 而这条异常是在系统线程里抛的，我们的 try-catch 接不住。
     * 所以任何退出路径都先补一次 enterForeground（哪怕通知内容是最空的那份），
     * 把账平掉，再走 stopForeground + stopSelf 的正常收尾。
     *
     * @return 是否成功进到前台（失败也照样继续退出，只是留一条日志）
     */
    private boolean settleForegroundBeforeExit(String why) {
        if (foregroundStarted) return true;
        try {
            enterForeground(buildNofitication());
            foregroundStarted = true;
            return true;
        } catch (Throwable e) {
            LogBridge.add(this, "MEDIA", "退出前补 startForeground 失败（" + why + "，尽力而为）: " + e);
            return false;
        }
    }

    /** 收尾：撤前台 → 撤会话 → 放引用 → stopSelf。退出路径共用，避免两处漏改 */
    private void finishAndStopSelf() {
        try {
            if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE);
            else stopForeground(true);
        } catch (Throwable ignored) {
        }
        try {
            if (session != null) {
                session.setActive(false);
                session.release();
                session = null;
            }
        } catch (Throwable ignored) {
        }
        foregroundStarted = false;
        lastNotifKey = null;
        releaseCoverRefOnly();
        stopSelf();
    }

    public void stopAndQuit() {
        main.post(() -> {
            try {
                main.removeCallbacks(idleCheck);
            } catch (Throwable ignored) {
            }
            settleForegroundBeforeExit("stopAndQuit");
            finishAndStopSelf();
        });
    }

    /**
     * O-04：释放封面位图（系统内存吃紧时由 Activity 调）。
     * 下一次重新上报会重新下载，不影响可播放性。
     *
     * 注意**不**调 bitmap.recycle()：同一个 Bitmap 已经通过 MediaMetadata
     * 交给系统的 MediaSession，跨进程还在用。真正回收它会让通知栏/锁屏
     * 在重绘时拿到一块已释放的内存（部分 ROM 上直接崩）。
     * 只把引用放掉，交给 GC 即可。
     */
    public void releaseCover() {
        main.post(() -> {
            try {
                /*
                 * L-14：推进代次，让**已经在飞**的封面任务失效。
                 * 只把 coverBmp 置空是不够的：那些线程手里已经下载/解码好的图
                 * 会在回到主线程时发现 `want.equals(coverUrl)` 仍然成立
                 * （coverUrl 没变，只是我们要释放内存），于是又把图写回来 ——
                 * 表现就是「系统内存吃紧 → 释放封面 → 一下子又占回去」。
                 */
                coverGen++;
                coverBmp = null;
                coverLoadedFor = "";
                // 通知里还挂着这张图，重画一次去掉它
                lastNotifKey = null;
                if (foregroundStarted) pushNotification();
            } catch (Throwable ignored) {
            }
        });
    }

    @Override
    public void onDestroy() {
        instance = null;
        try {
            main.removeCallbacks(idleCheck);
        } catch (Throwable ignored) {
        }
        /*
         * 系统因内存压力回收服务时走的是 onDestroy，不是 stopAndQuit()。
         * 原来这里不 stopForeground，通知栏就会留下一条点不动的「正在播放」僵尸通知。
         *
         * J-01 ②：同样要先平掉「等 startForeground」那笔账 —— 如果这时
         * foregroundStarted 还是 false，说明 startForegroundService 发出的账还没销，
         * 直接销毁服务照样会在 5 秒到点后抛系统异常。补一次再撤。
         */
        settleForegroundBeforeExit("onDestroy");
        try {
            if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE);
            else stopForeground(true);
        } catch (Throwable ignored) {
        }
        foregroundStarted = false;
        lastNotifKey = null;
        setSink(null);
        try {
            if (session != null) { session.release(); session = null; }
        } catch (Throwable ignored) {
        }
        // 只放引用，不 recycle：这个 Bitmap 已经交给系统的 MediaSession（见 releaseCover）
        coverBmp = null;
        super.onDestroy();
    }

    /**
     * 显式声明前台服务类型。
     * targetSdk 34 下类型主要靠 manifest 声明，但官方建议运行时也传一次，
     * 避免两边不一致时抛 IllegalArgumentException。
     */
    private void enterForeground(Notification n) {
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIF_ID, n, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } else {
            startForeground(NOTIF_ID, n);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        /*
         * Android 8+ 要求 startForegroundService() 之后 5 秒内必须 startForeground()，
         * 否则直接抛 ANR/ForegroundServiceDidNotStartInTimeException（我们会被系统杀掉）。
         * 而正常流程要等网页上报状态才发通知，中间可能超过 5 秒 ——
         * 所以这里先发一条「正在准备」的空通知把前台坐实，之后再覆盖。
         *
         * R-12：这里也是「上一次 startForeground 失败」的重试点 ——
         * 通知权限/前台服务被系统拒绝时，至少留下日志，并在下一次
         * startService（比如通知栏按钮）时再试一次，而不是永久静默。
         */
        lastReportAt = System.currentTimeMillis();
        if (!foregroundStarted) {
            try {
                enterForeground(buildNofitication());
                foregroundStarted = true;
            } catch (Throwable e) {
                CrashLog.recordAsync(this, "media-fg", e);
                LogBridge.add(this, "MEDIA", "startForeground 失败，300ms 后重试: " + e);
                /* 首次失败先等一拍：通知渠道可能刚建好，ROM 首次绘制也可能还没就绪 */
                main.postDelayed(this::retryForeground, 300);
            }
        }
        // 通知里那三个按钮是 PendingIntent → getService，命令从这里进来
        try {
            if (intent != null && "com.ripple.app.MEDIA_CMD".equals(intent.getAction())) {
                String cmd = intent.getStringExtra("cmd");
                LogBridge.add(this, "MEDIA", "notification action: " + cmd);
                if ("toggle".equals(cmd)) send(playing ? "pause" : "play");
                else if (cmd != null) send(cmd);
            }
        } catch (Throwable e) {
            CrashLog.recordAsync(this, "media-cmd", e);
        }
        // 被系统杀掉后不要自己重启（播放逻辑在网页里）
        return START_NOT_STICKY;
    }

    /**
     * 重试进前台。
     *
     * Android 8+ 的硬约束是「startForegroundService() 之后 **5 秒内**必须 startForeground() 成功」，
     * 超时由系统抛 ForegroundServiceDidNotStartInTimeException（12+）/ RemoteServiceException（8-11），
     * try-catch 捕不住 —— 是系统在另一条线程上判定的。
     *
     * 所以重试节奏必须压在 5 秒以内（J-01）。实际时间线：
     *   onStartCommand 首次失败 → 300ms → 重试 1 失败 → 300ms → 重试 2 失败
     *   → 700ms → 重试 3 失败 → 立刻 fgGiveUp()（累计约 1.3 秒，离 5 秒还有富余）。
     * 首次用 300ms 而不是「等一秒再说」：多数瞬时失败（通知渠道刚建、
     * ROM 首次绘制未就绪）一次就过，等太久反而把 5 秒预算花在空转上。
     * 老实现是 `1500ms` 起步、`2000L * fgRetries` 递增，第三次落在 T+7.5s ——
     * 重试还没跑，进程已经被系统杀掉了，属于「看起来在兜底，实际兜不住」。
     *
     * 放弃时主动 stopSelf() 同样重要：服务不再被系统盯着要 startForeground，
     * 不会因为「FGS 超时」被异常杀掉；网页侧每秒还会继续上报，下次上报会重新
     * startForegroundService 再试一轮（MainActivity 那条路），于是通知能自愈。
     */
    private int fgRetries = 0;

    private void retryForeground() {
        if (foregroundStarted) return;
        if (fgRetries >= 3) {
            LogBridge.add(this, "MEDIA", "startForeground 重试 3 次仍失败，主动退出服务避免被系统判超时杀掉");
            fgGiveUp();
            return;
        }
        fgRetries++;
        try {
            enterForeground(buildNofitication());
            foregroundStarted = true;
            LogBridge.add(this, "MEDIA", "startForeground 第 " + fgRetries + " 次重试成功");
        } catch (Throwable e) {
            LogBridge.add(this, "MEDIA", "startForeground 重试 " + fgRetries + " 失败: " + e);
            if (fgRetries >= 3) {
                LogBridge.add(this, "MEDIA", "3 次重试均失败（通知权限/前台服务被系统限制），主动退出服务");
                fgGiveUp();
                return;
            }
            main.postDelayed(this::retryForeground, fgRetries == 1 ? 300L : 700L);
        }
    }

    /**
     * 放弃进前台时的收尾：**不**留下一个「被系统认为还没 startForeground」的服务。
     * 直接 stopSelf()，让网页侧下一次上报重新拉起（见 retryForeground 的注释）。
     *
     * 注意这里刻意不调 stopForeground()：根本没成功进过前台，调它没有意义，
     * 某些 ROM 上还会因为状态机不一致抛异常。
     */
    private void fgGiveUp() {
        try {
            main.removeCallbacks(idleCheck);
        } catch (Throwable ignored) {
        }
        foregroundStarted = false;
        lastNotifKey = null;
        try {
            if (session != null) {
                session.setActive(false);
                session.release();
                session = null;
            }
        } catch (Throwable ignored) {
        }
        releaseCoverRefOnly();
        stopSelf();
    }

    /** 只放掉封面引用（不重画通知）—— 给「服务要退出了」的路径用 */
    private void releaseCoverRefOnly() {
        coverBmp = null;
        coverLoadedFor = "";
    }

    /* ================= 内部 ================= */

    private static String nz(String s) {
        return s == null ? "" : s;
    }

    private static long parseLong(String s) {
        try { return Long.parseLong(String.valueOf(s).trim()); } catch (Throwable e) { return 0; }
    }

    private void updateMetadata() {
        if (session == null) return;
        try {
            MediaMetadata.Builder b = new MediaMetadata.Builder()
                    .putString(MediaMetadata.METADATA_KEY_TITLE, title)
                    .putString(MediaMetadata.METADATA_KEY_ARTIST, artist)
                    .putString(MediaMetadata.METADATA_KEY_ALBUM, album)
                    .putLong(MediaMetadata.METADATA_KEY_DURATION, duration);
            if (coverBmp != null) {
                b.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, coverBmp);
                b.putBitmap(MediaMetadata.METADATA_KEY_ART, coverBmp);
            }
            session.setMetadata(b.build());
            session.setActive(true);
        } catch (Throwable e) {
            CrashLog.recordAsync(this, "media-meta", e);
        }
    }

    private void updatePlaybackState() {
        if (session == null) return;
        try {
            /*
             * 暂停且 position=0（刚从列表里点开、还没播）以前报 STATE_NONE。
             * 部分 ROM 拿到 STATE_NONE 就不渲染进度条、连按钮都灰掉，
             * 而这时用户明明已经选好歌了（U-07）。STATE_PAUSED 语义更准：
             * 「非播放中，但有曲目、可以开始」。STATE_NONE 只留给「根本没有曲目」。
             */
            int state = playing
                    ? PlaybackState.STATE_PLAYING
                    : (title.isEmpty() ? PlaybackState.STATE_NONE : PlaybackState.STATE_PAUSED);
            long actions = PlaybackState.ACTION_PLAY
                    | PlaybackState.ACTION_PAUSE
                    | PlaybackState.ACTION_PLAY_PAUSE
                    | PlaybackState.ACTION_SKIP_TO_NEXT
                    | PlaybackState.ACTION_SKIP_TO_PREVIOUS
                    | PlaybackState.ACTION_SEEK_TO
                    | PlaybackState.ACTION_STOP;
            session.setPlaybackState(new PlaybackState.Builder()
                    .setActions(actions)
                    .setState(state, position, playing ? 1f : 0f)
                    .build());
        } catch (Throwable e) {
            CrashLog.recordAsync(this, "media-state", e);
        }
    }

    /** 封面下载：只认 http(s)，失败就不带封面（不影响控件可用） */
    private void loadCoverAsync(final String url) {
        if (url == null || url.isEmpty()) return;
        if (!url.startsWith("http://") && !url.startsWith("https://")) return;
        if (url.equals(coverLoadedFor)) return;
        final String want = url;
        /*
         * L-14：代次号必须在这里**递增并捕获**。
         * 调用点都在主线程（update → main.post），所以 ++ 是安全的；
         * 任务回到主线程时比对 gen != coverGen 就能判断「期间又换歌了」。
         * 旧代码只比 want.equals(coverUrl)，但同一张图被重新上报时
         * coverUrl 不变，旧结果会被当成有效 —— 代次更严格。
         */
        final int gen = ++coverGen;
        COVER_POOL.execute(() -> {
            Bitmap bmp = null;
            HttpURLConnection c = null;
            try {
                c = (HttpURLConnection) new URL(want).openConnection();
                c.setConnectTimeout(6000);
                c.setReadTimeout(8000);
                c.setRequestProperty("User-Agent", "Mozilla/5.0 (Android) RippleApp");
                byte[] raw;
                try (InputStream in = c.getInputStream()) {
                    raw = readAll(in);
                }
                bmp = decodeCover(raw);
            } catch (Throwable e) {
                /* 静默失败：封面缺失不影响任何控件 */
            } finally {
                if (c != null) c.disconnect();
            }
            final Bitmap got = bmp;
            main.post(() -> {
                if (got == null) return;
                /* 代次变了（期间又换歌 / releaseCover）→ 这张已经没用了，直接丢 */
                if (gen != coverGen) return;
                if (!want.equals(coverUrl)) return;
                coverBmp = got;
                coverLoadedFor = want;
                updateMetadata();
                pushNotification();
            });
        });
    }

    /**
     * 按上限采样解码封面（L-14）。
     *
     * 为什么先读成 byte[] 再解两次：
     * 量尺寸要用 inJustDecodeBounds，而它会把流消费掉；重开一次 HTTPS 连接
     * 只为再解一次不划算，也不利于复用 keep-alive。把原始字节留在内存里
     * （封面通常 50~300KB）比「按原图尺寸解码出一张 2000x2000 = 16MB 的位图」便宜得多。
     *
     * inSampleSize 只需保证「最长边 <= COVER_MAX_PX」：通知栏/锁屏最终
     * 只渲染一两百 px，1024px 已经绰绰有余，而每翻一倍采样就省 4 倍内存。
     */
    private static Bitmap decodeCover(byte[] raw) {
        if (raw == null || raw.length == 0) return null;
        try {
            BitmapFactory.Options probe = new BitmapFactory.Options();
            probe.inJustDecodeBounds = true;
            BitmapFactory.decodeByteArray(raw, 0, raw.length, probe);
            int side = Math.max(probe.outWidth, probe.outHeight);
            int sample = 1;
            while (side > 0 && side / sample > COVER_MAX_PX) sample *= 2;
            BitmapFactory.Options dec = new BitmapFactory.Options();
            dec.inSampleSize = sample;
            return BitmapFactory.decodeByteArray(raw, 0, raw.length, dec);
        } catch (Throwable e) {
            return null;
        }
    }

    /** 读满一个流（封面体积有上限，不设额外限制；异常时返回已读部分） */
    private static byte[] readAll(InputStream in) throws java.io.IOException {
        java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream(64 * 1024);
        byte[] buf = new byte[16 * 1024];
        int n;
        while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
        return bos.toByteArray();
    }

    private PendingIntent contentIntent() {
        try {
            Intent it = new Intent(this, MainActivity.class);
            it.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            int flags = Build.VERSION.SDK_INT >= 23
                    ? PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
                    : PendingIntent.FLAG_UPDATE_CURRENT;
            return PendingIntent.getActivity(this, 0, it, flags);
        } catch (Throwable e) {
            return null;
        }
    }

    @SuppressWarnings("deprecation")
    private Notification buildNofitication() {
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= 26) {
            b = new Notification.Builder(this, CH_PLAYING);
        } else {
            b = new Notification.Builder(this);
        }
        // 1.3.5 多语言：兜底文案也翻。英文态下标题直接用产品名，不再拼「涟漪」
        b.setContentTitle(title.isEmpty() ? L10n.t("Ripple 涟漪", "Ripple") : title)
                .setContentText(artist.isEmpty() ? L10n.t("未在播放", "Nothing playing") : artist)
                // U-28：自带单色矢量图标，系统 android.R.drawable.ic_media_play 在部分 ROM 上会被 tint 成白块
                .setSmallIcon(R.drawable.ic_stat_music)
                /*
                 * J-04：暂停态也固定为 ongoing，与主流播放器一致。
                 * 以前是 setOngoing(playing)：暂停时通知可被划掉，但服务仍是前台服务、
                 * idleCheck 的自杀条件又被「App 开着 → sink 非 null」挡着不肯退，
                 * 于是「通知没了、服务还在」—— 用户回 App 点播放时通知栏一度没有控件入口，
                 * 进程还被 FGS 白养着。固定 ongoing 后暂停态也留一条控制入口；
                 * 真要撤掉通知就只能走 stopAndQuit / onDestroy（它们会 stopForeground）。
                 */
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .setSound(null)
                .setVisibility(Notification.VISIBILITY_PUBLIC);
        PendingIntent pi = contentIntent();
        if (pi != null) b.setContentIntent(pi);

        if (Build.VERSION.SDK_INT >= 21) {
            Notification.MediaStyle style = new Notification.MediaStyle()
                    .setShowActionsInCompactView(0, 1, 2);
            // session 可能是 null（onCreate 失败/已释放），此时退化成普通通知
            if (session != null) {
                try { style.setMediaSession(session.getSessionToken()); } catch (Throwable ignored) {}
            }
            b.setStyle(style);
            /*
             * 1.3.5 多语言：四个动作标题会被 TalkBack 朗读，也是紧凑视图的长按提示，
             * 所以必须跟着语言走。英文刻意用单词（Previous/Pause/Next/Like），
             * 通知栏这两处空间都很窄，长句会被截成省略号。
             */
            Notification.Action prev = new Notification.Action.Builder(
                    android.R.drawable.ic_media_previous, L10n.t("上一首", "Previous"),
                    cmdIntent("prev")).build();
            Notification.Action toggle = new Notification.Action.Builder(
                    playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                    playing ? L10n.t("暂停", "Pause") : L10n.t("播放", "Play"),
                    cmdIntent("toggle")).build();
            Notification.Action next = new Notification.Action.Builder(
                    android.R.drawable.ic_media_next, L10n.t("下一首", "Next"),
                    cmdIntent("next")).build();
            /*
             * 第 8 条：通知栏加「喜欢」。
             * 系统 drawable 里没有心形，所以自带一个 ic_heart 矢量图。
             * 点击后通过 cmdIntent("like") 回到网页，由 __rippleMediaCmd 处理 ——
             * 收藏逻辑（含未登录提示）仍然只有网页那一份，不重复实现。
             */
            Notification.Action like = new Notification.Action.Builder(
                    R.drawable.ic_heart, L10n.t("喜欢", "Like"), cmdIntent("like")).build();
            /* 用户要求「喜欢」放在最右边：上一首 / 播放暂停 / 下一首 / 喜欢 */
            b.addAction(prev).addAction(toggle).addAction(next).addAction(like);
            // 紧凑视图放前三个常用键；喜欢在最右侧的展开区
            style.setShowActionsInCompactView(0, 1, 2);
            if (coverBmp != null) b.setLargeIcon(coverBmp);
        }
        return b.build();
    }

    /**
     * 通知内容的「指纹」。
     *
     * R-06：只有它变化时才重建通知。位置/时长**故意不进指纹** ——
     * 进度条由系统根据 PlaybackState 插值，重建通知并不能让它更流畅，
     * 反而每秒都新建一次 MediaStyle + 4 个 Action + 4 个 PendingIntent。
     *
     * M-12：语言必须进指纹。
     * 四个动作按钮的标题是 buildNofitication() 里用 L10n.t 现取的中英文案；
     * 语言变了但 title/artist/playing 都没变时，指纹一样 → pushNotification
     * 早退 → 通知栏按钮还是旧语言，要等下一首歌才自愈。
     * 把语言位掺进来，切语言那一下就会判定「内容变了」而立即重建。
     * 顺带也让 L10n.isEnglish()（原先是零调用的死方法）在真实逻辑里生效。
     */
    private String notifKey() {
        return title + "\u0001" + artist + "\u0001" + album
                + "\u0001" + (playing ? "1" : "0")
                + "\u0001" + (coverBmp != null ? System.identityHashCode(coverBmp) : 0)
                + "\u0001" + (L10n.isEnglish() ? "en" : "zh");
    }

    private PendingIntent cmdIntent(String cmd) {
        Intent it = new Intent(this, PlaybackService.class);
        it.setAction("com.ripple.app.MEDIA_CMD");
        it.putExtra("cmd", cmd);
        int flags = Build.VERSION.SDK_INT >= 23
                ? PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
                : PendingIntent.FLAG_UPDATE_CURRENT;
        return PendingIntent.getService(this, cmd.hashCode(), it, flags);
    }

    private void pushNotification() {
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            /*
             * R-06：内容没变就不重建。
             * 通知已经在前台/通知栏里、且指纹一致 → 直接返回。
             * foregroundStarted 为 false 时必须继续走（还要把它坐实成前台服务）。
             */
            final String key = notifKey();
            if (foregroundStarted && key.equals(lastNotifKey)) return;
            Notification n = buildNofitication();
            if (!foregroundStarted) {
                enterForeground(n);
                foregroundStarted = true;
            } else {
                nm.notify(NOTIF_ID, n);
            }
            lastNotifKey = key;
        } catch (Throwable e) {
            CrashLog.recordAsync(this, "media-notify", e);
            LogBridge.add(this, "MEDIA", "notify failed: " + e);
        }
    }
}
