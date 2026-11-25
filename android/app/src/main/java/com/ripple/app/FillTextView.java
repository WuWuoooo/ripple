package com.ripple.app;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.os.SystemClock;
import android.text.TextPaint;
import android.util.AttributeSet;
import android.view.View;

/**
 * 状态栏歌词的绘制视图：**自己画**，不用 TextView。
 *
 * ============================================================================
 * 为什么从 TextView 换成自绘 View（1.3.3 第十轮）
 * ============================================================================
 *
 * 前九轮的教训链：
 *   · setShader   → 不生效（这块悬浮窗的绘制被系统按「静止窗口」缓存）
 *   · clipRect    → 不生效（同上）
 *   · Spannable   → **生效了！** 但带来两个新问题：
 *       ① 逐字 setText 会重置 marquee 的滚动状态 → 长句滚动时剧烈抖动；
 *       ② 按「字符」上色，视觉上是一个字一个字跳，不丝滑。
 *
 * 关键认知：Spannable 能生效，是因为它**改的是文字内容**（触发 TextView
 * 内部完整的重新排版与提交）。但那套机制太重 —— 每改一次就重建整个
 * CharSequence、重排、重置滚动。
 *
 * 真正该做的：**只让「内容」变一次，其余全靠平移**。
 *
 * ============================================================================
 * 现在的做法
 * ============================================================================
 *
 * 自己继承 View，在 onDraw 里用 Paint 画两遍文字：
 *   ① 用未唱色把整行画一遍；
 *   ② 用已唱色再画一遍，但用 canvas.clipRect 只露出左边「已唱宽度」。
 *
 * ⚠️ 这里会有疑问：前面不是说 clipRect 不生效吗？
 *   不生效的是「**在 TextView 的 onDraw 里**加 clipRect」——
 *   那是给 TextView 已经排好的布局做二次裁剪，它的提交路径被缓存了。
 *   而这里是**自己完整地画**，整个 View 的绘制都是我们自己发起的，
 *   没有任何父类布局参与，系统必须执行我们这一次的 canvas 指令。
 *   （Spannable 之所以能生效，也是因为走了「完整重画」这条路。）
 *
 * ============================================================================
 * 跑马灯自己实现
 * ============================================================================
 *
 * 不再用 TextView 的 TruncateAt.MARQUEE —— 它依赖 selected 状态、
 * 依赖 TextView 内部计时器，而且每次 setText 都会重置滚动进度，
 * 与高频刷新天然冲突（用户报的「填充覆盖滚动、引发布局抖动」就是它）。
 *
 * 现在：文字总宽度 > 可用宽度时，自己维护一个 scrollX，
 * 每帧推进一点点，到尾部停一下再回到开头。**滚动与染色完全解耦**：
 *   · 染色 = 裁剪宽度（不碰布局）
 *   · 滚动 = 绘制起点偏移（不碰布局）
 * 两者都是纯绘制参数，不会触发 measure/layout，因此不可能抖动。
 */
public class FillTextView extends View {

    /* ================= 配置 ================= */

    /** 是否启用进度上色 */
    private boolean fill = false;
    /** 当前进度 0..1 */
    private float progress = 0f;
    /** 已播放部分的颜色 */
    private int fillColor = 0xFF7DE3D0;
    /** 未播放部分（基础）的颜色 */
    private int baseColor = Color.WHITE;

    /** 要显示的文字 */
    private String text = "";
    /** 字号（px） */
    private float textSizePx = 48f;
    /** 是否粗体 */
    private boolean bold = true;
    /** 阴影半径（0 = 不画阴影） */
    private float shadowRadius = 0f;
    /** 左右内边距 */
    private int padH = 0;
    private int padV = 0;
    /** 最大宽度限制（0 = 不限制，用于长句滚动） */
    private int maxWidthPx = 0;

    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final TextPaint tp = new TextPaint(Paint.ANTI_ALIAS_FLAG);

