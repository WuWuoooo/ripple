#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

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
//! | `RippleNative.notify(title, body)` | 通知栏 | 恒返回 false（无系统通知后端） |
//! | `RippleNative.mediaState(...)` | MediaSession | **不提供** —— 见下方说明 |
//! | `RippleNative.canDrawOverlay()` | 悬浮窗权限 | 恒 true（桌面端是独立窗口，无需授权） |
//! | `RippleNative.log / jsError / ...` | LogBridge 写文件 | Rust 追加到 app_log_dir 下的日志文件 |
//!
//! `mediaState` 在桌面端**故意不提供**：它是「查询有没有原生媒体通知能力」的
//! 判断题，前端用 `typeof === 'function'` 判它。造一个恒返回 false 的占位实现
//! 会让 UI 显示「通知栏 / 锁屏 / 耳机键可控」，而桌面端根本没有这套东西 ——
//! 那是假承诺，比不提供更糟。不提供时前端自然走降级文案。
//!
//! 前端所有原生调用点都写成 `if (window.RippleNative && typeof N.xxx === 'function')`，
//! 所以某个方法不提供时会自动降级到浏览器行为。
//!
//! # 回调机制
//!
//! Android 侧是「同步调用 + 异步回调」：`netease(cmd, params, cbId)` 立刻返回，
//! 结果稍后通过 `__rippleNativeResult(cbId, text)` 送回 JS。
//! 桌面端必须保持同样的形状（包括同一个 cbId 语义），否则前端的
//! `_pending` 表对不上。
//!
//! 结果投给**所有** webview（桌面端有两个：主窗口与歌词窗），
//! 而不是写死投给 main —— 哪个窗口发的请求就该收到结果。
//! 前端那个回调表是 per-window 的，没有对应 cbId 的窗口会静默 no-op。

use ripple_desktop::i18n;
use ripple_desktop::netease;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri::{Emitter, Manager, RunEvent, State};

/// 全局客户端。桌面端只有一份登录态，所有命令共享它。
struct AppState {
    client: Mutex<Option<Arc<Mutex<netease::Client>>>>,
    data_dir: PathBuf,
    /// 歌词窗口的状态（见本文件下方「歌词窗」注释块）。与 client 分开加锁，
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
    /*
     * ===== 时间外推的基准点（D-02，1.3.4）=====
     *
     * Android 侧 LyricOverlay 有同样的机制，原因也相同：
     * 歌词窗最主要的用法就是「切到别的程序时看」，那时主窗口
     * rAF 暂停、1 秒 ticker 被 clearInterval，逐帧推送断流 ——
     * 表现就是「一下填满、换句才动」。
     *
     * 这里只负责**把基准带过去**，真正的按帧外推在 lyric.html 里
     * 用 performance.now() 做（那个窗口自己可见，rAF 照常运行）。
     * 不在 Rust 侧开定时器，是因为跨进程时钟比较容易错位，
     * 而且多一个线程就多一处要维护的启停逻辑。
     */
    base_progress: f32,
    /// 本句总时长（秒）。<= 0 表示未知，此时不启用外推。
    line_dur: f32,
    /// 播放倍速（1.0 = 正常）。外推时要按它缩放，否则 1.5x 会跟不上。
    rate: f32,
    /// 是否正在播放。false 时冻结在 base_progress，不继续推进。
    playing: bool,
    /// 窗口是否已成功创建过。创建失败（无合成器 / 无 DISPLAY）时置 false，
    /// 后续 show 直接返回失败而不是反复尝试。
    window_ok: bool,
    /*
     * 1.3.9：窗口是否走「降级不透明」形态。
     *
     * 透明窗在 Windows 精简版上可能建不出来（DWM 被裁），此时退回不透明窗
     * 保功能可用。这个标记跟着 lyric_payload 传给 lyric.html，让页面自己
     * 铺一层深色底 —— 否则不透明窗是 WebView 默认白底，白字直接看不见。
     *
     * 放在 state 而不是建窗时一次性塞进 URL：payload 是现成的通道，
     * 且首帧（页面主动 invoke lyric_overlay_sync）也能拿到，不用额外等事件。
     */
    opaque: bool,
}

/// 一个极小的固定大小工作池（审查 L-11）。
///
/// 为什么自己手写而不用现成的：本机构建是 `--offline --locked`，
/// 加任何依赖（rayon / tokio / threadpool）都会直接失败 —— 这一点
/// Cargo.toml 与 README 里都反复记着。而这个池的需求极简：
/// 「有界队列 + N 个常驻线程 + 任务是一次性闭包」，std 就够。
///
/// 语义取舍：
///   · 队列**无界**（mpsc 的 channel()）。有界队列在满时需要阻塞调用方，
///     而调用方是 Tauri 命令（跑在 IPC 线程上）—— 阻塞它等于把 UI 也堵住。
///     无界的风险是内存涨；但这里的任务体只是一个请求闭包、
///     且真正耗时的是等待 Mutex 与网络，队列深度实际被前端并发数限制住。
///   · 任务 panic 会让对应 worker 线程死掉。这里不让 panic 传染整个池：
///     每个任务包一层 catch_unwind，panic 后线程继续接下一个任务。
///   · 池本身用 OnceLock 惰性初始化一次，进程内唯一。
struct WorkerPool {
    tx: std::sync::mpsc::Sender<Box<dyn FnOnce() + Send + 'static>>,
}

impl WorkerPool {
    fn new(workers: usize) -> Self {
        let (tx, rx) = std::sync::mpsc::channel::<Box<dyn FnOnce() + Send + 'static>>();
        let rx = Arc::new(Mutex::new(rx));
        for i in 0..workers {
            let rx = Arc::clone(&rx);
            std::thread::Builder::new()
                .name(format!("ripple-net-{i}"))
                /* 守护语义：Tauri 的主线程退出后不因为这些 worker 而挂住。
                std 没有 setDaemon，这里的做法是：退出时它们自然跟着
                进程结束（main 返回后进程就终止了，不 join 也不影响）。 */
                .spawn(move || loop {
                    /* 锁只在这一行：取任务，之后立刻释放 —— 多个 worker
                    可以并发执行各自的任务，不是串行。 */
                    let job = {
                        let guard = match rx.lock() {
                            Ok(g) => g,
                            Err(e) => e.into_inner(),
                        };
                        guard.recv()
                    };
                    match job {
                        Ok(f) => {
                            /* 任务内 panic 不能带走整条 worker 线程 */
                            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));
                        }
                        /* 发送端（池本身）被 drop = 进程在收尾，退出循环 */
                        Err(_) => break,
                    }
                })
                .ok();
        }
        Self { tx }
    }

    fn execute<F: FnOnce() + Send + 'static>(&self, f: F) {
        /* 发送失败说明池里的 worker 全没了（极不可能）。
        此时退化成同步执行 —— 结果仍然会送到，只是让调用方等一会儿。
        宁可慢，也不要静默丢一条命令让前端干等超时。 */
        if self.tx.send(Box::new(f)).is_err() {
            // 已经被 move 进 Box 里了，无法再拿回来 —— 这条路径只可能是
            // 进程正在退出，放弃执行是唯一选择。
            eprintln!("[ripple] 网络工作池已关闭，任务被丢弃");
        }
    }
}

