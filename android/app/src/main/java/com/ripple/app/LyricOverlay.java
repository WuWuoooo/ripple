package com.ripple.app;

import android.content.Context;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;

/**
 * 状态栏歌词浮层。
 *
 * Android 没有公开的「往状态栏里写东西」接口，所谓状态栏歌词都是
 * 用一个系统级悬浮窗（TYPE_APPLICATION_OVERLAY）盖在状态栏区域上，
 * 因此必须拿到「显示在其他应用上层」权限。
 *
 * 交互：
 *   · 锁定（默认）：纯展示，不可拖动、不可修改，完全不拦触摸（FLAG_NOT_TOUCHABLE），
 *     用户正常操作别的 App 时一点感觉都没有。
 *   · 未锁定：可以按住拖动位置；点击一次会回调给网页，由网页弹出
 *     颜色 / 字号 / 透明度的调整面板。
 */
public class LyricOverlay {

    private static LyricOverlay instance;

    public interface Callback {
        /** 用户点了一下浮层（未锁定时），网页据此弹调整面板 */
        void onTap();

        /** 用户拖动结束后的新位置（屏幕坐标，px） */
        void onMoved(int x, int y);
    }

    private final Context ctx;
    private final WindowManager wm;
    private final Handler main = new Handler(Looper.getMainLooper());
    /**
     * R-11：以下配置字段会被两个线程碰 ——
     *   · 写：WebView 的 JS 桥线程（HttpBridge.showLyricOverlay → configure/setText/…）
     *   · 读：主线程（applyStyle / applyPosition / 触摸回调 / 进度填充）
     * 全部标 volatile，保证主线程读到的是最新一次配置；
     * 需要「读+比较+写」的地方（见 configure / setText / setProgress）
     * 再整体进 main.post 串行化。
     */
    private volatile Callback cb;

    private FillTextView view;
    private WindowManager.LayoutParams lp;
    private volatile boolean added = false;

    private volatile boolean locked = true;
    private volatile String text = "";
    /**
     * 最后显示过的歌词（A-06）。
     * 与 text 分开：hide() 清 text 是为了让 setText 的判重失效，
     * 但 show() 需要用它初始化新 TextView，否则重开浮层是空白的。
     */
    private volatile String lastText = "";
    private volatile int color = Color.WHITE;
    private volatile float sizeSp = 12f;
    private volatile float alpha = 0.92f;
    private volatile int posX = -1;
    private volatile int posY = -1;
    private volatile boolean bold = true;
    private volatile boolean shadow = true;
    /* 跟随播放进度填充：0=关闭；开启后按进度把文字从左到右染成高亮色 */
    private volatile boolean fillProgress = false;
    /*
     * ===== 原生侧自驱动填充（1.3.3 第三轮）=====
     *
     * 为什么必须由原生驱动，而不是等网页推：
     *   状态栏歌词的使用场景就是「切到别的 App 时看」—— 也就是网页**永远在后台**。
     *   而网页在后台时：
     *     · requestAnimationFrame 被暂停；
     *     · visibilitychange 里主动 clearInterval 了 1 秒 ticker；
     *     · 只剩 <audio> 的 timeupdate，而它被系统节流到几秒一次。
     *   实测日志：30 秒内只推到 1 次进度（dedup=29 把其余全吃了）。
     *
     *   这就是用户看到的「一句播完瞬间填满，然后下一句」——
     *   因为唯一还能可靠触发的推送点就是**换句那一刻**（setText）。
     *
     * 现在改成：网页只在「换句 / 播放暂停 / seek / 变速」这些**离散事件**上
     * 推一次「基准点」（进度 + 本句时长 + 倍速 + 是否在播），
     * 原生拿到基准点后用自己的时钟按 30fps 外推。
     * Handler.postDelayed 在应用进程里**不受 WebView 可见性影响**，
     * 所以切到任何别的 App 都能顺畅地填。
     */
    private volatile float baseProgress = 0f;      // 基准进度
    private volatile long baseAt = 0L;             // 基准时刻（elapsedRealtime）
    private volatile float lineDurSec = 0f;        // 本句时长（秒）
    private volatile float rate = 1f;              // 播放倍速
    private volatile boolean timingPlaying = false; // 是否在播（停就冻结）
    /**
     * 「下一帧把基准点挪到现在」的请求标记（换句时置位，见 setText）。
     *
     * 为什么要有它：换句时进度必须归零，但直接写 progress=0 会和
     * 每 33ms 一次的外推帧互相覆盖（真机日志出现过 p0=89 的连续零帧）。
     * 改成让外推逻辑自己兑现这次重置，写入方就只剩一个。
     */
    private volatile boolean needResetBase = false;
    /** 唱满后还能空转多少帧（见 pushFrame 末尾说明） */
    private int fullHoldFrames = 0;
    private boolean tickScheduled = false;
    /*
     * 自驱动链路的诊断计数（定位「填充不动」到底断在哪一层）：
     *   timingRecv —— setTiming 被调了多少次（网页推基准点）
     *   ticks      —— 定时器真的跑了多少帧（原生外推）
     *   draws      —— FillTextView 真的走了填充分支多少次（绘制）
     * 三者递进关系，缺哪一环一眼就能看出来。
     */
    private int dTimingRecv = 0, dTicks = 0, dDraws0 = 0;
    private long dAt = 0;
    private long dFirstAt = 0;
    /** 是否已经打过第一条诊断（决定用 8 秒还是 30 秒窗口） */
    private boolean dFirstReport = false;
    /*
     * ===== 逐帧快照（1.3.3 第七轮）=====
     *
     * 用户这次给的描述是决定性的：
     *   「他还是跟之前一样 只在换句的时候填 并不是看不见」
     * —— 填充看得见，但**只在换句那一下变一次**，句内一动不动。
     *
     * 而日志里 full=415/entry=461 说明「染色代码确实在跑、有帧」，
     * 那么唯一剩下的可能就是：**每帧算出来的 p 值不变**。
     *
     * 总计数看不出这件事（p1=5 很少，full 很高，一切正常），
     * 所以必须直接把 p 的序列打出来：把每帧的 p、baseProgress、
     * elapsedSec 各存进一个环形缓冲，够一窗就拼成一行日志。
     */
    private final float[] dProbeP = new float[8];
    private int dProbeN = 0;
    private volatile int fillColor = 0xFF7DE3D0;
    private volatile float progress = 0f;      // 0..1
    /*
     * ===== 帧驱动方式（1.3.3 第四轮）=====
     *
     * 上一轮日志暴露了一个关键矛盾：
     *     timing diag: timingRecv=188 ticks=495 draws=22
     * 30 秒里原生推了 495 帧、每帧都调了 setFill → invalidate()，
     * 但 FillTextView.onDraw 真正走填充分支只有 22 次。
     *
     * 22 这个数正好等于「换句时 updateViewLayout 触发重新布局」的次数 ——
     * 也就是说：**普通 invalidate() 在这块悬浮窗上没有兑现成帧**。
     *
     * 原因：这个窗口带 FLAG_NOT_FOCUSABLE / FLAG_NOT_TOUCHABLE /
     * FLAG_LAYOUT_NO_LIMITS，且是 TYPE_APPLICATION_OVERLAY（不受宿主
     * Activity 的渲染循环直接管辖）。这类窗口在部分 ROM（vivo OriginOS
     * 尤其明显）上，只有在「窗口属性变化 → 触发 measure/layout」时才会
     * 真正走一次 draw，单纯 invalidate 会被合并/丢弃。
     *
     * 对策：不再依赖 invalidate 的调度，改成两件事一起做：
     *   ① 用 Choreographer.postFrameCallback 拿到真实的 vsync 帧回调，
     *      在每帧回调里推进度 —— 这叫「在正确的帧上做正确的事」；
     *   ② 帧回调里显式 invalidate()，保证这一帧确实被重绘。
     * Choreographer 比 Handler.postDelayed(33ms) 更准（对齐 vsync，
     * 不会漂），而且它在应用有任何可见窗口时都会回调，不依赖 WebView。
     */
    /* Choreographer 相关字段已全部删除（见 ticker 的注释） */
    /**
     * App 是否在后台（见 setAppBackground）。
     *
     * 后台时必须用 Handler 驱动而不是 Choreographer ——
     * 后者依赖 vsync，而后台进程收不到 vsync，会导致外推彻底停摆，
     * 表现为「只有换句那一下才填充」。
     */
    private volatile boolean appInBackground = false;

