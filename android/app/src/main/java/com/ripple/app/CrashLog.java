package com.ripple.app;

import android.content.Context;
import android.os.Build;

import java.io.File;
import java.io.FileOutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.text.SimpleDateFormat;
import java.util.Arrays;
import java.util.Comparator;
import java.util.Date;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

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
 *
 * 文件策略（以前会无限增长）：
 *   · 「上次退出原因」这类**不是崩溃**的取证，固定文件名覆盖写（Ripple-exit-info.txt）；
 *     私有目录那份同样走固定名（exit-info-latest.txt / trace-latest.txt）——
 *     这两个是高频 tag，用时间戳命名会把崩溃文件的保留配额刷满（J-11）
 *   · 真正的崩溃保留最近 MAX_CRASH_FILES 份，超出按文件名（含时间戳）删最老的
 *
 * 线程模型（J-01）：
 *   · 常规轨迹（step）、退出取证（recordExitInfo）与**非崩溃的错误日志**（recordAsync）
 *     的落盘丢给后台单线程 —— 它们会在主线程被调用（MainActivity.onCreate、
 *     PlaybackService 的回调），一次写盘是 MediaStore 查询 + 跨进程 openOutputStream，
 *     不能挡在首帧或 UI 交互前面。
 *   · 崩溃路径（record / flushTrace）**同步**写：进程马上就要被系统杀掉，
 *     排进队列的任务可能永远不执行，宁可多花几毫秒也要把证据落下来。
 */
final class CrashLog {

    private static final Object LOCK = new Object();

    /*
     * 轨迹落盘的节流参数。
     * 以前每一步都 writeDownloads()：MediaStore 查询 + openOutputStream 全量重写，
     * 而 MainActivity.onCreate 里就有十来次 step，冷启动光在写文件上就跨进程好几趟。
     * 现在内存里照常累积，只在「攒够 8 步」或「距上次落盘超过 5 秒」时才排一次落盘；
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

    /** 崩溃文件保留份数：只留最近这么多份，避免下载目录被历史崩溃刷爆 */
    private static final int MAX_CRASH_FILES = 10;
    /**
     * 审查 AND-04：非崩溃错误日志用**独立前缀与独立配额**。
     *
     * 以前 recordAsync（35 个真实调用点：LyricOverlay 9 + MainActivity 19 +
     * PlaybackService 7）走的是同一个 writePrivate，生成的都是 crash-*.txt，
     * 与真崩溃共用 MAX_CRASH_FILES=10 的淘汰配额。
     * 故障期一秒钟就能刷出几十条错误 → 配额几秒被填满 →
     * **最早那份真正的 uncaught- 崩溃报告被删掉**，而这恰恰是最有价值的证据。
     *
     * 现在错误日志用 err- 前缀、独立保留 ERR_KEEP_FILES 份，
     * 两套配额互不侵占；崩溃文件永远留着。
     *
     * H-16：**下载目录那份当时没跟着改**（这一版补上）。
     * 下载目录里错误日志与真崩溃共用 "Ripple-crash-" 前缀和同一个 10 份配额，
     * 而下载目录才是用户/排查者真正翻得到的那份（/sdcard/Download 直接可见）——
     * 一次歌词浮层的持续报错就能把真崩溃现场挤出去。
     * 现在下载目录用 "Ripple-err-" 独立前缀、独立 ERR_KEEP_FILES 配额，
     * 与私有目录的模式完全一致（见 writeDownloads / pruneDownloadFiles）。
     */
    private static final int ERR_KEEP_FILES = 20;
    /** 幂等标记：装过就不再装第二次（否则会形成链式 handler + 重复写文件） */
    private static boolean installed = false;

    /**
     * 后台 IO（守护线程）：和 LogBridge 各用各的单线程。
     * 不合并成一条线程是有意的 —— 两边都会在崩溃路径上被同步调用（LogBridge 的
     * forceWrite / CrashLog 的 record），共用一条线程会让「我正在队列里等自己」
     * 这种事变得可能，还容易互相拖慢。两个静态线程不影响退出（daemon）。
     */
    private static final ExecutorService IO =
            Executors.newSingleThreadExecutor(r -> {
                Thread t = new Thread(r, "ripple-crash-io");
                t.setDaemon(true);
                return t;
            });