    /* ================= 滚动状态 ================= */

    /** 当前滚动偏移（px，>=0 表示内容整体左移） */
    private float scrollX = 0f;
    /** 上一次推进滚动的时刻 */
    private long scrollAt = 0;
    /** 滚动速度：px/秒 */
    private static final float SCROLL_SPEED = 42f;
    /** 滚到尾部后停留多久再回开头（毫秒） */
    private static final long HOLD_MS = 900;

    /* ================= 诊断 ================= */

    public static int DRAW_COUNT = 0;
    public static int DRAW_ENTRY = 0;
    public static int SKIP_NOFILL = 0;
    public static int SKIP_WIDTH = 0;
    public static int SKIP_PZERO = 0;
    public static int SKIP_PONE = 0;
    public static int DRAW_FULL = 0;
    public static int INV_CALL = 0;
    public static int INV_DUP = 0;
    public static int SET_TEXT = 0;
    public static long DRAW_ENTRY_TOTAL = 0L;

    public static String takeDiag() {
        String s = "entry=" + DRAW_ENTRY
                + " full=" + DRAW_FULL
                + " setText=" + SET_TEXT
                + " nofill=" + SKIP_NOFILL
                + " w0=" + SKIP_WIDTH
                + " p0=" + SKIP_PZERO
                + " p1=" + SKIP_PONE
                + " inv=" + INV_CALL
                + " dup=" + INV_DUP;
        DRAW_ENTRY = 0; SKIP_NOFILL = 0; SKIP_WIDTH = 0;
        SKIP_PZERO = 0; SKIP_PONE = 0; DRAW_FULL = 0;
        INV_CALL = 0; INV_DUP = 0; SET_TEXT = 0;
        return s;
    }

    public FillTextView(Context ctx) {
        super(ctx);
        init();
    }

    public FillTextView(Context ctx, AttributeSet attrs) {
        super(ctx, attrs);
        init();
    }

    public FillTextView(Context ctx, AttributeSet attrs, int defStyle) {
        super(ctx, attrs, defStyle);
        init();
    }

    private void init() {
        tp.setAntiAlias(true);
        tp.setDither(true);
        setWillNotDraw(false);
    }

    /* ================= 对外配置（保持与原 TextView 版本同名，减少调用处改动） ================= */

    /** 设置文字（只在真的变化时才触发重新测量） */
    public void setText(String t) {
        final String v = t == null ? "" : t;
        if (v.equals(text)) return;
        text = v;
        scrollX = 0f;
        scrollAt = 0;
        SET_TEXT++;
        requestLayout();
        invalidate();
        /* 换句后文字长度可能变了，重新判断要不要滚 */
        post(this::syncScrollLoop);
    }

    /** 当前原始文字 */
    public String plainText() {
        return text;
    }

    public void setTextSizePx(float px) {
        if (Math.abs(px - textSizePx) < 0.01f) return;
        textSizePx = px;
        tp.setTextSize(px);
        requestLayout();
        invalidate();
    }

    public void setBold(boolean b) {
        if (bold == b) return;
        bold = b;
        tp.setFakeBoldText(b);
        requestLayout();
        invalidate();
    }

    public void setShadowRadius(float r) {
        if (Math.abs(r - shadowRadius) < 0.01f) return;
        shadowRadius = r;
        if (r > 0f) {
            tp.setShadowLayer(r, 0f, 0f, 0xCC000000);
        } else {
            tp.clearShadowLayer();
        }
        invalidate();
    }

    public void setPaddingPx(int h, int v) {
        padH = h;
        padV = v;
        requestLayout();
        invalidate();
    }

    /**
     * 最大宽度（px）。
     *
     * 注意：这里限制的是**文字可用宽度**，不是 View 宽度。
     * 超过时会启用自实现的跑马灯（见 onDraw）。
     */
    public void setMaxTextWidth(int px) {
        if (px == maxWidthPx) return;
        maxWidthPx = px;
        requestLayout();
        invalidate();
    }