    /*
     * 自适应重绘探针的锚点（1.3.3 第四轮）。
     *
     * 观测到的坏情况：帧在跑（ticks 涨）、invalidate 也在调，
     * 但 FillTextView.onDraw 几乎不执行（draws 不涨）——
     * 也就是这块悬浮窗的普通 invalidate 被系统吞了，
     * 只有触发 measure/layout 的调用（updateViewLayout）才会真正出一帧。
     *
     * 于是自动检测：每 1.2 秒比较「自己发了多少次重绘请求」和
     * 「onDraw 真的执行了多少次」，比例不对就往上升一档重绘方式。
     */
    private long dDrawProbe0 = 0L;
    private long dProbeAt = 0;
    /*
     * ===== 重绘方式阶梯（1.3.3 第四轮）=====
     *
     * 0 = invalidate()          —— 最轻，正常窗口够用
     * 1 = requestLayout()       —— 强制 measure/layout，能让调度器重新走一遍
     * 2 = wm.updateViewLayout() —— 直接找 WindowManager，连系统都绕不过去
     *
     * 为什么要有阶梯而不是一开始就用最重的：
     *   3 对 30fps 的透明悬浮窗来说是有实际成本的（要过 WMS），
     *   在正常设备上能用 0 就不该升。只有实测「帧在跑但画不出来」才升级。
     *
     * 为什么必须自动检测而不是写死：
     *   vivo OriginOS 这类 ROM 对后台应用的悬浮窗 invalidate 合并得很凶，
     *   而原生 AOSP / 部分 ROM 完全没这个问题。写死会让好设备也吃惩罚。
     */
    /* 重绘档位阶梯已删除（见 forceRedraw 的注释） */
    /** 重绘抛异常的次数（>0 说明线程/权限有问题，不再静默） */
    private int dRedrawErr = 0;

    public LyricOverlay(Context ctx) {
        this.ctx = ctx.getApplicationContext();
        this.wm = (WindowManager) this.ctx.getSystemService(Context.WINDOW_SERVICE);
    }

    public static synchronized LyricOverlay get(Context ctx) {
        if (instance == null) instance = new LyricOverlay(ctx);
        return instance;
    }

    public static synchronized LyricOverlay peek() {
        return instance;
    }

    public void setCallback(Callback c) {
        this.cb = c;
    }
    /** 有没有悬浮窗权限 */
    public static boolean canDraw(Context ctx) {
        try {
            if (Build.VERSION.SDK_INT >= 23) return Settings.canDrawOverlays(ctx);
            return true;
        } catch (Throwable e) {
            return false;
        }
    }

    public boolean isShowing() {
        return added;
    }

    public boolean isLocked() {
        return locked;
    }

    /* ================= 对外配置 ================= */

    /**
     * 应用网页传来的配置。
     *
     * R-11：整段配置的读写搬进主线程 —— 以前 configure 在 JS 桥线程里
     * 「读 this.color → 算新值 → 写 this.color」，主线程同时在 applyStyle 里读，
     * 拿到的可能是半新半旧的组合（字号是新的、颜色是旧的）。
     * 参数在进入 main.post 前先落到 final 局部变量，避免 lambda 捕获可变值。
     */
    public void configure(final boolean locked, final String colorHex, final String sizeSp,
                          final String alphaStr, final String x, final String y,
                          final boolean bold, final boolean shadowOn,
                          final boolean fill, final String fillHex) {
        main.post(() -> {
            try {
                this.locked = locked;
                int c = parseColor(colorHex, this.color);
                float sz = parseFloat(sizeSp, this.sizeSp);
                float al = parseFloat(alphaStr, this.alpha);
                int nx = (int) parseFloat(x, this.posX);
                int ny = (int) parseFloat(y, this.posY);
                this.color = c;
                this.sizeSp = Math.max(9f, Math.min(28f, sz));
                this.alpha = Math.max(0.15f, Math.min(1f, al));
                this.bold = bold;
                this.shadow = shadowOn;
                this.fillProgress = fill;
                if (!fill) {
                    stopTick();
                } else {
                    baseAt = android.os.SystemClock.elapsedRealtime();
                    baseProgress = progress;
                    scheduleTick();
                }
                if (fillHex != null && !fillHex.isEmpty()) {
                    this.fillColor = parseColor(fillHex, this.fillColor);
                }
                /*
                 * -1 表示「恢复默认位置」。
                 * 之前写的是 if (ny > -9999) posY = ny，而 -1 恰好大于 -9999，
                 * 于是默认值永远覆盖不上去 —— 点「恢复默认位置」看起来毫无反应。
                 * 现在：< 0 就当作「用默认」，并立刻把窗口重新摆一次。
                 */
                this.posX = nx < 0 ? -1 : nx;
                this.posY = ny < 0 ? -1 : ny;
                final boolean reposition = (this.posX < 0 || this.posY < 0) || nx >= 0 || ny >= 0;

                applyStyle();
                if (!added || view == null || lp == null) return;
                if (reposition) {
                    applyPosition();
                    try {
                        wm.updateViewLayout(view, lp);
                    } catch (Throwable e) {
                        CrashLog.recordAsync(ctx, "lyric-move", e);
                    }
                }
                updateLayoutFlags();
            } catch (Throwable e) {
                CrashLog.recordAsync(ctx, "lyric-config", e);
            }
        });
    }

