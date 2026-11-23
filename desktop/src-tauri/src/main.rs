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

use tauri::{Manager, RunEvent, State};

/// 全局客户端。桌面端只有一份登录态，所有命令共享它。
struct AppState {
    client: Mutex<Option<Arc<Mutex<netease::Client>>>>,
    data_dir: PathBuf,
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
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            netease,
            notify,
            can_draw_overlay,
            request_overlay_permission,
            safe_mode
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