    /**
     * 只保护「真正碰磁盘」的那一段。
     * 后台线程的轨迹写与崩溃路径的同步写可能同时落同一个 Ripple-trace.txt，
     * 两个 FileOutputStream / 两条 MediaStore 写互相截断会把证据弄坏。
     * 加锁顺序固定为 LOCK → IO_LOCK；主线程的 step() 只拿 LOCK（纯内存），
     * 不会因为后台正在写盘而卡住 —— 这正是 J-01 要的效果。
     */
    private static final Object IO_LOCK = new Object();

    private CrashLog() {
    }

    /** 把落盘任务丢给后台线程；executor 已关闭（进程收尾）时静默跳过 */
    private static void post(Runnable task) {
        try {
            IO.execute(() -> {
                synchronized (IO_LOCK) {
                    task.run();
                }
            });
        } catch (Throwable ignored) {
        }
    }

    /* ================= 启动轨迹 ================= */

    /** 记一步（只在内存累积，按步数/时间窗口节流落盘） */
    static void step(Context ctx, String what) {
        String snapshot = null;
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
            /* 快照必须在锁内取：后台线程再去 toString 会撞上正在 append 的 StringBuilder */
            snapshot = TRACE.toString();
        }
        final String text = snapshot;
        final Context app = ctx == null ? null : ctx.getApplicationContext();
        post(() -> {
            try {
                writeDownloads(app, "trace", text, true);
            } catch (Throwable ignored) {
            }
        });
    }

    /**
     * 同步落盘（崩溃路径专用）。
     * 崩溃后进程随时会被系统收走，这里不能 post 到后台线程 —— 队列里的任务可能不执行。
     */
    static void flushTrace(Context ctx) {
        synchronized (LOCK) {
            lastFlushAt = System.currentTimeMillis();
            stepsSinceFlush = 0;
            String text = TRACE.toString();   // 锁内取快照，之后不再碰 StringBuilder
            synchronized (IO_LOCK) {
                try {
                    /* J-11：高频 tag 走固定名覆盖，别去挤崩溃文件的保留配额 */
                    writePrivateLatest(ctx, "trace", text);
                    writeDownloads(ctx, "trace", text, true);
                } catch (Throwable ignored) {
                }
            }
        }
    }

    /* ================= 崩溃 ================= */

    /**
     * 安装全局崩溃捕获。
     *
     * 幂等：MainActivity 和 RippleApp 以前都调了一次，于是形成
     * 「新 handler → 旧 handler → 默认 handler」的链，同一次崩溃会被写两遍，
     * 而且第一次调用带的是 Activity（静态字段里留住了整棵 View 树）。
     * 现在只装一次，并且强制用 Application Context。
     */
    static synchronized void installQuietly(Context ctx) {
        if (installed) return;
        if (ctx == null) return;
        installed = true;
        final Context app = ctx.getApplicationContext() == null
                ? ctx : ctx.getApplicationContext();
        try {
            final Thread.UncaughtExceptionHandler prev = Thread.getDefaultUncaughtExceptionHandler();
            Thread.setDefaultUncaughtExceptionHandler((t, e) -> {
                /*
                 * J-02：崩溃前最后一段**运行日志**也要落盘。
                 * LogBridge 的内存缓冲最多压着 700ms 的日志，而崩溃之后进程马上
                 * 被系统收走 —— 不在这里同步写一次，那段就永久丢了（类注释承诺过
                 * 「崩溃时能看到崩溃前最后一段」，之前只有网页主动 logFlush 才会落）。
                 * 用 forceWrite 而不是 flush：后者是异步的，队列里的任务可能不执行。
                 * 它内部吞掉所有异常，LogBridge 没初始化过时也只是白跑一趟，不会递归。
                 */
                try {
                    LogBridge.forceWrite(app);
                } catch (Throwable ignored) {
                }
                try {
                    record(app, "uncaught-" + t.getName(), e);
                    flushTrace(app);
                } catch (Throwable ignored) {
                }
                // 交给系统原本的处理器（默认实现会杀进程 + 上报），不要把它吃掉
                if (prev != null) {
                    try {
                        prev.uncaughtException(t, e);
                    } catch (Throwable ignored) {
                    }
                }
            });
        } catch (Throwable ignored) {
            installed = false;
        }
    }

    /**
     * 「上次进程为什么退出」这类非崩溃取证。
     *
     * 固定文件名覆盖写：LMK 杀进程、厂商后台清理都会产生一条 exit info，
     * 以前每条都新建一个带秒级时间戳的文件，用得久了下载目录里全是它。
     * 现在只留最新一份 —— 反正每次启动都会重新写。
     *
     * 落盘丢给后台线程（J-01）：调用点是 RippleApp.onCreate，正处在冷启动首帧
     * 之前的那段主线程上，跨进程写盘不该挡在那里。
     */
    static void recordExitInfo(Context ctx, String text) {
        if (text == null || text.isEmpty()) return;
        lastTrace = text;
        final Context app = ctx == null ? null : ctx.getApplicationContext();
        post(() -> {
            try {
                /* J-11：同上，exit-info 每次启动都会写，必须固定名 */
                writePrivateLatest(app, "exit-info", text);
                writeDownloads(app, "exit-info", text, true);
            } catch (Throwable ignored) {
            }
        });
    }

    /**
     * 非崩溃路径专用的异步版本（J-05）。
     *
     * 为什么需要它：record() 是**同步**写盘 —— MediaStore 查询 + 跨进程 openOutputStream
     * + 全量重写，在故障场景（也正是它被大量调用的时候）主线程每卡几十毫秒。
     * 它保持同步是对的（崩溃 handler 里进程随时会被收走，排队等于丢证据），
     * 但 MainActivity / PlaybackService 里那二十来处调用都是普通的错误日志
     * （cookie-init / edge-to-edge / webview-client / login-open …），
     * 一句「这次操作失败了」完全不值得挡在 UI 线程上。
     *
     * 这里做的就是把「拼文本」保留在调用线程（Throwable 的栈要趁还完整时取），
     * 真正碰盘的那一段丢给后台单线程。崩溃 handler 里仍然用 record()。
     *
     * 注意返回 void：异步路径拿不到落盘后的文本，需要 lastTrace 的调用方用 record()。
     */
    static void recordAsync(Context ctx, String tag, Throwable e) {
        final Context app = ctx == null ? null : (ctx.getApplicationContext() == null
                ? ctx : ctx.getApplicationContext());
        String text;
        try {
            text = buildReport(ctx, tag, e);
        } catch (Throwable ignored) {
            return;
        }
        post(() -> {
            try {
                /* AND-04 / H-16：非崩溃错误在**两个落点**都用 err 前缀，与真崩溃的配额隔离 */
                writePrivate(app, tag, text, "err-");
                writeDownloads(app, tag, text, false, "Ripple-err-");
            } catch (Throwable ignored) {
            }
        });
    }

    /** 同名便捷版：把一句话包成 RuntimeException（与 recordMessage 对应） */
    static void recordMessageAsync(Context ctx, String tag, String message) {
        recordAsync(ctx, tag, new RuntimeException(message));
    }

    static String record(Context ctx, String tag, Throwable e) {
        String text = buildReport(ctx, tag, e);
        lastTrace = text;
        /*
         * record() 保持同步写：它在崩溃路径上（UncaughtExceptionHandler），
         * 进程随时会被系统收掉，post 到后台线程等于赌那把队列会不会跑完。
         */
        synchronized (IO_LOCK) {
            writePrivate(ctx, tag, text);
            writeDownloads(ctx, tag, text, false, "Ripple-crash-");
        }
        return text;
    }

    /** 拼报告正文（不碰磁盘）。抽出来是为了让同步/异步两条路共用同一份格式。 */
    private static String buildReport(Context ctx, String tag, Throwable e) {
        StringWriter sw = new StringWriter();
        PrintWriter pw = new PrintWriter(sw);
        pw.println("== Ripple crash " + stamp() + " ==");
        pw.println("tag: " + tag);
        pw.println("sdk: " + Build.VERSION.SDK_INT + "  device: " + Build.MANUFACTURER + " " + Build.MODEL);
        /*
         * 版本号优先从 PackageManager 读（J-04）：这行以前是手写的，谁绕开
         * build-apk.sh 改版本，报告里的版本就会和真实 APK 对不上。
         * 读不到才回落到下面这个常量 —— 而下面这一行的形状必须保持
         * "version: x.y.z (" + NNN + ")"：android/sync-version.sh 用 sed 同步它，
         * CI 也用 grep -F 校验这一串，改成别的写法会让构建直接失败。
         */
        String fallbackVersion = "version: 1.3.8 (" + 138 + ")";
        String realVersion = versionOf(ctx);
        pw.println(realVersion == null ? fallbackVersion : "version: " + realVersion);
        pw.println();
        if (e != null) e.printStackTrace(pw);
        pw.println();
        /*
         * 只在锁里取一次快照：以前是锁外 TRACE.toString()，
         * 而 step() 同时在另一个线程 append —— 并发 toString/append
         * 可能抛 StringIndexOutOfBoundsException，把取证本身搞挂。
         */
        String trace;
        synchronized (LOCK) {
            trace = TRACE.toString();
        }
        pw.println("---- startup trace ----");
        pw.println(trace);
        pw.flush();
        return sw.toString();
    }

    static String recordMessage(Context ctx, String tag, String message) {
        return record(ctx, tag, new RuntimeException(message));
    }

    /**
     * 真实版本号（"1.2.2 (122)" 这种形状），读不到返回 null 由调用方回落常量。
     * 不缓存：PackageManager 只有崩溃时才会问一次，缓存的收益抵不上「装了新包
     * 还在报老版本」的风险。任何异常都不允许冒出去，取证不能自己制造崩溃。
     */
    private static String versionOf(Context ctx) {
        if (ctx == null) return null;
        try {
            android.content.pm.PackageInfo pi =
                    ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0);
            String name = pi.versionName == null ? "" : pi.versionName;
            if (name.isEmpty()) return null;
            int code = Build.VERSION.SDK_INT >= 28
                    ? (int) pi.getLongVersionCode() : pi.versionCode;
            return name + " (" + code + ")";
        } catch (Throwable e) {
            return null;
        }
    }

    private static String stamp() {
        return new SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(new Date());
    }

    private static void writePrivate(Context ctx, String tag, String text) {
        writePrivate(ctx, tag, text, "crash-");
    }

    /**
     * @param prefix 文件名前缀："crash-" = 真崩溃（配额 10）；
     *               "err-" = 非崩溃错误（配额 20，独立，见 AND-04）
     */
    private static void writePrivate(Context ctx, String tag, String text, String prefix) {
        if (ctx == null) return;
        try {
            File f = new File(ctx.getFilesDir(), prefix + stamp() + "-" + safe(tag) + ".txt");
            FileOutputStream out = new FileOutputStream(f, false);
            try {
                out.write(text.getBytes("UTF-8"));
            } finally {
                out.close();
            }
            /*
             * AND-04：按前缀走各自的淘汰逻辑 —— 错误日志不会挤掉崩溃报告。
             * 注意这里在写盘线程（post 出来的单线程）里跑，不占主线程。
             */
            if ("err-".equals(prefix)) prunePrivateErrFiles(ctx);
            else prunePrivateCrashFiles(ctx);
        } catch (Throwable ignored) {
        }
    }

    /**
     * 私有目录里的「最新一份」固定名覆盖写（J-11）。
     *
     * 为什么必须和 writePrivate 分开：trace / exit-info 这两个 tag 是**高频**的
     * （每次崩溃写一次 trace、每次启动写一次 exit-info），而它们和真正的崩溃文件
     * 共用同一个命名前缀与同一个保留配额 —— 用带时间戳的名字会让它们不断生成新文件，
     * 把 10 份的配额刷满，于是最早那份**真崩溃**的取证被挤掉。
     *
     * 这里改成固定名覆盖（trace-latest.txt / exit-info-latest.txt），
     * 而且**故意不带 crash- 前缀**：prunePrivateCrashFiles 只清 crash-*.txt，
     * 固定名不会被它当成历史崩溃删掉，两份配额从此互不干扰。
     * 下载目录那份本来就是覆盖写（writeDownloads(..., true)），不受影响。
     */
    private static void writePrivateLatest(Context ctx, String tag, String text) {
        if (ctx == null) return;
        try {
            File f = new File(ctx.getFilesDir(), safe(tag) + "-latest.txt");
            FileOutputStream out = new FileOutputStream(f, false);
            try {
                out.write(text.getBytes("UTF-8"));
            } finally {
                out.close();
            }
        } catch (Throwable ignored) {
        }
    }

    /**
     * @param overwrite true 时固定文件名并覆盖（轨迹 / 退出原因只留最新一份）
     */
    private static void writeDownloads(Context ctx, String tag, String text, boolean overwrite) {
        writeDownloads(ctx, tag, text, overwrite, "Ripple-crash-");
    }

    /**
     * 写下载目录。
     *
     * @param prefix 非覆盖写时的文件名前缀（H-16）：
     *               "Ripple-crash-" = 真崩溃（配额 MAX_CRASH_FILES=10）；
     *               "Ripple-err-"   = 非崩溃错误（配额 ERR_KEEP_FILES=20，独立清理）。
     *               前缀是清理逻辑唯一的判据，所以两套配额互不侵占 ——
     *               与私有目录那份（crash- / err-）保持同一套设计。
     */
    private static void writeDownloads(Context ctx, String tag, String text,
                                       boolean overwrite, String prefix) {
        String name = overwrite
                ? "Ripple-" + safe(tag) + ".txt"
                : prefix + stamp() + "-" + safe(tag) + ".txt";
        byte[] data;
        try {
            data = text.getBytes("UTF-8");
        } catch (Exception e) {
            return;
        }
        // 落点逻辑收敛到 PublicFile（以前和 LogBridge 各抄一份）
        PublicFile.write(ctx, name, data, overwrite);
        if (!overwrite) {
            /*
             * H-16：按前缀走各自的淘汰逻辑。
             * 以前这里无条件同时清 crash 相关的两个池子，而下载目录里
             * 错误日志也带 "Ripple-crash-" 前缀 → 两者挤同一个 10 份配额。
             * 现在错误日志写 "Ripple-err-"，只清错误池；崩溃只清崩溃池。
             */
            if ("Ripple-err-".equals(prefix)) {
                prunePrivateErrFiles(ctx);
                pruneDownloadFiles(ctx, "Ripple-err-", ERR_KEEP_FILES);
            } else {
                prunePrivateCrashFiles(ctx);
                pruneDownloadFiles(ctx, "Ripple-crash-", MAX_CRASH_FILES);
            }
        }
    }

    /**
     * 只保留最近 MAX_CRASH_FILES 份崩溃文件。
     * 文件名形如 crash-yyyyMMdd-HHmmss-tag.txt：时间戳是零填充的，
     * 所以按名字倒序排就是「新 → 旧」，删尾部的即可。
     */
    /**
     * 审查 AND-04：错误日志独立的淘汰逻辑（配额 ERR_KEEP_FILES）。
     * 与 prunePrivateCrashFiles 完全分开 —— 两套文件互不影响。
     */
    private static void prunePrivateErrFiles(Context ctx) {
        try {
            File dir = ctx.getFilesDir();
            if (dir == null) return;
            File[] all = dir.listFiles((d, n) -> n.startsWith("err-") && n.endsWith(".txt"));
            if (all == null || all.length <= ERR_KEEP_FILES) return;
            Arrays.sort(all, Comparator.comparing(File::getName).reversed());
            for (int i = ERR_KEEP_FILES; i < all.length; i++) {
                try {
                    if (all[i].getParentFile() != null
                            && all[i].getParentFile().getAbsolutePath()
                                    .equals(dir.getAbsolutePath())) {
                        //noinspection ResultOfMethodCallIgnored
                        all[i].delete();
                    }
                } catch (Throwable ignored) {
                }
            }
        } catch (Throwable ignored) {
        }
    }

    private static void prunePrivateCrashFiles(Context ctx) {
        try {
            File dir = ctx.getFilesDir();
            if (dir == null) return;
            File[] all = dir.listFiles((d, n) -> n.startsWith("crash-") && n.endsWith(".txt"));
            if (all == null || all.length <= MAX_CRASH_FILES) return;
            Arrays.sort(all, Comparator.comparing(File::getName).reversed());
            for (int i = MAX_CRASH_FILES; i < all.length; i++) {
                // 只删自己命名规则内的文件，且确认在 files 目录里
                try {
                    if (all[i].getParentFile() != null
                            && all[i].getParentFile().getAbsolutePath()
                                    .equals(dir.getAbsolutePath())) {
                        //noinspection ResultOfMethodCallIgnored
                        all[i].delete();
                    }
                } catch (Throwable ignored) {
                }
            }
        } catch (Throwable ignored) {
        }
    }

    /**
     * 下载目录里的取证文件按前缀分池清理（H-16）。
     *
     * 私有目录那份清掉了，但这才是用户真正能翻到、也真正会越攒越多的那份
     * （proot 里 /sdcard/Download 直接可见）。以前一个都不会删。
     * 用 MediaStore 按 DISPLAY_NAME 前缀查询，取出来按名字排序后删最老的。
     *
     * @param prefix 文件名前缀，同时也是**配额的作用域**：
     *               "Ripple-crash-" 留 keep 份真崩溃、"Ripple-err-" 留 keep 份错误日志。
     *               两池互不侵占 —— 故障期的错误刷屏不会再把真崩溃报告挤出去。
     * @param keep   该池保留份数
     */
    private static void pruneDownloadFiles(Context ctx, String prefix, int keep) {
        if (Build.VERSION.SDK_INT < 29) return;   // 29 以下兜底目录由私有目录那套思路覆盖
        if (prefix == null || prefix.isEmpty()) return;
        try {
            android.content.ContentResolver cr = ctx.getContentResolver();
            android.database.Cursor c = cr.query(
                    android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                    new String[]{
                            android.provider.MediaStore.MediaColumns._ID,
                            android.provider.MediaStore.MediaColumns.DISPLAY_NAME},
                    android.provider.MediaStore.MediaColumns.DISPLAY_NAME + " LIKE ?",
                    new String[]{prefix + "%"}, null);
            if (c == null) return;
            // (名字, id) 收起来一次处理，别在游标打开时做删除
            java.util.List<String[]> rows = new java.util.ArrayList<>();
            try {
                while (c.moveToNext()) {
                    rows.add(new String[]{c.getString(1), String.valueOf(c.getLong(0))});
                }
            } finally {
                c.close();
            }
            if (rows.size() <= keep) return;
            rows.sort((a, b) -> {
                String na = a[0] == null ? "" : a[0];
                String nb = b[0] == null ? "" : b[0];
                return nb.compareTo(na);      // 新 → 旧
            });
            for (int i = keep; i < rows.size(); i++) {
                try {
                    android.net.Uri u = android.content.ContentUris.withAppendedId(
                            android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                            Long.parseLong(rows.get(i)[1]));
                    cr.delete(u, null, null);
                } catch (Throwable ignored) {
                }
            }
        } catch (Throwable ignored) {
        }
    }

    private static String safe(String s) {
        if (s == null) return "x";
        return s.replaceAll("[^A-Za-z0-9_-]", "_");
    }
}