/// 进程内唯一的网络工作池。
///
/// 1.3.9 修复（Windows 上「所有请求超时 + 顶栏最小化/关闭点了没反应」）：
///
/// 以前是 **2 个线程**。配合 `Client` 上那把串行锁，这个组合在网络不好时
/// 会退化成**整个 IPC 通道堵死**：
///   · `netease` 命令本身是「立刻返回、结果异步推回」，前端等的是回调；
///   · 回调由 worker 线程里的 `win.eval` 投递；
///   · 而 `reqwest` 的单请求超时是 25 秒，`status` 命令内部还要**串行**发 4 次
///     （账号 → vip → level → like）—— 最坏就是 100 秒占着 2 个 worker 里的 1 个。
///
/// 首页一进来就并发拉「每日推荐 + 推荐歌单 + 排行榜 + 状态」，再叠加歌词窗
/// 每秒一次的进度推送，2 个 worker 瞬间被占满。之后**任何**新任务（包括
/// 用户点最小化要走的 `window` 命令）都只能在通道里排队 ——
/// 表现就是「点了没反应」+「所有请求 22 秒超时」。
///
/// 现在改成 8 个：不是为了让网络请求更快（那把锁仍然串行），
/// 而是保证**即使有几条请求卡在网络上，通道里也永远有空闲 worker 接手
/// 短小的 UI 任务**。这是「资源隔离」而不是「提高吞吐」——
/// 一个卡住的长任务不该饿死一个点击。
fn worker_pool() -> &'static WorkerPool {
    static POOL: std::sync::OnceLock<WorkerPool> = std::sync::OnceLock::new();
    POOL.get_or_init(|| WorkerPool::new(8))
}