    public void setText(final String t) {
        final String v = t == null ? "" : t.trim();
        /*
         * E-12 + R-11：这里原来是锁外的「读 text → 比较 → 写 text」。
         * 两个问题：
         *   1) text 与 view 的内容可能不一致 —— hide() 把 view 置 null 但没清 text，
         *      再次 show() 时新 TextView 是空的，而 setText 因为 v.equals(text)
         *      直接早退，于是状态栏歌词永久空白；
         *   2) 桥线程和主线程同时进这段会互相覆盖。
         * 现在：整体进主线程串行化，并且改了 text 一律同步到 view（不靠早退省事）。
         */
        main.post(() -> {
            boolean textChanged = !v.equals(text);
            text = v;
            if (view == null) return;
            if (v.isEmpty()) {
                view.setVisibility(View.GONE);
                return;
            }
            view.setVisibility(View.VISIBLE);
            /*
             * ⚠️ 比较必须用 plainText()。
             * 自绘 View 内部存的是纯 String，但仍然通过这个接口取 ——
             * 保持一层抽象，将来换实现不会影响这里的判重逻辑。
             *
             * 判重本身很重要：如果每帧都判定成「换句」，外层就会重置
             * 基准点（needResetBase），进度永远归零 → 完全填不动。
             */
            if (!v.equals(view.plainText())) view.setText(v);
            if (!v.isEmpty()) lastText = v;   // 供 show() 初始化，见 A-06
            /*
             * 换句时把填充进度归零。
             *
             * ⚠️ 这里曾经直接写 `progress = 0f` 并重置 baseAt ——
             * 那会和外推帧打架：pushFrame() 每 33ms 写一次 progress，
             * 换句瞬间清 0 之后，若网页那一侧的 setTiming 晚到一步，
             * 中间会出现一串 p<=0 的帧（真机日志 `p0=89`），
             * 而那正是用户肉眼看到的「卡在起点不填」。
             *
             * 现在改成只**请求**重置，由主线程上的外推逻辑自然接手：
             * 用一个「待重置」标记，pushFrame 读到它后才把基准点挪到现在。
             * 这样清零点只有一个，不会和写入方互相覆盖。
             */
            if (textChanged) {
                needResetBase = true;
                if (fillProgress) {
                    /*
                     * 立刻按 0 画一帧，避免新句子顶着上一句唱满的颜色。
                     * 这一帧是**一次性**的：不写 progress 字段，
                     * 只把 0 传给 View，外推逻辑下一帧就会用新基准接管。
                     */
                    FillTextView fv = view;
                    if (fv != null) {
                        fv.setFill(true, 0f, fillColor, color);
                        forceRedraw(fv);
                    }
                    scheduleTick();
                }
            }
            /*
             * 跑马灯已经移进 FillTextView 内部（自实现）：
             * TextView 的 TruncateAt.MARQUEE 依赖 selected 状态和
             * 内置计时器，而每改一次文字就会重置滚动进度 ——
             * 那正是用户报的「填充覆盖滚动、布局抖动」。
             * 现在滚动只是绘制层的一个偏移量，与文字/进度完全解耦。
             */
            /*
             * 窗口宽度是「包住文字」的，所以每换一句歌词窗口宽度都会变。
             * 如果当前是默认位置（没手动拖过），必须重新居中，
             * 否则长句会从中间开始、短句还停在上一句的左边。
             */
            if (posX < 0) {
                view.post(() -> {
                    if (view == null || lp == null || !added) return;
                    centerHorizontally();
                });
            }
        });
    }

    public void setLocked(boolean v) {
        main.post(() -> {
            if (locked == v && added) return;
            locked = v;
            if (added) updateLayoutFlags();
        });
    }

    public void show() {
        main.post(() -> {
            try {
                if (added || wm == null) return;
                if (!canDraw(ctx)) {
                    LogBridge.add(ctx, "LYRIC", "no overlay permission");
                    return;
                }
                /*
                 * E-12 / R-11：view 一定是新建的空 TextView，
                 * 上次 hide() 之后 text 里可能还留着上一句（hide 里现在会清空，
                 * 但这里是第二重保险）—— 用当前 text 初始化，
                 * 否则要等下一条歌词上报才有内容，用户看到的是空白。
                 */
                /*
                 * FillTextView 现在是**自绘 View**（不再是 TextView），
                 * 原因见它的类注释：TextView 上任何「改画法」的尝试
                 * （setShader / clipRect）在这块悬浮窗上都被系统缓存吃掉，
                 * 而逐字 setText 又会和 marquee 抢布局导致抖动。
                 *
                 * 现在：
                 *   · 文字用 Paint 自己画，染色用 canvas.clipRect —— 完整重画，必然生效；
                 *   · 跑马灯自实现（滚动偏移只是绘制参数，不碰布局）→ 不再抖动；
                 *   · 进度更新只改一个 float 并 invalidate → 布局完全不参与，
                 *     所以「一个字一个字跳」也没了，边界是像素级的连续移动。
                 */
                view = new FillTextView(ctx);
                view.setPaddingPx(dp(2), dp(1));
                /* 长歌词别把窗口撑出屏幕：给一个上限，超了走自实现的跑马灯 */
                final int screenW = ctx.getResources().getDisplayMetrics().widthPixels;
                view.setMaxTextWidth(Math.max(dp(120), screenW - dp(24)));

                lp = new WindowManager.LayoutParams();
                lp.type = Build.VERSION.SDK_INT >= 26
                        ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                        : WindowManager.LayoutParams.TYPE_PHONE;
                lp.format = PixelFormat.TRANSLUCENT;
                lp.gravity = Gravity.TOP | Gravity.START;
                /*
                 * 从 MATCH_PARENT 改成 WRAP_CONTENT：
                 *  · 窗口正好包住文字 → 拖动时「拖的是文字」，不会出现拖到中间还偏左；
                 *  · 默认位置改成「屏幕水平居中」，见 applyPosition()。
                 * 长歌词由 TextView 的 maxWidth 兜住，超出部分走跑马灯。
                 */
                lp.width = WindowManager.LayoutParams.WRAP_CONTENT;
                lp.height = WindowManager.LayoutParams.WRAP_CONTENT;
                // 默认不拦触摸：锁定态就是纯展示，绝不影响用户操作别的 App
                lp.flags = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                        | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
                        | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN;
                applyStyle();
                // 把上次的歌词写进新 TextView（否则重开标签页后一直是空白）
                /*
                 * A-05/A-06（审查报告）：用 lastText 初始化，而不是 text。
                 *
                 * hide() 会把 text 清空（为了让 setText 的「内容没变」早退
                 * 判断失效，见 E-12），于是这里原本想「用上次的歌词初始化」
                 * 永远拿到空串 —— 关掉再打开时浮层是空白的，要等下一条
                 * 歌词上报才有内容。拆成两个字段各司其职：
                 *   · text     —— 供 setText 判重，hide() 时清空；
                 *   · lastText —— 最后显示过的歌词，供 show() 初始化，不清空。
                 */
                final String cur = lastText;
                if (cur != null && !cur.isEmpty()) {
                    view.setText(cur);
                    view.setVisibility(View.VISIBLE);
                } else {
                    view.setVisibility(View.GONE);
                }
                placeDefault();
                bindTouch();

                wm.addView(view, lp);
                added = true;
                LogBridge.add(ctx, "LYRIC", "overlay shown locked=" + locked);
            } catch (Throwable e) {
                CrashLog.recordAsync(ctx, "lyric-show", e);
                LogBridge.add(ctx, "LYRIC", "show failed: " + e);
                added = false;
            }
        });
    }

