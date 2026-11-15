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
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * 软件运行日志（给排查用）。
 *
 * 写两处：
 *   · 应用私有 files/ripple-log.txt     —— 永远可写，保底
 *   · 公共「下载」Ripple-log.txt        —— proot 里的 /sdcard/Download 直接可读
 *
 * 特点：
 *   · 有上限（默认 200KB），超了从前面截断，不会把存储写爆
 *   · 写盘节流：最多每 700ms 落一次盘，避免频繁 IO
 *   · 崩溃时强制 flush，日志里能看到崩溃前最后一段
 */
final class LogBridge {

    private static final int MAX_CHARS = 200 * 1024;
    private static final long FLUSH_MS = 700;
    private static final String FILE_NAME = "Ripple-log.txt";

    private static final StringBuilder BUF = new StringBuilder();
    private static final SimpleDateFormat TS =
            new SimpleDateFormat("MM-dd HH:mm:ss.SSS", Locale.US);
    private static long lastFlush = 0;
    private static String cachedPath = "";

    private LogBridge() {
    }

    static synchronized void add(Context ctx, String tag, String msg) {
        if (msg == null) msg = "";
        BUF.append(TS.format(new Date()))
                .append(' ')
                .append(tag == null ? "-" : tag)
                .append(": ")
                .append(msg)
                .append('\n');
        trim();
        long now = System.currentTimeMillis();
        if (now - lastFlush >= FLUSH_MS) {
            lastFlush = now;
            write(ctx);
        }
    }

    static synchronized void flush(Context ctx) {
        lastFlush = System.currentTimeMillis();
        write(ctx);
    }

    static synchronized String dump() {
        return BUF.toString();
    }

    static synchronized String path() {
        return cachedPath;
    }

    private static void trim() {
        if (BUF.length() <= MAX_CHARS) return;
        int cut = BUF.length() - MAX_CHARS;
        BUF.delete(0, cut);
        BUF.insert(0, "…(更早的日志已截断)…\n");
    }

    /** 上一次真正写盘的正文，内容没变就不重复写（全量重写 200KB 很贵） */
    private static String lastBody = null;

    private static void write(Context ctx) {
        byte[] data;
        String body;
        try {
            body = BUF.toString();
            // 内容完全一样就别再写一遍：CrashLog.step / 启动阶段会连着调好几次
            if (body.equals(lastBody)) return;
            data = body.getBytes("UTF-8");
        } catch (Exception e) {
            return;
        }
        lastBody = body;
        // 1) 私有目录（保底）
        try {
            File f = new File(ctx.getFilesDir(), "ripple-log.txt");
            FileOutputStream out = new FileOutputStream(f, false);
            out.write(data);
            out.close();
        } catch (Throwable ignored) {
        }

        // 2) 公共下载目录（proot 可读）
        if (Build.VERSION.SDK_INT >= 29) {
            try {
                ContentResolver cr = ctx.getContentResolver();
                Uri uri = null;
                android.database.Cursor c = cr.query(MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                        new String[]{MediaStore.MediaColumns._ID},
                        MediaStore.MediaColumns.DISPLAY_NAME + "=?",
                        new String[]{FILE_NAME}, null);
                if (c != null) {
                    if (c.moveToFirst()) {
                        uri = android.content.ContentUris.withAppendedId(
                                MediaStore.Downloads.EXTERNAL_CONTENT_URI, c.getLong(0));
                    }
                    c.close();
                }
                if (uri == null) {
                    ContentValues cv = new ContentValues();
                    cv.put(MediaStore.MediaColumns.DISPLAY_NAME, FILE_NAME);
                    cv.put(MediaStore.MediaColumns.MIME_TYPE, "text/plain");
                    cv.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                    uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                }
                if (uri != null) {
                    OutputStream os = cr.openOutputStream(uri, "wt");
                    if (os != null) {
                        os.write(data);
                        os.close();
                        cachedPath = "Download/" + FILE_NAME;
                        return;
                    }
                }
            } catch (Throwable ignored) {
            }
        }
        try {
            File dir = ctx.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
            if (dir != null) {
                if (!dir.exists()) dir.mkdirs();
                File f = new File(dir, FILE_NAME);
                FileOutputStream out = new FileOutputStream(f, false);
                out.write(data);
                out.close();
                cachedPath = f.getAbsolutePath();
            }
        } catch (Throwable ignored) {
        }
    }
}
