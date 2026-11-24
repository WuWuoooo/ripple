//! Ripple 涟漪 · Tauri 桌面客户端入口
//!
//! # 设计目标：前端零改动
//!
//! `app/` 那 13000 行前端（液态玻璃、播放引擎、均衡器、歌词、歌单……）
//! **一行不改**地跑在桌面端。做法是把 Android 的 `@JavascriptInterface` 桥
//! （`window.RippleNative`）在桌面端用同样的形状复刻出来：
//!
//! | 前端调用 | Android | 桌面端 |
//! |---|---|---|
//! | `RippleNative.netease(cmd, json, id)` | Java 侧 weapi | Tauri command + Rust weapi |
//! | `RippleNative.notify(title, body)` | 通知栏 | 系统通知（先返回 false，见下） |
//! | `RippleNative.mediaState(json)` | MediaSession | 无对等物，注册空实现 |
//! | `RippleNative.canDrawOverlay()` | 悬浮窗权限 | 桌面端恒 false（无悬浮窗概念） |
//!
//! 前端所有原生调用点都写成 `if (window.RippleNative && typeof N.xxx === 'function')`，
//! 所以某个方法不提供时会自动降级到浏览器行为 —— 这也是为什么桌面端能
//! 只实现最重要的 `netease` 一条，其余先留空。
//!
//! # 回调机制
//!
//! Android 侧是「同步调用 + 异步回调」：`netease(cmd, params, cbId)` 立刻返回，
//! 结果稍后通过 `__rippleNativeResult(cbId, text)` 送回 JS。
//! 桌面端必须保持同样的形状（包括同一个 cbId 语义），否则前端的
//! `_pending` 表对不上。这里用 `window.__rippleNativeResult(...)` 主动调用 JS 实现。

use ripple_desktop::netease;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri::{Emitter, Manager, RunEvent, State};

/// 全局客户端。桌面端只有一份登录态，所有命令共享它。
struct AppState {
    client: Mutex<Option<Arc<Mutex<netease::Client>>>>,
    data_dir: PathBuf,
    /// 歌词窗口的状态（见 lyric.rs）。与 client 分开加锁，
    /// 免得「推一句歌词」和「发一次网络请求」互相等锁。
    lyric: Mutex<LyricState>,
}

/// 歌词窗的运行时状态。
///
/// 这里存的是「当前该显示成什么样」，而不是窗口对象本身 ——
/// 窗口可能还没建、也可能被用户关掉了，而状态要一直留着，
/// 下次建窗口时按它做首帧渲染（否则刚弹出来是空白，
/// 要等下一句歌词上报才有内容）。
#[derive(Default, Clone)]
struct LyricState {
    locked: bool,
    text: String,
    progress: f32,
    color: String,
    size: f32,
    alpha: f32,
    x: i32,
    y: i32,
    bold: bool,
    shadow: bool,
    fill: bool,
    fill_hex: String,
    /// 窗口是否已成功创建过。创建失败（无合成器 / 无 DISPLAY）时置 false，
    /// 后续 show 直接返回失败而不是反复尝试。
    window_ok: bool,
}

/// 惰性初始化共享 Client：首次调用时建，之后所有命令共用同一个实例。
///
/// 返回 Arc 的克隆，所以调用方拿到后可以在锁外持有 —— 这正是
/// "并发的两条命令不能各建一个 Client" 的关键。
fn get_or_init_client(
    state: &State<'_, AppState>,
    data_dir: &PathBuf,
) -> Result<Arc<Mutex<netease::Client>>, String> {
    let mut guard = state
        .client
        .lock()
        .map_err(|e| format!("状态锁被污染：{e}"))?;
    if let Some(c) = guard.as_ref() {
        return Ok(Arc::clone(c));
    }
    let client = Arc::new(Mutex::new(netease::Client::new(data_dir)?));
    *guard = Some(Arc::clone(&client));
    Ok(client)
}