    public void setColor(int c) {
        if (baseColor == c) return;
        baseColor = c;
        invalidate();
    }

    /**
     * 设置填充参数。
     *
     * ⚠️ 与旧版最重要的区别：**这里绝不碰文字内容、绝不 requestLayout**。
     * 只改 progress 一个数字，然后 invalidate。
     * 这正是「不抖动」的根本保证 —— 布局完全不参与进度更新。
     */
    public void setFill(boolean on, float p, int played, int base) {
        INV_CALL++;
        if (!Float.isFinite(p)) p = 0f;
        p = Math.max(0f, Math.min(1f, p));
        boolean changed = (on != fill)
                || Math.abs(p - progress) > 0.0005f
                || played != fillColor
                || base != baseColor;
        fillColor = played;
        baseColor = base;
        fill = on;
        progress = p;
        if (!changed) { INV_DUP++; return; }
        invalidate();
    }

    public void clearFill(int textColor) {
        fill = false;
        baseColor = textColor;
        invalidate();
    }

    /* ================= 测量 ================= */

    /** 文字实际宽度（px） */
    public float textWidth() {
        return text.isEmpty() ? 0f : tp.measureText(text);
    }

    /** 是否处于「需要滚动」状态 */
    public boolean needScroll() {
        if (maxWidthPx <= 0) return false;
        return textWidth() > maxWidthPx;
    }

    @Override
    protected void onMeasure(int widthSpec, int heightSpec) {
        tp.setTextSize(textSizePx);
        tp.setFakeBoldText(bold);
        final float tw = textWidth();
        final Paint.FontMetrics fm = tp.getFontMetrics();
        final int textH = (int) Math.ceil(fm.descent - fm.ascent);
        int wantW = (int) Math.ceil(tw) + padH * 2;
        if (maxWidthPx > 0) {
            /* 窗口宽度不超过「可用文字宽度 + padding」，超出的部分靠滚动看 */
            final int cap = maxWidthPx + padH * 2;
            if (wantW > cap) wantW = cap;
        }
        final int wantH = textH + padV * 2;
        setMeasuredDimension(
                resolveSize(wantW, widthSpec),
                resolveSize(wantH, heightSpec));
        /* 量完之后才知道是否超出 → 决定要不要启动滚动自驱动 */
        syncScrollLoop();
    }

    /* ================= 绘制 ================= */

