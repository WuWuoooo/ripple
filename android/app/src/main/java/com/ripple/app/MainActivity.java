package com.ripple.app;

import android.app.Activity;
import android.app.NotificationManager;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.util.Locale;

/**
 * Ripple · Android 外壳
 *
 * 设计约定：不再「崩了什么都不显示」。
 *   - Application 里装了全局崩溃捕获（RippleApp + CrashLog），
 *     堆栈会写到 私有 files/crash-*.txt 和「下载/Ripple-crash-*.txt」
 *   - 所有窗口/WebView 设置都包了 try-catch，任何一步失败都降级继续
 *   - 起不来时在界面上直接显示错误文本（而不是白屏/闪退）
 *   - 连续多次启动异常 → 自动进 safeMode（关掉边缘到边缘与 insets 注入）
 *
 * 注意：版本号**不要**写在这里。它只有一个来源（项目根 version.json，
 * 由 build-apk.sh 同步到 Gradle / 网页），写死一份副本必然会和真实 APK 对不上。
 */
public class MainActivity extends Activity {

    private static final int REQ_FILE = 0x51;
    private static final int REQ_NOTIFY = 0x52;

    private WebView web;
    private ValueCallback<Uri[]> filePathCallback;
    private NeteaseClient netease;
    /** 已提交验证的 MUSIC_U，避免同一 token 反复验证 */
    /** 打开登录页那一刻的 cookie 快照：只有出现「新的 MUSIC_U」才算登录成功 */
    /** 打开登录页前的完整 cookie：取消登录时原样写回，避免把用户静默登出 */
    /** 本次登录流程是否已经真正成功（成功就不回滚 cookie） */
    /** 自动校验连续失败次数：失败也要能重试，但不能变成每 900ms 一轮的请求风暴 */
    private final String pendingLoginCb = "loginCb";
    private boolean pageLoaded = false;
    /** 上一次已经下发过的系统栏状态（幂等缓存：值没变就不再发跨进程调用） */
    private String lastBarKey;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        /*
         * 崩溃捕获已经在 RippleApp.onCreate 里装过（并且用的是 Application Context）。
         * 这里**不再**调 CrashLog.installQuietly(this)：
         * 两处都调会形成链式 handler —— 同一次崩溃写两份文件，
         * 而第一次调用传的是 Activity，静态字段里从此留住整棵 View 树。
         * （installQuietly 内部也加了幂等标记，这里保险起见直接删掉。）
         */
        CrashLog.step(this, "onCreate begin, sdk=" + Build.VERSION.SDK_INT
                + " safeMode=" + StrictModes.safeMode);
        LogBridge.add(this, "UI", "onCreate, safeMode=" + StrictModes.safeMode);

        try {
            setupWindow();
            CrashLog.step(this, "window ok");
        } catch (Throwable e) {
            CrashLog.recordAsync(this, "window", e);
        }

        // 只在 debug 包打开：release 里开调试，连接上 DevTools 就能读 cookie 和本地状态
        if (Build.VERSION.SDK_INT >= 19 && !StrictModes.safeMode && isDebuggable()) {
            try {
                WebView.setWebContentsDebuggingEnabled(true);
            } catch (Throwable ignored) {
            }
        }
        try {
            // 资源缺失时立刻报出来，而不是白屏
            getAssets().open("www/index.html").close();
            CrashLog.step(this, "assets/www/index.html present");
        } catch (Throwable e) {
            CrashLog.recordAsync(this, "assets-missing", e);
        }

        try {
            netease = new NeteaseClient(this);
            CrashLog.step(this, "netease client ok");
        } catch (Throwable e) {
            CrashLog.recordAsync(this, "netease-init", e);
        }

        try {
            buildUi();
            CrashLog.step(this, "buildUi ok");
        } catch (Throwable e) {
            CrashLog.recordAsync(this, "webview-init", e);
            showFatal(L10n.t("WebView 初始化失败", "Failed to initialize WebView"), e);
            return;
        }