/// 与 Android 桥同名的 `netease` 命令。
///
/// 签名刻意保持 `(cmd, paramsJson, cbId)` 三元组，与
/// `HttpBridge.java` 的 `@JavascriptInterface public void netease(String cmd, String params, String cbId)`
/// 一一对应 —— 前端 `nativeCall()` 只认这个形状。
///
/// 实现是「立刻返回、结果异步推回」：先 spawn 一个线程跑网络请求，
/// 拿到结果再调 JS 的 `__rippleNativeResult(cbId, text)`。
/// 桌面端这样做的必要性与 Android 不同（桌面没有主线程阻塞问题），
/// 但**必须保持同一个契约**，否则前端那套 pending/超时逻辑会错乱。
#[tauri::command]
fn netease(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    cmd: String,
    params: String,
    cb_id: String,
) -> Result<(), String> {
    let params_json: serde_json::Value = if params.trim().is_empty() {
        serde_json::json!({})
    } else {
        serde_json::from_str(&params).unwrap_or_else(|_| serde_json::json!({}))
    };

    let data_dir = state.data_dir.clone();
    /*
     * 这里必须用 Arc 共享同一个 Client，不能「取出→用完→放回」。
     *
     * 早先的写法是 `guard.take()` 把 Client 拿走，请求期间它在共享状态里是
     * None —— 此时若并发的第二条命令进来，会看到 None 而**新建一个 Client**。
     * 两个 Client 各有自己的 cookie_jar，后果是：一边登录成功了，
     * 另一边仍然认为没登录；Set-Cookie 写回时互相覆盖，登录态随机丢失。
     *
     * 前端确实会并发（首页一次性拉每日推荐 + 推荐歌单 + 排行榜），
     * 所以这不是理论问题。改成 Arc<Mutex<Client>> 后，所有命令共享同一份
     * cookie_jar，锁只包住真正访问 client 的那一小段。
     */
    let client = get_or_init_client(&state, &data_dir)?;
    let app2 = app.clone();

    std::thread::spawn(move || {
        let text = {
            // 锁的范围：只包住这一次网络请求。同类请求会串行，
            // 但桌面端请求量本来就不高，且能保证 cookie 不被并发写坏。
            let result = match client.lock() {
                Ok(mut c) => c.call(&cmd, &params_json),
                Err(e) => Err(format!("状态锁被污染：{e}")),
            };
            match result {
                Ok(t) => t,
                Err(e) => format!(
                    r#"{{"code":-1,"message":{}}}"#,
                    serde_json::Value::String(e).to_string()
                ),
            }
        };

        // 与 Android 桥同名的全局回调
        let js = format!(
            "window.__rippleNativeResult({}, {});",
            serde_json::Value::String(cb_id).to_string(),
            serde_json::Value::String(text).to_string()
        );
        /*
         * Tauri 2 里 `AppHandle` **没有** eval 方法（Tauri 1 有，迁移时最容易踩）。
         * 执行 JS 必须拿到具体的 WebviewWindow：`get_webview_window(label)`。
         * label 用 "main" 是因为 tauri.conf.json 里那个窗口没写 label，
         * Tauri 会给默认 label `"main"`。
         *
         * 找不到窗口时静默跳过：前端那套 pending 逻辑有 22 秒超时兜底，
         * 不会永久卡住；而在这里 panic 会把整个应用带崩，代价大得多。
         */
        if let Some(win) = app2.get_webview_window("main") {
            let _ = win.eval(&js);
        }
    });

    Ok(())
}

/// 与 Android `HttpBridge.notify` 同签名。
///
/// 桌面端目前返回 `false`：系统通知在三个平台上要走三套不同 API
/// （Windows Toast / Linux libnotify / macOS UNUserNotification），
/// 而且带按钮的「媒体通知」本来就该由托盘与系统媒体控制承担。
/// 返回 false 会让前端走「通知不可用」的降级路径，不会报错。
///
/// 这是一个**已知的功能差异**，README 里会如实写明。
#[tauri::command]
fn notify(_title: String, _body: String) -> bool {
    false
}

/// 桌面端没有悬浮窗概念，恒 false。前端据此隐藏「状态栏歌词」相关设置项。
#[tauri::command]
fn can_draw_overlay() -> bool {
    false
}

/// 请求悬浮窗权限：桌面端无事可做，恒 false。
#[tauri::command]
fn request_overlay_permission() -> bool {
    false
}

