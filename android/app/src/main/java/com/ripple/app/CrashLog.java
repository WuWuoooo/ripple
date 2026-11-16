package com.ripple.app;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.text.SimpleDateFormat;
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

    static void installQuietly(Context app) {
        try {
            final Thread.UncaughtExceptionHandler prev = Thread.getDefaultUncaughtExceptionHandler();
            Thread.setDefaultUncaughtExceptionHandler((t, e) -> {
                try {
                    record(app, "uncaught-" + t.getName(), e);
                    flushTrace(app);
                } catch (Throwable ignored) {
                }
                if (prev != null) prev.uncaughtException(t, e);
            });
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
        pw.println("version: 1.1.0 (" + 110 + ")");
        pw.println();
        e.printStackTrace(pw);
        pw.println();
        pw.println("---- startup trace ----");
        pw.println(TRACE.toString());
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
            out.write(text.getBytes("UTF-8"));
            out.close();
        } catch (Throwable ignored) {
        }
    }

    /**
     * @param overwrite true 时固定文件名并覆盖（轨迹文件只留最新一份，避免刷爆下载目录）
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

        if (Build.VERSION.SDK_INT >= 29) {
            // 公共「下载」目录：proot 侧 /sdcard/Download 直接可读，方便排查
            try {
                ContentResolver cr = ctx.getContentResolver();
                Uri existing = null;
                if (overwrite) {
                    android.database.Cursor c = cr.query(MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                            new String[]{MediaStore.MediaColumns._ID},
                            MediaStore.MediaColumns.DISPLAY_NAME + "=?",
                            new String[]{name}, null);
                    if (c != null) {
                        if (c.moveToFirst()) {
                            existing = android.content.ContentUris.withAppendedId(
                                    MediaStore.Downloads.EXTERNAL_CONTENT_URI, c.getLong(0));
                        }
                        c.close();
                    }
                }
                if (existing == null) {
                    ContentValues cv = new ContentValues();
                    cv.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                    cv.put(MediaStore.MediaColumns.MIME_TYPE, "text/plain");
                    cv.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                    existing = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                }
                if (existing != null) {
                    OutputStream os = cr.openOutputStream(existing, "wt");
                    if (os != null) {
                        os.write(data);
                        os.close();
                        return;
                    }
                }
            } catch (Throwable ignored) {
            }
        }
        // 兜底：应用扩展目录（proot 读不到，但至少落盘了）
        try {
            File dir = ctx.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
            if (dir != null) {
                if (!dir.exists()) dir.mkdirs();
                File f = new File(dir, name);
                FileOutputStream out = new FileOutputStream(f, false);
                out.write(data);
                out.close();
            }
        } catch (Throwable ignored) {
        }
    }

    private static String safe(String s) {
        if (s == null) return "x";
        return s.replaceAll("[^A-Za-z0-9_-]", "_");
    }
}
