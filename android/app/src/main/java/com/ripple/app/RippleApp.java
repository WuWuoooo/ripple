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
                + " version=1.0.0(100)");
        CrashLog.installQuietly(this);
        readPreviousExit(this);

        // 连续两次没走到前台就重启 → 关掉边缘到边缘和 inset 注入（保守模式）
        try {
            android.content.SharedPreferences sp = getSharedPreferences(SP, Context.MODE_PRIVATE);
            int streak = sp.getInt(KEY_BOOT_STREAK, 0);
            sp.edit().putInt(KEY_BOOT_STREAK, streak + 1).apply();
            StrictModes.safeMode = streak >= 1;
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
