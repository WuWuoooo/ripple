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
     * B-3（审查 1.3.8）：**旧格式**崩溃池的配额，单独一池、保留更多。
     *
     * 1.3.6 之前 recordAsync 也写 "Ripple-crash-" 前缀（错误日志与真崩溃共用），
     * 而 pruneDownloadFiles 是**按前缀**分池的 —— 于是「清真崩溃池」这一步
     * 会把历史上所有 Ripple-crash-*-lyric-redraw.txt / -exit-info.txt 一起算进来，
     * 按名字倒序只留 10 份。真机上就有 101 份 Ripple-crash-*，
     * 其中 11 份 Ripple-crash-20261124-0629xx-lyric-redraw.txt 正是
     * 1.3.3「状态栏歌词根因」的关键证据 —— 它们会被静默删光。
     *
     * 现在按**语义 tag** 分池（见 poolOf）：
     *   · tag 以 uncaught 开头 → 真崩溃池，保留 MAX_CRASH_FILES 份；
     *   · 其它旧格式（lyric-redraw / cookie-init / exit-info …）→ 旧证据池，
     *     保留 LEGACY_CRASH_FILES 份，且**永远不会被真崩溃池的配额挤掉**；
     *   · Ripple-err- → 错误池，ERR_KEEP_FILES 份（AND-04 / H-16 的独立配额）。
     */
    private static final int LEGACY_CRASH_FILES = 60;
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
        String fallbackVersion = "version: 1.3.9 (" + 139 + ")";
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
     * @param prefix 非覆盖写时的文件名前缀：
     *               "Ripple-crash-" = 崩溃路径（真正的 uncaught 崩溃）；
     *               "Ripple-err-"   = 非崩溃错误（ERR_KEEP_FILES=20，独立清理）。
     *               ⚠️ B-3：前缀**不再是**清理逻辑唯一的判据 —— 同一个
     *               "Ripple-crash-" 前缀下还混着 1.3.5 之前的旧格式证据
     *               （tag 不是 uncaught-*），它们单独成池、单独配额。
     *               见 pruneDownloadsByPool()。
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
             * H-16 + B-3：淘汰逻辑按**语义 tag** 分池，不按文件名前缀。
             *
             * 按前缀分池会踩两个坑：
             *   ① 前缀同时也被错误日志用过（1.3.6 之前 recordAsync 也写
             *      "Ripple-crash-"）→ 错误刷屏会挤掉真崩溃（H-16 已用
             *      "Ripple-err-" 独立前缀缓解）；
             *   ② 同一个 "Ripple-crash-" 前缀里还躺着 1.3.5 之前的旧格式证据
             *      （-lyric-redraw / -exit-info / -cookie-init …），它们是
             *      **历史现场**而不是本次崩溃，却和真崩溃挤同一个 10 份配额 →
             *      真机上 101 份里那 11 份 1.3.3 歌词根因证据会被删光（B-3）。
             *
             * 现在 poolOf() 只看 tag：uncaught-* 才是真崩溃池，其余旧格式
             * 单独一池保留 LEGACY_CRASH_FILES 份。
             */
            prunePrivateCrashFiles(ctx);
            prunePrivateErrFiles(ctx);
            pruneDownloadFiles(ctx);
        }
    }

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

    /**
     * 私有目录里的崩溃文件按**语义 tag 分池**清理（B-3）。
     *
     * 文件名形如 crash-yyyyMMdd-HHmmss-tag.txt：时间戳零填充，
     * 所以同一池内按名字倒序排就是「新 → 旧」，删尾部的即可。
     *
     * 分池规则见 tagOf / isUncaught：
     *   · tag 以 uncaught 开头 → 真崩溃池（MAX_CRASH_FILES 份）；
     *   · 其余 tag → 1.3.6 之前混进同前缀的旧格式证据池（LEGACY_CRASH_FILES 份）。
     * 两池各自计时，真崩溃不会因为久病成堆的错误日志被顶掉，反之亦然。
     */
    private static void prunePrivateCrashFiles(Context ctx) {
        try {
            File dir = ctx.getFilesDir();
            if (dir == null) return;
            File[] all = dir.listFiles((d, n) -> n.startsWith("crash-") && n.endsWith(".txt"));
            if (all == null || all.length == 0) return;
            prunePrivatePool(dir, all, true, MAX_CRASH_FILES);
            prunePrivatePool(dir, all, false, LEGACY_CRASH_FILES);
        } catch (Throwable ignored) {
        }
    }

    /**
     * 私有目录里**某一池**的淘汰。
     *
     * @param uncaught true = 只处理真崩溃（tag 以 uncaught 开头）；
     *                 false = 只处理旧格式证据
     * @param keep     该池保留份数
     */
    private static void prunePrivatePool(File dir, File[] all, boolean uncaught, int keep) {
        java.util.List<File> pool = new java.util.ArrayList<>();
        for (File f : all) {
            String tag = tagOf(f.getName(), "crash-");
            if (isUncaught(tag) == uncaught) pool.add(f);
        }
        if (pool.size() <= keep) return;
        pool.sort(Comparator.comparing(File::getName).reversed());
        for (int i = keep; i < pool.size(); i++) {
            // 只删自己命名规则内的文件，且确认在 files 目录里
            try {
                File f = pool.get(i);
                if (f.getParentFile() != null
                        && f.getParentFile().getAbsolutePath()
                                .equals(dir.getAbsolutePath())) {
                    //noinspection ResultOfMethodCallIgnored
                    f.delete();
                }
            } catch (Throwable ignored) {
            }
        }
    }

    /* ==================== 下载目录取证文件的「分池」定义 ====================
     *
     * B-3 的核心：**池的界限是语义 tag，不是文件名前缀。**
     *
     * 旧实现按前缀分池，"Ripple-crash-" 这一个前缀里同时躺着三类完全不同的东西：
     *   · 真正的 uncaught 崩溃（tag 以 uncaught- 开头）—— 最该保住；
     *   · 1.3.6 之前用同前缀写的非崩溃错误（lyric-redraw / cookie-init …）；
     *   · 1.3.5 之前的旧格式取证（exit-info 等），是**历史现场**。
     * 它们挤同一个 10 份配额 → 真机上 101 份里那 11 份
     * Ripple-crash-*-lyric-redraw.txt（1.3.3 歌词根因证据）会被静默删光。
     *
     * 现在按 tag 分三池，各留各的：
     *   POOL_CRASH  tag 以 uncaught 开头      → MAX_CRASH_FILES
     *   POOL_LEGACY 其余 crash- 前缀的旧格式  → LEGACY_CRASH_FILES
     *   POOL_ERR    err- 前缀（AND-04）       → ERR_KEEP_FILES
     * 新增池时在这里加一个常量 + downloadPoolOf 里一条判断，配额各自独立。
     * ==================================================================== */
    private static final int POOL_NONE = -1;
    private static final int POOL_CRASH = 0;
    private static final int POOL_LEGACY = 1;
    private static final int POOL_ERR = 2;

    /** 各池的保留份数（下标 = 池 id） */
    private static int keepOf(int pool) {
        if (pool == POOL_CRASH) return MAX_CRASH_FILES;
        if (pool == POOL_LEGACY) return LEGACY_CRASH_FILES;
        if (pool == POOL_ERR) return ERR_KEEP_FILES;
        return 0;
    }

    /**
     * 从一个文件名里取出**语义 tag**。
     *
     * 支持两种名字：
     *   · 下载目录  "Ripple-crash-20261124-0629xx-lyric-redraw.txt"
     *   · 私有目录  "crash-20261124-0629xx-lyric-redraw.txt"
     * 以及 MediaStore 自动改名后的 "….txt" → " (3).txt" 形态
     * （B-3 的碎片正是这么来的，所以清理逻辑必须能认出来）。
     *
     * @return tag（不含 .txt / 不含改名后缀）；不是该前缀的返回 ""
     */
    private static String tagOf(String fileName, String prefix) {
        if (fileName == null || prefix == null || !fileName.startsWith(prefix)) return "";
        String base = stripTxt(fileName.substring(prefix.length()));
        /* 形如 yyyyMMdd-HHmmss-tag：跳过前两段 */
        int i1 = base.indexOf('-');
        if (i1 < 0) return "";
        int i2 = base.indexOf('-', i1 + 1);
        if (i2 < 0) return "";
        return base.substring(i2 + 1);
    }

    /** 去掉结尾的 ".txt"，再去掉 MediaStore 自动改名后缀 " (3)" */
    private static String stripTxt(String name) {
        if (name == null) return "";
        String base = name;
        if (base.endsWith(".txt")) base = base.substring(0, base.length() - 4);
        int p = base.lastIndexOf(" (");
        if (p > 0 && base.endsWith(")")) {
            String tail = base.substring(p + 2, base.length() - 1);
            if (allDigits(tail)) base = base.substring(0, p);
        }
        return base;
    }

    private static boolean allDigits(String s) {
        if (s == null || s.isEmpty()) return false;
        for (int i = 0; i < s.length(); i++) {
            if (!Character.isDigit(s.charAt(i))) return false;
        }
        return true;
    }

    /** 真崩溃的判据：tag 以 uncaught 开头（record 的调用点统一这么拼） */
    private static boolean isUncaught(String tag) {
        return tag != null && tag.startsWith("uncaught");
    }

    /**
     * 下载目录里的一个文件名属于哪个池。
     *
     * 只处理**带时间戳的取证文件**（Ripple-crash- 与 Ripple-err- 两个前缀）；
     * Ripple-log.txt / Ripple-trace.txt / Ripple-exit-info.txt 是固定名覆盖写的
     * 单份文件（J-11），永远不该被任何池的配额删掉 → POOL_NONE。
     */
    private static int downloadPoolOf(String displayName) {
        if (displayName == null) return POOL_NONE;
        if (displayName.startsWith("Ripple-err-")) return POOL_ERR;
        if (!displayName.startsWith("Ripple-crash-")) return POOL_NONE;
        String tag = tagOf(displayName, "Ripple-crash-");
        if (tag.isEmpty()) return POOL_NONE;
        return isUncaught(tag) ? POOL_CRASH : POOL_LEGACY;
    }

    /**
     * 下载目录里的取证文件分池清理（H-16 + B-3）。
     *
     * 私有目录那份清掉了，但这才是用户真正能翻到、也真正会越攒越多的那份
     * （proot 里 /sdcard/Download 直接可见）。
     *
     * 一次查询把所有 "Ripple-*" 条目取回来，按 downloadPoolOf 归类，
     * 再对每个池独立地「按名字倒序排、删掉配额之外的老文件」。
     * 池与池之间没有任何耦合 —— 这是 B-3 要的效果。
     */
    private static void pruneDownloadFiles(Context ctx) {
        if (Build.VERSION.SDK_INT < 29) return;   // 29 以下兜底目录由私有目录那套思路覆盖
        if (ctx == null) return;
        try {
            android.content.ContentResolver cr = ctx.getContentResolver();
            android.database.Cursor c = cr.query(
                    android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                    new String[]{
                            android.provider.MediaStore.MediaColumns._ID,
                            android.provider.MediaStore.MediaColumns.DISPLAY_NAME},
                    android.provider.MediaStore.MediaColumns.DISPLAY_NAME + " LIKE ?",
                    new String[]{"Ripple-%"}, null);
            if (c == null) return;
            /* (名字, id) 收起来一次处理，别在游标打开时做删除 */
            java.util.List<String[]> rows = new java.util.ArrayList<>();
            try {
                while (c.moveToNext()) {
                    rows.add(new String[]{c.getString(1), String.valueOf(c.getLong(0))});
                }
            } finally {
                c.close();
            }
            for (int pool = POOL_CRASH; pool <= POOL_ERR; pool++) {
                java.util.List<String[]> mine = new java.util.ArrayList<>();
                for (String[] row : rows) {
                    if (downloadPoolOf(row[0]) == pool) mine.add(row);
                }
                int keep = keepOf(pool);
                if (mine.size() <= keep) continue;
                mine.sort((a, b) -> {
                    String na = a[0] == null ? "" : a[0];
                    String nb = b[0] == null ? "" : b[0];
                    return nb.compareTo(na);      // 新 → 旧
                });
                for (int i = keep; i < mine.size(); i++) {
                    try {
                        android.net.Uri u = android.content.ContentUris.withAppendedId(
                                android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                                Long.parseLong(mine.get(i)[1]));
                        cr.delete(u, null, null);
                    } catch (Throwable ignored) {
                    }
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
