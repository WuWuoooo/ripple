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
    private static final int NOTIF_ID = 0x9A01;

    /** 网页侧的指令入口（由 MainActivity 注入的回调转发） */
    public interface Sink {
        void onMediaCommand(String cmd);
        void onSeekTo(long ms);
    }

    private static PlaybackService instance;
    private static Sink sink;

    private MediaSession session;
    private final Handler main = new Handler(Looper.getMainLooper());

    /* 当前展示状态（由网页上报） */
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

    public static void setSink(Sink s) {
        sink = s;
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
                    Sink s = sink;
                    if (s != null) s.onSeekTo(pos);
                }
            });
            updatePlaybackState();
            LogBridge.add(this, "MEDIA", "service created");
        } catch (Throwable e) {
            CrashLog.record(this, "media-create", e);
        }
    }

    private void send(String cmd) {
        Sink s = sink;
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
     */
    public void update(String title, String artist, String album, String coverUrl,
                       String durationMs, String positionMs, boolean playing) {
        try {
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
    }

    /** 只更新进度（每秒一次），成本更低 */
    public void updateProgress(String positionMs, String durationMs, boolean playing) {
        try {
            this.position = parseLong(positionMs);
            long d = parseLong(durationMs);
            if (d > 0) this.duration = d;
            boolean changed = this.playing != playing;
            this.playing = playing;
            if (changed) updatePlaybackState();
            pushNotification();
        } catch (Throwable e) {
            /* 进度更新失败不打扰 */
        }
    }

    public void stopAndQuit() {
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
        stopSelf();
    }

    @Override
    public void onDestroy() {
        instance = null;
        try {
            if (session != null) { session.release(); session = null; }
        } catch (Throwable ignored) {
        }
        super.onDestroy();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        /*
         * Android 8+ 要求 startForegroundService() 之后 5 秒内必须 startForeground()，
         * 否则直接抛 ANR/ForegroundServiceDidNotStartInTimeException（我们会被系统杀掉）。
         * 而正常流程要等网页上报状态才发通知，中间可能超过 5 秒 ——
         * 所以这里先发一条「正在准备」的空通知把前台坐实，之后再覆盖。
         */
        if (!foregroundStarted) {
            try {
                startForeground(NOTIF_ID, buildNofitication());
                foregroundStarted = true;
            } catch (Throwable e) {
                CrashLog.record(this, "media-fg", e);
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
                .setSmallIcon(android.R.drawable.ic_media_play)
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
            b.addAction(prev).addAction(toggle).addAction(next);
            if (coverBmp != null) b.setLargeIcon(coverBmp);
        }
        return b.build();
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
            Notification n = buildNofitication();
            if (!foregroundStarted) {
                startForeground(NOTIF_ID, n);
                foregroundStarted = true;
            } else {
                nm.notify(NOTIF_ID, n);
            }
        } catch (Throwable e) {
            CrashLog.record(this, "media-notify", e);
            LogBridge.add(this, "MEDIA", "notify failed: " + e);
        }
    }
}