    public void hide() {
        main.post(() -> {
            try {
                if (added && view != null && wm != null) wm.removeView(view);
            } catch (Throwable ignored) {
            }
            added = false;
            view = null;
            lp = null;
            /*
             * E-12：必须把 text 一起清掉。
             * 否则「关掉状态栏歌词 → 再打开」时，新 TextView 是空的，
             * 而下一条歌词如果恰好和上一句相同，setText 会判定「没变化」早退，
             * 结果界面上永久空白。
             */
            text = "";
            /*
             * 填充进度也要一起归零。
             *
             * 理由和上面的 text 一样：重开浮层时 view 是全新的，
             * 若 progress 还留着上次关闭时的 0.6，show() → applyStyle()
             * 会立刻按 0.6 给新文字上渐变 —— 用户看到的是「刚打开，
             * 这句歌词就已经唱了一半」，然后才被下一帧的正确值覆盖。
             * 这一闪很短，但在「刚打开状态栏歌词」这种主动操作后特别刺眼。
             */
            progress = 0f;
            /* 浮层没了就停掉自驱动，避免后台空转重绘耗电 */
            stopTick();
        });
    }

    /* ================= 内部 ================= */

    private void applyStyle() {
        if (view == null) return;
        try {
            /*
             * 两种状态统一交给 FillTextView 管：
             *   · 开填充 → 它自己在 onDraw 里按进度造渐变；
             *   · 关填充 → clearFill 回到纯色。
             * 这里不再直接碰 paint.setShader —— 那正是第一版「染色会被
             * 后续 setter 抹掉」的根源（见 FillTextView 的类注释）。
             */
            /*
             * FillTextView 现在是自绘 View，样式通过它自己的 setter 传 ——
             * 它内部用 TextPaint 画字，所以字号/粗体/阴影都要显式告知。
             */
            final FillTextView fv = view;
            final float density = ctx.getResources().getDisplayMetrics().scaledDensity;
            fv.setTextSizePx(sizeSp * density);
            fv.setBold(bold);
            fv.setShadowRadius(shadow ? Math.max(2f, sizeSp * 0.28f) : 0f);
            if (fillProgress) {
                applyProgressFill();
            } else {
                fv.clearFill(color);
            }
            view.setAlpha(alpha);
        } catch (Throwable e) {
            CrashLog.recordAsync(ctx, "lyric-style", e);
        }
    }

    /**
     * 按播放进度给文字上「填充色」：
     * 用 LinearGradient 做一条硬边渐变 —— 0..progress 用高亮色，
     * 之后用基础色，然后把它铺到整行宽度上。
     * 这比「画两层文字裁切」轻得多，每帧只改 shader 的位置。
     */
    /**
     * 按进度重绘。
     *
     * ⚠️ 这里只负责「把新进度交给 View 并让它重画」，真正的染色在
     * FillTextView.onDraw 里做。
     *
     * 为什么不再用 paint.setShader 就完事（1.3.3 第一版的写法）：
     *   TextView 在**每次 setText** 时都会重置 paint 上的一部分状态，
     *   而且 setTextColor / setAlpha / setTypeface 这些调用也会重建 TextPaint
     *   的内部分支。我们的 shader 是在别处算好再塞进 paint 的，
     *   一旦中间任何一次 setText 或样式变更发生，shader 就被丢掉 ——
     *   表现正是用户反馈的「只有边缘发亮，没有填充」：某一瞬间确实染过，
     *   但紧接着换句/换样式就没了，只剩文字本身的抗锯齿边缘还亮着。
     *
     *   放进 onDraw 就绕开了这个时序问题：每次绘制都按**当前**进度和宽度
     *   重新造一条渐变，draw 之前发生了什么 setter 都不影响结果。
     */
    private void applyProgressFill() {
        final FillTextView v = view;
        if (v == null) return;
        try {
            v.setFill(fillProgress, progress, fillColor, color);
            /*
             * ⚠️ 必须在这里也调一次 forceRedraw ——
             * 这正是「只在换句时填充」最后一个漏洞。
             *
             * setFill() 内部只做 invalidate()，而这块悬浮窗的普通
             * invalidate 有大概率不被兑现成帧（见 forceRedraw 的注释）。
             * 换句那条路径走的是 setText() → forceRedraw()，
             * 所以换句能画出来；而 setTiming 每次推来的新进度
             * 只经过 applyProgressFill()，只 invalidate 一下就被吞掉 ——
             * 于是画面只在换句时更新一次。
             *
             * 用户原话「只在换句的时候填」，一字不差地对上。
             */
            forceRedraw(v);
        } catch (Throwable e) {
            CrashLog.recordAsync(ctx, "lyric-fill", e);
        }
    }

    /** 网页每秒推一次进度（0..1）；只有开启填充时才真正重绘 */
    /*
     * setProgress 的诊断计数。
     *
     * 与 JS 侧 _sbDiag 配合：JS 记「推了多少次」，这里记「收到/丢掉/重绘了多少次」。
     * 两边一对就能立刻判断断点在哪：
     *   JS send 涨、Java recv 不涨  → 跨桥没通（RippleNative 没挂上/方法名错）
     *   Java recv 涨、drop 也涨     → 阈值把更新吃掉了
     *   Java recv 涨、draw 也涨     → 原生拿到了，问题在绘制
     */
    private int diagRecv = 0, diagDrop = 0, diagDraw = 0;
    private long diagAt = 0;

