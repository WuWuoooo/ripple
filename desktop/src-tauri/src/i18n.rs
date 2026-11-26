//! 桌面端原生层的最小多语言。
//!
//! # 为什么桌面端需要这个，而 Android 早就有了
//!
//! 前端（`app/js/i18n.js`）只负责 **DOM 里的文案**。哪些字翻不到它？
//! 那些根本不经过 DOM 的字符串 —— 从原生命令返回、又被前端 `throw` 出去
//! 直接 toast 的错误信息。Android 侧 1.3.5 就用 `L10n.t(zh, en)` 把这些包住了
//! （通知渠道名、崩溃页、「安装未知应用」引导、网易云错误码……共 31 处）。
//!
//! 桌面端 1.3.6 之前**一处都没有**：`netease.rs` 里 `Err("song_detail: ids 不能为空")`
//! 这类字符串经过
//! ```text
//! Rust Err → __rippleNativeResult → netease.js 的 throw new Error(msg) → app.js 的 toast
//! ```
//! 直接出现在英文界面用户眼前。这就是「三端同步」口号下真实存在的一处落差点。
//!
//! # 为什么不引第三方 i18n crate
//!
//! 只有几十条、两种语言、且都是"运行期拼一次就扔掉"的短句。一个 `match`
//! 足够，还能避免 `--offline --locked` 构建时多拉一棵依赖树
//! （Cargo.lock 一改，CI 的离线校验就红）。
//!
//! # 语言从哪来
//!
//! 前端切语言时会调 `RippleNative.setLang(code)`（Android 侧同名方法写进
//! SharedPreferences）。桌面端在 `bridge.js` 里把它转成 `invoke('set_lang')`，
//! 存进 `AppState.lang`。读不到时默认中文 —— 与 Android `L10n` 的
//! "init 之前一律中文"保持一致，不会因为初始化顺序蹦出英文。

use std::sync::atomic::{AtomicBool, Ordering};

/// 当前是否英文。
///
/// 用 `static` 而不是从 `AppState` 传参：
///   · 这些错误串在 `netease::Client` 内部、WebView 回调链上产生，
///     把 language 一路透传下去要改十几个函数签名，而它是个纯全局偏好；
///   · 单进程单语言（同一个 App 实例里不可能两个窗口用不同语言）；
///   · 无锁读取，不值得为它进 Mutex。
///
/// 默认 false（中文），与 Android `L10n.english` 的默认值对齐。
static ENGLISH: AtomicBool = AtomicBool::new(false);

/// 设置当前语言。`code` 为 `"en"` 时英文，其它一律中文。
pub fn set_lang(code: &str) {
    ENGLISH.store(code.trim().eq_ignore_ascii_case("en"), Ordering::Relaxed);
}

/// 当前是否英文（测试与诊断用）。
pub fn is_english() -> bool {
    ENGLISH.load(Ordering::Relaxed)
}

/// 中英二选一。参数顺序与 Android `L10n.t(zh, en)` **完全相同**，
/// 这样同一个文案在两端的写法可以逐字对照，改文案时一眼能看出漏了哪边。
pub fn t(zh: &'static str, en: &'static str) -> &'static str {
    if is_english() {
        en
    } else {
        zh
    }
}

/// 带插值的版本：`t_fmt(zh, en, |s| format!(...))` 太绕，
/// 这里直接给「格式串 + 参数」的形状，调用点写成
/// `i18n::tf("创建配置目录失败：{e}", "Failed to create config dir: {e}", &[("e", e.to_string())])`。
///
/// 为什么不直接用 `format!`：
///   两条分支要各自展开成不同的字面量，而 `format!` 的格式串必须是编译期字面量。
///   先选串再统一替换占位符，是这里唯一不求人于依赖的做法。
pub fn tf(zh: &'static str, en: &'static str, args: &[(&str, String)]) -> String {
    let mut s = t(zh, en).to_string();
    for (k, v) in args {
        s = s.replace(&format!("{{{k}}}"), v);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /*
     * 这三条测试都在改**同一个全局** `ENGLISH`，而 cargo test 默认并行跑
     * 同一个二进制里的测试（线程数通常 = CPU 核心数）。
     *
     * 1.3.7 第一次提交时没加锁，CI 的 windows-latest 上直接红了：
     *   lang_switches_both_ways 断言 "中文"，实际拿到 "English" ——
     *   因为另一条测试恰好在它 set_lang("zh") 之后 set_lang("en") 了。
     *
     * 为什么只在一台机器上红：并行度不同，交错顺序就不同。ubuntu 上恰好
     * 没撞上，windows 上撞上了。这类「本地绿、CI 红」的测试最消耗信任，
     * 所以显式串行化，而不是让人记得加 `--test-threads=1`（那等于没护栏）。
     *
     * 用标准库 Mutex 而不是 `serial_test` crate：多一个 dev-dependency 就要
     * 改 Cargo.lock，而本机构建是 `--offline --locked`。
     */
    static LANG_LOCK: Mutex<()> = Mutex::new(());

    /// 拿锁时忽略「上一个持锁线程 panic 导致锁中毒」——
    /// 中毒只说明别的测试失败过，而这几条彼此独立，继续跑不会掩盖问题。
    fn guard() -> std::sync::MutexGuard<'static, ()> {
        LANG_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 语言切换必须能来回切，且默认是中文。
    ///
    /// 这条测试看着简单，但它钉住的是 1.3.6 里真实发生过的形态：
    /// 桌面标题栏按钮用「取当前语言算一次英文再写死」的实现，
    /// 切回中文就再也回不去（见 bridge.js 里 injectTitlebar 的注释）。
    /// 只要语言状态是"每次现读"而不是"算一次存下来"，就不会有这个毛病。
    #[test]
    fn lang_switches_both_ways() {
        let _g = guard();
        set_lang("zh");
        assert_eq!(t("中文", "English"), "中文");
        set_lang("en");
        assert_eq!(t("中文", "English"), "English");
        set_lang("zh");
        assert_eq!(t("中文", "English"), "中文", "必须能切回中文");
    }

    /// 大小写与空白不该影响判定 —— 前端传的是 "en"，但万一哪天传 "EN" 也得认。
    #[test]
    fn lang_code_is_forgiving() {
        let _g = guard();
        set_lang(" EN ");
        assert!(is_english());
        set_lang("zh");
        set_lang("zh-CN");
        assert!(!is_english(), "zh-CN 之类的非 en 一律当中文");
    }

    /// 插值要真的替换掉占位符，且两种语言都用**各自的**格式串。
    #[test]
    fn tf_interpolates_each_language() {
        let _g = guard();
        set_lang("zh");
        let zh = tf(
            "目录 {p} 创建失败",
            "Failed to create dir {p}",
            &[("p", "/tmp/x".into())],
        );
        assert_eq!(zh, "目录 /tmp/x 创建失败");

        set_lang("en");
        let en = tf(
            "目录 {p} 创建失败",
            "Failed to create dir {p}",
            &[("p", "/tmp/x".into())],
        );
        assert_eq!(en, "Failed to create dir /tmp/x");
        set_lang("zh");
    }
}
