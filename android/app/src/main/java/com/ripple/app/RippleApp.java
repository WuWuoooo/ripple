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

    @Override
    public void onCreate() {
        super.onCreate();
        LogBridge.add(this, "APP", "onCreate start, sdk=" + Build.VERSION.SDK_INT
                + " " + Build.MANUFACTURER + " " + Build.MODEL
                + " version=1.1.0(110)");
        CrashLog.installQuietly(this);
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
                CrashLog.recordRaw(ctx, "exit-info", sb.toString());
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
