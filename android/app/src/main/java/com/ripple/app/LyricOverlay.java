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
    private Callback cb;

    private TextView view;
    private WindowManager.LayoutParams lp;
    private boolean added = false;

    private boolean locked = true;
    private String text = "";
    private int color = Color.WHITE;
    private float sizeSp = 12f;
    private float alpha = 0.92f;
    private int posX = -1;
    private int posY = -1;
    private boolean bold = true;
    private boolean shadow = true;
    /* 跟随播放进度填充：0=关闭；开启后按进度把文字从左到右染成高亮色 */
    private boolean fillProgress = false;
    private int fillColor = 0xFF7DE3D0;
    private float progress = 0f;      // 0..1

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

    public void configure(boolean locked, String colorHex, String sizeSp, String alphaStr,
                          String x, String y, boolean bold, boolean shadowOn,
                          boolean fill, String fillHex) {
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
        if (fillHex != null && !fillHex.isEmpty()) this.fillColor = parseColor(fillHex, this.fillColor);
        /*
         * -1 表示「恢复默认位置」。
         * 之前写的是 if (ny > -9999) posY = ny，而 -1 恰好大于 -9999，
         * 于是默认值永远覆盖不上去 —— 点「恢复默认位置」看起来毫无反应。
         * 现在：< 0 就当作「用默认」，并立刻把窗口重新摆一次。
         */
        this.posX = nx < 0 ? -1 : nx;
        this.posY = ny < 0 ? -1 : ny;
        final boolean reposition = (this.posX < 0 || this.posY < 0) || nx >= 0 || ny >= 0;
        main.post(() -> {
            applyStyle();
            if (!added) return;
            if (reposition) {
                applyPosition();
                try { wm.updateViewLayout(view, lp); } catch (Throwable e) {
                    CrashLog.record(ctx, "lyric-move", e);
                }
            }
            updateLayoutFlags();
        });
    }

    public void setText(final String t) {
        final String v = t == null ? "" : t.trim();
        if (v.equals(text)) return;
        text = v;
        main.post(() -> {
            if (view == null) return;
            if (v.isEmpty()) {
                view.setVisibility(View.GONE);
            } else {
                view.setVisibility(View.VISIBLE);
                view.setText(v);
            }
        });
    }

    public void setLocked(boolean v) {
        if (locked == v) return;
        locked = v;
        main.post(() -> {
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
                view = new TextView(ctx);
                view.setSingleLine(true);
                view.setEllipsize(TextUtils.TruncateAt.MARQUEE);
                view.setMarqueeRepeatLimit(-1);
                view.setHorizontallyScrolling(true);
                view.setIncludeFontPadding(false);
                view.setPadding(dp(2), dp(1), dp(2), dp(1));

                lp = new WindowManager.LayoutParams();
                lp.type = Build.VERSION.SDK_INT >= 26
                        ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                        : WindowManager.LayoutParams.TYPE_PHONE;
                lp.format = PixelFormat.TRANSLUCENT;
                lp.gravity = Gravity.TOP | Gravity.START;
                lp.width = WindowManager.LayoutParams.MATCH_PARENT;
                lp.height = WindowManager.LayoutParams.WRAP_CONTENT;
                // 默认不拦触摸：锁定态就是纯展示，绝不影响用户操作别的 App
                lp.flags = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                        | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
                        | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN;
                applyStyle();
                placeDefault();
                bindTouch();

                wm.addView(view, lp);
                added = true;
                LogBridge.add(ctx, "LYRIC", "overlay shown locked=" + locked);
            } catch (Throwable e) {
                CrashLog.record(ctx, "lyric-show", e);
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
            CrashLog.record(ctx, "lyric-style", e);
        }
    }

    /**
     * 按播放进度给文字上「填充色」：
     * 用 LinearGradient 做一条硬边渐变 —— 0..progress 用高亮色，
     * 之后用基础色，然后把它铺到整行宽度上。
     * 这比「画两层文字裁切」轻得多，每帧只改 shader 的位置。
     */
    private void applyProgressFill() {
        if (view == null) return;
        try {
            view.post(() -> {
                try {
                    int w = Math.max(1, view.getMeasuredWidth());
                    if (w <= 1) {
                        // 还没量到宽度，先给个纯色，下次进度来会补上
                        view.setTextColor(color);
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
                    view.getPaint().setShader(g);
                    view.invalidate();
                } catch (Throwable e) {
                    CrashLog.record(ctx, "lyric-fill", e);
                }
            });
        } catch (Throwable e) {
            CrashLog.record(ctx, "lyric-fill-outer", e);
        }
    }

    /** 网页每秒推一次进度（0..1）；只有开启填充时才真正重绘 */
    public void setProgress(final String p) {
        if (!fillProgress) return;
        float v;
        try { v = Float.parseFloat(String.valueOf(p).trim()); } catch (Throwable e) { return; }
        v = Math.max(0f, Math.min(1f, v));
        if (Math.abs(v - progress) < 0.004f) return;   // 0.4% 以内不重绘
        progress = v;
        main.post(this::applyProgressFill);
    }

    /** 默认位置：屏幕顶部，避开刘海/状态栏图标那一行 */
    private void placeDefault() {
        applyPosition();
    }

    /** 按 posX/posY 摆放；负值表示回到默认位置 */
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
                lp.y = posY;
            }
            lp.x = Math.max(0, posX);
            LogBridge.add(ctx, "LYRIC", "position x=" + lp.x + " y=" + lp.y
                    + " (saved " + posX + "," + posY + ")");
        } catch (Throwable e) {
            CrashLog.record(ctx, "lyric-pos", e);
            if (lp != null) lp.y = dp(26);
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
            CrashLog.record(ctx, "lyric-flags", e);
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
                    lp.x = origin[0] + (int) dx;
                    lp.y = Math.max(0, origin[1] + (int) dy);
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
