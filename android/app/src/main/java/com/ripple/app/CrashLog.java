package com.ripple.app;

import android.content.Context;
import android.os.Build;

import java.io.File;
import java.io.FileOutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.text.SimpleDateFormat;
import java.util.Arrays;
import java.util.Comparator;
import java.util.Date;
import java.util.Locale;

/**
 * 崩溃 / 启动轨迹取证。
 *
 * 写两处：
 *   1. 应用私有 files/*.txt（永远可写，保底）
 *   2. 系统「下载」目录 Download/Ripple-*.txt（API 29+ 走 MediaStore，不需要权限）
 *      —— 这一份的关键是：proot 里的 /sdcard/Download 能直接读到，可以拿来排查。
 *
 * 除了崩溃堆栈，还记录「启动轨迹」：每走一步写一行，
 * 这样即使发生 native 崩溃（Java 层抓不到），也能看出死在哪一步之前。
 *
 * 文件策略（以前会无限增长）：
 *   · 「上次退出原因」这类**不是崩溃**的取证，固定文件名覆盖写（Ripple-exit-info.txt）
 *   · 真正的崩溃保留最近 MAX_CRASH_FILES 份，超出按文件名（含时间戳）删最老的
 */
final class CrashLog {

    private static final Object LOCK = new Object();

    /*
     * 轨迹落盘的节流参数。
     * 以前每一步都 writeDownloads()：MediaStore 查询 + openOutputStream 全量重写，
     * 而 MainActivity.onCreate 里就有十来次 step，冷启动光在写文件上就跨进程好几趟。
     * 现在内存里照常累积，只在「攒够 8 步」或「距上次落盘超过 5 秒」时才写一次；
     * 崩溃（record / flushTrace）仍然保证拿到完整轨迹。
     * 保留条数上限而不是纯时间窗口，是因为 native 崩溃来不及走 flushTrace，
     * 下载目录里那份必须自己跟上关键启动步骤。
     */
    private static final long FLUSH_WINDOW_MS = 5000;
    private static final int FLUSH_EVERY_STEPS = 8;
    private static long lastFlushAt = 0;
    private static int stepsSinceFlush = 0;
    static volatile String lastTrace = "";

    private static final StringBuilder TRACE = new StringBuilder();
    private static int traceStep = 0;

    /** 崩溃文件保留份数：只留最近这么多份，避免下载目录被历史崩溃刷爆 */
    private static final int MAX_CRASH_FILES = 10;
    /** 幂等标记：装过就不再装第二次（否则会形成链式 handler + 重复写文件） */
    private static boolean installed = false;

    private CrashLog() {
    }

    /* ================= 启动轨迹 ================= */

    /** 记一步（只在内存累积，按步数/时间窗口节流落盘） */
    static void step(Context ctx, String what) {
        synchronized (LOCK) {
            traceStep++;
            TRACE.append(traceStep).append(". ")
                    .append(new SimpleDateFormat("HH:mm:ss.SSS", Locale.US).format(new Date()))
                    .append("  ").append(what).append('\n');
            stepsSinceFlush++;
            long now = System.currentTimeMillis();
            boolean byCount = stepsSinceFlush >= FLUSH_EVERY_STEPS;
            boolean byTime = now - lastFlushAt >= FLUSH_WINDOW_MS;
            if (!byCount && !byTime) return;
            stepsSinceFlush = 0;
            lastFlushAt = now;
            try {
                writeDownloads(ctx, "trace", TRACE.toString(), true);
            } catch (Throwable ignored) {
            }
        }
    }

    static void flushTrace(Context ctx) {
        synchronized (LOCK) {
            lastFlushAt = System.currentTimeMillis();
            stepsSinceFlush = 0;
            try {
                writePrivate(ctx, "trace", TRACE.toString());
                writeDownloads(ctx, "trace", TRACE.toString(), true);
            } catch (Throwable ignored) {
            }
        }
    }

    /* ================= 崩溃 ================= */

