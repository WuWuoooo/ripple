package com.ripple.app;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.view.View;

/**
 * 自绘图标按钮（1.3.8 · 状态栏歌词原生面板）。
 *
 * 为什么不用 emoji / Unicode 符号（⏯ ⚙ ✕ 🔒 之类）：
 *   这套符号没有统一的字形来源，不同 ROM / 字体回退链画出来的粗细、
 *   基线、留白完全不一样 —— 在原生 AOSP 上是小一圈的细线，
 *   在国产 ROM 上可能变成彩色 emoji 或者豆腐块。面板只有一排小按钮，
 *   一旦其中一个显示成豆腐块，整个面板看起来就是坏的。
 *
 * 为什么也不用 res/drawable 的 VectorDrawable：
 *   本项目没有 Gradle，资源走的是手写 aapt2 脚本（见 android/build-apk.sh）。
 *   加一套矢量资源要同时动 res/ 目录和资源编译链，为了 8 个几十像素的图标
 *   不值当；Canvas + Path 直接画，零依赖、零资源，且在 aapt2 各种
 *   压缩/多密度处理下都不会发虚。
 *
 * 坐标全部按「控件短边」归一化（图标半径 r = min(w,h) * 0.34），
 * 所以 32dp 和 40dp 下形状一致，不用为每种尺寸各调一套数值。
 */
public class GlyphButton extends View {

    public static final int LOCK = 1;
    public static final int PREV = 2;
    public static final int PLAY = 3;
    public static final int PAUSE = 4;
    public static final int NEXT = 5;
    public static final int GEAR = 6;
    public static final int CLOSE = 7;
    public static final int CHECK = 8;

    /** 强调色（与网页 --accent 一致），激活态用它 */
    private static final int ACCENT = 0xFFB3A2FF;
    /** 普通态前景色 */
    private static final int NORMAL = 0xFFF2F2F2;
    /** setSwatch 的「关闭色点模式」哨兵值 */
    public static final int NO_SWATCH = Integer.MIN_VALUE;

    private final Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Path path = new Path();
    private final RectF rect = new RectF();

    private int glyph = LOCK;
    private boolean active = false;
    private int swatchColor = NO_SWATCH;
    private final float density;

    public GlyphButton(Context ctx) {
        super(ctx);
        density = ctx.getResources().getDisplayMetrics().density <= 0f
                ? 1f : ctx.getResources().getDisplayMetrics().density;
        /* 自己处理点击，保证 setOnClickListener 一定能收到事件 */
        setClickable(true);
        setFocusable(true);
    }

    /** 换图标（见本类的 LOCK / PREV / ... 常量） */
    public void setGlyph(int g) {
        if (glyph == g) return;
        glyph = g;
        invalidate();
    }

    public int getGlyph() {
        return glyph;
    }

    /** 激活态：用强调色 + 一层淡底，区分「当前生效」的按钮（如已锁定） */
    public void setActive(boolean on) {
        if (active == on) return;
        active = on;
        invalidate();
    }

    public boolean isActive() {
        return active;
    }

    /**
     * 切成「色点」模式：整个按钮画成一个纯色圆点（预设色点用）。
     * 传 {@link #NO_SWATCH} 退出该模式。
     *
     * 为什么色点也放在这个类里：它和图标按钮共享「按压反馈 / 无障碍 / 触摸」
     * 这一整套行为，另开一个类只会多一份重复代码。
     */
    public void setSwatch(int color) {
        if (swatchColor == color) return;
        swatchColor = color;
        invalidate();
    }

    @Override
    protected void drawableStateChanged() {
        super.drawableStateChanged();
        /* 按压态要立刻反映到画面上 */
        invalidate();
    }