    /**
     * 设置「进度基准点」，并让原生侧开始自己外推。
     *
     * 这是 1.3.3 第三轮的核心改动。参数含义：
     * @param progress 当前这一句的进度 0..1（推送那一刻的真值）
     * @param lineDur  当前这一句的总时长（秒）；<=0 表示未知，此时退化为「不自动推进」
     * @param rate     播放倍速（1.0 = 正常）
     * @param playing  是否正在播放；false 时冻结在 progress，不继续外推
     *
     * 为什么要有这套「基准点 + 外推」而不是继续让网页每帧推：
     *   状态栏歌词的使用场景就是**切到别的 App 时看**，也就是网页永远在后台。
     *   WebView 在后台时 rAF 暂停、我们自己又把 1 秒 ticker clearInterval 了，
     *   只剩被系统节流到 1 次/秒左右的 timeupdate。实测日志证实了这一点：
     *   `fill diag: send=0 dedup=30`（30 秒里 30 次调用全部因为进度没变被去重）。
     *   于是整句只会在**换句那一刻**推进一次 —— 就是用户看到的
     *   「一句播完瞬间填满然后下一句」。
     *
     *   而 Handler.postDelayed 跑在应用进程里，不受 WebView 可见性影响，
     *   所以由原生按 30fps 外推就能在后台保持顺滑。
     */
    public void setTiming(final String progressStr, final String lineDur,
                          final String rateStr, final String playingStr) {
        /*
         * ⚠️ 解析放在调用线程上做没问题（纯计算、无副作用），
         * 但**从写字段开始一直到 scheduleTick 必须整体进主线程**。
         *
         * 为什么（2026-11-24 实测崩溃，栈在 Ripple-crash-*-lyric-redraw.txt）：
         *   setTiming 是 @JavascriptInterface，跑在 WebView 的 JavaBridge 线程。
         *   旧代码直接在 JavaBridge 线程里调 scheduleTick() →
         *   Choreographer.getInstance().postFrameCallback()。
         *   而 Choreographer 是**线程绑定**的：它取的是「当前线程」的实例。
         *   JavaBridge 线程没有 Looper、也没有自己的 Choreographer，
         *   于是回调要么不执行，要么在错误线程上执行 ——
         *   pushFrame() 里的 view.requestLayout() 直接抛
         *   CalledFromWrongThreadException: Expected main, Calling JavaBridge。
         *
         * 这个异常被 forceRedraw 的 catch 吞掉了，于是表现为
         * 「帧在跑（ticks 疯涨）但 onDraw 几乎不执行（draws=13）」——
         * 正是用户看到的「状态栏歌词完全没有实时填充」。
         */
        float p = 0f, d = 0f, r = 1f;
        try { p = Float.parseFloat(String.valueOf(progressStr).trim()); } catch (Throwable ignored) {}
        try { d = Float.parseFloat(String.valueOf(lineDur).trim()); } catch (Throwable ignored) {}
        try { r = Float.parseFloat(String.valueOf(rateStr).trim()); } catch (Throwable ignored) {}
        boolean play = "true".equalsIgnoreCase(String.valueOf(playingStr).trim());
        if (!Float.isFinite(p)) p = 0f;
        if (!Float.isFinite(d) || d < 0f) d = 0f;
        if (!Float.isFinite(r) || r <= 0f) r = 1f;

        final float fp = Math.max(0f, Math.min(1f, p));
        final float fd = d;
        final float fr = r;
        final boolean fplay = play;
        main.post(() -> {
            baseProgress = fp;
            baseAt = android.os.SystemClock.elapsedRealtime();
            lineDurSec = fd;
            this.rate = fr;
            timingPlaying = fplay;
            progress = fp;
            /*
             * 新基准点到了：清掉「唱满后的空转计数」，
             * 否则上一句遗留的 fullHoldFrames 会让这一句刚开始就被停掉
             * （pushFrame 里 p>=1 分支用的就是它）。
             */
            fullHoldFrames = 0;
            needResetBase = false;
            dTimingRecv++;
            applyProgressFill();
            scheduleTick();
            reportTiming();
        });
    }

    // ===== 原生自驱动：按时间外推进度并重绘 =====

    private static final long TICK_MS = 33;   // 退回 Handler 时的周期（≈30fps）

    /**
     * 推一帧：算进度 → 交给 FillTextView → **强制它真的重绘**。
     *
     * 三件事都必不可少，少一件就会回到「有数据没画面」：
     *   ① 算出当前进度；
     *   ② setFill() 更新参数（内部会 invalidate）；
     *   ③ **再显式 invalidate() 一次**。
     *
     * 为什么 ③ 看起来多余却不能省：见字段注释里那段 ——
     * 悬浮窗上普通 invalidate 有概率被系统合并/丢弃，
     * 而 setFill 内部的那次 invalidate 可能恰好落在「上一帧还没提交」
     * 的时间窗里，被当成同一帧吞掉。连着再调一次能显著提高兑现率。
     *
     * @return true = 本句还没唱满，可以继续排下一帧
     */
    private boolean pushFrame() {
        if (!added || view == null || !fillProgress) return false;
        /*
         * 暂停时冻结画面，但**不能就此断掉驱动链**。
         *
         * 曾经这里 return false —— 一旦暂停，scheduleTick 不再被调用，
         * 而恢复播放时没有任何东西会把它重新拉起来
         * （setTiming 只在「有变化」时才推，暂停期间本来就没变化）。
         * 结果：暂停一次之后填充永久停摆，直到下一次换句。
         *
         * 现在：暂停时仍然返回 true 继续排帧，只是不推进 p。
         * 成本是每秒 30 次空转，比起「暂停就永久坏掉」完全可以接受。
         */
        /*
         * 暂停：不推进，但**先画一帧再停**。
         *
         * 审查报告 A-04 指出「暂停时仍 30fps 空转」与省电目标矛盾，
         * 这一点成立 —— 所以这里改成暂停即停驱动。
         *
         * 但停之前必须先把当前帧画出来：用户暂停后仍应看到
         * 「染到哪儿」的定格画面，而不是空白或上一帧的残影。
         * 之后由 setTiming（恢复播放时前端会推一次）重新拉起驱动。
         */
        if (!timingPlaying) {
            final FillTextView v0 = view;
            if (v0 != null) {
                v0.setFill(true, progress, fillColor, color);
                forceRedraw(v0);
            }
            return false;                              // 停掉驱动，省电
        }
        if (lineDurSec <= 0.01f) return true;          // 句长未知，保持驱动等新基准
        /*
         * 换句的基准重置在这里兑现（见 setText 里 needResetBase 的说明）。
         *
         * 放在外推逻辑里做而不是 setText 里直接改字段，是为了让
         * 「读基准 → 算进度 → 写 progress」始终由同一个线程串行完成，
         * 不会出现 setText 清 0、外推又写回的互相覆盖。
         */
        if (needResetBase) {
            needResetBase = false;
            baseProgress = 0f;
            baseAt = android.os.SystemClock.elapsedRealtime();
        }
        long now = android.os.SystemClock.elapsedRealtime();
        float elapsedSec = (now - baseAt) / 1000f;
        float p = baseProgress + (elapsedSec * rate) / lineDurSec;
        if (p > 1f) p = 1f;
        if (p < 0f) p = 0f;
        progress = p;
        dTicks++;
        /* 逐帧采样（见 dProbeP 的注释：这是为了暴露「p 每帧都不变」） */
        dProbeP[dProbeN & 7] = p;
        dProbeN++;
        final FillTextView v = view;
        if (v != null) {
            v.setFill(true, p, fillColor, color);
            forceRedraw(v);
        }
        reportTiming();
        /*
         * ===== 到 1 之后绝不能停 =====
         *
         * 这里以前是 `return ++fullHoldFrames < 30` —— 满格 30 帧后
         * 就不再排下一帧，把驱动彻底停掉，等网页推新基准点来救。
         *
         * 那是「只在换句时填充」这个顽固 bug 的最后一块拼图：
         *   状态栏歌词的使用场景就是**切到别的 App 时看**，
         *   那时网页的 setInterval 被 clearInterval、timeupdate 被节流、
         *   rAF 暂停 —— 下次 setTiming 可能十几秒都不来。
         *   于是浮层停在满格不动，用户看到的就是
         *   「一句播完闪一下填满，然后一直不动，直到下一句」。
         *
         * 现在：永远返回 true，驱动永不停歇。
         *   · 外推本身只是几次浮点运算，30fps 下耗电可以忽略；
         *   · 满格期间 p 恒为 1，FillTextView 的 hash 去重会走
         *     「参数没变只 invalidate」的轻路径，不重建渐变；
         *   · 真正的省电由 stopTick() 负责 —— 隐藏浮层、关掉填充、
         *     暂停播放时都会停，那些才是该停的时刻。
         *
         * 冻结基准（baseProgress=1, baseAt=now）保留：
         * 这样 p 恒为 1 不会继续增长，算出来的值稳定，
         * 新基准点一到就能立刻从新值重新开始。
         */
        if (p >= 1f) {
            baseProgress = 1f;
            baseAt = now;
        } else {
            fullHoldFrames = 0;
        }
        return true;
    }