/// 惰性初始化共享 Client：首次调用时建，之后所有命令共用同一个实例。
///
/// 返回 Arc 的克隆，所以调用方拿到后可以在锁外持有 —— 这正是
/// 「并发的两条命令不能各建一个 Client」的关键。
fn get_or_init_client(
    state: &State<'_, AppState>,
    data_dir: &PathBuf,
) -> Result<Arc<Mutex<netease::Client>>, String> {
    let mut guard = state.client.lock().map_err(|e| {
        i18n::tf(
            "状态锁被污染：{e}",
            "State lock poisoned: {e}",
            &[("e", e.to_string())],
        )
    })?;
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
    /*
     * 审查 L-10：参数 JSON 解析失败不再静默变成 `{}`。
     *
     * 原来的写法是 `.unwrap_or_else(|_| json!({}))` —— 参数写错时命令**照样执行**，
     * 只是参数全空。危险之处在于空参数很容易恰好命中上游的某个「默认值」分支
     * （例如 search 的 `p.type || 1`），于是静默返回一份看起来正常、实际不对的
     * 结果集，比直接报错难查得多。
     *
     * 现在按 server.js 的 badRequest 语义回一条明确错误，并且**不发起请求**。
     * 注意空字符串仍然合法（= 无参数），那是历史约定，前端大量调用点这么传。
     */
    let params_json: serde_json::Value = if params.trim().is_empty() {
        serde_json::json!({})
    } else {
        match serde_json::from_str(&params) {
            Ok(v) => v,
            Err(e) => {
                let bad = serde_json::json!({
                    "code": 400,
                    "message": i18n::tf("参数不是合法 JSON：{e}", "Params are not valid JSON: {e}", &[("e", e.to_string())]),
                });
                let js = format!(
                    "if (typeof window.__rippleNativeResult === 'function') {{ window.__rippleNativeResult({}, {}); }}",
                    /* 虽然这条分支紧接着就 return，但 clone 一下更稳：
                       以后若有人在下面补日志/补逻辑，就不会突然变成 move-after-move */
                    serde_json::Value::String(cb_id.clone()).to_string(),
                    serde_json::Value::String(bad.to_string()).to_string()
                );
                /* 与正常结果同一条投递口径（见下方 H-12 注释） */
                for (_label, win) in app.webview_windows() {
                    let _ = win.eval(&js);
                }
                return Ok(());
            }
        }
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
     *
     * H-17（审查报告，1.3.8）：`get_or_init_client` 的调用点已经挪到下面的
     * worker 池内部（见 pool.execute 里的第一段），这里只留需要的值。
     *
     * 为什么必须挪：首次调用会走 `netease::Client::new()` →
     * `reqwest::blocking::Client::builder().build()`，上游会在内部 **spawn 一个
     * 线程并在里面建 tokio current-thread runtime、初始化 TLS**。那是几百毫秒
     * 级的阻塞工作，而它以前跑在**命令线程**上 —— 同步 command 默认跑主线程，
     * 表现就是首次登录 / 首次搜索时窗口白屏卡一下。
     *
     * 注意不能直接把 `&state` 塞进闭包：池的闭包要求 `'static`，而
     * `State<'_, AppState>` 借的是本次命令的栈。所以闭包里改用
     * `app2.state::<AppState>()` 重新取一个 —— AppHandle 本身是
     * `Clone + Send + 'static`，取到的 State 生命周期落在闭包体内，用完即弃。
     */
    let app2 = app.clone();

    /*
     * 审查 L-11：不再每条命令裸 spawn 一个线程。
     *
     * 裸 `std::thread::spawn` 的问题不是「线程贵」（一次几十微秒），
     * 而是**没有上限**：首页会一次性并发拉每日推荐 + 推荐歌单 + 排行榜，
     * 用户来回切页时命令数可以无界增长，每个线程都阻塞在一把 Mutex 上排队。
     * 线程栈白占内存，且没有任何反压机制。
     *
     * 现在投到一个固定大小的 worker 池：多出来的任务在通道里排队，
     * 线程数恒定，内存可预期。池的大小见 `worker_pool()` 的注释 ——
     * 那里解释了为什么最终定在 8 而不是更小（资源隔离，避免长请求
     * 饿死短小的 UI 任务，而不是为了提高网络吞吐：Client 的请求本来
     * 就受那把 Mutex 保护、是串行的）。
     *
     * 关于「把 HTTP 请求移出锁保护范围」这半个建议：**本轮不做**，理由如下。
     * `netease::Client::call(&mut self, ...)` 内部会读 cookie_jar 拼请求、
     * 并在收到 Set-Cookie 后就地合并回 self.cookie_jar。要把它拆成
     * 「锁内取快照 → 锁外发请求 → 锁内合并」需要一个两阶段 API，
     * 而这些改动**本机无法编译验证**（缺 adler2，见 README 的构建说明）。
     * 用一个不能编译验证的设计去改网络与登录态的核心路径，
     * 风险远大于「请求偶尔排队」这个可用性瑕疵。等有可编译环境再做。
     */
    let pool = worker_pool();
    pool.execute(move || {
        /*
         * 第一次进入时在这里建共享 Client（见上方 H-17 注释）。失败必须
         * **自己**回一条结果给前端：命令本体早已 `return Ok(())`，
         * invoke 的 Promise 已经 resolve 过了 —— 此时若静默返回，
         * 前端 pending 表要干等 22 秒超时，日志里只有「请求超时」，
         * 真实原因（建 Client 失败，多半是数据目录不可写）反而丢了。
         * 投递口径与下面的正常结果一致：typeof 守卫 + 投给所有 webview。
         */
        let client = {
            let st = app2.state::<AppState>();
            match get_or_init_client(&st, &data_dir) {
                Ok(c) => c,
                Err(e) => {
                    /* 与成功路径同一个取证习惯：失败先落日志，再回前端 */
                    log_line_at(&app2, &format!("[IPC] 建共享 Client 失败 cb={cb_id}: {e}"));
                    let text = format!(
                        r#"{{"code":-1,"message":{}}}"#,
                        serde_json::Value::String(e).to_string()
                    );
                    /* cb_id 下面还要用，所以这里 clone —— 别为了省一次分配
                    把后面那行弄成 move-after-move。 */
                    let js = format!(
                        "if (typeof window.__rippleNativeResult === 'function') {{ window.__rippleNativeResult({}, {}); }}",
                        serde_json::Value::String(cb_id.clone()).to_string(),
                        serde_json::Value::String(text).to_string()
                    );
                    for (_label, win) in app2.webview_windows() {
                        let _ = win.eval(&js);
                    }
                    return;
                }
            }
        };

        let text = {
            // 锁的范围：只包住这一次网络请求。同类请求会串行，
            // 但桌面端请求量本来就不高，且能保证 cookie 不被并发写坏。
            let result = match client.lock() {
                Ok(mut c) => c.call(&cmd, &params_json),
                Err(e) => Err(i18n::tf("状态锁被污染：{e}", "State lock poisoned: {e}", &[("e", e.to_string())])),
            };
            match result {
                Ok(t) => t,
                Err(e) => format!(
                    r#"{{"code":-1,"message":{}}}"#,
                    serde_json::Value::String(e).to_string()
                ),
            }
        };

        /*
         * 与 Android 桥同名的全局回调。
         *
         * 审查 H-12：以前这里写死投到 `get_webview_window("main")`，
         * 于是「谁发的请求」这件事被丢掉了 —— 只有主窗口能收到结果。
         * 桌面端有**两个** webview（主窗口 + 歌词窗），各自有独立的 JS 上下文；
         * 哪一个窗口发起的命令，结果就该回给哪一个，否则歌词窗里的
         * 命令会永远等不到返回。
         *
         * 现在的做法：带上 typeof 守卫后投给**所有** webview。
         * 为什么不用「按 cbId 记发起窗口」那套（更精确但更重）：
         *   · 回调函数 __rippleNativeResult 是前端全局表驱动的，
         *     只有真正发起过这条 cbId 的窗口才会有对应条目；
         *   · 多投一份到没有该条目的窗口是**无害的 no-op**（typeof 守卫挡住）；
         *   · 而按窗口记账要多维护一张 cbId→label 的表，还得处理
         *     「窗口中途被关掉」的清理 —— 对当前只有两个窗口的规模不值得。
         * 一旦以后窗口数变多、或回调开始有副作用，就该换成按窗口记账。
         *
         * 找不到任何窗口时静默跳过：前端 pending 表有 22 秒超时兜底，
         * 不会永久卡住；而在这里 panic 会把整个应用带崩，代价大得多。
         */
        let js = format!(
            "if (typeof window.__rippleNativeResult === 'function') {{ window.__rippleNativeResult({}, {}); }}",
            /*
             * ⚠️ 必须 clone：下面的失败日志还要借用 cb_id。
             * 上一版没 clone，CI 直接 E0382「borrow of moved value: cb_id」——
             * 这正是「本机无编译环境」的代价，靠 CI 抓到。
             */
            serde_json::Value::String(cb_id.clone()).to_string(),
            serde_json::Value::String(text).to_string()
        );
        /*
         * 1.3.9：投递失败必须留下痕迹。
         *
         * 这里是整个「请求 → 前端」链路的**最后一跳**。以前是 `let _ = win.eval()`
         * —— 投递失败（窗口已关、webview 正在销毁）时一条记录都没有，
         * 前端只能干等 22 秒超时，日志里也只看到「请求超时」这个**结果**，
         * 看不到「结果其实已经拿到了，只是没能送进页面」这个**原因**。
         *
         * 现在成功/失败都记一行（含窗口标签）。同一个 cbId 若出现
         * 「有投递失败」+「前端报超时」，就能立刻判定是渲染侧的问题
         * 而不是网络侧 —— 这两种情况以前在日志里长得一模一样。
         */
        let mut delivered = 0usize;
        for (label, win) in app2.webview_windows() {
            match win.eval(&js) {
                Ok(()) => delivered += 1,
                Err(e) => log_line_at(
                    &app2,
                    &format!("[IPC] 结果投递失败 win={label} cb={cb_id}: {e}"),
                ),
            }
        }
        if delivered == 0 {
            /* 一个窗口都没投进去（比如都关了）—— 前端注定要超时，先记下来 */
            log_line_at(
                &app2,
                &format!("[IPC] 没有任何窗口接收结果 cb={cb_id}（前端会等到超时）"),
            );
        }
    });

    Ok(())
}

/// 在系统默认浏览器里打开一个链接（1.3.4，供「检查更新」用）。
///
/// 为什么不引入 `tauri-plugin-opener` 或 shell 插件：
///   本机构建是 `--offline --locked`，加依赖会直接失败（审查报告也记过
///   缺 `adler2` 那件事）。shell 插件的依赖已经按审查 L-10 从 Cargo.toml
///   删掉了 —— 它从未注册、也从未使用，留着只会让人误以为桌面端支持
///   执行任意命令。
///   这里只做一件事 —— 让系统按 URL 打开默认浏览器，各平台各有现成命令，
///   直接 `Command::spawn` 是最小且可靠的做法。
///
/// 安全说明：只接受 http/https 且非空的 URL，其他 scheme 一律拒绝。
/// 这条检查是必要的 —— 若将来有人把这个命令接到用户输入上，
/// 没有 scheme 白名单就可能被用来执行 `file://` 或自定义协议。
#[tauri::command]
fn open_external(url: String) -> bool {
    let u = url.trim();
    if u.is_empty() || !(u.starts_with("http://") || u.starts_with("https://")) {
        eprintln!("open_external: 拒绝非 http(s) 链接");
        return false;
    }

    /*
     * 审查 L-3 + L-12（1.3.8）：Windows 上**不再走 `cmd /C start`**。
     *
     * L-3 的问题：cmd 会把整条命令行重新拼起来再解析一遍，`Command::args`
     * 分参数传并不构成保护 —— URL 里的 `&` `|` `>` `^` 对 cmd 是命令分隔符/
     * 转义符，于是 `https://x/?a=1&b=2` 可能被解析成两条命令。
     * 当时的第一版修法是「在入口处拦掉这些元字符」，它挡住了注入，
     * 但顺手也拦掉了 `%` —— 而 `%` 是 URL 百分号编码的起始符
     * （`%20` / `%E4%B8%AD` 到处都是）。结果是**合法的百分号编码链接被
     * 整个拒绝 → 静默失败**（调用点的 `.catch()` 是空的，用户看不到任何提示）。
     * 审查报告实测：带 `%20` 的 Release 链接打不开。
     *
     * L-12 的修法：换掉执行方式，而不是继续加/减黑名单。
     * `rundll32 url.dll,FileProtocolHandler <url>` 直接调 ShellExecute，
     * **不经过 cmd 解析**，于是 `&` `|` `%` `^` 全都只是普通字符 ——
     * 既没有注入面，也不会误伤合法 URL。安全性来自「不走 shell」这个
     * 结构性事实，而不是来自一份永远可能漏项的黑名单。
     *
     * 仍然保留一个**极窄**的兜底检查（见下）：只拦控制字符与换行。
     * 理由不是安全（已经不走 shell 了），而是 `rundll32` 的命令行本身
     * 以空格分隔参数 —— URL 里若混入 `\r`/`\n`，Windows 的命令行解析
     * 可能把它切断成两段。这条与平台无关的检查顺手也保护了另外两个平台。
     *
     * 只对 Windows 生效的部分：Linux 的 xdg-open / macOS 的 open 都是
     * 直接 execve，不经过 shell，`&` `%` 在那两个平台只是普通字符。
     */
    if u.chars().any(|c| c.is_control()) {
        eprintln!("open_external: 拒绝含控制字符的链接");
        return false;
    }

    #[cfg(target_os = "linux")]
    {
        /* xdg-open 是 freedesktop 标准，主流发行版都自带 */
        return std::process::Command::new("xdg-open")
            .arg(u)
            .spawn()
            .is_ok();
    }
    #[cfg(target_os = "windows")]
    {
        /*
         * 用 rundll32 而不是 `cmd /C start`（L-12，见上方注释）。
         *
         * `url.dll,FileProtocolHandler` 是 Windows 上打开 URL 的经典入口，
         * 内部走 ShellExecute，**不经过 cmd**，所以 URL 里的元字符不会被
         * 二次解析。两个参数必须**一起**作为一个参数传给 rundll32：
         * 逗号分隔的 `url.dll,FileProtocolHandler` 是它要求的模块+入口写法，
         * 拆成两个参数会被它当成两个独立的 DLL 参数而失败。
         */
        return std::process::Command::new("rundll32.exe")
            .arg("url.dll,FileProtocolHandler")
            .arg(u)
            .spawn()
            .is_ok();
    }
    #[cfg(target_os = "macos")]
    {
        return std::process::Command::new("open").arg(u).spawn().is_ok();
    }
    #[allow(unreachable_code)]
    false
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

/* ================= 运行日志（桌面端排障的唯一取证手段） =================
 *
 * 为什么需要：Android 侧有 LogBridge 把日志写进 Download/Ripple-log.txt，
 * 桌面端以前一个 log 方法都没有 —— app/js/log.js 里那些调用全是 typeof 判空的，
 * 于是全部走内存兜底，**关掉窗口日志就没了**。用户报「卡了一下」「刚才报错了」，
 * 我们手上什么都没有，只能靠猜。
 *
 * 为什么落盘放在 Rust 而不是 JS：
 *   窗口崩溃 / 被强杀 / 渲染进程被回收时，JS 侧的任何缓冲都跟着消失；
 *   只有由 Rust 主进程直接 append 文件，才能在「应用已经没了」之后还留着现场。
 *
 * 文件位置：app_log_dir()/Ripple-log.txt
 *   Linux:   ~/.local/share/<bundle-id>/logs/Ripple-log.txt（可能因发行版而异）
 *   Windows: %LOCALAPPDATA%\<bundle-id>\logs\...\Ripple-log.txt
 * 具体路径在启动时由 log_path 命令报给前端，前端「设置 → 关于 → 导出日志」
 * 显示的就是这个真实路径 —— 不写死、不猜。
 *
 * 容量策略：单文件上限 LOG_MAX_BYTES。超了就把它改名成 Ripple-log.1.txt
 * 再开新文件（只保留一代）。不做多代轮转：排障要的是「最近这一段」，
 * 多代只会让用户不知道该发哪一个。
 */
const LOG_MAX_BYTES: u64 = 2 * 1024 * 1024;

/// 日志文件路径。取不到 app_log_dir 时退到配置目录（仍然可写、用户找得到）。
fn log_file_path(app: &tauri::AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_log_dir()
        .or_else(|_| app.path().app_config_dir())
        .unwrap_or_else(|_| PathBuf::from("."));
    let _ = std::fs::create_dir_all(&dir);
    dir.join("Ripple-log.txt")
}

/// 真正落盘的那一层：追加一行（带毫秒时间戳 + 超限轮转）。
///
/// 独立成普通函数（而不是只在命令里），是为了让 **Rust 内部**也能写日志。
///
/// 为什么需要这个：1.3.8 及以前，歌词窗创建失败的原因在
/// `ensure_lyric_window(...).is_ok()` 这一句被**整个丢弃** ——
/// 精心构造的 `Err("歌词窗口创建失败：{e}")` 里带着系统的真实错误码，
/// 却既没进日志、也没进界面，release 版又没有可见控制台。
/// 结果就是用户看到「点了开关没反应」，而开发者手上**一条证据都没有**。
/// 这条排障死路修法只有一条：在错误产生的地方就把它写下来。
fn log_line_at(app: &tauri::AppHandle, line: &str) {
    let path = log_file_path(app);

    /* 超过上限就先轮转一代，避免日志长成几百 MB 把用户磁盘吃满 */
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > LOG_MAX_BYTES {
            let old = path.with_file_name("Ripple-log.1.txt");
            let _ = std::fs::remove_file(&old);
            let _ = std::fs::rename(&path, &old);
        }
    }

    use std::io::Write;
    match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        Ok(mut f) => {
            /* 每行带时间戳。用 SystemTime 而不是引 chrono —— 本机构建是
            --offline --locked，加依赖直接失败（README 里记过这件事）。
            这里只求「能按时间排序、能看出间隔」，不需要可读的日历格式。 */
            let ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let _ = writeln!(f, "[{ms}] {line}");
        }
        Err(e) => eprintln!("[log] 写日志失败（{}）：{e}", path.display()),
    }
}