    @Override
    protected void onDraw(Canvas c) {
        final int w = getWidth();
        final int h = getHeight();
        if (w <= 0 || h <= 0) return;
        final float size = Math.min(w, h);
        final float cx = w * 0.5f;
        final float cy = h * 0.5f;
        final float r = size * 0.34f;

        /* 按压反馈：一层很淡的圆底。比改 setAlpha 稳 —— alpha 会被父布局的
         * 透明度动画和窗口自身的 alpha 叠加，视觉上会飘。 */
        if (isPressed()) {
            p.setStyle(Paint.Style.FILL);
            p.setColor(0x22FFFFFF);
            c.drawCircle(cx, cy, size * 0.48f, p);
        }

        if (swatchColor != NO_SWATCH) {
            drawSwatch(c, cx, cy, r, size);
            return;
        }

        if (active) {
            p.setStyle(Paint.Style.FILL);
            p.setColor(0x26B3A2FF);
            c.drawCircle(cx, cy, size * 0.48f, p);
        }
        p.setColor(active ? ACCENT : NORMAL);
        p.setStrokeWidth(Math.max(1.6f * density, size * 0.085f));
        p.setStrokeCap(Paint.Cap.ROUND);
        p.setStrokeJoin(Paint.Join.ROUND);
        p.setStyle(Paint.Style.STROKE);

        switch (glyph) {
            case LOCK:
                /* 锁体（圆角矩形）+ 上面的锁梁（半圆环） */
                rect.set(cx - r * 0.80f, cy - r * 0.10f, cx + r * 0.80f, cy + r * 1.02f);
                c.drawRoundRect(rect, r * 0.26f, r * 0.26f, p);
                rect.set(cx - r * 0.46f, cy - r * 0.96f, cx + r * 0.46f, cy + r * 0.22f);
                c.drawArc(rect, 180f, 180f, false, p);
                break;
            case PREV:
                p.setStyle(Paint.Style.FILL);
                c.drawRect(cx - r * 0.78f, cy - r * 0.82f, cx - r * 0.58f, cy + r * 0.82f, p);
                path.reset();
                path.moveTo(cx + r * 0.62f, cy - r * 0.84f);
                path.lineTo(cx + r * 0.62f, cy + r * 0.84f);
                path.lineTo(cx - r * 0.44f, cy);
                path.close();
                c.drawPath(path, p);
                break;
            case PLAY:
                p.setStyle(Paint.Style.FILL);
                path.reset();
                path.moveTo(cx - r * 0.54f, cy - r * 0.84f);
                path.lineTo(cx - r * 0.54f, cy + r * 0.84f);
                path.lineTo(cx + r * 0.80f, cy);
                path.close();
                c.drawPath(path, p);
                break;
            case PAUSE:
                p.setStyle(Paint.Style.FILL);
                rect.set(cx - r * 0.52f, cy - r * 0.84f, cx - r * 0.16f, cy + r * 0.84f);
                c.drawRoundRect(rect, r * 0.12f, r * 0.12f, p);
                rect.set(cx + r * 0.16f, cy - r * 0.84f, cx + r * 0.52f, cy + r * 0.84f);
                c.drawRoundRect(rect, r * 0.12f, r * 0.12f, p);
                break;
            case NEXT:
                p.setStyle(Paint.Style.FILL);
                path.reset();
                path.moveTo(cx - r * 0.62f, cy - r * 0.84f);
                path.lineTo(cx - r * 0.62f, cy + r * 0.84f);
                path.lineTo(cx + r * 0.44f, cy);
                path.close();
                c.drawPath(path, p);
                c.drawRect(cx + r * 0.58f, cy - r * 0.82f, cx + r * 0.78f, cy + r * 0.82f, p);
                break;
            case GEAR:
                /* 简化齿轮：一个圆环 + 一圈小齿（小圆点）。比画 8 个梯形齿
                 * 简单得多，但在 24dp 下辨识度反而更高（梯形齿会糊成一团）。 */
                c.drawCircle(cx, cy, r * 0.50f, p);
                p.setStyle(Paint.Style.FILL);
                for (int i = 0; i < 8; i++) {
                    double a = Math.PI * 2.0 * i / 8.0 - Math.PI / 2.0;
                    float tx = cx + (float) Math.cos(a) * r * 0.86f;
                    float ty = cy + (float) Math.sin(a) * r * 0.86f;
                    c.drawCircle(tx, ty, Math.max(1.3f * density, size * 0.060f), p);
                }
                break;
            case CLOSE:
                c.drawLine(cx - r * 0.60f, cy - r * 0.60f, cx + r * 0.60f, cy + r * 0.60f, p);
                c.drawLine(cx + r * 0.60f, cy - r * 0.60f, cx - r * 0.60f, cy + r * 0.60f, p);
                break;
            case CHECK:
                drawCheck(c, cx, cy, r, active ? ACCENT : NORMAL);
                break;
            default:
                break;
        }
    }

    /** 打勾：选中色点、以及 CHECK 图标共用同一段路径 */
    private void drawCheck(Canvas c, float cx, float cy, float r, int color) {
        p.setStyle(Paint.Style.STROKE);
        p.setColor(color);
        p.setStrokeCap(Paint.Cap.ROUND);
        p.setStrokeJoin(Paint.Join.ROUND);
        path.reset();
        path.moveTo(cx - r * 0.56f, cy + r * 0.04f);
        path.lineTo(cx - r * 0.14f, cy + r * 0.48f);
        path.lineTo(cx + r * 0.58f, cy - r * 0.46f);
        c.drawPath(path, p);
    }

    /** 色点：纯色圆 + 细描边（保证纯白/纯黑在深色卡片上也有边界） */
    private void drawSwatch(Canvas c, float cx, float cy, float r, float size) {
        p.setStyle(Paint.Style.FILL);
        p.setColor(swatchColor);
        c.drawCircle(cx, cy, r * 0.86f, p);

        p.setStyle(Paint.Style.STROKE);
        p.setStrokeWidth(Math.max(1f * density, size * 0.045f));
        p.setColor(0x40FFFFFF);
        c.drawCircle(cx, cy, r * 0.86f, p);

        if (!active) return;
        /* 选中：外圈强调色环 + 内部打勾（按底色明暗决定勾的颜色，保证可见） */
        p.setColor(ACCENT);
        p.setStrokeWidth(Math.max(1.6f * density, size * 0.075f));
        c.drawCircle(cx, cy, r * 1.04f, p);

        float lum = 0.299f * Color.red(swatchColor)
                + 0.587f * Color.green(swatchColor)
                + 0.114f * Color.blue(swatchColor);
        p.setStrokeWidth(Math.max(1.6f * density, size * 0.075f));
        drawCheck(c, cx, cy, r * 0.86f, lum > 150f ? 0xFF1A1A1E : 0xFFF2F2F2);
    }
}