    /**
     * 请求重绘。
     *
     * ⚠️ 这个函数曾经承载了一整套「三档阶梯 + 每帧翻转 translationX(0.01px)」
     * 的补丁塔 —— 起因是连续两轮的误判（以为 invalidate 被 WMS 合并 /
     * 合成器没取走帧）。真正的病因是另外两个：
     *
     *   ① 线程：Choreographer 回调绑在 JavaBridge 线程，requestLayout
     *      每帧抛 CalledFromWrongThreadException 并被 catch 吞掉（已删掉
     *      Choreographer，统一主线程 Handler）；
     *   ② 绘制方式：这块悬浮窗对 shader / clipRect 这类「改画法」的操作
     *      不生效，只有改**内容**才刷新（见 FillTextView 的类注释）。
     *
     * 现在所有视觉变化都由 FillTextView.setText(Spannable) 完成，
     * 而 setText 会自己触发 TextView 的重新布局与提交 ——
     * 也就是说**根本不需要外部再请求重绘**。
     *
     * 保留这个函数只是为了「颜色/字号等样式变化后主动刷一帧」的场景，
     * 而且只做一次 invalidate（轻量、无副作用）。
     */
    private void forceRedraw(final FillTextView v) {
        try {
            v.invalidate();
        } catch (Throwable e) {
            /*
             * 这个 catch 曾经把真正的病因藏了整整七轮：
             * CalledFromWrongThreadException 在这里被静默吞掉，
             * 外部只能看到「帧在跑、画不出来」的假象。
             * 现在任何一次异常都记到 CrashLog 和软件日志，不再沉默。
             */
            dRedrawErr++;
            if (dRedrawErr <= 1) {
                CrashLog.recordAsync(ctx, "lyric-redraw", e);
                LogBridge.add(ctx, "LYRIC", "redraw failed: " + e);
            }
        }
    }

    /**
     * 唯一的帧驱动：主线程 Handler.postDelayed。
     *
     * ⚠️ 这里曾经有第二个分支 —— Choreographer.postFrameCallback，
     * 理由是「对齐 vsync、不漂、invalidate 兑现率更高」。
     * 它在 1.3.3 里制造了整整七轮排查都绕不出去的坑，两次致命：
     *
     * ①【线程绑定】Choreographer.getInstance() 返回的是**当前线程**的实例。
     *   setTiming 是 @JavascriptInterface，跑在 WebView 的 JavaBridge 线程；
     *   某个中间构建里 scheduleTick() 没进主线程，于是 frameCb 绑到了
     *   JavaBridge 线程的 Looper 上，回调里 view.requestLayout() 每帧抛
     *     CalledFromWrongThreadException: Expected: main  Calling: JavaBridge
     *   （真机日志 /sdcard/Download/Ripple-crash-*-lyric-redraw.txt，十余份连抛）
     *   异常被 forceRedraw 的 catch 吞掉 —— 但 dTicks 是在 forceRedraw
     *   **之前**自增的，于是日志显示「帧在跑、draws 不涨」，
     *   把排查引向「invalidate 被 WMS 合并 / 合成器没取走帧」这两个错误方向，
     *   白白叠加了 drawMode 阶梯和 translationX nudge 两套机制。
     *
     * ②【后台无 vsync】Choreographer 依赖 vsync 信号，而进程切到后台后
     *   系统就不再分发 vsync。可状态栏歌词的使用场景**就是切到别的 App 时看**，
     *   于是切后台后外推彻底停摆，只有网页跨桥推基准点（换句）时才画一帧 ——
     *   用户原话「只在换句的时候填」。
     *
     * Handler.postDelayed 没有这两个问题：消息由应用自己的主线程 Looper
     * 分发，既天然绑定主线程，也不受 vsync 与 WebView 可见性影响。
     * 30fps 的精度对「一句话两三秒」的染色完全够用。
     *
     * 结论（采纳 1.3.3 审查报告 A-01 的修改建议 1）：
     * **只保留这一种驱动，把另一条路径彻底删掉，而不是加兜底。**
     * 两条并存时，「哪条在跑」本身就是新的不确定性来源。
     */
    private final Runnable ticker = new Runnable() {
        @Override
        public void run() {
            tickScheduled = false;
            try {
                if (pushFrame()) scheduleTick();
            } catch (Throwable e) {
                CrashLog.recordAsync(ctx, "lyric-tick", e);
            }
        }
    };