/// 追加一行日志。**失败只打 stderr，不再往文件里写错误** ——
/// 否则写盘失败会引发「记录写盘失败」的无限递归。
#[tauri::command(async)]
fn log_write(app: tauri::AppHandle, line: String) {
    log_line_at(&app, &line);
}

/// 把当前日志文件路径报给前端（前端启动时取一次并缓存）。
#[tauri::command(async)]
fn log_path(app: tauri::AppHandle) -> String {
    log_file_path(&app).display().to_string()
}

/// 与 Android `HttpBridge.logFlush` 同签名。
///
/// 桌面端每行都是 append + 立即关闭文件，没有用户态缓冲，
/// 所以这里确实「没有待刷内容」。保留命令是为了形状一致 ——
/// 前端会 typeof 判空后调用，缺了它只是少一次无用调用，但三端形状一致更省心。
#[tauri::command]
fn log_flush() -> bool {
    true
}

/*
 * D-06（审查报告，1.3.4）：删掉 can_draw_overlay / request_overlay_permission。
 *
 * 这两条命令以前恒返回 false，注释还写着「前端据此隐藏状态栏歌词设置项」——
 * 但真相是 desktop/bridge.js 里 `canDrawOverlay: () => true` 硬编码返回 true，
 * 从不 invoke 这两个 Rust 命令（全 desktop/ 目录 grep 无调用点）。
 *
 * 危害不是「多两条死代码」，而是**注释与事实相反**：
 * 将来有人照着注释让 JS 真去调 Rust，返回 false 会立刻把整个歌词功能
 * 从设置页抹掉 —— 一个本来好好的功能被一行「正确的注释」删掉。
 *
 * 桌面端的真实口径：没有悬浮窗权限这个概念（歌词是独立窗口），
 * 所以 JS 桥直接返回 true 是对的。这里不再对外暴露语义相反的命令。
 */

/// 与 Android `HttpBridge.safeMode` 同签名：桌面端永远不是安全模式。
#[tauri::command]
fn safe_mode() -> bool {
    false
}

