package com.ripple.app;

import android.content.Context;

import java.io.File;
import java.io.FileOutputStream;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 软件运行日志（给排查用）。
 *
 * 写两处：
 *   · 应用私有 files/ripple-log.txt     —— 永远可写，保底
 *   · 公共「下载」Ripple-log.txt        —— proot 里的 /sdcard/Download 直接可读
 *
 * 特点：
 *   · 有上限（默认 200KB），超了从前面截断，不会把存储写爆
 *   · add() **只进内存**，落盘统一交给一条后台线程 —— 以前 add() 是
 *     synchronized static 并且同步写盘，而它会在 UI 线程（WebView 的 JS 桥）
 *     上被调用：一次 MediaStore 查询 + 200KB 全量重写就卡在那里。
 *   · 落盘节流：相邻两次写盘至少间隔 FLUSH_MS，内容没变直接跳过
 *   · 崩溃时强制 flush，日志里能看到崩溃前最后一段
 */
final class LogBridge {

    private static final int MAX_CHARS = 200 * 1024;
    private static final long FLUSH_MS = 700;
    private static final String FILE_NAME = "Ripple-log.txt";
    /** jsError 这类高频调用单独限速：最密 RATE_MS 一次，不再每次都全量重写 */
    private static final long RATE_MS = 3000;

    private static final Object LOCK = new Object();
    private static final StringBuilder BUF = new StringBuilder();
    private static final SimpleDateFormat TS =
            new SimpleDateFormat("MM-dd HH:mm:ss.SSS", Locale.US);
    private static long lastFlush = 0;
    private static volatile String cachedPath = "";

    /** 上一次真正写盘的正文，内容没变就不重复写（全量重写 200KB 很贵） */
    private static String lastBody = null;
    /** 上一次 jsError 触发落盘的时间（限速用） */
    private static long lastErrorFlush = 0;

    /*
     * 单线程 executor：所有写盘串行化。
     * 用进程级的 Application Context —— 不持有 Activity，不会泄漏；
     * 线程是守护性质的（任务队列很短），App 退出时不受它拖延。
     */
    private static final ExecutorService IO =
            Executors.newSingleThreadExecutor(r -> {
                Thread t = new Thread(r, "ripple-log-io");
                t.setDaemon(true);
                return t;
            });
    /** 已经排了一个「写盘」任务没跑：再多的 add() 只合并成这一次 */
    private static final AtomicBoolean PENDING = new AtomicBoolean(false);
    /** 写入用的 Application Context（跨线程读，必须 volatile） */
    private static volatile Context appCtx;

    private LogBridge() {
    }

    /** 只入内存，落盘交给后台线程（本方法不再碰磁盘） */
    static void add(Context ctx, String tag, String msg) {
        if (ctx != null) appCtx = ctx.getApplicationContext();
        if (msg == null) msg = "";
        boolean due;
        synchronized (LOCK) {
            BUF.append(TS.format(new Date()))
                    .append(' ')
                    .append(tag == null ? "-" : tag)
                    .append(": ")
                    .append(msg)
                    .append('\n');
            trim();
            long now = System.currentTimeMillis();
            due = now - lastFlush >= FLUSH_MS;
            if (due) lastFlush = now;
        }
        // 节流窗口外的调用只留个标记，由下一个到点的调用/定时器落盘
        if (due) scheduleWrite();
    }

    /** 强制落盘（关键节点调用）。异步执行，不阻塞调用线程。 */
    static void flush(Context ctx) {
        if (ctx != null) appCtx = ctx.getApplicationContext();
        synchronized (LOCK) {
            lastFlush = System.currentTimeMillis();
        }
        scheduleWrite();
    }

    /**
     * 记录一次 JS 错误并请求落盘。
     * 一个每秒复发的 JS 错误以前会每秒双写 200KB，这里单独限速。
     */
    static void addError(Context ctx, String tag, String msg) {
        add(ctx, tag, msg);
        if (ctx != null) appCtx = ctx.getApplicationContext();
        boolean due;
        synchronized (LOCK) {
            long now = System.currentTimeMillis();
            due = now - lastErrorFlush >= RATE_MS;
            if (due) lastErrorFlush = now;
        }
        if (due) scheduleWrite();
    }

    static String dump() {
        synchronized (LOCK) {
            return BUF.toString();
        }
    }

    static String path() {
        return cachedPath;
    }

    private static void trim() {
        if (BUF.length() <= MAX_CHARS) return;
        int cut = BUF.length() - MAX_CHARS;
        BUF.delete(0, cut);
        BUF.insert(0, "…(更早的日志已截断)…\n");
    }

    /** 合并写盘请求：队列里已经有一个未执行的写任务时不再重复提交 */
    private static void scheduleWrite() {
        if (!PENDING.compareAndSet(false, true)) return;
        try {
            IO.execute(() -> {
                PENDING.set(false);
                try {
                    write();
                } catch (Throwable ignored) {
                }
            });
        } catch (Throwable e) {
            // executor 已关闭（进程收尾）时不要抛
            PENDING.set(false);
        }
    }

    private static void write() {
        Context ctx = appCtx;
        if (ctx == null) return;
        byte[] data;
        String body;
        synchronized (LOCK) {
            body = BUF.toString();
            // 内容完全一样就别再写一遍：CrashLog.step / 启动阶段会连着调好几次
            if (body.equals(lastBody)) return;
            lastBody = body;
        }
        try {
            data = body.getBytes("UTF-8");
        } catch (Exception e) {
            return;
        }

        // 1) 私有目录（保底）
        try {
            File f = new File(ctx.getFilesDir(), "ripple-log.txt");
            FileOutputStream out = new FileOutputStream(f, false);
            try {
                out.write(data);
            } finally {
                out.close();
            }
        } catch (Throwable ignored) {
        }

        // 2) 公共下载目录（proot 可读）——落点逻辑收敛到 PublicFile
        String p = PublicFile.write(ctx, FILE_NAME, data, true);
        if (!p.isEmpty()) cachedPath = p;
    }
}