    /** 每 30 秒汇总一次自驱动链路诊断 */
    private void reportTiming() {
        try {
            long now = System.currentTimeMillis();
            /*
             * ⚠️ 这里以前用「dAt == 0 就只设锚点然后 return」做初始化，
             * 再配合 8 秒/30 秒窗口 —— 结果真机上出现过
             * 「网页 send=255、原生一条 timing diag 都没有」的怪现象。
             *
             * 原因还没完全证实（可能和 setTiming 被 main.post 串行化后
             * 首次落点的时间有关），但诊断本身不该有任何前置条件：
             * 它是排查工具，不是业务逻辑，宁可多打一条也不能沉默。
             *
             * 现在改成：以「第一次进入本函数」为锚，用 SystemClock
             * 单调时钟算窗口，窗口一到无条件打一条。
             */
            if (dFirstAt == 0) {
                dFirstAt = now;
                dAt = now;
                return;
            }
            final long window = dFirstReport ? 30000 : 8000;
            if (now - dAt < window) return;
            dAt = now;
            dFirstReport = true;
            int draws = FillTextView.DRAW_COUNT - dDraws0;
            dDraws0 = FillTextView.DRAW_COUNT;
            /*
             * 不再因为「计数都是 0」就静默返回。
             * 全 0 本身就是最有价值的信息（说明驱动完全没跑），
             * 恰恰最该打出来。只有「浮层没装、没开填充」这种明确无关时
             * 才跳过，避免刷屏。
             */
            if (!added && !fillProgress) return;
            /*
             * 逐帧 p 序列（见 dProbeP 的注释）。
             * 若这 8 个值几乎一样，就是「p 每帧不变」——
             * 那说明问题在基准点/时钟，而不是绘制。
             */
            StringBuilder seq = new StringBuilder();
            for (int k = 0; k < 8; k++) {
                if (k > 0) seq.append(',');
                seq.append(String.format("%.3f", dProbeP[(dProbeN + k) & 7]));
            }
            LogBridge.add(ctx, "LYRIC", "timing diag: timingRecv=" + dTimingRecv
                    + " ticks=" + dTicks
                    + " frames=" + dTicks
                    + " draws=" + draws
                    + " driver=handler"
                    + " fillProgress=" + fillProgress
                    + " playing=" + timingPlaying
                    + " lineDur=" + lineDurSec
                    + " rate=" + rate
                    + " progress=" + progress
                    + " color=" + String.format("#%06X", color & 0xFFFFFF)
                    + " fillColor=" + String.format("#%06X", fillColor & 0xFFFFFF)
                    + " added=" + added
                    + " view=" + (view != null ? 1 : 0)
                    + " paint[" + FillTextView.takeDiag() + "]"
                    + " pseq=" + seq
                    + " baseP=" + String.format("%.3f", baseProgress)
                    + " lineDur=" + String.format("%.2f", lineDurSec)
                    + " dt=" + String.format("%.0f", (android.os.SystemClock.elapsedRealtime() - baseAt)));
            dTimingRecv = 0; dTicks = 0;
        } catch (Throwable ignored) {
        }
    }

    private void scheduleTick() {
        if (!fillProgress || lineDurSec <= 0.01f) return;
        if (tickScheduled) return;
        tickScheduled = true;
        main.postDelayed(ticker, TICK_MS);
    }

    /** 停掉自驱动（隐藏浮层 / 关掉填充时调用，避免空转耗电） */
    private void stopTick() {
        main.removeCallbacks(ticker);
        tickScheduled = false;
    }

    /**
     * App 前后台状态变化（1.3.3 第六轮的关键修复）。
     *
     * ⚠️ 为什么必须有这个回调：
     *   上一轮为了解决「悬浮窗 invalidate 被吞」，把驱动从 Handler 换成了
     *   Choreographer。前台时它确实更好（对齐 vsync、不漂），但
     *   **Choreographer 的回调依赖 vsync 信号，而进程切到后台后
     *   系统就不再给它分发 vsync 了**（省电策略，AOSP 与各 ROM 都这样）。
     *
     *   于是出现了用户这次报的症状：
     *     「只会在一句播完的时候瞬间填充，然后到下一句」
     *   —— 因为状态栏歌词的使用场景**就是切到别的 App 时看**，
     *   此时 Choreographer 一帧不给，原生外推彻底停摆；
     *   唯一还能画一帧的时刻，就是网页跨桥送来新基准点（换句）的那一下。
     *
     *   修法：后台自动退回 Handler.postDelayed。
     *   Handler 消息由应用自己的 Looper 分发，**不受 vsync 影响**，
     *   后台依然按 30fps 跑（实测 Android 对普通后台 Handler 没有额外节流，
     *   只有 Doze/省电模式才会延迟，那种情况连播放都会断）。
     *
     * @param bg true = App 已切到后台
     */
    public void setAppBackground(final boolean bg) {
        main.post(() -> {
            if (appInBackground == bg) return;
            appInBackground = bg;
            LogBridge.add(ctx, "LYRIC", "app background=" + bg
                    + ", driver=handler");
            /* 切换驱动前先停掉旧的，避免两套同时在跑 */
            stopTick();
            scheduleTick();
        });
    }

    public void setProgress(final String p) {
        diagRecv++;
        if (!fillProgress) {
            diagDrop++;
            diagReport("fillProgress=false");
            return;
        }
        float v;
        try {
            v = Float.parseFloat(String.valueOf(p).trim());
        } catch (Throwable e) {
            diagDrop++;
            diagReport("parse fail: " + p);
            return;
        }
        if (Float.isNaN(v) || Float.isInfinite(v)) {
            diagDrop++;
            diagReport("nan/inf");
            return;
        }
        v = Math.max(0f, Math.min(1f, v));
        // R-11：「读 progress → 比较 → 写 progress」整体进主线程
        final float nv = v;
        main.post(() -> {
            if (Math.abs(nv - progress) < 0.004f) {   // 0.4% 以内不重绘
                diagDrop++;
                diagReport("below threshold");
                return;
            }
            progress = nv;
            diagDraw++;
            applyProgressFill();
            diagReport("ok");
        });
    }

    /** 每 30 秒汇总一次进度诊断（只在有值时打，正常使用不刷屏） */
    private void diagReport(String why) {
        try {
            long now = System.currentTimeMillis();
            if (diagAt == 0) { diagAt = now; return; }
            if (now - diagAt < 30000) return;
            diagAt = now;
            if (diagRecv == 0) return;
            LogBridge.add(ctx, "LYRIC", "progress diag: recv=" + diagRecv
                    + " drop=" + diagDrop + " draw=" + diagDraw
                    + " last=" + why
                    + " fillProgress=" + fillProgress
                    + " progress=" + progress
                    + " added=" + added);
            diagRecv = 0; diagDrop = 0; diagDraw = 0;
        } catch (Throwable ignored) {
        }
    }

    /** 默认位置：屏幕顶部，避开刘海/状态栏图标那一行 */
    private void placeDefault() {
        applyPosition();
    }

    /**
     * 按 posX/posY 摆放；负值表示回到默认位置。
     *
     * 默认位置 = 屏幕水平居中 + 状态栏下沿。
     * 保存过的位置按「窗口左边缘」还原，再钳进屏幕范围内 ——
     * 以前这里写的是 lp.x = Math.max(0, posX)，既不让负值出现，
     * 也从不考虑窗口宽度，于是窗口右侧经常被屏幕裁掉一截。
     */
    private void applyPosition() {
        if (lp == null) return;
        try {
            int statusH = 0;
            try {
                int id = ctx.getResources().getIdentifier("status_bar_height", "dimen", "android");
                if (id > 0) statusH = ctx.getResources().getDimensionPixelSize(id);
            } catch (Throwable ignored) {
            }
            if (posY < 0) {
                // 状态栏下沿再往下一点点，落在状态栏和标题栏之间的空隙里
                lp.y = statusH > 0 ? statusH - dp(2) : dp(26);
            } else {
                /*
                 * J-10 的另一半：已经存进设置里的越界 y（老版本拖出去的）也要拉回来，
                 * 否则升级后浮层仍然在屏幕外——用户不会想到是「旧的坏坐标」。
                 */
                lp.y = clampY(posY);
            }
            if (posX < 0) {
                centerHorizontally();          // 默认：居中（要等窗口量出宽度）
            } else {
                lp.x = clampX(posX);
            }
            LogBridge.add(ctx, "LYRIC", "position x=" + lp.x + " y=" + lp.y
                    + " (saved " + posX + "," + posY + ")");
        } catch (Throwable e) {
            CrashLog.recordAsync(ctx, "lyric-pos", e);
            if (lp != null) lp.y = dp(26);
        }
    }

