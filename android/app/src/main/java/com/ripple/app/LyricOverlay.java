package com.ripple.app;

import android.content.Context;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

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
 *   · 未锁定：可以按住拖动位置；点击一次弹出**原生控制面板**（1.3.8 起）。
 *
 * ===== 原生控制面板（1.3.8）=====
 *
 * 以前点一下是回调网页、由网页弹底部面板。问题很直接：状态栏歌词的
 * 使用场景就是「已经切到别的 App」，而这时网页在后台 —— 弹出来的
 * 底部面板根本看不见（WebView 不可见）。用户点了半天只有等切回 App 才看到。
 * 所以面板必须画在这块悬浮窗自己身上。
 *
 * 结构（为什么是 FrameLayout 套一层，而不是直接给歌词 View 加子 View）：
 *   之前 wm.addView 的是歌词本身（FillTextView，自绘 View，不会布局子 View）。
 *   现在改成：
 *       root(FrameLayout)  ← 真正 addView 给 WindowManager 的那个
 *         ├─ LinearLayout(竖向, id=body)
 *         │    ├─ view   ← 歌词本体（FillTextView），一行代码没改
 *         │    └─ bar    ← 按钮行 / 样式页（默认 GONE）
 *         └─ GlyphButton(✕)  ← 右上角，浮动在 root 的 padding 区域里
 *
 *   view 字段保持不变（大量既有代码在用它的 getWidth/textWidth/alpha…），
 *   只是从「窗口视图」降级成「窗口里的一行」。所有 wm.addView /
 *   updateViewLayout / removeView 全部换成 root。
 *
 * 几何（用户明确要求：面板打开时歌词本身**不能动**）：
 *   面板打开时给 root 设 padding（左上右下 = 12/28/12/10 dp）作为卡片的内缩，
 *   卡片背景是一张圆角 Drawable。
 *   padding 会把内容整体往右下推，所以窗口原点必须**反向平移同样的量**：
 *       lp.x = 歌词x - padLeft ; lp.y = 歌词y - padTop
 *   于是 (窗口原点 + padding) 恒等于歌词原来的屏幕坐标 —— 歌词纹丝不动，
 *   卡片是围着它长出来的。
 *   关闭面板时 padding 归零、背景置 null，窗口正好包住歌词，与旧版完全一致。
 *
 *   为此本类把「窗口原点」和「歌词位置」严格分开：
 *     · 对外的一切（posX/posY、onMoved、applyPosition 的入参）都是**歌词位置**；
 *     · lp.x / lp.y 永远是**窗口原点**，需要时用 lyricXFromWindow() 换算。
 *
 * 自动收起：面板开着就是一块能拦触摸的窗口，一直挂在那儿会挡住下面的 App。
 * 所以打开后 8 秒无操作自动收起（任何点击/拖动都重新计时）。
 */
public class LyricOverlay {

    private static LyricOverlay instance;

    public interface Callback {
        /**
         * 用户点了一下浮层（未锁定时）。
         *
         * ⚠️ 1.3.8 起原生面板接管了「点一下弹面板」，所以 MainActivity 里这个
         * 回调只剩打日志的作用（见 MainActivity.overlay()）。保留它是因为
         * 它同时也是「未锁定浮层被点」这个语义的唯一出口，将来若要再加
         * 其它反应（震动、统计）还有地方挂。
         */
        void onTap();

        /**
         * 用户拖动结束后的新位置（歌曲位置的**屏幕坐标 px**）。
         *
         * 注意这里给的是「歌词的左上角」，不是窗口原点 ——
         * 面板打开时窗口原点被 padding 平移过（见 openPanel / shiftWindowForPanel），
         * 直接把 lp.x/lp.y 报上去会让网页存下的位置一路往左上游。
         */
        void onMoved(int x, int y);

        /**
         * 面板里改了样式（颜色 / 字号）。网页据此落盘。
         *
         * @param colorHex 形如 "#B3A2FF"（不带 alpha）
         * @param sizeSp   字号的十进制字符串，如 "12"
         */
        void onStyle(String colorHex, String sizeSp);

        /** 面板里点了「锁定」。网页据此存盘（原生侧已经先把 locked 落实了） */
        void onLockChanged(boolean locked);

        /** 面板里点了 ✕，浮层已经被原生 hide() 掉；网页据此把 App 里的开关关掉 */
        void onClose();