/// 与 Android `HttpBridge.setLang` 同签名：前端切语言时把语言码推进原生层。
///
/// Android 那边是写进 SharedPreferences（重启后由 `L10n.init` 读回）；
/// 桌面端没有等价的"启动时读设置"时机 —— Rust 进程比 WebView 早，
/// 那时前端的 localStorage 还读不到。所以这里**只保存运行期状态**，
/// 由 bridge.js 在每次启动后（前端 boot 完成、语言确定之后）再推一次。
/// 结果就是：进程存活期间语言永远正确；重启后的第一次错误消息可能
/// 用中文默认值 —— 这是已知的、可接受的边界（README 里会写明）。
#[tauri::command]
fn set_lang(code: String) -> bool {
    i18n::set_lang(&code);
    true
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

/// 把歌词状态序列化成发给歌词窗的 payload。
///
/// 审查 M-16：这个函数抽出来的理由是**两份 payload 各写一遍必然漂移**。
/// 以前 `push_lyric_state`（事件推送）与 `lyric_overlay_sync`（首帧拉取）
/// 各手写一遍 json!({...})，结果前者有 baseProgress / lineDur / rate / playing，
/// 后者没有 —— 于是歌词窗每次打开的第一句，外推所需字段是 undefined，
/// 卡拉OK 填充静止不动，要等下一次换句才恢复。
/// 那种「一下填满 / 不动」正是 1.3.3 在 Android 侧查了十一轮的症状。
///
/// 现在只有一个构造点：加字段只改这里，两条通路自动同步。
fn lyric_payload(st: &LyricState) -> serde_json::Value {
    serde_json::json!({
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
        /* 以下四个字段只有推送路径有过 —— 正是 M-16 的缺口所在 */
        "baseProgress": st.base_progress,
        "lineDur": st.line_dur,
        "rate": st.rate,
        "playing": st.playing,
        /*
         * 1.3.9：窗口是不是降级的不透明形态。
         * 页面据此决定要不要自己铺一层深色底 —— 透明窗铺底等于白做，
         * 不透明窗不铺底则是白底白字（看不见）。
         */
        "opaque": st.opaque,
    })
}

/// 把当前状态推给歌词窗口。
///
/// 推的是**整份状态**而不是增量：状态字段总共十几个小值，
/// 每次全量推反而让 lyric.html 不必维护「哪些字段这次没变」的判断，
/// 少一类「某个字段忘了同步」的 bug。
fn push_lyric_state(app: &tauri::AppHandle, st: &LyricState) {
    let payload = lyric_payload(st);
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

/// 判断这次 `lyric_overlay_show` 是不是真的要「恢复默认位置」（审查 H-3）。
///
/// 三个条件必须**同时**成立：
///   1. 前端传来的 x 是负数；
///   2. 前端传来的 y 是负数；
///   3. state 里当前没有有效位置（x、y 也都是负数）。
///
/// 为什么第 1、2 条要用「且」而不是「或」：以前是或 —— 任何一个负值就算
/// 重置。而 x/y 是成对传的，只有一个负数意味着调用方传错了参数；
/// 那种情况应该老老实实保留原位置，而不是把窗口甩回默认点。
///
/// 为什么第 3 条不能省：桌面端前端**永远**传 -1（S().sbX/sbY 恒为 -1，
/// 因为没有 __rippleLyricMoved 回流），于是前两条恒真。少了第 3 条，
/// 每一次推送都会重置位置 —— 这正是「一拖就弹回去」的根因。
///
/// 加上第 3 条之后的语义：
///   · 已知位置无效（首次创建 / 刚从旧版本升上来）→ 重置到默认位置，
///     **并且**顺便把默认位置写进 state（调用方在 want_reset 分支里做），
///     于是下一次推送时第 3 条就不成立了，不会再重置；
///   · 已知位置有效 → 忽略前端的负值占位，继续用 state 里的位置。
///
/// ===== 这条判据的功能代价（必须如实写明，不要假装没有）=====
///
/// 桌面端的「恢复默认位置」按钮**会失效**。原因：按钮的实现是
/// `S().sbX = -1; S().sbY = -1; Store.save(); applySbOverlay()`
/// （app/js/app.js 的 #sbAct reset 分支），它传下来的 -1 与
/// 「前端没有位置」的占位 -1 **完全同形** —— bridge.js 的 10 参数
/// 载荷里没有第二个通道能表达「这是重置而不是占位」。
/// 于是本判据无法区分两者：只要 Rust 侧有有效位置，就一律按占位处理
/// （不重置）。用户点按钮的观感是「点了没用」。
///
/// 为什么这个代价可以接受：
///   · 修之前是**反过来的更严重故障** —— 每次改设置都把窗口弹回默认，
///     用户连位置都保不住，功能等于不可用（这是 H-3 要修的东西）；
///   · 修之后正常的「拖动 → 记住位置」完全成立，这才是主路径；
///   · 要彻底修好按钮，得给桥加一个显式的 reset 参数（改 bridge.js 的
///     签名 + app.js 的调用点）。那两处不在本任务的写入范围内
///     （本任务只许可改 main.rs / netease.rs / capabilities / Cargo /
///     lyric.html），而且改签名会波及 Android 三端一致的形状约定，
///     应该单独评估。已作为遗留项写进回报，由 Lead 决定是否开单。
///
/// 一旦桥有了显式 reset 信号，只需把这里换成
/// `x_neg_and_explicit_reset && ...`，本函数是唯一的改动点。
///
/// 另外：真正「首次启动 / 存档损坏」的情形仍然会重置，因为那种情况下
/// state 里确实没有位置（guard 读不到 lyric-pos.json）—— 那一侧的行为
/// 与修之前完全一致，没有退化。
fn want_reset_pos(x: &str, y: &str, cur_x: i32, cur_y: i32) -> bool {
    let x_neg = x.trim().parse::<i32>().map(|v| v < 0).unwrap_or(false);
    let y_neg = y.trim().parse::<i32>().map(|v| v < 0).unwrap_or(false);
    x_neg && y_neg && cur_x < 0 && cur_y < 0
}

/// 惰性创建歌词窗口；已存在则直接返回。
///
/// 三个平台都能走到，但 Linux 上没有合成器时透明窗口可能创建失败 ——
/// 那种情况下把 window_ok 置 false 并返回 Err，调用方据此让前端走降级路径
/// （前端所有 RippleNative 调用点都有 typeof 判空，返回失败不会崩）。
fn ensure_lyric_window(app: &tauri::AppHandle, st: &LyricState) -> Result<bool, String> {
    if app.get_webview_window(LYRIC_WINDOW).is_some() {
        /* 窗口已存在：沿用它在 state 里记录的形态，不要凭猜测重算 */
        return Ok(st.opaque);
    }

    /*
     * 1.3.9 修复（Windows 11 精简版上「歌词小窗点不开」的真凶）：
     *
     * 先按原本的样子建「透明 + 无边框 + 置顶」的窗口。这条路在 Windows 上
     * 走的是 DwmEnableBlurBehindWindow + WebView2 合成控制器的组合，是
     * 已知最容易失败的一条 —— 精简版系统常常裁掉 DWM 组件、关掉透明效果，
     * 于是 build() 直接返回 Err。1.3.8 及以前这个 Err 被 .is_ok() 吞掉，
     * 用户看到的只有「点了开关没反应」。
     *
     * 现在分两步走：**透明窗失败就退一步，用不透明窗再建一次**。
     *   · 透明成功 → 跟以前一样，文字直接浮在桌面上（最好看）
     *   · 透明失败 → 退成带深色底的不透明窗（难看一点，但**能用**），
     *     并让 lyric.html 知道要自己去铺底（见 fallback 参数）
     * 只有两步都失败才算真失败，那时才写日志 + 弹 toast。
     *
     * 为什么值得这样退让：歌词窗的核心价值是「在别的程序前面显示歌词」，
     * 透明只是观感。为了观感让整个功能不可用，是本末倒置。
     */
    match build_lyric_window(app, st, true) {
        Ok(()) => Ok(false), // 透明成功 = 非降级
        Err(first_err) => {
            log_line_at(
                app,
                &format!(
                    "[LYRIC] 透明歌词窗创建失败，降级为不透明窗重试：{first_err}（平台 {}）",
                    std::env::consts::OS
                ),
            );
            match build_lyric_window(app, st, false) {
                Ok(()) => {
                    log_line_at(
                        app,
                        "[LYRIC] 已降级为不透明窗（功能可用，仅少了桌面透明观感）",
                    );
                    /*
                     * 返回「是不是降级形态」而不是在这里改 state：
                     * 本函数拿不到 State（它只收 AppHandle），
                     * 硬塞一个全局锁反而多一处要维护的状态。
                     * 由调用方（lyric_overlay_show）把它写进 LyricState，
                     * 再随 payload 传给页面。
                     */
                    Ok(true)
                }
                Err(second_err) => Err(i18n::tf(
                    "透明窗与不透明窗都创建失败：{a} / {b}",
                    "Both the transparent and opaque lyric windows failed: {a} / {b}",
                    &[("a", first_err), ("b", second_err)],
                )),
            }
        }
    }
}

/// 建一次歌词窗。`transparent` 为 false 时走降级形态。
///
/// 拆成独立函数而不是在一个大函数里写两遍，是因为两次尝试**除了透明
/// 与背景色之外必须完全一致**（尺寸、置顶、不抢焦点、位置恢复逻辑）。
/// 复制粘贴两份的话，以后改一处忘另一处就会变成「透明版有某个修复、
/// 降级版没有」这种极难发现的偏差。
fn build_lyric_window(
    app: &tauri::AppHandle,
    st: &LyricState,
    transparent: bool,
) -> Result<(), String> {
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
    /* 窗口标题是任务栏/窗口列表里能被看到的一处；歌词窗没有装饰（decorations(false)），
    所以这行主要对「窗口列表」「无障碍接口」可见。仍跟语言走。 */
    .title(i18n::t("Ripple 歌词", "Ripple lyrics"))
    .inner_size(360.0, 64.0)
    .min_inner_size(120.0, 32.0)
    .decorations(false)
    /*
     * 透明底：让文字直接浮在桌面上。降级形态（transparent=false）时
     * 不透明，并且给一个深色背景 —— 否则是一个纯白/纯黑的裸窗。
     * 用 #0b0b12 跟主题暗底接近，白字依然清晰。
     */
    .transparent(transparent)
    .always_on_top(true)
    .skip_taskbar(true)
    /* 不抢焦点：用户正在别的程序里打字时，弹一句歌词不该把光标抢走 */
    .focused(false)
    .resizable(false)
    .shadow(false)
    .visible_on_all_workspaces(true)
    .accept_first_mouse(true);

    /*
     * 降级窗铺一层深色底，避免 WebView 默认白底刺眼。
     * (u8,u8,u8) → Color 是 tauri-utils 提供的 From 实现，不引入额外依赖。
     */
    if !transparent {
        builder = builder.background_color((11u8, 11u8, 18u8).into());
    }

    /*
     * M-15：这里**不再**给 builder.position()。
     *
     * 原因是窗口对象还不存在，而「默认位置」必须知道窗口尺寸与所在显示器
     * 才能算（default_lyric_pos_logical 要 &WebviewWindow）。以前的做法是
     * 「有位置文件就用 builder.position，没有就交给系统默认」——
     * 这正好造成了「首次创建」与「点恢复默认位置」落在两个不同地方。
     *
     * 改成建完窗口立刻落位：有存档位置就用存档，没有就用与
     * 「恢复默认位置」完全相同的那个函数算。两条路径从此不可能再分叉。
     */
    match builder.build() {
        Ok(win) => {
            /* 按当前锁定状态决定是否穿透。锁定 = 鼠标事件直接穿过去，
            盖在别的程序上也不影响用户点它下面的东西。 */
            let _ = win.set_ignore_cursor_events(st.locked);

            let scale = win.scale_factor().unwrap_or(1.0);
            let scale = if scale > 0.0 { scale } else { 1.0 };
            match pos {
                /* 存档位置是逻辑坐标，set_position 要物理坐标 */
                Some((lx, ly)) => {
                    let px = (lx as f64 * scale).round() as i32;
                    let py = (ly as f64 * scale).round() as i32;
                    let _ = win.set_position(tauri::PhysicalPosition::new(px, py));
                }
                None => {
                    // 与「恢复默认位置」走同一个函数、同一套坐标口径。
                    // 首次落位顺便把位置存下来，下次启动就稳定了。
                    if let Ok((lx, ly)) = default_lyric_pos_logical(&win) {
                        let px = (lx as f64 * scale).round() as i32;
                        let py = (ly as f64 * scale).round() as i32;
                        let _ = win.set_position(tauri::PhysicalPosition::new(px, py));
                        save_lyric_pos(&data_dir, lx, ly);
                    }
                }
            }
            Ok(())
        }
        Err(e) => Err(i18n::tf(
            "歌词窗口创建失败：{e}",
            "Failed to create lyric window: {e}",
            &[("e", e.to_string())],
        )),
    }
}

/// 与 Android `HttpBridge.showLyricOverlay` 同签名（10 个参数）。
///
/// 参数全部按字符串收：前端那边是 `String(!!x)` / `String(n)` 这样传的，
/// 与 Android 完全一致。这样三端桥的形状相同，前端不需要为桌面端写分支。
///
/// 解析容错与 Android 一致：解析失败就沿用旧值，而不是报错让调用方失败 ——
/// 一次脏数据不该让整条歌词链路停摆。
#[tauri::command(async)]
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
    /*
     * D-04（审查报告，1.3.4）：负值 = 「恢复默认位置」。
     *
     * 以前这里把 -1 当成合法坐标原样写进 state 和磁盘：
     *   · 窗口已存在时，这个函数**从不 set_position**，
     *     所以用户点完「恢复默认位置」窗口原地不动；
     *   · -1 又被持久化了，重启后读回来还是 -1，等于一直没恢复。
     *   UI 反馈「已恢复默认位置」，实际什么都没发生。
     *
     * 现在的口径：
     *   · 收到 < 0 → 视为「恢复默认」：删掉位置文件、把 state 也清成 -1、
     *     并对**已存在的窗口**真的 set_position 到默认位置；
     *   · 收到 >= 0 → 正常保存（逻辑坐标，见 lyric_save_pos 的 D-03 说明）。
     *
     * ===== H-3（审查报告，1.3.8）：为何还要「且当前已知位置也无效」=====
     *
     * 只判「收到的是不是负数」在桌面端是**恒真**的，因为前端永远传 -1：
     *   · app.js 的 applySbOverlay 传 String(s.sbX == null ? -1 : s.sbX)；
     *   · 而 S().sbX / S().sbY 在桌面端**永远是 -1** —— 它们只由
     *     window.__rippleLyricMoved 写入，那是 Android 原生浮层拖动后
     *     回推的钩子，桌面端没有任何地方调用它。桌面端的位置只存在
     *     Rust 侧的 lyric-pos.json 与 LyricState.x/y，从不回流到前端 settings。
     *
     * 后果：applySbOverlay 有 11 处调用点（改颜色、改字号、切播放态、
     * 改锁定……），每次都会走到这里、每次都被判成「恢复默认」——
     * 用户拖完歌词窗、下一次点任何设置它就被弹回默认位置，
     * 表现就是「一拖就弹回去 / 位置保存不了」。
     *
     * 修法（报告推荐方案）：把「前端要求重置」与「真有位置要重置」两个
     * 条件取交集 —— 只有当前确实有位置时，重置才有意义。判据抽成
     * want_reset_pos()，让「什么算重置」只有一个定义点。
     *
     * ===== 光有交集还不够：判定前必须先把存档读回 state =====
     *
     * want_reset_pos 的第三个条件（cur_x/cur_y < 0）只有在 guard 里真的
     * 存着有效位置时才有意义。而 guard 的有效值只有两个来源，都覆盖不到
     * 「进程刚启动后的第一次 show」：
     *   · lyric_save_pos（拖动落盘）→ 要用户先拖一次才会写；
     *   · build_lyric_window 建窗落位 → 它只 save_lyric_pos 写**文件**，
     *     拿的是 &LyricState（只读），算出来的位置**回不到 guard**。
     * 于是进程启动后 guard.x/y 一直是 LyricState::default() 的 -1，
     * want_reset_pos 的第三个条件恒真 —— 判据退化成和修之前一模一样，
     * 而且更糟：建窗时明明已按 lyric-pos.json 把窗口摆到了存档位置，
     * 紧接着这里又判「要重置」把它甩回默认位置、还删掉了位置文件。
     * 用户看到的就是「位置保存不了，每次重开都回默认」。
     *
     * 所以先把存档读进 state，让「已知位置」这个状态在进程启动后
     * 第一次判定时就正确。读不到（真·首次运行）才保持 -1，那时重置
     * 才是符合预期的行为。
     */
    if guard.x < 0 && guard.y < 0 {
        let dir = app
            .path()
            .app_config_dir()
            .unwrap_or_else(|_| PathBuf::from("."));
        if let Some((sx, sy)) = read_lyric_pos(&dir) {
            guard.x = sx;
            guard.y = sy;
        }
    }

    let want_reset = want_reset_pos(&x, &y, guard.x, guard.y);
    if want_reset {
        guard.x = -1;
        guard.y = -1;
        let dir = app
            .path()
            .app_config_dir()
            .unwrap_or_else(|_| PathBuf::from("."));
        let _ = std::fs::remove_file(dir.join("lyric-pos.json"));
    } else {
        /*
         * H-3：负值不再是合法坐标 —— 它是「前端没给位置」的占位。
         *
         * 以前这里无条件写入，于是 guard 被 -1 污染：下一次调用又满足
         * 「state 里没有有效位置」这个条件，窗口位置在两次调用之间反复横跳。
         * 只接受 >= 0 的值，让「已知位置」这个状态是**单调**的
         * （一旦有真位置，就不会被占位值覆盖回去）。
         */
        if let Ok(v) = x.trim().parse::<i32>() {
            if v >= 0 {
                guard.x = v;
            }
        }
        if let Ok(v) = y.trim().parse::<i32>() {
            if v >= 0 {
                guard.y = v;
            }
        }
    }
    guard.bold = bold == "true";
    guard.shadow = shadow == "true";
    guard.fill = fill == "true";
    if !fill_hex.is_empty() {
        guard.fill_hex = fill_hex;
    }

    // 首次创建窗口。失败就如实返回 false，前端会走降级。
    if !guard.window_ok || app.get_webview_window(LYRIC_WINDOW).is_none() {
        /*
         * 1.3.9 修复（Windows 11 上「点了开关没反应」的排障死路）：
         *
         * 这里以前是 `ensure_lyric_window(...).is_ok()` —— 只留一个 bool，
         * 把 `Err("歌词窗口创建失败：{e}")` 里那份**系统真实错误码整个丢掉**。
         * 后果：日志里没有一行、界面上一句提示都没有、release 版又没有
         * 可见控制台，于是「窗口为什么建不出来」在用户机器上永远查不到。
         *
         * 改成 match 后：成功照旧，失败时先写日志（用户能通过
         * 「我的 → 软件日志」把它发出来），再由前端弹 toast。
         * 这样同一个 bug 下次出现时，第一手信息就是错误原文。
         */
        match ensure_lyric_window(&app, &guard) {
            Ok(opaque) => {
                guard.window_ok = true;
                /*
                 * 记住这次是用哪种形态建出来的。降级窗（opaque=true）需要
                 * 页面自己铺深色底，否则白字在白底 WebView 上看不见。
                 * 存进 state 是为了重连（切歌、改样式）时不必重新判断。
                 */
                guard.opaque = opaque;
            }
            Err(e) => {
                guard.window_ok = false;
                log_line_at(
                    &app,
                    &format!(
                        "[LYRIC] 歌词窗口创建失败：{e}（平台 {} / 透明窗+置顶+无边框组合）",
                        std::env::consts::OS
                    ),
                );
                /*
                 * 同时推给前端：用户点开关是为了「看到歌词」，
                 * 静默失败会让他以为是自己点错了或 App 卡住了。
                 * 事件名与 bridge.js 里监听的一致。
                 */
                let _ = app.emit("lyric-window-error", e);
                return false;
            }
        }
        // 新建的窗口还没加载完页面，此时 emit 会被丢掉 ——
        // lyric.html 自己会在加载完成后主动 invoke 一次 lyric_overlay_sync
        // 把首帧状态取回去，所以这里不需要额外等待。
    }
    // 锁定状态变化要同步到窗口的点击穿透设置
    if let Some(win) = app.get_webview_window(LYRIC_WINDOW) {
        let _ = win.set_ignore_cursor_events(guard.locked);
        /*
         * D-04：位置变化（尤其「恢复默认」）必须作用到**已存在的窗口**。
         * 以前这段完全缺失 —— set_position 只在创建时读一次，
         * 于是「恢复默认位置」对已经开着的歌词窗永远无效。
         */
        if want_reset {
            /*
             * M-15：default_lyric_pos_logical 返回**逻辑**像素，
             * set_position 要**物理**像素 —— 这里乘 scale。
             * 同时把恢复后的位置回写 state 与 lyric-pos.json，
             * 否则下一次拖动保存会把「恢复默认」的结果覆盖掉，
             * 而且重启后读不到位置又回到创建路径。
             */
            if let Ok((lx, ly)) = default_lyric_pos_logical(&win) {
                let scale = win.scale_factor().unwrap_or(1.0);
                let scale = if scale > 0.0 { scale } else { 1.0 };
                let px = (lx as f64 * scale).round() as i32;
                let py = (ly as f64 * scale).round() as i32;
                let _ = win.set_position(tauri::PhysicalPosition::new(px, py));
                guard.x = lx;
                guard.y = ly;
                let dir = app
                    .path()
                    .app_config_dir()
                    .unwrap_or_else(|_| PathBuf::from("."));
                save_lyric_pos(&dir, lx, ly);
            }
        } else if guard.x >= 0 && guard.y >= 0 {
            let scale = win.scale_factor().unwrap_or(1.0);
            let px = (guard.x as f64 * scale).round() as i32;
            let py = (guard.y as f64 * scale).round() as i32;
            let _ = win.set_position(tauri::PhysicalPosition::new(px, py));
        }
    }
    push_lyric_state(&app, &guard);
    true
}

/// 默认歌词窗位置（**逻辑像素**）：水平居中、竖直靠上。
///
/// 审查 M-15：这里以前有两个毛病，都是「两套口径并存」造成的：
///
/// ① **创建**时用了 `builder.position(x, y)`（Tauri 的 position 收逻辑坐标），
///    但只在位置文件里读到值时才用它；首次创建**根本不调用它** ——
///    窗口落在系统默认位置（通常屏幕左上角附近）。
/// ② **恢复默认**时用 `set_position(PhysicalPosition)`（物理坐标），
///    位置由本函数按 monitor.size()/outer_size() 算 —— 那两个都是物理像素。
///
/// 于是「首次打开」和「点恢复默认位置」落在两个完全不同的地方，
/// 用户会以为恢复默认功能坏了。而且恢复后的位置**没有回写** lyric-pos.json，
/// 下次拖一下就被覆盖。
///
/// 现在统一成：本函数只返回**逻辑像素**，创建与恢复都走它，
/// 由调用方按各自的 API 需要乘/不乘 scale（builder.position 收逻辑，
/// set_position 收物理）。恢复后同时回写位置文件。
fn default_lyric_pos_logical(win: &tauri::WebviewWindow) -> Result<(i32, i32), ()> {
    let monitor = win.current_monitor().ok().flatten().ok_or(())?;
    /* monitor.size() 与 outer_size() 都是物理像素，除 scale 换回逻辑坐标 */
    let scale = win.scale_factor().unwrap_or(1.0);
    let scale = if scale > 0.0 { scale } else { 1.0 };
    let size = monitor.size();
    let win_size = win.outer_size().map_err(|_| ())?;
    let x = (((size.width as f64) - (win_size.width as f64)) / 2.0 / scale).round() as i32;
    let y = ((size.height as f64) / 8.0 / scale).round() as i32;
    Ok((x.max(0), y.max(0)))
}

/// 更新歌词文字。与 Android `updateLyricOverlay` 同语义。
#[tauri::command(async)]
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
#[tauri::command(async)]
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

/// 设置填充的「基准点」，由歌词窗口自己按时间外推（D-02，1.3.4）。
///
/// 与 Android `LyricOverlay.setTiming` 完全同语义，参数含义也一样：
/// @param progress 当前这一句的进度 0..1（推送那一刻的真值）
/// @param lineDur  本句总时长（秒）；<= 0 表示未知，不启用外推
/// @param rate     播放倍速（1.0 = 正常）
/// @param playing  是否正在播放；false 时冻结不推进
///
/// 为什么要这套机制（与 Android 同一个理由）：
///   歌词窗的使用场景就是「切到别的程序时看」—— 那时主窗口 rAF 暂停、
///   1 秒 ticker 被 clearInterval、timeupdate 被节流，逐帧推送断流。
///   只推「基准点」让接收方自己外推，就不依赖发送方的定时器还活着。
///
/// 为什么外推在 lyric.html 里做、不在这里开定时器：
///   那个窗口自己可见，rAF 照常运行；而在 Rust 侧要多开一个线程、
///   多一处启停逻辑，还要处理跨进程时钟对齐 —— 不值得。
#[tauri::command(async)]
fn lyric_overlay_timing(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    progress: String,
    line_dur: String,
    rate: String,
    playing: String,
) {
    let mut guard = match state.lyric.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    let p = progress.trim().parse::<f32>().unwrap_or(0.0);
    let p = if p.is_finite() {
        p.clamp(0.0, 1.0)
    } else {
        0.0
    };
    let d = line_dur.trim().parse::<f32>().unwrap_or(0.0);
    let d = if d.is_finite() && d > 0.0 { d } else { 0.0 };
    let r = rate.trim().parse::<f32>().unwrap_or(1.0);
    let r = if r.is_finite() && r > 0.0 { r } else { 1.0 };
    let play = playing.trim().eq_ignore_ascii_case("true");

    guard.base_progress = p;
    guard.line_dur = d;
    guard.rate = r;
    guard.playing = play;
    /* progress 也同步成基准值：外推不可用时（d<=0）退化成静态显示，
    此时窗口读的就是 progress，必须是最新的。 */
    guard.progress = p;
    push_lyric_state(&app, &guard);
}

/// 隐藏（销毁）歌词窗口。与 Android `hideLyricOverlay` 同语义。
///
/// 销毁而不是 hide：与 Android 那头 `wm.removeView` 一致，
/// 也更省资源 —— 用户关掉状态栏歌词后不该还挂着一个看不见的 webview。
#[tauri::command(async)]
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
#[tauri::command(async)]
fn lyric_overlay_sync(state: State<'_, AppState>) -> serde_json::Value {
    let guard = match state.lyric.lock() {
        Ok(g) => g,
        Err(_) => return serde_json::json!({}),
    };
    // 与事件推送共用同一个构造点（M-16）—— 首帧也必须带
    // baseProgress / lineDur / rate / playing，否则第一句不动。
    let v = lyric_payload(&guard);
    drop(guard);
    v
}

/// 歌词窗拖动结束后回报新位置并落盘。
#[tauri::command(async)]
fn lyric_save_pos(app: tauri::AppHandle, state: State<'_, AppState>, x: i32, y: i32) {
    /*
     * D-03（审查报告，1.3.4）：这里收到的 x/y 是**物理像素**，
     * 而 builder.position() 接受的是**逻辑像素** —— 必须换算后再存，
     * 否则 150% / 200% 缩放的屏幕上每拖一次就放大一次，
     * 几次之后窗口跑出屏幕，「位置持久化」实际是坏的。
     *
     * lyric.html 那边用 window.outerPosition() 取位置，它返回物理像素
     * （Tauri 的 webview_window.rs 里 outer_position 就是物理坐标）。
     * 这里用当前窗口的 scale_factor 把它除回逻辑坐标。
     */
    let scale = app
        .get_webview_window(LYRIC_WINDOW)
        .and_then(|w| w.scale_factor().ok())
        .filter(|s| *s > 0.0)
        .unwrap_or(1.0);
    let lx = (x as f64 / scale).round() as i32;
    let ly = (y as f64 / scale).round() as i32;

    if let Ok(mut g) = state.lyric.lock() {
        g.x = lx;
        g.y = ly;
    }
    let dir = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    save_lyric_pos(&dir, lx, ly);
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
    /*
     * D-05（审查报告，1.3.4）：必须用 create_new 才是真的 O_EXCL。
     *
     * 以前写的是 File::create（write+create+truncate）——
     * 那根本不是排他创建，注释里说的「挡住极端竞态」形同虚设：
     * 两个实例同时启动时都能成功 open 同一个路径，各自 truncate 后写自己的
     * pid，最后活下来的是后写的那个，而两个实例都在跑。
     *
     * create_new(true) 映射到 O_CREAT|O_EXCL：文件已存在就返回 AlreadyExists，
     * 由操作系统保证原子性，这是唯一能真正解决竞态的写法。
     */
    /*
     * 审查 H-13：这里的返回值语义是「本进程拿到锁了吗」——
     * false 表示**已有一个活实例在跑**，调用方必须退出本进程。
     */
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&lock)
    {
        Ok(mut f) => {
            let _ = write!(f, "{}", std::process::id());
            true
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            /*
             * 走到这里说明「锁文件已经存在，而且上面没能确认它是个死进程」。
             *
             * 审查 H-13：以前这里无条件 `true`（继续启动），注释写的是
             * 「宁可多开一个，也不能打不开」。这个取舍本来是合理的，
             * 但它把两种完全不同的情况混成了一样：
             *   (a) 真有一个活着的实例 —— 应当**拒绝**启动；
             *   (b) 锁文件存在但读不出 pid / pid 已死 —— 应当**接管**。
             * 结果是「双击两次图标」这个真实场景根本没被挡住：
             * 两次启动都返回 true，两个实例各持一份 cookie_jar 与位置文件，
             * 互相覆盖（这正是单实例机制要防的事）。
             *
             * 现在把 (a) 和 (b) 分开：
             *   · 文件里是一个活着的 pid → false（调用方会退出本进程）；
             *   · 文件读不出 / pid 已死 / pid 不合法 → 删掉陈旧锁，重新排他创建。
             * 重创建仍然用 create_new，所以并发竞争里只会有一个人成功。
             */
            let stale = match std::fs::read_to_string(&lock) {
                Ok(text) => {
                    let pid: i32 = text.trim().parse().unwrap_or(0);
                    /* pid <= 1 视为垃圾内容（0/负/解析失败），按陈旧处理 */
                    pid <= 1 || !unsafe { libc_kill0(pid) }
                }
                /* 读不出来（权限/编码问题）：无法证明有活实例。
                按陈旧处理 —— 否则用户会遇到「永远打不开」且不可解释。 */
                Err(_) => true,
            };

            if !stale {
                return false;
            }

            /* 陈旧锁：删掉再用 create_new 重排他创建一次。
            失败就放弃排他（返回 true 让用户能打开），
            因为「陈旧锁 + 删不掉」的组合下，拒绝启动等于永久锁死。 */
            let _ = std::fs::remove_file(&lock);
            match std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&lock)
            {
                Ok(mut f) => {
                    let _ = write!(f, "{}", std::process::id());
                    true
                }
                Err(_) => true,
            }
        }
        Err(_) => true,
    }
}