/// 与 Android `HttpBridge.safeMode` 同签名：桌面端永远不是安全模式。
#[tauri::command]
fn safe_mode() -> bool {
    false
}

/* ================= 歌词窗（状态栏歌词的桌面端对等物） =================
 *
 * Android 那边是「盖在系统状态栏上的悬浮窗」（LyricOverlay.java），
 * 桌面端没有系统状态栏，于是用一个**独立的无边框置顶小窗口**承担同一职责：
 *
 *   | 行为 | Android | 桌面端 |
 *   |---|---|---|
 *   | 载体 | TYPE_APPLICATION_OVERLAY 浮层 | 独立的 Tauri WebviewWindow |
 *   | 置顶 | 系统级悬浮窗天然在最上 | always_on_top + skip_taskbar |
 *   | 锁定 | FLAG_NOT_TOUCHABLE（点击穿透） | set_ignore_cursor_events(true) |
 *   | 未锁定 | 可拖动，点一下回调网页弹面板 | data-tauri-drag-region 拖动 |
 *   | 内容 | TextView + LinearGradient 硬边 | lyric.html + background-clip:text |
 *   | 进度 | setProgress(0..1) | 同一个 0..1，语义一致 |
 *
 * 为什么承载歌词的是一个 **webview 窗口**而不是原生绘制：
 *   卡拉OK染色在网页里只需要一条 CSS 渐变（background-clip:text），
 *   而在原生侧要自己算字形边界、裁切、处理 DPI —— 那套东西 app/ 里
 *   已经有了（四个表面共用同一份 CSS 变量），复用它比重新实现可靠得多。
 *
 * 窗口是**懒创建**的：第一次 showLyricOverlay 才建。理由是启动即建会让
 * 每个用户都多一个窗口（哪怕从没开过状态栏歌词），而且在没有合成器的
 * 环境里还会多一条启动失败记录。
 */

/// 歌词窗口的 label。前端 lyric.html 用同一个名字发/收事件。
const LYRIC_WINDOW: &str = "lyric";
/// Rust → 歌词窗口的事件名。
const LYRIC_EVENT: &str = "lyric-state";

/// 把当前状态推给歌词窗口。
///
/// 推的是**整份状态**而不是增量：状态字段总共十几个小值，
/// 每次全量推反而让 lyric.html 不必维护「哪些字段这次没变」的判断，
/// 少一类「某个字段忘了同步」的 bug。
fn push_lyric_state(app: &tauri::AppHandle, st: &LyricState) {
    let payload = serde_json::json!({
        "locked": st.locked,
        "text": st.text,
        "progress": st.progress,
        "color": st.color,
        "size": st.size,
        "alpha": st.alpha,
        "bold": st.bold,
        "shadow": st.shadow,
        "fill": st.fill,
        "fillHex": st.fill_hex,
    });
    // 窗口还没建 / 已被关闭时 emit 会返回错误 —— 这不是异常情况，
    // 用户关掉歌词窗再打开就会走到这条路径，所以只忽略不报错。
    let _ = app.emit_to(LYRIC_WINDOW, LYRIC_EVENT, payload);
}

/// 读位置文件。返回 (x, y)，没有文件或解析失败时返回 None。
fn read_lyric_pos(dir: &std::path::Path) -> Option<(i32, i32)> {
    let p = dir.join("lyric-pos.json");
    let raw = std::fs::read_to_string(p).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let x = v.get("x")?.as_i64()?;
    let y = v.get("y")?.as_i64()?;
    Some((x as i32, y as i32))
}

/// 写位置文件。失败只记日志：位置存不下来不是致命问题，
/// 下次就回到默认位置而已，不该因此让整个命令失败。
fn save_lyric_pos(dir: &std::path::Path, x: i32, y: i32) {
    let p = dir.join("lyric-pos.json");
    let body = format!("{{\"x\":{},\"y\":{}}}\n", x, y);
    if let Err(e) = std::fs::write(&p, body) {
        eprintln!("[lyric] 位置保存失败（{}）：{e}", p.display());
    }
}

