package com.ripple.app;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 检查更新 / 下载安装包 / 拉起系统安装器。
 *
 * ===== 为什么不做「热更新」而是直接下 APK =====
 *
 * 曾经考虑过「只更新 assets/www 里的 HTML/CSS/JS，运行时重启生效」——
 * 技术上可行（本项目无 Gradle、无打包器，资源天然可替换）。
 * 但 APK 本体只有 0.6 MB，用户下载一次就完了，
 * 而热更新要引入「可写目录 + 清单签名 + 原子切换 + 自动回滚」一整套机制，
 * 复杂度和风险远高于它省下的那 0.6 MB。所以选择直接下发安装包。
 *
 * ===== 设计要点 =====
 *
 * ① **全部在后台线程跑**：检查更新是网络请求，绝不能碰 UI 线程，
 *    也不能因为 GitHub 慢就拖慢 App 启动。结果通过 Handler 回主线程。
 *
 * ② **6 小时节流**：GitHub 对未认证请求限流 60 次/小时/IP。
 *    每次冷启动都查会很快把额度烧掉（尤其用户频繁切换）。
 *    用 SharedPreferences 记上次检查时间，6 小时内直接跳过。
 *    设置页手动点「检查更新」不受此限制（用户主动要求，必须真查）。
 *
 * ③ **只认 Release 里的确切资产名**：不按「最新文件」或通配符猜，
 *    避免把别的平台包/别的分支产物下进来。
 *
 * ④ **下载后校验大小**：GitHub 给了 `size` 字段，下完必须一致。
 *    这一步不能省 —— 弱网下截断的 APK 装上去会直接崩，
 *    而用户只会觉得「更新完就坏了」。
 */
final class UpdateChecker {

    /** GitHub 仓库坐标，与 README / Release 链接保持一致 */
    private static final String REPO = "WuWuoooo/ripple";
    private static final String API_LATEST =
            "https://api.github.com/repos/" + REPO + "/releases/latest";

    /** 自动检查的节流窗口：6 小时。用户手动点不受限。 */
    private static final long AUTO_CHECK_INTERVAL_MS = 6L * 60 * 60 * 1000;

    private static final String PREF = "ripple";
    private static final String KEY_LAST_CHECK = "update_last_check";