        /** 面板里的媒体按钮：prev / toggle / next */
        void onCommand(String cmd);
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
    /**
     * 真正的窗口视图（1.3.8）。
     *
     * view（歌词）现在是它的孙子：root → body(竖向 LinearLayout) → view。
     * 为什么要多这一层：卡片背景、内缩 padding、右上角的 ✕、下方的按钮行
     * 都需要一个「容器」来承载；而 FillTextView 是自绘 View，它不布局子 View。
     */
    private FrameLayout root;
    /** root 里唯一那个竖向 LinearLayout，装「歌词 + 按钮行」 */
    private LinearLayout body;
    /** 按钮行（第一页：锁定/上一首/播放暂停/下一首/齿轮） */
    private LinearLayout bar;
    /** 样式页（第二页：预设色点 + 色相条 + T-/T+） */
    private LinearLayout stylePage;
    /** 右上角的关闭按钮（✕），浮动在 root 的 padding 区域里 */
    private GlyphButton closeBtn;
    /** 播放/暂停按钮（要跟着 timingPlaying 换图标，所以留引用） */
    private GlyphButton playBtn;
    /** 齿轮按钮（切到样式页时高亮） */
    private GlyphButton gearBtn;
    /** 锁定按钮（已锁定时高亮） */
    private GlyphButton lockBtn;
    /** 当前正在走哪个页面：false=按钮行，true=样式页 */
    private boolean showingStylePage = false;
    /** 面板是否打开（打开时才设 padding / 背景 / 平移窗口） */
    private volatile boolean panelOpen = false;
    /**
     * 拖动锚点：面板打开期间歌词**在屏幕上的**左上角坐标（px）。
     *
     * 常量 padding + body 左对齐之后，歌词相对窗口的偏移恒为 (padL, padT)，
     * 所以这个值理论上总能由 lp.x + padL 算出来 —— 保留它只是为了拖动时
     * 有一个「按下那一刻的基准」可以累加位移，避免每帧累加误差。
     * 面板关着时它没有意义（不用它）。
     */
    private int anchorX = 0, anchorY = 0;
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
                /*
                 * 面板打开期间被改成锁定（比如用户在 App 里点了「锁定」）：
                 * 必须立刻收起面板。理由很实在 —— 锁定后窗口 flags 变成
                 * FLAG_NOT_TOUCHABLE，面板上的按钮再也收不到触摸，
                 * 会变成一块「看得见但点不动」的黑色卡片挡在状态栏上。
                 *
                 * 注意要在写 this.locked 之前判断旧值：判断依据是
                 * 「本来没锁、现在要锁」。
                 */
                boolean wasLocked = this.locked;
                this.locked = locked;
                if (!wasLocked && locked && panelOpen) {
                    closePanel();
                }
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
                /*
                 * H-14：这里本来是一句 `if (!added || view == null || lp == null) return;`，
                 * 把下面三件本该「随时可做」的事全挡在门外。
                 *
                 * 三种状态的正确分工：
                 *   · 浮层还没建（lp == null）：什么都做不了，改了字段等 show() 用 —— 直接 return；
                 *   · lp 已建、还没 addView（added == false）：**flags 可以先算好写进 lp**，
                 *     show() 拿到的就是对的；位置同理（applyPosition 只写 lp）。
                 *     前端「configure → show」是正常时序，这条分支必须把 flags 落实，
                 *     否则 updateLayoutFlags() 永远等不到 added（H-14 的第二个断点）；
                 *   · 已 addView：三条全做，并让窗口真的重建（updateViewLayout）。
                 */
                if (lp == null) return;
                if (reposition) {
                    applyPosition();
                    updateWindow();
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
            } else {
                /*
                 * P-01 的另一半：**拖过的位置**同样要跟着换句重算一次，
                 * 但方向相反 —— 不是重新居中，而是把窗口宽度变化带来的
                 * 「右边界溢出」收回来。
                 *
                 * 为什么必须有这一段：
                 *   窗口是 WRAP_CONTENT（宽度包住文字），换一句更长的词，
                 *   窗口就变宽。用户把浮层拖到靠右位置时，宽度一涨右半截
                 *   就出屏了；下一句变短又回来。观感是「位置在抖」。
                 *   以前这里是空的 —— 只有 posX < 0 的分支会动，于是拖过的
                 *   位置在换句后由 WindowManager 按旧 x 重新布局，
                 *   超出部分被裁掉，看着就像「位置不对了」。
                 *
                 * 注意这里只**平移不超过既有左边缘**：不改用户选的 x 本身，
                 * 也不回写设置（那是拖动才做的事），下次换回短句自然还原。
                 */
                view.post(() -> {
                    if (view == null || lp == null || !added) return;
                    try {
                        int sw = screenWidthPx();
                        int vw = view.getWidth();
                        if (sw <= 0 || vw <= 0) return;
                        int max = Math.max(0, sw - vw);
                        /*
                         * 每次都从 posX（用户拖出来的那份设置）重算，而不是
                         * 在上一帧的 lp.x 上继续收 —— 否则长句把它推到 max、
                         * 下一句变短时没有回程基准，位置会单向左移、越走越偏。
                         * 这也正是「位置看起来自己跑了」的另一半成因。
                         */
                        int want = Math.min(restoreX(posX), max);
                        /*
                         * want 是「歌词左边缘」，lp.x 是「窗口原点」，
                         * 两者恒差一个常量 padding —— 面板开不开都一样，
                         * 不需要任何分支（1.3.8 第一版这里要分两种算法，
                         * 纯粹是因为那时 padding 和歌词偏移都会变）。
                         */
                        if (want != lyricXFromWindow(lp.x)) {
                            lp.x = toWindowX(want);
                            updateWindow();
                            /* 面板开着时按钮行档位可能因此变化（歌词右移了） */
                            if (panelOpen) relayoutBar(want);
                        }
                    } catch (Throwable e) {
                        CrashLog.recordAsync(ctx, "lyric-reefit", e);
                    }
                });
            }
        });
    }

    /**
     * 运行中切换「锁定 / 解锁」（H-14）。
     *
     * 审查报告说它「零调用方」—— 在当前代码里确实如此（前端改锁定走的是
     * configure() 带 locked 参数那条路）。但它**不能删**：
     *   · configure() 只在浮层已 addView 时才走 updateLayoutFlags()，
     *     而 show() 之前调 configure() 是常态（MainActivity.showLyricOverlay
     *     就是 configure → show）。删掉它之后，「运行中改锁定」就只剩
     *     configure() 一条路，而那条路的 flags 生效依赖 added —— 语义太绕；
     *   · 它是「改锁定」这个动作**唯一**的语义化入口，留着比让下一个维护者
     *     再去 configure 里翻 flags 更不容易出错。
     *
     * 顺带修一个隐藏问题：原来 `if (locked == v && added) return;` 在
     * 「值没变、但还没 added」时也会走到 `if (added) updateLayoutFlags()`，
     * 等于什么都没做。现在只要 lp 已经建出来就重算 flags ——
     * 这样即使浮层还没 addView，锁定态也已经落实到 lp 上，show() 会直接用它。
     */
    public void setLocked(boolean v) {
        main.post(() -> {
            /*
             * 面板开着时被锁定（运行中改锁定）→ 先收起面板。
             * 锁定后 flags 变 FLAG_NOT_TOUCHABLE，面板会变成一块
             * 「看得见但点不动」的暗色卡片挡在状态栏上。
             * 与 configure() 里那段同一条理由，两个入口都要管。
             */
            if (v && panelOpen) closePanel();
            locked = v;
            /* lp 还没建（从未 show 过）时无事可做，show() 会按 locked 初始化 */
            if (lp != null) updateLayoutFlags();
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

                /* 先把「歌词 + 面板」的层级搭好，再建 lp（见类注释里的结构图） */
                buildRoot();

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
                /*
                 * ===== H-14：flags 必须按 locked 决定，不能写死 =====
                 *
                 * 这里原本无条件写死 FLAG_NOT_TOUCHABLE（「锁定态就是纯展示」）——
                 * 于是「解锁」按钮彻底失效：前端把 locked=false 推上来、
                 * configure() 也把字段改成了 false，但窗口 flags 只有
                 * updateLayoutFlags() 会按 locked 重算，而那个方法的调用点
                 * 全在 configure() 里 `if (!added || view == null || lp == null) return;`
                 * **之后** —— 前端走的是 configure() → show() 的顺序，
                 * configure 执行时浮层还没 addView（added=false），当场 return，
                 * updateLayoutFlags() 永远轮不到；接着 show() 又写死
                 * NOT_TOUCHABLE。结果：锁定 → 解锁之后浮层依然收不到触摸，
                 * bindTouch() 注册的 OnTouchListener 一次都不触发。
                 * （1.2.3 删掉 HttpBridge.lockLyricOverlay 时丢的就是这条通路，
                 *   拖到 1.3.5 一直没补回来。）
                 *
                 * 现在统一走 flagsFor(locked) —— 与 updateLayoutFlags() 同一个
                 * 算法（见那个函数上方的注释），两边不可能再漂。
                 * 于是无论「先 configure 后 show」还是「运行中 setLocked」，
                 * 最终生效的 flags 都由 locked 决定。
                 */
                lp.flags = flagsFor(locked);
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
                bindTouch();
                placeDefault();

                wm.addView(root, lp);
                added = true;
                LogBridge.add(ctx, "LYRIC", "overlay shown locked=" + locked);
                /* 浮层是新窗口：播放/暂停图标按当前播放状态重新对一次 */
                syncPlayGlyph();
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
                if (added && root != null && wm != null) wm.removeView(root);
            } catch (Throwable ignored) {
            }
            cancelPanelTimeout();
            added = false;
            panelOpen = false;
            showingStylePage = false;
            /*
             * ⚠️ padding **不要**归零：它是常量，由下一次 show() → buildRoot()
             * 重新算一遍（和这次的值必然相同）。1.3.8 第一版在这里写死
             * padL=0，配合「关闭时先清 padding 后挪窗口」的顺序，
             * 制造出了用户看到的「从左上角弹出来」。
             *
             * 拖动锚点只对「面板打开期间的拖动」有意义，浮层都没了就该清掉。
             */
            anchorX = 0;
            anchorY = 0;
            /*
             * 面板相关的引用必须一起清：它们都挂在旧的 root 上，
             * 留着会让下一次 show() 里的判空误以为「已经建过」而跳过重建。
             */
            view = null;
            root = null;
            body = null;
            bar = null;
            stylePage = null;
            closeBtn = null;
            playBtn = null;
            gearBtn = null;
            lockBtn = null;
            /*
             * ⚠️ 这几个**列表**必须一起清 —— 它们是按钮的唯一登记表，
             * 而 applyBarMode / fitStylePage 会遍历列表往行里 addView。
             * 不清的话下次 show() → buildBar() 会在旧列表后面**再追加** 5 个，
             * 于是同一排按钮被加两遍（前 5 个的父容器是 null，会直接挂上去），
             * 表现为「面板里按钮变多了 / 点错位置」。
             */
            barRowA = null;
            barRowB = null;
            barButtons.clear();
            dotsRowA = null;
            dotsRowB = null;
            dotButtons.clear();
            styleMainRow = null;
            hueBar = null;
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

    /* ================= 原生控制面板（1.3.8） ================= */

    /*
     * ===== 面板的几何参数（dp）—— 常量，永久不变 =====
     *
     *   · 左/右 12dp —— 卡片比歌词「宽一圈」但不显胖；
     *   · 上 28dp    —— 给右上角那个 ✕ 留位（✕ 是 24dp，加上下留白正好 28）；
     *   · 下 10dp    —— 按钮行与卡片底边之间的呼吸。
     *
     * ⚠️⚠️ 这四个 padding 是**常量**：面板开、面板关、锁定、拖动，全部一样。
     *      面板关着时只是「背景置 null + 所有控件 GONE」，窗口比歌词大一圈
     *      但整块全透明，视觉上和「窗口正好包住歌词」没有区别。
     *
     * ===== 为什么必须常量：真机上被 shift 方案坑惨了 =====
     *
     * 1.3.8 第一版走的是「打开面板时把 padding 变大、同时把窗口原点反向平移
     * 同样的量」那套（shift 方案），真机日志（vivo V2425A，411×914dp @3.06）：
     *
     *   16:52:05 panel open lyric=411,528 window=411,528 pad=36,85
     *   16:52:06 panel too wide, padL += 149px (overflow 149)
     *   16:52:06 panel too wide, padL += 149px (overflow 149)   ← 同一个溢出加了两次
     *   16:52:07 position x=-189 (saved 73,588, pad=334,85)     ← padL 36+149+149=334
     *   16:52:09 panel reanchor window=-652,503                 ← 窗口被推到屏幕外 652px
     *   16:52:23 position x=19 y=433 (saved 411,518, pad=410,85) ← padL 只增不减
     *
     * 病灶有两个，而且都是结构性的、没法靠打补丁解决：
     *   ① 「卡片太宽 → 补左 padding」这一步是**累加**的，而 reanchorPanel 会被
     *      OnLayoutChangeListener、openPanel、setStylePage 反复调用 ——
     *      同一次溢出被加两遍，改一次字号 padL 就涨一截，永远不回落，
     *      最后把窗口推出屏幕（-652px）；
     *   ② 关闭时「先清 padding、后挪窗口」，中间有一帧是「padding 已归零、
     *      窗口还在旧位置」，内容画到左上角 → 用户看到「从左上角弹出来」。
     *
     * 结论（别再改回去）：**只要 padding 会变，就一定有「几何在动」的那一帧，
     * 也就一定有可见的跳变**。所以改成 padding 恒定、窗口几何永不变化，
     * 打开/关闭只切内容的可见性 —— 窗口只是向下长高（按钮行变 VISIBLE），
     * 左上角一像素都不动，歌词自然纹丝不动、也不可能有弹出效果。
     */
    private static final int PAD_LR_DP = 12;
    private static final int PAD_TOP_DP = 28;
    private static final int PAD_BOTTOM_DP = 10;
    /** 卡片背景：18dp 圆角 + 约 85% 不透明的深灰，压暗但不遮死底下的内容 */
    private static final int CARD_BG_COLOR = 0xD91A1A1E;
    private static final int CARD_RADIUS_DP = 18;
    /** 面板无操作后自动收起的时长（毫秒） */
    private static final long PANEL_TIMEOUT_MS = 8000L;
    /** 图标按钮的边长（dp） */
    private static final int GLYPH_DP = 32;
    /** 色相条宽度（dp）。不能用 weight —— 见 buildStylePage 里的说明 */
    private static final int HUE_BAR_W_DP = 96;

    /**
     * 预设色点 —— 必须与网页 app.js 里的 SB_COLORS 完全一致，
     * 否则「原生面板选的颜色」在 App 设置页里显示不出来（找不到匹配的选中态）。
     */
    private static final String[] SB_COLORS = {
            "#FFFFFF", "#FFD166", "#8FD8FF", "#B3A2FF",
            "#FF9EC4", "#7DE3D0", "#000000", "#F1EEEA"
    };

    /**
     * 面板 padding 的像素值 —— **永远**是 12/28/12/10 dp，建 root 时算一次，之后不再改。
     * 见上面那段「为什么必须常量」。任何地方出现 padL = 0 或 padL += 的写法都是 bug。
     */
    private int padL = 0, padT = 0, padR = 0, padB = 0;

    /** 样式改动回写网页的合并器（见 pushStyleDebounced） */
    private boolean styleDirty = false;

    /** 8 秒自动收起 */
    private final Runnable panelTimeout = new Runnable() {
        @Override
        public void run() {
            if (!panelOpen) return;
            LogBridge.add(ctx, "LYRIC", "panel auto close (timeout)");
            closePanel();
        }
    };

    /**
     * 样式回写的延迟任务。
     *
     * 为什么要延迟合并而不是每次改动都直接跨桥：
     *   色相条拖动一次会产生几十上百个 onChange（每个像素一次），
     *   每次都 evaluateJavascript 会把 JS 桥线程打满，
     *   拖动本身反而变得卡顿。合并成「最后一次改动后 120ms 推一次」，
     *   既保证网页最终一定拿到最新值（末值必达），又把跨桥次数压到个位数。
     */
    private final Runnable stylePusher = new Runnable() {
        @Override
        public void run() {
            if (!styleDirty) return;
            styleDirty = false;
            try {
                Callback c = cb;
                if (c != null) {
                    c.onStyle(String.format("#%06X", color & 0xFFFFFF),
                            String.valueOf(Math.round(sizeSp)));
                }
            } catch (Throwable e) {
                CrashLog.recordAsync(ctx, "lyric-style-cb", e);
            }
        }
    };

    /*
     * ===== 歌词坐标 ⇄ 窗口原点（唯一一对换算，别在别处再写第三份） =====
     *
     * 因为有 padding 恒定 + body 左对齐（gravity=START），歌词相对窗口原点的
     * 偏移**永远**等于 (padL, padT)，与面板开没开、卡片多宽、换了几句都无关：
     *
     *     歌词左上角（屏幕） = 窗口原点 + (padL, padT)
     *
     * 所以这是一个纯减法，不需要任何布局后实测（1.3.8 第一版那套
     * lyricInRoot / reanchorPanel 正是因为没有这个前提才必须实测）。
     */
    private int lyricXFromWindow(int windowX) {
        return windowX + padL;
    }

    private int lyricYFromWindow(int windowY) {
        return windowY + padT;
    }

    /** 歌词位置 → 窗口原点（所有摆放代码都必须走它） */
    private int toWindowX(int lyricX) {
        return lyricX - padL;
    }

    private int toWindowY(int lyricY) {
        return lyricY - padT;
    }

    /**
     * 搭出「根 FrameLayout → 竖向 LinearLayout（歌词 + 按钮行/样式页）→ 右上角 ✕」。
     *
     * 为什么 ✕ 挂在 root 上而不是 body 里：
     *   它要浮在 padding 留出来的那块空白里，不占歌词和按钮行的高度。
     *   挂在 body 里会让它成为布局的一部分，面板高度会多出一行。
     */
    private void buildRoot() {
        /*
         * padding 在这里算一次，之后永不改变（见 PAD_LR_DP 上方那段注释）。
         */
        padL = dp(PAD_LR_DP);
        padT = dp(PAD_TOP_DP);
        padR = dp(PAD_LR_DP);
        padB = dp(PAD_BOTTOM_DP);

        root = new FrameLayout(ctx);
        /* padding 恒定量，开局就设上：窗口从第一次 addView 起就比歌词大一圈 */
        root.setPadding(padL, padT, padR, padB);

        body = new LinearLayout(ctx);
        body.setOrientation(LinearLayout.VERTICAL);
        /*
         * ⚠️ 必须是 START，不能是 CENTER_HORIZONTAL。
         *
         * 面板打开时 body 的宽度 = max(歌词宽, 按钮行宽)。按钮行（5 个 32dp
         * 图标 ≈ 180dp）经常比一句短歌词宽，若歌词在 body 里**居中**，
         * 它就会随按钮行宽度右移 —— 而按钮行宽度会随「第一页/样式页」切换、
         * 字号变化而变，于是歌词位置跟着飘。
         *
         * 左对齐后：歌词永远贴 body 左边，而 body 左边 = root 左边 + padL，
         * 恒定不变 → 歌词屏幕坐标恒定。这正是「打开面板歌词不能动」的落地方式。
         */
        body.setGravity(Gravity.START);
        root.addView(body, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT));

        /*
         * 歌词。宽度仍然由它自己 WRAP_CONTENT 决定 ——
         * 位置计算（clampX / centerHorizontally / setText 重排）全都建立在
         * 「view.getWidth() 是歌词宽度」这个前提上，不能改成 MATCH_PARENT，
         * 否则那些换算会整片错位。
         */
        body.addView(view, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT));

        body.addView(buildBar(), new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT));
        body.addView(buildStylePage(), new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT));

        closeBtn = new GlyphButton(ctx);
        closeBtn.setGlyph(GlyphButton.CLOSE);
        closeBtn.setContentDescription(L10n.t("关闭状态栏歌词", "Turn off status bar lyrics"));
        closeBtn.setOnClickListener(v -> {
            bumpPanelTimeout();
            doClose();
        });
        FrameLayout.LayoutParams clp = new FrameLayout.LayoutParams(dp(24), dp(24));
        clp.gravity = Gravity.TOP | Gravity.END;
        root.addView(closeBtn, clp);

        /*
         * ===== 卡片背景（含 padding 空白区）也能拖动 =====
         *
         * 用户原话：「拖动状态栏歌词黑色背景时也要能移动」—— 之前只有歌词
         * 本身（view）能拖，点在黑色卡片上什么都不发生。
         *
         * 为什么挂 OnTouchListener 而不是 OnClickListener：
         *   ViewGroup.dispatchTouchEvent 会先把事件给子 View，只有**没有子 View
         *   消费**时才轮到自己的 OnTouchListener。所以歌词上的拖动、
         *   按钮/✕/色点/色相条的点击都不会被这里抢走 —— 正好只兜住
         *   「点在卡片空白或 padding 上」这一种情况。
         *
         * 面板关着时不拦（返回 false）：那时窗口虽然比歌词大一圈，但全透明，
         * 用户看不到也点不到 —— 拦住反而会挡住歌词下方 App 的正常操作。
         */
        root.setOnTouchListener((v, ev) -> {
            if (!panelOpen || locked || lp == null) return false;
            return onPanelBackgroundTouch(ev);
        });

        /* 起始态：面板是关的 —— 常量 padding 不动，只把背景和控件藏起来 */
        applyPanelChrome(false);
    }

    /**
     * 卡片背景上的触摸：与 view 上完全相同的拖动语义。
     *
     * 唯一区别是「按下时的基准」—— 这里用 anchorX/anchorY（打开面板时记下的
     * 歌词屏幕坐标），因为卡片背景本身没有「歌词宽高」可以参考。
     *
     * ⚠️ 全程不许改 lp.x 之外的任何几何：padding 是常量，窗口原点只由
     *    「歌词位置 - padding」决定。1.3.8 第一版在这里做过 padL 累加，
     *   把窗口推到屏幕外 652px（见 PAD_LR_DP 上方的真机日志）。
     */
    private boolean onPanelBackgroundTouch(MotionEvent ev) {
        switch (ev.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                bgDownX = ev.getRawX();
                bgDownY = ev.getRawY();
                bgOriginX = lyricXFromWindow(lp.x);
                bgOriginY = lyricYFromWindow(lp.y);
                anchorX = bgOriginX;
                anchorY = bgOriginY;
                bgMoved = false;
                bumpPanelTimeout();
                return true;
            case MotionEvent.ACTION_MOVE: {
                float dx = ev.getRawX() - bgDownX;
                float dy = ev.getRawY() - bgDownY;
                if (Math.abs(dx) > dp(3) || Math.abs(dy) > dp(3)) bgMoved = true;
                /* clampX/clampY 的入参是**歌词坐标**（它们的语义一直是歌词能放哪） */
                anchorX = clampX(bgOriginX + (int) dx);
                anchorY = clampY(bgOriginY + (int) dy);
                lp.x = toWindowX(anchorX);
                lp.y = toWindowY(anchorY);
                updateWindow();
                if (bgMoved) bumpPanelTimeout();
                return true;
            }
            case MotionEvent.ACTION_UP:
            case MotionEvent.ACTION_CANCEL: {
                if (bgMoved) {
                    /* 存的是歌词位置，不是窗口原点 */
                    posX = anchorX;
                    posY = anchorY;
                    Callback c = cb;
                    if (c != null) c.onMoved(anchorX, anchorY);
                }
                return true;
            }
            default:
                return false;
        }
    }

    /* 卡片背景拖动的一次性状态（不进字段池，只给 onPanelBackgroundTouch 用） */
    private float bgDownX, bgDownY;
    private int bgOriginX, bgOriginY;
    private boolean bgMoved = false;

    /*
     * ===== 按钮行：宽度自适应，绝不靠挪窗口来塞进屏幕 =====
     *
     * 用户报的「点击调整颜色时 状态栏歌词下方黑被拉长」，根因就是第一版
     * 想用「把窗口往左挪 / 补左 padding」来给变宽的按钮行腾地方 ——
     * 而窗口一动就带动歌词，于是只能靠 padding 累加去补偿，
     * 最后 padL 涨到 410px、窗口被推到屏幕外 652px（真机日志见 PAD_LR_DP 注释）。
     *
     * 正确做法：**窗口不动，让按钮行自己变窄**。四档，从好看往紧凑退：
     *   A 单行 + 左右各 2dp margin      （5×32 + 10×2 = 180dp）← 默认
     *   B 单行 + margin 压到 0          （5×32 = 160dp）
     *   C 两行（3+2）+ margin 0         （3×32 = 96dp 一行）
     *   D 两行 + 按钮缩到 26dp + margin 0（3×26 = 78dp 一行）← 极窄屏兜底
     * 任何一档都不改 lp.x / padding。
     */
    private LinearLayout barRowA;      // 第一行（单行模式时就是全部按钮）
    private LinearLayout barRowB;      // 第二行（只有两行模式才有内容）
    private final java.util.List<GlyphButton> barButtons = new java.util.ArrayList<>();

    /** 第一页：锁定 / 上一首 / 播放暂停 / 下一首 / 齿轮 */
    private LinearLayout buildBar() {
        bar = new LinearLayout(ctx);
        bar.setOrientation(LinearLayout.VERTICAL);
        bar.setGravity(Gravity.CENTER_HORIZONTAL);
        bar.setVisibility(View.GONE);

        barRowA = new LinearLayout(ctx);
        barRowA.setOrientation(LinearLayout.HORIZONTAL);
        barRowA.setGravity(Gravity.CENTER);
        barRowB = new LinearLayout(ctx);
        barRowB.setOrientation(LinearLayout.HORIZONTAL);
        barRowB.setGravity(Gravity.CENTER);
        barRowB.setVisibility(View.GONE);

        lockBtn = makeBarBtn(GlyphButton.LOCK, L10n.t("锁定", "Lock"), v -> doLock());
        makeBarBtn(GlyphButton.PREV, L10n.t("上一首", "Previous"), v -> sendCommand("prev"));
        playBtn = makeBarBtn(GlyphButton.PLAY,
                L10n.t("播放暂停", "Play or pause"), v -> sendCommand("toggle"));
        makeBarBtn(GlyphButton.NEXT, L10n.t("下一首", "Next"), v -> sendCommand("next"));
        gearBtn = makeBarBtn(GlyphButton.GEAR, L10n.t("样式", "Style"), v -> {
            setStylePage(!showingStylePage);
        });

        bar.addView(barRowA, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        bar.addView(barRowB, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        /* 默认单行（真正的档位在 openPanel 里按可用宽度重算） */
        applyBarMode(1, dp(GLYPH_DP), dp(2));
        syncPlayGlyph();
        return bar;
    }

    /**
     * 造一个按钮并记进 barButtons。
     *
     * 为什么不在这里 setMargins/setLayoutParams：位置和大小由
     * {@link #applyBarMode} 统一决定 —— 档位切换时要重新摆一遍，
     * 建的时候写死会让两处打架。
     */
    private GlyphButton makeBarBtn(int glyph, String desc, View.OnClickListener l) {
        final GlyphButton b = new GlyphButton(ctx);
        b.setGlyph(glyph);
        b.setContentDescription(desc);
        b.setOnClickListener(v -> {
            /*
             * 任何一次点击都算「有操作」，重新计时。
             * 放在这里而不是各自 onClick 里，是为了漏不掉 ——
             * 以后新加按钮也会自动带上自动收起的续期。
             */
            bumpPanelTimeout();
            if (l != null) l.onClick(v);
        });
        barButtons.add(b);
        return b;
    }

    /**
     * 按档位重新摆按钮：{@code rows} 行、{@code glyphPx} 边长、{@code marginPx} 左右留白。
     *
     * 会先把按钮从旧的行里摘下来再挂到新的行里 —— 这是「1 行 ↔ 2 行」切换
     * 唯一的正确做法（一个 View 只能有一个父容器）。
     */
    private void applyBarMode(int rows, int glyphPx, int marginPx) {
        if (barRowA == null || barRowB == null) return;
        /* 先全部摘下来，避免「先 add 后 remove」导致同一个 View 有两个父容器 */
        for (GlyphButton b : barButtons) {
            ViewGroup p = (ViewGroup) b.getParent();
            if (p != null) p.removeView(b);
        }

        final int split = rows >= 2 ? 3 : barButtons.size();   // 两行时 3+2
        for (int i = 0; i < barButtons.size(); i++) {
            GlyphButton b = barButtons.get(i);
            LinearLayout.LayoutParams p =
                    new LinearLayout.LayoutParams(glyphPx, glyphPx);
            p.setMargins(marginPx, 0, marginPx, 0);
            b.setLayoutParams(p);
            if (i < split) barRowA.addView(b);
            else barRowB.addView(b);
        }
        barRowB.setVisibility(rows >= 2 && barRowB.getChildCount() > 0
                ? View.VISIBLE : View.GONE);
        /* 两行时行间留一点缝，否则两排图标贴在一起 */
        if (barRowB.getChildCount() > 0) barRowB.setPadding(0, dp(2), 0, 0);
    }

    /**
     * 按「当前歌词有多宽、还能往右长多少」挑一档最宽的、能放下的按钮布局。
     *
     * 约束（不许挪窗口，所以只能压按钮行）：
     *   卡片右边缘 = (歌词x - padL) + [max(歌词w, 按钮行w) + padL + padR]
     *   要求 <= 屏宽
     *   ⇒ 按钮行宽 <= 屏宽 - padR - 歌词x
     *
     * 之所以不从「屏宽 - 2*padLR - 歌词宽」算（那是假设歌词水平居中的乐观值）：
     * 用户可以把歌词拖到屏幕右边，那时能往右长的空间比居中时小得多 ——
     * 用居中值会算出「能放下」，然后卡片右半截被裁掉。
     *
     * ⚠️ 已知的、有意接受的极限情况：
     *   用户把歌词一直拖到贴着屏幕右边缘时（clampX 允许 lyrics 右边缘 == 屏宽），
     *   卡片背景必然有 padR（12dp≈37px）伸出屏幕右边、被裁掉一条。
     *   这一条**故意不修**：
     *     · 裁掉的只是卡片右上角一小块圆角背景，不是按钮（按钮在 body 里、
     *       受 availBody 约束，一定在屏幕内，见 relayoutBar）；
     *     · 想修只能改 clampX 把歌词往左夹 —— 那会改变「面板没开时」的拖动
     *       行为（用户会发现歌词拖不到最右边），是因小失大。
     *
     * @param lyricX 歌词左边缘的屏幕坐标（px）
     */
    private void relayoutBar(int lyricX) {
        try {
            if (barButtons.isEmpty()) return;
            final int sw = screenWidthPx();
            if (sw <= 0) return;
            /* 按钮行/样式页最多能有这么宽（卡片右边缘不许过屏幕右边） */
            int availBar = sw - padR - lyricX;
            if (availBar <= 0) availBar = 1;
            /* 样式页也按同一个可用宽度收窄（它在同一个 body 里） */
            fitStylePage(availBar);

            final int g32 = dp(GLYPH_DP);
            final int g26 = dp(26);
            final int m2 = dp(2);
            final int n = barButtons.size();          // 5
            final int rowCount2 = 3;                  // 两行时第一行 3 个

            /* A: 单行 + 2dp margin */
            if (n * g32 + n * 2 * m2 <= availBar) {
                applyBarMode(1, g32, m2);
                LogBridge.add(ctx, "LYRIC", "bar mode A (1 row, 32dp, 2dp margins) avail=" + availBar);
                return;
            }
            /* B: 单行 + margin 0 */
            if (n * g32 <= availBar) {
                applyBarMode(1, g32, 0);
                LogBridge.add(ctx, "LYRIC", "bar mode B (1 row, 32dp, no margin) avail=" + availBar);
                return;
            }
            /* C: 两行 3+2 + 32dp + margin 0 */
            if (rowCount2 * g32 <= availBar) {
                applyBarMode(2, g32, 0);
                LogBridge.add(ctx, "LYRIC", "bar mode C (2 rows, 32dp) avail=" + availBar);
                return;
            }
            /* D: 两行 + 26dp 兜底（极窄屏） */
            applyBarMode(2, g26, 0);
            LogBridge.add(ctx, "LYRIC", "bar mode D (2 rows, 26dp, cramped) avail=" + availBar);
        } catch (Throwable e) {
            CrashLog.recordAsync(ctx, "lyric-bar-layout", e);
        }
    }

    /*
     * 样式页也是「宽度自适应」的，理由和按钮行完全相同：
     * 不许改 lp.x，所以只能让内容自己收窄。
     *   色点：8 个一行（22+4 各 = 208dp）→ 放不下就 4+4 两行（104dp）
     *   色相条：宽 96dp → 放不下就按剩余空间收缩（最低 48dp）
     */
    private LinearLayout dotsRowA, dotsRowB;
    private final java.util.List<GlyphButton> dotButtons = new java.util.ArrayList<>();
    private LinearLayout styleMainRow;

    /** 第二页：预设色点 + 色相条 + 字号增减 */
    private LinearLayout buildStylePage() {
        stylePage = new LinearLayout(ctx);
        stylePage.setOrientation(LinearLayout.VERTICAL);
        stylePage.setGravity(Gravity.START);
        stylePage.setVisibility(View.GONE);

        /* ---- 预设色点（与网页 SB_COLORS 一一对应） ---- */
        dotsRowA = new LinearLayout(ctx);
        dotsRowA.setOrientation(LinearLayout.HORIZONTAL);
        dotsRowA.setGravity(Gravity.CENTER_VERTICAL);
        dotsRowB = new LinearLayout(ctx);
        dotsRowB.setOrientation(LinearLayout.HORIZONTAL);
        dotsRowB.setGravity(Gravity.CENTER_VERTICAL);
        dotsRowB.setVisibility(View.GONE);

        for (final String hex : SB_COLORS) {
            final int c = parseColor(hex, Color.WHITE);
            GlyphButton d = new GlyphButton(ctx);
            d.setSwatch(c);
            d.setContentDescription(L10n.t("颜色 " + hex, "Color " + hex));
            d.setOnClickListener(v -> {
                bumpPanelTimeout();
                applyPanelColor(c);
                syncSwatches();
            });
            dotButtons.add(d);
        }
        stylePage.addView(dotsRowA);
        stylePage.addView(dotsRowB);

        /* ---- 色相条 + 字号增减（同一行） ---- */
        styleMainRow = new LinearLayout(ctx);
        styleMainRow.setOrientation(LinearLayout.HORIZONTAL);
        styleMainRow.setGravity(Gravity.CENTER_VERTICAL);

        /*
         * 「完成」按钮：切回第一页。
         * ⚠️ 这一项是需求里没写、但实现上**必须**有的：样式页把按钮行整排
         *    换掉了，不给出口的话用户只能等 8 秒自动收起才能回到媒体按钮。
         *    图标用 CHECK（需求里预留的第 8 个字形，语义正好是「确认完成」）。
         */
        GlyphButton done = new GlyphButton(ctx);
        done.setGlyph(GlyphButton.CHECK);
        done.setContentDescription(L10n.t("完成", "Done"));
        LinearLayout.LayoutParams dlp =
                new LinearLayout.LayoutParams(dp(26), dp(26));
        dlp.setMargins(dp(2), dp(2), 0, dp(2));
        done.setLayoutParams(dlp);
        done.setOnClickListener(v -> {
            bumpPanelTimeout();
            setStylePage(false);
        });
        styleMainRow.addView(done);

        hueBar = new HueBar(ctx);
        hueBar.setContentDescription(L10n.t("自定义颜色", "Custom color"));
        hueBar.setOnColorChange(c -> {
            applyPanelColor(c);
            syncSwatches();
            bumpPanelTimeout();
        });
        /*
         * ⚠️ 宽度不能用 weight（LayoutParams(0, h, 1f)）。
         * 整个面板是 WRAP_CONTENT 一路下来的，带 weight 的子 View 在
         * 「父容器宽度由内容决定」的场景里会被量成 0 宽 —— 色相条直接消失，
         * 而样式页高度还是对的，现象是「这一行只剩下完成键和 T±」。
         * 改成固定宽度，放不下时由 fitStylePage 按可用空间调小。
         */
        styleMainRow.addView(hueBar);

        /*
         * T- / T+：需求里明确说「用简单 TextView 也行」，就保持最朴素的样子。
         * 字号范围 9..22 与网页设置页的滑杆完全一致 ——
         * 这里放宽会导致网页滑杆把值钳回去，用户看到「改了又跳回来」。
         */
        addSizeBtn(styleMainRow, "T-", L10n.t("字号减小", "Smaller text"), -1);
        addSizeBtn(styleMainRow, "T+", L10n.t("字号增大", "Larger text"), +1);

        stylePage.addView(styleMainRow);

        /* 默认形态（真正的宽窄在 openPanel / clampIntoPanel 里按实测重算） */
        fitStylePage(dp(300));
        return stylePage;
    }

    private HueBar hueBar;

    /**
     * 按可用宽度摆样式页：色点 1 行 ↔ 2 行、色相条宽度收缩。
     *
     * @param availBody 面板内容区最多能有多宽（px）。
     *                  = 屏宽 - padR - 歌词左边缘
     */
    private void fitStylePage(int availBody) {
        if (dotsRowA == null || dotsRowB == null || dotButtons.isEmpty()) return;
        try {
            final int dotPx = dp(22);
            final int dotM = dp(2);
            final int perDot = dotPx + dotM * 2;

            /* 先全部摘下来，再按行数重新分配 */
            for (GlyphButton d : dotButtons) {
                ViewGroup p = (ViewGroup) d.getParent();
                if (p != null) p.removeView(d);
            }

            final boolean oneRow = dotButtons.size() * perDot <= availBody;
            final int split = oneRow ? dotButtons.size() : (dotButtons.size() + 1) / 2;
            for (int i = 0; i < dotButtons.size(); i++) {
                GlyphButton d = dotButtons.get(i);
                LinearLayout.LayoutParams p =
                        new LinearLayout.LayoutParams(dotPx, dotPx);
                p.setMargins(dotM, dp(1), dotM, dp(1));
                d.setLayoutParams(p);
                if (i < split) dotsRowA.addView(d);
                else dotsRowB.addView(d);
            }
            dotsRowB.setVisibility(dotsRowB.getChildCount() > 0
                    ? View.VISIBLE : View.GONE);

            /*
             * 色相条宽度：剩下的空间给多少用多少，但夹在 [48dp, 96dp]。
             * 下限 48dp 是「还能拖动选色」的实用最小值；再窄就点不准了。
             */
            if (hueBar != null) {
                int fixed = dp(26 + 2)                  // 完成键 + margin
                        + dp(72)                        // T- / T+ 两个字的估算宽度
                        + dp(10);                       // 色相条左右 margin
                int hueW = Math.min(dp(HUE_BAR_W_DP), Math.max(dp(48), availBody - fixed));
                LinearLayout.LayoutParams hlp =
                        new LinearLayout.LayoutParams(hueW, dp(22));
                hlp.setMargins(dp(4), dp(2), dp(4), dp(2));
                hueBar.setLayoutParams(hlp);
            }
        } catch (Throwable e) {
            CrashLog.recordAsync(ctx, "lyric-style-fit", e);
        }
    }

    private TextView addSizeBtn(LinearLayout parent, String label, String desc,
                                final int delta) {
        TextView tv = new TextView(ctx);
        tv.setText(label);
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f);
        tv.setTextColor(0xFFF2F2F2);
        tv.setGravity(Gravity.CENTER);
        tv.setContentDescription(desc);
        tv.setClickable(true);
        tv.setFocusable(true);
        /* 触摸区域别只有字形那么大，13sp 的文字本身很窄 */
        tv.setPadding(dp(8), dp(4), dp(8), dp(4));
        tv.setOnClickListener(v -> {
            bumpPanelTimeout();
            applyPanelSize(sizeSp + delta);
        });
        parent.addView(tv);
        return tv;
    }

    /** 把当前的 color / sizeSp 同步到色点与色相条的选中态 */
    private void syncSwatches() {
        try {
            if (stylePage == null) return;
            /*
             * ⚠️ 遍历 dotButtons 列表，不要遍历 stylePage 的某个子行。
             * 色点在「一行 8 个」和「两行 4+4」之间会搬家（fitStylePage），
             * 按行遍历时第二行的 4 个色点永远轮不到选中态 ——
             * 现象是「选了浅紫/樱粉/薄荷/黑，色点上没有勾」。
             */
            int cur = color & 0xFFFFFF;
            for (int i = 0; i < dotButtons.size() && i < SB_COLORS.length; i++) {
                int hex = parseColor(SB_COLORS[i], Color.WHITE) & 0xFFFFFF;
                dotButtons.get(i).setActive(hex == cur);
            }
            if (hueBar != null) hueBar.setColor(color);
            if (lockBtn != null) lockBtn.setActive(locked);
            if (gearBtn != null) gearBtn.setActive(showingStylePage);
        } catch (Throwable e) {
            CrashLog.recordAsync(ctx, "lyric-swatch", e);
        }
    }

    /** 面板里改颜色：立即生效 + 合并回写网页 */
    private void applyPanelColor(int c) {
        /*
         * ⚠️ 必须显式补不透明 alpha（0xFF000000）。
         * 面板给的是 RGB（色点是 #FFFFFF 这种、色相条是 HSVToColor 的纯色），
         * 而 FillTextView 直接把这个 int 当 Paint 颜色用 —— 若只保留低 24 位，
         * 得到的就是 alpha=0 的完全透明色，歌词会当场消失。
         * 透明度由单独的 view.setAlpha(alpha) 负责，不在这里参与。
         */
        color = 0xFF000000 | (c & 0xFFFFFF);
        applyStyle();
        pushStyleDebounced();
        LogBridge.add(ctx, "LYRIC", "panel color=" + String.format("#%06X", color & 0xFFFFFF));
    }

    /** 面板里改字号：立即生效 + 合并回写网页 */
    private void applyPanelSize(float sp) {
        sizeSp = Math.max(9f, Math.min(22f, sp));
        applyStyle();
        pushStyleDebounced();
        /* 字号一变歌词宽度就变，居中/边界都要重算 */
        if (posX < 0) {
            centerHorizontally();
        } else {
            clampIntoPanel();
        }
        LogBridge.add(ctx, "LYRIC", "panel size=" + sizeSp);
    }

    private void pushStyleDebounced() {
        styleDirty = true;
        main.removeCallbacks(stylePusher);
        main.postDelayed(stylePusher, 120);
    }

    /** 收起面板前把待回写的样式立刻推出去（否则最后 120ms 内的改动会丢） */
    private void flushStyle() {
        main.removeCallbacks(stylePusher);
        if (styleDirty) stylePusher.run();
    }

    /** 播放/暂停图标跟随真实播放状态（timingPlaying 由 setTiming 更新） */
    private void syncPlayGlyph() {
        try {
            if (playBtn == null) return;
            playBtn.setGlyph(timingPlaying ? GlyphButton.PAUSE : GlyphButton.PLAY);
        } catch (Throwable ignored) {
        }
    }

    /** 媒体按钮 → 网页 */
    private void sendCommand(String cmd) {
        try {
            Callback c = cb;
            if (c != null) c.onCommand(cmd);
        } catch (Throwable e) {
            CrashLog.recordAsync(ctx, "lyric-cmd", e);
        }
    }

    /**
     * 面板里点「锁定」。
     *
     * 顺序是有讲究的，不能换：
     *   ① 先收起面板 —— 锁定会立刻把窗口 flags 换成 FLAG_NOT_TOUCHABLE，
     *      那时面板已经收不到任何触摸，留着就是一块挡在状态栏上的死卡片；
     *   ② 再落实 locked —— flagsFor / updateLayoutFlags 都按 locked 算；
     *   ③ 最后回调网页存盘。
     */
    private void doLock() {
        closePanel();
        locked = true;
        updateLayoutFlags();
        try {
            Callback c = cb;
            if (c != null) c.onLockChanged(true);
        } catch (Throwable e) {
            CrashLog.recordAsync(ctx, "lyric-lock-cb", e);
        }
        LogBridge.add(ctx, "LYRIC", "panel lock");
    }

    /** 面板里点 ✕：先真的关掉浮层，再让网页把开关也关掉 */
    private void doClose() {
        try {
            Callback c = cb;
            hide();
            if (c != null) c.onClose();
        } catch (Throwable e) {
            CrashLog.recordAsync(ctx, "lyric-close-cb", e);
        }
        LogBridge.add(ctx, "LYRIC", "panel close");
    }

    /** 在第一页 / 样式页之间切换 */
    private void setStylePage(boolean style) {
        showingStylePage = style;
        try {
            if (bar != null) bar.setVisibility(style ? View.GONE : View.VISIBLE);
            if (stylePage != null) stylePage.setVisibility(style ? View.VISIBLE : View.GONE);
            syncSwatches();
            /*
             * 两页的宽度需求不同（按钮行 5×32，样式页是色点行 + 色相条行），
             * 切过去时按当前可用空间重新摆一次。
             */
            if (lp != null) {
                int availBody = screenWidthPx() - padR - lyricXFromWindow(lp.x);
                if (availBody > 0) fitStylePage(availBody);
            }
        } catch (Throwable e) {
            CrashLog.recordAsync(ctx, "lyric-page", e);
        }
        /*
         * 样式页比按钮行宽/高都可能不同 → 重新挑一档按钮行布局。
         * ⚠️ 只调按钮行，窗口不动（第一版这里 post 的是 reanchorPanel，
         *    而那个函数会改 padding，正是 padL 累加的另一个入口）。
         */
        if (root != null) root.post(this::clampIntoPanel);
    }

    /** 点歌词：没开就打开，开着就收起（需求里的第 3 条） */
    private void togglePanel() {
        if (panelOpen) closePanel();
        else openPanel();
    }

    /**
     * 打开面板。
     *
     * ⚠️ 这里**不动窗口几何**（1.3.8 第一版就是在这一段挪窗口 + 改 padding，
     *    制造出了真机上那串 padL 累加和「从左上角弹出来」）。
     *
     * 具体只做三件事：
     *   ① 记下拖动锚点（歌词屏幕坐标，供拖动用）；
     *   ② 按「当前歌词位置还能往右长多少」挑一档按钮行布局（不挪窗口！）；
     *   ③ 把背景、✕、按钮行切到可见 —— 窗口于是「向下长高」，
     *      左上角一像素都不动，歌词自然纹丝不动。
     *
     * 窗口原点完全不用改：歌词相对窗口原点的偏移恒为 (padL, padT)，
     * 所以 lp.x/lp.y 在打开面板前后是**同一个值**。
     */
    private void openPanel() {
        if (panelOpen || root == null || lp == null || !added) return;
        try {
            /* 歌词屏幕坐标 = 窗口原点 + 常量 padding，纯减法，不需要实测 */
            anchorX = lyricXFromWindow(lp.x);
            anchorY = lyricYFromWindow(lp.y);

            panelOpen = true;
            showingStylePage = false;

            /*
             * 先按真实歌词位置挑按钮行档位，再让按钮行可见 ——
             * 否则会有一帧「按钮行按上一档的宽度画出来」再跳一下。
             */
            relayoutBar(anchorX);

            applyPanelChrome(true);
            if (bar != null) bar.setVisibility(View.VISIBLE);
            if (stylePage != null) stylePage.setVisibility(View.GONE);
            syncSwatches();
            syncPlayGlyph();

            /*
             * 窗口原点保持不变（不写 lp.x/lp.y）。
             * 只调一次 updateWindow 是为了让新出现的按钮行触发一次
             * measure/layout —— 这块悬浮窗在某些 ROM 上普通 invalidate
             * 不兑现成帧（见 forceRedraw 的注释），必须过一遍 WMS。
             */
            updateWindow();

            bumpPanelTimeout();
            LogBridge.add(ctx, "LYRIC", "panel open lyric=" + anchorX + "," + anchorY
                    + " window=" + lp.x + "," + lp.y
                    + " pad=" + padL + "," + padT + " (constant)");
        } catch (Throwable e) {
            panelOpen = false;
            CrashLog.recordAsync(ctx, "lyric-panel-open", e);
        }
    }

    /**
     * 收起面板。
     *
     * ⚠️ 顺序是这次真机 bug 的关键：**先让内容消失，再（可选地）动窗口**。
     *
     * 1.3.8 第一版是「先 applyPanelChrome(false) 把 padding 归零，
     * 然后才 lp.x = 歌词x」—— 中间那一帧 padding 已经是 0 而窗口还在旧位置，
     * 内容被画到窗口左上角，用户看到的就是「从左上角弹出来」。
     * 用户原话：「点击关闭状态栏歌词下方背景时（或者点击锁定按钮）
     * 歌词会有一个从左上角弹出来的效果 多余了」。
     *
     * 现在 padding 是常量，窗口本来就没动过，所以连 lp.x/lp.y 都不用写：
     * 画面上的变化只有「背景变透明 + 按钮行/✕ 消失」，
     * 那一帧用户看到的就已经是纯歌词了，不存在任何位移。
     */
    private void closePanel() {
        if (!panelOpen) return;
        try {
            flushStyle();               // 最后 120ms 的改动不能丢
            cancelPanelTimeout();

            /*
             * 先藏内容，再改状态位。
             * 顺序反过来的话，applyPanelChrome 读到的 panelOpen 已经是 false，
             * 万一里面还有依赖 panelOpen 的分支就会错 —— 现在没有，但别踩。
             */
            applyPanelChrome(false);
            if (bar != null) bar.setVisibility(View.GONE);
            if (stylePage != null) stylePage.setVisibility(View.GONE);

            panelOpen = false;
            showingStylePage = false;

            /* 窗口原点不变；只推一次让 WMS 重新走一遍排版（内容变矮了） */
            updateWindow();
            LogBridge.add(ctx, "LYRIC", "panel close (window untouched) x="
                    + lp.x + " y=" + lp.y);
        } catch (Throwable e) {
            CrashLog.recordAsync(ctx, "lyric-panel-close", e);
        }
    }

    /**
     * 落实「面板外观」：圆角背景 + ✕ 的可见性与位置。
     *
     * ⚠️ 这里**不碰 padding**（常量，建 root 时设一次就定了）。
     * 1.3.8 第一版在这里 setPadding(open ? padL : 0, ...)，
     * 于是每次开关面板都要重排一遍布局 —— 那正是跳变的来源。
     *
     * ✕ 为什么用 translation 而不是负 margin：
     *   FrameLayout 会把子 View 摆在 padding **以内**，而 ✕ 要待在上方
     *   28dp 那条留白里。负 margin 在不同 ROM 的 layout 实现里行为不一致，
     *   而 translationY/X 只影响绘制与命中测试（组件分发触摸时会换算），
     *   布局本身不变 —— 稳定且不影响其他子 View。
     */
    private void applyPanelChrome(boolean open) {
        if (root == null) return;
        try {
            /* padding 恒定，这里一个字都不改 */
            if (open) {
                GradientDrawable bg = new GradientDrawable();
                bg.setShape(GradientDrawable.RECTANGLE);
                bg.setCornerRadius(dp(CARD_RADIUS_DP));
                bg.setColor(CARD_BG_COLOR);
                root.setBackground(bg);
            } else {
                root.setBackground(null);
            }
            if (closeBtn != null) {
                closeBtn.setVisibility(open ? View.VISIBLE : View.GONE);
                /* ✕ 浮在 padding 留出的上方空白里，靠 translation 挪出去 */
                closeBtn.setTranslationY(open ? (-padT + dp(4)) : 0f);
                closeBtn.setTranslationX(open ? (padR - dp(4)) : 0f);
            }
        } catch (Throwable e) {
            CrashLog.recordAsync(ctx, "lyric-chrome", e);
        }
    }

    /*
     * ===== 这里曾经有一个 reanchorPanel()，已删除 —— 不要加回来 =====
     *
     * 它干的事是：布局完成后用 view.getLocationInWindow() 量出「歌词相对窗口的
     * 实际偏移」，再反推窗口原点，并在卡片比屏幕宽时把溢出量「补进左 padding」。
     *
     * 真机（vivo V2425A，411×914dp @3.06）实测的两个死结：
     *   ① padding 变成可变状态后，「补左 padding」是**累加**的，而它是一个
     *      被 OnLayoutChangeListener / openPanel / setStylePage 反复调用的函数 ——
     *      同一次溢出被加两遍，改一次字号 padL 就涨一截且永不回落：
     *        16:52:06 padL += 149px (overflow 149)   ← 连续两条，同一个溢出
     *        16:52:07 pad=334,85                      ← 36 + 149 + 149
     *        16:52:23 pad=410,85                      ← 继续涨
     *        16:52:09 window=-652,503                 ← 窗口被推出屏幕 652px
     *   ② 它让「窗口几何」变成了一个会随内容变化的量，于是开关面板必然有
     *      「几何在动」的那一帧 —— 用户看到的就是「从左上角弹出来」。
     *
     * 现在的前提变了，它已经没有必要存在：
     *   · padding 是常量（12/28/12/10 dp）；
     *   · body 左对齐（gravity=START）→ 歌词相对窗口的偏移恒为 (padL, padT)；
     *   · 按钮行宽度自适应（relayoutBar，四档）→ 不需要靠挪窗口腾地方。
     * 三条合起来，offset 是常量，纯减法就够，不需要任何布局后实测。
     */

    /** 内容尺寸变了（字号 / 换页 / 换句）后，重新挑一档按钮行布局。
     *  注意：只调按钮行，**不碰窗口**。 */
    private void clampIntoPanel() {
        try {
            if (!panelOpen || lp == null) return;
            relayoutBar(lyricXFromWindow(lp.x));
        } catch (Throwable e) {
            CrashLog.recordAsync(ctx, "lyric-clamp-panel", e);
        }
    }

    /** 任何操作都续期 8 秒自动收起 */
    private void bumpPanelTimeout() {
        if (!panelOpen) return;
        main.removeCallbacks(panelTimeout);
        main.postDelayed(panelTimeout, PANEL_TIMEOUT_MS);
    }

    private void cancelPanelTimeout() {
        main.removeCallbacks(panelTimeout);
    }

    /**
     * 统一的「窗口属性变了，通知 WindowManager」。
     *
     * 以前这段在 4 个地方各写一遍 wm.updateViewLayout(xxx, lp)，1.3.8 把
     * 窗口视图从 view 换成 root 之后，任何一处漏改就会「歌词动了、面板没动」
     * 或者反过来 —— 这类 bug 极难从现象倒推。所以收成一个函数，只在这里
     * 碰 view 的具体类型。
     */
    private void updateWindow() {
        if (root == null || lp == null || wm == null || !added) return;
        try {
            wm.updateViewLayout(root, lp);
        } catch (Throwable e) {
            CrashLog.recordAsync(ctx, "lyric-window", e);
        }
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
            /*
             * ⚠️ alpha 只给歌词（view），不给 root。
             * root 是窗口视图，如果它半透明，面板卡片也会跟着变淡 ——
             * 用户把歌词透明度调到 30% 时，面板会淡到看不见。
             * 所以透明度作用域仍然是「歌词本身」，与 1.3.8 之前一致。
             */
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
            needResetBase = false;
            dTimingRecv++;
            applyProgressFill();
            scheduleTick();
            reportTiming();
            /* 播放/暂停图标跟着真实状态走（面板开着时才需要重画） */
            syncPlayGlyph();
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
         *     「参数没变只 invalidate」的轻路径，不重建渐变。
         *
         * ⚠️ 别把「省电靠谁」想错了（审查报告 L-18）：
         *   **暂停播放时并不会调 stopTick()** —— 暂停是在上面那个
         *   `if (!timingPlaying) { ...; return false; }` 分支里，
         *   靠「本帧不再排下一帧」间接把驱动停掉的。
         *   stopTick() 的调用点只有三处：hide()（浮层隐藏）、
         *   configure() 里关闭填充、setAppBackground()（切驱动前先停旧的）。
         *   所以暂停期间的「省电」完全依赖上面那个 return false 分支，
         *   而恢复播放依赖前端推 setTiming —— 这正是 M-14 那条的成因
         *   （推送被前端去重挡掉时驱动就再也拉不起来了）。
         *
         * 冻结基准（baseProgress=1, baseAt=now）保留：
         * 这样 p 恒为 1 不会继续增长，算出来的值稳定，
         * 新基准点一到就能立刻从新值重新开始。
         */
        if (p >= 1f) {
            baseProgress = 1f;
            baseAt = now;
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

    /**
     * 排下一帧。
     *
     * M-14：这里曾经还有一条 `lineDurSec <= 0.01f` 的门禁 ——
     * 「句长未知就别排帧」。它和 pushFrame 里那条同名判断叠加之后，
     * 制造了一条**永久停摆**的路径：
     *   ① 暂停 → pushFrame 的暂停分支 return false，驱动链断掉；
     *   ② 恢复播放时前端推 setTiming，但纯音乐段 / 歌词未加载时
     *      前端自己会把推送挡掉（lineDur=0 那条门禁在 app.js 里），
     *      于是 setTiming 根本没被调用；
     *   ③ 就算调到了，lineDurSec 仍是 0 → 这里直接 return，驱动拉不起来；
     *   ④ 结果浮层填充永久停住，直到下一次换句（setText → scheduleTick）才复活。
     *
     * 现在只保留「开没开填充」和「是否已排过」两个判据：
     * 句长未知时也要让驱动转起来，靠 pushFrame 里那条
     * `if (lineDurSec <= 0.01f) return true;` 空转到新基准点到来 ——
     * 那种情况本来就该空转（省电交给暂停分支的 return false，不在这里挡）。
     */
    private void scheduleTick() {
        if (!fillProgress) return;
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
     * App 前后台状态变化（历史遗留的回调，现在只剩「重排一次驱动」的作用）。
     *
     * ⚠️ 这里曾经是个关键修复，但**描述的机制已经不存在了**，别再照着它推演：
     *   早期为了绕开「悬浮窗 invalidate 被吞」，驱动一度从 Handler 换成了
     *   Choreographer。Choreographer 依赖 vsync，而进程切到后台后系统
     *   不再分发 vsync，于是外推彻底停摆（症状是「只有换句那一下才填充」）。
     *   于是加了这条回调：后台退回 Handler、前台切回 Choreographer。
     *
     * 后来 Choreographer 分支被整段删除（见类里「Choreographer 相关字段
     * 已全部删除」那句，以及 ticker 的注释），现在**前后台都用
     * Handler.postDelayed**。所以切驱动已经没意义了，这个回调现在只做两件事：
     *   · 记录前后台状态（日志与诊断用）；
     *   · stopTick() + scheduleTick() 重排一次帧 —— 顺带能把「暂停期间
     *     pushFrame return false 断掉」的驱动链重新拉起来。
     *
     * 保留它而不是删掉：它是 App 生命周期里唯一会主动「重排帧」的钩子，
     * 在 M-14 那条「恢复播放推送被去重导致永久停摆」的场景里是兜底之一。
     *
     * @param bg true = App 已切到后台
     */
    public void setAppBackground(final boolean bg) {
        main.post(() -> {
            if (appInBackground == bg) return;
            appInBackground = bg;
            LogBridge.add(ctx, "LYRIC", "app background=" + bg + ", driver=handler");
            /* 先停旧的再排新的：保证同一时刻只有一条 ticker 链在跑 */
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
            /*
             * ⚠️ posX / posY / clampX / clampY 的语义全部是**歌词位置**，
             * 而这里写的是 lp.x / lp.y = **窗口原点**，两者恒差一个常量 padding。
             * 所以下面统一算出「歌词位置」，最后一步用 toWindowX/toWindowY 换算 ——
             * 中间任何一处直接把 lp.x 当歌词位置都会错位。
             * （面板开不开都是同一个换算：padding 是常量，歌词又左对齐。）
             */
            int lyricY;
            if (posY < 0) {
                // 状态栏下沿再往下一点点，落在状态栏和标题栏之间的空隙里
                int statusH = statusBarHeightPx();
                lyricY = statusH > 0 ? statusH - dp(2) : dp(26);
            } else {
                /*
                 * J-10 的另一半：已经存进设置里的越界 y（老版本拖出去的）也要拉回来，
                 * 否则升级后浮层仍然在屏幕外——用户不会想到是「旧的坏坐标」。
                 */
                lyricY = clampY(posY);
            }
            lp.y = toWindowY(lyricY);
            if (posX < 0) {
                centerHorizontally();          // 默认：居中（要等窗口量出宽度）
            } else {
                /*
                 * P-01（1.3.7，真机横屏反馈）：「拖过去的位置」是**逻辑位置**，
                 * 不能每次重开都重新按当前屏幕宽度钳一遍。
                 *
                 * 原来的写法直接 clampX(posX) —— 而 clampX 的上限是
                 * 「当前屏宽 - 当前窗宽」，窗宽随歌词长短变化、屏宽随横竖屏
                 * 变化。于是同一份设置值在不同时刻会得到不同结果：
                 *   横屏拖到右侧 → 保存 x（很大）→ 竖屏重开时
                 *   上限骤减 → 被钳回屏幕内某处 → 看起来「位置自己跑了」。
                 * 这里只做「完全出屏才拉回」的兜底，正常值原样还原。
                 */
                final int lyricX = restoreX(posX);
                lp.x = toWindowX(lyricX);
                /* 面板开着时按钮行档位按新位置重挑一次（不挪窗口） */
                if (panelOpen) relayoutBar(lyricX);
            }
            LogBridge.add(ctx, "LYRIC", "position x=" + lp.x + " y=" + lp.y
                    + " (saved " + posX + "," + posY + ", pad=" + padL + "," + padT + ")");
        } catch (Throwable e) {
            CrashLog.recordAsync(ctx, "lyric-pos", e);
            /* 兜底也只管歌词的 y，窗口原点仍要换算 */
            if (lp != null) lp.y = toWindowY(dp(26));
        }
    }

    /**
     * 浮层所在屏幕的宽度（px）。
     *
     * 为什么不用 ctx.getResources().getDisplayMetrics().widthPixels：
     *   这个 ctx 是 **application context**（见构造函数的 getApplicationContext），
     *   它的 DisplayMetrics 描述的是「设备屏幕」，而不是本窗口所在的那块区域。
     *   真机横屏 + 小窗（vivo/OriginOS 的应用小窗）下两者的 widthPixels
     *   并不相等 —— 小窗里 Application 拿到的仍是竖屏整屏宽度，
     *   而 WindowManager 布局用的是小窗可用宽度。
     *   结果：默认位置算出来的 x 是「按整屏居中」的，放进小窗里自然偏到一边。
     *
     * 取法：从 WindowManager 的 currentWindowMetrics 拿本窗口的 bounds；
     *   API < 30 时退回 DisplayMetrics（此时小窗能力也基本不存在）。
     * 任何一步失败都不抛，退到 DisplayMetrics —— 位置算错好过浮层消失。
     */
    private int screenWidthPx() {
        try {
            if (Build.VERSION.SDK_INT >= 30 && wm != null) {
                android.graphics.Rect b = wm.getCurrentWindowMetrics().getBounds();
                int w = b.width();
                if (w > 0) return w;
            }
        } catch (Throwable ignored) {
            /* 落到下面的 DisplayMetrics */
        }
        try {
            return ctx.getResources().getDisplayMetrics().widthPixels;
        } catch (Throwable e) {
            return 0;
        }
    }

    /** 同 {@link #screenWidthPx()}，纵向 */
    private int screenHeightPx() {
        try {
            if (Build.VERSION.SDK_INT >= 30 && wm != null) {
                android.graphics.Rect b = wm.getCurrentWindowMetrics().getBounds();
                int h = b.height();
                if (h > 0) return h;
            }
        } catch (Throwable ignored) {
        }
        try {
            return ctx.getResources().getDisplayMetrics().heightPixels;
        } catch (Throwable e) {
            return 0;
        }
    }

    /** 状态栏高度（px）；取不到返回 0，由调用方决定兜底 */
    private int statusBarHeightPx() {
        try {
            int id = ctx.getResources().getIdentifier("status_bar_height", "dimen", "android");
            if (id > 0) return ctx.getResources().getDimensionPixelSize(id);
        } catch (Throwable ignored) {
        }
        return 0;
    }

    /**
     * 还原用户拖过的 x（P-01）。
     *
     * 与 clampX 的区别：clampX 是「拖动过程中实时约束」，用当前窗宽/屏宽
     * 保证拖不出屏幕，语义正确；而这里是「重开浮层时还原一份已保存的位置」，
     * 如果也按当前尺寸重算上限，就会把合法位置越算越小 ——
     * 横屏保存的大 x 在竖屏下被压扁，用户看到的就是「位置自己变回中间」。
     *
     * 所以这里只做**完全出屏**的兜底：只有当整块窗口都落在屏幕外
     * （旧版本写坏的坐标）时才拉回来，正常值一律原样用。
     */
    private int restoreX(int x) {
        int sw = screenWidthPx();
        if (sw <= 0) return Math.max(0, x);
        /*
         * 判据用窗口左边缘，不用窗口宽度：
         *   左边缘已经在屏幕右边界之外 = 整块窗口都在屏幕外，肯定是坏数据；
         *   左边缘还在屏幕内 = 合法位置，原样还原（哪怕窗口右半截被裁掉）。
         * 绝不能按「sw - viewWidth」去卡上限 —— 那正是用户抱怨的
         * 「位置自己变回中间」的成因：窗宽随歌词长短变，一换句上限就变。
         */
        if (x >= sw) return 0;
        return Math.max(0, x);
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
                int sw = screenWidthPx();
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
                if (sw <= 0) return;
                /*
                 * 居中算的是**歌词**（vw 是 view.getWidth()），写进 lp 的却是
                 * 窗口原点 —— 恒差一个常量左 padding，与面板开没开无关。
                 */
                final int lyricCenterX = Math.max(0, (sw - vw) / 2);
                lp.x = toWindowX(lyricCenterX);
                updateWindow();
                /* 面板开着：位置变了要重挑按钮行档位（不挪窗口） */
                if (panelOpen) relayoutBar(lyricCenterX);
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
            int sw = screenWidthPx();
            if (sw <= 0) return Math.max(0, x);
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
            int sh = screenHeightPx();
            if (sh <= 0) return Math.max(0, y);
            int vh = view != null ? view.getHeight() : 0;
            int max = vh > 0 ? Math.max(0, sh - vh) : Integer.MAX_VALUE;
            return Math.max(0, Math.min(y, max));
        } catch (Throwable e) {
            return Math.max(0, y);
        }
    }

    /*
     * 窗口 flags 的公共部分（与 locked 无关的三件套）。
     *
     * 抽出来的理由（H-14 的根因就是这个算法存在**两份**）：
     *   show() 建立 lp 时要写一次，updateLayoutFlags() 改锁定时又要写一次，
     *   以前两处各抄一遍，show() 那份漏掉了「按 locked 选择触摸位」，
     *   于是运行中解锁永远不生效。现在两边都调这个函数，不可能再漂。
     */
    private static int baseWindowFlags() {
        return WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
                | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN;
    }

    /** 按 locked 算出完整的 flags：锁定 → 不拦触摸；未锁定 → 拦触摸以便拖动和点击 */
    private static int flagsFor(boolean locked) {
        return locked
                ? (baseWindowFlags() | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE)
                : (baseWindowFlags() | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL);
    }

    /**
     * 把当前锁定状态落实到窗口上。
     *
     * 允许在「还没 addView」时调用：那种情况下只更新 lp（show() 会直接用它），
     * 不去碰 WindowManager。以前这里一上来就 `if (view == null || wm == null) return;`，
     * 于是 configure() 在 show() 之前调它纯属空转 —— 这是 H-14 里
     * 「configure 先 show 后」链路上的第二个断点。
     */
    private void updateLayoutFlags() {
        if (lp == null) return;
        try {
            lp.flags = flagsFor(locked);
            if (view != null) {
                /* 解锁态稍亮一点：让用户看得出「现在是可拖动的」 */
                view.setAlpha(locked ? alpha : Math.min(1f, alpha + 0.06f));
            }
            if (added && root != null && wm != null) {
                updateWindow();
                LogBridge.add(ctx, "LYRIC", "flags updated locked=" + locked);
            }
        } catch (Throwable e) {
            CrashLog.recordAsync(ctx, "lyric-flags", e);
        }
    }

    /**
     * 歌词本体上的触摸：拖动 + 单击开关面板。
     *
     * ⚠️ 这里全程区分两套坐标，混用会让面板打开后位置一路漂：
     *   · origin = lp.x/lp.y      → **窗口原点**
     *   · clampX / clampY 的入参   → **歌词位置**（它们的语义是「歌词尺寸」的约束）
     *   · onMoved 报给网页的       → **歌词位置**
     * 所以按下时先把窗口原点换算成歌词位置，拖动过程在歌词坐标系里算，
     * 最后再减 padding 写回 lp。
     *
     * 面板打开时也允许拖 —— 用户按需求「拖动也算操作」，会续期自动收起；
     * 拖完面板会跟着窗口一起走（padding 不变，窗口原点整体平移），
     * 歌词与卡片的相对关系保持不变。
     */
    private void bindTouch() {
        final float[] down = new float[2];
        final int[] origin = new int[2];   // 歌词坐标（不是窗口原点）
        final boolean[] moved = new boolean[]{false};
        view.setOnTouchListener((v, ev) -> {
            if (locked || lp == null) return false;
            switch (ev.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    down[0] = ev.getRawX();
                    down[1] = ev.getRawY();
                    /* 拖动基准 = 歌词当前屏幕坐标 = 窗口原点 + 常量 padding */
                    origin[0] = lyricXFromWindow(lp.x);
                    origin[1] = lyricYFromWindow(lp.y);
                    moved[0] = false;
                    /* 面板开着时按住歌词也算「有操作」，续期自动收起 */
                    bumpPanelTimeout();
                    return true;
                case MotionEvent.ACTION_MOVE: {
                    float dx = ev.getRawX() - down[0];
                    float dy = ev.getRawY() - down[1];
                    if (Math.abs(dx) > dp(3) || Math.abs(dy) > dp(3)) moved[0] = true;
                    /* clampX/clampY 的语义一直是「歌词能放在哪」，入参必须是歌词坐标 */
                    int lyricX = clampX(origin[0] + (int) dx);
                    /*
                     * J-10：y 方向补齐上限，与 clampX 对称。
                     * 以前只有 Math.max(0, ...) 的下限 —— 配合 FLAG_LAYOUT_NO_LIMITS
                     * （允许布局越界），用户能把歌词一直拖到屏幕底部之外。
                     * 位置会被持久化（onMoved → 网页存设置），重启后它仍然在屏幕外，
                     * 只能靠「恢复默认位置」救回来，用户当时的感觉就是「歌词不见了」。
                     */
                    int lyricY = clampY(origin[1] + (int) dy);
                    if (moved[0]) bumpPanelTimeout();
                    lp.x = toWindowX(lyricX);
                    lp.y = toWindowY(lyricY);
                    updateWindow();
                    return true;
                }
                case MotionEvent.ACTION_UP:
                case MotionEvent.ACTION_CANCEL: {
                    if (!moved[0]) {
                        /* 单击：开关原生面板（1.3.8，不再回调网页弹底部面板） */
                        togglePanel();
                        Callback c = cb;
                        if (c != null) c.onTap();
                    } else {
                        /* 存的是歌词位置，不是窗口原点 —— 否则面板开合一次就漂一次 */
                        final int lx = lyricXFromWindow(lp.x);
                        final int ly = lyricYFromWindow(lp.y);
                        anchorX = lx;
                        anchorY = ly;
                        posX = lx;
                        posY = ly;
                        Callback c = cb;
                        if (c != null) c.onMoved(lx, ly);
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