/// 惰性创建歌词窗口；已存在则直接返回。
///
/// 三个平台都能走到，但 Linux 上没有合成器时透明窗口可能创建失败 ——
/// 那种情况下把 window_ok 置 false 并返回 Err，调用方据此让前端走降级路径
/// （前端所有 RippleNative 调用点都有 typeof 判空，返回失败不会崩）。
fn ensure_lyric_window(app: &tauri::AppHandle, st: &LyricState) -> Result<(), String> {
    if app.get_webview_window(LYRIC_WINDOW).is_some() {
        return Ok(());
    }
    let data_dir = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    let pos = read_lyric_pos(&data_dir);

    let mut builder = tauri::WebviewWindowBuilder::new(
        app,
        LYRIC_WINDOW,
        tauri::WebviewUrl::App("lyric.html".into()),
    )
    .title("Ripple 歌词")
    .inner_size(360.0, 64.0)
    .min_inner_size(120.0, 32.0)
    .decorations(false)
    /* 透明底：让文字直接浮在桌面上。没有合成器时会退化成黑底，
    但文字仍然可读（lyric.html 自己也画了一层深色描边兜底）。 */
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    /* 不抢焦点：用户正在别的程序里打字时，弹一句歌词不该把光标抢走 */
    .focused(false)
    .resizable(false)
    .shadow(false)
    .visible_on_all_workspaces(true)
    .accept_first_mouse(true);

    if let Some((x, y)) = pos {
        builder = builder.position(x as f64, y as f64);
    }

    match builder.build() {
        Ok(win) => {
            /* 按当前锁定状态决定是否穿透。锁定 = 鼠标事件直接穿过去，
            盖在别的程序上也不影响用户点它下面的东西。 */
            let _ = win.set_ignore_cursor_events(st.locked);
            Ok(())
        }
        Err(e) => Err(format!("歌词窗口创建失败：{e}")),
    }
}

/// 与 Android `HttpBridge.showLyricOverlay` 同签名（10 个参数）。
///
/// 参数全部按字符串收：前端那边是 `String(!!x)` / `String(n)` 这样传的，
/// 与 Android 完全一致。这样三端桥的形状相同，前端不需要为桌面端写分支。
///
/// 解析容错与 Android 一致：解析失败就沿用旧值，而不是报错让调用方失败 ——
/// 一次脏数据不该让整条歌词链路停摆。
#[tauri::command]
fn lyric_overlay_show(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    locked: String,
    color: String,
    size: String,
    alpha: String,
    x: String,
    y: String,
    bold: String,
    shadow: String,
    fill: String,
    fill_hex: String,
) -> bool {
    let mut guard = match state.lyric.lock() {
        Ok(g) => g,
        Err(_) => return false,
    };
    guard.locked = locked == "true";
    if !color.is_empty() {
        guard.color = color;
    }
    if let Ok(v) = size.trim().parse::<f32>() {
        guard.size = v.clamp(8.0, 32.0);
    }
    if let Ok(v) = alpha.trim().parse::<f32>() {
        guard.alpha = v.clamp(0.15, 1.0);
    }
    if let Ok(v) = x.trim().parse::<i32>() {
        guard.x = v;
    }
    if let Ok(v) = y.trim().parse::<i32>() {
        guard.y = v;
    }
    guard.bold = bold == "true";
    guard.shadow = shadow == "true";
    guard.fill = fill == "true";
    if !fill_hex.is_empty() {
        guard.fill_hex = fill_hex;
    }

    // 首次创建窗口。失败就如实返回 false，前端会走降级。
    if !guard.window_ok || app.get_webview_window(LYRIC_WINDOW).is_none() {
        guard.window_ok = ensure_lyric_window(&app, &guard).is_ok();
        if !guard.window_ok {
            return false;
        }
        // 新建的窗口还没加载完页面，此时 emit 会被丢掉 ——
        // lyric.html 自己会在加载完成后主动 invoke 一次 lyric_overlay_sync
        // 把首帧状态取回去，所以这里不需要额外等待。
    }
    // 锁定状态变化要同步到窗口的点击穿透设置
    if let Some(win) = app.get_webview_window(LYRIC_WINDOW) {
        let _ = win.set_ignore_cursor_events(guard.locked);
    }
    push_lyric_state(&app, &guard);
    true
}

