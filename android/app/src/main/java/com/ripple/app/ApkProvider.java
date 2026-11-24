package com.ripple.app;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;

/**
 * 极简的文件共享 ContentProvider —— 用来把下载好的安装包交给系统安装器。
 *
 * ===== 为什么不用 androidx.core.content.FileProvider =====
 *
 * 本项目有一条硬约束：**不使用 AndroidX**（也不用 Gradle 拉依赖，
 * 构建脚本只用 SDK 自带的 aapt2 / javac / d8 / apksigner）。
 * AndroidX 的 FileProvider 用不了，而 Android 7.0（API 24）起
 * 已经禁止用 file:// 把文件跨应用传递（会抛 FileUriExposedException），
 * 所以必须自己实现一个最小可用的 ContentProvider。
 *
 * 实现范围刻意收窄到「只服务更新包」：
 *   · 只允许访问 cacheDir/update 目录下的文件，任何越界路径一律拒绝；
 *   · 只支持 open / query（安装器要读文件内容和文件大小、名字）；
 *   · 不支持增删改 —— 返回 false / null，没有可被滥用的写入口。
 *
 * 这样做而不是直接放行整个目录，是因为 ContentProvider 一旦授权出去，
 * 任何拿到 content:// 的组件都能读取。把可见面压到最小是最省心的做法。
 */
public class ApkProvider extends ContentProvider {

    /** 与 AndroidManifest 里 android:authorities 必须完全一致 */
    public static final String AUTHORITY = "com.ripple.app.updates";

    private static final String PATH = "update";

    /**
     * 为一个文件生成 content:// URI。
     *
     * @param ctx  任意 Context（内部会取 ApplicationContext）
     * @param file 必须是 cacheDir/update 下的文件
     */
    static Uri uriFor(Context ctx, File file) {
        return new Uri.Builder()
                .scheme("content")
                .authority(AUTHORITY)
                .appendPath(PATH)
                .appendPath(file.getName())
                .build();
    }

    /** 把 URI 还原成文件；文件名里带路径分隔符或 `..` 一律拒绝 */
    private File resolve(Uri uri) throws FileNotFoundException {
        if (uri == null || !AUTHORITY.equals(uri.getAuthority())) {
            throw new FileNotFoundException("authority 不匹配");
        }
        java.util.List<String> seg = uri.getPathSegments();
        if (seg == null || seg.size() != 2 || !PATH.equals(seg.get(0))) {
            throw new FileNotFoundException("路径形状非法");
        }
        String name = seg.get(1);
        /*
         * 关键的安全检查：文件名来自 URI，而 URI 可能由别的应用构造。
         * 若不做这一步，`../../shared_prefs/xxx.xml` 就能读到应用私有数据。
         * 这里只接受「纯文件名」：不含分隔符、不含 ..、非空。
         */
        if (name.isEmpty()
                || name.contains("/")
                || name.contains("\\")
                || name.contains("..")
                || name.startsWith(".")) {
            throw new FileNotFoundException("文件名非法");
        }
        Context ctx = getContext();
        if (ctx == null) throw new FileNotFoundException("no context");
        File dir = new File(ctx.getApplicationContext().getCacheDir(), "update");
        File f = new File(dir, name);
        /*
         * 再做一次规范化校验：确认解析出来的绝对路径**确实在**那个目录里。
         * 上面的字符检查已经挡住了常见穿越，但绝对路径比较是没有争议的兜底。
         */
        try {
            if (!f.getCanonicalPath().startsWith(dir.getCanonicalPath() + File.separator)) {
                throw new FileNotFoundException("越界路径");
            }
        } catch (java.io.IOException e) {
            throw new FileNotFoundException("路径解析失败");
        }
        if (!f.isFile()) throw new FileNotFoundException("文件不存在");
        return f;
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        /*
         * 只允许读。安装器只需要读，写没有正当理由 ——
         * 拒绝写可以把「别的应用改写我们的安装包」这条路直接堵掉。
         */
        if (mode != null && (mode.contains("w") || mode.contains("a"))) {
            throw new FileNotFoundException("只读");
        }
        File f = resolve(uri);
        return ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY);
    }

    /**
     * 安装器会查这两个列来显示文件名和大小。
     *
     * 没有实现 query 的话，部分 ROM 的安装器会拿不到 DISPLAY_NAME，
     * 界面上显示成一串乱码或空白，用户会怀疑文件坏了。
     */
    @Override
    public Cursor query(Uri uri, String[] projection, String selection,
                        String[] selectionArgs, String sortOrder) {
        File f;
        try {
            f = resolve(uri);
        } catch (FileNotFoundException e) {
            return null;
        }
        String[] cols = projection != null ? projection
                : new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE};
        MatrixCursor c = new MatrixCursor(cols, 1);
        Object[] row = new Object[cols.length];
        for (int i = 0; i < cols.length; i++) {
            if (OpenableColumns.DISPLAY_NAME.equals(cols[i])) {
                row[i] = f.getName();
            } else if (OpenableColumns.SIZE.equals(cols[i])) {
                row[i] = f.length();
            } else {
                row[i] = null;
            }
        }
        c.addRow(row);
        return c;
    }

    @Override
    public String getType(Uri uri) {
        /*
         * 统一返回 APK 的 MIME。
         *
         * 为什么不做按扩展名判断：这个 provider 只服务更新包，
         * 返回安装包的 MIME 才能让安装器正确识别并直接弹出安装界面。
         * 返回 application/octet-stream 的话，系统只会问「用什么打开」。
         */
        return "application/vnd.android.package-archive";
    }

    /* ===== 下面三个是 ContentProvider 的必需实现，这里全部拒绝写入 ===== */

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        return null;
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        return 0;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        return 0;
    }
}
