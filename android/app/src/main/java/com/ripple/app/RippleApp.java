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
    private static final String FALLBACK_VERSION_TAG = "version=1.3.6(136)";

    @Override
    public void onCreate() {
        super.onCreate();
        /*
         * 1.3.5 多语言：尽可能早地把原生层语言读回来。
         *
         * 放在 onCreate 最前面（连启动日志都还没写）是因为崩溃兜底页 showFatal
         * 和通知渠道都在后面的路径上，越早恢复语言，「界面还没出来就崩」时
         * 那句标题也才是用户上次选的语言。读盘失败会被 init 内部吞掉，不影响启动。
         */
        L10n.init(this);
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
        /*
         * 审查 AND-05：readPreviousExit 必须离开主线程。
         *
         * 它会遍历最多 5 份进程 trace，每份都用 getTraceInputStream() 读到 EOF
         * 且**没有任何长度上限** —— 单份可达 MB 级，五份就是几 MB 的同步 IO
         * 全压在 Application.onCreate 上，直接拖慢冷启动（用户感知是「点开图标
         * 后卡一下才出画面」）。J-01/J-05 当初只把**写盘**挪到后台了，
         * 读盘留在主线程而且更重 —— 同一类问题换了个入口复发。
         *
         * 这份数据只是「上次怎么死的」的取证信息，迟到几百毫秒完全无害，
         * 所以直接丢给后台单线程。
         */
        new Thread(() -> {
            try {
                readPreviousExit(getApplicationContext());
            } catch (Throwable ignored) {
            }
        }, "ripple-exit-read").start();

        /*
         * 崩溃自保护：连续多次「没走到前台就重启」才关掉 edge-to-edge。
         *
         * 这里原来是 streak >= 1，等于「只要重启过一次就永久降级」——
         * 而清零逻辑挂在 MainActivity.onPageFinished 之后（见 scheduleBootStreakClear：
         * 页面加载完成再等 BOOT_OK_DELAY_MS = 5 秒，期间没有再次重建才算这次启动成功），
         * 用户如果在那之前退出（试完就关、切走再回、点错就退），
         * streak 永远清不掉，于是**下次启动又进 safeMode**，越用越容易中。
         *
         * 症状很有辨识度：视口变矮约 60px、状态栏不被背景覆盖、
         * 整个页面下移、顶部内容被压在状态栏下方。
         *
         * 改成 3 次：真的连续崩 3 次才降级，偶发退出不受影响。
         * 清零时机也从「建 WebView 就清」挪到了「onPageFinished + 5 秒无重建」——
         * 典型故障恰好发生在建 WebView 之后，清早了 safeMode 就永远不生效。
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
     * 运行时版本标记（"version=1.3.6(136)" 这种形状）。
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
                        /*
                         * 审查 AND-05：单份 trace 限 256KB。
                         * 以前读到 EOF 不限长度，单份可达 MB 级 —— 取证只需要
                         * 调用栈，不需要整个堆转储，256KB 足够放几千帧。
                         */
                        final int MAX_TRACE_BYTES = 256 * 1024;
                        java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
                        byte[] buf = new byte[4096];
                        int total = 0;
                        int n;
                        while (total < MAX_TRACE_BYTES && (n = in.read(buf)) > 0) {
                            int take = Math.min(n, MAX_TRACE_BYTES - total);
                            bos.write(buf, 0, take);
                            total += take;
                        }
                        in.close();
                        sb.append(bos.toString("UTF-8"));
                        if (total >= MAX_TRACE_BYTES) sb.append("\n…（trace 已截断于 ")
                                .append(MAX_TRACE_BYTES / 1024).append("KB）");
                        sb.append('\n');
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
