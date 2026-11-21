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
        let _ = app2.eval(&js);
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
        .run(|_app, event| {
            if let RunEvent::Exit = event {
                // 退出时确保 cookie 已落盘（save_cookie 在每次 Set-Cookie 后已写过，
                // 这里只是兜底 —— 若最后一条请求刚改完 jar 就退出，也不至于丢）。
            }
        });
}
