package com.ripple.app;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.Shader;
import android.view.MotionEvent;
import android.view.View;

/**
 * 色相条（1.3.8 · 状态栏歌词原生面板的自定义取色）。
 *
 * 为什么自己画一条 HSV 渐变，而不是塞一个系统 ColorPicker：
 *   Android 没有公开的取色控件（只有 API 26+ 的旧 ColorPickerDialog 已废弃），
 *   引第三方库又违反「不引入任何第三方依赖」的约束。
 *   而状态栏面板只需要「选个色相」这一件事 —— S=1 V=1 的纯色相环已经
 *   覆盖了用户实际会挑的那一圈颜色（网页端预设色点之外的自由色）。
 *
 * 为什么是色相条而不是色相环：面板是一条窄横条，色相条天然适配；
 * 环需要至少 120dp 的方块，会把面板撑高，挡住正上方的歌词。
 *
 * 取色语义：x 映射到色相 0..360，S=1、V=1，回调给调用方一个不透明 int 颜色。
 * ights 变化（换主题/改亮度）不影响，因为渐变是每次 onSizeChanged 重建的。
 */
public class HueBar extends View {

    /** 拖动回调：颜色（不含 alpha，永远不透明） */
    public interface OnColorChange {
        void onChange(int color);
    }

    private final Paint barPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint dotPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint ringPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final RectF barRect = new RectF();

    private final float density;
    private OnColorChange listener;
    /** 当前色相 0..360 */
    private float hue = 0f;
    /** 色相条的高度（dp）：8dp，具体像素在 onSizeChanged 里按短边算 */
    private final float barHeightDp;
    private Shader shader;

    public HueBar(Context ctx) {
        this(ctx, 8f);
    }

    public HueBar(Context ctx, float barHeightDp) {
        super(ctx);
        this.barHeightDp = barHeightDp;
        density = ctx.getResources().getDisplayMetrics().density <= 0f
                ? 1f : ctx.getResources().getDisplayMetrics().density;
        barPaint.setStyle(Paint.Style.FILL);
        dotPaint.setStyle(Paint.Style.FILL);
        ringPaint.setStyle(Paint.Style.STROKE);
        ringPaint.setStrokeWidth(1.5f * density);
        ringPaint.setColor(0xCCFFFFFF);
        setClickable(true);
    }

    public void setOnColorChange(OnColorChange l) {
        listener = l;
    }

    /** 外部（比如点了预设色点）设置当前色相，只更新指示点，不回调 */
    public void setColor(int color) {
        float[] hsv = new float[3];
        Color.colorToHSV(color, hsv);
        hue = hsv[0];
        invalidate();
    }

    /** 当前色相对应的颜色 */
    public int getColor() {
        return Color.HSVToColor(new float[]{hue, 1f, 1f});
    }

    @Override
    protected void onSizeChanged(int w, int h, int oldw, int oldh) {
        super.onSizeChanged(w, h, oldw, oldh);
        if (w <= 0) return;
        float bh = barHeightDp * density;
        if (bh > h) bh = h;
        float top = (h - bh) / 2f;
        barRect.set(0f, top, w, top + bh);
        /*
         * 用 7 个色标（每 60°）拼一整圈：
         * 只给首尾两个色标（红→红）会得到一条「红→红」的线性插值 ——
         * Android 的 LinearGradient 在 sRGB 空间直接插值，
         * 中段会变成灰褐色，看起来像没着色。多放色标才走得通。
         */
        int[] colors = new int[7];
        for (int i = 0; i < 7; i++) {
            colors[i] = Color.HSVToColor(new float[]{i * 60f, 1f, 1f});
        }
        shader = new LinearGradient(0f, 0f, w, 0f, colors, null, Shader.TileMode.CLAMP);
        barPaint.setShader(shader);
    }

    @Override
    protected void onDraw(Canvas c) {
        final int w = getWidth();
        final int h = getHeight();
        if (w <= 0 || h <= 0) return;

        /* 渐变条：两端圆角（半径取条高一半，正好是胶囊形） */
        float radius = barRect.height() / 2f;
        c.drawRoundRect(barRect, radius, radius, barPaint);

        /* 当前色相位置的小圆点：白圈 + 实心当前色，压在渐变上仍看得清 */
        float x = (hue / 360f) * w;
        if (x < radius) x = radius;
        if (x > w - radius) x = w - radius;
        float cy = barRect.centerY();
        float dotR = Math.max(barRect.height() * 0.72f, 5f * density);
        dotPaint.setColor(getColor());
        c.drawCircle(x, cy, dotR, dotPaint);
        c.drawCircle(x, cy, dotR, ringPaint);
    }

    @Override
    public boolean onTouchEvent(MotionEvent ev) {
        switch (ev.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
            case MotionEvent.ACTION_MOVE: {
                /* 按住即取色（不需要先精确点在小圆点上），这是色相条的通用手感 */
                applyX(ev.getX());
                if (ev.getActionMasked() == MotionEvent.ACTION_DOWN) {
                    getParent().requestDisallowInterceptTouchEvent(true);
                }
                return true;
            }
            case MotionEvent.ACTION_UP:
            case MotionEvent.ACTION_CANCEL: {
                applyX(ev.getX());
                try {
                    getParent().requestDisallowInterceptTouchEvent(false);
                } catch (Throwable ignored) {
                }
                return true;
            }
            default:
                return super.onTouchEvent(ev);
        }
    }

    private void applyX(float x) {
        int w = getWidth();
        if (w <= 0) return;
        float clamped = Math.max(0f, Math.min(w, x));
        hue = (clamped / w) * 360f;
        /* 360 与 0 是同一个颜色，但 HSVToColor 在 360 上会回到红色，语义正确 */
        if (hue >= 360f) hue = 0f;
        invalidate();
        OnColorChange l = listener;
        if (l != null) {
            try {
                l.onChange(getColor());
            } catch (Throwable ignored) {
            }
        }
    }
}