    /** 把窗口放到屏幕水平正中（窗口宽度取自上一次测量结果） */
    private void centerHorizontally() {
        final View v = view;
        if (lp == null) return;
        if (v == null) { lp.x = 0; return; }
        Runnable place = () -> {
            try {
                if (lp == null) return;
                int vw = v.getWidth();
                int sw = ctx.getResources().getDisplayMetrics().widthPixels;
                /* 还没量出来时先按内容宽度估一个，量完 applyPosition 会再来一次 */
                if (vw <= 0 && v instanceof FillTextView) {
                    /*
                     * 还没量出宽度时先按文字实测宽度估一个。
                     * 用 FillTextView.textWidth() 而不是 TextView.getPaint() ——
                     * 它现在是自绘 View，没有 getPaint()，而且要考虑
                     * 长句被 maxTextWidth 限制后的实际窗口宽度。
                     */
                    FillTextView fv = (FillTextView) v;
                    float tw = fv.textWidth() + dp(6);
                    if (tw <= 0f) tw = sw;
                    vw = Math.min(sw, (int) tw);
                }
                if (vw <= 0) vw = sw;
                lp.x = Math.max(0, (sw - vw) / 2);
                if (added && view != null && wm != null) {
                    try { wm.updateViewLayout(view, lp); } catch (Throwable ignored) {}
                }
            } catch (Throwable e) {
                CrashLog.recordAsync(ctx, "lyric-center", e);
            }
        };
        if (v.getWidth() > 0) place.run();
        else v.post(place);
    }

    /** 把 x 钳到「窗口完全落在屏幕内」的范围 */
    private int clampX(int x) {
        try {
            int sw = ctx.getResources().getDisplayMetrics().widthPixels;
            int vw = view != null ? view.getWidth() : 0;
            if (vw <= 0) vw = sw;
            int max = Math.max(0, sw - vw);
            return Math.max(0, Math.min(x, max));
        } catch (Throwable e) {
            return Math.max(0, x);
        }
    }

    /**
     * 把 y 钳到「窗口完全落在屏幕内」的范围 —— 与 clampX 对称（J-10）。
     *
     * 上限为什么不能省：浮层是 FLAG_LAYOUT_NO_LIMITS，越界不会被系统拦；
     * 一旦拖出屏幕底边又被持久化，重启后它仍然在屏幕外，用户只会觉得
     * 「歌词浮层设置打开了但什么都看不见」，且找不到原因。
     *
     * 高度取不到（还没量完）时不设上限 —— 宁可先不钳，也不能因为按 0 算
     * 而把它强行顶回 y=0，那是另一种「拖不动」。
     * 状态栏/导航栏的 inset 不参与计算：浮层本来就允许压在状态栏上。
     */
    private int clampY(int y) {
        try {
            int sh = ctx.getResources().getDisplayMetrics().heightPixels;
            int vh = view != null ? view.getHeight() : 0;
            int max = vh > 0 ? Math.max(0, sh - vh) : Integer.MAX_VALUE;
            return Math.max(0, Math.min(y, max));
        } catch (Throwable e) {
            return Math.max(0, y);
        }
    }

    /** 锁定 → 不拦触摸；未锁定 → 拦触摸以便拖动和点击 */
    private void updateLayoutFlags() {
        if (lp == null || view == null || wm == null) return;
        try {
            int base = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                    | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
                    | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN;
            if (locked) {
                lp.flags = base | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE;
                view.setAlpha(alpha);
            } else {
                lp.flags = base | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL;
                view.setAlpha(Math.min(1f, alpha + 0.06f));
            }
            wm.updateViewLayout(view, lp);
            LogBridge.add(ctx, "LYRIC", "flags updated locked=" + locked);
        } catch (Throwable e) {
            CrashLog.recordAsync(ctx, "lyric-flags", e);
        }
    }

    private void bindTouch() {
        final float[] down = new float[2];
        final int[] origin = new int[2];
        final boolean[] moved = new boolean[]{false};
        view.setOnTouchListener((v, ev) -> {
            if (locked || lp == null) return false;
            switch (ev.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    down[0] = ev.getRawX();
                    down[1] = ev.getRawY();
                    origin[0] = lp.x;
                    origin[1] = lp.y;
                    moved[0] = false;
                    return true;
                case MotionEvent.ACTION_MOVE: {
                    float dx = ev.getRawX() - down[0];
                    float dy = ev.getRawY() - down[1];
                    if (Math.abs(dx) > dp(3) || Math.abs(dy) > dp(3)) moved[0] = true;
                    lp.x = clampX(origin[0] + (int) dx);
                    /*
                     * J-10：y 方向补齐上限，与 clampX 对称。
                     * 以前只有 Math.max(0, ...) 的下限 —— 配合 FLAG_LAYOUT_NO_LIMITS
                     * （允许布局越界），用户能把歌词一直拖到屏幕底部之外。
                     * 位置会被持久化（onMoved → 网页存设置），重启后它仍然在屏幕外，
                     * 只能靠「恢复默认位置」救回来，用户当时的感觉就是「歌词不见了」。
                     */
                    lp.y = clampY(origin[1] + (int) dy);
                    try { wm.updateViewLayout(view, lp); } catch (Throwable ignored) {}
                    return true;
                }
                case MotionEvent.ACTION_UP:
                case MotionEvent.ACTION_CANCEL: {
                    if (!moved[0]) {
                        Callback c = cb;
                        if (c != null) c.onTap();
                    } else {
                        posX = lp.x;
                        posY = lp.y;
                        Callback c = cb;
                        if (c != null) c.onMoved(lp.x, lp.y);
                    }
                    return true;
                }
                default:
                    return false;
            }
        });
    }

    private int dp(float v) {
        try {
            return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v,
                    ctx.getResources().getDisplayMetrics());
        } catch (Throwable e) {
            return (int) v;
        }
    }

    private static int parseColor(String hex, int fallback) {
        if (hex == null || hex.isEmpty()) return fallback;
        try {
            if (hex.startsWith("#")) return Color.parseColor(hex);
            if (hex.matches("^[0-9a-fA-F]{6,8}$")) return Color.parseColor("#" + hex);
        } catch (Throwable ignored) {
        }
        return fallback;
    }

    private static float parseFloat(String v, float fallback) {
        try { return Float.parseFloat(String.valueOf(v).trim()); } catch (Throwable e) { return fallback; }
    }
}