    /** 单线程足够：检查与下载不会并发进行（用户点下载时不会再点第二次） */
    private static final ExecutorService IO = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "ripple-update");
        t.setDaemon(true);
        return t;
    });

    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    private UpdateChecker() {
    }

    /** 检查结果回调（都在主线程触发） */
    interface ResultCb {
        /**
         * @param hasNew   是否有新版本
         * @param version  远端版本名（如 "1.3.5"）
         * @param code     远端 versionCode（拿不到时给 0）
         * @param notes    Release 正文摘要（可能为空）
         * @param apkUrl   对应平台的安装包下载地址（拿不到时为 null）
         * @param size     安装包字节数（拿不到时给 0）
         * @param error    出错信息；成功时为 null
         */
        void onResult(boolean hasNew, String version, int code, String notes,
                      String apkUrl, long size, String error);
    }

    /** 下载进度 / 完成回调（都在主线程触发） */
    interface DownloadCb {
        void onProgress(int percent);
        void onDone(File file);
        void onError(String msg);
    }

    /**
     * 当前 App 的 versionCode。
     *
     * 从 PackageManager 读，而不是从 assets 的 version.js 读 ——
     * 前者是**安装包真实身份**，后者只是个资源文件，理论上可能不同步。
     * 判断「要不要更新」必须用前者。
     */
    static int currentCode(Context ctx) {
        try {
            return ctx.getPackageManager()
                    .getPackageInfo(ctx.getPackageName(), 0).versionCode;
        } catch (Throwable e) {
            return 0;
        }
    }

    static String currentName(Context ctx) {
        try {
            return ctx.getPackageManager()
                    .getPackageInfo(ctx.getPackageName(), 0).versionName;
        } catch (Throwable e) {
            return "";
        }
    }

    /**
     * 检查更新。
     *
     * @param manual true = 用户在设置页主动点的，不受 6 小时节流限制
     */
    static void check(final Context ctx, final boolean manual, final ResultCb cb) {
        final Context app = ctx.getApplicationContext();
        IO.execute(() -> {
            final ResultCb safeCb = wrap(cb);
            try {
                if (!manual) {
                    long last = app.getSharedPreferences(PREF, Context.MODE_PRIVATE)
                            .getLong(KEY_LAST_CHECK, 0L);
                    long now = System.currentTimeMillis();
                    if (last > 0 && now - last < AUTO_CHECK_INTERVAL_MS) {
                        long leftH = (AUTO_CHECK_INTERVAL_MS - (now - last)) / 3600000L + 1;
                        safeCb.onResult(false, "", 0, null, null, 0,
                                "throttled:" + leftH);
                        return;
                    }
                }
                /* 先记时间再请求：即使这次请求失败，也不该在 6 小时内反复重试
                   （失败多半是网络问题，立刻重试只会继续失败并烧额度）。 */
                app.getSharedPreferences(PREF, Context.MODE_PRIVATE)
                        .edit().putLong(KEY_LAST_CHECK, System.currentTimeMillis()).apply();

                JSONObject rel = fetchJson(API_LATEST);
                String tag = rel.optString("tag_name", "");
                String name = rel.optString("name", tag);
                /* tag 形如 v1.3.5；versionName 想要的是 1.3.5 */
                String ver = tag.startsWith("v") ? tag.substring(1) : tag;
                if (ver.isEmpty()) ver = name;
                String body = rel.optString("body", "");

                int remoteCode = parseCodeFromBody(body);

                /*
                 * 选安装包：只认 Android 的 .apk。
                 *
                 * ⚠️ 不能用「第一个资产」或「名字包含 Ripple」这种模糊判断 ——
                 * Release 里同时有 .deb / .AppImage / .zip / .exe，
                 * 下错一个就是「更新完打不开」。
                 */
                String apkUrl = null;
                long apkSize = 0;
                JSONArray assets = rel.optJSONArray("assets");
                if (assets != null) {
                    for (int i = 0; i < assets.length(); i++) {
                        JSONObject a = assets.optJSONObject(i);
                        if (a == null) continue;
                        String n = a.optString("name", "");
                        if (n.toLowerCase(Locale.US).endsWith(".apk")) {
                            apkUrl = a.optString("browser_download_url", null);
                            apkSize = a.optLong("size", 0);
                            break;
                        }
                    }
                }

                int cur = currentCode(app);
                /* 远端 code 拿不到时退化成「版本名不同就当有更新」，
                   这是保守方向：宁可多提示一次，也不要让用户永远收不到更新。 */
                boolean hasNew = remoteCode > 0
                        ? remoteCode > cur
                        : (!ver.isEmpty() && !ver.equals(currentName(app)));

                LogBridge.add(app, "UPDATE",
                        "check: cur=" + cur + " remote=" + ver + "(" + remoteCode + ")"
                                + " hasNew=" + hasNew + " apk=" + (apkUrl != null));
                safeCb.onResult(hasNew, ver, remoteCode, body, apkUrl, apkSize, null);
            } catch (Throwable e) {
                LogBridge.add(app, "UPDATE", "check failed: " + e);
                safeCb.onResult(false, "", 0, null, null, 0, String.valueOf(e));
            }
        });
    }

    /**
     * 从 Release 正文里找 versionCode。
     *
     * 为什么需要它：GitHub Release API **不提供** versionCode，
     * 那只存在于 APK 内部。而「哪个版本更新」必须按整数比，
     * 按版本名字符串比会在 1.3.10 vs 1.3.9 上判错。
     *
     * 所以让 CI 在正文里带一行机器可读的标记，这里解析它。
     * 找不到就返回 0，调用方退化到版本名比较。
     */
    private static int parseCodeFromBody(String body) {
        if (body == null || body.isEmpty()) return 0;
        /* 期望格式：<!-- ripple-version-code: 135 --> */
        try {
            int i = body.indexOf("ripple-version-code:");
            if (i < 0) return 0;
            int j = i + "ripple-version-code:".length();
            StringBuilder sb = new StringBuilder();
            for (int k = j; k < body.length() && sb.length() < 12; k++) {
                char c = body.charAt(k);
                if (c >= '0' && c <= '9') sb.append(c);
                else if (sb.length() > 0) break;
            }
            return sb.length() == 0 ? 0 : Integer.parseInt(sb.toString());
        } catch (Throwable e) {
            return 0;
        }
    }

    /**
     * 下载安装包到应用专属的 cache 目录。
     *
     * 为什么不用公共 Download 目录：从 Android 10 起写公共目录要走 MediaStore，
     * 而 APK 不在 MediaStore 允许的类型里 —— 硬写会失败或被系统清理。
     * 应用 cache 目录配合 FileProvider 授权给安装器，是最稳的路径。
     */
    static void download(final Context ctx, final String url, final long expectSize,
                         final String version, final DownloadCb cb) {
        final Context app = ctx.getApplicationContext();
        IO.execute(() -> {
            HttpURLConnection c = null;
            InputStream in = null;
            FileOutputStream out = null;
            try {
                File dir = new File(app.getCacheDir(), "update");
                if (!dir.exists() && !dir.mkdirs()) {
                    // 1.3.5 多语言：这句会通过 onError 一路显示到前端弹窗上
                    throw new java.io.IOException(L10n.t("无法创建更新目录",
                            "Cannot create the update folder"));
                }
                /* 先清掉旧包：避免磁盘里堆一堆历史版本，
                   也避免 FileProvider 授权到过期文件。 */
                File[] olds = dir.listFiles();
                if (olds != null) {
                    for (File f : olds) {
                        //noinspection ResultOfMethodCallIgnored
                        f.delete();
                    }
                }
                File dst = new File(dir, "Ripple-" + version + ".apk");

                URL u = new URL(url);
                c = (HttpURLConnection) u.openConnection();
                c.setConnectTimeout(15000);
                c.setReadTimeout(30000);
                c.setInstanceFollowRedirects(true);
                /*
                 * GitHub 的下载地址会 302 到 objects.githubusercontent.com。
                 * 手动跟一次，否则某些网络环境下拿到的是空响应。
                 */
                c.setRequestProperty("Accept", "*/*");
                c.setRequestProperty("User-Agent", "Ripple-Android");
                int code = c.getResponseCode();
                if (code == 301 || code == 302 || code == 307 || code == 308) {
                    String loc = c.getHeaderField("Location");
                    if (loc != null && !loc.isEmpty()) {
                        c.disconnect();
                        c = (HttpURLConnection) new URL(loc).openConnection();
                        c.setConnectTimeout(15000);
                        c.setReadTimeout(30000);
                        c.setRequestProperty("User-Agent", "Ripple-Android");
                        code = c.getResponseCode();
                    }
                }
                if (code != 200) throw new java.io.IOException("HTTP " + code);

                final long total = c.getContentLength() > 0 ? c.getContentLength() : expectSize;
                in = c.getInputStream();
                out = new FileOutputStream(dst);
                byte[] buf = new byte[8192];
                long got = 0;
                int lastPct = -1;
                int n;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                    got += n;
                    if (total > 0) {
                        final int pct = (int) (got * 100 / total);
                        if (pct != lastPct && pct % 2 == 0) {
                            lastPct = pct;
                            MAIN.post(() -> wrapDl(cb).onProgress(pct));
                        }
                    }
                }
                out.flush();
                out.close();
                out = null;
                in.close();
                in = null;

                /*
                 * 大小校验：弱网下截断的 APK 装上去会直接崩，
                 * 而用户只会觉得「更新完就坏了」。这一步不能省。
                 *
                 * H-15：错误文案里的字节数**必须用删除之前的真实值**。
                 * 以前写的是 dst.length() != expectSize → delete() → 文案里
                 * 再读一次 dst.length()，而 File.length() 对已删除的文件返回 0 ——
                 * 用户看到的永远是「下载不完整（0/12345678 字节）」，
                 * 「实际收到多少」这个唯一有用的诊断信息被代码自己抹掉了。
                 * 这个 bug 从 1.3.4 就在，1.3.5 只在外面套了 L10n.t 没修根因。
                 *
                 * 这里直接用循环里累计的 got（实际写进文件的字节数）——
                 * 它比 dst.length() 更准：既反映真实收到量，又不依赖文件系统
                 * 在这一刻把数据刷到磁盘（fuse / 某些 ROM 上 length 可能滞后）。
                 */
                if (expectSize > 0 && got != expectSize) {
                    //noinspection ResultOfMethodCallIgnored
                    dst.delete();
                    /*
                     * 1.3.5 多语言：这两句会经 onError 原样显示到前端弹窗，
                     * 是用户真正会读到的错误文案，所以随语言走。
                     * 数字和单位保持阿拉伯数字，中英两版都读得通。
                     */
                    throw new java.io.IOException(L10n.t(
                            "下载不完整（" + got + "/" + expectSize + " 字节）",
                            "Download incomplete (" + got + "/" + expectSize + " bytes)"));
                }
                /* 至少得比一个正常 APK 大，防止下到错误页面（比如 HTML 错误页） */
                if (dst.length() < 100 * 1024) {
                    long len = dst.length();
                    //noinspection ResultOfMethodCallIgnored
                    dst.delete();
                    throw new java.io.IOException(L10n.t(
                            "下载内容异常（" + len + " 字节，不是安装包）",
                            "Invalid download (" + len + " bytes, not an APK)"));
                }

                LogBridge.add(app, "UPDATE", "download ok: " + dst.getName()
                        + " " + dst.length() + " bytes");
                final File ok = dst;
                MAIN.post(() -> wrapDl(cb).onDone(ok));
            } catch (Throwable e) {
                LogBridge.add(app, "UPDATE", "download failed: " + e);
                final String msg = String.valueOf(e.getMessage());
                MAIN.post(() -> wrapDl(cb).onError(msg));
            } finally {
                try { if (out != null) out.close(); } catch (Throwable ignored) {}
                try { if (in != null) in.close(); } catch (Throwable ignored) {}
                try { if (c != null) c.disconnect(); } catch (Throwable ignored) {}
            }
        });
    }

    /**
     * 拉起系统安装器。
     *
     * 需要两样东西，缺一样都会失败：
     *   ① AndroidManifest 里声明 REQUEST_INSTALL_PACKAGES 权限；
     *   ② FileProvider 把 cache/update 下的 APK 通过 content:// 授权出去
     *      —— Android 7.0 起 file:// 不能跨应用传递文件了。
     *
     * Android 8.0 起还要用户在系统设置里给本应用「安装未知应用」的权限，
     * 这里会先检查，没有就跳转设置页并提示。
     */
    static void install(Activity act, File apk) {
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                boolean allowed = act.getPackageManager().canRequestPackageInstalls();
                if (!allowed) {
                    /*
                     * 没有权限时不能直接弹安装器（会被系统静默拒绝，
                     * 用户只会觉得「点了没反应」）。跳去设置页，
                     * 让用户自己开这个开关，回来再点一次安装。
                     */
                    try {
                        Intent i = new Intent(
                                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                                Uri.parse("package:" + act.getPackageName()));
                        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        act.startActivity(i);
                        LogBridge.add(act, "UPDATE", "需要「安装未知应用」权限，已跳转设置页");
                        MAIN.post(() -> {
                            try {
                                android.widget.Toast.makeText(act,
                                        /*
                                         * 1.3.5 多语言：这条是「跳去设置页之后」唯一的引导文字，
                                         * 用户如果看不懂就永远装不上更新。
                                         */
                                        L10n.t("请允许「安装未知应用」，返回后再点一次安装",
                                                "Please allow \"Install unknown apps\", then tap Install again"),
                                        android.widget.Toast.LENGTH_LONG).show();
                            } catch (Throwable ignored) {}
                        });
                    } catch (Throwable e) {
                        LogBridge.add(act, "UPDATE", "跳转安装权限页失败: " + e);
                    }
                    return;
                }
            }
            Uri uri = ApkProvider.uriFor(act, apk);
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(uri, "application/vnd.android.package-archive");
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            act.startActivity(i);
            LogBridge.add(act, "UPDATE", "已拉起系统安装器: " + apk.getName());
        } catch (Throwable e) {
            LogBridge.add(act, "UPDATE", "install failed: " + e);
            MAIN.post(() -> {
                try {
                    // 1.3.5 多语言：安装器没拉起来时的兜底 Toast（e.getMessage() 是系统原话，不翻）
                    android.widget.Toast.makeText(act,
                            L10n.t("拉起安装器失败：", "Failed to open the installer: ") + e.getMessage(),
                            android.widget.Toast.LENGTH_LONG).show();
                } catch (Throwable ignored) {}
            });
        }
    }

    /** 把文件打开（桌面端用：Windows 的 setup.exe / Linux 的 AppImage） */
    static void openFile(Activity act, File f) {
        try {
            Uri uri = ApkProvider.uriFor(act, f);
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(uri, "application/octet-stream");
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            act.startActivity(i);
        } catch (Throwable e) {
            LogBridge.add(act, "UPDATE", "openFile failed: " + e);
        }
    }

    /* ================= 内部工具 ================= */

    private static JSONObject fetchJson(String urlStr) throws Exception {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(urlStr).openConnection();
            c.setConnectTimeout(12000);
            c.setReadTimeout(12000);
            /*
             * GitHub API 强制要求 User-Agent，缺了会 403。
             * Accept 指定 v3 json 是为了拿到稳定结构（GitHub 未来可能默认 v4）。
             */
            c.setRequestProperty("User-Agent", "Ripple-Android/" + "update-check");
            c.setRequestProperty("Accept", "application/vnd.github+json");
            int code = c.getResponseCode();
            if (code != 200) {
                /*
                 * 403 多半是限流，把剩余额度打出来 —— 用户反馈「检查更新一直失败」时，
                 * 有这一行就能立刻判断是限流还是网络问题。
                 */
                String remain = c.getHeaderField("X-RateLimit-Remaining");
                // 1.3.5 多语言：这个 error 串会被前端原样显示出来，所以括号里那句也翻
                throw new java.io.IOException("HTTP " + code
                        + (remain != null
                        ? L10n.t("（剩余额度 " + remain + "）", " (rate limit remaining: " + remain + ")")
                        : ""));
            }
            StringBuilder sb = new StringBuilder();
            try (BufferedReader r = new BufferedReader(
                    new InputStreamReader(c.getInputStream(), "UTF-8"))) {
                String line;
                while ((line = r.readLine()) != null) sb.append(line);
            }
            return new JSONObject(sb.toString());
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static ResultCb wrap(final ResultCb cb) {
        return (a, b, c, d, e, f, g) -> MAIN.post(() -> {
            try { cb.onResult(a, b, c, d, e, f, g); } catch (Throwable ignored) {}
        });
    }

    private static DownloadCb wrapDl(final DownloadCb cb) {
        return new DownloadCb() {
            @Override public void onProgress(int percent) {
                try { cb.onProgress(percent); } catch (Throwable ignored) {}
            }
            @Override public void onDone(File file) {
                try { cb.onDone(file); } catch (Throwable ignored) {}
            }
            @Override public void onError(String msg) {
                try { cb.onError(msg); } catch (Throwable ignored) {}
            }
        };
    }

    /** 计算文件 SHA-256（诊断用；安装包完整性主要靠大小校验） */
    static String sha256(File f) {
        try (InputStream in = new java.io.FileInputStream(f)) {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
            StringBuilder sb = new StringBuilder();
            for (byte b : md.digest()) sb.append(String.format(Locale.US, "%02x", b));
            return sb.toString();
        } catch (Throwable e) {
            return "";
        }
    }
}
