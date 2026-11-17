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
                if (lastReportAt > 0 && idle >= IDLE_EXIT_MS) {
                    LogBridge.add(PlaybackService.this, "MEDIA",
                            "无人上报且无控制端，自动退出（idle=" + idle + "ms）");
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
            CrashLog.record(this, "media-create", e);
        }
        // E-06 兜底：没有控制端且长时间没有上报就自己退出，不让 FGS 白养进程
        lastReportAt = System.currentTimeMillis();
        main.postDelayed(idleCheck, IDLE_EXIT_MS);
    }

    private void send(String cmd) {
        Sink s = sink();
        if (s != null) s.onMediaCommand(cmd);
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        NotificationChannel ch = nm.getNotificationChannel(CH_PLAYING);
        if (ch != null) return;
        ch = new NotificationChannel(CH_PLAYING, "正在播放", NotificationManager.IMPORTANCE_LOW);
        ch.setDescription("媒体播放控制，不发声");
        ch.setSound(null, null);
        ch.enableVibration(false);
        ch.setShowBadge(false);
        ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(ch);
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
                CrashLog.record(this, "media-update", e);
            }
        });
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

    public void stopAndQuit() {
        main.post(() -> {
            try {
                main.removeCallbacks(idleCheck);
            } catch (Throwable ignored) {
            }
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
            releaseCover();
            stopSelf();
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
         */
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
                CrashLog.record(this, "media-fg", e);
                LogBridge.add(this, "MEDIA", "startForeground 失败，稍后重试: " + e);
                main.postDelayed(this::retryForeground, 1500);
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
            CrashLog.record(this, "media-cmd", e);
        }
        // 被系统杀掉后不要自己重启（播放逻辑在网页里）
        return START_NOT_STICKY;
    }

    /**
     * 重试进前台。
     * 只重试有限次（3 次）：真的没权限时无限重试只会刷日志、耗电。
     */
    private int fgRetries = 0;

    private void retryForeground() {
        if (foregroundStarted) return;
        if (fgRetries >= 3) {
            LogBridge.add(this, "MEDIA", "startForeground 重试 3 次仍失败，放弃（通知权限/前台服务被限制）");
            return;
        }
        fgRetries++;
        try {
            enterForeground(buildNofitication());
            foregroundStarted = true;
            LogBridge.add(this, "MEDIA", "startForeground 第 " + fgRetries + " 次重试成功");
        } catch (Throwable e) {
            LogBridge.add(this, "MEDIA", "startForeground 重试 " + fgRetries + " 失败: " + e);
            main.postDelayed(this::retryForeground, 2000L * fgRetries);
        }
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
            CrashLog.record(this, "media-meta", e);
        }
    }

    private void updatePlaybackState() {
        if (session == null) return;
        try {
            int state = playing
                    ? PlaybackState.STATE_PLAYING
                    : (position > 0 ? PlaybackState.STATE_PAUSED : PlaybackState.STATE_NONE);
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
            CrashLog.record(this, "media-state", e);
        }
    }

    /** 封面下载：只认 http(s)，失败就不带封面（不影响控件可用） */
    private void loadCoverAsync(final String url) {
        if (url == null || url.isEmpty()) return;
        if (!url.startsWith("http://") && !url.startsWith("https://")) return;
        if (url.equals(coverLoadedFor)) return;
        final String want = url;
        new Thread(() -> {
            Bitmap bmp = null;
            HttpURLConnection c = null;
            try {
                c = (HttpURLConnection) new URL(want).openConnection();
                c.setConnectTimeout(6000);
                c.setReadTimeout(8000);
                c.setRequestProperty("User-Agent", "Mozilla/5.0 (Android) RippleApp");
                try (InputStream in = c.getInputStream()) {
                    bmp = BitmapFactory.decodeStream(in);
                }
            } catch (Throwable e) {
                /* 静默失败 */
            } finally {
                if (c != null) c.disconnect();
            }
            final Bitmap got = bmp;
            main.post(() -> {
                if (got == null) return;
                if (!want.equals(coverUrl)) return;   // 期间又换歌了，丢弃
                coverBmp = got;
                coverLoadedFor = want;
                updateMetadata();
                pushNotification();
            });
        }, "ripple-cover").start();
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
        b.setContentTitle(title.isEmpty() ? "Ripple 涟漪" : title)
                .setContentText(artist.isEmpty() ? "未在播放" : artist)
                // U-28：自带单色矢量图标，系统 android.R.drawable.ic_media_play 在部分 ROM 上会被 tint 成白块
                .setSmallIcon(R.drawable.ic_stat_music)
                .setOngoing(playing)
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
            Notification.Action prev = new Notification.Action.Builder(
                    android.R.drawable.ic_media_previous, "上一首",
                    cmdIntent("prev")).build();
            Notification.Action toggle = new Notification.Action.Builder(
                    playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                    playing ? "暂停" : "播放", cmdIntent("toggle")).build();
            Notification.Action next = new Notification.Action.Builder(
                    android.R.drawable.ic_media_next, "下一首",
                    cmdIntent("next")).build();
            /*
             * 第 8 条：通知栏加「喜欢」。
             * 系统 drawable 里没有心形，所以自带一个 ic_heart 矢量图。
             * 点击后通过 cmdIntent("like") 回到网页，由 __rippleMediaCmd 处理 ——
             * 收藏逻辑（含未登录提示）仍然只有网页那一份，不重复实现。
             */
            Notification.Action like = new Notification.Action.Builder(
                    R.drawable.ic_heart, "喜欢", cmdIntent("like")).build();
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
     */
    private String notifKey() {
        return title + "\u0001" + artist + "\u0001" + album
                + "\u0001" + (playing ? "1" : "0")
                + "\u0001" + (coverBmp != null ? System.identityHashCode(coverBmp) : 0);
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
            CrashLog.record(this, "media-notify", e);
            LogBridge.add(this, "MEDIA", "notify failed: " + e);
        }
    }
}
