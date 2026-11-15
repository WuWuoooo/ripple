package com.ripple.app;

import android.app.Activity;
import android.content.Intent;
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

/**
 * Ripple · Android 外壳（v1.1.1）
 *
 * 与 1.1.0 的区别：不再「崩了什么都不显示」。
 *   - Application 里装了全局崩溃捕获（RippleApp + CrashLog），
 *     堆栈会写到 私有 files/crash-*.txt 和「下载/Ripple-crash-*.txt」
 *   - 所有窗口/WebView 设置都包了 try-catch，任何一步失败都降级继续
 *   - 起不来时在界面上直接显示错误文本（而不是白屏/闪退）
 *   - 连续两次启动异常 → 自动进 safeMode（关掉边缘到边缘与 insets 注入）
 */
public class MainActivity extends Activity {

    private static final int REQ_FILE = 0x51;
    private static final int REQ_NOTIFY = 0x52;

    private WebView web;
    private ValueCallback<Uri[]> filePathCallback;
    private NeteaseClient netease;
    private WebView loginWeb;
    private FrameLayout loginLayer;
    /** 已提交验证的 MUSIC_U，避免同一 token 反复验证 */
    private String loginVerifiedToken;
    private long loginLastVerifyAt;
    /** 打开登录页那一刻的 cookie 快照：只有出现「新的 MUSIC_U」才算登录成功 */
    private String loginBaseline = "";
    private long loginOpenedAt = 0;
    private final String pendingLoginCb = "loginCb";
    private boolean pageLoaded = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        CrashLog.installQuietly(this);
        CrashLog.step(this, "onCreate begin, sdk=" + Build.VERSION.SDK_INT
                + " safeMode=" + StrictModes.safeMode);
        LogBridge.add(this, "UI", "onCreate, safeMode=" + StrictModes.safeMode);

        try {
            setupWindow();
            CrashLog.step(this, "window ok");
        } catch (Throwable e) {
            CrashLog.record(this, "window", e);
        }

        if (Build.VERSION.SDK_INT >= 19 && !StrictModes.safeMode) {
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
            CrashLog.record(this, "assets-missing", e);
        }

        try {
            netease = new NeteaseClient(this);
            CrashLog.step(this, "netease client ok");
        } catch (Throwable e) {
            CrashLog.record(this, "netease-init", e);
        }

