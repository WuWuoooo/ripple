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

    private TextView view;
    private WindowManager.LayoutParams lp;
    private volatile boolean added = false;

    private volatile boolean locked = true;
    private volatile String text = "";
    private volatile int color = Color.WHITE;
    private volatile float sizeSp = 12f;
    private volatile float alpha = 0.92f;
    private volatile int posX = -1;
    private volatile int posY = -1;
    private volatile boolean bold = true;
    private volatile boolean shadow = true;
    /* 跟随播放进度填充：0=关闭；开启后按进度把文字从左到右染成高亮色 */
    private volatile boolean fillProgress = false;
    private volatile int fillColor = 0xFF7DE3D0;
    private volatile float progress = 0f;      // 0..1

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
            text = v;
            if (view == null) return;
            if (v.isEmpty()) {
                view.setVisibility(View.GONE);
                return;
            }
            view.setVisibility(View.VISIBLE);
            if (!v.contentEquals(view.getText())) view.setText(v);
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
                view = new TextView(ctx);
                view.setSingleLine(true);
                view.setEllipsize(TextUtils.TruncateAt.MARQUEE);
                view.setMarqueeRepeatLimit(-1);
                view.setHorizontallyScrolling(true);
                view.setIncludeFontPadding(false);
                view.setPadding(dp(2), dp(1), dp(2), dp(1));
                /*
                 * 文字在窗口内居中。
                 * 以前这里没有设 gravity，配合 MATCH_PARENT 宽度的窗口，
                 * 文字永远从屏幕最左边开始 —— 用户拖动时看到的「锚点」是左边缘，
                 * 拖到屏幕中间文字就整体偏左。现在窗口改成包住文字（WRAP_CONTENT），
                 * 窗口走到哪文字就在哪，视觉锚点就是文字本身。
                 */
                view.setGravity(Gravity.CENTER);
                /* 长歌词别把窗口撑出屏幕：给一个上限，超了走跑马灯 */
                final int screenW = ctx.getResources().getDisplayMetrics().widthPixels;
                view.setMaxWidth(Math.max(dp(120), screenW - dp(24)));

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
                final String cur = text;
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
        });
    }

    /* ================= 内部 ================= */

    private void applyStyle() {
        if (view == null) return;
        try {
            view.setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp);
            if (fillProgress) {
                applyProgressFill();
            } else {
                try { view.getPaint().setShader(null); } catch (Throwable ignored) {}
                view.setTextColor(color);
            }
            view.setAlpha(alpha);
            view.setTypeface(Typeface.DEFAULT, bold ? Typeface.BOLD : Typeface.NORMAL);
            if (shadow) {
                view.setShadowLayer(Math.max(2f, sizeSp * 0.28f), 0f, 0f, 0xCC000000);
            } else {
                view.setShadowLayer(0f, 0f, 0f, Color.TRANSPARENT);
            }
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
    private void applyProgressFill() {
        /*
         * J-08：把 view 抓成局部 final 再进闭包。
         * 外层这个 null 判断只管「提交任务的那一刻」；任务真正跑起来之前，
         * hide()（同样在主线程队列里）可能已经把字段 view 置空 ——
         * 内层再去读 this.view.getMeasuredWidth() 就是 NPE。
         * 虽然外层还有 try-catch(Throwable) 兜着不会崩，但会在崩溃记录里
         * 留下一条 lyric-fill 假崩溃，污染真正的排查线索。
         */
        final TextView v = view;
        if (v == null) return;
        try {
            v.post(() -> {
                try {
                    /* 任务执行时再复查一次：view 可能在这期间被 hide() 摘掉 */
                    if (v.getParent() == null) return;
                    int w = Math.max(1, v.getMeasuredWidth());
                    if (w <= 1) {
                        // 还没量到宽度，先给个纯色，下次进度来会补上
                        v.setTextColor(color);
                        return;
                    }
                    float p = Math.max(0f, Math.min(1f, progress));
                    float edge = w * p;
                    // 硬边：edge 前是高亮色，之后是基础色；两端各留 1px 过渡让边缘不那么生硬
                    float soft = Math.max(1f, w * 0.012f);
                    int[] colors = new int[]{fillColor, fillColor, color, color};
                    float[] pos = new float[]{
                        Math.max(0f, Math.min(1f, (edge - soft) / w)),
                        Math.max(0f, Math.min(1f, edge / w)),
                        Math.max(0f, Math.min(1f, (edge + soft) / w)),
                        1f
                    };
                    // 处理进度为 0 / 1 时的退化情况，保证 pos 单调递增
                    for (int i = 1; i < pos.length; i++) {
                        if (pos[i] < pos[i - 1]) pos[i] = pos[i - 1];
                    }
                    android.graphics.LinearGradient g = new android.graphics.LinearGradient(
                            0, 0, w, 0, colors, pos, android.graphics.Shader.TileMode.CLAMP);
                    v.getPaint().setShader(g);
                    v.invalidate();
                } catch (Throwable e) {
                    CrashLog.recordAsync(ctx, "lyric-fill", e);
                }
            });
        } catch (Throwable e) {
            CrashLog.recordAsync(ctx, "lyric-fill-outer", e);
        }
    }

    /** 网页每秒推一次进度（0..1）；只有开启填充时才真正重绘 */
    public void setProgress(final String p) {
        if (!fillProgress) return;
        float v;
        try {
            v = Float.parseFloat(String.valueOf(p).trim());
        } catch (Throwable e) {
            return;
        }
        if (Float.isNaN(v) || Float.isInfinite(v)) return;
        v = Math.max(0f, Math.min(1f, v));
        // R-11：「读 progress → 比较 → 写 progress」整体进主线程
        final float nv = v;
        main.post(() -> {
            if (Math.abs(nv - progress) < 0.004f) return;   // 0.4% 以内不重绘
            progress = nv;
            applyProgressFill();
        });
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
                if (vw <= 0 && v instanceof TextView) {
                    vw = Math.min(sw, (int) ((TextView) v).getPaint().measureText(
                            text == null ? "" : text) + dp(6));
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
