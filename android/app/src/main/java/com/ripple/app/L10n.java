package com.ripple.app;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * 1.3.5 多语言：原生层的最小实现。
 *
 * 为什么不在 Java 侧搞 res/values-zh / values-en 那套：
 * 本项目无 Gradle，资源走的是手写 aapt2 脚本，加一套 values-xx 目录要改 build-apk.sh
 * 和 R 类的生成；而且原生层要翻的句子总数不到 30 条，一半还带运行期拼接
 * （比如「下载不完整（a/b 字节）」）。用 `t("中文", "English")` 直接把两种语言写在
 * 同一个调用点上，改文案时一句话就能看到两个版本，也不会出现「键名对不上、
 * 取到空串」这类词典型方案最常见的问题。
 *
 * 语言状态只有两种：英文 / 其它（一律按中文）。这是有意的 —— 前端 i18n 目前也只有
 * zh / en 两套词典，原生层跟着同一个开关走，避免出现「界面英文、通知中文」的错配。
 *
 * 两个容易踩的点：
 *   · {@link #t} 必须能在 {@link #init} 之前被调用（静态初始化、崩溃兜底页都可能
 *     早于 Application.onCreate 跑到），所以字段默认值就是「非英文」。
 *   · 前端切语言时通过 HttpBridge.setLang 落盘，原生层重启后仍保持同一语言。
 */
public final class L10n {

    /** 原生层自己的 SharedPreferences 文件（不复用 "ripple"，那是启动计数/提示位的地盘） */
    private static final String SP = "ripple_native";
    private static final String KEY_LANG = "lang";

    private static final String ZH = "zh";
    private static final String EN = "en";

    /**
     * 当前是否英文。默认 false：保证 init 之前（含静态块里）调 t() 得到的是中文，
     * 与 1.3.4 及之前的行为一致，不会因为 class 加载顺序变化而突然蹦出英文。
     */
    private static volatile boolean english = false;

    private L10n() {
    }

    /** 英文态返回 en，其它一律 zh */
    public static String t(String zh, String en) {
        return english ? en : zh;
    }

    public static boolean isEnglish() {
        return english;
    }

    /** 启动时读回上次保存的语言；读不到就保持默认（中文）。Application 里调一次即可。 */
    public static void init(Context ctx) {
        try {
            SharedPreferences sp = ctx.getSharedPreferences(SP, Context.MODE_PRIVATE);
            apply(sp.getString(KEY_LANG, ZH));
        } catch (Throwable ignored) {
            // 读盘失败不能反过来把启动搞挂：保持默认即可
        }
    }

    /**
     * 前端切语言时调用（HttpBridge.setLang）。只认 "en"，其余按中文处理 ——
     * 这样前端传上来任何未知的语言码都不会让原生层落到「两种语言都不是」的空白态。
     */
    public static void setLang(Context ctx, String code) {
        String c = code == null ? "" : code.trim().toLowerCase(java.util.Locale.ROOT);
        apply(c);
        try {
            SharedPreferences sp = ctx.getSharedPreferences(SP, Context.MODE_PRIVATE);
            sp.edit().putString(KEY_LANG, english ? EN : ZH).apply();
        } catch (Throwable ignored) {
        }
    }

    private static void apply(String code) {
        english = EN.equals(code);
    }
}