    /**
     * 安装全局崩溃捕获。
     *
     * 幂等：MainActivity 和 RippleApp 以前都调了一次，于是形成
     * 「新 handler → 旧 handler → 默认 handler」的链，同一次崩溃会被写两遍，
     * 而且第一次调用带的是 Activity（静态字段里留住了整棵 View 树）。
     * 现在只装一次，并且强制用 Application Context。
     */
    static synchronized void installQuietly(Context ctx) {
        if (installed) return;
        if (ctx == null) return;
        installed = true;
        final Context app = ctx.getApplicationContext() == null
                ? ctx : ctx.getApplicationContext();
        try {
            final Thread.UncaughtExceptionHandler prev = Thread.getDefaultUncaughtExceptionHandler();
            Thread.setDefaultUncaughtExceptionHandler((t, e) -> {
                try {
                    record(app, "uncaught-" + t.getName(), e);
                    flushTrace(app);
                } catch (Throwable ignored) {
                }
                // 交给系统原本的处理器（默认实现会杀进程 + 上报），不要把它吃掉
                if (prev != null) {
                    try {
                        prev.uncaughtException(t, e);
                    } catch (Throwable ignored) {
                    }
                }
            });
        } catch (Throwable ignored) {
            installed = false;
        }
    }

    /**
     * 「上次进程为什么退出」这类非崩溃取证。
     *
     * 固定文件名覆盖写：LMK 杀进程、厂商后台清理都会产生一条 exit info，
     * 以前每条都新建一个带秒级时间戳的文件，用得久了下载目录里全是它。
     * 现在只留最新一份 —— 反正每次启动都会重新写。
     */
    static void recordExitInfo(Context ctx, String text) {
        if (text == null || text.isEmpty()) return;
        lastTrace = text;
        try {
            writePrivate(ctx, "exit-info", text);
            writeDownloads(ctx, "exit-info", text, true);
        } catch (Throwable ignored) {
        }
    }

    static void recordRaw(Context ctx, String tag, String text) {
        lastTrace = text;
        synchronized (LOCK) {
            writePrivate(ctx, tag, text);
            writeDownloads(ctx, tag, text, false);
        }
    }

    static String record(Context ctx, String tag, Throwable e) {
        StringWriter sw = new StringWriter();
        PrintWriter pw = new PrintWriter(sw);
        pw.println("== Ripple crash " + stamp() + " ==");
        pw.println("tag: " + tag);
        pw.println("sdk: " + Build.VERSION.SDK_INT + "  device: " + Build.MANUFACTURER + " " + Build.MODEL);
        // 这一行的形状必须保持 "version: x.y.z (" + NNN + ")"：build-apk.sh 用 sed 同步版本号
        pw.println("version: 1.2.0 (" + 120 + ")");
        pw.println();
        if (e != null) e.printStackTrace(pw);
        pw.println();
        /*
         * 只在锁里取一次快照：以前是锁外 TRACE.toString()，
         * 而 step() 同时在另一个线程 append —— 并发 toString/append
         * 可能抛 StringIndexOutOfBoundsException，把取证本身搞挂。
         */
        String trace;
        synchronized (LOCK) {
            trace = TRACE.toString();
        }
        pw.println("---- startup trace ----");
        pw.println(trace);
        pw.flush();
        String text = sw.toString();
        lastTrace = text;
        synchronized (LOCK) {
            writePrivate(ctx, tag, text);
            writeDownloads(ctx, tag, text, false);
        }
        return text;
    }

    static String recordMessage(Context ctx, String tag, String message) {
        return record(ctx, tag, new RuntimeException(message));
    }

    private static String stamp() {
        return new SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(new Date());
    }

    private static void writePrivate(Context ctx, String tag, String text) {
        try {
            File f = new File(ctx.getFilesDir(), "crash-" + stamp() + "-" + safe(tag) + ".txt");
            FileOutputStream out = new FileOutputStream(f, false);
            try {
                out.write(text.getBytes("UTF-8"));
            } finally {
                out.close();
            }
        } catch (Throwable ignored) {
        }
    }