        /*
         * 不在启动时就弹「允许通知」。
         * Android 13+ 上用户刚打开 App 还没做任何事就被拦一次，很讨嫌，
         * 而且跟「播放」本身没有关系。改成由网页在用户主动点
         * 「发送测试通知」时通过 requestNotifyPermission() 触发。
         */
    }

    /** 由网页调用：真正需要通知时才申请 */
    void requestNotifyPermissionNow() {
        askNotificationPermission();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQ_NOTIFY) return;
        boolean ok = grantResults != null && grantResults.length > 0
                && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        // 结果回给网页，让「通知」那一行立刻显示真实状态，不必等下次进设置页
        try {
            if (web != null) {
                web.evaluateJavascript(
                        "window.__rippleNotifyPerm && window.__rippleNotifyPerm(" + ok + ")", null);
            }
        } catch (Throwable ignored) {
        }
    }

    /* ================= 窗口 / 安全区 ================= */

    private void setupWindow() {
        /*
         * 边缘到边缘（edge-to-edge）：v1.2.2 的做法
         *
         * 之前的问题：
         *   · 状态栏是独立一条被系统涂色的区域，永远和网页渐变背景对不上
         *   · 导航栏同理，底部按钮下面露出一条底色
         *
         * 现在让 WebView 一直铺到屏幕四边，状态栏/导航栏都设成全透明，
         * 于是「状态栏区域显示的就是网页自己的背景」——颜色天然一致，
         * 换页面、换封面色、切主题都会自动跟着变。
         * 内容避让交给网页：真实高度通过 --safe-t/--safe-b 传过去。
         *
         * 所有系统调用都包 try-catch（部分定制 ROM 会抛异常），失败就退回非 edge-to-edge。
         */
        Window w = getWindow();
        boolean edgeToEdge = !StrictModes.safeMode;

        try {
            w.setStatusBarColor(Color.TRANSPARENT);
            w.setNavigationBarColor(Color.TRANSPARENT);
            w.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
        } catch (Throwable ignored) {
        }

        if (edgeToEdge) {
            try {
                if (Build.VERSION.SDK_INT >= 30) {
                    // 让内容自己决定怎么避让系统栏（我们靠 insets 变量）
                    w.setDecorFitsSystemWindows(false);
                } else {
                    w.getDecorView().setSystemUiVisibility(
                            View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
                }
                LogBridge.add(this, "WINDOW", "edge-to-edge enabled");
            } catch (Throwable e) {
                CrashLog.recordAsync(this, "edge-to-edge", e);
                LogBridge.add(this, "WINDOW", "edge-to-edge failed: " + e);
            }
        }

        if (Build.VERSION.SDK_INT >= 28) {
            try {
                w.getAttributes().layoutInDisplayCutoutMode =
                        WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            } catch (Throwable ignored) {
            }
        }
    }

    /**
     * 安全区推给网页（0dp 时网页用自己的 fallback）。
     *
     * ⚠️ 键盘弹出时必须把 --safe-b 归零，否则会和 --kb-h 叠加成「顶两次」。
     *
     * 为什么：Android 11+ 的 navigationBars() insets 在键盘弹出时**仍然包含
     * 导航栏高度**（导航栏并未消失，只是被键盘盖住）。而界面上键盘是从屏幕
     * 最底部升起的，已经把那块导航栏区域一起盖掉了。如果这时既给
     * --safe-b（面板按导航栏高度上移）又给 --kb-h（再按键盘高度上移），
     * 面板就会被顶起来两次 —— 用户看到的是「一打开键盘评论 UI 突然降低」。
     *
     * 实测症状（Review 反馈）：打开评论输入框 → 键盘弹出 → 底部发布框先跳一下；
     * 键盘收起时又跳回来。根因就是这两个量同时非零。
     *
     * 现在：有键盘时 --safe-b 归零（键盘已经盖住那块区域了），
     * 只让 --kb-h 生效；没有键盘时两者都正常。
     */
    private void pushInsets(int top, int bottom, int left, int right, int ime) {
        if (web == null) return;
        float d = getResources().getDisplayMetrics().density;
        // 键盘真的弹出来了（与 toggled 的 .kb-open 判据一致：> 60dp）
        final boolean kb = ime / d > 60;
        final int safeBottom = kb ? 0 : bottom;
        String code = "(function(){try{var r=document.documentElement.style;"
                + "r.setProperty('--safe-t','" + (top / d) + "px');"
                + "r.setProperty('--safe-b','" + (safeBottom / d) + "px');"
                + "r.setProperty('--safe-l','" + (left / d) + "px');"
                + "r.setProperty('--safe-r','" + (right / d) + "px');"
                + "r.setProperty('--kb-h','" + (ime / d) + "px');"
                + "document.documentElement.classList.toggle('kb-open', " + kb + ");"
                + "document.documentElement.classList.add('native');}catch(e){}})();";
        runOnUiThread(() -> {
            try {
                if (web != null) web.evaluateJavascript(code, null);
            } catch (Throwable ignored) {
            }
        });
    }

    /**
     * 键盘（IME）高度，单位像素；没有键盘时为 0。
     *
     * 为什么单独取：edge-to-edge 下 WebView 铺满整屏，
     * 键盘弹出时**不会**自动把窗口顶上去 —— 网页完全感知不到键盘占了多高，
     * 于是底部输入框（评论框、搜索框）被键盘盖住，用户打字时看不见自己打的内容。
     *
     * 以前 getInsets() 里只取了 statusBars / navigationBars / displayCutout，
     * 漏了 ime()，所以键盘弹出时这个回调虽然会触发，但算出来的高度不变，
     * 网页那边就收不到任何变化。
     */
    private int imeHeightPx(WindowInsets insets) {
        if (insets == null || Build.VERSION.SDK_INT < 30) return 0;
        try {
            return insets.getInsets(WindowInsets.Type.ime()).bottom;
        } catch (Throwable t) {
            return 0;
        }
    }

    /**
     * 把真实安全区推给网页。
     *
     * 现在是 edge-to-edge：WebView 铺满整屏，网页必须自己让出状态栏/导航栏，
     * 所以这里要把真实像素高度传过去（单位 dp），否则内容会被状态栏压住。
     */
    private void measureAndPushInsets() {
        try {
            int top = 0, bottom = 0, left = 0, right = 0;
            View decor = getWindow().getDecorView();
            WindowInsets insets = Build.VERSION.SDK_INT >= 23 ? decor.getRootWindowInsets() : null;
            if (insets != null) {
                if (Build.VERSION.SDK_INT >= 30) {
                    android.graphics.Insets i = insets.getInsets(
                            WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars()
                                    | WindowInsets.Type.displayCutout());
                    top = i.top; bottom = i.bottom; left = i.left; right = i.right;
                } else {
                    top = insets.getSystemWindowInsetTop();
                    bottom = insets.getSystemWindowInsetBottom();
                    left = insets.getSystemWindowInsetLeft();
                    right = insets.getSystemWindowInsetRight();
                }
            }
            if (top <= 0) top = getStatusBarHeight();
            if (bottom <= 0) bottom = getNavBarHeight();
            int ime = imeHeightPx(insets);
            LogBridge.add(this, "INSETS", "t=" + top + " b=" + bottom + " l=" + left + " r=" + right
                    + " ime=" + ime);
            pushInsets(top, bottom, left, right, ime);
        } catch (Throwable e) {
            LogBridge.add(this, "INSETS", "measure failed: " + e);
        }
    }

    private int getStatusBarHeight() {
        try {
            int id = getResources().getIdentifier("status_bar_height", "dimen", "android");
            return id > 0 ? getResources().getDimensionPixelSize(id) : 0;
        } catch (Throwable e) {
            return 0;
        }
    }

    private int getNavBarHeight() {
        try {
            int id = getResources().getIdentifier("navigation_bar_height", "dimen", "android");
            return id > 0 ? getResources().getDimensionPixelSize(id) : 0;
        } catch (Throwable e) {
            return 0;
        }
    }

    /* ================= WebView ================= */

    /** 主布局容器：WebView 挂在这里，渲染进程挂掉重建时也只替换它的子项 */
    private FrameLayout webRoot;

    private void buildUi() {
        CrashLog.step(this, "creating WebView");
        webRoot = new FrameLayout(this);
        web = new WebView(this);
        CrashLog.step(this, "WebView created");
        configureWeb(web);

        webRoot.addView(web, new FrameLayout.LayoutParams(-1, -1));
        setContentView(webRoot);
        CrashLog.step(this, "contentView set");

        loadIndex();
    }

    /**
     * 启动成功后才清零「连续失败计数」。
     *
     * 以前是「new WebView() 成功就清」，而典型故障（edge-to-edge 起不来、
     * insets 注入异常、页面 JS 崩在第一屏）全都发生在建 WebView **之后** ——
     * 计数永远累积不到 3 次，safeMode 等于形同虚设。
     *
     * 现在改成：页面加载完成（onPageFinished）之后再等 DELAY 毫秒，
     * 期间没有再次触发崩溃/重建，才认为这一次启动真的成功了。
     * RippleApp 里 >= 3 的判定保持不变。
     */
    private static final long BOOT_OK_DELAY_MS = 5000;
    /** 每次重建 WebView 都换一个 token，旧的延时清零点自己失效 */
    private int bootToken = 0;

    private void scheduleBootStreakClear() {
        final int token = ++bootToken;
        final WebView w = web;
        if (w == null) return;
        w.postDelayed(() -> {
            // 期间又崩过 / 重建过 / 页面换了：这次不算成功启动，别清零
            if (token != bootToken) return;
            if (!pageLoaded || web == null) return;
            try {
                getSharedPreferences("ripple", MODE_PRIVATE).edit()
                        .putInt("boot_streak", 0).apply();
            } catch (Throwable ignored) {
            }
        }, BOOT_OK_DELAY_MS);
    }

    /** 建一个新的 WebView 并挂到 webRoot（首次启动和渲染进程崩溃后重建共用） */
    private void configureWeb(final WebView w) {
        WebSettings s = w.getSettings();
        safe(() -> s.setJavaScriptEnabled(true));
        safe(() -> s.setDomStorageEnabled(true));
        safe(() -> s.setDatabaseEnabled(true));
        safe(() -> s.setMediaPlaybackRequiresUserGesture(false));
        safe(() -> s.setAllowFileAccess(true));
        /*
         * 关掉 WebView 加载 content:// URL 的能力（攻击面收窄）。
         *
         * 注意它管的是「页面自己去访问 content:// 」这一类加载；设置页的「导入本地音乐」
         * 走的是 <input type="file"> + onShowFileChooser，选中项由浏览器进程用
         * ContentResolver 打开 fd 再交给渲染进程，不经过这条开关，因此导入不受影响。
         * 万一以后导入出问题，这是第一个该回滚的开关。
         */
        safe(() -> s.setAllowContentAccess(false));
        /*
         * file:// 页面能读任意本地文件、还能跨域 fetch 任意站点，
         * 这两个开关一旦打开，配合 addJavascriptInterface 暴露的
         * cookie()（已删除）/httpGet()，攻击面就大得没必要 —— App 里根本没有跨域 file:// 需求。
         * 只保留 setAllowFileAccess（读自身 assets 需要）。
         */
        safe(() -> s.setAllowFileAccessFromFileURLs(false));
        safe(() -> s.setAllowUniversalAccessFromFileURLs(false));
        safe(() -> s.setLoadWithOverviewMode(true));
        safe(() -> s.setUseWideViewPort(true));
        safe(() -> s.setCacheMode(WebSettings.LOAD_DEFAULT));
        safe(() -> s.setJavaScriptCanOpenWindowsAutomatically(true));
        // 页面本身是本地 file://、在线资源全是 https，没有任何混用需求，直接禁掉明文子资源
        safe(() -> s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW));
        // UA 里的版本号跟真实 APK 对齐（以前写死一个固定版本号，和实际版本差了好几个版本）
        safe(() -> s.setUserAgentString(s.getUserAgentString() + " RippleApp/" + versionName()));

        if (!StrictModes.safeMode) {
            try {
                CookieManager.getInstance().setAcceptCookie(true);
                CookieManager.getInstance().setAcceptThirdPartyCookies(w, true);
            } catch (Throwable e) {
                CrashLog.recordAsync(this, "cookie-init", e);
            }
        }

        try {
            w.setBackgroundColor(Color.parseColor("#07070b"));
            w.setOverScrollMode(View.OVER_SCROLL_NEVER);
            w.addJavascriptInterface(new HttpBridge(this, netease), "RippleNative");
        } catch (Throwable e) {
            CrashLog.recordAsync(this, "bridge", e);
        }

        // 同一份 WebViewClient / ChromeClient 给重建出来的 WebView 复用
        try {
            w.setWebViewClient(new WebViewClient() {
                @Override
                public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                    Uri u = request.getUrl();
                    String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase(Locale.US);
                    if ("file".equals(scheme) || "about".equals(scheme)) return false;
                    if (scheme.startsWith("http") && "localhost".equals(u.getHost())) return false;
                    /*
                     * L-13：javascript: / data: 直接拦掉。
                     *
                     * ACTION_VIEW 本来也不会执行 javascript:（不是代码执行漏洞），
                     * 但它会去匹配浏览器 → 抛 ActivityNotFoundException →
                     * 弹一句「没有可以打开该链接的应用」，用户看到的是莫名其妙的
                     * 提示。这类 scheme 在本应用里没有任何合法用途，静默吞掉最合适。
                     * data: 同理：整个页面自己就能渲染，交给外部应用只会更危险。
                     */
                    if ("javascript".equals(scheme) || "data".equals(scheme)) return true;
                    try {
                        Intent it;
                        if ("intent".equals(scheme)) {
                            /*
                             * L-13：intent:// 必须用 Intent.parseUri 解析。
                             *
                             * 直接 new Intent(ACTION_VIEW, Uri.parse("intent://..."))
                             * 在多数 ROM 上会抛 ActivityNotFoundException ——
                             * 因为目标 scheme 是 "intent"，没有任何应用声明处理它。
                             * parseUri(..., URI_INTENT_SCHEME) 才会解出真实的
                             * scheme / package / 参数，从而正确拉起目标 App。
                             * 解析失败就静默返回 true（拦截），不弹无意义提示。
                             */
                            try {
                                it = Intent.parseUri(u.toString(), Intent.URI_INTENT_SCHEME);
                            } catch (Throwable e) {
                                LogBridge.add(MainActivity.this, "NAV", "bad intent uri: " + u);
                                return true;
                            }
                        } else {
                            it = new Intent(Intent.ACTION_VIEW, u);
                        }
                        it.addCategory(Intent.CATEGORY_BROWSABLE);
                        /*
                         * 从 WebView 里跳外部 Activity 必须带 NEW_TASK：
                         * 这里没有 Activity 栈上下文，不带会抛
                         * AndroidRuntimeException: Calling startActivity() from
                         * outside of an Activity context requires FLAG_ACTIVITY_NEW_TASK。
                         */
                        it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        startActivity(it);
                    } catch (android.content.ActivityNotFoundException e) {
                        // 没有任何应用能打开这个链接：明确告诉用户，而不是点了没反应
                        // 1.3.5 多语言：Toast 是用户唯一能看到的反馈，必须跟着语言走
                        Toast.makeText(MainActivity.this,
                                L10n.t("没有可以打开该链接的应用", "No app can open this link"),
                                Toast.LENGTH_SHORT).show();
                    } catch (Throwable e) {
                        Toast.makeText(MainActivity.this,
                                L10n.t("打开链接失败", "Failed to open link"),
                                Toast.LENGTH_SHORT).show();
                    }
                    return true;
                }

                @Override
                public void onPageFinished(WebView view, String url) {
                    super.onPageFinished(view, url);
                    pageLoaded = true;
                    CrashLog.step(MainActivity.this, "onPageFinished " + url);
                    measureAndPushInsets();
                    scheduleBootStreakClear();
                }

                @Override
                public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                    /*
                     * 渲染进程被杀（大内存/系统回收）不能让整个 App 一起死，
                     * 但也**不能只是 return true 就完事** —— 那个 WebView 已经废了：
                     * 之后的 evaluateJavascript 永远不回调，返回键判定卡住，
                     * 用户只能按 Home 出去。
                     *
                     * 正确做法（官方文档要求）：先把 View 从布局里摘掉，再 destroy，
                     * 然后把引用置空；这里再重建一个 WebView，用户不至于被迫退出。
                     */
                    CrashLog.recordMessageAsync(MainActivity.this, "render-gone",
                            "WebView renderer gone, didCrash=" + (detail != null && detail.didCrash()));
                    discardWeb(view);
                    recreateWeb();
                    return true;
                }

                @Override
                public void onReceivedError(WebView view, WebResourceRequest req, android.webkit.WebResourceError err) {
                    if (req != null && req.isForMainFrame()) {
                        CrashLog.recordMessageAsync(MainActivity.this, "page-error",
                                "主页面加载失败: " + err.getErrorCode() + " " + err.getDescription()
                                        + " url=" + req.getUrl());
                    }
                }
            });
        } catch (Throwable e) {
            CrashLog.recordAsync(this, "webview-client", e);
        }

        try {
            w.setWebChromeClient(new WebChromeClient() {
                @Override
                public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb,
                                                 FileChooserParams params) {
                    if (filePathCallback != null) filePathCallback.onReceiveValue(null);
                    filePathCallback = cb;
                    try {
                        Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                        i.addCategory(Intent.CATEGORY_OPENABLE);
                        i.setType("audio/*");
                        i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                        // 1.3.5 多语言：系统文件选择器的标题条会显示这一句
                        startActivityForResult(Intent.createChooser(i,
                                L10n.t("选择音频文件", "Choose an audio file")), REQ_FILE);
                        return true;
                    } catch (Exception e) {
                        filePathCallback = null;
                        return false;
                    }
                }
            });
        } catch (Throwable ignored) {
        }

        // edge-to-edge：必须把真实 insets 转给网页，否则顶部会被状态栏压住
        try {
            w.setOnApplyWindowInsetsListener((v, insets) -> {
                int top = 0, bottom = 0, left = 0, right = 0;
                if (Build.VERSION.SDK_INT >= 30) {
                    android.graphics.Insets i = insets.getInsets(
                            WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars()
                                    | WindowInsets.Type.displayCutout());
                    top = i.top; bottom = i.bottom; left = i.left; right = i.right;
                } else {
                    top = insets.getSystemWindowInsetTop();
                    bottom = insets.getSystemWindowInsetBottom();
                    left = insets.getSystemWindowInsetLeft();
                    right = insets.getSystemWindowInsetRight();
                }
                pushInsets(top, bottom, left, right, imeHeightPx(insets));
                return insets;
            });
        } catch (Throwable ignored) {
        }
    }

    /** 载入主页面 + 补推 insets（首次启动和重建都走这里） */
    private void loadIndex() {
        final WebView w = web;
        if (w == null) return;
        CrashLog.step(this, "loading index.html");
        try {
            w.loadUrl("file:///android_asset/www/index.html");
        } catch (Throwable e) {
            CrashLog.recordAsync(this, "load-index", e);
        }
        // 页面脚本可能晚于 insets 回调执行，补推几次
        w.postDelayed(this::measureAndPushInsets, 300);
        w.postDelayed(this::measureAndPushInsets, 1200);
        w.postDelayed(this::measureAndPushInsets, 2600);
    }

    /**
     * 渲染进程挂掉之后：把废掉的 WebView 从布局摘下再销毁，然后重建。
     * 任何一步失败都要保证不把 Activity 拖死。
     */
    private void discardWeb(WebView dead) {
        WebView w = dead != null ? dead : web;
        if (w == web) web = null;
        try {
            ViewGroup parent = (ViewGroup) w.getParent();
            if (parent != null) parent.removeView(w);
        } catch (Throwable ignored) {
        }
        try {
            w.stopLoading();
        } catch (Throwable ignored) {
        }
        try {
            w.destroy();
        } catch (Throwable ignored) {
        }
    }

    /**
     * 重建 WebView。
     * 渲染进程崩溃后如果什么都不做，用户看到的是一个永远白屏、返回键也失灵的外壳；
     * 重建能把网页重新拉起来（播放状态在网页侧本地存储里，能续上）。
     * 连重建都失败时，退回「退出 / 重启」按钮，至少给用户一条出路。
     */
    private void recreateWeb() {
        try {
            if (webRoot == null) {
                showFatal(L10n.t("页面渲染进程被系统回收（无法重建）",
                        "The page renderer was reclaimed by the system (cannot rebuild)"), null);
                return;
            }
            final WebView w = new WebView(this);
            configureWeb(w);
            web = w;
            webRoot.addView(w, new FrameLayout.LayoutParams(-1, -1));
            pageLoaded = false;
            lastBarKey = null;   // 重建后状态栏配色要重新下发
            loadIndex();
            LogBridge.add(this, "UI", "WebView 已重建（渲染进程曾被杀）");
        } catch (Throwable e) {
            CrashLog.recordAsync(this, "webview-recreate", e);
            showFatal(L10n.t("页面渲染进程被系统回收",
                    "The page renderer was reclaimed by the system"), e);
        }
    }

    private interface Action {
        void run() throws Throwable;
    }

    private static void safe(Action a) {
        try {
            a.run();
        } catch (Throwable ignored) {
        }
    }

    /** 兜底界面：显示错误 + 崩溃文件位置，而不是白屏 */
    private void showFatal(String title, Throwable e) {
        try {
            String trace = e == null ? CrashLog.lastTrace : CrashLog.record(this, "fatal", e);
            LinearLayoutCompat box = new LinearLayoutCompat(this);
            FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(-1, -1);
            box.setPadding(48, 96, 48, 48);
            box.setBackgroundColor(Color.parseColor("#07070b"));

            TextView h = new TextView(this);
            /*
             * 1.3.5 多语言：崩溃页是纯原生绘制的，前端 i18n 管不到这里 ——
             * 这大概是最需要翻译的一处（出问题时用户最慌，看不懂更没底）。
             * title 由各调用点用 L10n.t 翻好传进来，这里只翻固定的两段壳文字。
             */
            h.setText(L10n.t("Ripple 启动出错", "Ripple failed to start") + "\n" + title);
            h.setTextColor(Color.parseColor("#ff8fa3"));
            h.setTextSize(18f);

            TextView body = new TextView(this);
            body.setText((trace == null ? "" : trace)
                    + "\n\n" + L10n.t("堆栈已写入「下载」目录的 Ripple-crash-*.txt",
                    "Stack trace written to Ripple-crash-*.txt in the Downloads folder"));
            body.setTextColor(Color.parseColor("#bbbbbb"));
            body.setTextSize(11f);
            body.setPadding(0, 24, 0, 0);

            box.addView(h);
            box.addView(body);

            ScrollView sv = new ScrollView(this);
            sv.addView(box);

            FrameLayout wrap = new FrameLayout(this);
            wrap.addView(sv, lp);
            setContentView(wrap);
        } catch (Throwable ignored) {
        }
    }

    /* ================= 系统栏颜色 ================= */

    /**
     * 网页把当前背景色发过来，这里同步到状态栏 / 导航栏。
     * 之前病因：窗口铺满 + 状态栏透明色画在黑色 decorView 上 → 顶上一条纯黑。
     * 现在状态栏直接刷成和网页背景同色，深浅主题都一致。
     */
    void applySystemBars(final String statusHex, final String navHex, final boolean lightIcons) {
        /*
         * 幂等缓存：网页的 refreshSystemBars 在启动/开关播放页时会被连着调好几次
         * （日志里 2 秒内 3 次 BOOT: ready、8 次 BARS: send）。
         * 颜色和图标深浅都没变时直接返回，不再走一遍窗口 + insets 的跨进程调用。
         */
        final String key = statusHex + "|" + navHex + "|" + lightIcons;
        if (key.equals(lastBarKey)) return;
        try {
            Window w = getWindow();
            /*
             * edge-to-edge 模式下，状态栏/导航栏必须保持全透明：
             * 那样显示出来的就是网页自己的背景渐变，颜色天然和页面一致。
             * 如果把这里刷成某个固定色，反而会重新出现「上下两条不一样」的问题。
             * safeMode 下没有启用 edge-to-edge，才真的用网页传进来的颜色。
             */
            int status = StrictModes.safeMode ? parseColor(statusHex, Color.TRANSPARENT) : Color.TRANSPARENT;
            int nav = StrictModes.safeMode ? parseColor(navHex, Color.TRANSPARENT) : Color.TRANSPARENT;
            if (Build.VERSION.SDK_INT >= 21) {
                w.setStatusBarColor(status);
                w.setNavigationBarColor(nav);
                w.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
            }
            LogBridge.add(this, "BARS", "status=" + statusHex + " nav=" + navHex
                    + " lightIcons=" + lightIcons);
            // 只调整图标明暗，保证在浅色背景上看得清
            if (Build.VERSION.SDK_INT >= 30) {
                WindowInsetsController c = w.getInsetsController();
                if (c != null) {
                    int mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                            | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                    c.setSystemBarsAppearance(lightIcons ? mask : 0, mask);
                }
            } else if (Build.VERSION.SDK_INT >= 23) {
                int flags = w.getDecorView().getSystemUiVisibility();
                if (lightIcons) flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                else flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                w.getDecorView().setSystemUiVisibility(flags);
            }
            lastBarKey = key;
        } catch (Throwable e) {
            CrashLog.recordAsync(this, "system-bars", e);
        }
    }

    private static int parseColor(String hex, int fallback) {
        try {
            if (hex == null || !hex.startsWith("#")) return fallback;
            return Color.parseColor(hex);
        } catch (Throwable e) {
            return fallback;
        }
    }

    /** 从 PackageManager 读真实版本名，避免代码里再写一份副本 */
    private String versionName() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Throwable e) {
            return "?";
        }
    }

    /** 是不是 debug 包（只有 debug 才开 WebView 远程调试） */
    private boolean isDebuggable() {
        try {
            return (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        } catch (Throwable e) {
            return false;
        }
    }

    /* ================= 通知权限 ================= */

    private void askNotificationPermission() {
        try {
            if (Build.VERSION.SDK_INT < 33) return;
            if (checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                    == PackageManager.PERMISSION_GRANTED) return;
            requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, REQ_NOTIFY);
        } catch (Throwable ignored) {
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE) {
            if (filePathCallback == null) return;
            Uri[] out = null;
            if (resultCode == RESULT_OK && data != null) {
                try {
                    if (data.getClipData() != null) {
                        int n = data.getClipData().getItemCount();
                        out = new Uri[n];
                        for (int i = 0; i < n; i++) out[i] = data.getClipData().getItemAt(i).getUri();
                    } else if (data.getData() != null) {
                        out = new Uri[]{data.getData()};
                    }
                } catch (Throwable ignored) {
                }
            }
            try {
                filePathCallback.onReceiveValue(out);
            } catch (Throwable ignored) {
            }
            filePathCallback = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    /* ================= 网易云登录（纯扫码，见 app/js/app.js） ================= */
    /*
     * 审查 AND-02：内嵌 WebView 登录链已整段删除（原约 330 行）。
     *
     * 1.3.0 起三端统一走扫码登录（`chooseLoginMode` → `startQrLogin`），
     * 数据通道就是普通的 `login_qr_key` / `login_qr_check` 两条命令 ——
     * 不需要在 Activity 上再叠一个 WebView 去加载 music.163.com。
     *
     * 而前端 `Netease.login()` 已无任何调用方（grep 仅命中定义本身）。
     * 留着不只是死代码：它在主 Activity 上叠第二个 WebView 并暴露
     * @JavascriptInterface，是额外的攻击面；两份注释还互相矛盾
     * （HttpBridge 头注释说在用、NeteaseClient 说不再用）。
     *
     * 现在扫码登录只走 NeteaseClient 的普通命令通道，这条链整体移除。
     */

    /* ================= 回调网页 ================= */

    void replyToWeb(final String cbId, final String payload) {
        final WebView w = web;
        if (w == null) return;
        runOnUiThread(() -> {
            try {
                String js = "window.__rippleNativeResult&&window.__rippleNativeResult("
                        + quote(cbId) + "," + quote(payload) + ")";
                w.evaluateJavascript(js, null);
            } catch (Throwable ignored) {
            }
        });
    }

    /**
     * 把字符串转成 JS 字面量。
     *
     * M-13：U+2028 / U+2029 必须显式转义。
     * 它们在 JSON 里是合法字符，但在 **JavaScript 字符串字面量**里是行终止符 ——
     * 直接原样写进 evaluateJavascript 的脚本就是语法错误，整段脚本不执行，
     * 于是 window.__rippleNativeResult 永远不会被调用，前端只能等到超时，
     * 而且报的是「请求超时」而不是真实原因。
     * 网易云的错误消息里带上这两个字符并非不可能（内容字段来自上游）。
     */
    private static String quote(String s) {
        if (s == null) return "null";
        StringBuilder b = new StringBuilder(s.length() + 16);
        b.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\n': b.append("\\n"); break;
                case '\r': b.append("\\r"); break;
                case '\t': b.append("\\t"); break;
                case '\u2028': b.append("\\u2028"); break;
                case '\u2029': b.append("\\u2029"); break;
                default:
                    if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
                    else b.append(c);
            }
        }
        b.append('"');
        return b.toString();
    }

    NeteaseClient netease() {
        return netease;
    }

    @Override
    public void onBackPressed() {
        /*
         * 渲染进程崩溃后 web 会短暂为 null（重建期间）。
         * 此时不能再 evaluateJavascript —— 那个回调永远不会来，返回键等于失灵，
         * 只能按 Home 出去。直接 finish() 给用户一条出路。
         */
        if (web == null) {
            finish();
            return;
        }
        try {
            /*
             * 返回键的优先级判断整段挪到了网页里（window.__rippleBack）。
             * 原因：Java 这边不知道网页上还开着哪些面板，旧逻辑只认识
             * 「歌词展开」和「播放页」两种状态，于是播放列表还开着的时候
             * 按返回，先收的是播放页，列表留在后面。
             * 现在网页按「面板 → 歌词 → 播放页 → 搜索框 → 退出」的顺序判断，
             * 只有真的没东西可收时才返回 'exit'。
             */
            web.evaluateJavascript(
                    "(function(){try{return window.__rippleBack?window.__rippleBack():'exit'}"
                            + "catch(e){return 'exit'}})()",
                    value -> {
                        if (value == null || value.contains("exit")) finish();
                    });
        } catch (Throwable e) {
            finish();
        }
    }

    /**
     * 系统深色/浅色切换。
     * manifest 里声明了 uiMode 这个 configChanges，所以系统主题变化不会重建 Activity，
     * 只会回调到这里 —— 要主动告诉网页重新解析一次主题，否则「自动」不会跟手。
     */
    @Override
    public void onConfigurationChanged(android.content.res.Configuration cfg) {
        super.onConfigurationChanged(cfg);
        try {
            if (web != null) {
                web.evaluateJavascript(
                        "window.__rippleSystemTheme && window.__rippleSystemTheme()", null);
            }
        } catch (Throwable ignored) {
        }
        measureAndPushInsets();
        pushViewport();
    }

    /*
     * 小窗 / 分屏 / 自由窗口的尺寸变化。
     *
     * Manifest 里 resizeableActivity 已经改成 true，这里要配合做两件事：
     *   1) 通知网页「窗口尺寸变了」，让它重算封面尺寸（sizeCover()）和布局；
     *      网页侧的 matchMedia 断点也会随之切换（手机 / 平板布局自动换），
     *      所以小窗拖到很窄时会自动落到 --pad-x 小屏那一档，不会露出半截。
     *   2) 重新量一次安全区 —— 小窗里通常没有状态栏/手势条，insets 会变成 0，
     *      不重算就会在顶上留一条空白。
     */
    @Override
    public void onMultiWindowModeChanged(boolean isInMultiWindowMode,
                                         android.content.res.Configuration newConfig) {
        super.onMultiWindowModeChanged(isInMultiWindowMode, newConfig);
        try {
            if (web != null) {
                web.evaluateJavascript(
                        "(function(){try{window.dispatchEvent(new Event('resize'));" +
                        "document.documentElement.classList.toggle('in-multiwindow', " +
                        isInMultiWindowMode + ");}catch(e){}})()", null);
            }
        } catch (Throwable ignored) {
        }
        measureAndPushInsets();
        pushViewport();
        LogBridge.add(this, "WINDOW",
                "multiwindow=" + isInMultiWindowMode + " "
                        + (newConfig == null ? "" : newConfig.screenWidthDp + "x" + newConfig.screenHeightDp));
    }

    /**
     * 把当前窗口的逻辑尺寸与 dpr 推给网页。
     * WebView 在小窗里不会自动重算 viewport，靠这一步保证
     * 「小窗宽度 400dp」这类情况下网页真的按 400 布局，而不是还按全屏宽度。
     */
    private void pushViewport() {
        try {
            if (web == null) return;
            android.util.DisplayMetrics dm = getResources().getDisplayMetrics();
            final int w = Math.round(dm.widthPixels / dm.density);
            final int h = Math.round(dm.heightPixels / dm.density);
            final float dpr = dm.density;
            web.post(() -> {
                try {
                    if (web == null) return;
                    web.evaluateJavascript(
                            "window.__rippleViewport && window.__rippleViewport(" + w + "," + h + "," + dpr + ")",
                            null);
                } catch (Throwable ignored) {
                }
            });
        } catch (Throwable ignored) {
        }
    }

    /* ================= 状态栏歌词浮层 ================= */

    private LyricOverlay lyricOverlay;

    private LyricOverlay overlay() {
        if (lyricOverlay == null) {
            lyricOverlay = LyricOverlay.get(this);
            lyricOverlay.setCallback(new LyricOverlay.Callback() {
                /**
                 * 1.3.8：点一下浮层的「动作」已经全部由原生面板接管
                 * （见 LyricOverlay 的类注释），网页不用再弹底部面板了 ——
                 * 而且那个面板这时候也看不见：用户既然在点状态栏歌词，
                 * 就说明他正在用别的 App，WebView 是后台状态。
                 *
                 * 所以这里只打一条日志：它同时是「原生面板打开/收起」
                 * 这一跳的痕迹，排查「点了没反应」时有它就能分清
                 * 是触摸没进来、还是面板建不出来。
                 */
                @Override
                public void onTap() {
                    LogBridge.add(MainActivity.this, "LYRIC", "overlay tap (native panel)");
                }

                /**
                 * 拖动结束。x/y 是**歌词左上角**的屏幕坐标（不是窗口原点）——
                 * 面板打开时窗口原点被 padding 平移过，这里由 LyricOverlay
                 * 负责换算好再送上来，网页照旧直接落盘即可。
                 */
                @Override
                public void onMoved(int x, int y) {
                    runJs("window.__rippleLyricMoved && window.__rippleLyricMoved(" + x + "," + y + ")");
                }

                /** 面板里改了颜色/字号 → 网页落盘（原生侧已经先应用了） */
                @Override
                public void onStyle(String colorHex, String sizeSp) {
                    runJs("window.__rippleLyricStyle && window.__rippleLyricStyle("
                            + jsStr(colorHex) + "," + jsStr(sizeSp) + ")");
                    LogBridge.add(MainActivity.this, "LYRIC",
                            "panel style " + colorHex + " " + sizeSp + "sp");
                }

                /** 面板里点了「锁定」 → 网页存盘（原生侧 flags 已经落实） */
                @Override
                public void onLockChanged(boolean locked) {
                    runJs("window.__rippleLyricLock && window.__rippleLyricLock(" + locked + ")");
                    LogBridge.add(MainActivity.this, "LYRIC", "panel lock=" + locked);
                }

                /** 面板里点了 ✕ → 网页把「状态栏歌词」开关关掉（原生侧已 hide） */
                @Override
                public void onClose() {
                    runJs("window.__rippleLyricClose && window.__rippleLyricClose()");
                    LogBridge.add(MainActivity.this, "LYRIC", "panel close");
                }

                /** 媒体按钮：prev / toggle / next（与通知栏按钮走同一条网页入口） */
                @Override
                public void onCommand(String cmd) {
                    runJs("window.__rippleMediaCmd && window.__rippleMediaCmd(" + jsStr(cmd) + ")");
                }
            });
        }
        return lyricOverlay;
    }

    /** 有没有「显示在其他应用上层」权限 */
    boolean canDrawOverlay() {
        return LyricOverlay.canDraw(this);
    }

    /** 拉起系统的悬浮窗授权页 */
    void requestOverlayPermission() {
        try {
            Intent it = new Intent(android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    android.net.Uri.parse("package:" + getPackageName()));
            it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(it);
            LogBridge.add(this, "LYRIC", "request overlay permission");
        } catch (Throwable e) {
            CrashLog.recordAsync(this, "lyric-perm", e);
            try {
                Intent it = new Intent(android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION);
                it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(it);
            } catch (Throwable e2) {
                Toast.makeText(this, L10n.t("无法打开悬浮窗授权页，请到系统设置手动开启",
                        "Cannot open the overlay permission page; please enable it in system settings"),
                        Toast.LENGTH_LONG).show();
            }
        }
    }

    void showLyricOverlay(String locked, String colorHex, String sizeSp, String alpha,
                          String x, String y, String bold, String shadow,
                          String fill, String fillHex) {
        LyricOverlay o = overlay();
        o.configure(parseBool(locked, true), colorHex, sizeSp, alpha,
                x, y, parseBool(bold, true), parseBool(shadow, true),
                parseBool(fill, false), fillHex);
        o.show();
    }

    /** 进度 0..1，用于状态栏歌词的填充效果（兼容旧路径，不主动外推） */
    void setLyricProgress(String p) {
        if (lyricOverlay != null) lyricOverlay.setProgress(p);
    }

    /**
     * 设置进度基准点，让原生侧自己按时间外推（1.3.3 第三轮）。
     *
     * 见 LyricOverlay.setTiming 的注释：网页在后台时几乎推不动进度，
     * 必须由原生在这个场景下自己驱动，否则状态栏歌词就是「一句只染一次」。
     */
    void setLyricTiming(String progress, String lineDur, String rate, String playing) {
        LyricOverlay o = overlay();
        o.setTiming(progress, lineDur, rate, playing);
    }

    void updateLyricOverlay(String text) {
        LyricOverlay o = overlay();
        /*
         * 不判断 isShowing()：show() 是 post 到主线程的，紧接着来的第一句歌词
         * 很可能在浮层真正 addView 之前就到了。text 由 setText 自己存住，
         * show() 会用当前 text 初始化新 TextView，所以这里无条件交给它。
         */
        o.setText(text);
    }

    void hideLyricOverlay() {
        if (lyricOverlay != null) lyricOverlay.hide();
    }

    private static boolean parseBool(String v, boolean fallback) {
        if (v == null) return fallback;
        String s = v.trim().toLowerCase();
        if ("true".equals(s) || "1".equals(s)) return true;
        if ("false".equals(s) || "0".equals(s)) return false;
        return fallback;
    }

    /* ================= 媒体通知 ================= */

    /**
     * 把网页的播放状态同步到通知栏。
     * 第一次收到时启动前台服务（只有前台服务的媒体通知才能固定在通知栏、
     * 并且能接锁屏和耳机键的控制）。
     *
     * R-10：本方法的调用方是 WebView 的 JS 桥线程，而 PlaybackService 里的
     * title / position / playing 等字段只在主线程读写。所以这里先把整段工作
     * post 到主线程，绝不在桥线程里直接改服务的状态。
     */
    void updateMediaNotification(final String title, final String artist, final String album,
                                 final String coverUrl, final String durationMs,
                                 final String positionMs, final boolean playing) {
        runOnUiThread(() -> applyMediaNotification(title, artist, album, coverUrl,
                durationMs, positionMs, playing));
    }

    private void applyMediaNotification(String title, String artist, String album,
                                        String coverUrl, String durationMs,
                                        String positionMs, boolean playing) {
        try {
            /*
             * A-6：Android 13+ 没授通知权限时前台服务照常跑，但通知栏什么都不显示，
             * 用户既没有锁屏控件也没有耳机键，还完全不知道为什么。
             * 第一次真正开始播放时用非阻断方式（Toast，不弹权限框）提示一次。
             */
            if (playing) hintNotifyOnce();
            // 每次上报都重新绑定：Activity 重建后旧的 Sink 已经是弱引用，会随时被回收
            PlaybackService.setSink(mediaSink);
            if (!PlaybackService.isRunning()) {
                Intent it = new Intent(this, PlaybackService.class);
                boolean started = false;
                try {
                    startForegroundService(it);
                    started = true;
                } catch (Throwable e) {
                    // R-12：失败原因要留痕，否则通知永久消失且无声无息
                    CrashLog.recordMessageAsync(this, "media-fgs",
                            "startForegroundService 被拒: " + e);
                    LogBridge.add(this, "MEDIA", "startForegroundService failed: " + e);
                }
                if (!started) {
                    try {
                        startService(it);
                        started = true;
                    } catch (Throwable e2) {
                        CrashLog.recordMessageAsync(this, "media-svc",
                                "startService 也失败: " + e2);
                        LogBridge.add(this, "MEDIA", "startService failed: " + e2);
                        /*
                         * 服务起不来（省电策略 / 后台启动限制）。
                         *
                         * J-03 说明：这里发的 **window.__rippleMediaUnavailable(原因)**
                         * 以前是「Java 在调、前端根本没定义」的死通道。现在保留调用，
                         * 由前端注册同名函数来接（形状见回调下方注释）：
                         *   参数：1 个字符串 = 失败原因的类型名（如 "SecurityException"），
                         *         仅用于日志/排查，界面文案不必依赖它；
                         *   时机：startForegroundService 与 startService **双双**失败时，
                         *         每次这样的上报都会调一次（本函数每秒可能被调一次，
                         *         前端自己要按原因去重，别每秒弹一条 toast）；
                         *   语义：通知栏/锁屏控制这次彻底起不来了，网页侧该提示
                         *         「后台播放受系统限制，回到 App 内恢复」。
                         * 前端没注册时 `window.__rippleMediaUnavailable &&` 短接，
                         * 不会报错 —— 所以这条调用可以安全地一直留着。
                         */
                        replyToWebQuietly("window.__rippleMediaUnavailable && "
                                + "window.__rippleMediaUnavailable('" + e2.getClass().getSimpleName() + "')");
                        return;
                    }
                }
                /*
                 * J-02：服务刚起时 PlaybackService.get() 还是 null，而这条上报携带的是
                 * **唯一一次**完整元数据（title/artist/album/cover）—— 后续每秒的
                 * mediaProgress 只带进度。以前这里只等固定 260ms，服务 onCreate 稍慢
                 * （低端机、系统忙、通知渠道首次创建）就永久丢掉标题，通知栏在整首歌
                 * 期间都停在「Ripple 涟漪 · 未在播放」，而且没有任何自愈。
                 *
                 * 改成带上限的重试：50ms 起每次翻倍（50/100/200/400/800/1600ms，
                 * 最坏累计约 3.2 秒），足以覆盖服务冷启动的常见耗时；仍拿不到就
                 * 记一条日志放弃 —— 不做无限轮询（每秒都有新的 progress 上报，
                 * 不会把播放本身卡住）。
                 */
                scheduleMediaStateRetry(title, artist, album, coverUrl,
                        durationMs, positionMs, playing, 0);
                return;
            }
            PlaybackService svc = PlaybackService.get();
            if (svc != null) svc.update(title, artist, album, coverUrl, durationMs, positionMs, playing);
        } catch (Throwable e) {
            CrashLog.recordAsync(this, "media-notif", e);
        }
    }

    /**
     * J-02：把首条完整 mediaState 交给服务，最多重试 {@code MEDIA_STATE_MAX_TRIES} 次。
     * 只在「刚把服务拉起来、实例还没就绪」这条路上用；服务已经在跑时直接写状态。
     */
    private static final int MEDIA_STATE_MAX_TRIES = 6;

    private void scheduleMediaStateRetry(final String title, final String artist,
                                         final String album, final String coverUrl,
                                         final String durationMs, final String positionMs,
                                         final boolean playing, final int attempt) {
        PlaybackService svc = PlaybackService.get();
        if (svc != null) {
            svc.update(title, artist, album, coverUrl, durationMs, positionMs, playing);
            return;
        }
        if (attempt >= MEDIA_STATE_MAX_TRIES) {
            LogBridge.add(this, "MEDIA", "服务启动后 " + MEDIA_STATE_MAX_TRIES
                    + " 次重试仍拿不到实例，首条元数据放弃（后续 progress 仍会驱动通知）");
            return;
        }
        long delay = 50L << attempt;   // 50 / 100 / 200 / 400 / 800 / 1600
        new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> {
            try {
                scheduleMediaStateRetry(title, artist, album, coverUrl,
                        durationMs, positionMs, playing, attempt + 1);
            } catch (Throwable ignored) {
            }
        }, delay);
    }

    /** 给网页推一段 JS（已经在主线程时也能安全调用） */
    private void replyToWebQuietly(final String code) {
        runOnUiThread(() -> {
            try {
                if (web != null) web.evaluateJavascript(code, null);
            } catch (Throwable ignored) {
            }
        });
    }

    void updateMediaProgress(final String positionMs, final String durationMs, final boolean playing) {
        // R-10：同样先回主线程，服务字段只在主线程访问
        runOnUiThread(() -> {
            try {
                PlaybackService svc = PlaybackService.get();
                if (svc != null) svc.updateProgress(positionMs, durationMs, playing);
            } catch (Throwable e) {
                /* 进度更新失败不打扰 */
            }
        });
    }

    /**
     * 第一次播放且没有通知权限时，只提示一次（用 Toast，非阻断，不弹权限框）。
     * 是否已提示过记在 SharedPreferences 里，重装/清数据前不会重复骚扰。
     */
    private void hintNotifyOnce() {
        // 这个回调来自 WebView 的 JS 桥线程（没有 Looper），Toast 必须回主线程弹
        runOnUiThread(() -> {
            try {
                if (hasNotificationPermission()) return;
                SharedPreferences sp = getSharedPreferences("ripple", MODE_PRIVATE);
                if (sp.getBoolean("notify_hint_done", false)) return;
                sp.edit().putBoolean("notify_hint_done", true).apply();
                Toast.makeText(this, L10n.t("允许通知才能用锁屏/耳机控制（设置 → 通知）",
                        "Allow notifications for lock screen and headset controls (Settings → Notifications)"),
                        Toast.LENGTH_LONG).show();
            } catch (Throwable ignored) {
            }
        });
    }

    /** 通知权限（Android 13 以下看通知总开关） */
    private boolean hasNotificationPermission() {
        try {
            NotificationManager nm =
                    (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm == null || !nm.areNotificationsEnabled()) return false;
            if (Build.VERSION.SDK_INT < 33) return true;
            return checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                    == PackageManager.PERMISSION_GRANTED;
        } catch (Throwable e) {
            return false;
        }
    }

    /** 通知栏按钮 → 网页 */
    private final PlaybackService.Sink mediaSink = new PlaybackService.Sink() {
        @Override
        public void onMediaCommand(String cmd) {
            runJs("window.__rippleMediaCmd && window.__rippleMediaCmd(" + jsStr(cmd) + ")");
        }

        @Override
        public void onSeekTo(long ms) {
            runJs("window.__rippleMediaSeek && window.__rippleMediaSeek(" + ms + ")");
        }
    };

    /**
     * 在网页里执行一段 JS。
     *
     * 包内可见（不是 private）：HttpBridge 的「检查更新」链路要从后台线程
     * 把结果推回网页（window.__rippleUpdate* 回调），需要调它。
     * 内部已经切到 UI 线程并吞掉异常，调用方不用担心线程问题。
     */
    void runJs(final String code) {
        runOnUiThread(() -> {
            try {
                if (web != null) web.evaluateJavascript(code, null);
            } catch (Throwable ignored) {
            }
        });
    }

    /** 简单的 JS 字符串字面量转义 */
    private static String jsStr(String s) {
        if (s == null) return "''";
        return "'" + s.replace("\\", "\\\\").replace("'", "\\'").replace("\n", " ") + "'";
    }

    /** 网页是否正在播放音频（由 JS 通过 setPlaying 上报） */
    private volatile boolean webPlaying = false;
    /**
     * 后台冻结计时器的「票号」（见 setWebPlaying 的说明）。
     * 每次状态变化自增；延迟冻结执行时票号对不上就说明期间状态又变了，直接放弃。
     */
    private int pauseToken = 0;
    /**
     * 后台暂停后多久才真正冻结 WebView 计时器（毫秒）。
     *
     * 存在的理由：一首歌自然播完时浏览器会先发 pause，而我们同一个事件循环里
     * 已经在播下一首了。立刻冻结会把「进度推进 / 通知栏刷新 / 播完续下一首」
     * 的定时器冻死，表现为「后台播完到下一首不开始」。
     * 1500ms 足够覆盖「解析下一首地址 + 起播」这条链路，又不会让假暂停
     * 一直骗着系统不省电。
     */
    private static final long ADVANCE_GRACE_MS = 1500;
    /** Activity 是否在前台（onResume / onPause 维护，供 J-09 判断要不要补 pauseTimers） */
    private volatile boolean isForeground = false;

    void setWebPlaying(boolean playing) {
        webPlaying = playing;
        /*
         * J-09：补上一次「后台暂停」漏掉的 pauseTimers()。
         *
         * onPause 是按**当时**的 webPlaying 决定要不要暂停计时器的。
         * 常见路径是：切到后台（当时在播 → 不暂停计时器，正确），
         * 然后用户在通知栏/耳机键上按了暂停 —— 这时 Activity 已经在后台，
         * onPause 不会再跑，于是「该暂停计时器」的时机永远不会出现，
         * WebView 的 setInterval 在后台一直空转，正好把这段代码想省的电耗回去。
         *
         * 所以状态翻转就补判一次：不在前台且已停止播放 → 立刻暂停计时器。
         * 回到前台时 onResume 会 resumeTimers()，不会把播放逻辑长期冻住。
         *
         * 反方向同样要处理（否则上面这一步会挖出新坑）：
         * 后台暂停 → 计时器被 pauseTimers() 停掉 → 用户又从通知栏点了播放，
         * 这时播放动作是 evaluateJavascript 送进来的（能执行），
         * 但驱动「进度推进 / 播完自动下一首」的 setInterval 仍然是暂停的 ——
         * 表现为「回到播放态但进度条不动、一首放完就没声」。
         * 所以恢复播放时，只要还没回前台就补一次 resumeTimers()。
         */
        /*
         * 后台「暂停」时延迟一小会儿再冻结计时器。
         *
         * 一首歌自然播完时浏览器的时序是「ended → paused=true（可能补发
         * pause）→ 我们立刻去播下一首」。如果在这中间立刻 pauseTimers()，
         * 驱动「进度推进 / 通知栏刷新 / 播完续下一首」的定时器会被冻住，
         * 而下一首的解析往往还要走异步原生通道 + 跨桥 —— 结果就是
         * 「后台播完到下一首不开始」。
         *
         * 这里给一个宽限窗口：暂停后过 ADVANCE_GRACE_MS 仍然是暂停态才真正冻结。
         * 切歌途中（几百毫秒内）状态一定会翻回 playing，这次冻结就被取消了。
         * 同时冻结动作本身也带条件复查，避免「定时器已到期但状态已经变了」
         * 的竞态。
         */
        if (!playing && !isForeground) {
            final int token = ++pauseToken;
            runOnUiThread(() -> {
                try {
                    /*
                     * 真正的冻结延迟到宽限窗口之后执行。
                     * 自然播完→自动下一首的间隔通常只有几十到几百毫秒，
                     * 期间状态会翻回 playing，这次冻结随之作废。
                     */
                    if (web == null) return;
                    web.postDelayed(() -> {
                        try {
                            if (web == null || webPlaying || isForeground || token != pauseToken) return;
                            web.pauseTimers();
                            LogBridge.add(this, "WEB", "后台且未在播，暂停 WebView 计时器");
                        } catch (Throwable ignored) {
                        }
                    }, ADVANCE_GRACE_MS);
                } catch (Throwable ignored) {
                }
            });
        } else if (playing && !isForeground) {
            /*
             * 恢复播放时无条件 resumeTimers()。
             *
             * 以前这里有 `&& webPlaying` 复查，看似无害，但后台「通知栏点播放」
             * 这条路上 webPlaying 刚刚被 setWebPlaying(true) 设过、
             * 而 pauseTimers 可能在前一轮已经执行 —— 只要有任何一次时序错位，
             * 计时器就永久停在暂停，表现为「在放但进度不动 / 一首完就没声」。
             * 进来这个分支本身就说明「应该恢复」，直接 resume 更安全：
             * resumeTimers() 对未暂停的 WebView 是幂等的。
             */
            runOnUiThread(() -> {
                try {
                    if (web != null && !isForeground) web.resumeTimers();
                } catch (Throwable ignored) {
                }
            });
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        isForeground = false;
        /*
         * 通知状态栏歌词浮层「App 已切到后台」。
         *
         * 现在前后台**都用 Handler 驱动**（Choreographer 已在早期重构中删除，
         * 见 LyricOverlay 里那句「Choreographer 相关字段已全部删除」）。
         * 那为什么还要告诉浮层前后台？因为它在切驱动点会做一次
         * stopTick() + scheduleTick()：重新排一次帧，顺带把可能已经断掉的
         * 驱动链（例如暂停期间 return false 停掉的那条）拉起来。
         * 这是浮层自己决定的，App 侧只负责把这个状态变化告诉它。
         */
        try {
            LyricOverlay o = LyricOverlay.peek();
            if (o != null) o.setAppBackground(true);
        } catch (Throwable ignored) {
        }
        try {
            if (web != null) {
                /*
                 * 切到后台要停掉 WebView 的计时器。
                 * 原来这里调的是 resumeTimers()（等于在后台继续「恢复」计时器）：
                 * 网页里的 setInterval(1000) 会一直在后台写 localStorage、
                 * requestAnimationFrame 也继续跑，白耗电。
                 *
                 * 例外：正在播放时不暂停计时器 —— 网页要靠 setInterval 驱动
                 * 「播完自动下一首」和进度保存，停了就变成一首放完就没声了。
                 * 这个例外也带来 J-09 那个坑：如果用户是「切后台之后」才从通知栏
                 * 暂停的，onPause 早就跑过去了，pauseTimers() 永远不会被补上，
                 * 计时器一直空转到回前台。补的时机在 setWebPlaying()（见那里）。
                 */
                if (!webPlaying) {
                    web.onPause();
                    web.pauseTimers();
                }
            }
        } catch (Throwable ignored) {
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        isForeground = true;
        /*
         * 回到前台：把状态同步给歌词浮层，让它重排一次驱动
         * （前后台都用 Handler 驱动，Choreographer 已在早期重构中删除；
         *   这个回调的实际作用是「重新 scheduleTick，把可能断掉的驱动链拉起来」）。
         */
        try {
            LyricOverlay o = LyricOverlay.peek();
            if (o != null) o.setAppBackground(false);
        } catch (Throwable ignored) {
        }
        try {
            if (web != null) {
                web.resumeTimers();
                web.onResume();
            }
        } catch (Throwable ignored) {
        }
        measureAndPushInsets();
    }

    @Override
    protected void onDestroy() {
        isForeground = false;
        /*
         * E-06：退出 App 必须把前台服务一起停掉。
         *
         * 以前只清掉 Sink，服务本身还在跑 —— 于是通知栏留下一条滑不掉、
         * 按钮全失效的「正在播放」，进程还被 FGS 保活。前端从不调 mediaStop()，
         * 所以这条兜底必须由 Activity 自己收尾。
         *
         * 顺序：先 Stop 服务（撤通知 + stopForeground），再拆 WebView。
         * stopService 是幂等的：服务没起时什么都不发生。
         * 同时清掉残留通知（服务若已被系统回收，stopService 也收不掉那条通知）。
         *
         * J-01 ③：这条退出路径也是「FGS 没坐实就退」的高危点 ——
         * startForegroundService() 已经发出去、startForeground 还没成功时用户就退出，
         * 系统记的那笔「5 秒内必须 startForeground」的账不会因为 stopService 消失。
         * stopAndQuit()（上面那次调用）内部会先补一次 enterForeground 再收尾；
         * 但如果服务实例已经拿不到（get() == null），就只剩下面这层兜底 ——
         * 保留这次调用顺序：先 setSink(null) → stopService → stopAndQuit，
         * stopAndQuit 里的补前台动作才是真正销账的那一步。
         */
        try {
            PlaybackService.setSink(null);
        } catch (Throwable ignored) {
        }
        try {
            stopService(new Intent(this, PlaybackService.class));
        } catch (Throwable ignored) {
        }
        try {
            PlaybackService svc = PlaybackService.get();
            if (svc != null) svc.stopAndQuit();
        } catch (Throwable ignored) {
        }
        cancelPlaybackNotification();

        // A-2：歌词浮层是静态单例，不主动收掉的话它会留在桌面上变成一个关不掉的幽灵窗口
        try {
            LyricOverlay o = LyricOverlay.peek();
            if (o != null) {
                o.setCallback(null);
                o.hide();
            }
            lyricOverlay = null;
        } catch (Throwable ignored) {
        }
        /*
         * R-02：WebView 必须先 detach 再 destroy。
         * 直接把一个还挂在 View 树上的 WebView destroy 掉，某些 ROM 上会在
         * 后续绘制/输入分发时崩（渲染进程已经没了，但 View 还认为自己活着）。
         * 顺序：stopLoading() → loadUrl("about:blank") → removeView → destroy()。
         */
        destroyWeb();
        webRoot = null;
        /*
         * C-10：正常退出时把内存里还没落盘的那段运行日志写下去。
         *
         * 以前只有显式 logFlush 才会写盘，于是「用户点返回退出」这条最常见的路径上，
         * 最后若干条日志（包括这次退出的原因链）直接随进程消失 ——
         * 用户反馈「放着放着没声了」时，日志恰好停在事故发生之前。
         * LogBridge.flush 是**异步**的（排给它的守护线程），调用点不会拖慢退出；
         * 它也可能早就 forceWrite 过（内容没变就跳过），重复调用是幂等的。
         *
         * 顺序放在这里而不是更前面：前面的服务/浮层收尾本身还会产生日志，
         * 等它们都写完再 flush 才能一并带上。
         */
        try {
            LogBridge.flush(this);
        } catch (Throwable ignored) {
        }
        super.onDestroy();
    }

    /** 撤掉播放通知（服务已经被系统回收时也能清干净） */
    private void cancelPlaybackNotification() {
        try {
            NotificationManager nm =
                    (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm != null) nm.cancel(PlaybackService.NOTIF_ID);
        } catch (Throwable ignored) {
        }
    }

    /** 停下来 → 卸载 → 销毁，任何一步失败都不影响后面 */
    private void destroyWeb() {
        final WebView w = web;
        web = null;
        if (w == null) return;
        try {
            w.stopLoading();
        } catch (Throwable ignored) {
        }
        try {
            w.loadUrl("about:blank");
        } catch (Throwable ignored) {
        }
        try {
            ViewGroup parent = (ViewGroup) w.getParent();
            if (parent != null) parent.removeView(w);
        } catch (Throwable ignored) {
        }
        try {
            w.destroy();
        } catch (Throwable ignored) {
        }
    }

    /**
     * O-04：系统内存吃紧时主动让出内存。
     *
     * TRIM_MEMORY_RUNNING_LOW 及以上（= 更紧急）时：
     *   · 清掉 WebView 的缓存（页面资源在本地 assets 里，清了不影响离线可用）
     *   · 释放 PlaybackService 里缓存的封面位图（重新播放时会再下载）
     * 不清 DOM storage / localStorage —— 那里放着登录态之外的播放列表与设置。
     */
    @Override
    public void onTrimMemory(int level) {
        super.onTrimMemory(level);
        if (level < android.content.ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW) return;
        try {
            if (web != null) web.clearCache(true);
        } catch (Throwable ignored) {
        }
        try {
            PlaybackService svc = PlaybackService.get();
            if (svc != null) svc.releaseCover();
        } catch (Throwable ignored) {
        }
        LogBridge.add(this, "MEM", "onTrimMemory level=" + level + "，已释放 WebView 缓存与封面");
    }

    /** 极简纵向布局，避免依赖 android.widget.LinearLayout 的泛型用法 */
    private static final class LinearLayoutCompat extends android.widget.LinearLayout {
        LinearLayoutCompat(Activity a) {
            super(a);
            setOrientation(VERTICAL);
            setGravity(Gravity.START);
        }
    }
}
