package com.ripple.app;

import android.app.Application;
import android.app.ApplicationExitInfo;
import android.content.Context;
import android.os.Build;

import java.io.InputStream;
import java.util.List;

/**
 * 进程级崩溃取证。必须最早安装：Application 比 Activity 先跑，
 * 能抓到 "界面还没出来就崩" 的那一类错误（例如 WebView 初始化失败、dex 缺失）。
 */
public class RippleApp extends Application {

    private static final String SP = "ripple";
    private static final String KEY_BOOT_STREAK = "boot_streak";

    /**
     * 启动日志里的版本号回落值。
     *
     * 形状必须保持 `version=x.y.z(NNN)` 这一串：android/sync-version.sh 用 sed
     * 同步它、CI 用 grep -F 校验它，改成别的写法会让构建直接失败。
     * 正常路径下不起作用 —— 版本号优先从 PackageManager 读（J-04），
     * 免得有人绕开 build-apk.sh 手改版本后，日志里报的还是旧版本。
     */
    private static final String FALLBACK_VERSION_TAG = "version=1.2.2(122)";

    @Override
    public void onCreate() {
        super.onCreate();
        LogBridge.add(this, "APP", "onCreate start, sdk=" + Build.VERSION.SDK_INT
                + " " + Build.MANUFACTURER + " " + Build.MODEL
                + " " + versionTag(this));
        /*
         * 崩溃捕获只在这里装一次（传 Application Context）。
         * 以前 MainActivity 也调了一遍，形成链式 handler：同一次崩溃写两份文件，
         * 而且第一次调用带的是 Activity —— 静态字段里留住了整个界面。
         * installQuietly 内部也有幂等标记，两处都调也只会生效一次。
         */
        CrashLog.installQuietly(getApplicationContext());
        readPreviousExit(this);

        /*
         * 崩溃自保护：连续多次「没走到前台就重启」才关掉 edge-to-edge。
         *
         * 这里原来是 streak >= 1，等于「只要重启过一次就永久降级」——
         * 而清零逻辑挂在 MainActivity 的 pageLoaded 回调里（延迟 2.6 秒），
         * 用户如果在 2.6 秒内退出（试完就关、切走再回、点错就退），
         * streak 永远清不掉，于是**下次启动又进 safeMode**，越用越容易中。
         *
         * 症状很有辨识度：视口变矮约 60px、状态栏不被背景覆盖、
         * 整个页面下移、顶部内容被压在状态栏下方。
         *
         * 改成 3 次：真的连续崩 3 次才降级，偶发退出不受影响。
         * 同时把「清零」也提前到 onCreate 之后只要没崩就清（见 MainActivity）。
         */
        try {
            android.content.SharedPreferences sp = getSharedPreferences(SP, Context.MODE_PRIVATE);
            int streak = sp.getInt(KEY_BOOT_STREAK, 0);
            sp.edit().putInt(KEY_BOOT_STREAK, streak + 1).apply();
            StrictModes.safeMode = streak >= 3;
            if (StrictModes.safeMode) {
                LogBridge.add(this, "APP", "safeMode ON (streak=" + streak + ")，已关闭 edge-to-edge");
            }
        } catch (Throwable ignored) {
        }
    }

    /**
     * 运行时版本标记（"version=1.2.2(122)" 这种形状）。
     * 读不到时回落 FALLBACK_VERSION_TAG；任何异常都不能冒出去 ——
     * 这行日志是启动取证的一部分，不能反过来把启动搞挂。
     */
    private static String versionTag(Context ctx) {
        try {
            android.content.pm.PackageInfo pi =
                    ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0);
            String name = pi.versionName == null ? "" : pi.versionName;
            if (name.isEmpty()) return FALLBACK_VERSION_TAG;
            int code = Build.VERSION.SDK_INT >= 28
                    ? (int) pi.getLongVersionCode() : pi.versionCode;
            return "version=" + name + "(" + code + ")";
        } catch (Throwable e) {
            return FALLBACK_VERSION_TAG;
        }
    }

    /** 上一次进程是怎么死的（Android 11+ 可直接读真实死因，含 native crash/ANR/信号） */
    static void readPreviousExit(Context ctx) {
        if (Build.VERSION.SDK_INT < 30) return;
        try {
            android.app.ActivityManager am =
                    (android.app.ActivityManager) ctx.getSystemService(Context.ACTIVITY_SERVICE);
            if (am == null) return;
            List<ApplicationExitInfo> list =
                    am.getHistoricalProcessExitReasons(ctx.getPackageName(), 0, 5);
            if (list == null) return;
            StringBuilder sb = new StringBuilder();
            for (ApplicationExitInfo info : list) {
                int reason = info.getReason();
                if (reason == ApplicationExitInfo.REASON_EXIT_SELF
                        || reason == ApplicationExitInfo.REASON_USER_REQUESTED) continue;
                sb.append("== exit info ==\n")
                        .append("reason: ").append(reasonName(reason)).append('\n')
                        .append("status: ").append(info.getStatus()).append('\n')
                        .append("description: ").append(info.getDescription()).append('\n')
                        .append("timestamp: ").append(info.getTimestamp()).append('\n');
                try {
                    InputStream in = info.getTraceInputStream();
                    if (in != null) {
                        java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
                        byte[] buf = new byte[4096];
                        int n;
                        while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
                        in.close();
                        sb.append(bos.toString("UTF-8")).append('\n');
                    }
                } catch (Throwable ignored) {
                }
                sb.append('\n');
            }
            if (sb.length() > 0) {
                /*
                 * 固定文件名覆盖写（Ripple-exit-info.txt）。
                 * 以前这条走的是「每次新建一个带秒级时间戳的 crash 文件」那条路：
                 * LMK/厂商清理每杀一次就多一份，用得久了下载目录全是它。
                 * 这类「上次退出原因」只需要最新一次。
                 */
                CrashLog.recordExitInfo(ctx, sb.toString());
            }
        } catch (Throwable ignored) {
        }
    }

    private static String reasonName(int reason) {
        switch (reason) {
            case ApplicationExitInfo.REASON_CRASH: return "CRASH";
            case ApplicationExitInfo.REASON_CRASH_NATIVE: return "CRASH_NATIVE";
            case ApplicationExitInfo.REASON_ANR: return "ANR";
            case ApplicationExitInfo.REASON_SIGNALED: return "SIGNALED";
            case ApplicationExitInfo.REASON_LOW_MEMORY: return "LOW_MEMORY";
            case ApplicationExitInfo.REASON_INITIALIZATION_FAILURE: return "INIT_FAILURE";
            case ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE: return "RESOURCE";
            case ApplicationExitInfo.REASON_OTHER: return "OTHER";
            default: return "reason#" + reason;
        }
    }
}
