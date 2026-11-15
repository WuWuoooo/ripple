package com.ripple.app;

/** 保守模式开关：连续启动失败时自动降级，保证至少能进界面 */
final class StrictModes {
    /** true = 跳过边缘到边缘 / insets 覆盖 / CookieManager 等可能与机型冲突的设置 */
    static volatile boolean safeMode = false;

    private StrictModes() {
    }
}