    /**
     * @param overwrite true 时固定文件名并覆盖（轨迹 / 退出原因只留最新一份）
     */
    private static void writeDownloads(Context ctx, String tag, String text, boolean overwrite) {
        String name = overwrite
                ? "Ripple-" + safe(tag) + ".txt"
                : "Ripple-crash-" + stamp() + "-" + safe(tag) + ".txt";
        byte[] data;
        try {
            data = text.getBytes("UTF-8");
        } catch (Exception e) {
            return;
        }
        // 落点逻辑收敛到 PublicFile（以前和 LogBridge 各抄一份）
        PublicFile.write(ctx, name, data, overwrite);
        if (!overwrite) {
            prunePrivateCrashFiles(ctx);
            pruneDownloadCrashFiles(ctx);
        }
    }

    /**
     * 只保留最近 MAX_CRASH_FILES 份崩溃文件。
     * 文件名形如 crash-yyyyMMdd-HHmmss-tag.txt：时间戳是零填充的，
     * 所以按名字倒序排就是「新 → 旧」，删尾部的即可。
     */
    private static void prunePrivateCrashFiles(Context ctx) {
        try {
            File dir = ctx.getFilesDir();
            if (dir == null) return;
            File[] all = dir.listFiles((d, n) -> n.startsWith("crash-") && n.endsWith(".txt"));
            if (all == null || all.length <= MAX_CRASH_FILES) return;
            Arrays.sort(all, Comparator.comparing(File::getName).reversed());
            for (int i = MAX_CRASH_FILES; i < all.length; i++) {
                // 只删自己命名规则内的文件，且确认在 files 目录里
                try {
                    if (all[i].getParentFile() != null
                            && all[i].getParentFile().getAbsolutePath()
                                    .equals(dir.getAbsolutePath())) {
                        //noinspection ResultOfMethodCallIgnored
                        all[i].delete();
                    }
                } catch (Throwable ignored) {
                }
            }
        } catch (Throwable ignored) {
        }
    }

    /**
     * 下载目录里的崩溃文件同样只留最近 MAX_CRASH_FILES 份。
     *
     * 私有目录那份清掉了，但这才是用户真正能翻到、也真正会越攒越多的那份
     * （proot 里 /sdcard/Download 直接可见）。以前一个都不会删。
     * 用 MediaStore 按 DISPLAY_NAME 前缀查询，取出来按名字排序后删最老的。
     */
    private static void pruneDownloadCrashFiles(Context ctx) {
        if (Build.VERSION.SDK_INT < 29) return;   // 29 以下兜底目录由 prunePrivateCrashFiles 思路覆盖
        try {
            android.content.ContentResolver cr = ctx.getContentResolver();
            android.database.Cursor c = cr.query(
                    android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                    new String[]{
                            android.provider.MediaStore.MediaColumns._ID,
                            android.provider.MediaStore.MediaColumns.DISPLAY_NAME},
                    android.provider.MediaStore.MediaColumns.DISPLAY_NAME + " LIKE ?",
                    new String[]{"Ripple-crash-%"}, null);
            if (c == null) return;
            // (名字, id) 收起来一次处理，别在游标打开时做删除
            java.util.List<String[]> rows = new java.util.ArrayList<>();
            try {
                while (c.moveToNext()) {
                    rows.add(new String[]{c.getString(1), String.valueOf(c.getLong(0))});
                }
            } finally {
                c.close();
            }
            if (rows.size() <= MAX_CRASH_FILES) return;
            rows.sort((a, b) -> {
                String na = a[0] == null ? "" : a[0];
                String nb = b[0] == null ? "" : b[0];
                return nb.compareTo(na);      // 新 → 旧
            });
            for (int i = MAX_CRASH_FILES; i < rows.size(); i++) {
                try {
                    android.net.Uri u = android.content.ContentUris.withAppendedId(
                            android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                            Long.parseLong(rows.get(i)[1]));
                    cr.delete(u, null, null);
                } catch (Throwable ignored) {
                }
            }
        } catch (Throwable ignored) {
        }
    }

    private static String safe(String s) {
        if (s == null) return "x";
        return s.replaceAll("[^A-Za-z0-9_-]", "_");
    }
}