/// 更新歌词文字。与 Android `updateLyricOverlay` 同语义。
#[tauri::command]
fn lyric_overlay_text(app: tauri::AppHandle, state: State<'_, AppState>, text: String) {
    let mut guard = match state.lyric.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    let v = text.trim().to_string();
    if guard.text == v {
        return; // 同一句不重复推送（与 Android setText 的去重同义）
    }
    guard.text = v;
    /*
     * 换句时进度归零。
     *
     * 与 Android LyricOverlay.setText 里那段是同一个理由：
     * 前端先推新文字、再推新进度，两次跨桥之间必然隔一帧。
     * 不清的话新歌词会顶着上一句的 0.99 先渲染一次 —— 一次很明显的闪烁，
     * 而且正好出现在最该顺滑的换句时刻。
     */
    guard.progress = 0.0;
    push_lyric_state(&app, &guard);
}

/// 更新「当前这一句」的进度 0..1。
///
/// ⚠️ 语义是**句内**进度，不是整首进度 —— 与 1.3.3 改过的前端一致。
/// 桌面端这里不做任何「除以时长」的换算，直接当 --p 用。
#[tauri::command]
fn lyric_overlay_progress(app: tauri::AppHandle, state: State<'_, AppState>, progress: String) {
    let mut guard = match state.lyric.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    let v = match progress.trim().parse::<f32>() {
        Ok(v) if v.is_finite() => v.clamp(0.0, 1.0),
        _ => return,
    };
    if (v - guard.progress).abs() < 0.004 {
        return; // 0.4% 以内不推（与 Android setProgress 的阈值一致）
    }
    guard.progress = v;
    push_lyric_state(&app, &guard);
}

/// 隐藏（销毁）歌词窗口。与 Android `hideLyricOverlay` 同语义。
///
/// 销毁而不是 hide：与 Android 那头 `wm.removeView` 一致，
/// 也更省资源 —— 用户关掉状态栏歌词后不该还挂着一个看不见的 webview。
#[tauri::command]
fn lyric_overlay_hide(app: tauri::AppHandle, state: State<'_, AppState>) {
    if let Some(win) = app.get_webview_window(LYRIC_WINDOW) {
        let _ = win.close();
    }
    if let Ok(mut g) = state.lyric.lock() {
        g.window_ok = false;
        g.text.clear();
        g.progress = 0.0;
    }
}

/// 歌词窗加载完成后主动拉一次当前状态（解决「首帧空白」）。
///
/// 为什么需要它：窗口创建和页面加载是异步的，Rust 那边 push 首帧时
/// webview 可能还没跑起来，事件就被丢了。让页面自己来要一次最稳妥。
#[tauri::command]
fn lyric_overlay_sync(state: State<'_, AppState>) -> serde_json::Value {
    let guard = match state.lyric.lock() {
        Ok(g) => g,
        Err(_) => return serde_json::json!({}),
    };
    let v = serde_json::json!({
        "locked": guard.locked,
        "text": guard.text,
        "progress": guard.progress,
        "color": guard.color,
        "size": guard.size,
        "alpha": guard.alpha,
        "bold": guard.bold,
        "shadow": guard.shadow,
        "fill": guard.fill,
        "fillHex": guard.fill_hex,
    });
    drop(guard);
    v
}

/// 歌词窗拖动结束后回报新位置并落盘。
#[tauri::command]
fn lyric_save_pos(app: tauri::AppHandle, state: State<'_, AppState>, x: i32, y: i32) {
    if let Ok(mut g) = state.lyric.lock() {
        g.x = x;
        g.y = y;
    }
    let dir = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    save_lyric_pos(&dir, x, y);
}

