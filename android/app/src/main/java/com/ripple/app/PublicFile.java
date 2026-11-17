package com.ripple.app;

import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/**
 * 往系统的「下载」目录写一个文本文件（崩溃日志 / 运行日志共用）。
 *
 * 以前这套 MediaStore 逻辑在 CrashLog 和 LogBridge 里各抄了一份（各约 40 行），
 * 改一处忘一处，很容易两边行为不一致。现在收敛到这里。
 *
 * 两级落点：
 *   1. API 29+ 走 MediaStore.Downloads —— 不需要任何存储权限，
 *      proot 里的 /sdcard/Download 能直接读到，排查时最方便。
 *   2. 兜底写应用专属外部目录 getExternalFilesDir(DOWNLOADS) ——
 *      MediaStore 不可用时至少还能落盘（proot 读不到，只能 adb/文件管理器看）。
 *
 * 写失败一律静默：取证代码本身再抛异常会把「记录崩溃」变成「制造崩溃」。
 */
final class PublicFile {

    private PublicFile() {
    }

    /**
     * 写入「下载」目录。
     *
     * @param name      文件名（如 Ripple-log.txt）。overwrite=false 时调用方应自己带上唯一后缀
     * @param data      文件内容
     * @param overwrite true = 同名覆盖（先查已有 _ID 再复用），false = 每次新建
     * @return 可读的展示路径（成功时非空，例如 "Download/Ripple-log.txt"）；失败返回 ""
     */
    static String write(Context ctx, String name, byte[] data, boolean overwrite) {
        if (ctx == null || name == null || data == null) return "";
        if (Build.VERSION.SDK_INT >= 29) {
            String p = writeMediaStore(ctx, name, data, overwrite);
            if (!p.isEmpty()) return p;
        }
        return writeExternalFiles(ctx, name, data);
    }

    /** API 29+：MediaStore 公共下载目录（不需要权限） */
    private static String writeMediaStore(Context ctx, String name, byte[] data, boolean overwrite) {
        try {
            ContentResolver cr = ctx.getContentResolver();
            Uri existing = null;
            if (overwrite) {
                Cursor c = cr.query(MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                        new String[]{MediaStore.MediaColumns._ID},
                        MediaStore.MediaColumns.DISPLAY_NAME + "=?",
                        new String[]{name}, null);
                if (c != null) {
                    try {
                        if (c.moveToFirst()) {
                            existing = ContentUris.withAppendedId(
                                    MediaStore.Downloads.EXTERNAL_CONTENT_URI, c.getLong(0));
                        }
                    } finally {
                        c.close();
                    }
                }
            }
            if (existing == null) {
                ContentValues cv = new ContentValues();
                cv.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                cv.put(MediaStore.MediaColumns.MIME_TYPE, "text/plain");
                cv.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                existing = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
            }
            if (existing == null) return "";
            OutputStream os = cr.openOutputStream(existing, "wt");
            if (os == null) return "";
            try {
                os.write(data);
            } finally {
                os.close();
            }
            return "Download/" + name;
        } catch (Throwable e) {
            return "";
        }
    }

    /** 兜底：应用专属外部目录（卸载 App 时一起清掉，不需要权限） */
    private static String writeExternalFiles(Context ctx, String name, byte[] data) {
        try {
            File dir = ctx.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
            if (dir == null) return "";
            if (!dir.exists() && !dir.mkdirs()) return "";
            File f = new File(dir, name);
            FileOutputStream out = new FileOutputStream(f, false);
            try {
                out.write(data);
            } finally {
                out.close();
            }
            return f.getAbsolutePath();
        } catch (Throwable e) {
            return "";
        }
    }
}