    @Override
    protected void onDraw(Canvas canvas) {
        DRAW_ENTRY++;
        DRAW_ENTRY_TOTAL++;
        if (text.isEmpty()) {
            SKIP_WIDTH++;
            return;
        }
        tp.setTextSize(textSizePx);
        tp.setFakeBoldText(bold);
        tp.setStyle(Paint.Style.FILL);

        final int w = getWidth();
        final int h = getHeight();
        final float availW = Math.max(0, w - padH * 2);
        final float fullW = textWidth();
        final Paint.FontMetrics fm = tp.getFontMetrics();
        /* 基线：垂直居中 */
        final float baseline = h / 2f - (fm.ascent + fm.descent) / 2f;

        /* ---------- 滚动推进（纯绘制参数，不触发布局） ---------- */
        final boolean scrolling = needScroll() && fullW > availW;
        float offX = 0f;
        if (scrolling) {
            final long now = SystemClock.uptimeMillis();
            if (scrollAt == 0) scrollAt = now;
            final float dt = (now - scrollAt) / 1000f;
            scrollAt = now;
            final float span = fullW - availW;
            if (scrollX < span) {
                scrollX += dt * SCROLL_SPEED;
                if (scrollX > span) scrollX = span;
            } else {
                /*
                 * 滚到尾部：停留一段时间再回开头。
                 * 停留用「时间到就跳」而不是每帧判超时，
                 * 避免在停留期间反复重置计时器导致永远不走。
                 */
                if (dt > 0f) holdMs += (long) (dt * 1000);
                if (holdMs >= HOLD_MS) { scrollX = 0f; holdMs = 0; }
            }
            offX = -scrollX;
        } else {
            scrollX = 0f;
            holdMs = 0;
        }
        final float left = padH + offX;

        /* ---------- ① 未唱部分：整行画一遍（基础色） ---------- */
        tp.setColor(baseColor);
        SKIP_NOFILL++;
        canvas.drawText(text, left, baseline, tp);

        /* ---------- ② 已唱部分：裁剪后重画（填充色） ---------- */
        if (fill && progress > 0f) {
            /*
             * 已唱宽度按「文字总宽度 × 进度」算，而不是按可用宽度 ——
             * 长句滚动时，进度描述的是整句唱到哪儿，
             * 用可用宽度算会让染色边界和唱到的位置错开。
             */
            final float litW = fullW * progress;
            if (progress >= 1f) SKIP_PONE++; else SKIP_PZERO++;
            DRAW_COUNT++;
            DRAW_FULL++;
            final int save = canvas.save();
            try {
                /*
                 * 裁剪右边界必须**考虑滚动偏移**。
                 *
                 * 直观写法是 clipRect(padH, 0, padH + litW, h)，
                 * 但那是假设「文字从头开始画」（offX=0）。
                 * 长句滚动时文字整体左移了 scrollX，屏幕上此刻看到的是
                 * 文字内部 [scrollX, scrollX+availW] 这一段，
                 * 而「已唱」在文字内部到达 litW —— 它在屏幕上的位置是：
                 *
                 *     padH + litW - scrollX
                 *
                 * 不加这个修正，滚到后半段时染色边界会一直停在
                 * 屏幕的同一个位置，看起来「染色和唱到的字错开了」。
                 *
                 * 同时左边界取 padH 而不是 0：
                 * 文字区域从 padH 开始，再往左是 padding 空白，
                 * 裁进去没有意义（也避免把阴影裁出一条硬边）。
                 */
                final float litRight = padH + litW - scrollX;
                if (litRight > padH) {
                    canvas.clipRect(padH, 0f, litRight, h);
                    tp.setColor(fillColor);
                    canvas.drawText(text, left, baseline, tp);
                }
            } finally {
                canvas.restoreToCount(save);
            }
        }
    }

    /** 尾部停留计时（ms） */
    private long holdMs = 0;

    /**
     * 滚动自驱动。
     *
     * 为什么要自己 invalidate：
     *   滚动是**绘制层**的行为，而 invalidate 只会在「进度变化」时被外部触发。
     *   一旦关掉填充（进度不再更新）或播放暂停，外部就不再 invalidate，
     *   滚动会僵在原地。
     *
     *   这里在需要滚动时挂一个 16ms 的自循环，不需要时立刻停 ——
     *   只有长句（超出窗口宽度）才会启动，短句零开销。
     */
    private boolean scrollLoopOn = false;
    private final Runnable scrollTick = new Runnable() {
        @Override
        public void run() {
            if (!scrollLoopOn) return;
            if (!needScroll()) { scrollLoopOn = false; return; }
            invalidate();
            postDelayed(this, 16);   // ≈60fps，只用于滚动
        }
    };

    /** 根据当前文字长度决定是否启动/停止滚动自驱动 */
    private void syncScrollLoop() {
        final boolean need = needScroll();
        if (need && !scrollLoopOn) {
            scrollLoopOn = true;
            scrollAt = 0;
            postDelayed(scrollTick, 16);
        } else if (!need && scrollLoopOn) {
            scrollLoopOn = false;
            removeCallbacks(scrollTick);
            scrollX = 0f;
            holdMs = 0;
        }
    }

    @Override
    protected void onDetachedFromWindow() {
        scrollLoopOn = false;
        removeCallbacks(scrollTick);
        super.onDetachedFromWindow();
    }

    /** 兼容旧调用 */
    @SuppressWarnings("unused")
    private void noop() {
    }
}