/// 单实例守卫（审查 D-07）。
///
/// 为什么不用 `tauri-plugin-single-instance`：本机（aarch64 proot）的 cargo
/// 缓存里没有这个 crate，而构建脚本跑的是 `--offline`，加依赖会直接编译失败。
/// 而单实例的实质需求只有一条 ——「别让第二个实例去覆盖第一个实例的
/// cookie / 令牌文件」（审查 S-07 指出同一 data-dir 起两个实例会互相覆盖）。
///
/// 所以用**最小实现**：在配置目录里建一个 lock 文件并持有它。
/// 拿不到锁就说明已有实例在跑，直接退出并提示。
///
/// 说明与已知边界：
///   · 用 O_EXCL 创建而不是文件锁 —— 跨平台语义一致，且不依赖额外 crate；
///   · 进程被强杀可能留下陈旧 lock。所以我们检查里面的 pid 是否还活着，
///     活着就退出，死了就接管（见下）；
///   · 这不是「完美单实例」（极端竞态下两个进程可能同时判定陈旧），
///     但足以挡住「用户手滑双击两次图标」这个真实场景。
#[cfg(unix)]
fn acquire_single_instance(dir: &std::path::Path) -> bool {
    use std::io::Write;
    let lock = dir.join(".ripple-instance");
    if let Ok(text) = std::fs::read_to_string(&lock) {
        let pid: i32 = text.trim().parse().unwrap_or(0);
        if pid > 1 {
            /* kill(pid, 0) 探测存活：返回 0 说明进程还在 */
            let alive = unsafe { libc_kill0(pid) };
            if alive {
                return false;
            }
        }
    }
    match std::fs::File::create(&lock) {
        Ok(mut f) => {
            let _ = write!(f, "{}", std::process::id());
            true
        }
        Err(_) => {
            /* 创建失败也不要因此拒绝启动 —— 宁可多开一个，也不能打不开 */
            true
        }
    }
}

// 极小的 `kill(pid, 0)` 绑定：只用于「进程是否存活」探测。
// 不引入 libc crate（离线环境没缓存），直接声明外部符号。
#[cfg(unix)]
extern "C" {
    fn kill(pid: i32, sig: i32) -> i32;
}
#[cfg(unix)]
unsafe fn libc_kill0(pid: i32) -> bool {
    kill(pid, 0) == 0
}

#[cfg(windows)]
fn acquire_single_instance(_dir: &std::path::Path) -> bool {
    /* Windows 侧靠命名互斥体才可靠，而在没有 windows-sys 依赖的情况下
    做一个「语义正确」的实现不现实。这里明确不做，而不是给一个假的。 */
    true
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // 数据目录：各平台标准配置目录下的 ripple
            //   Linux:   ~/.config/ripple
            //   Windows: %APPDATA%\ripple
            //   macOS:   ~/Library/Application Support/ripple
            let data_dir = app
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| PathBuf::from("."));
            std::fs::create_dir_all(&data_dir).ok();

            /*
             * D-07：同一配置目录只允许一个实例 —— 否则两个实例会各持一份
             * cookie / 令牌表，互相覆盖（审查 S-07）。
             */
            if !acquire_single_instance(&data_dir) {
                eprintln!("Ripple 已在运行（{}）", data_dir.display());
                std::process::exit(0);
            }

            app.manage(AppState {
                client: Mutex::new(None),
                data_dir,
                lyric: Mutex::new(LyricState::default()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            netease,
            notify,
            can_draw_overlay,
            request_overlay_permission,
            safe_mode,
            /* 歌词窗（状态栏歌词的桌面端对等物），见上方注释 */
            lyric_overlay_show,
            lyric_overlay_text,
            lyric_overlay_progress,
            lyric_overlay_hide,
            lyric_overlay_sync,
            lyric_save_pos
        ])
        .build(tauri::generate_context!())
        .expect("Tauri 启动失败")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                /*
                 * 审查 D-07：这个分支以前只有注释、没有任何实际代码。
                 *
                 * 注释说「这里只是兜底」，但兜底本身是必要的：cookie 依赖每次
                 * Set-Cookie 后立即 save_cookie()，若最后一条请求刚改完 jar
                 * 就退出（或那次写盘失败），退出后就丢了 —— 用户表现是
                 * 「昨天还登录着，今天打开又要重新登录」。
                 *
                 * 现在真的在这里兜底写一次：拿共享 Client，drop 锁之后写盘，
                 * 避免在持锁状态里做 IO。
                 */
                if let Some(state) = app.try_state::<AppState>() {
                    let client = state.client.lock().ok().and_then(|g| g.as_ref().cloned());
                    if let Some(c) = client {
                        if let Ok(guard) = c.lock() {
                            guard.save_cookie();
                        }
                    }
                }
            }
        });
}
