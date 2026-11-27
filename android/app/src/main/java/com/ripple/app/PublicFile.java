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
                /*
                 * B-3（审查 1.3.8）：这段查询**不能**把 RELATIVE_PATH 写进 selection，
                 * 也不能要求 OWNER_PACKAGE_NAME 一定等于本包名。
                 *
                 * 1.3.6 修 L-15 时加了两个条件，结果把「覆盖写」彻底变成了「每次新建」：
                 *   ① selection 里带 RELATIVE_PATH = "Download" ——
                 *      MediaStore 实际存的是 "Download/"（带结尾斜杠），
                 *      个别 ROM 还会存成子目录形态，等值比较直接命不中；
                 *   ② 只在 who != null 且等于本包名时才复用 ——
                 *      OWNER_PACKAGE_NAME 是 API 29 才引入的列，**大量 ROM 对自家
                 *      创建的文件也返回 null**，于是 existing 永远是 null。
                 * 两者任一成立 → 每次都 cr.insert() → MediaStore 遇同名自动改名
                 * Ripple-log (1).txt、(2).txt… → 真机上实测已积 32 份 Ripple-log、
                 * 32 份 Ripple-trace、101 份 Ripple-crash，日志彻底碎掉；
                 * 而 LogBridge 记下的展示路径还停在 "Download/Ripple-log.txt"，
                 * 设置页「查看日志」打开的还是个错误文件。
                 *
                 * 现在的判据：
                 *   · 只按 DISPLAY_NAME 查（同名候选，跨目录，由下面的 sameDir 再筛）；
                 *   · 逐条遍历而不是只看第一条 —— 公共下载目录里可能既有别人的
                 *     同名文件、又有我们自己上次留下的那份，取第一条会取错；
                 *   · sameDir = 该条目的 RELATIVE_PATH 归一后确实是下载目录根
                 *     （兼容带/不带结尾斜杠、大小写，以及 null）；
                 *   · owner 为 null（老系统 / ROM 不填）时**允许复用** ——
                 *     这是本次修复的关键：把 null 当成「可能是自己的」，
                 *     而不是当成「一定不是自己的」；
                 *   · owner 非空且不等于本包名 → 明确是别人的文件，跳过（L-15 的初衷）；
                 *   · 一个都命不中才 insert。
                 */
                final String owner = ctx.getPackageName();
                final String dir = Environment.DIRECTORY_DOWNLOADS;
                Cursor c = cr.query(MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                        new String[]{
                                MediaStore.MediaColumns._ID,
                                MediaStore.MediaColumns.RELATIVE_PATH,
                                MediaStore.MediaColumns.OWNER_PACKAGE_NAME},
                        MediaStore.MediaColumns.DISPLAY_NAME + "=?",
                        new String[]{name}, null);
                if (c != null) {
                    try {
                        while (c.moveToNext()) {
                            String rp = c.isNull(1) ? null : c.getString(1);
                            String who = c.isNull(2) ? null : c.getString(2);
                            if (!sameDir(rp, dir)) continue;
                            /* owner 为 null：老系统 / ROM 没填 → 可能是我们自己的，复用 */
                            if (who == null || who.equals(owner)) {
                                existing = ContentUris.withAppendedId(
                                        MediaStore.Downloads.EXTERNAL_CONTENT_URI, c.getLong(0));
                                break;
                            }
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

    /**
     * 判断一条 MediaStore 记录的 RELATIVE_PATH 是否就在「下载」目录根下。
     *
     * 为什么要写这段而不是直接字符串比较：RELATIVE_PATH 的落库形态并不统一 ——
     * 官方约定是目录名 + 结尾斜杠（"Download/"），但实测有 ROM 存成 "Download"，
     * 个别实现还会带上外置存储卷前缀。用等值比较就是 B-3 的直接诱因之一。
     *
     * 这里只认「就是下载目录根」这一种情况（排除 "Download/子目录/"），
     * 因为本类只往下载目录根写文件；归一后仍不同的交给调用方 insert 新条目。
     */
    private static boolean sameDir(String relativePath, String expectedDir) {
        if (relativePath == null || expectedDir == null) return false;
        String rp = relativePath.trim().replace('\\', '/');
        /* 先统一去掉首尾斜杠："Download/" / "/Download/" → "Download" */
        while (rp.endsWith("/")) rp = rp.substring(0, rp.length() - 1);
        while (rp.startsWith("/")) rp = rp.substring(1);
        /* 绝对形态（"storage/emulated/0/Download"）：只留最后一段再比 */
        if (rp.indexOf('/') >= 0) rp = rp.substring(rp.lastIndexOf('/') + 1);
        return rp.equalsIgnoreCase(expectedDir);
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