        try {
            buildUi();
            CrashLog.step(this, "buildUi ok");
        } catch (Throwable e) {
            CrashLog.record(this, "webview-init", e);
            showFatal("WebView 初始化失败", e);
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
                CrashLog.record(this, "edge-to-edge", e);
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

    /** 安全区推给网页（0dp 时网页用自己的 fallback） */
    private void pushInsets(int top, int bottom, int left, int right) {
        if (web == null) return;
        float d = getResources().getDisplayMetrics().density;
        String code = "(function(){try{var r=document.documentElement.style;"
                + "r.setProperty('--safe-t','" + (top / d) + "px');"
                + "r.setProperty('--safe-b','" + (bottom / d) + "px');"
                + "r.setProperty('--safe-l','" + (left / d) + "px');"
                + "r.setProperty('--safe-r','" + (right / d) + "px');"
                + "document.documentElement.classList.add('native');}catch(e){}})();";
        runOnUiThread(() -> {
            try {
                if (web != null) web.evaluateJavascript(code, null);
            } catch (Throwable ignored) {
            }
        });
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
            LogBridge.add(this, "INSETS", "t=" + top + " b=" + bottom + " l=" + left + " r=" + right);
            pushInsets(top, bottom, left, right);
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

    private void buildUi() {
        CrashLog.step(this, "creating WebView");
        web = new WebView(this);
        CrashLog.step(this, "WebView created");
        WebSettings s = web.getSettings();
        safe(() -> s.setJavaScriptEnabled(true));
        safe(() -> s.setDomStorageEnabled(true));
        safe(() -> s.setDatabaseEnabled(true));
        safe(() -> s.setMediaPlaybackRequiresUserGesture(false));
        safe(() -> s.setAllowFileAccess(true));
        safe(() -> s.setAllowContentAccess(true));
        /*
         * file:// 页面能读任意本地文件、还能跨域 fetch 任意站点，
         * 这两个开关一旦打开，配合 addJavascriptInterface 暴露的
         * cookie()/httpGet()，攻击面就大得没必要 —— App 里根本没有跨域 file:// 需求。
         * 只保留 setAllowFileAccess（读自身 assets 需要）。
         */
        safe(() -> s.setAllowFileAccessFromFileURLs(false));
        safe(() -> s.setAllowUniversalAccessFromFileURLs(false));
        safe(() -> s.setLoadWithOverviewMode(true));
        safe(() -> s.setUseWideViewPort(true));
        safe(() -> s.setCacheMode(WebSettings.LOAD_DEFAULT));
        safe(() -> s.setJavaScriptCanOpenWindowsAutomatically(true));
        safe(() -> s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW));
        // UA 里的版本号跟真实 APK 对齐（以前写死 1.1.1，和实际 1.3.x 差了好几个版本）
        safe(() -> s.setUserAgentString(s.getUserAgentString() + " RippleApp/" + versionName()));

        if (!StrictModes.safeMode) {
            try {
                CookieManager.getInstance().setAcceptCookie(true);
                CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);
            } catch (Throwable e) {
                CrashLog.record(this, "cookie-init", e);
            }
        }

        try {
            web.setBackgroundColor(Color.parseColor("#07070b"));
            web.setOverScrollMode(View.OVER_SCROLL_NEVER);
            web.addJavascriptInterface(new HttpBridge(this, netease), "RippleNative");
        } catch (Throwable e) {
            CrashLog.record(this, "bridge", e);
        }

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                String scheme = u.getScheme() == null ? "" : u.getScheme();
                if ("file".equals(scheme) || "about".equals(scheme)) return false;
                if (scheme.startsWith("http") && "localhost".equals(u.getHost())) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (Exception ignored) {
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                pageLoaded = true;
                CrashLog.step(MainActivity.this, "onPageFinished " + url);
                measureAndPushInsets();
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                // 渲染进程被杀（大内存/系统回收）不能让整个 App 一起死
                CrashLog.recordMessage(MainActivity.this, "render-gone",
                        "WebView renderer gone, didCrash=" + (detail != null && detail.didCrash()));
                showFatal("页面渲染进程被系统回收", null);
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, android.webkit.WebResourceError err) {
                if (req != null && req.isForMainFrame()) {
                    CrashLog.recordMessage(MainActivity.this, "page-error",
                            "主页面加载失败: " + err.getErrorCode() + " " + err.getDescription()
                                    + " url=" + req.getUrl());
                }
            }
        });

        try {
            web.setWebChromeClient(new WebChromeClient() {
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
                        startActivityForResult(Intent.createChooser(i, "选择音频文件"), REQ_FILE);
                        return true;
                    } catch (Exception e) {
                        filePathCallback = null;
                        return false;
                    }
                }
            });
        } catch (Throwable ignored) {
        }

        FrameLayout root = new FrameLayout(this);
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));
        setContentView(root);
        CrashLog.step(this, "contentView set");

        // edge-to-edge：必须把真实 insets 转给网页，否则顶部会被状态栏压住
        try {
            web.setOnApplyWindowInsetsListener((v, insets) -> {
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
                pushInsets(top, bottom, left, right);
                return insets;
            });
        } catch (Throwable ignored) {
        }

        CrashLog.step(this, "loading index.html");
        web.loadUrl("file:///android_asset/www/index.html");

        // 页面脚本可能晚于 insets 回调执行，补推几次
        web.postDelayed(this::measureAndPushInsets, 300);
        web.postDelayed(this::measureAndPushInsets, 1200);
        web.postDelayed(this::measureAndPushInsets, 2600);

        // 启动成功：清掉连续失败计数
        web.postDelayed(() -> {
            if (pageLoaded) {
                try {
                    getSharedPreferences("ripple", MODE_PRIVATE).edit()
                            .putInt("boot_streak", 0).apply();
                } catch (Throwable ignored) {
                }
            }
        }, 3000);
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
            h.setText("Ripple 启动出错\n" + title);
            h.setTextColor(Color.parseColor("#ff8fa3"));
            h.setTextSize(18f);

            TextView body = new TextView(this);
            body.setText((trace == null ? "" : trace)
                    + "\n\n堆栈已写入「下载」目录的 Ripple-crash-*.txt");
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
        try {
            Window w = getWindow();
            /*
             * edge-to-edge 模式下，状态栏/导航栏必须保持全透明：
             * 那样显示出来的就是网页自己的背景渐变，颜色天然和页面一致。
             * 如果把这里刷成某个固定色，反而会重新出现「上下两条不一样」的问题。
             */
            if (Build.VERSION.SDK_INT >= 21) {
                w.setStatusBarColor(Color.TRANSPARENT);
                w.setNavigationBarColor(Color.TRANSPARENT);
                w.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
            }
            LogBridge.add(this, "BARS", "transparent, lightIcons=" + lightIcons
                    + " (hint color=" + statusHex + ")");
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
        } catch (Throwable e) {
            CrashLog.record(this, "system-bars", e);
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

    /* ================= 网易云登录 ================= */

    /**
     * 打开网易云官方登录页。
     *
     * @param mode "phone" = 手机号登录（移动版页面），"qr" = 扫码登录（桌面版页面）
     *
     * 之前「弹出就自动回去」的原因：onPageFinished 一触发就去读 cookie，
     * 而 CookieManager 里还留着上次的 MUSIC_U（甚至游客态也会写），
     * 于是立刻判定「已登录」把页面关了。现在改成：
     *   1. 打开前先记下当前 cookie 快照（并清掉旧登录态）
     *   2. 只有读到「和快照不同」的 MUSIC_U 才算成功
     *   3. 还要真的拿到 profile 才关页面
     */
    void openLogin(final String mode, final String cbId) {
        runOnUiThread(() -> {
            try {
                if (loginLayer != null || web == null) return;
                ViewGroup parent = (ViewGroup) web.getParent();
                if (parent == null) return;

                boolean qr = "qr".equals(mode);

                // 先清掉旧的登录态，避免残留 cookie 让登录页瞬间被判成功
                try {
                    CookieManager cm = CookieManager.getInstance();
                    String old = cm.getCookie("https://music.163.com");
                    loginBaseline = muscU(old);
                    if (loginBaseline != null) {
                        // 主动置空：下一次写进来的才是真登录
                        cm.setCookie("https://music.163.com", "MUSIC_U=; Max-Age=0; Path=/");
                    }
                    cm.flush();
                } catch (Throwable ignored) {
                }
                loginOpenedAt = System.currentTimeMillis();
                LogBridge.add(this, "LOGIN", "open mode=" + mode + " baseline="
                        + (loginBaseline == null ? "none" : "had"));

                loginLayer = new FrameLayout(this);
                loginLayer.setBackgroundColor(Color.parseColor("#0a0a10"));

                loginWeb = new WebView(this);
                WebSettings ls = loginWeb.getSettings();
                safe(() -> ls.setJavaScriptEnabled(true));
                safe(() -> ls.setDomStorageEnabled(true));
                safe(() -> ls.setDatabaseEnabled(true));
                safe(() -> ls.setLoadWithOverviewMode(true));
                safe(() -> ls.setUseWideViewPort(true));
                safe(() -> ls.setSupportZoom(false));
                safe(() -> ls.setBuiltInZoomControls(false));
                if (Build.VERSION.SDK_INT >= 21) {
                    safe(() -> ls.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW));
                    try {
                        CookieManager.getInstance().setAcceptThirdPartyCookies(loginWeb, true);
                    } catch (Throwable ignored) {
                    }
                }
                // 二维码在桌面版页面里最完整；手机号登录用移动版页面
                safe(() -> ls.setUserAgentString(qr
                        ? "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
                          + "Chrome/124.0.0.0 Safari/537.36"
                        : "Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) "
                          + "Chrome/124.0.0.0 Mobile Safari/537.36"));

                loginWeb.setWebViewClient(new WebViewClient() {
                    @Override
                    public void onPageFinished(WebView view, String url) {
                        super.onPageFinished(view, url);
                        LogBridge.add(MainActivity.this, "LOGIN", "page finished " + url);
                        harvestLogin(cbId);
                    }

                    /**
                     * 只在网易云域名里跳转。
                     * 以前没有这个钩子：登录页里任何外链（用户协议、帮助中心、
                     * 甚至广告）都会把整个登录层带到别的站点，
                     * 而登录层没有地址栏也没有返回键，用户就卡在那儿了。
                     */
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView view, String url) {
                        if (url == null) return false;
                        if (url.contains("music.163.com") || url.contains("126.net")
                                || url.startsWith("about:") || url.startsWith("javascript:")) {
                            return false;
                        }
                        LogBridge.add(MainActivity.this, "LOGIN", "block external nav " + url);
                        return true;   // 拦掉站外跳转，留在登录页
                    }
                });

                loginLayer.addView(loginWeb, new FrameLayout.LayoutParams(-1, -1));
                parent.addView(loginLayer, new FrameLayout.LayoutParams(-1, -1));
                loginWeb.loadUrl(qr
                        ? "https://music.163.com/#/login"
                        : "https://music.163.com/login?targetUrl=%2F");
                startLoginPoll(cbId);
            } catch (Throwable e) {
                CrashLog.record(this, "login-open", e);
                closeLogin();
                replyToWeb(cbId, "{\"code\":-1,\"msg\":\"登录页打不开\"}");
            }
        });
    }

    /** 从 cookie 串里取 MUSIC_U 的值 */
    private static String muscU(String cookies) {
        if (cookies == null) return null;
        for (String part : cookies.split(";")) {
            String p = part.trim();
            if (p.startsWith("MUSIC_U=")) {
                String v = p.substring(8).trim();
                return v.isEmpty() ? null : v;
            }
        }
        return null;
    }

    /** 登录页是半 SPA，扫码成功后不一定再触发 onPageFinished，所以轮询 cookie */
    /**
     * 登录轮询。
     *
     * 以前每 900ms 无上限地跑，直到用户关掉登录层。而每次 harvestLogin 命中新
     * cookie 都会起一个线程跑 status()（内部 4 个 POST）。用户把登录页晾在那儿时，
     * cookie 被服务端反复刷新 → 反复起线程、反复发请求。
     * 现在：总次数有上限（约 5 分钟），且两次 status 之间有去抖。
     */
    private void startLoginPoll(final String cbId) {
        final android.os.Handler h = new android.os.Handler(android.os.Looper.getMainLooper());
        final Runnable[] task = new Runnable[1];
        final int[] ticks = new int[]{0};
        final int MAX_TICKS = 340;      // 340 × 900ms ≈ 5 分钟
        task[0] = () -> {
            if (loginLayer == null) return;
            if (ticks[0]++ > MAX_TICKS) {
                LogBridge.add(this, "LOGIN", "poll timeout, stop checking");
                return;
            }
            try {
                harvestLogin(cbId);
            } catch (Throwable ignored) {
            }
            if (loginLayer != null) h.postDelayed(task[0], 900);
        };
        // 给登录页留出加载时间，别一打开就判
        h.postDelayed(task[0], 2000);
    }

    private void harvestLogin(final String cbId) {
        if (loginLayer == null) return;
        // 刚打开的前 1.2 秒不判定，等页面把旧 cookie 清干净
        if (System.currentTimeMillis() - loginOpenedAt < 1200) return;

        String cookies;
        try {
            cookies = CookieManager.getInstance().getCookie("https://music.163.com");
        } catch (Throwable e) {
            return;
        }
        String token = muscU(cookies);
        if (token == null) return;
        if (loginBaseline != null && token.equals(loginBaseline)) {
            // 还是旧的那个 cookie，说明用户还没真的登录
            return;
        }
        if (netease == null) return;

        netease.setCookie(cookies);
        /*
         * 去抖：这个新 token 已经验证过（成功或失败）就别再验一遍。
         * 轮询每 900ms 跑一次，cookie 不变的情况下以前会反复起线程。
         */
        if (token.equals(loginVerifiedToken)) return;
        if (System.currentTimeMillis() - loginLastVerifyAt < 4000) return;
        loginLastVerifyAt = System.currentTimeMillis();
        loginVerifiedToken = token;

        final String id = (cbId == null || cbId.isEmpty()) ? pendingLoginCb : cbId;
        LogBridge.add(this, "LOGIN", "got new MUSIC_U, verifying...");

        new Thread(() -> {
            String payload;
            boolean ok = false;
            try {
                payload = netease.call("status", null);
                ok = payload != null && payload.contains("\"profile\"") && !payload.contains("\"profile\":null");
            } catch (Throwable e) {
                CrashLog.record(MainActivity.this, "login-status", e);
                payload = "{\"code\":-1,\"msg\":\"登录后读取账号失败\"}";
            }
            LogBridge.add(MainActivity.this, "LOGIN", ok ? "verify ok" : "verify failed");
            if (!ok) {
                // cookie 有了但账号无效，保持页面开着让用户重试
                return;
            }
            runOnUiThread(MainActivity.this::closeLogin);
            replyToWeb(id, payload);
        }, "ripple-login").start();
    }

    private void closeLogin() {
        runOnUiThread(() -> {
            try {
                if (loginLayer == null) return;
                ViewGroup parent = (ViewGroup) loginLayer.getParent();
                if (parent != null) parent.removeView(loginLayer);
                if (loginWeb != null) {
                    loginWeb.loadUrl("about:blank");
                    loginWeb.destroy();
                    loginWeb = null;
                }
                loginLayer = null;
            } catch (Throwable ignored) {
                loginLayer = null;
                loginWeb = null;
            }
        });
    }

    void closeLoginFromWeb() {
        closeLogin();
    }

    void finishLoginFromWeb(String cbId) {
        // 用户手动点「我已登录」：跳过基线判定，直接验证当前 cookie
        loginBaseline = null;
        loginOpenedAt = 0;
        harvestLogin(cbId);
    }

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
        if (loginLayer != null) {
            closeLogin();
            return;
        }
        if (web == null) {
            super.onBackPressed();
            return;
        }
        try {
            web.evaluateJavascript(
                    "(function(){var n=document.getElementById('np');"
                            + "if(n&&n.classList.contains('open')){document.getElementById('npClose').click();return 'handled';}"
                            + "var s=document.getElementById('searchInput');"
                            + "if(s&&document.activeElement===s){s.blur();return 'handled';}"
                            + "return 'exit';})()",
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
    }

    /* ================= 状态栏歌词浮层 ================= */

    private LyricOverlay lyricOverlay;

    private LyricOverlay overlay() {
        if (lyricOverlay == null) {
            lyricOverlay = LyricOverlay.get(this);
            lyricOverlay.setCallback(new LyricOverlay.Callback() {
                @Override
                public void onTap() {
                    // 未锁定时点一下 → 网页弹调整面板
                    runJs("window.__rippleLyricTap && window.__rippleLyricTap()");
                }

                @Override
                public void onMoved(int x, int y) {
                    runJs("window.__rippleLyricMoved && window.__rippleLyricMoved(" + x + "," + y + ")");
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
            CrashLog.record(this, "lyric-perm", e);
            try {
                Intent it = new Intent(android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION);
                it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(it);
            } catch (Throwable e2) {
                Toast.makeText(this, "无法打开悬浮窗授权页，请到系统设置手动开启", Toast.LENGTH_LONG).show();
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

    /** 进度 0..1，用于状态栏歌词的填充效果 */
    void setLyricProgress(String p) {
        if (lyricOverlay != null) lyricOverlay.setProgress(p);
    }

    void updateLyricOverlay(String text) {
        LyricOverlay o = overlay();
        if (o.isShowing()) o.setText(text);
    }

    void hideLyricOverlay() {
        if (lyricOverlay != null) lyricOverlay.hide();
    }

    void lockLyricOverlay(boolean locked) {
        if (lyricOverlay != null) lyricOverlay.setLocked(locked);
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
     */
    void updateMediaNotification(String title, String artist, String album, String coverUrl,
                                 String durationMs, String positionMs, boolean playing) {
        try {
            if (!PlaybackService.isRunning()) {
                Intent it = new Intent(this, PlaybackService.class);
                try { startForegroundService(it); } catch (Throwable e) {
                    try { startService(it); } catch (Throwable e2) { return; }
                }
                PlaybackService.setSink(mediaSink);
                // 服务刚起时实例还是 null，稍等一拍再写状态
                new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> {
                    PlaybackService svc = PlaybackService.get();
                    if (svc != null) svc.update(title, artist, album, coverUrl,
                            durationMs, positionMs, playing);
                }, 260);
                return;
            }
            PlaybackService svc = PlaybackService.get();
            if (svc != null) svc.update(title, artist, album, coverUrl, durationMs, positionMs, playing);
        } catch (Throwable e) {
            CrashLog.record(this, "media-notif", e);
        }
    }

    void updateMediaProgress(String positionMs, String durationMs, boolean playing) {
        try {
            PlaybackService svc = PlaybackService.get();
            if (svc != null) svc.updateProgress(positionMs, durationMs, playing);
        } catch (Throwable e) {
            /* 进度更新失败不打扰 */
        }
    }

    void stopMediaNotification() {
        try {
            PlaybackService svc = PlaybackService.get();
            if (svc != null) svc.stopAndQuit();
        } catch (Throwable ignored) {
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

    private void runJs(final String code) {
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

    void setWebPlaying(boolean playing) {
        webPlaying = playing;
    }

    @Override
    protected void onPause() {
        super.onPause();
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
        // 登录用的 WebView 也要一起销毁，否则会一直持有 Activity 引用（内存泄漏）
        try {
            if (loginWeb != null) {
                loginWeb.loadUrl("about:blank");
                loginWeb.destroy();
                loginWeb = null;
            }
            loginLayer = null;
        } catch (Throwable ignored) {
        }
        try {
            if (web != null) {
                web.loadUrl("about:blank");
                web.destroy();
                web = null;
            }
        } catch (Throwable ignored) {
        }
        super.onDestroy();
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