/// 删除单实例锁文件（D-05）。
///
/// 以前的实现正常退出时不删 lock：pid 被系统复用后，若恰好命中一个活进程，
/// `kill(pid,0)` 返回 0，于是每次启动都判定「已在运行」直接退出 ——
/// 用户不手动删文件就再也打不开这个 App。
///
/// 这里在退出时删，但**先校验文件里写的是不是自己的 pid**：
/// 如果读到的是别的 pid（说明这个文件已经不属于本次会话，可能是并发启动的
/// 另一个实例写的），就不要删，免得把别人的锁误删掉。
#[cfg(unix)]
fn release_single_instance(dir: &std::path::Path) {
    let lock = dir.join(".ripple-instance");
    let mine = std::process::id().to_string();
    match std::fs::read_to_string(&lock) {
        Ok(text) if text.trim() == mine => {
            let _ = std::fs::remove_file(&lock);
        }
        _ => {}
    }
}

#[cfg(windows)]
fn release_single_instance(_dir: &std::path::Path) {}

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
            /* 原生层多语言：前端切语言时推进来，见 i18n 模块注释 */
            set_lang,
            lyric_overlay_timing,
            open_external,
            safe_mode,
            /* 运行日志：桌面端排障的唯一取证手段，见上方注释块 */
            log_write,
            log_path,
            log_flush,
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
                /*
                 * D-05：退出时删掉单实例锁文件。
                 *
                 * 不删的话，pid 被系统复用后若恰好命中一个活进程，
                 * 下次启动会一直判定「已在运行」直接退出 ——
                 * 用户不手动删文件就再也打不开 App。
                 * release_single_instance 内部会先校验文件里的 pid 是不是自己的。
                 */
                if let Ok(dir) = app.path().app_config_dir() {
                    release_single_instance(&dir);
                }
            }
        });
}
